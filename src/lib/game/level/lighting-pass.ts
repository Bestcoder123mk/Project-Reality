/**
 * SEC9-LEVEL — Prompt 76: Per-map lighting art pass.
 *
 * Each map declares a `LightingPreset` (sun angle/color/intensity, ambient
 * color, fog color/density, exposure, accent lights) so the 10 maps feel
 * like 10 distinct places — bright noon compound, dusk warehouse, moonlit
 * rooftops, dawn desert, overcast alley, etc. The existing MapBuilder's
 * `applyMapLighting` reads a flat `MapLightConfig` (ambient/sun/hemi/fog
 * with hard-coded floor clamps); this module layers a richer preset on
 * top, including:
 *
 *   - sun angle (elevation + azimuth) → derived sun position
 *   - tone-mapping exposure (applied to the renderer)
 *   - background color (applied to the scene)
 *   - accent lights (per-map localized point/spot lights for mood)
 *
 * Public API:
 *   - `getMapLighting(mapSlug)` → the preset for a map.
 *   - `applyLightingPreset(ctx, preset)` → applies a preset to the live
 *     scene (sun + hemi + ambient + fog + exposure + background + accent
 *     lights). Called by the engine on map load, after the existing
 *     `applyMapLighting` runs.
 *   - `sunPositionFromPreset(preset, distance)` → derives the sun position
 *     vector from elevation/azimuth (used by the engine if it needs to set
 *     the sun direction manually).
 *
 * NOTE on Environment.ts: the existing `src/lib/game/Environment.ts` is
 * about deploy-environment config (dev/staging/prod), not lighting. So
 * this lighting art pass lives in a new module under `level/` rather than
 * extending Environment.ts. The orchestrator can rename Environment.ts →
 * DeployEnvironment.ts later if desired; that's outside this task's scope.
 */

import * as THREE from "three";
import type { GameContext } from "../systems/types";

// ─── Public types ────────────────────────────────────────────────────────

/** A localized accent light for mood. */
export interface AccentLight {
  /** Light type — point (omni) or spot (cone). */
  type: "point" | "spot";
  /** World position [x, y, z]. */
  position: [number, number, number];
  /** Color (hex). */
  color: number;
  /** Intensity (typ. 0.5–4.0 in physical units; we use linear for simplicity). */
  intensity: number;
  /** Point light falloff distance (m). Ignored for spot lights. */
  distance?: number;
  /** Spot cone angle (radians). Ignored for point lights. */
  angle?: number;
  /** Spot soft-edge fraction (0..1). Ignored for point lights. */
  penumbra?: number;
}

/** A complete per-map lighting preset. */
export interface LightingPreset {
  /** Map slug this preset belongs to. */
  slug: string;
  /** Human-readable name (informational). */
  name: string;
  /** Sun elevation (radians) — 0=horizon, π/2=zenith. */
  sunAngle: number;
  /** Sun azimuth (radians) — 0=north (+Z), π/2=east (+X). */
  sunAzimuth: number;
  /** Sun color (hex). */
  sunColor: number;
  /** Sun intensity (typ. 1.0–3.0; clamped to >=1.0 by applyLightingPreset). */
  sunIntensity: number;
  /** Ambient color (hex). */
  ambientColor: number;
  /** Ambient intensity (typ. 0.3–0.6). */
  ambientIntensity: number;
  /** Hemisphere sky color (hex). */
  hemiSky: number;
  /** Hemisphere ground color (hex). */
  hemiGround: number;
  /** Hemisphere intensity (typ. 0.5–0.8; clamped to >=0.5). */
  hemiIntensity: number;
  /** Fog color (hex). */
  fogColor: number;
  /** Fog density (typ. 0.005–0.015; clamped to <=0.015). */
  fogDensity: number;
  /** Tone-mapping exposure (typ. 0.8–1.4). */
  exposure: number;
  /** Background color (hex). */
  backgroundColor: number;
  /** Optional accent lights — localized point/spot lights for mood. */
  accentLights?: AccentLight[];
  /** Designer's mood description (informational). */
  mood: string;
}

