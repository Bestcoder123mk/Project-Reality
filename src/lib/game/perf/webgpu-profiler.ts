/**
 * Section L / L_Performance_Optimization.txt
 * Prompts: 16, 41, 42, 45, 54 ("WebGPU pipeline creation" + "WebGPU compute shader")
 *
 * webgpu-profiler.ts — GPU timing queries for WebGPU.
 *
 * The FrameBudgetProfiler tracks CPU-side frame time but is blind to GPU
 * time. On a GPU-bound scene (high triangle count, complex shaders), the
 * CPU budget is met but the GPU is the bottleneck — the frame still
 * drops. WebGPU exposes GPU timing queries via `GPUCommandEncoder
 * .beginRenderPass` + `GPUQuerySet` (timestamp queries) which let us
 * measure the actual GPU time per pass.
 *
 * This module:
 *
 *   - Wraps a GPUDevice + GPUCommandEncoder pair with timestamp-query
 *     instrumentation.
 *   - Records begin/end timestamps per named pass (e.g. "opaque",
 *     "transparent", "shadow", "postprocess", "compute-cull").
 *   - Resolves the timestamp query set to a result buffer + reads it
 *     back asynchronously (so it doesn't stall the GPU pipeline).
 *   - Exposes a per-pass avg/peak GPU time API mirroring the
 *     FrameBudgetProfiler's per-subsystem CPU timing API.
 *
 * Degradation: if WebGPU is unavailable, the profiler is a no-op. The
 * `getPassTime()` methods return 0 and `beginPass()` returns a stub
 * object — callers don't have to branch on capability.
 *
 * Permission note: timestamp queries require `enable-timestamp-query` in
 * the device descriptor on some browsers (it's behind a flag in Chrome).
 * The profiler checks `adapter.features.has("timestamp-query")` and
 * silently degrades if not available.
 */

// ─── Public types ────────────────────────────────────────────────────────

/** A tracked GPU pass — returned by `beginPass()`, ended by `endPass()`. */
export interface GPUPassScope {
  name: string;
  beginIndex: number;
}

/** Per-pass GPU timing snapshot. */
export interface GPUPassTiming {
  name: string;
  /** Rolling average GPU time (ms). */
  avgMs: number;
  /** Last frame's GPU time (ms). */
  lastMs: number;
  /** Peak GPU time over the rolling window (ms). */
  peakMs: number;
  /** Number of samples captured. */
  samples: number;
}

/** Per-frame GPU timing snapshot. */
export interface GPUFrameTiming {
  /** Total GPU time (ms) — sum of all passes. */
  totalMs: number;
  /** Per-pass timings. */
  passes: GPUPassTiming[];
  /** True if the GPU time exceeded the CPU frame time (GPU-bound). */
  gpuBound: boolean;
  /** True if timestamps are actually being read (false on unsupported HW). */
  timestampQueriesEnabled: boolean;
}

// ─── WebGPU profiler ─────────────────────────────────────────────────────

const ROLLING_WINDOW = 60;
const MAX_PASSES_PER_FRAME = 32;
const MAX_QUERIES = MAX_PASSES_PER_FRAME * 2 + 4; // begin + end per pass + padding

/**
 * WebGPUGPUProfiler — instrument GPU passes with timestamp queries.
 *
 * Usage:
 *   const prof = new WebGPUGPUProfiler();
 *   await prof.init(device);
 *   // Per frame:
 *   const encoder = device.createCommandEncoder();
 *   const scope = prof.beginPass(encoder, "opaque");
 *   ... // draw calls
 *   prof.endPass(encoder, scope);
 *   prof.resolveFrame(encoder);
 *   device.queue.submit([encoder.finish()]);
 *   // Read results (async, returns the PREVIOUS frame's results):
 *   const timing = prof.getFrameTiming();
 */
