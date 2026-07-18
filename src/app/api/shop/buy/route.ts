import { NextResponse, type NextRequest } from "next/server";
import { db, ensureSeed, errorResponse, PLAYER_ID, getPlayerInventorySlugs } from "@/lib/api";
import {
  validatePurchase,
  debit,
  type CatalogKind,
} from "@/lib/game/meta/currency-guard";
import { shopBuySchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { createLogger } from "@/lib/logger";

const logger = createLogger("/api/shop/buy");
import { rateLimit, playerRateKey } from "@/lib/security/rate-limit";
import { issueNonce } from "@/lib/security/nonce";

type ItemType = "WEAPON" | "ATTACHMENT" | "SKIN" | "OPERATOR";

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Max inventory rows per kind — Task-1 (SEC) item 18 (server-side cap). */
const MAX_INVENTORY_PER_KIND = 200;

/** Purchase rate limit: 10 buys / player / minute. */
const BUY_RATE_LIMIT = { max: 10, windowMs: 60_000, label: "shop-buy" };

/**
 * POST /api/shop/buy — server-authoritative purchase (SEC11-META prompt 86).
 *
 * Hardening over the legacy flow:
 *   1. Re-fetch the player's balance server-side via `validatePurchase`
 *      (never trust client-sent balance).
 *   2. Validate the price against the catalog server-side — the catalog
 *      is the source of truth.
 *   3. Atomically debit + insert inventory inside `db.$transaction`.
 *   4. Write a signed `CurrencyReceipt` row (HMAC-SHA256 over
 *      `{playerId, reason, itemSlug, amount, balanceBefore, balanceAfter,
 *       nonce, ts}`).
 *   5. Task-1 (SEC): track the receipt nonce in `UsedNonce` so any
 *      follow-up action (refund, dispute verify) can detect replay.
 *
 * Task-1 (SEC) additions:
 *   - Same-origin CSRF check on the POST (item 5).
 *   - Rate limit: 10 buys / player / minute (item 3).
 *   - Body-size limit: 1KB (item 6).
 *   - Zod validation with catalog-enum + slug-shape enforcement (item 8, 16).
 *   - Inventory cap: reject when the player already owns > MAX items of
 *     this kind (item 18).
 *
 * Returns the new balance, the inventory, AND the receipt (id + nonce +
 * signature) so the client can display it on a confirmation toast + the
 * support team can look it up later.
 */
export async function POST(req: NextRequest) {
  // 1. CSRF check.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  // 2. Rate limit (per player).
  const rlKey = playerRateKey(PLAYER_ID, "shop-buy");
  const rl = rateLimit(rlKey, BUY_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many purchases", retryAfterMs: rl.retryAfterMs },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  // 3. Body-size limit + Zod validation.
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
  if (bodyError) return bodyError;
  const parsed = shopBuySchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("Invalid request body. Expected { itemType, slug }.", 400, {
      issues: parsed.error.issues,
    });
  }

  try {
    await ensureSeed();

    const itemType: ItemType = parsed.data.itemType;
    const slug: string = parsed.data.slug;
    const clientPrice = parsed.data.clientPrice;

    // (a)+(b) Server-side balance + catalog validation. clientPrice, if
    // sent, is asserted against the catalog price — the catalog wins.
    const kind: CatalogKind = itemType;
    const validation = await validatePurchase(PLAYER_ID, kind, slug, {
      expectedPrice: clientPrice,
    });
    if (!validation.ok) {
      return errorResponse(validation.message, 400);
    }
    if (!validation.affordable) {
      return errorResponse("Insufficient credits", 400);
    }
    const canonicalPrice = validation.catalog.price;

    // Section H (927) — alert on clientPrice mismatch. The
    // validatePurchase call above already rejects mismatches with
    // `code: "invalid_price"`, but that path is reached only when the
    // client explicitly sent a `clientPrice`. When the client omits
    // `clientPrice`, the canonical price is used silently — but if the
    // client DID send one + it diverged, we log the mismatch here so
    // the live-ops team can detect a stale-client or tampering pattern.
    if (clientPrice !== undefined && clientPrice !== canonicalPrice) {
      logger.warn("clientPrice mismatch", {
        playerId: PLAYER_ID,
        itemType,
        slug,
        clientPrice,
        canonicalPrice,
        delta: clientPrice - canonicalPrice,
      });
    }

    // Task-1 (SEC) item 18: inventory-size cap. Count the player's rows
    // in the target kind + reject if already at the cap. Prevents a
    // malicious client from flooding the inventory table.
    const inventoryCount = await (async () => {
      if (itemType === "WEAPON" || itemType === "SKIN") {
        return db.playerInventory.count({
          where:
            itemType === "WEAPON"
              ? { playerId: PLAYER_ID, weaponSlug: { not: null } }
              : { playerId: PLAYER_ID, skinSlug: { not: null } },
        });
      }
      if (itemType === "OPERATOR") {
        return db.playerInventoryOperator.count({ where: { playerId: PLAYER_ID } });
      }
      return db.playerInventoryAttachment.count({ where: { playerId: PLAYER_ID } });
    })();
    if (inventoryCount >= MAX_INVENTORY_PER_KIND) {
      return errorResponse(
        `Inventory cap reached (${MAX_INVENTORY_PER_KIND} ${itemType.toLowerCase()} items)`,
        400,
      );
    }

    // Ownership check first — clearer error for the user than
    // "Insufficient credits" on something they already own.
    let updatedCredits: number;
    let receipt: { id: string; nonce: string; signature: string; amount: number; reason: string; itemSlug: string; ts: Date } | null = null;
    try {
      const result = await db.$transaction(async (tx) => {
        if (itemType === "WEAPON") {
          const owned = await tx.playerInventory.findFirst({
            where: { playerId: PLAYER_ID, weaponSlug: slug },
          });
          if (owned) throw new HttpError(400, "Already owned");
        } else if (itemType === "SKIN") {
          const owned = await tx.playerInventory.findFirst({
            where: { playerId: PLAYER_ID, skinSlug: slug },
          });
          if (owned) throw new HttpError(400, "Already owned");
        } else if (itemType === "OPERATOR") {
          const owned = await tx.playerInventoryOperator.findUnique({
            where: {
              playerId_operatorSlug: { playerId: PLAYER_ID, operatorSlug: slug },
            },
          });
          if (owned) throw new HttpError(400, "Already owned");
        } else {
          const owned = await tx.playerInventoryAttachment.findUnique({
            where: {
              playerId_attachmentSlug: { playerId: PLAYER_ID, attachmentSlug: slug },
            },
          });
          if (owned) throw new HttpError(400, "Already owned");
        }

        // (c)+(d) Atomic debit + signed receipt inside the same tx.
        const debitResult = await debit(PLAYER_ID, canonicalPrice, "shop_buy", {
          tx,
          itemSlug: slug,
        });
        if (!debitResult.ok) {
          throw new HttpError(
            debitResult.code === "insufficient" ? 400 : 500,
            debitResult.message,
          );
        }

        if (itemType === "WEAPON") {
          await tx.playerInventory.create({
            data: { playerId: PLAYER_ID, weaponSlug: slug },
          });
        } else if (itemType === "SKIN") {
          await tx.playerInventory.create({
            data: { playerId: PLAYER_ID, skinSlug: slug },
          });
        } else if (itemType === "OPERATOR") {
          await tx.playerInventoryOperator.upsert({
            where: {
              playerId_operatorSlug: { playerId: PLAYER_ID, operatorSlug: slug },
            },
            update: {},
            create: { playerId: PLAYER_ID, operatorSlug: slug },
          });
        } else {
          await tx.playerInventoryAttachment.upsert({
            where: {
              playerId_attachmentSlug: { playerId: PLAYER_ID, attachmentSlug: slug },
            },
            update: {},
            create: { playerId: PLAYER_ID, attachmentSlug: slug },
          });
        }

        return debitResult;
      });
      updatedCredits = result.balanceAfter;
      receipt = result.receipt;

      // Task-1 (SEC) item 17: track the receipt nonce in `UsedNonce`
      // so any follow-up action that depends on this receipt being
      // "unspent" can detect a replay. Fire-and-forget — a failure
      // here doesn't unwind the purchase.
      if (receipt) {
        try {
          // Insert directly (we don't want to call issueNonce which
          // generates a fresh nonce — we want to track the existing
          // receipt's nonce).
          const now = new Date();
          await db.usedNonce.create({
            data: {
              nonce: receipt.nonce,
              flow: "purchase",
              playerId: PLAYER_ID,
              createdAt: now,
              expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            },
          });
        } catch (err) {
          logger.warn("failed to track receipt nonce", { error: String(err) });
        }
      }
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(err.message, err.status);
      }
      throw err;
    }

    const inventory = await getPlayerInventorySlugs();
    return NextResponse.json({
      credits: updatedCredits,
      inventory,
      receipt: receipt
        ? {
            id: receipt.id,
            nonce: receipt.nonce,
            signature: receipt.signature,
            amount: receipt.amount,
            reason: receipt.reason,
            itemSlug: receipt.itemSlug,
            ts: receipt.ts.toISOString(),
          }
        : null,
    });
  } catch (err) {
    logger.errorOf(err, "purchase failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Purchase failed" },
      { status: 500 },
    );
  }
}
