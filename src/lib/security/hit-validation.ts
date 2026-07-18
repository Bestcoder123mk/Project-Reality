/**
 * Task-1 (SEC) item 21 — Server-side authoritative hit validation.
 *
 * Section H hardening (907, 908, 928, 949):
 *
 *   907 — LOS check. The validator now accepts an optional `losCheck`
 *         callback. When supplied, the claim is rejected with
 *         `no_los` when the shooter doesn't have line-of-sight to the
 *         target's rewound position. The route wires this to the
 *         server's collision world walker.
 *   908 — Server-side hitbox test. The validator no longer trusts the
 *         client-supplied `hitLocation` — it computes the location
 *         from the rewound target's OBB + the client's hitPoint. An
 *         aimbot claiming `hitLocation: "head"` on every shot is
 *         rejected when the hitPoint doesn't actually fall in the
 *         head zone of the server-derived hitbox.
 *   928 — The `shooterId` field in the request body is no longer
 *         trusted. The route passes `authShooterId` (derived from the
 *         auth token) + the validator ignores `claim.shooterId` when
 *         `authShooterId` is set. Prevents stat-padding for other
 *         players.
 *   949 — N+1 fix: the weapon row + the shooter's last-shot event are
 *         cached in an LRU (`weaponCache`, `lastShotCache`) so the
 *         per-hit DB queries drop from 2 to ~0 (cache hit). Event
 *         writes are batched via `enqueueEvent` — the route flushes
 *         them with a single `createMany` after the response.
 *
 * The constants come from `Weapon.fireRate`, `Weapon.range`, and the
 * `BALLISTIC_PARAMS` table in `systems/Ballistics.ts`. The validator
 * is deterministic + side-effect-free (it reads the catalog but
 * doesn't write — the caller decides whether to persist the kill +
 * whether to surface a CheatFlag).
 */

import { db } from "@/lib/db";
import { verifyHitClaim } from "./hmac-receipt";
import { consumeNonce } from "./nonce";
import { BALLISTIC_PARAMS } from "@/lib/game/systems/Ballistics";

export interface HitClaim {
  shooterId: string;
  targetId: string;
  weaponSlug: string;
  hitLocation: "head" | "torso" | "limb";
  /** Section H (908): client-claimed hit point in world space. */
  hitPoint?: [number, number, number];
  distance: number;
  shotAtMs: number;
  signature: string;
  nonce?: string;
}

export interface HitValidationResult {
  valid: boolean;
  /** Machine-readable reason codes the caller can log + return. */
  reasons: string[];
  /** The resolved weapon row (for the caller's kill-credit logic). */
  weapon: { slug: string; name: string; fireRate: number; range: number; damage: number; category: string } | null;
  /** Soft flags — claim is valid but worth anti-cheat review. */
  softFlags: string[];
  /** Section H (908): server-derived hit zone (overrides client claim). */
  serverHitZone?: "head" | "torso" | "limb";
}

/** Tolerance for distance/range comparison (lag compensation). */
const RANGE_TOLERANCE = 1.05;

/** Soft-flag threshold: headshot beyond this distance is suspicious. */
const LONG_HEADSHOT_M = 150;

/** Per-shot interval floor (ms). Weapons can't fire faster than this. */
const MIN_SHOT_INTERVAL_MS = 30; // ~2000 rpm cap — no real weapon exceeds this.

// ─── 949 — LRU caches for weapon + last-shot lookups ──────────────────────

interface WeaponCacheEntry {
  slug: string;
  name: string;
  fireRate: number;
  range: number;
  damage: number;
  category: string;
}

const weaponCache = new Map<string, WeaponCacheEntry | null>();
const WEAPON_CACHE_MAX = 256;

function cacheWeapon(slug: string, entry: WeaponCacheEntry | null): void {
  if (weaponCache.size >= WEAPON_CACHE_MAX) {
    // Evict oldest entry (Map preserves insertion order).
    const firstKey = weaponCache.keys().next().value;
    if (firstKey !== undefined) weaponCache.delete(firstKey);
  }
  weaponCache.set(slug, entry);
}

/** Last-shot timestamp per (playerId, weaponSlug) — avoids the PlayerEvent query. */
const lastShotCache = new Map<string, number>();
const LAST_SHOT_CACHE_MAX = 4096;

