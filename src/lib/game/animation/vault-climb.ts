/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * VaultClimb — vaulting (low cover) + climbing/mantling (high cover) animations.
 *
 * B-prompt mapping:
 *   B-00033 / B-00035 / B-00060 / B-00079 / B-00083 / B-00088 — mantle onto
 *     crate (vault-climb for cover, crate, low wall).
 *   B-00034 / B-00052 / B-00057 / B-00059 / B-00061 — explosion knockback
 *     ragdoll (vault-climb is the recovery path back to standing).
 *   B-00011 / B-00089 — hand-on-wall contact IK (vault-climb feeds the
 *     hand-contact target).
 *
 * Design:
 *   Two distinct motion types share this module because they share the
 *   same rig-driving pattern (root translation + arm-reaching IK +
 *   leg-tuck) and trigger from the same input (jump key near cover):
 *
 *     VAULT (low cover, ≤1.2m):
 *       1. Approach  (0.0s)  — hands reach forward onto the cover top.
 *       2. Push      (0.2s)  — arms push down, body rises + legs tuck.
 *       3. Clear     (0.3s)  — body translates over the cover, legs swing
 *                              up + over.
 *       4. Land      (0.2s)  — body lands on the far side, run-out.
 *       Total: ~0.7s. Player retains forward momentum throughout.
 *
 *     MANTLE / CLIMB (high cover, 1.2-2.5m):
 *       1. Reach     (0.2s)  — hands reach up to the ledge.
 *       2. Pull-up   (0.6s)  — arms pull, body rises. Knees drive up.
 *       3. Hook      (0.3s)  — one knee hooks the ledge (asymmetric).
 *       4. Swing     (0.4s)  — body swings up + over.
 *       5. Stand     (0.3s)  — body stands on top of the cover.
 *       Total: ~1.8s. Player ends standing on the cover (or drops to
 *       the far side if the host calls .endWithDropOff()).
 *
 *   The clips drive Hips (root) position + quaternion + per-bone arm/leg
 *   rotations on the standard Mixamo rig. Hand IK targets are exposed as
 *   per-frame Vector3 tracks on dummy "LeftHandIK"/"RightHandIK" objects
 *   so the host's IK solver can read them and apply two-bone IK.
 *
 * SSR-safe: pure THREE + TS; no window/document.
 *
 * Public API:
 *   - VAULT_PARAMS / MANTLE_PARAMS — tuning constants.
 *   - classifyCoverHeight(heightM) → "vault" | "mantle" | "blocked"
 *   - buildVaultClip(opts?) → THREE.AnimationClip
 *   - buildMantleClip(opts?) → THREE.AnimationClip
 *   - class VaultClimbDriver — owns a mixer + drives the active clip.
 *   - .trigger(kind, opts?) → starts; returns true if started.
 *   - .tick(dt) → advance.
 *   - .isActive() → true during the clip.
 *   - .getHandIKTargets() → { left, right } world-space targets for IK.
 *   - .onComplete(fn) — fires when the clip ends.
 */

import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Types + tuning
// ───────────────────────────────────────────────────────────────────────────

export type CoverKind = "vault" | "mantle" | "blocked";

export const VAULT_PARAMS = {
  maxHeightM: 1.2,
  totalSec: 0.7,
  approachSec: 0.0,
  pushSec: 0.2,
  clearSec: 0.3,
  landSec: 0.2,
  /** Horizontal travel (meters) — assumes the cover is ~0.6m deep. */
  travelDistance: 1.4,
  /** Vertical peak (meters) — top of the cover + 0.1m clearance. */
  peakHeight: 1.3,
};

export const MANTLE_PARAMS = {
  minHeightM: 1.2,
  maxHeightM: 2.5,
  totalSec: 1.8,
  reachSec: 0.2,
  pullUpSec: 0.6,
  hookSec: 0.3,
  swingSec: 0.4,
  standSec: 0.3,
  /** Horizontal travel (meters). */
  travelDistance: 0.8,
};

export interface VaultOptions {
  /** Cover height (meters). Default 1.0. */
  coverHeight?: number;
  /** Override total duration. */
  duration?: number;
  /** If true, end the vault by dropping off the far side (run-out) rather
   *  than landing on top. */
  dropOff?: boolean;
}

