import * as THREE from "three";
import { particleTexture } from "../../textures";

export const _texCache = new Map<string, THREE.Texture>();
export function cachedParticleTexture(color: string): THREE.Texture {
  let t = _texCache.get(color);
  if (!t) { t = particleTexture(color); _texCache.set(color, t); }
  return t;
}

/** Blood color palette — slight variation per spawn (0x8a1a1a to 0xc93030). */
export function randomBloodColor(): number {
  const r = 0x8a + Math.floor(Math.random() * (0xc9 - 0x8a));
  const g = 0x1a + Math.floor(Math.random() * (0x30 - 0x1a));
  const b = 0x1a + Math.floor(Math.random() * (0x30 - 0x1a));
  return (r << 16) | (g << 8) | b;
}

/** Tracer color by weapon category (Task-6 — color-coded tracers). */
export const TRACER_COLORS: Record<string, number> = {
  RIFLE: 0xffcc66,    // yellow-orange
  SNIPER: 0xff5544,   // red
  SMG: 0xddff66,      // green-yellow
  PISTOL: 0xffffff,   // white
  SHOTGUN: 0xffaa55,  // amber
  ENEMY: 0xff3344,    // red-tinted for incoming fire
};

/** Per-surface impact VFX config. Drives spark count, debris color/count,
 *  smoke scale, and decal color for `spawnBulletImpact`. */
