/**
 * Section C — Supersonic bullet crack Doppler-shift audio model.
 *
 * A supersonic bullet radiates an N-wave shock ("crack") whose perceived
 * pitch is Doppler-shifted by the bullet's velocity relative to a
 * stationary listener. The classic moving-source Doppler formula is:
 *
 *     f' = f0 · c / (c − v · cos θ)
 *
 * where c = speed of sound, v = source (bullet) speed, θ = angle between
 * the source's velocity vector and the source→listener vector. A bullet
 * approaching the listener (cos θ → +1) pitches UP; receding (cos θ → −1)
 * pitches DOWN. Subsonic bullets produce no crack (return base × 0).
 */

/** Speed of sound at 15 °C, sea level (m/s). */
export const SPEED_OF_SOUND_MPS = 343;

/** Reference center frequency of a supersonic bullet's N-wave at 1 m. */
export const CRACK_BASE_FREQ_HZ = 1000;

/** Result of a Doppler evaluation for a single bullet/listener pair. */
export interface DopplerResult {
  /** Perceived (Doppler-shifted) frequency in Hz. */
  perceivedFreqHz: number;
  /** Doppler ratio f'/f0 (1.0 = no shift). */
  shiftRatio: number;
  /** Whether the bullet is supersonic (crack audible at all). */
  isSupersonic: boolean;
}

/**
 * Compute the Doppler-shifted perceived crack frequency.
 *
 * @param bulletVelocityMps   Bullet speed (m/s).
 * @param cosTheta            cos θ — dot of bullet velocity dir and
 *                            bullet→listener dir. +1 = bullet heading
 *                            straight at listener; −1 = directly away.
 * @param baseFreqHz          Emitted N-wave center frequency (Hz).
 * @param speedOfSoundMps     Optional override for c (temperature-corrected).
 */
export function computeDopplerShift(
  bulletVelocityMps: number,
  cosTheta: number,
  baseFreqHz: number = CRACK_BASE_FREQ_HZ,
  speedOfSoundMps: number = SPEED_OF_SOUND_MPS,
): DopplerResult {
  const isSupersonic = bulletVelocityMps > speedOfSoundMps;

  // Subsonic: no shock cone — return a muffled half-pitch placeholder.
  if (!isSupersonic) {
    return {
      perceivedFreqHz: baseFreqHz * 0.5,
      shiftRatio: 0.5,
      isSupersonic: false,
    };
  }

  // Denominator approaches 0 when the bullet heads straight at the listener
  // (cos θ → +1, v → c from above) — clamp to avoid div-by-zero blowup.
  const denom = speedOfSoundMps - bulletVelocityMps * cosTheta;
  const safeDenom = Math.sign(denom) * Math.max(Math.abs(denom), 1e-3);
  const shiftRatio = speedOfSoundMps / safeDenom;
  const perceivedFreqHz = baseFreqHz * shiftRatio;

  return {
    perceivedFreqHz: Math.max(40, perceivedFreqHz),
    shiftRatio,
    isSupersonic: true,
  };
}

/** Helper: cos θ from two unit vectors (bullet dir, bullet→listener dir). */
export function cosThetaFromDirs(
  bulletDir: { x: number; y: number; z: number },
  toListener: { x: number; y: number; z: number },
): number {
  const d =
    bulletDir.x * toListener.x +
    bulletDir.y * toListener.y +
    bulletDir.z * toListener.z;
  return Math.max(-1, Math.min(1, d));
}

/** Mach cone half-angle (radians) for a supersonic bullet. sin θ = c/v. */
export function machConeHalfAngleRad(bulletVelocityMps: number): number {
  if (bulletVelocityMps <= SPEED_OF_SOUND_MPS) return Math.PI / 2;
  return Math.asin(SPEED_OF_SOUND_MPS / bulletVelocityMps);
}