export interface MantleOptions {
  /** Cover height (meters). Default 1.8. */
  coverHeight?: number;
  /** Override total duration. */
  duration?: number;
  /** Which leg hooks the ledge first. */
  hookLeg?: "left" | "right";
  /** If true, end standing on top of the cover. If false, drop to the far
   *  side after clearing. */
  endOnTop?: boolean;
}

/** Classify cover by height. */
export function classifyCoverHeight(heightM: number): CoverKind {
  if (heightM < 0) return "blocked";
  if (heightM <= VAULT_PARAMS.maxHeightM) return "vault";
  if (heightM <= MANTLE_PARAMS.maxHeightM) return "mantle";
  return "blocked";
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────────

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Bone set driven by both vault + mantle clips. */
const VAULT_BONES = [
  "Hips", "Spine", "Spine1", "Spine2",
  "LeftArm", "LeftForeArm", "LeftHand",
  "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot",
  "RightUpLeg", "RightLeg", "RightFoot",
];

// ───────────────────────────────────────────────────────────────────────────
// Vault clip builder
// ───────────────────────────────────────────────────────────────────────────

export function buildVaultClip(opts: VaultOptions = {}): THREE.AnimationClip {
  const P = VAULT_PARAMS;
  const total = opts.duration ?? P.totalSec;
  const coverHeight = opts.coverHeight ?? 1.0;
  const peakY = coverHeight + 0.1;

  const pushDur = (P.pushSec / P.totalSec) * total;
  const clearDur = (P.clearSec / P.totalSec) * total;
  const landDur = (P.landSec / P.totalSec) * total;

  const stepsPerPhase = 6;
  const times: number[] = [];
  const hipsPos: number[] = [];
  const hipsQuat: number[] = [];
  const boneRots: Record<string, number[]> = {};
  // IK target tracks (LeftHandIK.position / RightHandIK.position).
  const leftHandIK: number[] = [];
  const rightHandIK: number[] = [];
  for (const b of VAULT_BONES) boneRots[b] = [];

  // Helper to push a frame.
  const pushFrame = (
    t: number,
    hipPos: [number, number, number],
    hipQuatEuler: [number, number, number],
    bones: Record<string, [number, number, number]>,
    lhIK: [number, number, number],
    rhIK: [number, number, number],
  ) => {
    times.push(t);
    hipsPos.push(...hipPos);
    _e.set(...hipQuatEuler);
    _q.setFromEuler(_e);
    hipsQuat.push(_q.x, _q.y, _q.z, _q.w);
    for (const b of VAULT_BONES) {
      const p = bones[b] ?? [0, 0, 0];
      _e.set(p[0], p[1], p[2]);
      _q.setFromEuler(_e);
      boneRots[b].push(_q.x, _q.y, _q.z, _q.w);
    }
    leftHandIK.push(...lhIK);
    rightHandIK.push(...rhIK);
  };

  // ── Phase 1: Push (0 → pushDur). Hands on cover, body rises. ──
  const startBones: Record<string, [number, number, number]> = {
    Hips: [0, 0, 0],
    Spine: [0.2, 0, 0],
    Spine1: [0.1, 0, 0],
    LeftArm: [-0.6, 0, 0.4],   // arm raised forward
    LeftForeArm: [-0.8, 0, 0], // forearm bent
    RightArm: [-0.6, 0, -0.4],
    RightForeArm: [-0.8, 0, 0],
    LeftUpLeg: [-0.2, 0, 0],
    RightUpLeg: [-0.2, 0, 0],
    LeftLeg: [0.4, 0, 0],
    RightLeg: [0.4, 0, 0],
  };
  const midBones: Record<string, [number, number, number]> = {
    ...startBones,
    Hips: [0.3, 0, 0],          // body pitched forward
    LeftArm: [-1.2, 0, 0.3],    // arms straightened, hands down on cover
    LeftForeArm: [-0.2, 0, 0],
    RightArm: [-1.2, 0, -0.3],
    RightForeArm: [-0.2, 0, 0],
    LeftUpLeg: [-0.6, 0, 0],    // legs tuck
    RightUpLeg: [-0.6, 0, 0],
    LeftLeg: [1.2, 0, 0],
    RightLeg: [1.2, 0, 0],
  };
  for (let i = 0; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = a * pushDur;
    const y = a * peakY;
    const hipPos: [number, number, number] = [0, y, 0];
    const hipQuat: [number, number, number] = [0.2 * a, 0, 0];
    // Interpolate bones start → mid.
    const bones: Record<string, [number, number, number]> = {};
    for (const b of VAULT_BONES) {
      const s = startBones[b] ?? [0, 0, 0];
      const m = midBones[b] ?? [0, 0, 0];
      bones[b] = [s[0] + (m[0] - s[0]) * a, s[1] + (m[1] - s[1]) * a, s[2] + (m[2] - s[2]) * a];
    }
    // Hands reach forward to cover top.
    const handZ = a * 0.4;
    const handY = a * coverHeight;
    pushFrame(t, hipPos, hipQuat, bones, [0.15, handY, handZ], [-0.15, handY, handZ]);
  }

  // ── Phase 2: Clear (pushDur → pushDur + clearDur). Body over cover. ──
  const clearBones: Record<string, [number, number, number]> = {
    Hips: [0.5, 0, 0],   // body horizontal
    Spine: [0.3, 0, 0],
    Spine1: [0.2, 0, 0],
    LeftArm: [-1.5, 0, 0.2],   // arms pushed back
    LeftForeArm: [-0.3, 0, 0],
    RightArm: [-1.5, 0, -0.2],
    RightForeArm: [-0.3, 0, 0],
    LeftUpLeg: [-0.8, 0, 0],   // legs swing up
    RightUpLeg: [-0.8, 0, 0],
    LeftLeg: [1.4, 0, 0],
    RightLeg: [1.4, 0, 0],
  };
  for (let i = 1; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = pushDur + a * clearDur;
    // Travel forward by half the distance; peak at mid-clear.
    const z = (a * 0.5) * P.travelDistance;
    const y = peakY - 0.05 * Math.sin(a * Math.PI);
    const hipPos: [number, number, number] = [0, y, z];
    const hipQuat: [number, number, number] = [0.5, 0, 0];
    // Interpolate mid → clear.
    const bones: Record<string, [number, number, number]> = {};
    for (const b of VAULT_BONES) {
      const m = midBones[b] ?? [0, 0, 0];
      const c = clearBones[b] ?? [0, 0, 0];
      bones[b] = [m[0] + (c[0] - m[0]) * a, m[1] + (c[1] - m[1]) * a, m[2] + (c[2] - m[2]) * a];
    }
    // Hands trail behind.
    pushFrame(t, hipPos, hipQuat, bones, [0.1, y - 0.2, z - 0.1], [-0.1, y - 0.2, z - 0.1]);
  }

  // ── Phase 3: Land (pushDur + clearDur → total). Drop to far side or stand. ──
  const landBones: Record<string, [number, number, number]> = {
    Hips: [0.1, 0, 0],
    Spine: [0.1, 0, 0],
    LeftArm: [-0.3, 0, 0.2],
    RightArm: [-0.3, 0, -0.2],
    LeftUpLeg: [-0.1, 0, 0],
    RightUpLeg: [-0.1, 0, 0],
    LeftLeg: [0.2, 0, 0],
    RightLeg: [0.2, 0, 0],
  };
  for (let i = 1; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = pushDur + clearDur + a * landDur;
    const z = (0.5 + a * 0.5) * P.travelDistance;
    const y = opts.dropOff
      ? peakY - a * peakY  // drop to ground
      : peakY - 0.05 * (1 - Math.sin(a * Math.PI * 0.5));  // settle on top
    const hipPos: [number, number, number] = [0, y, z];
    const hipQuat: [number, number, number] = [0.5 - 0.4 * a, 0, 0];
    const bones: Record<string, [number, number, number]> = {};
    for (const b of VAULT_BONES) {
      const c = clearBones[b] ?? [0, 0, 0];
      const l = landBones[b] ?? [0, 0, 0];
      bones[b] = [c[0] + (l[0] - c[0]) * a, c[1] + (l[1] - c[1]) * a, c[2] + (l[2] - c[2]) * a];
    }
    pushFrame(t, hipPos, hipQuat, bones, [0.1, y, z], [-0.1, y, z]);
  }

  // Build tracks.
  const tracks: THREE.KeyframeTrack[] = [
    new THREE.VectorKeyframeTrack("Hips.position", times, hipsPos),
    new THREE.QuaternionKeyframeTrack("Hips.quaternion", times, hipsQuat),
    new THREE.VectorKeyframeTrack("LeftHandIK.position", times, leftHandIK),
    new THREE.VectorKeyframeTrack("RightHandIK.position", times, rightHandIK),
  ];
  for (const b of VAULT_BONES) {
    if (b === "Hips") continue;
    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, boneRots[b]),
    );
  }
  return new THREE.AnimationClip("vault", total, tracks);
}

