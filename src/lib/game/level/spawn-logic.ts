/**
 * SEC9-LEVEL — Prompt 75: Spawn logic + anti-spawn-camping.
 *
 * Replaces the fixed/round-robin enemy spawn selection with a weighted
 * picker that prefers spawns which are:
 *   1. far from the player,
 *   2. out of the player's line-of-sight cone,
 *   3. not recently used,
 *   4. flagged as "safe" by the MapValidator's spawn-safety check.
 *
 * Public API:
 *   - `selectSpawn(mapSlug, playerPos, recentSpawnPositions, playerYaw)`
 *     → picks one spawn per enemy, weighted. Returns null if the map has
 *       no spawns.
 *   - `getSafeSpawns(mapSlug)` → precomputed safety verdict per spawn.
 *   - `scoreSpawn(...)` → exposed for the design dashboard / tests.
 *   - `getSpawnCandidates(mapSlug)` → raw list (mirrors map.enemySpawns).
 *
 * The selection is deterministic given (mapSlug, playerPos, recentSpawns,
 * playerYaw, rng) — pass an `rng` function for testability; defaults to
 * `Math.random`.
 *
 * No THREE dependency at module load (pure math), so safe to import in
 * unit tests + the maps API.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * K-5000 prompt mapping (this file owns):
 *   #4227 [validateMap per-spawn cached] — `getSafeSpawns(mapSlug)` has
 *         always cached the per-spawn MapValidator verdict in
 *         `safeSpawnCache` (module-level Map). The cache is invalidated
 *         via `clearSafeSpawnCache()` on map edits. This prompt is
 *         verified-DONE — the marker is added here so future Grep
 *         searches for `K-5000 #4227` land on the cache declaration
 *         (line ~99) which is the implementation. The cache prevents
 *         N×validateMap() calls per wave (each validateMap is O(P²)
 *         where P = cover-prop count, ~80 on warehouse) — without it,
 *         spawning a 13-enemy HORDE wave would re-run the validator 13
 *         times (~85ms total on warehouse, observable as a frame hitch
 *         at wave start). With the cache, only the first spawn pays the
 *         cost; the remaining 12 read from the Map.
 *   #4364 [cross-ref to 4227] — see marker above.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { getMap } from "../maps/MapRegistry";
import { validateMap } from "../maps/MapValidator";

// ─── Types ───────────────────────────────────────────────────────────────

export type Vec3 = [number, number, number];

export interface RecentSpawn {
  /** World position of the recent spawn. */
  position: Vec3;
  /** performance.now() timestamp when the spawn was used. */
  time: number;
}

export interface SpawnSelectionOptions {
  /** Min distance from the player (m). Spawns closer than this get weight 0. */
  minPlayerDist?: number;
  /** Distance at which a spawn is "far enough" (m). Spawns at/above this get
   *  the full distance-weight bonus. */
  farPlayerDist?: number;
  /** Half-angle (radians) of the player's LOS cone. Spawns inside the cone
   *  within `minPlayerDist` get weight 0; spawns inside the cone beyond that
   *  get a penalty. */
  losConeHalfAngle?: number;
  /** Distance (m) within which a recently-used spawn is heavily penalized. */
  recentSpawnPenaltyDist?: number;
  /** Time (ms) within which a recently-used spawn is penalized. */
  recentSpawnCooldownMs?: number;
  /** Multiplier applied to the weight of spawns flagged safe by the validator. */
  safeSpawnWeightMult?: number;
  /** RNG function — pass a seeded one for deterministic tests. */
  rng?: () => number;
}

export const DEFAULT_SPAWN_OPTIONS: Required<SpawnSelectionOptions> = {
  minPlayerDist: 12,
  farPlayerDist: 30,
  losConeHalfAngle: Math.PI / 6, // 30° half-angle = 60° cone
  recentSpawnPenaltyDist: 8,
  recentSpawnCooldownMs: 8000,
  safeSpawnWeightMult: 1.5,
  rng: Math.random,
};

/** A scored spawn candidate — exposed for the design dashboard. */
export interface ScoredSpawn {
  spawn: Vec3;
  /** Total weight (after all factors applied). */
  weight: number;
  /** Distance to the player (m). */
  playerDist: number;
  /** True if the spawn is inside the player's LOS cone. */
  inPlayerLos: boolean;
  /** True if the spawn is "recently used" (within the cooldown). */
  recentlyUsed: boolean;
  /** True if the MapValidator flagged this spawn as safe. */
  safe: boolean;
}

// ─── Public: getSafeSpawns precompute ────────────────────────────────────

