/**
 * Section C — Wind deflection of bullet trajectories.
 *
 * Implements the classic Didion (1859) crosswind deflection formula:
 *
 *     D = W · (T − R / V₀)
 *
 * where W = crosswind speed, T = time of flight to range R, V₀ = muzzle
 * velocity. The (T − R/V₀) term is the "lag time" — how much the bullet
 * has slowed relative to its muzzle velocity. At the muzzle it is 0 (no
 * drift); at long range it dominates (heavy drift on slow bullets).
 *
 * The exported resolver takes (distance, windSpeed, windAngle, bc) and
 * approximates time-of-flight from the G1 ballistic coefficient using a
 * point-mass drag model, then applies Didion. Lower BC → more drag →
 * longer ToF → more drift.
 */

/** G1 drag reference: drag deceleration constant (empirical, scaled). */
const G1_DRAG_K = 0.00528;

/**
 * Estimate time of flight (seconds) over `distanceM` for a bullet with
 * G1 ballistic coefficient `bc`, assuming a representative rifle muzzle
 * velocity of 850 m/s. Uses a closed-form exponential-velocity model:
 * v(d) ≈ v0 · exp(−k·d / bc), so ToF = (bc/k)·(1 − exp(−k·d/bc)) / v0.
 */
export function estimateTimeOfFlight(distanceM: number, bc: number, v0Mps = 850): number {
  if (distanceM <= 0 || bc <= 0) return 0;
  const k = G1_DRAG_K / bc; // per-meter drag rate
  const exponent = Math.min(50, k * distanceM); // clamp to avoid overflow
  return (1 - Math.exp(-exponent)) / (k * v0Mps);
}

/**
 * Compute wind deflection (meters) for a single shot.
 *
 * @param distance   Target distance in meters.
 * @param windSpeed  Wind speed in m/s.
 * @param windAngle  Angle between wind direction and bore axis, in degrees
 *                   (0 = head/tailwind, 90 = full crosswind). The crosswind
 *                   component is windSpeed · sin(angle).
 * @param bc         G1 ballistic coefficient (dimensionless). Higher BC →
 *                   less drag → less drift.
 * @returns Lateral deflection in meters (positive = downwind drift).
 */
export function computeWindDeflection(
  distance: number,
  windSpeed: number,
  windAngle: number,
  bc: number,
): number {
  if (distance <= 0 || windSpeed <= 0 || bc <= 0) return 0;

  // Crosswind component (perpendicular to bore).
  const crosswind = windSpeed * Math.sin((windAngle * Math.PI) / 180);
  if (Math.abs(crosswind) < 1e-6) return 0;

  // Reference muzzle velocity for the ToF estimate.
  const v0 = 850; // m/s — representative rifle muzzle velocity

  const tof = estimateTimeOfFlight(distance, bc, v0);
  if (tof <= 0) return 0;

  // Didion lag time: ToF minus the vacuum (no-drag) flight time.
  const vacuumTof = distance / v0;
  const lagTime = Math.max(0, tof - vacuumTof);

  return crosswind * lagTime;
}

/** Convenience: deflection in centimeters (common for hold-off HUDs). */
export function computeWindDeflectionCm(
  distance: number,
  windSpeed: number,
  windAngle: number,
  bc: number,
): number {
  return computeWindDeflection(distance, windSpeed, windAngle, bc) * 100;
}

/**
 * Sample a per-shot gusty crosswind (deterministic from a seed). Adds
 * shot-to-shot variation so a fixed compensation macro can't learn it.
 */
export function sampleGustyCrosswind(
  meanWindSpeed: number,
  gustAmplitude: number,
  shotSeed: number,
): number {
  if (gustAmplitude <= 0) return meanWindSpeed;
  // Mulberry32 step for a deterministic 0..1 sample.
  let z = (shotSeed + 0x6d2b79f5) >>> 0;
  z = Math.imul(z ^ (z >>> 15), z | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  const u = ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  const noise = (u * 2 - 1) * gustAmplitude;
  return meanWindSpeed * (1 + noise);
}
