/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * LandingRolls — landing roll animations for fall-damage mitigation.
 *
 * B-prompt mapping:
 *   B-00063 — combat roll animation (ragdoll corpse variant uses this module
 *     for the alive-side driver).
 *   B-00076 / B-00077 — combat roll (elite enemy / player FP rig).
 *   B-00029 / B-00049 / B-00094 — prone dive (roll-into-prone uses the same
 *     forward-roll keyframe set as the landing roll, terminated in prone).
 *   B-00004 — stumble-on-leg-shot (limp-roll variant — left-leg-hit bias).
 *
 * Design:
 *   A landing roll converts fall-damage-eligible vertical velocity into
 *   forward horizontal momentum by tucking + rolling. The system:
 *
 *     1. Triggers when the player lands with downward velocity above
 *        rollThreshold (default 8 m/s — ~3.3m fall).
 *     2. Picks a roll direction: forward (player input), or side (random
 *        if no input). The roll axis is horizontal.
 *     3. Builds a procedural THREE.AnimationClip from a roll profile:
 *          a. Tuck (0.1s)  — knees bend, body lowers.
 *          b. Roll  (0.4s) — root rotates 360° around the roll axis, body
 *                            translates forward by ~1.5m, head ducks.
 *          c. Rise  (0.3s) — body returns to standing.
 *     4. Returns damageMitigation (0..1) — the fraction of fall damage
 *        that should be negated. Higher forward speed at landing → more
 *        mitigation (cap 0.85 at 8 m/s forward).
 *
 *   The clip targets the character rig's root (Hips) position + quaternion
 *   plus per-bone tuck rotations (Spine, Spine1, Neck, Head, LeftUpLeg/
 *   RightUpLeg, LeftLeg/RightLeg) so the roll plays on any Mixamo rig.
 *
 * SSR-safe: pure THREE + TS; no window/document.
 *
 * Public API:
 *   - LANDING_ROLL_PARAMS — tuning constants.
 *   - shouldRoll(verticalVel, forwardSpeed, opts?) → boolean
 *   - computeDamageMitigation(forwardSpeed) → 0..1
 *   - buildLandingRollClip(direction, opts?) → THREE.AnimationClip
 *   - class LandingRollDriver — owns a mixer + drives the roll clip.
 *   - .trigger(direction, opts?) → starts the roll; returns mitigation.
 *   - .tick(dt) → advance.
 *   - .isRolling() → true during the roll.
 *   - .onComplete(fn) — fires when the roll clip ends.
 */

import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Types + tuning
// ───────────────────────────────────────────────────────────────────────────

export type RollDirection = "forward" | "left" | "right" | "back";

export const LANDING_ROLL_PARAMS = {
  /** Minimum downward velocity (m/s) at landing that triggers a roll.
   *  Below this, the player just lands normally. */
  rollThresholdMs: 8.0,
  /** Maximum downward velocity that a roll can fully mitigate (m/s).
   *  Falls above this still deal reduced damage. */
  fullMitigateMs: 14.0,
  /** Forward-speed threshold for "good" roll (m/s). Above this, the
   *  mitigation is maximized. */
  goodForwardSpeedMs: 6.0,
  /** Roll distance (meters) for a forward roll. */
  forwardRollDistance: 1.5,
  /** Roll distance for a side roll (slightly less). */
  sideRollDistance: 1.2,
  /** Tuck phase duration (seconds). */
  tuckSec: 0.1,
  /** Roll phase duration (seconds). */
  rollSec: 0.4,
  /** Rise phase duration (seconds). */
  riseSec: 0.3,
  /** Total clip duration. */
  totalSec: 0.8,
  /** Maximum damage mitigation (0..1). */
  maxMitigation: 0.85,
};

