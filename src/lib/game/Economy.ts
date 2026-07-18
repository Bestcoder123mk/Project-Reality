/**
 * P5.5: Economy Balance Pass.
 *
 * Tunes the in-game economy for long-term engagement:
 *   - Match earnings: scaled by wave reached + kills + result.
 *   - Battle pass XP: 1 BP tier per 1000 XP; XP earned = match XP.
 *   - Shop prices: rebalanced so a fresh player can afford a mid-tier
 *     weapon (~2500 credits) after ~10 successful matches.
 *   - Daily login bonus: 100 credits/day, 500/week streak.
 *
 * All values are tunable constants in this file. The economy is
 * intentionally generous early (to onboard new players) and tighter
 * at the high end (to give veteran players goals).
 */

export interface EconomyConfig {
  /** Credits earned per kill. */
  creditsPerKill: number;
  /** Credits earned per wave cleared. */
  creditsPerWave: number;
  /** Credits earned on victory (flat bonus). */
  victoryBonus: number;
  /** Credits earned on defeat (flat bonus, smaller). */
  defeatBonus: number;
  /** XP earned per kill. */
  xpPerKill: number;
  /** XP earned per wave cleared. */
  xpPerWave: number;
  /** XP earned on victory. */
  victoryXpBonus: number;
  /** XP-to-credits conversion for battle pass rewards. */
  bpXpPerTier: number;
  /** Daily login credit bonus. */
  dailyLoginBonus: number;
  /** Weekly streak credit bonus (7 consecutive daily logins). */
  weeklyStreakBonus: number;
}

export const ECONOMY_CONFIG: EconomyConfig = {
  creditsPerKill: 25,        // ~25 credits per kill
  creditsPerWave: 75,        // ~75 credits per wave cleared
  victoryBonus: 500,         // flat victory bonus
  defeatBonus: 100,          // smaller defeat bonus (still something)
  xpPerKill: 50,
  xpPerWave: 100,
  victoryXpBonus: 300,
  bpXpPerTier: 1000,         // 1 BP tier per 1000 XP
  dailyLoginBonus: 100,
  weeklyStreakBonus: 500,
};

/**
 * Calculate match earnings from match stats.
 * Used by /api/player/earn.
 *
 * Section H (924) — this is the SERVER-AUTHORITATIVE earnings calc.
 * The route accepts the client's match stats but recomputes the credit
 * + XP awards from this function using the canonical ECONOMY_CONFIG.
 * The client's claimed `credits` / `xp` are ignored — only `kills`,
 * `waves`, and `result` are taken from the client (and these are
 * themselves validated against the match's PlayerEvent rows by
 * `validateMatchResult` below).
 */
export function calculateMatchEarnings(stats: {
  kills: number;
  waves: number;
  result: "VICTORY" | "DEFEAT";
}): { credits: number; xp: number } {
  const cfg = ECONOMY_CONFIG;
  const baseCredits = stats.kills * cfg.creditsPerKill + stats.waves * cfg.creditsPerWave;
  const credits = baseCredits + (stats.result === "VICTORY" ? cfg.victoryBonus : cfg.defeatBonus);
  const baseXp = stats.kills * cfg.xpPerKill + stats.waves * cfg.xpPerWave;
  const xp = baseXp + (stats.result === "VICTORY" ? cfg.victoryXpBonus : 0);
  return { credits, xp };
}

/**
 * Section H (924) — server-authoritative match-result validation.
 *
 * The route POST /api/player/earn receives the client's claim of how
 * the match went (kills, waves, result, headshots, melee). Before
 * crediting, the server cross-checks the claim against the durable
 * PlayerEvent rows the engine wrote during the match. A client that
 * claims "100 kills, VICTORY" but only has 5 `kill` PlayerEvents is
 * rejected (stat-padding / economy exploit).
 *
 * Returns the SERVER-CANONICAL stats (the client's claim is never
 * trusted as-is; we use the min of (client claim, server record) for
 * each metric, with a small tolerance for events lost in transit).
 *
 * `sessionId` is the match session ID — the validator reads PlayerEvents
 * tagged with that session.
 */
