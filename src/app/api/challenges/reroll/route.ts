import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { errorResponse, PLAYER_ID } from "@/lib/api";
const logger = createLogger("/api/challenges/reroll");
import { rerollChallenge } from "@/lib/game/Challenges";
import { debit, isEconomyFrozen } from "@/lib/game/meta/currency-guard";
import { db, ensureSeed } from "@/lib/api";
import { serializePlayer, serializeChallenge } from "@/lib/api";
import { challengeClaimSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";

/**
 * POST /api/challenges/reroll — re-roll one of the player's active daily
 * challenges for a fresh one from the pool.
 * Body: { challengeId: string }
 *
 * I-5000 #3861 — Challenge re-roll. The player pays 50 credits to
 * re-roll. The route debits via `currency-guard` (atomic), then calls
 * `rerollChallenge` (which deletes the old + creates the new in a
 * single transaction). The new challenge has a fresh target + progress
 * 0, preserving the original's `resetsAt` window.
 */
const REROLL_COST = 50;

export async function POST(req: NextRequest) {
  try {
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

    // I-5000 #3901 — economy freeze gate.
    const freeze = await isEconomyFrozen();
    if (freeze.frozen) {
      return errorResponse(freeze.reason ?? "Economy frozen", 423);
    }

    // Debit the reroll cost atomically.
    const debitResult = await debit(PLAYER_ID, REROLL_COST, "challenge_reroll", {
      itemSlug: parsed.data.challengeId,
    });
    if (!debitResult.ok) {
      return errorResponse(debitResult.message, debitResult.code === "insufficient" ? 400 : 500);
    }

    // Reroll the challenge (atomic delete + create).
    const result = await rerollChallenge(PLAYER_ID, parsed.data.challengeId);
    if (!result.rerolled || !result.newChallenge) {
      // Refund the debit — the reroll didn't happen.
      // Best-effort: re-credit + write a compensating receipt.
      try {
        const player = await db.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
        await db.player.update({
          where: { id: PLAYER_ID },
          data: { credits: player.credits + REROLL_COST },
        });
      } catch {
        /* best-effort refund */
      }
      return errorResponse("Challenge could not be rerolled (not found, already claimed, or pool exhausted)", 400);
    }

    const player = await db.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
    return NextResponse.json({
      player: serializePlayer(player),
      newChallenge: serializeChallenge(result.newChallenge),
      cost: REROLL_COST,
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "reroll failed" },
      { status: 500 },
    );
  }
}

export { REROLL_COST };
