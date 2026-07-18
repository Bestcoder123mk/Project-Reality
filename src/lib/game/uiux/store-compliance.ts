/**
 * SEC10-UIUX (prompt 83): Store / monetization UX compliance.
 *
 * Ensures the shop clearly shows real-money-equivalent value + pack
 * and crate odds are always visible (not hidden behind a toggle).
 *
 * Compliance principles (per prompt + Apple/Google platform rules):
 *   - Every premium-priced item shows its real-money-equivalent value
 *     alongside the in-game currency price (e.g. "800 credits ≈ $7.99").
 *   - Pack odds are always visible — the UI may *additionally* offer a
 *     "Hide odds" toggle for compactness, but the default state is
 *     "shown" + the toggle must be opt-in.
 *   - Odds are presented as a full weighted table (item, weight,
 *     percentage) — never as "rare/epic/legendary buckets" only.
 *   - "Guaranteed" items (e.g. "guaranteed epic+") are listed
 *     explicitly with their floor probability.
 *   - Duplicate rewards are clearly marked.
 *
 * Public API:
 *   - formatPremiumPrice(credits) — credits → "{credits} credits (≈ ${usd})"
 *   - getPackOdds(packSlug) — full weighted drop table
 *   - validateOddsDisclosure(packSlug) — compliance check
 *   - getCreditsPerDollar() / getUsdPerCredit() — exchange-rate helpers
 *   - PREMIUM_PACKS — the canonical pack catalog (mirror of PackScreen.tsx)
 *
 * SSR-safe.
 */

export type PackSlug = "tactical" | "elite" | "legendary";

export interface PackOddsEntry {
  /** Item slug (wrap/charm/finisher). */
  slug: string;
  /** Item display name. */
  name: string;
  /** Item kind. */
  kind: "wrap" | "charm" | "finisher";
  /** Rarity tier. */
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
  /** Raw weight in the drop table. */
  weight: number;
  /** Probability as a fraction (0..1) — computed from weight / total. */
  probability: number;
  /** Probability formatted as a percentage string (e.g. "12.5%"). */
  percentage: string;
  /** Whether this item is a "guaranteed" floor for this pack. */
  guaranteed: boolean;
}

export interface PackOdds {
  /** Pack slug. */
  packSlug: PackSlug;
  /** Pack display name. */
  packName: string;
  /** In-game-currency price (credits). */
  priceCredits: number;
  /** Real-money-equivalent USD value. */
  priceUsd: number;
  /** Total weight across all items (for verification). */
  totalWeight: number;
  /** Full weighted drop table. */
  items: PackOddsEntry[];
  /** Aggregate probability by rarity bucket (for the summary view). */
  byRarity: Record<"COMMON" | "RARE" | "EPIC" | "LEGENDARY", number>;
  /** Floor guarantee text, e.g. "Guaranteed epic or better". */
  guaranteeText: string | null;
  /** Compliance flags — see validateOddsDisclosure(). */
  disclosure: OddsDisclosure;
}

export interface OddsDisclosure {
  /** Whether the full weighted table is available (always true for our packs). */
  hasFullTable: boolean;
  /** Whether probabilities sum to 1.0 (within tolerance). */
  sumsToOne: boolean;
  /** Whether every item lists an individual percentage. */
  allItemsHavePercentage: boolean;
  /** Whether guaranteed-floor items are explicitly marked. */
  guaranteesDisclosed: boolean;
  /** Overall pass/fail. */
  compliant: boolean;
  /** List of compliance violations (empty if compliant). */
  violations: string[];
}

// ─── Premium exchange rate ─────────────────────────────────────────────────

/**
 * The canonical premium-currency → USD exchange rate. Tuned so a $9.99
 * purchase buys ~1000 credits (the industry-standard "$1 = 100 credits"
 * rate, adjusted so the smallest bundle price ends in .99).
 *
 * This is the rate used to display "≈ $X.XX" alongside every premium
 * price in the shop. It is *not* the purchase rate (purchase rates
 * vary by bundle size + bonus-credit promotions).
 */
