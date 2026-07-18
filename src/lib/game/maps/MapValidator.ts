/**
 * SEC9-LEVEL — Prompt 71: Formal level-design validator.
 *
 * `validateMap(slug)` runs a static structural review of a registered map:
 *   1. Spawn-point safety — checks each enemy spawn against the player spawn
 *      (and a set of "common player positions" derived from cover clusters)
 *      for clear line-of-sight. Spawns with no cover between them and a
 *      common player position are flagged `unsafe`.
 *   2. Cover density per zone — divides the map into a 3×3 grid and counts
 *      the props that function as cover (solid + tall enough to crouch
 *      behind). Each zone is checked against configurable min/max bounds.
 *   3. Sightline length distribution — samples pairs of cover positions,
 *      ray-tests them for obstruction, and reports min/max/median + a
 *      histogram so the designer can see whether the map is too open or
 *      too tight.
 *
 * The validator is pure TypeScript (no THREE dependency, no scene access)
 * so it can run in Node unit tests, the maps API, or a CLI lint pass. All
 * geometry math is done with simple vector tuples + AABB intersection.
 *
 * Tunables: MIN_COVER_PER_ZONE / MAX_COVER_PER_ZONE / COVER_HEIGHT_MIN /
 * SAFE_SPAWN_MIN_DISTANCE / SAFE_SPAWN_OBSTRUCTION_HALF_EXTENT.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * K-5000 prompt mapping (this file owns):
 *   #4201 [MAX_COVER_PER_ZONE] tightened 28 → 20 (less clutter tolerance)
 *   #4202 [SAFE_SPAWN_MIN_DISTANCE] hardened 12 → 15 + explicit "min-distance
 *         violated" issue when a spawn is below SAFE_SPAWN_HARD_FLOOR (8m)
 *         even when obstructed (spawn-camping buffer)
 *   #4203 [sightline sampling cap 32 removed] — all cover props now sampled
 *         (with a soft cap SIGHTLINE_MAX_PAIRS to bound O(N²) growth on big
 *         maps; pairs are uniformly subsampled past the cap)
 *   #4204 [verticalityValidation] — new validateVerticality() audit: any map
 *         with zero props taller than VERTICALITY_MIN_HEIGHT (3m) is flagged
 *         "single-level"
 *   #4205 [navmeshGapCheck] — new validateNavmesh() audit: sample-grid the
 *         map + flood-fill walkable cells from the player spawn; any unreachable
 *         cell ≥ MIN_GAP_AREA m² is flagged a "navmesh gap"
 *   #4206 [boundaryKillVolume] — new validateBoundary() audit: every enemy
 *         spawn + every prop must lie within ±bounds; OOB spawns are flagged
 *         (engine kill-volume derives from these flags)
 *   #4207 [respawnZoneValidation] — new validateRespawnZones() audit: every
 *         enemy spawn must not be embedded inside a cover AABB (no stuck spawns)
 *   #4208 [objectiveZoneDefinition] — new validateObjectiveZones() audit:
 *         returns the per-mode objective zone (VIP waypoints / extraction zone
 *         / breach rooms / horde rally / etc.) derived from the map + modes
 *   #4209 [SIGHTLINE_AUDITS static comparison] — new
 *         compareSightlineAudits() returns per-map divergence between the
 *         static MapsAndModesEnhancements.SIGHTLINE_AUDITS table and the
 *         validator's measured longest sightline
 *   #4210 [ENV_STORYTELLING_AUDITS static comparison] — new
 *         compareEnvStorytellingAudits() returns per-map divergence between
 *         the static ENV_STORYTELLING_AUDIT table and the actual
 *         env-storytelling script prop count
 *   #4236 [sightline audit registry row] — see MapsAndModesEnhancements.MAP_AUDIT_REGISTRY
 *   #4237 [env-storytelling audit registry row] — same
 *   #4373, #4374 [cross-ref to 4236/4237]
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { MapDefinition, MapProp } from "./MapRegistry";
import { getMap, MAP_REGISTRY } from "./MapRegistry";

// ─── Tunable design constraints ──────────────────────────────────────────
const ZONE_GRID = 3; // 3×3 zones per map (9 zones total)
const MIN_COVER_PER_ZONE = 3; // below this → "too sparse"
// K-5000 #4201 — tightened 28 → 20: cluttered maps (>20 cover props per
// 3×3 zone, ~2.2 props per 100m²) consistently play as visual noise +
// degenerate into "first one to peek loses" poke-fests. 20 keeps the
// warehouse/alley "heavy" profile but flags compound/desert layouts that
// pile on too much clutter. Maps currently in-spec stay in-spec.
const MAX_COVER_PER_ZONE = 20; // above this → "too cluttered"
const COVER_HEIGHT_MIN = 0.7; // below this a prop is "decoration" not cover
// K-5000 #4202 — hardened 12 → 15: 12m is well inside the spawn-camping
// band for shotgun/CQB classes (their effective range is 12–18m); 15m
// guarantees a sprint-gap before a freshly spawned enemy can be engaged.
const SAFE_SPAWN_MIN_DISTANCE = 15; // spawns closer than this to a common
                                     // player position need LOS obstruction
// K-5000 #4202 — hard floor: even with LOS obstruction, spawns inside this
// distance are flagged as spawn-camp-vulnerable (the obstruction can be
// vaulted/flanked in <1s by a CQB-class enemy).
const SAFE_SPAWN_HARD_FLOOR = 8;
const SAFE_SPAWN_OBSTRUCTION_HALF_EXTENT = 0.6; // cover AABB inflation so
                                                 // thin walls still block
// K-5000 #4203 — sampling cap removed: every cover prop now participates
// in the sightline audit (was previously sliced to the first 32, which
// silently skipped ~80% of props on warehouse/compound). The O(N²) pair
// cost is bounded by SIGHTLINE_MAX_PAIRS via uniform subsampling past the
// cap so big maps don't blow the validator's budget.
const SIGHTLINE_SAMPLE_PAIRS = 64; // sample N×(N-1)/2 cover-pair sightlines
const SIGHTLINE_MAX_PAIRS = 4096; // soft cap — subsample uniformly past this
const SIGHTLINE_HISTOGRAM_BUCKETS = 8; // distance buckets (0..maxBound)

// K-5000 #4204 — verticality audit tunables.
const VERTICALITY_MIN_HEIGHT = 3.0; // props taller than this count as "vertical"
const VERTICALITY_MIN_COUNT = 2;    // need at least 2 vertical props for a map
                                     // to be considered multi-level

// K-5000 #4205 — navmesh gap audit tunables.
const NAVMESH_CELL_SIZE = 4;        // m per grid cell
const NAVMESH_MIN_GAP_AREA_M2 = 16; // ≥4m×4m unreachable cell → gap

// K-5000 #4206 — boundary kill-volume audit tunables.
const BOUNDARY_MARGIN_M = 2; // props/spawns must be within bounds - margin

// ─── Cover-capable prop types ────────────────────────────────────────────
// Prop types that provide gameplay cover (block bullets + conceal bodies).
// Decorative-only props (pallets, ammo boxes, jump pads, targets, glass
// panels, satellite dishes, skybridges, phone booths) are excluded.
const COVER_PROP_TYPES = new Set<MapProp["type"]>([
  "box", "destructible",
  "crate", "crate_stack", "sandbag_bunker", "barrier", "container",
  "barrel", "generator", "sandbag_wall", "barricade", "dumpster",
  "hesco", "building", "ac_unit", "water_tank", "tent", "fuel_bladder",
  "comms_tower", "car", "pillar", "shelf",
]);

/** Box3-like tuple: [minX, minY, minZ, maxX, maxY, maxZ]. */
type AABB = [number, number, number, number, number, number];

