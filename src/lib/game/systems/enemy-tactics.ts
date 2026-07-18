import * as THREE from "three";
import type { GameContext, Enemy } from "./types";
import type { EnemyClass } from "../EnemyClasses";
import { emitBark } from "../ai/barks";
// A3-5000 #507 / #508: emit medic-revive + grenade barks. The barks.ts has
// REVIVING + GRENADE configs that were never called from gameplay.

/**
 * P4.1 / Task-5: Enemy tactical behavior — extracted from EnemySystem to
 * keep that file under 250 lines. Each function corresponds to one FSM
 * state. Task-5 adds a COVER state (cover-seeking + peek + blind-fire +
 * grenades) and improves every existing state so enemies never stand
 * perfectly still for more than ~1s.
 *
 * Per-enemy transient AI state (peek dir/timer, cover cache, grenade
 * cooldown, crouch Y, etc.) is stashed on the enemy via the `EnemyAIExtra`
 * interface — accessed through the `ai()` helper — to avoid editing the
 * Enemy interface in types.ts (which is shared with systems we don't own).
 */

// ---------- Per-enemy transient AI state (stashed via cast) ----------

interface EnemyAIExtra {
  // ATTACK corner-peek strafing
  peekDir?: 1 | -1;
  peekTimer?: number; // performance.now() when to flip peekDir
  // COVER behavior
  coverEnterTime?: number;
  coverCachePos?: THREE.Vector3 | null;
  coverCacheTime?: number; // performance.now() when the cover cache was set
  coverPeekUntil?: number; // peeking out until this time
  coverNextBlindFireAt?: number;
  coverIsPeeking?: boolean;
  coverNextActionAt?: number;
  coverPeekDir?: 1 | -1;
  // Prompt #54 — true when the cached cover position is a distance-based
  // fallback (no LOS-blocking cover was found). Callers can bias behavior
  // (e.g. peek less aggressively, prefer to keep moving) when behind a
  // fallback position. Reset to false whenever findNearestCover runs and
  // finds real LOS-blocking cover.
  coverFallback?: boolean;
  // GRENADE throwing (per-enemy randomized cooldown)
  nextGrenadeAt?: number;
  // FLEE behavior
  fleeEnterTime?: number;
  fleeNextCoverCheck?: number;
  fleeCoverPos?: THREE.Vector3 | null;
  // SUPPRESSED behavior
  suppEnterTime?: number;
  suppNextBlindFireAt?: number;
  suppCoverPos?: THREE.Vector3 | null;
  suppCoverCacheTime?: number;
  // Task-5 (Prompt #53) — SUPPRESSED peek cycle (duck behind cover, peek out
  // every 2-3s for a snap shot, then duck back). Mirrors the COVER peek
  // cycle fields above but drives the SUPPRESSED state's behavior so a
  // high-suppression enemy isn't a sitting duck.
  suppIsPeeking?: boolean;
  suppNextActionAt?: number;
  suppPeekDir?: 1 | -1;
  // Task-5 (Prompt #52) — waypoint pathfinding. Per-enemy steered direction
  // cache + recalc timestamp. The straight-line desired velocity is adjusted
  // by `steerAroundObstacles` to detour around colliders; the result is
  // cached for ~0.5s so enemies don't recompute every frame.
  pathSteerX?: number; // cached steered direction X (unit)
  pathSteerZ?: number; // cached steered direction Z (unit)
  pathRecalcAt?: number; // performance.now() when to recompute the steer
  // Crouch visual (lowered group.position.y while in SUPPRESSED / COVER)
  crouchAmount?: number;
  // Task-15 — ZOMBIE melee state (per-enemy melee cooldown + lunge timer).
  zombieLastMeleeAt?: number; // performance.now() of the last claw swipe
  zombieLungeAt?: number;     // performance.now() when the current lunge started
  // Task-12 — MEDIC healing state.
  medicLastScanAt?: number;   // performance.now() of the last injured-ally scan
  medicLastHealAt?: number;   // performance.now() of the last heal/revive complete
  medicChannelEnd?: number;   // 0/undefined = not channeling; otherwise the time the channel completes
  medicHealTarget?: Enemy | null; // the ally currently being healed/revived
  // Task-12 — SCOUT recon + wide-callout state.
  scoutWideCalloutDone?: boolean;  // true after the scout's 30m callout has fired
  scoutPatrolTarget?: THREE.Vector3 | null; // current recon patrol point
  scoutNextPatrolAt?: number;     // performance.now() when to pick a new patrol point
  // Task-12 — SHIELD dropped flag (avoid re-triggering the drop-shield logic).
  shieldDropped?: boolean;
  // Task-12 — SHOTGUNNER last pellet-blast time (custom cooldown field).
  shotgunnerLastBlastAt?: number;
}

function ai(e: Enemy): EnemyAIExtra {
  return e as unknown as EnemyAIExtra;
}

/** Read the enemy's class — set by applyClassToEnemy in EnemyClasses.ts. */
function enemyClass(e: Enemy): EnemyClass | undefined {
  return (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
}

// ---------- Shared movement ----------

/** Move enemy with collision + bounds clamp. Shared across all moving states. */
export function moveEnemyWithCollision(ctx: GameContext, e: Enemy, dt: number, collides: (e: Enemy) => boolean) {
  const oldX = e.group.position.x, oldZ = e.group.position.z;
  e.group.position.x += e.velocity.x * dt;
  if (collides(e)) e.group.position.x = oldX;
  e.group.position.z += e.velocity.z * dt;
  if (collides(e)) e.group.position.z = oldZ;
  const b = 43;
  e.group.position.x = Math.max(-b, Math.min(b, e.group.position.x));
  e.group.position.z = Math.max(-b, Math.min(b, e.group.position.z));
}

// ---------- Waypoint pathfinding (Prompt #52) ----------
//
// A full navmesh is overkill; instead we use a "steer around obstacles"
// approach: when an enemy's straight-line path to its target is blocked by
// a collider AABB, we sample a few perpendicular detour directions and pick
// the one with a clear forward ray. The steered direction is cached per-
// enemy for ~0.5s so we don't recompute every frame.
//
// The raycast is a cheap slab-based ray-AABB test against ctx.colliders
// (horizontal plane only — we ignore Y since enemies are ground-bound and
// cover height is already filtered by findNearestCover).

/**
 * Prompt #52 — Ray-vs-AABB intersection on the horizontal plane (Y ignored).
 * Returns the ray parameter t at which the ray enters the box, or -1 if the
 * ray misses. Uses the slab method: clamp the ray's parametric range by the
 * X slab, then by the Z slab; if the resulting range is valid (min <= max),
 * the ray hits.
 *
 * `maxDist` caps the ray so we only count obstructions between the enemy
 * and its target (not colliders beyond the target).
 */
function rayHitsCollider(
  fromX: number, fromZ: number, dirX: number, dirZ: number,
  box: THREE.Box3, maxDist: number,
): boolean {
  // X slab.
  const minX = box.min.x, maxX = box.max.x;
  const minZ = box.min.z, maxZ = box.max.z;
  // Inverse direction components (handle zero dir gracefully).
  const invX = dirX !== 0 ? 1 / dirX : Infinity;
  const invZ = dirZ !== 0 ? 1 / dirZ : Infinity;
  let tmin = -Infinity, tmax = Infinity;
  // X slab.
  let tx1 = (minX - fromX) * invX;
  let tx2 = (maxX - fromX) * invX;
  if (tx1 > tx2) { const tmp = tx1; tx1 = tx2; tx2 = tmp; }
  tmin = tmin > tx1 ? tmin : tx1;
  tmax = tmax < tx2 ? tmax : tx2;
  // Z slab.
  let tz1 = (minZ - fromZ) * invZ;
  let tz2 = (maxZ - fromZ) * invZ;
  if (tz1 > tz2) { const tmp = tz1; tz1 = tz2; tz2 = tmp; }
  tmin = tmin > tz1 ? tmin : tz1;
  tmax = tmax < tz2 ? tmax : tz2;
  // Hit if the intersection interval is non-empty AND within [0, maxDist].
  return tmax >= Math.max(0, tmin) && tmin <= maxDist && tmax >= 0;
}

/**
 * Prompt #52 — Returns true if the straight-line path from (fromX, fromZ) to
 * (toX, toZ) is blocked by any ctx.collider. The ray is capped at the
 * target distance so colliders beyond the target don't count.
 *
 * Skips colliders shorter than 0.8m (low debris the enemy can step over)
 * and taller than 4m (full walls — those are map bounds, not obstacles to
 * steer around; the bounds clamp in moveEnemyWithCollision handles them).
 */
function pathBlocked(ctx: GameContext, fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  const dx = toX - fromX, dz = toZ - fromZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.001) return false;
  const dirX = dx / dist, dirZ = dz / dist;
  for (const c of ctx.colliders) {
    const h = c.box.max.y - c.box.min.y;
    if (h < 0.8 || h > 4) continue;
    if (rayHitsCollider(fromX, fromZ, dirX, dirZ, c.box, dist - 0.5)) return true;
  }
  return false;
}

/**
 * Prompt #52 — Steer a desired direction around obstacles. Samples 5
 * candidate directions (the desired direction + ±35°, ±70° perpendicular
 * offsets) and returns the closest-to-desired direction whose forward ray
 * is clear for at least 2.5m. Falls back to the desired direction if all
 * candidates are blocked (the enemy will bump along the collider face and
 * eventually slide past via moveEnemyWithCollision's axis revert).
 *
 * Returns a unit vector (x, z).
 *
 * Recomputes are throttled by the caller via `pathRecalcAt` (0.5s cooldown).
 */
function steerAroundObstacles(
  ctx: GameContext, e: Enemy, desiredX: number, desiredZ: number,
): { x: number; z: number } {
  const dLen = Math.hypot(desiredX, desiredZ);
  if (dLen < 0.001) return { x: desiredX, z: desiredZ };
  const dx = desiredX / dLen, dz = desiredZ / dLen;
  const fromX = e.group.position.x, fromZ = e.group.position.z;

  // Candidate angles: 0°, ±35°, ±70°. Sampled in order of preference (the
  // desired direction first, then progressively wider detours).
  const angles = [0, 35, -35, 70, -70];
  for (const a of angles) {
    const rad = a * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const cx = dx * cos - dz * sin;
    const cz = dx * sin + dz * cos;
    // Forward ray length: 2.5m. If the candidate's forward ray is clear,
    // accept it. (Shorter than the full path so we re-evaluate as we move.)
    let blocked = false;
    for (const c of ctx.colliders) {
      const h = c.box.max.y - c.box.min.y;
      if (h < 0.8 || h > 4) continue;
      if (rayHitsCollider(fromX, fromZ, cx, cz, c.box, 2.5)) { blocked = true; break; }
    }
    if (!blocked) return { x: cx, z: cz };
  }
  // All candidates blocked — fall back to the desired direction. The
  // axis-aligned collision revert in moveEnemyWithCollision will slide the
  // enemy along the collider face until a clear path opens.
  return { x: dx, z: dz };
}

/**
 * Prompt #52 — Cached steered direction. Returns a unit vector pointing
 * from the enemy toward `targetX/Z`, detoured around obstacles. The result
 * is cached per-enemy for `recalcMs` (default 500ms) so we don't raycast
 * every frame. Callers multiply the returned direction by the enemy's
 * move speed to get the desired velocity.
 */
function cachedSteer(
  ctx: GameContext, e: Enemy, targetX: number, targetZ: number, recalcMs = 500,
): { x: number; z: number } {
  const ex = ai(e);
  const now = performance.now();
  if (ex.pathRecalcAt === undefined || now >= ex.pathRecalcAt) {
    const desiredX = targetX - e.group.position.x;
    const desiredZ = targetZ - e.group.position.z;
    const steered = steerAroundObstacles(ctx, e, desiredX, desiredZ);
    ex.pathSteerX = steered.x;
    ex.pathSteerZ = steered.z;
    ex.pathRecalcAt = now + recalcMs;
  }
  return { x: ex.pathSteerX ?? 1, z: ex.pathSteerZ ?? 0 };
}

