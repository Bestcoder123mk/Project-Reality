/**
 * Section D — Fire Mode Selection (Safe / Semi / Burst / Auto).
 *
 * Real-world weapons have a selector lever with discrete positions:
 *   • Safe   — trigger mechanically disconnected from sear; cannot fire.
 *   • Semi   — one shot per trigger pull.
 *   • Burst  — N shots (usually 3) per trigger pull, then re-cock.
 *   • Auto   — continuous fire while trigger held.
 *
 * The existing `FireMode` type in `sectionB.ts` covers bolt/semi/auto/burst
 * but has no "safe" position, and the `FIRE_MODE_STATS` table is per-mode
 * (no per-weapon variant). This module adds:
 *
 *   1. Extended `FireSelectorPosition` enum including "safe".
 *   2. Per-weapon selector layout (which positions the weapon supports).
 *   3. Selector switch transition timing + audio cues.
 *   4. Burst-fire round count (some weapons: 2, 3, or 4 round burst).
 *   5. Burst-fire reset — must release trigger to re-arm burst.
 *   6. Selector position visual indicator (for HUD / viewmodel).
 *
 * Engine integration: the WeaponSystem reads `currentSelectorPosition()`
 * to gate firing; the HudSystem reads `selectorLabel()` for the HUD
 * indicator; the InputSystem reads `transitionSelector()` when the player
 * presses the selector key.
 */

import type { WeaponType } from "../store";
import { WEAPONS } from "../store";
import { defaultFireModeFor, type FireMode } from "./sectionB";

// ─────────────────────────────────────────────────────────────────────────────
// Selector position enum.
// ─────────────────────────────────────────────────────────────────────────────

export type FireSelectorPosition = "safe" | "semi" | "burst" | "auto";

export interface SelectorLayout {
  /** Positions the weapon supports, in the physical order on the selector. */
  positions: FireSelectorPosition[];
  /** Burst round count (if burst supported). Default 3. */
  burstRounds: number;
  /** Selector transition time (ms). */
  transitionMs: number;
  /** Selector location on the weapon (for viewmodel animation). */
  location: "left_thumb" | "right_thumb" | " ambi" | "top" | "side";
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-weapon selector layouts.
// Real-world reference:
//   M4A1:           Safe / Semi / Auto (no burst, full-auto instead)
//   M16A4:          Safe / Semi / Burst
//   AK-74:          Safe / Auto / Semi (lower is auto, upper is semi)
//   SCAR-H:         Safe / Semi / Auto
//   FAMAS:          Safe / Auto / 3rd-burst / Semi (4 positions)
//   Glock 18:       Safe / Semi / Auto (selector on slide)
//   Most pistols:   Safe / Semi (or DAO: no safety)
//   Snipers:        Safe / Semi (bolt-action snipers have no auto)
//   LMGs:           Safe / Auto (no semi)
// ─────────────────────────────────────────────────────────────────────────────

const LAYOUTS: Partial<Record<WeaponType, SelectorLayout>> = {
  // AR-pattern (M4A1-style: safe/semi/auto).
  m4:   { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 120, location: "left_thumb" },
  hk416: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 120, location: "left_thumb" },
  mk12: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 120, location: "left_thumb" },
  m4a1: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 120, location: "left_thumb" },
  scarl: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 130, location: "left_thumb" },
  mcx:  { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 120, location: "left_thumb" },
  g36:  { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 130, location: "left_thumb" },
  tavorx95: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 130, location: "left_thumb" },

  // AR-pattern with burst (M16A4-style).
  famas: { positions: ["safe", "semi", "burst", "auto"], burstRounds: 3, transitionMs: 140, location: "ambi" },
  aug:   { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 130, location: "left_thumb" },
  // AUG uses progressive trigger (pull light = semi, pull hard = auto).

  // AK-pattern (Safe / Auto / Semi — reversed order).
  ak74: { positions: ["safe", "auto", "semi"], burstRounds: 0, transitionMs: 150, location: "right_thumb" },
  ak74n: { positions: ["safe", "auto", "semi"], burstRounds: 0, transitionMs: 150, location: "right_thumb" },
  galil: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 140, location: "right_thumb" },
  rpk:  { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 150, location: "right_thumb" },
  rpk16: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 150, location: "right_thumb" },
  svd:  { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 150, location: "right_thumb" },

  // Battle rifles + DMRs (no auto on DMR).
  scarh: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 130, location: "left_thumb" },
  mk17:  { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 130, location: "left_thumb" },
  mk14:  { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 140, location: "left_thumb" },
  m110:  { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 140, location: "left_thumb" },

  // SMGs.
  mp7:   { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 100, location: "left_thumb" },
  p90:   { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 110, location: "top" },
  mp5:   { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 100, location: "left_thumb" },
  ump45: { positions: ["safe", "semi", "burst", "auto"], burstRounds: 2, transitionMs: 110, location: "left_thumb" },
  vector: { positions: ["safe", "semi", "burst", "auto"], burstRounds: 2, transitionMs: 100, location: "left_thumb" },
  pp90m1: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 110, location: "left_thumb" },

  // Pistols (semi-only, except G18).
  usp:     { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 80, location: "left_thumb" },
  deagle:  { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 90, location: "left_thumb" },
  glock17: { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 80, location: "left_thumb" },
  glock18: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 80, location: "left_thumb" },
  m1911:   { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 90, location: "left_thumb" },
  revolver: { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 100, location: "left_thumb" },

  // Snipers (bolt-action, no auto — modeled as semi w/ long cycle).
  awp:    { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 120, location: "right_thumb" },
  scout:  { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 120, location: "right_thumb" },
  kar98k: { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 130, location: "right_thumb" },
  l115a3: { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 120, location: "right_thumb" },
  m82:    { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 130, location: "right_thumb" },

  // Shotguns.
  nova:   { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 100, location: "right_thumb" },
  m870:   { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 100, location: "right_thumb" },
  m1014:  { positions: ["safe", "semi"], burstRounds: 0, transitionMs: 100, location: "right_thumb" },
  spas12: { positions: ["safe", "semi", "auto"], burstRounds: 0, transitionMs: 110, location: "right_thumb" },

  // LMGs (no semi — belt-fed, only safe / auto).
  m249:  { positions: ["safe", "auto"], burstRounds: 0, transitionMs: 130, location: "left_thumb" },
  rpk16: { positions: ["safe", "auto"], burstRounds: 0, transitionMs: 130, location: "right_thumb" },
  mk48:  { positions: ["safe", "auto"], burstRounds: 0, transitionMs: 140, location: "left_thumb" },
  pkm:   { positions: ["safe", "auto"], burstRounds: 0, transitionMs: 140, location: "right_thumb" },
  m240b: { positions: ["safe", "auto"], burstRounds: 0, transitionMs: 150, location: "left_thumb" },
};

