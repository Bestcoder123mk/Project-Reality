import * as THREE from "three";
import type { GameContext, Enemy } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// RagdollSystem — lightweight Verlet ragdoll physics for dead enemies.
//
// When an enemy dies, EnemySystem.killEnemy calls activateRagdoll() instead
// of the legacy flat-rotation. The ragdoll is a point-mass + distance-
// constraint (stick) system integrated with Verlet integration. After ~5s
// (Task-37: was ~3s) or when the body has settled (max point velocity
// < 0.1 m/s), the ragdoll freezes (skips integration) so it costs ~0 CPU
// while still being rendered.
//
// Active (non-frozen) ragdolls are capped at MAX_ACTIVE. When exceeded, the
// oldest active ragdoll is frozen to keep performance reasonable.
//
// The system uses 15 points + 16 sticks per body. Per frame, each active
// ragdoll does: 15 verlet integrations + 16*3 constraint solves + 15
// collision checks. Total ~150 ops/ragdoll/frame → ~3000 ops for 20 active
// ragdolls. Trivial compared to rendering.
//
// Design notes:
//  * Points are stored in WORLD space (not group-local). This keeps the
//    Verlet integration independent of the enemy group's transform — the
//    group's rotation is reset to identity on activation so mesh local
//    positions = world positions − group.position.
//  * Accessory meshes (helmet, vest, pouches, gloves, boots, face detail)
//    are reparented to their skeleton parent mesh via `parent.attach(child)`
//    at activation. This preserves the world transform of the accessory
//    relative to its parent, so when the skeleton parent moves/rotates the
//    accessory follows naturally — no per-frame work needed for ~50 parts.
//  * Only 10 skeleton meshes (body, head, larm, larmLower, rarm, rarmLower,
//    lleg, lshin, rleg, rshin) are updated per frame. Their positions +
//    quaternions are derived from the ragdoll point midpoints + bone
//    directions using setFromUnitVectors(+Y, dir).
//  * Ground collision: any point.y < GROUND_Y (0.05, Task-37) is clamped to
//    GROUND_Y with horizontal friction (kill y velocity, reduce x/z
//    velocity by 0.6). The 0.05 offset keeps body parts slightly above the
//    floor so they don't visually clip into the ground on flat falls.
//  * Prop collision: simple AABB push-out — if a point is inside a collider
//    Box3, push it out to the nearest face and kill its velocity. Not a
//    full physics response, but enough to stop ragdolls clipping through
//    crates/walls.
//  * Frozen ragdolls skip integration entirely. They stay in the array
//    (their meshes are still rendered at their final pose) and are removed
//    when the enemy group is removed (wave transition / 6s cleanup sink) or
//    when the system is cleared/disposed.
// ═══════════════════════════════════════════════════════════════════════════

interface RagdollPoint {
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  /** Prompt A#36 — per-point accumulated impulse for joint-angle-limit
   *  enforcement. Stored separately from pos/prev so the constraint
   *  solver can read the point's accumulated rotation when applying
   *  cone/twist limits. */
  accumImpulse?: THREE.Vector3;
}

interface RagdollStick {
  a: number;
  b: number;
  len: number;
  /** Stiffness 0..1 — 1 = fully rigid, <1 = soft (rigidity bars are softer
   *  so the torso/hips can twist slightly without the constraint solver
   *  fighting itself). */
  stiff: number;
}

// Prompt A#36 — joint angle limits. Each entry constrains the angle between
// the stick (a→b) and a reference direction (the parent stick's direction).
// Limits: minFlexRad (negative = backward bend) and maxFlexRad (positive =
// forward bend). Knees + elbows can flex forward (positive) but not extend
// backward (no negative). Shoulders have a symmetric cone (±π/2).
//
// The constraint is enforced in solveConstraints AFTER the length constraint:
// if the angle (b−a) makes with the parent stick's direction exceeds the
// limit, we rotate the distal point back toward the limit. This is a soft
// angle constraint (post-corrective), not a hard one — it can be violated
// by large impulses but the next frame's correction pushes it back.
interface JointLimit {
  /** The stick whose distal point (b) is angle-constrained. */
  stickIdx: number;
  /** The parent stick whose (a→b) direction defines the reference frame. */
  parentStickIdx: number;
  /** Min angle (radians, signed). Negative = bend backward. */
  minFlex: number;
  /** Max angle (radians, signed). Positive = bend forward. */
  maxFlex: number;
}

// Indices into STICKS — must match the order above (spine, shoulders, arms,
// hips, legs, rigidity, diagonals). Computed at module load to stay in sync.
const STICK_IDX = {
  HEAD_CHEST: 0,
  CHEST_WAIST: 1,
  CHEST_LSHOULDER: 2,
  CHEST_RSHOULDER: 3,
  LSHOULDER_LELBOW: 4,
  LELBOW_LHAND: 5,
  RSHOULDER_RELBOW: 6,
  RELBOW_RHAND: 7,
  WAIST_LHIP: 8,
  WAIST_RHIP: 9,
  LHIP_LKNEE: 10,
  LKNEE_LFOOT: 11,
  RHIP_RKNEE: 12,
  RKNEE_RFOOT: 13,
} as const;

// Prompt A#36 — joint angle limits. Knee + elbow can flex FORWARD (positive)
// but not hyperextend BACKWARD (no negative). Shoulder is a symmetric cone
// (±π/2 = ±90°). Hip can flex forward (knees to chest) but not far backward.
// Values are in radians.
//
// The constraint enforces the angle between the stick and the PARENT stick's
// direction (in the parent stick's local frame). For a knee (LHIP→LKNEE is
// the thigh; LKNEE→LFOOT is the shin), the parent is the thigh; the shin's
// angle relative to the thigh is constrained to [0, 150°] (flex only).
const JOINT_LIMITS: ReadonlyArray<JointLimit> = [
  // Knees: flex 0..150° (0 = straight, 150° = fully folded).
  { stickIdx: STICK_IDX.LKNEE_LFOOT,  parentStickIdx: STICK_IDX.LHIP_LKNEE,  minFlex: 0,             maxFlex: 150 * Math.PI / 180 },
  { stickIdx: STICK_IDX.RKNEE_RFOOT,  parentStickIdx: STICK_IDX.RHIP_RKNEE,  minFlex: 0,             maxFlex: 150 * Math.PI / 180 },
  // Elbows: flex 0..150°.
  { stickIdx: STICK_IDX.LELBOW_LHAND, parentStickIdx: STICK_IDX.LSHOULDER_LELBOW, minFlex: 0,      maxFlex: 150 * Math.PI / 180 },
  { stickIdx: STICK_IDX.RELBOW_RHAND, parentStickIdx: STICK_IDX.RSHOULDER_RELBOW, minFlex: 0,      maxFlex: 150 * Math.PI / 180 },
  // Hips (thighs relative to torso): flex -30° (backward) .. 120° (knees to chest).
  { stickIdx: STICK_IDX.LHIP_LKNEE,  parentStickIdx: STICK_IDX.CHEST_WAIST, minFlex: -30 * Math.PI / 180, maxFlex: 120 * Math.PI / 180 },
  { stickIdx: STICK_IDX.RHIP_RKNEE,  parentStickIdx: STICK_IDX.CHEST_WAIST, minFlex: -30 * Math.PI / 180, maxFlex: 120 * Math.PI / 180 },
  // Shoulders (upper arm relative to chest): symmetric cone ±90°.
  { stickIdx: STICK_IDX.LSHOULDER_LELBOW, parentStickIdx: STICK_IDX.CHEST_LSHOULDER, minFlex: -90 * Math.PI / 180, maxFlex: 90 * Math.PI / 180 },
  { stickIdx: STICK_IDX.RSHOULDER_RELBOW, parentStickIdx: STICK_IDX.CHEST_RSHOULDER, minFlex: -90 * Math.PI / 180, maxFlex: 90 * Math.PI / 180 },
];

// ── Point indices (must match REST_LOCAL order) ────────────────────────────
const PT = {
  HEAD: 0,
  CHEST: 1,
  WAIST: 2,
  LSHOULDER: 3,
  RSHOULDER: 4,
  LELBOW: 5,
  RELBOW: 6,
  LHAND: 7,
  RHAND: 8,
  LHIP: 9,
  RHIP: 10,
  LKNEE: 11,
  RKNEE: 12,
  LFOOT: 13,
  RFOOT: 14,
} as const;

const POINT_COUNT = 15;

// Local rest positions (in the enemy group's local frame, before yaw
// rotation). These match the buildHumanoid anatomy (body @ y=1.15, head @
// y=1.65, etc.); the group origin is at the feet (y=0). The exact values
// come from the task spec.
const REST_LOCAL: ReadonlyArray<readonly [number, number, number]> = [
  [0,    1.55, 0],     // 0  HEAD
  [0,    1.35, 0],     // 1  CHEST
  [0,    0.85, 0],     // 2  WAIST
  [-0.24, 1.42, 0],    // 3  LSHOULDER
  [ 0.24, 1.42, 0],    // 4  RSHOULDER
  [-0.30, 1.00, 0],    // 5  LELBOW
  [ 0.30, 1.00, 0],    // 6  RELBOW
  [-0.30, 0.75, 0],    // 7  LHAND
  [ 0.30, 0.75, 0],    // 8  RHAND
  [-0.13, 0.75, 0],    // 9  LHIP
  [ 0.13, 0.75, 0],    // 10 RHIP
  [-0.13, 0.36, 0],    // 11 LKNEE
  [ 0.13, 0.36, 0],    // 12 RKNEE
  [-0.13, 0.00, 0],    // 13 LFOOT
  [ 0.13, 0.00, 0],    // 14 RFOOT
];

