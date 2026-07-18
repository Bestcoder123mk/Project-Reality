/**
 * Section D — Trigger Discipline & Trigger Reset.
 *
 * Real-world precision shooting requires "trigger discipline":
 *   1. Slow, steady press — no jerking.
 *   2. Surprise break — the shot should fire as a surprise, not anticipating.
 *   3. Trigger reset — for follow-up shots, only release the trigger enough
 *      to hear/feel the "click" of the reset, then press again. Full release
 *      + full press takes longer and introduces more motion.
 *
 * The existing `shouldFireSingleShot(holdTimeMs)` in `sectionB.ts` handles
 * the auto/semi distinction (light tap = single shot). This module adds:
 *
 *   1. Trigger travel state (rest, takeup, wall, break, overtravel, reset).
 *   2. Trigger reset mechanic — only release to reset point, not full release.
 *   3. Trigger quality impact on accuracy (jerk = spread, smooth = precision).
 *   4. Per-weapon trigger specs (single-stage, two-stage, double-action).
 *
 * Engine integration: the InputSystem reads `updateTriggerState()` per frame
 * + `triggerFireEvent()` when the trigger is pressed; the WeaponSystem
 * reads `triggerAccuracyPenalty()` to add spread for jerky trigger pulls.
 */

import type { WeaponType } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Trigger types.
// ─────────────────────────────────────────────────────────────────────────────

export type TriggerType =
  | "single_stage"   // AR-pattern — single wall, single break.
  | "two_stage"      // military precision — takeup stage, then wall, then break.
  | "double_action"  // pistols — long heavy pull both cocks + releases hammer.
  | "single_action"  // 1911-style — short light pull, hammer pre-cocked.
  | "set_trigger"    // target rifles — light set pull for precision.
  | "binary";        // fires on press + release (not in game; rare).

export interface TriggerSpec {
  type: TriggerType;
  /** Total trigger travel (mm) from rest to break. */
  travelMm: number;
  /** Takeup distance (mm) — the slack before the wall. */
  takeupMm: number;
  /** Reset distance (mm) — distance from break to reset point. */
  resetMm: number;
  /** Pull weight at break (N). */
  pullWeightN: number;
  /** Pull weight during takeup (N). */
  takeupWeightN: number;
  /** Reset "click" audible (true = player can feel/hear reset). */
  resetClickAudible: boolean;
  /** Travel time for a smooth press (sec). */
  smoothPressTimeSec: number;
  /** Travel time for a jerk (sec) — much faster. */
  jerkPressTimeSec: number;
}