/** Vec3 tuple. */
type V3 = [number, number, number];

export interface SpawnSafetyResult {
  spawn: V3;
  safe: boolean;
  /** Reason for the verdict — informational. */
  reason: string;
  /** Distance to nearest common player position (m). */
  nearestPlayerDist: number;
  /** True if at least one cover AABB obstructs the line to nearest player pos. */
  obstructed: boolean;
}

export interface CoverZoneResult {
  /** Zone label, e.g. "NW" / "C" / "SE". */
  zone: string;
  /** Cover count in this zone. */
  count: number;
  min: number;
  max: number;
  ok: boolean;
  /** Verdict: "sparse" | "cluttered" | "ok". */
  verdict: "sparse" | "cluttered" | "ok";
}

export interface SightlineResult {
  /** Min unobstructed sightline length (m). */
  min: number;
  /** Max unobstructed sightline length (m). */
  max: number;
  /** Median sightline length (m). */
  median: number;
  /** Mean sightline length (m). */
  mean: number;
  /** Sampled count. */
  samples: number;
  /** Histogram buckets (count per distance band). */
  distribution: number[];
  /** Histogram bucket edges (m). */
  bucketEdges: number[];
}

export interface MapValidationResult {
  slug: string;
  /** Overall ok flag — true iff no issues were found. */
  ok: boolean;
  spawnSafety: SpawnSafetyResult[];
  coverDensity: CoverZoneResult[];
  sightlineLength: SightlineResult;
  /** Human-readable issue list (each entry one design defect). */
  issues: string[];
  /** Total cover prop count across all zones. */
  totalCover: number;
  /** Map bounds (m from origin). */
  bounds: number;
  // ─── K-5000 #4204–#4208 — extended audit results ───
  /** K-5000 #4204 — verticality audit. */
  verticality: VerticalityResult;
  /** K-5000 #4205 — navmesh gap audit. */
  navmesh: NavmeshResult;
  /** K-5000 #4206 — boundary kill-volume audit. */
  boundary: BoundaryResult;
  /** K-5000 #4207 — respawn-zone stuck-in-cover audit. */
  respawnZones: RespawnZoneResult[];
  /** K-5000 #4208 — per-mode objective zone definitions. */
  objectiveZones: ObjectiveZoneResult[];
}

// ─── K-5000 #4204: verticality audit types ───────────────────────────────
export interface VerticalityResult {
  /** Number of vertical props (height ≥ VERTICALITY_MIN_HEIGHT). */
  verticalPropCount: number;
  /** True iff the map has ≥ VERTICALITY_MIN_COUNT vertical props. */
  isMultiLevel: boolean;
  /** Distinct vertical levels detected (eyeballed from prop height buckets). */
  levels: number[];
}

// ─── K-5000 #4205: navmesh gap audit types ───────────────────────────────
export interface NavmeshResult {
  /** Total grid cells sampled. */
  totalCells: number;
  /** Cells reachable from the player spawn via flood-fill. */
  reachableCells: number;
  /** Unreachable cells (gaps) ≥ NAVMESH_MIN_GAP_AREA_M2. */
  gaps: Array<{ x: number; z: number; area: number }>;
  /** True iff no gaps found. */
  ok: boolean;
}

