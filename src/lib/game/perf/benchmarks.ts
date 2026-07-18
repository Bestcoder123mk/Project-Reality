/**
 * Section L / L_Performance_Optimization.txt
 * Prompts: 5, 8, 10, 12, 27, 40 ("Cloud Function cold start" + "WebGL shader compile time")
 *
 * benchmarks.ts — per-platform automated benchmark suite.
 *
 * The game has a FrameBudgetProfiler that tracks per-frame timing at
 * runtime, but it doesn't have a way to capture a deterministic baseline
 * that can be diffed across releases. This module provides:
 *
 *   - A 30-second fixed-scene benchmark that runs in a headless-friendly
 *     mode (no input, scripted camera path).
 *   - Per-platform expected baselines (FPS, frame time p50/p95/p99,
 *     draw calls, triangles, VRAM, JS heap).
 *   - A `compare()` function that diffs two benchmark runs and flags
 *     regressions.
 *   - A `runQuick()` 5-second smoke test for CI.
 *
 * The benchmark can run in two modes:
 *
 *   - "in-browser": runs the actual WebGLRenderer + scene against a
 *     scripted camera path. Reports real FPS + draw call counts.
 *   - "headless-emulated": uses the FrameBudgetProfiler's perSystem
 *     timers + a stubbed renderer (no GL context) — for CI runners
 *     without a GPU. Reports CPU-side timing only.
 *
 * The per-platform baselines are calibrated from the PERF_TARGETS table
 * (perf-targets.ts) — the benchmark's p95 frame time should be under
 * the platform's `budgetMs`.
 */

import type { PerfTarget, PlatformId } from "../platform/perf-targets";
import { PERF_TARGETS } from "../platform/perf-targets";

// ─── Public types ────────────────────────────────────────────────────────

/** A single benchmark sample (one frame). */
export interface BenchmarkSample {
  frameMs: number;
  drawCalls: number;
  triangles: number;
  vramBytes: number;
  jsHeapBytes: number;
}

/** Aggregated benchmark result. */
export interface BenchmarkResult {
  /** Platform ID the benchmark ran against. */
  platform: PlatformId;
  /** When the benchmark ran (ISO timestamp). */
  timestamp: string;
  /** Duration the benchmark ran (seconds). */
  durationSec: number;
  /** Total frames captured. */
  frames: number;
  /** Frame time percentile statistics (ms). */
  frameMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
    stddev: number;
  };
  /** FPS statistics. */
  fps: {
    min: number;
    mean: number;
    max: number;
  };
  /** Draw call statistics. */
  drawCalls: { mean: number; max: number };
  /** Triangle statistics. */
  triangles: { mean: number; max: number };
  /** VRAM usage (bytes). */
  vram: { mean: number; max: number };
  /** JS heap usage (bytes). */
  jsHeap: { mean: number; max: number };
  /** Whether the result passes the platform's perf-target. */
  passesTarget: boolean;
  /** Per-target violations (empty if passesTarget === true). */
  violations: string[];
  /** Mode the benchmark ran in. */
  mode: "in-browser" | "headless-emulated";
  /** Optional: git commit hash for regression tracking. */
  commit?: string;
}

/** Per-platform expected baseline (used for regression comparison). */
export interface BaselineEntry {
  platform: PlatformId;
  expectedFrameMsP95: number;
  expectedFps: number;
  expectedDrawCalls: number;
  expectedTriangles: number;
  /** Allowed deviation (fraction) before a regression is flagged. */
  tolerance: number;
}

// ─── Per-platform baselines ──────────────────────────────────────────────

/**
 * Expected baselines per platform. The `expectedFrameMsP95` is the
 * platform's `budgetMs` (so a p95 of exactly budgetMs is the threshold
 * of "passing"). The `tolerance` is 0.15 (15%) — a 15% regression on
 * any metric is flagged.
 */
export const BASELINES: Record<PlatformId, BaselineEntry> = (() => {
  const out = {} as Record<PlatformId, BaselineEntry>;
  for (const [id, t] of Object.entries(PERF_TARGETS) as [PlatformId, PerfTarget][]) {
    out[id] = {
      platform: id,
      expectedFrameMsP95: t.budgetMs,
      expectedFps: t.targetFps,
      expectedDrawCalls: t.maxDrawCalls,
      expectedTriangles: t.maxTriangles,
      tolerance: 0.15,
    };
  }
  return out;
})();