// Per-weapon trigger specs (real-world).
const TRIGGER_SPECS: Partial<Record<WeaponType, TriggerSpec>> = {
  // AR-pattern — single-stage mil-spec 5.5 lb pull.
  m4:   { type: "single_stage", travelMm: 5, takeupMm: 1, resetMm: 1.5, pullWeightN: 22, takeupWeightN: 5, resetClickAudible: true, smoothPressTimeSec: 0.25, jerkPressTimeSec: 0.08 },
  hk416: { type: "single_stage", travelMm: 5, takeupMm: 1, resetMm: 1.5, pullWeightN: 22, takeupWeightN: 5, resetClickAudible: true, smoothPressTimeSec: 0.25, jerkPressTimeSec: 0.08 },
  famas: { type: "single_stage", travelMm: 4, takeupMm: 1, resetMm: 1.2, pullWeightN: 25, takeupWeightN: 6, resetClickAudible: true, smoothPressTimeSec: 0.22, jerkPressTimeSec: 0.07 },
  aug:   { type: "single_stage", travelMm: 6, takeupMm: 2, resetMm: 2.0, pullWeightN: 28, takeupWeightN: 8, resetClickAudible: true, smoothPressTimeSec: 0.28, jerkPressTimeSec: 0.10 },
  scarh: { type: "two_stage", travelMm: 7, takeupMm: 3, resetMm: 1.8, pullWeightN: 24, takeupWeightN: 10, resetClickAudible: true, smoothPressTimeSec: 0.30, jerkPressTimeSec: 0.10 },
  mk14:  { type: "two_stage", travelMm: 6, takeupMm: 2.5, resetMm: 1.5, pullWeightN: 18, takeupWeightN: 8, resetClickAudible: true, smoothPressTimeSec: 0.28, jerkPressTimeSec: 0.09 },

  // AK-pattern — single-stage, typically heavier / grittier.
  ak74: { type: "single_stage", travelMm: 6, takeupMm: 2, resetMm: 2.0, pullWeightN: 26, takeupWeightN: 8, resetClickAudible: false, smoothPressTimeSec: 0.30, jerkPressTimeSec: 0.10 },
  galil: { type: "single_stage", travelMm: 6, takeupMm: 2, resetMm: 2.0, pullWeightN: 26, takeupWeightN: 8, resetClickAudible: false, smoothPressTimeSec: 0.30, jerkPressTimeSec: 0.10 },

  // SMGs.
  mp7:  { type: "single_stage", travelMm: 4, takeupMm: 1, resetMm: 1.0, pullWeightN: 18, takeupWeightN: 5, resetClickAudible: true, smoothPressTimeSec: 0.20, jerkPressTimeSec: 0.06 },
  p90:  { type: "single_stage", travelMm: 5, takeupMm: 1.5, resetMm: 1.5, pullWeightN: 22, takeupWeightN: 6, resetClickAudible: true, smoothPressTimeSec: 0.22, jerkPressTimeSec: 0.07 },
  mp5:  { type: "single_stage", travelMm: 5, takeupMm: 1.5, resetMm: 1.5, pullWeightN: 20, takeupWeightN: 6, resetClickAudible: true, smoothPressTimeSec: 0.22, jerkPressTimeSec: 0.07 },

  // Pistols.
  usp:    { type: "single_action", travelMm: 4, takeupMm: 0.5, resetMm: 1.0, pullWeightN: 18, takeupWeightN: 4, resetClickAudible: true, smoothPressTimeSec: 0.18, jerkPressTimeSec: 0.05 },
  deagle: { type: "single_action", travelMm: 5, takeupMm: 1, resetMm: 1.5, pullWeightN: 25, takeupWeightN: 5, resetClickAudible: true, smoothPressTimeSec: 0.22, jerkPressTimeSec: 0.07 },
  glock18: { type: "double_action", travelMm: 8, takeupMm: 4, resetMm: 1.5, pullWeightN: 22, takeupWeightN: 8, resetClickAudible: true, smoothPressTimeSec: 0.25, jerkPressTimeSec: 0.08 },
  m1911:  { type: "single_action", travelMm: 3.5, takeupMm: 0.5, resetMm: 1.0, pullWeightN: 18, takeupWeightN: 4, resetClickAudible: true, smoothPressTimeSec: 0.18, jerkPressTimeSec: 0.05 },

  // Snipers — set triggers for precision.
  awp:    { type: "two_stage", travelMm: 4, takeupMm: 1.5, resetMm: 0.8, pullWeightN: 12, takeupWeightN: 5, resetClickAudible: true, smoothPressTimeSec: 0.35, jerkPressTimeSec: 0.12 },
  l115a3: { type: "two_stage", travelMm: 4, takeupMm: 1.5, resetMm: 0.8, pullWeightN: 12, takeupWeightN: 5, resetClickAudible: true, smoothPressTimeSec: 0.35, jerkPressTimeSec: 0.12 },
  scout:  { type: "set_trigger", travelMm: 2, takeupMm: 0.5, resetMm: 0.5, pullWeightN: 8, takeupWeightN: 3, resetClickAudible: true, smoothPressTimeSec: 0.40, jerkPressTimeSec: 0.15 },
  kar98k: { type: "two_stage", travelMm: 5, takeupMm: 2, resetMm: 1.0, pullWeightN: 18, takeupWeightN: 8, resetClickAudible: true, smoothPressTimeSec: 0.30, jerkPressTimeSec: 0.10 },
};

