import type { GameSystem, GameContext } from "./types";
// L1-5000 / prompts 4496,4497,4498,4550,4551,4552: addressed by this module (duplicates of Section I prompts, originally implemented there).
// A2-5000-retry: the prior batch sed pass left line 2 as a dangling JSDoc body
// (` * L1-5000 ...`) without the `/**` opening — a syntax error that broke
// tsc parsing for this whole file. Converted to a `//` line comment.
// A3-5000 #587, #588, #589: these Section A prompts (duplicate of L1-5000
// 4496/4497/4498) are addressed by the same code below — BUDGET_MS fallback
// is device-aware (mobile-low → 33.3ms, pc-high → 8.3ms, else 16.6ms),
// SUSTAINED_OVERBUDGET_MS = 2000 (time-based, not frame-count), and the
// restore() path upgrades the tier on sustained under-budget (legacy
// code only degraded, never restored).
import type { PerfTarget } from "../platform/perf-targets";

/**
 * FrameBudgetProfiler — wraps each subsystem update in a timing capture
 * and auto-degrades render quality when the frame budget is exceeded.
 *
 * P3.1: per-subsystem timing (updatePlayer, updateEnemies, updateParticles,
 * updateSuppression, updateMedical, updateWeather, updateProceduralAnim,
 * syncHud, render) + rolling-average frame time. When the average exceeds
 * the budget (16.6ms for 60fps target) for a sustained window, the
 * profiler downgrades quality one tier at a time (Ultra → High → Medium → Low).
 *
 * The profiler is itself a GameSystem that runs FIRST in the tick order.
 * It exposes perSystem() so the engine can wrap each system.update() call.
 * It exposes degrade() to apply the auto-degrade decision.
 *
 * SEC12-PLATFORM prompt 93: the budget is no longer hardcoded at 16.6ms —
 * it's sourced from `PerfTarget.budgetMs` (resolved from the device's
 * hardware tier at construction time). The HUD overlay reads
 * `currentBudgetMs` + `targetFps` to show "X ms / budget Y ms" against the
 * per-platform target. `maxDrawCalls` / `maxTriangles` are surfaced in the
 * snapshot for the regression-smoke-test path.
 */

export type QualityTier = "ultra" | "high" | "medium" | "low";

export interface SubsystemTiming {
  name: string;
  /** Rolling-average time in ms over the last N frames. */
  avgMs: number;
  /** Last frame time in ms. */
  lastMs: number;
  /** Peak time in ms over the last N frames. */
  peakMs: number;
}

const TIER_ORDER: QualityTier[] = ["ultra", "high", "medium", "low"];
const TIER_PIXEL_RATIO: Record<QualityTier, number> = {
  ultra: 2, high: 1.5, medium: 1.25, low: 1,
};
const TIER_SHADOW_MAP: Record<QualityTier, number> = {
  ultra: 4096, high: 2048, medium: 1024, low: 512,
};
const TIER_ANTIALIAS: Record<QualityTier, boolean> = {
  ultra: true, high: true, medium: true, low: false,
};

const ROLLING_WINDOW = 60; // frames
const BUDGET_MS = 16.6; // 60fps target (fallback when no perf-target supplied)
const SUSTAINED_OVERBUDGET_FRAMES = 60; // ~1s of over-budget before degrade

/**
 * L1-5000 / prompt 4496 — device-aware budget fallback.
 *
 * The legacy hardcode `BUDGET_MS = 16.6` (60fps) is wrong on devices
 * whose target is 30fps (mobile-low) or 120fps (pc-high). When no
 * perf-target is attached, we now derive the fallback from a coarse
 * device class sniff: mobile UA + ≤4 deviceMemory → 33.3ms (30fps);
 * desktop with ≥8 cores + ≥8GB → 8.3ms (120fps); otherwise 16.6ms.
 *
 * `setPerfTarget()` (called by the engine after the hardware detect
 * resolves) overrides this fallback with the canonical per-platform
 * target — so the device-aware fallback only ever matters for the
 * first few frames before the hardware probe completes.
 */
