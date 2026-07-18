"use client";

/**
 * Prompt J-4035 / J-4129 — scoreboard.
 *
 * Data layer for the in-match scoreboard (Tab to view). The UI lives in
 * `src/components/game/hud/Scoreboard.tsx`.
 *
 * Design:
 *   - The scoreboard lists every player in the match (local + bots in
 *     the demo, plus squad-mates in a future MP build).
 *   - Per-player stats: kills, deaths, assists, score, ping, status.
 *   - Sorted by score desc; the local player is always pinned to the
 *     bottom row so they can find themselves quickly.
 *   - The engine publishes the live scoreboard to
 *     `window.__PR_SCOREBOARD__` each frame; this module is the schema
 *     + the read helpers.
 */

export interface ScoreboardEntry {
  /** Stable player ID (matches the engine's Player.id). */
  id: string;
  /** Display callsign. */
  callsign: string;
  /** Team — "player" | "enemy" | "ally". */
  team: "player" | "enemy" | "ally";
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  /** Network ping in ms (MP only; 0 in demo). */
  pingMs: number;
  /** Status — "alive" | "dead" | "spectating". */
  status: "alive" | "dead" | "spectating";
  /** True if this is the local player. */
  isLocal: boolean;
}

export interface ScoreboardData {
  entries: ScoreboardEntry[];
  /** Match time elapsed (seconds). */
  elapsedSec: number;
  /** Score limit (0 = no limit). */
  scoreLimit: number;
}

declare global {
  interface Window {
    __PR_SCOREBOARD__?: ScoreboardData;
  }
}

/** Read the current scoreboard data (or null if the engine hasn't published). */
export function getScoreboard(): ScoreboardData | null {
  if (typeof window === "undefined") return null;
  return window.__PR_SCOREBOARD__ ?? null;
}

/** Sort entries by score desc, then kills desc, then deaths asc. */
export function sortScoreboard(entries: ScoreboardEntry[]): ScoreboardEntry[] {
  return [...entries].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.deaths - b.deaths;
  });
}

/** Get the local player's entry (or null). */
export function getLocalEntry(data: ScoreboardData): ScoreboardEntry | null {
  return data.entries.find((e) => e.isLocal) ?? null;
}

/** Get the local player's rank (1-based) in the sorted scoreboard. */
export function getLocalRank(data: ScoreboardData): number {
  const sorted = sortScoreboard(data.entries);
  const local = sorted.findIndex((e) => e.isLocal);
  return local >= 0 ? local + 1 : 0;
}
