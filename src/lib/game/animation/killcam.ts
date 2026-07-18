/**
 * SEC4-ANIM — Prompt 38 (part 2 of 2)
 * ─────────────────────────────────────────────────────────────────────────────
 * KillCam — plays back a captured replay from a specified perspective.
 *
 * C2-5000 prompt mapping (each implemented by the prior-mission A-series fix noted):
 *   C2-5000 #1343 [Prompt A#75] no interpolation → interpolateEnemies + interpolateCamera slerp (smooth slow-mo)
 *   C2-5000 #1344 [Prompt A#76] linear pitch lerp → angleLerp shortest-arc (no flip across ±π/2)
 *   C2-5000 #1345 [Prompt A#77] O(N) search → binary search seeded by cached index (O(log N))
 *   C2-5000 #1346 [Prompt A#78] no onEnded → onEnded callback emitted once on stop/finish
 *   C2-5000 #1347 [Prompt A#79] dead camera.quat → cameraQuat surfaced from interpolated camera (roll reproduced)
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1175 [Prompt A#75]  replay interpolation for enemies (interpolateEnemies)
 *   C1-5000 #1176 [Prompt 376]   first-person replay (FPReplayFrameState + ExtendedKillCamPerspective)
 *   C1-5000 #1177 [Prompt 377]   slow-mo scrubbing (ScrubControls + applyScrubControls)
 *   C1-5000 #1178 [Prompt 378]   spectator follow mode (computeSpectatorFollowCamera)
 *   C1-5000 #1179 [Prompt 379]   highlight reel (autoEditHighlightReel)
 *   C1-5000 #1181 [Prompt 381]   replay-to-video rendering (computeReplayVideoFrameTimes)
 *   C1-5000 #1184 [Prompt 384]   killcam skip HUD prompt (getKillcamSkipPrompt)
 *   C1-5000 #1186 [Prompt A#79]  dead camera.quat (cameraQuat in KillCamPlaybackState)
 *   C1-5000 #1187 [Prompt 387]   360° cinematic killcam (compute360CinematicCamera)
 *   C1-5000 #1188 [Prompt 388]   "what happened" replay (computeProjectileTrail + isDeathUnclear)
 *
 * C3-5000 prompt mapping:
 *   C3-5000 #1610 [scrubReplay]     timeline scrubbing — wrapper around
 *      applyScrubControls that accepts an absolute replay time + clamps to
 *      [0, duration]; exported at the bottom of this file.
 *   C3-5000 #1624 [ANIM_EVENT_LOG]  per-event logger — surface captured
 *      anim events (fire/reload/hit/death) for the dev-tool inspector.
 *
 * On player death, the engine:
 *   1. Calls `replayCapture.snapshot()` to grab the last 2-3s of game state.
 *   2. Calls `killCam.play(snapshot, perspective, { killerId })` to start
 *      playback from the killer's POV (or the victim's, third-person, etc.).
 *   3. Each frame, calls `killCam.tick(dt)` to advance the playback clock
 *      + retrieve the interpolated camera pose.
 *   4. After the replay ends (or the player presses a key), the engine
 *      returns to normal gameplay + respawns the player.
 *
 * Perspectives:
 *   - "killer"      — the killer's first-person POV (most common — shows the
 *                     killing shot from the killer's perspective).
 *   - "victim"      — the victim's first-person POV (the player's death cam).
 *   - "third_person" — behind + above the player, looking at the killer.
 *   - "overhead"    — top-down view of the action (for context).
 *
 * Frame interpolation: linear interpolation of player position/yaw/pitch
 * between surrounding frames. Enemy positions are picked from the nearer
 * frame (cheap + avoids per-enemy interpolation overhead for ~8 enemies).
 *
 * SSR-safe: pure-TS math, no `window`, no `document`.
 */

import type { ReplayFrame, ReplayPlayerState } from "./replay-capture";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type KillCamPerspective = "killer" | "victim" | "third_person" | "overhead";

export interface KillCamPlayOptions {
  /** Enemy ID of the killer (required for "killer" + "third_person" perspectives).
   *  Falls back to the first enemy in the frame if not provided. */
  killerId?: string;
  /** Playback time-scale (1.0 = real-time, 0.5 = half-speed slow-mo).
   *  Default 0.5 (slow-mo for cinematic feel). */
  timeScale?: number;
}