export function triggerSpecFor(weapon: WeaponType): TriggerSpec {
  return TRIGGER_SPECS[weapon] ?? {
    type: "single_stage", travelMm: 5, takeupMm: 1, resetMm: 1.5,
    pullWeightN: 22, takeupWeightN: 6, resetClickAudible: true,
    smoothPressTimeSec: 0.25, jerkPressTimeSec: 0.08,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger state.
// ─────────────────────────────────────────────────────────────────────────────

export type TriggerPhase =
  | "rest"           // finger off the trigger
  | "takeup"         // taking up slack
  | "wall"           // at the wall (pre-break tension)
  | "break"          // shot fired, trigger fully depressed
  | "overtravel"     // beyond the break (negative effects)
  | "reset"          // released back to reset point
  | "followthrough"; // post-shot, holding the trigger back briefly

export interface TriggerState {
  phase: TriggerPhase;
  /** Current trigger position (mm, 0 = rest, travelMm = break). */
  positionMm: number;
  /** Time the current press took (sec). Used to detect jerk vs smooth. */
  pressTimeSec: number;
  /** True if the press was a jerk (pressTimeSec < jerkPressTimeSec). */
  wasJerk: boolean;
  /** True if the player over-traveled (released past reset). */
  fullRelease: boolean;
  /** Number of shots fired in current "string" (since last full release). */
  shotsInString: number;
}

export function initTriggerState(): TriggerState {
  return {
    phase: "rest", positionMm: 0, pressTimeSec: 0,
    wasJerk: false, fullRelease: true, shotsInString: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger update — called per frame by the InputSystem.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the trigger state based on input.
 * @param state Current trigger state.
 * @param spec Trigger spec for the weapon.
 * @param triggerPressed True if the trigger key/button is held.
 * @param dtSec Delta time in seconds.
 * @returns Updated state + a "fired" flag (true if the trigger just broke).
 */
export function updateTriggerState(
  state: TriggerState,
  spec: TriggerSpec,
  triggerPressed: boolean,
  dtSec: number,
): { state: TriggerState; fired: boolean } {
  let phase = state.phase;
  let positionMm = state.positionMm;
  let pressTimeSec = state.pressTimeSec;
  let wasJerk = state.wasJerk;
  let fullRelease = state.fullRelease;
  let shotsInString = state.shotsInString;
  let fired = false;

  // Trigger travel speed: smooth press = travelMm / smoothPressTimeSec.
  const pressSpeed = spec.travelMm / spec.smoothPressTimeSec;
  const releaseSpeed = spec.travelMm / (spec.smoothPressTimeSec * 0.6);

  if (triggerPressed) {
    pressTimeSec += dtSec;
    if (phase === "rest" || phase === "reset" || phase === "followthrough") {
      phase = "takeup";
    }
    if (phase === "takeup") {
      positionMm += pressSpeed * dtSec;
      if (positionMm >= spec.takeupMm) phase = "wall";
    }
    if (phase === "wall") {
      positionMm += pressSpeed * dtSec * 0.5; // slower through the wall
      if (positionMm >= spec.travelMm) {
        phase = "break";
        positionMm = spec.travelMm;
        fired = true;
        wasJerk = pressTimeSec < spec.jerkPressTimeSec;
        shotsInString = state.fullRelease ? 1 : state.shotsInString + 1;
        fullRelease = false;
      }
    }
    if (phase === "break") {
      // Continue into overtravel.
      positionMm = spec.travelMm + pressSpeed * dtSec;
      if (positionMm > spec.travelMm + 1.0) phase = "overtravel";
    }
  } else {
    // Release.
    if (phase === "break" || phase === "overtravel") {
      phase = "followthrough";
    }
    if (phase === "followthrough" || phase === "takeup" || phase === "wall") {
      positionMm -= releaseSpeed * dtSec;
      if (phase === "followthrough" && positionMm <= spec.travelMm - spec.resetMm) {
        phase = "reset";
        // Detect full release.
        if (positionMm <= 0) {
          phase = "rest";
          positionMm = 0;
          fullRelease = true;
          shotsInString = 0;
        }
      } else if (phase === "takeup" || phase === "wall") {
        if (positionMm <= 0) {
          phase = "rest";
          positionMm = 0;
          fullRelease = true;
          shotsInString = 0;
        }
      }
    }
    if (phase === "reset") {
      positionMm -= releaseSpeed * dtSec;
      if (positionMm <= 0) {
        phase = "rest";
        positionMm = 0;
        fullRelease = true;
        shotsInString = 0;
      }
    }
    pressTimeSec = 0;
  }

  return {
    state: { phase, positionMm, pressTimeSec, wasJerk, fullRelease, shotsInString },
    fired,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Accuracy penalty from trigger quality.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the accuracy multiplier for the most recent trigger press.
 *   • Smooth single press: 1.0 (no penalty).
 *   • Jerk: 0.7 (30% spread increase).
 *   • Overtravel: 0.85.
 *   • Multi-shot string with proper reset: 0.95 (slight degradation).
 *   • Multi-shot string with full release: 0.85.
 */
export function triggerAccuracyPenalty(state: TriggerState, spec: TriggerSpec): number {
  let mult = 1.0;
  if (state.wasJerk) mult *= 0.7;
  if (state.phase === "overtravel") mult *= 0.85;
  if (state.shotsInString > 1) {
    mult *= state.fullRelease ? 0.85 : 0.95;
  }
  // Heavy trigger pulls are harder to control smoothly.
  if (spec.pullWeightN > 24) mult *= 0.95;
  return mult;
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD hints.
// ─────────────────────────────────────────────────────────────────────────────

export function triggerPhaseLabel(phase: TriggerPhase): string {
  switch (phase) {
    case "rest":          return "";
    case "takeup":        return "TAKEUP";
    case "wall":          return "WALL";
    case "break":         return "BREAK";
    case "overtravel":    return "OVERTRAVEL";
    case "reset":         return "RESET";
    case "followthrough": return "FOLLOW-THROUGH";
  }
}

export function triggerPhaseColor(phase: TriggerPhase): string {
  switch (phase) {
    case "rest":          return "#9ca3af";
    case "takeup":        return "#84cc16";
    case "wall":          return "#f59e0b";
    case "break":         return "#ef4444";
    case "overtravel":    return "#dc2626";
    case "reset":         return "#3b82f6";
    case "followthrough": return "#10b981";
  }
}

/** Whether the trigger is currently reset (ready for the next shot). */
export function isTriggerReset(state: TriggerState): boolean {
  return state.phase === "rest" || state.phase === "reset";
}

/** Whether the player is using proper trigger reset (not full release). */
export function isUsingProperReset(state: TriggerState): boolean {
  return state.shotsInString > 1 && !state.fullRelease;
}
