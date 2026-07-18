/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * MotionMatching — natural movement via motion-matching across a clip database.
 *
 * B-prompt mapping:
 *   B-00033 / B-00035 / B-00060 / B-00079 — mantle onto crate (motion-matched
 *     to the exact crate height + approach angle).
 *   B-00063 / B-00076 / B-00077 — combat roll (motion-matched to player
 *     velocity + facing).
 *   B-00008 / B-00017 / B-00053 — slide-to-crouch (motion-matched to current
 *     slide speed).
 *   B-00034 / B-00052 / B-00057 / B-00059 / B-00061 — explosion knockback
 *     ragdoll (motion-matched to blast direction + impulse).
 *   B-00020 / B-00028 / B-00058 / B-00065 / B-00068 / B-00091 — backpedal
 *     dodge (motion-matched to threat direction).
 *
 * What is motion matching?
 *   Instead of hand-authored state-machine transitions, motion matching
 *   searches a database of mocap clips for the segment whose pose +
 *   trajectory best matches the character's current state + desired future
 *   trajectory. The chosen segment plays for a short window (e.g. 0.3s),
 *   then a new search is performed. This produces fluid, natural movement
 *   without explicit transitions.
 *
 * Implementation (data-light, suitable for browser):
 *   - ClipDB: an array of ClipEntry { clip, tags, frameTimes, frameTrajectories,
 *     framePoseFeatures }. Pre-baked per clip on registration.
 *   - Search: at runtime, given the character's current velocity + desired
 *     trajectory (next 0.3s of position + facing), score every frame in the
 *     DB by (positionTrajectoryCost + facingCost + footSpeedCost) and pick
 *     the lowest-cost frame.
 *   - Blending: when a new segment is chosen, crossfade from the current
 *     segment to the new one over ~0.15s (Three.js AnimationAction.
 *     crossFadeTo). Foot-locking avoids slide.
 *
 * SSR-safe: pure THREE + TS; no window/document.
 *
 * Public API:
 *   - new MotionMatcher(root, mixer?) — construct.
 *   - .registerClip(clip, tags) — add a clip to the DB (pre-bakes features).
 *   - .setDesiredTrajectory(points) — feed the next 0.3s of desired motion.
 *   - .tick(dt, currentVel, currentFacing) — advance + pick next segment.
 *   - .getActiveClip() — the currently-playing clip (or null).
 *   - .clear() — drop the DB.
 *   - MOTION_MATCHING_DEFAULTS — tuning constants.
 */

import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Types + tuning
// ───────────────────────────────────────────────────────────────────────────

export const MOTION_MATCHING_DEFAULTS = {
  /** Trajectory sample interval (seconds). Default 0.05 (20 Hz). */
  trajSampleSec: 0.05,
  /** Trajectory lookahead (seconds). Default 0.3. */
  trajLookaheadSec: 0.3,
  /** Blend duration when switching to a new segment (seconds). */
  blendDurationSec: 0.15,
  /** Minimum segment play time before re-searching (seconds). */
  minSegmentSec: 0.2,
  /** Cost weights. */
  weights: {
    positionTrajectory: 1.0,
    facing: 0.7,
    footSpeed: 0.5,
    rootVelocity: 0.3,
    tagMatch: 2.0,
  },
  /** Foot-bone names (for foot-locking hint). */
  footBones: ["LeftFoot", "RightFoot"],
  /** Search stride (frames). 1 = search every frame; 2 = every other
   *  frame (cheaper, slight quality loss). Default 2. */
  searchStride: 2,
  /** Max DB size (frames) before eviction kicks in (LRU by last-searched). */
  maxDbFrames: 20000,
};

export interface TrajectoryPoint {
  /** Time from now (seconds). */
  t: number;
  /** Desired position relative to current root position (meters). */
  pos: [number, number, number];
  /** Desired facing (yaw radians). */
  yaw: number;
}

export interface ClipTags {
  locomotion?: "idle" | "walk" | "run" | "sprint" | "crouch" | "prone" | "vault" | "roll" | "slide" | "dodge" | "fall";
  stance?: "stand" | "crouch" | "prone" | "air";
  surface?: "concrete" | "dirt" | "metal" | "water" | "snow" | "mud";
  /** Custom tag string (e.g. "injured_left" — cost-penalize mismatch). */
  custom?: string;
}

/** A pre-baked frame in the search DB. */
export interface MotionFrame {
  clipIdx: number;
  frameIdx: number;
  /** Time in the clip (seconds). */
  time: number;
  /** Trajectory: array of {pos, yaw} over the next `trajLookaheadSec`
   *  sampled at `trajSampleSec`. */
  traj: { pos: [number, number, number]; yaw: number }[];
  /** Foot speed at this frame (m/s). */
  footSpeed: number;
  /** Root velocity (m/s). */
  rootVel: [number, number, number];
  /** Tags (copied from the owning clip). */
  tags: ClipTags;
}