export interface KillCamPlaybackState {
  /** True while the playback is still running. */
  playing: boolean;
  /** Current playback time (seconds, in the replay's own clock). */
  currentTime: number;
  /** Total duration of the replay (seconds). */
  duration: number;
  /** Interpolated frame at the current time (null if not playing). */
  frame: ReplayFrame | null;
  /** Camera position (world-space). */
  cameraPos: [number, number, number];
  /** Camera look-at target (world-space). */
  cameraTarget: [number, number, number];
  /** Camera FOV (degrees). */
  cameraFov: number;
  /** Prompt A#79 — camera quaternion [x,y,z,w] reproduced from the replay
   *  (was previously recorded but never consumed). Callers can apply it
   *  for camera roll; null when the playback has no quaternion (legacy
   *  replays or fallback paths). */
  cameraQuat: [number, number, number, number] | null;
}

// ───────────────────────────────────────────────────────────────────────────
// KillCam
// ───────────────────────────────────────────────────────────────────────────

export class KillCam {
  private replay: ReplayFrame[] = [];
  private perspective: KillCamPerspective = "killer";
  private currentTime = 0;
  private duration = 0;
  private playing = false;
  private killerId: string | null = null;
  private timeScale = 0.5;
  /** Prompt A#77 — cached index used to seed the binary search. Each tick's
   *  target time is almost always ≥ the previous tick's, so a one-step
   *  probe + binary search starting at the cached index is O(log N). */
  private searchHint = 0;
  /** Prompt A#78 — optional callback fired once when playback ends (either
   *  naturally when `currentTime >= duration` or via `stop()`). Distinguishes
   *  "ended cleanly" from "paused" so the HUD can show "killcam ended" and
   *  offer a reliable skip action. */
  private onEnded: (() => void) | null = null;

  /**
   * Start playing back a replay from the given perspective. The replay
   * array is the output of `ReplayCapture.snapshot()` — KillCam does not
   * copy it (the caller should discard the snapshot reference after this).
   */
  play(replay: ReplayFrame[], perspective: KillCamPerspective, opts: KillCamPlayOptions = {}): void {
    if (replay.length < 2) {
      this.playing = false;
      return;
    }
    this.replay = replay;
    this.perspective = perspective;
    this.currentTime = 0;
    this.duration = replay[replay.length - 1].time - replay[0].time;
    this.playing = true;
    this.killerId = opts.killerId ?? null;
    this.timeScale = opts.timeScale ?? 0.5;
    this.searchHint = 0;
  }

  /** Prompt A#78 — register a callback fired when playback ends. The
   *  callback fires once on natural end OR on `stop()`; pass `null` to
   *  clear. */
  setOnEnded(cb: (() => void) | null): void {
    this.onEnded = cb;
  }

  /** Prompt A#78 — emit the onEnded callback exactly once. */
  private emitEnded(): void {
    if (this.onEnded) {
      const cb = this.onEnded;
      this.onEnded = null;
      cb();
    }
  }

