/**
 * Section D — Weapon Sway (stance / stamina / breath).
 *
 * Real-world weapon sway comes from:
 *   1. Respiratory motion — the chest expands/contracts with each breath,
 *      moving the shoulder-mounted weapon. Hold-breath eliminates this.
 *   2. Cardiac motion — the heartbeat causes a small (~0.5 MOA) vertical
 *      oscillation at the muzzle.
 *   3. Muscular fatigue — tired arms shake. Stamina-depleted players
 *      sway more, recover slower.
 *   4. Stance — prone is most stable, crouch is moderate, standing is
 *      least stable. Bipod eliminates most sway.
 *   5. Movement — even slight body motion translates to muzzle motion.
 *
 * The existing `ProceduralAnimSystem.ts` already applies a sway offset
 * based on the `weaponSwayPhase` + `weaponSwayOffset` fields in the
 * WeaponRuntimeState (types.ts). This module adds the *computation* layer
 * that decides the sway amplitude + frequency based on the above inputs.
 *
 * Engine integration: the ProceduralAnimSystem reads `computeSway()` to
 * set the per-frame sway offset; the HudSystem reads `swayAmplitudeLabel()`
 * for the breath indicator; the InputSystem reads `holdBreath()` when the
 * player holds the breath key.
 */

import type { WeaponType, WeaponCategory } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Sway inputs.
// ─────────────────────────────────────────────────────────────────────────────

export type Stance = "prone" | "crouch" | "standing" | "moving";

