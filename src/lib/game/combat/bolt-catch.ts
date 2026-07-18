/**
 * Section D — Bolt Catch / Release (Last Round Hold Open).
 *
 * Real-world semi-auto + auto firearms have a "bolt catch" (AR) or "bolt
 * hold-open device" (AK-variant) that locks the bolt to the rear after the
 * last round is fired. This signals "mag empty" visually + audibly, and
 * speeds up the reload (just drop a mag, hit the bolt release — no need
 * to charge the handle).
 *
 * Behavior varies by weapon family:
 *   • AR-pattern (M4, HK416, SCAR): full BHO + bolt release button.
 *   • AK-pattern: most don't have BHO; some modern AKs (Galil ACE, RPK-16) do.
 *   • Pistols: most modern pistols (Glock, USP, M1911) have BHO + slide release.
 *   • Snipers: bolt-action has no BHO (single-round feed).
 *   • Shotguns: no BHO (manual action).
 *   • LMGs: belt-feed systems have a "feed cover open" state instead.
 *
 * This module:
 *   1. Tracks bolt state (forward / locked-back / cycling).
 *   2. Triggers BHO when the last round is fired (for compatible weapons).
 *   3. Computes the time cost of bolt-release reload vs charge-handle reload.
 *   4. Provides audio cues + visual hints for the HUD.
 */

import type { WeaponType } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Bolt state.
// ─────────────────────────────────────────────────────────────────────────────

export type BoltState =
  | "forward"      // bolt forward, round chambered (or empty chamber)
  | "locked_back"  // bolt locked to the rear by bolt catch
  | "cycling"      // bolt is moving (between forward + locked_back)
  | "manual_hold"  // manually held back (e.g. inspect chamber)
  | "feed_cover_open"; // LMG belt-feed cover open (M249, M240B)

