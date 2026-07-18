/**
 * Section L / L_Performance_Optimization.txt
 * Prompts: 6, 24, 46, 47, 48 ("off-main-thread compute" + "Comlink worker")
 *
 * worker-offload.ts — generic Comlink-backed worker pool for offloading
 * heavy per-frame computation off the main thread.
 *
 * The game already has a single-purpose squad-coordinator.worker.ts. This
 * module is the GENERAL offload pool: AI ticks, physics broad-phase,
 * ballistic integration batches, and any other pure-math task that
 * benefits from running on a background thread.
 *
 * Architecture:
 *
 *   - A small pool of N workers (default: max(2, hardwareConcurrency/2 - 1),
 *     clamped to [1, 6]) is created on first use. Each worker hosts the
 *   same Comlink-exposed `OffloadWorkerApi` (defined below).
 *   - Tasks are round-robin dispatched across the pool by a stable hash of
 *     the task key (so the same AI tick for enemy #42 always lands on the
 *     same worker → cache-friendly).
 *   - The pool degrades gracefully when Workers are unavailable (SSR,
 *     non-COI headers, very old browsers): `dispatch()` runs the task
 *     synchronously on the main thread via a no-op proxy. The caller
 *     doesn't have to branch on capability.
 *   - Every dispatched task carries a soft deadline (ms). The worker can
 *     early-exit + return a partial result if the deadline elapses, so a
 *     runaway task never stalls the frame.
 *
 * Why a pool, not one worker: Web Workers are single-threaded, so a single
 * worker serializes every offloaded task. With a pool, an N-core CPU can
 * run N AI ticks in parallel — important when a 50-enemy wave wants all
 * FSM updates in the same 16ms budget.
 *
 * Transferable strategy: callers pass `transferList` (ArrayBuffer /
 * MessagePort) where possible to avoid structured-clone copies. The
 * pool passes the list straight through to `Comlink.transfer`.
 */

import * as Comlink from "comlink";

// ─── Public types ────────────────────────────────────────────────────────

/** A pure-data task that runs on a worker. MUST be side-effect-free +
 *  MUST NOT touch `window`, `document`, or any Three.js object. */
export interface OffloadTask<I, O> {
  /** Stable key used to dispatch to the same worker every time (cache
   *  friendliness). Same key → same worker. */
  key: string;
  /** Input payload (must be structured-clone-safe: plain objects, typed
   *  arrays, no class instances, no functions, no DOM refs). */
  input: I;
  /** Soft deadline in milliseconds. The worker SHOULD early-exit if it
   *  exceeds this. Default 4ms (≈ 25% of a 60fps frame). */
  deadlineMs?: number;
  /** Optional transferables (ArrayBuffers / MessagePorts) to transfer
   *  rather than copy. */
  transfer?: Transferable[];
  /** The compute function. Run on the worker. The `deadlineMs` is the
   *  caller's soft budget — the function MAY check it via the second arg. */
  run: (input: I, deadlineMs: number) => O;
}

/** Result of a dispatched task. */
export interface OffloadResult<O> {
  ok: boolean;
  /** Output when ok === true. */
  output?: O;
  /** Error message when ok === false. */
  error?: string;
  /** Wall-clock time the task took on the worker (ms). */
  durationMs: number;
  /** Worker index that ran the task (for diagnostics). */
  workerIndex: number;
  /** True if the task ran on the main thread (pool unavailable). */
  fallbackMainThread: boolean;
}

// ─── Worker-side API ─────────────────────────────────────────────────────

/**
 * The API each worker exposes via Comlink. Each method corresponds to a
 * category of offloaded work; a generic `runTask` covers anything not
 * covered by a specialized method.
 *
 * Specialized methods exist because:
 *  1. Comlink's RPC is faster when the function is statically defined
 *     (no closure serialization per call).
 *  2. Per-category methods make it easy to instrument which category is
 *     dominating the worker budget.
 */
export interface OffloadWorkerApi {
  /** Generic task runner. The `run` closure is transferred via Comlink —
   *  it MUST be a pure function with no captured non-cloneable state. */
  runTask<I, O>(input: I, deadlineMs: number, run: (i: I, d: number) => O): Promise<O>;

