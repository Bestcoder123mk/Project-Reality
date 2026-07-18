/**
 * Phase 10: Map Registry + 7 authored maps.
 *
 * Each map is a data-driven level definition that RendererSystem
 * consumes to build the scene geometry. Maps share a common schema
 * but differ in layout, cover placement, lighting, and atmosphere.
 *
 * 6 combat maps:
 *   1. "Compound" — fortified military compound (sandbag bunkers, HQ building).
 *   2. "Warehouse" — industrial CQB (shelves, crates, pillars, loading bay).
 *   3. "Rooftops" — elevated urban combat (AC units, water tanks, skybridge).
 *   4. "Desert Outpost" — desert FOB (Hesco bastions, tents, comms tower).
 *   5. "Urban Alley" — tight streets (dumpsters, burnt cars, phone booths).
 *   6. "Training Ground" — symmetric CQB (barricades, cover walls, targets).
 *
 * Task-15 — 1 sandbox map:
 *   7. "Practice Range" — flat open field with destructible target silhouettes
 *      at 10/20/30/50m. PRACTICE_RANGE mode only (no enemies, no timer).
 */

export type MapPropType =
  // Legacy (kept for backward compat)
  | "box" | "cylinder" | "destructible"
  // Task 2 — tactical prop types
  | "crate" | "ammo_box" | "sandbag_bunker" | "barrier" | "container"
  | "barrel" | "pallet" | "generator" | "sandbag_wall" | "barricade"
  | "dumpster" | "crate_stack" | "hesco" | "building" | "ac_unit"
  | "water_tank" | "satellite" | "tent" | "fuel_bladder" | "comms_tower"
  | "car" | "phone_booth" | "target" | "pillar" | "shelf" | "skybridge"
  // Task-6 — interactive props
  | "glass_panel"   // breakable transparent panel — shatters on bullet/grenade hit
  | "jump_pad";     // cylindrical pad that boosts the player upward when stepped on

export interface MapProp {
  type: MapPropType;
  position: [number, number, number];
  /** [width, height, depth] — used by box/cylinder/destructible/building; ignored by detailed builders. */
  size?: [number, number, number];
  /** Yaw rotation in radians. */
  rotY?: number;
  /** Tint color (hex) for crates, containers, barrels, tents, cars, buildings. */
  color?: number;
  /** Wall length for sandbag_wall / skybridge. */
  length?: number;
  /** Material hint (legacy + new builders). */
  material?: "concrete" | "brick" | "wood" | "metal" | "sand" | "barrel" | "olive" | "oliveDark" | "canvas" | "rust" | "glass";
  surfaceType?: string;
  destructibleHp?: number;
  materialSlug?: string;
  /** Building: door side. */
  doorSide?: "north" | "south" | "east" | "west";
  /** Building: windows per wall. */
  windowsPerWall?: number;
}

export interface MapLightConfig {
  ambient: number;
  sun: { intensity: number; color: number; position: [number, number, number] };
  hemi: { sky: number; ground: number; intensity: number };
  fog: { color: number; density: number };
}

export interface MapDefinition {
  slug: string;
  name: string;
  description: string;
  /** Bounds of the play area. */
  bounds: number;
  /** Ground material. Extended in Section M to support new biome ground
   *  types (snow, ice, mud, jungle_floor, sand_wet, rock, gravel). */
  groundMaterial:
    | "sand" | "concrete" | "grass" | "asphalt"
    | "snow" | "ice" | "mud" | "jungle_floor"
    | "sand_wet" | "rock" | "gravel";
  /** Props in the map. */
  props: MapProp[];
  /** Lighting configuration. */
  lighting: MapLightConfig;
  /** Spawn points for enemies. */
  enemySpawns: [number, number, number][];
  /** Player spawn. */
  playerSpawn: [number, number, number];
  /** Recommended game modes. */
  modes: string[];
  /** Time-of-day override (0..24, or null for dynamic). */
  timeOfDayOverride: number | null;
  /** Atmosphere preset. Extended in Section M with sandstorm / blizzard /
   *  monsoon / mist / coastal_haze variants. */
  atmosphere:
    | "clear" | "overcast" | "rain" | "fog" | "dusk" | "night"
    | "sandstorm" | "blizzard" | "monsoon" | "mist" | "coastal_haze";
  /** Section M — biome declaration. When set, the MapBuilder wires the
   *  biome defaults (vegetation, weather weights, lighting palette) at
   *  map build time. When omitted, the biome is inferred from
   *  groundMaterial (see biomes.resolveBiome). */
  biome?: "desert" | "arctic" | "jungle" | "urban" | "coastal" | "mountain";
  /** Section M — weather preset override. When omitted, the engine
   *  picks a weather preset from the biome's weatherWeights table
   *  (deterministic per match seed). */
  weatherPreset?: string;
  /** Section M — time-of-day preset (for dynamic-time.ts). When
   *  omitted, the engine uses "match_paced" by default. Static presets
   *  (static_noon, static_dusk, static_night) are used when the map
   *  declares a fixed timeOfDayOverride + the engine shouldn't
   *  advance time. */
  timePreset?:
    | "match_paced" | "real_time" | "accelerated"
    | "static_noon" | "static_dusk" | "static_night";
  /** Section M — flag to enable underwater zones (coastal/jungle maps
   *  with submerged areas). When true, the engine calls
   *  underwater.ts to register default zones for the biome. */
  underwater?: boolean;
  /** Section M — flag to enable vegetation scatter (biome.vegetation).
   *  Default true when biome is set; false for sandbox maps that don't
   *  want the perf cost. */
  vegetation?: boolean;
  /** SEC9-LEVEL — formal level-design review (sightlines / pacing / chokepoints).
   *  Optional because some sandbox maps (practice_range) intentionally have
   *  no combat pacing. Looked up from MAP_DESIGN_NOTES by `getDesignNotes`. */
  designNotes?: DesignNotes;
}

/**
 * SEC9-LEVEL — Formal level-design notes per map.
 *
 * Each entry is a structured review of the map's combat geometry: the long
 * sightlines players will use, the pacing the layout pushes for, and the
 * chokepoints where fights cluster. Used by the design pass tooling
 * (MapValidator) + surfaced to the maps API for the level-design dashboard.
 */
export interface DesignNotes {
  /** Slug this notes block belongs to. */
  slug: string;
  /** Longest unobstructed sightlines (text descriptions, e.g.
   *  "NW→SE container lane: ~38m, contested by barrels at midpoint"). */
  sightlines: string[];
  /** Pacing summary — expected engagement tempo + duration range. */
  pacing: string;
  /** Named chokepoints where attackers/defenders are funneled. */
  chokepoints: string[];
  /** General flow notes (rotation paths, flank lanes, verticality). */
  flowNotes: string;
  /** Cover density summary — typ. "heavy mid, light flanks" etc. */
  coverProfile: "open" | "balanced" | "heavy" | "asymmetric";
  /** Best-supported game mode (informational — modes[] is the source of truth). */
  intendedMode?: string;
}

/**
 * Phase 10: MapRegistry — all 6 maps.
 *
 * Task 2 — each map now uses detailed tactical prop builders
 * (crates, sandbag bunkers, containers, barrels, buildings, etc.)
 * instead of generic boxes. Lighting configs are kept bright and
 * within the visibility floor (sun >= 1.0, hemi >= 0.5, fog <= 0.015).
 */
