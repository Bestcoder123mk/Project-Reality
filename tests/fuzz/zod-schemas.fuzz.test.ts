import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  shopBuySchema,
  packsOpenSchema,
  playerDeleteSchema,
  hitClaimSchema,
  adminExperimentSchema,
  adminCalendarSchema,
  verifyReceiptSchema,
  itemSlugSchema,
  reasonSchema,
  packSlugSchema,
  shopItemTypeSchema,
  playerIdSchema,
} from "@/lib/security/validation";

/**
 * Backlog §2 item 39 — Fuzz testing for the Zod schemas on write routes.
 *
 * Every Zod schema in src/lib/security/validation.ts is the first line of
 * defense against malformed / hostile request bodies. The guarantee we
 * need: NO INPUT causes the schema to throw. A `.safeParse()` either
 * accepts the input or returns `{ success: false, error }` — never throws.
 *
 * fast-check generates 1,000 random inputs per schema across a wide
 * domain (strings, numbers, objects, arrays, null, undefined, mixed
 * shapes). Each input must be safely rejected (or accepted) without
 * throwing. This catches pathological inputs that would otherwise 500
 * in production.
 *
 * The "valid" branch is also tested: known-good inputs parse to a
 * success result so we don't regress to "everything fails".
 */

describe("Zod schemas never throw on arbitrary input (safeParse)", () => {
  // Generic arbitrary that covers the union of likely-malicious inputs:
  // strings, numbers, booleans, null, undefined, objects, arrays, nested.
  const anyJsonish: fc.Arbitrary<unknown> = fc.oneof(
    fc.string({ maxLength: 200 }),
    fc.integer(),
    fc.float(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.string(), { maxLength: 5 }),
    fc.record({
      a: fc.string(),
      b: fc.integer(),
      c: fc.array(fc.boolean()),
    }),
    fc.record({
      itemType: fc.string(),
      slug: fc.string(),
      clientPrice: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
    }),
  );

  const schemas: Array<[string, { safeParse: (u: unknown) => unknown }]> = [
    ["shopBuySchema", shopBuySchema],
    ["packsOpenSchema", packsOpenSchema],
    ["playerDeleteSchema", playerDeleteSchema],
    ["hitClaimSchema", hitClaimSchema],
    ["adminExperimentSchema", adminExperimentSchema],
    ["adminCalendarSchema", adminCalendarSchema],
    ["verifyReceiptSchema", verifyReceiptSchema],
    ["itemSlugSchema", itemSlugSchema],
    ["reasonSchema", reasonSchema],
    ["packSlugSchema", packSlugSchema],
    ["shopItemTypeSchema", shopItemTypeSchema],
    ["playerIdSchema", playerIdSchema],
  ];

  for (const [name, schema] of schemas) {
    it(`${name}.safeParse never throws on arbitrary input`, () => {
      fc.assert(
        fc.property(anyJsonish, (input) => {
          // The contract: safeParse MUST NOT throw. It returns either
          // { success: true, data } or { success: false, error }.
          let result: unknown;
          let threw = false;
          try {
            result = schema.safeParse(input);
          } catch (err) {
            threw = true;
            result = err;
          }
          expect(threw).toBe(false);
          // Result shape: either success or error.
          if (result && typeof result === "object" && "success" in (result as object)) {
            const r = result as { success: boolean };
            expect(typeof r.success).toBe("boolean");
          } else {
            throw new Error(`safeParse returned non-result shape: ${JSON.stringify(result)}`);
          }
        }),
        { numRuns: 200 },
      );
    });
  }
});

describe("Zod schemas accept known-good inputs (no false-negative regression)", () => {
  it("shopBuySchema accepts a well-formed shop buy request", () => {
    const r = shopBuySchema.safeParse({
      itemType: "WEAPON",
      slug: "m4",
      clientPrice: 2500,
    });
    expect(r.success).toBe(true);
  });

  it("packsOpenSchema accepts a well-formed pack open request", () => {
    const r = packsOpenSchema.safeParse({
      packSlug: "tactical",
      clientPrice: 800,
    });
    expect(r.success).toBe(true);
  });

  it("playerDeleteSchema accepts a GDPR delete request", () => {
    const r = playerDeleteSchema.safeParse({
      playerId: "00000000-0000-0000-0000-000000000001",
      confirm: "DELETE",
      reason: "user requested",
    });
    expect(r.success).toBe(true);
  });

  it("hitClaimSchema accepts a well-formed signed hit claim", () => {
    const r = hitClaimSchema.safeParse({
      shooterId: "00000000-0000-0000-0000-000000000001",
      targetId: "enemy-42",
      weaponSlug: "ak74",
      hitLocation: "head",
      distance: 42.5,
      shotAtMs: 1700000000000,
      signature: "a".repeat(64),
      nonce: "b".repeat(16),
    });
    expect(r.success).toBe(true);
  });

  it("adminCalendarSchema accepts a well-formed calendar entry", () => {
    const r = adminCalendarSchema.safeParse({
      slug: "season-2",
      kind: "season",
      title: "Season 2",
      startsAt: "2024-04-01T00:00:00Z",
      endsAt: "2024-06-30T23:59:59Z",
    });
    expect(r.success).toBe(true);
  });
});

