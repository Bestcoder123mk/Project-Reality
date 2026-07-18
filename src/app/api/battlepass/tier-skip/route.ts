import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, errorResponse, PLAYER_ID, getActiveSeason, getOrCreatePlayerBattlePass, serializeBattlePass, serializePlayer } from "@/lib/api";
const logger = createLogger("/api/battlepass/tier-skip");
import { computeTier, computeTierSkipCost } from "@/lib/api";
import { computeTierSkipCost as bpComputeTierSkipCost } from "@/lib/game/BattlePassSeasons";
import { debit } from "@/lib/game/meta/currency-guard";
import { isEconomyFrozen } from "@/lib/game/meta/currency-guard";
import { battlepassClaimSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";

/**
 * POST /api/battlepass/tier-skip — pay credits to skip forward N tiers.
 * Body: { toTier: positive int }
 *
 * I-5000 #3848 — Tier-skip purchase. The player pays credits to jump
 * from their current tier to `toTier` (skipping the XP grind). The
 * price is computed by `computeTierSkipCost` (per-tier + scales with
 * destination tier). The skip grants the XP needed to reach `toTier`
 * so the player can immediately claim the unlocked rewards.
 *
 * Server-authoritative: the route re-reads the player's current tier
 * inside the transaction (no client trust), debits via `currency-guard`,
 * and writes a CurrencyReceipt (reason="tier_skip") for the audit trail.
 */
export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
    if (bodyError) return bodyError;
    const parsed = battlepassClaimSchema.safeParse(json);
    if (!parsed.success) {
      return errorResponse("Invalid body. Expected { tier: positive int }.", 400, {
        issues: parsed.error.issues,
      });
    }

    await ensureSeed();

    // I-5000 #3901 — economy freeze gate.
    const freeze = await isEconomyFrozen();
    if (freeze.frozen) {
      return errorResponse(freeze.reason ?? "Economy frozen", 423);
    }

    const toTier = parsed.data.tier;
    const season = await getActiveSeason();
    if (!season) return errorResponse("No active season", 500);
    const bp = await getOrCreatePlayerBattlePass(season.id);
    const currentTier = computeTier(bp.xp, season.tierSize, season.maxTier);
    if (toTier <= currentTier) {
      return errorResponse(
        `toTier (${toTier}) must be greater than current tier (${currentTier})`,
        400,
      );
    }
    if (toTier > season.maxTier) {
      return errorResponse(`toTier (${toTier}) exceeds maxTier (${season.maxTier})`, 400);
    }
    const cost = bpComputeTierSkipCost(currentTier, toTier);

    const result = await db.$transaction(async (tx) => {
      // Re-read player + bp inside the tx (no client trust).
      const player = await tx.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
      if (player.credits < cost) {
        throw new TierSkipError(400, `Insufficient credits (need ${cost}, have ${player.credits})`);
      }
      const debitResult = await debit(PLAYER_ID, cost, "tier_skip", {
        tx,
        itemSlug: `tier_${currentTier}_to_${toTier}`,
      });
      if (!debitResult.ok) {
        throw new TierSkipError(
          debitResult.code === "insufficient" ? 400 : 500,
          debitResult.message,
        );
      }
      // Grant the XP needed to reach `toTier`.
      const targetXp = toTier * season.tierSize;
      const updatedBp = await tx.playerBattlePass.update({
        where: { id: bp.id },
        data: { xp: Math.max(bp.xp, targetXp) },
      });
      const updatedPlayer = await tx.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
      return { updatedBp, updatedPlayer, receipt: debitResult.receipt, cost, fromTier: currentTier };
    });

    return NextResponse.json({
      player: serializePlayer(result.updatedPlayer),
      battlePass: serializeBattlePass(result.updatedBp, season),
      skipped: { fromTier: result.fromTier, toTier, cost },
      receipt: {
        id: result.receipt.id,
        nonce: result.receipt.nonce,
        signature: result.receipt.signature,
        amount: result.receipt.amount,
        reason: result.receipt.reason,
        itemSlug: result.receipt.itemSlug,
        ts: result.receipt.ts.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof TierSkipError) {
      return errorResponse(err.message, err.status);
    }
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "tier-skip failed" },
      { status: 500 },
    );
  }
}

class TierSkipError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export { computeTierSkipCost };
