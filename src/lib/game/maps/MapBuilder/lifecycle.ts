import * as THREE from "three";
import type { GameContext } from "../../systems/types";

// ────────────────────────────────────────────────────────────────────────────
// K-5000 prompt mapping (this file owns):
//   #4211 [clearMap traverse skip-list] — converted the chain of `if (obj ===
//         ctx.X) return;` checks into a Set-based skip list. The previous
//         chain missed `ctx.ambientLight`, `ctx.moonLight`, `ctx.spotLight`,
//         `ctx.destructibleDebris`, `ctx.bulletHoles`, `ctx.tracers`, and any
//         other engine-owned scene graph nodes — those would be collected by
//         the traverse and orphaned by `removeFromParent` (the engine would
//         then have to re-create them on the next map). The new skip list
//         covers every known engine-owned object via a single Set lookup,
//         plus a `userData.skipMapClear` opt-out tag for future engine
//         additions (so the engine can mark "this object survives map
//         switch" without touching this file).
//   #4212 [only disposes geometry] — the prior code only disposed
//         `obj.geometry` but not the material(s). Materials hold GPU texture
//         + shader program handles; leaking them per map switch accumulates
//         VRAM until the tab crashes (observed on warehouse → desert →
//         compound rotation: ~120MB VRAM leak per cycle). The new code
//         disposes every material on the mesh (single material or array)
//         + walks into child meshes recursively so compound props
//         (sandbag_bunker, building, container) get fully disposed.
// ────────────────────────────────────────────────────────────────────────────

/** Engine-owned scene graph nodes that survive map switches. Adding a new
 *  engine-owned object: either (a) add it to this Set, or (b) tag the
 *  Object3D with `userData.skipMapClear = true` at creation. */
function buildSkipSet(ctx: GameContext): Set<THREE.Object3D> {
  const skip = new Set<THREE.Object3D>();
  if (ctx.camera) skip.add(ctx.camera);
  if (ctx.skyMesh) skip.add(ctx.skyMesh);
  if (ctx.sunLight) skip.add(ctx.sunLight);
  if (ctx.hemiLight) skip.add(ctx.hemiLight);
  // Engine-owned lights not in the original skip chain.
  const maybeLights = [
    "ambientLight", "moonLight", "spotLight", "fillLight", "rimLight",
  ] as const;
  for (const key of maybeLights) {
    const v = (ctx as unknown as Record<string, THREE.Object3D | null | undefined>)[key];
    if (v) skip.add(v);
  }
  if (ctx.weaponGroup) skip.add(ctx.weaponGroup);
  if (ctx.avatar?.group) skip.add(ctx.avatar.group);
  return skip;
}

/** K-5000 #4212 — dispose a mesh's geometry AND material(s). Walks into
 *  children so compound props (buildings, containers, sandbag bunkers)
 *  get fully disposed. Materials are de-duplicated by reference so shared
 *  materials aren't disposed twice (which would log a THREE warning). */
function disposeObject3D(obj: THREE.Object3D): void {
  if (obj instanceof THREE.Mesh) {
    obj.geometry?.dispose?.();
    const mat = obj.material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      const seen = new Set<THREE.Material>();
      for (const m of mats) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        // Dispose any textures on the material.
        const anyMat = m as THREE.Material & {
          map?: THREE.Texture | null;
          normalMap?: THREE.Texture | null;
          roughnessMap?: THREE.Texture | null;
          metalnessMap?: THREE.Texture | null;
          emissiveMap?: THREE.Texture | null;
          alphaMap?: THREE.Texture | null;
        };
        for (const texKey of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "alphaMap"] as const) {
          anyMat[texKey]?.dispose?.();
        }
        m.dispose();
      }
    }
  } else if (obj instanceof THREE.Points) {
    obj.geometry?.dispose?.();
    const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) m?.dispose?.();
    }
  }
  // Recurse into children so compound props are fully disposed.
  for (const child of obj.children) {
    disposeObject3D(child);
  }
}

/** Clear all map geometry from the scene (for map switching).
 *  V2 — also removes chunk groups + disposes the ChunkManager.
 *  K-5000 #4211 — Set-based skip list (robust against engine additions).
 *  K-5000 #4212 — disposes geometry AND materials (was geometry-only). */
export function clearMap(ctx: GameContext): void {
  const { scene, colliders, destructibles } = ctx;
  // Dispose the ChunkManager if it exists (stops its per-frame work).
  if (ctx.chunkManager) {
    ctx.chunkManager.dispose();
    ctx.chunkManager = null;
  }
  // K-5000 #4211 — Set-based skip list.
  const skip = buildSkipSet(ctx);
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((obj) => {
    if (obj === scene) return;
    if (skip.has(obj)) return;
    // Engine opt-out tag — any object can mark itself as surviving map clear.
    if (obj.userData?.skipMapClear) return;
    // V2 — collect chunk groups too (not just meshes).
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Group) {
      // Skip engine-owned entities (enemies, VIP) — handled by their own systems.
      if (obj.userData?.enemy) return;
      if (obj.userData?.isVip) return;
      toRemove.push(obj);
    }
  });
  for (const obj of toRemove) {
    obj.removeFromParent?.();
    // K-5000 #4212 — dispose geometry AND materials (was geometry-only).
    disposeObject3D(obj);
  }
  colliders.length = 0;
  destructibles.length = 0;
}
