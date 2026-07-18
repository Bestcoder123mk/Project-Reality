/**
 * SEC8-AUDIO (prompt 67) — Spatial audio / HRTF positional wrapper.
 *
 * Wraps a PannerNode configured for HRTF panning with inverse-distance
 * rolloff, plus an opt-in occlusion approximation (caller-supplied flag →
 * lowpass muffle). Without raycast integration the caller is responsible for
 * computing the `occluded` boolean (e.g. from a LOS check against the
 * navmesh / map geometry).
 *
 * SSR-safe: no AudioContext is touched until `attach()`.
 *
 * ─── G-5000 prompt mapping ────────────────────────────────────────────────
 *   #3402 → G2 #113 — panner-only disconnect leaks filter+gain  [intermediateNodes[]; onended disconnects the whole chain]
 *   #3409 → G2 #120 — listener position zipper noise             [setListenerPosition uses setTargetAtTime (5ms tau) instead of setValueAtTime]
 *   #3425 → G2 #136 — full-omni cone (no directional radiation)  [directional option: { forward, innerAngle=270, outerAngle=360, outerGain=0.3 }]
 *   #3526 → G  #813 — (cross-ref to #3436 — HRTF: PannerNode HRTF model + IndividualizedHrtfG in SectionG.ts for SOFA loading)
 *   #3530 → G  #817 — (cross-ref to #3440 — directional hit cue uses this PannerNode for stereo positioning)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BusMixer, BusName } from "./buses";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SpatialPlayOptions {
  /** When true, muffle the source with a lowpass filter (~600Hz cutoff). */
  occluded?: boolean;
  /** Bus to play through (default: "sfx"). */
  bus?: BusName;
  /** Per-source linear gain multiplier (default: 1). */
  gain?: number;
  /** Distance at which rolloff begins (default: 1.5m). */
  refDistance?: number;
  /** Distance at which the source is fully attenuated (default: 60m). */
  maxDistance?: number;
  /** Inverse-distance rolloff strength (default: 1.0). */
  rolloffFactor?: number;
  /** Playback rate (default: 1.0). */
  playbackRate?: number;
  /** Cutoff frequency (Hz) for the occlusion lowpass (default: 600). */
  occlusionCutoff?: number;
  /**
   * G2 #136 — directional radiation. When set, the panner's cone angles +
   * orientation are configured so the source emits louder in `forward` and
   * is muffled behind. Used for vehicle engines, muzzle reports, and other
   * sources with a real emission direction. Default: omni (full 360°).
   */
  directional?: {
    /** Source's emission forward vector (world space, need not be normalized). */
    forward: Vec3;
    /** Cone inner angle (degrees, 0–360). Default 270 (front ¾).
     *  Inside this angle the source is at full gain. */
    innerAngle?: number;
    /** Cone outer angle (degrees, 0–360, ≥ innerAngle). Default 360. */
    outerAngle?: number;
    /** Gain outside the outer angle (0–1). Default 0.3 (muffled). */
    outerGain?: number;
  };
}

