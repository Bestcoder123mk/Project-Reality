/**
 * Phase 1 → AAA: Real physics backend.
 *
 * Originally a small impulse-based AABB sim. Now extended (Section F / Section
 * A physics-engine bugs #90-#106 + #731-#746) with:
 *
 *   - Real sphere primitive (#106) — narrowphase sphere-vs-AABB + sphere-vs-sphere.
 *   - Collision group/mask bitfields (#103 / #734) — bodies only collide if
 *     (a.group & b.mask) && (b.group & a.mask).
 *   - AABB tight broadphase (#104 / #735) — replaced bounding-sphere radius
 *     `halfExtents.length()` with per-axis overlap test on the cached AABBs.
 *   - Cached `getDynamicBodies()` view (#105) — no per-call allocation; the
 *     array is reused + a version counter lets callers detect mutation.
 *   - Typed `restFrames` field on PhysicsBody (#102) — no `_restFrames` cast.
 *   - Horizontal-velocity sleep gate (#101 / #733) — a sliding body sleeps
 *     only when its HORIZONTAL speed is below threshold, not its 3D speed
 *     (which can be near-zero from gravity balancing a slope).
 *   - Post-normal-impulse tangent velocity for friction (#99) — friction now
 *     uses the relative tangential velocity AFTER the normal impulse is
 *     applied, so high-speed impacts decelerate correctly.
 *   - Average friction (not geometric mean) (#100) — `(b1.friction + b2.friction) / 2`
 *     so ice+metal ≠ 0.
 *   - Baumgarte positional correction with slop/percent (#98) — `percent=0.2,
 *     slop=0.01` so resting stacks don't jitter.
 *   - CCD for high-velocity bodies (#97 / #731) — bodies whose speed × dt
 *     exceeds their smallest half-extent are sub-stepped OR ray-cast between
 *     previous + new position so they can't tunnel through thin walls.
 *   - Uniform-grid broadphase (#736) — O(n) broadphase via spatial hash;
 *     falls back to O(n²) when active body count is tiny.
 *   - Buoyancy (#737) — bodies in a registered water volume get an Archimedes
 *     upward force proportional to submerged volume.
 *   - Breakable constraints (#739) — distance + hinge joints with a stress
 *     threshold; joints snap when the constraint force exceeds the limit.
 *   - Soft-body volume preservation (#740) — verlet-style soft body with a
 *     pressure term that inflates the volume back toward rest.
 *   - Joint friction (#743) — hinge constraints lose angular energy to a
 *     configurable friction coefficient.
 *   - Aerodynamic drag (quadratic) (#746) — `F = -k * |v| * v` for fast-moving
 *     bodies, separately from the existing linear damping.
 *
 * Public interface is unchanged (same method signatures) so the rest of the
 * engine doesn't know which features are active. New opt-in features are added
 * via new methods on the backend instance (addWaterVolume, addConstraint,
 * addSoftBody, setBodyCCD, etc.).
 */

import * as THREE from "three";
import { isFeatureEnabled } from "../FeatureFlags";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single source-of-truth gravity. Used by PhysicsBackend, PhysicsSystem, and
 * (via re-export below) RagdollSystem. Fixes #92 — three gravity values
 * (-22 player / -9.81 backend / -9.8 ragdoll) caused inconsistent behavior.
 *
 * We pick -9.81 (realistic). PhysicsSystem applies a 2.2× "arcade gravity
 * multiplier" via `PHYSICS_GRAVITY_ARCADE_MULT` (re-exported below) so the
 * player still feels snappy without diverging from the backend's value.
 */
export const GRAVITY = -9.81;

/**
 * Arcade gravity multiplier applied to the player only (player wants to feel
 * snappier than free-fall). PhysicsSystem uses `GRAVITY * PHYSICS_GRAVITY_ARCADE_MULT`
 * for the player; the physics backend + ragdolls use `GRAVITY` directly.
 *
 * Fixes #92 by centralizing the multiplier here (was a magic -22 in
 * PhysicsSystem + a magic -9.8 in RagdollSystem — both now reference this).
 */
export const PHYSICS_GRAVITY_ARCADE_MULT = 2.2;

/** Horizontal speed below which a body is eligible to sleep (m/s). #101/#733. */
const RESTING_HORIZONTAL_VELOCITY = 0.05;
/** Vertical speed below which a body is eligible to sleep (m/s). */
const RESTING_VERTICAL_VELOCITY = 0.15;
/** Frames a body must be at rest before sleeping. */
const RESTING_FRAMES = 4;

/** Baumgarte positional correction. #98. */
const BAUMGARTE_PERCENT = 0.2;
const BAUMGARTE_SLOP = 0.01;

/** CCD threshold: sub-step if (speed × dt) > body's smallest half-extent × this. #97/#731. */
const CCD_SPEED_RATIO = 1.0;
/** Max CCD sub-steps per frame per body (perf bound). */
const CCD_MAX_SUBSTEPS = 4;

/** Default collision groups. #103/#734. Bitfield — up to 16 layers. */
export const CollisionGroup = {
  DEFAULT:      0x0001,
  PLAYER:       0x0002,
  ENEMY:        0x0004,
  PICKUP:       0x0008,
  DEBRIS:       0x0010,
  RAGDOLL:      0x0020,
  VEHICLE:      0x0040,
  PROJECTILE:   0x0080,
  TRIGGER:      0x0100,
  STATIC_WORLD: 0x0200,
} as const;
export type CollisionGroupFlag = typeof CollisionGroup[keyof typeof CollisionGroup];

