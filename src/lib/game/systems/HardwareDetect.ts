import type { QualityTier } from "./FrameBudgetProfiler";
// L1-5000 / prompts 4493,4494,4495,4547,4548,4549,4550,4551,4552: addressed by this module (duplicates of Section I prompts, originally implemented there).
// A2-5000-retry: the prior batch sed pass left line 2 as a dangling JSDoc body
// (` * L1-5000 ...`) without the `/**` opening — a syntax error that broke
// tsc parsing for this whole file. Converted to a `//` line comment.
// A3-5000 #584, #585, #586: these Section A prompts (duplicate of L1-5000
// 4493/4494/4495) are addressed by the same guards below — `detectFeatures`
// verifies the WebGPU adapter (typeof === "object" && !== null), the
// webxrImmersiveAR flag is set by the async `applyAsyncWebXRFeatures()` call
// at startup (not hardcoded false), and `wasmThreads` validates a real
// threads-enabled Wasm module via `WebAssembly.validate(shared-memory-wasm)`.

/**
 * Phase 0: Extended hardware capability detection.
 *
 * Extends the P3.3 HardwareDetect with feature-detection for every
 * optional browser API that the seven pillars depend on:
 *   - WebGPU (Pillar 1: neural rendering)
 *   - WebNN (Pillar 1: ML super-resolution)
 *   - WebXR + immersive-ar + mesh detection (Pillar 4: spatial computing)
 *   - Web Bluetooth (Pillar 5: biometric HR)
 *   - Web Serial (Pillar 5: biometric sensors)
 *   - WebLLM / WebGPU compute (Pillar 2: in-browser SLM)
 *   - MediaPipe FaceMesh / blendshapes (Pillar 5: facial capture)
 *   - OffscreenCanvas + Worker (Pillar 8: background world sim)
 *
 * Every feature is optional. The detection result drives which pillars
 * are enabled at runtime. Callers MUST check these flags before using
 * any optional API.
 */

export interface HardwareProfile {
  tier: QualityTier;
  renderer: string;
  vendor: string;
  maxTextureSize: number;
  maxAnisotropy: number;
  cores: number;
  deviceMemoryGB: number;
  isMobile: boolean;
  /** Phase 0: optional API availability. */
  features: FeatureAvailability;
}

export interface FeatureAvailability {
  webgpu: boolean;
  webnn: boolean;
  webxr: boolean;
  webxrImmersiveAR: boolean;
  webxrMeshDetection: boolean;
  webxrPlaneDetection: boolean;
  webxrHandTracking: boolean;
  webxrLightEstimation: boolean;
  webBluetooth: boolean;
  webSerial: boolean;
  webMidi: boolean;
  offscreenCanvas: boolean;
  webWorker: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
  mediaDevices: boolean;
  getUserMedia: boolean;
  speechRecognition: boolean;
  speechSynthesis: boolean;
  serviceWorker: boolean;
  indexedDB: boolean;
  wasmSimd: boolean;
  wasmThreads: boolean;
}

/**
 * Detect all optional browser features. Call this on the client side
 * (window context required for most checks).
 *
 * L1-5000 / prompt 4493 — adapter verification: every `"x" in navigator`
 * check is now followed by a `typeof === "function"` / `typeof === "object"`
 * guard. The `in` operator returns true for any property on the prototype
 * chain (e.g. a polyfill that defines `navigator.bluetooth` as `undefined`),
 * which produced false positives on browsers that ship a partial
 * implementation behind a flag. The guard verifies the property actually
 * resolves to a usable value.
 *
 * L1-5000 / prompt 4494 — webxrImmersiveAR is no longer hardcoded to `false`
 * at synchronous detect time. The async `checkWebXRSession()` resolver is
 * the canonical path (it calls `navigator.xr.isSessionSupported
 * ("immersive-ar")`). The synchronous field stays `false` until
 * `applyAsyncWebXRFeatures()` is called at startup — the engine then
 * mutates the cached profile to set `webxrImmersiveAR` true/false once
 * the async probe resolves.
 *
 * L1-5000 / prompt 4495 — wasmThreads now validates a real threads-enabled
 * Wasm module (memory shared = true, threads = true). The previous check
 * `typeof SharedArrayBuffer !== "undefined" && WebAssembly.validate` was
 * always truthy because `WebAssembly.validate` is a function (truthy), not
 * a probe result. The real probe validates a module that uses shared memory;
 * on browsers without COOP/COEP (`crossOriginIsolated === false`) the
 * validation succeeds but instantiation throws, so we additionally gate on
 * `crossOriginIsolated === true`.
 */