// ─── K-5000 #4206: boundary kill-volume audit types ──────────────────────
export interface BoundaryResult {
  /** Enemy spawns beyond bounds - BOUNDARY_MARGIN_M. */
  outOfBoundsSpawns: V3[];
  /** Props beyond bounds - BOUNDARY_MARGIN_M. */
  outOfBoundsProps: Array<{ type: string; position: V3 }>;
  /** True iff no OOB items found. */
  ok: boolean;
}

// ─── K-5000 #4207: respawn-zone stuck-in-cover audit types ───────────────
export interface RespawnZoneResult {
  spawn: V3;
  /** True iff the spawn is embedded inside a cover AABB (stuck). */
  stuck: boolean;
  /** Prop type the spawn is stuck inside (if any). */
  stuckIn?: string;
}

// ─── K-5000 #4208: per-mode objective zone definition types ──────────────
export interface ObjectiveZoneResult {
  /** Mode this objective applies to. */
  mode: string;
  /** Objective zone archetype (engine reads this to build the in-world zone). */
  type:
    | "extraction_zone"   // EXTRACTION — cylinder trigger zone
    | "vip_waypoints"     // VIP — ordered waypoint list
    | "breach_rooms"      // BREACH — ordered room list (corner buildings)
    | "horde_rally"       // HORDE — central rally point (player-defended)
    | "zombies_rally"     // ZOMBIES — central rally point
    | "survival_arena"    // SURVIVAL — full arena (no specific zone)
    | "tdm_spawns"        // TDM — two team spawn clusters
    | "sd_bomb_sites"     // S&D — two bomb-site zones
    | "dom_flags"         // DOM — 3 flag capture zones
    | "gungame_spawn"     // GUN_GAME — single FFA spawn pool
    | "practice_sandbox"; // PRACTICE_RANGE — full sandbox
  /** World positions defining the zone (semantic depends on `type`). */
  positions: V3[];
  /** Radius (m) for circular zones; ignored for list types. */
  radius?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Conservative default size for a prop type if size isn't specified. */
function defaultPropSize(type: MapProp["type"]): [number, number, number] {
  switch (type) {
    case "crate":            return [1.2, 1.2, 1.2];
    case "ammo_box":         return [0.6, 0.4, 0.4];
    case "sandbag_bunker":   return [4, 1.0, 3];
    case "barrier":          return [2, 1.1, 0.5];
    case "hesco":            return [4, 1.6, 2];
    case "container":        return [6, 2.6, 2.5];
    case "barrel":           return [0.6, 1.0, 0.6];
    case "pallet":           return [1.2, 0.14, 0.8];
    case "generator":        return [1.4, 1.1, 0.9];
    case "sandbag_wall":     return [4, 1.0, 0.6];
    case "barricade":        return [1.8, 1.0, 0.4];
    case "dumpster":         return [1.8, 1.4, 1.2];
    case "crate_stack":      return [1.8, 2.0, 1.8];
    case "building":         return [8, 4, 8];
    case "ac_unit":          return [1.6, 1.2, 1.2];
    case "water_tank":       return [2, 3, 2];
    case "satellite":        return [2, 3, 2];
    case "tent":             return [4, 2.6, 4];
    case "fuel_bladder":     return [3, 1.2, 2];
    case "comms_tower":      return [2, 12, 2];
    case "car":              return [4.4, 1.6, 2];
    case "phone_booth":      return [0.9, 2.1, 0.9];
    case "target":           return [0.6, 1.7, 0.05];
    case "pillar":           return [1, 4, 1];
    case "shelf":            return [4, 2.2, 0.6];
    case "skybridge":        return [3, 0.4, 10];
    case "glass_panel":      return [4, 2.4, 0.04];
    case "jump_pad":         return [1.2, 0.2, 1.2];
    case "cylinder":         return [0.6, 1, 0.6];
    case "destructible":
    case "box":
    default:                 return [1, 1, 1];
  }
}

/** Compute an AABB for a prop. Uses size if provided, else defaultPropSize. */
function propAABB(prop: MapProp): AABB {
  const [x, y, z] = prop.position;
  // For sandbag_wall / skybridge the `length` field overrides the Z extent.
  let size: [number, number, number] = prop.size ?? defaultPropSize(prop.type);
  if ((prop.type === "sandbag_wall" || prop.type === "skybridge") && prop.length) {
    size = [size[0], size[1], prop.length];
  }
  const half = [size[0] / 2, size[1] / 2, size[2] / 2];
  return [x - half[0], y - half[1], z - half[2], x + half[0], y + size[1] / 2, z + half[2]];
}

/** Slab (ray-AABB) intersection test for a 3D segment vs an AABB.
 *  Returns true if the segment passes through the box. */
function segmentIntersectsAABB(
  a: V3, b: V3, box: AABB,
): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  let tmin = 0, tmax = 1;
  // X slab
  for (let i = 0; i < 3; i++) {
    const d = i === 0 ? dx : i === 1 ? dy : dz;
    const lo = box[i], hi = box[i + 3];
    if (Math.abs(d) < 1e-8) {
      // Parallel — no hit if origin outside slab.
      if (a[i] < lo || a[i] > hi) return false;
    } else {
      let t1 = (lo - a[i]) / d;
      let t2 = (hi - a[i]) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return tmax >= 0;
}

/** Distance between two V3 tuples. */
function dist(a: V3, b: V3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Zone label from grid coords (0..ZONE_GRID-1). */
function zoneLabel(gx: number, gz: number): string {
  const xName = gx === 0 ? "W" : gx === ZONE_GRID - 1 ? "E" : "";
  const zName = gz === 0 ? "N" : gz === ZONE_GRID - 1 ? "S" : "";
  if (!xName && !zName) return "C";
  return `${zName}${xName}`;
}

/** Derive a set of "common player positions" the spawn-safety check uses.
 *  Includes:
 *    - The map's player spawn
 *    - Cover-cluster centroids (avg of nearby cover positions) — players
 *      naturally gravitate to cover, so a spawn that has LOS to a cover
 *      cluster is spawn-campable.
 *  Returns at most ~6 positions to keep the check cheap. */
function deriveCommonPlayerPositions(map: MapDefinition): V3[] {
  const positions: V3[] = [[map.playerSpawn[0], map.playerSpawn[1] + 1.0, map.playerSpawn[2]]];
  const cover = map.props.filter(isCoverProp);
  // Bucket cover into ~4 clusters by quadrant around the map center.
  const clusters: V3[] = [];
  const clusterThreshold = map.bounds * 0.4;
  for (const p of cover) {
    const pos: V3 = [p.position[0], 1.0, p.position[2]];
    let added = false;
    for (const c of clusters) {
      if (dist(pos, c) < clusterThreshold) {
        // Move the cluster centroid toward this prop (running average).
        c[0] = (c[0] + pos[0]) / 2;
        c[2] = (c[2] + pos[2]) / 2;
        added = true;
        break;
      }
    }
    if (!added) clusters.push(pos);
    if (clusters.length >= 5) break;
  }
  positions.push(...clusters);
  return positions;
}

/** Predicate: does this prop count as gameplay cover? */
function isCoverProp(p: MapProp): boolean {
  if (!COVER_PROP_TYPES.has(p.type)) return false;
  const size = p.size ?? defaultPropSize(p.type);
  // Use the prop's effective height (with sandbag_wall length override).
  let h = size[1];
  if ((p.type === "sandbag_wall" || p.type === "skybridge") && p.length) h = size[1];
  return h >= COVER_HEIGHT_MIN;
}

// ─── Public: validateMap ─────────────────────────────────────────────────

/** Validate a map by slug. Returns null if the slug is unknown. */
export function validateMap(slug: string): MapValidationResult | null {
  const map = getMap(slug);
  if (!map) return null;
  return validateMapDefinition(map);
}

/** Validate a MapDefinition directly (useful for tests + future editor). */
export function validateMapDefinition(map: MapDefinition): MapValidationResult {
  const issues: string[] = [];

  // ─── Common player positions for spawn-safety check ───
  const playerPositions = deriveCommonPlayerPositions(map);

  // Pre-compute cover AABBs (also used for sightline obstruction tests).
  const coverProps = map.props.filter(isCoverProp);
  const coverAABBs = coverProps.map(propAABB);

  // ─── 1. Spawn-point safety ───
  const spawnSafety: SpawnSafetyResult[] = map.enemySpawns.map((spawn) => {
    let nearest = playerPositions[0];
    let nearestD = dist(spawn as V3, nearest);
    for (const p of playerPositions) {
      const d = dist(spawn as V3, p);
      if (d < nearestD) { nearestD = d; nearest = p; }
    }
    // If spawn is far from any player position, it's safe.
    if (nearestD >= SAFE_SPAWN_MIN_DISTANCE * 2.5) {
      return { spawn: spawn as V3, safe: true, reason: "far from common player positions", nearestPlayerDist: nearestD, obstructed: false };
    }
    // Check obstruction by every cover AABB.
    let obstructed = false;
    for (const box of coverAABBs) {
      // Skip boxes whose center is at the spawn or the player pos (they're
      // the standing-on prop, not between them).
      const cx = (box[0] + box[3]) / 2;
      const cz = (box[2] + box[5]) / 2;
      if (Math.hypot(cx - spawn[0], cz - spawn[2]) < 1.0) continue;
      if (Math.hypot(cx - nearest[0], cz - nearest[2]) < 1.0) continue;
      if (segmentIntersectsAABB(spawn as V3, nearest, box)) {
        obstructed = true;
        break;
      }
    }
    const safe = obstructed || nearestD >= SAFE_SPAWN_MIN_DISTANCE;
    // K-5000 #4202 — hard floor: even obstructed spawns inside
    // SAFE_SPAWN_HARD_FLOOR are spawn-camp-vulnerable (the obstruction
    // can be vaulted/flanked in <1s). Push a separate issue for these.
    if (nearestD < SAFE_SPAWN_HARD_FLOOR) {
      issues.push(`Spawn ${spawn.join(",")} is inside the spawn-camp hard floor (${nearestD.toFixed(1)}m < ${SAFE_SPAWN_HARD_FLOOR}m) — obstruction is not a reliable defense.`);
    }
    let reason: string;
    if (safe && obstructed) reason = "obstructed by cover between spawn and player";
    else if (safe) reason = "outside spawn-camp distance";
    else reason = "UNSAFE: clear LOS to a common player position within spawn-camp range";
    if (!safe) issues.push(`Spawn ${spawn.join(",")} has clear LOS to a common player position (${nearestD.toFixed(1)}m away).`);
    return { spawn: spawn as V3, safe, reason, nearestPlayerDist: nearestD, obstructed };
  });

  // ─── 2. Cover density per zone ───
  const step = (map.bounds * 2) / ZONE_GRID;
  const zones: CoverZoneResult[] = [];
  for (let gx = 0; gx < ZONE_GRID; gx++) {
    for (let gz = 0; gz < ZONE_GRID; gz++) {
      const x0 = -map.bounds + gx * step;
      const z0 = -map.bounds + gz * step;
      const x1 = x0 + step;
      const z1 = z0 + step;
      let count = 0;
      for (const p of coverProps) {
        const [px, , pz] = p.position;
        if (px >= x0 && px < x1 && pz >= z0 && pz < z1) count++;
      }
      let verdict: "sparse" | "cluttered" | "ok" = "ok";
      if (count < MIN_COVER_PER_ZONE) verdict = "sparse";
      else if (count > MAX_COVER_PER_ZONE) verdict = "cluttered";
      const ok = verdict === "ok";
      if (!ok) {
        issues.push(`Zone ${zoneLabel(gx, gz)} cover count ${count} is ${verdict} (target ${MIN_COVER_PER_ZONE}..${MAX_COVER_PER_ZONE}).`);
      }
      zones.push({
        zone: zoneLabel(gx, gz),
        count,
        min: MIN_COVER_PER_ZONE,
        max: MAX_COVER_PER_ZONE,
        ok,
        verdict,
      });
    }
  }

  // ─── 3. Sightline length distribution ───
  // K-5000 #4203 — sampling cap removed. Every cover prop now participates
  // in the sightline audit. Previously the slice(0, 32) silently skipped
  // ~80% of props on warehouse/compound (which have 40-100 cover props),
  // so the "longest sightline" + "distribution" fields under-reported the
  // map's true sightline profile. The O(N²) pair cost is bounded by
  // SIGHTLINE_MAX_PAIRS via uniform subsampling past the cap.
  const coverPositions: V3[] = coverProps.map(
    (p) => [p.position[0], 1.4, p.position[2]] as V3, // eye height when standing at cover
  );
  const sightlines: number[] = [];
  const seen = new Set<number>();
  // K-5000 #4203 — count total candidate pairs so we know whether to subsample.
  const totalPairs = (coverPositions.length * (coverPositions.length - 1)) / 2;
  // Stride for uniform subsampling when totalPairs > SIGHTLINE_MAX_PAIRS.
  const stride = totalPairs > SIGHTLINE_MAX_PAIRS
    ? Math.ceil(totalPairs / SIGHTLINE_MAX_PAIRS)
    : 1;
  let pairIndex = 0;
  for (let i = 0; i < coverPositions.length; i++) {
    for (let j = i + 1; j < coverPositions.length; j++) {
      // K-5000 #4203 — uniform subsample past the soft cap.
      if (stride > 1 && (pairIndex % stride) !== 0) { pairIndex++; continue; }
      pairIndex++;
      const key = i * 1000 + j;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = coverPositions[i];
      const b = coverPositions[j];
      const d = dist(a, b);
      // Too close to count as a sightline.
      if (d < 2) continue;
      // Check obstruction by every cover AABB (excluding the two endpoints).
      let obstructed = false;
      for (let k = 0; k < coverAABBs.length; k++) {
        const box = coverAABBs[k];
        const cx = (box[0] + box[3]) / 2;
        const cz = (box[2] + box[5]) / 2;
        // Skip the boxes whose center matches endpoint a or b.
        if (Math.hypot(cx - a[0], cz - a[2]) < 1.5) continue;
        if (Math.hypot(cx - b[0], cz - b[2]) < 1.5) continue;
        if (segmentIntersectsAABB(a, b, box)) {
          obstructed = true;
          break;
        }
      }
      if (!obstructed) sightlines.push(d);
    }
  }
  sightlines.sort((a, b) => a - b);
  const maxBound = map.bounds * 2.4;
  const bucketWidth = maxBound / SIGHTLINE_HISTOGRAM_BUCKETS;
  const distribution = new Array(SIGHTLINE_HISTOGRAM_BUCKETS).fill(0);
  const bucketEdges: number[] = [];
  for (let i = 0; i < SIGHTLINE_HISTOGRAM_BUCKETS; i++) {
    bucketEdges.push(+(bucketWidth * (i + 1)).toFixed(1));
  }
  for (const d of sightlines) {
    let bucket = Math.floor(d / bucketWidth);
    if (bucket >= SIGHTLINE_HISTOGRAM_BUCKETS) bucket = SIGHTLINE_HISTOGRAM_BUCKETS - 1;
    distribution[bucket]++;
  }
  const median = sightlines.length > 0
    ? sightlines[Math.floor(sightlines.length / 2)]
    : 0;
  const mean = sightlines.length > 0
    ? sightlines.reduce((s, d) => s + d, 0) / sightlines.length
    : 0;
  const sightlineLength: SightlineResult = {
    min: sightlines.length > 0 ? sightlines[0] : 0,
    max: sightlines.length > 0 ? sightlines[sightlines.length - 1] : 0,
    median,
    mean,
    samples: sightlines.length,
    distribution,
    bucketEdges,
  };

  // ─── Issues from sightline distribution ───
  if (sightlines.length > 0) {
    // If >40% of sightlines are >40m, the map is "too open".
    const longCount = sightlines.filter((d) => d > 40).length;
    if (longCount / sightlines.length > 0.4) {
      issues.push(`Sightline distribution is too open — ${longCount}/${sightlines.length} sightlines exceed 40m.`);
    }
    // If >60% of sightlines are <8m, the map is "too tight".
    const shortCount = sightlines.filter((d) => d < 8).length;
    if (shortCount / sightlines.length > 0.6) {
      issues.push(`Sightline distribution is too tight — ${shortCount}/${sightlines.length} sightlines are under 8m.`);
    }
  }

  // ─── K-5000 #4204: verticality audit ───
  const verticality = validateVerticality(map);

  // ─── K-5000 #4205: navmesh gap audit ───
  const navmesh = validateNavmesh(map, coverAABBs);

  // ─── K-5000 #4206: boundary kill-volume audit ───
  const boundary = validateBoundary(map);

  // ─── K-5000 #4207: respawn-zone stuck-in-cover audit ───
  const respawnZones = validateRespawnZones(map, coverAABBs);
  for (const r of respawnZones) {
    if (r.stuck) {
      issues.push(`Spawn ${r.spawn.join(",")} is embedded inside a ${r.stuckIn ?? "cover"} AABB — enemies will spawn stuck.`);
    }
  }

  // ─── K-5000 #4208: per-mode objective zone definitions ───
  const objectiveZones = validateObjectiveZones(map);

  if (!verticality.isMultiLevel) {
    issues.push(`Map has only ${verticality.verticalPropCount} vertical props (need ≥ ${VERTICALITY_MIN_COUNT} ≥ ${VERTICALITY_MIN_HEIGHT}m tall) — single-level layout.`);
  }
  if (!navmesh.ok) {
    issues.push(`Navmesh has ${navmesh.gaps.length} unreachable gap(s) ≥ ${NAVMESH_MIN_GAP_AREA_M2}m² (${navmesh.gaps.length}/${navmesh.totalCells} cells unreachable).`);
  }
  if (!boundary.ok) {
    issues.push(`Boundary: ${boundary.outOfBoundsSpawns.length} OOB spawns, ${boundary.outOfBoundsProps.length} OOB props (outside ±${map.bounds - BOUNDARY_MARGIN_M}m).`);
  }

  return {
    slug: map.slug,
    ok: issues.length === 0,
    spawnSafety,
    coverDensity: zones,
    sightlineLength,
    issues,
    totalCover: coverProps.length,
    bounds: map.bounds,
    verticality,
    navmesh,
    boundary,
    respawnZones,
    objectiveZones,
  };
}

// ─── K-5000 #4204: verticality audit implementation ──────────────────────
/** Returns the count of props whose effective height ≥ VERTICALITY_MIN_HEIGHT.
 *  These are the props that give a map vertical play (rooftops, watchtowers,
 *  skybridges, multi-story buildings, etc.). */
function validateVerticality(map: MapDefinition): VerticalityResult {
  let verticalPropCount = 0;
  const levelSet = new Set<number>();
  for (const p of map.props) {
    const size = p.size ?? defaultPropSize(p.type);
    let h = size[1];
    if ((p.type === "sandbag_wall" || p.type === "skybridge") && p.length) {
      h = size[1];
    }
    if (h >= VERTICALITY_MIN_HEIGHT) {
      verticalPropCount++;
      // Bucket the height into 1m levels so we can report distinct levels.
      levelSet.add(Math.floor(h));
    }
    // Comms towers + water tanks + buildings are inherently vertical even
    // when their explicit size.y is < VERTICALITY_MIN_HEIGHT (defaults).
    if (p.type === "comms_tower" || p.type === "water_tank" || p.type === "building") {
      verticalPropCount++;
      levelSet.add(Math.floor(defaultPropSize(p.type)[1]));
    }
  }
  const levels = Array.from(levelSet).sort((a, b) => a - b);
  return {
    verticalPropCount,
    isMultiLevel: verticalPropCount >= VERTICALITY_MIN_COUNT,
    levels,
  };
}

// ─── K-5000 #4205: navmesh gap audit implementation ──────────────────────
/** Grid-flood-fill reachability from the player spawn. Any cell ≥
 *  NAVMESH_MIN_GAP_AREA_M2 that isn't reachable is a navmesh gap (the engine
 *  would route enemies into it and they'd get stuck against the cover AABB). */
function validateNavmesh(map: MapDefinition, coverAABBs: AABB[]): NavmeshResult {
  const cellSize = NAVMESH_CELL_SIZE;
  const extent = map.bounds;
  const cellsPerSide = Math.ceil((extent * 2) / cellSize);
  // Walkable[cellIndex] = true if no cover AABB overlaps the cell center.
  const totalCells = cellsPerSide * cellsPerSide;
  const walkable = new Uint8Array(totalCells);
  for (let gx = 0; gx < cellsPerSide; gx++) {
    for (let gz = 0; gz < cellsPerSide; gz++) {
      const wx = -extent + (gx + 0.5) * cellSize;
      const wz = -extent + (gz + 0.5) * cellSize;
      let blocked = false;
      for (const box of coverAABBs) {
        if (wx >= box[0] && wx <= box[3] && wz >= box[2] && wz <= box[5]) {
          blocked = true;
          break;
        }
      }
      walkable[gx * cellsPerSide + gz] = blocked ? 0 : 1;
    }
  }
  // Flood-fill from the player spawn cell.
  const playerCellX = Math.floor((map.playerSpawn[0] + extent) / cellSize);
  const playerCellZ = Math.floor((map.playerSpawn[2] + extent) / cellSize);
  const reachable = new Uint8Array(totalCells);
  if (playerCellX >= 0 && playerCellX < cellsPerSide && playerCellZ >= 0 && playerCellZ < cellsPerSide) {
    const queue: number[] = [playerCellX * cellsPerSide + playerCellZ];
    reachable[queue[0]] = 1;
    while (queue.length > 0) {
      const idx = queue.shift()!;
      const cx = Math.floor(idx / cellsPerSide);
      const cz = idx % cellsPerSide;
      // 4-connected.
      const neighbors: Array<[number, number]> = [[cx - 1, cz], [cx + 1, cz], [cx, cz - 1], [cx, cz + 1]];
      for (const [nx, nz] of neighbors) {
        if (nx < 0 || nx >= cellsPerSide || nz < 0 || nz >= cellsPerSide) continue;
        const nidx = nx * cellsPerSide + nz;
        if (reachable[nidx] || !walkable[nidx]) continue;
        reachable[nidx] = 1;
        queue.push(nidx);
      }
    }
  }
  // Collect gaps: walkable cells that aren't reachable, clustered by adjacency.
  // For the audit we report each unreachable walkable cell as a gap entry;
  // the area is the cell size squared (gap area is approximate).
  const gaps: Array<{ x: number; z: number; area: number }> = [];
  let reachableCount = 0;
  for (let gx = 0; gx < cellsPerSide; gx++) {
    for (let gz = 0; gz < cellsPerSide; gz++) {
      const idx = gx * cellsPerSide + gz;
      if (reachable[idx]) { reachableCount++; continue; }
      if (walkable[idx]) {
        gaps.push({
          x: -extent + (gx + 0.5) * cellSize,
          z: -extent + (gz + 0.5) * cellSize,
          area: cellSize * cellSize,
        });
      }
    }
  }
  return {
    totalCells,
    reachableCells: reachableCount,
    gaps: gaps.filter((g) => g.area >= NAVMESH_MIN_GAP_AREA_M2),
    ok: gaps.length === 0,
  };
}

// ─── K-5000 #4206: boundary kill-volume audit implementation ─────────────
/** Returns spawns + props that lie outside ±(bounds - BOUNDARY_MARGIN_M).
 *  The engine's boundary kill volume uses this list to either relocate the
 *  spawn (preferred) or apply a soft kill (OOB damage-over-time) at runtime. */
function validateBoundary(map: MapDefinition): BoundaryResult {
  const limit = map.bounds - BOUNDARY_MARGIN_M;
  const outOfBoundsSpawns: V3[] = [];
  for (const s of map.enemySpawns) {
    if (Math.abs(s[0]) > limit || Math.abs(s[2]) > limit) {
      outOfBoundsSpawns.push([s[0], s[1], s[2]]);
    }
  }
  const outOfBoundsProps: Array<{ type: string; position: V3 }> = [];
  for (const p of map.props) {
    if (Math.abs(p.position[0]) > limit || Math.abs(p.position[2]) > limit) {
      outOfBoundsProps.push({ type: p.type, position: [p.position[0], p.position[1], p.position[2]] });
    }
  }
  return {
    outOfBoundsSpawns,
    outOfBoundsProps,
    ok: outOfBoundsSpawns.length === 0 && outOfBoundsProps.length === 0,
  };
}

// ─── K-5000 #4207: respawn-zone stuck-in-cover audit implementation ──────
/** For each enemy spawn, check if it lies inside any cover AABB. A stuck
 *  spawn means the enemy will spawn clipped into a prop + the physics
 *  solver will eject them in an unpredictable direction (often into the
 *  player's LOS). */
function validateRespawnZones(map: MapDefinition, coverAABBs: AABB[]): RespawnZoneResult[] {
  return map.enemySpawns.map((s) => {
    const spawn: V3 = [s[0], s[1], s[2]];
    for (let i = 0; i < coverAABBs.length; i++) {
      const box = coverAABBs[i];
      // Only flag if the spawn is inside the XZ footprint AND below the
      // box's top (so spawns on top of crates aren't flagged).
      if (
        s[0] >= box[0] && s[0] <= box[3] &&
        s[2] >= box[2] && s[2] <= box[5] &&
        s[1] < box[4]
      ) {
        return { spawn, stuck: true, stuckIn: map.props[i]?.type ?? "cover" };
      }
    }
    return { spawn, stuck: false };
  });
}

// ─── K-5000 #4208: per-mode objective zone definitions ───────────────────
/** Derives objective zones from the map + its declared modes. The engine
 *  reads the `type` + `positions` to build the in-world zone geometry
 *  (cylinder trigger for extraction, waypoint list for VIP, room list for
 *  breach, etc.). */
function validateObjectiveZones(map: MapDefinition): ObjectiveZoneResult[] {
  const out: ObjectiveZoneResult[] = [];
  for (const mode of map.modes) {
    switch (mode) {
      case "SURVIVAL":
        out.push({
          mode,
          type: "survival_arena",
          positions: [[0, 0, 0]],
          radius: map.bounds,
        });
        break;
      case "EXTRACTION":
        // Intel at one corner, extraction zone at the opposite corner.
        out.push({
          mode,
          type: "extraction_zone",
          positions: [[-map.bounds * 0.6, 0, -map.bounds * 0.6], [map.bounds * 0.6, 0, map.bounds * 0.6]],
          radius: 3,
        });
        break;
      case "VIP":
        // 4 waypoints around the arena center (matches MissionSystem.buildVip).
        out.push({
          mode,
          type: "vip_waypoints",
          positions: [[0, 0, 12], [-15, 0, 0], [0, 0, -12], [15, 0, 0]],
        });
        break;
      case "BREACH":
        // 5 rooms — 4 corner buildings + central HQ.
        out.push({
          mode,
          type: "breach_rooms",
          positions: [
            [-25, 0, -25], [25, 0, -25], [-25, 0, 25], [25, 0, 25], [0, 0, 0],
          ],
        });
        break;
      case "HORDE":
        out.push({ mode, type: "horde_rally", positions: [[0, 0, 0]], radius: map.bounds * 0.4 });
        break;
      case "ZOMBIES":
        out.push({ mode, type: "zombies_rally", positions: [[0, 0, 0]], radius: map.bounds * 0.4 });
        break;
      case "TDM":
        // K-5000 #4218 — two team spawn clusters (N + S).
        out.push({
          mode,
          type: "tdm_spawns",
          positions: [[0, 0, -map.bounds * 0.7], [0, 0, map.bounds * 0.7]],
          radius: 8,
        });
        break;
      case "SND":
        // K-5000 #4219 — two bomb sites (A=NE, B=SW).
        out.push({
          mode,
          type: "sd_bomb_sites",
          positions: [[map.bounds * 0.5, 0, map.bounds * 0.5], [-map.bounds * 0.5, 0, -map.bounds * 0.5]],
          radius: 4,
        });
        break;
      case "DOMINATION":
        // K-5000 #4220 — 3 flag capture zones (A=center, B=N, C=S).
        out.push({
          mode,
          type: "dom_flags",
          positions: [[0, 0, 0], [0, 0, -map.bounds * 0.5], [0, 0, map.bounds * 0.5]],
          radius: 4,
        });
        break;
      case "GUN_GAME":
        // K-5000 #4221 — single FFA spawn pool (the map's enemySpawns).
        out.push({
          mode,
          type: "gungame_spawn",
          positions: map.enemySpawns.map((s) => [s[0], s[1], s[2]] as V3),
        });
        break;
      case "PRACTICE_RANGE":
        out.push({ mode, type: "practice_sandbox", positions: [[0, 0, 0]], radius: map.bounds });
        break;
      default:
        // Unknown mode — record as a generic arena zone.
        out.push({ mode, type: "survival_arena", positions: [[0, 0, 0]], radius: map.bounds });
    }
  }
  return out;
}

/** Validate all registered maps. Returns a record keyed by slug. */
export function validateAllMaps(): Record<string, MapValidationResult> {
  const out: Record<string, MapValidationResult> = {};
  for (const m of MAP_REGISTRY) {
    const res = validateMapDefinition(m);
    out[m.slug] = res;
  }
  return out;
}

// ─── K-5000 #4209: SIGHTLINE_AUDITS static comparison ────────────────────
// Compares the static SIGHTLINE_AUDITS table from MapsAndModesEnhancements
// against the validator's measured longest sightline. Returns per-map
// divergence rows so the design dashboard can flag stale static data.
export interface SightlineAuditDivergence {
  mapId: string;
  /** Static "longest sightline" value from SIGHTLINE_AUDITS. */
  staticLongest: number;
  /** Measured longest sightline from the validator. */
  measuredLongest: number;
  /** Absolute delta (m). */
  delta: number;
  /** True iff |delta| > 10m — flagged as stale. */
  stale: boolean;
}

// Lazy-load the static audits table to avoid a hard runtime dependency
// cycle (MapsAndModesEnhancements imports nothing from maps/ — but to keep
// the validator pure-TS we use a deferred getter).
type SightlineAuditRow = { mapId: string; longestSightline: number; imbalanceFlag: boolean; recommendation: string };

/** K-5000 #4209 — compare the static SIGHTLINE_AUDITS table against the
 *  validator's measured longest sightline. Caller passes the static table
 *  (avoids a hard circular import). */
export function compareSightlineAudits(
  staticAudits: SightlineAuditRow[],
): SightlineAuditDivergence[] {
  const out: SightlineAuditDivergence[] = [];
  for (const row of staticAudits) {
    const validation = validateMap(row.mapId);
    const measured = validation?.sightlineLength.max ?? 0;
    const delta = measured - row.longestSightline;
    out.push({
      mapId: row.mapId,
      staticLongest: row.longestSightline,
      measuredLongest: measured,
      delta,
      stale: Math.abs(delta) > 10,
    });
  }
  return out;
}

// ─── K-5000 #4210: ENV_STORYTELLING_AUDITS static comparison ─────────────
export interface EnvStorytellingDivergence {
  mapId: string;
  /** Static "propCount" from ENV_STORYTELLING_AUDIT. */
  staticPropCount: number;
  /** Measured prop count from the env-storytelling script. */
  measuredPropCount: number;
  /** Absolute delta. */
  delta: number;
  /** True iff the static table says "used=true" but the script is empty (or vice versa). */
  stale: boolean;
}

type EnvStorytellingAuditRow = { mapId: string; used: boolean; propCount: number };

/** K-5000 #4210 — compare the static ENV_STORYTELLING_AUDIT table against
 *  the actual env-storytelling script's prop count. Caller passes the
 *  static table + a getter for the script prop count (avoids a hard
 *  circular import with the level/ module). */
export function compareEnvStorytellingAudits(
  staticAudits: EnvStorytellingAuditRow[],
  getScriptPropCount: (mapSlug: string) => number,
): EnvStorytellingDivergence[] {
  const out: EnvStorytellingDivergence[] = [];
  for (const row of staticAudits) {
    const measured = getScriptPropCount(row.mapId);
    const delta = measured - row.propCount;
    out.push({
      mapId: row.mapId,
      staticPropCount: row.propCount,
      measuredPropCount: measured,
      delta,
      // Stale if the static says "used=true" but no script props exist,
      // OR if the static propCount is off by >3.
      stale: (row.used && measured === 0) || (!row.used && measured > 0) || Math.abs(delta) > 3,
    });
  }
  return out;
}
