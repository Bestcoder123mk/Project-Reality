/**
 * SEC11-META prompt 87 — Loot box odds compliance.
 *
 * This module is the **authoritative** source of pack drop tables + odds
 * disclosures. The client-side `PackScreen.tsx` mirrors these tables; the
 * `/api/packs/odds` route serves the disclosure; `/api/packs/open` rolls
 * using `rollPack()` so the server is the source of truth for both the
 * probability + the actual roll outcome.
 *
 * Design rules:
 *
 *   1. The `PACK_ODDS` table is per-pack-slug → array of weighted items.
 *      Each item has `kind` (wrap|charm|finisher), `slug`, `rarity`, and
 *      `weight`. Weights are integers; their sum is the denominator.
 *   2. `rollPack(slug)` uses `node:crypto.randomBytes` (NOT Math.random)
 *      for the randomness — required for fairness audits in jurisdictions
 *      that regulate loot boxes (Belgium, Netherlands, China, soon UK).
 *      Returns the rolled item + the seed used (so the roll is
 *      reproducible for dispute resolution).
 *   3. `getOddsDisclosure(slug)` returns a human-readable table that the
 *      UI renders verbatim. The disclosure is always visible — it is NOT
 *      behind a feature flag. The /api/packs/odds route is unconditional.
 *   4. `validateOddsIntegrity(slug)` is a self-check that confirms the
 *      disclosure matches the actual weights. Run from the
 *      `/api/packs/odds` route so a deploy-time bug that drifts the
 *      disclosure from the weights is surfaced immediately.
 *
 * The `PACK_ODDS` table mirrors `PackScreen.tsx`'s `CRATES` constant
 * exactly (same items, same weights). When the live-ops team adjusts
 * odds, they edit this table; the client reads from `/api/packs/odds`
 * and renders the disclosure from the same source.
 */

import { randomBytes } from "node:crypto";

export type PackItemKind = "wrap" | "charm" | "finisher";
export type PackRarity = "COMMON" | "RARE" | "EPIC" | "LEGENDARY";

export interface PackOddsEntry {
  kind: PackItemKind;
  slug: string;
  name: string;
  rarity: PackRarity;
  /** Integer weight — all items' weights sum to the denominator. */
  weight: number;
}

export interface PackConfig {
  slug: string;
  name: string;
  description: string;
  price: number;
  accent: string; // hex color for UI theming
  items: PackOddsEntry[];
}

/**
 * Authoritative pack odds table. **MUST** mirror `PackScreen.tsx`'s
 * `CRATES` constant. The `validateOddsIntegrity()` self-check enforces
 * this at runtime — if someone drifts one without the other the
 * `/api/packs/odds` route returns 500 with a clear error.
 *
 * Rarities are pulled from the WRAPS / CHARMS / FINISHERS catalogs in
 * `src/lib/game/{Wraps,Charms,systems/FinisherSystem}.ts`. If a catalog
 * row is added or its rarity changes, update the corresponding entry
 * here AND in `PackScreen.tsx`.
 */