export interface SwayInputs {
  /** Player stance. */
  stance: Stance;
  /** Stamina fraction (0..1). 1 = full stamina. */
  stamina: number;
  /** True if the player is holding breath (sniper mechanic). */
  holdingBreath: boolean;
  /** True if the player is aiming down sights. */
  aiming: boolean;
  /** True if a bipod is deployed. */
  bipodDeployed: boolean;
  /** True if the player is leaning (left/right Q/E). */
  leaning: boolean;
  /** Time since the player last fired (sec). */
  timeSinceShotSec: number;
  /** Time since the player started aiming (sec). */
  timeSinceAdsStartSec: number;
  /** Heart-rate elevation (0..1). 1 = max exertion. */
  heartRateElevation: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-stance sway multipliers (real-world reference).
// ─────────────────────────────────────────────────────────────────────────────

const STANCE_SWAY_MULT: Record<Stance, number> = {
  prone: 0.15,    // very stable — bone support.
  crouch: 0.55,
  standing: 1.0,
  moving: 1.8,    // additional motion while moving.
};

// Per-weapon-class base sway amplitudes (radians). Heavier weapons sway more
// slowly but with more amplitude; lighter weapons sway faster but smaller.
const CLASS_BASE_AMPLITUDE: Record<WeaponCategory, number> = {
  PISTOL: 0.005,  // very small amplitude, fast oscillation.
  SMG: 0.008,
  RIFLE: 0.012,
  SHOTGUN: 0.015,
  SNIPER: 0.020,  // heaviest sway — long heavy barrel.
  LMG: 0.025,
};

const CLASS_BASE_FREQUENCY_HZ: Record<WeaponCategory, number> = {
  PISTOL: 4.0,    // high freq, small amplitude.
  SMG: 2.5,
  RIFLE: 1.5,
  SHOTGUN: 1.0,
  SNIPER: 0.7,    // slow, heavy oscillation.
  LMG: 0.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// Sway computation.
// ─────────────────────────────────────────────────────────────────────────────

export interface SwayResult {
  /** X (horizontal) offset in radians. */
  offsetXRad: number;
  /** Y (vertical) offset in radians. */
  offsetYRad: number;
  /** Total sway amplitude (radians). */
  amplitudeRad: number;
  /** Dominant frequency (Hz). */
  frequencyHz: number;
  /** Whether sway is currently "held still" (breath held + stamina OK). */
  heldStill: boolean;
  /** Time remaining for breath-hold (sec). */
  breathHoldRemainingSec: number;
}

export function computeSway(weapon: WeaponType, inputs: SwayInputs, timeSec: number, breathHoldRemainingSec: number): SwayResult {
  // Base amplitude from weapon class.
  const classAmp = CLASS_BASE_AMPLITUDE[WEAPON_CLASS[weapon] ?? "RIFLE"];
  const classFreq = CLASS_BASE_FREQUENCY_HZ[WEAPON_CLASS[weapon] ?? "RIFLE"];

  // Stance multiplier.
  let stanceMult = STANCE_SWAY_MULT[inputs.stance];
  if (inputs.bipodDeployed) stanceMult *= 0.1; // bipod almost eliminates sway.

  // Stamina multiplier — low stamina = up to 2× sway.
  const staminaMult = 1 + (1 - inputs.stamina) * 1.5;

  // Heart-rate elevation increases sway frequency (faster breathing).
  const freqMult = 1 + inputs.heartRateElevation * 0.5;

  // ADS reduces sway by 50% (the weapon is shouldered more firmly).
  const adsMult = inputs.aiming ? 0.5 : 1.0;

  // Breath-hold eliminates respiratory component (~70% of total sway).
  // Cardiac motion remains (~30% of sway).
  const breathMult = inputs.holdingBreath && breathHoldRemainingSec > 0 ? 0.3 : 1.0;

  // Leaning increases sway (asymmetric muscle load).
  const leanMult = inputs.leaning ? 1.3 : 1.0;

  // Time since ADS — sway is high right after ADS, settles over ~1 sec.
  const adsSettleMult = inputs.aiming && inputs.timeSinceAdsStartSec < 1.0
    ? 1.0 + (1.0 - inputs.timeSinceAdsStartSec) * 1.5
    : 1.0;

  // Recent shot — recoil recovery adds 50% sway for 0.5 sec after each shot.
  const recentShotMult = inputs.timeSinceShotSec < 0.5
    ? 1.0 + (0.5 - inputs.timeSinceShotSec) * 2.0
    : 1.0;

  // Final amplitude.
  const amplitude = classAmp * stanceMult * staminaMult * adsMult * breathMult
    * leanMult * adsSettleMult * recentShotMult;
  const frequency = classFreq * freqMult;

  // Compute the X/Y offset using two sinusoids (respiration) + small
  // high-freq jitter (cardiac).
  const respX = Math.sin(timeSec * frequency * 2 * Math.PI) * amplitude * 0.7;
  const respY = Math.sin(timeSec * frequency * 2 * Math.PI + Math.PI / 3) * amplitude * 0.5;
  // Cardiac — small high-freq component (~1.2 Hz heartbeat).
  const cardX = Math.sin(timeSec * 1.2 * 2 * Math.PI) * amplitude * 0.2;
  const cardY = Math.sin(timeSec * 1.2 * 2 * Math.PI + Math.PI / 2) * amplitude * 0.3;

  const offsetXRad = respX + cardX;
  const offsetYRad = respY + cardY;
  const heldStill = inputs.holdingBreath && breathHoldRemainingSec > 0 && inputs.stamina > 0.3;

  return {
    offsetXRad, offsetYRad, amplitudeRad: amplitude,
    frequencyHz: frequency, heldStill, breathHoldRemainingSec,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Breath-hold mechanic.
// ─────────────────────────────────────────────────────────────────────────────

export interface BreathHoldState {
  /** True if breath is currently held. */
  holding: boolean;
  /** Time remaining for the current breath hold (sec). */
  remainingSec: number;
  /** Maximum breath-hold duration (sec). */
  maxSec: number;
  /** Cooldown before next breath-hold (sec). */
  cooldownSec: number;
}

export function initBreathHold(maxSec = 8): BreathHoldState {
  return { holding: false, remainingSec: maxSec, maxSec, cooldownSec: 0 };
}

/** Start holding breath (if not on cooldown). */
export function startBreathHold(state: BreathHoldState): BreathHoldState {
  if (state.cooldownSec > 0) return state;
  return { ...state, holding: true };
}

/** Release breath (player let go or ran out). */
export function releaseBreathHold(state: BreathHoldState): BreathHoldState {
  if (!state.holding) return state;
  // Cooldown = 2× the fraction of breath used.
  const usedFraction = 1 - state.remainingSec / state.maxSec;
  const cooldownSec = usedFraction * 6; // up to 6 sec cooldown.
  return { ...state, holding: false, cooldownSec };
}

/** Tick the breath-hold state by dt seconds. */
export function tickBreathHold(state: BreathHoldState, dtSec: number, stamina: number): BreathHoldState {
  if (state.holding) {
    // Stamina low → breath-hold drains faster.
    const drainMult = 1.0 + (1 - stamina) * 0.5;
    const remaining = Math.max(0, state.remainingSec - dtSec * drainMult);
    if (remaining <= 0) {
      // Auto-release when out.
      return releaseBreathHold({ ...state, remainingSec: 0 });
    }
    return { ...state, remainingSec: remaining };
  }
  // Recover breath + tick down cooldown.
  const recover = dtSec * 0.5; // 2× slower than drain.
  const remaining = Math.min(state.maxSec, state.remainingSec + recover);
  const cooldown = Math.max(0, state.cooldownSec - dtSec);
  return { ...state, remainingSec: remaining, cooldownSec: cooldown };
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD helpers.
// ─────────────────────────────────────────────────────────────────────────────

export function swayAmplitudeLabel(amplitudeRad: number): string {
  const moa = (amplitudeRad * 180 * 60) / Math.PI;
  if (moa < 0.5) return "STEADY";
  if (moa < 1.5) return "STABLE";
  if (moa < 3.0) return "SWAYING";
  if (moa < 6.0) return "UNSTABLE";
  return "ERRATIC";
}

export function swayAmplitudeColor(amplitudeRad: number): string {
  const moa = (amplitudeRad * 180 * 60) / Math.PI;
  if (moa < 0.5) return "#10b981"; // green
  if (moa < 1.5) return "#84cc16"; // lime
  if (moa < 3.0) return "#f59e0b"; // amber
  if (moa < 6.0) return "#f97316"; // orange
  return "#ef4444"; // red
}

export function breathHoldFraction(state: BreathHoldState): number {
  return state.remainingSec / state.maxSec;
}

export function breathHoldColor(state: BreathHoldState): string {
  if (state.cooldownSec > 0) return "#ef4444";
  if (!state.holding) return "#9ca3af";
  const f = breathHoldFraction(state);
  if (f > 0.5) return "#10b981";
  if (f > 0.25) return "#f59e0b";
  return "#ef4444";
}

// ─────────────────────────────────────────────────────────────────────────────
// Weapon class lookup (cache for performance).
// ─────────────────────────────────────────────────────────────────────────────

import { WEAPONS } from "../store";
const WEAPON_CLASS: Partial<Record<WeaponType, WeaponCategory>> = {};
for (const [slug, cfg] of Object.entries(WEAPONS)) {
  WEAPON_CLASS[slug as WeaponType] = cfg.category;
}