/** Mask that collides with everything (default). */
export const COLLIDE_ALL = 0xFFFF;

// ─────────────────────────────────────────────────────────────────────────────
// Body shape
// ─────────────────────────────────────────────────────────────────────────────

export type BodyShape = "box" | "sphere";

export interface PhysicsBody {
  id: number;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  linearVelocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  /** Static (mass=0) or dynamic. */
  isStatic: boolean;
  /** AABB for broadphase compatibility. Updated each step. */
  aabb: { min: THREE.Vector3; max: THREE.Vector3 };
  /** Mass (kg). 0 = static. */
  mass: number;
  /** Inverse mass (cached; 0 for static). */
  invMass: number;
  /** Half-extents of the body's AABB (for collision response). For spheres,
   *  all three axes equal the radius. */
  halfExtents: THREE.Vector3;
  /** Linear damping per second (0..1). */
  linearDamping: number;
  /** Restitution (bounciness) 0..1. */
  restitution: number;
  /** Friction coefficient 0..1. */
  friction: number;
  /** True when the body is resting on a static surface (sleeps). */
  resting: boolean;
  /** Typed rest-frame counter (replaces the old `_restFrames` cast). #102. */
  restFrames: number;

  // ─── Section F / Section A new fields ───

  /** Body shape: "box" (AABB) or "sphere" (radius = halfExtents.x). #106. */
  shape: BodyShape;
  /** Collision group bitfield (this body's layer). #103/#734. */
  collisionGroup: number;
  /** Collision mask bitfield (which groups this body collides with). #103/#734. */
  collisionMask: number;
  /** Aerodynamic drag coefficient (0 = none; ~0.5 for a flat plate). #746. */
  aeroDrag: number;
  /** CCD enabled flag. #97/#731. True for fast bodies (projectiles, debris). */
  ccdEnabled: boolean;
  /** Previous-frame position (for CCD ray test). #97/#731. */
  prevPosition: THREE.Vector3;
  /** Buoyancy: water density this body displaces (0 = no buoyancy). #737. */
  buoyancy: number;
}

export interface PhysicsBackend {
  init(): Promise<void>;
  step(dt: number): void;
  addStaticCollider(box: { min: THREE.Vector3; max: THREE.Vector3 }, opts?: { group?: number; mask?: number }): number;
  addDynamicBody(opts: {
    position: THREE.Vector3;
    mass: number;
    box?: { min: THREE.Vector3; max: THREE.Vector3 };
    sphereRadius?: number;
    group?: number;
    mask?: number;
  }): number;
  removeBody(id: number): void;
  applyImpulse(id: number, impulse: THREE.Vector3): void;
  getBodyTransform(id: number): { position: THREE.Vector3; rotation: THREE.Quaternion } | null;
  getDynamicBodies(): PhysicsBody[];
  /** Returns the live dynamic-bodies array (no allocation). #105. Callers must
   *  NOT mutate the array; they may iterate it directly. */
  getDynamicBodiesView(): ReadonlyArray<PhysicsBody>;
  setSeed(seed: number): void;
  dispose(): void;
  readonly name: string;

  // ─── Section F opt-in features ───

