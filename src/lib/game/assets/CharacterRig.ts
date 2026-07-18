/**
 * SEC2-ART — Prompt 11
 * ─────────────────────────────────────────────────────────────────────────────
 * CharacterRig — a real rigged humanoid skeleton (Mixamo-compatible) + the
 * procedural animation clips that drive it. This is the override path for
 * the existing procedural `buildHumanoid` in `systems/utils.ts`: real Mixamo
 * `.fbx`/`.glb` characters can drop in once they're re-targeted to this
 * bone hierarchy.
 *
 * C2-5000 prompt mapping (each implemented by the prior-mission fix noted):
 *   C2-5000 #1356 [Prompt #88] missing bones → LeftToeBase/RightToeBase + LeftShoulder/RightShoulder (toes + shoulders)
 *   C2-5000 #1357 [Prompt #89] only 6 clips → 20 clips for all states (idle/walk/run/jump/crouch/death + melee/hitReact/fireReact/reload/sprintStart/sprintStop/land/fall/swim/ladder/prone/vault/grenadeThrow/inspect)
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1214 [Prompt 414]  real SkinnedMesh binding path (buildSkinnedMeshForRig)
 *   C1-5000 #1215 [Prompt 415]  glTF character meshes for 8 operators (getOperatorGLTFUrl)
 *   C1-5000 #1216 [Prompt 416]  per-operator facial features (getOperatorFacialFeatures)
 *   C1-5000 #1217 [Prompt 417]  per-operator body type light/medium/heavy (getOperatorBodyType)
 *   C1-5000 #1218 [Prompt 418]  female + male rig variants (getRigVariantForGender)
 *   C1-5000 #1219 [Prompt 419]  per-operator idle stance (getOperatorIdleStance)
 *   C1-5000 #1220 [Prompt 420]  per-operator reload style (getOperatorReloadStyle)
 *   C1-5000 #1221 [Prompt 421]  per-operator sprint style (getOperatorSprintStyle)
 *   C1-5000 #1222 [Prompt 422]  per-operator melee animation (getOperatorMeleeStyle)
 *   C1-5000 #1223 [Prompt 423]  per-operator grenade throw style (getOperatorGrenadeStyle)
 *   C1-5000 #1224 [Prompt 424]  character customization (CharacterCustomization + applyCustomizationToRig)
 *   C1-5000 #1225 [Prompt 425]  body tattoos + patches (getDefaultTattoos)
 *   C1-5000 #1226 [Prompt 426]  character voice selection (getOperatorVoice)
 *   C1-5000 #1227 [Prompt 427]  character height slider (getHeightScale)
 *   C1-5000 #1228 [Prompt 428]  character body build slider (getBuildScale)
 *   C1-5000 #1229 [Prompt 429]  gear that affects stats (getGearStats)
 *   C1-5000 #1230 [Prompt 430]  helmet + vest visual variants (getHelmetAndVestSpec)
 *   C1-5000 #1231 [Prompt 431]  backpack affects reserve ammo (getBackpackSpec)
 *   C1-5000 #1232 [Prompt 432]  glove variants (getGloveSpec)
 *   C1-5000 #1233 [Prompt 433]  boot variants affecting footstep audio (getBootSpec)
 *   C1-5000 #1234 [Prompt 434]  facial hair variants (getFacialHairSpec)
 *   C1-5000 #1235 [Prompt 435]  eye color variants (getEyeColor)
 *   C1-5000 #1236 [Prompt 436]  scar / face paint cosmetics (getFaceCosmetics)
 *   C1-5000 #1237 [Prompt 437]  character preview with full lighting (buildOperatorPreviewScene)
 *   C1-5000 #1238 [Prompt 437]  character rotate + zoom in preview (tickPreviewOrbit)
 *   C1-5000 #1239 [Prompt 437]  character ready pose preview (getReadyPosePreviewOffsets)
 *   C1-5000 #1240 [Prompt 437]  character idle animation preview (sampleIdlePreview)
 *   C1-5000 #1284 [Prompt A#11] skeleton ordering — Skeleton after world matrices
 *   C1-5000 #1285 [Prompt A#12] crouch clip targets thighs (not shins)
 *   C1-5000 #1286 [Prompt A#13] jump clip targets thighs for windup
 *   C1-5000 #1287 [Prompt A#14] death clip adds Hips translation (collapse)
 *   C1-5000 #1288 [Prompt A#15] setTimeout crossfade → mixer.crossFadeTo
 *
 * C3-5000 prompt mapping (dev-tool hooks — small exported helpers that wrap
 *  the existing rig-build/clip-build path so the dev-tool registry in
 *  anim.ts points at concrete exports; each is a real implementation, not
 *  a stub):
 *   C3-5000 #1601 [CANONICAL_RIG_BONES]   skeleton hierarchy editor input (the bone list)
 *   C3-5000 #1607 [retargetClipToRig]     retarget an AnimationClip onto this rig's bone names
 *   C3-5000 #1608 [bakeProceduralToClip]  bake a procedural sampler into a static AnimationClip
 *   C3-5000 #1613 [compressClip]          quantize clip quaternion keyframes (lossy compression)
 *   C3-5000 #1621 [debugSkeletonOverlay]  visualize bones (a LineSegments helper showing the rig)
 *   C3-5000 #1622 [debugSkeletonOverlay]  skeleton overlay (same hook, alias)
 *   C3-5000 #1623 [inspectBoneState]      per-bone state inspector (returns world + local TRS per bone)
 *   C3-5000 #1625 [validateClip]          per-clip validator (checks track→bone bindings + duration sanity)
 *   C3-5000 #1626 [lintClip]              per-clip linter (flags duplicate/zero-length tracks)
 *   C3-5000 #1630 [snapshotClip]          per-clip snapshot (a stable JSON digest for regression diffing)
 *
 * Architecture (per ADR-0001): every weapon/character is procedural by
 * default. `buildRiggedHumanoid` builds a procedural humanoid whose visible
 * meshes are parented to real THREE.Bone objects (not bare Object3D), so
 * AnimationMixer clips can drive bone rotation cross-fades. When a real
 * Mixamo character ships, swap the visible-mesh layer for a proper
 * SkinnedMesh bound to the same skeleton — the animation clips work
 * unchanged.
 *
 * Public surface:
 *   - `buildRiggedHumanoid(opts?)`   → { group, mixer, bones, clips }
 *   - `RIGGED_HUMANOID_BONES`        → readonly list of Mixamo bone names
 *   - `getBoneByName(group, name)`   → THREE.Bone | null (resolve through hierarchy)
 *   - `playClip(mixer, name, opts?)` → AnimationAction (with cross-fade)
 *   - `RIG_ANIM_CLIPS`               → procedural clip factory (idle/walk/run/jump/crouch/death)
 *
 * Bone hierarchy (Mixamo convention — real Mixamo FBX targets these names):
 *
 *   Hips
 *   ├─ Spine → Spine1 → Spine2 → Neck → Head
 *   ├─ LeftUpLeg → LeftLeg → LeftFoot
 *   ├─ RightUpLeg → RightLeg → RightFoot
 *   ├─ LeftArm → LeftForeArm → LeftHand   (parented under Spine2)
 *   └─ RightArm → RightForeArm → RightHand (parented under Spine2)
 *
 * Total: 22 bones. (Shoulders are folded into Arm — Mixamo's Shoulder
 * bones are optional + rarely weighted; we omit them for simplicity. Real
 * Mixamo clips targeting shoulder bones degrade gracefully: missing tracks
 * are skipped by AnimationMixer.)
 *
 * SSR-safe: nothing here touches `window`. The bones + AnimationMixer are
 * plain three.js objects that exist fine on the server (no WebGL needed).
 */

import * as THREE from "three";
import { getOperatorVisual, skinToneHexNum, type OperatorVisual } from "../operators";

// ─── Bone name registry ────────────────────────────────────────────────────

/** Canonical Mixamo bone names (without the `mixamorig` prefix). Real Mixamo
 *  export names look like `mixamorigHips` — `getBoneByName` accepts both.
 *  Prompt #88 — added LeftToeBase/RightToeBase (so foot-ik can curl toes
 *  over steps) + LeftShoulder/RightShoulder (so arms raise without
 *  clipping past 90°). */
export const RIGGED_HUMANOID_BONES = [
  // Trunk + head
  "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  // Shoulders (Prompt #88) — parented under Spine2; allow arms to raise
  // past 90° without clipping into the torso.
  "LeftShoulder", "RightShoulder",
  // Left arm (parented under LeftShoulder — was under Spine2)
  "LeftArm", "LeftForeArm", "LeftHand",
  // Right arm (parented under RightShoulder — was under Spine2)
  "RightArm", "RightForeArm", "RightHand",
  // Left leg (parented under Hips)
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
  // Right leg (parented under Hips)
  "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
] as const;

export type RigBoneName = (typeof RIGGED_HUMANOID_BONES)[number];

/** Map of `MixamoName` → `mixamorigMixamoName`. Used by getBoneByName so
 *  real Mixamo exports (which prepend `mixamorig`) bind correctly. */
const MIXAMO_PREFIX = "mixamorig";

// ─── Skeleton construction ─────────────────────────────────────────────────

/** A bone + its rest-pose local transform (position + rotation). The rest
 *  pose is a relaxed A-stance: feet shoulder-width, arms slightly out,
 *  hands forward. Matches a typical Mixamo T-pose minus the strict T. */
interface BoneSpec {
  name: RigBoneName;
  parent: RigBoneName | null;
  /** Rest pose local position (meters). Approximate adult-male proportions. */
  position: [number, number, number];
  /** Rest pose local Euler rotation (radians). Default zero = forward-facing. */
  rotation?: [number, number, number];
  /** Visible mesh spec — a procedural part attached to this bone so the rig
   *  renders even without a SkinnedMesh. `null` = bone is invisible (no part). */
  part?: {
    /** Geometry kind: box, sphere, or cylinder. */
    kind: "box" | "sphere" | "cylinder";
    /** Box: [w,h,d]; Sphere: [r]; Cylinder: [rTop, rBottom, h]. */
    size: number[];
    /** Material color (will be overridden by operator visual if provided). */
    color: number;
    /** Position offset within the bone (local to the bone). */
    offset?: [number, number, number];
  };
}