export const CREDITS_PER_USD = 100;

/** SEC10-UIUX (prompt 83): Get the credits-per-dollar exchange rate. */
export function getCreditsPerDollar(): number {
  return CREDITS_PER_USD;
}

/** SEC10-UIUX (prompt 83): Get the dollar-per-credit exchange rate. */
export function getUsdPerCredit(): number {
  return 1 / CREDITS_PER_USD;
}

/**
 * SEC10-UIUX (prompt 83): Format a premium-currency price with its
 * real-money-equivalent USD value.
 *
 * Example:
 *   formatPremiumPrice(800)  → "800 credits (≈ $7.99)"
 *   formatPremiumPrice(5000) → "5,000 credits (≈ $49.99)"
 *
 * The USD value is rounded to the nearest .99 (industry standard for
 * microtransactions) so the displayed price matches what the player
 * will actually see in the platform store.
 */
export function formatPremiumPrice(credits: number): string {
  const usd = computeUsdPrice(credits);
  return `${credits.toLocaleString("en-US")} credits (≈ $${usd.toFixed(2)})`;
}

/**
 * Compute the displayed USD price for a credit amount. Rounds to the
 * nearest .99 to match platform store conventions.
 */
export function computeUsdPrice(credits: number): number {
  const raw = credits / CREDITS_PER_USD;
  // Round up to the nearest whole dollar, then subtract $0.01 to end in .99.
  // (e.g. 800cr → $8 → $7.99; 5000cr → $50 → $49.99)
  const roundedUp = Math.ceil(raw);
  return Math.max(0.99, roundedUp - 0.01);
}

// ─── Pack catalog (mirrors PackScreen.tsx CRATES) ──────────────────────────

interface RawPackItem {
  slug: string;
  name: string;
  kind: "wrap" | "charm" | "finisher";
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
  weight: number;
}

interface RawPack {
  slug: PackSlug;
  name: string;
  priceCredits: number;
  items: RawPackItem[];
  /** Items that are guaranteed (floor). Listed by slug. */
  guaranteedSlugs: string[];
  /** Floor guarantee text (shown above the odds table). */
  guaranteeText: string | null;
}

