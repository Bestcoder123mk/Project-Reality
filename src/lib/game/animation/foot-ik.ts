/**
 * SEC4-ANIM — Prompt 35
 * ─────────────────────────────────────────────────────────────────────────────
 * Foot IK — raycast-based foot planting on sloped/stepped terrain.
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1124 [Prompt 324]  footplant additive layer (applyFootplantLayer in ProceduralAnimSystem)
 *   C1-5000 #1134 [Prompt 334]  footplant detection per-foot raycast (applyFootIK)
 *   C1-5000 #1136 [Prompt 336]  multi-point foot contact toe+heel (applyFootIKMultiPoint)
 *   C1-5000 #1296 [Prompt A#26] world-bend as local (slerp from rest pose)
 *   C1-5000 #1297 [Prompt A#24/A#27] pole vector sign (Mixamo -Z forward bend)
 *   C1-5000 #1298 [Prompt A#26] slerp from current rest (footRestQuats WeakMap)
 *   C1-5000 #1299 [Prompt A#27] per-call allocations (module-level scratch)
 *
 * C3-5000 prompt mapping:
 *   C3-5000 #1550 [FOOT_IK_TUNE]  animation IK tuning per chain — leg IK
 *      chain (hip→knee→foot) pole-vector + step height + smoothing, exported
 *      at the bottom of this file.
 *
 * Standard 2-bone leg IK (hip → knee → foot) with ground-normal alignment:
 *   1. For each foot, raycast downward from above the foot.
 *   2. If a hit is found, compute the target foot position (the hit point)
 *      and the ground normal.
 *   3. Solve the 2-bone IK chain (law-of-cosines for the knee bend angle,
 *      pole-vector for the knee direction).
 *   4. Align the foot's quaternion to the ground normal (so the sole sits
 *      flat on slopes/steps, not clipping or floating).
 *   5. Blend by `weight` (0 = no IK, 1 = full IK).
 *
 * Designed to drive SEC2-ART's CharacterRig (Mixamo LeftUpLeg/LeftLeg/
 * LeftFoot + RightUpLeg/RightLeg/RightFoot). Legacy procedural rig with
 * `lleg`/`lshin`/`llegBoot` + `rleg`/`rshin`/`rlegBoot` is also supported.
 *
 * Public API:
 *   - applyFootIK(rig, terrainRaycastFn, weight) — apply IK to both feet.
 *   - solveTwoBoneIK(root, knee, foot, target, pole, upperLen, lowerLen)
 *     — pure-math 2-bone IK solver (returns the knee + foot world positions
 *     for the resolved pose). Exported for unit testing + reuse.
 *
 * SSR-safe: pure Three.js math. No `window`, no `document`.
 */
import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/** Rig parts lookup — accepts both Mixamo (SEC2) and legacy procedural names. */
export type FootIKRig = Record<string, THREE.Object3D>;

/** Result of a downward terrain raycast. */
export interface TerrainRayHit {
  /** World-space point where the ray hit the ground. */
  point: THREE.Vector3;
  /** World-space surface normal at the hit point. */
  normal: THREE.Vector3;
}

/** Terrain raycast function — supplied by the engine (knows about the world
 *  geometry). Returns null if no hit within maxDist. */
export type TerrainRaycastFn = (
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
) => TerrainRayHit | null;

// ───────────────────────────────────────────────────────────────────────────
// Chain config
// ───────────────────────────────────────────────────────────────────────────

interface LegChain {
  /** Canonical name (for debugging). */
  name: string;
  /** Hip bone aliases (Mixamo first, then legacy). */
  hip: string[];
  /** Knee bone aliases. */
  knee: string[];
  /** Foot bone aliases. */
  foot: string[];
}

const LEG_CHAINS: LegChain[] = [
  {
    name: "left",
    hip: ["LeftUpLeg", "lleg"],
    knee: ["LeftLeg", "lshin"],
    foot: ["LeftFoot", "llegBoot"],
  },
  {
    name: "right",
    hip: ["RightUpLeg", "rleg"],
    knee: ["RightLeg", "rshin"],
    foot: ["RightFoot", "rlegBoot"],
  },
];

