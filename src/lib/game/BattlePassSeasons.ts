import { db } from "@/lib/db";

/**
 * P5.3: Battle Pass Season Rotation.
 *
 * The base schema (BattlePassSeason) supports multiple seasons but the
 * seed only created season 1. P5.3 adds:
 *   - Automatic season rotation: when a season's end date passes, the
 *     next season becomes active and the old one is archived.
 *   - Season creation helper: create a new season with default tiers
 *     (50 free + 50 premium, mirroring the season 1 pattern).
 *   - Player carry-over: when a new season activates, players get a
 *     fresh PlayerBattlePass row (xp=0, premium=false, claimed=[]).
 *
 * Implementation: this module exposes pure functions that the API
 * routes call. There's no cron job — rotation is triggered on first
 * /api/battlepass GET of a new day (lazy rotation).
 */

export interface SeasonRotationResult {
  rotated: boolean;
  activeSeasonId: string;
  activeSeasonNumber: number;
}

/**
 * Check if the active season has ended and rotate to the next one if so.
 * Idempotent — safe to call on every battlepass API request.
 */
export async function rotateSeasonIfNeeded(): Promise<SeasonRotationResult> {
  const activeSeasons = await db.battlePassSeason.findMany({
    where: { active: true },
    orderBy: { season: "desc" },
  });
  if (activeSeasons.length === 0) {
    // No active season — create season 1 (shouldn't happen post-seed, but safe).
    const s = await createNewSeason(1, "Season 1");
    return { rotated: true, activeSeasonId: s.id, activeSeasonNumber: 1 };
  }
  const current = activeSeasons[0];
  // Check if season should rotate — for now, rotate every 30 days.
  // (In production this would be driven by an `endDate` field.)
  const ageMs = Date.now() - current.createdAt.getTime();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (ageMs < thirtyDays) {
    return { rotated: false, activeSeasonId: current.id, activeSeasonNumber: current.season };
  }
  // Rotate: deactivate current, create next.
  await db.battlePassSeason.update({ where: { id: current.id }, data: { active: false } });
  const next = await createNewSeason(current.season + 1, `Season ${current.season + 1}`);
  // Carry over premium status for all players who had premium in the old season.
  const oldProgress = await db.playerBattlePass.findMany({ where: { seasonId: current.id, premium: true } });
  for (const p of oldProgress) {
    await db.playerBattlePass.upsert({
      where: { playerId_seasonId: { playerId: p.playerId, seasonId: next.id } },
      create: { playerId: p.playerId, seasonId: next.id, xp: 0, premium: true, claimedTiers: "[]" },
      update: { premium: true },
    });
  }
  return { rotated: true, activeSeasonId: next.id, activeSeasonNumber: next.season };
}

/**
 * Create a new season with 100 tier rows (50 free-track + 50 premium-track
 * rows, one per (tier, isPremium) pair), mirroring the season 1 reward
 * pattern. Called by rotateSeasonIfNeeded.
 *
 * I-5000 #3854 / A-38 — the prior docstring said "100 tiers (50 free + 50
 * premium)" but the loop only pushed ONE entry per tier (50 rows total)
 * because each tier branch was `if/else if` — only one of free/premium
 * won. Fixed: each tier now pushes BOTH a free-track row AND a
 * premium-track row, producing 100 rows total (matching the docstring).
 */
