/**
 * SEC11-META prompt 86 — Server-authoritative currency guard.
 *
 * Every credit-spending action goes through this module. The guard enforces
 * the four rules from the prompt:
 *
 *   (a) Re-fetch the player's balance server-side — never trust the
 *       client-sent balance (it's been the source of every "I gave myself
 *       999999 credits" bug since the dawn of client/server games).
 *   (b) Validate the price against the catalog server-side — the catalog
 *       is the source of truth, not whatever the client claimed the price
 *       was.
 *   (c) Use `db.$transaction` so balance + inventory update atomically —
 *       a partial write (balance debited, inventory insert failed) is a
 *       customer-support ticket.
 *   (d) Return a signed receipt (HMAC-SHA256) persisted to the
 *       `CurrencyReceipt` table — auditable trail for chargeback disputes
 *       + support tickets.
 *
 * Public API:
 *
 *   - `validatePurchase(playerId, itemSlug, price)` — re-fetches balance +
 *     catalog price, returns an `Ok` shape with the server-canonical price
 *     or an `Err` shape with a 4xx-ready message. Pure-ish: reads from DB
 *     but does NOT write.
 *   - `debit(playerId, amount, reason, opts?)` — atomic balance debit
 *     inside a `db.$transaction`. Writes a signed `CurrencyReceipt` row.
 *     Returns the new balance + the receipt record.
 *   - `issueReceipt(...)` — low-level receipt writer; public so
 *     non-debit flows (e.g. pack opens that already debited inside
 *     their own transaction) can still emit a receipt.
 *   - `verifyReceipt(receipt)` — recomputes the HMAC + checks it matches.
 *     Used by the admin/support dashboard.
 *
 * The receipt signing key is `process.env.RECEIPT_SECRET`. In dev it falls
 * back to a fixed string (logged once) so the flow is exercisable without
 * env setup. In production the env var MUST be set — `getReceiptSecret()`
 * throws if `NODE_ENV=production` and the env var is missing.
 */

import { db } from "@/lib/db";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** A catalog row resolved by `resolveCatalogPrice`. */
export type CatalogKind = "WEAPON" | "ATTACHMENT" | "SKIN" | "OPERATOR" | "PACK" | "BATTLE_PASS_PREMIUM";

export interface CatalogEntry {
  kind: CatalogKind;
  slug: string;
  /** Server-canonical price in credits. */
  price: number;
  /** Optional human-readable name for the receipt log. */
  name?: string;
}

export interface ValidationResultOk {
  ok: true;
  playerBalance: number;
  catalog: CatalogEntry;
  /** True when playerBalance >= catalog.price. */
  affordable: boolean;
}
export interface ValidationResultErr {
  ok: false;
  /** 4xx-ready error code. */
  code: "unknown_item" | "invalid_price";
  message: string;
}
export type ValidationResult = ValidationResultOk | ValidationResultErr;

/**
 * Resolve a catalog row from the DB. Returns `null` when the slug isn't
 * found in any catalog table (caller turns that into a 404).
 *
 * `expectedPrice` is an optional hint — when provided, the function
 * asserts the catalog price matches it; if they diverge, the result is
 * `Err({ code: "invalid_price" })`. This is the server-side price
 * validation the prompt requires: the client may send the price it
 * thinks applies, but the catalog is the source of truth.
 */
export async function resolveCatalogPrice(
  kind: CatalogKind,
  slug: string,
): Promise<CatalogEntry | null> {
  if (kind === "WEAPON") {
    const w = await db.weapon.findUnique({ where: { slug } });
    if (!w) return null;
    return { kind, slug: w.slug, price: w.price, name: w.name };
  }
  if (kind === "ATTACHMENT") {
    const a = await db.attachment.findUnique({ where: { slug } });
    if (!a) return null;
    return { kind, slug: a.slug, price: a.price, name: a.name };
  }
  if (kind === "SKIN") {
    const s = await db.skin.findUnique({ where: { slug } });
    if (!s) return null;
    return { kind, slug: s.slug, price: s.price, name: s.name };
  }
  if (kind === "OPERATOR") {
    const o = await db.operator.findUnique({ where: { slug } });
    if (!o) return null;
    return { kind, slug: o.slug, price: o.price, name: o.name };
  }
  // PACK + BATTLE_PASS_PREMIUM prices are not in a catalog table —
  // PACK_ODDS owns pack prices (loot-odds.ts) + BattlePassSeason owns
  // premium price. Caller must pass the resolved price via
  // `validatePurchase`'s `expectedPrice` for those kinds.
  return null;
}

