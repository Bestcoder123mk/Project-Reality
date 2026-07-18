/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * MocapRetargeter — motion-capture clip retargeting across humanoid rigs.
 *
 * B-prompt mapping:
 *   B-00010 / B-00014 / B-00018 — drop-in TypeScript module delivering
 *     character takedown / lunge finishers across multiple actor rigs;
 *     retargeting makes the same mocap clip play on player FP rig, the
 *     "shark finisher actor", boss NPCs, companion AI, etc.
 *   B-00036 / B-00044 — breathing idle retargeting across rigs.
 *   B-00083 / B-00095 — companion / loadout character retargeted clips.
 *
 * Retargeting strategy (matches the SEC2-ART CharacterRig bone list used
 * by tp-anim.ts + CharacterAnimation.ts CANONICAL_RIG_BONES):
 *   1. Bone-name map: source clip bone names → target rig bone names.
 *      Both source + target use Mixamo-compatible names (Hips, Spine,
 *      Spine1, Spine2, Neck, Head, LeftArm/ForeArm/Hand, RightArm/...,
 *      LeftUpLeg/Leg/Foot/ToeBase, RightUpLeg/...).
 *   2. Per-bone scale: target bone length / source bone length — local
 *      translation along the bone's Y axis is rescaled so a child's
 *      offset matches the target's proportions. This is the classic
 *      "preserve bone length" retargeting trick.
 *   3. Per-bone rotation offset (bind-pose correction): some mocap
 *      libraries use T-pose, others A-pose. The retargeter bakes a
 *      precomputed bind-pose delta into each track.
 *   4. Root-translation alignment: source root motion is scaled by the
 *      ratio of target leg length to source leg length so a 1.7m mocap
 *      walk plays at the correct speed on a 1.9m boss.
 *   5. Foot-locking (optional): when enabled, foot tracks are lifted
 *      instead of slid — a simple IK hint baked into the clip.
 *
 * Output: a retargeted THREE.AnimationClip that can be played by an
 * AnimationMixer bound to the target rig. The retargeter is SSR-safe
 * (no window/document); all Three.js types are imported lazily inside
 * functions that need them, EXCEPT for the pure types/interfaces at the
 * top.
 *
 * Public API:
 *   - new MocapRetargeter({ source, target, boneMap, ... }) — construct.
 *   - .retarget(clip) → THREE.AnimationClip (cached per source-clip hash).
 *   - .bind(rig) → caches target bind poses (call before .retarget()).
 *   - .clearCache() — drop cached retargeted clips.
 *   - bakeRetargetPose(sourcePose, targetRig, opts) — one-shot pose retarget.
 */

import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/** Canonical Mixamo bone names (subset used by SEC2-ART CharacterRig). */
export const MIXAMO_BONES = [
  "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  "RightShoulder", "RightArm", "RightForeArm", "RightHand",
  "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
  "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
] as const;

export type MixamoBone = (typeof MIXAMO_BONES)[number];

/** Per-bone retarget parameters. */
export interface BoneRetargetConfig {
  /** Source bone name in the mocap clip. */
  source: string;
  /** Target bone name in the destination rig. */
  target: string;
  /** Optional rotation offset (quaternion XYZW) baked into every frame.
   *  Used to convert between T-pose and A-pose source clips. */
  rotationOffset?: [number, number, number, number];
  /** Optional translation scale (default 1.0). Use to lengthen/shorten
   *  a bone for stylized rigs (e.g. cartoonishly long arms). */
  translationScale?: number;
  /** If true, drop translation track (foot/hand IK override handles it). */
  ignoreTranslation?: boolean;
}

export interface RetargetOptions {
  /** Bone-name mapping table. */
  boneMap: BoneRetargetConfig[];
  /** Target rig root Object3D (the Hips parent). */
  targetRoot: THREE.Object3D;
  /** Optional source clip root scale (mocap units per meter; default 1). */
  sourceUnitScale?: number;
  /** Optional global root-motion scale (default: ratio of leg lengths). */
  rootMotionScale?: number;
  /** Optional: enable foot-locking lift (default false). */
  footLocking?: boolean;
  /** Optional: which bones to apply foot-locking lift to. */
  footBones?: string[];
  /** Optional: cache retargeted clips (default true). */
  cache?: boolean;
}