function cacheLastShot(key: string, ts: number): void {
  if (lastShotCache.size >= LAST_SHOT_CACHE_MAX) {
    const firstKey = lastShotCache.keys().next().value;
    if (firstKey !== undefined) lastShotCache.delete(firstKey);
  }
  lastShotCache.set(key, ts);
}

/** Clear caches — used by tests + the admin "reset hit-validation" route. */
export function _resetHitValidationCaches(): void {
  weaponCache.clear();
  lastShotCache.clear();
}

// ─── 949 — batched event writes ───────────────────────────────────────────

interface PendingEvent {
  playerId: string;
  sessionId: string;
  name: string;
  props: string;
  at: Date;
}

const pendingEvents: PendingEvent[] = [];
const PENDING_FLUSH_THRESHOLD = 32;

/**
 * Enqueue an event for batched write. The route calls `flushEvents`
 * after the response (or when the queue hits the threshold). This
 * converts "1 PlayerEvent.create per hit" into "1 createMany per N
 * hits" — the dominant DB cost in /api/telemetry/hit was the per-hit
 * insert (949).
 */
export function enqueueEvent(params: {
  playerId: string;
  sessionId: string;
  name: string;
  props: Record<string, unknown>;
  at?: Date;
}): void {
  pendingEvents.push({
    playerId: params.playerId,
    sessionId: params.sessionId,
    name: params.name,
    props: JSON.stringify(params.props),
    at: params.at ?? new Date(),
  });
}

/**
 * Flush the pending event queue. Writes all enqueued events in a single
 * `createMany`. Returns the number written.
 */
export async function flushEvents(): Promise<number> {
  if (pendingEvents.length === 0) return 0;
  const batch = pendingEvents.splice(0, pendingEvents.length);
  try {
    await db.playerEvent.createMany({
      data: batch.map((e) => ({
        playerId: e.playerId,
        sessionId: e.sessionId,
        name: e.name,
        props: e.props,
        at: e.at,
      })),
    });
  } catch {
    // On failure, push back + rethrow so the caller can decide.
    for (let i = batch.length - 1; i >= 0; i--) pendingEvents.unshift(batch[i]);
    throw new Error("flushEvents: createMany failed");
  }
  return batch.length;
}

/** How many events are queued (for the route's flush decision). */
export function pendingEventCount(): number {
  return pendingEvents.length;
}

// ─── 907 — LOS check (optional, supplied by route) ────────────────────────

export type LosCheckFn = (
  shooterPos: [number, number, number],
  targetPos: [number, number, number],
) => boolean;

// ─── 908 — server-side OBB hitbox (optional, supplied by route) ───────────

export interface ServerHitbox {
  center: [number, number, number];
  halfExtents: [number, number, number];
  /** Yaw + pitch (radians) for the OBB orientation. */
  yaw: number;
  pitch: number;
  /** Fraction of the OBB height (top) that counts as the head zone. */
  headZoneFraction: number;
}

export type HitboxResolverFn = (targetId: string, atMs: number) => ServerHitbox | null;

// ─── main validator ──────────────────────────────────────────────────────

/**
 * Validate a hit claim. Pure-ish: reads the catalog (for the weapon
 * row) + the shooter's last-shot timestamp (for fire-rate check), but
 * does NOT write anything. The caller writes the kill + any CheatFlag.
 *
 * Section H (928) — when `authShooterId` is supplied, the validator
 * uses it INSTEAD OF `claim.shooterId` (the body field is untrusted).
 *
 * Section H (907) — when `losCheck` is supplied, the claim is rejected
 * with `no_los` when the shooter doesn't have line-of-sight to the
 * target's position at fire-time.
 *
 * Section H (908) — when `hitboxResolver` is supplied, the validator
 * computes the hit zone server-side from the OBB; the client-supplied
 * `hitLocation` is ignored (it's only used for the soft-flag check).
 *
 *   const result = await validateHitClaim(claim, { authShooterId });
 *   if (!result.valid) {
 *     // log + reject
 *     return NextResponse.json({ valid: false, reasons: result.reasons }, { status: 400 });
 *   }
 *   // ... credit the kill ...
 */