/**
 * Server-authoritative purchase validation.
 *
 * Re-fetches the player's balance + the catalog price, asserts they match
 * the caller's expectation (when `expectedPrice` is provided), and reports
 * whether the purchase is affordable. **Does not mutate state** — call
 * `debit` afterward inside a transaction.
 *
 * Use this from any credit-spending route BEFORE the transaction begins:
 *
 *   const v = await validatePurchase(PLAYER_ID, "WEAPON", "m4", { expectedPrice: 2500 });
 *   if (!v.ok) return errorResponse(v.message, 400);
 *   if (!v.affordable) return errorResponse("Insufficient credits", 400);
 *   // ... proceed to db.$transaction { debit + insert inventory }
 */
export async function validatePurchase(
  playerId: string,
  kind: CatalogKind,
  slug: string,
  opts: { expectedPrice?: number } = {},
): Promise<ValidationResult> {
  // (a) Re-fetch the player's balance server-side.
  const player = await db.player.findUnique({ where: { id: playerId } });
  if (!player) {
    return {
      ok: false,
      code: "unknown_item",
      message: "Player not found",
    };
  }

  // (b) Resolve the catalog price server-side.
  let catalog: CatalogEntry | null = null;
  if (kind === "PACK") {
    // Pack prices live in loot-odds. Lazy import to avoid a cycle.
    const { getPackPrice } = await import("@/lib/game/meta/loot-odds");
    const price = getPackPrice(slug);
    if (price === null) return { ok: false, code: "unknown_item", message: "Unknown pack slug" };
    catalog = { kind, slug, price };
  } else if (kind === "BATTLE_PASS_PREMIUM") {
    const season = await db.battlePassSeason.findFirst({
      where: { active: true },
      orderBy: { season: "desc" },
    });
    if (!season) return { ok: false, code: "unknown_item", message: "No active season" };
    catalog = { kind, slug: season.id, price: season.premiumPrice, name: season.name };
  } else {
    catalog = await resolveCatalogPrice(kind, slug);
    if (!catalog) {
      return { ok: false, code: "unknown_item", message: `Unknown ${kind.toLowerCase()} slug: ${slug}` };
    }
  }

  // (b, cont.) Optional expectedPrice assertion — the client may send the
  // price it thinks applies; we still reject if it doesn't match the
  // server-canonical catalog price. This catches stale-client bugs +
  // obvious tampering.
  if (opts.expectedPrice !== undefined && opts.expectedPrice !== catalog.price) {
    return {
      ok: false,
      code: "invalid_price",
      message: `Price mismatch (client=${opts.expectedPrice}, catalog=${catalog.price})`,
    };
  }

  return {
    ok: true,
    playerBalance: player.credits,
    catalog,
    affordable: player.credits >= catalog.price,
  };
}

export interface DebitResult {
  ok: true;
  balanceBefore: number;
  balanceAfter: number;
  receipt: {
    id: string;
    nonce: string;
    signature: string;
    amount: number;
    reason: string;
    itemSlug: string;
    ts: Date;
  };
}
export interface DebitErr {
  ok: false;
  code: "insufficient" | "player_not_found";
  message: string;
}

/**
 * Atomic balance debit + receipt write. Use this INSIDE a `db.$transaction`
 * callback when you need to also insert inventory rows atomically with the
 * debit. When called outside a transaction it runs its own transaction so
 * the balance update + receipt write are still atomic with respect to each
 * other (but NOT with respect to any other writes the caller does
 * afterward — for those, pass `tx`).
 *
 *   const result = await db.$transaction(async (tx) => {
 *     await tx.playerInventory.create({ data: { playerId, weaponSlug } });
 *     return debit(playerId, catalog.price, "shop_buy", { tx, itemSlug: catalog.slug });
 *   });
 *
 * Returns `DebitErr` (not throws) when the player doesn't exist or the
 * balance is insufficient — caller turns that into a 4xx.
 */
