/**
 * Section M — Destructible environment system.
 *
 * Per-biome destruction graph: each prop registered as destructible
 * declares its `DestructionProfile` (material class, fragmentation
 * pattern, chain-reaction neighbors, blast radius, structural role).
 * When the prop's HP hits 0:
 *   1. It fractures into N chunks (geometric break apart).
 *   2. The chunks become physics debris with limited lifetime.
 *   3. The destructible's collider is removed from the world.
 *   4. Any destructible inside `chainRadius` takes chain damage
 *      (proportional to overlap with the blast sphere).
 *   5. Story-relevant destructibles (load-bearing walls, support beams)
 *      trigger a "structural collapse" that removes the parent building's
 *      upper floors (see verticality.ts → collapseFloor).
 *
 * The destruction graph is intentionally a flat array per-map; the
 * `chainRadius` neighborhood is computed lazily on first fracture so we
 * don't pay O(N²) for maps where nothing breaks.
 *
 * Public API:
 *   - registerDestructibleNode() — wrap a mesh + DestructibleProp with
 *     a DestructionProfile.
 *   - applyDamage() — apply damage to a node, return the destruction
 *     events (fractures + chain reactions) the engine should play this
 *     frame.
 *   - getDestructionGraph() — read-only view of the per-map graph.
 *
 * Pure-logic core (no THREE import at module scope) so this is safe to
 * import from SSR / unit tests. The mesh manipulation (fracture spawn,
 * collider removal) is delegated to the engine via callbacks the engine
 * wires on map load.
 */

import type * as THREE from "three";
import type { DestructibleProp } from "../systems/types";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type DestructionClass =
  | "glass"        // shatters into many small fragments
  | "wood"         // splinters into long shards
  | "concrete"     // crumbles into rubble + dust
  | "brick"        // breaks into brick-shaped chunks
  | "metal"        // dents, then tears into panels
  | "sandbag"      // bursts, scatters bags
  | "explosive"    // barrels — explodes, chain-damages neighbors
  | "structural";  // load-bearing — collapses connected structure

export interface DestructionProfile {
  /** Material class — drives the fracture pattern + sound. */
  destructionClass: DestructionClass;
  /** Blast radius (m) for chain-damage propagation. 0 = no chain. */
  chainRadius: number;
  /** Chain damage falloff: 1 at center, 0 at chainRadius. */
  chainDamage: number;
  /** Number of debris chunks to spawn on fracture. */
  fragmentCount: number;
  /** Lifetime of debris (seconds) before despawn. */
  debrisLifetime: number;
  /** Mass per fragment (kg) — affects physics impulse. */
  fragmentMass: number;
  /** True if this prop is load-bearing (destroying it collapses the
   *  attached floor / roof in verticality.ts). */
  structural: boolean;
  /** Floor id this prop belongs to (for verticality collapse). */
  floorId?: string;
  /** Optional id of the parent structure (so we can lookup the upper
   *  floors when a structural support dies). */
  structureId?: string;
}

export interface DestructionNode {
  id: string;
  mesh: THREE.Mesh;
  prop: DestructibleProp;
  profile: DestructionProfile;
  /** Cumulative damage sustained. */
  damage: number;
  /** Whether this node has been fractured (one-shot). */
  fractured: boolean;
  /** Position cache for chain-neighbor queries (lazy). */
  position: [number, number, number];
}

