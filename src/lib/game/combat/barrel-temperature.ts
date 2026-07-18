/**
 * Section C — Barrel heat-soak model affecting accuracy.
 *
 * As a barrel heats up under sustained fire, three things happen:
 *   1. The barrel droops slightly and the bore expands → point-of-impact
 *      (POI) shifts, usually upward and slightly sideways.
 *   2. Mirage heat waves rise off the barrel in front of the scope,
 *      distorting the sight picture.
 *   3. Past a threshold (~400°C for 5.56mm) the chamber can reach
 *      "cook-off" temperature — a chambered round ignites from barrel
 *      heat alone, without a trigger pull.
 *
 * This module tracks per-weapon barrel temperature with first-order
 * heat/cool dynamics and exposes the accuracy / POI / mirage / cook-off
 * queries the WeaponSystem and PostProcessing pipeline read each frame.
 * Tone: src/lib/game/DESIGN.md (tactical-mil-sim-leaning-arcade).
 */
import type { WeaponType } from "../store";

/** Per-weapon thermal profile. */
export interface BarrelThermalProfile {
  /** Heat added per shot (°C). */
  heatPerShotC: number;
  /** Passive cooling rate (°C per second at ambient). */
  coolingPerS: number;
  /** POI vertical shift per 100°C above ambient (milliradians). */
  poiShiftPer100C_mrad: number;
  /** POI horizontal drift per 100°C (mrad). */
  poiDriftPer100C_mrad: number;
  /** Cook-off threshold (°C). Above this, chambered round may auto-fire. */
  cookOffThresholdC: number;
  /** Mirage intensity coefficient (0..1 per 100°C above ambient). */
  mirageCoeff: number;
  /** Barrel mass (kg) — heavier barrels soak more heat. */
  barrelMassKg: number;
}

/** Live barrel-temperature state for one weapon instance. */
export interface BarrelThermalState {
  weapon: WeaponType;
  /** Current barrel temperature (°C). */
  tempC: number;
  /** Ambient temperature (°C). */
  ambientC: number;
  /** Shots fired since last cool-down to ambient. */
  shotsSinceCold: number;
}

