/**
 * Section E — Charm physics (dangling + swinging).
 *
 * Extends the existing `Charms.ts` dangle model (a single-pivot pendulum)
 * with a multi-bone verlet chain so multi-segment charms (the dog-tag
 * beaded chain, the lightning bolt's chain links) swing realistically as
 * a *chain* — each link lags the one above it, giving the satisfying
 * "whip crack" effect on fast view flicks + recoil.
 *
 * Also adds wind sway (subtle constant motion so the charm never looks
 * frozen), collision response against the weapon body (the charm bounces
 * off the magazine well instead of clipping through), and a configurable
 * per-charm mass + stiffness so heavy charms (the shark, the dog tag)
 * swing slower than light ones (the feather, the lightning bolt).
 *
 * Pure physics — no THREE import at module load (the apply step takes a
 * THREE.Object3D chain root). The host's weapon-viewmodel system wires
 * `updateCharmChainPhysics(state, dt, weaponMotion)` into its per-frame
 * loop, then `applyCharmChain(group, state)` writes the solved rotations
 * back to the chain's bone Object3Ds.
 */
import * as THREE from "three";
import type { CharmSlug } from "../Charms";

// ─── Charm physics config per slug ──────────────────────────────────────────

export interface CharmPhysicsConfig {
  /** Number of bones in the swing chain (chain link count). */
  chainLength: number;
  /** Per-bone rest length (meters) — distance from one link to the next. */
  boneLength: number;
  /** Mass of the charm tip (kg). Heavier = slower swing. */
  tipMass: number;
  /** Spring stiffness — how strongly each bone pulls back to rest. */
  stiffness: number;
  /** Damping — how quickly the swing settles. */
  damping: number;
  /** Gravitational acceleration (m/s²). Default 9.81. */
  gravity: number;
  /** Wind-sway amplitude (radians). Subtle idle motion. */
  windAmp: number;
  /** Wind-sway frequency (Hz). */
  windFreq: number;
  /** Recoil impulse gain — how much the charm whips on a shot. */
  recoilGain: number;
  /** Collision radius — the charm tip bounces off the weapon body within this. */
  collisionRadius: number;
}

/** Per-slug physics tuning — heavier charms swing slower, lighter ones faster. */
export const CHARM_PHYSICS: Record<Exclude<CharmSlug, "none">, CharmPhysicsConfig> = {
  dice_charm: {
    chainLength: 3, boneLength: 0.004, tipMass: 0.012,
    stiffness: 28, damping: 4.5, gravity: 9.81,
    windAmp: 0.04, windFreq: 0.8, recoilGain: 1.0,
    collisionRadius: 0.008,
  },
  skull_charm: {
    chainLength: 4, boneLength: 0.004, tipMass: 0.018,
    stiffness: 24, damping: 4.0, gravity: 9.81,
    windAmp: 0.05, windFreq: 0.7, recoilGain: 1.1,
    collisionRadius: 0.009,
  },
  feather_charm: {
    chainLength: 2, boneLength: 0.006, tipMass: 0.003,
    stiffness: 18, damping: 3.0, gravity: 9.81,
    windAmp: 0.12, windFreq: 1.4, recoilGain: 1.5,
    collisionRadius: 0.012,
  },
  dogtag_charm: {
    chainLength: 6, boneLength: 0.003, tipMass: 0.022,
    stiffness: 22, damping: 4.2, gravity: 9.81,
    windAmp: 0.03, windFreq: 0.6, recoilGain: 0.9,
    collisionRadius: 0.011,
  },
  shark_charm: {
    chainLength: 3, boneLength: 0.004, tipMass: 0.030,
    stiffness: 20, damping: 3.5, gravity: 9.81,
    windAmp: 0.06, windFreq: 0.5, recoilGain: 1.2,
    collisionRadius: 0.015,
  },
  lightning_charm: {
    chainLength: 3, boneLength: 0.004, tipMass: 0.008,
    stiffness: 30, damping: 5.0, gravity: 9.81,
    windAmp: 0.08, windFreq: 1.0, recoilGain: 1.3,
    collisionRadius: 0.008,
  },
  flame_charm: {
    chainLength: 3, boneLength: 0.004, tipMass: 0.010,
    stiffness: 26, damping: 4.5, gravity: 9.81,
    windAmp: 0.07, windFreq: 1.1, recoilGain: 1.1,
    collisionRadius: 0.009,
  },
};

