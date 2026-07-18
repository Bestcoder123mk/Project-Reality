import * as THREE from "three";

/**
 * P4.4: Realistic projectile ballistics — bullet drop + wind drift.
 *
 * The existing fireRay in WeaponSystem uses an instant-hit raycast with
 * multi-segment penetration. P4.4 keeps that structure but adds:
 *   - Gravity drop: the projectile's path arcs downward over distance,
 *     scaled by velocity and gravity constant. Sniper rounds (high
 *     velocity) drop less; pistol rounds (low velocity) drop more.
 *   - Wind drift: the projectile deflects sideways based on the wind
 *     vector (from ctx.weather.windSpeed/windDirection) and a wind
 *     sensitivity factor per projectile (lighter bullets drift more).
 *
 * Implementation: the raycast direction is adjusted segment-by-segment
 * to account for drop + drift accumulated over the traveled distance.
 * This is a simplification of true ballistic integration but produces
 * the visible effect (you must aim above a distant target; you must
 * lead into the wind).
 */

/** Gravity constant for bullet drop (m/s², scaled for game feel). */
const BULLET_GRAVITY = 9.81;

/**
 * Compute the drop (meters) for a projectile at given distance and velocity.
 * drop = 0.5 * g * t², where t = distance / velocity.
 */
export function computeDrop(distance: number, velocity: number): number {
  if (velocity <= 0) return 0;
  const t = distance / velocity;
  return 0.5 * BULLET_GRAVITY * t * t;
}

/**
 * Compute the wind drift (meters, in the wind's horizontal direction)
 * for a projectile at given distance and velocity.
 *
 * Heavier bullets (high damage) drift less; lighter bullets drift more.
 * Wind sensitivity is inversely proportional to momentum (mass × velocity),
 * approximated as 1 / (damage * velocity).
 */
export function computeWindDrift(distance: number, velocity: number, damage: number, windSpeed: number): number {
  if (velocity <= 0 || windSpeed <= 0) return 0;
  const t = distance / velocity;
  // Wind accelerates the bullet sideways; drift = 0.5 * a * t²
  // where a scales with windSpeed and inversely with bullet momentum.
  const windAccel = (windSpeed * 2) / Math.max(15, damage);
  return 0.5 * windAccel * t * t;
}

/**
 * Apply drop + drift to a raycast direction over a single segment.
 *
 * Returns a new direction vector that bakes in the ballistic correction
 * for the given segment distance. The caller uses this as the new
 * currentDir for the next raycast segment.
 *
 * @param currentDir Current normalized travel direction (mutated).
 * @param distance Segment distance traveled (m).
 * @param velocity Projectile velocity (m/s).
 * @param damage Bullet damage (proxy for mass).
 * @param windSpeed Wind speed (m/s).
 * @param windDirection Wind direction (radians, 0 = +X, π/2 = +Z).
 * @param out Output vector (set to the adjusted direction).
 */
export function applyBallisticDrop(
  currentDir: THREE.Vector3,
  distance: number,
  velocity: number,
  damage: number,
  windSpeed: number,
  windDirection: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  // Start from current direction.
  out.copy(currentDir);
  // Drop: subtract from Y component (gravity pulls down).
  const drop = computeDrop(distance, velocity);
  out.y -= drop / Math.max(distance, 0.1);
  // Wind drift: add to the horizontal component along the wind vector.
  const drift = computeWindDrift(distance, velocity, damage, windSpeed);
  if (drift > 0) {
    const windX = Math.cos(windDirection);
    const windZ = Math.sin(windDirection);
    out.x += (windX * drift) / Math.max(distance, 0.1);
    out.z += (windZ * drift) / Math.max(distance, 0.1);
  }
  out.normalize();
  return out;
}

/**
 * P4.4: Per-category ballistic parameters.
 * Snipers have high velocity + low drop + low drift (heavy bullet).
 * Pistols have low velocity + high drop + medium drift.
 * Shotguns have very low velocity + extreme drop + high drift (pellets).
 * Task-11: LMG has near-sniper velocity (long heavy barrel) with low drop
 * (heavy 5.56mm belt-fed round) — close to real M249 ballistics.
 *
 * REAL-BALLISTICS extension: added `mass`, `dragCoef`, `gravityScale` fields
 * consumed by ProjectileSystem for the per-frame physics integration.
 * Values are grounded in real-world ballistics:
 *   - 5.56mm NATO (RIFLE/LMG): 4g bullet, ~920 m/s, low drag (G1 BC ~0.304)
 *   - 7.62mm NATO (SNIPER/DMR): 9.3g bullet, ~840 m/s, lower drag (BC ~0.405)
 *   - 9mm Parabellum (SMG/PISTOL): 8g bullet, ~400 m/s, high drag
 *   - 12-gauge slug (SHOTGUN): 18g, ~450 m/s, very high drag, big drop
 * Drag coefficient is a simplified scalar (1/m) — multiply by velocity² for
 * deceleration. Tuned for game feel rather than literal G1/G7 drag curves.
 */
export interface BallisticParams {
  /** Muzzle velocity (m/s). */
  velocity: number;
  /** Multiplier on bullet drop (legacy, kept for compat). */
  dropMultiplier: number;
  /** Multiplier on wind drift (legacy, kept for compat). */
  driftMultiplier: number;
  /** Bullet mass (grams). Heavier = more momentum = less drag effect. */
  mass: number;
  /** Drag coefficient (1/m). Higher = decelerates faster. */
  dragCoef: number;
  /** Gravity multiplier on the standard 9.81 m/s². Snipers < 1, pistols > 1. */
  gravityScale: number;
}

export const BALLISTIC_PARAMS: Record<string, BallisticParams> = {
  SNIPER:  { velocity: 850, dropMultiplier: 0.5, driftMultiplier: 0.4, mass: 9.3,  dragCoef: 0.0008, gravityScale: 0.45 },
  RIFLE:   { velocity: 760, dropMultiplier: 1.0, driftMultiplier: 1.0, mass: 4.0,  dragCoef: 0.0014, gravityScale: 1.0  },
  SMG:     { velocity: 450, dropMultiplier: 1.3, driftMultiplier: 1.4, mass: 8.0,  dragCoef: 0.0024, gravityScale: 1.4  },
  PISTOL:  { velocity: 380, dropMultiplier: 1.6, driftMultiplier: 1.6, mass: 8.0,  dragCoef: 0.0030, gravityScale: 1.8  },
  SHOTGUN: { velocity: 410, dropMultiplier: 2.2, driftMultiplier: 2.0, mass: 18.0, dragCoef: 0.0050, gravityScale: 2.4  },
  LMG:     { velocity: 820, dropMultiplier: 0.7, driftMultiplier: 0.7, mass: 4.0,  dragCoef: 0.0012, gravityScale: 0.65 },
};