// ───────────────────────────────────────────────────────────────────────────
// Mantle clip builder
// ───────────────────────────────────────────────────────────────────────────

export function buildMantleClip(opts: MantleOptions = {}): THREE.AnimationClip {
  const P = MANTLE_PARAMS;
  const total = opts.duration ?? P.totalSec;
  const coverHeight = opts.coverHeight ?? 1.8;
  const hookLeg = opts.hookLeg ?? "right";

  const reachDur = (P.reachSec / P.totalSec) * total;
  const pullUpDur = (P.pullUpSec / P.totalSec) * total;
  const hookDur = (P.hookSec / P.totalSec) * total;
  const swingDur = (P.swingSec / P.totalSec) * total;
  const standDur = (P.standSec / P.totalSec) * total;

  const stepsPerPhase = 6;
  const times: number[] = [];
  const hipsPos: number[] = [];
  const hipsQuat: number[] = [];
  const boneRots: Record<string, number[]> = {};
  const leftHandIK: number[] = [];
  const rightHandIK: number[] = [];
  for (const b of VAULT_BONES) boneRots[b] = [];

  const pushFrame = (
    t: number,
    hipPos: [number, number, number],
    hipQuatEuler: [number, number, number],
    bones: Record<string, [number, number, number]>,
    lhIK: [number, number, number],
    rhIK: [number, number, number],
  ) => {
    times.push(t);
    hipsPos.push(...hipPos);
    _e.set(...hipQuatEuler);
    _q.setFromEuler(_e);
    hipsQuat.push(_q.x, _q.y, _q.z, _q.w);
    for (const b of VAULT_BONES) {
      const p = bones[b] ?? [0, 0, 0];
      _e.set(p[0], p[1], p[2]);
      _q.setFromEuler(_e);
      boneRots[b].push(_q.x, _q.y, _q.z, _q.w);
    }
    leftHandIK.push(...lhIK);
    rightHandIK.push(...rhIK);
  };

  // ── Reach phase: arms reach up to ledge. ──
  for (let i = 0; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = a * reachDur;
    const y = a * 0.3;
    pushFrame(
      t,
      [0, y, 0],
      [0.1 * a, 0, 0],
      {
        Hips: [0.1 * a, 0, 0],
        Spine: [0.1 * a, 0, 0],
        LeftArm: [-0.5 * a, 0, 0.3],
        RightArm: [-0.5 * a, 0, -0.3],
        LeftForeArm: [-0.3 * a, 0, 0],
        RightForeArm: [-0.3 * a, 0, 0],
        LeftUpLeg: [-0.1 * a, 0, 0],
        RightUpLeg: [-0.1 * a, 0, 0],
      },
      [0.15, a * coverHeight, a * 0.3],
      [-0.15, a * coverHeight, a * 0.3],
    );
  }

  // ── Pull-up phase: body rises to ledge height. ──
  for (let i = 1; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = reachDur + a * pullUpDur;
    const y = 0.3 + a * (coverHeight - 0.3 - 0.2);  // rise to just below ledge
    pushFrame(
      t,
      [0, y, 0],
      [0.3, 0, 0],
      {
        Hips: [0.3, 0, 0],
        Spine: [0.3, 0, 0],
        Spine1: [0.2, 0, 0],
        LeftArm: [-1.4, 0, 0.3],   // arms fully extended up
        RightArm: [-1.4, 0, -0.3],
        LeftForeArm: [-0.1, 0, 0],
        RightForeArm: [-0.1, 0, 0],
        LeftUpLeg: [-0.5, 0, 0],   // knees drive up
        RightUpLeg: [-0.5, 0, 0],
        LeftLeg: [1.0, 0, 0],
        RightLeg: [1.0, 0, 0],
      },
      [0.15, coverHeight, 0.3],
      [-0.15, coverHeight, 0.3],
    );
  }

  // ── Hook phase: one knee hooks the ledge. ──
  const hookLegName = hookLeg === "left" ? "LeftLeg" : "RightLeg";
  const otherLegName = hookLeg === "left" ? "RightLeg" : "LeftLeg";
  const hookUpLeg = hookLeg === "left" ? "LeftUpLeg" : "RightUpLeg";
  const otherUpLeg = hookLeg === "left" ? "RightUpLeg" : "LeftUpLeg";
  for (let i = 1; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = reachDur + pullUpDur + a * hookDur;
    const y = coverHeight - 0.2 + a * 0.2;
    const bones: Record<string, [number, number, number]> = {
      Hips: [0.4 - 0.1 * a, 0, 0],
      Spine: [0.3 - 0.1 * a, 0, 0],
      LeftArm: [-1.4 + 0.3 * a, 0, 0.3],
      RightArm: [-1.4 + 0.3 * a, 0, -0.3],
      LeftForeArm: [-0.1, 0, 0],
      RightForeArm: [-0.1, 0, 0],
    };
    // Hook leg swings up + over.
    bones[hookUpLeg] = [-1.0 - 0.3 * a, 0, 0];
    bones[hookLegName] = [1.4 - 1.0 * a, 0, 0];
    // Other leg dangles.
    bones[otherUpLeg] = [-0.3, 0, 0];
    bones[otherLegName] = [0.6, 0, 0];
    pushFrame(t, [0, y, 0], [0.3 - 0.1 * a, 0, 0], bones, [0.15, coverHeight + 0.1, 0.3], [-0.15, coverHeight + 0.1, 0.3]);
  }

  // ── Swing phase: body rotates over the ledge. ──
  for (let i = 1; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = reachDur + pullUpDur + hookDur + a * swingDur;
    const y = coverHeight + 0.1;
    const z = a * 0.4;
    pushFrame(
      t,
      [0, y, z],
      [0.2 - 0.5 * a, 0, 0],
      {
        Hips: [0.3 - 0.5 * a, 0, 0],
        Spine: [0.2 - 0.3 * a, 0, 0],
        LeftArm: [-1.1 + 0.8 * a, 0, 0.3],
        RightArm: [-1.1 + 0.8 * a, 0, -0.3],
        LeftForeArm: [-0.1 + 0.3 * a, 0, 0],
        RightForeArm: [-0.1 + 0.3 * a, 0, 0],
        LeftUpLeg: [-1.3 + 1.1 * a, 0, 0],
        RightUpLeg: [-1.3 + 1.1 * a, 0, 0],
        LeftLeg: [0.4 + 0.1 * a, 0, 0],
        RightLeg: [0.4 + 0.1 * a, 0, 0],
      },
      [0.15, coverHeight + 0.1, z],
      [-0.15, coverHeight + 0.1, z],
    );
  }

  // ── Stand phase: body upright on top (or drops to far side). ──
  for (let i = 1; i <= stepsPerPhase; i++) {
    const a = i / stepsPerPhase;
    const t = reachDur + pullUpDur + hookDur + swingDur + a * standDur;
    const y = opts.endOnTop === false ? coverHeight - a * coverHeight : coverHeight + 0.1;
    const z = 0.4 + (opts.endOnTop === false ? a * 0.6 : 0);
    pushFrame(
      t,
      [0, y, z],
      [-0.3 + 0.3 * a, 0, 0],
      {
        Hips: [-0.3 + 0.3 * a, 0, 0],
        Spine: [-0.1 + 0.1 * a, 0, 0],
        LeftArm: [-0.3 + 0.3 * a, 0, 0.2],
        RightArm: [-0.3 + 0.3 * a, 0, -0.2],
        LeftForeArm: [0.2 - 0.2 * a, 0, 0],
        RightForeArm: [0.2 - 0.2 * a, 0, 0],
        LeftUpLeg: [-0.2 + 0.2 * a, 0, 0],
        RightUpLeg: [-0.2 + 0.2 * a, 0, 0],
        LeftLeg: [0.5 - 0.5 * a, 0, 0],
        RightLeg: [0.5 - 0.5 * a, 0, 0],
      },
      [0.15, y + 0.5, z],
      [-0.15, y + 0.5, z],
    );
  }

  const tracks: THREE.KeyframeTrack[] = [
    new THREE.VectorKeyframeTrack("Hips.position", times, hipsPos),
    new THREE.QuaternionKeyframeTrack("Hips.quaternion", times, hipsQuat),
    new THREE.VectorKeyframeTrack("LeftHandIK.position", times, leftHandIK),
    new THREE.VectorKeyframeTrack("RightHandIK.position", times, rightHandIK),
  ];
  for (const b of VAULT_BONES) {
    if (b === "Hips") continue;
    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, boneRots[b]),
    );
  }
  return new THREE.AnimationClip("mantle", total, tracks);
}