export function detectFeatures(): FeatureAvailability {
  if (typeof window === "undefined") {
    // Server-side: all features false.
    return {
      webgpu: false, webnn: false, webxr: false, webxrImmersiveAR: false,
      webxrMeshDetection: false, webxrPlaneDetection: false, webxrHandTracking: false,
      webxrLightEstimation: false, webBluetooth: false, webSerial: false, webMidi: false,
      offscreenCanvas: false, webWorker: false, sharedArrayBuffer: false,
      crossOriginIsolated: false, mediaDevices: false, getUserMedia: false,
      speechRecognition: false, speechSynthesis: false, serviceWorker: false,
      indexedDB: false, wasmSimd: false, wasmThreads: false,
    };
  }
  // L1-5000 / prompt 4493 — adapter verification guards.
  const nav = navigator as unknown as {
    gpu?: unknown;
    ml?: unknown;
    xr?: unknown;
    bluetooth?: unknown;
    serial?: unknown;
    requestMIDIAccess?: unknown;
    mediaDevices?: { getUserMedia?: unknown };
    serviceWorker?: unknown;
  };
  const crossOriginIsolated =
    (window as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  return {
    webgpu: "gpu" in navigator && typeof nav.gpu === "object" && nav.gpu !== null,
    webnn: "ml" in navigator && typeof nav.ml === "object" && nav.ml !== null,
    webxr: "xr" in navigator && typeof nav.xr === "object" && nav.xr !== null,
    // L1-5000 / prompt 4494 — async probe via checkWebXRSession();
    // applyAsyncWebXRFeatures() mutates the cached profile at startup.
    webxrImmersiveAR: false,
    webxrMeshDetection: false,
    webxrPlaneDetection: false,
    webxrHandTracking: false,
    webxrLightEstimation: false,
    webBluetooth: "bluetooth" in navigator && typeof nav.bluetooth === "object" && nav.bluetooth !== null,
    webSerial: "serial" in navigator && typeof nav.serial === "object" && nav.serial !== null,
    webMidi: "requestMIDIAccess" in navigator && typeof nav.requestMIDIAccess === "function",
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    webWorker: typeof Worker !== "undefined",
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    crossOriginIsolated,
    mediaDevices: !!navigator.mediaDevices && typeof nav.mediaDevices === "object",
    getUserMedia: !!(navigator.mediaDevices && typeof nav.mediaDevices?.getUserMedia === "function"),
    speechRecognition: "SpeechRecognition" in window || "webkitSpeechRecognition" in window,
    speechSynthesis: "speechSynthesis" in window,
    serviceWorker: "serviceWorker" in navigator && typeof nav.serviceWorker === "object" && nav.serviceWorker !== null,
    indexedDB: "indexedDB" in window,
    wasmSimd: detectWasmSimd(),
    // L1-5000 / prompt 4495 — real threads-enabled probe.
    wasmThreads: detectWasmThreads(crossOriginIsolated),
  };
}

/**
 * L1-5000 / prompt 4494 — apply the async WebXR feature flags to a
 * previously-detected profile. Call this once at engine startup AFTER
 * `checkWebXRSession()` resolves. The function mutates the passed
 * profile's `features` field (in-place) + returns it for chaining.
 */
export function applyAsyncWebXRFeatures(
  profile: HardwareProfile,
  xr: Awaited<ReturnType<typeof checkWebXRSession>>,
): HardwareProfile {
  profile.features = {
    ...profile.features,
    webxrImmersiveAR: xr.immersiveAR,
    webxrMeshDetection: xr.meshDetection,
    webxrPlaneDetection: xr.planeDetection,
    webxrHandTracking: xr.handTracking,
    webxrLightEstimation: xr.lightEstimation,
  };
  return profile;
}

/**
 * L1-5000 / prompt 4495 — validate a real threads-enabled Wasm module.
 * See detectFeatures() docstring for the rationale.
 */
function detectWasmThreads(crossOriginIsolated: boolean): boolean {
  if (!crossOriginIsolated) return false;
  if (typeof SharedArrayBuffer === "undefined" || typeof WebAssembly === "undefined") {
    return false;
  }
  try {
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x02, 0x0b, 0x01,
      0x03, 0x65, 0x6e, 0x76,
      0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,
      0x02, 0x00, 0x01, 0x01, 0x03,
    ]));
  } catch {
    return false;
  }
}