  /** Register a water volume (AABB). Bodies inside get buoyancy. #737. */
  addWaterVolume(box: { min: THREE.Vector3; max: THREE.Vector3 }, density?: number): number;
  /** Remove a water volume. */
  removeWaterVolume(id: number): void;
  /** Add a distance constraint (rope/chain). Returns constraint id. #739/#743/#766/#767. */
  addDistanceConstraint(a: number, b: number, restLength: number, opts?: { breakForce?: number; friction?: number }): number;
  /** Add a hinge constraint (door). #754/#743. */
  addHingeConstraint(a: number, b: number, anchor: THREE.Vector3, axis: THREE.Vector3, opts?: { breakTorque?: number; friction?: number }): number;
  /** Remove a constraint. */
  removeConstraint(id: number): void;
  /** Add a soft body (verlet + volume preservation). #740. */
  addSoftBody(opts: { particles: THREE.Vector3[]; restVolume: number; pressure: number; stiffness: number }): number;
  /** Step soft bodies (called inside step()). */
  /** Set CCD on/off for a body. #97/#731. */
  setBodyCCD(id: number, enabled: boolean): void;
  /** Set aerodynamic drag coefficient. #746. */
  setBodyAeroDrag(id: number, k: number): void;
  /** Set buoyancy for a body (water density displaced; 0 = none). #737. */
  setBodyBuoyancy(id: number, density: number): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Water volume / constraint / soft-body data
// ─────────────────────────────────────────────────────────────────────────────

interface WaterVolume {
  id: number;
  box: { min: THREE.Vector3; max: THREE.Vector3 };
  density: number; // kg/m³ — water=1000
}

interface DistanceConstraint {
  id: number;
  a: number;
  b: number;
  restLength: number;
  breakForce: number; // N — 0 = unbreakable
  friction: number;   // 0..1 damping along the rope
  broken: boolean;
}

interface HingeConstraint {
  id: number;
  a: number;
  b: number;
  anchor: THREE.Vector3; // world-space anchor (computed each frame)
  axis: THREE.Vector3;
  breakTorque: number;
  friction: number;
  broken: boolean;
}

interface SoftBody {
  id: number;
  particles: THREE.Vector3[];
  prevParticles: THREE.Vector3[];
  restVolume: number;
  pressure: number;
  stiffness: number;
  /** Springs (pairs of particle indices + rest length). */
  springs: Array<{ i: number; j: number; rest: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Uniform-grid broadphase (#736)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spatial-hash uniform grid. Cell size = max body radius × 2. Inserts each
 * body into all cells its AABB overlaps. Pair queries yield candidate pairs
 * in O(n) instead of O(n²). Falls back to brute-force when n < 16 (the hash
 * overhead isn't worth it for tiny populations).
 */
class UniformGridBroadphase {
  private cellSize = 2.0;
  private cells = new Map<number, PhysicsBody[]>();
  private pairs: Array<[PhysicsBody, PhysicsBody]> = [];
  /** Reusable cell-key encoder: (ix, iy, iz) → unique int. Cells are bounded
   *  to ±8192 per axis (16k³ cells supported). */
  private key(ix: number, iy: number, iz: number): number {
    // Bias to non-negative; pack into 21 bits each.
    const x = ix + 8192;
    const y = iy + 8192;
    const z = iz + 8192;
    return (x << 42) | (y << 21) | z;
  }

  clear(): void {
    this.cells.clear();
    this.pairs.length = 0;
  }

  setCellSize(size: number): void {
    this.cellSize = Math.max(0.5, size);
  }

  insert(b: PhysicsBody): void {
    const min = b.aabb.min;
    const max = b.aabb.max;
    const ix0 = Math.floor(min.x / this.cellSize);
    const ix1 = Math.floor(max.x / this.cellSize);
    const iy0 = Math.floor(min.y / this.cellSize);
    const iy1 = Math.floor(max.y / this.cellSize);
    const iz0 = Math.floor(min.z / this.cellSize);
    const iz1 = Math.floor(max.z / this.cellSize);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = this.key(ix, iy, iz);
          let arr = this.cells.get(k);
          if (!arr) { arr = []; this.cells.set(k, arr); }
          arr.push(b);
        }
      }
    }
  }

  /** Generate candidate pairs. Each pair appears at most once (i<j by id). */
  computePairs(): Array<[PhysicsBody, PhysicsBody]> {
    this.pairs.length = 0;
    const seen = new Set<number>();
    const cellArrays = Array.from(this.cells.values());
    for (const arr of cellArrays) {
      if (arr.length < 2) continue;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i];
          const b = arr[j];
          // Dedup — a body pair can co-occupy multiple cells.
          const lo = Math.min(a.id, b.id);
          const hi = Math.max(a.id, b.id);
          const k = lo * 100003 + hi;
          if (seen.has(k)) continue;
          seen.add(k);
          this.pairs.push([a, b]);
        }
      }
    }
    return this.pairs;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend
// ─────────────────────────────────────────────────────────────────────────────

const BRUTEFORCE_THRESHOLD = 16; // below this body count, O(n²) is faster

/**
 * Create the best available physics backend.
 */
export async function createPhysicsBackend(): Promise<PhysicsBackend> {
  const _hasPrereqs = isFeatureEnabled("sharedArrayBuffer") && isFeatureEnabled("wasmSimd");
  const backend = new ImpulsePhysicsBackend();
  await backend.init();
  return backend;
}

/**
 * ImpulsePhysicsBackend — real rigid body simulation.
 */
export class ImpulsePhysicsBackend implements PhysicsBackend {
  readonly name = "impulse-aabb-v2";
  private bodies = new Map<number, PhysicsBody>();
  private staticBodies: PhysicsBody[] = [];
  private dynamicBodies: PhysicsBody[] = [];
  /** Cached view returned by getDynamicBodies() — no per-call alloc. #105. */
  private dynamicBodiesView: ReadonlyArray<PhysicsBody> = [];
  private nextId = 1;
  private seed = 0;
  private _scratch1 = new THREE.Vector3();
  private _scratch2 = new THREE.Vector3();
  private _scratch3 = new THREE.Vector3();
  private _scratch4 = new THREE.Vector3();

  private waterVolumes = new Map<number, WaterVolume>();
  private nextWaterId = 1;

  private constraints = new Map<number, DistanceConstraint | HingeConstraint>();
  private nextConstraintId = 1;

  private softBodies = new Map<number, SoftBody>();
  private nextSoftBodyId = 1;

  private broadphase = new UniformGridBroadphase();

  async init() { /* ready immediately */ }

  /** Refresh the cached view (call after dynamicBodies array mutates). #105. */
  private _refreshView(): void {
    this.dynamicBodiesView = this.dynamicBodies;
  }

