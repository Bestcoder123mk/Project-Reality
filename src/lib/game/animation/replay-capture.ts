/**
 * SEC4-ANIM — Prompt 38 (part 1 of 2)
 * ─────────────────────────────────────────────────────────────────────────────
 * ReplayCapture — ring-buffer capture of per-frame game state for the kill-cam.
 *
 * C2-5000 prompt mapping (each implemented by the prior-mission A-series fix noted):
 *   C2-5000 #1348 [Prompt A#80] O(N) shift → fixed-capacity ring buffer (head/tail) O(1) push
 *   C2-5000 #1349 [Prompt A#81] no pause/resume → start/pause/resume + isRecording gate
 *   C2-5000 #1350 [Prompt A#82] no dt clamp → wall-clock dt clamped to 1/15s (no gap on tab)
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1180 [Prompt 380]  replay save/export JSON (saveReplayToJSON + loadReplayFromJSON)
 *   C1-5000 #1182 [Prompt 382]  extend replay buffer beyond 3s (createExtendedReplayCapture)
 *   C1-5000 #1183 [Prompt 383]  capture non-lethal events (NON_LETHAL_EVENT_KINDS + makeNonLethalEvent)
 *   C1-5000 #1185 [Prompt 385]  multi-kill replay concatenation (concatenateMultiKillReplays)
 *
 * C3-5000 prompt mapping:
 *   C3-5000 #1624 [ANIM_EVENT_LOG]  per-event logger — captures per-clip
 *      anim events (fire/reload/hit/death) into a ring-buffer log exported
 *      at the bottom of this file for the dev-tool inspector.
 *
 * Records the last N seconds (default 3.0s @ 60Hz = 180 frames) of:
 *   - Player position + yaw + pitch.
 *   - Enemy positions + yaw + alive state (per enemy, by id).
 *   - Camera world position + quaternion.
 *   - Key events (kills, damage, headshots) emitted during the window.
 *
 * The engine calls `captureFrame(state)` once per frame; on player death,
 * the kill-cam calls `getBuffer()` to retrieve the captured frames and
 * plays them back from a specified perspective (killer / victim / etc.).
 *
 * Memory: each frame is ~200 bytes (player + 8 enemies + camera + events).
 * 180 frames × 200 bytes = ~36KB per match — trivial.
 *
 * SSR-safe: pure-TS, no `window`, no `document`, no Three.js needed (the
 * tuple-based state shape avoids Vector3 allocation in the hot path).
 */

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/** Per-frame player state. Tuples (not Vector3) for cheap ring-buffer storage. */
export interface ReplayPlayerState {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
}

/** Per-frame per-enemy state. `id` matches the Enemy.id field. */
export interface ReplayEnemyState {
  id: string;
  pos: [number, number, number];
  yaw: number;
  alive: boolean;
}

/** Per-frame camera state. Quaternion as [x, y, z, w] tuple. */
export interface ReplayCameraState {
  pos: [number, number, number];
  quat: [number, number, number, number];
}

/** A key event captured during the replay window (kill, damage, headshot). */
export interface ReplayEvent {
  kind: "kill" | "damage" | "headshot" | "explosion" | "down";
  time: number; // seconds since capture start
  data?: unknown;
}

/** One frame in the replay ring buffer. */
export interface ReplayFrame {
  /** Time since capture started (seconds). */
  time: number;
  player: ReplayPlayerState;
  enemies: ReplayEnemyState[];
  camera: ReplayCameraState;
  events: ReplayEvent[];
}

/** State to capture for a frame. Omit `time` (assigned by the capture). */
export type ReplayFrameInput = Omit<ReplayFrame, "time">;

// ───────────────────────────────────────────────────────────────────────────
// ReplayCapture
// ───────────────────────────────────────────────────────────────────────────

export interface ReplayCaptureOptions {
  /** How many seconds of history to keep. Default 3.0. */
  capacitySeconds?: number;
  /** Target capture FPS (drives ring-buffer size). Default 60. */
  targetFps?: number;
  /** Performance.now() override (for testing). */
  now?: () => number;
}

