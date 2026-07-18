/**
 * Section M — Interactive environment: doors, switches, elevators,
 * destructible walls.
 *
 * Adds interactive props to maps. Each interactive prop is registered
 * with a state machine (closed/open for doors, off/on for switches,
 * floor-N for elevators). The engine's InputSystem checks for
 * "use key pressed + looking at interactive prop within range" each
 * frame and calls `triggerInteractive(id)`.
 *
 * Public API:
 *   - InteractiveProp union + InteractiveRegistry.
 *   - registerInteractive / getInteractive / getInteractivesForMap.
 *   - triggerInteractive(id, ctx) — apply the use action; returns the
 *     new state + any side-effect (door opens, elevator moves, wall
 *     explodes).
 *   - findInteractiveInView(playerPos, playerYaw, range) — for the HUD
 *     prompt ("[E] Open Door").
 *
 * All builders are lazy (THREE imported inside builder functions) so
 * the module is SSR-safe to import.
 */

import * as THREE from "three";
import type { BuildContext, MaterialCache } from "./MapBuilder/_shared";
import type { Collider } from "../systems/types";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type InteractiveKind = "door" | "switch" | "elevator" | "destructible_wall";

export interface InteractiveBase {
  id: string;
  mapSlug: string;
  kind: InteractiveKind;
  position: [number, number, number];
  /** Initial state — what "use" does depends on the kind. */
  state: string;
  /** Use-action label shown in the HUD prompt ("Open Door", "Flip Switch"). */
  useLabel: string;
  /** Whether the prop is currently locked (needs a key / switch first). */
  locked: boolean;
  /** Id of the switch that unlocks this prop (if locked). */
  unlockedBy?: string;
  /** Mesh handle (set by the builder; engine reads userData). */
  mesh?: THREE.Object3D;
}

export interface DoorInteractive extends InteractiveBase {
  kind: "door";
  state: "closed" | "open";
  /** Hinge side ("left" / "right"). */
  hinge: "left" | "right";
  /** Open angle (radians) — default π/2 (90°). */
  openAngle: number;
  /** Auto-close delay (seconds); 0 = no auto-close. */
  autoClose: number;
}

export interface SwitchInteractive extends InteractiveBase {
  kind: "switch";
  state: "off" | "on";
  /** Targets (door ids / elevator ids) this switch toggles. */
  targets: string[];
}

export interface ElevatorInteractive extends InteractiveBase {
  kind: "elevator";
  state: string; // current floor id
  /** Floors this elevator stops at (id → Y). */
  floors: Array<{ id: string; y: number; label: string }>;
  /** Travel speed (m/s). */
  speed: number;
  /** Current Y (interpolated). */
  currentY: number;
}

export interface DestructibleWallInteractive extends InteractiveBase {
  kind: "destructible_wall";
  state: "intact" | "breached";
  /** HP — engine reduces this on grenade/explosive hits. */
  hp: number;
  /** Max HP. */
  maxHp: number;
  /** Material class (drives fracture pattern in destruction.ts). */
  material: "concrete" | "brick" | "wood" | "metal";
}

export type InteractiveProp =
  | DoorInteractive
  | SwitchInteractive
  | ElevatorInteractive
  | DestructibleWallInteractive;

// ──────────────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────────────

const INTERACTIVES: InteractiveProp[] = [];

export function registerInteractive(prop: InteractiveProp): InteractiveProp {
  INTERACTIVES.push(prop);
  return prop;
}

export function getInteractive(id: string): InteractiveProp | undefined {
  return INTERACTIVES.find((p) => p.id === id);
}

export function getInteractivesForMap(mapSlug: string): InteractiveProp[] {
  return INTERACTIVES.filter((p) => p.mapSlug === mapSlug);
}