export class WebGPUGPUProfiler {
  private device: GPUDevice | null = null;
  private querySet: GPUQuerySet | null = null;
  private resolveBuffer: GPUBuffer | null = null;
  private resultBuffer: GPUBuffer | null = null;
  private readBuffer: GPUBuffer | null = null;
  private timestampQueriesEnabled = false;

  private pendingBegins: number[] = [];
  private pendingEnds: number[] = [];
  private pendingNames: string[] = [];
  private queryIndex = 0;

  private passTimings = new Map<string, {
    samples: number[];
    head: number;
    avgMs: number;
    lastMs: number;
    peakMs: number;
  }>();

  private lastFrameTotalMs = 0;
  private lastCpuFrameMs = 16.6;

  /** Initialize the profiler with a GPUDevice. Returns false if timestamp
   *  queries are not supported (the profiler becomes a no-op). */
  async init(device: GPUDevice): Promise<boolean> {
    this.device = device;
    // Check support.
    const hasTimestampQuery = device.features.has("timestamp-query" as GPUFeatureName);
    if (!hasTimestampQuery) {
      console.info("[WebGPUProfiler] timestamp-query not available — GPU timing disabled");
      this.timestampQueriesEnabled = false;
      return false;
    }
    try {
      this.querySet = device.createQuerySet({
        type: "timestamp",
        count: MAX_QUERIES,
      });
      this.resolveBuffer = device.createBuffer({
        size: MAX_QUERIES * 8,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      this.resultBuffer = device.createBuffer({
        size: MAX_QUERIES * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.timestampQueriesEnabled = true;
      return true;
    } catch (err) {
      console.warn("[WebGPUProfiler] init failed:", err);
      this.timestampQueriesEnabled = false;
      return false;
    }
  }

  /** Begin a tracked pass. Returns a scope to pass to `endPass()`. */
  beginPass(encoder: GPUCommandEncoder, name: string): GPUPassScope {
    if (!this.timestampQueriesEnabled || !this.querySet) {
      return { name, beginIndex: -1 };
    }
    const beginIndex = this.queryIndex++;
    encoder.writeTimestamp(this.querySet, beginIndex);
    this.pendingBegins.push(beginIndex);
    this.pendingNames.push(name);
    return { name, beginIndex };
  }

  /** End a tracked pass. */
  endPass(encoder: GPUCommandEncoder, scope: GPUPassScope): void {
    if (!this.timestampQueriesEnabled || !this.querySet || scope.beginIndex < 0) return;
    const endIndex = this.queryIndex++;
    encoder.writeTimestamp(this.querySet, endIndex);
    this.pendingEnds.push(endIndex);
  }

  /** Resolve this frame's timestamp queries + schedule a readback. Call
   *  BEFORE `encoder.finish()` but AFTER all `endPass()` calls. */
  resolveFrame(encoder: GPUCommandEncoder): void {
    if (!this.timestampQueriesEnabled || !this.querySet || !this.resolveBuffer || !this.resultBuffer) {
      this.pendingBegins = [];
      this.pendingEnds = [];
      this.pendingNames = [];
      this.queryIndex = 0;
      return;
    }
    // Resolve the query set into the resolve buffer.
    encoder.resolveQuerySet(this.querySet, 0, this.queryIndex, this.resolveBuffer, 0);
    // Copy to the result buffer (so we can map it without invalidating the resolve buffer).
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.resultBuffer, 0, this.queryIndex * 8);

    // Save the pending data for the async readback.
    const begins = this.pendingBegins;
    const ends = this.pendingEnds;
    const names = this.pendingNames;
    const buf = this.resultBuffer;
    this.pendingBegins = [];
    this.pendingEnds = [];
    this.pendingNames = [];
    this.queryIndex = 0;

    // Async readback — returns the PREVIOUS frame's results (because
    // mapAsync only resolves after the GPU finishes the current frame).
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const view = new BigInt64Array(buf.getMappedRange());
      let totalNs = 0n;
      for (let i = 0; i < begins.length; i++) {
        const begin = Number(view[begins[i]]);
        const end = Number(view[ends[i]]);
        const deltaNs = end - begin;
        const deltaMs = deltaNs / 1_000_000;
        totalNs += BigInt(deltaNs);
        this.recordSample(names[i], deltaMs);
      }
      this.lastFrameTotalMs = Number(totalNs) / 1_000_000;
      buf.unmap();
    }).catch(() => {
      // Readback failed — drop this frame's data.
      try { buf.unmap(); } catch { /* noop */ }
    });
  }

  /** Set the CPU frame time (for GPU-bound detection). */
  setCpuFrameTime(ms: number): void {
    this.lastCpuFrameMs = ms;
  }

  /** Get the latest frame's timing (or null if not yet available). */
  getFrameTiming(): GPUFrameTiming {
    const passes: GPUPassTiming[] = [];
    for (const [name, t] of this.passTimings) {
      passes.push({
        name,
        avgMs: t.avgMs,
        lastMs: t.lastMs,
        peakMs: t.peakMs,
        samples: t.samples.length,
      });
    }
    return {
      totalMs: this.lastFrameTotalMs,
      passes,
      gpuBound: this.lastFrameTotalMs > this.lastCpuFrameMs,
      timestampQueriesEnabled: this.timestampQueriesEnabled,
    };
  }

  /** Get the rolling average GPU time for a specific pass. */
  getPassTime(name: string): number {
    return this.passTimings.get(name)?.avgMs ?? 0;
  }

  /** Dispose GPU resources. */
  dispose(): void {
    this.querySet?.destroy();
    this.resolveBuffer?.destroy();
    this.resultBuffer?.destroy();
    this.readBuffer?.destroy();
    this.querySet = null;
    this.resolveBuffer = null;
    this.resultBuffer = null;
    this.readBuffer = null;
    this.device = null;
    this.passTimings.clear();
    this.timestampQueriesEnabled = false;
  }

  /** Record a sample for a pass. */
  private recordSample(name: string, ms: number): void {
    let entry = this.passTimings.get(name);
    if (!entry) {
      entry = {
        samples: new Array(ROLLING_WINDOW).fill(0),
        head: 0,
        avgMs: 0,
        lastMs: 0,
        peakMs: 0,
      };
      this.passTimings.set(name, entry);
    }
    entry.samples[entry.head] = ms;
    entry.head = (entry.head + 1) % ROLLING_WINDOW;
    entry.lastMs = ms;
    if (ms > entry.peakMs) entry.peakMs = ms;
    let sum = 0;
    for (let i = 0; i < ROLLING_WINDOW; i++) sum += entry.samples[i];
    entry.avgMs = sum / ROLLING_WINDOW;
  }
}

// ─── WebGL2 fallback ─────────────────────────────────────────────────────

/**
 * WebGL2GPUProfiler — emulates the WebGPU profiler API on top of the
 * EXT_disjoint_timer_query_webgl2 extension. Same public API so callers
 * don't branch on backend.
 *
 * Returns 0 for all timing methods when the extension is unavailable
 * (it's missing on Safari, iOS, and many mobile GPUs).
 */
export class WebGL2GPUProfiler {
  private gl: WebGL2RenderingContext | null = null;
  private ext: any = null;
  private enabled = false;
  private pendingQueries: Array<{ name: string; q: WebGLQuery }> = [];
  private passTimings = new Map<string, {
    samples: number[];
    head: number;
    avgMs: number;
    lastMs: number;
    peakMs: number;
  }>();
  private lastFrameTotalMs = 0;
  private lastCpuFrameMs = 16.6;