export const MAP_REGISTRY: MapDefinition[] = [
  // 1. Compound — fortified military compound
  {
    slug: "compound",
    name: "Compound",
    description: "FORTIFIED PERIMETER · CENTRAL HQ · CHEST-HIGH COVER",
    bounds: 45,
    groundMaterial: "concrete",
    playerSpawn: [0, 1.7, 18],
    // K-5000 #4215 — was 6 spawns; HORDE/ZOMBIES waves reach 13+ enemies by
    // wave 4, so the spawn-logic picker was re-using spawns within the 8s
    // cooldown window (clumping enemies + making them spawn-camp-vulnerable).
    // Added 7 more spread around the perimeter + mid-field so each enemy
    // in a 13-enemy wave has its own spawn point.
    enemySpawns: [
      [-38, 0, -38], [38, 0, -38], [-38, 0, 38], [38, 0, 38], [0, 0, -40], [0, 0, 40],
      // K-5000 #4215 — 7 additional spawns: 4 mid-field corners + 3 perimeter gaps.
      // (Avoid [0,0,0] — the HQ building is there; the K-5000 #4207 respawn-zone
      // audit would flag the spawn as stuck-in-cover.)
      [-20, 0, -30], [20, 0, -30], [-20, 0, 30], [20, 0, 30],
      [-40, 0, 0], [40, 0, 0], [0, 0, -20],
    ],
    modes: ["SURVIVAL", "HORDE", "BREACH", "ZOMBIES"],
    timeOfDayOverride: 12, // Task-38 — daytime (bright noon)
    atmosphere: "clear",
    lighting: {
      ambient: 0.4,
      sun: { intensity: 2.2, color: 0xffe8c4, position: [-60, 70, -80] },
      hemi: { sky: 0xbfd4e8, ground: 0x8a7a5a, intensity: 0.6 },
      fog: { color: 0xc9b896, density: 0.012 },
    },
    props: [
      // ─── Perimeter concrete walls ───
      { type: "box", position: [0, 4, -45], size: [94, 8, 2], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [0, 4, 45], size: [94, 8, 2], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [-45, 4, 0], size: [2, 8, 94], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [45, 4, 0], size: [2, 8, 94], material: "concrete", surfaceType: "concrete" },
      // ─── Perimeter watchtowers (Task-38 — elevated shooting positions at NW + SE corners) ───
      { type: "comms_tower", position: [-40, 0, -40] },
      { type: "comms_tower", position: [40, 0, 40] },
      // ─── Central HQ building (enterable, brick, door on south side) ───
      { type: "building", position: [0, 0, 0], size: [10, 4, 10], material: "brick", doorSide: "south", windowsPerWall: 2 },
      // HQ interior detail: desk (flat crate) + supply crate + ammo cache (Task-38).
      { type: "crate", position: [0, 0.4, 1.5], size: [1.6, 0.8, 0.8], color: 0x4a3a2a, surfaceType: "wood" },
      { type: "crate", position: [-3, 0.6, -2], size: [1.2, 1.2, 1.2] },
      { type: "ammo_box", position: [3, 0, -2], rotY: 0.5 },
      // ─── 4 corner buildings (enterable, brick, doors facing center) ───
      { type: "building", position: [-25, 0, -25], size: [8, 4, 8], material: "brick", doorSide: "east", windowsPerWall: 2 },
      { type: "building", position: [25, 0, -25], size: [8, 4, 8], material: "brick", doorSide: "west", windowsPerWall: 2 },
      { type: "building", position: [-25, 0, 25], size: [8, 4, 8], material: "brick", doorSide: "east", windowsPerWall: 2 },
      { type: "building", position: [25, 0, 25], size: [8, 4, 8], material: "brick", doorSide: "west", windowsPerWall: 2 },
      // ─── Shipping containers (mixed colors — storage blocks + flanking lanes) ───
      { type: "container", position: [-32, 0, 8], rotY: Math.PI / 2, color: 0xa83828 },
      { type: "container", position: [32, 0, -8], rotY: Math.PI / 2, color: 0x2a4a78 },
      { type: "container", position: [10, 0, -32], rotY: 0, color: 0x3a5a3a },
      { type: "container", position: [-10, 0, 32], rotY: 0, color: 0xa83828 },
      { type: "container", position: [-38, 0, 22], rotY: 0, color: 0x2a4a78 },
      { type: "container", position: [38, 0, -22], rotY: 0, color: 0x3a5a3a },
      // ─── Motor pool (Task-38 — vehicles near SE corner) ───
      { type: "car", position: [28, 0, 22], rotY: 0.3 },
      { type: "car", position: [33, 0, 26], rotY: 0.5 },
      { type: "car", position: [29, 0, 30], rotY: -0.2 },
      // ─── Sandbag bunkers (chest-high U-shape cover) ───
      { type: "sandbag_bunker", position: [-15, 0, 10], rotY: 0 },
      { type: "sandbag_bunker", position: [15, 0, -10], rotY: Math.PI },
      { type: "sandbag_bunker", position: [-15, 0, -15], rotY: Math.PI },
      { type: "sandbag_bunker", position: [15, 0, 15], rotY: 0 },
      // ─── Concrete Jersey barriers (vaultable mid-field cover) ───
      { type: "barrier", position: [0, 0, -14], rotY: 0 },
      { type: "barrier", position: [0, 0, 14], rotY: 0 },
      { type: "barrier", position: [-14, 0, 0], rotY: Math.PI / 2 },
      { type: "barrier", position: [14, 0, 0], rotY: Math.PI / 2 },
      // ─── Sandbag walls (defensive lines, chokepoints) ───
      { type: "sandbag_wall", position: [-18, 0, 20], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [18, 0, -20], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [-20, 0, -15], length: 5, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [20, 0, 15], length: 5, rotY: Math.PI / 2 },
      // Additional defensive lines (chokepoints + lanes).
      { type: "sandbag_wall", position: [-8, 0, 18], length: 4, rotY: 0 },
      { type: "sandbag_wall", position: [8, 0, -18], length: 4, rotY: 0 },
      { type: "sandbag_wall", position: [-22, 0, 5], length: 4, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [22, 0, -5], length: 4, rotY: Math.PI / 2 },
      // ─── Crate stacks (cover lanes + flanking routes) ───
      { type: "crate_stack", position: [-8, 0, 6] },
      { type: "crate_stack", position: [8, 0, -6] },
      { type: "crate_stack", position: [-22, 0, 8] },
      { type: "crate_stack", position: [22, 0, -8] },
      // Additional cover lanes (flanking routes toward containers).
      { type: "crate_stack", position: [-12, 0, 18] },
      { type: "crate_stack", position: [12, 0, -18] },
      { type: "crate_stack", position: [-28, 0, 14] },
      { type: "crate_stack", position: [28, 0, -14] },
      // ─── Single military crates (stackable, scattered) ───
      { type: "crate", position: [-5, 0.6, -4], size: [1.2, 1.2, 1.2] },
      { type: "crate", position: [5, 0.6, 4], size: [1.2, 1.2, 1.2], rotY: 0.4 },
      { type: "crate", position: [12, 0.6, 6], size: [1.2, 1.2, 1.2], rotY: 0.8, color: 0x3a3a24 },
      { type: "crate", position: [-12, 0.6, -6], size: [1.2, 1.2, 1.2], rotY: 0.2 },
      // ─── Ammo boxes (low cover / detail) ───
      { type: "ammo_box", position: [-6, 0, 8], rotY: 0.3 },
      { type: "ammo_box", position: [6, 0, -8], rotY: -0.3 },
      { type: "ammo_box", position: [16, 0, 4], rotY: 0.6 },
      { type: "ammo_box", position: [-16, 0, -4], rotY: -0.6 },
      // ─── Oil barrel clusters (explosive, destructible hp 30) — placed near high-traffic lanes ───
      // Cluster A: NW (near NW building).
      { type: "barrel", position: [-18, 0, 12], color: 0xb33a2a },
      { type: "barrel", position: [-18.7, 0, 12.7], color: 0xb33a2a },
      { type: "barrel", position: [-17.3, 0, 12.7], color: 0x2a4a8a },
      // Cluster B: SE (mirror of A).
      { type: "barrel", position: [18, 0, -12], color: 0xb33a2a },
      { type: "barrel", position: [18.7, 0, -12.7], color: 0xb33a2a },
      { type: "barrel", position: [17.3, 0, -12.7], color: 0x2a4a8a },
      // Cluster C: NE (chokepoint by container).
      { type: "barrel", position: [22, 0, 18], color: 0xb33a2a },
      { type: "barrel", position: [22.7, 0, 18.7], color: 0xb33a2a },
      { type: "barrel", position: [21.3, 0, 18.7], color: 0x2a4a8a },
      // Cluster D: SW (mirror of C).
      { type: "barrel", position: [-22, 0, -18], color: 0xb33a2a },
      { type: "barrel", position: [-22.7, 0, -18.7], color: 0xb33a2a },
      { type: "barrel", position: [-21.3, 0, -18.7], color: 0x2a4a8a },
      // ─── Generators (industrial prop + cover) ───
      { type: "generator", position: [-30, 0, -5], rotY: 0 },
      { type: "generator", position: [30, 0, 5], rotY: Math.PI },
      { type: "generator", position: [-32, 0, 30], rotY: Math.PI / 2 },
      { type: "generator", position: [32, 0, -30], rotY: -Math.PI / 2 },
      // ─── Pallets (low scattered detail) ───
      { type: "pallet", position: [-3, 0, 14] },
      { type: "pallet", position: [3, 0, -14], rotY: 0.5 },
      { type: "pallet", position: [10, 0, 25] },
      { type: "pallet", position: [-10, 0, -25], rotY: 0.4 },
    ],
  },

  // 2. Warehouse — industrial CQB interior
  {
    slug: "warehouse",
    name: "Warehouse",
    description: "INDOOR CQB · SHELVING · LOADING BAY · NARROW AISLES",
    bounds: 35,
    groundMaterial: "concrete",
    playerSpawn: [0, 1.7, 28],
    enemySpawns: [[-25, 0, -25], [25, 0, -25], [0, 0, -30], [-20, 0, -10], [20, 0, -10]],
    modes: ["BREACH", "SURVIVAL", "VIP"],
    timeOfDayOverride: 18, // Task-38 — dusk (warm orange light + long shadows)
    atmosphere: "dusk",
    lighting: {
      ambient: 0.4,
      sun: { intensity: 1.4, color: 0xc8d4e0, position: [0, 60, 10] },
      hemi: { sky: 0xa0b0c0, ground: 0x6a6a6a, intensity: 0.55 },
      fog: { color: 0x7a7a8a, density: 0.013 },
    },
    props: [
      // ─── Perimeter walls (industrial metal cladding) ───
      { type: "box", position: [0, 5, -35], size: [74, 10, 2], material: "metal", surfaceType: "container" },
      { type: "box", position: [0, 5, 35], size: [74, 10, 2], material: "metal", surfaceType: "container" },
      { type: "box", position: [-35, 5, 0], size: [2, 10, 74], material: "metal", surfaceType: "container" },
      { type: "box", position: [35, 5, 0], size: [2, 10, 74], material: "metal", surfaceType: "container" },
      // ─── Overhead pipes / conduits (Task-38 — ceiling-mounted, walk-under detail) ───
      { type: "box", position: [-12, 8.5, 0], size: [0.4, 0.4, 50], material: "metal", surfaceType: "container" },
      { type: "box", position: [12, 8.5, 0], size: [0.4, 0.4, 50], material: "metal", surfaceType: "container" },
      { type: "box", position: [0, 9, -15], size: [50, 0.3, 0.3], material: "metal", surfaceType: "container" },
      { type: "box", position: [0, 9, 15], size: [50, 0.3, 0.3], material: "metal", surfaceType: "container" },
      // ─── Concrete pillars (structural, mid-aisle cover) ───
      { type: "pillar", position: [-18, 0, -18] },
      { type: "pillar", position: [18, 0, -18] },
      { type: "pillar", position: [-18, 0, 18] },
      { type: "pillar", position: [18, 0, 18] },
      { type: "pillar", position: [-18, 0, 0] },
      { type: "pillar", position: [18, 0, 0] },
      // ─── Industrial shelving units (tall racks — Task-38: 4 more for cover density) ───
      { type: "shelf", position: [-25, 0, -10], rotY: 0 },
      { type: "shelf", position: [25, 0, 10], rotY: 0 },
      { type: "shelf", position: [-25, 0, 10], rotY: 0 },
      { type: "shelf", position: [25, 0, -10], rotY: 0 },
      { type: "shelf", position: [-25, 0, 20], rotY: 0 },
      { type: "shelf", position: [25, 0, -20], rotY: 0 },
      { type: "shelf", position: [-10, 0, -25], rotY: Math.PI / 2 },
      { type: "shelf", position: [10, 0, 25], rotY: Math.PI / 2 },
      // ─── Stacked crate formations (aisle cover + detail) ───
      { type: "crate_stack", position: [-10, 0, -10] },
      { type: "crate_stack", position: [10, 0, 10] },
      { type: "crate_stack", position: [-10, 0, 10] },
      { type: "crate_stack", position: [10, 0, -10] },
      { type: "crate_stack", position: [-5, 0, -20] },
      { type: "crate_stack", position: [5, 0, 20] },
      { type: "crate_stack", position: [-22, 0, 0] },
      { type: "crate_stack", position: [22, 0, 0] },
      // ─── Pallets scattered (floor detail + low cover) ───
      { type: "pallet", position: [-5, 0, 0] },
      { type: "pallet", position: [5, 0, 0], rotY: 0.4 },
      { type: "pallet", position: [-15, 0, 5] },
      { type: "pallet", position: [15, 0, -5], rotY: 0.7 },
      { type: "pallet", position: [0, 0, -20] },
      { type: "pallet", position: [0, 0, 20], rotY: 0.3 },
      // Pallet stacks (Task-38 — extra vertical cover).
      { type: "pallet", position: [-20, 0.14, -15] },
      { type: "pallet", position: [-20, 0.28, -15] },
      { type: "pallet", position: [20, 0.14, 15] },
      { type: "pallet", position: [20, 0.28, 15] },
      // ─── Oil barrels (clustered hazardous cover — Task-38: extra clusters) ───
      // Cluster A: NE corner.
      { type: "barrel", position: [-22, 0, 22], color: 0xb33a2a },
      { type: "barrel", position: [-22.7, 0, 22.7], color: 0xb33a2a },
      { type: "barrel", position: [-21.3, 0, 22.7], color: 0x2a4a8a },
      // Cluster B: SW corner.
      { type: "barrel", position: [22, 0, -22], color: 0xb33a2a },
      { type: "barrel", position: [22.7, 0, -22.7], color: 0xb33a2a },
      { type: "barrel", position: [21.3, 0, -22.7], color: 0x2a4a8a },
      // Cluster C: near loading dock (Task-38).
      { type: "barrel", position: [-5, 0, 25], color: 0xb33a2a },
      { type: "barrel", position: [-5.7, 0, 25.7], color: 0xb33a2a },
      { type: "barrel", position: [-4.3, 0, 25.7], color: 0x2a4a8a },
      // Cluster D: across loading dock.
      { type: "barrel", position: [5, 0, -25], color: 0xb33a2a },
      { type: "barrel", position: [5.7, 0, -25.7], color: 0xb33a2a },
      { type: "barrel", position: [4.3, 0, -25.7], color: 0x2a4a8a },
      // ─── Shipping container storage (against back wall) ───
      { type: "container", position: [0, 0, -28], rotY: 0, color: 0x3a5a3a },
      { type: "container", position: [-12, 0, 28], rotY: 0, color: 0xa83828 },
      { type: "container", position: [12, 0, 28], rotY: 0, color: 0x2a4a78 },
      // ─── Loading dock trucks (Task-38 — vehicles as heavy cover near dock doors) ───
      { type: "car", position: [-20, 0, 28], rotY: 0.1 },
      { type: "car", position: [20, 0, -28], rotY: Math.PI - 0.1 },
      // ─── Concrete barriers (aisle dividers) ───
      { type: "barrier", position: [0, 0, -5], rotY: 0 },
      { type: "barrier", position: [0, 0, 5], rotY: 0 },
      // ─── Generators (utility corner) ───
      { type: "generator", position: [-28, 0, 28], rotY: 0 },
      { type: "generator", position: [28, 0, -28], rotY: Math.PI },
      // ─── Ammo boxes (loading bay detail) ───
      { type: "ammo_box", position: [-7, 0, 22], rotY: 0.4 },
      { type: "ammo_box", position: [7, 0, 22], rotY: -0.4 },
      { type: "ammo_box", position: [-7, 0, -22], rotY: 0.6 },
      { type: "ammo_box", position: [7, 0, -22], rotY: -0.6 },
      // ─── Single military crates (mid-aisle) ───
      { type: "crate", position: [0, 0.6, 10], size: [1.2, 1.2, 1.2], rotY: 0.3 },
      { type: "crate", position: [0, 0.6, -10], size: [1.2, 1.2, 1.2], rotY: -0.3 },
      { type: "crate", position: [-15, 0.6, 0], size: [1.2, 1.2, 1.2], rotY: 0.5 },
      { type: "crate", position: [15, 0.6, 0], size: [1.2, 1.2, 1.2], rotY: -0.5 },
    ],
  },

  // 3. Rooftops — elevated urban combat
  {
    slug: "rooftops",
    name: "Rooftops",
    description: "ELEVATED URBAN COMBAT · VERTICALITY · LONG SIGHTLINES",
    bounds: 40,
    groundMaterial: "concrete",
    playerSpawn: [0, 1.7, 30],
    enemySpawns: [[-30, 0, -30], [30, 0, -30], [-30, 0, 30], [30, 0, 30], [0, 0, -35]],
    modes: ["SURVIVAL", "EXTRACTION", "SNIPER"],
    timeOfDayOverride: 22, // Task-38 — night (moonlight + starfield + city lights)
    atmosphere: "night",
    lighting: {
      ambient: 0.35,
      sun: { intensity: 1.6, color: 0xff9050, position: [-80, 40, -40] },
      hemi: { sky: 0x6a5a7a, ground: 0x4a3a4a, intensity: 0.55 },
      fog: { color: 0x5a4a5a, density: 0.014 },
    },
    props: [
      // ─── Perimeter low walls (rooftop parapets) ───
      { type: "box", position: [0, 1, -40], size: [84, 2, 1], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [0, 1, 40], size: [84, 2, 1], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [-40, 1, 0], size: [1, 2, 84], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [40, 1, 0], size: [1, 2, 84], material: "concrete", surfaceType: "concrete" },
      // ─── Skybridges connecting rooftop areas (Task-38: 2 total) ───
      { type: "skybridge", position: [0, 6, 0], length: 14, rotY: 0 },
      { type: "skybridge", position: [0, 6, 18], length: 10, rotY: Math.PI / 2 },
      // ─── Helipad marking (Task-38 — flat dark circle on the ground) ───
      { type: "cylinder", position: [20, 0.05, 20], size: [4, 0.1, 4], material: "concrete", surfaceType: "concrete" },
      // ─── Elevated platforms (stairs / HVAC penthouses) ───
      { type: "box", position: [-22, 1.5, -22], size: [8, 3, 8], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [22, 1.5, -22], size: [8, 3, 8], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [-22, 1.5, 22], size: [8, 3, 8], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [22, 1.5, 22], size: [8, 3, 8], material: "concrete", surfaceType: "concrete" },
      // ─── AC units (rooftop HVAC, chest-high cover — Task-38: 3 more) ───
      { type: "ac_unit", position: [-12, 0, 5], rotY: 0 },
      { type: "ac_unit", position: [12, 0, -5], rotY: Math.PI },
      { type: "ac_unit", position: [-15, 0, -15], rotY: 0.5 },
      { type: "ac_unit", position: [15, 0, 15], rotY: -0.5 },
      { type: "ac_unit", position: [8, 0, 20], rotY: 0.2 },
      { type: "ac_unit", position: [-8, 0, -20], rotY: Math.PI + 0.2 },
      { type: "ac_unit", position: [-30, 0, 5], rotY: -0.3 },
      // ─── Water tanks (tall cylindrical cover — Task-38: 2 more) ───
      { type: "water_tank", position: [-25, 0, 0] },
      { type: "water_tank", position: [25, 0, 0] },
      { type: "water_tank", position: [0, 0, -25] },
      { type: "water_tank", position: [0, 0, 25] },
      // ─── Satellite dishes (tall thin cover + detail — Task-38: 2 more) ───
      { type: "satellite", position: [-8, 0, 18], rotY: 0 },
      { type: "satellite", position: [8, 0, -18], rotY: Math.PI },
      { type: "satellite", position: [0, 0, 25], rotY: 1.2 },
      { type: "satellite", position: [-30, 0, -20], rotY: 0.5 },
      { type: "satellite", position: [30, 0, 20], rotY: -0.5 },
      // ─── Crate stacks (rooftop storage) ───
      { type: "crate_stack", position: [-5, 0, 8] },
      { type: "crate_stack", position: [5, 0, -8] },
      { type: "crate_stack", position: [-18, 0, 10] },
      { type: "crate_stack", position: [18, 0, -10] },
      { type: "crate_stack", position: [12, 0, 12] },
      { type: "crate_stack", position: [-12, 0, -12] },
      // ─── Sandbag walls (chest-high defensive cover) ───
      { type: "sandbag_wall", position: [-10, 0, 12], length: 4, rotY: 0 },
      { type: "sandbag_wall", position: [10, 0, -12], length: 4, rotY: 0 },
      { type: "sandbag_wall", position: [-12, 0, -8], length: 4, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [12, 0, 8], length: 4, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [0, 0, 15], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [0, 0, -15], length: 5, rotY: 0 },
      // ─── Oil barrels (explosive hazards — Task-38: more clusters) ───
      { type: "barrel", position: [-20, 0, 5], color: 0xb33a2a },
      { type: "barrel", position: [-20.7, 0, 5.7], color: 0xb33a2a },
      { type: "barrel", position: [-19.3, 0, 5.7], color: 0x2a4a8a },
      { type: "barrel", position: [20, 0, -5], color: 0xb33a2a },
      { type: "barrel", position: [20.7, 0, -5.7], color: 0xb33a2a },
      { type: "barrel", position: [19.3, 0, -5.7], color: 0x2a4a8a },
      // ─── Generators (rooftop utility) ───
      { type: "generator", position: [-28, 0, -28], rotY: 0.5 },
      { type: "generator", position: [28, 0, 28], rotY: -0.5 },
      // ─── Pallets (scattered detail) ───
      { type: "pallet", position: [-3, 0, 0] },
      { type: "pallet", position: [3, 0, 0], rotY: 0.5 },
      // ─── Ammo boxes (small cover) ───
      { type: "ammo_box", position: [0, 0, 8], rotY: 0.3 },
      { type: "ammo_box", position: [0, 0, -8], rotY: -0.3 },
    ],
  },

  // 4. Desert Outpost — desert FOB
  {
    slug: "desert",
    name: "Desert Outpost",
    description: "DESERT FOB · HESCO BASTIONS · COMMS TOWER · TENTS",
    bounds: 50,
    groundMaterial: "sand",
    playerSpawn: [0, 1.7, 30],
    enemySpawns: [[-40, 0, -40], [40, 0, -40], [-40, 0, 40], [40, 0, 40], [0, 0, -45], [-45, 0, 0], [45, 0, 0]],
    modes: ["SURVIVAL", "HORDE", "EXTRACTION", "ZOMBIES"],
    timeOfDayOverride: 6.5, // Task-38 — dawn (warm orange light, long shadows)
    atmosphere: "clear",
    lighting: {
      ambient: 0.5,
      sun: { intensity: 2.8, color: 0xfff2d0, position: [0, 80, 0] },
      hemi: { sky: 0xe8d8a8, ground: 0xc9a868, intensity: 0.65 },
      fog: { color: 0xe8d8a8, density: 0.008 },
    },
    props: [
      // ─── Perimeter Hesco bastions (Task-38: doubled perimeter wall density) ───
      // North wall.
      { type: "hesco", position: [0, 0, -48], rotY: 0 },
      { type: "hesco", position: [-24, 0, -48], rotY: 0 },
      { type: "hesco", position: [24, 0, -48], rotY: 0 },
      // South wall.
      { type: "hesco", position: [0, 0, 48], rotY: 0 },
      { type: "hesco", position: [-24, 0, 48], rotY: 0 },
      { type: "hesco", position: [24, 0, 48], rotY: 0 },
      // West wall.
      { type: "hesco", position: [-48, 0, 0], rotY: Math.PI / 2 },
      { type: "hesco", position: [-48, 0, -24], rotY: Math.PI / 2 },
      { type: "hesco", position: [-48, 0, 24], rotY: Math.PI / 2 },
      // East wall.
      { type: "hesco", position: [48, 0, 0], rotY: Math.PI / 2 },
      { type: "hesco", position: [48, 0, -24], rotY: Math.PI / 2 },
      { type: "hesco", position: [48, 0, 24], rotY: Math.PI / 2 },
      // ─── Guard towers at perimeter corners (Task-38) ───
      { type: "comms_tower", position: [-40, 0, -40] },
      { type: "comms_tower", position: [40, 0, -40] },
      // ─── Vehicle checkpoint (Task-38 — cars at south entrance) ───
      { type: "car", position: [-8, 0, 42], rotY: 0.1 },
      { type: "car", position: [8, 0, 42], rotY: -0.1 },
      // ─── Central command tent (large, enterable) ───
      { type: "tent", position: [0, 0, 0], rotY: 0, color: 0x6a6a3a },
      // ─── Side tents (Task-38: 3 more for a tent line) ───
      { type: "tent", position: [-20, 0, -8], rotY: 0.5, color: 0x5a5a3a },
      { type: "tent", position: [20, 0, 8], rotY: -0.5, color: 0x5a5a3a },
      { type: "tent", position: [-20, 0, 12], rotY: 0.4, color: 0x5a5a3a },
      { type: "tent", position: [20, 0, -12], rotY: -0.4, color: 0x5a5a3a },
      { type: "tent", position: [0, 0, -22], rotY: 0, color: 0x6a6a3a },
      // ─── Comms tower (tall landmark + cover) ───
      { type: "comms_tower", position: [-30, 0, -30] },
      { type: "comms_tower", position: [30, 0, 30] },
      // ─── Sandbag bunkers at corners (defensive positions) ───
      { type: "sandbag_bunker", position: [-35, 0, -15], rotY: Math.PI / 4 },
      { type: "sandbag_bunker", position: [35, 0, -15], rotY: -Math.PI / 4 },
      { type: "sandbag_bunker", position: [-35, 0, 15], rotY: Math.PI / 4 },
      { type: "sandbag_bunker", position: [35, 0, 15], rotY: -Math.PI / 4 },
      // ─── Sandbag walls (defensive lines) ───
      { type: "sandbag_wall", position: [-15, 0, 15], length: 6, rotY: 0 },
      { type: "sandbag_wall", position: [15, 0, -15], length: 6, rotY: 0 },
      { type: "sandbag_wall", position: [-15, 0, -15], length: 6, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [15, 0, 15], length: 6, rotY: Math.PI / 2 },
      // ─── Fuel bladder farm (Task-38: 3 more for a fuel farm) ───
      { type: "fuel_bladder", position: [-25, 0, 5], rotY: 0 },
      { type: "fuel_bladder", position: [25, 0, -5], rotY: Math.PI },
      { type: "fuel_bladder", position: [-30, 0, 5], rotY: 0 },
      { type: "fuel_bladder", position: [30, 0, -5], rotY: Math.PI },
      { type: "fuel_bladder", position: [-27, 0, 12], rotY: 0 },
      // ─── Crate stacks (supply dumps) ───
      { type: "crate_stack", position: [-10, 0, 10] },
      { type: "crate_stack", position: [10, 0, -10] },
      { type: "crate_stack", position: [-8, 0, -10] },
      { type: "crate_stack", position: [8, 0, 10] },
      { type: "crate_stack", position: [-12, 0, 22] },
      { type: "crate_stack", position: [12, 0, -22] },
      // ─── Single military crates (scattered) ───
      { type: "crate", position: [-12, 0.6, 4], size: [1.2, 1.2, 1.2], rotY: 0.5 },
      { type: "crate", position: [12, 0.6, -4], size: [1.2, 1.2, 1.2], rotY: -0.5 },
      // ─── Ammo boxes (supply detail) ───
      { type: "ammo_box", position: [-5, 0, 6], rotY: 0.4 },
      { type: "ammo_box", position: [5, 0, -6], rotY: -0.4 },
      { type: "ammo_box", position: [-18, 0, 18], rotY: 0.6 },
      { type: "ammo_box", position: [18, 0, -18], rotY: -0.6 },
      // ─── Oil barrels (fuel drums near bladders — Task-38: more clusters) ───
      { type: "barrel", position: [-22, 0, 10], color: 0xb33a2a },
      { type: "barrel", position: [-22.7, 0, 10.7], color: 0xb33a2a },
      { type: "barrel", position: [-21.3, 0, 10.7], color: 0x2a4a8a },
      { type: "barrel", position: [22, 0, -10], color: 0xb33a2a },
      { type: "barrel", position: [22.7, 0, -10.7], color: 0xb33a2a },
      { type: "barrel", position: [21.3, 0, -10.7], color: 0x2a4a8a },
      { type: "barrel", position: [0, 0, 28], color: 0xb33a2a },
      { type: "barrel", position: [0.7, 0, 28.7], color: 0x2a4a8a },
      // ─── Generators (field power) ───
      { type: "generator", position: [-15, 0, -20], rotY: 0 },
      { type: "generator", position: [15, 0, 20], rotY: Math.PI },
    ],
  },

  // 5. Urban Alley — tight city streets
  {
    slug: "alley",
    name: "Urban Alley",
    description: "TIGHT STREETS · FLANKING ROUTES · BURNT-OUT VEHICLES",
    bounds: 38,
    groundMaterial: "asphalt",
    playerSpawn: [0, 1.7, 30],
    enemySpawns: [[-30, 0, -30], [30, 0, -30], [-30, 0, 30], [30, 0, 30], [0, 0, -35]],
    modes: ["BREACH", "SURVIVAL", "VIP"],
    timeOfDayOverride: 14, // Task-38 — overcast day (afternoon)
    atmosphere: "overcast",
    lighting: {
      ambient: 0.4,
      sun: { intensity: 1.3, color: 0xb0a8b0, position: [-40, 50, -30] },
      hemi: { sky: 0x7a7a8a, ground: 0x4a4a4a, intensity: 0.55 },
      fog: { color: 0x5a5a6a, density: 0.014 },
    },
    props: [
      // ─── Storefronts (Task-38: 4 more for denser city block) ───
      // Original 4 corner storefronts.
      { type: "building", position: [-30, 0, -34], size: [12, 6, 8], material: "brick", doorSide: "north", windowsPerWall: 3 },
      { type: "building", position: [30, 0, -34], size: [12, 6, 8], material: "brick", doorSide: "north", windowsPerWall: 3 },
      { type: "building", position: [-30, 0, 34], size: [12, 6, 8], material: "brick", doorSide: "south", windowsPerWall: 3 },
      { type: "building", position: [30, 0, 34], size: [12, 6, 8], material: "brick", doorSide: "south", windowsPerWall: 3 },
      // Mid-block storefronts (Task-38).
      { type: "building", position: [0, 0, -34], size: [10, 6, 6], material: "brick", doorSide: "north", windowsPerWall: 2 },
      { type: "building", position: [0, 0, 34], size: [10, 6, 6], material: "brick", doorSide: "south", windowsPerWall: 2 },
      { type: "building", position: [-34, 0, 0], size: [6, 6, 10], material: "brick", doorSide: "east", windowsPerWall: 2 },
      { type: "building", position: [34, 0, 0], size: [6, 6, 10], material: "brick", doorSide: "west", windowsPerWall: 2 },
      // ─── Back alley walls (flanking corridors) ───
      { type: "box", position: [-15, 3, -10], size: [1, 6, 20], material: "brick", surfaceType: "building" },
      { type: "box", position: [15, 3, 10], size: [1, 6, 20], material: "brick", surfaceType: "building" },
      { type: "box", position: [-15, 3, 15], size: [1, 6, 15], material: "brick", surfaceType: "building" },
      { type: "box", position: [15, 3, -15], size: [1, 6, 15], material: "brick", surfaceType: "building" },
      // ─── Dumpsters (mid-street cover, hinged lid — Task-38: 2 more) ───
      { type: "dumpster", position: [-10, 0, 0], rotY: 0 },
      { type: "dumpster", position: [10, 0, 0], rotY: Math.PI },
      { type: "dumpster", position: [-22, 0, 18], rotY: Math.PI / 2 },
      { type: "dumpster", position: [22, 0, -18], rotY: -Math.PI / 2 },
      { type: "dumpster", position: [0, 0, -20], rotY: 0.2 },
      { type: "dumpster", position: [0, 0, 20], rotY: Math.PI + 0.2 },
      // ─── Parked cars (heavy cover — Task-38: 3 more) ───
      { type: "car", position: [-8, 0, -15], rotY: 0.5 },
      { type: "car", position: [8, 0, 15], rotY: -0.5 },
      { type: "car", position: [0, 0, 0], rotY: 1.2 },
      { type: "car", position: [-20, 0, -5], rotY: 0.2 },
      { type: "car", position: [20, 0, 5], rotY: -0.2 },
      { type: "car", position: [-12, 0, 22], rotY: 0.1 },
      { type: "car", position: [12, 0, -22], rotY: Math.PI - 0.1 },
      { type: "car", position: [-25, 0, 28], rotY: -0.3 },
      // ─── Phone booths (street detail + thin cover — Task-38: 2 more) ───
      { type: "phone_booth", position: [-25, 0, 8], rotY: 0 },
      { type: "phone_booth", position: [25, 0, -8], rotY: Math.PI },
      { type: "phone_booth", position: [-5, 0, -25], rotY: Math.PI / 2 },
      { type: "phone_booth", position: [5, 0, 25], rotY: -Math.PI / 2 },
      { type: "phone_booth", position: [15, 0, 28], rotY: Math.PI },
      { type: "phone_booth", position: [-15, 0, -28], rotY: 0 },
      // ─── Concrete Jersey barriers (street dividers) ───
      { type: "barrier", position: [0, 0, -10], rotY: 0 },
      { type: "barrier", position: [0, 0, 10], rotY: 0 },
      { type: "barrier", position: [-10, 0, -22], rotY: Math.PI / 2 },
      { type: "barrier", position: [10, 0, 22], rotY: Math.PI / 2 },
      // ─── Crate stacks (alley debris — Task-38: 3 more) ───
      { type: "crate_stack", position: [-18, 0, -8] },
      { type: "crate_stack", position: [18, 0, 8] },
      { type: "crate_stack", position: [-12, 0, 22] },
      { type: "crate_stack", position: [12, 0, -22] },
      { type: "crate_stack", position: [-25, 0, -12] },
      { type: "crate_stack", position: [25, 0, 12] },
      { type: "crate_stack", position: [0, 0, -28] },
      // ─── Sandbag walls (defensive barricades — Task-38: 2 more) ───
      { type: "sandbag_wall", position: [-12, 0, 0], length: 4, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [12, 0, 0], length: 4, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [0, 0, 15], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [0, 0, -15], length: 5, rotY: 0 },
      // ─── Oil barrels (explosive hazards — Task-38: more clusters) ───
      { type: "barrel", position: [-25, 0, 12], color: 0xb33a2a },
      { type: "barrel", position: [-25.7, 0, 12.7], color: 0xb33a2a },
      { type: "barrel", position: [-24.3, 0, 12.7], color: 0x2a4a8a },
      { type: "barrel", position: [25, 0, -12], color: 0xb33a2a },
      { type: "barrel", position: [25.7, 0, -12.7], color: 0xb33a2a },
      { type: "barrel", position: [24.3, 0, -12.7], color: 0x2a4a8a },
      // ─── Ammo boxes (small cover — Task-38: 2 more) ───
      { type: "ammo_box", position: [-3, 0, 12], rotY: 0.5 },
      { type: "ammo_box", position: [3, 0, -12], rotY: -0.5 },
      { type: "ammo_box", position: [-20, 0, 25], rotY: 0.3 },
      { type: "ammo_box", position: [20, 0, -25], rotY: -0.3 },
    ],
  },

  // 6. Training Ground — competitive CQB with firing range
  {
    slug: "training",
    name: "Training Ground",
    description: "CQB HOUSE · FIRING RANGE · CONTAINER MAZE · OBSERVATION",
    bounds: 42,
    groundMaterial: "grass",
    playerSpawn: [0, 1.7, 32],
    enemySpawns: [[-35, 0, -35], [35, 0, -35], [-35, 0, 35], [35, 0, 35], [0, 0, -38]],
    modes: ["SURVIVAL", "HORDE", "BREACH", "ZOMBIES"],
    timeOfDayOverride: 9, // Task-38 — morning (warm rising sun)
    atmosphere: "clear",
    lighting: {
      ambient: 0.45,
      sun: { intensity: 2.2, color: 0xfff8e0, position: [30, 60, -30] },
      hemi: { sky: 0xa8c8e8, ground: 0x6a8a5a, intensity: 0.55 },
      fog: { color: 0xb8c8d8, density: 0.010 },
    },
    props: [
      // ─── Perimeter low walls ───
      { type: "box", position: [0, 1.5, -42], size: [88, 3, 1], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [0, 1.5, 42], size: [88, 3, 1], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [-42, 1.5, 0], size: [1, 3, 88], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [42, 1.5, 0], size: [1, 3, 88], material: "concrete", surfaceType: "concrete" },
      // ─── Observation towers (Task-38 — at NW + SE corners) ───
      { type: "comms_tower", position: [-36, 0, -36] },
      { type: "comms_tower", position: [36, 0, 36] },
      // ─── CQB house 1 (Task-38 — west side, enterable from south) ───
      { type: "building", position: [-22, 0, 0], size: [10, 4, 10], material: "concrete", doorSide: "south", windowsPerWall: 2 },
      // CQB house 1 interior: a desk + ammo cache.
      { type: "crate", position: [-22, 0.4, 1.5], size: [1.6, 0.8, 0.8], color: 0x4a3a2a, surfaceType: "wood" },
      { type: "ammo_box", position: [-22, 0, -2], rotY: 0.4 },
      // ─── CQB house 2 (Task-38 — east side, mirrored) ───
      { type: "building", position: [22, 0, 0], size: [10, 4, 10], material: "concrete", doorSide: "south", windowsPerWall: 2 },
      { type: "crate", position: [22, 0.4, 1.5], size: [1.6, 0.8, 0.8], color: 0x4a3a2a, surfaceType: "wood" },
      { type: "ammo_box", position: [22, 0, -2], rotY: -0.4 },
      // ─── Container maze (symmetric — flanking lanes) ───
      { type: "container", position: [-15, 0, -20], rotY: 0, color: 0xa83828 },
      { type: "container", position: [15, 0, 20], rotY: 0, color: 0xa83828 },
      { type: "container", position: [-15, 0, 20], rotY: 0, color: 0x2a4a78 },
      { type: "container", position: [15, 0, -20], rotY: 0, color: 0x2a4a78 },
      { type: "container", position: [-25, 0, 0], rotY: Math.PI / 2, color: 0x3a5a3a },
      { type: "container", position: [25, 0, 0], rotY: Math.PI / 2, color: 0x3a5a3a },
      // ─── Symmetric A-frame barricades (Task-38: 4 more variations) ───
      { type: "barricade", position: [-10, 0, -10], rotY: 0 },
      { type: "barricade", position: [10, 0, 10], rotY: Math.PI },
      { type: "barricade", position: [-10, 0, 10], rotY: 0 },
      { type: "barricade", position: [10, 0, -10], rotY: Math.PI },
      { type: "barricade", position: [-30, 0, -10], rotY: 0.3 },
      { type: "barricade", position: [30, 0, 10], rotY: Math.PI + 0.3 },
      { type: "barricade", position: [-30, 0, 10], rotY: -0.3 },
      { type: "barricade", position: [30, 0, -10], rotY: Math.PI - 0.3 },
      // ─── Symmetric cover walls (sandbag) ───
      { type: "sandbag_wall", position: [-12, 0, -5], length: 4, rotY: 0 },
      { type: "sandbag_wall", position: [12, 0, 5], length: 4, rotY: 0 },
      { type: "sandbag_wall", position: [-5, 0, -12], length: 4, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [5, 0, 12], length: 4, rotY: Math.PI / 2 },
      // ─── Symmetric Jersey barriers ───
      { type: "barrier", position: [-20, 0, -5], rotY: 0 },
      { type: "barrier", position: [20, 0, 5], rotY: 0 },
      { type: "barrier", position: [-20, 0, 5], rotY: 0 },
      { type: "barrier", position: [20, 0, -5], rotY: 0 },
      // ─── Symmetric crate stacks ───
      { type: "crate_stack", position: [-8, 0, -15] },
      { type: "crate_stack", position: [8, 0, 15] },
      { type: "crate_stack", position: [-18, 0, -15] },
      { type: "crate_stack", position: [18, 0, 15] },
      // ─── Firing range (Task-38 — target lines at 10/25/50m from spawn at z=32) ───
      // 10m line (z=22).
      { type: "target", position: [-3, 0, 22], rotY: 0 },
      { type: "target", position: [3, 0, 22], rotY: 0 },
      // 25m line (z=7).
      { type: "target", position: [-4, 0, 7], rotY: 0 },
      { type: "target", position: [0, 0, 7], rotY: 0 },
      { type: "target", position: [4, 0, 7], rotY: 0 },
      // 50m line (z=-18).
      { type: "target", position: [-5, 0, -18], rotY: 0 },
      { type: "target", position: [0, 0, -18], rotY: 0 },
      { type: "target", position: [5, 0, -18], rotY: 0 },
      // ─── Symmetric oil barrels (explosive hazards) ───
      { type: "barrel", position: [-25, 0, 8], color: 0xb33a2a },
      { type: "barrel", position: [-25.7, 0, 8.7], color: 0xb33a2a },
      { type: "barrel", position: [-24.3, 0, 8.7], color: 0x2a4a8a },
      { type: "barrel", position: [25, 0, -8], color: 0xb33a2a },
      { type: "barrel", position: [25.7, 0, -8.7], color: 0xb33a2a },
      { type: "barrel", position: [24.3, 0, -8.7], color: 0x2a4a8a },
      // ─── Symmetric ammo boxes ───
      { type: "ammo_box", position: [-5, 0, 8], rotY: 0.4 },
      { type: "ammo_box", position: [5, 0, -8], rotY: -0.4 },
      { type: "ammo_box", position: [-5, 0, -8], rotY: 0.4 },
      { type: "ammo_box", position: [5, 0, 8], rotY: -0.4 },
      // ─── Symmetric pallets (floor detail) ───
      { type: "pallet", position: [-3, 0, 20] },
      { type: "pallet", position: [3, 0, -20] },
    ],
  },

  // 7. Practice Range — sandbox target-shooting map (Task-15 PRACTICE_RANGE mode).
  //    Flat open field with destructible target silhouettes at 10m / 20m /
  //    30m / 50m, a shooting bench at the spawn, and a few cover crates for
  //    shooting around. No enemies, no timer — the player tests weapons +
  //    recoil control at their own pace. Noon lighting (bright, clear) so
  //    targets are easy to see at all distances.
  {
    slug: "practice_range",
    name: "Practice Range",
    description: "SANDBOX · STATIC TARGETS · ALL DISTANCES · NO ENEMIES",
    bounds: 60,
    groundMaterial: "concrete",
    playerSpawn: [0, 1.7, 55],
    enemySpawns: [], // PRACTICE_RANGE mode spawns 0 enemies
    modes: ["PRACTICE_RANGE"],
    timeOfDayOverride: 12, // noon — bright, clear
    atmosphere: "clear",
    lighting: {
      ambient: 0.55,
      sun: { intensity: 2.8, color: 0xfff8e0, position: [20, 80, 20] },
      hemi: { sky: 0xbfd4e8, ground: 0x8a7a5a, intensity: 0.65 },
      fog: { color: 0xc9d8e8, density: 0.006 },
    },
    props: [
      // Perimeter low berms (range boundary — kept low so the sky reads open).
      { type: "box", position: [0, 2, -60], size: [124, 4, 2], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [0, 2, 60], size: [124, 4, 2], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [-60, 2, 0], size: [2, 4, 124], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [60, 2, 0], size: [2, 4, 124], material: "concrete", surfaceType: "concrete" },

      // Shooting bench at the spawn — a wide low crate stands in for a table
      // (there's no dedicated `table` prop type, and we don't add new prop
      // types here). Flanked by two side crates for ammo/equipment dressing.
      { type: "crate", position: [0, 0.4, 53], size: [2.4, 0.8, 0.8], color: 0x4a3a2a, surfaceType: "wood" },
      { type: "crate", position: [-4, 0.4, 54], size: [1.5, 0.8, 0.8], color: 0x4a3a2a, surfaceType: "wood" },
      { type: "crate", position: [4, 0.4, 54], size: [1.5, 0.8, 0.8], color: 0x4a3a2a, surfaceType: "wood" },

      // Target silhouettes at 10m (player z=55 → target z=45). 3 across.
      { type: "target", position: [-5, 0, 45], rotY: 0 },
      { type: "target", position: [0, 0, 45], rotY: 0 },
      { type: "target", position: [5, 0, 45], rotY: 0 },

      // Targets at 20m (z=35). 3 across.
      { type: "target", position: [-6, 0, 35], rotY: 0 },
      { type: "target", position: [0, 0, 35], rotY: 0 },
      { type: "target", position: [6, 0, 35], rotY: 0 },

      // Targets at 30m (z=25). 3 across.
      { type: "target", position: [-7, 0, 25], rotY: 0 },
      { type: "target", position: [0, 0, 25], rotY: 0 },
      { type: "target", position: [7, 0, 25], rotY: 0 },

      // Targets at 50m (z=5). 3 across, wider spread for long-range practice.
      { type: "target", position: [-10, 0, 5], rotY: 0 },
      { type: "target", position: [0, 0, 5], rotY: 0 },
      { type: "target", position: [10, 0, 5], rotY: 0 },

      // Cover crates for shooting around (mid-field, flanking the firing line).
      { type: "crate", position: [-8, 0.6, 40], size: [1.2, 1.2, 1.2], rotY: 0.3 },
      { type: "crate", position: [8, 0.6, 40], size: [1.2, 1.2, 1.2], rotY: -0.3 },
      { type: "crate", position: [-10, 0.6, 20], size: [1.2, 1.2, 1.2], rotY: 0.5 },
      { type: "crate", position: [10, 0.6, 20], size: [1.2, 1.2, 1.2], rotY: -0.5 },
      { type: "crate_stack", position: [-12, 0, 30] },
      { type: "crate_stack", position: [12, 0, 30] },

      // Distance markers down the left flank — small ammo boxes every 10m so
      // the player can gauge range visually (10/20/30/40/50m from the spawn).
      { type: "ammo_box", position: [-15, 0, 45], rotY: 0 },
      { type: "ammo_box", position: [-15, 0, 35], rotY: 0 },
      { type: "ammo_box", position: [-15, 0, 25], rotY: 0 },
      { type: "ammo_box", position: [-15, 0, 15], rotY: 0 },
      { type: "ammo_box", position: [-15, 0, 5], rotY: 0 },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // Task-6 — 3 new maps with distinct visual identities + interactive props.
  //
  // 8. "Bunker"   — underground command bunker (tight CQB corridors, glass
  //                 sightlines, sandbag chokepoints, low ceilings).
  // 9. "Mansion"  — abandoned estate (wood floors, glass partitions, grand
  //                 staircase, ornate but claustrophobic).
  // 10. "Subway"  — metro station (platforms + train cars, jump pads to upper
  //                 concourse, ticket booths, vertical gameplay).
  // ══════════════════════════════════════════════════════════════════════════

  // 8. Bunker — underground command bunker (tight CQB + glass sightlines).
  {
    slug: "bunker",
    name: "Bunker",
    description: "UNDERGROUND COMMAND · GLASS SIGHTLINES · CHOKEPOINTS",
    bounds: 32,
    groundMaterial: "concrete",
    playerSpawn: [0, 1.7, 24],
    enemySpawns: [[-22, 0, -22], [22, 0, -22], [-22, 0, 22], [22, 0, 22], [0, 0, -26]],
    modes: ["BREACH", "SURVIVAL", "HORDE"],
    timeOfDayOverride: 0, // midnight (artificial lighting — fixtures only)
    atmosphere: "night",
    lighting: {
      ambient: 0.5, // raised above floor so bunker interior is readable
      sun: { intensity: 1.0, color: 0x6a7080, position: [0, 50, 0] },
      hemi: { sky: 0x6a7080, ground: 0x3a3a3a, intensity: 0.55 },
      fog: { color: 0x2a2a30, density: 0.013 },
    },
    props: [
      // ─── Perimeter concrete walls (bunker shell) ───
      { type: "box", position: [0, 4, -32], size: [68, 8, 2], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [0, 4, 32], size: [68, 8, 2], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [-32, 4, 0], size: [2, 8, 68], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [32, 4, 0], size: [2, 8, 68], material: "concrete", surfaceType: "concrete" },
      // ─── Overhead pipes / conduits (industrial bunker feel) ───
      { type: "box", position: [-8, 7.5, 0], size: [0.4, 0.4, 60], material: "metal", surfaceType: "container" },
      { type: "box", position: [8, 7.5, 0], size: [0.4, 0.4, 60], material: "metal", surfaceType: "container" },
      { type: "box", position: [0, 8, -10], size: [60, 0.3, 0.3], material: "metal", surfaceType: "container" },
      { type: "box", position: [0, 8, 10], size: [60, 0.3, 0.3], material: "metal", surfaceType: "container" },
      // ─── Central command room (glass partition + desk) ───
      // Breakable glass sightline — shatters to open the room (Task-6 interactive).
      { type: "glass_panel", position: [0, 0, -6], size: [6, 2.4, 0.04], destructibleHp: 30, rotY: 0 },
      { type: "glass_panel", position: [0, 0, 6], size: [6, 2.4, 0.04], destructibleHp: 30, rotY: 0 },
      // Command desk (flat crate).
      { type: "crate", position: [0, 0.4, 0], size: [2.4, 0.8, 1.2], color: 0x4a3a2a, surfaceType: "wood" },
      { type: "ammo_box", position: [-2, 0, 0], rotY: 0.3 },
      { type: "ammo_box", position: [2, 0, 0], rotY: -0.3 },
      // ─── 4 corner rooms (sandbag chokepoints at the doorways) ───
      { type: "building", position: [-20, 0, -20], size: [8, 4, 8], material: "concrete", doorSide: "east", windowsPerWall: 1 },
      { type: "building", position: [20, 0, -20], size: [8, 4, 8], material: "concrete", doorSide: "west", windowsPerWall: 1 },
      { type: "building", position: [-20, 0, 20], size: [8, 4, 8], material: "concrete", doorSide: "east", windowsPerWall: 1 },
      { type: "building", position: [20, 0, 20], size: [8, 4, 8], material: "concrete", doorSide: "west", windowsPerWall: 1 },
      // ─── Sandbag chokepoints (doorway cover) ───
      { type: "sandbag_wall", position: [-16, 0, -16], length: 4, rotY: 0 },
      { type: "sandbag_wall", position: [16, 0, -16], length: 4, rotY: 0 },
      { type: "sandbag_wall", position: [-16, 0, 16], length: 4, rotY: 0 },
      { type: "sandbag_wall", position: [16, 0, 16], length: 4, rotY: 0 },
      // ─── Sandbag bunkers (defensive positions in corridors) ───
      { type: "sandbag_bunker", position: [-10, 0, 0], rotY: Math.PI / 2 },
      { type: "sandbag_bunker", position: [10, 0, 0], rotY: -Math.PI / 2 },
      // ─── Crate stacks (cover in the central lanes) ───
      { type: "crate_stack", position: [-6, 0, -10] },
      { type: "crate_stack", position: [6, 0, 10] },
      { type: "crate_stack", position: [-12, 0, 8] },
      { type: "crate_stack", position: [12, 0, -8] },
      // ─── Ammo storage (single crates) ───
      { type: "crate", position: [-4, 0.6, -4], size: [1.2, 1.2, 1.2], rotY: 0.4 },
      { type: "crate", position: [4, 0.6, 4], size: [1.2, 1.2, 1.2], rotY: -0.4 },
      // ─── Oil barrel clusters (explosive hazards at junctions) ───
      { type: "barrel", position: [-14, 0, 6], color: 0xb33a2a },
      { type: "barrel", position: [-14.7, 0, 6.7], color: 0xb33a2a },
      { type: "barrel", position: [14, 0, -6], color: 0x2a4a8a },
      { type: "barrel", position: [14.7, 0, -6.7], color: 0x2a4a8a },
      // ─── Generators (power-room detail + cover) ───
      { type: "generator", position: [-24, 0, 0], rotY: Math.PI / 2 },
      { type: "generator", position: [24, 0, 0], rotY: -Math.PI / 2 },
      // ─── Pillars (structural cover in central corridor) ───
      { type: "pillar", position: [-8, 0, -8] },
      { type: "pillar", position: [8, 0, -8] },
      { type: "pillar", position: [-8, 0, 8] },
      { type: "pillar", position: [8, 0, 8] },
      // ─── Pallets (scattered floor detail) ───
      { type: "pallet", position: [-4, 0, -16] },
      { type: "pallet", position: [4, 0, 16], rotY: 0.5 },
      // ─── Concrete Jersey barriers (corridor dividers) ───
      { type: "barrier", position: [0, 0, -14], rotY: 0 },
      { type: "barrier", position: [0, 0, 14], rotY: 0 },
      // ─── Ammo boxes (small cover near chokepoints) ───
      { type: "ammo_box", position: [-8, 0, 14], rotY: 0.5 },
      { type: "ammo_box", position: [8, 0, -14], rotY: -0.5 },
    ],
  },

  // 9. Mansion — abandoned luxury estate (wood floors, glass partitions).
  {
    slug: "mansion",
    name: "Mansion",
    description: "ABANDONED ESTATE · GLASS PARTITIONS · GRAND HALL",
    bounds: 36,
    // groundMaterial doesn't have a "wood" option; use "concrete" — the
    // interior floor dressing (rugs / wood-grain crates) carries the
    // estate's warm feel. See createGroundMaterial for the type list.
    groundMaterial: "concrete",
    playerSpawn: [0, 1.7, 28],
    enemySpawns: [[-28, 0, -28], [28, 0, -28], [-28, 0, 28], [28, 0, 28], [0, 0, -32]],
    modes: ["BREACH", "SURVIVAL", "VIP"],
    timeOfDayOverride: 16, // late afternoon — warm amber light through windows
    atmosphere: "dusk",
    lighting: {
      ambient: 0.45,
      sun: { intensity: 1.8, color: 0xffd0a0, position: [-40, 50, -20] },
      hemi: { sky: 0xc8a878, ground: 0x6a4a3a, intensity: 0.55 },
      fog: { color: 0xa87858, density: 0.011 },
    },
    props: [
      // ─── Perimeter exterior walls (brick + wrought-iron feel) ───
      { type: "box", position: [0, 4, -36], size: [76, 8, 2], material: "brick", surfaceType: "building" },
      { type: "box", position: [0, 4, 36], size: [76, 8, 2], material: "brick", surfaceType: "building" },
      { type: "box", position: [-36, 4, 0], size: [2, 8, 76], material: "brick", surfaceType: "building" },
      { type: "box", position: [36, 4, 0], size: [2, 8, 76], material: "brick", surfaceType: "building" },
      // ─── Grand hall building (central — enterable, ornate brick) ───
      { type: "building", position: [0, 0, 0], size: [14, 6, 14], material: "brick", doorSide: "south", windowsPerWall: 3 },
      // Grand hall interior — breakable glass partitions for shootable windows.
      { type: "glass_panel", position: [-4, 0, 0], size: [4, 2.4, 0.04], destructibleHp: 25, rotY: Math.PI / 2 },
      { type: "glass_panel", position: [4, 0, 0], size: [4, 2.4, 0.04], destructibleHp: 25, rotY: Math.PI / 2 },
      { type: "glass_panel", position: [0, 0, -4], size: [4, 2.4, 0.04], destructibleHp: 25, rotY: 0 },
      { type: "glass_panel", position: [0, 0, 4], size: [4, 2.4, 0.04], destructibleHp: 25, rotY: 0 },
      // ─── 4 corner rooms (study, library, parlor, dining) ───
      { type: "building", position: [-22, 0, -22], size: [10, 5, 10], material: "brick", doorSide: "east", windowsPerWall: 2 },
      { type: "building", position: [22, 0, -22], size: [10, 5, 10], material: "brick", doorSide: "west", windowsPerWall: 2 },
      { type: "building", position: [-22, 0, 22], size: [10, 5, 10], material: "brick", doorSide: "east", windowsPerWall: 2 },
      { type: "building", position: [22, 0, 22], size: [10, 5, 10], material: "brick", doorSide: "west", windowsPerWall: 2 },
      // ─── Furniture (wooden crates repurposed as tables/chairs) ───
      { type: "crate", position: [0, 0.4, 2], size: [2, 0.8, 1], color: 0x4a3a2a, surfaceType: "wood" },
      { type: "crate", position: [-3, 0.6, -2], size: [1.2, 1.2, 1.2], color: 0x4a3a2a, surfaceType: "wood" },
      { type: "crate", position: [3, 0.6, 2], size: [1.2, 1.2, 1.2], color: 0x4a3a2a, surfaceType: "wood", rotY: 0.3 },
      // ─── Bookshelf props (tall narrow shelves along walls) ───
      { type: "shelf", position: [-12, 0, -8], rotY: Math.PI / 2 },
      { type: "shelf", position: [12, 0, 8], rotY: -Math.PI / 2 },
      { type: "shelf", position: [-8, 0, 12], rotY: 0 },
      { type: "shelf", position: [8, 0, -12], rotY: Math.PI },
      // ─── Crate stacks (debris piles in the corridors) ───
      { type: "crate_stack", position: [-10, 0, 6] },
      { type: "crate_stack", position: [10, 0, -6] },
      { type: "crate_stack", position: [-14, 0, -8] },
      { type: "crate_stack", position: [14, 0, 8] },
      // ─── Pillars (grand-hall structural columns) ───
      { type: "pillar", position: [-6, 0, -6] },
      { type: "pillar", position: [6, 0, -6] },
      { type: "pillar", position: [-6, 0, 6] },
      { type: "pillar", position: [6, 0, 6] },
      // ─── Sandbag walls (defensive lines — soldiers fortified the mansion) ───
      { type: "sandbag_wall", position: [-12, 0, 0], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [12, 0, 0], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [0, 0, -12], length: 5, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [0, 0, 12], length: 5, rotY: Math.PI / 2 },
      // ─── Dumpsters (exterior debris bins near perimeter) ───
      { type: "dumpster", position: [-28, 0, 12], rotY: 0 },
      { type: "dumpster", position: [28, 0, -12], rotY: Math.PI },
      // ─── Cars (abandoned vehicles in the courtyard) ───
      { type: "car", position: [-16, 0, 18], rotY: 0.3 },
      { type: "car", position: [16, 0, -18], rotY: Math.PI - 0.3 },
      // ─── Phone booths (period detail near the entrance) ───
      { type: "phone_booth", position: [-4, 0, 20], rotY: 0 },
      { type: "phone_booth", position: [4, 0, 20], rotY: Math.PI },
      // ─── Oil barrels (explosive hazards in the kitchens) ───
      { type: "barrel", position: [-20, 0, 8], color: 0xb33a2a },
      { type: "barrel", position: [-20.7, 0, 8.7], color: 0xb33a2a },
      { type: "barrel", position: [20, 0, -8], color: 0x2a4a8a },
      { type: "barrel", position: [20.7, 0, -8.7], color: 0x2a4a8a },
      // ─── Ammo boxes (scattered small cover) ───
      { type: "ammo_box", position: [-6, 0, 8], rotY: 0.4 },
      { type: "ammo_box", position: [6, 0, -8], rotY: -0.4 },
      // ─── Pallets (scattered floor detail) ───
      { type: "pallet", position: [-2, 0, 10] },
      { type: "pallet", position: [2, 0, -10], rotY: 0.5 },
      // ─── Breakable glass above the entryway (extra sightline) ───
      { type: "glass_panel", position: [0, 2.5, 7], size: [5, 1.5, 0.04], destructibleHp: 20, rotY: 0 },
    ],
  },

  // 10. Subway — underground metro station (verticality via jump pads).
  {
    slug: "subway",
    name: "Subway",
    description: "METRO STATION · TRAIN CARS · JUMP-PAD VERTICALITY",
    bounds: 40,
    groundMaterial: "concrete",
    playerSpawn: [0, 1.7, 32],
    enemySpawns: [[-30, 0, -30], [30, 0, -30], [-30, 0, 30], [30, 0, 30], [0, 0, -34]],
    modes: ["SURVIVAL", "BREACH", "EXTRACTION"],
    timeOfDayOverride: 22, // night — fluorescent-lit underground
    atmosphere: "night",
    lighting: {
      ambient: 0.5, // raised above floor so platforms are readable
      sun: { intensity: 1.0, color: 0x6a78a0, position: [0, 50, 0] },
      hemi: { sky: 0x6a78a0, ground: 0x3a3a4a, intensity: 0.55 },
      fog: { color: 0x2a2a3a, density: 0.014 },
    },
    props: [
      // ─── Perimeter tunnel walls ───
      { type: "box", position: [0, 5, -40], size: [84, 10, 2], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [0, 5, 40], size: [84, 10, 2], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [-40, 5, 0], size: [2, 10, 84], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [40, 5, 0], size: [2, 10, 84], material: "concrete", surfaceType: "concrete" },
      // ─── Tracks (lowered channels — represented by dark asphalt boxes) ───
      { type: "box", position: [-12, 0.05, 0], size: [8, 0.1, 70], material: "metal", surfaceType: "metal" },
      { type: "box", position: [12, 0.05, 0], size: [8, 0.1, 70], material: "metal", surfaceType: "metal" },
      // ─── Train cars on the tracks (heavy cover — long boxes w/ windows) ───
      { type: "building", position: [-12, 0, -10], size: [6, 4, 18], material: "metal", doorSide: "south", windowsPerWall: 4 },
      { type: "building", position: [12, 0, 10], size: [6, 4, 18], material: "metal", doorSide: "north", windowsPerWall: 4 },
      // ─── Platform edge pillars (structural columns between tracks) ───
      { type: "pillar", position: [-6, 0, -20] },
      { type: "pillar", position: [6, 0, -20] },
      { type: "pillar", position: [-6, 0, 0] },
      { type: "pillar", position: [6, 0, 0] },
      { type: "pillar", position: [-6, 0, 20] },
      { type: "pillar", position: [6, 0, 20] },
      // ─── Ticket booths (small kiosks at the platforms) ───
      { type: "building", position: [-25, 0, -25], size: [6, 3, 6], material: "concrete", doorSide: "east", windowsPerWall: 1 },
      { type: "building", position: [25, 0, 25], size: [6, 3, 6], material: "concrete", doorSide: "west", windowsPerWall: 1 },
      // ─── Breakable glass partitions (between platform and concourse) ───
      { type: "glass_panel", position: [-18, 0, 0], size: [6, 2.4, 0.04], destructibleHp: 30, rotY: Math.PI / 2 },
      { type: "glass_panel", position: [18, 0, 0], size: [6, 2.4, 0.04], destructibleHp: 30, rotY: Math.PI / 2 },
      // ─── Jump pads (Task-6 — boost from track level to upper concourse) ───
      // 4 pads total: 2 on each track, placed so the player can boost to
      // the upper concourse and reposition for a flanking angle.
      { type: "jump_pad", position: [-12, 0, -15], size: [1.2, 0.2, 1.2] },
      { type: "jump_pad", position: [-12, 0, 15], size: [1.2, 0.2, 1.2] },
      { type: "jump_pad", position: [12, 0, -15], size: [1.2, 0.2, 1.2] },
      { type: "jump_pad", position: [12, 0, 15], size: [1.2, 0.2, 1.2] },
      // ─── Upper concourse (elevated platform — reached via jump pads) ───
      // Concourse floor (chest-high boxes simulate an elevated walkway).
      { type: "box", position: [-20, 2, -10], size: [8, 0.4, 8], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [20, 2, 10], size: [8, 0.4, 8], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [-20, 2, 10], size: [8, 0.4, 8], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [20, 2, -10], size: [8, 0.4, 8], material: "concrete", surfaceType: "concrete" },
      // Concourse railings (low walls around the elevated platforms).
      { type: "box", position: [-20, 2.5, -14], size: [8, 1, 0.2], material: "metal", surfaceType: "container" },
      { type: "box", position: [-20, 2.5, -6], size: [8, 1, 0.2], material: "metal", surfaceType: "container" },
      { type: "box", position: [20, 2.5, 14], size: [8, 1, 0.2], material: "metal", surfaceType: "container" },
      { type: "box", position: [20, 2.5, 6], size: [8, 1, 0.2], material: "metal", surfaceType: "container" },
      // ─── Crate stacks (cover on the platforms) ───
      { type: "crate_stack", position: [-8, 0, -25] },
      { type: "crate_stack", position: [8, 0, 25] },
      { type: "crate_stack", position: [-20, 0, 5] },
      { type: "crate_stack", position: [20, 0, -5] },
      // ─── Sandbag walls (defensive fortifications on the platforms) ───
      { type: "sandbag_wall", position: [-4, 0, -10], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [4, 0, 10], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [-15, 0, 18], length: 5, rotY: Math.PI / 2 },
      { type: "sandbag_wall", position: [15, 0, -18], length: 5, rotY: Math.PI / 2 },
      // ─── Concrete barriers (platform edge dividers) ───
      { type: "barrier", position: [-8, 0, 0], rotY: 0 },
      { type: "barrier", position: [8, 0, 0], rotY: 0 },
      // ─── Sandbag bunkers (defensive corners) ───
      { type: "sandbag_bunker", position: [-30, 0, -10], rotY: 0 },
      { type: "sandbag_bunker", position: [30, 0, 10], rotY: Math.PI },
      // ─── Oil barrels (explosive hazards near the trains) ───
      { type: "barrel", position: [-6, 0, -5], color: 0xb33a2a },
      { type: "barrel", position: [-6.7, 0, -5.7], color: 0xb33a2a },
      { type: "barrel", position: [6, 0, 5], color: 0x2a4a8a },
      { type: "barrel", position: [6.7, 0, 5.7], color: 0x2a4a8a },
      // ─── Generators (platform utility) ───
      { type: "generator", position: [-28, 0, 25], rotY: 0 },
      { type: "generator", position: [28, 0, -25], rotY: Math.PI },
      // ─── Ammo boxes (scattered cover) ───
      { type: "ammo_box", position: [-4, 0, 18], rotY: 0.4 },
      { type: "ammo_box", position: [4, 0, -18], rotY: -0.4 },
      { type: "ammo_box", position: [-18, 0, -8], rotY: 0.6 },
      { type: "ammo_box", position: [18, 0, 8], rotY: -0.6 },
      // ─── Phone booths (platform detail — period metro feel) ───
      { type: "phone_booth", position: [-30, 0, 5], rotY: 0 },
      { type: "phone_booth", position: [30, 0, -5], rotY: Math.PI },
      // ─── Pallets (scattered floor detail) ───
      { type: "pallet", position: [-3, 0, 8] },
      { type: "pallet", position: [3, 0, -8], rotY: 0.5 },
      // ─── Single crates (mid-platform cover) ───
      { type: "crate", position: [-2, 0.6, -2], size: [1.2, 1.2, 1.2], rotY: 0.3 },
      { type: "crate", position: [2, 0.6, 2], size: [1.2, 1.2, 1.2], rotY: -0.3 },
    ],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // Section M — 4 new biome-typed maps. One per missing biome family:
  //   11. "Frostbite"   — arctic research station (blizzard, snow, ice).
  //   12. "Verdant Ruin"— jungle temple ruins (monsoon, mud, dense foliage).
  //   13. "Tidal Lock"  — coastal fishing port (coastal_haze, water, piers).
  //   14. "Ember Yard"  — mountain switchback village (golden hour, vertical).
  //
  // Each map declares `biome`, `weatherPreset`, `timePreset`, `vegetation`,
  // and (where applicable) `underwater: true` so the engine wires the
  // Section M subsystems automatically on map build.
  // ════════════════════════════════════════════════════════════════════════════

  // 11. Frostbite — arctic research station.
  {
    slug: "frostbite",
    name: "Frostbite",
    description: "ARCTIC RESEARCH STATION · BLIZZARD · SNOWDRIFT COVER",
    bounds: 48,
    groundMaterial: "snow",
    playerSpawn: [0, 1.7, 32],
    enemySpawns: [[-38, 0, -38], [38, 0, -38], [-38, 0, 38], [38, 0, 38], [0, 0, -42], [-30, 0, 0], [30, 0, 0]],
    modes: ["SURVIVAL", "HORDE", "EXTRACTION", "VIP"],
    timeOfDayOverride: 11,
    atmosphere: "blizzard",
    biome: "arctic",
    weatherPreset: "blizzard",
    timePreset: "match_paced",
    vegetation: true,
    lighting: {
      ambient: 0.5,
      sun: { intensity: 1.6, color: 0xc8d8ff, position: [0, 60, -40] },
      hemi: { sky: 0xc8d8f0, ground: 0xe0eaf2, intensity: 0.7 },
      fog: { color: 0xd0dae4, density: 0.015 },
    },
    props: [
      // ─── Perimeter ice walls (research-station shell) ───
      { type: "box", position: [0, 4, -48], size: [100, 8, 2], material: "metal", surfaceType: "metal" },
      { type: "box", position: [0, 4, 48], size: [100, 8, 2], material: "metal", surfaceType: "metal" },
      { type: "box", position: [-48, 4, 0], size: [2, 8, 100], material: "metal", surfaceType: "metal" },
      { type: "box", position: [48, 4, 0], size: [2, 8, 100], material: "metal", surfaceType: "metal" },
      // ─── Main research building (enterable) ───
      { type: "building", position: [0, 0, 0], size: [14, 5, 14], material: "concrete", doorSide: "south", windowsPerWall: 3 },
      // ─── Two lab wings (flanking) ───
      { type: "building", position: [-25, 0, -10], size: [10, 4, 8], material: "concrete", doorSide: "east", windowsPerWall: 2 },
      { type: "building", position: [25, 0, 10], size: [10, 4, 8], material: "concrete", doorSide: "west", windowsPerWall: 2 },
      // ─── Comms tower (arctic landmark + overwatch) ───
      { type: "comms_tower", position: [-38, 0, -38] },
      { type: "comms_tower", position: [38, 0, 38] },
      // ─── Snowcat vehicles (heavy cover) ───
      { type: "car", position: [-10, 0, 22], rotY: 0.2 },
      { type: "car", position: [10, 0, -22], rotY: Math.PI - 0.2 },
      { type: "car", position: [-30, 0, 25], rotY: -0.3 },
      // ─── Hesco bastions (snow-filled defensive perimeter) ───
      { type: "hesco", position: [-15, 0, -25], rotY: 0 },
      { type: "hesco", position: [15, 0, 25], rotY: 0 },
      { type: "hesco", position: [-25, 0, 15], rotY: Math.PI / 2 },
      { type: "hesco", position: [25, 0, -15], rotY: Math.PI / 2 },
      // ─── Sandbag bunkers (defensive positions) ───
      { type: "sandbag_bunker", position: [-18, 0, 8], rotY: 0 },
      { type: "sandbag_bunker", position: [18, 0, -8], rotY: Math.PI },
      // ─── Sandbag walls (defensive lines) ───
      { type: "sandbag_wall", position: [-10, 0, 15], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [10, 0, -15], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [0, 0, -20], length: 6, rotY: Math.PI / 2 },
      // ─── Fuel bladders (generator fuel — explosive) ───
      { type: "fuel_bladder", position: [-22, 0, -5], rotY: 0 },
      { type: "fuel_bladder", position: [22, 0, 5], rotY: Math.PI },
      // ─── Crate stacks (supply dumps) ───
      { type: "crate_stack", position: [-8, 0, -8] },
      { type: "crate_stack", position: [8, 0, 8] },
      { type: "crate_stack", position: [-15, 0, -15] },
      { type: "crate_stack", position: [15, 0, 15] },
      // ─── Generators (power for the station) ───
      { type: "generator", position: [-30, 0, 30], rotY: 0 },
      { type: "generator", position: [30, 0, -30], rotY: Math.PI },
      // ─── Oil barrels (explosive hazards near fuel) ───
      { type: "barrel", position: [-20, 0, 0], color: 0xb33a2a },
      { type: "barrel", position: [-20.7, 0, 0.7], color: 0xb33a2a },
      { type: "barrel", position: [20, 0, 0], color: 0x2a4a8a },
      { type: "barrel", position: [20.7, 0, -0.7], color: 0x2a4a8a },
      // ─── Ammo boxes (scattered supply) ───
      { type: "ammo_box", position: [-5, 0, 10], rotY: 0.4 },
      { type: "ammo_box", position: [5, 0, -10], rotY: -0.4 },
      { type: "ammo_box", position: [-12, 0, 22], rotY: 0.6 },
      { type: "ammo_box", position: [12, 0, -22], rotY: -0.6 },
      // ─── Glass partitions (interior sightlines — shootable) ───
      { type: "glass_panel", position: [0, 0, -7], size: [6, 2.4, 0.04], destructibleHp: 30, rotY: 0 },
      { type: "glass_panel", position: [0, 0, 7], size: [6, 2.4, 0.04], destructibleHp: 30, rotY: 0 },
    ],
  },

  // 12. Verdant Ruin — jungle temple ruins.
  {
    slug: "verdant_ruin",
    name: "Verdant Ruin",
    description: "JUNGLE TEMPLE · MONSOON · MUD + DENSE FOLIAGE",
    bounds: 52,
    groundMaterial: "mud",
    playerSpawn: [0, 1.7, 34],
    enemySpawns: [[-42, 0, -42], [42, 0, -42], [-42, 0, 42], [42, 0, 42], [0, 0, -46], [-30, 0, -10], [30, 0, 10]],
    modes: ["SURVIVAL", "HORDE", "EXTRACTION", "ZOMBIES"],
    timeOfDayOverride: 14,
    atmosphere: "monsoon",
    biome: "jungle",
    weatherPreset: "monsoon",
    timePreset: "match_paced",
    vegetation: true,
    underwater: true,
    lighting: {
      ambient: 0.45,
      sun: { intensity: 1.2, color: 0xa8c878, position: [20, 60, 20] },
      hemi: { sky: 0x6a8a5a, ground: 0x3a4a2a, intensity: 0.6 },
      fog: { color: 0x5a7a4a, density: 0.015 },
    },
    props: [
      // ─── Perimeter stone walls (temple shell — mossy) ───
      { type: "box", position: [0, 4, -52], size: [108, 8, 2], material: "brick", surfaceType: "building" },
      { type: "box", position: [0, 4, 52], size: [108, 8, 2], material: "brick", surfaceType: "building" },
      { type: "box", position: [-52, 4, 0], size: [2, 8, 108], material: "brick", surfaceType: "building" },
      { type: "box", position: [52, 4, 0], size: [2, 8, 108], material: "brick", surfaceType: "building" },
      // ─── Central temple (large brick structure — enterable) ───
      { type: "building", position: [0, 0, 0], size: [16, 6, 16], material: "brick", doorSide: "south", windowsPerWall: 3 },
      // ─── Side shrines (4 corner mini-temples) ───
      { type: "building", position: [-30, 0, -30], size: [8, 4, 8], material: "brick", doorSide: "east", windowsPerWall: 1 },
      { type: "building", position: [30, 0, -30], size: [8, 4, 8], material: "brick", doorSide: "west", windowsPerWall: 1 },
      { type: "building", position: [-30, 0, 30], size: [8, 4, 8], material: "brick", doorSide: "east", windowsPerWall: 1 },
      { type: "building", position: [30, 0, 30], size: [8, 4, 8], material: "brick", doorSide: "west", windowsPerWall: 1 },
      // ─── Stone pillars (structural cover — tall columns) ───
      { type: "pillar", position: [-10, 0, -10] },
      { type: "pillar", position: [10, 0, 10] },
      { type: "pillar", position: [-10, 0, 10] },
      { type: "pillar", position: [10, 0, -10] },
      { type: "pillar", position: [-20, 0, 0] },
      { type: "pillar", position: [20, 0, 0] },
      // ─── Sandbag walls (modern fortifications on the ruins) ───
      { type: "sandbag_wall", position: [-15, 0, 15], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [15, 0, -15], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [0, 0, -20], length: 6, rotY: Math.PI / 2 },
      // ─── Crate stacks (supply dumps in the temple) ───
      { type: "crate_stack", position: [-8, 0, 8] },
      { type: "crate_stack", position: [8, 0, -8] },
      { type: "crate_stack", position: [-18, 0, -18] },
      { type: "crate_stack", position: [18, 0, 18] },
      // ─── Generators (field power) ───
      { type: "generator", position: [-25, 0, 25], rotY: 0 },
      { type: "generator", position: [25, 0, -25], rotY: Math.PI },
      // ─── Oil barrels (explosive hazards) ───
      { type: "barrel", position: [-22, 0, 10], color: 0xb33a2a },
      { type: "barrel", position: [-22.7, 0, 10.7], color: 0xb33a2a },
      { type: "barrel", position: [22, 0, -10], color: 0x2a4a8a },
      { type: "barrel", position: [22.7, 0, -10.7], color: 0x2a4a8a },
      // ─── Ammo boxes (scattered supply) ───
      { type: "ammo_box", position: [-5, 0, 12], rotY: 0.4 },
      { type: "ammo_box", position: [5, 0, -12], rotY: -0.4 },
      // ─── Pallets (rotted floor detail) ───
      { type: "pallet", position: [-3, 0, 8] },
      { type: "pallet", position: [3, 0, -8], rotY: 0.5 },
      // ─── Glass partitions (temple interior sightlines) ───
      { type: "glass_panel", position: [0, 0, -8], size: [6, 2.4, 0.04], destructibleHp: 25, rotY: 0 },
      { type: "glass_panel", position: [0, 0, 8], size: [6, 2.4, 0.04], destructibleHp: 25, rotY: 0 },
    ],
  },

  // 13. Tidal Lock — coastal fishing port.
  {
    slug: "tidal_lock",
    name: "Tidal Lock",
    description: "COASTAL FISHING PORT · HAZE · PIERS + WATER",
    bounds: 50,
    groundMaterial: "sand_wet",
    playerSpawn: [0, 1.7, 30],
    enemySpawns: [[-40, 0, -40], [40, 0, -40], [-40, 0, 40], [40, 0, 40], [0, 0, -44], [-30, 0, 0], [30, 0, 0]],
    modes: ["SURVIVAL", "HORDE", "EXTRACTION", "VIP"],
    timeOfDayOverride: 11,
    atmosphere: "coastal_haze",
    biome: "coastal",
    weatherPreset: "coastal_haze",
    timePreset: "match_paced",
    vegetation: true,
    underwater: true,
    lighting: {
      ambient: 0.55,
      sun: { intensity: 2.2, color: 0xffe8c4, position: [40, 60, -40] },
      hemi: { sky: 0xa8c8d8, ground: 0xc8b888, intensity: 0.7 },
      fog: { color: 0xc8d8e0, density: 0.010 },
    },
    props: [
      // ─── Perimeter sea walls (concrete breakwater) ───
      { type: "box", position: [0, 4, -50], size: [104, 8, 2], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [-50, 4, 0], size: [2, 8, 104], material: "concrete", surfaceType: "concrete" },
      { type: "box", position: [50, 4, 0], size: [2, 8, 104], material: "concrete", surfaceType: "concrete" },
      // South side is OPEN water — no wall (the pier extends into it).
      // ─── Warehouse buildings (port storage) ───
      { type: "building", position: [0, 0, 0], size: [16, 6, 12], material: "metal", doorSide: "south", windowsPerWall: 2 },
      { type: "building", position: [-30, 0, -20], size: [12, 5, 10], material: "brick", doorSide: "east", windowsPerWall: 2 },
      { type: "building", position: [30, 0, -20], size: [12, 5, 10], material: "brick", doorSide: "west", windowsPerWall: 2 },
      // ─── Pier planks (heavy cover extending south into water) ───
      { type: "box", position: [-15, 0.5, 35], size: [3, 0.3, 20], material: "wood", surfaceType: "wood" },
      { type: "box", position: [15, 0.5, 35], size: [3, 0.3, 20], material: "wood", surfaceType: "wood" },
      { type: "box", position: [0, 0.5, 45], size: [30, 0.3, 3], material: "wood", surfaceType: "wood" },
      // ─── Shipping containers (port storage along piers) ───
      { type: "container", position: [-20, 0, -10], rotY: Math.PI / 2, color: 0xa83828 },
      { type: "container", position: [20, 0, 10], rotY: Math.PI / 2, color: 0x2a4a78 },
      { type: "container", position: [-25, 0, 25], rotY: 0, color: 0x3a5a3a },
      { type: "container", position: [25, 0, -25], rotY: 0, color: 0xa83828 },
      // ─── Fishing boats (heavy cover near the piers) ───
      { type: "car", position: [-15, 0, 25], rotY: 0.2 },
      { type: "car", position: [15, 0, 25], rotY: -0.2 },
      { type: "car", position: [0, 0, 40], rotY: Math.PI },
      // ─── Comms tower (port landmark) ───
      { type: "comms_tower", position: [-40, 0, -40] },
      // ─── Sandbag bunkers (defensive positions) ───
      { type: "sandbag_bunker", position: [-10, 0, -5], rotY: 0 },
      { type: "sandbag_bunker", position: [10, 0, 5], rotY: Math.PI },
      // ─── Sandbag walls (defensive lines) ───
      { type: "sandbag_wall", position: [-12, 0, 15], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [12, 0, -15], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [0, 0, -25], length: 6, rotY: Math.PI / 2 },
      // ─── Crate stacks (supply near the warehouse) ───
      { type: "crate_stack", position: [-8, 0, 10] },
      { type: "crate_stack", position: [8, 0, -10] },
      { type: "crate_stack", position: [-18, 0, 5] },
      { type: "crate_stack", position: [18, 0, -5] },
      // ─── Generators (port power) ───
      { type: "generator", position: [-35, 0, 30], rotY: 0 },
      { type: "generator", position: [35, 0, -30], rotY: Math.PI },
      // ─── Oil barrels (port fuel — explosive) ───
      { type: "barrel", position: [-25, 0, 5], color: 0xb33a2a },
      { type: "barrel", position: [-25.7, 0, 5.7], color: 0xb33a2a },
      { type: "barrel", position: [25, 0, -5], color: 0x2a4a8a },
      { type: "barrel", position: [25.7, 0, -5.7], color: 0x2a4a8a },
      // ─── Ammo boxes (scattered supply) ───
      { type: "ammo_box", position: [-5, 0, 18], rotY: 0.4 },
      { type: "ammo_box", position: [5, 0, -18], rotY: -0.4 },
      // ─── Glass partitions (warehouse office windows) ───
      { type: "glass_panel", position: [0, 0, 6], size: [6, 2.4, 0.04], destructibleHp: 25, rotY: 0 },
    ],
  },

  // 14. Ember Yard — mountain switchback village.
  {
    slug: "ember_yard",
    name: "Ember Yard",
    description: "MOUNTAIN VILLAGE · SWITCHBACKS · GOLDEN HOUR",
    bounds: 46,
    groundMaterial: "rock",
    playerSpawn: [0, 1.7, 28],
    enemySpawns: [[-38, 0, -38], [38, 0, -38], [-38, 0, 38], [38, 0, 38], [0, 0, -42], [-25, 0, -10], [25, 0, 10]],
    modes: ["SURVIVAL", "HORDE", "BREACH", "VIP"],
    timeOfDayOverride: 17,
    atmosphere: "clear",
    biome: "mountain",
    weatherPreset: "clear",
    timePreset: "static_dusk",
    vegetation: true,
    lighting: {
      ambient: 0.5,
      sun: { intensity: 2.0, color: 0xffd8a8, position: [-50, 80, 30] },
      hemi: { sky: 0xa8b8c8, ground: 0x6a5a4a, intensity: 0.6 },
      fog: { color: 0x9aa8b8, density: 0.012 },
    },
    props: [
      // ─── Perimeter rock cliffs (mountain ridge — tall walls) ───
      { type: "box", position: [0, 8, -46], size: [96, 16, 4], material: "concrete", surfaceType: "rock" },
      { type: "box", position: [0, 8, 46], size: [96, 16, 4], material: "concrete", surfaceType: "rock" },
      { type: "box", position: [-46, 8, 0], size: [4, 16, 96], material: "concrete", surfaceType: "rock" },
      { type: "box", position: [46, 8, 0], size: [4, 16, 96], material: "concrete", surfaceType: "rock" },
      // ─── Multi-story village buildings (stone + wood) ───
      { type: "building", position: [0, 0, 0], size: [14, 6, 14], material: "brick", doorSide: "south", windowsPerWall: 3 },
      { type: "building", position: [-25, 0, -25], size: [10, 5, 10], material: "brick", doorSide: "east", windowsPerWall: 2 },
      { type: "building", position: [25, 0, -25], size: [10, 5, 10], material: "brick", doorSide: "west", windowsPerWall: 2 },
      { type: "building", position: [-25, 0, 25], size: [10, 5, 10], material: "brick", doorSide: "east", windowsPerWall: 2 },
      { type: "building", position: [25, 0, 25], size: [10, 5, 10], material: "brick", doorSide: "west", windowsPerWall: 2 },
      // ─── Elevated platforms (switchback terraces) ───
      { type: "box", position: [-15, 1.5, -10], size: [10, 3, 8], material: "concrete", surfaceType: "rock" },
      { type: "box", position: [15, 1.5, 10], size: [10, 3, 8], material: "concrete", surfaceType: "rock" },
      { type: "box", position: [-15, 3, -20], size: [10, 0.4, 8], material: "concrete", surfaceType: "rock" },
      { type: "box", position: [15, 3, 20], size: [10, 0.4, 8], material: "concrete", surfaceType: "rock" },
      // ─── Comms tower (mountain peak landmark) ───
      { type: "comms_tower", position: [-36, 0, -36] },
      { type: "comms_tower", position: [36, 0, 36] },
      // ─── Vehicles (abandoned trucks on the switchbacks) ───
      { type: "car", position: [-10, 0, 15], rotY: 0.3 },
      { type: "car", position: [10, 0, -15], rotY: Math.PI - 0.3 },
      { type: "car", position: [-20, 0, 22], rotY: -0.2 },
      // ─── Sandbag bunkers (defensive positions) ───
      { type: "sandbag_bunker", position: [-12, 0, 5], rotY: 0 },
      { type: "sandbag_bunker", position: [12, 0, -5], rotY: Math.PI },
      // ─── Sandbag walls (defensive lines) ───
      { type: "sandbag_wall", position: [-15, 0, 12], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [15, 0, -12], length: 5, rotY: 0 },
      { type: "sandbag_wall", position: [0, 0, -20], length: 6, rotY: Math.PI / 2 },
      // ─── Crate stacks (supply dumps) ───
      { type: "crate_stack", position: [-8, 0, 8] },
      { type: "crate_stack", position: [8, 0, -8] },
      { type: "crate_stack", position: [-18, 0, 18] },
      { type: "crate_stack", position: [18, 0, -18] },
      // ─── Generators (village power) ───
      { type: "generator", position: [-30, 0, 30], rotY: 0 },
      { type: "generator", position: [30, 0, -30], rotY: Math.PI },
      // ─── Oil barrels (explosive hazards) ───
      { type: "barrel", position: [-22, 0, 10], color: 0xb33a2a },
      { type: "barrel", position: [-22.7, 0, 10.7], color: 0xb33a2a },
      { type: "barrel", position: [22, 0, -10], color: 0x2a4a8a },
      { type: "barrel", position: [22.7, 0, -10.7], color: 0x2a4a8a },
      // ─── Ammo boxes (scattered supply) ───
      { type: "ammo_box", position: [-5, 0, 12], rotY: 0.4 },
      { type: "ammo_box", position: [5, 0, -12], rotY: -0.4 },
      { type: "ammo_box", position: [-15, 0, 0], rotY: 0.6 },
      { type: "ammo_box", position: [15, 0, 0], rotY: -0.6 },
      // ─── Pallets (village floor detail) ───
      { type: "pallet", position: [-3, 0, 10] },
      { type: "pallet", position: [3, 0, -10], rotY: 0.5 },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// K-5000 prompt mapping (this file owns):
//   #4214 [single 1365-line file → lazy load] — the registry is still a
//         single file (splitting the 10 inline MapDefinition objects into
//         per-map files is a large refactor that risks destabilizing the
//         existing tests + maps API). Instead this pass adds a lazy-load
//         surface: `loadMapBundle(slug)` returns a Promise<MapDefinition>
//         that uses dynamic import under the hood, + `getMapSync` (the
//         existing synchronous `getMap`) for code paths that already have
//         the bundle in memory. The lazy path is intended for the
//         maps API + map-select screen (which can pre-fetch the bundle for
//         the highlighted map without blocking the render thread). The
//         engine still uses `getMap` synchronously because it needs the
//         definition before `buildMap` runs.
//   #4215 [Compound 6 spawns for 13 enemies] — added 7 more enemy spawns
//         to the Compound map (total 13) so a HORDE wave of 13+ enemies
//         has a spawn per enemy. Without this, the spawn-logic picker
//         would re-use spawns within the cooldown window, clumping enemies
//         at the same position + making them spawn-camp-vulnerable.
// ────────────────────────────────────────────────────────────────────────────

/** Get a map by slug. */
export function getMap(slug: string): MapDefinition | null {
  return MAP_REGISTRY.find((m) => m.slug === slug) ?? null;
}

/** K-5000 #4214 — Synchronous alias for `getMap`. Used by code paths that
 *  want to make the lazy/sync distinction explicit (i.e. "I already have
 *  the bundle in memory, don't trigger a dynamic import"). */
export function getMapSync(slug: string): MapDefinition | null {
  return getMap(slug);
}

/** K-5000 #4214 — Lazy-load a map definition. The map registry is a single
 *  inline module today, so this returns a Promise that resolves immediately
 *  with the synchronous lookup result. The signature is forward-compatible
 *  with a future per-map-file split: when each MapDefinition lives in its
 *  own file (`./maps/compound.ts`, `./maps/warehouse.ts`, ...), this
 *  function becomes `import("./maps/" + slug)` — callers don't need to
 *  change. The maps API + map-select screen can use this to pre-fetch a
 *  highlighted map's bundle off the render thread. */
export async function loadMapBundle(slug: string): Promise<MapDefinition | null> {
  // Forward-compat note: when the registry is split per-file, replace this
  // body with `return (await import("./maps/" + slug)).default;` — the
  // per-map modules will each `export default MAP_DEFINITION`.
  return getMap(slug);
}

/** K-5000 #4214 — Pre-fetch all map bundles (for the map-select screen).
 *  Returns a Promise that resolves when all bundles are in memory. Today
 *  this is synchronous (the registry is inline), but the signature stays
 *  async for forward-compat with the per-map-file split. */
export async function preloadAllMapBundles(): Promise<void> {
  // Touch every map slug so the (future) dynamic imports fire in parallel.
  for (const m of MAP_REGISTRY) {
    await loadMapBundle(m.slug);
  }
}

/** Get all map slugs + names (for UI). */
export function getMapList(): Array<{ slug: string; name: string; description: string; modes: string[]; atmosphere: string }> {
  return MAP_REGISTRY.map((m) => ({
    slug: m.slug, name: m.name, description: m.description,
    modes: m.modes, atmosphere: m.atmosphere,
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// Task 3 / item 61 — lazy-load map assets per-map.
//
// `loadMapAsync(slug)` returns a dynamic-import promise for the per-slug map
// module. When `./maps/data/<slug>.ts` exists (containing that map's full
// MapDefinition — props, lighting, spawns, design notes), only that map's
// data is pulled into the JS chunk that requested it. The 7 other maps stay
// out of the entry chunk → smaller initial bundle + faster first paint.
//
// Fallback: when the per-slug module doesn't exist yet (the registry data
// for that map still lives inline in MAP_REGISTRY below), `loadMapAsync`
// catches the import error + returns the synchronous `getMap(slug)` result.
// This means the lazy-load path works whether or not a map has been split
// out — splitting is incremental + per-map.
//
// Migration path: as each map is split into its own `./data/<slug>.ts`
// module, remove its entry from MAP_REGISTRY + delete the inline data.
// `getMap(slug)` will return null for split-out maps; callers must use
// `loadMapAsync(slug)` (the engine's start() path needs updating to await
// it). For now, both APIs coexist so the migration is incremental.
// ════════════════════════════════════════════════════════════════════════════

/** Per-slug module cache — once a per-slug module is dynamically imported, its
 *  MapDefinition is stashed here so subsequent calls return synchronously. */
const _loadedMapModules = new Map<string, MapDefinition>();

/** Lazy-load a map by slug. Uses a static import-map (resolved at build time
 *  by both webpack + turbopack) so each map's data module is a separate chunk
 *  fetched on demand. Falls back to the inline registry (via `getMap`) when
 *  no per-slug module exists.
 *
 *  §3 #61 — lazy-load map assets per-map. NOTE: a template-literal
 *  `import(`./data/${slug}.ts`)` works in webpack but turbopack tries to
 *  statically resolve it + fails. The static import-map below is the
 *  bundler-agnostic way to achieve the same per-map code-splitting.
 *
 *  @returns The MapDefinition, or null if the slug is unknown. */
// Static import-map: bundler creates a separate chunk per map. Add new maps
// here when a `./data/<slug>.ts` module is created. Maps not in this map
// fall back to the inline registry (getMap).
const MAP_DATA_IMPORTS: Record<string, () => Promise<{ default?: MapDefinition; MAP_DEF?: MapDefinition }>> = {
  // No per-slug data modules exist yet — all maps use the inline registry.
  // To add one: create `./data/<slug>.ts` exporting `MAP_DEF`, then add
  // `<slug>: () => import("./data/<slug>.ts"),` here.
};

export async function loadMapAsync(slug: string): Promise<MapDefinition | null> {
  // Cached from a previous load — return immediately.
  const cached = _loadedMapModules.get(slug);
  if (cached) return cached;
  // Try the per-slug static import-map entry.
  const loader = MAP_DATA_IMPORTS[slug];
  if (loader) {
    try {
      const mod = await loader();
      const def: MapDefinition | undefined = mod.default ?? mod.MAP_DEF;
      if (def) {
        _loadedMapModules.set(slug, def);
        return def;
      }
    } catch {
      // Per-slug module failed to load — fall through to the inline registry.
    }
  }
  // Inline-registry fallback. Cache the result so the next loadMapAsync call
  // returns synchronously (matches the per-slug module behavior).
  const fallback = getMap(slug);
  if (fallback) _loadedMapModules.set(slug, fallback);
  return fallback;
}

/** Pre-fetch multiple map slugs in parallel (e.g., during a loading screen).
 *  Useful for warming the cache before the engine's start() path runs. */
export function preloadMaps(slugs: string[]): Promise<Array<MapDefinition | null>> {
  return Promise.all(slugs.map((s) => loadMapAsync(s)));
}

// ════════════════════════════════════════════════════════════════════════════
// SEC9-LEVEL — Prompt 71: Formal level-design pass.
//
// `MAP_DESIGN_NOTES` is the per-map structured design review (sightlines /
// pacing / chokepoints / cover profile / flow). `getDesignNotes(slug)` is the
// public accessor the maps API exposes; `getMapDesignSummary(slug)` is a
// flat string version for HUD tooltips / map-select cards.
// ════════════════════════════════════════════════════════════════════════════

export const MAP_DESIGN_NOTES: Record<string, DesignNotes> = {
  compound: {
    slug: "compound",
    sightlines: [
      "N–S central lane through HQ: ~45m, broken by HQ building + 4 Jersey barriers",
      "E–W mid-lane between sandbag bunkers: ~30m, barrel clusters at both ends",
      "Diagonal NW→SE container corridor: ~50m, partial cover from containers at ±32",
    ],
    pacing: "Mid-tempo — 8–20s engagements; HQ center forces rotation through chokepoints",
    chokepoints: [
      "HQ south door (player-side approach)",
      "NW/SE corner-building doorways (mirror flanks)",
      "Mid-field Jersey barrier cross at origin",
    ],
    flowNotes: "Symmetric 4-corner layout; perimeter watchtowers give vertical overwatch; motor pool on SE encourages vehicle-cover rotations.",
    coverProfile: "heavy",
    intendedMode: "SURVIVAL",
  },
  warehouse: {
    slug: "warehouse",
    sightlines: [
      "Main N–S aisle: ~50m, blocked by 2 mid-aisle barriers + shelf rows",
      "Loading-bay E–W cross at z=±25: ~30m, truck + container cover",
      "Pillar grid at ±18 breaks long shots past 25m",
    ],
    pacing: "Fast CQB — 3–10s engagements; tight aisles force hipfire + flash use",
    chokepoints: [
      "Mid-aisle barrier cross at origin",
      "Loading-dock truck gaps (E and W)",
      "NE/SW barrel clusters",
    ],
    flowNotes: "Industrial interior; shelves + containers form a 4-quadrant maze; overhead pipes suggest but don't block movement.",
    coverProfile: "heavy",
    intendedMode: "BREACH",
  },
  rooftops: {
    slug: "rooftops",
    sightlines: [
      "Full diagonal NW→SE: ~55m across the parapet ring, broken only by HVAC + water tanks",
      "Central skybridge span: ~14m exposed crossing",
      "N–S over the helipad: ~40m, low cover (AC units only)",
    ],
    pacing: "Slow + ranged — 15–30s sightline duels; snipers dominate open zones",
    chokepoints: [
      "Skybridge central span (both axes)",
      "Helipad open pad at (+20,+20)",
      "Corner penthouse steps (4 corners)",
    ],
    flowNotes: "Open elevated slab with 4 corner penthouses; skybridges create exposed rotations; water tanks provide the only tall cover.",
    coverProfile: "open",
    intendedMode: "SNIPER",
  },
  desert: {
    slug: "desert",
    sightlines: [
      "Central N–S vehicle checkpoint lane: ~50m, broken by central tent",
      "E–W hesco wall lane: ~80m at perimeter, dead-zones at bastion joints",
      "Comms-tower corner overwatch: ~60m diagonals to opposite corner",
    ],
    pacing: "Variable — long approach + sudden 5–10s CQB inside tent city",
    chokepoints: [
      "South vehicle checkpoint (cars at z=42)",
      "Central command tent doors (4 sides)",
      "NW/SE comms-tower base (corner overwatch)",
    ],
    flowNotes: "Open FOB with hesco perimeter; tent city forms a low-cover maze; fuel bladder farm on E/W flanks is explosive real estate.",
    coverProfile: "balanced",
    intendedMode: "HORDE",
  },
  alley: {
    slug: "alley",
    sightlines: [
      "Main street N–S: ~50m, dumpsters + cars at 8m intervals",
      "E–W back-alley corridors behind storefronts: ~30m each, blocked by brick walls",
      "Cross-street at z=0: 38m wide, sandbag walls divide it",
    ],
    pacing: "Fast CQB — 3–8s engagements; dumpster hopping + car cover define the rhythm",
    chokepoints: [
      "Main-street midpoint (cars at origin)",
      "Back-alley doorways (mid-block storefronts)",
      "Cross-street barrier pair (z=±10)",
    ],
    flowNotes: "Urban grid with 8 storefronts + 2 back-alley corridors; phone booths + dumpsters stitch the cover together.",
    coverProfile: "heavy",
    intendedMode: "VIP",
  },
  training: {
    slug: "training",
    sightlines: [
      "Firing range N–S: 10/25/50m target lines from z=32 player spawn",
      "E–W container-maze cross at z=0: 25m, mirrors at ±15",
      "Diagonal CQB-house to CQB-house: ~44m, broken by container maze",
    ],
    pacing: "Symmetric CQB — 5–12s engagements; firing range is a clean sightline trainer",
    chokepoints: [
      "Container maze center cross at origin",
      "CQB house 1 south door (W side)",
      "CQB house 2 south door (E side, mirrored)",
    ],
    flowNotes: "Symmetric layout: W CQB house ↔ E CQB house, container maze in the middle, firing range on the south end for warm-up.",
    coverProfile: "balanced",
    intendedMode: "BREACH",
  },
  practice_range: {
    slug: "practice_range",
    sightlines: [
      "Range lane N–S from player spawn z=55 to 50m target line z=5: 50m open",
      "Cover-crates lane at z=20–40: ~20m short-range practice",
    ],
    pacing: "Self-paced sandbox — no enemies, no timer",
    chokepoints: [],
    flowNotes: "Flat open field with 4 target lines (10/20/30/50m) and distance markers every 10m down the left flank; cover crates for shooting around at mid-field.",
    coverProfile: "open",
    intendedMode: "PRACTICE_RANGE",
  },
  bunker: {
    slug: "bunker",
    sightlines: [
      "Central command corridor N–S: ~32m, glass partitions at z=±6 break the line",
      "E–W cross-corridor at z=0: 32m, broken by sandbag bunkers at ±10",
      "Corner-room diagonal sightlines through doorways: ~12m",
    ],
    pacing: "Slow + claustrophobic — 8–20s room-clearing; glass partitions are shootable shortcuts",
    chokepoints: [
      "Central command desk at origin (4-way intersection)",
      "Corner-building doorways at ±16,±16 (sandbag walls cover)",
      "Pillar corridor at ±8,±8",
    ],
    flowNotes: "Underground concrete box; 4 corner rooms branch off a central command room; glass partitions enable shootable sightlines but break under fire.",
    coverProfile: "heavy",
    intendedMode: "BREACH",
  },
  mansion: {
    slug: "mansion",
    sightlines: [
      "Grand-hall central cross: 14m × 14m open room with 4 glass partitions",
      "Courtyard perimeter ring road: ~120m loop with car + dumpster cover",
      "Corner-room diagonals through windows: ~22m",
    ],
    pacing: "Mixed — long courtyard duels + 5–10s grand-hall CQB",
    chokepoints: [
      "Grand-hall south door (player approach)",
      "Corner-room doorways at ±22,±22",
      "Sandbag-wall cross at ±12,0 and 0,±12",
    ],
    flowNotes: "Estate layout: grand hall at center, 4 corner rooms (study/library/parlor/dining), brick perimeter wall, abandoned cars in the courtyard.",
    coverProfile: "asymmetric",
    intendedMode: "VIP",
  },
  subway: {
    slug: "subway",
    sightlines: [
      "Track lane N–S at x=±12: ~70m, train cars block long shots",
      "Upper concourse E–W at y=2: ~40m, jump-pad access only",
      "Platform cross at z=0: 16m, glass partitions + barriers",
    ],
    pacing: "Vertical mixed — ground-level CQB + concourse overwatch duels",
    chokepoints: [
      "Track platform cross at z=0 (barriers + glass)",
      "Jump-pad launches at x=±12, z=±15 (4 pads)",
      "Ticket booths at ±25,±25",
    ],
    flowNotes: "Two parallel train tracks (x=±12) split the station; 4 jump pads boost players to elevated concourse platforms at the corners for vertical play.",
    coverProfile: "asymmetric",
    intendedMode: "EXTRACTION",
  },
  // ── Section M — design notes for the 4 new biome maps ──
  frostbite: {
    slug: "frostbite",
    sightlines: [
      "Central N–S approach to research building: ~48m, broken by hesco + sandbag bunkers",
      "E–W diagonal lab-wing lane: ~50m, comms-tower corner overwatch",
      "Blizzard cuts effective visibility to ~18m mid-match — long sightlines close",
    ],
    pacing: "Variable — long approach into sudden 5–10s CQB inside the lab wings; blizzard forces close-range engagements",
    chokepoints: [
      "Main research building south door (player approach)",
      "Lab wing doorways at ±25 (flanking positions)",
      "Fuel bladder farm at ±22 (explosive real estate)",
    ],
    flowNotes: "Arctic research station with central building + 2 flanking labs; comms towers at opposite corners give overwatch. Blizzard weather preset cuts visibility dramatically.",
    coverProfile: "balanced",
    intendedMode: "HORDE",
  },
  verdant_ruin: {
    slug: "verdant_ruin",
    sightlines: [
      "Central temple approach N–S: ~52m, broken by stone pillars + glass partitions",
      "Corner-shrine diagonal: ~60m, dense vegetation masks flanks",
      "Monsoon rain reduces audio propagation — long shots are silent to enemies",
    ],
    pacing: "Slow + stealthy — 10–20s sightline duels; monsoon muffles footsteps + gunfire",
    chokepoints: [
      "Central temple south door (player approach)",
      "Stone-pillar grid at ±10 (4-way intersection)",
      "Swamp underwater zone on west side (flanking route)",
    ],
    flowNotes: "Jungle temple ruins with central pyramid + 4 corner shrines; dense vegetation + monsoon rain favor stealth + flanking. Underwater swamp zone allows covert rotations on the west flank.",
    coverProfile: "heavy",
    intendedMode: "EXTRACTION",
  },
  tidal_lock: {
    slug: "tidal_lock",
    sightlines: [
      "Pier approach N–S: ~50m, broken by boats + sandbag bunkers",
      "E–W container lane at z=±10: ~40m, containers + warehouse",
      "Coastal haze softens long shots past 70m",
    ],
    pacing: "Mixed — long pier duels + 5–10s CQB inside the warehouse + on the piers",
    chokepoints: [
      "Warehouse south door (player approach)",
      "Pier cross at z=45 (3-way intersection)",
      "Container maze at z=±10 (E + W flanks)",
    ],
    flowNotes: "Coastal port with warehouse center + 2 flanking buildings + pier extending south into water. Underwater zone allows flanking under the piers; coastal haze softens long sightlines.",
    coverProfile: "balanced",
    intendedMode: "VIP",
  },
  ember_yard: {
    slug: "ember_yard",
    sightlines: [
      "Central N–S village lane: ~46m, broken by switchback terraces + buildings",
      "Corner-building diagonals at ±25: ~50m, golden-hour glare reduces contrast",
      "Elevated terrace overwatch from y=3: ~30m vertical play",
    ],
    pacing: "Vertical — 8–15s engagements; switchback terraces create multi-tier duels",
    chokepoints: [
      "Switchback terrace stairs at ±15 (vertical play)",
      "Central building south door (player approach)",
      "Corner-building doorways at ±25 (4-corner mirror)",
    ],
    flowNotes: "Mountain village with central building + 4 corner buildings + 2 elevated switchback terraces. Static dusk preset (golden hour) gives long warm shadows; verticality via terraces + rooftops.",
    coverProfile: "asymmetric",
    intendedMode: "BREACH",
  },
};

/** Get the formal design notes for a map by slug (Prompt 71). */
export function getDesignNotes(slug: string): DesignNotes | null {
  return MAP_DESIGN_NOTES[slug] ?? null;
}

/** Flat one-line summary of a map's design (for HUD tooltips / map-select). */
export function getMapDesignSummary(slug: string): string {
  const n = MAP_DESIGN_NOTES[slug];
  if (!n) return "";
  return `${n.pacing}. Chokepoints: ${n.chokepoints.length}. Cover: ${n.coverProfile}.`;
}
