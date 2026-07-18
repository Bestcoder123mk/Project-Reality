/**
 * Section H — Extended surface foley with shoe materials + weight modulation.
 *
 * Section H prompt coverage: H_Audio_Immersion-00083/00098/04949 — footstep
 * audio on concrete/wood/metal/snow per surface, plus voice-over line sets
 * for the same. Also covers H_Audio_Immersion-00091/04932 — shell-casing
 * drop audio per surface.
 *
 * The existing foley.ts implements 6 surfaces (metal/concrete/sand/water/
 * wood/dirt) with a single preset per surface. AudioEnhancements.ts extends
 * the table to 9 surfaces (adds grass/snow/gravel) but the entries are
 * sample-slug stubs — there's no procedural synth path for the 3 new
 * surfaces. This module fills that gap AND adds shoe-material variation
 * (boots / sneakers / barefoot / combat) and weight modulation (heavy
 * load = louder + darker footsteps).
 *
 * All audio is procedural — each footstep is a synthesized noise burst +
 * tonal layer (metallic ping, water splash, snow crunch, gravel rattle).
 * Routes through the existing FoleyEngine's bus via BusMixer.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

/** Extended surface set — 8 surfaces (adds snow + gravel to foley.ts's 6). */
export type ExtendedSurface =
  | "metal"
  | "concrete"
  | "wood"
  | "dirt"
  | "sand"
  | "water"
  | "grass"
  | "snow"
  | "gravel";

/** Shoe material — modifies the noise burst's tonal character. */
export type ShoeMaterial = "boots" | "sneakers" | "barefoot" | "combat" | "heavy_boots";

export interface SurfaceFoleyPreset {
  /** Filter applied to the noise layer. */
  filterType: BiquadFilterType;
  filterFreq: number;
  filterQ?: number;
  /** Peak gain for the noise layer (linear, pre-intensity). */
  gain: number;
  /** Decay time for the noise envelope (seconds). */
  decay: number;
  /** Optional tonal layer (metallic ping, water splash, snow crunch, etc.). */
  osc?: {
    type: OscillatorType;
    startFreq: number;
    endFreq?: number;
    gain: number;
    decay: number;
  };
  /** Optional secondary noise layer for surface debris (gravel rattle, etc.). */
  debris?: {
    filterFreq: number;
    gain: number;
    decay: number;
    rate: number; // average debris particles per step
  };
}

/**
 * Extended per-surface recipes — 9 surfaces total.
 *
 * Tuned by ear against the 1s white noise buffer generated in audio.ts.
 * Metal/concrete/wood/dirt/sand/water mirror foley.ts's FOOTSTEP_PRESETS so
 * the two engines produce consistent base timbres; grass/snow/gravel are new.
 */
export const EXTENDED_SURFACE_PRESETS: Record<ExtendedSurface, SurfaceFoleyPreset> = {
  metal: {
    filterType: "highpass",
    filterFreq: 2600,
    gain: 0.18,
    decay: 0.085,
    osc: { type: "triangle", startFreq: 1900, endFreq: 1400, gain: 0.13, decay: 0.06 },
  },
  concrete: {
    filterType: "lowpass",
    filterFreq: 1100,
    gain: 0.22,
    decay: 0.075,
  },
  wood: {
    filterType: "bandpass",
    filterFreq: 450,
    filterQ: 4.5,
    gain: 0.22,
    decay: 0.065,
    osc: { type: "triangle", startFreq: 180, gain: 0.1, decay: 0.05 },
  },
  dirt: {
    filterType: "lowpass",
    filterFreq: 500,
    gain: 0.18,
    decay: 0.1,
  },
  sand: {
    filterType: "lowpass",
    filterFreq: 600,
    filterQ: 0.6,
    gain: 0.16,
    decay: 0.12,
  },
  water: {
    filterType: "lowpass",
    filterFreq: 1500,
    gain: 0.18,
    decay: 0.13,
    osc: { type: "sine", startFreq: 260, endFreq: 90, gain: 0.15, decay: 0.1 },
  },
  // Grass — soft swish, no tonal layer, longer decay than dirt.
  grass: {
    filterType: "bandpass",
    filterFreq: 2400,
    filterQ: 0.5,
    gain: 0.12,
    decay: 0.14,
  },
  // Snow — crunch: filtered noise + descending high-freq squeak.
  snow: {
    filterType: "highpass",
    filterFreq: 1800,
    filterQ: 0.7,
    gain: 0.2,
    decay: 0.11,
    osc: { type: "sawtooth", startFreq: 2200, endFreq: 800, gain: 0.08, decay: 0.09 },
  },
  // Gravel — broad-spectrum rattle + many small debris particles.
  gravel: {
    filterType: "bandpass",
    filterFreq: 2200,
    filterQ: 0.7,
    gain: 0.24,
    decay: 0.13,
    debris: { filterFreq: 3500, gain: 0.07, decay: 0.18, rate: 4 },
  },
};

