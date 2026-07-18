/**
 * SEC3-RENDER — rendering2 barrel.
 *
 * Public API surface for the rendering2 subsystem. Re-exports each module's
 * public types + functions so the engine / PostProcessing / tests can pull
 * everything from one import.
 *
 * Each pass class is constructed by the caller (or by the engineWiring
 * helper below) — no side-effects on import (SSR-safe).
 */

// Prompt 19 — GI / baked lightmaps
export {
  bakeLightmap, applyLightmap, bakeAndApplyLightmaps, makeSunConfig,
  computeVertexAO, hemisphereSample,
  BAKE_QUALITY,
  type LightmapData, type SunConfig, type BakeQuality,
} from "./gi";

// Prompt 20 — Volumetric fog + god rays
export { VolumetricFogPass, VolumetricFogShader } from "./volumetric-fog";

// Prompt 21 — SSAO
export {
  SSAOPass, SSAOShader,
  generateSSAOKernel, generateSSAONoise,
  SSAO_QUALITY_DEFAULTS,
  type SSAOConfig,
} from "./ssao";

// Prompt 22 — SSR
export {
  SSRPass, SSRShader,
  SSR_QUALITY_DEFAULTS,
  type SSRConfig,
} from "./ssr";

// Prompt 23 — TAA
export {
  TAAPass, TAAShader,
  haltonJitter, getJitter,
  TAA_QUALITY_DEFAULTS,
  type TAAConfig,
} from "./taa";

// Prompt 24 — Muzzle flash + tracer VFX
export {
  MuzzleVfxSystem,
  getMuzzleVfxSystem,
  spawnMuzzleFlash, spawnTracer,
  type MuzzleVfxQuality, type MuzzleVfxOptions,
} from "./muzzle-vfx";

// Prompt 25 — Lens weather
export { LensWeatherPass, LensWeatherShader } from "./lens-weather";

// Prompt 26 — Fracture VFX
export {
  FractureVfxSystem, getFractureVfxSystem,
  spawnDustCloud, spawnDebris,
  DustHazeShader,
  type FractureVfxQuality, type FractureVfxOptions,
} from "./fracture-vfx";

// Prompt 27 — Gore
export {
  GoreSystem, getGoreSystem,
  spawnBloodDecal, setGoreLevel,
  GORE_CONFIGS, getGoreConfig,
  type GoreLevel, type GoreConfig,
} from "./gore";

// Prompt 28 — Water
export {
  createWaterMesh, updateWaterMesh, getWaterParams,
  buildWaveSet, packWaves,
  type WaterOptions, type GerstnerWave,
} from "./water";

// Prompt 29 — Day/night cycle
export {
  DayNightCycle, SkyShader,
  sunPositionForTime, sunDirectionFromAngles, getSunDirectionForTime,
  sunColorForElevation, skyColorsForElevation,
} from "./daynight";

// Prompt 30 — Photo mode
export {
  PhotoMode, getPhotoMode,
  FilterShader, FILTER_CONFIGS, getFilterConfig,
  type PhotoModeFilter, type FilterConfig,
} from "./photomode";

