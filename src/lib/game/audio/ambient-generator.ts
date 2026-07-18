/**
 * Section H — Procedural ambient scene generation.
 *
 * Section H prompt coverage: H_Audio_Immersion-00012/00014/00019/00021/00037/
 * 00040/00042/00043/00046/00067/04911/04913/04917/04918/04931/04936/04948/
 * 04972/04994 — ambient wind/rain/thunder/bird call/city traffic per map.
 *
 * The existing SectionG.ts has RainAmbientG / WindAmbientG / FireAmbientG —
 * single-layer looping noise beds with LFO modulation. This module extends
 * that with a **scene generator** that places multiple ambient sources in a
 * virtual sphere around the listener, each with its own position + emission
 * pattern. Sources include:
 *
 *   • Birds — stochastic chirps placed in trees (forest maps).
 *   • Insects — looping high-freq drone (night maps).
 *   • Distant traffic — low rumble + occasional horn (urban maps).
 *   • Distant gunfire — random cracks at 100-300m range.
 *   • Wind gusts — periodic gusts that sweep through the stereo field.
 *   • Ocean waves — looping wave pattern with period 8-12s.
 *   • City hum — broad-spectrum low-level noise.
 *
 * Each source has a position (fixed in world space) + emission pattern
 * (periodic, stochastic, looping). The engine tracks active sources and
 * schedules the next emission for each. All audio is procedural.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

export type AmbientSourceH =
  | "bird"
  | "insect"
  | "distant_traffic"
  | "distant_gunfire"
  | "wind_gust"
  | "ocean_wave"
  | "city_hum"
  | "rain_patter"
  | "forest_rustle"
  | "industrial_hum";

export interface AmbientSourceDef {
  type: AmbientSourceH;
  /** World position (fixed). */
  pos: { x: number; y: number; z: number };
  /** Emission pattern: "looping" (continuous) or "periodic" or "stochastic". */
  pattern: "looping" | "periodic" | "stochastic";
  /** For periodic: interval between emissions (s). */
  intervalSec?: number;
  /** For stochastic: average emissions per minute. */
  ratePerMin?: number;
  /** Gain 0..1. */
  gain: number;
  /** Max audible distance (m). */
  maxDistance: number;
}

export interface AmbientSceneDef {
  /** Scene name (e.g. "forest", "urban_night", "desert_dawn"). */
  name: string;
  sources: AmbientSourceDef[];
}

/** Built-in scene presets per map archetype. */
export const AMBIENT_SCENES: Record<string, AmbientSceneDef> = {
  forest: {
    name: "forest",
    sources: [
      // 4 birds at random positions around the listener (10-30m).
      { type: "bird", pos: { x: 12, y: 4, z: 8 },   pattern: "stochastic", ratePerMin: 12, gain: 0.3, maxDistance: 60 },
      { type: "bird", pos: { x: -15, y: 5, z: 12 }, pattern: "stochastic", ratePerMin: 8,  gain: 0.25, maxDistance: 60 },
      { type: "bird", pos: { x: 20, y: 6, z: -18 }, pattern: "stochastic", ratePerMin: 10, gain: 0.2,  maxDistance: 60 },
      { type: "forest_rustle", pos: { x: 0, y: 0, z: 0 }, pattern: "looping", gain: 0.12, maxDistance: 100 },
      { type: "wind_gust", pos: { x: 0, y: 8, z: 0 }, pattern: "periodic", intervalSec: 12, gain: 0.18, maxDistance: 100 },
    ],
  },
  urban_night: {
    name: "urban_night",
    sources: [
      { type: "city_hum",       pos: { x: 0, y: 0, z: 0 }, pattern: "looping", gain: 0.18, maxDistance: 200 },
      { type: "distant_traffic", pos: { x: 30, y: 0, z: 0 }, pattern: "looping", gain: 0.15, maxDistance: 200 },
      { type: "distant_gunfire", pos: { x: 80, y: 2, z: -40 }, pattern: "stochastic", ratePerMin: 4, gain: 0.2, maxDistance: 300 },
      { type: "insect",         pos: { x: 5, y: 1, z: 5 }, pattern: "looping", gain: 0.08, maxDistance: 30 },
    ],
  },
  desert_dawn: {
    name: "desert_dawn",
    sources: [
      { type: "wind_gust", pos: { x: 0, y: 10, z: 0 }, pattern: "periodic", intervalSec: 8, gain: 0.25, maxDistance: 150 },
      { type: "distant_gunfire", pos: { x: -100, y: 0, z: 80 }, pattern: "stochastic", ratePerMin: 2, gain: 0.18, maxDistance: 300 },
      { type: "bird", pos: { x: 25, y: 5, z: 25 }, pattern: "stochastic", ratePerMin: 4, gain: 0.15, maxDistance: 60 },
    ],
  },
  coastal: {
    name: "coastal",
    sources: [
      { type: "ocean_wave", pos: { x: 0, y: 0, z: 30 }, pattern: "periodic", intervalSec: 10, gain: 0.35, maxDistance: 200 },
      { type: "wind_gust",  pos: { x: 0, y: 8, z: 0 }, pattern: "periodic", intervalSec: 6, gain: 0.18, maxDistance: 150 },
      { type: "bird",       pos: { x: 15, y: 6, z: -10 }, pattern: "stochastic", ratePerMin: 6, gain: 0.2, maxDistance: 60 },
    ],
  },
  industrial: {
    name: "industrial",
    sources: [
      { type: "industrial_hum", pos: { x: 0, y: 0, z: 0 }, pattern: "looping", gain: 0.3, maxDistance: 100 },
      { type: "distant_gunfire", pos: { x: 50, y: 2, z: 50 }, pattern: "stochastic", ratePerMin: 6, gain: 0.18, maxDistance: 300 },
      { type: "wind_gust", pos: { x: 0, y: 8, z: 0 }, pattern: "periodic", intervalSec: 15, gain: 0.1, maxDistance: 100 },
    ],
  },
};