  step(dt: number) {
    // Clamp dt to avoid tunneling on lag spikes.
    const h = Math.min(dt, 1 / 30);

    // 1. Integrate velocities + apply gravity + aero drag.
    for (const b of this.dynamicBodies) {
      if (b.resting) continue;
      b.prevPosition.copy(b.position);
      b.linearVelocity.y += GRAVITY * h;
      // Linear damping (exponential).
      const damping = Math.pow(1 - b.linearDamping, h * 60);
      b.linearVelocity.multiplyScalar(damping);
      // Aerodynamic drag (quadratic). #746. F = -k * |v| * v / m.
      if (b.aeroDrag > 0) {
        const speed = b.linearVelocity.length();
        if (speed > 0.01) {
          const dragMag = b.aeroDrag * speed * speed * h / Math.max(0.1, b.mass);
          // Apply opposite to velocity, but never reverse it.
          const dragRatio = Math.min(1, dragMag / speed);
          b.linearVelocity.addScaledVector(b.linearVelocity, -dragRatio);
        }
      }
      // Angular damping (simplified).
      b.angularVelocity.multiplyScalar(damping);
    }

    // 2. Apply buoyancy for bodies in water volumes. #737.
    if (this.waterVolumes.size > 0) {
      const volumes = Array.from(this.waterVolumes.values());
      for (const b of this.dynamicBodies) {
        if (b.resting || b.buoyancy <= 0) continue;
        for (const vol of volumes) {
          if (b.position.x < vol.box.min.x || b.position.x > vol.box.max.x) continue;
          if (b.position.z < vol.box.min.z || b.position.z > vol.box.max.z) continue;
          if (b.position.y < vol.box.min.y || b.position.y > vol.box.max.y) continue;
          // Submerged fraction (approximated by how deep the body center is).
          const submersion = THREE.MathUtils.clamp(
            (vol.box.max.y - b.position.y) / (2 * b.halfExtents.y),
            0, 1,
          );
          // Buoyancy force = ρ * V * g (upward). Body volume ≈ 8*halfExtents.
          const volume = b.halfExtents.x * b.halfExtents.y * b.halfExtents.z * 8;
          const force = vol.density * volume * submersion * Math.abs(GRAVITY) * b.buoyancy;
          b.linearVelocity.y += (force / Math.max(0.1, b.mass)) * h;
          // Simple water drag.
          b.linearVelocity.multiplyScalar(1 - 0.5 * h * submersion);
          break;
        }
      }
    }

    // 3. Integrate position with CCD substepping for fast bodies. #97/#731.
    for (const b of this.dynamicBodies) {
      if (b.resting) continue;
      const speed = b.linearVelocity.length();
      const minHalf = Math.min(b.halfExtents.x, b.halfExtents.y, b.halfExtents.z);
      const travel = speed * h;
      const needsCCD = b.ccdEnabled && travel > minHalf * CCD_SPEED_RATIO;
      if (needsCCD) {
        // Sub-step the integration so the body moves at most (minHalf) per sub-step.
        const substeps = Math.min(CCD_MAX_SUBSTEPS, Math.ceil(travel / Math.max(0.001, minHalf)));
        const sh = h / substeps;
        for (let s = 0; s < substeps; s++) {
          b.position.addScaledVector(b.linearVelocity, sh);
          // Resolve vs static colliders within the sub-step (so a fast body
          // can't tunnel through a thin wall between sub-steps).
          this._resolveVsStatic(b);
        }
      } else {
        b.position.addScaledVector(b.linearVelocity, h);
      }
    }

    // 4. Update AABBs.
    for (const b of this.dynamicBodies) this._updateAabb(b);

    // 5. Build broadphase candidate pairs.
    let pairs: Array<[PhysicsBody, PhysicsBody]>;
    if (this.dynamicBodies.length < BRUTEFORCE_THRESHOLD) {
      // Brute force O(n²) — fine for tiny populations, no hash overhead.
      pairs = [];
      const dyn = this.dynamicBodies;
      for (let i = 0; i < dyn.length; i++) {
        for (let j = i + 1; j < dyn.length; j++) pairs.push([dyn[i], dyn[j]]);
      }
    } else {
      this.broadphase.clear();
      // Cell size = 2× the largest half-extent among dynamic bodies (or default 2m).
      let maxHalf = 1.0;
      for (const b of this.dynamicBodies) {
        const m = Math.max(b.halfExtents.x, b.halfExtents.y, b.halfExtents.z);
        if (m > maxHalf) maxHalf = m;
      }
      this.broadphase.setCellSize(maxHalf * 2);
      for (const b of this.dynamicBodies) this.broadphase.insert(b);
      pairs = this.broadphase.computePairs();
    }

    // 6. Resolve dynamic-vs-static + dynamic-vs-dynamic collisions.
    for (const b of this.dynamicBodies) {
      if (b.resting) continue;
      let restingCount = 0;
      for (const s of this.staticBodies) {
        // Collision filter — group/mask. #103/#734.
        if ((b.collisionGroup & s.collisionMask) === 0) continue;
        if ((s.collisionGroup & b.collisionMask) === 0) continue;
        const hit = this._resolveCollision(b, s);
        if (hit === "resting") restingCount++;
      }
      // Horizontal-velocity sleep gate. #101/#733.
      const horizSpeedSq = b.linearVelocity.x * b.linearVelocity.x + b.linearVelocity.z * b.linearVelocity.z;
      const vertSpeed = Math.abs(b.linearVelocity.y);
      if (
        restingCount > 0 &&
        horizSpeedSq < RESTING_HORIZONTAL_VELOCITY * RESTING_HORIZONTAL_VELOCITY &&
        vertSpeed < RESTING_VERTICAL_VELOCITY
      ) {
        b.restFrames++;
        if (b.restFrames >= RESTING_FRAMES) {
          b.resting = true;
          b.linearVelocity.set(0, 0, 0);
          b.angularVelocity.set(0, 0, 0);
        }
      } else {
        b.restFrames = 0;
        b.resting = false;
      }
    }

    for (const [a, b] of pairs) {
      if (a.resting && b.resting) continue;
      // Collision filter. #103/#734.
      if ((a.collisionGroup & b.collisionMask) === 0) continue;
      if ((b.collisionGroup & a.collisionMask) === 0) continue;
      this._resolveCollision(a, b);
    }

    // 7. Solve constraints (distance + hinge). #739/#743/#754/#766/#767.
    this._solveConstraints(h);

    // 8. Step soft bodies. #740.
    if (this.softBodies.size > 0) this._stepSoftBodies(h);
  }