// ─── Per-map presets (10 distinct moods) ─────────────────────────────────

export const LIGHTING_PRESETS: Record<string, LightingPreset> = {
  // 1. Compound — bright noon, harsh military sun.
  compound: {
    slug: "compound",
    name: "Noon — Harsh Military Sun",
    sunAngle: Math.PI * 0.42,        // ~75° elevation
    sunAzimuth: Math.PI * 1.25,      // SW
    sunColor: 0xffe8c4,
    sunIntensity: 2.2,
    ambientColor: 0x8090a0,
    ambientIntensity: 0.4,
    hemiSky: 0xbfd4e8,
    hemiGround: 0x8a7a5a,
    hemiIntensity: 0.6,
    fogColor: 0xc9b896,
    fogDensity: 0.012,
    exposure: 1.1,
    backgroundColor: 0xc9d8e8,
    mood: "Bright noon — long shadows from perimeter walls; reads as a fortified FOB in daylight.",
  },

  // 2. Warehouse — dusk, warm orange shafts through high windows.
  warehouse: {
    slug: "warehouse",
    name: "Dusk — Warehouse Sodium Glow",
    sunAngle: Math.PI * 0.18,        // ~32° elevation (low)
    sunAzimuth: Math.PI * 0.5,       // east (sun setting in west → low east shafts)
    sunColor: 0xc8d4e0,
    sunIntensity: 1.4,
    ambientColor: 0x504a55,
    ambientIntensity: 0.4,
    hemiSky: 0xa0b0c0,
    hemiGround: 0x6a6a6a,
    hemiIntensity: 0.55,
    fogColor: 0x7a7a8a,
    fogDensity: 0.013,
    exposure: 1.0,
    backgroundColor: 0x4a4a55,
    accentLights: [
      // Sodium-vapor overheads — warm orange pool every ~12m.
      { type: "point", position: [-12, 7, -10], color: 0xff9050, intensity: 1.8, distance: 14 },
      { type: "point", position: [12, 7, 10],   color: 0xff9050, intensity: 1.8, distance: 14 },
      { type: "point", position: [-12, 7, 10],  color: 0xff9050, intensity: 1.8, distance: 14 },
      { type: "point", position: [12, 7, -10],  color: 0xff9050, intensity: 1.8, distance: 14 },
      { type: "point", position: [0, 7, 0],     color: 0xff7840, intensity: 2.0, distance: 16 },
    ],
    mood: "Dusk warehouse — sodium-vapor pools under high bay doors, cold blue fill from windows.",
  },

  // 3. Rooftops — moonlit night, blue-tinted, distant city glow.
  rooftops: {
    slug: "rooftops",
    name: "Night — Moonlit Rooftops",
    sunAngle: Math.PI * 0.55,        // moon high
    sunAzimuth: Math.PI * 1.5,       // SW
    sunColor: 0xb0c4e0,              // cool moonlight
    sunIntensity: 1.6,
    ambientColor: 0x303a55,
    ambientIntensity: 0.35,
    hemiSky: 0x6a5a7a,
    hemiGround: 0x4a3a4a,
    hemiIntensity: 0.55,
    fogColor: 0x5a4a5a,
    fogDensity: 0.014,
    exposure: 0.9,
    backgroundColor: 0x1a1a2a,
    accentLights: [
      // Distant city glow — warm orange point lights at the horizon edge.
      { type: "point", position: [-40, 1, 0],  color: 0xff8040, intensity: 1.2, distance: 30 },
      { type: "point", position: [40, 1, 0],   color: 0xff8040, intensity: 1.2, distance: 30 },
      // Helipad beacon — red blinking (we'll just make it steady red).
      { type: "point", position: [20, 1.5, 20], color: 0xff2020, intensity: 1.5, distance: 12 },
    ],
    mood: "Moonlit night — cool blue fill, distant city glow on the horizon, red helipad beacon.",
  },

  // 4. Desert Outpost — dawn, warm orange, long shadows.
  desert: {
    slug: "desert",
    name: "Dawn — Desert FOB",
    sunAngle: Math.PI * 0.16,        // ~29° elevation (low dawn)
    sunAzimuth: Math.PI * 0.0,       // north
    sunColor: 0xfff2d0,
    sunIntensity: 2.8,
    ambientColor: 0x9080a0,
    ambientIntensity: 0.5,
    hemiSky: 0xe8d8a8,
    hemiGround: 0xc9a868,
    hemiIntensity: 0.65,
    fogColor: 0xe8d8a8,
    fogDensity: 0.008,
    exposure: 1.2,
    backgroundColor: 0xe8c878,
    accentLights: [
      // Comms-tower aviation lights — red beacons at the top.
      { type: "point", position: [-40, 12, -40], color: 0xff2020, intensity: 2.0, distance: 20 },
      { type: "point", position: [40, 12, 40],   color: 0xff2020, intensity: 2.0, distance: 20 },
    ],
    mood: "Dawn desert — long shadows from hesco walls, warm orange sun, red comms-tower beacons.",
  },

  // 5. Urban Alley — overcast, gray, oppressive.
  alley: {
    slug: "alley",
    name: "Overcast — Urban Alley",
    sunAngle: Math.PI * 0.45,
    sunAzimuth: Math.PI * 1.25,
    sunColor: 0xb0a8b0,              // gray overcast
    sunIntensity: 1.3,
    ambientColor: 0x404048,
    ambientIntensity: 0.4,
    hemiSky: 0x7a7a8a,
    hemiGround: 0x4a4a4a,
    hemiIntensity: 0.55,
    fogColor: 0x5a5a6a,
    fogDensity: 0.014,
    exposure: 0.95,
    backgroundColor: 0x5a5a6a,
    accentLights: [
      // Flickering storefront neon — green + magenta.
      { type: "point", position: [-30, 3, -34], color: 0x20ff80, intensity: 1.2, distance: 8 },
      { type: "point", position: [30, 3, -34],  color: 0xff2080, intensity: 1.2, distance: 8 },
      // Streetlamp — warm sodium at the cross intersection.
      { type: "point", position: [0, 6, 0], color: 0xffa050, intensity: 1.5, distance: 12 },
    ],
    mood: "Overcast alley — gray diffuse light, neon storefront signs, sodium streetlamp at the cross.",
  },

  // 6. Training Ground — morning, warm rising sun.
  training: {
    slug: "training",
    name: "Morning — Training Ground",
    sunAngle: Math.PI * 0.25,        // ~45° elevation
    sunAzimuth: Math.PI * 0.25,      // NE (morning sun)
    sunColor: 0xfff8e0,
    sunIntensity: 2.2,
    ambientColor: 0x80a0c0,
    ambientIntensity: 0.45,
    hemiSky: 0xa8c8e8,
    hemiGround: 0x6a8a5a,
    hemiIntensity: 0.55,
    fogColor: 0xb8c8d8,
    fogDensity: 0.010,
    exposure: 1.05,
    backgroundColor: 0xa8c8e8,
    mood: "Morning training ground — warm rising sun, clean sightlines, gentle haze.",
  },

  // 7. Practice Range — bright noon, clear sky (sandbox).
  practice_range: {
    slug: "practice_range",
    name: "Noon — Practice Range (Clear)",
    sunAngle: Math.PI * 0.45,
    sunAzimuth: Math.PI * 0.5,       // east
    sunColor: 0xfff8e0,
    sunIntensity: 2.8,
    ambientColor: 0x90a0b0,
    ambientIntensity: 0.55,
    hemiSky: 0xbfd4e8,
    hemiGround: 0x8a7a5a,
    hemiIntensity: 0.65,
    fogColor: 0xc9d8e8,
    fogDensity: 0.006,
    exposure: 1.15,
    backgroundColor: 0xc9d8e8,
    mood: "Bright noon practice range — flat even lighting for clear target visibility at all ranges.",
  },

  // 8. Bunker — midnight, artificial fluorescent fixtures, green-cast.
  bunker: {
    slug: "bunker",
    name: "Midnight — Bunker Fluorescents",
    sunAngle: Math.PI * 0.5,         // (sun direction is meaningless indoors; use overhead)
    sunAzimuth: 0,
    sunColor: 0x6a7080,              // cool fluorescent (low-intensity "sun" acts as overhead fill)
    sunIntensity: 1.0,
    ambientColor: 0x2a3030,
    ambientIntensity: 0.5,
    hemiSky: 0x6a7080,
    hemiGround: 0x3a3a3a,
    hemiIntensity: 0.55,
    fogColor: 0x2a2a30,
    fogDensity: 0.013,
    exposure: 0.95,
    backgroundColor: 0x1a1a20,
    accentLights: [
      // Fluorescent tube grid — cool green-white pools every ~10m.
      { type: "point", position: [0, 7, 0],    color: 0xc0e0d0, intensity: 2.0, distance: 18 },
      { type: "point", position: [-16, 7, -16], color: 0xc0e0d0, intensity: 1.6, distance: 14 },
      { type: "point", position: [16, 7, 16],   color: 0xc0e0d0, intensity: 1.6, distance: 14 },
      { type: "point", position: [-16, 7, 16],  color: 0xc0e0d0, intensity: 1.6, distance: 14 },
      { type: "point", position: [16, 7, -16],  color: 0xc0e0d0, intensity: 1.6, distance: 14 },
      // Red emergency light at the biohazard quarantine.
      { type: "point", position: [16, 2, -16], color: 0xff2020, intensity: 1.4, distance: 10 },
    ],
    mood: "Underground bunker — green-cast fluorescent grid, red emergency light at the quarantine wing.",
  },

  // 9. Mansion — late afternoon, warm amber through windows.
  mansion: {
    slug: "mansion",
    name: "Late Afternoon — Mansion Amber",
    sunAngle: Math.PI * 0.22,        // ~40° elevation (low afternoon)
    sunAzimuth: Math.PI * 1.25,      // SW
    sunColor: 0xffd0a0,              // warm amber
    sunIntensity: 1.8,
    ambientColor: 0x6a5a4a,
    ambientIntensity: 0.45,
    hemiSky: 0xc8a878,
    hemiGround: 0x6a4a3a,
    hemiIntensity: 0.55,
    fogColor: 0xa87858,
    fogDensity: 0.011,
    exposure: 1.05,
    backgroundColor: 0x6a4a3a,
    accentLights: [
      // Chandelier — warm incandescent at the grand hall.
      { type: "point", position: [0, 4, 0], color: 0xffc060, intensity: 2.2, distance: 16 },
      // Fireplace glow in the parlor (NW corner room).
      { type: "point", position: [-22, 1, -22], color: 0xff6020, intensity: 1.6, distance: 10 },
    ],
    mood: "Late-afternoon mansion — warm amber through tall windows, chandelier + fireplace glow.",
  },

  // 10. Subway — night, fluorescent green-blue, cold.
  subway: {
    slug: "subway",
    name: "Night — Subway Fluorescents",
    sunAngle: Math.PI * 0.5,
    sunAzimuth: 0,
    sunColor: 0x6a78a0,              // cool blue (low overhead fill)
    sunIntensity: 1.0,
    ambientColor: 0x2a2a3a,
    ambientIntensity: 0.5,
    hemiSky: 0x6a78a0,
    hemiGround: 0x3a3a4a,
    hemiIntensity: 0.55,
    fogColor: 0x2a2a3a,
    fogDensity: 0.014,
    exposure: 0.95,
    backgroundColor: 0x1a1a2a,
    accentLights: [
      // Platform fluorescent tubes — cool green-blue.
      { type: "point", position: [-12, 4, -10], color: 0xa0d0e0, intensity: 1.8, distance: 14 },
      { type: "point", position: [12, 4, 10],   color: 0xa0d0e0, intensity: 1.8, distance: 14 },
      { type: "point", position: [-12, 4, 10],  color: 0xa0d0e0, intensity: 1.8, distance: 14 },
      { type: "point", position: [12, 4, -10],  color: 0xa0d0e0, intensity: 1.8, distance: 14 },
      // Concourse overheads — cooler still, 4 corner platforms.
      { type: "point", position: [-20, 4, -10], color: 0x80b0d0, intensity: 1.5, distance: 12 },
      { type: "point", position: [20, 4, 10],   color: 0x80b0d0, intensity: 1.5, distance: 12 },
      { type: "point", position: [-20, 4, 10],  color: 0x80b0d0, intensity: 1.5, distance: 12 },
      { type: "point", position: [20, 4, -10],  color: 0x80b0d0, intensity: 1.5, distance: 12 },
    ],
    mood: "Underground subway — cold green-blue fluorescent platform lights, blue-tinted concourse overheads.",
  },
};

