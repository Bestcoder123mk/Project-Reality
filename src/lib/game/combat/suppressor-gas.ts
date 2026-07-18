/**
 * Section C — Suppressor gas blowback particle configuration.
 *
 * A suppressor's baffle stack traps most muzzle blast, but a portion of
 * the propellant gas still vents forward as a visible + thermal puff.
 * This module exposes a per-suppressor-type gas profile consumed by the
 * ParticleSystem to render the blowback cloud, plus a sustained-fire
 * accumulator that lingers around the shooter in still air.
 */

/** Suppressor archetype — drives the base signature. */
export type SuppressorType =
  | "direct_thread"      // standard baffle stack
  | "flow_through"       // low back-pressure (less gas forward)
  | "wet"                // water/cream cooled (least visible)
  | "integrally_suppressed";

/** Per-shot gas blowback particle profile. */
export interface SuppressorGasProfile {
  /** Suppressor archetype this profile describes. */
  type: SuppressorType;
  /** Visible gas cloud opacity 0..1. */
  opacity: number;
  /** Visible puff lifespan (seconds). */
  lifespanS: number;
  /** Particle count spawned per shot. */
  particleCount: number;
  /** Initial outward spread velocity (m/s). */
  spreadVelocityMps: number;
  /** Thermal intensity 0..1 (visibility on thermal optics). */
  thermalIntensity: number;
  /** Per-shot back-pressure fraction 0..1 (affects weapon reliability). */
  backPressure: number;
}

// ─── Per-archetype profiles (real-world signature ordering) ──────────────────

const DIRECT_THREAD: SuppressorGasProfile = {
  type: "direct_thread",
  opacity: 0.45, lifespanS: 0.9, particleCount: 14,
  spreadVelocityMps: 3.5, thermalIntensity: 0.70, backPressure: 0.85,
};

const FLOW_THROUGH: SuppressorGasProfile = {
  type: "flow_through",
  opacity: 0.30, lifespanS: 0.6, particleCount: 9,
  spreadVelocityMps: 2.8, thermalIntensity: 0.50, backPressure: 0.40,
};

const WET: SuppressorGasProfile = {
  type: "wet",
  opacity: 0.15, lifespanS: 0.4, particleCount: 5,
  spreadVelocityMps: 2.0, thermalIntensity: 0.30, backPressure: 0.70,
};

const INTEGRAL: SuppressorGasProfile = {
  type: "integrally_suppressed",
  opacity: 0.10, lifespanS: 0.35, particleCount: 4,
  spreadVelocityMps: 1.8, thermalIntensity: 0.25, backPressure: 0.60,
};

/**
 * Master suppressor gas profile table, keyed by suppressor type.
 * Ordered from most-visible (direct thread) to least (integral).
 */
export const SUPPRESSOR_GAS_PROFILE: Record<SuppressorType, SuppressorGasProfile> = {
  direct_thread: DIRECT_THREAD,
  flow_through: FLOW_THROUGH,
  wet: WET,
  integrally_suppressed: INTEGRAL,
};

/** Resolve a gas profile by suppressor type (falls back to direct_thread). */
export function getSuppressorGasProfile(type: SuppressorType): SuppressorGasProfile {
  return SUPPRESSOR_GAS_PROFILE[type] ?? DIRECT_THREAD;
}

/** Per-caliber gas-volume multiplier (more powder = more gas). */
export const CALIBER_GAS_MULT: Record<string, number> = {
  m855: 1.0, m80: 1.4, "9mm": 0.5, "338_lm": 1.8, "12ga_buck": 1.2,
};

/**
 * Scale a base profile by the fired caliber's gas volume. Returns a new
 * profile object (does not mutate the base).
 */
export function scaleProfileByCaliber(
  base: SuppressorGasProfile,
  caliberSlug: string,
): SuppressorGasProfile {
  const mult = CALIBER_GAS_MULT[caliberSlug] ?? 1.0;
  return {
    ...base,
    opacity: Math.min(1, base.opacity * mult),
    particleCount: Math.round(base.particleCount * mult),
    thermalIntensity: Math.min(1, base.thermalIntensity * mult),
    spreadVelocityMps: base.spreadVelocityMps * (1 + (mult - 1) * 0.3),
  };
}

/** Sustained-fire accumulator: opacity lingering around the shooter. */
export interface SustainedGasState {
  accumulatedOpacity: number;
  decayPerS: number;
}

/** Add a shot's contribution to the lingering cloud. */
export function addSustainedGas(state: SustainedGasState, shotOpacity: number): SustainedGasState {
  return {
    ...state,
    accumulatedOpacity: Math.min(0.85, state.accumulatedOpacity + shotOpacity * 0.35),
  };
}

/** Decay the lingering cloud over time (faster in wind). */
export function decaySustainedGas(state: SustainedGasState, dtS: number, windSpeedMps: number): SustainedGasState {
  const windDecay = 1 + windSpeedMps / 8;
  return {
    ...state,
    accumulatedOpacity: Math.max(0, state.accumulatedOpacity - state.decayPerS * windDecay * dtS),
  };
}
