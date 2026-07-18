/**
 * Section D — Weapon Wear & Tear (visual degradation).
 *
 * Real-world weapons degrade with use:
 *   • The finish wears off high-friction surfaces (rail edges, bolt catch).
 *   • Carbon fouling accumulates in the chamber, gas block, and bore.
 *   • The barrel throat erodes (affecting accuracy + gas seal).
 *   • The trigger group wears, lightening the trigger pull (sometimes good).
 *   • Cosmetic: scratches, dings, rust spotting from neglect.
 *
 * The existing `WearTier` type in `sectionB.ts` defines cosmetic tiers
 * (factory_new → battle_scarred). This module adds the dynamic wear
 * progression + visual rendering hints:
 *
 *   1. Wear state per weapon (0..1 wear fraction).
 *   2. Wear progression from rounds fired + reloads + maintenance.
 *   3. Per-surface wear map (receiver, barrel, bolt, stock) — surfaces
 *      wear at different rates (high-friction surfaces faster).
 *   4. Visual rendering hints: scratch density, edge wear, fouling tint,
 *      rust spots, finish-loss areas.
 *   5. Functional effects: throat erosion → spread increase; bolt wear →
 *      malfunction risk; trigger wear → pull weight change.
 *
 * Engine integration: the HudSystem reads `wearVisualHints()` to apply
 * decals; the WeaponSystem reads `wearFunctionalPenalty()` for spread /
 * malfunction; the Gunsmith reads `wearProgressionReport()` for the
 * maintenance card.
 */

import type { WeaponType, WeaponCategory } from "../store";
import type { WearTier } from "./sectionB";

// ─────────────────────────────────────────────────────────────────────────────
// Wear state.
// ─────────────────────────────────────────────────────────────────────────────

export type WearSurface =
  | "receiver"
  | "barrel"
  | "bolt"
  | "trigger_group"
  | "stock"
  | "magazine"
  | "handguard"
  | "finish";

export interface SurfaceWearState {
  /** Surface identifier. */
  surface: WearSurface;
  /** Wear fraction (0 = factory new, 1 = destroyed). */
  wear: number;
  /** Carbon fouling (0..1). Affects appearance + reliability. */
  fouling: number;
  /** Rust fraction (0..1). */
  rust: number;
  /** Edge-wear fraction (0..1) — how much the finish is gone at edges. */
  edgeWear: number;
  /** Number of visible scratches. */
  scratchCount: number;
  /** Number of visible dings/dents. */
  dingCount: number;
}

