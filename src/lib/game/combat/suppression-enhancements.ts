/**
 * Section C — Suppression blur + audio ducking enhancements.
 *
 * The existing SuppressionSystem applies:
 *   - Desaturation (screen grade lerps toward grey at suppression > 0.4).
 *   - Vignette (tightens at suppression > 0.4).
 *   - Screen blur (0..1.5px at suppression 0.5..1.0).
 *   - Enemy panic animation (suppression > 0.8).
 *   - Player accuracy penalty (0..0.5 at suppression 0..1).
 *
 * This module adds the missing AUDIO + VISUAL layer for the player's
 * own suppression (when the player is being shot at):
 *
 *   1. AUDIO DUCKING: when suppressed, the game's audio ducks (quieter)
 *      and a high-frequency "tinnitus" tone is layered on top. The
 *      ducking scales with suppression (50% volume at suppression 0.5,
 *      20% at 1.0). The tinnitus frequency + amplitude match a real
 *      near-miss + shell-shock experience.
 *
 *   2. TUNNEL HEARING: the audio becomes muffled (low-pass filter) —
 *      the player can hear their own heartbeat + breathing but distant
 *      sounds are damped. This is the classic "shell shock" effect.
 *
 *   3. VISUAL TUNNEL VISION: the player's FOV narrows (zoom-in slightly)
 *      + the peripheral vision blurs. This is the visual analog of the
 *      tunnel hearing — the player's attention narrows to the threat.
 *
 *   4. SCREEN SHAKE: small camera shake from the near-misses. Scales
 *      with the proximity + velocity of the incoming rounds (a .338 LM
 *      whizzing past shakes the camera more than a 9mm).
 *
 *   5. POST-EFFECT COLOR GRADE: at high suppression, the screen shifts
 *      slightly red (the "blood pressure" effect — the player's vision
 *      reddens as adrenaline spikes).
 *
 *   6. BREATHING + HEARTBEAT: the player's breathing rate increases +
 *      becomes audible. At suppression > 0.7, the heartbeat becomes
 *      audible (a thumping bass tone that matches the in-game cardiac
 *      rhythm).
 *
 *   7. RECOVERY OVERSHOOT: when suppression drops, the visual + audio
 *      effects don't return to baseline instantly — there's a brief
 *      "overshoot" where the screen briefly brightens + the audio
 *      briefly spikes (the "phew" moment after surviving a near-miss).
 *
 * The PostProcessing pipeline + the AudioSystem both read
 * SUPPRESSION_ENHANCEMENT_STATE for the per-frame values.
 *
 * Tone reference: tactical-mil-sim-leaning-arcade. The effects are tuned
 * to be IMPACTFUL but not DISORIENTING — the player should feel "pinned
 * down" without losing the ability to play. The audio ducking doesn't
 * fully mute the game (the player still needs to hear footsteps); the
 * tunnel vision doesn't fully black out the periphery.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SuppressionEnhancementState {
  /** Current suppression level (0..1). */
  suppression: number;
  /** Smoothed suppression (lagged by ~50ms — prevents flicker). */
  smoothedSuppression: number;
  /** Peak suppression in the last 2 seconds (for the recovery overshoot). */
  peakSuppression: number;
  /** Time since suppression last dropped below 0.3 (seconds). */
  timeSinceLastHitSec: number;
  /** True if recovery overshoot is currently active. */
  recoveryOvershoot: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio enhancement parameters.
// ─────────────────────────────────────────────────────────────────────────────