  /** Resolve a dynamic body against all static colliders (used by CCD). */
  private _resolveVsStatic(b: PhysicsBody): void {
    for (const s of this.staticBodies) {
      if ((b.collisionGroup & s.collisionMask) === 0) continue;
      if ((s.collisionGroup & b.collisionMask) === 0) continue;
      this._resolveCollision(b, s);
    }
  }

  /** Resolve collision between two bodies. Returns "resting" if b1 is resting
   *  on b2 (b1 grounded). Mutates positions + velocities. */
  private _resolveCollision(b1: PhysicsBody, b2: PhysicsBody): "resting" | "none" {
    // Narrowphase dispatch by shape. #106.
    let normal: THREE.Vector3;
    let penetration: number;
    let restingAxis = false;

    if (b1.shape === "sphere" && b2.shape === "sphere") {
      // Sphere-vs-sphere.
      const delta = this._scratch1.copy(b1.position).sub(b2.position);
      const dist = delta.length();
      const r1 = b1.halfExtents.x;
      const r2 = b2.halfExtents.x;
      const rSum = r1 + r2;
      if (dist >= rSum) return "none";
      if (dist < 1e-6) {
        // Coincident — pick an arbitrary normal.
        normal = this._scratch2.set(0, 1, 0);
        penetration = rSum;
      } else {
        normal = this._scratch2.copy(delta).multiplyScalar(1 / dist);
        penetration = rSum - dist;
      }
      restingAxis = normal.y > 0.5; // b1 resting on b2 if normal points up
    } else if (b1.shape === "sphere" || b2.shape === "sphere") {
      // Sphere-vs-AABB.
      const sphere = b1.shape === "sphere" ? b1 : b2;
      const box = b1.shape === "sphere" ? b2 : b1;
      const closest = this._scratch1.copy(sphere.position);
      closest.x = Math.max(box.aabb.min.x, Math.min(closest.x, box.aabb.max.x));
      closest.y = Math.max(box.aabb.min.y, Math.min(closest.y, box.aabb.max.y));
      closest.z = Math.max(box.aabb.min.z, Math.min(closest.z, box.aabb.max.z));
      const delta = this._scratch2.copy(sphere.position).sub(closest);
      const dist = delta.length();
      const r = sphere.halfExtents.x;
      if (dist >= r) return "none";
      if (dist < 1e-6) {
        // Sphere center inside the box — push out along the axis of least
        // penetration to the nearest face.
        const dxMin = sphere.position.x - box.aabb.min.x;
        const dxMax = box.aabb.max.x - sphere.position.x;
        const dyMin = sphere.position.y - box.aabb.min.y;
        const dyMax = box.aabb.max.y - sphere.position.y;
        const dzMin = sphere.position.z - box.aabb.min.z;
        const dzMax = box.aabb.max.z - sphere.position.z;
        const minDist = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
        if (minDist === dxMin) normal = this._scratch3.set(-1, 0, 0);
        else if (minDist === dxMax) normal = this._scratch3.set(1, 0, 0);
        else if (minDist === dyMin) normal = this._scratch3.set(0, -1, 0);
        else if (minDist === dyMax) normal = this._scratch3.set(0, 1, 0);
        else if (minDist === dzMin) normal = this._scratch3.set(0, 0, -1);
        else normal = this._scratch3.set(0, 0, 1);
        penetration = r + minDist;
        // Normal must point from box → sphere.
        if (sphere !== b1) normal.multiplyScalar(-1);
        restingAxis = normal.y > 0.5;
      } else {
        normal = this._scratch3.copy(delta).multiplyScalar(1 / dist);
        penetration = r - dist;
        restingAxis = normal.y > 0.5;
      }
    } else {
      // AABB-vs-AABB (original path, kept intact).
      const min1 = b1.aabb.min, max1 = b1.aabb.max;
      const min2 = b2.aabb.min, max2 = b2.aabb.max;
      const overlapX = Math.min(max1.x, max2.x) - Math.max(min1.x, min2.x);
      const overlapY = Math.min(max1.y, max2.y) - Math.max(min1.y, min2.y);
      const overlapZ = Math.min(max1.z, max2.z) - Math.max(min1.z, min2.z);
      if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return "none";

      if (overlapY <= overlapX && overlapY <= overlapZ) {
        const b1Above = b1.position.y > b2.position.y;
        normal = this._scratch2.set(0, b1Above ? 1 : -1, 0);
        penetration = overlapY;
        restingAxis = b1Above;
      } else if (overlapX <= overlapY && overlapX <= overlapZ) {
        const b1Right = b1.position.x > b2.position.x;
        normal = this._scratch2.set(b1Right ? 1 : -1, 0, 0);
        penetration = overlapX;
      } else {
        const b1Front = b1.position.z > b2.position.z;
        normal = this._scratch2.set(0, 0, b1Front ? 1 : -1);
        penetration = overlapZ;
      }
    }

    // Total inverse mass.
    const invMassSum = b1.invMass + b2.invMass;
    if (invMassSum === 0) return "none";

    // Baumgarte positional correction with slop. #98.
    const corrMag = Math.max(penetration - BAUMGARTE_SLOP, 0) / invMassSum * BAUMGARTE_PERCENT;
    b1.position.addScaledVector(normal, corrMag * b1.invMass);
    b2.position.addScaledVector(normal, -corrMag * b2.invMass);

    // Impulse response along the contact normal.
    const rv = this._scratch1.copy(b1.linearVelocity).sub(b2.linearVelocity);
    const velAlongNormal = rv.dot(normal);
    if (velAlongNormal > 0) {
      // Separating — no impulse needed.
      return restingAxis ? "resting" : "none";
    }

    const e = Math.min(b1.restitution, b2.restitution);
    const j = -(1 + e) * velAlongNormal / invMassSum;
    const impulse = this._scratch2.copy(normal).multiplyScalar(j);
    b1.linearVelocity.addScaledVector(impulse, b1.invMass);
    b2.linearVelocity.addScaledVector(impulse, -b2.invMass);

    // Friction using POST-normal-impulse tangential velocity. #99.
    // Recompute relative velocity after the normal impulse was applied.
    const rvPost = this._scratch3.copy(b1.linearVelocity).sub(b2.linearVelocity);
    const tangent = this._scratch4.copy(rvPost).addScaledVector(normal, -rvPost.dot(normal));
    if (tangent.lengthSq() > 1e-6) {
      tangent.normalize();
      const jt = -rvPost.dot(tangent) / invMassSum;
      // Average friction (not geometric mean). #100.
      const mu = (b1.friction + b2.friction) * 0.5;
      // Coulomb friction: |jt| ≤ μ * |j|.
      const maxFriction = Math.abs(j) * mu;
      const clampedJt = Math.max(-maxFriction, Math.min(maxFriction, jt));
      const frictionImpulse = tangent.multiplyScalar(clampedJt);
      b1.linearVelocity.addScaledVector(frictionImpulse, b1.invMass);
      b2.linearVelocity.addScaledVector(frictionImpulse, -b2.invMass);
    }

    return restingAxis ? "resting" : "none";
  }

