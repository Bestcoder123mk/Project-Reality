/**
 * Section D — Brass Ejection Physics.
 *
 * Real-world firearms eject spent shell casings through the ejection port
 * with a velocity + spin determined by the bolt's extractor + ejector
 * geometry. The casing bounces off the brass deflector (AR) or receiver
 * (AK) and lands in a pile to the shooter's right.
 *
 * This module computes:
 *   1. Initial casing velocity (m/s) — ejection speed + direction.
 *   2. Casing spin (rad/sec) — tumbling motion.
 *   3. Trajectory — gravity + air drag + bounce off ground.
 *   4. Surface impact sound selection — dirt / concrete / wood / water.
 *   5. Casings accumulate into a "brass pile" for visual effect.
 *
 * Engine integration: the ParticleSystem reads `ejectCasing()` per shot
 * to spawn a casing particle; the AudioSystem reads `casingImpactSound()`
 * for the bounce sound.
 */

import type { WeaponType, WeaponCategory } from "../store";
import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// Casing specs per cartridge.
// ─────────────────────────────────────────────────────────────────────────────

export type CartridgeFamily =
  | "5.45x39"
  | "5.56x45"
  | "7.62x39"
  | "7.62x51"
  | "7.62x54R"
  | "9x19"
  | "4.6x30"
  | "5.7x28"
  | "45acp"
  | "50ae"
  | "338lapua"
  | "12ga"
  | "50bmg";

export interface CasingSpec {
  cartridge: CartridgeFamily;
  /** Casing length (mm). */
  lengthMm: number;
  /** Casing base diameter (mm). */
  baseMm: number;
  /** Casing material. */
  material: "brass" | "steel" | "aluminum" | "polymer";
  /** Empty casing mass (g). */
  massG: number;
  /** Color in [r, g, b] (0..1). */
  color: [number, number, number];
}