  init(gl: WebGL2RenderingContext): boolean {
    this.gl = gl;
    try {
      this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      if (!this.ext) {
        this.enabled = false;
        return false;
      }
      this.enabled = true;
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  beginPass(_name: string): GPUPassScope {
    if (!this.enabled || !this.gl || !this.ext) return { name: _name, beginIndex: -1 };
    const q = this.gl.createQuery();
    if (!q) return { name: _name, beginIndex: -1 };
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.pendingQueries.push({ name: _name, q });
    return { name: _name, beginIndex: this.pendingQueries.length - 1 };
  }

  endPass(_scope: GPUPassScope): void {
    if (!this.enabled || !this.gl || !this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
  }

  resolveFrame(_encoder?: any): void {
    if (!this.enabled || !this.gl) return;
    // Poll all pending queries — read available results.
    const stillPending: Array<{ name: string; q: WebGLQuery }> = [];
    let totalMs = 0;
    for (const pq of this.pendingQueries) {
      const available = this.gl.getQueryParameter(pq.q, this.gl.QUERY_RESULT_AVAILABLE);
      if (!available) {
        stillPending.push(pq);
        continue;
      }
      const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (disjoint) {
        this.gl.deleteQuery(pq.q);
        continue;
      }
      const ns = this.gl.getQueryParameter(pq.q, this.gl.QUERY_RESULT);
      const ms = Number(ns) / 1_000_000;
      totalMs += ms;
      this.recordSample(pq.name, ms);
      this.gl.deleteQuery(pq.q);
    }
    this.pendingQueries = stillPending;
    this.lastFrameTotalMs = totalMs;
  }

  setCpuFrameTime(ms: number): void { this.lastCpuFrameMs = ms; }

  getFrameTiming(): GPUFrameTiming {
    const passes: GPUPassTiming[] = [];
    for (const [name, t] of this.passTimings) {
      passes.push({
        name, avgMs: t.avgMs, lastMs: t.lastMs, peakMs: t.peakMs,
        samples: t.samples.length,
      });
    }
    return {
      totalMs: this.lastFrameTotalMs,
      passes,
      gpuBound: this.lastFrameTotalMs > this.lastCpuFrameMs,
      timestampQueriesEnabled: this.enabled,
    };
  }

  getPassTime(name: string): number {
    return this.passTimings.get(name)?.avgMs ?? 0;
  }

  dispose(): void {
    if (this.gl) {
      for (const pq of this.pendingQueries) this.gl.deleteQuery(pq.q);
    }
    this.pendingQueries = [];
    this.passTimings.clear();
    this.enabled = false;
  }

  private recordSample(name: string, ms: number): void {
    let entry = this.passTimings.get(name);
    if (!entry) {
      entry = {
        samples: new Array(ROLLING_WINDOW).fill(0),
        head: 0,
        avgMs: 0,
        lastMs: 0,
        peakMs: 0,
      };
      this.passTimings.set(name, entry);
    }
    entry.samples[entry.head] = ms;
    entry.head = (entry.head + 1) % ROLLING_WINDOW;
    entry.lastMs = ms;
    if (ms > entry.peakMs) entry.peakMs = ms;
    let sum = 0;
    for (let i = 0; i < ROLLING_WINDOW; i++) sum += entry.samples[i];
    entry.avgMs = sum / ROLLING_WINDOW;
  }
}

// ─── Union type + factory ────────────────────────────────────────────────

export type AnyGPUProfiler = WebGPUGPUProfiler | WebGL2GPUProfiler;

/** Create the appropriate profiler for the backend. */
export async function createGPUProfiler(opts: {
  webgpuDevice?: GPUDevice;
  gl?: WebGL2RenderingContext;
}): Promise<AnyGPUProfiler> {
  if (opts.webgpuDevice) {
    const prof = new WebGPUGPUProfiler();
    await prof.init(opts.webgpuDevice);
    return prof;
  }
  if (opts.gl) {
    const prof = new WebGL2GPUProfiler();
    prof.init(opts.gl);
    return prof;
  }
  // Default to a no-op WebGPU profiler.
  return new WebGPUGPUProfiler();
}
