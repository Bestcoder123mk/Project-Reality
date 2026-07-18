"use client";

/**
 * UISound — lightweight Web Audio system for UI hover/press/confirm sounds.
 *
 * Procedurally synthesized by default (zero asset files). SEC8 prompt 65
 * adds a sample-loading path: if /sfx/ui_{name}.wav is present, the cached
 * AudioBuffer plays; otherwise the synth blip plays. First call to an
 * unknown UI sound fires both the synth (immediate feedback) and an
 * async fetch (so subsequent calls use the real sample).
 *
 * The engine can attach to an external AudioContext + BusMixer (typically
 * provided by AudioEngine.init) so UI sounds route through the UI bus and
 * respect bus-level ducking. When no external ctx is attached, it lazily
 * creates its own (preserving the original standalone behaviour).
 *
 * ─── G-5000 prompt mapping ────────────────────────────────────────────────
 *   #3404 → G2 #115 — no onended disconnect (sample + synth paths)  [src.onended + osc.onended disconnect gain/out]
 *   #3433 → G2 #144 — ownCtx closed on attach, cutting in-flight sounds  [attach({ keepStandaloneAlive: true }) defers ownCtx.close() 1.5s]
 *   #3490–3504 → G #867–#881 — UI / progression sound events       [ProgressionSoundsG (SectionG.ts) is the canonical caller; this file provides the low-level playSound("press"/"hover"/...) synth + sample path it builds on]
 *   #3580–3594 → G #867–#881 — (cross-refs to #3490–3504)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BusMixer } from "./audio/buses";

export type SoundType =
  | "hover"
  | "press"
  | "confirm"
  | "back"
  | "toggle"
  | "error"
  | "success"
  | "tick";

/** Map of public name → SoundType (used by AudioEngine.playUi + external callers). */
export const UI_SOUND_NAMES: Record<string, SoundType> = {
  hover: "hover",
  press: "press",
  confirm: "confirm",
  back: "back",
  toggle: "toggle",
  error: "error",
  success: "success",
  tick: "tick",
};

class UISoundEngine {
  private ownCtx: AudioContext | null = null;
  /** External ctx (from AudioEngine) — preferred over ownCtx when set. */
  private extCtx: AudioContext | null = null;
  private extBus: GainNode | null = null;
  private ownMaster: GainNode | null = null;
  private enabled = true;
  private volume = 0.15; // quiet — UI sounds should be subtle
  /** G2 #144 — setTimeout token for the deferred ownCtx.close(). Cleared on
   *  explicit dispose() so a hot detach/reattach doesn't fire stale closes. */
  private ownCtxCloseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cached decoded sample buffers per SoundType. null = confirmed-missing. */
  private sampleCache = new Map<SoundType, AudioBuffer | null>();
  private sampleFetching = new Set<SoundType>();

  /**
   * Attach to an external AudioContext + UI bus (called from AudioEngine.init).
   *
   * G2 #144 — `opts.keepStandaloneAlive` (default false) preserves the
   * pre-existing standalone ownCtx for a short grace period so any UI sounds
   * already in flight on it (e.g. menu clicks played before the AudioEngine
   * was constructed) get to finish naturally. Without this, the immediate
   * `ownCtx.close()` truncates every in-flight UI sound the moment the game
   * boots. The ownCtx is closed from a 1.5s timer; new sounds route through
   * the external ctx immediately.
   */
  attach(ctx: AudioContext, buses: BusMixer, opts: { keepStandaloneAlive?: boolean } = {}): void {
    this.extCtx = ctx;
    this.extBus = buses.getBus("ui");
    // Tear down the standalone ctx if we had one. With keepStandaloneAlive,
    // defer the close so in-flight sounds can finish.
    if (this.ownCtx) {
      if (opts.keepStandaloneAlive) {
        const ctxToClose = this.ownCtx;
        if (this.ownCtxCloseTimer) clearTimeout(this.ownCtxCloseTimer);
        this.ownCtxCloseTimer = setTimeout(() => {
          try { ctxToClose.close(); } catch { /* noop */ }
          this.ownCtxCloseTimer = null;
        }, 1500);
      } else {
        try { this.ownCtx.close(); } catch { /* noop */ }
      }
      // Either way, the ownMaster is no longer the active output — drop the
      // reference so new calls route through the external ctx/bus.
      this.ownMaster = null;
      if (!opts.keepStandaloneAlive) this.ownCtx = null;
      else {
        // Keep ownCtx alive (timer above will close it). New sounds still go
        // through extCtx via the ctx()/out() pickers below.
      }
    }
  }

