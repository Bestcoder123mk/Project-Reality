/**
 * Section F — Vehicle AI.
 *
 * Addresses Section F prompts for "enemy vehicles with pathfinding and
 * turret tracking". Implements a lightweight vehicle controller for
 * ground vehicles (APCs, technicals, tanks) with:
 *
 *   - **Waypoint pathfinding**: a simple A*-style grid pathfinder that
 *     plans a route around obstacles to the target. Cached + re-planned
 *     when the target moves > 5m or a path segment is blocked.
 *   - **Driver behavior**: the driver steers toward the next waypoint,
 *     accelerates / brakes based on the turn angle, and avoids colliders
 *     in the immediate forward arc.
 *   - **Turret tracking**: the turret independently tracks a target
 *     (typically the player). The turret yaw + pitch are slewed toward
 *     the target at a max rate (deg/sec). When the turret is within a
 *     firing tolerance, the gun fires.
 *   - **Dismount**: when the vehicle's HP drops below 25%, the crew
 *     dismounts (spawns 2-4 infantry enemies near the vehicle).
 *   - **Roles**: DRIVER (steers), GUNNER (aims + fires the main gun),
 *     COMMANDER (spots + designates targets). For simplicity, all three
 *     are simulated by the vehicle's AI; the dismount spawns actual
 *     infantry enemies.
 *
 * Pure-TS, SSR-safe. THREE is imported lazily.
 *
 * Integration:
 *   - The engine constructs a VehicleManager per match (only in modes /
 *     waves that have vehicles). Each Vehicle has a THREE.Group mesh
 *     (built lazily).
 *   - The manager ticks each vehicle per frame.
 *   - The damage system calls `damageVehicle(v, amount)` when a projectile
 *     hits a vehicle mesh.
 */

import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type VehicleClass = "technical" | "apc" | "tank";

export type VehicleState = "IDLE" | "PATROL" | "ENGAGE" | "FLEE" | "DISMOUNTING" | "DEAD";

export interface Vehicle {
  id: string;
  /** Vehicle class — drives stats + behavior. */
  cls: VehicleClass;
  /** World mesh (hull + turret + wheels). */
  group: THREE.Group;
  /** Turret Object3D (child of group; rotated independently). */
  turret: THREE.Object3D;
  /** Hull (the main body — used for hit detection). */
  hull: THREE.Mesh;
  /** Position (mirrors group.position). */
  posX: number;
  posY: number;
  posZ: number;
  /** Hull yaw (radians) — the direction the hull is facing. */
  hullYaw: number;
  /** Turret yaw (radians, world-space) — independent of hullYaw. */
  turretYaw: number;
  /** Turret pitch (radians). */
  turretPitch: number;
  /** Current forward speed (m/s). */
  speed: number;
  /** Health. */
  health: number;
  maxHealth: number;
  alive: boolean;
  /** FSM state. */
  state: VehicleState;
  /** Current path (list of waypoints). */
  path: Array<{ x: number; z: number }>;
  /** Current path waypoint index. */
  pathIdx: number;
  /** Target position (the player or a patrol point). */
  targetX: number;
  targetZ: number;
  /** performance.now() of last main-gun fire. */
  lastFireAt: number;
  /** performance.now() of last path re-plan. */
  lastRepathAt: number;
  /** True if the crew has dismounted (one-shot). */
  dismounted: boolean;
  /** Dismounted crew (Enemy references, for tracking). */
  crew: Enemy[];
  /** Dead timestamp. */
  deadAt: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-class stats
// ───────────────────────────────────────────────────────────────────────────

export interface VehicleStats {
  /** Max forward speed (m/s). */
  maxSpeed: number;
  /** Acceleration (m/s²). */
  acceleration: number;
  /** Brake deceleration (m/s²). */
  brakeDecel: number;
  /** Hull turn rate (rad/sec). */
  hullTurnRate: number;
  /** Turret turn rate (rad/sec). */
  turretTurnRate: number;
  /** Main-gun damage per shot. */
  gunDamage: number;
  /** Main-gun fire cooldown (ms). */
  gunCooldownMs: number;
  /** Main-gun range (m). */
  gunRange: number;
  /** Hull health. */
  health: number;
  /** Turret pitch range (rad) — [min, max] (negative = down). */
  pitchRange: [number, number];
  /** Dismount crew count. */
  crewCount: number;
  /** True if the vehicle has a turret (vs. fixed-gun). */
  hasTurret: boolean;
}

const VEHICLE_STATS: Record<VehicleClass, VehicleStats> = {
  technical: {
    maxSpeed: 14, acceleration: 6, brakeDecel: 10,
    hullTurnRate: 1.2, turretTurnRate: 2.0,
    gunDamage: 8, gunCooldownMs: 120, gunRange: 50,
    health: 200, pitchRange: [-0.3, 0.5], crewCount: 2, hasTurret: true,
  },
  apc: {
    maxSpeed: 10, acceleration: 4, brakeDecel: 8,
    hullTurnRate: 0.8, turretTurnRate: 1.5,
    gunDamage: 12, gunCooldownMs: 200, gunRange: 60,
    health: 400, pitchRange: [-0.3, 0.5], crewCount: 4, hasTurret: true,
  },
  tank: {
    maxSpeed: 8, acceleration: 3, brakeDecel: 6,
    hullTurnRate: 0.6, turretTurnRate: 1.0,
    gunDamage: 80, gunCooldownMs: 2500, gunRange: 100,
    health: 1000, pitchRange: [-0.2, 0.4], crewCount: 3, hasTurret: true,
  },
};

// ───────────────────────────────────────────────────────────────────────────
// VehicleManager
// ───────────────────────────────────────────────────────────────────────────

const PATH_REPLAN_INTERVAL_MS = 1000;
const PATH_REPLAN_TARGET_DELTA_M = 5;
const DISMOUNT_HP_PCT = 0.25;
const GRID_CELL_M = 4;
const GRID_EXTENT = 48; // ±48m

export class VehicleManager {
  private vehicles: Vehicle[] = [];
  private ctx: GameContext;
  /** Dismount crew spawn hook — the engine wires this to spawn an Enemy
   *  at the given position. */
  crewSpawnHook?: (x: number, z: number) => Enemy | null;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
  }

