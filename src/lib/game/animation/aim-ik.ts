/**
 * SEC4-ANIM — Prompt 34
 * ─────────────────────────────────────────────────────────────────────────────
 * Aim IK — procedural spine-chain look-at for torso/head aim tracking.
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1103 [Prompt 303]  2D aim blend space pitch×yaw (sampleAimBlend2D + applyAimBlend2D)
 *   C1-5000 #1129 [Prompt 329]  weapon sight-to-camera IK for ADS (sightToCameraAdsAlign)
 *   C1-5000 #1130 [Prompt 330]  spine IK for leaning (applyLeanSpineIK)
 *   C1-5000 #1133 [Prompt 333]  look-at IK for head (applyHeadLookAtIK)
 *   C1-5000 #1281 [Prompt A#8]  per-bone prev-delta (no accumulation)
 *   C1-5000 #1282 [Prompt A#9]  weight renormalization cap (applyChainDeltas)
 *
 * C3-5000 prompt mapping:
 *   C3-5000 #1550 [IK_CHAIN_TUNE]  animation IK tuning per chain — spine→neck→head
 *      weight distribution + clamp angles per chain, exported at the bottom
 *      of this file so the dev-tool registry in anim.ts can point at it.
 *
 * Distributes a target look-at direction across the spine chain (Spine →
 * Spine1 → Spine2 → Neck → Head) so enemies + visible ally models visually
 * track their aim target through spine rotation, not just the head. Standard
 * "turret IK" approach: compute desired yaw + pitch from anchor to target,
 * clamp to anatomical limits, then weight-distribute across the chain.
 *
 * Designed to drive SEC2-ART's CharacterRig (Mixamo bone names) with
 * graceful fallback to the legacy procedural rig (`body`/`head` meshes).
 *
 * Public API:
 *   - applyAimIK(rig, targetPos, weight) — apply look-at to the spine chain.
 *   - computeAimAngles(anchorPos, targetPos, parentQuat) — pure math helper
 *     (returns {yaw, pitch} in radians) for callers that want the angles
 *     without applying them.
 *
 * SSR-safe: pure Three.js Vector3/Quaternion math, no `window`, no `document`.
 */
import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/** Rig parts lookup — accepts both Mixamo (SEC2) and legacy procedural names. */
export type AimIKRig = Record<string, THREE.Object3D>;