/**
 * Prompt #52 — Apply obstacle-aware steering to an enemy's desired velocity.
 * Takes the raw desired velocity (e.g. "move toward player at speed S") and
 * returns a steered velocity that detours around colliders. Uses the
 * per-enemy cached steer direction (recomputed every 0.5s).
 *
 * Callers should use the returned velocity instead of the raw desired
 * velocity when calling moveEnemyWithCollision.
 */
function applyPathSteer(
  ctx: GameContext, e: Enemy, desiredVX: number, desiredVZ: number,
): { x: number; z: number } {
  const speed = Math.hypot(desiredVX, desiredVZ);
  if (speed < 0.01) return { x: desiredVX, z: desiredVZ };
  // Target = enemy position + desired velocity (so the steer ray points
  // where the enemy wants to go).
  const targetX = e.group.position.x + desiredVX;
  const targetZ = e.group.position.z + desiredVZ;
  const steer = cachedSteer(ctx, e, targetX, targetZ);
  return { x: steer.x * speed, z: steer.z * speed };
}

// ---------- Crouch visual helper ----------

/**
 * Smoothly lower (or raise) the enemy's group.position.y to simulate a
 * crouch. The collision box in EnemySystem.enemyCollides uses world-space
 * y=0.1..2 regardless of group.position.y, so crouching doesn't break
 * collision. `target` is the crouch depth (0 = standing, 0.35 = crouched).
 *
 * Prompt #53 — also mirrors the crouch state onto `e.crouching` so other
 * systems (HUD nameplate, hitbox height bias, etc.) can read the enemy's
 * posture without inspecting the rig. The boolean flips the moment the
 * target depth changes sign (i.e. as soon as the enemy starts to lower or
 * rise), not when the damp reaches the target — so the posture flag is
 * immediately consistent with the behavioral state that requested it.
 */
function applyCrouch(e: Enemy, dt: number, target: number) {
  const ex = ai(e);
  // Default group.position.y is 0 (standing). Lower it for crouch.
  const desired = -target;
  e.group.position.y = THREE.MathUtils.damp(e.group.position.y, desired, 10, dt);
  ex.crouchAmount = target;
  // Prompt #53 — mirror the crouch state onto the Enemy interface so
  // external readers (HUD, hitbox) can read posture without inspecting
  // the rig. `target > 0` means "ducking"; `target === 0` means "standing".
  e.crouching = target > 0.01;
}

// ---------- Cover finding ----------

/**
 * Task-5 — Find the nearest collider that provides cover from the threat
 * position (`fromPos`, usually the player). Returns the cover position
 * (a point on the collider's far side from the threat, offset 0.6m off
 * the collider face), or null if no cover is within ~8m.
 *
 * The collider must be:
 *   - Between the enemy and the threat (roughly on the LOS line, projection
 *     between 1m and (enemyToThreatDist - 1m)).
 *   - Perpendicular distance from the LOS line < 2.5m (actually blocks LOS).
 *   - Height 0.8m..4m (skip walls and low debris).
 *   - Within 8m of the enemy.
 *
 * Prompt #54 — REAL LOS EVALUATION: after the geometric filter, we raycast
 * from the candidate cover point to the threat position. The cover is only
 * accepted if the ray is blocked by the candidate collider (or any other
 * collider in the same LOS band). This replaces the distance-only scoring
 * with a true line-of-sight test — a cover point behind a low wall that the
 * player can see over is now rejected.
 *
 * Prompt #54 — FALLBACK: if NO collider passes the LOS check (e.g. the
 * enemy is in open ground with no real cover between them and the player),
 * we fall back to distance-based scoring — return the closest geometrically-
 * valid collider (regardless of whether it actually blocks LOS). Moving to
 * a non-LOS-blocking collider is still better than standing still in the
 * open: it at least puts the enemy closer to a future cover position, and
 * the enemy's crouch + peek behavior still applies. The fallback is tagged
 * by the `findNearestCover.fallback` sentinel — callers can read it via the
 * `coverFallback` field on the enemy AI extra if they want to distinguish
 * "real cover" from "best-available fallback".
 *
 * Performance: O(N) over ctx.colliders for the geometric filter + O(N) for
 * the LOS ray per accepted candidate. Callers cache the result for ~1.5s
 * via `coverCacheTime` so this doesn't run every frame per enemy.
 */
export function findNearestCover(ctx: GameContext, e: Enemy, fromPos: THREE.Vector3): THREE.Vector3 | null {
  const enemyPos = e.group.position;
  const enemyToThreat = ctx.scratch.v2.copy(fromPos).sub(enemyPos);
  enemyToThreat.y = 0;
  const enemyToThreatDist = enemyToThreat.length();
  if (enemyToThreatDist < 1) return null;
  enemyToThreat.normalize();

  let best: THREE.Vector3 | null = null;
  let bestDist = Infinity;
  // Prompt #54 — distance-based fallback when no LOS-blocking cover exists.
  let fallback: THREE.Vector3 | null = null;
  let fallbackDist = Infinity;
  const maxCoverDist = 8;
  const center = new THREE.Vector3();

  for (const c of ctx.colliders) {
    c.box.getCenter(center);
    const height = c.box.max.y - c.box.min.y;
    if (height > 4 || height < 0.8) continue;

    // Project (center - enemy) onto the enemy→threat direction. The collider
    // is "between" only if the projection is in (1, enemyToThreatDist - 1).
    const enemyToCenterX = center.x - enemyPos.x;
    const enemyToCenterZ = center.z - enemyPos.z;
    const projection = enemyToCenterX * enemyToThreat.x + enemyToCenterZ * enemyToThreat.z;
    if (projection < 1 || projection > enemyToThreatDist - 1) continue;

    // Perpendicular distance from collider center to the LOS line.
    const perpX = enemyToCenterX - enemyToThreat.x * projection;
    const perpZ = enemyToCenterZ - enemyToThreat.z * projection;
    const perpDist = Math.hypot(perpX, perpZ);
    if (perpDist > 2.5) continue;

    // Cover point: on the enemy's side of the collider, offset 0.6m off the
    // collider face (away from the threat).
    const awayX = center.x - fromPos.x;
    const awayZ = center.z - fromPos.z;
    const awayLen = Math.hypot(awayX, awayZ);
    if (awayLen < 0.01) continue;
    const awayNX = awayX / awayLen, awayNZ = awayZ / awayLen;

    // Approximate collider half-extent in the horizontal plane.
    const halfExtent = Math.max(
      (c.box.max.x - c.box.min.x) * 0.5,
      (c.box.max.z - c.box.min.z) * 0.5,
    );
    const offset = halfExtent + 0.6;
    const coverX = center.x + awayNX * offset;
    const coverZ = center.z + awayNZ * offset;

    const distToEnemy = Math.hypot(coverX - enemyPos.x, coverZ - enemyPos.z);
    if (distToEnemy > maxCoverDist) continue;

    // Prompt #54 — REAL LOS CHECK: raycast from the cover point to the
    // threat position. The cover is only valid if the ray is blocked by
    // a collider (i.e. the player can't see the enemy at this position).
    // Ray at chest height (y=1.2) so low cover (0.8m) correctly blocks LOS
    // to the enemy's torso but the enemy can still fire over it.
    const losBlocks = losBlocked(ctx, coverX, coverZ, fromPos.x, fromPos.z);

    if (losBlocks) {
      if (distToEnemy < bestDist) {
        bestDist = distToEnemy;
        if (!best) best = new THREE.Vector3();
        best.set(coverX, 0, coverZ);
      }
    } else if (distToEnemy < fallbackDist) {
      // Prompt #54 — distance-based fallback: track the closest non-LOS-
      // blocking collider. Used only if no LOS-blocking cover is found.
      fallbackDist = distToEnemy;
      if (!fallback) fallback = new THREE.Vector3();
      fallback.set(coverX, 0, coverZ);
    }
  }
  // Prompt #54 — prefer real LOS-blocking cover; fall back to the closest
  // geometrically-valid collider if none exists. Both can be null if no
  // collider passed the geometric filter (enemy in fully open ground).
  const result = best ?? fallback;
  // Tag the fallback flag on the enemy so callers (tickCover, tickSuppressed)
  // can distinguish "real cover" from "best-available fallback" if they want
  // to bias behavior (e.g. peek less aggressively when behind fallback cover).
  ai(e).coverFallback = result !== null && best === null;
  return result;
}

/**
 * Prompt #54 — Real LOS raycast between two horizontal positions at a given
 * height. Returns true if any collider (0.8m..4m tall) blocks the ray.
 * Uses the same slab-based ray-AABB test as the pathfinding helper. Both
 * endpoints are sampled at chest height (1.2m); the collider height filter
 * ensures the collider is tall enough to block a chest-height ray.
 */
function losBlocked(ctx: GameContext, fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  const dx = toX - fromX, dz = toZ - fromZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.001) return false;
  const dirX = dx / dist, dirZ = dz / dist;
  for (const c of ctx.colliders) {
    const h = c.box.max.y - c.box.min.y;
    if (h < 0.8 || h > 4) continue;
    if (rayHitsCollider(fromX, fromZ, dirX, dirZ, c.box, dist - 0.3)) return true;
  }
  return false;
}

/**
 * Task-5 — Cached cover lookup. Returns the cached cover position if it was
 * computed within `ttlMs` (default 1500ms), otherwise recomputes. The
 * cache lives on the enemy (coverCachePos + coverCacheTime) so each enemy
 * only re-scans colliders ~0.7 Hz instead of every frame.
 */
function cachedCover(
  ctx: GameContext, e: Enemy, fromPos: THREE.Vector3, now: number, ttlMs = 1500,
): THREE.Vector3 | null {
  const ex = ai(e);
  if (ex.coverCachePos !== undefined && ex.coverCacheTime && now - ex.coverCacheTime < ttlMs) {
    return ex.coverCachePos;
  }
  ex.coverCachePos = findNearestCover(ctx, e, fromPos);
  ex.coverCacheTime = now;
  return ex.coverCachePos;
}

// ---------- Grenade throwing ----------

/**
 * Task-5 — Check whether the player is in a defensible position (near a
 * collider that could be cover). Used to gate grenade throws so enemies
 * only throw when the player is "turtling" behind cover.
 */
function isPlayerInCover(ctx: GameContext): boolean {
  const p = ctx.player.pos;
  for (const c of ctx.colliders) {
    const cx = (c.box.min.x + c.box.max.x) * 0.5;
    const cz = (c.box.min.z + c.box.max.z) * 0.5;
    const d = Math.hypot(cx - p.x, cz - p.z);
    if (d < 2.0) {
      const h = c.box.max.y - c.box.min.y;
      if (h >= 0.8 && h <= 4) return true;
    }
  }
  return false;
}

/**
 * Task-5 — Maybe throw a grenade at the player. Per-enemy cooldown of
 * 15-25s, randomized on first call. Only throws if:
 *   - The player is within 10-20m (grenade range).
 *   - The player is in cover (near a collider) — flush them out.
 *   - The enemy's class is grenade-capable (RIFLEMAN / MG / COMMANDER).
 *
 * Uses the `ctx.enemyGrenadeThrow` hook, which GrenadeSystem.constructor
 * self-registers. No-op if the hook isn't wired (e.g. before the grenade
 * system is constructed).
 */