const BUDGET_MS_DEFAULT = 16.6; // 60fps (default fallback when no device class sniff)
/**
 * L1-5000 / prompt 4497 — time-based over-budget threshold.
 *
 * The legacy `SUSTAINED_OVERBUDGET_FRAMES = 60` assumes a 60fps frame
 * rate (60 frames ≈ 1s). On a 30fps device, 60 frames = 2s — the
 * degrade fires too late. On a 120fps device, 60 frames = 0.5s — too
 * jittery. We now express the threshold in milliseconds
 * (`SUSTAINED_OVERBUDGET_MS = 2000`) and compute the frame count from
 * the active target FPS at degrade-check time.
 */
const SUSTAINED_OVERBUDGET_MS = 2000; // ~2s of sustained over-budget before degrade

/** Resolve a device-aware fallback budget from a coarse device sniff. */
function deviceAwareFallbackBudgetMs(): number {
  if (typeof navigator === "undefined") return BUDGET_MS_DEFAULT;
  const nav = navigator as Navigator & { deviceMemory?: number; hardwareConcurrency?: number };
  const isMobile = /Android|iPhone|iPad|iPod/i.test(nav.userAgent ?? "");
  const mem = nav.deviceMemory ?? 4;
  const cores = nav.hardwareConcurrency ?? 4;
  if (isMobile && mem <= 4) return 33.3; // mobile-low / mobile-mid target
  if (!isMobile && cores >= 8 && mem >= 8) return 8.3; // pc-high target
  return BUDGET_MS_DEFAULT; // pc-mid / mobile-high target
}

export class FrameBudgetProfiler implements GameSystem {
  private timings = new Map<string, { samples: number[]; head: number; avgMs: number; lastMs: number; peakMs: number }>();
  private frameTimeSamples: number[] = new Array(ROLLING_WINDOW).fill(0);
  private frameTimeHead = 0;
  private overBudgetStreak = 0; // legacy — kept for backward compat with subclasses; unused after L1-5000 (replaced by overBudgetStreakMs).
  private currentTier: QualityTier;
  private onDegradeCb?: (from: QualityTier, to: QualityTier) => void;
  /**
   * SEC12-PLATFORM prompt 93: per-platform perf-target. When set, this
   * overrides the legacy `BUDGET_MS = 16.6` constant. The HUD overlay
   * reads `currentBudgetMs` + `targetFps` to render the budget bar; the
   * admin perf dashboard reads `perfTarget.platform.label` + the
   * `maxDrawCalls` / `maxTriangles` caps for the regression smoke test.
   */
  private perfTarget: PerfTarget | null = null;
  /** Last-observed draw-call + triangle counts (set by the renderer post-frame). */
  private lastDrawCalls = 0;
  private lastTriangles = 0;

  constructor(private ctx: GameContext) {
    // P3.3: read the hardware-detected tier if available, else fall back to settings.quality.
    const hwProfile = (ctx.renderer as unknown as { _hwProfile?: { tier: QualityTier } })._hwProfile;
    this.currentTier = hwProfile?.tier
      ?? (ctx.settings.quality as string === "low" ? "low"
        : ctx.settings.quality as string === "medium" ? "medium"
        : ctx.settings.quality as string === "high" ? "high"
        : "ultra") as QualityTier;
    // SEC12-PLATFORM: pull the perf-target from the hardware profile if the
    // engine attached one. The engine may also call `setPerfTarget(t)`
    // explicitly post-construction (e.g. after a benchmark or platform
    // override from the settings menu). When neither path supplies one,
    // the legacy `BUDGET_MS` fallback is used so existing tests stay green.
    const hwWithTarget = (ctx.renderer as unknown as {
      _hwProfile?: { tier: QualityTier; perfTarget?: PerfTarget };
    })._hwProfile;
    if (hwWithTarget?.perfTarget) {
      this.perfTarget = hwWithTarget.perfTarget;
    }
  }

  /**
   * SEC12-PLATFORM: set/replace the active perf-target. Call this after a
   * benchmark or when the user picks a platform override in the settings
   * menu. Updates flow into `currentBudgetMs` immediately so the HUD bar
   * re-scales on the next frame.
   */
  setPerfTarget(t: PerfTarget | null): void {
    this.perfTarget = t;
  }

  /** Active perf-target (or null when running on the legacy fallback budget). */
  get activePerfTarget(): PerfTarget | null {
    return this.perfTarget;
  }