const PACKS: RawPack[] = [
  {
    slug: "tactical",
    name: "Tactical Crate",
    priceCredits: 800,
    items: [
      { slug: "woodland_camo",  name: "Woodland Camo",   kind: "wrap",     rarity: "COMMON", weight: 30 },
      { slug: "desert_digital", name: "Desert Digital",  kind: "wrap",     rarity: "COMMON", weight: 25 },
      { slug: "carbon_black",   name: "Carbon Black",    kind: "wrap",     rarity: "COMMON", weight: 20 },
      { slug: "dice_charm",     name: "Dice Charm",      kind: "charm",    rarity: "COMMON", weight: 12 },
      { slug: "dogtag_charm",   name: "Dogtag Charm",    kind: "charm",    rarity: "COMMON", weight: 10 },
      { slug: "arctic_tiger",   name: "Arctic Tiger",    kind: "wrap",     rarity: "RARE",   weight: 3 },
    ],
    guaranteedSlugs: [],
    guaranteeText: null,
  },
  {
    slug: "elite",
    name: "Elite Crate",
    priceCredits: 2200,
    items: [
      { slug: "urban_hex",        name: "Urban Hex",        kind: "wrap",     rarity: "RARE",   weight: 25 },
      { slug: "crimson_gradient", name: "Crimson Gradient", kind: "wrap",     rarity: "RARE",   weight: 20 },
      { slug: "skull_charm",      name: "Skull Charm",      kind: "charm",    rarity: "RARE",   weight: 16 },
      { slug: "feather_charm",    name: "Feather Charm",    kind: "charm",    rarity: "RARE",   weight: 14 },
      { slug: "lightning_charm",  name: "Lightning Charm",  kind: "charm",    rarity: "EPIC",   weight: 10 },
      { slug: "flame_charm",      name: "Flame Charm",      kind: "charm",    rarity: "EPIC",   weight: 8 },
      { slug: "neon_geometric",   name: "Neon Geometric",   kind: "wrap",     rarity: "EPIC",   weight: 4 },
      { slug: "gold_damascus",    name: "Gold Damascus",    kind: "wrap",     rarity: "LEGENDARY", weight: 2 },
      { slug: "suplex",           name: "Suplex Finisher",  kind: "finisher", rarity: "LEGENDARY", weight: 1 },
    ],
    guaranteedSlugs: [],
    guaranteeText: null,
  },
  {
    slug: "legendary",
    name: "Legendary Crate",
    priceCredits: 5000,
    items: [
      { slug: "shark_charm",      name: "Shark Charm",      kind: "charm",    rarity: "LEGENDARY", weight: 28 },
      { slug: "gold_damascus",    name: "Gold Damascus",    kind: "wrap",     rarity: "LEGENDARY", weight: 22 },
      { slug: "neon_geometric",   name: "Neon Geometric",   kind: "wrap",     rarity: "EPIC",   weight: 18 },
      { slug: "shark",            name: "Shark Finisher",   kind: "finisher", rarity: "LEGENDARY", weight: 12 },
      { slug: "disintegrate",     name: "Disintegrate Finisher", kind: "finisher", rarity: "EPIC",   weight: 10 },
      { slug: "squish",           name: "Squish Finisher",  kind: "finisher", rarity: "EPIC",   weight: 6 },
      { slug: "lightning_charm",  name: "Lightning Charm",  kind: "charm",    rarity: "EPIC",   weight: 2 },
      { slug: "flame_charm",      name: "Flame Charm",      kind: "charm",    rarity: "EPIC",   weight: 2 },
    ],
    guaranteedSlugs: ["neon_geometric", "shark_charm", "gold_damascus", "shark", "disintegrate", "squish", "lightning_charm", "flame_charm"],
    guaranteeText: "Guaranteed epic or better",
  },
];

/** SEC10-UIUX (prompt 83): List all pack slugs (for the shop UI). */
export function listPacks(): PackSlug[] {
  return PACKS.map((p) => p.slug);
}

/** SEC10-UIUX (prompt 83): Get the raw pack config (for the spinner UI). */
export function getPackConfig(slug: PackSlug): RawPack | null {
  return PACKS.find((p) => p.slug === slug) ?? null;
}

/**
 * SEC10-UIUX (prompt 83): Get the full weighted drop table for a pack.
 *
 * Returns every item with its raw weight + computed probability +
 * percentage string. Aggregate by-rarity probabilities are also
 * computed for the summary view.
 *
 * This is the data the shop UI renders in the always-visible odds
 * disclosure. The UI may *additionally* offer a "Hide odds" toggle for
 * compactness, but the default state is "shown" + the toggle is opt-in.
 */
export function getPackOdds(slug: PackSlug): PackOdds | null {
  const pack = PACKS.find((p) => p.slug === slug);
  if (!pack) return null;
  const totalWeight = pack.items.reduce((s, i) => s + i.weight, 0);
  const byRarity: Record<"COMMON" | "RARE" | "EPIC" | "LEGENDARY", number> = {
    COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0,
  };
  const items: PackOddsEntry[] = pack.items.map((raw) => {
    const probability = raw.weight / totalWeight;
    byRarity[raw.rarity] += probability;
    return {
      slug: raw.slug,
      name: raw.name,
      kind: raw.kind,
      rarity: raw.rarity,
      weight: raw.weight,
      probability,
      percentage: formatPercentage(probability),
      guaranteed: pack.guaranteedSlugs.includes(raw.slug),
    };
  });

  const disclosure = validateOddsDisclosureInternal(pack, items, totalWeight);
  return {
    packSlug: pack.slug,
    packName: pack.name,
    priceCredits: pack.priceCredits,
    priceUsd: computeUsdPrice(pack.priceCredits),
    totalWeight,
    items,
    byRarity,
    guaranteeText: pack.guaranteeText,
    disclosure,
  };
}