function tryThrowGrenade(ctx: GameContext, e: Enemy, now: number): boolean {
  const ex = ai(e);
  if (ex.nextGrenadeAt === undefined) {
    ex.nextGrenadeAt = now + 15000 + Math.random() * 10000; // 15-25s
  }
  if (now < ex.nextGrenadeAt) return false;
  if (!ctx.enemyGrenadeThrow) return false;

  // Class gating — snipers hold position, CQB rushes. Don't give them nades.
  const cls = enemyClass(e);
  if (cls === "SNIPER" || cls === "CQB") return false;

  // Range gate — only throw at mid-range targets.
  const dx = ctx.player.pos.x - e.group.position.x;
  const dz = ctx.player.pos.z - e.group.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 10 || dist > 20) return false;

  // Only throw if the player is in cover (flush them out).
  if (!isPlayerInCover(ctx)) return false;

  // A3-5000 #508: emit the GRENADE bark ("Frag out!") — the config exists in
  // barks.ts but was never wired from gameplay.
  try { emitBark(ctx, e, "GRENADE"); } catch { /* non-fatal */ }

  // Throw from the enemy's chest toward the player's PREDICTED position.
  // Prompt #55 — predict where the player will be when the grenade lands.
  // leadTime = distance / grenade_velocity. The GrenadeSystem throws with
  // a horizontal velocity of ~15 m/s (matches the player's grenade throw
  // velocity in releaseGrenade — GrenadeSystem.throwFromEnemy uses a 1.8s
  // flight time, but the horizontal velocity magnitude varies with range;
  // 15 m/s is the canonical value used across the throw code). For a 15m
  // throw, leadTime ≈ 1.0s; for a 20m throw, ≈ 1.33s. The player's
  // velocity (ctx.player.vel) is in m/s, so target += vel * leadTime.
  const origin = e.group.position.clone();
  origin.y = 1.2;
  const target = ctx.player.pos.clone();
  const GRENADE_VELOCITY = 15; // m/s — matches GrenadeSystem.throwFromEnemy
  const leadTime = dist / GRENADE_VELOCITY;
  target.x += ctx.player.vel.x * leadTime;
  target.z += ctx.player.vel.z * leadTime;

  ctx.enemyGrenadeThrow(origin, target);

  // Reset cooldown (15-25s).
  ex.nextGrenadeAt = now + 15000 + Math.random() * 10000;
  return true;
}

// ---------- Blind-fire shooting ----------

/**
 * Task-5 — Shoot from cover toward the player without requiring a clear LOS.
 * Accuracy is scaled by `accuracyMult` (default 0.35):
 *   • 0.3  — blind fire from behind cover (ducked back, can't see player).
 *            Used by tickCover (ducked-back blind fire) and tickSuppressed.
 *   • 0.6  — peek snapshot (exposed but quick — strafed out from cover).
 *            Used by tickCover during the peek window.
 * Spawns a tracer via the particle pool, plays a muffled gunshot
 * (occluded=true), applies suppression, and applies damage with simple
 * armor absorption on hit.
 *
 * Used by tickCover (peek snapshot + ducked-back blind fire) and
 * tickSuppressed (suppressed blind-fire). Bypasses EnemySystem.enemyShoot
 * because we can't reach it from here (no shootFn in tickCover's
 * signature) — the damage path is the same simple armor-absorption model
 * used by the grenade explode() for player damage.
 */
function blindFireShot(ctx: GameContext, e: Enemy, now: number, accuracyMult = 0.35) {
  const origin = ctx.scratch.rayOrigin.copy(e.group.position);
  origin.y = 1.4; // slightly above the head when blind-firing over cover
  const target = ctx.scratch.rayDir.copy(ctx.player.pos);
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.1) return;

  // Audio — occluded=true (muffled, behind cover).
  const cls = enemyClass(e);
  // Task-12 — include the new classes' calibers. SHOTGUNNER uses pistol
  // audio (the spec reuses pistol SFX); SCOUT uses smg; MEDIC + SHIELD
  // use pistol. ZOMBIE never reaches blindFireShot (no shooting state).
  const caliber =
    cls === "SNIPER" ? "sniper" :
    cls === "MG" || cls === "SCOUT" ? "smg" :
    (cls === "CQB" || cls === "MEDIC" || cls === "SHIELD" || cls === "SHOTGUNNER") ? "pistol" :
    "rifle";
  ctx.audio.distantGunshot(origin.x, origin.y, origin.z, true, caliber);

  // Tracer via the shared particle pool — same path as ParticleSystem.spawnTracer.
  const line = ctx.particlePool.acquireTracer(origin, target);
  if (line) {
    ctx.particlePool.activeTracers.push({ line, life: 0.08, maxLife: 0.08, active: true });
  }

  // Suppression — blind-fire is highly suppressive (close range = more).
  const supp = dist < 5 ? 0.12 : dist < 15 ? 0.06 : 0.02;
  ctx.suppression.value = Math.min(1, ctx.suppression.value + supp);

  // Damage — reduced hit chance, reduced damage (blind fire is mostly
  // suppressive). Uses the same simple armor absorption as the grenade.
  const hitChance = e.accuracy * accuracyMult * Math.max(0.1, 1 - dist / 50);
  if (Math.random() < hitChance) {
    let dmg = 3 + Math.random() * 6; // 3-9 dmg (low — it's blind fire)
    if (ctx.player.armor > 0) {
      const absorbed = Math.min(ctx.player.armor, dmg * 0.6);
      ctx.player.armor -= absorbed;
      dmg -= absorbed;
    }
    ctx.player.health -= dmg;
    ctx.audio.damage();
    // Directional damage indicator.
    const wYaw = Math.atan2(dx, dz);
    ctx.player.lastDamageDir = wYaw - ctx.player.yaw;
    ctx.player.lastDamageTime = now;
    ctx.pushHud({
      health: Math.max(0, Math.round(ctx.player.health)),
      armor: Math.max(0, Math.round(ctx.player.armor)),
      damageFlash: now,
    });
    const shake = Math.min(0.4, dmg * 0.02);
    ctx.triggerShake(shake);
    if (ctx.player.health <= 0) ctx.onGameOver();
  }

  e.lastShot = now;
}

// ---------- FSM state behaviors ----------

/**
 * Task-5 — SUPPRESSED enemy behavior. Improved from the legacy "drop prone
 * + random" pattern: the enemy now crouches (lowered group.position.y),
 * seeks the nearest cover, holds there, and blind-fires occasionally to
 * keep the player pinned while suppression decays.
 *
 * Prompt #53 — DUCK/PEEK: when an enemy's suppression value is high
 * (SUPPRESSED state is entered when ctx.suppression.value crosses the
 * class's suppressionThreshold, default 0.6), the enemy now:
 *   1. Stops advancing (crouches behind nearest cover).
 *   2. Holds the cover position for 2-3s (ducked back, blind-firing).
 *   3. Peeks out for 0.6s to take a snap shot at 0.5× accuracy, then
 *      ducks back. Repeats the cycle until suppression decays below
 *      recoveryThreshold (default 0.2) → FSM transitions back to CHASE.
 *
 * The peek cycle reuses the SUPPRESSED sub-state fields (`suppIsPeeking`,
 * `suppNextActionAt`, `suppPeekDir`) so it survives across ticks without
 * re-entering the FSM state. Direction alternates each peek so the enemy
 * doesn't always expose the same side.
 */
export function tickSuppressed(ctx: GameContext, e: Enemy, dt: number, collides: (e: Enemy) => boolean) {
  const now = performance.now();
  const ex = ai(e);
  if (ex.suppEnterTime === undefined) ex.suppEnterTime = now;

  // Crouch visual — lower the enemy's group.position.y by ~0.3m.
  // Duck back deeper when not peeking (the enemy is hugging the cover).
  // When peeking, raise slightly so the enemy can see over the cover.
  const isPeeking = ex.suppIsPeeking === true;
  applyCrouch(e, dt, isPeeking ? 0.15 : 0.35);

  const coverPos = ((): THREE.Vector3 | null => {
    if (ex.suppCoverPos !== undefined && ex.suppCoverCacheTime && now - ex.suppCoverCacheTime < 1500) {
      return ex.suppCoverPos;
    }
    ex.suppCoverPos = findNearestCover(ctx, e, ctx.player.pos);
    ex.suppCoverCacheTime = now;
    return ex.suppCoverPos;
  })();

  // Perpendicular axis (player LOS perpendicular — used for peek strafe).
  const losX = ctx.player.pos.x - e.group.position.x;
  const losZ = ctx.player.pos.z - e.group.position.z;
  const losLen = Math.hypot(losX, losZ) || 1;
  const perpX = -losZ / losLen;
  const perpZ = losX / losLen;

  if (!coverPos) {
    // No cover — stay still and blind-fire occasionally.
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, 0, 10, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, 0, 10, dt);
  } else {
    const toCover = ctx.scratch.v3.copy(coverPos).sub(e.group.position);
    toCover.y = 0;
    const coverDist = toCover.length();
    if (coverDist > 1.2) {
      toCover.normalize();
      const coverSpeed = e.speed * 0.7;
      // Prompt #52 — steer around obstacles on the way to cover.
      const steered = applyPathSteer(ctx, e, toCover.x * coverSpeed, toCover.z * coverSpeed);
      e.velocity.x = THREE.MathUtils.damp(e.velocity.x, steered.x, 8, dt);
      e.velocity.z = THREE.MathUtils.damp(e.velocity.z, steered.z, 8, dt);
    } else {
      // Prompt #53 — At cover. Manage the peek cycle: peek out for 0.6s
      // every 2-3s, duck back in between. This is the "duck/peek" behavior
      // the prompt asks for — a suppressed enemy isn't a sitting duck, it
      // exposes briefly to return fire then ducks back.
      if (ex.suppIsPeeking === undefined) {
        ex.suppIsPeeking = false;
        ex.suppNextActionAt = now + 2000 + Math.random() * 1000; // first peek in 2-3s
        ex.suppPeekDir = Math.random() < 0.5 ? 1 : -1;
      }
      if (ex.suppIsPeeking) {
        // Currently peeking — strafe sideways out of cover by ~0.5m.
        const peekDir = ex.suppPeekDir ?? 1;
        const peekSpeed = e.speed * 0.5;
        e.velocity.x = THREE.MathUtils.damp(e.velocity.x, perpX * peekDir * peekSpeed, 8, dt);
        e.velocity.z = THREE.MathUtils.damp(e.velocity.z, perpZ * peekDir * peekSpeed, 8, dt);
        if (now >= (ex.suppNextActionAt ?? 0)) {
          // Peek ended — duck back. Schedule the next peek.
          ex.suppIsPeeking = false;
          ex.suppNextActionAt = now + 2000 + Math.random() * 1000; // 2-3s hold
        }
      } else {
        // Ducked back behind cover — hold position with a tiny jitter so
        // the enemy is never perfectly still.
        const jitter = Math.sin(now * 0.005 + e.gaitPhase) * 0.2;
        e.velocity.x = THREE.MathUtils.damp(e.velocity.x, perpX * jitter * e.speed * 0.15, 8, dt);
        e.velocity.z = THREE.MathUtils.damp(e.velocity.z, perpZ * jitter * e.speed * 0.15, 8, dt);
        if (now >= (ex.suppNextActionAt ?? 0)) {
          // Time to peek — alternate direction.
          ex.suppIsPeeking = true;
          ex.suppPeekDir = (ex.suppPeekDir === 1 ? -1 : 1);
          ex.suppNextActionAt = now + 600; // peek for 0.6s
        }
      }
    }
  }
  moveEnemyWithCollision(ctx, e, dt, collides);

  // ---- Shooting: peek snapshot vs blind fire ----
  // Prompt #53 — when peeking, the enemy takes a snap shot at 0.5× accuracy
  // (exposed briefly, can see the player). When ducked back, blind-fires at
  // 0.25× accuracy (can't see the player — keeps their head down).
  if (isPeeking) {
    // Peek snapshot — one shot per peek (the 600ms lockout matches the peek
    // window length, so the enemy can't fire twice in a single peek).
    if (now - e.lastShot > 600) {
      blindFireShot(ctx, e, now, 0.5);
    }
  } else {
    // Blind fire from behind cover — keeps the player pinned while
    // suppression decays.
    if (ex.suppNextBlindFireAt === undefined) {
      ex.suppNextBlindFireAt = now + 1200 + Math.random() * 1800;
    }
    if (now >= ex.suppNextBlindFireAt) {
      blindFireShot(ctx, e, now, 0.25); // very low accuracy while suppressed
      ex.suppNextBlindFireAt = now + 1500 + Math.random() * 2000;
    }
  }
}