export interface RollOptions {
  /** Override the roll distance (meters). */
  distance?: number;
  /** Override the total clip duration (seconds). */
  duration?: number;
  /** Multiply the tuck/roll/rise time split. */
  timeSplit?: { tuck: number; roll: number; rise: number };
  /** If true, end the roll in prone stance instead of standing. */
  endInProne?: boolean;
  /** Limp-leg bias (0 = symmetric, +1 = right leg weak, -1 = left leg
   *  weak). Asymmetric tuck + asymmetric rise for injured rolls. */
  limpBias?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Roll-decision helpers
// ───────────────────────────────────────────────────────────────────────────

/** Should the player roll on landing? Returns true if downward velocity
 *  is above the threshold AND (optionally) the roll key is held OR the
 *  forward speed is high enough that an automatic roll is sensible. */
export function shouldRoll(
  verticalVel: number,
  forwardSpeed: number,
  opts: { rollKeyHeld?: boolean; threshold?: number } = {},
): boolean {
  const threshold = opts.threshold ?? LANDING_ROLL_PARAMS.rollThresholdMs;
  // Downward velocity is negative in world space; check magnitude.
  const downSpeed = -verticalVel;
  if (downSpeed < threshold) return false;
  // Auto-roll if forward speed is high enough (momentum carries into roll).
  if (forwardSpeed >= 3.0) return true;
  // Otherwise require the roll key.
  return opts.rollKeyHeld === true;
}

/** Compute the damage-mitigation fraction for a roll with the given
 *  forward speed at landing. 0 = no mitigation; 1 = full mitigation. */
export function computeDamageMitigation(forwardSpeed: number): number {
  const { goodForwardSpeedMs, maxMitigation } = LANDING_ROLL_PARAMS;
  const ratio = Math.min(1, forwardSpeed / goodForwardSpeedMs);
  return maxMitigation * ratio;
}

// ───────────────────────────────────────────────────────────────────────────
// Clip builder
// ───────────────────────────────────────────────────────────────────────────

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Build a procedural landing-roll AnimationClip. The clip drives the
 *  Hips (root) position + quaternion + tuck rotations on the spine/
 *  neck/head/legs. */
export function buildLandingRollClip(
  direction: RollDirection,
  opts: RollOptions = {},
): THREE.AnimationClip {
  const P = LANDING_ROLL_PARAMS;
  const total = opts.duration ?? P.totalSec;
  const split = opts.timeSplit ?? { tuck: P.tuckSec, roll: P.rollSec, rise: P.riseSec };
  // Normalize split to total duration.
  const splitSum = split.tuck + split.roll + split.rise;
  const tuckDur = (split.tuck / splitSum) * total;
  const rollDur = (split.roll / splitSum) * total;
  const riseDur = (split.rise / splitSum) * total;

  const distance = opts.distance ??
    (direction === "forward" ? P.forwardRollDistance : P.sideRollDistance);

  // Roll axis: forward roll rotates around X axis; side rolls around Z.
  // For left/right rolls, the body also translates sideways.
  const isForward = direction === "forward" || direction === "back";
  const rollAxis = isForward ? "x" : "z";
  // Roll direction sign.
  const rollSign = direction === "back" || direction === "right" ? -1 : 1;
  // Forward/side translation sign.
  const translateX = isForward ? 0 : (direction === "right" ? 1 : -1) * distance;
  const translateZ = isForward ? (direction === "forward" ? 1 : -1) * distance : 0;

  // ── Build tracks ──
  // Hips.position: tuck down → roll translate → rise back to 0.
  // Hips.quaternion: rotate 360° around rollAxis during roll phase.
  // Spine/Spine1/Spine2/Neck/Head/LeftUpLeg/RightUpLeg/LeftLeg/RightLeg:
  //   tuck rotations during tuck phase, partial recovery during roll,
  //   full recovery during rise.

  const stepsPerPhase = 8;
  const times: number[] = [];
  const hipsPos: number[] = [];
  const hipsQuat: number[] = [];
  // Per-bone tracks.
  const boneRotations: Record<string, number[]> = {};
  const BONES_TO_TUCK = [
    "Spine", "Spine1", "Spine2", "Neck", "Head",
    "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg",
  ];
  for (const b of BONES_TO_TUCK) boneRotations[b] = [];

  // Tuck pose: curl forward ~90° at the spine, knees bend, head ducks.
  const tuckPose: Record<string, [number, number, number]> = {
    Spine: [0.6, 0, 0],
    Spine1: [0.5, 0, 0],
    Spine2: [0.4, 0, 0],
    Neck: [0.3, 0, 0],
    Head: [0.4, 0, 0],
    LeftUpLeg: [-0.4, 0, 0],
    RightUpLeg: [-0.4, 0, 0],
    LeftLeg: [0.8, 0, 0],
    RightLeg: [0.8, 0, 0],
  };
  // Limp bias: shift weight to the strong leg.
  const limp = opts.limpBias ?? 0;
  if (limp !== 0) {
    tuckPose.LeftUpLeg[0] -= limp * 0.2;
    tuckPose.RightUpLeg[0] += limp * 0.2;
    tuckPose.LeftLeg[0] -= limp * 0.3;
    tuckPose.RightLeg[0] += limp * 0.3;
  }
  // Prone end pose: body flat, legs extended.
  const pronePose: Record<string, [number, number, number]> = {
    Spine: [1.4, 0, 0],
    Spine1: [0.3, 0, 0],
    Spine2: [0.2, 0, 0],
    Neck: [0.1, 0, 0],
    Head: [0.2, 0, 0],
    LeftUpLeg: [-0.1, 0, 0],
    RightUpLeg: [-0.1, 0, 0],
    LeftLeg: [0.2, 0, 0],
    RightLeg: [0.2, 0, 0],
  };

  const endPose = opts.endInProne ? pronePose : null;

  // ── Tuck phase (0 → tuckDur): curl into ball, drop 0.3m. ──
  for (let i = 0; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = a * tuckDur;
    times.push(t);
    // Hips Y: 0 → -0.3 (drop into tuck).
    hipsPos.push(0, -0.3 * a, 0);
    // Hips quat: identity during tuck (no roll yet).
    hipsQuat.push(0, 0, 0, 1);
    // Bone rotations: identity → tuckPose.
    for (const b of BONES_TO_TUCK) {
      const p = tuckPose[b];
      _e.set(p[0] * a, p[1] * a, p[2] * a);
      _q.setFromEuler(_e);
      boneRotations[b].push(_q.x, _q.y, _q.z, _q.w);
    }
  }

  // ── Roll phase (tuckDur → tuckDur + rollDur): rotate 360° around axis,
  //    translate forward by `distance`, body stays tucked. ──
  for (let i = 1; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = tuckDur + a * rollDur;
    times.push(t);
    // Hips Y: dip slightly lower mid-roll (momentum), then back up.
    const yDip = -0.4 + 0.1 * Math.sin(a * Math.PI);
    hipsPos.push(translateX * a, yDip, translateZ * a);
    // Hips quat: rotate 360° around axis.
    if (rollAxis === "x") {
      _e.set(rollSign * a * Math.PI * 2, 0, 0);
    } else {
      _e.set(0, 0, rollSign * a * Math.PI * 2);
    }
    _q.setFromEuler(_e);
    hipsQuat.push(_q.x, _q.y, _q.z, _q.w);
    // Bone rotations: stay at tuckPose (with a small spine oscillation
    // for "rolling" feel).
    for (const b of BONES_TO_TUCK) {
      const p = tuckPose[b];
      const osc = 0.1 * Math.sin(a * Math.PI * 2);
      _e.set(p[0] + osc, p[1], p[2]);
      _q.setFromEuler(_e);
      boneRotations[b].push(_q.x, _q.y, _q.z, _q.w);
    }
  }

  // ── Rise phase (tuckDur + rollDur → total): uncurl, return to identity
  //    (or to prone pose if endInProne). ──
  const riseStart = tuckDur + rollDur;
  for (let i = 1; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = riseStart + a * riseDur;
    times.push(t);
    // Hips Y: -0.3 → 0 (or stays low for prone).
    const y = opts.endInProne ? -0.5 : -0.3 * (1 - a);
    hipsPos.push(translateX, y, translateZ);
    // Hips quat: identity (or face-down for prone).
    if (opts.endInProne) {
      _e.set(Math.PI / 2, 0, 0);
    } else {
      _e.set(0, 0, 0);
    }
    _q.setFromEuler(_e);
    hipsQuat.push(_q.x, _q.y, _q.z, _q.w);
    // Bone rotations: tuckPose → endPose.
    for (const b of BONES_TO_TUCK) {
      const startP = tuckPose[b];
      const endP = endPose ? endPose[b] : [0, 0, 0] as [number, number, number];
      _e.set(
        startP[0] + (endP[0] - startP[0]) * a,
        startP[1] + (endP[1] - startP[1]) * a,
        startP[2] + (endP[2] - startP[2]) * a,
      );
      _q.setFromEuler(_e);
      boneRotations[b].push(_q.x, _q.y, _q.z, _q.w);
    }
  }

  // ── Build the clip ──
  const tracks: THREE.KeyframeTrack[] = [];
  tracks.push(new THREE.VectorKeyframeTrack("Hips.position", times, hipsPos));
  tracks.push(new THREE.QuaternionKeyframeTrack("Hips.quaternion", times, hipsQuat));
  for (const b of BONES_TO_TUCK) {
    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, boneRotations[b]),
    );
  }

  return new THREE.AnimationClip(
    `landing_roll_${direction}${opts.endInProne ? "_prone" : ""}`,
    total,
    tracks,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// LandingRollDriver class
// ───────────────────────────────────────────────────────────────────────────

export class LandingRollDriver {
  private mixer: THREE.AnimationMixer;
  private ownMixer: boolean;
  private root: THREE.Object3D;
  private activeAction: THREE.AnimationAction | null = null;
  private completeCb: (() => void) | null = null;
  private disposed = false;

  constructor(root: THREE.Object3D, mixer?: THREE.AnimationMixer) {
    this.root = root;
    if (mixer) {
      this.mixer = mixer;
      this.ownMixer = false;
    } else {
      this.mixer = new THREE.AnimationMixer(root);
      this.ownMixer = true;
    }
  }

  /** Trigger a landing roll. Returns the damage-mitigation fraction the
   *  host should apply to the fall damage. */
  trigger(
    direction: RollDirection,
    forwardSpeed: number,
    opts: RollOptions = {},
  ): number {
    if (this.disposed || this.activeAction) return 0;
    const clip = buildLandingRollClip(direction, opts);
    this.activeAction = this.mixer.clipAction(clip, this.root);
    this.activeAction.setLoop(THREE.LoopOnce, 1);
    this.activeAction.clampWhenFinished = true;
    this.activeAction.reset().play();
    return computeDamageMitigation(forwardSpeed);
  }

  /** Advance the driver. Host should call this each frame. */
  tick(dt: number): void {
    if (this.disposed) return;
    if (this.ownMixer) this.mixer.update(dt);
    if (this.activeAction && !this.activeAction.isRunning()) {
      // Roll complete.
      const cb = this.completeCb;
      this.completeCb = null;
      this.mixer.uncacheAction(this.activeAction.getClip());
      this.activeAction = null;
      if (cb) cb();
    }
  }

  isRolling(): boolean {
    return this.activeAction !== null && this.activeAction.isRunning();
  }

  /** Get the remaining roll time (seconds; 0 when not rolling). */
  getRemainingSec(): number {
    if (!this.activeAction) return 0;
    const clip = this.activeAction.getClip();
    return Math.max(0, clip.duration - this.activeAction.time);
  }

  onComplete(fn: () => void): void {
    this.completeCb = fn;
  }

  cancel(): void {
    if (this.activeAction) {
      this.activeAction.stop();
      this.mixer.uncacheAction(this.activeAction.getClip());
      this.activeAction = null;
    }
    this.completeCb = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    if (this.ownMixer) this.mixer.uncacheRoot(this.root);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Direction picker
// ───────────────────────────────────────────────────────────────────────────

/** Pick the best roll direction based on the player's input intent.
 *  If no input, default to forward (most natural for fall recovery). */
export function pickRollDirection(
  inputX: number,  // strafe input (-1..1)
  inputY: number,  // forward input (-1..1; +1 = forward)
): RollDirection {
  const absX = Math.abs(inputX);
  const absY = Math.abs(inputY);
  if (absX < 0.1 && absY < 0.1) return "forward";
  if (absX > absY) return inputX > 0 ? "right" : "left";
  return inputY > 0 ? "forward" : "back";
}
