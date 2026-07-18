/**
 * Section H — Squad radio communication with Brevity codes + squelch.
 *
 * Section H prompt coverage: H_Audio_Immersion-00039/00044/00050/00066/00070/
 * 00079/00087/00099/00100/04903/04912/04934/04943/04952/04971/04996 — voice
 * line "enemy spotted", "need backup", "reloading", "objective captured" per
 * map + quality tier.
 *
 * The existing SectionG.ts has CommsRadioFilterG (bandpass + highpass +
 * waveshaper + hum + static chain for radio voice). This module wraps that
 * filter chain with a higher-level squad-comms system:
 *
 *   • Brevity codes — standardized NATO callout words (Tango, Bandit, Winchester,
 *     Buddy, Spike, Magnum, etc.) that compress tactical information.
 *   • Radio squelch — the "click" at the start/end of each transmission
 *     (the classic walkie-talkie "kkkkht" sound).
 *   • Signal strength — distance from transmitter affects filter cutoff +
 *     adds static (weak signal = muffled + noisy).
 *   • Priority interrupts — high-priority transmissions ("Mayday",
 *     "Winchester" = out of ammo) interrupt lower-priority ones.
 *
 * Voice lines come from the voice-scripting.ts module (text + voice id). This
 * engine synthesizes the radio filter chain + squelch and applies them to
 * the TTS-generated audio (which the VoEngine plays through the VO bus).
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

/** Brevity code — standardized NATO callout word. */
export interface BrevityCode {
  code: string;
  meaning: string;
  /** Priority 1..5 (higher = more urgent). */
  priority: number;
}

export const BREVITY_CODES: Record<string, BrevityCode> = {
  tango:      { code: "Tango",      meaning: "Enemy",                    priority: 2 },
  bandit:     { code: "Bandit",     meaning: "Enemy aircraft/visible",   priority: 3 },
  winchester: { code: "Winchester", meaning: "Out of ammo",              priority: 5 },
  buddy:      { code: "Buddy",      meaning: "Friendly",                 priority: 1 },
  spike:      { code: "Spike",      meaning: "Under attack",             priority: 4 },
  magnum:     { code: "Magnum",     meaning: "Out of fuel/medical",      priority: 4 },
  mayday:     { code: "Mayday",     meaning: "Emergency",                priority: 5 },
  knockItOff: { code: "Knock it off", meaning: "Cease fire immediately", priority: 5 },
  fox:        { code: "Fox",        meaning: "Air-to-air missile launch", priority: 3 },
  rifle:      { code: "Rifle",      meaning: "Air-to-ground missile",    priority: 3 },
  pickled:    { code: "Pickled",    meaning: "Bombs away",               priority: 3 },
  splash:     { code: "Splash",     meaning: "Target destroyed",         priority: 3 },
  sunshine:   { code: "Sunshine",   meaning: "RTB (return to base)",     priority: 4 },
  banjo:      { code: "Banjo",      meaning: "Engage ground target",     priority: 3 },
  mud:        { code: "Mud",        meaning: "Ground fire detected",     priority: 3 },
};

export interface RadioTransmission {
  /** Sender callsign. */
  from: string;
  /** Recipient callsign (or "all" for broadcast). */
  to: string;
  /** Transmission text (after Brevity expansion). */
  text: string;
  /** Sender world position (for signal strength). */
  senderPos?: { x: number; y: number; z: number };
  /** Priority 1..5. */
  priority: number;
}