/**
 * Task-5 — Flank behavior. Improved from the legacy "perpendicular strafe"
 * pattern: the flanker now moves to a position ~90° offset from the
 * player's facing direction (attacking from the side/rear where the player
 * isn't looking), and moves 1.3x faster than chase speed.
 *
 * Flankers shoot on the move if they have LOS.
 */
export function tickFlank(
  ctx: GameContext, e: Enemy, dt: number, hasLOS: boolean, now: number, dist: number,
  toPlayer: THREE.Vector3, shoot: (e: Enemy, dist: number) => void, collides: (e: Enemy) => boolean,
) {
  // Task-5 — Stand back up if we were crouching.
  applyCrouch(e, dt, 0);

  // Target = a point ~8m to the side of the player (90° offset from the
  // player's facing direction). Pick left or right based on gaitPhase so
  // the direction is stable per-enemy (each flanker picks a side and
  // sticks with it).
  const flankSign = e.gaitPhase > Math.PI ? 1 : -1;
  // Player's right direction (yaw convention: forward = (sin, 0, cos)).
  const playerRightX = Math.cos(ctx.player.yaw);
  const playerRightZ = -Math.sin(ctx.player.yaw);
  const flankTargetX = ctx.player.pos.x + playerRightX * flankSign * 8;
  const flankTargetZ = ctx.player.pos.z + playerRightZ * flankSign * 8;

  // Move toward the flank target.
  const toFlankX = flankTargetX - e.group.position.x;
  const toFlankZ = flankTargetZ - e.group.position.z;
  const toFlankLen = Math.hypot(toFlankX, toFlankZ) || 1;
  const flankSpeed = e.speed * 1.3;
  const desiredX = (toFlankX / toFlankLen) * flankSpeed;
  const desiredZ = (toFlankZ / toFlankLen) * flankSpeed;

  // Small forward component so the flanker still closes distance when far.
  // This prevents the flanker from orbiting forever at exactly 8m offset.
  if (dist > 12) {
    const fwdBlend = 0.4;
    const blendedX = desiredX * (1 - fwdBlend) + toPlayer.x * e.speed * fwdBlend;
    const blendedZ = desiredZ * (1 - fwdBlend) + toPlayer.z * e.speed * fwdBlend;
    // Prompt #52 — steer around obstacles on the flank path.
    const steered = applyPathSteer(ctx, e, blendedX, blendedZ);
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, steered.x, 6, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, steered.z, 6, dt);
  } else {
    // Prompt #52 — steer around obstacles on the flank path.
    const steered = applyPathSteer(ctx, e, desiredX, desiredZ);
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, steered.x, 6, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, steered.z, 6, dt);
  }
  moveEnemyWithCollision(ctx, e, dt, collides);

  // Flankers shoot on the move if they have LOS.
  if (hasLOS && now - e.lastShot > 1200 + Math.random() * 600) {
    e.lastShot = now;
    shoot(e, dist);
  }

  // Task-5 — flankers can throw grenades to flush a turtling player.
  tryThrowGrenade(ctx, e, now);
}

/**
 * Task-5 — Chase/idle behavior. Closes distance to the player, with
 * cover-to-cover advance at medium range. Also routes the COVER FSM state
 * to tickCover (since COVER maps to legacy "idle" in the EnemySystem
 * dispatch, tickChase runs for COVER — we detect it here and delegate).
 *
 * G2.2 — at medium range (12–25m), advance cover-to-cover instead of
 * walking straight at the player. This makes firefights read as tactical.
 *
 * Task-12 — Class-gated special behaviors (per the task's final approach:
 * no new FSM states; behavior is gated on the enemy's class + current FSM
 * state, dispatched internally from the existing tick functions):
 *   - MEDIC: if a nearby ally needs healing, run tickMedicHeal instead of
 *     normal chase. The medic still defends itself with a pistol via the
 *     EnemySystem shooting path when not actively channeling a heal.
 *   - SCOUT: in IDLE (pre-spotting), run recon patrol (sprint to random
 *     patrol points seeking the player). On the first CHASE tick after
 *     spotting, fire the 30m wide callout (vs the normal 20m radius).
 *   - SHIELD: advance directly toward the player (no cover-to-cover — the
 *     shield is its cover). Skip the medium-range cover logic.
 *   - SHOTGUNNER: rush the player directly (close distance fast, no
 *     cover-to-cover — wants to get within 6m ASAP).
 */
export function tickChase(
  ctx: GameContext, e: Enemy, dt: number, now: number, toPlayer: THREE.Vector3, collides: (e: Enemy) => boolean,
) {
  // Task-5 — Route COVER state to tickCover. EnemySystem's dispatch maps
  // COVER to legacy "idle" (COVER isn't in its fsmStateMap), so tickChase
  // runs for COVER. Detect + delegate. (tickCover internally handles the
  // Task-12 SHIELD + SCOUT class gates for the COVER state.)
  if (e.fsm?.state === "COVER") {
    tickCover(ctx, e, dt, now, collides);
    return;
  }

  // Task-12 — Class-gated dispatch. Each special class takes over the
  // tickChase slot for its own behavior; non-special classes fall through
  // to the existing cover-to-cover + strafe logic below.
  const cls = enemyClass(e);

  // MEDIC — heal/revive logic takes priority over chase. If the medic is
  // actively healing (channeling or moving to a target), tickMedicHeal
  // returns true and we skip the normal chase. Otherwise the medic falls
  // through to normal chase behavior (closing distance to the player).
  if (cls === "MEDIC") {
    if (tickMedicHeal(ctx, e, dt, now, collides)) return;
    // No healing needed right now — fall through to normal chase so the
    // medic closes distance with the squad (it shouldn't lag behind).
  }

  // SCOUT — recon patrol while in IDLE (pre-spotting). On the first CHASE
  // tick after spotting, fire the 30m wide callout. In CHASE the scout
  // falls through to normal chase (its high speed naturally flanks).
  if (cls === "SCOUT") {
    const fsmState = e.fsm?.state ?? "IDLE";
    if (fsmState === "IDLE" || fsmState === "PATROL") {
      tickScoutRecon(ctx, e, dt, now, collides);
      return;
    }
    // First CHASE tick after spotting → wide callout (30m radius).
    if (!ai(e).scoutWideCalloutDone) {
      const firstSeenAt = (e as unknown as { firstSeenAt?: number }).firstSeenAt ?? 0;
      if (firstSeenAt > 0) {
        scoutWideCallout(ctx, e, now);
        ai(e).scoutWideCalloutDone = true;
      }
    }
    // Fall through to normal chase — the scout's high speed (4.5 m/s)
    // naturally flanks during the chase.
  }

  // SHIELD — advance directly toward the player. Skip the cover-to-cover
  // logic below (the shield is its cover; the trooper never seeks cover).
  // The drop-shield-at-30%-HP logic is in tickCover (the FSM forces COVER
  // at <40% HP; tickCover for shield troopers at <30% HP drops the shield
  // + sends moraleBreak). At >30% HP the trooper advances even from COVER.
  if (cls === "SHIELD") {
    tickShieldAdvance(ctx, e, dt, toPlayer, collides, now);
    return;
  }

  // SHOTGUNNER — rush the player (close distance fast, no cover-to-cover).
  // The 6-pellet blast fires from tickAttackMaintainRange once within 6m.
  if (cls === "SHOTGUNNER") {
    tickShotgunnerRush(ctx, e, dt, toPlayer, collides);
    return;
  }

  // Task-5 — Stand back up if we were crouching (SUPPRESSED/COVER exit).
  applyCrouch(e, dt, 0);

  const distToPlayer = toPlayer.length();
  const moveSpeed = e.state === "chase" ? e.speed : e.speed * 0.4;

  // G2.2 — Cover-to-cover advance at medium range.
  // Task-5 — use the 1.5s cached cover lookup (cachedCover) instead of
  // calling findNearestCover every frame. This is the spec-mandated perf
  // throttle: cover scans are O(N) over ctx.colliders, and at 30 enemies
  // × 60fps an uncached scan would burn ~1800 collider loops/sec for the
  // chase cohort alone. The cache lives on the enemy (coverCachePos +
  // coverCacheTime) so it's shared with tickCover — same threat pos.
  if (distToPlayer > 12 && distToPlayer < 25) {
    const coverPos = cachedCover(ctx, e, ctx.player.pos, now);
    if (coverPos) {
      const toCover = ctx.scratch.v2.copy(coverPos).sub(e.group.position);
      toCover.y = 0;
      const coverDist = toCover.length();
      if (coverDist > 1.0) {
        toCover.normalize();
        const coverVel = toCover.multiplyScalar(moveSpeed);
        // Prompt #52 — steer around obstacles on the way to cover.
        const steered = applyPathSteer(ctx, e, coverVel.x, coverVel.z);
        e.velocity.x = THREE.MathUtils.damp(e.velocity.x, steered.x, 6, dt);
        e.velocity.z = THREE.MathUtils.damp(e.velocity.z, steered.z, 6, dt);
        moveEnemyWithCollision(ctx, e, dt, collides);
        return;
      }
      // At cover — peek + strafe along the cover line, still closing slowly.
      const strafe = Math.sin(now * 0.003 + e.gaitPhase) * 0.6;
      const perp = ctx.scratch.v3.set(-toPlayer.z, 0, toPlayer.x).multiplyScalar(strafe * moveSpeed * 0.5);
      const fwd = ctx.scratch.v4.copy(toPlayer).multiplyScalar(moveSpeed * 0.3);
      e.velocity.x = THREE.MathUtils.damp(e.velocity.x, perp.x + fwd.x, 6, dt);
      e.velocity.z = THREE.MathUtils.damp(e.velocity.z, perp.z + fwd.z, 6, dt);
      moveEnemyWithCollision(ctx, e, dt, collides);
      return;
    }
  }

  // Default: close distance to player, strafe slightly.
  const desiredVel = ctx.scratch.v2.copy(toPlayer).multiplyScalar(moveSpeed);
  // Prompt #52 — steer around obstacles between the enemy and the player.
  // applyPathSteer returns a detour velocity when the straight path is
  // blocked by a collider; otherwise it returns the desired velocity
  // unchanged. The cached steer direction is recomputed every 0.5s.
  const steeredVel = applyPathSteer(ctx, e, desiredVel.x, desiredVel.z);
  e.velocity.x = THREE.MathUtils.damp(e.velocity.x, steeredVel.x, 6, dt);
  e.velocity.z = THREE.MathUtils.damp(e.velocity.z, steeredVel.z, 6, dt);
  const strafe = Math.sin(now * 0.002 + e.gaitPhase) * 0.5;
  const perp = ctx.scratch.v3.set(-toPlayer.z, 0, toPlayer.x).multiplyScalar(strafe);
  e.velocity.x += perp.x; e.velocity.z += perp.z;
  moveEnemyWithCollision(ctx, e, dt, collides);
}

