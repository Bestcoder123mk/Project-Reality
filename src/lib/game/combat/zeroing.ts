/**
 * Section D — Advanced Zeroing System.
 *
 * Real-world optics are "zeroed" — the reticle is calibrated to align with
 * the bullet's point of impact at a specific distance. Inside that distance,
 * the bullet is still rising; beyond it, the bullet has dropped.
 *
 * The existing `zeroingPoiOffsetM` in `sectionB.ts` computes a single POI
 * offset. This module adds the full zeroing workflow:
 *
 *   1. Zero-distance presets (100, 200, 300, 400, 500 m + maximum-point-blank).
 *   2. Click-based adjustment (1/4 MOA per click on US scopes, 1/10 mil on
 *      metric scopes).
 *   3. BDC (Bullet Drop Compensator) reticle marks per zero distance.
 *   4. Maximum Point-Blank Range (MPBR) — the zero that keeps the bullet
 *      within ±X cm of line of sight out to the longest range.
 *   5. Zero verification: dry-fire confirmation at a known range.
 *
 * Engine integration: the HudSystem reads `bdcReticleFor()` to render the
 * BDC marks; the WeaponSystem reads `zeroedPoiOffsetM()` to apply the POI
 * shift; the Gunsmith reads `zeroingPresets()` + `mpbrZero()` for the
 * tuning bench.
 */

import type { WeaponType } from "../store";
import { REAL_WORLD_SPECS } from "./weapon-catalog-extended";

// ─────────────────────────────────────────────────────────────────────────────
// Zero distance presets.
// ─────────────────────────────────────────────────────────────────────────────

export type ZeroDistance = 50 | 100 | 150 | 200 | 250 | 300 | 400 | 500;

export interface ZeroPreset {
  distance: ZeroDistance;
  label: string;
  /** Typical use case. */
  useCase: string;
  /** Bullet drop at this distance with a typical 5.56mm load (cm). */
  drop5_56Cm: number;
  /** Bullet drop at this distance with a typical 7.62mm NATO load (cm). */
  drop7_62Cm: number;
  /** Bullet drop at this distance with a .338 Lapua load (cm). */
  drop338Cm: number;
}

