/**
 * Section L / L_Performance_Optimization.txt
 *
 * index.ts — barrel export + integration helpers for the perf module.
 *
 * Public API surface for the 12 performance-optimization systems
 * implemented in this directory. Also exposes `initPerformanceStack()`
 * which wires all the systems together with the existing
 * FrameBudgetProfiler + LODSystem.
 *
 * The integration is opt-in: callers explicitly call
 * `initPerformanceStack(ctx)` once at engine startup. After that, the
 * individual systems are accessible via their singleton getters.
 */

// ─── Barrel exports ──────────────────────────────────────────────────────

export * from "./worker-offload";
export * from "./gpu-culling";
export * from "./texture-streaming";
export * from "./benchmarks";
export * from "./webgpu-profiler";
export * from "./memory-pool";
export * from "./draw-call-batcher";
export * from "./occlusion-culling";
export * from "./variable-rate-shading";
export * from "./async-compute";
export * from "./frame-budget-scaler";
export * from "./asset-streaming";

// ─── Integration ─────────────────────────────────────────────────────────

import type * as THREE from "three";
import { getOffloadPool } from "./worker-offload";
import { getGPUCuller } from "./gpu-culling";
import { getTextureStreamingManager } from "./texture-streaming";
import { getThreeMemoryPool } from "./memory-pool";
import { getDrawCallBatcher } from "./draw-call-batcher";
import { getOcclusionCuller } from "./occlusion-culling";
import { getVRS } from "./variable-rate-shading";
import { getAsyncComputeScheduler } from "./async-compute";
import { getFrameBudgetScaler, buildDefaultKnobs } from "./frame-budget-scaler";
import { getAssetStreamingManager } from "./asset-streaming";
import { createGPUProfiler } from "./webgpu-profiler";
import type { FrameBudgetProfiler, QualityTier } from "../systems/FrameBudgetProfiler";
import { PERF_TARGETS, getPerfTargetForDevice } from "../platform/perf-targets";

/** Init options. */
export interface PerformanceStackOptions {
  /** The renderer (used to extract the GL context + viewport size). */
  renderer: THREE.WebGLRenderer;
  /** The FrameBudgetProfiler (already constructed by the engine). */
  profiler: FrameBudgetProfiler;
  /** The active quality tier. */
  tier: QualityTier;
  /** Whether this device is mobile (affects VRAM budget + worker count). */
  isMobile: boolean;
  /** Optional WebGPU device (when running on the WebGPU backend). */
  webgpuDevice?: GPUDevice;
  /** Optional explicit platform override. */
  platformOverride?: keyof typeof PERF_TARGETS;
}

/** The initialized stack — references to every system. */
export interface PerformanceStack {
  offloadPool: Awaited<ReturnType<typeof getOffloadPool>>;
  gpuCuller: ReturnType<typeof getGPUCuller>;
  textureStreaming: ReturnType<typeof getTextureStreamingManager>;
  memoryPool: ReturnType<typeof getThreeMemoryPool>;
  drawCallBatcher: ReturnType<typeof getDrawCallBatcher>;
  occlusionCuller: ReturnType<typeof getOcclusionCuller>;
  vrs: ReturnType<typeof getVRS>;
  asyncCompute: ReturnType<typeof getAsyncComputeScheduler>;
  frameBudgetScaler: ReturnType<typeof getFrameBudgetScaler>;
  assetStreaming: ReturnType<typeof getAssetStreamingManager>;
  gpuProfiler: Awaited<ReturnType<typeof createGPUProfiler>>;
  /** The active perf-target (from PERF_TARGETS). */
  perfTarget: ReturnType<typeof getPerfTargetForDevice>;
}

/**
 * Initialize the full performance stack. Call once at engine startup,
 * AFTER the FrameBudgetProfiler is constructed but BEFORE the first
 * frame. Safe to call multiple times — returns the existing stack.
 */
export async function initPerformanceStack(opts: PerformanceStackOptions): Promise<PerformanceStack> {
  // Resolve the perf-target.
  const perfTarget = getPerfTargetForDevice({
    tier: opts.tier,
    isMobile: opts.isMobile,
    override: opts.platformOverride,
  });
  opts.profiler.setPerfTarget(perfTarget);

  // Wire the GL context into the GPU culler (for WebGL2 fallback).
  const gl = (opts.renderer as any).getContext?.() as WebGL2RenderingContext | undefined;
  const gpuCuller = getGPUCuller();
  if (gl) gpuCuller.setGLContext(gl);
  await gpuCuller.init();

  // Texture streaming — set the VRAM budget from the perf-target.
  const textureStreaming = getTextureStreamingManager();
  textureStreaming.setVramBudget(perfTarget.maxVramMB * 1024 * 1024);

  // Worker pool.
  const offloadPool = await getOffloadPool();

  // Memory pool.
  const memoryPool = getThreeMemoryPool();

  // Draw call batcher.
  const drawCallBatcher = getDrawCallBatcher();

  // Occlusion culler — try WebGPU then WebGL2.
  const occlusionCuller = getOcclusionCuller();
  await occlusionCuller.init({
    webgpuDevice: opts.webgpuDevice,
    gl,
  });

  // VRS.
  const vrs = getVRS();
  const viewport = opts.renderer.getSize(new (await import("three")).Vector2());
  await vrs.init({
    webgpuDevice: opts.webgpuDevice,
    viewport: { w: viewport.width, h: viewport.height },
  });

  // Async compute scheduler.
  const asyncCompute = getAsyncComputeScheduler();

  // Frame budget scaler — register default knobs.
  const frameBudgetScaler = getFrameBudgetScaler(opts.profiler);
  const defaultKnobs = buildDefaultKnobs({
    renderer: opts.renderer,
    sunLight: (opts.renderer as any)._sunLight,
    particleSystem: (opts.renderer as any)._particleSystem,
    lodSystem: (opts.renderer as any)._lodSystem,
  });
  for (const knob of defaultKnobs) {
    frameBudgetScaler.registerKnob(knob);
  }

  // Asset streaming.
  const assetStreaming = getAssetStreamingManager();

  // GPU profiler.
  const gpuProfiler = await createGPUProfiler({
    webgpuDevice: opts.webgpuDevice,
    gl,
  });

  return {
    offloadPool,
    gpuCuller,
    textureStreaming,
    memoryPool,
    drawCallBatcher,
    occlusionCuller,
    vrs,
    asyncCompute,
    frameBudgetScaler,
    assetStreaming,
    gpuProfiler,
    perfTarget,
  };
}

