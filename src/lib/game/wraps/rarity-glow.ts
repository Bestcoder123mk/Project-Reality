/**
 * Section E — Visual rarity glow effects.
 *
 * Every skin, charm, and wrap has an associated rarity tier. The rarity
 * drives a visual "glow" effect in the gunsmith / inventory UI:
 *
 *   - COMMON    → no glow (neutral)
 *   - RARE      → soft blue rim glow
 *   - EPIC      → pulsing purple rim glow
 *   - LEGENDARY → strong gold glow + slow pulse + edge shimmer
 *   - MYTHIC    → red flame-lick glow + fast pulse + particle halo
 *
 * The glow is implemented as a post-process-style rim shader on the
 * cosmetic's icon (in the UI) and as an additive emissive boost on the
 * in-world weapon mesh (when equipped). The two paths share the same
 * `RarityGlowConfig` so the visual identity is consistent.
 *
 * Section E prompts specifically call out "visual rarity glow effects
 * (common, rare, epic, legendary, mythic)" — this module is the single
 * source of truth for the rarity → glow mapping, consumed by:
 *   - The gunsmith UI (icon rim glow)
 *   - The inventory grid (cell border glow)
 *   - The loot-drop reveal animation (burst glow)
 *   - The in-world weapon mesh (additive emissive on body-class parts)
 */
import * as THREE from "three";
import { RARITY_GLOW_HEX, type SkinRarity } from "./skin-catalog";

// ─── Glow config per rarity ─────────────────────────────────────────────────

export interface RarityGlowConfig {
  rarity: SkinRarity;
  /** Glow color (hex string). */
  color: string;
  /** Glow color as THREE.Color (cached). */
  colorObj: THREE.Color;
  /** Base intensity 0..1 — COMMON = 0 (no glow), MYTHIC = 1 (max). */
  intensity: number;
  /** Pulse speed (Hz) — 0 = steady, 1 = 1 pulse/sec. */
  pulseSpeed: number;
  /** Pulse depth 0..1 — how much the glow modulates with the pulse. */
  pulseDepth: number;
  /** Rim width 0..1 (fraction of the icon edge that glows). */
  rimWidth: number;
  /** Whether the glow spawns ambient particles (legendary+ only). */
  hasParticles: boolean;
  /** Particle color (hex). Defaults to glow color. */
  particleColor: string;
  /** Particle spawn rate (particles/sec). */
  particleRate: number;
  /** Emissive boost applied to the in-world mesh material (0..1). */
  emissiveBoost: number;
  /** Edge shimmer intensity 0..1 — for legendary+ mythic+. */
  edgeShimmer: number;
}

export const RARITY_GLOW: Record<SkinRarity, RarityGlowConfig> = {
  COMMON: {
    rarity: "COMMON",
    color: RARITY_GLOW_HEX.COMMON,
    colorObj: new THREE.Color(RARITY_GLOW_HEX.COMMON),
    intensity: 0.0,
    pulseSpeed: 0,
    pulseDepth: 0,
    rimWidth: 0.0,
    hasParticles: false,
    particleColor: RARITY_GLOW_HEX.COMMON,
    particleRate: 0,
    emissiveBoost: 0.0,
    edgeShimmer: 0.0,
  },
  RARE: {
    rarity: "RARE",
    color: RARITY_GLOW_HEX.RARE,
    colorObj: new THREE.Color(RARITY_GLOW_HEX.RARE),
    intensity: 0.35,
    pulseSpeed: 0.5,
    pulseDepth: 0.2,
    rimWidth: 0.15,
    hasParticles: false,
    particleColor: RARITY_GLOW_HEX.RARE,
    particleRate: 0,
    emissiveBoost: 0.05,
    edgeShimmer: 0.0,
  },
  EPIC: {
    rarity: "EPIC",
    color: RARITY_GLOW_HEX.EPIC,
    colorObj: new THREE.Color(RARITY_GLOW_HEX.EPIC),
    intensity: 0.55,
    pulseSpeed: 0.8,
    pulseDepth: 0.35,
    rimWidth: 0.2,
    hasParticles: false,
    particleColor: RARITY_GLOW_HEX.EPIC,
    particleRate: 0,
    emissiveBoost: 0.12,
    edgeShimmer: 0.15,
  },
  LEGENDARY: {
    rarity: "LEGENDARY",
    color: RARITY_GLOW_HEX.LEGENDARY,
    colorObj: new THREE.Color(RARITY_GLOW_HEX.LEGENDARY),
    intensity: 0.75,
    pulseSpeed: 1.0,
    pulseDepth: 0.45,
    rimWidth: 0.25,
    hasParticles: true,
    particleColor: RARITY_GLOW_HEX.LEGENDARY,
    particleRate: 8,
    emissiveBoost: 0.25,
    edgeShimmer: 0.4,
  },
  MYTHIC: {
    rarity: "MYTHIC",
    color: RARITY_GLOW_HEX.MYTHIC,
    colorObj: new THREE.Color(RARITY_GLOW_HEX.MYTHIC),
    intensity: 1.0,
    pulseSpeed: 1.6,
    pulseDepth: 0.6,
    rimWidth: 0.35,
    hasParticles: true,
    particleColor: RARITY_GLOW_HEX.MYTHIC,
    particleRate: 18,
    emissiveBoost: 0.45,
    edgeShimmer: 0.7,
  },
};