export interface SurfaceVfx {
  sparkCount: number;
  sparkColor: number;
  debrisColor: number;
  debrisCount: number;
  smokeScale: number;
  decalColor: number;
  decalScale: number;
}
// REALISM-1 (task E): decalColor values are now material-aware — they tint
// the bullet-hole decal toward the surface's actual color instead of always
// painting a charcoal pock-mark. Concrete reads as dark grey, wood as brown,
// sheet_metal as silver, glass as a faint cyan tint (when it didn't fully
// shatter), sandbag as tan, earth as dark brown. Flesh (0x661111) is included
// for the rare case a flesh surface (e.g. a corpse) takes a fresh bullet hit
// — though most enemy hits go through the blood-spray code path instead.
export const SURFACE_VFX: Record<string, SurfaceVfx> = {
  concrete:   { sparkCount: 8,  sparkColor: 0xffcc44, debrisColor: 0x6b6b6b, debrisCount: 6, smokeScale: 0.4,  decalColor: 0x222222, decalScale: 3.0 },
  wood:       { sparkCount: 5,  sparkColor: 0xffaa33, debrisColor: 0x8a5a2b, debrisCount: 8, smokeScale: 0.35, decalColor: 0x3a2418, decalScale: 2.8 },
  sheet_metal:{ sparkCount: 14, sparkColor: 0xffee88, debrisColor: 0xb0b0b8, debrisCount: 5, smokeScale: 0.3,  decalColor: 0x888888, decalScale: 2.6 },
  brick:      { sparkCount: 7,  sparkColor: 0xffbb44, debrisColor: 0x7a4a3a, debrisCount: 7, smokeScale: 0.4,  decalColor: 0x3a2018, decalScale: 2.8 },
  sandbag:    { sparkCount: 4,  sparkColor: 0xffaa55, debrisColor: 0xc9b08a, debrisCount: 10,smokeScale: 0.5,  decalColor: 0x6b5536, decalScale: 2.6 },
  glass:      { sparkCount: 6,  sparkColor: 0xffffff, debrisColor: 0xb8d4e8, debrisCount: 4, smokeScale: 0.25, decalColor: 0x88ccff, decalScale: 2.2 },
  earth:      { sparkCount: 5,  sparkColor: 0xffaa55, debrisColor: 0x6a5a3a, debrisCount: 8, smokeScale: 0.45, decalColor: 0x2a1e10, decalScale: 3.0 },
  drywall:    { sparkCount: 4,  sparkColor: 0xffcc66, debrisColor: 0xd8d4c8, debrisCount: 8, smokeScale: 0.5,  decalColor: 0x4a463a, decalScale: 2.6 },
  steel_plate:{ sparkCount: 16, sparkColor: 0xffffff, debrisColor: 0x3a3a3e, debrisCount: 4, smokeScale: 0.25, decalColor: 0xaaaaaa, decalScale: 2.4 },
  foliage:    { sparkCount: 3,  sparkColor: 0xddcc44, debrisColor: 0x4a7a3a, debrisCount: 6, smokeScale: 0.3,  decalColor: 0x2a3a18, decalScale: 2.4 },
  flesh:      { sparkCount: 6,  sparkColor: 0xff4a4a, debrisColor: 0x8a1a1a, debrisCount: 5, smokeScale: 0.35, decalColor: 0x661111, decalScale: 2.4 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Section B #160 — bullet trace visibility tuning.
//
// Tracer length + opacity should scale with bullet velocity AND ambient light.
// A bright tracer in daylight looks wrong (tracers are barely visible against
// a sunny sky); at night the same tracer should be vivid. We add:
//   - per-weapon `tracerBrightness` (snipers = brightest, pistols = dimmest)
//   - a day/night multiplier (0.5 at noon → 1.8 at midnight)
//   - a velocity scale (faster bullet = longer, brighter tracer)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-weapon-category tracer brightness baseline (0..1). */
export const TRACER_BRIGHTNESS_BY_CATEGORY: Record<string, number> = {
  RIFLE: 0.7,
  SNIPER: 1.0,  // brightest — big powder charge, slow-burn tracer compound
  SMG: 0.5,     // dim — short barrel, less time to ignite the tracer
  PISTOL: 0.35, // dimmest — tiny powder charge, rarely traced
  SHOTGUN: 0.4, // dim — most loads don't trace
  LMG: 0.85,    // bright — every 5th round is typically a tracer
  ENEMY: 0.8,   // bright — visible threat indicator
};

/**
 * Section B #160 — per-weapon `tracerBrightness` override. Most weapons fall
 * back to the category default; specific weapons can override here (e.g. a
 * "tracer-only" loadout bumps the brightness to 1.0).
 */
export const TRACER_BRIGHTNESS_BY_WEAPON: Record<string, number> = {
  // No per-weapon overrides yet — all weapons use the category default. Add
  // entries here when a specific weapon needs a non-default tracer brightness.
};

/** Get the per-weapon tracer brightness. Falls back to the category default. */
export function getTracerBrightness(weaponSlug: string, category: string): number {
  return TRACER_BRIGHTNESS_BY_WEAPON[weaponSlug] ?? TRACER_BRIGHTNESS_BY_CATEGORY[category] ?? 0.7;
}

/**
 * Section B #160 — day/night multiplier for tracer visibility. At noon
 * (ambientLight ≥ 1.0), the multiplier is 0.5 (tracers dim against the bright
 * sky). At midnight (ambientLight ≤ 0.0), the multiplier is 1.8 (tracers glow
 * against the dark sky). Linear in between.
 *
 * @param ambientLight  0..1+ (0 = pitch black, 1 = full daylight).
 */
export function tracerDayNightMult(ambientLight: number): number {
  const a = Math.max(0, Math.min(1, ambientLight));
  // Linear from 1.8 at a=0 → 0.5 at a=1.
  return 1.8 - 1.3 * a;
}

/**
 * Section B #160 — compute the tracer's length scale + opacity given the
 * bullet's velocity, the weapon's tracerBrightness, and the ambient light.
 *
 * Length scales linearly with velocity (a 900 m/s bullet = 1.0× length; a
 * 300 m/s bullet = 0.33× length). Opacity = brightness × day/night mult,
 * clamped to [0.05, 1.0].
 *
 * Returns { lengthMult, opacity } for the renderer.
 */
export function computeTracerVisibility(
  bulletVelocityMs: number,
  weaponSlug: string,
  category: string,
  ambientLight: number,
): { lengthMult: number; opacity: number } {
  const brightness = getTracerBrightness(weaponSlug, category);
  const dayNight = tracerDayNightMult(ambientLight);
  // Reference velocity for 1.0× length: 900 m/s (rifle muzzle velocity).
  const lengthMult = Math.max(0.15, Math.min(1.5, bulletVelocityMs / 900));
  const opacity = Math.max(0.05, Math.min(1.0, brightness * dayNight));
  return { lengthMult, opacity };
}