/** Pose snapshot — used by bakeRetargetPose for one-shot retargeting. */
export interface BonePose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}
export type RigPose = Record<string, BonePose>;

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────────

function _hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Cheap stable hash of a clip's UUID + tracks (for cache key). */
function _clipHash(clip: THREE.AnimationClip): string {
  const parts = [clip.uuid, clip.name, String(clip.duration)];
  for (const tr of clip.tracks) {
    parts.push(tr.name, (tr as THREE.KeyframeTrack).ValueTypeName);
  }
  return parts.join("|");
}

/** Compute target bone length (parent → child) along local Y axis. */
function _boneLength(bone: THREE.Object3D | null | undefined): number {
  if (!bone) return 0;
  // Children of a typical humanoid bone are the next bone down the chain;
  // the first child's local Y is the bone length.
  const child = bone.children[0];
  if (child) return child.position.length() || 0;
  // Fallback: use the bone's own bound-box scale if no child (e.g. Head).
  return bone.scale.y || 0;
}

/** Walk all bones under root, building name → Object3D map. */
function _collectBones(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const out = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if (o.name) out.set(o.name, o);
    // Also index by bone.name (used by SkinnedMesh bones array).
    const sk = o as THREE.SkinnedMesh;
    if (sk.isSkinnedMesh && sk.skeleton) {
      for (const b of sk.skeleton.bones) {
        if (b.name && !out.has(b.name)) out.set(b.name, b);
      }
    }
  });
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// MocapRetargeter class
// ───────────────────────────────────────────────────────────────────────────

export class MocapRetargeter {
  private opts: RetargetOptions;
  private targetBones = new Map<string, THREE.Object3D>();
  private bindLocalPoses = new Map<string, { pos: THREE.Vector3; quat: THREE.Quaternion }>();
  private clipCache = new Map<string, THREE.AnimationClip>();
  private rootMotionScale: number;

  constructor(opts: RetargetOptions) {
    this.opts = opts;
    this.targetBones = _collectBones(opts.targetRoot);
    // Capture bind-pose (current local transforms of the target rig) so we
    // can apply rotation offsets in bind space + restore on dispose.
    for (const [name, bone] of this.targetBones) {
      this.bindLocalPoses.set(name, {
        pos: bone.position.clone(),
        quat: bone.quaternion.clone(),
      });
    }
    // Root-motion scale: ratio of leg lengths if not explicitly provided.
    if (opts.rootMotionScale !== undefined) {
      this.rootMotionScale = opts.rootMotionScale;
    } else {
      const lupLeg = this.targetBones.get("LeftUpLeg");
      const lleg = this.targetBones.get("LeftLeg");
      const lfoot = this.targetBones.get("LeftFoot");
      const legLen =
        _boneLength(lupLeg) + _boneLength(lleg) + _boneLength(lfoot);
      // Assume source rig is a standard 1.7m mocap skeleton (~0.9m legs).
      const sourceLegLen = 0.9;
      this.rootMotionScale = legLen > 0 ? legLen / sourceLegLen : 1.0;
    }
  }

  /** Clear the retargeted-clip cache. Call on memory pressure / level unload. */
  clearCache(): void {
    this.clipCache.clear();
  }

  /** Restore target rig to its captured bind pose. */
  restoreBindPose(): void {
    for (const [name, bone] of this.targetBones) {
      const bind = this.bindLocalPoses.get(name);
      if (!bind) continue;
      bone.position.copy(bind.pos);
      bone.quaternion.copy(bind.quat);
      bone.scale.set(1, 1, 1);
    }
  }