// Section E (601–730) — rendering/lighting/environment/particles/LOD enhancements.
export {
  // #601–624 — PBR + materials + post-FX + LUT.
  PBR_MAP_REGISTRY, getPBRDescriptor, buildPBRMaterial,
  PARALLAX_MAPPING_CHUNK, TERRAIN_DISPLACEMENT_CHUNK,
  DecalPool, buildAreaLight,
  applySoftShadows, SOFT_SHADOW_DEFAULTS,
  ContactShadowSystem, pickShadowLODTier,
  cullLights, buildLightCookie,
  BLOOM_THRESHOLDS, applyBloomThreshold,
  MotionBlurShader, DepthOfFieldShader, ChromaticAberrationShader,
  FilmGrainShader, VIGNETTE_PRESETS,
  LensFlareShader, LensDirtShader,
  tickExposureAdaptation, EXPOSURE_ADAPTATION_DEFAULTS,
  LUTShader,
  // #631 — DDGI.
  DDGISystem,
  // #640–643 — Wetness / puddles / snow / ice.
  WeatherSurfaceSystem, PuddleSystem, IceSystem,
  // #644–646 — Wind / thunder / lightning.
  VEGETATION_WIND_CHUNK, ThunderSystem, LightningFlashSystem,
  // #657–666 — LOD / culling / batching.
  OcclusionCullingSystem, HLODSystem, ImpostorSystem,
  mergeStaticGeometries, makeHalfResTarget, EarlyZPrePass,
  DrawCallBatcher, ShadowCache, staticBatchScene,
  // #632–636 — Water extras (caustics, foam, underwater).
  WaterCausticsShader, ShoreFoamSystem, UnderwaterDistortionShader,
  // #721–730 — Perf overlay.
  PerfOverlayBackend, DEFAULT_PERF_OVERLAY,
  SECTION_E_STATUS,
  type PBRMapDescriptor, type AreaLightSpec, type SoftShadowConfig,
  type BloomThresholdConfig, type ExposureAdaptationConfig,
  type DDGIProbe, type HLODCluster, type PerfOverlaySettings,
  type VignettePreset,
} from "./section-e-enhancements";

// ─── Section A (Realism & Rendering) — 18 new high-impact modules ───
// Each module is self-contained + re-exported here so the engine / host
// PostProcessing.ts can pull everything from one import.

// WebGPU detection + fallback policy.
export {
  detectWebGPU, getWebGPUCapabilities, classifyTier, chooseBackend, chooseBackendAsync,
  createWebGPURenderer, getActivePolicy, hasWebGPUNavigator, resetWebGPUCache,
  BACKEND_POLICY,
  type BackendKind, type WebGPUCapabilities, type CapabilityTier,
  type BackendPolicyEntry, type BackendPolicyEntry as BackendPolicy,
} from "./webgpu-detect";

// Ray-traced soft shadows (post-process).
export {
  RTShadowPass, RTShadowShader, RT_SHADOW_DEFAULTS,
  type RTShadowConfig,
} from "./rt-shadows";

// Surfel-based + neural GI.
export {
  SurfelGIPass, SurfelGIShader, SURFEL_GI_DEFAULTS, NEURAL_GI_WEIGHTS,
  type SurfelGIConfig, type Surfel,
} from "./neural-gi";

// GPU-driven visibility buffer.
export {
  VisibilityBufferTarget, buildVisibilityMaterial,
  VisibilityGatherShader, VISIBILITY_BUFFER_DEFAULTS,
  type VisibilityBufferConfig, type MeshIDLUTEntry,
} from "./visibility-buffer";

// Mesh-shader culling.
export {
  MeshletCuller, buildMeshlets, cullMeshlets,
  MESHLET_MAX_VERTS, MESHLET_MAX_TRIS,
  type Meshlet, type MeshletSet, type CullResult,
} from "./mesh-shader-cull";

// Anisotropic metal brushing.
export {
  applyAnisotropicMaterial, buildBrushedMetalTexture,
  disposeAnisotropicResources, getAnisotropyPreset, ANISOTROPY_PRESETS,
  type AnisotropyPreset,
} from "./anisotropic-metal";

// Photogrammetry procedural PBR generator.
export {
  generatePBRSet, applyPBRSet, disposePBRSet,
  SURFACE_KIND_DEFAULTS,
  type PhotogrammetryConfig, type PBRSet, type SurfaceKind,
} from "./photogrammetry";

// Neural-network denoiser.
export {
  NeuralDenoiserPass, NeuralDenoiserShader, DENOISER_DEFAULTS,
  buildDenoiserWeightTextures, NEURAL_DENOISER_WEIGHTS,
  type DenoiserConfig,
} from "./neural-denoiser";