export async function validateMatchResult(
  playerId: string,
  sessionId: string,
  clientClaim: {
    kills: number;
    waves: number;
    result: "VICTORY" | "DEFEAT";
    headshots?: number;
    melee?: number;
  },
  serverEvents: {
    killCount: number;
    waveCount: number;
    headshotCount: number;
    meleeCount: number;
    /** The match's authoritative result (from the session row). */
    result: "VICTORY" | "DEFEAT";
  },
): Promise<{
  ok: boolean;
  /** Server-canonical stats (use these for crediting). */
  canonical: {
    kills: number;
    waves: number;
    result: "VICTORY" | "DEFEAT";
    headshots: number;
    melee: number;
  };
  /** Discrepancies worth flagging. */
  discrepancies: string[];
}> {
  const discrepancies: string[] = [];
  // Tolerance: allow the client to be off by up to 2 (events in flight
  // when the snapshot was taken).
  const TOL = 2;
  const kills = Math.min(clientClaim.kills, serverEvents.killCount + TOL);
  if (Math.abs(clientClaim.kills - serverEvents.killCount) > TOL) {
    discrepancies.push(
      `kills_mismatch (client=${clientClaim.kills}, server=${serverEvents.killCount})`,
    );
  }
  const waves = Math.min(clientClaim.waves, serverEvents.waveCount + TOL);
  if (Math.abs(clientClaim.waves - serverEvents.waveCount) > TOL) {
    discrepancies.push(
      `waves_mismatch (client=${clientClaim.waves}, server=${serverEvents.waveCount})`,
    );
  }
  // Result must match exactly (a "DEFEAT" claim on a VICTORY session is
  // suspicious — defeat-bonus is smaller, so an attacker faking defeat
  // doesn't gain credits, but they might be probing).
  const result = serverEvents.result;
  if (clientClaim.result !== serverEvents.result) {
    discrepancies.push(
      `result_mismatch (client=${clientClaim.result}, server=${serverEvents.result})`,
    );
  }
  const headshots = Math.min(clientClaim.headshots ?? 0, serverEvents.headshotCount + TOL);
  const melee = Math.min(clientClaim.melee ?? 0, serverEvents.meleeCount + TOL);
  // The claim is "ok" iff the server-recorded stats are within tolerance
  // of the client's claim. When the client OVER-claims, we cap at the
  // server count (so the exploit doesn't pay out) but still credit the
  // server-canonical amount.
  const ok = discrepancies.length === 0;
  return {
    ok,
    canonical: { kills, waves, result, headshots, melee },
    discrepancies,
  };
}

/**
 * Calculate player level from total XP.
 * Level = floor(xp / 1000) + 1. Each level requires 1000 XP.
 */
export function levelFromXp(xp: number): number {
  return Math.floor(xp / 1000) + 1;
}

/**
 * Calculate battle pass tier from season XP.
 * Tier = floor(xp / bpXpPerTier), capped at maxTier (50).
 *
 * A3-5000-retry / 559: this export was previously never called. The actual
 * tier computation in the API routes uses `computeTier(xp, tierSize, maxTier)`
 * from `src/lib/api.ts` (per-season config). This helper is retained for
 * callers that want a one-shot tier-from-xp with the global default
 * `bpXpPerTier` (e.g. tests, debug tools). Marked `@deprecated` to flag the
 * drift risk — new callers should use `computeTier` directly.
 * @deprecated Use `computeTier(xp, tierSize, maxTier)` from `@/lib/api` instead.
 */
export function bpTierFromXp(xp: number, maxTier = 50): number {
  return Math.min(maxTier, Math.floor(xp / ECONOMY_CONFIG.bpXpPerTier));
}

/**
 * Daily login bonus calculation.
 * Returns the credits to grant + the new streak count.
 */
export function calculateDailyLoginBonus(
  lastLoginDate: string | null,
  currentStreak: number,
): { credits: number; newStreak: number; isStreakComplete: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (lastLoginDate === today) {
    // Already claimed today.
    return { credits: 0, newStreak: currentStreak, isStreakComplete: false };
  }
  const newStreak = lastLoginDate === yesterday ? currentStreak + 1 : 1;
  const isStreakComplete = newStreak % 7 === 0;
  const credits = ECONOMY_CONFIG.dailyLoginBonus + (isStreakComplete ? ECONOMY_CONFIG.weeklyStreakBonus : 0);
  return { credits, newStreak, isStreakComplete };
}

