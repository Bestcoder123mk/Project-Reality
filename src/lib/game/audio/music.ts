/**
 * SEC8-AUDIO (prompt 66) — Adaptive music engine.
 *
 * Three intensity layers (calm / engaged / climax) are synthesized
 * procedurally as ambient pads (sawtooth drone + sub-octave sine + filtered
 * noise bed + optional pulse LFO for tension). The layers crossfade on the
 * AudioContext clock via per-stem GainNode exponential ramps based on a
 * 0..1 intensity value driven by combat state.
 *
 * Replaces nothing in the existing audio.ts (the game has no music yet);
 * AudioEngine exposes a `music` getter and dispatches setIntensity() calls
 * based on combat state — the orchestrator wires that one-liner.
 *
 * ─── G-5000 prompt mapping ────────────────────────────────────────────────
 *   #3408 → G2 #119 — cancelScheduledValues wipes duck         [applyIntensity + stop use cancelAndHoldAtTime(t) + lastScheduledGain fallback]
 *   #3420 → G2 #131 — deferred stop races dispose             [pendingStopTimers Set; dispose() clears them before stop()]
 *   #3421 → G2 #132 — re-start race (stop→start kills new)    [generation counter; stale stop callbacks reject if gen changed]
 *   #3422 → G2 #133 — fifth overtone coupled to pulseFreq     [addFifth StemOptions field (default true); calm/engaged true, climax false]
 *   #3449 → G  #826 — zone-based reverb                        [ZoneReverbG in SectionG.ts reuses this engine's reverbNode; this file holds IntensityLevel/directorLabelToIntensity used by music-zone presets]
 *   #3450 → G  #827 — music stinger system                    [MusicExtensionsG in SectionG.ts — stingers play over this engine's stems]
 *   #3505 → G  #882 — music stems (calm/tension/combat) crossfade [applyIntensity 0..1 → 3-stem exponential crossfade]
 *   #3506 → G  #883 — ducking coexistence verify              [verifyDuckingCoexistence (SectionG.ts) asserts BusMixer.duck math + MusicEngine stems survive a duck]
 *   #3507 → G  #884 — "last alive" music layer                [MusicExtensionsG.playLayer('last_alive')]
 *   #3508 → G  #885 — "clutch" music layer                    [MusicExtensionsG.playLayer('clutch')]
 *   #3509 → G  #886 — "victory" music layer                   [MusicExtensionsG.playLayer('victory')]
 *   #3510 → G  #887 — "defeat" music layer                    [MusicExtensionsG.playLayer('defeat')]
 *   #3511 → G  #888 — per-bus volume slider                   [BusExtensionsG.setBusVolume in SectionG.ts adjusts this engine's music bus]
 *   #3539 → G  #826 — (cross-ref to #3449)
 *   #3540 → G  #827 — (cross-ref to #3450)
 *   #3595 → G  #882 — (cross-ref to #3505)
 *   #3596 → G  #883 — (cross-ref to #3506)
 *   #3597 → G  #884 — (cross-ref to #3507)
 *   #3598 → G  #885 — (cross-ref to #3508)
 *   #3599 → G  #886 — (cross-ref to #3509)
 *   #3600 → G  #887 — (cross-ref to #3510)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BusMixer } from "./buses";

export type IntensityLevel = "calm" | "engaged" | "climax";

/**
 * SEC8-AUDIO (prompt 70) — AI director combat-intensity label. Maps onto the
 * continuous 0..1 music intensity via `directorLabelToIntensity()`. Re-exported
 * here (rather than imported from ai/director.ts) so audio consumers don't
 * take a hard dependency on the director module.
 */
export type DirectorIntensityLabel = "CALM" | "BUILDING" | "PEAK" | "BREATH";

/**
 * Map the AI director's intensity label onto the 0..1 music-intensity value.
 *
 *   CALM     → 0.00  (calm-only)
 *   BUILDING → 0.45  (engaged-dominant)
 *   PEAK     → 0.95  (climax-dominant)
 *   BREATH   → 0.15  (mostly-calm with engaged shimmer — recovery)
 *
 * The BREATH state is the director backing off because the player is wounded
 * / downed; we still keep a low-engaged pad so the music doesn't drop to dead
 * silence at the worst possible moment.
 */