// ─── Pulsing intensity helper ───────────────────────────────────────────────

/**
 * Compute the current pulse-modulated intensity for a rarity glow at time t.
 * Pure — same input always returns the same output. The pulse is a sin wave
 * centered on the base intensity, amplitude = intensity * pulseDepth.
 *
 * COMMON returns 0 always (no glow).
 */
export function computeGlowIntensity(rarity: SkinRarity, timeSec: number): number {
  const cfg = RARITY_GLOW[rarity];
  if (cfg.intensity === 0) return 0;
  if (cfg.pulseSpeed === 0 || cfg.pulseDepth === 0) return cfg.intensity;
  const pulse = Math.sin(timeSec * cfg.pulseSpeed * Math.PI * 2) * 0.5 + 0.5;
  return cfg.intensity * (1 - cfg.pulseDepth + cfg.pulseDepth * pulse);
}

// ─── In-world mesh glow (emissive boost) ────────────────────────────────────

/**
 * Apply rarity-glow emissive boost to a weapon mesh material. For legendary +
 * mythic rarities, this adds a subtle emissive tint to the body-class parts
 * (so the gun glows faintly in the dark — a "premium" feel). COMMON/RARE
 * get no boost (the glow is UI-only).
 *
 * The original emissive is stashed on `userData.__rarityOrigEmissive` so the
 * glow can be removed (e.g., when the skin is unequipped).
 */
export function applyRarityGlowToMaterial(
  mat: THREE.MeshStandardMaterial,
  rarity: SkinRarity,
): void {
  const cfg = RARITY_GLOW[rarity];
  if (cfg.emissiveBoost === 0) return;
  const udata = mat.userData as { __rarityOrigEmissive?: THREE.Color; __rarityOrigIntensity?: number };
  if (!udata.__rarityOrigEmissive) {
    udata.__rarityOrigEmissive = mat.emissive.clone();
    udata.__rarityOrigIntensity = mat.emissiveIntensity;
  }
  mat.emissive.copy(cfg.colorObj).multiplyScalar(cfg.emissiveBoost);
  mat.emissiveIntensity = 1.0;
  mat.needsUpdate = true;
}

/** Restore a material to its pre-glow state. */
export function clearRarityGlowFromMaterial(mat: THREE.MeshStandardMaterial): void {
  const udata = mat.userData as { __rarityOrigEmissive?: THREE.Color; __rarityOrigIntensity?: number };
  if (udata.__rarityOrigEmissive) mat.emissive.copy(udata.__rarityOrigEmissive);
  if (typeof udata.__rarityOrigIntensity === "number") mat.emissiveIntensity = udata.__rarityOrigIntensity;
  mat.needsUpdate = true;
  delete udata.__rarityOrigEmissive;
  delete udata.__rarityOrigIntensity;
}

/**
 * Per-frame update — modulates the emissive intensity with the pulse. The
 * caller wires this into the render loop for the equipped weapon's body
 * material(s).
 */
export function updateRarityGlow(
  mat: THREE.MeshStandardMaterial,
  rarity: SkinRarity,
  timeSec: number,
): void {
  const cfg = RARITY_GLOW[rarity];
  if (cfg.emissiveBoost === 0) return;
  const intensity = computeGlowIntensity(rarity, timeSec);
  mat.emissiveIntensity = intensity * 1.5;
}

// ─── UI icon rim glow (canvas) ──────────────────────────────────────────────

/**
 * Draw a rarity rim glow on a 2D canvas context — used by the inventory grid
 * cell, the gunsmith icon, and the loot-drop reveal animation. The glow is
 * drawn as a radial gradient around the icon's edge.
 *
 * @param ctx Canvas 2D context.
 * @param x,y Icon top-left (canvas pixels).
 * @param w,h Icon size (canvas pixels).
 * @param rarity The rarity tier.
 * @param timeSec Current time (seconds) — drives the pulse.
 * @param opts Optional overrides.
 */
