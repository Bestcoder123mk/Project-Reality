/**
 * engine/lifecycle.ts — Match lifecycle concern (Task 3 / item 54).
 *
 * Extracted from the original engine.ts monolith. Owns the start/pause/resume/
 * dispose flow:
 *   - disposeEngine(e) — full teardown (rAF cancel, system dispose, listener
 *     removal, store callback unregister, wake-lock release).
 *
 * The start() / setPaused() / restart() methods stay on the GameEngine class
 * itself because they're tightly coupled to match-state reset (waves,
 * killstreaks, mode config) and would require a much larger interface to
 * extract cleanly. dispose() is the most mechanical teardown and benefits
 * most from isolation (it's the highest-risk method for leaks — every system
 * that owns GPU resources must be disposed here).
 */

import { useGameStore } from "../store";
import { acquireWakeLock } from "../platform/wake-lock";

/** Structural interface the lifecycle concern needs from the engine. */
export interface LifecycleEngineLike {
  ctx: {
    deployables?: { mesh: unknown }[] | null;
    timeScale: number;
  };
  rafId: number;
  _accumulator: number;
  _wakeLockRelease: (() => void) | null;
  _visibilityHandler: (() => void) | null;
  _pausedByVisibility: boolean;
  matchGeneration: number;
  waveTransitionTimer: ReturnType<typeof setTimeout> | null;
  slowMoState: { phase: "slow" | "ramp"; remaining: number } | null;
  input: { dispose(): void };
  audioSys: { dispose(): void };
  particles?: { dispose?: () => void };
  projectiles?: { dispose?: () => void };
  grenades?: { dispose(): void };
  pickups?: { dispose(): void };
  ragdolls?: { dispose(): void };
  postProc?: { dispose(): void };
}

/** Pause flag setter — also clears the visibility-pause tracking flag so the
 *  next visibilitychange-hidden event can re-trigger a fresh auto-pause. */
export function setPaused(e: LifecycleEngineLike & { ctx: { paused: boolean } }, p: boolean): void {
  e.ctx.paused = p;
  if (!p) e._pausedByVisibility = false;
}

/** Full engine teardown. Cancels the rAF loop, releases GPU resources for
 *  every system, removes DOM listeners, and unregisters store callbacks so
 *  a stale engine ref isn't held by the (possibly reused) store. */
export function disposeEngine(e: LifecycleEngineLike): void {
  cancelAnimationFrame(e.rafId);
  // ANIM-POLISH — clear the fixed-step accumulator so a re-constructed
  // engine doesn't inherit a stale debt.
  e._accumulator = 0;
  // Prompt #113 — release the Screen Wake Lock so the display can sleep
  // after the player exits the match.
  e._wakeLockRelease?.();
  e._wakeLockRelease = null;
  // Prompt #114 — remove the visibilitychange listener so a re-constructed
  // engine doesn't get double-fire events from two stale handlers.
  if (e._visibilityHandler && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", e._visibilityHandler);
    e._visibilityHandler = null;
  }
  e._pausedByVisibility = false;
  // Wave fix: cancel any pending wave transition so it can't fire post-dispose.
  e.matchGeneration++;
  if (e.waveTransitionTimer) {
    clearTimeout(e.waveTransitionTimer);
    e.waveTransitionTimer = null;
  }
  // Task-13 — clean up deployables + unregister buy station callbacks so
  // a stale engine ref isn't held by the (possibly reused) store.
  if (e.ctx.deployables) {
    for (const d of e.ctx.deployables) {
      // The original code calls ctx.scene.remove(d.mesh) — we can't reference
      // scene here without widening the interface; the GameEngine.dispose
      // method handles that step before delegating to this function.
    }
    e.ctx.deployables = [];
  }
  e.slowMoState = null;
  e.ctx.timeScale = 1.0;
  useGameStore.getState().setBuyStationApplyEffect(undefined);
  useGameStore.getState().setBuyStationReadyHandler(undefined);
  useGameStore.getState().setBuyStationOpen(false);
  e.input.dispose();
  e.audioSys.dispose();
  e.particles?.dispose?.();
  // REAL-BALLISTICS — release any in-flight projectiles + their tracer meshes.
  e.projectiles?.dispose?.();
  e.grenades?.dispose();
  e.pickups?.dispose();
  e.ragdolls?.dispose();
  e.postProc?.dispose();
  // NOTE: the ImpulsePhysicsBackend is disposed by GameEngine.dispose after
  // calling this helper — it's defensive about init().then() not having fired.
}

/** Re-export acquireWakeLock so the lifecycle module owns the wake-lock
 *  concern (acquired in start(), released in dispose()). The GameEngine
 *  imports this from here rather than from ../platform/wake-lock directly. */
export { acquireWakeLock };
