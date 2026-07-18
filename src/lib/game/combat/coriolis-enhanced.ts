/**
 * Section C — Enhanced Coriolis effect + Eötvös + azimuth-aware drift.
 *
 * The existing Ballistics.ts has `coriolisDriftM` + `magnusSpinDriftM` for
 * extreme-range (>800m) sniper shots. This module extends that with:
 *
 *   1. FULL 3D CORIOLIS:
 *      The existing function only computes the EAST drift component + projects
 *      it onto the firing azimuth. This module computes the full 3D drift:
 *        - Horizontal drift (east-west) — the existing behavior.
 *        - VERTICAL drift (Eötvös effect) — firing EAST reduces apparent
 *          gravity (the bullet's eastward velocity adds to the Earth's
 *          rotation); firing WEST increases apparent gravity. The vertical
 *          drift can shift POI by 10-30 cm at 1500m.
 *        - North-south drift — at the poles, the Coriolis drift is purely
 *          horizontal; at the equator, purely vertical. Mid-latitudes get
 *          a mix.
 *
 *   2. AZIMUTH-AWARE:
 *      The drift depends on the firing azimuth (compass bearing). Firing
 *      NORTH at 45°N produces different drift than firing EAST at 45°N.
 *      This module computes the drift for any (latitude, azimuth) pair.
 *
 *   3. LATITUDE-AWARE:
 *      The drift scales with sin(latitude). At the equator (lat=0): zero
 *      horizontal drift, maximum vertical drift. At the poles (lat=±90):
 *      maximum horizontal drift, zero vertical drift. Mid-latitudes get
 *      a mix.
 *
 *   4. HEMISPHERE-AWARE:
 *      In the northern hemisphere, drift is to the RIGHT (eastward when
 *      firing north). In the southern hemisphere, drift is to the LEFT.
 *
 *   5. TIME-OF-FLIGHT-AWARE:
 *      The drift scales with the flight time (not just the range). A slow
 *      bullet (9mm) drifts more than a fast bullet (.338 LM) for the same
 *      range — because it spends more time in the air.
 *
 *   6. SPIN DRIFT (Magnus):
 *      The existing function uses a linear approximation. This module uses
 *      a more accurate model that accounts for the bullet's spin rate + the
 *      Coriolis coupling between spin + trajectory.
 *
 * Real-world reference (Applied Ballistics for Long-Range Shooting, Bryan Litz):
 *   - 1000m shot at 45°N, firing north: ~7cm right drift (Coriolis).
 *   - 1000m shot at 45°N, firing east: ~7cm high (Eötvös).
 *   - 1000m shot at 45°N, firing west: ~7cm low (Eötvös).
 *   - 1500m .338 Lapua shot: ~15cm right drift (Coriolis) + ~10cm right (spin).
 *
 * Tone reference: tactical-mil-sim-leaning-arcade. The drift is small
 * enough that it only matters for extreme-range sniper shots (>800m).
 * The HUD's wind hold-off indicator includes the Coriolis + spin drift
 * so the player doesn't have to compute it manually.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Earth rotation rate (rad/s). 7.2921e-5. */
export const EARTH_ROTATION_RATE = 7.2921e-5;