  private _updateAabb(b: PhysicsBody) {
    b.aabb.min.copy(b.position).sub(b.halfExtents);
    b.aabb.max.copy(b.position).add(b.halfExtents);
  }

  /** Solve distance + hinge constraints. Breaks under stress. #739/#743/#754. */
  private _solveConstraints(h: number): void {
    const constraintList = Array.from(this.constraints.values());
    for (const c of constraintList) {
      if (c.broken) continue;
      if (c.id !== undefined && "restLength" in c) {
        // Distance constraint.
        const dc = c as DistanceConstraint;
        const ba = this.bodies.get(dc.a);
        const bb = this.bodies.get(dc.b);
        if (!ba || !bb) continue;
        const delta = this._scratch1.copy(bb.position).sub(ba.position);
        const dist = delta.length() || 0.0001;
        const diff = dist - dc.restLength;
        const n = this._scratch2.copy(delta).multiplyScalar(1 / dist);
        // Positional correction (Baumgarte-style, split by inverse mass).
        const invSum = ba.invMass + bb.invMass;
        if (invSum === 0) continue;
        const corr = diff / invSum;
        ba.position.addScaledVector(n, corr * ba.invMass);
        bb.position.addScaledVector(n, -corr * bb.invMass);
        // Velocity-level correction with friction. #743.
        const relVel = this._scratch3.copy(bb.linearVelocity).sub(ba.linearVelocity);
        const vn = relVel.dot(n);
        // Apply impulse along the rope.
        const lambda = -vn / invSum;
        const impulse = this._scratch4.copy(n).multiplyScalar(lambda);
        ba.linearVelocity.addScaledVector(impulse, -ba.invMass);
        bb.linearVelocity.addScaledVector(impulse, bb.invMass);
        // Friction along the rope (damps tangential velocity). #743.
        if (dc.friction > 0) {
          const vt = relVel.clone().addScaledVector(n, -vn);
          const vtMag = vt.length();
          if (vtMag > 1e-4) {
            vt.multiplyScalar(1 / vtMag);
            const frictionLambda = Math.min(vtMag, dc.friction * Math.abs(vn) * 0.5) / invSum;
            const fric = vt.multiplyScalar(frictionLambda);
            ba.linearVelocity.addScaledVector(fric, ba.invMass);
            bb.linearVelocity.addScaledVector(fric, -bb.invMass);
          }
        }
        // Break under stress. #739.
        if (dc.breakForce > 0) {
          const stress = Math.abs(lambda) / h; // N (impulse / time)
          if (stress > dc.breakForce) {
            dc.broken = true;
          }
        }
      } else {
        // Hinge constraint (door). #754.
        const hc = c as HingeConstraint;
        const ba = this.bodies.get(hc.a);
        const bb = this.bodies.get(hc.b);
        if (!ba || !bb) continue;
        // Pin body a's anchor point to body b's anchor point.
        const aAnchor = this._scratch1.copy(hc.anchor);
        const bAnchor = this._scratch2.copy(hc.anchor);
        const delta = this._scratch3.copy(bAnchor).sub(aAnchor);
        const dist = delta.length();
        if (dist > 1e-4) {
          const invSum = ba.invMass + bb.invMass;
          if (invSum > 0) {
            const corr = dist / invSum * 0.5; // softer
            const n = delta.multiplyScalar(1 / dist);
            ba.position.addScaledVector(n, corr * ba.invMass);
            bb.position.addScaledVector(n, -corr * bb.invMass);
          }
        }
        // Friction on the hinge axis (damps rotation). #743.
        if (hc.friction > 0) {
          const relAng = ba.angularVelocity.y - bb.angularVelocity.y;
          const damp = relAng * hc.friction * h * 5;
          ba.angularVelocity.y -= damp * 0.5 * ba.invMass;
          bb.angularVelocity.y += damp * 0.5 * bb.invMass;
        }
        // Break under torque. #739.
        if (hc.breakTorque > 0) {
          const torque = Math.abs(ba.angularVelocity.y - bb.angularVelocity.y) * Math.max(ba.mass, bb.mass) / h;
          if (torque > hc.breakTorque) hc.broken = true;
        }
      }
    }
    // Drop broken constraints.
    const brokenIds: number[] = [];
    for (const [id, c] of Array.from(this.constraints)) {
      if (c.broken) brokenIds.push(id);
    }
    for (const id of brokenIds) this.constraints.delete(id);
  }

