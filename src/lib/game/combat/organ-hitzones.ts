/**
 * Section C — Anatomical organ hit zones with damage multipliers.
 *
 * Coarse zoning (head / chest / limb) is refined into anatomically-placed
 * organ hitboxes (brain, heart, lungs, liver, stomach, limbs, etc.). Each
 * organ carries a damage multiplier, bleed rate, and incapacitation flag
 * consumed by the damage model. Coordinates are in body-local cm: origin at
 * the crown, +Y down (toward feet), +X to subject's left, +Z forward.
 */

/** Coarse body zone (mirrors the base HitZone enum). */
export type BodyZone = "head" | "chest" | "abdomen" | "limb";

/** Organ slug — `flesh` is the fallback for non-vital hits. */
export type OrganSlug =
  | "flesh" | "brain" | "heart" | "lung" | "liver"
  | "stomach" | "spine" | "femoral" | "kidney";

/** Gameplay + anatomical data for one organ. */
export interface OrganHitZone {
  slug: OrganSlug;
  label: string;
  coarseZone: BodyZone;
  /** Damage multiplier vs. a baseline chest hit (1.0). */
  damageMult: number;
  /** Blood loss per second while wounded (HP/s). */
  bleedRateHpPerS: number;
  /** Instant incapacitation (drops the target in <1 s). */
  instantIncapacitate: boolean;
}

/** Per-organ gameplay stats keyed by slug. */
export const ORGAN_STATS: Record<OrganSlug, OrganHitZone> = {
  flesh:   { slug: "flesh",   label: "Muscle/Flesh",      coarseZone: "limb",     damageMult: 0.85, bleedRateHpPerS: 1.5,  instantIncapacitate: false },
  brain:   { slug: "brain",   label: "Brain",             coarseZone: "head",     damageMult: 8.0,  bleedRateHpPerS: 0.0,  instantIncapacitate: true  },
  heart:   { slug: "heart",   label: "Heart",             coarseZone: "chest",    damageMult: 10.0, bleedRateHpPerS: 25.0, instantIncapacitate: true  },
  lung:    { slug: "lung",    label: "Lung",              coarseZone: "chest",    damageMult: 2.0,  bleedRateHpPerS: 6.0,  instantIncapacitate: false },
  liver:   { slug: "liver",   label: "Liver",             coarseZone: "abdomen",  damageMult: 3.0,  bleedRateHpPerS: 10.0, instantIncapacitate: false },
  stomach: { slug: "stomach", label: "Stomach/Gut",       coarseZone: "abdomen",  damageMult: 1.5,  bleedRateHpPerS: 5.0,  instantIncapacitate: false },
  spine:   { slug: "spine",   label: "Spine",             coarseZone: "chest",    damageMult: 5.0,  bleedRateHpPerS: 4.0,  instantIncapacitate: true  },
  femoral: { slug: "femoral", label: "Femoral Artery",    coarseZone: "limb",     damageMult: 1.2,  bleedRateHpPerS: 20.0, instantIncapacitate: false },
  kidney:  { slug: "kidney",  label: "Kidney",            coarseZone: "abdomen",  damageMult: 2.5,  bleedRateHpPerS: 8.0,  instantIncapacitate: false },
};

/** Axis-aligned hitbox in body-local cm (origin = crown, +Y down). */
export interface OrganHitbox {
  organ: OrganSlug;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Organ hitboxes for a standing 175 cm adult (anterior view).
 * Coordinates approximate Gray's Anatomy proportions.
 */
export const ORGAN_HITBOXES: OrganHitbox[] = [
  { organ: "brain",   min: { x: -8,  y: 0,   z: -8 },  max: { x:  8, y: 18,  z:  8 } },
  { organ: "heart",   min: { x: -4,  y: 78,  z: -2 },  max: { x:  6, y: 96,  z:  8 } },
  { organ: "lung",    min: { x: -10, y: 70,  z: -8 },  max: { x: 10, y: 100, z:  6 } },
  { organ: "liver",   min: { x: -10, y: 95,  z: -6 },  max: { x:  2, y: 115, z:  6 } },
  { organ: "stomach", min: { x: -8,  y: 108, z: -6 },  max: { x:  8, y: 135, z:  6 } },
  { organ: "spine",   min: { x: -2,  y: 30,  z: -10 }, max: { x:  2, y: 140, z: -7 } },
  { organ: "kidney",  min: { x: -7,  y: 100, z: -10 }, max: { x:  7, y: 115, z: -7 } },
  { organ: "femoral", min: { x: -4,  y: 148, z: -3 },  max: { x:  4, y: 175, z:  3 } },
];

/** Priority order: most lethal organs tested first. */
const PRIORITY: OrganSlug[] = ["brain", "heart", "spine", "lung", "liver", "kidney", "stomach", "femoral"];

/** Classify which organ (if any) a body-local hit point lies inside. */
export function classifyOrganHit(p: { x: number; y: number; z: number }): OrganHitZone {
  for (const slug of PRIORITY) {
    const box = ORGAN_HITBOXES.find((b) => b.organ === slug);
    if (!box) continue;
    if (p.x >= box.min.x && p.x <= box.max.x &&
        p.y >= box.min.y && p.y <= box.max.y &&
        p.z >= box.min.z && p.z <= box.max.z) {
      return ORGAN_STATS[slug];
    }
  }
  return ORGAN_STATS.flesh;
}

/** Apply an organ's damage multiplier to a base damage value. */
export function applyOrganDamage(organ: OrganHitZone, baseDamage: number): number {
  return baseDamage * organ.damageMult;
}