export interface BoltCatchState {
  weapon: WeaponType;
  boltState: BoltState;
  /** True if the weapon supports last-round BHO. */
  supportsBho: boolean;
  /** Rounds remaining in the magazine at the time of last state change. */
  lastKnownRoundsInMag: number;
  /** Time the bolt has been locked back (sec). */
  timeLockedBackSec: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-weapon BHO support.
// Real-world reference:
//   • AR-pattern (M4, M16, HK416, SCAR): YES.
//   • Classic AK-74: NO. Modern AK (Galil ACE, RPK-16): YES.
//   • Most pistols: YES (Glock, USP, M1911, Deagle).
//   • Snipers (bolt-action): N/A (no auto-cycling).
//   • Shotguns: NO (manual action).
//   • LMGs: belt-fed — "feed cover open" state instead.
// ─────────────────────────────────────────────────────────────────────────────

const BHO_SUPPORT: Record<WeaponType, boolean> = {
  // AR-pattern.
  m4: true, hk416: true, famas: true, aug: true, scarh: true, mk17: true,
  mk14: true, galil: true,
  // AK-pattern.
  ak74: false, rpk: false,
  // SMGs.
  mp7: true, p90: true, mp5: true, ump45: true, vector: true, pp90m1: false,
  // Pistols.
  usp: true, deagle: true, glock18: true, m1911: true, revolver: false,
  // Snipers (bolt-action — no auto-cycling, so no BHO state).
  awp: false, scout: false, kar98k: false, l115a3: false,
  // Shotguns (manual action).
  nova: false, m1014: false, spas12: false,
  // LMGs (belt-fed — different mechanic).
  m249: false, mk48: false,
};

export function supportsBoltHoldOpen(weapon: WeaponType): boolean {
  return BHO_SUPPORT[weapon] ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// State machine.
// ─────────────────────────────────────────────────────────────────────────────

export function initBoltCatchState(weapon: WeaponType): BoltCatchState {
  return {
    weapon,
    boltState: "forward",
    supportsBho: supportsBoltHoldOpen(weapon),
    lastKnownRoundsInMag: 0,
    timeLockedBackSec: 0,
  };
}

/**
 * Called when a round is fired. Updates the bolt state:
 *   • If the round was the last in the mag AND the weapon supports BHO,
 *     lock the bolt back.
 *   • Otherwise, the bolt cycles forward (round chambered) or stays empty.
 */
export function onRoundFired(state: BoltCatchState, roundsInMagAfterShot: number): BoltCatchState {
  if (roundsInMagAfterShot === 0 && state.supportsBho) {
    return { ...state, boltState: "locked_back", lastKnownRoundsInMag: 0, timeLockedBackSec: 0 };
  }
  return { ...state, boltState: "forward", lastKnownRoundsInMag: roundsInMagAfterShot };
}

/**
 * Reload completion — drops a fresh magazine. The bolt stays locked back
 * (if BHO), waiting for the bolt release; or the player charges the handle
 * for an empty-mag reload on a non-BHO weapon.
 */
export function onReloadComplete(
  state: BoltCatchState,
  newMagRounds: number,
  wasEmptyReload: boolean,
): BoltCatchState {
  if (wasEmptyReload && state.supportsBho) {
    // BHO: mag is seated, bolt still locked back. Player hits bolt release.
    return { ...state, boltState: "locked_back", lastKnownRoundsInMag: newMagRounds };
  }
  if (wasEmptyReload && !state.supportsBho) {
    // Non-BHO: player must charge the handle to chamber a round.
    return { ...state, boltState: "forward", lastKnownRoundsInMag: 0 };
  }
  // Tactical reload (non-empty): bolt stays forward, new round already chambered.
  return { ...state, boltState: "forward", lastKnownRoundsInMag: newMagRounds };
}

/** Bolt release — slams the bolt forward, chambering a round. */
export function releaseBolt(state: BoltCatchState): BoltCatchState {
  if (state.boltState !== "locked_back") return state;
  return { ...state, boltState: "forward", timeLockedBackSec: 0 };
}

/** Manually charge the bolt (for non-BHO weapons). */
export function chargeBolt(state: BoltCatchState): BoltCatchState {
  if (state.boltState === "locked_back") {
    return { ...state, boltState: "forward" };
  }
  // Charging from forward: extracts + ejects chambered round, chambers a new one.
  return { ...state, boltState: "forward" };
}

/** Manually lock the bolt back (for chamber inspection). */
export function lockBoltBack(state: BoltCatchState): BoltCatchState {
  return { ...state, boltState: "manual_hold" };
}

/** Tick — track time locked back. */
export function tickBoltCatch(state: BoltCatchState, dtSec: number): BoltCatchState {
  if (state.boltState !== "locked_back") return state;
  return { ...state, timeLockedBackSec: state.timeLockedBackSec + dtSec };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reload-time impact.
// ─────────────────────────────────────────────────────────────────────────────

export interface BoltReloadTimeModifier {
  /** Time cost of bolt release (ms) — usually 200-400 ms. */
  boltReleaseMs: number;
  /** Time cost of charging handle (ms) — usually 600-900 ms. */
  chargeHandleMs: number;
  /** Whether the current state requires bolt release (vs charge handle). */
  requiresBoltRelease: boolean;
  /** Total reload-time adder (ms) for the current state. */
  reloadAdderMs: number;
}

/**
 * Compute the reload-time adder based on bolt state.
 *   • BHO + bolt release: fast (200 ms add).
 *   • Non-BHO + charge handle: slow (700 ms add).
 *   • Tactical reload (non-empty): no adder (bolt already forward).
 */
export function boltReloadTimeModifier(
  state: BoltCatchState,
  wasEmptyReload: boolean,
): BoltReloadTimeModifier {
  if (!wasEmptyReload) {
    return { boltReleaseMs: 0, chargeHandleMs: 0, requiresBoltRelease: false, reloadAdderMs: 0 };
  }
  if (state.supportsBho) {
    return {
      boltReleaseMs: 250,
      chargeHandleMs: 0,
      requiresBoltRelease: true,
      reloadAdderMs: 250,
    };
  }
  return {
    boltReleaseMs: 0,
    chargeHandleMs: 700,
    requiresBoltRelease: false,
    reloadAdderMs: 700,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio + HUD helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** Sound slug for the bolt lock-back click. */
export function boltLockBackSoundSlug(weapon: WeaponType): string {
  return `bolt_lockback_${weapon}`;
}

/** Sound slug for the bolt release slam. */
export function boltReleaseSoundSlug(weapon: WeaponType): string {
  return `bolt_release_${weapon}`;
}

/** Sound slug for the charging handle. */
export function chargeHandleSoundSlug(weapon: WeaponType): string {
  return `charge_handle_${weapon}`;
}

/** HUD label for the current bolt state. */
export function boltStateLabel(state: BoltCatchState): string {
  switch (state.boltState) {
    case "forward":         return "";
    case "locked_back":     return "BOLT LOCKED — [T] to release";
    case "cycling":         return "CYCLING";
    case "manual_hold":     return "CHAMBER INSPECT";
    case "feed_cover_open": return "FEED COVER OPEN";
  }
}

/** Whether the HUD should highlight the bolt-release prompt. */
export function shouldPromptBoltRelease(state: BoltCatchState): boolean {
  return state.boltState === "locked_back";
}
