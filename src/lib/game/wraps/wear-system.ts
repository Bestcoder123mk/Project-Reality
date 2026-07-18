/**
 * Section E — Skin wear / tear progression.
 *
 * Skins in the catalog accumulate wear over their lifetime — mirroring the
 * CS:GO / Rivals "Factory New → Battle Scarred" float-wear system. Each
 * owned skin has a wear float (0 = pristine, 1 = destroyed); the wear
 * advances slowly with use (firing, taking damage, melee kills) and
 * deterministically from a seed when the skin is first acquired (so the
 * initial wear is random but stable — the player can't reroll).
 *
 * The wear drives two visual outputs:
 *   1. A darkening + roughness increase on the body-class meshes (the
 *      painted surface dulls with use).
 *   2. A procedural scratch + grime mask that gets denser as wear rises
 *      (the painted surface scratches + collects carbon fouling).
 *
 * The wear tier (Factory New / Minimal Wear / Field-Tested / Well-Worn /
 * Battle Scarred) is shown in the gunsmith UI next to the skin name; it
 * also feeds the skin-trading.ts pricing modifier (lower wear = higher
 * trade value).
 */
import * as THREE from "three";
import type { SkinCatalogEntry } from "./skin-catalog";

// ─── Wear tiers ─────────────────────────────────────────────────────────────

export type WearTier =
  | "factory_new"
  | "minimal_wear"
  | "field_tested"
  | "well_worn"
  | "battle_scarred";

export interface WearTierConfig {
  tier: WearTier;
  /** Wear float range [min, max]. */
  range: [number, number];
  /** Display name. */
  label: string;
  /** Trade-value multiplier (1.0 = full price). */
  tradeValueMult: number;
  /** Roughness modifier added to the base material. */
  roughnessAdd: number;
  /** Darken factor (multiplied against albedo). */
  darken: number;
  /** Scratch density 0..1. */
  scratchDensity: number;
  /** Grime (carbon fouling) density 0..1. */
  grimeDensity: number;
}

export const WEAR_TIERS: Record<WearTier, WearTierConfig> = {
  factory_new: {
    tier: "factory_new",
    range: [0.0, 0.07],
    label: "Factory New",
    tradeValueMult: 1.0,
    roughnessAdd: 0.0,
    darken: 1.0,
    scratchDensity: 0.0,
    grimeDensity: 0.0,
  },
  minimal_wear: {
    tier: "minimal_wear",
    range: [0.07, 0.15],
    label: "Minimal Wear",
    tradeValueMult: 0.92,
    roughnessAdd: 0.04,
    darken: 0.96,
    scratchDensity: 0.15,
    grimeDensity: 0.08,
  },
  field_tested: {
    tier: "field_tested",
    range: [0.15, 0.38],
    label: "Field-Tested",
    tradeValueMult: 0.78,
    roughnessAdd: 0.1,
    darken: 0.88,
    scratchDensity: 0.4,
    grimeDensity: 0.22,
  },
  well_worn: {
    tier: "well_worn",
    range: [0.38, 0.6],
    label: "Well-Worn",
    tradeValueMult: 0.62,
    roughnessAdd: 0.18,
    darken: 0.78,
    scratchDensity: 0.65,
    grimeDensity: 0.45,
  },
  battle_scarred: {
    tier: "battle_scarred",
    range: [0.6, 1.0],
    label: "Battle Scarred",
    tradeValueMult: 0.45,
    roughnessAdd: 0.3,
    darken: 0.65,
    scratchDensity: 0.9,
    grimeDensity: 0.75,
  },
};

/** Map a wear float (0..1) to its tier. */
export function wearTierForFloat(wearFloat: number): WearTier {
  const w = Math.min(1, Math.max(0, wearFloat));
  if (w < 0.07) return "factory_new";
  if (w < 0.15) return "minimal_wear";
  if (w < 0.38) return "field_tested";
  if (w < 0.6) return "well_worn";
  return "battle_scarred";
}

/** Get the tier config for a wear float. */
export function wearConfigForFloat(wearFloat: number): WearTierConfig {
  return WEAR_TIERS[wearTierForFloat(wearFloat)];
}

// ─── Per-owned-skin wear state ──────────────────────────────────────────────