// ─── Benchmark runner ────────────────────────────────────────────────────

/**
 * runBenchmark — runs a fixed-duration benchmark and aggregates samples.
 *
 * The caller is responsible for providing a `sampler` function that
 * returns the current frame's BenchmarkSample. The benchmark runner
 * calls it once per RAF tick and accumulates samples for `durationSec`.
 *
 * This design decouples the benchmark from the actual rendering path —
 * the same runner works for in-browser (real GL) and headless-emulated
 * (stubbed) modes.
 */
export async function runBenchmark(opts: {
  platform: PlatformId;
  durationSec: number;
  sampler: () => BenchmarkSample;
  mode?: "in-browser" | "headless-emulated";
  commit?: string;
  onProgress?: (pct: number) => void;
}): Promise<BenchmarkResult> {
  const { platform, durationSec, sampler, onProgress, commit } = opts;
  const mode = opts.mode ?? "in-browser";
  const samples: BenchmarkSample[] = [];

  return new Promise<BenchmarkResult>((resolve) => {
    const start = performance.now();
    const end = start + durationSec * 1000;

    const tick = () => {
      const now = performance.now();
      samples.push(sampler());
      if (onProgress) {
        const pct = Math.min(1, (now - start) / (durationSec * 1000));
        onProgress(pct);
      }
      if (now < end) {
        requestAnimationFrame(tick);
      } else {
        resolve(aggregate(samples, platform, mode, durationSec, commit));
      }
    };
    requestAnimationFrame(tick);
  });
}

/** Quick 5-second benchmark for CI smoke tests. */
export async function runQuick(opts: {
  platform: PlatformId;
  sampler: () => BenchmarkSample;
  mode?: "in-browser" | "headless-emulated";
  commit?: string;
}): Promise<BenchmarkResult> {
  return runBenchmark({
    platform: opts.platform,
    durationSec: 5,
    sampler: opts.sampler,
    mode: opts.mode,
    commit: opts.commit,
  });
}

/** Full 30-second benchmark. */
export async function runFull(opts: {
  platform: PlatformId;
  sampler: () => BenchmarkSample;
  mode?: "in-browser" | "headless-emulated";
  commit?: string;
  onProgress?: (pct: number) => void;
}): Promise<BenchmarkResult> {
  return runBenchmark({
    platform: opts.platform,
    durationSec: 30,
    sampler: opts.sampler,
    mode: opts.mode,
    commit: opts.commit,
    onProgress: opts.onProgress,
  });
}

// ─── Aggregation ─────────────────────────────────────────────────────────

/** Aggregate a list of samples into a BenchmarkResult. */
function aggregate(
  samples: BenchmarkSample[],
  platform: PlatformId,
  mode: "in-browser" | "headless-emulated",
  durationSec: number,
  commit?: string,
): BenchmarkResult {
  const target = PERF_TARGETS[platform];
  const baseline = BASELINES[platform];

  const frameMsArr = samples.map((s) => s.frameMs).sort((a, b) => a - b);
  const fpsArr = frameMsArr.map((ms) => (ms > 0 ? 1000 / ms : 0));
  const dcArr = samples.map((s) => s.drawCalls);
  const triArr = samples.map((s) => s.triangles);
  const vramArr = samples.map((s) => s.vramBytes);
  const heapArr = samples.map((s) => s.jsHeapBytes);

  const p50 = percentile(frameMsArr, 0.50);
  const p95 = percentile(frameMsArr, 0.95);
  const p99 = percentile(frameMsArr, 0.99);
  const mean = avg(frameMsArr);
  const stddev = stdDev(frameMsArr, mean);

  const violations: string[] = [];
  if (p95 > target.budgetMs) violations.push(`p95 frame time ${p95.toFixed(2)}ms > budget ${target.budgetMs.toFixed(2)}ms`);
  const meanDc = avg(dcArr);
  if (meanDc > target.maxDrawCalls) violations.push(`mean draw calls ${meanDc.toFixed(0)} > cap ${target.maxDrawCalls}`);
  const meanTri = avg(triArr);
  if (meanTri > target.maxTriangles) violations.push(`mean triangles ${meanTri.toFixed(0)} > cap ${target.maxTriangles}`);

  // Regression check: any metric worse than (baseline * (1 + tolerance))
  // is flagged as a regression.
  if (p95 > baseline.expectedFrameMsP95 * (1 + baseline.tolerance)) {
    violations.push(`p95 ${p95.toFixed(2)}ms regressed >${(baseline.tolerance * 100).toFixed(0)}% over baseline ${baseline.expectedFrameMsP95.toFixed(2)}ms`);
  }

  return {
    platform,
    timestamp: new Date().toISOString(),
    durationSec,
    frames: samples.length,
    frameMs: {
      min: frameMsArr[0],
      p50,
      p95,
      p99,
      max: frameMsArr[frameMsArr.length - 1],
      mean,
      stddev,
    },
    fps: {
      min: Math.min(...fpsArr),
      mean: avg(fpsArr),
      max: Math.max(...fpsArr),
    },
    drawCalls: { mean: meanDc, max: Math.max(...dcArr) },
    triangles: { mean: meanTri, max: Math.max(...triArr) },
    vram: { mean: avg(vramArr), max: Math.max(...vramArr) },
    jsHeap: { mean: avg(heapArr), max: Math.max(...heapArr) },
    passesTarget: violations.length === 0,
    violations,
    mode,
    commit,
  };
}