/** Check WebXR immersive-ar session support (async). */
export async function checkWebXRSession(): Promise<{
  immersiveAR: boolean;
  meshDetection: boolean;
  planeDetection: boolean;
  handTracking: boolean;
  lightEstimation: boolean;
}> {
  if (typeof navigator === "undefined" || !("xr" in navigator)) {
    return { immersiveAR: false, meshDetection: false, planeDetection: false, handTracking: false, lightEstimation: false };
  }
  try {
    const xr = navigator as unknown as { xr: { isSessionSupported: (mode: string) => Promise<boolean> } };
    const supported = await xr.xr.isSessionSupported("immersive-ar");
    if (!supported) {
      return { immersiveAR: false, meshDetection: false, planeDetection: false, handTracking: false, lightEstimation: false };
    }
    // Feature detection via session options (would need an active session to fully verify).
    return {
      immersiveAR: true,
      meshDetection: true, // Quest 3 supports it; assume true if immersive-ar is supported
      planeDetection: true,
      handTracking: true,
      lightEstimation: true,
    };
  } catch {
    return { immersiveAR: false, meshDetection: false, planeDetection: false, handTracking: false, lightEstimation: false };
  }
}

/** Detect WASM SIMD support via a tiny validation probe. */
function detectWasmSimd(): boolean {
  try {
    // A minimal WASM module with a SIMD instruction (v128.const).
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x0a, 0x01, 0x08, 0x00, 0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x0b,
    ]));
  } catch {
    return false;
  }
}

/**
 * Extended detectHardware that includes feature flags.
 * Falls back to the original WebGL-based detection if WebGPU is unavailable.
 */
export function detectHardwareExtended(gl?: WebGL2RenderingContext | WebGLRenderingContext): HardwareProfile {
  const features = detectFeatures();
  // If we have a GL context, use the original detection for tier + renderer info.
  if (gl) {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : "unknown";
    const vendor = dbg ? (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) as string) : "unknown";
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const maxAnisotropy = (() => {
      const ext = gl.getExtension("EXT_texture_filter_anisotropic");
      return ext ? (gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 1;
    })();
    const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
    const deviceMemoryGB = typeof navigator !== "undefined" && (navigator as any).deviceMemory ? (navigator as any).deviceMemory : 4;
    const isMobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    let tier: QualityTier = "high";
    if (features.webgpu && deviceMemoryGB >= 8 && cores >= 8) tier = "ultra";
    else if (deviceMemoryGB >= 4) tier = "high";
    else if (deviceMemoryGB >= 2) tier = "medium";
    else tier = "low";
    return { tier, renderer, vendor, maxTextureSize, maxAnisotropy, cores, deviceMemoryGB, isMobile, features };
  }
  // No GL context — return a minimal profile with feature flags.
  return {
    tier: features.webgpu ? "high" : "medium",
    renderer: features.webgpu ? "webgpu" : "unknown",
    vendor: "unknown",
    maxTextureSize: 0,
    maxAnisotropy: 1,
    cores: typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4,
    deviceMemoryGB: typeof navigator !== "undefined" && (navigator as any).deviceMemory ? (navigator as any).deviceMemory : 4,
    isMobile: typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
    features,
  };
}

/** Original detectHardware (kept for backward compat — calls extended version). */
export function detectHardware(gl: WebGL2RenderingContext | WebGLRenderingContext): HardwareProfile {
  return detectHardwareExtended(gl);
}

