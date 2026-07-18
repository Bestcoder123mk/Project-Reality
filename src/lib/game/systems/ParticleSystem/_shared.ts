import * as THREE from "three";
import type { GameSystem, GameContext, Enemy } from "../types";
import type { HudState } from "../../store";
import { particleTexture, smokeTexture, bulletHoleTexture } from "../../textures";
import { ObjectPool, type PooledParticle, type PooledTracer } from "../ObjectPool";
import type { WeaponType } from "../../store";
import { isNight } from "../../realism";
/** Pool size for shell casings (dedicated, capped). */
export const SHELL_POOL_SIZE = 30;
/** Task-25: explosion element pool sizes. Explosions are infrequent
 *  (grenades + barrel chain reactions) so small pools suffice. */
export const FLASH_POOL_SIZE = 4;
export const SHOCKWAVE_POOL_SIZE = 4;
export const EXPLOSION_LIGHT_POOL_SIZE = 4;

/** REALISM-1 (task B): scope glint pool — small (only a handful of snipers
 *  scope in on the player at once). */
export const SCOPE_GLINT_POOL_SIZE = 4;
/** Scope glint lifetime (s) — ~1.5s matches the spec. */
export const SCOPE_GLINT_LIFETIME = 1.5;
/** Tracked active shell casing entry. */
export interface PooledShell {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  angVel: THREE.Vector3;
  life: number;
  maxLife: number;
  settled: boolean;
  active: boolean;
}

/** Task-25: tracked active explosion flash (sphere + light). */
export interface PooledFlash {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  scaleStart: number;
  scaleEnd: number;
  active: boolean;
}

/** Task-25: tracked active explosion point light. */
export interface PooledExplosionLight {
  light: THREE.PointLight;
  life: number;
  maxLife: number;
  active: boolean;
}

/** Task-25: tracked active shockwave ring. */
export interface PooledShockwave {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  scaleStart: number;
  scaleEnd: number;
  active: boolean;
}

/** Task-25: tracked active explosion debris chunk (bounces once, settles). */
export interface PooledExplosionDebris {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  angVel: THREE.Vector3;
  life: number;
  maxLife: number;
  bounceCount: number;
  settled: boolean;
  active: boolean;
}

/** Task-32: tracked active blood drip streak (on walls, grows downward). */
export interface PooledBloodDrip {
  mesh: THREE.Mesh;
  growProgress: number; // 0 → 1 over 2s
  life: number;          // remaining lifetime (fades in last 2s)
  maxLife: number;
  active: boolean;
}

/** Task-32: tracked active blood pool (under corpses, grows + persists).
 *  `followTarget` is the enemy body whose world position the pool follows
 *  during the 3s growth (so it stays under the ragdoll as it settles). */
export interface PooledBloodPool {
  mesh: THREE.Mesh;
  satellites: THREE.Mesh[];
  followTarget: { body: THREE.Mesh; alive: boolean } | null;
  growProgress: number; // 0 → 1 over 3s
  baseScale: number;    // target scale multiplier
  active: boolean;
}

/** REALISM-1 (task B): tracked active sniper scope glint. A bright warm-white
 *  billboard sprite at the sniper's position that flickers on a sin-wave to
 *  mimic the sun catching the ocular lens of a scoped rifle. Visible for ~1.5s. */
export interface PooledScopeGlint {
  sprite: THREE.Sprite;
  /** Total lifetime (s). Counts down from maxLife → 0. */
  life: number;
  maxLife: number;
  /** Phase offset so concurrent glints don't flicker in lockstep. */
  phase: number;
  /** Frequency of the intensity flicker (Hz). ~12 Hz mimics sun-catch shimmer. */
  flickerFreq: number;
  active: boolean;
}