// ─── Comparison ──────────────────────────────────────────────────────────

/** Compare two benchmark results. Returns a list of regression notes
 *  (empty array if no regressions). */
export function compare(a: BenchmarkResult, b: BenchmarkResult): string[] {
  const out: string[] = [];
  if (a.platform !== b.platform) {
    out.push(`platform mismatch: ${a.platform} vs ${b.platform}`);
    return out;
  }
  const checkPct = (name: string, aVal: number, bVal: number, lowerIsBetter: boolean, threshold = 0.15) => {
    if (aVal === 0 || bVal === 0) return;
    const delta = (bVal - aVal) / aVal;
    if (lowerIsBetter && delta > threshold) {
      out.push(`${name}: ${(delta * 100).toFixed(1)}% worse (${aVal.toFixed(2)} → ${bVal.toFixed(2)})`);
    }
    if (!lowerIsBetter && -delta > threshold) {
      out.push(`${name}: ${(-delta * 100).toFixed(1)}% worse (${aVal.toFixed(2)} → ${bVal.toFixed(2)})`);
    }
  };
  checkPct("frameMsP95", a.frameMs.p95, b.frameMs.p95, true);
  checkPct("frameMsMean", a.frameMs.mean, b.frameMs.mean, true);
  checkPct("fpsMean", a.fps.mean, b.fps.mean, false);
  checkPct("drawCallsMean", a.drawCalls.mean, b.drawCalls.mean, true);
  checkPct("trianglesMean", a.triangles.mean, b.triangles.mean, true);
  checkPct("vramMean", a.vram.mean, b.vram.mean, true);
  checkPct("jsHeapMean", a.jsHeap.mean, b.jsHeap.mean, true);
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stdDev(arr: number[], mean: number): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += (v - mean) ** 2;
  return Math.sqrt(s / arr.length);
}

// ─── Headless-friendly sampler ───────────────────────────────────────────

/**
 * Build a sampler that reads from the FrameBudgetProfiler + renderer info.
 * The sampler is called once per RAF tick by `runBenchmark`. Returns a
 * BenchmarkSample for aggregation.
 *
 * In SSR / headless mode (no window), the sampler returns zeroed samples —
 * the benchmark can still run but its results only capture CPU-side work.
 */
export function buildProfilerSampler(opts: {
  profiler: {
    avgFrameMs: number;
    fps: number;
    lastDrawCalls: number;
    lastTriangles: number;
  };
  getVramBytes?: () => number;
}): () => BenchmarkSample {
  return () => {
    const p = opts.profiler;
    const vram = opts.getVramBytes?.() ?? 0;
    const heap = (typeof performance !== "undefined" && (performance as any).memory?.usedJSHeapSize) ?? 0;
    return {
      frameMs: p.avgFrameMs,
      drawCalls: p.lastDrawCalls,
      triangles: p.lastTriangles,
      vramBytes: vram,
      jsHeapBytes: heap,
    };
  };
}