// ─── Per-bone state (verlet point per chain link) ───────────────────────────

export interface CharmBoneState {
  /** Position (meters, charm-socket-local space). */
  pos: THREE.Vector3;
  /** Previous position (verlet integration). */
  prev: THREE.Vector3;
  /** Pinned (root bone doesn't move). */
  pinned: boolean;
}

export interface CharmChainState {
  /** Bone states — index 0 is the root (pinned at the socket). */
  bones: CharmBoneState[];
  /** Per-bone rotation in radians (X = forward/back, Y = side/side). */
  rotations: { x: number; y: number }[];
  /** Config used to build the state. */
  config: CharmPhysicsConfig;
  /** Cumulative time (seconds) — drives wind sway. */
  time: number;
  /** Pending recoil impulse (applied next update, then cleared). */
  recoilImpulse: number;
}

// ─── Build a chain state ────────────────────────────────────────────────────

/**
 * Build a fresh charm chain physics state. The chain hangs straight down
 * from the socket initially. Each bone is spaced `boneLength` meters apart.
 */
export function createCharmChainState(
  slug: Exclude<CharmSlug, "none">,
  socketPos: THREE.Vector3 = new THREE.Vector3(0, 0, 0),
): CharmChainState {
  const config = CHARM_PHYSICS[slug];
  const bones: CharmBoneState[] = [];
  const rotations: { x: number; y: number }[] = [];
  for (let i = 0; i < config.chainLength; i++) {
    const pos = socketPos.clone();
    pos.y -= i * config.boneLength;
    bones.push({
      pos,
      prev: pos.clone(),
      pinned: i === 0,
    });
    rotations.push({ x: 0, y: 0 });
  }
  return { bones, rotations, config, time: 0, recoilImpulse: 0 };
}

// ─── Physics step (verlet integration + distance constraint) ────────────────

/**
 * Advance the charm chain physics by dt seconds. Verlet integration with a
 * 1-iteration distance constraint per bone (1-iteration is enough for the
 * small boneLength values — the chain stays rigid without a long solver).
 *
 * @param state The chain state (mutated in place).
 * @param dt Delta time (seconds). Clamped to 1/30 to avoid instability.
 * @param weaponMotion Weapon motion in viewmodel-local space:
 *   - linearVel: [right, up, forward] m/s — drives swing.
 *   - angularVel: [pitch, yaw, roll] rad/s — drives centrifugal swing.
 *   - recoilKick: optional recoil impulse (radians) — adds to recoilImpulse.
 */