// ───────────────────────────────────────────────────────────────────────────
// VaultClimbDriver class
// ───────────────────────────────────────────────────────────────────────────

export class VaultClimbDriver {
  private mixer: THREE.AnimationMixer;
  private ownMixer: boolean;
  private root: THREE.Object3D;
  private activeAction: THREE.AnimationAction | null = null;
  private kind: CoverKind | null = null;
  private completeCb: (() => void) | null = null;
  private disposed = false;
  // Hand IK target Object3Ds (created lazily; bound to the clip's IK tracks).
  private leftHandIK = new THREE.Object3D();
  private rightHandIK = new THREE.Object3D();

  constructor(root: THREE.Object3D, mixer?: THREE.AnimationMixer) {
    this.root = root;
    if (mixer) {
      this.mixer = mixer;
      this.ownMixer = false;
    } else {
      this.mixer = new THREE.AnimationMixer(root);
      this.ownMixer = true;
    }
    // Add IK target objects as children of the root (named to match clip tracks).
    this.leftHandIK.name = "LeftHandIK";
    this.rightHandIK.name = "RightHandIK";
    root.add(this.leftHandIK);
    root.add(this.rightHandIK);
  }

  /** Trigger a vault or mantle. Returns true if started; false if the
   *  driver is busy or the kind is "blocked". */
  trigger(kind: CoverKind, opts: VaultOptions | MantleOptions = {}): boolean {
    if (this.disposed || this.activeAction) return false;
    if (kind === "blocked") return false;
    this.kind = kind;
    const clip = kind === "vault"
      ? buildVaultClip(opts as VaultOptions)
      : buildMantleClip(opts as MantleOptions);
    this.activeAction = this.mixer.clipAction(clip, this.root);
    this.activeAction.setLoop(THREE.LoopOnce, 1);
    this.activeAction.clampWhenFinished = true;
    this.activeAction.reset().play();
    return true;
  }

  /** Advance the driver. */
  tick(dt: number): void {
    if (this.disposed) return;
    if (this.ownMixer) this.mixer.update(dt);
    if (this.activeAction && !this.activeAction.isRunning()) {
      const cb = this.completeCb;
      this.completeCb = null;
      this.mixer.uncacheAction(this.activeAction.getClip());
      this.activeAction = null;
      this.kind = null;
      if (cb) cb();
    }
  }

  isActive(): boolean {
    return this.activeAction !== null && this.activeAction.isRunning();
  }

  getKind(): CoverKind | null {
    return this.kind;
  }

  /** Get the current world-space hand IK targets (for the host's two-bone
   *  IK solver to track). Updated each tick(). */
  getHandIKTargets(): { left: THREE.Vector3; right: THREE.Vector3 } {
    return {
      left: this.leftHandIK.getWorldPosition(new THREE.Vector3()),
      right: this.rightHandIK.getWorldPosition(new THREE.Vector3()),
    };
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
    this.kind = null;
    this.completeCb = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.root.remove(this.leftHandIK);
    this.root.remove(this.rightHandIK);
    if (this.ownMixer) this.mixer.uncacheRoot(this.root);
  }
}