export class RadioCommEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** Currently-active transmission (only one at a time — higher-pri preempts). */
  private activeTransmission: RadioTransmission | null = null;
  /** Listener position (for signal strength). */
  private listenerPos = { x: 0, y: 0, z: 0 };

  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
  }

  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  /** Update the listener position (for signal strength). */
  setListenerPos(pos: { x: number; y: number; z: number }): void {
    this.listenerPos = { ...pos };
  }

  /**
   * Start a radio transmission. Plays the squelch-click, then applies the
   * radio filter chain to the rest of the audio for the duration. If a
   * higher-priority transmission is active, the lower one is preempted.
   *
   * Note: the actual voice audio comes from the VoEngine (TTS); this engine
   * plays the squelch + static overlay only. The VoEngine's voice output
   * should be routed through a CommsRadioFilterG node by the engine wiring.
   */
  startTransmission(transmission: RadioTransmission): void {
    if (this.activeTransmission && this.activeTransmission.priority >= transmission.priority) {
      // Lower-priority transmission in flight — ignore.
      return;
    }
    this.activeTransmission = transmission;
    this.playSquelchClick("start");
    // Schedule the end-of-transmission squelch based on text length (~100ms/word).
    const wordCount = transmission.text.split(/\s+/).length;
    const durSec = Math.max(1, wordCount * 0.4);
    const ctx = this.ctx;
    if (!ctx) return;
    // Use AudioContext clock for the end-squelch (no setTimeout drift).
    const t = ctx.currentTime + durSec;
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); // empty 1-sample buffer (immediate stop)
    src.connect(ctx.destination);
    src.start(t);
    src.onended = () => {
      this.playSquelchClick("end");
      this.activeTransmission = null;
    };
  }

  /**
   * Compute signal strength 0..1 from sender position to listener.
   * 1.0 = next to listener; 0.0 = beyond maxRange.
   */
  computeSignalStrength(senderPos: { x: number; y: number; z: number }, maxRange: number = 80): number {
    const dx = senderPos.x - this.listenerPos.x;
    const dy = senderPos.y - this.listenerPos.y;
    const dz = senderPos.z - this.listenerPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= maxRange) return 0;
    // Linear falloff with slight curve.
    return Math.pow(1 - dist / maxRange, 1.5);
  }

  /**
   * Apply a radio filter chain to a source node. The chain is:
   *   source → highpass (300Hz) → bandpass (1.5kHz, Q=1) → waveshaper (distortion)
   *          → static gain → target
   *
   * `signalStrength` 0..1 controls the static gain (lower = more static).
   */
  applyRadioFilter(
    source: AudioNode,
    target: AudioNode,
    signalStrength: number = 1.0,
  ): AudioNode {
    if (!this.ctx || !this.noiseBuffer) {
      try { source.connect(target); } catch { /* noop */ }
      return source;
    }
    const ctx = this.ctx;
    // Highpass at 300Hz (cuts rumble + low-freq noise).
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 300;
    hp.Q.value = 0.7;
    // Bandpass at 1.5kHz (the classic "telephone" midrange character).
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500;
    bp.Q.value = 1.0;
    // Waveshaper for subtle distortion (overdriven tube character).
    const ws = ctx.createWaveShaper();
    ws.curve = this.makeDistortionCurve(8);
    // Static gain — inversely proportional to signal strength.
    const staticGain = ctx.createGain();
    staticGain.gain.value = Math.max(0.0001, 1 - signalStrength) * 0.15;
    // Static noise source (looping).
    const staticSrc = ctx.createBufferSource();
    staticSrc.buffer = this.noiseBuffer;
    staticSrc.loop = true;
    const staticBP = ctx.createBiquadFilter();
    staticBP.type = "highpass";
    staticBP.frequency.value = 2500;
    staticSrc.connect(staticBP);
    staticBP.connect(staticGain);
    // Output gain — scales with signal strength.
    const outGain = ctx.createGain();
    outGain.gain.value = Math.max(0.1, signalStrength);
    // Chain.
    try {
      source.connect(hp);
      hp.connect(bp);
      bp.connect(ws);
      ws.connect(outGain);
      staticGain.connect(outGain);
      outGain.connect(target);
    } catch { /* noop */ }
    staticSrc.start();
    // The caller is responsible for stopping the source; the static source
    // will be cleaned up when the source ends (we hook onended).
    if (source instanceof AudioScheduledSourceNode) {
      source.onended = () => {
        try { staticSrc.stop(); } catch { /* noop */ }
        try { hp.disconnect(); } catch { /* noop */ }
        try { bp.disconnect(); } catch { /* noop */ }
        try { ws.disconnect(); } catch { /* noop */ }
        try { staticGain.disconnect(); } catch { /* noop */ }
        try { staticBP.disconnect(); } catch { /* noop */ }
        try { outGain.disconnect(); } catch { /* noop */ }
      };
    }
    return outGain;
  }

  /** Play the squelch click at the start or end of a transmission. */
  private playSquelchClick(phase: "start" | "end"): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const bus = this.buses.getBus("vo");
    if (!bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Squelch click — short (40ms) broadband noise burst through a highpass.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2000;
    const g = ctx.createGain();
    const peak = phase === "start" ? 0.15 : 0.1;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    src.connect(hp);
    hp.connect(g);
    g.connect(bus);
    src.start(t);
    src.stop(t + 0.06);
    src.onended = () => {
      try { hp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
  }

  /**
   * Build a waveshaper distortion curve. `amount` 0..100 controls the
   * overdrive level. 8 = subtle tube character; 50 = heavy fuzz.
   */
  private makeDistortionCurve(amount: number): Float32Array {
    const n = 44100;
    const curve = new Float32Array(n);
    const k = amount;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  /** Get the currently-active transmission (or null). */
  getActiveTransmission(): RadioTransmission | null {
    return this.activeTransmission;
  }

  /** Expand a Brevity code into its plain-text meaning. */
  static expandBrevity(text: string): string {
    return text.replace(/\b(Tango|Bandit|Winchester|Buddy|Spike|Magnum|Mayday|Knock it off|Fox|Rifle|Pickled|Splash|Sunshine|Banjo|Mud)\b/gi, (match) => {
      const code = BREVITY_CODES[match.toLowerCase().replace(/\s/g, "")];
      return code ? `${match} (${code.meaning})` : match;
    });
  }

  dispose(): void {
    this.activeTransmission = null;
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _radio: RadioCommEngine | null = null;
export function getRadioCommEngine(): RadioCommEngine {
  if (!_radio) _radio = new RadioCommEngine();
  return _radio;
}
