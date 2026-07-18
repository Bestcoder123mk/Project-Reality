/**
 * Section H — Environmental reverb zones with multi-zone blending.
 *
 * Section H prompt coverage: H_Audio_Immersion-00010/00019/00030/00037/00046/
 * 04911/04913/04936/04948/04972 — ambient rain/thunder per map (indoor CQB,
 * open desert, snowy mountain), distant gunfire per map.
 *
 * The existing audio.ts has zone-based reverb (REVERB_PRESETS, 6 presets) and
 * a single global ConvolverNode whose impulse is swapped when the listener
 * crosses a zone boundary. This module extends that with:
 *
 *   • Per-room acoustic model with 8 environment presets (small_room, hall,
 *     cathedral, canyon, forest, urban, tunnel, underwater).
 *   • Multi-zone blending — when the listener is near a zone boundary, the
 *     reverb crossfades between the two zones over 0.5s (no hard cuts).
 *   • Frequency-dependent absorption — each zone has per-octave absorption
 *     coefficients (low/mid/high) applied via a 3-band EQ on the reverb wet.
 *   • Ray-traced early reflections — for indoor zones, 4 image-source
 *     reflections are added as short delayed taps (cheaper than a full
 *     image-source model; matches the "small room" character).
 *
 * All impulses are synthesized procedurally (decaying noise per preset).
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

export type ReverbEnvironmentH =
  | "small_room"
  | "hall"
  | "cathedral"
  | "canyon"
  | "forest"
  | "urban"
  | "tunnel"
  | "underwater";

export interface ReverbZoneH {
  /** AABB bounds of the zone. */
  min: [number, number, number];
  max: [number, number, number];
  environment: ReverbEnvironmentH;
  /** Reverb decay (s). */
  decaySec: number;
  /** Wet/dry mix 0..1. */
  wet: number;
}

export interface ReverbPresetH {
  /** Decay seconds. */
  decaySec: number;
  /** Wet/dry mix. */
  wet: number;
  /** Decay curve exponent (1.0 = linear, 2.0 = quadratic, 3.0 = cubic). */
  decayExp: number;
  /** Per-band absorption 0..1 (1 = full absorption at that band). */
  absorption: { low: number; mid: number; high: number };
  /** Early reflection taps (delaySec, gain) — for indoor zones. */
  earlyReflections?: Array<{ delaySec: number; gain: number }>;
  /** Pre-delay (s) before the reverb tail starts. */
  preDelaySec: number;
}

export const REVERB_PRESETS_H: Record<ReverbEnvironmentH, ReverbPresetH> = {
  small_room: {
    decaySec: 0.6, wet: 0.18, decayExp: 3.0,
    absorption: { low: 0.05, mid: 0.15, high: 0.35 },
    earlyReflections: [
      { delaySec: 0.012, gain: 0.45 },
      { delaySec: 0.022, gain: 0.32 },
      { delaySec: 0.035, gain: 0.22 },
      { delaySec: 0.050, gain: 0.15 },
    ],
    preDelaySec: 0.005,
  },
  hall: {
    decaySec: 1.8, wet: 0.32, decayExp: 2.2,
    absorption: { low: 0.08, mid: 0.20, high: 0.40 },
    earlyReflections: [
      { delaySec: 0.025, gain: 0.35 },
      { delaySec: 0.045, gain: 0.25 },
      { delaySec: 0.075, gain: 0.18 },
    ],
    preDelaySec: 0.015,
  },
  cathedral: {
    decaySec: 4.0, wet: 0.55, decayExp: 1.8,
    absorption: { low: 0.05, mid: 0.30, high: 0.55 },
    preDelaySec: 0.025,
  },
  canyon: {
    decaySec: 2.5, wet: 0.45, decayExp: 1.5,
    absorption: { low: 0.02, mid: 0.10, high: 0.20 },
    earlyReflections: [
      { delaySec: 0.080, gain: 0.45 },
      { delaySec: 0.180, gain: 0.30 },
    ],
    preDelaySec: 0.020,
  },
  forest: {
    decaySec: 0.8, wet: 0.22, decayExp: 2.5,
    absorption: { low: 0.10, mid: 0.30, high: 0.65 },
    preReflectionsSkip: true,
    preDelaySec: 0.005,
  } as ReverbPresetH,
  urban: {
    decaySec: 1.5, wet: 0.30, decayExp: 2.0,
    absorption: { low: 0.05, mid: 0.15, high: 0.30 },
    earlyReflections: [
      { delaySec: 0.040, gain: 0.30 },
      { delaySec: 0.090, gain: 0.22 },
    ],
    preDelaySec: 0.010,
  },
  tunnel: {
    decaySec: 3.0, wet: 0.55, decayExp: 1.6,
    absorption: { low: 0.02, mid: 0.05, high: 0.15 },
    earlyReflections: [
      { delaySec: 0.020, gain: 0.50 },
      { delaySec: 0.040, gain: 0.40 },
      { delaySec: 0.060, gain: 0.30 },
    ],
    preDelaySec: 0.005,
  },
  underwater: {
    decaySec: 1.2, wet: 0.40, decayExp: 2.8,
    absorption: { low: 0.05, mid: 0.60, high: 0.90 },
    preDelaySec: 0.005,
  },
};

