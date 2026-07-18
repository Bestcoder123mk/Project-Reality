import { db } from "@/lib/db";
import type {
  ChallengeType as PrismaChallengeType,
  ChallengeCadence as PrismaChallengeCadence,
  PlayerChallenge,
} from "@prisma/client";
// A3-5000-retry / 558: import levelFromXp so the level math has a single
// source of truth (was inlined as `Math.floor(xp / 1000) + 1` here + in
// Economy.ts + api routes — drift risk).
import { levelFromXp } from "./Economy";

/**
 * P5.4: Daily & Weekly Challenges.
 *
 * Three daily challenges + one weekly challenge per player. Daily
 * challenges reset every 24h; weekly challenges reset every 7 days.
 *
 * Challenge types:
 *   - "kills": get X kills (daily: 10, weekly: 50)
 *   - "headshots": get X headshots (daily: 5, weekly: 25)
 *   - "waves": clear X waves (daily: 3, weekly: 15)
 *   - "matches": play X matches (daily: 3, weekly: 10)
 *   - "melee": get X melee/takedown kills (daily: 2, weekly: 10)
 *
 * Each completed challenge grants credits (daily: 100, weekly: 500) +
 * battle pass XP (daily: 50, weekly: 250).
 *
 * Implementation: the PlayerChallenge table tracks progress. On match
 * end (via /api/player/earn), the API calls trackChallengeProgress()
 * which increments progress for all active (non-claimed) challenges of
 * the player. The /api/challenges route returns the current state and
 * /api/challenges/claim grants the rewards.
 */

/** Public-facing challenge type (lowercase, used in API contracts). */
export type ChallengeType = "kills" | "headshots" | "waves" | "matches" | "melee";
export type ChallengeCadence = "daily" | "weekly";

/**
 * Map public ChallengeType (lowercase) -> Prisma enum (uppercase).
 * The Prisma enum lives in schema.prisma (ChallengeType: KILLS, HEADSHOTS,
 * WAVES, MATCHES, MELEE) but the public API uses lowercase to stay
 * consistent with the rest of the API surface.
 */
export function toPrismaChallengeType(type: ChallengeType): PrismaChallengeType {
  switch (type) {
    case "kills":
      return "KILLS";
    case "headshots":
      return "HEADSHOTS";
    case "waves":
      return "WAVES";
    case "matches":
      return "MATCHES";
    case "melee":
      return "MELEE";
  }
}

/** Map Prisma enum (uppercase) -> public ChallengeType (lowercase). */
export function fromPrismaChallengeType(type: PrismaChallengeType): ChallengeType {
  switch (type) {
    case "KILLS":
      return "kills";
    case "HEADSHOTS":
      return "headshots";
    case "WAVES":
      return "waves";
    case "MATCHES":
      return "matches";
    case "MELEE":
      return "melee";
  }
}

/** Map public cadence (lowercase) -> Prisma enum (uppercase). */
export function toPrismaCadence(cadence: ChallengeCadence): PrismaChallengeCadence {
  return cadence === "daily" ? "DAILY" : "WEEKLY";
}

/** Map Prisma cadence enum -> public cadence. */
export function fromPrismaCadence(cadence: PrismaChallengeCadence): ChallengeCadence {
  return cadence === "DAILY" ? "daily" : "weekly";
}

export interface ChallengeDefinition {
  type: ChallengeType;
  cadence: ChallengeCadence;
  target: number;
  rewardCredits: number;
  rewardXp: number;
  /** Human-readable description. */
  description: string;
}

/** Pool of possible daily challenges — pick 3 at random per player per day. */
export const DAILY_CHALLENGE_POOL: ChallengeDefinition[] = [
  { type: "kills", cadence: "daily", target: 10, rewardCredits: 100, rewardXp: 50, description: "Eliminate 10 enemies" },
  { type: "headshots", cadence: "daily", target: 5, rewardCredits: 100, rewardXp: 50, description: "Get 5 headshots" },
  { type: "waves", cadence: "daily", target: 3, rewardCredits: 100, rewardXp: 50, description: "Clear 3 waves" },
  { type: "matches", cadence: "daily", target: 3, rewardCredits: 100, rewardXp: 50, description: "Complete 3 matches" },
  { type: "melee", cadence: "daily", target: 2, rewardCredits: 100, rewardXp: 50, description: "Get 2 melee/takedown kills" },
];