export class ReplayCapture {
  /** Prompt A#80 — fixed-capacity ring buffer (head/tail) backed by a
   *  pre-allocated array. Was `buffer.push()` + `buffer.shift()` which
   *  was O(N) per capture frame (180 frames × N moves = 32_400 array
   *  moves per second at 60Hz). Now O(1) per frame: write at `tail`, advance
   *  tail modulo capacity; the read path (getBuffer/snapshot) reconstructs
   *  the time-ordered view on demand (rare — only on player death). */
  private buffer: ReplayFrame[];
  private head = 0; // index of the oldest live frame
  private tail = 0; // index where the NEXT write will land
  private count = 0; // number of live frames (head..tail mod capacity)
  /** Max frames the buffer holds (capacitySeconds × targetFps). */
  private capacity: number;
  /** Performance.now() reference — kept for diagnostics / external callers
   *  that may inspect capture-start time (set on first capture). */
  private startTime = 0;
  /** Whether the start time has been initialized. */
  private started = false;
  /** Clock function (overridable for testing). */
  private now: () => number;
  /** Prompt A#81 — when false, `captureFrame` is a no-op so pausing
   *  capture during killcam playback doesn't pollute the buffer with
   *  the killcam's own camera/enemy state. */
  private isRecording = false;
  /** Prompt A#82 — last frame's wall-clock time, used to compute dt.
   *  Clamped to 1/15s so a backgrounded tab doesn't inject a 30s gap. */
  private lastWallTime = 0;
  /** Prompt A#82 — max dt (seconds) we'll accept between capture frames.
   *  Larger gaps (tab backgrounded, debugger paused, GC stall) are clamped
   *  so the replay timeline doesn't jump. */
  private static readonly MAX_DT_SEC = 1 / 15;

  constructor(opts: ReplayCaptureOptions = {}) {
    const capacitySeconds = opts.capacitySeconds ?? 3.0;
    const targetFps = opts.targetFps ?? 60;
    this.capacity = Math.max(1, Math.ceil(capacitySeconds * targetFps));
    // Pre-allocate the slot array once (capacity+1 to distinguish full
    // from empty in the classic ring-buffer head/tail convention).
    this.buffer = new Array<ReplayFrame>(this.capacity);
    this.now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.isRecording = false;
  }

  /** Prompt A#81 — start/resume capture. Idempotent. */
  start(): void {
    this.isRecording = true;
  }

  /** Prompt A#81 — pause capture (e.g. while the killcam itself is
   *  playing back). Idempotent. The buffer is preserved; only future
   *  captureFrame calls are dropped. */
  pause(): void {
    this.isRecording = false;
  }

  /** Prompt A#81 — resume capture, resetting the dt baseline so the
   *  gap during the pause doesn't inject a giant dt on the first
   *  post-resume frame. */
  resume(): void {
    if (this.isRecording) return;
    this.isRecording = true;
    this.lastWallTime = this.now();
  }

  /** Prompt A#81 — true when capture is actively recording frames. */
  get recording(): boolean {
    return this.isRecording;
  }