export async function createNewSeason(seasonNumber: number, name: string) {
  const season = await db.battlePassSeason.create({
    data: {
      season: seasonNumber,
      name,
      startXp: 0,
      tierSize: 1000,
      maxTier: 50,
      premiumPrice: 950,
      active: true,
    },
  });
  // Generate tiers. I-5000 #3854 — 100 rows total: for each of the 50
  // tiers, push BOTH a free-track row AND a premium-track row.
  const tierData: Array<{ seasonId: string; tier: number; rewardType: any; rewardSlug: string; rewardAmount: number; isPremium: boolean }> = [];
  for (let tier = 1; tier <= 50; tier++) {
    // ─── Free track ──────────────────────────────────────────────────
    // Every 5th free tier gives credits; others give small XP boosts.
    if (tier % 10 === 0) {
      tierData.push({ seasonId: season.id, tier, rewardType: "CREDITS", rewardSlug: "credits", rewardAmount: 200 + tier * 10, isPremium: false });
    } else if (tier % 5 === 0) {
      tierData.push({ seasonId: season.id, tier, rewardType: "CREDITS", rewardSlug: "credits", rewardAmount: 100 + tier * 5, isPremium: false });
    } else {
      tierData.push({ seasonId: season.id, tier, rewardType: "XP_BOOST", rewardSlug: "xp_boost_small", rewardAmount: 50, isPremium: false });
    }
    // ─── Premium track ───────────────────────────────────────────────
    if (tier === 25) {
      tierData.push({ seasonId: season.id, tier, rewardType: "WEAPON", rewardSlug: "m4", rewardAmount: 1, isPremium: true });
    } else if (tier === 50) {
      tierData.push({ seasonId: season.id, tier, rewardType: "SKIN", rewardSlug: "gold", rewardAmount: 1, isPremium: true });
    } else if (tier % 7 === 0) {
      tierData.push({ seasonId: season.id, tier, rewardType: "ATTACHMENT", rewardSlug: tier % 14 === 0 ? "scope8x" : "suppressor", rewardAmount: 1, isPremium: true });
    } else {
      tierData.push({ seasonId: season.id, tier, rewardType: "CREDITS", rewardSlug: "credits", rewardAmount: 150 + tier * 8, isPremium: true });
    }
  }
  await db.battlePassTier.createMany({ data: tierData });
  return season;
}

/**
 * Get the active season, rotating if needed. Called by /api/battlepass.
 */
export async function getActiveSeason() {
  const { activeSeasonId } = await rotateSeasonIfNeeded();
  return db.battlePassSeason.findUnique({
    where: { id: activeSeasonId },
    include: { tiers: { orderBy: { tier: "asc" } } },
  });
}

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3847 (BP premium preview)    — NEW: `getPremiumPreview` below.
// 3848 (tier-skip purchase)    — NEW: `TIER_SKIP_PRICE` + `computeTierSkipCost` below.
// 3849 (weekly challenges on BP) — NEW: `BATTLE_PASS_WEEKLY_CHALLENGES` below.
// 3850 (catch-up mechanic)     — NEW: `CATCH_UP_CONFIG` + `computeCatchUpXp` below.
// 3851 (alliance/clan pass)    — NEW: `CLAN_PASS_CONFIG` below.
// 3852 (auto-claim premium on rollover) — DONE in seasonal-rollover.ts:autoClaimUnclaimedRewards.
// 3853 (30-day heuristic)      — DONE in seasonal-rollover.ts:shouldRotateSeason (uses endsAt when set).
// 3854 (createNewSeason 50 vs 100) — DONE: fixed above to push BOTH free + premium per tier.
// 3855 (rewardSlug free-text → relation) — DEFERRED: schema change (prisma/schema.prisma not in I-5000 ownership).
// 3856 (claimedTiers JSON → Postgres Json) — DEFERRED: schema change (same).
// 3857 (next tier in X XP UI)  — NEW: `nextTierInXp` below.
// 3858 (XP source breakdown)   — NEW: `BATTLE_PASS_XP_SOURCES` + `formatXpBreakdown` below.
// 3905–4000 (BP reward-type catalog) — NEW: `BATTLE_PASS_REWARD_TYPES` below.

/**
 * I-5000 #3847 — Premium preview. Returns the premium-track rewards the
 * player WOULD unlock if they purchased premium right now (based on their
 * current tier). The UI uses this to render the "Buy Premium to unlock X"
 * upsell. Does NOT grant the rewards — just previews them.
 */
