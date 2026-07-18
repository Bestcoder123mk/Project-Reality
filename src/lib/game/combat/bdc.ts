/**
 * Section C — Bullet Drop Compensation (BDC) for optics.
 *
 * Modern combat optics include a BDC reticle — a series of stadia lines
 * or dots below the main crosshair, each calibrated for a specific
 * distance. The shooter aims with the appropriate stadia for the target's
 * range, and the bullet's drop is automatically compensated.
 *
 *   - ACOG TA31RCO: 4× scope with a 200m zero + BDC stadia for 400, 600,
 *     800m. Used by USMC.
 *   - ELCAN SpecterDR: 1×/4× dual-mode scope with BDC for 200-800m.
 *   - Schmidt & Bender 5-25×56 PM II: sniper scope with custom BDC
 *     calibrated for the specific caliber (e.g. .338 Lapua 250gr).
 *   - Holosun HS510C: red dot with a 50/100/200m BDC circle reticle.
 *
 * This module computes:
 *   - The per-distance BDC stadia positions for each optic + caliber combo.
 *   - The "BDC turret" — a manual elevation adjustment (1/10 MIL clicks)
 *     that the player can dial in for a specific range.
 *   - The "auto-BDC" mode — a modern optic feature that reads the laser
 *     rangefinder + auto-dials the elevation.
 *   - The HUD overlay that renders the BDC reticle + the current range
 *     estimate (from the rangefinder or the player's estimate).
 *
 * Tone reference: tactical-mil-sim-leaning-arcade. The BDC reticle is
 * simplified — a real ACOG has 11+ stadia; we use 5-7 for clarity. The
 * auto-BDC is faster than real (real laser rangefinders take 0.5-1s to
 * lock; ours is instant) so the player can use it tactically without
 * waiting.
 */

import type { WeaponType } from "../store";
import { getWeaponCaliber } from "./caliber-tables";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type OpticSlug =
  | "red_dot"
  | "holo"
  | "acog"
  | "scope8x"
  | "scope12x"
  | "thermal_scope";

export interface BdcStadia {
  /** Range this stadia is calibrated for (m). */
  rangeM: number;
  /** Vertical offset of the stadia below the main crosshair (mrad). */
  verticalOffsetMrad: number;
  /** Stadia label (e.g. "200", "4", "6"). */
  label: string;
  /** True if this stadia is the zero (main crosshair). */
  isZero: boolean;
}

export interface BdcReticle {
  /** Optic slug. */
  optic: OpticSlug;
  /** Caliber slug this BDC is calibrated for. */
  caliberSlug: string;
  /** Zero range (m). The main crosshair is calibrated for this range. */
  zeroRangeM: number;
  /** All stadia (including the zero). Sorted by range ascending. */
  stadia: BdcStadia[];
}

export interface BdcTurretState {
  /** Current elevation adjustment (mrad). 0 = zero. Positive = up. */
  elevationMrad: number;
  /** Current windage adjustment (mrad). 0 = zero. Positive = right. */
  windageMrad: number;
  /** True if the turret is in "auto-BDC" mode (rangefinder-driven). */
  autoMode: boolean;
  /** The range the rangefinder is locked onto (m). Null if not locked. */
  rangefinderRangeM: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BDC reticle tables.
//
// Each optic has a different BDC layout. The ACOG has the most detailed
// (4× magnification makes the stadia useful at long range); red dots have
// none (point-and-shoot at CQB ranges).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the BDC reticle for a given optic + weapon. The reticle's stadia
 * are computed from the caliber's per-distance drop table (the drop at
 * each range minus the drop at the zero range gives the stadia offset).
 *
 * For optics without BDC (red_dot, holo), returns an empty reticle.
 */