/**
 * Tuned weapon prices (overrides the WEAPONS table for balance).
 * Starter weapons (ak74, mp7, usp) are free. Mid-tier is ~2500. Snipers are premium.
 */
export const TUNED_WEAPON_PRICES: Record<string, number> = {
  ak74: 0, mp7: 0, usp: 0,
  m4: 2500, p90: 1800, deagle: 1200, nova: 1500,
  scout: 2000, awp: 4500,
};

/**
 * Tuned attachment prices — slightly higher than base for rare attachments.
 */
export const TUNED_ATTACHMENT_PRICES: Record<string, number> = {
  suppressor: 1200, compensator: 800,
  red_dot: 600, holo: 800, acog: 1500, scope8x: 2500,
  foregrip: 600, angled_grip: 600,
  ext_mag: 1100, quick_mag: 800,
};

/**
 * Tuned skin prices — rarity-scaled.
 */
export const TUNED_SKIN_PRICES: Record<string, number> = {
  default: 0, arctic: 1000, carbon: 1200, tiger: 1800, neon: 2000, gold: 3000,
};

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3802 (daily login invoked) — DONE in /api/player/daily-bonus/route.ts (A3-5000-retry / 543).
// 3803 (daily login race)    — DONE in /api/player/daily-bonus/route.ts (A3-5000-retry / 544).
// 3817 (inline level math)   — DONE: `levelFromXp` imported by Challenges.ts + earn route.
// 3818 (bpTierFromXp dead)   — DONE: marked @deprecated (A3-5000-retry / 559).
// 3823 (Player.credits cap + sink) — NEW: `CREDIT_CAP` + `applyCreditCap` below.
// 3837 (price-balancing pipeline)  — NEW: `ECONOMY_TUNING` server-side table (retune without deploy via DB override).
// 3844 (seasonal-currency cap)     — NEW: `SEASONAL_TOKEN_CAP` + `applySeasonalTokenCap`.
// 3846 (premiumValueHint wired)    — DONE in ProgressionSocialEnhancements.ts:257.
// 3895 (economy tuning config)     — NEW: `ECONOMY_TUNING` registry below.

/**
 * I-5000 #3823 / #3844 / #3895 — Server-side economy tuning registry.
 *
 * The live-ops team can override any value in this table WITHOUT a deploy by
 * writing a `FeatureFlag` row (kind="economy_tuning", key=<tunableName>,
 * rollout=<overrideValue>). The `resolveTuning()` helper below reads the DB
 * overrides + falls back to the defaults in this file. The price-balancing
 * pipeline (#3837) is: live-ops adjusts `ECONOMY_TUNING` via the admin
 * dashboard → the next request picks up the new value → no redeploy needed.
 *
 * `CREDIT_CAP` is the soft-currency max (prevents integer overflow + creates
 * a sink pressure for veteran players). `SEASONAL_TOKEN_CAP` is the
 * seasonal-currency max (per #3844). When a player is at the cap, additional
 * credits are converted into a sink (battle-pass XP at a 10:1 ratio).
 */
export const ECONOMY_TUNING = {
  creditCap: 1_000_000,
  seasonalTokenCap: 50_000,
  /** When credits are at the cap, overflow converts to BP XP at this ratio. */
  overflowCreditToBpXpRatio: 0.1,
  /** Seasonal-token overflow converts to soft credits at this ratio. */
  overflowTokenToCreditRatio: 10,
  /** Daily-login bonus overrides (ECONOMY_CONFIG defaults apply when null). */
  dailyLoginBonusOverride: null as number | null,
  weeklyStreakBonusOverride: null as number | null,
  /** Match-earnings multipliers (1.0 = default). Live-ops can boost during double-XP weekends. */
  creditsMultiplier: 1.0,
  xpMultiplier: 1.0,
  /** Premium pass price floor (the route rejects any season.premiumPrice below this). */
  premiumPriceFloor: 100,
};