export interface SkinWearState {
  /** Catalog slug this wear state applies to. */
  skinSlug: string;
  /** Wear float 0..1 (0 = pristine, 1 = destroyed). */
  wearFloat: number;
  /** Cumulative XP accumulated toward the next wear tier (informational). */
  wearXP: number;
}

/**
 * Generate the initial wear float for a newly-acquired skin. Deterministic
 * from a seed (the player's inventory item ID hash) so the wear is stable
 * across sessions and can't be rerolled. The distribution is biased toward
 * the lower tiers (most skins are Factory New / Minimal Wear; only ~10%
 * spawn as Field-Tested or worse) — mirrors CS:GO float drop odds.
 */
export function rollInitialWearFloat(seed: number): number {
  // Mulberry32 — deterministic PRNG from a 32-bit seed.
  let s = seed >>> 0;
  const rng = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Bias: 50% Factory New, 25% Minimal Wear, 15% Field-Tested, 7% Well-Worn, 3% Battle Scarred.
  const r = rng();
  let lo: number, hi: number;
  if (r < 0.5) { lo = 0.0; hi = 0.07; }
  else if (r < 0.75) { lo = 0.07; hi = 0.15; }
  else if (r < 0.9) { lo = 0.15; hi = 0.38; }
  else if (r < 0.97) { lo = 0.38; hi = 0.6; }
  else { lo = 0.6; hi = 1.0; }
  return lo + rng() * (hi - lo);
}

/**
 * Advance the wear XP for a skin. Wear XP accumulates from gameplay events
 * (firing a shot = +0.01, taking damage = +0.05, melee kill = +0.2). When
 * XP crosses 1.0, the wear float advances by a small delta and XP resets.
 *
 * Mutates `state` in place. Pure-equivalent: `addWearXP(state, amount)`
 * returns the same mutated state for chaining.
 */
export function addWearXP(state: SkinWearState, amount: number): SkinWearState {
  state.wearXP += amount;
  while (state.wearXP >= 1.0) {
    state.wearXP -= 1.0;
    // Each XP-level adds a small delta. Delta shrinks as wear rises (the
    // skin wears fastest in the early tiers, slowest when battle-scarred).
    const delta = 0.008 * (1.0 - state.wearFloat * 0.5);
    state.wearFloat = Math.min(1.0, state.wearFloat + delta);
  }
  return state;
}

/** Standard gameplay wear-XP awards. */
export const WEAR_XP_AWARDS = {
  perShotFired: 0.012,
  perDamageTaken: 0.05,
  perMeleeKill: 0.2,
  perReloadCycle: 0.005,
  perMatchPlayed: 0.15,
  perDeath: 0.08,
} as const;

// ─── Procedural scratch + grime texture ─────────────────────────────────────

const _scratchCache = new Map<string, THREE.CanvasTexture>();

/**
 * Generate a procedural scratch + grime texture for a skin at a given wear
 * float. The texture is a grayscale alpha mask: bright = clean, dark =
 * scratched/grimed. The wrap material multiplies its albedo by this mask to
 * show wear.
 *
 * The texture is cached per (skinSlug + wear-bucket) — we bucket to the
 * nearest 0.05 wear float so the cache doesn't grow unbounded.
 */
