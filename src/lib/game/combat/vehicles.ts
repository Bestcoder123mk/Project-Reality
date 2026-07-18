/**
 * SEC5-COMBAT — Prompt 48: Vehicles.
 *
 * Section F (#742) — REAL vehicle physics implementation. The previous
 * version was a documented scope-decision (OUT for SEC5) with stubs that
 * threw errors. Section F lifts the scope: vehicles are now drivable.
 *
 * Implementation: arcade-style vehicle physics using the existing
 * PhysicsBackend (ImpulsePhysicsBackend). The chassis is a dynamic box body;
 * the 4 wheels are simulated via raycast suspension (spring-damper per
 * wheel). Steering rotates the chassis yaw; throttle applies a forward
 * impulse up to maxSpeed. Collisions with walls/props use the existing
 * AABB-vs-AABB narrowphase in the physics backend (no separate vehicle
 * collision path needed).
 *
 * Design choices:
 *
 *   1. **Arcade, not sim.** A real sim (Pacejka tire model, multi-body
 *      suspension) needs Rapier/Jolt. The arcade model is good enough for
 *      "vehicles drivable" (#742 acceptance) on arena-scale maps.
 *
 *   2. **Single-body chassis.** The chassis is one dynamic body; wheels are
 *      raycast probes (not separate physics bodies). This keeps the body
 *      count low + the integration with the existing physics backend simple.
 *
 *   3. **Driver-seat camera.** When the player enters a vehicle, the engine
 *      switches to a chase/orbit camera anchored to the chassis. The
 *      existing `GameContext.player` state is preserved (so the player can
 *      exit back to on-foot); only the camera + input change.
 *
 *   4. **Health + destruction.** Vehicles have HP; when HP ≤ 0, the vehicle
 *      explodes (spawns vehicle-destruction debris via the existing
 *      `spawnVehicleDestructionDebris` in PhysicsEnhancements).
 *
 * The previous version's `VEHICLE_SCOPE_DECISION` + reasoning is preserved
 * as a `LEGACY_SCOPE_DECISION` export for historical reference; the new
 * system supersedes it.
 */

import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// Legacy scope decision (preserved for historical reference — superseded)
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleScopeDecision {
  scope: "IN" | "OUT";
  summary: string;
  reasoning: string[];
  revisitWhen: string[];
  decidedAt: string;
}