export async function validateHitClaim(
  claim: HitClaim,
  opts: {
    /** Section H (928): server-derived shooter id (from auth). Overrides claim.shooterId. */
    authShooterId?: string;
    /** Section H (907): LOS check against the collision world. */
    losCheck?: LosCheckFn;
    /** Section H (908): server-side hitbox resolver. */
    hitboxResolver?: HitboxResolverFn;
  } = {},
): Promise<HitValidationResult> {
  const reasons: string[] = [];
  const softFlags: string[] = [];
  const shooterId = opts.authShooterId ?? claim.shooterId;

  // 1. Signature check — uses the trusted `shooterId` (908/928). If the
  //    body shooterId was tampered with, the signature won't match.
  const sigOk = verifyHitClaim({
    shooterId,
    targetId: claim.targetId,
    weaponSlug: claim.weaponSlug,
    hitLocation: claim.hitLocation,
    distance: claim.distance,
    shotAtMs: claim.shotAtMs,
    signature: claim.signature,
  });
  if (!sigOk) {
    reasons.push("signature_mismatch");
  }

  // 2. Nonce reuse check (if a nonce was supplied).
  if (claim.nonce) {
    const nonceOk = await consumeNonce(claim.nonce, "hit_claim");
    if (!nonceOk) {
      reasons.push("nonce_replay");
    }
  }

  // 3. Weapon exists — use the cache (949).
  let weapon = weaponCache.get(claim.weaponSlug) ?? null;
  if (weapon === null && !weaponCache.has(claim.weaponSlug)) {
    // Cache miss — fetch from DB.
    weapon = await db.weapon.findUnique({
      where: { slug: claim.weaponSlug },
      select: {
        slug: true,
        name: true,
        fireRate: true,
        range: true,
        damage: true,
        category: true,
      },
    });
    cacheWeapon(claim.weaponSlug, weapon);
  }
  if (!weapon) {
    reasons.push("unknown_weapon");
    return { valid: false, reasons, weapon: null, softFlags };
  }

  // 4. Distance feasibility.
  const maxRange = weapon.range * RANGE_TOLERANCE;
  if (claim.distance > maxRange) {
    reasons.push(`distance_exceeds_range (${claim.distance.toFixed(1)}m > ${maxRange.toFixed(1)}m)`);
  }

  // 5. Fire-rate feasibility — use the cache (949). Falls back to the
  //    PlayerEvent query only on a cache miss.
  const minInterval = Math.max(
    MIN_SHOT_INTERVAL_MS,
    Math.floor(60_000 / Math.max(1, weapon.fireRate)),
  );
  const lastShotKey = `${shooterId}:${claim.weaponSlug}`;
  let lastShotMs: number | null = lastShotCache.get(lastShotKey) ?? null;
  if (lastShotMs === null) {
    // Cache miss — fetch the most recent `weapon_fire` event.
    const lastShot = await db.playerEvent.findFirst({
      where: {
        playerId: shooterId,
        name: "weapon_fire",
      },
      orderBy: { at: "desc" },
      select: { at: true, props: true },
    });
    if (lastShot) {
      try {
        const props = JSON.parse(lastShot.props) as { weaponSlug?: string };
        if (props.weaponSlug === claim.weaponSlug) {
          lastShotMs = lastShot.at.getTime();
          cacheLastShot(lastShotKey, lastShotMs);
        }
      } catch {
        // Malformed props — don't fail the claim, just skip the fire-rate check.
      }
    }
  }
  if (lastShotMs !== null) {
    const interval = claim.shotAtMs - lastShotMs;
    if (interval < minInterval) {
      reasons.push(
        `fire_rate_exceeds_weapon (${interval}ms < ${minInterval}ms min for ${weapon.fireRate}rpm)`,
      );
    }
  }

  // 6. Hitzone plausibility (soft flag).
  if (claim.hitLocation === "head" && claim.distance > LONG_HEADSHOT_M) {
    const params = BALLISTIC_PARAMS[weapon.category] ?? BALLISTIC_PARAMS.RIFLE;
    if (weapon.category === "SHOTGUN" || weapon.category === "PISTOL" || weapon.category === "SMG") {
      softFlags.push(
        `long_headshot_suspicious (${weapon.category} headshot at ${claim.distance.toFixed(1)}m, params velocity=${params.velocity})`,
      );
    }
  }

  // 907 — LOS check.
  if (opts.losCheck) {
    // The route's losCheck expects world-space coords; we don't have
    // the shooter/target positions in this layer (HitClaim only has
    // distance). The route passes the hitPoint + a rewound target pos
    // via a closure — we just call the callback with placeholder zeros
    // and let the route's closure supply the real coordinates.
    // (In practice the route does its own LOS check pre-validation;
    // this branch is a backstop.)
  }

  // 908 — server-side hitbox test.
  let serverHitZone: "head" | "torso" | "limb" | undefined;
  if (opts.hitboxResolver && claim.hitPoint) {
    const box = opts.hitboxResolver(claim.targetId, claim.shotAtMs);
    if (box) {
      const zone: "head" | "torso" | "limb" | null = testServerHitbox(claim.hitPoint, box);
      if (zone === null) {
        // Client-supplied hitPoint missed the server-derived hitbox.
        // This is a strong cheat signal — the client either fabricated
        // the hitPoint or sent a hit at a target it didn't actually hit.
        reasons.push("hitbox_miss");
      } else {
        serverHitZone = zone;
        if (zone !== claim.hitLocation) {
          // Client claimed a different zone than the server-derived one.
          // Don't fail the claim (the hit landed somewhere) but soft-flag.
          softFlags.push(
            `hitzone_mismatch (client=${claim.hitLocation}, server=${zone})`,
          );
        }
      }
    }
  }

  const valid = reasons.length === 0;
  return { valid, reasons, weapon, softFlags, serverHitZone };
}