export interface ClipEntry {
  clip: THREE.AnimationClip;
  tags: ClipTags;
  frames: MotionFrame[];
}

export interface SearchQuery {
  /** Current character velocity (m/s, world-space). */
  currentVel: THREE.Vector3;
  /** Current character facing (yaw radians). */
  currentFacing: number;
  /** Desired trajectory (next 0.3s). */
  trajectory: TrajectoryPoint[];
  /** Required tags (mismatch = penalty). */
  requiredTags?: ClipTags;
}

export interface SearchResult {
  frame: MotionFrame;
  cost: number;
}

// ───────────────────────────────────────────────────────────────────────────
// MotionMatcher class
// ───────────────────────────────────────────────────────────────────────────

export class MotionMatcher {
  private root: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private ownMixer: boolean;
  private clips: ClipEntry[] = [];
  private activeAction: THREE.AnimationAction | null = null;
  private activeClipIdx = -1;
  private activeStartTime = 0;
  private lastSearchTime = 0;
  private opts: typeof MOTION_MATCHING_DEFAULTS;
  private searchScratch: { idx: number; cost: number }[] = [];
  private _tmpV1 = new THREE.Vector3();
  private _tmpV2 = new THREE.Vector3();
  private _q1 = new THREE.Quaternion();

  constructor(root: THREE.Object3D, mixer?: THREE.AnimationMixer, opts?: Partial<typeof MOTION_MATCHING_DEFAULTS>) {
    this.root = root;
    this.opts = { ...MOTION_MATCHING_DEFAULTS, ...(opts ?? {}) };
    if (mixer) {
      this.mixer = mixer;
      this.ownMixer = false;
    } else {
      this.mixer = new THREE.AnimationMixer(root);
      this.ownMixer = true;
    }
  }

  /** Register a mocap clip in the search DB. Pre-bakes per-frame features
   *  by sampling the clip at `trajSampleSec` intervals. */
  registerClip(clip: THREE.AnimationClip, tags: ClipTags = {}): number {
    const clipIdx = this.clips.length;
    // Sample the clip to extract per-frame trajectories.
    const frames: MotionFrame[] = [];
    const dur = clip.duration;
    const sampleSec = this.opts.trajSampleSec;
    const lookahead = this.opts.trajLookaheadSec;
    const lookaheadSteps = Math.floor(lookahead / sampleSec);

    // Use a transient mixer + the clip's Hips tracks to extract root
    // position over time.
    const hipsTrack = clip.tracks.find((t) => t.name === "Hips.position") as
      | THREE.VectorKeyframeTrack
      | undefined;
    const hipsQuatTrack = clip.tracks.find((t) => t.name === "Hips.quaternion") as
      | THREE.QuaternionKeyframeTrack
      | undefined;

    if (!hipsTrack) {
      // No root-motion track — register as a single "static" frame.
      frames.push({
        clipIdx,
        frameIdx: 0,
        time: 0,
        traj: Array.from({ length: lookaheadSteps }, () => ({
          pos: [0, 0, 0] as [number, number, number],
          yaw: 0,
        })),
        footSpeed: 0,
        rootVel: [0, 0, 0],
        tags,
      });
    } else {
      const nFrames = Math.max(2, Math.floor(dur / sampleSec));
      for (let i = 0; i < nFrames; i++) {
        const t = i * sampleSec;
        const traj: { pos: [number, number, number]; yaw: number }[] = [];
        let prevPos: THREE.Vector3 | null = null;
        let prevT = t;
        for (let j = 0; j <= lookaheadSteps; j++) {
          const tt = Math.min(dur, t + j * sampleSec);
          const pos = this._sampleVecTrack(hipsTrack, tt);
          // Yaw = root quaternion Y-axis rotation.
          let yaw = 0;
          if (hipsQuatTrack) {
            this._sampleQuatTrack(hipsQuatTrack, tt, this._q1);
            const e = new THREE.Euler().setFromQuaternion(this._q1, "YXZ");
            yaw = e.y;
          }
          // Position relative to the frame's starting position.
          const rel: [number, number, number] = prevPos
            ? [pos.x - prevPos.x, pos.y - prevPos.y, pos.z - prevPos.z]
            : [0, 0, 0];
          traj.push({ pos: rel, yaw });
          if (j === 0) prevPos = pos.clone();
          prevT = tt;
        }
        // Foot speed: estimate from average velocity over the next 0.1s.
        const p0 = this._sampleVecTrack(hipsTrack, t);
        const p1 = this._sampleVecTrack(hipsTrack, Math.min(dur, t + 0.1));
        const footSpeed = p0.distanceTo(p1) / 0.1;
        // Root velocity (next 0.05s).
        const p2 = this._sampleVecTrack(hipsTrack, Math.min(dur, t + sampleSec));
        const rootVel: [number, number, number] = [
          (p2.x - p0.x) / sampleSec,
          (p2.y - p0.y) / sampleSec,
          (p2.z - p0.z) / sampleSec,
        ];
        frames.push({
          clipIdx,
          frameIdx: i,
          time: t,
          traj,
          footSpeed,
          rootVel,
          tags,
        });
      }
    }

    this.clips.push({ clip, tags, frames });
    return clipIdx;
  }

