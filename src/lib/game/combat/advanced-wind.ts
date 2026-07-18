/**
 * Section C — Advanced wind deflection model.
 *
 * The existing Ballistics.ts integrates a steady horizontal wind in
 * `integrateProjectile`. This module extends that with a richer wind model
 * covering:
 *
 *   1. CROSSWIND + HEADWIND/TAILWIND: a full 2D wind vector in the
 *      horizontal plane (the existing model collapses to a single
 *      direction). A bullet flying into a headwind decelerates faster;
 *      a tailwind extends the effective range; a crosswind pushes the
 *      bullet sideways.
 *
 *   2. VERTICAL GUSTS: updrafts + downdrafts (e.g. thermals, ridge lift).
 *      These affect the bullet's vertical trajectory — a strong downdraft
 *      can drop a sniper round by 10+ cm at 500m.
 *
 *   3. ALTITUDE GRADIENT: wind speed increases with altitude (the wind
 *      at 2m is slower than at 10m, due to surface friction). A bullet
 *      fired from a hilltop experiences different wind than one fired
 *      from a valley.
 *
 *   4. PER-CALIBER SENSITIVITY: lighter + slower bullets are pushed more
 *      by the same wind. A 9mm at 400 m/s drifts ~3× as much as a .338
 *      Lapua at 915 m/s for the same crosswind.
 *
 *   5. SPIN (MAGNUS) DRIFT: a spinning bullet in a crosswind experiences
 *      a small vertical Magnus force (right-hand twist + right crosswind =
 *      small upward force). Tiny but included for sniper-grade realism.
 *
 *   6. WIND READING AIDS: the model exposes a "wind reading" helper that
 *      computes the bullet's deflection for a given wind + range, used by
 *      the HUD to display the wind hold-off indicator.
 *
 * Reference data (Hornady 4DOF + Applied Ballistics):
 *   - 5.56mm M855, 5 m/s crosswind: drift at 100m = 1.8cm, 300m = 18cm,
 *     500m = 50cm.
 *   - 7.62mm M80, 5 m/s crosswind: drift at 100m = 1.2cm, 300m = 12cm,
 *     500m = 35cm.
 *   - .338 Lapua, 5 m/s crosswind: drift at 100m = 0.6cm, 300m = 6cm,
 *     500m = 18cm, 1000m = 95cm.
 *   - 9mm at 50m, 5 m/s crosswind: drift = 4.5cm (huge for a pistol shot).
 *
 * Integration: ProjectileSystem calls `applyAdvancedWind` per tick instead
 * of the legacy `integrateProjectile` wind-only branch. The HUD calls
 * `computeWindDeflection` for the wind hold-off indicator.
 *
 * Tone reference: tactical-mil-sim-leaning-arcade. The model is grounded
 * in real ballistics but the wind values are tuned for play-feel — a 5 m/s
 * crosswind is the "default" because it produces visible drift without
 * requiring the player to use a ballistic calculator.
 */

import type { CaliberProfile } from "./caliber-tables";
import { getCaliber } from "./caliber-tables";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WindVector {
  /** East-west wind speed (m/s). +X = wind blowing eastward. */
  u: number;
  /** North-south wind speed (m/s). +Z = wind blowing northward (positive Z). */
  v: number;
  /** Vertical wind speed (m/s). +Y = updraft, -Y = downdraft. */
  w: number;
}

export interface WindField {
  /** Wind at ground level (1.5m, the standard anemometer height). */
  ground: WindVector;
  /** Wind at 10m altitude (the standard missile-fire weather height). */
  at10m: WindVector;
  /** Gust factor (0..1). 0 = steady, 1 = heavily gusting. */
  gustFactor: number;
  /** Gust frequency (Hz). 0.1 = 10s period, 0.5 = 2s period. */
  gustFrequencyHz: number;
}

