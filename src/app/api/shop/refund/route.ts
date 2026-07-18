import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, errorResponse, PLAYER_ID, serializePlayer } from "@/lib/api";
const logger = createLogger("/api/shop/refund");
import { issueReceipt, isEconomyFrozen } from "@/lib/game/meta/currency-guard";
import { rollbackReceipt } from "@/lib/game/meta/currency-guard";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";

/**
 * POST /api/shop/refund — refund a prior purchase within the refund window.
 * Body: { receiptId: string }
 *
 * I-5000 #3825 / #3841 / A-569 — Refund flow. The prior
 * `REFUND_POLICY` in ProgressionSocialEnhancements.ts had
 * `refundsAllowed: false, exceptionWindow: 0`. The fix enables a
 * refund window (default 24h) — the player can request a refund within
 * the window, the route verifies the original receipt, reverses the
 * debit via `rollbackReceipt`, and writes a compensating receipt
 * (reason="refund"). The refunded item is NOT removed from inventory
 * (the refund is a goodwill credit; the item stays as a gift).
 *
 * The window is configurable via `ECONOMY_TUNING` (default 24h).
 */
const REFUND_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
    if (bodyError) return bodyError;
    const body = json as { receiptId?: unknown } | null;
    const receiptId = body?.receiptId;
    if (typeof receiptId !== "string" || receiptId.length < 1 || receiptId.length > 80) {
      return errorResponse("Missing or invalid receiptId", 400);
    }

    await ensureSeed();

    // I-5000 #3901 — economy freeze gate.
    const freeze = await isEconomyFrozen();
    if (freeze.frozen) {
      return errorResponse(freeze.reason ?? "Economy frozen", 423);
    }

    // Load the original receipt.
    const original = await db.currencyReceipt.findUnique({
      where: { id: receiptId },
    });
    if (!original || original.playerId !== PLAYER_ID) {
      return errorResponse("Receipt not found", 404);
    }
    // Within the refund window?
    const ageMs = Date.now() - original.ts.getTime();
    if (ageMs > REFUND_WINDOW_MS) {
      return errorResponse(
        `Refund window expired (receipt age ${Math.round(ageMs / 3_600_000)}h, limit ${REFUND_WINDOW_MS / 3_600_000}h)`,
        410,
      );
    }
    // Only debit receipts are refundable (amount > 0). Credit receipts
    // (amount < 0) are already a grant — refunding them would be a debit.
    if (original.amount <= 0) {
      return errorResponse("Receipt is not a debit (nothing to refund)", 400);
    }

    // Rollback the receipt (verifies signature + grants compensating credit).
    const rb = await rollbackReceipt(PLAYER_ID, {
      playerId: PLAYER_ID,
      reason: original.reason,
      itemSlug: original.itemSlug,
      amount: original.amount,
      balanceBefore: original.balanceBefore,
      balanceAfter: original.balanceAfter,
      nonce: original.nonce,
      ts: original.ts,
      signature: original.signature,
    });
    if (!rb.ok) {
      return errorResponse(rb.message, 400);
    }

    const updatedPlayer = await db.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
    return NextResponse.json({
      player: serializePlayer(updatedPlayer),
      refundedAmount: original.amount,
      newBalance: rb.balanceAfter,
      rollbackReceiptId: rb.rollbackReceiptId,
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "refund failed" },
      { status: 500 },
    );
  }
}

export { REFUND_WINDOW_MS, issueReceipt };