/**
 * Task-5 — ATTACK-state behavior. Adds corner-peek strafing on top of the
 * G2.3 range-maintenance logic: enemies strafe between two positions near
 * their attack range (peek left/right), flipping direction every 1.5-2.5s.
 * This makes enemies harder to hit and looks like they're using cover edges.
 *
 * Snipers/MG still back away to maintain engagement range if the player
 * rushes in; CQB/rifleman hold their ground and strafe.
 *
 * Task-12 — Class-gated ATTACK behaviors:
 *   - MEDIC: tickMedicHeal at the top. If healing, return. Else fall through
 *     to normal strafe + the regular EnemySystem shooting path (pistol).
 *   - SHIELD: tickShieldAdvance (slow advance, no strafe, no back-away).
 *     The shield trooper never strafes or backs away — it walks forward.
 *   - SHOTGUNNER: rush closer if dist > 6m (within attackRange but wants
 *     point-blank). At <= 6m, fire the 6-pellet blast on cooldown.
 *   - SCOUT: high strafe (1.5x) + no back-away (the scout relies on speed,
 *     not range). Falls through to normal strafe with the bumped magnitude.
 */
export function tickAttackMaintainRange(
  ctx: GameContext, e: Enemy, dt: number, dist: number, toPlayer: THREE.Vector3,
  attackRange: number, collides: (e: Enemy) => boolean,
) {
  const now = performance.now();
  const ex = ai(e);
  const cls = enemyClass(e);

  // Task-12 — MEDIC: heal/revive logic takes priority over attack.
  if (cls === "MEDIC") {
    if (tickMedicHeal(ctx, e, dt, now, collides)) return;
    // No healing needed — fall through to normal attack (pistol defense).
  }

  // Task-12 — SHIELD: advance toward the player (no strafe, no back-away).
  // The shield trooper's "attack" is walking forward while firing its
  // pistol via the regular EnemySystem shooting path.
  if (cls === "SHIELD") {
    tickShieldAdvance(ctx, e, dt, toPlayer, collides, now);
    return;
  }

  // Task-12 — SHOTGUNNER: rush to point-blank + fire the 6-pellet blast.
  if (cls === "SHOTGUNNER") {
    applyCrouch(e, dt, 0); // stand tall
    const SHOTGUN_RANGE = 6;
    if (dist > SHOTGUN_RANGE) {
      // Not yet at point-blank — keep rushing closer.
      const rushSpeed = e.speed * 1.1;
      const desiredVX = toPlayer.x * rushSpeed;
      const desiredVZ = toPlayer.z * rushSpeed;
      e.velocity.x = THREE.MathUtils.damp(e.velocity.x, desiredVX, 6, dt);
      e.velocity.z = THREE.MathUtils.damp(e.velocity.z, desiredVZ, 6, dt);
      moveEnemyWithCollision(ctx, e, dt, collides);
      // Suppress the regular shooting path while closing distance (the
      // shotgunner doesn't take potshots — it waits for the blast).
      e.lastShot = now;
    } else {
      // Point-blank — stand still + fire the 6-pellet blast on cooldown.
      e.velocity.x = THREE.MathUtils.damp(e.velocity.x, 0, 8, dt);
      e.velocity.z = THREE.MathUtils.damp(e.velocity.z, 0, 8, dt);
      moveEnemyWithCollision(ctx, e, dt, collides);
      // Blast cooldown: 700-1200ms (matches SHOTGUNNER.shotCooldown).
      const blastCdMs = 700 + Math.random() * 500;
      if (now - (ex.shotgunnerLastBlastAt ?? 0) >= blastCdMs) {
        ex.shotgunnerLastBlastAt = now;
        shotgunPelletBlast(ctx, e, now, dist);
      } else {
        // On cooldown — still suppress the regular shooting path so it
        // doesn't fire a single pellet between blasts.
        e.lastShot = now;
      }
    }
    return;
  }

  // Task-5 — Stand back up if we were crouching (COVER exit).
  applyCrouch(e, dt, 0);

  // Prompt #59 — Distinct movement signatures per archetype.
  //   • MG (heavy)      — slow deliberate peeks: long hold (3-4s), tiny
  //                       strafe (0.4×). The MG is a suppressive platform;
  //                       it plants and lays down fire, only nudging to
  //                       avoid getting headshot.
  //   • SCOUT           — erratic strafe: flips direction every 0.5-1.0s
  //                       (vs the grunt's 1.5-2.5s) at 1.5× magnitude.
  //                       Reads as a twitchy close-quarters duelist.
  //   • CQB             — aggressive strafe at 1.4× with normal hold.
  //   • SNIPER          — barely moves (0.3×); holds a stable firing position.
  //   • RIFLEMAN (grunt)— standard advance: 1.5-2.5s hold, 1.0× strafe.
  // The peek hold duration + strafe magnitude are computed once per
  // direction flip below; the per-class values are factored into a small
  // table so they're easy to tune.
  const peekHoldMs = (() => {
    if (cls === "MG") return 3000 + Math.random() * 1000; // 3-4s
    if (cls === "SCOUT") return 500 + Math.random() * 500; // 0.5-1.0s
    if (cls === "CQB") return 1200 + Math.random() * 800; // 1.2-2.0s
    if (cls === "SNIPER") return 2500 + Math.random() * 1500; // 2.5-4.0s
    return 1500 + Math.random() * 1000; // grunt: 1.5-2.5s
  })();

  // Initialize peek state on first call.
  if (ex.peekDir === undefined) {
    ex.peekDir = Math.random() < 0.5 ? 1 : -1;
    ex.peekTimer = now + peekHoldMs;
  }
  // Flip peek direction on a timer.
  if (now >= (ex.peekTimer ?? 0)) {
    ex.peekDir = (ex.peekDir === 1 ? -1 : 1);
    ex.peekTimer = now + peekHoldMs;
  }

  // Perpendicular strafe (peek left/right around the current position).
  // Magnitude scales with class: CQB strafes harder (close-range dodging),
  // snipers barely strafe (they want a stable firing position).
  // Task-12 — SCOUT strafes rapidly (1.5x) per the spec.
  // Prompt #59 — MG strafes at 0.4× (heavy platform, barely moves).
  let strafeMag = 1.0;
  if (cls === "CQB") strafeMag = 1.4;
  else if (cls === "SCOUT") strafeMag = 1.5;
  else if (cls === "SNIPER") strafeMag = 0.3;
  else if (cls === "MG") strafeMag = 0.4; // Prompt #59 — heavy, barely moves

  const perpX = -toPlayer.z * (ex.peekDir ?? 1);
  const perpZ = toPlayer.x * (ex.peekDir ?? 1);
  const strafeVel = strafeMag * e.speed * 0.7;
  let desiredVX = perpX * strafeVel;
  let desiredVZ = perpZ * strafeVel;

  // G2.3 — range maintenance: snipers/MG (attackRange > 8) back away if
  // the player gets inside 50% of their attack range. CQB/rifleman hold.
  // Task-12 — SCOUT (attackRange 12) skips back-away — the scout relies
  // on speed + strafing, not range maintenance. SHIELD is handled above.
  let backingAway = false;
  if (attackRange > 8 && cls !== "SCOUT") {
    const minRange = attackRange * 0.5;
    if (dist < minRange) {
      const retreatX = -toPlayer.x * e.speed * 0.8;
      const retreatZ = -toPlayer.z * e.speed * 0.8;
      desiredVX = retreatX + perpX * strafeVel * 0.4;
      desiredVZ = retreatZ + perpZ * strafeVel * 0.4;
      backingAway = true;
    }
  }

  e.velocity.x = THREE.MathUtils.damp(e.velocity.x, desiredVX, 6, dt);
  e.velocity.z = THREE.MathUtils.damp(e.velocity.z, desiredVZ, 6, dt);
  moveEnemyWithCollision(ctx, e, dt, collides);

  // Task-5 — ATTACK-state enemies can throw grenades (the primary grenade
  // use case — flush a turtling player while the enemy has LOS).
  if (!backingAway) {
    tryThrowGrenade(ctx, e, now);
  }
}

/**
 * Task-5 — COVER state behavior. The enemy:
 *   1. Moves to the nearest cover (cached for 1.5s — don't scan every frame).
 *   2. At cover, peeks out every 2-3s (strafe sideways ~0.5m) and takes a
 *      snapshot shot at 0.6× accuracy (exposed but quick).
 *   3. When ducked back behind cover, blind-fires at 0.3× accuracy if the
 *      player is suppressing (suppression > 0.5) OR the enemy's last shot
 *      was > 2s ago.
 *   4. Throws grenades to flush a turtling player.
 *   5. Transitions back to ATTACK after 3s (handled by the FSM — see
 *      EnemyFSM.tick COVER branch).
 *
 * The enemy never stands still — even at cover it strafes slightly during
 * peek windows and duck-backs. Movement is always happening.
 */
