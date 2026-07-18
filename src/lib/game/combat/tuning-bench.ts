/**
 * Section D — Weapon Tuning Bench (advanced stats visualization).
 *
 * Real-world gunsmiths use ballistics software (e.g. Strelok, Applied
 * Ballistics, JBM Ballistics) to visualize weapon performance before
 * tuning. This module aggregates data from all the Section D sub-modules
 * into a single "tuning bench" view:
 *
 *   1. Real-world spec card (muzzle velocity, ROF, weight, etc.).
 *   2. Drop chart (bullet drop at 100, 200, 300, 400, 500 m).
 *   3. Wind drift chart (at 5, 10, 15 m/s crosswind).
 *   4. Time-of-flight chart.
 *   5. Energy chart (kinetic energy at range).
 *   6. Recoil analysis (vertical + horizontal, with attachments).
 *   7. Spread analysis (ADS / hipfire / moving).
 *   8. Heat soak chart (POI shift vs rounds fired).
 *   9. Wear progression chart (wear vs rounds fired).
 *  10. Rail system summary (Picatinny / M-LOK / KeyMod).
 *  11. Fire mode layout + selector diagram.
 *  12. Reload timing breakdown (tactical / speed / empty).
 *  13. Engraving + paint job summary.
 *  14. Tuning recommendations (zero distance, parallax, etc.).
 *
 * This is a pure data aggregator — the React component reads the result
 * and renders it.
 */

import type { WeaponType, AttachmentSlug, LoadoutConfig } from "../store";
import { WEAPONS } from "../store";
import {
  REAL_WORLD_SPECS, REAL_WORLD_EXTENDED, type RealWorldWeaponSpec,
  formatMuzzleVelocity, formatWeight, formatBarrelLength,
  formatMuzzleEnergy, formatCyclicRate,
} from "./weapon-catalog-extended";
import { heatSoakProfileFor, type BarrelHeatProfile, type PoiShift, barrelHeatPoiShift, initBarrelHeatState, injectShotHeat } from "./barrel-heat";
import { railSummaryFor, type WeaponRailSummary, railLabel, socketLabelList } from "./attachment-sockets";
import { selectorLayoutFor, type FireSelectorPosition, effectiveRpmInMode, selectorLabel as selLabel } from "./fire-modes";
import { computeReloadTimings, type ReloadType, reloadStages, reloadTypeLabel } from "./reload-types";
import { OPTIC_PARALLAX_PROFILES, type OpticVariant, factoryZeroDistance, hasParallaxAdjustment } from "./optic-parallax";
import { triggerSpecFor, type TriggerSpec } from "./trigger-discipline";
import { supportsBoltHoldOpen } from "./bolt-catch";
import { triggerSpecFor as _ts } from "./trigger-discipline";
void _ts;

// ─────────────────────────────────────────────────────────────────────────────
// Drop / wind / TOF / energy chart rows.
// ─────────────────────────────────────────────────────────────────────────────

export interface DropChartRow {
  rangeM: number;
  dropCm: number;
  tofSec: number;
  velocityMs: number;
  energyJ: number;
}

const G = 9.81;

/**
 * Compute a drop chart for a weapon at 100, 200, 300, 400, 500 m.
 * Uses real-world muzzle velocity from the spec catalog.
 */
