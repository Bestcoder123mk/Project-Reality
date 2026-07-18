/**
 * Section C — Multi-material layered penetration model.
 *
 * The existing combat/penetration.ts handles SINGLE-surface penetration:
 * one bullet, one surface, residual velocity + damage. The WeaponSystem
 * raycast loop iterates through surfaces in the bullet's path, but the
 * per-surface math doesn't account for accumulated velocity degradation
 * across MULTIPLE layers (e.g. bullet passes through drywall + body +
 * drywall — each layer saps velocity).
 *
 * This module adds the layered model: a `PenetrationContext` that travels
 * with the bullet through all surfaces, accumulating:
 *
 *   - Total velocity degradation (multiplicative across layers).
 *   - Total damage falloff (multiplicative across layers).
 *   - Range budget consumed (the bullet has a finite penetration depth
 *     budget — once exceeded, it stops).
 *   - Layer count (a 9mm stops after 2 layers; a .338 LM continues for 6+).
 *   - Deflection accumulation (each layer adds a small random yaw).
 *
 * The model is grounded in real terminal ballistics:
 *
 *   - M855 (5.56mm FMJ) through typical residential wall (drywall + stud +
 *     drywall = 3 layers): penetrates with ~50% velocity loss + ~30%
 *     damage loss. Stops in the second stud.
 *   - M80 (7.62mm) through the same wall: penetrates clean with ~20%
 *     velocity loss. Will penetrate a second identical wall.
 *   - 9mm through drywall: penetrates one layer with ~40% velocity loss;
 *     stops in the second drywall layer.
 *   - .338 Lapua through brick wall: penetrates with ~30% velocity loss;
 *     retains enough energy to incapacitate a target behind.
 *   - 12ga buckshot pellet through drywall: each pellet penetrates one
 *     layer; pellets lose ~60% velocity. Stops in the second layer.
 *
 * This module composes with the existing MATERIAL_PENETRATION table — it
 * uses the same per-surface penetration depth + falloff data, but tracks
 * the accumulation across multiple layers.
 *
 * Tone reference: tactical-mil-sim-leaning-arcade. The model is grounded
 * in real ballistics but tuned for play-feel — a 5.56mm reliably penetrates
 * one interior wall; a 7.62mm reliably penetrates two; a .338 reliably
 * penetrates a brick wall. The player learns the caliber-vs-cover matrix.
 */

import {
  getRichPenetration,
  type RichMaterialPenetration,
} from "./penetration";
import { getCaliber, type CaliberProfile } from "./caliber-tables";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single layer the bullet has penetrated. */
export interface PenetrationLayer {
  /** Material slug. */
  surface: string;
  /** Layer thickness (m). */
  thicknessM: number;
  /** Entry velocity (m/s). */
  entryVelocityMps: number;
  /** Exit velocity (m/s). */
  exitVelocityMps: number;
  /** Damage multiplier applied after this layer (0..1). */
  damageFalloffMult: number;
  /** Whether the bullet deflected (grazing angle) in this layer. */
  deflected: boolean;
}

/** The accumulated state of a bullet's penetration through multiple layers. */
export interface PenetrationContext {
  /** Caliber slug firing this bullet. */
  caliberSlug: string;
  /** Initial muzzle velocity (m/s). */
  muzzleVelocityMps: number;
  /** Current velocity (m/s) — degrades as the bullet passes through layers. */
  currentVelocityMps: number;
  /** Total range budget remaining (m). Bullets lose penetration depth as they
   *  travel — a bullet at 100m has less penetration than at the muzzle. */
  remainingRangeBudgetM: number;
  /** Cumulative damage multiplier (0..1). Composed across all layers. */
  cumulativeDamageMult: number;
  /** Cumulative velocity multiplier (0..1). */
  cumulativeVelocityMult: number;
  /** Total layers penetrated so far. */
  layerCount: number;
  /** Per-layer record. */
  layers: PenetrationLayer[];
  /** True if the bullet has stopped (penetration budget exhausted). */
  stopped: boolean;
  /** Total accumulated deflection (radians). Each grazing hit adds yaw. */
  accumulatedDeflectionRad: number;
}