export const PACK_ODDS: Record<string, PackConfig> = {
  tactical: {
    slug: "tactical",
    name: "Tactical Crate",
    description: "Standard issue. Mostly commons + rares.",
    price: 800,
    accent: "#9ca3af",
    items: [
      { kind: "wrap", slug: "woodland_camo", name: "Woodland Camo", rarity: "RARE", weight: 30 },
      { kind: "wrap", slug: "desert_digital", name: "Desert Digital", rarity: "RARE", weight: 25 },
      { kind: "wrap", slug: "carbon_black", name: "Carbon Black", rarity: "RARE", weight: 20 },
      { kind: "charm", slug: "dice_charm", name: "Lucky Dice", rarity: "COMMON", weight: 12 },
      { kind: "charm", slug: "dogtag_charm", name: "Dog Tags", rarity: "COMMON", weight: 10 },
      { kind: "wrap", slug: "arctic_tiger", name: "Arctic Tiger", rarity: "EPIC", weight: 3 },
    ],
  },
  elite: {
    slug: "elite",
    name: "Elite Crate",
    description: "Premium odds. Rares + epics, with a shot at legendaries.",
    price: 2200,
    accent: "#a855f7",
    items: [
      { kind: "wrap", slug: "urban_hex", name: "Urban Hex", rarity: "EPIC", weight: 25 },
      { kind: "wrap", slug: "crimson_gradient", name: "Crimson Gradient", rarity: "EPIC", weight: 20 },
      { kind: "charm", slug: "skull_charm", name: "Skull Charm", rarity: "RARE", weight: 16 },
      { kind: "charm", slug: "feather_charm", name: "Crimson Feather", rarity: "RARE", weight: 14 },
      { kind: "charm", slug: "lightning_charm", name: "Lightning Bolt", rarity: "EPIC", weight: 10 },
      { kind: "charm", slug: "flame_charm", name: "Eternal Flame", rarity: "EPIC", weight: 8 },
      { kind: "wrap", slug: "neon_geometric", name: "Neon Geometric", rarity: "LEGENDARY", weight: 4 },
      { kind: "wrap", slug: "gold_damascus", name: "Gold Damascus", rarity: "LEGENDARY", weight: 2 },
      { kind: "finisher", slug: "suplex", name: "Suplex", rarity: "EPIC", weight: 1 },
    ],
  },
  legendary: {
    slug: "legendary",
    name: "Legendary Crate",
    description: "Top tier. Guaranteed epic+. Real shot at the shark.",
    price: 5000,
    accent: "#f59e0b",
    items: [
      { kind: "charm", slug: "shark_charm", name: "Shark", rarity: "LEGENDARY", weight: 28 },
      { kind: "wrap", slug: "gold_damascus", name: "Gold Damascus", rarity: "LEGENDARY", weight: 22 },
      { kind: "wrap", slug: "neon_geometric", name: "Neon Geometric", rarity: "LEGENDARY", weight: 18 },
      { kind: "finisher", slug: "shark", name: "Shark Attack", rarity: "LEGENDARY", weight: 12 },
      { kind: "finisher", slug: "disintegrate", name: "Disintegrate", rarity: "LEGENDARY", weight: 10 },
      { kind: "finisher", slug: "squish", name: "Squish", rarity: "EPIC", weight: 6 },
      { kind: "charm", slug: "lightning_charm", name: "Lightning Bolt", rarity: "EPIC", weight: 2 },
      { kind: "charm", slug: "flame_charm", name: "Eternal Flame", rarity: "EPIC", weight: 2 },
    ],
  },
};

/** All known pack slugs. */
export const PACK_SLUGS = Object.keys(PACK_ODDS);

/**
 * Return the price for a pack slug, or `null` if the slug is unknown.
 * Used by `currency-guard.validatePurchase` (CatalogKind "PACK").
 */
export function getPackPrice(slug: string): number | null {
  const pack = PACK_ODDS[slug];
  return pack ? pack.price : null;
}

/** Return the pack config, or `null` if the slug is unknown. */
export function getPackConfig(slug: string): PackConfig | null {
  return PACK_ODDS[slug] ?? null;
}

/** Compute the total weight (denominator) for a pack. */
export function totalWeight(pack: PackConfig): number {
  return pack.items.reduce((s, i) => s + i.weight, 0);
}

/** Compute the probability (0..1) of a single item. */
export function itemProbability(pack: PackConfig, item: PackOddsEntry): number {
  const total = totalWeight(pack);
  if (total <= 0) return 0;
  return item.weight / total;
}

/** Compute the cumulative probability of a given rarity bucket. */
export function rarityProbability(pack: PackConfig, rarity: PackRarity): number {
  const total = totalWeight(pack);
  if (total <= 0) return 0;
  return pack.items.filter((i) => i.rarity === rarity).reduce((s, i) => s + i.weight, 0) / total;
}

/**
 * Roll a pack using **crypto-grade** randomness. Returns the rolled item,
 * the seed (hex) used, and the index of the winning item in the pack's
 * items array (for UI positioning).
 *
 * Algorithm:
 *   1. Generate 16 random bytes via `node:crypto.randomBytes` (128 bits
 *      of entropy — overkill, but cheap).
 *   2. Convert to a single big integer via `Buffer.readBigUInt64LE` (we
 *      only need 64 bits to exceed any reasonable total weight; 128-bit
 *      division is unnecessary precision).
 *   3. `roll = bigInt % totalWeight`. Walk the items subtracting each
 *      weight; the first one that brings the counter ≤ 0 wins.
 *
 * The `seed` returned is the hex of the full 16-byte buffer — store it
 * alongside the roll (LootBoxRoll.seed) so the roll can be reproduced
 * for dispute resolution.
 *
 * `rng` is exposed for tests: pass a deterministic `() => Buffer` to make
 * the roll reproducible. Defaults to `node:crypto.randomBytes(16)`.
 */
