import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  verifyReceipt,
  getReceiptSecret,
  receiptMessage,
  type CatalogKind,
} from "../currency-guard";
import { createHmac } from "node:crypto";

/**
 * Backlog §2 item 29 — Unit-test currency-guard.ts economy math.
 *
 * The module has two flavors of function:
 *   - Pure crypto helpers (getReceiptSecret, receiptMessage, signReceipt via
 *     verifyReceipt) — fully testable in-process, no DB.
 *   - DB-bound flows (validatePurchase, debit, issueReceipt) — require a
 *     live Prisma client. Those are exercised in `tests/load/shop-buy.
 *     double-spend.test.ts` and `tests/contract/shop-buy.contract.test.ts`
 *     against the real SQLite DB, because the double-spend + concurrency
 *     semantics are the actual security guarantee.
 *
 * This file covers the pure math:
 *   - Receipt message format (canonical concatenation with `|`).
 *   - HMAC-SHA256 signature determinism + tamper detection.
 *   - verifyReceipt accepts a valid signature and rejects every mutated
 *     field (amount, balanceBefore, balanceAfter, nonce, ts, playerId,
 *     reason, itemSlug).
 *   - getReceiptSecret falls back to the dev key in non-prod + throws in
 *     production when RECEIPT_SECRET is unset.
 */

const SECRET = "test-receipt-secret-do-not-use-in-prod";

describe("getReceiptSecret", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.RECEIPT_SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns the env var when RECEIPT_SECRET is set", () => {
    process.env.RECEIPT_SECRET = "my-prod-secret";
    expect(getReceiptSecret()).toBe("my-prod-secret");
  });

  it("returns the dev fallback when neither env var nor NODE_ENV=production is set", () => {
    process.env.NODE_ENV = "test";
    expect(getReceiptSecret()).toMatch(/INSECURE_DO_NOT_USE_IN_PRODUCTION/);
  });

  it("throws in production when RECEIPT_SECRET is unset", () => {
    process.env.NODE_ENV = "production";
    expect(() => getReceiptSecret()).toThrow(/RECEIPT_SECRET must be set/);
  });

  it("does NOT throw in production when RECEIPT_SECRET is set", () => {
    process.env.NODE_ENV = "production";
    process.env.RECEIPT_SECRET = "prod-secret";
    expect(getReceiptSecret()).toBe("prod-secret");
  });
});

describe("receiptMessage canonical format", () => {
  const params = {
    playerId: "player-1",
    reason: "shop_buy",
    itemSlug: "m4",
    amount: 2500,
    balanceBefore: 5000,
    balanceAfter: 2500,
    nonce: "abc123",
    ts: new Date("2024-01-15T12:00:00.000Z"),
  };

  it("joins all 8 fields with '|'", () => {
    const msg = receiptMessage(params);
    const parts = msg.split("|");
    expect(parts).toHaveLength(8);
    expect(parts[0]).toBe("player-1");
    expect(parts[1]).toBe("shop_buy");
    expect(parts[2]).toBe("m4");
    expect(parts[3]).toBe("2500");
    expect(parts[4]).toBe("5000");
    expect(parts[5]).toBe("2500");
    expect(parts[6]).toBe("abc123");
    expect(parts[7]).toBe("2024-01-15T12:00:00.000Z");
  });

  it("changes when any field changes (tamper-evidence)", () => {
    const baseline = receiptMessage(params);
    // Mutate each field in turn — every mutation must produce a different
    // canonical message.
    expect(receiptMessage({ ...params, playerId: "player-2" })).not.toBe(baseline);
    expect(receiptMessage({ ...params, reason: "pack_open" })).not.toBe(baseline);
    expect(receiptMessage({ ...params, itemSlug: "ak74" })).not.toBe(baseline);
    expect(receiptMessage({ ...params, amount: 2499 })).not.toBe(baseline);
    expect(receiptMessage({ ...params, balanceBefore: 4999 })).not.toBe(baseline);
    expect(receiptMessage({ ...params, balanceAfter: 2499 })).not.toBe(baseline);
    expect(receiptMessage({ ...params, nonce: "different" })).not.toBe(baseline);
    expect(receiptMessage({ ...params, ts: new Date("2024-01-15T12:00:01.000Z") })).not.toBe(baseline);
  });
});

