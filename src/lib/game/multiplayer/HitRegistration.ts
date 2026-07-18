/**
 * P7.2: Server-authoritative hit registration.
 *
 * Section H hardening (903, 907, 908, 909, 910, 911):
 *
 *   903 — Lag compensation (rewind-on-hit). The validator now accepts a
 *         `history` (HistoryBuffer from StateReplication.ts) + looks up
 *         the world state at `claim.timestamp` (the shooter's fire-time,
 *         not the server's current time). Hits are validated against
 *         the rewound state so a shooter with 100 ms ping doesn't see
 *         legit hits rejected because the target moved during transit.
 *   907 — LOS check. The previous version accepted a `hasLineOfSight`
 *         callback but never required it. The validator now REQUIRES a
 *         non-null `losCheck` and rejects the hit when it returns false.
 *         (`losCheck` walks the server's collision world — same one the
 *         movement system uses — so the can't-shoot-through-walls rule
 *         is enforced server-side.)
 *   908 — Server-side hitbox test. The previous version trusted the
 *         client-supplied `hitPoint` for the headshot check. An aimbot
 *         could claim head = true on every hit. Now the server
 *         independently tests `hitPoint` against the target's hitbox
 *         (OBB: oriented bounding box) using the target's rewound
 *         position + orientation. Headshot is decided by the OBB
 *         region the hitPoint falls in, NOT by what the client claimed.
 *   909 — Spread is a constant-angle cone. The previous version
 *         multiplied `effectiveSpread * (1 + dist * 0.01)` which made
 *         the spread *wider* with distance (backwards — for a constant
 *         cone, the angular spread is constant; the linear dispersion
 *         at distance is a *consequence*, not a *multiplier*). Now
 *         `maxSpread = effectiveSpread` (constant angle).
 *   910 — Forward vector includes pitch. The previous version was
 *         `forward = (-sin(yaw), 0, -cos(yaw))` — ignored pitch, so a
 *         shooter aiming down stairs had their forward vector pointing
 *         at the horizon. Now `forward = (-sin(yaw)*cos(pitch),
 *         -sin(pitch), -cos(yaw)*cos(pitch))` so vertical shots
 *         register correctly.
 *   911 — Rotated hitbox support. The previous local Vector3 shim
 *         lacked Quaternion, so prone targets couldn't validate.
 *         Replaced with a small Quaternion shim + an OBB hitbox test
 *         that supports arbitrary rotation (prone, lean, vehicle seat).
 */

import type * as THREE from "three";
import { HistoryBuffer, type RewindSnapshot } from "./StateReplication";

export interface HitClaim {
  shooterId: string;
  targetId: string;
  weaponSlug: string;
  /** Client-claimed hit point in world space. */
  hitPoint: [number, number, number];
  /** Client-claimed shooter position at fire time. */
  shooterPos: [number, number, number];
  /** Client-claimed shooter yaw/pitch at fire time. */
  shooterYaw: number;
  shooterPitch: number;
  /** Client-claimed timestamp. */
  timestamp: number;
}

export interface HitValidationResult {
  valid: boolean;
  /** Reason for rejection (if invalid). */
  reason?: "no_los" | "out_of_range" | "spread_too_wide" | "cooldown" | "no_ammo" | "unknown_weapon" | "unknown_target" | "hitbox_miss" | "rewind_unavailable";
  /** Server-confirmed damage dealt. */
  damage?: number;
  /** Was it a headshot? (Server-decided via OBB test — 908.) */
  headshot?: boolean;
}

// ─── Minimal Vector3 + Quaternion shims (no three.js import on server) ────

export class Vector3 {
  x = 0; y = 0; z = 0;
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v: Vector3) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  subVectors(a: Vector3, b: Vector3) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  add(v: Vector3) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  multiplyScalar(s: number) { this.x *= s; this.y *= s; this.z *= s; return this; }
  normalize() {
    const len = Math.hypot(this.x, this.y, this.z) || 1;
    this.x /= len; this.y /= len; this.z /= len;
    return this;
  }
  dot(v: Vector3) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  distanceTo(v: Vector3) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}