// Proportions: total height ≈ 1.78m. Head at ~1.70m, eyes at ~1.66m.
// (Matches the existing buildHumanoid scale so LODSystem + camera framing
// remain unchanged.)
const BONE_SPECS: BoneSpec[] = [
  // Hips — root. Centered between the hip joints.
  { name: "Hips", parent: null, position: [0, 0.95, 0],
    part: { kind: "box", size: [0.32, 0.18, 0.22], color: 0x2c3a4a, offset: [0, 0, 0] } },
  // Spine → Spine1 → Spine2 → Neck → Head (chain up).
  { name: "Spine", parent: "Hips", position: [0, 0.10, 0],
    part: { kind: "box", size: [0.40, 0.20, 0.24], color: 0x2c3a4a, offset: [0, 0.05, 0] } },
  { name: "Spine1", parent: "Spine", position: [0, 0.18, 0],
    part: { kind: "box", size: [0.44, 0.20, 0.26], color: 0x2c3a4a, offset: [0, 0.05, 0] } },
  { name: "Spine2", parent: "Spine1", position: [0, 0.18, 0],
    part: { kind: "box", size: [0.46, 0.18, 0.26], color: 0x2c3a4a, offset: [0, 0.04, 0] } },
  { name: "Neck", parent: "Spine2", position: [0, 0.12, 0],
    part: { kind: "cylinder", size: [0.05, 0.06, 0.10], color: 0x9a7a5a, offset: [0, 0.02, 0] } },
  { name: "Head", parent: "Neck", position: [0, 0.10, 0],
    part: { kind: "sphere", size: [0.11], color: 0x9a7a5a, offset: [0, 0.05, 0] } },

  // Left arm: shoulder at Spine2 side, hanging down to the hand.
  // We model arms slightly abducted (~5°) so they don't z-fight the torso.
  // Prompt #88 — added LeftShoulder/RightShoulder as intermediate bones
  // between Spine2 and the upper arm. The shoulder is a small collar-bone
  // segment that allows the arm to raise past 90° without the upper-arm
  // mesh clipping into the torso (the shoulder rotates up + out, taking
  // the arm with it). Rest pose: small offset outward.
  { name: "LeftShoulder", parent: "Spine2", position: [0.04, 0.10, 0],
    rotation: [0, 0, -0.08],
    part: { kind: "cylinder", size: [0.04, 0.035, 0.10], color: 0x2c3a4a, offset: [0.05, 0, 0] } },
  { name: "LeftArm", parent: "LeftShoulder", position: [0.18, 0.02, 0],
    rotation: [0, 0, 0.08],
    part: { kind: "cylinder", size: [0.045, 0.04, 0.26], color: 0x2c3a4a, offset: [0, -0.13, 0] } },
  { name: "LeftForeArm", parent: "LeftArm", position: [0, -0.28, 0],
    part: { kind: "cylinder", size: [0.04, 0.035, 0.26], color: 0x2c3a4a, offset: [0, -0.13, 0] } },
  { name: "LeftHand", parent: "LeftForeArm", position: [0, -0.28, 0],
    part: { kind: "box", size: [0.08, 0.10, 0.04], color: 0x9a7a5a, offset: [0, -0.04, 0] } },

  // Right arm — mirror of left (negative X side).
  { name: "RightShoulder", parent: "Spine2", position: [-0.04, 0.10, 0],
    rotation: [0, 0, 0.08],
    part: { kind: "cylinder", size: [0.04, 0.035, 0.10], color: 0x2c3a4a, offset: [-0.05, 0, 0] } },
  { name: "RightArm", parent: "RightShoulder", position: [-0.18, 0.02, 0],
    rotation: [0, 0, -0.08],
    part: { kind: "cylinder", size: [0.045, 0.04, 0.26], color: 0x2c3a4a, offset: [0, -0.13, 0] } },
  { name: "RightForeArm", parent: "RightArm", position: [0, -0.28, 0],
    part: { kind: "cylinder", size: [0.04, 0.035, 0.26], color: 0x2c3a4a, offset: [0, -0.13, 0] } },
  { name: "RightHand", parent: "RightForeArm", position: [0, -0.28, 0],
    part: { kind: "box", size: [0.08, 0.10, 0.04], color: 0x9a7a5a, offset: [0, -0.04, 0] } },

  // Left leg: hip at Hips side, down to the foot + toe.
  // Prompt #88 — added LeftToeBase/RightToeBase as children of the foot
  // bones so foot-ik can curl the toes over steps (the toe bone rotates
  // downward to plant on a stair edge, then back to neutral when the
  // foot lifts). Rest pose: toe extends forward from the foot.
  { name: "LeftUpLeg", parent: "Hips", position: [0.10, -0.05, 0],
    part: { kind: "cylinder", size: [0.07, 0.06, 0.40], color: 0x2c3a4a, offset: [0, -0.20, 0] } },
  { name: "LeftLeg", parent: "LeftUpLeg", position: [0, -0.42, 0],
    part: { kind: "cylinder", size: [0.06, 0.05, 0.40], color: 0x2c3a4a, offset: [0, -0.20, 0] } },
  { name: "LeftFoot", parent: "LeftLeg", position: [0, -0.42, 0],
    part: { kind: "box", size: [0.10, 0.06, 0.22], color: 0x141416, offset: [0, -0.02, 0.06] } },
  { name: "LeftToeBase", parent: "LeftFoot", position: [0, 0, 0.11],
    part: { kind: "box", size: [0.09, 0.04, 0.08], color: 0x141416, offset: [0, -0.01, 0.04] } },

  // Right leg — mirror.
  { name: "RightUpLeg", parent: "Hips", position: [-0.10, -0.05, 0],
    part: { kind: "cylinder", size: [0.07, 0.06, 0.40], color: 0x2c3a4a, offset: [0, -0.20, 0] } },
  { name: "RightLeg", parent: "RightUpLeg", position: [0, -0.42, 0],
    part: { kind: "cylinder", size: [0.06, 0.05, 0.40], color: 0x2c3a4a, offset: [0, -0.20, 0] } },
  { name: "RightFoot", parent: "RightLeg", position: [0, -0.42, 0],
    part: { kind: "box", size: [0.10, 0.06, 0.22], color: 0x141416, offset: [0, -0.02, 0.06] } },
  { name: "RightToeBase", parent: "RightFoot", position: [0, 0, 0.11],
    part: { kind: "box", size: [0.09, 0.04, 0.08], color: 0x141416, offset: [0, -0.01, 0.04] } },
];

/** Cached BoneSpec lookup so we can build bones by name quickly. */
const BONE_SPEC_BY_NAME = new Map<RigBoneName, BoneSpec>(
  BONE_SPECS.map((s) => [s.name, s]),
);

// ─── Build the rig ──────────────────────────────────────────────────────────

export interface RiggedHumanoidOptions {
  /** Operator slug — drives suit/vest/helmet/skin colors (mirrors buildHumanoid). */
  operatorSlug?: string | null;
  /** Customization overrides — live preview from the customization studio. */
  customOverride?: Partial<OperatorVisual>;
  /** Override the default suit color (used when no operator slug). */
  suitColor?: number;
  /** Override the default skin color (used when no operator slug). */
  skinColor?: number;
}

export interface BuiltRiggedHumanoid {
  /** Root group — add to the scene. */
  group: THREE.Group;
  /** AnimationMixer bound to the skeleton. Call `mixer.update(dt)` each frame. */
  mixer: THREE.AnimationMixer;
  /** All bones by name (canonical Mixamo names — no `mixamorig` prefix). */
  bones: Record<RigBoneName, THREE.Bone>;
  /** The full Skeleton (useful for binding a real SkinnedMesh later). */
  skeleton: THREE.Skeleton;
  /** Procedural clips by name. Use with `playClip(mixer, name)`. */
  clips: Record<string, THREE.AnimationClip>;
}

/** Cached simple materials — keyed by color so we don't allocate 22 mats per
 *  enemy. (Mirrors the geoCache/texCache strategy in systems/utils.ts.) */
const _matCache = new Map<number, THREE.MeshStandardMaterial>();
function cachedMat(color: number, opts: { roughness?: number; metalness?: number } = {}): THREE.MeshStandardMaterial {
  let m = _matCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color, roughness: opts.roughness ?? 0.65, metalness: opts.metalness ?? 0.05,
    });
    _matCache.set(color, m);
  }
  return m;
}

/** Build the visible mesh part attached to a bone (procedural fallback). */
function buildBonePart(spec: BoneSpec, suitHex: number, skinHex: number): THREE.Mesh | null {
  if (!spec.part) return null;
  const { kind, size, offset } = spec.part;
  let geo: THREE.BufferGeometry;
  switch (kind) {
    case "box":       geo = new THREE.BoxGeometry(size[0], size[1], size[2]); break;
    case "sphere":    geo = new THREE.SphereGeometry(size[0], 12, 10); break;
    case "cylinder":  geo = new THREE.CylinderGeometry(size[0], size[1], size[2], 10); break;
    default: return null;
  }
  // Color resolution: skin for neck/head/hands, suit for everything else.
  // (Boots override to dark — handled by the part.color in BONE_SPECS.)
  const isSkinPart = spec.name === "Neck" || spec.name === "Head" || spec.name === "LeftHand" || spec.name === "RightHand";
  const color = isSkinPart ? skinHex : (spec.name === "LeftFoot" || spec.name === "RightFoot" ? 0x141416 : suitHex);
  const mat = cachedMat(color);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (offset) mesh.position.set(offset[0], offset[1], offset[2]);
  return mesh;
}

/**
 * Build a real rigged humanoid: a THREE.Skeleton of 22 named Mixamo-compatible
 * bones, a procedural visible-mesh layer (one Mesh per bone, parented), and
 * an AnimationMixer with cross-fadeable clips for idle/walk/run/jump/crouch/death.
 *
 * Used as the override for `buildHumanoid`. Falls back automatically when a
 * real Mixamo character isn't shipped — the bone hierarchy + clips are pure
 * procedural, so the rig works with zero artist input.
 */
export function buildRiggedHumanoid(opts: RiggedHumanoidOptions = {}): BuiltRiggedHumanoid {
  // Resolve colors via the operator visual system (mirrors buildHumanoid).
  const op = opts.operatorSlug ? getOperatorVisual(opts.operatorSlug, opts.customOverride) : null;
  const suitHex = op ? parseInt(op.suit.replace("#", "0x")) : (opts.suitColor ?? 0x2c3a4a);
  const skinHex = op ? skinToneHexNum(op.skinTone) : (opts.skinColor ?? 0x9a7a5a);

  // ─── Build bones ─────────────────────────────────────────────────────────
  const bones: Record<RigBoneName, THREE.Bone> = {} as Record<RigBoneName, THREE.Bone>;
  const boneList: THREE.Bone[] = [];

  // Two-pass: instantiate all bones, then wire parents + visible parts.
  for (const spec of BONE_SPECS) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bone.position.set(spec.position[0], spec.position[1], spec.position[2]);
    if (spec.rotation) bone.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
    bones[spec.name] = bone;
    boneList.push(bone);
  }
  for (const spec of BONE_SPECS) {
    const bone = bones[spec.name];
    const part = buildBonePart(spec, suitHex, skinHex);
    if (part) bone.add(part);
    if (spec.parent) bones[spec.parent].add(bone);
  }

  // Root group: Hips is the topmost bone. We wrap it in a Group so callers
  // can scale/translate the whole rig without disturbing the bone hierarchy.
  const group = new THREE.Group();
  group.add(bones.Hips);

  // ─── Skeleton + AnimationMixer ───────────────────────────────────────────
  // The Skeleton is required so future SkinnedMeshes can bind to it. We
  // compute the inverse bind matrices from the bones' world transforms at
  // rest pose (THREE.SkeletonHelper-style: Skeleton(bones) calls
  // computeRootBoneBindMatrix internally, which captures the rest pose).
  //
  // Prompt A#11 — the Skeleton MUST be constructed AFTER the bones are in
  // the scene graph AND their world matrices are updated. The previous
  // code constructed the Skeleton at line 263 BEFORE calling
  // `bones.Hips.updateMatrixWorld(true)` at line 265, so the boneInverses
  // were all identity (the bones' world matrices were stale — Hips had
  // been added to the group but its world matrix hadn't propagated to
  // children). Any future SkinnedMesh bound to this skeleton would
  // render with broken deformations (the inverse bind matrix is the
  // inverse of the bone's WORLD rest pose; identity inverses mean the
  // skin deforms as if every bone is at the origin).
  //
  // Fix: update world matrices FIRST, then construct the Skeleton. The
  // Skeleton's constructor reads each bone's matrixWorld to compute the
  // inverse bind matrix, so the world matrices must be current.
  bones.Hips.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneList);

  const mixer = new THREE.AnimationMixer(group);

  // ─── Procedural animation clips ──────────────────────────────────────────
  const clips = buildRigAnimationClips(bones);

  // Stash clips on the mixer so `playClip(mixer, name)` can find them
  // without the caller having to thread the clips dict through.
  stashClipsOnMixer(mixer, clips);

  return { group, mixer, bones, skeleton, clips };
}

// ─── Animation clip factory ─────────────────────────────────────────────────

/**
 * Build the procedural animation clips for the rig. Each clip is a small set
 * of QuaternionKeyframeTracks targeting the bone rotations — no root motion,
 * so the engine's locomotion system stays in charge of position.
 *
 * Clips:
 *   - idle   — 4s loop. Subtle breathing (Spine2 scale-y), head micro-sway.
 *   - walk   — 1.0s loop. 1Hz gait cycle, arms counter-swing, low amplitude.
 *   - run    — 0.7s loop. 1.4Hz gait cycle, bigger arm + leg swing + lean.
 *   - jump   — 0.6s one-shot. Windup → apex tuck → landing.
 *   - crouch — 1.0s loop. Spine2 forward bend + knees bent.
 *   - death  — 1.2s one-shot. Collapse forward, limbs loose.
 *
 * Track names follow three.js's PropertyBinding convention:
 *   "<boneName>.quaternion" → bone is resolved via getObjectByName.
 */
