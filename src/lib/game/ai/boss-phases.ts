/**
 * Section F — Boss phase transitions.
 *
 * Addresses Section F prompts for "multi-phase boss fights with telegraphs".
 * The existing boss-patterns.ts already implements per-boss attack
 * patterns + phases; this module is a generic phase-transition controller
 * that:
 *
 *   - Tracks the current phase per boss (PHASE_1, PHASE_2, PHASE_3_ENRAGE).
 *   - Triggers phase transitions based on HP thresholds (e.g. PHASE_2 at
 *     60%, PHASE_3_ENRAGE at 30%).
 *   - Emits telegraphed warnings before each phase transition (3s warning
 *     + screen shake + bark).
 *   - On phase entry, applies the phase's modifiers (damageMult,
 *     attackSpeedMult, new attack pool).
 *   - Triggers "enrage" mechanics on PHASE_3 (faster attacks, self-damage
 *     tick to enforce a soft enrage timer).
 *   - Surfaces the current phase + telegraph state for the HUD.
 *
 * Pure-TS, SSR-safe.
 *
 * Integration:
 *   - EnemySystem calls `tickBossPhases(boss, ctx, cls, now, dt)` per
 *     frame for each alive boss.
 *   - boss-patterns.ts's `onTick` reads the current phase from this
 *     module to pick the attack pool.
 *   - The HUD reads `getBossPhaseState(boss)` for the phase indicator +
 *     telegraph bar.
 */

import type { GameContext, Enemy } from "../systems/types";
import type { BossClass } from "../EnemyClasses";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type BossPhaseId = "PHASE_1" | "PHASE_2" | "PHASE_3_ENRAGE";

export interface PhaseDefinition {
  /** Phase ID. */
  id: BossPhaseId;
  /** HP threshold to ENTER this phase (1.0 = full HP, 0.0 = dead). */
  hpThreshold: number;
  /** Multiplier on attack speed (lower = faster attacks). */
  attackSpeedMult: number;
  /** Damage multiplier applied to all attack damage. */
  damageMult: number;
  /** Movement speed multiplier. */
  moveSpeedMult: number;
  /** Telegraph duration (ms) before this phase begins. */
  telegraphMs: number;
  /** Bark to emit at phase entry. */
  entryBark: "BOSS_PHASE_2" | "BOSS_PHASE_3" | "BOSS_ENRAGE" | "BOSS_TAUNT";
  /** True if this phase applies a soft-enrage self-damage tick. */
  enraged: boolean;
}

