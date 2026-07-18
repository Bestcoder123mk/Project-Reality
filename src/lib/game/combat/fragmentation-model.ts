/**
 * Section C — Enhanced bullet fragmentation model.
 *
 * The existing combat/penetration.ts has a basic `computeFragmentation`
 * function that returns whether a rifle bullet fragments at high velocity.
 * This module extends that with a richer model covering:
 *
 *   1. PER-AMMO-TYPE FRAGMENTATION:
 *      - FMJ (M855): fragments at close range (yaw + break at the
 *        cannelure). Threshold: 700 m/s.
 *      - HP (Hollow Point): expands (not fragments) — creates a wide
 *        permanent wound cavity but doesn't produce secondary fragments.
 *      - AP (Armor Piercing): doesn't fragment (steel penetrator stays
 *        intact). Trades fragmentation for penetration.
 *      - Soft Point (SP): fragments like FMJ but with a wider cone.
 *      - Frangible: designed to fragment completely on hard surfaces
 *        (no overpenetration — used in CQB to avoid wallbangs).
 *
 *   2. PER-CALIBER FRAGMENTATION:
 *      - 5.56mm M855: fragments at 700-900 m/s (close range). Known for
 *        the "yaw + break" wound profile (Fackler ballistics).
 *      - 7.62mm M80: fragments less readily (heavier bullet, slower yaw).
 *        Threshold: 600 m/s.
 *      - 9mm: doesn't fragment (pistol velocities are too low for
 *        fragmentation, except for specially-designed fragmenting rounds).
 *      - .338 Lapua: doesn't fragment (solid copper-brass bullet for
 *        deep penetration at long range).
 *      - 12ga slug: fragments on hard surfaces (lead slug deforms + breaks).
 *
 *   3. FRAGMENTATION CONE:
 *      - The cone's half-angle + fragment count + range depend on the
 *        bullet's velocity at impact + the ammo type.
 *      - FMJ at 850 m/s: 6-10 fragments, 15° cone, 30cm range.
 *      - Frangible at 850 m/s: 30+ fragments, 45° cone, 10cm range.
 *
 *   4. SECONDARY DAMAGE:
 *      - Fragments deal damage to multiple organs in the cone.
 *      - The damage multiplier (1.0 = no extra, 1.5 = +50%) scales with
 *        the fragment count + their energy.
 *
 *   5. SURFACE-IMPACT FRAGMENTATION:
 *      - A bullet hitting a hard surface (concrete, steel) may fragment
 *        on impact (vs. penetrating or ricocheting). The fragments spray
 *        outward in a forward cone (spalling).
 *      - Spalling is dangerous to anyone behind thin armor — the fragments
 *        penetrate the armor + hit the target on the other side.
 *
 * Integration: WeaponSystem's raycast loop calls `computeBulletFragmentation`
 * on impact. The result's `extraDamageMult` is applied to the target; the
 * `fragmentCone` is used by ParticleSystem to spawn the fragment VFX.
 *
 * Tone reference: tactical-mil-sim-leaning-arcade. The model is grounded
 * in Fackler wound ballistics but tuned for play-feel — fragmentation
 * happens consistently at close range (not the unreliable 30% real-world
 * rate) so the player gets predictable close-range lethality.
 */

import type { CaliberProfile } from "./caliber-tables";
import { getCaliber } from "./caliber-tables";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AmmoTypeSlug = "fmj" | "hp" | "ap" | "subsonic" | "tracer" | "incendiary" | "frangible" | "soft_point";