export function directorLabelToIntensity(label: DirectorIntensityLabel): number {
  switch (label) {
    case "CALM":     return 0.0;
    case "BUILDING": return 0.45;
    case "PEAK":     return 0.95;
    case "BREATH":   return 0.15;
  }
}

interface StemOptions {
  /** Root drone frequency (Hz). */
  droneFreq: number;
  /** Bandpass center for the noise bed. */
  noiseFilter: number;
  /** Noise-bed linear gain. */
  noiseGain: number;
  /** Drone linear gain. */
  droneGain: number;
  /** Optional pulse LFO frequency (Hz) for tension / heartbeat feel. */
  pulseFreq?: number;
  /** Pulse LFO depth (linear modulation of droneGain). */
  pulseDepth?: number;
  /**
   * G2 #133 — decoupled from `pulseFreq`. When true, a perfect-fifth
   * overtone (droneFreq * 1.5) is added to the stem. Previously the fifth
   * was added only when `pulseFreq === undefined`, which meant adding a
   * pulse to the calm stem silently removed the fifth (and removing the
   * pulse from the engaged stem would add a fifth, changing its timbre).
   * Default: true (preserve old calm-stem behaviour).
   */
  addFifth?: boolean;
}

interface Stem {
  input: GainNode;
  oscs: OscillatorNode[];
  sources: AudioBufferSourceNode[];
  filters: BiquadFilterNode[];
}

