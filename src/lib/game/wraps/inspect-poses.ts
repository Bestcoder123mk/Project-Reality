/**
 * Section E — Per-skin inspect pose overrides.
 *
 * When the player triggers the weapon-inspect animation (R-key / inspect
 * button), the viewmodel plays a canned "rotate + tilt" pose. Section E
 * prompts 09951–10000 call for per-skin inspect pose overrides so each
 * skin gets a bespoke inspection: a holographic skin is angled to catch
 * the iridescent sheen; a kraken-engraving skin is tilted so the tentacle
 * relief reads in profile; a thermochromic skin is held near the muzzle
 * so the heat-shift is visible.
 *
 * Each override is a typed pose (camera offset, weapon rotation, focus
 * point, duration). The viewmodel animation system blends from the
 * current pose to the override over `blendInMs`, holds for `holdMs`,
 * then blends back out. Skins without an override fall through to the
 * default inspect pose.
 *
 * The pose data is also exposed declaratively so the gunsmith UI can
 * preview each skin's inspect animation without entering a match.
 */
import type { SkinCatalogEntry, SkinPatternFamily, SkinRarity } from "./skin-catalog";

// ─── Pose types ─────────────────────────────────────────────────────────────

export interface InspectPose {
  /** Pose ID — used for lookup + UI display. */
  id: string;
  /** Camera offset relative to the viewmodel rest position (meters). */
  cameraOffset: [number, number, number];
  /** Weapon rotation (Euler radians, XYZ). */
  weaponRotation: [number, number, number];
  /** Weapon translation offset (meters). */
  weaponOffset: [number, number, number];
  /** Focal point — where the camera looks on the weapon (meters, weapon-local). */
  focalPoint: [number, number, number];
  /** Field-of-view override during inspect (degrees). 0 = no change. */
  fovOverride: number;
  /** Blend-in duration (ms). */
  blendInMs: number;
  /** Hold duration (ms) — how long the pose holds before blending out. */
  holdMs: number;
  /** Blend-out duration (ms). */
  blendOutMs: number;
  /** Optional slow-rotate speed (radians/s) — weapon rotates during hold. */
  slowRotateRadPerSec: number;
  /** Optional ambient particle effect tag ("sparkles", "embers", "snow"). */
  ambientFx?: string;
  /** Display name for the gunsmith UI. */
  label: string;
}

// ─── Default + per-pattern-family poses ─────────────────────────────────────

export const DEFAULT_INSPECT_POSE: InspectPose = {
  id: "default",
  cameraOffset: [0.05, 0.02, -0.05],
  weaponRotation: [0.1, -0.6, 0.2],
  weaponOffset: [0, 0, 0],
  focalPoint: [0, 0, 0.15],
  fovOverride: 0,
  blendInMs: 220,
  holdMs: 2400,
  blendOutMs: 260,
  slowRotateRadPerSec: 0,
  label: "Standard",
};

