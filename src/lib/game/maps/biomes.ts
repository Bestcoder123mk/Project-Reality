/**
 * Section M — Biome system.
 *
 * Config-driven biome definitions for the 6 major biome families sampled
 * across the M_Maps_Environments prompt library:
 *
 *   - desert   (sand dunes, FOBs, hesco bastions, harsh sun)
 *   - arctic   (snowdrifts, ice, frozen bunkers, bluish ambient)
 *   - jungle   (dense foliage, monsoon rain, mud, low fog)
 *   - urban    (concrete/asphalt, storefronts, verticality)
 *   - coastal  (sand + water, piers, spray, glare)
 *   - mountain (vertical rock faces, switchbacks, snow caps)
 *
 * Each biome bundles: ground material, sky color keys, fog tuning,
 * weather weights, ambient palette, prop-density bias, and a list of
 * vegetation slugs the vegetation-system knows how to scatter. Biome
 * selection is the single knob a MapDefinition can set via the new
 * optional `biome` field; the engine reads biome defaults at map build
 * time and lets per-map overrides win (per-field basis).
 *
 * Pure TypeScript (no THREE import at module scope) so this is safe to
 * import from SSR / Node / unit tests. The biome → THREE material glue
 * lives in MapBuilder/_shared.ts (MaterialCache) + geometry.ts
 * (createGroundMaterial).
 *
 * K-5000 prompt-mapping:
 *   #M-1002 Author a MapBuilder module for <biome> — covered by BIOMES
 *          registry + MapRegistry expansion (one new map per biome).
 *   #M-2400 Build a destruction graph for <biome> — see destruction.ts.
 *   #M-3500 Implement a weather preset on <biome> map — see weather-maps.ts.
 */

import type { MapLightConfig } from "./MapRegistry";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type BiomeId =
  | "desert"
  | "arctic"
  | "jungle"
  | "urban"
  | "coastal"
  | "mountain";

/** Ground material slug used by createGroundMaterial. Extended in
 *  geometry.ts to support the new biome-specific ground types. */
export type BiomeGroundMaterial =
  | "sand" | "concrete" | "grass" | "asphalt"
  | "snow" | "ice" | "mud" | "jungle_floor"
  | "sand_wet" | "rock" | "gravel";

/** Atmosphere preset — superset of the original MapDefinition.atmosphere
 *  union so existing maps keep working. New biomes introduce the extra
 *  variants (sandstorm, blizzard, monsoon, mist). */
export type BiomeAtmosphere =
  | "clear" | "overcast" | "rain" | "fog" | "dusk" | "night"
  | "sandstorm" | "blizzard" | "monsoon" | "mist" | "coastal_haze";

/** Vegetation slug — must match a builder in vegetation-system.ts. */
export type VegetationSlug =
  | "palm" | "cactus" | "dead_shrub"
  | "pine_snow" | "frost_grass"
  | "banyan" | "fern" | "bamboo" | "orchid"
  | "street_tree" | "hedge" | "ivy"
  | "kelp" | "coconut_palm" | "driftwood"
  | "alpine_pine" | "lichen_rock" | "snow_boulder";