export interface DestructionEvent {
  nodeId: string;
  position: [number, number, number];
  destructionClass: DestructionClass;
  fragmentCount: number;
  /** Chain-damaged neighbors (nodeId → damage). */
  chainHits: Array<{ nodeId: string; damage: number }>;
  /** True if this fracture should trigger a structural collapse. */
  structuralCollapse: boolean;
  structureId?: string;
  floorId?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Preset profiles (per-prop defaults)
// ──────────────────────────────────────────────────────────────────────────

export const DESTRUCTION_PROFILES: Record<string, DestructionProfile> = {
  // Glass partitions (bunker / mansion).
  glass_partition: {
    destructionClass: "glass", chainRadius: 1.5, chainDamage: 5,
    fragmentCount: 24, debrisLifetime: 6, fragmentMass: 0.3,
    structural: false,
  },
  // Oil barrels — explosive.
  barrel: {
    destructionClass: "explosive", chainRadius: 6, chainDamage: 80,
    fragmentCount: 18, debrisLifetime: 4, fragmentMass: 0.5,
    structural: false,
  },
  // Wooden crates.
  crate: {
    destructionClass: "wood", chainRadius: 0.5, chainDamage: 10,
    fragmentCount: 8, debrisLifetime: 8, fragmentMass: 0.6,
    structural: false,
  },
  // Concrete barriers — heavy, no chain.
  concrete_barrier: {
    destructionClass: "concrete", chainRadius: 0, chainDamage: 0,
    fragmentCount: 12, debrisLifetime: 12, fragmentMass: 2.0,
    structural: false,
  },
  // Brick walls.
  brick_wall: {
    destructionClass: "brick", chainRadius: 1.0, chainDamage: 20,
    fragmentCount: 16, debrisLifetime: 10, fragmentMass: 1.5,
    structural: false,
  },
  // Sandbag bunkers/walls — burst, scatter.
  sandbag: {
    destructionClass: "sandbag", chainRadius: 1.0, chainDamage: 8,
    fragmentCount: 14, debrisLifetime: 6, fragmentMass: 0.4,
    structural: false,
  },
  // Shipping containers — dent + tear.
  container: {
    destructionClass: "metal", chainRadius: 0, chainDamage: 0,
    fragmentCount: 6, debrisLifetime: 12, fragmentMass: 8.0,
    structural: false,
  },
  // Load-bearing pillar (verticality collapse).
  structural_pillar: {
    destructionClass: "structural", chainRadius: 2.0, chainDamage: 40,
    fragmentCount: 10, debrisLifetime: 12, fragmentMass: 3.0,
    structural: true,
  },
  // Load-bearing wall (verticality collapse).
  structural_wall: {
    destructionClass: "structural", chainRadius: 2.0, chainDamage: 35,
    fragmentCount: 14, debrisLifetime: 12, fragmentMass: 2.5,
    structural: true,
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Destruction graph (per-map)
// ──────────────────────────────────────────────────────────────────────────

export class DestructionGraph {
  private nodes = new Map<string, DestructionNode>();
  /** Lazy neighbor index — built on first fracture for O(N log N) chain
   *  queries instead of O(N²) every hit. */
  private neighborIndex: Map<string, Array<{ id: string; dist: number }>> | null = null;
  private nextId = 1;

  /** Register a destructible mesh + DestructibleProp with a profile. */
  register(
    mesh: THREE.Mesh,
    prop: DestructibleProp,
    profile: DestructionProfile,
  ): DestructionNode {
    const id = `d-${this.nextId++}`;
    const pos = mesh.position;
    const node: DestructionNode = {
      id, mesh, prop, profile, damage: 0, fractured: false,
      position: [pos.x, pos.y, pos.z],
    };
    this.nodes.set(id, node);
    // Invalidate neighbor index — new node must be indexed before next query.
    this.neighborIndex = null;
    return node;
  }

  /** Apply damage to a node. Returns the destruction events fired this
   *  call (one for the directly-damaged node, plus one per fractured
   *  neighbor in the chain reaction). */
  applyDamage(nodeId: string, damage: number): DestructionEvent[] {
    const events: DestructionEvent[] = [];
    const node = this.nodes.get(nodeId);
    if (!node || node.fractured) return events;
    node.damage += damage;
    if (node.damage < node.prop.maxHealth) return events;
    // Fracture!
    events.push(this.fracture(node));
    // Chain reaction — propagate damage to neighbors within chainRadius.
    if (node.profile.chainRadius > 0) {
      this.ensureNeighborIndex();
      const neighbors = this.neighborIndex!.get(nodeId) ?? [];
      for (const n of neighbors) {
        if (n.dist > node.profile.chainRadius) continue;
        const falloff = 1 - n.dist / node.profile.chainRadius;
        const chainDamage = node.profile.chainDamage * falloff;
        const sub = this.applyDamage(n.id, chainDamage);
        events.push(...sub);
      }
    }
    return events;
  }

  /** Fracture a single node. Returns the destruction event. */
  private fracture(node: DestructionNode): DestructionEvent {
    node.fractured = true;
    node.prop.stage = 2; // breached
    return {
      nodeId: node.id,
      position: node.position,
      destructionClass: node.profile.destructionClass,
      fragmentCount: node.profile.fragmentCount,
      chainHits: [],
      structuralCollapse: node.profile.structural,
      structureId: node.profile.structureId,
      floorId: node.profile.floorId,
    };
  }

  /** Build the neighbor index (one-time O(N²) cost). Called lazily on
   *  first fracture. For maps with thousands of destructibles this is
   *  still cheap (sub-millisecond for <500 nodes). */
  private ensureNeighborIndex(): void {
    if (this.neighborIndex) return;
    const idx = new Map<string, Array<{ id: string; dist: number }>>();
    const all = Array.from(this.nodes.values());
    for (const a of all) {
      const list: Array<{ id: string; dist: number }> = [];
      for (const b of all) {
        if (a.id === b.id) continue;
        const dx = a.position[0] - b.position[0];
        const dy = a.position[1] - b.position[1];
        const dz = a.position[2] - b.position[2];
        list.push({ id: b.id, dist: Math.hypot(dx, dy, dz) });
      }
      list.sort((x, y) => x.dist - y.dist);
      idx.set(a.id, list);
    }
    this.neighborIndex = idx;
  }

  /** Get a read-only view of all registered nodes. */
  getAll(): ReadonlyArray<DestructionNode> {
    return Array.from(this.nodes.values());
  }

  /** Get a single node by id. */
  get(id: string): DestructionNode | undefined {
    return this.nodes.get(id);
  }

  /** Reset the graph (called by clearMap on map switch). */
  clear(): void {
    this.nodes.clear();
    this.neighborIndex = null;
    this.nextId = 1;
  }

  /** Number of registered nodes (for the design dashboard). */
  get size(): number { return this.nodes.size; }

  /** Number of fractured nodes (for the design dashboard). */
  get fracturedCount(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.fractured) n++;
    return n;
  }
}

// Module-scope singleton — one graph per active map. The engine
// destructs + rebuilds this on map switch.
export const DESTRUCTION_GRAPH = new DestructionGraph();

// ──────────────────────────────────────────────────────────────────────────
// Storytelling hook — environmental storytelling layer.
// ──────────────────────────────────────────────────────────────────────────

export interface BattleDamageDecal {
  position: [number, number, number];
  type: "bullet_hole" | "scorch" | "blood_splatter" | "blood_trail" | "shrapnel_gouge";
  /** Surface normal the decal faces (used to orient the plane). */
  normal: [number, number, number];
  /** Age in seconds (0 = fresh). Drives fade-out for blood + scorch. */
  age: number;
  /** Length of the trail (only for blood_trail). */
  length?: number;
}

/** Environmental-storytelling decals applied to surfaces during + after
 *  a firefight. The engine populates this list as bullets hit walls
 *  (bullet_hole), as explosives go off (scorch, shrapnel_gouge), as
 *  enemies die (blood_splatter → blood_trail if they crawl). Decals
 *  fade out over their class lifetime. */
export const BATTLE_DECALS: BattleDamageDecal[] = [];

/** Spawn a fresh battle-damage decal. Pure data — the engine's renderer
 *  reads this list to spawn the actual plane meshes (cached per type). */
export function spawnBattleDamage(
  type: BattleDamageDecal["type"],
  position: [number, number, number],
  normal: [number, number, number],
  length?: number,
): BattleDamageDecal {
  const decal: BattleDamageDecal = { position, type, normal, age: 0, length };
  BATTLE_DECALS.push(decal);
  // Cap the decal list to prevent runaway memory on long matches.
  if (BATTLE_DECALS.length > 400) BATTLE_DECALS.splice(0, BATTLE_DECALS.length - 400);
  return decal;
}

/** Tick all decals — fade + remove. Pure logic. */
export function tickBattleDecals(dt: number): void {
  const lifetimes: Record<BattleDamageDecal["type"], number> = {
    bullet_hole: 600,        // persistent (round-long)
    scorch: 240,             // 4 minutes
    blood_splatter: 180,     // 3 minutes
    blood_trail: 120,        // 2 minutes
    shrapnel_gouge: 600,     // persistent
  };
  for (let i = BATTLE_DECALS.length - 1; i >= 0; i--) {
    const d = BATTLE_DECALS[i];
    d.age += dt;
    if (d.age > lifetimes[d.type]) BATTLE_DECALS.splice(i, 1);
  }
}

/** Reset decals on map switch. */
export function clearBattleDecals(): void {
  BATTLE_DECALS.length = 0;
}
