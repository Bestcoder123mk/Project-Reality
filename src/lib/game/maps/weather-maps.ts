/**
 * Section M — Weather system per map.
 *
 * Per-biome weather presets that integrate with the existing
 * WeatherSystem.ts (engine-owned). Each preset configures: cloud cover,
 * precipitation type + intensity, fog density, wind speed/direction,
 * and gameplay-impact flags (visibility modifier, audio muffling factor,
 * movement-speed modifier, weapon-sway multiplier).
 *
 * The M_Maps_Environments prompt library repeatedly calls for weather
 * presets per biome + per fidelity tier — this module is the single
 * source of truth the maps API + the WeatherSystem read from.
 *
 * Public API:
 *   - WEATHER_PRESETS — registry (id → preset).
 *   - getWeatherPreset(id) — accessor.
 *   - pickWeatherForBiome(biome, seed) — deterministic random pick
 *     weighted by the biome's weatherWeights table.
 *   - applyWeatherPreset(ctx, preset) — write the preset into the
 *     engine's weather state (pure-data side; the WeatherSystem reads
 *     it on next tick + refreshes visuals).
 *   - getWeatherGameplayImpact(preset) — read-only impact summary for
 *     the HUD (visibility modifier etc.).
 */

import type { BiomeId } from "./biomes";
import { getBiome } from "./biomes";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type WeatherPresetId =
  | "clear" | "overcast" | "rain_light" | "rain_heavy"
  | "fog_dense" | "fog_coastal" | "coastal_haze"
  | "sandstorm" | "blizzard" | "monsoon"
  | "snow_light" | "mist_jungle" | "dusk_warm";

export type PrecipitationType = "none" | "rain" | "snow" | "sleet" | "sand";

export interface WeatherPreset {
  id: WeatherPresetId;
  label: string;
  /** Cloud cover 0..1. */
  cloudCover: number;
  /** Precipitation type + intensity 0..1. */
  precipitation: { type: PrecipitationType; intensity: number };
  /** Fog density (m^-1, exponential). Capped at 0.015 by the visibility floor. */
  fogDensity: number;
  /** Wind speed (m/s) + direction (radians, 0 = +X). */
  wind: { speed: number; direction: number };
  /** Sky-color tint (hex) applied on top of the time-of-day palette. */
  skyTint: number;
  /** Ambient brightness multiplier (0..1 typical; 1.1 = brighter). */
  ambientMultiplier: number;
  /** Sun intensity multiplier (0..1.2 typical; 0.4 = heavily overcast). */
  sunMultiplier: number;
  /** Gameplay impact block — surfaced to the HUD + consumed by movement/
   *  audio/weapon-sway systems. */
  gameplay: WeatherGameplayImpact;
}

