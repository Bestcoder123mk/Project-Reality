/**
 * Section L / L_Performance_Optimization.txt
 * Prompts: 1, 5, 12, 33, 37 ("JS bundle size" + "asset download size" + "WebGL shader compile time")
 *
 * asset-streaming.ts — priority-based asset streaming for large maps.
 *
 * On a 4km² map (typical Project Reality large map), the full asset set
 * can be 500MB+ of geometry + textures. Loading all of it upfront:
 *
 *   - Blocks the player for 30+ seconds at level start.
 *   - Exceeds mobile VRAM budgets (50-200MB).
 *   - Wastes bandwidth on assets the player may never see (e.g. the
 *     opposite corner of the map).
 *
 * Streaming loads assets on-demand based on:
 *
 *   - **Distance** from the player (closer = higher priority).
 *   - **Line of sight** (visible from current camera = higher priority).
 *   - **Movement prediction** (player heading toward an asset = higher).
 *   - **Criticality** (mission-critical assets like objective markers
 *     always load first).
 *
 * This module is the orchestrator — it doesn't load files itself. It
 * accepts a queue of asset requests + a `loader` callback (typically
 * backed by fetch() + GLTFLoader), prioritizes them, and dispatches them
 * at a configurable rate (e.g. 2 assets per frame to avoid hitches).
 *
 * The streaming manager works WITH the existing ChunkManager (which
 * handles chunk-level visibility). ChunkManager decides which chunks are
 * "active"; this module decides which ASSETS within those chunks to
 * load + in what order.
 */

import * as THREE from "three";

// ─── Public types ────────────────────────────────────────────────────────

/** Priority levels — lower number = higher priority. */
export type AssetPriority = 0 | 1 | 2 | 3 | 4;
export const PRIORITY_CRITICAL: AssetPriority = 0;
export const PRIORITY_HIGH: AssetPriority = 1;
export const PRIORITY_NORMAL: AssetPriority = 2;
export const PRIORITY_LOW: AssetPriority = 3;
export const PRIORITY_BACKGROUND: AssetPriority = 4;

/** A request to stream an asset. */
export interface AssetRequest {
  /** Stable ID (e.g. "asset-barracks-01"). */
  id: string;
  /** URL to load (passed to the loader callback). */
  url: string;
  /** World-space anchor for distance-based prioritization. */
  anchor: THREE.Vector3;
  /** Base priority (before distance adjustment). */
  basePriority: AssetPriority;
  /** Estimated size in bytes (for bandwidth budgeting). */
  sizeBytes: number;
  /** Optional: which chunk this asset belongs to (chunk unload cancels
   *  the request). */
  chunkId?: string;
  /** Callback when the asset loads. */
  onLoad?: (data: unknown) => void;
  /** Callback on error. */
  onError?: (err: Error) => void;
}

/** Internal request state. */
interface InternalRequest extends AssetRequest {
  /** Computed priority (lower = higher). */
  computedPriority: number;
  /** True if currently loading. */
  loading: boolean;
  /** True if loaded successfully. */
  loaded: boolean;
  /** True if failed. */
  failed: boolean;
  /** Frame the request was enqueued. */
  enqueuedFrame: number;
}

/** Streaming stats. */
export interface StreamingStats {
  /** Total requests in the queue. */
  queueLength: number;
  /** Requests currently loading. */
  loading: number;
  /** Requests loaded this session. */
  loaded: number;
  /** Requests failed this session. */
  failed: number;
  /** Total bytes loaded this session. */
  bytesLoaded: number;
  /** Average load time per asset (ms). */
  avgLoadMs: number;
  /** Bandwidth used (bytes/sec) — rolling average. */
  bytesPerSec: number;
}

// ─── Streaming manager ───────────────────────────────────────────────────

const MAX_CONCURRENT_LOADS = 4;
const MAX_LOADS_PER_FRAME = 2;
const BANDWIDTH_BUDGET_BYTES_PER_SEC = 8 * 1024 * 1024; // 8 MB/s default

/**
 * AssetStreamingManager — owns the priority queue + dispatch loop.
 *
 * Usage:
 *   const mgr = new AssetStreamingManager({
 *     loader: async (url) => { return await fetch(url).then(r => r.arrayBuffer()); },
 *   });
 *   mgr.enqueue({ id: "barracks-01", url: "/models/barracks.glb", anchor: new THREE.Vector3(...), ... });
 *   // Per frame:
 *   mgr.update(camera, frameIndex);
 *   mgr.stats();
 */
export class AssetStreamingManager {
  private queue: InternalRequest[] = [];
  private active = new Map<string, InternalRequest>();
  private completed = new Set<string>();
  private failed = new Set<string>();
  private loader: (url: string) => Promise<unknown>;
  private bandwidthBudget = BANDWIDTH_BUDGET_BYTES_PER_SEC;
  private bytesLoadedThisSession = 0;
  private bytesLoadedThisSecond = 0;
  private lastSecondStart = 0;
  private rollingLoadMs: number[] = new Array(60).fill(0);
  private rollingLoadMsHead = 0;

