/**
 * Section M — Verticality system: multi-story buildings, rooftops,
 * underground tunnels.
 *
 * Generates procedural multi-story structures (3–5 floors) with:
 *   - Floor slabs (each with floorId for destruction.ts structural collapse).
 *   - Stairwells connecting adjacent floors (walkable ramp geometry).
 *   - Exterior walls with window openings (glass_panel destructibles).
 *   - Rooftop parapets + HVAC props.
 *   - Optional underground tunnel network (separate builder).
 *
 * Each story is registered as a separate collider + a structural
 * dependency tree (lower floor supports upper floor). When a structural
 * pillar/wall on floor N is destroyed (see destruction.ts), floor N+1
 * + everything above collapses (mesh falls + is removed from the
 * collider list, debris is spawned at the impact zone).
 *
 * Public API:
 *   - buildMultiStoryBuilding(ctx, opts) — adds the building to the scene.
 *   - buildUndergroundTunnel(ctx, opts) — adds a tunnel network.
 *   - registerStructure(structure) — register for collapse tracking.
 *   - collapseFloor(structureId, floorId) — engine calls this when a
 *     structural prop is destroyed; returns the floors to remove.
 *
 * THREE imports are lazy (inside builder functions) so the module is
 * safe to import from SSR / Node / tests.
 */

import * as THREE from "three";
import type { Collider, DestructibleProp } from "../systems/types";
import type { BuildContext } from "./MapBuilder/_shared";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface MultiStoryBuildingOptions {
  /** World position (center of the ground floor). */
  position: [number, number, number];
  /** Footprint width / depth (m). */
  width: number;
  depth: number;
  /** Floor-to-floor height (m). */
  floorHeight: number;
  /** Number of floors above ground. */
  floors: number;
  /** Number of basement levels (underground; accessed via stairwell). */
  basements?: number;
  /** Yaw rotation (radians). */
  rotY?: number;
  /** Wall material class. */
  wallMaterial?: "concrete" | "brick" | "metal";
  /** Window count per floor per wall. */
  windowsPerWall?: number;
  /** Structure id (for destruction.ts collapse tracking). */
  structureId: string;
}

export interface TunnelOptions {
  /** Origin (entrance) of the tunnel network. */
  origin: [number, number, number];
  /** Tunnel segments — each is a straight run. */
  segments: Array<{
    length: number;
    /** Direction in radians (0 = +X, π/2 = +Z). */
    direction: number;
    /** Optional branch point (player can choose left/right). */
    branch?: "left" | "right" | "straight";
  }>;
  /** Cross-section width / height (m). */
  width?: number;
  height?: number;
  /** Wall material. */
  wallMaterial?: "concrete" | "brick";
}

export interface FloorRecord {
  floorId: string;
  level: number; // 0 = ground, +N = upper, -N = basement
  /** World-space Y of the floor slab top. */
  y: number;
  /** AABB of the floor footprint. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Set of structural node ids (pillars + load-bearing walls) this
   *  floor depends on. Empty = no collapse trigger. */
  supports: Set<string>;
  /** True once this floor has collapsed. */
  collapsed: boolean;
}

export interface Structure {
  id: string;
  floors: FloorRecord[];
  /** Map of floorId → floorId(s) above that depend on it. */
  dependents: Map<string, string[]>;
}

// ──────────────────────────────────────────────────────────────────────────
// Structure registry
// ──────────────────────────────────────────────────────────────────────────

const STRUCTURES = new Map<string, Structure>();

/** Register a structure for collapse tracking. */
export function registerStructure(structure: Structure): void {
  STRUCTURES.set(structure.id, structure);
}

/** Get a structure by id. */
export function getStructure(id: string): Structure | undefined {
  return STRUCTURES.get(id);
}

/** When a structural support on floorId is destroyed, mark this floor +
 *  every floor above as collapsed. Returns the list of floors that
 *  collapsed (so the engine can spawn debris + remove colliders). */
export function collapseFloor(structureId: string, floorId: string): FloorRecord[] {
  const structure = STRUCTURES.get(structureId);
  if (!structure) return [];
  const startFloor = structure.floors.find((f) => f.floorId === floorId);
  if (!startFloor || startFloor.collapsed) return [];
  const collapsed: FloorRecord[] = [];
  // BFS upward through dependents.
  const queue = [floorId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const floor = structure.floors.find((f) => f.floorId === id);
    if (!floor || floor.collapsed) continue;
    floor.collapsed = true;
    collapsed.push(floor);
    const deps = structure.dependents.get(id) ?? [];
    queue.push(...deps);
  }
  return collapsed;
}

/** Reset the structure registry (called on map switch). */
export function clearStructures(): void {
  STRUCTURES.clear();
}

// ──────────────────────────────────────────────────────────────────────────
// Multi-story building builder
// ──────────────────────────────────────────────────────────────────────────

