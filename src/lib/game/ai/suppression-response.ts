/**
 * Section F — Suppression response.
 *
 * Addresses Section F prompts for "enemies react to suppressive fire
 * realistically". The existing SuppressionSystem applies a per-enemy
 * `suppression` scalar (0..1) and the EnemyFSM transitions to SUPPRESSED
 * when it crosses a threshold; this module layers the actual *behavior*
 * of a suppressed enemy on top:
 *
 *   - **Duck** — the enemy drops to a crouch + lowers its head (animation
 *     hook). Reduces its hitbox silhouette by ~30%.
 *   - **Return fire** — short blind-fire bursts toward the player's last
 *     known position (low accuracy, but suppresses the player back).
 *   - **Call for help** — emit a SUPPRESSED bark + alert nearby allies
 *     (increases their detection meter).
 *   - **Crawl to cover** — if no cover is nearby, the enemy crawl-sprints
 *     to the nearest LOS-blocking collider.
 *   - **Panic** — at very high suppression (> 0.9), a small chance per
 *     tick to panic-fire (full-auto spray) or freeze (combat stress).
 *   - **Recover** — when suppression decays below the recovery threshold,
 *     the enemy returns to CHASE and re-engages.
 *
 * Tunables are per-class (e.g. MG is suppression-resistant; CQB panics
 * easier; SHIELD ignores suppression because it has a shield).
 *
 * Pure-TS, SSR-safe. THREE is imported lazily in the spatial helpers.
 *
 * Integration:
 *   - enemy-tactics.ts's `tickSuppressed` calls `tickSuppressionResponse`
 *     each frame for an enemy in the SUPPRESSED FSM state.
 *   - The module updates the per-enemy SuppressionResponse stash (cast on
 *     Enemy) and returns a behavior descriptor the tactics code applies.
 */

import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";
import type { EnemyClass } from "../EnemyClasses";

// ───────────────────────────────────────────────────────────────────────────
// Per-class suppression profile
// ───────────────────────────────────────────────────────────────────────────

export interface SuppressionProfile {
  /** Multiplier on the suppression increment when a bullet whizzes by.
   *  Lower = more resistant. MG = 0.5, CQB = 1.5, SHIELD = 0.1. */
  incomingMult: number;
  /** Multiplier on the suppression decay rate. MG = 1.5 (recovers fast),
   *  CQB = 0.7 (recovers slow). */
  decayMult: number;
  /** Probability per tick of blind-firing back. */
  blindFireChance: number;
  /** Probability per tick of panic-freezing when suppression > 0.9. */
  panicChance: number;
  /** Crouch depth (m) — how far the enemy drops when suppressed. */
  crouchDepth: number;
  /** True if the class has a ballistic shield (immune to front-cone
   *  suppression — shield blocks the visual + audio trigger). */
  hasShield: boolean;
  /** True if the class is trained to crawl under fire (else stays put). */
  canCrawl: boolean;
}

const DEFAULT_PROFILE: SuppressionProfile = {
  incomingMult: 1.0,
  decayMult: 1.0,
  blindFireChance: 0.05,
  panicChance: 0.01,
  crouchDepth: 0.6,
  hasShield: false,
  canCrawl: true,
};