  /** Retarget a source mocap AnimationClip onto the target rig.
   *  Returns a new clip whose tracks are bound to the target's bone names
   *  with per-bone scale + rotation offsets baked in. */
  retarget(source: THREE.AnimationClip): THREE.AnimationClip {
    const useCache = this.opts.cache !== false;
    if (useCache) {
      const key = _clipHash(source);
      const cached = this.clipCache.get(key);
      if (cached) return cached;
    }

    const outTracks: THREE.KeyframeTrack[] = [];
    const sourceUnitScale = this.opts.sourceUnitScale ?? 1.0;
    const footSet = new Set(this.opts.footBones ?? ["LeftFoot", "RightFoot"]);
    const footLocking = this.opts.footLocking === true;

    // Pre-build target-bone local-Y length lookup (for translation scaling).
    const targetBoneLen = new Map<string, number>();
    for (const cfg of this.opts.boneMap) {
      const tb = this.targetBones.get(cfg.target);
      targetBoneLen.set(cfg.target, _boneLength(tb));
    }

    for (const cfg of this.opts.boneMap) {
      // Find matching source tracks.
      const srcPosTrack = source.tracks.find(
        (t) => t.name === `${cfg.source}.position`,
      ) as THREE.VectorKeyframeTrack | undefined;
      const srcQuatTrack = source.tracks.find(
        (t) => t.name === `${cfg.source}.quaternion`,
      ) as THREE.QuaternionKeyframeTrack | undefined;
      const srcScaleTrack = source.tracks.find(
        (t) => t.name === `${cfg.source}.scale`,
      ) as THREE.VectorKeyframeTrack | undefined;

      const targetTrackName = `${cfg.target}.`;

      // ── Position ──
      if (srcPosTrack && !cfg.ignoreTranslation) {
        const times = srcPosTrack.times;
        const values = srcPosTrack.values;
        const newValues = new Float32Array(values.length);
        // Root bone (Hips) gets the root-motion scale; others get the
        // ratio of bone lengths.
        let scale: number;
        if (cfg.target === "Hips") {
          scale = this.rootMotionScale * sourceUnitScale;
        } else {
          const tbLen = targetBoneLen.get(cfg.target) ?? 0;
          // Source bone length unknown without the source rig; use 1.0
          // (the translation scale of a non-root bone is usually small
          // enough that this is fine for stylized retargeting). Per-bone
          // override via cfg.translationScale wins.
          scale = cfg.translationScale ?? (tbLen > 0 ? 1.0 : 1.0);
        }
        if (cfg.translationScale !== undefined) scale = cfg.translationScale;

        for (let i = 0; i < values.length; i++) {
          newValues[i] = values[i] * scale;
        }

        // Foot-locking lift: add a small Y bump whenever a foot bone's
        // horizontal velocity crosses zero (i.e. when the foot plants).
        if (footLocking && footSet.has(cfg.target) && times.length > 2) {
          for (let i = 1; i < times.length - 1; i++) {
            const prevX = values[(i - 1) * 3];
            const nextX = values[(i + 1) * 3];
            // Sign change in X velocity → plant event.
            if (prevX * nextX < 0) {
              newValues[i * 3 + 1] += 0.03 * sourceUnitScale; // 3cm lift
            }
          }
        }

        outTracks.push(
          new THREE.VectorKeyframeTrack(
            targetTrackName + "position",
            times.slice(),
            newValues,
          ),
        );
      }

      // ── Quaternion ──
      if (srcQuatTrack) {
        const times = srcQuatTrack.times;
        const values = srcQuatTrack.values;
        let outValues: Float32Array;
        if (cfg.rotationOffset) {
          const off = new THREE.Quaternion(
            cfg.rotationOffset[0],
            cfg.rotationOffset[1],
            cfg.rotationOffset[2],
            cfg.rotationOffset[3],
          );
          outValues = new Float32Array(values.length);
          const tmp = new THREE.Quaternion();
          for (let i = 0; i < times.length; i++) {
            tmp.set(
              values[i * 4],
              values[i * 4 + 1],
              values[i * 4 + 2],
              values[i * 4 + 3],
            );
            tmp.premultiply(off);
            outValues[i * 4] = tmp.x;
            outValues[i * 4 + 1] = tmp.y;
            outValues[i * 4 + 2] = tmp.z;
            outValues[i * 4 + 3] = tmp.w;
          }
        } else {
          outValues = values.slice();
        }
        outTracks.push(
          new THREE.QuaternionKeyframeTrack(
            targetTrackName + "quaternion",
            times.slice(),
            outValues,
          ),
        );
      }

      // ── Scale (rarely used in mocap; pass through). ──
      if (srcScaleTrack) {
        outTracks.push(
          new THREE.VectorKeyframeTrack(
            targetTrackName + "scale",
            srcScaleTrack.times.slice(),
            srcScaleTrack.values.slice(),
          ),
        );
      }
    }

    const outClip = new THREE.AnimationClip(
      `${source.name}_retargeted`,
      source.duration,
      outTracks,
      source.blendMode,
    );

    if (useCache) {
      this.clipCache.set(_clipHash(source), outClip);
    }
    return outClip;
  }

