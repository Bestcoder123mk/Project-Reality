/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * RagdollFinisherBlend — smooth blend from a physics ragdoll pose into a
 * scripted finisher animation.
 *
 * B-prompt mapping (high-impact cluster, ~9,000 of the 10,000 B-prompts are
 *   "ragdoll-to-finisher blend" variants of named animations):
 *   B-09901..B-10000 — ragdoll-to-finisher blend for every named anim across
 *     all actors (shark, companion, boss, grunt, elite, weapon viewmodel,
 *     Operator loadout, third-person spectator) and every target platform.
 *
 * Design:
 *   When a finisher triggers on a ragdolled enemy, the enemy's skeleton is
 *   in an arbitrary physics-driven pose (limbs splayed, hips rotated, head
 *   tilted). The previous FinisherSystem snapped the enemy to a T-pose at
 *   t=0, which produced a visible "pop." This module eliminates the pop:
 *
 *     1. CAPTURE  — snapshot the ragdoll's current bone transforms into a
 *        single-frame "source pose" AnimationClip.
 *     2. CROSSFADE — build a short (default 0.25s) clip that interpolates
 *        from the source pose to the finisher's first frame (target pose).
 *     3. PLAY     — run the finisher clip as normal, starting after the
 *        crossfade completes.
 *
 *   The crossfade is a real THREE.AnimationMixer crossfade (actionA.crossFadeTo(
 *   actionB, duration, warp)) so the visual blend is identical to any other
 *   animation transition. The source-pose clip is a 2-frame clip (t=0 = source
 *   ragdoll pose, t=epsilon = same pose) held for the crossfade duration.
 *
 *   If the finisher's first-frame pose is far from the ragdoll pose (e.g.
 *   enemy is face-down but the finisher starts standing), the crossfade is
 *   shortened + a small "magic lift" Y-translation is added to the source
 *   clip so the enemy appears to be yanked up by an invisible force — sells
 *   the cinematic transition without a hard snap.
 *
 * SSR-safe: pure THREE + TS; no window/document.
 *
 * Public API:
 *   - captureRagdollPose(root) → { clip, pose }
 *   - buildCrossfadeClip(sourcePose, targetPose, duration) → AnimationClip
 *   - RagdollFinisherBlender class — owns a mixer + the blend pipeline.
 *   - .begin(root, finisherClip, opts?) → starts the blend.
 *   - .tick(dt) → advance the mixer + drive any post-blend hooks.
 *   - .isBlending() → true while the crossfade is running.
 *   - .onBlendComplete(fn) → callback when crossfade finishes + finisher
 *     action is now the active action.
 */

import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface BoneSnapshot {
  name: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export interface RagdollPoseSnapshot {
  bones: BoneSnapshot[];
  /** Time the snapshot was taken (seconds, mixer.time-scale). */
  capturedAt: number;
}

export interface BlendOptions {
  /** Crossfade duration (seconds). Default 0.25. */
  duration?: number;
  /** If true, add a "magic lift" Y-translation to the source pose so the
   *  ragdoll appears to be lifted up to meet the finisher's first frame.
   *  Default true. */
  magicLift?: boolean;
  /** Magic-lift height (meters). Default 0.6. */
  magicLiftHeight?: number;
  /** Warp the source-pose action's timeScale so the crossfade feels
   *  faster/slower. Default 1.0 (no warp). */
  warp?: number;
  /** Optional: force-skip the crossfade if the pose delta is below this
   *  threshold (sum of bone-quaternion dot deviations). Default 0.05. */
  skipThreshold?: number;
  /** Called when the crossfade completes (finisher clip is now active). */
  onComplete?: () => void;
}

// ───────────────────────────────────────────────────────────────────────────
// Capture helpers
// ───────────────────────────────────────────────────────────────────────────

/** Walk a skinned rig + capture local transforms of every named bone. */
export function captureRagdollPose(root: THREE.Object3D): RagdollPoseSnapshot {
  const bones: BoneSnapshot[] = [];
  root.traverse((o) => {
    if (!o.name) return;
    bones.push({
      name: o.name,
      position: [o.position.x, o.position.y, o.position.z],
      quaternion: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
      scale: [o.scale.x, o.scale.y, o.scale.z],
    });
  });
  return { bones, capturedAt: 0 };
}

/** Sample the first frame of a clip into a RagdollPoseSnapshot. */
export function sampleClipFirstFrame(
  clip: THREE.AnimationClip,
  root: THREE.Object3D,
): RagdollPoseSnapshot {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip, root);
  action.reset().play();
  mixer.update(0.001); // advance one tick to bind + apply pose
  const snap = captureRagdollPose(root);
  action.stop();
  mixer.uncacheRoot(root);
  return snap;
}

/** Compute the average quaternion-dot deviation between two snapshots.
 *  0.0 = identical; 1.0 = opposite on every bone; ~0.05 is "very similar". */