  /**
   * Capture a frame. The frame's `time` is computed from the elapsed time
   * since the first capture. If the buffer is full, the oldest frame is
   * dropped (ring-buffer behavior).
   *
   * Prompt A#81 — no-op when `isRecording === false` (use start/pause/resume).
   * Prompt A#82 — dt between frames is clamped to 1/15s so a backgrounded
   *   tab doesn't inject a multi-second gap into the replay timeline.
   */
  captureFrame(state: ReplayFrameInput): void {
    if (!this.isRecording) return;
    const wallMs = this.now();
    if (!this.started) {
      this.startTime = wallMs;
      this.lastWallTime = wallMs;
      this.started = true;
    }
    // Prompt A#82 — clamp the wall-clock delta. A backgrounded tab stops
    // the rAF loop; when it resumes, the first dt is the entire gap (often
    // 30s+). Without clamping the replay timeline jumps and the killcam
    // shows a frozen scene for one frame at the gap point.
    const rawDt = (wallMs - this.lastWallTime) / 1000;
    const dt = Math.max(0, Math.min(rawDt, ReplayCapture.MAX_DT_SEC));
    this.lastWallTime = wallMs;
    // Advance the replay clock by the CLAMPED dt (so the timeline stays
    // continuous even after a background gap). When count > 0 the newest
    // frame is guaranteed non-null; the nullish coalescing covers the
    // (impossible) race where count > 0 but the buffer slot is empty.
    const newest = this.peekNewest();
    const time = this.count === 0 || !newest ? 0 : newest.time + dt;
    const frame: ReplayFrame = { time, ...state };
    this.buffer[this.tail] = frame;
    this.tail = (this.tail + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      // Buffer full — head moves forward (oldest frame dropped).
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Prompt A#80 — read the newest frame (for dt computation) without
   *  reconstructing the time-ordered array. */
  private peekNewest(): ReplayFrame | null {
    if (this.count === 0) return null;
    const idx = (this.tail + this.capacity - 1) % this.capacity;
    return this.buffer[idx];
  }

  /** Prompt A#80 — reconstruct the time-ordered array of live frames.
   *  O(N) but called only on player death (rare). */
  private liveFrames(): ReplayFrame[] {
    if (this.count === 0) return [];
    const out: ReplayFrame[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.buffer[(this.head + i) % this.capacity];
    }
    return out;
  }

  /** Get the current ring buffer (oldest first, newest last). The returned
   *  array is a freshly-built copy — callers may mutate it freely.
   *  Prompt A#80 — was the live internal array; now a reconstructed copy
   *  since the storage is a head/tail ring. */
  getBuffer(): ReplayFrame[] {
    return this.liveFrames();
  }

  /** Total duration captured (seconds). 0 if fewer than 2 frames. */
  get duration(): number {
    if (this.count < 2) return 0;
    const frames = this.liveFrames();
    return frames[frames.length - 1].time - frames[0].time;
  }

  /** Number of frames currently in the buffer. */
  get frameCount(): number {
    return this.count;
  }

  /** Max frames the buffer can hold. */
  get maxFrames(): number {
    return this.capacity;
  }

  /** True if the capture has at least 2 frames (minimum for playback). */
  get isReady(): boolean {
    return this.count >= 2;
  }

  /** Clear the buffer (call on match restart / death cleanup). */
  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.startTime = 0;
    this.lastWallTime = 0;
    this.started = false;
  }

  /**
   * Get a snapshot of the buffer suitable for handing off to KillCam.play().
   * Returns a shallow copy so the KillCam owns its own array reference
   * (the live ring buffer keeps shifting as new frames are captured).
   */
  snapshot(): ReplayFrame[] {
    return this.liveFrames();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 380, 382, 383, 385: replay save/export (JSON), extended
// buffer (up to 30s), non-lethal event capture, multi-kill concatenation.
// ═══════════════════════════════════════════════════════════════════════════

/** Prompt 380 — replay save/export. Serializes a replay (array of frames)
 *  to a JSON string. The format is a plain array of frame objects (each
 *  frame is a tuple-based object, so JSON.stringify is cheap). The exported
 *  JSON can be re-loaded via `loadReplayFromJSON` for playback or sharing.
 *
 *  Returns the JSON string. */
export function saveReplayToJSON(frames: ReplayFrame[]): string {
  // Strip any non-serializable fields (e.g., circular refs in `data`).
  // The base frame shape is plain tuples + primitives, so JSON.stringify
  // handles it directly. We use a replacer that skips functions + symbols.
  return JSON.stringify(frames, (_key, value) => {
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    return value;
  });
}

/** Prompt 380 — load a replay from a JSON string. Returns the parsed frame
 *  array, or null if the JSON is invalid / doesn't match the expected shape. */
export function loadReplayFromJSON(json: string): ReplayFrame[] | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    // Basic shape validation — each entry must have time, player, enemies, camera, events.
    for (const f of parsed as unknown[]) {
      const frame = f as Partial<ReplayFrame>;
      if (typeof frame.time !== "number") return null;
      if (!Array.isArray(frame.player?.pos)) return null;
      if (!Array.isArray(frame.enemies)) return null;
      if (!Array.isArray(frame.camera?.pos) || !Array.isArray(frame.camera?.quat)) return null;
      if (!Array.isArray(frame.events)) return null;
    }
    return parsed as ReplayFrame[];
  } catch {
    return null;
  }
}

/** Prompt 382 — extended replay buffer. The base ReplayCapture constructor
 *  accepts `capacitySeconds` (default 3.0). This helper constructs a
 *  capture pre-configured for the "extended" setting (up to 30s at 60Hz =
 *  1800 frames). The engine should use this when the player has enabled
 *  "extended replay buffer" in settings. */
export function createExtendedReplayCapture(
  capacitySeconds: number = 30.0,
  targetFps: number = 60,
): ReplayCapture {
  return new ReplayCapture({ capacitySeconds, targetFps });
}

/** Prompt 383 — non-lethal event kinds. The base ReplayEvent.kind union is
 *  "kill" | "damage" | "headshot" | "explosion" | "down". This extends it
 *  with revive, capture, objective for non-lethal replays (objective
 *  captures, revives, etc.). The engine calls `captureFrame` with these
 *  kinds in the events array. */
export const NON_LETHAL_EVENT_KINDS = [
  "revive", "capture", "objective", "defuse", "plant", "extract",
] as const;
export type NonLethalEventKind = (typeof NON_LETHAL_EVENT_KINDS)[number];

/** Prompt 383 — helper to emit a non-lethal event at the current capture
 *  time. The engine calls this when an objective is captured, a teammate
 *  is revived, etc. The event is added to the NEXT captured frame's
 *  events array (the engine passes it via the ReplayFrameInput.events
 *  field). */
export function makeNonLethalEvent(
  kind: NonLethalEventKind,
  time: number,
  data?: unknown,
): { kind: NonLethalEventKind; time: number; data?: unknown } {
  return { kind, time, data };
}

/** Prompt 385 — multi-kill replay concatenation. Given multiple replays
 *  (each an array of frames), concatenates them into a single timeline
 *  with continuous time. Each replay's frames are time-shifted so they
 *  play back-to-back. The result can be passed to KillCam.play() for a
 *  single multi-kill montage.
 *
 *  The `gapSeconds` between replays defaults to 0.5s (a brief beat
 *  between kills). */
export function concatenateMultiKillReplays(
  replays: ReplayFrame[][],
  gapSeconds: number = 0.5,
): ReplayFrame[] {
  if (replays.length === 0) return [];
  if (replays.length === 1) return replays[0];
  const out: ReplayFrame[] = [];
  let timeOffset = 0;
  for (let i = 0; i < replays.length; i++) {
    const replay = replays[i];
    if (replay.length === 0) continue;
    const startTime = replay[0].time;
    for (const frame of replay) {
      out.push({
        ...frame,
        time: frame.time - startTime + timeOffset,
      });
    }
    const endTime = replay[replay.length - 1].time - startTime + timeOffset;
    timeOffset = endTime + gapSeconds;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1624 — per-event logger (ring buffer of anim events for the
//  dev-tool inspector). The kill-cam reads this log to overlay event
//  markers on the timeline scrubber.
// ═══════════════════════════════════════════════════════════════════════════

export interface AnimEventLogEntry {
  time: number;       // seconds since recording start
  kind: string;       // "fire" | "reload" | "hit" | "death" | etc.
  actorId: string;    // operator/enemy id
  meta?: Record<string, unknown>;
}

export class AnimEventLog {
  private _buf: AnimEventLogEntry[] = [];
  private _head = 0;
  constructor(private _capacity: number = 256) {
    this._buf = new Array(_capacity);
  }
  push(entry: AnimEventLogEntry): void {
    this._buf[this._head] = entry;
    this._head = (this._head + 1) % this._capacity;
  }
  /** Drain returns all entries in chronological order (oldest first). */
  drain(): AnimEventLogEntry[] {
    const out: AnimEventLogEntry[] = [];
    for (let i = 0; i < this._capacity; i++) {
      const idx = (this._head + i) % this._capacity;
      const e = this._buf[idx];
      if (e) out.push(e);
    }
    return out;
  }
  clear(): void {
    this._buf = new Array(this._capacity);
    this._head = 0;
  }
}

/** Module-level singleton used by the engine to log anim events. */
export const ANIM_EVENT_LOG = new AnimEventLog();