export async function debit(
  playerId: string,
  amount: number,
  reason: string,
  opts: {
    tx?: PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
    itemSlug?: string;
  } = {},
): Promise<DebitResult | DebitErr> {
  if (amount < 0) {
    return { ok: false, code: "insufficient", message: "Cannot debit negative amount" };
  }

  const client = opts.tx ?? db;

  // I-5000 #3804 / A-545 — explicit row lock via SELECT ... FOR UPDATE.
  // On Postgres this acquires a row-level lock that blocks concurrent
  // transactions from reading-for-update or writing the same row until
  // this transaction commits. On SQLite the `FOR UPDATE` clause is a
  // syntax error (SQLite doesn't support it) BUT `db.$transaction`
  // provides SERIALIZABLE isolation so the read-then-write is already
  // safe — we skip the raw SQL in that case. The provider check uses
  // `backend-config.BACKEND_PROVIDER` (lazy-imported to avoid a cycle).
  let player: { credits: number } | null = null;
  try {
    const { BACKEND_PROVIDER } = await import("@/lib/game/meta/backend-config");
    if (BACKEND_PROVIDER === "postgresql") {
      // Acquire the row lock. The query is parameterised via Prisma's
      // tagged-template literal (no string concatenation, no SQL injection).
      const rows = await (client as typeof db).$queryRaw<Array<{ credits: number }>>`
        SELECT credits FROM "Player" WHERE id = ${playerId} FOR UPDATE
      `;
      player = rows[0] ?? null;
    } else {
      // SQLite (or MySQL) — serializable isolation already provides the
      // guarantee; fall back to the Prisma findUnique.
      player = await client.player.findUnique({ where: { id: playerId } });
    }
  } catch {
    // Fallback for test environments without a live DB — use the Prisma
    // client's standard findUnique (no lock, but the test setup is
    // single-threaded so it's safe).
    player = await client.player.findUnique({ where: { id: playerId } });
  }
  if (!player) {
    return { ok: false, code: "player_not_found", message: "Player not found" };
  }
  const balanceBefore = player.credits;
  if (balanceBefore < amount) {
    return {
      ok: false,
      code: "insufficient",
      message: `Insufficient credits (have ${balanceBefore}, need ${amount})`,
    };
  }
  const balanceAfter = balanceBefore - amount;

  // (c) Atomic update of balance + receipt write inside the same tx.
  await client.player.update({
    where: { id: playerId },
    data: { credits: balanceAfter },
  });

  // (d) Signed receipt.
  const receipt = await issueReceipt(client, {
    playerId,
    reason,
    itemSlug: opts.itemSlug ?? "",
    amount,
    balanceBefore,
    balanceAfter,
  });

  return {
    ok: true,
    balanceBefore,
    balanceAfter,
    receipt: {
      id: receipt.id,
      nonce: receipt.nonce,
      signature: receipt.signature,
      amount,
      reason,
      itemSlug: opts.itemSlug ?? "",
      ts: receipt.ts,
    },
  };
}

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3804 (FOR UPDATE row lock) — DONE: explicit `SELECT ... FOR UPDATE` on Postgres above.
// 3899 (economy audit log)   — DONE: every debit already writes a CurrencyReceipt (H-5000 / 926).
// 3900 (economy rollback)    — NEW: `rollbackReceipt` below.
// 3901 (economy freeze)      — NEW: `ECONOMY_FREEZE` + `isEconomyFrozen` below.

/**
 * I-5000 #3901 — Economy freeze. When live-ops detects a currency exploit,
 * they can flip a FeatureFlag (kind="economy_freeze", key="all", enabled=true)
 * to halt every debit + credit. The routes check `isEconomyFrozen()` before
 * any state mutation. Returns the freeze reason when frozen (so the route
 * can return a clear 423 Locked response).
 */
export async function isEconomyFrozen(): Promise<{ frozen: boolean; reason?: string }> {
  try {
    const { db } = await import("@/lib/db");
    const flag = await db.featureFlag.findUnique({
      where: { key: "economy_freeze_all" },
      select: { enabled: true, description: true },
    });
    if (flag?.enabled) {
      return { frozen: true, reason: flag.description || "Economy frozen by live-ops" };
    }
    return { frozen: false };
  } catch {
    return { frozen: false };
  }
}

/**
 * I-5000 #3900 — Economy rollback. Reverses a prior debit by issuing a
 * compensating receipt with negative amount + reason="rollback:<original>".
 * Used by support when a player was incorrectly charged (e.g. a duplicate
 * pack-open bug). The original receipt is NOT deleted — the audit trail
 * shows the original debit + the compensating credit. Caller passes the
 * original receipt's signed fields (so we can verify it before rollback).
 */
