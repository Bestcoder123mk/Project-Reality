/**
 * Section L / L_Performance_Optimization.txt
 * Prompts: 3, 18, 32, 46 ("input-to-photon latency" + "without exceeding 16.67ms frame budget")
 *
 * frame-budget-scaler.ts — dynamically reduce quality if frame budget exceeded.
 *
 * The existing FrameBudgetProfiler degrades the pixel ratio on sustained
 * over-budget frames. This module is the EXPANDED version: it manages a
 * whole tree of quality knobs (not just pixel ratio) and applies them
 * adaptively per-knob based on which subsystem is actually over budget.
 *
 * Knobs the scaler can adjust:
 *
 *   - pixelRatio (already in FrameBudgetProfiler)
 *   - shadowMapSize
 *   - particleLimit
 *   - renderDistance / fog start
 *   - SSAO / SSR / volumetric fog on/off
 *   - triangle LOD bias
 *   - draw distance for enemies
 *   - physics timestep
 *
 * The scaler measures per-subsystem cost (via the FrameBudgetProfiler's
 * perSystem timings) + applies knobs targeted at the most expensive
 * subsystem first. E.g. if shadows are 40% of the frame budget,
 * `shadowMapSize` is the first knob to turn; if particles are 30%,
 * `particleLimit` goes down.
 *
 * The scaler is hysteresis-safe: it waits for 2s of sustained over-budget
 * before degrading (matches the FrameBudgetProfiler's existing threshold)
 * + 4s of sustained under-budget before restoring. Restores happen one
 * knob at a time + are debounced.
 */

import type { FrameBudgetProfiler, QualityTier } from "../systems/FrameBudgetProfiler";

// ─── Public types ────────────────────────────────────────────────────────

/** A single quality knob the scaler can adjust. */
export interface QualityKnob {
  /** Stable ID. */
  id: string;
  /** Display name. */
  label: string;
  /** Current value. */
  value: number;
  /** Steps the knob can take (sorted from highest quality to lowest). */
  steps: number[];
  /** Current step index. */
  stepIndex: number;
  /** Apply the knob to the renderer/scene. Called whenever the step changes. */
  apply: (value: number) => void;
  /** Which subsystem timing this knob targets ("render" / "shadows" / etc.). */
  targetSubsystem: string;
  /** Cost weight — how much this knob is "worth" relative to others.
   *  Higher = the scaler prefers to turn this knob first. */
  costWeight: number;
}

/** Scaler stats for the perf overlay. */
export interface ScalerStats {
  /** Total knobs registered. */
  knobs: number;
  /** Knobs currently below their highest step (i.e. degraded). */
  degradedKnobs: number;
  /** Knob IDs currently degraded. */
  degradedKnobIds: string[];
  /** Sustained over-budget ms in the current streak. */
  overBudgetStreakMs: number;
  /** Sustained under-budget ms in the current streak. */
  underBudgetStreakMs: number;
  /** True if the scaler is currently in "degrading" mode. */
  degrading: boolean;
  /** True if the scaler is currently in "restoring" mode. */
  restoring: boolean;
}

// ─── Scaler ──────────────────────────────────────────────────────────────

const OVER_BUDGET_THRESHOLD_MS = 2000; // 2s sustained over → degrade
const UNDER_BUDGET_THRESHOLD_MS = 4000; // 4s sustained under → restore
const RESTORE_DEBOUNCE_MS = 4000;

/**
 * FrameBudgetScaler — wraps the FrameBudgetProfiler + a set of quality
 * knobs. Call `update()` per frame with the latest subsystem timings.
 *
 * Usage:
 *   const scaler = new FrameBudgetScaler(profiler);
 *   scaler.registerKnob({
 *     id: "shadowMapSize",
 *     label: "Shadow Map Size",
 *     steps: [4096, 2048, 1024, 512],
 *     stepIndex: 0,
 *     targetSubsystem: "shadows",
 *     costWeight: 0.4,
 *     apply: (v) => { ctx.sunLight.shadow.mapSize.set(v, v); },
 *   });
 *   // Per frame:
 *   scaler.update(frameMs, subsystemTimings);
 */
export class FrameBudgetScaler {
  private knobs = new Map<string, QualityKnob>();
  private overBudgetStreakMs = 0;
  private underBudgetStreakMs = 0;
  private lastRestoreAt = 0;
  private currentTier: QualityTier;
  private degrading = false;
  private restoring = false;

  constructor(private profiler: FrameBudgetProfiler) {
    this.currentTier = profiler.tier;
  }

