/**
 * Section C — Per-caliber damage falloff curves.
 *
 * The existing Ballistics.velocityDamageMult maps a bullet's current velocity
 * to a damage multiplier (0.5 at 30 m/s, 1.0 at muzzle). This is a
 * velocity-based model — it works but doesn't reflect per-caliber behavior.
 *
 * This module adds per-caliber damage falloff curves using the real-world
 * ballistic tables from caliber-tables.ts. Each caliber has its own energy
 * retention curve:
 *
 *   - 5.56mm M855: retains 50% energy at 350m, 30% at 500m.
 *   - 7.62mm M80: retains 65% energy at 400m, 50% at 600m, 35% at 800m.
 *   - 9mm: retains 75% at 50m, 55% at 100m (drops fast past 100m).
 *   - .338 Lapua: retains 80% at 500m, 65% at 1000m, 50% at 1500m (excellent retention).
 *   - 12ga pellet: retains 60% at 25m, 35% at 50m, 15% at 75m (terrible retention).
 *
 * The damage scales linearly with retained kinetic energy (E = 0.5 × m × v²).
 * A bullet at 50% muzzle energy deals 50% damage.
 *
 * This module also handles:
 *   - Per-organ damage modifiers (heart, brain, etc. — see organ-hitzones.ts).
 *   - Per-ammo-type modifiers (HP, AP, FMJ — see Ballistics.AMMO_TYPES).
 *   - Per-surface penetration damage falloff (see layered-penetration.ts).
 *
 * The final damage formula composes all multipliers:
 *
 *   final_damage = weapon_base_damage
 *                  × caliberDamageMult(range)              // this module
 *                  × ammoDamageMult                         // Ballistics.AMMO_TYPES
 *                  × zoneMult(zone)                          // Ballistics.HITZONE_DAMAGE_MULT
 *                  × organMult(organ)                        // organ-hitzones.ts
 *                  × penetrationMult                         // layered-penetration.ts
 *
 * Tone reference: tactical-mil-sim-leaning-arcade. The numbers are tuned
 * so that:
 *   - Point-blank rifle shots deal full damage (3-shot kill on chest).
 *   - Long-range rifle shots (500m+) deal ~40% damage (5-7 shots to kill).
 *   - Sniper rounds stay lethal at 1500m (one-shot kill on chest).
 *   - Pistol rounds become non-lethal past 50m (8+ shots to kill).
 */

import type { WeaponType } from "../store";
import { WEAPONS } from "../store";
import {
  getCaliber,
  getWeaponCaliber,
  interpolateBallisticRow,
  type CaliberProfile,
} from "./caliber-tables";
import type { OrganSlug } from "./organ-hitzones";
import { ORGAN_HIT_ZONES } from "./organ-hitzones";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type HitZone = "head" | "chest" | "limb";
export type AmmoTypeSlug = "fmj" | "hp" | "ap" | "subsonic" | "tracer" | "incendiary";

export interface DamageFalloffInput {
  /** Weapon slug. */
  weapon: WeaponType;
  /** Range to target (m). */
  rangeM: number;
  /** Hit zone. */
  zone: HitZone;
  /** Organ hit (or "none" for non-organ hits). */
  organ: OrganSlug;
  /** Ammo type. */
  ammoType: AmmoTypeSlug;
  /** Penetration multiplier (from layered-penetration.ts, 0..1). 1.0 = no
   *  surfaces penetrated; < 1.0 = bullet passed through surfaces. */
  penetrationMult: number;
}

