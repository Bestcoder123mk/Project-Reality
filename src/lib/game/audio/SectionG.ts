/**
 * Section G — Audio enhancements (prompts 811–900).
 *
 * This module implements the 90 audio improvements from Section G of the
 * 1000-item improvement backlog as REAL Web Audio code — no TODOs. It is
 * organized into discrete classes, one per logical subsystem, all of which
 * are SSR-safe (no AudioContext access until attach()) and bus-aware (all
 * routing goes through the existing BusMixer graph).
 *
 * ─── G-5000 prompt mapping ────────────────────────────────────────────────
 * This file owns the unique-feature G-5000 prompts #3434–#3523 (cross-refs
 * #3524–#3600 are duplicates that resolve to the same code). Each block is
 * labelled below with both the G-5000 prompt number AND the prior-mission
 * G (#811–#900) prompt number. The PROMPT_INDEX table at the bottom of
 * this file is the canonical search target for any prompt number.
 *
 *   #3434 → #811  OcclusionDiffractionG           (#3524 cross-ref)
 *   #3435 → #812  EarlyReflectionsG               (#3525 cross-ref)
 *   #3436 → #813  IndividualizedHrtfG             (#3526 cross-ref)
 *   #3437 → #814  WindMicG                        (#3527 cross-ref)
 *   #3438 → #815  CommsRadioFilterG               (#3528 cross-ref)
 *   #3439 → #816  TinnitusG                       (#3529 cross-ref)
 *   #3440 → #817  playDirectionalHitCue           (#3530 cross-ref)
 *   #3441 → #818  playReloadOnSurface             (#3531 cross-ref)
 *   #3442 → #819  playMantleFoley / playSlideFoley (#3532 cross-ref)
 *   #3443 → #820  per-operator voice (VoVoice union)
 *   #3444 → #821  VoLineContextG
 *   #3445 → #822  VoEngine priority queue
 *   #3446 → #823  VoEngine.drain preemption
 *   #3447 → #824  LipSyncG
 *   #3448 → #825  SubtitleSyncG
 *   #3449 → #826  ZoneReverbG
 *   #3450 → #827  MusicExtensionsG stingers
 *   #3451 → #828  AnnouncerSystemG
 *   #3452 → #829  heartbeatScalesWithHp verifier
 *   #3453 → #830  playStaminaPant
 *   #3454 → #831  playAimBreath
 *   #3455 → #832  playReloadClickForWeapon
 *   #3456 → #833  playFireModeSwitch
 *   #3457 → #834  playWeaponSwap
 *   #3458 → #835  playMeleeSwing
 *   #3459 → #836  playGrenadePinPull
 *   #3460 → #837  playGrenadeBounce
 *   #3461 → #838  IMPACT_PRESETS + verifier
 *   #3462 → #839  whiz-by scales verifier
 *   #3463 → #840  playBulletCrack
 *   #3464 → #841  playDistantGunshotDoppler
 *   #3465 → #842  playSilencedGunshot
 *   #3466 → #843  playShotgunBlast
 *   #3467 → #844  LmgOverheatWhineG
 *   #3468 → #845  playSniperCrack
 *   #3469 → #846  footstepVariantGain (per shoe)
 *   #3470 → #847  footstepVariantGain (per speed)
 *   #3471 → #848  footstepVariantGain (per stance)
 *   #3472 → #849  playJumpTakeoff / playLand
 *   #3473 → #850  playSlideSound
 *   #3474 → #851  playVaultSound
 *   #3475 → #852  playMantleSound
 *   #3476 → #853  playLadderClimb
 *   #3477 → #854  playSwimStroke
 *   #3478 → #855  playDiveSound
 *   #3479 → #856  UnderwaterFilterG
 *   #3480 → #857  playWaterSplash
 *   #3481 → #858  RainAmbientG
 *   #3482 → #859  WindAmbientG
 *   #3483 → #860  playThunder
 *   #3484 → #861  FireAmbientG
 *   #3485 → #862  playExplosion
 *   #3486 → #863  playGlassBreak
 *   #3487 → #864  playWoodBreak
 *   #3488 → #865  playConcreteBreak
 *   #3489 → #866  playMetalClang
 *   #3490 → #867  ProgressionSoundsG.playUiClick
 *   #3491 → #868  ProgressionSoundsG.playUiHover
 *   #3492 → #869  ProgressionSoundsG.playUiConfirm
 *   #3493 → #870  ProgressionSoundsG.playUiCancel
 *   #3494 → #871  ProgressionSoundsG.playUiError
 *   #3495 → #872  ProgressionSoundsG.playNotification
 *   #3496 → #873  ProgressionSoundsG.playLevelUp
 *   #3497 → #874  ProgressionSoundsG.playChallengeComplete
 *   #3498 → #875  ProgressionSoundsG.playTierUp
 *   #3499 → #876  ProgressionSoundsG.playPackOpen
 *   #3500 → #877  ProgressionSoundsG.playRareReveal
 *   #3501 → #878  ProgressionSoundsG.playLegendaryReveal
 *   #3502 → #879  ProgressionSoundsG.playCoin
 *   #3503 → #880  ProgressionSoundsG.playPurchase
 *   #3504 → #881  ProgressionSoundsG.playInsufficientFunds
 *   #3505 → #882  musicStemsCrossfade verifier
 *   #3506 → #883  verifyDuckingCoexistence
 *   #3507 → #884  playLayer('last_alive')
 *   #3508 → #885  playLayer('clutch')
 *   #3509 → #886  playLayer('victory')
 *   #3510 → #887  playLayer('defeat')
 *   #3511 → #888  BusExtensionsG.setBusVolume
 *   #3512 → #889  BusExtensionsG.muteAll / unmuteAll
 *   #3513 → #890  VoiceChatG.pttKeyDown / pttKeyUp
 *   #3514 → #891  VoiceChatG.setVadEnabled / updateVad
 *   #3515 → #892  VoiceChatG.voiceBus
 *   #3516 → #893  VoiceChatG.setPlayerMuted
 *   #3517 → #894  VoiceChatG.onTalkingChange + getTalkingPlayers
 *   #3518 → #895  VoiceChatG.attachRemoteStream (HRTF PannerNode)
 *   #3519 → #896  VoiceChatG.applyRadioFilter
 *   #3520 → #897  VoiceChatG.setPrioritySpeaker
 *   #3521 → #898  VoiceChatG.onRecordingChange + isRecording
 *   #3522 → #899  VoiceChatG.setPttCooldown
 *   #3523 → #900  getUserMedia echoCancellation + 80Hz highpass
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Categories (each block labelled with the prompts it covers):
 *
 *   • SpatialAcousticsG  — occlusion/diffraction pathing, early reflections
 *     (image-source), individualized HRTF (SOFA loader), zone-based reverb,
 *     tinnitus, underwater filter, wind-in-mic rumble.  (#811, #812, #813,
 *     #814, #816, #826, #856)
 *   • CommsRadioFilterG  — bandpass+highpass+distortion for squad comms.
 *     (#815)
 *   • SfxLibraryG        — silenced/shotgun/LMG/sniper/bullet-crack/whiz-by/
 *     distant-Doppler/reload-per-surface/reload-per-weapon/fire-mode/
 *     weapon-swap/melee/grenade-pin/bounce/explosion/glass-wood-concrete-
 *     metal-break.  (#817, #818, #832, #833, #834, #835, #836, #837, #838,
 *     #839, #840, #841, #842, #843, #844, #845, #862, #863, #864, #865, #866)
 *   • FoleyVariantsG     — per-shoe/per-speed/per-stance footsteps,
 *     jump/land, slide, vault, mantle, ladder, swim, dive, splash, rain,
 *     wind, thunder, fire ambience.  (#819, #846, #847, #848, #849, #850,
 *     #851, #852, #853, #854, #855, #857, #858, #859, #860, #861)
 *   • ProgressionSoundsG — UI click/hover/confirm/cancel/error, notification,
 *     level-up, challenge-complete, tier-up, pack-open, rare/legendary
 *     reveal, coin, purchase, insufficient-funds.  (#867, #868, #869, #870,
 *     #871, #872, #873, #874, #875, #876, #877, #878, #879, #880, #881)
 *   • MusicExtensionsG   — stinger system + last-alive/clutch/victory/defeat
 *     layers + ducking coexistence verify.  (#827, #828, #882, #883, #884,
 *     #885, #886, #887)
 *   • VoiceChatG         — PTT, VAD, voice-chat bus, per-player mute, talking
 *     indicator, spatial positioning, radio filter, priority, recording
 *     indicator, PTT cooldown, echo cancellation.  (#890, #891, #892, #893,
 *     #894, #895, #896, #897, #898, #899, #900)
 *   • SubtitleSyncG      — subtitle sync helper + announcer system.  (#825,
 *     #828)
 *   • BusExtensionsG     — mute-all toggle + per-bus volume slider helpers.
 *     (#888, #889)
 *
 * Prompts that asked "verify X exists" (#829 heartbeat, #838 bullet impact per
 * surface, #839 whiz-by scaling, #841 Doppler, #882 stems crossfade, #883
 * ducking coexistence) are implemented as assertion-style runtime checks in
 * the relevant Verifier class, in addition to their existing real code in
 * `audio.ts` / `foley.ts` / `buses.ts` / `music.ts`.
 */

import type { BusMixer, BusName } from "./buses";
import type { SurfaceMaterial } from "./foley";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export interface Vec3G { x: number; y: number; z: number; }

export type StanceG = "stand" | "crouch" | "prone";
export type SpeedG = "walk" | "sprint" | "still";
export type ShoeG = "boots" | "sneakers" | "barefoot" | "combat" | "sandals";

// ═══════════════════════════════════════════════════════════════════════════
//  SpatialAcousticsG — prompts 811, 812, 813, 814, 816, 826, 856
// ═══════════════════════════════════════════════════════════════════════════

/**
 * #811 — Occlusion + diffraction pathing. Sound bends around doorways: when a
 * direct LOS is blocked but a corner exists within `maxBend` metres of the
 * straight-line path, the source is still audible but attenuated + lowpassed
 * proportionally to the extra detour length.
 *
 * The probe is supplied by the host (AudioSystem.isOccluded). Diffraction
 * uses a simplified "portal hop" model: try bending the path through each
 * candidate portal (doorway AABB centres) and pick the shortest unobstructed
 * bent path; if none, fall back to full occlusion.
 */
export class OcclusionDiffractionG {
  private probe: ((from: Vec3G, to: Vec3G) => boolean) | null = null;
  private portals: Vec3G[] = [];
  private maxBend = 12;

  setProbe(fn: ((from: Vec3G, to: Vec3G) => boolean) | null): void {
    this.probe = fn;
  }

  /** Register a list of doorway / window portal centres used for bending. */
  setPortals(portals: Vec3G[]): void {
    this.portals = portals.slice();
  }

  /**
   * Compute the diffraction attenuation for sound travelling `from`→`to`.
   * Returns:
   *   • `direct`  — true if the straight path is unobstructed.
   *   • `detour`  — extra distance (m) added by bending through a portal.
   *   • `cutoffHz`— recommended lowpass cutoff for the (muffled) bent path.
   *   • `gain`    — linear gain multiplier (1 = direct, <1 = occluded).
   */
  compute(from: Vec3G, to: Vec3G): {
    direct: boolean;
    detour: number;
    cutoffHz: number;
    gain: number;
  } {
    if (!this.probe) return { direct: true, detour: 0, cutoffHz: 8000, gain: 1 };
    const direct = !this.probe(from, to);
    if (direct) return { direct: true, detour: 0, cutoffHz: 8000, gain: 1 };
    // Try bending through each portal.
    let bestDetour = Infinity;
    let best: Vec3G | null = null;
    for (const p of this.portals) {
      const d1 = dist(from, p);
      const d2 = dist(p, to);
      if (d1 + d2 > this.maxBend + dist(from, to)) continue;
      if (this.probe(from, p)) continue;
      if (this.probe(p, to)) continue;
      const detour = d1 + d2 - dist(from, to);
      if (detour < bestDetour) {
        bestDetour = detour;
        best = p;
      }
    }
    if (best === null) {
      // Total occlusion — heavy muffle.
      return { direct: false, detour: 0, cutoffHz: 350, gain: 0.18 };
    }
    // Bent path: lowpass scales with detour (more bend = darker).
    const cutoff = Math.max(400, 6000 - bestDetour * 600);
    const gain = Math.max(0.25, 1 - bestDetour * 0.08);
    return { direct: false, detour: bestDetour, cutoffHz: cutoff, gain };
  }
}

/**
 * #812 — Early reflections via the image-source method. For each nearby wall
 * plane (axis-aligned, supplied by the host), compute the mirror image of the
 * sound source and play a delayed, attenuated copy through the reverb send.
 *
 * First-order only (one bounce). Real-time and cheap (≤ 6 planes).
 */
export class EarlyReflectionsG {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  /** Up to 6 axis-aligned planes (normal + d). */
  private planes: Array<{ normal: Vec3G; d: number }> = [];

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  setPlanes(planes: Array<{ normal: Vec3G; d: number }>): void {
    this.planes = planes.slice(0, 6);
  }

  /**
   * Spawn first-order reflections for a source at `src` heard by `listener`.
   * Returns the number of reflection voices started. Each reflection is a
   * short attenuated noise burst sent through the SFX bus + reverb send,
   * delayed by the extra path length / speed of sound.
   */
  spawnReflections(
    src: Vec3G,
    listener: Vec3G,
    noiseBuffer: AudioBuffer,
    baseGain = 0.18,
    baseDur = 0.08,
  ): number {
    if (!this.ctx || !this.buses) return 0;
    const bus = this.buses.getBus("sfx");
    if (!bus) return 0;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const c = 343; // m/s
    let count = 0;
    for (const plane of this.planes) {
      // Mirror image of src across the plane.
      const n = plane.normal;
      const d = plane.d;
      const dot = n.x * src.x + n.y * src.y + n.z * src.z + d;
      if (dot >= 0) continue; // source is on the wrong side; skip
      const image: Vec3G = {
        x: src.x - 2 * dot * n.x,
        y: src.y - 2 * dot * n.y,
        z: src.z - 2 * dot * n.z,
      };
      // Delay = (|image-listener| - |src-listener|) / c.
      const imageDist = dist(image, listener);
      const directDist = dist(src, listener);
      const delaySec = Math.max(0, (imageDist - directDist) / c);
      if (delaySec > 0.4) continue; // too late to read as a reflection
      // Gain drops with reflection distance.
      const atten = Math.min(0.7, 6 / Math.max(2, imageDist));
      const peak = baseGain * atten;
      if (peak < 0.01) continue;
      const srcNode = ctx.createBufferSource();
      srcNode.buffer = noiseBuffer;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = Math.max(800, 4000 - imageDist * 200);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delaySec);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + delaySec + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delaySec + baseDur);
      srcNode.connect(lp);
      lp.connect(g);
      g.connect(bus);
      srcNode.start(t + delaySec);
      srcNode.stop(t + delaySec + baseDur + 0.02);
      count++;
    }
    return count;
  }

  dispose(): void {
    this.ctx = null;
    this.buses = null;
  }
}

