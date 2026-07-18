/**
 * Section C — Hydrostatic shock + temporary wound cavity modeling.
 *
 * A high-velocity rifle bullet passing through soft tissue creates two
 * wound tracks: (1) the permanent crush cavity (the bullet's actual
 * path, ~bullet-diameter wide) and (2) the temporary stretch cavity —
 * tissue elastically displaced radially by the pressure pulse, reaching
 * 10–15× bullet diameter for high-energy rounds. Organs in the cavity
 * path suffer blunt trauma scaled by their susceptibility (liver/spleen
 * burst, lungs over-expand, brain hemorrhages).
 *
 * This module computes cavity dimensions + organ damage from caliber +
 * impact velocity + ammo type + primary organ, and the probability of
 * remote neural incapacitation ("hydrostatic shock" — contested in
 * forensics but a recognized game-design lever).
 * Tone: src/lib/game/DESIGN.md (tactical-mil-sim-leaning-arcade).
 */
import type { CaliberProfile } from "./caliber-tables";
import { getCaliber } from "./caliber-tables";
import type { OrganSlug } from "./organ-hitzones";

export type AmmoTypeSlug =
  | "fmj" | "hp" | "ap" | "subsonic" | "tracer" | "incendiary" | "frangible" | "soft_point";

/** Full wound-cavity computation result. */
export interface WoundCavityResult {
  /** Permanent crush cavity diameter (mm) — ~bullet diameter. */
  permanentCavityMm: number;
  /** Peak temporary stretch-cavity diameter (mm). */
  temporaryCavityMm: number;
  /** Cavity depth along the bullet path (mm). */
  cavityDepthMm: number;
  /** Tissue damage multiplier applied to base bullet damage (≥1). */
  tissueDamageMult: number;
  /** Total energy deposited in tissue (Joules). */
  energyDepositedJ: number;
  /** Organs destroyed (lethal/vital hit). */
  destroyedOrgans: OrganSlug[];
  /** Organs damaged (non-lethal but bleed/impair). */
  damagedOrgans: OrganSlug[];
  /** Probability of remote neural incapacitation (hydrostatic shock) 0..1. */
  remoteShockProb: number;
}

/** Per-caliber wound-cavity profile. */
export interface CaliberWoundCavityProfile {
  /** Multiplier on the temporary cavity diameter (caliber-specific yaw tendency). */
  cavityDiameterMult: number;
  /** Fraction of impact energy deposited in a 30cm tissue path (0..1). */
  energyDepositFraction: number;
  /** Yaw/fragment amplification factor on tissue damage. */
  tissueDamageMult: number;
  /** Remote-shock coefficient (higher = more neural trauma). */
  remoteShockCoeff: number;
}

/** Per-caliber wound-cavity profiles. */
export const CALIBER_WOUND_CAVITY_PROFILES: Record<string, CaliberWoundCavityProfile> = {
  m855:    { cavityDiameterMult: 1.4, energyDepositFraction: 0.45, tissueDamageMult: 1.5, remoteShockCoeff: 0.8 },
  m80:     { cavityDiameterMult: 1.2, energyDepositFraction: 0.55, tissueDamageMult: 1.3, remoteShockCoeff: 0.7 },
  "9mm":   { cavityDiameterMult: 0.8, energyDepositFraction: 0.30, tissueDamageMult: 1.0, remoteShockCoeff: 0.2 },
  "338_lm":{ cavityDiameterMult: 1.8, energyDepositFraction: 0.70, tissueDamageMult: 2.0, remoteShockCoeff: 1.2 },
  "12ga_buck":{ cavityDiameterMult: 2.0, energyDepositFraction: 0.85, tissueDamageMult: 1.8, remoteShockCoeff: 1.0 },
};

export function getCaliberWoundCavityProfile(slug: string): CaliberWoundCavityProfile {
  return CALIBER_WOUND_CAVITY_PROFILES[slug] ?? CALIBER_WOUND_CAVITY_PROFILES.m855;
}

/** Per-ammo-type modifier on wound-cavity behavior. */
export interface AmmoWoundCavityModifier {
  cavityDiameterMult: number;
  energyDepositFraction: number;
  tissueDamageMult: number;
  /** True if the round is designed to expand/fragment (no overpenetration). */
  expands: boolean;
}

export const AMMO_WOUND_CAVITY_MODIFIERS: Record<AmmoTypeSlug, AmmoWoundCavityModifier> = {
  fmj:        { cavityDiameterMult: 1.0, energyDepositFraction: 1.0, tissueDamageMult: 1.0, expands: false },
  hp:         { cavityDiameterMult: 1.8, energyDepositFraction: 1.6, tissueDamageMult: 1.6, expands: true },
  ap:         { cavityDiameterMult: 0.7, energyDepositFraction: 0.7, tissueDamageMult: 0.9, expands: false },
  subsonic:   { cavityDiameterMult: 0.8, energyDepositFraction: 1.1, tissueDamageMult: 0.9, expands: false },
  tracer:     { cavityDiameterMult: 1.0, energyDepositFraction: 1.0, tissueDamageMult: 1.0, expands: false },
  incendiary: { cavityDiameterMult: 1.3, energyDepositFraction: 1.3, tissueDamageMult: 1.4, expands: false },
  frangible:  { cavityDiameterMult: 1.5, energyDepositFraction: 1.8, tissueDamageMult: 1.5, expands: true },
  soft_point: { cavityDiameterMult: 1.6, energyDepositFraction: 1.4, tissueDamageMult: 1.5, expands: true },
};

export function getAmmoWoundCavityModifier(slug: AmmoTypeSlug): AmmoWoundCavityModifier {
  return AMMO_WOUND_CAVITY_MODIFIERS[slug] ?? AMMO_WOUND_CAVITY_MODIFIERS.fmj;
}

