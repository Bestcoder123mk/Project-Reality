/**
 * Section C — Grenade fragmentation pattern model.
 *
 * The existing GrenadeSystem handles the basic grenade types (frag, smoke,
 * flash, incendiary, decoy) with explosion radius + damage falloff. The
 * frag grenade's fragmentation is currently a simple radial damage falloff
 * — but real frag grenades produce 1000+ pre-fragmented shards that fly in
 * specific patterns (the casing's notches determine the fragment pattern).
 *
 * This module adds a per-grenade-type fragmentation pattern model:
 *
 *   1. FRAG GRENADE (M67):
 *      - Pre-fragmented casing produces ~1000 small steel shards.
 *      - Each shard has a velocity of ~1500 m/s at the casing.
 *      - The shard pattern is roughly spherical but with concentrated
 *        "lobes" along the casing's notch lines (4-8 lobes).
 *      - Lethal radius: 5m (90% incapacitation). Dangerous radius: 15m
 *        (50% incapacitation). Safe radius: 30m (mostly fragments have
 *        lost lethal velocity).
 *      - Fragments lose velocity fast due to their small mass (~0.1g each).
 *
 *   2. CONCUSSION GRENADE (M14):
 *      - No fragmentation — pure overpressure blast.
 *      - Lethal radius: 2m. Stun radius: 8m. Safe radius: 15m.
 *      - Damage falls off as 1/r³ (spherical blast wave).
 *
 *   3. INCENDIARY GRENADE (AN-M14):
 *      - Thermite mixture burns at 2200°C for 40s.
 *      - Lethal radius: 3m (direct flame). Burn radius: 5m (radiant heat).
 *      - Melts through engine blocks + light armor.
 *
 *   4. FLASHBANG (M84):
 *      - 1-2 million candela flash + 170 dB bang.
 *      - Stun radius: 5m (full effect). Disorient radius: 15m (reduced).
 *      - Duration: 5s (full), 10s (lingering).
 *
 *   5. SMOKE GRENADE (M18):
 *      - Burns 60-90s producing a colored smoke cloud.
 *      - Coverage radius: 8m. Cloud height: 15m. Obscures thermal too.
 *
 *   6. STICKY BOMB / SEMTEX:
 *      - Directional charge — concentrates blast in one direction.
 *      - Lethal cone: 60° half-angle, 10m range.
 *
 * The model:
 *   - Generates a per-grenade-type fragment pattern (deterministic given
 *     a seed).
 *   - Computes the lethal/dangerous/safe radius per type.
 *   - Computes the per-target damage based on distance + cover (fragments
 *     are blocked by hard cover).
 *   - Provides the VFX spawn parameters (fragment count, velocity, color)
 *     for the ParticleSystem.
 *
 * Tone reference: tactical-mil-sim-leaning-arcade. The fragment counts are
 * real (M67 = ~1000 fragments), but the fragment raycasting is simplified
 * (we sample 50-100 representative fragments instead of all 1000) for
 * performance.
 */

// Re-export the grenade type from GrenadeSystem for convenience.
export type GrenadeType = "frag" | "smoke" | "flash" | "incendiary" | "decoy" | "concussion" | "sticky";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GrenadeFragmentPattern {
  /** Grenade type. */
  type: GrenadeType;
  /** Total fragment count (real-world value). */
  totalFragmentCount: number;
  /** Sampled fragment count for raycasting (for performance). */
  sampledFragmentCount: number;
  /** Initial fragment velocity (m/s). */
  fragmentVelocityMps: number;
  /** Per-fragment mass (grams). */
  fragmentMassGrams: number;
  /** Cone half-angle (radians). π/2 = spherical, smaller = directional. */
  coneHalfAngleRad: number;
  /** Directionality axis (for directional grenades like sticky bomb).
   *  Null for spherical grenades. */
  directionAxis: { x: number; y: number; z: number } | null;
  /** Number of concentrated "lobes" in the fragment pattern (for frag). */
  lobeCount: number;
  /** Lobe concentration factor (0..1). Higher = more concentrated. */
  lobeConcentration: number;
  /** Lethal radius (m) — 90% incapacitation. */
  lethalRadiusM: number;
  /** Dangerous radius (m) — 50% incapacitation. */
  dangerousRadiusM: number;
  /** Safe radius (m) — fragments have lost lethal velocity. */
  safeRadiusM: number;
  /** Velocity falloff exponent — how fast fragments lose velocity. */
  velocityFalloffExponent: number;
}

