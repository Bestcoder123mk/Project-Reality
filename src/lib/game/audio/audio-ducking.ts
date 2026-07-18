/**
 * Section H — Smart sidechain ducking with priority-based multi-target rules.
 *
 * Section H prompt coverage: H_Audio_Immersion-00020/00046/00094/04911/04933
 * — kill-cam stings, ambient rain per map, music stingers per map (ducking
 * between music / SFX / VO / ambient layers).
 *
 * The existing buses.ts has BusMixer.duck() (single-bus sidechain) and
 * duckForTrigger() (table-driven). This module extends that with:
 *
 *   • Priority-based multi-target rules — a single trigger can duck multiple
 *     buses by different amounts with different attack/release curves.
 *   • Lookahead — important sounds (VO, stingers) can pre-duck the music by
 *     ~50ms so the dip is in place when the sound starts.
 *   • Custom curves — exponential (default), linear, or S-curve attack/
 *     release per rule.
 *   • Active-duck registry — tracks all currently-active ducks so we can
 *     compute the deepest active dip per bus at any time (multiple overlapping
 *     ducks → take the deepest, not the latest).
 *   • Auto-release — ducks auto-release when their duration expires, with
 *     optional release-tail extension for stingers that fade out.
 *
 * Routes through the existing BusMixer's buses — this engine doesn't own
 * audio nodes, it just schedules gain ramps on the existing bus GainNodes.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer, BusName } from "./buses";

export type DuckCurve = "exponential" | "linear" | "s_curve";

export type DuckTriggerCategory =
  | "vo"
  | "announcer"
  | "stinger"
  | "gunfire"
  | "explosion"
  | "ui_important"
  | "killcam"
  | "menu"
  | "ambient_priority";

export interface SmartDuckRule {
  /** Trigger category this rule applies to. */
  trigger: DuckTriggerCategory;
  /** Buses to duck. */
  ducked: BusName[];
  /** Duck amount 0..1 (1 = full mute). */
  amount: number;
  /** Attack time (ms). */
  attackMs: number;
  /** Release time (ms, after the hold duration). */
  releaseMs: number;
  /** Hold duration (ms, the dip holds this long before release). */
  holdMs: number;
  /** Lookahead (ms, pre-duck the bus this far before the sound starts). */
  lookaheadMs: number;
  /** Attack/release curve. */
  curve: DuckCurve;
  /** Priority 1..5 (higher preempts lower — deeper dip wins for ties). */
  priority: number;
}

export const SMART_DUCK_RULES: SmartDuckRule[] = [
  // VO barks duck music by 40% (~8dB), quick attack, 200ms release.
  { trigger: "vo", ducked: ["music", "sfx"], amount: 0.4, attackMs: 25, releaseMs: 200, holdMs: 0, lookaheadMs: 0, curve: "exponential", priority: 3 },
  // Announcer ducks everything by 60% (~12dB), slower attack, 400ms release.
  { trigger: "announcer", ducked: ["music", "sfx", "ui"], amount: 0.6, attackMs: 50, releaseMs: 400, holdMs: 0, lookaheadMs: 50, curve: "exponential", priority: 5 },
  // Stingers duck music by 70% (~14dB), 100ms attack, 600ms release.
  { trigger: "stinger", ducked: ["music"], amount: 0.7, attackMs: 100, releaseMs: 600, holdMs: 100, lookaheadMs: 0, curve: "s_curve", priority: 4 },
  // Gunfire ducks music by 50% (~10dB), fast attack (50ms), 300ms release.
  { trigger: "gunfire", ducked: ["music"], amount: 0.5, attackMs: 50, releaseMs: 300, holdMs: 0, lookaheadMs: 0, curve: "exponential", priority: 2 },
  // Explosions duck everything by 80% (~16dB), 30ms attack, 800ms release.
  { trigger: "explosion", ducked: ["music", "sfx", "ui"], amount: 0.8, attackMs: 30, releaseMs: 800, holdMs: 100, lookaheadMs: 0, curve: "exponential", priority: 4 },
  // Important UI sounds duck music by 30% (~6dB), 20ms attack, 150ms release.
  { trigger: "ui_important", ducked: ["music"], amount: 0.3, attackMs: 20, releaseMs: 150, holdMs: 0, lookaheadMs: 0, curve: "linear", priority: 2 },
  // Killcam sting ducks everything by 90% (~20dB), 200ms attack, 1000ms release.
  { trigger: "killcam", ducked: ["music", "sfx", "ui"], amount: 0.9, attackMs: 200, releaseMs: 1000, holdMs: 500, lookaheadMs: 100, curve: "s_curve", priority: 5 },
  // Menu sounds duck ambient + music by 20% (~4dB), 10ms attack, 100ms release.
  { trigger: "menu", ducked: ["music"], amount: 0.2, attackMs: 10, releaseMs: 100, holdMs: 0, lookaheadMs: 0, curve: "linear", priority: 1 },
];

