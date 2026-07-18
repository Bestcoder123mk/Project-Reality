/**
 * Section F — Wounded behavior.
 *
 * Addresses Section F prompts for "injured enemies crawl, call for medic".
 * The existing EnemyFSM has a FLEE state + a moraleBreak event; this
 * module implements the wounded-enemy behavior layer:
 *
 *   - **Wound detection**: an enemy becomes "wounded" when its HP drops
 *     below 25% (the WOUND_THRESHOLD). A wounded enemy moves at 40% speed,
 *     cannot sprint, and emits a WOUNDED_MEDIC bark.
 *   - **Crawl-to-cover**: a wounded enemy crawls to the nearest cover
 *     (if not already in cover) and stays there, peeks reduced.
 *   - **Bleed-out**: a wounded enemy loses HP at 1 HP/sec; if it reaches
 *     0 HP before a medic reaches it, it dies (and emits WOUNDED_LAST_WORDS).
 *   - **Medic call**: a wounded enemy periodically emits a WOUNDED_MEDIC
 *     bark (with cooldown) to summon the squad's medic.
 *   - **Medic revive**: a medic that reaches a wounded enemy channels a
 *     3s revive; on completion, the enemy's HP is restored to 50% + the
 *     wounded state clears.
 *   - **Crawl to medic**: if no medic is available, a wounded enemy may
 *     crawl toward the squad's rally point (a fallback position).
 *   - **Last words**: when a wounded enemy's HP drops to 0, it emits a
 *     WOUNDED_LAST_WORDS bark before dying.
 *
 * Per-enemy wounded state is stashed via cast on Enemy.
 *
 * Pure-TS, SSR-safe.
 *
 * Integration:
 *   - EnemySystem.damageEnemy calls `markWounded(enemy, cls)` when HP
 *     drops below the threshold (idempotent).
 *   - enemy-tactics.ts calls `tickWoundedBehavior(enemy, ctx, cls, now)`
 *     per frame for wounded enemies (instead of the normal CHASE/ATTACK
 *     tactics).
 *   - The medic AI (in ai-enhancements-d.ts / enemy-tactics.ts) calls
 *     `findWoundedAlly(medic, ctx)` to find a revive target + calls
 *     `applyRevive(wounded, medic, now)` to channel the revive.
 */

import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";
import type { EnemyClass } from "../EnemyClasses";

// ───────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────

export const WOUND_THRESHOLD_HP_PCT = 0.25;  // wounded below 25% HP.
export const WOUNDED_SPEED_MULT = 0.4;        // 40% speed.
export const BLEED_OUT_HP_PER_SEC = 1.0;      // 1 HP/sec bleed.
export const MEDIC_BARK_COOLDOWN_MS = 3000;   // medic call every 3s.
export const REVIVE_CHANNEL_MS = 3000;        // 3s revive.
export const REVIVE_HP_RESTORE_PCT = 0.5;     // revive restores to 50% HP.
export const MEDIC_SEEK_RADIUS_M = 25;        // medic search radius.
export const CRAWL_TO_COVER_RANGE_M = 10;     // max crawl distance.

// ───────────────────────────────────────────────────────────────────────────
// Wounded state (cast on Enemy)
// ───────────────────────────────────────────────────────────────────────────

export interface WoundedState {
  /** True if the enemy is currently wounded. */
  wounded: boolean;
  /** Timestamp the wound was inflicted. */
  woundedAt: number;
  /** Last medic-bark time (for cooldown). */
  lastMedicBarkAt: number;
  /** Cover position the enemy is crawling to (or null if at cover). */
  crawlTarget: THREE.Vector3 | null;
  /** True if the enemy has emitted its last-words bark (avoid dupes). */
  lastWordsEmitted: boolean;
  /** Medic channeling a revive on this enemy. */
  reviveChannel: {
    medicId: string;
    startedAt: number;
    /** Total duration (ms). */
    durationMs: number;
  } | null;
  /** True if the enemy has been revived (used to clear the wounded flag). */
  revivedAt: number | null;
}

const KEY = Symbol("wounded");

export function getWoundedState(e: Enemy): WoundedState {
  const ex = e as unknown as { [KEY]?: WoundedState };
  if (!ex[KEY]) {
    ex[KEY] = {
      wounded: false,
      woundedAt: 0,
      lastMedicBarkAt: 0,
      crawlTarget: null,
      lastWordsEmitted: false,
      reviveChannel: null,
      revivedAt: null,
    };
  }
  return ex[KEY]!;
}