/** Per-pattern-family inspect pose overrides. */
export const PATTERN_INSPECT_POSES: Partial<Record<SkinPatternFamily, InspectPose>> = {
  gold_filigree: {
    id: "gold_filigree",
    cameraOffset: [0.06, 0.03, -0.08],
    weaponRotation: [0.15, -0.8, 0.3],
    weaponOffset: [0, 0.005, 0],
    focalPoint: [0, 0.005, 0.18],
    fovOverride: 45,
    blendInMs: 250,
    holdMs: 2800,
    blendOutMs: 300,
    slowRotateRadPerSec: 0.2,
    ambientFx: "gold_dust",
    label: "Filigree Close-up",
  },
  holographic_foil: {
    id: "holographic_foil",
    cameraOffset: [0.08, 0.02, -0.04],
    weaponRotation: [0.2, -0.4, 0.4],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 40,
    blendInMs: 280,
    holdMs: 3200,
    blendOutMs: 320,
    slowRotateRadPerSec: 0.5,
    ambientFx: "holo_sparkle",
    label: "Holographic Tilt",
  },
  thermochromic_heat: {
    id: "thermochromic_heat",
    cameraOffset: [0.04, 0.01, 0.02],
    weaponRotation: [0.05, -0.3, 0.1],
    weaponOffset: [0, 0, 0.05],
    focalPoint: [0, 0, 0.25],
    fovOverride: 38,
    blendInMs: 260,
    holdMs: 3500,
    blendOutMs: 280,
    slowRotateRadPerSec: 0,
    ambientFx: "heat_haze",
    label: "Heat Inspection",
  },
  kraken_tentacle_engraving: {
    id: "kraken_tentacle_engraving",
    cameraOffset: [0.07, 0.0, -0.06],
    weaponRotation: [0.0, -1.0, 0.5],
    weaponOffset: [0, -0.005, 0],
    focalPoint: [-0.02, 0, 0.12],
    fovOverride: 42,
    blendInMs: 240,
    holdMs: 3000,
    blendOutMs: 280,
    slowRotateRadPerSec: 0.3,
    ambientFx: "ink_swirl",
    label: "Tentacle Profile",
  },
  lava_crackle: {
    id: "lava_crackle",
    cameraOffset: [0.05, 0.02, 0.0],
    weaponRotation: [0.1, -0.5, 0.2],
    weaponOffset: [0, 0, 0.04],
    focalPoint: [0, 0, 0.2],
    fovOverride: 40,
    blendInMs: 260,
    holdMs: 2800,
    blendOutMs: 280,
    slowRotateRadPerSec: 0.15,
    ambientFx: "embers",
    label: "Magma Hold",
  },
  galaxy_nebula: {
    id: "galaxy_nebula",
    cameraOffset: [0.06, 0.04, -0.05],
    weaponRotation: [0.2, -0.6, 0.3],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.18],
    fovOverride: 50,
    blendInMs: 300,
    holdMs: 3500,
    blendOutMs: 320,
    slowRotateRadPerSec: 0.4,
    ambientFx: "stars",
    label: "Cosmic Vista",
  },
  neon_cyberpunk: {
    id: "neon_cyberpunk",
    cameraOffset: [0.08, 0.0, -0.02],
    weaponRotation: [0.0, -0.4, 0.6],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.1],
    fovOverride: 48,
    blendInMs: 200,
    holdMs: 2600,
    blendOutMs: 240,
    slowRotateRadPerSec: 0.6,
    ambientFx: "neon_glow",
    label: "Neon Snap",
  },
  vaporwave_grid: {
    id: "vaporwave_grid",
    cameraOffset: [0.07, 0.05, -0.04],
    weaponRotation: [0.3, -0.5, 0.4],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 52,
    blendInMs: 280,
    holdMs: 3000,
    blendOutMs: 280,
    slowRotateRadPerSec: 0.5,
    ambientFx: "vapor_trail",
    label: "Vaporwave Drift",
  },
  geometric_memphis: {
    id: "geometric_memphis",
    cameraOffset: [0.06, 0.03, -0.04],
    weaponRotation: [0.1, -0.7, 0.2],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 44,
    blendInMs: 240,
    holdMs: 2800,
    blendOutMs: 260,
    slowRotateRadPerSec: 0.25,
    ambientFx: "confetti",
    label: "Memphis Pan",
  },
  bismuth_staircase: {
    id: "bismuth_staircase",
    cameraOffset: [0.05, 0.04, -0.06],
    weaponRotation: [0.25, -0.8, 0.35],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.16],
    fovOverride: 42,
    blendInMs: 260,
    holdMs: 3000,
    blendOutMs: 280,
    slowRotateRadPerSec: 0.35,
    ambientFx: "crystal_shimmer",
    label: "Crystal Profile",
  },
  amber_trapped_insect: {
    id: "amber_trapped_insect",
    cameraOffset: [0.04, 0.02, 0.05],
    weaponRotation: [0.0, -0.2, 0.0],
    weaponOffset: [0, 0, 0.06],
    focalPoint: [0, 0, 0.22],
    fovOverride: 35,
    blendInMs: 300,
    holdMs: 3500,
    blendOutMs: 320,
    slowRotateRadPerSec: 0.1,
    ambientFx: "amber_glow",
    label: "Amber Close-up",
  },
  phoenix_feather_relief: {
    id: "phoenix_feather_relief",
    cameraOffset: [0.06, 0.02, -0.06],
    weaponRotation: [0.1, -0.7, 0.25],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.18],
    fovOverride: 42,
    blendInMs: 260,
    holdMs: 3000,
    blendOutMs: 280,
    slowRotateRadPerSec: 0.25,
    ambientFx: "phoenix_ash",
    label: "Phoenix Feather",
  },
  holi_powder_splash: {
    id: "holi_powder_splash",
    cameraOffset: [0.06, 0.04, -0.04],
    weaponRotation: [0.15, -0.6, 0.3],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 44,
    blendInMs: 220,
    holdMs: 2800,
    blendOutMs: 260,
    slowRotateRadPerSec: 0.4,
    ambientFx: "holi_powder",
    label: "Festival Burst",
  },
  ice_crystal_bloom: {
    id: "ice_crystal_bloom",
    cameraOffset: [0.05, 0.03, -0.05],
    weaponRotation: [0.2, -0.7, 0.3],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.16],
    fovOverride: 42,
    blendInMs: 280,
    holdMs: 3200,
    blendOutMs: 300,
    slowRotateRadPerSec: 0.3,
    ambientFx: "snow",
    label: "Frost Bloom",
  },
  iridescent_oil_slick: {
    id: "iridescent_oil_slick",
    cameraOffset: [0.07, 0.02, -0.03],
    weaponRotation: [0.15, -0.4, 0.4],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.14],
    fovOverride: 40,
    blendInMs: 280,
    holdMs: 3200,
    blendOutMs: 300,
    slowRotateRadPerSec: 0.45,
    ambientFx: "oil_shimmer",
    label: "Oil-slick Tilt",
  },
  carbon_fiber_weave: {
    id: "carbon_fiber_weave",
    cameraOffset: [0.04, 0.02, -0.04],
    weaponRotation: [0.1, -0.6, 0.15],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 38,
    blendInMs: 220,
    holdMs: 2400,
    blendOutMs: 240,
    slowRotateRadPerSec: 0.15,
    label: "Weave Pan",
  },
  rusted_post_apocalyptic: {
    id: "rusted_post_apocalyptic",
    cameraOffset: [0.05, 0.01, -0.03],
    weaponRotation: [0.05, -0.5, 0.1],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 42,
    blendInMs: 240,
    holdMs: 2600,
    blendOutMs: 260,
    slowRotateRadPerSec: 0.1,
    ambientFx: "dust",
    label: "Wasteland Hold",
  },
  fire_forged_damascus: {
    id: "fire_forged_damascus",
    cameraOffset: [0.05, 0.02, -0.05],
    weaponRotation: [0.15, -0.7, 0.25],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.17],
    fovOverride: 40,
    blendInMs: 240,
    holdMs: 2800,
    blendOutMs: 260,
    slowRotateRadPerSec: 0.2,
    ambientFx: "forge_ember",
    label: "Damascus Fold",
  },
  jade_dragon_scale: {
    id: "jade_dragon_scale",
    cameraOffset: [0.05, 0.03, -0.06],
    weaponRotation: [0.1, -0.8, 0.3],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.16],
    fovOverride: 42,
    blendInMs: 260,
    holdMs: 3000,
    blendOutMs: 280,
    slowRotateRadPerSec: 0.3,
    ambientFx: "jade_glow",
    label: "Dragon Scale",
  },
  skull_mosaic: {
    id: "skull_mosaic",
    cameraOffset: [0.06, 0.02, -0.05],
    weaponRotation: [0.1, -0.6, 0.2],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 42,
    blendInMs: 240,
    holdMs: 2800,
    blendOutMs: 260,
    slowRotateRadPerSec: 0.2,
    ambientFx: "bone_dust",
    label: "Mosaic Pan",
  },
  celtic_knot: {
    id: "celtic_knot",
    cameraOffset: [0.05, 0.02, -0.06],
    weaponRotation: [0.15, -0.8, 0.3],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.16],
    fovOverride: 40,
    blendInMs: 260,
    holdMs: 3000,
    blendOutMs: 280,
    slowRotateRadPerSec: 0.25,
    ambientFx: "mist",
    label: "Knot Pan",
  },
  tribal_maori_moko: {
    id: "tribal_maori_moko",
    cameraOffset: [0.06, 0.0, -0.04],
    weaponRotation: [0.0, -0.9, 0.4],
    weaponOffset: [0, 0, 0],
    focalPoint: [-0.01, 0, 0.14],
    fovOverride: 42,
    blendInMs: 240,
    holdMs: 2800,
    blendOutMs: 260,
    slowRotateRadPerSec: 0.3,
    ambientFx: "war_paint",
    label: "Moko Profile",
  },
  cracked_porcelain: {
    id: "cracked_porcelain",
    cameraOffset: [0.04, 0.02, -0.04],
    weaponRotation: [0.1, -0.5, 0.2],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 40,
    blendInMs: 240,
    holdMs: 2600,
    blendOutMs: 260,
    slowRotateRadPerSec: 0.15,
    ambientFx: "porcelain_glint",
    label: "Porcelain Tilt",
  },
  trippy_kaleidoscope: {
    id: "trippy_kaleidoscope",
    cameraOffset: [0.08, 0.04, -0.02],
    weaponRotation: [0.3, -0.5, 0.6],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.12],
    fovOverride: 55,
    blendInMs: 300,
    holdMs: 3200,
    blendOutMs: 320,
    slowRotateRadPerSec: 0.8,
    ambientFx: "prism",
    label: "Kaleidoscope Spin",
  },
  anime_waifu_print: {
    id: "anime_waifu_print",
    cameraOffset: [0.05, 0.03, -0.04],
    weaponRotation: [0.1, -0.6, 0.2],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.16],
    fovOverride: 42,
    blendInMs: 240,
    holdMs: 2800,
    blendOutMs: 260,
    slowRotateRadPerSec: 0.2,
    ambientFx: "sakura",
    label: "Print Tilt",
  },
  camo_woodland: {
    id: "camo_woodland",
    cameraOffset: [0.05, 0.02, -0.05],
    weaponRotation: [0.1, -0.6, 0.2],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 0,
    blendInMs: 220,
    holdMs: 2200,
    blendOutMs: 240,
    slowRotateRadPerSec: 0.1,
    label: "Woodland Pan",
  },
  camo_desert: {
    id: "camo_desert",
    cameraOffset: [0.05, 0.02, -0.05],
    weaponRotation: [0.1, -0.6, 0.2],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 0,
    blendInMs: 220,
    holdMs: 2200,
    blendOutMs: 240,
    slowRotateRadPerSec: 0.1,
    label: "Desert Pan",
  },
  camo_arctic: {
    id: "camo_arctic",
    cameraOffset: [0.05, 0.02, -0.05],
    weaponRotation: [0.1, -0.6, 0.2],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 0,
    blendInMs: 220,
    holdMs: 2200,
    blendOutMs: 240,
    slowRotateRadPerSec: 0.1,
    label: "Arctic Pan",
  },
  camo_digital_hex: {
    id: "camo_digital_hex",
    cameraOffset: [0.06, 0.02, -0.04],
    weaponRotation: [0.1, -0.5, 0.3],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 0,
    blendInMs: 220,
    holdMs: 2400,
    blendOutMs: 240,
    slowRotateRadPerSec: 0.2,
    label: "Hex Pan",
  },
  matte_tactical_black: {
    id: "matte_tactical_black",
    cameraOffset: [0.04, 0.02, -0.04],
    weaponRotation: [0.1, -0.6, 0.15],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 0,
    blendInMs: 200,
    holdMs: 2000,
    blendOutMs: 220,
    slowRotateRadPerSec: 0.1,
    label: "Tactical Pan",
  },
  razor_sharp_chrome: {
    id: "razor_sharp_chrome",
    cameraOffset: [0.08, 0.04, -0.04],
    weaponRotation: [0.2, -0.6, 0.4],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 38,
    blendInMs: 240,
    holdMs: 2600,
    blendOutMs: 260,
    slowRotateRadPerSec: 0.3,
    ambientFx: "chrome_glint",
    label: "Chrome Tilt",
  },
  solid_painted: {
    id: "solid_painted",
    cameraOffset: [0.05, 0.02, -0.05],
    weaponRotation: [0.1, -0.6, 0.2],
    weaponOffset: [0, 0, 0],
    focalPoint: [0, 0, 0.15],
    fovOverride: 0,
    blendInMs: 200,
    holdMs: 2000,
    blendOutMs: 220,
    slowRotateRadPerSec: 0.1,
    label: "Standard Pan",
  },
};