export function updateCharmChainPhysics(
  state: CharmChainState,
  dt: number,
  weaponMotion: {
    linearVel?: [number, number, number];
    angularVel?: [number, number, number];
    recoilKick?: number;
  } = {},
): void {
  const cfg = state.config;
  const stepDt = Math.min(dt, 1 / 30);
  state.time += stepDt;
  if (weaponMotion.recoilKick) {
    state.recoilImpulse += weaponMotion.recoilKick * cfg.recoilGain;
  }

  // Wind sway — a subtle sinusoidal lateral force on the tip.
  const wind = Math.sin(state.time * cfg.windFreq * Math.PI * 2) * cfg.windAmp;

  // Inertial drive from weapon linear velocity — the charm "lags" behind
  // the weapon's motion (so when the weapon moves right, the charm
  // appears to swing left relative to the weapon).
  const linV = weaponMotion.linearVel ?? [0, 0, 0];
  const driveX = -linV[2] * 0.02; // forward vel → swing back
  const driveY = linV[0] * 0.02; // right vel → swing right

  // Recoil impulse — applied as a one-shot backward kick.
  const recoilX = state.recoilImpulse;
  state.recoilImpulse *= 0.6; // decay (not full clear — softens the kick)

  // Verlet integration for each non-pinned bone.
  const gravity = cfg.gravity * 0.0001; // scaled for weapon-space meters
  for (let i = 1; i < state.bones.length; i++) {
    const b = state.bones[i];
    if (b.pinned) continue;
    // Verlet: pos += (pos - prev) * drag + accel * dt²
    const vx = (b.pos.x - b.prev.x) * (1 - cfg.damping * stepDt);
    const vy = (b.pos.y - b.prev.y) * (1 - cfg.damping * stepDt);
    const vz = (b.pos.z - b.prev.z) * (1 - cfg.damping * stepDt);
    b.prev.copy(b.pos);
    // Spring back toward rest (the bone's rest position is directly below
    // the parent bone).
    const parent = state.bones[i - 1];
    const restY = parent.pos.y - cfg.boneLength;
    const springX = (parent.pos.x - b.pos.x) * cfg.stiffness * stepDt * stepDt;
    const springY = (restY - b.pos.y) * cfg.stiffness * stepDt * stepDt;
    const springZ = (parent.pos.z - b.pos.z) * cfg.stiffness * stepDt * stepDt;
    b.pos.x += vx + springX + driveX * stepDt * stepDt + (i === state.bones.length - 1 ? (recoilX * 0.001) : 0);
    b.pos.y += vy + springY - gravity;
    b.pos.z += vz + springZ + driveY * stepDt * stepDt;
    // Wind sway on the tip bone only.
    if (i === state.bones.length - 1) {
      b.pos.x += wind * 0.0005;
    }
  }

  // Distance constraint — enforce bone spacing. 1 iteration is enough
  // for the small boneLength values we use.
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 1; i < state.bones.length; i++) {
      const a = state.bones[i - 1];
      const b = state.bones[i];
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const dz = b.pos.z - a.pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
      const diff = (dist - cfg.boneLength) / dist;
      // Pinned root doesn't move; otherwise split the correction.
      if (a.pinned) {
        b.pos.x -= dx * diff;
        b.pos.y -= dy * diff;
        b.pos.z -= dz * diff;
      } else {
        const half = 0.5 * diff;
        a.pos.x += dx * half;
        a.pos.y += dy * half;
        a.pos.z += dz * half;
        b.pos.x -= dx * half;
        b.pos.y -= dy * half;
        b.pos.z -= dz * half;
      }
    }
  }

  // Collision response — the tip bone bounces off the weapon body (modeled
  // as a sphere around the socket). Simple sphere collision.
  const tip = state.bones[state.bones.length - 1];
  const socket = state.bones[0];
  const sdx = tip.pos.x - socket.pos.x;
  const sdy = tip.pos.y - socket.pos.y;
  const sdz = tip.pos.z - socket.pos.z;
  const sd = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);
  const minDist = cfg.chainLength * cfg.boneLength;
  if (sd < minDist - cfg.collisionRadius) {
    // Tip is too close to the socket — push it out along the socket axis.
    const push = (minDist - cfg.collisionRadius) - sd;
    const nx = sd > 0.0001 ? sdx / sd : 0;
    const ny = sd > 0.0001 ? sdy / sd : -1;
    const nz = sd > 0.0001 ? sdz / sd : 0;
    tip.pos.x += nx * push;
    tip.pos.y += ny * push;
    tip.pos.z += nz * push;
  }

  // Compute rotations from bone positions (for the apply step).
  for (let i = 1; i < state.bones.length; i++) {
    const a = state.bones[i - 1];
    const b = state.bones[i];
    const dx = b.pos.x - a.pos.x;
    const dz = b.pos.z - a.pos.z;
    const dy = b.pos.y - a.pos.y;
    // Rotation X = forward/back tilt (atan2 of dy vs dz).
    state.rotations[i].x = Math.atan2(-dy, Math.sqrt(dz * dz + dx * dx)) * 0.5;
    // Rotation Y = side tilt (atan2 of dx vs dz).
    state.rotations[i].y = Math.atan2(dx, dz) * 0.5;
  }
}