export function makeWearMaskTexture(
  skinSlug: string,
  wearFloat: number,
  size = 256,
): THREE.CanvasTexture {
  const bucket = Math.round(wearFloat * 20) / 20; // nearest 0.05
  const key = `${skinSlug}:${bucket}`;
  const cached = _scratchCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Start clean (white).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  const tier = wearConfigForFloat(wearFloat);

  // Scratches — short dark lines, denser with wear.
  if (tier.scratchDensity > 0) {
    ctx.strokeStyle = `rgba(20, 20, 20, ${0.4 + tier.scratchDensity * 0.5})`;
    const scratchCount = Math.floor(tier.scratchDensity * 80);
    for (let i = 0; i < scratchCount; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const len = 4 + Math.random() * 20;
      const angle = Math.random() * Math.PI * 2;
      ctx.lineWidth = 0.5 + Math.random() * 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
      ctx.stroke();
    }
  }

  // Grime — soft dark blobs (carbon fouling near the muzzle, oil near the grip).
  if (tier.grimeDensity > 0) {
    const grimeCount = Math.floor(tier.grimeDensity * 30);
    for (let i = 0; i < grimeCount; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 6 + Math.random() * 24;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      const alpha = 0.15 + tier.grimeDensity * 0.35;
      grad.addColorStop(0, `rgba(40, 30, 20, ${alpha})`);
      grad.addColorStop(1, "rgba(40, 30, 20, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Edge-wear — darken the texture borders (the painted surface chips at
  // the gun's edges — receiver corners, sight posts, magazine lips).
  if (tier.scratchDensity > 0.2) {
    const edgeGrad = ctx.createLinearGradient(0, 0, size, 0);
    edgeGrad.addColorStop(0, `rgba(30, 30, 30, ${tier.scratchDensity * 0.3})`);
    edgeGrad.addColorStop(0.1, "rgba(30, 30, 30, 0)");
    edgeGrad.addColorStop(0.9, "rgba(30, 30, 30, 0)");
    edgeGrad.addColorStop(1, `rgba(30, 30, 30, ${tier.scratchDensity * 0.3})`);
    ctx.fillStyle = edgeGrad;
    ctx.fillRect(0, 0, size, size);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  _scratchCache.set(key, tex);
  return tex;
}

// ─── Apply wear to a MeshStandardMaterial ───────────────────────────────────

/**
 * Apply wear to a material — multiplies the albedo by a darkening factor,
 * bumps roughness, and overlays the procedural scratch/grime mask as a
 * `roughnessMap` (scratches = higher roughness = more matte, clean areas
 * stay glossy). The original albedo + roughness are saved so wear can be
 * updated without losing the base values.
 */
export function applyWearToMaterial(
  mat: THREE.MeshStandardMaterial,
  skinSlug: string,
  wearFloat: number,
): void {
  const tier = wearConfigForFloat(wearFloat);
  // Stash the originals if we haven't already.
  const udata = mat.userData as { __wearOrigColor?: THREE.Color; __wearOrigRough?: number };
  if (!udata.__wearOrigColor) {
    udata.__wearOrigColor = mat.color.clone();
    udata.__wearOrigRough = mat.roughness;
  }
  // Darken the albedo.
  mat.color.copy(udata.__wearOrigColor).multiplyScalar(tier.darken);
  // Bump roughness.
  mat.roughness = Math.min(1, udata.__wearOrigRough + tier.roughnessAdd);
  // Overlay scratch mask as roughnessMap (only if wear is visible).
  if (tier.scratchDensity > 0) {
    const mask = makeWearMaskTexture(skinSlug, wearFloat);
    if (mat.roughnessMap !== mask) {
      mat.roughnessMap = mask;
      mat.needsUpdate = true;
    }
  } else {
    mat.roughnessMap = null;
    mat.needsUpdate = true;
  }
}

/** Restore a material to its pre-wear state. */
export function clearWearFromMaterial(mat: THREE.MeshStandardMaterial): void {
  const udata = mat.userData as { __wearOrigColor?: THREE.Color; __wearOrigRough?: number };
  if (udata.__wearOrigColor) mat.color.copy(udata.__wearOrigColor);
  if (typeof udata.__wearOrigRough === "number") mat.roughness = udata.__wearOrigRough;
  mat.roughnessMap = null;
  mat.needsUpdate = true;
  delete udata.__wearOrigColor;
  delete udata.__wearOrigRough;
}

// ─── Trade-value modifier ───────────────────────────────────────────────────

/**
 * Compute the trade-value multiplier for a skin given its wear float. Pure —
 * the trading module uses this to compute trade offers.
 */
export function wearTradeValueMult(wearFloat: number): number {
  return wearConfigForFloat(wearFloat).tradeValueMult;
}

// ─── Per-catalog-entry defaults ─────────────────────────────────────────────

/**
 * Default wear behavior per catalog entry. Mythic skins wear 50% slower
 * (they're "collectible" — the player wants them pristine). Legendary
 * skins wear 25% slower. Everything else wears at the standard rate.
 */
export function wearRateForRarity(rarity: SkinCatalogEntry["rarity"]): number {
  switch (rarity) {
    case "MYTHIC": return 0.5;
    case "LEGENDARY": return 0.75;
    default: return 1.0;
  }
}