// Water caustics (SWE simulation + post-process).
// NOTE: WaterCausticsShader is already exported from ./section-e-enhancements,
// so we only export the new symbols here.
export {
  WaterCausticsPass, WATER_CAUSTICS_DEFAULTS,
  createSWESimulation, initSWESimulation, stepSWESimulation,
  computeCausticIntensity,
  type WaterCausticsConfig, type SWESimulation,
} from "./water-caustics";

// Atmospheric scattering (Rayleigh + Mie).
export {
  AerialPerspectivePass, AerialPerspectiveShader,
  createAtmosphericSkyMaterial,
  atmosphericScatter, rayleighPhase, miePhase,
  ATMOSPHERE_DEFAULTS,
  type AtmosphereConfig,
} from "./atmospheric-scattering";

// HDR eye adaptation (rod/cone).
export {
  HDREyeAdaptation, EYE_ADAPTATION_DEFAULTS,
  computeTargetExposure, computeRodConeBlend,
  PURKINJE_SHIFT_CHUNK, buildEyeAdaptationUniforms,
  type EyeAdaptationConfig, type EyeAdaptationState,
} from "./hdr-eye-adaptation";

// Subsurface scattering on skin.
export {
  ScreenSpaceSSSPass, ScreenSpaceSSSShader,
  applySkinSSS, getSkinSSSPreset, SKIN_SSS_PRESETS,
  type SkinSSSConfig,
} from "./subsurface-scattering";

// Anamorphic lens flares.
export {
  AnamorphicFlarePass, AnamorphicFlareShader, ANAMORPHIC_FLARE_DEFAULTS,
  type AnamorphicFlareConfig,
} from "./anamorphic-flares";

// Film grain per-ISO.
export {
  FilmGrainPerISO, getGrainForISO, FILM_GRAIN_PRESETS,
  PER_ISO_GRAIN_CHUNK,
  type FilmGrainPreset,
} from "./film-grain";

// Shell-shock desaturation curve.
export {
  ShellShockPass, ShellShockShader, SHELL_SHOCK_DEFAULTS,
  type ShellShockConfig,
} from "./shell-shock";

// Thermal bloom from hot barrels.
export {
  ThermalBarrelSystem, ThermalBloomPass, ThermalBloomShader,
  THERMAL_PROFILES, getThermalProfile,
  type ThermalProfile, type BarrelThermalState,
} from "./thermal-bloom";

// Frost pattern on cold-metal surfaces.
export {
  FrostMaterial, FrostPatternPass, FrostPatternShader,
  buildFrostTexture, getFrostPreset, FROST_PATTERN_PRESETS,
  type FrostPatternConfig,
} from "./frost-pattern";

// Lens dirt accumulation over match.
// NOTE: LensDirtShader is already exported from ./section-e-enhancements
// (line 106), so we only export the new symbols here to avoid a duplicate
// export error.
export {
  LensDirtPass, LensDirtAccumulator,
  buildLensDirtTexture, LENS_DIRT_DEFAULTS,
  type LensDirtConfig,
} from "./lens-dirt";