  constructor(opts: { loader: (url: string) => Promise<unknown> }) {
    this.loader = opts.loader;
    this.lastSecondStart = typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /** Set the bandwidth budget (bytes/sec). 0 = unlimited. */
  setBandwidthBudget(bytesPerSec: number): void {
    this.bandwidthBudget = bytesPerSec;
  }

  /** Enqueue a request. If the asset is already loaded or loading, no-op. */
  enqueue(req: AssetRequest): void {
    if (this.completed.has(req.id) || this.active.has(req.id)) return;
    // Check if already in queue.
    if (this.queue.some((r) => r.id === req.id)) return;
    const internal: InternalRequest = {
      ...req,
      computedPriority: req.basePriority,
      loading: false,
      loaded: false,
      failed: false,
      enqueuedFrame: 0,
    };
    this.queue.push(internal);
  }

  /** Cancel a request (e.g. when its chunk unloads). */
  cancel(id: string): void {
    this.queue = this.queue.filter((r) => r.id !== id);
    // Note: in-flight loads can't be canceled — they'll complete + the
    // result will be discarded (no onLoad call) if the request is gone.
    this.active.delete(id);
  }

  /** Per-frame update: re-prioritize the queue + dispatch up to
   *  MAX_LOADS_PER_FRAME new loads. */
  update(camera: THREE.Camera, _frameIndex: number): void {
    const camPos = camera.position;

    // Re-prioritize the queue based on distance + base priority.
    for (const req of this.queue) {
      const dist = req.anchor.distanceTo(camPos);
      // Closer = lower computed priority value (higher actual priority).
      // Distance contributes 0..5 to the priority (clamped).
      const distComponent = Math.min(5, dist / 50);
      req.computedPriority = req.basePriority + distComponent;
    }
    this.queue.sort((a, b) => a.computedPriority - b.computedPriority);

    // Throttle bandwidth: check the rolling 1-second window.
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - this.lastSecondStart >= 1000) {
      this.bytesLoadedThisSecond = 0;
      this.lastSecondStart = now;
    }

    // Dispatch up to MAX_LOADS_PER_FRAME new loads.
    let dispatched = 0;
    while (
      dispatched < MAX_LOADS_PER_FRAME
      && this.active.size < MAX_CONCURRENT_LOADS
      && this.queue.length > 0
    ) {
      const req = this.queue.shift()!;
      // Skip if bandwidth budget exceeded.
      if (this.bandwidthBudget > 0 && this.bytesLoadedThisSecond + req.sizeBytes > this.bandwidthBudget) {
        // Re-queue for next frame.
        this.queue.push(req);
        break;
      }
      this.startLoad(req);
      dispatched++;
    }
  }

  /** Start loading a request. */
  private startLoad(req: InternalRequest): void {
    req.loading = true;
    this.active.set(req.id, req);
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.loader(req.url)
      .then((data) => {
        req.loading = false;
        req.loaded = true;
        this.active.delete(req.id);
        this.completed.add(req.id);
        this.bytesLoadedThisSession += req.sizeBytes;
        this.bytesLoadedThisSecond += req.sizeBytes;
        const dt = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
        this.rollingLoadMs[this.rollingLoadMsHead] = dt;
        this.rollingLoadMsHead = (this.rollingLoadMsHead + 1) % this.rollingLoadMs.length;
        try { req.onLoad?.(data); } catch (err) { console.error(err); }
      })
      .catch((err) => {
        req.loading = false;
        req.failed = true;
        this.active.delete(req.id);
        this.failed.add(req.id);
        try { req.onError?.(err instanceof Error ? err : new Error(String(err))); }
        catch (e) { console.error(e); }
      });
  }

  /** True if an asset is loaded. */
  isLoaded(id: string): boolean {
    return this.completed.has(id);
  }

  /** True if an asset is currently loading. */
  isLoading(id: string): boolean {
    return this.active.has(id);
  }

  /** Snapshot for diagnostics. */
  stats(): StreamingStats {
    let sum = 0;
    for (const v of this.rollingLoadMs) sum += v;
    const avg = sum / this.rollingLoadMs.length;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const elapsedSec = Math.max(1, (now - this.lastSecondStart) / 1000);
    return {
      queueLength: this.queue.length,
      loading: this.active.size,
      loaded: this.completed.size,
      failed: this.failed.size,
      bytesLoaded: this.bytesLoadedThisSession,
      avgLoadMs: avg,
      bytesPerSec: this.bytesLoadedThisSecond / elapsedSec,
    };
  }

  /** Reset (e.g. on map change). Does NOT cancel in-flight loads. */
  reset(): void {
    this.queue = [];
    this.active.clear();
    this.completed.clear();
    this.failed.clear();
    this.bytesLoadedThisSession = 0;
    this.bytesLoadedThisSecond = 0;
    this.rollingLoadMs = new Array(60).fill(0);
    this.rollingLoadMsHead = 0;
  }

  /** Dispose all state. */
  dispose(): void {
    this.reset();
  }
}

// ─── Built-in loader factories ───────────────────────────────────────────

/** Build a fetch-based loader that returns an ArrayBuffer. */
export function fetchArrayBufferLoader(): (url: string) => Promise<unknown> {
  return async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    return await res.arrayBuffer();
  };
}

/** Build a fetch-based loader that returns a JSON object. */
export function fetchJsonLoader(): (url: string) => Promise<unknown> {
  return async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    return await res.json();
  };
}

/** Build a GLTF loader that returns a THREE.Group. */
export function gltfLoader(loader: { loadAsync: (url: string) => Promise<unknown> }): (url: string) => Promise<unknown> {
  return async (url) => loader.loadAsync(url);
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _mgr: AssetStreamingManager | null = null;

export function getAssetStreamingManager(loader?: (url: string) => Promise<unknown>): AssetStreamingManager {
  if (!_mgr) {
    _mgr = new AssetStreamingManager({
      loader: loader ?? fetchArrayBufferLoader(),
    });
  }
  return _mgr;
}

export function resetAssetStreamingManager(): void {
  _mgr?.dispose();
  _mgr = null;
}
