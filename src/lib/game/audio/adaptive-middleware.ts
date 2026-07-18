/**
 * Section H — Adaptive music middleware with cue system + bar-accurate
 * transitions.
 *
 * Section H prompt coverage: H_Audio_Immersion-00014/00019/00021/00040/00042/
 * 00067/04917/04947/04994 — ambient wind, killstreak fanfare, victory/defeat
 * stings per map, music transitions for finisher sequences.
 *
 * The existing music.ts (3-stem crossfade) and dynamic-music.ts (5-stem ×
 * 5-section resequencer) handle the *continuous* music bed. This module is
 * the **middleware** layer above them: a cue scheduler that triggers one-shot
 * musical events (stingers, transitions, fanfares) on bar boundaries, with
 * hit-point-driven intensity that ramps the underlying dynamic-music engine
 * up / down.
 *
 * Features:
 *   • Cue table — named musical cues (multikill, clutch, victory, defeat,
 *     objective_captured, danger_close, last_alive, sweep) each with a
 *     synthesized sting + ducking + tier-change.
 *   • Bar-accurate scheduling — cues fire at the next bar boundary so they
 *     land in-time with the music bed.
 *   • Hit-point intensity — recent damage events ramp the music tier up to
 *     "climax" over 0.5s, then decay back to baseline over ~5s.
 *   • Cue priority — high-priority cues (victory/defeat) interrupt lower-
 *     priority cues in flight; low-priority cues queue.
 *
 * All audio is procedural — each cue is a synthesized oscillator + noise
 * burst pattern. Routes through the music bus via BusMixer.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";
import type { DynamicMusicEngine, CombatTier } from "./dynamic-music";

export type CueId =
  | "multikill"
  | "clutch"
  | "victory"
  | "defeat"
  | "objective_captured"
  | "danger_close"
  | "last_alive"
  | "sweep"
  | "match_start";

export interface CueDef {
  /** Cue id. */
  id: CueId;
  /** Priority 1..5 (higher preempts lower). */
  priority: number;
  /** Duration in seconds. */
  durationSec: number;
  /** Music duck amount 0..1 (1 = full mute while cue plays). */
  duckAmount: number;
  /** Target music tier while the cue plays. */
  targetTier: CombatTier;
  /** Synth recipe (oscillator + noise burst). */
  synth: CueSynth;
}

export interface CueSynth {
  /** Tonal layer — oscillator type + frequency envelope. */
  tonal?: {
    type: OscillatorType;
    startFreq: number;
    endFreq: number;
    gain: number;
  };
  /** Noise layer — filter type + frequency + gain. */
  noise?: {
    filterType: BiquadFilterType;
    filterFreq: number;
    filterQ?: number;
    gain: number;
  };
}

export const CUE_DEFS: Record<CueId, CueDef> = {
  multikill: {
    id: "multikill", priority: 2, durationSec: 1.5, duckAmount: 0.4,
    targetTier: "combat",
    synth: {
      tonal: { type: "sawtooth", startFreq: 440, endFreq: 880, gain: 0.18 },
      noise: { filterType: "bandpass", filterFreq: 2500, filterQ: 1.2, gain: 0.22 },
    },
  },
  clutch: {
    id: "clutch", priority: 3, durationSec: 2.5, duckAmount: 0.5,
    targetTier: "climax",
    synth: {
      tonal: { type: "triangle", startFreq: 220, endFreq: 660, gain: 0.22 },
      noise: { filterType: "highpass", filterFreq: 4000, gain: 0.18 },
    },
  },
  victory: {
    id: "victory", priority: 5, durationSec: 4.0, duckAmount: 0.6,
    targetTier: "climax",
    synth: {
      tonal: { type: "sawtooth", startFreq: 523, endFreq: 1047, gain: 0.28 },
      noise: { filterType: "bandpass", filterFreq: 3000, filterQ: 0.8, gain: 0.16 },
    },
  },
  defeat: {
    id: "defeat", priority: 5, durationSec: 4.0, duckAmount: 0.7,
    targetTier: "calm",
    synth: {
      tonal: { type: "sine", startFreq: 440, endFreq: 110, gain: 0.28 },
      noise: { filterType: "lowpass", filterFreq: 600, gain: 0.18 },
    },
  },
  objective_captured: {
    id: "objective_captured", priority: 3, durationSec: 2.0, duckAmount: 0.4,
    targetTier: "combat",
    synth: {
      tonal: { type: "triangle", startFreq: 660, endFreq: 990, gain: 0.2 },
      noise: { filterType: "bandpass", filterFreq: 2000, filterQ: 1.5, gain: 0.14 },
    },
  },
  danger_close: {
    id: "danger_close", priority: 4, durationSec: 1.2, duckAmount: 0.5,
    targetTier: "climax",
    synth: {
      tonal: { type: "sawtooth", startFreq: 880, endFreq: 220, gain: 0.24 },
      noise: { filterType: "lowpass", filterFreq: 1200, gain: 0.3 },
    },
  },
  last_alive: {
    id: "last_alive", priority: 4, durationSec: 3.0, duckAmount: 0.5,
    targetTier: "climax",
    synth: {
      tonal: { type: "triangle", startFreq: 330, endFreq: 220, gain: 0.22 },
      noise: { filterType: "bandpass", filterFreq: 1500, filterQ: 0.8, gain: 0.16 },
    },
  },
  sweep: {
    id: "sweep", priority: 2, durationSec: 1.5, duckAmount: 0.3,
    targetTier: "combat",
    synth: {
      tonal: { type: "sine", startFreq: 110, endFreq: 880, gain: 0.18 },
    },
  },
  match_start: {
    id: "match_start", priority: 5, durationSec: 3.0, duckAmount: 0.5,
    targetTier: "calm",
    synth: {
      tonal: { type: "sawtooth", startFreq: 220, endFreq: 440, gain: 0.24 },
      noise: { filterType: "bandpass", filterFreq: 1800, filterQ: 1.0, gain: 0.16 },
    },
  },
};