export async function getPremiumPreview(playerId: string): Promise<{
  currentTier: number;
  purchasableTiers: Array<{ tier: number; rewardType: string; rewardSlug: string; rewardAmount: number }>;
}> {
  const season = await getActiveSeason();
  if (!season) return { currentTier: 0, purchasableTiers: [] };
  const bp = await db.playerBattlePass.findUnique({
    where: { playerId_seasonId: { playerId, seasonId: season.id } },
  });
  const currentTier = bp ? Math.min(season.maxTier, Math.floor(bp.xp / season.tierSize)) : 0;
  const purchasableTiers = season.tiers
    .filter((t) => t.isPremium && t.tier <= currentTier)
    .map((t) => ({
      tier: t.tier,
      rewardType: t.rewardType,
      rewardSlug: t.rewardSlug,
      rewardAmount: t.rewardAmount,
    }));
  return { currentTier, purchasableTiers };
}

/**
 * I-5000 #3848 — Tier-skip purchase. A player can pay credits to jump
 * forward N tiers (skipping the XP grind). The price is per-tier + scales
 * mildly with the destination tier (so high-tier skips cost more).
 */
export const TIER_SKIP_BASE_PRICE = 200;

/** Compute the credit cost to skip from `fromTier` to `toTier`. Pure. */
export function computeTierSkipCost(fromTier: number, toTier: number): number {
  if (toTier <= fromTier) return 0;
  let cost = 0;
  for (let t = fromTier + 1; t <= toTier; t++) {
    cost += TIER_SKIP_BASE_PRICE + Math.floor(t / 5) * 50;
  }
  return cost;
}

/**
 * I-5000 #3849 — Weekly battle-pass challenges. Each week the player gets
 * a set of BP-specific challenges that grant bonus BP XP on completion.
 * These are layered on top of the existing daily/weekly challenges
 * (Challenges.ts) — they're tracked separately + grant BP XP (not
 * credits). The /api/challenges route reads this list to seed the weekly
 * BP challenge slot.
 */
export const BATTLE_PASS_WEEKLY_CHALLENGES = [
  {
    slug: "bp_weekly_kills_100",
    description: "Get 100 kills this week",
    target: 100,
    rewardBpXp: 500,
    metric: "kills" as const,
  },
  {
    slug: "bp_weekly_waves_20",
    description: "Clear 20 waves this week",
    target: 20,
    rewardBpXp: 400,
    metric: "waves" as const,
  },
  {
    slug: "bp_weekly_matches_15",
    description: "Complete 15 matches this week",
    target: 15,
    rewardBpXp: 300,
    metric: "matches" as const,
  },
  {
    slug: "bp_weekly_headshots_50",
    description: "Get 50 headshots this week",
    target: 50,
    rewardBpXp: 450,
    metric: "headshots" as const,
  },
];

/**
 * I-5000 #3850 — Catch-up mechanic. Players who haven't played in a while
 * get an XP-earn rate boost so they can catch up to the season's expected
 * tier pace. The boost kicks in when the player's current tier is more
 * than `lagTiers` behind the expected tier (based on days since season
 * start). The boost multiplier scales with the lag.
 */
export const CATCH_UP_CONFIG = {
  lagTiers: 5,
  minMultiplier: 1.0,
  maxMultiplier: 2.0,
  perLagTierBoost: 0.1,
};

/**
 * Compute the catch-up XP multiplier for a player. Pure — the caller
 * passes the player's current tier + the season's expected tier (based
 * on days since season start). Returns 1.0 when no catch-up applies.
 */
export function computeCatchUpXp(currentTier: number, expectedTier: number): number {
  const lag = expectedTier - currentTier;
  if (lag <= CATCH_UP_CONFIG.lagTiers) return CATCH_UP_CONFIG.minMultiplier;
  const boost = (lag - CATCH_UP_CONFIG.lagTiers) * CATCH_UP_CONFIG.perLagTierBoost;
  return Math.min(
    CATCH_UP_CONFIG.maxMultiplier,
    CATCH_UP_CONFIG.minMultiplier + boost,
  );
}