export function tickCover(
  ctx: GameContext, e: Enemy, dt: number, now: number, collides: (e: Enemy) => boolean,
) {
  const ex = ai(e);
  const cls = enemyClass(e);

  // Task-12 — SHIELD trooper in COVER: never actually use cover (the shield
  // is its cover). Delegate to tickShieldAdvance which handles the advance
  // + the drop-shield-at-30%-HP logic (sends moraleBreak → FLEE).
  if (cls === "SHIELD") {
    tickShieldAdvance(ctx, e, dt,
      ctx.scratch.v2.copy(ctx.player.pos).sub(e.group.position).setY(0).normalize(),
      collides, now);
    return;
  }

  // Task-12 — SCOUT in COVER: never stay in cover (too fast — relies on
  // speed). Immediately request exitCover so the FSM transitions back to
  // ATTACK. The FSM's COVER lifecycle would eventually fire exitCover after
  // 3s anyway, but the scout shouldn't wait — it should re-engage now.
  if (cls === "SCOUT") {
    e.fsm?.send("exitCover");
    // While we wait for the FSM transition (next tick), do a fast strafe
    // so the scout isn't a sitting duck this frame.
    applyCrouch(e, dt, 0);
    const strafe = Math.sin(now * 0.006 + e.gaitPhase) * 1.2;
    const perpX = -(ctx.player.pos.z - e.group.position.z);
    const perpZ = (ctx.player.pos.x - e.group.position.x);
    const pl = Math.hypot(perpX, perpZ) || 1;
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, (perpX / pl) * strafe * e.speed, 8, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, (perpZ / pl) * strafe * e.speed, 8, dt);
    moveEnemyWithCollision(ctx, e, dt, collides);
    return;
  }

  // Slight crouch while in cover (visual cue + smaller hit profile).
  applyCrouch(e, dt, 0.25);

  // Cached cover lookup — only re-scan colliders every 1.5s.
  const coverPos = cachedCover(ctx, e, ctx.player.pos, now, 1500);

  if (!coverPos) {
    // No cover available — fall back to a slow strafe + occasional blind
    // fire. Don't stand still.
    const strafe = Math.sin(now * 0.003 + e.gaitPhase) * 0.7;
    const perpX = -(ctx.player.pos.z - e.group.position.z);
    const perpZ = (ctx.player.pos.x - e.group.position.x);
    const pl = Math.hypot(perpX, perpZ) || 1;
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, (perpX / pl) * strafe * e.speed * 0.6, 6, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, (perpZ / pl) * strafe * e.speed * 0.6, 6, dt);
    moveEnemyWithCollision(ctx, e, dt, collides);
    // Still try to throw a grenade if conditions are met.
    tryThrowGrenade(ctx, e, now);
    // Blind-fire if it's been a while.
    if (now - e.lastShot > 2000) {
      blindFireShot(ctx, e, now, 0.3);
    }
    return;
  }

  // Distance to the cover point.
  const toCoverX = coverPos.x - e.group.position.x;
  const toCoverZ = coverPos.z - e.group.position.z;
  const coverDist = Math.hypot(toCoverX, toCoverZ);

  // Direction from player to enemy (used to compute the "peek" strafe axis
  // — perpendicular to the player LOS).
  const losX = ctx.player.pos.x - e.group.position.x;
  const losZ = ctx.player.pos.z - e.group.position.z;
  const losLen = Math.hypot(losX, losZ) || 1;
  const perpX = -losZ / losLen;
  const perpZ = losX / losLen;

  if (coverDist > 1.2) {
    // Move to cover at full speed.
    const dirX = toCoverX / coverDist;
    const dirZ = toCoverZ / coverDist;
    const coverSpeed = e.speed * 1.0;
    // Prompt #52 — steer around obstacles on the way to cover.
    const steered = applyPathSteer(ctx, e, dirX * coverSpeed, dirZ * coverSpeed);
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, steered.x, 8, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, steered.z, 8, dt);
    moveEnemyWithCollision(ctx, e, dt, collides);
    return;
  }

  // At cover. Manage the peek cycle: peek out for 0.6s every 2-3s.
  // The cycle uses two fields — `coverIsPeeking` (current phase) and
  // `coverNextActionAt` (when to transition). Direction alternates each
  // peek so the enemy doesn't always peek the same way.
  if (ex.coverIsPeeking === undefined) {
    ex.coverIsPeeking = false;
    ex.coverNextActionAt = now + 2000 + Math.random() * 1000; // first peek in 2-3s
    ex.coverPeekDir = Math.random() < 0.5 ? 1 : -1;
  }

  if (ex.coverIsPeeking) {
    // Currently peeking — strafe sideways out of cover by ~0.5m.
    const peekDir = ex.coverPeekDir ?? 1;
    const peekSpeed = e.speed * 0.6;
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, perpX * peekDir * peekSpeed, 8, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, perpZ * peekDir * peekSpeed, 8, dt);
    moveEnemyWithCollision(ctx, e, dt, collides);
    if (now >= (ex.coverNextActionAt ?? 0)) {
      // Peek ended — duck back. Schedule the next peek.
      ex.coverIsPeeking = false;
      ex.coverNextActionAt = now + 2000 + Math.random() * 1000; // 2-3s hold
    }
  } else {
    // Ducked back behind cover — hold position with a tiny jitter so the
    // enemy is never perfectly still.
    const jitter = Math.sin(now * 0.005 + e.gaitPhase) * 0.25;
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, perpX * jitter * e.speed * 0.2, 8, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, perpZ * jitter * e.speed * 0.2, 8, dt);
    moveEnemyWithCollision(ctx, e, dt, collides);
    if (now >= (ex.coverNextActionAt ?? 0)) {
      // Time to peek — alternate direction.
      ex.coverIsPeeking = true;
      ex.coverPeekDir = (ex.coverPeekDir === 1 ? -1 : 1);
      ex.coverNextActionAt = now + 600; // peek for 0.6s
    }
  }

  // ---- Shooting: peek snapshot vs blind fire ----
  // Task-5 — distinct shot types depending on whether the enemy is exposed
  // (peeking out of cover) or ducked back behind cover.
  //
  //   • Peek shot  — enemy is strafed out from cover, has LOS, takes a quick
  //                  snapshot. Higher accuracy (0.6x of base — exposed but
  //                  still a fast peek, not a braced shot). At most one shot
  //                  per peek window (peeks last 600ms; the 600ms lockout
  //                  below ensures a single shot per peek).
  //   • Blind fire — enemy is ducked back behind cover with no LOS. Only
  //                  fires when the player is suppressing (>0.5) OR the
  //                  enemy hasn't shot in the last 2s. Lower accuracy (0.3x).
  //
  // Both paths go through blindFireShot (the shared shoot-from-cover helper
  // that handles audio + tracer + suppression + damage). We can't reach
  // EnemySystem.enemyShoot from here (no shootFn in tickCover's signature),
  // but blindFireShot implements the same simple-armor-absorption damage
  // model used by the grenade explosion path.
  if (ex.coverIsPeeking) {
    // Peek snapshot — one shot per peek (the 600ms lockout matches the peek
    // window length, so the enemy can't fire twice in a single peek).
    if (now - e.lastShot > 600) {
      blindFireShot(ctx, e, now, 0.6);
    }
  } else {
    // Blind fire from behind cover.
    if (ex.coverNextBlindFireAt === undefined) {
      ex.coverNextBlindFireAt = now + 1000 + Math.random() * 1500;
    }
    const shouldBlindFire =
      ctx.suppression.value > 0.5 || (now - e.lastShot > 2000);
    if (shouldBlindFire && now >= ex.coverNextBlindFireAt) {
      blindFireShot(ctx, e, now, 0.3);
      ex.coverNextBlindFireAt = now + 1500 + Math.random() * 1500;
    }
  }

  // ---- Grenade throw ----
  tryThrowGrenade(ctx, e, now);
}

/**
 * Task-5 — Flee behavior. Improved from the legacy "sprint directly away"
 * pattern: the enemy now flees toward the nearest cover (not just away
 * from the player), sprints faster at very low HP (<25% → 1.4x speed),
 * and after 3s of fleeing transitions back to ATTACK (re-engage) — the
 * FSM handles the transition in EnemyFSM.tick.
 */
export function tickFlee(
  ctx: GameContext, e: Enemy, dt: number, toPlayer: THREE.Vector3, collides: (e: Enemy) => boolean,
) {
  const now = performance.now();
  const ex = ai(e);
  if (ex.fleeEnterTime === undefined) ex.fleeEnterTime = now;

  // Task-5 — Stand back up if we were crouching.
  applyCrouch(e, dt, 0);

  // Faster flee at very low HP.
  const hpPct = e.health / (e.maxHealth || 100);
  const fleeSpeed = hpPct < 0.25 ? e.speed * 1.4 : e.speed * 1.15;

  // Look for cover (cached for 1.5s — don't scan every frame while fleeing).
  let coverPos: THREE.Vector3 | null = null;
  if (!ex.fleeNextCoverCheck || now >= ex.fleeNextCoverCheck) {
    ex.fleeCoverPos = findNearestCover(ctx, e, ctx.player.pos);
    ex.fleeNextCoverCheck = now + 1500;
  }
  coverPos = ex.fleeCoverPos ?? null;

  let desiredVX: number, desiredVZ: number;
  if (coverPos) {
    // Flee toward cover.
    const toCoverX = coverPos.x - e.group.position.x;
    const toCoverZ = coverPos.z - e.group.position.z;
    const toCoverLen = Math.hypot(toCoverX, toCoverZ) || 1;
    desiredVX = (toCoverX / toCoverLen) * fleeSpeed;
    desiredVZ = (toCoverZ / toCoverLen) * fleeSpeed;
  } else {
    // No cover — flee directly away from the player.
    const fleeX = -toPlayer.x;
    const fleeZ = -toPlayer.z;
    const fleeLen = Math.hypot(fleeX, fleeZ) || 1;
    desiredVX = (fleeX / fleeLen) * fleeSpeed;
    desiredVZ = (fleeZ / fleeLen) * fleeSpeed;
  }

  // Prompt #52 — steer around obstacles while fleeing (so a fleeing enemy
  // doesn't get stuck on a collider face with the player shooting it in
  // the back — the steer detours it around the obstacle toward cover).
  // Blend the steer with the desired flee velocity (50/50) so the flee
  // direction still dominates (we don't want the enemy to circle a
  // collider forever instead of running away).
  const fleeSteer = applyPathSteer(ctx, e, desiredVX, desiredVZ);
  const blendedVX = fleeSteer.x * 0.5 + desiredVX * 0.5;
  const blendedVZ = fleeSteer.z * 0.5 + desiredVZ * 0.5;
  e.velocity.x = THREE.MathUtils.damp(e.velocity.x, blendedVX, 8, dt);
  e.velocity.z = THREE.MathUtils.damp(e.velocity.z, blendedVZ, 8, dt);
  moveEnemyWithCollision(ctx, e, dt, collides);
}

// ============================================================================
// Task-12 — MEDIC / SHIELD / SCOUT / SHOTGUNNER class behaviors.
// ============================================================================
//
// Per the task's final approach: NO new FSM states. All special behavior is
// gated on the enemy's class + current FSM state, dispatched internally
// from the existing tick functions (tickChase / tickAttackMaintainRange /
// tickCover). This keeps EnemySystem.ts's tactic dispatch untouched (it
// only knows about SUPPRESSED / FLANK / FLEE / ATTACK / chase-or-idle).
//
// The medic heal/revive scan is throttled to 2 Hz (every 500ms) per the
// spec's performance mandate. At 2 medics × 2 Hz × 30 enemies = 120 ops/sec
// — negligible. The heal channel is 2s (stationary, vulnerable). The heal
// cooldown is 8s per the spec.

/**
 * Task-12 — MEDIC heal/revive logic. Called from tickChase + tickAttackMaintainRange
 * at the top (before normal behavior). Returns true if the medic is actively
 * healing (channeling or moving to a target) — the caller should skip normal
 * chase/attack behavior. Returns false if no healing is needed (caller falls
 * through to normal behavior — the medic defends itself with a pistol via
 * the regular EnemySystem shooting path).
 *
 * Behavior:
 *   1. If currently channeling (medicChannelEnd set):
 *      - If the channel timer expired: complete the heal/revive on the target.
 *      - If the target is no longer valid (out of range, fully healed, or
 *        dead too long): cancel the channel.
 *      - Otherwise: stand still (vulnerable) + suppress shooting.
 *   2. If not channeling:
 *      - If the heal cooldown (8s) hasn't elapsed: return false (normal behavior).
 *      - Else scan for the nearest injured ally (living with HP < 50% OR
 *        recently dead within 5s) within 8m. Throttled to 2 Hz.
 *      - If no injured ally: return false (normal behavior).
 *      - If injured ally found:
 *        * Within 2m: start channeling (2s).
 *        * Else: move toward the ally.
 *
 * Revive mechanics (when the target is dead):
 *   - ally.alive = true, ally.health = 50% maxHealth, ally.deadTime = 0.
 *   - ally.fsm.reset() (back to IDLE — the FSM's DEAD state has no exits).
 *   - ally.group.rotation.x = 0, ally.group.position.y = 0 (undo killEnemy's
 *     face-plant rotation + 0.3m lift).
 *   - ctx.match.enemiesRemaining++ (killEnemy decremented it; revive restores).
 *
 * Heal mechanics (when the target is alive but low HP):
 *   - ally.health = 80% maxHealth.
 */