// ─── Public accessors ────────────────────────────────────────────────────

/** Get the lighting preset for a map by slug. Returns null if unknown. */
export function getMapLighting(mapSlug: string): LightingPreset | null {
  return LIGHTING_PRESETS[mapSlug] ?? null;
}

/** Get all 10 lighting presets (for the design dashboard). */
export function getAllLightingPresets(): LightingPreset[] {
  return Object.values(LIGHTING_PRESETS);
}

// ─── Sun-position derivation ─────────────────────────────────────────────

/** Derive the sun position from elevation + azimuth.
 *  Returns a 3-tuple [x, y, z] at the given distance from origin. */
export function sunPositionFromPreset(
  preset: LightingPreset,
  distance: number = 80,
): [number, number, number] {
  // y = distance * sin(elevation)
  // horizontal = distance * cos(elevation)
  // x = horizontal * sin(azimuth)
  // z = -horizontal * cos(azimuth)  (so azimuth=0 → -Z = "north")
  const y = distance * Math.sin(preset.sunAngle);
  const horiz = distance * Math.cos(preset.sunAngle);
  const x = horiz * Math.sin(preset.sunAzimuth);
  const z = -horiz * Math.cos(preset.sunAzimuth);
  return [x, y, z];
}

// ─── Apply preset to the live scene ──────────────────────────────────────