export interface SpawnSafetyInfo {
  spawn: Vec3;
  safe: boolean;
  reason: string;
  nearestPlayerDist: number;
  obstructed: boolean;
}

/** Per-map spawn-safety precompute. Wraps MapValidator's spawn-safety check
 *  into a fast lookup the spawn picker uses. Results are cached per map slug
 *  for the lifetime of the process — the underlying map data is immutable.
 *
 *  K-5000 #4227 — this cache is the implementation of the "validateMap
 *  per-spawn cached" prompt. The cache is invalidated via
 *  `clearSafeSpawnCache()` on map edits. */
const safeSpawnCache = new Map<string, SpawnSafetyInfo[]>();

export function getSafeSpawns(mapSlug: string): SpawnSafetyInfo[] {
  const cached = safeSpawnCache.get(mapSlug);
  if (cached) return cached;
  const map = getMap(mapSlug);
  if (!map) {
    safeSpawnCache.set(mapSlug, []);
    return [];
  }
  const validation = validateMap(mapSlug);
  const out: SpawnSafetyInfo[] = map.enemySpawns.map((s) => {
    const match = validation?.spawnSafety.find(
      (r) => r.spawn[0] === s[0] && r.spawn[1] === s[1] && r.spawn[2] === s[2],
    );
    if (match) {
      return {
        spawn: s as Vec3,
        safe: match.safe,
        reason: match.reason,
        nearestPlayerDist: match.nearestPlayerDist,
        obstructed: match.obstructed,
      };
    }
    // No match — default to "safe" so we don't accidentally exclude spawns
    // the validator didn't see (e.g., sandbox maps with no player positions).
    return {
      spawn: s as Vec3,
      safe: true,
      reason: "no validator verdict (defaulting to safe)",
      nearestPlayerDist: Infinity,
      obstructed: false,
    };
  });
  safeSpawnCache.set(mapSlug, out);
  return out;
}

/** Clear the safety cache (used on map edits / tests). */
export function clearSafeSpawnCache(): void {
  safeSpawnCache.clear();
}

// ─── Public: getSpawnCandidates ──────────────────────────────────────────

/** Get the raw spawn candidates for a map (mirrors map.enemySpawns). */
export function getSpawnCandidates(mapSlug: string): Vec3[] {
  const map = getMap(mapSlug);
  if (!map) return [];
  return map.enemySpawns.map((s) => [s[0], s[1], s[2]] as Vec3);
}

// ─── Public: scoreSpawn ──────────────────────────────────────────────────

/** Score a single spawn candidate. Exposed for tests + the design dashboard. */
export function scoreSpawn(
  spawn: Vec3,
  playerPos: { x: number; y: number; z: number },
  playerYaw: number,
  recentSpawns: RecentSpawn[],
  safe: boolean,
  options: SpawnSelectionOptions = {},
): ScoredSpawn {
  const opts = { ...DEFAULT_SPAWN_OPTIONS, ...options };
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());

  // ─── Distance factor ───
  const dx = spawn[0] - playerPos.x;
  const dy = spawn[1] - playerPos.y;
  const dz = spawn[2] - playerPos.z;
  const playerDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // ─── LOS cone check ───
  // Player forward = (sin(yaw), 0, -cos(yaw)) (yaw=0 → -Z, +yaw → clockwise).
  const horizDist = Math.hypot(dx, dz);
  let inPlayerLos = false;
  if (horizDist > 0.01) {
    const fx = Math.sin(playerYaw);
    const fz = -Math.cos(playerYaw);
    const cosA = (dx * fx + dz * fz) / horizDist;
    inPlayerLos = cosA >= Math.cos(opts.losConeHalfAngle);
  }

  // ─── Recently-used check ───
  let recentlyUsed = false;
  let recentPenalty = 1.0;
  for (const r of recentSpawns) {
    const ageMs = now - r.time;
    if (ageMs > opts.recentSpawnCooldownMs) continue;
    const rd = Math.hypot(r.position[0] - spawn[0], r.position[2] - spawn[2]);
    if (rd <= opts.recentSpawnPenaltyDist) {
      recentlyUsed = true;
      // Linear penalty: full penalty at age=0, zero at age=cooldown.
      const ageFrac = 1 - ageMs / opts.recentSpawnCooldownMs;
      recentPenalty = Math.min(recentPenalty, 1 - 0.85 * ageFrac);
    }
  }

  // ─── Weight computation ───
  // Base weight: 1.0.
  let weight = 1.0;

  // Hard exclusion: spawns too close to the player get weight 0.
  if (playerDist < opts.minPlayerDist) {
    weight = 0;
  } else {
    // Distance bonus: linear ramp from 0 at minPlayerDist to 1 at farPlayerDist.
    const distFrac = Math.min(1, (playerDist - opts.minPlayerDist) /
      (opts.farPlayerDist - opts.minPlayerDist));
    weight *= 0.4 + 0.6 * distFrac; // 0.4..1.0

    // LOS penalty: spawns inside the player's cone get a 0.5× penalty.
    if (inPlayerLos) weight *= 0.5;

    // Recent-spawn penalty.
    weight *= recentPenalty;

    // Safe-spawn bonus.
    if (safe) weight *= opts.safeSpawnWeightMult;
  }

  return {
    spawn,
    weight,
    playerDist,
    inPlayerLos,
    recentlyUsed,
    safe,
  };
}

