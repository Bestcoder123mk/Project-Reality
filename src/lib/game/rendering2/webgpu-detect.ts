/**
 * Section A — WebGPU detection, capability probing, and WebGL2 fallback policy.
 * Project Reality is WebGL2-first; this module is the entry point for the
 * optional WebGPU adoption path. Exposes:
 *   - detectWebGPU() / getWebGPUCapabilities() — async probe + sync snapshot
 *   - classifyTier() / chooseBackend() — capability → tier → backend mapping
 *   - createWebGPURenderer() — guarded constructor (null if unavailable)
 *   - BACKEND_POLICY — config-driven data table of per-tier feature gates
 * SSR-safe: every path guards for typeof navigator/window.
 */
import * as THREE from "three";

export type BackendKind = "webgpu" | "webgl2";

export interface WebGPUCapabilities {
  available: boolean;
  vendor?: string; architecture?: string; description?: string;
  deviceMemoryBytes?: number; maxBufferSize?: number;
  maxTextureDimension2D?: number; maxStorageBufferBindingSize?: number;
  maxComputeWorkgroupInvocations?: number;
  hasRayTracing?: boolean; hasSubgroups?: boolean; hasBarycentric?: boolean;
  error?: string;
}

export type CapabilityTier = "ultra" | "high" | "medium" | "low" | "webgl2-fallback";

export interface BackendPolicyEntry {
  backend: BackendKind;
  features: {
    rayTracedShadows: boolean; neuralGI: boolean; visibilityBuffer: boolean;
    meshShaderCull: boolean; neuralDenoiser: boolean; surfelGI: boolean;
    anisotropicMetal: boolean; subsurfaceScattering: boolean;
  };
  resolutionScale: number;
  maxShadowRays: number;
  maxSurfels: number;
}
export type BackendPolicy = BackendPolicyEntry;

const HIGH_FEAT = {
  rayTracedShadows: true, neuralGI: true, visibilityBuffer: true,
  meshShaderCull: true, neuralDenoiser: true, surfelGI: true,
  anisotropicMetal: true, subsurfaceScattering: true,
};
const NONE_FEAT = {
  rayTracedShadows: false, neuralGI: false, visibilityBuffer: false,
  meshShaderCull: false, neuralDenoiser: false, surfelGI: false,
  anisotropicMetal: false, subsurfaceScattering: false,
};
const MED_FEAT = {
  ...NONE_FEAT, meshShaderCull: true, anisotropicMetal: true, subsurfaceScattering: true,
};

export const BACKEND_POLICY: Record<CapabilityTier, BackendPolicyEntry> = {
  ultra: { backend: "webgpu", features: { ...HIGH_FEAT }, resolutionScale: 1.0, maxShadowRays: 4, maxSurfels: 65536 },
  high: { backend: "webgpu", features: { ...HIGH_FEAT }, resolutionScale: 1.0, maxShadowRays: 2, maxSurfels: 32768 },
  medium: { backend: "webgpu", features: { ...MED_FEAT }, resolutionScale: 0.85, maxShadowRays: 1, maxSurfels: 16384 },
  low: { backend: "webgl2", features: { ...NONE_FEAT }, resolutionScale: 0.75, maxShadowRays: 0, maxSurfels: 0 },
  "webgl2-fallback": { backend: "webgl2", features: { ...NONE_FEAT }, resolutionScale: 1.0, maxShadowRays: 0, maxSurfels: 0 },
};

let cachedCaps: WebGPUCapabilities | null = null;
let probeInProgress: Promise<WebGPUCapabilities> | null = null;

/** Sync check — true if `navigator.gpu` is present (does NOT guarantee functional). */
export function hasWebGPUNavigator(): boolean {
  if (typeof navigator === "undefined") return false;
  return typeof (navigator as { gpu?: unknown }).gpu !== "undefined";
}

/** Sync best-effort snapshot — returns cached result or "unknown" snapshot. */
export function getWebGPUCapabilities(): WebGPUCapabilities {
  if (cachedCaps) return cachedCaps;
  return { available: hasWebGPUNavigator(), error: "not-probed-yet" };
}