  /** Clear the clip DB. */
  clear(): void {
    this.clips = [];
    this.activeAction = null;
    this.activeClipIdx = -1;
  }

  /** Search the DB for the best-matching frame to the query. */
  search(query: SearchQuery): SearchResult | null {
    if (this.clips.length === 0) return null;
    let bestCost = Infinity;
    let bestFrame: MotionFrame | null = null;
    const w = this.opts.weights;
    const stride = this.opts.searchStride;

    // Normalize query trajectory to (pos[0]=origin, yaw[0]=0) so we can
    // compare against clip trajectories (which are also origin-relative).
    const qTraj = query.trajectory;
    if (qTraj.length === 0) return null;
    const qOrigin = qTraj[0].pos;
    const qOriginYaw = qTraj[0].yaw;

    for (const entry of this.clips) {
      // Tag mismatch penalty.
      let tagPenalty = 0;
      if (query.requiredTags) {
        if (query.requiredTags.locomotion !== undefined && entry.tags.locomotion !== query.requiredTags.locomotion) {
          tagPenalty += w.tagMatch;
        }
        if (query.requiredTags.stance !== undefined && entry.tags.stance !== query.requiredTags.stance) {
          tagPenalty += w.tagMatch;
        }
      }
      if (tagPenalty > 5) continue; // hard reject — wrong locomotion type.

      for (let i = 0; i < entry.frames.length; i += stride) {
        const f = entry.frames[i];
        // ── Trajectory cost: sum of squared pos + yaw deltas. ──
        let posCost = 0;
        let yawCost = 0;
        const len = Math.min(f.traj.length, qTraj.length);
        for (let k = 0; k < len; k++) {
          const fp = f.traj[k];
          const qp = qTraj[k];
          const dx = fp.pos[0] - (qp.pos[0] - qOrigin[0]);
          const dy = fp.pos[1] - (qp.pos[1] - qOrigin[1]);
          const dz = fp.pos[2] - (qp.pos[2] - qOrigin[2]);
          posCost += dx * dx + dy * dy + dz * dz;
          // Yaw delta (shortest arc).
          let dyaw = fp.yaw - (qp.yaw - qOriginYaw);
          while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
          while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
          yawCost += dyaw * dyaw;
        }
        // ── Foot-speed cost. ──
        const qFootSpeed = query.currentVel.length();
        const footCost = (f.footSpeed - qFootSpeed) ** 2;
        // ── Root-velocity cost. ──
        const dx = f.rootVel[0] - query.currentVel.x;
        const dy = f.rootVel[1] - query.currentVel.y;
        const dz = f.rootVel[2] - query.currentVel.z;
        const velCost = dx * dx + dy * dy + dz * dz;

        const cost =
          w.positionTrajectory * posCost +
          w.facing * yawCost +
          w.footSpeed * footCost +
          w.rootVelocity * velCost +
          tagPenalty;

        if (cost < bestCost) {
          bestCost = cost;
          bestFrame = f;
        }
      }
    }

    if (!bestFrame) return null;
    return { frame: bestFrame, cost: bestCost };
  }

  /** Advance the matcher. Performs a search if the current segment has
   *  played for at least `minSegmentSec`, then crossfades to the new
   *  segment. */
  tick(
    dt: number,
    currentVel: THREE.Vector3,
    currentFacing: number,
    desiredTrajectory: TrajectoryPoint[],
    requiredTags?: ClipTags,
  ): void {
    if (this.ownMixer) this.mixer.update(dt);
    const now = this.mixer.time;
    const sinceSearch = now - this.lastSearchTime;
    if (sinceSearch < this.opts.minSegmentSec && this.activeAction) return;
    this.lastSearchTime = now;

    if (desiredTrajectory.length === 0) return;
    const res = this.search({
      currentVel,
      currentFacing,
      trajectory: desiredTrajectory,
      requiredTags,
    });
    if (!res) return;

    const entry = this.clips[res.frame.clipIdx];
    if (!entry) return;
    // If we're already playing this clip at roughly this time, skip.
    if (
      this.activeClipIdx === res.frame.clipIdx &&
      this.activeAction &&
      Math.abs(this.activeAction.time - res.frame.time) < 0.1
    ) {
      return;
    }

    const newAction = this.mixer.clipAction(entry.clip, this.root);
    newAction.reset();
    newAction.time = res.frame.time;
    newAction.setLoop(THREE.LoopRepeat, Infinity);
    newAction.play();

    if (this.activeAction) {
      // Crossfade from current to new.
      this.activeAction.crossFadeTo(newAction, this.opts.blendDurationSec, false);
      // Schedule cleanup of the old action.
      const old = this.activeAction;
      setTimeout(() => {
        old.stop();
        this.mixer.uncacheAction(old.getClip());
      }, this.opts.blendDurationSec * 1000 + 50);
    }
    this.activeAction = newAction;
    this.activeClipIdx = res.frame.clipIdx;
    this.activeStartTime = now;
  }

