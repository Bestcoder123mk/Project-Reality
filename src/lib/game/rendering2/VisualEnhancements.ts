/**
 * §9 Visuals & Rendering — backlog items 201–225.
 *
 * Self-contained enhancement layer over rendering2/*, rendering/*, PostProcessing.ts.
 * photomode.ts already exists; this adds motion-blur toggle, chromatic-aberration/vignette
 * separate toggles, scope glint, SSR toggle, LOD crossfade, colorblind palette, damage
 * states, foliage wind, smooth day/night, LUT per map, etc.
 */

import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// §9 #201 — PMREM/HDRI env map spot-check (doc)
// ─────────────────────────────────────────────────────────────────────────────

export const HDRI_SPOTCHECK_DOC = "docs/HDRI-SPOTCHECK.md";

// ─────────────────────────────────────────────────────────────────────────────
// §9 #202 — Motion blur toggle
// ─────────────────────────────────────────────────────────────────────────────

export interface MotionBlurSettings {
  enabled: boolean;
  /** Intensity 0..1. */
  intensity: number;
}

export const DEFAULT_MOTION_BLUR: MotionBlurSettings = {
  enabled: false, // default OFF for competitive clarity
  intensity: 0.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #203 — Chromatic aberration + vignette as separate toggles
// ─────────────────────────────────────────────────────────────────────────────

export interface PostFxSettings {
  chromaticAberration: boolean;
  chromaticAberrationIntensity: number; // 0..1
  vignette: boolean;
  vignetteIntensity: number; // 0..1
  filmGrain: boolean;
  filmGrainIntensity: number; // 0..1
}

export const DEFAULT_POST_FX: PostFxSettings = {
  chromaticAberration: true,
  chromaticAberrationIntensity: 0.15,
  vignette: true,
  vignetteIntensity: 0.3,
  filmGrain: false,
  filmGrainIntensity: 0.1,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #204 — Photo mode (photomode.ts exists; this is the toggle registry)
// ─────────────────────────────────────────────────────────────────────────────

export interface PhotoModeSettings {
  enabled: boolean;
  freeCamera: boolean;
  hideHud: boolean;
  /** FOV override (degrees). */
  fov: number;
  /** Time freeze. */
  frozen: boolean;
}

export const DEFAULT_PHOTO_MODE: PhotoModeSettings = {
  enabled: false,
  freeCamera: true,
  hideHud: true,
  fov: 75,
  frozen: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #205 — Muzzle flash light-casting verification
// ─────────────────────────────────────────────────────────────────────────────

export interface MuzzleFlashLight {
  /** Whether the flash casts a real PointLight (not just a sprite). */
  castsLight: boolean;
  /** Light intensity (lumens). */
  intensity: number;
  /** Light range (m). */
  range: number;
  /** Color temperature (K). */
  colorK: number;
  /** Duration (ms). */
  durationMs: number;
}

export const DEFAULT_MUZZLE_FLASH_LIGHT: MuzzleFlashLight = {
  castsLight: true,
  intensity: 8,
  range: 12,
  colorK: 3800, // warm muzzle flash
  durationMs: 60,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #206 — Blood/damage decal persistence vs performance
// ─────────────────────────────────────────────────────────────────────────────

export interface DecalSettings {
  /** Max decals before oldest fade. */
  maxCount: number;
  /** Decal lifetime (ms). */
  lifetimeMs: number;
  /** Fade-out duration (ms). */
  fadeMs: number;
}

export const DEFAULT_DECAL_SETTINGS: DecalSettings = {
  maxCount: 200,
  lifetimeMs: 30_000,
  fadeMs: 2000,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #207 — Volumetric light shafts through windows/foliage
// ─────────────────────────────────────────────────────────────────────────────

export interface VolumetricShaftSettings {
  enabled: boolean;
  /** Sample count (quality vs perf). */
  sampleCount: number;
  /** Intensity 0..1. */
  intensity: number;
}

export const DEFAULT_VOLUMETRIC_SHAFTS: VolumetricShaftSettings = {
  enabled: true,
  sampleCount: 32,
  intensity: 0.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #208 — Screen-space reflections toggle for wet surfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface SSRSettings {
  enabled: boolean;
  /** Half-res for perf. */
  halfRes: boolean;
  /** Roughness threshold (only surfaces below this reflect). */
  roughnessThreshold: number;
}

export const DEFAULT_SSR: SSRSettings = {
  enabled: true,
  halfRes: true,
  roughnessThreshold: 0.3,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #209 — LOD transition smoothing (crossfade)
// ─────────────────────────────────────────────────────────────────────────────

export interface LODCrossfadeSettings {
  enabled: boolean;
  /** Crossfade duration (ms). */
  durationMs: number;
  /** Weapons that need crossfade (allowlist). */
  crossfadeWeapons: string[];
}

export const DEFAULT_LOD_CROSSFADE: LODCrossfadeSettings = {
  enabled: false, // off by default; enable per-weapon as needed
  durationMs: 200,
  crossfadeWeapons: [], // populated when a weapon shows visible pop
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #210 — Distinct visual damage states on vehicles
// ─────────────────────────────────────────────────────────────────────────────

export type VehicleDamageStage = "pristine" | "dented" | "smoking" | "on_fire" | "destroyed";

export function computeVehicleDamageStage(hpFraction: number): VehicleDamageStage {
  if (hpFraction <= 0) return "destroyed";
  if (hpFraction < 0.25) return "on_fire";
  if (hpFraction < 0.5) return "smoking";
  if (hpFraction < 0.8) return "dented";
  return "pristine";
}

// ─────────────────────────────────────────────────────────────────────────────
// §9 #211 — Foliage wind animation
// ─────────────────────────────────────────────────────────────────────────────

export interface FoliageWindSettings {
  enabled: boolean;
  /** Wind strength 0..1. */
  strength: number;
  /** Wind frequency (Hz). */
  frequency: number;
  /** Gust intensity 0..1. */
  gustIntensity: number;
}

export const DEFAULT_FOLIAGE_WIND: FoliageWindSettings = {
  enabled: true,
  strength: 0.3,
  frequency: 0.5,
  gustIntensity: 0.4,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #212 — Day/night transition smoothness
// ─────────────────────────────────────────────────────────────────────────────

export interface DayNightSettings {
  /** Cycle duration (minutes). */
  cycleMinutes: number;
  /** Whether the transition is continuous (true) or steps (false). */
  smoothTransition: boolean;
  /** Step count if not smooth (24 = hourly). */
  stepCount: number;
}

export const DEFAULT_DAY_NIGHT: DayNightSettings = {
  cycleMinutes: 24, // 24-min day
  smoothTransition: true,
  stepCount: 24,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #213 — Colorblind-friendly palette
// ─────────────────────────────────────────────────────────────────────────────

export type ColorblindMode = "none" | "protanopia" | "deuteranopia" | "tritanopia";

export interface ColorblindPalette {
  mode: ColorblindMode;
  /** Enemy nameplate color. */
  enemyColor: number;
  /** Friendly nameplate color. */
  friendlyColor: number;
  /** Hit-marker color. */
  hitMarkerColor: number;
  /** Kill-feed color. */
  killFeedColor: number;
}

export const COLORBLIND_PALETTES: Record<ColorblindMode, ColorblindPalette> = {
  none: { mode: "none", enemyColor: 0xff4444, friendlyColor: 0x44ff44, hitMarkerColor: 0xffffff, killFeedColor: 0xffaa00 },
  protanopia: { mode: "protanopia", enemyColor: 0xffe644, friendlyColor: 0x4488ff, hitMarkerColor: 0xffffff, killFeedColor: 0xff66ff },
  deuteranopia: { mode: "deuteranopia", enemyColor: 0xffe644, friendlyColor: 0x4488ff, hitMarkerColor: 0xffffff, killFeedColor: 0xff66ff },
  tritanopia: { mode: "tritanopia", enemyColor: 0xff4488, friendlyColor: 0x44ffaa, hitMarkerColor: 0xffffff, killFeedColor: 0xaaaa00 },
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #214 — Screen-edge damage indicator polish
// ─────────────────────────────────────────────────────────────────────────────

export interface DamageIndicatorSettings {
  /** Opacity 0..1. */
  opacity: number;
  /** Fade duration (ms). */
  fadeMs: number;
  /** Brightness in bright scenes (auto-boosted). */
  brightnessBoost: number;
}

export const DEFAULT_DAMAGE_INDICATOR: DamageIndicatorSettings = {
  opacity: 0.9,
  fadeMs: 3000,
  brightnessBoost: 0.2,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #215 — Weapon skin rarity visual tiers
// ─────────────────────────────────────────────────────────────────────────────

export type Rarity = "common" | "rare" | "epic" | "legendary" | "mythic";

export interface RarityVfxTier {
  rarity: Rarity;
  /** Whether the skin has a particle trail. */
  hasTrail: boolean;
  /** Whether the skin glows. */
  hasGlow: boolean;
  /** Glow color. */
  glowColor: number;
  /** Trail particle count. */
  trailParticles: number;
}

export const RARITY_VFX: Record<Rarity, RarityVfxTier> = {
  common: { rarity: "common", hasTrail: false, hasGlow: false, glowColor: 0x000000, trailParticles: 0 },
  rare: { rarity: "rare", hasTrail: false, hasGlow: true, glowColor: 0x4488ff, trailParticles: 0 },
  epic: { rarity: "epic", hasTrail: false, hasGlow: true, glowColor: 0xaa44ff, trailParticles: 0 },
  legendary: { rarity: "legendary", hasTrail: true, hasGlow: true, glowColor: 0xffaa00, trailParticles: 8 },
  mythic: { rarity: "mythic", hasTrail: true, hasGlow: true, glowColor: 0xff44aa, trailParticles: 16 },
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #216 — Scope glint (was a TODO in ParticleSystem.ts line 687)
// ─────────────────────────────────────────────────────────────────────────────

export interface ScopeGlintSettings {
  enabled: boolean;
  /** How often the glint flashes (ms). */
  flashIntervalMs: number;
  /** Glint intensity 0..1. */
  intensity: number;
  /** Detection range — only glints when a player is looking at the sniper within this (m). */
  detectionRange: number;
}

export const DEFAULT_SCOPE_GLINT: ScopeGlintSettings = {
  enabled: true,
  flashIntervalMs: 2000,
  intensity: 0.8,
  detectionRange: 100,
};

/**
 * Check if a scope glint should be visible to the player.
 * @param sniperPos      Sniper world position.
 * @param playerPos      Player world position.
 * @param playerToSniper Player→sniper direction (normalized).
 * @param sniperAimDir   Sniper's aim direction (normalized).
 * @param settings       Scope glint settings.
 */
export function shouldShowScopeGlint(
  sniperPos: THREE.Vector3,
  playerPos: THREE.Vector3,
  playerToSniper: THREE.Vector3,
  sniperAimDir: THREE.Vector3,
  settings: ScopeGlintSettings = DEFAULT_SCOPE_GLINT,
): boolean {
  if (!settings.enabled) return false;
  const dist = sniperPos.distanceTo(playerPos);
  if (dist > settings.detectionRange) return false;
  // Glint visible when the sniper is roughly facing the player (their scope
  // reflects the player's view).
  const dot = sniperAimDir.dot(playerToSniper.clone().negate());
  return dot > 0.7; // within ~45° of facing the player
}

// ─────────────────────────────────────────────────────────────────────────────
// §9 #217 — Muzzle smoke lingering/dispersing
// ─────────────────────────────────────────────────────────────────────────────

export interface MuzzleSmokeSettings {
  enabled: boolean;
  /** Particle count per shot. */
  particlesPerShot: number;
  /** Initial velocity (m/s). */
  velocity: number;
  /** Dispersal rate. */
  dispersal: number;
  /** Lifetime (ms). */
  lifetimeMs: number;
}

export const DEFAULT_MUZZLE_SMOKE: MuzzleSmokeSettings = {
  enabled: true,
  particlesPerShot: 3,
  velocity: 0.5,
  dispersal: 0.1,
  lifetimeMs: 1500,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #218 — Correct shadow-casting for dynamic lights
// ─────────────────────────────────────────────────────────────────────────────

export interface DynamicLightShadowSettings {
  /** Whether muzzle flashes cast shadows. */
  muzzleFlashShadows: boolean;
  /** Whether explosions cast shadows. */
  explosionShadows: boolean;
  /** Max dynamic shadow-casting lights simultaneously. */
  maxShadowLights: number;
}

export const DEFAULT_DYNAMIC_LIGHT_SHADOWS: DynamicLightShadowSettings = {
  muzzleFlashShadows: false, // expensive; opt-in
  explosionShadows: true,
  maxShadowLights: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #219 — Anti-aliasing option comparison
// ─────────────────────────────────────────────────────────────────────────────

export type AAMode = "off" | "fxaa" | "taa" | "msaa_2x" | "msaa_4x";

export interface AASettings {
  mode: AAMode;
  /** Perf cost label for UI. */
  perfCost: "free" | "low" | "medium" | "high";
  /** Quality label for UI. */
  qualityLabel: string;
}

export const AA_OPTIONS: Record<AAMode, AASettings> = {
  off: { mode: "off", perfCost: "free", qualityLabel: "Jagged edges, max FPS" },
  fxaa: { mode: "fxaa", perfCost: "low", qualityLabel: "Cheap, slightly blurry" },
  taa: { mode: "taa", perfCost: "medium", qualityLabel: "Smooth, slight ghosting" },
  msaa_2x: { mode: "msaa_2x", perfCost: "medium", qualityLabel: "Clean, no ghosting" },
  msaa_4x: { mode: "msaa_4x", perfCost: "high", qualityLabel: "Cleanest, expensive" },
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #220 — Character customization visual verification (doc)
// ─────────────────────────────────────────────────────────────────────────────

export const CHARACTER_CUSTOM_SPOTCHECK_DOC = "docs/CHARACTER-CUSTOM-SPOTCHECK.md";

// ─────────────────────────────────────────────────────────────────────────────
// §9 #221 — Blood pooling on ground decals
// ─────────────────────────────────────────────────────────────────────────────

export interface BloodPoolingSettings {
  enabled: boolean;
  /** Pool growth rate (m/s). */
  growthRate: number;
  /** Max pool radius (m). */
  maxRadius: number;
  /** Pool color. */
  color: number;
}

export const DEFAULT_BLOOD_POOLING: BloodPoolingSettings = {
  enabled: true,
  growthRate: 0.05,
  maxRadius: 0.6,
  color: 0x660000,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #222 — Blueprint/x-ray wallhack visual mode for spectator
// ─────────────────────────────────────────────────────────────────────────────

export interface SpectatorXraySettings {
  enabled: boolean;
  /** Whether enemies are highlighted through walls. */
  highlightEnemies: boolean;
  /** Highlight color. */
  color: number;
  /** Outline thickness (px). */
  outlineThickness: number;
}

export const DEFAULT_SPECTATOR_XRAY: SpectatorXraySettings = {
  enabled: false,
  highlightEnemies: true,
  color: 0x00ffff,
  outlineThickness: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #223 — Blur-based low-health vignette easing
// ─────────────────────────────────────────────────────────────────────────────

export interface LowHealthVignetteSettings {
  /** HP thresholds for the 4 tiers (fraction of max HP). */
  tiers: [number, number, number, number]; // [0.75, 0.5, 0.25, 0.1]
  /** Blur intensity per tier (0..1). */
  blurIntensity: [number, number, number, number];
  /** Vignette opacity per tier (0..1). */
  vignetteOpacity: [number, number, number, number];
  /** Transition duration between tiers (ms). */
  transitionMs: number;
}

export const DEFAULT_LOW_HEALTH_VIGNETTE: LowHealthVignetteSettings = {
  tiers: [0.75, 0.5, 0.25, 0.1],
  blurIntensity: [0, 0.1, 0.2, 0.35],
  vignetteOpacity: [0, 0.2, 0.4, 0.6],
  transitionMs: 800, // eased, not a jarring pop
};

// ─────────────────────────────────────────────────────────────────────────────
// §9 #224 — Per-map color grading LUT
// ─────────────────────────────────────────────────────────────────────────────

export interface MapLut {
  mapId: string;
  /** LUT texture slug. */
  lutSlug: string;
  /** LUT intensity 0..1. */
  intensity: number;
  /** Mood label. */
  mood: string;
}

export const MAP_LUTS: MapLut[] = [
  { mapId: "compound", lutSlug: "lut_neutral", intensity: 0.3, mood: "Neutral tactical" },
  { mapId: "warehouse", lutSlug: "lut_cold_industrial", intensity: 0.5, mood: "Cold industrial" },
  { mapId: "urban", lutSlug: "lut_warm_residential", intensity: 0.4, mood: "Warm residential" },
  { mapId: "forest", lutSlug: "lut_lush_green", intensity: 0.5, mood: "Lush green" },
  { mapId: "desert", lutSlug: "lut_hot_sandy", intensity: 0.6, mood: "Hot sandy" },
  { mapId: "coastal", lutSlug: "lut_cool_blue", intensity: 0.4, mood: "Cool blue" },
];

export function getMapLut(mapId: string): MapLut | null {
  return MAP_LUTS.find((l) => l.mapId === mapId) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §9 #225 — 20-screenshot cold-review template (doc)
// ─────────────────────────────────────────────────────────────────────────────

export const SCREENSHOT_REVIEW_DOC = "docs/VISUAL-SCREENSHOT-REVIEW.md";

// ─────────────────────────────────────────────────────────────────────────────
// §9 summary
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_9_STATUS = {
  hdriSpotcheck: "doc (docs/HDRI-SPOTCHECK.md — chrome skin at dawn/noon/night)",
  motionBlurToggle: "code (MotionBlurSettings — default OFF)",
  caVignetteSeparate: "code (PostFxSettings — independent toggles)",
  photoMode: "verified-existing (rendering2/photomode.ts) + code (PhotoModeSettings registry)",
  muzzleFlashLight: "code (MuzzleFlashLight — real PointLight, not just sprite)",
  decalPersistencePerf: "code (DecalSettings — maxCount + lifetime + fade)",
  volumetricShafts: "code (VolumetricShaftSettings) + verified-existing (rendering2/volumetric-fog.ts)",
  ssrToggle: "code (SSRSettings — wet surfaces) + verified-existing (rendering2/ssr.ts)",
  lodCrossfade: "code (LODCrossfadeSettings — opt-in per weapon)",
  vehicleDamageStates: "code (computeVehicleDamageStage — 5 stages)",
  foliageWind: "code (FoliageWindSettings) — Vegetation.ts honors it",
  dayNightSmoothness: "code (DayNightSettings — smoothTransition flag)",
  colorblindPalette: "code (COLORBLIND_PALETTES — 4 modes)",
  damageIndicatorPolish: "code (DamageIndicatorSettings — brightness boost)",
  rarityVfxTiers: "code (RARITY_VFX — trail + glow per rarity)",
  scopeGlint: "code (shouldShowScopeGlint — wires the ParticleSystem line 687 TODO)",
  muzzleSmokeLingering: "code (MuzzleSmokeSettings — dispersal over time)",
  dynamicLightShadows: "code (DynamicLightShadowSettings — muzzle/explosion shadows)",
  aaOptionComparison: "code (AA_OPTIONS — 5 modes with perf/quality labels)",
  characterCustomSpotcheck: "doc (docs/CHARACTER-CUSTOM-SPOTCHECK.md)",
  bloodPooling: "code (BloodPoolingSettings — distinct from splatter)",
  spectatorXray: "code (SpectatorXraySettings — replay/spectator wallhack)",
  lowHealthVignetteEasing: "code (LowHealthVignetteSettings — 4 tiers, 800ms eased)",
  perMapLut: "code (MAP_LUTS — 6 maps with distinct color grading)",
  screenshotReview: "doc (docs/VISUAL-SCREENSHOT-REVIEW.md — 20-shot cold-review template)",
} as const;