export function dropChartFor(weapon: WeaponType, rangesM = [100, 200, 300, 400, 500]): DropChartRow[] {
  const spec = REAL_WORLD_SPECS[weapon];
  if (!spec) return [];
  const v0 = spec.muzzleVelocityMs;
  const bc = 0.3; // G1 ballistic coefficient (typical for rifle bullets).

  return rangesM.map((r) => {
    // Simple ballistic model: deceleration from drag + gravity drop.
    // Use iterative solution: time of flight with drag.
    let vel = v0;
    let time = 0;
    const dt = 0.001;
    let dist = 0;
    while (dist < r && time < 10) {
      const drag = 0.0001 * vel * vel / bc; // simplified drag
      vel = Math.max(0, vel - drag * dt);
      dist += vel * dt;
      time += dt;
    }
    // Drop = 0.5 × g × t² (no air resistance on vertical).
    const dropCm = 0.5 * G * time * time * 100;
    // Energy = 0.5 × m × v². m = cartridge mass (typical rifle ~ 4 g).
    const massKg = 0.004;
    const energyJ = 0.5 * massKg * vel * vel;
    return { rangeM: r, dropCm, tofSec: time, velocityMs: Math.round(vel), energyJ: Math.round(energyJ) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Wind drift chart.
// ─────────────────────────────────────────────────────────────────────────────

export interface WindDriftRow {
  rangeM: number;
  wind5MsCm: number;
  wind10MsCm: number;
  wind15MsCm: number;
}

export function windDriftChartFor(weapon: WeaponType, rangesM = [100, 200, 300, 400, 500]): WindDriftRow[] {
  const spec = REAL_WORLD_SPECS[weapon];
  if (!spec) return [];
  const v0 = spec.muzzleVelocityMs;
  const bc = 0.3;
  const massKg = 0.004;

  return rangesM.map((r) => {
    // Wind drift = wind × t² / range (simplified deflection formula).
    let vel = v0;
    let time = 0;
    const dt = 0.001;
    let dist = 0;
    while (dist < r && time < 10) {
      const drag = 0.0001 * vel * vel / bc;
      vel = Math.max(0, vel - drag * dt);
      dist += vel * dt;
      time += dt;
    }
    // Wind drift = wind × time × (time / range) × ... (simplified).
    // Real formula: drift = wind × (time - range/v_avg).
    const drift5 = 5 * (time - r / vel) * 100;
    const drift10 = 10 * (time - r / vel) * 100;
    const drift15 = 15 * (time - r / vel) * 100;
    void massKg;
    return { rangeM: r, wind5MsCm: drift5, wind10MsCm: drift10, wind15MsCm: drift15 };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Heat-soak chart — POI shift vs rounds fired.
// ─────────────────────────────────────────────────────────────────────────────

export interface HeatSoakChartRow {
  roundsFired: number;
  heatFraction: number;
  poiVerticalMoa: number;
  poiHorizontalMoa: number;
}

export function heatSoakChartFor(weapon: WeaponType, roundsList = [0, 10, 20, 30, 50, 100]): HeatSoakChartRow[] {
  const profile = heatSoakProfileFor(weapon);
  let state = initBarrelHeatState();
  const rows: HeatSoakChartRow[] = [];
  let lastRounds = 0;
  for (const target of roundsList) {
    const shots = target - lastRounds;
    for (let i = 0; i < shots; i++) {
      state = injectShotHeat(state, profile);
    }
    const shift = barrelHeatPoiShift(state, profile);
    rows.push({
      roundsFired: target,
      heatFraction: state.fraction,
      poiVerticalMoa: shift.verticalMoa,
      poiHorizontalMoa: shift.horizontalMoa,
    });
    lastRounds = target;
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning recommendations.
// ─────────────────────────────────────────────────────────────────────────────

export interface TuningRecommendation {
  /** Category of recommendation. */
  category: "zero" | "optic" | "attachment" | "fire_mode" | "reload" | "maintenance";
  /** Short title. */
  title: string;
  /** Detailed recommendation. */
  description: string;
  /** Priority (0..1, 1 = highest). */
  priority: number;
}

/**
 * Generate tuning recommendations for a weapon + loadout.
 */
export function tuningRecommendations(
  weapon: WeaponType,
  loadout: LoadoutConfig,
): TuningRecommendation[] {
  const recs: TuningRecommendation[] = [];
  const spec = REAL_WORLD_SPECS[weapon];
  const cfg = WEAPONS[weapon];

  // Zero recommendation.
  if (cfg?.category === "SNIPER") {
    recs.push({
      category: "zero",
      title: "Set zero to 200 m",
      description: "Sniper rifles benefit from a 200 m zero — minimum bullet drop within ±5 cm out to 230 m.",
      priority: 0.9,
    });
  } else if (cfg?.category === "RIFLE") {
    recs.push({
      category: "zero",
      title: "Set zero to 100 m",
      description: "Assault rifles benefit from a 100 m zero — flat trajectory for typical engagement ranges.",
      priority: 0.7,
    });
  }

  // Optic recommendation.
  if (spec && spec.effectiveRangeM > 400) {
    recs.push({
      category: "optic",
      title: "Use 8× or higher scope",
      description: `Effective range ${spec.effectiveRangeM} m requires magnified optic. ${hasParallaxAdjustment("scope8x") ? "Set parallax to match target range." : ""}`,
      priority: 0.85,
    });
  } else if (spec && spec.effectiveRangeM < 150) {
    recs.push({
      category: "optic",
      title: "Use red dot or holographic sight",
      description: "Short-range weapon — magnification is unnecessary and limits FOV.",
      priority: 0.6,
    });
  }

  // Attachment recommendations.
  if (cfg && cfg.recoil > 0.030) {
    recs.push({
      category: "attachment",
      title: "Equip compensator + foregrip",
      description: `High recoil (${(cfg.recoil * 1000).toFixed(1)}) — compensator reduces vertical, foregrip reduces recovery time.`,
      priority: 0.8,
    });
  }
  if (loadout?.muzzle === "suppressor" && cfg && cfg.range > 200) {
    recs.push({
      category: "attachment",
      title: "Suppressor reduces range by 15%",
      description: "Consider flash hider if stealth is not required — preserves effective range.",
      priority: 0.5,
    });
  }

  // Fire mode recommendation.
  if (cfg?.category === "SMG" || cfg?.category === "LMG") {
    recs.push({
      category: "fire_mode",
      title: "Use burst fire at >50 m",
      description: "Full-auto at range wastes ammo — 3-round burst maintains accuracy.",
      priority: 0.55,
    });
  }

  // Reload recommendation.
  if (cfg && cfg.magSize <= 30) {
    recs.push({
      category: "reload",
      title: "Tactical reload at 50% mag",
      description: "Small-mag weapons should tactical-reload at 50% to avoid empty-reload penalty.",
      priority: 0.45,
    });
  }

  // Maintenance recommendation.
  recs.push({
    category: "maintenance",
    title: "Clean every 500 rounds",
    description: "Carbon fouling accumulates ~5% per hour without cleaning, increasing malfunction risk.",
    priority: 0.4,
  });

  return recs.sort((a, b) => b.priority - a.priority);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full tuning bench report — single object the React component renders.
// ─────────────────────────────────────────────────────────────────────────────

export interface TuningBenchReport {
  weapon: WeaponType;
  weaponName: string;
  realWorldSpec?: RealWorldWeaponSpec;
  dropChart: DropChartRow[];
  windDriftChart: WindDriftRow[];
  heatSoakChart: HeatSoakChartRow[];
  heatProfile: BarrelHeatProfile;
  railSummary: WeaponRailSummary;
  fireSelectorPositions: FireSelectorPosition[];
  burstRounds: number;
  reloadTimings: { type: ReloadType; stages: ReturnType<typeof reloadStages>; totalMs: number }[];
  triggerSpec: TriggerSpec;
  supportsBho: boolean;
  effectiveRpm: number;
  recommendations: TuningRecommendation[];
  formattedStats: {
    muzzleVelocity: string;
    weight: string;
    barrelLength: string;
    muzzleEnergy: string;
    cyclicRate: string;
  };
  socketLabels: ReturnType<typeof socketLabelList>;
  opticParallaxFactoryZero: number;
  opticParallaxAdjustable: boolean;
}

export function buildTuningBenchReport(
  weapon: WeaponType,
  loadout?: LoadoutConfig,
): TuningBenchReport {
  const spec = REAL_WORLD_SPECS[weapon];
  const cfg = WEAPONS[weapon];
  const layout = selectorLayoutFor(weapon);
  const opticVariant = (loadout?.sight ?? "none") as OpticVariant;
  const opticProfile = OPTIC_PARALLAX_PROFILES[opticVariant];

  const reloadTimings: TuningBenchReport["reloadTimings"] = (["tactical", "speed", "empty"] as ReloadType[])
    .map((t) => {
      const timings = computeReloadTimings(weapon, t, loadout?.magazine);
      return { type: t, stages: reloadStages(t, timings), totalMs: timings.totalMs };
    });

  return {
    weapon,
    weaponName: cfg?.name ?? weapon,
    realWorldSpec: spec,
    dropChart: dropChartFor(weapon),
    windDriftChart: windDriftChartFor(weapon),
    heatSoakChart: heatSoakChartFor(weapon),
    heatProfile: heatSoakProfileFor(weapon),
    railSummary: railSummaryFor(weapon),
    fireSelectorPositions: layout.positions,
    burstRounds: layout.burstRounds,
    reloadTimings,
    triggerSpec: triggerSpecFor(weapon),
    supportsBho: supportsBoltHoldOpen(weapon),
    effectiveRpm: effectiveRpmInMode(weapon, "auto"),
    recommendations: tuningRecommendations(weapon, loadout ?? {} as LoadoutConfig),
    formattedStats: spec ? {
      muzzleVelocity: formatMuzzleVelocity(spec.muzzleVelocityMs),
      weight: formatWeight(spec.weightKg),
      barrelLength: formatBarrelLength(spec.barrelMm),
      muzzleEnergy: formatMuzzleEnergy(spec.muzzleEnergyJ),
      cyclicRate: formatCyclicRate(spec.cyclicRpm),
    } : {
      muzzleVelocity: "—", weight: "—", barrelLength: "—",
      muzzleEnergy: "—", cyclicRate: "—",
    },
    socketLabels: socketLabelList(weapon),
    opticParallaxFactoryZero: opticProfile ? opticProfile.factoryZeroM : Infinity,
    opticParallaxAdjustable: opticProfile ? opticProfile.adjustable : false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Weapon comparison — for the spec card to compare two weapons.
// ─────────────────────────────────────────────────────────────────────────────

export interface WeaponComparisonRow {
  label: string;
  weaponA: string;
  weaponB: string;
  /** "a" = A is better, "b" = B is better, "=" = equal. */
  better: "a" | "b" | "=";
}

export function compareTwoWeapons(a: WeaponType, b: WeaponType): WeaponComparisonRow[] {
  const specA = REAL_WORLD_SPECS[a];
  const specB = REAL_WORLD_SPECS[b];
  const cfgA = WEAPONS[a];
  const cfgB = WEAPONS[b];
  if (!specA || !specB || !cfgA || !cfgB) return [];

  const rows: WeaponComparisonRow[] = [
    { label: "Damage", weaponA: `${cfgA.damage}`, weaponB: `${cfgB.damage}`, better: cfgA.damage > cfgB.damage ? "a" : cfgA.damage < cfgB.damage ? "b" : "=" },
    { label: "Muzzle Velocity", weaponA: formatMuzzleVelocity(specA.muzzleVelocityMs), weaponB: formatMuzzleVelocity(specB.muzzleVelocityMs), better: specA.muzzleVelocityMs > specB.muzzleVelocityMs ? "a" : "b" },
    { label: "Cyclic Rate", weaponA: formatCyclicRate(specA.cyclicRpm), weaponB: formatCyclicRate(specB.cyclicRpm), better: specA.cyclicRpm > specB.cyclicRpm ? "a" : "b" },
    { label: "Effective Range", weaponA: `${specA.effectiveRangeM} m`, weaponB: `${specB.effectiveRangeM} m`, better: specA.effectiveRangeM > specB.effectiveRangeM ? "a" : "b" },
    { label: "Weight (empty)", weaponA: formatWeight(specA.weightKg), weaponB: formatWeight(specB.weightKg), better: specA.weightKg < specB.weightKg ? "a" : "b" },
    { label: "Magazine Size", weaponA: `${cfgA.magSize}`, weaponB: `${cfgB.magSize}`, better: cfgA.magSize > cfgB.magSize ? "a" : "b" },
    { label: "Muzzle Energy", weaponA: formatMuzzleEnergy(specA.muzzleEnergyJ), weaponB: formatMuzzleEnergy(specB.muzzleEnergyJ), better: specA.muzzleEnergyJ > specB.muzzleEnergyJ ? "a" : "b" },
    { label: "Recoil", weaponA: `${cfgA.recoil.toFixed(3)}`, weaponB: `${cfgB.recoil.toFixed(3)}`, better: cfgA.recoil < cfgB.recoil ? "a" : "b" },
    { label: "Reload Time", weaponA: `${(cfgA.reloadTime / 1000).toFixed(1)} s`, weaponB: `${(cfgB.reloadTime / 1000).toFixed(1)} s`, better: cfgA.reloadTime < cfgB.reloadTime ? "a" : "b" },
  ];
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog-wide stats — for the spec card.
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogStat {
  label: string;
  value: string;
}

export function catalogStats(): CatalogStat[] {
  const allSpecs = Object.values(REAL_WORLD_SPECS);
  const allExtended = Object.values(REAL_WORLD_EXTENDED);
  const total = allSpecs.length + allExtended.length;
  const avgVel = Math.round(
    [...allSpecs, ...allExtended].reduce((s, x) => s + x.muzzleVelocityMs, 0) / total,
  );
  const maxRange = Math.max(
    ...[...allSpecs, ...allExtended].map((x) => x.effectiveRangeM),
  );
  const heaviest = Math.max(
    ...[...allSpecs, ...allExtended].map((x) => x.weightKg),
  );
  return [
    { label: "Total Catalog", value: `${total} weapons` },
    { label: "Avg Muzzle Velocity", value: `${avgVel} m/s` },
    { label: "Max Effective Range", value: `${maxRange} m` },
    { label: "Heaviest Weapon", value: `${heaviest.toFixed(1)} kg` },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Lint helpers — exported to satisfy "no unused" lint rules when the
// component imports some but not all helpers.
// ─────────────────────────────────────────────────────────────────────────────

export { railLabel, selLabel, reloadTypeLabel, factoryZeroDistance };