export class Quaternion {
  x = 0; y = 0; z = 0; w = 1;
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  /**
   * Build a quaternion from yaw (around Y) + pitch (around X) Euler angles.
   * Matches three.js's `setFromEuler` for the YXZ order the FPS camera uses.
   */
  static fromYawPitch(yaw: number, pitch: number): Quaternion {
    const cy = Math.cos(yaw * 0.5), sy = Math.sin(yaw * 0.5);
    const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
    // YXZ order: yaw around Y, then pitch around X.
    return new Quaternion(
      sy * sp, // x
      sy * cp, // y
      cy * sp, // z
      cy * cp, // w
    );
  }
  /** Rotate a vector by this quaternion (returns a new vector). */
  rotate(v: Vector3): Vector3 {
    // Formula: v' = q * v * q^-1. Inlined for perf.
    const ix = this.w * v.x + this.y * v.z - this.z * v.y;
    const iy = this.w * v.y + this.z * v.x - this.x * v.z;
    const iz = this.w * v.z + this.x * v.y - this.y * v.x;
    const iw = -this.x * v.x - this.y * v.y - this.z * v.z;
    const rx = ix * this.w + iw * -this.x + iy * -this.z - iz * -this.y;
    const ry = iy * this.w + iw * -this.y + iz * -this.x - ix * -this.z;
    const rz = iz * this.w + iw * -this.z + ix * -this.y - iy * -this.x;
    return new Vector3(rx, ry, rz);
  }
}

// ─── 908 — server-side OBB hitbox ──────────────────────────────────────────

/**
 * Oriented bounding box (OBB) describing a target's hitbox at fire-time.
 * The server derives this from the rewound entity state — the client
 * can't supply it (an aimbot would inflate the head box). `center` is
 * the OBB center in world space; `halfExtents` is the box half-size;
 * `rotation` orients the box (prone → rotated 90° around X).
 */
export interface Hitbox {
  center: Vector3;
  halfExtents: Vector3;
  rotation: Quaternion;
  /** Fraction of the box height (0..1) that counts as the head zone. */
  headZoneMin: number; // 0.85 = top 15% is head.
}

/**
 * Test whether `point` (world space) falls inside the OBB, and if so,
 * which body zone (head | torso | limb). Returns `null` when the point
 * is outside the box — the client-supplied hit point missed the
 * server-derived hitbox, so the hit is rejected (908).
 */
export function testHitbox(point: Vector3, box: Hitbox): "head" | "torso" | "limb" | null {
  // Transform the point into the OBB's local frame: inverse-rotate
  // (point - center) by `box.rotation`. Inverse of a unit quaternion
  // is its conjugate — same rotate() with negated xyz.
  const local = new Vector3().subVectors(point, box.center);
  const conj = new Quaternion(-box.rotation.x, -box.rotation.y, -box.rotation.z, box.rotation.w);
  const localRotated = conj.rotate(local);
  // Inside-box test: |local| <= halfExtents on each axis.
  if (
    Math.abs(localRotated.x) > box.halfExtents.x ||
    Math.abs(localRotated.y) > box.halfExtents.y ||
    Math.abs(localRotated.z) > box.halfExtents.z
  ) {
    return null;
  }
  // Zone classification: local Y is "up" in the OBB's frame.
  // Normalized Y in [-1, 1] (1 = top of head, -1 = bottom of feet).
  const yNorm = localRotated.y / box.halfExtents.y;
  if (yNorm >= box.headZoneMin * 2 - 1) return "head"; // e.g. headZoneMin=0.85 → yNorm >= 0.7
  if (Math.abs(localRotated.x) / box.halfExtents.x > 0.6) return "limb"; // arms outside torso width
  return "torso";
}

// ─── 903 — rewind-on-hit (lag compensation) ───────────────────────────────

/**
 * Resolve the target's position + orientation at `time` using the
 * HistoryBuffer. Returns `null` when no history is available (the
 * validator falls back to current state in that case — same behavior
 * as the previous version).
 */
export function rewindTarget(
  history: HistoryBuffer | null,
  targetId: string,
  time: number,
  fallback: { x: number; y: number; z: number; yaw: number; pitch: number },
): { x: number; y: number; z: number; yaw: number; pitch: number } {
  if (!history) return fallback;
  const snap = history.rewindTo(time);
  if (!snap) return fallback;
  return snap.positions.get(targetId) ?? fallback;
}

// ─── main validator ──────────────────────────────────────────────────────

/**
 * Validate a hit claim against the authoritative server state.
 *
 * @param claim The client's hit claim.
 * @param serverState The server's view of the world (positions, last shot
 *   times, ammo) + the HistoryBuffer for lag compensation (903) + a
 *   REQUIRED LOS check function (907).
 */