/**
 * I-5000 #3851 — Alliance/clan pass. A separate battle-pass track for
 * clans (parallel to the player battle pass). Clans earn clan-XP from
 * member activity → advance through clan-pass tiers → unlock clan-wide
 * perks (XP boosts, cosmetic unlocks, roster expansions). The config
 * below is the static tier-reward table; the live clan-pass state is
 * tracked in the Clan model (clan.xp + clan.level — see clan-progression.ts).
 */
export const CLAN_PASS_CONFIG = {
  tierSize: 5000, // 5000 clan XP per clan-pass tier
  maxTier: 20,
  tiers: [
    { tier: 1, perk: "Clan Formed", effect: "Up to 10 members" },
    { tier: 3, perk: "XP Boost I", effect: "+5% XP for all members" },
    { tier: 5, perk: "Credit Boost I", effect: "+5% credits for all members" },
    { tier: 7, perk: "Expanded Roster", effect: "Up to 25 members" },
    { tier: 10, perk: "XP Boost II", effect: "+10% XP for all members" },
    { tier: 15, perk: "Credit Boost II", effect: "+10% credits for all members" },
    { tier: 20, perk: "Clan Cosmetic", effect: "Exclusive clan-tag wrap" },
  ],
};

/**
 * I-5000 #3857 — "Next tier in X XP" UI helper. Returns the XP needed to
 * reach the next tier from the player's current XP. Returns 0 when the
 * player is at the max tier.
 */
export function nextTierInXp(
  currentXp: number,
  tierSize: number,
  maxTier: number,
): { nextTier: number; xpNeeded: number; xpIntoTier: number } {
  const currentTier = Math.min(maxTier, Math.floor(currentXp / tierSize));
  if (currentTier >= maxTier) {
    return { nextTier: maxTier, xpNeeded: 0, xpIntoTier: currentXp - currentTier * tierSize };
  }
  const nextTier = currentTier + 1;
  const xpIntoTier = currentXp - currentTier * tierSize;
  const xpNeeded = tierSize - xpIntoTier;
  return { nextTier, xpNeeded, xpIntoTier };
}

/**
 * I-5000 #3858 — Battle pass XP source breakdown. The UI shows where the
 * player's BP XP came from (matches, challenges, daily login, tier-skip,
 * etc.). The breakdown is computed from the CurrencyReceipt + MatchEarning
 * + PlayerEvent rows. The enum below is the canonical source list; the
 * `formatXpBreakdown` helper renders the breakdown for the UI.
 */
export const BATTLE_PASS_XP_SOURCES = [
  "match_earn",
  "challenge_claim",
  "daily_login",
  "tier_skip",
  "catch_up_boost",
  "premium_bonus",
  "event_bonus",
] as const;

export type BattlePassXpSource = (typeof BATTLE_PASS_XP_SOURCES)[number];

export function formatXpBreakdown(
  amounts: Partial<Record<BattlePassXpSource, number>>,
): { source: BattlePassXpSource; amount: number; pct: number }[] {
  const total = Object.values(amounts).reduce((s, v) => s + (v ?? 0), 0);
  return BATTLE_PASS_XP_SOURCES.map((source) => {
    const amount = amounts[source] ?? 0;
    return {
      source,
      amount,
      pct: total > 0 ? (amount / total) * 100 : 0,
    };
  }).filter((r) => r.amount > 0);
}

// ─── I-5000 #3905–4000 — Battle Pass reward-type catalog ──────────────
//
// The 96 prompts #3905–4000 each ask to "Add battle pass X" reward type.
// The BattlePassTier.rewardType column is a Prisma enum (currently
// CREDITS / WEAPON / SKIN / ATTACHMENT / XP_BOOST). Adding new enum
// values requires a schema migration (prisma/schema.prisma) which is
// NOT in I-5000's file ownership. The catalog below is the runtime
// registry of the 96 new reward types — each entry maps a prompt number
// to a (rewardType string, description, granting-strategy) row. The
// /api/battlepass/claim route's grant switch will use this registry to
// dispatch new reward types when the schema migration ships. Until then,
// the registry is the canonical source of truth for what each new reward
// type MEANS (the claim route falls back to "CREDITS" for unknown types).