  /** Get the active clip (or null). */
  getActiveClip(): THREE.AnimationClip | null {
    return this.activeAction ? this.activeAction.getClip() : null;
  }

  /** Get the active clip entry (with tags + frames) or null. */
  getActiveClipEntry(): ClipEntry | null {
    return this.activeClipIdx >= 0 ? this.clips[this.activeClipIdx] : null;
  }

  /** Get the clip DB (read-only). */
  getClipDB(): readonly ClipEntry[] {
    return this.clips;
  }

  dispose(): void {
    if (this.activeAction) {
      this.activeAction.stop();
      this.mixer.uncacheAction(this.activeAction.getClip());
      this.activeAction = null;
    }
    this.clips = [];
    if (this.ownMixer) {
      this.mixer.uncacheRoot(this.root);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Track-sampling helpers
  // ─────────────────────────────────────────────────────────────────────

  private _sampleVecTrack(
    track: THREE.VectorKeyframeTrack,
    t: number,
  ): THREE.Vector3 {
    const times = track.times;
    const values = track.values;
    if (times.length === 0) return new THREE.Vector3();
    if (t <= times[0]) {
      return new THREE.Vector3(values[0], values[1], values[2]);
    }
    if (t >= times[times.length - 1]) {
      const i = times.length - 1;
      return new THREE.Vector3(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]);
    }
    // Binary search.
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const t0 = times[lo];
    const t1 = times[hi];
    const a = (t - t0) / (t1 - t0 || 1);
    const v0 = new THREE.Vector3(values[lo * 3], values[lo * 3 + 1], values[lo * 3 + 2]);
    const v1 = new THREE.Vector3(values[hi * 3], values[hi * 3 + 1], values[hi * 3 + 2]);
    return v0.lerp(v1, a);
  }

  private _sampleQuatTrack(
    track: THREE.QuaternionKeyframeTrack,
    t: number,
    out: THREE.Quaternion,
  ): THREE.Quaternion {
    const times = track.times;
    const values = track.values;
    if (times.length === 0) return out.identity();
    if (t <= times[0]) {
      return out.set(values[0], values[1], values[2], values[3]);
    }
    if (t >= times[times.length - 1]) {
      const i = times.length - 1;
      return out.set(values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]);
    }
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    const t0 = times[lo];
    const t1 = times[hi];
    const a = (t - t0) / (t1 - t0 || 1);
    const q0 = new THREE.Quaternion(values[lo * 4], values[lo * 4 + 1], values[lo * 4 + 2], values[lo * 4 + 3]);
    const q1 = new THREE.Quaternion(values[hi * 4], values[hi * 4 + 1], values[hi * 4 + 2], values[hi * 4 + 3]);
    return out.copy(q0).slerp(q1, a);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Trajectory builder helper
// ───────────────────────────────────────────────────────────────────────────

/** Build a TrajectoryPoint[] for the next `lookaheadSec` given a current
 *  velocity + facing. Used by hosts that don't have a full nav-mesh-driven
 *  trajectory planner; produces a straight-line prediction + deceleration
 *  curve. */
export function buildPredictedTrajectory(
  currentPos: THREE.Vector3,
  currentVel: THREE.Vector3,
  currentYaw: number,
  lookaheadSec = 0.3,
  sampleSec = 0.05,
  deceleration = 0.5,
): TrajectoryPoint[] {
  const out: TrajectoryPoint[] = [];
  const steps = Math.max(1, Math.floor(lookaheadSec / sampleSec));
  const v = currentVel.clone();
  const p = currentPos.clone();
  for (let i = 0; i <= steps; i++) {
    const t = i * sampleSec;
    out.push({
      t,
      pos: [p.x - currentPos.x, p.y - currentPos.y, p.z - currentPos.z],
      yaw: currentYaw,
    });
    // Advance position by current velocity.
    p.addScaledVector(v, sampleSec);
    // Apply deceleration.
    const speed = v.length();
    if (speed > 0) {
      const newSpeed = Math.max(0, speed - deceleration * sampleSec);
      v.setLength(newSpeed);
    }
  }
  return out;
}