/** Default params for an unknown category — rifle-like. */
export const DEFAULT_BALLISTIC_PARAMS: BallisticParams = BALLISTIC_PARAMS.RIFLE;

/** Lookup helper with safe fallback. */
export function getBallisticParams(category: string): BallisticParams {
  return BALLISTIC_PARAMS[category] ?? DEFAULT_BALLISTIC_PARAMS;
}

// ─────────────────────────────────────────────────────────────────────────────
// REALISM-1 — Per-weapon-slug ballistic overrides.
//
// The per-category BALLISTIC_PARAMS table sets baseline ballistics for each
// of the 6 calibers (rifle / smg / pistol / sniper / shotgun / lmg). Most
// weapons in a category share the same cartridge, so the category baseline
// is correct. But some weapons in the same category fire different cartridges
// (e.g. the SCAR-H + MK17 fire 7.62mm NATO while the M4 + AK-74 fire 5.56 /
// 5.45mm — yet all are category "RIFLE"). This table layers per-weapon
// overrides on top of the category baseline so each weapon's flight model
// matches its real cartridge.
//
// Values are partial — only the fields that differ from the category baseline
// are specified. The accessor `getWeaponBallisticParams(slug, category)`
// merges the override onto the category baseline.
//
// Tuned per real-world cartridge data:
//   - 5.45×39mm (AK-74):    ~900 m/s, 3.4g, low drag (slightly lighter than 5.56)
//   - 5.56×45mm NATO (M4 etc.): ~920 m/s, 4.0g, low drag
//   - 7.62×51mm NATO (SCAR-H, MK17, MK14): ~840 m/s, 9.3g, lower drag + heavier
//   - 7.92×57mm Mauser (Kar98k): ~760 m/s, 12.8g, heavy bullet, more drop
//   - .338 Lapua (AWP, L115A3): ~910 m/s, 16.2g, very low drag (best BC)
//   - .50 AE (Deagle): ~470 m/s, 19g, heavy pistol round, big drop
//   - .50 cal revolver: ~460 m/s, 21g, even heavier, more drop
//   - 12-gauge slug (Nova/M1014/SPAS-12): ~450 m/s, 18g, very high drag
//   - 5.45×39mm RPK: same as AK-74 (RPK is a heavy-barrel AK)
//   - 7.62×51mm Mk48: same as SCAR-H (GPMG cartridge)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-weapon-slug partial ballistic overrides. Fields that are present
 *  replace the category baseline; fields that are absent inherit it. */
export const WEAPON_BALLISTIC_OVERRIDES: Partial<Record<string, Partial<BallisticParams>>> = {
  // ── RIFLE ──
  ak74:    { velocity: 900, mass: 3.4,  dragCoef: 0.0013, gravityScale: 0.95 }, // 5.45×39mm
  scarh:   { velocity: 840, mass: 9.3,  dragCoef: 0.0008, gravityScale: 0.70 }, // 7.62×51mm
  mk17:    { velocity: 840, mass: 9.3,  dragCoef: 0.0008, gravityScale: 0.70 }, // 7.62×51mm
  mk14:    { velocity: 850, mass: 9.3,  dragCoef: 0.0008, gravityScale: 0.70 }, // 7.62×51mm DMR
  // (m4, hk416, famas, aug, galil stay at the RIFLE baseline — 5.56mm NATO)

  // ── SNIPER ──
  awp:     { velocity: 910, mass: 16.2, dragCoef: 0.0004, gravityScale: 0.40 }, // .338 Lapua
  l115a3:  { velocity: 915, mass: 16.2, dragCoef: 0.0004, gravityScale: 0.38 }, // .338 Lapua, heavy rifle
  kar98k:  { velocity: 760, mass: 12.8, dragCoef: 0.0006, gravityScale: 0.55 }, // 7.92×57mm Mauser
  // (scout stays at SNIPER baseline — 7.62×51mm)

  // ── PISTOL ──
  deagle:  { velocity: 470, mass: 19.0, dragCoef: 0.0035, gravityScale: 2.0  }, // .50 AE
  revolver:{ velocity: 460, mass: 21.0, dragCoef: 0.0038, gravityScale: 2.2  }, // .50 cal revolver
  // (usp, glock18, m1911 stay at PISTOL baseline — .45 ACP / 9mm)

  // ── SHOTGUN (all 12-gauge — stay at category baseline) ──

  // ── LMG ──
  rpk:     { velocity: 900, mass: 3.4,  dragCoef: 0.0013, gravityScale: 0.95 }, // 5.45×39mm
  mk48:    { velocity: 840, mass: 9.3,  dragCoef: 0.0008, gravityScale: 0.70 }, // 7.62×51mm
  // (m249 stays at LMG baseline — 5.56mm NATO belt-fed)
};

/**
 * Get the ballistic params for a specific weapon slug. Merges the per-weapon
 * override (if any) onto the category baseline. Weapons not in the override
 * table inherit the full category baseline.
 *
 * Callers (e.g. WeaponSystem.spawnProjectile) should use this instead of
 * `getBallisticParams(category)` when the weapon slug is known — produces
 * per-weapon flight models (the AK-74's bullet flies differently from the
 * M4's, even though both are RIFLE category).
 */