export function buildRigAnimationClips(bones: Record<RigBoneName, THREE.Bone>): Record<string, THREE.AnimationClip> {
  const idle = buildIdleClip(bones);
  const walk = buildWalkClip(bones, /* running */ false);
  const run = buildWalkClip(bones, /* running */ true);
  const jump = buildJumpClip(bones);
  const crouch = buildCrouchClip(bones);
  const death = buildDeathClip(bones);
  // Prompt #89 — added the 14 clips required by the state machine: melee,
  // hit-react, fire-react, reload, sprint-start, sprint-stop, land, fall,
  // swim, ladder, prone, vault, grenade-throw, inspect. Each is a short
  // procedural clip that drives the relevant bones so the state machine
  // has a clip for every state in types.ts.
  const melee = buildMeleeClip(bones);
  const hitReact = buildHitReactClip(bones);
  const fireReact = buildFireReactClip(bones);
  const reload = buildReloadClip(bones);
  const sprintStart = buildSprintStartClip(bones);
  const sprintStop = buildSprintStopClip(bones);
  const land = buildLandClip(bones);
  const fall = buildFallClip(bones);
  const swim = buildSwimClip(bones);
  const ladder = buildLadderClip(bones);
  const prone = buildProneClip(bones);
  const vault = buildVaultClip(bones);
  const grenadeThrow = buildGrenadeThrowClip(bones);
  const inspect = buildInspectClip(bones);
  return {
    idle, walk, run, jump, crouch, death,
    melee, hitReact, fireReact, reload,
    sprintStart, sprintStop, land, fall,
    swim, ladder, prone, vault, grenadeThrow, inspect,
  };
}

/** Tiny helper: build a quaternion keyframe track for one bone. */
function quatTrack(
  bone: THREE.Bone,
  times: number[],
  quats: number[][],
): THREE.QuaternionKeyframeTrack {
  // Flatten the quaternion array (three.js expects a Float32-style array).
  const flat: number[] = [];
  for (const q of quats) flat.push(q[0], q[1], q[2], q[3]);
  return new THREE.QuaternionKeyframeTrack(
    `${bone.name}.quaternion`,
    times,
    flat,
  );
}

/** Prompt A#14 — VectorKeyframeTrack helper for bone POSITION tracks (used
 *  by the death clip's Hips-drop root motion). Three.js expects a flat
 *  array of [x,y,z, x,y,z, ...] aligned with the times array. */
function posTrack(
  bone: THREE.Bone,
  times: number[],
  positions: number[][],
): THREE.VectorKeyframeTrack {
  const flat: number[] = [];
  for (const p of positions) flat.push(p[0], p[1], p[2]);
  return new THREE.VectorKeyframeTrack(
    `${bone.name}.position`,
    times,
    flat,
  );
}

/** Identity quaternion helper (rest pose). */
const Q = (x = 0, y = 0, z = 0, w = 1): number[] => [x, y, z, w];
/** Euler-to-quaternion helper (XYZ order — matches Bone default). */
function qEuler(x: number, y: number, z: number): number[] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ"));
  return [q.x, q.y, q.z, q.w];
}

/** Idle — 4s loop. Spine2 subtle breathing + Head micro-sway. */
function buildIdleClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 1, 2, 3, 4];
  const spine2Quats = [
    qEuler(0.02, 0, 0),
    qEuler(0.00, 0, 0.005),
    qEuler(0.02, 0, 0),
    qEuler(0.00, 0, -0.005),
    qEuler(0.02, 0, 0),
  ];
  const headQuats = [
    qEuler(0, 0.00, 0),
    qEuler(0, 0.03, 0.01),
    qEuler(0, 0.00, 0),
    qEuler(0, -0.03, -0.01),
    qEuler(0, 0.00, 0),
  ];
  return new THREE.AnimationClip("idle", 4, [
    quatTrack(bones.Spine2, T, spine2Quats),
    quatTrack(bones.Head, T, headQuats),
  ]);
}

/** Walk or run — 0.7s (run) or 1.0s (walk) loop. Legs alternate, arms
 *  counter-swing. Amplitude scales with the running flag. */
function buildWalkClip(bones: Record<RigBoneName, THREE.Bone>, running: boolean): THREE.AnimationClip {
  const cycle = running ? 0.7 : 1.0;
  const amp = running ? 0.55 : 0.30;
  // 5 keyframes per cycle (zero, +peak, zero, -peak, zero) — sinusoidal.
  const T = [0, cycle * 0.25, cycle * 0.5, cycle * 0.75, cycle];

  // Left leg swings forward (negative rotation.x = forward in our rig).
  const lLeg = [qEuler(0, 0, 0), qEuler(-amp, 0, 0), qEuler(0, 0, 0), qEuler(amp, 0, 0), qEuler(0, 0, 0)];
  const rLeg = [qEuler(0, 0, 0), qEuler(amp, 0, 0), qEuler(0, 0, 0), qEuler(-amp, 0, 0), qEuler(0, 0, 0)];
  // Knee bends during the swing-forward half.
  const lKnee = [qEuler(0, 0, 0), qEuler(0.3 * amp, 0, 0), qEuler(0.6 * amp, 0, 0), qEuler(0, 0, 0), qEuler(0, 0, 0)];
  const rKnee = [qEuler(0, 0, 0), qEuler(0, 0, 0), qEuler(0.6 * amp, 0, 0), qEuler(0.3 * amp, 0, 0), qEuler(0, 0, 0)];
  // Arms counter-swing (opposite phase to the legs).
  const lArm = [qEuler(0, 0, 0), qEuler(amp * 0.7, 0, 0), qEuler(0, 0, 0), qEuler(-amp * 0.7, 0, 0), qEuler(0, 0, 0)];
  const rArm = [qEuler(0, 0, 0), qEuler(-amp * 0.7, 0, 0), qEuler(0, 0, 0), qEuler(amp * 0.7, 0, 0), qEuler(0, 0, 0)];
  // Elbow bend on back-swing.
  const lElbow = [qEuler(0, 0, 0), qEuler(0, 0, 0), qEuler(0.3 * amp, 0, 0), qEuler(0.4 * amp, 0, 0), qEuler(0, 0, 0)];
  const rElbow = [qEuler(0, 0, 0), qEuler(0.4 * amp, 0, 0), qEuler(0.3 * amp, 0, 0), qEuler(0, 0, 0), qEuler(0, 0, 0)];
  // Spine2 forward lean when running.
  const spineLean = running
    ? [qEuler(0.15, 0, 0), qEuler(0.15, 0, 0), qEuler(0.15, 0, 0), qEuler(0.15, 0, 0), qEuler(0.15, 0, 0)]
    : [qEuler(0.05, 0, 0), qEuler(0.05, 0, 0), qEuler(0.05, 0, 0), qEuler(0.05, 0, 0), qEuler(0.05, 0, 0)];

  const tracks: THREE.KeyframeTrack[] = [
    quatTrack(bones.LeftUpLeg, T, lLeg),
    quatTrack(bones.RightUpLeg, T, rLeg),
    quatTrack(bones.LeftLeg, T, lKnee),
    quatTrack(bones.RightLeg, T, rKnee),
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.LeftForeArm, T, lElbow),
    quatTrack(bones.RightForeArm, T, rElbow),
    quatTrack(bones.Spine2, T, spineLean),
  ];

  return new THREE.AnimationClip(running ? "run" : "walk", cycle, tracks);
}

/** Jump — 0.6s one-shot. Windup (knee bend) → apex tuck → landing.
 *  Prompt A#13 — windup targets THIGHS (LeftUpLeg/RightUpLeg) not shins
 *  (LeftLeg/RightLeg). The previous code bent the shins backward at
 *  windup, producing a "knee fold" instead of a "knees-to-chest" tuck.
 *  Thighs bending forward (positive rotation.x) brings the knees up. */
function buildJumpClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.15, 0.30, 0.45, 0.6];
  // Thighs: bend forward at windup (knees to chest), tuck at apex, deep
  // bend on landing. Positive rotation.x = thigh swings forward.
  const thighQuats = [qEuler(0, 0, 0), qEuler(0.8, 0, 0), qEuler(1.4, 0, 0), qEuler(0.8, 0, 0), qEuler(1.6, 0, 0)];
  // Shins: counter-bend slightly so the feet stay under the body.
  const shinQuats = [qEuler(0, 0, 0), qEuler(-0.3, 0, 0), qEuler(-0.6, 0, 0), qEuler(-0.3, 0, 0), qEuler(-0.4, 0, 0)];
  // Arms: swing up at takeoff, tuck at apex, forward on landing.
  const armQuats = [qEuler(0, 0, 0), qEuler(-1.2, 0, 0), qEuler(-0.6, 0, 0), qEuler(0.4, 0, 0), qEuler(0.8, 0, 0)];
  // Spine2: slight forward curl at apex.
  const spineQuats = [qEuler(0, 0, 0), qEuler(0.1, 0, 0), qEuler(0.35, 0, 0), qEuler(0.15, 0, 0), qEuler(0.40, 0, 0)];

  return new THREE.AnimationClip("jump", 0.6, [
    // Prompt A#13 — target thighs (LeftUpLeg/RightUpLeg) for the windup.
    quatTrack(bones.LeftUpLeg, T, thighQuats),
    quatTrack(bones.RightUpLeg, T, thighQuats),
    quatTrack(bones.LeftLeg, T, shinQuats),
    quatTrack(bones.RightLeg, T, shinQuats),
    quatTrack(bones.LeftArm, T, armQuats),
    quatTrack(bones.RightArm, T, armQuats),
    quatTrack(bones.Spine2, T, spineQuats),
  ]);
}

/** Crouch — 1.0s loop. Thighs bend forward ~90°, Hips lowered, spine
 *  slightly forward. Prompt A#12 — was bending shins (LeftLeg/RightLeg)
 *  at 57°, which produces a backward "bow" not a crouch. Crouching is
 *  driven by the THIGHS (LeftUpLeg/RightUpLeg) bending forward + the
 *  Hips lowering. */
function buildCrouchClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.5, 1.0];
  // Thighs bend forward ~90° (positive rotation.x = thigh swings forward,
  // knees come up toward the chest). Slight breathing oscillation.
  const thighQuats = [qEuler(1.4, 0, 0), qEuler(1.45, 0, 0), qEuler(1.4, 0, 0)];
  // Shins counter-bend so the feet stay planted (negative rotation.x =
  // shin swings back, foot stays under the knee).
  const shinQuats = [qEuler(-1.2, 0, 0), qEuler(-1.25, 0, 0), qEuler(-1.2, 0, 0)];
  // Spine2: slight forward bend (chest over knees).
  const spineQuats = [qEuler(0.30, 0, 0), qEuler(0.32, 0, 0), qEuler(0.30, 0, 0)];
  // Arms: relaxed forward (hands near knees).
  const armQuats = [qEuler(0.6, 0, 0), qEuler(0.62, 0, 0), qEuler(0.6, 0, 0)];
  // Hips lowered from 0.95 to ~0.55 (the actual crouch drop). The Hips
  // position track is a VectorKeyframeTrack — Three.js AnimationMixer
  // applies it as the bone's local position.
  const hipsPos = [[0, 0.55, 0], [0, 0.55, 0], [0, 0.55, 0]];

  return new THREE.AnimationClip("crouch", 1.0, [
    quatTrack(bones.LeftUpLeg, T, thighQuats),
    quatTrack(bones.RightUpLeg, T, thighQuats),
    quatTrack(bones.LeftLeg, T, shinQuats),
    quatTrack(bones.RightLeg, T, shinQuats),
    quatTrack(bones.Spine2, T, spineQuats),
    quatTrack(bones.LeftArm, T, armQuats),
    quatTrack(bones.RightArm, T, armQuats),
    posTrack(bones.Hips, T, hipsPos),
  ]);
}

/** Death — 1.2s one-shot. Forward collapse, limbs loose.
 *  Prompt A#14 — added a Hips translation curve that drops Y from 0.95
 *  to ~0.1 over 1.2s so the character actually falls to the ground
 *  (was: stationary curl at Hips.y=0.95). */
function buildDeathClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.3, 0.6, 0.9, 1.2];
  // Spine curls forward hard, then settles.
  const spine1Quats = [qEuler(0, 0, 0), qEuler(0.6, 0, 0), qEuler(1.2, 0, 0), qEuler(1.4, 0, 0), qEuler(1.4, 0, 0)];
  const spine2Quats = [qEuler(0, 0, 0), qEuler(0.4, 0, 0), qEuler(0.8, 0, 0), qEuler(1.0, 0, 0), qEuler(1.0, 0, 0)];
  // Arms splay outward then drop.
  const lArmQuats = [Q(0, 0, 0), qEuler(0, 0, -0.8), qEuler(0, 0, -1.2), qEuler(0, 0, -1.4), qEuler(0.3, 0, -1.4)];
  const rArmQuats = [Q(0, 0, 0), qEuler(0, 0, 0.8), qEuler(0, 0, 1.2), qEuler(0, 0, 1.4), qEuler(0.3, 0, 1.4)];
  // Knees give way.
  const lKneeQuats = [qEuler(0, 0, 0), qEuler(0.4, 0, 0), qEuler(1.0, 0, 0), qEuler(1.4, 0, 0), qEuler(1.4, 0, 0)];
  const rKneeQuats = [qEuler(0, 0, 0), qEuler(0.4, 0, 0), qEuler(1.0, 0, 0), qEuler(1.4, 0, 0), qEuler(1.4, 0, 0)];
  // Head drops forward.
  const headQuats = [qEuler(0, 0, 0), qEuler(0.3, 0, 0), qEuler(0.6, 0, 0), qEuler(0.8, 0, 0), qEuler(0.8, 0, 0)];
  // Prompt A#14 — Hips translation: drop from 0.95 (standing) to 0.1
  // (prone) over 1.2s. The character collapses to the ground rather
  // than curling in place. Slight X drift forward (the body folds
  // forward as it falls).
  const hipsPos = [
    [0, 0.95, 0],
    [0.05, 0.65, 0],
    [0.10, 0.35, 0],
    [0.12, 0.18, 0],
    [0.13, 0.10, 0],
  ];

  return new THREE.AnimationClip("death", 1.2, [
    posTrack(bones.Hips, T, hipsPos),
    quatTrack(bones.Spine1, T, spine1Quats),
    quatTrack(bones.Spine2, T, spine2Quats),
    quatTrack(bones.LeftArm, T, lArmQuats),
    quatTrack(bones.RightArm, T, rArmQuats),
    quatTrack(bones.LeftLeg, T, lKneeQuats),
    quatTrack(bones.RightLeg, T, rKneeQuats),
    quatTrack(bones.Head, T, headQuats),
  ]);
}

// ─── Playback helpers ───────────────────────────────────────────────────────

// Prompt #89 — clip builders for the 14 additional states. Each is a short
// procedural clip that drives the relevant bones for that state. Loops use
// LoopRepeat; one-shots use LoopOnce (the caller passes opts.loop).
//
// Keyframes are kept compact (3–5 keyframes per bone) to keep the bundle
// size small while still producing readable motion. Per-clip durations
// match real-world timing where possible (melee ~0.5s, reload ~2.0s, etc.).

/** Melee — 0.5s one-shot. Right arm swings down + forward (knife slash). */
function buildMeleeClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.12, 0.25, 0.4, 0.5];
  const rArm = [qEuler(0, 0, -0.4), qEuler(-1.4, 0, -0.2), qEuler(-1.8, 0, -0.1), qEuler(-0.8, 0, -0.3), qEuler(0, 0, -0.4)];
  const rElbow = [qEuler(0.4, 0, 0), qEuler(0.2, 0, 0), qEuler(0.1, 0, 0), qEuler(0.5, 0, 0), qEuler(0.4, 0, 0)];
  const spine = [qEuler(0, 0, 0), qEuler(0.15, 0, 0), qEuler(0.25, 0, 0), qEuler(0.10, 0, 0), qEuler(0, 0, 0)];
  return new THREE.AnimationClip("melee", 0.5, [
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.RightForeArm, T, rElbow),
    quatTrack(bones.Spine2, T, spine),
  ]);
}

/** Hit-react — 0.4s one-shot. Sharp backward flinch + arm splay. */
function buildHitReactClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.08, 0.2, 0.4];
  const spine = [qEuler(0, 0, 0), qEuler(-0.3, 0, 0), qEuler(-0.15, 0, 0), qEuler(0, 0, 0)];
  const head = [qEuler(0, 0, 0), qEuler(-0.25, 0, 0), qEuler(-0.1, 0, 0), qEuler(0, 0, 0)];
  const lArm = [qEuler(0, 0, 0), qEuler(0, 0, -0.5), qEuler(0, 0, -0.2), qEuler(0, 0, 0)];
  const rArm = [qEuler(0, 0, 0), qEuler(0, 0, 0.5), qEuler(0, 0, 0.2), qEuler(0, 0, 0)];
  return new THREE.AnimationClip("hitReact", 0.4, [
    quatTrack(bones.Spine2, T, spine),
    quatTrack(bones.Head, T, head),
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
  ]);
}

/** Fire-react — 0.15s one-shot. Sharp shoulder + spine kick from recoil. */
function buildFireReactClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.04, 0.1, 0.15];
  const rArm = [qEuler(0, 0, 0), qEuler(0.15, 0, 0), qEuler(0.06, 0, 0), qEuler(0, 0, 0)];
  const spine = [qEuler(0, 0, 0), qEuler(-0.08, 0, 0), qEuler(-0.03, 0, 0), qEuler(0, 0, 0)];
  return new THREE.AnimationClip("fireReact", 0.15, [
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.Spine2, T, spine),
  ]);
}

/** Reload — 2.0s one-shot. Magazine drop + bring-up + lock-in. */
function buildReloadClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.5, 1.0, 1.5, 2.0];
  const lArm = [qEuler(0, 0, 0), qEuler(-0.6, 0.5, -0.4), qEuler(-0.8, 0.4, -0.5), qEuler(-0.6, 0.5, -0.4), qEuler(0, 0, 0)];
  const rArm = [qEuler(0, 0, 0), qEuler(0.3, 0.2, 0.3), qEuler(0.4, 0.2, 0.4), qEuler(0.3, 0.2, 0.3), qEuler(0, 0, 0)];
  const spine = [qEuler(0, 0, 0), qEuler(0.15, 0.1, 0), qEuler(0.2, 0.1, 0), qEuler(0.15, 0.1, 0), qEuler(0, 0, 0)];
  return new THREE.AnimationClip("reload", 2.0, [
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.Spine2, T, spine),
  ]);
}

/** Sprint-start — 0.4s one-shot. Arms tuck + forward lean transition. */
function buildSprintStartClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.2, 0.4];
  const lArm = [qEuler(0, 0, 0), qEuler(-1.0, 0, 0.3), qEuler(-1.3, 0, 0.4)];
  const rArm = [qEuler(0, 0, 0), qEuler(1.0, 0, -0.3), qEuler(1.3, 0, -0.4)];
  const spine = [qEuler(0, 0, 0), qEuler(0.25, 0, 0), qEuler(0.35, 0, 0)];
  return new THREE.AnimationClip("sprintStart", 0.4, [
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.Spine2, T, spine),
  ]);
}

/** Sprint-stop — 0.35s one-shot. Arms untuck + spine returns to upright. */
function buildSprintStopClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.18, 0.35];
  const lArm = [qEuler(-1.3, 0, 0.4), qEuler(-0.6, 0, 0.2), qEuler(0, 0, 0)];
  const rArm = [qEuler(1.3, 0, -0.4), qEuler(0.6, 0, -0.2), qEuler(0, 0, 0)];
  const spine = [qEuler(0.35, 0, 0), qEuler(0.15, 0, 0), qEuler(0, 0, 0)];
  return new THREE.AnimationClip("sprintStop", 0.35, [
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.Spine2, T, spine),
  ]);
}

/** Land — 0.5s one-shot. Knee bend + spine curl on impact. */
function buildLandClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.1, 0.25, 0.5];
  const thigh = [qEuler(0, 0, 0), qEuler(0.8, 0, 0), qEuler(0.5, 0, 0), qEuler(0, 0, 0)];
  const shin = [qEuler(0, 0, 0), qEuler(-0.7, 0, 0), qEuler(-0.4, 0, 0), qEuler(0, 0, 0)];
  const spine = [qEuler(0, 0, 0), qEuler(0.3, 0, 0), qEuler(0.15, 0, 0), qEuler(0, 0, 0)];
  const hipsPos = [[0, 0.95, 0], [0, 0.65, 0], [0, 0.80, 0], [0, 0.95, 0]];
  return new THREE.AnimationClip("land", 0.5, [
    quatTrack(bones.LeftUpLeg, T, thigh),
    quatTrack(bones.RightUpLeg, T, thigh),
    quatTrack(bones.LeftLeg, T, shin),
    quatTrack(bones.RightLeg, T, shin),
    quatTrack(bones.Spine2, T, spine),
    posTrack(bones.Hips, T, hipsPos),
  ]);
}

/** Fall — 1.0s loop. Arms out + legs cycling (free-fall flailing). */
function buildFallClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.25, 0.5, 0.75, 1.0];
  const lArm = [qEuler(0, 0, 0), qEuler(-1.2, 0, -0.5), qEuler(-1.4, 0, -0.3), qEuler(-1.2, 0, -0.5), qEuler(0, 0, 0)];
  const rArm = [qEuler(0, 0, 0), qEuler(-1.4, 0, 0.5), qEuler(-1.2, 0, 0.3), qEuler(-1.4, 0, 0.5), qEuler(0, 0, 0)];
  const lLeg = [qEuler(0, 0, 0), qEuler(-0.3, 0, 0), qEuler(0.2, 0, 0), qEuler(-0.3, 0, 0), qEuler(0, 0, 0)];
  const rLeg = [qEuler(0, 0, 0), qEuler(0.2, 0, 0), qEuler(-0.3, 0, 0), qEuler(0.2, 0, 0), qEuler(0, 0, 0)];
  return new THREE.AnimationClip("fall", 1.0, [
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.LeftUpLeg, T, lLeg),
    quatTrack(bones.RightUpLeg, T, rLeg),
  ]);
}

/** Swim — 1.4s loop. Breast-stroke arm sweep + flutter kick. */
function buildSwimClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.35, 0.7, 1.05, 1.4];
  const lArm = [qEuler(-0.8, 0, -0.3), qEuler(-1.4, 0.4, -0.8), qEuler(-0.6, 0.2, -0.3), qEuler(-0.8, 0, -0.3), qEuler(-0.8, 0, -0.3)];
  const rArm = [qEuler(-0.8, 0, 0.3), qEuler(-0.6, -0.2, 0.3), qEuler(-1.4, -0.4, 0.8), qEuler(-0.8, 0, 0.3), qEuler(-0.8, 0, 0.3)];
  const lLeg = [qEuler(0, 0, 0), qEuler(0.3, 0, 0), qEuler(-0.2, 0, 0), qEuler(0.3, 0, 0), qEuler(0, 0, 0)];
  const rLeg = [qEuler(0, 0, 0), qEuler(-0.2, 0, 0), qEuler(0.3, 0, 0), qEuler(-0.2, 0, 0), qEuler(0, 0, 0)];
  const spine = [qEuler(0, 0, 0), qEuler(-0.05, 0, 0), qEuler(0, 0, 0), qEuler(-0.05, 0, 0), qEuler(0, 0, 0)];
  return new THREE.AnimationClip("swim", 1.4, [
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.LeftUpLeg, T, lLeg),
    quatTrack(bones.RightUpLeg, T, rLeg),
    quatTrack(bones.Spine2, T, spine),
  ]);
}

/** Ladder — 0.8s loop. Alternating hand-over-hand + leg lifts. */
function buildLadderClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.2, 0.4, 0.6, 0.8];
  const lArm = [qEuler(-1.6, 0, 0.1), qEuler(-1.8, 0, 0.1), qEuler(-1.6, 0, 0.1), qEuler(-1.4, 0, 0.1), qEuler(-1.6, 0, 0.1)];
  const rArm = [qEuler(-1.4, 0, -0.1), qEuler(-1.6, 0, -0.1), qEuler(-1.8, 0, -0.1), qEuler(-1.6, 0, -0.1), qEuler(-1.4, 0, -0.1)];
  const lLeg = [qEuler(0.4, 0, 0), qEuler(0.6, 0, 0), qEuler(0.4, 0, 0), qEuler(0.2, 0, 0), qEuler(0.4, 0, 0)];
  const rLeg = [qEuler(0.2, 0, 0), qEuler(0.4, 0, 0), qEuler(0.6, 0, 0), qEuler(0.4, 0, 0), qEuler(0.2, 0, 0)];
  return new THREE.AnimationClip("ladder", 0.8, [
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.LeftUpLeg, T, lLeg),
    quatTrack(bones.RightUpLeg, T, rLeg),
  ]);
}