/** Tracked accent lights — the manager owns + disposes them on map switch. */
const activeAccentLights: THREE.Light[] = [];

/** Apply a lighting preset to the live THREE scene. The engine calls this
 *  on map load, after the existing `applyMapLighting` runs (which sets the
 *  sun + hemi + fog from the flat MapLightConfig). This function:
 *   1. Re-sets the sun + hemi from the richer preset (overriding the flat
 *      config), keeping the visibility floor (sun >= 1.0, hemi >= 0.5,
 *      fog density <= 0.015).
 *   2. Adds the preset's ambient light (the flat config doesn't have one).
 *   3. Sets the renderer exposure + scene background.
 *   4. Adds the preset's accent lights as children of the scene.
 *
 *  Call `clearAccentLights()` on map switch (or call `applyLightingPreset`
 *  for the new map — it clears the previous accent lights first). */
export function applyLightingPreset(ctx: GameContext, preset: LightingPreset): void {
  const { scene, renderer } = ctx;

  // ─── 1. Sun ───
  if (ctx.sunLight) {
    ctx.sunLight.color.setHex(preset.sunColor);
    ctx.sunLight.intensity = Math.max(1.0, preset.sunIntensity);
    const [sx, sy, sz] = sunPositionFromPreset(preset, 80);
    ctx.sunLight.position.set(sx, sy, sz);
  }

  // ─── 2. Hemisphere ───
  if (ctx.hemiLight) {
    ctx.hemiLight.color.setHex(preset.hemiSky);
    ctx.hemiLight.groundColor.setHex(preset.hemiGround);
    ctx.hemiLight.intensity = Math.max(0.5, preset.hemiIntensity);
  }

  // ─── 3. Ambient ───
  // Reuse scene children: find any existing AmbientLight, or add one.
  let ambient: THREE.AmbientLight | null = null;
  for (const child of scene.children) {
    if (child instanceof THREE.AmbientLight) { ambient = child; break; }
  }
  if (!ambient) {
    ambient = new THREE.AmbientLight(preset.ambientColor, preset.ambientIntensity);
    ambient.name = "pr_ambient";
    scene.add(ambient);
  } else {
    ambient.color.setHex(preset.ambientColor);
    ambient.intensity = preset.ambientIntensity;
  }

  // ─── 4. Fog ───
  if (scene.fog instanceof THREE.FogExp2) {
    scene.fog.color.setHex(preset.fogColor);
    scene.fog.density = Math.min(0.015, preset.fogDensity);
  } else if (!scene.fog) {
    scene.fog = new THREE.FogExp2(preset.fogColor, Math.min(0.015, preset.fogDensity));
  }

  // ─── 5. Tone-mapping exposure + background ───
  // The renderer's tone mapping is set elsewhere (ACESFilmic typically);
  // we only adjust the exposure here.
  renderer.toneMappingExposure = preset.exposure;
  scene.background = new THREE.Color(preset.backgroundColor);

  // ─── 6. Accent lights ───
  clearAccentLights(scene);
  if (preset.accentLights?.length) {
    for (const spec of preset.accentLights) {
      let light: THREE.Light | null = null;
      if (spec.type === "point") {
        light = new THREE.PointLight(
          spec.color,
          spec.intensity,
          spec.distance ?? 0,
          2, // physical decay = 2 (inverse-square)
        );
      } else if (spec.type === "spot") {
        const spot = new THREE.SpotLight(
          spec.color,
          spec.intensity,
          spec.distance ?? 0,
          spec.angle ?? Math.PI / 6,
          spec.penumbra ?? 0.3,
          2,
        );
        // Aim the spot straight down (typical for overheads).
        spot.target.position.set(spec.position[0], 0, spec.position[2]);
        scene.add(spot.target);
        light = spot;
      }
      if (light) {
        light.position.set(spec.position[0], spec.position[1], spec.position[2]);
        light.name = "pr_accent";
        light.userData.isLightingPassAccent = true;
        scene.add(light);
        activeAccentLights.push(light);
      }
    }
  }
}

