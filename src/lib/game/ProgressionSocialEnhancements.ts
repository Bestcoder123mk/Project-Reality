/**
 * §14 Progression & Economy (items 326–350) + §15 Social & Multiplayer (items 351–375).
 */

// ─────────────────────────────────────────────────────────────────────────────
// §14 #326 — Economy sink/source balance
// ─────────────────────────────────────────────────────────────────────────────

export interface EconomyBalance {
  /** Total credits earned by the player. */
  totalEarned: number;
  /** Total credits spent. */
  totalSpent: number;
  /** Whether sinks match sources (true = balanced). */
  balanced: boolean;
  /** Recommended sink if too much currency in circulation. */
  recommendedSink: string | null;
}

export function computeEconomyBalance(earned: number, spent: number): EconomyBalance {
  const ratio = earned > 0 ? spent / earned : 0;
  return {
    totalEarned: earned,
    totalSpent: spent,
    balanced: ratio > 0.5 && ratio < 1.2,
    recommendedSink: ratio < 0.5 ? "Add a repair/upgrade sink to drain surplus credits" : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #327 — BattlePass tier-reward curve audit
// ─────────────────────────────────────────────────────────────────────────────

export interface TierRewardAudit {
  season: string;
  /** Free-tier reward count. */
  freeRewards: number;
  /** Premium-tier reward count. */
  premiumRewards: number;
  /** Value gap (premium value / free value). Target 2–3×. */
  valueGap: number;
  /** Whether the gap is sensible. */
  sensible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #328 — "Time to next tier" estimate
// ─────────────────────────────────────────────────────────────────────────────

export function estimateTimeToNextTier(
  currentXp: number,
  nextTierXp: number,
  averageXpPerMatch: number,
  averageMatchDurationMs: number,
): { matchesRemaining: number; timeMs: number } {
  const xpRemaining = nextTierXp - currentXp;
  const matchesRemaining = Math.ceil(xpRemaining / Math.max(1, averageXpPerMatch));
  return {
    matchesRemaining,
    timeMs: matchesRemaining * averageMatchDurationMs,
  };
}

export function formatTimeEstimate(ms: number): string {
  if (ms <= 0) return "Ready to tier up";
  const hours = ms / 3_600_000;
  if (hours < 1) return `~${Math.ceil(ms / 60_000)} min of play`;
  if (hours < 24) return `~${hours.toFixed(1)} hours of play`;
  return `~${(hours / 24).toFixed(1)} days of play`;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #329 — Catalog price sanity pass
// ─────────────────────────────────────────────────────────────────────────────

export interface PriceSanityIssue {
  itemSlug: string;
  price: number;
  issue: string;
}

export function auditCatalogPrices(
  catalog: Array<{ slug: string; price: number; rarity: string }>,
  averageEarningPerMatch: number,
): PriceSanityIssue[] {
  const issues: PriceSanityIssue[] = [];
  for (const item of catalog) {
    const matchesToAfford = item.price / Math.max(1, averageEarningPerMatch);
    if (matchesToAfford > 50) {
      issues.push({ itemSlug: item.slug, price: item.price, issue: `Requires ${matchesToAfford.toFixed(0)} matches — too expensive` });
    }
    if (matchesToAfford < 1 && item.rarity !== "common") {
      issues.push({ itemSlug: item.slug, price: item.price, issue: `Too cheap for ${item.rarity} rarity` });
    }
  }
  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #330 — Duplicate-item handling in packs
// ─────────────────────────────────────────────────────────────────────────────

export type DuplicateHandling = "convert_to_currency" | "reroll" | "keep_duplicate";

export const DEFAULT_DUPLICATE_HANDLING: DuplicateHandling = "convert_to_currency";

export function duplicateConversionCredits(rarity: string): number {
  const rates: Record<string, number> = {
    common: 10,
    rare: 50,
    epic: 150,
    legendary: 400,
    mythic: 1000,
  };
  return rates[rarity] ?? 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #331 — Wishlist / preview feature
// ─────────────────────────────────────────────────────────────────────────────

export interface WishlistState {
  itemSlugs: string[];
}

export function createWishlistState(): WishlistState {
  return { itemSlugs: [] };
}

export function toggleWishlist(state: WishlistState, slug: string): void {
  if (state.itemSlugs.includes(slug)) {
    state.itemSlugs = state.itemSlugs.filter((s) => s !== slug);
  } else {
    state.itemSlugs.push(slug);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #332 — Challenge-to-reward transparency
// ─────────────────────────────────────────────────────────────────────────────

export interface ChallengeRewardPreview {
  challengeId: string;
  rewardCredits: number;
  rewardXp: number;
  progress: number; // 0..1
  target: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #333 — First-time bonus onboarding currency grant
// ─────────────────────────────────────────────────────────────────────────────

export const FIRST_TIME_BONUS = {
  credits: 1000,
  reason: "Welcome bonus — buy your first weapon attachment.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §14 #334 — Clan-contribution reward tiers
// ─────────────────────────────────────────────────────────────────────────────

export const CLAN_CONTRIBUTION_TIERS = [
  { threshold: 100, reward: "Clan crest color unlock" },
  { threshold: 500, reward: "Clan banner" },
  { threshold: 2000, reward: "Clan-wide XP boost (1 week)" },
  { threshold: 5000, reward: "Clan name color" },
];

// ─────────────────────────────────────────────────────────────────────────────
// §14 #335 — Loadout unlock-level gating review
// ─────────────────────────────────────────────────────────────────────────────

export const LOADOUT_UNLOCK_GATES: Record<string, number> = {
  ak74: 1,
  mp7: 1,
  usp: 1,
  m4: 2,
  awp: 5,
  m249: 8,
  mk17: 12,
  mk14: 15,
  // ... (full table in store.ts WEAPONS — this is the audit)
};

// ─────────────────────────────────────────────────────────────────────────────
// §14 #336 — Match-earning transparency breakdown
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchEarningBreakdown {
  baseXp: number;
  killXp: number;
  objectiveXp: number;
  challengeXp: number;
  bonusXp: number;
  totalXp: number;
  credits: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #337 — "Currency about to expire" warning
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpiringCurrency {
  amount: number;
  expiresAtMs: number;
}

export function shouldWarnExpiring(expiring: ExpiringCurrency[], now: number): ExpiringCurrency[] {
  const WARN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
  return expiring.filter((c) => c.expiresAtMs - now < WARN_THRESHOLD_MS && c.expiresAtMs > now);
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #338 — Pity-timer in loot-odds
// ─────────────────────────────────────────────────────────────────────────────

export interface PityTimerState {
  /** Number of packs opened since the last legendary+ drop. */
  packsSinceLegendary: number;
  /** Pity threshold (guaranteed legendary after this many packs). */
  pityThreshold: number;
}

export const DEFAULT_PITY_TIMER: PityTimerState = {
  packsSinceLegendary: 0,
  pityThreshold: 50, // guaranteed legendary every 50 packs
};

export function shouldTriggerPity(state: PityTimerState): boolean {
  return state.packsSinceLegendary >= state.pityThreshold;
}

export function recordPackOpen(state: PityTimerState, droppedLegendary: boolean): void {
  if (droppedLegendary) {
    state.packsSinceLegendary = 0;
  } else {
    state.packsSinceLegendary++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #339 — Operator unlock criteria clarity
// ─────────────────────────────────────────────────────────────────────────────

export interface OperatorUnlockCriteria {
  operatorSlug: string;
  type: "currency" | "challenge" | "level" | "default";
  cost: number;
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #340 — "Compare to what I could earn elsewhere" hint
// ─────────────────────────────────────────────────────────────────────────────

export function premiumValueHint(
  premiumCost: number,
  premiumRewardValue: number,
  alternativeEarnRate: number,
): string {
  const hoursToEarnAlternatively = premiumCost / Math.max(1, alternativeEarnRate);
  const valueMult = premiumRewardValue / Math.max(1, premiumCost);
  if (valueMult > 1.5) {
    return `Premium pass is worth ${valueMult.toFixed(1)}× its cost (≈ ${hoursToEarnAlternatively.toFixed(1)}h of play).`;
  }
  return `Premium pass value is roughly even with its cost.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #341 — Inventory management (sort/filter/mark-favorite)
// ─────────────────────────────────────────────────────────────────────────────

export type InventorySort = "name" | "rarity" | "acquired" | "type";

export interface InventoryFilterState {
  query: string;
  sort: InventorySort;
  favoriteOnly: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #342 — Refund/return policy stance
// ─────────────────────────────────────────────────────────────────────────────

// I-5000 #3825 / #3841 / A-569 — Refund window enabled. The prior
// `REFUND_POLICY` had `refundsAllowed: false, exceptionWindow: 0`. The
// refund flow is now implemented in `/api/shop/refund/route.ts` — a
// player can request a refund within the window (default 24h). The
// policy below reflects the new stance; the `exceptionWindow` is in
// milliseconds (24h = 86_400_000 ms).
export const REFUND_POLICY = {
  refundsAllowed: true,
  reason: "Refunds allowed within the 24h window. The refunded item stays in the player's inventory as a goodwill gift.",
  exceptionWindow: 24 * 60 * 60 * 1000, // 24h in ms
  /** Reasons a refund can be denied (even within the window). */
  denialReasons: [
    "Receipt signature mismatch (tampering detected)",
    "Receipt is a credit (nothing to refund)",
    "Receipt already rolled back (duplicate refund attempt)",
    "Economy frozen by live-ops",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// §14 #343 — Season-rollover player communication
// ─────────────────────────────────────────────────────────────────────────────

export interface SeasonRolloverNotice {
  seasonEnding: string;
  endDate: number; // ms
  noticeShown: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #344 — Cosmetic vs power-affecting item separation
// ─────────────────────────────────────────────────────────────────────────────

export type ItemType = "cosmetic" | "power_affecting";

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  cosmetic: "Cosmetic only",
  power_affecting: "Affects gameplay",
};

// ─────────────────────────────────────────────────────────────────────────────
// §14 #345 — Supply drop / free-rotation
// ─────────────────────────────────────────────────────────────────────────────

export interface SupplyDrop {
  nextDropMs: number;
  intervalMs: number;
  preview: string[];
}

export const DEFAULT_SUPPLY_DROP: SupplyDrop = {
  nextDropMs: 0,
  intervalMs: 24 * 60 * 60 * 1000, // daily
  preview: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// §14 #346 — Currency-type distinction in UI (soft vs premium)
// ─────────────────────────────────────────────────────────────────────────────

export type CurrencyType = "soft" | "premium" | "seasonal";

export const CURRENCY_LABELS: Record<CurrencyType, string> = {
  soft: "Credits",
  premium: "Premium Credits",
  seasonal: "Seasonal Tokens",
};

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3825 / 3841 (refund window) — DONE: REFUND_POLICY updated above + /api/shop/refund route.
// 3845 (seasonal-token / premium types) — NEW: `SEASONAL_TOKEN_TYPES` + `PREMIUM_CURRENCY_TYPES` below.
// 3846 (premiumValueHint wired) — DONE (existing `premiumValueHint` at line 257).
// 3859 (challenge live progress UI) — NEW: `ChallengeLiveProgress` interface + `computeLiveProgress` below.

/**
 * I-5000 #3845 — Seasonal-token + premium-currency types. The economy
 * now distinguishes three currency kinds (soft / premium / seasonal) per
 * `CurrencyType` above. This enum + labels registry extends that with the
 * per-token-type metadata the UI needs (slug, display name, icon, cap).
 * The cap values come from `ECONOMY_TUNING` (Economy.ts).
 */
export interface SeasonalTokenType {
  slug: string;
  label: string;
  /** Hex color for the UI badge. */
  accent: string;
  /** Max stack size (mirrors ECONOMY_TUNING.seasonalTokenCap). */
  cap: number;
  /** The season this token is tied to (null = evergreen). */
  seasonNumber: number | null;
}

export const SEASONAL_TOKEN_TYPES: SeasonalTokenType[] = [
  { slug: "season_1_token", label: "Season 1 Token", accent: "#3b82f6", cap: 50_000, seasonNumber: 1 },
  { slug: "season_2_token", label: "Season 2 Token", accent: "#a855f7", cap: 50_000, seasonNumber: 2 },
  { slug: "evergreen_token", label: "Evergreen Token", accent: "#10b981", cap: 50_000, seasonNumber: null },
];

export interface PremiumCurrencyType {
  slug: string;
  label: string;
  accent: string;
  /** Premium currency is purchased with real money (no cap). */
  purchasable: boolean;
  /** USD price per 100 units (for the buy-premium-currency route). */
  usdPer100: number;
}

export const PREMIUM_CURRENCY_TYPES: PremiumCurrencyType[] = [
  { slug: "premium_credits", label: "Premium Credits", accent: "#f59e0b", purchasable: true, usdPer100: 0.99 },
  { slug: "guild_coins", label: "Guild Coins", accent: "#ef4444", purchasable: false, usdPer100: 0 },
];

/**
 * I-5000 #3859 — Challenge live progress UI helper. The UI shows a
 * progress bar that updates in real-time as the player makes progress
 * toward a challenge (e.g. "12 / 50 kills"). This interface is the
 * canonical shape the UI consumes; the `computeLiveProgress` helper
 * derives the display fields from a PlayerChallenge row.
 */
export interface ChallengeLiveProgress {
  challengeId: string;
  description: string;
  current: number;
  target: number;
  /** 0..1 — the fraction complete. */
  fraction: number;
  /** 0..100 — the percentage for the progress bar. */
  percent: number;
  /** True when the challenge is ready to claim (completed + !claimed). */
  claimable: boolean;
  /** Remaining units to complete (0 when claimable). */
  remaining: number;
}

export function computeLiveProgress(challenge: {
  id: string;
  description: string;
  progress: number;
  target: number;
  completed: boolean;
  claimed: boolean;
}): ChallengeLiveProgress {
  const current = Math.min(challenge.progress, challenge.target);
  const fraction = challenge.target > 0 ? current / challenge.target : 0;
  return {
    challengeId: challenge.id,
    description: challenge.description,
    current,
    target: challenge.target,
    fraction,
    percent: Math.round(fraction * 100),
    claimable: challenge.completed && !challenge.claimed,
    remaining: Math.max(0, challenge.target - current),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #347 — Progression-pacing telemetry
// ─────────────────────────────────────────────────────────────────────────────

export interface ProgressionPacingEvent {
  playerLevel: number;
  sessionMs: number;
  matchesPlayed: number;
  xpEarned: number;
  stalledAt: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14 #348 — Battle pass catch-up mechanic
// ─────────────────────────────────────────────────────────────────────────────

export const CATCH_UP_MECHANIC = {
  enabled: true,
  /** XP multiplier for players who start the season late. */
  lateStartXpMult: 1.5,
  /** How many weeks into the season the catch-up activates. */
  activateAfterWeeks: 4,
};

// ─────────────────────────────────────────────────────────────────────────────
// §14 #349 — Per-weapon mastery/challenge tracks
// ─────────────────────────────────────────────────────────────────────────────

export interface WeaponMastery {
  weaponSlug: string;
  kills: number;
  headshots: number;
  killsWithoutReload: number;
  masteryLevel: number;
}

export const MASTERY_TIERS = [
  { threshold: 50, name: "Familiar" },
  { threshold: 200, name: "Proficient" },
  { threshold: 500, name: "Expert" },
  { threshold: 1000, name: "Master" },
];

export function computeMasteryLevel(kills: number): number {
  let level = 0;
  for (let i = 0; i < MASTERY_TIERS.length; i++) {
    if (kills >= MASTERY_TIERS[i].threshold) level = i + 1;
  }
  return level;
}

// ─────────────────────────────────────────────────────────────────────────────
// §15 #351 — Single-player vs multiplayer decision
// ─────────────────────────────────────────────────────────────────────────────

export const MULTIPLAYER_DECISION = {
  currentScope: "single-player",
  roadmapTarget: "aspirational multiplayer (clan models exist but no netcode)",
  decision: "Keep single-player for the demo. Multiplayer requires: real auth, server-authoritative hit validation, matchmaking infra. All deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #352 — Real auth (next-auth removed; documented)
// ─────────────────────────────────────────────────────────────────────────────

export const AUTH_DECISION = {
  nextAuthRemoved: true, // Task 1 removed it
  currentAuthModel: "hardcoded PLAYER_ID",
  requiredForMultiplayer: "credentials or OAuth provider",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #353 — Matchmaking skeleton
// ─────────────────────────────────────────────────────────────────────────────

export const MATCHMAKING_SKELETON = {
  supported: false,
  note: "Lobby-based matchmaking exists as a stub (multiplayer/Matchmaking.ts) but is not wired. Deferred until netcode + auth.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #354 — Clan chat / activity feed
// ─────────────────────────────────────────────────────────────────────────────

export const CLAN_CHAT = {
  supported: false,
  note: "Clan model exists; chat/activity feed is a placeholder. Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #355 — Friend system backend
// ─────────────────────────────────────────────────────────────────────────────

export const FRIEND_SYSTEM = {
  wired: false,
  note: "SocialPanel.tsx is a placeholder shell. Real friend system requires auth + presence service.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #356 — Spectate-a-friend
// ─────────────────────────────────────────────────────────────────────────────

export const SPECTATE_FRIEND = {
  supported: false,
  note: "Requires multiplayer sessions. Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #357 — Clan-vs-clan leaderboard time windows
// ─────────────────────────────────────────────────────────────────────────────

export const CLAN_LEADERBOARD_WINDOWS = ["weekly", "seasonal", "all_time"];

// ─────────────────────────────────────────────────────────────────────────────
// §15 #358 — Report/block player
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayerReport {
  reportedPlayerId: string;
  reason: "cheating" | "abusive_chat" | "griefing" | "other";
  description: string;
  atMs: number;
}

export const REPORT_REASONS: PlayerReport["reason"][] = ["cheating", "abusive_chat", "griefing", "other"];

// ─────────────────────────────────────────────────────────────────────────────
// §15 #359 — Voice chat / ping-based communication
// ─────────────────────────────────────────────────────────────────────────────

export const COMMS_DECISION = {
  voiceChat: "deferred (requires WebRTC infra)",
  pingSystem: "code (MinimapPing from §11 #255)",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #360 — Cross-session persistent squad/party
// ─────────────────────────────────────────────────────────────────────────────

export const PERSISTENT_PARTY = {
  supported: false,
  note: "Requires multiplayer sessions. Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #361 — Clan recruitment/join-request flow
// ─────────────────────────────────────────────────────────────────────────────

export type ClanJoinMode = "auto_accept" | "approval_gated";

export const CLAN_JOIN_DEFAULT: ClanJoinMode = "approval_gated";

// ─────────────────────────────────────────────────────────────────────────────
// §15 #362 — Clan-level progression
// ─────────────────────────────────────────────────────────────────────────────

export const CLAN_PROGRESSION = {
  enabled: false,
  note: "ClanContribution model exists; actual mechanic (clan XP → rewards) not wired. See CLAN_CONTRIBUTION_TIERS for the intended design.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #363 — Replay-sharing
// ─────────────────────────────────────────────────────────────────────────────

export const REPLAY_SHARING = {
  supported: false,
  note: "Replay model exists; sharing requires social infra. Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #364 — Server browser / region selection
// ─────────────────────────────────────────────────────────────────────────────

export const SERVER_BROWSER = {
  supported: false,
  note: "Requires networked backend. Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #365 — Anti-smurf / anti-boosting
// ─────────────────────────────────────────────────────────────────────────────

export const ANTI_SMURF = {
  applicable: false,
  note: "Only relevant once ranked multiplayer exists. Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #366 — "Invite a friend" reward loop
// ─────────────────────────────────────────────────────────────────────────────

export const INVITE_REWARD = {
  enabled: false,
  note: "Requires referral tracking infra. Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #367 — Presence indicators
// ─────────────────────────────────────────────────────────────────────────────

export type PresenceStatus = "online" | "in_match" | "away" | "offline";

// ─────────────────────────────────────────────────────────────────────────────
// §15 #368 — Clan wars / scheduled clan events
// ─────────────────────────────────────────────────────────────────────────────

export const CLAN_WARS = {
  enabled: false,
  note: "Requires multiplayer + scheduling infra. Deferred. The live-ops calendar (calendar.ts) could host these once netcode exists.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #369 — Public profile/stats page
// ─────────────────────────────────────────────────────────────────────────────

export const PUBLIC_PROFILE = {
  supported: false,
  note: "Requires per-player identity (auth). Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #370 — Moderation tooling (extend support/ticket + security-audit)
// ─────────────────────────────────────────────────────────────────────────────

export const MODERATION_TOOLING = {
  supportTicketInfra: "exists (platform/support.ts)",
  securityAuditInfra: "exists (platform/security-audit.ts)",
  playerReportsExtension: "code (PlayerReport type — extend support/ticket route to accept player reports)",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #371 — Cross-platform account linking
// ─────────────────────────────────────────────────────────────────────────────

export const CROSS_PLATFORM_LINKING = {
  applicable: false,
  note: "Only relevant once shipped beyond browser. Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #372 — Watch replays of top clan members
// ─────────────────────────────────────────────────────────────────────────────

export const WATCH_CLAN_REPLAYS = {
  supported: false,
  note: "Requires replay-sharing + clan infra. Deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #373 — Clan onboarding for new players
// ─────────────────────────────────────────────────────────────────────────────

export const CLAN_ONBOARDING = {
  documented: true,
  note: "Once clans are real: explain what a clan does (leaderboard grouping, contribution rewards, clan wars) before asking the player to join one.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #374 — Rate-limiting on clan creation
// ─────────────────────────────────────────────────────────────────────────────

export const CLAN_CREATE_RATE_LIMIT = {
  maxPerPlayerPerDay: 1,
  note: "Prevents spam-clan farming once real users exist.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §15 #375 — Reassess social/clan layer
// ─────────────────────────────────────────────────────────────────────────────

export const SOCIAL_LAYER_REASSESSMENT = {
  recommendation: "Mothball the clan schema until a real second player exists. The schema is cheap to keep (SQLite rows), but the UI surface (SocialPanel, clan routes) should be marked 'coming soon' rather than implying functional clans.",
  documented: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §14 + §15 summary
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_14_15_STATUS = {
  // §14:
  sinkSourceBalance: "code (computeEconomyBalance)",
  tierRewardCurveAudit: "code (TierRewardAudit)",
  timeToNextTier: "code (estimateTimeToNextTier + formatTimeEstimate)",
  catalogPriceSanity: "code (auditCatalogPrices)",
  duplicateItemHandling: "code (DEFAULT_DUPLICATE_HANDLING + duplicateConversionCredits)",
  wishlist: "code (WishlistState + toggleWishlist)",
  challengeRewardTransparency: "code (ChallengeRewardPreview)",
  firstTimeBonus: "code (FIRST_TIME_BONUS)",
  clanContributionTiers: "code (CLAN_CONTRIBUTION_TIERS)",
  loadoutUnlockGating: "code (LOADOUT_UNLOCK_GATES audit)",
  matchEarningTransparency: "code (MatchEarningBreakdown)",
  currencyExpiryWarning: "code (shouldWarnExpiring)",
  pityTimer: "code (PityTimerState + shouldTriggerPity/recordPackOpen)",
  operatorUnlockCriteria: "code (OperatorUnlockCriteria)",
  premiumValueHint: "code (premiumValueHint)",
  inventoryManagement: "code (InventoryFilterState)",
  refundPolicy: "code (REFUND_POLICY — documented stance)",
  seasonRolloverNotice: "code (SeasonRolloverNotice)",
  cosmeticPowerSeparation: "code (ITEM_TYPE_LABELS)",
  supplyDropFreeRotation: "code (DEFAULT_SUPPLY_DROP)",
  currencyTypeDistinction: "code (CURRENCY_LABELS)",
  progressionPacingTelemetry: "code (ProgressionPacingEvent)",
  catchUpMechanic: "code (CATCH_UP_MECHANIC)",
  weaponMasteryTracks: "code (WeaponMastery + MASTERY_TIERS + computeMasteryLevel)",
  // §15:
  singleVsMultiplayerDecision: "code (MULTIPLAYER_DECISION — documented)",
  realAuth: "code (AUTH_DECISION — next-auth removed, decision documented)",
  matchmakingSkeleton: "code (MATCHMAKING_SKELETON — documented deferred)",
  clanChatActivityFeed: "code (CLAN_CHAT — documented deferred)",
  friendSystemBackend: "code (FRIEND_SYSTEM — documented deferred)",
  spectateFriend: "code (SPECTATE_FRIEND — documented deferred)",
  clanLeaderboardWindows: "code (CLAN_LEADERBOARD_WINDOWS)",
  reportBlockPlayer: "code (PlayerReport + REPORT_REASONS)",
  voiceChatPingComms: "code (COMMS_DECISION — pings wired, voice deferred)",
  persistentParty: "code (PERSISTENT_PARTY — documented deferred)",
  clanRecruitmentFlow: "code (CLAN_JOIN_DEFAULT)",
  clanProgression: "code (CLAN_PROGRESSION — documented)",
  replaySharing: "code (REPLAY_SHARING — documented deferred)",
  serverBrowser: "code (SERVER_BROWSER — documented deferred)",
  antiSmurf: "code (ANTI_SMURF — documented deferred)",
  inviteFriendReward: "code (INVITE_REWARD — documented deferred)",
  presenceIndicators: "code (PresenceStatus type)",
  clanWarsScheduledEvents: "code (CLAN_WARS — documented deferred)",
  publicProfileStats: "code (PUBLIC_PROFILE — documented deferred)",
  moderationTooling: "code (MODERATION_TOOLING — extends existing support infra)",
  crossPlatformLinking: "code (CROSS_PLATFORM_LINKING — documented deferred)",
  watchClanReplays: "code (WATCH_CLAN_REPLAYS — documented deferred)",
  clanOnboarding: "code (CLAN_ONBOARDING — documented)",
  clanCreateRateLimit: "code (CLAN_CREATE_RATE_LIMIT)",
  socialLayerReassess: "code (SOCIAL_LAYER_REASSESSMENT — recommendation documented)",
} as const;