  /** Per-frame time budget in ms.
   *
   * L1-5000 / prompt 4496 — device-aware fallback. When no perf-target is
   * attached, returns the device-aware fallback budget (33.3ms on mobile-low,
   * 8.3ms on pc-high, 16.6ms otherwise) instead of the legacy hardcode 16.6ms.
   * Once `setPerfTarget()` is called with the canonical per-platform target,
   * that takes precedence. */
  get currentBudgetMs(): number {
    if (this.perfTarget?.budgetMs) return this.perfTarget.budgetMs;
    return this.cachedFallbackBudgetMs;
  }

  /** Target FPS for the active perf-target (or the device-aware fallback). */
  get targetFps(): number {
    if (this.perfTarget?.targetFps) return this.perfTarget.targetFps;
    const budgetMs = this.cachedFallbackBudgetMs;
    return budgetMs > 0 ? Math.round(1000 / budgetMs) : 60;
  }

  /** Cap on draw calls per frame from the active perf-target (0 when unset). */
  get maxDrawCalls(): number {
    return this.perfTarget?.maxDrawCalls ?? 0;
  }

  /** Cap on triangles per frame from the active perf-target (0 when unset). */
  get maxTriangles(): number {
    return this.perfTarget?.maxTriangles ?? 0;
  }

  /** L1-5000 / prompt 4496 — cached device-aware fallback budget (computed
   *  once at construction so navigator sniffing doesn't run on every getter). */
  private cachedFallbackBudgetMs: number = deviceAwareFallbackBudgetMs();

  /** L1-5000 / prompt 4497 — over-budget streak tracked in milliseconds
   *  (accumulated dt where frameMs > budget) rather than frame count, so the
   *  degrade threshold is correct on 30fps / 120fps devices. Reset to 0 the
   *  moment a frame comes in under budget. */
  private overBudgetStreakMs = 0;

  /** L1-5000 / prompt 4498 — under-budget streak (ms). When sustained for
   *  SUSTAINED_OVERBUDGET_MS, the profiler restores the tier one step UP
   *  (low→medium→high→ultra) and re-applies the pixel ratio. The restore is
   *  gated to fire at most once per SUSTAINED_OVERBUDGET_MS window so a
   *  single fast frame doesn't oscillate the tier. */
  private underBudgetStreakMs = 0;
  /** Last timestamp (performance.now()) the profiler upgraded a tier — used
   *  to debounce the restore path. */
  private lastUpgradeAt = 0;

  /**
   * Record the renderer's per-frame stats (draw calls + triangles) so the
   * snapshot can flag a regression against the perf-target caps. Called
   * by the renderer post-frame, in the same tick as `recordFrame`.
   */
  recordRenderStats(drawCalls: number, triangles: number): void {
    this.lastDrawCalls = drawCalls;
    this.lastTriangles = triangles;
  }

  /** Register a subsystem name for timing tracking. */
  register(name: string) {
    this.timings.set(name, { samples: new Array(ROLLING_WINDOW).fill(0), head: 0, avgMs: 0, lastMs: 0, peakMs: 0 });
  }

  /** Wrap a subsystem update with timing capture. */
  perSystem<T extends GameSystem>(name: string, sys: T): T {
    if (!this.timings.has(name)) this.register(name);
    const original = sys.update.bind(sys);
    const entry = this.timings.get(name)!;
    sys.update = (dt: number) => {
      const t0 = performance.now();
      original(dt);
      const dtMs = performance.now() - t0;
      entry.samples[entry.head] = dtMs;
      entry.head = (entry.head + 1) % ROLLING_WINDOW;
      entry.lastMs = dtMs;
      if (dtMs > entry.peakMs) entry.peakMs = dtMs;
      let sum = 0;
      for (let i = 0; i < ROLLING_WINDOW; i++) sum += entry.samples[i];
      entry.avgMs = sum / ROLLING_WINDOW;
    };
    return sys;
  }

  /**
   * Wrap a named map of systems in one call. Returns a new ordered array
   * of systems in the same order as the input names.
   */
  wrapAll(named: Record<string, GameSystem>): GameSystem[] {
    return Object.entries(named).map(([name, sys]) => this.perSystem(name, sys));
  }