// ─── Per-rarity inspect pose amplifiers ─────────────────────────────────────

/**
 * Per-rarity pose amplifiers — high-rarity skins get longer hold times +
 * ambient FX so the inspection feels "premium". Common skins get the base
 * pose; Mythic skins get 2x hold time + guaranteed ambient FX.
 */
export const RARITY_POSE_AMPLIFIER: Record<SkinRarity, {
  holdMsMult: number;
  ambientFxBoost: boolean;
  slowRotateMult: number;
}> = {
  COMMON: { holdMsMult: 1.0, ambientFxBoost: false, slowRotateMult: 1.0 },
  RARE: { holdMsMult: 1.1, ambientFxBoost: false, slowRotateMult: 1.1 },
  EPIC: { holdMsMult: 1.25, ambientFxBoost: true, slowRotateMult: 1.2 },
  LEGENDARY: { holdMsMult: 1.5, ambientFxBoost: true, slowRotateMult: 1.3 },
  MYTHIC: { holdMsMult: 2.0, ambientFxBoost: true, slowRotateMult: 1.5 },
};

// ─── Pose resolution ────────────────────────────────────────────────────────

/**
 * Resolve the inspect pose for a catalog entry. Falls through:
 *   1. Per-slug override (explicit per-skin pose) — none yet, but the API
 *      supports future per-skin overrides.
 *   2. Per-pattern-family override (PATTERN_INSPECT_POSES).
 *   3. Default pose (DEFAULT_INSPECT_POSE).
 *
 * The returned pose is amplified by the rarity tier (longer hold, etc.).
 * Pure — the same input always returns the same pose.
 */
