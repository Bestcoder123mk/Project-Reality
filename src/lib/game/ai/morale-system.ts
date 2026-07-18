/**
 * Section F — Morale system.
 *
 * Addresses Section F prompts for "enemy morale affecting aggression and
 * retreat". The existing ai-enhancements-d.ts has a `morale?: number`
 * field on the SectionDAIState, and EnemyFSM has a moraleBreak event;
 * this module is a dedicated morale system that:
 *
 *   - Tracks per-enemy morale (0..1, 1 = full morale).
 *   - Computes morale changes from events (ally died, ally retreated,
 *     player killed multiple allies in quick succession, enemy is
 *     wounded, enemy is suppressed, commander is present, outnumbered).
 *   - Maps morale to behavioral modifiers:
 *       - High morale (>0.7): +accuracy, +aggression, immune to panic.
 *       - Mid morale (0.4..0.7): normal behavior.
 *       - Low morale (0.2..0.4): -accuracy, cover-seeking + rally to
 *         commander if nearby.
 *       - Critical morale (<0.2): flee, surrender, or suicidal last-stand
 *         (depending on class + health).
 *   - Commander rally aura: commanders periodically emit a +morale pulse
 *     to nearby allies.
 *   - Squad-wide morale: a squad's morale is the average of its members;
 *     when squad morale drops below 0.3, the whole squad retreats.
 *
 * Pure-TS, SSR-safe.
 *
 * Integration:
 *   - The morale system is ticked once per frame by EnemySystem (or by
 *     the SquadCoordinator for squad-level morale).
 *   - Events are pushed via `recordEvent(...)`.
 *   - The FSM reads `getMorale(enemy)` + `getMoraleModifier(enemy)` to
 *     gate transitions (e.g. moraleBreak only fires when morale < 0.2).
 */

import type { Enemy } from "../systems/types";
import type { EnemyClass } from "../EnemyClasses";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type MoraleEventKind =
  | "ally_died"
  | "ally_retreated"
  | "ally_surrendered"
  | "player_killed_multi"   // player killed 2+ allies within 2s
  | "player_killed_ally"    // player killed one ally (single)
  | "wounded"               // this enemy took damage
  | "suppressed"            // this enemy is suppressed
  | "commander_present"     // a commander is nearby
  | "commander_died"        // the squad's commander died
  | "outnumbered"           // enemies < players (multiplayer future)
  | "rallied"               // commander rallied this enemy
  | "killed_player"         // this enemy killed the player
  | "flanked_player"        // this enemy successfully flanked the player
  | "ally_killed_player";   // an ally killed the player (squad-wide boost)

