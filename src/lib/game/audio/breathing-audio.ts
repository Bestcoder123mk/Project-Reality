/**
 * Section H — Breathing state machine synced to stamina + exertion.
 *
 * Section H prompt coverage: H_Audio_Immersion-00002/00006/00011/00054/00093/
 * 04907/04949/04981/04993 — operator breath audio assets (calm / winded /
 * panicked) per map + quality tier.
 *
 * The existing SectionG.ts has playStaminaPant + playAimBreath — one-shot
 * synthesis functions. This module adds a full **breathing state machine**
 * that emits breaths continuously based on the player's exertion state:
 *
 *   States: rest → walk → sprint → aim_hold → exhausted → wounded → dead
 *
 * Each state has a target breath rate (breaths per minute) + a breath
 * character (calm / winded / panicked / gasping). The engine schedules the
 * next breath on each exhale completion, ramping the rate smoothly when
 * state changes.
 *
 * Breaths are synthesized as filtered noise bursts with an inhale/exhale
 * envelope. Routes through the SFX bus.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

export type BreathState =
  | "rest"
  | "walk"
  | "sprint"
  | "aim_hold"
  | "exhausted"
  | "wounded"
  | "dead";

export interface BreathProfile {
  /** Breaths per minute. */
  bpm: number;
  /** inhale/exhale ratio (1 = equal, 0.5 = quick inhale / long exhale). */
  inhaleRatio: number;
  /** Filter frequency for the breath (higher = sharper). */
  filterFreq: number;
  /** Peak gain for each breath. */
  gain: number;
  /** Pitch multiplier (higher = more frantic). */
  pitchMult: number;
}

export const BREATH_PROFILES: Record<BreathState, BreathProfile> = {
  rest:      { bpm: 12, inhaleRatio: 0.5, filterFreq: 800,  gain: 0.08, pitchMult: 1.0 },
  walk:      { bpm: 18, inhaleRatio: 0.5, filterFreq: 1000, gain: 0.1,  pitchMult: 1.0 },
  sprint:    { bpm: 36, inhaleRatio: 0.4, filterFreq: 1600, gain: 0.18, pitchMult: 1.15 },
  aim_hold:  { bpm: 6,  inhaleRatio: 0.3, filterFreq: 700,  gain: 0.12, pitchMult: 0.95 },
  exhausted: { bpm: 48, inhaleRatio: 0.35, filterFreq: 1800, gain: 0.22, pitchMult: 1.2 },
  wounded:   { bpm: 30, inhaleRatio: 0.3, filterFreq: 1400, gain: 0.2,  pitchMult: 1.1 },
  dead:      { bpm: 0,  inhaleRatio: 0,   filterFreq: 0,    gain: 0,    pitchMult: 0 },
};

export class BreathingAudioEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private currentState: BreathState = "rest";
  private targetState: BreathState = "rest";
  /** Current effective BPM (smoothed toward target). */
  private currentBpm = 12;
  /** Generation counter — bumped on dispose so timers reject. */
  private generation = 0;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private started = false;

  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
  }

  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  /** Start the breathing state machine. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNextBreath();
  }

  /** Stop the breathing state machine. */
  stop(): void {
    this.started = false;
    this.generation++;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  /**
   * Set the target breath state. The engine ramps the BPM smoothly toward
   * the target state's BPM over ~2s so transitions don't click.
   */
  setState(state: BreathState): void {
    if (state === this.targetState) return;
    this.targetState = state;
    if (state === "dead") {
      // Stop scheduling — play one final gasp + silence.
      this.currentState = "dead";
      this.stop();
      this.playFinalGasp();
      return;
    }
    this.currentState = state;
  }

  /** Get the current breath state. */
  getState(): BreathState {
    return this.currentState;
  }

  /** Get the current effective BPM (smoothed). */
  getCurrentBpm(): number {
    return this.currentBpm;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private scheduleNextBreath(): void {
    if (!this.started) return;
    const myGen = this.generation;
    const targetBpm = BREATH_PROFILES[this.targetState].bpm;
    if (targetBpm <= 0) return;
    // Smooth currentBpm toward targetBpm (10% per breath).
    this.currentBpm = this.currentBpm + (targetBpm - this.currentBpm) * 0.1;
    if (this.currentBpm < 1) return;
    const breathDurSec = 60 / this.currentBpm;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (myGen !== this.generation || !this.started) return;
      this.playBreath();
      this.scheduleNextBreath();
    }, Math.max(200, breathDurSec * 1000));
    this.pendingTimers.add(timer);
  }

  /** Play a single breath (inhale + exhale) using the current state profile. */
  private playBreath(): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const profile = BREATH_PROFILES[this.currentState];
    if (profile.gain <= 0) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const breathDur = 60 / Math.max(1, this.currentBpm);
    const inhaleDur = breathDur * profile.inhaleRatio;
    const exhaleDur = breathDur - inhaleDur;
    // Inhale: rising filtered noise.
    this.playBreathPhase(t, inhaleDur, profile.filterFreq * 1.2, profile.gain * 0.7, profile.pitchMult, "inhale");
    // Exhale: falling filtered noise, slightly louder.
    this.playBreathPhase(t + inhaleDur, exhaleDur, profile.filterFreq, profile.gain, profile.pitchMult, "exhale");
  }

  private playBreathPhase(
    startT: number,
    durSec: number,
    filterFreq: number,
    gain: number,
    pitchMult: number,
    phase: "inhale" | "exhale",
  ): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = phase === "inhale" ? 1.2 * pitchMult : 0.9 * pitchMult;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = filterFreq;
    filter.Q.value = 0.7;
    const g = ctx.createGain();
    // Inhale: ramp up then quick fall. Exhale: ramp up slowly then trail off.
    if (phase === "inhale") {
      g.gain.setValueAtTime(0.0001, startT);
      g.gain.linearRampToValueAtTime(Math.max(0.0001, gain), startT + durSec * 0.6);
      g.gain.linearRampToValueAtTime(0.0001, startT + durSec);
    } else {
      g.gain.setValueAtTime(0.0001, startT);
      g.gain.linearRampToValueAtTime(Math.max(0.0001, gain), startT + durSec * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, startT + durSec);
    }
    src.connect(filter);
    filter.connect(g);
    g.connect(bus);
    src.start(startT);
    src.stop(startT + durSec + 0.02);
    src.onended = () => {
      try { filter.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
  }

  /** Play a final gasp on death — sharp inhale + slow trailing exhale. */
  private playFinalGasp(): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Sharp inhale.
    this.playBreathPhase(t, 0.4, 1800, 0.3, 1.3, "inhale");
    // Slow trailing exhale.
    this.playBreathPhase(t + 0.4, 1.2, 600, 0.2, 0.8, "exhale");
  }

  dispose(): void {
    this.stop();
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _breath: BreathingAudioEngine | null = null;
export function getBreathingAudioEngine(): BreathingAudioEngine {
  if (!_breath) _breath = new BreathingAudioEngine();
  return _breath;
}

/**
 * Map a player's stamina + health + movement state to a BreathState. Used
 * by the engine wiring to derive the breath state each frame.
 */
export function deriveBreathState(opts: {
  stamina: number; // 0..1
  health: number;  // 0..100
  isSprinting: boolean;
  isAiming: boolean;
  isMoving: boolean;
  isDead: boolean;
}): BreathState {
  if (opts.isDead) return "dead";
  if (opts.health < 30) return "wounded";
  if (opts.stamina < 0.15) return "exhausted";
  if (opts.isAiming) return "aim_hold";
  if (opts.isSprinting) return "sprint";
  if (opts.isMoving) return "walk";
  return "rest";
}