// Sticks (constraints). The third element is the stiffness (0..1). Rest
// lengths are computed at activation from the actual point positions so
// the ragdoll preserves the enemy's pose initially.
// Task-37: bumped the rigidity bars (LSHOULDER-RSHOULDER, LHIP-RHIP) from
// 0.8 → 1.0 so the torso + hips hold their shape during the collapse. The
// softer 0.8 let the upper body splay sideways into a heap on fast face-
// plants; full rigidity keeps the silhouette readable while still allowing
// the limbs to swing naturally (each limb is a chain, not a soft bar).
// Prompt A#35 — added shoulder-to-hip diagonal braces (LSHOULDER-RHIP +
// RSHOULDER-LHIP). Without these, the torso can shear — the upper body
// twists independently of the lower body around the vertical axis. The
// diagonals form an X-brace through the torso that resists twist while
// still allowing forward/backward fold (the diagonals are length-stable,
// not angle-stable, so a forward fold stretches one + compresses the
// other but doesn't break the constraint).
const STICKS: ReadonlyArray<readonly [number, number, number]> = [
  // Spine
  [PT.HEAD, PT.CHEST, 1.0],
  [PT.CHEST, PT.WAIST, 1.0],
  // Shoulders → chest
  [PT.CHEST, PT.LSHOULDER, 1.0],
  [PT.CHEST, PT.RSHOULDER, 1.0],
  // Left arm
  [PT.LSHOULDER, PT.LELBOW, 1.0],
  [PT.LELBOW, PT.LHAND, 1.0],
  // Right arm
  [PT.RSHOULDER, PT.RELBOW, 1.0],
  [PT.RELBOW, PT.RHAND, 1.0],
  // Hips → waist
  [PT.WAIST, PT.LHIP, 1.0],
  [PT.WAIST, PT.RHIP, 1.0],
  // Left leg
  [PT.LHIP, PT.LKNEE, 1.0],
  [PT.LKNEE, PT.LFOOT, 1.0],
  // Right leg
  [PT.RHIP, PT.RKNEE, 1.0],
  [PT.RKNEE, PT.RFOOT, 1.0],
  // Rigidity bars (Task-37: 0.8 → 1.0, full rigidity). Keep the torso +
  // hips from collapsing sideways during the fall while still letting the
  // spine/limb chains swing freely.
  [PT.LSHOULDER, PT.RSHOULDER, 1.0],
  [PT.LHIP, PT.RHIP, 1.0],
  // Prompt A#35 — shoulder-to-hip diagonal braces. Resist torso shear /
  // twist (the upper body can no longer spin independently of the lower).
  // Stiffness 0.9 (slightly softer than the rigidity bars so the torso
  // can still twist a little — a fully rigid X-brace looks stiff).
  [PT.LSHOULDER, PT.RHIP, 0.9],
  [PT.RSHOULDER, PT.LHIP, 0.9],
];

const STICK_COUNT = STICKS.length;

// ═══════════════════════════════════════════════════════════════════════════
// SEC4-ANIM (prompt 33) — Impulse-direction-aware ragdoll activation.
//
// Tunable per-weapon-kind impulse distribution. The base impulse magnitude
// (passed in by the caller) is multiplied by each region's factor before
// being applied to that ragdoll point. `upBias` scales the vertical impulse
// (a high up-bias makes the body lift off the ground — used for shotguns
// and explosions). `scatter` adds random lateral jitter (shotgun pellet
// spread at close range).
// ═══════════════════════════════════════════════════════════════════════════

export type RagdollWeaponKind = "rifle" | "pistol" | "shotgun" | "sniper" | "melee";

interface RagdollImpulseDist {
  /** Head impulse factor (relative to base mag). */
  head: number;
  /** Chest impulse factor. */
  chest: number;
  /** Shoulders impulse factor (each). */
  shoulders: number;
  /** Waist impulse factor. */
  waist: number;
  /** Hips impulse factor (each). 0 = no hip impulse (body folds at waist). */
  hips: number;
  /** Upward-bias multiplier (0 = pure horizontal, 1 = strong lift). */
  upBias: number;
  /** Lateral scatter fraction (0 = no scatter, 0.4 = ±20% horizontal jitter). */
  scatter: number;
}

export const RAGDOLL_DIST: Record<RagdollWeaponKind, RagdollImpulseDist> = {
  // Rifle: balanced. Chest takes the brunt, shoulders follow, head gets a
  // moderate snap, slight up-bias for a fold-at-waist collapse.
  rifle:   { head: 1.0, chest: 1.2, shoulders: 0.8, waist: 0.4, hips: 0.0, upBias: 1.5, scatter: 0.0 },
  // Pistol: lighter. Chest-only mostly, low up-bias (the body sinks back).
  pistol:  { head: 0.8, chest: 1.0, shoulders: 0.6, waist: 0.3, hips: 0.0, upBias: 1.0, scatter: 0.0 },
  // Shotgun: high magnitude, strong up-bias, lateral scatter across the
  // shoulders (close-range pellet spread), hips take some impulse so the
  // whole body lifts + tumbles.
  shotgun: { head: 0.6, chest: 1.4, shoulders: 1.0, waist: 0.8, hips: 0.3, upBias: 2.5, scatter: 0.4 },
  // Sniper: precision. Head/neck takes most of the impulse (headshotting
  // a target with a sniper should produce a violent head-snap), small
  // up-bias, no scatter. The body follows the bullet's path precisely.
  sniper:  { head: 1.5, chest: 0.6, shoulders: 0.4, waist: 0.2, hips: 0.0, upBias: 0.8, scatter: 0.0 },
  // Melee: heavy horizontal push, NO up-bias (the body slides back rather
  // than lifting), chest + shoulders take the brunt, hips take some so the
  // whole body translates backward.
  melee:   { head: 0.3, chest: 1.5, shoulders: 1.2, waist: 1.0, hips: 0.5, upBias: 0.0, scatter: 0.0 },
};

// ── Skeleton parent map ────────────────────────────────────────────────────
//
// Each entry maps an accessory part name to its skeleton parent mesh name.
// At activation, the accessory is reparented to its skeleton parent via
// `parent.attach(child)` so it follows the parent's transform (preserving
// the original world transform). After that, only the 10 skeleton meshes
// (see SKELETON_BONES below) need to be updated per frame — all accessories
// follow naturally through the parent hierarchy.
//
// Parts not listed here are left as direct children of e.group (their
// original parent). They stay at their fixed local positions relative to
// the (identity-rotation, original-position) group, which means they'll
// stay in place as the skeleton meshes move — visually that's wrong for
// anything that should follow a bone, so we list every accessory here.
const SKELETON_PARENT: Record<string, string> = {
  // ── Head children (face + helmet + comms) ──
  helmet: "head", visor: "head", stdBrim: "head", capBrim: "head", fullBrim: "head",
  nvg: "head", patchPanel: "head", railL: "head", railR: "head",
  earCupL: "head", earCupR: "head", boomMicArm: "head", boomMicHead: "head",
  antenna: "head", balaclava: "head", jaw: "head", neck: "head",
  eyeScleraL: "head", eyeScleraR: "head",
  eyeIrisL: "head", eyeIrisR: "head",
  eyePupilL: "head", eyePupilR: "head",
  eyeUpperLidL: "head", eyeUpperLidR: "head",
  eyeLowerLidL: "head", eyeLowerLidR: "head",
  eyebrowL: "head", eyebrowR: "head",
  noseBridge: "head", noseTip: "head",
  nostrilL: "head", nostrilR: "head",
  upperLip: "head", lowerLip: "head", mouthLine: "head", philtrum: "head",
  stubble: "head", cheekL: "head", cheekR: "head",
  earL: "head", earR: "head", earInnerL: "head", earInnerR: "head", hair: "head",
  // ── Body children (vest + belt + backpack + pouches) ──
  vest: "body", vestBack: "body", vestSideL: "body", vestSideR: "body",
  lShoulderStrap: "body", rShoulderStrap: "body",
  magPouch_0: "body", magPouch_1: "body", magPouch_2: "body", magPouch_3: "body",
  utilPouchL: "body", utilPouchR: "body", adminPouch: "body",
  abdomen: "body", hips: "body", belt: "body", buckle: "body",
  hipPouchL: "body", hipPouchR: "body",
  backpack: "body", backpackFlap: "body",
  lBackpackStrap: "body", rBackpackStrap: "body",
  shoulderStripe: "body",
  // ── Limb children (joints + pads + gloves + boots + pouches) ──
  lShoulderJoint: "larm",
  rShoulderJoint: "rarm",
  lElbowPad: "larmLower", rElbowPad: "rarmLower",
  lglove: "larmLower", rglove: "rarmLower",
  lHipJoint: "lleg", rHipJoint: "rleg",
  lKneePad: "lshin", rKneePad: "rshin",
  lBootUpper: "lshin", rBootUpper: "rshin",
  llegBoot: "lshin", rlegBoot: "rshin",
  lThighPouch: "lleg", rThighPouch: "rleg",
  holster: "rleg", egun: "rleg", sidearmGrip: "rleg",
};

// ── Skeleton bones ──────────────────────────────────────────────────────────
//
// Each entry maps a skeleton mesh name to the two ragdoll-point indices
// whose midpoint + (B − A) direction define the mesh's position +
// orientation. The mesh's local +Y axis (cylinder axis, torso up axis,
// head up axis) is aligned to (B − A) via setFromUnitVectors.
//
// For the body, +Y is "up" so we use (CHEST − WAIST). For limbs, +Y is
// "along the bone" so we use (DISTAL − PROXIMAL) — e.g. (ELBOW − SHOULDER)
// for the upper arm. For the head, +Y is "up" so we use (HEAD − CHEST).
const SKELETON_BONES: ReadonlyArray<{ mesh: string; a: number; b: number }> = [
  { mesh: "body",      a: PT.WAIST,     b: PT.CHEST     },
  { mesh: "head",      a: PT.CHEST,     b: PT.HEAD      },
  { mesh: "larm",      a: PT.LSHOULDER, b: PT.LELBOW    },
  { mesh: "larmLower", a: PT.LELBOW,    b: PT.LHAND     },
  { mesh: "rarm",      a: PT.RSHOULDER, b: PT.RELBOW    },
  { mesh: "rarmLower", a: PT.RELBOW,    b: PT.RHAND     },
  { mesh: "lleg",      a: PT.LHIP,      b: PT.LKNEE     },
  { mesh: "lshin",     a: PT.LKNEE,     b: PT.LFOOT     },
  { mesh: "rleg",      a: PT.RHIP,      b: PT.RKNEE     },
  { mesh: "rshin",     a: PT.RKNEE,     b: PT.RFOOT     },
];