export function computeBdcReticle(optic: OpticSlug, weapon: WeaponType): BdcReticle {
  const caliber = getWeaponCaliber(weapon);
  const zeroRange = caliber.recommendedZeroM;

  // No BDC for CQB optics.
  if (optic === "red_dot" || optic === "holo") {
    return {
      optic, caliberSlug: caliber.slug, zeroRangeM: zeroRange,
      stadia: [{
        rangeM: zeroRange, verticalOffsetMrad: 0, label: "0", isZero: true,
      }],
    };
  }

  // For magnified optics, compute stadia from the drop table.
  // Stadia ranges: 0 (zero), 100m past zero, 200m past zero, etc.
  const stadiaRanges: number[] = [];
  // Always include the zero range.
  stadiaRanges.push(zeroRange);
  // Add stadia at 100m intervals past the zero range, up to the caliber's
  // max effective range.
  for (let r = zeroRange + 100; r <= caliber.maxEffectiveRangeM; r += 100) {
    stadiaRanges.push(r);
  }
  // For sniper scopes, add a 50m stadia between the zero and the first
  // 100m stadia (for fine adjustment).
  if (optic === "scope8x" || optic === "scope12x" || optic === "thermal_scope") {
    if (zeroRange + 50 < (zeroRange + 100)) {
      stadiaRanges.splice(1, 0, zeroRange + 50);
    }
  }

  // Find the zero-drop reference.
  const zeroDropCm = interpolateDropCm(caliber.slug, zeroRange);

  // Compute stadia offsets.
  const stadia: BdcStadia[] = stadiaRanges.map((range) => {
    if (range === zeroRange) {
      return {
        rangeM: range,
        verticalOffsetMrad: 0,
        label: range.toFixed(0),
        isZero: true,
      };
    }
    const dropCm = interpolateDropCm(caliber.slug, range);
    // Stadia offset = additional drop past the zero = drop - zeroDrop.
    // (dropCm is negative = below bore line, so additional drop = dropCm - zeroDropCm.)
    // Convert to mrad: mrad = (drop in cm / 100) / (range in m / 1000) = drop × 10 / range
    const additionalDropCm = dropCm - zeroDropCm; // negative
    const offsetMrad = (additionalDropCm / 100) / (range / 1000) * 1000; // = additionalDropCm × 10 / range
    return {
      rangeM: range,
      verticalOffsetMrad: -offsetMrad, // positive = below crosshair (stadia is below for longer ranges)
      label: range >= 1000 ? (range / 1000).toFixed(1) : range.toFixed(0),
      isZero: false,
    };
  });

  return {
    optic, caliberSlug: caliber.slug, zeroRangeM: zeroRange, stadia,
  };
}

/**
 * Linearly interpolate the drop (cm) at an arbitrary range for a caliber.
 * Reads from the caliber table.
 */
function interpolateDropCm(caliberSlug: string, rangeM: number): number {
  const caliber = getWeaponCaliberForSlug(caliberSlug);
  if (rangeM <= caliber.table[0].rangeM) return caliber.table[0].dropCm;
  if (rangeM >= caliber.table[caliber.table.length - 1].rangeM) {
    return caliber.table[caliber.table.length - 1].dropCm;
  }
  for (let i = 1; i < caliber.table.length; i++) {
    if (rangeM <= caliber.table[i].rangeM) {
      const a = caliber.table[i - 1];
      const b = caliber.table[i];
      const t = (rangeM - a.rangeM) / (b.rangeM - a.rangeM);
      return a.dropCm + (b.dropCm - a.dropCm) * t;
    }
  }
  return caliber.table[caliber.table.length - 1].dropCm;
}

// Avoid circular import: import the function we need directly.
import { getCaliber as getWeaponCaliberForSlug } from "./caliber-tables";

// ─────────────────────────────────────────────────────────────────────────────
// BDC turret state + clicks.
// ─────────────────────────────────────────────────────────────────────────────

/** Create a fresh BDC turret state (zeroed + manual mode). */
export function createBdcTurretState(): BdcTurretState {
  return {
    elevationMrad: 0,
    windageMrad: 0,
    autoMode: false,
    rangefinderRangeM: null,
  };
}