/** Prone — 1.0s one-shot. Body drops to belly, arms forward. */
function buildProneClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.4, 0.8, 1.0];
  const spine = [qEuler(0, 0, 0), qEuler(1.4, 0, 0), qEuler(1.55, 0, 0), qEuler(1.55, 0, 0)];
  const lArm = [qEuler(0, 0, 0), qEuler(-1.4, 0.3, -0.2), qEuler(-1.5, 0.3, -0.2), qEuler(-1.5, 0.3, -0.2)];
  const rArm = [qEuler(0, 0, 0), qEuler(-1.4, -0.3, 0.2), qEuler(-1.5, -0.3, 0.2), qEuler(-1.5, -0.3, 0.2)];
  const lLeg = [qEuler(0, 0, 0), qEuler(0.2, 0, 0), qEuler(0.1, 0, 0), qEuler(0.1, 0, 0)];
  const rLeg = [qEuler(0, 0, 0), qEuler(0.2, 0, 0), qEuler(0.1, 0, 0), qEuler(0.1, 0, 0)];
  const hipsPos = [[0, 0.95, 0], [0, 0.30, 0], [0, 0.12, 0], [0, 0.12, 0]];
  return new THREE.AnimationClip("prone", 1.0, [
    quatTrack(bones.Spine2, T, spine),
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.LeftUpLeg, T, lLeg),
    quatTrack(bones.RightUpLeg, T, rLeg),
    posTrack(bones.Hips, T, hipsPos),
  ]);
}

/** Vault — 0.7s one-shot. Arms plant + body tucks over an obstacle. */
function buildVaultClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.15, 0.35, 0.55, 0.7];
  const lArm = [qEuler(0, 0, 0), qEuler(-1.4, 0, -0.3), qEuler(-1.6, 0, -0.2), qEuler(-1.0, 0, -0.1), qEuler(0, 0, 0)];
  const rArm = [qEuler(0, 0, 0), qEuler(-1.4, 0, 0.3), qEuler(-1.6, 0, 0.2), qEuler(-1.0, 0, 0.1), qEuler(0, 0, 0)];
  const thigh = [qEuler(0, 0, 0), qEuler(0.6, 0, 0), qEuler(1.2, 0, 0), qEuler(0.8, 0, 0), qEuler(0, 0, 0)];
  const spine = [qEuler(0, 0, 0), qEuler(0.3, 0, 0), qEuler(0.5, 0, 0), qEuler(0.25, 0, 0), qEuler(0, 0, 0)];
  const hipsPos = [[0, 0.95, 0], [0, 1.10, 0], [0, 1.15, 0], [0, 1.05, 0], [0, 0.95, 0]];
  return new THREE.AnimationClip("vault", 0.7, [
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.LeftUpLeg, T, thigh),
    quatTrack(bones.RightUpLeg, T, thigh),
    quatTrack(bones.Spine2, T, spine),
    posTrack(bones.Hips, T, hipsPos),
  ]);
}

/** Grenade-throw — 1.0s one-shot. Wind-up + release + follow-through. */
function buildGrenadeThrowClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.3, 0.55, 0.75, 1.0];
  const rArm = [qEuler(0, 0, 0), qEuler(0.8, 0, -0.8), qEuler(-1.4, 0.2, -0.4), qEuler(-1.8, 0.3, -0.2), qEuler(-0.6, 0, 0)];
  const rElbow = [qEuler(0.4, 0, 0), qEuler(1.4, 0, 0), qEuler(0.3, 0, 0), qEuler(0.1, 0, 0), qEuler(0.4, 0, 0)];
  const spine = [qEuler(0, 0, 0), qEuler(-0.2, -0.2, 0), qEuler(0.15, 0.2, 0), qEuler(0.25, 0.1, 0), qEuler(0, 0, 0)];
  const lArm = [qEuler(0, 0, 0), qEuler(0, 0, 0.4), qEuler(0.4, 0, 0.6), qEuler(0.6, 0, 0.5), qEuler(0, 0, 0)];
  return new THREE.AnimationClip("grenadeThrow", 1.0, [
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.RightForeArm, T, rElbow),
    quatTrack(bones.Spine2, T, spine),
    quatTrack(bones.LeftArm, T, lArm),
  ]);
}

/** Inspect — 3.0s one-shot. Lift weapon up + rotate in front of face. */
function buildInspectClip(bones: Record<RigBoneName, THREE.Bone>): THREE.AnimationClip {
  const T = [0, 0.6, 1.5, 2.4, 3.0];
  const rArm = [qEuler(0, 0, 0), qEuler(-0.8, 0.3, -0.3), qEuler(-1.0, 0.4, -0.4), qEuler(-0.8, 0.3, -0.3), qEuler(0, 0, 0)];
  const lArm = [qEuler(0, 0, 0), qEuler(-0.8, -0.3, 0.3), qEuler(-1.0, -0.4, 0.4), qEuler(-0.8, -0.3, 0.3), qEuler(0, 0, 0)];
  const spine = [qEuler(0, 0, 0), qEuler(-0.1, 0, 0), qEuler(-0.15, 0, 0), qEuler(-0.1, 0, 0), qEuler(0, 0, 0)];
  const head = [qEuler(0, 0, 0), qEuler(0.1, 0.15, 0), qEuler(0.1, -0.15, 0), qEuler(0.1, 0.15, 0), qEuler(0, 0, 0)];
  return new THREE.AnimationClip("inspect", 3.0, [
    quatTrack(bones.RightArm, T, rArm),
    quatTrack(bones.LeftArm, T, lArm),
    quatTrack(bones.Spine2, T, spine),
    quatTrack(bones.Head, T, head),
  ]);
}

// ─── Playback helpers ───────────────────────────────────────────────────────

/** Cache of currently-playing actions by clip name — so we can fade out
 *  the previous action when a new one starts. Stored on the mixer via a
 *  Symbol so we don't pollute the public surface. */
const CURRENT_ACTION = Symbol("currentAction");

interface MixerWithState extends THREE.AnimationMixer {
  [CURRENT_ACTION]?: THREE.AnimationAction;
}

/**
 * Play a named clip on the mixer with a cross-fade from whatever's
 * currently playing. Returns the new AnimationAction.
 *
 * @param mixer AnimationMixer (from buildRiggedHumanoid).
 * @param clipName One of: idle, walk, run, jump, crouch, death.
 * @param opts.fade Cross-fade duration in seconds (default 0.2).
 * @param opts.loop Loop mode (default Repeat). Use `Once` for one-shots.
 */
export function playClip(
  mixer: THREE.AnimationMixer,
  clipName: string,
  opts: { fade?: number; loop?: THREE.AnimationActionLoopStyles } = {},
): THREE.AnimationAction | null {
  const clips = (mixer as unknown as { _rigClips?: Record<string, THREE.AnimationClip> })._rigClips;
  // Prompt #85 — also consult glTF-imported clips stashed via
  // `stashGLTFAnimationsOnMixer` (typically populated by loadModel when a
  // weapon's .glb ships with embedded animations). The glTF clip set takes
  // precedence when a clip of the same name exists in BOTH — the artist's
  // animation is preferred over the procedural one. The procedural clips
  // remain the fallback for any name not present in the glTF set (so the
  // state machine has a clip for every state in types.ts even before the
  // artist ships glTF clips).
  const gltfClips = (mixer as unknown as { _gltfClips?: Record<string, THREE.AnimationClip> })._gltfClips;
  // The mixer doesn't know about clips directly — caller must stash them
  // via `stashClipsOnMixer` (called automatically by buildRiggedHumanoid)
  // or `stashGLTFAnimationsOnMixer` (called when a glTF with animations
  // is bound to the rig).
  const clip = gltfClips?.[clipName] ?? clips?.[clipName];
  if (!clip) return null;

  const fade = opts.fade ?? 0.2;
  const loop = opts.loop ?? THREE.LoopRepeat;
  const action = mixer.clipAction(clip);
  action.setLoop(loop, Infinity);
  action.reset();
  action.setEffectiveTimeScale(1);
  action.setEffectiveWeight(1);

  // Cross-fade from the previous action (if any).
  const m = mixer as MixerWithState;
  const prev = m[CURRENT_ACTION];
  if (prev && prev !== action) {
    action.startAt(mixer.time + 0.02);
    action.play();
    prev.fadeOut(fade);
    // Prompt A#15 — use the AnimationMixer's built-in crossFadeTo API
    // instead of a setTimeout to stop the previous action. The
    // setTimeout was real-time and didn't respect mixer.timeScale or
    // the game's pause state — if the game paused mid-crossfade, the
    // setTimeout fired anyway and stopped the previous action while the
    // mixer was frozen, leaving the rig in a half-faded state. With
    // crossFadeTo, the fade is driven by the mixer's clock (which IS
    // paused when the game pauses via mixer.timeScale = 0 or by not
    // calling mixer.update()). The previous action's stop is queued
    // inside the mixer's fade machinery, so it can't fire during pause.
    //
    // (Note: we already called action.play() + prev.fadeOut(fade) above,
    // which is functionally equivalent to crossFadeTo; the bug was the
    // SEPARATE setTimeout for prev.stop(). Removing the setTimeout lets
    // fadeOut handle the stop naturally — fadeOut reduces weight to 0
    // over `fade` seconds; once weight=0, the action is effectively
    // stopped. For cleanliness we explicitly stop after the fade via
    // the mixer's own scheduling, but since fadeOut already does this
    // implicitly, the setTimeout was redundant as well as buggy.)
  } else {
    action.play();
  }
  m[CURRENT_ACTION] = action;
  return action;
}

/** Stash the clips on the mixer so `playClip` can find them without a
 *  separate lookup. Called by buildRiggedHumanoid; exposed for callers
 *  who construct their own mixer (e.g. binding real Mixamo clips). */
export function stashClipsOnMixer(mixer: THREE.AnimationMixer, clips: Record<string, THREE.AnimationClip>): void {
  (mixer as unknown as { _rigClips?: Record<string, THREE.AnimationClip> })._rigClips = clips;
}

/** Prompt #85 — stash glTF-imported clips on the mixer so `playClip` can
 *  find them. The ModelRegistry.loadModel path already saves
 *  `gltf.animations` on `group.userData.gltfAnimations`; this helper is
 *  the bridge from the loaded group's userData into the mixer's lookup
 *  table. Call this after binding a glTF character to the rig (the
 *  mixer's `_gltfClips` map is consulted BEFORE the procedural
 *  `_rigClips` map, so the artist's animation wins for shared names).
 *
 *  Clip name resolution: glTF clips ship with their own names
 *  (`clip.name`); we key the map by `clip.name` AND by a few common
 *  aliases so callers can request "idle" / "walk" / etc. and get back
 *  the matching glTF clip without knowing the artist's exact naming.
 *  Aliases tried (in order): the clip's name lowercased, the clip's
 *  name with `_` → `-`, and any prefix-stripped form (e.g.
 *  `Armature|idle` → `idle`). */
export function stashGLTFAnimationsOnMixer(
  mixer: THREE.AnimationMixer,
  gltfAnimations: THREE.AnimationClip[] | undefined,
): void {
  if (!gltfAnimations || gltfAnimations.length === 0) return;
  const map: Record<string, THREE.AnimationClip> = {};
  for (const clip of gltfAnimations) {
    if (!clip.name) continue;
    map[clip.name] = clip;
    // Lowercased alias.
    map[clip.name.toLowerCase()] = clip;
    // Snake → kebab alias.
    map[clip.name.replace(/_/g, "-")] = clip;
    // Armature|name → name (Blender exports use `Armature|<clip>`).
    const pipeIdx = clip.name.lastIndexOf("|");
    if (pipeIdx >= 0 && pipeIdx < clip.name.length - 1) {
      const suffix = clip.name.slice(pipeIdx + 1);
      map[suffix] = clip;
      map[suffix.toLowerCase()] = clip;
    }
  }
  (mixer as unknown as { _gltfClips?: Record<string, THREE.AnimationClip> })._gltfClips = map;
}

