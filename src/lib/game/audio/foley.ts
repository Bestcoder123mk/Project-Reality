/**
 * SEC8-AUDIO (prompt 70) — Footstep / movement foley with surface-aware timbres.
 *
 * Each surface has a distinct procedural recipe (noise burst + filter +
 * optional oscillator layer for ping/splash/knock) and is wired through the
 * SFX bus via the BusMixer.
 *
 * SurfaceMaterial is intentionally a strict superset of the ballistics
 * material table (see src/lib/game/systems/Ballistics.ts RICOCHET_PROBABILITY):
 * ballistics material slugs map onto the foley SurfaceMaterial union via
 * `ballisticsSurfaceToFoley()`.
 *
 * ─── G-5000 prompt mapping ────────────────────────────────────────────────
 *   #3403 → G2 #114 — src.stop() no disconnect            [onended → filter/gain.disconnect()]
 *   #3406 → G2 #117 — click on set (partial — foley)      [1ms linearRampToValueAtTime attack on noise + tonal layers]
 *   #3461 → G  #838 — bullet impact per surface           [IMPACT_PRESETS — 6 surfaces: metal/concrete/sand/water/wood/dirt]
 *   #3469 → G  #846 — footstep per shoe (FOOTSTEP_PRESETS feeds SectionG.ts footstepVariantGain which scales per shoe)
 *   #3470 → G  #847 — footstep per speed (footstepVariantGain scales per speed: sprint +30%, walk nominal)
 *   #3471 → G  #848 — footstep per stance (footstepVariantGain scales per stance: crouch -20%, prone -50%)
 *   #3551 → G  #838 — (cross-ref to #3461)
 *   #3559 → G  #846 — (cross-ref to #3469)
 *   #3560 → G  #847 — (cross-ref to #3470)
 *   #3561 → G  #848 — (cross-ref to #3471)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BusMixer } from "./buses";

export type SurfaceMaterial =
  | "metal"
  | "concrete"
  | "sand"
  | "water"
  | "wood"
  | "dirt";

export interface FootstepPreset {
  /** Filter applied to the noise layer. */
  filterType: BiquadFilterType;
  filterFreq: number;
  filterQ?: number;
  /** Peak gain for the noise layer (linear, pre-intensity). */
  gain: number;
  /** Decay time for the noise envelope (seconds). */
  decay: number;
  /** Optional tonal layer: metallic ping, water splash, wood knock. */
  osc?: {
    type: OscillatorType;
    startFreq: number;
    endFreq?: number;
    gain: number;
    decay: number;
  };
}

/**
 * Per-surface foley recipes. Tuned by ear against the noiseBuffer (1s white
 * noise generated in audio.ts:AudioEngine.init).
 */
export const FOOTSTEP_PRESETS: Record<SurfaceMaterial, FootstepPreset> = {
  // Metal grating — bright metallic ping + bright noise tick.
  metal: {
    filterType: "highpass",
    filterFreq: 2600,
    gain: 0.18,
    decay: 0.085,
    osc: { type: "triangle", startFreq: 1900, endFreq: 1400, gain: 0.13, decay: 0.06 },
  },
  // Concrete — thuddy broadband noise burst, lowpassed.
  concrete: {
    filterType: "lowpass",
    filterFreq: 1100,
    gain: 0.22,
    decay: 0.075,
  },
  // Sand — soft filtered noise, longer decay, no tonal layer.
  sand: {
    filterType: "lowpass",
    filterFreq: 600,
    filterQ: 0.6,
    gain: 0.16,
    decay: 0.12,
  },
  // Water — splashy noise + descending sine bubble.
  water: {
    filterType: "lowpass",
    filterFreq: 1500,
    gain: 0.18,
    decay: 0.13,
    osc: { type: "sine", startFreq: 260, endFreq: 90, gain: 0.15, decay: 0.1 },
  },
  // Wood — hollow bandpass knock + low triangle body.
  wood: {
    filterType: "bandpass",
    filterFreq: 450,
    filterQ: 4.5,
    gain: 0.22,
    decay: 0.065,
    osc: { type: "triangle", startFreq: 180, gain: 0.1, decay: 0.05 },
  },
  // Dirt — soft lowpassed thump, slightly longer than concrete.
  dirt: {
    filterType: "lowpass",
    filterFreq: 500,
    gain: 0.18,
    decay: 0.1,
  },
};

/**
 * Map a ballistics material slug (concrete / sheet_metal / steel_plate /
 * wood / sand / glass / earth / foliage / drywall / brick / sandbag / flesh)
 * onto a foley SurfaceMaterial. Anything unknown falls back to "concrete".
 */