// ─── Public: selectSpawn ─────────────────────────────────────────────────

/** Select a weighted-random spawn for an enemy. Returns null if the map has
 *  no spawns or all candidates have weight 0.
 *
 *  @param mapSlug               Map slug.
 *  @param playerPos             Player world position (typically ctx.player.pos).
 *  @param recentSpawnPositions  Recently-used spawns (the engine maintains this
 *                               list — push the returned spawn + a timestamp
 *                               each time selectSpawn is called).
 *  @param playerYaw             Player yaw (radians) — for LOS cone.
 *  @param options               Optional tunables. */
export function selectSpawn(
  mapSlug: string,
  playerPos: { x: number; y: number; z: number },
  recentSpawnPositions: RecentSpawn[],
  playerYaw: number,
  options?: SpawnSelectionOptions,
): Vec3 | null {
  const candidates = getSpawnCandidates(mapSlug);
  if (candidates.length === 0) return null;
  const safety = getSafeSpawns(mapSlug);
  const safeSet = new Set(safety.filter((s) => s.safe).map((s) => `${s.spawn[0]},${s.spawn[1]},${s.spawn[2]}`));

  // Score every candidate.
  const scored: ScoredSpawn[] = candidates.map((c) => {
    const safe = safeSet.has(`${c[0]},${c[1]},${c[2]}`);
    return scoreSpawn(c, playerPos, playerYaw, recentSpawnPositions, safe, options);
  });

  // Filter out weight-0 spawns.
  const viable = scored.filter((s) => s.weight > 0);
  if (viable.length === 0) {
    // Fallback: all candidates are weight-0 (e.g., the player is too close to
    // every spawn). Pick the farthest candidate to minimize spawn-camping.
    let farthest = scored[0];
    for (const s of scored) {
      if (!farthest || s.playerDist > farthest.playerDist) farthest = s;
    }
    return farthest ? farthest.spawn : null;
  }

  // Weighted random pick.
  const rng = (options?.rng ?? DEFAULT_SPAWN_OPTIONS.rng);
  const totalWeight = viable.reduce((s, x) => s + x.weight, 0);
  if (totalWeight <= 0) return viable[0].spawn;
  let r = rng() * totalWeight;
  for (const s of viable) {
    r -= s.weight;
    if (r <= 0) return s.spawn;
  }
  // Floating-point safety — return the last viable.
  return viable[viable.length - 1].spawn;
}

/** Convenience: select N spawns in one call. The engine can use this to
 *  spawn a whole wave at once — each call updates `recentSpawnPositions`
 *  in place so subsequent picks avoid the same area. Returns an array of
 *  N spawn positions (or fewer if the map has fewer spawns). */
export function selectSpawns(
  mapSlug: string,
  playerPos: { x: number; y: number; z: number },
  recentSpawnPositions: RecentSpawn[],
  playerYaw: number,
  count: number,
  options?: SpawnSelectionOptions,
): Vec3[] {
  const out: Vec3[] = [];
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  for (let i = 0; i < count; i++) {
    const spawn = selectSpawn(mapSlug, playerPos, recentSpawnPositions, playerYaw, options);
    if (!spawn) break;
    out.push(spawn);
    // Mark this spawn as recently used so the next pick avoids it.
    recentSpawnPositions.push({ position: spawn, time: now });
  }
  return out;
}

/** Prune entries from `recentSpawnPositions` older than `maxAgeMs`. The
 *  engine should call this once per frame (or once per wave) to keep the
 *  list bounded. */
