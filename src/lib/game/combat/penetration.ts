/**
 * SEC5-COMBAT — Prompt 45: Ballistic penetration tuning (per-surface).
 *
 * The existing realism.ts `computePenetration(velocity, material)` computes
 * residual velocity using density × thickness × caliberK math. That's good
 * physics but it's hidden from the designer — tuning "how far does a rifle
 * round penetrate a wood wall" requires editing the density or thickness of
 * the wood material, which then ripples into the impact VFX colour, the
 * ricochet probability, etc. Penetration DEPTH + DAMAGE FALLOFF should be
 * first-class designer knobs.
 *
 * This module adds a per-surface `MATERIAL_PENETRATION` table keyed by the
 * 10 material slugs in realism.ts (drywall, wood, sheet_metal, brick,
 * sandbag, glass, foliage, earth, concrete, steel_plate). Each entry has:
 *
 *   - `penetrationDepthM` — how many meters a rifle round penetrates before
 *     stopping. Wood = 0.30m (penetrates a stud wall + the guy behind it);
 *     concrete = 0.08m (stops in the wall); steel_plate = 0 (deflects).
 *   - `damageFalloff` — multiplier applied to bullet damage after exiting the
 *     surface. Wood = 0.7 (30% lost to splintering); concrete = 0.4 (60%
 *     lost to fragmentation); sheet_metal = 0.5; glass = 0.95 (almost none).
 *   - `velocityFalloff` — multiplier applied to bullet velocity after exit.
 *     Used by the WeaponSystem raycast loop (in addition to the realism.ts
 *     density-based falloff).
 *   - `tell` — visual + audio cue shown to the player when the bullet passes
 *     through. Wood = "wood chip puff + soft thud"; concrete = "dust puff +
 *     sharp crack"; sheet_metal = "spark shower + metallic ping". The audio
 *     system reads this for the surface-aware impact layer; the VFX system
 *     reads this for the particle effect.
 *
 * The existing `computePenetration(velocity, material)` in realism.ts continues
 * to handle the physics math (density × thickness); this module adds the
 * designer-facing knobs that layer on top. The two functions compose:
 *
 *   const physicsResult = computePenetration(velocity, material);
 *   const surfaceResult = getPenetration(material.slug);
 *   const finalVelocity = physicsResult.velocity * surfaceResult.velocityFalloff;
 *   const finalDamage  = baseDamage * surfaceResult.damageFalloff;
 *
 * The orchestrator wires this into WeaponSystem's penetration raycast loop
 * (one-liner — see "Wiring Notes" at the bottom).
 *
 * Tone reference: see src/lib/game/DESIGN.md (tactical-mil-sim-leaning-arcade).
 * Per-surface penetration is a core mil-sim-leaning-arcade feature — the
 * player should learn that "you can shoot through wood, not through concrete".
 */

// ─────────────────────────────────────────────────────────────────────────────
// Material penetration table
// ─────────────────────────────────────────────────────────────────────────────

/** Visual + audio cue shown when a bullet penetrates a surface. */
export interface PenetrationTell {
  /** Short label for the gunsmith / debug HUD. */
  label: string;
  /** Visual effect slug (consumed by ParticleSystem.spawnImpact). */
  vfxSlug: string;
  /** Audio cue slug (consumed by AudioEngine — surface-aware impact). */
  audioSlug: string;
  /** One-line description for the designer. */
  description: string;
}

export interface MaterialPenetrationEntry {
  /** Material slug (matches realism.ts DEFAULT_MATERIALS). */
  slug: string;
  /** Human-readable name. */
  name: string;
  /** Penetration depth in meters for a rifle round (5.56/7.62).
   *  Pistol rounds penetrate ~50% of this; shotgun pellets ~20%; sniper ~130%. */
  penetrationDepthM: number;
  /** Damage multiplier after exit (0..1). Lower = more damage lost to the surface. */
  damageFalloff: number;
  /** Velocity multiplier after exit (0..1). Layered on top of the realism.ts
   *  density-based falloff. */
  velocityFalloff: number;
  /** Visual + audio tell for the player. */
  tell: PenetrationTell;
}