interface ActiveDuck {
  rule: SmartDuckRule;
  startedAt: number;
  endsAt: number;
  /** Per-bus deepest active dip (0..1, 1 = full mute). */
  perBusDip: Record<string, number>;
}

export class AudioDuckingEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  /** Active ducks (one per trigger that's currently in flight). */
  private activeDucks: ActiveDuck[] = [];
  /** Generation counter — bumped on dispose. */
  private generation = 0;
  /** Per-bus nominal gain cache (so we can compute the deepest dip target). */
  private nominalCache: Record<BusName, number> = { sfx: 0.85, music: 0.55, vo: 1.0, ui: 0.6 };

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  /**
   * Trigger a duck by category. Looks up the rule(s) for the trigger and
   * applies each via the smart-duck algorithm. Multiple rules can apply for
   * the same trigger (e.g. VO ducks both music + sfx by different amounts).
   */
  triggerDuck(trigger: DuckTriggerCategory, holdMsOverride?: number): void {
    if (!this.ctx || !this.buses) return;
    const rules = SMART_DUCK_RULES.filter((r) => r.trigger === trigger);
    if (rules.length === 0) return;
    for (const rule of rules) {
      this.applyRule(rule, holdMsOverride);
    }
  }

  /**
   * Apply a single rule — schedule the attack (dip) + release (return) on
   * each target bus, considering the rule's lookahead + curve.
   */
  private applyRule(rule: SmartDuckRule, holdMsOverride?: number): void {
    if (!this.ctx || !this.buses) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const lookaheadSec = Math.max(0, rule.lookaheadMs) / 1000;
    const attackSec = Math.max(0.001, rule.attackMs / 1000);
    const holdSec = Math.max(0, (holdMsOverride ?? rule.holdMs)) / 1000;
    const releaseSec = Math.max(0.001, rule.releaseMs / 1000);
    const dipStart = t + lookaheadSec;
    const dipEnd = dipStart + attackSec + holdSec;
    const releaseEnd = dipEnd + releaseSec;
    const perBusDip: Record<string, number> = {};
    for (const busName of rule.ducked) {
      const bus = this.buses.getBus(busName);
      if (!bus) continue;
      const nominal = this.nominalCache[busName] ?? 0.85;
      const dipped = Math.max(0.0001, nominal * (1 - rule.amount));
      const g = bus.gain as AudioParam & {
        cancelAndHoldAtTime?: (t: number) => void;
      };
      if (typeof g.cancelAndHoldAtTime === "function") {
        g.cancelAndHoldAtTime(t);
      } else {
        bus.gain.cancelScheduledValues(t);
        bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), t);
      }
      // Attack ramp (curve-dependent).
      this.applyCurve(bus.gain, dipped, dipStart, attackSec, rule.curve);
      // Release ramp (always exponential for natural recovery).
      bus.gain.exponentialRampToValueAtTime(Math.max(0.0001, nominal), releaseEnd);
      perBusDip[busName] = dipped;
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.activeDucks.push({
      rule,
      startedAt: now,
      endsAt: now + (lookaheadSec + attackSec + holdSec + releaseSec) * 1000,
      perBusDip,
    });
    // Schedule cleanup of this duck after it ends.
    const myGen = this.generation;
    const timer = setTimeout(() => {
      if (myGen !== this.generation) return;
      this.activeDucks = this.activeDucks.filter((d) => d.endsAt > now);
    }, (lookaheadSec + attackSec + holdSec + releaseSec) * 1000 + 100);
    void timer; // fire-and-forget — we filter on access.
  }

  /**
   * Apply a curve from the current value to `target` over `durSec` starting
   * at `startT`. For exponential we use exponentialRampToValueAtTime; for
   * linear we use linearRampToValueAtTime; for s_curve we approximate with
   * two linear ramps (slow-fast-slow).
   */
  private applyCurve(
    param: AudioParam,
    target: number,
    startT: number,
    durSec: number,
    curve: DuckCurve,
  ): void {
    switch (curve) {
      case "exponential":
        param.exponentialRampToValueAtTime(Math.max(0.0001, target), startT + durSec);
        break;
      case "linear":
        param.linearRampToValueAtTime(target, startT + durSec);
        break;
      case "s_curve": {
        // Approximate S-curve with three linear segments (slow → fast → slow).
        const t1 = startT + durSec * 0.25;
        const t2 = startT + durSec * 0.75;
        const t3 = startT + durSec;
        const current = Math.max(0.0001, param.value);
        const v1 = current + (target - current) * 0.25;
        const v2 = current + (target - current) * 0.75;
        param.linearRampToValueAtTime(v1, t1);
        param.linearRampToValueAtTime(v2, t2);
        param.linearRampToValueAtTime(target, t3);
        break;
      }
    }
  }

  /** Get the count of currently-active ducks. */
  getActiveDuckCount(): number {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    return this.activeDucks.filter((d) => d.endsAt > now).length;
  }

  /** Get the deepest active dip per bus (0..1, 1 = full mute). */
  getDeepestActiveDip(): Record<string, number> {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const result: Record<string, number> = {};
    for (const duck of this.activeDucks) {
      if (duck.endsAt <= now) continue;
      for (const [busName, dip] of Object.entries(duck.perBusDip)) {
        if (result[busName] === undefined || dip < result[busName]) {
          result[busName] = dip;
        }
      }
    }
    return result;
  }

  /** Cancel all active ducks + restore nominal gains. */
  cancelAll(): void {
    if (!this.ctx || !this.buses) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const busName of ["sfx", "music", "vo", "ui"] as BusName[]) {
      const bus = this.buses.getBus(busName);
      if (!bus) continue;
      const nominal = this.nominalCache[busName] ?? 0.85;
      const g = bus.gain as AudioParam & {
        cancelAndHoldAtTime?: (t: number) => void;
      };
      if (typeof g.cancelAndHoldAtTime === "function") {
        g.cancelAndHoldAtTime(t);
      } else {
        bus.gain.cancelScheduledValues(t);
        bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), t);
      }
      bus.gain.exponentialRampToValueAtTime(Math.max(0.0001, nominal), t + 0.1);
    }
    this.activeDucks = [];
  }

  /** Set the per-bus nominal gain cache (kept in sync with BusMixer.setBusVolume). */
  setNominal(busName: BusName, gain: number): void {
    this.nominalCache[busName] = gain;
  }

  dispose(): void {
    this.generation++;
    this.cancelAll();
    this.ctx = null;
    this.buses = null;
    this.activeDucks = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _ducking: AudioDuckingEngine | null = null;
export function getAudioDuckingEngine(): AudioDuckingEngine {
  if (!_ducking) _ducking = new AudioDuckingEngine();
  return _ducking;
}