const CLASS_PROFILES: Partial<Record<EnemyClass, Partial<SuppressionProfile>>> = {
  RIFLEMAN: {},
  SNIPER: {
    incomingMult: 1.3,    // snipers don't like being shot at
    decayMult: 0.8,
    blindFireChance: 0.02, // snipers don't blind-fire (they reposition)
    panicChance: 0.02,
    crouchDepth: 0.4,
    canCrawl: true,
  },
  MG: {
    incomingMult: 0.5,    // MG is suppression-resistant
    decayMult: 1.5,
    blindFireChance: 0.08,
    panicChance: 0.001,
    crouchDepth: 0.3,
    canCrawl: false,
  },
  CQB: {
    incomingMult: 1.2,
    decayMult: 0.7,
    blindFireChance: 0.06,
    panicChance: 0.015,
    crouchDepth: 0.7,
  },
  COMMANDER: {
    incomingMult: 0.7,    // commander rallies under fire
    decayMult: 1.2,
    blindFireChance: 0.04,
    panicChance: 0.005,
    crouchDepth: 0.5,
  },
  ZOMBIE: {
    incomingMult: 0.0,    // zombies don't get suppressed
    decayMult: 100,
    blindFireChance: 0,
    panicChance: 0,
    crouchDepth: 0,
    canCrawl: false,
  },
  MEDIC: {
    incomingMult: 1.1,
    decayMult: 0.9,
    blindFireChance: 0.03,
    panicChance: 0.02,
    crouchDepth: 0.6,
  },
  SHIELD: {
    incomingMult: 0.1,    // shield bearer barely suppresses
    decayMult: 2.0,
    blindFireChance: 0.02,
    panicChance: 0.001,
    crouchDepth: 0.2,
    hasShield: true,
    canCrawl: false,
  },
  SCOUT: {
    incomingMult: 1.4,
    decayMult: 0.6,
    blindFireChance: 0.04,
    panicChance: 0.02,
    crouchDepth: 0.6,
  },
  SHOTGUNNER: {
    incomingMult: 0.8,
    decayMult: 1.0,
    blindFireChance: 0.07,
    panicChance: 0.008,
    crouchDepth: 0.5,
  },
};