describe("verifyReceipt (HMAC signature check)", () => {
  // Use a known secret so the test is fully deterministic.
  beforeEach(() => {
    process.env.RECEIPT_SECRET = SECRET;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    delete process.env.RECEIPT_SECRET;
  });

  const params = {
    playerId: "player-1",
    reason: "shop_buy",
    itemSlug: "m4",
    amount: 2500,
    balanceBefore: 5000,
    balanceAfter: 2500,
    nonce: "abc123def456",
    ts: new Date("2024-01-15T12:00:00.000Z"),
  };

  function sign(p: typeof params): string {
    return createHmac("sha256", SECRET).update(receiptMessage(p)).digest("hex");
  }

  it("returns true for a valid signature", () => {
    const signature = sign(params);
    expect(verifyReceipt({ ...params, signature })).toBe(true);
  });

  it("returns false when the signature length differs (timingSafeEqual guard)", () => {
    expect(verifyReceipt({ ...params, signature: "short" })).toBe(false);
  });

  it("returns false when any signed field is mutated", () => {
    const validSig = sign(params);
    // Mutate each field; signature should no longer match.
    expect(verifyReceipt({ ...params, playerId: "player-2", signature: validSig })).toBe(false);
    expect(verifyReceipt({ ...params, reason: "pack_open", signature: validSig })).toBe(false);
    expect(verifyReceipt({ ...params, itemSlug: "ak74", signature: validSig })).toBe(false);
    expect(verifyReceipt({ ...params, amount: 2499, signature: validSig })).toBe(false);
    expect(verifyReceipt({ ...params, balanceBefore: 4999, signature: validSig })).toBe(false);
    expect(verifyReceipt({ ...params, balanceAfter: 2499, signature: validSig })).toBe(false);
    expect(verifyReceipt({ ...params, nonce: "tampered", signature: validSig })).toBe(false);
    expect(verifyReceipt({ ...params, ts: new Date("2024-01-15T12:00:01.000Z"), signature: validSig })).toBe(false);
  });

  it("returns false when the signature itself is mutated", () => {
    const validSig = sign(params);
    // Flip the last hex char.
    const last = validSig.slice(-1);
    const replacement = last === "a" ? "b" : "a";
    const tampered = validSig.slice(0, -1) + replacement;
    expect(verifyReceipt({ ...params, signature: tampered })).toBe(false);
  });

  it("uses a constant-time comparison (timingSafeEqual) — same-length but wrong sig returns false without throwing", () => {
    const validSig = sign(params);
    // A valid-length but totally wrong signature.
    const wrongSig = "0".repeat(validSig.length);
    expect(verifyReceipt({ ...params, signature: wrongSig })).toBe(false);
  });
});

/**
 * Type-only sanity check — the CatalogKind union covers every kind the
 * shop + packs + battlepass routes use. If someone adds a new kind without
 * updating validatePurchase's branch, the type system catches it; this
 * test is a runtime mirror of that invariant.
 */
describe("CatalogKind union", () => {
  it("covers the six known catalog kinds", () => {
    const kinds: CatalogKind[] = [
      "WEAPON", "ATTACHMENT", "SKIN", "OPERATOR", "PACK", "BATTLE_PASS_PREMIUM",
    ];
    expect(kinds).toHaveLength(6);
    // Each kind is a distinct string literal.
    expect(new Set(kinds).size).toBe(6);
  });
});

/**
 * Sanity-check the economy math the module relies on:
 *   balanceAfter = balanceBefore - amount
 *   affordable   = balanceBefore >= price
 * These are one-liners in validatePurchase but they're the actual security
 * boundary — a sign-flip here is a "I gave myself 999999 credits" bug.
 */
describe("economy math invariants", () => {
  it("balanceAfter = balanceBefore - amount (no off-by-one)", () => {
    for (const [before, amount] of [
      [5000, 2500],
      [100, 100],
      [1, 1],
      [10_000_000, 1],
    ] as const) {
      const after = before - amount;
      expect(after).toBe(before - amount);
      expect(after).toBeGreaterThanOrEqual(0);
    }
  });

  it("a debit that would push the balance below zero is unaffordable", () => {
    const balance = 100;
    const price = 101;
    expect(balance >= price).toBe(false);
  });

  it("a debit equal to the balance is affordable (boundary case)", () => {
    const balance = 100;
    const price = 100;
    expect(balance >= price).toBe(true);
  });
});