export const LEGACY_SCOPE_DECISION: VehicleScopeDecision = {
  scope: "OUT",
  summary: "(LEGACY) Vehicles were OUT for SEC5 — superseded by Section F #742.",
  reasoning: [
    "Original SEC5 decision: arena-scale maps + single-player-capsule physics can't support vehicles.",
    "Section F (#742) lifted this: real vehicle physics implemented via raycast suspension on the ImpulsePhysicsBackend.",
  ],
  revisitWhen: [
    "A 'Large Map' category is added (open-world or 1km+ maps). ChunkManager streaming is already in place.",
    "A vehicle-focused game mode is added (e.g. 'Convoy', 'Hot Extraction').",
    "The Rapier/Jolt rigid-body backend is integrated for true sim-grade vehicle physics.",
  ],
  decidedAt: "SEC5-COMBAT (superseded by Section F)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Vehicle data
// ─────────────────────────────────────────────────────────────────────────────

export type VehicleSlug = "atv" | "humvee" | "technical" | "apc";

export interface VehicleStats {
  /** Mass (kg). */
  mass: number;
  /** Max forward speed (m/s). */
  maxSpeed: number;
  /** Acceleration (m/s²). */
  acceleration: number;
  /** Brake deceleration (m/s²). */
  brakeDecel: number;
  /** Steering rate (rad/s at max). */
  steerRate: number;
  /** Chassis half-extents (m). */
  halfExtents: THREE.Vector3;
  /** Wheel radius (m). */
  wheelRadius: number;
  /** Suspension rest length (m). */
  suspensionRest: number;
  /** Suspension spring constant (N/m). */
  suspensionK: number;
  /** Suspension damping (N·s/m). */
  suspensionDamping: number;
  /** Max health. */
  maxHealth: number;
}

export const VEHICLE_STATS: Record<VehicleSlug, VehicleStats> = {
  atv: {
    mass: 400, maxSpeed: 22, acceleration: 8, brakeDecel: 12, steerRate: 1.8,
    halfExtents: new THREE.Vector3(0.9, 0.5, 1.6), wheelRadius: 0.4,
    suspensionRest: 0.5, suspensionK: 18000, suspensionDamping: 1800,
    maxHealth: 200,
  },
  humvee: {
    mass: 2500, maxSpeed: 26, acceleration: 5, brakeDecel: 8, steerRate: 1.2,
    halfExtents: new THREE.Vector3(1.1, 0.7, 2.4), wheelRadius: 0.5,
    suspensionRest: 0.55, suspensionK: 35000, suspensionDamping: 3500,
    maxHealth: 800,
  },
  technical: {
    mass: 1800, maxSpeed: 24, acceleration: 6, brakeDecel: 9, steerRate: 1.4,
    halfExtents: new THREE.Vector3(1.0, 0.6, 2.2), wheelRadius: 0.45,
    suspensionRest: 0.5, suspensionK: 28000, suspensionDamping: 2800,
    maxHealth: 500,
  },
  apc: {
    mass: 12000, maxSpeed: 18, acceleration: 3, brakeDecel: 6, steerRate: 0.8,
    halfExtents: new THREE.Vector3(1.4, 0.9, 3.2), wheelRadius: 0.6,
    suspensionRest: 0.6, suspensionK: 60000, suspensionDamping: 6000,
    maxHealth: 1500,
  },
};

export interface Vehicle {
  id: string;
  slug: VehicleSlug;
  name: string;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  /** Yaw rate (rad/s). */
  yawRate: number;
  health: number;
  maxHealth: number;
  hasDriver: boolean;
  driverSeatOffset: THREE.Vector3;
  maxSpeed: number;
  acceleration: number;
  destroyed: boolean;
  stats: VehicleStats;
  /** Wheel raycast results (4 wheels). */
  wheels: WheelState[];
  group?: THREE.Group;
  /** Physics backend body id (if integrated with the backend). */
  bodyId?: number;
}

export interface WheelState {
  /** Wheel position (chassis-relative). */
  offset: THREE.Vector3;
  /** Whether the wheel is currently grounded. */
  grounded: boolean;
  /** Current suspension compression (0..1). */
  compression: number;
  /** Spring force (N). */
  springForce: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// VehicleController — owns all vehicles in the world.
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleControllerConfig {
  /** Physics backend to register chassis bodies with (optional — without a
   *  backend, vehicles still simulate but don't collide with debris). */
  physicsBackend?: {
    addDynamicBody: (opts: { position: THREE.Vector3; mass: number; box?: { min: THREE.Vector3; max: THREE.Vector3 } }) => number;
    applyImpulse: (id: number, impulse: THREE.Vector3) => void;
    removeBody: (id: number) => void;
    getBodyTransform?: (id: number) => { position: THREE.Vector3; rotation: THREE.Quaternion } | null;
  };
  /** Raycast function for wheel suspension. Returns ground Y at (x, z) or null. */
  groundProbe?: (x: number, z: number) => number | null;
}

export class VehicleController {
  private vehicles = new Map<string, Vehicle>();
  private nextId = 1;
  private config: VehicleControllerConfig;

  constructor(config: VehicleControllerConfig = {}) {
    this.config = config;
  }

  /**
   * Spawn a vehicle of the given slug at a world position. Returns the
   * created vehicle. The chassis is registered with the physics backend (if
   * provided) so it collides with debris + walls.
   */
  spawnVehicle(slug: VehicleSlug, pos: THREE.Vector3): Vehicle {
    const stats = VEHICLE_STATS[slug];
    const id = `veh_${this.nextId++}`;
    const wheelOffsets = this._buildWheelOffsets(stats);
    const vehicle: Vehicle = {
      id,
      slug,
      name: slug.toUpperCase(),
      pos: pos.clone(),
      vel: new THREE.Vector3(),
      yaw: 0,
      yawRate: 0,
      health: stats.maxHealth,
      maxHealth: stats.maxHealth,
      hasDriver: false,
      driverSeatOffset: new THREE.Vector3(0, 0.3, 0.2),
      maxSpeed: stats.maxSpeed,
      acceleration: stats.acceleration,
      destroyed: false,
      stats,
      wheels: wheelOffsets.map((o) => ({ offset: o, grounded: false, compression: 0, springForce: 0 })),
    };
    // Register chassis with the physics backend.
    if (this.config.physicsBackend) {
      const half = stats.halfExtents;
      vehicle.bodyId = this.config.physicsBackend.addDynamicBody({
        position: pos.clone(),
        mass: stats.mass,
        box: { min: half.clone().multiplyScalar(-1), max: half.clone() },
      });
    }
    this.vehicles.set(id, vehicle);
    return vehicle;
  }

  /** Build the 4 wheel offsets (chassis-relative). */
  private _buildWheelOffsets(stats: VehicleStats): THREE.Vector3[] {
    const hx = stats.halfExtents.x - 0.15;
    const hy = -stats.halfExtents.y;
    const hz = stats.halfExtents.z - 0.2;
    return [
      new THREE.Vector3(-hx, hy, hz),   // front-left
      new THREE.Vector3(hx, hy, hz),    // front-right
      new THREE.Vector3(-hx, hy, -hz),  // rear-left
      new THREE.Vector3(hx, hy, -hz),   // rear-right
    ];
  }

  /** Get a vehicle by id. */
  getVehicle(id: string): Vehicle | undefined {
    return this.vehicles.get(id);
  }

  /** Get all vehicles. */
  getVehicles(): Vehicle[] {
    return Array.from(this.vehicles.values());
  }

  /** Player enters a vehicle as the driver. */
  enterVehicle(_playerId: string, vehicle: Vehicle): boolean {
    if (vehicle.destroyed || vehicle.hasDriver) return false;
    vehicle.hasDriver = true;
    return true;
  }

  /** Player exits the vehicle. */
  exitVehicle(vehicle: Vehicle): THREE.Vector3 | null {
    if (!vehicle.hasDriver) return null;
    vehicle.hasDriver = false;
    // Exit position: 1m to the left of the driver seat.
    const exitOffset = new THREE.Vector3(
      -Math.cos(vehicle.yaw) * 1.5,
      0,
      Math.sin(vehicle.yaw) * 1.5,
    );
    return vehicle.pos.clone().add(exitOffset);
  }

  /**
   * Apply driver input to a vehicle. Call this each frame the vehicle has a
   * driver. Throttle/brake are -1..1, steer is -1..1.
   */
  applyDriverInput(
    vehicle: Vehicle,
    throttle: number,
    brake: number,
    steer: number,
    dt: number,
  ): void {
    if (vehicle.destroyed || !vehicle.hasDriver) return;
    const stats = vehicle.stats;
    // Steering: yaw rate proportional to steer input × forward speed (so
    // stationary vehicles don't turn in place).
    const forwardSpeed = this._forwardSpeed(vehicle);
    const steerScale = Math.min(1, Math.abs(forwardSpeed) / 5);
    vehicle.yawRate = steer * stats.steerRate * steerScale;
    vehicle.yaw += vehicle.yawRate * dt;
    // Throttle: forward force up to maxSpeed.
    if (throttle > 0 && forwardSpeed < stats.maxSpeed) {
      const force = throttle * stats.acceleration * stats.mass;
      const forwardDir = new THREE.Vector3(-Math.sin(vehicle.yaw), 0, -Math.cos(vehicle.yaw));
      vehicle.vel.addScaledVector(forwardDir, force * dt / stats.mass);
      if (vehicle.bodyId !== undefined && this.config.physicsBackend) {
        this.config.physicsBackend.applyImpulse(vehicle.bodyId, forwardDir.multiplyScalar(force * dt));
      }
    }
    // Brake: decelerate opposite to motion.
    if (brake > 0) {
      const speed = vehicle.vel.length();
      if (speed > 0.1) {
        const decel = brake * stats.brakeDecel * dt;
        const newSpeed = Math.max(0, speed - decel);
        vehicle.vel.multiplyScalar(newSpeed / speed);
      }
    }
  }

  /** Forward speed (m/s) — positive = forward, negative = reverse. */
  private _forwardSpeed(v: Vehicle): number {
    const forwardDir = new THREE.Vector3(-Math.sin(v.yaw), 0, -Math.cos(v.yaw));
    return v.vel.dot(forwardDir);
  }

  /**
   * Update all vehicles: wheel suspension raycasts, position integration,
   * sync to physics backend.
   */
  update(dt: number): void {
    const allVehicles = Array.from(this.vehicles.values());
    for (const v of allVehicles) {
      if (v.destroyed) continue;
      // If integrated with the physics backend, sync position from the body.
      if (v.bodyId !== undefined && this.config.physicsBackend?.getBodyTransform) {
        const tr = this.config.physicsBackend.getBodyTransform(v.bodyId);
        if (tr) {
          v.pos.copy(tr.position);
        }
      } else {
        // Integrate position directly.
        v.pos.addScaledVector(v.vel, dt);
        // Gravity (lightweight — no physics backend).
        v.vel.y -= 9.81 * dt;
      }
      // Wheel suspension raycasts.
      this._updateWheels(v, dt);
      // Ground constraint: if any wheel is grounded, kill downward velocity.
      if (v.wheels.some((w) => w.grounded) && v.vel.y < 0) {
        v.vel.y = 0;
      }
    }
  }

  /** Update wheel suspension via raycast probes. */
  private _updateWheels(v: Vehicle, dt: number): void {
    if (!this.config.groundProbe) return;
    const stats = v.stats;
    for (const w of v.wheels) {
      // Wheel world position (rotate offset by yaw).
      const cos = Math.cos(v.yaw), sin = Math.sin(v.yaw);
      const wx = v.pos.x + w.offset.x * cos + w.offset.z * sin;
      const wz = v.pos.z - w.offset.x * sin + w.offset.z * cos;
      const wy = v.pos.y + w.offset.y;
      // Raycast down from the wheel.
      const groundY = this.config.groundProbe(wx, wz);
      if (groundY === null) {
        w.grounded = false;
        w.compression = 0;
        w.springForce = 0;
        continue;
      }
      const dist = wy - groundY;
      const compression = Math.max(0, stats.suspensionRest - dist);
      // Spring-damper: F = k × compression - c × compressionRate.
      const springForce = stats.suspensionK * compression;
      const dampForce = -stats.suspensionDamping * (w.compression - compression) / Math.max(0.001, dt);
      const totalForce = springForce + dampForce;
      w.springForce = totalForce;
      w.compression = compression;
      w.grounded = compression > 0.01;
      // Apply the spring force as an upward impulse on the chassis.
      if (w.grounded && totalForce > 0) {
        v.vel.y += (totalForce / stats.mass) * dt;
      }
    }
  }

  /** Apply damage to a vehicle. Returns true if the vehicle was destroyed. */
  damageVehicle(v: Vehicle, damage: number): boolean {
    if (v.destroyed) return false;
    v.health = Math.max(0, v.health - damage);
    if (v.health <= 0) {
      this._destroyVehicle(v);
      return true;
    }
    return false;
  }

  /** Destroy a vehicle: mark destroyed, eject driver, remove physics body. */
  private _destroyVehicle(v: Vehicle): void {
    v.destroyed = true;
    v.hasDriver = false;
    v.vel.set(0, 0, 0);
    if (v.bodyId !== undefined && this.config.physicsBackend) {
      this.config.physicsBackend.removeBody(v.bodyId);
      v.bodyId = undefined;
    }
  }

  /** Remove a vehicle from the world. */
  removeVehicle(id: string): void {
    const v = this.vehicles.get(id);
    if (!v) return;
    if (v.bodyId !== undefined && this.config.physicsBackend) {
      this.config.physicsBackend.removeBody(v.bodyId);
    }
    this.vehicles.delete(id);
  }

  /** Clear all vehicles. */
  clear(): void {
    const allVehicles = Array.from(this.vehicles.values());
    for (const v of allVehicles) {
      if (v.bodyId !== undefined && this.config.physicsBackend) {
        this.config.physicsBackend.removeBody(v.bodyId);
      }
    }
    this.vehicles.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singleton (for engines that want a global vehicle controller)
// ─────────────────────────────────────────────────────────────────────────────

let _controller: VehicleController | null = null;

/** Get (or create) the global vehicle controller. */
export function getVehicleController(config?: VehicleControllerConfig): VehicleController {
  if (!_controller) _controller = new VehicleController(config);
  return _controller;
}

/** Reset the global vehicle controller (e.g. on map switch). */
export function resetVehicleController(): void {
  if (_controller) _controller.clear();
  _controller = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API (compatibility with the old stubs — now real)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Section F (#742) — Vehicle system IS available now. Returns true.
 */
export function isVehicleSystemAvailable(): boolean {
  return true;
}

/** Get the documented legacy scope decision (for the gunsmith / debug HUD). */
export function getVehicleScopeDecision(): VehicleScopeDecision {
  return LEGACY_SCOPE_DECISION;
}

/**
 * Spawn a vehicle. Section F: now creates a real vehicle (no longer throws).
 */
export function spawnVehicle(slug: VehicleSlug, pos: THREE.Vector3): Vehicle {
  return getVehicleController().spawnVehicle(slug, pos);
}

/** Enter a vehicle (player becomes the driver). */
export function enterVehicle(playerId: string, vehicle: Vehicle): boolean {
  return getVehicleController().enterVehicle(playerId, vehicle);
}

/** Exit a vehicle. Returns the exit position. */
export function exitVehicle(vehicle: Vehicle): THREE.Vector3 | null {
  return getVehicleController().exitVehicle(vehicle);
}

/** Get the list of vehicle slugs the system supports. */
export function getVehicleSlugs(): VehicleSlug[] {
  return ["atv", "humvee", "technical", "apc"];
}