/** Organ susceptibility to stretch-cavity trauma (0..2). */
export const ORGAN_SUSCEPTIBILITY: Record<OrganSlug, number> = {
  none: 0.5, brain: 2.0, heart: 1.5, spine: 1.2,
  lung_l: 1.4, lung_r: 1.4, liver: 1.8, spleen: 1.8,
  kidney_l: 1.3, kidney_r: 1.3, stomach: 1.2,
  femoral_l: 1.0, femoral_r: 1.0,
};

export function getOrganSusceptibility(organ: OrganSlug): number {
  return ORGAN_SUSCEPTIBILITY[organ] ?? 0.5;
}

/**
 * Compute the full wound-cavity result for a tissue hit.
 *
 * @param caliberSlug Caliber key (e.g. "m855").
 * @param ammo Ammo construction type.
 * @param impactVelocityMps Bullet velocity at impact (m/s).
 * @param primaryOrgan The organ directly struck.
 * @param adjacentOrgans Organs within the temporary-cavity radius (radial trauma).
 */
export function computeWoundCavity(
  caliberSlug: string,
  ammo: AmmoTypeSlug,
  impactVelocityMps: number,
  primaryOrgan: OrganSlug,
  adjacentOrgans: OrganSlug[] = [],
): WoundCavityResult {
  const caliber: CaliberProfile = getCaliber(caliberSlug);
  const caliberProfile = getCaliberWoundCavityProfile(caliberSlug);
  const ammoMod = getAmmoWoundCavityModifier(ammo);

  const permanentCavityMm = caliber.bulletDiameterMm * (ammoMod.expands ? 1.8 : 1.0);
  // Temporary cavity scales with bullet energy and a caliber-specific yaw factor.
  const impactEnergyJ = 0.5 * (caliber.massGrams / 1000) * impactVelocityMps * impactVelocityMps;
  const tempBase = Math.sqrt(impactEnergyJ) * 0.55; // empirical scaling → ~50mm at 1600J
  const temporaryCavityMm = tempBase * caliberProfile.cavityDiameterMult * ammoMod.cavityDiameterMult;

  // Cavity depth: 30cm tissue path, scaled by energy deposit fraction.
  const cavityDepthMm = 300 * Math.min(1, caliberProfile.energyDepositFraction * ammoMod.energyDepositFraction);
  const energyDepositedJ = impactEnergyJ * Math.min(1, caliberProfile.energyDepositFraction * ammoMod.energyDepositFraction);

  const tissueDamageMult = caliberProfile.tissueDamageMult * ammoMod.tissueDamageMult * getOrganSusceptibility(primaryOrgan);

  // Organs destroyed if cavity exceeds their fragility threshold; damaged otherwise.
  const destroyedOrgans: OrganSlug[] = [];
  const damagedOrgans: OrganSlug[] = [];
  const destroyThresholdMm = 60;
  const damageThresholdMm = 25;
  const primarySuscept = getOrganSusceptibility(primaryOrgan);
  if (temporaryCavityMm * primarySuscept >= destroyThresholdMm) destroyedOrgans.push(primaryOrgan);
  else if (temporaryCavityMm * primarySuscept >= damageThresholdMm) damagedOrgans.push(primaryOrgan);
  for (const organ of adjacentOrgans) {
    const s = getOrganSusceptibility(organ);
    if (temporaryCavityMm * s >= destroyThresholdMm) destroyedOrgans.push(organ);
    else if (temporaryCavityMm * s >= damageThresholdMm) damagedOrgans.push(organ);
  }

  const remoteShockProb = remoteShockIncapacitationProb(caliberSlug, impactVelocityMps, primaryOrgan);

  return {
    permanentCavityMm, temporaryCavityMm, cavityDepthMm,
    tissueDamageMult, energyDepositedJ,
    destroyedOrgans, damagedOrgans, remoteShockProb,
  };
}

/**
 * Probability of remote neural incapacitation (the contested "hydrostatic
 * shock" effect — a high-energy hit to the torso causing rapid BP spike
 * to the brain). Scales with impact energy and falls off outside the
 * thoracic cavity.
 */
export function remoteShockIncapacitationProb(
  caliberSlug: string,
  impactVelocityMps: number,
  primaryOrgan: OrganSlug,
): number {
  const caliber = getCaliber(caliberSlug);
  const profile = getCaliberWoundCavityProfile(caliberSlug);
  const energyJ = 0.5 * (caliber.massGrams / 1000) * impactVelocityMps * impactVelocityMps;
  // Only thoracic/cranial hits produce remote shock.
  const thoracicHits: OrganSlug[] = ["heart", "lung_l", "lung_r", "liver", "spleen", "spine", "brain"];
  if (!thoracicHits.includes(primaryOrgan)) return 0;
  // Sigmoid centered at ~1500J with width ~800J, scaled by caliber coefficient.
  const x = (energyJ - 1500) / 800;
  const sigmoid = 1 / (1 + Math.exp(-x));
  return Math.min(0.75, sigmoid * profile.remoteShockCoeff * 0.6);
}

/** Human-readable summary for the gunsmith / debug HUD. */
export function summarizeWoundCavity(result: WoundCavityResult): string {
  return `perm ${result.permanentCavityMm.toFixed(1)}mm / temp ${result.temporaryCavityMm.toFixed(0)}mm / depth ${result.cavityDepthMm.toFixed(0)}mm / dmg×${result.tissueDamageMult.toFixed(2)} / shock ${(result.remoteShockProb * 100).toFixed(0)}%`;
}

/** Convenience: fetch the CaliberProfile for a cavity calc (used by tooling). */
export function getWoundCavityCaliber(caliberSlug: string): CaliberProfile {
  return getCaliber(caliberSlug);
}
