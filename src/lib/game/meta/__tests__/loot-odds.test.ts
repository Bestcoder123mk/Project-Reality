import { describe, it, expect } from "vitest";
import {
  PACK_ODDS,
  PACK_SLUGS,
  getPackPrice,
  getPackConfig,
  totalWeight,
  itemProbability,
  rarityProbability,
  rollPack,
  getOddsDisclosure,
  validateOddsIntegrity,
  type PackConfig,
  type PackRarity,
} from "../loot-odds";

/**
 * Backlog §2 item 30 — Unit-test loot-odds.ts rarity weights sum/roll.
 *
 * Invariants:
 *   1. Every pack's item weights sum to a positive denominator.
 *   2. The sum of per-item probabilities equals 1.0 (within float tolerance).
 *   3. The sum of per-rarity bucket probabilities also equals 1.0.
 *   4. Empirical roll distribution over 10,000 rolls matches declared
 *      probabilities within ±5% (statistical sanity check, not a hard
 *      equality — that's the whole point of randomness).
 *   5. rollPack is reproducible when given a deterministic RNG (seeded
 *      determinism test, item 43).
 *   6. validateOddsIntegrity passes for every shipped pack (no drift
 *      between the disclosure cache and the actual weights).
 */

const ALL_RARITIES: PackRarity[] = ["COMMON", "RARE", "EPIC", "LEGENDARY"];