function tickMedicHeal(
  ctx: GameContext, e: Enemy, dt: number, now: number, collides: (e: Enemy) => boolean,
): boolean {
  const ex = ai(e);

  // ---- Already channeling ----
  if (ex.medicChannelEnd !== undefined && ex.medicChannelEnd > 0) {
    const target = ex.medicHealTarget ?? null;

    // Validate the target is still heal-worthy.
    const targetValid = (() => {
      if (!target) return false;
      // Target removed from the wave (wave transition, etc.)?
      if (!ctx.enemies.includes(target)) return false;
      // Target too far away (moved or medic got pushed)?
      const dx = target.group.position.x - e.group.position.x;
      const dz = target.group.position.z - e.group.position.z;
      if (Math.hypot(dx, dz) > 5) return false;
      // Target alive + healthy (healed by another medic)?
      if (target.alive && target.health >= target.maxHealth * 0.5) return false;
      // Target dead too long (body sunk)?
      if (!target.alive && now - target.deadTime > 5000) return false;
      return true;
    })();

    if (!targetValid) {
      // Cancel the channel — target no longer needs healing.
      ex.medicChannelEnd = undefined;
      ex.medicHealTarget = null;
      return true; // stay in heal mode this tick (don't fall through to attack)
    }

    // Channel complete?
    if (now >= ex.medicChannelEnd) {
      // Apply heal/revive.
      if (target!.alive) {
        // Heal: restore to 80% maxHealth.
        target!.health = Math.max(target!.health, target!.maxHealth * 0.8);
        ctx.addKillFeed({
          killer: "MEDIC", victim: "Healed ally", weapon: "+HP", headshot: false,
        });
      } else {
        // Revive: restore to 50% maxHealth + reset state.
        target!.alive = true;
        target!.health = target!.maxHealth * 0.5;
        target!.deadTime = 0;
        target!.state = "idle";
        target!.fsm?.reset(); // back to IDLE (DEAD state has no exits)
        // Undo killEnemy's face-plant rotation + 0.3m lift.
        target!.group.rotation.x = 0;
        target!.group.position.y = 0;
        // A3-5000 #507: emit REVIVING bark ("Hang on — I've got you!") — the
        // config exists in barks.ts but was never wired from the medic logic.
        try { emitBark(ctx, e, "REVIVING"); } catch { /* non-fatal */ }
        // Section D #1765 — medic revive never-ends wave. The prior code
        // incremented enemiesRemaining on revive (correct: the player
        // needs to kill the revived enemy again to clear the wave). BUT
        // the revived enemy was NOT marked as `wasRevived`, so killEnemy
        // couldn't distinguish a "fresh-counted" enemy from a "revived"
        // one — if the player killed the revived enemy, killEnemy
        // decremented again (which is correct, since the medic's revive
        // incremented). The bug: if the medic revived DURING the
        // wave-clear window (enemiesRemaining was 0, wave-clear branch
        // about to fire), the increment prevented the wave-clear branch
        // from firing, and the player had to kill the revived enemy to
        // re-trigger it — but if the medic revived AGAIN before the
        // player killed the revived enemy, the wave could stall.
        // Fix: mark the revived enemy with `wasRevived: true` so
        // killEnemy can detect it (the decrement still happens — the
        // flag is for diagnostics + future-proofing). We also gate the
        // increment on `!waveTransitioning` so a medic reviving during
        // the wave-clear transition window doesn't prevent the transition
        // (the revived enemy is cleaned up by the wave-clear callback
        // anyway).
        (target as unknown as { wasRevived?: boolean }).wasRevived = true;
        if (!ctx.match.waveTransitioning && ctx.match.enemiesRemaining >= 0) {
          ctx.match.enemiesRemaining++;
        }
        ctx.addKillFeed({
          killer: "MEDIC", victim: "Revived ally", weapon: "+HP", headshot: false,
        });
        ctx.pushHud({ enemiesRemaining: ctx.match.enemiesRemaining });
      }
      ex.medicLastHealAt = now;
      ex.medicChannelEnd = undefined;
      ex.medicHealTarget = null;
      return true; // medic just finished healing — skip normal behavior this tick
    }

    // Still channeling — stand still + suppress shooting (the medic is
    // stationary + vulnerable per the spec). Setting e.lastShot = now
    // prevents the regular EnemySystem shooting path from firing.
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, 0, 10, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, 0, 10, dt);
    moveEnemyWithCollision(ctx, e, dt, collides);
    e.lastShot = now; // suppress the regular shooting path
    return true;
  }

  // ---- Not channeling — check heal cooldown ----
  const healCooldownMs = 8000;
  if (ex.medicLastHealAt !== undefined && now - ex.medicLastHealAt < healCooldownMs) {
    return false; // on cooldown — fall through to normal behavior
  }

  // ---- Throttled scan for the nearest injured ally (2 Hz) ----
  ex.medicLastScanAt = ex.medicLastScanAt ?? 0;
  const scanIntervalMs = 500;
  if (now - ex.medicLastScanAt < scanIntervalMs) {
    // Re-use the previous scan's target if still valid + still needs healing.
    const prev = ex.medicHealTarget ?? null;
    if (prev && ctx.enemies.includes(prev)) {
      const dx = prev.group.position.x - e.group.position.x;
      const dz = prev.group.position.z - e.group.position.z;
      const d = Math.hypot(dx, dz);
      const needsHeal = prev.alive
        ? prev.health < prev.maxHealth * 0.5
        : now - prev.deadTime < 5000;
      if (needsHeal && d <= 8) {
        // Move toward the target (or start channeling if within 2m).
        if (d <= 2) {
          ex.medicChannelEnd = now + 2000;
          // medicHealTarget already set
        } else {
          const len = d || 1;
          const vx = (dx / len) * e.speed;
          const vz = (dz / len) * e.speed;
          e.velocity.x = THREE.MathUtils.damp(e.velocity.x, vx, 6, dt);
          e.velocity.z = THREE.MathUtils.damp(e.velocity.z, vz, 6, dt);
          moveEnemyWithCollision(ctx, e, dt, collides);
        }
        return true;
      }
    }
    ex.medicHealTarget = null;
    return false; // no valid target from the previous scan
  }
  ex.medicLastScanAt = now;

  // ---- Fresh scan: find the nearest injured ally within 8m ----
  const scanRadius = 8;
  let best: Enemy | null = null;
  let bestDist = scanRadius;
  for (const ally of ctx.enemies) {
    if (ally === e) continue; // don't heal self
    // Skip bosses (medics shouldn't heal Juggernauts — too OP) + zombies.
    if ((ally as unknown as { isBoss?: boolean }).isBoss === true) continue;
    if (enemyClass(ally) === "ZOMBIE") continue;
    // Skip allies whose body has already sunk (dead too long).
    if (!ally.alive && now - ally.deadTime > 5000) continue;
    // Skip allies that are alive + healthy.
    if (ally.alive && ally.health >= ally.maxHealth * 0.5) continue;
    const dx = ally.group.position.x - e.group.position.x;
    const dz = ally.group.position.z - e.group.position.z;
    const d = Math.hypot(dx, dz);
    if (d < bestDist) {
      bestDist = d;
      best = ally;
    }
  }

  if (!best) {
    ex.medicHealTarget = null;
    return false; // no injured ally — fall through to normal behavior
  }

  ex.medicHealTarget = best;

  // Move toward the target (or start channeling if within 2m).
  const dx = best.group.position.x - e.group.position.x;
  const dz = best.group.position.z - e.group.position.z;
  const d = Math.hypot(dx, dz) || 1;
  if (d <= 2) {
    ex.medicChannelEnd = now + 2000;
    // Stand still this tick — channeling starts next tick (or now, doesn't
    // matter — the channel logic above handles it).
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, 0, 10, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, 0, 10, dt);
    moveEnemyWithCollision(ctx, e, dt, collides);
  } else {
    const vx = (dx / d) * e.speed;
    const vz = (dz / d) * e.speed;
    e.velocity.x = THREE.MathUtils.damp(e.velocity.x, vx, 6, dt);
    e.velocity.z = THREE.MathUtils.damp(e.velocity.z, vz, 6, dt);
    moveEnemyWithCollision(ctx, e, dt, collides);
  }
  return true;
}

/**
 * Task-12 — SCOUT recon patrol. Used while the scout is in IDLE/PATROL
 * (hasn't spotted the player). The scout sprints to random patrol points
 * around its spawn position, covering ground to find the player. Picks a
 * new patrol point every 3-5s or on arrival. The scout's high speed (4.5
 * m/s) means it covers ground fast — once it gains LOS, the FSM's IDLE→CHASE
 * transition fires + the scout's 30m wide callout alerts the squad.
 */
function tickScoutRecon(
  ctx: GameContext, e: Enemy, dt: number, now: number, collides: (e: Enemy) => boolean,
) {
  const ex = ai(e);
  applyCrouch(e, dt, 0); // stand tall — scouts don't crouch

  // Pick a new patrol point every 3-5s, or on arrival, or on first call.
  const arrivalDist = 1.5;
  const needNewTarget = !ex.scoutPatrolTarget ||
    (ex.scoutNextPatrolAt !== undefined && now >= ex.scoutNextPatrolAt);
  let target = ex.scoutPatrolTarget ?? null;
  if (target) {
    const dx = target.x - e.group.position.x;
    const dz = target.z - e.group.position.z;
    if (Math.hypot(dx, dz) < arrivalDist) {
      // Arrived — pick a new target after a brief pause.
      target = null;
    }
  }
  if (!target || needNewTarget) {
    // Random patrol point within 15m of the scout's spawn position.
    // (Use spawn position so the scout stays in its assigned area rather
    // than wandering across the whole map.)
    const angle = Math.random() * Math.PI * 2;
    const radius = 5 + Math.random() * 10; // 5-15m from spawn
    target = new THREE.Vector3(
      e.spawnPos.x + Math.cos(angle) * radius,
      0,
      e.spawnPos.z + Math.sin(angle) * radius,
    );
    // Clamp inside the map bounds (matches enemy-tactics b = 43).
    target.x = Math.max(-43, Math.min(43, target.x));
    target.z = Math.max(-43, Math.min(43, target.z));
    ex.scoutPatrolTarget = target;
    ex.scoutNextPatrolAt = now + 3000 + Math.random() * 2000; // 3-5s
  }

  // Sprint toward the patrol point.
  const dx = target.x - e.group.position.x;
  const dz = target.z - e.group.position.z;
  const d = Math.hypot(dx, dz) || 1;
  const vx = (dx / d) * e.speed;
  const vz = (dz / d) * e.speed;
  e.velocity.x = THREE.MathUtils.damp(e.velocity.x, vx, 6, dt);
  e.velocity.z = THREE.MathUtils.damp(e.velocity.z, vz, 6, dt);
  moveEnemyWithCollision(ctx, e, dt, collides);
}

/**
 * Task-12 — SCOUT wide callout. On the scout's first IDLE→CHASE transition
 * (detected by firstSeenAt being set), alert ALL enemies within 30m (vs the
 * normal 20m callout radius in EnemySystem.alertNearbyEnemies). This is the
 * scout's signature squad-alert mechanic — a single scout spotting the
 * player wakes up the whole nearby squad.
 *
 * Idempotent: sending "spotPlayer" to an enemy already in CHASE is a no-op
 * (the FSM has no spotPlayer transition from CHASE). So overlapping callouts
 * from the regular alertNearbyEnemies + this wide callout are safe.
 */
function scoutWideCallout(ctx: GameContext, scout: Enemy, now: number) {
  const calloutRadius = 30;
  let alerted = 0;
  for (const other of ctx.enemies) {
    if (other === scout || !other.alive) continue;
    // Only alert IDLE/PATROL allies (those that haven't spotted the player
    // yet — matches the regular alertNearbyEnemies gate).
    const st = other.fsm?.state ?? "IDLE";
    if (st !== "IDLE" && st !== "PATROL") continue;
    const dx = other.group.position.x - scout.group.position.x;
    const dz = other.group.position.z - scout.group.position.z;
    if (Math.hypot(dx, dz) > calloutRadius) continue;
    // Higher alert chance than the regular 40% — the scout's callout is
    // distinctive (radioed, not shouted). 70% per ally.
    if (Math.random() < 0.7) {
      other.fsm?.send("spotPlayer");
      (other as unknown as { firstSeenAt?: number }).firstSeenAt = now;
      alerted++;
    }
  }
  if (alerted > 0) {
    ctx.addKillFeed({
      killer: "SCOUT", victim: `Squad alert — ${alerted} hostile(s) inbound`,
      weapon: "", headshot: false,
    });
  }
}

/**
 * Task-12 — SHIELD trooper advance. The shield enemy walks slowly toward
 * the player (the shield is its cover — it never seeks traditional cover).
 * Fires its pistol via the regular EnemySystem shooting path (no special
 * shoot logic needed — the SHIELD class's damageRange + caliber handle it).
 *
 * Drop-shield logic: when the trooper's HP drops below 30%, it drops the
 * shield (hasShield = false, remove the shield mesh) and sends moraleBreak
 * to transition to FLEE. The shield is gone for the rest of the trooper's
 * life — even if it rallies out of FLEE, it fights shieldless.
 */
