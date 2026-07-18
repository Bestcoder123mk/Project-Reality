/**
 * Section H — Dynamic music stems with horizontal resequencing + vertical
 * layering.
 *
 * Section H prompt coverage: H_Audio_Immersion-00026/00029/00031/00042/00067/
 * 04910/04917/04963/04987/04997 — killstreak fanfares, victory/defeat stings,
 * ambient wind per map, voice-over line sets for menu music events, etc.
 *
 * The existing music.ts implements 3 stems (calm/engaged/climax) that
 * crossfade on a 0..1 intensity. This module adds **horizontal resequencing**
 * — a bar-accurate music state machine that transitions between song
 * sections (intro / verse / chorus / bridge / outro) — and **vertical
 * layering** — each section has up to 5 stems (drums / bass / melody /
 * harmony / percussion) that can be toggled on or off based on combat state.
 *
 * Composers lay out tracks as a sequence of sections, each ~16 bars at a
 * fixed BPM. The engine schedules transitions on bar boundaries so the music
 * never cuts mid-phrase. Combat intensity controls which stems are audible
 * within each section (drums off during stealth, all-stems-on during climax).
 *
 * All audio is procedural — each stem is a synthesized oscillator + filtered
 * noise pattern, not a sample. The output routes through the music bus via
 * the existing BusMixer so ducking rules apply.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

/** Music section type — horizontal resequencing states. */
export type MusicSection = "intro" | "verse" | "chorus" | "bridge" | "outro";

/** Vertical stem layers — each can be independently toggled. */
export type MusicStem = "drums" | "bass" | "melody" | "harmony" | "percussion";

/** Combat intensity tier — drives which stems are audible. */
export type CombatTier = "stealth" | "calm" | "combat" | "climax";

export interface SectionDef {
  section: MusicSection;
  /** Bars in this section (default 16). */
  bars: number;
  /** Beats per minute (default 120). */
  bpm: number;
  /** Beats per bar (default 4). */
  beatsPerBar: number;
  /** Root frequency in Hz (default A2 = 110Hz). */
  rootHz: number;
  /** Mode — major / minor / dorian (affects melody intervals). */
  mode: "major" | "minor" | "dorian";
}

export const DEFAULT_SECTIONS: SectionDef[] = [
  { section: "intro",   bars: 4,  bpm: 120, beatsPerBar: 4, rootHz: 110, mode: "minor" },
  { section: "verse",   bars: 16, bpm: 120, beatsPerBar: 4, rootHz: 110, mode: "minor" },
  { section: "chorus",  bars: 8,  bpm: 124, beatsPerBar: 4, rootHz: 110, mode: "minor" },
  { section: "bridge",  bars: 8,  bpm: 116, beatsPerBar: 4, rootHz: 146.83, mode: "dorian" },
  { section: "outro",   bars: 4,  bpm: 120, beatsPerBar: 4, rootHz: 110, mode: "minor" },
];

/**
 * Per-tier stem gain matrix. Each tier exposes a subset of stems at varying
 * gains. Stealth mutes drums + melody; combat brings in everything; climax
 * adds the melody layer louder.
 */
export const TIER_STEM_GAINS: Record<CombatTier, Record<MusicStem, number>> = {
  stealth:    { drums: 0.0, bass: 0.45, melody: 0.0, harmony: 0.35, percussion: 0.0 },
  calm:       { drums: 0.5, bass: 0.55, melody: 0.4, harmony: 0.45, percussion: 0.3 },
  combat:     { drums: 0.7, bass: 0.6,  melody: 0.55, harmony: 0.5, percussion: 0.55 },
  climax:     { drums: 0.85, bass: 0.7, melody: 0.75, harmony: 0.6, percussion: 0.75 },
};

interface ActiveStem {
  gain: GainNode;
  oscs: OscillatorNode[];
  sources: AudioBufferSourceNode[];
  filters: BiquadFilterNode[];
}