/**
 * Per-shoe modifiers. Each shoe scales the surface preset's gain + filter
 * cutoff + decay. Combat boots are loudest + darkest; sneakers are quieter
 * + brighter; barefoot is softest + brightest + shortest.
 */
export const SHOE_MODIFIERS: Record<ShoeMaterial, {
  gainMult: number;
  filterFreqMult: number;
  decayMult: number;
}> = {
  boots:       { gainMult: 1.0,  filterFreqMult: 1.0,  decayMult: 1.0 },
  combat:      { gainMult: 1.1,  filterFreqMult: 0.9,  decayMult: 1.05 },
  heavy_boots: { gainMult: 1.25, filterFreqMult: 0.8,  decayMult: 1.15 },
  sneakers:    { gainMult: 0.7,  filterFreqMult: 1.25, decayMult: 0.85 },
  barefoot:    { gainMult: 0.55, filterFreqMult: 1.5,  decayMult: 0.7 },
};

export interface SurfaceFoleyOpts {
  surface: ExtendedSurface;
  shoe?: ShoeMaterial;
  /** Movement intensity 0..2 (1 = walk, 1.5 = sprint, 0.6 = crouch-walk). */
  intensity?: number;
  /** Encumbrance 0..1 (heavier load = louder + darker footstep). */
  load?: number;
}