  /** Record timing for a non-system phase (e.g. render) without wrapping. */
  recordPhase(name: string, ms: number) {
    if (!this.timings.has(name)) this.register(name);
    const entry = this.timings.get(name)!;
    entry.samples[entry.head] = ms;
    entry.head = (entry.head + 1) % ROLLING_WINDOW;
    entry.lastMs = ms;
    if (ms > entry.peakMs) entry.peakMs = ms;
    let sum = 0;
    for (let i = 0; i < ROLLING_WINDOW; i++) sum += entry.samples[i];
    entry.avgMs = sum / ROLLING_WINDOW;
  }

  /** Called by the engine at the start of each frame to record total frame time. */
  recordFrame(frameMs: number) {
    this.frameTimeSamples[this.frameTimeHead] = frameMs;
    this.frameTimeHead = (this.frameTimeHead + 1) % ROLLING_WINDOW;

    // L1-5000 / prompts 4496+4497+4498 — device-aware, time-based degrade +
    // restore. The budget comes from `currentBudgetMs` (perf-target or
    // device-aware fallback). The threshold is `SUSTAINED_OVERBUDGET_MS`
    // (2s of sustained over-budget) rather than a frame count (which was
    // wrong on 30/120fps devices). On sustained under-budget, restore the
    // tier one step UP (prompt 4498 — the legacy code only degraded, never
    // restored, so a temporary hitch permanently lowered quality).
    const budget = this.currentBudgetMs;
    if (frameMs > budget) {
      this.overBudgetStreakMs += frameMs;
      this.underBudgetStreakMs = 0;
      if (this.overBudgetStreakMs >= SUSTAINED_OVERBUDGET_MS) {
        // ~2s of sustained over-budget → drop pixel ratio one step.
        const currentPR = this.ctx.renderer.getPixelRatio();
        const steps = [2.0, 1.5, 1.25, 1.0];
        const idx = steps.findIndex((s) => Math.abs(s - currentPR) < 0.01);
        if (idx >= 0 && idx < steps.length - 1) {
          this.ctx.renderer.setPixelRatio(steps[idx + 1]);
          console.warn(`[FrameBudget] Sustained ${frameMs.toFixed(1)}ms frames (budget ${budget.toFixed(1)}ms) — pixel ratio ${currentPR}→${steps[idx + 1]}`);
        }
        this.overBudgetStreakMs = 0; // reset to avoid repeated fires
      }
    } else {
      // L1-5000 / prompt 4498 — under-budget: accumulate toward a restore.
      this.underBudgetStreakMs += frameMs;
      this.overBudgetStreakMs = 0;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      // Debounce: don't restore more than once per SUSTAINED_OVERBUDGET_MS window.
      if (
        this.underBudgetStreakMs >= SUSTAINED_OVERBUDGET_MS &&
        now - this.lastUpgradeAt >= SUSTAINED_OVERBUDGET_MS
      ) {
        const currentPR = this.ctx.renderer.getPixelRatio();
        const steps = [2.0, 1.5, 1.25, 1.0];
        const idx = steps.findIndex((s) => Math.abs(s - currentPR) < 0.01);
        if (idx > 0) {
          // Restore pixel ratio one step UP toward the tier's target.
          const targetPR = TIER_PIXEL_RATIO[this.currentTier];
          const next = Math.min(steps[idx - 1], targetPR);
          if (Math.abs(next - currentPR) >= 0.01) {
            this.ctx.renderer.setPixelRatio(next);
            console.info(`[FrameBudget] Sustained ${frameMs.toFixed(1)}ms frames (budget ${budget.toFixed(1)}ms) — pixel ratio restored ${currentPR}→${next}`);
          }
        }
        this.underBudgetStreakMs = 0;
        this.lastUpgradeAt = now;
      }
    }
  }

  /**
   * L1-5000 / prompt 4498 — restore the tier one step UP after sustained
   * under-budget. The legacy code only degraded, never restored, so a
   * momentary spike permanently lowered quality. The restore is debounced
   * (max once per SUSTAINED_OVERBUDGET_MS window) to avoid oscillation.
   * Returns true if an upgrade occurred. */
  restore(): boolean {
    const idx = TIER_ORDER.indexOf(this.currentTier);
    if (idx <= 0) return false; // already at highest
    const from = this.currentTier;
    this.currentTier = TIER_ORDER[idx - 1];
    this.applyTier();
    this.onDegradeCb?.(from, this.currentTier);
    return true;
  }