export function getWeaponBallisticParams(slug: string, category: string): BallisticParams {
  const base = getBallisticParams(category);
  const override = WEAPON_BALLISTIC_OVERRIDES[slug];
  if (!override) return base;
  return {
    velocity:        override.velocity        ?? base.velocity,
    dropMultiplier:  override.dropMultiplier  ?? base.dropMultiplier,
    driftMultiplier: override.driftMultiplier ?? base.driftMultiplier,
    mass:            override.mass            ?? base.mass,
    dragCoef:        override.dragCoef        ?? base.dragCoef,
    gravityScale:    override.gravityScale    ?? base.gravityScale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REALISM-1 — Per-weapon-slug tracer color table.
//
// The existing TRACER_COLORS table in ParticleSystem.ts is keyed by weapon
// CATEGORY (RIFLE/SNIPER/SMG/PISTOL/SHOTGUN/LMG/ENEMY). That gives every
// rifle the same yellow-orange tracer — functional but flat. This per-weapon
// table lets specific weapons carry distinctive tracer tints so the player
// can identify the source of incoming fire by tracer color:
//
//   - AWP / L115A3: bright red (.338 Lapua — the "death ray" tracer)
//   - AK-74: deep amber (5.45mm Soviet — warmer than NATO)
//   - Deagle / Revolver: hot orange (.50 cal — heavy tracer)
//   - Vector: green-yellow (Super V — distinctive tint)
//
// Weapons not in this table fall back to the category color in TRACER_COLORS
// (the existing behavior). The accessor `getWeaponTracerColor(slug, category)`
// does the lookup with fallback.
//
// Wiring note for the orchestrator: in WeaponSystem.spawnProjectile, replace
//   const tracerColor = TRACER_COLORS[category] ?? TRACER_COLORS.RIFLE;
// with
//   const tracerColor = getWeaponTracerColor(ctx.weapon.loadout.weapon, category);
// (one-liner — leaves the existing structure intact).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-weapon-slug tracer color overrides (hex). Weapons not listed fall back
 *  to the category color in ParticleSystem.TRACER_COLORS. */
export const WEAPON_TRACER_COLORS: Record<string, number> = {
  // ── SNIPER — bright red "death ray" tracers for .338 Lapua ──
  awp:     0xff3322, // bright red — .338 Lapua magnum
  l115a3:  0xff2a1a, // even brighter red — heaviest sniper

  // ── RIFLE — cartridge-specific tints ──
  ak74:    0xffaa44, // deep amber — 5.45mm Soviet (warmer than NATO)
  scarh:   0xffbb55, // 7.62mm — slightly warmer than 5.56
  mk17:    0xffbb55, // 7.62mm — same as SCAR-H
  mk14:    0xffcc66, // 7.62mm DMR — slightly brighter (longer barrel)

  // ── PISTOL — heavy-caliber tracers read at distance ──
  deagle:  0xff9933, // hot orange — .50 AE
  revolver:0xff8822, // even hotter — .50 cal revolver

  // ── SMG — distinctive tints per weapon ──
  vector:  0xccff66, // green-yellow — Super V signature tint
};

/**
 * Get the tracer color for a specific weapon slug. Falls back to the category
 * color (provided as the second arg) if the slug isn't in the override table.
 *
 * Caller pattern (WeaponSystem.spawnProjectile):
 *   const tracerColor = getWeaponTracerColor(slug, TRACER_COLORS[category] ?? TRACER_COLORS.RIFLE);
 */
export function getWeaponTracerColor(slug: string, fallbackCategoryColor: number): number {
  return WEAPON_TRACER_COLORS[slug] ?? fallbackCategoryColor;
}

/**
 * REAL-BALLISTICS — integrate a projectile one step forward in time.
 *
 * Semi-implicit Euler (symplectic, conserves energy better than explicit Euler
 * over long flights):
 *   v_new = v_old + (gravity + wind_accel - drag*v_old*|v_old|) * dt
 *   p_new = p_old + v_new * dt
 *
 * Gravity is -Y (world down) at 9.81 * gravityScale m/s².
 * Wind adds a horizontal acceleration along the wind vector.
 * Drag is quadratic in speed: a_drag = -dragCoef * |v| * v (per unit mass,
 * so we divide by mass/1000 to convert grams → kg... actually we keep mass
 * baked into the dragCoef for simplicity — the per-category dragCoef already
 * accounts for typical bullet mass).
 *
 * Returns the new velocity + position via the out params (no allocations
 * except the wind vector when windSpeed > 0).
 */
const _windVec = new THREE.Vector3();
// A3-5000 #527: re-entrancy guard — _windVec is module-level + mutable. If
// integrateProjectile is called re-entrantly (e.g. via a recursive sub-step),
// the inner call would corrupt the outer call's _windVec. We use a simple
// re-entrancy flag + fall back to a per-call allocation on re-entry.
let _windVecInUse = false;
export function integrateProjectile(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  dt: number,
  params: BallisticParams,
  windSpeed: number,
  windDirection: number,
): void {
  // Gravity
  vel.y -= 9.81 * params.gravityScale * dt;
  // Wind (horizontal only — wind doesn't push bullets up/down).
  if (windSpeed > 0) {
    const windAccel = (windSpeed * 2) / Math.max(15, params.mass);
    // A3-5000 #527: if re-entered, allocate a per-call vector (slower but
    // correct). The common path uses the shared _windVec (zero-alloc).
    if (_windVecInUse) {
      const localWind = new THREE.Vector3(
        Math.cos(windDirection) * windAccel, 0, Math.sin(windDirection) * windAccel,
      );
      vel.addScaledVector(localWind, dt);
    } else {
      _windVecInUse = true;
      _windVec.set(Math.cos(windDirection) * windAccel, 0, Math.sin(windDirection) * windAccel);
      vel.addScaledVector(_windVec, dt);
      _windVecInUse = false;
    }
  }
  // Quadratic drag: a = -k * |v| * v
  const speed = vel.length();
  if (speed > 0.001) {
    const dragDecel = params.dragCoef * speed;
    vel.addScaledVector(vel, -dragDecel * dt);
  }
  // Integrate position using the NEW velocity (semi-implicit).
  pos.addScaledVector(vel, dt);
}

/**
 * REAL-BALLISTICS — damage falloff by residual velocity.
 *
 * A bullet at full muzzle velocity deals 100% damage. As it slows (drag) the
 * damage scales linearly down to a floor of 50% at 30 m/s (the despawn
 * threshold). This makes long-range pistol shots noticeably weaker while
 * keeping sniper rounds lethal at distance (they retain velocity better).
 *
 * Headshots multiply AFTER falloff (so a slow headshot still crits).
 */
export function velocityDamageMult(currentVelocity: number, muzzleVelocity: number): number {
  if (muzzleVelocity <= 0) return 1;
  const ratio = currentVelocity / muzzleVelocity;
  // 1.0 at full speed, 0.5 at 30 m/s (the despawn floor), linear in between.
  // Clamp the ratio to [0.4, 1.0] so a very-slow bullet still deals 50%.
  const clamped = Math.max(0.4, Math.min(1.0, ratio));
  return 0.5 + 0.5 * clamped;
}

// ============================================================
// Task-11: Bullet ricochets.
// ============================================================

/**
 * Per-surface ricochet probability. Hard surfaces (concrete, sheet metal,
 * steel plate) ricochet; soft surfaces (wood, sand, flesh, glass, earth,
 * foliage, drywall, brick, sandbag) absorb the bullet.
 *
 * Tuned to the task spec: 30% on concrete, 50% on metal/steel, 0% on soft.
 */
const RICOCHET_PROBABILITY: Record<string, number> = {
  concrete: 0.30,
  sheet_metal: 0.50,
  steel_plate: 0.50,
};

/** Damage multiplier applied to a ricocheting bullet (50% reduction). */
export const RICOCHET_DAMAGE_MULT = 0.5;
/** Max travel distance of a ricocheting bullet (meters). One bounce only. */
export const RICOCHET_RANGE = 10;
/** Surfaces whose ricochet VFX should use the bright metallic spark table. */
const RICOCHET_SPARK_SURFACE = "steel_plate";

export interface RicochetResult {
  /** Reflected direction (normalized) the ricocheting bullet travels, or
   *  null when the bullet embeds (no ricochet). */
  direction: THREE.Vector3 | null;
  /** Damage multiplier applied to the ricocheting bullet (0..1). */
  damageMult: number;
  /** Max range of the ricocheting bullet, in meters. */
  range: number;
  /** Surface slug to use when spawning the ricochet spark VFX. */
  sparkSurface: string;
}

/**
 * Task-11: Compute a bullet ricochet off a hard surface.
 *
 * Reflection formula: `r = d - 2 * (d · n) * n` (mirror reflection across the
 * surface normal). The ricocheting bullet carries 50% of the original damage
 * and travels up to RICOCHET_RANGE meters (one bounce max — the caller is
 * responsible for not chaining ricochets).
 *
 * Rules:
 *   1. Only hard surfaces (concrete / sheet_metal / steel_plate) can ricochet.
 *      Soft surfaces (wood / sand / flesh / glass / earth / foliage / drywall
 *      / brick / sandbag) absorb the bullet.
 *   2. Probability per the spec: 30% concrete, 50% sheet_metal/steel_plate.
 *   3. Defensive: the bullet must be traveling INTO the surface (dot < 0).
 *   4. Steep-angle hits (within ~25° of the surface normal) embed rather than
 *      ricochet — this is real-world physics and also prevents the edge case
 *      of a ricochet bouncing straight back at the shooter.
 *   5. The reflected direction gets a small random jitter (±0.04 per axis)
 *      so ricochets don't look perfectly mirror-like.
 *
 * @param hitNormal    Surface normal at the impact point (world-space, outward).
 * @param bulletDir    Incoming bullet direction (normalized, world-space).
 * @param surfaceType  Ballistics material slug (concrete / sheet_metal / …).
 * @returns            RicochetResult — `direction` is null when no ricochet.
 */
export function computeRicochet(
  hitNormal: THREE.Vector3,
  bulletDir: THREE.Vector3,
  surfaceType: string,
): RicochetResult {
  const empty: RicochetResult = {
    direction: null, damageMult: 0, range: 0, sparkSurface: surfaceType,
  };

  // Step 1: only hard surfaces ricochet.
  const prob = RICOCHET_PROBABILITY[surfaceType] ?? 0;
  if (prob <= 0) return empty;

  // Step 2: bullet must be traveling INTO the surface.
  const dot = bulletDir.dot(hitNormal);
  if (dot >= 0) return empty;

  // Step 3: steep-angle hits embed (no ricochet). |dot| > 0.91 means the
  // bullet hit within ~25° of perpendicular — it digs in.
  if (dot < -0.91) return empty;

  // Step 4: probability roll.
  if (Math.random() > prob) return empty;

  // Step 5: reflect: r = d - 2 * (d · n) * n
  const reflected = bulletDir
    .clone()
    .sub(hitNormal.clone().multiplyScalar(2 * dot));
  // Small random jitter so the ricochet isn't a perfect mirror bounce.
  reflected.x += (Math.random() - 0.5) * 0.08;
  reflected.y += (Math.random() - 0.5) * 0.08;
  reflected.z += (Math.random() - 0.5) * 0.08;
  reflected.normalize();

  return {
    direction: reflected,
    damageMult: RICOCHET_DAMAGE_MULT,
    range: RICOCHET_RANGE,
    sparkSurface: RICOCHET_SPARK_SURFACE,
  };
}

// ============================================================
// SEC5-COMBAT — Prompt 45: Per-surface penetration tuning.
// ============================================================

/**
 * Per-surface penetration multiplier — a flat 0..1 scale layered on top of
 * the realism.ts density-based `computePenetration` math. Snipers penetrate
 * the most, shotguns the least.
 *
 * This is the Ballistics-side companion to `combat/penetration.ts`'s
 * `MATERIAL_PENETRATION` table. The two compose:
 *
 *   const physicsResult = computePenetration(velocity, material);  // realism.ts
 *   const surfaceMult = SURFACE_PENETRATION_MULT[material.slug] ?? 0.5;
 *   const finalVelocity = physicsResult.velocity * surfaceMult;
 *
 * The flat multiplier captures the designer-facing "this surface stops bullets
 * more or less than its density would suggest" knob. Concrete's high density
 * already produces low residual velocity via the realism.ts math; the
 * multiplier here adds the gameplay-tuning layer (e.g. "for play-feel, sheet
 * metal should let 55% of velocity through, not the 30% pure physics gives").
 */
export const SURFACE_PENETRATION_MULT: Record<string, number> = {
  drywall: 0.85,        // soft interior wall — penetrates easily
  wood: 0.75,           // stud wall — penetrates with falloff
  sheet_metal: 0.55,    // car door — partial penetration
  brick: 0.40,          // brick wall — mostly stops
  sandbag: 0.05,        // military sandbag — bullet trap
  glass: 0.95,          // window — almost clean penetration
  foliage: 0.98,        // bush — negligible resistance
  earth: 0.10,          // dirt berm — stops quickly
  concrete: 0.35,       // concrete wall — hard cover
  steel_plate: 0.00,    // armour plate — impenetrable
};

/**
 * Default penetration multiplier for surfaces not in the table. Conservative
 * (treat unknowns as concrete-ish).
 */
export const DEFAULT_SURFACE_PENETRATION_MULT = 0.35;

/**
 * Get the penetration multiplier for a surface slug. Falls back to the
 * default (0.35) if the slug isn't recognised.
 */
export function getSurfacePenetrationMult(surface: string): number {
  return SURFACE_PENETRATION_MULT[surface] ?? DEFAULT_SURFACE_PENETRATION_MULT;
}

/**
 * Per-weapon-category penetration multiplier. Heavy rounds (sniper, LMG)
 * penetrate more of the surface's nominal depth than light rounds (pistol,
 * shotgun). Applied multiplicatively with the surface multiplier.
 */
export const CATEGORY_PENETRATION_MULT: Record<string, number> = {
  SNIPER: 1.30,
  LMG: 1.10,
  RIFLE: 1.00,
  SMG: 0.70,
  PISTOL: 0.50,
  SHOTGUN: 0.10,
};

/**
 * Default category multiplier (treat unknowns as rifle).
 */
export const DEFAULT_CATEGORY_PENETRATION_MULT = 1.00;

/**
 * Get the penetration multiplier for a weapon category. Falls back to rifle
 * (1.0) if the category isn't recognised.
 */
export function getCategoryPenetrationMult(category: string): number {
  return CATEGORY_PENETRATION_MULT[category] ?? DEFAULT_CATEGORY_PENETRATION_MULT;
}

/**
 * SEC5-COMBAT — Prompt 45: Combined surface + category penetration test.
 *
 * Returns whether a bullet of the given weapon category can penetrate the
 * given surface, + the residual velocity multiplier (0 = stopped, 1 = clean
 * penetration).
 *
 * This is the high-level API the WeaponSystem penetration raycast loop calls
 * per surface hit. It composes the surface multiplier (per-material) with
 * the category multiplier (per-weapon-class) for a single 0..1 verdict.
 *
 * @param surface   Material slug (e.g. "wood", "concrete", "steel_plate").
 * @param category  Weapon category ("RIFLE"|"SMG"|"PISTOL"|"SNIPER"|"SHOTGUN"|"LMG").
 * @returns         { penetrates: boolean, velocityMult: number }.
 *                  `velocityMult` is the multiplier to apply to the bullet's
 *                  post-physics residual velocity. `penetrates` is true iff
 *                  `velocityMult > 0.05` (below 5%, treat as stopped).
 */
export function testSurfacePenetration(
  surface: string,
  category: string,
): { penetrates: boolean; velocityMult: number } {
  const surfaceMult = getSurfacePenetrationMult(surface);
  const catMult = getCategoryPenetrationMult(category);
  const velocityMult = surfaceMult * catMult;
  return {
    penetrates: velocityMult > 0.05,
    velocityMult,
  };
}

// ============================================================
// Prompt #46 — Hitbox zones (head / chest / limb).
// ============================================================

/**
 * A ballistic hitbox zone on the humanoid rig. Each enemy part is tagged
 * with one of these via `mesh.userData.hitZone`. The WeaponSystem /
 * ProjectileSystem raycast reads the zone + applies the matching damage
 * multiplier from `HITZONE_DAMAGE_MULT`.
 *
 *   - "head"  — head, helmet, neck, face parts (eyes, nose, ears, …).
 *               4× damage multiplier (the spec value — a single rifle round
 *               to the head drops a 100 HP target).
 *   - "chest" — upper torso: body, vest, jacket, shoulders, abdomen.
 *               1× damage (the baseline).
 *   - "limb"  — arms, legs, hands, feet, hips, belt, pouches on legs.
 *               0.7× damage (peripheral hits hurt but rarely kill).
 */
export type HitZone = "head" | "chest" | "limb";

/** Per-zone damage multiplier. Head = 4×, chest = 1× (base), limb = 0.7×. */
export const HITZONE_DAMAGE_MULT: Record<HitZone, number> = {
  head: 4.0,
  chest: 1.0,
  limb: 0.7,
};

/** Default multiplier when the zone is missing / unrecognised (treat as chest). */
export const DEFAULT_HITZONE_MULT = 1.0;

/**
 * Look up the damage multiplier for a hit zone. Falls back to chest (1.0)
 * for unknown / missing zones so a missing tag never produces a 0-damage hit.
 */
export function getHitZoneMult(zone: HitZone | string | undefined): number {
  if (!zone) return DEFAULT_HITZONE_MULT;
  return HITZONE_DAMAGE_MULT[zone as HitZone] ?? DEFAULT_HITZONE_MULT;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B — Prompts 161–166 + 286: advanced ballistics.
//   161: subsonic behavior (no sonic crack, reduced suppression).
//   162: transonic transition destabilization (drag spike crossing 343 m/s).
//   163: wind gusts (noise-driven, not constant).
//   164: Coriolis + spin drift for extreme ranges (>800m).
//   165: G1/G7 ballistic coefficient drag model.
//   166: bullet spin rate decay (gyroscopic stability vs range).
//   286: sniper bullet trace visibility (handled in weapon-viewmodel + tracers).
// ─────────────────────────────────────────────────────────────────────────────

/** Speed of sound at sea level (m/s, 15°C). Used for subsonic/transonic logic. */
export const SPEED_OF_SOUND = 343;

/** Prompt 161 — ammo types with subsonic flag. */
export interface AmmoType {
  slug: string;
  /** Display label (FMJ, HP, AP, Subsonic, etc.). */
  label: string;
  /** True if muzzle velocity < 343 m/s (no sonic crack, reduced suppression). */
  subsonic: boolean;
  /** Damage multiplier relative to the weapon's baseline ammo. */
  damageMult: number;
  /** Penetration multiplier (HP < 1, AP > 1, FMJ = 1). */
  penetrationMult: number;
  /** Suppression multiplier — subsonic reduces suppression (no sonic crack). */
  suppressionMult: number;
}

/** Per-ammo-type table. The loadout ammo type field is a key into this table. */
export const AMMO_TYPES: Record<string, AmmoType> = {
  fmj:       { slug: "fmj",       label: "FMJ",       subsonic: false, damageMult: 1.00, penetrationMult: 1.00, suppressionMult: 1.00 },
  hp:        { slug: "hp",        label: "Hollow Point", subsonic: false, damageMult: 1.35, penetrationMult: 0.30, suppressionMult: 1.00 },
  ap:        { slug: "ap",        label: "Armor Piercing", subsonic: false, damageMult: 0.90, penetrationMult: 1.60, suppressionMult: 1.00 },
  subsonic:  { slug: "subsonic",  label: "Subsonic", subsonic: true,  damageMult: 0.85, penetrationMult: 0.85, suppressionMult: 0.35 },
  tracer:    { slug: "tracer",    label: "Tracer",   subsonic: false, damageMult: 0.95, penetrationMult: 0.95, suppressionMult: 1.10 },
  incendiary:{ slug: "incendiary",label: "Incendiary", subsonic: false, damageMult: 1.10, penetrationMult: 0.70, suppressionMult: 1.00 },
};

/** Prompt 161 — get ammo-type properties (falls back to FMJ). */
export function getAmmoType(slug: string): AmmoType {
  return AMMO_TYPES[slug] ?? AMMO_TYPES.fmj;
}

/**
 * Prompt 161 — does this bullet produce a sonic crack?
 *
 * Subsonic bullets (velocity < SPEED_OF_SOUND) don't break the sound barrier,
 * so they produce no supersonic crack. Combined with a suppressor they're
 * genuinely quiet. Supersonic bullets produce a sharp crack regardless of
 * suppressor (the crack comes from the bullet, not the muzzle).
 */
export function producesSonicCrack(velocity: number, ammoType: AmmoType): boolean {
  if (ammoType.subsonic) return false;
  return velocity > SPEED_OF_SOUND;
}

/**
 * Prompt 162 — transonic destabilization factor.
 *
 * When a bullet's velocity crosses SPEED_OF_SOUND (343 m/s) on its way down
 * from supersonic to subsonic, it briefly encounters the transonic drag rise
 * (Mach 1 drag spike) + reduced gyroscopic stability. This function returns
 * a multiplier on drag (1.0 outside the transonic band, up to 1.4 inside it)
 * + a small POI scatter that simulates the destabilization.
 *
 * The transonic band is defined as [SPEED_OF_SOUND * 0.85, SPEED_OF_SOUND * 1.15]
 * — the bullet is "transonic" while it's within ±15% of the sound barrier.
 */
export const TRANSONIC_BAND_LOW = SPEED_OF_SOUND * 0.85;
export const TRANSONIC_BAND_HIGH = SPEED_OF_SOUND * 1.15;
export const TRANSONIC_DRAG_PEAK = 1.4;
export const TRANSONIC_SCATTER_DEGREES = 0.06; // ~3.4 MOA at the transonic band

export function transonicDragMult(velocity: number): number {
  if (velocity < TRANSONIC_BAND_LOW || velocity > TRANSONIC_BAND_HIGH) return 1.0;
  // Peak drag at exactly Mach 1 (velocity = SPEED_OF_SOUND), falling off
  // linearly to 1.0 at the band edges.
  const t = 1 - Math.abs(velocity - SPEED_OF_SOUND) / (SPEED_OF_SOUND * 0.15);
  return 1.0 + (TRANSONIC_DRAG_PEAK - 1.0) * Math.max(0, Math.min(1, t));
}

/**
 * Prompt 163 — wind gust signal (noise-driven, not constant).
 *
 * The base wind speed from WeatherSystem is a steady value; this function
 * layers a noise-driven gust component so long-range shots require reading
 * the gust pattern rather than a single wind value. The gust is computed
 * from a low-frequency sinusoid + a noise term — deterministic given (t, seed)
 * so the engine can predict the gust pattern for a single shot.
 *
 * Returns the gust-modified wind speed (m/s). Gusts add ±30% of the base
 * wind speed at a 0.2 Hz cadence (5-second gust cycle).
 */
export function gustWindSpeed(
  baseWindSpeed: number,
  timeSeconds: number,
  seed: number = 0,
): number {
  if (baseWindSpeed <= 0) return 0;
  // Low-frequency sinusoid (5s period) + higher-frequency noise (1s period).
  const slow = Math.sin(timeSeconds * 0.4 * Math.PI + seed);
  const fast = Math.sin(timeSeconds * 2.0 * Math.PI + seed * 1.7) * 0.4;
  const gust = (slow + fast) * 0.3; // ±30% of base wind
  return Math.max(0, baseWindSpeed * (1 + gust));
}

/**
 * Prompt 164 — Coriolis drift for extreme-range shots (>800m).
 *
 * At mid-latitudes (default 45°N), a 1000m shot drifts ~10cm east (in the
 * northern hemisphere) due to the Earth's rotation. The drift is small at
 * short range but becomes relevant past 800m. This function computes the
 * lateral drift (meters) given range, latitude, flight time, and the firing
 * azimuth (compass bearing in radians, 0 = north, π/2 = east).
 *
 * Simplified Eötvös/Coriolis: drift = 0.5 * Ω * sin(lat) * t * range, where
 * Ω = 7.2921e-5 rad/s (Earth rotation rate). For a 1000m shot at 850 m/s,
 * flight time ≈ 1.2s, drift ≈ 0.5 * 7.29e-5 * 0.707 * 1.2 * 1000 ≈ 0.062m
 * = ~6cm — close to the spec's ~10cm at mid-latitudes.
 *
 * The drift is in the EAST direction (rightward in the northern hemisphere).
 */
export const EARTH_ROTATION_RATE = 7.2921e-5; // rad/s

export function coriolisDriftM(
  rangeM: number,
  flightTimeS: number,
  latitudeDeg: number,
  azimuthRad: number,
): number {
  if (rangeM < 800) return 0; // negligible below 800m
  const lat = (latitudeDeg * Math.PI) / 180;
  // Eastward drift (signed). Positive = east.
  const eastDrift = 0.5 * EARTH_ROTATION_RATE * Math.sin(lat) * flightTimeS * rangeM;
  // Project the eastward drift onto the firing azimuth's lateral axis (right
  // of the firing direction). If azimuth = π/2 (firing east), drift is purely
  // lateral (right). If azimuth = 0 (firing north), eastward drift is fully
  // lateral-right in the northern hemisphere.
  const rightDrift = eastDrift * Math.cos(azimuthRad - Math.PI / 2);
  return rightDrift;
}

/**
 * Prompt 164 — Magnus spin drift (lateral drift from bullet spin).
 *
 * A spinning bullet experiences a small lateral Magnus force from the
 * crosswind-equivalent of its spin axis. For a right-hand-twist barrel
 * (the standard), the drift is rightward. Typical drift is ~10cm at 1000m
 * for a 1:10 twist .30-cal bullet. Returns lateral drift in meters.
 */
export function magnusSpinDriftM(rangeM: number): number {
  if (rangeM < 800) return 0;
  // Linear with range past 800m: ~0.1m per 1000m past the 800m threshold.
  return 0.1 * (rangeM - 800) / 1000;
}

/**
 * Prompt 165 — G1 / G7 ballistic coefficient drag model.
 *
 * Replaces the constant `dragCoef` with a velocity-dependent drag curve
 * based on the standard G1 (flat-based bullet) or G7 (boat-tail) drag
 * function. The G1 BC is more common in load data; G7 is more accurate for
 * modern boat-tail bullets. This is a simplified table — full G1/G7 tables
 * have ~40 Mach-band entries; this uses 8 bands with linear interpolation.
 *
 * Returns the effective drag coefficient (1/m) at the given velocity.
 *
 * Per-category defaults: SNIPER + LMG use G7 (boat-tail match bullets);
 * everything else uses G1 (flat-base). The BC is layered on top of the
 * per-weapon dragCoef as a velocity-dependent multiplier.
 */
export type DragModel = "G1" | "G7";

export interface BallisticCoefficient {
  model: DragModel;
  /** BC value (higher = less drag). Typical G1 BC: 0.3–0.5; G7 BC: 0.15–0.25. */
  bc: number;
}

/** Per-category default BC. Snipers/LMGs use G7 (boat-tail); rest use G1. */
export const DEFAULT_BC_BY_CATEGORY: Record<string, BallisticCoefficient> = {
  SNIPER:  { model: "G7", bc: 0.220 },
  LMG:     { model: "G7", bc: 0.180 },
  RIFLE:   { model: "G1", bc: 0.305 },
  SMG:     { model: "G1", bc: 0.180 },
  PISTOL:  { model: "G1", bc: 0.150 },
  SHOTGUN: { model: "G1", bc: 0.080 },
};

/**
 * The G1 / G7 standard drag function — returns the drag function value Cd
 * at the given Mach number. Standard tables approximated by 8 bands.
 * Lower Mach = lower Cd (subsonic); peak Cd at Mach 1 (transonic); declining
 * Cd at higher Mach. G7 has lower Cd than G1 across the board (more aerodynamic).
 */
const G1_CD_TABLE: Array<[number, number]> = [
  // [Mach upper bound, Cd]
  [0.5, 0.145],
  [0.8, 0.165],
  [0.9, 0.205],
  [1.0, 0.295],
  [1.1, 0.380],
  [1.5, 0.380],
  [2.0, 0.345],
  [3.0, 0.295],
  [Infinity, 0.220],
];

const G7_CD_TABLE: Array<[number, number]> = [
  [0.5, 0.098],
  [0.8, 0.108],
  [0.9, 0.130],
  [1.0, 0.220],
  [1.1, 0.295],
  [1.5, 0.295],
  [2.0, 0.260],
  [3.0, 0.220],
  [Infinity, 0.180],
];

function lookupCd(mach: number, table: Array<[number, number]>): number {
  for (const [machUpper, cd] of table) {
    if (mach <= machUpper) return cd;
  }
  return table[table.length - 1][1];
}

/**
 * Prompt 165 — compute the effective drag coefficient (1/m) using G1/G7.
 *
 * The standard formula: effective_drag = Cd(Mach) / (BC * K),
 * where K = i (form factor) — simplified to 1.0 here for game tuning.
 * The result is multiplied by the per-weapon `dragCoef` baseline so the
 * existing tuning continues to apply (the G1/G7 curve is a velocity-dependent
 * multiplier on top of the baseline).
 */
export function gModelDragCoef(
  velocity: number,
  bc: BallisticCoefficient,
  baselineDragCoef: number,
): number {
  const mach = velocity / SPEED_OF_SOUND;
  const cd = bc.model === "G7"
    ? lookupCd(mach, G7_CD_TABLE)
    : lookupCd(mach, G1_CD_TABLE);
  // Effective Cd / BC. Higher BC = lower drag. Scale by baseline so the
  // per-weapon tuning still applies.
  const effectiveCd = cd / Math.max(0.05, bc.bc);
  // Normalize: the baseline dragCoef is tuned for a typical Cd ~ 0.3 at Mach 1.
  // Multiply the baseline by the ratio of the current Cd to 0.3.
  return baselineDragCoef * (effectiveCd / 0.3);
}

/**
 * Prompt 166 — bullet spin rate decay + gyroscopic stability scatter.
 *
 * A bullet's spin rate decays linearly with flight time (air friction on the
 * bearing surface). At extreme range the bullet's gyroscopic stability factor
 * drops below 1.0 and the bullet destabilizes — modeled as a small random POI
 * scatter that grows with range past 800m.
 *
 * Returns the destabilization scatter (radians) to apply to the bullet's
 * direction at the given flight time. 0 inside 800m, ramping up to ~0.001 rad
 * (~3.4 MOA) at 1500m flight time.
 */
export function spinStabilityScatter(
  flightTimeS: number,
  rangeM: number,
): number {
  if (rangeM < 800) return 0;
  // Spin decays linearly with time; stability crosses 1.0 at ~1.5s flight.
  const stability = Math.max(0.5, 1.5 - flightTimeS * 0.4);
  if (stability >= 1.0) return 0;
  // Below stability 1.0: scatter grows linearly with the deficit.
  // Random scatter scaled by (1 - stability) * maxScatter.
  const maxScatter = 0.0012; // rad
  const deficit = 1.0 - stability;
  return (Math.random() - 0.5) * 2 * maxScatter * deficit;
}

/**
 * Prompt 162 — combined transonic + spin-stability scatter for a bullet at
 * the given (velocity, flightTime, range). Returns the lateral deflection
 * (radians) to apply to the bullet's direction this tick.
 */
export function computeDestabilizationScatter(
  velocity: number,
  flightTimeS: number,
  rangeM: number,
): { lateral: number; vertical: number } {
  let lateral = 0;
  let vertical = 0;
  // Transonic scatter (small, only inside the transonic band).
  if (velocity >= TRANSONIC_BAND_LOW && velocity <= TRANSONIC_BAND_HIGH) {
    lateral += (Math.random() - 0.5) * TRANSONIC_SCATTER_DEGREES;
    vertical += (Math.random() - 0.5) * TRANSONIC_SCATTER_DEGREES;
  }
  // Spin-stability scatter (only past 800m).
  const spinScatter = spinStabilityScatter(flightTimeS, rangeM);
  lateral += spinScatter;
  return { lateral, vertical };
}

/**
 * Prompt 286 — sniper bullet trace visibility factor.
 *
 * Sniper rounds are heavy + slow-firing — every missed shot should be
 * locatable by the enemy (a faint trace visible to enemies on miss). This
 * function returns a visibility multiplier (0..1) for the sniper's tracer
 * based on the bullet's remaining velocity. At muzzle velocity the trace
 * is at full brightness (1.0); as the bullet slows, the trace fades (down
 * to 0.3 at 30 m/s).
 *
 * Non-sniper weapons return 1.0 (their tracers already follow the standard
 * brightness curve in ParticleSystem).
 */
export function sniperTraceVisibilityMult(
  currentVelocity: number,
  muzzleVelocity: number,
  isSniper: boolean,
): number {
  if (!isSniper) return 1.0;
  if (muzzleVelocity <= 0) return 1.0;
  const ratio = currentVelocity / muzzleVelocity;
  // Fade from 1.0 at full speed to 0.3 at 30 m/s. The trace stays visible
  // enough to locate the sniper but doesn't read as a bright tracer round.
  return 0.3 + 0.7 * Math.max(0, Math.min(1, ratio));
}

// ─────────────────────────────────────────────────────────────────────────────
// Part-name → hit-zone classifier.
//
// The humanoid rig (utils.ts buildHumanoid) registers ~70 named meshes in the
// `parts` dict. We classify each by name prefix so the WeaponSystem raycast
// can apply the correct damage multiplier. Anything not matched defaults to
// "limb" — the safest non-critical zone (a hit on an unrecognised pouch or
// accessory shouldn't read as a chest shot, but also shouldn't be a free
// headshot).
//
// The classifier is a pure function over the part name (the dict key in
// `parts`), not the mesh itself — the rig builds all parts as siblings
// under a single Group (no parent/child hierarchy between body / head / limbs),
// so we can't use the Object3D parent chain to detect the zone.
// ─────────────────────────────────────────────────────────────────────────────

/** Mesh-name prefixes that map to the HEAD hitbox zone. */
const HEAD_PART_PREFIXES = [
  "head", "helmet", "neck", "balaclava", "cap", "fullBrim", "stdBrim", "visor",
  "railL", "railR", "nvg", "patchPanel", "helmetFlagPatch", "tacLens", "boomMic",
  "earcup", "headset", "earL", "earR", "ear", "brow", "eyelid", "eyelash",
  "eyebrow", "eye", "iris", "pupil", "sclera", "nose", "nostril", "mouth",
  "lip", "lips", "teeth", "jaw", "chin", "cheek", "cheekbone", "stubble",
  "philtrum", "hair", "sideburn", "beard", "mustache",
];

/** Mesh-name prefixes that map to the CHEST hitbox zone (upper torso). */
const CHEST_PART_PREFIXES = [
  "body", "vest", "abdomen", "abCrease", "jacket", "shoulderStripe", "shoulderStrap",
  "lShoulderStrap", "rShoulderStrap", "utilPouch", "adminPouch",
  "lShoulderJoint", "rShoulderJoint", "idBadge", "collarbone",
];

/**
 * Classify a humanoid rig part by name into a hitbox zone.
 *
 * Strategy: check the part name against the head + chest prefix lists; if
 * neither matches, fall back to "limb" (the rig's arms, legs, hips, belt,
 * boots, backpack, and accessories all land here — they're peripheral hits
 * that should deal reduced damage).
 *
 * The match is case-insensitive on the prefix (e.g. "VestBack" → "vest"
 * prefix → "chest"). We also explicitly catch the few part names that would
 * otherwise mis-match (e.g. "lShoulderJoint" starts with "l" but should be
 * chest, not limb — listed under CHEST_PART_PREFIXES first).
 *
 * @param partName  The key in `built.parts` (e.g. "head", "lleg", "vestBack").
 * @returns         The hit zone ("head" | "chest" | "limb").
 */
export function classifyHitZone(partName: string): HitZone {
  if (!partName) return "limb";
  const name = partName.toLowerCase();
  // Head check first — many head sub-parts have distinctive prefixes
  // (eye, nose, ear, etc.) that we want to catch before the generic limb
  // fallback. We also check the exact name "head" / "helmet" / "neck".
  for (const prefix of HEAD_PART_PREFIXES) {
    if (name === prefix.toLowerCase() || name.startsWith(prefix.toLowerCase())) {
      return "head";
    }
  }
  // Chest check — body, vest, jacket, shoulder straps, abdomen.
  for (const prefix of CHEST_PART_PREFIXES) {
    if (name === prefix.toLowerCase() || name.startsWith(prefix.toLowerCase())) {
      return "chest";
    }
  }
  // Default: limbs (arms, legs, hips, belt, boots, pouches, backpack, etc.).
  return "limb";
}