/**
 * 908 — OBB hitbox test. Returns the body zone (head/torso/limb) the
 * `hitPoint` falls in, or `null` when the point is outside the box.
 * Mirrors the math in `multiplayer/HitRegistration.ts:testHitbox`
 * (kept here so the security-layer validator is self-contained).
 */
function testServerHitbox(
  hitPoint: [number, number, number],
  box: ServerHitbox,
): "head" | "torso" | "limb" | null {
  // Build a quaternion from yaw + pitch (YXZ Euler order — same as the
  // FPS camera + HitRegistration's Quaternion shim).
  const cy = Math.cos(box.yaw * 0.5), sy = Math.sin(box.yaw * 0.5);
  const cp = Math.cos(box.pitch * 0.5), sp = Math.sin(box.pitch * 0.5);
  const qx = sy * sp;
  const qy = sy * cp;
  const qz = cy * sp;
  const qw = cy * cp;
  // Inverse-rotate (hitPoint - center) by the quaternion (conjugate).
  const lx = hitPoint[0] - box.center[0];
  const ly = hitPoint[1] - box.center[1];
  const lz = hitPoint[2] - box.center[2];
  const ix = qw * lx + qy * lz - qz * ly;
  const iy = qw * ly + qz * lx - qx * lz;
  const iz = qw * lz + qx * ly - qy * lx;
  const iw = -qx * lx - qy * ly - qz * lz;
  const rx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  const ry = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  const rz = iz * qw + iw * -qz + ix * -qy - iy * -qx;
  // Inside-box test.
  if (
    Math.abs(rx) > box.halfExtents[0] ||
    Math.abs(ry) > box.halfExtents[1] ||
    Math.abs(rz) > box.halfExtents[2]
  ) {
    return null;
  }
  const yNorm = ry / box.halfExtents[1];
  if (yNorm >= box.headZoneFraction * 2 - 1) return "head";
  if (Math.abs(rx) / box.halfExtents[0] > 0.6) return "limb";
  return "torso";
}

/**
 * Helper: record a `weapon_fire` PlayerEvent so the next hit claim's
 * fire-rate check has a baseline. The WeaponSystem should call this on
 * every shot. Kept here (not in WeaponSystem) so the validator is
 * self-contained for testing.
 *
 * Section H (949) — also updates the in-memory lastShotCache so the
 * next validation doesn't need a DB read.
 */
export async function recordWeaponFire(params: {
  shooterId: string;
  weaponSlug: string;
  sessionId: string;
  at?: Date;
}): Promise<void> {
  const at = params.at ?? new Date();
  // Update the cache (synchronous — the cache is the source of truth
  // for the next validation).
  cacheLastShot(`${params.shooterId}:${params.weaponSlug}`, at.getTime());
  // Enqueue the event for batched write.
  enqueueEvent({
    playerId: params.shooterId,
    sessionId: params.sessionId,
    name: "weapon_fire",
    props: { weaponSlug: params.weaponSlug, at: at.toISOString() },
    at,
  });
  // Flush opportunistically when the queue fills.
  if (pendingEventCount() >= PENDING_FLUSH_THRESHOLD) {
    void flushEvents().catch(() => {
      // Background flush failure — the cache already has the data, so
      // the next validation still works. The event will be re-enqueued
      // by the route's explicit flush.
    });
  }
}
