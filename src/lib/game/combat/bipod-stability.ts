/**
 * Section D — Bipod Stability System.
 *
 * Real-world bipods (Harris, Atlas, GG&G, integrated M4 / SCAR) provide
 * a hard mechanical rest for the weapon's fore-end, eliminating muscle
 * fatigue and dramatically reducing both sway and felt recoil. Snipers
 * and machine-gunners rely on bipods for sustained precision fire.
 *
 * Physics:
 *   • Bipod leg geometry converts vertical recoil into horizontal motion
 *     (the legs dig in instead of the muzzle climbing). Reduces vertical
 *     climb by 60-90% depending on the surface.
 *   • The bipod removes ~85% of sway because the weapon's mass is
 *     supported by a rigid tripod (the two bipod legs + the shooter's
 *     shoulder form a triangle).
 *   • Surface matters: soft dirt lets the bipod dig in (max grip), hard
 *     concrete causes the bipod to skip (less grip), smooth surfaces
 *     (glass, ice) cause the bipod to slide.
 *   • Deployed weapons are constrained in traverse (horizontal swing)
 *     and elevation — typically ±15° horizontal, ±10° vertical. Outside
 *     this cone, the player must re-deploy.
 *
 * This module provides:
 *   1. Per-weapon bipod compatibility (which weapons accept a bipod).
 *   2. Per-surface grip coefficients (dirt, concrete, sand, etc.).
 *   3. Deployment state machine (stowed → deploying → deployed → stowing).
 *   4. Recoil reduction + sway reduction multipliers when deployed.
 *   5. Traverse / elevation cone constraints.
 *   6. Bipod type database (Harris, Atlas, integrated, etc.).
 *
 * Engine integration: the WeaponSystem reads `bipodRecoilMultiplier()`
 * to reduce recoil; the ProceduralAnimSystem reads `bipodSwayMultiplier()`
 * (the weapon-sway module already uses 0.1× when bipodDeployed is true);
 * the InputSystem reads `tickBipodDeployment()` per frame and
 * `canRotateTo()` to gate aim within the deployed cone.
 */

import type { WeaponType, WeaponCategory } from "../store";
import type { AttachmentSlug } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Bipod types — real-world manufacturer + model database.
// ─────────────────────────────────────────────────────────────────────────────

export type BipodType =
  | "none"
  | "harris_br"        // Harris Engineering BR (hunting/sniper classic)
  | "harris_lm"        // Harris LM (taller, for LMGs)
  | "atlas_bt10"       // B&T Atlas BT10 (modular, AR-pattern)
  | "ggg_pivot"        // GG&G pivot bipod (rapid-deploy)
  | "scar_integrated"  // SCAR-H integrated folding bipod
  | "m4_integrated"    // M4-style integrated (M27 IAR / M4A1)
  | "m249_integrated"  // M249 / M240 fixed integral bipod
  | "rpk_integrated"   // RPK / PKM fixed integral bipod
  | "grip_pod"         // Grip-Pod (vertical grip + folding bipod combo)
  | "arca_swiss";      // ARCA Swiss precision (for AX50 / AI chassis)

export interface BipodSpec {
  type: BipodType;
  /** Real-world manufacturer. */
  manufacturer: string;
  /** Mass (grams). */
  massG: number;
  /** Stowed length (mm) — when folded against the handguard. */
  stowedLengthMm: number;
  /** Deployed leg length (mm) — from mount to foot. */
  deployedLengthMm: number;
  /** Adjustability range (mm) — most bipods have ±25mm leg adjustment. */
  legAdjustMm: number;
  /** Whether the bipod pans (rotates around the mount). */
  pans: boolean;
  /** Whether the bipod tilts (rolls side-to-side). */
  tilts: boolean;
  /** Tilt range (deg) — most tilting bipods allow ±15°. */
  tiltRangeDeg: number;
  /** Recoil reduction factor (0..1) when deployed on firm surface. */
  recoilReductionFactor: number;
  /** Sway reduction factor (0..1) when deployed. */
  swayReductionFactor: number;
  /** Time to deploy from stowed (ms). */
  deployMs: number;
  /** Time to stow (ms). */
  stowMs: number;
  /** Attachment weight contribution (for movement speed penalty). */
  weightPenaltyKg: number;
}

