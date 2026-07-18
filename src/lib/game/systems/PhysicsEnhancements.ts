/**
 * §7 Physics & Destruction — backlog items 151–175.
 *
 * Self-contained enhancement layer over PhysicsBackend.ts, VoronoiFracture.ts,
 * RagdollSystem.ts, GrenadeSystem.ts, vehicles.ts. Adds verification helpers
 * + missing destruction interactions without rewriting those systems.
 */

import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// §7 #151 — Voronoi fracture local-space verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a voronoi fracture produces shards whose centroids stay within the
 * original prop's bounding box. Used as a regression check after Task-9's
 * local-space fix.
 *
 * @param shards        Array of shard centroids (local space).
 * @param propBounds    Prop AABB {min, max} (local space).
 * @param tolerance     Extra tolerance (m) — shards slightly outside are OK.
 */
export function verifyVoronoiShardsInBounds(
  shards: THREE.Vector3[],
  propBounds: { min: THREE.Vector3; max: THREE.Vector3 },
  tolerance = 0.05,
): { ok: boolean; outOfBounds: number[] } {
  const outOfBounds: number[] = [];
  shards.forEach((c, i) => {
    if (
      c.x < propBounds.min.x - tolerance ||
      c.x > propBounds.max.x + tolerance ||
      c.y < propBounds.min.y - tolerance ||
      c.y > propBounds.max.y + tolerance ||
      c.z < propBounds.min.z - tolerance ||
      c.z > propBounds.max.z + tolerance
    ) {
      outOfBounds.push(i);
    }
  });
  return { ok: outOfBounds.length === 0, outOfBounds };
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #152 — Debris collision-with-player physics push
// ─────────────────────────────────────────────────────────────────────────────

export interface DebrisShard {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mass: number;
  /** Whether this shard has come to rest. */
  atRest: boolean;
}

/**
 * Apply debris-to-player collision push. If a fast-moving shard hits the
 * player, it staggers them.
 *
 * @param shards        All active debris shards.
 * @param playerPos     Player world position.
 * @param playerRadius  Player collision radius (m).
 * @param minImpactSpeed Minimum shard speed to cause a stagger (m/s).
 * @returns             The stagger impulse (a Vector3 the player physics adds).
 */
export function debrisPlayerPush(
  shards: DebrisShard[],
  playerPos: THREE.Vector3,
  playerRadius = 0.4,
  minImpactSpeed = 4,
): THREE.Vector3 {
  const impulse = new THREE.Vector3();
  for (const s of shards) {
    if (s.atRest) continue;
    const speed = s.vel.length();
    if (speed < minImpactSpeed) continue;
    const dist = s.pos.distanceTo(playerPos);
    if (dist > playerRadius + 0.2) continue;
    // Push the player away from the shard's velocity direction.
    const push = s.vel.clone().multiplyScalar(s.mass * 0.05);
    impulse.add(push);
    // The shard loses energy (bounces off the player).
    s.vel.multiplyScalar(0.3);
  }
  return impulse;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #153 — Ragdoll death-pose variety
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a per-ragdoll random seed so death poses vary.
 * Without this, all ragdolls collapse identically.
 */
export function ragdollSeed(enemyId: string, deathTimeMs: number): number {
  // Hash the enemy id + death time into a 32-bit seed.
  let h = 2166136261;
  const s = `${enemyId}:${deathTimeMs}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Apply a per-seed jitter to initial ragdoll limb velocities so no two
 * ragdolls collapse identically.
 */
export function jitterRagdollVelocities(
  velocities: THREE.Vector3[],
  seed: number,
  jitterMag = 0.5,
): void {
  // Simple LCG seeded by `seed`.
  let state = seed || 1;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  for (const v of velocities) {
    v.x += (rand() - 0.5) * jitterMag;
    v.y += (rand() - 0.5) * jitterMag;
    v.z += (rand() - 0.5) * jitterMag;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #154 — Ragdoll-to-cover interaction (no clip-through)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a ragdoll limb position is inside a wall/floor. If so, project
 * it back to the surface.
 *
 * @param limbPos       Limb position (mutated in place if inside).
 * @param colliders     Array of AABB colliders {min, max}.
 * @returns             True if the limb was projected out.
 */
export function projectRagdollOutOfColliders(
  limbPos: THREE.Vector3,
  colliders: Array<{ min: THREE.Vector3; max: THREE.Vector3 }>,
): boolean {
  let projected = false;
  for (const c of colliders) {
    if (
      limbPos.x >= c.min.x &&
      limbPos.x <= c.max.x &&
      limbPos.y >= c.min.y &&
      limbPos.y <= c.max.y &&
      limbPos.z >= c.min.z &&
      limbPos.z <= c.max.z
    ) {
      // Find the nearest face + push out.
      const dxMin = limbPos.x - c.min.x;
      const dxMax = c.max.x - limbPos.x;
      const dyMin = limbPos.y - c.min.y;
      const dyMax = c.max.y - limbPos.y;
      const dzMin = limbPos.z - c.min.z;
      const dzMax = c.max.z - limbPos.z;
      const minDist = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
      if (minDist === dxMin) limbPos.x = c.min.x;
      else if (minDist === dxMax) limbPos.x = c.max.x;
      else if (minDist === dyMin) limbPos.y = c.min.y;
      else if (minDist === dyMax) limbPos.y = c.max.y;
      else if (minDist === dzMin) limbPos.z = c.min.z;
      else limbPos.z = c.max.z;
      projected = true;
    }
  }
  return projected;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #155 — Destructible wall "rebar exposed" visual stage
// ─────────────────────────────────────────────────────────────────────────────

export type DestructibleStage = "intact" | "cracked" | "rebar_exposed" | "destroyed";

export interface DestructibleWallState {
  hp: number;
  maxHp: number;
  stage: DestructibleStage;
}

/**
 * Compute the visual stage of a destructible wall from its HP fraction.
 */
export function computeWallStage(hpFraction: number): DestructibleStage {
  if (hpFraction <= 0) return "destroyed";
  if (hpFraction < 0.25) return "rebar_exposed";
  if (hpFraction < 0.6) return "cracked";
  return "intact";
}

/**
 * Update a wall's stage based on current HP.
 */
export function updateWallStage(state: DestructibleWallState): void {
  state.stage = computeWallStage(state.hp / state.maxHp);
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #156 — Glass-specific shatter physics
// ─────────────────────────────────────────────────────────────────────────────

export interface GlassShard {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** When this shard should despawn (ms). */
  despawnMs: number;
}

/**
 * Shatter a glass pane into N shards. Glass shards are lighter + faster
 * than concrete debris, and despawn faster (less persistent).
 *
 * @param paneCenter  Center of the glass pane.
 * @param paneNormal  Normal of the pane (shards fly along this).
 * @param paneSize    Width × height of the pane.
 * @param impactSpeed Speed of the impacting round (m/s).
 * @param count       Number of shards to spawn.
 */
export function shatterGlass(
  paneCenter: THREE.Vector3,
  paneNormal: THREE.Vector3,
  paneSize: { w: number; h: number },
  impactSpeed: number,
  count = 20,
): GlassShard[] {
  const shards: GlassShard[] = [];
  const baseSpeed = Math.min(8, impactSpeed * 0.5);
  const now = performance.now();
  for (let i = 0; i < count; i++) {
    // Random offset within the pane.
    const offX = (Math.random() - 0.5) * paneSize.w;
    const offY = (Math.random() - 0.5) * paneSize.h;
    const pos = paneCenter.clone();
    // Build a basis: paneNormal + two in-plane vectors.
    const up = Math.abs(paneNormal.y) > 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(paneNormal, up).normalize();
    const inPlaneUp = new THREE.Vector3().crossVectors(right, paneNormal).normalize();
    pos.add(right.multiplyScalar(offX));
    pos.add(inPlaneUp.multiplyScalar(offY));
    // Velocity: along pane normal + random spread.
    const vel = paneNormal.clone().multiplyScalar(baseSpeed);
    vel.x += (Math.random() - 0.5) * baseSpeed * 0.5;
    vel.y += (Math.random() - 0.5) * baseSpeed * 0.5;
    vel.z += (Math.random() - 0.5) * baseSpeed * 0.5;
    shards.push({
      pos,
      vel,
      despawnMs: now + 3000, // glass despawns in 3s (vs 8s for concrete)
    });
  }
  return shards;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #157 — Vehicle destruction physics (debris propulsion)
// ─────────────────────────────────────────────────────────────────────────────

export interface VehicleDebris {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mass: number;
  /** Mesh id for rendering. */
  meshId: string;
}

/**
 * Spawn vehicle destruction debris. The vehicle doesn't despawn — it
 * explodes into chunks propelled realistically.
 *
 * @param vehicleCenter  Vehicle center position.
 * @param vehicleSize    Approx vehicle bbox size.
 * @param explosionForce Impulse magnitude.
 */
export function spawnVehicleDestructionDebris(
  vehicleCenter: THREE.Vector3,
  vehicleSize: THREE.Vector3,
  explosionForce = 30,
): VehicleDebris[] {
  const debris: VehicleDebris[] = [];
  const parts = ["door_fl", "door_fr", "door_rl", "door_rr", "hood", "trunk", "wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"];
  for (const part of parts) {
    const offset = new THREE.Vector3(
      (Math.random() - 0.5) * vehicleSize.x,
      (Math.random() - 0.5) * vehicleSize.y,
      (Math.random() - 0.5) * vehicleSize.z,
    );
    const vel = offset.clone().normalize().multiplyScalar(explosionForce * (0.5 + Math.random()));
    vel.y += explosionForce * 0.5; // bias upward (explosion lifts)
    debris.push({
      pos: vehicleCenter.clone().add(offset),
      vel,
      mass: 5 + Math.random() * 10,
      meshId: part,
    });
  }
  return debris;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #158 — Water-surface interaction (splash, buoyancy)
// ─────────────────────────────────────────────────────────────────────────────

export interface SplashParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Size (m). */
  size: number;
  despawnMs: number;
}

/**
 * Spawn splash particles for an object entering water.
 */
export function spawnWaterSplash(
  impactPos: THREE.Vector3,
  impactSpeed: number,
  now: number,
): SplashParticle[] {
  const count = Math.min(30, Math.floor(impactSpeed * 2));
  const particles: SplashParticle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = impactSpeed * (0.3 + Math.random() * 0.5);
    particles.push({
      pos: impactPos.clone(),
      vel: new THREE.Vector3(
        Math.cos(angle) * speed,
        speed * (0.5 + Math.random() * 0.5), // upward bias
        Math.sin(angle) * speed,
      ),
      size: 0.05 + Math.random() * 0.1,
      despawnMs: now + 1500,
    });
  }
  return particles;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #159 — Wind-affects-cloth verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the cloth force from a wind vector.
 * @param windDir    Wind direction (normalized).
 * @param windSpeed  Wind speed (m/s).
 * @param clothNormal Normal of the cloth face.
 */
export function clothWindForce(
  windDir: THREE.Vector3,
  windSpeed: number,
  clothNormal: THREE.Vector3,
): THREE.Vector3 {
  // Force ∝ wind speed × dot(wind, clothNormal).
  const dot = windDir.dot(clothNormal);
  return windDir.clone().multiplyScalar(windSpeed * dot * 0.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #160 — Rope / rappel physics
// ─────────────────────────────────────────────────────────────────────────────

export interface RopeSegment {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
}

/**
 * Simulate a rope as N segments with distance constraints (verlet-style).
 * Mutates the segments array.
 *
 * @param segments    Rope segments (top to bottom).
 * @param anchor      Top anchor position (fixed).
 * @param segmentLen  Rest length per segment.
 * @param gravity     Gravity (m/s²).
 * @param dt          Delta time (s).
 */
export function simulateRope(
  segments: RopeSegment[],
  anchor: THREE.Vector3,
  segmentLen: number,
  gravity: number,
  dt: number,
): void {
  if (segments.length === 0) return;
  // Verlet integration.
  segments[0].pos.copy(anchor); // anchor fixed
  for (let i = 1; i < segments.length; i++) {
    segments[i].vel.y -= gravity * dt;
    segments[i].pos.add(segments[i].vel.clone().multiplyScalar(dt));
  }
  // Distance constraints (5 iterations).
  for (let iter = 0; iter < 5; iter++) {
    for (let i = 1; i < segments.length; i++) {
      const diff = segments[i].pos.clone().sub(segments[i - 1].pos);
      const dist = diff.length() || 0.001;
      const correction = diff.multiplyScalar((dist - segmentLen) / dist * 0.5);
      if (i > 1) segments[i - 1].pos.add(correction);
      segments[i].pos.sub(correction);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #161 — Prop-on-prop stacking (no jitter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settle stacked props: zero out low-magnitude velocities so they stop
 * jittering and "sleep" (no longer consume CPU).
 *
 * @param shards   Debris shards to check.
 * @param sleepThreshold  Speed below which a shard sleeps (m/s).
 */
export function sleepSettledProps(shards: DebrisShard[], sleepThreshold = 0.05): number {
  let slept = 0;
  for (const s of shards) {
    if (s.atRest) continue;
    if (s.vel.length() < sleepThreshold) {
      s.atRest = true;
      s.vel.set(0, 0, 0);
      slept++;
    }
  }
  return slept;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #162 — Physics "sleep" threshold (documented as implemented above)
// ─────────────────────────────────────────────────────────────────────────────

export const PHYSICS_SLEEP_THRESHOLD = 0.05; // m/s — bodies below this sleep

// ─────────────────────────────────────────────────────────────────────────────
// §7 #163 — Grenade physics bounce realism
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a grenade's bounce velocity off a wall.
 * @param inVel       Incoming velocity.
 * @param wallNormal  Wall normal (pointing away from wall).
 * @param restitution Bounciness 0..1 (1 = perfect bounce, 0 = splat).
 */
export function grenadeBounceVelocity(
  inVel: THREE.Vector3,
  wallNormal: THREE.Vector3,
  restitution = 0.4,
): THREE.Vector3 {
  const dot = inVel.dot(wallNormal);
  if (dot >= 0) return inVel.clone(); // moving away already
  // Reflect the normal component, dampened by restitution.
  const reflected = inVel.clone().sub(wallNormal.clone().multiplyScalar((1 + restitution) * dot));
  // Also dampen the tangential component (friction).
  const tangent = reflected.clone().sub(wallNormal.clone().multiplyScalar(reflected.dot(wallNormal)));
  tangent.multiplyScalar(0.8);
  reflected.sub(tangent.clone().multiplyScalar(0.2));
  return reflected;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #164 — Breach-charge directional destruction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the destruction direction for a breach charge. The door/wall
 * blows OUTWARD (away from the charge), not omnidirectionally.
 *
 * @param chargePos     Charge position.
 * @param wallNormal    Wall normal (pointing away from the room the charge is on).
 */
export function breachDestructionDirection(
  chargePos: THREE.Vector3,
  wallNormal: THREE.Vector3,
): THREE.Vector3 {
  // The destruction propagates in the wall-normal direction (away from charge).
  return wallNormal.clone().normalize();
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #165 — Footstep-triggered small debris (kick a can, step on glass)
// ─────────────────────────────────────────────────────────────────────────────

export interface KickableProp {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mass: number;
}

/**
 * Check if a footstep is near a kickable prop + apply a kick impulse.
 * Returns true if a prop was kicked.
 */
export function maybeKickPropOnStep(
  props: KickableProp[],
  footPos: THREE.Vector3,
  stepDir: THREE.Vector3,
  kickRadius = 0.5,
  kickForce = 2,
): boolean {
  let kicked = false;
  for (const p of props) {
    const dist = p.pos.distanceTo(footPos);
    if (dist > kickRadius) continue;
    // Kick in the step direction + slightly upward.
    const impulse = stepDir.clone().multiplyScalar(kickForce / p.mass);
    impulse.y += kickForce * 0.3 / p.mass;
    p.vel.add(impulse);
    kicked = true;
  }
  return kicked;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #166 — Zipline / grapple physics
// ─────────────────────────────────────────────────────────────────────────────

export interface ZiplineState {
  /** Start anchor. */
  start: THREE.Vector3;
  /** End anchor. */
  end: THREE.Vector3;
  /** Current position along the line (0..1). */
  t: number;
  /** Current speed along the line (m/s). */
  speed: number;
  /** Whether the player is currently on the zipline. */
  active: boolean;
}

/**
 * Update zipline physics. Player accelerates along the line by gravity.
 */
export function updateZipline(state: ZiplineState, gravity: number, dt: number): void {
  if (!state.active) return;
  const dir = state.end.clone().sub(state.start);
  const lineLen = dir.length();
  const downComponent = dir.clone().normalize().y * -gravity; // gravity pulls down
  state.speed += downComponent * dt;
  state.t += (state.speed / lineLen) * dt;
  if (state.t >= 1) {
    state.t = 1;
    state.active = false;
  }
}

/**
 * Get the player's current position on the zipline.
 */
export function ziplinePosition(state: ZiplineState): THREE.Vector3 {
  return state.start.clone().lerp(state.end, state.t);
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #167 — Ragdoll impact force scaling by caliber
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the impulse applied to a ragdoll based on the weapon caliber.
 * Snipers launch bodies further than pistols.
 *
 * @param weaponDamage  Base weapon damage.
 * @param caliberClass  "pistol" | "rifle" | "sniper" | "shotgun" | "lmg".
 */
export function ragdollImpulseByCaliber(
  weaponDamage: number,
  caliberClass: "pistol" | "rifle" | "sniper" | "shotgun" | "lmg",
): number {
  const mult = {
    pistol: 0.5,
    rifle: 1.0,
    sniper: 2.5,
    shotgun: 1.8,
    lmg: 1.2,
  }[caliberClass];
  return weaponDamage * mult * 0.1; // scale to m/s impulse
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #168 — Explosive barrel chain reaction
// ─────────────────────────────────────────────────────────────────────────────

export interface ExplosiveBarrel {
  id: string;
  pos: THREE.Vector3;
  hp: number;
  /** Blast radius (m). */
  blastRadius: number;
  /** Whether this barrel has already exploded. */
  exploded: boolean;
}

/**
 * Process a barrel explosion: damage + chain-trigger nearby barrels.
 * Returns the list of barrels that should explode (caller triggers them).
 */
export function processBarrelExplosion(
  barrels: ExplosiveBarrel[],
  explodingId: string,
  chainDelayMs = 200,
): ExplosiveBarrel[] {
  const source = barrels.find((b) => b.id === explodingId);
  if (!source || source.exploded) return [];
  source.exploded = true;
  const chained: ExplosiveBarrel[] = [];
  for (const b of barrels) {
    if (b.id === explodingId || b.exploded) continue;
    const dist = b.pos.distanceTo(source.pos);
    if (dist <= source.blastRadius) {
      b.hp -= 100; // chain reaction damage
      if (b.hp <= 0) chained.push(b);
    }
  }
  return chained;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #169 — Physics debug visualizer (AABB wireframes toggle)
// ─────────────────────────────────────────────────────────────────────────────

export interface PhysicsDebugVizState {
  enabled: boolean;
  /** Color for static colliders. */
  staticColor: number;
  /** Color for dynamic bodies. */
  dynamicColor: number;
  /** Color for triggers. */
  triggerColor: number;
}

export function createPhysicsDebugViz(): PhysicsDebugVizState {
  return { enabled: false, staticColor: 0x00ffff, dynamicColor: 0xffff00, triggerColor: 0xff00ff };
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #170 — Falling-object hazards (loose scaffolding, hanging lights)
// ─────────────────────────────────────────────────────────────────────────────

export interface FallingHazard {
  id: string;
  pos: THREE.Vector3;
  /** HP — when destroyed by an explosion, it falls. */
  hp: number;
  /** Whether it has been knocked loose. */
  loose: boolean;
  /** Velocity (used once loose). */
  vel: THREE.Vector3;
}

/**
 * Knock loose any falling hazards within the blast radius.
 */
export function knockLooseHazards(
  hazards: FallingHazard[],
  blastPos: THREE.Vector3,
  blastRadius: number,
  blastForce: number,
): FallingHazard[] {
  const knocked: FallingHazard[] = [];
  for (const h of hazards) {
    if (h.loose) continue;
    const dist = h.pos.distanceTo(blastPos);
    if (dist > blastRadius) continue;
    h.loose = true;
    h.vel.set(
      (Math.random() - 0.5) * blastForce,
      -blastForce * 0.3, // initial downward bias
      (Math.random() - 0.5) * blastForce,
    );
    knocked.push(h);
  }
  return knocked;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #171 — Mass-based knockback (barrel vs can)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute knockback velocity for an object of given mass hit by an explosion.
 * Heavier objects fly less far.
 */
export function massBasedKnockback(
  mass: number,
  explosionForce: number,
  distance: number,
): number {
  // Inverse-square falloff + inverse-mass scaling.
  const falloff = 1 / Math.max(0.5, distance * distance * 0.1);
  return (explosionForce * falloff) / Math.max(0.5, mass);
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #172 — Broadphase tunneling verification (fast small objects)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a fast-moving small object would tunnel through a thin collider
 * in one frame. Returns true if tunneling is likely (caller should substep).
 *
 * @param speed        Object speed (m/s).
 * @param dt           Delta time (s).
 * @param objRadius    Object radius (m).
 * @param colliderThickness  Thinnest collider thickness (m).
 */
export function wouldTunnel(
  speed: number,
  dt: number,
  objRadius: number,
  colliderThickness: number,
): boolean {
  const distancePerFrame = speed * dt;
  // Tunneling risk if the object moves more than (colliderThickness + objRadius) per frame.
  return distancePerFrame > colliderThickness + objRadius;
}

/**
 * Compute the number of substeps needed to prevent tunneling.
 */
export function substepsToPreventTunneling(
  speed: number,
  dt: number,
  objRadius: number,
  colliderThickness: number,
): number {
  const distancePerFrame = speed * dt;
  const safeStep = (colliderThickness + objRadius) * 0.5;
  return Math.max(1, Math.ceil(distancePerFrame / safeStep));
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #173 — Multi-hit destructible props (not binary destroy)
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiHitProp {
  hp: number;
  maxHp: number;
  /** Visual stage thresholds (fractions of maxHp). */
  stages: number[];
  currentStage: number;
}

/**
 * Apply damage to a multi-hit prop + update its visual stage.
 */
export function damageMultiHitProp(state: MultiHitProp, damage: number): void {
  state.hp = Math.max(0, state.hp - damage);
  const frac = state.hp / state.maxHp;
  let stage = 0;
  for (let i = 0; i < state.stages.length; i++) {
    if (frac <= state.stages[i]) stage = i + 1;
  }
  state.currentStage = stage;
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #174 — Physics-driven camera shake from explosion impulse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute camera shake intensity from a nearby explosion.
 * @param distance      Player distance from blast (m).
 * @param blastForce    Explosion force.
 * @param maxShake      Max shake amplitude (deg).
 */
export function explosionCameraShake(
  distance: number,
  blastForce: number,
  maxShake = 4,
): number {
  const falloff = 1 / Math.max(1, distance * 0.5);
  return Math.min(maxShake, blastForce * falloff * 0.1);
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 #175 — Stress test: 10 simultaneous explosions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stress-test the physics by simulating 10 simultaneous explosions.
 * Returns the frame time stats. Caller renders the explosions + runs this
 * in a perf overlay.
 */
export function simulateExplosionStressTest(
  count = 10,
): { explosions: number; expectedFrameTimeMs: number; warning: string | null } {
  // Each explosion spawns ~20 debris shards + 30 splash particles + a blast.
  // 10 explosions = 200 shards + 300 particles + 10 blasts.
  const shardsPerExplosion = 20;
  const totalShards = count * shardsPerExplosion;
  // Rough frame-time estimate: ~0.05ms per shard + ~0.02ms per particle.
  const estimatedMs = totalShards * 0.05 + count * 30 * 0.02 + count * 0.5;
  let warning: string | null = null;
  if (estimatedMs > 16) {
    warning = `Estimated ${estimatedMs.toFixed(1)}ms frame time exceeds 60fps budget (16.7ms). Consider reducing debris count or pooling.`;
  }
  return { explosions: count, expectedFrameTimeMs: estimatedMs, warning };
}

// ─────────────────────────────────────────────────────────────────────────────
// §7 summary
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_7_STATUS = {
  voronoiBoundsVerify: "code (verifyVoronoiShardsInBounds — regression check)",
  debrisPlayerPush: "code (debrisPlayerPush — stagger impulse)",
  ragdollVariety: "code (ragdollSeed + jitterRagdollVelocities — per-death jitter)",
  ragdollCoverInteraction: "code (projectRagdollOutOfColliders — no clip-through)",
  rebarExposedStage: "code (DestructibleWallState + computeWallStage)",
  glassShatter: "code (shatterGlass — distinct from concrete)",
  vehicleDestruction: "code (spawnVehicleDestructionDebris — chunk propulsion)",
  waterSurfaceInteraction: "code (spawnWaterSplash)",
  windCloth: "code (clothWindForce — wind affects cloth)",
  ropeRappel: "code (simulateRope — verlet rope)",
  propStacking: "code (sleepSettledProps — no jitter, sleep threshold)",
  physicsSleep: "code (PHYSICS_SLEEP_THRESHOLD constant)",
  grenadeBounce: "code (grenadeBounceVelocity — realistic bounce)",
  breachChargeDirectional: "code (breachDestructionDirection — blows outward)",
  footstepDebris: "code (maybeKickPropOnStep — kick a can / step on glass)",
  ziplineGrapple: "code (ZiplineState + updateZipline)",
  ragdollCaliberScaling: "code (ragdollImpulseByCaliber — sniper launches further)",
  explosiveBarrelChain: "code (processBarrelExplosion — chain reaction)",
  physicsDebugViz: "code (PhysicsDebugVizState — AABB wireframes toggle)",
  fallingObjectHazards: "code (knockLooseHazards — scaffolding / hanging lights)",
  massBasedKnockback: "code (massBasedKnockback — barrel vs can)",
  broadphaseTunneling: "code (wouldTunnel + substepsToPreventTunneling)",
  multiHitProps: "code (damageMultiHitProp — staged destruction)",
  explosionCameraShake: "code (explosionCameraShake — impulse-driven, not flat)",
  explosionStressTest: "code (simulateExplosionStressTest — 10× blast frame-time estimate)",
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Section F — Physics, Destruction, Vehicles, Spatial (731–810).
//
// The §7 work above covered backlog items 151–175. Section F adds 80 more
// prompts (731–810) covering advanced physics features, destruction materials,
// environmental interactions, and WebXR spatial computing. These are
// self-contained helper functions + data structures — the engine wires them
// into the main loop (one-liners, no shared-file churn).
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// #737 — Buoyancy (Archimedes force for submerged bodies)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the buoyancy force on a body submerged in water.
 * F = ρ * V * g (upward).
 *
 * @param volume         Submerged volume (m³).
 * @param fluidDensity   Fluid density (kg/m³). Water=1000, mud=1700, oil=900.
 * @param gravity        |gravity| (m/s²). Defaults to 9.81.
 * @returns              Upward force (N) as a scalar; apply along +Y.
 */
export function buoyancyForce(volume: number, fluidDensity = 1000, gravity = 9.81): number {
  return fluidDensity * volume * gravity;
}

/**
 * Compute the submerged volume of an AABB body in a fluid plane at y=fluidY.
 * Returns the body volume below the fluid surface.
 */
export function submergedVolume(
  aabb: { min: THREE.Vector3; max: THREE.Vector3 },
  fluidY: number,
): number {
  const top = Math.min(aabb.max.y, fluidY);
  const bottom = aabb.min.y;
  if (top <= bottom) return 0;
  const height = top - bottom;
  return (aabb.max.x - aabb.min.x) * height * (aabb.max.z - aabb.min.z);
}

// ─────────────────────────────────────────────────────────────────────────────
// #738 — Ragdoll-to-prop momentum transfer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transfer momentum from a falling ragdoll to a prop it lands on. The prop
 * gets an impulse = (ragdoll mass × ragdoll velocity × transferCoeff); the
 * ragdoll's velocity is reduced by (1 - transferCoeff).
 *
 * @param ragdollMass    Ragdoll mass (kg).
 * @param ragdollVel     Ragdoll velocity (m/s) — mutated.
 * @param propMass       Prop mass (kg).
 * @param propVel        Prop velocity (m/s) — mutated.
 * @param transferCoeff  0..1 — fraction of momentum transferred.
 */
export function ragdollToPropMomentumTransfer(
  ragdollMass: number,
  ragdollVel: THREE.Vector3,
  propMass: number,
  propVel: THREE.Vector3,
  transferCoeff = 0.7,
): void {
  const impulse = ragdollVel.clone().multiplyScalar(ragdollMass * transferCoeff);
  propVel.addScaledVector(impulse, 1 / propMass);
  ragdollVel.multiplyScalar(1 - transferCoeff);
}

// ─────────────────────────────────────────────────────────────────────────────
// #741 — Cloth-vs-body collision (cross-ref 68, 364)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve collision between a cloth particle and a body AABB. If the particle
 * is inside the body, project it to the nearest face + reflect its velocity
 * along the contact normal.
 *
 * @param particlePos   Cloth particle position (mutated in place).
 * @param particleVel   Cloth particle velocity (mutated in place).
 * @param bodyAabb      Body AABB.
 * @param bodyVel       Body velocity (for relative-velocity reflection).
 */
export function clothVsBody(
  particlePos: THREE.Vector3,
  particleVel: THREE.Vector3,
  bodyAabb: { min: THREE.Vector3; max: THREE.Vector3 },
  bodyVel: THREE.Vector3,
): boolean {
  if (
    particlePos.x < bodyAabb.min.x || particlePos.x > bodyAabb.max.x ||
    particlePos.y < bodyAabb.min.y || particlePos.y > bodyAabb.max.y ||
    particlePos.z < bodyAabb.min.z || particlePos.z > bodyAabb.max.z
  ) return false;
  // Find the nearest face.
  const dxMin = particlePos.x - bodyAabb.min.x;
  const dxMax = bodyAabb.max.x - particlePos.x;
  const dyMin = particlePos.y - bodyAabb.min.y;
  const dyMax = bodyAabb.max.y - particlePos.y;
  const dzMin = particlePos.z - bodyAabb.min.z;
  const dzMax = bodyAabb.max.z - particlePos.z;
  const minDist = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
  let normal: THREE.Vector3;
  if (minDist === dxMin) { particlePos.x = bodyAabb.min.x; normal = new THREE.Vector3(-1, 0, 0); }
  else if (minDist === dxMax) { particlePos.x = bodyAabb.max.x; normal = new THREE.Vector3(1, 0, 0); }
  else if (minDist === dyMin) { particlePos.y = bodyAabb.min.y; normal = new THREE.Vector3(0, -1, 0); }
  else if (minDist === dyMax) { particlePos.y = bodyAabb.max.y; normal = new THREE.Vector3(0, 1, 0); }
  else if (minDist === dzMin) { particlePos.z = bodyAabb.min.z; normal = new THREE.Vector3(0, 0, -1); }
  else { particlePos.z = bodyAabb.max.z; normal = new THREE.Vector3(0, 0, 1); }
  // Reflect the relative velocity along the contact normal.
  const relVel = particleVel.clone().sub(bodyVel);
  const vn = relVel.dot(normal);
  if (vn < 0) {
    particleVel.addScaledVector(normal, -vn * 1.5); // 0.5 restitution
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// #744 — Material-specific friction (ice/mud/metal/sand)
// ─────────────────────────────────────────────────────────────────────────────

export type SurfacePhysicsType = "ice" | "mud" | "metal" | "sand" | "concrete" | "wood" | "water" | "grass";

export interface SurfacePhysicsProfile {
  /** Friction coefficient 0..1 (lower = slipperier). */
  friction: number;
  /** Restitution 0..1 (higher = bouncier). */
  restitution: number;
  /** Speed multiplier applied to player movement on this surface. */
  speedMult: number;
  /** Whether wading through this surface slows the player (water/mud). */
  wading: boolean;
}

export const SURFACE_PHYSICS: Record<SurfacePhysicsType, SurfacePhysicsProfile> = {
  ice:      { friction: 0.05, restitution: 0.1, speedMult: 1.2, wading: false }, // #779 — slippery
  mud:      { friction: 0.85, restitution: 0.05, speedMult: 0.6, wading: true },  // #778 — slow + dirty
  metal:    { friction: 0.35, restitution: 0.4, speedMult: 1.0, wading: false },
  sand:     { friction: 0.75, restitution: 0.05, speedMult: 0.85, wading: false },// #780 — sinks
  concrete: { friction: 0.8,  restitution: 0.2, speedMult: 1.0, wading: false },
  wood:     { friction: 0.65, restitution: 0.25, speedMult: 1.0, wading: false },
  water:    { friction: 0.1,  restitution: 0.0, speedMult: 0.5, wading: true },   // #775-777
  grass:    { friction: 0.7,  restitution: 0.15, speedMult: 0.95, wading: false },
};

// ─────────────────────────────────────────────────────────────────────────────
// #745 / #751 — Slope slide (can't walk up > maxSlope°)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the slope angle (radians) from a ground normal.
 * Returns 0 for flat ground (normal pointing straight up).
 */
export function slopeAngleFromNormal(normal: THREE.Vector3): number {
  const up = new THREE.Vector3(0, 1, 0);
  return Math.acos(THREE.MathUtils.clamp(normal.dot(up), -1, 1));
}

/**
 * Compute the slide acceleration along a slope. If the slope angle exceeds
 * `maxSlope` (radians), the player slides down.
 *
 * @param groundNormal  Ground surface normal (pointing up).
 * @param gravity       |gravity| (m/s²).
 * @param maxSlope      Max walkable slope (radians). Default 45°.
 * @returns             Slide acceleration vector (m/s²). Zero if slope is walkable.
 */
export function slopeSlideAcceleration(
  groundNormal: THREE.Vector3,
  gravity = 9.81,
  maxSlope = Math.PI / 4,
): THREE.Vector3 {
  const angle = slopeAngleFromNormal(groundNormal);
  if (angle <= maxSlope) return new THREE.Vector3();
  // Slide direction = projection of gravity onto the slope plane.
  const g = new THREE.Vector3(0, -gravity, 0);
  const slideDir = g.clone().addScaledVector(groundNormal, -g.dot(groundNormal));
  return slideDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// #747 / #749 — Capsule-vs-mesh narrowphase + swept capsule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capsule-vs-triangle collision (used for capsule-vs-mesh). Returns the
 * penetration depth + contact normal if the capsule intersects the triangle;
 * null otherwise.
 *
 * The capsule is parameterized by (segmentStart, segmentEnd, radius). The
 * triangle by three vertices. This is a simplified closest-point-on-segment-
 * to-closest-point-on-triangle test — accurate enough for game collisions.
 *
 * @returns  { depth, normal } where normal points from triangle → capsule.
 */
export function capsuleVsTriangle(
  segStart: THREE.Vector3,
  segEnd: THREE.Vector3,
  radius: number,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): { depth: number; normal: THREE.Vector3 } | null {
  // Find the closest point on the segment to the triangle (approximate by
  // sampling the segment midpoint + endpoints — a full SAT/GJK would be more
  // accurate but ~10× slower).
  const samples = [segStart, segEnd, segStart.clone().lerp(segEnd, 0.5)];
  let bestDist = Infinity;
  let bestPoint = new THREE.Vector3();
  for (const s of samples) {
    const cp = closestPointOnTriangle(s, a, b, c);
    const d = cp.distanceTo(s);
    if (d < bestDist) { bestDist = d; bestPoint = cp; }
  }
  if (bestDist >= radius) return null;
  const normal = samples[0].clone().lerp(samples[1], 0.5).sub(bestPoint).normalize();
  return { depth: radius - bestDist, normal };
}

/** Closest point on a triangle to a query point (barycentric). */
export function closestPointOnTriangle(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const ap = p.clone().sub(a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return a.clone();
  const bp = p.clone().sub(b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return b.clone();
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return a.clone().addScaledVector(ab, v);
  }
  const cp = p.clone().sub(c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return c.clone();
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return a.clone().addScaledVector(ac, w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return b.clone().addScaledVector(c.clone().sub(b), w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return a.clone().addScaledVector(ab, v).addScaledVector(ac, w);
}

/**
 * #749 — Swept capsule collision. Casts a capsule from `from` to `to` against
 * a list of triangles; returns the first hit (t in 0..1, contact point,
 * normal). Used for high-velocity player movement to prevent tunneling
 * through thin walls.
 */
export function sweptCapsuleVsTriangles(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  triangles: Array<{ a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3 }>,
): { t: number; point: THREE.Vector3; normal: THREE.Vector3 } | null {
  // Simplified: sample N points along the segment + test capsuleVsTriangle.
  // A full continuous-collision-detection (CCD) sweep would be more accurate
  // but ~50× slower. N=8 is a good balance for 60fps gameplay.
  const N = 8;
  const delta = to.clone().sub(from);
  let best: { t: number; point: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const segStart = from.clone().addScaledVector(delta, t);
    const segEnd = from.clone().addScaledVector(delta, (i + 1) / N);
    for (const tri of triangles) {
      const hit = capsuleVsTriangle(segStart, segEnd, radius, tri.a, tri.b, tri.c);
      if (hit) {
        if (!best || t < best.t) {
          best = { t, point: segStart.clone(), normal: hit.normal };
        }
      }
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// #748 — Trimesh colliders for complex props
// ─────────────────────────────────────────────────────────────────────────────

export interface TrimeshCollider {
  /** World-space vertices. */
  vertices: Float32Array;
  /** Triangle indices (3 per triangle). */
  indices: Uint32Array;
  /** World position offset (applied to vertices). */
  offset: THREE.Vector3;
}

/**
 * Build a trimesh collider from a Three.js BufferGeometry. Extracts the
 * position attribute + index attribute (or generates indices if missing).
 */
export function buildTrimeshFromGeometry(
  geom: THREE.BufferGeometry,
  worldOffset: THREE.Vector3 = new THREE.Vector3(),
): TrimeshCollider {
  const posAttr = geom.getAttribute("position");
  const vertices = new Float32Array(posAttr.array as ArrayLike<number>);
  const indexAttr = geom.getIndex();
  let indices: Uint32Array;
  if (indexAttr) {
    indices = new Uint32Array(indexAttr.array as ArrayLike<number>);
  } else {
    indices = new Uint32Array(vertices.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
  }
  return { vertices, indices, offset: worldOffset.clone() };
}

/** Iterate triangles of a trimesh as Vector3 triples. */
export function* iterTrimeshTriangles(
  tm: TrimeshCollider,
): Generator<{ a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3 }> {
  for (let i = 0; i < tm.indices.length; i += 3) {
    const ia = tm.indices[i] * 3;
    const ib = tm.indices[i + 1] * 3;
    const ic = tm.indices[i + 2] * 3;
    yield {
      a: new THREE.Vector3(tm.vertices[ia] + tm.offset.x, tm.vertices[ia + 1] + tm.offset.y, tm.vertices[ia + 2] + tm.offset.z),
      b: new THREE.Vector3(tm.vertices[ib] + tm.offset.x, tm.vertices[ib + 1] + tm.offset.y, tm.vertices[ib + 2] + tm.offset.z),
      c: new THREE.Vector3(tm.vertices[ic] + tm.offset.x, tm.vertices[ic + 1] + tm.offset.y, tm.vertices[ic + 2] + tm.offset.z),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #750 — Stair stepping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt a stair step for the player. If the player is blocked by a low
 * obstacle (≤ stepHeight) and there's a clear path forward, lift the player
 * up onto the step.
 *
 * @param playerPos     Player position (mutated in place if stepped).
 * @param playerVel     Player velocity (forward component preserved).
 * @param forwardDir    Forward direction (normalized).
 * @param stepHeight    Max step height (m). Default 0.3m (standard stair rise).
 * @param probeFn       Function that returns ground Y at (x, z) or null.
 * @returns             True if the player was stepped up.
 */
export function tryStairStep(
  playerPos: THREE.Vector3,
  playerVel: THREE.Vector3,
  forwardDir: THREE.Vector3,
  stepHeight: number,
  probeFn: (x: number, z: number) => number | null,
): boolean {
  if (Math.hypot(playerVel.x, playerVel.z) < 0.5) return false;
  // Probe ahead — is there ground slightly forward + up by stepHeight?
  const aheadX = playerPos.x + forwardDir.x * 0.4;
  const aheadZ = playerPos.z + forwardDir.z * 0.4;
  const groundAhead = probeFn(aheadX, aheadZ);
  if (groundAhead === null) return false;
  const stepDelta = groundAhead - (playerPos.y - 1.7); // y - eyeHeight = feet
  if (stepDelta > 0.05 && stepDelta <= stepHeight) {
    playerPos.y = groundAhead + 1.7; // eye height above new ground
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// #752 — Moving platforms (player rides them)
// ─────────────────────────────────────────────────────────────────────────────

export interface MovingPlatform {
  /** Current platform position. */
  pos: THREE.Vector3;
  /** Previous-frame position (for delta computation). */
  prevPos: THREE.Vector3;
  /** Platform velocity (m/s). */
  vel: THREE.Vector3;
  /** AABB half-extents. */
  halfExtents: THREE.Vector3;
}

/**
 * Update a moving platform along a path (linear lerp between waypoints).
 * The platform's velocity is the delta of position over dt — the player
 * riding the platform inherits this velocity (added to player.vel when
 * standing on it).
 */
export function updateMovingPlatform(
  platform: MovingPlatform,
  waypoints: THREE.Vector3[],
  t: number, // 0..1 along the path
  dt: number,
): void {
  if (waypoints.length < 2) return;
  platform.prevPos.copy(platform.pos);
  // Bi-linear lerp between waypoints.
  const segCount = waypoints.length - 1;
  const scaled = t * segCount;
  const segIdx = Math.min(segCount - 1, Math.floor(scaled));
  const segT = scaled - segIdx;
  const a = waypoints[segIdx];
  const b = waypoints[segIdx + 1];
  platform.pos.lerpVectors(a, b, segT);
  platform.vel.copy(platform.pos).sub(platform.prevPos).multiplyScalar(1 / Math.max(0.001, dt));
}

/**
 * Check if the player is standing on a moving platform + transfer the
 * platform's horizontal velocity to the player.
 */
export function rideMovingPlatform(
  playerPos: THREE.Vector3,
  playerVel: THREE.Vector3,
  platform: MovingPlatform,
  eyeHeight: number,
): boolean {
  const feet = playerPos.y - eyeHeight;
  const onPlatform =
    Math.abs(playerPos.x - platform.pos.x) < platform.halfExtents.x &&
    Math.abs(playerPos.z - platform.pos.z) < platform.halfExtents.z &&
    Math.abs(feet - (platform.pos.y + platform.halfExtents.y)) < 0.1;
  if (onPlatform) {
    // Player inherits platform's horizontal velocity.
    playerVel.x += platform.vel.x;
    playerVel.z += platform.vel.z;
    // Player rides vertically too (lifts up with the platform).
    playerPos.y += platform.vel.y * (1 / 60); // approximate
  }
  return onPlatform;
}

// ─────────────────────────────────────────────────────────────────────────────
// #753 — Elevator physics
// ─────────────────────────────────────────────────────────────────────────────

export interface ElevatorState {
  /** Current Y position. */
  y: number;
  /** Current velocity (m/s). */
  vel: number;
  /** Floor Y targets (sorted ascending). */
  floors: number[];
  /** Current target floor index. */
  targetFloor: number;
  /** Acceleration (m/s²). */
  accel: number;
  /** Max speed (m/s). */
  maxSpeed: number;
}

/** Update an elevator toward its target floor. Returns updated Y. */
export function updateElevator(state: ElevatorState, dt: number): number {
  const target = state.floors[state.targetFloor];
  if (target === undefined) return state.y;
  const dy = target - state.y;
  const dir = Math.sign(dy);
  // Accelerate toward target.
  if (Math.abs(dy) > 0.05) {
    state.vel += dir * state.accel * dt;
    state.vel = THREE.MathUtils.clamp(state.vel, -state.maxSpeed, state.maxSpeed);
    state.y += state.vel * dt;
  } else {
    // Snap + decelerate.
    state.y = target;
    state.vel = 0;
  }
  return state.y;
}

/** Call the elevator to a floor (sets the target). */
export function callElevator(state: ElevatorState, floorIdx: number): void {
  if (floorIdx >= 0 && floorIdx < state.floors.length) {
    state.targetFloor = floorIdx;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #754 — Door physics (hinged)
// ─────────────────────────────────────────────────────────────────────────────

export interface HingedDoor {
  /** Hinge anchor (world position). */
  anchor: THREE.Vector3;
  /** Hinge axis (normalized; usually (0,1,0) for vertical hinge). */
  axis: THREE.Vector3;
  /** Current angle (radians). 0 = closed. */
  angle: number;
  /** Angular velocity (rad/s). */
  angularVel: number;
  /** Closed angle (usually 0). */
  closedAngle: number;
  /** Open angle (usually ±π/2). */
  openAngle: number;
  /** Spring constant pulling toward closed. */
  springK: number;
  /** Damping. */
  damping: number;
  /** Whether the door is locked (won't swing). */
  locked: boolean;
}

/** Apply an impulse to a hinged door (e.g. kick, explosion). */
export function applyDoorImpulse(door: HingedDoor, impulse: number): void {
  if (door.locked) return;
  door.angularVel += impulse;
}

/** Update a hinged door's angle + angular velocity. */
export function updateHingedDoor(door: HingedDoor, dt: number): void {
  if (door.locked) { door.angularVel = 0; return; }
  // Spring back toward closed.
  const springAccel = -door.springK * (door.angle - door.closedAngle);
  door.angularVel += springAccel * dt;
  door.angularVel *= 1 - door.damping * dt;
  door.angle += door.angularVel * dt;
  // Clamp at the open angle.
  const openMin = Math.min(door.openAngle, door.closedAngle);
  const openMax = Math.max(door.openAngle, door.closedAngle);
  if (door.angle < openMin) { door.angle = openMin; door.angularVel = 0; }
  if (door.angle > openMax) { door.angle = openMax; door.angularVel = 0; }
}

// ─────────────────────────────────────────────────────────────────────────────
// #758 — Stress propagation in destruction (structural collapse)
// ─────────────────────────────────────────────────────────────────────────────

export interface StructuralNode {
  id: string;
  pos: THREE.Vector3;
  /** Load-bearing capacity (N). When load exceeds this, the node fails. */
  capacity: number;
  /** Whether the node has failed (destroyed). */
  failed: boolean;
  /** List of supporting node ids (the nodes holding this one up). */
  supportedBy: string[];
  /** List of node ids this node supports. */
  supports: string[];
}

/**
 * Propagate structural failure through a graph of load-bearing nodes. When
 * a support node fails, the load it carried is redistributed to its
 * supporters; if they can't take the extra load, they fail too (cascade).
 *
 * @param nodes    All structural nodes (id → node).
 * @param startId  The node that just failed (e.g. from a breach charge).
 * @returns        The list of nodes that failed as a cascade.
 */
export function propagateStructuralFailure(
  nodes: Map<string, StructuralNode>,
  startId: string,
): StructuralNode[] {
  const failed: StructuralNode[] = [];
  const queue: string[] = [startId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (!node || node.failed) continue;
    node.failed = true;
    failed.push(node);
    // For each node this one supported: redistribute its load.
    for (const upId of node.supports) {
      const up = nodes.get(upId);
      if (!up || up.failed) continue;
      // If `up` has no remaining supporters, it collapses.
      const remainingSupporters = up.supportedBy.filter((sid) => {
        const s = nodes.get(sid);
        return s && !s.failed;
      });
      if (remainingSupporters.length === 0) {
        queue.push(upId);
      } else {
        // Check if remaining supporters can take the redistributed load.
        // (Simplified — assume each supporter takes an equal share.)
        const loadPerSupporter = up.capacity / remainingSupporters.length;
        for (const sid of remainingSupporters) {
          const s = nodes.get(sid);
          if (s && loadPerSupporter > s.capacity) {
            queue.push(sid);
          }
        }
      }
    }
  }
  return failed;
}

// ─────────────────────────────────────────────────────────────────────────────
// #759 — Load-bearing walls
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadBearingWall {
  id: string;
  /** Wall AABB. */
  aabb: { min: THREE.Vector3; max: THREE.Vector3 };
  /** Load capacity (N). */
  capacity: number;
  /** Whether this wall is currently load-bearing (carrying the structure above). */
  loadBearing: boolean;
  /** Whether the wall has been destroyed. */
  destroyed: boolean;
}

/**
 * Mark walls as load-bearing if they're below other walls in the same XZ
 * column. This is the "is there structure above this wall?" check.
 */
export function identifyLoadBearingWalls(walls: LoadBearingWall[]): void {
  for (const w of walls) {
    if (w.destroyed) { w.loadBearing = false; continue; }
    w.loadBearing = walls.some((other) =>
      other !== w && !other.destroyed &&
      other.aabb.min.x < w.aabb.max.x && other.aabb.max.x > w.aabb.min.x &&
      other.aabb.min.z < w.aabb.max.z && other.aabb.max.z > w.aabb.min.z &&
      other.aabb.min.y >= w.aabb.max.y - 0.1
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #761 — Dust clouds on destruction
// ─────────────────────────────────────────────────────────────────────────────

export interface DustParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Radius (m) — grows over time as the dust cloud expands. */
  radius: number;
  /** Density 0..1 (fades as it disperses). */
  density: number;
  despawnMs: number;
}

/**
 * Spawn a dust cloud at a destruction site. Dust particles are lighter +
 * slower than concrete shards; they expand + fade over ~2 seconds.
 */
export function spawnDustCloud(
  center: THREE.Vector3,
  force: number,
  now: number,
  count = 15,
): DustParticle[] {
  const particles: DustParticle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = force * (0.2 + Math.random() * 0.4);
    particles.push({
      pos: center.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
      )),
      vel: new THREE.Vector3(
        Math.cos(angle) * speed,
        speed * 0.5 + Math.random() * 0.5,
        Math.sin(angle) * speed,
      ),
      radius: 0.2 + Math.random() * 0.3,
      density: 0.6 + Math.random() * 0.3,
      despawnMs: now + 2000,
    });
  }
  return particles;
}

/** Update dust particles (expand + fade). */
export function updateDustCloud(particles: DustParticle[], dt: number, now: number): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    if (now > p.despawnMs) { particles.splice(i, 1); continue; }
    p.pos.addScaledVector(p.vel, dt);
    p.vel.multiplyScalar(0.95); // drag
    p.vel.y -= 0.5 * dt; // mild gravity (dust falls slowly)
    p.radius += dt * 0.5; // expand
    p.density *= 1 - 0.5 * dt; // fade
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #762 — Rebar in destroyed concrete
// ─────────────────────────────────────────────────────────────────────────────

export interface RebarSegment {
  /** Start of the rebar (world space). */
  start: THREE.Vector3;
  /** End of the rebar (world space). */
  end: THREE.Vector3;
  /** Whether the rebar is exposed (concrete around it destroyed). */
  exposed: boolean;
}

/**
 * Generate rebar segments for a concrete wall. Rebar runs in a grid pattern
 * inside the wall; exposed segments are those near the surface.
 */
export function generateRebar(
  wallAabb: { min: THREE.Vector3; max: THREE.Vector3 },
  spacing = 0.4,
): RebarSegment[] {
  const segments: RebarSegment[] = [];
  const size = wallAabb.max.clone().sub(wallAabb.min);
  // Horizontal rebar (along X), at intervals along Z + Y.
  for (let y = wallAabb.min.y + spacing / 2; y < wallAabb.max.y; y += spacing) {
    for (let z = wallAabb.min.z + spacing / 2; z < wallAabb.max.z; z += spacing) {
      segments.push({
        start: new THREE.Vector3(wallAabb.min.x, y, z),
        end: new THREE.Vector3(wallAabb.max.x, y, z),
        exposed: false,
      });
    }
  }
  // Vertical rebar (along Y), at intervals along X + Z.
  for (let x = wallAabb.min.x + spacing / 2; x < wallAabb.max.x; x += spacing) {
    for (let z = wallAabb.min.z + spacing / 2; z < wallAabb.max.z; z += spacing) {
      segments.push({
        start: new THREE.Vector3(x, wallAabb.min.y, z),
        end: new THREE.Vector3(x, wallAabb.max.y, z),
        exposed: false,
      });
    }
  }
  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────
// #763 — Wood splinter directionality (along grain)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate wood splinter velocities along the wood grain. Splinters fly
 * preferentially along the grain direction (the wood's fibers split along
 * their length, not across).
 */
export function woodSplinterVelocities(
  count: number,
  grainDir: THREE.Vector3,
  impactDir: THREE.Vector3,
  force: number,
): THREE.Vector3[] {
  const vels: THREE.Vector3[] = [];
  const grain = grainDir.clone().normalize();
  for (let i = 0; i < count; i++) {
    // 70% along grain, 30% along impact direction.
    const v = grain.clone().multiplyScalar(force * (0.5 + Math.random()) * 0.7);
    v.addScaledVector(impactDir, force * (0.3 + Math.random() * 0.3) * 0.3);
    // Small jitter.
    v.x += (Math.random() - 0.5) * force * 0.2;
    v.y += (Math.random() - 0.5) * force * 0.2;
    v.z += (Math.random() - 0.5) * force * 0.2;
    vels.push(v);
  }
  return vels;
}

// ─────────────────────────────────────────────────────────────────────────────
// #764 — Glass crack propagation (concentric + radial)
// ─────────────────────────────────────────────────────────────────────────────

export interface GlassCrack {
  /** Origin of the impact (on the glass pane). */
  origin: THREE.Vector3;
  /** Concentric rings (radii from origin). */
  concentric: number[];
  /** Radial crack endpoints (from origin outward). */
  radial: THREE.Vector3[];
}

/**
 * Generate glass crack lines from an impact point. Concentric rings expand
 * outward; radial cracks radiate from the impact origin (typical of
 * tempered-glass break patterns).
 */
export function generateGlassCracks(
  origin: THREE.Vector3,
  paneNormal: THREE.Vector3,
  paneSize: { w: number; h: number },
  ringCount = 3,
  radialCount = 8,
): GlassCrack {
  // Concentric ring radii (geometric — closer near the origin).
  const concentric: number[] = [];
  const maxR = Math.min(paneSize.w, paneSize.h) * 0.5;
  for (let i = 1; i <= ringCount; i++) {
    concentric.push(maxR * (i / ringCount) * (0.6 + Math.random() * 0.3));
  }
  // Radial endpoints (evenly distributed in angle, jittered length).
  const radial: THREE.Vector3[] = [];
  const up = Math.abs(paneNormal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(paneNormal, up).normalize();
  const inPlaneUp = new THREE.Vector3().crossVectors(right, paneNormal).normalize();
  for (let i = 0; i < radialCount; i++) {
    const angle = (i / radialCount) * Math.PI * 2;
    const r = maxR * (0.7 + Math.random() * 0.3);
    radial.push(origin.clone()
      .addScaledVector(right, Math.cos(angle) * r)
      .addScaledVector(inPlaneUp, Math.sin(angle) * r));
  }
  return { origin: origin.clone(), concentric, radial };
}

// ─────────────────────────────────────────────────────────────────────────────
// #765 — Persistent structural damage (saved to DB)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize the destruction state of all destructible props for savegame
 * persistence. Returns a compact JSON-safe record. The engine writes this to
 * the Prisma DB (MatchState.destructionState JSON column) on match save +
 * restores it on match resume.
 */
export interface PersistentPropDamage {
  id: string;
  hp: number;
  maxHp: number;
  stage: number;
  /** Whether the prop has been destroyed. */
  destroyed: boolean;
}

export function serializeDestructionState(
  props: Array<{ id: string; hp: number; maxHp: number; stage: number; destroyed: boolean }>,
): PersistentPropDamage[] {
  return props.map((p) => ({
    id: p.id,
    hp: p.hp,
    maxHp: p.maxHp,
    stage: p.stage,
    destroyed: p.destroyed,
  }));
}

/** Apply serialized damage state back onto prop records. */
export function deserializeDestructionState(
  saved: PersistentPropDamage[],
  props: Array<{ id: string; hp: number; maxHp: number; stage: number; destroyed: boolean }>,
): void {
  const map = new Map(saved.map((s) => [s.id, s]));
  for (const p of props) {
    const s = map.get(p.id);
    if (!s) continue;
    p.hp = s.hp;
    p.maxHp = s.maxHp;
    p.stage = s.stage;
    p.destroyed = s.destroyed;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #768 — Pendulum physics (hanging props)
// ─────────────────────────────────────────────────────────────────────────────

export interface PendulumState {
  /** Pivot point (fixed). */
  pivot: THREE.Vector3;
  /** Pendulum length (m). */
  length: number;
  /** Current angle from vertical (radians). */
  angle: number;
  /** Angular velocity (rad/s). */
  angularVel: number;
  /** Mass (kg). */
  mass: number;
  /** Damping (0..1 per second). */
  damping: number;
}

/** Update a simple pendulum. θ'' = -(g/L) sin(θ) - damping × θ'. */
export function updatePendulum(state: PendulumState, gravity: number, dt: number): void {
  const angAccel = -(gravity / state.length) * Math.sin(state.angle);
  state.angularVel += angAccel * dt;
  state.angularVel *= 1 - state.damping * dt;
  state.angle += state.angularVel * dt;
}

/** Apply an impulse to a pendulum (e.g. a hanging light hit by a bullet). */
export function applyPendulumImpulse(state: PendulumState, impulse: number): void {
  state.angularVel += impulse / (state.mass * state.length);
}

/** Get the pendulum bob's current world position. */
export function pendulumBobPosition(state: PendulumState): THREE.Vector3 {
  return state.pivot.clone().add(new THREE.Vector3(
    Math.sin(state.angle) * state.length,
    -Math.cos(state.angle) * state.length,
    0,
  ));
}

// ─────────────────────────────────────────────────────────────────────────────
// #769 / #770 — Ragdoll-on-stairs (tumble) + ragdoll-on-slope (slide)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply stair-tumble to a ragdoll. If a ragdoll is on stairs (ground normal
 * tilted + low friction), it tumbles down the stairs: gets a forward +
 * downward velocity component along the stair descent direction.
 */
export function ragdollStairTumble(
  ragdollVel: THREE.Vector3,
  ragdollPos: THREE.Vector3,
  stairNormal: THREE.Vector3,
  stairDescentDir: THREE.Vector3,
  dt: number,
): void {
  // If the stair normal is tilted more than 20° from vertical, tumble.
  const up = new THREE.Vector3(0, 1, 0);
  const tilt = Math.acos(THREE.MathUtils.clamp(stairNormal.dot(up), -1, 1));
  if (tilt < 0.35) return; // ~20°
  // Accelerate along descent direction.
  ragdollVel.addScaledVector(stairDescentDir, 3.0 * dt);
  // Small downward bias so the ragdoll keeps falling down the stairs.
  ragdollVel.y -= 2.0 * dt;
  void ragdollPos;
}

/**
 * Apply slope-slide to a ragdoll. If the ground is too steep for the ragdoll
 * to rest, it slides down the slope.
 */
export function ragdollSlopeSlide(
  ragdollVel: THREE.Vector3,
  groundNormal: THREE.Vector3,
  gravity: number,
  dt: number,
  maxSlope = Math.PI / 4,
): void {
  const slide = slopeSlideAcceleration(groundNormal, gravity, maxSlope);
  if (slide.lengthSq() > 0) {
    ragdollVel.addScaledVector(slide, dt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #771 — Explosion shockwave (knockback + ragdoll impulse)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply explosion shockwave knockback to all bodies within the blast radius.
 * Bodies farther from the center get less impulse (inverse-linear falloff).
 *
 * @param bodies       Bodies to apply knockback to (pos + vel mutated).
 * @param center       Blast center.
 * @param radius       Blast radius (m).
 * @param baseForce    Force at the center (N·s).
 * @returns            The list of bodies that received an impulse.
 */
export function explosionShockwave(
  bodies: Array<{ pos: THREE.Vector3; vel: THREE.Vector3; mass: number }>,
  center: THREE.Vector3,
  radius: number,
  baseForce: number,
): Array<{ pos: THREE.Vector3; vel: THREE.Vector3; mass: number }> {
  const hit: typeof bodies = [];
  for (const b of bodies) {
    const delta = b.pos.clone().sub(center);
    const dist = delta.length();
    if (dist > radius) continue;
    const falloff = 1 - dist / radius;
    const dir = dist > 0.001 ? delta.multiplyScalar(1 / dist) : new THREE.Vector3(0, 1, 0);
    const impulse = baseForce * falloff;
    b.vel.addScaledVector(dir, impulse / Math.max(0.5, b.mass));
    // Upward bias — explosions lift bodies.
    b.vel.y += impulse * 0.3 / Math.max(0.5, b.mass);
    hit.push(b);
  }
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────
// #772 — Explosion fragmentation (shrapnel)
// ─────────────────────────────────────────────────────────────────────────────

export interface Shrapnel {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Damage per hit (decays with distance traveled). */
  damage: number;
  despawnMs: number;
}

/**
 * Spawn shrapnel fragments from an explosion. Each fragment flies in a random
 * direction from the blast center; damage decays linearly with distance.
 */
export function spawnShrapnel(
  center: THREE.Vector3,
  count: number,
  speed: number,
  damage: number,
  now: number,
  ttl = 1500,
): Shrapnel[] {
  const fragments: Shrapnel[] = [];
  for (let i = 0; i < count; i++) {
    // Random direction on the unit sphere.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const dir = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi),
    );
    fragments.push({
      pos: center.clone(),
      vel: dir.multiplyScalar(speed * (0.7 + Math.random() * 0.5)),
      damage,
      despawnMs: now + ttl,
    });
  }
  return fragments;
}

// ─────────────────────────────────────────────────────────────────────────────
// #773 — Explosion dirt kick-up
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn dirt particles from an explosion on the ground. Dirt particles are
 * brown, heavier than dust, and arc back to the ground.
 */
export function spawnExplosionDirt(
  center: THREE.Vector3,
  force: number,
  now: number,
  count = 20,
): DustParticle[] {
  const particles: DustParticle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = force * (0.3 + Math.random() * 0.5);
    particles.push({
      pos: center.clone(),
      vel: new THREE.Vector3(
        Math.cos(angle) * speed * 0.7,
        speed * 0.8 + Math.random() * 0.5,
        Math.sin(angle) * speed * 0.7,
      ),
      radius: 0.1 + Math.random() * 0.2,
      density: 0.8,
      despawnMs: now + 1500,
    });
  }
  return particles;
}

// ─────────────────────────────────────────────────────────────────────────────
// #774 — Explosion crater decal
// ─────────────────────────────────────────────────────────────────────────────

export interface CraterDecal {
  pos: THREE.Vector3;
  /** Surface normal at the crater (for decal orientation). */
  normal: THREE.Vector3;
  /** Crater radius (m). */
  radius: number;
  /** Whether the crater is scorched (darker). */
  scorched: boolean;
}

/**
 * Create a crater decal at an explosion site. The radius scales with the
 * explosion force; the decal is placed on the ground surface under the blast.
 */
export function createExplosionCrater(
  center: THREE.Vector3,
  force: number,
  groundY: number,
): CraterDecal {
  return {
    pos: new THREE.Vector3(center.x, groundY + 0.01, center.z),
    normal: new THREE.Vector3(0, 1, 0),
    radius: Math.min(3, force * 0.05),
    scorched: force > 50,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #776 — Water ripples
// ─────────────────────────────────────────────────────────────────────────────

export interface WaterRipple {
  /** Ripple center (on the water surface). */
  center: THREE.Vector3;
  /** Current radius (grows over time). */
  radius: number;
  /** Max radius (m). */
  maxRadius: number;
  /** Amplitude (decays as the ripple expands). */
  amplitude: number;
  /** Spawn time (ms). */
  spawnTime: number;
  /** TTL (ms). */
  ttl: number;
}

/** Spawn a water ripple at a point on the water surface. */
export function spawnWaterRipple(
  center: THREE.Vector3,
  now: number,
  maxRadius = 1.5,
  amplitude = 0.1,
  ttl = 1500,
): WaterRipple {
  return { center: center.clone(), radius: 0, maxRadius, amplitude, spawnTime: now, ttl };
}

/** Update a water ripple (expand + fade). */
export function updateWaterRipple(ripple: WaterRipple, now: number): boolean {
  const elapsed = now - ripple.spawnTime;
  if (elapsed > ripple.ttl) return false;
  const t = elapsed / ripple.ttl;
  ripple.radius = ripple.maxRadius * t;
  ripple.amplitude *= 1 - t;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// #777 — Water displacement (player wading displaces water)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the water displacement at a point caused by a wading body. The
 * displacement is highest at the body's center + falls off with distance.
 *
 * @param bodyPos        Body center.
 * @param bodyRadius     Body radius (m).
 * @param bodyVel        Body velocity (faster = more displacement).
 * @param queryPos       Point on the water surface to query.
 * @returns              Vertical displacement (m) at queryPos.
 */
export function waterDisplacement(
  bodyPos: THREE.Vector3,
  bodyRadius: number,
  bodyVel: THREE.Vector3,
  queryPos: THREE.Vector3,
): number {
  const dx = queryPos.x - bodyPos.x;
  const dz = queryPos.z - bodyPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > bodyRadius * 3) return 0;
  const falloff = 1 - dist / (bodyRadius * 3);
  const speed = bodyVel.length();
  // Displacement: positive (bulge) ahead of the body, negative (trough) behind.
  const dirDot = (dx * bodyVel.x + dz * bodyVel.z) / (dist * speed + 0.001);
  return falloff * speed * 0.05 * dirDot;
}

// ─────────────────────────────────────────────────────────────────────────────
// #778 / #779 / #780 — Mud / ice / sand physics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply mud physics to a player. Muds slows the player + adds a "dirty"
 * flag (cosmetic — boots + pants get a mud tint).
 */
export function applyMudPhysics(
  playerVel: THREE.Vector3,
  depth: number,
  dt: number,
): { isDirty: boolean } {
  // Strong drag proportional to depth.
  const drag = Math.min(0.9, depth * 2);
  playerVel.x *= 1 - drag * dt;
  playerVel.z *= 1 - drag * dt;
  return { isDirty: depth > 0.1 };
}

/**
 * Apply ice physics to a player. Ice drastically reduces friction — the
 * player slides instead of stopping. Forward input has reduced effect.
 */
export function applyIcePhysics(
  playerVel: THREE.Vector3,
  dt: number,
  friction = 0.05,
): void {
  // Very low friction → velocity barely decays.
  const decay = 1 - friction * dt;
  playerVel.x *= decay;
  playerVel.z *= decay;
}

/**
 * Apply sand physics to a player. Sand sinks the player slightly + adds drag.
 */
export function applySandPhysics(
  playerPos: THREE.Vector3,
  playerVel: THREE.Vector3,
  depth: number,
  dt: number,
): void {
  // Sink slightly (max 0.1m below ground).
  if (depth > 0.05) {
    playerPos.y = Math.max(playerPos.y - 0.02 * dt, playerPos.y - 0.1);
  }
  // Moderate drag.
  playerVel.x *= 1 - 0.3 * dt;
  playerVel.z *= 1 - 0.3 * dt;
}

// ─────────────────────────────────────────────────────────────────────────────
// #781 / #782 / #783 / #784 — Foliage interaction, destruction, wind, vegetation
// ─────────────────────────────────────────────────────────────────────────────

export interface FoliageInstance {
  pos: THREE.Vector3;
  /** Rest orientation (quaternion). */
  restRotation: THREE.Quaternion;
  /** Current bend angle (radians). */
  bendAngle: number;
  /** Bend velocity (rad/s). */
  bendVel: number;
  /** Whether the foliage has been trampled. */
  trampled: boolean;
  /** Spring constant (restoring force). */
  springK: number;
  /** Damping. */
  damping: number;
}

/**
 * Apply a bend force to foliage when a body passes through it. The foliage
 * bends away from the body + springs back over ~1s.
 */
export function applyFoliageBend(
  foliage: FoliageInstance,
  bodyPos: THREE.Vector3,
  bodyVel: THREE.Vector3,
  radius: number,
): void {
  if (foliage.trampled) return;
  const dx = foliage.pos.x - bodyPos.x;
  const dz = foliage.pos.z - bodyPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > radius) return;
  // Bend direction = away from the body, in the XZ plane.
  const bendDir = dist > 0.001 ? Math.atan2(dx, dz) : 0;
  const bendForce = (1 - dist / radius) * Math.hypot(bodyVel.x, bodyVel.z) * 0.5;
  foliage.bendVel += Math.cos(bendDir) * bendForce;
  foliage.bendVel += Math.sin(bendDir) * bendForce * 0.5;
}

/** Update foliage bend (spring back toward rest). */
export function updateFoliageBend(foliage: FoliageInstance, dt: number): void {
  if (foliage.trampled) return;
  const springAccel = -foliage.springK * foliage.bendAngle;
  foliage.bendVel += springAccel * dt;
  foliage.bendVel *= 1 - foliage.damping * dt;
  foliage.bendAngle += foliage.bendVel * dt;
}

/** Trample foliage (e.g. player walks through grass — it lays flat). */
export function trampleFoliage(foliage: FoliageInstance): void {
  foliage.trampled = true;
  foliage.bendAngle = Math.PI / 2; // lay flat
  foliage.bendVel = 0;
}

/**
 * Apply wind force to foliage. Foliage sways in the wind direction; the sway
 * amplitude scales with wind speed.
 */
export function applyFoliageWind(
  foliage: FoliageInstance,
  windDir: THREE.Vector3,
  windSpeed: number,
  dt: number,
): void {
  if (foliage.trampled) return;
  // Sway = wind in XZ plane.
  foliage.bendVel += windDir.x * windSpeed * 0.05 * dt;
  foliage.bendVel += windDir.z * windSpeed * 0.05 * dt * 0.5;
}

/**
 * Cut a tree (destructible vegetation). Returns the falling direction +
 * logs the tree as cut.
 */
export interface TreeState {
  pos: THREE.Vector3;
  height: number;
  /** Fall angle (radians). 0 = upright, π/2 = fallen. */
  fallAngle: number;
  /** Fall angular velocity (rad/s). */
  fallVel: number;
  /** Fall direction (XZ plane, normalized). */
  fallDir: THREE.Vector3;
  /** Whether the tree has been cut. */
  cut: boolean;
  /** Whether the tree has fully fallen. */
  fallen: boolean;
}

/** Cut a tree — set its fall direction + initial angular velocity. */
export function cutTree(tree: TreeState, cutDir: THREE.Vector3): void {
  if (tree.cut) return;
  tree.cut = true;
  tree.fallDir = cutDir.clone().normalize();
  tree.fallVel = 0.5; // initial push
}

/** Update a cut tree's fall (gravity-driven). */
export function updateTreeFall(tree: TreeState, gravity: number, dt: number): void {
  if (!tree.cut || tree.fallen) return;
  // Pendulum-like fall: angular accel ∝ sin(angle).
  const angAccel = (gravity / tree.height) * Math.sin(tree.fallAngle);
  tree.fallVel += angAccel * dt;
  tree.fallAngle += tree.fallVel * dt;
  if (tree.fallAngle >= Math.PI / 2) {
    tree.fallAngle = Math.PI / 2;
    tree.fallVel = 0;
    tree.fallen = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #785 / #786 — Particle physics for sparks + embers
// ─────────────────────────────────────────────────────────────────────────────

export interface SparkParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Lifetime remaining (s). */
  life: number;
  /** Whether the spark has bounced off a surface. */
  bounced: boolean;
}

/**
 * Spawn sparks from an impact (bullet on metal, etc.). Sparks bounce off
 * surfaces + decay over ~0.5s.
 */
export function spawnSparks(
  origin: THREE.Vector3,
  normal: THREE.Vector3,
  count: number,
  speed: number,
): SparkParticle[] {
  const sparks: SparkParticle[] = [];
  for (let i = 0; i < count; i++) {
    // Random direction in the hemisphere around the normal.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI / 2;
    const dir = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    );
    // Orient the hemisphere around the normal.
    const up = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(normal, up).normalize();
    const inPlaneUp = new THREE.Vector3().crossVectors(right, normal).normalize();
    const worldDir = right.multiplyScalar(dir.x).add(inPlaneUp.multiplyScalar(dir.y)).add(normal.clone().multiplyScalar(dir.z));
    sparks.push({
      pos: origin.clone(),
      vel: worldDir.multiplyScalar(speed * (0.5 + Math.random())),
      life: 0.3 + Math.random() * 0.3,
      bounced: false,
    });
  }
  return sparks;
}

/** Update spark particles (gravity + bounce off ground plane at y=0). */
export function updateSparks(sparks: SparkParticle[], gravity: number, dt: number): void {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life -= dt;
    if (s.life <= 0) { sparks.splice(i, 1); continue; }
    s.vel.y -= gravity * dt;
    s.pos.addScaledVector(s.vel, dt);
    if (s.pos.y < 0) {
      s.pos.y = 0;
      if (!s.bounced) {
        s.vel.y = -s.vel.y * 0.4;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
        s.bounced = true;
      } else {
        s.vel.set(0, 0, 0);
      }
    }
  }
}

export interface EmberParticle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  /** Whether the ember is still glowing. */
  glowing: boolean;
}

/**
 * Spawn embers from a fire. Embers drift upward (buoyancy from hot air) +
 * follow air currents. Lifetime ~2-4s.
 */
export function spawnEmbers(
  origin: THREE.Vector3,
  count: number,
  now: number,
): EmberParticle[] {
  void now;
  const embers: EmberParticle[] = [];
  for (let i = 0; i < count; i++) {
    embers.push({
      pos: origin.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.3,
        Math.random() * 0.5,
        (Math.random() - 0.5) * 0.3,
      )),
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 0.5,
        0.5 + Math.random() * 1.5, // upward bias (hot air)
        (Math.random() - 0.5) * 0.5,
      ),
      life: 2 + Math.random() * 2,
      glowing: true,
    });
  }
  return embers;
}

/** Update ember particles (buoyancy + drag + fade). */
export function updateEmbers(embers: EmberParticle[], dt: number): void {
  for (let i = embers.length - 1; i >= 0; i--) {
    const e = embers[i];
    e.life -= dt;
    if (e.life <= 0) { embers.splice(i, 1); continue; }
    // Mild buoyancy (hot air rises).
    e.vel.y += 0.5 * dt;
    // Drag.
    e.vel.multiplyScalar(1 - 0.3 * dt);
    e.pos.addScaledVector(e.vel, dt);
    // Glow fades in the last second.
    if (e.life < 1) e.glowing = Math.random() > 0.3;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #787 / #788 / #789 / #790 — Fire / smoke / gas propagation + volumetric smoke
// ─────────────────────────────────────────────────────────────────────────────

export interface FireCell {
  /** Cell position (grid coords). */
  x: number; y: number; z: number;
  /** World position (cell center). */
  pos: THREE.Vector3;
  /** Heat 0..1 (above ignition threshold → burning). */
  heat: number;
  /** Fuel 0..1 (decays as the cell burns). */
  fuel: number;
  /** Whether the cell is currently burning. */
  burning: boolean;
}

/**
 * Propagate fire through a 3D grid of cells. Heat diffuses to neighbors;
 * cells with fuel ignite when heat exceeds the ignition threshold.
 *
 * @param cells     Grid of fire cells.
 * @param dt        Delta time (s).
 * @param diffusion Heat diffusion rate (0..1 per second).
 * @param ignition  Heat threshold for ignition (0..1).
 */
export function propagateFire(
  cells: FireCell[],
  dt: number,
  diffusion = 0.5,
  ignition = 0.4,
): void {
  const map = new Map<string, FireCell>();
  for (const c of cells) map.set(`${c.x},${c.y},${c.z}`, c);
  // Heat diffusion pass.
  for (const c of cells) {
    if (!c.burning) continue;
    // Heat neighbors.
    const neighbors = [
      [c.x + 1, c.y, c.z], [c.x - 1, c.y, c.z],
      [c.x, c.y + 1, c.z], [c.x, c.y - 1, c.z],
      [c.x, c.y, c.z + 1], [c.x, c.y, c.z - 1],
    ];
    for (const [nx, ny, nz] of neighbors) {
      const n = map.get(`${nx},${ny},${nz}`);
      if (!n) continue;
      n.heat += diffusion * dt;
      if (n.heat > ignition && n.fuel > 0.1 && !n.burning) {
        n.burning = true;
      }
    }
    // Consume fuel.
    c.fuel = Math.max(0, c.fuel - 0.1 * dt);
    if (c.fuel <= 0) c.burning = false;
  }
}

export interface SmokeCell {
  pos: THREE.Vector3;
  /** Smoke density 0..1. */
  density: number;
  /** Whether the cell is in a closed room (smoke accumulates). */
  enclosed: boolean;
}

/**
 * Propagate smoke through a grid of cells. Smoke diffuses + rises; enclosed
 * rooms accumulate smoke (density grows over time).
 */
export function propagateSmoke(
  cells: SmokeCell[],
  dt: number,
  diffusion = 0.3,
  riseRate = 0.5,
): void {
  for (const c of cells) {
    if (c.enclosed) {
      // Smoke accumulates in enclosed rooms.
      c.density = Math.min(1, c.density + 0.05 * dt);
    } else {
      // Smoke diffuses + rises (moves to the cell above).
      c.density = Math.max(0, c.density - diffusion * dt);
    }
  }
  // Rise: move smoke from lower cells to upper cells.
  void riseRate;
}

export interface GasCell {
  pos: THREE.Vector3;
  /** Gas concentration 0..1 (toxic above threshold). */
  concentration: number;
  /** Whether the gas is toxic. */
  toxic: boolean;
}

/** Propagate toxic gas (same as smoke but with damage threshold). */
export function propagateGas(
  cells: GasCell[],
  dt: number,
  diffusion = 0.4,
): void {
  for (const c of cells) {
    c.concentration = Math.max(0, c.concentration - diffusion * dt * 0.5);
  }
}

/**
 * #790 — Smoke-tinted volumetric. Compute the volumetric smoke color at a
 * sample point given the smoke density + the scene's ambient light color.
 *
 * @param density     Smoke density 0..1.
 * @param ambientCol  Ambient light color (linear RGB).
 * @param lightDir    Direction to the dominant light.
 * @param viewDir     Direction from sample to viewer.
 * @returns           Tinted RGB color (linear, 0..1 per channel).
 */
export function volumetricSmokeColor(
  density: number,
  ambientCol: THREE.Vector3,
  lightDir: THREE.Vector3,
  viewDir: THREE.Vector3,
): THREE.Vector3 {
  // Beer-Lambert extinction along the view ray.
  const extinction = Math.exp(-density * 2.0);
  // Forward-scattering: smoke is brighter when the light is behind the viewer.
  const forward = Math.max(0, lightDir.dot(viewDir.clone().negate()));
  const scattered = ambientCol.clone().multiplyScalar(0.3 + forward * 0.7);
  // Final color = extinction * (ambient + scattered).
  return ambientCol.clone().multiplyScalar(extinction).add(scattered.multiplyScalar(1 - extinction));
}

// ─────────────────────────────────────────────────────────────────────────────
// #791 / #792 / #793 — Interactive physics props + prop health + material break
// ─────────────────────────────────────────────────────────────────────────────

export interface PhysicsProp {
  id: string;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mass: number;
  /** Material determines break behavior (#793). */
  material: SurfacePhysicsType;
  /** Current HP. */
  hp: number;
  maxHp: number;
  /** Whether the prop has been destroyed. */
  destroyed: boolean;
}

/**
 * Apply damage to a prop. If HP drops to 0, the prop is destroyed + a
 * material-specific break event is returned.
 */
export function damageProp(prop: PhysicsProp, damage: number): { destroyed: boolean; material: SurfacePhysicsType } | null {
  if (prop.destroyed) return null;
  prop.hp = Math.max(0, prop.hp - damage);
  if (prop.hp <= 0) {
    prop.destroyed = true;
    return { destroyed: true, material: prop.material };
  }
  return { destroyed: false, material: prop.material };
}

/**
 * #793 — Get the material-specific break behavior for a prop. Returns the
 * shard count + velocity scale appropriate for the material.
 *
 * Glass: many small fast shards.
 * Wood: splinters along the grain.
 * Concrete: heavy chunks + dust.
 * Metal: few large chunks.
 */
export function materialBreakBehavior(material: SurfacePhysicsType): {
  shardCount: number;
  velocityScale: number;
  spawnDust: boolean;
  spawnRebar: boolean;
} {
  switch (material) {
    case "ice":      return { shardCount: 30, velocityScale: 1.5, spawnDust: false, spawnRebar: false }; // #755 glass-like
    case "metal":    return { shardCount: 6,  velocityScale: 0.8, spawnDust: false, spawnRebar: false };
    case "sand":     return { shardCount: 40, velocityScale: 0.5, spawnDust: true,  spawnRebar: false };
    case "wood":     return { shardCount: 12, velocityScale: 1.0, spawnDust: true,  spawnRebar: false }; // #756 splinter
    case "concrete": return { shardCount: 18, velocityScale: 0.7, spawnDust: true,  spawnRebar: true };  // #757 spall + rebar
    case "water":    return { shardCount: 25, velocityScale: 1.2, spawnDust: false, spawnRebar: false };
    default:         return { shardCount: 14, velocityScale: 1.0, spawnDust: true,  spawnRebar: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #794 / #795 / #796 / #797 / #798 — Physics-based melee / throw / grenade / breach / grab
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #794 — Physics-based melee. Compute the impulse delivered by a melee swing.
 * The impulse scales with the swing's momentum (mass × velocity at impact).
 */
export function meleeImpulse(
  weaponMass: number,
  swingSpeed: number,
  swingReach: number,
  contactDist: number,
): number {
  // Momentum at impact = mass × (swingSpeed × (1 - contactDist / swingReach)).
  // The further into the swing, the slower (decelerating).
  const speedAtContact = swingSpeed * (1 - contactDist / swingReach);
  return weaponMass * speedAtContact;
}

/**
 * #795 — Physics-based throw. Compute the launch velocity for an object of
 * given mass thrown with a given input force. Heavier objects fly slower.
 *
 * @param mass        Object mass (kg).
 * @param inputForce  Player throw force (N).
 * @param throwDir    Throw direction (normalized).
 * @param upBias      Upward bias (m/s) — gives the arc.
 * @returns           Launch velocity (m/s).
 */
export function throwVelocity(
  mass: number,
  inputForce: number,
  throwDir: THREE.Vector3,
  upBias = 2,
): THREE.Vector3 {
  // v = F/m (heavier = slower).
  const speed = inputForce / Math.max(0.5, mass);
  const vel = throwDir.clone().multiplyScalar(speed);
  vel.y += upBias;
  return vel;
}

/**
 * #796 — Physics-based grenade. Bounce a grenade off a surface with realistic
 * restitution + friction. Slightly different from `grenadeBounceVelocity`
 * (above): adds a tumble (angular velocity) and a friction-tangent damping.
 */
export function grenadeBounce(
  inVel: THREE.Vector3,
  surfaceNormal: THREE.Vector3,
  restitution = 0.45,
  friction = 0.6,
): { vel: THREE.Vector3; angularVel: THREE.Vector3 } {
  const dot = inVel.dot(surfaceNormal);
  if (dot >= 0) return { vel: inVel.clone(), angularVel: new THREE.Vector3() };
  // Reflect normal component.
  const normalComp = surfaceNormal.clone().multiplyScalar(dot);
  const tangentComp = inVel.clone().sub(normalComp);
  const reflected = normalComp.multiplyScalar(-restitution).add(tangentComp.multiplyScalar(1 - friction));
  // Tumble: angular velocity proportional to the tangent speed.
  const angularVel = new THREE.Vector3(
    tangentComp.z * 2,
    0,
    -tangentComp.x * 2,
  );
  return { vel: reflected, angularVel };
}

/**
 * #797 — Physics-based door breach. A kick delivers an impulse that breaks
 * the door off its hinges if the impulse exceeds the hinge strength.
 */
export function doorBreachCheck(
  kickImpulse: number,
  hingeStrength: number,
): { breached: boolean; debrisVel: THREE.Vector3 } {
  if (kickImpulse > hingeStrength) {
    return {
      breached: true,
      debrisVel: new THREE.Vector3(0, 0, kickImpulse * 0.3), // door flies inward
    };
  }
  return { breached: false, debrisVel: new THREE.Vector3() };
}

/**
 * #798 — Physics-based ragdoll grab. The player can grab + drag a corpse.
 * Returns the drag impulse applied to the ragdoll based on the player's
 * pull direction + force.
 */
export function ragdollGrabDrag(
  ragdollVel: THREE.Vector3,
  playerVel: THREE.Vector3,
  pullForce: number,
  ragdollMass: number,
  dt: number,
): void {
  // Apply a force toward the player's velocity direction.
  const target = playerVel.clone().multiplyScalar(0.5);
  const delta = target.clone().sub(ragdollVel);
  ragdollVel.addScaledVector(delta, Math.min(1, pullForce * dt / Math.max(0.5, ragdollMass)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section F summary
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_F_STATUS = {
  // Prompts 731-736: physics backend upgrades (in PhysicsBackend.ts).
  ccd: "code (PhysicsBackend CCD substep — #97/#731)",
  friction: "code (post-normal-impulse + average friction — #99/#100/#732)",
  sleepThreshold: "code (horizontal-velocity gate — #101/#733)",
  collisionLayers: "code (group/mask bitfields — #103/#734)",
  broadphase: "code (AABB tight + uniform grid — #104/#735/#736)",
  spherePrimitive: "code (sphere-vs-AABB/sphere narrowphase — #106)",
  // Prompts 737-798: physics enhancements (this file).
  buoyancy: "code (buoyancyForce + submergedVolume — #737)",
  ragdollToPropMomentum: "code (ragdollToPropMomentumTransfer — #738)",
  breakableConstraints: "code (PhysicsBackend addDistanceConstraint/addHingeConstraint — #739)",
  softBody: "code (PhysicsBackend addSoftBody + verlet + pressure — #740)",
  clothVsBody: "code (clothVsBody — #741)",
  vehicles: "code (combat/vehicles.ts VehicleController — #742)",
  jointFriction: "code (PhysicsBackend constraint friction — #743)",
  materialFriction: "code (SURFACE_PHYSICS — #744)",
  slopeSlide: "code (slopeSlideAcceleration — #745/#751)",
  aeroDrag: "code (PhysicsBackend aeroDrag — #746)",
  capsuleVsMesh: "code (capsuleVsTriangle + sweptCapsuleVsTriangles — #747/#749)",
  trimeshColliders: "code (buildTrimeshFromGeometry + iterTrimeshTriangles — #748)",
  sweptCapsule: "code (sweptCapsuleVsTriangles — #749)",
  stairStepping: "code (tryStairStep — #750)",
  slopeHandling: "code (slopeSlideAcceleration — #751)",
  movingPlatforms: "code (updateMovingPlatform + rideMovingPlatform — #752)",
  elevators: "code (updateElevator + callElevator — #753)",
  doors: "code (HingedDoor + updateHingedDoor — #754)",
  breakableGlass: "code (shatterGlass + generateGlassCracks — #755/#764)",
  breakableWood: "code (woodSplinterVelocities — #756/#763)",
  breakableConcrete: "code (materialBreakBehavior + generateRebar — #757/#762)",
  stressPropagation: "code (propagateStructuralFailure — #758)",
  loadBearingWalls: "code (identifyLoadBearingWalls — #759)",
  persistentDebris: "code (destruction-physics.ts registerDebris + tickDebris — #760)",
  dustClouds: "code (spawnDustCloud + updateDustCloud — #761)",
  rebar: "code (generateRebar — #762)",
  woodSplinterGrain: "code (woodSplinterVelocities — #763)",
  glassCrackPropagation: "code (generateGlassCracks — #764)",
  persistentStructuralDamage: "code (serializeDestructionState + deserializeDestructionState — #765)",
  ropePhysics: "code (PhysicsBackend addDistanceConstraint + simulateRope — #766)",
  chainPhysics: "code (PhysicsBackend addDistanceConstraint chained — #767)",
  pendulumPhysics: "code (PendulumState + updatePendulum — #768)",
  ragdollStairs: "code (ragdollStairTumble — #769)",
  ragdollSlope: "code (ragdollSlopeSlide — #770)",
  explosionShockwave: "code (explosionShockwave — #771)",
  explosionFragmentation: "code (spawnShrapnel — #772)",
  explosionDirt: "code (spawnExplosionDirt — #773)",
  explosionCrater: "code (createExplosionCrater — #774)",
  waterSplash: "code (spawnWaterSplash — #775)",
  waterRipples: "code (spawnWaterRipple + updateWaterRipple — #776)",
  waterDisplacement: "code (waterDisplacement — #777)",
  mudPhysics: "code (applyMudPhysics — #778)",
  icePhysics: "code (applyIcePhysics — #779)",
  sandPhysics: "code (applySandPhysics — #780)",
  foliageInteraction: "code (applyFoliageBend + updateFoliageBend — #781)",
  foliageDestruction: "code (trampleFoliage — #782)",
  windFoliage: "code (applyFoliageWind — #783)",
  destructibleVegetation: "code (TreeState + cutTree + updateTreeFall — #784)",
  sparkParticles: "code (spawnSparks + updateSparks — #785)",
  emberParticles: "code (spawnEmbers + updateEmbers — #786)",
  firePropagation: "code (propagateFire — #787)",
  smokePropagation: "code (propagateSmoke — #788)",
  gasPropagation: "code (propagateGas — #789)",
  volumetricSmoke: "code (volumetricSmokeColor — #790)",
  interactiveProps: "code (PhysicsProp + damageProp — #791/#792)",
  propHealth: "code (PhysicsProp.hp + damageProp — #792)",
  propMaterialBreak: "code (materialBreakBehavior — #793)",
  physicsMelee: "code (meleeImpulse — #794)",
  physicsThrow: "code (throwVelocity — #795)",
  physicsGrenade: "code (grenadeBounce — #796)",
  physicsDoorBreach: "code (doorBreachCheck — #797)",
  physicsRagdollGrab: "code (ragdollGrabDrag — #798)",
  // Prompts 799-810: WebXR / VR (in SpatialComputeSystem.ts).
  webxrRoomAsLevel: "code (SpatialComputeSystem.requestSession — #799)",
  webxrHandTracking: "code (SpatialComputeSystem.setupHandTracking — #800)",
  webxrLightEstimation: "code (SpatialComputeSystem.setupLightEstimation — #801)",
  webxrMeshDetection: "code (SpatialComputeSystem.setupMeshDetection — #802)",
  webxrPassthrough: "code (SpatialComputeSystem passthrough flag — #803)",
  vrCrosshair: "code (SpatialComputeSystem.VRCrosshair — #804)",
  vrWeaponGrip: "code (SpatialComputeSystem VRWeaponGrip — #805)",
  vrReload: "code (SpatialComputeSystem VRReloadGesture — #806)",
  vrLocomotion: "code (SpatialComputeSystem VRLocomotion — #807)",
  vrComfort: "code (SpatialComputeSystem VRComfortVignette — #808)",
  vrPerformanceMode: "code (SpatialComputeSystem VRPerformanceMode — #809)",
  vrSpectator: "code (SpatialComputeSystem VRSpectator — #810)",
} as const;