export function selectorLayoutFor(weapon: WeaponType): SelectorLayout {
  return LAYOUTS[weapon] ?? {
    positions: ["safe", "semi", "auto"],
    burstRounds: 0,
    transitionMs: 120,
    location: "left_thumb",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Selector state + transitions.
// ─────────────────────────────────────────────────────────────────────────────

export interface FireSelectorState {
  weapon: WeaponType;
  currentPosition: FireSelectorPosition;
  /** Position being transitioned to (or null if not transitioning). */
  transitioningTo: FireSelectorPosition | null;
  /** Transition progress (0..1). */
  transitionProgress: number;
  /** Burst-fire state — remaining shots in current burst. */
  burstShotsRemaining: number;
  /** Whether the trigger was released since the last burst (burst reset). */
  triggerReleasedSinceBurst: boolean;
}

export function initFireSelectorState(weapon: WeaponType): FireSelectorState {
  const layout = selectorLayoutFor(weapon);
  // Default to "safe" — player must consciously disengage the safety.
  // (Game-feel option: default to the weapon's primary mode instead.)
  const defaultMode = defaultFireModeFor(weapon);
  const mapped: FireSelectorPosition = defaultMode === "auto"
    ? "auto"
    : defaultMode === "burst"
      ? "burst"
      : "semi";
  return {
    weapon,
    currentPosition: layout.positions.includes(mapped) ? mapped : "semi",
    transitioningTo: null,
    transitionProgress: 0,
    burstShotsRemaining: 0,
    triggerReleasedSinceBurst: true,
  };
}

/** Begin a transition to the next/previous selector position. */
export function cycleSelector(state: FireSelectorState, direction: 1 | -1 = 1): FireSelectorState {
  const layout = selectorLayoutFor(state.weapon);
  const idx = layout.positions.indexOf(state.currentPosition);
  const newIdx = (idx + direction + layout.positions.length) % layout.positions.length;
  return {
    ...state,
    transitioningTo: layout.positions[newIdx],
    transitionProgress: 0,
  };
}

/** Set the selector directly to a position (e.g. via keybind 1/2/3/4). */
export function setSelectorPosition(state: FireSelectorState, position: FireSelectorPosition): FireSelectorState {
  const layout = selectorLayoutFor(state.weapon);
  if (!layout.positions.includes(position)) return state;
  return {
    ...state,
    transitioningTo: position,
    transitionProgress: 0,
  };
}

/** Tick the transition. Returns the new state. */
export function tickSelectorTransition(state: FireSelectorState, dtMs: number): FireSelectorState {
  if (!state.transitioningTo) return state;
  const layout = selectorLayoutFor(state.weapon);
  const progress = state.transitionProgress + dtMs / layout.transitionMs;
  if (progress >= 1) {
    return {
      ...state,
      currentPosition: state.transitioningTo,
      transitioningTo: null,
      transitionProgress: 0,
    };
  }
  return { ...state, transitionProgress: progress };
}

// ─────────────────────────────────────────────────────────────────────────────
// Burst-fire handling.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether the selector will fire a round on this trigger pull. */
export function canFireInSelector(state: FireSelectorState): boolean {
  if (state.currentPosition === "safe") return false;
  if (state.transitioningTo !== null) return false; // mid-transition
  if (state.currentPosition === "burst") {
    return state.burstShotsRemaining > 0 && state.triggerReleasedSinceBurst;
  }
  return true;
}

/** Called when a round is fired; updates burst count. */
export function onShotFired(state: FireSelectorState): FireSelectorState {
  if (state.currentPosition === "burst") {
    const remaining = Math.max(0, state.burstShotsRemaining - 1);
    return { ...state, burstShotsRemaining: remaining, triggerReleasedSinceBurst: false };
  }
  return { ...state, triggerReleasedSinceBurst: false };
}

/** Called when the trigger is released; arms the next burst. */
export function onTriggerReleased(state: FireSelectorState): FireSelectorState {
  if (state.currentPosition === "burst" && state.burstShotsRemaining === 0) {
    const layout = selectorLayoutFor(state.weapon);
    return { ...state, burstShotsRemaining: layout.burstRounds, triggerReleasedSinceBurst: true };
  }
  return { ...state, triggerReleasedSinceBurst: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers.
// ─────────────────────────────────────────────────────────────────────────────

export function selectorLabel(pos: FireSelectorPosition): string {
  switch (pos) {
    case "safe":  return "SAFE";
    case "semi":  return "SEMI";
    case "burst": return "BURST";
    case "auto":  return "AUTO";
  }
}

export function selectorSymbol(pos: FireSelectorPosition): string {
  switch (pos) {
    case "safe":  return "⊙"; // safe — crossed out
    case "semi":  return "1";
    case "burst": return "3";
    case "auto":  return "∞";
  }
}

export function selectorColor(pos: FireSelectorPosition): string {
  switch (pos) {
    case "safe":  return "#9ca3af"; // gray
    case "semi":  return "#10b981"; // green
    case "burst": return "#f59e0b"; // amber
    case "auto":  return "#ef4444"; // red
  }
}

/** Map the existing FireMode enum to the new FireSelectorPosition. */
export function fireModeToSelector(mode: FireMode): FireSelectorPosition {
  switch (mode) {
    case "bolt":  return "semi"; // bolt-action → semi (1 pull = 1 shot)
    case "semi":  return "semi";
    case "burst": return "burst";
    case "auto":  return "auto";
  }
}

/** Reverse map for the existing WeaponSystem that consumes FireMode. */
export function selectorToFireMode(pos: FireSelectorPosition): FireMode | null {
  switch (pos) {
    case "safe":  return null;
    case "semi":  return "semi";
    case "burst": return "burst";
    case "auto":  return "auto";
  }
}

/** Whether the weapon supports a given fire mode (real-world). */
export function weaponSupportsFireMode(weapon: WeaponType, mode: FireSelectorPosition): boolean {
  return selectorLayoutFor(weapon).positions.includes(mode);
}

/** Real-world fire-rate (RPM) for the weapon in the selected mode. */
export function effectiveRpmInMode(weapon: WeaponType, mode: FireSelectorPosition): number {
  if (mode === "safe") return 0;
  const cfg = WEAPONS[weapon];
  if (!cfg) return 0;
  // Game fireRate is in ms between shots → convert to RPM.
  if (mode === "semi" || mode === "burst") {
    // Semi: limited by trigger pull speed (cap ~300 rpm for rifle, 120 pistol).
    return Math.min(300, 60000 / cfg.fireRate);
  }
  return Math.round(60000 / cfg.fireRate);
}