/** Per-weapon thermal profiles (real steel-barrel estimates). */
export const BARREL_THERMAL_PROFILES: Partial<Record<WeaponType, BarrelThermalProfile>> = {
  // Rifles — M4-profile 14.5" barrel ~0.9kg
  m4:   { heatPerShotC: 2.2, coolingPerS: 0.45, poiShiftPer100C_mrad: 0.8, poiDriftPer100C_mrad: 0.2, cookOffThresholdC: 420, mirageCoeff: 0.6, barrelMassKg: 0.9 },
  ak74: { heatPerShotC: 2.4, coolingPerS: 0.40, poiShiftPer100C_mrad: 0.9, poiDriftPer100C_mrad: 0.3, cookOffThresholdC: 430, mirageCoeff: 0.6, barrelMassKg: 0.85 },
  hk416:{ heatPerShotC: 2.0, coolingPerS: 0.48, poiShiftPer100C_mrad: 0.7, poiDriftPer100C_mrad: 0.2, cookOffThresholdC: 430, mirageCoeff: 0.55,barrelMassKg: 1.0 },
  // 7.62 battle rifles — heavier barrel, more heat per shot
  scarh:{ heatPerShotC: 3.2, coolingPerS: 0.42, poiShiftPer100C_mrad: 0.7, poiDriftPer100C_mrad: 0.25,cookOffThresholdC: 450, mirageCoeff: 0.7, barrelMassKg: 1.4 },
  mk14: { heatPerShotC: 3.0, coolingPerS: 0.40, poiShiftPer100C_mrad: 0.7, poiDriftPer100C_mrad: 0.25,cookOffThresholdC: 450, mirageCoeff: 0.7, barrelMassKg: 1.3 },
  // LMG / GPMG — quick-change barrels, run very hot
  m249: { heatPerShotC: 2.6, coolingPerS: 0.35, poiShiftPer100C_mrad: 1.0, poiDriftPer100C_mrad: 0.3, cookOffThresholdC: 440, mirageCoeff: 0.8, barrelMassKg: 1.7 },
  mk48: { heatPerShotC: 3.4, coolingPerS: 0.32, poiShiftPer100C_mrad: 1.0, poiDriftPer100C_mrad: 0.3, cookOffThresholdC: 460, mirageCoeff: 0.85,barrelMassKg: 1.8 },
  rpk:  { heatPerShotC: 2.5, coolingPerS: 0.38, poiShiftPer100C_mrad: 0.9, poiDriftPer100C_mrad: 0.3, cookOffThresholdC: 440, mirageCoeff: 0.75,barrelMassKg: 1.5 },
  // Sniper — heavy profile, slow to heat, very stable
  awp:  { heatPerShotC: 1.8, coolingPerS: 0.50, poiShiftPer100C_mrad: 0.4, poiDriftPer100C_mrad: 0.1, cookOffThresholdC: 470, mirageCoeff: 0.5, barrelMassKg: 2.2 },
  l115a3:{heatPerShotC: 1.6, coolingPerS: 0.52, poiShiftPer100C_mrad: 0.35,poiDriftPer100C_mrad: 0.1, cookOffThresholdC: 470, mirageCoeff: 0.45,barrelMassKg: 2.6 },
  // Pistols — small barrels, heat fast but low cook-off risk (low cadence)
  usp:  { heatPerShotC: 4.0, coolingPerS: 0.80, poiShiftPer100C_mrad: 1.5, poiDriftPer100C_mrad: 0.5, cookOffThresholdC: 500, mirageCoeff: 0.3, barrelMassKg: 0.2 },
  deagle:{heatPerShotC: 6.0, coolingPerS: 0.70, poiShiftPer100C_mrad: 1.8, poiDriftPer100C_mrad: 0.6, cookOffThresholdC: 500, mirageCoeff: 0.35,barrelMassKg: 0.3 },
  // Shotguns — low pressure, low heat
  nova: { heatPerShotC: 1.5, coolingPerS: 0.60, poiShiftPer100C_mrad: 0.6, poiDriftPer100C_mrad: 0.2, cookOffThresholdC: 480, mirageCoeff: 0.3, barrelMassKg: 0.7 },
};

const DEFAULT_PROFILE: BarrelThermalProfile = {
  heatPerShotC: 2.5, coolingPerS: 0.45, poiShiftPer100C_mrad: 0.8, poiDriftPer100C_mrad: 0.25,
  cookOffThresholdC: 440, mirageCoeff: 0.6, barrelMassKg: 1.0,
};

export function getBarrelThermalProfile(weapon: WeaponType): BarrelThermalProfile {
  return BARREL_THERMAL_PROFILES[weapon] ?? DEFAULT_PROFILE;
}

export function createBarrelThermalState(weapon: WeaponType, ambientTempC = 20): BarrelThermalState {
  return { weapon, tempC: ambientTempC, ambientC: ambientTempC, shotsSinceCold: 0 };
}

/** Apply one shot's heat. */
export function applyShotHeat(state: BarrelThermalState): BarrelThermalState {
  const p = getBarrelThermalProfile(state.weapon);
  return { ...state, tempC: state.tempC + p.heatPerShotC, shotsSinceCold: state.shotsSinceCold + 1 };
}

/** Cool the barrel passively over dtS seconds (Newton's-law approximation). */
export function updateBarrelCooling(state: BarrelThermalState, dtS: number): BarrelThermalState {
  const p = getBarrelThermalProfile(state.weapon);
  const delta = state.tempC - state.ambientC;
  if (delta <= 0) return { ...state, shotsSinceCold: 0 };
  // Cooling proportional to temperature delta (first-order decay).
  const cooled = delta * Math.exp(-p.coolingPerS * dtS / Math.max(0.5, p.barrelMassKg));
  const newTemp = state.ambientC + cooled;
  return {
    ...state,
    tempC: newTemp,
    shotsSinceCold: newTemp <= state.ambientC + 1 ? 0 : state.shotsSinceCold,
  };
}