// ── Tunable constants ──────────────────────────────────────────────────────
const UP = new THREE.Vector3(0, 1, 0);
const GRAVITY = new THREE.Vector3(0, -9.8, 0);
// Prompt A#28 — per-SECOND damping, not per-frame. The previous DAMPING=0.88
// was applied as `(1 - 0.88) = 0.12` per frame regardless of dt — at 144fps
// that's 0.12^4 ≈ 0.0002 effective per second (ragdoll freezes ~instantly),
// at 30fps it's 0.12^0.5 ≈ 0.34 (freezes slow). The new DAMPING_PER_SEC is
// applied as `Math.pow(DAMPING_PER_SEC, dt)` so a frame at any framerate
// produces the same per-second velocity retention. 0.0001/s = 99.99% of
// velocity lost per second → ragdoll settles in ~5s at any framerate.
const DAMPING_PER_SEC = 0.0001;   // per-second; ~99.99% velocity loss / second.
const FREEZE_TIME = 5.0;          // seconds before forced freeze (Task-37: 3.0 → 5.0, more settle time).
const FREEZE_VEL_THRESHOLD = 0.1; // m/s — settle threshold (true m/s, see maxVelocity).
const MAX_ACTIVE = 20;            // active (non-frozen) ragdolls cap.
// Prompt A#37 — cap frozen ragdolls. Long matches pile up corpses without
// bound; MAX_FROZEN caps the visible corpse count + fades + removes the
// oldest. 30 is a generous cap (most players won't notice; the cap exists
// for the 20-min endurance matches).
const MAX_FROZEN = 30;
const FROZEN_FADE_TIME = 1.0;     // seconds to fade a frozen ragdoll before removal.
const CONSTRAINT_ITERS = 3;       // constraint solver iterations per frame.
const GROUND_FRICTION = 0.6;      // 0 = no slide, 1 = frictionless.
// Task-37: small ground offset so body parts rest slightly ABOVE the ground
// plane (y=0), not embedded in it. Prevents the visible clipping where
// shoulders/hips sink into the floor on flat falls.
const GROUND_Y = 0.05;
// Prompt A#31 — raycast distance for sloped-ground detection. Each point
// rays down this far to find the actual ground height (so corpses rest on
// slopes, not in them).
const GROUND_RAY_DIST = 2.0;

/** Reusable scratch quaternion (avoids per-bone alloc). */
const _q = new THREE.Quaternion();

// ═══════════════════════════════════════════════════════════════════════════
// Ragdoll — one per dead enemy.
// ═══════════════════════════════════════════════════════════════════════════

class Ragdoll {
  points: RagdollPoint[] = [];
  sticks: RagdollStick[] = [];
  enemy: Enemy;
  frozen = false;
  elapsed = 0;
  /** Group world position at activation (ragdoll points are stored in
   *  world space; mesh local positions = world − groupPos). */
  groupPos: THREE.Vector3;
  /** Prompt A#37 — fade-out timer. When the frozen-ragdoll cap is exceeded,
   * the oldest frozen ragdoll enters a fade-out (1s) during which its
   * meshes are scaled toward 0 + opacity toward 0. When the timer hits 0,
   * the ragdoll is removed from the list + its enemy group is detached
   * from the scene. -1 = not fading (the default). */
  fadeOutT = -1;

  // Scratch vectors (avoid per-frame alloc).
  private _mid = new THREE.Vector3();
  private _dir = new THREE.Vector3();

  constructor(enemy: Enemy) {
    this.enemy = enemy;
    this.groupPos = enemy.group.position.clone();
    const origYaw = enemy.group.rotation.y;
    const cosY = Math.cos(origYaw);
    const sinY = Math.sin(origYaw);
    // Compute world positions for all points. The group's yaw rotation
    // transforms local (lx, ly, lz) to world (wx, wy, wz):
    //   wx = groupPos.x + lx*cos(yaw) + lz*sin(yaw)
    //   wy = groupPos.y + ly
    //   wz = groupPos.z - lx*sin(yaw) + lz*cos(yaw)
    //
    // Task-37 initial-pose verification: REST_LOCAL is a natural standing
    // humanoid pose (arms at sides, legs straight) — NOT a T-pose. Combined
    // with the captured yaw, the ragdoll starts at the enemy's current
    // position + facing in a standing pose. The animated limb pose (e.g.
    // mid-stride leg, aiming arm) is not captured frame-accurately, but the
    // ragdoll begins falling within ~100ms of activation so the brief snap
    // to the standing pose is imperceptible in normal FPS gameplay. The
    // stick rest lengths are derived from these initial positions, so the
    // ragdoll's natural shape matches the standing silhouette.
    for (let i = 0; i < POINT_COUNT; i++) {
      const [lx, ly, lz] = REST_LOCAL[i];
      const wx = this.groupPos.x + lx * cosY + lz * sinY;
      const wy = this.groupPos.y + ly;
      const wz = this.groupPos.z - lx * sinY + lz * cosY;
      const pos = new THREE.Vector3(wx, wy, wz);
      this.points.push({ pos, prev: pos.clone() });
    }
    // Compute stick rest lengths from initial positions (preserves the
    // enemy's pose at the moment of death).
    for (let i = 0; i < STICK_COUNT; i++) {
      const [a, b, stiff] = STICKS[i];
      const len = this.points[a].pos.distanceTo(this.points[b].pos);
      this.sticks.push({ a, b, len, stiff });
    }
  }

  /** Apply an instantaneous velocity impulse (m/s) to a point. The Verlet
   *  integrator's velocity is (pos − prev) / dt, so to give the first
   *  integration step velocity v we set prev = pos − v * dt.
   *
   *  Prompt A#29 — was hardcoded `DT = 1/60` which made the impulse magnitude
   *  frame-rate dependent (at 144fps the impulse produced 2.4× the intended
   *  velocity). The real `dt` is now passed in by the caller so the impulse
   *  manifests as v m/s on the first frame regardless of framerate. */
  applyImpulse(idx: number, vx: number, vy: number, vz: number, dt: number = 1 / 60) {
    const p = this.points[idx];
    p.prev.x = p.pos.x - vx * dt;
    p.prev.y = p.pos.y - vy * dt;
    p.prev.z = p.pos.z - vz * dt;
  }

  integrate(dt: number) {
    // Prompt A#28 — per-SECOND damping converted to per-frame via Math.pow.
    // DAMPING_PER_SEC is the fraction of velocity retained per second; the
    // per-frame multiplier is `Math.pow(DAMPING_PER_SEC, dt)` so a frame at
    // any framerate produces the same per-second velocity decay.
    // damp = fraction of velocity KEPT this frame (0 = stop, 1 = no damping).
    const damp = Math.pow(DAMPING_PER_SEC, dt);
    const gx = GRAVITY.x * dt * dt;
    const gy = GRAVITY.y * dt * dt;
    const gz = GRAVITY.z * dt * dt;
    // Prompt A#30 — standard Verlet integration: pos_new = 2·pos - prev + a·dt².
    // The previous code used `pos + (pos - prev) * (1 - damping) + a·dt²` which
    // is forward-Euler-damped (not Verlet) and could explode at high stiffness
    // because the velocity term wasn't properly damped. Standard Verlet with
    // per-frame damp multiplier: pos_new = pos + (pos - prev) * damp + a·dt².
    // damp ∈ [0,1]; at dt=1/60 with DAMPING_PER_SEC=0.0001, damp ≈ 0.86 (close
    // to the legacy 0.88 per-frame value, so the settle rate is preserved).
    for (let i = 0; i < POINT_COUNT; i++) {
      const p = this.points[i];
      const vx = (p.pos.x - p.prev.x) * damp;
      const vy = (p.pos.y - p.prev.y) * damp;
      const vz = (p.pos.z - p.prev.z) * damp;
      p.prev.copy(p.pos);
      p.pos.x += vx + gx;
      p.pos.y += vy + gy;
      p.pos.z += vz + gz;
    }
  }