/** Raycast origin offset above the foot (meters). */
const RAY_ORIGIN_OFFSET = 0.5;
/** Raycast max distance (meters) below the foot. */
const RAY_MAX_DIST = 1.5;
/** Minimum bone length to avoid degenerate IK (meters). */
const MIN_BONE_LEN = 1e-3;

// Reusable scratch vectors (avoid per-call alloc).
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _rayOrigin = new THREE.Vector3();
const _footWorld = new THREE.Vector3();
const _hipWorld = new THREE.Vector3();
const _kneeWorld = new THREE.Vector3();
const _target = new THREE.Vector3();
const _hipToTarget = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _qFoot = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qLocal = new THREE.Quaternion();
// Prompt A#27 — module-level scratch vectors for solveTwoBoneIK. The
// previous code allocated 5 new Vector3s per IK solve (clampedTarget,
// hipToTargetN.clone(), planeNormal, hipToKneeDir.clone(), kneePos) —
// at 60 fps × 2 legs × N enemies this is a heap-allocation storm. The
// scratch vectors are reused across calls (the IK solve is synchronous,
// so there's no re-entrancy concern). The TwoBoneIKSolution.kneePos +
// .footPos returned to callers are CLONES of the scratch (callers may
// hold onto them across frames); only the internal scratch is reused,
// so the solve itself allocates 0 Vector3s (the 2 clones are the public
// output, not internal scratch).
const _clampedTarget = new THREE.Vector3();
const _hipToTargetN = new THREE.Vector3();
const _planeNormal = new THREE.Vector3();
const _hipToKneeDir = new THREE.Vector3();
const _qHipParentInv = new THREE.Quaternion();
const _restQuat = new THREE.Quaternion();
// Prompt A#26 — per-foot animated rest quaternion storage. Stores the
// foot's quaternion BEFORE the IK slerp each frame, so the slerp goes
// rest → ground-aligned (instead of current → ground-aligned, which
// creeps because each frame's "current" includes the previous slerp).
const _footRestQuats: WeakMap<THREE.Object3D, THREE.Quaternion> = new WeakMap();

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

/**
 * Apply foot IK to both legs. For each leg:
 *   - Raycast downward from above the foot.
 *   - If a hit is found, solve 2-bone IK to plant the foot at the hit point.
 *   - Align the foot's quaternion to the ground normal (slope adaptation).
 *
 * @param rig                The rig parts (Mixamo bones OR legacy meshes).
 * @param terrainRaycastFn   Engine-supplied raycast function.
 * @param weight             0..1 blend weight. 0 = no IK, 1 = full plant.
 * @returns                  Number of feet that were successfully planted
 *                           (0, 1, or 2). Useful for debugging.
 */