// Wiring helper — constructs the rendering2 passes for a given quality tier.
// The host PostProcessing.ts calls this and inserts the resulting passes
// into its EffectComposer pass list.
import * as THREE from "three";
import type { VolumetricFogPass as _VFog } from "./volumetric-fog";
import type { SSAOPass as _SSAO } from "./ssao";
import type { SSRPass as _SSR } from "./ssr";
import type { TAAPass as _TAA } from "./taa";
import type { LensWeatherPass as _Lens } from "./lens-weather";
import type { FractureVfxSystem as _Fracture } from "./fracture-vfx";
import type { RTShadowPass as _RTShadow } from "./rt-shadows";
import type { SurfelGIPass as _SurfelGI } from "./neural-gi";
import type { NeuralDenoiserPass as _Denoiser } from "./neural-denoiser";
import type { WaterCausticsPass as _Caustics } from "./water-caustics";
import type { AerialPerspectivePass as _Aerial } from "./atmospheric-scattering";
import type { ScreenSpaceSSSPass as _SSS } from "./subsurface-scattering";
import type { AnamorphicFlarePass as _Anamorphic } from "./anamorphic-flares";
import type { ShellShockPass as _ShellShock } from "./shell-shock";
import type { ThermalBloomPass as _Thermal } from "./thermal-bloom";
import type { FrostPatternPass as _Frost } from "./frost-pattern";
import type { LensDirtPass as _LensDirt } from "./lens-dirt";
import { SSAOPass } from "./ssao";
import { SSRPass } from "./ssr";
import { VolumetricFogPass } from "./volumetric-fog";
import { TAAPass } from "./taa";
import { LensWeatherPass } from "./lens-weather";
import { FractureVfxSystem } from "./fracture-vfx";
import { RTShadowPass } from "./rt-shadows";
import { RT_SHADOW_DEFAULTS } from "./rt-shadows";
import { SurfelGIPass } from "./neural-gi";
import { SURFEL_GI_DEFAULTS } from "./neural-gi";
import { NeuralDenoiserPass } from "./neural-denoiser";
import { WaterCausticsPass } from "./water-caustics";
import { WATER_CAUSTICS_DEFAULTS } from "./water-caustics";
import { AerialPerspectivePass } from "./atmospheric-scattering";
import { ScreenSpaceSSSPass } from "./subsurface-scattering";
import { SKIN_SSS_PRESETS } from "./subsurface-scattering";
import { AnamorphicFlarePass } from "./anamorphic-flares";
import { ANAMORPHIC_FLARE_DEFAULTS } from "./anamorphic-flares";
import { ShellShockPass } from "./shell-shock";
import { ThermalBloomPass } from "./thermal-bloom";
import { FrostPatternPass } from "./frost-pattern";
import { FROST_PATTERN_PRESETS } from "./frost-pattern";
import { LensDirtPass } from "./lens-dirt";
import { LENS_DIRT_DEFAULTS } from "./lens-dirt";
import { SSAO_QUALITY_DEFAULTS } from "./ssao";
import { SSR_QUALITY_DEFAULTS } from "./ssr";
import { TAA_QUALITY_DEFAULTS } from "./taa";

export type QualityTier = "low" | "medium" | "high" | "ultra";

/** A bundle of rendering2 passes — returned by `buildRendering2Passes`.
 *  Section A additions: rtShadows, surfelGI, denoiser, caustics, aerial,
 *  sss, anamorphic, shellShock, thermal, frost, lensDirt. */
export interface Rendering2Bundle {
  ssao: _SSAO | null;
  ssr: _SSR | null;
  volumetricFog: _VFog | null;
  taa: _TAA | null;
  lensWeather: _Lens | null;
  fractureVfx: _Fracture | null;
  // ─── Section A — 11 new passes ───
  rtShadows: _RTShadow | null;
  surfelGI: _SurfelGI | null;
  denoiser: _Denoiser | null;
  caustics: _Caustics | null;
  aerial: _Aerial | null;
  sss: _SSS | null;
  anamorphic: _Anamorphic | null;
  shellShock: _ShellShock | null;
  thermal: _Thermal | null;
  frost: _Frost | null;
  lensDirt: _LensDirt | null;
}

/** Construct the rendering2 passes for a given quality tier. Each pass is
 *  gated — `null` if disabled at this tier. The host PostProcessing.ts
 *  inserts the non-null passes into its composer pass list in the desired
 *  order (typically: SSAO → RT shadows → neural GI → SSR → volumetric fog →
 *  SSS → caustics → aerial perspective → thermal → anamorphic → shell-shock
 *  → lens dirt → lens weather → TAA). */