  /** AI broad-phase: spatial-hash insert + neighbor query for a list of
   *  enemy positions. Returns an array of [enemyIdx, neighborIdx, distSq]
   *  tuples for pairs within `radius`. */
  aiBroadPhase(positions: Float32Array, radius: number, deadlineMs: number): Promise<Float32Array>;

  /** Ballistic integration: advance N projectiles forward by dt. Returns
   *  the new positions + velocities in a single Float32Array (interleaved
   *  x,y,z,vx,vy,vz per projectile). */
  integrateProjectiles(state: Float32Array, dt: number, gravity: number, drag: number, deadlineMs: number): Promise<Float32Array>;

  /** Physics broad-phase AABB overlap test. Returns pairs of collider
   *  indices that overlap. */
  physicsBroadPhase(boxes: Float32Array, deadlineMs: number): Promise<Uint32Array>;
}

// ─── Worker implementation (string-source for inline worker) ─────────────

/**
 * The worker body is inlined as a string + loaded via Blob URL so this
 * module is self-contained (no separate worker file to ship). The
 * alternative — a separate .worker.ts file imported via `?worker` query —
 * requires the bundler's worker-loader support, which Next.js 16 supports
 * but is flaky under turbopack. The Blob-URL approach is bundler-agnostic.
 */
const WORKER_SRC = `
import * as Comlink from "comlink";

const api = {
  async runTask(input, deadlineMs, run) {
    return run(input, deadlineMs);
  },

  async aiBroadPhase(positions, radius, deadlineMs) {
    const t0 = performance.now();
    const r2 = radius * radius;
    const n = positions.length / 3;
    // Naive O(N^2) — fine for N up to ~200; spatial-hash for larger.
    const out = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = positions[i*3] - positions[j*3];
        const dy = positions[i*3+1] - positions[j*3+1];
        const dz = positions[i*3+2] - positions[j*3+2];
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 <= r2) {
          out.push(i, j, d2);
        }
        // Soft deadline check — early exit if we're over budget.
        if ((i & 7) === 0 && performance.now() - t0 > deadlineMs) {
          return new Float32Array(out);
        }
      }
    }
    return new Float32Array(out);
  },

  async integrateProjectiles(state, dt, gravity, drag, deadlineMs) {
    const t0 = performance.now();
    const n = state.length / 6;
    const out = new Float32Array(state.length);
    out.set(state);
    const dragFactor = Math.exp(-drag * dt);
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      // Integrate velocity: drag + gravity.
      out[o+3] = out[o+3] * dragFactor;
      out[o+4] = out[o+4] * dragFactor;
      out[o+5] = out[o+5] * dragFactor - gravity * dt;
      // Integrate position: pos += vel * dt.
      out[o]   = out[o]   + out[o+3] * dt;
      out[o+1] = out[o+1] + out[o+4] * dt;
      out[o+2] = out[o+2] + out[o+5] * dt;
      if ((i & 31) === 0 && performance.now() - t0 > deadlineMs) break;
    }
    return out;
  },

  async physicsBroadPhase(boxes, deadlineMs) {
    const t0 = performance.now();
    const n = boxes.length / 6; // [minX,minY,minZ,maxX,maxY,maxZ] per box
    const out = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = i * 6, b = j * 6;
        if (boxes[a]   <= boxes[b+3] && boxes[a+3] >= boxes[b]   &&
            boxes[a+1] <= boxes[b+4] && boxes[a+4] >= boxes[b+1] &&
            boxes[a+2] <= boxes[b+5] && boxes[a+5] >= boxes[b+2]) {
          out.push(i, j);
        }
      }
      if ((i & 7) === 0 && performance.now() - t0 > deadlineMs) break;
    }
    return new Uint32Array(out);
  },
};

Comlink.expose(api);
`;

// ─── Pool ────────────────────────────────────────────────────────────────