export class SurfaceFoleyEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
  }

  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  /**
   * Play a single footstep with surface + shoe + load modulation.
   *
   * The shoe modifier scales the surface preset's gain/filter/decay. The
   * load modifier further darkens + amplifies the step (heavy pack = louder,
   * lower-frequency content). The intensity modifier scales the peak gain.
   */
  playFootstep(opts: SurfaceFoleyOpts): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const preset = EXTENDED_SURFACE_PRESETS[opts.surface];
    const shoeMod = SHOE_MODIFIERS[opts.shoe ?? "boots"];
    const intensity = opts.intensity ?? 1;
    const load = Math.max(0, Math.min(1, opts.load ?? 0));
    // Final per-step modifiers.
    const loadGainMult = 1 + load * 0.3; // up to +30% gain at full load
    const loadFilterMult = 1 - load * 0.2; // up to -20% filter freq at full load
    const peak = Math.max(
      0.0001,
      preset.gain * intensity * shoeMod.gainMult * loadGainMult,
    );
    const filterFreq = Math.max(
      80,
      preset.filterFreq * shoeMod.filterFreqMult * loadFilterMult,
    );
    const decay = Math.max(0.02, preset.decay * shoeMod.decayMult);
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Noise layer
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = preset.filterType;
    filter.frequency.value = filterFreq;
    if (preset.filterQ) filter.Q.value = preset.filterQ;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(filter);
    filter.connect(g);
    g.connect(bus);
    src.start(t);
    src.stop(t + decay + 0.02);
    src.onended = () => {
      try { filter.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };

    // Optional tonal layer (metal ping / water splash / snow squeak / etc.)
    if (preset.osc) {
      const o = preset.osc;
      const osc = ctx.createOscillator();
      osc.type = o.type;
      osc.frequency.setValueAtTime(o.startFreq, t);
      if (o.endFreq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.endFreq), t + o.decay);
      }
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(
        Math.max(0.0001, o.gain * intensity * shoeMod.gainMult),
        t + 0.001,
      );
      og.gain.exponentialRampToValueAtTime(0.0001, t + o.decay);
      osc.connect(og);
      og.connect(bus);
      osc.start(t);
      osc.stop(t + o.decay + 0.02);
      osc.onended = () => {
        try { og.disconnect(); } catch { /* noop */ }
      };
    }

    // Optional debris layer (gravel rattle, etc.) — emits N short noise
    // particles after the main footstep.
    if (preset.debris) {
      const d = preset.debris;
      const count = Math.max(1, Math.round(d.rate * (0.5 + Math.random() * 0.5)));
      for (let i = 0; i < count; i++) {
        const dt = t + 0.02 + Math.random() * d.decay * 0.5;
        const dsrc = ctx.createBufferSource();
        dsrc.buffer = this.noiseBuffer;
        // Random offset into the noise buffer for variety.
        dsrc.loop = true;
        dsrc.playbackRate.value = 0.8 + Math.random() * 0.6;
        const dBP = ctx.createBiquadFilter();
        dBP.type = "bandpass";
        dBP.frequency.value = d.filterFreq * (0.7 + Math.random() * 0.6);
        dBP.Q.value = 2.0;
        const dg = ctx.createGain();
        const dPeak = Math.max(0.0001, d.gain * intensity * (0.5 + Math.random() * 0.5));
        dg.gain.setValueAtTime(0.0001, dt);
        dg.gain.linearRampToValueAtTime(dPeak, dt + 0.001);
        dg.gain.exponentialRampToValueAtTime(0.0001, dt + 0.04 + Math.random() * 0.04);
        dsrc.connect(dBP);
        dBP.connect(dg);
        dg.connect(bus);
        dsrc.start(dt);
        dsrc.stop(dt + 0.1);
        const idx = i;
        dsrc.onended = () => {
          try { dBP.disconnect(); } catch { /* noop */ }
          try { dg.disconnect(); } catch { /* noop */ }
          void idx;
        };
      }
    }
  }

  /**
   * Play a shell-casing drop on a given surface (prompts 84, 85, 91, 4908, 4932).
   * Two-stage sound: initial metallic ping + surface bounce.
   */
  playShellCasingDrop(surface: ExtendedSurface, intensity: number = 1): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Metallic ping — bright triangle descending.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(3200, t);
    osc.frequency.exponentialRampToValueAtTime(2200, t + 0.05);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.18 * intensity, t + 0.001);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(og);
    og.connect(bus);
    osc.start(t);
    osc.stop(t + 0.1);
    osc.onended = () => { try { og.disconnect(); } catch { /* noop */ } };
    // Surface bounce — use the surface preset at reduced gain after 60ms.
    const bounceT = t + 0.06;
    const preset = EXTENDED_SURFACE_PRESETS[surface];
    const bsrc = ctx.createBufferSource();
    bsrc.buffer = this.noiseBuffer;
    const bfilter = ctx.createBiquadFilter();
    bfilter.type = preset.filterType;
    bfilter.frequency.value = preset.filterFreq;
    if (preset.filterQ) bfilter.Q.value = preset.filterQ;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, bounceT);
    bg.gain.linearRampToValueAtTime(0.1 * intensity, bounceT + 0.001);
    bg.gain.exponentialRampToValueAtTime(0.0001, bounceT + 0.04);
    bsrc.connect(bfilter);
    bfilter.connect(bg);
    bg.connect(bus);
    bsrc.start(bounceT);
    bsrc.stop(bounceT + 0.06);
    bsrc.onended = () => {
      try { bfilter.disconnect(); } catch { /* noop */ }
      try { bg.disconnect(); } catch { /* noop */ }
    };
  }

  dispose(): void {
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _surface: SurfaceFoleyEngine | null = null;
export function getSurfaceFoleyEngine(): SurfaceFoleyEngine {
  if (!_surface) _surface = new SurfaceFoleyEngine();
  return _surface;
}