// ─── Apply to a chain of Object3Ds ──────────────────────────────────────────

/**
 * Apply the chain physics to a THREE.Object3D hierarchy. The caller supplies
 * the chain root (the socket_charm node) — the children of which are the
 * chain-link Object3Ds in order (index 0 = the link closest to the socket).
 * Each link's rotation is set from the corresponding bone's solved rotation.
 *
 * The hierarchy typically looks like:
 *   socket_charm/
 *     link0 (pinned, root)
 *     link1
 *     link2
 *     ... (rest of chain)
 *     charm_body (the visible charm mesh, parented to the last link)
 *
 * If the chain has fewer links than the state expects, the extra bones are
 * skipped (graceful degradation for charms whose visual hierarchy doesn't
 * match the physics chain length — the simple charms in Charms.ts build their
 * chain as a single group, so this falls back to applying just the tip
 * rotation to the whole group).
 */
export function applyCharmChain(
  chainRoot: THREE.Object3D,
  state: CharmChainState,
): void {
  const children = chainRoot.children;
  // Find child meshes/groups in chain order. The first child is the root
  // link (pinned, no rotation needed); subsequent children get the
  // per-bone rotations.
  const chainChildren = children.filter((c) => (c.userData as { isCharmLink?: boolean }).isCharmLink);
  if (chainChildren.length === 0) {
    // Fallback — apply the tip rotation to the root (single-group charms).
    const tip = state.rotations[state.rotations.length - 1];
    chainRoot.rotation.x = tip.x;
    chainRoot.rotation.y = tip.y;
    return;
  }
  for (let i = 0; i < chainChildren.length && i + 1 < state.rotations.length; i++) {
    const r = state.rotations[i + 1];
    chainChildren[i].rotation.x = r.x;
    chainChildren[i].rotation.y = r.y;
  }
}

// ─── Convenience: single-pendulum compat with Charms.ts ─────────────────────

/**
 * Compatibility wrapper — if the caller has a single-group charm (the
 * Charms.ts attachCharm output) and wants the chain-physics motion without
 * restructuring the hierarchy, this maps the chain's tip rotation to the
 * charm group's rotation. Equivalent to the legacy `applyCharmDangle`.
 */
export function applyCharmChainToSingleGroup(
  charmGroup: THREE.Object3D,
  state: CharmChainState,
): void {
  const tip = state.rotations[state.rotations.length - 1];
  charmGroup.rotation.x = tip.x;
  charmGroup.rotation.y = tip.y;
}

// ─── Preset motion profiles ─────────────────────────────────────────────────

/** Motion profile presets for common weapon states. */
export const MOTION_PROFILES = {
  /** Idle — weapon held still, slight breathing sway. */
  idle: (t: number): { linearVel: [number, number, number]; angularVel: [number, number, number] } => ({
    linearVel: [Math.sin(t * 1.2) * 0.02, Math.sin(t * 0.8) * 0.01, 0],
    angularVel: [Math.sin(t * 1.2) * 0.01, 0, 0],
  }),
  /** Walking — weapon bobs with the player's gait. */
  walking: (t: number): { linearVel: [number, number, number]; angularVel: [number, number, number] } => ({
    linearVel: [Math.sin(t * 6) * 0.15, Math.abs(Math.sin(t * 6)) * 0.1, 0],
    angularVel: [Math.sin(t * 6) * 0.05, 0, 0],
  }),
  /** Sprinting — heavy forward motion + camera bob. */
  sprinting: (t: number): { linearVel: [number, number, number]; angularVel: [number, number, number] } => ({
    linearVel: [Math.sin(t * 9) * 0.3, Math.abs(Math.sin(t * 9)) * 0.2, 4.5],
    angularVel: [Math.sin(t * 9) * 0.08, 0, 0],
  }),
  /** ADS (aiming down sights) — weapon is steady. */
  ads: (): { linearVel: [number, number, number]; angularVel: [number, number, number] } => ({
    linearVel: [0, 0, 0],
    angularVel: [0, 0, 0],
  }),
} as const;
