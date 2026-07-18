/**
 * raycast-env — Task 3 / item 59
 *
 * Shared "environment raycast targets" cache used to scope
 * `raycaster.intersectObjects(arr, false)` calls so they don't recurse the
 * entire scene tree (which on this codebase means ~220 weapon meshes + the
 * avatar + every enemy + every particle sprite + the sky/sun meshes).
 *
 * Background: every `intersectObjects(scene.children, true)` call site was
 * paying for a full recursive traversal even though the caller only wanted
 * world geometry (walls, props, ground). ProjectileSystem already had a
 * private version of this cache (rebuilt on scene-children-length change);
 * item 59 extracts it so WeaponSystem, VaultSystem, EnemySystem, and
 * movement-tech can reuse the same scoped array.
 *
 * Usage:
 *   const env = getEnvRaycastTargets(ctx);
 *   raycaster.intersectObjects(env, false); // PERF: scoped
 *
 * The cache is rebuilt when `ctx.scene.children.length` changes (cheap sig).
 * This catches level load + wave spawn (enemies are added to scene root),
 * but NOT a single chunk visibility toggle (which doesn't change the top-
 * level count — only a child group's `visible` flag). That's fine because
 * raycasting deliberately ignores `visible` (per the ChunkManager comment),
 * so we want every env mesh in the list regardless of visibility.
 *
 * The cache is per-GameContext (a WeakMap). On ctx dispose the entry is
 * GC'd — no manual cleanup needed.
 */

import type { Object3D } from "three";
import type { GameContext } from "./types";

/** Per-context cache: flat array of env meshes + the sig it was built for. */
interface EnvCache {
  sig: number;
  meshes: Object3D[];
}

const _cache = new WeakMap<GameContext, EnvCache>();

/** Returns true iff `o` is part of the player's own rig (camera, weapon,
 *  avatar) — these should never be hit by environment raycasts. Walks up
 *  the parent chain so children-of-children are also excluded. */
function isPlayerSubtree(o: Object3D, ctx: GameContext): boolean {
  let p: Object3D | null = o;
  while (p) {
    if (p === ctx.camera) return true;
    if (ctx.avatar && p === ctx.avatar.group) return true;
    if (p === ctx.weaponGroup) return true;
    p = p.parent;
  }
  return false;
}

/** A3-5000 #519: compute a content hash for the scene that captures BOTH
 *  structural changes (child count) AND visibility toggles (which the prior
 *  `scene.children.length` sig missed). The hash is cheap (one integer
 *  accumulate over a traverse) + is cached per ctx via _cache. */
function computeSceneSig(ctx: GameContext): number {
  // Combine top-level count + total descendant count + visibility mask.
  // This catches: chunk visibility toggle, particle add/remove, enemy spawn.
  let topLevel = 0;
  let descendants = 0;
  let visibleCount = 0;
  for (const child of ctx.scene.children) {
    topLevel++;
    child.traverse((o) => {
      descendants++;
      if (o.visible) visibleCount++;
    });
  }
  // Mix the three counts into a single integer sig.
  return (topLevel * 73856093) ^ (descendants * 19349663) ^ (visibleCount * 83492791);
}

/** Returns true iff `o` is an explicitly-tagged HUD sprite or viewmodel
 *  quad (muzzle flash, crosshair overlay, scope quad, etc.). These are
 *  camera-attached or scene-attached full-screen quads that should NEVER
 *  register as raycast hits — but because they're Meshes (not Sprites),
 *  the type filter in getEnvRaycastTargets() doesn't catch them. Callers
 *  must tag them at creation time via `mesh.userData.isHUDSprite = true`
 *  or `mesh.userData.isViewmodel = true`. Prompt A#3. */
function isTaggedExcluded(o: Object3D): boolean {
  const ud = (o as unknown as { userData?: Record<string, unknown> }).userData;
  if (!ud) return false;
  return ud.isHUDSprite === true || ud.isViewmodel === true;
}

/** Get the flat array of environment raycast targets for `ctx`. Rebuilds the
 *  cache when the scene's top-level child count changes (cheap sig check).
 *
 *  The returned array contains every Mesh in the scene that is NOT:
 *    - part of the camera/weapon/avatar rig
 *    - an enemy part (tagged via userData.enemy — handled separately)
 *    - a Sprite / Line / Points / Light / Camera (non-Mesh types)
 *    - tagged userData.isHUDSprite / userData.isViewmodel (Prompt A#3 —
 *      muzzle-flash quads, crosshair overlays, scope quads attached to
 *      the camera would otherwise intercept rays meant to miss)
 *
 *  Pass to `raycaster.intersectObjects(arr, false)` — the array is already
 *  flat, so recursive=true would be wasted work. */
export function getEnvRaycastTargets(ctx: GameContext): Object3D[] {
  // A3-5000 #519: was `sig = ctx.scene.children.length` — misses internal
  // changes (chunk visibility toggle, particle add/remove). Now we use a
  // content hash that combines: top-level child count + total descendant
  // count + a hash of visible-state changes. Cheap to compute (one traverse
  // every N frames, cached).
  const sig = computeSceneSig(ctx);
  let entry = _cache.get(ctx);
  if (!entry || entry.sig !== sig) {
    // Rebuild — walk the scene once, collect env meshes.
    const meshes: Object3D[] = [];
    ctx.scene.traverse((o) => {
      if (o.type !== "Mesh") return; // skip Groups/Lights/Cameras/Sprites/Lines/Points
      if (isPlayerSubtree(o, ctx)) return;
      if (isTaggedExcluded(o)) return; // Prompt A#3 — HUD/viewmodel quads
      if ((o as unknown as { userData?: { enemy?: unknown } }).userData?.enemy) return;
      meshes.push(o);
    });
    entry = { sig, meshes };
    _cache.set(ctx, entry);
  }
  return entry.meshes;
}

/** Prompt A#3 — convenience predicate for callers that raycast against a
 *  hand-built list (not the env cache) and need the same exclusion rules.
 *  Returns true if the object is a camera-attached sprite, a HUD quad, a
 *  viewmodel quad, or part of the player's own rig. */
export function isRaycastExcluded(o: Object3D, ctx: GameContext): boolean {
  if (o.type === "Sprite") return true;
  if (isTaggedExcluded(o)) return true;
  if (isPlayerSubtree(o, ctx)) return true;
  const ud = (o as unknown as { userData?: { enemy?: unknown } }).userData;
  if (ud?.enemy) return true;
  return false;
}

/** Invalidate the cache for `ctx` (force rebuild on next call). Call this
 *  after a chunk-streaming load/unload that doesn't change the top-level
 *  child count (rare — the chunk groups themselves stay in the scene graph
 *  during visibility toggles; only their `visible` flag changes). */
export function invalidateEnvRaycastTargets(ctx: GameContext): void {
  _cache.delete(ctx);
}