export function drawRarityRimGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rarity: SkinRarity,
  timeSec: number,
  opts?: { intensityMult?: number; featherMult?: number },
): void {
  const cfg = RARITY_GLOW[rarity];
  if (cfg.intensity === 0) return;
  const intensity = computeGlowIntensity(rarity, timeSec) * (opts?.intensityMult ?? 1);
  if (intensity <= 0) return;
  const feather = (opts?.featherMult ?? 1);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.max(w, h) / 2;
  // Outer radial gradient — soft halo around the icon.
  const grad = ctx.createRadialGradient(cx, cy, r * 0.7, cx, cy, r * 1.5 * feather);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.5, `${cfg.color}${Math.floor(intensity * 0.6 * 255).toString(16).padStart(2, "0")}`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = grad;
  ctx.fillRect(x - r, y - r, w + r * 2, h + r * 2);
  // Inner rim — bright edge stroke.
  ctx.lineWidth = cfg.rimWidth * w * 0.5;
  ctx.strokeStyle = `${cfg.color}${Math.floor(intensity * 200).toString(16).padStart(2, "0")}`;
  ctx.strokeRect(x, y, w, h);
  // Edge shimmer for legendary+ — diagonal sweep highlight.
  if (cfg.edgeShimmer > 0) {
    const sweep = (timeSec * 0.5) % 1;
    const sweepX = x + sweep * w;
    const sweepGrad = ctx.createLinearGradient(sweepX - w * 0.1, 0, sweepX + w * 0.1, 0);
    sweepGrad.addColorStop(0, "rgba(255,255,255,0)");
    sweepGrad.addColorStop(0.5, `rgba(255,255,255,${cfg.edgeShimmer * 0.5})`);
    sweepGrad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sweepGrad;
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

// ─── Loot-drop burst animation ──────────────────────────────────────────────

export interface LootBurstState {
  rarity: SkinRarity;
  /** Elapsed time (seconds). */
  elapsed: number;
  /** Burst duration (seconds). */
  duration: number;
  /** Current radius (canvas pixels). */
  radius: number;
  /** Current opacity 0..1. */
  opacity: number;
}

/** Start a loot-drop burst for a rarity. */
export function startLootBurst(rarity: SkinRarity, duration = 1.2): LootBurstState {
  return { rarity, elapsed: 0, duration, radius: 0, opacity: 1 };
}

/** Advance the burst by dt seconds. Returns the updated state. */
export function updateLootBurst(state: LootBurstState, dt: number): LootBurstState {
  state.elapsed += dt;
  const t = Math.min(1, state.elapsed / state.duration);
  // Eased-out radius expansion.
  state.radius = 80 * (1 - Math.pow(1 - t, 3));
  state.opacity = Math.max(0, 1 - t);
  return state;
}

/** Draw the burst on a canvas — radial expanding glow. */
export function drawLootBurst(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  state: LootBurstState,
): void {
  const cfg = RARITY_GLOW[state.rarity];
  if (cfg.intensity === 0 || state.opacity <= 0) return;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, state.radius);
  const alpha = state.opacity * cfg.intensity;
  grad.addColorStop(0, `${cfg.color}${Math.floor(alpha * 200).toString(16).padStart(2, "0")}`);
  grad.addColorStop(0.6, `${cfg.color}${Math.floor(alpha * 80).toString(16).padStart(2, "0")}`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, state.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ─── Particle halo (legendary+ mythic+) ─────────────────────────────────────

export interface RarityParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}

/**
 * Spawn rarity particles for a frame. Returns the new particles to add to the
 * particle system. Legendary+ rarities spawn ambient sparkles around the icon
 * / weapon — gives the "premium collectible" feel.
 */
export function spawnRarityParticles(
  rarity: SkinRarity,
  cx: number,
  cy: number,
  radius: number,
  dt: number,
): RarityParticle[] {
  const cfg = RARITY_GLOW[rarity];
  if (!cfg.hasParticles) return [];
  const spawnCount = Math.floor(cfg.particleRate * dt + Math.random());
  const out: RarityParticle[] = [];
  for (let i = 0; i < spawnCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = radius * (0.8 + Math.random() * 0.4);
    const speed = 5 + Math.random() * 15;
    out.push({
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 10, // slight upward drift
      life: 0,
      maxLife: 0.8 + Math.random() * 0.6,
      size: 1 + Math.random() * 2,
    });
  }
  return out;
}

/** Advance + draw rarity particles on a canvas. Mutates the array (removes dead). */
export function updateAndDrawRarityParticles(
  ctx: CanvasRenderingContext2D,
  particles: RarityParticle[],
  rarity: SkinRarity,
  dt: number,
): void {
  const cfg = RARITY_GLOW[rarity];
  if (!cfg.hasParticles) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.maxLife) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 8 * dt; // gravity
    const t = p.life / p.maxLife;
    const alpha = (1 - t) * 0.8;
    ctx.fillStyle = `${cfg.particleColor}${Math.floor(alpha * 255).toString(16).padStart(2, "0")}`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─── Convenience: rarity ordering ───────────────────────────────────────────

export const RARITY_ORDER: SkinRarity[] = ["COMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC"];

/** Compare rarities — returns -1/0/1. Higher rarity = "greater". */
export function compareRarity(a: SkinRarity, b: SkinRarity): number {
  return RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b);
}