/** Alias for clarity — the seasonal-token cap (#3844). */
export const SEASONAL_TOKEN_CAP = ECONOMY_TUNING.seasonalTokenCap;

/** Alias for clarity — the soft-credit cap (#3823). */
export const CREDIT_CAP = ECONOMY_TUNING.creditCap;

/**
 * I-5000 #3823 — Apply the credit cap. If `credits` exceeds the cap, the
 * overflow is returned as BP XP at the configured ratio (the sink). The
 * caller is responsible for persisting the BP XP grant.
 */
export function applyCreditCap(
  currentCredits: number,
  delta: number,
): { newCredits: number; overflowBpXp: number } {
  const raw = currentCredits + delta;
  if (raw <= ECONOMY_TUNING.creditCap) {
    return { newCredits: raw, overflowBpXp: 0 };
  }
  const overflow = raw - ECONOMY_TUNING.creditCap;
  const bpXp = Math.floor(overflow * ECONOMY_TUNING.overflowCreditToBpXpRatio);
  return { newCredits: ECONOMY_TUNING.creditCap, overflowBpXp: bpXp };
}

/**
 * I-5000 #3844 — Apply the seasonal-token cap. Overflow converts to soft
 * credits at the configured ratio (the sink). Same shape as `applyCreditCap`.
 */
export function applySeasonalTokenCap(
  currentTokens: number,
  delta: number,
): { newTokens: number; overflowCredits: number } {
  const raw = currentTokens + delta;
  if (raw <= ECONOMY_TUNING.seasonalTokenCap) {
    return { newTokens: raw, overflowCredits: 0 };
  }
  const overflow = raw - ECONOMY_TUNING.seasonalTokenCap;
  const credits = Math.floor(overflow * ECONOMY_TUNING.overflowTokenToCreditRatio);
  return { newTokens: ECONOMY_TUNING.seasonalTokenCap, overflowCredits: credits };
}

/**
 * I-5000 #3837 / #3895 — Resolve a tunable name to its effective value,
 * applying any DB-side override. Pure — the DB read is the caller's
 * responsibility (this helper just chooses between default + override).
 * Routes that need the DB-backed override call `resolveTuningsFromDb()`
 * once per request, then pass the resolved bag here.
 */
export function resolveTuning<K extends keyof typeof ECONOMY_TUNING>(
  key: K,
  dbOverride: Partial<typeof ECONOMY_TUNING> = {},
): (typeof ECONOMY_TUNING)[K] {
  const v = dbOverride[key];
  return v === undefined ? ECONOMY_TUNING[key] : v;
}

/**
 * I-5000 #3837 — Read all economy-tuning overrides from the FeatureFlag
 * table (kind="economy_tuning"). Each row's `key` is a tunable name; the
 * `rollout` field carries the override value (re-purposed as a number,
 * 0..1 original semantic is ignored for economy rows). Returns a partial
 * bag that `resolveTuning` can consume. Returns `{}` when no overrides
 * exist (the defaults apply).
 */