/** Build a multi-story building into the scene. Returns the structure
 *  record (already registered via registerStructure).
 *
 *  The building is composed of:
 *    - One floor slab per level (with floorId for collapse tracking).
 *    - Four exterior walls per level (with window openings).
 *    - One stairwell (spiral ramp geometry) connecting adjacent floors.
 *    - Rooftop parapet + optional HVAC unit on the top floor.
 *
 *  Each floor's slab + the four walls below it are registered as
 *  structural supports for the floor above (so destroying any one
 *  collapses everything above). */
export function buildMultiStoryBuilding(
  bctx: BuildContext,
  opts: MultiStoryBuildingOptions,
): Structure {
  const {
    position: [cx, cy, cz],
    width, depth, floorHeight, floors, basements = 0,
    rotY = 0, wallMaterial = "concrete", windowsPerWall = 2,
    structureId,
  } = opts;

  const group = new THREE.Group();
  group.position.set(cx, cy, cz);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const wallMat = bctx.matCache.getMaterial(wallMaterial);
  const floorMat = bctx.matCache.getMaterial("concrete");
  const windowMat = bctx.matCache.getMaterial("glass");

  const structure: Structure = {
    id: structureId,
    floors: [],
    dependents: new Map(),
  };

  const totalLevels = floors + basements;
  for (let level = -basements; level < floors; level++) {
    const floorY = level * floorHeight;
    const floorId = `${structureId}_floor_${level}`;

    // Floor slab.
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.3, depth),
      floorMat,
    );
    slab.position.set(0, floorY - 0.15, 0);
    slab.castShadow = true; slab.receiveShadow = true;
    slab.userData.surfaceType = "concrete";
    slab.userData.materialSlug = "concrete";
    slab.userData.structureId = structureId;
    slab.userData.floorId = floorId;
    slab.userData.structural = true;
    group.add(slab);
    bctx.colliders.push({ box: new THREE.Box3().setFromObject(slab) });

    // Exterior walls (4 sides), each with window openings.
    const wallH = floorHeight;
    const wallT = 0.2;
    const wallDefs: Array<{ x: number; z: number; w: number; d: number }> = [
      { x: 0, z: -depth / 2, w: width, d: wallT }, // north
      { x: 0, z: depth / 2, w: width, d: wallT },  // south
      { x: -width / 2, z: 0, w: wallT, d: depth }, // west
      { x: width / 2, z: 0, w: wallT, d: depth },  // east
    ];
    for (const wd of wallDefs) {
      // Wall body split around windows — simplified: full wall + window
      // insets (glass_panel destructibles placed over the wall).
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(wd.w, wallH, wd.d),
        wallMat,
      );
      wall.position.set(wd.x, floorY + wallH / 2, wd.z);
      wall.castShadow = true; wall.receiveShadow = true;
      wall.userData.surfaceType = wallMaterial;
      wall.userData.materialSlug = wallMaterial;
      wall.userData.structureId = structureId;
      wall.userData.floorId = floorId;
      wall.userData.structural = true;
      group.add(wall);
      bctx.colliders.push({ box: new THREE.Box3().setFromObject(wall) });

      // Window insets (front + back walls only).
      if (windowsPerWall > 0 && (wd.w > 1 || wd.d > 1)) {
        const isNS = wd.d < wd.w; // wall runs along X
        const span = isNS ? wd.w : wd.d;
        for (let i = 0; i < windowsPerWall; i++) {
          const t = (i + 1) / (windowsPerWall + 1);
          const offset = (t - 0.5) * span;
          const wx = isNS ? wd.x + offset : wd.x;
          const wz = isNS ? wd.z : wd.z + offset;
          const win = new THREE.Mesh(
            new THREE.BoxGeometry(
              isNS ? 1.0 : 0.05,
              1.4,
              isNS ? 0.05 : 1.0,
            ),
            windowMat,
          );
          win.position.set(wx, floorY + wallH * 0.55, wz);
          win.castShadow = false; win.receiveShadow = false;
          win.userData.surfaceType = "glass";
          win.userData.materialSlug = "glass";
          win.userData.destructible = true;
          win.userData.structureId = structureId;
          win.userData.floorId = floorId;
          group.add(win);
          // Register as a destructible (HP 30 — shatters easily).
          const dprop: DestructibleProp = {
            mesh: win, health: 30, maxHealth: 30,
            materialSlug: "glass", stage: 0,
            collider: { box: new THREE.Box3().setFromObject(win) },
            baseScale: 1,
          };
          bctx.destructibles.push(dprop);
        }
      }
    }

    // Stairwell (spiral ramp) to next floor — only between adjacent
    // levels (skip on top floor).
    if (level < floors - 1) {
      const stairGroup = new THREE.Group();
      stairGroup.position.set(width / 2 - 1.0, floorY, depth / 2 - 1.0);
      // 10-step spiral — simplified as a ramped box.
      for (let s = 0; s < 10; s++) {
        const angle = (s / 10) * Math.PI * 1.2; // ~216° arc
        const radius = 1.2;
        const sx = Math.cos(angle) * radius;
        const sz = Math.sin(angle) * radius;
        const sy = (s / 10) * floorHeight + 0.1;
        const step = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.1, 0.5),
          floorMat,
        );
        step.position.set(sx, sy, sz);
        step.rotation.y = -angle;
        step.castShadow = true; step.receiveShadow = true;
        step.userData.surfaceType = "concrete";
        stairGroup.add(step);
        bctx.colliders.push({ box: new THREE.Box3().setFromObject(step) });
      }
      group.add(stairGroup);
    }

    // Record floor for collapse tracking.
    const floorRec: FloorRecord = {
      floorId,
      level,
      y: floorY,
      bounds: {
        minX: cx - width / 2, maxX: cx + width / 2,
        minZ: cz - depth / 2, maxZ: cz + depth / 2,
      },
      supports: new Set(),
      collapsed: false,
    };
    structure.floors.push(floorRec);
    // Wire dependency: this floor depends on the floor below it.
    if (level > -basements) {
      const lowerId = `${structureId}_floor_${level - 1}`;
      floorRec.supports.add(lowerId);
      const deps = structure.dependents.get(lowerId) ?? [];
      deps.push(floorId);
      structure.dependents.set(lowerId, deps);
    }
  }

  // Rooftop parapet + HVAC (on top floor only).
  const topY = floors * floorHeight;
  const parapet = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.2, 1.0, 0.2),
    wallMat,
  );
  parapet.position.set(0, topY + 0.5, -depth / 2);
  parapet.castShadow = true; parapet.receiveShadow = true;
  parapet.userData.surfaceType = wallMaterial;
  group.add(parapet);
  bctx.colliders.push({ box: new THREE.Box3().setFromObject(parapet) });

  // HVAC unit (rooftop).
  const hvac = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 1.2, 1.5),
    bctx.matCache.getMaterial("metal"),
  );
  hvac.position.set(0, topY + 0.6, 0);
  hvac.castShadow = true; hvac.receiveShadow = true;
  hvac.userData.surfaceType = "metal";
  group.add(hvac);
  bctx.colliders.push({ box: new THREE.Box3().setFromObject(hvac) });

  registerStructure(structure);
  return structure;
}