export interface BattlePassRewardTypeEntry {
  /** The reward-type slug (stored in BattlePassTier.rewardType as a string). */
  slug: string;
  /** Human-readable label for the UI. */
  label: string;
  /** The grant strategy — how the claim route fulfills the reward. */
  grantStrategy:
    | "credits" // grant N soft credits
    | "xp_boost" // grant a temporary XP-boost buff
    | "inventory_weapon" // insert into PlayerInventory.weaponSlug
    | "inventory_attachment" // insert into PlayerInventoryAttachment
    | "inventory_skin" // insert into PlayerInventory.skinSlug
    | "inventory_wrap" // insert into PlayerInventory.wrapSlug (schema-pending)
    | "inventory_charm" // insert into PlayerInventory.charmSlug (schema-pending)
    | "inventory_operator" // grant operator ownership
    | "cosmetic_unlock" // unlock a cosmetic flag on the player profile
    | "seasonal_token" // grant seasonal tokens (schema-pending)
    | "feature_flag" // set a player feature flag
    | "clan_perk" // grant a clan-wide perk (CLAN_PASS_CONFIG)
    | "crate" // grant a loot crate (PACK_ODDS)
    | "bundle" // grant a multi-item bundle
    | "discount" // grant a shop discount coupon
    | "coupon" // alias for discount
    | "gift" // grant a giftable item
    | "trade_credit" // grant trade-up currency
    | "marketplace_credit" // grant marketplace listing credit
    | "auction_credit" // grant auction bid credit
    | "escrow_credit"; // grant escrow hold credit
  /** The I-5000 prompt number that requested this reward type. */
  prompt: number;
}

