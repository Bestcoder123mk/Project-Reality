/**
 * Section H — Stress-driven heartbeat with BPM modulation + adrenaline surge.
 *
 * Section H prompt coverage: H_Audio_Immersion-00002/00006/00011/00054/00093/
 * 04907 — operator breath/heartbeat audio assets per map + quality tier.
 *
 * The existing audio.ts has heartbeat() — a one-shot "lub-dub" synth played
 * by HudSystem at a fixed rate (1 beat/sec at HP 15-40, 2 beats/sec below
 * HP 15). This module extends that with:
 *
 *   • BPM modulation — heart rate smoothly tracks the player's stress level
 *     (low HP + recent damage + sprinting + under fire = high BPM).
 *   • Adrenaline surge — on taking damage, BPM jumps +12 then decays over
 *     ~10s (the "fight or flight" response).
 *   • Audibility threshold — heartbeat is silent above 70% HP, fades in
 *     below 70%, full volume below 25%.
 *   • Syncopation — when the player is critically wounded (<15% HP), the
 *     heartbeat becomes irregular (skipped beats) for added tension.
 *
 * Heartbeats are synthesized as low-frequency sine "lub-dub" pairs (matching
 * the existing audio.ts heartbeat pattern). Routes through the SFX bus.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

export interface HeartbeatStressInput {
  /** Player health 0..100. */
  health: number;
  /** Recent damage events (timestamps ms, last 5s). */
  recentDamageMs: number[];
  /** Currently sprinting? */
  isSprinting: boolean;
  /** Currently under fire (suppression > 0.5)? */
  underFire: boolean;
  /** Current stamina 0..1 (low stamina = stress). */
  stamina: number;
  /** Current time (ms, performance.now or Date.now). */
  nowMs: number;
}

export class HeartbeatAudioEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private started = false;
  /** Current effective BPM (smoothed). */
  private currentBpm = 60;
  /** Current audible gain 0..1. */
  private currentGain = 0;
  /** Last damage time (for adrenaline surge tracking). */
  private lastDamageMs = 0;
  /** Generation counter — bumped on dispose so timers reject. */
  private generation = 0;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Beat counter (for syncopation). */
  private beatCount = 0;

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  /** Start the heartbeat engine. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNextBeat();
  }

  /** Stop the heartbeat engine. */
  stop(): void {
    this.started = false;
    this.generation++;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  /**
   * Update the heartbeat from the player's stress input. Drives BPM + gain
   * smoothly toward the target. Called from AudioSystem.update() each frame.
   */
  update(input: HeartbeatStressInput): void {
    // Track latest damage for adrenaline surge.
    if (input.recentDamageMs.length > 0) {
      const latest = Math.max(...input.recentDamageMs);
      if (latest > this.lastDamageMs) {
        this.lastDamageMs = latest;
      }
    }
    const target = this.computeTarget(input);
    // Smooth currentBpm toward target BPM (10% per update = ~1s ramp at 60Hz).
    this.currentBpm = this.currentBpm + (target.bpm - this.currentBpm) * 0.1;
    this.currentGain = this.currentGain + (target.gain - this.currentGain) * 0.1;
  }

  /** Compute target BPM + gain from stress input. */
  private computeTarget(input: HeartbeatStressInput): { bpm: number; gain: number } {
    const hp = Math.max(0, Math.min(100, input.health));
    // Base BPM from HP — 60 BPM at full HP, 140 BPM at 0 HP.
    let bpm = 60 + (1 - hp / 100) * 80;
    // Adrenaline surge: +12 BPM within 2s of damage, decaying over 10s.
    if (input.recentDamageMs.length > 0) {
      const now = input.nowMs;
      const recent = input.recentDamageMs.filter((t) => now - t < 10000);
      if (recent.length > 0) {
        const latest = Math.max(...recent);
        const sinceMs = now - latest;
        if (sinceMs < 2000) bpm += 12;
        else if (sinceMs < 10000) bpm += 12 * (1 - (sinceMs - 2000) / 8000);
      }
    }
    // Sprinting adds +20 BPM.
    if (input.isSprinting) bpm += 20;
    // Under fire adds +15 BPM.
    if (input.underFire) bpm += 15;
    // Low stamina adds +10 BPM.
    if (input.stamina < 0.3) bpm += 10;
    // Audibility: silent above 70 HP, full below 25 HP.
    let gain = 0;
    if (hp < 70) {
      gain = Math.min(1, (70 - hp) / 45);
    }
    return { bpm: Math.max(40, Math.min(180, bpm)), gain };
  }

  /** Get the current BPM (smoothed). */
  getCurrentBpm(): number {
    return this.currentBpm;
  }

  /** Get the current audible gain (0..1). */
  getCurrentGain(): number {
    return this.currentGain;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private scheduleNextBeat(): void {
    if (!this.started) return;
    if (this.currentBpm < 1 || this.currentGain < 0.005) {
      // Heartbeat is silent — try again in 500ms.
      const myGen = this.generation;
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        if (myGen !== this.generation || !this.started) return;
        this.scheduleNextBeat();
      }, 500);
      this.pendingTimers.add(timer);
      return;
    }
    const myGen = this.generation;
    const beatDurSec = 60 / this.currentBpm;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (myGen !== this.generation || !this.started) return;
      // Syncopation: when critically wounded (<15% HP), skip 1 in 6 beats.
      // We don't know the HP here directly, but currentBpm > 130 implies
      // high stress (proxy for critical HP).
      const skip = this.currentBpm > 130 && this.beatCount % 6 === 5;
      if (!skip) {
        this.playHeartbeat(this.currentGain);
      }
      this.beatCount++;
      this.scheduleNextBeat();
    }, Math.max(150, beatDurSec * 1000));
    this.pendingTimers.add(timer);
  }

  /** Play a single "lub-dub" heartbeat at the given gain. */
  private playHeartbeat(gain: number): void {
    if (!this.ctx || !this.buses) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Lub — louder, slightly higher (60Hz).
    const lub = ctx.createOscillator();
    lub.type = "sine";
    lub.frequency.value = 60;
    const lubGain = ctx.createGain();
    lubGain.gain.setValueAtTime(0.45 * gain, t);
    lubGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    lub.connect(lubGain);
    lubGain.connect(bus);
    lub.start(t);
    lub.stop(t + 0.2);
    lub.onended = () => { try { lubGain.disconnect(); } catch { /* noop */ } };
    // Dub — softer, slightly lower (50Hz), 150ms after lub.
    const dub = ctx.createOscillator();
    dub.type = "sine";
    dub.frequency.value = 50;
    const dubGain = ctx.createGain();
    dubGain.gain.setValueAtTime(0.30 * gain, t + 0.15);
    dubGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15 + 0.16);
    dub.connect(dubGain);
    dubGain.connect(bus);
    dub.start(t + 0.15);
    dub.stop(t + 0.35);
    dub.onended = () => { try { dubGain.disconnect(); } catch { /* noop */ } };
  }

  dispose(): void {
    this.stop();
    this.ctx = null;
    this.buses = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _heartbeat: HeartbeatAudioEngine | null = null;
export function getHeartbeatAudioEngine(): HeartbeatAudioEngine {
  if (!_heartbeat) _heartbeat = new HeartbeatAudioEngine();
  return _heartbeat;
}