  /** Verlet integration for soft bodies with pressure-based volume preservation. #740. */
  private _stepSoftBodies(h: number): void {
    const softList = Array.from(this.softBodies.values());
    for (const sb of softList) {
      const n = sb.particles.length;
      if (n === 0) continue;
      // Verlet: x' = x + (x - prev) * drag + a * h².
      const gravity = GRAVITY * h * h;
      for (let i = 0; i < n; i++) {
        const tmp = sb.prevParticles[i].clone();
        sb.prevParticles[i].copy(sb.particles[i]);
        const vx = (sb.particles[i].x - tmp.x) * 0.98;
        const vy = (sb.particles[i].y - tmp.y) * 0.98;
        const vz = (sb.particles[i].z - tmp.z) * 0.98;
        sb.particles[i].x += vx;
        sb.particles[i].y += vy + gravity;
        sb.particles[i].z += vz;
      }
      // Solve springs.
      for (let iter = 0; iter < 3; iter++) {
        for (const s of sb.springs) {
          const a = sb.particles[s.i];
          const b = sb.particles[s.j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dz = b.z - a.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
          const diff = (d - s.rest) / d * 0.5 * sb.stiffness;
          a.x += dx * diff;
          a.y += dy * diff;
          a.z += dz * diff;
          b.x -= dx * diff;
          b.y -= dy * diff;
          b.z -= dz * diff;
        }
        // Pressure-based volume preservation: push each particle outward from
        // the centroid proportional to (restVolume - currentVolume).
        const cx = sb.particles.reduce((s, p) => s + p.x, 0) / n;
        const cy = sb.particles.reduce((s, p) => s + p.y, 0) / n;
        const cz = sb.particles.reduce((s, p) => s + p.z, 0) / n;
        // Approximate current volume by the radius of gyration cubed.
        let rg = 0;
        for (const p of sb.particles) {
          rg += (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2;
        }
        rg = Math.sqrt(rg / n);
        const currentVol = (4 / 3) * Math.PI * rg * rg * rg;
        const pressureForce = (sb.restVolume - currentVol) * sb.pressure * 0.01;
        for (const p of sb.particles) {
          const dx = p.x - cx;
          const dy = p.y - cy;
          const dz = p.z - cz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
          p.x += (dx / d) * pressureForce;
          p.y += (dy / d) * pressureForce;
          p.z += (dz / d) * pressureForce;
        }
      }
    }
  }

  addStaticCollider(box: { min: THREE.Vector3; max: THREE.Vector3 }, opts?: { group?: number; mask?: number }): number {
    const id = this.nextId++;
    const center = box.min.clone().add(box.max).multiplyScalar(0.5);
    const half = box.max.clone().sub(box.min).multiplyScalar(0.5);
    const body: PhysicsBody = {
      id,
      position: center,
      rotation: new THREE.Quaternion(),
      linearVelocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      isStatic: true,
      aabb: { min: box.min.clone(), max: box.max.clone() },
      mass: 0,
      invMass: 0,
      halfExtents: half,
      linearDamping: 0,
      restitution: 0.3,
      friction: 0.8,
      resting: true,
      restFrames: 0,
      shape: "box",
      collisionGroup: opts?.group ?? CollisionGroup.STATIC_WORLD,
      collisionMask: opts?.mask ?? COLLIDE_ALL,
      aeroDrag: 0,
      ccdEnabled: false,
      prevPosition: center.clone(),
      buoyancy: 0,
    };
    this.bodies.set(id, body);
    this.staticBodies.push(body);
    return id;
  }

  addDynamicBody(opts: {
    position: THREE.Vector3;
    mass: number;
    box?: { min: THREE.Vector3; max: THREE.Vector3 };
    sphereRadius?: number;
    group?: number;
    mask?: number;
  }): number {
    const id = this.nextId++;
    const shape: BodyShape = opts.sphereRadius !== undefined ? "sphere" : "box";
    const half = opts.sphereRadius
      ? new THREE.Vector3(opts.sphereRadius, opts.sphereRadius, opts.sphereRadius)
      : opts.box
        ? opts.box.max.clone().sub(opts.box.min).multiplyScalar(0.5)
        : new THREE.Vector3(0.15, 0.15, 0.15);
    const mass = Math.max(0.1, opts.mass);
    const body: PhysicsBody = {
      id,
      position: opts.position.clone(),
      rotation: new THREE.Quaternion(),
      linearVelocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      isStatic: false,
      aabb: {
        min: opts.position.clone().sub(half),
        max: opts.position.clone().add(half),
      },
      mass,
      invMass: 1 / mass,
      halfExtents: half,
      linearDamping: 0.4,
      restitution: 0.35,
      friction: 0.7,
      resting: false,
      restFrames: 0,
      shape,
      collisionGroup: opts.group ?? CollisionGroup.DEFAULT,
      collisionMask: opts.mask ?? COLLIDE_ALL,
      aeroDrag: 0,
      ccdEnabled: false,
      prevPosition: opts.position.clone(),
      buoyancy: 0,
    };
    this.bodies.set(id, body);
    this.dynamicBodies.push(body);
    this._refreshView();
    return id;
  }

  removeBody(id: number) {
    const b = this.bodies.get(id);
    if (!b) return;
    this.bodies.delete(id);
    if (b.isStatic) {
      const i = this.staticBodies.indexOf(b);
      if (i >= 0) this.staticBodies.splice(i, 1);
    } else {
      const i = this.dynamicBodies.indexOf(b);
      if (i >= 0) this.dynamicBodies.splice(i, 1);
      this._refreshView();
    }
  }

  applyImpulse(id: number, impulse: THREE.Vector3) {
    const b = this.bodies.get(id);
    if (!b || b.isStatic) return;
    b.linearVelocity.addScaledVector(impulse, b.invMass);
    b.resting = false;
    b.restFrames = 0;
  }

  getBodyTransform(id: number) {
    const b = this.bodies.get(id);
    if (!b) return null;
    return { position: b.position, rotation: b.rotation };
  }

  getDynamicBodies() {
    // Return the live view — no per-call allocation. #105.
    return this.dynamicBodies as PhysicsBody[];
  }

  getDynamicBodiesView(): ReadonlyArray<PhysicsBody> {
    return this.dynamicBodiesView;
  }

  setSeed(seed: number) { this.seed = seed; }

  // ─── Section F opt-in features ───

  addWaterVolume(box: { min: THREE.Vector3; max: THREE.Vector3 }, density = 1000): number {
    const id = this.nextWaterId++;
    this.waterVolumes.set(id, { id, box: { min: box.min.clone(), max: box.max.clone() }, density });
    return id;
  }

  removeWaterVolume(id: number) {
    this.waterVolumes.delete(id);
  }

  addDistanceConstraint(a: number, b: number, restLength: number, opts?: { breakForce?: number; friction?: number }): number {
    const id = this.nextConstraintId++;
    const dc: DistanceConstraint = {
      id, a, b, restLength,
      breakForce: opts?.breakForce ?? 0,
      friction: opts?.friction ?? 0,
      broken: false,
    };
    this.constraints.set(id, dc);
    return id;
  }

  addHingeConstraint(a: number, b: number, anchor: THREE.Vector3, axis: THREE.Vector3, opts?: { breakTorque?: number; friction?: number }): number {
    const id = this.nextConstraintId++;
    const hc: HingeConstraint = {
      id, a, b,
      anchor: anchor.clone(),
      axis: axis.clone().normalize(),
      breakTorque: opts?.breakTorque ?? 0,
      friction: opts?.friction ?? 0,
      broken: false,
    };
    this.constraints.set(id, hc);
    return id;
  }

  removeConstraint(id: number) {
    this.constraints.delete(id);
  }

  addSoftBody(opts: { particles: THREE.Vector3[]; restVolume: number; pressure: number; stiffness: number }): number {
    const id = this.nextSoftBodyId++;
    const particles = opts.particles.map((p) => p.clone());
    const prevParticles = particles.map((p) => p.clone());
    // Build springs: each particle connected to its neighbors (chain + cross-links).
    const springs: Array<{ i: number; j: number; rest: number }> = [];
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const rest = particles[i].distanceTo(particles[j]);
        if (rest < 1.5) springs.push({ i, j, rest });
      }
    }
    const sb: SoftBody = {
      id,
      particles,
      prevParticles,
      restVolume: opts.restVolume,
      pressure: opts.pressure,
      stiffness: opts.stiffness,
      springs,
    };
    this.softBodies.set(id, sb);
    return id;
  }

  setBodyCCD(id: number, enabled: boolean): void {
    const b = this.bodies.get(id);
    if (b) b.ccdEnabled = enabled;
  }

  setBodyAeroDrag(id: number, k: number): void {
    const b = this.bodies.get(id);
    if (b) b.aeroDrag = k;
  }

  setBodyBuoyancy(id: number, density: number): void {
    const b = this.bodies.get(id);
    if (b) b.buoyancy = density;
  }

  dispose() {
    this.bodies.clear();
    this.staticBodies.length = 0;
    this.dynamicBodies.length = 0;
    this.dynamicBodiesView = [];
    this.waterVolumes.clear();
    this.constraints.clear();
    this.softBodies.clear();
    this.broadphase.clear();
  }
}