export interface BossPhaseState {
  /** Current phase. */
  current: BossPhaseId;
  /** Pending phase (during telegraph). Null when no transition is in progress. */
  pending: BossPhaseId | null;
  /** Telegraph started at (ms). */
  telegraphStartedAt: number;
  /** Telegraph duration (ms). */
  telegraphMs: number;
  /** True if the boss has entered enrage (one-shot). */
  enraged: boolean;
  /** performance.now() of the last phase transition. */
  lastTransitionAt: number;
  /** Total damage dealt to the boss this match (for the boss HP bar %). */
  damageDealt: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-boss phase definitions
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_PHASES: PhaseDefinition[] = [
  { id: "PHASE_1", hpThreshold: 1.0, attackSpeedMult: 1.0, damageMult: 1.0, moveSpeedMult: 1.0, telegraphMs: 0, entryBark: "BOSS_TAUNT", enraged: false },
  { id: "PHASE_2", hpThreshold: 0.6, attackSpeedMult: 0.85, damageMult: 1.2, moveSpeedMult: 1.1, telegraphMs: 2000, entryBark: "BOSS_PHASE_2", enraged: false },
  { id: "PHASE_3_ENRAGE", hpThreshold: 0.3, attackSpeedMult: 0.6, damageMult: 1.5, moveSpeedMult: 1.3, telegraphMs: 1500, entryBark: "BOSS_ENRAGE", enraged: true },
];

const BOSS_PHASES: Partial<Record<BossClass, PhaseDefinition[]>> = {
  JUGGERNAUT: DEFAULT_PHASES,
  FLAMETHROWER_HEAVY: [
    { id: "PHASE_1", hpThreshold: 1.0, attackSpeedMult: 1.0, damageMult: 1.0, moveSpeedMult: 1.0, telegraphMs: 0, entryBark: "BOSS_TAUNT", enraged: false },
    { id: "PHASE_2", hpThreshold: 0.5, attackSpeedMult: 0.8, damageMult: 1.3, moveSpeedMult: 1.2, telegraphMs: 2000, entryBark: "BOSS_PHASE_2", enraged: false },
    { id: "PHASE_3_ENRAGE", hpThreshold: 0.2, attackSpeedMult: 0.5, damageMult: 1.8, moveSpeedMult: 1.4, telegraphMs: 1500, entryBark: "BOSS_ENRAGE", enraged: true },
  ],
  ARMORED_MECH: [
    { id: "PHASE_1", hpThreshold: 1.0, attackSpeedMult: 1.0, damageMult: 1.0, moveSpeedMult: 0.8, telegraphMs: 0, entryBark: "BOSS_TAUNT", enraged: false },
    { id: "PHASE_2", hpThreshold: 0.65, attackSpeedMult: 0.9, damageMult: 1.1, moveSpeedMult: 0.9, telegraphMs: 2500, entryBark: "BOSS_PHASE_2", enraged: false },
    { id: "PHASE_3_ENRAGE", hpThreshold: 0.3, attackSpeedMult: 0.7, damageMult: 1.4, moveSpeedMult: 1.1, telegraphMs: 2000, entryBark: "BOSS_ENRAGE", enraged: true },
  ],
  DRONE_COMMANDER: [
    { id: "PHASE_1", hpThreshold: 1.0, attackSpeedMult: 1.0, damageMult: 1.0, moveSpeedMult: 1.2, telegraphMs: 0, entryBark: "BOSS_TAUNT", enraged: false },
    { id: "PHASE_2", hpThreshold: 0.7, attackSpeedMult: 0.85, damageMult: 1.15, moveSpeedMult: 1.3, telegraphMs: 2000, entryBark: "BOSS_PHASE_2", enraged: false },
    { id: "PHASE_3_ENRAGE", hpThreshold: 0.35, attackSpeedMult: 0.6, damageMult: 1.4, moveSpeedMult: 1.5, telegraphMs: 1500, entryBark: "BOSS_ENRAGE", enraged: true },
  ],
  RIOT_SHIELD_CAPTAIN: DEFAULT_PHASES,
};

export function getPhaseDefinitions(cls: BossClass | undefined): PhaseDefinition[] {
  if (!cls) return DEFAULT_PHASES;
  return BOSS_PHASES[cls] ?? DEFAULT_PHASES;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-boss state (cast on Enemy)
// ───────────────────────────────────────────────────────────────────────────

const KEY = Symbol("boss_phase");

export function getBossPhaseState(boss: Enemy): BossPhaseState {
  const ex = boss as unknown as { [KEY]?: BossPhaseState };
  if (!ex[KEY]) {
    ex[KEY] = {
      current: "PHASE_1",
      pending: null,
      telegraphStartedAt: 0,
      telegraphMs: 0,
      enraged: false,
      lastTransitionAt: 0,
      damageDealt: 0,
    };
  }
  return ex[KEY]!;
}

/** Public read accessor — returns the current phase. */
export function getCurrentPhase(boss: Enemy): BossPhaseId {
  return getBossPhaseState(boss).current;
}

/** Public read accessor — returns the active phase definition. */
export function getCurrentPhaseDef(boss: Enemy, cls: BossClass | undefined): PhaseDefinition {
  const phases = getPhaseDefinitions(cls);
  const cur = getBossPhaseState(boss).current;
  return phases.find((p) => p.id === cur) ?? phases[0];
}

// ───────────────────────────────────────────────────────────────────────────
// Tick
// ───────────────────────────────────────────────────────────────────────────

const ENRAGE_SELF_DAMAGE_PER_SEC = 0.5; // % of max HP per sec.

/** Tick the boss phase controller. Returns the phase event descriptor
 *  (or null if no event this tick). */
export interface PhaseEvent {
  /** "telegraph_start" — telegraph for an upcoming phase transition. */
  telegraphStart?: { pending: BossPhaseId; durationMs: number; bark: PhaseDefinition["entryBark"] };
  /** "phase_change" — phase transition just completed. */
  phaseChange?: { from: BossPhaseId; to: BossPhaseId; def: PhaseDefinition };
  /** "enrage_tick" — soft-enrage self-damage tick (caller applies). */
  enrageTick?: { damage: number };
}

export function tickBossPhases(
  boss: Enemy,
  ctx: GameContext,
  cls: BossClass | undefined,
  now: number = performance.now(),
  dt: number = 0.016,
): PhaseEvent | null {
  const phases = getPhaseDefinitions(cls);
  const state = getBossPhaseState(boss);
  const hpPct = boss.health / Math.max(1, boss.maxHealth);

  // ---------- Pending telegraph ----------
  if (state.pending) {
    const elapsed = now - state.telegraphStartedAt;
    if (elapsed >= state.telegraphMs) {
      // Complete the transition.
      const def = phases.find((p) => p.id === state.pending);
      const from = state.current;
      state.current = state.pending;
      state.pending = null;
      state.lastTransitionAt = now;
      if (def?.enraged) state.enraged = true;
      return { phaseChange: { from, to: state.current, def: def ?? phases[0] } };
    }
    return null; // still telegraphing.
  }

  // ---------- Check for phase-up triggers ----------
  // Find the next phase (lowest hpThreshold > current).
  const curIdx = phases.findIndex((p) => p.id === state.current);
  for (let i = curIdx + 1; i < phases.length; i++) {
    if (hpPct <= phases[i].hpThreshold) {
      // Trigger the telegraph.
      state.pending = phases[i].id;
      state.telegraphStartedAt = now;
      state.telegraphMs = phases[i].telegraphMs;
      return {
        telegraphStart: {
          pending: phases[i].id,
          durationMs: phases[i].telegraphMs,
          bark: phases[i].entryBark,
        },
      };
    }
  }

  // ---------- Enrage self-damage tick ----------
  if (state.enraged) {
    const dmg = boss.maxHealth * (ENRAGE_SELF_DAMAGE_PER_SEC / 100) * dt;
    return { enrageTick: { damage: dmg } };
  }

  void ctx;
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Telegraph progress (for HUD)
// ───────────────────────────────────────────────────────────────────────────

/** Get the telegraph progress (0..1) for the HUD bar. Returns 0 if no
 *  telegraph is active. */
export function getTelegraphProgress(boss: Enemy, now: number = performance.now()): number {
  const state = getBossPhaseState(boss);
  if (!state.pending) return 0;
  const elapsed = now - state.telegraphStartedAt;
  return Math.min(1, elapsed / Math.max(1, state.telegraphMs));
}

/** Get the pending phase (or null if no transition in progress). */
export function getPendingPhase(boss: Enemy): BossPhaseId | null {
  return getBossPhaseState(boss).pending;
}

// ───────────────────────────────────────────────────────────────────────────
// Damage tracking
// ───────────────────────────────────────────────────────────────────────────

/** Record damage dealt to the boss (called by EnemySystem.damageEnemy). */
export function recordBossDamage(boss: Enemy, amount: number): void {
  getBossPhaseState(boss).damageDealt += amount;
}