export const BIPOD_SPECS: Record<BipodType, BipodSpec> = {
  none: {
    type: "none", manufacturer: "—", massG: 0,
    stowedLengthMm: 0, deployedLengthMm: 0, legAdjustMm: 0,
    pans: false, tilts: false, tiltRangeDeg: 0,
    recoilReductionFactor: 0, swayReductionFactor: 0,
    deployMs: 0, stowMs: 0, weightPenaltyKg: 0,
  },
  harris_br: {
    type: "harris_br", manufacturer: "Harris Engineering", massG: 380,
    stowedLengthMm: 170, deployedLengthMm: 240, legAdjustMm: 25,
    pans: false, tilts: true, tiltRangeDeg: 15,
    recoilReductionFactor: 0.78, swayReductionFactor: 0.85,
    deployMs: 1100, stowMs: 800, weightPenaltyKg: 0.38,
  },
  harris_lm: {
    type: "harris_lm", manufacturer: "Harris Engineering", massG: 510,
    stowedLengthMm: 230, deployedLengthMm: 320, legAdjustMm: 30,
    pans: false, tilts: true, tiltRangeDeg: 15,
    recoilReductionFactor: 0.80, swayReductionFactor: 0.87,
    deployMs: 1200, stowMs: 900, weightPenaltyKg: 0.51,
  },
  atlas_bt10: {
    type: "atlas_bt10", manufacturer: "B&T USA (Accuracy International)", massG: 340,
    stowedLengthMm: 165, deployedLengthMm: 220, legAdjustMm: 30,
    pans: true, tilts: true, tiltRangeDeg: 20,
    recoilReductionFactor: 0.82, swayReductionFactor: 0.88,
    deployMs: 900, stowMs: 700, weightPenaltyKg: 0.34,
  },
  ggg_pivot: {
    type: "ggg_pivot", manufacturer: "GG&G", massG: 410,
    stowedLengthMm: 175, deployedLengthMm: 250, legAdjustMm: 25,
    pans: true, tilts: true, tiltRangeDeg: 25,
    recoilReductionFactor: 0.76, swayReductionFactor: 0.83,
    deployMs: 700, stowMs: 500, weightPenaltyKg: 0.41,
  },
  scar_integrated: {
    type: "scar_integrated", manufacturer: "FN Herstal (integrated)", massG: 280,
    stowedLengthMm: 0, deployedLengthMm: 200, legAdjustMm: 0,
    pans: false, tilts: true, tiltRangeDeg: 12,
    recoilReductionFactor: 0.75, swayReductionFactor: 0.82,
    deployMs: 500, stowMs: 350, weightPenaltyKg: 0.0, // already in base weight
  },
  m4_integrated: {
    type: "m4_integrated", manufacturer: "various (KAC / Daniel Defense)", massG: 250,
    stowedLengthMm: 0, deployedLengthMm: 180, legAdjustMm: 0,
    pans: false, tilts: false, tiltRangeDeg: 0,
    recoilReductionFactor: 0.70, swayReductionFactor: 0.78,
    deployMs: 550, stowMs: 400, weightPenaltyKg: 0.0,
  },
  m249_integrated: {
    type: "m249_integrated", manufacturer: "FN Herstal (integral)", massG: 600,
    stowedLengthMm: 0, deployedLengthMm: 280, legAdjustMm: 0,
    pans: true, tilts: true, tiltRangeDeg: 18,
    recoilReductionFactor: 0.85, swayReductionFactor: 0.92,
    deployMs: 350, stowMs: 250, weightPenaltyKg: 0.0,
  },
  rpk_integrated: {
    type: "rpk_integrated", manufacturer: "Izhmash (integral)", massG: 520,
    stowedLengthMm: 0, deployedLengthMm: 260, legAdjustMm: 0,
    pans: false, tilts: false, tiltRangeDeg: 0,
    recoilReductionFactor: 0.82, swayReductionFactor: 0.88,
    deployMs: 380, stowMs: 280, weightPenaltyKg: 0.0,
  },
  grip_pod: {
    type: "grip_pod", manufacturer: "Grip Pod Systems", massG: 290,
    stowedLengthMm: 0, deployedLengthMm: 195, legAdjustMm: 0,
    pans: false, tilts: false, tiltRangeDeg: 0,
    recoilReductionFactor: 0.65, swayReductionFactor: 0.75,
    deployMs: 350, stowMs: 250, weightPenaltyKg: 0.29,
  },
  arca_swiss: {
    type: "arca_swiss", manufacturer: "ARCA Swiss", massG: 480,
    stowedLengthMm: 200, deployedLengthMm: 280, legAdjustMm: 40,
    pans: true, tilts: true, tiltRangeDeg: 30,
    recoilReductionFactor: 0.85, swayReductionFactor: 0.92,
    deployMs: 800, stowMs: 600, weightPenaltyKg: 0.48,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-weapon bipod compatibility + default bipod type.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a weapon accepts a bipod (has a fore-end rail or integral bipod). */
export function weaponAcceptsBipod(weapon: WeaponType): boolean {
  // Snipers, DMRs, LMGs, and battle rifles accept bipods.
  // SMGs, pistols, shotguns, and most carbines don't (too short fore-end).
  switch (weapon) {
    case "m249": case "mk48": case "m240b": case "rpk": case "rpk16": case "pkm":
      return true; // LMGs — integral bipod
    case "awp": case "l115a3": case "m110": case "kar98k":
      return true; // Snipers
    case "scarh": case "mk17": case "mk14": case "svd": // DMRs + battle rifles
      return true;
    case "m4": case "m4a1": case "hk416": case "mk12": // AR-pattern with bipod mount
      return true;
    default:
      return false;
  }
}

/** Default bipod type for a weapon (integral bipod for LMGs etc.). */
export function defaultBipodFor(weapon: WeaponType): BipodType {
  switch (weapon) {
    case "m249": case "mk48": return "m249_integrated";
    case "rpk": case "rpk16": return "rpk_integrated";
    case "pkm": return "rpk_integrated";
    case "scarh": case "mk17": return "scar_integrated";
    case "awp": case "l115a3": return "atlas_bt10";
    case "m110": case "mk14": return "atlas_bt10";
    case "m4": case "hk416": case "mk12": return "m4_integrated";
    default: return "none";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Surface grip coefficients — how well a bipod bites into the surface.
// Real-world reference:
//   • Dirt / sand — bipod digs in, max grip (1.0)
//   • Grass — moderate grip, slight sliding (0.85)
//   • Wood (logs / barricade) — moderate, depends on grain (0.75)
//   • Concrete — bipod skips, lower grip (0.60)
//   • Metal / vehicle hood — low grip, smooth (0.45)
//   • Glass — almost no grip, bipod slides (0.20)
//   • Ice — minimum grip (0.10)
// ─────────────────────────────────────────────────────────────────────────────

export type BipodSurface =
  | "dirt"
  | "sand"
  | "grass"
  | "wood"
  | "concrete"
  | "metal"
  | "glass"
  | "ice"
  | "water"; // bipod submerged — very high drag

export interface SurfaceGrip {
  /** Surface type. */
  surface: BipodSurface;
  /** Grip coefficient (0..1). 1 = perfect, 0 = bipod slides freely. */
  grip: number;
  /** Recoil reduction multiplier (0..1). Lower = less reduction on this surface. */
  recoilReductionMult: number;
  /** Sway reduction multiplier (0..1). */
  swayReductionMult: number;
  /** Whether the bipod digs in (visible effect + extra grip). */
  digsIn: boolean;
  /** Friendly label. */
  label: string;
}

export const SURFACE_GRIP: Record<BipodSurface, SurfaceGrip> = {
  dirt:     { surface: "dirt",     grip: 1.00, recoilReductionMult: 1.00, swayReductionMult: 1.00, digsIn: true,  label: "Soft Dirt" },
  sand:     { surface: "sand",     grip: 0.95, recoilReductionMult: 0.95, swayReductionMult: 0.95, digsIn: true,  label: "Sand" },
  grass:    { surface: "grass",    grip: 0.85, recoilReductionMult: 0.90, swayReductionMult: 0.95, digsIn: false, label: "Grass" },
  wood:     { surface: "wood",     grip: 0.75, recoilReductionMult: 0.85, swayReductionMult: 0.90, digsIn: false, label: "Wood" },
  concrete: { surface: "concrete", grip: 0.60, recoilReductionMult: 0.70, swayReductionMult: 0.85, digsIn: false, label: "Concrete" },
  metal:    { surface: "metal",    grip: 0.45, recoilReductionMult: 0.55, swayReductionMult: 0.75, digsIn: false, label: "Metal" },
  glass:    { surface: "glass",    grip: 0.20, recoilReductionMult: 0.30, swayReductionMult: 0.50, digsIn: false, label: "Glass" },
  ice:      { surface: "ice",      grip: 0.10, recoilReductionMult: 0.15, swayReductionMult: 0.40, digsIn: false, label: "Ice" },
  water:    { surface: "water",    grip: 0.30, recoilReductionMult: 0.40, swayReductionMult: 0.60, digsIn: false, label: "Water (submerged)" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Deployment state machine.
// ─────────────────────────────────────────────────────────────────────────────

export type BipodState = "stowed" | "deploying" | "deployed" | "stowing";

export interface BipodRuntimeState {
  /** Current deployment state. */
  state: BipodState;
  /** Bipod type (fixed per weapon, but can be swapped via attachments). */
  bipodType: BipodType;
  /** Deployment progress (0..1) when transitioning. */
  progress: number;
  /** Whether the bipod is currently in contact with a surface. */
  inContact: boolean;
  /** The surface the bipod is resting on (null if not in contact). */
  contactSurface: BipodSurface | null;
  /** The deployed cone center direction (radians, weapon-local yaw). */
  deployedCenterYawRad: number;
  /** The deployed cone center direction (radians, weapon-local pitch). */
  deployedCenterPitchRad: number;
  /** Traverse cone (radians) — horizontal aim range when deployed. */
  traverseConeRad: number;
  /** Elevation cone (radians) — vertical aim range when deployed. */
  elevationConeRad: number;
}

export function initBipodState(weapon: WeaponType, attachment: AttachmentSlug = "none"): BipodRuntimeState {
  void attachment;
  const bipodType = defaultBipodFor(weapon);
  return {
    state: "stowed",
    bipodType,
    progress: 0,
    inContact: false,
    contactSurface: null,
    deployedCenterYawRad: 0,
    deployedCenterPitchRad: 0,
    // Default cone — ±15° horizontal, ±10° vertical (Atlas bipod).
    traverseConeRad: degToRad(15),
    elevationConeRad: degToRad(10),
  };
}

/** Begin deployment (player presses the bipod key while aiming at surface). */
export function deployBipod(state: BipodRuntimeState): BipodRuntimeState {
  if (state.bipodType === "none") return state;
  if (state.state !== "stowed") return state;
  return { ...state, state: "deploying", progress: 0 };
}

/** Begin stowing (player releases the bipod key or moves out of cone). */
export function stowBipod(state: BipodRuntimeState): BipodRuntimeState {
  if (state.bipodType === "none") return state;
  if (state.state === "deployed") {
    return { ...state, state: "stowing", progress: 0 };
  }
  if (state.state === "deploying") {
    // Cancel deployment — return to stowed.
    return { ...state, state: "stowed", progress: 0 };
  }
  return state;
}

/** Tick the deployment state machine by dt milliseconds. */
export function tickBipodDeployment(
  state: BipodRuntimeState,
  dtMs: number,
): BipodRuntimeState {
  if (state.bipodType === "none") return state;
  const spec = BIPOD_SPECS[state.bipodType];

  if (state.state === "deploying") {
    const progress = state.progress + dtMs / spec.deployMs;
    if (progress >= 1) {
      // Snap to deployed state. The deployed cone is centered on the
      // current aim direction.
      return {
        ...state,
        state: "deployed",
        progress: 1,
        // The cone center is set when the bipod first achieves contact.
        // (Caller should update deployedCenterYaw/Pitch when bipod first
        // touches down.)
      };
    }
    return { ...state, progress };
  }

  if (state.state === "stowing") {
    const progress = state.progress + dtMs / spec.stowMs;
    if (progress >= 1) {
      return {
        ...state,
        state: "stowed",
        progress: 0,
        inContact: false,
        contactSurface: null,
      };
    }
    return { ...state, progress };
  }

  return state;
}

/** Set the contact surface for the bipod (called by the engine when the
 *  bipod raycast hits a surface). */
export function setBipodContact(
  state: BipodRuntimeState,
  inContact: boolean,
  surface: BipodSurface | null,
  yawRad: number,
  pitchRad: number,
): BipodRuntimeState {
  if (!inContact || surface === null) {
    return { ...state, inContact: false, contactSurface: null };
  }
  // If this is the first contact in deployed state, lock the cone center.
  const firstContact = !state.inContact;
  return {
    ...state,
    inContact: true,
    contactSurface: surface,
    deployedCenterYawRad: firstContact ? yawRad : state.deployedCenterYawRad,
    deployedCenterPitchRad: firstContact ? pitchRad : state.deployedCenterPitchRad,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aim cone constraints — when deployed, the aim is constrained to a cone.
// ─────────────────────────────────────────────────────────────────────────────

export interface AimConeCheck {
  /** True if the aim direction is within the deployed cone. */
  withinCone: boolean;
  /** Yaw offset from cone center (rad). */
  yawOffsetRad: number;
  /** Pitch offset from cone center (rad). */
  pitchOffsetRad: number;
  /** Recommended action if outside the cone. */
  action: "ok" | "redeploy" | "stow";
}

/** Check if the current aim direction is within the deployed cone. */
export function canRotateTo(
  state: BipodRuntimeState,
  yawRad: number,
  pitchRad: number,
): AimConeCheck {
  if (state.state !== "deployed" || !state.inContact) {
    return { withinCone: true, yawOffsetRad: 0, pitchOffsetRad: 0, action: "ok" };
  }
  const yawOffset = yawRad - state.deployedCenterYawRad;
  const pitchOffset = pitchRad - state.deployedCenterPitchRad;
  const withinYaw = Math.abs(yawOffset) <= state.traverseConeRad;
  const withinPitch = Math.abs(pitchOffset) <= state.elevationConeRad;
  const withinCone = withinYaw && withinPitch;
  let action: AimConeCheck["action"] = "ok";
  if (!withinCone) {
    // If very far outside, recommend stow. Otherwise recommend redeploy.
    const maxOffset = Math.max(Math.abs(yawOffset), Math.abs(pitchOffset));
    action = maxOffset > state.traverseConeRad * 2 ? "stow" : "redeploy";
  }
  return { withinCone, yawOffsetRad: yawOffset, pitchOffsetRad: pitchOffset, action };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recoil + sway multipliers — the gameplay effect of a deployed bipod.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recoil multiplier (0..1) for the current bipod state. 1 = full recoil,
 * 0 = no recoil. Called by the WeaponSystem per shot.
 */
export function bipodRecoilMultiplier(state: BipodRuntimeState): number {
  if (state.state !== "deployed" || !state.inContact || state.bipodType === "none") {
    return 1.0;
  }
  const spec = BIPOD_SPECS[state.bipodType];
  const surface = state.contactSurface ? SURFACE_GRIP[state.contactSurface] : null;
  if (!surface) return 1.0;
  // Multiply the bipod's base reduction by the surface's reduction multiplier.
  const effectiveReduction = spec.recoilReductionFactor * surface.recoilReductionMult;
  return 1.0 - effectiveReduction;
}

/**
 * Sway multiplier (0..1) for the current bipod state. 1 = full sway,
 * 0 = no sway. Called by the weapon-sway module.
 */
export function bipodSwayMultiplier(state: BipodRuntimeState): number {
  if (state.state !== "deployed" || !state.inContact || state.bipodType === "none") {
    return 1.0;
  }
  const spec = BIPOD_SPECS[state.bipodType];
  const surface = state.contactSurface ? SURFACE_GRIP[state.contactSurface] : null;
  if (!surface) return 1.0;
  const effectiveReduction = spec.swayReductionFactor * surface.swayReductionMult;
  return 1.0 - effectiveReduction;
}

/**
 * Movement speed multiplier when the bipod is deployed. Deployed bipod
 * = no movement (the bipod is a fixed rest).
 */
export function bipodMovementMultiplier(state: BipodRuntimeState): number {
  if (state.state === "deployed") return 0.0;
  if (state.state === "deploying" || state.state === "stowing") return 0.3;
  // Bipod weight penalty when stowed (small movement penalty).
  if (state.bipodType === "none") return 1.0;
  const spec = BIPOD_SPECS[state.bipodType];
  // 0.5kg bipod = ~2% movement penalty.
  return 1.0 - Math.min(0.10, spec.weightPenaltyKg * 0.04);
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: aggregate "is bipod active and beneficial" check.
// ─────────────────────────────────────────────────────────────────────────────

/** True if the bipod is deployed + in contact (providing full benefit). */
export function isBipodBeneficial(state: BipodRuntimeState): boolean {
  return state.state === "deployed" && state.inContact && state.bipodType !== "none";
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD helpers.
// ─────────────────────────────────────────────────────────────────────────────

export function bipodStateLabel(state: BipodRuntimeState): string {
  switch (state.state) {
    case "stowed":    return "BIPOD STOWED";
    case "deploying": return "DEPLOYING…";
    case "deployed":  return state.inContact ? "BIPOD DEPLOYED" : "BIPOD READY (NO SURFACE)";
    case "stowing":   return "STOWING…";
  }
}

export function bipodStateColor(state: BipodRuntimeState): string {
  switch (state.state) {
    case "stowed":    return "#9ca3af"; // gray
    case "deploying": return "#f59e0b"; // amber
    case "deployed":  return state.inContact ? "#10b981" : "#ef4444"; // green if in contact, red if not
    case "stowing":   return "#f59e0b"; // amber
  }
}

/** Surface quality label for the HUD (visible when bipod is deployed). */
export function surfaceQualityLabel(surface: BipodSurface | null): string {
  if (surface === null) return "NO SURFACE";
  const grip = SURFACE_GRIP[surface].grip;
  if (grip >= 0.90) return "EXCELLENT GRIP";
  if (grip >= 0.75) return "GOOD GRIP";
  if (grip >= 0.55) return "FAIR GRIP";
  if (grip >= 0.30) return "POOR GRIP";
  return "NO GRIP";
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-category defaults — for the AI + the Gunsmith UI.
// ─────────────────────────────────────────────────────────────────────────────

/** Recommended deployment surface for each weapon category. */
export function recommendedSurfaceFor(category: WeaponCategory): BipodSurface {
  switch (category) {
    case "LMG":    return "dirt";     // LMGs want maximum dig-in
    case "SNIPER": return "sand";     // Snipers want stability + view
    case "RIFLE":  return "wood";     // DMRs typically deploy on barricades
    default:       return "dirt";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers.
// ─────────────────────────────────────────────────────────────────────────────

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