describe("PACK_ODDS table integrity", () => {
  it("has at least 3 packs (tactical / elite / legendary)", () => {
    expect(PACK_SLUGS.length).toBeGreaterThanOrEqual(3);
    expect(PACK_SLUGS).toContain("tactical");
    expect(PACK_SLUGS).toContain("elite");
    expect(PACK_SLUGS).toContain("legendary");
  });

  it("every pack has at least 1 item with a positive integer weight", () => {
    for (const slug of PACK_SLUGS) {
      const pack = PACK_ODDS[slug];
      expect(pack.items.length).toBeGreaterThan(0);
      for (const item of pack.items) {
        expect(Number.isInteger(item.weight)).toBe(true);
        expect(item.weight).toBeGreaterThan(0);
        expect(ALL_RARITIES).toContain(item.rarity);
        expect(item.slug.length).toBeGreaterThan(0);
        expect(item.name.length).toBeGreaterThan(0);
      }
    }
  });

  it("every pack has a positive integer price", () => {
    for (const slug of PACK_SLUGS) {
      const price = getPackPrice(slug);
      expect(price).not.toBeNull();
      expect(price! > 0).toBe(true);
    }
  });

  it("no pack contains duplicate (kind, slug) pairs", () => {
    for (const slug of PACK_SLUGS) {
      const seen = new Set<string>();
      for (const item of PACK_ODDS[slug].items) {
        const key = `${item.kind}:${item.slug}`;
        expect(seen.has(key), `pack ${slug} has duplicate ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe("rarity weights sum", () => {
  it("totalWeight returns the sum of all item weights", () => {
    for (const slug of PACK_SLUGS) {
      const pack = PACK_ODDS[slug];
      const expected = pack.items.reduce((s, i) => s + i.weight, 0);
      expect(totalWeight(pack)).toBe(expected);
      expect(totalWeight(pack)).toBeGreaterThan(0);
    }
  });

  it("item probabilities sum to 1.0 (within 1e-9)", () => {
    for (const slug of PACK_SLUGS) {
      const pack = PACK_ODDS[slug];
      const sum = pack.items.reduce((s, i) => s + itemProbability(pack, i), 0);
      expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
    }
  });

  it("rarity bucket probabilities sum to 1.0 (within 1e-9)", () => {
    for (const slug of PACK_SLUGS) {
      const pack = PACK_ODDS[slug];
      const sum = ALL_RARITIES.reduce((s, r) => s + rarityProbability(pack, r), 0);
      expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
    }
  });

  it("every item probability is in (0, 1] and matches weight/total", () => {
    for (const slug of PACK_SLUGS) {
      const pack = PACK_ODDS[slug];
      const total = totalWeight(pack);
      for (const item of pack.items) {
        const p = itemProbability(pack, item);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThanOrEqual(1);
        expect(p).toBeCloseTo(item.weight / total, 6);
      }
    }
  });
});

describe("rollPack statistical distribution (N=10000)", () => {
  // Use a deterministic-but-well-mixed RNG so the test is reproducible.
  // mulberry32 is fine — we just need a uniform float source.
  function mulberry32(seed: number): () => number {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Statistical tolerance: ±3σ where σ = sqrt(N * p * (1-p)) (binomial).
   * At 3σ the false-positive rate is ~0.27% per item; with ~25 items
   * across 3 packs the family-wise false-positive rate is ~7%, acceptable
   * for a non-flaky CI test. We also enforce a minimum absolute floor
   * of 3 occurrences so a 0-vs-2 outcome on a rare item doesn't trip.
   */
  function toleranceFor(expected: number): number {
    const sigma = Math.sqrt(expected * (1 - expected / 10_000));
    return Math.max(3 * sigma, 3);
  }

  it("empirical per-item frequency matches declared probability (within ±3σ)", () => {
    const N = 10_000;
    for (const slug of PACK_SLUGS) {
      const pack = PACK_ODDS[slug];
      const counts: Record<string, number> = {};
      const rng = mulberry32(slug.length * 7919 + 1);
      const buf = Buffer.alloc(16);
      for (let i = 0; i < N; i++) {
        buf.writeUInt32LE((rng() * 0xffffffff) >>> 0, 0);
        buf.writeUInt32LE((rng() * 0xffffffff) >>> 0, 4);
        const roll = rollPack(slug, () => buf);
        if (!roll) throw new Error(`rollPack returned null for ${slug}`);
        counts[roll.item.slug] = (counts[roll.item.slug] ?? 0) + 1;
      }
      for (const item of pack.items) {
        const expected = itemProbability(pack, item) * N;
        const actual = counts[item.slug] ?? 0;
        const tol = toleranceFor(expected);
        expect(Math.abs(actual - expected)).toBeLessThan(tol);
      }
    }
  });

  it("empirical rarity-bucket frequency matches declared probability (within ±3σ)", () => {
    const N = 10_000;
    for (const slug of PACK_SLUGS) {
      const pack = PACK_ODDS[slug];
      const counts: Record<string, number> = {};
      const rng = mulberry32(slug.length * 7919 + N);
      const buf = Buffer.alloc(16);
      for (let i = 0; i < N; i++) {
        buf.writeUInt32LE((rng() * 0xffffffff) >>> 0, 0);
        buf.writeUInt32LE((rng() * 0xffffffff) >>> 0, 4);
        const roll = rollPack(slug, () => buf);
        if (!roll) throw new Error(`rollPack returned null for ${slug}`);
        counts[roll.item.rarity] = (counts[roll.item.rarity] ?? 0) + 1;
      }
      for (const rarity of ALL_RARITIES) {
        const expected = rarityProbability(pack, rarity) * N;
        const actual = counts[rarity] ?? 0;
        if (expected === 0) {
          expect(actual).toBe(0);
          continue;
        }
        const tol = toleranceFor(expected);
        expect(Math.abs(actual - expected)).toBeLessThan(tol);
      }
    }
  });
});

describe("rollPack error handling", () => {
  it("returns null for an unknown pack slug", () => {
    expect(rollPack("nonexistent")).toBeNull();
  });

  it("throws if the rng returns fewer than 8 bytes", () => {
    expect(() => rollPack("tactical", () => Buffer.alloc(4))).toThrow(/at least 8 bytes/);
  });
});

describe("getOddsDisclosure", () => {
  it("returns null for unknown pack slugs", () => {
    expect(getOddsDisclosure("nonexistent")).toBeNull();
  });

  it("returns a complete disclosure with sorted rows + integrity flag", () => {
    const d = getOddsDisclosure("tactical");
    expect(d).not.toBeNull();
    expect(d!.packSlug).toBe("tactical");
    expect(d!.packName.length).toBeGreaterThan(0);
    expect(d!.totalWeight).toBeGreaterThan(0);
    expect(d!.rows.length).toBe(PACK_ODDS.tactical.items.length);
    // Rows sorted by weight descending.
    for (let i = 1; i < d!.rows.length; i++) {
      expect(d!.rows[i].weight).toBeLessThanOrEqual(d!.rows[i - 1].weight);
    }
    expect(d!.byRarity.length).toBeGreaterThan(0);
    expect(d!.integrityOk).toBe(true);
  });

  it("percentage strings parse back to the float probability (±0.1%)", () => {
    const d = getOddsDisclosure("elite");
    for (const row of d!.rows) {
      const parsed = parseFloat(row.percentage.replace("%", "")) / 100;
      expect(Math.abs(parsed - row.probability)).toBeLessThan(0.001);
    }
  });
});

describe("validateOddsIntegrity", () => {
  it("returns true for every shipped pack", () => {
    for (const slug of PACK_SLUGS) {
      expect(validateOddsIntegrity(slug), `integrity failed for ${slug}`).toBe(true);
    }
  });

  it("returns false for an unknown pack slug", () => {
    expect(validateOddsIntegrity("nonexistent")).toBe(false);
  });
});

describe("getPackConfig / getPackPrice accessors", () => {
  it("getPackConfig returns the matching config or null", () => {
    expect(getPackConfig("tactical")).toBe(PACK_ODDS.tactical);
    expect(getPackConfig("???")).toBeNull();
  });

  it("getPackPrice mirrors getPackConfig().price", () => {
    for (const slug of PACK_SLUGS) {
      expect(getPackPrice(slug)).toBe(getPackConfig(slug)!.price);
    }
    expect(getPackPrice("???")).toBeNull();
  });
});

/**
 * Backlog §2 item 43 — Seeded-RNG determinism test for pack rolls.
 *
 * rollPack accepts an `rng: () => Buffer` for exactly this reason. Two
 * calls with the same rng output (i.e. same seed) produce the same item.
 */
describe("rollPack determinism (item 43)", () => {
  it("same rng output → same roll (same item, same index, same seed)", () => {
    const fixedBuf = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    for (const slug of PACK_SLUGS) {
      const a = rollPack(slug, () => Buffer.from(fixedBuf));
      const b = rollPack(slug, () => Buffer.from(fixedBuf));
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.item.slug).toBe(b!.item.slug);
      expect(a!.index).toBe(b!.index);
      expect(a!.seed).toBe(b!.seed);
    }
  });

  it("different rng output → different roll (at least one buffer pair lands on a different item)", () => {
    // Walk a few (bufferA, bufferB) pairs across packs; assert at least one
    // pair produces a different item slug. We use buffers whose first 8
    // bytes give modular rolls in different weight buckets.
    //
    // Tactical pack (total=100) cumulative boundaries:
    //   0–29 woodland_camo, 30–54 desert_digital, 55–74 carbon_black,
    //   75–86 dice_charm, 87–96 dogtag_charm, 97–99 arctic_tiger.
    // bufA → roll=0 (woodland_camo); bufB → roll=50 (desert_digital).
    const bufA = Buffer.from("0000000000000000ffffffffffffffff", "hex"); // roll 0
    const bufB = Buffer.from("32000000000000000000000000000000", "hex"); // roll 50 (0x32 = 50)
    let anyDiffers = false;
    for (const slug of PACK_SLUGS) {
      const a = rollPack(slug, () => Buffer.from(bufA));
      const b = rollPack(slug, () => Buffer.from(bufB));
      if (a!.item.slug !== b!.item.slug || a!.index !== b!.index) {
        anyDiffers = true;
        break;
      }
    }
    expect(anyDiffers).toBe(true);
  });

  it("the seed is the hex of the rng buffer (audit trail)", () => {
    const buf = Buffer.from("deadbeefcafef00d1234567890abcdef", "hex");
    const roll = rollPack("tactical", () => Buffer.from(buf));
    expect(roll!.seed).toBe(buf.toString("hex"));
  });
});
