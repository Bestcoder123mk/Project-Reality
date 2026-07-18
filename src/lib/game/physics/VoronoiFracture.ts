/**
 * Phase 1: Voronoi pre-fracture system.
 *
 * Pre-fractures destructible props into Voronoi shards at load time.
 * When a prop is destroyed, the shards become dynamic rigid bodies that
 * scatter with realistic physics (via JoltPhysics or the AABB fallback).
 *
 * The Voronoi algorithm is a pure-TS implementation (no external dep):
 *   1. Generate N random seed points inside the prop's AABB.
 *   2. For each seed, compute the Voronoi cell by clipping the AABB
 *      against the half-space planes of all other seeds.
 *   3. Each cell becomes a shard mesh (convex hull of the cell vertices).
 *
 * The shards are pre-built and stored dormant. On prop destruction,
 * they're activated as dynamic bodies with outward velocity.
 */

import * as THREE from "three";

export interface VoronoiShard {
  /** Convex hull vertices of the shard. */
  vertices: THREE.Vector3[];
  /** Center of mass. */
  center: THREE.Vector3;
  /** The mesh to render (created lazily on activation). */
  mesh?: THREE.Mesh;
  /** Whether the shard is currently active (simulated). */
  active: boolean;
}

export interface PreFracturedProp {
  /** Original prop mesh. */
  sourceMesh: THREE.Mesh;
  /** Pre-computed shards. */
  shards: VoronoiShard[];
  /** AABB of the original prop. */
  aabb: THREE.Box3;
}

/**
 * Pre-fracture a mesh into N Voronoi shards.
 * Returns the shards (dormant) + their geometry.
 */
export function preFracture(mesh: THREE.Mesh, shardCount: number = 14): PreFracturedProp {
  const aabb = new THREE.Box3().setFromObject(mesh);
  const size = aabb.getSize(new THREE.Vector3());
  // Generate random seed points inside the AABB.
  const seeds: THREE.Vector3[] = [];
  for (let i = 0; i < shardCount; i++) {
    seeds.push(new THREE.Vector3(
      aabb.min.x + Math.random() * size.x,
      aabb.min.y + Math.random() * size.y,
      aabb.min.z + Math.random() * size.z,
    ));
  }
  // Compute Voronoi cells by clipping.
  const shards: VoronoiShard[] = seeds.map((seed, i) => {
    // Start with the full AABB.
    let cell = [
      new THREE.Vector3(aabb.min.x, aabb.min.y, aabb.min.z),
      new THREE.Vector3(aabb.max.x, aabb.min.y, aabb.min.z),
      new THREE.Vector3(aabb.max.x, aabb.max.y, aabb.min.z),
      new THREE.Vector3(aabb.min.x, aabb.max.y, aabb.min.z),
      new THREE.Vector3(aabb.min.x, aabb.min.y, aabb.max.z),
      new THREE.Vector3(aabb.max.x, aabb.min.y, aabb.max.z),
      new THREE.Vector3(aabb.max.x, aabb.max.y, aabb.max.z),
      new THREE.Vector3(aabb.min.x, aabb.max.y, aabb.max.z),
    ];
    // Clip against each other seed's half-space.
    for (let j = 0; j < seeds.length; j++) {
      if (i === j) continue;
      cell = clipHalfSpace(cell, seed, seeds[j]);
      if (cell.length === 0) break;
    }
    // Compute center of mass.
    const center = cell.reduce((acc, v) => acc.add(v), new THREE.Vector3()).divideScalar(cell.length || 1);
    return { vertices: cell, center, active: false };
  }).filter((s) => s.vertices.length >= 4); // need at least 4 verts for a volume
  return { sourceMesh: mesh, shards, aabb };
}

/**
 * Clip a convex polyhedron against a half-space.
 * Keeps vertices on the "seed" side of the plane perpendicular to (other - seed)
 * passing through the midpoint.
 */