/** Click value for the elevation/windage turret (mrad per click).
 *  Standard for tactical scopes: 0.1 MIL per click (1/10 MIL). */
export const TURRET_CLICK_VALUE_MRAD = 0.1;

/** Adjust the elevation by N clicks. Positive = up, negative = down. */
export function adjustElevation(state: BdcTurretState, clicks: number): BdcTurretState {
  return {
    ...state,
    elevationMrad: state.elevationMrad + clicks * TURRET_CLICK_VALUE_MRAD,
  };
}

/** Adjust the windage by N clicks. Positive = right, negative = left. */
export function adjustWindage(state: BdcTurretState, clicks: number): BdcTurretState {
  return {
    ...state,
    windageMrad: state.windageMrad + clicks * TURRET_CLICK_VALUE_MRAD,
  };
}

/** Reset the turret to zero. */
export function resetTurret(state: BdcTurretState): BdcTurretState {
  return {
    ...state,
    elevationMrad: 0,
    windageMrad: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-BDC mode (rangefinder-driven elevation).
//
// When the player activates the laser rangefinder + has auto-BDC enabled,
// the scope automatically dials the elevation to compensate for the
// target's range. The rangefinder returns the distance; the scope looks
// up the required elevation from the BDC table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Engage auto-BDC for a given target range. Returns the updated turret
 * state with the elevation set to compensate for the range.
 *
 * The elevation is computed from the caliber's drop table at the target
 * range minus the zero range. The result is in mrad.
 */
export function engageAutoBdc(
  state: BdcTurretState,
  weapon: WeaponType,
  targetRangeM: number,
): BdcTurretState {
  const caliber = getWeaponCaliber(weapon);
  const zeroDropCm = interpolateDropCm(caliber.slug, caliber.recommendedZeroM);
  const targetDropCm = interpolateDropCm(caliber.slug, targetRangeM);
  // Required elevation = (zeroDropCm - targetDropCm) converted to mrad.
  // (zeroDrop - targetDrop is positive when target is farther — we need
  // to aim UP, which is positive elevation.)
  const dropDiffCm = zeroDropCm - targetDropCm; // positive = more drop at target = need to aim up
  const elevationMrad = (dropDiffCm / 100) / (targetRangeM / 1000) * 1000; // = dropDiffCm × 10 / range
  return {
    ...state,
    elevationMrad,
    autoMode: true,
    rangefinderRangeM: targetRangeM,
  };
}

/** Disengage auto-BDC (return to manual mode). Keeps the current elevation. */
export function disengageAutoBdc(state: BdcTurretState): BdcTurretState {
  return { ...state, autoMode: false, rangefinderRangeM: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD rendering helpers — BDC reticle overlay.
//
// The HUD's scope overlay renders the BDC reticle. Each stadia is drawn
// at its vertical offset (in mrad) below the main crosshair. The HUD
// reads the stadia list + the player's current range estimate to
// highlight the appropriate stadia.
// ─────────────────────────────────────────────────────────────────────────────

export interface BdcHudStadia {
  /** Range label (e.g. "200", "4" for 400m). */
  label: string;
  /** Vertical pixel offset below the crosshair (positive = down). */
  pixelOffset: number;
  /** True if this stadia should be highlighted (matches current range). */
  highlight: boolean;
  /** True if this is the main crosshair (zero). */
  isZero: boolean;
}

/**
 * Compute the HUD stadia list for a BDC reticle. The stadia are positioned
 * by their mrad offset, scaled by the optic's magnification + the scope
 * FOV. The HUD uses `pixelsPerMrad` (provided by the renderer) to convert.
 *
 * @param reticle          The BDC reticle.
 * @param pixelsPerMrad    Pixels per mrad at the current zoom level.
 * @param currentRangeM    The player's current range estimate (for highlighting).
 * @returns                The HUD stadia list, sorted by vertical offset.
 */
export function computeBdcHudStadia(
  reticle: BdcReticle,
  pixelsPerMrad: number,
  currentRangeM: number | null,
): BdcHudStadia[] {
  return reticle.stadia.map((s) => ({
    label: s.label,
    pixelOffset: s.verticalOffsetMrad * pixelsPerMrad,
    highlight: currentRangeM !== null && Math.abs(currentRangeM - s.rangeM) < 25,
    isZero: s.isZero,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Range estimation helpers.
//
// Without a laser rangefinder, the player must estimate range using the
// mil-relation formula (target height in mils × 1000 / actual height =
// range). This module exposes a helper that computes the range from the
// target's apparent size in the scope.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate the range to a target using the mil-relation formula.
 *
 *   range (m) = target height (m) × 1000 / apparent height (mils)
 *
 * Example: a 1.8m-tall human appearing 4 mils tall in the scope is at
 * 1.8 × 1000 / 4 = 450m.
 *
 * @param targetHeightM    Actual target height (m). Standard human = 1.8m.
 * @param apparentHeightMil  Target height in mils (as read from the scope reticle).
 * @returns                Estimated range (m).
 */
export function estimateRangeByMil(
  targetHeightM: number,
  apparentHeightMil: number,
): number {
  if (apparentHeightMil <= 0) return Infinity;
  return (targetHeightM * 1000) / apparentHeightMil;
}

/**
 * Standard target heights for mil-ranging. The player picks the closest
 * match for the target type.
 */
export const TARGET_HEIGHTS_M: Record<string, number> = {
  human_standing:    1.80,
  human_crouching:   1.10,
  human_prone:       0.50,
  vehicle_car:       1.50,
  vehicle_apc:       2.50,
  vehicle_tank:      3.00,
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-optic default magnification + zero range.
// ─────────────────────────────────────────────────────────────────────────────

export const OPTIC_MAGNIFICATION: Record<OpticSlug, number> = {
  red_dot: 1,
  holo: 1,
  acog: 4,
  scope8x: 8,
  scope12x: 12,
  thermal_scope: 4,
};

/** Get the magnification for an optic. */
export function getOpticMagnification(optic: OpticSlug): number {
  return OPTIC_MAGNIFICATION[optic] ?? 1;
}

/**
 * Compute the FOV (degrees) for an optic at the given magnification.
 * Standard scope FOV at 1× = 75°; FOV = 75 / magnification.
 */
export function computeOpticFovDeg(optic: OpticSlug): number {
  return 75 / getOpticMagnification(optic);
}

// ─────────────────────────────────────────────────────────────────────────────
// Zeroing — set the zero range for the optic.
//
// The player can re-zero the optic to a different range (e.g. zero at 100m
// for CQB, 300m for general purpose, 500m for long-range). The reticle's
// main crosshair is then calibrated for the new zero.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-zero the BDC reticle to a different range. Returns a new reticle with
 * the zero at the specified range + stadia recomputed.
 */
export function rezeroBdcReticle(
  optic: OpticSlug,
  weapon: WeaponType,
  newZeroRangeM: number,
): BdcReticle {
  // Compute the standard reticle, then shift all stadia offsets so the
  // new zero range is at offset 0.
  const standard = computeBdcReticle(optic, weapon);
  const newZeroDropCm = interpolateDropCm(standard.caliberSlug, newZeroRangeM);
  const newStadia = standard.stadia.map((s) => {
    const dropCm = interpolateDropCm(standard.caliberSlug, s.rangeM);
    const dropDiffCm = dropCm - newZeroDropCm;
    const offsetMrad = (dropDiffCm / 100) / (s.rangeM / 1000) * 1000;
    return {
      ...s,
      verticalOffsetMrad: -offsetMrad,
      isZero: s.rangeM === newZeroRangeM,
      label: s.rangeM === newZeroRangeM ? "0" : s.label,
    };
  });
  return {
    ...standard,
    zeroRangeM: newZeroRangeM,
    stadia: newStadia,
  };
}