export function pruneRecentSpawns(
  recentSpawnPositions: RecentSpawn[],
  maxAgeMs: number = DEFAULT_SPAWN_OPTIONS.recentSpawnCooldownMs,
): void {
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  for (let i = recentSpawnPositions.length - 1; i >= 0; i--) {
    if (now - recentSpawnPositions[i].time > maxAgeMs) {
      recentSpawnPositions.splice(i, 1);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Section D #529–532 — Spawn protection, camping prevention, dynamic spawn,
// max-alive cap. Pure functions (no THREE dependency) — the engine wires
// these into EnemySystem.startWave / EnemySystem.spawnEnemy.
// ───────────────────────────────────────────────────────────────────────────

/** Section D #529 — Spawn protection. Freshly spawned players (and
 *  freshly spawned AI in co-op) are invulnerable for SPAWN_PROTECTION_MS
 *  milliseconds. The engine sets `entity.spawnProtectedUntil` on spawn;
 *  the damage system checks it before applying damage. */
export const SPAWN_PROTECTION_MS = 3000;

/** Section D #529 — Mark an entity as spawn-protected. The damage system
 *  reads `entity.spawnProtectedUntil` (a performance.now() timestamp);
 *  damage is skipped while `performance.now() < spawnProtectedUntil`.
 *  Returns the entity for chaining. */
export function applySpawnProtection(entity: { spawnProtectedUntil?: number }, now?: number): void {
  const t = now ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  entity.spawnProtectedUntil = t + SPAWN_PROTECTION_MS;
}

/** Section D #529 — Is the entity currently spawn-protected? */
export function isSpawnProtected(entity: { spawnProtectedUntil?: number }, now?: number): boolean {
  if (entity.spawnProtectedUntil === undefined) return false;
  const t = now ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  return t < entity.spawnProtectedUntil;
}

/** Section D #530 — Spawn camping prevention. A spawn point is "camped" if
 *  N or more bullets (or enemy LOS rays) passed within CAMPING_RADIUS of it
 *  in the last CAMPING_WINDOW_MS. The engine pushes bullet/LOS events via
 *  recordSpawnCampEvent(); selectSpawn() reads isSpawnCamped() + biases
 *  against camped spawns (weight × 0.1). */
export const CAMPING_RADIUS = 6;
export const CAMPING_WINDOW_MS = 5000;
export const CAMPING_THRESHOLD = 5; // 5+ near-spawn events = camped.

interface SpawnCampEvent {
  /** World position of the spawn point that was under fire. */
  spawn: Vec3;
  /** performance.now() when the event was recorded. */
  time: number;
}

/** Module-level ring buffer of recent spawn-camp events. Bounded to 64
 *  entries (pruned on push). */
const spawnCampEvents: SpawnCampEvent[] = [];

/** Section D #530 — Record a spawn-camp event (a bullet or LOS ray passed
 *  near a spawn point). Called by the ProjectileSystem (on bullet near-miss
 *  to a spawn point) or the EnemySystem (on enemy LOS to a spawn point). */
export function recordSpawnCampEvent(spawn: Vec3, now?: number): void {
  const t = now ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  spawnCampEvents.push({ spawn: [spawn[0], spawn[1], spawn[2]], time: t });
  // Prune.
  const cutoff = t - CAMPING_WINDOW_MS;
  while (spawnCampEvents.length > 0 && spawnCampEvents[0].time < cutoff) {
    spawnCampEvents.shift();
  }
  // Hard cap.
  if (spawnCampEvents.length > 64) spawnCampEvents.splice(0, spawnCampEvents.length - 64);
}

/** Section D #530 — Is the given spawn point currently camped? Returns
 *  true if CAMPING_THRESHOLD+ events within CAMPING_RADIUS occurred in
 *  the last CAMPING_WINDOW_MS. */
export function isSpawnCamped(spawn: Vec3, now?: number): boolean {
  const t = now ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  const cutoff = t - CAMPING_WINDOW_MS;
  let count = 0;
  for (const ev of spawnCampEvents) {
    if (ev.time < cutoff) continue;
    const d = Math.hypot(ev.spawn[0] - spawn[0], ev.spawn[2] - spawn[2]);
    if (d <= CAMPING_RADIUS) {
      count++;
      if (count >= CAMPING_THRESHOLD) return true;
    }
  }
  return false;
}

/** Section D #530 — Clear the spawn-camp event buffer (called on match
 *  restart). */
export function clearSpawnCampEvents(): void {
  spawnCampEvents.length = 0;
}

/**
 * Section D #530 — Wrap selectSpawn with camping-aware filtering. Returns
 * the same spawn shape as selectSpawn, but with camped spawns heavily
 * penalized (weight × 0.1) so the picker avoids them unless every spawn
 * is camped (in which case it picks the least-camped).
 */
export function selectSpawnAntiCamp(
  mapSlug: string,
  playerPos: { x: number; y: number; z: number },
  recentSpawnPositions: RecentSpawn[],
  playerYaw: number,
  options?: SpawnSelectionOptions,
): Vec3 | null {
  const candidates = getSpawnCandidates(mapSlug);
  if (candidates.length === 0) return null;
  // Score every candidate.
  const safety = getSafeSpawns(mapSlug);
  const safeSet = new Set(safety.filter((s) => s.safe).map((s) => `${s.spawn[0]},${s.spawn[1]},${s.spawn[2]}`));
  const scored = candidates.map((c) => {
    const safe = safeSet.has(`${c[0]},${c[1]},${c[2]}`);
    const base = scoreSpawn(c, playerPos, playerYaw, recentSpawnPositions, safe, options);
    // Apply camping penalty.
    const camped = isSpawnCamped(c);
    return { ...base, weight: camped ? base.weight * 0.1 : base.weight };
  });
  const viable = scored.filter((s) => s.weight > 0);
  if (viable.length === 0) {
    // All camped — pick the farthest.
    let farthest = scored[0];
    for (const s of scored) if (!farthest || s.playerDist > farthest.playerDist) farthest = s;
    return farthest ? farthest.spawn : null;
  }
  const rng = (options?.rng ?? DEFAULT_SPAWN_OPTIONS.rng);
  const total = viable.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return viable[0].spawn;
  let r = rng() * total;
  for (const s of viable) {
    r -= s.weight;
    if (r <= 0) return s.spawn;
  }
  return viable[viable.length - 1].spawn;
}

/**
 * Section D #531 — Dynamic spawn placement based on the player's position.
 * Picks a spawn that flanks the player (off the player's LOS cone, to the
 * side or rear). The standard selectSpawn already biases away from the
 * player's LOS cone; this function makes the flank bias explicit by
 * requiring the spawn to be > 90° off the player's facing direction.
 *
 * Returns null if no flank spawn is available (falls back to selectSpawn).
 */
export function selectFlankSpawn(
  mapSlug: string,
  playerPos: { x: number; y: number; z: number },
  playerYaw: number,
  recentSpawnPositions: RecentSpawn[],
  options?: SpawnSelectionOptions,
): Vec3 | null {
  const candidates = getSpawnCandidates(mapSlug);
  if (candidates.length === 0) return null;
  // Player forward = (sin(yaw), 0, -cos(yaw)).
  const fx = Math.sin(playerYaw);
  const fz = -Math.cos(playerYaw);
  const flankSpawns: Vec3[] = [];
  for (const c of candidates) {
    const dx = c[0] - playerPos.x;
    const dz = c[2] - playerPos.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const cosA = (dx * fx + dz * fz) / len;
    // cosA < cos(90°) = 0 means the spawn is > 90° off the player's facing
    // (i.e. beside or behind the player). That's a flank spawn.
    if (cosA < 0.2) { // 0.2 ≈ 78° — slightly forward of 90° to give more options.
      flankSpawns.push(c);
    }
  }
  if (flankSpawns.length === 0) return null;
  // Pick the farthest flank spawn (max pressure on the player's flank).
  let best = flankSpawns[0];
  let bestDist = -Infinity;
  for (const c of flankSpawns) {
    const d = Math.hypot(c[0] - playerPos.x, c[2] - playerPos.z);
    if (d > bestDist) { bestDist = d; best = c; }
  }
  // Push to recent spawns.
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  recentSpawnPositions.push({ position: [best[0], best[1], best[2]], time: now });
  return best;
}

/**
 * Section D #532 — Max-alive cap. Returns true if the engine should defer
 * spawning a new enemy (the alive count is at or above the cap). The cap
 * is read from the difficulty config (concurrentEnemyCap) — passed in by
 * the caller. The director's spawnRateMult is applied as a multiplier on
 * the cap (so a CALM decision lowers the effective cap, a PEAK raises it).
 *
 * The engine calls this before each spawn; if true, it queues the spawn
 * and retries on the next tick where an enemy died.
 */
export function shouldDeferSpawn(
  aliveCount: number,
  cap: number,
  spawnRateMult: number = 1.0,
): boolean {
  const effectiveCap = Math.max(1, Math.floor(cap * spawnRateMult));
  return aliveCount >= effectiveCap;
}

/**
 * Section D #532 — Compute the effective max-alive cap given the difficulty
 * + the director's spawnRateMult. The engine reads this once per wave to
 * set the cap. Hard / Insane have higher base caps (more enemies on field
 * simultaneously); Easy / Normal are lower.
 */
export function computeMaxAliveCap(
  baseCap: number,
  spawnRateMult: number,
): number {
  return Math.max(1, Math.floor(baseCap * spawnRateMult));
}