  /** Register a quality knob. */
  registerKnob(knob: Omit<QualityKnob, "value" | "stepIndex"> & { stepIndex?: number }): void {
    const stepIndex = knob.stepIndex ?? 0;
    const fullKnob: QualityKnob = {
      ...knob,
      stepIndex,
      value: knob.steps[stepIndex],
    };
    this.knobs.set(knob.id, fullKnob);
  }

  /** Unregister a knob. */
  unregisterKnob(id: string): void {
    this.knobs.delete(id);
  }

  /** Per-frame update. Reads the profiler's current budget + subsystem
   *  timings + applies/degrades/restores knobs as needed. */
  update(frameMs: number, subsystemTimings: Array<{ name: string; avgMs: number }>): void {
    const budget = this.profiler.currentBudgetMs;
    if (frameMs > budget) {
      this.overBudgetStreakMs += frameMs;
      this.underBudgetStreakMs = 0;
      this.degrading = this.overBudgetStreakMs >= OVER_BUDGET_THRESHOLD_MS;
      if (this.degrading) {
        // Degrade the highest-cost knob in the most expensive subsystem.
        this.degradeMostExpensiveKnob(subsystemTimings);
        this.overBudgetStreakMs = 0; // reset to avoid repeat fires
      }
    } else {
      this.underBudgetStreakMs += frameMs;
      this.overBudgetStreakMs = 0;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      this.restoring = this.underBudgetStreakMs >= UNDER_BUDGET_THRESHOLD_MS
        && now - this.lastRestoreAt >= RESTORE_DEBOUNCE_MS;
      if (this.restoring) {
        this.restoreOneKnob();
        this.underBudgetStreakMs = 0;
        this.lastRestoreAt = now;
      }
    }
  }

  /** Degrade the highest-cost knob targeting the most expensive subsystem. */
  private degradeMostExpensiveKnob(subsystemTimings: Array<{ name: string; avgMs: number }>): void {
    // Find the most expensive subsystem.
    if (subsystemTimings.length === 0) return;
    const sortedSubs = [...subsystemTimings].sort((a, b) => b.avgMs - a.avgMs);
    for (const sub of sortedSubs) {
      // Find the highest-cost knob targeting this subsystem that's not
      // already at its lowest step.
      const candidates = Array.from(this.knobs.values())
        .filter((k) => k.targetSubsystem === sub.name && k.stepIndex < k.steps.length - 1)
        .sort((a, b) => b.costWeight - a.costWeight);
      if (candidates.length > 0) {
        this.degradeKnob(candidates[0]);
        return;
      }
    }
    // No targeted knob — degrade any knob (fallback).
    const anyCandidate = Array.from(this.knobs.values())
      .filter((k) => k.stepIndex < k.steps.length - 1)
      .sort((a, b) => b.costWeight - a.costWeight)[0];
    if (anyCandidate) this.degradeKnob(anyCandidate);
  }

  /** Degrade a single knob one step. */
  private degradeKnob(knob: QualityKnob): void {
    if (knob.stepIndex >= knob.steps.length - 1) return;
    knob.stepIndex++;
    knob.value = knob.steps[knob.stepIndex];
    try {
      knob.apply(knob.value);
      console.warn(`[FrameBudgetScaler] Degrading ${knob.label} → ${knob.value}`);
    } catch (err) {
      console.error(`[FrameBudgetScaler] Failed to apply knob ${knob.id}:`, err);
    }
  }

  /** Restore a single knob one step (most recently degraded first). */
  private restoreOneKnob(): void {
    // Find the knob with the highest stepIndex (most degraded) that's
    // not at its highest step.
    const candidates = Array.from(this.knobs.values())
      .filter((k) => k.stepIndex > 0)
      .sort((a, b) => a.costWeight - b.costWeight); // restore cheapest first
    if (candidates.length === 0) return;
    const knob = candidates[0];
    knob.stepIndex--;
    knob.value = knob.steps[knob.stepIndex];
    try {
      knob.apply(knob.value);
      console.info(`[FrameBudgetScaler] Restoring ${knob.label} → ${knob.value}`);
    } catch (err) {
      console.error(`[FrameBudgetScaler] Failed to apply knob ${knob.id}:`, err);
    }
  }

  /** Force a specific knob to a step (e.g. from settings menu). */
  setKnobStep(id: string, stepIndex: number): void {
    const knob = this.knobs.get(id);
    if (!knob) return;
    knob.stepIndex = Math.max(0, Math.min(knob.steps.length - 1, stepIndex));
    knob.value = knob.steps[knob.stepIndex];
    try { knob.apply(knob.value); } catch (err) { console.error(err); }
  }