export interface BiomeDefinition {
  id: BiomeId;
  /** Human-readable label for the maps-select screen + design dashboard. */
  label: string;
  /** Ground material slug for createGroundMaterial. */
  groundMaterial: BiomeGroundMaterial;
  /** Default atmosphere preset (can be overridden per-map). */
  defaultAtmosphere: BiomeAtmosphere;
  /** Default lighting block (sun + hemi + fog) — clamped by the floor in
   *  applyMapLighting so visibility never drops below the floor. */
  defaultLighting: MapLightConfig;
  /** Default time-of-day (0..24). Noon for desert glare, dusk for urban,
   *  dawn for arctic, 14:00 for jungle (post-monsoon), 11:00 for coastal,
   *  17:00 for mountain golden hour. */
  defaultTimeOfDay: number;
  /** Vegetation slugs the vegetation-system scatters for this biome.
   *  Each slug resolves to a procedural builder in vegetation-system.ts. */
  vegetation: VegetationSlug[];
  /** Vegetation density multiplier (0 = none, 1 = default, 2+ = dense). */
  vegetationDensity: number;
  /** Weather weights — used by weather-maps.ts to pick a weather preset
   *  for this biome. Each weight is in [0,1]; the preset with the highest
   *  weight*random roll wins. */
  weatherWeights: Record<string, number>;
  /** Recommended prop-density bias (relative to base 1.0). Maps in dense
   *  biomes (jungle, urban) bias up; open biomes (desert, mountain) bias
   *  down. MapRegistry uses this to scale ambient detail scatter. */
  propDensityBias: number;
  /** Sky-color palette keys (lookup in lighting-pass.ts). */
  skyKey: "harsh_desert" | "cold_arctic" | "lush_jungle" | "warm_residential" | "cool_coastal" | "alpine_golden";
  /** Design notes — narrative description for the level-design dashboard. */
  description: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Biome registry
// ──────────────────────────────────────────────────────────────────────────

export const BIOMES: Record<BiomeId, BiomeDefinition> = {
  // ─── Desert ──────────────────────────────────────────────────────────
  desert: {
    id: "desert",
    label: "Desert",
    groundMaterial: "sand",
    defaultAtmosphere: "clear",
    defaultLighting: {
      ambient: 0.55,
      sun: { intensity: 2.8, color: 0xfff2d0, position: [0, 80, 0] },
      hemi: { sky: 0xe8d8a8, ground: 0xc9a868, intensity: 0.65 },
      fog: { color: 0xe8d8a8, density: 0.008 },
    },
    defaultTimeOfDay: 12,
    vegetation: ["palm", "cactus", "dead_shrub"],
    vegetationDensity: 0.25,
    weatherWeights: { clear: 0.6, sandstorm: 0.25, overcast: 0.15 },
    propDensityBias: 0.7,
    skyKey: "harsh_desert",
    description:
      "Sand + hesco FOBs; harsh sun, low ground clutter, long sightlines broken by tents + containers. Sandstorm preset dramatically cuts visibility mid-match.",
  },

  // ─── Arctic ──────────────────────────────────────────────────────────
  arctic: {
    id: "arctic",
    label: "Arctic",
    groundMaterial: "snow",
    defaultAtmosphere: "blizzard",
    defaultLighting: {
      ambient: 0.5,
      sun: { intensity: 1.6, color: 0xc8d8ff, position: [0, 60, -40] },
      hemi: { sky: 0xc8d8f0, ground: 0xe0eaf2, intensity: 0.7 },
      fog: { color: 0xd0dae4, density: 0.013 },
    },
    defaultTimeOfDay: 11,
    vegetation: ["pine_snow", "frost_grass"],
    vegetationDensity: 0.4,
    weatherWeights: { blizzard: 0.45, overcast: 0.3, clear: 0.15, fog: 0.1 },
    propDensityBias: 0.85,
    skyKey: "cold_arctic",
    description:
      "Snow + ice cover; bluish ambient, low contrast, whiteout blizzards reduce engagement ranges. Frozen bunkers + hesco walls provide cover; footprints + blood trails are highly visible on snow.",
  },

  // ─── Jungle ──────────────────────────────────────────────────────────
  jungle: {
    id: "jungle",
    label: "Jungle",
    groundMaterial: "mud",
    defaultAtmosphere: "monsoon",
    defaultLighting: {
      ambient: 0.45,
      sun: { intensity: 1.2, color: 0xa8c878, position: [20, 60, 20] },
      hemi: { sky: 0x6a8a5a, ground: 0x3a4a2a, intensity: 0.6 },
      fog: { color: 0x5a7a4a, density: 0.015 },
    },
    defaultTimeOfDay: 14,
    vegetation: ["banyan", "fern", "bamboo", "orchid"],
    vegetationDensity: 1.5,
    weatherWeights: { monsoon: 0.45, rain: 0.3, mist: 0.2, clear: 0.05 },
    propDensityBias: 1.25,
    skyKey: "lush_jungle",
    description:
      "Dense foliage + mud ground; monsoon rain reduces audio propagation + creates puddles. Vertical play through canopy + banyan roots; ferns provide low concealment (no full cover).",
  },

  // ─── Urban ───────────────────────────────────────────────────────────
  urban: {
    id: "urban",
    label: "Urban",
    groundMaterial: "asphalt",
    defaultAtmosphere: "overcast",
    defaultLighting: {
      ambient: 0.45,
      sun: { intensity: 1.4, color: 0xb8b0b8, position: [-40, 60, -30] },
      hemi: { sky: 0x7a7a8a, ground: 0x4a4a4a, intensity: 0.6 },
      fog: { color: 0x5a5a6a, density: 0.014 },
    },
    defaultTimeOfDay: 14,
    vegetation: ["street_tree", "hedge", "ivy"],
    vegetationDensity: 0.3,
    weatherWeights: { overcast: 0.4, clear: 0.3, rain: 0.2, dusk: 0.1 },
    propDensityBias: 1.4,
    skyKey: "warm_residential",
    description:
      "Asphalt streets + brick storefronts; verticality via rooftops + multi-story interiors. Dumpsters + cars provide cover; phone booths + street trees are thin cover. Dusk variant plays warm amber through windows.",
  },

  // ─── Coastal ─────────────────────────────────────────────────────────
  coastal: {
    id: "coastal",
    label: "Coastal",
    groundMaterial: "sand_wet",
    defaultAtmosphere: "coastal_haze",
    defaultLighting: {
      ambient: 0.55,
      sun: { intensity: 2.2, color: 0xffe8c4, position: [40, 60, -40] },
      hemi: { sky: 0xa8c8d8, ground: 0xc8b888, intensity: 0.7 },
      fog: { color: 0xc8d8e0, density: 0.010 },
    },
    defaultTimeOfDay: 11,
    vegetation: ["coconut_palm", "driftwood", "kelp"],
    vegetationDensity: 0.5,
    weatherWeights: { coastal_haze: 0.4, clear: 0.3, overcast: 0.2, fog: 0.1 },
    propDensityBias: 0.9,
    skyKey: "cool_coastal",
    description:
      "Wet sand + water edges; piers + buoys define lanes. Coastal haze softens long sightlines; spray reduces audio clarity near water. Kelp clusters conceal submerged movement (underwater section).",
  },

  // ─── Mountain ────────────────────────────────────────────────────────
  mountain: {
    id: "mountain",
    label: "Mountain",
    groundMaterial: "rock",
    defaultAtmosphere: "clear",
    defaultLighting: {
      ambient: 0.5,
      sun: { intensity: 2.0, color: 0xffd8a8, position: [-50, 80, 30] },
      hemi: { sky: 0xa8b8c8, ground: 0x6a5a4a, intensity: 0.6 },
      fog: { color: 0x9aa8b8, density: 0.012 },
    },
    defaultTimeOfDay: 17,
    vegetation: ["alpine_pine", "lichen_rock", "snow_boulder"],
    vegetationDensity: 0.35,
    weatherWeights: { clear: 0.4, overcast: 0.3, blizzard: 0.2, fog: 0.1 },
    propDensityBias: 0.8,
    skyKey: "alpine_golden",
    description:
      "Vertical rock faces + switchbacks; multi-tier combat with switchback lanes. Alpine pines provide sparse cover; lichen rocks + snow boulders are sightline-breakers. Golden hour lighting favors long-range duels.",
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Accessors
// ──────────────────────────────────────────────────────────────────────────

/** Get a biome definition by id. Returns the urban biome as a safe
 *  default if the id is unknown (matches the original Compound fallback). */
export function getBiome(id: BiomeId | string | undefined): BiomeDefinition {
  if (id && id in BIOMES) return BIOMES[id as BiomeId];
  return BIOMES.urban;
}

/** List all biomes (for the maps-select screen / design dashboard). */
export function listBiomes(): BiomeDefinition[] {
  return Object.values(BIOMES);
}

/** Merge a biome's default lighting with per-map overrides. Per-map
 *  fields win; biome defaults fill the gaps. Used by the MapBuilder when
 *  a map declares `biome: "jungle"` but provides its own sun color etc.
 *
 *  Pure function — exported for tests. */
export function mergeBiomeLighting(
  biome: BiomeDefinition,
  override?: Partial<MapLightConfig>,
): MapLightConfig {
  const base = biome.defaultLighting;
  if (!override) return base;
  return {
    ambient: override.ambient ?? base.ambient,
    sun: { ...base.sun, ...override.sun },
    hemi: { ...base.hemi, ...override.hemi },
    fog: { ...base.fog, ...override.fog },
  };
}

/** Resolve the effective biome for a MapDefinition. If the map doesn't
 *  declare a biome, infer one from the ground material (sand→desert,
 *  grass→jungle-ish, etc.) so existing maps still benefit from biome
 *  hooks (vegetation, weather weights) without needing a data migration.
 *
 *  Pure function — exported for tests. */
export function resolveBiome(
  declared: BiomeId | string | undefined,
  groundMaterial: string,
): BiomeDefinition {
  if (declared && declared in BIOMES) return BIOMES[declared as BiomeId];
  // Infer from ground material.
  switch (groundMaterial) {
    case "sand": return BIOMES.desert;
    case "grass": return BIOMES.jungle; // closest match for organic ground
    case "asphalt": return BIOMES.urban;
    case "concrete": return BIOMES.urban;
    case "snow": case "ice": return BIOMES.arctic;
    case "mud": case "jungle_floor": return BIOMES.jungle;
    case "sand_wet": return BIOMES.coastal;
    case "rock": case "gravel": return BIOMES.mountain;
    default: return BIOMES.urban;
  }
}
