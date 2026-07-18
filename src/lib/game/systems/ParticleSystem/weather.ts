// Ambient particle concerns (muzzle smoke, ground dust) — split out from
// ParticleSystem.ts. ACTUAL weather (rain, snow, fog volumetrics) lives in
// WeatherSystem.ts; this module only owns the non-weather ambient particle
// helpers that ParticleSystem spawns directly.
//
// Why a separate file: keeps the ParticleSystem.ts class focused on combat
// VFX (decals / tracers / debris). Ambient particles have different
// lifetime + visibility rules (long-lived, frustum-culled, additive-blended)
// that benefit from being isolated.

import * as THREE from "three";
import { smokeTexture } from "../../textures";

/** Muzzle smoke puff — short-lived additive sprite emitted on each shot.
 *  Suppressed weapons get a smaller, darker puff. The ParticleSystem class
 *  calls this from spawnMuzzleSmoke(); kept here so the smoke texture factory
 *  and tuning constants live with their concern. */
export const MUZZLE_SMOKE_LIFETIME = 0.45; // seconds
export const MUZZLE_SMOKE_SUPPRESSED_LIFETIME = 0.25;
export const MUZZLE_SMOKE_SCALE_START = 0.04;
export const MUZZLE_SMOKE_SCALE_END = 0.18;

/** Procedural ambient dust field parameters — used by buildMap() in
 *  MapBuilder/geometry.ts (NOT by ParticleSystem). Documented here because
 *  it's the closest "ambient particle" concern to weather. */
export const AMBIENT_DUST_PARTICLE_COUNT = 200;
export const AMBIENT_DUST_FIELD_SIZE = 80; // meters
export const AMBIENT_DUST_HEIGHT = 2.5; // meters above ground

/** Lazy smoke-texture getter (mirrors the cached-factory pattern used by
 *  decals/tracers). */
let _smokeTex: THREE.Texture | null = null;
export function getSmokeTexture(): THREE.Texture {
  if (!_smokeTex) _smokeTex = smokeTexture();
  return _smokeTex;
}