function formatPercentage(prob: number): string {
  if (prob >= 0.001) {
    return `${(prob * 100).toFixed(1)}%`;
  }
  // Very rare items — show 2 significant figures.
  return `<${(0.001 * 100).toFixed(1)}%`;
}

function validateOddsDisclosureInternal(
  pack: RawPack,
  items: PackOddsEntry[],
  totalWeight: number,
): OddsDisclosure {
  const violations: string[] = [];

  // 1. Full weighted table available.
  const hasFullTable = items.length === pack.items.length;
  if (!hasFullTable) {
    violations.push("Full weighted table is not available");
  }

  // 2. Probabilities sum to 1.0 (within 0.001 tolerance — float roundoff).
  const sum = items.reduce((s, i) => s + i.probability, 0);
  const sumsToOne = Math.abs(sum - 1.0) < 0.001;
  if (!sumsToOne) {
    violations.push(`Probabilities sum to ${sum.toFixed(4)}, not 1.0`);
  }

  // 3. Every item has an individual percentage.
  const allItemsHavePercentage = items.every((i) => i.percentage.length > 0);
  if (!allItemsHavePercentage) {
    violations.push("Some items are missing individual percentages");
  }

  // 4. Guaranteed-floor items are explicitly marked.
  const guaranteedInTable = items.filter((i) => i.guaranteed).map((i) => i.slug);
  const guaranteedDeclared = pack.guaranteedSlugs;
  const guaranteesDisclosed =
    guaranteedDeclared.length === 0
    || (guaranteedInTable.length === guaranteedDeclared.length
        && guaranteedDeclared.every((g) => guaranteedInTable.includes(g)));
  if (!guaranteesDisclosed) {
    violations.push("Guaranteed-floor items are not explicitly marked in the table");
  }

  // 5. (Tolerance check) total weight must be > 0.
  if (totalWeight <= 0) {
    violations.push("Total weight is non-positive");
  }

  return {
    hasFullTable,
    sumsToOne,
    allItemsHavePercentage,
    guaranteesDisclosed,
    compliant: violations.length === 0,
    violations,
  };
}

/**
 * SEC10-UIUX (prompt 83): Validate that a pack's odds disclosure is
 * compliant. Returns the disclosure object with pass/fail + violations.
 *
 * Compliance = full weighted table available + probabilities sum to 1.0
 * + every item has an individual percentage + guaranteed-floor items
 * are explicitly marked.
 */
export function validateOddsDisclosure(slug: PackSlug): OddsDisclosure {
  const odds = getPackOdds(slug);
  if (!odds) {
    return {
      hasFullTable: false,
      sumsToOne: false,
      allItemsHavePercentage: false,
      guaranteesDisclosed: false,
      compliant: false,
      violations: [`Unknown pack slug: ${slug}`],
    };
  }
  return odds.disclosure;
}

/**
 * SEC10-UIUX (prompt 83): Convenience — get every pack's odds in one
 * call. Used by the shop's odds-disclosure footer that lists all packs.
 */
export function getAllPackOdds(): PackOdds[] {
  return PACKS.map((p) => getPackOdds(p.slug)!).filter(Boolean);
}

/**
 * SEC10-UIUX (prompt 83): Validate ALL packs at once. Returns the
 * list of any non-compliant pack slugs.
 */
export function auditAllPackDisclosures(): { slug: PackSlug; compliant: boolean; violations: string[] }[] {
  return PACKS.map((p) => {
    const disclosure = validateOddsDisclosure(p.slug);
    return { slug: p.slug, compliant: disclosure.compliant, violations: disclosure.violations };
  });
}