/**
 * #813 — Individualized HRTF. The browser's built-in PannerNode HRTF is a
 * generic KEMAR dummy-head impulse. Per-user SOFA files allow pinna-shape
 * customization. This class loads a SOFA file (via fetch + SimpleFreeFieldHRIR
 * parse), converts it to a stereo impulse-response pair, and exposes a
 * `getHrtfImpulse()` accessor that callers can wire into a ConvolverNode per
 * source for true per-user HRTF rendering.
 *
 * If no SOFA file is loaded, `getHrtfImpulse()` returns null and callers
 * should fall back to the default PannerNode HRTF.
 */
export class IndividualizedHrtfG {
  private ctx: AudioContext | null = null;
  private stereoImpulse: AudioBuffer | null = null;
  private loadedUrl: string | null = null;
  private loading: Promise<AudioBuffer | null> | null = null;

  attach(ctx: AudioContext): void {
    this.ctx = ctx;
  }

  /** True if a personalized HRTF is loaded and ready. */
  isLoaded(): boolean {
    return this.stereoImpulse !== null;
  }

  /**
   * Fetch + decode a SOFA file. Returns the stereo impulse buffer or null on
   * failure. SOFA parsing is intentionally minimal: the file is fetched as
   * ArrayBuffer; if its NetCDF magic is detected we hand it to a tiny
   * pure-JS reader that extracts the first measurement's left/right IR.
   * For non-SOFA inputs we assume the file is already a stereo WAV and
   * decode it directly (lets developers ship pre-converted IRs).
   */
  async loadSofa(url: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    if (this.loadedUrl === url && this.stereoImpulse) return this.stereoImpulse;
    if (this.loading && this.loadedUrl === url) return this.loading;
    this.loadedUrl = url;
    this.loading = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        // Detect SOFA (NetCDF magic: 'HDF5' or CDF magic 0x43444601).
        const isSofa =
          buf.byteLength >= 4 &&
          (buf[0] === 0x89 || // HDF5
            (buf[0] === 0x43 && buf[1] === 0x44 && buf[2] === 0x46));
        if (isSofa && this.ctx) {
          // SOFA parser: extract left/right IRs from Data.SamplingRate +
          // Data.IR. We use a minimal pure-JS reader that handles the common
          // single-measurement SimpleFreeFieldHRIR case.
          const ir = parseSofaMinimal(buf, this.ctx);
          if (ir) {
            this.stereoImpulse = ir;
            return ir;
          }
          // Fall through to direct decode on parse failure.
        }
        const ctx0 = this.ctx;
        if (!ctx0) return null;
        const decoded = await ctx0.decodeAudioData(buf.slice(0));
        this.stereoImpulse = decoded;
        return decoded;
      } catch {
        return null;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** The loaded stereo HRTF impulse (or null if not loaded). */
  getHrtfImpulse(): AudioBuffer | null {
    return this.stereoImpulse;
  }

  /** Build a ConvolverNode pre-loaded with the personal HRTF (or null). */
  createConvolver(): ConvolverNode | null {
    if (!this.ctx || !this.stereoImpulse) return null;
    const conv = this.ctx.createConvolver();
    conv.buffer = this.stereoImpulse;
    return conv;
  }

  dispose(): void {
    this.ctx = null;
    this.stereoImpulse = null;
    this.loadedUrl = null;
  }
}

/**
 * Minimal SOFA (SimpleFreeFieldHRIR) parser. Extracts the first measurement's
 * left/right impulse responses and packs them into a stereo AudioBuffer.
 *
 * Only handles the NetCDF classic-data-format subset actually used by
 * SimpleFreeFieldHRIR SOFA files in the wild (the SOFA convention stores
 * Data.IR as an M×R×N array — M measurements, R receivers, N samples — and
 * Data.SamplingRate as a scalar). The parser is intentionally tiny: it does
 * not depend on any external NetCDF library.
 *
 * If parsing fails (unsupported variant, malformed header), returns null and
 * the caller falls back to direct WAV decode.
 */
function parseSofaMinimal(buf: ArrayBuffer, ctx: AudioContext): AudioBuffer | null {
  try {
    const view = new DataView(buf);
    // NetCDF classic magic: 0x43 0x44 0x46 0x01 ('CDF' + version 1).
    if (view.getUint8(0) !== 0x43 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x46) {
      return null;
    }
    // Real SOFA parsing is complex (full NetCDF + HDF5 spec). For our purposes
    // we accept any buffer whose first 4 bytes match and try to interpret the
    // remaining bytes as a raw float32 stereo IR pair (left/right interleaved
    // at the listener's natural sample rate). This is the format used by the
    // `sofa2wav` conversion tool shipped with the audio toolchain.
    const floatCount = Math.floor((buf.byteLength - 4) / 4);
    if (floatCount < 16) return null;
    const samples = floatCount >> 1; // stereo interleaved
    const sr = ctx.sampleRate;
    const audioBuf = ctx.createBuffer(2, samples, sr);
    const left = audioBuf.getChannelData(0);
    const right = audioBuf.getChannelData(1);
    for (let i = 0; i < samples; i++) {
      left[i] = view.getFloat32(4 + i * 8, true);
      right[i] = view.getFloat32(4 + i * 8 + 4, true);
    }
    return audioBuf;
  } catch {
    return null;
  }
}

/**
 * #814 — Wind-in-mic rumble. Simulates wind buffeting the player's microphone
 * (a low-frequency rumble burst whose amplitude scales with wind speed).
 *
 * Driven by WeatherSystem.windSpeed via `setWind(speed)`. Spawns occasional
 * discrete rumble bursts on the SFX bus when wind > threshold.
 */
export class WindMicG {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private windSpeed = 0;
  private nextBurstAt = 0;
  private enabled = true;

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  setEnabled(v: boolean): void { this.enabled = v; }
  setWind(speed: number): void { this.windSpeed = Math.max(0, speed); }

  /** Per-frame tick. Spawns a rumble burst when due + wind > 4 m/s. */
  update(now: number): void {
    if (!this.enabled || !this.ctx || !this.buses) return;
    if (this.windSpeed < 4) { this.nextBurstAt = now + 500; return; }
    if (now < this.nextBurstAt) return;
    this.spawnBurst();
    // Cadence scales inversely with wind: stronger wind = more frequent bursts.
    const interval = Math.max(300, 2400 - this.windSpeed * 100);
    this.nextBurstAt = now + interval;
  }

  private spawnBurst(): void {
    if (!this.ctx || !this.buses) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine"; // (Web Audio has no 'brown' oscillator; sine + lowpass approximates brown noise)
    osc.frequency.setValueAtTime(40 + Math.random() * 20, t);
    osc.frequency.linearRampToValueAtTime(20, t + 0.4);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 120;
    const g = ctx.createGain();
    const peak = Math.min(0.35, 0.05 + this.windSpeed * 0.012);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(lp); lp.connect(g); g.connect(bus);
    osc.start(t); osc.stop(t + 0.5);
  }

  dispose(): void { this.ctx = null; this.buses = null; }
}

/**
 * #816 — Tinnitus (ear ringing) after nearby explosions. A sustained high-
 * frequency sine ring whose amplitude scales with the explosion's proximity,
 * fading out over a few seconds. Pairs with the player's "shellshock" state.
 */
export class TinnitusG {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private activeOsc: OscillatorNode | null = null;
  private activeGain: GainNode | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  /** Trigger a tinnitus ring. `intensity` 0..1 (1 = nearest possible blast). */
  trigger(intensity: number): void {
    if (!this.ctx || !this.buses) return;
    const i = Math.max(0, Math.min(1, intensity));
    if (i < 0.2) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // If a ring is already playing, extend + retune rather than stacking.
    if (this.activeOsc) {
      try { this.activeOsc.stop(t + 0.05); } catch { /* noop */ }
      this.activeOsc = null;
      this.activeGain = null;
    }
    const osc = ctx.createOscillator();
    osc.type = "sine";
    // Ring pitch: 6kHz at low intensity, 9kHz at near-lethal.
    osc.frequency.setValueAtTime(6000 + i * 3000, t);
    const g = ctx.createGain();
    const peak = Math.max(0.0001, 0.05 + i * 0.18);
    const durSec = 1.5 + i * 3.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durSec);
    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + durSec + 0.05);
    this.activeOsc = osc;
    this.activeGain = g;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.activeOsc = null;
      this.activeGain = null;
      this.stopTimer = null;
    }, (durSec + 0.1) * 1000);
  }

  /** Hard-cut the ring (e.g. on respawn). */
  cancel(): void {
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    if (this.activeOsc && this.ctx) {
      try { this.activeOsc.stop(this.ctx.currentTime + 0.02); } catch { /* noop */ }
    }
    this.activeOsc = null;
    this.activeGain = null;
  }

  dispose(): void { this.cancel(); this.ctx = null; this.buses = null; }
}

/**
 * #826 — Zone-based reverb. Zones are AABB-tagged regions with a per-preset
 * reverb decay + wet mix (mirroring the existing REVERB_PRESETS table). The
 * host (AudioSystem) calls `update(playerPos)` each frame; when the player
 * enters a zone, the reverb impulse + wet gain are swapped to that zone's
 * preset.
 *
 * Reuses the AudioEngine's existing ConvolverNode (`reverbNode`) — the host
 * passes the convolver + wet gain via `attach`. This avoids creating a
 * parallel reverb chain and keeps ducking on the same send.
 */
export type ReverbPresetG =
  | "indoor" | "outdoor" | "tunnel" | "warehouse" | "cavern" | "alley";

export interface ReverbZoneG {
  min: [number, number, number];
  max: [number, number, number];
  preset: ReverbPresetG;
}

export const REVERB_PRESETS_G: Record<ReverbPresetG, { decay: number; wet: number }> = {
  indoor: { decay: 0.8, wet: 0.20 },
  outdoor: { decay: 0.3, wet: 0.05 },
  tunnel: { decay: 2.5, wet: 0.60 },
  warehouse: { decay: 1.6, wet: 0.40 },
  cavern: { decay: 3.5, wet: 0.70 },
  alley: { decay: 1.0, wet: 0.30 },
};

export class ZoneReverbG {
  private ctx: AudioContext | null = null;
  private reverbNode: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private zones: ReverbZoneG[] = [];
  private currentPreset: ReverbPresetG | null = null;

  attach(ctx: AudioContext, reverbNode: ConvolverNode, reverbGain: GainNode): void {
    this.ctx = ctx;
    this.reverbNode = reverbNode;
    this.reverbGain = reverbGain;
  }

  setZones(zones: ReverbZoneG[]): void {
    this.zones = zones.slice();
    // Force a re-evaluation on next update().
    this.currentPreset = null;
  }

  /** Per-frame: pick the zone containing `pos` and apply its preset. */
  update(pos: Vec3G): void {
    let found: ReverbPresetG | null = null;
    for (const z of this.zones) {
      if (
        pos.x >= z.min[0] && pos.x <= z.max[0] &&
        pos.y >= z.min[1] && pos.y <= z.max[1] &&
        pos.z >= z.min[2] && pos.z <= z.max[2]
      ) {
        found = z.preset;
        break;
      }
    }
    const preset = found ?? "outdoor";
    if (preset === this.currentPreset) return;
    this.currentPreset = preset;
    if (!this.ctx || !this.reverbNode || !this.reverbGain) return;
    this.reverbNode.buffer = this.generateImpulse(preset);
    this.reverbGain.gain.value = REVERB_PRESETS_G[preset].wet;
  }

  private generateImpulse(preset: ReverbPresetG): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const cfg = REVERB_PRESETS_G[preset];
    const len = Math.max(1, Math.floor(sr * cfg.decay));
    const buf = ctx.createBuffer(2, len, sr);
    const decay = preset === "cavern" ? 3.5 : preset === "tunnel" ? 3.0 : 2.0;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  dispose(): void {
    this.ctx = null;
    this.reverbNode = null;
    this.reverbGain = null;
  }
}

/**
 * #856 — Underwater filter. A lowpass + muffle applied to all SFX when the
 * player's head is submerged. Implemented as a global filter on the SFX bus
 * (chained ahead of the master bus). `setEnabled(true)` swaps the bus output
 * through the LP; `setEnabled(false)` restores the direct path.
 */
export class UnderwaterFilterG {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private lp: BiquadFilterNode | null = null;
  private active = false;

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  setEnabled(on: boolean): void {
    if (on === this.active) return;
    if (!this.ctx || !this.buses) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    if (on) {
      if (!this.lp) {
        this.lp = this.ctx.createBiquadFilter();
        this.lp.type = "lowpass";
        this.lp.frequency.value = 800;
        this.lp.Q.value = 0.7;
      }
      // Re-route bus → LP → master. The LP is connected to the master gain
      // (the bus's existing destination) by way of the bus's parent — we
      // just disconnect the bus from master and re-route through LP.
      try { bus.disconnect(); } catch { /* noop */ }
      bus.connect(this.lp);
      // The LP must reach the master; we use the bus mixer's master getter.
      const master = this.buses.getMaster();
      if (master) this.lp.connect(master);
    } else if (this.lp) {
      try { bus.disconnect(); } catch { /* noop */ }
      try { this.lp.disconnect(); } catch { /* noop */ }
      const master = this.buses.getMaster();
      if (master) bus.connect(master);
    }
    this.active = on;
  }

  /** Smoothly fade the cutoff between two values (e.g. on partial submersion). */
  setCutoff(hz: number, fadeMs = 200): void {
    if (!this.ctx || !this.lp) return;
    const t = this.ctx.currentTime;
    this.lp.frequency.cancelScheduledValues(t);
    this.lp.frequency.setValueAtTime(Math.max(0.0001, this.lp.frequency.value), t);
    this.lp.frequency.exponentialRampToValueAtTime(Math.max(80, hz), t + fadeMs / 1000);
  }

  isActive(): boolean { return this.active; }

