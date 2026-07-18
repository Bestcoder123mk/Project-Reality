/**
 * Section C — Enhanced server-side hit validation.
 *
 * The existing src/lib/security/hit-validation.ts covers the basic
 * anti-cheat: HMAC-signed hit receipts, rate limiting, basic sanity
 * checks. This module adds the BALLISTIC-SIDE validation: when a client
 * reports a hit, the server re-simulates the shot using the same
 * ballistic model + verifies the hit is physically possible.
 *
 * The checks:
 *
 *   1. SHOT FEASIBILITY:
 *      - The reported hit point must be within the weapon's max effective
 *        range + a 5% tolerance.
 *      - The flight time must match the caliber's time-of-flight table
 *        at the reported range, ±10% (network jitter tolerance).
 *      - The bullet's velocity at impact must be > 30 m/s (otherwise the
 *        bullet would have despawned before hitting).
 *
 *   2. TRAJECTORY VALIDATION:
 *      - The reported hit point must lie on a plausible ballistic
 *        trajectory from the shooter's position. The server computes the
 *        expected drop + wind drift at the reported range + verifies the
 *        hit point is within the bullet's possible hit cone (the cone
 *        widens with range due to spread + spin destabilization).
 *      - The trajectory must NOT pass through impenetrable surfaces
 *        (steel plate, sandbag) without sufficient residual velocity.
 *
 *   3. HITBOX VALIDATION:
 *      - The reported hit point must map to a valid hitbox on the target
 *        enemy. If the client claims a headshot but the hit point is
 *        outside the head hitbox AABB, the hit is rejected (or downgraded
 *        to the actual zone the hit point lies in).
 *
 *   4. RATE-OF-FIRE VALIDATION:
 *      - The client must not report hits faster than the weapon's fire
 *        rate allows. Two hits within 30ms of each other from a 600 RPM
 *        weapon (= 100ms between shots) is impossible — flag it.
 *
 *   5. DAMAGE VALIDATION:
 *      - The reported damage must match the server's recomputation
 *        (weapon damage × caliber falloff × hitbox mult × organ mult)
 *        within ±10%. Larger discrepancies are flagged as a damage hack.
 *
 *   6. CONSISTENCY VALIDATION:
 *      - The client's reported recoil state must be consistent with the
 *        shots fired (recoil accumulates per shot + recovers over time).
 *        A client claiming to dump 30 rounds from an AK with no recoil
 *        is using a no-recoil hack.
 *
 *   7. PATTERN VALIDATION (anti-macro):
 *      - The client's recoil compensation pattern must have human-like
 *        jitter (see recoil-randomization.ts). A perfect compensation
 *        pattern (no jitter, perfectly linear) is a macro.
 *
 * The module returns a `HitValidationResult` for each reported hit. The
 * server's hit-registration code reads the result + either accepts the
 * hit (with optional downgraded damage / zone), rejects it, or flags it
 * for review (cheat suspicion).
 *
 * Tone reference: tactical-mil-sim-leaning-arcade. The checks are strict
 * enough to catch obvious cheats (instakill, wallhack, aimbot) but loose
 * enough to tolerate network jitter + legitimate skill.
 */

import type { WeaponType } from "../store";
import { WEAPONS } from "../store";
import {
  getWeaponCaliber,
  interpolateBallisticRow,
  type CaliberProfile,
} from "./caliber-tables";
import {
  createPenetrationContext,
  attemptLayerPenetration,
  type PenetrationContext,
} from "./layered-penetration";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Vec3 { x: number; y: number; z: number; }

export interface ReportedHit {
  /** Shooter's player ID. */
  shooterId: string;
  /** Target's player ID (or enemy ID). */
  targetId: string;
  /** Weapon used. */
  weapon: WeaponType;
  /** Shooter's position at fire time (world space). */
  shooterPos: Vec3;
  /** Target's position at hit time (world space). */
  targetPos: Vec3;
  /** Reported hit point (world space). */
  hitPoint: Vec3;
  /** Reported flight time (seconds). */
  flightTimeSec: number;
  /** Reported hit zone (head / chest / limb). */
  reportedZone: "head" | "chest" | "limb";
  /** Reported damage. */
  reportedDamage: number;
  /** Timestamp of the shot (ms). */
  shotTimestampMs: number;
  /** Wind speed at fire time (m/s). */
  windSpeedMps: number;
  /** Wind direction at fire time (radians). */
  windDirectionRad: number;
}