/** Tear down the full stack. Call from engine.dispose(). */
export function disposePerformanceStack(): void {
  // Each system has a reset() that disposes GPU resources + clears state.
  // Import lazily to avoid circular module-load issues.
  import("./worker-offload").then(({ resetOffloadPool }) => resetOffloadPool());
  import("./gpu-culling").then(({ resetGPUCuller }) => resetGPUCuller());
  import("./texture-streaming").then(({ resetTextureStreamingManager }) => resetTextureStreamingManager());
  import("./memory-pool").then(({ resetThreeMemoryPool }) => resetThreeMemoryPool());
  import("./draw-call-batcher").then(({ resetDrawCallBatcher }) => resetDrawCallBatcher());
  import("./occlusion-culling").then(({ resetOcclusionCuller }) => resetOcclusionCuller());
  import("./variable-rate-shading").then(({ resetVRS }) => resetVRS());
  import("./async-compute").then(({ resetAsyncComputeScheduler }) => resetAsyncComputeScheduler());
  import("./frame-budget-scaler").then(({ resetFrameBudgetScaler }) => resetFrameBudgetScaler());
  import("./asset-streaming").then(({ resetAssetStreamingManager }) => resetAssetStreamingManager());
}

// ─── Per-frame tick ──────────────────────────────────────────────────────

/**
 * Update all per-frame perf systems. Call once per frame from the engine
 * loop, AFTER the FrameBudgetProfiler.recordFrame() call.
 *
 * Each system's update is wrapped in a try/catch so a failure in one
 * system doesn't break the others.
 */
export function tickPerformanceStack(stack: PerformanceStack, opts: {
  camera: THREE.Camera;
  frameIndex: number;
  frameMs: number;
  subsystemTimings: Array<{ name: string; avgMs: number }>;
}): void {
  const { camera, frameIndex, frameMs, subsystemTimings } = opts;

  // Texture streaming — promote/demote mips based on camera distance.
  try { stack.textureStreaming.update(camera, frameIndex); } catch (e) { console.error(e); }

  // GPU culling — produce the per-frame draw list.
  try { stack.gpuCuller.cull(camera); } catch (e) { console.error(e); }

  // Occlusion culling — begin/end frame + apply results.
  try {
    stack.occlusionCuller.beginFrame();
    for (const c of stack.occlusionCuller.candidateList) {
      stack.occlusionCuller.issueQuery(c);
    }
    stack.occlusionCuller.endFrame();
  } catch (e) { console.error(e); }

  // VRS — update the shading rate image.
  try { stack.vrs.update({}); } catch (e) { console.error(e); }

  // Frame budget scaler — apply degradation if over budget.
  try { stack.frameBudgetScaler.update(frameMs, subsystemTimings); } catch (e) { console.error(e); }

  // GPU profiler — set CPU frame time for GPU-bound detection.
  try { (stack.gpuProfiler as any).setCpuFrameTime?.(frameMs); } catch (e) { console.error(e); }

  // Memory pool — auto-flush on heap pressure.
  try { stack.memoryPool.autoFlush(); } catch (e) { console.error(e); }
}

// ─── Aggregate stats ─────────────────────────────────────────────────────

/** Get an aggregated snapshot of every perf system. */
export function getPerformanceStackStats(stack: PerformanceStack): Record<string, unknown> {
  return {
    offload: stack.offloadPool.stats(),
    gpuCuller: stack.gpuCuller.stats(),
    textureStreaming: stack.textureStreaming.stats(),
    memoryPool: stack.memoryPool.stats(),
    drawCallBatcher: stack.drawCallBatcher.stats(),
    occlusionCuller: stack.occlusionCuller.stats(),
    vrs: stack.vrs.stats(),
    asyncCompute: stack.asyncCompute.getStats(),
    frameBudgetScaler: stack.frameBudgetScaler.stats(),
    assetStreaming: stack.assetStreaming.stats(),
    gpuProfiler: (stack.gpuProfiler as any).getFrameTiming?.() ?? null,
    perfTarget: {
      platform: stack.perfTarget.platform,
      label: stack.perfTarget.label,
      budgetMs: stack.perfTarget.budgetMs,
      targetFps: stack.perfTarget.targetFps,
      maxDrawCalls: stack.perfTarget.maxDrawCalls,
      maxTriangles: stack.perfTarget.maxTriangles,
      maxVramMB: stack.perfTarget.maxVramMB,
    },
  };
}