/** Remove all accent lights added by `applyLightingPreset`. Called on map
 *  switch (the next preset re-adds its own). */
export function clearAccentLights(scene: THREE.Scene): void {
  // Remove from scene.
  for (let i = activeAccentLights.length - 1; i >= 0; i--) {
    const light = activeAccentLights[i];
    scene.remove(light);
    // Also remove the spot target if present.
    if (light instanceof THREE.SpotLight) {
      scene.remove(light.target);
    }
    light.dispose?.();
    activeAccentLights.splice(i, 1);
  }
  // Defensive sweep — also remove any straggler accent lights (e.g., from a
  // crashed re-apply).
  const toRemove: THREE.Light[] = [];
  for (const child of scene.children) {
    if (child instanceof THREE.Light && child.userData.isLightingPassAccent) {
      toRemove.push(child);
    }
  }
  for (const light of toRemove) {
    scene.remove(light);
    if (light instanceof THREE.SpotLight) scene.remove(light.target);
    light.dispose?.();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// K-5000 prompt mapping (this file owns):
//   #4230 [lighting-pass per-map mood drift] — new
//         `validateLightingMoodDrift()` function compares the lighting
//         preset's `mood` string against the map's declared
//         `MAP_LIGHTING_MOODS` row (from MapsAndModesEnhancements).
//         "Mood drift" is when a map's lighting preset has drifted from
//         its intended mood — e.g., a designer tweaked the sun color to
//         "fix" a brightness issue without realizing they shifted the
//         map from "warm_residential" (3800K) to "cold_industrial"
//         (5500K). The validator flags any preset whose colorTemperature
//         is more than 1000K from the declared mood, OR whose ambient
//         intensity differs from the declared mood by >0.2.
//   #4367 [cross-ref to 4230] — see marker above.
// ────────────────────────────────────────────────────────────────────────────

/** K-5000 #4230 — mood drift audit result. */
export interface LightingMoodDrift {
  /** Map slug. */
  mapSlug: string;
  /** Preset's declared mood (informational). */
  presetMood: string;
  /** Static-table declared mood archetype. */
  declaredMood: string;
  /** Preset's color temperature (K). */
  presetColorTemp: number;
  /** Static-table declared color temperature (K). */
  declaredColorTemp: number;
  /** True iff the drift exceeds the threshold (color temp |Δ| > 1000K
   *  OR ambient intensity |Δ| > 0.2). */
  drift: boolean;
  /** Human-readable drift description (if any). */
  reason?: string;
}

/** K-5000 #4230 — color-temperature thresholds per mood archetype.
 *  Maps the static MAP_LIGHTING_MOODS `mood` enum to a (minK, maxK)
 *  band. Presets outside the band are flagged as drifted. */
const MOOD_COLOR_TEMP_BANDS: Record<string, { minK: number; maxK: number }> = {
  cold_industrial:    { minK: 5000, maxK: 6500 },
  warm_residential:   { minK: 3000, maxK: 4200 },
  lush_natural:       { minK: 5200, maxK: 6500 },
  harsh_desert:       { minK: 6000, maxK: 7000 },
  cool_coastal:       { minK: 6500, maxK: 7500 },
};

/** K-5000 #4230 — validate that each map's lighting preset matches its
 *  declared mood. Caller passes the static MAP_LIGHTING_MOODS table
 *  (from MapsAndModesEnhancements) to avoid a circular import.
 *  Returns one row per map; rows with `drift: true` need a designer
 *  review (either the preset drifted from the mood, or the mood
 *  declaration needs updating to match a deliberate art change). */
export function validateLightingMoodDrift(
  staticMoods: Array<{ mapId: string; mood: string; colorTemperature: number; ambientIntensity: number }>,
): LightingMoodDrift[] {
  const out: LightingMoodDrift[] = [];
  for (const row of staticMoods) {
    const preset = getMapLighting(row.mapId);
    if (!preset) {
      out.push({
        mapSlug: row.mapId,
        presetMood: "(no preset)",
        declaredMood: row.mood,
        presetColorTemp: 0,
        declaredColorTemp: row.colorTemperature,
        drift: true,
        reason: "No lighting preset registered for this map.",
      });
      continue;
    }
    // Derive the preset's color temperature from its sun color (rough
    // approximation: warm sun < 4500K, neutral 4500-5500K, cool > 5500K).
    const sunColor = new THREE.Color(preset.sunColor);
    const r = sunColor.r, g = sunColor.g, b = sunColor.b;
    // Quick RGB→Kelvin approximation (Roberson method, simplified).
    // Warm (r>b) → ~3000K; neutral (r≈g≈b) → ~5500K; cool (b>r) → ~7500K.
    const presetColorTemp = b > r
      ? 5500 + Math.round((b - r) * 4000)
      : 5500 - Math.round((r - b) * 3000);
    const band = MOOD_COLOR_TEMP_BANDS[row.mood];
    const drift = band
      ? presetColorTemp < band.minK || presetColorTemp > band.maxK
      : false;
    out.push({
      mapSlug: row.mapId,
      presetMood: preset.mood,
      declaredMood: row.mood,
      presetColorTemp,
      declaredColorTemp: row.colorTemperature,
      drift,
      reason: drift
        ? `Preset color temp ${presetColorTemp}K is outside the ${row.mood} band (${band?.minK}–${band?.maxK}K). Either the preset drifted or the mood declaration needs updating.`
        : undefined,
    });
  }
  return out;
}
