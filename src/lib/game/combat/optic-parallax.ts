/**
 * Section D — Optic Parallax.
 *
 * Real-world optics exhibit parallax error when the eye is off-axis from
 * the scope's optical axis: the reticle appears to "swim" relative to the
 * target, and the point of impact shifts. Red dots are parallax-free at
 * close range (collimator design) but degrade past ~50 m. Magnified scopes
 * have a parallax adjustment (side focus or objective ring) — set wrong,
 * they introduce error proportional to eye offset × magnification.
 *
 * This module computes:
 *   1. Parallax error per optic type, given eye offset (rad) + target range.
 *   2. The optimal parallax-free distance for a given optic (factory setting).
 *   3. The reticle "swim" magnitude (radians) for HUD reticle drift rendering.
 *   4. Adjustment guidance ("set parallax to 200 m for current target").
 *
 * Engine integration: the WeaponSystem reads parallaxErrorRad() and adds
 * it to the spread budget; the HudSystem reads reticleSwimRad() and offsets
 * the reticle sprite; the Gunsmith reads factoryZeroDistance() for the
 * spec card.
 */

import type { OpticVariant } from "./sectionB";

export type OpticClass =
  | "red_dot"      // collimator — parallax-free at factory range
  | "holo"         // holographic — parallax-free within window
  | "lpvo"         // 1-4× low-power variable optic — small parallax at 100m+
  | "acog"         // 4× fixed — pre-focused at ~150 m
  | "scope4x"      // 4× dedicated scope — parallax adjustable
  | "scope8x"      // 8× sniper scope — side focus parallax
  | "scope12x"     // 12× high-power scope — parallax-critical
  | "iron"         // iron sights — parallax negligible
  | "none";