export class SpatialAudio {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  /** Recently-started source nodes — kept for stopAll() / dispose(). */
  private activeSources = new Set<AudioBufferSourceNode>();

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  /**
   * Update listener world position (call from AudioSystem.update).
   *
   * G2 #120 — was `setValueAtTime(pos, t)` which produces zipper noise when
   * the player moves continuously (the listener snaps in 1-frame increments
   * instead of ramping smoothly). Switched to `setTargetAtTime` with a small
   * time constant (5ms) so the listener tracks smoothly without audible
   * zippering. The legacy Safari fallback still uses `setPosition` (no
   * automation API there).
   */
  setListenerPosition(pos: Vec3): void {
    if (!this.ctx) return;
    const listener = this.ctx.listener;
    const t = this.ctx.currentTime;
    const tau = 0.005; // 5ms smoothing — fast enough to track player motion, slow enough to de-zipper
    // Modern API: positionX/Y/Z AudioParams
    if (listener.positionX) {
      // setTargetAtTime exponential-smooths from the current value to the
      // target with the given time constant — no zipper discontinuities.
      listener.positionX.setTargetAtTime(pos.x, t, tau);
      listener.positionY.setTargetAtTime(pos.y, t, tau);
      listener.positionZ.setTargetAtTime(pos.z, t, tau);
    } else {
      // Deprecated fallback (Safari < 14, older Chrome)
      (listener as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(pos.x, pos.y, pos.z);
    }
  }

  /**
   * Update listener orientation. `forward` and `up` are direction vectors
   * (do not need to be normalized — PannerNode does it internally).
   */
  setListenerOrientation(forward: Vec3, up: Vec3): void {
    if (!this.ctx) return;
    const listener = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (listener.forwardX) {
      listener.forwardX.setValueAtTime(forward.x, t);
      listener.forwardY.setValueAtTime(forward.y, t);
      listener.forwardZ.setValueAtTime(forward.z, t);
      listener.upX.setValueAtTime(up.x, t);
      listener.upY.setValueAtTime(up.y, t);
      listener.upZ.setValueAtTime(up.z, t);
    } else {
      (listener as unknown as {
        setOrientation: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
      }).setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /**
   * Play an AudioBuffer at a world position with HRTF panning + distance
   * rolloff + optional occlusion muffle. Routes through the SFX bus by
   * default.
   */
  playSpatial(
    buffer: AudioBuffer,
    worldPos: Vec3,
    opts: SpatialPlayOptions = {},
  ): AudioBufferSourceNode | null {
    if (!this.ctx || !this.buses) return null;
    const busName: BusName = opts.bus ?? "sfx";
    const bus = this.buses.getBus(busName);
    if (!bus) return null;
    const ctx = this.ctx;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (opts.playbackRate !== undefined) src.playbackRate.value = opts.playbackRate;

    // Panner with HRTF
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = opts.refDistance ?? 1.5;
    panner.maxDistance = opts.maxDistance ?? 60;
    panner.rolloffFactor = opts.rolloffFactor ?? 1.0;
    // G2 #136 — directional radiation. Default is omni (full 360°). When the
    // caller passes `directional`, the panner's cone angles + orientation
    // are configured so the source is muffled behind (vehicle engines, muzzle
    // reports, etc.). The defaults are inner=270°, outer=360°, outerGain=0.3
    // — i.e. full gain in the front ¾, muffled to 30% behind.
    if (opts.directional) {
      const d = opts.directional;
      panner.coneInnerAngle = d.innerAngle ?? 270;
      panner.coneOuterAngle = d.outerAngle ?? 360;
      panner.coneOuterGain = d.outerGain ?? 0.3;
      const f = d.forward;
      if (panner.orientationX) {
        const t0 = ctx.currentTime;
        panner.orientationX.setValueAtTime(f.x, t0);
        panner.orientationY.setValueAtTime(f.y, t0);
        panner.orientationZ.setValueAtTime(f.z, t0);
      } else {
        (panner as unknown as { setOrientation: (x: number, y: number, z: number) => void })
          .setOrientation(f.x, f.y, f.z);
      }
    } else {
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 0;
    }
    const t = ctx.currentTime;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(worldPos.x, t);
      panner.positionY.setValueAtTime(worldPos.y, t);
      panner.positionZ.setValueAtTime(worldPos.z, t);
    } else {
      (panner as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(worldPos.x, worldPos.y, worldPos.z);
    }

    // Build the node chain: src → [occlusion LP] → [gain] → panner → bus.
    // Track each intermediate node so onended can disconnect them (G2 #113 —
    // only disconnecting the panner leaked every intermediate gain/filter).
    let out: AudioNode = src;
    const intermediateNodes: AudioNode[] = [];

    if (opts.occluded) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = opts.occlusionCutoff ?? 600;
      lp.Q.value = 0.7;
      src.connect(lp);
      out = lp;
      intermediateNodes.push(lp);
    }

    if (opts.gain !== undefined && opts.gain !== 1) {
      const g = ctx.createGain();
      g.gain.value = opts.gain;
      out.connect(g);
      out = g;
      intermediateNodes.push(g);
    }

    out.connect(panner);
    panner.connect(bus);

    src.onended = () => {
      this.activeSources.delete(src);
      // G2 #113 — disconnect the entire chain (intermediate LP + gain + panner).
      for (const n of intermediateNodes) {
        try { n.disconnect(); } catch { /* noop */ }
      }
      try { panner.disconnect(); } catch { /* noop */ }
    };
    this.activeSources.add(src);
    src.start();
    return src;
  }

  /**
   * Helper: play a positional synthesized noise burst (e.g. a footstep or
   * distant gunshot) without pre-rendering an AudioBuffer. Returns the
   * source node so callers can stop early if needed.
   */
  playSpatialNoiseBurst(
    worldPos: Vec3,
    opts: SpatialPlayOptions & {
      duration: number;
      filterType?: BiquadFilterType;
      filterFreq?: number;
      filterQ?: number;
      gain?: number;
      noiseBuffer: AudioBuffer;
    },
  ): AudioBufferSourceNode | null {
    if (!this.ctx || !this.buses) return null;
    const bus = this.buses.getBus(opts.bus ?? "sfx");
    if (!bus) return null;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = opts.noiseBuffer;
    const t = ctx.currentTime;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.filterType ?? "lowpass";
    filter.frequency.value = opts.filterFreq ?? 1000;
    if (opts.filterQ) filter.Q.value = opts.filterQ;

    const g = ctx.createGain();
    const peak = Math.max(0.0001, opts.gain ?? 0.4);
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);

    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = opts.refDistance ?? 1.5;
    panner.maxDistance = opts.maxDistance ?? 60;
    panner.rolloffFactor = opts.rolloffFactor ?? 1.0;
    // G2 #136 — directional radiation (see playSpatial above for details).
    if (opts.directional) {
      const d = opts.directional;
      panner.coneInnerAngle = d.innerAngle ?? 270;
      panner.coneOuterAngle = d.outerAngle ?? 360;
      panner.coneOuterGain = d.outerGain ?? 0.3;
      const f = d.forward;
      if (panner.orientationX) {
        panner.orientationX.setValueAtTime(f.x, t);
        panner.orientationY.setValueAtTime(f.y, t);
        panner.orientationZ.setValueAtTime(f.z, t);
      } else {
        (panner as unknown as { setOrientation: (x: number, y: number, z: number) => void })
          .setOrientation(f.x, f.y, f.z);
      }
    } else {
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 0;
    }
    if (panner.positionX) {
      panner.positionX.setValueAtTime(worldPos.x, t);
      panner.positionY.setValueAtTime(worldPos.y, t);
      panner.positionZ.setValueAtTime(worldPos.z, t);
    } else {
      (panner as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(worldPos.x, worldPos.y, worldPos.z);
    }

    let chain: AudioNode = filter;
    const noiseBurstNodes: AudioNode[] = [filter, g];
    src.connect(filter);
    filter.connect(g);
    chain = g;

    if (opts.occluded) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = opts.occlusionCutoff ?? 600;
      lp.Q.value = 0.7;
      chain.connect(lp);
      chain = lp;
      noiseBurstNodes.push(lp);
    }

    chain.connect(panner);
    panner.connect(bus);

    src.onended = () => {
      this.activeSources.delete(src);
      // G2 #113 — disconnect the entire chain (filter + gain + occlusion LP +
      // panner). Was: only `panner.disconnect()`, leaking the filter + gain
      // every burst.
      for (const n of noiseBurstNodes) {
        try { n.disconnect(); } catch { /* noop */ }
      }
      try { panner.disconnect(); } catch { /* noop */ }
    };
    this.activeSources.add(src);
    src.start(t);
    src.stop(t + opts.duration + 0.02);
    return src;
  }

  /** Stop all currently-playing spatial sources (e.g. on map unload). */
  stopAll(): void {
    for (const src of this.activeSources) {
      try { src.stop(); } catch { /* already ended */ }
    }
    this.activeSources.clear();
  }

  dispose(): void {
    this.stopAll();
    this.ctx = null;
    this.buses = null;
  }
}