function tickShieldAdvance(
  ctx: GameContext, e: Enemy, dt: number, toPlayer: THREE.Vector3,
  collides: (e: Enemy) => boolean, now: number,
) {
  const ex = ai(e);
  applyCrouch(e, dt, 0); // stand tall behind the shield

  // ---- Drop shield at <30% HP ----
  const hpPct = e.health / (e.maxHealth || 1);
  if (hpPct < 0.3 && !ex.shieldDropped) {
    ex.shieldDropped = true;
    (e as unknown as { hasShield?: boolean }).hasShield = false;
    // Remove the shield mesh (named "normalShield" + "normalShieldSlit").
    const toRemove: THREE.Object3D[] = [];
    for (const child of e.group.children) {
      if (child.name === "normalShield" || child.name === "normalShieldSlit") {
        toRemove.push(child);
      }
    }
    for (const child of toRemove) e.group.remove(child);
    // Flee — the FSM transitions COVER → FLEE via moraleBreak.
    e.fsm?.send("moraleBreak");
    ctx.addKillFeed({
      killer: "SHIELD", victim: "Shield dropped — retreating",
      weapon: "", headshot: false,
    });
    return;
  }

  // ---- Advance toward the player ----
  // Slow walk (the trooper is encumbered by the shield). 0.8x speed.
  const advanceSpeed = e.speed * 0.8;
  const desiredVX = toPlayer.x * advanceSpeed;
  const desiredVZ = toPlayer.z * advanceSpeed;
  // Prompt #52 — steer around obstacles so the shield trooper doesn't
  // get stuck on corners (its slow speed makes it especially vulnerable
  // to the axis-revert stall in moveEnemyWithCollision).
  const steered = applyPathSteer(ctx, e, desiredVX, desiredVZ);
  e.velocity.x = THREE.MathUtils.damp(e.velocity.x, steered.x, 4, dt);
  e.velocity.z = THREE.MathUtils.damp(e.velocity.z, steered.z, 4, dt);
  moveEnemyWithCollision(ctx, e, dt, collides);
}

/**
 * Task-12 — SHOTGUNNER rush. Closes distance to the player fast (no
 * cover-to-cover, no strafe — just beelines). Used in CHASE. The 6-pellet
 * blast fires from tickAttackMaintainRange once within 6m.
 */
function tickShotgunnerRush(
  ctx: GameContext, e: Enemy, dt: number, toPlayer: THREE.Vector3,
  collides: (e: Enemy) => boolean,
) {
  applyCrouch(e, dt, 0); // stand tall — shotgunners don't crouch

  // Sprint toward the player at 1.1x speed (slight rush boost).
  const rushSpeed = e.speed * 1.1;
  const desiredVX = toPlayer.x * rushSpeed;
  const desiredVZ = toPlayer.z * rushSpeed;
  // Prompt #52 — steer around obstacles so the shotgunner doesn't stall
  // on a collider face just short of its 6m blast range.
  const steered = applyPathSteer(ctx, e, desiredVX, desiredVZ);
  e.velocity.x = THREE.MathUtils.damp(e.velocity.x, steered.x, 6, dt);
  e.velocity.z = THREE.MathUtils.damp(e.velocity.z, steered.z, 6, dt);
  moveEnemyWithCollision(ctx, e, dt, collides);
}

/**
 * Task-12 — SHOTGUNNER 6-pellet blast. Fires 6 pellets in a tight spread
 * (±0.05 rad angular offset per the spec) at the player. Each pellet has
 * an independent hit chance (e.accuracy * distance falloff) + damage roll
 * (18-35 dmg per pellet from the SHOTGUNNER class config). At point-blank
 * (6m, the shotgunner's attackRange), a full blast is devastating — 6
 * pellets × ~0.66 hit chance × ~26.5 avg dmg = ~105 damage if all pellets
 * connect. Armored players absorb ~40% of that.
 *
 * Implementation note: the spec says "call enemyShoot 6 times with spread
 * offsets", but enemyShoot is in EnemySystem.ts (read-only). This local
 * helper replicates enemyShoot's per-shot logic (audio + tracer +
 * suppression + damage with armor absorption) for each pellet. The tracers
 * get a small visual spread (±0.3m at the target) so the player sees the
 * pellet cone. The damage rolls are independent per pellet (the spec's
 * "spread" is implicit in the per-pellet hit/miss + damage variation).
 *
 * Audio is played once (not 6×) to avoid audio spam — a single shotgun
 * blast sound per blast. Suppression is applied once (the spec doesn't call
 * for 6× suppression per blast).
 */
function shotgunPelletBlast(ctx: GameContext, e: Enemy, now: number, dist: number) {
  const origin = ctx.scratch.rayOrigin.copy(e.group.position);
  origin.y = 1.2;
  const target = ctx.scratch.rayDir.copy(ctx.player.pos);

  // One audio call for the whole blast (pistol SFX — the spec reuses pistol
  // audio for the shotgunner). Occluded = false (the shotgunner is in
  // ATTACK state with LOS — the FSM only transitions to ATTACK when the
  // enemy has LOS).
  ctx.audio.distantGunshot(origin.x, origin.y, origin.z, false, "pistol");

  // Per-pellet hit chance + damage. The shotgunner's accuracy (0.75) is
  // high — at 6m the hit chance per pellet is ~0.66. Damage rolls 18-35.
  const hitChanceBase = e.accuracy * Math.max(0.15, 1 - dist / 50);
  const dmgMin = 18, dmgMax = 35;

  let totalDamageApplied = 0;
  for (let i = 0; i < 6; i++) {
    // Tracer with a small visual spread (±0.3m perpendicular offset at
    // the target). The spread is purely visual — the damage roll is
    // independent per pellet (the spec's "spread" is the per-pellet
    // hit/miss variation, not a geometric cone).
    const spreadX = (Math.random() - 0.5) * 0.6;
    const spreadY = (Math.random() - 0.5) * 0.6;
    const spreadZ = (Math.random() - 0.5) * 0.6;
    const pelletTarget = ctx.scratch.v2.set(
      target.x + spreadX, target.y + spreadY, target.z + spreadZ,
    );
    const line = ctx.particlePool.acquireTracer(origin, pelletTarget);
    if (line) {
      ctx.particlePool.activeTracers.push({
        line, life: 0.08, maxLife: 0.08, active: true,
      });
    }

    // Per-pellet hit roll + damage.
    if (Math.random() < hitChanceBase) {
      let dmg = dmgMin + Math.random() * (dmgMax - dmgMin);
      // Armor absorption (same model as blindFireShot + grenade explode).
      if (ctx.player.armor > 0) {
        const absorbed = Math.min(ctx.player.armor, dmg * 0.6);
        ctx.player.armor -= absorbed;
        dmg -= absorbed;
      }
      ctx.player.health -= dmg;
      totalDamageApplied += dmg;
    }
  }

  // Apply the post-blast feedback once (not per pellet — avoids 6× HUD
  // flashes + 6× shakes for a single blast).
  if (totalDamageApplied > 0) {
    ctx.audio.damage();
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const wYaw = Math.atan2(dx, dz);
    ctx.player.lastDamageDir = wYaw - ctx.player.yaw;
    ctx.player.lastDamageTime = now;
    ctx.pushHud({
      health: Math.max(0, Math.round(ctx.player.health)),
      armor: Math.max(0, Math.round(ctx.player.armor)),
      damageFlash: now,
    });
    const shake = Math.min(0.5, totalDamageApplied * 0.015);
    ctx.triggerShake(shake);
    if (ctx.player.health <= 0) ctx.onGameOver();
  }

  // Suppression — one application per blast (close-range shotgun blast is
  // highly suppressive). Slightly higher than a single pistol shot.
  const supp = dist < 5 ? 0.2 : dist < 15 ? 0.1 : 0.04;
  ctx.suppression.value = Math.min(1, ctx.suppression.value + supp);

  e.lastShot = now; // suppress the regular EnemySystem shooting path
}

// ============================================================================
// Task-15 — ZOMBIE behavior (ZOMBIES game mode).
// ============================================================================

/**
 * Task-15 — Zombie melee rusher. Replaces the entire FSM-driven tactic
 * dispatch for the ZOMBIE class (EnemySystem.update calls this directly
 * instead of tickSuppressed / tickFlank / tickChase / tickAttackMaintainRange
 * / tickFlee — see the `isZombie` branch in EnemySystem.update).
 *
 * Behavior:
 *   - Always sprint toward the player. No cover, no peek, no suppression,
 *     no flee — zombies are fearless and relentless (COD Zombies style).
 *   - The zombie naturally flanks by spawning from all sides and beelining
 *     to the player — no explicit flank logic needed.
 *   - When within 2m (attackRange) and the melee cooldown is ready, the
 *     zombie lunges (brief 1.6x speed boost for 200ms) and claws the
 *     player for 15-25 damage via `meleeFn` (which routes through
 *     EnemySystem.onApplyDamageToPlayer — same path as enemyShoot, so the
 *     armor absorption + HUD damage flash + directional indicator all
 *     fire correctly).
 *   - 1s melee cooldown — a single zombie can't stunlock the player, but a
 *     swarm of 8+ zombies landing simultaneous hits is deadly.
 *
 * Note: the zombie NEVER shoots (ZOMBIE class has shotCooldown [99999, 99999]
 * and EnemySystem.update skips the shooting branch entirely for zombies).
 */
export function tickZombieMelee(
  ctx: GameContext,
  e: Enemy,
  dt: number,
  dist: number,
  toPlayer: THREE.Vector3,
  collidesFn: (e: Enemy) => boolean,
  meleeFn: (dmg: number, hitLoc?: "torso" | "limb" | "head") => void,
) {
  const now = performance.now();
  const ex = ai(e);

  // Stand upright — never crouch (no SUPPRESSED/COVER state for zombies).
  applyCrouch(e, dt, 0);

  // Melee timing constants.
  const MELEE_RANGE = 2.0;             // matches ZOMBIE.attackRange
  const MELEE_COOLDOWN_MS = 1000;      // 1s between claw swipes per zombie
  const LUNGE_BOOST = 1.6;             // 60% speed boost during lunge
  const LUNGE_DURATION_MS = 200;       // brief — the lunge is a quick leap

  const inMeleeRange = dist <= MELEE_RANGE;
  const cooldownReady = now - (ex.zombieLastMeleeAt ?? 0) >= MELEE_COOLDOWN_MS;
  const lungeActive = now - (ex.zombieLungeAt ?? 0) < LUNGE_DURATION_MS;
  const lungeBoost = lungeActive ? LUNGE_BOOST : 1.0;

  // Always sprint toward the player — no cover, no strafe, no retreat.
  // The lunge boosts the sprint briefly when the zombie is about to swing.
  const desiredVel = ctx.scratch.v2.copy(toPlayer).multiplyScalar(e.speed * lungeBoost);
  // Prompt #52 — steer around obstacles so a zombie swarm doesn't pile up
  // against a single wall between them and the player.
  const zSteer = applyPathSteer(ctx, e, desiredVel.x, desiredVel.z);
  e.velocity.x = THREE.MathUtils.damp(e.velocity.x, zSteer.x, 8, dt);
  e.velocity.z = THREE.MathUtils.damp(e.velocity.z, zSteer.z, 8, dt);
  moveEnemyWithCollision(ctx, e, dt, collidesFn);

  // Claw swipe: in range + cooldown ready → lunge + strike.
  if (inMeleeRange && cooldownReady) {
    ex.zombieLastMeleeAt = now;
    ex.zombieLungeAt = now;
    // 15-25 damage per swipe (matches ZOMBIE.damageRange). The meleeFn
    // routes through onApplyDamageToPlayer, which handles armor absorption,
    // HUD damage flash, directional indicator, and the player damage audio.
    const dmg = 15 + Math.random() * 10;
    meleeFn(dmg, "torso");
    // Small shake so the melee hit reads as impactful (less than a gunshot
    // hit — a claw swipe shouldn't kick the camera as hard as a bullet).
    ctx.triggerShake(0.1);
  }
}