export function ballisticsSurfaceToFoley(slug: string): SurfaceMaterial {
  switch (slug) {
    case "sheet_metal":
    case "steel_plate":
      return "metal";
    case "wood":
      return "wood";
    case "sand":
    case "sandbag":
      return "sand";
    case "earth":
      return "dirt";
    case "water":
      return "water";
    case "concrete":
    case "brick":
      return "concrete";
    default:
      // glass / foliage / drywall / flesh / unknown → deadened concrete-ish
      return "concrete";
  }
}

/**
 * Impact (bullet-hit) preset per surface — sharper + louder than footstep,
 * with a brighter filter to read as a distinct "tick/thwack/ping".
 */
export const IMPACT_PRESETS: Record<SurfaceMaterial, FootstepPreset> = {
  metal: {
    filterType: "bandpass",
    filterFreq: 3200,
    filterQ: 2.0,
    gain: 0.32,
    decay: 0.09,
    osc: { type: "triangle", startFreq: 2400, endFreq: 1700, gain: 0.22, decay: 0.08 },
  },
  concrete: {
    filterType: "bandpass",
    filterFreq: 1500,
    filterQ: 1.2,
    gain: 0.34,
    decay: 0.08,
  },
  sand: {
    filterType: "lowpass",
    filterFreq: 700,
    gain: 0.22,
    decay: 0.12,
  },
  water: {
    filterType: "lowpass",
    filterFreq: 1800,
    gain: 0.28,
    decay: 0.14,
    osc: { type: "sine", startFreq: 320, endFreq: 120, gain: 0.18, decay: 0.12 },
  },
  wood: {
    filterType: "bandpass",
    filterFreq: 600,
    filterQ: 3.5,
    gain: 0.32,
    decay: 0.07,
    osc: { type: "triangle", startFreq: 240, gain: 0.16, decay: 0.06 },
  },
  dirt: {
    filterType: "lowpass",
    filterFreq: 600,
    gain: 0.26,
    decay: 0.11,
  },
};

export class FoleyEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
  }

  /** Inject a fresh noise buffer (e.g. after AudioContext reset). */
  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  /**
   * Play a single footstep on the given surface. `intensity` scales the peak
   * gain (0..1+: 1 = walk, 0.6 = crouch-walk, 1.4 = sprint). Routes through
   * the SFX bus.
   */
  playFootstep(surface: SurfaceMaterial, intensity: number = 1): void {
    const preset = FOOTSTEP_PRESETS[surface];
    this.playPreset(preset, intensity);
  }

  /** Bullet-impact variant — uses the louder/sharper IMPACT_PRESETS table. */
  playImpact(surface: SurfaceMaterial, intensity: number = 1): void {
    const preset = IMPACT_PRESETS[surface];
    this.playPreset(preset, intensity);
  }

  /** Shared voice for footstep + impact synthesis. */
  private playPreset(preset: FootstepPreset, intensity: number): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const peak = Math.max(0.0001, preset.gain * intensity);

    // Noise layer
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = preset.filterType;
    filter.frequency.value = preset.filterFreq;
    if (preset.filterQ) filter.Q.value = preset.filterQ;
    const g = ctx.createGain();
    // G2 #117 — 1ms attack (was: setValueAtTime jump) — softens onset click.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + preset.decay);
    src.connect(filter);
    filter.connect(g);
    g.connect(bus);
    src.start(t);
    src.stop(t + preset.decay + 0.02);
    // G2 #114 — was: only `src.stop()`, no disconnect. Filter + gain + bus
    // connections leak every footstep (footsteps are the most frequent SFX
    // in the game — leaks here dominate the AudioContext node count after a
    // long session). Disconnect the chain on end.
    src.onended = () => {
      try { filter.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };

    // Optional tonal layer (metal ping / water splash / wood knock)
    if (preset.osc) {
      const o = preset.osc;
      const osc = ctx.createOscillator();
      osc.type = o.type;
      osc.frequency.setValueAtTime(o.startFreq, t);
      if (o.endFreq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.endFreq), t + o.decay);
      }
      const og = ctx.createGain();
      // G2 #117 — 1ms attack on the tonal layer too.
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(Math.max(0.0001, o.gain * intensity), t + 0.001);
      og.gain.exponentialRampToValueAtTime(0.0001, t + o.decay);
      osc.connect(og);
      og.connect(bus);
      osc.start(t);
      osc.stop(t + o.decay + 0.02);
      // G2 #114 — disconnect the tonal layer's gain too.
      osc.onended = () => {
        try { og.disconnect(); } catch { /* noop */ }
      };
    }
  }

  dispose(): void {
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
  }
}