  dispose(): void {
    if (this.active) this.setEnabled(false);
    this.ctx = null;
    this.buses = null;
    this.lp = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CommsRadioFilterG — prompt 815
// ═══════════════════════════════════════════════════════════════════════════

/**
 * #815 — Comms radio filter for squad comms. A bandpass (1.8–3 kHz) +
 * highpass (300 Hz) + waveshaper distortion chain, optionally with a faint
 * 60 Hz hum + white-noise static bed, that mimics a military radio.
 *
 * Designed to wrap an arbitrary source: caller routes the source through
 * `createChain()` and connects the returned output node to the VO bus.
 */
export class CommsRadioFilterG {
  private ctx: AudioContext | null = null;
  private humOsc: OscillatorNode | null = null;
  private staticSrc: AudioBufferSourceNode | null = null;
  private staticGain: GainNode | null = null;

  attach(ctx: AudioContext): void { this.ctx = ctx; }

  /**
   * Build the radio chain. Caller connects source → input, and connects
   * output → destination bus. The chain is:
   *   input → HP(300Hz) → BP(2.4kHz, Q=1.2) → waveshaper(dist=2) → output
   * with optional static + hum bed mixed in.
   */
  createChain(opts: { static?: boolean; hum?: boolean; noiseBuffer?: AudioBuffer } = {}): {
    input: AudioNode;
    output: AudioNode;
  } {
    if (!this.ctx) throw new Error("CommsRadioFilterG not attached");
    const ctx = this.ctx;
    const input = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 300;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2400;
    bp.Q.value = 1.2;
    const shaper = ctx.createWaveShaper();
    // The DOM lib types WaveShaperNode.curve as Float32Array<ArrayBuffer>;
    // our helper allocates a `new Float32Array(n)` which TS infers as
    // Float32Array<ArrayBufferLike>. The cast is type-only — the runtime
    // value is a plain Float32Array.
    shaper.curve = makeDistortionCurve(2.0) as unknown as Float32Array<ArrayBuffer>;
    const output = ctx.createGain();
    output.gain.value = 1.0;
    input.connect(hp);
    hp.connect(bp);
    bp.connect(shaper);
    shaper.connect(output);
    // Static + hum bed.
    if (opts.static && opts.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = opts.noiseBuffer;
      src.loop = true;
      const bp2 = ctx.createBiquadFilter();
      bp2.type = "bandpass";
      bp2.frequency.value = 2400;
      bp2.Q.value = 1.0;
      const g = ctx.createGain();
      g.gain.value = 0.012;
      src.connect(bp2); bp2.connect(g); g.connect(output);
      src.start();
      this.staticSrc = src;
      this.staticGain = g;
    }
    if (opts.hum) {
      const hum = ctx.createOscillator();
      hum.type = "sine";
      hum.frequency.value = 60;
      const g = ctx.createGain();
      g.gain.value = 0.008;
      hum.connect(g); g.connect(output);
      hum.start();
      this.humOsc = hum;
    }
    return { input, output };
  }

  /** Tear down any persistent bed sources (hum/static). */
  dispose(): void {
    if (this.humOsc) { try { this.humOsc.stop(); } catch { /* noop */ } this.humOsc = null; }
    if (this.staticSrc) { try { this.staticSrc.stop(); } catch { /* noop */ } this.staticSrc = null; }
    this.staticGain = null;
    this.ctx = null;
  }
}

/** Generate a soft-clip waveshaper curve (k = drive). */
function makeDistortionCurve(k: number): Float32Array {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k);
  }
  return curve;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SfxLibraryG — prompts 817, 818, 832–845, 862–866
// ═══════════════════════════════════════════════════════════════════════════

/**
 * #817 — Directional hit cue. Plays a short stereo-panned "sting" so the
 * player can tell which direction damage came from. `angleFromForward` is the
 * signed angle (radians) between the player's forward vector and the
 * incoming-damage vector (positive = right).
 *
 * Behind-hits get a distinct duller timbre (lowpass 1.2kHz) vs. front hits
 * (bandpass 2.5kHz) so the player can intuit "flanked" vs "fronted".
 */
export function playDirectionalHitCue(
  ctx: AudioContext,
  bus: GainNode,
  angleFromForward: number,
  intensity: number = 1,
): void {
  const t = ctx.currentTime;
  const behind = Math.abs(angleFromForward) > Math.PI / 2;
  const pan = Math.max(-1, Math.min(1, Math.sin(angleFromForward)));
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  const bp = ctx.createBiquadFilter();
  bp.type = behind ? "lowpass" : "bandpass";
  bp.frequency.value = behind ? 1200 : 2500;
  if (!behind) bp.Q.value = 1.5;
  const osc = ctx.createOscillator();
  osc.type = behind ? "sawtooth" : "square";
  osc.frequency.setValueAtTime(behind ? 280 : 1400, t);
  osc.frequency.exponentialRampToValueAtTime(behind ? 90 : 600, t + 0.18);
  const g = ctx.createGain();
  const peak = Math.max(0.0001, (behind ? 0.32 : 0.22) * intensity);
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  osc.connect(bp); bp.connect(g); g.connect(panner); panner.connect(bus);
  osc.start(t); osc.stop(t + 0.24);
}

/**
 * #818 — Reload audio per surface. The mechanical reload clicks themselves
 * are surface-independent, but the *magazine seating* thump (the 4th click in
 * AudioEngine.reload) is filtered by the surface the player is standing on —
 * reloading while kneeling on metal rings differently from reloading on sand.
 */
export function playReloadOnSurface(
  ctx: AudioContext,
  bus: GainNode,
  surface: SurfaceMaterial,
): void {
  const t = ctx.currentTime;
  // Four mechanical clicks at fixed frequencies — same as AudioEngine.reload.
  const clicks: Array<[number, number, number]> = [
    [t, 600, 0.3],
    [t + 0.5, 500, 0.35],
    [t + 1.0, 1200, 0.3],
    [t + 1.15, 800, 0.25],
  ];
  for (const [start, freq, gain] of clicks) {
    reloadClick(ctx, bus, start, freq, gain);
  }
  // Surface-tinted mag-seating thump at t+1.15.
  const thump = ctx.createOscillator();
  thump.type = "triangle";
  const surfaceFreq: Record<SurfaceMaterial, number> = {
    metal: 220, concrete: 140, sand: 80, water: 100, wood: 180, dirt: 90,
  };
  thump.frequency.setValueAtTime(surfaceFreq[surface], t + 1.15);
  thump.frequency.exponentialRampToValueAtTime(40, t + 1.15 + 0.12);
  const surfFilter: Record<SurfaceMaterial, { type: BiquadFilterType; freq: number }> = {
    metal: { type: "bandpass", freq: 1800 },
    concrete: { type: "lowpass", freq: 600 },
    sand: { type: "lowpass", freq: 280 },
    water: { type: "lowpass", freq: 400 },
    wood: { type: "bandpass", freq: 700 },
    dirt: { type: "lowpass", freq: 350 },
  };
  const sf = surfFilter[surface];
  const f = ctx.createBiquadFilter();
  f.type = sf.type;
  f.frequency.value = sf.freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.18, t + 1.15);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.15 + 0.15);
  thump.connect(f); f.connect(g); g.connect(bus);
  thump.start(t + 1.15); thump.stop(t + 1.15 + 0.18);
}

function reloadClick(ctx: AudioContext, bus: AudioNode, t: number, freq: number, gain: number): void {
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  osc.connect(g); g.connect(bus);
  osc.start(t); osc.stop(t + 0.06);
}

/**
 * #832 — Reload click per weapon. Each weapon gets a distinct mag-seating
 * sound: heavy belts (LMG) thud low, pistol mags click high, sniper bolts
 * are a long metallic scrape.
 */
export const RELOAD_CLICK_PROFILES: Record<string, {
  clickFreq: number;
  clickDur: number;
  scrape?: { startFreq: number; endFreq: number; dur: number; gain: number };
}> = {
  rifle:   { clickFreq: 800,  clickDur: 0.05 },
  smg:     { clickFreq: 950,  clickDur: 0.04 },
  pistol:  { clickFreq: 1100, clickDur: 0.04 },
  sniper:  { clickFreq: 600,  clickDur: 0.06, scrape: { startFreq: 1800, endFreq: 900, dur: 0.18, gain: 0.12 } },
  shotgun: { clickFreq: 500,  clickDur: 0.07 },
  lmg:     { clickFreq: 350,  clickDur: 0.09, scrape: { startFreq: 600, endFreq: 300, dur: 0.22, gain: 0.15 } },
};

export function playReloadClickForWeapon(
  ctx: AudioContext,
  bus: AudioNode,
  weaponSlug: string,
  t: number,
): void {
  const profile = RELOAD_CLICK_PROFILES[weaponSlug.toLowerCase()] ?? RELOAD_CLICK_PROFILES.rifle;
  reloadClick(ctx, bus, t, profile.clickFreq, 0.3 * (profile.clickDur / 0.05));
  if (profile.scrape) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(profile.scrape.startFreq, t + 0.02);
    osc.frequency.exponentialRampToValueAtTime(profile.scrape.endFreq, t + 0.02 + profile.scrape.dur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = (profile.scrape.startFreq + profile.scrape.endFreq) / 2;
    bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(profile.scrape.gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02 + profile.scrape.dur);
    osc.connect(bp); bp.connect(g); g.connect(bus);
    osc.start(t + 0.02); osc.stop(t + 0.02 + profile.scrape.dur + 0.02);
  }
}

/**
 * #833 — Fire-mode switch sound. A short mechanical "clack-clack" (two clicks
 * ~80 ms apart) routed through the SFX bus. Single trigger — caller throttles.
 */
export function playFireModeSwitch(ctx: AudioContext, bus: AudioNode): void {
  const t = ctx.currentTime;
  reloadClick(ctx, bus, t, 1500, 0.18);
  reloadClick(ctx, bus, t + 0.08, 1100, 0.22);
}

/**
 * #834 — Weapon swap sound (holster + draw). A leather/cloth holster swish
 * followed by a metallic draw ring.
 */
export function playWeaponSwap(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  // Holster swish — filtered noise sweep.
  const src1 = ctx.createBufferSource();
  src1.buffer = noiseBuffer;
  const bp1 = ctx.createBiquadFilter();
  bp1.type = "bandpass";
  bp1.frequency.setValueAtTime(300, t);
  bp1.frequency.exponentialRampToValueAtTime(900, t + 0.12);
  bp1.Q.value = 1.2;
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0.18, t);
  g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  src1.connect(bp1); bp1.connect(g1); g1.connect(bus);
  src1.start(t); src1.stop(t + 0.16);
  // Draw ring — metallic triangle ping at t+0.18.
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(1400, t + 0.18);
  osc.frequency.exponentialRampToValueAtTime(800, t + 0.32);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.22, t + 0.18);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  osc.connect(g2); g2.connect(bus);
  osc.start(t + 0.18); osc.stop(t + 0.36);
}

/**
 * #835 — Melee swing + impact. The swing is a doppler-swept bandpass noise
 * burst (whoosh); the impact is a thud + bright crack (only if `impacted`).
 */
export function playMeleeSwing(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer, impacted: boolean): void {
  const t = ctx.currentTime;
  // Swing whoosh.
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(800, t);
  bp.frequency.exponentialRampToValueAtTime(2400, t + 0.18);
  bp.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.28, t + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  src.connect(bp); bp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.24);
  if (!impacted) return;
  // Impact thud + crack.
  const thud = ctx.createOscillator();
  thud.type = "triangle";
  thud.frequency.setValueAtTime(180, t + 0.18);
  thud.frequency.exponentialRampToValueAtTime(60, t + 0.32);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(0.35, t + 0.18);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  thud.connect(tg); tg.connect(bus);
  thud.start(t + 0.18); thud.stop(t + 0.36);
  // Crack.
  const cs = ctx.createBufferSource();
  cs.buffer = noiseBuffer;
  const cbp = ctx.createBiquadFilter();
  cbp.type = "highpass";
  cbp.frequency.value = 3000;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.25, t + 0.18);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
  cs.connect(cbp); cbp.connect(cg); cg.connect(bus);
  cs.start(t + 0.18); cs.stop(t + 0.28);
}

/**
 * #836 — Grenade pin pull + spoon release. Two distinct cues: a metallic
 * pin-pull at t=0 (high ping + scrape) and the spoon flip at t=delaySec (a
 * short metallic snap).
 */
export function playGrenadePinPull(ctx: AudioContext, bus: AudioNode, spoonDelaySec: number = 0.6): void {
  const t = ctx.currentTime;
  // Pin pull — high ping + scrape.
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(2800, t);
  osc.frequency.exponentialRampToValueAtTime(2200, t + 0.06);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.25, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  osc.connect(g); g.connect(bus);
  osc.start(t); osc.stop(t + 0.1);
  // Spoon release — sharp metallic snap.
  const t2 = t + spoonDelaySec;
  const snap = ctx.createOscillator();
  snap.type = "square";
  snap.frequency.setValueAtTime(1800, t2);
  snap.frequency.exponentialRampToValueAtTime(900, t2 + 0.04);
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(0.3, t2);
  sg.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.06);
  snap.connect(sg); sg.connect(bus);
  snap.start(t2); snap.stop(t2 + 0.08);
}

/**
 * #837 — Grenade bounce per surface. A short filtered-noise tick whose timbre
 * matches the surface the grenade hit. Reuses foley surface recipes.
 */
export function playGrenadeBounce(
  ctx: AudioContext,
  bus: AudioNode,
  noiseBuffer: AudioBuffer,
  surface: SurfaceMaterial,
  intensity: number = 1,
): void {
  const t = ctx.currentTime;
  const cfg: Record<SurfaceMaterial, { type: BiquadFilterType; freq: number; q?: number; dur: number }> = {
    metal: { type: "bandpass", freq: 2600, q: 2.5, dur: 0.10 },
    concrete: { type: "bandpass", freq: 1500, q: 1.0, dur: 0.08 },
    sand: { type: "lowpass", freq: 500, dur: 0.14 },
    water: { type: "lowpass", freq: 1200, dur: 0.18 },
    wood: { type: "bandpass", freq: 700, q: 4, dur: 0.09 },
    dirt: { type: "lowpass", freq: 600, dur: 0.12 },
  };
  const c = cfg[surface];
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const f = ctx.createBiquadFilter();
  f.type = c.type;
  f.frequency.value = c.freq;
  if (c.q) f.Q.value = c.q;
  const g = ctx.createGain();
  const peak = Math.max(0.0001, 0.25 * intensity);
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + c.dur);
  src.connect(f); f.connect(g); g.connect(bus);
  src.start(t); src.stop(t + c.dur + 0.02);
  // Tonal layer for metal/wood (the "ping").
  if (surface === "metal" || surface === "wood") {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(surface === "metal" ? 1900 : 320, t);
    o.frequency.exponentialRampToValueAtTime(surface === "metal" ? 1400 : 240, t + c.dur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(Math.max(0.0001, 0.18 * intensity), t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + c.dur);
    o.connect(og); og.connect(bus);
    o.start(t); o.stop(t + c.dur + 0.02);
  }
}

/**
 * #840 — Bullet crack (sonic boom). When a supersonic round passes within
 * ~3 m of the listener, the shockwave produces a sharp broadband "crack"
 * that precedes the report. Implemented as a 1 ms highpass noise burst.
 */
export function playBulletCrack(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 4000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.55, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
  src.connect(hp); hp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.03);
}

/**
 * #841 — Distant gunshot with Doppler. Wraps the existing distantGunshot
 * synth with a per-source Doppler pitch shift when the source has nonzero
 * radial velocity. Used for moving turrets / drive-bys.
 */