export const CASING_SPECS: Record<CartridgeFamily, CasingSpec> = {
  "5.45x39":   { cartridge: "5.45x39", lengthMm: 39.8, baseMm: 10.0, material: "steel", massG: 6.7,  color: [0.85, 0.65, 0.35] },
  "5.56x45":   { cartridge: "5.56x45", lengthMm: 44.7, baseMm: 9.5,  material: "brass", massG: 12.4, color: [0.85, 0.65, 0.35] },
  "7.62x39":   { cartridge: "7.62x39", lengthMm: 38.7, baseMm: 11.3, material: "steel", massG: 11.3, color: [0.85, 0.65, 0.35] },
  "7.62x51":   { cartridge: "7.62x51", lengthMm: 51.2, baseMm: 11.9, material: "brass", massG: 24.0, color: [0.85, 0.65, 0.35] },
  "7.62x54R":  { cartridge: "7.62x54R", lengthMm: 53.7, baseMm: 12.4, material: "brass", massG: 22.0, color: [0.85, 0.65, 0.35] },
  "9x19":      { cartridge: "9x19", lengthMm: 19.2, baseMm: 9.0,  material: "brass", massG: 7.5,  color: [0.85, 0.65, 0.35] },
  "4.6x30":    { cartridge: "4.6x30", lengthMm: 30.5, baseMm: 7.9,  material: "brass", massG: 6.3,  color: [0.85, 0.65, 0.35] },
  "5.7x28":    { cartridge: "5.7x28", lengthMm: 28.8, baseMm: 7.9,  material: "brass", massG: 6.0,  color: [0.85, 0.65, 0.35] },
  "45acp":     { cartridge: "45acp", lengthMm: 22.8, baseMm: 12.1, material: "brass", massG: 12.5, color: [0.85, 0.65, 0.35] },
  "50ae":      { cartridge: "50ae", lengthMm: 33.3, baseMm: 13.0, material: "brass", massG: 30.0, color: [0.85, 0.65, 0.35] },
  "338lapua":  { cartridge: "338lapua", lengthMm: 69.2, baseMm: 13.8, material: "brass", massG: 35.0, color: [0.85, 0.65, 0.35] },
  "12ga":      { cartridge: "12ga", lengthMm: 70.0, baseMm: 18.5, material: "polymer", massG: 18.0, color: [0.25, 0.15, 0.10] },
  "50bmg":     { cartridge: "50bmg", lengthMm: 99.0, baseMm: 20.0, material: "brass", massG: 116.0, color: [0.85, 0.65, 0.35] },
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-weapon cartridge + ejection pattern.
// ─────────────────────────────────────────────────────────────────────────────

const WEAPON_CARTRIDGE: Partial<Record<WeaponType, CartridgeFamily>> = {
  ak74: "5.45x39", m4: "5.56x45", hk416: "5.56x45", famas: "5.56x45",
  aug: "5.56x45", scarh: "7.62x51", galil: "5.56x45", mk17: "7.62x51",
  mk14: "7.62x51", scarl: "5.56x45", m110: "7.62x51", mk12: "5.56x45",
  g36: "5.56x45", mcx: "5.56x45", tavorx95: "5.56x45", svd: "7.62x54R",
  mp7: "4.6x30", p90: "5.7x28", mp5: "9x19", ump45: "45acp",
  vector: "45acp", pp90m1: "9x19",
  usp: "45acp", deagle: "50ae", glock18: "9x19", glock17: "9x19",
  m1911: "45acp", revolver: "50ae",
  awp: "338lapua", scout: "5.56x45", kar98k: "7.62x51",
  l115a3: "338lapua", m82: "50bmg",
  nova: "12ga", m1014: "12ga", spas12: "12ga", m870: "12ga",
  m249: "5.56x45", rpk: "5.45x39", mk48: "7.62x51", rpk16: "5.45x39",
  pkm: "7.62x54R", m240b: "7.62x51",
};

export function cartridgeForWeapon(weapon: WeaponType): CartridgeFamily {
  return WEAPON_CARTRIDGE[weapon] ?? "5.56x45";
}

// ─────────────────────────────────────────────────────────────────────────────
// Ejection trajectory.
// ─────────────────────────────────────────────────────────────────────────────

export interface EjectionParams {
  /** Ejection port position relative to weapon (meters, weapon-local). */
  portOffset: THREE.Vector3;
  /** Initial velocity vector (m/s, weapon-local). */
  initialVelocity: THREE.Vector3;
  /** Spin axis (unit vector, weapon-local). */
  spinAxis: THREE.Vector3;
  /** Spin rate (rad/sec). */
  spinRate: number;
  /** Casing spec. */
  casing: CasingSpec;
  /** Casing scale (relative to its base dimensions). */
  scale: number;
}

export interface EjectionTrajectory {
  /** Sampled positions over time (meters, world-space). */
  positions: THREE.Vector3[];
  /** Sampled rotations (quaternions). */
  rotations: THREE.Quaternion[];
  /** Time of each sample (sec). */
  times: number[];
  /** Final resting position. */
  finalPosition: THREE.Vector3;
  /** Total trajectory duration (sec). */
  durationSec: number;
  /** Number of bounces. */
  bounces: number;
}

// Ejection port positions (weapon-local, meters) — relative to receiver.
const EJECTION_PORTS: Partial<Record<WeaponType, THREE.Vector3>> = {
  // AR-pattern: right side, just behind the ejection port.
  m4:   new THREE.Vector3(0.025, 0.04, -0.05),
  hk416: new THREE.Vector3(0.025, 0.04, -0.05),
  famas: new THREE.Vector3(0.025, 0.04, -0.05),
  aug:   new THREE.Vector3(0.025, 0.04, -0.05),
  scarh: new THREE.Vector3(0.025, 0.04, -0.05),
  // AK-pattern: right side, slightly forward.
  ak74:  new THREE.Vector3(0.025, 0.05, 0.02),
  galil: new THREE.Vector3(0.025, 0.05, 0.02),
  rpk:   new THREE.Vector3(0.025, 0.05, 0.02),
  // Pistols: right side, up and back.
  usp:    new THREE.Vector3(0.020, 0.06, 0.04),
  deagle: new THREE.Vector3(0.022, 0.07, 0.04),
  glock18: new THREE.Vector3(0.018, 0.05, 0.04),
  m1911:  new THREE.Vector3(0.020, 0.06, 0.04),
  // Snipers: right side, large casing.
  awp:    new THREE.Vector3(0.028, 0.06, -0.05),
  l115a3: new THREE.Vector3(0.028, 0.06, -0.05),
  kar98k: new THREE.Vector3(0.028, 0.06, 0.02),
  // Shotguns: bottom-eject (most combat shotguns).
  nova:   new THREE.Vector3(0.0, 0.0, -0.20),
  m1014:  new THREE.Vector3(0.0, 0.0, -0.20),
  spas12: new THREE.Vector3(0.0, 0.0, -0.20),
  // LMGs: right side, high volume.
  m249:   new THREE.Vector3(0.030, 0.06, 0.05),
  rpk16:  new THREE.Vector3(0.025, 0.05, 0.02),
  mk48:   new THREE.Vector3(0.030, 0.06, 0.05),
};

/**
 * Compute the ejection parameters for a weapon + fire mode.
 * Real-world ejection speeds: 4-6 m/s for rifles, 3-5 m/s for pistols,
 * 5-7 m/s for shotguns, 6-8 m/s for LMGs.
 */
export function computeEjectionParams(weapon: WeaponType): EjectionParams {
  const cartridge = cartridgeForWeapon(weapon);
  const casing = CASING_SPECS[cartridge];
  const portOffset = EJECTION_PORTS[weapon] ?? new THREE.Vector3(0.025, 0.04, -0.05);

  // Ejection velocity — depends on weapon + cartridge. Default 4.5 m/s for
  // rifles; overridden below for specific weapon families.
  let speed = 4.5; // m/s, default rifle.
  if (weapon === "awp" || weapon === "l115a3" || weapon === "kar98k") speed = 3.5; // bolt-action: slower
  else if (weapon === "deagle" || weapon === "revolver") speed = 5.0; // heavy pistol
  else if (weapon === "m249" || weapon === "mk48" || weapon === "rpk") speed = 6.0; // LMG
  else if (weapon === "nova" || weapon === "m1014" || weapon === "spas12") speed = 4.0; // shotgun

  // Ejection direction — typically up + right + slightly forward.
  const up = 1.2;
  const right = 2.5;
  const forward = -0.3;
  const initialVelocity = new THREE.Vector3(right, up, forward).normalize().multiplyScalar(speed);

  // Spin — casings tumble on the long axis.
  const spinAxis = new THREE.Vector3(1, 0.2, 0).normalize();
  const spinRate = 15 + Math.random() * 10; // 15-25 rad/sec

  // Scale — 1.0 corresponds to a casing at its real-world dimensions.
  // We render casings slightly larger than real-world for visibility.
  const scale = 1.0;

  return { portOffset, initialVelocity, spinAxis, spinRate, casing, scale };
}

/**
 * Simulate the casing trajectory. Returns sampled positions + final rest.
 *
 * Physics:
 *   - Gravity: -9.81 m/s².
 *   - Air drag: 0.5 × ρ × v² × Cd × A (simplified: 0.05 /s linear drag).
 *   - Ground bounce: 0.3 restitution (casing loses 70% of velocity).
 *   - Stop when speed < 0.5 m/s and on the ground.
 *
 * @param params Ejection parameters.
 * @param weaponWorldTransform The weapon's world matrix (for port offset).
 * @param weaponForward The weapon's forward direction (world).
 * @param weaponRight The weapon's right direction (world).
 * @param weaponUp The weapon's up direction (world).
 * @param groundY The ground plane Y (default 0).
 * @param maxTimeSec Max simulation time (default 5 sec).
 */
export function simulateCasingTrajectory(
  params: EjectionParams,
  weaponWorldPos: THREE.Vector3,
  weaponForward: THREE.Vector3,
  weaponRight: THREE.Vector3,
  weaponUp: THREE.Vector3,
  groundY = 0,
  maxTimeSec = 5,
): EjectionTrajectory {
  const positions: THREE.Vector3[] = [];
  const rotations: THREE.Quaternion[] = [];
  const times: number[] = [];
  let bounces = 0;

  // Initial position: weapon position + port offset in weapon-local space.
  const pos = weaponWorldPos.clone()
    .add(weaponRight.clone().multiplyScalar(params.portOffset.x))
    .add(weaponUp.clone().multiplyScalar(params.portOffset.y))
    .add(weaponForward.clone().multiplyScalar(params.portOffset.z));
  positions.push(pos.clone());
  rotations.push(new THREE.Quaternion());
  times.push(0);

  // Initial velocity: transform local velocity to world.
  const vel = weaponRight.clone().multiplyScalar(params.initialVelocity.x)
    .add(weaponUp.clone().multiplyScalar(params.initialVelocity.y))
    .add(weaponForward.clone().multiplyScalar(params.initialVelocity.z));

  // Spin axis to world.
  const spinAxisWorld = weaponRight.clone().multiplyScalar(params.spinAxis.x)
    .add(weaponUp.clone().multiplyScalar(params.spinAxis.y))
    .add(weaponForward.clone().multiplyScalar(params.spinAxis.z))
    .normalize();
  const angularVel = spinAxisWorld.clone().multiplyScalar(params.spinRate);

  const dt = 1 / 60; // 60 Hz simulation.
  let time = 0;
  let rotation = new THREE.Quaternion();
  const dragCoef = 0.05; // linear drag per second.

  while (time < maxTimeSec) {
    time += dt;

    // Gravity.
    vel.y -= 9.81 * dt;
    // Linear drag.
    vel.multiplyScalar(1 - dragCoef * dt);
    // Position.
    pos.add(vel.clone().multiplyScalar(dt));
    // Rotation.
    const dq = new THREE.Quaternion().setFromAxisAngle(spinAxisWorld, params.spinRate * dt);
    rotation = dq.multiply(rotation);

    positions.push(pos.clone());
    rotations.push(rotation.clone());
    times.push(time);

    // Ground bounce.
    if (pos.y <= groundY) {
      pos.y = groundY;
      vel.y = -vel.y * 0.3; // 30% restitution
      vel.x *= 0.7;
      vel.z *= 0.7;
      bounces++;
      // Stop if very slow.
      if (vel.lengthSq() < 0.25) {
        break;
      }
    }
  }

  return {
    positions, rotations, times,
    finalPosition: pos.clone(),
    durationSec: time,
    bounces,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio + visual helpers.
// ─────────────────────────────────────────────────────────────────────────────

export type SurfaceMaterial = "concrete" | "dirt" | "wood" | "metal" | "water" | "grass" | "sand";

/** Select the appropriate brass-impact sound for a surface. */
export function casingImpactSound(surface: SurfaceMaterial, casing: CasingSpec): string {
  if (surface === "water") return "brass_water";
  if (surface === "concrete" || surface === "metal") {
    return casing.material === "brass" ? "brass_concrete" : "steel_concrete";
  }
  if (surface === "wood") return "brass_wood";
  // dirt / grass / sand — muffled.
  return "brass_dirt";
}

/** Estimated pile size (radius in meters) for N casings ejected in one spot. */
export function brassPileRadius(casingCount: number, casing: CasingSpec): number {
  // Each casing occupies ~π × (baseMm/2000)² m². Packed at ~50% density.
  const areaPerCasing = Math.PI * Math.pow(casing.baseMm / 2000, 2) * 2;
  const totalArea = casingCount * areaPerCasing;
  return Math.sqrt(totalArea / Math.PI);
}

/** Whether the weapon ejects casings (some shotguns/speshul weapons don't). */
export function weaponEjectsCasings(weapon: WeaponType): boolean {
  // Shotguns eject hulls but they're polymer; for visual variety, shotguns
  // still eject. Revolvers + belt-fed LMGs (M249 links) don't eject casings
  // the same way — revolvers keep casings in the cylinder, belt-fed eject
  // links + casings.
  if (weapon === "revolver") return false;
  return true;
}

/** Get the casing color as a CSS hex string (for HUD/UI). */
export function casingColorHex(casing: CasingSpec): string {
  const [r, g, b] = casing.color;
  const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Category-based ejection pattern fallback. */
export function defaultEjectionForCategory(category: WeaponCategory): EjectionParams {
  const portOffset = new THREE.Vector3(0.025, 0.04, -0.05);
  const initialVelocity = new THREE.Vector3(2.5, 1.2, -0.3).normalize().multiplyScalar(4.5);
  return {
    portOffset, initialVelocity,
    spinAxis: new THREE.Vector3(1, 0.2, 0).normalize(),
    spinRate: 20,
    casing: CASING_SPECS["5.56x45"],
    scale: 1.0,
  };
}
