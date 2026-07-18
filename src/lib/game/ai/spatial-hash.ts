/**
 * Section D #533–534 — Spatial hash + scoped LOS raycasts.
 *
 * #533 — Replace O(n²) AI vision checks with a spatial hash. Each AI's
 * "who can I see" query is O(n) over the bucket of nearby entities instead
 * of O(n) over all entities (where n is the total enemy count). At 30
 * enemies × 30 enemies × 60fps, the O(n²) check is 54k checks/sec; with
 * the spatial hash, the average bucket size is 2–4, so it drops to ~7k.
 *
 * #534 — Scope LOS raycasts to environment targets only. The existing
 * raycast-env.ts already scopes LOS to environment colliders (not the full
 * scene.children); this module provides a higher-level API the AI uses to
 * batch-resolve LOS for all enemies-of-interest in one pass. The spatial
 * hash returns the candidate set; the LOS batcher raycasts each candidate
 * against ctx.colliders (the same env-only collider set).
 *
 * Pure-TS, no THREE import at module load (the only THREE use is in the
 * Vector3 type for the hash key — we use plain numbers). SSR-safe.
 */

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface SpatialEntity {
  /** Unique ID (for dedup). */
  id: string | number;
  /** World position (XZ plane — Y is ignored for the spatial hash). */
  x: number;
  y: number;
  z: number;
  /** Team — used by the LOS query to filter targets. */
  team: "player" | "enemy" | "neutral";
  /** Alive flag — dead entities are pruned on rebuild. */
  alive: boolean;
  /** Optional radius (for "entities within R of me" queries). */
  radius?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Spatial hash
// ───────────────────────────────────────────────────────────────────────────

/** Cell size (meters). Determines the bucket granularity. Smaller = more
 *  buckets but smaller per-bucket sets; larger = fewer buckets but bigger
 *  sets. 8m matches the typical engagement range band — a single bucket
 *  covers the entities in a 8m × 8m tile. */
const CELL_SIZE = 8;
const CELL_SIZE_INV = 1 / CELL_SIZE;

export class SpatialHash<T extends SpatialEntity> {
  private buckets = new Map<number, T[]>();
  /** Rebuild the hash from a fresh entity list. Call once per frame (or
   *  once per AI-tick batch) before querying. Clears the previous buckets. */
  rebuild(entities: Iterable<T>): void {
    this.buckets.clear();
    for (const e of entities) {
      if (!e.alive) continue;
      const key = this.cellKey(e.x, e.z);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = [];
        this.buckets.set(key, bucket);
      }
      bucket.push(e);
    }
  }

  /** Query all entities within `radius` meters of (x, z). Returns a new
   *  array (caller owns it). O(buckets-touched) — typically 1–4 buckets
   *  for a radius ≤ CELL_SIZE. */
  queryRadius(x: number, z: number, radius: number, out: T[] = []): T[] {
    out.length = 0;
    const r = Math.max(radius, CELL_SIZE);
    const minX = Math.floor((x - r) * CELL_SIZE_INV);
    const maxX = Math.floor((x + r) * CELL_SIZE_INV);
    const minZ = Math.floor((z - r) * CELL_SIZE_INV);
    const maxZ = Math.floor((z + r) * CELL_SIZE_INV);
    const rSqr = radius * radius;
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.buckets.get(this.cellKeyXY(cx, cz));
        if (!bucket) continue;
        for (const e of bucket) {
          const dx = e.x - x;
          const dz = e.z - z;
          if (dx * dx + dz * dz <= rSqr) out.push(e);
        }
      }
    }
    return out;
  }

  /** Query all entities in the buckets overlapping the line segment from
   *  (x1, z1) to (x2, z2). Used for "who can I see along this ray" queries
   *  (e.g. an AI's vision ray — find all entities the ray passes near). */
  querySegment(x1: number, z1: number, x2: number, z2: number, out: T[] = []): T[] {
    out.length = 0;
    // DDA-style traversal of the cells the segment passes through.
    const dx = x2 - x1, dz = z2 - z1;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) {
      // Degenerate — just query the single cell.
      const bucket = this.buckets.get(this.cellKey(x1, z1));
      if (bucket) for (const e of bucket) out.push(e);
      return out;
    }
    const stepCount = Math.max(1, Math.ceil(dist / (CELL_SIZE * 0.5)));
    const stepX = dx / stepCount;
    const stepZ = dz / stepCount;
    const seen = new Set<number>();
    let cx = x1, cz = z1;
    for (let i = 0; i <= stepCount; i++) {
      const key = this.cellKey(cx, cz);
      if (!seen.has(key)) {
        seen.add(key);
        const bucket = this.buckets.get(key);
        if (bucket) for (const e of bucket) out.push(e);
      }
      cx += stepX;
      cz += stepZ;
    }
    return out;
  }

  /** Get the total entity count across all buckets (for debug). */
  size(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) n += bucket.length;
    return n;
  }

  /** Cell key encoding: combine (cx, cz) into a single number via Cantor
   *  pairing (handles negative coordinates). */
  private cellKey(x: number, z: number): number {
    return this.cellKeyXY(Math.floor(x * CELL_SIZE_INV), Math.floor(z * CELL_SIZE_INV));
  }
  private cellKeyXY(cx: number, cz: number): number {
    // Cantor pairing for non-negative integers; offset to handle negatives.
    const a = cx >= 0 ? 2 * cx : -2 * cx - 1;
    const b = cz >= 0 ? 2 * cz : -2 * cz - 1;
    return ((a + b) * (a + b + 1)) / 2 + b;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Section D #534 — Batched LOS resolver (scoped to environment colliders).
// ───────────────────────────────────────────────────────────────────────────

export interface EnvCollider {
  box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

/** Ray-vs-AABB on the XZ plane (Y ignored — assumes chest-height rays). */
function rayHitsBoxXZ(
  fromX: number, fromZ: number, dirX: number, dirZ: number,
  box: EnvCollider["box"], maxDist: number,
): boolean {
  const minX = box.min.x, maxX = box.max.x;
  const minZ = box.min.z, maxZ = box.max.z;
  const invX = dirX !== 0 ? 1 / dirX : Infinity;
  const invZ = dirZ !== 0 ? 1 / dirZ : Infinity;
  let tmin = -Infinity, tmax = Infinity;
  let tx1 = (minX - fromX) * invX;
  let tx2 = (maxX - fromX) * invX;
  if (tx1 > tx2) { const tmp = tx1; tx1 = tx2; tx2 = tmp; }
  tmin = tmin > tx1 ? tmin : tx1;
  tmax = tmax < tx2 ? tmax : tx2;
  let tz1 = (minZ - fromZ) * invZ;
  let tz2 = (maxZ - fromZ) * invZ;
  if (tz1 > tz2) { const tmp = tz1; tz1 = tz2; tz2 = tmp; }
  tmin = tmin > tz1 ? tmin : tz1;
  tmax = tmax < tz2 ? tmax : tz2;
  return tmax >= Math.max(0, tmin) && tmin <= maxDist && tmax >= 0;
}

/** Section D #534 — Returns true if the LOS ray from (fromX, fromZ) to
 *  (toX, toZ) is blocked by any environment collider (height 0.8..4m,
 *  matching the existing losBlocked filter in enemy-tactics.ts). */
export function envLosBlocked(
  colliders: EnvCollider[],
  fromX: number, fromZ: number, toX: number, toZ: number,
): boolean {
  const dx = toX - fromX, dz = toZ - fromZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.001) return false;
  const dirX = dx / dist, dirZ = dz / dist;
  for (const c of colliders) {
    const h = c.box.max.y - c.box.min.y;
    if (h < 0.8 || h > 4) continue;
    if (rayHitsBoxXZ(fromX, fromZ, dirX, dirZ, c.box, dist - 0.3)) return true;
  }
  return false;
}

/**
 * Section D #533+#534 — Batched AI vision query. Given:
 *   - a spatial hash of all alive entities (rebuilt per frame),
 *   - a list of environment colliders (the same ctx.colliders),
 *   - a viewer position + sight range,
 *  returns the list of visible entities (alive, within range, LOS clear,
 *  on the opposing team). This is the O(n) replacement for the O(n²)
 *  nested-loop perception check.
 *
 * The caller (EnemySystem) iterates the result instead of iterating all
 * enemies for each enemy.
 */
export function queryVisible<T extends SpatialEntity>(
  hash: SpatialHash<T>,
  colliders: EnvCollider[],
  viewer: { x: number; z: number; team: T["team"]; sightRange: number },
  out: T[] = [],
): T[] {
  out.length = 0;
  // Step 1: spatial-hash query — O(buckets) candidates.
  const candidates = hash.queryRadius(viewer.x, viewer.z, viewer.sightRange);
  // Step 2: filter by team + LOS.
  for (const e of candidates) {
    if (e.team === viewer.team) continue;
    if (!e.alive) continue;
    const dx = e.x - viewer.x;
    const dz = e.z - viewer.z;
    const dist = Math.hypot(dx, dz);
    if (dist > viewer.sightRange) continue;
    // LOS check — env-collider raycast.
    if (envLosBlocked(colliders, viewer.x, viewer.z, e.x, e.z)) continue;
    out.push(e);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Section D #540 — Glass occlusion helper.
// Glass should block AI vision but NOT bullets. The existing losBlocked
// filter in enemy-tactics.ts skips colliders with height < 0.8m or > 4m
// (treating them as floor/ceiling). Glass panes are typically 1–2m tall
// (within the 0.8..4m range), so they currently block BOTH vision + bullets.
// This helper lets the integrator tag glass colliders (userData.isGlass)
// and have the AI's vision ray skip them while the bullet ray still hits.
// ───────────────────────────────────────────────────────────────────────────

export interface GlassCollider extends EnvCollider {
  /** True if this collider is glass (vision passes through, bullets don't). */
  isGlass?: boolean;
}

/** Section D #540 — Env-LOS check that respects glass. Glass colliders
 *  (isGlass=true) are SKIPPED by this vision ray (so the AI can see the
 *  player through glass). Bullet rays should use envLosBlocked (which
 *  doesn't skip glass) so bullets are stopped by glass. */
export function envLosBlockedRespectGlass(
  colliders: GlassCollider[],
  fromX: number, fromZ: number, toX: number, toZ: number,
): boolean {
  const dx = toX - fromX, dz = toZ - fromZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.001) return false;
  const dirX = dx / dist, dirZ = dz / dist;
  for (const c of colliders) {
    // Section D #540 — skip glass colliders (vision passes through).
    if (c.isGlass) continue;
    const h = c.box.max.y - c.box.min.y;
    if (h < 0.8 || h > 4) continue;
    if (rayHitsBoxXZ(fromX, fromZ, dirX, dirZ, c.box, dist - 0.3)) return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Section D #539 — Friendly-fire LOS check.
// Before an enemy fires, it should verify the ray to the player doesn't
// pass through a teammate. This helper takes the firing enemy's position,
// the player's position, + the spatial hash of all allies (rebuilt per
// frame); returns true if an ally is in the ray's path (within a 1m tube).
// The caller skips the shot (or re-aims) when true.
// ───────────────────────────────────────────────────────────────────────────

export function friendlyInLineOfFire<T extends SpatialEntity>(
  hash: SpatialHash<T>,
  fromX: number, fromZ: number, toX: number, toZ: number,
  shooterId: string | number,
  allyTeam: T["team"],
): boolean {
  // Query the segment for candidate allies.
  const candidates = hash.querySegment(fromX, fromZ, toX, toZ);
  const dx = toX - fromX, dz = toZ - fromZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.5) return false;
  const dirX = dx / dist, dirZ = dz / dist;
  for (const e of candidates) {
    if (e.id === shooterId) continue;
    if (e.team !== allyTeam) continue;
    if (!e.alive) continue;
    // Project (ally - from) onto the ray. If the projection is in (0, dist)
    // AND the perpendicular distance is < 1m, the ally is in the line of fire.
    const ex = e.x - fromX;
    const ez = e.z - fromZ;
    const proj = ex * dirX + ez * dirZ;
    if (proj < 0.5 || proj > dist - 0.5) continue;
    const perpX = ex - dirX * proj;
    const perpZ = ez - dirZ * proj;
    const perpDist = Math.hypot(perpX, perpZ);
    if (perpDist < 1.0) return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Singleton accessor — the engine constructs one SpatialHash on match start
// + rebuilds it per frame from ctx.enemies (and the companion + VIP).
// ───────────────────────────────────────────────────────────────────────────

let _enemyHash: SpatialHash<SpatialEntity> | null = null;

/** Get the process-wide enemy spatial hash (for AI vision queries). */
export function getEnemySpatialHash(): SpatialHash<SpatialEntity> {
  if (!_enemyHash) _enemyHash = new SpatialHash<SpatialEntity>();
  return _enemyHash;
}

/** Tear down the singleton (called on match dispose). */
export function destroyEnemySpatialHash(): void {
  _enemyHash = null;
}