export function clearInteractives(): void {
  INTERACTIVES.length = 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Trigger (use-action) logic
// ──────────────────────────────────────────────────────────────────────────

export interface TriggerResult {
  id: string;
  newState: string;
  /** Side-effect payloads the engine applies. */
  effects: TriggerEffect[];
}

export type TriggerEffect =
  | { type: "play_sound"; sound: string; position: [number, number, number] }
  | { type: "toggle_mesh_visible"; visible: boolean }
  | { type: "rotate_mesh"; rotationY: number }
  | { type: "move_mesh_y"; y: number }
  | { type: "remove_collider"; colliderIndex: number }
  | { type: "explode_wall"; position: [number, number, number]; radius: number }
  | { type: "show_hud_message"; text: string };

/** Apply a use-action to an interactive prop. Returns the new state +
 *  side-effect list the engine should execute this frame.
 *
 *  Pure function (mutates the prop's `state` field but performs no I/O). */
export function triggerInteractive(
  id: string,
  ctx?: { playerHasKey?: (keyId: string) => boolean },
): TriggerResult | null {
  const prop = INTERACTIVES.find((p) => p.id === id);
  if (!prop) return null;
  // Locked check.
  if (prop.locked && prop.unlockedBy) {
    const sw = INTERACTIVES.find((p) => p.id === prop.unlockedBy);
    if (!sw || sw.kind !== "switch" || sw.state !== "on") {
      return {
        id,
        newState: prop.state,
        effects: [{ type: "show_hud_message", text: "Locked. Find the switch." }],
      };
    }
    prop.locked = false;
  }

  switch (prop.kind) {
    case "door": {
      const door = prop as DoorInteractive;
      door.state = door.state === "closed" ? "open" : "closed";
      const targetRotY = door.state === "open"
        ? (door.hinge === "left" ? 1 : -1) * door.openAngle
        : 0;
      return {
        id,
        newState: door.state,
        effects: [
          { type: "play_sound", sound: `door_${door.state}`, position: door.position },
          { type: "rotate_mesh", rotationY: targetRotY },
        ],
      };
    }
    case "switch": {
      const sw = prop as SwitchInteractive;
      sw.state = sw.state === "off" ? "on" : "off";
      const effects: TriggerEffect[] = [
        { type: "play_sound", sound: `switch_${sw.state}`, position: sw.position },
      ];
      // Cascade to targets (unlock doors, call elevators).
      for (const targetId of sw.targets) {
        const t = INTERACTIVES.find((p) => p.id === targetId);
        if (!t) continue;
        if (t.kind === "door" && t.locked) {
          t.locked = false;
          effects.push({ type: "show_hud_message", text: "You hear a door unlock somewhere." });
        }
        if (t.kind === "elevator") {
          // Calling an elevator = send it to this switch's floor.
          const elev = t as ElevatorInteractive;
          effects.push({ type: "show_hud_message", text: `Elevator called: ${elev.state}` });
        }
      }
      return { id, newState: sw.state, effects };
    }
    case "elevator": {
      const elev = prop as ElevatorInteractive;
      // Cycle to next floor.
      const idx = elev.floors.findIndex((f) => f.id === elev.state);
      const next = elev.floors[(idx + 1) % elev.floors.length];
      elev.state = next.id;
      return {
        id,
        newState: elev.state,
        effects: [
          { type: "play_sound", sound: "elevator_chime", position: elev.position },
          { type: "move_mesh_y", y: next.y },
        ],
      };
    }
    case "destructible_wall": {
      const wall = prop as DestructibleWallInteractive;
      // Use action doesn't breach walls (only explosives do); show status.
      return {
        id,
        newState: wall.state,
        effects: [{ type: "show_hud_message", text: `Reinforced wall: ${wall.hp}/${wall.maxHp} HP` }],
      };
    }
  }
  return null;
}

/** Apply explosive damage to a destructible_wall interactive. Returns
 *  the trigger result if the wall breaches this hit. Pure function. */
export function damageDestructibleWall(
  id: string,
  damage: number,
): TriggerResult | null {
  const prop = INTERACTIVES.find((p) => p.id === id);
  if (!prop || prop.kind !== "destructible_wall") return null;
  const wall = prop as DestructibleWallInteractive;
  wall.hp = Math.max(0, wall.hp - damage);
  if (wall.hp > 0) return null;
  wall.state = "breached";
  return {
    id,
    newState: "breached",
    effects: [
      { type: "explode_wall", position: wall.position, radius: 3.0 },
      { type: "play_sound", sound: "wall_collapse", position: wall.position },
      { type: "toggle_mesh_visible", visible: false },
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// "Find interactive in view" — HUD prompt helper
// ──────────────────────────────────────────────────────────────────────────

export interface InteractiveInViewResult {
  id: string;
  useLabel: string;
  distance: number;
}

/** Find the nearest interactive prop within the player's use-cone.
 *  Pure function — engine calls this each frame for the HUD prompt.
 *
 *  - playerPos: world-space camera position.
 *  - playerYaw: radians (0 = looking +X).
 *  - range: max use distance (default 3.0m).
 *  - halfAngle: half the use cone (default 30°). */
export function findInteractiveInView(
  mapSlug: string,
  playerPos: [number, number, number],
  playerYaw: number,
  range = 3.0,
  halfAngle = Math.PI / 6,
): InteractiveInViewResult | null {
  const props = getInteractivesForMap(mapSlug);
  const [px, py, pz] = playerPos;
  const dirX = Math.cos(playerYaw);
  const dirZ = Math.sin(playerYaw);
  let best: InteractiveInViewResult | null = null;
  let bestDist = range;
  for (const p of props) {
    const dx = p.position[0] - px;
    const dy = p.position[1] - py;
    const dz = p.position[2] - pz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > range || dist > bestDist) continue;
    // Dot with player forward = cos(angle to prop).
    const dot = (dx * dirX + dz * dirZ) / (Math.hypot(dx, dz) || 1);
    if (dot < Math.cos(halfAngle)) continue;
    bestDist = dist;
    best = { id: p.id, useLabel: p.useLabel, distance: dist };
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────
// Builders (lazy THREE imports — SSR-safe module load)
// ──────────────────────────────────────────────────────────────────────────

/** Build a door mesh (the visual representation of a DoorInteractive). */
export function buildDoor(
  bctx: BuildContext,
  door: DoorInteractive,
): THREE.Object3D {
  const group = new THREE.Group();
  const [x, y, z] = door.position;
  group.position.set(x, y, z);
  bctx.scene.add(group);

  const doorMat = bctx.matCache.getMaterial("metal");
  const frameMat = bctx.matCache.getMaterial("concrete");
  const w = 1.2, h = 2.4, t = 0.12;

  // Door panel (hinged at one side).
  const hingeOffset = door.hinge === "left" ? -w / 2 : w / 2;
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, t),
    doorMat,
  );
  panel.position.set(hingeOffset, h / 2, 0);
  panel.castShadow = true; panel.receiveShadow = true;
  panel.userData.surfaceType = "metal";
  panel.userData.materialSlug = "sheet_metal";
  panel.userData.interactiveId = door.id;
  panel.userData.interactiveKind = "door";
  panel.userData.hinge = door.hinge;
  group.add(panel);

  // Frame (left + right uprights + lintel).
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, h, 0.15),
      frameMat,
    );
    post.position.set(sx * (w / 2 + 0.075), h / 2, 0);
    post.castShadow = true; post.receiveShadow = true;
    group.add(post);
    bctx.colliders.push({ box: new THREE.Box3().setFromObject(post) });
  }
  const lintel = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.3, 0.2, 0.2),
    frameMat,
  );
  lintel.position.set(0, h + 0.1, 0);
  lintel.castShadow = true;
  group.add(lintel);
  bctx.colliders.push({ box: new THREE.Box3().setFromObject(lintel) });

  door.mesh = panel;
  return group;
}