/** The result of attempting to penetrate a new layer. */
export interface PenetrationAttemptResult {
  /** True if the bullet penetrated the layer; false if it stopped in it. */
  penetrated: boolean;
  /** Updated context (new velocity, damage mult, layer count). */
  context: PenetrationContext;
  /** Exit velocity if penetrated (m/s). 0 if stopped. */
  exitVelocityMps: number;
  /** Damage multiplier to apply to the NEXT target hit (0..1). */
  nextTargetDamageMult: number;
  /** True if the bullet should deflect (ricochet-like) at this layer. */
  deflected: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-caliber penetration budget.
//
// Real-world data (FBI barrier penetration tests):
//   - 5.56mm M855: penetrates ~3 layers of drywall + 1 wood stud (≈0.15m total).
//   - 7.62mm M80: penetrates ~6 layers of drywall + 2 wood studs (≈0.30m total).
//   - 9mm: penetrates ~2 layers of drywall (≈0.08m total).
//   - .338 LM: penetrates ~0.30m of brick wall (≈0.30m effective on hard surfaces).
//   - 12ga buckshot pellet: penetrates ~1 layer of drywall (≈0.04m total).
// ─────────────────────────────────────────────────────────────────────────────

export const CALIBER_PENETRATION_BUDGET: Record<string, number> = {
  // Total penetration depth budget (m) at the muzzle.
  m855:        0.25,
  m80:         0.45,
  "9mm":       0.10,
  "338_lm":    0.65,
  "12ga_buck": 0.05,
};

/** Get the penetration budget for a caliber. */
export function getCaliberPenetrationBudget(slug: string): number {
  return CALIBER_PENETRATION_BUDGET[slug] ?? 0.20;
}

// ─────────────────────────────────────────────────────────────────────────────
// Range-driven penetration degradation.
//
// A bullet at long range has less velocity → less penetration. The
// penetration budget is scaled by the velocity retention:
//   budgetAtRange = baseBudget × (currentVelocity / muzzleVelocity)
//
// A 5.56mm at 300m (60% velocity) has 60% of its muzzle penetration
// budget — ~0.15m instead of 0.25m. This means a long-range shot won't
// reliably penetrate the same walls as a point-blank shot.
// ─────────────────────────────────────────────────────────────────────────────

export function penetrationBudgetAtRange(
  caliberSlug: string,
  currentVelocityMps: number,
  muzzleVelocityMps: number,
): number {
  const base = getCaliberPenetrationBudget(caliberSlug);
  const velocityRatio = Math.max(0, currentVelocityMps / Math.max(1, muzzleVelocityMps));
  return base * velocityRatio;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/** Create a fresh penetration context for a bullet at the muzzle. */
export function createPenetrationContext(
  caliberSlug: string,
  muzzleVelocityMps: number,
): PenetrationContext {
  return {
    caliberSlug,
    muzzleVelocityMps,
    currentVelocityMps: muzzleVelocityMps,
    remainingRangeBudgetM: getCaliberPenetrationBudget(caliberSlug),
    cumulativeDamageMult: 1.0,
    cumulativeVelocityMult: 1.0,
    layerCount: 0,
    layers: [],
    stopped: false,
    accumulatedDeflectionRad: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core penetration attempt — process a single new layer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to penetrate a new surface layer with the bullet's current state.
 *
 * The function:
 *   1. Looks up the surface's penetration profile (depth, falloff, exit vel).
 *   2. Computes the bullet's effective penetration depth at its current
 *      velocity (scaled by velocity ratio).
 *   3. Checks if the layer thickness exceeds the remaining budget. If yes,
 *      the bullet stops in this layer (no exit).
 *   4. Computes the exit velocity (entry × surface.exitVelocityMult, scaled
 *      by the layer thickness ratio if the layer is thicker than the
 *      surface's nominal penetration depth).
 *   5. Updates the cumulative damage multiplier (multiplicative across layers).
 *   6. Records the layer in the context's layer history.
 *   7. Returns the result — `penetrated=true` if the bullet continues,
 *      `penetrated=false` if it stopped.
 *
 * @param ctx              The current penetration context.
 * @param surface          The surface slug (e.g. "wood", "drywall").
 * @param thicknessM       The layer's thickness (m).
 * @param dotBulletNormal  The dot product of the bullet direction + surface
 *                         outward normal. Used to detect grazing hits (deflection).
 * @returns                The penetration attempt result.
 */
export function attemptLayerPenetration(
  ctx: PenetrationContext,
  surface: string,
  thicknessM: number,
  dotBulletNormal: number,
): PenetrationAttemptResult {
  if (ctx.stopped) {
    return {
      penetrated: false,
      context: ctx,
      exitVelocityMps: 0,
      nextTargetDamageMult: 0,
      deflected: false,
    };
  }

  const surfaceProfile: RichMaterialPenetration = getRichPenetration(surface);
  const entryVelocity = ctx.currentVelocityMps;

  // Step 1: check for grazing-angle deflection. The existing penetration.ts
  // DEFLECTION_ANGLE_RAD is 60° (π/3). If the bullet is hitting at a
  // grazing angle, it deflects instead of penetrating.
  const isGrazing = dotBulletNormal > -0.5 && dotBulletNormal < 0;
  if (isGrazing) {
    // Deflect — no penetration, but the bullet continues with reduced
    // velocity (40% of entry, per the existing deflectBulletDirection).
    const exitVel = entryVelocity * 0.4;
    const newCtx: PenetrationContext = {
      ...ctx,
      currentVelocityMps: exitVel,
      cumulativeVelocityMult: ctx.cumulativeVelocityMult * 0.4,
      accumulatedDeflectionRad: ctx.accumulatedDeflectionRad + 0.05,
    };
    return {
      penetrated: false,
      context: newCtx,
      exitVelocityMps: exitVel,
      nextTargetDamageMult: ctx.cumulativeDamageMult * 0.5, // ricochet damage
      deflected: true,
    };
  }

  // Step 2: compute the bullet's effective penetration depth at its current
  // velocity. Scaled by velocity ratio.
  const velocityRatio = entryVelocity / ctx.muzzleVelocityMps;
  const effectiveSurfaceDepth = surfaceProfile.maxPenetrationDepthM * velocityRatio;

  // Step 3: check if the layer thickness exceeds the remaining budget.
  // The remaining budget is the caliber's total penetration budget minus
  // the thickness already consumed in prior layers.
  if (thicknessM > ctx.remainingRangeBudgetM) {
    // Bullet stops in this layer. No exit.
    const stoppedCtx: PenetrationContext = {
      ...ctx,
      currentVelocityMps: 0,
      stopped: true,
      layerCount: ctx.layerCount + 1,
      layers: [...ctx.layers, {
        surface,
        thicknessM,
        entryVelocityMps: entryVelocity,
        exitVelocityMps: 0,
        damageFalloffMult: 0,
        deflected: false,
      }],
    };
    return {
      penetrated: false,
      context: stoppedCtx,
      exitVelocityMps: 0,
      nextTargetDamageMult: 0,
      deflected: false,
    };
  }

  // Step 4: compute exit velocity. The surface's exitVelocityMult is
  // applied. If the layer is thicker than the surface's nominal depth,
  // apply additional degradation (thicker layer = more energy lost).
  let exitVel = entryVelocity * surfaceProfile.exitVelocityMult;
  if (thicknessM > effectiveSurfaceDepth) {
    // Layer is thicker than the surface's nominal depth — additional
    // velocity loss proportional to the excess.
    const excess = (thicknessM - effectiveSurfaceDepth) / Math.max(0.01, effectiveSurfaceDepth);
    exitVel *= Math.max(0.2, 1 - excess * 0.5);
  }

  // Step 5: compute the damage falloff for this layer.
  let damageFalloff = surfaceProfile.damageFalloff;
  if (thicknessM > effectiveSurfaceDepth) {
    // Thicker layer = more damage lost.
    const excess = (thicknessM - effectiveSurfaceDepth) / Math.max(0.01, effectiveSurfaceDepth);
    damageFalloff *= Math.max(0.2, 1 - excess * 0.3);
  }

  // Step 6: update the context.
  const newCtx: PenetrationContext = {
    caliberSlug: ctx.caliberSlug,
    muzzleVelocityMps: ctx.muzzleVelocityMps,
    currentVelocityMps: exitVel,
    remainingRangeBudgetM: Math.max(0, ctx.remainingRangeBudgetM - thicknessM),
    cumulativeDamageMult: ctx.cumulativeDamageMult * damageFalloff,
    cumulativeVelocityMult: ctx.cumulativeVelocityMult * surfaceProfile.exitVelocityMult,
    layerCount: ctx.layerCount + 1,
    layers: [...ctx.layers, {
      surface,
      thicknessM,
      entryVelocityMps: entryVelocity,
      exitVelocityMps: exitVel,
      damageFalloffMult: damageFalloff,
      deflected: false,
    }],
    stopped: exitVel < 30, // stopped if velocity drops below 30 m/s
    accumulatedDeflectionRad: ctx.accumulatedDeflectionRad,
  };

  return {
    penetrated: !newCtx.stopped,
    context: newCtx,
    exitVelocityMps: exitVel,
    nextTargetDamageMult: newCtx.cumulativeDamageMult,
    deflected: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level helpers — common multi-layer scenarios.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate a bullet passing through a typical residential interior wall
 * (drywall + 2×4 wood stud + drywall). Returns the final damage multiplier
 * to apply to a target on the other side.
 *
 * Used for the "wallbang" damage calculation in WeaponSystem.
 */
export function penetrateInteriorWall(
  caliberSlug: string,
  muzzleVelocityMps: number,
): { damageMult: number; velocityMult: number; penetrated: boolean } {
  let ctx = createPenetrationContext(caliberSlug, muzzleVelocityMps);
  // Layer 1: drywall (0.012m = ½")
  ctx = attemptLayerPenetration(ctx, "drywall", 0.012, -1).context;
  if (ctx.stopped) return { damageMult: 0, velocityMult: 0, penetrated: false };
  // Layer 2: wood stud (0.090m = 3½")
  ctx = attemptLayerPenetration(ctx, "wood", 0.090, -1).context;
  if (ctx.stopped) return { damageMult: 0, velocityMult: 0, penetrated: false };
  // Layer 3: drywall (0.012m)
  ctx = attemptLayerPenetration(ctx, "drywall", 0.012, -1).context;
  return {
    damageMult: ctx.cumulativeDamageMult,
    velocityMult: ctx.cumulativeVelocityMult,
    penetrated: !ctx.stopped,
  };
}

/**
 * Simulate a bullet passing through a brick wall (0.10m thick).
 */
export function penetrateBrickWall(
  caliberSlug: string,
  muzzleVelocityMps: number,
): { damageMult: number; velocityMult: number; penetrated: boolean } {
  let ctx = createPenetrationContext(caliberSlug, muzzleVelocityMps);
  ctx = attemptLayerPenetration(ctx, "brick", 0.10, -1).context;
  return {
    damageMult: ctx.cumulativeDamageMult,
    velocityMult: ctx.cumulativeVelocityMult,
    penetrated: !ctx.stopped,
  };
}

/**
 * Simulate a bullet passing through a vehicle door (sheet metal + window
 * glass gap + sheet metal).
 */
export function penetrateVehicleDoor(
  caliberSlug: string,
  muzzleVelocityMps: number,
): { damageMult: number; velocityMult: number; penetrated: boolean } {
  let ctx = createPenetrationContext(caliberSlug, muzzleVelocityMps);
  // Outer door skin (0.001m sheet metal)
  ctx = attemptLayerPenetration(ctx, "sheet_metal", 0.001, -1).context;
  if (ctx.stopped) return { damageMult: 0, velocityMult: 0, penetrated: false };
  // Window glass (0.005m) — if window is rolled up
  ctx = attemptLayerPenetration(ctx, "glass", 0.005, -1).context;
  if (ctx.stopped) return { damageMult: 0, velocityMult: 0, penetrated: false };
  // Inner door skin (0.001m sheet metal)
  ctx = attemptLayerPenetration(ctx, "sheet_metal", 0.001, -1).context;
  return {
    damageMult: ctx.cumulativeDamageMult,
    velocityMult: ctx.cumulativeVelocityMult,
    penetrated: !ctx.stopped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Soft-target (enemy body) penetration layer.
//
// A bullet hitting an enemy also passes through a "soft target" layer
// before potentially hitting another surface behind. The soft target's
// effective thickness depends on the body region + the bullet's
// characteristics.
// ─────────────────────────────────────────────────────────────────────────────

/** Approximate soft-target thickness by hit region (m). */
export const SOFT_TARGET_THICKNESS: Record<string, number> = {
  head:  0.18, // front-to-back skull
  chest: 0.30, // chest front-to-back (heart, lungs, spine)
  abdomen: 0.25,
  limb:  0.12, // arm/leg
  neck:  0.13,
};

/** Effective soft-target surface slug (the body behaves like a dense fluid). */
export const SOFT_TARGET_SURFACE_SLUG = "flesh";

/**
 * Custom penetration profile for soft targets. The body is denser than
 * water but less dense than muscle-only tissue (we use a simplified model).
 */
export const SOFT_TARGET_PROFILE: RichMaterialPenetration = {
  slug: "flesh",
  name: "Soft Tissue",
  maxPenetrationDepthM: 0.30, // rifle round penetrates ~30cm of flesh
  exitVelocityMult: 0.55,     // 55% velocity retained after passing through
  deflectionAngleRad: Math.PI / 3, // 60° grazing
  damageFalloff: 0.40,        // 40% damage retained after passing through
};

/**
 * Compute the penetration context after passing through a soft target.
 * Uses the soft-target profile above.
 */
export function penetrateSoftTarget(
  ctx: PenetrationContext,
  hitRegion: string,
): { context: PenetrationContext; penetrated: boolean; overpenetrationMult: number } {
  const thickness = SOFT_TARGET_THICKNESS[hitRegion] ?? 0.25;
  // Use the soft-target profile directly.
  const velocityRatio = ctx.currentVelocityMps / ctx.muzzleVelocityMps;
  const effectiveDepth = SOFT_TARGET_PROFILE.maxPenetrationDepthM * velocityRatio;

  if (thickness > ctx.remainingRangeBudgetM || thickness > effectiveDepth * 1.5) {
    // Bullet stops in the body. No overpenetration.
    const newCtx: PenetrationContext = {
      ...ctx,
      currentVelocityMps: 0,
      stopped: true,
      layerCount: ctx.layerCount + 1,
      layers: [...ctx.layers, {
        surface: SOFT_TARGET_SURFACE_SLUG,
        thicknessM: thickness,
        entryVelocityMps: ctx.currentVelocityMps,
        exitVelocityMps: 0,
        damageFalloffMult: 0,
        deflected: false,
      }],
    };
    return { context: newCtx, penetrated: false, overpenetrationMult: 0 };
  }

  // Bullet passes through — overpenetration. The next target behind takes
  // reduced damage.
  const exitVel = ctx.currentVelocityMps * SOFT_TARGET_PROFILE.exitVelocityMult;
  const newCtx: PenetrationContext = {
    ...ctx,
    currentVelocityMps: exitVel,
    remainingRangeBudgetM: Math.max(0, ctx.remainingRangeBudgetM - thickness),
    cumulativeDamageMult: ctx.cumulativeDamageMult * SOFT_TARGET_PROFILE.damageFalloff,
    cumulativeVelocityMult: ctx.cumulativeVelocityMult * SOFT_TARGET_PROFILE.exitVelocityMult,
    layerCount: ctx.layerCount + 1,
    layers: [...ctx.layers, {
      surface: SOFT_TARGET_SURFACE_SLUG,
      thicknessM: thickness,
      entryVelocityMps: ctx.currentVelocityMps,
      exitVelocityMps: exitVel,
      damageFalloffMult: SOFT_TARGET_PROFILE.damageFalloff,
      deflected: false,
    }],
    stopped: exitVel < 30,
  };

  return {
    context: newCtx,
    penetrated: !newCtx.stopped,
    overpenetrationMult: newCtx.cumulativeDamageMult,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic / debug helpers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Summarize a penetration context as a human-readable string. Used by the
 * debug HUD + the gunsmith's "penetration simulator" view.
 */
export function summarizePenetration(ctx: PenetrationContext): string {
  if (ctx.layerCount === 0) return `${ctx.caliberSlug} — no layers hit`;
  const layerStrs = ctx.layers.map(
    (l) => `${l.surface}(${(l.thicknessM * 100).toFixed(1)}cm: ${l.entryVelocityMps.toFixed(0)}→${l.exitVelocityMps.toFixed(0)}m/s)`,
  );
  const status = ctx.stopped ? "STOPPED" : `continues @ ${ctx.currentVelocityMps.toFixed(0)}m/s`;
  return `${ctx.caliberSlug} — ${ctx.layerCount} layers: ${layerStrs.join(", ")} — ${status} — dmg × ${ctx.cumulativeDamageMult.toFixed(2)}`;
}

/**
 * Get the caliber profile for a penetration context (for the gunsmith UI).
 */
export function getPenetrationCaliber(ctx: PenetrationContext): CaliberProfile {
  return getCaliber(ctx.caliberSlug);
}