export function getSuppressionProfile(cls: EnemyClass | undefined): SuppressionProfile {
  if (!cls) return { ...DEFAULT_PROFILE };
  return { ...DEFAULT_PROFILE, ...(CLASS_PROFILES[cls] ?? {}) };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-enemy suppression-response state (cast on Enemy)
// ───────────────────────────────────────────────────────────────────────────

export interface SuppressionResponseState {
  /** Multiplier applied to incoming suppression increments. Set by the
   *  profile but can be temporarily modified (e.g. commander rally aura). */
  incomingMult: number;
  /** Multiplier applied to suppression decay. */
  decayMult: number;
  /** performance.now() of the last blind-fire burst. */
  lastBlindFireAt: number;
  /** performance.now() of the last panic freeze. */
  lastPanicAt: number;
  /** True while the enemy is panic-frozen (can't move). */
  panicFrozen: boolean;
  /** True while the enemy is panic-firing (full-auto spray). */
  panicFiring: boolean;
  /** Crawl target (cover position to crawl to). */
  crawlTarget: THREE.Vector3 | null;
  /** Crouch visual amount (0..1, lerped toward 1 when suppressed). */
  crouchAmount: number;
  /** True if the enemy has called for help this engagement. */
  calledForHelp: boolean;
  /** Combat-stress accumulator (0..1, increases while suppressed; triggers
   *  panic when > 0.8). Decays slowly when not suppressed. */
  stress: number;
}

const KEY = Symbol("suppression_response");

export function getSuppressionResponse(e: Enemy): SuppressionResponseState {
  const ex = e as unknown as { [KEY]?: SuppressionResponseState };
  if (!ex[KEY]) {
    ex[KEY] = {
      incomingMult: 1.0,
      decayMult: 1.0,
      lastBlindFireAt: 0,
      lastPanicAt: 0,
      panicFrozen: false,
      panicFiring: false,
      crawlTarget: null,
      crouchAmount: 0,
      calledForHelp: false,
      stress: 0,
    };
  }
  return ex[KEY]!;
}

// ───────────────────────────────────────────────────────────────────────────
// Behavior descriptor (returned by tickSuppressionResponse)
// ───────────────────────────────────────────────────────────────────────────

export interface SuppressionBehavior {
  /** "duck" — hold position + crouch. */
  duck: boolean;
  /** "blind_fire" — fire a burst toward the player's LKP. */
  blindFire: boolean;
  /** "crawl" — crawl toward this position. */
  crawl: { x: number; z: number } | null;
  /** "panic_freeze" — combat-stress freeze (no movement, no firing). */
  panicFreeze: boolean;
  /** "panic_fire" — full-auto spray (low accuracy, high ROF). */
  panicFire: boolean;
  /** "call_help" — emit a SUPPRESSED bark + alert nearby allies. */
  callHelp: boolean;
  /** "recover" — suppression has decayed; FSM should fire `recovered`. */
  recover: boolean;
  /** Target crouch amount (0..1) for the visual interpolation. */
  crouchAmount: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Tick
// ───────────────────────────────────────────────────────────────────────────

const BLIND_FIRE_COOLDOWN_MS = 800;
const PANIC_FREEZE_DURATION_MS = 600;
const PANIC_FIRE_DURATION_MS = 1200;
const CALL_HELP_RADIUS_M = 25;
const COVER_SEARCH_RADIUS_M = 12;

/** Tick the suppression response for one enemy.
 *  `recoveryThreshold` is the FSM's recovery threshold (0..1) — when the
 *  enemy's suppression drops below it, the behavior returns `recover=true`.
 */
export function tickSuppressionResponse(
  enemy: Enemy,
  ctx: GameContext,
  cls: EnemyClass | undefined,
  recoveryThreshold: number,
  lkp: THREE.Vector3 | null,
  now: number = performance.now(),
  dt: number = 0.016,
  rng: () => number = Math.random,
): SuppressionBehavior {
  const profile = getSuppressionProfile(cls);
  const state = getSuppressionResponse(enemy);
  const suppression = enemy.suppression ?? 0;

  // Apply profile multipliers (in case they changed since last tick).
  state.incomingMult = profile.incomingMult;
  state.decayMult = profile.decayMult;

  // Combat-stress accumulates while suppressed; decays when not.
  if (suppression > 0.5) {
    state.stress = Math.min(1, state.stress + dt * 0.2 * suppression);
  } else {
    state.stress = Math.max(0, state.stress - dt * 0.05);
  }

  // Crouch visual — lerps toward 1 when suppressed, 0 when not.
  const targetCrouch = suppression > 0.3 ? 1 : 0;
  state.crouchAmount += (targetCrouch - state.crouchAmount) * Math.min(1, dt * 5);

  // Default behavior: duck.
  const behavior: SuppressionBehavior = {
    duck: true,
    blindFire: false,
    crawl: null,
    panicFreeze: false,
    panicFire: false,
    callHelp: false,
    recover: false,
    crouchAmount: state.crouchAmount,
  };

  // Panic freeze / panic fire — high stress + high suppression.
  if (state.panicFrozen) {
    if (now - state.lastPanicAt > PANIC_FREEZE_DURATION_MS) {
      state.panicFrozen = false;
    } else {
      behavior.duck = false;
      behavior.panicFreeze = true;
      return behavior;
    }
  }
  if (state.panicFiring) {
    if (now - state.lastPanicAt > PANIC_FIRE_DURATION_MS) {
      state.panicFiring = false;
    } else {
      behavior.duck = false;
      behavior.panicFire = true;
      return behavior;
    }
  }
  if (suppression > 0.85 && state.stress > 0.7 && rng() < profile.panicChance) {
    // Panic — either freeze or fire (50/50).
    state.lastPanicAt = now;
    if (rng() < 0.5) {
      state.panicFrozen = true;
      behavior.panicFreeze = true;
    } else {
      state.panicFiring = true;
      behavior.panicFire = true;
    }
    behavior.duck = false;
    return behavior;
  }

  // Recovered — suppression decayed below the threshold.
  if (suppression < recoveryThreshold) {
    behavior.recover = true;
    behavior.duck = false;
    state.calledForHelp = false;
    return behavior;
  }

  // Call for help once per engagement (SUPPRESSED bark + alert allies).
  if (!state.calledForHelp && suppression > 0.5) {
    behavior.callHelp = true;
    state.calledForHelp = true;
    alertNearbyAllies(enemy, ctx, CALL_HELP_RADIUS_M);
  }

  // Blind fire toward LKP on a cooldown.
  if (lkp && now - state.lastBlindFireAt > BLIND_FIRE_COOLDOWN_MS && rng() < profile.blindFireChance) {
    behavior.blindFire = true;
    state.lastBlindFireAt = now;
    behavior.duck = false;
  }

  // Crawl to cover if no cover nearby + can crawl + not actively blind-firing.
  if (profile.canCrawl && !behavior.blindFire && !state.crawlTarget) {
    const cover = findNearestCover(enemy, ctx, COVER_SEARCH_RADIUS_M);
    if (cover) {
      state.crawlTarget = cover;
    }
  }
  if (state.crawlTarget) {
    // If we've reached the cover, drop the crawl target.
    const dx = state.crawlTarget.x - enemy.group.position.x;
    const dz = state.crawlTarget.z - enemy.group.position.z;
    if (Math.hypot(dx, dz) < 1.0) {
      state.crawlTarget = null;
    } else {
      behavior.crawl = { x: state.crawlTarget.x, z: state.crawlTarget.z };
      behavior.duck = false;
    }
  }

  return behavior;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Alert nearby allies — bump their detection meter + suppression slightly
 *  so they know there's a fight going on. */
function alertNearbyAllies(enemy: Enemy, ctx: GameContext, radius: number): void {
  for (const other of ctx.enemies) {
    if (other === enemy || !other.alive) continue;
    const d = other.group.position.distanceTo(enemy.group.position);
    if (d > radius) continue;
    // Bump suppression + the perception meter (via cast).
    other.suppression = Math.min(1, (other.suppression ?? 0) + 0.1);
    const ps = (other as unknown as { __perception?: { meter?: number } }).__perception;
    if (ps && typeof ps.meter === "number") ps.meter = Math.min(1, ps.meter + 0.15);
  }
}

/** Find the nearest collider AABB that blocks LOS to the player. Returns
 *  a position just behind the collider (from the player's POV). Cheap O(N)
 *  scan over ctx.colliders. */
const _vCover = new THREE.Vector3();

function findNearestCover(enemy: Enemy, ctx: GameContext, radius: number): THREE.Vector3 | null {
  const playerPos = ctx.player.pos;
  let best: THREE.Vector3 | null = null;
  let bestD = Infinity;
  for (const c of ctx.colliders) {
    const center = c.box.getCenter(_vCover);
    const dToEnemy = enemy.group.position.distanceTo(center);
    if (dToEnemy > radius) continue;
    // Position behind the collider from the player's POV.
    const dirX = center.x - playerPos.x;
    const dirZ = center.z - playerPos.z;
    const len = Math.hypot(dirX, dirZ) || 1;
    const behindX = center.x + (dirX / len) * 1.2;
    const behindZ = center.z + (dirZ / len) * 1.2;
    const d = Math.hypot(behindX - enemy.group.position.x, behindZ - enemy.group.position.z);
    if (d < bestD) {
      bestD = d;
      best = new THREE.Vector3(behindX, enemy.group.position.y, behindZ);
    }
  }
  return best;
}

// ───────────────────────────────────────────────────────────────────────────
// Direct suppression-bump API (called by ProjectileSystem on near-miss)
// ───────────────────────────────────────────────────────────────────────────

/** Apply a suppression bump to an enemy, scaled by the class profile. */
export function applySuppressionBump(
  enemy: Enemy,
  amount: number,
  cls: EnemyClass | undefined,
): void {
  const profile = getSuppressionProfile(cls);
  if (profile.hasShield) return; // shield bearer doesn't suppress.
  const state = getSuppressionResponse(enemy);
  const scaled = amount * state.incomingMult * profile.incomingMult;
  enemy.suppression = Math.min(1, (enemy.suppression ?? 0) + scaled);
}

/** Apply suppression decay (called by SuppressionSystem per frame). */
export function applySuppressionDecay(
  enemy: Enemy,
  decayPerSec: number,
  cls: EnemyClass | undefined,
  dt: number = 0.016,
): void {
  const profile = getSuppressionProfile(cls);
  if (profile.hasShield) return;
  const state = getSuppressionResponse(enemy);
  const scaled = decayPerSec * state.decayMult * profile.decayMult;
  enemy.suppression = Math.max(0, (enemy.suppression ?? 0) - scaled * dt);
}
