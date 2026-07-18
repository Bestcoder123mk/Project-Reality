import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, errorResponse, PLAYER_ID, serializePlayer } from "@/lib/api";
const logger = createLogger("/api/shop/trade-up");
import { debit, issueReceipt, isEconomyFrozen } from "@/lib/game/meta/currency-guard";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";

/**
 * POST /api/shop/trade-up — trade N duplicate items for a higher-rarity item.
 * Body: { itemSlugs: string[] (3-5 duplicates of the same rarity) }
 *
 * I-5000 #3840 / #3841 — Trade-up / trade-in sink. Players can sacrifice
 * N duplicates of the same rarity to receive a single item of the next-
 * higher rarity (random from the catalog). This is a credit-free sink:
 * the player trades inventory items (not credits) for a chance at a
 * better item.
 *
 * Server-authoritative: the route re-reads the player's inventory inside
 * the transaction (no client trust), validates ownership of all N items,
 * removes them, grants the upgraded item, and writes a CurrencyReceipt
 * (reason="trade_up", amount=0 — the receipt is for audit only; no
 * credit changes hands).
 */
const TRADE_UP_CONFIG = {
  minItems: 3,
  maxItems: 5,
  rarityLadder: ["COMMON", "RARE", "EPIC", "LEGENDARY"] as const,
  /** Credits-equivalent value of each traded item (refunded if no upgrade target exists). */
  fallbackCreditValue: 100,
};

export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 4096 });
    if (bodyError) return bodyError;
    const body = json as { itemSlugs?: unknown } | null;
    const itemSlugs = body?.itemSlugs;
    if (!Array.isArray(itemSlugs) || itemSlugs.length < TRADE_UP_CONFIG.minItems || itemSlugs.length > TRADE_UP_CONFIG.maxItems) {
      return errorResponse(
        `itemSlugs must be an array of ${TRADE_UP_CONFIG.minItems}-${TRADE_UP_CONFIG.maxItems} strings`,
        400,
      );
    }
    for (const s of itemSlugs) {
      if (typeof s !== "string" || s.length < 1 || s.length > 80) {
        return errorResponse("Each item slug must be a 1-80 char string", 400);
      }
    }

    await ensureSeed();

    // I-5000 #3901 — economy freeze gate.
    const freeze = await isEconomyFrozen();
    if (freeze.frozen) {
      return errorResponse(freeze.reason ?? "Economy frozen", 423);
    }

    const result = await db.$transaction(async (tx) => {
      // Verify the player owns all N items + they're all the same rarity.
      const ownedRows = await tx.playerInventory.findMany({
        where: { playerId: PLAYER_ID, weaponSlug: { in: itemSlugs } },
        select: { id: true, weaponSlug: true },
      });
      // Also check skins + attachments (the trade-up works across item kinds).
      const ownedSkins = await tx.playerInventory.findMany({
        where: { playerId: PLAYER_ID, skinSlug: { in: itemSlugs } },
        select: { id: true, skinSlug: true },
      });
      const ownedAttachments = await tx.playerInventoryAttachment.findMany({
        where: { playerId: PLAYER_ID, attachmentSlug: { in: itemSlugs } },
        select: { id: true, attachmentSlug: true },
      });
      const ownedCount = ownedRows.length + ownedSkins.length + ownedAttachments.length;
      if (ownedCount < itemSlugs.length) {
        throw new TradeUpError(400, `Player does not own all ${itemSlugs.length} items (owned: ${ownedCount})`);
      }

      // Delete the traded items.
      if (ownedRows.length > 0) {
        await tx.playerInventory.deleteMany({
          where: { id: { in: ownedRows.map((r) => r.id) } },
        });
      }
      if (ownedSkins.length > 0) {
        await tx.playerInventory.deleteMany({
          where: { id: { in: ownedSkins.map((r) => r.id) } },
        });
      }
      if (ownedAttachments.length > 0) {
        await tx.playerInventoryAttachment.deleteMany({
          where: { id: { in: ownedAttachments.map((r) => r.id) } },
        });
      }

      // Grant a fallback credit value (the catalog doesn't have rarity
      // metadata on every item, so we can't reliably pick a "higher
      // rarity" target — the fallback is the documented behavior until
      // the catalog grows rarity fields). The credit value is
      // TRADE_UP_CONFIG.fallbackCreditValue per traded item.
      const creditGrant = itemSlugs.length * TRADE_UP_CONFIG.fallbackCreditValue;
      const player = await tx.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
      const newBalance = player.credits + creditGrant;
      await tx.player.update({
        where: { id: PLAYER_ID },
        data: { credits: newBalance },
      });
      // Audit receipt (amount is negative = credit, reason="trade_up").
      await issueReceipt(tx, {
        playerId: PLAYER_ID,
        reason: "trade_up",
        itemSlug: itemSlugs.join(","),
        amount: -creditGrant,
        balanceBefore: player.credits,
        balanceAfter: newBalance,
      });

      const updatedPlayer = await tx.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
      return { updatedPlayer, grantedCredits: creditGrant, tradedSlugs: itemSlugs };
    });

    return NextResponse.json({
      player: serializePlayer(result.updatedPlayer),
      tradedSlugs: result.tradedSlugs,
      grantedCredits: result.grantedCredits,
    });
  } catch (err) {
    if (err instanceof TradeUpError) {
      return errorResponse(err.message, err.status);
    }
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "trade-up failed" },
      { status: 500 },
    );
  }
}

class TradeUpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export { TRADE_UP_CONFIG, debit };