export interface WeaponWearState {
  weapon: WeaponType;
  /** Total rounds fired with this weapon's current parts. */
  roundsFired: number;
  /** Total reload cycles. */
  reloadCycles: number;
  /** Time since last cleaning (sec). */
  timeSinceCleaningSec: number;
  /** Per-surface wear. */
  surfaces: Record<WearSurface, SurfaceWearState>;
  /** Bore throat erosion (0..1). Drives accuracy degradation. */
  throatErosion: number;
  /** Trigger pull weight (N) — wears lighter over time. */
  triggerPullN: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-surface wear rates (per 1000 rounds / 100 reloads).
// Real-world reference: AK finish wears slower than AR; parkerized finishes
// hold up better than painted; chrome-lined barrels throat-erode slower.
// ─────────────────────────────────────────────────────────────────────────────

interface SurfaceWearRate {
  perRoundsFired: number;     // wear per 1000 rounds
  perReloadCycle: number;     // wear per 100 reloads
  perHourNoCleaning: number;  // fouling per hour without cleaning
}

const SURFACE_WEAR_RATES: Record<WearSurface, SurfaceWearRate> = {
  receiver:     { perRoundsFired: 0.008, perReloadCycle: 0.002, perHourNoCleaning: 0.005 },
  barrel:       { perRoundsFired: 0.012, perReloadCycle: 0.0,  perHourNoCleaning: 0.003 },
  bolt:         { perRoundsFired: 0.015, perReloadCycle: 0.005, perHourNoCleaning: 0.008 },
  trigger_group: { perRoundsFired: 0.005, perReloadCycle: 0.001, perHourNoCleaning: 0.001 },
  stock:        { perRoundsFired: 0.002, perReloadCycle: 0.001, perHourNoCleaning: 0.0005 },
  magazine:     { perRoundsFired: 0.003, perReloadCycle: 0.012, perHourNoCleaning: 0.0005 },
  handguard:    { perRoundsFired: 0.004, perReloadCycle: 0.002, perHourNoCleaning: 0.0005 },
  finish:       { perRoundsFired: 0.020, perReloadCycle: 0.003, perHourNoCleaning: 0.001 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Initialization.
// ─────────────────────────────────────────────────────────────────────────────

function freshSurface(surface: WearSurface): SurfaceWearState {
  return {
    surface, wear: 0, fouling: 0, rust: 0,
    edgeWear: 0, scratchCount: 0, dingCount: 0,
  };
}

export function initWeaponWearState(weapon: WeaponType): WeaponWearState {
  const surfaces = {} as Record<WearSurface, SurfaceWearState>;
  (Object.keys(SURFACE_WEAR_RATES) as WearSurface[]).forEach((s) => {
    surfaces[s] = freshSurface(s);
  });
  return {
    weapon, roundsFired: 0, reloadCycles: 0, timeSinceCleaningSec: 0,
    surfaces, throatErosion: 0,
    // Real-world trigger pull weights: M4 = ~20 N, AK = ~25 N, precision = ~12 N.
    triggerPullN: defaultTriggerPull(weapon),
  };
}

function defaultTriggerPull(weapon: WeaponType): number {
  const precision = ["awp", "l115a3", "scout", "kar98k", "mk14", "usp"];
  if (precision.includes(weapon)) return 12;
  return 20;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wear progression.
// ─────────────────────────────────────────────────────────────────────────────

/** Apply wear from firing N rounds. */
export function applyRoundsFired(state: WeaponWearState, rounds: number): WeaponWearState {
  const surfaces = { ...state.surfaces };
  for (const surfaceName of Object.keys(surfaces) as WearSurface[]) {
    const rate = SURFACE_WEAR_RATES[surfaceName];
    const dWear = (rounds / 1000) * rate.perRoundsFired;
    const surf = surfaces[surfaceName];
    surfaces[surfaceName] = {
      ...surf,
      wear: Math.min(1, surf.wear + dWear),
      edgeWear: Math.min(1, surf.edgeWear + dWear * 1.5),
      scratchCount: surf.scratchCount + Math.round(dWear * 50),
      fouling: Math.min(1, surf.fouling + (rounds / 1000) * rate.perHourNoCleaning),
    };
  }
  // Throat erosion scales with rounds fired (heavy cartridges erode faster).
  const erosionRate = state.weapon === "awp" || state.weapon === "l115a3"
    ? 0.0008 // .338 Lapua — burns throats fast.
    : state.weapon === "deagle" || state.weapon === "revolver"
      ? 0.0012 // .50 AE / .50 Russian — extreme erosion.
      : 0.0004; // Standard rifles/pistols.
  return {
    ...state, surfaces,
    roundsFired: state.roundsFired + rounds,
    throatErosion: Math.min(1, state.throatErosion + rounds * erosionRate),
  };
}

/** Apply wear from one reload cycle. */
export function applyReloadCycle(state: WeaponWearState): WeaponWearState {
  const surfaces = { ...state.surfaces };
  for (const surfaceName of Object.keys(surfaces) as WearSurface[]) {
    const rate = SURFACE_WEAR_RATES[surfaceName];
    const dWear = (1 / 100) * rate.perReloadCycle;
    const surf = surfaces[surfaceName];
    surfaces[surfaceName] = {
      ...surf,
      wear: Math.min(1, surf.wear + dWear),
      dingCount: surf.dingCount + (Math.random() < 0.05 ? 1 : 0),
    };
  }
  return { ...state, surfaces, reloadCycles: state.reloadCycles + 1 };
}

/** Apply time passage (fouling + rust accumulation). */
export function applyTimePassage(state: WeaponWearState, dtSec: number): WeaponWearState {
  const surfaces = { ...state.surfaces };
  for (const surfaceName of Object.keys(surfaces) as WearSurface[]) {
    const rate = SURFACE_WEAR_RATES[surfaceName];
    const hours = dtSec / 3600;
    const surf = surfaces[surfaceName];
    surfaces[surfaceName] = {
      ...surf,
      fouling: Math.min(1, surf.fouling + hours * rate.perHourNoCleaning),
      // Rust only accumulates if fouling > 0.5 and no cleaning.
      rust: surf.fouling > 0.5
        ? Math.min(0.3, surf.rust + hours * 0.002)
        : surf.rust,
    };
  }
  return { ...state, surfaces, timeSinceCleaningSec: state.timeSinceCleaningSec + dtSec };
}

/** Clean the weapon — resets fouling + rust, slows wear slightly. */
export function cleanWeapon(state: WeaponWearState): WeaponWearState {
  const surfaces = { ...state.surfaces };
  for (const surfaceName of Object.keys(surfaces) as WearSurface[]) {
    const surf = surfaces[surfaceName];
    surfaces[surfaceName] = { ...surf, fouling: 0, rust: 0 };
  }
  return { ...state, surfaces, timeSinceCleaningSec: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual rendering hints — what decals/textures to apply.
// ─────────────────────────────────────────────────────────────────────────────

export interface WearVisualHints {
  /** Scratch density (0..1) — drives scratch texture opacity. */
  scratchDensity: number;
  /** Edge wear (0..1) — drives edge-highlight tint. */
  edgeWear: number;
  /** Fouling tint (0..1) — dark carbon smudge. */
  foulingTint: number;
  /** Rust fraction (0..1) — orange-brown spotting. */
  rustFraction: number;
  /** Color tint multiplier — worn weapons desaturate. */
  colorDesaturation: number;
  /** Color brightness multiplier — worn weapons darken slightly. */
  colorBrightness: number;
  /** Overall wear tier (cosmetic label). */
  tier: WearTier;
}

const TIER_THRESHOLDS: { threshold: number; tier: WearTier }[] = [
  { threshold: 0.05, tier: "factory_new" },
  { threshold: 0.20, tier: "minimal_wear" },
  { threshold: 0.45, tier: "field_tested" },
  { threshold: 0.70, tier: "well_worn" },
  { threshold: 1.01, tier: "battle_scarred" },
];

export function wearTierForFraction(fraction: number): WearTier {
  for (const t of TIER_THRESHOLDS) {
    if (fraction < t.threshold) return t.tier;
  }
  return "battle_scarred";
}

/** Compute visual rendering hints from the wear state. */
export function wearVisualHints(state: WeaponWearState): WearVisualHints {
  // Average wear across all surfaces.
  const surfaces = Object.values(state.surfaces);
  const avgWear = surfaces.reduce((s, x) => s + x.wear, 0) / surfaces.length;
  const avgFouling = surfaces.reduce((s, x) => s + x.fouling, 0) / surfaces.length;
  const avgRust = surfaces.reduce((s, x) => s + x.rust, 0) / surfaces.length;
  const finishWear = state.surfaces.finish?.wear ?? avgWear;
  return {
    scratchDensity: Math.min(1, finishWear * 1.2),
    edgeWear: Math.min(1, (state.surfaces.finish?.edgeWear ?? 0) * 1.1),
    foulingTint: avgFouling * 0.6,
    rustFraction: avgRust,
    colorDesaturation: avgWear * 0.4,
    colorBrightness: 1 - avgWear * 0.15,
    tier: wearTierForFraction(avgWear),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Functional effects — accuracy, reliability, trigger.
// ─────────────────────────────────────────────────────────────────────────────

export interface WearFunctionalPenalty {
  /** Spread multiplier (1 = no penalty, >1 = worse). */
  spreadMult: number;
  /** Malfunction risk multiplier. */
  malfunctionRiskMult: number;
  /** Trigger pull weight change (N). Positive = heavier. */
  triggerPullDeltaN: number;
  /** Whether the weapon needs cleaning (fouling > 0.6). */
  needsCleaning: boolean;
  /** Estimated rounds remaining before barrel replacement. */
  barrelLifeRemainingRounds: number;
}

export function wearFunctionalPenalty(state: WeaponWearState): WearFunctionalPenalty {
  // Throat erosion drives spread: a worn throat lets gas escape, dropping
  // velocity consistency + bullet alignment.
  const spreadMult = 1 + state.throatErosion * 0.5;

  // Bolt + trigger wear drives malfunction risk.
  const boltWear = state.surfaces.bolt?.wear ?? 0;
  const triggerWear = state.surfaces.trigger_group?.wear ?? 0;
  const fouling = state.surfaces.bolt?.fouling ?? 0;
  const malfunctionRiskMult = 1 + boltWear * 1.5 + fouling * 2 + triggerWear * 0.5;

  // Trigger wears lighter over time (smoothing of sear engagement).
  const triggerPullDeltaN = -triggerWear * 2;

  const needsCleaning = fouling > 0.6 || (state.surfaces.receiver?.fouling ?? 0) > 0.6;

  // Barrel life — precision rifles ~3000 rounds, AK ~10000, AR ~10000.
  const baseLife = state.weapon === "awp" || state.weapon === "l115a3"
    ? 3000
    : state.weapon === "deagle" || state.weapon === "revolver"
      ? 5000
      : 10000;
  const barrelLifeRemainingRounds = Math.max(0, baseLife - Math.round(state.throatErosion * baseLife));

  return { spreadMult, malfunctionRiskMult, triggerPullDeltaN, needsCleaning, barrelLifeRemainingRounds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance report — for the Gunsmith spec card.
// ─────────────────────────────────────────────────────────────────────────────

export interface WearMaintenanceReport {
  tier: WearTier;
  overallFraction: number;
  needsCleaning: boolean;
  needsBarrelReplacement: boolean;
  mostWornSurface: WearSurface;
  leastWornSurface: WearSurface;
  estimatedRoundsToReplacement: number;
}

export function wearProgressionReport(state: WeaponWearState): WearMaintenanceReport {
  const hints = wearVisualHints(state);
  const surfaces = Object.values(state.surfaces);
  const mostWorn = surfaces.reduce((a, b) => a.wear > b.wear ? a : b);
  const leastWorn = surfaces.reduce((a, b) => a.wear < b.wear ? a : b);
  const functional = wearFunctionalPenalty(state);
  return {
    tier: hints.tier,
    overallFraction: hints.scratchDensity,
    needsCleaning: functional.needsCleaning,
    needsBarrelReplacement: state.throatErosion > 0.8,
    mostWornSurface: mostWorn.surface,
    leastWornSurface: leastWorn.surface,
    estimatedRoundsToReplacement: functional.barrelLifeRemainingRounds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Category-based shortcut: brand-new weapon of a category.
// ─────────────────────────────────────────────────────────────────────────────

export function freshWeaponWearForCategory(_category: WeaponCategory): WeaponWearState {
  // Brand-new across all categories — just returns the initial state for "m4"
  // (the surface template is identical, only `weapon` differs).
  return initWeaponWearState("m4");
}