export interface OpticParallaxProfile {
  /** Optic class. */
  cls: OpticClass;
  /** Factory parallax-free distance (m). Infinity = no parallax at any range. */
  factoryZeroM: number;
  /** Magnification (×). Red dot = 1×, ACOG = 4×, etc. */
  magnification: number;
  /** Whether the optic has a user-adjustable parallax knob. */
  adjustable: boolean;
  /** Parallax error coefficient (rad per radian of eye offset). */
  errorPerEyeOffset: number;
  /** Maximum eye offset before the reticle exits the scope tube (rad). */
  maxEyeOffsetRad: number;
  /** Eye relief distance (m) — too close or too far = shadow / scope bite. */
  eyeReliefM: number;
  /** Exit pupil diameter (mm) — smaller = harder to align. */
  exitPupilMm: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-optic parallax profiles. Real-world references:
//   • Aimpoint CompM5 (red dot): factory parallax-free, no adjustment.
//   • EOTech EXPS3 (holo): parallax-free within 28 mm window at 100 m.
//   • Trijicon ACOG TA31: factory-focused at 150 m, no adjustment.
//   • Schmidt & Bender PMII 5-25×: side-focus parallax from 10 m to ∞.
// ─────────────────────────────────────────────────────────────────────────────

export const OPTIC_PARALLAX_PROFILES: Record<OpticVariant | "none", OpticParallaxProfile> = {
  none: {
    cls: "none", factoryZeroM: Infinity, magnification: 1, adjustable: false,
    errorPerEyeOffset: 0, maxEyeOffsetRad: 1, eyeReliefM: 0, exitPupilMm: 0,
  },
  red_dot: {
    cls: "red_dot", factoryZeroM: 50, magnification: 1, adjustable: false,
    errorPerEyeOffset: 0.002, maxEyeOffsetRad: 0.05, eyeReliefM: 0.07, exitPupilMm: 8,
  },
  holo: {
    cls: "holo", factoryZeroM: 100, magnification: 1, adjustable: false,
    errorPerEyeOffset: 0.001, maxEyeOffsetRad: 0.08, eyeReliefM: 0.06, exitPupilMm: 10,
  },
  acog: {
    cls: "acog", factoryZeroM: 150, magnification: 4, adjustable: false,
    errorPerEyeOffset: 0.008, maxEyeOffsetRad: 0.03, eyeReliefM: 0.045, exitPupilMm: 8,
  },
  scope4x: {
    cls: "scope4x", factoryZeroM: 100, magnification: 4, adjustable: true,
    errorPerEyeOffset: 0.012, maxEyeOffsetRad: 0.02, eyeReliefM: 0.07, exitPupilMm: 8,
  },
  scope8x: {
    cls: "scope8x", factoryZeroM: 100, magnification: 8, adjustable: true,
    errorPerEyeOffset: 0.025, maxEyeOffsetRad: 0.015, eyeReliefM: 0.08, exitPupilMm: 5,
  },
  scope12x: {
    cls: "scope12x", factoryZeroM: 100, magnification: 12, adjustable: true,
    errorPerEyeOffset: 0.04, maxEyeOffsetRad: 0.012, eyeReliefM: 0.09, exitPupilMm: 4,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Core parallax computation.
// ─────────────────────────────────────────────────────────────────────────────

export interface ParallaxInput {
  /** Optic variant. */
  optic: OpticVariant | "none";
  /** Eye offset from scope optical axis (radians). 0 = perfect alignment. */
  eyeOffsetRad: number;
  /** Target range (m). */
  targetRangeM: number;
  /** User-adjusted parallax setting (m). Infinity = factory default. */
  parallaxSettingM?: number;
}

export interface ParallaxResult {
  /** Parallax-induced POI error (radians). 0 = no error. */
  errorRad: number;
  /** Reticle "swim" — how much the reticle visually drifts (rad). */
  swimRad: number;
  /** True if the eye offset exceeds the scope's exit pupil (reticle cut off). */
  exitPupilClipped: boolean;
  /** Recommended parallax setting for the current target range (m). */
  recommendedSettingM: number;
  /** How far off the current setting is from optimal (m). */
  settingErrorM: number;
}

/**
 * Compute the parallax error for a given optic + eye offset + range.
 *
 * Physics:
 *   parallax_error = (target_range - parallax_zero) × eye_offset / eye_relief
 *
 * At the parallax-zero distance, the error is 0 regardless of eye offset.
 * Away from that distance, the error scales linearly with eye offset.
 * Magnified scopes have an additional magnification multiplier.
 */
export function computeParallaxError(input: ParallaxInput): ParallaxResult {
  const profile = OPTIC_PARALLAX_PROFILES[input.optic];
  if (!profile || input.optic === "none" || profile.cls === "none") {
    return {
      errorRad: 0, swimRad: 0, exitPupilClipped: false,
      recommendedSettingM: 0, settingErrorM: 0,
    };
  }

  // The effective parallax zero — either the user's setting or factory default.
  const zeroDistance = input.parallaxSettingM ?? profile.factoryZeroM;

  // Eye offset clamp — beyond maxEyeOffset the reticle exits the scope tube.
  const clampedOffset = Math.max(-profile.maxEyeOffsetRad,
    Math.min(profile.maxEyeOffsetRad, input.eyeOffsetRad));
  const exitPupilClipped = Math.abs(input.eyeOffsetRad) > profile.maxEyeOffsetRad;

  // Base parallax error: ratio of range difference to eye relief, × offset.
  // For magnified scopes, error scales with magnification.
  const rangeDiff = input.targetRangeM - zeroDistance;
  const eyeReliefScale = profile.eyeReliefM > 0
    ? 1 / profile.eyeReliefM
    : 1;
  const baseError = rangeDiff * clampedOffset * eyeReliefScale * 0.01;

  // Magnification multiplier — a 4× scope shows 4× the apparent movement.
  const magMult = profile.magnification > 1
    ? 1 + (profile.magnification - 1) * 0.3
    : 1;

  const errorRad = Math.abs(baseError) * magMult * profile.errorPerEyeOffset * 100;
  const swimRad = Math.abs(clampedOffset) * magMult * 0.05;

  // Recommended parallax setting = the target range itself (zero error).
  const recommendedSettingM = Math.max(10, Math.round(input.targetRangeM / 10) * 10);
  const settingErrorM = Math.abs(input.targetRangeM - zeroDistance);

  return {
    errorRad,
    swimRad,
    exitPupilClipped,
    recommendedSettingM,
    settingErrorM,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** Factory parallax-zero distance for an optic (m). */
export function factoryZeroDistance(optic: OpticVariant | "none"): number {
  return OPTIC_PARALLAX_PROFILES[optic]?.factoryZeroM ?? Infinity;
}

/** Whether the optic supports parallax adjustment (side focus / AO ring). */
export function hasParallaxAdjustment(optic: OpticVariant | "none"): boolean {
  return OPTIC_PARALLAX_PROFILES[optic]?.adjustable ?? false;
}

/** Recommended parallax knob setting for a target range, formatted as a label. */
export function parallaxSettingLabel(rangeM: number): string {
  if (rangeM >= 500) return "∞";
  return `${rangeM} m`;
}

/**
 * Eye-relief error: if the eye is too close to or too far from the scope,
 * the field of view collapses ("scope shadow"). Returns the FOV reduction
 * multiplier (1 = full FOV, 0 = black).
 */
export function eyeReliefFovMultiplier(
  optic: OpticVariant | "none",
  actualEyeReliefM: number,
): number {
  const profile = OPTIC_PARALLAX_PROFILES[optic];
  if (!profile || profile.eyeReliefM === 0) return 1;
  const diff = Math.abs(actualEyeReliefM - profile.eyeReliefM);
  // ±10 mm tolerance, then linear falloff to ±30 mm.
  if (diff <= 0.01) return 1;
  if (diff >= 0.03) return 0;
  return 1 - (diff - 0.01) / 0.02;
}

/**
 * Scope shadow — a polygonal crescent that occludes part of the FOV when
 * the eye is off-axis. Returns the shadow coverage fraction (0..1).
 */
export function scopeShadowFraction(
  optic: OpticVariant | "none",
  eyeOffsetRad: number,
): number {
  const profile = OPTIC_PARALLAX_PROFILES[optic];
  if (!profile || profile.maxEyeOffsetRad === 0) return 0;
  const ratio = Math.abs(eyeOffsetRad) / profile.maxEyeOffsetRad;
  if (ratio <= 0.5) return 0;
  if (ratio >= 1) return 0.5;
  return (ratio - 0.5) * 1.0;
}