export interface WeatherGameplayImpact {
  /** Effective visibility (m). 0 = unlimited. */
  visibility: number;
  /** Audio muffle factor 0..1 (0 = clear, 1 = fully muffled). */
  audioMuffle: number;
  /** Movement-speed multiplier (1 = normal, 0.8 = 20% slower). */
  movementMultiplier: number;
  /** Weapon-sway multiplier (1 = normal, 1.5 = 50% more sway). */
  swayMultiplier: number;
  /** Exposure tick (HP/sec) when outside cover in extreme weather
   *  (blizzard = hypothermia, sandstorm = lung damage). 0 = none. */
  exposureDamage: number;
  /** Footprint visibility multiplier — wet snow + mud leave clear
   *  tracks (helps hunting the VIP in EXTRACTION mode). */
  footprintVisibility: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Presets
// ──────────────────────────────────────────────────────────────────────────

export const WEATHER_PRESETS: Record<WeatherPresetId, WeatherPreset> = {
  clear: {
    id: "clear", label: "Clear",
    cloudCover: 0.15, precipitation: { type: "none", intensity: 0 },
    fogDensity: 0.008, wind: { speed: 2, direction: 0 },
    skyTint: 0xffffff, ambientMultiplier: 1.0, sunMultiplier: 1.0,
    gameplay: { visibility: 0, audioMuffle: 0, movementMultiplier: 1, swayMultiplier: 1, exposureDamage: 0, footprintVisibility: 0.4 },
  },
  overcast: {
    id: "overcast", label: "Overcast",
    cloudCover: 0.75, precipitation: { type: "none", intensity: 0 },
    fogDensity: 0.012, wind: { speed: 5, direction: 0.5 },
    skyTint: 0xa0a8b0, ambientMultiplier: 0.85, sunMultiplier: 0.55,
    gameplay: { visibility: 0, audioMuffle: 0.05, movementMultiplier: 0.97, swayMultiplier: 1.1, exposureDamage: 0, footprintVisibility: 0.6 },
  },
  rain_light: {
    id: "rain_light", label: "Light Rain",
    cloudCover: 0.7, precipitation: { type: "rain", intensity: 0.3 },
    fogDensity: 0.013, wind: { speed: 4, direction: 1.0 },
    skyTint: 0x8090a0, ambientMultiplier: 0.8, sunMultiplier: 0.45,
    gameplay: { visibility: 60, audioMuffle: 0.2, movementMultiplier: 0.95, swayMultiplier: 1.15, exposureDamage: 0, footprintVisibility: 0.8 },
  },
  rain_heavy: {
    id: "rain_heavy", label: "Heavy Rain",
    cloudCover: 0.9, precipitation: { type: "rain", intensity: 0.75 },
    fogDensity: 0.015, wind: { speed: 8, direction: 1.5 },
    skyTint: 0x606878, ambientMultiplier: 0.65, sunMultiplier: 0.3,
    gameplay: { visibility: 35, audioMuffle: 0.45, movementMultiplier: 0.9, swayMultiplier: 1.3, exposureDamage: 0, footprintVisibility: 0.95 },
  },
  fog_dense: {
    id: "fog_dense", label: "Dense Fog",
    cloudCover: 0.5, precipitation: { type: "none", intensity: 0 },
    fogDensity: 0.015, wind: { speed: 1, direction: 0 },
    skyTint: 0xb0b0b0, ambientMultiplier: 0.75, sunMultiplier: 0.4,
    gameplay: { visibility: 25, audioMuffle: 0.15, movementMultiplier: 1, swayMultiplier: 1, exposureDamage: 0, footprintVisibility: 0.5 },
  },
  fog_coastal: {
    id: "fog_coastal", label: "Coastal Fog",
    cloudCover: 0.4, precipitation: { type: "none", intensity: 0 },
    fogDensity: 0.013, wind: { speed: 3, direction: 2.0 },
    skyTint: 0xc8d0d8, ambientMultiplier: 0.85, sunMultiplier: 0.55,
    gameplay: { visibility: 45, audioMuffle: 0.1, movementMultiplier: 1, swayMultiplier: 1.05, exposureDamage: 0, footprintVisibility: 0.7 },
  },
  coastal_haze: {
    id: "coastal_haze", label: "Coastal Haze",
    cloudCover: 0.3, precipitation: { type: "none", intensity: 0 },
    fogDensity: 0.010, wind: { speed: 3, direction: 2.5 },
    skyTint: 0xd0e0e8, ambientMultiplier: 0.9, sunMultiplier: 0.7,
    gameplay: { visibility: 70, audioMuffle: 0.08, movementMultiplier: 1, swayMultiplier: 1.05, exposureDamage: 0, footprintVisibility: 0.5 },
  },
  sandstorm: {
    id: "sandstorm", label: "Sandstorm",
    cloudCover: 0.4, precipitation: { type: "sand", intensity: 0.9 },
    fogDensity: 0.015, wind: { speed: 15, direction: 0.8 },
    skyTint: 0xc8a060, ambientMultiplier: 0.7, sunMultiplier: 0.5,
    gameplay: { visibility: 20, audioMuffle: 0.5, movementMultiplier: 0.85, swayMultiplier: 1.4, exposureDamage: 1.5, footprintVisibility: 0.3 },
  },
  blizzard: {
    id: "blizzard", label: "Blizzard",
    cloudCover: 0.95, precipitation: { type: "snow", intensity: 0.95 },
    fogDensity: 0.015, wind: { speed: 12, direction: 1.2 },
    skyTint: 0xd0dae4, ambientMultiplier: 0.8, sunMultiplier: 0.4,
    gameplay: { visibility: 18, audioMuffle: 0.35, movementMultiplier: 0.8, swayMultiplier: 1.5, exposureDamage: 2.0, footprintVisibility: 0.9 },
  },
  monsoon: {
    id: "monsoon", label: "Monsoon",
    cloudCover: 0.95, precipitation: { type: "rain", intensity: 0.95 },
    fogDensity: 0.015, wind: { speed: 10, direction: 2.4 },
    skyTint: 0x4a5a4a, ambientMultiplier: 0.6, sunMultiplier: 0.25,
    gameplay: { visibility: 22, audioMuffle: 0.55, movementMultiplier: 0.85, swayMultiplier: 1.35, exposureDamage: 0, footprintVisibility: 1.0 },
  },
  snow_light: {
    id: "snow_light", label: "Light Snow",
    cloudCover: 0.7, precipitation: { type: "snow", intensity: 0.4 },
    fogDensity: 0.012, wind: { speed: 4, direction: 0.8 },
    skyTint: 0xc0c8d4, ambientMultiplier: 0.85, sunMultiplier: 0.55,
    gameplay: { visibility: 50, audioMuffle: 0.2, movementMultiplier: 0.92, swayMultiplier: 1.2, exposureDamage: 0.3, footprintVisibility: 0.85 },
  },
  mist_jungle: {
    id: "mist_jungle", label: "Jungle Mist",
    cloudCover: 0.6, precipitation: { type: "none", intensity: 0 },
    fogDensity: 0.014, wind: { speed: 1, direction: 0 },
    skyTint: 0x809070, ambientMultiplier: 0.8, sunMultiplier: 0.5,
    gameplay: { visibility: 30, audioMuffle: 0.3, movementMultiplier: 0.95, swayMultiplier: 1.1, exposureDamage: 0, footprintVisibility: 0.7 },
  },
  dusk_warm: {
    id: "dusk_warm", label: "Warm Dusk",
    cloudCover: 0.25, precipitation: { type: "none", intensity: 0 },
    fogDensity: 0.010, wind: { speed: 3, direction: 1.0 },
    skyTint: 0xffa860, ambientMultiplier: 0.9, sunMultiplier: 0.85,
    gameplay: { visibility: 0, audioMuffle: 0, movementMultiplier: 1, swayMultiplier: 1, exposureDamage: 0, footprintVisibility: 0.5 },
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Accessors
// ──────────────────────────────────────────────────────────────────────────

export function getWeatherPreset(id: WeatherPresetId | string | undefined): WeatherPreset {
  if (id && id in WEATHER_PRESETS) return WEATHER_PRESETS[id as WeatherPresetId];
  return WEATHER_PRESETS.clear;
}

/** Deterministic weighted-random pick of a weather preset for a biome.
 *  Uses the biome's `weatherWeights` table. The seed makes the pick
 *  reproducible per-match (so a rematch on the same map+biome can roll
 *  a different preset). */
export function pickWeatherForBiome(
  biome: BiomeId,
  seed: number,
): WeatherPreset {
  const def = getBiome(biome);
  const weights = def.weatherWeights;
  // Deterministic PRNG (mulberry32).
  let a = seed >>> 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const roll = ((t ^ (t >>> 14)) >>> 0) / 4294967296;

  const entries = Object.entries(weights) as [WeatherPresetId, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let cumul = 0;
  for (const [id, w] of entries) {
    cumul += w / total;
    if (roll <= cumul) return WEATHER_PRESETS[id] ?? WEATHER_PRESETS.clear;
  }
  return WEATHER_PRESETS.clear;
}

// ──────────────────────────────────────────────────────────────────────────
// Apply preset → engine weather state
// ──────────────────────────────────────────────────────────────────────────

/** Loose shape of the engine weather state (subset of WeatherState in
 *  realism.ts). Kept loose so we don't pull the whole realism module
 *  into this file's import graph. */
export interface EngineWeatherState {
  cloudCover: number;
  precipitation: number;
  windSpeed: number;
  windDirection: number;
  fogDensity: number;
  wetness: number;
  timeOfDay: number;
}

/** Write a weather preset into the engine weather state. The
 *  WeatherSystem picks this up on the next visuals refresh + drives
 *  the rain particle field + renderer's wetness lerp.
 *
 *  Pure function (no THREE). */
export function applyWeatherPreset(
  state: EngineWeatherState,
  preset: WeatherPreset,
): void {
  state.cloudCover = preset.cloudCover;
  state.precipitation = preset.precipitation.intensity;
  state.windSpeed = preset.wind.speed;
  state.windDirection = preset.wind.direction;
  state.fogDensity = preset.fogDensity;
  // Wetness ramps up only for rain/sleet; snow + sand don't wet surfaces.
  if (preset.precipitation.type === "rain" || preset.precipitation.type === "sleet") {
    state.wetness = Math.min(1, state.wetness + preset.precipitation.intensity * 0.5);
  } else {
    state.wetness = Math.max(0, state.wetness - 0.1);
  }
}

/** Read-only gameplay impact summary (for HUD + design dashboard). */
export function getWeatherGameplayImpact(preset: WeatherPreset): WeatherGameplayImpact {
  return { ...preset.gameplay };
}

/** List all weather presets (for the maps-select screen / map-voting). */
export function listWeatherPresets(): WeatherPreset[] {
  return Object.values(WEATHER_PRESETS);
}