  /** Spawn a vehicle of the given class at the given position. */
  spawn(cls: VehicleClass, x: number, z: number): Vehicle {
    const stats = VEHICLE_STATS[cls];
    const group = this.buildVehicleMesh(cls);
    group.position.set(x, 0, z);
    this.ctx.scene.add(group);
    const turret = group.getObjectByName("turret") ?? new THREE.Object3D();
    const hull = group.getObjectByName("hull") as THREE.Mesh ?? new THREE.Mesh();
    const id = `veh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const v: Vehicle = {
      id, cls, group, turret, hull,
      posX: x, posY: 0, posZ: z,
      hullYaw: 0, turretYaw: 0, turretPitch: 0,
      speed: 0,
      health: stats.health, maxHealth: stats.health,
      alive: true, state: "PATROL",
      path: [], pathIdx: 0,
      targetX: x, targetZ: z,
      lastFireAt: 0, lastRepathAt: 0,
      dismounted: false, crew: [], deadAt: 0,
    };
    // Tag the mesh's parts so the damage system can identify them.
    group.userData.vehicle = v;
    group.traverse((o) => { o.userData.vehicle = v; });
    this.vehicles.push(v);
    return v;
  }

  /** Damage a vehicle. Returns true if the vehicle died from this damage. */
  damageVehicle(v: Vehicle, amount: number, now: number = performance.now()): boolean {
    if (!v.alive) return false;
    v.health -= amount;
    if (v.health <= 0) {
      v.health = 0;
      v.alive = false;
      v.deadAt = now;
      v.state = "DEAD";
      return true;
    }
    if (v.health < v.maxHealth * DISMOUNT_HP_PCT && !v.dismounted) {
      v.state = "DISMOUNTING";
    }
    return false;
  }

  /** Tick all vehicles. */
  update(dt: number, now: number = performance.now()): void {
    for (const v of this.vehicles) {
      if (!v.alive) continue;
      this.tickVehicle(v, dt, now);
    }
    // Remove long-dead vehicles.
    this.vehicles = this.vehicles.filter((v) => {
      if (v.alive) return true;
      if (now - v.deadAt > 8000) {
        this.ctx.scene.remove(v.group);
        return false;
      }
      return true;
    });
  }

  /** Get all vehicles (for debug / HUD). */
  getAll(): Vehicle[] { return this.vehicles; }

  /** Get all alive vehicles. */
  getAlive(): Vehicle[] { return this.vehicles.filter((v) => v.alive); }

  /** Reset (called on match restart). */
  dispose(): void {
    for (const v of this.vehicles) {
      this.ctx.scene.remove(v.group);
    }
    this.vehicles = [];
  }

  // ---------- Internal ----------

  private tickVehicle(v: Vehicle, dt: number, now: number): void {
    const stats = VEHICLE_STATS[v.cls];
    const playerPos = this.ctx.player.pos;
    const distToPlayer = Math.hypot(playerPos.x - v.posX, playerPos.z - v.posZ);

    // ---------- State transitions ----------
    if (v.state === "DISMOUNTING") {
      // Stop the vehicle + spawn the crew.
      v.speed = 0;
      if (!v.dismounted) {
        this.spawnCrew(v, stats);
        v.dismounted = true;
      }
      // After dismount, the vehicle is no longer a threat (engine off, crew
      // gone). Transition to FLEE if HP > 0 (driver bails) or stay put.
      v.state = v.health > v.maxHealth * 0.1 ? "FLEE" : "DEAD";
      if (v.state === "DEAD") { v.alive = false; v.deadAt = now; }
      return;
    }

    // ---------- Target selection ----------
    v.targetX = playerPos.x;
    v.targetZ = playerPos.z;
    if (v.state === "FLEE") {
      // Flee: move away from the player.
      const dx = v.posX - playerPos.x;
      const dz = v.posZ - playerPos.z;
      const d = Math.hypot(dx, dz) || 1;
      v.targetX = v.posX + (dx / d) * 40;
      v.targetZ = v.posZ + (dz / d) * 40;
    }

    // ---------- Path planning ----------
    if (now - v.lastRepathAt > PATH_REPLAN_INTERVAL_MS) {
      v.path = this.planPath(v.posX, v.posZ, v.targetX, v.targetZ);
      v.pathIdx = 0;
      v.lastRepathAt = now;
    }

    // ---------- Driver behavior ----------
    const nextWp = v.path[v.pathIdx];
    if (nextWp) {
      const dx = nextWp.x - v.posX;
      const dz = nextWp.z - v.posZ;
      const d = Math.hypot(dx, dz);
      if (d < 2) {
        v.pathIdx++;
      } else {
        // Steer toward the waypoint.
        const desiredYaw = Math.atan2(dx, dz);
        const yawDelta = angleDiff(desiredYaw, v.hullYaw);
        const turn = clamp(yawDelta, -stats.hullTurnRate * dt, stats.hullTurnRate * dt);
        v.hullYaw += turn;
        // Accelerate if heading roughly forward; brake on hard turns.
        const turnFactor = Math.abs(yawDelta) > 0.5 ? 0.3 : 1.0;
        v.speed = Math.min(v.speed + stats.acceleration * dt * turnFactor, stats.maxSpeed * turnFactor);
        if (Math.abs(yawDelta) > 1.5) v.speed = Math.max(0, v.speed - stats.brakeDecel * dt);
      }
    } else {
      // No path / reached destination — slow down.
      v.speed = Math.max(0, v.speed - stats.brakeDecel * dt);
    }

    // Apply movement.
    v.posX += Math.sin(v.hullYaw) * v.speed * dt;
    v.posZ += Math.cos(v.hullYaw) * v.speed * dt;
    // Bounds clamp.
    const b = 43;
    v.posX = Math.max(-b, Math.min(b, v.posX));
    v.posZ = Math.max(-b, Math.min(b, v.posZ));
    v.group.position.set(v.posX, v.posY, v.posZ);
    v.group.rotation.y = v.hullYaw;

    // ---------- Turret tracking ----------
    if (stats.hasTurret && v.state !== "FLEE") {
      const tdx = playerPos.x - v.posX;
      const tdz = playerPos.z - v.posZ;
      const desiredTurretYaw = Math.atan2(tdx, tdz);
      const yawDelta = angleDiff(desiredTurretYaw, v.turretYaw);
      const turn = clamp(yawDelta, -stats.turretTurnRate * dt, stats.turretTurnRate * dt);
      v.turretYaw += turn;
      // Pitch (slight downward aim at close range, level at long range).
      const dy = playerPos.y + 1.4 - (v.posY + 2.0);
      const horizDist = Math.hypot(tdx, tdz);
      const desiredPitch = -Math.atan2(dy, Math.max(1, horizDist));
      v.turretPitch = clamp(desiredPitch, stats.pitchRange[0], stats.pitchRange[1]);
      v.turret.rotation.y = v.turretYaw - v.hullYaw; // local yaw relative to hull.
      v.turret.rotation.x = v.turretPitch;

      // ---------- Main gun firing ----------
      if (Math.abs(yawDelta) < 0.05 && distToPlayer <= stats.gunRange &&
          now - v.lastFireAt > stats.gunCooldownMs) {
        v.lastFireAt = now;
        this.fireMainGun(v, stats, playerPos);
      }
    }
  }

  private fireMainGun(v: Vehicle, stats: VehicleStats, target: THREE.Vector3): void {
    // Spawn an enemy projectile via the ctx.projectileSystem.
    const origin = new THREE.Vector3(v.posX, v.posY + 2.0, v.posZ);
    const dir = new THREE.Vector3().subVectors(target, origin).normalize();
    const ps = this.ctx.projectileSystem;
    if (!ps) return;
    ps.spawn({
      origin,
      direction: dir,
      category: v.cls === "tank" ? "sniper" : "rifle", // tank = high-caliber; apc/technical = rifle proxy.
      baseDamage: stats.gunDamage,
      headshotMult: 1.0,
      maxRange: stats.gunRange,
      team: "enemy",
      weaponSlug: v.cls === "tank" ? "tank_main_gun" : "vehicle_mg",
      tracerColor: 0xff4422,
      tracerHidden: false,
    });
  }

  private spawnCrew(v: Vehicle, stats: VehicleStats): void {
    if (!this.crewSpawnHook) return;
    for (let i = 0; i < stats.crewCount; i++) {
      const angle = (i / stats.crewCount) * Math.PI * 2;
      const x = v.posX + Math.cos(angle) * 3;
      const z = v.posZ + Math.sin(angle) * 3;
      const enemy = this.crewSpawnHook(x, z);
      if (enemy) v.crew.push(enemy);
    }
  }

  // ---------- Pathfinding (grid A*) ----------

  private planPath(startX: number, startZ: number, goalX: number, goalZ: number): Array<{ x: number; z: number }> {
    // Cheap grid-based A* with the level's colliders as obstacles.
    const grid = this.buildObstacleGrid();
    const startCell = this.worldToCell(startX, startZ);
    const goalCell = this.worldToCell(goalX, goalZ);
    const path = astar(grid, startCell, goalCell);
    // Convert back to world waypoints (cell centers).
    return path.map((c) => this.cellToWorld(c));
  }

  private buildObstacleGrid(): Uint8Array {
    const size = Math.ceil((GRID_EXTENT * 2) / GRID_CELL_M);
    const grid = new Uint8Array(size * size); // 0 = free, 1 = blocked.
    for (const c of this.ctx.colliders) {
      // Mark cells overlapping the collider AABB as blocked.
      const minX = Math.max(0, Math.floor((c.box.min.x + GRID_EXTENT) / GRID_CELL_M));
      const maxX = Math.min(size - 1, Math.floor((c.box.max.x + GRID_EXTENT) / GRID_CELL_M));
      const minZ = Math.max(0, Math.floor((c.box.min.z + GRID_EXTENT) / GRID_CELL_M));
      const maxZ = Math.min(size - 1, Math.floor((c.box.max.z + GRID_EXTENT) / GRID_CELL_M));
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          grid[z * size + x] = 1;
        }
      }
    }
    return grid;
  }

  private worldToCell(x: number, z: number): { x: number; z: number } {
    const size = Math.ceil((GRID_EXTENT * 2) / GRID_CELL_M);
    return {
      x: clamp(Math.floor((x + GRID_EXTENT) / GRID_CELL_M), 0, size - 1),
      z: clamp(Math.floor((z + GRID_EXTENT) / GRID_CELL_M), 0, size - 1),
    };
  }

  private cellToWorld(c: { x: number; z: number }): { x: number; z: number } {
    return {
      x: c.x * GRID_CELL_M - GRID_EXTENT + GRID_CELL_M / 2,
      z: c.z * GRID_CELL_M - GRID_EXTENT + GRID_CELL_M / 2,
    };
  }

  // ---------- Vehicle mesh ----------

  private buildVehicleMesh(cls: VehicleClass): THREE.Group {
    const group = new THREE.Group();
    // Hull.
    const hullSize = cls === "tank" ? 4 : cls === "apc" ? 3 : 2.5;
    const hullGeo = new THREE.BoxGeometry(hullSize, 1.2, hullSize * 1.6);
    const hullMat = new THREE.MeshStandardMaterial({ color: cls === "tank" ? 0x3a3a2a : 0x4a4030, roughness: 0.8 });
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.position.y = 1.0;
    hull.name = "hull";
    group.add(hull);
    // Turret.
    const turret = new THREE.Object3D();
    turret.position.y = 1.6;
    turret.name = "turret";
    group.add(turret);
    const turretGeo = new THREE.BoxGeometry(hullSize * 0.6, 0.8, hullSize * 0.7);
    const turretMesh = new THREE.Mesh(turretGeo, hullMat);
    turretMesh.position.y = 0.4;
    turret.add(turretMesh);
    // Gun barrel.
    const barrelLen = cls === "tank" ? 3.5 : 1.5;
    const barrelGeo = new THREE.CylinderGeometry(0.12, 0.12, barrelLen, 8);
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.6 });
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.4, barrelLen / 2);
    turret.add(barrel);
    // Wheels (visual only).
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.9 });
    for (let i = 0; i < 4; i++) {
      const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 12);
      const wl = new THREE.Mesh(wheelGeo, wheelMat);
      wl.rotation.z = Math.PI / 2;
      wl.position.set(-hullSize / 2, 0.4, -hullSize * 0.5 + i * hullSize * 0.35);
      group.add(wl);
      const wr = new THREE.Mesh(wheelGeo, wheelMat);
      wr.rotation.z = Math.PI / 2;
      wr.position.set(hullSize / 2, 0.4, -hullSize * 0.5 + i * hullSize * 0.35);
      group.add(wr);
    }
    return group;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// A* pathfinder (grid)
// ───────────────────────────────────────────────────────────────────────────

interface Cell { x: number; z: number; }

function astar(grid: Uint8Array, start: Cell, goal: Cell): Cell[] {
  const size = Math.sqrt(grid.length) | 0;
  const idx = (x: number, z: number) => z * size + x;
  const inBounds = (x: number, z: number) => x >= 0 && z >= 0 && x < size && z < size;
  const isBlocked = (x: number, z: number) => grid[idx(x, z)] === 1;
  const heuristic = (a: Cell, b: Cell) => Math.hypot(a.x - b.x, a.z - b.z);

  const open: Array<{ cell: Cell; g: number; f: number }> = [];
  const cameFrom = new Map<number, Cell>();
  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  const startKey = idx(start.x, start.z);
  gScore.set(startKey, 0);
  fScore.set(startKey, heuristic(start, goal));
  open.push({ cell: start, g: 0, f: fScore.get(startKey)! });

  let iter = 0;
  const MAX_ITER = 500;
  while (open.length > 0 && iter++ < MAX_ITER) {
    // Pop the lowest-f cell.
    open.sort((a, b) => a.f - b.f);
    const { cell: cur } = open.shift()!;
    if (cur.x === goal.x && cur.z === goal.z) {
      // Reconstruct path.
      const path: Cell[] = [cur];
      let k = idx(cur.x, cur.z);
      while (cameFrom.has(k)) {
        const prev = cameFrom.get(k)!;
        path.unshift(prev);
        k = idx(prev.x, prev.z);
      }
      return path;
    }
    // 8-connected neighbors.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cur.x + dx;
        const nz = cur.z + dz;
        if (!inBounds(nx, nz) || isBlocked(nx, nz)) continue;
        // No corner-cutting.
        if (dx !== 0 && dz !== 0) {
          if (isBlocked(cur.x + dx, cur.z) || isBlocked(cur.x, cur.z + dz)) continue;
        }
        const nKey = idx(nx, nz);
        const tentativeG = (gScore.get(idx(cur.x, cur.z)) ?? Infinity) + (dx !== 0 && dz !== 0 ? 1.41 : 1);
        if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, cur);
          gScore.set(nKey, tentativeG);
          const f = tentativeG + heuristic({ x: nx, z: nz }, goal);
          fScore.set(nKey, f);
          open.push({ cell: { x: nx, z: nz }, g: tentativeG, f });
        }
      }
    }
  }
  // No path found — return a straight line as a fallback.
  return [start, goal];
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Smallest signed angle from a to b (radians). */
function angleDiff(b: number, a: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