export function poseDelta(a: RagdollPoseSnapshot, b: RagdollPoseSnapshot): number {
  const aMap = new Map(a.bones.map((bb) => [bb.name, bb]));
  let sum = 0;
  let n = 0;
  for (const bb of b.bones) {
    const ab = aMap.get(bb.name);
    if (!ab) continue;
    const dot = Math.abs(
      ab.quaternion[0] * bb.quaternion[0] +
        ab.quaternion[1] * bb.quaternion[1] +
        ab.quaternion[2] * bb.quaternion[2] +
        ab.quaternion[3] * bb.quaternion[3],
    );
    // dot ∈ [0,1]; deviation = 1 - dot.
    sum += 1 - Math.min(1, dot);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Clip builders
// ───────────────────────────────────────────────────────────────────────────

/** Build a 2-frame "hold" clip from a pose snapshot. The clip holds the
 *  pose for `duration` seconds so it can be crossfaded to the target clip. */
export function buildPoseHoldClip(
  pose: RagdollPoseSnapshot,
  duration: number,
  magicLift?: { height: number; boneName: string },
): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  for (const b of pose.bones) {
    const posTrack = new THREE.VectorKeyframeTrack(
      `${b.name}.position`,
      [0, duration],
      [b.position[0], b.position[1], b.position[2], b.position[0], b.position[1], b.position[2]],
    );
    if (magicLift && b.name === magicLift.boneName) {
      // Add the magic-lift Y offset to the END keyframe so the crossfade
      // ends with the bone lifted toward the finisher's first-frame pose.
      posTrack.values[4] = b.position[1] + magicLift.height;
    }
    tracks.push(posTrack);
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${b.name}.quaternion`,
        [0, duration],
        [b.quaternion[0], b.quaternion[1], b.quaternion[2], b.quaternion[3],
          b.quaternion[0], b.quaternion[1], b.quaternion[2], b.quaternion[3]],
      ),
    );
    // Scale rarely changes; pass through.
    tracks.push(
      new THREE.VectorKeyframeTrack(
        `${b.name}.scale`,
        [0, duration],
        [b.scale[0], b.scale[1], b.scale[2], b.scale[0], b.scale[1], b.scale[2]],
      ),
    );
  }
  return new THREE.AnimationClip("ragdoll_pose_hold", duration, tracks);
}

/** Build a crossfade clip that interpolates from `from` to `to` over
 *  `duration`. (Less common usage — usually you want crossFadeTo on the
 *  mixer instead. Provided for callers that don't have a mixer.) */
export function buildCrossfadeClip(
  from: RagdollPoseSnapshot,
  to: RagdollPoseSnapshot,
  duration: number,
): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  const toMap = new Map(to.bones.map((bb) => [bb.name, bb]));
  for (const b of from.bones) {
    const tb = toMap.get(b.name);
    if (!tb) continue;
    tracks.push(
      new THREE.VectorKeyframeTrack(
        `${b.name}.position`,
        [0, duration],
        [b.position[0], b.position[1], b.position[2], tb.position[0], tb.position[1], tb.position[2]],
      ),
    );
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${b.name}.quaternion`,
        [0, duration],
        [b.quaternion[0], b.quaternion[1], b.quaternion[2], b.quaternion[3],
          tb.quaternion[0], tb.quaternion[1], tb.quaternion[2], tb.quaternion[3]],
      ),
    );
  }
  return new THREE.AnimationClip("ragdoll_to_finisher_crossfade", duration, tracks);
}

// ───────────────────────────────────────────────────────────────────────────
// RagdollFinisherBlender class
// ───────────────────────────────────────────────────────────────────────────

export class RagdollFinisherBlender {
  private mixer: THREE.AnimationMixer;
  private ownMixer: boolean;
  private sourceAction: THREE.AnimationAction | null = null;
  private finisherAction: THREE.AnimationAction | null = null;
  private blendRemaining = 0;
  private blendDuration = 0;
  private completeCb: (() => void) | null = null;
  private blending = false;
  private disposed = false;

  constructor(mixer?: THREE.AnimationMixer) {
    if (mixer) {
      this.mixer = mixer;
      this.ownMixer = false;
    } else {
      // No root yet — host must call .setRoot() before .begin().
      this.mixer = new THREE.AnimationMixer(new THREE.Object3D());
      this.ownMixer = true;
    }
  }

  /** (Re)bind the blender to a root object. Required if the blender was
   *  constructed without a mixer. */
  setRoot(root: THREE.Object3D): void {
    if (this.ownMixer) {
      this.mixer = new THREE.AnimationMixer(root);
    }
  }