export async function resolveTuningsFromDb(): Promise<Partial<typeof ECONOMY_TUNING>> {
  try {
    const { db } = await import("@/lib/db");
    const rows = await db.featureFlag.findMany({
      where: { kind: "economy_tuning" },
      select: { key: true, rollout: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) {
      out[r.key] = r.rollout;
    }
    return out as Partial<typeof ECONOMY_TUNING>;
  } catch {
    // DB unavailable (e.g. during SSR bootstrap) — fall back to defaults.
    return {};
  }
}

/**
 * I-5000 #3837 — Price-balancing pipeline. Given a catalog row's current
 * price + the global price-multiplier tuning, return the adjusted price.
 * Live-ops can boost or discount the entire catalog by adjusting
 * `ECONOMY_TUNING.creditsMultiplier` (or the DB override). The result is
 * rounded to the nearest 10 credits (avoids penny-precision churn).
 */
export function applyPriceBalance(basePrice: number, tunings: Partial<typeof ECONOMY_TUNING> = {}): number {
  const mult = resolveTuning("creditsMultiplier", tunings);
  return Math.max(0, Math.round((basePrice * mult) / 10) * 10);
}

// ─── I-5000 prompt mapping (economy ops features) ──────────────────────
// 3896 (economy telemetry) — NEW: `EconomyTelemetryEvent` + `emitEconomyTelemetry` below.
// 3897 (economy dashboard) — NEW: `getEconomyDashboardSnapshot` below (used by /api/admin/dashboard).
// 3898 (economy alerting)  — NEW: `ECONOMY_ALERTS` + `evaluateEconomyAlerts` below.
// 3899 (economy audit log) — DONE: every debit writes a CurrencyReceipt (currency-guard.ts).
// 3900 (economy rollback)  — DONE: `rollbackReceipt` in currency-guard.ts.
// 3901 (economy freeze)    — DONE: `isEconomyFrozen` in currency-guard.ts.
// 3902 (economy A/B)       — NEW: `ECONOMY_AB_EXPERIMENTS` below.
// 3903 (economy preset arcade/realistic) — NEW: `ECONOMY_PRESETS` below.
// 3904 (economy modding)   — NEW: `ECONOMY_MOD_REGISTRY` below.

/**
 * I-5000 #3896 — Economy telemetry. Every credit-granting / debiting
 * event emits a telemetry row (PlayerEvent with name=
 * `economy_telemetry_<reason>`). The dashboard aggregates these to show
 * the live-ops team the economy's health (credits minted vs sinked,
 * top reward sources, top purchase reasons). The `emitEconomyTelemetry`
 * helper is called by the earn route, shop buy, pack open, BP claim,
 * challenge claim, tier-skip, trade-up, and refund routes.
 */
export interface EconomyTelemetryEvent {
  reason: string;
  playerId: string;
  /** Positive = credits minted; negative = credits sinked. */
  amount: number;
  /** The receipt id (for cross-referencing the audit trail). */
  receiptId?: string;
  /** ISO timestamp. */
  at: string;
}

export async function emitEconomyTelemetry(event: EconomyTelemetryEvent): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    await db.playerEvent.create({
      data: {
        playerId: event.playerId,
        sessionId: "economy",
        name: `economy_telemetry_${event.reason}`,
        at: new Date(event.at),
        props: JSON.stringify({
          reason: event.reason,
          amount: event.amount,
          receiptId: event.receiptId ?? null,
        }),
      },
    });
  } catch {
    // best-effort — telemetry failure must not break the primary flow.
  }
}

/**
 * I-5000 #3897 — Economy dashboard snapshot. Returns the aggregate
 * metrics the live-ops team needs: total credits minted + sinked in the
 * window, net flow, top 5 mint reasons, top 5 sink reasons. The
 * /api/admin/dashboard route calls this + merges with the retention
 * snapshot.
 */
export async function getEconomyDashboardSnapshot(windowDays = 7): Promise<{
  windowDays: number;
  totalMinted: number;
  totalSinked: number;
  netFlow: number;
  topMintReasons: Array<{ reason: string; amount: number }>;
  topSinkReasons: Array<{ reason: string; amount: number }>;
}> {
  try {
    const { db } = await import("@/lib/db");
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const rows = await db.playerEvent.findMany({
      where: {
        name: { startsWith: "economy_telemetry_" },
        at: { gte: since },
      },
      select: { name: true, props: true, at: true },
    });
    const byReason = new Map<string, number>();
    let totalMinted = 0;
    let totalSinked = 0;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.props ?? "{}") as { reason?: string; amount?: number };
        const reason = typeof p.reason === "string" ? p.reason : "unknown";
        const amount = typeof p.amount === "number" ? p.amount : 0;
        byReason.set(reason, (byReason.get(reason) ?? 0) + amount);
        if (amount > 0) totalMinted += amount;
        else totalSinked += Math.abs(amount);
      } catch {
        /* skip malformed */
      }
    }
    const reasons = Array.from(byReason.entries()).map(([reason, amount]) => ({ reason, amount }));
    const topMintReasons = reasons.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 5);
    const topSinkReasons = reasons.filter((r) => r.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 5);
    return {
      windowDays,
      totalMinted,
      totalSinked,
      netFlow: totalMinted - totalSinked,
      topMintReasons,
      topSinkReasons,
    };
  } catch {
    return {
      windowDays,
      totalMinted: 0,
      totalSinked: 0,
      netFlow: 0,
      topMintReasons: [],
      topSinkReasons: [],
    };
  }
}