function clipHalfSpace(cell: THREE.Vector3[], seed: THREE.Vector3, other: THREE.Vector3): THREE.Vector3[] {
  const normal = other.clone().sub(seed).normalize();
  const midpoint = seed.clone().add(other).multiplyScalar(0.5);
  const result: THREE.Vector3[] = [];
  for (let i = 0; i < cell.length; i++) {
    const a = cell[i];
    const b = cell[(i + 1) % cell.length];
    const da = a.clone().sub(midpoint).dot(normal);
    const db = b.clone().sub(midpoint).dot(normal);
    if (da <= 0) result.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      result.push(a.clone().lerp(b, t));
    }
  }
  return result;
}

/**
 * Activate shards as dynamic bodies after prop destruction.
 * Returns the shard meshes to add to the scene + their initial velocities.
 *
 * Task-9 — Fixed geometry/positioning bug. The shard vertices computed by
 * `preFracture` are in WORLD space (they come from the prop's world AABB).
 * Previously `activateShards` set `mesh.position.copy(shard.center)` while
 * leaving the geometry's vertex positions in world space → the mesh's
 * effective world position was `center + vertex_world_pos` = DOUBLE the
 * intended position (shards spawned at ~2× the prop's distance from origin).
 * Now we translate the geometry into LOCAL space (vertices relative to
 * shard.center) so `mesh.position = shard.center` produces the correct
 * world position. This also lets the physics body own `shard.center` as
 * its position and update `mesh.position` each tick without the geometry
 * needing to be re-translated.
 */
export function activateShards(
  prop: PreFracturedProp,
  impactPoint: THREE.Vector3,
  force: number,
): Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3; center: THREE.Vector3 }> {
  // Task 3 / item 65 — "Reduced effects" preset: return an empty shard list.
  // The destructible prop will still be removed from the scene (the caller
  // checks the returned array length to decide whether to spawn shard
  // bodies), so the player sees the prop disappear but no shard scatter.
  // This saves both the convex-hull construction + the per-shard physics
  // body integration on integrated GPUs / mobile.
  if (_isReducedEffects()) return [];
  const result: Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3; center: THREE.Vector3 }> = [];
  const material = (prop.sourceMesh.material as THREE.MeshStandardMaterial) || new THREE.MeshStandardMaterial({ color: 0x886644, roughness: 0.8 });
  for (const shard of prop.shards) {
    if (shard.active) continue;
    shard.active = true;
    // Build a convex hull mesh from the shard vertices (translated to local
    // space relative to shard.center so the mesh origin sits at the shard's
    // center of mass — physics body position then == mesh.position).
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(shard.vertices.length * 3);
    shard.vertices.forEach((v, i) => {
      positions[i * 3]     = v.x - shard.center.x;
      positions[i * 3 + 1] = v.y - shard.center.y;
      positions[i * 3 + 2] = v.z - shard.center.z;
    });
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material.clone());
    mesh.position.copy(shard.center);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Outward velocity from impact point.
    const outward = shard.center.clone().sub(impactPoint).normalize();
    const velocity = outward.multiplyScalar(force * (0.5 + Math.random()));
    velocity.y += force * 0.5; // upward bias
    result.push({ mesh, velocity, center: shard.center.clone() });
  }
  return result;
}

// ─── Task 3 / item 65 — reduced-effects helper ───────────────────────────────
/** True when the user has enabled the "Reduced effects" preset (or the
 *  hardware benchmark auto-enabled it on an integrated GPU). When true,
 *  activateShards() returns [] so no shard meshes are created. */