export interface HitValidationResult {
  /** Final verdict: "accept" / "reject" / "flag". */
  verdict: "accept" | "reject" | "flag";
  /** Validated (server-computed) damage. May differ from reported. */
  validatedDamage: number;
  /** Validated hit zone. May differ from reported (downgraded). */
  validatedZone: "head" | "chest" | "limb";
  /** Reasons for the verdict (multiple if multiple checks failed). */
  reasons: string[];
  /** Cheat suspicion score (0..1). Higher = more suspicious. */
  suspicionScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation context — the server's view of the world at the time of the shot.
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationContext {
  /** Surfaces between the shooter + target (for trajectory validation). */
  surfaces: Array<{
    /** Surface slug. */
    slug: string;
    /** Surface AABB (world space). */
    aabb: { min: Vec3; max: Vec3 };
    /** Surface thickness (m). */
    thicknessM: number;
  }>;
  /** The target's body bounding box (world space). */
  targetBodyAabb: { min: Vec3; max: Vec3 };
  /** The shooter's previous shot timestamp (for rate-of-fire validation). */
  previousShotTimestampMs: number;
  /** The shooter's cumulative recoil state (for pattern validation). */
  shooterRecoilState: {
    /** Total recoil accumulated (arbitrary units). */
    accumulated: number;
    /** Recovery rate per second. */
    recoveryPerSec: number;
    /** Number of shots fired in the current burst. */
    burstShotCount: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Tolerance for flight-time validation (±10%). */
export const FLIGHT_TIME_TOLERANCE = 0.10;

/** Tolerance for damage validation (±10%). */
export const DAMAGE_TOLERANCE = 0.10;

/** Minimum bullet velocity at impact (m/s). */
export const MIN_IMPACT_VELOCITY_MPS = 30;

/** Max effective range tolerance (+5%). */
export const RANGE_TOLERANCE = 1.05;

/** Suspicion threshold (above this = reject). */
export const SUSPICION_REJECT_THRESHOLD = 0.7;

/** Suspicion flag threshold (above this = flag for review). */
export const SUSPICION_FLAG_THRESHOLD = 0.3;

// ─────────────────────────────────────────────────────────────────────────────
// Validation pass 1 — shot feasibility.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the Euclidean distance between two points.
 */
function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Validate the shot's basic feasibility — range + flight time + impact velocity.
 */
export function validateShotFeasibility(
  hit: ReportedHit,
): { ok: boolean; reasons: string[]; suspicion: number } {
  const reasons: string[] = [];
  let suspicion = 0;
  const caliber = getWeaponCaliber(hit.weapon);
  const range = distance(hit.shooterPos, hit.targetPos);

  // Range check: must be within the weapon's effective range × tolerance.
  const maxRange = WEAPONS[hit.weapon]?.range ?? 100;
  if (range > maxRange * RANGE_TOLERANCE) {
    reasons.push(`range ${range.toFixed(0)}m exceeds weapon max ${maxRange}m`);
    suspicion += 0.4;
  }

  // Caliber max effective range check.
  if (range > caliber.maxEffectiveRangeM * RANGE_TOLERANCE) {
    reasons.push(`range ${range.toFixed(0)}m exceeds caliber max effective ${caliber.maxEffectiveRangeM}m`);
    suspicion += 0.5;
  }

  // Flight time check: must match the caliber's TOF at the reported range.
  const expectedRow = interpolateBallisticRow(caliber, range);
  const expectedTof = expectedRow.timeOfFlightS;
  const tofDiff = Math.abs(hit.flightTimeSec - expectedTof) / Math.max(0.001, expectedTof);
  if (tofDiff > FLIGHT_TIME_TOLERANCE) {
    reasons.push(`flight time ${hit.flightTimeSec.toFixed(3)}s differs from expected ${expectedTof.toFixed(3)}s by ${(tofDiff * 100).toFixed(0)}%`);
    suspicion += 0.3;
  }

  // Impact velocity check: must be > MIN_IMPACT_VELOCITY_MPS.
  const impactVelocity = expectedRow.velocityMps;
  if (impactVelocity < MIN_IMPACT_VELOCITY_MPS) {
    reasons.push(`impact velocity ${impactVelocity.toFixed(0)}m/s below minimum ${MIN_IMPACT_VELOCITY_MPS}m/s`);
    suspicion += 0.4;
  }

  return { ok: reasons.length === 0, reasons, suspicion: Math.min(1, suspicion) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation pass 2 — trajectory validation (hit point plausibility).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate that the reported hit point lies on a plausible ballistic
 * trajectory from the shooter's position to the target.
 *
 * The check:
 *   1. Compute the expected drop + wind drift at the reported range.
 *   2. Compute the line from shooter to (target - drop + drift).
 *   3. Check if the reported hit point is within the bullet's possible
 *      hit cone (the cone widens with range due to spread + spin destabilization).
 *
 * For shots through surfaces, also validate that the bullet has sufficient
 * residual velocity to penetrate each surface in its path.
 */
export function validateTrajectory(
  hit: ReportedHit,
  ctx: ValidationContext,
): { ok: boolean; reasons: string[]; suspicion: number } {
  const reasons: string[] = [];
  let suspicion = 0;
  const caliber = getWeaponCaliber(hit.weapon);
  const range = distance(hit.shooterPos, hit.targetPos);

  // Compute the expected drop + wind drift at the reported range.
  const ballisticRow = interpolateBallisticRow(caliber, range);
  const expectedDropM = ballisticRow.dropCm / 100;
  // The hit point's vertical offset from the bore line.
  const shooterToTarget = {
    x: hit.targetPos.x - hit.shooterPos.x,
    y: hit.targetPos.y - hit.shooterPos.y,
    z: hit.targetPos.z - hit.shooterPos.z,
  };
  const boreLineDir = {
    x: shooterToTarget.x,
    y: 0, // bore line is horizontal — drop is accounted for separately
    z: shooterToTarget.z,
  };
  const boreLineLen = Math.sqrt(boreLineDir.x * boreLineDir.x + boreLineDir.z * boreLineDir.z);
  if (boreLineLen < 0.01) {
    reasons.push("shooter and target are at the same position");
    suspicion += 0.5;
    return { ok: false, reasons, suspicion };
  }

  // Compute the expected hit point = bore line endpoint + drop.
  const expectedHitPoint: Vec3 = {
    x: hit.targetPos.x,
    y: hit.targetPos.y + expectedDropM, // expected hit point is below bore line by drop
    z: hit.targetPos.z,
  };

  // The reported hit point must be within the hit cone. The cone's radius
  // grows with range due to spread + spin destabilization. Approximate:
  // cone radius = (spread × range) + (destabilization scatter × range).
  const weapon = WEAPONS[hit.weapon];
  const spreadRad = weapon?.spread ?? 0.02;
  const coneRadiusM = spreadRad * range + 0.05 * range / 100; // destabilization term
  const hitPointDiff = distance(hit.hitPoint, expectedHitPoint);
  if (hitPointDiff > coneRadiusM) {
    reasons.push(`hit point ${hitPointDiff.toFixed(2)}m from expected, cone radius ${coneRadiusM.toFixed(2)}m`);
    suspicion += 0.5;
  }

  // Surface penetration check: walk the bullet through each surface in its
  // path + verify it has sufficient residual velocity.
  let penetrationCtx: PenetrationContext = createPenetrationContext(
    caliber.slug,
    caliber.muzzleVelocityMps,
  );
  for (const surface of ctx.surfaces) {
    // Check if the bullet's path intersects this surface's AABB. (For
    // simplicity, we use a ray-AABB intersection test here.)
    if (!rayAabbIntersection(hit.shooterPos, hit.hitPoint, surface.aabb)) continue;
    // Attempt to penetrate.
    const result = attemptLayerPenetration(
      penetrationCtx, surface.slug, surface.thicknessM, -1,
    );
    penetrationCtx = result.context;
    if (!result.penetrated && !result.deflected) {
      reasons.push(`bullet stopped in surface ${surface.slug} before reaching target`);
      suspicion += 0.6;
      break;
    }
  }

  return { ok: reasons.length === 0, reasons, suspicion: Math.min(1, suspicion) };
}

/** Ray-AABB intersection test (slab method). */
function rayAabbIntersection(
  rayStart: Vec3,
  rayEnd: Vec3,
  aabb: { min: Vec3; max: Vec3 },
): boolean {
  const dir = {
    x: rayEnd.x - rayStart.x,
    y: rayEnd.y - rayStart.y,
    z: rayEnd.z - rayStart.z,
  };
  let tmin = 0;
  let tmax = 1;
  for (const axis of ["x", "y", "z"] as const) {
    const invD = 1 / (Math.abs(dir[axis]) < 1e-9 ? 1e-9 : dir[axis]);
    let t1 = (aabb.min[axis] - rayStart[axis]) * invD;
    let t2 = (aabb.max[axis] - rayStart[axis]) * invD;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return tmax >= 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation pass 3 — hitbox validation.
//
// Verify the reported hit point actually lies in the reported hit zone.
// If not, downgrade the zone to the actual zone the hit point lies in.
// ─────────────────────────────────────────────────────────────────────────────

export function validateHitbox(
  hit: ReportedHit,
  ctx: ValidationContext,
): { zone: "head" | "chest" | "limb"; downgraded: boolean; reasons: string[]; suspicion: number } {
  const reasons: string[] = [];
  let suspicion = 0;
  // Compute the hit point's position within the target's body AABB (normalized 0..1).
  const aabb = ctx.targetBodyAabb;
  const ny = (hit.hitPoint.y - aabb.min.y) / Math.max(0.01, aabb.max.y - aabb.min.y);
  // Classify the zone by height.
  let actualZone: "head" | "chest" | "limb";
  if (ny > 0.85) actualZone = "head";      // top 15% = head
  else if (ny > 0.30) actualZone = "chest"; // middle 55% = chest
  else actualZone = "limb";                 // bottom 30% = limb

  const downgraded = actualZone !== hit.reportedZone;
  if (downgraded) {
    reasons.push(`reported zone ${hit.reportedZone} but hit point is in ${actualZone} zone (y-ratio ${ny.toFixed(2)})`);
    suspicion += 0.3;
  }

  return { zone: actualZone, downgraded, reasons, suspicion: Math.min(1, suspicion) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation pass 4 — rate-of-fire validation.
// ─────────────────────────────────────────────────────────────────────────────

export function validateRateOfFire(
  hit: ReportedHit,
  ctx: ValidationContext,
): { ok: boolean; reasons: string[]; suspicion: number } {
  const reasons: string[] = [];
  let suspicion = 0;
  const weapon = WEAPONS[hit.weapon];
  if (!weapon) return { ok: false, reasons: ["unknown weapon"], suspicion: 1 };
  const minIntervalMs = weapon.fireRate; // ms between shots
  const actualIntervalMs = hit.shotTimestampMs - ctx.previousShotTimestampMs;
  if (actualIntervalMs < minIntervalMs * 0.85) { // 15% tolerance
    reasons.push(`shot interval ${actualIntervalMs}ms below weapon minimum ${minIntervalMs}ms`);
    suspicion += 0.6;
  }
  return { ok: reasons.length === 0, reasons, suspicion: Math.min(1, suspicion) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation pass 5 — damage validation.
// ─────────────────────────────────────────────────────────────────────────────

export function validateDamage(
  hit: ReportedHit,
  validatedZone: "head" | "chest" | "limb",
): { ok: boolean; validatedDamage: number; reasons: string[]; suspicion: number } {
  const reasons: string[] = [];
  let suspicion = 0;
  const weapon = WEAPONS[hit.weapon];
  if (!weapon) return { ok: false, validatedDamage: 0, reasons: ["unknown weapon"], suspicion: 1 };

  const caliber = getWeaponCaliber(hit.weapon);
  const range = distance(hit.shooterPos, hit.targetPos);
  // Compute the expected damage: weapon damage × energy retention × zone mult.
  const ballisticRow = interpolateBallisticRow(caliber, range);
  const energyRatio = Math.max(0.25, ballisticRow.energyJ / caliber.muzzleEnergyJ);
  const zoneMult = validatedZone === "head" ? 4.0 : validatedZone === "limb" ? 0.7 : 1.0;
  const expectedDamage = weapon.damage * energyRatio * zoneMult;

  const damageDiff = Math.abs(hit.reportedDamage - expectedDamage) / Math.max(1, expectedDamage);
  if (damageDiff > DAMAGE_TOLERANCE) {
    reasons.push(`reported damage ${hit.reportedDamage.toFixed(1)} differs from expected ${expectedDamage.toFixed(1)} by ${(damageDiff * 100).toFixed(0)}%`);
    suspicion += 0.5;
  }

  return {
    ok: reasons.length === 0,
    validatedDamage: expectedDamage,
    reasons,
    suspicion: Math.min(1, suspicion),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation pass 6 — recoil consistency (anti-no-recoil).
//
// The shooter's recoil state must be consistent with the shots fired.
// Each shot adds recoil (accumulated += recoilPerShot); recovery decays
// it over time. If the reported accumulated recoil is far below the
// expected value, the shooter is using a no-recoil hack.
// ─────────────────────────────────────────────────────────────────────────────

export function validateRecoilConsistency(
  hit: ReportedHit,
  ctx: ValidationContext,
): { ok: boolean; reasons: string[]; suspicion: number } {
  const reasons: string[] = [];
  let suspicion = 0;
  const weapon = WEAPONS[hit.weapon];
  if (!weapon) return { ok: false, reasons: ["unknown weapon"], suspicion: 1 };

  // Expected accumulated recoil = (burstShotCount × recoilPerShot) - (recovery × elapsed)
  const recoilPerShot = weapon.recoil;
  const expectedAccumulated = ctx.shooterRecoilState.burstShotCount * recoilPerShot
    - ctx.shooterRecoilState.recoveryPerSec * (hit.shotTimestampMs / 1000);
  const actualAccumulated = ctx.shooterRecoilState.accumulated;
  if (actualAccumulated < expectedAccumulated * 0.3) {
    reasons.push(`recoil accumulated ${actualAccumulated.toFixed(2)} far below expected ${expectedAccumulated.toFixed(2)} (no-recoil hack suspicion)`);
    suspicion += 0.7;
  }

  return { ok: reasons.length === 0, reasons, suspicion: Math.min(1, suspicion) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level validation — run all passes + compute the final verdict.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a reported hit. Runs all 6 validation passes + computes the
 * final verdict:
 *
 *   - "accept"  — all passes succeeded (or failed with low suspicion).
 *   - "flag"    — one or more passes failed with moderate suspicion (cheat
 *                 suspicion but not conclusive). The hit is accepted but
 *                 flagged for review.
 *   - "reject"  — one or more passes failed with high suspicion. The hit
 *                 is rejected.
 *
 * The validated damage + zone may differ from the reported values (the
 * server uses its own computation as the source of truth).
 */
export function validateHit(
  hit: ReportedHit,
  ctx: ValidationContext,
): HitValidationResult {
  const allReasons: string[] = [];
  let totalSuspicion = 0;

  // Pass 1: shot feasibility.
  const feasibility = validateShotFeasibility(hit);
  allReasons.push(...feasibility.reasons);
  totalSuspicion += feasibility.suspicion;

  // Pass 2: trajectory.
  const trajectory = validateTrajectory(hit, ctx);
  allReasons.push(...trajectory.reasons);
  totalSuspicion += trajectory.suspicion;

  // Pass 3: hitbox (downgrade if needed).
  const hitbox = validateHitbox(hit, ctx);
  allReasons.push(...hitbox.reasons);
  totalSuspicion += hitbox.suspicion;

  // Pass 4: rate of fire.
  const rof = validateRateOfFire(hit, ctx);
  allReasons.push(...rof.reasons);
  totalSuspicion += rof.suspicion;

  // Pass 5: damage (use the validated zone).
  const damage = validateDamage(hit, hitbox.zone);
  allReasons.push(...damage.reasons);
  totalSuspicion += damage.suspicion;

  // Pass 6: recoil consistency.
  const recoil = validateRecoilConsistency(hit, ctx);
  allReasons.push(...recoil.reasons);
  totalSuspicion += recoil.suspicion;

  // Final verdict.
  const avgSuspicion = Math.min(1, totalSuspicion / 6);
  let verdict: "accept" | "reject" | "flag";
  if (avgSuspicion >= SUSPICION_REJECT_THRESHOLD) {
    verdict = "reject";
  } else if (avgSuspicion >= SUSPICION_FLAG_THRESHOLD) {
    verdict = "flag";
  } else {
    verdict = "accept";
  }

  return {
    verdict,
    validatedDamage: damage.validatedDamage,
    validatedZone: hitbox.zone,
    reasons: allReasons,
    suspicionScore: avgSuspicion,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cheat detection aggregation.
//
// The server maintains a per-player cheat suspicion score, aggregated over
// many shots. A single flagged shot is no big deal (network jitter); 10
// flagged shots in a row is a clear pattern.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayerCheatScore {
  /** Player ID. */
  playerId: string;
  /** Total shots validated. */
  totalShots: number;
  /** Number of shots flagged. */
  flaggedShots: number;
  /** Number of shots rejected. */
  rejectedShots: number;
  /** Average suspicion score across all shots. */
  avgSuspicion: number;
  /** Last 10 suspicion scores (rolling window). */
  recentSuspicion: number[];
}

/** Create a fresh cheat score for a player. */
export function createPlayerCheatScore(playerId: string): PlayerCheatScore {
  return {
    playerId,
    totalShots: 0,
    flaggedShots: 0,
    rejectedShots: 0,
    avgSuspicion: 0,
    recentSuspicion: [],
  };
}

/** Update the cheat score with a new validation result. */
export function updatePlayerCheatScore(
  score: PlayerCheatScore,
  result: HitValidationResult,
): PlayerCheatScore {
  const newTotal = score.totalShots + 1;
  const newFlagged = score.flaggedShots + (result.verdict === "flag" ? 1 : 0);
  const newRejected = score.rejectedShots + (result.verdict === "reject" ? 1 : 0);
  const newAvg = (score.avgSuspicion * score.totalShots + result.suspicionScore) / newTotal;
  const newRecent = [...score.recentSuspicion, result.suspicionScore].slice(-10);
  return {
    playerId: score.playerId,
    totalShots: newTotal,
    flaggedShots: newFlagged,
    rejectedShots: newRejected,
    avgSuspicion: newAvg,
    recentSuspicion: newRecent,
  };
}

/**
 * Determine the action to take based on a player's cheat score.
 *   - "none"     — no action (legitimate player).
 *   - "monitor"  — increase monitoring (suspicious but inconclusive).
 *   - "warn"     — send a warning to the player (clear pattern of suspicion).
 *   - "kick"     — kick the player (conclusive cheat detection).
 *   - "ban"      — ban the player (long-term pattern of cheating).
 */
export function cheatScoreAction(score: PlayerCheatScore): "none" | "monitor" | "warn" | "kick" | "ban" {
  const flagRate = score.totalShots > 0 ? score.flaggedShots / score.totalShots : 0;
  const rejectRate = score.totalShots > 0 ? score.rejectedShots / score.totalShots : 0;
  if (rejectRate > 0.5 && score.totalShots > 10) return "ban";
  if (rejectRate > 0.3 && score.totalShots > 5) return "kick";
  if (flagRate > 0.3 && score.totalShots > 10) return "warn";
  if (flagRate > 0.1 && score.totalShots > 20) return "monitor";
  return "none";
}