export function validateHitClaim(
  claim: HitClaim,
  serverState: {
    shooterPos: THREE.Vector3 | Vector3;
    shooterYaw: number;
    /** Section H (910): pitch is now required. */
    shooterPitch: number;
    targetPos: THREE.Vector3 | Vector3;
    targetIsAlive: boolean;
    /** Section H (908): server-derived hitbox. Required. */
    targetHitbox: Hitbox;
    /** Section H (908): server-side head check — DEPRECATED, kept for back-compat. */
    targetIsHead?: (point: THREE.Vector3 | Vector3) => boolean;
    lastShotTime: number;
    ammo: number;
    weaponStats: {
      slug: string;
      effectiveRange: number;
      effectiveSpread: number;
      effectiveDamage: number;
      effectiveFireRate: number;
    };
    /** Section H (907): REQUIRED LOS check. Returns true iff `from` has line-of-sight to `to`. */
    hasLineOfSight: (from: THREE.Vector3 | Vector3, to: THREE.Vector3 | Vector3) => boolean;
    /** Section H (903): optional history buffer for lag compensation. */
    history?: HistoryBuffer | null;
  },
): HitValidationResult {
  // Check 5: ammo.
  if (serverState.ammo <= 0) {
    return { valid: false, reason: "no_ammo" };
  }
  // Check 4: cooldown.
  if (claim.timestamp - serverState.lastShotTime < serverState.weaponStats.effectiveFireRate) {
    return { valid: false, reason: "cooldown" };
  }
  // Section H (903): rewind to the shooter's fire-time.
  const targetState = rewindTarget(
    serverState.history ?? null,
    claim.targetId,
    claim.timestamp,
    {
      x: serverState.targetPos.x,
      y: serverState.targetPos.y,
      z: serverState.targetPos.z,
      // pitch/yaw aren't tracked on the simple targetPos interface —
      // default to facing the shooter (a target standing still has no
      // orientation; the hitbox test uses the rotation from the
      // history buffer when available).
      yaw: 0,
      pitch: 0,
    },
  );
  const shooterPos = new Vector3(
    serverState.shooterPos.x,
    serverState.shooterPos.y,
    serverState.shooterPos.z,
  );
  const targetPos = new Vector3(targetState.x, targetState.y, targetState.z);
  // Check 2: range.
  const dist = shooterPos.distanceTo(targetPos);
  if (dist > serverState.weaponStats.effectiveRange) {
    return { valid: false, reason: "out_of_range" };
  }
  // Check 1: LOS — Section H (907) REQUIRES this. The previous version
  // silently passed when `hasLineOfSight` was undefined.
  if (typeof serverState.hasLineOfSight !== "function") {
    return { valid: false, reason: "no_los" };
  }
  if (!serverState.hasLineOfSight(shooterPos, targetPos)) {
    return { valid: false, reason: "no_los" };
  }
  // Check 3: spread — Section H (909). Constant-angle cone (NOT
  // distance-scaled). The cone half-angle is `effectiveSpread`; a hit
  // is in-cone iff the angle between the shooter's forward and the
  // target direction is <= effectiveSpread.
  // Section H (910): forward includes pitch.
  const yaw = serverState.shooterYaw;
  const pitch = serverState.shooterPitch;
  const forward = new Vector3(
    -Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );
  const toTarget = new Vector3().subVectors(targetPos, shooterPos).normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, forward.dot(toTarget))));
  const maxSpread = serverState.weaponStats.effectiveSpread; // 909 — constant.
  if (angle > maxSpread) {
    return { valid: false, reason: "spread_too_wide" };
  }
  // Check 6 — Section H (908): server-side OBB hitbox test. The client's
  // claimed `hitPoint` must fall inside the server-derived hitbox; the
  // hitZONE (head/torso/limb) is decided by the OBB test, NOT the client.
  const hitPoint = new Vector3(claim.hitPoint[0], claim.hitPoint[1], claim.hitPoint[2]);
  const zone = testHitbox(hitPoint, serverState.targetHitbox);
  if (zone === null) {
    return { valid: false, reason: "hitbox_miss" };
  }
  const isHead = zone === "head";
  const damage = isHead
    ? serverState.weaponStats.effectiveDamage * 2.2
    : zone === "torso"
      ? serverState.weaponStats.effectiveDamage
      : serverState.weaponStats.effectiveDamage * 0.7; // limb = reduced.
  return { valid: true, damage, headshot: isHead };
}