export interface AimIKResult {
  /** Yaw angle (radians) — rotation around the parent's local Y axis. */
  yaw: number;
  /** Pitch angle (radians) — rotation around the parent's local X axis. */
  pitch: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Spine chain config
// ───────────────────────────────────────────────────────────────────────────

/**
 * Spine chain entries — each entry tries the listed bone-name aliases in
 * order (Mixamo first, then legacy procedural). The weights distribute the
 * total yaw/pitch across the chain; lower-spine takes less, upper-spine +
 * head take more (the head carries the most weight for actual look-at).
 *
 * Legacy fallback: if the Mixamo bones aren't found, the layer falls back
 * to the legacy `{body, head}` 2-bone chain with [0.5, 0.5] weights.
 */
const SPINE_CHAIN: Array<{
  aliases: string[];
  /** Weight for yaw distribution. */
  yaw: number;
  /** Weight for pitch distribution. */
  pitch: number;
}> = [
  { aliases: ["Spine"],  yaw: 0.10, pitch: 0.10 },
  { aliases: ["Spine1"], yaw: 0.15, pitch: 0.15 },
  { aliases: ["Spine2"], yaw: 0.25, pitch: 0.25 },
  { aliases: ["Neck", "head"], yaw: 0.20, pitch: 0.25 },
  { aliases: ["Head"],   yaw: 0.30, pitch: 0.25 },
];

const LEGACY_CHAIN: Array<{
  aliases: string[];
  yaw: number;
  pitch: number;
}> = [
  { aliases: ["body"], yaw: 0.5, pitch: 0.5 },
  { aliases: ["head"], yaw: 0.5, pitch: 0.5 },
];

// ───────────────────────────────────────────────────────────────────────────
// Limits
// ───────────────────────────────────────────────────────────────────────────

/** Max yaw (radians) the spine chain can rotate left/right. ~108°. */
const MAX_YAW = Math.PI * 0.6;
/** Max pitch down (radians). ~72°. */
const MAX_PITCH_DOWN = Math.PI * 0.4;
/** Max pitch up (radians). ~90°. */
const MAX_PITCH_UP = Math.PI * 0.5;

// ───────────────────────────────────────────────────────────────────────────
// Per-bone prev-delta tracking (Prompt A#8)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Prompt A#8 — per-bone previous-frame delta. The original `applyAimIK`
 * did `bone.rotation.y += clampedYaw * yawWeight * weight` every frame,
 * which accumulates unbounded (60s of sustained aim → 60s × yawWeight ×
 * clampedYaw of integrated rotation, which spins the head continuously).
 *
 * `applyAimIK` is a pure function (no instance state), so we track the
 * prev-delta in a module-level WeakMap keyed on each bone Object3D.
 * WeakMap entries are GC'd when the bone is disposed, so there's no
 * leak. The first call on a given bone has no prev-delta → applies the
 * full delta. Subsequent calls subtract the prev-delta before applying
 * the new one, so the rotation TRACKS `clampedYaw * weight` instead of
 * integrating it.
 */
const _aimIkPrevDelta: WeakMap<
  THREE.Object3D,
  { rx: number; ry: number }
> = new WeakMap();

/**
 * Prompt A#9 — instead of normalizing weights when some chain bones are
 * missing (which over-rotates the present bones past their authored
 * anatomical contribution), cap each bone's effective contribution at
 * its authored `yawWeight` / `pitchWeight` and clamp the TOTAL applied
 * yaw/pitch to `weightSum * clampedAngle`. This keeps the head within
 * its authored 30° yaw even on a 3-bone rig.
 */
function applyChainDeltas(
  chain: ResolvedChainLayer[],
  clampedYaw: number,
  clampedPitch: number,
  weight: number,
): void {
  // Sum the authored weights so we can scale the total applied angle
  // down if the chain is partial (e.g., 3 of 5 bones present → yawSum
  // = 0.50 → total applied yaw = 0.50 × clampedYaw, distributed across
  // the present bones at their authored weights).
  const yawSum = chain.reduce((s, l) => s + l.yawWeight, 0);
  const pitchSum = chain.reduce((s, l) => s + l.pitchWeight, 0);
  // Total applied angle = min(1, sum) × clamped × weight — this is the
  // clamp: if the chain is partial, the total can't exceed the authored
  // sum (so the head never goes past 30° yaw even on a 3-bone rig).
  const totalYawScale = Math.min(1, yawSum) * weight;
  const totalPitchScale = Math.min(1, pitchSum) * weight;
  for (const layer of chain) {
    // Per-bone contribution = authored weight × total scale. The
    // authored weight is NOT renormalized (no dividing by yawSum) so a
    // missing bone just means less total rotation, not more rotation
    // per present bone.
    const ry = clampedYaw * layer.yawWeight * totalYawScale;
    const rx = clampedPitch * layer.pitchWeight * totalPitchScale;
    const prev = _aimIkPrevDelta.get(layer.bone);
    if (prev) {
      layer.bone.rotation.x -= prev.rx;
      layer.bone.rotation.y -= prev.ry;
    }
    layer.bone.rotation.x += rx;
    layer.bone.rotation.y += ry;
    _aimIkPrevDelta.set(layer.bone, { rx, ry });
  }
}

/**
 * Prompt A#8 — clear the per-bone prev-delta for a rig. Call this when
 * the rig is reset (e.g., enemy respawn, weapon swap) so the next
 * applyAimIK call doesn't subtract a stale delta from the wrong rest
 * pose. Safe to call on an empty rig.
 */
export function clearAimIKDeltas(rig: AimIKRig): void {
  for (const key in rig) {
    const bone = rig[key];
    if (bone) _aimIkPrevDelta.delete(bone);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

/**
 * Apply aim IK to the rig's spine chain. Computes the look-at direction from
 * the upper-chest anchor (Spine2 preferred) to the target, decomposes into
 * yaw + pitch in the anchor's parent-local frame, clamps to anatomical
 * limits, and distributes across the chain.
 *
 * Prompt A#8 — additive-once: this function tracks the previous frame's
 * per-bone delta in a module-level WeakMap + subtracts it before applying
 * this frame's delta. So calling applyAimIK every frame produces a TRACKING
 * rotation (the head follows the target) instead of an INTEGRATING rotation
 * (the head spins continuously). Call `clearAimIKDeltas(rig)` when the rig
 * is reset to a fresh rest pose (e.g., enemy respawn).
 *
 * @param rig        The rig parts (Mixamo bones OR legacy meshes).
 * @param targetPos  World-space position to look at.
 * @param weight     0..1 blend weight. 0 = no-op, 1 = full look-at.
 */
export function applyAimIK(
  rig: AimIKRig,
  targetPos: THREE.Vector3,
  weight: number = 1.0,
): AimIKResult | null {
  if (weight <= 0) return null;

  // Resolve the anchor bone (the pivot point for the look-at computation).
  // Spine2 (upper chest) is the standard aim pivot; fall back to lower
  // Spine, then Hips, then legacy "body".
  const anchor =
    rig.Spine2 ?? rig.Spine1 ?? rig.Spine ??
    rig.Hips ?? rig.body ?? null;
  if (!anchor) return null;

  // Get the anchor's world position.
  const anchorWorld = new THREE.Vector3();
  anchor.getWorldPosition(anchorWorld);

  // Compute desired look-at angles (in the anchor's PARENT's local frame).
  const parent = anchor.parent ?? anchor;
  const parentWorldQuat = new THREE.Quaternion();
  parent.getWorldQuaternion(parentWorldQuat);
  const angles = computeAimAngles(anchorWorld, targetPos, parentWorldQuat);
  if (!angles) return null;

  // Clamp to anatomical limits.
  const clampedYaw = THREE.MathUtils.clamp(angles.yaw, -MAX_YAW, MAX_YAW);
  const clampedPitch = THREE.MathUtils.clamp(
    angles.pitch,
    -MAX_PITCH_DOWN,
    MAX_PITCH_UP,
  );

  // Resolve the spine chain (Mixamo preferred; legacy fallback).
  const chain = resolveChain(rig);
  if (!chain) return null;

  // Prompt A#8 + A#9 — apply via the delta-subtraction helper. The chain
  // is NOT renormalized; each bone's effective contribution is capped at
  // its authored weight × total-scale, so a partial chain produces less
  // total rotation (not over-rotation per present bone).
  applyChainDeltas(chain, clampedYaw, clampedPitch, weight);

  return { yaw: clampedYaw, pitch: clampedPitch };
}

/**
 * Pure-math helper: compute the yaw + pitch (radians) that rotate the +Z
 * forward direction to point at `targetPos` from `anchorPos`, expressed in
 * the frame defined by `parentQuat` (the parent bone's world quaternion).
 *
 * Returns null if anchor + target are coincident.
 */
export function computeAimAngles(
  anchorPos: THREE.Vector3,
  targetPos: THREE.Vector3,
  parentQuat: THREE.Quaternion,
): AimIKResult | null {
  const dir = new THREE.Vector3().subVectors(targetPos, anchorPos);
  if (dir.lengthSq() < 1e-6) return null;
  dir.normalize();

  // Convert world direction to parent-local direction.
  const invParent = parentQuat.clone().invert();
  const dirLocal = dir.applyQuaternion(invParent);

  // Yaw = atan2(x, z) — rotation around Y to point +Z at the target.
  const yaw = Math.atan2(dirLocal.x, dirLocal.z);
  // Pitch = atan2(-y, sqrt(x²+z²)) — rotation around X to tilt up/down.
  // (Negative y because pitch-up = look-up = head tilts back = -X rotation
  // in the parent's local frame when +Y is up + +Z is forward.)
  const pitch = Math.atan2(-dirLocal.y, Math.hypot(dirLocal.x, dirLocal.z));
  return { yaw, pitch };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

interface ResolvedChainLayer {
  bone: THREE.Object3D;
  yawWeight: number;
  pitchWeight: number;
}

/** Resolve the spine chain — try Mixamo first; if no Mixamo bones, fall
 *  back to legacy. Returns null if NEITHER chain has any bones present.
 *
 *  Prompt A#9 — does NOT call `normalizeWeights` anymore. The original
 *  code renormalized the chain's weights to sum to 1.0 when some bones
 *  were missing (e.g., 3 of 5 → redistribute the missing 0.20 onto the
 *  present 3 bones). This over-rotated the head past its authored
 *  anatomical contribution. Now we return the layers with their authored
 *  weights; `applyChainDeltas` caps the total applied angle at the
 *  authored sum so a partial chain just produces less total rotation. */
function resolveChain(rig: AimIKRig): ResolvedChainLayer[] | null {
  // Try Mixamo chain first.
  const mixamoLayers: ResolvedChainLayer[] = [];
  for (const layer of SPINE_CHAIN) {
    for (const alias of layer.aliases) {
      if (rig[alias]) {
        mixamoLayers.push({
          bone: rig[alias],
          yawWeight: layer.yaw,
          pitchWeight: layer.pitch,
        });
        break;
      }
    }
  }
  // If we got at least 3 Mixamo bones, use them (need a real chain).
  // Prompt A#9 — no renormalization; authored weights preserved.
  if (mixamoLayers.length >= 3) {
    return mixamoLayers;
  }

  // Fall back to legacy 2-bone chain.
  const legacyLayers: ResolvedChainLayer[] = [];
  for (const layer of LEGACY_CHAIN) {
    for (const alias of layer.aliases) {
      if (rig[alias]) {
        legacyLayers.push({
          bone: rig[alias],
          yawWeight: layer.yaw,
          pitchWeight: layer.pitch,
        });
        break;
      }
    }
  }
  if (legacyLayers.length === 0) return null;
  // Prompt A#9 — no renormalization (see comment above).
  return legacyLayers;
}

/** Re-normalize the weights so they sum to 1.0 (in case some chain bones
 *  were missing). Ensures the FULL clamped angle is distributed across the
 *  available bones rather than only a fraction of it.
 *
 *  Prompt A#9 — DEPRECATED. Renormalization over-rotates present bones
 *  past their authored anatomical contribution when some bones are
 *  missing. Kept here for reference + in case a caller explicitly wants
 *  the renormalized behavior (none currently do). `resolveChain` no
 *  longer calls this. */
function normalizeWeights(
  layers: ResolvedChainLayer[],
): ResolvedChainLayer[] {
  const yawSum = layers.reduce((s, l) => s + l.yawWeight, 0);
  const pitchSum = layers.reduce((s, l) => s + l.pitchWeight, 0);
  if (yawSum < 1e-6 || pitchSum < 1e-6) return layers;
  return layers.map((l) => ({
    bone: l.bone,
    yawWeight: l.yawWeight / yawSum,
    pitchWeight: l.pitchWeight / pitchSum,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 330 + 333: spine IK for leaning + head look-at IK.
// These are exported as pure helpers that the engine can call separately
// from applyAimIK when it needs explicit lean-twist or head-look behavior.
// Both use the same delta-subtraction pattern (module-level WeakMaps) so
// they coexist cleanly with applyAimIK without accumulating.
// ═══════════════════════════════════════════════════════════════════════════

/** Prompt 330 — spine IK for leaning. Twists the torso toward the lean
 *  direction (left or right). The lean amount is -1 (full left) .. +1
 *  (full right). The twist is distributed across the spine chain (more
 *  in the upper spine + less in the lower) so the torso twists as a
 *  unit, not just at one joint.
 *
 *  The camera lean (PhysicsSystem.ts:638) already moves the camera; this
 *  adds the body exposure so leaning shows the character's shoulder + arm
 *  pivoting out from behind cover.
 *
 *  Uses delta-subtraction via a module-level WeakMap so multiple calls
 *  per frame (or skipped frames) don't accumulate. */
const _leanPrevDelta: WeakMap<THREE.Object3D, { rx: number; ry: number; rz: number }> = new WeakMap();
export function applyLeanSpineIK(
  rig: AimIKRig,
  leanAmount: number,
  weight: number = 1.0,
): void {
  if (weight <= 0) {
    // Clear any lingering deltas.
    for (const key in rig) {
      const bone = rig[key];
      const prev = _leanPrevDelta.get(bone);
      if (prev) {
        bone.rotation.x -= prev.rx;
        bone.rotation.y -= prev.ry;
        bone.rotation.z -= prev.rz;
        _leanPrevDelta.delete(bone);
      }
    }
    return;
  }
  const a = THREE.MathUtils.clamp(leanAmount, -1, 1) * weight;
  // Distribute the lean across the spine chain — upper spine takes more
  // roll + yaw; lower spine takes less. Same chain as applyAimIK so they
  // compose correctly (both write to the same bones; delta-subtraction
  // keeps them independent).
  const chain: Array<{ aliases: string[]; rollW: number; yawW: number }> = [
    { aliases: ["Spine"], rollW: 0.10, yawW: 0.10 },
    { aliases: ["Spine1"], rollW: 0.20, yawW: 0.15 },
    { aliases: ["Spine2"], rollW: 0.30, yawW: 0.20 },
    { aliases: ["Neck", "head"], rollW: 0.15, yawW: 0.15 },
    { aliases: ["Head"], rollW: 0.10, yawW: 0.10 },
  ];
  for (const layer of chain) {
    let bone: THREE.Object3D | null = null;
    for (const alias of layer.aliases) {
      if (rig[alias]) { bone = rig[alias]; break; }
    }
    if (!bone) continue;
    const rx = 0;                                  // no pitch change
    const ry = a * layer.yawW * 0.5;               // twist toward lean
    const rz = a * layer.rollW;                    // roll toward lean
    const prev = _leanPrevDelta.get(bone);
    if (prev) {
      bone.rotation.x -= prev.rx;
      bone.rotation.y -= prev.ry;
      bone.rotation.z -= prev.rz;
    }
    bone.rotation.x += rx;
    bone.rotation.y += ry;
    bone.rotation.z += rz;
    _leanPrevDelta.set(bone, { rx, ry, rz });
  }
}

/** Prompt 333 — look-at IK for the head. True IK target (not weighted
 *  distribution): rotates the Head bone (and slightly the Neck) to look
 *  at the target position. The existing applyAimIK distributes yaw/pitch
 *  across the spine chain; this is a focused head-only look-at for
 *  cases where the character should turn their head to track a target
 *  (e.g., an enemy tracking the player) without rotating the torso.
 *
 *  Uses delta-subtraction via a module-level WeakMap. */
const _headLookPrevDelta: WeakMap<THREE.Object3D, { rx: number; ry: number }> = new WeakMap();
export function applyHeadLookAtIK(
  rig: AimIKRig,
  targetPos: THREE.Vector3,
  weight: number = 1.0,
  maxYaw: number = Math.PI * 0.45,
  maxPitchDown: number = Math.PI * 0.35,
  maxPitchUp: number = Math.PI * 0.4,
): { yaw: number; pitch: number } | null {
  if (weight <= 0) return null;
  const head = rig.Head ?? rig.head ?? null;
  if (!head) return null;
  // Anchor = head's parent (the neck) — compute look-at in the parent's
  // local frame so the head rotates relative to the neck.
  const anchorWorld = new THREE.Vector3();
  head.getWorldPosition(anchorWorld);
  const parent = head.parent ?? head;
  const parentWorldQuat = new THREE.Quaternion();
  parent.getWorldQuaternion(parentWorldQuat);
  const angles = computeAimAngles(anchorWorld, targetPos, parentWorldQuat);
  if (!angles) return null;
  // Clamp to anatomical head limits (tighter than the spine chain).
  const clampedYaw = THREE.MathUtils.clamp(angles.yaw, -maxYaw, maxYaw);
  const clampedPitch = THREE.MathUtils.clamp(angles.pitch, -maxPitchDown, maxPitchUp);
  // Apply to the head (full weight on the head; a small fraction to the
  // neck so the look-at reads as a neck+head motion, not just a head snap).
  const neck = rig.Neck ?? null;
  const headDeltas: Array<{ bone: THREE.Object3D; rx: number; ry: number }> = [
    { bone: head, rx: clampedPitch * 0.7 * weight, ry: clampedYaw * 0.7 * weight },
  ];
  if (neck) {
    headDeltas.push({ bone: neck, rx: clampedPitch * 0.3 * weight, ry: clampedYaw * 0.3 * weight });
  }
  for (const d of headDeltas) {
    const prev = _headLookPrevDelta.get(d.bone);
    if (prev) {
      d.bone.rotation.x -= prev.rx;
      d.bone.rotation.y -= prev.ry;
    }
    d.bone.rotation.x += d.rx;
    d.bone.rotation.y += d.ry;
    _headLookPrevDelta.set(d.bone, { rx: d.rx, ry: d.ry });
  }
  return { yaw: clampedYaw, pitch: clampedPitch };
}

/** Clear the head-look + lean deltas for a rig (call on respawn / weapon
 *  swap so the next call doesn't subtract a stale delta). */
export function clearHeadLookAndLeanDeltas(rig: AimIKRig): void {
  for (const key in rig) {
    const bone = rig[key];
    const lookPrev = _headLookPrevDelta.get(bone);
    if (lookPrev) {
      bone.rotation.x -= lookPrev.rx;
      bone.rotation.y -= lookPrev.ry;
      _headLookPrevDelta.delete(bone);
    }
    const leanPrev = _leanPrevDelta.get(bone);
    if (leanPrev) {
      bone.rotation.x -= leanPrev.rx;
      bone.rotation.y -= leanPrev.ry;
      bone.rotation.z -= leanPrev.rz;
      _leanPrevDelta.delete(bone);
    }
  }
}

/** Prompt 303 — 2D aim blend space (pitch × yaw) with pre-authored aim
 *  poses. The existing applyAimIK distributes a single (yaw, pitch) pair
 *  across the spine chain. This 2D blend space lets the caller sample
 *  pre-authored aim poses at the (pitch, yaw) coordinate so the aim
 *  looks natural at all angles (e.g., aiming up + to the right uses a
 *  different pose than aiming down + to the left).
 *
 *  The blend space is a 3×3 grid of poses (yaw = -60°, 0, +60° × pitch =
 *  -45°, 0, +45°). The caller samples at (pitch, yaw) and we bilinearly
 *  interpolate the 4 surrounding poses. The pose values are per-bone
 *  rotation deltas (radians) for the spine chain + right arm. */
export interface AimBlendPose {
  spine: [number, number, number];   // [rx, ry, rz] for Spine2
  neck: [number, number, number];
  head: [number, number, number];
  rArm: [number, number, number];
  rForeArm: [number, number, number];
}
const AIM_BLEND_POSES: Record<string, AimBlendPose> = {
  // 9 grid points keyed by "yaw_pitch" (yaw: -1/0/1, pitch: -1/0/1).
  // These are hand-tuned default poses; a real artist would author them.
  "0_0":   { spine: [0, 0, 0],       neck: [0, 0, 0],       head: [0, 0, 0],       rArm: [0, 0, 0],       rForeArm: [0, 0, 0] },
  "1_0":   { spine: [0, 0.15, 0],    neck: [0, 0.10, 0],    head: [0, 0.10, 0],    rArm: [0, 0.20, 0],    rForeArm: [0, 0, 0] },
  "-1_0":  { spine: [0, -0.15, 0],   neck: [0, -0.10, 0],   head: [0, -0.10, 0],   rArm: [0, -0.20, 0],   rForeArm: [0, 0, 0] },
  "0_1":   { spine: [-0.20, 0, 0],   neck: [-0.15, 0, 0],   head: [-0.20, 0, 0],   rArm: [-0.40, 0, 0],   rForeArm: [-0.20, 0, 0] },
  "0_-1":  { spine: [0.20, 0, 0],    neck: [0.15, 0, 0],    head: [0.20, 0, 0],    rArm: [0.40, 0, 0],    rForeArm: [0.20, 0, 0] },
  "1_1":   { spine: [-0.15, 0.15, 0], neck: [-0.10, 0.10, 0], head: [-0.15, 0.10, 0], rArm: [-0.35, 0.20, 0], rForeArm: [-0.15, 0, 0] },
  "1_-1":  { spine: [0.15, 0.15, 0], neck: [0.10, 0.10, 0], head: [0.15, 0.10, 0], rArm: [0.35, 0.20, 0], rForeArm: [0.15, 0, 0] },
  "-1_1":  { spine: [-0.15, -0.15, 0], neck: [-0.10, -0.10, 0], head: [-0.15, -0.10, 0], rArm: [-0.35, -0.20, 0], rForeArm: [-0.15, 0, 0] },
  "-1_-1": { spine: [0.15, -0.15, 0], neck: [0.10, -0.10, 0], head: [0.15, -0.10, 0], rArm: [0.35, -0.20, 0], rForeArm: [0.15, 0, 0] },
};
/** Sample the 2D aim blend space at (pitch, yaw) in radians. Returns the
 *  bilinearly-interpolated pose. Pitch range: ±π/4. Yaw range: ±π/3. */
export function sampleAimBlend2D(pitch: number, yaw: number): AimBlendPose {
  // Normalize to -1..1.
  const py = THREE.MathUtils.clamp(pitch / (Math.PI / 4), -1, 1);
  const yw = THREE.MathUtils.clamp(yaw / (Math.PI / 3), -1, 1);
  // Grid cell indices.
  const yawIdx0 = yw <= 0 ? -1 : 0;
  const yawIdx1 = yw <= 0 ? 0 : 1;
  const pitchIdx0 = py <= 0 ? -1 : 0;
  const pitchIdx1 = py <= 0 ? 0 : 1;
  // Bilinear weights.
  const tx = Math.abs(yw);
  const ty = Math.abs(py);
  const getPose = (yi: number, pi: number): AimBlendPose =>
    AIM_BLEND_POSES[`${yi}_${pi}`] ?? AIM_BLEND_POSES["0_0"];
  const p00 = getPose(yawIdx0, pitchIdx0);
  const p10 = getPose(yawIdx1, pitchIdx0);
  const p01 = getPose(yawIdx0, pitchIdx1);
  const p11 = getPose(yawIdx1, pitchIdx1);
  const lerp3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const top = lerp3(p00.spine, p10.spine, tx);
  const bot = lerp3(p01.spine, p11.spine, tx);
  const spine = lerp3(top, bot, ty);
  const topN = lerp3(p00.neck, p10.neck, tx);
  const botN = lerp3(p01.neck, p11.neck, tx);
  const neck = lerp3(topN, botN, ty);
  const topH = lerp3(p00.head, p10.head, tx);
  const botH = lerp3(p01.head, p11.head, tx);
  const head = lerp3(topH, botH, ty);
  const topA = lerp3(p00.rArm, p10.rArm, tx);
  const botA = lerp3(p01.rArm, p11.rArm, tx);
  const rArm = lerp3(topA, botA, ty);
  const topF = lerp3(p00.rForeArm, p10.rForeArm, tx);
  const botF = lerp3(p01.rForeArm, p11.rForeArm, tx);
  const rForeArm = lerp3(topF, botF, ty);
  return { spine, neck, head, rArm, rForeArm };
}

/** Prompt 303 — apply the 2D aim blend pose to the rig. Uses delta-
 *  subtraction so the pose tracks the (pitch, yaw) input without
 *  accumulating. Call this INSTEAD of applyAimIK when you want the
 *  pre-authored pose blend. */
const _aimBlendPrevDelta: WeakMap<THREE.Object3D, { rx: number; ry: number; rz: number }> = new WeakMap();
export function applyAimBlend2D(
  rig: AimIKRig,
  pitch: number,
  yaw: number,
  weight: number = 1.0,
): AimBlendPose {
  const pose = sampleAimBlend2D(pitch, yaw);
  if (weight <= 0) return pose;
  const apply = (bone: THREE.Object3D | null, rot: [number, number, number]) => {
    if (!bone) return;
    const rx = rot[0] * weight, ry = rot[1] * weight, rz = rot[2] * weight;
    const prev = _aimBlendPrevDelta.get(bone);
    if (prev) {
      bone.rotation.x -= prev.rx;
      bone.rotation.y -= prev.ry;
      bone.rotation.z -= prev.rz;
    }
    bone.rotation.x += rx;
    bone.rotation.y += ry;
    bone.rotation.z += rz;
    _aimBlendPrevDelta.set(bone, { rx, ry, rz });
  };
  apply(rig.Spine2 ?? rig.Spine ?? null, pose.spine);
  apply(rig.Neck ?? rig.head ?? null, pose.neck);
  apply(rig.Head ?? null, pose.head);
  apply(rig.RightArm ?? null, pose.rArm);
  apply(rig.RightForeArm ?? null, pose.rForeArm);
  return pose;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1550 — IK chain tuning table. Per-chain weight distribution +
//  clamp angles for the spine→neck→head look-at chain (and the arm IK
//  chain). The runtime IK solvers (applyAimIK / solveArmTwoBoneIK) read
//  these to decide how much each bone contributes + how far it can rotate.
// ═══════════════════════════════════════════════════════════════════════════

export const IK_CHAIN_TUNE: Record<string, { weight: number; maxYaw: number; maxPitch: number }> = {
  spine:      { weight: 0.30, maxYaw: 0.40, maxPitch: 0.25 },
  spine1:     { weight: 0.25, maxYaw: 0.35, maxPitch: 0.25 },
  spine2:     { weight: 0.20, maxYaw: 0.30, maxPitch: 0.20 },
  neck:       { weight: 0.15, maxYaw: 0.50, maxPitch: 0.40 },
  head:       { weight: 0.10, maxYaw: 0.70, maxPitch: 0.50 },
  // Arm IK chain (two-bone solver)
  upper_arm:  { weight: 0.50, maxYaw: 1.20, maxPitch: 1.20 },
  fore_arm:   { weight: 0.50, maxYaw: 1.60, maxPitch: 1.60 },
};