export function buildRendering2Passes(tier: QualityTier): Rendering2Bundle {
  const norm = (tier === "ultra" ? "high" : tier) as "low" | "medium" | "high";
  const ssaoCfg = SSAO_QUALITY_DEFAULTS[norm];
  const ssrCfg = SSR_QUALITY_DEFAULTS[norm];
  const taaCfg = TAA_QUALITY_DEFAULTS[norm];
  // Section A gates: the heavy RT/GI/denoiser passes are only constructed on
  // high tier (WebGPU tier classification handles further gating).
  const isHigh = norm === "high";
  return {
    ssao: ssaoCfg ? new SSAOPass(ssaoCfg) : null,
    ssr: ssrCfg ? new SSRPass(ssrCfg) : null,
    volumetricFog: isHigh ? new VolumetricFogPass({ steps: 24 }) : null,
    taa: taaCfg.enabled ? new TAAPass(taaCfg) : null,
    lensWeather: norm !== "low" ? new LensWeatherPass(norm) : null,
    fractureVfx: new FractureVfxSystem({ quality: norm }),
    // Section A — gated to high tier.
    rtShadows: isHigh && RT_SHADOW_DEFAULTS.high ? new RTShadowPass(RT_SHADOW_DEFAULTS.high) : null,
    surfelGI: isHigh && SURFEL_GI_DEFAULTS.high ? new SurfelGIPass(SURFEL_GI_DEFAULTS.high) : null,
    denoiser: isHigh ? new NeuralDenoiserPass() : null,
    caustics: isHigh ? new WaterCausticsPass(WATER_CAUSTICS_DEFAULTS) : null,
    aerial: isHigh ? new AerialPerspectivePass() : null,
    sss: isHigh ? new ScreenSpaceSSSPass(SKIN_SSS_PRESETS["skin-medium"]) : null,
    anamorphic: isHigh ? new AnamorphicFlarePass(ANAMORPHIC_FLARE_DEFAULTS) : null,
    shellShock: norm !== "low" ? new ShellShockPass() : null,
    thermal: norm !== "low" ? new ThermalBloomPass() : null,
    frost: isHigh ? new FrostPatternPass(FROST_PATTERN_PRESETS["arctic-outdoor"]) : null,
    lensDirt: norm !== "low" ? new LensDirtPass(LENS_DIRT_DEFAULTS) : null,
  };
}

/** Quality tier → boolean gate helper. Exported for tests + diagnostics.
 *
 *  Convention (matches the per-module QUALITY_DEFAULTS):
 *    - SSAO:       medium + high (different sample counts per tier)
 *    - SSR:        medium + high (different step counts per tier)
 *    - TAA:        medium + high (FXAA fallback on low)
 *    - Volumetric fog: high only (heavy GPU cost — god rays + distance fog)
 *    - Lens weather:   medium + high (skipped on low)
 *    - Section A passes (RT shadows, GI, denoiser, caustics, aerial, SSS,
 *      anamorphic, frost): high only.
 *    - Shell shock, thermal, lens dirt: medium + high (lighter cost). */
export function isPassEnabled(tier: QualityTier, pass: "ssao" | "ssr" | "taa" | "volumetricFog" | "lensWeather" | "rtShadows" | "surfelGI" | "denoiser" | "caustics" | "aerial" | "sss" | "anamorphic" | "shellShock" | "thermal" | "frost" | "lensDirt"): boolean {
  const norm = (tier === "ultra" ? "high" : tier) as "low" | "medium" | "high";
  if (norm === "low") return false;
  if (pass === "volumetricFog") return norm === "high";
  // Heavy Section A passes — high only.
  if (pass === "rtShadows" || pass === "surfelGI" || pass === "denoiser" ||
      pass === "caustics" || pass === "aerial" || pass === "sss" ||
      pass === "anamorphic" || pass === "frost") {
    return norm === "high";
  }
  return true;
}

/** Sentinel — re-export THREE so callers can `import { THREE } from "@/lib/game/rendering2"`. */
export { THREE };