interface ActiveSource {
  def: AmbientSourceDef;
  /** For looping sources: the active buffer source + gain nodes. */
  loop?: {
    src: AudioBufferSourceNode;
    gain: GainNode;
    panner: PannerNode;
  };
  /** For periodic/stochastic: the next scheduled emission time (ms). */
  nextEmissionMs: number;
}

export class AmbientGeneratorEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private activeSources: ActiveSource[] = [];
  private currentScene: AmbientSceneDef | null = null;
  private generation = 0;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private listenerPos = { x: 0, y: 0, z: 0 };

  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
  }

  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  /** Update the listener position (for spatial ambient sources). */
  setListenerPos(pos: { x: number; y: number; z: number }): void {
    this.listenerPos = { ...pos };
  }

  /** Load a built-in scene by name. */
  loadScene(name: keyof typeof AMBIENT_SCENES): void {
    const scene = AMBIENT_SCENES[name];
    if (scene) this.setScene(scene);
  }

  /** Set a custom scene. */
  setScene(scene: AmbientSceneDef): void {
    this.stopScene();
    this.currentScene = scene;
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    for (const def of scene.sources) {
      const source: ActiveSource = {
        def,
        nextEmissionMs: typeof performance !== "undefined" ? performance.now() : Date.now(),
      };
      if (def.pattern === "looping") {
        this.startLoopingSource(source);
      }
      this.activeSources.push(source);
    }
    this.scheduleNextEmissions();
  }

  /** Stop the current scene + clean up. */
  stopScene(): void {
    this.generation++;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    for (const source of this.activeSources) {
      if (source.loop) {
        try { source.loop.src.stop(); } catch { /* noop */ }
        try { source.loop.gain.disconnect(); } catch { /* noop */ }
        try { source.loop.panner.disconnect(); } catch { /* noop */ }
      }
    }
    this.activeSources = [];
    this.currentScene = null;
  }

  /** Get the current scene name (or null). */
  getCurrentScene(): string | null {
    return this.currentScene?.name ?? null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private startLoopingSource(source: ActiveSource): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    // Filter per source type.
    const filter = this.makeSourceFilter(ctx, source.def.type);
    const g = ctx.createGain();
    g.gain.value = source.def.gain;
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 5;
    panner.maxDistance = source.def.maxDistance;
    panner.rolloffFactor = 0.8;
    const t = ctx.currentTime;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(source.def.pos.x, t);
      panner.positionY.setValueAtTime(source.def.pos.y, t);
      panner.positionZ.setValueAtTime(source.def.pos.z, t);
    } else {
      (panner as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(source.def.pos.x, source.def.pos.y, source.def.pos.z);
    }
    src.connect(filter);
    filter.connect(g);
    g.connect(panner);
    panner.connect(bus);
    src.start();
    source.loop = { src, gain: g, panner };
  }

  private makeSourceFilter(ctx: AudioContext, type: AmbientSourceH): BiquadFilterNode {
    const f = ctx.createBiquadFilter();
    switch (type) {
      case "city_hum":
        f.type = "lowshelf";
        f.frequency.value = 200;
        f.gain.value = 6;
        break;
      case "industrial_hum":
        f.type = "bandpass";
        f.frequency.value = 120;
        f.Q.value = 1.5;
        break;
      case "forest_rustle":
        f.type = "bandpass";
        f.frequency.value = 3500;
        f.Q.value = 0.5;
        break;
      case "insect":
        f.type = "bandpass";
        f.frequency.value = 6000;
        f.Q.value = 4.0;
        break;
      case "distant_traffic":
        f.type = "lowpass";
        f.frequency.value = 400;
        break;
      case "rain_patter":
        f.type = "highpass";
        f.frequency.value = 2500;
        break;
      default:
        f.type = "lowpass";
        f.frequency.value = 1500;
        break;
    }
    return f;
  }

  private scheduleNextEmissions(): void {
    if (!this.ctx) return;
    const myGen = this.generation;
    const checkIntervalMs = 200;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (myGen !== this.generation) return;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      for (const source of this.activeSources) {
        if (source.def.pattern === "looping") continue;
        if (now >= source.nextEmissionMs) {
          this.emitOneShot(source);
          // Schedule next emission.
          let nextDelayMs: number;
          if (source.def.pattern === "periodic") {
            nextDelayMs = (source.def.intervalSec ?? 10) * 1000;
          } else {
            // Stochastic — exponential distribution from ratePerMin.
            const ratePerSec = (source.def.ratePerMin ?? 6) / 60;
            nextDelayMs = (-Math.log(Math.max(0.001, Math.random())) / ratePerSec) * 1000;
          }
          source.nextEmissionMs = now + nextDelayMs;
        }
      }
      this.scheduleNextEmissions();
    }, checkIntervalMs);
    this.pendingTimers.add(timer);
  }

  private emitOneShot(source: ActiveSource): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const t = ctx.currentTime;
    switch (source.def.type) {
      case "bird":
        this.emitBirdChirp(ctx, bus, source.def, t);
        break;
      case "distant_gunfire":
        this.emitDistantGunfire(ctx, bus, source.def, t);
        break;
      case "wind_gust":
        this.emitWindGust(ctx, bus, source.def, t);
        break;
      case "ocean_wave":
        this.emitOceanWave(ctx, bus, source.def, t);
        break;
      default:
        // Other one-shot types are no-ops (their looping variants carry them).
        break;
    }
  }

  private emitBirdChirp(ctx: AudioContext, bus: AudioNode, def: AmbientSourceDef, t: number): void {
    // Bird chirp — 3 quick frequency-modulated sine pulses.
    const baseFreq = 2000 + Math.random() * 2000;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      const startF = baseFreq + Math.random() * 500;
      const endF = startF + (Math.random() - 0.5) * 800;
      osc.frequency.setValueAtTime(startF, t + i * 0.08);
      osc.frequency.exponentialRampToValueAtTime(Math.max(100, endF), t + i * 0.08 + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.08);
      g.gain.linearRampToValueAtTime(def.gain * 0.5, t + i * 0.08 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.08 + 0.06);
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 3;
      panner.maxDistance = def.maxDistance;
      panner.rolloffFactor = 1.0;
      if (panner.positionX) {
        panner.positionX.setValueAtTime(def.pos.x, t);
        panner.positionY.setValueAtTime(def.pos.y, t);
        panner.positionZ.setValueAtTime(def.pos.z, t);
      }
      osc.connect(g);
      g.connect(panner);
      panner.connect(bus);
      osc.start(t + i * 0.08);
      osc.stop(t + i * 0.08 + 0.08);
      osc.onended = () => {
        try { g.disconnect(); } catch { /* noop */ }
        try { panner.disconnect(); } catch { /* noop */ }
      };
    }
  }

  private emitDistantGunshot(ctx: AudioContext, bus: AudioNode, def: AmbientSourceDef, t: number): void {
    // Distant gunfire — muffled crack + boom (per audio.ts distantGunshot).
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer!;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(def.gain * 0.5, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 50;
    panner.maxDistance = def.maxDistance;
    panner.rolloffFactor = 1.0;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(def.pos.x, t);
      panner.positionY.setValueAtTime(def.pos.y, t);
      panner.positionZ.setValueAtTime(def.pos.z, t);
    }
    src.connect(bp);
    bp.connect(g);
    g.connect(panner);
    panner.connect(bus);
    src.start(t);
    src.stop(t + 0.07);
    src.onended = () => {
      try { bp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
      try { panner.disconnect(); } catch { /* noop */ }
    };
  }

  private emitWindGust(ctx: AudioContext, bus: AudioNode, def: AmbientSourceDef, t: number): void {
    // Wind gust — filtered noise with rising then falling gain envelope.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer!;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 800;
    const g = ctx.createGain();
    const dur = 2.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(def.gain, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(lp);
    lp.connect(g);
    g.connect(bus);
    src.start(t);
    src.stop(t + dur + 0.1);
    src.onended = () => {
      try { lp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
  }

  private emitOceanWave(ctx: AudioContext, bus: AudioNode, def: AmbientSourceDef, t: number): void {
    // Ocean wave — filtered noise with a slow swell envelope (~5s).
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer!;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 600;
    const g = ctx.createGain();
    const dur = 5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(def.gain, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(lp);
    lp.connect(g);
    g.connect(bus);
    src.start(t);
    src.stop(t + dur + 0.1);
    src.onended = () => {
      try { lp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
  }

  dispose(): void {
    this.stopScene();
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _ambient: AmbientGeneratorEngine | null = null;
export function getAmbientGeneratorEngine(): AmbientGeneratorEngine {
  if (!_ambient) _ambient = new AmbientGeneratorEngine();
  return _ambient;
}