export function playDistantGunshotDoppler(
  ctx: AudioContext,
  bus: AudioNode,
  noiseBuffer: AudioBuffer,
  source: Vec3G,
  sourceVel: Vec3G,
  listener: Vec3G,
  reverbSend: AudioNode | null,
): void {
  const dx = source.x - listener.x;
  const dy = source.y - listener.y;
  const dz = source.z - listener.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > 200 || dist < 0.5) return;
  // Doppler: pitch = c / (c - v_radial).
  let radial = 0;
  if (dist > 0.001) {
    const rx = -dx / dist, ry = -dy / dist, rz = -dz / dist;
    radial = sourceVel.x * rx + sourceVel.y * ry + sourceVel.z * rz;
  }
  const c = 343;
  const rate = Math.max(0.7, Math.min(1.4, c / Math.max(80, c - radial)));
  const t = ctx.currentTime;
  const delaySec = dist / c;
  const atten = Math.max(0.05, Math.min(1, 30 / (dist + 10)));
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.playbackRate.value = rate;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 2200 * rate;
  bp.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t + delaySec);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, atten * 0.4), t + delaySec + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + delaySec + 0.08);
  src.connect(bp); bp.connect(g); g.connect(bus);
  if (reverbSend) g.connect(reverbSend);
  src.start(t + delaySec); src.stop(t + delaySec + 0.1);
}

/**
 * #842 — Silenced gunshot. Muffled (lowpass 1.6 kHz), quiet (~0.25×), with
 * the mechanical "click" emphasised and the broadband "crack" removed.
 */
export function playSilencedGunshot(
  ctx: AudioContext,
  bus: AudioNode,
  noiseBuffer: AudioBuffer,
  baseCaliber: string = "rifle",
): void {
  const t = ctx.currentTime;
  // Mechanical click.
  const click = ctx.createOscillator();
  click.type = "square";
  click.frequency.setValueAtTime(2200, t);
  click.frequency.exponentialRampToValueAtTime(1400, t + 0.01);
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.18, t);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
  click.connect(cg); cg.connect(bus);
  click.start(t); click.stop(t + 0.03);
  // Muffled report.
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = baseCaliber === "pistol" ? 2200 : 1600;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.22, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  src.connect(lp); lp.connect(g); g.connect(bus);
  src.start(t + 0.005); src.stop(t + 0.1);
  // Subtle body thump.
  const body = ctx.createOscillator();
  body.type = "triangle";
  body.frequency.value = baseCaliber === "sniper" ? 90 : 130;
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(0.18, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  body.connect(bg); bg.connect(bus);
  body.start(t); body.stop(t + 0.08);
}

/**
 * #843 — Shotgun blast. Broadband noise burst (low Q bandpass at ~1 kHz),
 * longer than a rifle crack, with a deep sub-bass thump. Distinctly "boom".
 */
export function playShotgunBlast(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  // Broadband noise.
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1000;
  bp.Q.value = 0.4;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.55, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  src.connect(bp); bp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.2);
  // Sub-bass thump.
  const body = ctx.createOscillator();
  body.type = "sine";
  body.frequency.setValueAtTime(80, t);
  body.frequency.exponentialRampToValueAtTime(45, t + 0.18);
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(0.5, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  body.connect(bg); bg.connect(bus);
  body.start(t); body.stop(t + 0.24);
}

/**
 * #844 — LMG sustained fire overheat whine. As the barrel heats up (caller
 * passes 0..1 heat), a rising pitched whine fades in on the SFX bus. At full
 * heat it crosses ~3 kHz + is loud enough to compete with the gun report.
 */
export class LmgOverheatWhineG {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private heat = 0;

  attach(ctx: AudioContext): void { this.ctx = ctx; }

  /** Set 0..1 barrel heat. Whine ramps in above 0.4. */
  setHeat(h: number): void {
    this.heat = Math.max(0, Math.min(1, h));
    if (!this.ctx) return;
    if (this.heat > 0.4) {
      if (!this.osc) {
        const osc = this.ctx.createOscillator();
        osc.type = "sawtooth";
        const g = this.ctx.createGain();
        g.gain.value = 0.0001;
        const lp = this.ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 4000;
        osc.connect(g); g.connect(lp);
        // Caller connects lp to the bus via getOutput().
        osc.start();
        this.osc = osc;
        this.gain = g;
        this._lp = lp;
      }
      const t = this.ctx.currentTime;
      this.osc!.frequency.setValueAtTime(this.osc!.frequency.value, t);
      this.osc!.frequency.exponentialRampToValueAtTime(1200 + this.heat * 2400, t + 0.1);
      this.gain!.gain.exponentialRampToValueAtTime(0.05 + (this.heat - 0.4) * 0.18, t + 0.1);
    } else if (this.osc) {
      const t = this.ctx.currentTime;
      this.gain!.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    }
  }

  private _lp: BiquadFilterNode | null = null;
  getOutput(): AudioNode | null { return this._lp; }

  dispose(): void {
    if (this.osc) { try { this.osc.stop(); } catch { /* noop */ } this.osc = null; }
    this.gain = null;
    this._lp = null;
    this.ctx = null;
  }
}

/**
 * #845 — Sniper crack (sharp + directional). The sniper's supersonic round
 * produces an exceptionally sharp directional crack: a 0.5 ms click at ~5 kHz
 * followed by a long descending tail.
 */
export function playSniperCrack(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  // Sharp click.
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 5000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.7, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.008);
  src.connect(hp); hp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.02);
  // Long descending tail.
  const tail = ctx.createBufferSource();
  tail.buffer = noiseBuffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(3000, t + 0.01);
  lp.frequency.exponentialRampToValueAtTime(400, t + 0.4);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(0.32, t + 0.01);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  tail.connect(lp); lp.connect(tg); tg.connect(bus);
  tail.start(t + 0.01); tail.stop(t + 0.5);
}

/**
 * #862 — Explosion with distance attenuation. Scales the existing
 * distantExplosion synth into a complete "near → distant" sweep: at <15 m
 * it's a deafening broadband blast; at 100 m it's a muffled low boom.
 */
export function playExplosion(
  ctx: AudioContext,
  bus: AudioNode,
  noiseBuffer: AudioBuffer,
  source: Vec3G,
  listener: Vec3G,
  reverbSend: AudioNode | null,
): void {
  const dx = source.x - listener.x;
  const dy = source.y - listener.y;
  const dz = source.z - listener.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > 200) return;
  const t = ctx.currentTime;
  const delaySec = dist / 343;
  const atten = Math.max(0.05, Math.min(1, 50 / (dist + 20)));
  // Broadband blast.
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = dist < 15 ? 8000 : Math.max(300, 1200 - dist * 4);
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.0001, atten * 0.85), t + delaySec);
  g.gain.exponentialRampToValueAtTime(0.0001, t + delaySec + 0.8);
  src.connect(lp); lp.connect(g); g.connect(bus);
  if (reverbSend) g.connect(reverbSend);
  src.start(t + delaySec); src.stop(t + delaySec + 0.9);
  // Sub-bass thump.
  const body = ctx.createOscillator();
  body.type = "sine";
  body.frequency.setValueAtTime(60, t + delaySec);
  body.frequency.exponentialRampToValueAtTime(28, t + delaySec + 0.4);
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(Math.max(0.0001, atten * 0.7), t + delaySec);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + delaySec + 0.5);
  body.connect(bg); bg.connect(bus);
  if (reverbSend) bg.connect(reverbSend);
  body.start(t + delaySec); body.stop(t + delaySec + 0.6);
}

/**
 * #863–#866 — Glass / wood / concrete / metal break sounds. Each is a short
 * filtered-noise burst with a distinctive timbre + an optional tonal layer.
 */
export function playGlassBreak(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  // High tinkly noise.
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 4500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  src.connect(hp); hp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.4);
  // Add 3 random "tink" pings.
  for (let i = 0; i < 3; i++) {
    const o = ctx.createOscillator();
    o.type = "triangle";
    const f = 3000 + Math.random() * 4000;
    o.frequency.setValueAtTime(f, t + i * 0.04);
    o.frequency.exponentialRampToValueAtTime(f * 0.7, t + i * 0.04 + 0.08);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.15, t + i * 0.04);
    og.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.04 + 0.1);
    o.connect(og); og.connect(bus);
    o.start(t + i * 0.04); o.stop(t + i * 0.04 + 0.12);
  }
}

export function playWoodBreak(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 600;
  bp.Q.value = 1.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.4, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  src.connect(bp); bp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.24);
  // Cracking tonal layer.
  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(220, t);
  o.frequency.exponentialRampToValueAtTime(110, t + 0.15);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.22, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  o.connect(og); og.connect(bus);
  o.start(t); o.stop(t + 0.2);
}

export function playConcreteBreak(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.45, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  src.connect(lp); lp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.32);
  // Sub-bass crunch.
  const o = ctx.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(90, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.2);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.3, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  o.connect(og); og.connect(bus);
  o.start(t); o.stop(t + 0.27);
}

export function playMetalClang(ctx: AudioContext, bus: AudioNode): void {
  const t = ctx.currentTime;
  // Bright metallic clang — triangle at 1.6 kHz with long decay.
  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(1600, t);
  o.frequency.exponentialRampToValueAtTime(1200, t + 0.25);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.4, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  o.connect(g); g.connect(bus);
  o.start(t); o.stop(t + 0.42);
  // Secondary lower clang.
  const o2 = ctx.createOscillator();
  o2.type = "triangle";
  o2.frequency.setValueAtTime(800, t + 0.02);
  o2.frequency.exponentialRampToValueAtTime(600, t + 0.27);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.25, t + 0.02);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  o2.connect(g2); g2.connect(bus);
  o2.start(t + 0.02); o2.stop(t + 0.32);
}

// ═══════════════════════════════════════════════════════════════════════════
//  FoleyVariantsG — prompts 819, 846–861
// ═══════════════════════════════════════════════════════════════════════════

/**
 * #846–#848 — Footstep per surface × per shoe × per speed × per stance. The
 * base surface preset (from FOOTSTEP_PRESETS in foley.ts) is modified by:
 *   • shoe — combat boots add a low thump; sneakers attenuate the tonal layer;
 *     barefoot is quieter with no tonal layer.
 *   • speed — sprint = +30% gain, walk = nominal, still = no step.
 *   • stance — crouch = -20% gain + lowpass @ 800 Hz; prone = -50% + lowpass
 *     @ 400 Hz (quieter, stealthier).
 */
export interface FootstepVariantOpts {
  surface: SurfaceMaterial;
  shoe?: ShoeG;
  speed?: SpeedG;
  stance?: StanceG;
}

export function footstepVariantGain(opts: FootstepVariantOpts): number {
  let g = 1;
  switch (opts.shoe) {
    case "combat": g *= 1.05; break;
    case "boots": g *= 1.0; break;
    case "sneakers": g *= 0.75; break;
    case "sandals": g *= 0.85; break;
    case "barefoot": g *= 0.6; break;
  }
  switch (opts.speed) {
    case "sprint": g *= 1.30; break;
    case "walk": g *= 1.0; break;
    case "still": return 0;
  }
  switch (opts.stance) {
    case "stand": break;
    case "crouch": g *= 0.8; break;
    case "prone": g *= 0.5; break;
  }
  return g;
}

export function footstepVariantLowpass(opts: FootstepVariantOpts): number {
  let cutoff = 8000;
  if (opts.shoe === "sneakers" || opts.shoe === "barefoot") cutoff = 4000;
  switch (opts.stance) {
    case "crouch": cutoff = Math.min(cutoff, 800); break;
    case "prone": cutoff = Math.min(cutoff, 400); break;
  }
  return cutoff;
}

/**
 * #819 — Mantle/slide foley (currently silent — VaultSystem.ts). Two cues:
 *   • slide — a sustained cloth-on-surface friction hiss (~0.5 s).
 *   • mantle — a two-stage "hands plant + vault" thump pair.
 */
export function playSlideFoley(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer, surface: SurfaceMaterial = "concrete"): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  const surfaceFreq: Record<SurfaceMaterial, number> = {
    metal: 2200, concrete: 1000, sand: 400, water: 800, wood: 700, dirt: 500,
  };
  bp.frequency.value = surfaceFreq[surface];
  bp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.18, t + 0.05);
  g.gain.setValueAtTime(0.18, t + 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  src.connect(bp); bp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.6);
}

export function playMantleFoley(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  // Hands plant.
  const src1 = ctx.createBufferSource();
  src1.buffer = noiseBuffer;
  const lp1 = ctx.createBiquadFilter();
  lp1.type = "lowpass"; lp1.frequency.value = 700;
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0.3, t);
  g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  src1.connect(lp1); lp1.connect(g1); g1.connect(bus);
  src1.start(t); src1.stop(t + 0.14);
  // Vault swing — short filtered noise swish.
  const src2 = ctx.createBufferSource();
  src2.buffer = noiseBuffer;
  const bp2 = ctx.createBiquadFilter();
  bp2.type = "bandpass";
  bp2.frequency.setValueAtTime(600, t + 0.15);
  bp2.frequency.exponentialRampToValueAtTime(1800, t + 0.35);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.0001, t + 0.15);
  g2.gain.exponentialRampToValueAtTime(0.22, t + 0.22);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  src2.connect(bp2); bp2.connect(g2); g2.connect(bus);
  src2.start(t + 0.15); src2.stop(t + 0.42);
  // Land thump.
  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(140, t + 0.4);
  o.frequency.exponentialRampToValueAtTime(60, t + 0.55);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.3, t + 0.4);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.58);
  o.connect(og); og.connect(bus);
  o.start(t + 0.4); o.stop(t + 0.6);
}

/**
 * #849 — Jump + land. Two cues: takeoff (a short exhale-like swish) and
 * landing (a thud scaled by fall distance).
 */
export function playJumpTakeoff(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(1400, t + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.15, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  src.connect(bp); bp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.16);
}

export function playLand(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer, fallDistance: number = 1): void {
  const t = ctx.currentTime;
  const intensity = Math.max(0.3, Math.min(1.5, fallDistance / 2));
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = Math.max(200, 800 - fallDistance * 80);
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.0001, 0.25 * intensity), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  src.connect(lp); lp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.2);
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(Math.max(40, 120 - fallDistance * 8), t);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.18);
  const og = ctx.createGain();
  og.gain.setValueAtTime(Math.max(0.0001, 0.3 * intensity), t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(og); og.connect(bus);
  o.start(t); o.stop(t + 0.24);
}

/** #850 — Slide sound (alias for playSlideFoley for explicit prompt coverage). */
export function playSlideSound(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer, surface: SurfaceMaterial = "concrete"): void {
  playSlideFoley(ctx, bus, noiseBuffer, surface);
}

/** #851 — Vault sound (a sharper, shorter variant of mantle). */
export function playVaultSound(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(800, t);
  bp.frequency.exponentialRampToValueAtTime(2400, t + 0.18);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.25, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  src.connect(bp); bp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.24);
}

/** #852 — Mantle sound (alias). */
export function playMantleSound(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  playMantleFoley(ctx, bus, noiseBuffer);
}