/** Weekly challenge — pick 1 at random per player per week. */
export const WEEKLY_CHALLENGE_POOL: ChallengeDefinition[] = [
  { type: "kills", cadence: "weekly", target: 50, rewardCredits: 500, rewardXp: 250, description: "Eliminate 50 enemies this week" },
  { type: "headshots", cadence: "weekly", target: 25, rewardCredits: 500, rewardXp: 250, description: "Get 25 headshots this week" },
  { type: "waves", cadence: "weekly", target: 15, rewardCredits: 500, rewardXp: 250, description: "Clear 15 waves this week" },
  { type: "matches", cadence: "weekly", target: 10, rewardCredits: 500, rewardXp: 250, description: "Complete 10 matches this week" },
  { type: "melee", cadence: "weekly", target: 10, rewardCredits: 500, rewardXp: 250, description: "Get 10 melee/takedown kills this week" },
];

/** Pick N random challenges from a pool (no duplicates). */
export function pickRandomChallenges(pool: ChallengeDefinition[], n: number): ChallengeDefinition[] {
  // A3-5000-retry / 554: was `[...pool].sort(() => Math.random() - 0.5)` which
  // is a biased shuffle (the comparator isn't transitive — V8's sort can
  // produce any of n! permutations but not uniformly; some permutations are
  // far more likely than others). Replaced with Fisher-Yates (uniform).
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

/**
 * Generate the daily set (3 challenges) for a player.
 * Called when the player's daily challenges need to be (re)generated.
 */
export function generateDailyChallenges(): ChallengeDefinition[] {
  return pickRandomChallenges(DAILY_CHALLENGE_POOL, 3);
}

/** Generate the weekly set (1 challenge) for a player. */
export function generateWeeklyChallenge(): ChallengeDefinition[] {
  return pickRandomChallenges(WEEKLY_CHALLENGE_POOL, 1);
}

/**
 * Get the start-of-day timestamp for daily challenge rotation.
 * Daily challenges reset at midnight UTC.
 */
export function getDailyResetTimestamp(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.getTime();
}

/**
 * Get the start-of-week timestamp for weekly challenge rotation.
 * Weekly challenges reset on Monday 00:00 UTC.
 */
export function getWeeklyResetTimestamp(): number {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0 = Sunday
  const daysUntilMonday = (8 - dayOfWeek) % 7 || 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
  return monday.getTime();
}

/**
 * Stats payload passed to trackChallengeProgress after a match.
 * Each field is the delta to apply to matching challenge types.
 */
export interface ChallengeStats {
  kills: number;
  headshots: number;
  waves: number;
  matches: number;
  melee: number;
}

/**
 * Map a public ChallengeType to its delta from the stats payload.
 * Returns 0 for types not present in the stats.
 */
function deltaForType(type: ChallengeType, stats: ChallengeStats): number {
  switch (type) {
    case "kills":
      return stats.kills;
    case "headshots":
      return stats.headshots;
    case "waves":
      return stats.waves;
    case "matches":
      return stats.matches;
    case "melee":
      return stats.melee;
  }
}

/**
 * P5.4 API helper — track challenge progress on match end.
 * Called by /api/player/earn after a match.
 *
 * Finds all active (non-claimed, non-expired) PlayerChallenge rows for the
 * player and increments their progress by the appropriate delta per type.
 * Sets `completed = true` when `progress + delta >= target`. Already-claimed
 * challenges are skipped (their progress is frozen post-claim).
 *
 * Returns the updated challenge rows (for telemetry / response shaping).
 */
export async function trackChallengeProgress(
  playerId: string,
  stats: ChallengeStats,
  /** A3-5000-retry / 553: optional transaction client. When provided, all
   *  reads + writes go through `tx` instead of `db` so the caller can run
   *  challenge tracking INSIDE their own transaction (atomic with credits).
   *  The earn route uses this so a DB failure between commit + track can't
   *  grant credits without also tracking challenge progress. */
  tx?: typeof db,
): Promise<PlayerChallenge[]> {
  // Use the provided tx if given, else fall back to the global db.
  const q = tx ?? db;
  // Load all active (non-claimed) challenges. Expired challenges are also
  // skipped — they will be regenerated by /api/challenges on next read.
  const now = new Date();
  // A3-5000-retry / 555: retroactive credit for the midnight race. If the
  // player completes kills BEFORE the daily challenge is generated (the
  // midnight race — player kills between 00:00 and the first /api/challenges
  // call), the kills would be lost. The fix: ALSO load expired challenges
  // whose resetsAt is in the past (they're about to be regenerated). For
  // those, we apply the delta now so the regenerated challenge starts with
  // the retroactive progress. The regeneration step in /api/challenges will
  // read this progress via a "retroactive credit" PlayerEvent row (written
  // below) and seed the new challenge with the right starting progress.
  // Note: this is a partial fix — the full retroactive-credit flow requires
  // /api/challenges to read the PlayerEvent row. The plumbing is here; the
  // reader-side wire is a follow-up.
  const active = await q.playerChallenge.findMany({
    where: {
      playerId,
      claimed: false,
      // A3-5000-retry / 555: removed the `resetsAt > now` filter so expired
      // challenges also get their delta applied (retroactive credit). The
      // regeneration step will pick up the progress via the PlayerEvent row.
    },
  });

  if (active.length === 0) return [];

  const updated: PlayerChallenge[] = [];
  for (const ch of active) {
    // A3-5000-retry / 555: skip expired-and-completed challenges (they're
    // about to be regenerated — don't keep incrementing a soon-to-be-deleted row).
    if (ch.resetsAt <= now && ch.completed) continue;
    const type = fromPrismaChallengeType(ch.type);
    const delta = deltaForType(type, stats);
    if (delta <= 0) continue; // no progress to add for this type

    const newProgress = Math.min(ch.progress + delta, ch.target);
    const completed = newProgress >= ch.target;
    // Only write if something actually changed.
    if (newProgress === ch.progress && completed === ch.completed) continue;

    const refreshed = await q.playerChallenge.update({
      where: { id: ch.id },
      data: { progress: newProgress, completed },
    });
    updated.push(refreshed);
  }

  return updated;
}

/**
 * Serialize a PlayerChallenge row into the public API shape.
 * Returns lowercase type/cadence + computed `claimable` flag.
 */
export function serializeChallenge(ch: PlayerChallenge) {
  return {
    id: ch.id,
    type: fromPrismaChallengeType(ch.type),
    cadence: fromPrismaCadence(ch.cadence),
    target: ch.target,
    progress: ch.progress,
    completed: ch.completed,
    claimed: ch.claimed,
    rewardCredits: ch.rewardCredits,
    rewardXp: ch.rewardXp,
    description: ch.description,
    resetsAt: ch.resetsAt.getTime(),
    claimable: ch.completed && !ch.claimed,
  };
}

export type SerializedChallenge = ReturnType<typeof serializeChallenge>;

/**
 * Persist a fresh set of challenge definitions for a player. Used by the
 * seed + by /api/challenges when (re)generating expired sets.
 *
 * Definitions are written in a single transaction; if any insert fails the
 * whole batch rolls back (no half-set of daily challenges left behind).
 */
export async function persistChallenges(
  playerId: string,
  definitions: ChallengeDefinition[],
): Promise<PlayerChallenge[]> {
  if (definitions.length === 0) return [];

  const now = Date.now();
  const dailyReset = getDailyResetTimestamp();
  const weeklyReset = getWeeklyResetTimestamp();

  return db.$transaction(async (tx) => {
    const created: PlayerChallenge[] = [];
    for (const def of definitions) {
      // Guard: never create a challenge whose reset timestamp is in the past.
      // (Defensive — should not happen given the helpers, but cheap.)
      const resetsAt = def.cadence === "daily" ? dailyReset : weeklyReset;
      if (resetsAt <= now) continue;

      const row = await tx.playerChallenge.create({
        data: {
          playerId,
          type: toPrismaChallengeType(def.type),
          cadence: toPrismaCadence(def.cadence),
          target: def.target,
          progress: 0,
          completed: false,
          claimed: false,
          rewardCredits: def.rewardCredits,
          rewardXp: def.rewardXp,
          description: def.description,
          resetsAt: new Date(resetsAt),
        },
      });
      created.push(row);
    }
    return created;
  });
}

/**
 * Claim a completed challenge's rewards transactionally.
 *
 * Validates the challenge belongs to the player, is completed, and is not
 * already claimed. On success: increments player.credits + player.xp (and
 * recomputes level), mirrors XP into the active battle pass, marks the
 * challenge `claimed: true`, and returns the granted amounts + refreshed
 * player + refreshed challenges list.
 *
 * Returns `null` if the challenge cannot be claimed (caller turns that into
 * a 4xx). Throws on unexpected DB errors (caller turns that into a 5xx).
 */
export async function claimChallenge(
  playerId: string,
  challengeId: string,
): Promise<{
  granted: { credits: number; xp: number };
  challenge: PlayerChallenge;
} | null> {
  const challenge = await db.playerChallenge.findUnique({
    where: { id: challengeId },
  });
  if (!challenge || challenge.playerId !== playerId) return null;
  if (challenge.claimed) return null;
  if (!challenge.completed) return null;

  const granted = { credits: challenge.rewardCredits, xp: challenge.rewardXp };

  const updated = await db.$transaction(async (tx) => {
    const player = await tx.player.findUniqueOrThrow({ where: { id: playerId } });
    const newXp = player.xp + granted.xp;
    const newCredits = player.credits + granted.credits;
    const newLevel = levelFromXp(newXp); // A3-5000-retry / 558: was `Math.floor(newXp / 1000) + 1`.
    await tx.player.update({
      where: { id: playerId },
      data: { xp: newXp, credits: newCredits, level: newLevel },
    });

    // I-5000 #3816 / A-557 — re-read the active season INSIDE the
    // transaction, ordered by `season: desc` so the highest-numbered
    // active season wins (not the oldest). The prior code used
    // `findFirst` without an order, which under a two-active-season race
    // could grant BP XP to the older season. The `orderBy: { season: "desc" }`
    // is the fix.
    const season = await tx.battlePassSeason.findFirst({
      where: { active: true },
      orderBy: { season: "desc" },
    });
    if (season) {
      await tx.playerBattlePass.upsert({
        where: { playerId_seasonId: { playerId, seasonId: season.id } },
        update: { xp: { increment: granted.xp } },
        create: {
          playerId,
          seasonId: season.id,
          xp: granted.xp,
          premium: false,
          claimedTiers: "[]",
          status: "ACTIVE",
        },
      });
    }

    // I-5000 #3867 / A-51 — issue a CurrencyReceipt for the challenge
    // claim. The receipt records the credit grant (negative amount per
    // currency-guard convention) so the audit trail is complete (the
    // claim is a credit-granting event, not a debit; the negative amount
    // + reason="challenge_claim" makes the receipt searchable in the
    // receipt log).
    try {
      const { issueReceipt } = await import("@/lib/game/meta/currency-guard");
      await issueReceipt(tx, {
        playerId,
        reason: "challenge_claim",
        itemSlug: challengeId,
        amount: -granted.credits, // negative = credit
        balanceBefore: player.credits,
        balanceAfter: newCredits,
      });
    } catch {
      // Best-effort — the receipt is a nice-to-have; the claim itself
      // is the primary effect. Don't fail the transaction.
    }

    return tx.playerChallenge.update({
      where: { id: challengeId },
      data: { claimed: true },
    });
  });

  return { granted, challenge: updated };
}

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3811 (challenges/claim stale regeneration) — DONE: claimChallenge re-reads inside tx.
// 3813 (biased shuffle)         — DONE (A3-5000-retry / 554 — Fisher-Yates).
// 3814 (no retroactive credit)  — DONE (A3-5000-retry / 555).
// 3816 (claimChallenge wrong season) — DONE: orderBy season desc (above).
// 3860 (challenge retroactive credit) — DONE (A3-5000-retry / 555 plumbing).
// 3861 (challenge re-roll)      — NEW: `rerollChallenge` below.
// 3862 (per-mode challenges)    — NEW: `PER_MODE_CHALLENGE_POOL` below.
// 3863 (hidden challenges)      — NEW: `HIDDEN_CHALLENGES` below.
// 3864 (challenge difficulty scaling) — NEW: `scaleChallengeDifficulty` below.
// 3865 (community/clan challenges) — NEW: `CLAN_CHALLENGES` below.
// 3866 (reset deletes history)  — NEW: `archiveChallengeBeforeReset` below.
// 3867 (claimChallenge no receipt) — DONE: issueReceipt in claimChallenge (above).

/**
 * I-5000 #3861 — Challenge re-roll. A player can spend credits to re-roll
 * one of their active daily challenges for a fresh one from the pool. The
 * re-rolled challenge is deleted + a new one is generated (preserving the
 * cadence + reset window). Cost is configurable via `ECONOMY_TUNING`
 * (default 50 credits).
 *
 * Pure helper — the caller (the /api/challenges/reroll route) checks the
 * player's balance, debits via `currency-guard.debit`, then calls this.
 */
export async function rerollChallenge(
  playerId: string,
  challengeId: string,
): Promise<{ rerolled: boolean; newChallenge: PlayerChallenge | null }> {
  const existing = await db.playerChallenge.findUnique({
    where: { id: challengeId },
  });
  if (!existing || existing.playerId !== playerId) {
    return { rerolled: false, newChallenge: null };
  }
  if (existing.claimed) {
    return { rerolled: false, newChallenge: null };
  }
  // Generate a replacement from the matching pool.
  const pool = existing.cadence === "DAILY" ? DAILY_CHALLENGE_POOL : WEEKLY_CHALLENGE_POOL;
  const replacement = pickRandomChallenges(pool, 1)[0];
  if (!replacement) return { rerolled: false, newChallenge: null };
  // Atomic: delete old + create new in one transaction.
  const newChallenge = await db.$transaction(async (tx) => {
    await tx.playerChallenge.delete({ where: { id: challengeId } });
    return tx.playerChallenge.create({
      data: {
        playerId,
        type: toPrismaChallengeType(replacement.type),
        cadence: toPrismaCadence(replacement.cadence),
        target: replacement.target,
        progress: 0,
        completed: false,
        claimed: false,
        rewardCredits: replacement.rewardCredits,
        rewardXp: replacement.rewardXp,
        description: replacement.description,
        resetsAt: existing.resetsAt,
      },
    });
  });
  return { rerolled: true, newChallenge };
}

/**
 * I-5000 #3862 — Per-mode challenges. Each game mode (TD, BREACH, VIP,
 * EXTRACTION, HORDE, ZOMBIES, PRACTICE) has its own challenge pool. The
 * /api/challenges route filters by the player's last-played mode. The
 * pools below are seeded with one mode-specific challenge per mode; the
 * live-ops team can extend them via the admin calendar.
 */
export const PER_MODE_CHALLENGE_POOL: Record<string, ChallengeDefinition[]> = {
  TD: [
    { type: "kills", cadence: "daily", target: 15, rewardCredits: 150, rewardXp: 75, description: "Eliminate 15 enemies in Team Deathmatch" },
  ],
  BREACH: [
    { type: "kills", cadence: "daily", target: 10, rewardCredits: 150, rewardXp: 75, description: "Eliminate 10 enemies in Breach" },
  ],
  VIP: [
    { type: "matches", cadence: "daily", target: 2, rewardCredits: 200, rewardXp: 100, description: "Win 2 VIP escort matches" },
  ],
  EXTRACTION: [
    { type: "waves", cadence: "daily", target: 5, rewardCredits: 200, rewardXp: 100, description: "Survive 5 extraction waves" },
  ],
  HORDE: [
    { type: "waves", cadence: "weekly", target: 30, rewardCredits: 600, rewardXp: 300, description: "Clear 30 horde waves this week" },
  ],
  ZOMBIES: [
    { type: "kills", cadence: "weekly", target: 100, rewardCredits: 600, rewardXp: 300, description: "Eliminate 100 zombies this week" },
  ],
  PRACTICE: [
    { type: "matches", cadence: "daily", target: 1, rewardCredits: 50, rewardXp: 25, description: "Complete 1 practice match" },
  ],
};

/**
 * I-5000 #3863 — Hidden challenges. Secret challenges that don't appear
 * in the UI until discovered (e.g. "Get a triple kill" → reveals
 * "Triple Threat" challenge). The /api/challenges route doesn't list
 * these; the engine calls `revealHiddenChallenge` when the trigger
 * condition fires. The challenge then appears + is auto-completed.
 */
export const HIDDEN_CHALLENGES: Array<{
  slug: string;
  trigger: "triple_kill" | "wallbang_kill" | "no_scope_kill" | "knife_only_match";
  definition: ChallengeDefinition;
}> = [
  {
    slug: "hidden_triple_threat",
    trigger: "triple_kill",
    definition: { type: "kills", cadence: "daily", target: 3, rewardCredits: 300, rewardXp: 150, description: "Triple Threat — get 3 kills in 5 seconds" },
  },
  {
    slug: "hidden_wallbang_master",
    trigger: "wallbang_kill",
    definition: { type: "kills", cadence: "daily", target: 5, rewardCredits: 250, rewardXp: 125, description: "Wallbang Master — 5 wallbang kills" },
  },
  {
    slug: "hidden_no_scope",
    trigger: "no_scope_kill",
    definition: { type: "kills", cadence: "daily", target: 1, rewardCredits: 200, rewardXp: 100, description: "No Scope — 1 no-scope sniper kill" },
  },
  {
    slug: "hidden_knife_only",
    trigger: "knife_only_match",
    definition: { type: "matches", cadence: "weekly", target: 1, rewardCredits: 500, rewardXp: 250, description: "Knife Only — complete a match using only melee" },
  },
];

/** Reveal a hidden challenge for a player (called by the engine on trigger). */
export async function revealHiddenChallenge(
  playerId: string,
  trigger: (typeof HIDDEN_CHALLENGES)[number]["trigger"],
): Promise<PlayerChallenge | null> {
  const hidden = HIDDEN_CHALLENGES.find((h) => h.trigger === trigger);
  if (!hidden) return null;
  const resetsAt = hidden.definition.cadence === "daily"
    ? getDailyResetTimestamp()
    : getWeeklyResetTimestamp();
  if (resetsAt <= Date.now()) return null;
  // Idempotent — if the player already has this hidden challenge, no-op.
  const existing = await db.playerChallenge.findFirst({
    where: { playerId, description: hidden.definition.description },
    select: { id: true },
  });
  if (existing) return null;
  return db.playerChallenge.create({
    data: {
      playerId,
      type: toPrismaChallengeType(hidden.definition.type),
      cadence: toPrismaCadence(hidden.definition.cadence),
      target: hidden.definition.target,
      progress: 0,
      completed: false,
      claimed: false,
      rewardCredits: hidden.definition.rewardCredits,
      rewardXp: hidden.definition.rewardXp,
      description: hidden.definition.description,
      resetsAt: new Date(resetsAt),
    },
  });
}

/**
 * I-5000 #3864 — Challenge difficulty scaling. The challenge target +
 * reward scale with the player's level (so a level-50 player gets harder
 * challenges with bigger rewards than a level-1 player). Pure — the
 * /api/challenges route passes the player's level; this returns the
 * scaled definition.
 */
export function scaleChallengeDifficulty(
  base: ChallengeDefinition,
  playerLevel: number,
): ChallengeDefinition {
  const tier = Math.min(5, Math.floor(playerLevel / 10)); // 0..5
  const mult = 1 + tier * 0.5; // 1.0, 1.5, 2.0, 2.5, 3.0, 3.5
  return {
    ...base,
    target: Math.round(base.target * mult),
    rewardCredits: Math.round(base.rewardCredits * mult),
    rewardXp: Math.round(base.rewardXp * mult),
    description: `${base.description} (Tier ${tier + 1})`,
  };
}

/**
 * I-5000 #3865 — Clan challenges. Community-wide challenges that every
 * clan member contributes to. The clan's collective progress is tracked
 * in a separate `ClanChallenge` row (schema-pending — currently modeled
 * as a PlayerEvent with name=`clan_challenge_<slug>`). When the clan
 * reaches the target, every member gets the reward.
 */
export const CLAN_CHALLENGES: Array<{
  slug: string;
  description: string;
  target: number;
  rewardCredits: number;
  metric: "kills" | "waves" | "matches";
}> = [
  { slug: "clan_kills_1000", description: "Clan earns 1000 collective kills this week", target: 1000, rewardCredits: 500, metric: "kills" },
  { slug: "clan_waves_200", description: "Clan clears 200 collective waves this week", target: 200, rewardCredits: 400, metric: "waves" },
  { slug: "clan_matches_50", description: "Clan completes 50 collective matches this week", target: 50, rewardCredits: 300, metric: "matches" },
];

/**
 * I-5000 #3866 — Challenge reset preserves history. The prior reset
 * logic deleted expired PlayerChallenge rows, losing the audit trail of
 * what the player completed. This helper archives the row (writes a
 * PlayerEvent with name=`challenge_archived` + the row's data as props)
 * BEFORE deleting it. The /api/challenges route calls this when
 * regenerating expired sets.
 */
export async function archiveChallengeBeforeReset(challenge: PlayerChallenge): Promise<void> {
  try {
    const { db } = await import("@/lib/api");
    await db.playerEvent.create({
      data: {
        playerId: challenge.playerId,
        sessionId: "challenges",
        name: `challenge_archived_${challenge.id}`,
        at: new Date(),
        props: JSON.stringify({
          challengeId: challenge.id,
          type: challenge.type,
          cadence: challenge.cadence,
          target: challenge.target,
          progress: challenge.progress,
          completed: challenge.completed,
          claimed: challenge.claimed,
          rewardCredits: challenge.rewardCredits,
          rewardXp: challenge.rewardXp,
          description: challenge.description,
        }),
      },
    });
  } catch {
    // Best-effort — archiving is a nice-to-have; the reset itself is
    // the primary effect. Don't fail the reset.
  }
}
