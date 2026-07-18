import { NextResponse, type NextRequest } from "next/server";
import { db, ensureSeed, errorResponse, PLAYER_ID } from "@/lib/api";
import {
  validatePurchase,
  debit,
} from "@/lib/game/meta/currency-guard";
import {
  PACK_ODDS,
  rollPack,
  getPackConfig,
} from "@/lib/game/meta/loot-odds";
import { packsOpenSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { rateLimit, playerRateKey } from "@/lib/security/rate-limit";
import { createLogger } from "@/lib/logger";

const logger = createLogger("/api/packs/open");

/** Pack-open rate limit: 6 packs / player / minute. */
const PACK_RATE_LIMIT = { max: 6, windowMs: 60_000, label: "pack-open" };

/**
 * SEC11-META prompt 87 — Server-authoritative pack open.
 *
 * POST /api/packs/open { packSlug }
 *
 * Flow:
 *   1. Validate the pack exists + the player can afford it (server-side
 *      balance + price check via `currency-guard.validatePurchase`).
 *   2. Inside `db.$transaction`:
 *      a. Debit the player (atomic + signed receipt).
 *      b. Roll the pack using crypto-grade randomness (`rollPack`).
 *      c. Write a `LootBoxRoll` row (audit log — pack, item, seed, rarity).
 *      d. Grant the item locally (mark wrap/charm/finisher as owned).
 *   3. Return the rolled item + receipt.
 *
 * The seed is persisted so the roll is reproducible for dispute resolution
 * (regulatory requirement in some jurisdictions).
 *
 * Task-1 (SEC) additions:
 *   - Same-origin CSRF check on the POST (item 5).
 *   - Rate limit: 6 packs / player / minute (item 3).
 *   - Body-size limit: 1KB (item 6).
 *   - Zod validation with `packSlug` enum-checked against `PACK_ODDS` (item 8, 16).
 *   - Receipt nonce tracked in `UsedNonce` for replay-attack protection (item 17).
 *
 * `PackScreen.tsx` was switched to call this route (item 4) — the
 * client's local `pickWeighted` is no longer authoritative.
 */
export async function POST(req: NextRequest) {
  // 1. CSRF check.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  // 2. Rate limit (per player).
  const rlKey = playerRateKey(PLAYER_ID, "pack-open");
  const rl = rateLimit(rlKey, PACK_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many pack opens", retryAfterMs: rl.retryAfterMs },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  // 3. Body-size limit + Zod validation.
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
  if (bodyError) return bodyError;
  const parsed = packsOpenSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("Invalid request body. Expected { packSlug }.", 400, {
      issues: parsed.error.issues,
    });
  }
  const packSlug = parsed.data.packSlug;
  const clientPrice = parsed.data.clientPrice;

  try {
    await ensureSeed();

    const pack = getPackConfig(packSlug);
    if (!pack) {
      // Defensive — Zod's enum should already have caught this.
      return errorResponse(`Unknown pack slug: ${packSlug}`, 404);
    }

    // Section H (927) — alert on clientPrice mismatch. The client may
    // send a `clientPrice` it thinks applies; the server-canonical pack
    // price (from `pack.price`) is the source of truth. When they
    // diverge we log the mismatch so the live-ops team can detect a
    // stale-client or tampering pattern. The log fires BEFORE
    // `validatePurchase` (which would reject the mismatch with
    // `code: "invalid_price"`) so the alert is recorded even when the
    // request is ultimately rejected. Mirrors the same alert in
    // `/api/shop/buy` (927).
    if (clientPrice !== undefined && clientPrice !== pack.price) {
      logger.warn("clientPrice mismatch", {
        playerId: PLAYER_ID,
        packSlug,
        clientPrice,
        canonicalPrice: pack.price,
        delta: clientPrice - pack.price,
      });
    }

    // (a)+(b) Server-side balance + catalog price validation.
    const validation = await validatePurchase(PLAYER_ID, "PACK", packSlug, {
      expectedPrice: clientPrice,
    });
    if (!validation.ok) {
      return errorResponse(validation.message, 400);
    }
    if (!validation.affordable) {
      return errorResponse("Insufficient credits", 400);
    }
    const price = validation.catalog.price;

    // (c)+(d) Atomic debit + roll + audit + grant.
    const result = await db.$transaction(async (tx) => {
      const debitResult = await debit(PLAYER_ID, price, "pack_open", {
        tx,
        itemSlug: packSlug,
      });
      if (!debitResult.ok) {
        throw new Error(debitResult.message);
      }

      // Roll the pack using crypto-grade randomness.
      const roll = rollPack(packSlug);
      if (!roll) {
        throw new Error(`Pack "${packSlug}" has no items`);
      }

      // Audit log — pack, item, seed, rarity. Always written so the
      // support team can reproduce any roll.
      await tx.lootBoxRoll.create({
        data: {
          playerId: PLAYER_ID,
          packSlug,
          itemKind: roll.item.kind,
          itemSlug: roll.item.slug,
          rarity: roll.item.rarity,
          seed: roll.seed,
        },
      });

      // Grant the item locally. Wraps + charms are persisted via the
      // profile's ownedWraps/ownedCharms fields (store.ts); the server
      // doesn't have a wraps/charms ownership table yet, so for now we
      // just return the rolled item — the client adds it to the local
      // profile. A future pack-ownership table would be the right place
      // to persist this server-side.
      return { debitResult, roll };
    });

    // Task-1 (SEC) item 17: track the receipt nonce in `UsedNonce`.
    try {
      const now = new Date();
      await db.usedNonce.create({
        data: {
          nonce: result.debitResult.receipt.nonce,
          flow: "pack_open",
          playerId: PLAYER_ID,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        },
      });
    } catch (err) {
      logger.warn("failed to track receipt nonce", { error: String(err) });
    }

    return NextResponse.json({
      packSlug,
      item: {
        kind: result.roll.item.kind,
        slug: result.roll.item.slug,
        name: result.roll.item.name,
        rarity: result.roll.item.rarity,
      },
      seed: result.roll.seed,
      credits: result.debitResult.balanceAfter,
      receipt: {
        id: result.debitResult.receipt.id,
        nonce: result.debitResult.receipt.nonce,
        signature: result.debitResult.receipt.signature,
        amount: result.debitResult.receipt.amount,
        reason: result.debitResult.receipt.reason,
        itemSlug: result.debitResult.receipt.itemSlug,
        ts: result.debitResult.receipt.ts.toISOString(),
      },
      // Include the full odds disclosure so the client can show "you
      // had a 3% chance" alongside the reveal.
      odds: PACK_ODDS[packSlug]
        ? {
            packSlug,
            price: PACK_ODDS[packSlug].price,
            totalWeight: PACK_ODDS[packSlug].items.reduce((s, i) => s + i.weight, 0),
          }
        : null,
    });
  } catch (err) {
    logger.errorOf(err, "pack open failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Pack open failed" },
      { status: 500 },
    );
  }
}