function _isReducedEffects(): boolean {
  try {
    // Lazy require to avoid a static circular import at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useGameStore } = require("../store") as typeof import("../store");
    return !!useGameStore.getState().settings.extended.reducedEffects;
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Section F (#755-#765) — Material-specific fracture variants + stress
// propagation + persistent structural damage.
//
// The original `preFracture` is material-agnostic (uniform Voronoi seeds).
// Section F adds per-material variants: glass shatters into many small thin
// shards, wood splinters along the grain (elongated cells), concrete spalls
// (jagged chunks with rebar). Each variant reuses the same clipHalfSpace
// algorithm but customizes seed distribution + shard count.
// ═════════════════════════════════════════════════════════════════════════════

import type * as _THREE from "three";
import type {
  StructuralNode,
  LoadBearingWall,
  PersistentPropDamage,
} from "../systems/PhysicsEnhancements";
import {
  propagateStructuralFailure,
  identifyLoadBearingWalls,
  serializeDestructionState,
  deserializeDestructionState,
} from "../systems/PhysicsEnhancements";

/** Material type for material-aware fracture. Mirrors SurfacePhysicsType
 *  from PhysicsEnhancements (kept local to avoid a cycle through THREE). */
export type FractureMaterial = "glass" | "wood" | "concrete" | "metal" | "ice";

/** Material-specific fracture parameters. */
export interface FractureMaterialConfig {
  /** Default shard count for this material. */
  shardCount: number;
  /** Whether shards are elongated (wood splinters) or isotropic (glass). */
  elongated: boolean;
  /** Grain direction (for elongated shards). */
  grainDir?: _THREE.Vector3;
  /** Whether the material exposes rebar when broken. */
  exposesRebar: boolean;
  /** Velocity multiplier applied to shard initial velocity. */
  velocityScale: number;
}

export const FRACTURE_MATERIAL_CONFIG: Record<FractureMaterial, FractureMaterialConfig> = {
  glass:    { shardCount: 30, elongated: false, exposesRebar: false, velocityScale: 1.5 }, // #755 — many small fast shards
  wood:     { shardCount: 12, elongated: true,  grainDir: new THREE.Vector3(1, 0, 0), exposesRebar: false, velocityScale: 1.0 }, // #756 — splinters
  concrete: { shardCount: 18, elongated: false, exposesRebar: true,  velocityScale: 0.7 }, // #757 — spall + rebar
  metal:    { shardCount: 6,  elongated: false, exposesRebar: false, velocityScale: 0.6 },
  ice:      { shardCount: 25, elongated: false, exposesRebar: false, velocityScale: 1.3 }, // #755-like
};

/**
 * #755 — Pre-fracture a glass pane into many small Voronoi shards. Glass
 * shards are smaller + more numerous than concrete; the shard count scales
 * with the pane area.
 */
export function preFractureGlass(mesh: THREE.Mesh, areaFactor = 1): PreFracturedProp {
  const cfg = FRACTURE_MATERIAL_CONFIG.glass;
  return preFracture(mesh, Math.floor(cfg.shardCount * areaFactor));
}

/**
 * #756 — Pre-fracture wood into elongated splinter shards. The seeds are
 * biased along the grain direction so the Voronoi cells come out elongated
 * (long thin shards rather than cubic chunks).
 */
export function preFractureWood(mesh: THREE.Mesh, grainDir = new THREE.Vector3(1, 0, 0)): PreFracturedProp {
  const cfg = FRACTURE_MATERIAL_CONFIG.wood;
  const aabb = new THREE.Box3().setFromObject(mesh);
  const size = aabb.getSize(new THREE.Vector3());
  const seeds: THREE.Vector3[] = [];
  // Generate seeds biased along the grain axis: pack them tight across the
  // grain (perpendicular axes) + spread them along the grain.
  const grain = grainDir.clone().normalize();
  // Find the two perpendicular axes.
  const up = Math.abs(grain.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const perp1 = new THREE.Vector3().crossVectors(grain, up).normalize();
  const perp2 = new THREE.Vector3().crossVectors(grain, perp1).normalize();
  const grainLen = size.dot(grain);
  const perp1Len = size.dot(perp1);
  const perp2Len = size.dot(perp2);
  const grainCount = Math.max(3, Math.floor(cfg.shardCount * 0.7));
  const perpCount = Math.max(2, Math.ceil(cfg.shardCount / grainCount));
  for (let g = 0; g < grainCount; g++) {
    for (let p = 0; p < perpCount; p++) {
      const gt = (g + 0.5) / grainCount;
      const pt = (p + 0.5) / perpCount;
      seeds.push(
        aabb.min.clone()
          .addScaledVector(grain, gt * grainLen)
          .addScaledVector(perp1, pt * perp1Len)
          .addScaledVector(perp2, (Math.random() * 0.5 + 0.25) * perp2Len)
      );
    }
  }
  // Compute Voronoi cells (same algorithm as preFracture).
  const shards: VoronoiShard[] = seeds.map((seed, i) => {
    let cell = [
      new THREE.Vector3(aabb.min.x, aabb.min.y, aabb.min.z),
      new THREE.Vector3(aabb.max.x, aabb.min.y, aabb.min.z),
      new THREE.Vector3(aabb.max.x, aabb.max.y, aabb.min.z),
      new THREE.Vector3(aabb.min.x, aabb.max.y, aabb.min.z),
      new THREE.Vector3(aabb.min.x, aabb.min.y, aabb.max.z),
      new THREE.Vector3(aabb.max.x, aabb.min.y, aabb.max.z),
      new THREE.Vector3(aabb.max.x, aabb.max.y, aabb.max.z),
      new THREE.Vector3(aabb.min.x, aabb.max.y, aabb.max.z),
    ];
    for (let j = 0; j < seeds.length; j++) {
      if (i === j) continue;
      cell = clipHalfSpace(cell, seed, seeds[j]);
      if (cell.length === 0) break;
    }
    const center = cell.reduce((acc, v) => acc.add(v), new THREE.Vector3()).divideScalar(cell.length || 1);
    return { vertices: cell, center, active: false };
  }).filter((s) => s.vertices.length >= 4);
  return { sourceMesh: mesh, shards, aabb };
}

/**
 * #757 — Pre-fracture concrete into jagged spall chunks. Concrete fracture
 * uses the default Voronoi algorithm but with slightly fewer seeds (concrete
 * breaks into bigger chunks than glass).
 */
export function preFractureConcrete(mesh: THREE.Mesh): PreFracturedProp {
  const cfg = FRACTURE_MATERIAL_CONFIG.concrete;
  return preFracture(mesh, cfg.shardCount);
}

/**
 * Material-aware fracture dispatch. Routes to the right pre-fracture variant
 * based on the material tag (set by the map builder on the mesh's userData).
 */
export function preFractureByMaterial(mesh: THREE.Mesh): PreFracturedProp {
  const ud = mesh.userData as { fractureMaterial?: FractureMaterial };
  const mat = ud?.fractureMaterial ?? "concrete";
  switch (mat) {
    case "glass":    return preFractureGlass(mesh);
    case "wood":     return preFractureWood(mesh);
    case "concrete": return preFractureConcrete(mesh);
    case "ice":      return preFractureGlass(mesh, 0.8); // ice ≈ glass with fewer shards
    case "metal":
    default:         return preFracture(mesh, FRACTURE_MATERIAL_CONFIG[mat].shardCount);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #758 — Stress propagation in destruction.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-export the structural-failure propagator from PhysicsEnhancements so the
 * fracture layer can trigger a structural collapse when a load-bearing prop
 * is destroyed. This is the integration point between Voronoi fracture
 * (geometric shards) + structural analysis (which props collapse).
 *
 * Usage: when a destructible prop with structural metadata is destroyed:
 *   1. Call `propagateStructuralFailure(nodes, destroyedPropId)` to get the
 *      list of cascaded failures.
 *   2. For each failed node, call `activateShards(preFractureByMaterial(nodeMesh), impactPoint, force)`.
 */
export { propagateStructuralFailure, identifyLoadBearingWalls };

/**
 * Build a StructuralNode from a PreFracturedProp (for stress propagation).
 * The node's capacity is proportional to the prop's material strength.
 */
export function buildStructuralNode(
  id: string,
  prop: PreFracturedProp,
  material: FractureMaterial,
): StructuralNode {
  const capacityByMaterial: Record<FractureMaterial, number> = {
    glass: 100,    // N — glass fails easily
    wood: 800,
    concrete: 2500, // load-bearing
    metal: 5000,
    ice: 200,
  };
  return {
    id,
    pos: prop.aabb.getCenter(new THREE.Vector3()),
    capacity: capacityByMaterial[material],
    failed: false,
    supportedBy: [],
    supports: [],
  };
}

/**
 * Link structural nodes by vertical support: a node at the bottom supports
 * nodes above it (within a small horizontal tolerance). Mutates each node's
 * supportedBy + supports arrays.
 */
export function linkStructuralNodes(nodes: StructuralNode[], hTol = 0.5, vTol = 0.5): void {
  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue;
      const dx = Math.abs(a.pos.x - b.pos.x);
      const dz = Math.abs(a.pos.z - b.pos.z);
      const dy = b.pos.y - a.pos.y;
      if (dx < hTol && dz < hTol && dy > 0.1 && dy < vTol + 0.5) {
        // a is below b → a supports b.
        a.supports.push(b.id);
        b.supportedBy.push(a.id);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #759 — Load-bearing walls.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a PreFracturedProp into a LoadBearingWall (for the structural
 * analysis in PhysicsEnhancements.identifyLoadBearingWalls).
 */
export function propToLoadBearingWall(
  id: string,
  prop: PreFracturedProp,
  material: FractureMaterial,
): LoadBearingWall {
  const capacityByMaterial: Record<FractureMaterial, number> = {
    glass: 100, wood: 800, concrete: 2500, metal: 5000, ice: 200,
  };
  return {
    id,
    aabb: { min: prop.aabb.min.clone(), max: prop.aabb.max.clone() },
    capacity: capacityByMaterial[material],
    loadBearing: false,
    destroyed: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #760 — Persistent debris (destruction-physics.ts owns the registry).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper: activate shards AND register each as persistent debris in one call.
 * Combines activateShards() + registerDebris() (from destruction-physics.ts)
 * so the engine has a single integration point.
 *
 * Lazy-requires destruction-physics.ts to avoid a static circular import.
 */
export function activateShardsPersistent(
  prop: PreFracturedProp,
  impactPoint: THREE.Vector3,
  force: number,
): Array<{ mesh: THREE.Mesh; velocity: THREE.Vector3; center: THREE.Vector3 }> {
  const shards = activateShards(prop, impactPoint, force);
  if (shards.length === 0) return shards;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerDebris } = require("../combat/destruction-physics") as typeof import("../combat/destruction-physics");
    const now = performance.now();
    for (const s of shards) registerDebris(s.mesh, now);
  } catch {
    // destruction-physics not available — shards still activate but won't be
    // tracked by the LRU/TTL despawner. Engine will handle despawn.
  }
  return shards;
}

// ─────────────────────────────────────────────────────────────────────────────
// #761 — Dust clouds on destruction.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn a dust cloud at a fracture site. Lazy-requires PhysicsEnhancements
 * so the fracture layer can spawn dust without a static import.
 */
export function spawnFractureDust(
  center: THREE.Vector3,
  force: number,
): Array<{ pos: THREE.Vector3; vel: THREE.Vector3; radius: number; density: number; despawnMs: number }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnDustCloud } = require("../systems/PhysicsEnhancements") as typeof import("../systems/PhysicsEnhancements");
    return spawnDustCloud(center, force, performance.now());
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #765 — Persistent structural damage (saved to DB).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize the destruction state of a list of PreFracturedProp entries (each
 * tagged with an id + material). Returns a JSON-safe record for the savegame.
 */
export function serializeFractureState(
  props: Array<{ id: string; prop: PreFracturedProp; material: FractureMaterial; destroyed: boolean; hp: number; maxHp: number; stage: number }>,
): PersistentPropDamage[] {
  return serializeDestructionState(
    props.map((p) => ({
      id: p.id,
      hp: p.hp,
      maxHp: p.maxHp,
      stage: p.destroyed ? 3 : 0, // 3 = destroyed
      destroyed: p.destroyed,
    })),
  );
}

/**
 * Restore destruction state from a savegame. Mutates the props array to mark
 * destroyed entries (the engine will skip rendering / re-fracturing them).
 */
export function restoreFractureState(
  saved: PersistentPropDamage[],
  props: Array<{ id: string; prop: PreFracturedProp; material: FractureMaterial; destroyed: boolean; hp: number; maxHp: number; stage: number }>,
): void {
  deserializeDestructionState(saved, props);
}