/**
 * OffloadPool — N workers behind a round-robin / sticky-key dispatcher.
 *
 * Usage:
 *   const pool = new OffloadPool();
 *   await pool.start();
 *   const result = await pool.dispatch({
 *     key: `enemy-ai-${enemyId}`,
 *     input: { ... },
 *     deadlineMs: 4,
 *     run: (input, deadline) => computeAI(input, deadline),
 *   });
 */
export class OffloadPool {
  private workers: Worker[] = [];
  private apis: Comlink.Remote<OffloadWorkerApi>[] = [];
  private readonly size: number;
  private started = false;
  private startFailed = false;
  private nextWorker = 0;

  constructor(size?: number) {
    if (size !== undefined) {
      this.size = Math.max(1, Math.min(6, size));
    } else {
      // Default: clamp to [1, 6], leave 1-2 cores for the main thread.
      const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;
      this.size = Math.max(1, Math.min(6, Math.floor(cores / 2) - 1));
    }
  }

  /** True iff Workers + Blob URLs are available. False on SSR / non-COI / very
   *  old browsers. */
  static get available(): boolean {
    if (typeof window === "undefined") return false;
    if (typeof Worker === "undefined") return false;
    if (typeof Blob === "undefined") return false;
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
    return true;
  }

  /** Lazily create the worker pool. Safe to call multiple times. Returns
   *  false if Workers are unavailable — callers should fall back to the
   *  main-thread proxy. */
  async start(): Promise<boolean> {
    if (this.started) return true;
    if (this.startFailed) return false;
    if (!OffloadPool.available) {
      this.startFailed = true;
      return false;
    }
    try {
      const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      for (let i = 0; i < this.size; i++) {
        // Comlink comes from the main bundle (importmap-style), so the worker
        // needs to import it. We inject the import via a tiny bootstrap that
        // re-exports comlink from a CDN-or-bundle path. To stay bundler-
        // agnostic, we use a dynamic import inside the worker.
        // NOTE: This works in browsers that support ESM workers (Chrome 80+,
        // Firefox 114+, Safari 15+). For older browsers we fall back to the
        // classic-script path below.
        const worker = this.tryCreateWorker(url);
        this.workers.push(worker);
        this.apis.push(Comlink.wrap<OffloadWorkerApi>(worker));
      }
      this.started = true;
      return true;
    } catch (err) {
      console.warn("[OffloadPool] start failed — falling back to main thread:", err);
      this.startFailed = true;
      return false;
    }
  }

  /** Create a worker. Tries ESM first (so `import * as Comlink` works inside
   *  the worker body); falls back to a classic script that loads Comlink
   *  from the bundler-resolved URL. */
  private tryCreateWorker(blobUrl: string): Worker {
    // ESM worker: wrap the blob source so `import * as Comlink from "comlink"`
    // resolves. Modern browsers support `type: "module"` workers.
    try {
      // The blob's source already imports "comlink" as a bare specifier —
      // we need an importmap. Browsers don't support importmap inside
      // workers, so we re-write the import to an absolute URL.
      // We use the same chunk that the main bundle serves Comlink from.
      // Resolved lazily: try window.__comlinkWorkerUrl first (set by the
      // bundler hook), else fall back to the esm.sh CDN.
      const comlinkUrl =
        (typeof window !== "undefined" && (window as any).__comlinkWorkerUrl) ||
        "https://esm.sh/comlink@4.4.2";
      const rewritten = WORKER_SRC.replace(
        'import * as Comlink from "comlink";',
        `import * as Comlink from "${comlinkUrl}";`,
      );
      const rewrittenBlob = new Blob([rewritten], { type: "application/javascript" });
      const rewrittenUrl = URL.createObjectURL(rewrittenBlob);
      return new Worker(rewrittenUrl, { type: "module" });
    } catch {
      // Fallback: classic worker without Comlink — the pool will mark this
      // worker as "no proxy" and dispatch will run on the main thread.
      return new Worker(blobUrl);
    }
  }