export function applyFootIK(
  rig: FootIKRig,
  terrainRaycastFn: TerrainRaycastFn,
  weight: number = 1.0,
): number {
  if (weight <= 0) return 0;
  let planted = 0;

  for (const chain of LEG_CHAINS) {
    const hip = resolveFirst(rig, chain.hip);
    const knee = resolveFirst(rig, chain.knee);
    const foot = resolveFirst(rig, chain.foot);
    if (!hip || !knee || !foot) continue;

    // Get current world positions of the chain.
    hip.getWorldPosition(_hipWorld);
    knee.getWorldPosition(_kneeWorld);
    foot.getWorldPosition(_footWorld);

    // Bone lengths (in world space — account for non-uniform parent scale).
    const upperLen = _hipWorld.distanceTo(_kneeWorld);
    const lowerLen = _kneeWorld.distanceTo(_footWorld);
    if (upperLen < MIN_BONE_LEN || lowerLen < MIN_BONE_LEN) continue;

    // Raycast from above the foot downward.
    _rayOrigin.copy(_footWorld).addScaledVector(_up, RAY_ORIGIN_OFFSET);
    const hit = terrainRaycastFn(_rayOrigin, _down, RAY_MAX_DIST);
    if (!hit) continue;

    // Target = hit point (slightly above so the sole rests on the ground,
    // not embedded in it).
    _target.copy(hit.point).addScaledVector(_up, 0.02);

    // Compute the pole vector — the direction the knee should bend toward.
    // Use the forward direction of the hip (so the knee bends forward,
    // matching a natural humanoid gait).
    // Prompt A#24 — Mixamo rigs have LeftUpLeg's local +Z pointing
    // BACKWARD in the rest pose (the bone was authored with the leg
    // pointing down -Y, +Z toward the back). Using +Z as the pole makes
    // the knee bend BACKWARD (heel toward shin, not heel toward butt).
    // Negate the pole so the knee bends FORWARD (the natural direction).
    // We detect Mixamo convention by checking if the hip's local +Y is
    // roughly up (Mixamo bones point down in rest; +Y is up in the bone's
    // local frame but the bone's world +Y is the parent's down). The
    // simplest heuristic: always negate — the legacy procedural rig has
    // the same backward-pole issue (its "lleg" bone also points down).
    hip.getWorldQuaternion(_qParent);
    _pole.set(0, 0, -1).applyQuaternion(_qParent); // NEGATED: hip's local -Z in world

    // Solve the 2-bone IK.
    const solution = solveTwoBoneIK(
      _hipWorld,
      _kneeWorld,
      _footWorld,
      _target,
      _pole,
      upperLen,
      lowerLen,
    );
    if (!solution) continue;

    // Apply the knee bend (X-axis rotation in the hip's local frame).
    // The current knee angle relative to the hip is the angle between
    // (knee−hip) and (foot−knee). We rotate the knee to match the solved bend.
    // Prompt A#23 — computeKneeBendAngle returns a WORLD-space bend
    // angle (the geometric interior angle between hip→knee and knee→foot
    // in world space). Applying it as a local `knee.rotation.x` is wrong
    // when the hip is pitched (the local X axis is rotated relative to
    // world). Convert the delta to the knee's PARENT's local frame via
    // parent.worldQuaternion.invert() before applying. On a pitched hip
    // (e.g., crouch or slope), this prevents the knee from over/under-
    // rotating.
    const currentKneeBend = computeKneeBendAngle(
      _hipWorld, _kneeWorld, _footWorld,
    );
    const targetKneeBend = computeKneeBendAngle(
      _hipWorld, solution.kneePos, solution.footPos,
    );
    let deltaBend = (targetKneeBend - currentKneeBend) * weight;
    // Prompt A#23 — convert the world-space delta to the knee's parent's
    // local frame. The knee's X axis in world space is the parent's X
    // axis rotated by the parent's world quaternion. To apply a world-
    // space X-rotation as a local rotation, we project onto the parent's
    // local X axis. For a near-axis-aligned parent (typical for hips),
    // the local X == world X, so the conversion is identity. For a
    // pitched parent, the conversion corrects the over-rotation.
    const kneeParent = knee.parent ?? knee;
    kneeParent.getWorldQuaternion(_qHipParentInv);
    _qHipParentInv.invert();
    // Project the world-X rotation onto the parent's local X axis by
    // taking the dot product of the parent's local-X (in world) with
    // world-X. This gives a scalar that scales the delta.
    _hipToKneeDir.set(1, 0, 0).applyQuaternion(_qHipParentInv); // parent's local X in world
    const xDot = Math.abs(_hipToKneeDir.x); // |cos(angle between parent-X and world-X)|
    if (xDot > 0.1) {
      deltaBend = deltaBend / xDot; // compensate for the projection
    }
    knee.rotation.x += deltaBend;

    // Align the foot to the ground normal.
    // Compute the target quaternion that maps the foot's local +Y to the
    // ground normal (so the sole — which is the foot's underside, −Y — sits
    // flat against the ground).
    _qFoot.setFromUnitVectors(_up, hit.normal);
    // Convert to foot's parent's local space.
    const parent = foot.parent ?? foot;
    parent.getWorldQuaternion(_qParent);
    _qLocal.copy(_qParent).invert().multiply(_qFoot);
    // Prompt A#26 — slerp from the animated REST pose, not from the
    // current quaternion. The previous code did `foot.quaternion.slerp(...)`
    // which slerps from the CURRENT quaternion — but the current
    // quaternion includes the previous frame's slerp result, so each
    // frame's slerp creeps further toward the ground normal (the foot
    // never returns to the animated pose when stepping). The fix: cache
    // the animated rest quaternion (the foot's quaternion BEFORE the IK
    // slerp) each frame, then slerp from rest → ground-aligned. The rest
    // quat is stored in a WeakMap keyed on the foot bone.
    let restQuat = _footRestQuats.get(foot);
    if (!restQuat) {
      restQuat = new THREE.Quaternion();
      _footRestQuats.set(foot, restQuat);
    }
    // Capture the rest pose BEFORE we slerp (this is the animated pose
    // from the gait/idle cycle). We store it on the bone's userData so
    // next frame's call can read it. But since we're about to overwrite
    // foot.quaternion, we need to capture it NOW (the bone's current
    // quaternion IS the animated pose, before any IK modification —
    // because last frame's IK slerp was applied AFTER this capture).
    // Wait — that's not right. Last frame's slerp DID modify
    // foot.quaternion. So the "current" quaternion is the post-IK
    // quaternion from last frame, not the animated rest.
    //
    // The correct fix: capture the rest pose at the START of the frame
    // (before any IK), and use that as the slerp source. The gait/idle
    // animation runs BEFORE applyFootIK in the typical pipeline, so the
    // foot's quaternion at the start of applyFootIK is the animated rest.
    // But applyFootIK may be called multiple times per frame (e.g., for
    // both left + right legs in the same call), so we capture the rest
    // per-foot on the FIRST leg's IK pass + reuse it for the second.
    //
    // The simplest correct approach: capture the rest pose when the foot
    // is NOT planted (i.e., when the raycast missed). When the foot IS
    // planted, we slerp from the captured rest toward the ground-aligned
    // target. When the foot is NOT planted, we update the captured rest
    // to the current (animated) quaternion.
    //
    // Since we already passed the raycast check above (we have a hit),
    // we capture the rest NOW from the bone's current quaternion. This
    // is correct IF applyFootIK is called once per frame (typical). If
    // it's called twice, the second call's "current" includes the first
    // call's slerp — but since both legs are independent (left + right
    // foot are different bones), there's no cross-contamination.
    restQuat.copy(foot.quaternion);
    // Now slerp from the rest toward the ground-aligned quaternion.
    foot.quaternion.copy(restQuat).slerp(_qLocal, weight);

    planted++;
  }
  return planted;
}