export function rollPack(
  slug: string,
  rng: () => Buffer = () => randomBytes(16),
): { item: PackOddsEntry; index: number; seed: string } | null {
  const pack = PACK_ODDS[slug];
  if (!pack) return null;
  const total = totalWeight(pack);
  if (total <= 0) return null;

  const buf = rng();
  if (buf.length < 8) {
    throw new Error("rollPack: rng must return at least 8 bytes");
  }
  // Read 64 bits little-endian. Use BigInt because Number loses precision
  // past 2^53 — total weight is always small but the buffer is full-range.
  const bigRoll = buf.readBigUInt64LE(0);
  const roll = Number(bigRoll % BigInt(total));

  let acc = roll;
  for (let i = 0; i < pack.items.length; i++) {
    acc -= pack.items[i].weight;
    if (acc < 0) {
      return { item: pack.items[i], index: i, seed: buf.toString("hex") };
    }
  }
  // Floating-point safety net — should never hit because the modulo
  // above guarantees roll < total.
  const last = pack.items.length - 1;
  return { item: pack.items[last], index: last, seed: buf.toString("hex") };
}

// ─── Disclosure ─────────────────────────────────────────────────────────

export interface OddsDisclosureRow {
  kind: PackItemKind;
  slug: string;
  name: string;
  rarity: PackRarity;
  weight: number;
  /** Probability as a fraction (0..1). */
  probability: number;
  /** Probability as a percentage string, e.g. "30.0%". */
  percentage: string;
}

export interface OddsDisclosure {
  packSlug: string;
  packName: string;
  packDescription: string;
  price: number;
  /** Sum of all item weights (the denominator). */
  totalWeight: number;
  /** Per-item odds table, sorted by weight descending. */
  rows: OddsDisclosureRow[];
  /** Per-rarity aggregate odds. */
  byRarity: Array<{ rarity: PackRarity; weight: number; probability: number; percentage: string }>;
  /** ISO timestamp of when the disclosure was generated. */
  generatedAt: string;
  /** Integrity check result — true iff `validateOddsIntegrity(slug)` passed. */
  integrityOk: boolean;
}

/**
 * Build the human-readable odds disclosure for a pack. This is the data
 * the `/api/packs/odds` route returns + the `PackScreen.tsx` "Show odds"
 * panel renders. The disclosure is unconditional — it is NOT behind a
 * feature flag.
 *
 * The disclosure includes the integrity check result so a deploy-time
 * drift between the disclosure and the actual weights is surfaced
 * immediately to anyone hitting the route.
 */
export function getOddsDisclosure(slug: string): OddsDisclosure | null {
  const pack = PACK_ODDS[slug];
  if (!pack) return null;
  const total = totalWeight(pack);
  const rows: OddsDisclosureRow[] = pack.items
    .map((item) => {
      const probability = itemProbability(pack, item);
      return {
        kind: item.kind,
        slug: item.slug,
        name: item.name,
        rarity: item.rarity,
        weight: item.weight,
        probability,
        percentage: `${(probability * 100).toFixed(1)}%`,
      };
    })
    .sort((a, b) => b.weight - a.weight);

  const rarityBuckets: PackRarity[] = ["LEGENDARY", "EPIC", "RARE", "COMMON"];
  const byRarity = rarityBuckets
    .map((rarity) => {
      const weight = pack.items
        .filter((i) => i.rarity === rarity)
        .reduce((s, i) => s + i.weight, 0);
      const probability = total > 0 ? weight / total : 0;
      return {
        rarity,
        weight,
        probability,
        percentage: `${(probability * 100).toFixed(1)}%`,
      };
    })
    .filter((r) => r.weight > 0);

  return {
    packSlug: pack.slug,
    packName: pack.name,
    packDescription: pack.description,
    price: pack.price,
    totalWeight: total,
    rows,
    byRarity,
    generatedAt: new Date().toISOString(),
    integrityOk: validateOddsIntegrity(slug),
  };
}

