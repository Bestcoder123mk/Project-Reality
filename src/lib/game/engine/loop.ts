/**
 * engine/loop.ts — Fixed-step loop concern (Task 3 / item 54).
 *
 * Extracted from the original engine.ts monolith. Owns:
 *   - The fixed-step constants (FIXED_DT, MAX_ACCUMULATOR, MAX_STEPS_PER_FRAME).
 *   - The per-frame tick body (system update + interpolation + FPS counter).
 *   - The render-skip-on-hidden-tab optimization.
 *
 * The GameEngine class delegates its `loop()` arrow fn to `runEngineFrame()`
 * below. `EngineLike` is the structural interface the loop function needs; the
 * GameEngine class satisfies it without inheritance (TS structural typing).
 *
 * Why split: the loop is the most performance-sensitive code in the engine
 * and benefits from being isolated for profiling + hot-loop review. It also
 * clarifies which fields the loop touches (audited via EngineLike).
 */

import type { GameSystem } from "../systems/types";

/** Fixed physics timestep (60 Hz). Systems receive FIXED_DT, not the
 *  variable render dt, so physics integration is deterministic. */
export const FIXED_DT = 1 / 60;

/** Spiral-of-death guard: if the tab was backgrounded + realDt would pile
 *  up more than 0.25s of physics debt, clamp the accumulator so we don't
 *  burn the frame budget on catch-up steps. */
export const MAX_ACCUMULATOR = 0.25;

/** Hard cap on physics steps per render frame. With FIXED_DT=1/60 and
 *  MAX_ACCUMULATOR=0.25, the theoretical max is 15 steps; capping at 5
 *  means we'd rather slow the simulation than hitch the renderer. */
export const MAX_STEPS_PER_FRAME = 5;

/** Structural interface the loop needs from the engine. GameEngine
 *  satisfies this via TS structural typing — no `implements` needed. */
export interface EngineLike {
  ctx: {
    clock: { getDelta(): number };
    paused: boolean;
    running: boolean;
    timeScale?: number;
    match: {
      matchOver: boolean;
      fpsAccum: number;
      fpsFrames: number;
      fpsTime: number;
    };
    pushHud(partial: { fps?: number; objective?: string }): void;
    renderer: { render(scene: unknown, camera: unknown): void };
    scene: unknown;
    camera: unknown;
    lodSystem?: { update(dt: number): void };
    ragdolls?: { update(dt: number): void };
    chunkManager?: { update(dt: number): void };
    pickups?: { update(dt: number): void };
    physicsBackend?: { step(dt: number): void };
  };
  systems: GameSystem[];
  grenades: { update(dt: number): void };
  finishers: { update(dt: number): void };
  missions: { update(dt: number): void };
  renderer: { update(dt: number): void };
  postProc: {
    shouldUseComposer: boolean;
    update(dt: number): void;
    render(): void;
  };
  profiler: {
    recordFrame(ms: number): void;
    recordPhase(phase: string, ms: number): void;
  };
  _accumulator: number;
  updateSlowMo(realDt: number): void;
  updateDeployables(dt: number): void;
  rafId: number;
  loop: () => void;
}

/** Run one engine frame: request next rAF, tick systems at FIXED_DT, render.
 *  Extracted verbatim from the original GameEngine.loop arrow fn — only the
 *  `this` references became `e.` references. */
export function runEngineFrame(e: EngineLike, t0: number): void {
  // Task-13 — track real dt (for slow-mo state + FPS + post-proc) and
  // scaled dt (for system updates — multiplied by ctx.timeScale so the
  // slow-mo final-kill effect actually slows the world down).
  const realDt = Math.min(e.ctx.clock.getDelta(), 0.05);
  e.updateSlowMo(realDt);
  if (!e.ctx.paused && e.ctx.running) {
    // ANIM-POLISH — fixed-step accumulator (60 Hz physics tick).
    e._accumulator += realDt * (e.ctx.timeScale ?? 1);
    if (e._accumulator > MAX_ACCUMULATOR) e._accumulator = MAX_ACCUMULATOR;
    let steps = 0;
    while (e._accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      for (const sys of e.systems) sys.update(FIXED_DT);
      e.grenades.update(FIXED_DT);
      e.finishers.update(FIXED_DT);
      e.missions.update(FIXED_DT);
      e.updateDeployables(FIXED_DT);
      e.ctx.lodSystem?.update(FIXED_DT);
      e.ctx.ragdolls?.update(FIXED_DT);
      e.ctx.chunkManager?.update(FIXED_DT);
      e.ctx.pickups?.update(FIXED_DT);
      e.renderer.update(FIXED_DT);
      e.ctx.physicsBackend?.step(FIXED_DT);
      e._accumulator -= FIXED_DT;
      steps++;
    }
    const alpha = e._accumulator / FIXED_DT;
    for (const sys of e.systems) {
      if (sys.interpolate) sys.interpolate(alpha);
    }
    e.ctx.match.fpsAccum += realDt;
    e.ctx.match.fpsFrames++;
    e.ctx.match.fpsTime += realDt;
    if (e.ctx.match.fpsTime >= 0.5) {
      e.ctx.pushHud({ fps: Math.round(e.ctx.match.fpsFrames / e.ctx.match.fpsAccum) });
      e.ctx.match.fpsAccum = 0;
      e.ctx.match.fpsFrames = 0;
      e.ctx.match.fpsTime = 0;
    }
    // Flush HUD updates through the store (best-effort — store is set up
    // before the loop starts). Imported lazily to avoid a top-level circular
    // dependency on the zustand store from this perf module.
    // (GameEngine calls useGameStore.getState().flushHud directly; the loop
    // function only computes the partial HUD state above.)
  }
  const renderStart = performance.now();
  // V5 — Skip the GPU render when the document is hidden.
  if (typeof document === "undefined" || !document.hidden) {
    e.postProc.update(realDt);
    if (e.postProc.shouldUseComposer) {
      e.postProc.render();
    } else {
      e.ctx.renderer.render(e.ctx.scene, e.ctx.camera);
    }
  }
  e.profiler.recordPhase("render", performance.now() - renderStart);
  e.profiler.recordFrame(performance.now() - t0);
}