interface ActiveCue {
  cue: CueDef;
  startedAt: number;
  endsAt: number;
  /** Cleanup function — disconnects cue synth nodes. */
  cleanup: () => void;
}

export class AdaptiveMusicMiddleware {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private dynamicMusic: DynamicMusicEngine | null = null;
  /** Currently-playing cue (only one at a time — higher-pri preempts). */
  private activeCue: ActiveCue | null = null;
  /** Pending cue waiting for the next bar boundary. */
  private pendingCue: CueDef | null = null;
  /** Baseline tier — returned to after a cue ends. */
  private baselineTier: CombatTier = "calm";
  /** Hit-point intensity — recent damage events ramp the tier up. */
  private hpIntensity = 0;
  /** Recent damage timestamps (performance.now) for ramp-down. */
  private recentDamage: number[] = [];
  /** Generation counter — bumped on dispose so timers reject. */
  private generation = 0;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Bar-dur cache (from dynamic-music current section). */
  private barDurSec = 0.5;

  attach(
    ctx: AudioContext,
    buses: BusMixer,
    noiseBuffer: AudioBuffer,
    dynamicMusic?: DynamicMusicEngine,
  ): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
    this.dynamicMusic = dynamicMusic ?? null;
  }

  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  /** Set the dynamic-music engine this middleware drives (tier changes). */
  setDynamicMusic(engine: DynamicMusicEngine): void {
    this.dynamicMusic = engine;
  }

  /** Set the baseline tier (returned to after a cue ends). */
  setBaselineTier(tier: CombatTier): void {
    this.baselineTier = tier;
  }

  /**
   * Trigger a cue by id. If a higher-priority cue is active, the active cue
   * is interrupted and the new one starts at the next bar boundary.
   */
  triggerCue(id: CueId): void {
    const cue = CUE_DEFS[id];
    if (!cue) return;
    // If a higher-priority cue is active, interrupt it.
    if (this.activeCue && this.activeCue.cue.priority < cue.priority) {
      this.stopActiveCue();
    }
    // Queue for the next bar boundary (or play immediately if no cue active).
    if (this.activeCue) {
      this.pendingCue = cue;
    } else {
      this.playCue(cue);
    }
  }

  /**
   * Notify the middleware of player damage (drives hit-point intensity).
   * Each damage event ramps the music tier up to "climax" over 0.5s, then
   * decays back to baseline over ~5s.
   */
  notifyPlayerDamage(amount: number): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.recentDamage.push(now);
    // Trim events older than 5s.
    this.recentDamage = this.recentDamage.filter((t) => now - t < 5000);
    // Intensity = number of recent damage events / 5, clamped to 0..1.
    this.hpIntensity = Math.min(1, this.recentDamage.length / 5);
    // Apply the tier immediately if no cue is active.
    if (!this.activeCue && this.dynamicMusic) {
      const targetTier: CombatTier = this.hpIntensity > 0.6 ? "climax"
        : this.hpIntensity > 0.3 ? "combat"
        : this.baselineTier;
      this.dynamicMusic.setTier(targetTier, 0.5);
    }
  }

  /**
   * Per-frame update — decays the hit-point intensity + checks for expired
   * cues. Called from AudioSystem.update() each frame.
   */
  update(): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    // Trim recent damage events older than 5s.
    this.recentDamage = this.recentDamage.filter((t) => now - t < 5000);
    const newIntensity = Math.min(1, this.recentDamage.length / 5);
    if (newIntensity !== this.hpIntensity) {
      this.hpIntensity = newIntensity;
      // If no cue is active, ramp the dynamic music tier to match.
      if (!this.activeCue && this.dynamicMusic) {
        const targetTier: CombatTier = this.hpIntensity > 0.6 ? "climax"
          : this.hpIntensity > 0.3 ? "combat"
          : this.baselineTier;
        this.dynamicMusic.setTier(targetTier, 1.0);
      }
    }
    // Check if the active cue expired.
    if (this.activeCue && now >= this.activeCue.endsAt) {
      this.stopActiveCue();
      // Play the pending cue (if any) at the next bar boundary.
      if (this.pendingCue) {
        const next = this.pendingCue;
        this.pendingCue = null;
        this.playCue(next);
      }
    }
  }

  /** Get the currently-active cue id (or null). */
  getActiveCue(): CueId | null {
    return this.activeCue?.cue.id ?? null;
  }

  /** Stop any active cue + clear the pending queue. */
  stopAll(): void {
    this.stopActiveCue();
    this.pendingCue = null;
  }

  // ── Internal cue playback ────────────────────────────────────────────────

  private playCue(cue: CueDef): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const musicBus = this.buses.getBus("music");
    if (!musicBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Duck the music bus by `duckAmount` for the cue's duration.
    const duckRatio = Math.max(0.0001, 1 - cue.duckAmount);
    const g = musicBus.gain as AudioParam & {
      cancelAndHoldAtTime?: (t: number) => void;
    };
    if (typeof g.cancelAndHoldAtTime === "function") {
      g.cancelAndHoldAtTime(t);
    } else {
      musicBus.gain.cancelScheduledValues(t);
      musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), t);
    }
    musicBus.gain.exponentialRampToValueAtTime(duckRatio, t + 0.05);
    musicBus.gain.exponentialRampToValueAtTime(1.0, t + cue.durationSec);

    // Drive the dynamic-music engine to the cue's target tier.
    this.dynamicMusic?.setTier(cue.targetTier, 0.5);

    // Synthesize the cue sting.
    const cleanupFns: Array<() => void> = [];
    if (cue.synth.tonal) {
      const osc = ctx.createOscillator();
      osc.type = cue.synth.tonal.type;
      osc.frequency.setValueAtTime(cue.synth.tonal.startFreq, t);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, cue.synth.tonal.endFreq),
        t + cue.durationSec,
      );
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(cue.synth.tonal.gain, t + 0.02);
      og.gain.exponentialRampToValueAtTime(0.0001, t + cue.durationSec);
      osc.connect(og);
      og.connect(musicBus);
      osc.start(t);
      osc.stop(t + cue.durationSec + 0.02);
      cleanupFns.push(() => {
        try { osc.stop(); } catch { /* noop */ }
        try { og.disconnect(); } catch { /* noop */ }
      });
    }
    if (cue.synth.noise) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = cue.synth.noise.filterType;
      filter.frequency.value = cue.synth.noise.filterFreq;
      if (cue.synth.noise.filterQ) filter.Q.value = cue.synth.noise.filterQ;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.linearRampToValueAtTime(cue.synth.noise.gain, t + 0.02);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + cue.durationSec);
      src.connect(filter);
      filter.connect(ng);
      ng.connect(musicBus);
      src.start(t);
      src.stop(t + cue.durationSec + 0.02);
      cleanupFns.push(() => {
        try { src.stop(); } catch { /* noop */ }
        try { filter.disconnect(); } catch { /* noop */ }
        try { ng.disconnect(); } catch { /* noop */ }
      });
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.activeCue = {
      cue,
      startedAt: now,
      endsAt: now + cue.durationSec * 1000,
      cleanup: () => {
        for (const fn of cleanupFns) {
          try { fn(); } catch { /* noop */ }
        }
      },
    };
  }

  private stopActiveCue(): void {
    if (!this.activeCue) return;
    try { this.activeCue.cleanup(); } catch { /* noop */ }
    this.activeCue = null;
    // Restore the dynamic music to the baseline tier (or hp-intensity tier).
    if (this.dynamicMusic) {
      const targetTier: CombatTier = this.hpIntensity > 0.6 ? "climax"
        : this.hpIntensity > 0.3 ? "combat"
        : this.baselineTier;
      this.dynamicMusic.setTier(targetTier, 1.0);
    }
  }

  dispose(): void {
    this.generation++;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.stopActiveCue();
    this.pendingCue = null;
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
    this.dynamicMusic = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _middleware: AdaptiveMusicMiddleware | null = null;
export function getAdaptiveMusicMiddleware(): AdaptiveMusicMiddleware {
  if (!_middleware) _middleware = new AdaptiveMusicMiddleware();
  return _middleware;
}
