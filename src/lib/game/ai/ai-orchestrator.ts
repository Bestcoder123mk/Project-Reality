/**
 * Section F — AI orchestrator (integration layer).
 *
 * Bundles the new Section F AI subsystems into a single tick entry point
 * the engine / EnemySystem can call. Mirrors the pattern of the existing
 * AI subsystems (director, squads, companion) wired on ctx.ai.*.
 *
 * The orchestrator is intentionally thin: it owns no game state beyond
 * the per-subsystem singletons (LearningAI, CoverSystem) and routes per-
 * frame ticks to the right subsystem. The actual per-enemy behavior is
 * implemented in the dedicated modules (suppression-response.ts, etc.).
 *
 * Integration:
 *   - Engine calls `initAIOrchestrator(ctx)` on match start (after the
 *     existing AI init in engine.ts).
 *   - Engine calls `tickAIOrchestrator(ctx, dt)` once per frame from the
 *     main loop (after the existing EnemySystem.update).
 *   - Engine calls `disposeAIOrchestrator()` on match end / restart.
 *
 * All hooks are guarded so a failure in any subsystem is contained (the
 * orchestrator logs a warning + continues — never crashes the match).
 *
 * Pure-TS, SSR-safe.
 */

import type { GameContext, Enemy } from "../systems/types";
import {
  LearningAI, getLearningAI, destroyLearningAI,
} from "./learning-ai";
import {
  DifficultyCalibrator, getDifficultyCalibrator,
} from "./difficulty-calibrator";
import {
  CoverSystem, getCoverSystem,
} from "./cover-system";
import {
  AcousticBus, ScentTrail,
} from "./perception-model";
import {
  tickMorale, recordMoraleEvent, type MoraleEvent,
} from "./morale-system";
import {
  tickBossPhases, recordBossDamage, type PhaseEvent,
} from "./boss-phases";
import type { EnemyClass } from "../EnemyClasses";
import type { BossClass } from "../EnemyClasses";

// ───────────────────────────────────────────────────────────────────────────
// Orchestrator state
// ───────────────────────────────────────────────────────────────────────────

export interface AIOrchestratorState {
  /** Per-match LearningAI instance (process-wide singleton). */
  learning: LearningAI;
  /** Per-match DifficultyCalibrator (persists across matches in localStorage). */
  calibrator: DifficultyCalibrator;
  /** Per-match CoverSystem (rebaked on level load). */
  cover: CoverSystem;
  /** Per-match AcousticBus (pushed by WeaponSystem, footsteps, etc.). */
  acoustic: AcousticBus;
  /** Per-match ScentTrail (pushed by the damage system when the player bleeds). */
  scent: ScentTrail;
  /** performance.now() of the last orchestrator tick. */
  lastTickAt: number;
  /** performance.now() of the last director-style 1Hz sub-tick. */
  lastSlowTickAt: number;
  /** True if the orchestrator has been initialized for this match. */
  initialized: boolean;
}

let _state: AIOrchestratorState | null = null;

/** Initialize the orchestrator for a new match. Idempotent — calling
 *  again re-initializes (the engine calls this on match start). */
export function initAIOrchestrator(ctx: GameContext): AIOrchestratorState {
  // Lazily create the per-match subsystems.
  const learning = getLearningAI();
  learning.reset();
  const calibrator = getDifficultyCalibrator();
  const cover = getCoverSystem();
  cover.dispose();
  cover.bake(ctx);
  const acoustic = new AcousticBus(128);
  const scent = new ScentTrail(64, 15_000);
  _state = {
    learning,
    calibrator,
    cover,
    acoustic,
    scent,
    lastTickAt: 0,
    lastSlowTickAt: 0,
    initialized: true,
  };
  // Expose the acoustic bus + scent trail on ctx via cast (other systems
  // read them through the same opaque api the cast exposes).
  (ctx as unknown as { acousticBus?: AcousticBus }).acousticBus = acoustic;
  (ctx as unknown as { scentTrail?: ScentTrail }).scentTrail = scent;
  (ctx as unknown as { coverSystem?: CoverSystem }).coverSystem = cover;
  return _state;
}

/** Dispose the orchestrator (called on match end / restart). */
export function disposeAIOrchestrator(): void {
  if (_state) {
    _state.cover.dispose();
    _state.learning.reset();
  }
  _state = null;
  destroyLearningAI();
}