export interface FragmentationResult {
  /** True if the bullet fragments on this impact. */
  fragments: boolean;
  /** Fragmentation mechanism. */
  mechanism: "yaw_break" | "expansion" | "spalling" | "frangible" | "none";
  /** Cone half-angle (radians). The fragments spread within this cone. */
  coneHalfAngleRad: number;
  /** Number of fragments. */
  fragmentCount: number;
  /** Extra damage multiplier applied within the cone (1.0 = no extra, 1.5 = +50%). */
  extraDamageMult: number;
  /** Range of the fragmentation cone (meters). */
  coneRangeM: number;
  /** Per-fragment mass (grams). */
  fragmentMassGrams: number;
  /** Per-fragment velocity (m/s). */
  fragmentVelocityMps: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-caliber fragmentation profiles.
//
// Real-world fragmentation data (Fackler + DEA wound ballistics studies):
//   - 5.56mm M855 at 850 m/s: 60-80% fragmentation rate (cannelure yaw).
//   - 5.56mm M855 at 700 m/s: ~30% fragmentation.
//   - 5.56mm M855 below 700 m/s: no fragmentation (bullet passes through intact).
//   - 7.62mm M80 at 760 m/s: ~40% fragmentation.
//   - 9mm at 360 m/s: 0% fragmentation (pistol velocities too low).
//   - .338 Lapua: 0% fragmentation (solid bullet design).
//   - 12ga slug on hard surface: 100% fragmentation (lead deforms + breaks).
// ─────────────────────────────────────────────────────────────────────────────

export interface CaliberFragmentationProfile {
  /** Caliber slug. */
  slug: string;
  /** Velocity above which fragmentation occurs (m/s). 0 = never fragments. */
  fragmentThresholdMps: number;
  /** Velocity above which fragmentation is guaranteed (m/s). */
  guaranteedFragmentMps: number;
  /** Cone half-angle at the fragmentation threshold (radians). */
  baseConeHalfAngleRad: number;
  /** Fragment count at the fragmentation threshold. */
  baseFragmentCount: number;
  /** Extra damage multiplier at the fragmentation threshold. */
  baseExtraDamageMult: number;
  /** Fragmentation cone range at the threshold (meters). */
  baseConeRangeM: number;
  /** Per-fragment mass at the threshold (grams). */
  baseFragmentMassGrams: number;
}

export const CALIBER_FRAGMENTATION_PROFILES: Record<string, CaliberFragmentationProfile> = {
  m855: {
    slug: "m855",
    fragmentThresholdMps: 700,
    guaranteedFragmentMps: 850,
    baseConeHalfAngleRad: Math.PI / 12, // 15°
    baseFragmentCount: 8,
    baseExtraDamageMult: 1.3,
    baseConeRangeM: 0.30,
    baseFragmentMassGrams: 0.5,
  },
  m80: {
    slug: "m80",
    fragmentThresholdMps: 600,
    guaranteedFragmentMps: 750,
    baseConeHalfAngleRad: Math.PI / 14, // ~13°
    baseFragmentCount: 6,
    baseExtraDamageMult: 1.25,
    baseConeRangeM: 0.35,
    baseFragmentMassGrams: 1.0,
  },
  "9mm": {
    slug: "9mm",
    fragmentThresholdMps: 0, // never fragments (pistol velocities too low)
    guaranteedFragmentMps: 0,
    baseConeHalfAngleRad: 0,
    baseFragmentCount: 0,
    baseExtraDamageMult: 1.0,
    baseConeRangeM: 0,
    baseFragmentMassGrams: 0,
  },
  "338_lm": {
    slug: "338_lm",
    fragmentThresholdMps: 0, // solid bullet — no fragmentation
    guaranteedFragmentMps: 0,
    baseConeHalfAngleRad: 0,
    baseFragmentCount: 0,
    baseExtraDamageMult: 1.0,
    baseConeRangeM: 0,
    baseFragmentMassGrams: 0,
  },
  "12ga_buck": {
    slug: "12ga_buck",
    fragmentThresholdMps: 0, // pellets already separate — no further fragmentation
    guaranteedFragmentMps: 0,
    baseConeHalfAngleRad: 0,
    baseFragmentCount: 0,
    baseExtraDamageMult: 1.0,
    baseConeRangeM: 0,
    baseFragmentMassGrams: 0,
  },
};

/** Get the fragmentation profile for a caliber. Falls back to no-fragmentation. */
export function getCaliberFragmentationProfile(slug: string): CaliberFragmentationProfile {
  return CALIBER_FRAGMENTATION_PROFILES[slug] ?? CALIBER_FRAGMENTATION_PROFILES["9mm"];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-ammo-type fragmentation modifiers.
// ─────────────────────────────────────────────────────────────────────────────

export interface AmmoFragmentationModifier {
  /** Multiplier on the fragmentation threshold (1.0 = no change). Higher = harder to fragment. */
  thresholdMult: number;
  /** Multiplier on the fragment count. */
  fragmentCountMult: number;
  /** Multiplier on the cone half-angle. */
  coneAngleMult: number;
  /** Multiplier on the extra damage. */
  extraDamageMult: number;
  /** Multiplier on the cone range. */
  coneRangeMult: number;
  /** Fragmentation mechanism. */
  mechanism: FragmentationResult["mechanism"];
}

export const AMMO_FRAGMENTATION_MODIFIERS: Record<AmmoTypeSlug, AmmoFragmentationModifier> = {
  fmj: {
    thresholdMult: 1.0,
    fragmentCountMult: 1.0,
    coneAngleMult: 1.0,
    extraDamageMult: 1.0,
    coneRangeMult: 1.0,
    mechanism: "yaw_break",
  },
  hp: {
    // Hollow point: expands (no fragmentation, but creates a wide permanent cavity).
    // Modeled as a single "fragment" with a large cone (expansion).
    thresholdMult: 0.5, // expands at lower velocity than FMJ fragments
    fragmentCountMult: 0.2, // "fewer fragments" (it's actually one expanded bullet)
    coneAngleMult: 2.5, // very wide cone (expansion)
    extraDamageMult: 1.6, // more damage (energy dump)
    coneRangeMult: 0.5, // shorter range (energy dumps close)
    mechanism: "expansion",
  },
  ap: {
    // Armor piercing: doesn't fragment (steel penetrator stays intact).
    thresholdMult: Infinity, // never fragments
    fragmentCountMult: 0,
    coneAngleMult: 0,
    extraDamageMult: 0.9, // slightly less damage (no fragmentation benefit)
    coneRangeMult: 0,
    mechanism: "none",
  },
  subsonic: {
    // Subsonic: low velocity — doesn't fragment.
    thresholdMult: Infinity,
    fragmentCountMult: 0,
    coneAngleMult: 0,
    extraDamageMult: 0.85,
    coneRangeMult: 0,
    mechanism: "none",
  },
  tracer: {
    // Tracer: fragments like FMJ (the tracer compound doesn't significantly affect fragmentation).
    thresholdMult: 1.0,
    fragmentCountMult: 1.0,
    coneAngleMult: 1.0,
    extraDamageMult: 1.0,
    coneRangeMult: 1.0,
    mechanism: "yaw_break",
  },
  incendiary: {
    // Incendiary: fragments + adds incendiary effect (the bullet ignites on impact).
    thresholdMult: 0.8,
    fragmentCountMult: 1.5,
    coneAngleMult: 1.3,
    extraDamageMult: 1.4,
    coneRangeMult: 1.2,
    mechanism: "yaw_break",
  },
  frangible: {
    // Frangible: designed to fragment completely on hard surfaces.
    // 30+ tiny fragments, very wide cone, very short range.
    thresholdMult: 0.3, // fragments at very low velocity
    fragmentCountMult: 4.0,
    coneAngleMult: 3.0,
    extraDamageMult: 1.7,
    coneRangeMult: 0.3,
    mechanism: "frangible",
  },
  soft_point: {
    // Soft point: expands + fragments (a hybrid of HP + FMJ).
    thresholdMult: 0.7,
    fragmentCountMult: 1.3,
    coneAngleMult: 1.5,
    extraDamageMult: 1.45,
    coneRangeMult: 0.7,
    mechanism: "yaw_break",
  },
};

/** Get the ammo fragmentation modifier. Falls back to FMJ. */
export function getAmmoFragmentationModifier(slug: AmmoTypeSlug): AmmoFragmentationModifier {
  return AMMO_FRAGMENTATION_MODIFIERS[slug] ?? AMMO_FRAGMENTATION_MODIFIERS.fmj;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core fragmentation computation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the bullet's fragmentation behavior on impact with a soft target.
 *
 * @param impactVelocityMps  Bullet velocity at impact (m/s).
 * @param caliberSlug        Caliber slug.
 * @param ammoType           Ammo type slug.
 * @returns                  The fragmentation result. `fragments=false` if
 *                            the bullet doesn't fragment.
 */
export function computeBulletFragmentation(
  impactVelocityMps: number,
  caliberSlug: string,
  ammoType: AmmoTypeSlug,
): FragmentationResult {
  const emptyResult: FragmentationResult = {
    fragments: false, mechanism: "none",
    coneHalfAngleRad: 0, fragmentCount: 0, extraDamageMult: 1.0,
    coneRangeM: 0, fragmentMassGrams: 0, fragmentVelocityMps: 0,
  };

  const caliberProfile = getCaliberFragmentationProfile(caliberSlug);
  const ammoMod = getAmmoFragmentationModifier(ammoType);

  // Apply ammo modifier to threshold.
  const effectiveThreshold = caliberProfile.fragmentThresholdMps * ammoMod.thresholdMult;
  if (!isFinite(effectiveThreshold) || impactVelocityMps < effectiveThreshold) {
    return emptyResult;
  }

  // Scale factor: 0 at threshold, 1 at guaranteed-fragment velocity.
  const guaranteed = caliberProfile.guaranteedFragmentMps * ammoMod.thresholdMult;
  const t = guaranteed > effectiveThreshold
    ? Math.min(1, (impactVelocityMps - effectiveThreshold) / (guaranteed - effectiveThreshold))
    : 1;

  // Scale the fragmentation params by t (more velocity = more fragments, wider cone, etc.).
  const fragmentCount = Math.round(
    caliberProfile.baseFragmentCount * ammoMod.fragmentCountMult * (0.5 + 0.5 * t),
  );
  const coneHalfAngleRad = caliberProfile.baseConeHalfAngleRad * ammoMod.coneAngleMult * (0.7 + 0.3 * t);
  const extraDamageMult = 1.0 + (caliberProfile.baseExtraDamageMult - 1.0) * ammoMod.extraDamageMult * (0.5 + 0.5 * t);
  const coneRangeM = caliberProfile.baseConeRangeM * ammoMod.coneRangeMult * (0.8 + 0.2 * t);
  const fragmentMassGrams = caliberProfile.baseFragmentMassGrams / Math.max(1, fragmentCount);
  // Fragments retain ~50% of the bullet's impact velocity.
  const fragmentVelocityMps = impactVelocityMps * 0.5;

  return {
    fragments: true,
    mechanism: ammoMod.mechanism,
    coneHalfAngleRad,
    fragmentCount,
    extraDamageMult,
    coneRangeM,
    fragmentMassGrams,
    fragmentVelocityMps,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Surface-impact fragmentation (spalling).
//
// A bullet hitting a HARD surface (concrete, steel) may fragment on impact
// instead of penetrating or ricocheting. The fragments spray forward in a
// cone (spalling). This is dangerous to anyone behind thin armor.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the spalling behavior when a bullet hits a hard surface.
 *
 * @param impactVelocityMps  Bullet velocity at impact (m/s).
 * @param caliberSlug        Caliber slug.
 * @param surfaceSlug        Surface slug (e.g. "concrete", "steel_plate").
 * @returns                  The spalling result. `fragments=false` if the
 *                            bullet embeds / ricochets without spalling.
 */
export function computeSurfaceSpalling(
  impactVelocityMps: number,
  caliberSlug: string,
  surfaceSlug: string,
): FragmentationResult {
  const emptyResult: FragmentationResult = {
    fragments: false, mechanism: "none",
    coneHalfAngleRad: 0, fragmentCount: 0, extraDamageMult: 1.0,
    coneRangeM: 0, fragmentMassGrams: 0, fragmentVelocityMps: 0,
  };

  // Spalling happens on hard surfaces: concrete, brick, steel, sheet metal.
  const spallingSurfaces = new Set(["concrete", "brick", "steel_plate", "sheet_metal"]);
  if (!spallingSurfaces.has(surfaceSlug)) {
    return emptyResult;
  }

  // Velocity threshold for spalling. Higher for harder surfaces.
  const thresholdBySurface: Record<string, number> = {
    concrete: 400,
    brick: 350,
    steel_plate: 600,
    sheet_metal: 300,
  };
  const threshold = thresholdBySurface[surfaceSlug] ?? 500;
  if (impactVelocityMps < threshold) {
    return emptyResult;
  }

  // Scale the spall by velocity + surface hardness.
  const t = Math.min(1, (impactVelocityMps - threshold) / 400);
  // Steel produces the most + sharpest spall (the bullet shatters).
  // Concrete produces less + softer spall (concrete dust + small chunks).
  const surfaceSpallMult: Record<string, number> = {
    steel_plate: 1.5,
    sheet_metal: 0.8,
    concrete: 0.7,
    brick: 0.6,
  };
  const mult = surfaceSpallMult[surfaceSlug] ?? 1.0;

  const fragmentCount = Math.round((6 + 6 * t) * mult);
  const coneHalfAngleRad = Math.PI / 8 * (0.7 + 0.3 * t); // ~22° at full spall
  const extraDamageMult = 1.0 + 0.3 * t * mult;
  const coneRangeM = 0.5 + 0.5 * t;
  const fragmentMassGrams = 0.2;
  const fragmentVelocityMps = impactVelocityMps * 0.3; // spall fragments are slower

  return {
    fragments: true,
    mechanism: "spalling",
    coneHalfAngleRad,
    fragmentCount,
    extraDamageMult,
    coneRangeM,
    fragmentMassGrams,
    fragmentVelocityMps,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fragment cone geometry (for ParticleSystem + damage application).
//
// The fragment cone is centered on the bullet's direction at impact, with
// a half-angle + range. Each fragment is a ray within the cone.
// ─────────────────────────────────────────────────────────────────────────────

export interface FragmentRay {
  /** Direction (normalized, world space). */
  dir: { x: number; y: number; z: number };
  /** Range (meters). */
  rangeM: number;
  /** Damage multiplier (per-fragment). */
  damageMult: number;
}

/**
 * Generate the fragment rays for a fragmentation event. Each ray is a
 * random direction within the cone. Used by:
 *   - ParticleSystem to spawn the fragment VFX.
 *   - WeaponSystem to apply fragment damage to any enemy in the cone.
 */
export function generateFragmentRays(
  fragmentation: FragmentationResult,
  bulletDir: { x: number; y: number; z: number },
): FragmentRay[] {
  if (!fragmentation.fragments || fragmentation.fragmentCount === 0) return [];

  const rays: FragmentRay[] = [];
  const cosHalfAngle = Math.cos(fragmentation.coneHalfAngleRad);
  const dirLen = Math.sqrt(bulletDir.x * bulletDir.x + bulletDir.y * bulletDir.y + bulletDir.z * bulletDir.z);
  const dir = {
    x: bulletDir.x / Math.max(1e-6, dirLen),
    y: bulletDir.y / Math.max(1e-6, dirLen),
    z: bulletDir.z / Math.max(1e-6, dirLen),
  };

  // Per-fragment damage: total extra damage / fragment count.
  const perFragmentDamageMult = (fragmentation.extraDamageMult - 1.0) / Math.max(1, fragmentation.fragmentCount);

  for (let i = 0; i < fragmentation.fragmentCount; i++) {
    // Random direction within the cone. Use a uniform spherical cap sample.
    const z = cosHalfAngle + Math.random() * (1 - cosHalfAngle);
    const theta = Math.random() * 2 * Math.PI;
    const r = Math.sqrt(1 - z * z);
    // Build a local frame around `dir`. For simplicity, perturb the
    // direction + renormalize (gives a slightly biased distribution but
    // is fast + good enough for game purposes).
    const perturbation = Math.sqrt(1 - z * z) * 0.5; // scale by r for cone shape
    const px = r * Math.cos(theta) * perturbation;
    const py = r * Math.sin(theta) * perturbation;
    const pz = z;
    // Rotate the perturbation to be aligned with `dir` (simplified — just
    // add perturbation to dir + renormalize).
    const newDir = {
      x: dir.x + px,
      y: dir.y + py,
      z: dir.z + pz - 1 + z, // shift to keep dir as the cone axis
    };
    const len = Math.sqrt(newDir.x * newDir.x + newDir.y * newDir.y + newDir.z * newDir.z);
    rays.push({
      dir: {
        x: newDir.x / Math.max(1e-6, len),
        y: newDir.y / Math.max(1e-6, len),
        z: newDir.z / Math.max(1e-6, len),
      },
      rangeM: fragmentation.coneRangeM * (0.7 + 0.3 * Math.random()),
      damageMult: perFragmentDamageMult,
    });
    // Suppress unused var warnings.
    void r;
    void theta;
  }
  return rays;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick lookup: does this caliber+ammo combination fragment at this velocity?
// ─────────────────────────────────────────────────────────────────────────────

/** Quick check: does the bullet fragment at this velocity? */
export function doesFragment(
  impactVelocityMps: number,
  caliberSlug: string,
  ammoType: AmmoTypeSlug,
): boolean {
  return computeBulletFragmentation(impactVelocityMps, caliberSlug, ammoType).fragments;
}

/** Get the caliber profile for a fragmentation event (for diagnostics). */
export function getFragmentationCaliber(caliberSlug: string): CaliberProfile {
  return getCaliber(caliberSlug);
}