export interface GrenadeFragment {
  /** Direction (normalized, world space). */
  dir: { x: number; y: number; z: number };
  /** Initial velocity (m/s). */
  velocityMps: number;
  /** Mass (grams). */
  massGrams: number;
  /** Range (m) before the fragment loses lethal velocity. */
  rangeM: number;
}

export interface GrenadeDamageResult {
  /** Damage to the target (HP). */
  damage: number;
  /** Number of fragments that hit the target. */
  fragmentHits: number;
  /** True if the target is in the lethal zone. */
  lethalZone: boolean;
  /** True if the target is in the dangerous zone. */
  dangerousZone: boolean;
  /** True if a hard surface blocked most fragments (cover). */
  blockedByCover: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-grenade-type fragmentation patterns.
//
// Real-world reference (US Army FM 3-23.30):
//   - M67 frag: 1000+ fragments, 5m lethal, 15m dangerous, 30m safe.
//   - M14 concussion: no fragments, 2m lethal, 8m stun, 15m safe.
//   - AN-M14 incendiary: thermite, 3m lethal, 5m burn, 10m safe.
//   - M84 flashbang: 5m full stun, 15m reduced, 30m safe.
//   - M18 smoke: 0 damage, 8m coverage, 0m safe (no damage).
//   - Sticky bomb: directional, 10m lethal cone, 30m safe.
// ─────────────────────────────────────────────────────────────────────────────

export const GRENADE_FRAGMENT_PATTERNS: Record<GrenadeType, GrenadeFragmentPattern> = {
  frag: {
    type: "frag",
    totalFragmentCount: 1000,
    sampledFragmentCount: 80, // sample 80 representative fragments for raycasting
    fragmentVelocityMps: 1500,
    fragmentMassGrams: 0.1,
    coneHalfAngleRad: Math.PI / 2, // spherical
    directionAxis: null,
    lobeCount: 6,
    lobeConcentration: 0.4,
    lethalRadiusM: 5.0,
    dangerousRadiusM: 15.0,
    safeRadiusM: 30.0,
    velocityFalloffExponent: 2.0, // fragments decelerate fast
  },
  concussion: {
    type: "concussion",
    totalFragmentCount: 0,
    sampledFragmentCount: 0,
    fragmentVelocityMps: 0,
    fragmentMassGrams: 0,
    coneHalfAngleRad: Math.PI / 2,
    directionAxis: null,
    lobeCount: 0,
    lobeConcentration: 0,
    lethalRadiusM: 2.0,
    dangerousRadiusM: 8.0,
    safeRadiusM: 15.0,
    velocityFalloffExponent: 3.0, // blast overpressure falls off fast
  },
  incendiary: {
    type: "incendiary",
    totalFragmentCount: 0, // no fragments — pure fire
    sampledFragmentCount: 0,
    fragmentVelocityMps: 0,
    fragmentMassGrams: 0,
    coneHalfAngleRad: Math.PI / 2,
    directionAxis: null,
    lobeCount: 0,
    lobeConcentration: 0,
    lethalRadiusM: 3.0,
    dangerousRadiusM: 5.0,
    safeRadiusM: 10.0,
    velocityFalloffExponent: 2.5,
  },
  flash: {
    type: "flash",
    totalFragmentCount: 0, // no fragments — pure flash + bang
    sampledFragmentCount: 0,
    fragmentVelocityMps: 0,
    fragmentMassGrams: 0,
    coneHalfAngleRad: Math.PI / 2,
    directionAxis: null,
    lobeCount: 0,
    lobeConcentration: 0,
    lethalRadiusM: 1.0, // only lethal at point-blank
    dangerousRadiusM: 5.0,
    safeRadiusM: 15.0,
    velocityFalloffExponent: 2.0,
  },
  smoke: {
    type: "smoke",
    totalFragmentCount: 0,
    sampledFragmentCount: 0,
    fragmentVelocityMps: 0,
    fragmentMassGrams: 0,
    coneHalfAngleRad: Math.PI / 2,
    directionAxis: null,
    lobeCount: 0,
    lobeConcentration: 0,
    lethalRadiusM: 0,
    dangerousRadiusM: 0,
    safeRadiusM: 0,
    velocityFalloffExponent: 0,
  },
  decoy: {
    type: "decoy",
    totalFragmentCount: 0,
    sampledFragmentCount: 0,
    fragmentVelocityMps: 0,
    fragmentMassGrams: 0,
    coneHalfAngleRad: Math.PI / 2,
    directionAxis: null,
    lobeCount: 0,
    lobeConcentration: 0,
    lethalRadiusM: 0,
    dangerousRadiusM: 0,
    safeRadiusM: 0,
    velocityFalloffExponent: 0,
  },
  sticky: {
    type: "sticky",
    totalFragmentCount: 200, // pre-fragmented plate
    sampledFragmentCount: 40,
    fragmentVelocityMps: 2000, // higher velocity (shaped charge)
    fragmentMassGrams: 0.5,
    coneHalfAngleRad: Math.PI / 3, // 60° directional cone
    directionAxis: { x: 0, y: 0, z: 1 }, // forward
    lobeCount: 1,
    lobeConcentration: 0.8,
    lethalRadiusM: 10.0,
    dangerousRadiusM: 15.0,
    safeRadiusM: 30.0,
    velocityFalloffExponent: 1.5,
  },
};

/** Get the fragment pattern for a grenade type. */
export function getGrenadeFragmentPattern(type: GrenadeType): GrenadeFragmentPattern {
  return GRENADE_FRAGMENT_PATTERNS[type] ?? GRENADE_FRAGMENT_PATTERNS.frag;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fragment generation.
//
// Generate the sampled fragment rays for a grenade explosion. Deterministic
// given (type, seed) so the server can validate the client's reported
// fragment hits.
// ─────────────────────────────────────────────────────────────────────────────

/** Mulberry32 PRNG for deterministic fragment generation. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate the sampled fragment rays for a grenade explosion.
 *
 * @param type      Grenade type.
 * @param seed      Random seed (for deterministic generation).
 * @returns         Array of fragment rays (in grenade-local space — the
 *                   caller transforms to world space using the grenade's
 *                   orientation).
 */
export function generateGrenadeFragments(
  type: GrenadeType,
  seed: number,
): GrenadeFragment[] {
  const pattern = getGrenadeFragmentPattern(type);
  if (pattern.sampledFragmentCount === 0) return [];
  const rng = makeRng(seed);
  const fragments: GrenadeFragment[] = [];

  for (let i = 0; i < pattern.sampledFragmentCount; i++) {
    let dir: { x: number; y: number; z: number };

    if (pattern.directionAxis) {
      // Directional grenade — concentrate fragments in a cone around the axis.
      const cosHalfAngle = Math.cos(pattern.coneHalfAngleRad);
      // Uniform sample on a spherical cap.
      const z = cosHalfAngle + rng() * (1 - cosHalfAngle);
      const theta = rng() * 2 * Math.PI;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      // Build local frame around the direction axis.
      const axis = pattern.directionAxis;
      const axisLen = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z);
      const normAxis = { x: axis.x / axisLen, y: axis.y / axisLen, z: axis.z / axisLen };
      // Pick an "up" vector not parallel to axis.
      const up = Math.abs(normAxis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      // right = axis × up
      const right = {
        x: normAxis.y * up.z - normAxis.z * up.y,
        y: normAxis.z * up.x - normAxis.x * up.z,
        z: normAxis.x * up.y - normAxis.y * up.x,
      };
      // Re-compute "true up" = right × axis
      const trueUp = {
        x: right.y * normAxis.z - right.z * normAxis.y,
        y: right.z * normAxis.x - right.x * normAxis.z,
        z: right.x * normAxis.y - right.y * normAxis.x,
      };
      // dir = z * axis + r*cos(theta) * right + r*sin(theta) * trueUp
      dir = {
        x: z * normAxis.x + r * Math.cos(theta) * right.x + r * Math.sin(theta) * trueUp.x,
        y: z * normAxis.y + r * Math.cos(theta) * right.y + r * Math.sin(theta) * trueUp.y,
        z: z * normAxis.z + r * Math.cos(theta) * right.z + r * Math.sin(theta) * trueUp.z,
      };
    } else if (pattern.lobeCount > 0) {
      // Spherical grenade with lobes (frag grenade). Concentrate fragments
      // along the lobe lines.
      const lobeIdx = i % pattern.lobeCount;
      const lobeAngle = (lobeIdx / pattern.lobeCount) * 2 * Math.PI;
      // Random direction in a sphere.
      const u = rng() * 2 - 1;
      const phi = rng() * 2 * Math.PI;
      const r = Math.sqrt(1 - u * u);
      dir = { x: r * Math.cos(phi), y: u, z: r * Math.sin(phi) };
      // Pull the direction toward the lobe angle (in the XZ plane).
      const lobeDir = { x: Math.cos(lobeAngle), y: 0, z: Math.sin(lobeAngle) };
      const concentration = pattern.lobeConcentration * rng();
      dir.x = dir.x * (1 - concentration) + lobeDir.x * concentration;
      dir.z = dir.z * (1 - concentration) + lobeDir.z * concentration;
      // Renormalize.
      const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
      dir = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    } else {
      // Uniform spherical distribution (default).
      const u = rng() * 2 - 1;
      const phi = rng() * 2 * Math.PI;
      const r = Math.sqrt(1 - u * u);
      dir = { x: r * Math.cos(phi), y: u, z: r * Math.sin(phi) };
    }

    // Per-fragment velocity varies ±10%.
    const velocityMult = 0.9 + 0.2 * rng();
    const velocity = pattern.fragmentVelocityMps * velocityMult;
    // Per-fragment range: where it loses lethal velocity. Scales with the
    // velocity falloff exponent + the initial velocity.
    const range = pattern.lethalRadiusM + (pattern.safeRadiusM - pattern.lethalRadiusM) * rng();

    fragments.push({
      dir,
      velocityMps: velocity,
      massGrams: pattern.fragmentMassGrams,
      rangeM: range,
    });
  }
  return fragments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Damage computation.
//
// Compute the damage to a target at a given distance from the grenade
// explosion, accounting for:
//   - Lethal / dangerous / safe radius per grenade type.
//   - Cover (hard surfaces between the grenade + target).
//   - Fragment count (sampled rays that hit the target).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the damage to a target at a given distance from a grenade explosion.
 *
 * @param type         Grenade type.
 * @param distanceM    Distance from the explosion to the target.
 * @param hasCover     True if a hard surface is between the grenade + target.
 * @returns            The damage result.
 */
export function computeGrenadeDamage(
  type: GrenadeType,
  distanceM: number,
  hasCover: boolean,
): GrenadeDamageResult {
  const pattern = getGrenadeFragmentPattern(type);

  // Cover blocks fragments but not blast overpressure. So:
  //   - Frag grenades: cover reduces damage to 10% (some fragments still penetrate).
  //   - Concussion grenades: cover has no effect (overpressure goes around).
  //   - Incendiary: cover blocks radiant heat (50% reduction).
  //   - Flash: cover blocks the flash completely (90% reduction).
  const coverMultByType: Record<GrenadeType, number> = {
    frag: 0.10,
    concussion: 1.00,
    incendiary: 0.50,
    flash: 0.10,
    smoke: 0,
    decoy: 0,
    sticky: 0.15,
  };
  const coverMult = hasCover ? (coverMultByType[type] ?? 1.0) : 1.0;

  // Base damage: 100 at the explosion center, falling off with distance.
  // The falloff depends on the grenade type + radius.
  let baseDamage = 0;
  if (distanceM <= pattern.lethalRadiusM) {
    // Lethal zone: 100 damage at center, 80 at the lethal radius edge.
    const t = distanceM / Math.max(0.1, pattern.lethalRadiusM);
    baseDamage = 100 - 20 * t;
  } else if (distanceM <= pattern.dangerousRadiusM) {
    // Dangerous zone: 80 damage at lethal edge, 30 at dangerous edge.
    const t = (distanceM - pattern.lethalRadiusM) / Math.max(0.1, pattern.dangerousRadiusM - pattern.lethalRadiusM);
    baseDamage = 80 - 50 * t;
  } else if (distanceM <= pattern.safeRadiusM) {
    // Safe zone: 30 damage at dangerous edge, 0 at safe edge.
    const t = (distanceM - pattern.dangerousRadiusM) / Math.max(0.1, pattern.safeRadiusM - pattern.dangerousRadiusM);
    baseDamage = 30 - 30 * t;
  } else {
    // Beyond safe radius — no damage.
    baseDamage = 0;
  }

  // Apply cover multiplier.
  const damage = baseDamage * coverMult;

  // Estimate fragment hits: at lethal radius, ~5-10 fragments hit; at dangerous, 1-3; at safe, 0-1.
  let fragmentHits = 0;
  if (type === "frag" || type === "sticky") {
    if (distanceM <= pattern.lethalRadiusM) {
      fragmentHits = Math.round(8 - 3 * (distanceM / pattern.lethalRadiusM));
    } else if (distanceM <= pattern.dangerousRadiusM) {
      fragmentHits = Math.round(3 - 2 * ((distanceM - pattern.lethalRadiusM) / pattern.dangerousRadiusM));
    } else if (distanceM <= pattern.safeRadiusM) {
      fragmentHits = Math.random() < 0.3 ? 1 : 0;
    }
    if (hasCover) fragmentHits = Math.round(fragmentHits * 0.1);
  }

  return {
    damage,
    fragmentHits,
    lethalZone: distanceM <= pattern.lethalRadiusM,
    dangerousZone: distanceM <= pattern.dangerousRadiusM,
    blockedByCover: hasCover && coverMult < 0.5,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cook time + fuse helpers.
//
// The existing GrenadeSystem handles cook time (COOK_FUSE_MS = fuse × 1000).
// This module exposes the per-type fuse values + a helper for the "cook to
// airburst" timing.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-type fuse length (seconds). */
export const GRENADE_FUSE_SEC: Record<GrenadeType, number> = {
  frag: 4.5,        // M67: 4-5s fuse
  concussion: 3.0,  // M14: 3-4s fuse
  incendiary: 1.5,  // AN-M14: 1.5-2s fuse (short — the thermite ignites fast)
  flash: 1.5,       // M84: 1.5s fuse
  smoke: 2.0,       // M18: 2-3s fuse
  decoy: 8.0,       // 8s (decoy fires shots for 5s after landing)
  sticky: 5.0,      // 5s fuse
};

/** Get the fuse length for a grenade type. */
export function getGrenadeFuseSec(type: GrenadeType): number {
  return GRENADE_FUSE_SEC[type] ?? 4.5;
}

/**
 * Compute the optimal cook time for an airburst grenade. The goal is to
 * detonate the grenade in the air, just before it hits the ground — this
 * maximizes fragment coverage on targets behind cover.
 *
 * For a grenade thrown 30m with a 1s flight time + 4.5s fuse, the optimal
 * cook time is 4.5 - 1.0 = 3.5s (cook for 3.5s, throw, grenade detonates
 * at the target).
 *
 * @param type         Grenade type.
 * @param flightTimeSec  Estimated flight time to the target.
 * @returns            Optimal cook time (seconds). Clamped to [0, fuse - 0.1].
 */
export function optimalCookTimeSec(type: GrenadeType, flightTimeSec: number): number {
  const fuse = getGrenadeFuseSec(type);
  return Math.max(0, Math.min(fuse - 0.1, fuse - flightTimeSec));
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounce + roll physics.
//
// The existing GrenadeSystem has bounce physics. This module adds per-
// surface bounce coefficients + a roll model for when the grenade lands
// on a flat surface.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-surface bounce coefficient (0..1). 0 = no bounce, 1 = perfect bounce. */
export const SURFACE_BOUNCE_COEFF: Record<string, number> = {
  concrete: 0.35,
  brick: 0.30,
  wood: 0.20,
  sheet_metal: 0.45,
  steel_plate: 0.55,
  sandbag: 0.05, // soft — absorbs impact
  earth: 0.10,
  water: 0.00, // splash, no bounce
  foliage: 0.15,
  glass: 0.25,
};

/** Get the bounce coefficient for a surface. Falls back to 0.3. */
export function getSurfaceBounceCoeff(surface: string): number {
  return SURFACE_BOUNCE_COEFF[surface] ?? 0.3;
}

/**
 * Compute the roll distance for a grenade landing on a flat surface.
 * The grenade rolls until friction stops it.
 *
 * @param landingVelocityMps  Velocity at landing (m/s).
 * @param surface             Surface slug.
 * @returns                   Roll distance (m).
 */
export function computeRollDistance(
  landingVelocityMps: number,
  surface: string,
): number {
  // Friction coefficient per surface.
  const frictionBySurface: Record<string, number> = {
    concrete: 0.4,
    wood: 0.5,
    sheet_metal: 0.3,
    sandbag: 1.0, // high friction — stops fast
    earth: 0.7,
    grass: 0.8,
  };
  const friction = frictionBySurface[surface] ?? 0.5;
  // Roll distance = v² / (2 × friction × g).
  const g = 9.81;
  return (landingVelocityMps * landingVelocityMps) / (2 * friction * g);
}

// ─────────────────────────────────────────────────────────────────────────────
// VFX spawn params (for ParticleSystem).
// ─────────────────────────────────────────────────────────────────────────────

export interface GrenadeVfxSpawnParams {
  /** Number of fragment particles to spawn. */
  fragmentParticleCount: number;
  /** Fragment particle initial velocity (m/s). */
  fragmentVelocityMps: number;
  /** Fragment particle color (hex). */
  fragmentColorHex: number;
  /** Explosion fireball size (m). 0 for non-explosive grenades. */
  fireballSizeM: number;
  /** Fireball color (hex). */
  fireballColorHex: number;
  /** Smoke cloud size (m). 0 for non-smoke grenades. */
  smokeSizeM: number;
  /** Smoke color (hex). */
  smokeColorHex: number;
  /** Flash intensity (0..1). For flashbangs. */
  flashIntensity: number;
}

/** Get the VFX spawn params for a grenade type. */
export function getGrenadeVfxParams(type: GrenadeType): GrenadeVfxSpawnParams {
  switch (type) {
    case "frag":
      return {
        fragmentParticleCount: 80,
        fragmentVelocityMps: 1500,
        fragmentColorHex: 0xa0a0a0,
        fireballSizeM: 1.5,
        fireballColorHex: 0xff8040,
        smokeSizeM: 0,
        smokeColorHex: 0x404040,
        flashIntensity: 0.3,
      };
    case "concussion":
      return {
        fragmentParticleCount: 0,
        fragmentVelocityMps: 0,
        fragmentColorHex: 0xffffff,
        fireballSizeM: 0.5,
        fireballColorHex: 0xffffa0,
        smokeSizeM: 0,
        smokeColorHex: 0x404040,
        flashIntensity: 0.5,
      };
    case "incendiary":
      return {
        fragmentParticleCount: 0,
        fragmentVelocityMps: 0,
        fragmentColorHex: 0xffffff,
        fireballSizeM: 3.0,
        fireballColorHex: 0xff4020,
        smokeSizeM: 2.0,
        smokeColorHex: 0x202020,
        flashIntensity: 0.7,
      };
    case "flash":
      return {
        fragmentParticleCount: 0,
        fragmentVelocityMps: 0,
        fragmentColorHex: 0xffffff,
        fireballSizeM: 1.0,
        fireballColorHex: 0xffffff,
        smokeSizeM: 0.5,
        smokeColorHex: 0x808080,
        flashIntensity: 1.0,
      };
    case "smoke":
      return {
        fragmentParticleCount: 0,
        fragmentVelocityMps: 0,
        fragmentColorHex: 0xffffff,
        fireballSizeM: 0,
        fireballColorHex: 0xffffff,
        smokeSizeM: 8.0,
        smokeColorHex: 0x808080,
        flashIntensity: 0,
      };
    case "decoy":
      return {
        fragmentParticleCount: 0,
        fragmentVelocityMps: 0,
        fragmentColorHex: 0xffffff,
        fireballSizeM: 0.2,
        fireballColorHex: 0xff8040,
        smokeSizeM: 0.5,
        smokeColorHex: 0x404040,
        flashIntensity: 0.1,
      };
    case "sticky":
      return {
        fragmentParticleCount: 40,
        fragmentVelocityMps: 2000,
        fragmentColorHex: 0xa0a0a0,
        fireballSizeM: 2.0,
        fireballColorHex: 0xff8040,
        smokeSizeM: 0,
        smokeColorHex: 0x404040,
        flashIntensity: 0.4,
      };
  }
}