export function resolveInspectPose(entry: SkinCatalogEntry): InspectPose {
  const base = PATTERN_INSPECT_POSES[entry.pattern] ?? DEFAULT_INSPECT_POSE;
  const amp = RARITY_POSE_AMPLIFIER[entry.rarity];
  return {
    ...base,
    holdMs: Math.round(base.holdMs * amp.holdMsMult),
    slowRotateRadPerSec: base.slowRotateRadPerSec * amp.slowRotateMult,
    ambientFx: amp.ambientFxBoost ? (base.ambientFx ?? `${entry.pattern}_glow`) : base.ambientFx,
  };
}

// ─── Pose-blend state machine ───────────────────────────────────────────────

export type InspectPhase = "idle" | "blending_in" | "holding" | "blending_out";

export interface InspectAnimState {
  phase: InspectPhase;
  /** Elapsed time in current phase (ms). */
  elapsedMs: number;
  /** The pose being played. */
  pose: InspectPose;
  /** Current blend factor 0..1 (0 = rest pose, 1 = inspect pose). */
  blend: number;
  /** Current slow-rotate angle accumulator (radians). */
  rotateAccum: number;
}

export function createInspectAnimState(pose: InspectPose): InspectAnimState {
  return {
    phase: "idle",
    elapsedMs: 0,
    pose,
    blend: 0,
    rotateAccum: 0,
  };
}