  /** Detach from external ctx (revert to standalone lazy-init). */
  detach(): void {
    this.extCtx = null;
    this.extBus = null;
  }

  /** Lazily init the standalone ctx (only used if not attached externally). */
  private ensureCtx(): void {
    if (this.extCtx || this.ownCtx) return;
    if (typeof window === "undefined") return;
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ownCtx = new Ctor();
      this.ownMaster = this.ownCtx.createGain();
      this.ownMaster.gain.value = this.volume;
      this.ownMaster.connect(this.ownCtx.destination);
    } catch {
      this.ownCtx = null;
    }
  }

  /** Get the active ctx (external preferred). */
  private ctx(): AudioContext | null {
    return this.extCtx ?? this.ownCtx;
  }

  /** Get the active output node (UI bus when attached, else own master). */
  private out(): AudioNode | null {
    return this.extBus ?? this.ownMaster;
  }

  /** Resume the audio context (call on first user interaction). */
  resume() {
    this.ensureCtx();
    void this.ctx()?.resume?.();
  }

  setEnabled(v: boolean) { this.enabled = v; }
  setVolume(v: number) {
    this.volume = v;
    if (this.ownMaster) this.ownMaster.gain.value = v;
    // External UI bus volume is managed by BusMixer.setBusVolume('ui', v).
  }

  /** Play a UI sound by SoundType (preferred entry point). */
  play(type: SoundType) {
    if (!this.enabled) return;
    this.ensureCtx();
    const ctx = this.ctx();
    const out = this.out();
    if (!ctx || !out) return;

    // 1. Cached real sample wins.
    const cached = this.sampleCache.get(type);
    if (cached) {
      const src = ctx.createBufferSource();
      src.buffer = cached;
      src.connect(out);
      src.start();
      // G2 #115 — disconnect on end so the buffer-source → out edge doesn't
      // leak per UI sound (every menu click would otherwise leak one node).
      src.onended = () => {
        try { src.disconnect(); } catch { /* noop */ }
      };
      return;
    }

    // 2. Synth fallback now.
    this.playSynth(type, ctx, out);

    // 3. Async-load real sample for next time (if any).
    if (!this.sampleFetching.has(type) && !this.sampleCache.has(type)) {
      void this.preloadSample(type);
    }
  }

  /** Public alias for the AudioEngine.playUi(name) entry point. */
  playByName(name: string): void {
    const type = UI_SOUND_NAMES[name] ?? "tick";
    this.play(type);
  }

  /** Pre-fetch /sfx/ui_{type}.wav into the cache (null = confirmed missing). */
  async preloadSample(type: SoundType): Promise<AudioBuffer | null> {
    if (typeof window === "undefined") return null;
    if (this.sampleCache.has(type)) return this.sampleCache.get(type) ?? null;
    if (this.sampleFetching.has(type)) return null;
    this.sampleFetching.add(type);
    try {
      const res = await fetch(`/sfx/ui_${type}.wav`, { method: "GET" });
      if (!res.ok) {
        this.sampleCache.set(type, null);
        return null;
      }
      const arrayBuf = await res.arrayBuffer();
      const ctx = this.ctx();
      if (!ctx) return null;
      const audioBuf = await this.decodeAudioData(ctx, arrayBuf);
      this.sampleCache.set(type, audioBuf);
      return audioBuf;
    } catch {
      this.sampleCache.set(type, null);
      return null;
    } finally {
      this.sampleFetching.delete(type);
    }
  }

  /** Decode helper — handles both modern promise + legacy callback signatures. */
  private decodeAudioData(ctx: AudioContext, arrayBuf: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise<AudioBuffer>((resolve, reject) => {
      try {
        const ret = ctx.decodeAudioData(arrayBuf) as unknown as
          | Promise<AudioBuffer>
          | undefined;
        if (ret && typeof ret.then === "function") {
          ret.then(resolve, reject);
        } else {
          ctx.decodeAudioData(
            arrayBuf,
            (buf: AudioBuffer) => resolve(buf),
            (err?: unknown) => reject(err ?? new Error("decodeAudioData failed")),
          );
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Synthesize the original procedural UI blips (the synth fallback). */
  private playSynth(type: SoundType, ctx: AudioContext, out: AudioNode) {
    const now = ctx.currentTime;
    switch (type) {
      case "hover":
        this.blip(ctx, out, 1200, 0.015, 0.04, now);
        break;
      case "press":
        this.blip(ctx, out, 440, 0.04, 0.08, now);
        this.blip(ctx, out, 220, 0.06, 0.06, now + 0.005);
        break;
      case "confirm":
        this.blip(ctx, out, 523, 0.08, 0.1, now);        // C5
        this.blip(ctx, out, 784, 0.12, 0.08, now + 0.06); // G5
        break;
      case "success":
        this.blip(ctx, out, 523, 0.1, 0.08, now);         // C5
        this.blip(ctx, out, 659, 0.1, 0.08, now + 0.08);  // E5
        this.blip(ctx, out, 784, 0.15, 0.1, now + 0.16);  // G5
        this.blip(ctx, out, 1047, 0.2, 0.12, now + 0.24); // C6
        break;
      case "back":
        this.blip(ctx, out, 440, 0.06, 0.08, now);
        this.blip(ctx, out, 330, 0.08, 0.06, now + 0.05);
        break;
      case "toggle":
        this.blip(ctx, out, 800, 0.03, 0.06, now);
        break;
      case "error":
        this.blip(ctx, out, 200, 0.15, 0.1, now, "sawtooth");
        break;
      case "tick":
        this.blip(ctx, out, 1000, 0.01, 0.03, now);
        break;
    }
  }

  /** Synthesize a single sine/saw blip with envelope. */
  private blip(
    ctx: AudioContext,
    out: AudioNode,
    freq: number,
    duration: number,
    gain: number,
    start: number,
    wave: OscillatorType = "sine",
  ) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.005); // 5ms attack
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration); // exponential decay
    osc.connect(env);
    env.connect(out);
    osc.start(start);
    osc.stop(start + duration + 0.01);
    // G2 #115 — was: no onended disconnect at all. Every UI blip leaked its
    // envelope gain node (multiple per click for press/confirm/success which
    // play 2–4 blips). Disconnect the env on end.
    osc.onended = () => {
      try { env.disconnect(); } catch { /* noop */ }
    };
  }

  dispose(): void {
    if (this.ownCtxCloseTimer) {
      clearTimeout(this.ownCtxCloseTimer);
      this.ownCtxCloseTimer = null;
    }
    if (this.ownCtx) {
      try { this.ownCtx.close(); } catch { /* noop */ }
    }
    this.ownCtx = null;
    this.ownMaster = null;
    this.extCtx = null;
    this.extBus = null;
    this.sampleCache.clear();
  }
}

/** Singleton instance — shared across all UI components. */
let _instance: UISoundEngine | null = null;
export function getUISound(): UISoundEngine {
  if (!_instance) _instance = new UISoundEngine();
  return _instance;
}

/** React hook for UI sound feedback. */
export function useUISound() {
  return {
    hover: () => getUISound().play("hover"),
    press: () => getUISound().play("press"),
    confirm: () => getUISound().play("confirm"),
    back: () => getUISound().play("back"),
    toggle: () => getUISound().play("toggle"),
    error: () => getUISound().play("error"),
    success: () => getUISound().play("success"),
    tick: () => getUISound().play("tick"),
    /** SEC8: play by arbitrary name (maps via UI_SOUND_NAMES; unknown → "tick"). */
    byName: (name: string) => getUISound().playByName(name),
  };
}