export interface DamageFalloffResult {
  /** Final computed damage. */
  damage: number;
  /** Per-component breakdown (for the gunsmith / debug HUD). */
  breakdown: {
    baseDamage: number;
    caliberMult: number;
    ammoMult: number;
    zoneMult: number;
    organMult: number;
    penetrationMult: number;
    energyRetention: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-zone damage multipliers (mirrors Ballistics.HITZONE_DAMAGE_MULT,
// duplicated here to avoid circular imports).
// ─────────────────────────────────────────────────────────────────────────────

export const ZONE_DAMAGE_MULT: Record<HitZone, number> = {
  head: 4.0,
  chest: 1.0,
  limb: 0.7,
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-ammo-type damage multipliers (mirrors Ballistics.AMMO_TYPES.damageMult).
// ─────────────────────────────────────────────────────────────────────────────

export const AMMO_DAMAGE_MULT: Record<AmmoTypeSlug, number> = {
  fmj: 1.00,
  hp: 1.35,
  ap: 0.90,
  subsonic: 0.85,
  tracer: 0.95,
  incendiary: 1.10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-caliber energy retention + damage.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the energy retention ratio (0..1) for a caliber at a given range.
 * Reads from the caliber's per-distance table.
 *
 *   ratio = energy_at_range / muzzle_energy
 *
 * A 5.56mm at 300m has ~37% energy retention (601J / 1640J).
 */
export function energyRetentionAtRange(caliberSlug: string, rangeM: number): number {
  const caliber = getCaliberProfile(caliberSlug);
  const row = interpolateBallisticRow(caliber, rangeM);
  return Math.max(0.15, row.energyJ / caliber.muzzleEnergyJ);
}

/** Get the caliber profile by slug. */
function getCaliberProfile(slug: string): CaliberProfile {
  return getCaliber(slug);
}

/**
 * Compute the per-caliber damage multiplier at a given range. Linearly
 * scales with energy retention. At the muzzle, mult = 1.0. At max
 * effective range, mult = energy retention (typically 0.3-0.5).
 *
 *   damage_mult = energy_retention / 1.0
 *
 * This means a 5.56mm at 500m (37% energy retention) deals 37% damage.
 *
 * Below 25% energy retention the multiplier is clamped to 0.25 — a very
 * long-range shot still deals some damage (it didn't just bounce off).
 */
export function caliberDamageMultAtRange(caliberSlug: string, rangeM: number): number {
  const retention = energyRetentionAtRange(caliberSlug, rangeM);
  // Apply a slight gameplay boost: long-range shots deal a bit more damage
  // than pure energy retention would suggest, so they remain meaningful.
  // boost = 1.0 + (1 - retention) × 0.2
  const boost = 1.0 + (1 - retention) * 0.2;
  return Math.max(0.25, Math.min(1.0, retention * boost));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-organ damage multiplier.
//
// Wraps organ-hitzones.ts's organDamage to compute just the organ multiplier
// (not the full damage — that's composed below).
// ─────────────────────────────────────────────────────────────────────────────

export function organDamageMult(organ: OrganSlug): number {
  return ORGAN_HIT_ZONES[organ].damageMult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level damage computation.
//
// Composes all multipliers:
//
//   final_damage = weapon_base_damage
//                  × caliberDamageMultAtRange(caliber, range)   // 0.25..1.0
//                  × AMMO_DAMAGE_MULT[ammoType]                  // 0.85..1.35
//                  × ZONE_DAMAGE_MULT[zone]                      // 0.7 / 1.0 / 4.0
//                  × organDamageMult(organ)                      // 0.8..2.5
//                  × penetrationMult                             // 0..1.0
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the final damage for a hit, composing all multipliers.
 *
 * @param input  The damage input (weapon, range, zone, organ, ammo, penetration).
 * @returns      The damage result with breakdown.
 */
export function computeDamage(input: DamageFalloffInput): DamageFalloffResult {
  const weapon = WEAPONS[input.weapon];
  if (!weapon) {
    return {
      damage: 0,
      breakdown: {
        baseDamage: 0, caliberMult: 0, ammoMult: 0, zoneMult: 0,
        organMult: 0, penetrationMult: 0, energyRetention: 0,
      },
    };
  }
  const baseDamage = weapon.damage;
  const caliber = getWeaponCaliber(input.weapon);
  const energyRetention = energyRetentionAtRange(caliber.slug, input.rangeM);
  const caliberMult = caliberDamageMultAtRange(caliber.slug, input.rangeM);
  const ammoMult = AMMO_DAMAGE_MULT[input.ammoType] ?? 1.0;
  const zoneMult = ZONE_DAMAGE_MULT[input.zone] ?? 1.0;
  const organMult = organDamageMult(input.organ);
  const penetrationMult = Math.max(0, Math.min(1, input.penetrationMult));

  const damage = baseDamage * caliberMult * ammoMult * zoneMult * organMult * penetrationMult;

  return {
    damage,
    breakdown: {
      baseDamage,
      caliberMult,
      ammoMult,
      zoneMult,
      organMult,
      penetrationMult,
      energyRetention,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TTK (Time-to-Kill) helpers.
//
// Used by the gunsmith / weapon-balance view to estimate TTK at various
// ranges. TTK = HP / DPS, where DPS = damage_per_shot × fire_rate.
// ─────────────────────────────────────────────────────────────────────────────

export interface TtkEstimate {
  /** Range (m). */
  rangeM: number;
  /** Damage per shot at this range. */
  damagePerShot: number;
  /** Shots to kill (100 HP target). */
  shotsToKill: number;
  /** Time to kill (seconds). */
  ttkSec: number;
}

/**
 * Estimate the TTK for a weapon at various ranges (chest hits, FMJ ammo,
 * no penetration). Used by the gunsmith's TTK chart.
 */
export function estimateTtkCurve(
  weapon: WeaponType,
  ranges: number[] = [10, 25, 50, 100, 200, 300, 500, 800, 1000],
): TtkEstimate[] {
  const weaponConfig = WEAPONS[weapon];
  if (!weaponConfig) return [];
  const fireRateSec = (weaponConfig.fireRate || 100) / 1000; // ms → s
  const targetHp = 100;

  return ranges.map((range) => {
    const result = computeDamage({
      weapon,
      rangeM: range,
      zone: "chest",
      organ: "none",
      ammoType: "fmj",
      penetrationMult: 1.0,
    });
    const shotsToKill = Math.ceil(targetHp / Math.max(1, result.damage));
    const ttkSec = shotsToKill * fireRateSec;
    return {
      rangeM: range,
      damagePerShot: result.damage,
      shotsToKill,
      ttkSec,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-range damage table (for HUD / gunsmith display).
// ─────────────────────────────────────────────────────────────────────────────

export interface RangeDamageRow {
  rangeM: number;
  /** Damage per chest hit (FMJ, no penetration). */
  damage: number;
  /** Energy retention ratio (0..1). */
  energyRetention: number;
  /** Shots to kill a 100 HP target on chest. */
  shotsToKill: number;
  /** Hit zone for headshot at this range (1-shot kill indicator). */
  headshotKill: boolean;
}

/**
 * Compute the per-range damage table for a weapon. Used by the gunsmith's
 * "damage falloff" chart.
 */
export function computeRangeDamageTable(
  weapon: WeaponType,
  ranges: number[] = [0, 25, 50, 100, 200, 300, 500, 800, 1000, 1500],
): RangeDamageRow[] {
  return ranges.map((range) => {
    const chestResult = computeDamage({
      weapon, rangeM: range, zone: "chest",
      organ: "none", ammoType: "fmj", penetrationMult: 1.0,
    });
    const caliber = getWeaponCaliber(weapon);
    const energyRetention = energyRetentionAtRange(caliber.slug, range);
    const headshotResult = computeDamage({
      weapon, rangeM: range, zone: "head",
      organ: "brain", ammoType: "fmj", penetrationMult: 1.0,
    });
    return {
      rangeM: range,
      damage: chestResult.damage,
      energyRetention,
      shotsToKill: Math.ceil(100 / Math.max(1, chestResult.damage)),
      headshotKill: headshotResult.damage >= 100,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick-knowledge helpers — precomputed TTK curves for the 5 calibers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the canonical TTK curve for a caliber (used by the gunsmith's
 * caliber comparison view). Picks a representative weapon for the caliber.
 */
export function getCanonicalTtkCurve(caliberSlug: string): TtkEstimate[] {
  // Representative weapons per caliber.
  const weaponForCaliber: Record<string, WeaponType> = {
    m855: "m4",
    m80: "scarh",
    "9mm": "mp5",
    "338_lm": "awp",
    "12ga_buck": "m1014",
  };
  const weapon = weaponForCaliber[caliberSlug] ?? "m4";
  return estimateTtkCurve(weapon);
}

/**
 * Get the canonical range damage table for a caliber. Same as
 * computeRangeDamageTable but uses the representative weapon.
 */
export function getCanonicalRangeDamageTable(caliberSlug: string): RangeDamageRow[] {
  const weaponForCaliber: Record<string, WeaponType> = {
    m855: "m4",
    m80: "scarh",
    "9mm": "mp5",
    "338_lm": "awp",
    "12ga_buck": "m1014",
  };
  const weapon = weaponForCaliber[caliberSlug] ?? "m4";
  return computeRangeDamageTable(weapon);
}
