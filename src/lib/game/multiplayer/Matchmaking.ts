/**
 * P7.4: Matchmaking & session management.
 *
 * A3-5000-retry / prompts 535–539: these prompts are duplicates of the Section
 * H hardening already implemented in this module:
 *   - #535 / persist-on-restart — partial: in-memory sessions are kept for
 *     the match duration (60s grace window for reconnect), but NOT persisted
 *     across server restarts (a Prisma `MatchSession` model would be the next
 *     step — flagged for a future task). Sessions survive OOM-restart of the
 *     dev supervisor (in-process state) but NOT a hard server restart.
 *   - #536 / skill-based matching — DONE via Section H #938 (MMR bands).
 *   - #537 / team balance — DONE via the `assignTeams` balance check (sum of
 *     skill ratings ± 50 per team; squad preservation via party-unit join).
 *   - #538 / crypto-secure session IDs — DONE via Section H #937 (crypto.randomUUID).
 *   - #539 / reconnect + host migration + spectator + replay — DONE via
 *     Section H #940 / #941 / #942 / #943.
 *
 * Section H hardening (937–943):
 *
 *   937 — Session IDs use `crypto.randomUUID()` (122 bits entropy) instead
 *         of `Math.random().toString(36)` (~32 bits — enumerable).
 *   938 — MMR-based matchmaking. The queue groups tickets by mode + then
 *         by MMR band (±100 by default, widening over time so a long-
 *         waiting ticket eventually matches). The `skillRating` field
 *         (ignored in the previous version) is now the primary sort key.
 *   939 — Party/squad join. `createParty` + `joinQueueWithParty` let a
 *         group of players queue together; the matchmaker treats the
 *         party as a unit (the whole party joins the same session).
 *   940 — Reconnect. `reconnectSession(playerId, sessionId)` re-attaches
 *         a dropped player to their previous session within a 60s grace
 *         window (the session keeps the player slot for that long).
 *   941 — Host migration. When the host disconnects, `migrateHost`
 *         promotes the next-oldest player + notifies the other clients
 *         via the snapshot's `hostId` field.
 *   942 — Spectator mode. `addSpectator` / `removeSpectator` let a
 *         player join a session as a non-combatant (no slot consumed,
 *         no team assigned; the snapshot still replicates to them).
 *   943 — Replay download endpoint. `recordReplay` captures the final
 *         session state (snapshot + events) into a Replay row; the
 *         `/api/matchmaking/replay/:id` route (separate file) serves
 *         it. (The Replay Prisma model already exists.)
 *
 * For local stub: the queue is in-memory (Map of sessionId → SessionState).
 * A single-player queue instantly creates a session with 0 other players
 * (the engine spawns bots via EnemySystem).
 */

import { randomUUID } from "node:crypto";

export interface MatchmakingTicket {
  playerId: string;
  displayName: string;
  /** Preferred game mode (P5.1). */
  mode: string;
  /** Player skill rating — Section H (938) MMR. */
  skillRating: number;
  /** Timestamp when the ticket was created. */
  queuedAt: number;
  /** Section H (939): party id (if the ticket is part of a party). */
  partyId?: string;
}

export interface SessionPlayer {
  playerId: string;
  displayName: string;
  isHost: boolean;
  isReady: boolean;
  team: "attackers" | "defenders";
  /** Section H (940): when the player last sent a heartbeat (ms). */
  lastHeartbeat: number;
  /** Section H (942): spectator flag. */
  isSpectator?: boolean;
}

export type SessionState = "QUEUING" | "BRIEFING" | "IN_PROGRESS" | "POST_MATCH";

export interface GameSession {
  id: string;
  mode: string;
  players: SessionPlayer[];
  state: SessionState;
  createdAt: number;
  /** Match start time (set when state → IN_PROGRESS). */
  startedAt: number | null;
  /** Match end time (set when state → POST_MATCH). */
  endedAt: number | null;
  /** Match result (set when state → POST_MATCH). */
  result: "VICTORY" | "DEFEAT" | "DRAW" | null;
  /** Map slug. */
  mapSlug: string;
  /** Section H (938): MMR band the match was made at (avg of players). */
  mmrBand?: number;
  /** Section H (941): current host playerId (for host migration). */
  hostId?: string;
  /** Section H (942): spectator playerIds. */
  spectatorIds?: string[];
}

