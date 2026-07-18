/**
 * Section D — Sight Alignment & Sight Picture.
 *
 * Real-world marksmanship has four fundamentals:
 *   1. Steady Position — body + weapon support (covered by `weapon-sway.ts`).
 *   2. Sight Alignment — front sight centered in rear sight aperture
 *      (iron sights) or eye centered on scope exit pupil (optics).
 *   3. Sight Picture — placing the aligned sights on the target.
 *   4. Trigger Control — covered by `trigger-discipline.ts`.
 *
 * This module computes the *accuracy* impact of imperfect sight alignment
 * + sight picture. Even with perfect trigger control, an off-axis sight
 * picture produces a parallax-like POI shift that compounds with range.
 *
 * The existing `adsSightAlignment()` in `sectionB.ts` returns the ADS
 * pose offset (viewmodel transform). This module computes the *accuracy*
 * effect — how much an imperfect sight alignment degrades the shot.
 *
 * Engine integration: the WeaponSystem reads `sightAlignmentAccuracyMult()`
 * to multiply the weapon's base spread; the HudSystem reads
 * `sightAlignmentHint()` to display the current alignment quality.
 */

import type { WeaponType, WeaponCategory } from "../store";
import type { OpticVariant } from "./sectionB";
import { OPTIC_PARALLAX_PROFILES, type OpticClass } from "./optic-parallax";

// ─────────────────────────────────────────────────────────────────────────────
// Sight alignment state.
// ─────────────────────────────────────────────────────────────────────────────

export interface SightAlignmentState {
  /** Vertical alignment error (radians). 0 = perfect. */
  verticalErrorRad: number;
  /** Horizontal alignment error (radians). 0 = perfect. */
  horizontalErrorRad: number;
  /** Sight picture offset — how far from the target center the player is aiming (radians). */
  pictureOffsetRad: number;
  /** Time the player has held the alignment (sec) — alignment improves over time. */
  timeHeldSec: number;
  /** Whether the player is aiming (not hip-firing). */
  isAiming: boolean;
}