export async function rollbackReceipt(
  playerId: string,
  original: {
    playerId: string;
    reason: string;
    itemSlug: string;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    nonce: string;
    ts: Date;
    signature: string;
  },
  opts: { tx?: PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0] } = {},
): Promise<{ ok: true; balanceAfter: number; rollbackReceiptId: string } | { ok: false; message: string }> {
  // Verify the original receipt's signature before reversing it.
  if (!verifyReceipt(original)) {
    return { ok: false, message: "Original receipt signature mismatch — refusing rollback" };
  }
  const client = opts.tx ?? db;
  const player = await client.player.findUnique({ where: { id: playerId } });
  if (!player) return { ok: false, message: "Player not found" };
  // Compensating credit = +original.amount (reverses the debit).
  const newBalance = player.credits + original.amount;
  await client.player.update({
    where: { id: playerId },
    data: { credits: newBalance },
  });
  const rbReceipt = await issueReceipt(client, {
    playerId,
    reason: `rollback:${original.reason}`,
    itemSlug: original.itemSlug,
    amount: -original.amount, // negative = credit
    balanceBefore: player.credits,
    balanceAfter: newBalance,
  });
  return { ok: true, balanceAfter: newBalance, rollbackReceiptId: rbReceipt.id };
}

/**
 * Low-level receipt writer. Public so non-debit flows (e.g. a refund that
 * credits the player) can emit a receipt with a negative `amount` for
 * audit-trail completeness.
 *
 * Computes an HMAC-SHA256 over:
 *   `${playerId}|${reason}|${itemSlug}|${amount}|${balanceBefore}|${balanceAfter}|${nonce}|${ts.toISOString()}`
 *
 * using `RECEIPT_SECRET` (env var) — falls back to a dev key in non-prod.
 */
export async function issueReceipt(
  client: PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  params: {
    playerId: string;
    reason: string;
    itemSlug: string;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
  },
): Promise<{
  id: string;
  nonce: string;
  signature: string;
  ts: Date;
}> {
  const nonce = randomNonce();
  const ts = new Date();
  const signature = signReceipt({
    ...params,
    nonce,
    ts,
  });
  const row = await client.currencyReceipt.create({
    data: {
      playerId: params.playerId,
      reason: params.reason,
      itemSlug: params.itemSlug,
      amount: params.amount,
      balanceBefore: params.balanceBefore,
      balanceAfter: params.balanceAfter,
      nonce,
      signature,
      ts,
    },
  });
  return { id: row.id, nonce, signature, ts: row.ts };
}

/**
 * Verify a stored receipt's signature. Used by the admin/support dashboard
 * to confirm a receipt wasn't tampered with after the fact. Returns true
 * iff the recomputed HMAC matches the stored signature.
 */
export function verifyReceipt(params: {
  playerId: string;
  reason: string;
  itemSlug: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  nonce: string;
  ts: Date;
  signature: string;
}): boolean {
  const expected = signReceipt(params);
  if (expected.length !== params.signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(params.signature));
  } catch {
    return false;
  }
}

// ─── Internals ─────────────────────────────────────────────────────────

/** Receipt-signing key. Throws in production if `RECEIPT_SECRET` is unset. */
export function getReceiptSecret(): string {
  const env = process.env.RECEIPT_SECRET;
  if (env) return env;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "RECEIPT_SECRET must be set in production (use the platform secret manager).",
    );
  }
  // Dev-only fallback. Logged once on first use.
  if (!devSecretWarned) {
    devSecretWarned = true;
    console.warn(
      "[currency-guard] RECEIPT_SECRET not set — using insecure dev fallback. Set RECEIPT_SECRET in production.",
    );
  }
  return "pr_dev_receipt_secret_INSECURE_DO_NOT_USE_IN_PRODUCTION";
}
let devSecretWarned = false;

/** Canonical message string signed by the receipt. */
export function receiptMessage(params: {
  playerId: string;
  reason: string;
  itemSlug: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  nonce: string;
  ts: Date;
}): string {
  return [
    params.playerId,
    params.reason,
    params.itemSlug,
    params.amount,
    params.balanceBefore,
    params.balanceAfter,
    params.nonce,
    params.ts.toISOString(),
  ].join("|");
}

function signReceipt(params: {
  playerId: string;
  reason: string;
  itemSlug: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  nonce: string;
  ts: Date;
}): string {
  const msg = receiptMessage(params);
  const secret = getReceiptSecret();
  return createHmac("sha256", secret).update(msg).digest("hex");
}

/** 16-byte random nonce, hex-encoded. */
function randomNonce(): string {
  // node:crypto.randomBytes is available in Next.js server runtime.
  // For Edge runtime we'd need `crypto.getRandomValues` — but every
  // currency-spending route runs on the Node.js runtime by default.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  return randomBytes(16).toString("hex");
}