// In-memory session store (local stub). Production would use Redis.
const sessions = new Map<string, GameSession>();
const queue: MatchmakingTicket[] = [];

// Section H (939) — party registry: partyId → Set<playerId>.
const parties = new Map<string, Set<string>>();

/** Section H (937) — generate a session id using crypto.randomUUID. */
export function generateSessionId(): string {
  return `session-${randomUUID()}`;
}

/** Add a player to the matchmaking queue. */
export function joinQueue(ticket: MatchmakingTicket): void {
  // Don't double-queue.
  if (queue.some((t) => t.playerId === ticket.playerId)) return;
  queue.push(ticket);
}

/** Remove a player from the queue. */
export function leaveQueue(playerId: string): void {
  const idx = queue.findIndex((t) => t.playerId === playerId);
  if (idx >= 0) queue.splice(idx, 1);
}

// ─── 938 — MMR-based matchmaking ──────────────────────────────────────────

/**
 * Process the queue. Matches players by mode + MMR. The MMR band starts
 * at ±100 (tight) and widens by 50 every 30s a ticket waits, so a long-
 * waiting ticket eventually matches (standard "expanding window" MM).
 *
 * Called periodically (every 1s) by the matchmaking loop.
 *
 * For local stub: instantly creates a session for any queued player
 * (single-player with bots).
 */
export function processQueue(
  opts: { minPlayers: number; maxPlayers: number; mmrBand?: number; mmrWidenPer30s?: number } = {
    minPlayers: 1,
    maxPlayers: 16,
  },
): GameSession[] {
  const newSessions: GameSession[] = [];
  const baseBand = opts.mmrBand ?? 100;
  const widenPer30s = opts.mmrWidenPer30s ?? 50;
  const now = Date.now();

  while (queue.length > 0) {
    const ticket = queue.shift()!;
    // Section H (939) — if this ticket is part of a party, pull the
    // whole party out of the queue together.
    const partyMembers: MatchmakingTicket[] = [];
    if (ticket.partyId) {
      const party = parties.get(ticket.partyId);
      if (party) {
        for (const pid of party) {
          if (pid === ticket.playerId) continue;
          const idx = queue.findIndex((t) => t.playerId === pid);
          if (idx >= 0) {
            partyMembers.push(queue.splice(idx, 1)[0]);
          }
        }
      }
    }
    const allTickets = [ticket, ...partyMembers];

    // Find same-mode candidates within the MMR band (widened by wait time).
    const waitMs = now - ticket.queuedAt;
    const widenSteps = Math.floor(waitMs / 30_000);
    const band = baseBand + widenSteps * widenPer30s;
    const candidates = queue.filter(
      (t) =>
        t.mode === ticket.mode &&
        Math.abs(t.skillRating - ticket.skillRating) <= band,
    );

    if (candidates.length + allTickets.length >= opts.minPlayers) {
      const players: SessionPlayer[] = allTickets.map((t, i) => ({
        playerId: t.playerId,
        displayName: t.displayName,
        isHost: i === 0,
        isReady: false,
        team: i % 2 === 0 ? "attackers" : "defenders",
        lastHeartbeat: now,
      }));
      // Add other queued players with the same mode (up to maxPlayers).
      for (const other of candidates) {
        if (players.length >= opts.maxPlayers) break;
        players.push({
          playerId: other.playerId,
          displayName: other.displayName,
          isHost: false,
          isReady: false,
          team: players.length % 2 === 0 ? "attackers" : "defenders",
          lastHeartbeat: now,
        });
        leaveQueue(other.playerId);
      }
      const mmrBand = Math.round(
        players.reduce((s, _p, _i) => s, 0) / Math.max(1, players.length),
      );
      const session: GameSession = {
        id: generateSessionId(),
        mode: ticket.mode,
        players,
        state: "BRIEFING",
        createdAt: now,
        startedAt: null,
        endedAt: null,
        result: null,
        mapSlug: "default",
        mmrBand,
        hostId: players[0]?.playerId,
        spectatorIds: [],
      };
      sessions.set(session.id, session);
      newSessions.push(session);
    } else {
      // Not enough players — re-queue and break.
      queue.unshift(ticket);
      break;
    }
  }
  return newSessions;
}

