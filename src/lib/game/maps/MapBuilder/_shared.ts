/**
 * Phase 10+ (Task 2 — Environment Upgrade): Map builder.
 *
 * Constructs the scene from a MapDefinition using detailed, production-quality
 * tactical shooter props. Each builder function creates shaped geometry
 * (ExtrudeGeometry, LatheGeometry, merged boxes, beveled crates, sandbag
 * clusters, corrugated containers, etc.) with PBR materials, registers
 * colliders for every solid surface, and registers explosive props
 * (oil barrels) as destructibles.
 *
 * Backward compatibility:
 *   - Legacy types "box" | "cylinder" | "destructible" still work unchanged.
 *   - New tactical types ("crate", "ammo_box", "sandbag_bunker", "barrier",
 *     "container", "barrel", "pallet", "generator", "building", "dumpster",
 *     "barricade", "sandbag_wall", "crate_stack", "hesco", "ac_unit",
 *     "water_tank", "satellite", "tent", "fuel_bladder", "comms_tower",
 *     "car", "phone_booth", "target", "pillar", "shelf", "skybridge")
 *     dispatch to dedicated builder functions.
 *
 * Lighting floor (per Lead constraint):
 *   applyMapLighting enforces sun >= 1.0, hemi >= 0.5, fog density <= 0.015
 *   so the map is always clearly visible.
 */

import * as THREE from "three";
import type { GameContext, Collider, DestructibleProp } from "../../systems/types";
import type { MapDefinition, MapProp } from "../MapRegistry";
import {
  concreteTexture, concreteRoughnessTexture, sandTexture,
  woodTexture, metalTexture, brickTexture,
} from "../../textures";
import { SURFACE_MATERIAL_MAP } from "../../realism";
// Section M — photogrammetry PBR surface class type + material factory.
import { buildPbrMaterial } from "../photogrammetry";
import type { PbrSurfaceClass } from "../photogrammetry";

export interface BuiltMap {
  ground: THREE.Mesh;
  props: THREE.Object3D[];
  colliders: Collider[];
  destructibles: DestructibleProp[];
  /** V2 — chunk groups for frustum-gated streaming. Each group holds all
   *  props whose (x,z) center falls within that chunk's grid cell. The
   *  ChunkManager toggles `group.visible` per-frame based on the camera
   *  frustum. Groups are added to the scene with `visible=false` initially;
   *  the ChunkManager activates them as the player looks around. */
  chunkGroups: Map<string, THREE.Group>;
  /** Grid cell size (meters) used to compute chunk keys. */
  chunkSize: number;
}

/** Shared build context passed to all builder functions. */
export interface BuildContext {
  scene: THREE.Scene;
  colliders: Collider[];
  destructibles: DestructibleProp[];
  matCache: MaterialCache;
}

/** No-op raycast override used on decorative child meshes so the
 *  destructible parent mesh is the one the weapon raycaster hits. */
export const NO_RAYCAST = (): void => {};

/** Extended material tag set used by the new tactical props. */
export type MaterialTag =
  | "concrete" | "brick" | "wood" | "metal" | "sand" | "barrel"
  | "olive" | "oliveDark" | "canvas" | "rust"
  | "containerRed" | "containerBlue" | "containerGreen"
  | "glass" | "fabric" | "rubber" | "asphalt" | "charred" | "sandbag"
  // ── Section M — biome PBR surface classes (resolved via photogrammetry.ts) ──
  | "snow" | "ice" | "mud" | "jungle_floor"
  | "sand_wet" | "rock" | "gravel"
  | "mossy_concrete" | "rusted_metal" | "frozen_metal" | "wet_asphalt"
  | "scorched_concrete";

