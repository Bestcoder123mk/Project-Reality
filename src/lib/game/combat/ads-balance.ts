/**
 * SEC5-COMBAT — Prompt 42: ADS / hip-fire balance pass.
 *
 * This module audits the accuracy-cone math across all 30 weapons + flags
 * balance bugs. The existing WeaponConfig carries 9 stats:
 *
 *   damage, fireRate, magSize, reloadTime, spread, recoil, range, zoom, price
 *
 * A balance bug is when weapon A is strictly better than weapon B in EVERY
 * combat-relevant stat (i.e. higher damage, faster fireRate, bigger mag,
 * faster reload, tighter spread, lower recoil, longer range — zoom + price
 * aren't combat-relevant). If such a pair exists, weapon B is dead weight in
 * the catalog — there's no reason a player would ever pick it.
 *
 * This audit runs at import time + is exposed via `auditWeaponBalance()` for
 * tests + the gunsmith UI. Designers can run it after editing WEAPONS to catch
 * regressions.
 *
 * Stats treated as "higher is better": damage, magSize, range, zoom (scope).
 * Stats treated as "lower is better": fireRate (ms between shots), reloadTime,
 * spread, recoil, price (player perspective — though price is economic, not
 * combat; we treat it as a soft tiebreaker, not a strict-better axis).
 *
 * Two stats are normalised before comparison:
 *   - dpsTtk = damage / fireRate (sustained DPS — higher is better)
 *   - burstAccuracy = 1 / spread (cone tightness — higher is better)
 *
 * Strict-better is checked against the 7 combat axes:
 *   damage, dpsTtk, burstAccuracy, magSize, reloadTime (lower better),
 *   recoil (lower better), range.
 */

import { WEAPONS, type WeaponType, type WeaponConfig } from "../store";

/** The 7 combat axes used to detect strict-better pairs. */
export interface WeaponCombatAxes {
  slug: WeaponType;
  category: WeaponConfig["category"];
  damage: number;
  /** Sustained DPS = damage / fireRate. Higher is better. */
  dps: number;
  /** Burst accuracy proxy = 1 / spread. Higher is better. */
  burstAccuracy: number;
  /** Magazine size. Higher is better. */
  magSize: number;
  /** Reload time (ms). Lower is better. */
  reloadTime: number;
  /** Recoil. Lower is better. */
  recoil: number;
  /** Effective range. Higher is better. */
  range: number;
}

/**
 * Convert a WeaponConfig into the 7 combat axes used by the balance audit.
 * Pure function — no side effects.
 */
export function toCombatAxes(cfg: WeaponConfig): WeaponCombatAxes {
  return {
    slug: cfg.id,
    category: cfg.category,
    damage: cfg.damage,
    dps: cfg.damage / Math.max(1, cfg.fireRate),
    burstAccuracy: 1 / Math.max(0.0001, cfg.spread),
    magSize: cfg.magSize,
    reloadTime: cfg.reloadTime,
    recoil: cfg.recoil,
    range: cfg.range,
  };
}

/** All 30 weapons projected onto the 7 combat axes. */
export const WEAPON_BALANCE_AUDIT: WeaponCombatAxes[] = Object.values(WEAPONS).map(toCombatAxes);

/**
 * Compare two weapons across all 7 combat axes.
 *
 * Returns "A" if A is strictly better than B in every axis, "B" if B is
 * strictly better, "equal" if they're tied on every axis (extremely unlikely),
 * or "incomparable" if neither dominates (the common case — most weapons trade
 * off some axes for others).
 */