/** Async probe — calls navigator.gpu.requestAdapter(). Cached per session. */
export async function detectWebGPU(): Promise<WebGPUCapabilities> {
  if (cachedCaps) return cachedCaps;
  if (probeInProgress) return probeInProgress;
  probeInProgress = (async (): Promise<WebGPUCapabilities> => {
    if (typeof navigator === "undefined") { cachedCaps = { available: false, error: "no-navigator" }; return cachedCaps; }
    const nav = navigator as { gpu?: { requestAdapter?: (opts?: unknown) => Promise<unknown> } };
    if (!nav.gpu || typeof nav.gpu.requestAdapter !== "function") {
      cachedCaps = { available: false, error: "no-navigator.gpu" };
      return cachedCaps;
    }
    try {
      const adapter = (await nav.gpu.requestAdapter({ powerPreference: "high-performance" })) as {
        info?: { vendor?: string; architecture?: string; description?: string };
        features?: Set<string> | string[];
        limits?: Record<string, number>;
      } | null;
      if (!adapter) { cachedCaps = { available: false, error: "no-adapter" }; return cachedCaps; }
      const features = adapter.features as Set<string> | string[] | undefined;
      const limits = adapter.limits;
      const featSet = features instanceof Set ? features : new Set(features ?? []);
      cachedCaps = {
        available: true,
        vendor: adapter.info?.vendor,
        architecture: adapter.info?.architecture,
        description: adapter.info?.description,
        maxBufferSize: limits?.maxBufferSize,
        maxTextureDimension2D: limits?.maxTextureDimension2D,
        maxStorageBufferBindingSize: limits?.maxStorageBufferBindingSize,
        maxComputeWorkgroupInvocations: limits?.maxComputeWorkgroupInvocations,
        hasRayTracing: featSet.has("ray_tracing") || featSet.has("ray-query"),
        hasSubgroups: featSet.has("subgroups"),
        hasBarycentric: featSet.has("barycentric-coordinates"),
      };
      return cachedCaps;
    } catch (err) {
      cachedCaps = { available: false, error: err instanceof Error ? err.message : String(err) };
      return cachedCaps;
    }
  })();
  return probeInProgress;
}

/** Classify a capability snapshot into a tier. Pure function. */
export function classifyTier(caps: WebGPUCapabilities): CapabilityTier {
  if (!caps.available) return "webgl2-fallback";
  if (caps.hasSubgroups && caps.hasRayTracing) return "ultra";
  if (caps.hasSubgroups) return "high";
  if ((caps.maxStorageBufferBindingSize ?? 0) >= 128 * 1024 * 1024 &&
      (caps.maxComputeWorkgroupInvocations ?? 0) >= 64) {
    return "medium";
  }
  return "webgl2-fallback";
}

/** Choose a backend given a tier. Sync (use cached caps if no tier given). */
export function chooseBackend(tier?: CapabilityTier): BackendKind {
  if (tier) return BACKEND_POLICY[tier].backend;
  return BACKEND_POLICY[classifyTier(getWebGPUCapabilities())].backend;
}

/** Async variant — runs the probe if needed. */
export async function chooseBackendAsync(): Promise<{ backend: BackendKind; tier: CapabilityTier; caps: WebGPUCapabilities }> {
  const caps = await detectWebGPU();
  const tier = classifyTier(caps);
  return { backend: BACKEND_POLICY[tier].backend, tier, caps };
}

/** Construct a Three.js WebGPURenderer, guarding for the import being absent.
 *  Returns null if WebGPU is unavailable or the renderer is not bundled.
 *
 *  Three.js 0.185 ships WebGPU builds in `three/build/three.webgpu.js` but
 *  does not expose a clean module import path. When a proper `three/webgpu`
 *  export becomes available, the dynamic import below will be enabled. For
 *  now, this returns null and the game uses the WebGL2 renderer (which is
 *  the stable production path). WebGPU capability detection still works. */
export async function createWebGPURenderer(
  _canvas?: HTMLCanvasElement | OffscreenCanvas,
): Promise<THREE.WebGPURenderer | null> {
  const caps = await detectWebGPU();
  if (!caps.available) return null;
  // WebGPU renderer not available via standard import in Three.js 0.185.
  // Fall back to WebGL2 (the game's primary renderer). When Three.js
  // exposes `three/webgpu` as a package export, this will be updated to:
  //   const mod = await import(variablePath);
  //   return new mod.WebGPURenderer({ canvas, forceWebGPU: true });
  console.info("[webgpu-detect] WebGPU detected but renderer import not bundled — using WebGL2.");
  return null;
}

/** Returns the active backend policy entry. */
export function getActivePolicy(): BackendPolicyEntry {
  return BACKEND_POLICY[classifyTier(getWebGPUCapabilities())];
}

/** Reset the cache (for tests + manual re-probe). */
export function resetWebGPUCache(): void { cachedCaps = null; probeInProgress = null; }

/** Minimal structural type so callers don't import the full WebGPU module. */
declare module "three" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface WebGPURenderer extends THREE.Renderer {}
}