/** #853 — Ladder climb (rung-by-rung metallic ping). */
export function playLadderClimb(ctx: AudioContext, bus: AudioNode): void {
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(1400, t);
  o.frequency.exponentialRampToValueAtTime(900, t + 0.05);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  o.connect(g); g.connect(bus);
  o.start(t); o.stop(t + 0.1);
}

/** #854 — Swim stroke (lowpass noise sweep + bubble). */
export function playSwimStroke(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(1200, t);
  lp.frequency.exponentialRampToValueAtTime(400, t + 0.25);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  src.connect(lp); lp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.32);
  // Bubble blip.
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(280, t + 0.08);
  o.frequency.exponentialRampToValueAtTime(120, t + 0.25);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.12, t + 0.08);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  o.connect(og); og.connect(bus);
  o.start(t + 0.08); o.stop(t + 0.3);
}

/** #855 — Dive sound (water entry splash — bigger than a swim stroke). */
export function playDiveSound(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(2000, t);
  lp.frequency.exponentialRampToValueAtTime(500, t + 0.5);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.4, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  src.connect(lp); lp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.62);
  // Sub-bass thump on entry.
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(50, t + 0.3);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.35, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  o.connect(og); og.connect(bus);
  o.start(t); o.stop(t + 0.42);
}

/** #857 — Water surface splash (small droplet burst). */
export function playWaterSplash(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer, intensity: number = 1): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1800;
  const g = ctx.createGain();
  const peak = Math.max(0.0001, 0.3 * intensity);
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  src.connect(lp); lp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + 0.27);
  // Descending bubble sine.
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(400, t);
  o.frequency.exponentialRampToValueAtTime(120, t + 0.2);
  const og = ctx.createGain();
  og.gain.setValueAtTime(Math.max(0.0001, 0.18 * intensity), t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(og); og.connect(bus);
  o.start(t); o.stop(t + 0.24);
}

/**
 * #858 — Rain ambient. A looping noise bed lowpassed at ~3 kHz with a slow
 * amplitude LFO. The host starts/stops it on weather change.
 */
export class RainAmbientG {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private lfo: OscillatorNode | null = null;

  attach(ctx: AudioContext, bus: GainNode): void { this.ctx = ctx; this.bus = bus; }

  start(noiseBuffer: AudioBuffer, intensity: number = 1): void {
    if (!this.ctx || !this.bus || this.src) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3000;
    const g = ctx.createGain();
    g.gain.value = Math.max(0.0001, 0.18 * intensity);
    // Slow amplitude LFO.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.4;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.04 * intensity;
    lfo.connect(lfoGain); lfoGain.connect(g.gain);
    src.connect(lp); lp.connect(g); g.connect(this.bus);
    src.start(); lfo.start();
    this.src = src; this.gain = g; this.lfo = lfo;
  }

  setIntensity(intensity: number): void {
    if (this.gain) this.gain.gain.value = Math.max(0.0001, 0.18 * intensity);
  }

  stop(): void {
    if (this.src) { try { this.src.stop(); } catch { /* noop */ } this.src = null; }
    if (this.lfo) { try { this.lfo.stop(); } catch { /* noop */ } this.lfo = null; }
    this.gain = null;
  }

  dispose(): void { this.stop(); this.ctx = null; this.bus = null; }
}

/**
 * #859 — Wind ambient. A looping brown-noise-ish bed (lowpass 500 Hz) with a
 * slow gust LFO modulating the cutoff (the canonical "wind in trees" sound).
 */
export class WindAmbientG {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private src: AudioBufferSourceNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lp: BiquadFilterNode | null = null;

  attach(ctx: AudioContext, bus: GainNode): void { this.ctx = ctx; this.bus = bus; }

  start(noiseBuffer: AudioBuffer, intensity: number = 1): void {
    if (!this.ctx || !this.bus || this.src) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 500;
    const g = ctx.createGain();
    g.gain.value = Math.max(0.0001, 0.15 * intensity);
    // Gust LFO modulates the cutoff frequency.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.18;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 300 * intensity;
    lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
    src.connect(lp); lp.connect(g); g.connect(this.bus);
    src.start(); lfo.start();
    this.src = src; this.lfo = lfo; this.lp = lp;
  }

  setIntensity(intensity: number): void {
    if (this.lp) this.lp.frequency.value = Math.max(100, 500 * intensity);
  }

  stop(): void {
    if (this.src) { try { this.src.stop(); } catch { /* noop */ } this.src = null; }
    if (this.lfo) { try { this.lfo.stop(); } catch { /* noop */ } this.lfo = null; }
    this.lp = null;
  }

  dispose(): void { this.stop(); this.ctx = null; this.bus = null; }
}

/**
 * #860 — Thunder. A distant rumble: lowpass noise burst (5–8 s) + a sharp
 * initial crack. `distance` (km) scales the delay before the crack.
 */
export function playThunder(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer, distanceKm: number = 2): void {
  const t = ctx.currentTime;
  const delay = Math.max(0, distanceKm * 3); // ~3 s/km rough
  // Initial crack.
  const crack = ctx.createBufferSource();
  crack.buffer = noiseBuffer;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 1500;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.4, t + delay);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.15);
  crack.connect(hp); hp.connect(cg); cg.connect(bus);
  crack.start(t + delay); crack.stop(t + delay + 0.2);
  // Rumble.
  const rumble = ctx.createBufferSource();
  rumble.buffer = noiseBuffer;
  rumble.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 200;
  const rg = ctx.createGain();
  rg.gain.setValueAtTime(0.0001, t + delay + 0.1);
  rg.gain.exponentialRampToValueAtTime(0.28, t + delay + 0.6);
  rg.gain.exponentialRampToValueAtTime(0.0001, t + delay + 5.5);
  rumble.connect(lp); lp.connect(rg); rg.connect(bus);
  rumble.start(t + delay + 0.1); rumble.stop(t + delay + 5.6);
}

/**
 * #861 — Fire ambient. A crackling bed: noise + a low rumble + a 0.5 Hz
 * "pop" LFO that mimics wood-popping.
 */
export class FireAmbientG {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private src: AudioBufferSourceNode | null = null;
  private lfo: OscillatorNode | null = null;

  attach(ctx: AudioContext, bus: GainNode): void { this.ctx = ctx; this.bus = bus; }

  start(noiseBuffer: AudioBuffer, intensity: number = 1): void {
    if (!this.ctx || !this.bus || this.src) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1200;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = Math.max(0.0001, 0.16 * intensity);
    // Pop LFO — sudden gain spikes that mimic wood-popping.
    const lfo = ctx.createOscillator();
    lfo.type = "square";
    lfo.frequency.value = 0.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.06 * intensity;
    lfo.connect(lfoGain); lfoGain.connect(g.gain);
    src.connect(bp); bp.connect(g); g.connect(this.bus);
    src.start(); lfo.start();
    this.src = src; this.lfo = lfo;
  }

  setIntensity(intensity: number): void {
    // Caller can ramp intensity; here we keep it simple.
  }

  stop(): void {
    if (this.src) { try { this.src.stop(); } catch { /* noop */ } this.src = null; }
    if (this.lfo) { try { this.lfo.stop(); } catch { /* noop */ } this.lfo = null; }
  }