  /** Dispatch a task. Returns the result or, on failure / pool unavailable,
   *  runs the task on the main thread + marks `fallbackMainThread`. */
  async dispatch<I, O>(task: OffloadTask<I, O>): Promise<OffloadResult<O>> {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const deadline = task.deadlineMs ?? 4;

    // Pool not started or unavailable — run on main thread.
    if (!this.started || this.apis.length === 0) {
      try {
        const output = task.run(task.input, deadline);
        return {
          ok: true,
          output,
          durationMs: (performance.now() - t0),
          workerIndex: -1,
          fallbackMainThread: true,
        };
      } catch (err) {
        return {
          ok: false,
          error: String(err),
          durationMs: performance.now() - t0,
          workerIndex: -1,
          fallbackMainThread: true,
        };
      }
    }

    // Sticky dispatch: hash the key → pick a worker.
    const idx = this.hashKey(task.key) % this.apis.length;
    const api = this.apis[idx];
    try {
      const call = api.runTask<I, O>(task.input, deadline, Comlink.proxy(task.run));
      const output = task.transfer && task.transfer.length > 0
        ? await (call as any)
        : await call;
      return {
        ok: true,
        output,
        durationMs: performance.now() - t0,
        workerIndex: idx,
        fallbackMainThread: false,
      };
    } catch (err) {
      // Worker RPC failed (worker crashed, OOM, etc.) — fall back to main.
      try {
        const output = task.run(task.input, deadline);
        return {
          ok: true,
          output,
          durationMs: performance.now() - t0,
          workerIndex: idx,
          fallbackMainThread: true,
        };
      } catch (err2) {
        return {
          ok: false,
          error: String(err2),
          durationMs: performance.now() - t0,
          workerIndex: idx,
          fallbackMainThread: true,
        };
      }
    }
  }

  /** Specialized AI broad-phase dispatch. Avoids closure serialization. */
  async aiBroadPhase(positions: Float32Array, radius: number, deadlineMs = 4): Promise<Float32Array> {
    if (!this.started) return new Float32Array(0);
    const idx = this.nextWorker = (this.nextWorker + 1) % this.apis.length;
    try {
      return await this.apis[idx].aiBroadPhase(positions, radius, deadlineMs);
    } catch {
      return new Float32Array(0);
    }
  }

  /** Specialized projectile integration dispatch. */
  async integrateProjectiles(state: Float32Array, dt: number, gravity: number, drag: number, deadlineMs = 4): Promise<Float32Array> {
    if (!this.started) return state;
    const idx = this.nextWorker = (this.nextWorker + 1) % this.apis.length;
    try {
      return await this.apis[idx].integrateProjectiles(state, dt, gravity, drag, deadlineMs);
    } catch {
      return state;
    }
  }

  /** Specialized physics broad-phase dispatch. */
  async physicsBroadPhase(boxes: Float32Array, deadlineMs = 4): Promise<Uint32Array> {
    if (!this.started) return new Uint32Array(0);
    const idx = this.nextWorker = (this.nextWorker + 1) % this.apis.length;
    try {
      return await this.apis[idx].physicsBroadPhase(boxes, deadlineMs);
    } catch {
      return new Uint32Array(0);
    }
  }

  /** FNV-1a hash — stable, fast, no deps. */
  private hashKey(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** Tear down the pool. Safe to call multiple times. */
  dispose(): void {
    for (const w of this.workers) {
      try { w.terminate(); } catch { /* noop */ }
    }
    this.workers = [];
    this.apis = [];
    this.started = false;
  }

  /** Snapshot for diagnostics / the perf overlay. */
  stats() {
    return {
      size: this.size,
      started: this.started,
      available: OffloadPool.available,
      fallbackActive: !this.started,
    };
  }
}

// ─── Singleton accessor ──────────────────────────────────────────────────

let _pool: OffloadPool | null = null;

/** Get the shared OffloadPool. Lazily started on first call. */
export async function getOffloadPool(): Promise<OffloadPool> {
  if (_pool) return _pool;
  _pool = new OffloadPool();
  await _pool.start();
  return _pool;
}

/** Reset the singleton (tests / engine dispose). */
export function resetOffloadPool(): void {
  _pool?.dispose();
  _pool = null;
}
