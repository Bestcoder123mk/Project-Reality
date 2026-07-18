/**
 * Section M — Map voting system.
 *
 * Between-match voting: each connected client casts a vote for one of
 * N candidate maps (sampled from the registry weighted by recent play
 * frequency — less-played maps get a small boost). The map with the
 * most votes is selected; ties broken by deterministic random.
 *
 * The vote state lives in a single in-memory store (single-player /
 * local co-op) and can be mirrored to Firestore for multiplayer (the
 * engine wires the sync — this module is the pure logic).
 *
 * Public API:
 *   - createVoteSession(candidates, deadline) — start a new vote.
 *   - castVote(sessionId, clientId, slug) — record a vote.
 *   - tallyVotes(sessionId) — read-only tally.
 *   - resolveVote(sessionId) — pick the winner + close the session.
 *   - getCandidateSet(mapSlugs, recentHistory) — sample N candidates
 *     weighted by recency (less-played maps boosted).
 *   - subscribe(sessionId, cb) — live tally updates (single-process).
 *
 * Pure TypeScript (no THREE) so safe to import from SSR / Cloud Functions.
 */

import type { MapDefinition } from "./MapRegistry";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface VoteSession {
  id: string;
  /** Candidate maps in the vote (slug + display info). */
  candidates: Array<{ slug: string; name: string; description: string; biome?: string }>;
  /** Maps clientId → slug they voted for. */
  votes: Map<string, string>;
  /** Wall-clock deadline (ms). After this, the session is closed. */
  deadline: number;
  /** Whether the session is still open. */
  open: boolean;
  /** Winning slug (set by resolveVote). */
  winner?: string;
  /** Tiebreaker seed (deterministic). */
  seed: number;
}