export interface MoraleEvent {
  kind: MoraleEventKind;
  /** Affected enemy (or null for squad-wide). */
  enemyId: string | null;
  /** Squad ID (or null for solo). */
  squadId: number | null;
  /** Timestamp. */
  at: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-enemy morale state (cast on Enemy)
// ───────────────────────────────────────────────────────────────────────────

export interface MoraleState {
  /** Current morale 0..1 (1 = full). */
  morale: number;
  /** Recent events affecting this enemy (for decaying morale). */
  recentEvents: Array<{ kind: MoraleEventKind; at: number }>;
  /** Multiplier on accuracy from morale (0.7..1.2). */
  accuracyMult: number;
  /** Multiplier on aggression from morale (0.5..1.5). */
  aggressionMult: number;
  /** True if the enemy is currently in a "rallied" state (immune to
   *  morale break for the duration). */
  ralliedUntil: number;
  /** True if the enemy has surrendered. */
  surrendered: boolean;
  /** True if the enemy is in last-stand mode (suicidal). */
  lastStand: boolean;
}

const KEY = Symbol("morale");

export function getMoraleState(e: Enemy): MoraleState {
  const ex = e as unknown as { [KEY]?: MoraleState };
  if (!ex[KEY]) {
    ex[KEY] = {
      morale: 1.0,
      recentEvents: [],
      accuracyMult: 1.0,
      aggressionMult: 1.0,
      ralliedUntil: 0,
      surrendered: false,
      lastStand: false,
    };
  }
  return ex[KEY]!;
}

/** Public read accessor — returns the raw morale value (0..1). */
export function getMorale(e: Enemy): number {
  return getMoraleState(e).morale;
}

/** Public read accessor — returns the behavioral modifiers. */
export function getMoraleModifier(e: Enemy): { accuracyMult: number; aggressionMult: number } {
  const s = getMoraleState(e);
  return { accuracyMult: s.accuracyMult, aggressionMult: s.aggressionMult };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-class morale profile
// ───────────────────────────────────────────────────────────────────────────

export interface MoraleProfile {
  /** Multiplier on morale loss per ally-death event. */
  allyDeathLossMult: number;
  /** Multiplier on morale gain from commander presence. */
  commanderGainMult: number;
  /** Threshold below which the enemy may moraleBreak (flee). */
  breakThreshold: number;
  /** Threshold below which the enemy may surrender. */
  surrenderThreshold: number;
  /** True if the class never breaks (zombies, mind-controlled). */
  neverBreaks: boolean;
  /** True if the class prefers last-stand over surrender (zealots). */
  prefersLastStand: boolean;
}

const DEFAULT_PROFILE: MoraleProfile = {
  allyDeathLossMult: 1.0,
  commanderGainMult: 1.0,
  breakThreshold: 0.25,
  surrenderThreshold: 0.15,
  neverBreaks: false,
  prefersLastStand: false,
};

const CLASS_PROFILES: Partial<Record<EnemyClass, Partial<MoraleProfile>>> = {
  RIFLEMAN: {},
  SNIPER: { breakThreshold: 0.2, surrenderThreshold: 0.1 },
  MG: { allyDeathLossMult: 0.7, breakThreshold: 0.2 },
  CQB: { breakThreshold: 0.15, prefersLastStand: true },
  COMMANDER: { breakThreshold: 0.1, neverBreaks: false, prefersLastStand: true },
  ZOMBIE: { neverBreaks: true, breakThreshold: 0, surrenderThreshold: 0 },
  MEDIC: { breakThreshold: 0.3, surrenderThreshold: 0.2 },
  SHIELD: { breakThreshold: 0.2 },
  SCOUT: { breakThreshold: 0.35, surrenderThreshold: 0.25 },
  SHOTGUNNER: { breakThreshold: 0.15, prefersLastStand: true },
};

export function getMoraleProfile(cls: EnemyClass | undefined): MoraleProfile {
  if (!cls) return { ...DEFAULT_PROFILE };
  return { ...DEFAULT_PROFILE, ...(CLASS_PROFILES[cls] ?? {}) };
}

// ───────────────────────────────────────────────────────────────────────────
// Event recording + morale recomputation
// ───────────────────────────────────────────────────────────────────────────

/** Per-event morale deltas. */
const EVENT_DELTAS: Record<MoraleEventKind, number> = {
  ally_died: -0.12,
  ally_retreated: -0.05,
  ally_surrendered: -0.08,
  player_killed_multi: -0.20,
  player_killed_ally: -0.08,
  wounded: -0.04,
  suppressed: -0.02,
  commander_present: +0.03,
  commander_died: -0.25,
  outnumbered: -0.05,
  rallied: +0.30,
  killed_player: +0.50,
  flanked_player: +0.10,
  ally_killed_player: +0.15,
};

/** Record an event + apply the morale delta to the affected enemy
 *  (or all squad members if `enemyId` is null). */
export function recordMoraleEvent(
  enemies: Enemy[],
  ev: MoraleEvent,
  cls: (e: Enemy) => EnemyClass | undefined,
): void {
  const delta = EVENT_DELTAS[ev.kind] ?? 0;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (ev.enemyId !== null && e.id !== ev.enemyId) continue;
    const profile = getMoraleProfile(cls(e));
    if (profile.neverBreaks && ev.kind !== "killed_player" && ev.kind !== "flanked_player") continue;
    const state = getMoraleState(e);
    // Apply profile multiplier to negative events.
    let applied = delta;
    if (delta < 0 && ev.kind === "ally_died") {
      applied = delta * profile.allyDeathLossMult;
    }
    if (delta > 0 && ev.kind === "commander_present") {
      applied = delta * profile.commanderGainMult;
    }
    state.morale = clamp01(state.morale + applied);
    state.recentEvents.push({ kind: ev.kind, at: ev.at });
    // Cap recent events memory.
    if (state.recentEvents.length > 16) state.recentEvents.shift();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tick
// ───────────────────────────────────────────────────────────────────────────

const RALLIED_DURATION_MS = 4000;
const COMMANDER_RALLY_RADIUS_M = 15;
const COMMANDER_RALLY_INTERVAL_MS = 5000;
const MORALE_REGEN_PER_SEC = 0.02; // slow regen when no negative events.
const RECENT_EVENT_DECAY_MS = 8000;

/** Tick the morale system for one enemy. Updates the morale + behavioral
 *  modifiers + status flags. */
export function tickMorale(
  enemy: Enemy,
  cls: EnemyClass | undefined,
  nearbyCommander: boolean,
  now: number = performance.now(),
  dt: number = 0.016,
): MoraleState {
  const profile = getMoraleProfile(cls);
  const state = getMoraleState(enemy);

  // Prune old events.
  if (state.recentEvents.length > 0) {
    state.recentEvents = state.recentEvents.filter((e) => now - e.at < RECENT_EVENT_DECAY_MS);
  }

  // Slow regen when no recent negative events.
  const hasRecentNegative = state.recentEvents.some((e) =>
    EVENT_DELTAS[e.kind] < 0 && now - e.at < RECENT_EVENT_DECAY_MS);
  if (!hasRecentNegative && !profile.neverBreaks) {
    state.morale = clamp01(state.morale + MORALE_REGEN_PER_SEC * dt);
  }

  // Commander rally — periodic +morale pulse to nearby allies.
  if (nearbyCommander && now > state.ralliedUntil) {
    state.morale = clamp01(state.morale + 0.05);
    state.ralliedUntil = now + RALLIED_DURATION_MS;
  }

  // Recompute modifiers from the current morale.
  // accuracyMult: 0.7..1.2 (low morale = -30% accuracy).
  state.accuracyMult = clamp(0.7 + state.morale * 0.5, 0.7, 1.2);
  // aggressionMult: 0.5..1.5 (low morale = -50% aggression).
  state.aggressionMult = clamp(0.5 + state.morale * 1.0, 0.5, 1.5);

  // Status flags.
  if (profile.neverBreaks) {
    state.surrendered = false;
    state.lastStand = false;
    return state;
  }
  // Rallied state grants temporary immunity.
  if (now < state.ralliedUntil) {
    state.surrendered = false;
    state.lastStand = false;
    return state;
  }
  // Critical morale → surrender OR last-stand (depending on profile + health).
  if (state.morale < profile.surrenderThreshold && !state.surrendered && !state.lastStand) {
    if (profile.prefersLastStand || (enemy.health / Math.max(1, enemy.maxHealth)) < 0.2) {
      state.lastStand = true;
    } else {
      state.surrendered = true;
    }
  }
  // Recover from surrender if morale recovers.
  if (state.surrendered && state.morale > 0.4) {
    state.surrendered = false;
  }
  // Last-stand is permanent (until death).
  return state;
}

// ───────────────────────────────────────────────────────────────────────────
// Squad-wide morale
// ───────────────────────────────────────────────────────────────────────────

/** Compute the average morale of a squad (alive members only). */
export function squadMorale(members: Enemy[]): number {
  const alive = members.filter((m) => m.alive);
  if (alive.length === 0) return 0;
  let sum = 0;
  for (const m of alive) sum += getMoraleState(m).morale;
  return sum / alive.length;
}

/** True if the squad should retreat (squad morale < 0.3 AND no
 *  commander alive in the squad). */
export function shouldSquadRetreat(members: Enemy[]): boolean {
  if (members.length === 0) return false;
  const alive = members.filter((m) => m.alive);
  if (alive.length === 0) return true;
  const avg = squadMorale(alive);
  if (avg >= 0.3) return false;
  // Check if a commander is alive in the squad (he can hold them).
  const hasCommander = alive.some((m) => {
    const cls = (m as unknown as { enemyClass?: EnemyClass }).enemyClass;
    return cls === "COMMANDER";
  });
  return !hasCommander;
}

// ───────────────────────────────────────────────────────────────────────────
// Commander rally aura
// ───────────────────────────────────────────────────────────────────────────

/** Process the commander's rally aura for a single commander. Should be
 *  called once per commander per tick (throttled to ~0.2 Hz by the caller).
 *  Returns the number of allies rallied. */
export function processCommanderRally(
  commander: Enemy,
  allEnemies: Enemy[],
  now: number = performance.now(),
): number {
  let rallied = 0;
  const lastRallyAt = (commander as unknown as { __lastRallyAt?: number }).__lastRallyAt ?? 0;
  if (now - lastRallyAt < COMMANDER_RALLY_INTERVAL_MS) return 0;
  (commander as unknown as { __lastRallyAt?: number }).__lastRallyAt = now;
  for (const e of allEnemies) {
    if (e === commander || !e.alive) continue;
    const d = commander.group.position.distanceTo(e.group.position);
    if (d > COMMANDER_RALLY_RADIUS_M) continue;
    const state = getMoraleState(e);
    state.morale = clamp01(state.morale + 0.10);
    state.ralliedUntil = now + RALLIED_DURATION_MS;
    rallied++;
  }
  return rallied;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