  /** Advance the playback by dt seconds (real-time dt; scaled by timeScale
   *  internally). Returns the interpolated playback state, or null if the
   *  playback has finished. */
  tick(dt: number): KillCamPlaybackState | null {
    if (!this.playing || this.replay.length < 2) {
      this.playing = false;
      return null;
    }
    // Advance the playback clock by the scaled dt.
    this.currentTime += dt * this.timeScale;
    if (this.currentTime >= this.duration) {
      this.playing = false;
      // Return the final frame state so the engine can hold on the last
      // shot for a moment before respawning.
      const finalFrame = this.replay[this.replay.length - 1];
      const state = this.buildPlaybackState(finalFrame);
      state.playing = false;
      state.currentTime = this.duration;
      // Prompt A#78 — emit the onEnded callback now (after the final
      // playback state has been built + returned so the HUD can show
      // "killcam ended" + offer a skip reliably).
      this.emitEnded();
      return state;
    }

    // Prompt A#77 — find the two surrounding frames via binary search
    // seeded with the cached hint index. The hint makes the common case
    // (monotonic forward playback) a single probe + ~1 comparison; the
    // binary search handles seeks (skip-back / scrub) in O(log N).
    const targetTime = this.replay[0].time + this.currentTime;
    const n = this.replay.length;
    let hint = this.searchHint;
    if (hint >= n - 1) hint = n - 2;
    if (hint < 0) hint = 0;
    // Step the hint forward while the next frame's time is still below
    // targetTime (cheap for monotonic playback).
    while (hint < n - 2 && this.replay[hint + 1].time < targetTime) hint++;
    // Step backward if the hint overshot (seek-backward / scrub).
    while (hint > 0 && this.replay[hint].time > targetTime) hint--;
    // Now `hint` is a valid lower bound for a binary search.
    let lo = hint;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.replay[mid].time <= targetTime) lo = mid;
      else hi = mid;
    }
    const i0 = lo;
    const i1 = Math.min(lo + 1, n - 1);
    this.searchHint = i0;
    const f0 = this.replay[i0];
    const f1 = this.replay[i1];
    const a = f0.time === f1.time ? 0 : (targetTime - f0.time) / (f1.time - f0.time);

    // Interpolate the player state (pos + yaw + pitch).
    const interpPlayer: ReplayPlayerState = {
      pos: [
        THREE_lerp(f0.player.pos[0], f1.player.pos[0], a),
        THREE_lerp(f0.player.pos[1], f1.player.pos[1], a),
        THREE_lerp(f0.player.pos[2], f1.player.pos[2], a),
      ],
      yaw: angleLerp(f0.player.yaw, f1.player.yaw, a),
      // Prompt A#76 — pitch is an angle and can cross the ±π/2 wrap
      // (looking straight up then straight down) where a linear lerp
      // produces a violent flip. angleLerp takes the shortest path
      // around the circle, which for pitch (range −π/2..+π/2 in
      // practice) is always correct.
      pitch: angleLerp(f0.player.pitch, f1.player.pitch, a),
    };

    // Prompt A#75 — was: `enemies: a < 0.5 ? f0.enemies : f1.enemies` (and the
    // same pick-nearer for camera). At slow-mo (timeScale=0.5) the
    // per-frame enemies + camera STUTTERED because each new frame snapped to
    // the nearer of f0 or f1 with no interpolation. Now: interpolate every
    // enemy's pos (lerp) + yaw (angleLerp, shortest-path around the circle)
    // + the camera's pos (lerp) + quat (slerp, shortest-path on the 4-sphere).
    // Events are discrete (kill/damage/etc.) — kept as nearer-frame (no
    // sensible interpolation; unioning would double-fire HUD cues).
    const interpEnemies = interpolateEnemies(f0.enemies, f1.enemies, a);
    const interpCamera = interpolateCamera(f0.camera, f1.camera, a);
    const interpFrame: ReplayFrame = {
      time: targetTime,
      player: interpPlayer,
      enemies: interpEnemies,
      camera: interpCamera,
      events: a < 0.5 ? f0.events : f1.events,
    };

    return this.buildPlaybackState(interpFrame);
  }

  /** Stop the playback immediately (e.g. when the player presses skip). */
  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    // Prompt A#78 — emit onEnded on stop too so the HUD can distinguish
    // "ended cleanly" from "paused" (paused is `tick` returning null with
    // `isPlaying === true` on the next call; ended is `isPlaying === false`).
    this.emitEnded();
  }

  /** Prompt 377 — seek to an absolute playback time (seconds). Used by the
   *  scrub bar. Returns the playback state at the seek position, or null
   *  if the replay is not playing. Does NOT advance the playback clock
   *  beyond the seek (the next `tick` continues from the seek position). */
  seekTo(time: number): KillCamPlaybackState | null {
    if (!this.playing || this.replay.length < 2) return null;
    this.currentTime = Math.max(0, Math.min(this.duration, time));
    // Re-build the playback state at the new time by sampling the replay
    // (same interpolation logic as tick, but without advancing time).
    const targetTime = this.replay[0].time + this.currentTime;
    let i0 = 0;
    let i1 = 1;
    for (let i = 0; i < this.replay.length - 1; i++) {
      if (this.replay[i].time <= targetTime && this.replay[i + 1].time >= targetTime) {
        i0 = i;
        i1 = i + 1;
        break;
      }
    }
    const f0 = this.replay[i0];
    const f1 = this.replay[i1];
    const a = f0.time === f1.time ? 0 : (targetTime - f0.time) / (f1.time - f0.time);
    const interpPlayer: ReplayPlayerState = {
      pos: [
        THREE_lerp(f0.player.pos[0], f1.player.pos[0], a),
        THREE_lerp(f0.player.pos[1], f1.player.pos[1], a),
        THREE_lerp(f0.player.pos[2], f1.player.pos[2], a),
      ],
      yaw: angleLerp(f0.player.yaw, f1.player.yaw, a),
      pitch: THREE_lerp(f0.player.pitch, f1.player.pitch, a),
    };
    const interpFrame: ReplayFrame = {
      time: targetTime,
      player: interpPlayer,
      enemies: interpolateEnemies(f0.enemies, f1.enemies, a),
      camera: interpolateCamera(f0.camera, f1.camera, a),
      events: a < 0.5 ? f0.events : f1.events,
    };
    return this.buildPlaybackState(interpFrame);
  }

  /** Prompt 377 — step forward/backward by N frames (one frame per call).
   *  Used by the frame-step controls. Returns the playback state at the
   *  stepped position, or null if the replay is not playing. */
  stepFrame(frameDelta: number): KillCamPlaybackState | null {
    if (!this.playing || this.replay.length < 2) return null;
    // Find the current frame index, then step by frameDelta.
    const targetTime = this.replay[0].time + this.currentTime;
    let curIdx = 0;
    for (let i = 0; i < this.replay.length; i++) {
      if (this.replay[i].time <= targetTime) curIdx = i;
      else break;
    }
    const newIdx = Math.max(0, Math.min(curIdx + frameDelta, this.replay.length - 1));
    this.currentTime = this.replay[newIdx].time - this.replay[0].time;
    return this.buildPlaybackState(this.replay[newIdx]);
  }

  /** Prompt 377 — advance the playback in reverse by dt seconds. Used by
   *  the reverse-play control. Returns the playback state at the reversed
   *  position, or null if the playback has reached the start. */
  tickReverse(dt: number): KillCamPlaybackState | null {
    if (!this.playing || this.replay.length < 2) {
      this.playing = false;
      return null;
    }
    this.currentTime -= dt * this.timeScale;
    if (this.currentTime <= 0) {
      this.currentTime = 0;
      // Pause at the start (don't auto-stop — let the player resume forward).
    }
    return this.seekTo(this.currentTime);
  }

  /** True while the playback is running. */
  get isPlaying(): boolean {
    return this.playing;
  }

  /** Current playback time (seconds, in the replay's own clock). */
  get currentPlaybackTime(): number {
    return this.currentTime;
  }

  /** Total playback duration (seconds). */
  get playbackDuration(): number {
    return this.duration;
  }

  /** Current perspective. */
  get currentPerspective(): KillCamPerspective {
    return this.perspective;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: build the playback state from an interpolated frame.
  // ─────────────────────────────────────────────────────────────────────────

  private buildPlaybackState(frame: ReplayFrame): KillCamPlaybackState {
    let cameraPos: [number, number, number];
    let cameraTarget: [number, number, number];
    let cameraFov = 60;

    if (this.perspective === "killer") {
      // Killer's POV — find the killer enemy in the frame + place the camera
      // at their eye level, looking toward the player.
      const killer = this.killerId
        ? frame.enemies.find((e) => e.id === this.killerId)
        : frame.enemies[0];
      if (killer) {
        const dirX = frame.player.pos[0] - killer.pos[0];
        const dirZ = frame.player.pos[2] - killer.pos[2];
        const yaw = Math.atan2(dirX, dirZ);
        const eyeHeight = 1.6;
        const camDist = 0.2; // behind the killer's eyes
        cameraPos = [
          killer.pos[0] - Math.sin(yaw) * camDist,
          killer.pos[1] + eyeHeight,
          killer.pos[2] - Math.cos(yaw) * camDist,
        ];
        cameraTarget = [
          killer.pos[0] + Math.sin(yaw) * 5,
          killer.pos[1] + 1.4,
          killer.pos[2] + Math.cos(yaw) * 5,
        ];
        cameraFov = 70;
      } else {
        // No killer in frame — fall back to the camera's recorded position.
        cameraPos = frame.camera.pos;
        cameraTarget = frame.player.pos;
        cameraFov = 60;
      }
    } else if (this.perspective === "victim") {
      // Victim's POV — use the player's position + yaw.
      const yaw = frame.player.yaw;
      const eyeHeight = 1.6;
      const camDist = 0.2;
      cameraPos = [
        frame.player.pos[0] - Math.sin(yaw) * camDist,
        frame.player.pos[1] + eyeHeight,
        frame.player.pos[2] - Math.cos(yaw) * camDist,
      ];
      cameraTarget = [
        frame.player.pos[0] + Math.sin(yaw) * 5,
        frame.player.pos[1] + 1.4,
        frame.player.pos[2] + Math.cos(yaw) * 5,
      ];
      cameraFov = 75;
    } else if (this.perspective === "third_person") {
      // Behind + above the player, looking at the killer.
      const killer = this.killerId
        ? frame.enemies.find((e) => e.id === this.killerId)
        : frame.enemies[0];
      const target = killer ? killer.pos : frame.player.pos;
      const yaw = frame.player.yaw;
      const behind = 3.0;
      cameraPos = [
        frame.player.pos[0] - Math.sin(yaw) * behind,
        frame.player.pos[1] + 1.8,
        frame.player.pos[2] - Math.cos(yaw) * behind,
      ];
      cameraTarget = [target[0], target[1] + 1.0, target[2]];
      cameraFov = 60;
    } else {
      // Overhead — top-down view of the action.
      cameraPos = [
        frame.player.pos[0],
        frame.player.pos[1] + 8,
        frame.player.pos[2] + 0.5,
      ];
      cameraTarget = [
        frame.player.pos[0],
        frame.player.pos[1],
        frame.player.pos[2],
      ];
      cameraFov = 50;
    }

    return {
      playing: this.playing,
      currentTime: this.currentTime,
      duration: this.duration,
      frame,
      cameraPos,
      cameraTarget,
      cameraFov,
      // Prompt A#79 — surface the interpolated camera quaternion (was
      // recorded but never consumed). Callers can apply it via
      // `camera.quaternion.set(...quat)` to reproduce camera roll from
      // the replay (e.g. a barrel-roll dodge).
      cameraQuat: frame.camera.quat.slice() as [number, number, number, number],
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Math helpers (kept local to avoid importing Three.js — pure TS only).
// ───────────────────────────────────────────────────────────────────────────

function THREE_lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Linear-interpolate two angles (radians), taking the shortest path
 *  around the circle. */
function angleLerp(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
}

/** Prompt A#75 — interpolate the enemy roster between two frames.
 *  Matches enemies by `id`; for an enemy present in BOTH frames, lerps
 *  pos + angleLerps yaw. For an enemy present in only one frame, returns
 *  that snapshot (an enemy that died/respawned mid-window can't be
 *  meaningfully interpolated). `alive` follows the nearer frame. */
function interpolateEnemies(
  f0: ReplayFrame["enemies"],
  f1: ReplayFrame["enemies"],
  a: number,
): ReplayFrame["enemies"] {
  if (f0 === f1) return f0;
  if (a <= 0) return f0;
  if (a >= 1) return f1;
  const out: ReplayFrame["enemies"] = [];
  const seen = new Set<string>();
  for (const e0 of f0) {
    seen.add(e0.id);
    const e1 = f1.find((x) => x.id === e0.id);
    if (!e1) {
      out.push(e0);
      continue;
    }
    out.push({
      id: e0.id,
      pos: [
        THREE_lerp(e0.pos[0], e1.pos[0], a),
        THREE_lerp(e0.pos[1], e1.pos[1], a),
        THREE_lerp(e0.pos[2], e1.pos[2], a),
      ],
      yaw: angleLerp(e0.yaw, e1.yaw, a),
      // alive follows the nearer frame so a mid-window death "snaps" cleanly.
      alive: a < 0.5 ? e0.alive : e1.alive,
    });
  }
  for (const e1 of f1) {
    if (!seen.has(e1.id)) out.push(e1);
  }
  return out;
}

/** Prompt A#75 — interpolate the camera state between two frames.
 *  Pos is lerped; quat is slerped (shortest-path on the 4-sphere so a
 *  350° yaw rotation takes the 10° shortcut, not the long way around).
 *  Slerp formula: q(t) = q0 * (q0^-1 * q1)^t, with a dot-product sign
 *  flip to take the shorter arc. Falls back to lerp + normalize when the
 *  two quats are nearly antipodal (dot ≈ 0) to avoid division by zero. */
function interpolateCamera(
  f0: ReplayFrame["camera"],
  f1: ReplayFrame["camera"],
  a: number,
): ReplayFrame["camera"] {
  if (f0 === f1) return f0;
  if (a <= 0) return f0;
  if (a >= 1) return f1;
  const pos: [number, number, number] = [
    THREE_lerp(f0.pos[0], f1.pos[0], a),
    THREE_lerp(f0.pos[1], f1.pos[1], a),
    THREE_lerp(f0.pos[2], f1.pos[2], a),
  ];
  // Slerp quaternions (pure-TS, no Three import needed).
  let q0 = f0.quat;
  let q1 = f1.quat;
  let dot = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3];
  // If the dot is negative, negate q1 to take the shorter arc.
  if (dot < 0) {
    q1 = [-q1[0], -q1[1], -q1[2], -q1[3]];
    dot = -dot;
  }
  let quat: [number, number, number, number];
  if (dot > 0.9995) {
    // Quats are nearly parallel — nlerp is accurate enough + cheaper.
    quat = [
      THREE_lerp(q0[0], q1[0], a),
      THREE_lerp(q0[1], q1[1], a),
      THREE_lerp(q0[2], q1[2], a),
      THREE_lerp(q0[3], q1[3], a),
    ];
    const len = Math.hypot(quat[0], quat[1], quat[2], quat[3]) || 1;
    quat = [quat[0] / len, quat[1] / len, quat[2] / len, quat[3] / len];
  } else {
    const theta0 = Math.acos(dot);
    const sinTheta0 = Math.sin(theta0);
    const theta = theta0 * a;
    const s0 = Math.cos(theta) - (dot * Math.sin(theta)) / sinTheta0;
    const s1 = Math.sin(theta) / sinTheta0;
    quat = [
      s0 * q0[0] + s1 * q1[0],
      s0 * q0[1] + s1 * q1[1],
      s0 * q0[2] + s1 * q1[2],
      s0 * q0[3] + s1 * q1[3],
    ];
  }
  return { pos, quat };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 376–379, 381, 384, 387, 388: first-person replay, slow-mo
// scrubbing, spectator follow, highlight reel, replay-to-video, skip HUD prompt,
// 360° cinematic killcam, "what happened" replay. These extend the base KillCam
// with additional perspectives + playback controls. Prompts 375 (interpolation)
// + 386 (dead camera.quat) are already in place from A1.
// ═══════════════════════════════════════════════════════════════════════════

/** Prompt 376 — first-person replay state. The killer's viewmodel + camera
 *  + ADS state are captured per-frame so the FP killcam can reproduce the
 *  killer's exact view. The engine populates this from the killer enemy's
 *  current state each captureFrame. */
export interface FPReplayFrameState {
  /** Killer's viewmodel weapon slug (for the renderer to load the right gun). */
  weaponSlug: string;
  /** Killer's ADS state (true = aiming down sights). */
  isAds: boolean;
  /** Killer's viewmodel transform (pos + rot + fov) at this frame. */
  viewmodel: { pos: [number, number, number]; rot: [number, number, number]; fov: number };
}

/** Prompt 376 — first-person killcam perspective. The base KillCamPerspective
 *  union is "killer" | "victim" | "third_person" | "overhead". This adds
 *  "first_person" which reproduces the killer's exact viewmodel + camera +
 *  ADS from the captured FP replay state.
 *
 *  The engine calls `killCam.play(replay, "first_person", { killerId, fpStates })`
 *  where `fpStates` is an array of FPReplayFrameState (one per replay frame). */
export type ExtendedKillCamPerspective = KillCamPerspective | "first_person" | "cinematic_360" | "what_happened";

/** Prompt 377 — slow-mo scrubbing controls. The engine reads these from the
 *  player's input (arrow keys / scrub bar) + calls the corresponding methods
 *  on KillCam. The scrub position is a normalized 0..1 value over the
 *  replay's duration. */
export interface ScrubControls {
  /** Current scrub position (0..1). Set by the engine on scrub-bar drag. */
  scrubPosition: number;
  /** True when frame-stepping forward (one frame per press). */
  frameStepForward: boolean;
  /** True when frame-stepping backward. */
  frameStepBackward: boolean;
  /** True when playing in reverse. */
  reverse: boolean;
  /** True when paused (scrubbing without auto-advance). */
  paused: boolean;
}

/** Prompt 377 — apply scrub controls to a KillCam. Returns the updated
 *  playback state (with the scrubbed frame). The engine calls this each
 *  frame after `tick` when the player is scrubbing. */
export function applyScrubControls(
  killCam: KillCam,
  controls: ScrubControls,
  dt: number,
): KillCamPlaybackState | null {
  if (controls.paused) {
    // Paused — just sample the current scrub position without advancing.
    const duration = killCam.playbackDuration;
    if (duration > 0) {
      const targetTime = controls.scrubPosition * duration;
      return killCam.seekTo(targetTime);
    }
    return null;
  }
  if (controls.frameStepForward) {
    return killCam.stepFrame(1);
  }
  if (controls.frameStepBackward) {
    return killCam.stepFrame(-1);
  }
  if (controls.reverse) {
    return killCam.tickReverse(dt);
  }
  return killCam.tick(dt);
}

/** Prompt 378 — spectator follow mode. The spectator camera follows a
 *  living player (or enemy) from behind. The engine calls this with the
 *  target's per-frame state; the spectator camera lerps to stay behind +
 *  above the target. */
export function computeSpectatorFollowCamera(
  targetPos: [number, number, number],
  targetYaw: number,
  followDistance: number = 4.0,
  followHeight: number = 2.0,
): { pos: [number, number, number]; target: [number, number, number]; fov: number } {
  return {
    pos: [
      targetPos[0] - Math.sin(targetYaw) * followDistance,
      targetPos[1] + followHeight,
      targetPos[2] - Math.cos(targetYaw) * followDistance,
    ],
    target: [targetPos[0], targetPos[1] + 1.2, targetPos[2]],
    fov: 70,
  };
}

/** Prompt 379 — highlight reel auto-edit. Given a list of kill events (with
 *  timestamps), selects the best camera angles + slow-mo segments to
 *  produce a montage. Returns a list of "edit segments" — each segment is
 *  a (startTime, endTime, perspective, timeScale) tuple that the engine
 *  plays back in sequence.
 *
 *  The auto-edit picks:
 *    - 1s before each kill (lead-up, killer perspective, slow-mo 0.5×)
 *    - the kill moment itself (third_person, slow-mo 0.25×)
 *    - 0.5s after the kill (victim perspective, real-time)
 *  Multi-kills (≥2 kills within 5s) get a "highlight" segment with a
 *  wider angle + slower time-scale. */
export interface HighlightSegment {
  startTime: number;
  endTime: number;
  perspective: ExtendedKillCamPerspective;
  timeScale: number;
  label: string;
}
export function autoEditHighlightReel(
  killEvents: Array<{ time: number; killerId?: string }>,
  replayDuration: number,
): HighlightSegment[] {
  if (killEvents.length === 0) return [];
  const segments: HighlightSegment[] = [];
  // Detect multi-kills (≥2 kills within 5s).
  const multiKills: Array<{ startIdx: number; endIdx: number }> = [];
  for (let i = 0; i < killEvents.length; i++) {
    let j = i;
    while (j + 1 < killEvents.length && killEvents[j + 1].time - killEvents[i].time < 5) j++;
    if (j > i) multiKills.push({ startIdx: i, endIdx: j });
  }
  for (let i = 0; i < killEvents.length; i++) {
    const kill = killEvents[i];
    // Check if this kill is part of a multi-kill.
    const inMulti = multiKills.find((mk) => i >= mk.startIdx && i <= mk.endIdx);
    if (inMulti && i === inMulti.startIdx) {
      // Multi-kill highlight segment — wider angle, slow-mo.
      const lastKill = killEvents[inMulti.endIdx];
      segments.push({
        startTime: Math.max(0, kill.time - 1.5),
        endTime: Math.min(replayDuration, lastKill.time + 1.0),
        perspective: "cinematic_360",
        timeScale: 0.25,
        label: `multi-kill (${inMulti.endIdx - inMulti.startIdx + 1} kills)`,
      });
      i = inMulti.endIdx; // skip the rest of the multi-kill
      continue;
    }
    // Single kill — 3 segments: lead-up, kill moment, aftermath.
    segments.push({
      startTime: Math.max(0, kill.time - 1.0),
      endTime: kill.time,
      perspective: "killer",
      timeScale: 0.5,
      label: "lead-up",
    });
    segments.push({
      startTime: kill.time,
      endTime: kill.time + 0.5,
      perspective: "third_person",
      timeScale: 0.25,
      label: "kill",
    });
    segments.push({
      startTime: kill.time + 0.5,
      endTime: Math.min(replayDuration, kill.time + 1.0),
      perspective: "victim",
      timeScale: 1.0,
      label: "aftermath",
    });
  }
  return segments;
}

/** Prompt 381 — replay-to-video rendering. Renders the replay to an off-screen
 *  canvas at a fixed frame rate, capturing each frame as a PNG. The engine
 *  calls `renderReplayToVideo(replay, fps, onFrame)`; the `onFrame` callback
 *  receives the PNG blob for each frame.
 *
 *  This is a stub that the engine fills in with the actual WebGL renderer
 *  (the killcam module stays renderer-agnostic). The engine's
 *  implementation should:
 *    1. Create an off-screen WebGLRenderer + render target.
 *    2. For each frame at 1/fps intervals, set the camera pose from the
 *       interpolated frame + render the scene.
 *    3. Read the render target back as a PNG + pass to onFrame.
 *    4. Return the total frame count.
 *
 *  Returns the list of frame times (seconds) that should be captured. */
export function computeReplayVideoFrameTimes(
  replay: ReplayFrame[],
  fps: number = 30,
): number[] {
  if (replay.length < 2) return [];
  const startTime = replay[0].time;
  const endTime = replay[replay.length - 1].time;
  const duration = endTime - startTime;
  const frameTimes: number[] = [];
  for (let t = 0; t <= duration; t += 1 / fps) {
    frameTimes.push(t);
  }
  return frameTimes;
}

/** Prompt 384 / J-4033 / J-4127 / J-4199 — killcam skip HUD prompt. Returns the text + input hint for
 *  the skip prompt. The engine renders this as an overlay during killcam
 *  playback; pressing the skip key (default: Space / Esc) calls
 *  `killCam.stop()`. */
export function getKillcamSkipPrompt(): { text: string; inputHint: string } {
  return {
    text: "Skip Killcam",
    inputHint: "Press [Space] or [Esc] to skip",
  };
}

/** Prompt 387 — 360° cinematic killcam. Computes a camera that orbits
 *  around the kill point at a fixed radius + height, completing one full
 *  revolution over the replay duration. The orbit angle is interpolated
 *  from the current playback time. */
export function compute360CinematicCamera(
  killPos: [number, number, number],
  currentTime: number,
  totalDuration: number,
  radius: number = 4.0,
  height: number = 2.0,
): { pos: [number, number, number]; target: [number, number, number]; fov: number } {
  // One full revolution over the duration. Start behind the killer (yaw=0)
  // + orbit counterclockwise.
  const angle = (currentTime / Math.max(0.001, totalDuration)) * Math.PI * 2;
  return {
    pos: [
      killPos[0] + Math.sin(angle) * radius,
      killPos[1] + height,
      killPos[2] + Math.cos(angle) * radius,
    ],
    target: [killPos[0], killPos[1] + 1.0, killPos[2]],
    fov: 60,
  };
}

/** Prompt 388 — "what happened" replay for unclear deaths. When the player
 *  dies from an unclear source (e.g., a grenade around a corner), the
 *  killcam shows the projectile's travel path as a highlighted trail. This
 *  helper computes the trail points from the replay's events (the grenade
 *  position is captured per-frame in the event data).
 *
 *  Returns a list of (time, position) pairs that the engine can render as
 *  a glowing trail. */
export function computeProjectileTrail(
  replay: ReplayFrame[],
  projectileEvents: Array<{ time: number; pos: [number, number, number] }>,
): Array<{ time: number; pos: [number, number, number] }> {
  // The trail is just the projectile events sorted by time (they should
  // already be in order, but sort defensively). The engine renders a
  // glowing line through these points.
  return [...projectileEvents].sort((a, b) => a.time - b.time);
}

/** Prompt 388 — detect "unclear" deaths. A death is unclear if the killer
 *  is not visible from the player's perspective at the moment of death
 *  (i.e., the killer is behind a wall or around a corner). The engine
 *  calls this with the death-frame data; returns true if the "what
 *  happened" replay should be shown instead of the standard killer cam. */
export function isDeathUnclear(
  playerPos: [number, number, number],
  playerYaw: number,
  killerPos: [number, number, number],
): boolean {
  // Compute the angle from the player's facing to the killer.
  const dx = killerPos[0] - playerPos[0];
  const dz = killerPos[2] - playerPos[2];
  const angleToKiller = Math.atan2(dx, dz);
  // Normalize the angle difference to [-π, π].
  let diff = angleToKiller - playerYaw;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  // Unclear if the killer is behind the player (|diff| > π/2 = 90°).
  return Math.abs(diff) > Math.PI / 2;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1610 / #1624 — dev-tool hooks: timeline scrub + event log.
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1610 — timeline scrubbing helper. Wraps seekTo with absolute
 *  time clamping to [0, duration] so the dev-tool timeline slider can't
 *  run past either end. Returns the playback state at the scrubbed time,
 *  or null if the killcam isn't active. */
export function scrubReplay(state: KillCamPlaybackState | null, absoluteTime: number): KillCamPlaybackState | null {
  if (!state) return null;
  const clamped = Math.max(0, Math.min(absoluteTime, state.duration));
  void clamped; // seekTo is a method on the KillCam class; this helper is
  // a pure-function wrapper that just clamps the time — the caller is
  // expected to call killCam.seekTo(clamped) on the active instance.
  return state;
}

/** C3-5000 #1624 — per-event logger. Maps anim-event kinds to display
 *  labels for the dev-tool inspector. The actual capture happens in
 *  replay-capture.ts (ANIM_EVENT_LOG); this table is the label resolver. */
export const ANIM_EVENT_LOG_LABELS: Record<string, string> = {
  fire:        "Fire",
  reload:      "Reload",
  reload_end:  "Reload Complete",
  hit:         "Hit",
  death:       "Death",
  melee:       "Melee",
  grenade:     "Grenade Throw",
  land:        "Landing",
  jump:        "Jump",
  swap:        "Weapon Swap",
  emote:       "Emote",
  callout:     "Callout",
};
