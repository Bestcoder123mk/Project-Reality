import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, PLAYER_ID } from "@/lib/api";
const logger = createLogger("/api/challenges");
import {
  generateDailyChallenges,
  generateWeeklyChallenge,
  getDailyResetTimestamp,
  getWeeklyResetTimestamp,
  persistChallenges,
  serializeChallenge,
} from "@/lib/game/Challenges";
import type { ChallengeCadence as PrismaCadence } from "@prisma/client";

/**
 * GET /api/challenges
 *
 * Returns the player's active daily (3) + weekly (1) challenges with their
 * current progress, completed/claimed status, and reset timestamps. If the
 * player has no challenges yet (or a cadence has fully expired), fresh ones
 * are generated + persisted before returning.
 *
 * Response shape:
 *   {
 *     daily:   SerializedChallenge[],  // length 3
 *     weekly:  SerializedChallenge[],  // length 1
 *     dailyResetAt:  number,           // ms epoch
 *     weeklyResetAt: number,           // ms epoch
 *   }
 */
export async function GET() {
  try {
    await ensureSeed();

    const now = new Date();

    // Load all challenge rows for the player, split by cadence.
    const all = await db.playerChallenge.findMany({
      where: { playerId: PLAYER_ID },
      orderBy: { createdAt: "asc" },
    });

    const active = all.filter((c) => c.resetsAt > now);
    const expired = all.filter((c) => c.resetsAt <= now);

    const activeDaily = active.filter((c) => c.cadence === "DAILY");
    const activeWeekly = active.filter((c) => c.cadence === "WEEKLY");

    // Delete expired rows (audit-free — the player can no longer claim them
    // anyway, and we don't want the table to grow unbounded across resets).
    if (expired.length > 0) {
      await db.playerChallenge.deleteMany({
        where: { id: { in: expired.map((c) => c.id) } },
      });
    }

    // Regenerate any missing cadence batch.
    if (activeDaily.length === 0) {
      await persistChallenges(PLAYER_ID, generateDailyChallenges());
    }
    if (activeWeekly.length === 0) {
      await persistChallenges(PLAYER_ID, generateWeeklyChallenge());
    }

    // Re-read fresh state (only if we changed anything; cheap either way).
    const finalRows = await db.playerChallenge.findMany({
      where: { playerId: PLAYER_ID, resetsAt: { gt: now } },
      orderBy: [{ cadence: "asc" }, { createdAt: "asc" }],
    });

    const daily = finalRows
      .filter((c) => c.cadence === "DAILY")
      .map(serializeChallenge);
    const weekly = finalRows
      .filter((c) => c.cadence === "WEEKLY")
      .map(serializeChallenge);

    return NextResponse.json({
      daily,
      weekly,
      dailyResetAt: nextResetFor(finalRows, "DAILY", getDailyResetTimestamp()),
      weeklyResetAt: nextResetFor(finalRows, "WEEKLY", getWeeklyResetTimestamp()),
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load challenges" },
      { status: 500 },
    );
  }
}

/**
 * Pick the earliest `resetsAt` among the rows of a given cadence. Falls back
 * to the freshly-computed next-reset timestamp when no rows exist (defensive
 * — shouldn't happen since we just persisted them).
 */
function nextResetFor(
  rows: { cadence: PrismaCadence; resetsAt: Date }[],
  cadence: PrismaCadence,
  fallback: number,
): number {
  const matching = rows.filter((r) => r.cadence === cadence);
  if (matching.length === 0) return fallback;
  return matching.reduce(
    (min, r) => (r.resetsAt.getTime() < min ? r.resetsAt.getTime() : min),
    matching[0].resetsAt.getTime(),
  );
}