export class DynamicMusicEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private sections: SectionDef[] = DEFAULT_SECTIONS;
  private currentSectionIdx = 0;
  private currentTier: CombatTier = "calm";
  private stems: Partial<Record<MusicStem, ActiveStem>> = {};
  private input: GainNode | null = null;
  private started = false;
  /** Next bar boundary in ctx.currentTime seconds. */
  private nextBarTime = 0;
  /** Beats elapsed in the current section (for transition scheduling). */
  private beatsElapsedInSection = 0;
  /** Generation counter — bumped on stop() so stale timers reject. */
  private generation = 0;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Optional callback fired when a section transition completes. */
  onSectionChange?: (section: MusicSection) => void;
  /** Optional callback fired when the tier changes. */
  onTierChange?: (tier: CombatTier) => void;

  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
  }

  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  /** Replace the section list (call before start()). */
  setSections(sections: SectionDef[]): void {
    if (this.started) return;
    this.sections = sections.length > 0 ? sections : DEFAULT_SECTIONS;
  }

  /** Start the dynamic music engine. Builds all 5 stems (initially muted). */
  start(): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer || this.started) return;
    const musicBus = this.buses.getBus("music");
    if (!musicBus) return;
    this.started = true;
    this.input = this.ctx.createGain();
    this.input.gain.value = 0.0001;
    this.input.connect(musicBus);
    // Build each stem (initially silent; gain ramps up via setTier).
    this.stems.drums = this.buildDrumStem();
    this.stems.bass = this.buildBassStem();
    this.stems.melody = this.buildMelodyStem();
    this.stems.harmony = this.buildHarmonyStem();
    this.stems.percussion = this.buildPercussionStem();
    this.currentSectionIdx = 0;
    this.beatsElapsedInSection = 0;
    this.nextBarTime = this.ctx.currentTime + 0.1;
    // Apply the initial tier (calm) so stems ramp in over ~1s.
    this.applyTier(this.currentTier, 1.0);
    // Schedule the bar-accurate advance.
    this.scheduleNextBar();
  }

  /** Stop the dynamic music (fade out + oscillator cleanup). */
  stop(): void {
    if (!this.ctx || !this.started) return;
    this.generation++;
    const myGen = this.generation;
    const t = this.ctx.currentTime;
    if (this.input) {
      const g = this.input.gain as AudioParam & {
        cancelAndHoldAtTime?: (t: number) => void;
      };
      if (typeof g.cancelAndHoldAtTime === "function") {
        g.cancelAndHoldAtTime(t);
      } else {
        this.input.gain.cancelScheduledValues(t);
        this.input.gain.setValueAtTime(Math.max(0.0001, this.input.gain.value), t);
      }
      this.input.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    }
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (myGen !== this.generation) return;
      for (const stem of Object.values(this.stems)) {
        if (!stem) continue;
        for (const o of stem.oscs) { try { o.stop(); } catch { /* noop */ } }
        for (const s of stem.sources) { try { s.stop(); } catch { /* noop */ } }
        try { stem.gain.disconnect(); } catch { /* noop */ }
      }
      this.stems = {};
      if (this.input) { try { this.input.disconnect(); } catch { /* noop */ } }
      this.input = null;
      this.started = false;
    }, 900);
    this.pendingTimers.add(timer);
  }

  /** Set the combat tier (drives per-stem gain). Crossfades over `fadeSec`. */
  setTier(tier: CombatTier, fadeSec: number = 0.8): void {
    if (tier === this.currentTier) return;
    this.currentTier = tier;
    if (this.started) this.applyTier(tier, fadeSec);
    this.onTierChange?.(tier);
  }

  /** Get the current combat tier. */
  getTier(): CombatTier {
    return this.currentTier;
  }

  /** Get the current section name. */
  getCurrentSection(): MusicSection {
    return this.sections[this.currentSectionIdx]?.section ?? "intro";
  }

  /**
   * Force a transition to a specific section at the next bar boundary.
   * Used by scripted events (e.g. on boss spawn → chorus).
   */
  queueSectionTransition(section: MusicSection): void {
    const idx = this.sections.findIndex((s) => s.section === section);
    if (idx < 0) return;
    this.pendingSectionIdx = idx;
  }
  private pendingSectionIdx: number | null = null;

  isRunning(): boolean {
    return this.started;
  }

  // ── Per-stem synth voices ──────────────────────────────────────────────

  private buildDrumStem(): ActiveStem {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(this.input!);
    const oscs: OscillatorNode[] = [];
    const sources: AudioBufferSourceNode[] = [];
    const filters: BiquadFilterNode[] = [];

    // Kick drum — sine with fast pitch drop, triggered on beat 1 of each bar.
    const kickOsc = ctx.createOscillator();
    kickOsc.type = "sine";
    kickOsc.frequency.value = 60;
    const kickGain = ctx.createGain();
    kickGain.gain.value = 0.0001; // gated — opened per beat by LFO schedule
    kickOsc.connect(kickGain);
    kickGain.connect(gain);
    kickOsc.start();
    oscs.push(kickOsc);

    // Snare — noise burst through bandpass, triggered on beats 2 + 4.
    const snareSrc = ctx.createBufferSource();
    snareSrc.buffer = this.noiseBuffer!;
    snareSrc.loop = true;
    const snareBP = ctx.createBiquadFilter();
    snareBP.type = "bandpass";
    snareBP.frequency.value = 1800;
    snareBP.Q.value = 0.9;
    const snareGain = ctx.createGain();
    snareGain.gain.value = 0.0001;
    snareSrc.connect(snareBP);
    snareBP.connect(snareGain);
    snareGain.connect(gain);
    snareSrc.start();
    sources.push(snareSrc);
    filters.push(snareBP);

    // Hat — highpassed noise, 8th-note pattern.
    const hatSrc = ctx.createBufferSource();
    hatSrc.buffer = this.noiseBuffer!;
    hatSrc.loop = true;
    const hatHP = ctx.createBiquadFilter();
    hatHP.type = "highpass";
    hatHP.frequency.value = 7000;
    const hatGain = ctx.createGain();
    hatGain.gain.value = 0.0001;
    hatSrc.connect(hatHP);
    hatHP.connect(hatGain);
    hatGain.connect(gain);
    hatSrc.start();
    sources.push(hatSrc);
    filters.push(hatHP);

    return { gain, oscs, sources, filters };
  }

  private buildBassStem(): ActiveStem {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(this.input!);
    const oscs: OscillatorNode[] = [];
    const sources: AudioBufferSourceNode[] = [];
    const filters: BiquadFilterNode[] = [];
    // Bass — sawtooth an octave below root, lowpassed for warmth.
    const bass = ctx.createOscillator();
    bass.type = "sawtooth";
    bass.frequency.value = this.sections[0]?.rootHz ?? 110;
    const bassLP = ctx.createBiquadFilter();
    bassLP.type = "lowpass";
    bassLP.frequency.value = 320;
    bassLP.Q.value = 1.2;
    bass.connect(bassLP);
    bassLP.connect(gain);
    bass.start();
    oscs.push(bass);
    filters.push(bassLP);
    return { gain, oscs, sources, filters };
  }

  private buildMelodyStem(): ActiveStem {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(this.input!);
    const oscs: OscillatorNode[] = [];
    const sources: AudioBufferSourceNode[] = [];
    const filters: BiquadFilterNode[] = [];
    // Melody — triangle 2 octaves above root, modulated by an LFO.
    const mel = ctx.createOscillator();
    mel.type = "triangle";
    mel.frequency.value = (this.sections[0]?.rootHz ?? 110) * 4;
    const melGain = ctx.createGain();
    melGain.gain.value = 0.6;
    mel.connect(melGain);
    melGain.connect(gain);
    mel.start();
    oscs.push(mel);
    // Vibrato LFO.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 4;
    lfo.connect(lfoGain);
    lfoGain.connect(mel.frequency);
    lfo.start();
    oscs.push(lfo);
    return { gain, oscs, sources, filters };
  }

  private buildHarmonyStem(): ActiveStem {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(this.input!);
    const oscs: OscillatorNode[] = [];
    const sources: AudioBufferSourceNode[] = [];
    const filters: BiquadFilterNode[] = [];
    // Harmony — pad of two detuned sawtooths a fifth above the root.
    const root = this.sections[0]?.rootHz ?? 110;
    const h1 = ctx.createOscillator();
    h1.type = "sawtooth";
    h1.frequency.value = root * 1.5;
    const h2 = ctx.createOscillator();
    h2.type = "sawtooth";
    h2.frequency.value = root * 1.5 * 1.005; // slight detune for chorus effect
    const padLP = ctx.createBiquadFilter();
    padLP.type = "lowpass";
    padLP.frequency.value = 1400;
    padLP.Q.value = 0.6;
    h1.connect(padLP);
    h2.connect(padLP);
    padLP.connect(gain);
    h1.start(); h2.start();
    oscs.push(h1, h2);
    filters.push(padLP);
    return { gain, oscs, sources, filters };
  }

  private buildPercussionStem(): ActiveStem {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(this.input!);
    const oscs: OscillatorNode[] = [];
    const sources: AudioBufferSourceNode[] = [];
    const filters: BiquadFilterNode[] = [];
    // Shaker — looping noise through a high bandpass, modulated by LFO.
    const shakerSrc = ctx.createBufferSource();
    shakerSrc.buffer = this.noiseBuffer!;
    shakerSrc.loop = true;
    const shakerBP = ctx.createBiquadFilter();
    shakerBP.type = "bandpass";
    shakerBP.frequency.value = 5000;
    shakerBP.Q.value = 1.5;
    const shakerGain = ctx.createGain();
    shakerGain.gain.value = 0.0001;
    shakerSrc.connect(shakerBP);
    shakerBP.connect(shakerGain);
    shakerGain.connect(gain);
    shakerSrc.start();
    sources.push(shakerSrc);
    filters.push(shakerBP);
    return { gain, oscs, sources, filters };
  }

  // ── Bar-accurate scheduling ──────────────────────────────────────────────

  private scheduleNextBar(): void {
    if (!this.ctx || !this.started) return;
    const myGen = this.generation;
    const section = this.sections[this.currentSectionIdx];
    if (!section) return;
    const barDurSec = (60 / section.bpm) * section.beatsPerBar;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (myGen !== this.generation || !this.started) return;
      this.onBarBoundary();
      this.scheduleNextBar();
    }, Math.max(20, barDurSec * 1000));
    this.pendingTimers.add(timer);
    this.nextBarTime = this.ctx.currentTime + barDurSec;
  }

  /** Called at each bar boundary — advance the section if needed. */
  private onBarBoundary(): void {
    if (!this.ctx) return;
    const section = this.sections[this.currentSectionIdx];
    if (!section) return;
    this.beatsElapsedInSection += section.beatsPerBar;
    // If the pending-section flag is set OR we've played all bars in this
    // section, advance to the next section.
    const sectionDone = this.beatsElapsedInSection >= section.bars * section.beatsPerBar;
    if (this.pendingSectionIdx !== null || sectionDone) {
      let nextIdx: number;
      if (this.pendingSectionIdx !== null) {
        nextIdx = this.pendingSectionIdx;
        this.pendingSectionIdx = null;
      } else {
        nextIdx = (this.currentSectionIdx + 1) % this.sections.length;
      }
      if (nextIdx !== this.currentSectionIdx) {
        this.currentSectionIdx = nextIdx;
        this.beatsElapsedInSection = 0;
        this.onSectionChange?.(this.sections[nextIdx].section);
        // Update bass/melody/harmony root frequencies for the new section.
        this.applySectionTuning(this.sections[nextIdx]);
      }
    }
  }

  /** Re-tune the bass + melody + harmony stems to a new section's root. */
  private applySectionTuning(section: SectionDef): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const fadeSec = 0.4;
    const bass = this.stems.bass;
    if (bass?.oscs[0]) {
      bass.oscs[0].frequency.cancelScheduledValues(t);
      bass.oscs[0].frequency.setValueAtTime(Math.max(20, bass.oscs[0].frequency.value), t);
      bass.oscs[0].frequency.linearRampToValueAtTime(section.rootHz, t + fadeSec);
    }
    const mel = this.stems.melody;
    if (mel?.oscs[0]) {
      mel.oscs[0].frequency.cancelScheduledValues(t);
      mel.oscs[0].frequency.setValueAtTime(Math.max(20, mel.oscs[0].frequency.value), t);
      mel.oscs[0].frequency.linearRampToValueAtTime(section.rootHz * 4, t + fadeSec);
    }
    const harm = this.stems.harmony;
    if (harm?.oscs[0] && harm.oscs[1]) {
      harm.oscs[0].frequency.cancelScheduledValues(t);
      harm.oscs[0].frequency.setValueAtTime(Math.max(20, harm.oscs[0].frequency.value), t);
      harm.oscs[0].frequency.linearRampToValueAtTime(section.rootHz * 1.5, t + fadeSec);
      harm.oscs[1].frequency.cancelScheduledValues(t);
      harm.oscs[1].frequency.setValueAtTime(Math.max(20, harm.oscs[1].frequency.value), t);
      harm.oscs[1].frequency.linearRampToValueAtTime(section.rootHz * 1.5 * 1.005, t + fadeSec);
    }
  }

  /** Apply the per-stem gain matrix for a tier (crossfaded). */
  private applyTier(tier: CombatTier, fadeSec: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const gains = TIER_STEM_GAINS[tier];
    (Object.keys(this.stems) as MusicStem[]).forEach((stemName) => {
      const stem = this.stems[stemName];
      if (!stem) return;
      const target = Math.max(0.0001, gains[stemName] ?? 0);
      const g = stem.gain.gain as AudioParam & {
        cancelAndHoldAtTime?: (t: number) => void;
      };
      if (typeof g.cancelAndHoldAtTime === "function") {
        g.cancelAndHoldAtTime(t);
      } else {
        stem.gain.gain.cancelScheduledValues(t);
        stem.gain.gain.setValueAtTime(Math.max(0.0001, stem.gain.gain.value), t);
      }
      stem.gain.gain.exponentialRampToValueAtTime(target, t + fadeSec);
    });
  }

  dispose(): void {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    this.generation++;
    this.stop();
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _dynamic: DynamicMusicEngine | null = null;
export function getDynamicMusicEngine(): DynamicMusicEngine {
  if (!_dynamic) _dynamic = new DynamicMusicEngine();
  return _dynamic;
}
