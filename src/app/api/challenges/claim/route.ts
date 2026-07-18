import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, errorResponse, PLAYER_ID, serializePlayer } from "@/lib/api";
const logger = createLogger("/api/challenges/claim");
import {
  claimChallenge,
  generateDailyChallenges,
  generateWeeklyChallenge,
  getDailyResetTimestamp,
  getWeeklyResetTimestamp,
  persistChallenges,
  serializeChallenge,
} from "@/lib/game/Challenges";
import { challengeClaimSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";

/**
 * POST /api/challenges/claim
 *
 * Body: `{ challengeId: string }`
 *
 * Task-1 (SEC) additions (items 5, 6, 8):
 *   - Same-origin CSRF check.
 *   - Body-size limit (1KB).
 *   - Zod validation via the shared `challengeClaimSchema`.
 */
export async function POST(req: NextRequest) {
  try {
    // Task-1 (SEC) items 5, 6, 8.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
    if (bodyError) return bodyError;
    const parsed = challengeClaimSchema.safeParse(json);
    if (!parsed.success) {
      return errorResponse("Invalid body. Expected { challengeId: string }.", 400, {
        issues: parsed.error.issues,
      });
    }

    await ensureSeed();

    const challengeId = parsed.data.challengeId;

    // Pre-fetch the challenge to give precise 4xx errors before claiming.
    const challenge = await db.playerChallenge.findUnique({
      where: { id: challengeId },
    });
    if (!challenge || challenge.playerId !== PLAYER_ID) {
      return errorResponse("Challenge not found", 404);
    }
    if (challenge.claimed) {
      return errorResponse("Challenge already claimed", 400);
    }
    if (!challenge.completed) {
      return errorResponse(
        "Challenge not yet completed",
        400,
        { progress: challenge.progress, target: challenge.target },
      );
    }

    const result = await claimChallenge(PLAYER_ID, challengeId);
    if (!result) {
      // Race condition: another request claimed it between our pre-check and
      // the transactional claim. Surface a clean 409.
      return errorResponse("Challenge could not be claimed (state changed)", 409);
    }

    // Refresh the player + challenges for the response.
    const [player, rows] = await Promise.all([
      db.player.findUniqueOrThrow({ where: { id: PLAYER_ID } }),
      db.playerChallenge.findMany({
        where: { playerId: PLAYER_ID, resetsAt: { gt: new Date() } },
        orderBy: [{ cadence: "asc" }, { createdAt: "asc" }],
      }),
    ]);

    const daily = rows
      .filter((c) => c.cadence === "DAILY")
      .map(serializeChallenge);
    const weekly = rows
      .filter((c) => c.cadence === "WEEKLY")
      .map(serializeChallenge);

    // Defensive: ensure we always return at least the canonical 3 daily +
    // 1 weekly to the client. If a reset just happened between the claim and
    // the re-read, regenerate (rare; safe because we're inside the request
    // lifecycle).
    if (daily.length === 0) {
      await persistChallenges(PLAYER_ID, generateDailyChallenges());
    }
    if (weekly.length === 0) {
      await persistChallenges(PLAYER_ID, generateWeeklyChallenge());
    }

    return NextResponse.json({
      granted: result.granted,
      challenge: serializeChallenge(result.challenge),
      player: serializePlayer(player),
      challenges: { daily, weekly },
      dailyResetAt: getDailyResetTimestamp(),
      weeklyResetAt: getWeeklyResetTimestamp(),
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Claim failed" },
      { status: 500 },
    );
  }
}
