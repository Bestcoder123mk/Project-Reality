/**
 * G_Multiplayer_Netcode-00016: Rollback netcode for melee.
 *
 * Melee swings are 1-3 frame commitment windows; standard server-authoritative
 * replay (60 ms RTT) feels awful. Rollback lets both clients render the swing
 * immediately from local input, then rewind + resimulate when the remote
 * player's input arrives. Caller drives from the game loop:
 *   1. `recordLocal(input, state)` each tick.
 *   2. On remote input: `recordRemote(frame, input)` → if true, `rollbackTo(frame)`.
 *   3. Replay: call `replayNext()` until null, `commitResimulated(frame, state)`.
 *
 * Buffer defaults to 12 frames (200 ms @ 60 Hz) — beyond that we accept a snap.
 */

export interface MeleeInput {
  /** Player pressed the melee button this frame. */
  swing: boolean;
  /** Direction the player was facing (for hitbox sweep). */
  yaw: number;
}

export interface MeleeState {
  /** -1 = idle, 0..activeFrames-1 = windup/active/recovery frame index. */
  swingFrame: number;
  activeFrames: number;
  /** Player world position at this frame (for hitbox overlap tests). */
  x: number;
  y: number;
  z: number;
}

export interface FrameEntry {
  frame: number;
  local: MeleeInput;
  remote: MeleeInput | null;
  state: MeleeState;
  confirmedHit: boolean;
}

export class RollbackBuffer {
  private capacity: number;
  private ring: FrameEntry[] = [];
  private currentFrame = -1;
  private replayCursor: number | null = null;
  private confirmedFrames = new Set<number>();

  constructor(capacity = 12) {
    this.capacity = capacity;
  }

  get latestFrame(): number {
    return this.currentFrame;
  }

  /** Record local input + predicted state for the next frame. */
  recordLocal(input: MeleeInput, state: MeleeState): void {
    this.currentFrame += 1;
    this.push({
      frame: this.currentFrame,
      local: input,
      remote: null,
      state,
      confirmedHit: this.confirmedFrames.has(this.currentFrame),
    });
  }

  /** Apply a remote input for a past frame; returns true if rollback is needed. */
  recordRemote(frame: number, input: MeleeInput): boolean {
    const entry = this.get(frame);
    if (!entry) return false;
    if (entry.remote && inputsEqual(entry.remote, input)) return false;
    entry.remote = input;
    return frame < this.currentFrame;
  }

  /** Mark a hit as confirmed at `frame` so the replay loop short-circuits. */
  confirmHit(frame: number, _targetId: string): void {
    this.confirmedFrames.add(frame);
    const entry = this.get(frame);
    if (entry) entry.confirmedHit = true;
  }

  /** Begin replaying from `frame`. Returns the prev state or null. */
  rollbackTo(frame: number): MeleeState | null {
    const entry = this.get(frame);
    if (!entry) return null;
    this.replayCursor = frame;
    return entry.state;
  }

  /** Returns the next frame's (input, prev-state) to simulate, or null when done. */
  replayNext(): { frame: number; local: MeleeInput; remote: MeleeInput; prev: MeleeState } | null {
    if (this.replayCursor === null) return null;
    const frame = this.replayCursor;
    if (frame >= this.currentFrame) { this.replayCursor = null; return null; }
    const entry = this.get(frame);
    const next = this.get(frame + 1);
    if (!entry || !next || entry.confirmedHit) { this.replayCursor = null; return null; }
    this.replayCursor = frame + 1;
    return {
      frame: frame + 1,
      local: next.local,
      remote: next.remote ?? entry.remote ?? { swing: false, yaw: entry.state.yaw },
      prev: entry.state,
    };
  }

  /** After replaying, commit the resimulated state for `frame`. */
  commitResimulated(frame: number, state: MeleeState): void {
    const entry = this.get(frame);
    if (entry) entry.state = state;
  }

  reset(): void {
    this.ring = [];
    this.currentFrame = -1;
    this.replayCursor = null;
    this.confirmedFrames.clear();
  }

  private push(entry: FrameEntry): void {
    if (this.ring.length < this.capacity) {
      this.ring.push(entry);
    } else {
      // Overwrite oldest (lowest frame) entry.
      let oldestIdx = 0;
      for (let i = 1; i < this.ring.length; i++) {
        if (this.ring[i].frame < this.ring[oldestIdx].frame) oldestIdx = i;
      }
      this.ring[oldestIdx] = entry;
    }
  }

  private get(frame: number): FrameEntry | null {
    if (frame < 0 || frame > this.currentFrame) return null;
    return this.ring.find((e) => e?.frame === frame) ?? null;
  }
}

function inputsEqual(a: MeleeInput, b: MeleeInput): boolean {
  return a.swing === b.swing && a.yaw === b.yaw;
}