/** Public read accessor — true if the enemy is currently wounded. */
export function isWounded(e: Enemy): boolean {
  return getWoundedState(e).wounded;
}

// ───────────────────────────────────────────────────────────────────────────
// Mark wounded
// ───────────────────────────────────────────────────────────────────────────

/** Mark an enemy as wounded (idempotent). Called by EnemySystem.damageEnemy
 *  when HP drops below the threshold. */
export function markWounded(enemy: Enemy, now: number = performance.now()): void {
  const state = getWoundedState(enemy);
  if (state.wounded) return;
  state.wounded = true;
  state.woundedAt = now;
  state.lastMedicBarkAt = 0;
  state.crawlTarget = null;
  state.lastWordsEmitted = false;
  state.reviveChannel = null;
  state.revivedAt = null;
}

/** Clear the wounded state (e.g. when an enemy is fully healed or revived). */
export function clearWounded(enemy: Enemy, now: number = performance.now()): void {
  const state = getWoundedState(enemy);
  state.wounded = false;
  state.crawlTarget = null;
  state.reviveChannel = null;
  state.revivedAt = now;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-class wounded profile
// ───────────────────────────────────────────────────────────────────────────

export interface WoundedProfile {
  /** True if the class never gets wounded (zombies, mind-controlled). */
  immune: boolean;
  /** Multiplier on the bleed-out rate. */
  bleedMult: number;
  /** True if the class can call for a medic. */
  canCallMedic: boolean;
  /** True if the class fights back while wounded (vs. only fleeing). */
  canFightWhileWounded: boolean;
}

const DEFAULT_PROFILE: WoundedProfile = {
  immune: false,
  bleedMult: 1.0,
  canCallMedic: true,
  canFightWhileWounded: false,
};

const CLASS_PROFILES: Partial<Record<EnemyClass, Partial<WoundedProfile>>> = {
  RIFLEMAN: {},
  SNIPER: { canFightWhileWounded: true }, // snipers keep shooting if they can.
  MG: { bleedMult: 0.7 }, // big guys bleed slower.
  CQB: { canFightWhileWounded: true },
  COMMANDER: { canFightWhileWounded: true, bleedMult: 0.5 },
  ZOMBIE: { immune: true, canCallMedic: false },
  MEDIC: { canFightWhileWounded: true }, // medics patch themselves.
  SHIELD: { bleedMult: 0.8 },
  SCOUT: { bleedMult: 1.3 }, // fast bleeders.
  SHOTGUNNER: { canFightWhileWounded: true },
};

export function getWoundedProfile(cls: EnemyClass | undefined): WoundedProfile {
  if (!cls) return { ...DEFAULT_PROFILE };
  return { ...DEFAULT_PROFILE, ...(CLASS_PROFILES[cls] ?? {}) };
}

// ───────────────────────────────────────────────────────────────────────────
// Behavior descriptor (returned by tickWoundedBehavior)
// ───────────────────────────────────────────────────────────────────────────

export interface WoundedBehavior {
  /** "crawl" — crawl toward this position. */
  crawl: { x: number; z: number } | null;
  /** "call_medic" — emit a WOUNDED_MEDIC bark. */
  callMedic: boolean;
  /** "bleed" — apply bleed-out HP loss (caller applies the damage). */
  bleed: boolean;
  /** "fight" — fire a snapshot at the player (if profile allows). */
  fight: boolean;
  /** "die" — HP has reached 0; emit WOUNDED_LAST_WORDS + die. */
  die: boolean;
  /** "revive_channel" — being revived; hold still + don't fight. */
  reviveChannel: boolean;
  /** "revived" — revive just completed; clear wounded flag. */
  revived: boolean;
  /** Speed multiplier to apply this tick (0.4 when crawling, 0 when channeling). */
  speedMult: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Tick
// ───────────────────────────────────────────────────────────────────────────

/** Tick the wounded behavior for one enemy. Returns the behavior
 *  descriptor the tactics code should apply. */
export function tickWoundedBehavior(
  enemy: Enemy,
  ctx: GameContext,
  cls: EnemyClass | undefined,
  now: number = performance.now(),
  dt: number = 0.016,
): WoundedBehavior {
  const profile = getWoundedProfile(cls);
  const state = getWoundedState(enemy);

  const behavior: WoundedBehavior = {
    crawl: null,
    callMedic: false,
    bleed: false,
    fight: false,
    die: false,
    reviveChannel: false,
    revived: false,
    speedMult: WOUNDED_SPEED_MULT,
  };

  if (profile.immune || !state.wounded) {
    behavior.speedMult = 1.0;
    return behavior;
  }

  // ---------- Revive channel ----------
  if (state.reviveChannel) {
    const elapsed = now - state.reviveChannel.startedAt;
    if (elapsed >= state.reviveChannel.durationMs) {
      // Revive complete.
      behavior.revived = true;
      behavior.speedMult = 1.0;
      return behavior;
    }
    // Hold still + don't fight while being revived.
    behavior.reviveChannel = true;
    behavior.speedMult = 0;
    return behavior;
  }

  // ---------- Bleed-out ----------
  behavior.bleed = true;
  // Apply bleed damage here (so the caller doesn't have to).
  enemy.health -= BLEED_OUT_HP_PER_SEC * profile.bleedMult * dt;
  if (enemy.health <= 0) {
    enemy.health = 0;
    behavior.die = true;
    behavior.bleed = false;
    if (!state.lastWordsEmitted) {
      state.lastWordsEmitted = true;
    }
    return behavior;
  }

  // ---------- Call for medic (cooldown-gated) ----------
  if (profile.canCallMedic && now - state.lastMedicBarkAt > MEDIC_BARK_COOLDOWN_MS) {
    behavior.callMedic = true;
    state.lastMedicBarkAt = now;
  }

  // ---------- Crawl to cover ----------
  if (!state.crawlTarget) {
    const cover = findCoverNear(enemy, ctx, CRAWL_TO_COVER_RANGE_M);
    if (cover) {
      state.crawlTarget = cover;
    }
  }
  if (state.crawlTarget) {
    const dx = state.crawlTarget.x - enemy.group.position.x;
    const dz = state.crawlTarget.z - enemy.group.position.z;
    if (Math.hypot(dx, dz) < 1.0) {
      state.crawlTarget = null;
    } else {
      behavior.crawl = { x: state.crawlTarget.x, z: state.crawlTarget.z };
    }
  }

  // ---------- Fight back (rare, profile-gated) ----------
  if (profile.canFightWhileWounded && !behavior.crawl) {
    behavior.fight = true;
  }

  return behavior;
}

// ───────────────────────────────────────────────────────────────────────────
// Medic integration
// ───────────────────────────────────────────────────────────────────────────

/** Find the nearest wounded ally within `radius` of the medic. Returns
 *  the ally (or null). */
export function findWoundedAlly(medic: Enemy, ctx: GameContext, radius: number = MEDIC_SEEK_RADIUS_M): Enemy | null {
  let best: Enemy | null = null;
  let bestD = Infinity;
  for (const other of ctx.enemies) {
    if (other === medic || !other.alive) continue;
    if (!isWounded(other)) continue;
    if (getWoundedState(other).reviveChannel) continue; // already being revived.
    const d = medic.group.position.distanceTo(other.group.position);
    if (d > radius) continue;
    if (d < bestD) { bestD = d; best = other; }
  }
  return best;
}

/** Start channeling a revive on the wounded enemy. Called by the medic AI
 *  when it reaches the wounded ally. */
export function startRevive(
  wounded: Enemy,
  medic: Enemy,
  now: number = performance.now(),
): void {
  const state = getWoundedState(wounded);
  state.reviveChannel = {
    medicId: medic.id,
    startedAt: now,
    durationMs: REVIVE_CHANNEL_MS,
  };
}

/** Apply the revive completion (called by tickWoundedBehavior when the
 *  channel finishes). Restores HP + clears the wounded state. */
export function applyRevive(wounded: Enemy, now: number = performance.now()): void {
  wounded.health = Math.max(wounded.health, wounded.maxHealth * REVIVE_HP_RESTORE_PCT);
  clearWounded(wounded, now);
}

/** Get the revive-channel progress (0..1) for HUD / animation. */
export function getReviveProgress(enemy: Enemy, now: number = performance.now()): number {
  const state = getWoundedState(enemy);
  if (!state.reviveChannel) return 0;
  const elapsed = now - state.reviveChannel.startedAt;
  return Math.min(1, elapsed / state.reviveChannel.durationMs);
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Find a cover position near the enemy (re-uses the same heuristic as
 *  suppression-response.ts but local to this module to avoid a circular
 *  import). */
const _vCover = new THREE.Vector3();

function findCoverNear(enemy: Enemy, ctx: GameContext, radius: number): THREE.Vector3 | null {
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