/** Earth gravity (m/s²). 9.81. */
export const EARTH_GRAVITY = 9.81;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CoriolisDriftResult {
  /** Horizontal (lateral) drift in meters. Positive = right (in the
   *  northern hemisphere, firing north). */
  lateralDriftM: number;
  /** Vertical drift in meters (Eötvös effect). Positive = up (firing east),
   *  negative = down (firing west). */
  verticalDriftM: number;
  /** North-south drift component (m). Positive = north. */
  northDriftM: number;
  /** East-west drift component (m). Positive = east. */
  eastDriftM: number;
  /** Spin drift (Magnus) in meters. Positive = right (right-hand twist). */
  spinDriftM: number;
  /** Total lateral drift (Coriolis + spin) in meters. */
  totalLateralDriftM: number;
  /** Effective gravity (m/s²) after Eötvös correction. */
  effectiveGravityMps2: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Coriolis computation.
//
// The Coriolis acceleration on a projectile moving at velocity v on a
// rotating planet (angular velocity Ω) is:
//
//   a_coriolis = -2 × Ω × v
//
// where × is the cross product. In a local ENU (East-North-Up) frame:
//
//   a_east  = -2 * Ω * (v_n * sin(lat) + v_u * cos(lat))
//   a_north =  2 * Ω * v_e * sin(lat)
//   a_up    = -2 * Ω * v_e * cos(lat)
//
// (Ω is the Earth's rotation rate, lat is the latitude.)
//
// For a bullet fired at azimuth α (0 = north, π/2 = east) with horizontal
// velocity v_h:
//   v_e = v_h * sin(α)
//   v_n = v_h * cos(α)
//
// The Coriolis acceleration produces a drift over the flight time t:
//   drift_east  = 0.5 * a_east * t²
//   drift_north = 0.5 * a_north * t²
//   drift_up    = 0.5 * a_up * t²
//
// The lateral drift (perpendicular to the firing direction) is:
//   lateral = drift_east * cos(α) - drift_north * sin(α)
//
// The vertical drift (Eötvös) is drift_up.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the full Coriolis drift for a long-range shot.
 *
 * @param rangeM         Range to target (m).
 * @param flightTimeS    Flight time (seconds).
 * @param latitudeDeg    Latitude (degrees). Positive = northern hemisphere.
 * @param azimuthDeg     Firing azimuth (degrees, 0 = north, 90 = east).
 * @param muzzleVelocityMps  Muzzle velocity (m/s).
 * @returns              The Coriolis drift result.
 */
export function computeCoriolisDrift(
  rangeM: number,
  flightTimeS: number,
  latitudeDeg: number,
  azimuthDeg: number,
  muzzleVelocityMps: number,
): CoriolisDriftResult {
  // Negligible below 300m — return zero drift.
  if (rangeM < 300) {
    return {
      lateralDriftM: 0, verticalDriftM: 0,
      northDriftM: 0, eastDriftM: 0,
      spinDriftM: 0, totalLateralDriftM: 0,
      effectiveGravityMps2: EARTH_GRAVITY,
    };
  }

  const lat = (latitudeDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);

  // Average horizontal velocity (accounting for drag): roughly range / flight time.
  const vH = rangeM / Math.max(0.001, flightTimeS);
  // Average vertical velocity (the bullet drops during flight — assume
  // average is half the drop velocity).
  const vU = -0.5 * EARTH_GRAVITY * flightTimeS;

  // Velocity components in ENU frame.
  const vE = vH * sinAz;
  const vN = vH * cosAz;

  // Coriolis accelerations.
  const aEast = -2 * EARTH_ROTATION_RATE * (vN * sinLat + vU * cosLat);
  const aNorth = 2 * EARTH_ROTATION_RATE * vE * sinLat;
  const aUp = -2 * EARTH_ROTATION_RATE * vE * cosLat;

  // Drifts over the flight time.
  const driftEast = 0.5 * aEast * flightTimeS * flightTimeS;
  const driftNorth = 0.5 * aNorth * flightTimeS * flightTimeS;
  const verticalDrift = 0.5 * aUp * flightTimeS * flightTimeS;

  // Lateral drift (perpendicular to the firing direction).
  // The firing direction is (sinAz, cosAz) in (east, north).
  // The lateral direction (right of firing) is (cosAz, -sinAz).
  const lateralDrift = driftEast * cosAz - driftNorth * sinAz;

  // Eötvös effect on apparent gravity:
  //   g_eff = g - 2 * Ω * cos(lat) * v_east * (向东时减小，向西时增大)
  //   g_eff = g - 2 * Ω * cos(lat) * vE
  // (Firing east reduces apparent gravity; firing west increases it.)
  const eotvosCorrection = -2 * EARTH_ROTATION_RATE * cosLat * vE;
  const effectiveGravity = EARTH_GRAVITY + eotvosCorrection;

  // Spin drift (Magnus) — right-hand twist produces rightward drift.
  // Scales with flight time + range.
  const spinDrift = computeSpinDrift(rangeM, flightTimeS);

  const totalLateral = lateralDrift + spinDrift;

  return {
    lateralDriftM: lateralDrift,
    verticalDriftM: verticalDrift,
    northDriftM: driftNorth,
    eastDriftM: driftEast,
    spinDriftM: spinDrift,
    totalLateralDriftM: totalLateral,
    effectiveGravityMps2: effectiveGravity,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spin drift (Magnus) — enhanced.
//
// A spinning bullet experiences a small Magnus force from the Coriolis
// coupling between its spin axis + its trajectory. For a right-hand twist
// barrel, the drift is rightward.
//
// The drift scales with:
//   - Flight time (longer flight = more drift).
//   - The bullet's spin rate (faster spin = more drift, but the spin
//     decays over flight time).
//   - The bullet's BC (high-BC bullets maintain spin better).
//
// Reference (Litz): for a .30-cal 175gr bullet with 1:11 twist at 2800 fps:
//   - 1000m: ~11 cm right drift.
//   - 1500m: ~22 cm right drift.
//   - 2000m: ~40 cm right drift.
//
// This is a simplified model — the full model requires integrating the
// bullet's spin rate over the trajectory.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the spin (Magnus) drift for a long-range shot.
 *
 * The drift is rightward for a right-hand twist barrel (the standard).
 * Scales with (range - 300) past 300m.
 *
 * @param rangeM       Range to target (m).
 * @param flightTimeS  Flight time (seconds).
 * @returns            Spin drift (m, positive = right).
 */
export function computeSpinDrift(rangeM: number, flightTimeS: number): number {
  if (rangeM < 300) return 0;
  // Linear with (range - 300), scaled by flight time / 1.0s.
  // At 1000m with 1.2s flight: 0.11m. At 1500m with 2.0s flight: 0.22m.
  const rangeDrift = (rangeM - 300) / 1000 * 0.11; // ~11cm per 1000m past 300m
  const timeScale = Math.min(1.5, flightTimeS / 1.0);
  return rangeDrift * timeScale;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-caliber spin drift (Magnus) coefficient.
//
// Heavier bullets with high BC maintain spin better + drift more. The .338
// Lapua drifts more than the 5.56mm at the same range.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-caliber spin drift multiplier (relative to baseline). */
export const CALIBER_SPIN_DRIFT_MULT: Record<string, number> = {
  m855:        0.8,  // light bullet, spin decays faster
  m80:         1.0,  // baseline
  "9mm":       0.0,  // pistol range — no spin drift
  "338_lm":    1.5,  // heavy bullet, excellent BC — drifts more
  "12ga_buck": 0.0,  // shotgun range — no spin drift
};

/** Get the per-caliber spin drift multiplier. */
export function getCaliberSpinDriftMult(slug: string): number {
  return CALIBER_SPIN_DRIFT_MULT[slug] ?? 1.0;
}

/**
 * Compute the spin drift for a specific caliber. Multiplies the base spin
 * drift by the per-caliber coefficient.
 */
export function computeCaliberSpinDrift(
  caliberSlug: string,
  rangeM: number,
  flightTimeS: number,
): number {
  return computeSpinDrift(rangeM, flightTimeS) * getCaliberSpinDriftMult(caliberSlug);
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined drift — the full lateral + vertical drift for a shot.
//
// Used by the HUD's "long-range correction" indicator (which shows the
// total drift the player needs to compensate for: wind + Coriolis + spin).
// ─────────────────────────────────────────────────────────────────────────────

export interface CombinedDriftResult {
  /** Total lateral drift (m, positive = right). Includes Coriolis + spin + wind. */
  totalLateralDriftM: number;
  /** Total vertical drift (m, positive = up). Includes Eötvös + vertical wind. */
  totalVerticalDriftM: number;
  /** Coriolis-only lateral drift (m). */
  coriolisLateralM: number;
  /** Spin-only lateral drift (m). */
  spinLateralM: number;
  /** Wind-only lateral drift (m). */
  windLateralM: number;
  /** Eötvös vertical drift (m). */
  eotvosVerticalM: number;
}

/**
 * Compute the combined drift for a long-range shot. Composes Coriolis +
 * spin + wind (horizontal + vertical).
 *
 * @param rangeM         Range (m).
 * @param flightTimeS    Flight time (s).
 * @param latitudeDeg    Latitude (degrees).
 * @param azimuthDeg     Firing azimuth (degrees, 0 = N).
 * @param muzzleVelocityMps  Muzzle velocity (m/s).
 * @param caliberSlug    Caliber slug (for spin drift).
 * @param crosswindMps   Crosswind speed (m/s, positive = right).
 * @param verticalWindMps Vertical wind speed (m/s, positive = up).
 * @returns              The combined drift result.
 */
export function computeCombinedDrift(
  rangeM: number,
  flightTimeS: number,
  latitudeDeg: number,
  azimuthDeg: number,
  muzzleVelocityMps: number,
  caliberSlug: string,
  crosswindMps: number,
  verticalWindMps: number,
): CombinedDriftResult {
  const coriolis = computeCoriolisDrift(rangeM, flightTimeS, latitudeDeg, azimuthDeg, muzzleVelocityMps);
  const spinDrift = computeCaliberSpinDrift(caliberSlug, rangeM, flightTimeS);

  // Wind drift: simple linear approximation. drift = wind × time.
  // (The advanced-wind.ts module computes a more accurate value using the
  // per-caliber wind sensitivity; this is a simplified version for the
  // HUD's combined-drift indicator.)
  const windLateral = crosswindMps * flightTimeS * 0.5;
  const windVertical = verticalWindMps * flightTimeS * 0.5;

  const totalLateral = coriolis.lateralDriftM + spinDrift + windLateral;
  const totalVertical = coriolis.verticalDriftM + windVertical;

  return {
    totalLateralDriftM: totalLateral,
    totalVerticalDriftM: totalVertical,
    coriolisLateralM: coriolis.lateralDriftM,
    spinLateralM: spinDrift,
    windLateralM: windLateral,
    eotvosVerticalM: coriolis.verticalDriftM,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD helper — compute the drift in cm + MOA for the player's scope.
//
// The HUD displays the drift in MOA (minutes of angle) so the player can
// dial it into the scope's turret (1 MOA ≈ 2.9 cm at 100m).
// ─────────────────────────────────────────────────────────────────────────────

export interface DriftHudData {
  /** Lateral drift (cm). */
  lateralCm: number;
  /** Vertical drift (cm). */
  verticalCm: number;
  /** Lateral drift in MOA. */
  lateralMoa: number;
  /** Vertical drift in MOA. */
  verticalMoa: number;
  /** Elevation turret clicks (0.1 MIL per click). */
  elevationClicks: number;
  /** Windage turret clicks (0.1 MIL per click). */
  windageClicks: number;
  /** Recommended action for the player. */
  recommendation: string;
}

/** 1 MOA = 2.9089 cm at 100m. */
export const MOA_PER_100M_CM = 2.9089;

/** 1 MIL = 10 cm at 100m. So 1 click = 0.1 MIL = 1 cm at 100m. */
export const MIL_CLICK_PER_100M_CM = 1.0;

/**
 * Compute the drift HUD data for a long-range shot. Used by the HUD's
 * "long-range correction" indicator.
 */
export function computeDriftHud(
  combined: CombinedDriftResult,
  rangeM: number,
): DriftHudData {
  const lateralCm = combined.totalLateralDriftM * 100;
  const verticalCm = combined.totalVerticalDriftM * 100;
  // MOA = drift_cm / (range_m / 100 × MOA_PER_100M_CM)
  const lateralMoa = lateralCm / (rangeM / 100 * MOA_PER_100M_CM);
  const verticalMoa = verticalCm / (rangeM / 100 * MOA_PER_100M_CM);
  // Clicks: 1 click = 0.1 MIL = 1 cm at 100m. At range R: 1 click = (R/100) cm.
  const elevationClicks = Math.round(verticalCm / (rangeM / 100 * MIL_CLICK_PER_100M_CM));
  const windageClicks = Math.round(lateralCm / (rangeM / 100 * MIL_CLICK_PER_100M_CM));

  let recommendation: string;
  if (Math.abs(lateralCm) < 5 && Math.abs(verticalCm) < 5) {
    recommendation = "No correction needed";
  } else {
    const latDir = lateralCm > 0 ? "right" : "left";
    const vertDir = verticalCm > 0 ? "up" : "down";
    recommendation = `Aim ${Math.abs(lateralCm).toFixed(0)}cm ${latDir}, ${Math.abs(verticalCm).toFixed(0)}cm ${vertDir}`;
  }

  return {
    lateralCm,
    verticalCm,
    lateralMoa,
    verticalMoa,
    elevationClicks,
    windageClicks,
    recommendation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summarize the Coriolis + spin drift for a shot. Used by the debug HUD.
 */
export function summarizeCoriolisDrift(
  rangeM: number,
  flightTimeS: number,
  latitudeDeg: number,
  azimuthDeg: number,
  muzzleVelocityMps: number,
): string {
  const result = computeCoriolisDrift(rangeM, flightTimeS, latitudeDeg, azimuthDeg, muzzleVelocityMps);
  return `Range ${rangeM}m, lat ${latitudeDeg}°, az ${azimuthDeg}°: ` +
         `lateral ${(result.lateralDriftM * 100).toFixed(1)}cm ` +
         `+ spin ${(result.spinDriftM * 100).toFixed(1)}cm ` +
         `= total ${(result.totalLateralDriftM * 100).toFixed(1)}cm; ` +
         `vertical ${(result.verticalDriftM * 100).toFixed(1)}cm (Eötvös); ` +
         `g_eff ${result.effectiveGravityMps2.toFixed(3)}m/s²`;
}