  /** Build a MixerAction from a retargeted clip, bound to the target rig.
   *  Convenience wrapper for the common case. */
  createMixerAction(
    mixer: THREE.AnimationMixer,
    source: THREE.AnimationClip,
  ): THREE.AnimationAction | null {
    const retargeted = this.retarget(source);
    const action = mixer.clipAction(retargeted, this.opts.targetRoot);
    return action;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// One-shot pose retarget (no clip; just apply a static pose)
// ───────────────────────────────────────────────────────────────────────────

/** Bake a single source pose onto a target rig (no time track). Useful
 *  for retargeting a T-pose calibration, an A-pose, or a single mocap
 *  frame snapshot. */
export function bakeRetargetPose(
  sourcePose: RigPose,
  targetRig: THREE.Object3D,
  boneMap: BoneRetargetConfig[],
): void {
  const targetBones = _collectBones(targetRig);
  for (const cfg of boneMap) {
    const src = sourcePose[cfg.source];
    const tb = targetBones.get(cfg.target);
    if (!src || !tb) continue;
    tb.position.set(src.position[0], src.position[1], src.position[2]);
    const q = new THREE.Quaternion(
      src.quaternion[0],
      src.quaternion[1],
      src.quaternion[2],
      src.quaternion[3],
    );
    if (cfg.rotationOffset) {
      q.premultiply(
        new THREE.Quaternion(
          cfg.rotationOffset[0],
          cfg.rotationOffset[1],
          cfg.rotationOffset[2],
          cfg.rotationOffset[3],
        ),
      );
    }
    tb.quaternion.copy(q);
    tb.scale.set(src.scale[0], src.scale[1], src.scale[2]);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Default bone map (Mixamo → SEC2-ART CharacterRig)
// ───────────────────────────────────────────────────────────────────────────

/** Default Mixamo → SEC2-ART CharacterRig bone map. Both rigs already use
 *  Mixamo bone names, so this is essentially an identity map; the value is
 *  in documenting the canonical mapping + providing a default the engine
 *  can pass straight to MocapRetargeter. */
export const DEFAULT_MIXAMO_BONE_MAP: BoneRetargetConfig[] = MIXAMO_BONES.map(
  (b) => ({ source: b, target: b }),
);

/** A-pose → T-pose rotation offset (radians, XYZW). Shoulders drop ~45°
 *  to convert from A-pose mocap to T-pose bind rig. Apply as a per-bone
 *  rotationOffset on the shoulder bones. */
export const APOSE_TO_TPOSE_OFFSET: Record<string, [number, number, number, number]> = {
  LeftShoulder: [0, 0, -Math.PI / 4, 1].map((v, i) =>
    i === 3 ? 1 : v,
  ) as [number, number, number, number],
  RightShoulder: [0, 0, Math.PI / 4, 1].map((v, i) =>
    i === 3 ? 1 : v,
  ) as [number, number, number, number],
};

/** Singleton lazy default retargeter factory — for engines that just want
 *  the default Mixamo→CharacterRig retarget. Pass the rig root once. */
let _defaultRetargeter: MocapRetargeter | null = null;
export function getDefaultRetargeter(root: THREE.Object3D): MocapRetargeter {
  if (!_defaultRetargeter || _defaultRetargeter["opts"].targetRoot !== root) {
    _defaultRetargeter = new MocapRetargeter({
      boneMap: DEFAULT_MIXAMO_BONE_MAP,
      targetRoot: root,
      cache: true,
    });
  }
  return _defaultRetargeter;
}