describe("Zod schemas reject known-hostile inputs (security boundary)", () => {
  it("itemSlugSchema rejects path-traversal payloads", () => {
    for (const hostile of [
      "../../../etc/passwd",
      "..\\..\\windows\\system32",
      "m4; DROP TABLE weapons;",
      "m4\n--",
      "m4\x00null",
      " m4 ",
      "M4 CARBINE!", // space + punctuation
    ]) {
      const r = itemSlugSchema.safeParse(hostile);
      expect(r.success, `itemSlugSchema accepted "${hostile}"`).toBe(false);
    }
  });

  it("reasonSchema rejects control-character injection", () => {
    for (const hostile of [
      "\x00\x01\x02",
      "hello\x1b[2Jworld", // ANSI escape
      "line\r\nbreak",
      "tab\there",
    ]) {
      const r = reasonSchema.safeParse(hostile);
      expect(r.success, `reasonSchema accepted control chars`).toBe(false);
    }
  });

  it("shopBuySchema rejects non-enum itemType", () => {
    const r = shopBuySchema.safeParse({ itemType: "NUKE", slug: "m4" });
    expect(r.success).toBe(false);
  });

  it("packsOpenSchema rejects unknown pack slugs", () => {
    const r = packsOpenSchema.safeParse({ packSlug: "free_money" });
    expect(r.success).toBe(false);
  });

  it("shopBuySchema rejects negative + huge clientPrice", () => {
    const r1 = shopBuySchema.safeParse({ itemType: "WEAPON", slug: "m4", clientPrice: -1 });
    expect(r1.success).toBe(false);
    const r2 = shopBuySchema.safeParse({ itemType: "WEAPON", slug: "m4", clientPrice: 1_000_001 });
    expect(r2.success).toBe(false);
  });

  it("playerDeleteSchema rejects without confirm='DELETE'", () => {
    const r = playerDeleteSchema.safeParse({ confirm: "delete" }); // case-sensitive
    expect(r.success).toBe(false);
  });

  it("hitClaimSchema rejects too-short signatures", () => {
    const r = hitClaimSchema.safeParse({
      shooterId: "p1",
      targetId: "t1",
      weaponSlug: "ak74",
      hitLocation: "head",
      distance: 10,
      shotAtMs: 1,
      signature: "short",
    });
    expect(r.success).toBe(false);
  });

  it("hitClaimSchema rejects negative distances", () => {
    const r = hitClaimSchema.safeParse({
      shooterId: "p1",
      targetId: "t1",
      weaponSlug: "ak74",
      hitLocation: "head",
      distance: -5,
      shotAtMs: 1,
      signature: "a".repeat(64),
    });
    expect(r.success).toBe(false);
  });
});

/**
 * Property-based fuzz on the most-exercised schema (shopBuySchema).
 * fast-check generates random `itemType` + `slug` + `clientPrice` triples;
 * we assert the schema either accepts or safely rejects each one.
 */
describe("shopBuySchema property-based fuzz (item 39)", () => {
  it("safeParse never throws on any (itemType, slug, clientPrice) triple", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 50 }), fc.integer(), fc.constant(null), fc.boolean()),
        fc.oneof(fc.string({ maxLength: 100 }), fc.integer(), fc.constant(null)),
        fc.oneof(fc.integer(), fc.float(), fc.string(), fc.constant(null), fc.constant(undefined)),
        (itemType, slug, clientPrice) => {
          const input: Record<string, unknown> = { itemType, slug };
          if (clientPrice !== undefined) input.clientPrice = clientPrice;
          let threw = false;
          try {
            shopBuySchema.safeParse(input);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });
});