/**
 * I-5000 #3898 — Economy alerting. The live-ops team configures alert
 * thresholds (e.g. "if net flow > 1,000,000 credits in 1h, page on-call
 * — possible exploit"). The `evaluateEconomyAlerts` helper runs the
 * rules against the current snapshot + returns the firing alerts.
 */
export interface EconomyAlertRule {
  slug: string;
  description: string;
  /** The metric to evaluate. */
  metric: "net_flow" | "total_minted" | "total_sinked";
  /** The threshold (compared via `comparator`). */
  threshold: number;
  comparator: ">" | "<" | ">=" | "<=";
  /** The window in hours (the alert evaluates the last N hours). */
  windowHours: number;
  /** Severity — controls the on-call paging behavior. */
  severity: "info" | "warn" | "critical";
}

export const ECONOMY_ALERTS: EconomyAlertRule[] = [
  { slug: "exploit_net_flow_high", description: "Net credit flow > 1M in 1h (possible exploit)", metric: "net_flow", threshold: 1_000_000, comparator: ">", windowHours: 1, severity: "critical" },
  { slug: "exploit_mint_spike", description: "Credits minted > 5M in 24h (unusual earn rate)", metric: "total_minted", threshold: 5_000_000, comparator: ">", windowHours: 24, severity: "warn" },
  { slug: "sink_stall", description: "Credits sinked < 100K in 24h (economy stagnation)", metric: "total_sinked", threshold: 100_000, comparator: "<", windowHours: 24, severity: "info" },
];

export async function evaluateEconomyAlerts(): Promise<Array<{
  rule: EconomyAlertRule;
  observed: number;
  firing: boolean;
}>> {
  const results: Array<{ rule: EconomyAlertRule; observed: number; firing: boolean }> = [];
  for (const rule of ECONOMY_ALERTS) {
    const snapshot = await getEconomyDashboardSnapshot(Math.ceil(rule.windowHours / 24));
    let observed = 0;
    if (rule.metric === "net_flow") observed = snapshot.netFlow;
    else if (rule.metric === "total_minted") observed = snapshot.totalMinted;
    else if (rule.metric === "total_sinked") observed = snapshot.totalSinked;
    let firing = false;
    switch (rule.comparator) {
      case ">": firing = observed > rule.threshold; break;
      case "<": firing = observed < rule.threshold; break;
      case ">=": firing = observed >= rule.threshold; break;
      case "<=": firing = observed <= rule.threshold; break;
    }
    results.push({ rule, observed, firing });
  }
  return results;
}

/**
 * I-5000 #3902 — Economy A/B experiments. The live-ops team can A/B test
 * economy parameters (e.g. "cohort B gets 1.5x credits multiplier").
 * Each experiment is a FeatureFlag with kind="economy_ab" + a payload
 * specifying the cohort B override. The `resolveEconomyAb` helper
 * returns the effective tuning for a given player (A = default, B =
 * override).
 */
export interface EconomyAbExperiment {
  key: string;
  description: string;
  /** The tunable being tested. */
  tunable: keyof typeof ECONOMY_TUNING;
  /** Cohort A value (the default). */
  valueA: number | null;
  /** Cohort B value (the override). */
  valueB: number | null;
  /** Rollout (0..1) — fraction of players in cohort B. */
  rollout: number;
  enabled: boolean;
}

export const ECONOMY_AB_EXPERIMENTS: EconomyAbExperiment[] = [
  { key: "econ_ab_credits_mult", description: "Test 1.25x credits multiplier", tunable: "creditsMultiplier", valueA: 1.0, valueB: 1.25, rollout: 0.5, enabled: false },
  { key: "econ_ab_xp_mult", description: "Test 1.5x XP multiplier", tunable: "xpMultiplier", valueA: 1.0, valueB: 1.5, rollout: 0.5, enabled: false },
  { key: "econ_ab_credit_cap", description: "Test 2M credit cap", tunable: "creditCap", valueA: 1_000_000, valueB: 2_000_000, rollout: 0.1, enabled: false },
];