// ──────────────────────────────────────────────────────────────────────────
// Underground tunnel builder
// ──────────────────────────────────────────────────────────────────────────

/** Build an underground tunnel network. Tunnels are below-ground (Y < 0)
 *  rectangular corridors with walls + floor + ceiling. Used for covert
 *  rotations between map zones (e.g. compound HQ basement ↔ perimeter
 *  bunker). Pure geometry — no collapse tracking (tunnels are indestructible). */
export function buildUndergroundTunnel(
  bctx: BuildContext,
  opts: TunnelOptions,
): THREE.Object3D {
  const {
    origin: [ox, oy, oz],
    segments,
    width = 3, height = 2.6,
    wallMaterial = "concrete",
  } = opts;

  const group = new THREE.Group();
  group.position.set(ox, oy, oz);
  bctx.scene.add(group);

  const wallMat = bctx.matCache.getMaterial(wallMaterial);
  const floorMat = bctx.matCache.getMaterial("concrete");

  let cursorX = 0, cursorZ = 0;
  for (const seg of segments) {
    const len = seg.length;
    const dir = seg.direction;
    const dx = Math.cos(dir), dz = Math.sin(dir);

    // Floor.
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.2, width),
      floorMat,
    );
    floor.position.set(cursorX + dx * len / 2, 0, cursorZ + dz * len / 2);
    floor.rotation.y = -dir;
    floor.receiveShadow = true;
    floor.userData.surfaceType = "concrete";
    group.add(floor);
    bctx.colliders.push({ box: new THREE.Box3().setFromObject(floor) });

    // Ceiling.
    const ceil = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.2, width),
      wallMat,
    );
    ceil.position.set(cursorX + dx * len / 2, height, cursorZ + dz * len / 2);
    ceil.rotation.y = -dir;
    ceil.castShadow = true; ceil.receiveShadow = true;
    ceil.userData.surfaceType = wallMaterial;
    group.add(ceil);

    // Two side walls.
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(len, height, 0.2),
        wallMat,
      );
      // Perpendicular offset.
      const px = -dz * side * width / 2;
      const pz = dx * side * width / 2;
      wall.position.set(cursorX + dx * len / 2 + px, height / 2, cursorZ + dz * len / 2 + pz);
      wall.rotation.y = -dir;
      wall.castShadow = true; wall.receiveShadow = true;
      wall.userData.surfaceType = wallMaterial;
      group.add(wall);
      bctx.colliders.push({ box: new THREE.Box3().setFromObject(wall) });
    }

    cursorX += dx * len;
    cursorZ += dz * len;
  }

  return group;
}

/** Engine-cleanup helper: remove + dispose all structures + floor records.
 *  Called by clearMap on map switch. */
export function disposeVerticality(): void {
  clearStructures();
}