export const ZERO_PRESETS: ZeroPreset[] = [
  { distance: 50,  label: "50 m",   useCase: "CQB / urban",         drop5_56Cm: -0.6, drop7_62Cm: -0.8,  drop338Cm: -0.5 },
  { distance: 100, label: "100 m",  useCase: "Standard patrol",     drop5_56Cm: 0,    drop7_62Cm: 0,    drop338Cm: 0 },
  { distance: 150, label: "150 m",  useCase: "Mid-range patrol",    drop5_56Cm: 1.5,  drop7_62Cm: 1.8,  drop338Cm: 0.8 },
  { distance: 200, label: "200 m",  useCase: "General purpose",     drop5_56Cm: 5.4,  drop7_62Cm: 6.5,  drop338Cm: 3.2 },
  { distance: 250, label: "250 m",  useCase: "Mid-range engagement", drop5_56Cm: 11.8, drop7_62Cm: 14.2, drop338Cm: 7.1 },
  { distance: 300, label: "300 m",  useCase: "Extended range",      drop5_56Cm: 21.0, drop7_62Cm: 25.5, drop338Cm: 12.6 },
  { distance: 400, label: "400 m",  useCase: "DMR / sniper",        drop5_56Cm: 47.0, drop7_62Cm: 57.0, drop338Cm: 28.0 },
  { distance: 500, label: "500 m",  useCase: "Long-range sniper",   drop5_56Cm: 87.0, drop7_62Cm: 105.0, drop338Cm: 50.0 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Click adjustments.
// ─────────────────────────────────────────────────────────────────────────────

export type ClickUnit = "moa" | "mil" | "cm";

export interface ClickAdjustmentSpec {
  unit: ClickUnit;
  /** Value per click (1/4 MOA, 1/10 mil, or 1 cm @ 100 m). */
  valuePerClick: number;
  /** Clicks per full rotation of the turret. */
  clicksPerRotation: number;
  /** Total clicks of adjustment range. */
  totalRange: number;
}

export const CLICK_SPECS: Record<ClickUnit, ClickAdjustmentSpec> = {
  moa: { unit: "moa", valuePerClick: 0.25, clicksPerRotation: 48, totalRange: 240 },
  mil: { unit: "mil", valuePerClick: 0.1, clicksPerRotation: 60, totalRange: 200 },
  cm:  { unit: "cm",  valuePerClick: 1.0, clicksPerRotation: 50, totalRange: 200 },
};

export interface ClickAdjustmentState {
  unit: ClickUnit;
  /** Vertical clicks (positive = up). */
  verticalClicks: number;
  /** Horizontal clicks (positive = right). */
  horizontalClicks: number;
}

export function zeroClickAdjustment(unit: ClickUnit): ClickAdjustmentState {
  return { unit, verticalClicks: 0, horizontalClicks: 0 };
}

/** Apply clicks to the zero. */
export function applyClicks(
  state: ClickAdjustmentState,
  verticalClicks: number,
  horizontalClicks: number,
): ClickAdjustmentState {
  const spec = CLICK_SPECS[state.unit];
  const maxClicks = spec.totalRange / 2;
  return {
    ...state,
    verticalClicks: Math.max(-maxClicks, Math.min(maxClicks, state.verticalClicks + verticalClicks)),
    horizontalClicks: Math.max(-maxClicks, Math.min(maxClicks, state.horizontalClicks + horizontalClicks)),
  };
}

/** Compute the POI shift (MOA) from click adjustment. */
export function clicksToPoiMoa(state: ClickAdjustmentState): { vertical: number; horizontal: number } {
  const spec = CLICK_SPECS[state.unit];
  return {
    vertical: state.verticalClicks * spec.valuePerClick,
    horizontal: state.horizontalClicks * spec.valuePerClick,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BDC reticle marks — Bullet Drop Compensator.
// ─────────────────────────────────────────────────────────────────────────────

export interface BDCMark {
  /** Range this mark corresponds to (m). */
  rangeM: number;
  /** Vertical offset from the central crosshair (MOA). Positive = below. */
  offsetMoa: number;
  /** Optional label (e.g. "200", "300", "400"). */
  label?: string;
}

/**
 * Compute BDC marks for a given weapon + zero distance. The BDC reticle
 * has horizontal stadia marks at the drop distances for the zero.
 */
export function bdcReticleFor(weapon: WeaponType, zero: ZeroDistance): BDCMark[] {
  const spec = REAL_WORLD_SPECS[weapon];
  if (!spec) return [];
  const v = spec.muzzleVelocityMs;
  const g = 9.81;
  // Time of flight to each range.
  const ranges = [zero * 2, zero * 3, zero * 4, zero * 5].filter((r) => r <= spec.maxRangeM);
  // Compute drop at the zero (baseline) and at each range.
  const tZero = zero / v;
  const dropZero = 0.5 * g * tZero * tZero;
  return ranges.map((r) => {
    const t = r / v;
    const drop = 0.5 * g * t * t;
    const relativeDrop = drop - dropZero; // cm at range r
    // Convert cm at range r to MOA: 1 MOA = ~3 cm at 100 m, scales linearly.
    const moa = (relativeDrop * 100) / (r * 0.0291);
    return { rangeM: r, offsetMoa: moa, label: `${r}` };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Maximum Point-Blank Range (MPBR) — the zero that keeps the bullet within
// a target zone out to the longest distance.
// ─────────────────────────────────────────────────────────────────────────────

export interface MpbrResult {
  /** Recommended zero distance (m). */
  zero: ZeroDistance;
  /** MPBR — the longest range where the bullet stays within the zone. */
  mpbrM: number;
  /** Maximum height of trajectory above line of sight (cm). */
  maxOrdinateCm: number;
  /** Range at which the bullet is at max ordinate (m). */
  maxOrdinateRangeM: number;
}

/**
 * Compute the MPBR for a given target zone size.
 * @param targetZoneCm — vertical size of the target zone (e.g. 15 cm for a
 *   head, 30 cm for a torso, 50 cm for a body).
 * @param weaponMuzzleVelocityMs — bullet velocity (m/s).
 */
export function mpbrZero(targetZoneCm: number, weaponMuzzleVelocityMs: number): MpbrResult {
  const g = 9.81;
  const v = weaponMuzzleVelocityMs;
  // The bullet trajectory is a parabola. For a target zone of half-height h
  // (in meters), the MPBR is when the parabola reaches -h at the maximum
  // range while +h at the peak.
  const h = targetZoneCm / 200; // half-height in m
  // The optimal zero is at ~3/4 of the MPBR (rule of thumb).
  // Trajectory: y(x) = (x/v)² × g/2 - x × tan(zero_angle)
  // For MPBR: y(mpbr) = -h, and y'(maxOrd) = 0 at maxOrd.
  // Approximation: zero = h / arctan(...), mpbr = 4 × zero.
  const mpbrM = Math.round(2 * v * Math.sqrt(2 * h / g));
  const zero = Math.round(mpbrM * 0.75 / 50) * 50 as ZeroDistance;
  const maxOrdinateRangeM = Math.round(mpbrM / 2);
  const maxOrdinateCm = h * 100;
  return { zero, mpbrM, maxOrdinateCm, maxOrdinateRangeM };
}

// ─────────────────────────────────────────────────────────────────────────────
// Zeroed POI offset — for the WeaponSystem to apply per shot.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the POI offset (in meters, vertical) at a given range, given the
 * zero distance + muzzle velocity.
 *
 * At the zero distance: 0.
 * Closer than zero: positive (bullet still rising — hits high).
 * Farther than zero: negative (bullet has dropped — hits low).
 */
export function zeroedPoiOffsetM(
  zeroDistanceM: number,
  actualRangeM: number,
  muzzleVelocityMs: number,
): number {
  const g = 9.81;
  const tZero = zeroDistanceM / muzzleVelocityMs;
  const tActual = actualRangeM / muzzleVelocityMs;
  const dropZero = 0.5 * g * tZero * tZero;
  const dropActual = 0.5 * g * tActual * tActual;
  // If actual > zero, drop more → impact low (negative).
  return dropZero - dropActual;
}

// ─────────────────────────────────────────────────────────────────────────────
// Zero verification — dry-fire confirmation at a known range.
// ─────────────────────────────────────────────────────────────────────────────

export interface ZeroVerificationResult {
  /** Confirmed hits at the zero distance. */
  hits: number;
  /** Total shots fired in verification. */
  shots: number;
  /** Mean POI offset (cm) at the zero distance. */
  meanOffsetCm: { vertical: number; horizontal: number };
  /** Whether the zero is verified (hits ≥ 4 of 5). */
  verified: boolean;
  /** Recommended click adjustment to fine-tune. */
  recommendedClicks: { vertical: number; horizontal: number };
}

export function verifyZero(
  zeroDistanceM: number,
  shots: { verticalCm: number; horizontalCm: number }[],
): ZeroVerificationResult {
  const hits = shots.filter((s) =>
    Math.abs(s.verticalCm) < 5 && Math.abs(s.horizontalCm) < 5).length;
  const meanV = shots.reduce((s, x) => s + x.verticalCm, 0) / shots.length;
  const meanH = shots.reduce((s, x) => s + x.horizontalCm, 0) / shots.length;
  // 1 click (1/4 MOA) = ~0.73 cm at 100 m.
  const cmPerClick = 0.7275 * (zeroDistanceM / 100);
  return {
    hits,
    shots: shots.length,
    meanOffsetCm: { vertical: meanV, horizontal: meanH },
    verified: hits >= 4,
    recommendedClicks: {
      vertical: -Math.round(meanV / cmPerClick),
      horizontal: -Math.round(meanH / cmPerClick),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: presets list for UI.
// ─────────────────────────────────────────────────────────────────────────────

export function zeroingPresets(): ZeroPreset[] {
  return ZERO_PRESETS;
}

export function zeroPresetFor(distance: ZeroDistance): ZeroPreset | undefined {
  return ZERO_PRESETS.find((p) => p.distance === distance);
}