export interface ProjectileWindState {
  /** Caliber slug. */
  caliberSlug: string;
  /** Current bullet velocity (m/s) — x, y, z in world space. */
  velocity: { x: number; y: number; z: number };
  /** Current bullet position (m). */
  position: { x: number; y: number; z: number };
  /** Spin rate (rad/s). Right-hand twist = positive. */
  spinRateRadPerSec: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Altitude gradient — wind speed increases with altitude.
//
// The standard wind profile (power law): v(h) = v_ref × (h / h_ref) ^ α,
// where α ≈ 0.143 (1/7) for open terrain, 0.20 for suburban, 0.30 for
// urban. The wind at 10m is ~30% faster than at 1.5m in open terrain.
// ─────────────────────────────────────────────────────────────────────────────

/** Terrain type for the altitude gradient. */
export type TerrainType = "open" | "suburban" | "urban" | "forest";

export const TERRAIN_ALPHA: Record<TerrainType, number> = {
  open: 0.143,    // 1/7 power law (open water / plains)
  suburban: 0.20, // light obstacles
  urban: 0.30,    // tall buildings
  forest: 0.25,   // tree canopy
};

/**
 * Compute the wind speed at a given altitude, given the wind at the
 * reference height (1.5m by default).
 *
 *   v(h) = v_ref × (h / h_ref) ^ α
 */
export function windAtAltitude(
  windAtRef: number,
  altitudeM: number,
  refAltitudeM: number = 1.5,
  terrain: TerrainType = "open",
): number {
  if (altitudeM <= refAltitudeM) return windAtRef;
  const alpha = TERRAIN_ALPHA[terrain];
  return windAtRef * Math.pow(altitudeM / refAltitudeM, alpha);
}

/**
 * Sample the wind field at a given world position + altitude. Interpolates
 * between the ground + 10m wind vectors, then applies the altitude power
 * law for the actual altitude.
 */
export function sampleWindField(
  field: WindField,
  altitudeM: number,
  terrain: TerrainType = "open",
): WindVector {
  // Linear interpolation between ground (1.5m) + 10m wind.
  const t = Math.max(0, Math.min(1, (altitudeM - 1.5) / (10 - 1.5)));
  const baseU = field.ground.u + (field.at10m.u - field.ground.u) * t;
  const baseV = field.ground.v + (field.at10m.v - field.ground.v) * t;
  const baseW = field.ground.w + (field.at10m.w - field.ground.w) * t;
  // Apply the altitude power law (only to horizontal components — vertical
  // gusts don't follow the same profile).
  const horizMult = windAtAltitude(1, altitudeM, 1.5, terrain);
  return {
    u: baseU * horizMult,
    v: baseV * horizMult,
    w: baseW, // vertical unchanged
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gust noise — wind speed varies over time.
//
// The existing Ballistics.gustWindSpeed uses a simple sinusoid. This module
// uses a sum-of-sinusoids noise (1/f-like) to produce more natural gust
// patterns. The gust is deterministic given (time, seed) so the player
// can read the pattern.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the gust multiplier (0..2, where 1.0 = no gust) at a given time.
 * Deterministic given (time, seed).
 */
export function gustMultiplier(
  timeSec: number,
  frequencyHz: number,
  gustFactor: number,
  seed: number = 0,
): number {
  if (gustFactor <= 0) return 1.0;
  // Sum of 3 sinusoids (1/f-like spectrum).
  const f1 = Math.sin(timeSec * Math.PI * 2 * frequencyHz + seed);
  const f2 = Math.sin(timeSec * Math.PI * 2 * frequencyHz * 2.3 + seed * 1.7) * 0.5;
  const f3 = Math.sin(timeSec * Math.PI * 2 * frequencyHz * 4.7 + seed * 2.3) * 0.25;
  const noise = (f1 + f2 + f3) / 1.75; // normalized to [-1, 1]
  return 1.0 + noise * gustFactor;
}

/**
 * Apply the gust multiplier to a wind field at a given time. Returns a
 * new wind vector with the gust applied.
 */
export function applyGust(
  wind: WindVector,
  field: WindField,
  timeSec: number,
  seed: number = 0,
): WindVector {
  const mult = gustMultiplier(timeSec, field.gustFrequencyHz, field.gustFactor, seed);
  return {
    u: wind.u * mult,
    v: wind.v * mult,
    w: wind.w * mult,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-caliber wind sensitivity.
//
// Lighter + slower bullets are pushed more by the same wind. The wind
// sensitivity is inversely proportional to the bullet's momentum (mass ×
// velocity) + its BC (aerodynamic bullets cut through wind better).
//
// We use a per-caliber "wind sensitivity coefficient" calibrated against
// the reference data above:
//   - 5.56mm M855: 1.0 (baseline)
//   - 7.62mm M80: 0.65 (heavier, more aerodynamic)
//   - 9mm: 2.5 (much lighter + slower)
//   - .338 Lapua: 0.35 (very heavy + very aerodynamic)
//   - 12ga pellet: 4.0 (very light + poor BC)
// ─────────────────────────────────────────────────────────────────────────────

export const CALIBER_WIND_SENSITIVITY: Record<string, number> = {
  m855:        1.0,
  m80:         0.65,
  "9mm":       2.5,
  "338_lm":    0.35,
  "12ga_buck": 4.0,
};

/** Get the wind sensitivity coefficient for a caliber. */
export function getCaliberWindSensitivity(slug: string): number {
  return CALIBER_WIND_SENSITIVITY[slug] ?? 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core wind deflection computation.
//
// For a bullet traveling at velocity v_b through air with wind velocity v_w:
//   - The relative wind (v_w - v_b) acts on the bullet.
//   - The crosswind component (perpendicular to v_b) pushes the bullet sideways.
//   - The headwind/tailwind component (parallel to v_b) increases/decreases
//     the effective drag.
//
// The crosswind force: F = 0.5 × ρ × Cd × A × v_rel² × sin(θ)
//   - For small angles (sin θ ≈ θ): F ≈ 0.5 × ρ × Cd × A × v_rel × v_crosswind
//   - The bullet's acceleration: a = F / m = (0.5 × ρ × Cd × A / m) × v_rel × v_crosswind
//   - The coefficient (0.5 × ρ × Cd × A / m) is the wind sensitivity.
//
// We precompute the wind sensitivity per caliber + apply it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the wind acceleration (m/s²) on a bullet, given the bullet's
 * current velocity + the wind vector.
 *
 * @param bulletVel   Bullet velocity vector (m/s, world space).
 * @param wind        Wind vector (m/s, world space).
 * @param caliberSlug Caliber slug (for sensitivity).
 * @returns           Acceleration vector (m/s²) to apply to the bullet.
 */
export function computeWindAcceleration(
  bulletVel: { x: number; y: number; z: number },
  wind: WindVector,
  caliberSlug: string,
): { x: number; y: number; z: number } {
  const sensitivity = getCaliberWindSensitivity(caliberSlug);
  // Relative wind = wind - bulletVel (only the horizontal + vertical
  // components matter; the bullet's horizontal motion makes the wind
  // appear to come from the front, but the perpendicular component is
  // what pushes the bullet).
  const relU = wind.u; // wind u component (East-West)
  const relV = wind.v; // wind v component (North-South)
  const relW = wind.w; // vertical gust

  // Acceleration on the bullet = wind sensitivity × relative wind.
  // The constant 0.5 is from the drag formula; tuned for play-feel.
  const ACCEL_COEFF = 0.5;
  return {
    x: ACCEL_COEFF * sensitivity * relU,
    y: ACCEL_COEFF * sensitivity * relW * 0.3, // vertical gusts have less effect (bullet's spin resists)
    z: ACCEL_COEFF * sensitivity * relV,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Magnus force (spin drift in crosswind).
//
// A spinning bullet in a crosswind experiences a small vertical Magnus
// force. For a right-hand twist bullet + rightward crosswind, the force
// is upward (small lift). For a leftward crosswind, the force is downward.
//
// The Magnus force magnitude: F_mag = (8π/3) × ρ × r³ × ω × v_crosswind
//   - ρ = air density (1.225 kg/m³)
//   - r = bullet radius
//   - ω = spin rate (rad/s)
//   - v_crosswind = crosswind speed
//
// For a 5.56mm bullet at 250,000 rpm spin + 5 m/s crosswind: F_mag ≈ 0.02 N,
// producing a vertical drift of ~2 cm at 500m. Small but visible for snipers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the Magnus vertical acceleration (m/s²) on a spinning bullet in
 * a crosswind.
 *
 * @param spinRateRadPerSec  Bullet spin rate (rad/s). Positive = right-hand twist.
 * @param crosswindMps       Crosswind speed (m/s) — perpendicular to bullet.
 * @param caliberSlug        Caliber slug (for bullet radius).
 * @returns                  Vertical Magnus acceleration (m/s²). Positive = up.
 */
export function magnusVerticalAcceleration(
  spinRateRadPerSec: number,
  crosswindMps: number,
  caliberSlug: string,
): number {
  const caliber = getCaliber(caliberSlug);
  const r = caliber.bulletDiameterMm / 2 / 1000; // mm → m
  const rho = 1.225; // air density kg/m³
  // Magnus force coefficient: (8π/3) × ρ × r³
  const coeff = (8 * Math.PI / 3) * rho * r * r * r;
  // F_mag = coeff × ω × v_crosswind. Acceleration = F / m.
  const massKg = caliber.massGrams / 1000;
  if (massKg <= 0) return 0;
  const force = coeff * spinRateRadPerSec * crosswindMps;
  return force / massKg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level integration — apply advanced wind to a bullet for one tick.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply advanced wind to a projectile for one tick. Mutates the bullet's
 * velocity in-place (consistent with the existing integrateProjectile).
 *
 * This composes:
 *   - Crosswind + headwind/tailwind + vertical gust acceleration.
 *   - Magnus vertical acceleration (small lift/downdraft).
 *
 * The caller's existing drag + gravity integration runs AFTER this — wind
 * is a per-tick acceleration added on top.
 *
 * @param state    The bullet's wind state (velocity, position, spin).
 * @param wind     The wind vector at the bullet's current altitude.
 * @param dt       Tick duration (seconds).
 * @returns        The velocity delta to apply (m/s). The caller adds this
 *                 to the bullet's velocity.
 */
export function applyAdvancedWind(
  state: ProjectileWindState,
  wind: WindVector,
  dt: number,
): { dx: number; dy: number; dz: number } {
  // Compute the wind acceleration.
  const accel = computeWindAcceleration(state.velocity, wind, state.caliberSlug);

  // Compute the crosswind magnitude (for Magnus).
  const bulletSpeed = Math.sqrt(
    state.velocity.x * state.velocity.x +
    state.velocity.z * state.velocity.z,
  );
  let crosswindMps = 0;
  if (bulletSpeed > 0.1) {
    // Crosswind = wind component perpendicular to the bullet's horizontal velocity.
    const bulletDirX = state.velocity.x / bulletSpeed;
    const bulletDirZ = state.velocity.z / bulletSpeed;
    // Project wind onto bullet direction (parallel component).
    const parallel = wind.u * bulletDirX + wind.v * bulletDirZ;
    // Perpendicular = total wind - parallel.
    const perpU = wind.u - parallel * bulletDirX;
    const perpV = wind.v - parallel * bulletDirZ;
    crosswindMps = Math.sqrt(perpU * perpU + perpV * perpV);
  }

  // Magnus vertical acceleration.
  const magnusAccel = magnusVerticalAcceleration(
    state.spinRateRadPerSec, crosswindMps, state.caliberSlug,
  );

  // Total acceleration = wind + Magnus.
  const totalAccel = {
    x: accel.x,
    y: accel.y + magnusAccel,
    z: accel.z,
  };

  return {
    dx: totalAccel.x * dt,
    dy: totalAccel.y * dt,
    dz: totalAccel.z * dt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wind deflection lookup (HUD wind hold-off indicator).
//
// The HUD displays a "wind hold-off" indicator that tells the player how
// far to lead the target into the wind. The indicator is calibrated per
// caliber + wind speed + range.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the horizontal wind deflection (cm) at a given range for a given
 * crosswind. Uses the per-caliber wind drift table (from the caliber tables
 * module — windDriftCm at 4 m/s crosswind) + scales linearly.
 *
 * @param caliberSlug  Caliber slug.
 * @param rangeM       Target range (m).
 * @param crosswindMps Crosswind speed (m/s).
 * @returns            Wind deflection (cm, signed by wind direction).
 */
export function computeWindDeflection(
  caliberSlug: string,
  rangeM: number,
  crosswindMps: number,
): number {
  const caliber = getCaliber(caliberSlug);
  // Find the table row closest to the range.
  let driftAt4mps = 0;
  for (let i = 0; i < caliber.table.length; i++) {
    if (caliber.table[i].rangeM >= rangeM) {
      if (i === 0) {
        driftAt4mps = caliber.table[0].windDriftCm;
      } else {
        const a = caliber.table[i - 1];
        const b = caliber.table[i];
        const t = (rangeM - a.rangeM) / (b.rangeM - a.rangeM);
        driftAt4mps = a.windDriftCm + (b.windDriftCm - a.windDriftCm) * t;
      }
      break;
    }
    // If past the last row, use the last row.
    if (i === caliber.table.length - 1) {
      driftAt4mps = caliber.table[i].windDriftCm;
    }
  }
  // Scale linearly with wind speed (the 4 m/s reference).
  return driftAt4mps * (crosswindMps / 4);
}

/**
 * Compute the vertical wind deflection (cm) at a given range for a given
 * vertical wind (updraft/downdraft). Uses the same wind sensitivity as
 * horizontal but scaled down (vertical gusts have less effect).
 */
export function computeVerticalWindDeflection(
  caliberSlug: string,
  rangeM: number,
  verticalWindMps: number,
): number {
  // Vertical wind deflection = horizontal deflection × 0.3 (the bullet's
  // spin resists vertical perturbation).
  return computeWindDeflection(caliberSlug, rangeM, verticalWindMps) * 0.3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wind reading HUD helpers.
// ─────────────────────────────────────────────────────────────────────────────

export interface WindReadingHud {
  /** Wind speed (m/s) at the player's altitude. */
  windSpeedMps: number;
  /** Wind direction (compass bearing in degrees, 0 = N, 90 = E). */
  windDirectionDeg: number;
  /** Crosswind component (m/s) — perpendicular to the player's aim. */
  crosswindMps: number;
  /** Headwind component (m/s) — parallel to the player's aim (+ = headwind). */
  headwindMps: number;
  /** Horizontal deflection at the target's range (cm). */
  horizontalDeflectionCm: number;
  /** Vertical deflection at the target's range (cm). */
  verticalDeflectionCm: number;
  /** Recommended wind hold-off direction ("left" | "right" | "none"). */
  holdOffDirection: "left" | "right" | "none";
}

/**
 * Compute the wind reading HUD for the player's current shot. Used by the
 * HUD's wind hold-off indicator.
 *
 * @param caliberSlug   Caliber slug.
 * @param targetRangeM  Target range (m).
 * @param wind          Wind vector at the player's altitude.
 * @param aimDirection  Player's aim direction (horizontal, normalized).
 * @returns             Wind reading HUD data.
 */
export function computeWindReadingHud(
  caliberSlug: string,
  targetRangeM: number,
  wind: WindVector,
  aimDirection: { x: number; z: number },
): WindReadingHud {
  const windSpeed = Math.sqrt(wind.u * wind.u + wind.v * wind.v);
  // Compass bearing: 0 = N (+Z), 90 = E (+X). atan2(u, v) in degrees.
  const windDirectionDeg = (Math.atan2(wind.u, wind.v) * 180) / Math.PI;
  // Aim direction normalized.
  const aimMag = Math.sqrt(aimDirection.x * aimDirection.x + aimDirection.z * aimDirection.z);
  const aimX = aimMag > 0 ? aimDirection.x / aimMag : 0;
  const aimZ = aimMag > 0 ? aimDirection.z / aimMag : 0;
  // Wind components relative to aim direction.
  // Parallel = headwind (positive = wind in player's face).
  const parallel = wind.u * aimX + wind.v * aimZ;
  // Perpendicular = crosswind (rightward positive).
  const perpU = wind.u - parallel * aimX;
  const perpV = wind.v - parallel * aimZ;
  const crosswind = Math.sqrt(perpU * perpU + perpV * perpV);
  // Sign of crosswind: dot with right vector (perpendicular to aim, rightward).
  // Right vector = (aimZ, -aimX) (left-handed: aim × up = right).
  const rightX = aimZ;
  const rightZ = -aimX;
  const crosswindSign = (perpU * rightX + perpV * rightZ) >= 0 ? 1 : -1;

  const horizontalDeflectionCm = computeWindDeflection(caliberSlug, targetRangeM, crosswind * crosswindSign);
  const verticalDeflectionCm = computeVerticalWindDeflection(caliberSlug, targetRangeM, wind.w);

  return {
    windSpeedMps: windSpeed,
    windDirectionDeg,
    crosswindMps: crosswind,
    headwindMps: parallel,
    horizontalDeflectionCm,
    verticalDeflectionCm,
    holdOffDirection: crosswindSign > 0 ? "right" : crosswindSign < 0 ? "left" : "none",
  };
}