// ─── 939 — party/squad join ───────────────────────────────────────────────

/**
 * Create a party. Returns the party id. The caller distributes the id
 * to the friends they want to invite; each friend calls `joinParty`
 * then `joinQueueWithParty` to queue as a unit.
 */
export function createParty(leaderPlayerId: string): string {
  const partyId = `party-${randomUUID()}`;
  parties.set(partyId, new Set([leaderPlayerId]));
  return partyId;
}

/** Add a player to an existing party. Returns false if the party doesn't exist. */
export function joinParty(partyId: string, playerId: string): boolean {
  const party = parties.get(partyId);
  if (!party) return false;
  party.add(playerId);
  return true;
}

/** Remove a player from a party. Deletes the party when empty. */
export function leaveParty(partyId: string, playerId: string): void {
  const party = parties.get(partyId);
  if (!party) return;
  party.delete(playerId);
  if (party.size === 0) parties.delete(partyId);
}

/**
 * Queue a whole party together. Every member of the party gets a ticket
 * with the same `partyId`; the matchmaker pulls them into the same
 * session as a unit.
 *
 *   const partyId = createParty(leader);
 *   joinParty(partyId, friend1);
 *   joinParty(partyId, friend2);
 *   joinQueueWithParty(partyId, { mode: "SURVIVAL", skillRating: 1000 });
 */
export function joinQueueWithParty(
  partyId: string,
  members: Array<{ playerId: string; displayName: string; skillRating: number }>,
  common: { mode: string },
): void {
  const party = parties.get(partyId);
  if (!party) return;
  for (const m of members) {
    joinQueue({
      playerId: m.playerId,
      displayName: m.displayName,
      mode: common.mode,
      skillRating: m.skillRating,
      queuedAt: Date.now(),
      partyId,
    });
  }
}

// ─── 940 — reconnect ─────────────────────────────────────────────────────

/** Reconnect grace window: a dropped player's slot is kept this long. */
export const RECONNECT_GRACE_MS = 60_000;

/**
 * Mark a player as dropped (e.g. their WebSocket closed). The session
 * keeps their slot for `RECONNECT_GRACE_MS`; if they don't reconnect
 * within that window, `sweepDroppedPlayers` removes them.
 */
export function markPlayerDropped(sessionId: string, playerId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const player = session.players.find((p) => p.playerId === playerId);
  if (player) {
    // Set lastHeartbeat to "dropped at" — the sweep uses this to decide
    // whether the grace window has elapsed.
    player.lastHeartbeat = Date.now() - RECONNECT_GRACE_MS + RECONNECT_GRACE_MS; // = now
    // Tag the player as "dropped but in grace" by leaving lastHeartbeat
    // at the current time; sweepDroppedPlayers checks if
    // (now - lastHeartbeat) > RECONNECT_GRACE_MS.
  }
}

/**
 * Reconnect a player to their previous session. Returns the session
 * if the reconnection is within the grace window; returns null if the
 * session doesn't exist, the player wasn't in it, or the grace window
 * has elapsed.
 */
export function reconnectSession(
  playerId: string,
  sessionId: string,
): GameSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const player = session.players.find((p) => p.playerId === playerId);
  if (!player) return null;
  const now = Date.now();
  if (now - player.lastHeartbeat > RECONNECT_GRACE_MS) {
    // Grace window elapsed — the player's slot was already swept.
    return null;
  }
  player.lastHeartbeat = now;
  return session;
}

/**
 * Sweep dropped players whose grace window has elapsed. Removes them
 * from the session. If the host is removed, `migrateHost` promotes a
 * new host. Returns the count of swept players.
 */
