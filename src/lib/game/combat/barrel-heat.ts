/**
 * Section D — Barrel Heat Soak.
 *
 * Real-world barrels deform as they heat up: the steel expands, the bore
 * shifts slightly, and the point of impact (POI) drifts. A precision rifle
 * shooting 5-round strings will see ~0.5 MOA shift per 50 rounds of sustained
 * fire; an LMG dumping a belt will see ~2 MOA shift.
 *
 * The existing `barrelHeat` field in `WeaponRuntimeState` (WeaponSystem.ts)
 * is a 0..1 heat scalar with malfunction risk (cook-off at >0.95). This
 * module adds the POI-shift layer on top:
 *
 *   1. POI shift as a function of barrel heat (vertical + horizontal).
 *   2. Heat-soak curve: barrel heats faster than it cools (thermal mass).
 *   3. Per-weapon heat capacity (light barrels soak faster than heavy).
 *   4. Per-shot heat injection scaled by cartridge energy.
 *   5. Cooling rate: air-cooled vs forced-air (fan assist, bipod stationary).
 *
 * Engine integration: the WeaponSystem calls `barrelHeatPoiShiftRad()`
 * once per shot and adds the offset to the shot direction; the HudSystem
 * reads `barrelThermometerFraction()` for the HUD thermometer; the
 * Gunsmith reads `heatSoakProfileFor()` for the spec card.
 */

import type { WeaponType } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Heat-soak profile per weapon.
// ─────────────────────────────────────────────────────────────────────────────