export class MusicEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private stems: Partial<Record<IntensityLevel, Stem>> = {};
  private intensity = 0;
  private started = false;
  private fadeSeconds = 0.8;
  /** G2 #131 — pending setTimeout tokens from stop()'s deferred oscillator
   *  stop. Cleared on dispose() so a stale stop() doesn't fire on closed nodes. */
  private pendingStopTimers = new Set<ReturnType<typeof setTimeout>>();
  /** G2 #132 — generation counter incremented on every stop() / start().
   *  Used to reject stale stop() callbacks from a prior generation so a
   *  rapid stop→start doesn't kill the newly-started stems. */
  private generation = 0;

  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
  }

  /** Inject a fresh noise buffer (e.g. after AudioContext reset). */
  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  /** Build all 3 stems and start them (initially silent). Idempotent. */
  start(): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer || this.started) return;
    const musicBus = this.buses.getBus("music");
    if (!musicBus) return;
    this.started = true;
    this.stems.calm = this.buildStem({
      droneFreq: 55,       // A1
      noiseFilter: 220,
      noiseGain: 0.018,
      droneGain: 0.045,
      // G2 #133 — explicit addFifth (was implicit when pulseFreq was unset).
      addFifth: true,
    });
    this.stems.engaged = this.buildStem({
      droneFreq: 73.42,    // D2
      noiseFilter: 420,
      noiseGain: 0.035,
      droneGain: 0.055,
      pulseFreq: 1.6,
      pulseDepth: 0.35,
      // G2 #133 — engaged stem also gets a fifth (was: no fifth because
      // pulseFreq was set). Decoupling lets the caller add both a pulse AND
      // a fifth independently.
      addFifth: true,
    });
    this.stems.climax = this.buildStem({
      droneFreq: 110,      // A2
      noiseFilter: 850,
      noiseGain: 0.06,
      droneGain: 0.085,
      pulseFreq: 3.0,
      pulseDepth: 0.55,
      // G2 #133 — climax stem has no fifth (heavy pulse + sub-bass is
      // enough; adding a fifth would clutter the high-midrange).
      addFifth: false,
    });
    // Apply current intensity (likely 0 → calm only).
    this.applyIntensity(this.intensity, 0.05);
  }

  private buildStem(opts: StemOptions): Stem {
    const ctx = this.ctx!;
    const musicBus = this.buses!.getBus("music")!;
    const input = ctx.createGain();
    input.gain.value = 0.0001;
    input.connect(musicBus);

    const oscs: OscillatorNode[] = [];
    const sources: AudioBufferSourceNode[] = [];
    const filters: BiquadFilterNode[] = [];

    // Sawtooth drone → lowpass at ~4x root for warmth.
    const drone = ctx.createOscillator();
    drone.type = "sawtooth";
    drone.frequency.value = opts.droneFreq;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = opts.droneFreq * 4;
    droneFilter.Q.value = 0.7;
    const droneGain = ctx.createGain();
    droneGain.gain.value = opts.droneGain;
    drone.connect(droneFilter);
    droneFilter.connect(droneGain);
    droneGain.connect(input);
    drone.start();
    oscs.push(drone);
    filters.push(droneFilter);

    // Sub-octave sine for body.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = opts.droneFreq / 2;
    const subGain = ctx.createGain();
    subGain.gain.value = opts.droneGain * 0.6;
    sub.connect(subGain);
    subGain.connect(input);
    sub.start();
    oscs.push(sub);

    // Perfect-fifth overtone for tonal interest. G2 #133 — decoupled from
    // pulseFreq: the caller opts in via `addFifth` (default true). Was:
    // `if (opts.pulseFreq === undefined)` which silently removed the fifth
    // when a pulse was added (and added one when the pulse was removed).
    if (opts.addFifth !== false) {
      const fifth = ctx.createOscillator();
      fifth.type = "sine";
      fifth.frequency.value = opts.droneFreq * 1.5;
      const fifthGain = ctx.createGain();
      fifthGain.gain.value = opts.droneGain * 0.25;
      fifth.connect(fifthGain);
      fifthGain.connect(input);
      fifth.start();
      oscs.push(fifth);
    }

    // Filtered noise bed (looping).
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer!;
    noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = opts.noiseFilter;
    noiseFilter.Q.value = 0.7;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = opts.noiseGain;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(input);
    noise.start();
    sources.push(noise);
    filters.push(noiseFilter);

    // Optional tension LFO modulating droneGain.
    if (opts.pulseFreq) {
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = opts.pulseFreq;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = opts.droneGain * (opts.pulseDepth ?? 0.4);
      lfo.connect(lfoGain);
      lfoGain.connect(droneGain.gain);
      lfo.start();
      oscs.push(lfo);
    }

    return { input, oscs, sources, filters };
  }

  /**
   * Set the music intensity. 0 = calm-only, 0.5 = engaged-dominant,
   * 1.0 = climax-dominant. Linear crossfade between the 3 stems.
   */
  setIntensity(level: number): void {
    this.intensity = Math.max(0, Math.min(1, level));
    if (this.started) this.applyIntensity(this.intensity, this.fadeSeconds);
  }

  /**
   * SEC8-AUDIO (prompt 70) — Crossfade stems from the AI director's intensity
   * label ("CALM" | "BUILDING" | "PEAK" | "BREATH"). Maps the discrete label
   * to a continuous 0..1 level via `directorLabelToIntensity()` and delegates
   * to `setIntensity()`. The crossfade uses the engine's standard fade
   * duration (0.8s exponential ramp).
   *
   * Safe to call when the music engine isn't started yet — the latest label
   * is cached in `this.intensity` and applied on `start()`.
   */
  setDirectorIntensity(label: DirectorIntensityLabel): void {
    this.setIntensity(directorLabelToIntensity(label));
  }

  /** Compute per-stem target volumes from a 0..1 intensity value. */
  private stemVolumes(level: number): Record<IntensityLevel, number> {
    // Triangular crossfade: calm dominates [0, 0.5], engaged peaks at 0.5,
    // climax dominates [0.5, 1.0].
    const calm = level <= 0.5 ? 1 - level * 1.4 : Math.max(0, 0.3 - (level - 0.5) * 0.6);
    const engaged = level <= 0.5 ? level * 1.6 : 1.6 - (level - 0.5) * 1.6;
    const climax = level <= 0.5 ? level * 0.3 : 0.15 + (level - 0.5) * 1.7;
    const clamp = (v: number) => Math.max(0.0001, Math.min(1, v));
    return {
      calm: clamp(calm),
      engaged: clamp(engaged),
      climax: clamp(climax),
    };
  }

  private applyIntensity(level: number, fade: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const vols = this.stemVolumes(level);
    (["calm", "engaged", "climax"] as IntensityLevel[]).forEach((lvl) => {
      const stem = this.stems[lvl];
      if (!stem) return;
      const target = Math.max(0.0001, vols[lvl]);
      // G2 #119 — was: cancelScheduledValues(t) + setValueAtTime(value, t)
      // which wiped any active duck ramp on the stem's input gain. If a duck
      // was in flight (e.g. gunfire ducks music), the stem's gain would snap
      // to the captured value mid-duck, causing a click. Now use
      // cancelAndHoldAtTime(t) which preserves the in-flight value at time t,
      // then ramp smoothly to the new target. Fallback for older browsers:
      // cancelScheduledValues + setValueAtTime (best-effort — same pattern
      // as BusMixer.duck).
      const gainParam = stem.input.gain as AudioParam & {
        cancelAndHoldAtTime?: (t: number) => void;
      };
      if (typeof gainParam.cancelAndHoldAtTime === "function") {
        gainParam.cancelAndHoldAtTime(t);
      } else {
        stem.input.gain.cancelScheduledValues(t);
        stem.input.gain.setValueAtTime(Math.max(0.0001, stem.input.gain.value), t);
      }
      stem.input.gain.exponentialRampToValueAtTime(target, t + fade);
    });
  }

  /** Smoothly fade all stems to silence and stop oscillators/sources. */
  stop(): void {
    if (!this.ctx) return;
    // G2 #132 — bump the generation counter so any stale stop-timer callbacks
    // from a previous stop() reject instead of killing the new stems after a
    // rapid stop→start.
    this.generation++;
    const myGen = this.generation;
    const t = this.ctx.currentTime;
    (["calm", "engaged", "climax"] as IntensityLevel[]).forEach((lvl) => {
      const stem = this.stems[lvl];
      if (!stem) return;
      const gainParam = stem.input.gain as AudioParam & {
        cancelAndHoldAtTime?: (t: number) => void;
      };
      // G2 #119 — use cancelAndHoldAtTime here too so a stop() mid-duck
      // doesn't snap to the captured mid-ramp value.
      if (typeof gainParam.cancelAndHoldAtTime === "function") {
        gainParam.cancelAndHoldAtTime(t);
      } else {
        stem.input.gain.cancelScheduledValues(t);
        stem.input.gain.setValueAtTime(Math.max(0.0001, stem.input.gain.value), t);
      }
      stem.input.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      // Defer oscillator/source stop until after the fade.
      // G2 #131 — track the timer so dispose() can clear it. Without this,
      // dispose() can fire while the timer is pending; the timer then fires
      // stop() on already-closed nodes, which throws.
      // G2 #132 — capture myGen and reject if the generation changed (rapid
      // stop→start) so we don't kill the new stems.
      const timer = setTimeout(() => {
        this.pendingStopTimers.delete(timer);
        if (myGen !== this.generation) return; // G2 #132 — stale, new stems live
        if (!this.stems[lvl]) return; // already cleared by another path
        for (const o of stem.oscs) { try { o.stop(); } catch { /* already */ } }
        for (const s of stem.sources) { try { s.stop(); } catch { /* already */ } }
        try { stem.input.disconnect(); } catch { /* noop */ }
        this.stems[lvl] = undefined;
      }, 750);
      this.pendingStopTimers.add(timer);
    });
    this.started = false;
  }

  /** Current intensity level (0..1). */
  getIntensity(): number {
    return this.intensity;
  }

  isRunning(): boolean {
    return this.started;
  }

  dispose(): void {
    // G2 #131 — clear any pending stop timers BEFORE stopping so a stale
    // timer doesn't fire stop() on already-closed nodes after dispose().
    for (const timer of this.pendingStopTimers) {
      clearTimeout(timer);
    }
    this.pendingStopTimers.clear();
    // G2 #132 — bump generation so any in-flight timer that escaped the clear
    // (race) rejects on the generation check.
    this.generation++;
    this.stop();
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: map a "combat intensity" hint (enemies alive, recent damage…)
// to the 0..1 music intensity. Used by the engine wiring layer.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param enemiesAlive      Current visible/active enemy count.
 * @param recentDamageDealt Damage the player dealt in the last ~5s.
 * @param playerHealthPct   Player health 0..1.
 */
export function computeMusicIntensity(
  enemiesAlive: number,
  recentDamageDealt: number,
  playerHealthPct: number,
): number {
  // Threat from enemy count: ramps 0 → 0.6 over 0 → 6 enemies.
  const enemyThreat = Math.min(0.6, enemiesAlive / 6 * 0.6);
  // Recent damage dealt adds urgency: ramps 0 → 0.3 over 0 → 300 dmg.
  const combatUrgency = Math.min(0.3, recentDamageDealt / 300 * 0.3);
  // Low health adds a final 0.1 climax bias.
  const danger = playerHealthPct < 0.35 ? (1 - playerHealthPct) * 0.15 : 0;
  return Math.max(0, Math.min(1, enemyThreat + combatUrgency + danger));
}