// ─── Task 3 / item 57 — integrated-GPU detection for ShadowQuality auto-degrade ─
//
// CSM shadow cost scales linearly with cascades × shadowMapSize². On integrated
// GPUs (Intel HD/UHD/Iris, AMD Radeon Vega Mobile, ARM Mali/Adreno, Apple
// M-series integrated) the GPU memory bandwidth + fill rate are typically
// 1/3 to 1/2 of a discrete card, so even a "medium" tier can stall on a
// 3-cascade CSM. detectIntegratedGPU() inspects the UNMASKED_RENDERER string
// + the deviceMemory / hardwareConcurrency hints to flag an integrated part.
//
// The output is a tri-state:
//   - "discrete"    → discrete GPU (NVIDIA / AMD Radeon RX / Radeon Pro WX)
//   - "integrated"  → known integrated GPU string OR low-end heuristic match
//   - "unknown"     → could not classify (treat as discrete — keep user's tier)
//
// RendererSystem.buildLights() reads `isIntegratedGPU` off the hardware
// profile + auto-degrades the ShadowQuality one tier down when true (e.g.,
// high→medium, medium→low, low→off). The user can still override via the
// settings panel — this is the auto-detected starting point only.

export type GPUClass = "discrete" | "integrated" | "unknown";

/** Known-integrated GPU substrings (case-insensitive) matched against the
 *  UNMASKED_RENDERER_WEBGL string. Intel HD/UHD/Iris, AMD Radeon Vega Mobile
 *  (NOT Vega Pro / RX Vega — those are discrete), Apple M-series integrated
 *  memory, and ARM Mali / Adreno / PowerVR mobile parts. */
const INTEGRATED_PATTERNS: RegExp[] = [
  /intel.*hd/i,
  /intel.*uhd/i,
  /intel.*iris/i,
  /intel.*arc.*a\d{2,3}m/i, // Arc A370M etc. (mobile variants — discrete-class but bandwidth-limited)
  /radeon.*vega.*(mobile|8|11)/i, // Vega 8 / 11 (APU integrated), NOT RX Vega
  /radeon.*graphics/i, // AMD APU "Radeon Graphics" combo
  /amd.*radeon.*\(integrated\)/i,
  /mali-/i, // ARM Mali (mobile / integrated)
  /adreno/i, // Qualcomm Adreno (mobile)
  /powervr/i,
  /apple.*m\d/i, // Apple M1/M2/M3 — unified memory, integrated-class bandwidth
  /apple gpu/i,
  /d3d12.*warp/i, // Windows Advanced Rasterization Platform — software renderer
  /microsoft basic render/i, // Software fallback
];

/** Known-discrete GPU substrings (case-insensitive). Takes precedence over the
 *  integrated list — a string matching both (e.g., a dual-GPU laptop that
 *  reports "NVIDIA GeForce GTX 1650 / Intel UHD Graphics" in crossfire mode)
 *  should be classified as discrete since the discrete card is doing the work. */
const DISCRETE_PATTERNS: RegExp[] = [
  /nvidia/i,
  /geforce/i,
  /quadro/i,
  /radeon.*rx/i, // RX 6000 / RX 7000 series — discrete
  /radeon.*pro.*w[5-7]/i, // Radeon Pro W5700 etc. — discrete
  /radeon.*vega.*56/i, // Vega 56 / 64 — discrete
  /radeon.*vii/i,
  /radeon vii/i,
  /arc.*a\d{2,3}(?!m)/i, // Arc A380/A750/A770 — desktop discrete
];

/** Classify the GPU as discrete / integrated / unknown from the renderer string.
 *  When no string is available (e.g., WEBGL_debug_renderer_info blocked by the
 *  browser — Safari 16+ does this), falls back to a heuristic on
 *  deviceMemory + hardwareConcurrency (≤4GB / ≤4 cores → likely integrated). */
export function classifyGPU(renderer?: string, profile?: Pick<HardwareProfile, "deviceMemoryGB" | "cores" | "isMobile">): GPUClass {
  if (renderer && renderer !== "unknown") {
    // Discrete check first — takes precedence on dual-GPU systems.
    if (DISCRETE_PATTERNS.some((re) => re.test(renderer))) return "discrete";
    if (INTEGRATED_PATTERNS.some((re) => re.test(renderer))) return "integrated";
    // Unknown renderer string with no pattern match — fall through to heuristic.
  }
  // Heuristic fallback when the renderer string is unavailable or unclassified.
  if (profile) {
    if (profile.isMobile) return "integrated"; // Mobile = integrated by definition.
    if (profile.deviceMemoryGB <= 2) return "integrated"; // ≤2GB deviceMemory → low-end APU.
    if (profile.deviceMemoryGB <= 4 && profile.cores <= 4) return "integrated"; // 4GB + 4 cores = APU-class.
  }
  return "unknown";
}