/**
 * Advance the inspect-anim state by dtMs. The caller triggers an inspect by
 * setting phase to "blending_in"; the state machine auto-advances through
 * hold → blending_out → idle.
 *
 * Returns the current blend factor (0..1) so the viewmodel can lerp its
 * camera + weapon transforms toward the pose.
 */
export function updateInspectAnim(state: InspectAnimState, dtMs: number): number {
  if (state.phase === "idle") {
    state.blend = 0;
    return 0;
  }
  state.elapsedMs += dtMs;
  const pose = state.pose;
  if (state.phase === "blending_in") {
    state.blend = Math.min(1, state.elapsedMs / pose.blendInMs);
    if (state.elapsedMs >= pose.blendInMs) {
      state.phase = "holding";
      state.elapsedMs = 0;
    }
  } else if (state.phase === "holding") {
    state.blend = 1;
    state.rotateAccum += pose.slowRotateRadPerSec * (dtMs / 1000);
    if (state.elapsedMs >= pose.holdMs) {
      state.phase = "blending_out";
      state.elapsedMs = 0;
    }
  } else if (state.phase === "blending_out") {
    state.blend = Math.max(0, 1 - state.elapsedMs / pose.blendOutMs);
    if (state.elapsedMs >= pose.blendOutMs) {
      state.phase = "idle";
      state.elapsedMs = 0;
      state.blend = 0;
      state.rotateAccum = 0;
    }
  }
  return state.blend;
}

/** Trigger an inspect — pass the resolved pose for the equipped skin. */
export function triggerInspect(state: InspectAnimState, pose: InspectPose): void {
  state.phase = "blending_in";
  state.elapsedMs = 0;
  state.pose = pose;
  state.rotateAccum = 0;
}

/** Cancel an in-progress inspect (e.g., player fires the weapon). */
export function cancelInspect(state: InspectAnimState): void {
  if (state.phase === "idle") return;
  state.phase = "blending_out";
  state.elapsedMs = 0;
}