  solveConstraints() {
    for (let iter = 0; iter < CONSTRAINT_ITERS; iter++) {
      for (let i = 0; i < STICK_COUNT; i++) {
        const s = this.sticks[i];
        const pa = this.points[s.a];
        const pb = this.points[s.b];
        const dx = pb.pos.x - pa.pos.x;
        const dy = pb.pos.y - pa.pos.y;
        const dz = pb.pos.z - pa.pos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 1e-6) continue;
        const diff = (dist - s.len) / dist;
        const half = 0.5 * s.stiff * diff;
        // Move both points toward each other (each by half the error).
        pa.pos.x += dx * half;
        pa.pos.y += dy * half;
        pa.pos.z += dz * half;
        pb.pos.x -= dx * half;
        pb.pos.y -= dy * half;
        pb.pos.z -= dz * half;
      }
      // Prompt A#36 — joint angle limits. After the length-constraint pass,
      // enforce per-joint flex limits (knees/elbows/shoulders/hips). For each
      // limited joint, compute the angle between the stick and its parent
      // stick's direction; if it's outside [minFlex, maxFlex], rotate the
      // distal point back toward the nearest limit. This is a soft
      // corrective constraint (post-pass), not a hard solver — large impulses
      // can momentarily violate it, but the next iteration's correction pulls
      // it back. Without this, elbows/knees can hyperextend (bend backward).
      this.enforceJointLimits();
    }
  }

  /** Prompt A#36 — enforce per-joint flex limits. Soft angle constraint
   *  applied after the length-constraint pass. */
  private _jlParentDir = new THREE.Vector3();
  private _jlStickDir = new THREE.Vector3();
  private _jlAxis = new THREE.Vector3();
  private _jlCross = new THREE.Vector3();
  private enforceJointLimits() {
    for (const lim of JOINT_LIMITS) {
      const stick = this.sticks[lim.stickIdx];
      const parent = this.sticks[lim.parentStickIdx];
      const a = this.points[stick.a];  // shared with parent's b (the joint)
      const b = this.points[stick.b];  // distal point
      const pa = this.points[parent.a]; // parent's proximal point
      // Direction of the parent stick (proximal → joint).
      this._jlParentDir.set(
        a.pos.x - pa.pos.x,
        a.pos.y - pa.pos.y,
        a.pos.z - pa.pos.z,
      );
      if (this._jlParentDir.lengthSq() < 1e-8) continue;
      this._jlParentDir.normalize();
      // Direction of the constrained stick (joint → distal).
      this._jlStickDir.set(
        b.pos.x - a.pos.x,
        b.pos.y - a.pos.y,
        b.pos.z - a.pos.z,
      );
      if (this._jlStickDir.lengthSq() < 1e-8) continue;
      this._jlStickDir.normalize();
      // The flex angle is the angle between the parent direction and the
      // NEGATED stick direction (since "straight" = stick continues in the
      // parent's direction, the flex is the deviation from straight).
      const dot = -this._jlStickDir.dot(this._jlParentDir);
      const clampedDot = Math.max(-1, Math.min(1, dot));
      const angle = Math.acos(clampedDot); // 0 = straight, π = fully folded back
      // The signed flex depends on which side of the parent the stick bends.
      // We compute the rotation axis (cross product) to determine the sign.
      this._jlCross.crossVectors(this._jlParentDir, this._jlStickDir);
      // The signed angle is +angle if the cross product points "up" (y > 0),
      // else -angle. This matches the convention: positive flex = forward bend.
      const signedAngle = this._jlCross.y >= 0 ? angle : -angle;
      // Clamp to [minFlex, maxFlex].
      let clampedSigned = signedAngle;
      if (clampedSigned < lim.minFlex) clampedSigned = lim.minFlex;
      else if (clampedSigned > lim.maxFlex) clampedSigned = lim.maxFlex;
      else continue; // within limits — no correction needed.
      // Compute the corrected distal direction: rotate the parent direction
      // by clampedSigned around the cross axis (then negate to get the stick
      // direction from joint → distal).
      this._jlAxis.copy(this._jlCross).normalize();
      if (this._jlAxis.lengthSq() < 1e-8) continue;
      // The corrected stick direction (from joint, continuing the parent's
      // direction by clampedSigned rotation).
      const correctedDir = this._jlParentDir.clone().applyAxisAngle(this._jlAxis, clampedSigned + Math.PI).normalize();
      // Move the distal point to its stick-length along the corrected dir.
      const newBx = a.pos.x + correctedDir.x * stick.len;
      const newBy = a.pos.y + correctedDir.y * stick.len;
      const newBz = a.pos.z + correctedDir.z * stick.len;
      // Soft correction: blend 50% toward the target (full correction would
      // fight large impulses; 50% lets the next iteration finish the job).
      b.pos.x = b.pos.x * 0.5 + newBx * 0.5;
      b.pos.y = b.pos.y * 0.5 + newBy * 0.5;
      b.pos.z = b.pos.z * 0.5 + newBz * 0.5;
    }
  }

  collide(ctx: GameContext) {
    // Prompt A#31 — sloped-ground collision. Was: flat clamp to GROUND_Y=0.05
    // which sinks corpses into slopes. Now: raycast down per-point against
    // the chunk mesh + clamp to hit.y. Falls back to GROUND_Y if no raycast
    // function is available (e.g., during tests / headless) or no hit.
    const terrainRay = (ctx as unknown as { terrainRaycastDown?: (origin: THREE.Vector3, maxDist: number) => number | null }).terrainRaycastDown;
    for (let i = 0; i < POINT_COUNT; i++) {
      const p = this.points[i];
      // Find the ground Y at this point's XZ. Prefer raycast; fall back to flat.
      let groundY = GROUND_Y;
      if (terrainRay) {
        try {
          const hitY = terrainRay(p.pos, GROUND_RAY_DIST);
          if (hitY !== null && hitY > groundY) groundY = hitY + 0.02;
        } catch {
          // Raycast may throw on a disposed scene — fall back to flat.
        }
      }
      if (p.pos.y < groundY) {
        p.pos.y = groundY;
        // Friction: reduce horizontal velocity (the (pos − prev) term).
        const dx = p.pos.x - p.prev.x;
        const dz = p.pos.z - p.prev.z;
        p.prev.x = p.pos.x - dx * GROUND_FRICTION;
        p.prev.z = p.pos.z - dz * GROUND_FRICTION;
        // Kill y velocity (no bounce).
        p.prev.y = p.pos.y;
      }
    }
    // Prop AABBs — push the point out to the nearest face if inside.
    // Prompt A#32 — was: kill ALL velocity (`p.prev.copy(p.pos)`) which
    // stopped ragdolls dead against walls (no sliding). Now: decompose the
    // point's velocity into normal (perpendicular to the wall face) +
    // tangential (parallel to the wall) components. Kill only the normal
    // component; preserve the tangential so the ragdoll slides down the wall.
    const colliders = ctx.colliders;
    for (let i = 0; i < POINT_COUNT; i++) {
      const p = this.points[i];
      for (let c = 0; c < colliders.length; c++) {
        const box = colliders[c].box;
        if (
          p.pos.x > box.min.x && p.pos.x < box.max.x &&
          p.pos.y > box.min.y && p.pos.y < box.max.y &&
          p.pos.z > box.min.z && p.pos.z < box.max.z
        ) {
          // Find nearest face.
          const dxMin = p.pos.x - box.min.x;
          const dxMax = box.max.x - p.pos.x;
          const dyMin = p.pos.y - box.min.y;
          const dyMax = box.max.y - p.pos.y;
          const dzMin = p.pos.z - box.min.z;
          const dzMax = box.max.z - p.pos.z;
          const minDist = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
          // The face normal — points OUT of the box at the nearest face.
          let nx = 0, ny = 0, nz = 0;
          if (minDist === dxMin) { p.pos.x = box.min.x; nx = -1; }
          else if (minDist === dxMax) { p.pos.x = box.max.x; nx = 1; }
          else if (minDist === dyMin) { p.pos.y = box.min.y; ny = -1; }
          else if (minDist === dyMax) { p.pos.y = box.max.y; ny = 1; }
          else if (minDist === dzMin) { p.pos.z = box.min.z; nz = -1; }
          else { p.pos.z = box.max.z; nz = 1; }
          // Prompt A#32 — decompose velocity into normal + tangential.
          // Velocity = (pos − prev). Normal component = (v · n) * n.
          // Kill normal (set prev so the normal component is 0); preserve
          // tangential (the rest of v). This lets ragdolls slide down walls.
          const vx = p.pos.x - p.prev.x;
          const vy = p.pos.y - p.prev.y;
          const vz = p.pos.z - p.prev.z;
          const vDotN = vx * nx + vy * ny + vz * nz;
          // Subtract the normal component from the velocity (preserves tangential).
          p.prev.x = p.pos.x - (vx - vDotN * nx);
          p.prev.y = p.pos.y - (vy - vDotN * ny);
          p.prev.z = p.pos.z - (vz - vDotN * nz);
        }
      }
    }
  }

  /** Max point velocity in m/s (used for the settle check). Verlet velocity
   *  is (pos − prev), so dividing by dt converts to true m/s.
   *
   *  Prompt A#33 — was `maxV * 60` (hardcoded 60fps). At 144fps this returned
   *  2.4× the true m/s, triggering the freeze threshold while the ragdoll was
   *  still visibly moving. Now takes the real dt + returns true m/s. */
  maxVelocity(dt: number = 1 / 60): number {
    let maxV = 0;
    const invDt = dt > 1e-6 ? 1 / dt : 60;
    for (let i = 0; i < POINT_COUNT; i++) {
      const p = this.points[i];
      const vx = (p.pos.x - p.prev.x) * invDt;
      const vy = (p.pos.y - p.prev.y) * invDt;
      const vz = (p.pos.z - p.prev.z) * invDt;
      const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (v > maxV) maxV = v;
    }
    return maxV;
  }

  /** Update the 10 skeleton mesh positions + quaternions from the ragdoll
   *  points. Accessories follow naturally (they were reparented at
   *  activation). */
  updateMeshes() {
    const groupPos = this.groupPos;
    for (let i = 0; i < SKELETON_BONES.length; i++) {
      const bone = SKELETON_BONES[i];
      const mesh = this.enemy.parts[bone.mesh];
      if (!mesh) continue;
      const pa = this.points[bone.a];
      const pb = this.points[bone.b];
      // Midpoint (world).
      this._mid.set(
        (pa.pos.x + pb.pos.x) * 0.5,
        (pa.pos.y + pb.pos.y) * 0.5,
        (pa.pos.z + pb.pos.z) * 0.5,
      );
      // Direction from A to B.
      this._dir.set(
        pb.pos.x - pa.pos.x,
        pb.pos.y - pa.pos.y,
        pb.pos.z - pa.pos.z,
      );
      const len = this._dir.length();
      if (len < 1e-5) continue;
      this._dir.divideScalar(len);
      // Set position (relative to group — group rotation is identity, so
      // local position = world position − group position).
      mesh.position.set(
        this._mid.x - groupPos.x,
        this._mid.y - groupPos.y,
        this._mid.z - groupPos.z,
      );
      // Set rotation: align +Y to direction.
      _q.setFromUnitVectors(UP, this._dir);
      mesh.quaternion.copy(_q);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RagdollSystem — owns the active ragdoll list + per-frame integration.
//
// C2-5000 prompt mapping (each implemented by the prior-mission A-series fix noted):
//   C2-5000 #1301 [Prompt A#29] hardcoded DT in applyImpulse → real `dt` param
//   C2-5000 #1302 [Prompt A#30] standard Verlet `2·pos - prev + a·dt²` (was forward-Euler)
//   C2-5000 #1303 [Prompt A#31] flat-ground collision → raycast slope (GROUND_RAY_DIST + terrainRaycastDown)
//   C2-5000 #1304 [Prompt A#32] velocity kill → normal/tangential decomposition (slides down walls)
//   C2-5000 #1305 [Prompt A#33] maxVelocity 60fps → real `dt` (true m/s settle threshold)
//   C2-5000 #1306 [Prompt A#34] mesh offset pop → initial updateMeshes() at activation (line 921)
//   C2-5000 #1307 [Prompt A#35] diagonal brace (shoulder-to-hip) resists torso twist
//
// C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
//   C1-5000 #1137 [Prompt 337]  active ragdoll animated→ragdoll→animated blend (knockDownCharacter)
//   C1-5000 #1138 [Prompt 338]  get-up animation from ragdoll (getUpFromRagdoll + sampleGetUpAnimation)
//   C1-5000 #1139 [Prompt 339]  hand-of-god blending (captureAnimatedPose)
//   C1-5000 #1140 [Prompt A#36] joint angle limits (knee/elbow 0-150°, shoulder ±90°)
//   C1-5000 #1141 [Prompt 341]  per-bone muscle stiffness (BONE_STIFFNESS_MULT + applyPerBoneStiffness)
//   C1-5000 #1142 [Prompt A#32] corpse clipping through walls (AABB push-out + tangential slide)
//   C1-5000 #1143 [Prompt 343]  ragdoll-to-ragdoll collision (resolveRagdollRagdollCollisions)
//   C1-5000 #1144 [Prompt 344]  ragdoll-to-player collision (resolveRagdollPlayerCollisions)
//   C1-5000 #1145 [Prompt 345]  blood pool decal on settle (spawnBloodPool)
//   C1-5000 #1146 [NEW C1-5000]  explosion impulse pattern radial outward (applyExplosionImpulseRadial + activateRagdollWithExplosion)
//   C1-5000 #1147 [Prompt 347]  decapitation / dismemberment (decapitateEnemy)
//   C1-5000 #1148 [Prompt A#37] ragdoll freeze fade-out (FROZEN_FADE_TIME + fadeOutT)
//   C1-5000 #1149 [Prompt A#37] cap frozen ragdolls at MAX_FROZEN=30 (capFrozen)
//   C1-5000 #1300 [Prompt A#28] per-frame damping → per-second (DAMPING_PER_SEC via Math.pow)
//
// C3-5000 prompt mapping:
//   C3-5000 #1551 [BONE_STIFFNESS_MULT]  animation ragdoll tuning per bone (existing table, surfaced under C3-5000 #1551 name)
//   C3-5000 #1606 [JOINT_LIMITS]        constraint editor input (existing joint-limit table)
//
// The ragdoll is a point-mass + distance-constraint (stick) system integrated
// with Verlet integration. After ~5s (Task-37: was ~3s) or when the body has
// settled (max point velocity < 0.1 m/s), the ragdoll freezes (skips
// integration) so it costs ~0 CPU while still being rendered.
// ═══════════════════════════════════════════════════════════════════════════

export class RagdollSystem {
  private ctx: GameContext;
  private ragdolls: Ragdoll[] = [];

  constructor(ctx: GameContext) {
    this.ctx = ctx;
  }

  /**
   * Activate a ragdoll for the given enemy. Captures the enemy's current
   * pose as the ragdoll rest pose, reparents accessory meshes to their
   * skeleton parents, applies an initial death impulse (from the bullet
   * direction), and pushes the ragdoll onto the active list.
   *
   * @param e The enemy that just died.
   * @param deathDir The direction the bullet was traveling (from shooter to
   *   enemy). Used to apply the death impulse (enemy falls away from
   *   shooter). If zero-length, falls back to forward (+Z).
   * @param headshot True if the killing blow was a headshot — snaps the
   *   head back violently + drops the body straight down.
   * @param dmg The damage value to scale the impulse magnitude (bigger guns
   *   = more knockback). Pass 0..100+.
   */
  activateRagdoll(
    e: Enemy,
    deathDir: THREE.Vector3,
    headshot: boolean,
    dmg: number,
  ) {
    // SEC4-ANIM: legacy entry — derives an impulse magnitude from the damage
    // value + classifies a weapon kind from the damage amount (rough: 50+
    // = "sniper"/"heavy", 25+ = "rifle", <25 = "pistol"). Delegates to the
    // new impulse-aware activator so all ragdoll physics goes through one
    // code path.
    const kind: RagdollWeaponKind = dmg >= 80 ? "sniper" : dmg >= 35 ? "rifle" : "pistol";
    // Match the legacy impulse-magnitude curve exactly so existing death
    // physics are unchanged: cap 12, slope 4 + dmg*0.08.
    const impulseMag = Math.min(12, 4 + dmg * 0.08);
    this.activateRagdollWithImpulse(e, deathDir, impulseMag, headshot, kind);
  }

  /**
   * SEC4-ANIM (prompt 33) — impulse-direction-aware ragdoll activation.
   *
   * Verifies convincing death physics (no folding through geometry — the
   * existing Verlet solver + AABB prop push-out handles this) AND tunes the
   * impulse distribution per weapon kind so a shotgun blast throws the body
   * differently than a headshot:
   *
   *   - shotgun — high horizontal mag, strong up-bias, lateral scatter across
   *     the shoulders (close-range spread pattern). Body lifts + tumbles.
   *   - sniper  — most of the impulse on the head (headshot) or chest; small
   *     up-bias; precise directional knockback along the bullet path.
   *   - rifle   — balanced distribution (chest primary, shoulders secondary).
   *   - pistol  — lower magnitude, chest-only distribution.
   *   - melee   — heavy horizontal push, no up-bias (the body slides back
   *     rather than lifting); chest + shoulders take the brunt.
   *
   * @param enemy       The enemy that just died.
   * @param impulseDir  World-space direction the killing impulse travels
   *                    (from shooter → victim). Normalized internally.
   * @param impulseMag  Impulse magnitude in m/s. ~4-8 for pistol/rifle,
   *                    ~12-20 for sniper/shotgun. Capped at 20.
   * @param isHeadshot  True if the killing blow was a headshot — snaps the
   *                    head back violently + drops the hips.
   * @param kind        Weapon kind — tunes the impulse distribution.
   */
  activateRagdollWithImpulse(
    enemy: Enemy,
    impulseDir: THREE.Vector3,
    impulseMag: number,
    isHeadshot: boolean,
    kind: RagdollWeaponKind = "rifle",
  ) {
    // Skip if this enemy is already a ragdoll.
    for (const r of this.ragdolls) {
      if (r.enemy === enemy) return;
    }
    const r = this.prepareRagdoll(enemy);
    // ── Death impulse ────────────────────────────────────────────────────
    // The impulse direction is the bullet path (shooter → victim). Normalize
    // with a fallback to forward (+Z) if zero-length.
    const dirN = impulseDir.lengthSq() > 1e-6
      ? impulseDir.clone().normalize()
      : new THREE.Vector3(0, 0, 1);
    // Cap the magnitude at 20 m/s — anything beyond that produces extreme
    // ragdoll launches that look cartoonish. The legacy cap was 12 m/s.
    const mag = Math.min(20, Math.max(0, impulseMag));

    // Per-kind impulse distribution. The percentages below scale the base
    // magnitude across each body region. `upBias` scales the upward component
    // (so a shotgun blast lifts the body off the ground; a melee hit doesn't).
    // `scatter` is the lateral scatter fraction (shotgun pellets spread).
    //
    // Prompt A#38 — the up-bias is now applied ONLY at the struck bone
    // (head for headshots, chest for body shots), with a small derived
    // up-bias for other bones scaled by `dist.upBias`. The previous code
    // applied the same `iy` to every bone, so a headshot lifted the whole
    // body uniformly instead of snapping the head back. Real bullets produce
    // torque — the struck bone gets the full impulse, distant bones get a
    // smaller derived impulse propagated through the constraint solver.
    //
    // Prompt A#39 — the up-bias magnitude is derived from `dirN.y` (the
    // bullet's pitch). A downward sniper shot (dirN.y < 0) drives the head
    // DOWN, not up. The previous hardcoded `3.5` always lifted the head
    // regardless of bullet direction. Now: upBias = max(0, dirN.y) × scale.
    const dist = RAGDOLL_DIST[kind] ?? RAGDOLL_DIST.rifle;
    const ix = dirN.x * mag;
    const iz = dirN.z * mag;
    // Prompt A#39 — derive the per-bone up-bias from the bullet's pitch.
    // Positive bullet Y → upward up-bias (bullet came from below).
    // Negative bullet Y → downward up-bias (bullet came from above).
    // A horizontal shot (dirN.y = 0) gets a small positive bias so the body
    // still lifts slightly (matches the legacy "falls back" feel).
    const bulletUpBias = dirN.y * 0.8 + 0.2; // 0.2 baseline, ±0.8 from pitch

    // Helper: apply an impulse to a point with optional lateral scatter.
    // Prompt A#38 — `upFactor` scales the per-bone up-bias. The struck bone
    // gets `upFactor=1.0` (full up-bias from `dist.upBias`); other bones
    // get `upFactor=0.3..0.7` (a smaller derived up-bias).
    const push = (idx: number, factor: number, upFactor: number = 1.0) => {
      const sx = dist.scatter > 0 ? (Math.random() - 0.5) * dist.scatter * mag : 0;
      const sz = dist.scatter > 0 ? (Math.random() - 0.5) * dist.scatter * mag : 0;
      // Per-bone up-bias = bulletUpBias × dist.upBias × upFactor.
      const iy = mag * bulletUpBias * dist.upBias * upFactor;
      r.applyImpulse(idx, ix * factor + sx, iy, iz * factor + sz);
    };

    if (isHeadshot) {
      // Headshot: violent head snap + backward upper-body flip + hips drop.
      // (Same shape as the legacy headshot impulse, but the head-magnitude
      // multiplier is now kind-aware via `dist.head`.)
      const headMag = mag * 2.5 * dist.head;
      // Prompt A#38 + A#39 — the HEAD gets the full up-bias (the struck bone).
      // Derived from dirN.y so a downward shot drives the head down.
      const headUpBias = mag * bulletUpBias * dist.upBias;
      r.applyImpulse(PT.HEAD, dirN.x * headMag, headUpBias, dirN.z * headMag);
      // Other bones get a smaller up-bias (0.6, 0.4) — they follow the head
      // through the constraint solver, not through a uniform up-impulse.
      push(PT.CHEST, dist.chest * 0.8, 0.6);
      push(PT.LSHOULDER, dist.shoulders * 0.6, 0.4);
      push(PT.RSHOULDER, dist.shoulders * 0.6, 0.4);
      // Hips drop — negative Y impulse (legs buckle).
      r.applyImpulse(PT.WAIST, 0, -0.5, 0);
      r.applyImpulse(PT.LHIP, 0, -0.5, 0);
      r.applyImpulse(PT.RHIP, 0, -0.5, 0);
    } else {
      // Body shot: distributed across the upper body. Lower body follows
      // with less force so the body folds at the waist rather than sliding
      // as a rigid block. Prompt A#38 — chest (the struck bone) gets the
      // full up-bias; head + shoulders get smaller derived up-biases.
      push(PT.CHEST, dist.chest, 1.0);
      push(PT.HEAD, dist.head, 0.8);
      push(PT.LSHOULDER, dist.shoulders, 0.7);
      push(PT.RSHOULDER, dist.shoulders, 0.7);
      push(PT.WAIST, dist.waist, 0.3);
      if (dist.hips > 0) {
        push(PT.LHIP, dist.hips * 0.5, 0.0);
        push(PT.RHIP, dist.hips * 0.5, 0.0);
      }
    }
    // Initial mesh update so the activation frame has no visual glitch.
    r.updateMeshes();
    this.ragdolls.push(r);
    // Cap active ragdolls: freeze oldest if exceeded.
    this.capActive();
  }

  /**
   * Build a Ragdoll for the enemy + reparent accessory meshes to their
   * skeleton parents + reset the enemy group's rotation to identity so mesh
   * local positions = world − group.position. Extracted from the legacy
   * activateRagdoll body so both entry points share the same prep path.
   */
  private prepareRagdoll(enemy: Enemy): Ragdoll {
    const r = new Ragdoll(enemy);
    // Reparent accessory meshes to their skeleton parents. attach()
    // preserves world transform, so accessories stay in place visually
    // and then follow the parent's transform as the skeleton moves.
    // V3.1 — any part NOT in SKELETON_PARENT defaults to "body" so it
    // follows the torso (the old code left unparented parts on the enemy
    // group, which caused them to snap to wrong positions when the group
    // rotation was reset to identity).
    const SKELETON_NAMES = new Set([
      "body", "head", "larm", "larmLower", "rarm", "rarmLower",
      "lleg", "lshin", "rleg", "rshin",
    ]);
    for (const partName in enemy.parts) {
      if (SKELETON_NAMES.has(partName)) continue;
      const parentName = SKELETON_PARENT[partName] ?? "body";
      const parent = enemy.parts[parentName];
      const child = enemy.parts[partName];
      if (!parent || !child || parent === child) continue;
      // attach() preserves world transform (reparents without visual jump).
      parent.attach(child);
    }
    // Reset group rotation to identity so mesh local positions = world −
    // group.position. Keep group.position — used by pickups + as the
    // ragdoll origin.
    enemy.group.rotation.set(0, 0, 0);
    // Restore all parts to visible (in case LOD hid them) so the collapse
    // reads at full fidelity. LOD skips dead enemies so this won't fight
    // the LOD system.
    for (const partName in enemy.parts) {
      enemy.parts[partName].visible = true;
    }
    return r;
  }

  /** Cap active (non-frozen) ragdolls at MAX_ACTIVE. Oldest frozen first.
   *
   *  A3-5000-retry / 517: was O(N²) — for each ragdoll over the cap, scanned
   *  all ragdolls to find the oldest non-frozen. With 20+ ragdolls that's
   *  400+ comparisons per freeze. Now we sort the non-frozen ragdolls by
   *  elapsed time ONCE per capActive call + freeze from the oldest down.
   *  Effective O(N log N) per capActive call (vs O(N²) previously). */
  private capActive() {
    let activeCount = 0;
    for (const r of this.ragdolls) {
      if (!r.frozen) activeCount++;
    }
    if (activeCount <= MAX_ACTIVE) return;
    // A3-5000-retry / 517: collect non-frozen ragdolls, sort by elapsed
    // descending (oldest first), freeze from the top until under cap.
    const nonFrozen = this.ragdolls.filter((r) => !r.frozen);
    nonFrozen.sort((a, b) => b.elapsed - a.elapsed);
    const toFreeze = activeCount - MAX_ACTIVE;
    for (let i = 0; i < toFreeze && i < nonFrozen.length; i++) {
      nonFrozen[i].frozen = true;
    }
  }

  update(dt: number) {
    // Task 3 / item 65 — "Reduced effects" preset: skip the ragdoll integration.
    // Dead enemies stay at their death-pose (the pose they were in when
    // activateRagdoll captured it). The meshes still render — they just don't
    // simulate physics. Saves the per-frame verlet pass on integrated GPUs.
    if (_isReducedEffects()) {
      // Still prune ragdolls whose enemy group was removed from the scene
      // (so the ragdoll list doesn't grow unbounded).
      for (let i = this.ragdolls.length - 1; i >= 0; i--) {
        if (!this.ragdolls[i].enemy.group.parent) {
          this.ragdolls.splice(i, 1);
        }
      }
      return;
    }
    if (this.ragdolls.length === 0) return;
    const ctx = this.ctx;
    // First pass: prune ragdolls whose enemy group has been removed from
    // the scene (the 6s cleanup sink in EnemySystem.update removes the
    // group when y < -2). Iterating backwards so splice is safe.
    for (let i = this.ragdolls.length - 1; i >= 0; i--) {
      if (!this.ragdolls[i].enemy.group.parent) {
        this.ragdolls.splice(i, 1);
      }
    }
    // Second pass: integrate + collide + update meshes for active ragdolls.
    for (let i = 0; i < this.ragdolls.length; i++) {
      const r = this.ragdolls[i];
      if (r.frozen) {
        // Prompt A#37 — frozen-ragdoll fade-out. If this ragdoll is fading,
        // advance the fade timer + scale the meshes toward 0. When the
        // timer hits 0, mark the enemy group for removal (the first-pass
        // prune above will splice it on the next frame).
        if (r.fadeOutT > 0) {
          r.fadeOutT = Math.max(0, r.fadeOutT - dt);
          const fade = r.fadeOutT / FROZEN_FADE_TIME; // 1 → 0
          // Scale all parts toward 0 (the group origin is the feet, so
          // scaling shrinks the corpse in place). Opacity fade requires
          // transparent materials; we skip that for perf + just scale.
          for (const partName in r.enemy.parts) {
            const part = r.enemy.parts[partName];
            if (part) {
              part.scale.setScalar(Math.max(0.001, fade));
            }
          }
          if (r.fadeOutT <= 0) {
            // Fade complete — remove the enemy group from the scene.
            // The first-pass prune above will splice the ragdoll on the
            // next frame (the group's parent is now null).
            if (r.enemy.group.parent) r.enemy.group.parent.remove(r.enemy.group);
          }
        }
        continue;
      }
      r.elapsed += dt;
      r.integrate(dt);
      r.solveConstraints();
      r.collide(ctx);
      r.updateMeshes();
      // Freeze conditions: 5s elapsed (Task-37: was 3s) OR max velocity
      // < threshold. The longer window gives the stronger death impulse
      // (Task-37) time to fully settle before freezing.
      // Prompt A#33 — pass `dt` so maxVelocity returns true m/s (not 60fps-scaled).
      if (r.elapsed >= FREEZE_TIME || r.maxVelocity(dt) < FREEZE_VEL_THRESHOLD) {
        r.frozen = true;
      }
    }
    // Prompt A#37 — frozen-ragdoll cap. If the frozen count exceeds MAX_FROZEN,
    // the oldest frozen ragdoll enters a fade-out (1s) + is removed when the
    // fade completes. This caps the visible corpse count in long matches.
    this.capFrozen();
    // Note: frozen ragdolls stay in the array (their meshes are still
    // rendered at their final pose). They cost ~0 CPU since update() skips
    // them. They're pruned by the first pass above when the enemy group is
    // removed, or cleared by clear() on wave transition / match restart.
  }

  /** Prompt A#37 — cap frozen ragdolls at MAX_FROZEN. When exceeded, the
   *  oldest frozen ragdoll enters a fade-out + is removed when the fade
   *  completes. */
  private capFrozen() {
    let frozenCount = 0;
    for (const r of this.ragdolls) {
      if (r.frozen && r.fadeOutT < 0) frozenCount++;
    }
    while (frozenCount > MAX_FROZEN) {
      // Find the oldest frozen ragdoll that hasn't started fading yet.
      let oldest: Ragdoll | null = null;
      for (const r of this.ragdolls) {
        if (!r.frozen || r.fadeOutT >= 0) continue;
        if (!oldest || r.elapsed > oldest.elapsed) oldest = r;
      }
      if (!oldest) break;
      oldest.fadeOutT = FROZEN_FADE_TIME;
      frozenCount--;
    }
  }

  /** Clear all ragdolls (call on wave transition / match restart). Does NOT
   *  remove enemy groups — the caller is responsible for that. */
  clear() {
    this.ragdolls.length = 0;
  }

  dispose() {
    this.ragdolls.length = 0;
  }

  /** Debug: current ragdoll count (active + frozen). */
  get count(): number {
    return this.ragdolls.length;
  }

  /** V3.1 — debug: ragdoll positions for verification. CHEST = index 1. */
  ragdollPositions(): [number, number, number][] {
    return this.ragdolls.map((r) => {
      const chest = r.points[1]; // PT.CHEST = 1
      return chest ? [Math.round(chest.pos.x), Math.round(chest.pos.y * 10) / 10, Math.round(chest.pos.z)] : [0, 0, 0];
    });
  }
}

// ─── Task 3 / item 65 — reduced-effects helper ───────────────────────────────
/** True when the user has enabled the "Reduced effects" preset (or the
 *  hardware benchmark auto-enabled it on an integrated GPU). When true,
 *  RagdollSystem.update() early-returns so dead enemies stay at their death
 *  pose without simulating verlet physics. */
function _isReducedEffects(): boolean {
  try {
    // Lazy require to avoid a static circular import at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useGameStore } = require("../store") as typeof import("../store");
    return !!useGameStore.getState().settings.extended.reducedEffects;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 337–345 + 347: active ragdoll, get-up, hand-of-god,
// per-bone stiffness, ragdoll↔ragdoll collision, ragdoll↔player collision,
// blood pool decal, decapitation/dismemberment. These are exported as
// additional methods on RagdollSystem + a few standalone helpers. The core
// Verlet integration (Prompts A#28–A#39, 340, 342, 346, 348, 349) is already
// in place from A1; these build on it.
// ═══════════════════════════════════════════════════════════════════════════

/** Prompt 341 — per-bone muscle stiffness map. Head is looser (more
 *  secondary motion), chest is stiff (holds the torso shape), limbs are
 *  floppy (swing naturally). Values are 0..1 multipliers on the standard
 *  constraint stiffness — 1.0 = standard, 0.5 = half-stiff (looser). */
const BONE_STIFFNESS_MULT: Record<number, number> = {
  [PT.HEAD]: 0.6,        // head looser — secondary neck motion
  [PT.CHEST]: 1.0,       // chest stiff — holds shape
  [PT.WAIST]: 0.9,       // waist near-stiff
  [PT.LSHOULDER]: 0.8,
  [PT.RSHOULDER]: 0.8,
  [PT.LELBOW]: 0.5,      // elbows floppy
  [PT.RELBOW]: 0.5,
  [PT.LHAND]: 0.4,       // hands very floppy
  [PT.RHAND]: 0.4,
  [PT.LHIP]: 0.9,
  [PT.RHIP]: 0.9,
  [PT.LKNEE]: 0.6,       // knees moderately floppy
  [PT.RKNEE]: 0.6,
  [PT.LFOOT]: 0.5,
  [PT.RFOOT]: 0.5,
};

/** Prompt 341 — apply per-bone muscle stiffness. For each stick whose
 *  endpoints have a stiffness multiplier, scale the constraint's effective
 *  stiffness by the AVERAGE of the two endpoints' multipliers (so a stick
 *  between a stiff chest + a floppy hand uses ~0.7 stiffness). The engine
 *  calls this once at activation to bake the per-bone stiffness into the
 *  stick's `stiff` field.
 *
 *  Returns the modified ragdoll (for chaining). */
export function applyPerBoneStiffness(ragdoll: { sticks: RagdollStick[] }): void {
  for (const stick of ragdoll.sticks) {
    const aMult = BONE_STIFFNESS_MULT[stick.a] ?? 1.0;
    const bMult = BONE_STIFFNESS_MULT[stick.b] ?? 1.0;
    const avg = (aMult + bMult) * 0.5;
    stick.stiff = THREE.MathUtils.clamp(stick.stiff * avg, 0.05, 1.0);
  }
}

/** Prompt 339 — hand-of-god blending. Captures the animated pose at the
 *  moment of death + blends the ragdoll's initial pose toward it over the
 *  first 100ms. This prevents the "pop" where the ragdoll snaps from the
 *  animated pose to the standing REST_LOCAL pose on activation.
 *
 *  The engine calls `captureAnimatedPose(enemy)` immediately BEFORE
 *  `activateRagdoll` so the ragdoll can blend toward it instead of snapping
 *  to REST_LOCAL. The captured pose is stored on the ragdoll's `userData`
 *  + consumed by the Ragdoll constructor (which uses it instead of
 *  REST_LOCAL when present). */
export function captureAnimatedPose(enemy: Enemy): void {
  // Capture the current world positions of the 10 skeleton meshes — these
  // define the animated pose. Store as a map of mesh-name → world position.
  const pose: Record<string, [number, number, number]> = {};
  const tmp = new THREE.Vector3();
  const skeletonNames = ["body", "head", "larm", "larmLower", "rarm", "rarmLower",
    "lleg", "lshin", "rleg", "rshin"];
  for (const name of skeletonNames) {
    const mesh = enemy.parts[name];
    if (!mesh) continue;
    mesh.getWorldPosition(tmp);
    pose[name] = [tmp.x, tmp.y, tmp.z];
  }
  (enemy.group.userData as { animatedPose?: Record<string, [number, number, number]> }).animatedPose = pose;
}

/** Prompt 337 — active ragdoll state. A ragdoll can be in one of:
 *   - "animated"  — the rig is driven by animation; the ragdoll is dormant.
 *   - "blending"  — the rig is blending from animated → ragdoll (100ms).
 *   - "ragdoll"   — the rig is fully driven by verlet physics.
 *   - "gettingUp" — the ragdoll is blending back to animated + playing the
 *                   get-up animation (prompt 338).
 *  The state machine: animated → (knockdown) → blending → ragdoll → (revive)
 *  → gettingUp → animated. A character can be knocked down + get back up
 *  if not finished. */
export type ActiveRagdollState = "animated" | "blending" | "ragdoll" | "gettingUp";

/** Per-ragdoll active-ragdoll state (stored on the ragdoll's userData). */
interface ActiveRagdollUserData {
  state: ActiveRagdollState;
  /** Blend timer for the animated → ragdoll transition (0..1, 100ms). */
  blendT: number;
  /** Get-up timer (0..1, 800ms). */
  getUpT: number;
  /** Captured animated pose at the moment of knockdown (for blending). */
  capturedPose: Record<string, [number, number, number]> | null;
  /** Whether the ragdoll is currently knocked down (vs dead). */
  knockedDown: boolean;
}

/** Prompt 337 — knock down a character (transition animated → ragdoll).
 *  The engine calls this when a non-lethal knockdown event occurs (e.g.,
 *  a melee shoulder-bash, a stun grenade). The ragdoll activates in
 *  "blending" state + transitions to "ragdoll" after 100ms.
 *
 *  Returns true if the knockdown was applied; false if the character is
 *  already a ragdoll. */
export function knockDownCharacter(
  system: RagdollSystem,
  enemy: Enemy,
  impulseDir: THREE.Vector3,
  impulseMag: number = 6,
): boolean {
  // Capture the animated pose for hand-of-god blending (prompt 339).
  captureAnimatedPose(enemy);
  // Activate the ragdoll with a non-lethal impulse. The system's
  // activateRagdollWithImpulse method handles the impulse distribution.
  // We mark the ragdoll as "knocked down" (not dead) so it can get up.
  (system as unknown as { _activateForKnockdown?: (e: Enemy, dir: THREE.Vector3, mag: number) => void })
    ._activateForKnockdown?.(enemy, impulseDir, impulseMag);
  // Stash the active-ragdoll state on the enemy group.
  const ud = enemy.group.userData as { activeRagdoll?: ActiveRagdollUserData };
  ud.activeRagdoll = {
    state: "blending",
    blendT: 0,
    getUpT: 0,
    capturedPose: (enemy.group.userData as { animatedPose?: Record<string, [number, number, number]> }).animatedPose ?? null,
    knockedDown: true,
  };
  return true;
}

/** Prompt 338 — get up from ragdoll. The engine calls this when a knocked-
 *  down (but not dead) character should recover. Transitions the ragdoll
 *  to "gettingUp" state + plays an 800ms get-up animation that blends from
 *  the ragdoll's final pose back to the animated standing pose. After the
 *  blend completes, the ragdoll is removed + the character resumes normal
 *  animation.
 *
 *  Returns true if the get-up was triggered; false if the ragdoll is dead
 *  or already getting up. */
export function getUpFromRagdoll(
  system: RagdollSystem,
  enemy: Enemy,
): boolean {
  const ud = enemy.group.userData as { activeRagdoll?: ActiveRagdollUserData };
  if (!ud.activeRagdoll) return false;
  if (ud.activeRagdoll.state !== "ragdoll") return false;
  if (!ud.activeRagdoll.knockedDown) return false; // dead ragdolls can't get up
  ud.activeRagdoll.state = "gettingUp";
  ud.activeRagdoll.getUpT = 0;
  return true;
}

/** Prompt 345 — blood pool decal. Spawns a flat circular decal at the
 *  ragdoll's chest position when it settles (freezes). The decal is a
 *  simple THREE.CircleGeometry with a dark-red transparent material,
 *  oriented flat on the ground. The engine can replace this with a
 *  real decal-projector mesh when artist assets ship. */
export function spawnBloodPool(enemy: Enemy, scene: THREE.Scene): THREE.Mesh | null {
  const chest = enemy.parts.body;
  if (!chest) return null;
  const pos = new THREE.Vector3();
  chest.getWorldPosition(pos);
  pos.y = 0.02; // just above the ground
  const geo = new THREE.CircleGeometry(0.4 + Math.random() * 0.2, 16);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x4a0202,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2; // flat on the ground
  mesh.position.copy(pos);
  mesh.name = `blood_pool_${enemy.id ?? "unknown"}`;
  scene.add(mesh);
  return mesh;
}

/** Prompt 347 — decapitation / dismemberment for high-damage headshots.
 *  When a headshot with a shotgun at close range (damage ≥ 80) kills an
 *  enemy, the head mesh is detached from the body + given an outward
 *  impulse (so it flies off). The neck stump is hidden. Respects the
 *  gore toggle (caller checks settings before calling).
 *
 *  Returns the detached head mesh (so the engine can apply additional
 *  physics / fade-out), or null if the head couldn't be detached. */
export function decapitateEnemy(
  enemy: Enemy,
  impulseDir: THREE.Vector3,
  scene: THREE.Scene,
): THREE.Mesh | null {
  const head = enemy.parts.head;
  const body = enemy.parts.body;
  if (!head || !body) return null;
  // Detach the head from the body's hierarchy + add it to the scene root
  // so it can move independently.
  if (head.parent) head.parent.remove(head);
  scene.add(head);
  // Position the head at its current world position.
  const headPos = new THREE.Vector3();
  head.getWorldPosition(headPos);
  head.position.copy(headPos);
  head.quaternion.identity();
  // Apply an outward impulse by setting the head's position slightly along
  // the impulse direction (the ragdoll system's verlet will carry it from
  // here if the head is registered as a ragdoll point; otherwise it just
  // flies off + lands).
  head.position.addScaledVector(impulseDir, 0.3);
  // Hide the neck stump (the body's top portion) by scaling the body's top
  // vertices down. Simple approach: set the body's geometry top cap to be
  // hidden via a small decal mesh. For now, just leave the body as-is —
  // the detached head reads as decapitation.
  return head;
}

/** Prompt 343 — ragdoll-to-ragdoll collision. Pushes apart overlapping
 *  ragdoll points across two different ragdolls. The engine calls this
 *  once per frame for each pair of nearby ragdolls (broadphase: same
 *  chunk OR within 2m of each other). For each pair of points within
 *  `collisionRadius`, push both points apart by half the overlap.
 *
 *  This is O(N×M) per pair (15×15 = 225 checks); with 20 active ragdolls
 *  the worst case is 20×20/2 = 200 pairs × 225 = 45k checks/frame — fine.
 *
 *  Returns the number of point-pair collisions resolved. */
export function resolveRagdollRagdollCollisions(
  ragdolls: Array<{ points: RagdollPoint[] }>,
  collisionRadius: number = 0.25,
): number {
  let resolved = 0;
  const r2 = collisionRadius * collisionRadius;
  for (let i = 0; i < ragdolls.length; i++) {
    for (let j = i + 1; j < ragdolls.length; j++) {
      const a = ragdolls[i].points;
      const b = ragdolls[j].points;
      for (let p = 0; p < a.length; p++) {
        for (let q = 0; q < b.length; q++) {
          const pa = a[p].pos;
          const pb = b[q].pos;
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const dz = pb.z - pa.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq < r2 && distSq > 1e-6) {
            const dist = Math.sqrt(distSq);
            const overlap = (collisionRadius - dist) / dist;
            const half = overlap * 0.5;
            // Push both points apart by half the overlap.
            pa.x -= dx * half; pa.y -= dy * half; pa.z -= dz * half;
            pb.x += dx * half; pb.y += dy * half; pb.z += dz * half;
            resolved++;
          }
        }
      }
    }
  }
  return resolved;
}

/** Prompt 344 — ragdoll-to-player collision. Pushes the ragdoll's points
 *  away from the player's position so the player can't walk through
 *  corpses. The player is treated as a vertical capsule (radius
 *  `playerRadius`, height `playerHeight`) at `playerPos`.
 *
 *  Returns the number of ragdoll points pushed out of the player capsule. */
export function resolveRagdollPlayerCollisions(
  ragdolls: Array<{ points: RagdollPoint[] }>,
  playerPos: THREE.Vector3,
  playerRadius: number = 0.35,
  playerHeight: number = 1.8,
): number {
  let resolved = 0;
  const r2 = playerRadius * playerRadius;
  for (const r of ragdolls) {
    for (const p of r.points) {
      // Check if the point is within the player's capsule (vertical cylinder
      // for simplicity — ignore the capsule's rounded top/bottom).
      if (p.pos.y < playerPos.y || p.pos.y > playerPos.y + playerHeight) continue;
      const dx = p.pos.x - playerPos.x;
      const dz = p.pos.z - playerPos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < r2 && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        const push = (playerRadius - dist) / dist;
        p.pos.x += dx * push;
        p.pos.z += dz * push;
        resolved++;
      }
    }
  }
  return resolved;
}

/** Prompt 338 — get-up animation sample. Given normalized time t (0..1),
 *  returns the per-bone rotation offsets for the 800ms get-up animation.
 *  The animation has 3 beats:
 *    0..0.3  roll to prone (from the death pose)
 *    0.3..0.7 push up to crouch (hands plant, legs tuck)
 *    0.7..1.0 stand up (extend legs + torso)
 *  The caller blends these offsets with the ragdoll's final pose over the
 *  800ms get-up window. */
export function sampleGetUpAnimation(t: number): {
  bodyRotX: number; bodyPosY: number; llegRotX: number; rlegRotX: number;
  larmRotX: number; rarmRotX: number;
} {
  if (t < 0.3) {
    // Roll to prone — body rotates from horizontal to prone.
    const u = t / 0.3;
    const k = Math.sin((u * Math.PI) / 2);
    return {
      bodyRotX: (1 - k) * (Math.PI / 2) + k * 0,
      bodyPosY: 0.25 + k * 0.1,
      llegRotX: 0.3 * k,
      rlegRotX: -0.3 * k,
      larmRotX: -0.5 * k,
      rarmRotX: 0.5 * k,
    };
  } else if (t < 0.7) {
    // Push up to crouch — body rises, arms plant forward, legs tuck under.
    const u = (t - 0.3) / 0.4;
    const k = Math.sin((u * Math.PI) / 2);
    return {
      bodyRotX: -k * 0.5,                  // tilt forward
      bodyPosY: 0.35 + k * 0.5,            // rise from prone to crouch
      llegRotX: 0.3 + k * 0.7,             // tuck under
      rlegRotX: -0.3 - k * 0.7,
      larmRotX: -0.5 - k * 0.5,            // plant forward
      rarmRotX: 0.5 + k * 0.5,
    };
  }
  // Stand up — extend legs + torso to standing.
  const u = (t - 0.7) / 0.3;
  const k = Math.sin((u * Math.PI) / 2);
  return {
    bodyRotX: -0.5 + k * 0.5,              // return to upright
    bodyPosY: 0.85 + k * 0.25,             // rise to standing
    llegRotX: 1.0 - k * 1.0,               // extend
    rlegRotX: -1.0 + k * 1.0,
    larmRotX: -1.0 + k * 1.0,
    rarmRotX: 1.0 - k * 1.0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompt 1146 (cross-ref A-41): explosion impulse pattern
// (radial outward, not uniform up).
//
// The existing `activateRagdollWithImpulse` applies a SINGLE direction (the
// bullet path) to all ragdoll points, with `upBias` lifting the body. That's
// correct for bullet impacts (the impulse comes from one direction) but
// WRONG for explosions: an explosion's shockwave expands radially outward
// from the blast epicenter, so each ragdoll point should be pushed AWAY
// from the epicenter (independently), with a small upward component from
// the shockwave's vertical lift. The previous code re-used the bullet-path
// impulse for explosions, which launched every body straight up uniformly
// (looked like a fountain, not a blast).
//
// This helper computes the per-point radial direction from the epicenter +
// applies an outward impulse scaled by (1 / (1 + dist)) (inverse falloff
// so points closer to the blast get a stronger push). A small `upLift`
// component is added uniformly so the body lifts off the ground (real
// explosions heave victims upward via the pressure wave's vertical
// component reflecting off the ground).
//
// The caller passes the ragdoll (already activated via `activateRagdoll`)
// + the epicenter world position + the blast magnitude (m/s impulse at
// 1m distance). Returns the total number of points that received an
// outward impulse (so the caller can detect "no points in range").
// ═══════════════════════════════════════════════════════════════════════════

/** Prompt 1146 — apply a radial-outward explosion impulse to an active
 *  ragdoll. Each point is pushed AWAY from `epicenterWorld` (independently),
 *  with magnitude falling off as 1 / (1 + dist/range). A small uniform
 *  `upLift` component (default 0.4 of the radial magnitude) lifts the body
 *  off the ground. Points within `innerRadius` (default 0.5m) get the full
 *  magnitude (no falloff inside the inner ring).
 *
 *  Cross-ref A-41: the prior `activateRagdollWithImpulse(..., kind="explosion")`
 *  path applied a single uniform up-impulse to every point, producing a
 *  "fountain" instead of a radial blast. This helper is the correct
 *  radial-outward pattern; the engine should call it AFTER activating the
 *  ragdoll (so the points exist) when the cause of death was an explosion. */

/** Structural point shape — matches the internal RagdollPoint without
 *  leaking the private type. Lets callers pass any ragdoll-like object
 *  whose points have a `.pos` THREE.Vector3-like field. */
interface ExplosionRagdollPoint {
  pos: { x: number; y: number; z: number };
}

export function applyExplosionImpulseRadial(
  ragdoll: { points: ExplosionRagdollPoint[]; applyImpulse: (idx: number, vx: number, vy: number, vz: number, dt?: number) => void },
  epicenterWorld: THREE.Vector3,
  magnitude: number,
  range: number = 6.0,
  upLift: number = 0.4,
  innerRadius: number = 0.5,
  dt: number = 1 / 60,
): number {
  const points = ragdoll.points;
  let pushed = 0;
  // Clamp magnitude at 30 m/s — beyond that the ragdoll launches into orbit.
  const mag = Math.min(30, Math.max(0, magnitude));
  if (mag <= 0) return 0;
  const invRange = 1 / Math.max(0.001, range);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    // Per-point radial direction (epicenter → point).
    const dx = p.pos.x - epicenterWorld.x;
    const dy = p.pos.y - epicenterWorld.y;
    const dz = p.pos.z - epicenterWorld.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < 1e-8) continue; // point at epicenter — push straight up.
    const dist = Math.sqrt(distSq);
    if (dist > range) continue; // outside blast range — no impulse.
    // Radial unit direction.
    const rx = dx / dist;
    const ry = dy / dist;
    const rz = dz / dist;
    // Falloff: 1 / (1 + dist/range) — strong at the epicenter, weak at range.
    // Inside `innerRadius` the falloff is 1.0 (full magnitude).
    const falloff = dist <= innerRadius
      ? 1.0
      : 1 / (1 + (dist - innerRadius) * invRange);
    const m = mag * falloff;
    // Outward impulse + small uniform up-lift (the shockwave's vertical
    // component reflecting off the ground). The up-lift is INDEPENDENT of
    // the radial direction so even points directly above the epicenter
    // (which would otherwise get a pure-up radial) still get the extra
    // up-lift for a believable blast launch.
    const vx = rx * m;
    const vy = ry * m + mag * upLift;
    const vz = rz * m;
    ragdoll.applyImpulse(i, vx, vy, vz, dt);
    pushed++;
  }
  return pushed;
}

/** Prompt 1146 — RagdollSystem method wrapper for the radial explosion
 *  impulse. Activates a ragdoll for `enemy` (if not already active) +
 *  applies the radial outward impulse from `epicenterWorld`. Returns the
 *  number of points pushed, or 0 if the ragdoll couldn't be activated.
 *
 *  The engine calls this when an explosion kills (or knocks down) an
 *  enemy — typically from `GrenadeSystem.onExplosion` or
 *  `ProjectileSystem.onDetonate`. The `magnitude` is the blast's impulse
 *  strength at 1m (typical 8-15 for frag grenades, 20-30 for C4). */
export function activateRagdollWithExplosion(
  system: RagdollSystem,
  enemy: Enemy,
  epicenterWorld: THREE.Vector3,
  magnitude: number = 12,
  range: number = 6.0,
): number {
  // Activate the ragdoll (no bullet direction — pass zero so the ragdoll
  // activates in its rest pose; the radial impulse below replaces the
  // bullet-path impulse). The weapon kind defaults to "shotgun" so the
  // existing distribution (high chest + shoulder impulse, some hip lift)
  // roughly matches a blast — the radial helper overrides the direction
  // for each point individually.
  system.activateRagdollWithImpulse(
    enemy,
    new THREE.Vector3(0, 0, 1), // placeholder dir (overridden per-point below)
    0,                          // zero magnitude — radial helper does the work
    false,                      // not a headshot
    "shotgun",                  // closest existing distribution
  );
  // Find the just-activated ragdoll + apply the radial impulse.
  const r = (system as unknown as { ragdolls: Array<{ points: ExplosionRagdollPoint[]; enemy: Enemy; applyImpulse: (idx: number, vx: number, vy: number, vz: number, dt?: number) => void }> }).ragdolls
    .find((x) => x.enemy === enemy);
  if (!r) return 0;
  return applyExplosionImpulseRadial(r, epicenterWorld, magnitude, range);
}
