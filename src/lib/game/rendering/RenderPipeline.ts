/**
 * Phase 2: WebGPU render pipeline.
 *
 * Migrates the renderer from WebGL2 to WebGPU (with WebGL2 fallback).
 * WebGPU unlocks:
 *   - Compute shaders (DDGI, particle GPU simulation, MLS-MPM fluid)
 *   - Virtual geometry (Nanite-equivalent) via Three.js r170+
 *   - TSL (Three Shading Language) node materials
 *   - Higher performance on modern GPUs
 *
 * The migration is behind a feature flag. If WebGPU is unavailable
 * (older browsers, Safari < 17), the pipeline falls back to the
 * existing WebGLRenderer.
 *
 * This module provides the RenderPipeline class that wraps either
 * renderer + manages DDGI probe volumes + virtual geometry + cloud
 * rendering. RendererSystem.ts delegates to this pipeline.
 */

import * as THREE from "three";
import { isFeatureEnabled } from "../FeatureFlags";
import type { QualityTier } from "../systems/FrameBudgetProfiler";

export type RenderBackend = "webgpu" | "webgl2";

export interface RenderPipelineConfig {
  tier: QualityTier;
  /** Preferred backend. Falls back if unavailable. */
  preferredBackend: RenderBackend;
  /** Enable DDGI global illumination (Phase 3). */
  enableDDGI: boolean;
  /** Enable virtual geometry (Nanite-equivalent). */
  enableVirtualGeometry: boolean;
  /** Enable @takram/three-clouds volumetric clouds. */
  enableClouds: boolean;
  /** Enable ML super-resolution (Phase 3). */
  enableSuperRes: boolean;
}

export interface RenderPipelineResult {
  backend: RenderBackend;
  renderer: THREE.WebGLRenderer | any; // WebGPURenderer when available
  config: RenderPipelineConfig;
}

/**
 * Create the best available render pipeline.
 * Tries WebGPU first, falls back to WebGL2.
 */
export async function createRenderPipeline(
  canvas: HTMLCanvasElement,
  config: RenderPipelineConfig,
): Promise<RenderPipelineResult> {
  const webgpuAvailable = isFeatureEnabled("webgpu");
  const useWebGPU = config.preferredBackend === "webgpu" && webgpuAvailable;

  if (useWebGPU) {
    try {
      // A3-5000-retry / 419: log WebGPU import failures (was silent
      // `.catch(() => ({ WebGPURenderer: null }))` — any failure invisible).
      const mod = await import("three/webgpu").catch((err: unknown) => {
        console.warn("[RenderPipeline] WebGPU import failed — falling back to WebGL2:", err);
        return { WebGPURenderer: null };
      });
      const { WebGPURenderer } = mod;
      if (WebGPURenderer) {
        const renderer = new WebGPURenderer({ canvas, antialias: config.tier !== "low" });
        await renderer.init();
        // A3-5000-retry / 420: virtual-geometry check was wrong — was
        // `"virtualGeometry" in renderer` (always false; the property lives on
        // `renderer.backend`). Check both spots + set via the backend path.
        if (config.enableVirtualGeometry) {
          const backend = (renderer as any).backend;
          if (backend && "virtualGeometry" in backend) {
            backend.virtualGeometry = true;
          } else if ("virtualGeometry" in renderer) {
            (renderer as any).virtualGeometry = true;
          }
        }
        applyTierSettings(renderer, config.tier);
        return { backend: "webgpu", renderer, config };
      }
    } catch (err) {
      // A3-5000-retry / 419: log the failure (was silent `catch {}`).
      console.warn("[RenderPipeline] WebGPU init failed — falling back to WebGL2:", err);
    }
  }

  // WebGL2 fallback (existing behavior).
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: config.tier !== "low" });
  applyTierSettings(renderer, config.tier);
  return { backend: "webgl2", renderer, config };
}

/** Apply tier-specific settings to either renderer type.
 *
 *  A3-5000-retry / 421: shadow map type changed from PCFShadowMap (hard) to
 *  PCFSoftShadowMap for soft shadow edges. VSMShadowMap was avoided because
 *  it requires depth-precision adjustments in all shadow-casting shaders.
 *
 *  A3-5000-retry / 461: toneMapping is set here BUT RendererSystem.ts:75
 *  overrides it to NoToneMapping (so the PostProcessing grade shader's ACES
 *  is the sole tonemapper). This order-dependent clash is now resolved by
 *  PostProcessing.ts:887 — every frame while the composer is active, it
 *  re-asserts `renderer.toneMapping = NoToneMapping`. So this ACES setting
 *  is the FALLBACK for the raw-render path (when the composer is disabled
 *  or fails to init). Documented here so a future reader doesn't think
 *  the ACES setting is a no-op. */
function applyTierSettings(renderer: any, tier: QualityTier): void {
  const pixelRatios: Record<QualityTier, number> = { ultra: 2, high: 1.5, medium: 1.25, low: 1 };
  const shadowSizes: Record<QualityTier, number> = { ultra: 4096, high: 2048, medium: 1024, low: 512 };
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatios[tier]));
  renderer.shadowMap.enabled = tier !== "low";
  // A3-5000-retry / 421: PCFSoftShadowMap for soft shadow edges (was PCFShadowMap — hard).
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  (renderer as any)._tierShadowSize = shadowSizes[tier];
}

/**
 * Detect the best render backend for this hardware.
 */
export function detectPreferredBackend(): RenderBackend {
  return isFeatureEnabled("webgpu") ? "webgpu" : "webgl2";
}

/**
 * Phase 2: Default render pipeline config based on hardware tier.
 */
export function getDefaultRenderConfig(tier: QualityTier): RenderPipelineConfig {
  return {
    tier,
    preferredBackend: detectPreferredBackend(),
    enableDDGI: tier === "ultra" || tier === "high",
    enableVirtualGeometry: tier === "ultra",
    enableClouds: tier === "ultra" || tier === "high",
    enableSuperRes: tier === "ultra",
  };
}