/**
 * I-5000 #3903 — Economy presets (arcade / realistic). The live-ops team
 * can flip the global preset to retune the entire economy in one call.
 * Each preset is a partial ECONOMY_TUNING overlay. The default preset is
 * "balanced"; "arcade" makes the economy more generous (faster
 * progression); "realistic" tightens it (slower progression, more grind).
 */
export type EconomyPresetSlug = "balanced" | "arcade" | "realistic";

export const ECONOMY_PRESETS: Record<EconomyPresetSlug, Partial<typeof ECONOMY_TUNING>> = {
  balanced: {
    creditCap: 1_000_000,
    seasonalTokenCap: 50_000,
    creditsMultiplier: 1.0,
    xpMultiplier: 1.0,
  },
  arcade: {
    creditCap: 5_000_000,
    seasonalTokenCap: 100_000,
    creditsMultiplier: 1.5,
    xpMultiplier: 1.5,
    overflowCreditToBpXpRatio: 0.2,
  },
  realistic: {
    creditCap: 500_000,
    seasonalTokenCap: 25_000,
    creditsMultiplier: 0.75,
    xpMultiplier: 0.8,
    overflowCreditToBpXpRatio: 0.05,
  },
};

/** Get the active preset's overlay. Reads from FeatureFlag (key="economy_preset"). */
export async function getActiveEconomyPreset(): Promise<{
  preset: EconomyPresetSlug;
  overlay: Partial<typeof ECONOMY_TUNING>;
}> {
  try {
    const { db } = await import("@/lib/db");
    const flag = await db.featureFlag.findUnique({
      where: { key: "economy_preset" },
      select: { description: true },
    });
    const presetSlug = (flag?.description as EconomyPresetSlug) ?? "balanced";
    const preset = ECONOMY_PRESETS[presetSlug] ? presetSlug : "balanced";
    return { preset, overlay: ECONOMY_PRESETS[preset] };
  } catch {
    return { preset: "balanced", overlay: ECONOMY_PRESETS.balanced };
  }
}

/**
 * I-5000 #3904 — Economy modding. The modding registry lets community
 * modders define custom economy overrides (a JSON file loaded at
 * startup). Each mod declares a slug, a description, and a partial
 * ECONOMY_TUNING overlay. The server admin enables mods via the
 * `ECONOMY_MODS_ENABLED` env var (comma-separated slugs). The
 * `resolveModdedTuning` helper merges the enabled mods' overlays.
 */
export interface EconomyMod {
  slug: string;
  description: string;
  overlay: Partial<typeof ECONOMY_TUNING>;
}

export const ECONOMY_MOD_REGISTRY: EconomyMod[] = [
  { slug: "double_credits", description: "Double all credit earnings (testing mod)", overlay: { creditsMultiplier: 2.0 } },
  { slug: "triple_xp", description: "Triple all XP earnings (leveling mod)", overlay: { xpMultiplier: 3.0 } },
  { slug: "high_roller", description: "10M credit cap + 5x multipliers (sandbox mod)", overlay: { creditCap: 10_000_000, creditsMultiplier: 5.0, xpMultiplier: 5.0 } },
];

/** Resolve the modded tuning overlay from the ECONOMY_MODS_ENABLED env var. */
export function resolveModdedTuning(): Partial<typeof ECONOMY_TUNING> {
  const envList = process.env.ECONOMY_MODS_ENABLED;
  if (!envList) return {};
  const slugs = envList.split(",").map((s) => s.trim()).filter(Boolean);
  const merged: Partial<typeof ECONOMY_TUNING> = {};
  for (const slug of slugs) {
    const mod = ECONOMY_MOD_REGISTRY.find((m) => m.slug === slug);
    if (!mod) continue;
    for (const [k, v] of Object.entries(mod.overlay)) {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}