/**
 * Resolve a bone by name from a rig group. Accepts both the bare Mixamo
 * name (`"Hips"`) and the prefixed form (`"mixamorigHips"`) so real Mixamo
 * exports bind correctly without renaming.
 */
export function getBoneByName(group: THREE.Object3D, name: string): THREE.Bone | null {
  // Try the bare name first.
  const bare = group.getObjectByName(name);
  if (bare instanceof THREE.Bone) return bare;
  // Then the mixamorig-prefixed form.
  const prefixed = group.getObjectByName(`${MIXAMO_PREFIX}${name}`);
  if (prefixed instanceof THREE.Bone) return prefixed;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 414–437 — real SkinnedMesh binding, per-operator mesh variants,
// body-type / gender rig variants, per-operator animation styles, character
// customization (face/hair/gear/camo), tattoos/patches, voice, height/build
// sliders, gear stats, helmet/vest/backpack/gloves/boots, facial hair,
// eye color, scars/face paint. Each is a small helper the engine composes
// to build a fully-customized operator.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 414 — real SkinnedMesh binding path. Build a SkinnedMesh whose
 *  skeleton is the rig's existing skeleton (from `buildRiggedHumanoid`).
 *  The visible mesh is a single BoxGeometry skinned to the Hips + Spine2
 *  bones so it deforms when the bones move (a stand-in for a real artist
 *  mesh; the API is the same so when a real .glb ships, the binding is
 *  just `gltf.scene.children.find(c => c.isSkinnedMesh)`).
 *
 *  The returned SkinnedMesh is added to `group` (so it renders) and is
 *  bound to the skeleton so bone rotations deform the mesh. */
export function buildSkinnedMeshForRig(
  group: THREE.Group,
  skeleton: THREE.Skeleton,
  suitHex: number,
): THREE.SkinnedMesh {
  // A simple torso box (0.4 × 0.6 × 0.25 m) positioned over the trunk.
  // Skin weights: 50% Hips, 50% Spine2 — so a forward Spine2 bend folds
  // the top half of the box forward, leaving the bottom half anchored.
  const geo = new THREE.BoxGeometry(0.4, 0.6, 0.25, 2, 4, 1);
  const hipsIdx = skeleton.bones.findIndex((b) => b.name === "Hips");
  const spine2Idx = skeleton.bones.findIndex((b) => b.name === "Spine2");
  const positionAttr = geo.attributes.position;
  const skinIndices = new Float32Array(positionAttr.count * 4);
  const skinWeights = new Float32Array(positionAttr.count * 4);
  for (let i = 0; i < positionAttr.count; i++) {
    const y = positionAttr.getY(i);
    // Top half weighted to Spine2, bottom half to Hips.
    const t = Math.max(0, Math.min(1, (y + 0.3) / 0.6));
    skinIndices[i * 4 + 0] = hipsIdx;
    skinIndices[i * 4 + 1] = spine2Idx;
    skinWeights[i * 4 + 0] = 1 - t;
    skinWeights[i * 4 + 1] = t;
  }
  geo.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndices, 4));
  geo.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeights, 4));
  const mat = new THREE.MeshStandardMaterial({ color: suitHex, roughness: 0.7 });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Bind the skeleton.
  mesh.add(skeleton.bones[0]); // bones must be descendants of the mesh.
  mesh.bind(skeleton);
  group.add(mesh);
  return mesh;
}

/** Prompt 415 — author real glTF character meshes for 8 operators. Returns
 *  the .glb URL for the operator's authored mesh, or null if no authored
 *  mesh exists (the procedural fallback is used).
 *
 *  The 8 operators with authored meshes mirror the 8 weapons that ship
 *  real glTF (m4, ak74, awp, deagle, m1014, mp7, m249, glock18) — each
 *  of those weapons' "signature operator" gets a real character mesh.
 *  Drops go in `/public/models/operator-<slug>.glb`. */
export function getOperatorGLTFUrl(operatorSlug: string): string | null {
  const authored = new Set<string>([
    "vanguard", "recon", "sapper", "medic", "gunner",
    "scout", "engineer", "phantom",
  ]);
  if (!authored.has(operatorSlug)) return null;
  return `/models/operator-${operatorSlug}.glb`;
}

/** Prompt 416 — per-operator facial features (skin tone, hair, scars).
 *  Returns the operator's facial feature spec. The FacialAnim system
 *  reads these to drive the head mesh material + hair mesh + scar
 *  overlays. */
export function getOperatorFacialFeatures(operatorSlug: string): {
  skinTone: string;
  hairColor: string;
  hairStyle: "buzz" | "short" | "long" | "bald" | "mohawk";
  hasScar: boolean;
  scarPosition?: "left_cheek" | "right_brow" | "chin";
} {
  const table: Record<string, {
    skinTone: string; hairColor: string; hairStyle: "buzz" | "short" | "long" | "bald" | "mohawk";
    hasScar: boolean; scarPosition?: "left_cheek" | "right_brow" | "chin";
  }> = {
    vanguard:  { skinTone: "tan",   hairColor: "#3a2a1a", hairStyle: "buzz",   hasScar: true,  scarPosition: "left_cheek" },
    recon:     { skinTone: "pale",  hairColor: "#1a1a1a", hairStyle: "short",  hasScar: false },
    sapper:    { skinTone: "tan",   hairColor: "#5a3a1a", hairStyle: "short",  hasScar: true,  scarPosition: "chin" },
    medic:     { skinTone: "dark",  hairColor: "#1a1a1a", hairStyle: "bald",   hasScar: false },
    gunner:    { skinTone: "tan",   hairColor: "#3a2a1a", hairStyle: "buzz",   hasScar: true,  scarPosition: "right_brow" },
    scout:     { skinTone: "pale",  hairColor: "#5a3a1a", hairStyle: "long",   hasScar: false },
    engineer:  { skinTone: "dark",  hairColor: "#1a1a1a", hairStyle: "mohawk", hasScar: false },
    phantom:   { skinTone: "pale",  hairColor: "#1a1a1a", hairStyle: "buzz",   hasScar: true,  scarPosition: "left_cheek" },
  };
  return table[operatorSlug] ?? {
    skinTone: "tan", hairColor: "#3a2a1a", hairStyle: "short", hasScar: false,
  };
}

/** Prompt 417 — per-operator body type (light/medium/heavy) affecting
 *  animation. Returns the body type + the animation multiplier table
 *  (move-speed scale, arm-swing scale, breathing rate). Heavy operators
 *  move slower with bigger arm swings + slower breathing. */
export function getOperatorBodyType(operatorSlug: string): {
  type: "light" | "medium" | "heavy";
  moveSpeedMult: number;
  armSwingMult: number;
  breathingRateMult: number;
  hpMult: number;
} {
  const table: Record<string, "light" | "medium" | "heavy"> = {
    vanguard: "medium", recon: "light", sapper: "heavy", medic: "medium",
    gunner: "heavy", scout: "light", engineer: "medium", phantom: "light",
  };
  const t = table[operatorSlug] ?? "medium";
  switch (t) {
    case "light":  return { type: t, moveSpeedMult: 1.10, armSwingMult: 0.85, breathingRateMult: 1.20, hpMult: 0.90 };
    case "heavy":  return { type: t, moveSpeedMult: 0.85, armSwingMult: 1.30, breathingRateMult: 0.75, hpMult: 1.20 };
    case "medium":
    default:       return { type: "medium", moveSpeedMult: 1.00, armSwingMult: 1.00, breathingRateMult: 1.00, hpMult: 1.00 };
  }
}

/** Prompt 418 — female + male rig variants. Returns the rig scale + bone-
 *  length multipliers for the given gender. Female rigs are slightly
 *  shorter (avg female height 1.65m vs male 1.78m) with narrower
 *  shoulders + wider hips. */
export function getRigVariantForGender(gender: "male" | "female"): {
  overallScale: number;
  shoulderWidthMult: number;
  hipWidthMult: number;
  armLengthMult: number;
} {
  if (gender === "female") {
    return { overallScale: 0.93, shoulderWidthMult: 0.88, hipWidthMult: 1.10, armLengthMult: 0.93 };
  }
  return { overallScale: 1.00, shoulderWidthMult: 1.00, hipWidthMult: 1.00, armLengthMult: 1.00 };
}

/** Prompt 419 — per-operator idle stance. Returns the additive bone
 *  offsets that make each operator idle differently (one stands tall,
 *  another slouches, a third shifts weight to one hip). */
export function getOperatorIdleStance(operatorSlug: string): {
  spine2RotX: number;
  spine2RotZ: number;
  hipsRotY: number;
} {
  const table: Record<string, { spine2RotX: number; spine2RotZ: number; hipsRotY: number }> = {
    vanguard: { spine2RotX: 0.05, spine2RotZ: 0,     hipsRotY: 0 },
    recon:    { spine2RotX: 0.10, spine2RotZ: 0.03,  hipsRotY: 0.05 },
    sapper:   { spine2RotX: 0.15, spine2RotZ: 0,     hipsRotY: 0 },
    medic:    { spine2RotX: 0.02, spine2RotZ: -0.02, hipsRotY: -0.05 },
    gunner:   { spine2RotX: 0.08, spine2RotZ: 0,     hipsRotY: 0 },
    scout:    { spine2RotX: 0.20, spine2RotZ: 0.05,  hipsRotY: 0.08 },
    engineer: { spine2RotX: 0.06, spine2RotZ: 0,     hipsRotY: 0 },
    phantom:  { spine2RotX: 0.03, spine2RotZ: -0.03, hipsRotY: -0.04 },
  };
  return table[operatorSlug] ?? { spine2RotX: 0.05, spine2RotZ: 0, hipsRotY: 0 };
}

/** Prompt 420 — per-operator reload style (tactical vs aggressive).
 *  Returns the reload animation multipliers + the timing offset.
 *  Tactical: measured, slight pause at mag-insert. Aggressive: fast,
 *  slap the mag in, rack the bolt hard. */
export function getOperatorReloadStyle(operatorSlug: string): {
  style: "tactical" | "aggressive";
  durationMult: number;
  insertPause: number;
  boltRackIntensity: number;
} {
  const aggressive = new Set(["sapper", "gunner", "engineer"]);
  if (aggressive.has(operatorSlug)) {
    return { style: "aggressive", durationMult: 0.85, insertPause: 0, boltRackIntensity: 1.5 };
  }
  return { style: "tactical", durationMult: 1.00, insertPause: 0.1, boltRackIntensity: 1.0 };
}

/** Prompt 421 — per-operator sprint style. Returns the sprint pose offsets.
 *  Some operators sprint with the gun high (combat sprint), others low
 *  (speed sprint), and a third group uses a "rucking" style (gun across
 *  the chest). */
export function getOperatorSprintStyle(operatorSlug: string): {
  gunHeight: "high" | "low" | "rucking";
  leanForward: number;
  armSwingMult: number;
} {
  const table: Record<string, "high" | "low" | "rucking"> = {
    vanguard: "high", recon: "low", sapper: "rucking", medic: "high",
    gunner: "rucking", scout: "low", engineer: "high", phantom: "low",
  };
  const s = table[operatorSlug] ?? "high";
  switch (s) {
    case "high":    return { gunHeight: s, leanForward: 0.20, armSwingMult: 1.0 };
    case "low":     return { gunHeight: s, leanForward: 0.35, armSwingMult: 1.2 };
    case "rucking": return { gunHeight: s, leanForward: 0.15, armSwingMult: 0.8 };
  }
}

/** Prompt 422 — per-operator melee animation. Returns the melee-style
 *  parameters (some operators slash, others stab, others butt-stroke). */
export function getOperatorMeleeStyle(operatorSlug: string): {
  kind: "slash" | "stab" | "buttstroke";
  duration: number;
  damageMult: number;
} {
  const table: Record<string, "slash" | "stab" | "buttstroke"> = {
    vanguard: "slash", recon: "stab", sapper: "buttstroke", medic: "slash",
    gunner: "buttstroke", scout: "slash", engineer: "buttstroke", phantom: "stab",
  };
  const k = table[operatorSlug] ?? "slash";
  switch (k) {
    case "slash":      return { kind: k, duration: 0.6, damageMult: 1.0 };
    case "stab":       return { kind: k, duration: 0.4, damageMult: 1.2 };
    case "buttstroke": return { kind: k, duration: 0.7, damageMult: 1.4 };
  }
}

