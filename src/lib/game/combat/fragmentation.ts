/**
 * Section C — Bullet fragmentation on hard surfaces.
 *
 * When a bullet strikes a hard surface (steel, concrete, glass) at high
 * velocity, it shatters into fragments that spray forward in a cone — a
 * key suppression source and a hazard to nearby friendlies. Each surface
 * material has a fragmentation threshold velocity (above which the bullet
 * frags) and a severity curve. Lower thresholds = frags more readily.
 */

/** Impact surface material classification. */
export type FragmentMaterial =
  | "steel" | "concrete" | "brick" | "glass" | "sheet_metal"
  | "wood" | "hard_armor" | "soft_armor" | "water" | "flesh";

/** Result of a fragmentation evaluation. */
export interface FragmentationResult {
  /** Whether the bullet fragmented at all. */
  fragmented: boolean;
  /** Number of significant fragments (≥0.1 g each). */
  fragmentCount: number;
  /** Cone half-angle of the fragment spray (radians). */
  coneHalfAngleRad: number;
  /** Total fragment mass as a fraction of bullet mass (0..1). */
  massFraction: number;
  /** Per-fragment kinetic energy (joules). */
  perFragmentEnergyJ: number;
  /** Tissue damage multiplier (≥1 if fragmented in flesh). */
  tissueDamageMult: number;
}

/** Per-material fragmentation profile. */
export interface MaterialFragmentProfile {
  /** Impact velocity above which fragmentation occurs (m/s). */
  thresholdMps: number;
  /** Cone half-angle of the spray (radians). */
  coneHalfAngleRad: number;
  /** Max mass fraction shed into fragments at full severity (0..1). */
  maxMassFraction: number;
  /** Max fragment count at full severity. */
  maxFragmentCount: number;
}

/** Real-world-ish fragmentation thresholds per surface material. */
export const MATERIAL_FRAG_PROFILES: Record<FragmentMaterial, MaterialFragmentProfile> = {
  steel:       { thresholdMps: 400, coneHalfAngleRad: 0.45, maxMassFraction: 0.70, maxFragmentCount: 8 },
  concrete:    { thresholdMps: 500, coneHalfAngleRad: 0.40, maxMassFraction: 0.55, maxFragmentCount: 6 },
  brick:       { thresholdMps: 550, coneHalfAngleRad: 0.38, maxMassFraction: 0.50, maxFragmentCount: 5 },
  glass:       { thresholdMps: 350, coneHalfAngleRad: 0.50, maxMassFraction: 0.40, maxFragmentCount: 10 },
  sheet_metal: { thresholdMps: 600, coneHalfAngleRad: 0.30, maxMassFraction: 0.35, maxFragmentCount: 4 },
  wood:        { thresholdMps: 700, coneHalfAngleRad: 0.25, maxMassFraction: 0.30, maxFragmentCount: 3 },
  hard_armor:  { thresholdMps: 450, coneHalfAngleRad: 0.42, maxMassFraction: 0.60, maxFragmentCount: 6 },
  soft_armor:  { thresholdMps: 900, coneHalfAngleRad: 0.20, maxMassFraction: 0.20, maxFragmentCount: 2 },
  water:       { thresholdMps: 1200,coneHalfAngleRad: 0.15, maxMassFraction: 0.10, maxFragmentCount: 2 },
  flesh:       { thresholdMps: 700, coneHalfAngleRad: 0.35, maxMassFraction: 0.55, maxFragmentCount: 4 },
};

/** Default bullet mass (grams) for the energy calculation. */
const DEFAULT_BULLET_MASS_G = 4.0; // ~M855 62gr

/**
 * Evaluate fragmentation for a bullet impact.
 *
 * @param velocity   Bullet impact velocity in m/s.
 * @param material   Surface material the bullet struck.
 * @param bulletMassGrams  Bullet mass in grams (default 4.0 = M855).
 */
export function computeFragmentation(
  velocity: number,
  material: FragmentMaterial | string,
  bulletMassGrams: number = DEFAULT_BULLET_MASS_G,
): FragmentationResult {
  const profile = MATERIAL_FRAG_PROFILES[material as FragmentMaterial] ??
    MATERIAL_FRAG_PROFILES.steel;

  const fragmented = velocity >= profile.thresholdMps;
  if (!fragmented) {
    return {
      fragmented: false,
      fragmentCount: 0,
      coneHalfAngleRad: 0,
      massFraction: 0,
      perFragmentEnergyJ: 0,
      tissueDamageMult: 1,
    };
  }

  // Severity ramps from threshold → 2× threshold (full fragmentation).
  const severity = Math.min(
    1,
    (velocity - profile.thresholdMps) / Math.max(1, profile.thresholdMps),
  );

  const fragmentCount = Math.max(
    1,
    Math.round(profile.maxFragmentCount * (0.5 + 0.5 * severity)),
  );
  const massFraction = Math.min(
    profile.maxMassFraction,
    profile.maxMassFraction * (0.4 + 0.6 * severity),
  );
  const coneHalfAngleRad = profile.coneHalfAngleRad * (0.7 + 0.3 * severity);

  // Per-fragment energy: total impact energy × massFraction / fragmentCount.
  const massKg = bulletMassGrams / 1000;
  const impactEnergyJ = 0.5 * massKg * velocity * velocity;
  const perFragmentEnergyJ = (impactEnergyJ * massFraction) / fragmentCount;

  const tissueDamageMult = material === "flesh" ? 1 + 0.6 * severity : 1;

  return {
    fragmented: true,
    fragmentCount,
    coneHalfAngleRad,
    massFraction,
    perFragmentEnergyJ,
    tissueDamageMult,
  };
}

/** Probability a fragment strikes a secondary target within `radiusM`. */
export function fragmentHitProbability(result: FragmentationResult, radiusM: number): number {
  if (!result.fragmented || radiusM <= 0) return 0;
  const coneArea = Math.PI * Math.tan(result.coneHalfAngleRad) ** 2 * 4; // at 1 m
  const targetArea = Math.PI * radiusM * radiusM;
  return Math.min(0.95, (targetArea / Math.max(coneArea, 0.1)) * result.fragmentCount * 0.5);
}