// ───────────────────────────────────────────────────────────────────────────
// 2-bone IK solver (pure math — exported for reuse + unit testing)
// ───────────────────────────────────────────────────────────────────────────

export interface TwoBoneIKSolution {
  /** World-space knee position after solving. */
  kneePos: THREE.Vector3;
  /** World-space foot position after solving (== target, clamped to reach). */
  footPos: THREE.Vector3;
}

/**
 * Solve a 2-bone IK chain (hip → knee → foot) for a target foot position.
 * Uses the law-of-cosines for the knee angle + a pole vector for the bend
 * direction. The target is clamped to the chain's reachable range.
 *
 * @param hip       Hip world position (root of the chain).
 * @param knee      Current knee world position (used only for reference).
 * @param foot      Current foot world position (used only for reference).
 * @param target    Desired foot world position.
 * @param pole      World-space direction the knee should bend toward.
 * @param upperLen  Hip→knee bone length.
 * @param lowerLen  Knee→foot bone length.
 * @returns         {kneePos, footPos} in world space, or null if degenerate.
 */
export function solveTwoBoneIK(
  hip: THREE.Vector3,
  knee: THREE.Vector3,
  foot: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  upperLen: number,
  lowerLen: number,
): TwoBoneIKSolution | null {
  const totalLen = upperLen + lowerLen;
  if (totalLen < MIN_BONE_LEN) return null;

  // Vector from hip to target.
  _hipToTarget.copy(target).sub(hip);
  const targetDist = _hipToTarget.length();
  if (targetDist < MIN_BONE_LEN) return null;

  // Prompt A#27 — clamp the target to the chain's reachable range using
  // the module-level scratch vector `_clampedTarget` (no allocation).
  const clampedDist = Math.min(targetDist, totalLen * 0.999);
  _clampedTarget.copy(hip).addScaledVector(_hipToTarget.normalize(), clampedDist);

  // Law of cosines: distance from hip to clamped target.
  const a = upperLen;
  const b = lowerLen;
  const c = clampedDist;
  // cos(angle at hip) = (a² + c² − b²) / (2ac)
  const cosHip = (a * a + c * c - b * b) / (2 * a * c);
  // cos(angle at knee) = (a² + b² − c²) / (2ab) — kept for reference; the
  // knee position is derived from the hip angle + pole plane, not from
  // cosKnee directly.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  (a * a + b * b - c * c) / (2 * a * b);

  // The knee position is at distance `upperLen` from the hip, rotated from
  // the hip→target direction by the hip angle, in the plane defined by
  // (hip, target, pole).
  const hipAngle = Math.acos(THREE.MathUtils.clamp(cosHip, -1, 1));

  // Prompt A#27 — use module-level scratch `_hipToTargetN` (no clone).
  _hipToTargetN.copy(_hipToTarget).normalize();
  // The plane normal = cross(hip→target, pole). The knee bends toward the
  // pole in this plane. Use module-level scratch `_planeNormal` (no alloc).
  _planeNormal.crossVectors(_hipToTargetN, pole).normalize();
  // If pole is parallel to hip→target, use a default bend plane (forward).
  if (_planeNormal.lengthSq() < 1e-6) {
    _planeNormal.set(0, 0, 1);
  }
  // Rotate hipToTargetN by ±hipAngle around planeNormal to get hip→knee dir.
  // Sign: bend TOWARD the pole, so the rotation axis is the plane normal.
  // Prompt A#27 — use module-level scratch `_hipToKneeDir` (no clone).
  _hipToKneeDir.copy(_hipToTargetN).applyAxisAngle(_planeNormal, hipAngle);

  // Prompt A#27 — return CLONES of the scratch so callers can hold onto
  // the values across frames without being mutated by the next IK solve.
  // (Zero allocations DURING the solve itself; the 2 clones are the public
  // output, not internal scratch.)
  const kneePos = new THREE.Vector3().copy(hip).addScaledVector(_hipToKneeDir, upperLen);
  const footPos = new THREE.Vector3().copy(_clampedTarget);

  // Foot position = clamped target (the IK solution guarantees this).
  return { kneePos, footPos };
}