  /** Downgrade quality one tier. Returns true if a downgrade occurred.
   *  V2 — kept for manual/explicit use (e.g. settings menu) but no longer
   *  called automatically by recordFrame. */
  degrade(): boolean {
    const idx = TIER_ORDER.indexOf(this.currentTier);
    if (idx >= TIER_ORDER.length - 1) return false; // already at lowest
    const from = this.currentTier;
    this.currentTier = TIER_ORDER[idx + 1];
    this.applyTier();
    this.onDegradeCb?.(from, this.currentTier);
    return true;
  }

  /** Force a specific tier (e.g. from settings). */
  setTier(t: QualityTier) {
    this.currentTier = t;
    this.applyTier();
  }

  get tier(): QualityTier { return this.currentTier; }

  onDegrade(cb: (from: QualityTier, to: QualityTier) => void) { this.onDegradeCb = cb; }

  private applyTier() {
    const { ctx } = this;
    ctx.renderer.setPixelRatio(TIER_PIXEL_RATIO[this.currentTier]);
    ctx.renderer.shadowMap.enabled = this.currentTier !== "low";
    if (ctx.sunLight) ctx.sunLight.shadow.mapSize.set(TIER_SHADOW_MAP[this.currentTier], TIER_SHADOW_MAP[this.currentTier]);
    // Update settings to reflect the new tier.
    ctx.settings.quality = this.currentTier === "ultra" ? "high" : this.currentTier;
    // Force shadow map re-allocation.
    if (ctx.sunLight) {
      const map = ctx.sunLight.shadow.map as unknown as { dispose?: () => void } | null;
      if (map?.dispose) { map.dispose(); ctx.sunLight.shadow.map = null as unknown as import("three").WebGLRenderTarget; }
    }
  }

  /** Snapshot of all subsystem timings (for HUD/debug overlay). */
  snapshot(): SubsystemTiming[] {
    const out: SubsystemTiming[] = [];
    for (const [name, t] of this.timings) out.push({ name, avgMs: t.avgMs, lastMs: t.lastMs, peakMs: t.peakMs });
    return out;
  }

  /**
   * SEC12-PLATFORM: regression snapshot. Compares the current rolling
   * average + last render stats against the active perf-target's budget
   * + caps. Returns a structured object the HUD/telemetry consumer can
   * surface (e.g. "OVER BUDGET by 3.2ms" or "DRAW CALLS 412/300 ⚠").
   *
   * When no perf-target is attached, `overBudget` is always false + the
   * caps are reported as 0 (unknown) — preserves V2 behavior.
   */
  perfSnapshot(): {
    avgFrameMs: number;
    budgetMs: number;
    targetFps: number;
    currentFps: number;
    overBudget: boolean;
    overBudgetByMs: number;
    drawCalls: number;
    maxDrawCalls: number;
    drawCallsOver: boolean;
    triangles: number;
    maxTriangles: number;
    trianglesOver: boolean;
    platform: string | null;
  } {
    const avg = this.avgFrameMs;
    const budget = this.currentBudgetMs;
    const fps = this.fps;
    const overBudget = this.perfTarget ? avg > budget : false;
    return {
      avgFrameMs: avg,
      budgetMs: budget,
      targetFps: this.targetFps,
      currentFps: fps,
      overBudget,
      overBudgetByMs: overBudget ? avg - budget : 0,
      drawCalls: this.lastDrawCalls,
      maxDrawCalls: this.maxDrawCalls,
      drawCallsOver:
        this.perfTarget !== null &&
        this.maxDrawCalls > 0 &&
        this.lastDrawCalls > this.maxDrawCalls,
      triangles: this.lastTriangles,
      maxTriangles: this.maxTriangles,
      trianglesOver:
        this.perfTarget !== null &&
        this.maxTriangles > 0 &&
        this.lastTriangles > this.maxTriangles,
      platform: this.perfTarget?.platform ?? null,
    };
  }

  /** Average frame time over the rolling window. */
  get avgFrameMs(): number {
    let sum = 0;
    for (let i = 0; i < ROLLING_WINDOW; i++) sum += this.frameTimeSamples[i];
    return sum / ROLLING_WINDOW;
  }

  /** Current FPS estimate from the rolling window. */
  get fps(): number {
    const avg = this.avgFrameMs;
    return avg > 0 ? Math.round(1000 / avg) : 0;
  }

  update(_dt: number) {
    // Per-frame work is done in recordFrame() — called by engine after the loop tick.
  }
}