export interface AudioSuppressionEffect {
  /** Master volume multiplier (0..1). 1.0 = normal, 0.2 = heavily ducked. */
  masterVolumeMult: number;
  /** Tinnitus frequency (Hz). Typically 4000-8000 Hz. */
  tinnitusFreqHz: number;
  /** Tinnitus amplitude (0..1). */
  tinnitusAmplitude: number;
  /** Low-pass filter cutoff frequency (Hz). Lower = more muffled. */
  lowpassCutoffHz: number;
  /** Heartbeat amplitude (0..1). */
  heartbeatAmplitude: number;
  /** Breathing amplitude (0..1). */
  breathingAmplitude: number;
  /** Breathing rate (breaths per minute). 12 = resting, 30 = stressed. */
  breathingRateBpm: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual enhancement parameters.
// ─────────────────────────────────────────────────────────────────────────────

export interface VisualSuppressionEffect {
  /** Screen blur (pixels). 0 = no blur, 1.5 = heavy blur. */
  blurPx: number;
  /** Vignette intensity (0..1). Higher = tighter vignette. */
  vignetteIntensity: number;
  /** Desaturation (0..1). 0 = full color, 1 = full grey. */
  desaturation: number;
  /** FOV offset (degrees, negative = zoom in). 0 = normal, -5 = slight zoom. */
  fovOffsetDeg: number;
  /** Peripheral blur (pixels). The edges of the screen blur more than the center. */
  peripheralBlurPx: number;
  /** Color grade shift (red tint). 0 = no shift, 0.3 = heavy red. */
  redShift: number;
  /** Screen shake amplitude (pixels). */
  shakeAmplitudePx: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// State lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/** Create a fresh suppression enhancement state. */
export function createSuppressionEnhancementState(): SuppressionEnhancementState {
  return {
    suppression: 0,
    smoothedSuppression: 0,
    peakSuppression: 0,
    timeSinceLastHitSec: Infinity,
    recoveryOvershoot: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// State update — call once per frame.
//
// Smoothing: the smoothed suppression lags the raw suppression by ~50ms
// (at 60Hz = 3 frames). This prevents flicker when suppression oscillates
// rapidly (e.g. bursts of fire).
//
// Peak tracking: the peak suppression in the last 2s is tracked. When
// suppression drops below 0.3 AND the peak was > 0.7, the recovery
// overshoot is triggered (lasts 0.5s).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update the suppression enhancement state. Call once per frame.
 *
 * @param state     The current state.
 * @param suppression  The raw suppression value (0..1).
 * @param dt         The frame delta time (seconds).
 * @returns          The updated state.
 */
export function updateSuppressionEnhancement(
  state: SuppressionEnhancementState,
  suppression: number,
  dt: number,
): SuppressionEnhancementState {
  // Smoothing: exponential moving average with ~50ms time constant.
  const smoothingFactor = 1 - Math.exp(-dt / 0.05);
  const newSmoothed = state.smoothedSuppression + (suppression - state.smoothedSuppression) * smoothingFactor;

  // Peak tracking: peak decays at 0.5/sec.
  const peakDecay = 0.5 * dt;
  const newPeak = Math.max(suppression, Math.max(0, state.peakSuppression - peakDecay));

  // Time since last hit: tracks when suppression last dropped below 0.3.
  const newTimeSinceLastHit = suppression > 0.3 ? 0 : state.timeSinceLastHitSec + dt;

  // Recovery overshoot: triggered when suppression drops below 0.3 AND
  // the recent peak was > 0.7 AND we haven't already triggered it.
  let newRecoveryOvershoot = state.recoveryOvershoot;
  if (suppression < 0.3 && state.peakSuppression > 0.7 && !state.recoveryOvershoot) {
    newRecoveryOvershoot = true;
  }
  // Recovery overshoot lasts 0.5s.
  if (newRecoveryOvershoot && newTimeSinceLastHit > 0.5) {
    newRecoveryOvershoot = false;
  }

  return {
    suppression,
    smoothedSuppression: newSmoothed,
    peakSuppression: newPeak,
    timeSinceLastHitSec: newTimeSinceLastHit,
    recoveryOvershoot: newRecoveryOvershoot,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio effect computation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the audio suppression effect for the current state.
 *
 * The audio effects scale with the SMOOTHED suppression (to prevent
 * audio flicker). At suppression 0: normal audio. At suppression 1.0:
 *   - Master volume ducked to 20%.
 *   - Tinnitus at 6000 Hz, 0.7 amplitude.
 *   - Low-pass filter at 800 Hz (heavily muffled).
 *   - Heartbeat at 0.6 amplitude.
 *   - Breathing at 0.5 amplitude, 28 BPM.
 */
export function computeAudioEffect(state: SuppressionEnhancementState): AudioSuppressionEffect {
  const s = state.smoothedSuppression;
  // Master volume: 1.0 at s=0, 0.2 at s=1.
  const masterVolumeMult = 1.0 - 0.8 * s;
  // Tinnitus: 0 amplitude at s<0.3, ramps to 0.7 at s=1.
  const tinnitusAmplitude = s > 0.3 ? Math.min(0.7, (s - 0.3) * 1.0) : 0;
  // Tinnitus frequency: shifts down slightly at high suppression (the
  // ringing drops in pitch as the ears fatigue).
  const tinnitusFreqHz = 6000 - 1000 * s;
  // Low-pass filter: 20000 Hz at s=0, 800 Hz at s=1 (exponential).
  const lowpassCutoffHz = Math.max(800, 20000 * Math.pow(0.95, s * 50));
  // Heartbeat: 0 at s<0.5, ramps to 0.6 at s=1.
  const heartbeatAmplitude = s > 0.5 ? Math.min(0.6, (s - 0.5) * 1.2) : 0;
  // Breathing: 0 at s<0.3, ramps to 0.5 at s=1.
  const breathingAmplitude = s > 0.3 ? Math.min(0.5, (s - 0.3) * 0.7) : 0;
  // Breathing rate: 12 BPM at rest, 30 BPM at full suppression.
  const breathingRateBpm = 12 + 18 * s;

  return {
    masterVolumeMult,
    tinnitusFreqHz,
    tinnitusAmplitude,
    lowpassCutoffHz,
    heartbeatAmplitude,
    breathingAmplitude,
    breathingRateBpm,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual effect computation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the visual suppression effect for the current state.
 *
 * The visual effects scale with the SMOOTHED suppression + the recovery
 * overshoot (which briefly brightens the screen + adds a small FOV pullback).
 */
export function computeVisualEffect(state: SuppressionEnhancementState): VisualSuppressionEffect {
  const s = state.smoothedSuppression;
  // Blur: 0 at s<0.5, ramps to 1.5px at s=1.
  const blurPx = s > 0.5 ? (s - 0.5) * 3.0 : 0;
  // Vignette: 0.22 baseline (matching the existing PostProcessing), tightens
  // to 0.6 at s=1.
  const vignetteIntensity = 0.22 + 0.38 * s;
  // Desaturation: 0.05 baseline, ramps to 0.6 at s=1.
  const desaturation = 0.05 + 0.55 * s;
  // FOV offset: 0 at s=0, -5° at s=1 (slight zoom-in for tunnel vision).
  const fovOffsetDeg = -5 * s;
  // Peripheral blur: 0 at s<0.4, ramps to 3px at s=1 (heavier than center blur).
  const peripheralBlurPx = s > 0.4 ? (s - 0.4) * 5.0 : 0;
  // Red shift: 0 at s<0.6, ramps to 0.3 at s=1 (the "blood pressure" effect).
  const redShift = s > 0.6 ? (s - 0.6) * 0.75 : 0;
  // Screen shake: 0 at s<0.3, ramps to 4px at s=1.
  const shakeAmplitudePx = s > 0.3 ? (s - 0.3) * 6.0 : 0;

  // Recovery overshoot: brightens the screen briefly + reduces vignette.
  if (state.recoveryOvershoot) {
    const overshootT = Math.max(0, 1 - state.timeSinceLastHitSec / 0.5);
    return {
      blurPx: blurPx * (1 - overshootT),
      vignetteIntensity: Math.max(0, vignetteIntensity - 0.15 * overshootT),
      desaturation: Math.max(0, desaturation - 0.1 * overshootT),
      fovOffsetDeg: fovOffsetDeg + 2 * overshootT, // brief zoom-out
      peripheralBlurPx: peripheralBlurPx * (1 - overshootT),
      redShift: Math.max(0, redShift - 0.1 * overshootT),
      shakeAmplitudePx: shakeAmplitudePx * 0.5,
    };
  }

  return {
    blurPx,
    vignetteIntensity,
    desaturation,
    fovOffsetDeg,
    peripheralBlurPx,
    redShift,
    shakeAmplitudePx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-event: apply a near-miss suppression bump.
//
// When a bullet whizzes past the player, the SuppressionSystem bumps the
// suppression. This module adds an IMMEDIATE visual + audio spike on the
// bump (a brief flinch + louder heartbeat) — separate from the steady-state
// suppression effects.
// ─────────────────────────────────────────────────────────────────────────────

export interface NearMissSpike {
  /** Time remaining for the spike effect (seconds). */
  timeRemainingSec: number;
  /** Total spike duration (seconds). */
  totalDurationSec: number;
  /** Spike intensity (0..1). Scales with bullet velocity + proximity. */
  intensity: number;
}

/** Create a near-miss spike from a bullet's closest-approach distance + velocity. */
export function createNearMissSpike(
  closestApproachM: number,
  bulletVelocityMps: number,
): NearMissSpike {
  // Intensity scales with proximity (closer = stronger) + velocity (faster = louder).
  // At 1m + 900 m/s: intensity 1.0. At 10m + 400 m/s: intensity ~0.1.
  const proximityFactor = Math.max(0, 1 - closestApproachM / 10);
  const velocityFactor = Math.min(1, bulletVelocityMps / 900);
  const intensity = proximityFactor * velocityFactor;
  // Duration: 0.3-0.5s (longer for higher intensity).
  const totalDurationSec = 0.3 + 0.2 * intensity;
  return {
    timeRemainingSec: totalDurationSec,
    totalDurationSec,
    intensity,
  };
}

/** Update the near-miss spike (decay over time). */
export function updateNearMissSpike(spike: NearMissSpike, dt: number): NearMissSpike {
  return {
    ...spike,
    timeRemainingSec: Math.max(0, spike.timeRemainingSec - dt),
  };
}

/** Compute the additional visual shake from a near-miss spike. */
export function nearMissSpikeShakePx(spike: NearMissSpike): number {
  if (spike.timeRemainingSec <= 0) return 0;
  const t = spike.timeRemainingSec / spike.totalDurationSec;
  // Spike shake: peak at the start, decays to 0.
  return 8 * spike.intensity * t;
}

/** Compute the additional audio gain from a near-miss spike. */
export function nearMissSpikeAudioGain(spike: NearMissSpike): number {
  if (spike.timeRemainingSec <= 0) return 0;
  const t = spike.timeRemainingSec / spike.totalDurationSec;
  // Brief audio spike (the "WHIZ-BANG" of a near miss).
  return 0.3 * spike.intensity * t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-event: incoming-round direction indicator (HUD).
//
// When the player is being shot at, the HUD displays a directional
// indicator showing where the incoming fire is coming from. This module
// computes the indicator's position + intensity.
// ─────────────────────────────────────────────────────────────────────────────

export interface IncomingFireIndicator {
  /** Direction the fire is coming from (compass bearing, degrees, 0 = N). */
  directionDeg: number;
  /** Intensity (0..1). Scales with proximity + velocity. */
  intensity: number;
  /** Time remaining for the indicator (seconds). */
  timeRemainingSec: number;
}

/**
 * Create an incoming-fire indicator from a bullet's trajectory.
 *
 * @param bulletPos     The bullet's position when it passed closest.
 * @param bulletVel     The bullet's velocity vector.
 * @param playerPos     The player's position.
 * @returns             The indicator (or null if the bullet is too far away).
 */
export function createIncomingFireIndicator(
  bulletPos: { x: number; y: number; z: number },
  bulletVel: { x: number; y: number; z: number },
  playerPos: { x: number; y: number; z: number },
): IncomingFireIndicator | null {
  const dx = bulletPos.x - playerPos.x;
  const dz = bulletPos.z - playerPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 30) return null; // too far to indicate
  // Direction: the fire is coming FROM the bullet's source. The source is
  // roughly opposite the bullet's velocity (the bullet is moving away from
  // the source). We use the reverse velocity direction.
  const sourceX = bulletPos.x - bulletVel.x * 0.1; // back-project 0.1s
  const sourceZ = bulletPos.z - bulletVel.z * 0.1;
  const sdx = sourceX - playerPos.x;
  const sdz = sourceZ - playerPos.z;
  // Compass bearing: 0 = N (+Z), 90 = E (+X). atan2(dx, dz).
  const directionDeg = (Math.atan2(sdx, sdz) * 180) / Math.PI;
  const bulletSpeed = Math.sqrt(bulletVel.x * bulletVel.x + bulletVel.y * bulletVel.y + bulletVel.z * bulletVel.z);
  const proximityFactor = Math.max(0, 1 - dist / 30);
  const velocityFactor = Math.min(1, bulletSpeed / 900);
  return {
    directionDeg,
    intensity: proximityFactor * velocityFactor,
    timeRemainingSec: 2.0, // indicator lasts 2s
  };
}

/** Update the incoming-fire indicator (decay over time). */
export function updateIncomingFireIndicator(ind: IncomingFireIndicator, dt: number): IncomingFireIndicator {
  return {
    ...ind,
    timeRemainingSec: Math.max(0, ind.timeRemainingSec - dt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summarize the suppression enhancement state for the debug HUD.
 */
export function summarizeSuppressionEnhancement(state: SuppressionEnhancementState): string {
  const audio = computeAudioEffect(state);
  const visual = computeVisualEffect(state);
  return `suppression ${(state.smoothedSuppression * 100).toFixed(0)}% | ` +
         `audio: vol ×${audio.masterVolumeMult.toFixed(2)}, tinnitus ${audio.tinnitusAmplitude.toFixed(2)}, ` +
         `LP ${audio.lowpassCutoffHz.toFixed(0)}Hz | ` +
         `visual: blur ${visual.blurPx.toFixed(1)}px, vignette ${visual.vignetteIntensity.toFixed(2)}, ` +
         `red ${visual.redShift.toFixed(2)}, shake ${visual.shakeAmplitudePx.toFixed(1)}px`;
}