/** Build a switch mesh (wall-mounted lever / button). */
export function buildSwitch(
  bctx: BuildContext,
  sw: SwitchInteractive,
): THREE.Object3D {
  const group = new THREE.Group();
  const [x, y, z] = sw.position;
  group.position.set(x, y, z);
  bctx.scene.add(group);

  const boxMat = bctx.matCache.getMaterial("metal");
  const leverMat = bctx.matCache.getMaterial("rust");

  // Mounting box.
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.4, 0.15),
    boxMat,
  );
  box.position.set(0, 0, 0);
  box.castShadow = true;
  box.userData.surfaceType = "metal";
  box.userData.interactiveId = sw.id;
  box.userData.interactiveKind = "switch";
  group.add(box);
  bctx.colliders.push({ box: new THREE.Box3().setFromObject(box) });

  // Lever (cylinder sticking out — rotates on use).
  const lever = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 0.3, 8),
    leverMat,
  );
  lever.position.set(0, 0.05, 0.15);
  lever.rotation.x = Math.PI / 2;
  lever.castShadow = true;
  lever.userData.interactiveId = sw.id;
  group.add(lever);

  sw.mesh = lever;
  return group;
}

/** Build an elevator platform (mesh that moves between floors). */
export function buildElevator(
  bctx: BuildContext,
  elev: ElevatorInteractive,
): THREE.Object3D {
  const group = new THREE.Group();
  const [x, , z] = elev.position;
  group.position.set(x, elev.currentY, z);
  bctx.scene.add(group);

  const platMat = bctx.matCache.getMaterial("metal");
  const railMat = bctx.matCache.getMaterial("oliveDark");

  // Platform.
  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(3.0, 0.2, 3.0),
    platMat,
  );
  platform.position.set(0, 0, 0);
  platform.castShadow = true; platform.receiveShadow = true;
  platform.userData.surfaceType = "metal";
  platform.userData.interactiveId = elev.id;
  platform.userData.interactiveKind = "elevator";
  group.add(platform);
  const col: Collider = { box: new THREE.Box3().setFromObject(platform) };
  bctx.colliders.push(col);
  elev.mesh = platform;

  // 4 corner rails (visual; not collidable).
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 12, 8),
      railMat,
    );
    rail.position.set(sx * 1.5, 6, sz * 1.5);
    rail.castShadow = false;
    group.add(rail);
  }

  return group;
}

/** Build a destructible wall (breachable wall that explodes when HP=0). */
export function buildDestructibleWall(
  bctx: BuildContext,
  wall: DestructibleWallInteractive,
): THREE.Object3D {
  const group = new THREE.Group();
  const [x, y, z] = wall.position;
  group.position.set(x, y, z);
  bctx.scene.add(group);

  const mat = bctx.matCache.getMaterial(wall.material);
  const w = 4, h = 3, t = 0.4;

  // Main wall panel.
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, t),
    mat,
  );
  panel.position.set(0, h / 2, 0);
  panel.castShadow = true; panel.receiveShadow = true;
  panel.userData.surfaceType = wall.material;
  panel.userData.materialSlug = wall.material;
  panel.userData.interactiveId = wall.id;
  panel.userData.interactiveKind = "destructible_wall";
  panel.userData.destructible = true;
  group.add(panel);
  const col: Collider = { box: new THREE.Box3().setFromObject(panel) };
  bctx.colliders.push(col);
  wall.mesh = panel;

  return group;
}

// ──────────────────────────────────────────────────────────────────────────
// Engine-cleanup helper
// ──────────────────────────────────────────────────────────────────────────

export function disposeInteractives(): void {
  clearInteractives();
}