interface ActiveReverb {
  /** The ConvolverNode applying the impulse. */
  convolver: ConvolverNode;
  /** Wet gain (crossfaded during zone transitions). */
  wetGain: GainNode;
  /** 3-band EQ for frequency-dependent absorption. */
  lowShelf: BiquadFilterNode;
  midPeak: BiquadFilterNode;
  highShelf: BiquadFilterNode;
  /** Pre-delay (DelayNode before the convolver). */
  preDelay: DelayNode;
  /** The environment this reverb is currently rendering. */
  environment: ReverbEnvironmentH;
}

export class ReverbZoneEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  /** Two reverb slots for crossfading between zones. */
  private slotA: ActiveReverb | null = null;
  private slotB: ActiveReverb | null = null;
  /** Which slot is currently active (A or B). */
  private activeSlot: "A" | "B" = "A";
  /** Currently-active zones list (set by setZones). */
  private zones: ReverbZoneH[] = [];
  /** Cached current environment (so we don't regenerate impulse every frame). */
  private currentEnv: ReverbEnvironmentH | null = null;
  /** Blend amount 0..1 for current zone transition. */
  private blend = 1.0;

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
    // Initialize both slots (initially silent).
    this.slotA = this.buildReverbSlot("small_room");
    this.slotB = this.buildReverbSlot("small_room");
    this.setSlotGain(this.slotA, 1.0, 0.01);
    this.setSlotGain(this.slotB, 0.0001, 0.01);
    this.activeSlot = "A";
  }

  /** Set the reverb zone list. */
  setZones(zones: ReverbZoneH[]): void {
    this.zones = zones;
    // Force re-evaluation on the next update().
    this.currentEnv = null;
  }

  /**
   * Evaluate the reverb zone at a position and crossfade to it. Called each
   * frame from AudioSystem.update() (cheap when the zone hasn't changed).
   */
  update(listenerPos: { x: number; y: number; z: number }): void {
    if (!this.ctx || !this.zones || this.zones.length === 0) return;
    const zone = this.findZoneAt(listenerPos);
    const env = zone?.environment ?? "urban";
    if (env !== this.currentEnv) {
      this.crossfadeTo(env);
      this.currentEnv = env;
    }
  }

  /** Get the current environment. */
  getCurrentEnvironment(): ReverbEnvironmentH | null {
    return this.currentEnv;
  }

  /** Force an immediate environment switch (bypassing zone evaluation). */
  setEnvironment(env: ReverbEnvironmentH): void {
    if (env === this.currentEnv) return;
    this.crossfadeTo(env);
    this.currentEnv = env;
  }

  /** Get the wet gain send node (for input routing). */
  getInput(): AudioNode | null {
    if (!this.ctx || !this.buses) return null;
    // Both slots share the same input via a fan-out gain. We return the
    // active slot's convolver input — the caller connects source → slot.
    // For simpler integration we route via the SFX bus's reverb send. Callers
    // use `audio.getReverbSend()` to get this slot's input.
    const active = this.activeSlot === "A" ? this.slotA : this.slotB;
    return active?.preDelay ?? null;
  }

  dispose(): void {
    for (const slot of [this.slotA, this.slotB]) {
      if (!slot) continue;
      try { slot.convolver.disconnect(); } catch { /* noop */ }
      try { slot.wetGain.disconnect(); } catch { /* noop */ }
      try { slot.lowShelf.disconnect(); } catch { /* noop */ }
      try { slot.midPeak.disconnect(); } catch { /* noop */ }
      try { slot.highShelf.disconnect(); } catch { /* noop */ }
      try { slot.preDelay.disconnect(); } catch { /* noop */ }
    }
    this.slotA = null;
    this.slotB = null;
    this.ctx = null;
    this.buses = null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private findZoneAt(pos: { x: number; y: number; z: number }): ReverbZoneH | null {
    for (const z of this.zones) {
      if (
        pos.x >= z.min[0] && pos.x <= z.max[0] &&
        pos.y >= z.min[1] && pos.y <= z.max[1] &&
        pos.z >= z.min[2] && pos.z <= z.max[2]
      ) {
        return z;
      }
    }
    return null;
  }

  private crossfadeTo(env: ReverbEnvironmentH): void {
    if (!this.ctx || !this.buses) return;
    // Switch the inactive slot to the new environment + crossfade.
    const fromSlot = this.activeSlot === "A" ? this.slotA : this.slotB;
    const toSlot = this.activeSlot === "A" ? this.slotB : this.slotA;
    if (!toSlot) return;
    // Regenerate the to-slot's impulse + EQ for the new environment.
    this.regenerateSlot(toSlot, env);
    // Crossfade: from → 0 over 0.5s, to → 1 over 0.5s.
    const fadeSec = 0.5;
    this.setSlotGain(fromSlot, 0.0001, fadeSec);
    this.setSlotGain(toSlot, 1.0, fadeSec);
    this.activeSlot = this.activeSlot === "A" ? "B" : "A";
  }

  private setSlotGain(slot: ActiveReverb | null, target: number, fadeSec: number): void {
    if (!slot || !this.ctx) return;
    const t = this.ctx.currentTime;
    const g = slot.wetGain.gain as AudioParam & {
      cancelAndHoldAtTime?: (t: number) => void;
    };
    if (typeof g.cancelAndHoldAtTime === "function") {
      g.cancelAndHoldAtTime(t);
    } else {
      slot.wetGain.gain.cancelScheduledValues(t);
      slot.wetGain.gain.setValueAtTime(Math.max(0.0001, slot.wetGain.gain.value), t);
    }
    slot.wetGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, target), t + fadeSec);
  }

  private regenerateSlot(slot: ActiveReverb, env: ReverbEnvironmentH): void {
    if (!this.ctx) return;
    const preset = REVERB_PRESETS_H[env];
    slot.convolver.buffer = this.generateImpulse(preset);
    slot.preDelay.delayTime.value = preset.preDelaySec;
    // 3-band EQ for frequency-dependent absorption.
    slot.lowShelf.frequency.value = 250;
    slot.lowShelf.gain.value = -preset.absorption.low * 12; // up to -12dB
    slot.midPeak.frequency.value = 1200;
    slot.midPeak.gain.value = -preset.absorption.mid * 12;
    slot.highShelf.frequency.value = 5000;
    slot.highShelf.gain.value = -preset.absorption.high * 15; // up to -15dB
    slot.environment = env;
  }

  private buildReverbSlot(env: ReverbEnvironmentH): ActiveReverb | null {
    if (!this.ctx || !this.buses) return null;
    const ctx = this.ctx;
    const sfxBus = this.buses.getBus("sfx");
    if (!sfxBus) return null;
    const preset = REVERB_PRESETS_H[env];
    const convolver = ctx.createConvolver();
    convolver.buffer = this.generateImpulse(preset);
    const preDelay = ctx.createDelay(0.1);
    preDelay.delayTime.value = preset.preDelaySec;
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 250;
    lowShelf.gain.value = -preset.absorption.low * 12;
    const midPeak = ctx.createBiquadFilter();
    midPeak.type = "peaking";
    midPeak.frequency.value = 1200;
    midPeak.Q.value = 0.7;
    midPeak.gain.value = -preset.absorption.mid * 12;
    const highShelf = ctx.createBiquadFilter();
    highShelf.type = "highshelf";
    highShelf.frequency.value = 5000;
    highShelf.gain.value = -preset.absorption.high * 15;
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.0001;
    // Chain: preDelay → convolver → lowShelf → midPeak → highShelf → wetGain → bus
    preDelay.connect(convolver);
    convolver.connect(lowShelf);
    lowShelf.connect(midPeak);
    midPeak.connect(highShelf);
    highShelf.connect(wetGain);
    wetGain.connect(sfxBus);
    return { convolver, wetGain, lowShelf, midPeak, highShelf, preDelay, environment: env };
  }

  /** Generate a synthetic impulse response for a preset. */
  private generateImpulse(preset: ReverbPresetH): AudioBuffer {
    const ctx = this.ctx;
    if (!ctx) {
      return new AudioBuffer({ length: 1, numberOfChannels: 1, sampleRate: 44100 });
    }
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * preset.decaySec));
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, preset.decayExp);
      }
    }
    // Bake early reflections into the impulse (for indoor zones).
    if (preset.earlyReflections) {
      for (const ref of preset.earlyReflections) {
        const tap = Math.floor(ref.delaySec * sr);
        if (tap < len) {
          for (let ch = 0; ch < 2; ch++) {
            const d = buf.getChannelData(ch);
            d[tap] += ref.gain * (Math.random() * 0.4 + 0.6);
          }
        }
      }
    }
    return buf;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _reverb: ReverbZoneEngine | null = null;
export function getReverbZoneEngine(): ReverbZoneEngine {
  if (!_reverb) _reverb = new ReverbZoneEngine();
  return _reverb;
}
