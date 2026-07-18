import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, errorResponse, PLAYER_ID } from "@/lib/api";
const logger = createLogger("/api/battlepass/premium");
import {
  getActiveSeason,
  serializeBattlePass,
  serializePlayer,
} from "@/lib/api";
import {
  validatePurchase,
  debit,
} from "@/lib/game/meta/currency-guard";
import type { Player, PlayerBattlePass } from "@prisma/client";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * I-5000 #3809 — sentinel thrown inside the transaction when the request
 * is a safe retry (premium already active + original receipt found). The
 * outer catch returns the original receipt instead of a 4xx error.
 */
class IdempotentRetry extends Error {
  constructor(public readonly outcome: PremiumOutcome) {
    super("idempotent_retry");
    this.name = "IdempotentRetry";
  }
}

type PremiumOutcome = {
  player: Player;
  bp: PlayerBattlePass;
  receipt: {
    id: string;
    nonce: string;
    signature: string;
    amount: number;
    reason: string;
    itemSlug: string;
    ts: Date;
  };
};

/**
 * POST /api/battlepass/premium — server-authoritative premium pass purchase
 * (SEC11-META prompt 86).
 *
 * Hardening:
 *   1. Re-fetch balance + season.premiumPrice via `validatePurchase`.
 *   2. Atomic debit + `premium=true` update inside `db.$transaction`.
 *   3. Signed `CurrencyReceipt` row written in the same tx.
 *
 * Note: the season id is resolved once before the transaction (cheap read);
 * the season row is then re-read INSIDE the transaction via `tx` so the
 * premiumPrice is authoritative even if live-ops changed it between the
 * two reads.
 *
 * I-5000 #3809 / A-550 — idempotent retry. The prior code returned
 * `400 "Premium already active"` on a retry, which broke idempotency
 * (the client couldn't safely re-submit after a network blip). The fix:
 * when `bp.premium` is already true, the route returns the ORIGINAL
 * receipt (looked up by `reason="battlepass_premium"` + `itemSlug=seasonId`)
 * so the retry sees a successful response with the same receipt. The
 * player is NOT re-charged.
 */
export async function POST(_req: NextRequest) {
  try {
    await ensureSeed();
    const season = await getActiveSeason();

    let outcome: PremiumOutcome;
    try {
      outcome = await db.$transaction(async (tx) => {
        const player = await tx.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });

        const bp = await tx.playerBattlePass.upsert({
          where: { playerId_seasonId: { playerId: PLAYER_ID, seasonId: season.id } },
          update: {},
          create: {
            playerId: PLAYER_ID,
            seasonId: season.id,
            xp: 0,
            premium: false,
            claimedTiers: "[]",
            status: "ACTIVE",
          },
        });

        // I-5000 #3809 — idempotent retry. If premium is already active,
        // look up the original purchase receipt + return it (no re-charge).
        if (bp.premium) {
          const originalReceipt = await tx.currencyReceipt.findFirst({
            where: {
              playerId: PLAYER_ID,
              reason: "battlepass_premium",
              itemSlug: season.id,
            },
            orderBy: { ts: "desc" },
          });
          if (originalReceipt) {
            throw new IdempotentRetry(
              {
                player,
                bp,
                receipt: {
                  id: originalReceipt.id,
                  nonce: originalReceipt.nonce,
                  signature: originalReceipt.signature,
                  amount: originalReceipt.amount,
                  reason: originalReceipt.reason,
                  itemSlug: originalReceipt.itemSlug,
                  ts: originalReceipt.ts,
                },
              },
            );
          }
          // No original receipt found (data drift) — fall through to
          // the "already active" error path below.
          throw new HttpError(400, "Premium already active (no original receipt found)");
        }

        // Re-read the season inside the tx so premiumPrice is
        // authoritative even if live-ops changed it mid-flight.
        const seasonRow = await tx.battlePassSeason.findFirstOrThrow({
          where: { active: true },
          orderBy: { season: "desc" },
        });
        const price = seasonRow.premiumPrice;
        if (player.credits < price) {
          throw new HttpError(400, "Insufficient credits");
        }

        // Server-side validation pass (defence in depth — re-checks the
        // catalog price + balance even though we just read both).
        const validation = await validatePurchase(PLAYER_ID, "BATTLE_PASS_PREMIUM", seasonRow.id, {
          expectedPrice: price,
        });
        if (!validation.ok) {
          throw new HttpError(400, validation.message);
        }

        // Atomic debit + signed receipt.
        const debitResult = await debit(PLAYER_ID, price, "battlepass_premium", {
          tx,
          itemSlug: seasonRow.id,
        });
        if (!debitResult.ok) {
          throw new HttpError(
            debitResult.code === "insufficient" ? 400 : 500,
            debitResult.message,
          );
        }

        const updatedPlayer = await tx.player.update({
          where: { id: PLAYER_ID },
          data: { credits: debitResult.balanceAfter },
        });
        const updatedBp = await tx.playerBattlePass.update({
          where: { id: bp.id },
          data: { premium: true },
        });

        return { player: updatedPlayer, bp: updatedBp, receipt: debitResult.receipt };
      });
    } catch (err) {
      if (err instanceof IdempotentRetry) {
        outcome = err.outcome;
      } else if (err instanceof HttpError) {
        return errorResponse(err.message, err.status);
      } else {
        throw err;
      }
    }

    return NextResponse.json({
      player: serializePlayer(outcome.player),
      battlePass: serializeBattlePass(outcome.bp, season),
      receipt: {
        id: outcome.receipt.id,
        nonce: outcome.receipt.nonce,
        signature: outcome.receipt.signature,
        amount: outcome.receipt.amount,
        reason: outcome.receipt.reason,
        itemSlug: outcome.receipt.itemSlug,
        ts: outcome.receipt.ts.toISOString(),
      },
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Premium purchase failed" },
      { status: 500 },
    );
  }
}