/** Get the current orchestrator state (or null if not initialized). */
export function getAIOrchestrator(): AIOrchestratorState | null {
  return _state;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-frame tick
// ───────────────────────────────────────────────────────────────────────────

/** Tick the orchestrator. Called once per frame by the engine after
 *  EnemySystem.update. Updates all per-match AI subsystems. */
export function tickAIOrchestrator(ctx: GameContext, dt: number): void {
  if (!_state || !_state.initialized) return;
  const now = performance.now();
  _state.lastTickAt = now;
  const isNightFlag = isNightNow(ctx);

  // ---------- Per-enemy subsystems (always tick) ----------
  for (const enemy of ctx.enemies) {
    if (!enemy.alive) continue;
    const cls = enemyClassOf(enemy);
    // Morale tick.
    try {
      const nearbyCommander = hasNearbyCommander(enemy, ctx);
      tickMorale(enemy, cls, nearbyCommander, now, dt);
    } catch (err) {
      console.warn("[AIOrchestrator] morale tick failed:", err);
    }
    // Boss phase tick.
    if (isBoss(enemy)) {
      try {
        const bossCls = bossClassOf(enemy);
        const ev = tickBossPhases(enemy, ctx, bossCls, now, dt);
        if (ev?.enrageTick) {
          // Apply enrage self-damage.
          enemy.health = Math.max(0, enemy.health - ev.enrageTick.damage);
        }
      } catch (err) {
        console.warn("[AIOrchestrator] boss phase tick failed:", err);
      }
    }
  }

  // ---------- Slow sub-tick (1 Hz): learning + calibrator read ----------
  if (now - _state.lastSlowTickAt > 1000) {
    _state.lastSlowTickAt = now;
    try {
      _state.learning.tick(now);
    } catch (err) {
      console.warn("[AIOrchestrator] learning tick failed:", err);
    }
  }

  void isNightFlag;
}

// ───────────────────────────────────────────────────────────────────────────
// Event hooks (called by other systems)
// ───────────────────────────────────────────────────────────────────────────

/** Record that the player took damage (pays off pending learning tactics). */
export function notifyPlayerDamaged(): void {
  if (!_state) return;
  _state.learning.recordPlayerDamaged();
}

/** Record a player action observation for the learning AI. */
export function notifyPlayerAction(cat: Parameters<LearningAI["recordPlayerAction"]>[0]): void {
  if (!_state) return;
  _state.learning.recordPlayerAction(cat);
}

/** Record a morale event (ally died, commander present, etc.). */
export function notifyMoraleEvent(ev: MoraleEvent, enemies: Enemy[]): void {
  recordMoraleEvent(enemies, ev, (e) => enemyClassOf(e));
}

/** Record damage dealt to a boss (for the boss HP bar + phase tracking). */
export function notifyBossDamage(boss: Enemy, amount: number): void {
  recordBossDamage(boss, amount);
}

/** Record an acoustic event (footstep, gunshot, etc.). */
export function notifyAcousticEvent(ev: Parameters<AcousticBus["push"]>[0]): void {
  if (!_state) return;
  _state.acoustic.push(ev);
}

/** Record a scent marker (player blood drop). */
export function notifyScentMarker(x: number, z: number, intensity: number): void {
  if (!_state) return;
  _state.scent.drop(x, z, intensity, performance.now());
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers (mirror the cast-on-Enemy pattern used in enemy-tactics.ts)
// ───────────────────────────────────────────────────────────────────────────

function enemyClassOf(e: Enemy): EnemyClass | undefined {
  return (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
}

function bossClassOf(e: Enemy): BossClass | undefined {
  return (e as unknown as { bossClass?: BossClass }).bossClass;
}

function isBoss(e: Enemy): boolean {
  return !!(e as unknown as { isBoss?: boolean }).isBoss;
}

function hasNearbyCommander(e: Enemy, ctx: GameContext, radius: number = 15): boolean {
  for (const other of ctx.enemies) {
    if (other === e || !other.alive) continue;
    if (enemyClassOf(other) !== "COMMANDER") continue;
    if (other.group.position.distanceTo(e.group.position) <= radius) return true;
  }
  return false;
}

function isNightNow(ctx: GameContext): boolean {
  // Re-use the realism.isNight check if available; otherwise fall back to
  // the weather state's dayPhase.
  const w = ctx.weather as unknown as { dayPhase?: string };
  return w?.dayPhase === "night" || (ctx.weatherTime ?? 0) % 86400 > 64800;
}

// Re-export the PhaseEvent type so callers don't need to import from
// boss-phases.ts directly.
export type { PhaseEvent };