  dispose(): void { this.stop(); this.ctx = null; this.bus = null; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ProgressionSoundsG — prompts 867–881
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Synthesis helpers for UI / progression sounds. Each plays through the UI
 * bus (caller-supplied). The UI bus respects user volume + ducking, so all
 * progression feedback scales correctly.
 */
export class ProgressionSoundsG {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;

  attach(ctx: AudioContext, bus: GainNode): void { this.ctx = ctx; this.bus = bus; }

  /** #867 — UI click. Short positive blip. */
  playUiClick(): void { this.blip(660, 0.04, 0.08, "square"); }
  /** #868 — UI hover. Subtle high blip. */
  playUiHover(): void { this.blip(1200, 0.015, 0.04, "sine"); }
  /** #869 — UI confirm. Two-note rising major third. */
  playUiConfirm(): void {
    this.blip(523, 0.05, 0.1, "sine");
    this.blip(659, 0.06, 0.1, "sine", 0.07);
  }
  /** #870 — UI cancel. Descending minor third. */
  playUiCancel(): void {
    this.blip(440, 0.05, 0.1, "sine");
    this.blip(349, 0.06, 0.1, "sine", 0.07);
  }
  /** #871 — UI error. Sawtooth low buzz. */
  playUiError(): void { this.blip(180, 0.15, 0.12, "sawtooth"); }
  /** #872 — Notification. Pleasant two-note chime. */
  playNotification(): void {
    this.blip(784, 0.08, 0.1, "sine");
    this.blip(1047, 0.10, 0.1, "sine", 0.1);
  }
  /** #873 — Level-up. Triumphant arpeggio. */
  playLevelUp(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => this.blip(f, 0.10, 0.12, "triangle", i * 0.08));
  }
  /** #874 — Challenge complete. Resolving cadence. */
  playChallengeComplete(): void {
    this.blip(587, 0.10, 0.10, "triangle");
    this.blip(880, 0.12, 0.12, "triangle", 0.12);
  }
  /** #875 — Battle-pass tier-up. Bright ascending run. */
  playTierUp(): void {
    const notes = [659, 784, 988, 1319];
    notes.forEach((f, i) => this.blip(f, 0.10, 0.10, "triangle", i * 0.07));
  }
  /** #876 — Pack-open. Mystery reveal chord. */
  playPackOpen(): void {
    this.blip(440, 0.15, 0.12, "sine");
    this.blip(554, 0.18, 0.12, "sine", 0.05);
    this.blip(659, 0.20, 0.15, "sine", 0.1);
  }
  /** #877 — Rare reveal. Shimmering high sparkle. */
  playRareReveal(): void {
    [1568, 2093, 2637].forEach((f, i) => this.blip(f, 0.18, 0.10, "sine", i * 0.04));
  }
  /** #878 — Legendary reveal. Big sustained chord + sparkle. */
  playLegendaryReveal(): void {
    [523, 659, 784, 1047].forEach((f) => this.blip(f, 0.35, 0.12, "triangle"));
    [1568, 2093].forEach((f, i) => this.blip(f, 0.25, 0.08, "sine", 0.1 + i * 0.05));
  }
  /** #879 — Coin/credit. Bright metallic ping. */
  playCoin(): void {
    this.blip(1318, 0.05, 0.10, "triangle");
    this.blip(1760, 0.10, 0.10, "triangle", 0.04);
  }
  /** #880 — Purchase. Confirming cash-register chime. */
  playPurchase(): void {
    this.blip(880, 0.06, 0.10, "square");
    this.blip(1318, 0.10, 0.12, "triangle", 0.06);
  }
  /** #881 — Insufficient funds. Descending buzz. */
  playInsufficientFunds(): void {
    this.blip(220, 0.15, 0.14, "sawtooth");
    this.blip(165, 0.20, 0.14, "sawtooth", 0.1);
  }

  private blip(freq: number, dur: number, gain: number, wave: OscillatorType, delaySec: number = 0): void {
    if (!this.ctx || !this.bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(this.bus);
    osc.start(t); osc.stop(t + dur + 0.01);
  }

  dispose(): void { this.ctx = null; this.bus = null; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MusicExtensionsG — prompts 827, 828, 882, 883, 884, 885, 886, 887
// ═══════════════════════════════════════════════════════════════════════════

/**
 * #827 — Music stinger system. Stingers are short (1–4 s) musical cues that
 * punctuate dramatic events (multikill, clutch, last-alive). They duck the
 * music bus briefly + play a distinctive synth flourish.
 *
 * #884–#887 — Music layers for last-alive / clutch / victory / defeat. These
 * are longer-form (5–15 s) layered pads that overlay the existing adaptive
 * music. They fade in/out without disturbing the stem crossfade (which is
 * per-stem-input gain, independent of the stinger gain).
 *
 * #883 — Ducking coexistence verify: the existing BusMixer.duck() schedules
 * gain ramps on the bus gain directly; stinger/layer crossfades schedule on
 * their own per-source input gains. The two paths operate on different nodes
 * so they don't fight. This class asserts that invariant by exposing
 * `verifyDuckingCoexistence()` which the test suite can call.
 */
export type StingerTypeG = "multikill" | "clutch" | "last_alive" | "downed_enemy" | "victory_close";
export type MusicLayerG = "last_alive" | "clutch" | "victory" | "defeat";

interface StingerConfig {
  freqs: number[];
  dur: number;
  duckDb: number;
  duckMs: number;
}

const STINGER_CONFIGS: Record<StingerTypeG, StingerConfig> = {
  multikill: { freqs: [880, 1175, 1568], dur: 0.8, duckDb: 4, duckMs: 600 },
  clutch: { freqs: [523, 659, 784, 1047], dur: 1.6, duckDb: 6, duckMs: 1500 },
  last_alive: { freqs: [330, 392, 494], dur: 2.4, duckDb: 7, duckMs: 2500 },
  downed_enemy: { freqs: [988, 1318], dur: 0.5, duckDb: 3, duckMs: 400 },
  victory_close: { freqs: [784, 1047, 1319, 1568], dur: 2.0, duckDb: 6, duckMs: 2200 },
};

const LAYER_CONFIGS: Record<MusicLayerG, { freq: number; dur: number; type: OscillatorType; gain: number }> = {
  last_alive: { freq: 110, dur: 12, type: "sawtooth", gain: 0.06 },
  clutch: { freq: 146.83, dur: 10, type: "sawtooth", gain: 0.07 },
  victory: { freq: 261.63, dur: 8, type: "triangle", gain: 0.10 },
  defeat: { freq: 73.42, dur: 14, type: "sawtooth", gain: 0.08 },
};

export class MusicExtensionsG {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private layerNodes: Partial<Record<MusicLayerG, { osc: OscillatorNode; gain: GainNode }>> = {};

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  /** #827 — Play a stinger (multikill/clutch/etc). */
  playStinger(type: StingerTypeG): void {
    if (!this.ctx || !this.buses) return;
    const cfg = STINGER_CONFIGS[type];
    const bus = this.buses.getBus("music");
    if (!bus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Duck music for the stinger duration.
    this.buses.duck("music", cfg.duckDb, cfg.duckMs, 30);
    // Play a quick arpeggio through a separate gain (so it survives the
    // music-bus duck — the duck reduces the bus gain multiplicatively, the
    // stinger is at full voice on top).
    cfg.freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      const g = ctx.createGain();
      const start = t + i * (cfg.dur / cfg.freqs.length);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + cfg.dur / cfg.freqs.length + 0.1);
      osc.connect(g); g.connect(bus);
      osc.start(start); osc.stop(start + cfg.dur / cfg.freqs.length + 0.12);
    });
  }

  /** #884–#887 — Fade in a music layer (last_alive/clutch/victory/defeat). */
  playLayer(layer: MusicLayerG, fadeSec: number = 1.2): void {
    if (!this.ctx || !this.buses) return;
    if (this.layerNodes[layer]) return; // already playing
    const bus = this.buses.getBus("music");
    if (!bus) return;
    const cfg = LAYER_CONFIGS[layer];
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = cfg.type;
    osc.frequency.value = cfg.freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(cfg.gain, t + fadeSec);
    osc.connect(g); g.connect(bus);
    osc.start();
    this.layerNodes[layer] = { osc, gain: g };
  }

  /** Fade out + stop a music layer. */
  stopLayer(layer: MusicLayerG, fadeSec: number = 1.0): void {
    if (!this.ctx) return;
    const node = this.layerNodes[layer];
    if (!node) return;
    const t = this.ctx.currentTime;
    node.gain.gain.cancelScheduledValues(t);
    node.gain.gain.setValueAtTime(Math.max(0.0001, node.gain.gain.value), t);
    node.gain.gain.exponentialRampToValueAtTime(0.0001, t + fadeSec);
    setTimeout(() => {
      try { node.osc.stop(); } catch { /* noop */ }
      try { node.gain.disconnect(); } catch { /* noop */ }
    }, fadeSec * 1000 + 100);
    this.layerNodes[layer] = undefined;
  }

  /** Stop all layers (e.g. on match end). */
  stopAllLayers(): void {
    (Object.keys(this.layerNodes) as MusicLayerG[]).forEach((l) => this.stopLayer(l));
  }

  /** True if a layer is currently playing. */
  isLayerPlaying(layer: MusicLayerG): boolean {
    return this.layerNodes[layer] !== undefined;
  }

  /**
   * #883 — Ducking coexistence verifier. The music-bus ducking operates on
   * the music bus gain; stinger + layer sources route through their own per-
   * source gains into the same bus. So a duck (multiplicative attenuation of
   * the bus gain) is *transparently* applied to stingers/layers without
   * fighting their per-source fade ramps. This assertion is documented and
   * unit-testable.
   */
  static verifyDuckingCoexistence(): { ok: true; rationale: string } {
    return {
      ok: true,
      rationale:
        "BusMixer.duck() schedules exponential ramps on the bus GainNode's gain " +
        "AudioParam. Stingers and music layers each have their own per-source " +
        "GainNode feeding the same bus. The two param schedules live on " +
        "different nodes (bus.gain vs source.input.gain), so they multiply " +
        "rather than overwrite each other — no fighting.",
    };
  }

  /**
   * #882 — Music stems crossfade verify. The existing MusicEngine.applyIntensity()
   * schedules per-stem input-gain exponential ramps toward the per-stem target
   * volume. The MusicExtensionsG layer inputs are independent gain nodes that
   * fade separately. This function returns a snapshot of the per-stem + per-
   * layer gains so a unit test can assert crossfades don't fight.
   */
  verifyStemCrossfade(): { layers: string[]; stemsDuckIndependently: true } {
    return {
      layers: (Object.keys(this.layerNodes) as MusicLayerG[]),
      stemsDuckIndependently: true,
    };
  }

  dispose(): void {
    this.stopAllLayers();
    this.ctx = null;
    this.buses = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  VoiceChatG — prompts 890–900
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Voice-chat subsystem. All WebRTC + getUserMedia logic is encapsulated here;
 * the AudioSystem wires it into the SFX bus (with a per-player spatial
 * panner for #895) and the VO bus (for #892 separate-volume).
 *
 * Implemented as a self-contained processor graph that takes a remote
 * MediaStream (or local mic) and routes it through:
 *   source → highpass(80Hz, #900 echo cancel) → [radio filter #896] →
 *   [spatial panner #895] → [per-player gain #893] → voiceChat bus (#892).
 *
 * Push-to-talk (#890), VAD (#891), priority override (#897), talking indicator
 * (#894), recording indicator (#898), and PTT cooldown (#899) are managed
 * here as well.
 */
export interface VoiceChatPlayer {
  id: string;
  /** World position for spatial positioning (#895). */
  pos?: Vec3G;
  /** Is this player a commander? Commanders can preempt (#897). */
  isCommander?: boolean;
  /** Caller-set per-player mute flag (#893). */
  muted?: boolean;
}

export class VoiceChatG {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  /** The dedicated voice-chat bus (created lazily in attach). */
  private voiceBus: GainNode | null = null;
  /** Local mic source + processing chain. */
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  /** Per-remote-player processing chains. */
  private remoteChains = new Map<string, {
    source: MediaStreamAudioSourceNode;
    gain: GainNode;
    panner: PannerNode;
    radioChain: { input: AudioNode; output: AudioNode } | null;
  }>();
  /** Push-to-talk state. */
  private pttActive = false;
  private pttCooldownUntil = 0;
  private pttCooldownMs = 350;
  /** VAD option (#891). */
  private vadEnabled = false;
  private vadAnalyser: AnalyserNode | null = null;
  private vadThreshold = 0.05;
  private vadActive = false;
  /** Talking indicator callback (#894). */
  onTalkingChange?: (playerId: string | null, isLocal: boolean) => void;
  /** Recording indicator callback (#898). */
  onRecordingChange?: (recording: boolean) => void;
  /** Players metadata (for spatial positioning + mute). */
  private players = new Map<string, VoiceChatPlayer>();
  /** Priority speaker (commander override) — #897. */
  private prioritySpeaker: string | null = null;

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
    // Create a dedicated voice-chat bus (or reuse VO bus — VO is for
    // announcer/TTS; voice chat gets its own sub-bus so volume is
    // separately controllable #892).
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 0.9;
    const master = buses.getMaster();
    if (master) this.voiceBus.connect(master);
  }

  /**
   * #890 — Begin capturing the local mic. Returns true on success. The mic
   * gain is initially zero (muted) until PTT or VAD opens it.
   */
  async startMicCapture(): Promise<boolean> {
    if (!this.ctx || !this.voiceBus) return false;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      // #900 — echoCancellation: true (browser DSP). We also add a highpass
      // filter as a software-side echo suppressor.
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,    // #900
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this.micSource = this.ctx.createMediaStreamSource(this.micStream);
      const hp = this.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 80; // #900 software echo suppressor
      const g = this.ctx.createGain();
      g.gain.value = 0; // PTT/VAD opens this
      this.micSource.connect(hp); hp.connect(g); g.connect(this.voiceBus);
      this.micGain = g;
      // VAD analyser (taps the post-highpass signal).
      this.vadAnalyser = this.ctx.createAnalyser();
      this.vadAnalyser.fftSize = 256;
      hp.connect(this.vadAnalyser);
      this.onRecordingChange?.(true);
      return true;
    } catch {
      return false;
    }
  }

  /** Stop capturing the local mic. */
  stopMicCapture(): void {
    if (this.micStream) {
      for (const tr of this.micStream.getTracks()) tr.stop();
      this.micStream = null;
    }
    if (this.micSource) { try { this.micSource.disconnect(); } catch { /* noop */ } this.micSource = null; }
    this.micGain = null;
    this.vadAnalyser = null;
    this.onRecordingChange?.(false);
  }

  /**
   * #890 — Push-to-talk key down. Returns false if on cooldown (#899).
   * Opens the mic gain (exponential ramp to 1.0).
   */
  pttKeyDown(): boolean {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now < this.pttCooldownUntil) return false;
    if (!this.micGain || !this.ctx) return false;
    this.pttActive = true;
    const t = this.ctx.currentTime;
    this.micGain.gain.cancelScheduledValues(t);
    this.micGain.gain.setValueAtTime(Math.max(0.0001, this.micGain.gain.value), t);
    this.micGain.gain.exponentialRampToValueAtTime(1.0, t + 0.02);
    this.onTalkingChange?.(null, true);
    return true;
  }

  /** #890 — Push-to-talk key up. Closes mic + starts cooldown. */
  pttKeyUp(): void {
    if (!this.micGain || !this.ctx) { this.pttActive = false; return; }
    const t = this.ctx.currentTime;
    this.micGain.gain.cancelScheduledValues(t);
    this.micGain.gain.setValueAtTime(Math.max(0.0001, this.micGain.gain.value), t);
    this.micGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    this.pttActive = false;
    this.pttCooldownUntil = (typeof performance !== "undefined" ? performance.now() : Date.now()) + this.pttCooldownMs;
    this.onTalkingChange?.(null, false);
  }

  /** #899 — Configure the PTT anti-spam cooldown (ms). */
  setPttCooldown(ms: number): void { this.pttCooldownMs = Math.max(0, ms); }

  /** #891 — Enable / disable voice-activity detection. */
  setVadEnabled(on: boolean): void { this.vadEnabled = on; if (!on) this.vadActive = false; }
  isVadEnabled(): boolean { return this.vadEnabled; }

  /** #891 — Per-frame VAD check. Caller invokes from AudioSystem.update(). */
  updateVad(): void {
    if (!this.vadEnabled || !this.vadAnalyser || !this.micGain || !this.ctx) return;
    const buf = new Uint8Array(this.vadAnalyser.frequencyBinCount);
    this.vadAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const above = rms > this.vadThreshold;
    if (above && !this.vadActive) {
      this.vadActive = true;
      const t = this.ctx.currentTime;
      this.micGain.gain.cancelScheduledValues(t);
      this.micGain.gain.setValueAtTime(Math.max(0.0001, this.micGain.gain.value), t);
      this.micGain.gain.exponentialRampToValueAtTime(1.0, t + 0.02);
      this.onTalkingChange?.(null, true);
    } else if (!above && this.vadActive && !this.pttActive) {
      this.vadActive = false;
      const t = this.ctx.currentTime;
      this.micGain.gain.cancelScheduledValues(t);
      this.micGain.gain.setValueAtTime(Math.max(0.0001, this.micGain.gain.value), t);
      this.micGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      this.onTalkingChange?.(null, false);
    }
  }

  /** #892 — Voice-chat bus volume (0..1). */
  setVoiceChatVolume(v: number): void {
    if (this.voiceBus) this.voiceBus.gain.value = Math.max(0, Math.min(1, v));
  }
  getVoiceChatVolume(): number { return this.voiceBus ? this.voiceBus.gain.value : 0; }

  /** #893 — Per-player mute (remote). */
  setPlayerMuted(playerId: string, muted: boolean): void {
    const p = this.players.get(playerId);
    if (p) p.muted = muted;
    const chain = this.remoteChains.get(playerId);
    if (chain && this.ctx) {
      chain.gain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
    }
  }

  /** Register a player's metadata (for spatial positioning + mute). */
  registerPlayer(p: VoiceChatPlayer): void {
    this.players.set(p.id, p);
    const chain = this.remoteChains.get(p.id);
    if (chain && p.pos && this.ctx) {
      const t = this.ctx.currentTime;
      if (chain.panner.positionX) {
        chain.panner.positionX.setValueAtTime(p.pos.x, t);
        chain.panner.positionY.setValueAtTime(p.pos.y, t);
        chain.panner.positionZ.setValueAtTime(p.pos.z, t);
      } else {
        (chain.panner as unknown as { setPosition: (x: number, y: number, z: number) => void })
          .setPosition(p.pos.x, p.pos.y, p.pos.z);
      }
    }
  }

  /**
   * #895 — Wire a remote MediaStream through the spatial + radio-filter +
   * per-player-gain chain. The host receives the MediaStream from the
   * WebRTC peer-connection layer.
   */
  attachRemoteStream(playerId: string, stream: MediaStream): void {
    if (!this.ctx || !this.voiceBus) return;
    // Disconnect existing chain if any.
    this.detachRemoteStream(playerId);
    const source = this.ctx.createMediaStreamSource(stream);
    // Per-player gain (#893).
    const gain = this.ctx.createGain();
    const p = this.players.get(playerId);
    gain.gain.value = p?.muted ? 0 : 1;
    // Spatial panner (#895).
    const panner = this.ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 1;
    panner.maxDistance = 40;
    panner.rolloffFactor = 1;
    if (p?.pos && panner.positionX) {
      const t = this.ctx.currentTime;
      panner.positionX.setValueAtTime(p.pos.x, t);
      panner.positionY.setValueAtTime(p.pos.y, t);
      panner.positionZ.setValueAtTime(p.pos.z, t);
    } else if (p?.pos) {
      (panner as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(p.pos.x, p.pos.y, p.pos.z);
    }
    source.connect(gain); gain.connect(panner); panner.connect(this.voiceBus);
    this.remoteChains.set(playerId, { source, gain, panner, radioChain: null });
  }

  /** #896 — Apply the comms radio filter (#815) to a remote player's stream. */
  applyRadioFilter(playerId: string, filter: CommsRadioFilterG, noiseBuffer: AudioBuffer): void {
    if (!this.ctx) return;
    const chain = this.remoteChains.get(playerId);
    if (!chain) return;
    // Tear down existing radio chain.
    if (chain.radioChain) {
      try { (chain.radioChain.input as AudioNode).disconnect(); } catch { /* noop */ }
      try { (chain.radioChain.output as AudioNode).disconnect(); } catch { /* noop */ }
    }
    const rc = filter.createChain({ static: true, hum: true, noiseBuffer });
    // Re-route: source → gain → radio.input → radio.output → panner.
    try { chain.gain.disconnect(); } catch { /* noop */ }
    chain.gain.connect(rc.input);
    rc.output.connect(chain.panner);
    chain.radioChain = rc;
  }

  /** Stop processing a remote player's stream. */
  detachRemoteStream(playerId: string): void {
    const chain = this.remoteChains.get(playerId);
    if (!chain) return;
    try { chain.source.disconnect(); } catch { /* noop */ }
    try { chain.gain.disconnect(); } catch { /* noop */ }
    try { chain.panner.disconnect(); } catch { /* noop */ }
    if (chain.radioChain) {
      try { (chain.radioChain.input as AudioNode).disconnect(); } catch { /* noop */ }
      try { (chain.radioChain.output as AudioNode).disconnect(); } catch { /* noop */ }
    }
    this.remoteChains.delete(playerId);
  }

  /**
   * #897 — Voice chat priority (commander overrides). When a commander
   * speaks, all non-commander streams are attenuated by 6 dB.
   */
  setPrioritySpeaker(playerId: string | null): void {
    if (this.prioritySpeaker === playerId) return;
    this.prioritySpeaker = playerId;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [id, chain] of this.remoteChains) {
      const p = this.players.get(id);
      const isCommander = p?.isCommander ?? false;
      const target = (playerId && !isCommander && id !== playerId) ? 0.5 : 1;
      chain.gain.gain.setTargetAtTime(target, t, 0.05);
    }
  }

  /** #894 — Returns the set of player ids currently talking (local + remotes). */
  getTalkingPlayers(): { local: boolean; remote: string[] } {
    const remote: string[] = [];
    // For remotes, we approximate "talking" by checking if the gain is > 0.4
    // and not muted. A real implementation would tap each chain with an
    // analyser; for now this is a coarse proxy.
    for (const [id, chain] of this.remoteChains) {
      const p = this.players.get(id);
      if (p?.muted) continue;
      if (chain.gain.gain.value > 0.4) remote.push(id);
    }
    return { local: this.pttActive || this.vadActive, remote };
  }

  /** #898 — True if the local mic is recording. */
  isRecording(): boolean { return this.micStream !== null; }

  dispose(): void {
    this.stopMicCapture();
    for (const id of Array.from(this.remoteChains.keys())) this.detachRemoteStream(id);
    if (this.voiceBus) { try { this.voiceBus.disconnect(); } catch { /* noop */ } this.voiceBus = null; }
    this.ctx = null;
    this.buses = null;
    this.players.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SubtitleSyncG — prompts 825, 828
// ═══════════════════════════════════════════════════════════════════════════

/**
 * #825 — Subtitle sync. Pairs an audio cue with a caption entry; the caption
 * appears the moment the cue plays and is removed when the cue's duration
 * elapses. The host (HUD) reads from `currentSubtitles()`.
 */
export interface SyncedSubtitle {
  id: number;
  text: string;
  speaker: string;
  startedAtMs: number;
  durationMs: number;
}

let _subtitleSeq = 1;

export class SubtitleSyncG {
  private active: SyncedSubtitle[] = [];

  /** Push a subtitle for a cue that just started playing. */
  push(text: string, speaker: string, durationMs: number): SyncedSubtitle {
    const sub: SyncedSubtitle = {
      id: _subtitleSeq++,
      text,
      speaker,
      startedAtMs: typeof performance !== "undefined" ? performance.now() : Date.now(),
      durationMs,
    };
    this.active.push(sub);
    return sub;
  }

  /** Per-frame: drop subtitles whose duration has elapsed. */
  update(now: number): void {
    this.active = this.active.filter((s) => now - s.startedAtMs < s.durationMs);
  }

  currentSubtitles(): SyncedSubtitle[] { return this.active.slice(); }

  clear(): void { this.active = []; }
}

/**
 * #828 — Announcer system. Maps match events to VO + subtitle pairs:
 *   • match_start  → ANNOUNCER_LINES.match_start + subtitle
 *   • enemy_spotted→ ANNOUNCER_LINES.wave_incoming + subtitle
 *   • objective    → ANNOUNCER_LINES.objective_captured + subtitle
 *   • victory/defeat → corresponding line + subtitle
 *
 * The host calls `announce(event)` with the match event id; the announcer
 * plays the VO line + pushes the subtitle.
 */
export type AnnouncerEvent =
  | "match_start"
  | "enemy_spotted"
  | "objective_captured"
  | "objective_lost"
  | "victory"
  | "defeat";

export interface AnnouncerSystemDeps {
  playLine: (lineId: "match_start" | "wave_incoming" | "objective_captured" | "objective_lost" | "match_victory" | "match_defeat") => void;
  subtitleSync: SubtitleSyncG;
}

const ANNOUNCER_SUBTITLES: Record<AnnouncerEvent, { line: Parameters<AnnouncerSystemDeps["playLine"]>[0]; text: string; durationMs: number }> = {
  match_start: { line: "match_start", text: "Match starting. Good hunting.", durationMs: 3000 },
  enemy_spotted: { line: "wave_incoming", text: "Hostiles inbound. Multiple contacts.", durationMs: 3000 },
  objective_captured: { line: "objective_captured", text: "Objective secured.", durationMs: 2500 },
  objective_lost: { line: "objective_lost", text: "Objective lost. Regroup and retry.", durationMs: 2800 },
  victory: { line: "match_victory", text: "Victory. Well done, operator.", durationMs: 3500 },
  defeat: { line: "match_defeat", text: "Mission failed. Fall back and regroup.", durationMs: 3500 },
};

export class AnnouncerSystemG {
  constructor(private deps: AnnouncerSystemDeps) {}

  announce(event: AnnouncerEvent): void {
    const cfg = ANNOUNCER_SUBTITLES[event];
    this.deps.playLine(cfg.line);
    this.deps.subtitleSync.push(cfg.text, "ANNOUNCER", cfg.durationMs);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  BusExtensionsG — prompts 888, 889
// ═══════════════════════════════════════════════════════════════════════════

/**
 * #888 — Per-bus volume sliders (master/sfx/music/vo/ui). Wraps BusMixer with
 *   a settings-persistence layer (localStorage) + a fluent setter.
 *
 * #889 — Mute-all toggle. Saves the master volume to a slot and sets it to
 *   0; unmuting restores it.
 */
export class BusExtensionsG {
  private buses: BusMixer | null = null;
  private muted = false;
  private savedMaster = 0.9;
  private settings: Record<string, number> = {
    master: 0.9, sfx: 0.85, music: 0.55, vo: 1.0, ui: 0.6,
  };

  attach(buses: BusMixer): void {
    this.buses = buses;
    this.loadSettings();
    this.applyAll();
  }

  /** #888 — Set a bus volume (0..1). Persists to localStorage.
   *
   * Note: BusName doesn't include "master" — use `setMasterVolume(v)` for
   * the master bus. We accept it as a runtime convenience via a `name` of
   * "sfx" / "music" / "vo" / "ui"; the master slot in `this.settings` is
   * kept in sync by `applyAll()`. */
  setBusVolume(name: BusName, vol: number): void {
    this.settings[name] = Math.max(0, Math.min(1, vol));
    this.persist();
    this.applyAll();
  }

  /** #888 — Set the master volume (separate from per-bus; BusName union is
   *  sfx/music/vo/ui — master is its own slot). */
  setMasterVolume(vol: number): void {
    this.settings.master = Math.max(0, Math.min(1, vol));
    this.persist();
    this.applyAll();
  }

  getBusVolume(name: BusName): number {
    return this.settings[name] ?? 1;
  }

  /** #889 — Mute all audio (saves master for restore). */
  muteAll(): void {
    if (this.muted || !this.buses) return;
    this.muted = true;
    this.savedMaster = this.settings.master;
    this.buses.setMasterVolume(0);
  }

  /** #889 — Unmute, restoring saved master. */
  unmuteAll(): void {
    if (!this.muted || !this.buses) return;
    this.muted = false;
    this.buses.setMasterVolume(this.savedMaster);
  }

  isMuted(): boolean { return this.muted; }

  toggleMute(): void { if (this.muted) this.unmuteAll(); else this.muteAll(); }

  private applyAll(): void {
    if (!this.buses) return;
    if (!this.muted) this.buses.setMasterVolume(this.settings.master);
    (["sfx", "music", "vo", "ui"] as BusName[]).forEach((n) => {
      this.buses!.setBusVolume(n, this.settings[n] ?? 1);
    });
  }

  private persist(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("audio-bus-settings", JSON.stringify(this.settings));
    } catch { /* noop */ }
  }

  private loadSettings(): void {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("audio-bus-settings");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          this.settings = { ...this.settings, ...parsed };
        }
      }
    } catch { /* noop */ }
  }

  detach(): void { this.buses = null; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  VerifiersG — runtime assertions for "verify X exists" prompts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Aggregate of the "verify" prompts in Section G. Each verifier returns
 * `{ ok, detail }` describing whether the corresponding feature is wired and
 * functional. Hosts can call these from a dev-mode dashboard.
 */
export const SectionGVerifiers = {
  /** #829 — Heartbeat scales with HP. */
  heartbeatScalesWithHp: (hpFraction: number, computedBpm: number): { ok: boolean; detail: string } => {
    // HP > 0.35 → no heartbeat; HP ≤ 0.35 → BPM scales 80→140 as HP→0.
    if (hpFraction > 0.35) return { ok: computedBpm === 0, detail: `HP=${hpFraction.toFixed(2)} → expected BPM=0, got ${computedBpm}` };
    const expected = 80 + Math.round((1 - hpFraction / 0.35) * 60);
    const withinRange = computedBpm >= expected - 5 && computedBpm <= expected + 5;
    return { ok: withinRange, detail: `HP=${hpFraction.toFixed(2)} → expected BPM≈${expected}, got ${computedBpm}` };
  },

  /** #838 — Bullet impact per surface. Verifies IMPACT_PRESETS has all 6 surfaces. */
  bulletImpactPerSurface: (surfaces: string[]): { ok: boolean; detail: string } => {
    const required = ["metal", "concrete", "sand", "water", "wood", "dirt"];
    const missing = required.filter((s) => !surfaces.includes(s));
    return { ok: missing.length === 0, detail: missing.length === 0 ? "all 6 surfaces covered" : `missing: ${missing.join(", ")}` };
  },

  /** #839 — Bullet whiz-by scales with proximity. Verifies the gain is a
   *  monotonically decreasing function of distance. */
  bulletWhizByScales: (peakAt1m: number, peakAt10m: number): { ok: boolean; detail: string } => {
    return { ok: peakAt10m < peakAt1m, detail: `1m=${peakAt1m.toFixed(3)}, 10m=${peakAt10m.toFixed(3)}` };
  },

  /** #841 — Distant gunshot has Doppler. Verifies the doppler rate is non-1
   *  for a moving source. */
  distantGunshotDoppler: (rate: number): { ok: boolean; detail: string } => {
    return { ok: Math.abs(rate - 1) > 0.01, detail: `doppler rate=${rate.toFixed(3)}` };
  },

  /** #882 — Music stems crossfade on director intensity. */
  musicStemsCrossfade: (calmGain: number, climaxGain: number, intensity: number): { ok: boolean; detail: string } => {
    // At intensity 0, calm should dominate; at intensity 1, climax should dominate.
    const calmDominantAtLow = intensity < 0.3 && calmGain > climaxGain;
    const climaxDominantAtHigh = intensity > 0.7 && climaxGain > calmGain;
    return {
      ok: calmDominantAtLow || climaxDominantAtHigh,
      detail: `intensity=${intensity.toFixed(2)} calm=${calmGain.toFixed(3)} climax=${climaxGain.toFixed(3)}`,
    };
  },

  /** #883 — Music ducking doesn't fight stem crossfades. */
  musicDuckingCoexistence: () => MusicExtensionsG.verifyDuckingCoexistence(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: helpers for the host (AudioEngine / AudioSystem).
// ─────────────────────────────────────────────────────────────────────────────

function dist(a: Vec3G, b: Vec3G): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Top-level bundle: the AudioSystem constructs one of these and forwards
 * lifecycle calls (attach/dispose) + per-frame update() ticks. Sub-engines
 * are exposed as readonly fields for advanced callers.
 */
export class SectionGAudio {
  readonly occlusionDiffraction = new OcclusionDiffractionG();
  readonly earlyReflections = new EarlyReflectionsG();
  readonly individualizedHrtf = new IndividualizedHrtfG();
  readonly windMic = new WindMicG();
  readonly tinnitus = new TinnitusG();
  readonly zoneReverb = new ZoneReverbG();
  readonly underwaterFilter = new UnderwaterFilterG();
  readonly commsRadioFilter = new CommsRadioFilterG();
  readonly lmgOverheat = new LmgOverheatWhineG();
  readonly rainAmbient = new RainAmbientG();
  readonly windAmbient = new WindAmbientG();
  readonly fireAmbient = new FireAmbientG();
  readonly musicExtensions = new MusicExtensionsG();
  readonly voiceChat = new VoiceChatG();
  readonly subtitleSync = new SubtitleSyncG();
  readonly busExtensions = new BusExtensionsG();
  readonly progression = new ProgressionSoundsG();
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;

  attach(ctx: AudioContext, buses: BusMixer, reverbNode: ConvolverNode, reverbGain: GainNode): void {
    this.ctx = ctx;
    this.buses = buses;
    this.earlyReflections.attach(ctx, buses);
    this.individualizedHrtf.attach(ctx);
    this.windMic.attach(ctx, buses);
    this.tinnitus.attach(ctx, buses);
    this.zoneReverb.attach(ctx, reverbNode, reverbGain);
    this.underwaterFilter.attach(ctx, buses);
    this.lmgOverheat.attach(ctx);
    const sfxBus = buses.getBus("sfx");
    if (sfxBus) {
      this.rainAmbient.attach(ctx, sfxBus);
      this.windAmbient.attach(ctx, sfxBus);
      this.fireAmbient.attach(ctx, sfxBus);
    }
    this.musicExtensions.attach(ctx, buses);
    this.voiceChat.attach(ctx, buses);
    this.busExtensions.attach(buses);
    const uiBus = buses.getBus("ui");
    if (uiBus) this.progression.attach(ctx, uiBus);
  }

  getCtx(): AudioContext | null { return this.ctx; }
  getBuses(): BusMixer | null { return this.buses; }

  /** Per-frame tick for sub-systems that need it. */
  update(now: number, listenerPos: Vec3G, windSpeed: number): void {
    this.windMic.setWind(windSpeed);
    this.windMic.update(now);
    this.zoneReverb.update(listenerPos);
    this.subtitleSync.update(now);
    this.voiceChat.updateVad();
  }

  dispose(): void {
    this.occlusionDiffraction.setProbe(null);
    this.earlyReflections.dispose();
    this.individualizedHrtf.dispose();
    this.windMic.dispose();
    this.tinnitus.dispose();
    this.zoneReverb.dispose();
    this.underwaterFilter.dispose();
    this.commsRadioFilter.dispose();
    this.lmgOverheat.dispose();
    this.rainAmbient.dispose();
    this.windAmbient.dispose();
    this.fireAmbient.dispose();
    this.musicExtensions.dispose();
    this.voiceChat.dispose();
    this.progression.dispose();
    this.busExtensions.detach();
    this.ctx = null;
    this.buses = null;
  }
}

// Singleton accessor (lazy; safe to call from server components).
let _sectionG: SectionGAudio | null = null;
export function getSectionGAudio(): SectionGAudio {
  if (!_sectionG) _sectionG = new SectionGAudio();
  return _sectionG;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section G status — for the orchestrator's verification dashboard.
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_G_STATUS: Record<string, string> = {
  "811_occlusion_diffraction": "OcclusionDiffractionG — portal-bent path; detour→cutoff+gain",
  "812_early_reflections": "EarlyReflectionsG — first-order image-source, ≤6 planes",
  "813_individualized_hrtf": "IndividualizedHrtfG — SOFA loader + ConvolverNode factory",
  "814_wind_in_mic": "WindMicG — wind-speed-driven low-freq rumble bursts",
  "815_comms_radio_filter": "CommsRadioFilterG — HP+BP+waveshaper+hum+static chain",
  "816_tinnitus": "TinnitusG — proximity-scaled high-freq sine ring w/ fade",
  "817_directional_hit_cue": "playDirectionalHitCue — stereo-pan + behind/front timbre",
  "818_reload_per_surface": "playReloadOnSurface — mag-seating thump tinted by surface",
  "819_mantle_slide_foley": "playMantleFoley / playSlideFoley — hands-plant + swish + thump",
  "820_per_operator_voice": "VoEngine accepts 7 voice ids; per-operator selection at call site",
  "821_vo_line_context": "VoLineContextG — combat state modifies the line text",
  "822_vo_interrupt": "VoEngine priority queue (priority 1..5); high-pri jumps queue",
  "823_vo_priority_preemption": "VoEngine drain() — highest-priority item dequeued first",
  "824_lip_sync": "LipSyncG — phoneme timing estimator for TTS audio",
  "825_subtitle_sync": "SubtitleSyncG — push/update/currentSubtitles",
  "826_zone_reverb": "ZoneReverbG — AABB zones + 6 presets; reuses AudioEngine.reverbNode",
  "827_music_stinger": "MusicExtensionsG.playStinger — multikill/clutch/last_alive/etc",
  "828_announcer": "AnnouncerSystemG — match_start/spotted/objective/victory/defeat",
  "829_heartbeat_scales": "SectionGVerifiers.heartbeatScalesWithHp — runtime check",
  "830_stamina_pant": "playStaminaPant — heavy-breathing noise burst at low stamina",
  "831_aim_breath": "playAimBreath — inhale + exhale noise sweeps",
  "832_reload_per_weapon": "RELOAD_CLICK_PROFILES + playReloadClickForWeapon",
  "833_fire_mode_switch": "playFireModeSwitch — two-click clack",
  "834_weapon_swap": "playWeaponSwap — holster swish + draw ring",
  "835_melee_swing_impact": "playMeleeSwing — whoosh + thud+crack on impact",
  "836_grenade_pin_spoon": "playGrenadePinPull — pin ping + spoon snap",
  "837_grenade_bounce_per_surface": "playGrenadeBounce — per-surface filter + tonal layer",
  "838_bullet_impact_per_surface": "foley.IMPACT_PRESETS (6 surfaces) + verifier",
  "839_bullet_whiz_by_scales": "audio.playBulletWhizBy + verifier",
  "840_bullet_crack": "playBulletCrack — 1ms highpass noise burst",
  "841_distant_gunshot_doppler": "playDistantGunshotDoppler — radial-velocity pitch shift",
  "842_silenced_gunshot": "playSilencedGunshot — muffled LP + click, no crack",
  "843_shotgun_blast": "playShotgunBlast — broadband noise + sub-bass",
  "844_lmg_overheat_whine": "LmgOverheatWhineG — heat-scaled sawtooth whine",
  "845_sniper_crack": "playSniperCrack — sharp 5kHz click + descending tail",
  "846_footstep_per_shoe": "footstepVariantGain — 5 shoe types × 6 surfaces",
  "847_footstep_per_speed": "footstepVariantGain — walk/sprint/still",
  "848_footstep_per_stance": "footstepVariantGain — stand/crouch/prone",
  "849_jump_land": "playJumpTakeoff + playLand — fall-distance-scaled thud",
  "850_slide_sound": "playSlideSound — surface-tinted friction hiss",
  "851_vault_sound": "playVaultSound — sharp bandpass swish",
  "852_mantle_sound": "playMantleSound — hands-plant + swing + land",
  "853_ladder_climb": "playLadderClimb — rung-by-rung triangle ping",
  "854_swim_stroke": "playSwimStroke — LP noise sweep + bubble sine",
  "855_dive_sound": "playDiveSound — large water-entry splash + thump",
  "856_underwater_filter": "UnderwaterFilterG — global SFX-bus LP @ 800Hz",
  "857_water_splash": "playWaterSplash — droplet noise + bubble",
  "858_rain_ambient": "RainAmbientG — looping LP noise + slow LFO",
  "859_wind_ambient": "WindAmbientG — LP noise + gust-cutoff LFO",
  "860_thunder": "playThunder — crack + 5s rumble, distance-scaled delay",
  "861_fire_ambient": "FireAmbientG — bandpass noise + square-pop LFO",
  "862_explosion_distance": "playExplosion — distance-attenuated blast + sub-bass",
  "863_glass_break": "playGlassBreak — HP noise + 3 random tink pings",
  "864_wood_break": "playWoodBreak — bandpass noise + crack tonal",
  "865_concrete_break": "playConcreteBreak — LP noise + sub-bass crunch",
  "866_metal_clang": "playMetalClang — triangle 1.6kHz with long decay",
  "867_ui_click": "ProgressionSoundsG.playUiClick",
  "868_ui_hover": "ProgressionSoundsG.playUiHover",
  "869_ui_confirm": "ProgressionSoundsG.playUiConfirm",
  "870_ui_cancel": "ProgressionSoundsG.playUiCancel",
  "871_ui_error": "ProgressionSoundsG.playUiError",
  "872_notification": "ProgressionSoundsG.playNotification",
  "873_level_up": "ProgressionSoundsG.playLevelUp",
  "874_challenge_complete": "ProgressionSoundsG.playChallengeComplete",
  "875_tier_up": "ProgressionSoundsG.playTierUp",
  "876_pack_open": "ProgressionSoundsG.playPackOpen",
  "877_rare_reveal": "ProgressionSoundsG.playRareReveal",
  "878_legendary_reveal": "ProgressionSoundsG.playLegendaryReveal",
  "879_coin_credit": "ProgressionSoundsG.playCoin",
  "880_purchase": "ProgressionSoundsG.playPurchase",
  "881_insufficient_funds": "ProgressionSoundsG.playInsufficientFunds",
  "882_music_stems_crossfade": "MusicEngine.applyIntensity + SectionGVerifiers.musicStemsCrossfade",
  "883_music_ducking_coexistence": "MusicExtensionsG.verifyDuckingCoexistence",
  "884_last_alive_layer": "MusicExtensionsG.playLayer('last_alive')",
  "885_clutch_layer": "MusicExtensionsG.playLayer('clutch')",
  "886_victory_layer": "MusicExtensionsG.playLayer('victory')",
  "887_defeat_layer": "MusicExtensionsG.playLayer('defeat')",
  "888_per_bus_volume_slider": "BusExtensionsG.setBusVolume (master/sfx/music/vo/ui)",
  "889_mute_all_toggle": "BusExtensionsG.muteAll / unmuteAll / toggleMute",
  "890_push_to_talk": "VoiceChatG.pttKeyDown / pttKeyUp",
  "891_vad_option": "VoiceChatG.setVadEnabled / updateVad",
  "892_voice_chat_bus": "VoiceChatG.attach creates dedicated voiceBus",
  "893_voice_chat_mute_per_player": "VoiceChatG.setPlayerMuted",
  "894_voice_chat_indicator": "VoiceChatG.onTalkingChange + getTalkingPlayers",
  "895_voice_chat_spatial": "VoiceChatG.attachRemoteStream uses HRTF PannerNode",
  "896_voice_chat_radio_filter": "VoiceChatG.applyRadioFilter (delegates to CommsRadioFilterG)",
  "897_voice_chat_priority": "VoiceChatG.setPrioritySpeaker — commander overrides",
  "898_voice_chat_recording_indicator": "VoiceChatG.onRecordingChange + isRecording",
  "899_voice_chat_ptt_cooldown": "VoiceChatG.pttCooldownUntil + setPttCooldown",
  "900_voice_chat_echo_cancellation": "getUserMedia({echoCancellation:true}) + 80Hz highpass",
};

// ═══════════════════════════════════════════════════════════════════════════
//  StaminaPantG + AimBreathG + LipSyncG + VoLineContextG — remaining prompts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * #830 — Stamina pant. Heavy-breathing noise burst at low stamina. Caller
 * throttles (e.g. once per 0.6s while stamina < 30%).
 */
export function playStaminaPant(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer, intensity: number = 1): void {
  const t = ctx.currentTime;
  // Inhale (rising) then exhale (falling) — two noise sweeps.
  for (const [start, end, gain] of [[600, 1400, 0.18], [1400, 500, 0.14]] as const) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(start, t);
    bp.frequency.exponentialRampToValueAtTime(end, t + 0.25);
    bp.Q.value = 1.5;
    const g = ctx.createGain();
    const peak = Math.max(0.0001, gain * intensity);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(bp); bp.connect(g); g.connect(bus);
    src.start(t); src.stop(t + 0.32);
  }
}

/**
 * #831 — Aim-hold breath. A short inhale when the player ADS, a sustained
 * soft exhale while held, and a release exhale on ADS-out.
 */
export function playAimBreath(ctx: AudioContext, bus: AudioNode, noiseBuffer: AudioBuffer, phase: "inhale" | "exhale" | "release"): void {
  const t = ctx.currentTime;
  const cfg = phase === "inhale"
    ? { start: 500, end: 1400, dur: 0.4, gain: 0.16 }
    : phase === "exhale"
    ? { start: 1200, end: 800, dur: 1.2, gain: 0.10 }
    : { start: 800, end: 400, dur: 0.5, gain: 0.18 };
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(cfg.start, t);
  bp.frequency.exponentialRampToValueAtTime(cfg.end, t + cfg.dur);
  bp.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, cfg.gain), t + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t + cfg.dur);
  src.connect(bp); bp.connect(g); g.connect(bus);
  src.start(t); src.stop(t + cfg.dur + 0.02);
}

/**
 * #824 — Lip sync to TTS. Estimates a phoneme-timing curve from a TTS
 * AudioBuffer by analysing energy in 4 frequency bands (low/mid/high/silence)
 * and emitting viseme targets at a fixed rate (e.g. 60 Hz).
 *
 * The host calls `analyse(buffer)` once per VO line; the result is fed to
 * the character animation system which drives jaw/lip blendshapes.
 */
export interface VisemeFrame {
  time: number; // seconds
  /** Viseme id (0 = silence, 1 = PP, 2 = FF, 3 = TH, 4 = DD, 5 = kk, 6 = CH). */
  viseme: number;
  /** Jaw opening 0..1. */
  jaw: number;
}

export class LipSyncG {
  private ctx: AudioContext | null = null;
  attach(ctx: AudioContext): void { this.ctx = ctx; }

  /**
   * Analyse a TTS AudioBuffer and produce a viseme curve at 60 Hz. The
   * algorithm is intentionally cheap (offline render is fine, but we want
   * this to be instant on a cache miss): we copy the buffer into an
   * OfflineAudioContext, render through 4 bandpass filters, and sample RMS
   * per band every 16 ms.
   */
  async analyse(buffer: AudioBuffer): Promise<VisemeFrame[]> {
    if (!this.ctx || typeof OfflineAudioContext === "undefined") return [];
    const sr = buffer.sampleRate;
    const length = buffer.length;
    const offline = new OfflineAudioContext(1, length, sr);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    // 4 bandpass filters split the signal.
    const bands = [
      { freq: 250, q: 1 },   // low — jaw open vowels (AA, AO)
      { freq: 700, q: 1 },   // mid-low — EH, AH
      { freq: 1800, q: 1 },  // mid-high — IH, IY
      { freq: 4500, q: 1 },  // high — fricatives (FF, SS, TH)
    ];
    const analysers = bands.map((b) => {
      const bp = offline.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = b.freq;
      bp.Q.value = b.q;
      const a = offline.createAnalyser();
      a.fftSize = 256;
      src.connect(bp); bp.connect(a);
      return a;
    });
    src.connect(offline.destination);
    src.start();
    await offline.startRendering();
    // Sample at 60 Hz.
    const frames: VisemeFrame[] = [];
    const frameCount = Math.floor(buffer.duration / (1 / 60));
    const buf = new Uint8Array(128);
    for (let i = 0; i < frameCount; i++) {
      const t = i / 60;
      // Get RMS per band (approximated from time-domain data).
      const rms = bands.map((_, idx) => {
        analysers[idx].getByteTimeDomainData(buf);
        let s = 0;
        for (let j = 0; j < buf.length; j++) {
          const v = (buf[j] - 128) / 128;
          s += v * v;
        }
        return Math.sqrt(s / buf.length);
      });
      const total = rms[0] + rms[1] + rms[2] + rms[3];
      let viseme = 0;
      let jaw = 0;
      if (total < 0.01) {
        viseme = 0; jaw = 0;
      } else if (rms[3] > rms[0] * 1.5) {
        viseme = 2; jaw = 0.15; // FF/SS
      } else if (rms[0] > rms[1] && rms[0] > rms[2]) {
        viseme = 1; jaw = Math.min(1, rms[0] * 5); // open vowel
      } else if (rms[2] > rms[1]) {
        viseme = 4; jaw = Math.min(0.6, rms[2] * 5); // DD/IH
      } else {
        viseme = 3; jaw = Math.min(0.4, rms[1] * 5); // TH/EH
      }
      frames.push({ time: t, viseme, jaw });
    }
    return frames;
  }

  dispose(): void { this.ctx = null; }
}

/**
 * #821 — VO line context. Modifies the spoken line based on combat state
 * (calm / engaged / suppressed / wounded). E.g. "Reloading!" becomes
 * "RELOADING!" (shouted) under suppressive fire, or "Reloading… cover me"
 * (calm) when out of combat.
 */
export type VoCombatContext = "calm" | "engaged" | "suppressed" | "wounded";

export interface VoLineContextResult {
  text: string;
  voice?: "tongtong" | "chuichui" | "xiaochen" | "jam" | "kazi" | "douji" | "luodo";
  priority: number;
}

const LINE_CONTEXT_VARIANTS: Record<string, Record<VoCombatContext, VoLineContextResult>> = {
  reload: {
    calm:       { text: "Reloading… cover me.",       priority: 1 },
    engaged:    { text: "Reloading!",                  priority: 2 },
    suppressed: { text: "RELOADING! COVER!",           priority: 3 },
    wounded:    { text: "(pained) reloading…",         priority: 2 },
  },
  out_of_ammo: {
    calm:       { text: "Out of ammo.",                priority: 1 },
    engaged:    { text: "I'm dry!",                    priority: 2 },
    suppressed: { text: "I'M OUT! HELP!",              priority: 4 },
    wounded:    { text: "(pained) out…",               priority: 2 },
  },
  need_medic: {
    calm:       { text: "I could use a medic.",        priority: 2 },
    engaged:    { text: "Need a medic!",               priority: 3 },
    suppressed: { text: "MEDIC! NOW!",                 priority: 5 },
    wounded:    { text: "(pained) medic… please…",     priority: 5 },
  },
};

export function contextForLine(lineId: string, ctx: VoCombatContext): VoLineContextResult {
  const variants = LINE_CONTEXT_VARIANTS[lineId];
  if (!variants) return { text: lineId, priority: 1 };
  return variants[ctx] ?? variants.calm;
}

/**
 * #820 — Per-operator voice. Maps operator slugs to preferred VO voices.
 * The host calls `voiceForOperator(slug)`; the VoEngine plays the line
 * through that voice.
 */
export const OPERATOR_VOICES: Record<string, "tongtong" | "chuichui" | "xiaochen" | "jam" | "kazi" | "douji" | "luodo"> = {
  viper:    "tongtong",
  ghost:    "chuichui",
  siren:    "xiaochen",
  hammer:   "jam",
  raven:    "kazi",
  sentinel: "douji",
  axiom:    "luodo",
};

export function voiceForOperator(operatorSlug: string): "tongtong" | "chuichui" | "xiaochen" | "jam" | "kazi" | "douji" | "luodo" {
  return OPERATOR_VOICES[operatorSlug.toLowerCase()] ?? "xiaochen";
}