/** Normalized heat 0..1 (0 = ambient, 1 = cook-off). */
export function barrelHeat0to1(state: BarrelThermalState): number {
  const p = getBarrelThermalProfile(state.weapon);
  return Math.max(0, Math.min(1, (state.tempC - state.ambientC) / (p.cookOffThresholdC - state.ambientC)));
}

/** Mirage distortion intensity 0..1 in front of the scope. */
export function mirageIntensity(state: BarrelThermalState): number {
  const p = getBarrelThermalProfile(state.weapon);
  const overAmbient = Math.max(0, state.tempC - state.ambientC);
  return Math.min(1, (overAmbient / 100) * p.mirageCoeff);
}

/** Mirage screen-space distortion magnitude (pixels at 1080p). */
export function mirageDistortion(state: BarrelThermalState): number {
  return mirageIntensity(state) * 8;
}

/** Accuracy multiplier 1..0 (hot barrels are less accurate). */
export function heatAccuracyMult(state: BarrelThermalState): number {
  const h = barrelHeat0to1(state);
  // Up to 30% accuracy loss at cook-off threshold.
  return 1 - h * 0.30;
}

/** Point-of-impact shift (milliradians) — vertical + horizontal. */
export function heatPoiShiftRad(state: BarrelThermalState): { vertMrad: number; horizMrad: number } {
  const p = getBarrelThermalProfile(state.weapon);
  const overAmbientC = Math.max(0, state.tempC - state.ambientC);
  return {
    vertMrad: (overAmbientC / 100) * p.poiShiftPer100C_mrad,
    horizMrad: (overAmbientC / 100) * p.poiDriftPer100C_mrad,
  };
}

/** True if the barrel is hot enough to cook off a chambered round. */
export function isCookOffTemp(state: BarrelThermalState): boolean {
  return state.tempC >= getBarrelThermalProfile(state.weapon).cookOffThresholdC;
}

/** Barrel wear multiplier (hot barrels erode faster — feeds weapon-wear.ts). */
export function heatWearMult(state: BarrelThermalState): number {
  const h = barrelHeat0to1(state);
  return 1 + h * 1.5;
}

// ─── Quick-change barrel (LMG doctrine) ─────────────────────────────────────

export const QUICK_CHANGE_BARREL_WEAPONS: ReadonlySet<WeaponType> = new Set<WeaponType>([
  "m249", "mk48", "rpk",
]);

export const BARREL_SWAP_TIME_SEC = 5.0;

export function hasQuickChangeBarrel(weapon: WeaponType): boolean {
  return QUICK_CHANGE_BARREL_WEAPONS.has(weapon);
}

/** Swap to a fresh cold barrel (resets temperature to ambient). */
export function swapBarrel(state: BarrelThermalState): BarrelThermalState {
  return { ...state, tempC: state.ambientC, shotsSinceCold: 0 };
}

// ─── Per-frame tick + summary ───────────────────────────────────────────────

export interface BarrelThermalTickResult {
  state: BarrelThermalState;
  cookOffRisk: boolean;
  accuracyMult: number;
  mirage: number;
}

/** One-shot per-frame update — call with the weapon's dt since last frame. */
export function tickBarrelThermal(state: BarrelThermalState, dtS: number): BarrelThermalTickResult {
  const cooled = updateBarrelCooling(state, dtS);
  return {
    state: cooled,
    cookOffRisk: isCookOffTemp(cooled),
    accuracyMult: heatAccuracyMult(cooled),
    mirage: mirageIntensity(cooled),
  };
}

export function summarizeBarrelThermal(state: BarrelThermalState): string {
  const p = getBarrelThermalProfile(state.weapon);
  return `${state.weapon}: ${state.tempC.toFixed(0)}°C / ${p.cookOffThresholdC}°C cook-off, ${barrelHeat0to1(state).toFixed(2)} heat, ${heatAccuracyMult(state).toFixed(2)} acc`;
}

export function getWeaponCategory(weapon: WeaponType): string {
  // Lightweight helper used by some HUD readouts; returns the profile's category hint.
  return BARREL_THERMAL_PROFILES[weapon] ? "profiled" : "default";
}