/** Material cache (avoids re-creating textures per prop). */
export class MaterialCache {
  private cache = new Map<string, THREE.Material>();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) { this.scene = scene; }

  getMaterial(type: MaterialTag | string): THREE.Material {
    if (this.cache.has(type)) return this.cache.get(type)!;
    let mat: THREE.Material;
    switch (type) {
      case "concrete": {
        const tex = concreteTexture(); tex.repeat.set(10, 3);
        const rough = concreteRoughnessTexture(); rough.repeat.set(10, 3);
        mat = new THREE.MeshStandardMaterial({ map: tex, roughnessMap: rough, roughness: 0.9, metalness: 0.05 });
        break;
      }
      case "brick": {
        const tex = brickTexture(); tex.repeat.set(3, 2);
        mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.02 });
        break;
      }
      case "wood": {
        const tex = woodTexture();
        mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
        break;
      }
      case "metal": {
        const tex = metalTexture();
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0xb5563a, roughness: 0.55, metalness: 0.65 });
        break;
      }
      case "sand": {
        const tex = sandTexture();
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0xc9b08a, roughness: 1, metalness: 0 });
        break;
      }
      case "barrel": {
        mat = new THREE.MeshStandardMaterial({ color: 0xb33a2a, roughness: 0.5, metalness: 0.7 });
        break;
      }
      // --- New tactical materials ---
      case "olive": {
        const tex = metalTexture();
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0x4a4a2e, roughness: 0.6, metalness: 0.55 });
        break;
      }
      case "oliveDark": {
        const tex = metalTexture();
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0x2e3320, roughness: 0.65, metalness: 0.5 });
        break;
      }
      case "canvas": {
        mat = new THREE.MeshStandardMaterial({ color: 0x6b6a4a, roughness: 0.95, metalness: 0 });
        break;
      }
      case "fabric": {
        mat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 0.95, metalness: 0 });
        break;
      }
      case "rust": {
        const tex = metalTexture();
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0x6b3a28, roughness: 0.85, metalness: 0.4 });
        break;
      }
      case "containerRed": {
        const tex = metalTexture(); tex.repeat.set(2, 1);
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0xa83828, roughness: 0.6, metalness: 0.55 });
        break;
      }
      case "containerBlue": {
        const tex = metalTexture(); tex.repeat.set(2, 1);
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0x2a4a78, roughness: 0.6, metalness: 0.55 });
        break;
      }
      case "containerGreen": {
        const tex = metalTexture(); tex.repeat.set(2, 1);
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0x3a5a3a, roughness: 0.6, metalness: 0.55 });
        break;
      }
      case "glass": {
        mat = new THREE.MeshStandardMaterial({
          color: 0x9ec4d8, roughness: 0.1, metalness: 0.2,
          transparent: true, opacity: 0.35,
        });
        break;
      }
      case "rubber": {
        mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.9, metalness: 0.1 });
        break;
      }
      case "asphalt": {
        mat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.92, metalness: 0.05 });
        break;
      }
      case "charred": {
        const tex = metalTexture();
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0x1a1410, roughness: 0.95, metalness: 0.2 });
        break;
      }
      case "sandbag": {
        const tex = sandTexture(); tex.repeat.set(1, 1);
        mat = new THREE.MeshStandardMaterial({ map: tex, color: 0xb89e72, roughness: 1, metalness: 0 });
        break;
      }
      // ── Section M — new biome-specific materials (lazy PBR) ──
      case "snow":
      case "ice":
      case "mud":
      case "jungle_floor":
      case "sand_wet":
      case "rock":
      case "gravel":
      case "mossy_concrete":
      case "rusted_metal":
      case "frozen_metal":
      case "wet_asphalt":
      case "scorched_concrete": {
        mat = buildPbrMaterial(type as PbrSurfaceClass, { repeat: 1 });
        break;
      }
      default:
        mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
    }
    this.cache.set(type, mat);
    return mat;
  }

  /** Get a tinted variant of a base material (clones the cached base). */
  getTinted(base: MaterialTag, color: number, roughness?: number, metalness?: number): THREE.Material {
    const key = `tint:${base}:${color.toString(16)}:${roughness ?? ""}:${metalness ?? ""}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const baseMat = this.getMaterial(base) as THREE.MeshStandardMaterial;
    const clone = baseMat.clone();
    clone.color = new THREE.Color(color);
    if (roughness !== undefined) clone.roughness = roughness;
    if (metalness !== undefined) clone.metalness = metalness;
    // Cloned materials share the same texture; safe.
    this.cache.set(key, clone);
    return clone;
  }

  dispose(): void {
    for (const mat of this.cache.values()) mat.dispose();
    this.cache.clear();
  }
}

// ============================================================
// Build context helpers
// ============================================================

/** Tag a mesh with surface + material info, enable shadows. */
export function tagMesh(mesh: THREE.Mesh, surfaceType: string, materialSlug: string, cast = true, receive = true): void {
  mesh.userData.surfaceType = surfaceType;
  mesh.userData.materialSlug = materialSlug;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
}

/** Mark a mesh as contributing a collider (for hollow/segmented props). */
export function markCollider(mesh: THREE.Mesh): void {
  mesh.userData.colliderTag = true;
}

/** Disable raycast on a decorative child so the destructible parent is hit instead. */
export function noRaycast(mesh: THREE.Mesh): void {
  mesh.raycast = NO_RAYCAST;
}

/** Add a box mesh to a parent group, optionally tagged for collider + destructible surface. */
export function addBox(
  parent: THREE.Object3D,
  x: number, y: number, z: number,
  w: number, h: number, d: number,
  material: THREE.Material,
  opts: { surface?: string; materialSlug?: string; collider?: boolean; cast?: boolean; receive?: boolean; raycast?: boolean } = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = opts.cast ?? true;
  mesh.receiveShadow = opts.receive ?? true;
  if (opts.surface) mesh.userData.surfaceType = opts.surface;
  if (opts.materialSlug) mesh.userData.materialSlug = opts.materialSlug;
  if (opts.collider) markCollider(mesh);
  if (opts.raycast === false) noRaycast(mesh);
  parent.add(mesh);
  return mesh;
}

/** Add a cylinder mesh to a parent group. */
export function addCyl(
  parent: THREE.Object3D,
  x: number, y: number, z: number,
  rTop: number, rBot: number, h: number, radial: number,
  material: THREE.Material,
  opts: { surface?: string; materialSlug?: string; collider?: boolean; cast?: boolean; receive?: boolean; rotX?: number; rotZ?: number; raycast?: boolean } = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, radial), material);
  mesh.position.set(x, y, z);
  if (opts.rotX !== undefined) mesh.rotation.x = opts.rotX;
  if (opts.rotZ !== undefined) mesh.rotation.z = opts.rotZ;
  mesh.castShadow = opts.cast ?? true;
  mesh.receiveShadow = opts.receive ?? true;
  if (opts.surface) mesh.userData.surfaceType = opts.surface;
  if (opts.materialSlug) mesh.userData.materialSlug = opts.materialSlug;
  if (opts.collider) markCollider(mesh);
  if (opts.raycast === false) noRaycast(mesh);
  parent.add(mesh);
  return mesh;
}

/** Add a sphere mesh to a parent group. */
export function addSphere(
  parent: THREE.Object3D,
  x: number, y: number, z: number,
  r: number, segments: number,
  material: THREE.Material,
  opts: { surface?: string; materialSlug?: string; collider?: boolean; scaleX?: number; scaleY?: number; scaleZ?: number; raycast?: boolean } = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, segments, Math.max(6, segments / 2)), material);
  mesh.position.set(x, y, z);
  if (opts.scaleX !== undefined || opts.scaleY !== undefined || opts.scaleZ !== undefined) {
    mesh.scale.set(opts.scaleX ?? 1, opts.scaleY ?? 1, opts.scaleZ ?? 1);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (opts.surface) mesh.userData.surfaceType = opts.surface;
  if (opts.materialSlug) mesh.userData.materialSlug = opts.materialSlug;
  if (opts.collider) markCollider(mesh);
  if (opts.raycast === false) noRaycast(mesh);
  parent.add(mesh);
  return mesh;
}

/** Add a mesh from an arbitrary geometry to a parent group. */
export function addMesh(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  x: number, y: number, z: number,
  opts: { surface?: string; materialSlug?: string; collider?: boolean; rotX?: number; rotY?: number; rotZ?: number; raycast?: boolean } = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(x, y, z);
  if (opts.rotX !== undefined) mesh.rotation.x = opts.rotX;
  if (opts.rotY !== undefined) mesh.rotation.y = opts.rotY;
  if (opts.rotZ !== undefined) mesh.rotation.z = opts.rotZ;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (opts.surface) mesh.userData.surfaceType = opts.surface;
  if (opts.materialSlug) mesh.userData.materialSlug = opts.materialSlug;
  if (opts.collider) markCollider(mesh);
  if (opts.raycast === false) noRaycast(mesh);
  parent.add(mesh);
  return mesh;
}

/** Register a single AABB collider for an entire group (solid props). */
export function registerGroupCollider(bctx: BuildContext, group: THREE.Object3D): Collider {
  const collider: Collider = { box: new THREE.Box3().setFromObject(group) };
  bctx.colliders.push(collider);
  return collider;
}

/** Register one AABB collider per child mesh tagged with `colliderTag`
 *  (for hollow/segmented props like buildings and containers). */
export function registerTaggedColliders(bctx: BuildContext, group: THREE.Object3D): Collider[] {
  const added: Collider[] = [];
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.userData.colliderTag) {
      const c: Collider = { box: new THREE.Box3().setFromObject(obj) };
      bctx.colliders.push(c);
      added.push(c);
    }
  });
  return added;
}

/** Register a single mesh as a destructible prop. */
export function registerDestructible(
  bctx: BuildContext,
  mesh: THREE.Mesh,
  hp: number,
  materialSlug: string,
  surfaceType: string,
): DestructibleProp {
  mesh.userData.surfaceType = surfaceType;
  mesh.userData.materialSlug = materialSlug;
  mesh.userData.destructible = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  bctx.scene.add(mesh);
  const collider: Collider = { box: new THREE.Box3().setFromObject(mesh) };
  bctx.colliders.push(collider);
  const prop: DestructibleProp = {
    mesh, health: hp, maxHealth: hp, materialSlug,
    stage: 0, collider, baseScale: 1,
  };
  bctx.destructibles.push(prop);
  return prop;
}

// ============================================================
// Main build entry point
// ============================================================

/** Build a map into the scene.
 *  V2 — props are grouped into chunk groups (16m grid cells) for frustum-gated
 *  streaming. All props are built upfront (colliders + meshes), then reparented
 *  into chunk groups. The ChunkManager toggles each group's `visible` flag
 *  per-frame based on the camera frustum. Three.js Raycaster does NOT check
 *  `visible`, so bullets + enemy LOS still work on invisible (off-screen) chunks. */