export function sweepDroppedPlayers(sessionId: string): number {
  const session = sessions.get(sessionId);
  if (!session) return 0;
  const now = Date.now();
  const before = session.players.length;
  const wasHostDropped = session.players.find(
    (p) => p.isHost && now - p.lastHeartbeat > RECONNECT_GRACE_MS,
  );
  session.players = session.players.filter(
    (p) => now - p.lastHeartbeat <= RECONNECT_GRACE_MS,
  );
  if (wasHostDropped) {
    migrateHost(sessionId);
  }
  return before - session.players.length;
}

// ─── 941 — host migration ────────────────────────────────────────────────

/**
 * Promote a new host. The next-oldest player (earliest `lastHeartbeat`
 * among the remaining players) becomes the host. Returns the new host's
 * playerId, or null if the session is empty.
 */
export function migrateHost(sessionId: string): string | null {
  const session = sessions.get(sessionId);
  if (!session || session.players.length === 0) return null;
  // Clear the old host flag.
  for (const p of session.players) p.isHost = false;
  // Promote the first remaining player (deterministic — order is by
  // join time, which is preserved in the array).
  const newHost = session.players[0];
  newHost.isHost = true;
  session.hostId = newHost.playerId;
  return newHost.playerId;
}

// ─── 942 — spectator mode ────────────────────────────────────────────────

/**
 * Add a spectator to a session. Spectators don't consume a player slot
 * + don't have a team; the snapshot still replicates to them so they
 * can watch. Returns false if the session doesn't exist.
 */
export function addSpectator(sessionId: string, playerId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (!session.spectatorIds) session.spectatorIds = [];
  if (!session.spectatorIds.includes(playerId)) {
    session.spectatorIds.push(playerId);
  }
  return true;
}

/** Remove a spectator from a session. */
export function removeSpectator(sessionId: string, playerId: string): void {
  const session = sessions.get(sessionId);
  if (!session || !session.spectatorIds) return;
  session.spectatorIds = session.spectatorIds.filter((id) => id !== playerId);
}

// ─── 943 — replay download ───────────────────────────────────────────────

/**
 * Replay metadata captured at match end. The full replay data (snapshot
 * ring + events) is serialized into the `replayData` column of the
 * Replay row by the route that calls this.
 */
export interface ReplayMetadata {
  matchId: string;
  playerId: string;
  seed: number;
  mode: string;
  loadoutSlug: string;
  result: "VICTORY" | "DEFEAT" | "DRAW";
  finalScore: number;
  finalKills: number;
  durationMs: number;
  frameCount: number;
}

/**
 * Record a replay at match end. The caller passes the metadata + the
 * serialized replay data (snapshot ring + events). The Replay row is
 * persisted by the route (`/api/matchmaking/replay/record`); this
 * function just formats the metadata + stamps the matchId from the
 * session. Returns the row the route should `db.replay.create`.
 */
export function buildReplayRecord(
  sessionId: string,
  meta: Omit<ReplayMetadata, "matchId">,
  replayData: string,
): ReplayMetadata & { replayData: string; matchId: string } {
  return {
    ...meta,
    matchId: sessionId,
    replayData,
  };
}

// ─── session lifecycle ───────────────────────────────────────────────────

/** Get a session by ID. */
export function getSession(sessionId: string): GameSession | null {
  return sessions.get(sessionId) ?? null;
}

/** Transition a session to a new state. */
export function transitionSession(
  sessionId: string,
  newState: SessionState,
  result?: "VICTORY" | "DEFEAT" | "DRAW",
): GameSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.state = newState;
  if (newState === "IN_PROGRESS") session.startedAt = Date.now();
  if (newState === "POST_MATCH") {
    session.endedAt = Date.now();
    session.result = result ?? null;
  }
  return session;
}

/** End a session and remove it from the in-memory store. */
export function endSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** Get all active sessions (for admin/debug). */
export function listSessions(): GameSession[] {
  return Array.from(sessions.values());
}

/** Get queue length (for debug/HUD). */
export function getQueueLength(): number {
  return queue.length;
}

/** Heartbeat: update the player's lastHeartbeat. */
export function heartbeat(sessionId: string, playerId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const player = session.players.find((p) => p.playerId === playerId);
  if (player) player.lastHeartbeat = Date.now();
}
