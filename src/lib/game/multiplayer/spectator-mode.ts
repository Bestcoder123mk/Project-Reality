/**
 * G_Multiplayer_Netcode-00036 / 00037: Spectator mode networking.
 *
 * Spectators receive the full snapshot (no culling — they can free-cam) but
 * never send inputs that affect game state. The server treats them as
 * read-only clients:
 *   - No slot consumed (a 5v5 ranked match can host up to 4 spectators).
 *   - No team assignment; `interpolateSnapshots` skips them in the entity list.
 *   - Their only uplink is a "follow target" message so the server can
 *     prioritize that entity's snapshot.
 *
 * `SpectatorSync` runs on both client + server:
 *   - Client: `setFollowTarget(targetId)` queues a follow message;
 *     `consumeOutbox()` returns + clears the queue (the relay sends it).
 *   - Server: `applyFollow(msg)` updates the interest set for that spectator
 *     + returns the new state.
 *
 * Free-cam: `setFollowTarget(null)` → free-cam; server sends full snapshot
 * without prioritizing any entity. Target switches are throttled to once
 * per `switchCooldownTicks` (default 15 ticks = 250 ms @ 60 Hz) to prevent
 * snapshot thrash.
 */

export type SpectatorMode = "follow" | "freecam" | "overview";

export interface FollowMessage {
  type: "follow";
  clientId: string;
  targetId: string | null;
  mode: SpectatorMode;
  /** Tick at which the client switched (for jitter buffering). */
  tick: number;
}

export interface SpectatorState {
  clientId: string;
  targetId: string | null;
  mode: SpectatorMode;
  /** Tick of last switch (server-side, for throttle). */
  lastSwitchTick: number;
}

export interface SpectatorSyncOptions {
  /** Min ticks between target switches. Default 15 (250 ms @ 60 Hz). */
  switchCooldownTicks?: number;
  /** Max spectators per match. Default 4. */
  maxSpectators?: number;
}

export class SpectatorSync {
  private opts: Required<SpectatorSyncOptions>;
  private spectators = new Map<string, SpectatorState>();
  private outbox: FollowMessage[] = [];
  private currentTick = 0;

  constructor(opts: SpectatorSyncOptions = {}) {
    this.opts = { switchCooldownTicks: 15, maxSpectators: 4, ...opts };
  }

  /** Advance the internal tick counter (called once per server/client tick). */
  advanceTick(): void {
    this.currentTick += 1;
  }

  /** Add a spectator (server-side). Returns false if the match is full. */
  addSpectator(clientId: string): boolean {
    if (this.spectators.size >= this.opts.maxSpectators) return false;
    if (this.spectators.has(clientId)) return true;
    this.spectators.set(clientId, {
      clientId,
      targetId: null,
      mode: "overview",
      lastSwitchTick: this.currentTick,
    });
    return true;
  }

  removeSpectator(clientId: string): void {
    this.spectators.delete(clientId);
  }

  /** Client-side: request a follow-target switch. */
  setFollowTarget(targetId: string | null, mode: SpectatorMode = targetId ? "follow" : "freecam"): boolean {
    this.outbox.push({ type: "follow", clientId: "self", targetId, mode, tick: this.currentTick });
    return true;
  }

  /** Drain the outbox (relay sends these as critical-priority packets). */
  consumeOutbox(): FollowMessage[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /** Server-side: apply a follow message. Returns the new state or null on reject. */
  applyFollow(msg: FollowMessage): SpectatorState | null {
    const s = this.spectators.get(msg.clientId);
    if (!s) return null;
    if (this.currentTick - s.lastSwitchTick < this.opts.switchCooldownTicks) return s;
    s.targetId = msg.targetId;
    s.mode = msg.mode;
    s.lastSwitchTick = this.currentTick;
    return s;
  }

  getState(clientId: string): SpectatorState | null {
    return this.spectators.get(clientId) ?? null;
  }

  allSpectators(): IterableIterator<SpectatorState> {
    return this.spectators.values();
  }

  /** Entity id the server should prioritize for this spectator (or null). */
  prioritizedEntity(clientId: string): string | null {
    const s = this.spectators.get(clientId);
    if (!s || s.mode !== "follow" || !s.targetId) return null;
    return s.targetId;
  }

  get size(): number {
    return this.spectators.size;
  }

  reset(): void {
    this.spectators.clear();
    this.outbox = [];
    this.currentTick = 0;
  }
}