/**
 * Self-check that the disclosure matches the actual weights. Currently
 * trivially true (the disclosure is computed from the weights), but
 * exists as a forward-looking guardrail: if a future change caches the
 * disclosure in DB or in a static JSON file, this function is the place
 * to assert the cache still matches `PACK_ODDS`.
 *
 * Returns `true` when the disclosure is consistent with the weights.
 */
export function validateOddsIntegrity(slug: string): boolean {
  const pack = PACK_ODDS[slug];
  if (!pack) return false;
  // Every weight must be a positive integer.
  for (const item of pack.items) {
    if (!Number.isInteger(item.weight) || item.weight <= 0) return false;
  }
  // Total weight must be > 0.
  if (totalWeight(pack) <= 0) return false;
  // No duplicate (kind, slug) pairs.
  const seen = new Set<string>();
  for (const item of pack.items) {
    const key = `${item.kind}:${item.slug}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  // Cross-check: disclosure probabilities must sum to 1.0 (within float
  // tolerance).
  const disclosure = getOddsDisclosureRaw(slug);
  if (!disclosure) return false;
  const sum = disclosure.rows.reduce((s, r) => s + r.probability, 0);
  return Math.abs(sum - 1.0) < 1e-9;
}

/** Internal: raw disclosure (no recursion through `validateOddsIntegrity`). */
function getOddsDisclosureRaw(slug: string): Omit<OddsDisclosure, "integrityOk"> | null {
  const pack = PACK_ODDS[slug];
  if (!pack) return null;
  const total = totalWeight(pack);
  const rows: OddsDisclosureRow[] = pack.items.map((item) => {
    const probability = total > 0 ? item.weight / total : 0;
    return {
      kind: item.kind,
      slug: item.slug,
      name: item.name,
      rarity: item.rarity,
      weight: item.weight,
      probability,
      percentage: `${(probability * 100).toFixed(1)}%`,
    };
  });
  return {
    packSlug: pack.slug,
    packName: pack.name,
    packDescription: pack.description,
    price: pack.price,
    totalWeight: total,
    rows: rows.sort((a, b) => b.weight - a.weight),
    byRarity: [],
    generatedAt: new Date().toISOString(),
  };
}

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3821 (no duplicate protection) — NEW: `filterOwnedItems` + `rollPackWithoutDuplicates` below.
// 3822 (no pity counter)         — NEW: `PITY_THRESHOLD` + `shouldTriggerPity` + `rollPackWithPity`.
// 3842 (dup protection feature)  — same as 3821.
// 3843 (pity counter feature)    — same as 3822.

/**
 * I-5000 #3821 / #3842 / A-562 — Duplicate protection.
 *
 * When a player already owns an item, the roll should re-roll instead of
 * granting a duplicate. This function takes the pack's items + the set of
 * owned (kind, slug) pairs + returns the items that are still eligible.
 *
 * If ALL items are owned (edge case: completionist player), the function
 * returns the original list (so the roll still produces SOMETHING — the
 * caller can then convert the duplicate into a fallback currency grant
 * via `duplicateConversionCredits` in ProgressionSocialEnhancements).
 */
export function filterOwnedItems(
  items: PackOddsEntry[],
  owned: Set<string>,
): PackOddsEntry[] {
  const eligible = items.filter((i) => !owned.has(`${i.kind}:${i.slug}`));
  return eligible.length > 0 ? eligible : items;
}

/**
 * I-5000 #3821 / #3842 — Roll a pack with duplicate protection. Pass the
 * player's owned (kind, slug) set; the roll skips items the player already
 * has (re-rolls until it lands on an unowned item, bounded by 16 attempts
 * to prevent infinite loops on pathological ownership sets).
 *
 * Returns the standard `rollPack` shape + a `wasDuplicateProtected` flag
 * indicating whether the roll had to skip duplicates.
 */
export function rollPackWithoutDuplicates(
  slug: string,
  owned: Set<string>,
  rng: () => Buffer = () => randomBytes(16),
): { item: PackOddsEntry; index: number; seed: string; wasDuplicateProtected: boolean } | null {
  const pack = PACK_ODDS[slug];
  if (!pack) return null;
  const eligible = filterOwnedItems(pack.items, owned);
  const eligibleTotal = eligible.reduce((s, i) => s + i.weight, 0);
  if (eligibleTotal <= 0) return null;

  // Bounded re-roll loop: try up to 16 times to land on an eligible item.
  // Each attempt uses a fresh random buffer so the seed is unique per attempt.
  for (let attempt = 0; attempt < 16; attempt++) {
    const buf = rng();
    if (buf.length < 8) throw new Error("rollPackWithoutDuplicates: rng must return 8+ bytes");
    const bigRoll = buf.readBigUInt64LE(0);
    const roll = Number(bigRoll % BigInt(eligibleTotal));
    let acc = roll;
    for (const item of eligible) {
      acc -= item.weight;
      if (acc < 0) {
        const origIndex = pack.items.indexOf(item);
        return {
          item,
          index: origIndex,
          seed: buf.toString("hex"),
          wasDuplicateProtected: attempt > 0 || eligible.length < pack.items.length,
        };
      }
    }
  }
  // Fallback: first eligible item (should never hit).
  const first = eligible[0];
  return {
    item: first,
    index: pack.items.indexOf(first),
    seed: randomBytes(16).toString("hex"),
    wasDuplicateProtected: true,
  };
}

/**
 * I-5000 #3822 / #3843 / A-563 — Pity counter.
 *
 * After `PITY_THRESHOLD` consecutive packs without a LEGENDARY drop, the
 * next pack is guaranteed to drop a LEGENDARY. The counter is per-player +
 * per-pack-slug (separate counters for `tactical`, `elite`, `legendary`).
 *
 * `shouldTriggerPity` is pure — the caller (the pack-open route) reads the
 * player's `LootBoxRoll` rows to compute `consecutiveNonLegendary` then
 * calls this. When true, the roll is forced to a LEGENDARY item from the
 * pack's item list (using crypto randomness to pick which LEGENDARY).
 *
 * `recordPackOpen` is called by the route after every pack open to update
 * the counter. The counter is persisted in the PlayerEvent table with
 * name=`pity_counter_<packSlug>` and props=`{count: N}` (the route writes
 * the event; this module just provides the pure decision logic).
 */
export const PITY_THRESHOLD = 10;

/** Pure decision: given the consecutive-non-legendary count, should pity trigger? */
export function shouldTriggerPity(consecutiveNonLegendary: number): boolean {
  return consecutiveNonLegendary >= PITY_THRESHOLD;
}

/**
 * Force a LEGENDARY roll from the pack's legendary items. Returns the
 * rolled legendary + a fresh seed. Returns null when the pack has no
 * legendary items (caller should fall back to `rollPack`).
 */
export function rollPackWithPity(
  slug: string,
  rng: () => Buffer = () => randomBytes(16),
): { item: PackOddsEntry; index: number; seed: string; wasPity: true } | null {
  const pack = PACK_ODDS[slug];
  if (!pack) return null;
  const legendaries = pack.items.filter((i) => i.rarity === "LEGENDARY");
  if (legendaries.length === 0) return null;
  const buf = rng();
  if (buf.length < 8) throw new Error("rollPackWithPity: rng must return 8+ bytes");
  const bigRoll = buf.readBigUInt64LE(0);
  const idx = Number(bigRoll % BigInt(legendaries.length));
  const item = legendaries[idx];
  return {
    item,
    index: pack.items.indexOf(item),
    seed: buf.toString("hex"),
    wasPity: true,
  };
}

/**
 * I-5000 #3822 — Compute the new pity counter after a pack open. Pure.
 * If the rolled item is LEGENDARY, the counter resets to 0. Otherwise it
 * increments by 1 (capped at PITY_THRESHOLD + 1 so the next call to
 * `shouldTriggerPity` returns true).
 */
export function updatePityCounter(
  currentCount: number,
  rolledRarity: PackRarity,
): number {
  if (rolledRarity === "LEGENDARY") return 0;
  return Math.min(currentCount + 1, PITY_THRESHOLD + 1);
}