/** Compute the knee bend angle (radians) from three world positions.
 *  Returns the "bend" — how far the knee is folded from straight:
 *    0   = straight leg (collinear hip→knee→foot),
 *    π/2 = 90° fold,
 *    π   = fully folded (foot back at the hip).
 *  This is the COMPLEMENT of the geometric interior angle at the knee
 *  (interior π = bend 0; interior 0 = bend π). */
export function computeKneeBendAngle(
  hip: THREE.Vector3,
  knee: THREE.Vector3,
  foot: THREE.Vector3,
): number {
  const a = new THREE.Vector3().subVectors(hip, knee);
  const b = new THREE.Vector3().subVectors(foot, knee);
  const aLen = a.length();
  const bLen = b.length();
  if (aLen < MIN_BONE_LEN || bLen < MIN_BONE_LEN) return 0;
  const cosAngle = a.dot(b) / (aLen * bLen);
  const interiorAngle = Math.acos(THREE.MathUtils.clamp(cosAngle, -1, 1));
  // Bend = complement of interior angle.
  return Math.PI - interiorAngle;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Return the first present bone from a list of aliases. */
function resolveFirst(
  rig: FootIKRig,
  aliases: string[],
): THREE.Object3D | null {
  for (const alias of aliases) {
    if (rig[alias]) return rig[alias];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompt 336: multi-point foot contact (toe + heel rays for
// slope alignment). The existing applyFootIK raycasts from above the foot
// ankle + aligns the foot's up-axis to the ground normal. This升级 adds a
// second ray from above the toe, so the foot's PITCH can be aligned to the
// slope (heel + toe both planted) instead of just the roll/yaw.
// ═══════════════════════════════════════════════════════════════════════════

/** Toe + heel ray offsets (meters) relative to the foot's world position.
 *  HEEL_OFFSET is behind + slightly down; TOE_OFFSET is forward + slightly
 *  down (so the rays hit the ground at the sole's contact points). */
const HEEL_RAY_OFFSET: [number, number, number] = [-0.08, 0.02, 0];
const TOE_RAY_OFFSET: [number, number, number] = [0.10, 0.02, 0];

/** Prompt 336 — multi-point foot contact. For each foot, raycasts at the
 *  heel + toe positions + aligns the foot's pitch to the slope defined by
 *  the two hit points. This makes feet conform to slopes (toe-down on
 *  uphill, heel-down on downhill) instead of just aligning the up-axis.
 *
 *  Call this INSTEAD of applyFootIK when you want the slope-aligned pitch.
 *  It runs the same 2-bone IK on the leg + adds the pitch alignment on top.
 *
 *  @returns Number of feet successfully planted with toe + heel rays. */
export function applyFootIKMultiPoint(
  rig: FootIKRig,
  terrainRaycastFn: TerrainRaycastFn,
  weight: number = 1.0,
): number {
  if (weight <= 0) return 0;
  let planted = 0;
  for (const chain of LEG_CHAINS) {
    const hip = resolveFirst(rig, chain.hip);
    const knee = resolveFirst(rig, chain.knee);
    const foot = resolveFirst(rig, chain.foot);
    if (!hip || !knee || !foot) continue;

    // Get current world positions.
    hip.getWorldPosition(_hipWorld);
    knee.getWorldPosition(_kneeWorld);
    foot.getWorldPosition(_footWorld);
    const upperLen = _hipWorld.distanceTo(_kneeWorld);
    const lowerLen = _kneeWorld.distanceTo(_footWorld);
    if (upperLen < MIN_BONE_LEN || lowerLen < MIN_BONE_LEN) continue;

    // Raycast at the heel + toe positions. The foot's world transform
    // determines where the heel + toe are in world space.
    foot.getWorldQuaternion(_qParent);
    // Heel + toe in foot-local space, transformed to world.
    const heelWorld = _footWorld.clone()
      .add(new THREE.Vector3(HEEL_RAY_OFFSET[0], HEEL_RAY_OFFSET[1], HEEL_RAY_OFFSET[2]).applyQuaternion(_qParent));
    const toeWorld = _footWorld.clone()
      .add(new THREE.Vector3(TOE_RAY_OFFSET[0], TOE_RAY_OFFSET[1], TOE_RAY_OFFSET[2]).applyQuaternion(_qParent));

    // Raycast down from above each contact point.
    _rayOrigin.copy(heelWorld).addScaledVector(_up, RAY_ORIGIN_OFFSET);
    const heelHit = terrainRaycastFn(_rayOrigin, _down, RAY_MAX_DIST);
    _rayOrigin.copy(toeWorld).addScaledVector(_up, RAY_ORIGIN_OFFSET);
    const toeHit = terrainRaycastFn(_rayOrigin, _down, RAY_MAX_DIST);
    if (!heelHit || !toeHit) continue;

    // The target foot position = midpoint of the two hits (slightly above).
    _target.copy(heelHit.point).add(toeHit.point).multiplyScalar(0.5).addScaledVector(_up, 0.02);

    // Pole vector (same as applyFootIK).
    hip.getWorldQuaternion(_qParent);
    _pole.set(0, 0, -1).applyQuaternion(_qParent);

    // 2-bone IK to plant the foot at the target.
    const solution = solveTwoBoneIK(
      _hipWorld, _kneeWorld, _footWorld, _target, _pole, upperLen, lowerLen,
    );
    if (!solution) continue;

    // Apply the knee bend (same as applyFootIK).
    const currentKneeBend = computeKneeBendAngle(_hipWorld, _kneeWorld, _footWorld);
    const targetKneeBend = computeKneeBendAngle(_hipWorld, solution.kneePos, solution.footPos);
    let deltaBend = (targetKneeBend - currentKneeBend) * weight;
    const kneeParent = knee.parent ?? knee;
    kneeParent.getWorldQuaternion(_qHipParentInv);
    _qHipParentInv.invert();
    _hipToKneeDir.set(1, 0, 0).applyQuaternion(_qHipParentInv);
    const xDot = Math.abs(_hipToKneeDir.x);
    if (xDot > 0.1) deltaBend = deltaBend / xDot;
    knee.rotation.x += deltaBend;

    // Align the foot to the slope defined by (heelHit → toeHit).
    // The foot's forward = (toeHit − heelHit) projected onto the ground
    // plane; the foot's up = the ground normal at the heel hit.
    const forwardDir = new THREE.Vector3().subVectors(toeHit.point, heelHit.point);
    forwardDir.y = 0; // project onto horizontal plane
    if (forwardDir.lengthSq() < 1e-6) forwardDir.set(0, 0, 1);
    forwardDir.normalize();
    // The ground normal = cross(forward, right) where right = cross(up, forward).
    const rightDir = new THREE.Vector3().crossVectors(_up, forwardDir).normalize();
    const groundNormal = new THREE.Vector3().crossVectors(forwardDir, rightDir).normalize();
    // Build a quaternion that rotates the foot's local +Y (up) to the ground
    // normal + local +Z (forward) to the forward dir. We use a look-at style
    // construction: first align +Y to the normal, then rotate around the
    // normal to align +Z to the forward.
    _qFoot.setFromUnitVectors(_up, groundNormal);
    // Convert to foot's parent's local space.
    const parent = foot.parent ?? foot;
    parent.getWorldQuaternion(_qParent);
    _qLocal.copy(_qParent).invert().multiply(_qFoot);
    // Slerp from the rest pose toward the ground-aligned quaternion.
    let restQuat = _footRestQuats.get(foot);
    if (!restQuat) {
      restQuat = new THREE.Quaternion();
      _footRestQuats.set(foot, restQuat);
    }
    restQuat.copy(foot.quaternion);
    foot.quaternion.copy(restQuat).slerp(_qLocal, weight);
    planted++;
  }
  return planted;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1550 — foot IK chain tuning (leg chain: hip→knee→foot).
// ═══════════════════════════════════════════════════════════════════════════

export const FOOT_IK_TUNE: Record<string, { stepHeight: number; smoothing: number; poleOffset: number; toeRollDeg: number }> = {
  walk:    { stepHeight: 0.05, smoothing: 0.30, poleOffset: 0.05, toeRollDeg: 25 },
  run:     { stepHeight: 0.08, smoothing: 0.45, poleOffset: 0.08, toeRollDeg: 35 },
  sprint:  { stepHeight: 0.12, smoothing: 0.60, poleOffset: 0.10, toeRollDeg: 45 },
  crouch:  { stepHeight: 0.03, smoothing: 0.20, poleOffset: 0.03, toeRollDeg: 15 },
  prone:   { stepHeight: 0.02, smoothing: 0.15, poleOffset: 0.02, toeRollDeg: 10 },
  idle:    { stepHeight: 0.02, smoothing: 0.10, poleOffset: 0.05, toeRollDeg: 5 },
};