export interface BarrelHeatProfile {
  /** Barrel mass (kg). Heavier barrels soak more heat per shot. */
  barrelMassKg: number;
  /** Barrel profile: light / medium / heavy / fluted. */
  profile: "light" | "medium" | "heavy" | "fluted" | "bull" | "belt-fed";
  /** Heat injected per shot (J). Scaled by cartridge muzzle energy. */
  heatPerShotJ: number;
  /** Maximum sustainable heat capacity (J). Heat / capacity = 0..1. */
  heatCapacityJ: number;
  /** Cooling rate (J/sec) when not firing. */
  coolingRateJPerSec: number;
  /** POI vertical drift per 10% heat (MOA). */
  poiVerticalPerHeatDecileMoa: number;
  /** POI horizontal drift per 10% heat (MOA). Usually asymmetric. */
  poiHorizontalPerHeatDecileMoa: number;
  /** Temperature at which cook-off risk begins (°C). */
  cookOffThresholdC: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-weapon profiles. Heat capacity is based on barrel mass × specific heat
// of steel (~470 J/kg·K) and a max temperature rise of 350 K above ambient.
// ─────────────────────────────────────────────────────────────────────────────

function makeProfile(
  barrelMassKg: number,
  profile: BarrelHeatProfile["profile"],
  heatPerShotJ: number,
  coolingJPerSec: number,
  poiV: number,
  poiH: number,
): BarrelHeatProfile {
  const heatCapacityJ = barrelMassKg * 470 * 350; // 350 K rise
  return {
    barrelMassKg,
    profile,
    heatPerShotJ,
    heatCapacityJ,
    coolingRateJPerSec: coolingJPerSec,
    poiVerticalPerHeatDecileMoa: poiV,
    poiHorizontalPerHeatDecileMoa: poiH,
    cookOffThresholdC: 250,
  };
}

export const BARREL_HEAT_PROFILES: Partial<Record<WeaponType, BarrelHeatProfile>> = {
  // Rifles — medium barrels.
  ak74: makeProfile(0.9, "medium", 35, 4, 0.4, 0.2),
  m4:   makeProfile(0.7, "light", 30, 3.5, 0.5, 0.3),
  hk416: makeProfile(0.8, "medium", 30, 4, 0.45, 0.25),
  famas: makeProfile(0.75, "medium", 30, 3.8, 0.5, 0.3),
  aug:   makeProfile(0.8, "medium", 30, 4, 0.45, 0.25),
  scarh: makeProfile(1.1, "heavy", 55, 4.5, 0.3, 0.15),
  galil: makeProfile(1.0, "medium", 30, 4.2, 0.4, 0.2),
  mk17:  makeProfile(1.1, "heavy", 55, 4.5, 0.3, 0.15),
  mk14:  makeProfile(1.2, "heavy", 55, 4.5, 0.25, 0.12),

  // SMGs — light barrels, less heat.
  mp7:  makeProfile(0.3, "light", 15, 3, 0.8, 0.4),
  p90:  makeProfile(0.35, "light", 12, 3.2, 0.7, 0.35),
  mp5:  makeProfile(0.4, "medium", 18, 3.5, 0.6, 0.3),
  ump45: makeProfile(0.45, "medium", 22, 3.5, 0.6, 0.3),
  vector: makeProfile(0.3, "light", 22, 3, 0.8, 0.4),
  pp90m1: makeProfile(0.35, "light", 18, 3.2, 0.7, 0.35),

  // Pistols — very low thermal mass; POI shift negligible but rapid cook-off risk.
  usp:     makeProfile(0.15, "light", 8, 2, 1.0, 0.5),
  deagle:  makeProfile(0.25, "medium", 22, 2.5, 0.8, 0.4),
  glock18: makeProfile(0.12, "light", 7, 2, 1.2, 0.6),
  m1911:   makeProfile(0.18, "medium", 9, 2, 0.9, 0.45),
  revolver: makeProfile(0.22, "medium", 25, 2.5, 0.7, 0.35),

  // Snipers — heavy barrels; POI shift is precision-critical.
  awp:    makeProfile(1.5, "bull", 80, 4, 0.15, 0.08),
  scout:  makeProfile(1.0, "medium", 45, 3.5, 0.3, 0.15),
  kar98k: makeProfile(1.4, "heavy", 65, 3.8, 0.2, 0.1),
  l115a3: makeProfile(1.6, "bull", 80, 4, 0.12, 0.06),

  // Shotguns — low velocity, low heat.
  nova:   makeProfile(0.8, "medium", 25, 3.5, 0.6, 0.3),
  m1014:  makeProfile(0.8, "medium", 25, 3.5, 0.6, 0.3),
  spas12: makeProfile(0.85, "medium", 25, 3.5, 0.6, 0.3),

  // LMGs — belt-fed heavy barrels, large heat capacity, but rapid injection.
  m249: makeProfile(2.2, "belt-fed", 35, 6, 0.3, 0.15),
  rpk:  makeProfile(1.8, "heavy", 30, 5.5, 0.35, 0.18),
  mk48: makeProfile(2.5, "belt-fed", 55, 6.5, 0.25, 0.12),
};

export function heatSoakProfileFor(weapon: WeaponType): BarrelHeatProfile {
  return BARREL_HEAT_PROFILES[weapon] ?? makeProfile(0.8, "medium", 30, 4, 0.5, 0.25);
}

// ─────────────────────────────────────────────────────────────────────────────
// Heat-soak runtime state (per weapon, per match).
// ─────────────────────────────────────────────────────────────────────────────

export interface BarrelHeatState {
  /** Current thermal energy in the barrel (J). */
  energyJ: number;
  /** Temperature above ambient (°C). Derived: energyJ / (mass × 470). */
  tempC: number;
  /** Fraction of heat capacity (0..1). The same value as WeaponRuntimeState.barrelHeat. */
  fraction: number;
  /** Time since last shot (sec). */
  timeSinceShotSec: number;
  /** Total shots fired with this barrel in the current match. */
  totalShots: number;
}

/** Initialize a fresh barrel heat state. */
export function initBarrelHeatState(): BarrelHeatState {
  return { energyJ: 0, tempC: 25, fraction: 0, timeSinceShotSec: Infinity, totalShots: 0 };
}

/** Inject heat for one shot. Returns the new state. */
export function injectShotHeat(
  state: BarrelHeatState,
  profile: BarrelHeatProfile,
  cartridgeMultiplier = 1.0,
): BarrelHeatState {
  const dE = profile.heatPerShotJ * cartridgeMultiplier;
  const energyJ = Math.min(profile.heatCapacityJ, state.energyJ + dE);
  const tempC = 25 + (energyJ / (profile.barrelMassKg * 470));
  return {
    energyJ,
    tempC,
    fraction: energyJ / profile.heatCapacityJ,
    timeSinceShotSec: 0,
    totalShots: state.totalShots + 1,
  };
}

/** Cool the barrel by dt seconds. */
export function coolBarrel(
  state: BarrelHeatState,
  profile: BarrelHeatProfile,
  dtSec: number,
): BarrelHeatState {
  // Cooling is non-linear: faster at high temp, slows as it approaches ambient.
  // Newton's law of cooling: dT/dt = -k(T - T_ambient).
  const ambientC = 25;
  const k = profile.coolingRateJPerSec / (profile.barrelMassKg * 470 * 100);
  const tempC = ambientC + (state.tempC - ambientC) * Math.exp(-k * dtSec);
  const energyJ = Math.max(0, (tempC - ambientC) * profile.barrelMassKg * 470);
  return {
    energyJ,
    tempC,
    fraction: energyJ / profile.heatCapacityJ,
    timeSinceShotSec: state.timeSinceShotSec + dtSec,
    totalShots: state.totalShots,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POI shift computation.
// ─────────────────────────────────────────────────────────────────────────────

export interface PoiShift {
  /** Vertical shift (MOA). Positive = high. */
  verticalMoa: number;
  /** Horizontal shift (MOA). Positive = right. */
  horizontalMoa: number;
  /** Total shift magnitude (MOA). */
  magnitudeMoa: number;
  /** Total shift in radians (for adding to shot direction). */
  shiftRad: number;
  /** Vertical shift in radians. */
  verticalRad: number;
  /** Horizontal shift in radians. */
  horizontalRad: number;
}

const MOA_TO_RAD = Math.PI / (180 * 60);

/** Compute the POI shift for the current heat state. */
export function barrelHeatPoiShift(
  state: BarrelHeatState,
  profile: BarrelHeatProfile,
): PoiShift {
  // POI shift scales with the heat fraction. Most barrels walk UP as they
  // heat (barrel droops downward under gravity, but heat expansion dominates
  // upward); some walk RIGHT (gas block heating on one side).
  // Each "decile" of heat (0.1) produces the profile's per-decile MOA shift.
  const deciles = state.fraction * 10;
  const verticalMoa = deciles * profile.poiVerticalPerHeatDecileMoa;
  // Add a small random walk — real barrels don't shift deterministically.
  const horizontalMoa = deciles * profile.poiHorizontalPerHeatDecileMoa
    + (state.totalShots % 2 === 0 ? 0.05 : -0.05);

  const magnitudeMoa = Math.sqrt(
    verticalMoa * verticalMoa + horizontalMoa * horizontalMoa,
  );
  const verticalRad = verticalMoa * MOA_TO_RAD;
  const horizontalRad = horizontalMoa * MOA_TO_RAD;
  return {
    verticalMoa, horizontalMoa, magnitudeMoa,
    shiftRad: magnitudeMoa * MOA_TO_RAD,
    verticalRad, horizontalRad,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD / display helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** Thermometer fraction for the HUD (0..1). */
export function barrelThermometerFraction(state: BarrelHeatState): number {
  return Math.max(0, Math.min(1, state.fraction));
}

/** Color for the thermometer — green → yellow → red. */
export function barrelThermometerColor(state: BarrelHeatState): [number, number, number] {
  const f = state.fraction;
  if (f < 0.5) {
    // Green → yellow.
    const t = f / 0.5;
    return [t, 1, 0];
  }
  // Yellow → red.
  const t = (f - 0.5) / 0.5;
  return [1, 1 - t, 0];
}

/** Cook-off risk (0..1). */
export function cookOffRisk(state: BarrelHeatState, profile: BarrelHeatProfile): number {
  const thresholdFraction = (profile.cookOffThresholdC - 25) / 350;
  if (state.fraction < thresholdFraction) return 0;
  if (state.fraction >= 1) return 1;
  return (state.fraction - thresholdFraction) / (1 - thresholdFraction);
}

/** Format temperature for the HUD. */
export function formatBarrelTemp(state: BarrelHeatState): string {
  return `${Math.round(state.tempC)} °C`;
}

/** Format POI shift for the spec card. */
export function formatPoiShiftMoa(shift: PoiShift): string {
  const sign = (n: number) => (n >= 0 ? "+" : "");
  return `${sign(shift.verticalMoa)}${shift.verticalMoa.toFixed(1)} / ${sign(shift.horizontalMoa)}${shift.horizontalMoa.toFixed(1)} MOA`;
}