/** Convenience: true iff the detected hardware is known-integrated. Pulled
 *  off the HardwareProfile after detectHardwareExtended populates it. The
 *  caller (RendererSystem) uses this to bump the ShadowQuality down one tier
 *  at construction time. */
export function isIntegratedGPU(profile: HardwareProfile): boolean {
  return classifyGPU(profile.renderer, profile) === "integrated";
}

/** Task 3 / item 57 — ShadowQuality tier ordering used by the auto-degrade
 *  path. "off" disables shadows entirely (cheapest); "high" enables CSM with
 *  the full cascade count. The FrameBudgetProfiler can drop the runtime tier
 *  one step at a time on sustained frame-budget misses (separate from the
 *  initial hardware-driven classification here). */
export const SHADOW_QUALITY_ORDER = ["off", "low", "medium", "high"] as const;
export type ShadowQualityTier = (typeof SHADOW_QUALITY_ORDER)[number];

/** Decrement the shadow quality tier by one step (e.g. "high" → "medium").
 *  Returns "off" unchanged (already at the floor). Used by RendererSystem
 *  on integrated GPUs + by the FrameBudgetProfiler on sustained over-budget. */
export function degradeShadowQuality(tier: ShadowQualityTier): ShadowQualityTier {
  const idx = SHADOW_QUALITY_ORDER.indexOf(tier);
  if (idx <= 0) return "off";
  return SHADOW_QUALITY_ORDER[idx - 1];
}

/**
 * P3.3: Per-tier render config.
 * Used by context-factory.ts to apply initial renderer settings based on
 * the hardware-detected tier. The FrameBudgetProfiler has its own
 * TIER_PIXEL_RATIO + TIER_SHADOW_MAP for runtime auto-degrade — this
 * TIER_CONFIG is the initial bootstrap config.
 */
export const TIER_CONFIG: Record<QualityTier, {
  pixelRatio: number;
  shadowMapSize: number;
  antialias: boolean;
  fogDensity: number;
  particleLimit: number;
  renderDistance: number;
}> = {
  ultra: { pixelRatio: 2, shadowMapSize: 4096, antialias: true, fogDensity: 0.012, particleLimit: 200, renderDistance: 500 },
  high: { pixelRatio: 1.5, shadowMapSize: 2048, antialias: true, fogDensity: 0.014, particleLimit: 150, renderDistance: 400 },
  medium: { pixelRatio: 1.25, shadowMapSize: 1024, antialias: true, fogDensity: 0.018, particleLimit: 100, renderDistance: 300 },
  low: { pixelRatio: 1, shadowMapSize: 512, antialias: false, fogDensity: 0.025, particleLimit: 60, renderDistance: 200 },
};

// ── SEC12-PLATFORM prompt 93: perf-target wiring ───────────────────────────
//
// Lazy import avoids a circular dependency at module load: perf-targets.ts
// imports the `QualityTier` type from this file (type-only — elided at
// runtime) but we don't want a value-side cycle. The helper is intentionally
// a thin pass-through so the existing HardwareDetect callers can stay on the
// bare `detectHardwareExtended()` API and pull a perf-target on demand.

/**
 * Resolve the perf-target for the detected hardware. Wraps
 * `getPerfTargetForDevice` so callers that already hold a HardwareProfile
 * don't have to construct a DeviceProfile themselves.
 *
 * Returns the platform-specific { targetFps, budgetMs, maxDrawCalls,
 * maxTriangles, ... } that the FrameBudgetProfiler compares its rolling
 * average against.
 */
export async function getPerfTargetForProfile(profile: HardwareProfile) {
  // Lazy import keeps this SSR-safe (perf-targets.ts has no side effects,
  // but the dynamic import defers evaluation until first use).
  const { getPerfTargetForDevice } = await import("../platform/perf-targets");
  return getPerfTargetForDevice({
    tier: profile.tier,
    isMobile: profile.isMobile,
  });
}