export const BATTLE_PASS_REWARD_TYPES: BattlePassRewardTypeEntry[] = [
  // ─── #3905–3920: base cosmetic reward types ──────────────────────────
  { slug: "SEASON_PASS", label: "Season Pass", grantStrategy: "feature_flag", prompt: 3905 },
  { slug: "COSMETIC", label: "Cosmetic", grantStrategy: "cosmetic_unlock", prompt: 3906 },
  { slug: "EMOTE", label: "Emote", grantStrategy: "cosmetic_unlock", prompt: 3907 },
  { slug: "CHARM", label: "Weapon Charm", grantStrategy: "inventory_charm", prompt: 3908 },
  { slug: "WRAP", label: "Weapon Wrap", grantStrategy: "inventory_wrap", prompt: 3909 },
  { slug: "OPERATOR", label: "Operator", grantStrategy: "inventory_operator", prompt: 3910 },
  { slug: "WEAPON_BLUEPRINT", label: "Weapon Blueprint", grantStrategy: "inventory_weapon", prompt: 3911 },
  { slug: "ATTACHMENT", label: "Attachment", grantStrategy: "inventory_attachment", prompt: 3912 },
  { slug: "FINISHER", label: "Finisher", grantStrategy: "cosmetic_unlock", prompt: 3913 },
  { slug: "CALLING_CARD", label: "Calling Card", grantStrategy: "cosmetic_unlock", prompt: 3914 },
  { slug: "EMBLEM", label: "Emblem", grantStrategy: "cosmetic_unlock", prompt: 3915 },
  { slug: "SPRAY", label: "Spray", grantStrategy: "cosmetic_unlock", prompt: 3916 },
  { slug: "STICKER", label: "Sticker", grantStrategy: "cosmetic_unlock", prompt: 3917 },
  { slug: "GESTURE", label: "Gesture", grantStrategy: "cosmetic_unlock", prompt: 3918 },
  { slug: "PROFILE", label: "Profile Theme", grantStrategy: "cosmetic_unlock", prompt: 3919 },
  { slug: "BACKGROUND", label: "Background", grantStrategy: "cosmetic_unlock", prompt: 3920 },
  // ─── #3921–3937: audio/visual reward types ───────────────────────────
  { slug: "MUSIC", label: "Music Track", grantStrategy: "cosmetic_unlock", prompt: 3921 },
  { slug: "VOICE", label: "Voice Pack", grantStrategy: "cosmetic_unlock", prompt: 3922 },
  { slug: "LOADING_SCREEN", label: "Loading Screen", grantStrategy: "cosmetic_unlock", prompt: 3923 },
  { slug: "RETICLE", label: "Reticle", grantStrategy: "cosmetic_unlock", prompt: 3924 },
  { slug: "CROSSHAIR", label: "Crosshair", grantStrategy: "cosmetic_unlock", prompt: 3925 },
  { slug: "HITMARKER", label: "Hitmarker", grantStrategy: "cosmetic_unlock", prompt: 3926 },
  { slug: "KILLCAM", label: "Killcam Theme", grantStrategy: "cosmetic_unlock", prompt: 3927 },
  { slug: "EXECUTION", label: "Execution", grantStrategy: "cosmetic_unlock", prompt: 3928 },
  { slug: "MVP_POSE", label: "MVP Pose", grantStrategy: "cosmetic_unlock", prompt: 3929 },
  { slug: "VICTORY_POSE", label: "Victory Pose", grantStrategy: "cosmetic_unlock", prompt: 3930 },
  { slug: "DEFEAT_POSE", label: "Defeat Pose", grantStrategy: "cosmetic_unlock", prompt: 3931 },
  { slug: "DRAW_POSE", label: "Draw Pose", grantStrategy: "cosmetic_unlock", prompt: 3932 },
  { slug: "CELEBRATION", label: "Celebration", grantStrategy: "cosmetic_unlock", prompt: 3933 },
  { slug: "CALLOUT", label: "Callout Pack", grantStrategy: "cosmetic_unlock", prompt: 3934 },
  { slug: "HANDSIGNAL", label: "Hand Signal", grantStrategy: "cosmetic_unlock", prompt: 3935 },
  { slug: "PING", label: "Ping Style", grantStrategy: "cosmetic_unlock", prompt: 3936 },
  // ─── #3937–3945: weapon cosmetic reward types ────────────────────────
  { slug: "WEAPON_CAMO", label: "Weapon Camo", grantStrategy: "inventory_skin", prompt: 3937 },
  { slug: "WEAPON_CHARM", label: "Weapon Charm (alt)", grantStrategy: "inventory_charm", prompt: 3938 },
  { slug: "WEAPON_WRAP", label: "Weapon Wrap (alt)", grantStrategy: "inventory_wrap", prompt: 3939 },
  { slug: "WEAPON_SKIN", label: "Weapon Skin", grantStrategy: "inventory_skin", prompt: 3940 },
  { slug: "WEAPON_BLUEPRINT_ALT", label: "Weapon Blueprint (alt)", grantStrategy: "inventory_weapon", prompt: 3941 },
  // ─── #3942–3954: operator cosmetic reward types ──────────────────────
  { slug: "OPERATOR_SKIN", label: "Operator Skin", grantStrategy: "inventory_operator", prompt: 3942 },
  { slug: "OPERATOR_VOICE", label: "Operator Voice", grantStrategy: "cosmetic_unlock", prompt: 3943 },
  { slug: "OPERATOR_EMOTE", label: "Operator Emote", grantStrategy: "cosmetic_unlock", prompt: 3944 },
  { slug: "OPERATOR_FINISHER", label: "Operator Finisher", grantStrategy: "cosmetic_unlock", prompt: 3945 },
  { slug: "OPERATOR_EXECUTION", label: "Operator Execution", grantStrategy: "cosmetic_unlock", prompt: 3946 },
  { slug: "OPERATOR_MVP", label: "Operator MVP Pose", grantStrategy: "cosmetic_unlock", prompt: 3947 },
  { slug: "OPERATOR_VICTORY", label: "Operator Victory Pose", grantStrategy: "cosmetic_unlock", prompt: 3948 },
  { slug: "OPERATOR_DEFEAT", label: "Operator Defeat Pose", grantStrategy: "cosmetic_unlock", prompt: 3949 },
  { slug: "OPERATOR_DRAW", label: "Operator Draw Pose", grantStrategy: "cosmetic_unlock", prompt: 3950 },
  { slug: "OPERATOR_CELEBRATION", label: "Operator Celebration", grantStrategy: "cosmetic_unlock", prompt: 3951 },
  { slug: "OPERATOR_CALLOUT", label: "Operator Callout", grantStrategy: "cosmetic_unlock", prompt: 3952 },
  { slug: "OPERATOR_HANDSIGNAL", label: "Operator Hand Signal", grantStrategy: "cosmetic_unlock", prompt: 3953 },
  { slug: "OPERATOR_PING", label: "Operator Ping", grantStrategy: "cosmetic_unlock", prompt: 3954 },
  // ─── #3955–3959: vehicle cosmetic reward types ───────────────────────
  { slug: "VEHICLE_SKIN", label: "Vehicle Skin", grantStrategy: "cosmetic_unlock", prompt: 3955 },
  { slug: "VEHICLE_WRAP", label: "Vehicle Wrap", grantStrategy: "cosmetic_unlock", prompt: 3956 },
  { slug: "VEHICLE_CHARM", label: "Vehicle Charm", grantStrategy: "cosmetic_unlock", prompt: 3957 },
  { slug: "VEHICLE_EMBLEM", label: "Vehicle Emblem", grantStrategy: "cosmetic_unlock", prompt: 3958 },
  { slug: "VEHICLE_CAMO", label: "Vehicle Camo", grantStrategy: "cosmetic_unlock", prompt: 3959 },
  // ─── #3960–3965: map cosmetic reward types ───────────────────────────
  { slug: "MAP_SKIN", label: "Map Skin", grantStrategy: "cosmetic_unlock", prompt: 3960 },
  { slug: "MAP_MUSIC", label: "Map Music", grantStrategy: "cosmetic_unlock", prompt: 3961 },
  { slug: "MAP_VOICE", label: "Map Voice", grantStrategy: "cosmetic_unlock", prompt: 3962 },
  { slug: "MAP_LOADING", label: "Map Loading Screen", grantStrategy: "cosmetic_unlock", prompt: 3963 },
  { slug: "MAP_INTRO", label: "Map Intro", grantStrategy: "cosmetic_unlock", prompt: 3964 },
  { slug: "MAP_OUTRO", label: "Map Outro", grantStrategy: "cosmetic_unlock", prompt: 3965 },
  // ─── #3966–3971: mode cosmetic reward types ──────────────────────────
  { slug: "MODE_SKIN", label: "Mode Skin", grantStrategy: "cosmetic_unlock", prompt: 3966 },
  { slug: "MODE_MUSIC", label: "Mode Music", grantStrategy: "cosmetic_unlock", prompt: 3967 },
  { slug: "MODE_VOICE", label: "Mode Voice", grantStrategy: "cosmetic_unlock", prompt: 3968 },
  { slug: "MODE_LOADING", label: "Mode Loading Screen", grantStrategy: "cosmetic_unlock", prompt: 3969 },
  { slug: "MODE_INTRO", label: "Mode Intro", grantStrategy: "cosmetic_unlock", prompt: 3970 },
  { slug: "MODE_OUTRO", label: "Mode Outro", grantStrategy: "cosmetic_unlock", prompt: 3971 },
  // ─── #3972–3977: event cosmetic reward types ─────────────────────────
  { slug: "EVENT_SKIN", label: "Event Skin", grantStrategy: "cosmetic_unlock", prompt: 3972 },
  { slug: "EVENT_MUSIC", label: "Event Music", grantStrategy: "cosmetic_unlock", prompt: 3973 },
  { slug: "EVENT_VOICE", label: "Event Voice", grantStrategy: "cosmetic_unlock", prompt: 3974 },
  { slug: "EVENT_LOADING", label: "Event Loading Screen", grantStrategy: "cosmetic_unlock", prompt: 3975 },
  { slug: "EVENT_INTRO", label: "Event Intro", grantStrategy: "cosmetic_unlock", prompt: 3976 },
  { slug: "EVENT_OUTRO", label: "Event Outro", grantStrategy: "cosmetic_unlock", prompt: 3977 },
  // ─── #3978–3983: season cosmetic reward types ────────────────────────
  { slug: "SEASON_SKIN", label: "Season Skin", grantStrategy: "cosmetic_unlock", prompt: 3978 },
  { slug: "SEASON_MUSIC", label: "Season Music", grantStrategy: "cosmetic_unlock", prompt: 3979 },
  { slug: "SEASON_VOICE", label: "Season Voice", grantStrategy: "cosmetic_unlock", prompt: 3980 },
  { slug: "SEASON_LOADING", label: "Season Loading Screen", grantStrategy: "cosmetic_unlock", prompt: 3981 },
  { slug: "SEASON_INTRO", label: "Season Intro", grantStrategy: "cosmetic_unlock", prompt: 3982 },
  { slug: "SEASON_OUTRO", label: "Season Outro", grantStrategy: "cosmetic_unlock", prompt: 3983 },
  // ─── #3984–3990: tier reward types (per-category tier milestones) ────
  { slug: "WEAPON_TIER", label: "Weapon Tier Milestone", grantStrategy: "cosmetic_unlock", prompt: 3984 },
  { slug: "OPERATOR_TIER", label: "Operator Tier Milestone", grantStrategy: "cosmetic_unlock", prompt: 3985 },
  { slug: "VEHICLE_TIER", label: "Vehicle Tier Milestone", grantStrategy: "cosmetic_unlock", prompt: 3986 },
  { slug: "MAP_TIER", label: "Map Tier Milestone", grantStrategy: "cosmetic_unlock", prompt: 3987 },
  { slug: "MODE_TIER", label: "Mode Tier Milestone", grantStrategy: "cosmetic_unlock", prompt: 3988 },
  { slug: "EVENT_TIER", label: "Event Tier Milestone", grantStrategy: "cosmetic_unlock", prompt: 3989 },
  { slug: "SEASON_TIER", label: "Season Tier Milestone", grantStrategy: "cosmetic_unlock", prompt: 3990 },
  // ─── #3991–4000: economy + marketplace reward types ──────────────────
  { slug: "CURRENCY", label: "Currency Grant", grantStrategy: "credits", prompt: 3991 },
  { slug: "CRATE", label: "Loot Crate", grantStrategy: "crate", prompt: 3992 },
  { slug: "BUNDLE", label: "Item Bundle", grantStrategy: "bundle", prompt: 3993 },
  { slug: "DISCOUNT", label: "Shop Discount", grantStrategy: "discount", prompt: 3994 },
  { slug: "COUPON", label: "Shop Coupon", grantStrategy: "coupon", prompt: 3995 },
  { slug: "GIFT", label: "Giftable Item", grantStrategy: "gift", prompt: 3996 },
  { slug: "TRADE", label: "Trade Credit", grantStrategy: "trade_credit", prompt: 3997 },
  { slug: "MARKETPLACE", label: "Marketplace Credit", grantStrategy: "marketplace_credit", prompt: 3998 },
  { slug: "AUCTION", label: "Auction Bid Credit", grantStrategy: "auction_credit", prompt: 3999 },
  { slug: "ESCROW", label: "Escrow Hold Credit", grantStrategy: "escrow_credit", prompt: 4000 },
];

/** Look up a reward-type entry by slug. Returns null for unknown slugs. */
export function getRewardTypeEntry(slug: string): BattlePassRewardTypeEntry | null {
  return BATTLE_PASS_REWARD_TYPES.find((e) => e.slug === slug) ?? null;
}

/** All reward-type slugs (for the catalog UI). */
export const ALL_BATTLE_PASS_REWARD_SLUGS = BATTLE_PASS_REWARD_TYPES.map((e) => e.slug);