export interface VoteTally {
  sessionId: string;
  /** Per-candidate vote count (sorted desc). */
  counts: Array<{ slug: string; name: string; count: number }>;
  /** Total votes cast. */
  total: number;
  /** Number of candidates. */
  candidateCount: number;
  /** Time remaining (ms) — negative if expired. */
  timeRemaining: number;
  open: boolean;
  winner?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory session store (single-process). For multiplayer, mirror this
// to a Firestore collection (sessionId → VoteSession) and have each client
// subscribe to the doc.
// ──────────────────────────────────────────────────────────────────────────

const SESSIONS = new Map<string, VoteSession>();
const SUBSCRIBERS = new Map<string, Set<(t: VoteTally) => void>>();

// ──────────────────────────────────────────────────────────────────────────
// Session lifecycle
// ──────────────────────────────────────────────────────────────────────────

let _sessionIdCounter = 1;

/** Start a new vote session. Candidates is the shortlist of maps to
 *  vote on (typically 3–5). */
export function createVoteSession(
  candidates: Array<{ slug: string; name: string; description: string; biome?: string }>,
  durationMs: number,
  seed = Date.now(),
): VoteSession {
  const id = `vote-${_sessionIdCounter++}`;
  const session: VoteSession = {
    id,
    candidates,
    votes: new Map(),
    deadline: Date.now() + durationMs,
    open: true,
    seed,
  };
  SESSIONS.set(id, session);
  SUBSCRIBERS.set(id, new Set());
  return session;
}

/** Cast a vote. Returns true if the vote was accepted (client hasn't
 *  voted before, session is open, slug is a valid candidate). */
export function castVote(sessionId: string, clientId: string, slug: string): boolean {
  const session = SESSIONS.get(sessionId);
  if (!session || !session.open) return false;
  if (Date.now() > session.deadline) {
    session.open = false;
    return false;
  }
  const valid = session.candidates.some((c) => c.slug === slug);
  if (!valid) return false;
  // Each client can only vote once.
  if (session.votes.has(clientId)) {
    // Allow changing vote (re-vote). Comment out to lock vote.
    session.votes.set(clientId, slug);
    notify(session);
    return true;
  }
  session.votes.set(clientId, slug);
  notify(session);
  return true;
}

/** Read-only tally. Pure function. */
export function tallyVotes(sessionId: string): VoteTally | null {
  const session = SESSIONS.get(sessionId);
  if (!session) return null;
  const counts = session.candidates.map((c) => ({
    slug: c.slug, name: c.name, count: 0,
  }));
  for (const slug of session.votes.values()) {
    const entry = counts.find((c) => c.slug === slug);
    if (entry) entry.count++;
  }
  counts.sort((a, b) => b.count - a.count);
  return {
    sessionId,
    counts,
    total: session.votes.size,
    candidateCount: session.candidates.length,
    timeRemaining: session.deadline - Date.now(),
    open: session.open,
    winner: session.winner,
  };
}

/** Resolve a vote session — picks the winner (highest count, ties
 *  broken by deterministic seed), closes the session, returns the
 *  winning slug. Returns null if the session doesn't exist. */
export function resolveVote(sessionId: string): string | null {
  const session = SESSIONS.get(sessionId);
  if (!session) return null;
  session.open = false;
  const tally = tallyVotes(sessionId);
  if (!tally) return null;
  if (tally.total === 0) {
    // No votes — pick a random candidate (deterministic).
    const idx = session.seed % session.candidates.length;
    session.winner = session.candidates[idx].slug;
  } else {
    // Highest count wins; ties broken by deterministic random.
    const top = tally.counts[0];
    const tied = tally.counts.filter((c) => c.count === top.count);
    if (tied.length === 1) {
      session.winner = top.slug;
    } else {
      const idx = session.seed % tied.length;
      session.winner = tied[idx].slug;
    }
  }
  notify(session);
  return session.winner;
}

/** Cancel a vote session (admin / host action). */
export function cancelVoteSession(sessionId: string): void {
  const session = SESSIONS.get(sessionId);
  if (session) {
    session.open = false;
    notify(session);
  }
}

/** Get a session by id. */
export function getVoteSession(sessionId: string): VoteSession | undefined {
  return SESSIONS.get(sessionId);
}

/** Clear all sessions (called on server reset). */
export function clearVoteSessions(): void {
  SESSIONS.clear();
  SUBSCRIBERS.clear();
}

// ──────────────────────────────────────────────────────────────────────────
// Subscribe / unsubscribe (live tally)
// ──────────────────────────────────────────────────────────────────────────

export function subscribe(sessionId: string, cb: (t: VoteTally) => void): () => void {
  let subs = SUBSCRIBERS.get(sessionId);
  if (!subs) {
    subs = new Set();
    SUBSCRIBERS.set(sessionId, subs);
  }
  subs.add(cb);
  return () => subs!.delete(cb);
}

function notify(session: VoteSession): void {
  const tally = tallyVotes(session.id);
  if (!tally) return;
  const subs = SUBSCRIBERS.get(session.id);
  if (!subs) return;
  for (const cb of subs) cb(tally);
}

// ──────────────────────────────────────────────────────────────────────────
// Candidate sampling — recency-weighted
// ──────────────────────────────────────────────────────────────────────────

/** Sample N candidate maps from the registry weighted by recency.
 *  Maps that were played recently get a small penalty (so the same
 *  map doesn't show up vote after vote); less-played maps get a
 *  boost. The exact maps played in the last `recentWindow` matches
 *  are excluded from candidates entirely (forces variety).
 *
 *  Pure function — exported for tests. */
export function getCandidateSet(
  allMaps: Array<{ slug: string; name: string; description: string; biome?: string }>,
  recentHistory: string[],
  count: number,
  seed = Date.now(),
): Array<{ slug: string; name: string; description: string; biome?: string }> {
  if (allMaps.length <= count) return [...allMaps];
  const recent = new Set(recentHistory.slice(-Math.floor(count * 0.5)));
  const eligible = allMaps.filter((m) => !recent.has(m.slug));
  const pool = eligible.length >= count ? eligible : allMaps;
  // Weighted random: less-recently-played = higher weight.
  const weights = pool.map((m) => {
    const lastIdx = recentHistory.lastIndexOf(m.slug);
    if (lastIdx < 0) return 2.0; // never played → boost
    const recency = recentHistory.length - lastIdx;
    return 0.5 + recency / Math.max(1, recentHistory.length);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  // Deterministic PRNG.
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const picked: number[] = [];
  const available = pool.map((_, i) => i);
  while (picked.length < count && available.length > 0) {
    let r = rng() * total;
    let idx = 0;
    while (idx < available.length && r > 0) {
      r -= weights[available[idx]];
      if (r > 0) idx++;
    }
    if (idx >= available.length) idx = available.length - 1;
    picked.push(available[idx]);
    available.splice(idx, 1);
  }
  return picked.map((i) => pool[i]);
}

/** Convenience: build a candidate set from the registry directly. */
export function buildCandidateSetFromRegistry(
  registry: MapDefinition[],
  recentHistory: string[],
  count: number,
  seed?: number,
): Array<{ slug: string; name: string; description: string; biome?: string }> {
  const maps = registry.map((m) => ({
    slug: m.slug, name: m.name, description: m.description,
    // @ts-expect-error — biome is an optional new field on MapDefinition.
    biome: m.biome,
  }));
  return getCandidateSet(maps, recentHistory, count, seed);
}

// ──────────────────────────────────────────────────────────────────────────
// Default voting flow (host-side orchestration helper)
// ──────────────────────────────────────────────────────────────────────────

/** Default voting flow: 30-second vote, 4 candidates, then resolve.
 *  Returns the winning slug + the session id (for the HUD). */
export function runDefaultVote(
  registry: MapDefinition[],
  recentHistory: string[],
  durationMs = 30_000,
  candidateCount = 4,
  seed = Date.now(),
): { sessionId: string; candidates: VoteSession["candidates"]; winner: string | null } {
  const candidates = buildCandidateSetFromRegistry(registry, recentHistory, candidateCount, seed);
  const session = createVoteSession(candidates, durationMs, seed);
  return {
    sessionId: session.id,
    candidates: session.candidates,
    winner: null, // resolved later when the deadline hits
  };
}