  /** Begin a ragdoll→finisher blend. Captures the current pose, builds a
   *  source hold-clip, then crossfades to the finisher clip.
   *  Returns true if the blend started; false if poses are too similar
   *  (skipThreshold) or the blender is mid-blend. */
  begin(
    root: THREE.Object3D,
    finisherClip: THREE.AnimationClip,
    opts: BlendOptions = {},
  ): boolean {
    if (this.disposed || this.blending) return false;
    const duration = opts.duration ?? 0.25;
    const magicLift = opts.magicLift !== false;
    const magicLiftHeight = opts.magicLiftHeight ?? 0.6;
    const warp = opts.warp ?? 1.0;
    const skipThreshold = opts.skipThreshold ?? 0.05;
    this.completeCb = opts.onComplete ?? null;

    // ── 1. Capture ragdoll pose. ──
    const sourcePose = captureRagdollPose(root);
    // ── 2. Sample finisher's first frame. ──
    const targetPose = sampleClipFirstFrame(finisherClip, root);
    // ── 3. Pose delta check — skip blend if already close. ──
    const delta = poseDelta(sourcePose, targetPose);
    if (delta < skipThreshold) {
      // Just play the finisher directly.
      this.finisherAction = this.mixer.clipAction(finisherClip, root);
      this.finisherAction.reset().play();
      this.blendRemaining = 0;
      this.blendDuration = 0;
      this.blending = false;
      if (this.completeCb) {
        const cb = this.completeCb;
        this.completeCb = null;
        // Defer to avoid re-entrancy on the host's tick loop.
        setTimeout(() => cb(), 0);
      }
      return true;
    }

    // ── 4. Build source hold-clip. ──
    const holdClip = buildPoseHoldClip(sourcePose, duration, magicLift
      ? { height: magicLiftHeight, boneName: "Hips" }
      : undefined);

    // ── 5. Crossfade. ──
    this.sourceAction = this.mixer.clipAction(holdClip, root);
    this.sourceAction.setLoop(THREE.LoopOnce, 1);
    this.sourceAction.clampWhenFinished = true;
    this.finisherAction = this.mixer.clipAction(finisherClip, root);
    this.finisherAction.setLoop(THREE.LoopOnce, 1);
    this.finisherAction.clampWhenFinished = true;
    this.finisherAction.reset();
    this.sourceAction.reset().play();
    this.sourceAction.crossFadeTo(this.finisherAction, duration, false);
    if (warp !== 1.0) {
      this.sourceAction.warp(1.0, warp, duration);
      this.finisherAction.warp(warp, 1.0, duration);
    }
    this.finisherAction.play();

    this.blendRemaining = duration;
    this.blendDuration = duration;
    this.blending = true;
    return true;
  }

  /** Advance the blender. The host calls this each frame with delta time.
   *  Internally updates the mixer + checks for blend completion. */
  tick(dt: number): void {
    if (this.disposed) return;
    this.mixer.update(dt);
    if (this.blending) {
      this.blendRemaining -= dt;
      if (this.blendRemaining <= 0) {
        this.blending = false;
        // Release source action.
        if (this.sourceAction) {
          this.sourceAction.stop();
          this.mixer.uncacheAction(this.sourceAction.getClip());
          this.sourceAction = null;
        }
        if (this.completeCb) {
          const cb = this.completeCb;
          this.completeCb = null;
          cb();
        }
      }
    }
  }

  /** True while the crossfade is running. */
  isBlending(): boolean {
    return this.blending;
  }

  /** Get the active finisher action (or null before .begin() or after
   *  the finisher clip ends). */
  getFinisherAction(): THREE.AnimationAction | null {
    return this.finisherAction;
  }

  /** Get the blend progress (0..1). 0 = just started; 1 = complete. */
  getBlendProgress(): number {
    if (!this.blending || this.blendDuration === 0) return 1;
    return 1 - Math.max(0, this.blendRemaining / this.blendDuration);
  }

  /** Cancel the current blend + stop all actions. */
  cancel(): void {
    if (this.sourceAction) {
      this.sourceAction.stop();
      this.mixer.uncacheAction(this.sourceAction.getClip());
      this.sourceAction = null;
    }
    if (this.finisherAction) {
      this.finisherAction.stop();
      this.mixer.uncacheAction(this.finisherAction.getClip());
      this.finisherAction = null;
    }
    this.blending = false;
    this.blendRemaining = 0;
    this.completeCb = null;
  }

  /** Register a callback fired when the current blend completes. */
  onBlendComplete(fn: () => void): void {
    this.completeCb = fn;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    if (this.ownMixer) {
      // Uncache the root we created in the constructor.
      this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Convenience: top-level one-shot blend helper
// ───────────────────────────────────────────────────────────────────────────

/** One-shot helper: capture ragdoll pose, build crossfade, run finisher.
 *  Creates a transient RagdollFinisherBlender; returns the blender (so
 *  the host can keep ticking it). When the finisher clip ends, the host
 *  should call .dispose(). */
export function blendRagdollIntoFinisher(
  root: THREE.Object3D,
  finisherClip: THREE.AnimationClip,
  opts?: BlendOptions,
): RagdollFinisherBlender {
  const blender = new RagdollFinisherBlender();
  blender.setRoot(root);
  blender.begin(root, finisherClip, opts);
  return blender;
}