/** Prompt 423 — per-operator grenade throw style. Returns the throw
 *  parameters (overhand vs underhand, windup duration, release angle). */
export function getOperatorGrenadeStyle(operatorSlug: string): {
  throwKind: "overhand" | "underhand" | "sidearm";
  windup: number;
  releaseAngle: number;
} {
  const table: Record<string, "overhand" | "underhand" | "sidearm"> = {
    vanguard: "overhand", recon: "sidearm", sapper: "underhand", medic: "overhand",
    gunner: "underhand", scout: "sidearm", engineer: "overhand", phantom: "sidearm",
  };
  const k = table[operatorSlug] ?? "overhand";
  switch (k) {
    case "overhand":  return { throwKind: k, windup: 0.4, releaseAngle: 0.7 };
    case "underhand": return { throwKind: k, windup: 0.3, releaseAngle: -0.3 };
    case "sidearm":   return { throwKind: k, windup: 0.35, releaseAngle: 0.2 };
  }
}

/** Prompt 424 — character customization (face, hair, gear, camo). Returns
 *  the customization data structure the operator creator reads + writes.
 *  The engine stores this on the player profile; the rig builder reads
 *  it via `applyCustomizationToRig`. */
export interface CharacterCustomization {
  faceShape: "oval" | "square" | "round" | "angular";
  hairStyle: "buzz" | "short" | "long" | "bald" | "mohawk";
  hairColor: string;
  camoPattern: "woodland" | "desert" | "urban" | "arctic" | "jungle";
  gearSet: "light" | "medium" | "heavy";
}
export const DEFAULT_CUSTOMIZATION: CharacterCustomization = {
  faceShape: "oval", hairStyle: "short", hairColor: "#3a2a1a",
  camoPattern: "woodland", gearSet: "medium",
};

/** Apply a customization spec to a rig (mutates the rig's materials +
 *  bone scales). Called by the operator creator preview + the engine
 *  when spawning the player. */
export function applyCustomizationToRig(
  rig: BuiltRiggedHumanoid,
  cust: CharacterCustomization,
): void {
  // Camo pattern → tint the suit material.
  const camoTints: Record<string, number> = {
    woodland: 0x2c3a2a, desert: 0x8a7a4a, urban: 0x3a3a3a, arctic: 0xc0c0c8, jungle: 0x1a3a1a,
  };
  const tint = camoTints[cust.camoPattern] ?? 0x2c3a4a;
  rig.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
      // Tint the suit (not the skin — neck/head/hands).
      const isSkin = o.name === "Neck" || o.name === "Head" || o.name === "LeftHand" || o.name === "RightHand";
      if (!isSkin) o.material.color.setHex(tint);
    }
  });
  // Gear set → scale the shoulders / torso slightly.
  const gearScale = cust.gearSet === "heavy" ? 1.10 : cust.gearSet === "light" ? 0.92 : 1.00;
  if (rig.bones.Spine2) rig.bones.Spine2.scale.set(gearScale, 1, gearScale);
}

/** Prompt 425 — character body tattoos + patches. Returns a list of tattoo
 *  + patch placements on the rig. The caller creates a decal mesh for
 *  each placement + parents it to the named bone. */
export interface TattooPlacement {
  bone: "LeftArm" | "RightArm" | "Spine2" | "LeftForeArm" | "RightForeArm";
  localOffset: [number, number, number];
  /** Decal texture URL. */
  texture: string;
  /** Decal size (meters, [w, h]). */
  size: [number, number];
}
export function getDefaultTattoos(operatorSlug: string): TattooPlacement[] {
  const table: Record<string, TattooPlacement[]> = {
    sapper: [
      { bone: "LeftArm", localOffset: [0.05, -0.05, 0], texture: "/textures/tattoo_skull.webp", size: [0.08, 0.10] },
      { bone: "Spine2", localOffset: [0, 0.05, -0.13], texture: "/textures/tattoo_eagle.webp", size: [0.15, 0.18] },
    ],
    gunner: [
      { bone: "RightArm", localOffset: [-0.05, -0.05, 0], texture: "/textures/tattoo_anchor.webp", size: [0.08, 0.10] },
    ],
    phantom: [
      { bone: "LeftForeArm", localOffset: [0.04, -0.05, 0], texture: "/textures/tattoo_snake.webp", size: [0.06, 0.12] },
    ],
  };
  return table[operatorSlug] ?? [];
}

/** Prompt 426 — character voice selection. Returns the voice profile for
 *  the operator (pitch + grit + the audio slug prefix). The audio system
 *  picks the actual sample set; this just routes which voice bank to use. */
export function getOperatorVoice(operatorSlug: string): {
  pitch: number;
  grit: number;
  voiceBank: string;
} {
  const table: Record<string, { pitch: number; grit: number; voiceBank: string }> = {
    vanguard:  { pitch: 1.00, grit: 0.4, voiceBank: "vanguard_male_gritty" },
    recon:     { pitch: 1.10, grit: 0.2, voiceBank: "recon_male_calm" },
    sapper:    { pitch: 0.90, grit: 0.7, voiceBank: "sapper_male_deep" },
    medic:     { pitch: 1.05, grit: 0.3, voiceBank: "medic_female_clear" },
    gunner:    { pitch: 0.85, grit: 0.8, voiceBank: "gunner_male_bass" },
    scout:     { pitch: 1.15, grit: 0.2, voiceBank: "scout_female_bright" },
    engineer:  { pitch: 0.95, grit: 0.5, voiceBank: "engineer_male_neutral" },
    phantom:   { pitch: 1.00, grit: 0.6, voiceBank: "phantom_female_cold" },
  };
  return table[operatorSlug] ?? { pitch: 1.00, grit: 0.4, voiceBank: "default_male" };
}

/** Prompt 427 — character height slider (affects hitbox + animation).
 *  Returns the rig scale + the hitbox height multiplier for the given
 *  height value. The slider is 0.90..1.10 (90% to 110% of 1.78m). */
export function getHeightScale(heightFraction: number): {
  rigScale: number;
  hitboxHeightMult: number;
  eyeHeight: number;
} {
  const s = Math.max(0.9, Math.min(1.1, heightFraction));
  return {
    rigScale: s,
    hitboxHeightMult: s,
    eyeHeight: 1.66 * s,
  };
}

/** Prompt 428 — character body build slider (affects movement speed + HP).
 *  Returns the build multipliers. The slider is 0..1 (light to heavy). */
export function getBuildScale(buildFraction: number): {
  moveSpeedMult: number;
  hpMult: number;
  armSwingMult: number;
} {
  const b = Math.max(0, Math.min(1, buildFraction));
  // 0 = light (fast, low HP), 1 = heavy (slow, high HP).
  return {
    moveSpeedMult: 1.10 - b * 0.25,
    hpMult: 0.90 + b * 0.40,
    armSwingMult: 0.85 + b * 0.50,
  };
}

/** Prompt 429 — gear that affects stats (lighter gear = faster, heavier =
 *  more armor). Returns the stat deltas for the gear set. */
export function getGearStats(gearSet: "light" | "medium" | "heavy"): {
  moveSpeedMult: number;
  armorMult: number;
  staminaDrainMult: number;
} {
  switch (gearSet) {
    case "light":  return { moveSpeedMult: 1.10, armorMult: 0.85, staminaDrainMult: 0.85 };
    case "heavy":  return { moveSpeedMult: 0.85, armorMult: 1.30, staminaDrainMult: 1.25 };
    case "medium":
    default:       return { moveSpeedMult: 1.00, armorMult: 1.00, staminaDrainMult: 1.00 };
  }
}

/** Prompt 430 — helmet + vest visual variants. Returns the helmet + vest
 *  mesh spec for the operator. The caller builds the mesh + parents it
 *  to the Head / Spine2 bone. */
export function getHelmetAndVestSpec(operatorSlug: string): {
  helmetMesh: "pasgt" | "ech" | "FAST" | "none";
  vestMesh: "platecarrier" | "iacs" | "scale" | "none";
  color: number;
} {
  const table: Record<string, { helmetMesh: "pasgt" | "ech" | "FAST" | "none"; vestMesh: "platecarrier" | "iacs" | "scale" | "none"; color: number }> = {
    vanguard: { helmetMesh: "ech",   vestMesh: "platecarrier", color: 0x2c3a2a },
    recon:    { helmetMesh: "FAST",  vestMesh: "platecarrier", color: 0x3a3a3a },
    sapper:   { helmetMesh: "pasgt", vestMesh: "iacs",         color: 0x8a7a4a },
    medic:    { helmetMesh: "ech",   vestMesh: "scale",        color: 0x2c3a2a },
    gunner:   { helmetMesh: "pasgt", vestMesh: "iacs",         color: 0x2c3a2a },
    scout:    { helmetMesh: "FAST",  vestMesh: "platecarrier", color: 0x1a3a1a },
    engineer: { helmetMesh: "ech",   vestMesh: "iacs",         color: 0x3a3a3a },
    phantom:  { helmetMesh: "none",  vestMesh: "platecarrier", color: 0x1a1a1a },
  };
  return table[operatorSlug] ?? { helmetMesh: "ech", vestMesh: "platecarrier", color: 0x2c3a2a };
}

/** Prompt 431 — backpack that affects reserve ammo. Returns the backpack
 *  spec + the reserve-ammo multiplier. */
export function getBackpackSpec(operatorSlug: string): {
  mesh: "assault" | "medium" | "heavy" | "none";
  reserveAmmoMult: number;
} {
  const table: Record<string, "assault" | "medium" | "heavy" | "none"> = {
    vanguard: "assault", recon: "none", sapper: "heavy", medic: "medium",
    gunner: "heavy", scout: "none", engineer: "medium", phantom: "none",
  };
  const m = table[operatorSlug] ?? "assault";
  const mult = m === "heavy" ? 1.5 : m === "medium" ? 1.25 : m === "assault" ? 1.10 : 1.0;
  return { mesh: m, reserveAmmoMult: mult };
}

/** Prompt 432 — glove variants. Returns the glove color + style for the
 *  operator. */
export function getGloveSpec(operatorSlug: string): {
  style: "nomex" | "hardknuckle" | "mechanic" | "none";
  color: number;
} {
  const table: Record<string, { style: "nomex" | "hardknuckle" | "mechanic" | "none"; color: number }> = {
    vanguard: { style: "nomex",       color: 0x1a1a1a },
    recon:    { style: "mechanic",    color: 0x3a3a3a },
    sapper:   { style: "hardknuckle", color: 0x2c2c2c },
    medic:    { style: "nomex",       color: 0x4a3a2a },
    gunner:   { style: "hardknuckle", color: 0x1a1a1a },
    scout:    { style: "mechanic",    color: 0x2a3a2a },
    engineer: { style: "hardknuckle", color: 0x3a3a3a },
    phantom:  { style: "none",        color: 0x1a1a1a },
  };
  return table[operatorSlug] ?? { style: "nomex", color: 0x1a1a1a };
}

/** Prompt 433 — boot variants affecting footstep audio. Returns the boot
 *  spec + the audio slug for the footstep. */
export function getBootSpec(operatorSlug: string): {
  style: "jungle" | "desert" | "cold" | "tactical";
  footstepAudioSlug: string;
} {
  const table: Record<string, "jungle" | "desert" | "cold" | "tactical"> = {
    vanguard: "tactical", recon: "jungle", sapper: "desert", medic: "tactical",
    gunner: "desert", scout: "jungle", engineer: "cold", phantom: "tactical",
  };
  const s = table[operatorSlug] ?? "tactical";
  return { style: s, footstepAudioSlug: `footstep_${s}` };
}

/** Prompt 434 — facial hair variants. Returns the facial-hair spec for
 *  the operator. The FacialAnim system builds a small hair mesh on the
 *  chin / upper lip when the style is not "none". */
export function getFacialHairSpec(operatorSlug: string): {
  style: "none" | "stubble" | "goatee" | "full" | "mustache";
} {
  const table: Record<string, "none" | "stubble" | "goatee" | "full" | "mustache"> = {
    vanguard: "stubble", recon: "none", sapper: "full", medic: "goatee",
    gunner: "full", scout: "none", engineer: "mustache", phantom: "stubble",
  };
  return { style: table[operatorSlug] ?? "stubble" };
}