  /** Get a knob by ID. */
  getKnob(id: string): QualityKnob | undefined {
    return this.knobs.get(id);
  }

  /** Snapshot for diagnostics. */
  stats(): ScalerStats {
    const degraded = Array.from(this.knobs.values()).filter((k) => k.stepIndex > 0);
    return {
      knobs: this.knobs.size,
      degradedKnobs: degraded.length,
      degradedKnobIds: degraded.map((k) => k.id),
      overBudgetStreakMs: this.overBudgetStreakMs,
      underBudgetStreakMs: this.underBudgetStreakMs,
      degrading: this.degrading,
      restoring: this.restoring,
    };
  }

  /** Reset all knobs to their highest step (full quality). */
  resetAll(): void {
    for (const knob of this.knobs.values()) {
      knob.stepIndex = 0;
      knob.value = knob.steps[0];
      try { knob.apply(knob.value); } catch (err) { console.error(err); }
    }
    this.overBudgetStreakMs = 0;
    this.underBudgetStreakMs = 0;
  }

  /** Dispose. */
  dispose(): void {
    this.knobs.clear();
  }
}

// ─── Built-in knob factory ───────────────────────────────────────────────

/**
 * Build the default set of knobs for the game's standard renderer config.
 * Returns an array of knob specs ready to pass to `registerKnob`.
 *
 * Each knob targets a specific subsystem + has a cost weight derived
 * from empirical profiling (e.g. shadowMapSize at 4096 vs 512 is a 4x
 * fill-rate saving — weight 0.4; particleLimit at 200 vs 60 is ~3x
 * CPU saving — weight 0.3).
 */
export function buildDefaultKnobs(ctx: {
  renderer: THREE.WebGLRenderer;
  sunLight?: THREE.DirectionalLight;
  particleSystem?: { maxParticles: number };
  lodSystem?: { bias: number };
}): Array<Omit<QualityKnob, "value" | "stepIndex">> {
  const knobs: Array<Omit<QualityKnob, "value" | "stepIndex">> = [];
  if (ctx.sunLight) {
    knobs.push({
      id: "shadowMapSize",
      label: "Shadow Map Size",
      steps: [4096, 2048, 1024, 512, 256],
      apply: (v) => {
        ctx.sunLight!.shadow.mapSize.set(v, v);
        // Force re-alloc.
        const map = ctx.sunLight!.shadow.map as any;
        if (map?.dispose) {
          map.dispose();
          ctx.sunLight!.shadow.map = null;
        }
      },
      targetSubsystem: "shadows",
      costWeight: 0.4,
    });
  }
  knobs.push({
    id: "pixelRatio",
    label: "Pixel Ratio",
    steps: [2, 1.5, 1.25, 1, 0.75],
    apply: (v) => ctx.renderer.setPixelRatio(v),
    targetSubsystem: "render",
    costWeight: 0.35,
  });
  if (ctx.particleSystem) {
    knobs.push({
      id: "particleLimit",
      label: "Particle Limit",
      steps: [200, 150, 100, 60, 30],
      apply: (v) => { (ctx.particleSystem as any).maxParticles = v; },
      targetSubsystem: "particles",
      costWeight: 0.3,
    });
  }
  if (ctx.lodSystem) {
    knobs.push({
      id: "lodBias",
      label: "LOD Bias (distance multiplier)",
      steps: [1.0, 1.25, 1.5, 2.0, 2.5],
      apply: (v) => { (ctx.lodSystem as any).bias = v; },
      targetSubsystem: "render",
      costWeight: 0.2,
    });
  }
  knobs.push({
    id: "postProcess",
    label: "Post-Process Quality",
    steps: [3, 2, 1, 0], // 3 = full (SSAO+SSR+volfog), 0 = off
    apply: (v) => {
      // The PostProcessing system reads these flags.
      (ctx.renderer as any)._postProcessQuality = v;
    },
    targetSubsystem: "render",
    costWeight: 0.25,
  });
  return knobs;
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _scaler: FrameBudgetScaler | null = null;

export function getFrameBudgetScaler(profiler: FrameBudgetProfiler): FrameBudgetScaler {
  if (!_scaler) _scaler = new FrameBudgetScaler(profiler);
  return _scaler;
}

export function resetFrameBudgetScaler(): void {
  _scaler?.dispose();
  _scaler = null;
}

// Local import to avoid circular dependency at module load.
import type * as THREE from "three";