export function getWeaponStatComparison(
  slugA: WeaponType,
  slugB: WeaponType,
): {
  verdict: "A" | "B" | "equal" | "incomparable";
  /** "A" if A is strictly better. Per-axis breakdown for debugging. */
  axes: Record<keyof Omit<WeaponCombatAxes, "slug" | "category">, "A" | "B" | "tie">;
  a: WeaponCombatAxes;
  b: WeaponCombatAxes;
} {
  const a = toCombatAxes(WEAPONS[slugA]);
  const b = toCombatAxes(WEAPONS[slugB]);

  // "higher is better" axes: damage, dps, burstAccuracy, magSize, range.
  // "lower is better" axes: reloadTime, recoil.
  const axes = {
    damage:        a.damage > b.damage ? "A" : a.damage < b.damage ? "B" : "tie",
    dps:           a.dps > b.dps ? "A" : a.dps < b.dps ? "B" : "tie",
    burstAccuracy: a.burstAccuracy > b.burstAccuracy ? "A" : a.burstAccuracy < b.burstAccuracy ? "B" : "tie",
    magSize:       a.magSize > b.magSize ? "A" : a.magSize < b.magSize ? "B" : "tie",
    reloadTime:    a.reloadTime < b.reloadTime ? "A" : a.reloadTime > b.reloadTime ? "B" : "tie",
    recoil:        a.recoil < b.recoil ? "A" : a.recoil > b.recoil ? "B" : "tie",
    range:         a.range > b.range ? "A" : a.range < b.range ? "B" : "tie",
  } as const;

  const allA = Object.values(axes).every((v) => v === "A");
  const allB = Object.values(axes).every((v) => v === "B");
  const allTie = Object.values(axes).every((v) => v === "tie");

  return {
    verdict: allA ? "A" : allB ? "B" : allTie ? "equal" : "incomparable",
    axes,
    a, b,
  };
}

export interface BalanceOutlier {
  /** The dominant weapon — strictly better in every axis. */
  better: WeaponType;
  /** The dominated weapon — strictly worse in every axis. */
  worse: WeaponType;
  category: WeaponConfig["category"];
  /** Per-axis breakdown for the gunsmith UI tooltip. */
  axes: Record<keyof Omit<WeaponCombatAxes, "slug" | "category">, "A" | "B" | "tie">;
}

export interface BalanceAuditResult {
  /** All strict-better pairs found across the 30-weapon catalog. */
  outliers: BalanceOutlier[];
  /** Total weapons audited. */
  weaponCount: number;
  /** Total pairs checked (n*(n-1)/2). */
  pairsChecked: number;
  /** True if no strict-better pairs found (the catalog is balanced). */
  ok: boolean;
}

/**
 * Audit the weapon catalog for strict-better pairs (balance bugs).
 *
 * Compares every pair of weapons within the same category (RIFLE vs RIFLE, etc.).
 * Cross-category comparisons are skipped — a sniper is never "strictly better"
 * than an SMG because they have different roles; the player picks based on
 * context, not on a single 7-axis dominance test.
 *
 * Within a category, if weapon A is strictly better than weapon B in all 7
 * combat axes, weapon B has no niche — that's a balance bug. Either B should
 * be cheaper (economic niche), or B should be rebalanced on at least one axis.
 */
export function auditWeaponBalance(): BalanceAuditResult {
  // Group by category.
  const byCat: Record<string, WeaponType[]> = {};
  for (const cfg of Object.values(WEAPONS)) {
    if (!byCat[cfg.category]) byCat[cfg.category] = [];
    byCat[cfg.category].push(cfg.id);
  }

  const outliers: BalanceOutlier[] = [];
  let pairsChecked = 0;

  for (const slugs of Object.values(byCat)) {
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        pairsChecked++;
        const a = slugs[i];
        const b = slugs[j];
        const cmp = getWeaponStatComparison(a, b);
        if (cmp.verdict === "A") {
          outliers.push({
            better: a, worse: b,
            category: WEAPONS[a].category,
            axes: cmp.axes,
          });
        } else if (cmp.verdict === "B") {
          outliers.push({
            better: b, worse: a,
            category: WEAPONS[b].category,
            axes: cmp.axes,
          });
        }
      }
    }
  }

  return {
    outliers,
    weaponCount: Object.keys(WEAPONS).length,
    pairsChecked,
    ok: outliers.length === 0,
  };
}

/**
 * Get the 7-axis projection for one weapon (for the gunsmith UI).
 */
export function getWeaponAxes(slug: WeaponType): WeaponCombatAxes {
  return toCombatAxes(WEAPONS[slug]);
}

/**
 * Get the list of weapons that are strictly dominated by the given weapon
 * (i.e. the given weapon is strictly better in every axis). Used by the
 * gunsmith "Compare" view to highlight dead-weight alternatives.
 */
export function getWeaponsDominatedBy(slug: WeaponType): WeaponType[] {
  const result: WeaponType[] = [];
  const mine = WEAPONS[slug];
  for (const other of Object.values(WEAPONS)) {
    if (other.id === slug) continue;
    if (other.category !== mine.category) continue;
    const cmp = getWeaponStatComparison(slug, other.id);
    if (cmp.verdict === "A") result.push(other.id);
  }
  return result;
}