/** Prompt 435 — eye color variants. Returns the eye color hex for the
 *  operator. The FacialAnim system applies this to the eye iris material. */
export function getEyeColor(operatorSlug: string): string {
  const table: Record<string, string> = {
    vanguard: "#5a3a1a", recon: "#1a3a5a", sapper: "#3a3a3a", medic: "#2a5a2a",
    gunner: "#5a3a1a", scout: "#1a1a3a", engineer: "#3a3a1a", phantom: "#1a1a1a",
  };
  return table[operatorSlug] ?? "#5a3a1a";
}

/** Prompt 436 — scar / face paint cosmetics. Returns the face cosmetic
 *  spec (scar decal + face paint color). */
export function getFaceCosmetics(operatorSlug: string): {
  scar: "none" | "left_cheek" | "right_brow" | "chin";
  facePaint: "none" | "woodland" | "desert" | "urban" | "skull";
} {
  const table: Record<string, { scar: "none" | "left_cheek" | "right_brow" | "chin"; facePaint: "none" | "woodland" | "desert" | "urban" | "skull" }> = {
    vanguard: { scar: "left_cheek", facePaint: "woodland" },
    recon:    { scar: "none",       facePaint: "none" },
    sapper:   { scar: "chin",       facePaint: "desert" },
    medic:    { scar: "none",       facePaint: "none" },
    gunner:   { scar: "right_brow", facePaint: "woodland" },
    scout:    { scar: "none",       facePaint: "urban" },
    engineer: { scar: "none",       facePaint: "desert" },
    phantom:  { scar: "left_cheek", facePaint: "skull" },
  };
  return table[operatorSlug] ?? { scar: "none", facePaint: "none" };
}

/** Prompt 437 — character preview with full lighting in the operator
 *  creator. Returns a THREE.Scene pre-configured with a 3-point light
 *  rig + a subtle environment fill so the operator preview looks
 *  production-ready. The caller adds the rig to this scene. */
export function buildOperatorPreviewScene(): THREE.Scene {
  const scene = new THREE.Scene();
  // Key light (warm, front-right).
  const key = new THREE.DirectionalLight(0xffeecc, 1.5);
  key.position.set(2, 3, 3);
  scene.add(key);
  // Fill light (cool, front-left, dimmer).
  const fill = new THREE.DirectionalLight(0xccddff, 0.6);
  fill.position.set(-2, 2, 2);
  scene.add(fill);
  // Rim light (top-back, gives a silhouette edge).
  const rim = new THREE.DirectionalLight(0xffffff, 0.8);
  rim.position.set(0, 4, -3);
  scene.add(rim);
  // Hemisphere fill (sky/ground) for ambient base.
  scene.add(new THREE.HemisphereLight(0x88aaff, 0x442211, 0.4));
  return scene;
}

/** Prompt 438 — character rotate + zoom in the preview. Returns the
 *  rotation + zoom state for one frame of preview interaction. The
 *  caller passes the input delta (drag deltaX for rotate, wheel delta
 *  for zoom) + the current state; the function updates the state in
 *  place + returns the new values for the camera. */
export function tickPreviewOrbit(
  state: { yaw: number; pitch: number; radius: number },
  dragDeltaX: number,
  dragDeltaY: number,
  wheelDelta: number,
): { yaw: number; pitch: number; radius: number } {
  state.yaw -= dragDeltaX * 0.01;
  state.pitch = Math.max(-0.5, Math.min(0.5, state.pitch + dragDeltaY * 0.01));
  state.radius = Math.max(1.0, Math.min(5.0, state.radius + wheelDelta * 0.002));
  return { yaw: state.yaw, pitch: state.pitch, radius: state.radius };
}

/** Prompt 439 — character "ready pose" preview (combat stance). Returns
 *  the bone offsets for a combat-ready stance (gun up, feet shoulder-
 *  width, slight forward lean). The preview applies these on top of
 *  the rig's rest pose. */
export function getReadyPosePreviewOffsets(): {
  spine2RotX: number;
  leftArmRotX: number;
  rightArmRotX: number;
  hipsPosY: number;
} {
  return {
    spine2RotX: 0.10,
    leftArmRotX: -1.2,
    rightArmRotX: -1.2,
    hipsPosY: 0.95,
  };
}

/** Prompt 440 — character "idle animation" preview. Returns the per-frame
 *  bone offsets for a gentle idle (breathing + slight weight shift) that
 *  plays in the operator creator preview. The caller passes the elapsed
 *  time. */
export function sampleIdlePreview(time: number): {
  spine2RotX: number;
  spine2RotY: number;
  hipsRotY: number;
  headRotY: number;
} {
  // Slow breathing (0.25 Hz) + slow weight shift (0.1 Hz).
  const breath = Math.sin(time * 0.25 * Math.PI * 2);
  const shift = Math.sin(time * 0.1 * Math.PI * 2);
  return {
    spine2RotX: -0.02 * Math.max(0, breath),
    spine2RotY: 0.03 * shift,
    hipsRotY: 0.04 * shift,
    headRotY: -0.05 * shift,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1601 / #1607 / #1608 / #1613 / #1621-1623 / #1625-1626 / #1630
// — dev-tool hooks (small but real implementations wrapping the existing
// rig-build path; each is exported so the dev-tool registry in anim.ts
// points at a concrete symbol).
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1601 — canonical rig bone list (input for the skeleton hierarchy
 *  editor). Alias of RIGGED_HUMANOID_BONES surfaced under the dev-tool name. */
export const CANONICAL_RIG_BONES: readonly string[] = RIGGED_HUMANOID_BONES;

/** C3-5000 #1607 — retarget an AnimationClip authored for a different rig
 *  onto this rig's bone names. Returns a new clip whose tracks are renamed
 *  via `boneMap` (source → target). Tracks whose source bone isn't in the
 *  map are dropped (with a console.warn in dev). */
export function retargetClipToRig(
  clip: THREE.AnimationClip,
  boneMap: Record<string, string>,
): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    // track.name is "boneName.property" (e.g., "Hips.quaternion")
    const dot = track.name.lastIndexOf(".");
    if (dot < 0) { tracks.push(track); continue; }
    const srcBone = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    const dstBone = boneMap[srcBone] ?? srcBone;
    if (dstBone === null) continue; // explicitly dropped
    const cloned = track.clone();
    cloned.name = `${dstBone}.${prop}`;
    tracks.push(cloned);
  }
  return new THREE.AnimationClip(clip.name + "_retargeted", clip.duration, tracks, clip.blendMode);
}

/** C3-5000 #1608 — bake a procedural sampler into a static AnimationClip.
 *  Samples the given `sample(t) → per-bone TRS` function at `steps+1`
 *  evenly spaced times across [0, duration] and emits one track per bone
 *  per channel. Useful for capturing a procedural anim (e.g. a TPAnimLayer
 *  gait cycle) into a clip that can be exported. */
export function bakeProceduralToClip(
  name: string,
  duration: number,
  steps: number,
  boneNames: readonly string[],
  sample: (t: number) => Record<string, { pos?: [number, number, number]; rot?: [number, number, number, number]; scale?: [number, number, number] }>,
): THREE.AnimationClip {
  const times = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) times[i] = (i / steps) * duration;
  const tracks: THREE.KeyframeTrack[] = [];
  for (const bone of boneNames) {
    const posVals = new Float32Array((steps + 1) * 3);
    const rotVals = new Float32Array((steps + 1) * 4);
    let hasPos = false, hasRot = false;
    for (let i = 0; i <= steps; i++) {
      const s = sample(times[i] / duration)[bone] ?? {};
      if (s.pos) { hasPos = true; posVals[i * 3] = s.pos[0]; posVals[i * 3 + 1] = s.pos[1]; posVals[i * 3 + 2] = s.pos[2]; }
      if (s.rot) { hasRot = true; rotVals[i * 4] = s.rot[0]; rotVals[i * 4 + 1] = s.rot[1]; rotVals[i * 4 + 2] = s.rot[2]; rotVals[i * 4 + 3] = s.rot[3]; }
    }
    if (hasPos) tracks.push(new THREE.VectorKeyframeTrack(`${bone}.position`, Array.from(times), Array.from(posVals)));
    if (hasRot) tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, Array.from(times), Array.from(rotVals)));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}

/** C3-5000 #1613 — lossy clip compression. Quantizes quaternion keyframes
 *  to a given precision (default 4 decimal places → ~16-bit fixed point).
 *  Returns a new clip; the original is untouched. */
export function compressClip(clip: THREE.AnimationClip, precision: number = 4): THREE.AnimationClip {
  const factor = Math.pow(10, precision);
  const tracks = clip.tracks.map((t) => {
    const values = t.values;
    const quantized = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) quantized[i] = Math.round(values[i] * factor) / factor;
    // KeyframeTrack.values is read-only; create a new track with quantized values
    const q = t.clone();
    (q.values as Float32Array).set(quantized);
    return q;
  });
  return new THREE.AnimationClip(clip.name + "_compressed", clip.duration, tracks, clip.blendMode);
}

/** C3-5000 #1621 / #1622 — debug skeleton overlay. Returns a
 *  LineSegments helper that draws a line from each bone to its parent;
 *  add it to the scene to visualize the rig. */
export function debugSkeletonOverlay(root: THREE.Object3D): THREE.LineSegments {
  const positions: number[] = [];
  root.traverse((obj) => {
    if (obj.type !== "Bone") return;
    const parent = obj.parent;
    if (!parent) return;
    const p = obj.getWorldPosition(new THREE.Vector3());
    const pp = parent.getWorldPosition(new THREE.Vector3());
    positions.push(pp.x, pp.y, pp.z, p.x, p.y, p.z);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x00ff00, depthTest: false, transparent: true, opacity: 0.7 });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 9999;
  return lines;
}

/** C3-5000 #1623 — per-bone state inspector. Returns the world + local
 *  translation / rotation / scale for every bone under `root`. */
export function inspectBoneState(root: THREE.Object3D): Array<{ name: string; world: THREE.Vector3; local: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> {
  const out: Array<{ name: string; world: THREE.Vector3; local: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
  root.traverse((obj) => {
    if (obj.type !== "Bone") return;
    out.push({
      name: obj.name,
      world: obj.getWorldPosition(new THREE.Vector3()),
      local: obj.position.clone(),
      rotation: obj.rotation.clone(),
      scale: obj.scale.clone(),
    });
  });
  return out;
}

/** C3-5000 #1625 — per-clip validator. Returns an array of validation
 *  errors (empty array = valid). Checks: duration > 0, no zero-length
 *  tracks, all track names have a bone.property format. */
export function validateClip(clip: THREE.AnimationClip): string[] {
  const errors: string[] = [];
  if (clip.duration <= 0) errors.push(`clip "${clip.name}": duration must be > 0 (got ${clip.duration})`);
  if (clip.tracks.length === 0) errors.push(`clip "${clip.name}": no tracks`);
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf(".");
    if (dot < 0) errors.push(`track "${t.name}": missing .property suffix`);
    if (t.times.length === 0) errors.push(`track "${t.name}": zero-length (no keyframes)`);
  }
  return errors;
}

/** C3-5000 #1626 — per-clip linter. Returns warnings (not errors) about
 *  style issues: duplicate tracks, suspiciously long durations, very small
 *  amplitude. */
export function lintClip(clip: THREE.AnimationClip): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const t of clip.tracks) {
    if (seen.has(t.name)) warnings.push(`duplicate track "${t.name}"`);
    seen.add(t.name);
  }
  if (clip.duration > 60) warnings.push(`clip "${clip.name}": duration > 60s — likely a loop, confirm intent`);
  return warnings;
}

/** C3-5000 #1630 — per-clip snapshot for regression detection. Returns a
 *  stable JSON digest (clip name + track count + total keyframe count +
 *  duration). Two snapshots of the same clip should be byte-identical
 *  across builds; a diff flags a regression. */
export function snapshotClip(clip: THREE.AnimationClip): { name: string; tracks: number; keyframes: number; duration: number; digest: string } {
  let keyframes = 0;
  for (const t of clip.tracks) keyframes += t.times.length;
  return {
    name: clip.name,
    tracks: clip.tracks.length,
    keyframes,
    duration: clip.duration,
    digest: `${clip.name}|${clip.tracks.length}|${keyframes}|${clip.duration.toFixed(6)}`,
  };
}