/**
 * Per-surface penetration table. Tuned for tactical-mil-sim-leaning-arcade:
 *
 *   - Soft surfaces (drywall, foliage, glass) — high penetration, low falloff.
 *     The player learns they can shoot through drywall + glass.
 *   - Wood — moderate penetration. A stud wall will let a rifle round through
 *     but cost 30% damage — enough to wound, not enough to clean-kill.
 *   - Sheet metal — low penetration, high damage falloff. Cars are cover but
 *     not safe cover.
 *   - Brick + concrete — very low penetration. The intended hard cover.
 *   - Sandbag + earth — bullet-trap materials (military sandbag wall stops
 *     rifle rounds). Zero penetration depth.
 *   - Steel plate — impenetrable (matches `bulletStop: true` in realism.ts).
 */
export const MATERIAL_PENETRATION: Record<string, MaterialPenetrationEntry> = {
  drywall: {
    slug: "drywall", name: "Drywall",
    penetrationDepthM: 0.40,
    damageFalloff: 0.85,
    velocityFalloff: 0.85,
    tell: { label: "Chalky puff", vfxSlug: "puff_chalk", audioSlug: "impact_drywall", description: "Chalky white dust puff + soft thud. Penetrates easily." },
  },
  wood: {
    slug: "wood", name: "Wood",
    penetrationDepthM: 0.30,
    damageFalloff: 0.70,
    velocityFalloff: 0.75,
    tell: { label: "Wood chip puff", vfxSlug: "puff_wood", audioSlug: "impact_wood", description: "Wood chip spray + soft thud. Penetrates a stud wall." },
  },
  sheet_metal: {
    slug: "sheet_metal", name: "Sheet Metal",
    penetrationDepthM: 0.12,
    damageFalloff: 0.50,
    velocityFalloff: 0.55,
    tell: { label: "Spark shower", vfxSlug: "sparks_metal", audioSlug: "impact_metal_ping", description: "Bright spark shower + metallic ping. Cars are cover, not safety." },
  },
  brick: {
    slug: "brick", name: "Brick",
    penetrationDepthM: 0.10,
    damageFalloff: 0.40,
    velocityFalloff: 0.40,
    tell: { label: "Brick dust puff", vfxSlug: "puff_brick", audioSlug: "impact_brick", description: "Red brick dust puff + sharp crack. Mostly stops rifle rounds." },
  },
  sandbag: {
    slug: "sandbag", name: "Sandbag",
    penetrationDepthM: 0.02,
    damageFalloff: 0.05,
    velocityFalloff: 0.05,
    tell: { label: "Sand burst", vfxSlug: "puff_sand", audioSlug: "impact_sandbag", description: "Sand burst + dull thud. Military sandbag wall — bullet trap." },
  },
  glass: {
    slug: "glass", name: "Glass",
    penetrationDepthM: 0.50,
    damageFalloff: 0.95,
    velocityFalloff: 0.95,
    tell: { label: "Glass shatter", vfxSlug: "shatter_glass", audioSlug: "impact_glass_shatter", description: "Cascading glass shards + bright tinkle. Penetrates almost clean." },
  },
  foliage: {
    slug: "foliage", name: "Foliage",
    penetrationDepthM: 0.80,
    damageFalloff: 0.98,
    velocityFalloff: 0.98,
    tell: { label: "Leaf rustle", vfxSlug: "rustle_leaf", audioSlug: "impact_foliage", description: "Leaf rustle + soft swish. Effectively no resistance." },
  },
  earth: {
    slug: "earth", name: "Earth",
    penetrationDepthM: 0.05,
    damageFalloff: 0.10,
    velocityFalloff: 0.10,
    tell: { label: "Dirt burst", vfxSlug: "puff_dirt", audioSlug: "impact_earth", description: "Dirt burst + dull thud. Stops rifle rounds quickly." },
  },
  concrete: {
    slug: "concrete", name: "Concrete",
    penetrationDepthM: 0.08,
    damageFalloff: 0.35,
    velocityFalloff: 0.35,
    tell: { label: "Concrete dust", vfxSlug: "puff_concrete", audioSlug: "impact_concrete", description: "Grey concrete dust + sharp crack. Hard cover — stops most rounds." },
  },
  steel_plate: {
    slug: "steel_plate", name: "Steel Plate",
    penetrationDepthM: 0.00,
    damageFalloff: 0.00,
    velocityFalloff: 0.00,
    tell: { label: "Spark shower + ricochet", vfxSlug: "sparks_steel", audioSlug: "impact_steel_ricochet", description: "Bright spark shower + sharp metallic ricochet. Impenetrable." },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Accessors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the penetration properties for a surface. Falls back to concrete (the
 * default hard surface) if the slug isn't recognised.
 */
export function getPenetration(surface: string): MaterialPenetrationEntry {
  return MATERIAL_PENETRATION[surface] ?? MATERIAL_PENETRATION.concrete;
}

/**
 * Get the visual + audio tell for a penetrating hit on a surface. Convenience
 * wrapper around `getPenetration(surface).tell`.
 */
export function penetrationTell(surface: string): PenetrationTell {
  return getPenetration(surface).tell;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-category penetration multipliers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-weapon-category penetration multiplier. Snipers penetrate ~130% of the
 * rifle baseline (heavy round, high velocity); pistols penetrate ~50%;
 * shotgun pellets ~20%; SMG ~70%; LMG ~110% (heavy belt-fed round).
 *
 * Applied to `MaterialPenetrationEntry.penetrationDepthM` to get the actual
 * penetration depth for a given weapon category + surface combination.
 */
export const CATEGORY_PENETRATION_MULT: Record<string, number> = {
  RIFLE: 1.00,
  SMG: 0.70,
  PISTOL: 0.50,
  SNIPER: 1.30,
  SHOTGUN: 0.10,
  LMG: 1.10,
};

/**
 * Compute the effective penetration depth for a (surface, weaponCategory) pair.
 * Returns meters. Zero means the bullet doesn't penetrate (e.g. shotgun pellet
 * on concrete).
 */
export function effectivePenetrationDepth(surface: string, weaponCategory: string): number {
  const base = getPenetration(surface).penetrationDepthM;
  const mult = CATEGORY_PENETRATION_MULT[weaponCategory] ?? 1.0;
  return base * mult;
}

/**
 * Compute the effective damage falloff for a (surface, weaponCategory) pair.
 * Heavier rounds lose less damage to a given surface — sniper rounds keep
 * more of their energy through wood than pistol rounds do.
 *
 * The falloff multiplier is `damageFalloff * categoryRetainMult`, where
 * categoryRetainMult is 1.0 for rifles, 1.05 for snipers/LMGs (heavier
 * rounds), 0.95 for SMGs, 0.90 for pistols, 0.80 for shotguns.
 */
export function effectiveDamageFalloff(surface: string, weaponCategory: string): number {
  const base = getPenetration(surface).damageFalloff;
  if (base === 0) return 0; // steel plate
  const retainMult: Record<string, number> = {
    RIFLE: 1.00, SMG: 0.95, PISTOL: 0.90, SNIPER: 1.05, SHOTGUN: 0.80, LMG: 1.05,
  };
  const mult = retainMult[weaponCategory] ?? 1.0;
  return Math.min(1, base * mult);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B — Prompts 167–171: penetration depth, deflection, fragmentation,
// overpenetration, hollow-point vs FMJ.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 167 — expanded material penetration table.
 *
 * The base MATERIAL_PENETRATION table covers 10 surfaces. The spec calls for
 * "concrete, brick, wood, drywall, glass, metal, sandbag, water, foliage" —
 * these are all in the base table. This extension adds the spec's
 * maxPenetrationDepth + exitVelocityMult + deflectionAngle fields as a typed
 * view layered on top of the existing data so existing callers continue to
 * work. New callers (the Section B penetration raycast) read this richer view.
 */
export interface RichMaterialPenetration {
  slug: string;
  name: string;
  /** Max penetration depth for a rifle round (m). Pistol = 0.5×, sniper = 1.3×. */
  maxPenetrationDepthM: number;
  /** Exit velocity multiplier (0..1) — residual velocity after passing through. */
  exitVelocityMult: number;
  /** Angle (radians) at which a bullet hitting the surface starts to deflect
   *  instead of penetrating. The spec calls for >60° from normal → deflect. */
  deflectionAngleRad: number;
  /** Damage falloff (0..1) — multiplier on bullet damage after exit. */
  damageFalloff: number;
}

/** Prompt 167 — angle (radians) from surface normal above which deflection occurs.
 *  60° from normal = π/3 (≈1.047 rad). */
export const DEFLECTION_ANGLE_RAD = Math.PI / 3;

/**
 * Prompt 167 — rich per-surface penetration data. Combines the base
 * MATERIAL_PENETRATION data with explicit max-penetration-depth, exit-velocity,
 * and deflection-angle fields per the spec.
 */
export const RICH_MATERIAL_PENETRATION: Record<string, RichMaterialPenetration> = {
  concrete:   { slug: "concrete",   name: "Concrete",     maxPenetrationDepthM: 0.08, exitVelocityMult: 0.35, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.35 },
  brick:      { slug: "brick",      name: "Brick",        maxPenetrationDepthM: 0.10, exitVelocityMult: 0.40, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.40 },
  wood:       { slug: "wood",       name: "Wood",         maxPenetrationDepthM: 0.30, exitVelocityMult: 0.75, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.70 },
  drywall:    { slug: "drywall",    name: "Drywall",      maxPenetrationDepthM: 0.40, exitVelocityMult: 0.85, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.85 },
  glass:      { slug: "glass",      name: "Glass",        maxPenetrationDepthM: 0.50, exitVelocityMult: 0.95, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.95 },
  sheet_metal:{ slug: "sheet_metal",name: "Sheet Metal",  maxPenetrationDepthM: 0.12, exitVelocityMult: 0.55, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.50 },
  steel_plate:{ slug: "steel_plate",name: "Steel Plate",  maxPenetrationDepthM: 0.00, exitVelocityMult: 0.00, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.00 },
  sandbag:    { slug: "sandbag",    name: "Sandbag",      maxPenetrationDepthM: 0.02, exitVelocityMult: 0.05, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.05 },
  earth:      { slug: "earth",      name: "Earth",        maxPenetrationDepthM: 0.05, exitVelocityMult: 0.10, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.10 },
  foliage:    { slug: "foliage",    name: "Foliage",      maxPenetrationDepthM: 0.80, exitVelocityMult: 0.98, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.98 },
  water:      { slug: "water",      name: "Water",        maxPenetrationDepthM: 1.20, exitVelocityMult: 0.30, deflectionAngleRad: DEFLECTION_ANGLE_RAD, damageFalloff: 0.30 },
};

/** Prompt 167 — accessor for the rich penetration data (falls back to concrete). */
export function getRichPenetration(surface: string): RichMaterialPenetration {
  return RICH_MATERIAL_PENETRATION[surface] ?? RICH_MATERIAL_PENETRATION.concrete;
}

/**
 * Prompt 168 — should a bullet deflect (ricochet-like) instead of penetrating?
 *
 * Returns true if the angle between the bullet's direction and the surface
 * normal is greater than DEFLECTION_ANGLE_RAD (60°). The bullet is hitting
 * the surface at a shallow angle (close to grazing) — it should ricochet
 * rather than penetrate straight through.
 *
 * `dotBulletNormal` is the dot product of the bullet direction (normalized,
 * pointing INTO the surface) and the surface outward normal. If the dot is
 * positive the bullet is traveling AWAY from the surface (defensive guard).
 * Negative dots close to 0 mean grazing (shallow angle); dots close to -1
 * mean head-on (perpendicular).
 *
 * Deflect when |dot| < cos(DEFLECTION_ANGLE_RAD) = cos(60°) = 0.5.
 */
export function shouldDeflectOnAngle(dotBulletNormal: number): boolean {
  // |dot| < cos(60°) = 0.5 → grazing angle.
  // Bullet is traveling into the surface (dot < 0) at a shallow angle.
  return dotBulletNormal > -0.5 && dotBulletNormal < 0;
}

/**
 * Prompt 168 — compute the deflection direction for a shallow-angle hit.
 *
 * Reflects the bullet direction across the surface normal, with a small
 * random jitter so the ricochet isn't a perfect mirror bounce. Returns the
 * new direction (normalized) + the residual velocity multiplier.
 *
 * The caller passes the bullet direction + surface normal as plain vectors
 * (arrays). The reflection formula is `r = d - 2 * (d · n) * n`.
 */
export function deflectBulletDirection(
  bulletDir: { x: number; y: number; z: number },
  surfaceNormal: { x: number; y: number; z: number },
): { x: number; y: number; z: number; exitVelocityMult: number } {
  const dot = bulletDir.x * surfaceNormal.x + bulletDir.y * surfaceNormal.y + bulletDir.z * surfaceNormal.z;
  const rx = bulletDir.x - 2 * dot * surfaceNormal.x;
  const ry = bulletDir.y - 2 * dot * surfaceNormal.y;
  const rz = bulletDir.z - 2 * dot * surfaceNormal.z;
  // Add ±5% jitter so the ricochet isn't a perfect mirror bounce.
  const j = 0.05;
  const jx = (Math.random() - 0.5) * j;
  const jy = (Math.random() - 0.5) * j;
  const jz = (Math.random() - 0.5) * j;
  // Normalize.
  const len = Math.sqrt((rx + jx) ** 2 + (ry + jy) ** 2 + (rz + jz) ** 2) || 1;
  // Residual velocity after deflection — 40% of the incoming velocity (the
  // rest is absorbed by the surface).
  return {
    x: (rx + jx) / len,
    y: (ry + jy) / len,
    z: (rz + jz) / len,
    exitVelocityMult: 0.4,
  };
}

/**
 * Prompt 169 — bullet fragmentation on high-velocity impact.
 *
 * 5.56mm at close range (velocity > 700 m/s) fragments on impact — the bullet
 * yaws + breaks, dumping extra energy into the target. The fragmentation
 * cone is a narrow cone (±15°) of secondary fragments that deal extra damage
 * in a small radius behind the impact point.
 *
 * Returns null if the bullet doesn't fragment (low velocity, no fragmentation
 * for this ammo type). Otherwise returns the fragmentation parameters.
 */
export interface FragmentationResult {
  /** Cone half-angle (radians). The fragments spread within this cone. */
  coneHalfAngleRad: number;
  /** Number of fragments. */
  fragmentCount: number;
  /** Extra damage multiplier applied within the cone (1.0 = no extra, 1.5 = +50%). */
  extraDamageMult: number;
  /** Range of the fragmentation cone (meters). */
  coneRangeM: number;
}

/** Prompt 169 — fragment if velocity > threshold + the bullet type can fragment. */
export function computeFragmentation(
  impactVelocity: number,
  ammoTypeSlug: string,
  weaponCategory: string,
): FragmentationResult | null {
  // 5.56mm RIFLE rounds fragment at close range (high velocity). Other
  // categories don't fragment (pistol/SMG/sniper are designed NOT to fragment
  // per the Hague Convention — though snipers sometimes use fragmenting rounds).
  if (weaponCategory !== "RIFLE" && weaponCategory !== "LMG") return null;
  if (ammoTypeSlug === "hp" || ammoTypeSlug === "ap") return null; // HP expands, AP doesn't fragment
  // Fragment only above 700 m/s (typical 5.56 fragmentation threshold).
  if (impactVelocity < 700) return null;
  // Extra damage scales with velocity above the threshold (more velocity = more fragmentation).
  const overVelocity = Math.min(1, (impactVelocity - 700) / 200); // 0..1 from 700..900 m/s
  return {
    coneHalfAngleRad: Math.PI / 12, // 15°
    fragmentCount: Math.round(4 + overVelocity * 6), // 4–10 fragments
    extraDamageMult: 1.2 + 0.3 * overVelocity, // 1.2×–1.5×
    coneRangeM: 0.5, // fragments travel 0.5m into the target
  };
}

/**
 * Prompt 170 — overpenetration on soft targets.
 *
 * A rifle round through a thin enemy should continue with reduced velocity
 * and can hit a second target. This function computes the post-target state:
 * whether the bullet continues + its residual velocity + damage multiplier.
 *
 * The thin-enemy model: an enemy is treated as a "soft target" with an
 * effective thickness of 0.3m. Heavy rounds (rifle, sniper, LMG) penetrate
 * through; light rounds (pistol, SMG, shotgun) stop.
 */
export function overpenetrationAfterSoftTarget(
  weaponCategory: string,
  impactVelocity: number,
  ammoTypeSlug: string,
): { continues: boolean; residualVelocityMult: number; residualDamageMult: number } {
  // HP rounds stop at the first surface (per spec).
  if (ammoTypeSlug === "hp") {
    return { continues: false, residualVelocityMult: 0, residualDamageMult: 0 };
  }
  // Heavy rounds penetrate through soft targets.
  if (weaponCategory === "RIFLE" || weaponCategory === "SNIPER" || weaponCategory === "LMG") {
    return {
      continues: true,
      residualVelocityMult: 0.6, // 60% of impact velocity continues
      residualDamageMult: 0.5,   // 50% damage to the second target
    };
  }
  // Light rounds stop in the first target.
  return { continues: false, residualVelocityMult: 0, residualDamageMult: 0 };
}

/**
 * Prompt 171 — hollow-point vs FMJ ammo behavior.
 *
 * Hollow-point: more damage, no penetration (stops at the first surface).
 * FMJ: less damage, more penetration.
 *
 * This function returns the ammo's penetration rules: does it stop at the
 * first surface, and if so, what's the damage multiplier on the first target?
 *
 * `ammoTypeSlug` is one of: "fmj", "hp", "ap", "subsonic", "tracer",
 * "incendiary". See Ballistics.AMMO_TYPES for the full table.
 */
export interface AmmoPenetrationRule {
  /** Stops at the first surface (HP, subsonic). False = penetrates (FMJ, AP). */
  stopsAtFirstSurface: boolean;
  /** Damage multiplier on the first target (HP > 1, FMJ = 1). */
  firstTargetDamageMult: number;
  /** Penetration depth multiplier (HP < 1, AP > 1, FMJ = 1). */
  penetrationDepthMult: number;
}

export function getAmmoPenetrationRule(ammoTypeSlug: string): AmmoPenetrationRule {
  switch (ammoTypeSlug) {
    case "hp":
      return { stopsAtFirstSurface: true,  firstTargetDamageMult: 1.35, penetrationDepthMult: 0.30 };
    case "ap":
      return { stopsAtFirstSurface: false, firstTargetDamageMult: 0.90, penetrationDepthMult: 1.60 };
    case "subsonic":
      return { stopsAtFirstSurface: true,  firstTargetDamageMult: 0.85, penetrationDepthMult: 0.85 };
    case "tracer":
      return { stopsAtFirstSurface: false, firstTargetDamageMult: 0.95, penetrationDepthMult: 0.95 };
    case "incendiary":
      return { stopsAtFirstSurface: true,  firstTargetDamageMult: 1.10, penetrationDepthMult: 0.70 };
    case "fmj":
    default:
      return { stopsAtFirstSurface: false, firstTargetDamageMult: 1.00, penetrationDepthMult: 1.00 };
  }
}

/**
 * Prompt 192 — wallbang melee (knife through thin drywall).
 *
 * A knife melee through a thin drywall wall (max 0.04m thick) hits an enemy
 * on the other side. Returns true if the wall is thin enough for a knife to
 * pass through + the residual damage multiplier (50% — the knife loses half
 * its energy to the drywall).
 */
export function canMeleeWallbang(surface: string, surfaceThicknessM: number): {
  canWallbang: boolean;
  residualDamageMult: number;
} {
  // Only soft surfaces thin enough for a knife to pass through.
  const softSurfaces = new Set(["drywall", "foliage", "glass"]);
  if (!softSurfaces.has(surface)) {
    return { canWallbang: false, residualDamageMult: 0 };
  }
  // Drywall up to 0.05m, foliage up to 0.5m, glass up to 0.02m.
  const maxThicknessBySurface: Record<string, number> = {
    drywall: 0.05,
    foliage: 0.50,
    glass: 0.02,
  };
  const max = maxThicknessBySurface[surface] ?? 0;
  if (surfaceThicknessM > max) {
    return { canWallbang: false, residualDamageMult: 0 };
  }
  // Residual damage: 50% through drywall, 80% through foliage, 90% through glass.
  const residual: Record<string, number> = {
    drywall: 0.50,
    foliage: 0.80,
    glass: 0.90,
  };
  return { canWallbang: true, residualDamageMult: residual[surface] ?? 0.5 };
}

// ─────────────────────────────────────────────────────────────────────────────
// B1-5000 — Prompts 646 + 647: suppressor heat mirage + durability/wear.
//
// Prompt 646: sustained auto through a suppressor produces visible heat shimmer
// at the muzzle. The mirage intensity scales with the suppressor's temperature
// (driven by the existing barrelHeat value). At heat > 0.6 the mirage is
// visible; at heat = 1.0 it's a strong shimmer that distorts the scope picture.
//
// Prompt 647: suppressors wear with use. The round count past the rated life
// increases the sound + degrades accuracy. Below the rated life the suppressor
// performs as new. The wear is a 0..1 value the engine reads for sound +
// accuracy modifiers.
// ─────────────────────────────────────────────────────────────────────────────

/** Suppressor wear state. Tracks round count + the rated life of the
 *  suppressor. Wear > 1.0 means the suppressor is past its rated life. */
export interface SuppressorWearState {
  /** Rounds fired through this suppressor. */
  roundsFired: number;
  /** Rated life (rounds) before wear starts degrading performance. */
  ratedLifeRounds: number;
}

/** Default rated life — 10,000 rounds (typical for a quality 5.56mm suppressor). */
export const DEFAULT_SUPPRESSOR_RATED_LIFE = 10_000;

/** Prompt 647 — compute the suppressor wear ratio (0 = new, 1 = end of life,
 *  >1 = past rated life). Returns 0 below the rated life; scales linearly
 *  above. */
export function suppressorWearRatio(state: SuppressorWearState): number {
  if (state.roundsFired <= state.ratedLifeRounds) return 0;
  const over = state.roundsFired - state.ratedLifeRounds;
  // Linear wear over 2× the rated life past the rated life (so 1.0 wear at
  // 3× rated life total — 30,000 rounds for the default 10k rated life).
  return Math.min(1, over / (state.ratedLifeRounds * 2));
}

/** Prompt 647 — suppressor sound multiplier based on wear. A worn suppressor
 *  is louder (the baffle stack erodes). Returns a multiplier on the suppressed
 *  sound (1.0 = new, up to 1.4 at full wear). */
export function suppressorWearSoundMult(wearRatio: number): number {
  // Linear from 1.0 at wear=0 to 1.4 at wear=1.
  return 1.0 + 0.4 * Math.max(0, Math.min(1, wearRatio));
}

/** Prompt 647 — suppressor accuracy multiplier based on wear. A worn
 *  suppressor's baffle stack erodes, increasing bullet yaw + spread. Returns
 *  a multiplier on the weapon's spread (1.0 = new, up to 1.25 at full wear). */
export function suppressorWearSpreadMult(wearRatio: number): number {
  // Linear from 1.0 at wear=0 to 1.25 at wear=1.
  return 1.0 + 0.25 * Math.max(0, Math.min(1, wearRatio));
}

/** Prompt 646 — suppressor heat mirage intensity (0..1) based on barrel heat.
 *  The mirage is visible above heat=0.6 + scales to full intensity at heat=1.0.
 *  Returns 0 below the threshold (no mirage). */
export function suppressorHeatMirageIntensity(barrelHeat: number): number {
  if (barrelHeat < 0.6) return 0;
  // Linear from 0 at heat=0.6 to 1.0 at heat=1.0.
  return Math.max(0, Math.min(1, (barrelHeat - 0.6) / 0.4));
}

/** Prompt 646 — the mirage distortion strength (radians) applied to the scope
 *  picture. At full intensity, the mirage produces a ~0.5 mrad shimmer that
 *  distorts the scope picture at long range. Scaled by intensity + a noise
 *  term so the shimmer oscillates. */
export function suppressorHeatMirageDistortion(
  barrelHeat: number,
  timeSeconds: number,
): { lateral: number; vertical: number } {
  const intensity = suppressorHeatMirageIntensity(barrelHeat);
  if (intensity <= 0) return { lateral: 0, vertical: 0 };
  // Slow sinusoidal shimmer (1 Hz lateral, 1.7 Hz vertical — beats).
  const maxShimmer = 0.5e-3; // 0.5 mrad
  return {
    lateral: Math.sin(timeSeconds * Math.PI * 2) * maxShimmer * intensity,
    vertical: Math.sin(timeSeconds * Math.PI * 2 * 1.7) * maxShimmer * intensity * 0.7,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring notes (for the orchestrator — one-liners, none touch shared files)
// ─────────────────────────────────────────────────────────────────────────────
//
// In WeaponSystem.ts fireRay, after `const pen = computePenetration(velocity, material);`
// (around line 305), the orchestrator can layer the surface-specific falloff:
//
//   if (pen.penetrated && !material.bulletStop) {
//     const surfaceEntry = getPenetration(material.slug);
//     velocity = pen.velocity * surfaceEntry.velocityFalloff;
//     // Apply the per-category damage falloff for the player's current weapon.
//     const cat = WEAPONS[this.ctx.weapon.loadout.weapon].category;
//     const dmgMult = effectiveDamageFalloff(material.slug, cat);
//     // The next segment of the raycast uses `velocity` for penetration
//     // math; the damage applied on the next enemy hit is multiplied by `dmgMult`.
//     // (Store dmgMult on the ray state + apply at the next enemy-hit branch.)
//     this.onSpawnImpact?.(hitPoint, hitNormal, surfaceEntry.tell.vfxSlug);
//     // ... existing continue
//   }
//
// The damage falloff requires the orchestrator to thread a `damageMult` value
// through the ray loop. The existing loop already threads `velocity` and
// `remaining` (range budget) — adding a parallel `dmgMult` field is a 3-line
// change in WeaponSystem.fireRay.