export function initSightAlignment(): SightAlignmentState {
  return {
    verticalErrorRad: 0.05, horizontalErrorRad: 0.05,
    pictureOffsetRad: 0.1, timeHeldSec: 0, isAiming: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-optic alignment difficulty.
// ─────────────────────────────────────────────────────────────────────────────

export interface AlignmentDifficultySpec {
  /** Time to achieve perfect alignment (sec). Smaller = faster. */
  acquireTimeSec: number;
  /** Maximum alignment error when freshly ADS'd (rad). */
  maxErrorRad: number;
  /** How forgiving the optic is (0..1, 1 = most forgiving). */
  forgiveness: number;
}

export const ALIGNMENT_DIFFICULTY: Record<OpticClass, AlignmentDifficultySpec> = {
  red_dot: { acquireTimeSec: 0.15, maxErrorRad: 0.02, forgiveness: 0.95 },
  holo:    { acquireTimeSec: 0.18, maxErrorRad: 0.025, forgiveness: 0.9 },
  lpvo:    { acquireTimeSec: 0.30, maxErrorRad: 0.04, forgiveness: 0.7 },
  acog:    { acquireTimeSec: 0.40, maxErrorRad: 0.05, forgiveness: 0.6 },
  scope4x: { acquireTimeSec: 0.55, maxErrorRad: 0.07, forgiveness: 0.45 },
  scope8x: { acquireTimeSec: 0.85, maxErrorRad: 0.10, forgiveness: 0.30 },
  scope12x: { acquireTimeSec: 1.20, maxErrorRad: 0.15, forgiveness: 0.20 },
  iron:    { acquireTimeSec: 0.35, maxErrorRad: 0.06, forgiveness: 0.55 },
  none:    { acquireTimeSec: 0, maxErrorRad: 0, forgiveness: 1.0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Alignment accuracy computation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the accuracy multiplier from sight alignment.
 *   1.0 = perfect alignment (no spread penalty).
 *   0.5 = 50% accuracy (heavy spread increase).
 *
 * The accuracy depends on:
 *   • Alignment error magnitude (worse = lower accuracy).
 *   • Time held (improves over the acquire time).
 *   • Optic forgiveness.
 */
export function sightAlignmentAccuracyMult(
  state: SightAlignmentState,
  optic: OpticVariant | "none",
): number {
  if (!state.isAiming) return 0.5; // hip-fire = 50% accuracy baseline.

  const profile = OPTIC_PARALLAX_PROFILES[optic];
  const difficulty = profile ? ALIGNMENT_DIFFICULTY[profile.cls] : ALIGNMENT_DIFFICULTY.none;
  if (!profile || profile.cls === "none") {
    return 0.5; // no optic = hip-fire-ish.
  }

  // Error magnitude.
  const errorMag = Math.sqrt(
    state.verticalErrorRad * state.verticalErrorRad +
    state.horizontalErrorRad * state.horizontalErrorRad,
  );

  // Time-acquisition factor: alignment improves over the acquire time.
  const acquireFrac = Math.min(1, state.timeHeldSec / difficulty.acquireTimeSec);
  const timeFactor = 1 - 0.7 * (1 - acquireFrac);

  // Error-vs-forgiveness: high forgiveness = error matters less.
  const errorFrac = Math.min(1, errorMag / difficulty.maxErrorRad);
  const errorFactor = 1 - (1 - difficulty.forgiveness) * errorFrac;

  // Picture offset: even with perfect alignment, an off-target picture misses.
  const pictureFactor = 1 - Math.min(0.5, state.pictureOffsetRad * 5);

  return Math.max(0.1, timeFactor * errorFactor * pictureFactor);
}

// ─────────────────────────────────────────────────────────────────────────────
// Alignment update — driven by player input + sway.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the sight alignment state for this frame.
 * @param dtSec Delta time in seconds.
 * @param swayOffsetRad The current sway offset (from weapon-sway.ts).
 * @param isFiring Whether the player just fired (resets timeHeld).
 */
export function tickSightAlignment(
  state: SightAlignmentState,
  dtSec: number,
  swayOffsetRad: { x: number; y: number },
  isFiring: boolean,
  isAiming: boolean,
): SightAlignmentState {
  if (!isAiming) {
    return { ...state, isAiming: false, timeHeldSec: 0 };
  }

  // Alignment error tracks the sway (the player tries to compensate, but
  // can't fully eliminate the sway). Over time, the player adapts.
  const acquireFactor = Math.min(1, state.timeHeldSec / 0.5);
  const errorMult = 1 - acquireFactor * 0.7; // reduces error over time.
  const verticalErrorRad = swayOffsetRad.y * errorMult;
  const horizontalErrorRad = swayOffsetRad.x * errorMult;

  // Picture offset is the residual aim error after the player compensates.
  const pictureOffsetRad = Math.abs(swayOffsetRad.x) + Math.abs(swayOffsetRad.y);

  return {
    verticalErrorRad,
    horizontalErrorRad,
    pictureOffsetRad,
    timeHeldSec: isFiring ? 0 : state.timeHeldSec + dtSec,
    isAiming: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Alignment hint for the HUD.
// ─────────────────────────────────────────────────────────────────────────────

export type AlignmentQuality = "perfect" | "good" | "fair" | "poor" | "bad";

export function sightAlignmentQuality(
  state: SightAlignmentState,
  optic: OpticVariant | "none",
): AlignmentQuality {
  if (!state.isAiming) return "bad";
  const profile = OPTIC_PARALLAX_PROFILES[optic];
  const difficulty = profile ? ALIGNMENT_DIFFICULTY[profile.cls] : ALIGNMENT_DIFFICULTY.none;
  if (!profile || profile.cls === "none") return "bad";

  const errorMag = Math.sqrt(
    state.verticalErrorRad * state.verticalErrorRad +
    state.horizontalErrorRad * state.horizontalErrorRad,
  );
  const errorFrac = Math.min(1, errorMag / difficulty.maxErrorRad);
  if (errorFrac < 0.1) return "perfect";
  if (errorFrac < 0.3) return "good";
  if (errorFrac < 0.5) return "fair";
  if (errorFrac < 0.8) return "poor";
  return "bad";
}

export function sightAlignmentHint(quality: AlignmentQuality): { label: string; color: string } {
  switch (quality) {
    case "perfect": return { label: "PERFECT", color: "#10b981" };
    case "good":    return { label: "GOOD",    color: "#84cc16" };
    case "fair":    return { label: "FAIR",    color: "#f59e0b" };
    case "poor":    return { label: "POOR",    color: "#f97316" };
    case "bad":     return { label: "BAD",     color: "#ef4444" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-category alignment default (for AI / spec cards).
// ─────────────────────────────────────────────────────────────────────────────

export function defaultAlignmentTimeForCategory(category: WeaponCategory): number {
  switch (category) {
    case "PISTOL":  return 0.20;
    case "SMG":     return 0.25;
    case "RIFLE":   return 0.35;
    case "SHOTGUN": return 0.30;
    case "SNIPER":  return 0.85;
    case "LMG":     return 0.50;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-weapon alignment offset (re-uses the existing per-weapon ADS pose).
// ─────────────────────────────────────────────────────────────────────────────

export function weaponAlignmentOffset(weapon: WeaponType): { x: number; y: number; z: number } {
  // Mirror of the per-weapon ADS pose from adsSightAlignment (sectionB.ts).
  const offsets: Partial<Record<WeaponType, { x: number; y: number; z: number }>> = {
    awp:   { x: 0, y: -0.090, z: -0.22 },
    l115a3: { x: 0, y: -0.095, z: -0.22 },
    scout: { x: 0, y: -0.085, z: -0.21 },
    kar98k: { x: 0, y: -0.080, z: -0.21 },
    usp:   { x: 0, y: -0.065, z: -0.18 },
    deagle: { x: 0, y: -0.065, z: -0.18 },
  };
  return offsets[weapon] ?? { x: 0, y: -0.075, z: -0.20 };
}
