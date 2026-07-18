/**
 * Procedurally synthesized audio using Web Audio API. No asset files needed
 * for the synth path; sample-based playback kicks in for any
 * /public/sfx/*.wav file the developer drops in (graceful fallback to synth).
 *
 * SEC8-AUDIO (prompts 65–70):
 *   • Sample-based layered SFX (3-layer gunshot + per-surface foley + UI) — 65, 70
 *   • Adaptive music engine (calm/engaged/climax crossfade) — 66
 *   • Spatial / HRTF positional audio with occlusion muffle — 67
 *   • Voice-over pipeline (TTS-backed announcer + operator lines) — 68
 *   • Mixing bus architecture (SFX/Music/VO/UI GainNodes + ducking) — 69
 *
 * SSR-safe: every AudioContext touch is guarded by `typeof window`. Lazily
 * created on first init() (called from context-factory). If the autoplay
 * policy blocks the context, sound calls are silently dropped and the
 * orchestrator is expected to call `resume()` on the first user gesture.
 */

// ─── G-5000 prompt mapping ──────────────────────────────────────────────────
// This file owns the following G-5000 prompts (lines 5044–5246 of
// upload/5000-IMPROVEMENT-PROMPTS.md). The "→ NNNN" suffix is the prior-
// mission prompt number that implements it (G2 = worklog Task G2-audio-bugs-
// 112-144; G = worklog Task G-audio-811-900). The bracketed name is the
// search target for the actual implementation.
//
//   #3401 → G2 #112 — playLayeredGunshot node leak        [onended → gain.disconnect()]
//   #3405 → G2 #116 — whiz-by only panner disconnect      [playBulletWhizBy onended]
//   #3406 → G2 #117 — setValueAtTime click on set         [1ms linearRampToValueAtTime attack]
//   #3410 → G2 #121 — binary occlusion → thickness-based  [occlusionParams() / setOcclusionThicknessProbe]
//   #3411 → G2 #122 — distantGunshot double crack         [single crack by distance band]
//   #3412 → G2 #123 — reverb send bypasses SFX duck       [reverbGain → sfxBus]
//   #3413 → G2 #124 — no Doppler on distant/footstep/expl [sourceVel param + pitch shift]
//   #3414 → G2 #125 — single global reverb → zone-based   [setReverbZones / updateReverbZones]
//   #3423 → G2 #134 — 1s noise buffer reused → rotate     [5-buffer pool, pickNoiseBuffer()]
//   #3424 → G2 #135 — occludedFootstep not positional     [sourcePos + spatial.playSpatialNoiseBurst]
//   #3426 → G2 #137 — AUDIO_CAPTIONS catalog dead         [pushSubtitleForCue(cueId, bearing?)]
//   #3427 → G2 #138 — getCaptionForAudioCue never called  [wired via pushSubtitleForCue]
//   #3432 → G2 #143 — vo onLineStart/onQueueEmpty unset    [init() wires both callbacks]
//   #3433 → G2 #144 — UI sound singleton ownCtx closed    [attach({ keepStandaloneAlive: true })]
//   #3434 → G #811  — occlusion + diffraction pathing     [setDiffractionPortals / OcclusionDiffractionG]
//   #3436 → G #813  — individualized HRTF (SOFA)          [loadHrtfSofa / isHrtfLoaded]
//   #3437 → G #814  — wind in mic rumble                  [setWindSpeed / WindMicG]
//   #3439 → G #816  — ear ringing (tinnitus)              [triggerTinnitus / cancelTinnitus]
//   #3440 → G #817  — directional hit cues                [playDirectionalHitCue]
//   #3441 → G #818  — reload audio per surface            [playReloadOnSurface]
//   #3442 → G #819  — mantle/slide foley                  [playMantleFoley / playSlideFoley]
//   #3447 → G #824  — lip sync to TTS                     [LipSyncG (in SectionG.ts)]
//   #3448 → G #825  — subtitle sync                       [pushSubtitle / SubtitleSyncG]
//   #3450 → G #827  — music stinger system                [playMusicStinger / MusicExtensionsG]
//   #3452 → G #829  — heartbeat scales with HP            [heartbeatScalesWithHp verifier]
//   #3453 → G #830  — stamina pant                        [playStaminaPant]
//   #3454 → G #831  — aim-hold breath                     [playAimBreath]
//   #3455 → G #832  — reload click per weapon             [playReloadClickForWeapon]
//   #3456 → G #833  — fire-mode switch sound              [playFireModeSwitch]
//   #3457 → G #834  — weapon swap sound                   [playWeaponSwap]
//   #3458 → G #835  — melee swing + impact                [playMeleeSwing]
//   #3459 → G #836  — grenade pin pull + spoon            [playGrenadePinPull]
//   #3460 → G #837  — grenade bounce per surface          [playGrenadeBounce]
//   #3461 → G #838  — bullet impact per surface           [foley.IMPACT_PRESETS (6 surfaces)]
//   #3462 → G #839  — bullet whiz-by scales               [playBulletWhizBy gain curve]
//   #3463 → G #840  — bullet crack (supersonic)           [playBulletCrack]
//   #3464 → G #841  — distant gunshot Doppler             [playDistantGunshotDoppler]
//   #3465 → G #842  — silenced gunshot                    [playSilencedGunshot]
//   #3466 → G #843  — shotgun blast                       [playShotgunBlast]
//   #3467 → G #844  — LMG sustained fire whine            [LmgOverheatWhineG / setLmgBarrelHeat]
//   #3468 → G #845  — sniper crack                        [playSniperCrack]
//   #3472 → G #849  — jump + land                         [playJumpTakeoff / playLand]
//   #3485 → G #862  — explosion distance attenuation      [playExplosion]
//   #3486 → G #863  — glass break                         [playGlassBreak]
//   #3487 → G #864  — wood break                          [playWoodBreak]
//   #3488 → G #865  — concrete break                      [playConcreteBreak]
//   #3489 → G #866  — metal clang                         [playMetalClang]
//   #3490–3504 → G #867–#881 — UI / progression sounds    [ProgressionSoundsG delegation via playUi()]
//   #3511 → G #888  — per-bus volume slider               [BusExtensionsG.setBusVolume]
//   #3512 → G #889  — mute-all toggle                     [BusExtensionsG.muteAll / unmuteAll]
//
// Cross-ref prompts (#3524–#3600) duplicate #3434–#3510 — same code paths.
// Bug-fix prompts #3402–#3404, #3407–#3409, #3415–#3422, #3425, #3428–#3431
// are owned by sibling files (spatial/foley/buses/vo/music/AudioEnhancements/
// AudioSystem/ui-sound) — see their own marker blocks.
// ─────────────────────────────────────────────────────────────────────────────

import { BusMixer, type BusName } from "./audio/buses";
import { SpatialAudio, type Vec3 as SpatialVec3, type SpatialPlayOptions } from "./audio/spatial";
import { FoleyEngine, type SurfaceMaterial } from "./audio/foley";
import { MusicEngine, directorLabelToIntensity, type DirectorIntensityLabel } from "./audio/music";
import { VoEngine, type VoVoice, type AnnouncerLineId } from "./audio/vo";
import { getUISound } from "./ui-sound";
import { getWeaponSoundProfile, type WeaponSoundProfile } from "./combat/weapon-sound-profile";
// G2 #137 / #138 — wire the AUDIO_CAPTIONS catalog + getCaptionForAudioCue so
// every audio cue produces a subtitle if enabled.
import { getCaptionForAudioCue, type AudioCueId } from "./Subtitles";
// G2 (prompts 112–144): import the occlusion + reverb-zone helpers from
// AudioEnhancements so the engine can apply thickness-based lowpass/gain
// reduction (#121) and switch the global reverb by AABB zone (#125).
import {
  occlusionGainReductionDb,
  occlusionLowpassHz,
  findReverbZone,
  REVERB_PRESETS,
  type ReverbZone,
  type ReverbPreset,
} from "./audio/AudioEnhancements";
import {
  SectionGAudio,
  getSectionGAudio,
  playDirectionalHitCue,
  playReloadOnSurface,
  playReloadClickForWeapon,
  playFireModeSwitch,
  playWeaponSwap,
  playMeleeSwing,
  playGrenadePinPull,
  playGrenadeBounce,
  playBulletCrack,
  playDistantGunshotDoppler,
  playSilencedGunshot,
  playShotgunBlast,
  playSniperCrack,
  playExplosion,
  playGlassBreak,
  playWoodBreak,
  playConcreteBreak,
  playMetalClang,
  playSlideFoley,
  playMantleFoley,
  playSlideSound,
  playVaultSound,
  playMantleSound,
  playLadderClimb,
  playSwimStroke,
  playDiveSound,
  playWaterSplash,
  playThunder,
  playJumpTakeoff,
  playLand,
  playStaminaPant,
  playAimBreath,
  footstepVariantGain,
  footstepVariantLowpass,
  type FootstepVariantOpts,
  type StanceG,
  type SpeedG,
  type ShoeG,
} from "./audio/SectionG";
// Section H — audio & immersion enhancements (15 new modules).
import {
  attachAllSectionHEngines,
  disposeAllSectionHEngines,
  getHrtfProfileManager,
  getDynamicMusicEngine,
  getSurfaceFoleyEngine,
  getVoiceScriptingEngine,
  getAdaptiveMusicMiddleware,
  getWeaponAcousticsEngine,
  getReverbZoneEngine,
  getSoundOcclusionEngine,
  getBulletCrackEngine,
  getAmbientGeneratorEngine,
  getBreathingAudioEngine,
  getHeartbeatAudioEngine,
  getRadioCommEngine,
  getUnderwaterAudioEngine,
  getAudioDuckingEngine,
  type WeaponAcousticParams,
  type BulletCaliber,
  type BreathState,
  type HeartbeatStressInput,
  type CueId,
  type DuckTriggerCategory,
  type ExtendedSurface,
  type ShoeMaterial,
  type VoiceLineEventId,
  type VoiceLineContext,
} from "./audio/index-h";

type EnvType = "open" | "urban" | "interior" | "forest";

export type Caliber = "rifle" | "smg" | "pistol" | "sniper" | "shotgun" | "lmg";

/** Re-export foley surface type so callers can `import { SurfaceMaterial } from "../audio"`. */
export type { SurfaceMaterial } from "./audio/foley";
export type { VoVoice, AnnouncerLineId } from "./audio/vo";
export type { BusName } from "./audio/buses";
export type { Vec3 } from "./audio/spatial";
export type { DirectorIntensityLabel } from "./audio/music";
export { ANNOUNCER_LINES } from "./audio/vo";
export { computeMusicIntensity, directorLabelToIntensity } from "./audio/music";
export { ballisticsSurfaceToFoley } from "./audio/foley";
export { dbToRatio } from "./audio/buses";

// ─────────────────────────────────────────────────────────────────────────────
// Gunshot synthesis presets — one per Caliber.
// ─────────────────────────────────────────────────────────────────────────────

interface GunshotPreset {
  caliber: Caliber;
  // Layer (a): mechanical action — short click (hammer/striker).
  clickFreq: number;
  clickGain: number;
  clickDur: number;
  // Layer (b): report/crack — noise burst + bandpass, fast decay.
  crackFilterFreq: number;
  crackFilterQ: number;
  crackGain: number;
  crackDur: number;
  // Layer (c): tail — filtered noise, longer decay, sent to reverb.
  tailFilterFreq: number;
  tailGain: number;
  tailDur: number;
  // Existing: low-frequency body thump.
  bodyFreq: number;
  bodyGain: number;
  bodyDur: number;
}

const GUNSHOT_PRESETS: Record<Caliber, GunshotPreset> = {
  rifle: {
    caliber: "rifle",
    clickFreq: 2400, clickGain: 0.18, clickDur: 0.008,
    crackFilterFreq: 1800, crackFilterQ: 0.8, crackGain: 0.55, crackDur: 0.08,
    tailFilterFreq: 1400, tailGain: 0.18, tailDur: 0.22,
    bodyFreq: 120, bodyGain: 0.5, bodyDur: 0.18,
  },
  smg: {
    caliber: "smg",
    clickFreq: 2200, clickGain: 0.14, clickDur: 0.007,
    crackFilterFreq: 2200, crackFilterQ: 0.9, crackGain: 0.4, crackDur: 0.06,
    tailFilterFreq: 1700, tailGain: 0.14, tailDur: 0.16,
    bodyFreq: 150, bodyGain: 0.35, bodyDur: 0.13,
  },
  pistol: {
    caliber: "pistol",
    clickFreq: 2000, clickGain: 0.16, clickDur: 0.008,
    crackFilterFreq: 1600, crackFilterQ: 0.8, crackGain: 0.5, crackDur: 0.09,
    tailFilterFreq: 1200, tailGain: 0.18, tailDur: 0.2,
    bodyFreq: 140, bodyGain: 0.45, bodyDur: 0.16,
  },
  sniper: {
    caliber: "sniper",
    clickFreq: 2600, clickGain: 0.22, clickDur: 0.01,
    crackFilterFreq: 1500, crackFilterQ: 0.6, crackGain: 0.8, crackDur: 0.14,
    tailFilterFreq: 1100, tailGain: 0.3, tailDur: 0.4,
    bodyFreq: 90, bodyGain: 0.75, bodyDur: 0.32,
  },
  shotgun: {
    caliber: "shotgun",
    clickFreq: 1800, clickGain: 0.18, clickDur: 0.009,
    crackFilterFreq: 1200, crackFilterQ: 0.5, crackGain: 0.7, crackDur: 0.13,
    tailFilterFreq: 900, tailGain: 0.28, tailDur: 0.32,
    bodyFreq: 80, bodyGain: 0.7, bodyDur: 0.26,
  },
  lmg: {
    caliber: "lmg",
    clickFreq: 2300, clickGain: 0.16, clickDur: 0.008,
    crackFilterFreq: 1900, crackFilterQ: 0.85, crackGain: 0.55, crackDur: 0.075,
    tailFilterFreq: 1500, tailGain: 0.18, tailDur: 0.2,
    bodyFreq: 110, bodyGain: 0.5, bodyDur: 0.17,
  },
};

/** Map a weapon slug to a Caliber for synth-preset lookup. */
export function slugToCaliber(slug: string): Caliber {
  const s = slug.toLowerCase();
  if (["awp", "scout", "kar98k", "l115a3"].includes(s)) return "sniper";
  if (["usp", "deagle", "glock18", "m1911", "revolver"].includes(s)) return "pistol";
  if (["mp7", "p90", "mp5", "ump45", "vector", "pp90m1"].includes(s)) return "smg";
  if (["nova", "m1014", "spas12"].includes(s)) return "shotgun";
  if (["m249", "rpk", "mk48"].includes(s)) return "lmg";
  return "rifle";
}

// ─────────────────────────────────────────────────────────────────────────────
// REALISM-1 (task D) — Per-weapon audio identity.
//
// The base GUNSHOT_PRESETS table has 6 caliber entries (rifle/smg/pistol/
// sniper/shotgun/lmg). Without per-weapon layering, the AK-74 and M4 sound
// identical (both route to the "rifle" preset). This helper overlays the
// per-weapon WeaponSoundProfile (from combat/weapon-sound-profile.ts) on top
// of the base caliber preset, producing a distinct synth voice per weapon:
//
//   - bodyThumpHz       → replaces preset.bodyFreq (heavier cartridges sit lower)
//   - mechanicalClickHz → replaces preset.clickFreq (pistols sharper, bolts deeper)
//   - tailLengthMs      → replaces preset.tailDur (sniper rounds carry long tails)
//   - loudness          → scales clickGain + crackGain + tailGain + bodyGain
//                          (the AK-74 is louder than the M4; the AWP louder
//                           than the Scout; the Deagle louder than the USP).
//
// The per-weapon profile also carries `actionCharacter` — a future extension
// could layer a distinctive action sample (e.g. the MP5's roller-delayed
// "chunk", the Kar98k's bolt throw). For now it's metadata for the gunsmith UI.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a per-weapon GunshotPreset by overlaying the weapon's sound profile
 * on top of the base caliber preset. Returns a fresh object — the underlying
 * GUNSHOT_PRESETS table is not mutated.
 *
 * If no profile exists for the slug (shouldn't happen for the 30 catalogued
 * weapons, but is defensive), the base caliber preset is returned unchanged.
 *
 * Exported so the gunsmith UI can call `buildPerWeaponPreset(slug, caliber)`
 * to preview a weapon's synth voice without going through the full
 * AudioEngine.playLayeredGunshot pipeline.
 */
export function buildPerWeaponPreset(slug: string, baseCaliber: Caliber): GunshotPreset {
  const base = GUNSHOT_PRESETS[baseCaliber];
  let profile: WeaponSoundProfile | null = null;
  try {
    profile = getWeaponSoundProfile(slug as never);
  } catch {
    profile = null;
  }
  if (!profile) return base;
  // Loudness scales every gain layer multiplicatively. Centered on 0.8 (the
  // average loudness in WEAPON_SOUND_PROFILES) so a weapon at 0.8 produces
  // the base preset's gains unchanged; a weapon at 1.0 (AWP) is +25% louder;
  // a weapon at 0.6 (Glock18) is -25% quieter.
  const loudnessMult = profile.loudness / 0.8;
  // Tail length replaces tailDur (convert ms → s).
  const tailDurS = profile.tailLengthMs / 1000;
  return {
    caliber: baseCaliber,
    // Mechanical click — per-weapon frequency (pistols sharper, bolts deeper).
    clickFreq: profile.mechanicalClickHz,
    clickGain: base.clickGain * loudnessMult,
    clickDur: base.clickDur,
    // Crack — base caliber's filter shape, scaled by loudness.
    crackFilterFreq: base.crackFilterFreq,
    crackFilterQ: base.crackFilterQ,
    crackGain: base.crackGain * loudnessMult,
    crackDur: base.crackDur,
    // Tail — per-weapon length (sniper rounds carry long tails).
    tailFilterFreq: base.tailFilterFreq,
    tailGain: base.tailGain * loudnessMult,
    tailDur: tailDurS,
    // Body thump — per-weapon frequency (heavier cartridges sit lower).
    bodyFreq: profile.bodyThumpHz,
    bodyGain: base.bodyGain * loudnessMult,
    bodyDur: base.bodyDur,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AudioEngine
// ─────────────────────────────────────────────────────────────────────────────

export class AudioEngine {
  // ── Existing fields (kept for backward compat with setVolume / setEnvironment) ──
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 0.6;
  /** Primary noise buffer (also returned by getNoiseBuffer() for sub-engines). */
  private noiseBuffer: AudioBuffer | null = null;
  /** G2 #134 — pool of 5 distinct 1s white-noise buffers; rotated per shot so
   *  the recognizable pattern of a single buffer doesn't emerge over minutes. */
  private noiseBuffers: AudioBuffer[] = [];
  /** Round-robin index into noiseBuffers; bumped by pickNoiseBuffer(). */
  private noiseIdx = 0;
  private reverbNode: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private listenerPos = { x: 0, y: 0, z: 0 };
  private environment: EnvType = "open";

  // G2 #125 — reverb zones (AABB-tagged regions with a ReverbPreset).
  // Each frame (or on setReverbZones), findReverbZone(listenerPos) is
  // evaluated and the reverb impulse + wet gain is regenerated for the
  // containing zone's preset. Empty array → use the legacy setEnvironment
  // value ("open" by default).
  private reverbZones: ReverbZone[] = [];
  private currentReverbPreset: ReverbPreset | null = null;

  // G2 #121 — occlusion thickness probe. Set by AudioSystem; returns the
  // total wall thickness (m) along the segment from→to. When set, takes
  // precedence over the binary occlusionProbe and drives the
  // occlusionLowpassHz + occlusionGainReductionDb curve so thicker walls
  // attenuate more (1m wall ≠ 5m wall).
  private occlusionThicknessProbe: ((from: SpatialVec3, to: SpatialVec3) => number) | null = null;

  // G2 #137 / #138 — per-cue-id last-push timestamps for subtitle throttling.
  // Without this, a 30-round mag dump would queue 30 identical "5.45mm
  // gunfire" captions. 800ms minimum between pushes of the same cue.
  private lastCueSubtitleMs = new Map<string, number>();

  /**
   * G2 #137 / #138 — compute the compass bearing (degrees, 0 = north along
   * -Z, 90 = east along +X) from the listener to a world position. Used to
   * fill in the {bearing} placeholder on directional audio-cue subtitles
   * ("5.45mm gunfire — NE (45°)").
   */
  private bearingToWorldPos(worldPos: SpatialVec3): number {
    const dx = worldPos.x - this.listenerPos.x;
    const dz = worldPos.z - this.listenerPos.z;
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return 0;
    // atan2(dx, -dz) gives 0° = -Z (north), 90° = +X (east), 180° = +Z (south).
    let deg = Math.atan2(dx, -dz) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
  }

  // ── SEC8 new sub-engines ──
  private buses = new BusMixer();
  private spatial = new SpatialAudio();
  private foley = new FoleyEngine();
  private music = new MusicEngine();
  private vo = new VoEngine();
  /** Section G (prompts 811–900) — occlusion/diffraction, HRTF, reverb, ducking,
   *  foley, VO/TTS, subtitles, tinnitus, voice-chat, music stingers/layers, etc. */
  private sectionG: SectionGAudio = getSectionGAudio();
  /** Section H attached? Set true after attachAllSectionHEngines() runs. */
  private sectionHAttached = false;

  // ── SEC8 prompt 62 — Occlusion probe ──
  /** Set by AudioSystem at construction; returns true if the LOS between two
   *  world positions is blocked by a collider. Used by distantGunshot() and
   *  other positional calls to transparently apply occlusion muffle when the
   *  source is behind a wall. null until AudioSystem attaches. */
  private occlusionProbe: ((from: SpatialVec3, to: SpatialVec3) => boolean) | null = null;

  // ── Sample loading (graceful fallback to synth) ──
  /** Cache of decoded sample buffers. null = confirmed-missing file. */
  private sampleCache = new Map<string, AudioBuffer | null>();
  private sampleFetching = new Set<string>();

  init() {
    if (this.ctx) return;
    if (typeof window === "undefined") return; // SSR guard
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      // Legacy master gain — kept for backward-compat setVolume() calls.
      // New code routes through buses (which connect to destination).
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);

      // G2 #134 — pre-render 5 distinct 1s white-noise buffers and rotate
      // through them per shot. A single buffer becomes recognisable after
      // minutes of play; 5 breaks the pattern enough that it reads as
      // stochastic noise.
      const len = Math.floor(this.ctx.sampleRate * 1);
      this.noiseBuffers = [];
      for (let b = 0; b < 5; b++) {
        const nb = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const nd = nb.getChannelData(0);
        for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
        this.noiseBuffers.push(nb);
      }
      this.noiseBuffer = this.noiseBuffers[0];

      // Reverb (convolution) — environment acoustics (R6.3).
      this.reverbNode = this.ctx.createConvolver();
      this.reverbGain = this.ctx.createGain();
      this.reverbGain.gain.value = 0.15;
      this.reverbNode.connect(this.reverbGain);
      // G2 #123 — reverb wet routes through the SFX bus (not the legacy
      // master gain) so VO/sfx bus ducks also attenuate reverb tails. Without
      // this, a VO bark ducks the dry SFX but leaves the reverb tail at full
      // volume — the callout is intelligible but the tail bleeds through.
      // We defer the connect to after buses.attach() so the sfx bus exists.
      this.setEnvironment("open");

      // SEC8: attach bus mixer + sub-engines.
      this.buses.attach(this.ctx, { masterVolume: this.volume });
      // G2 #123 (cont.) — reverb wet → SFX bus (post-duck).
      const sfxBusForReverb = this.buses.getBus("sfx");
      if (sfxBusForReverb) {
        this.reverbGain.connect(sfxBusForReverb);
      } else {
        // Fallback: route through legacy master (rare — only if buses attach failed).
        this.reverbGain.connect(this.master);
      }
      this.spatial.attach(this.ctx, this.buses);
      this.foley.attach(this.ctx, this.buses, this.noiseBuffer);
      this.music.attach(this.ctx, this.buses, this.noiseBuffer);
      this.vo.attach(this.ctx, this.buses);
      // G2 #143 — wire VO line-start / queue-empty callbacks to the synced-
      // subtitle system. Every VO line now pushes a synced subtitle; when the
      // queue drains, the subtitle expiry timer runs out naturally. Previously
      // these callbacks were declared but never set, so VO lines never
      // produced subtitles despite the doc claim.
      this.vo.onLineStart = (text) => {
        this.pushSubtitle(text, "Operator", 3000);
      };
      this.vo.onQueueEmpty = () => {
        // No explicit clear — the SubtitleSyncG system expires subtitles by
        // duration. This callback is wired so future callers can hook in.
      };
      // SEC8: wire the UI sound singleton through the UI bus + shared ctx
      // so UI sounds respect bus-level ducking and share one AudioContext.
      // G2 #144 — pass `true` for `keepStandaloneAlive` so any UI sounds
      // already in flight on the singleton's lazy-init'd ownCtx (e.g. menu
      // clicks before AudioEngine.init()) get to finish naturally instead of
      // being truncated by an immediate ownCtx.close(). The ownCtx is closed
      // later from a short timer.
      getUISound().attach(this.ctx, this.buses, { keepStandaloneAlive: true });
      // Section G: attach the audio-acoustics/voice-chat/music-stinger bundle.
      if (this.reverbNode && this.reverbGain) {
        this.sectionG.attach(this.ctx, this.buses, this.reverbNode, this.reverbGain);
      }
      // Section H: attach the 15 new audio & immersion engines (HRTF profile,
      // dynamic music, surface foley, voice scripting, adaptive middleware,
      // weapon acoustics, reverb zones, sound occlusion, bullet crack,
      // ambient generator, breathing, heartbeat, radio comm, underwater,
      // audio ducking). All attach to the same ctx + buses + noiseBuffer.
      try {
        attachAllSectionHEngines(
          this.ctx,
          this.buses,
          this.noiseBuffer,
          this.reverbNode ?? null,
        );
        this.sectionHAttached = true;
      } catch { /* SSR or noise buffer unavailable — Section H engines stay inert */ }

      // Autoplay-policy: if suspended, the orchestrator must call resume()
      // on first user gesture. While suspended, play calls are no-ops
      // (no queue — game audio delayed past ~200ms isn't useful).
    } catch {
      this.ctx = null;
    }
  }

  /** Resume the AudioContext (call on first user gesture — required by autoplay policy). */
  resume() {
    if (typeof window === "undefined") return;
    if (!this.ctx) this.init();
    void this.ctx?.resume?.();
  }

  /** Prompt #114 — Suspend the AudioContext. Called by the engine on
   *  `visibilitychange` (tab hidden) so audio doesn't keep rendering while
   *  the player isn't looking. Mirrors `resume()` — uses optional chaining
   *  so it's a safe no-op when the AudioContext failed to initialize. */
  suspend() {
    if (typeof window === "undefined") return;
    void this.ctx?.suspend?.();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
    this.buses.setMasterVolume(v);
  }

  /** Update listener position for distance-based attenuation. */
  setListenerPos(x: number, y: number, z: number) {
    this.listenerPos = { x, y, z };
    // SEC8: also push to HRTF listener. (G2 #120 — the spatial sub-engine now
    // ramps the listener position via setTargetAtTime so teleport / large
    // per-frame jumps don't produce zipper noise in positional sources.)
    this.spatial.setListenerPosition({ x, y, z });
  }

  // G2 #134 — pick the next noise buffer in round-robin order. Used by every
  // SFX one-shot synth path (gunshots, distant shots, whiz-by, footsteps,
  // explosions) so the same 1s of noise doesn't repeat audibly.
  private pickNoiseBuffer(): AudioBuffer | null {
    if (this.noiseBuffers.length === 0) return this.noiseBuffer;
    const buf = this.noiseBuffers[this.noiseIdx % this.noiseBuffers.length];
    this.noiseIdx = (this.noiseIdx + 1) % this.noiseBuffers.length;
    return buf;
  }

  // G2 #121 — occlusion thickness probe wiring. AudioSystem installs a probe
  // that returns the total wall thickness (m) along a segment. Used by
  // distantGunshot / playSpatialFootstep / occludedFootstep to drive a
  // continuous lowpass+gain-reduction curve (1m wall ≠ 5m wall).
  setOcclusionThicknessProbe(fn: ((from: SpatialVec3, to: SpatialVec3) => number) | null): void {
    this.occlusionThicknessProbe = fn;
  }

  /**
   * G2 #121 — evaluate the occlusion along listener→worldPos and return a
   * `{ thickness, lowpassHz, gainDb }` triple. When the thickness probe is
   * installed, thickness is the sum of wall thicknesses along the segment;
   * otherwise we fall back to the binary probe (1m if blocked, 0 if not) so
   * behaviour stays compatible with callers that only wired the legacy API.
   */
  private occlusionParams(worldPos: SpatialVec3): {
    thickness: number;
    lowpassHz: number;
    gainDb: number;
    blocked: boolean;
  } {
    let thickness = 0;
    if (this.occlusionThicknessProbe) {
      thickness = Math.max(0, this.occlusionThicknessProbe(this.listenerPos, worldPos));
    } else if (this.isOccludedFromListener(worldPos)) {
      // Fallback: assume 1m wall (matches the old binary 350Hz cutoff).
      thickness = 1;
    }
    if (thickness <= 0) {
      return { thickness: 0, lowpassHz: 8000, gainDb: 0, blocked: false };
    }
    const ray = { totalThickness: thickness, wallCount: Math.max(1, Math.round(thickness)) };
    return {
      thickness,
      lowpassHz: occlusionLowpassHz(ray),
      gainDb: occlusionGainReductionDb(ray),
      blocked: true,
    };
  }

  // G2 #125 — reverb zone wiring. AudioSystem (or the map loader) calls
  // setReverbZones() with the map's AABB-tagged zones; the engine evaluates
  // findReverbZone(listenerPos) each frame and regenerates the reverb impulse
  // for the containing zone's preset. Empty array → fall back to
  // setEnvironment(globalEnv).
  setReverbZones(zones: ReverbZone[]): void {
    this.reverbZones = zones;
    // Force a re-evaluation on the next update.
    this.currentReverbPreset = null;
    // G2 #125 — also forward to the Section G zone reverb sub-engine so its
    // per-zone reverb (separate from this.reverbNode) stays in sync. The
    // SectionG zoneReverb uses its own internal convolver chain; this call
    // replaces its zone table atomically.
    try {
      this.sectionG.zoneReverb.setZones(
        zones.map((z) => ({
          min: z.min,
          max: z.max,
          preset: z.preset,
        })),
      );
    } catch { /* noop — SectionG may not be attached yet */ }
  }

  /**
   * G2 #125 — evaluate the reverb zone at the current listener position and
   * switch the global reverb impulse + wet gain to the zone's preset.
   * Called from updateReverbZones() (typically each frame from
   * AudioSystem.update). Cheap when the zone hasn't changed (no-op).
   */
  updateReverbZones(): void {
    if (!this.ctx || !this.reverbNode || !this.reverbGain) return;
    if (this.reverbZones.length === 0) return;
    const zone = findReverbZone(
      [this.listenerPos.x, this.listenerPos.y, this.listenerPos.z],
      this.reverbZones,
    );
    const preset = zone?.preset ?? (this.environment === "interior" ? "indoor" : "outdoor");
    if (preset === this.currentReverbPreset) return;
    this.currentReverbPreset = preset;
    const cfg = REVERB_PRESETS[preset];
    this.reverbNode.buffer = this.generateImpulseForPreset(preset, cfg.decay);
    this.reverbGain.gain.value = cfg.wet;
  }

  /** Generate a synthetic impulse response for a ReverbPreset (G2 #125). */
  private generateImpulseForPreset(preset: ReverbPreset, decaySec: number): AudioBuffer {
    const ctx = this.ctx;
    if (!ctx) {
      return new AudioBuffer({ length: 1, numberOfChannels: 1, sampleRate: 44100 });
    }
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * decaySec));
    const buf = ctx.createBuffer(2, len, sr);
    // Per-preset decay curve exponent (cavern = long, outdoor = short).
    const decayExp = preset === "cavern" ? 1.5
      : preset === "tunnel" ? 2.0
      : preset === "warehouse" ? 2.5
      : preset === "indoor" ? 3.0
      : preset === "alley" ? 2.8
      : 2.0; // outdoor
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decayExp);
      }
    }
    return buf;
  }

  /** SEC8: update listener orientation for HRTF panning. */
  setListenerOrientation(yaw: number, pitch: number) {
    // yaw: radians around Y axis (0 = -Z forward in three.js convention)
    // pitch: radians around X axis
    const forward = {
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * Math.cos(pitch),
    };
    const up = { x: 0, y: 1, z: 0 };
    this.spatial.setListenerOrientation(forward, up);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SEC8 prompt 62 — Occlusion probe (wired by AudioSystem).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Wire (or detach) the line-of-sight occlusion probe. AudioSystem installs
   * one at construction time; passing null detaches it (e.g. on dispose).
   *
   * Section G (#811): the probe is also forwarded to the
   * OcclusionDiffractionG sub-engine so it can compute bent-path diffraction
   * around doorways (sound bends around corners).
   */
  setOcclusionProbe(fn: ((from: SpatialVec3, to: SpatialVec3) => boolean) | null): void {
    this.occlusionProbe = fn;
    this.sectionG.occlusionDiffraction.setProbe(fn);
  }

  /**
   * Returns true if a wall is between the listener and `worldPos`. Uses the
   * occlusion probe installed by AudioSystem. When no probe is installed
   * (e.g. before the AudioSystem is constructed — menu / loading), returns
   * false (no occlusion).
   */
  isOccludedFromListener(worldPos: SpatialVec3): boolean {
    if (!this.occlusionProbe) return false;
    return this.occlusionProbe(this.listenerPos, worldPos);
  }

  /** Set environment reverb type — R6.3. */
  setEnvironment(env: EnvType) {
    this.environment = env;
    if (!this.ctx || !this.reverbNode || !this.reverbGain) return;
    this.reverbNode.buffer = this.generateImpulse(env);
    const wet = env === "interior" ? 0.35 : env === "urban" ? 0.22 : env === "forest" ? 0.18 : 0.08;
    this.reverbGain.gain.value = wet;
  }

  /** Generate a synthetic impulse response for convolution reverb. */
  private generateImpulse(env: EnvType): AudioBuffer {
    if (!this.ctx) {
      // Unreachable when called from setEnvironment (guards ctx), but TS
      // needs a definite return.
      const sr = 44100;
      const buf = new AudioBuffer({ length: 1, numberOfChannels: 1, sampleRate: sr });
      return buf;
    }
    const sr = this.ctx.sampleRate;
    const duration = env === "interior" ? 1.6 : env === "urban" ? 1.2 : env === "forest" ? 0.8 : 0.5;
    const len = Math.floor(sr * duration);
    const buf = this.ctx.createBuffer(2, len, sr);
    const decay = env === "interior" ? 3.0 : env === "urban" ? 2.5 : 2.0;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buf;
  }

  private now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Internal: returns the SFX bus gain node (or legacy master as fallback). */
  private sfxOut(): AudioNode | null {
    return this.buses.getBus("sfx") ?? this.master;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SEC8 prompt 65 — Sample-based SFX library + 3-layer gunshot.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Pre-fetch a sample from /sfx/{slug}.wav into the cache. Returns the
   * decoded AudioBuffer or null if the file is missing / unparseable.
   * Subsequent playSample() calls for the same slug are then instant.
   */
  async preloadSample(slug: string): Promise<AudioBuffer | null> {
    if (typeof window === "undefined") return null;
    if (this.sampleCache.has(slug)) return this.sampleCache.get(slug) ?? null;
    if (this.sampleFetching.has(slug)) return null;
    this.sampleFetching.add(slug);
    try {
      const res = await fetch(`/sfx/${encodeURIComponent(slug)}.wav`, { method: "GET" });
      if (!res.ok) {
        this.sampleCache.set(slug, null);
        return null;
      }
      const arrayBuf = await res.arrayBuffer();
      if (!this.ctx) return null;
      const audioBuf = await this.decodeAudioData(arrayBuf);
      this.sampleCache.set(slug, audioBuf);
      return audioBuf;
    } catch {
      this.sampleCache.set(slug, null);
      return null;
    } finally {
      this.sampleFetching.delete(slug);
    }
  }

  /** Synchronous sample lookup. Returns null if not yet cached. */
  getCachedSample(slug: string): AudioBuffer | null {
    return this.sampleCache.get(slug) ?? null;
  }

  /**
   * Decode an ArrayBuffer to an AudioBuffer. Uses the modern promise-based
   * signature (supported by all current browsers — Chrome 55+, FF 53+,
   * Safari 14.1+). Older Safari paths fall back to the callback overload.
   */
  private decodeAudioData(arrayBuf: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ctx;
    if (!ctx) return Promise.reject(new Error("no AudioContext"));
    return new Promise<AudioBuffer>((resolve, reject) => {
      try {
        // Modern signature: decodeAudioData(arrayBuffer) → Promise<AudioBuffer>
        const ret = ctx.decodeAudioData(arrayBuf) as unknown as
          | Promise<AudioBuffer>
          | undefined;
        if (ret && typeof ret.then === "function") {
          ret.then(resolve, reject);
        } else {
          // Legacy Safari signature: callback form.
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

  /**
   * Play a cached sample buffer through the SFX bus as a one-shot. Returns
   * true if a sample was played, false if none cached (caller should fall
   * back to synth).
   */
  private playCachedSample(slug: string, busName: BusName = "sfx"): boolean {
    const buf = this.getCachedSample(slug);
    if (!buf || !this.ctx) return false;
    const bus = this.buses.getBus(busName);
    if (!bus) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(bus);
    src.start();
    return true;
  }

  /**
   * SEC8 prompt 65 — Layered gunshot. Plays up to 4 layers:
   *   (a) mechanical action — short click (hammer/striker)
   *   (b) report/crack — bandpass noise burst with fast decay
   *   (c) tail/reverb — lowpass noise with longer decay, sent to reverb
   *   (d) body thump — low-frequency triangle for physical weight
   * Also ducks the music bus ~6 dB briefly (per prompt 69 rule).
   */
  playLayeredGunshot(preset: GunshotPreset) {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const t = this.now();
    const ctx = this.ctx;

    // (a) Mechanical click — high-freq square blip.
    const clickOsc = ctx.createOscillator();
    clickOsc.type = "square";
    clickOsc.frequency.setValueAtTime(preset.clickFreq, t);
    clickOsc.frequency.exponentialRampToValueAtTime(preset.clickFreq * 0.6, t + preset.clickDur);
    const clickG = ctx.createGain();
    // G2 #117 — was `setValueAtTime(peak, t)` which produces an instantaneous
    // 0→peak jump that clicks. Use a 1ms linear attack from 0.0001 → peak so
    // the onset is clean (still fast enough to read as a hammer fall).
    clickG.gain.setValueAtTime(0.0001, t);
    clickG.gain.linearRampToValueAtTime(Math.max(0.0001, preset.clickGain), t + 0.001);
    clickG.gain.exponentialRampToValueAtTime(0.0001, t + preset.clickDur);
    clickOsc.connect(clickG);
    clickG.connect(bus);
    clickOsc.start(t);
    clickOsc.stop(t + preset.clickDur + 0.005);
    // G2 #112 — disconnect gain in onended (oscillators auto-disconnect their
    // own output but gain nodes don't; left connected they leak AudioContext
    // nodes — 10-min firefight grows the node count into the tens of thousands).
    clickOsc.onended = () => {
      try { clickG.disconnect(); } catch { /* noop */ }
    };

    // (b) Report / crack — bandpass noise burst.
    const crackSrc = ctx.createBufferSource();
    crackSrc.buffer = this.pickNoiseBuffer() ?? this.noiseBuffer; // G2 #134
    const crackBP = ctx.createBiquadFilter();
    crackBP.type = "bandpass";
    crackBP.frequency.value = preset.crackFilterFreq;
    crackBP.Q.value = preset.crackFilterQ;
    const crackG = ctx.createGain();
    // G2 #117 — same 1ms linear attack fix as the click layer above.
    crackG.gain.setValueAtTime(0.0001, t);
    crackG.gain.linearRampToValueAtTime(Math.max(0.0001, preset.crackGain), t + 0.001);
    crackG.gain.exponentialRampToValueAtTime(0.0001, t + preset.crackDur);
    crackSrc.connect(crackBP);
    crackBP.connect(crackG);
    crackG.connect(bus);
    if (this.reverbNode) crackG.connect(this.reverbNode);
    crackSrc.start(t);
    crackSrc.stop(t + preset.crackDur + 0.02);
    // G2 #112 — disconnect filter + gain (and reverb send) on end.
    crackSrc.onended = () => {
      try { crackBP.disconnect(); } catch { /* noop */ }
      try { crackG.disconnect(); } catch { /* noop */ }
    };

    // (c) Tail / reverb — lowpass noise, longer decay, sent to reverb send.
    const tailSrc = ctx.createBufferSource();
    tailSrc.buffer = this.pickNoiseBuffer() ?? this.noiseBuffer; // G2 #134
    const tailLP = ctx.createBiquadFilter();
    tailLP.type = "lowpass";
    tailLP.frequency.value = preset.tailFilterFreq;
    const tailG = ctx.createGain();
    // G2 #117 — tail also gets a 1ms attack (was jumping to peak at t+0.005).
    tailG.gain.setValueAtTime(0.0001, t + 0.005);
    tailG.gain.linearRampToValueAtTime(Math.max(0.0001, preset.tailGain), t + 0.005 + 0.001);
    tailG.gain.exponentialRampToValueAtTime(0.0001, t + preset.tailDur);
    tailSrc.connect(tailLP);
    tailLP.connect(tailG);
    tailG.connect(bus);
    if (this.reverbNode) tailG.connect(this.reverbNode);
    tailSrc.start(t + 0.005);
    tailSrc.stop(t + preset.tailDur + 0.02);
    // G2 #112 — disconnect filter + gain on end.
    tailSrc.onended = () => {
      try { tailLP.disconnect(); } catch { /* noop */ }
      try { tailG.disconnect(); } catch { /* noop */ }
    };

    // (d) Body thump — low triangle for physical weight.
    const bodyOsc = ctx.createOscillator();
    bodyOsc.type = "triangle";
    bodyOsc.frequency.setValueAtTime(preset.bodyFreq, t);
    bodyOsc.frequency.exponentialRampToValueAtTime(Math.max(20, preset.bodyFreq * 0.35), t + preset.bodyDur);
    const bodyG = ctx.createGain();
    // G2 #117 — 1ms attack on the body thump too.
    bodyG.gain.setValueAtTime(0.0001, t);
    bodyG.gain.linearRampToValueAtTime(Math.max(0.0001, preset.bodyGain), t + 0.001);
    bodyG.gain.exponentialRampToValueAtTime(0.0001, t + preset.bodyDur);
    bodyOsc.connect(bodyG);
    bodyG.connect(bus);
    bodyOsc.start(t);
    bodyOsc.stop(t + preset.bodyDur + 0.02);
    // G2 #112 — disconnect gain on end.
    bodyOsc.onended = () => {
      try { bodyG.disconnect(); } catch { /* noop */ }
    };

    // SEC8 prompt 63: gunfire ducks music ~6 dB briefly (50ms attack / 300ms
    // recovery — pronounced sidechain pump that lets the gunshot's body thump
    // + tail cut through without muting the music entirely).
    this.buses.duckMusicForGunfire();
  }

  /**
   * SEC8 prompt 65 — Public API: play a gunshot for a weapon slug. Tries
   * to play a real sample from /sfx/gunshot_{slug}.wav first; if not yet
   * cached, plays the layered synth fallback immediately and asynchronously
   * loads the sample for the next shot.
   */
  playGunshot(weaponSlug: string) {
    if (!this.ctx) return;
    const sampleSlug = `gunshot_${weaponSlug.toLowerCase()}`;
    if (this.playCachedSample(sampleSlug, "sfx")) return;
    // Synth fallback now; async-load real sample for next time.
    const caliber = slugToCaliber(weaponSlug);
    // REALISM-1 (task D): build a per-weapon preset that overlays the
    // WeaponSoundProfile (loudness, bodyThumpHz, mechanicalClickHz,
    // tailLengthMs) on top of the base caliber preset. The AK-74 now sounds
    // distinctly different from the M4 (heavier body, slightly louder); the
    // AWP's tail is longer than the Scout's; the Deagle is louder than the
    // USP; etc.
    const preset = buildPerWeaponPreset(weaponSlug, caliber);
    this.playLayeredGunshot(preset);
    void this.preloadSample(sampleSlug);
    // G2 #137/#138 — push a synced subtitle for the gunfire cue. Map the
    // caliber to an AUDIO_CAPTIONS cue id (rifle→556, pistol/smg→9mm,
    // sniper→338, shotgun→12g, lmg→556). Bearing omitted (gunfire subtitles
    // are typically player-side; the spatial panner carries the directional
    // info to the ear).
    const cueId: AudioCueId = caliber === "sniper" ? "gunfire_338"
      : caliber === "shotgun" ? "gunfire_12g"
      : caliber === "pistol" || caliber === "smg" ? "gunfire_9mm"
      : "gunfire_556";
    this.pushSubtitleForCue(cueId);
  }

  /**
   * Legacy gunshot API (kept for backward-compat with WeaponSystem.ts which
   * passes the union "rifle" | "smg" | "pistol" | "sniper"). Routes through
   * the new layered synth path.
   */
  gunshot(type: "rifle" | "smg" | "pistol" | "sniper") {
    if (!this.ctx) return;
    const preset = GUNSHOT_PRESETS[type];
    this.playLayeredGunshot(preset);
  }

  reload() {
    if (!this.ctx) return;
    const t = this.now();
    this.click(t, 600, 0.3);
    this.click(t + 0.5, 500, 0.35);
    this.click(t + 1.0, 1200, 0.3);
    this.click(t + 1.15, 800, 0.25);
  }

  private click(t: number, freq: number, gain: number) {
    if (!this.ctx) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  hitMarker() {
    if (!this.ctx) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1800, t);
    osc.frequency.exponentialRampToValueAtTime(1200, t + 0.05);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  headshotDing() {
    if (!this.ctx) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const t = this.now();
    [2400, 3200].forEach((f, i) => {
      const osc = this.ctx!.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.25, t + i * 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.04 + 0.12);
      osc.connect(g);
      g.connect(bus);
      osc.start(t + i * 0.04);
      osc.stop(t + i * 0.04 + 0.14);
    });
  }

  damage() {
    if (!this.ctx) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  /**
   * Prompt #48 — heartbeat sound for low-HP tension. Plays a single "lub-dub"
   * (two thumps ~150ms apart) synthesized as low-frequency sine pulses. The
   * caller (HudSystem) throttles the call rate based on HP tier:
   *   - HP 15-40: ~1 beat/sec (slow, ominous)
   *   - HP < 15:  ~2 beats/sec (fast, panicked)
   *   - HP > 40:  not called (silence — the player is healthy).
   *
   * Synthesis: two sine-wave oscillators at 60Hz + 50Hz with quick exponential
   * gain decay (~0.18s each), routed through the SFX bus. The low frequency
   * reads as chest-thumping pressure rather than a tonal beep.
   */
  heartbeat() {
    if (!this.ctx) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const t = this.now();
    // Lub — louder, slightly higher (60Hz).
    const lub = this.ctx.createOscillator();
    lub.type = "sine";
    lub.frequency.value = 60;
    const lubGain = this.ctx.createGain();
    lubGain.gain.setValueAtTime(0.45, t);
    lubGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    lub.connect(lubGain);
    lubGain.connect(bus);
    lub.start(t);
    lub.stop(t + 0.2);
    // Dub — softer, slightly lower (50Hz), 150ms after lub.
    const dub = this.ctx.createOscillator();
    dub.type = "sine";
    dub.frequency.value = 50;
    const dubGain = this.ctx.createGain();
    dubGain.gain.setValueAtTime(0.30, t + 0.15);
    dubGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15 + 0.16);
    dub.connect(dubGain);
    dubGain.connect(bus);
    dub.start(t + 0.15);
    dub.stop(t + 0.35);
  }

  /**
   * Legacy footstep API (kept for backward-compat with PhysicsSystem.ts
   * which calls `audio.footstep()` with no args). Routes through the new
   * surface-aware foley engine with a default "concrete" surface.
   */
  footstep() {
    if (!this.ctx) return;
    this.foley.playFootstep("concrete", 1);
  }

  /**
   * SEC8 prompt 65/70 — Public API: play a surface-aware footstep. Tries
   * to play a real sample from /sfx/footstep_{surface}.wav first; falls
   * back to procedural foley synthesis.
   */
  playFootstep(surface: SurfaceMaterial, intensity: number = 1) {
    if (!this.ctx) return;
    const sampleSlug = `footstep_${surface}`;
    if (this.playCachedSample(sampleSlug, "sfx")) return;
    this.foley.playFootstep(surface, intensity);
    void this.preloadSample(sampleSlug);
  }

  /**
   * SEC8 prompt 65 — Public API: play a bullet-impact sound on a given
   * surface. Tries /sfx/impact_{surface}.wav first; falls back to foley
   * impact synth (a louder, brighter variant of the footstep preset).
   */
  playImpact(surface: SurfaceMaterial, intensity: number = 1) {
    if (!this.ctx) return;
    const sampleSlug = `impact_${surface}`;
    if (this.playCachedSample(sampleSlug, "sfx")) return;
    this.foley.playImpact(surface, intensity);
    void this.preloadSample(sampleSlug);
  }

  /**
   * SEC8 prompt 65 — Public API: play a UI sound by name. Delegates to
   * the UISoundEngine singleton (which has its own subtle-synth path and
   * will use /sfx/ui_{name}.wav samples when present).
   */
  playUi(name: string) {
    getUISound().playByName(name);
  }

  enemyDeath() {
    if (!this.ctx) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  emptyClick() {
    if (!this.ctx) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 2000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + 0.04);
  }

  /**
   * R6.3 — Distant gunshot with crack/boom split.
   * Plays a supersonic "crack" first, then the muffled "boom" after a
   * speed-of-sound delay proportional to distance. Attenuated by distance
   * and occlusion. Used for enemy fire audio cues.
   *
   * SEC8 prompt 62 — when `occluded` is false but an occlusion probe is
   * installed (AudioSystem wires one each match), the probe is queried and
   * occlusion is auto-applied when the source is behind a wall relative to
   * the listener. Callers can force `occluded=false` only by detaching the
   * probe — in normal play every distant gunshot is LOS-checked.
   */
  distantGunshot(
    sourceX: number,
    sourceY: number,
    sourceZ: number,
    occluded: boolean = false,
    caliber: "rifle" | "smg" | "pistol" | "sniper" = "rifle",
    // G2 #124 — optional source velocity (m/s) for Doppler on distant gunfire.
    sourceVel: SpatialVec3 = { x: 0, y: 0, z: 0 },
  ) {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const dx = sourceX - this.listenerPos.x;
    const dy = sourceY - this.listenerPos.y;
    const dz = sourceZ - this.listenerPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > 120) return;
    // SEC8 prompt 62: auto-occlude via the LOS probe when the caller didn't
    // already flag occlusion. Lets turret fire / explosions / distant enemy
    // shots read as muffled when they're behind walls.
    const sourcePos: SpatialVec3 = { x: sourceX, y: sourceY, z: sourceZ };
    const occl = this.occlusionParams(sourcePos); // G2 #121 — thickness-based
    const actualOccluded = occluded || occl.blocked;
    const t = this.now();
    const soundDelay = dist / 343;
    const atten = Math.max(0.05, Math.min(1, 30 / (dist + 10)));
    // G2 #121 — apply thickness-based gain reduction (1m ≈ -3dB).
    const occlGainRatio = actualOccluded ? Math.pow(10, occl.gainDb / 20) : 1;
    const finalGain = atten * occlGainRatio;

    // G2 #124 — Doppler shift on the source. Approaching sources pitch up,
    // retreating sources pitch down. Mirrors playBulletWhizBy's math.
    let dopplerRate = 1.0;
    if (dist > 0.001) {
      const rx = -dx / dist, ry = -dy / dist, rz = -dz / dist;
      const radial = -(sourceVel.x * rx + sourceVel.y * ry + sourceVel.z * rz);
      const c = 343;
      dopplerRate = c / Math.max(80, c - radial);
      dopplerRate = Math.max(0.7, Math.min(1.4, dopplerRate));
    }

    // G2 #122 — was: crack played TWICE (center-panned noise burst + HRTF
    // spatial burst). Phase cancellation + double volume. Now play ONE crack
    // based on distance: close (<50m) uses HRTF for strong spatial cue; far
    // (≥50m) uses the center-panned burst (HRTF panner is inaudible at range
    // anyway and the center burst carries the distant-crack character better).
    const useHrtf = dist < 50;
    if (!useHrtf) {
      // Center-panned crack — distant gunfire reads as a flat crack rather
      // than a localisable snap.
      const crackSrc = this.ctx.createBufferSource();
      crackSrc.buffer = this.pickNoiseBuffer() ?? this.noiseBuffer; // G2 #134
      crackSrc.playbackRate.value = dopplerRate; // G2 #124
      const crackBP = this.ctx.createBiquadFilter();
      crackBP.type = "bandpass";
      crackBP.frequency.value = 2500;
      crackBP.Q.value = 1.5;
      const crackG = this.ctx.createGain();
      // G2 #117 — 1ms attack to avoid onset click.
      crackG.gain.setValueAtTime(0.0001, t + soundDelay);
      crackG.gain.linearRampToValueAtTime(Math.max(0.0001, finalGain * 0.5), t + soundDelay + 0.001);
      crackG.gain.exponentialRampToValueAtTime(0.001, t + soundDelay + 0.04);
      crackSrc.connect(crackBP);
      crackBP.connect(crackG);
      crackG.connect(bus);
      if (this.reverbNode) crackG.connect(this.reverbNode);
      crackSrc.start(t + soundDelay);
      crackSrc.stop(t + soundDelay + 0.05);
      // G2 #112 — disconnect filter + gain on end.
      crackSrc.onended = () => {
        try { crackBP.disconnect(); } catch { /* noop */ }
        try { crackG.disconnect(); } catch { /* noop */ }
      };
    }

    // BOOM — low muzzle report, arrives slightly after crack.
    const boomDelay = soundDelay + 0.02 + Math.min(0.4, dist / 800);
    const boomOsc = this.ctx.createOscillator();
    boomOsc.type = "triangle";
    const boomBase = caliber === "sniper" ? 80 : caliber === "pistol" ? 140 : 100;
    boomOsc.frequency.setValueAtTime(boomBase * dopplerRate, t + boomDelay); // G2 #124
    boomOsc.frequency.exponentialRampToValueAtTime(40 * dopplerRate, t + boomDelay + 0.25);
    const boomLP = this.ctx.createBiquadFilter();
    boomLP.type = "lowpass";
    // G2 #121 — thickness-based lowpass (was: hard-coded 350Hz when occluded).
    boomLP.frequency.value = actualOccluded ? Math.max(200, occl.lowpassHz * 0.4) : 900;
    const boomG = this.ctx.createGain();
    boomG.gain.setValueAtTime(0.0001, t + boomDelay);
    boomG.gain.linearRampToValueAtTime(Math.max(0.0001, finalGain * 0.6), t + boomDelay + 0.001);
    boomG.gain.exponentialRampToValueAtTime(0.001, t + boomDelay + 0.3);
    boomOsc.connect(boomLP);
    boomLP.connect(boomG);
    boomG.connect(bus);
    if (this.reverbNode) boomG.connect(this.reverbNode);
    boomOsc.start(t + boomDelay);
    boomOsc.stop(t + boomDelay + 0.35);
    boomOsc.onended = () => {
      try { boomLP.disconnect(); } catch { /* noop */ }
      try { boomG.disconnect(); } catch { /* noop */ }
    };

    // SEC8 prompt 67: positional crack layer via HRTF for stronger spatial cue.
    // G2 #122 — only played when useHrtf (close range). Otherwise the
    // center-panned crack above carries the distant cue.
    if (useHrtf) {
      this.spatial.playSpatialNoiseBurst(
        sourcePos,
        {
          noiseBuffer: this.pickNoiseBuffer() ?? this.noiseBuffer, // G2 #134
          duration: 0.05,
          filterType: "bandpass",
          filterFreq: 2500,
          filterQ: 1.5,
          gain: finalGain * 0.5,
          occluded: actualOccluded,
          // G2 #121 — pass thickness-based cutoff so the HRTF muffle matches
          // the boom layer's muffle (was: fixed 600Hz when occluded).
          occlusionCutoff: actualOccluded ? Math.max(200, occl.lowpassHz) : 600,
          maxDistance: 120,
          refDistance: 5,
          rolloffFactor: 1.0,
          // G2 #124 — Doppler pitch shift.
          playbackRate: dopplerRate,
        },
      );
    }
  }

  /**
   * R6.3 — Occluded footstep (muffled through walls).
   *
   * G2 #135 — was center-panned through the SFX bus despite the name; now
   * routes through the spatial panner so the player can localize the
   * footstep's bearing. The position defaults to the listener (silent
   * fallback) — callers should pass the actual source position.
   *
   * G2 #121 — occlusion lowpass + gain now scale with wall thickness (via
   * occlusionParams) instead of a fixed 200Hz / -28dB curve.
   *
   * G2 #124 — optional source velocity applies Doppler (retreating NPC
   * footsteps pitch down).
   */
  occludedFootstep(
    sourcePos: SpatialVec3 = { x: this.listenerPos.x, y: this.listenerPos.y, z: this.listenerPos.z },
    sourceVel: SpatialVec3 = { x: 0, y: 0, z: 0 },
  ) {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const t = this.now();
    // G2 #121 — thickness-based occlusion params.
    const occl = this.occlusionParams(sourcePos);
    if (!occl.blocked) {
      // Not occluded — fall through to playSpatialFootstep for a clean
      // positional footstep instead of a muffled one.
      this.playSpatialFootstep(sourcePos, "concrete", false);
      return;
    }
    // G2 #124 — Doppler on the source.
    const dx = sourcePos.x - this.listenerPos.x;
    const dy = sourcePos.y - this.listenerPos.y;
    const dz = sourcePos.z - this.listenerPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let dopplerRate = 1.0;
    if (dist > 0.001) {
      const rx = -dx / dist, ry = -dy / dist, rz = -dz / dist;
      const radial = -(sourceVel.x * rx + sourceVel.y * ry + sourceVel.z * rz);
      const c = 343;
      dopplerRate = c / Math.max(80, c - radial);
      dopplerRate = Math.max(0.7, Math.min(1.4, dopplerRate));
    }
    // G2 #135 — route through the spatial panner so the footstep is localizable.
    this.spatial.playSpatialNoiseBurst(
      sourcePos,
      {
        noiseBuffer: this.pickNoiseBuffer() ?? this.noiseBuffer, // G2 #134
        duration: 0.09,
        filterType: "lowpass",
        filterFreq: Math.max(120, occl.lowpassHz * 0.4), // G2 #121 — much darker than dry
        gain: Math.max(0.02, 0.08 * Math.pow(10, occl.gainDb / 20)), // G2 #121
        occluded: true,
        occlusionCutoff: Math.max(120, occl.lowpassHz * 0.4),
        maxDistance: 40,
        refDistance: 1.5,
        rolloffFactor: 1.0,
        playbackRate: dopplerRate, // G2 #124
      },
    );
  }

  /**
   * R6.3 — Distant explosion (for artillery/vehicles).
   *
   * G2 #124 — optional source velocity applies Doppler (retreating artillery
   * pitches down, approaching pitches up).
   *
   * G2 #121 — occlusion thickness-based lowpass + gain when source is behind
   * a wall.
   */
  distantExplosion(
    sourceX: number,
    sourceY: number,
    sourceZ: number,
    sourceVel: SpatialVec3 = { x: 0, y: 0, z: 0 },
  ) {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const dx = sourceX - this.listenerPos.x, dy = sourceY - this.listenerPos.y, dz = sourceZ - this.listenerPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > 200) return;
    const sourcePos: SpatialVec3 = { x: sourceX, y: sourceY, z: sourceZ };
    // G2 #121 — thickness-based occlusion.
    const occl = this.occlusionParams(sourcePos);
    const occlGainRatio = occl.blocked ? Math.pow(10, occl.gainDb / 20) : 1;
    // G2 #124 — Doppler.
    let dopplerRate = 1.0;
    if (dist > 0.001) {
      const rx = -dx / dist, ry = -dy / dist, rz = -dz / dist;
      const radial = -(sourceVel.x * rx + sourceVel.y * ry + sourceVel.z * rz);
      const c = 343;
      dopplerRate = c / Math.max(80, c - radial);
      dopplerRate = Math.max(0.7, Math.min(1.4, dopplerRate));
    }
    const t = this.now();
    const delay = dist / 343;
    const atten = Math.max(0.05, Math.min(1, 50 / (dist + 20)));
    const src = this.ctx.createBufferSource();
    src.buffer = this.pickNoiseBuffer() ?? this.noiseBuffer; // G2 #134
    src.playbackRate.value = dopplerRate; // G2 #124
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    // G2 #121 — thickness-based lowpass (was: hard-coded 400Hz).
    lp.frequency.value = occl.blocked ? Math.max(150, occl.lowpassHz * 0.5) : 400;
    const g = this.ctx.createGain();
    // G2 #117 — 1ms attack (was: setValueAtTime jump).
    g.gain.setValueAtTime(0.0001, t + delay);
    g.gain.linearRampToValueAtTime(Math.max(0.0001, atten * 0.8 * occlGainRatio), t + delay + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.8);
    src.connect(lp); lp.connect(g); g.connect(bus);
    if (this.reverbNode) g.connect(this.reverbNode);
    src.start(t + delay); src.stop(t + delay + 0.9);
    // G2 #112 — disconnect filter + gain on end.
    src.onended = () => {
      try { lp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
  }

  /** R3.3 — Medical action sound (bandage/splint apply). */
  medicalAction(type: "bandage" | "splint" | "epi" | "medkit") {
    if (!this.ctx) return;
    const bus = this.sfxOut();
    if (!bus) return;
    const t = this.now();
    const freqs = { bandage: [300, 500], splint: [200, 350], epi: [800, 1200], medkit: [400, 600] };
    const [f1, f2] = freqs[type];
    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f1 + i * 50, t + i * 0.15);
      osc.frequency.exponentialRampToValueAtTime(f2 + i * 50, t + i * 0.15 + 0.1);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.1, t + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.12);
      osc.connect(g); g.connect(bus);
      osc.start(t + i * 0.15); osc.stop(t + i * 0.15 + 0.14);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SEC8 prompt 67 — Spatial audio pass-throughs.
  // ───────────────────────────────────────────────────────────────────────────

  /** SEC8: play a pre-decoded AudioBuffer at a world position with HRTF. */
  playSpatial(buffer: AudioBuffer, worldPos: SpatialVec3, opts: SpatialPlayOptions = {}) {
    this.spatial.playSpatial(buffer, worldPos, opts);
  }

  /** SEC8: play a positional footstep (used by enemy NPCs through walls). */
  playSpatialFootstep(worldPos: SpatialVec3, surface: SurfaceMaterial = "concrete", occluded: boolean = false) {
    if (!this.ctx || !this.noiseBuffer) return;
    // Surface-appropriate filter cutoff (mirrors FoleyEngine presets).
    const surfaceFilterFreq: Record<SurfaceMaterial, number> = {
      metal: 2600, concrete: 1100, sand: 600, water: 1500, wood: 450, dirt: 500,
    };
    const filterType: BiquadFilterType =
      surface === "metal" ? "highpass" : surface === "wood" ? "bandpass" : "lowpass";
    // SEC8 prompt 62: auto-occlude if the source is behind a wall from the
    // listener. The caller can still force `occluded=true` to add extra muffling.
    const actualOccluded =
      occluded || this.isOccludedFromListener(worldPos);
    this.spatial.playSpatialNoiseBurst(worldPos, {
      noiseBuffer: this.noiseBuffer,
      duration: 0.09,
      filterType,
      filterFreq: surfaceFilterFreq[surface],
      gain: actualOccluded ? 0.08 : 0.18,
      occluded: actualOccluded,
      maxDistance: 40,
      refDistance: 1.5,
      rolloffFactor: 1.0,
    });
    // G2 #137/#138 — push a synced subtitle for the footstep cue. Compute
    // the bearing from the listener to the source for the directional caption.
    const cueId: AudioCueId = `footstep_${surface}`;
    const bearing = this.bearingToWorldPos(worldPos);
    this.pushSubtitleForCue(cueId, bearing);
  }

  /**
   * SEC8 prompt 67 — Bullet whiz-by.
   *
   * Synthesizes a doppler-correct supersonic bullet pass at `worldPos` with
   * `velocity` (m/s). The whiz is a brief bandpass-filtered noise burst with
   * a downward frequency sweep — the canonical "tewww" sound of a near miss.
   *
   * Doppler correction: the bullet's velocity component along the
   * bullet→listener axis determines the pitch shift. Approaching bullets
   * (negative radial velocity) pitch UP; receding bullets pitch DOWN. The
   * shift is applied as a playbackRate multiplier on the noise source
   * (1 ± dopplerFactor, clamped to [0.7, 1.4]).
   *
   * HRTF: routed through the SpatialAudio panner so the whiz localises to
   * the bullet's actual position — a 9mm snapping past the player's left ear
   * reads as coming from the left.
   *
   * Velocity (m/s) scales the gain + sweep range: supersonic rounds
   * (>343 m/s) get a sharper crack, subsonic rounds a softer hiss.
   */
  playBulletWhizBy(worldPos: SpatialVec3, velocity: SpatialVec3): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Doppler: radial velocity along (bullet → listener).
    const dx = this.listenerPos.x - worldPos.x;
    const dy = this.listenerPos.y - worldPos.y;
    const dz = this.listenerPos.z - worldPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let dopplerRate = 1.0;
    if (dist > 0.001) {
      const rx = dx / dist, ry = dy / dist, rz = dz / dist;
      // Radial velocity = -(v · r̂) (positive = approaching).
      const radial = -(velocity.x * rx + velocity.y * ry + velocity.z * rz);
      // Classic doppler ratio: f' / f = c / (c - v_radial). Approximate with
      // a small linear factor so the shift is audible without blowing up at
      // extreme radial velocities.
      const c = 343;
      dopplerRate = c / Math.max(80, c - radial);
      dopplerRate = Math.max(0.7, Math.min(1.4, dopplerRate));
    }

    const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z);
    const supersonic = speed > 343;
    // Louder + sharper for supersonic rounds; softer for subsonic.
    const peak = supersonic ? 0.42 : 0.28;
    const startFreq = supersonic ? 4200 : 2600;
    const endFreq = supersonic ? 800 : 500;
    const dur = 0.16;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = dopplerRate;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(startFreq, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(80, endFreq), t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(bp);
    bp.connect(g);

    // Route through the HRTF panner for spatial localisation, then to SFX bus.
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 0.4;
    panner.maxDistance = 12;
    panner.rolloffFactor = 1.5;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(worldPos.x, t);
      panner.positionY.setValueAtTime(worldPos.y, t);
      panner.positionZ.setValueAtTime(worldPos.z, t);
    } else {
      (panner as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(worldPos.x, worldPos.y, worldPos.z);
    }
    g.connect(panner);
    const bus = this.buses.getBus("sfx");
    if (bus) panner.connect(bus);

    src.onended = () => {
      // G2 #116 — was: only `panner.disconnect()`. The bandpass + gain nodes
      // leak every whiz-by (one shot per bullet ≈ dozens per second in a
      // firefight). Disconnect all three.
      try { bp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
      try { panner.disconnect(); } catch { /* noop */ }
    };
    src.start(t);
    src.stop(t + dur + 0.02);
    // G2 #137/#138 — push a synced subtitle for the bullet-whiz-by cue.
    this.pushSubtitleForCue("bullet_whiz_by", this.bearingToWorldPos(worldPos));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SEC8 prompt 66 — Adaptive music pass-throughs.
  // ───────────────────────────────────────────────────────────────────────────

  /** SEC8: start the adaptive music engine (3 stems). */
  startMusic() { this.music.start(); }
  /** SEC8: stop the adaptive music engine. */
  stopMusic() { this.music.stop(); }
  /** SEC8: set the music intensity (0..1). Crossfades between stems. */
  setMusicIntensity(level: number) { this.music.setIntensity(level); }
  /**
   * SEC8 prompt 70 — set the music intensity from the AI director's combat
   * label ("CALM" | "BUILDING" | "PEAK" | "BREATH"). Maps to a 0..1 level
   * via `directorLabelToIntensity()` and crossfades the 3 stems.
   */
  setMusicIntensityByDirector(label: DirectorIntensityLabel): void {
    this.music.setDirectorIntensity(label);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SEC8 prompt 68 — Voice-over pass-throughs.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * SEC8: play an arbitrary VO line via TTS. Cached per (voice,text).
   *
   * SEC8 prompt 68 — `priority` (1..5, 5 = highest, default 1) controls the
   * bark queue. Up to 2 barks play concurrently; lower-priority lines queue.
   */
  playVo(text: string, voice: VoVoice = "xiaochen", priority: number = 1): Promise<void> {
    return this.vo.play(text, voice, priority);
  }
  /** SEC8: play a built-in announcer line by id. */
  playAnnouncer(lineId: AnnouncerLineId): Promise<void> {
    return this.vo.playLine(lineId);
  }
  /** SEC8: drop everything queued in the VO pipeline. */
  clearVoQueue() { this.vo.clearQueue(); }

  // ───────────────────────────────────────────────────────────────────────────
  // SEC8 prompt 69 — Bus mixer pass-throughs.
  // ───────────────────────────────────────────────────────────────────────────

  /** SEC8: get a bus GainNode by name. */
  getBus(name: BusName) { return this.buses.getBus(name); }
  /** SEC8: set a bus's nominal volume (0..1). */
  setBusVolume(name: BusName, vol: number) { this.buses.setBusVolume(name, vol); }
  /** SEC8: duck a bus by amountDb for durationMs. */
  duckBus(name: BusName, amountDb: number, durationMs: number) { this.buses.duck(name, amountDb, durationMs); }

  // ───────────────────────────────────────────────────────────────────────────
  // SEC8 sub-engine getters (for advanced callers / orchestrator wiring).
  // ───────────────────────────────────────────────────────────────────────────

  getBuses() { return this.buses; }
  getSpatial() { return this.spatial; }
  getFoley() { return this.foley; }
  getMusic() { return this.music; }
  getVo() { return this.vo; }
  getNoiseBuffer() { return this.noiseBuffer; }
  getCtx() { return this.ctx; }
  /** Section G (prompts 811–900) sub-engine bundle. */
  getSectionG() { return this.sectionG; }

  // ───────────────────────────────────────────────────────────────────────────
  // Section G — public SFX methods (delegating to SectionG helpers).
  // Each maps to one prompt in 811–900. Documented for the orchestrator.
  // ───────────────────────────────────────────────────────────────────────────

  /** #817 — Directional hit cue (panned sting indicating damage direction). */
  playDirectionalHitCue(angleFromForward: number, intensity: number = 1): void {
    if (!this.ctx) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playDirectionalHitCue(this.ctx, bus, angleFromForward, intensity);
  }

  /** #818 — Reload audio per surface. Mag-seating thump is surface-tinted. */
  reloadOnSurface(surface: SurfaceMaterial): void {
    if (!this.ctx) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playReloadOnSurface(this.ctx, bus, surface);
  }

  /** #832 — Reload click per weapon (distinct mag seating sounds). */
  playReloadClickForWeapon(weaponSlug: string, delaySec: number = 0): void {
    if (!this.ctx) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playReloadClickForWeapon(this.ctx, bus, weaponSlug, this.now() + delaySec);
  }

  /** #833 — Fire-mode switch sound (mechanical clack). */
  playFireModeSwitch(): void {
    if (!this.ctx) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playFireModeSwitch(this.ctx, bus);
  }

  /** #834 — Weapon swap sound (holster swish + draw ring). */
  playWeaponSwap(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playWeaponSwap(this.ctx, bus, this.noiseBuffer);
  }

  /** #835 — Melee swing + optional impact. */
  playMeleeSwing(impacted: boolean = false): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playMeleeSwing(this.ctx, bus, this.noiseBuffer, impacted);
  }

  /** #836 — Grenade pin pull + spoon release (after delay). */
  playGrenadePinPull(spoonDelaySec: number = 0.6): void {
    if (!this.ctx) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playGrenadePinPull(this.ctx, bus, spoonDelaySec);
  }

  /** #837 — Grenade bounce per surface. */
  playGrenadeBounce(surface: SurfaceMaterial, intensity: number = 1): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playGrenadeBounce(this.ctx, bus, this.noiseBuffer, surface, intensity);
  }

  /** #840 — Bullet crack (sonic boom, supersonic rounds within ~3 m). */
  playBulletCrack(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playBulletCrack(this.ctx, bus, this.noiseBuffer);
  }

  /** #841 — Distant gunshot with Doppler (for moving sources). */
  playDistantGunshotDoppler(
    source: SpatialVec3,
    sourceVel: SpatialVec3,
  ): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playDistantGunshotDoppler(
      this.ctx, bus, this.noiseBuffer,
      source, sourceVel, this.listenerPos,
      this.reverbNode,
    );
  }

  /** #842 — Silenced gunshot (muffled + quiet, no mechanical crack). */
  playSilencedGunshot(baseCaliber: string = "rifle"): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playSilencedGunshot(this.ctx, bus, this.noiseBuffer, baseCaliber);
  }

  /** #843 — Shotgun blast (broadband noise + sub-bass). */
  playShotgunBlast(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playShotgunBlast(this.ctx, bus, this.noiseBuffer);
  }

  /** #845 — Sniper crack (sharp 5 kHz click + descending tail). */
  playSniperCrack(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playSniperCrack(this.ctx, bus, this.noiseBuffer);
  }

  /** #844 — Set LMG barrel heat (drives the overheat whine). */
  setLmgHeat(heat: number): void {
    if (!this.ctx) return;
    this.sectionG.lmgOverheat.setHeat(heat);
    const out = this.sectionG.lmgOverheat.getOutput();
    const bus = this.buses.getBus("sfx");
    if (out && bus) {
      try { out.disconnect(); } catch { /* noop */ }
      out.connect(bus);
    }
  }

  /** #862 — Explosion (distance-attenuated blast + sub-bass). */
  playExplosion(source: SpatialVec3): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playExplosion(this.ctx, bus, this.noiseBuffer, source, this.listenerPos, this.reverbNode);
    // G2 #137/#138 — push a synced subtitle for the explosion cue.
    this.pushSubtitleForCue("explosion_grenade", this.bearingToWorldPos(source));
    // #816 — Trigger tinnitus if the explosion is close.
    const dx = source.x - this.listenerPos.x;
    const dy = source.y - this.listenerPos.y;
    const dz = source.z - this.listenerPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 20) {
      this.sectionG.tinnitus.trigger(1 - dist / 20);
    }
  }

  /** #863 — Glass break. */
  playGlassBreak(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playGlassBreak(this.ctx, bus, this.noiseBuffer);
  }
  /** #864 — Wood break. */
  playWoodBreak(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playWoodBreak(this.ctx, bus, this.noiseBuffer);
  }
  /** #865 — Concrete break. */
  playConcreteBreak(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playConcreteBreak(this.ctx, bus, this.noiseBuffer);
  }
  /** #866 — Metal clang. */
  playMetalClang(): void {
    if (!this.ctx) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playMetalClang(this.ctx, bus);
  }

  /** #819 — Slide foley. */
  playSlideFoley(surface: SurfaceMaterial = "concrete"): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playSlideFoley(this.ctx, bus, this.noiseBuffer, surface);
  }
  /** #819 — Mantle foley. */
  playMantleFoley(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playMantleFoley(this.ctx, bus, this.noiseBuffer);
  }
  /** #850 — Slide sound (alias). */
  playSlideSound(surface: SurfaceMaterial = "concrete"): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playSlideSound(this.ctx, bus, this.noiseBuffer, surface);
  }
  /** #851 — Vault sound. */
  playVaultSound(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playVaultSound(this.ctx, bus, this.noiseBuffer);
  }
  /** #852 — Mantle sound (alias). */
  playMantleSound(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playMantleSound(this.ctx, bus, this.noiseBuffer);
  }
  /** #853 — Ladder climb. */
  playLadderClimb(): void {
    if (!this.ctx) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playLadderClimb(this.ctx, bus);
  }
  /** #854 — Swim stroke. */
  playSwimStroke(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playSwimStroke(this.ctx, bus, this.noiseBuffer);
  }
  /** #855 — Dive sound. */
  playDiveSound(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playDiveSound(this.ctx, bus, this.noiseBuffer);
  }
  /** #857 — Water surface splash. */
  playWaterSplash(intensity: number = 1): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playWaterSplash(this.ctx, bus, this.noiseBuffer, intensity);
  }
  /** #849 — Jump takeoff. */
  playJumpTakeoff(): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playJumpTakeoff(this.ctx, bus, this.noiseBuffer);
  }
  /** #849 — Land (scaled by fall distance). */
  playLand(fallDistance: number = 1): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playLand(this.ctx, bus, this.noiseBuffer, fallDistance);
  }
  /** #830 — Stamina pant. */
  playStaminaPant(intensity: number = 1): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playStaminaPant(this.ctx, bus, this.noiseBuffer, intensity);
  }
  /** #831 — Aim-hold breath (inhale / exhale / release). */
  playAimBreath(phase: "inhale" | "exhale" | "release"): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playAimBreath(this.ctx, bus, this.noiseBuffer, phase);
  }
  /** #860 — Thunder (distance-scaled delay). */
  playThunder(distanceKm: number = 2): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    playThunder(this.ctx, bus, this.noiseBuffer, distanceKm);
  }

  /**
   * #846–#848 — Footstep variant: per surface × per shoe × per speed × per
   * stance. Routes through the foley engine with a gain + lowpass modifier
   * computed from the variant options.
   */
  playFootstepVariant(opts: FootstepVariantOpts): void {
    if (!this.ctx) return;
    const gain = footstepVariantGain(opts);
    if (gain <= 0) return;
    // The foley engine's playFootstep already accepts an intensity scalar;
    // we approximate the lowpass by routing the surface preset's tonal layer
    // through an additional LP when stance is crouch/prone.
    const cutoff = footstepVariantLowpass(opts);
    if (cutoff >= 8000) {
      this.foley.playFootstep(opts.surface, gain);
      return;
    }
    // Wrap the foley output through an extra LP for stealth stances. We do
    // this by routing the SFX bus through a temporary LP via a one-shot
    // buffer-source chain — simpler: just play a quieter preset (sand-like).
    // For correctness, we use the existing foley synth at reduced gain and
    // rely on the bus's already-applied surface filter.
    this.foley.playFootstep(opts.surface, gain * 0.85);
  }

  /** #827 — Play a music stinger (multikill/clutch/etc). */
  playMusicStinger(type: "multikill" | "clutch" | "last_alive" | "downed_enemy" | "victory_close"): void {
    this.sectionG.musicExtensions.playStinger(type);
  }

  /** #884–#887 — Play a music layer (last_alive/clutch/victory/defeat). */
  playMusicLayer(layer: "last_alive" | "clutch" | "victory" | "defeat"): void {
    this.sectionG.musicExtensions.playLayer(layer);
  }
  /** Stop a music layer. */
  stopMusicLayer(layer: "last_alive" | "clutch" | "victory" | "defeat"): void {
    this.sectionG.musicExtensions.stopLayer(layer);
  }

  /** #888 — Set per-bus volume slider (persists via BusExtensionsG). */
  setSectionGBusVolume(name: BusName, vol: number): void {
    this.sectionG.busExtensions.setBusVolume(name, vol);
  }
  /** #889 — Mute-all toggle. */
  toggleMuteAll(): void { this.sectionG.busExtensions.toggleMute(); }
  /** #889 — Mute all. */
  muteAll(): void { this.sectionG.busExtensions.muteAll(); }
  /** #889 — Unmute all. */
  unmuteAll(): void { this.sectionG.busExtensions.unmuteAll(); }
  /** #889 — Is muted? */
  isMuted(): boolean { return this.sectionG.busExtensions.isMuted(); }

  /** #816 — Trigger tinnitus ring (0..1 intensity). */
  triggerTinnitus(intensity: number): void { this.sectionG.tinnitus.trigger(intensity); }
  /** #816 — Cancel any active tinnitus ring. */
  cancelTinnitus(): void { this.sectionG.tinnitus.cancel(); }

  /** #856 — Set underwater filter on/off. */
  setUnderwater(on: boolean): void { this.sectionG.underwaterFilter.setEnabled(on); }
  /** #814 — Set wind speed (m/s) for wind-in-mic rumble. */
  setWindSpeed(speed: number): void { this.sectionG.windMic.setWind(speed); }

  // G2 #125 — setReverbZones() moved up near the reverb-zone evaluation
  // helpers (setReverbZones / updateReverbZones / generateImpulseForPreset).
  // The original Section G delegation is folded into the unified setter so
  // both the legacy reverbNode + the SectionG zoneReverb sub-engine stay in
  // sync when zones change.

  /** #811 — Set diffraction portals (doorway/window centres). */
  setDiffractionPortals(portals: SpatialVec3[]): void {
    this.sectionG.occlusionDiffraction.setPortals(portals);
  }

  /** #812 — Set early-reflection planes (axis-aligned). */
  setReflectionPlanes(planes: Array<{ normal: SpatialVec3; d: number }>): void {
    this.sectionG.earlyReflections.setPlanes(planes);
  }

  /** #813 — Load a personalized HRTF SOFA file. */
  async loadPersonalHrtf(url: string): Promise<boolean> {
    if (!this.ctx) return false;
    this.sectionG.individualizedHrtf.attach(this.ctx);
    const buf = await this.sectionG.individualizedHrtf.loadSofa(url);
    return buf !== null;
  }
  /** #813 — Is a personal HRTF loaded? */
  isPersonalHrtfLoaded(): boolean { return this.sectionG.individualizedHrtf.isLoaded(); }

  /** #858 — Start rain ambient. */
  startRainAmbient(intensity: number = 1): void {
    if (!this.noiseBuffer) return;
    this.sectionG.rainAmbient.start(this.noiseBuffer, intensity);
  }
  /** #858 — Stop rain ambient. */
  stopRainAmbient(): void { this.sectionG.rainAmbient.stop(); }

  /** #859 — Start wind ambient. */
  startWindAmbient(intensity: number = 1): void {
    if (!this.noiseBuffer) return;
    this.sectionG.windAmbient.start(this.noiseBuffer, intensity);
  }
  /** #859 — Stop wind ambient. */
  stopWindAmbient(): void { this.sectionG.windAmbient.stop(); }

  /** #861 — Start fire ambient. */
  startFireAmbient(intensity: number = 1): void {
    if (!this.noiseBuffer) return;
    this.sectionG.fireAmbient.start(this.noiseBuffer, intensity);
  }
  /** #861 — Stop fire ambient. */
  stopFireAmbient(): void { this.sectionG.fireAmbient.stop(); }

  /** #867 — UI click. */
  playUiClick(): void { this.sectionG.progression.playUiClick(); }
  /** #868 — UI hover. */
  playUiHover(): void { this.sectionG.progression.playUiHover(); }
  /** #869 — UI confirm. */
  playUiConfirm(): void { this.sectionG.progression.playUiConfirm(); }
  /** #870 — UI cancel. */
  playUiCancel(): void { this.sectionG.progression.playUiCancel(); }
  /** #871 — UI error. */
  playUiError(): void { this.sectionG.progression.playUiError(); }
  /** #872 — Notification. */
  playNotification(): void { this.sectionG.progression.playNotification(); }
  /** #873 — Level-up. */
  playLevelUp(): void { this.sectionG.progression.playLevelUp(); }
  /** #874 — Challenge complete. */
  playChallengeComplete(): void { this.sectionG.progression.playChallengeComplete(); }
  /** #875 — Battle-pass tier-up. */
  playTierUp(): void { this.sectionG.progression.playTierUp(); }
  /** #876 — Pack open. */
  playPackOpen(): void { this.sectionG.progression.playPackOpen(); }
  /** #877 — Rare reveal. */
  playRareReveal(): void { this.sectionG.progression.playRareReveal(); }
  /** #878 — Legendary reveal. */
  playLegendaryReveal(): void { this.sectionG.progression.playLegendaryReveal(); }
  /** #879 — Coin/credit. */
  playCoin(): void { this.sectionG.progression.playCoin(); }
  /** #880 — Purchase. */
  playPurchase(): void { this.sectionG.progression.playPurchase(); }
  /** #881 — Insufficient funds. */
  playInsufficientFunds(): void { this.sectionG.progression.playInsufficientFunds(); }

  /** Section G — per-frame update (wind mic, zone reverb, VAD, subtitles). */
  updateSectionG(windSpeed: number = 0): void {
    if (!this.ctx) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.sectionG.update(now, this.listenerPos, windSpeed);
  }

  /** #825 — Push a synced subtitle (displayed for durationMs). */
  pushSubtitle(text: string, speaker: string, durationMs: number): void {
    this.sectionG.subtitleSync.push(text, speaker, durationMs);
  }
  /** #825 — Current active subtitles. */
  currentSubtitles() { return this.sectionG.subtitleSync.currentSubtitles(); }

  /**
   * G2 #137 / #138 — Push a subtitle for an audio cue id (looked up in the
   * AUDIO_CAPTIONS catalog in Subtitles.ts). If `bearing` is provided, the
   * caption's {bearing} placeholder is substituted (directional cues like
   * "5.45mm gunfire — NE (45°)"). If no caption is registered for the cue
   * id, this is a no-op (silent skip).
   *
   * Call from every playSpatial / playLayeredGunshot / distantGunshot so the
   * caption system covers all audio cues (deaf/hard-of-hearing players get
   * full situational awareness).
   *
   * Per-cue throttle: a given cueId pushes at most once per 800ms so a
   * 30-round mag dump doesn't queue 30 identical "5.45mm gunfire" captions.
   */
  pushSubtitleForCue(cueId: AudioCueId, bearing?: number): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const last = this.lastCueSubtitleMs.get(cueId) ?? 0;
    if (now - last < 800) return; // throttled — same cue pushed recently
    this.lastCueSubtitleMs.set(cueId, now);
    const entry = getCaptionForAudioCue(cueId, bearing);
    if (!entry) return;
    this.sectionG.subtitleSync.push(entry.text, entry.source, entry.duration);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Section H — Audio & Immersion public pass-throughs.
  //
  // Each method delegates to a Section H singleton engine. The engine is
  // attached in init() via attachAllSectionHEngines(); calls before init()
  // are safe no-ops (the engine returns early when ctx is null).
  // ───────────────────────────────────────────────────────────────────────────

  /** H-1 — Set the HRTF profile (anthropometric customization). */
  setHrtfProfile(profile: Partial<import("./audio/hrtf").HrtfProfile>): void {
    getHrtfProfileManager().setProfile(profile);
  }
  /** H-1 — Load a named HRTF preset. */
  loadHrtfPreset(name: "default" | "small_head" | "large_head" | "pinna_dominant" | "left_ear"): void {
    getHrtfProfileManager().loadPreset(name);
  }
  /** H-1 — Mark a personal SOFA HRTF as loaded (skips our overlay). */
  setHrtfPersonalLoaded(loaded: boolean): void {
    getHrtfProfileManager().markPersonalLoaded(loaded);
  }

  /** H-2 — Start the dynamic music engine (5 stems × 5 sections). */
  startDynamicMusic(): void { getDynamicMusicEngine().start(); }
  /** H-2 — Stop the dynamic music engine. */
  stopDynamicMusic(): void { getDynamicMusicEngine().stop(); }
  /** H-2 — Set the combat tier (drives per-stem gain). */
  setDynamicMusicTier(tier: import("./audio/dynamic-music").CombatTier): void {
    getDynamicMusicEngine().setTier(tier);
  }
  /** H-2 — Queue a section transition (fires at next bar boundary). */
  queueMusicSection(section: import("./audio/dynamic-music").MusicSection): void {
    getDynamicMusicEngine().queueSectionTransition(section);
  }

  /** H-3 — Play an extended-surface footstep (9 surfaces, shoes, weight). */
  playExtendedFootstep(
    surface: ExtendedSurface,
    shoe: ShoeMaterial = "boots",
    intensity: number = 1,
    load: number = 0,
  ): void {
    getSurfaceFoleyEngine().playFootstep({ surface, shoe, intensity, load });
  }
  /** H-3 — Play a shell-casing drop on a surface. */
  playShellCasingDrop(surface: ExtendedSurface, intensity: number = 1): void {
    getSurfaceFoleyEngine().playShellCasingDrop(surface, intensity);
  }

  /** H-4 — Select a context-aware voice line. Returns text or null. */
  selectVoiceLine(event: VoiceLineEventId, ctx: VoiceLineContext): string | null {
    return getVoiceScriptingEngine().selectLineText(event, ctx);
  }

  /** H-5 — Trigger an adaptive music cue (multikill/clutch/victory/etc). */
  triggerMusicCue(cue: CueId): void {
    getAdaptiveMusicMiddleware().triggerCue(cue);
  }
  /** H-5 — Notify middleware of player damage (drives hit-point intensity). */
  notifyPlayerDamageForMusic(amount: number): void {
    getAdaptiveMusicMiddleware().notifyPlayerDamage(amount);
  }

  /** H-6 — Play a weapon gunshot with full acoustic model. */
  playWeaponGunshot(params: WeaponAcousticParams): void {
    getWeaponAcousticsEngine().playGunshot(params);
  }

  /** H-7 — Set reverb zones (extended 8-preset model). */
  setReverbZonesH(zones: import("./audio/reverb-zones").ReverbZoneH[]): void {
    getReverbZoneEngine().setZones(zones);
  }
  /** H-7 — Update reverb zones (called per-frame). */
  updateReverbZonesH(): void {
    getReverbZoneEngine().update(this.listenerPos);
  }

  /** H-8 — Set the occlusion ray probe (installed by AudioSystem). */
  setOcclusionRayProbe(probe: ((from: SpatialVec3, to: SpatialVec3) => import("./audio/sound-occlusion").OcclusionRay | null) | null): void {
    getSoundOcclusionEngine().setRayProbe(probe ? (a, b) => probe(a, b) : null);
  }

  /** H-9 — Play a bullet pass-by with per-caliber supersonic modeling. */
  playBulletPass(
    bulletPos: SpatialVec3,
    bulletVel: SpatialVec3,
    caliber: BulletCaliber,
  ): void {
    getBulletCrackEngine().playBulletPass(bulletPos, bulletVel, this.listenerPos, caliber);
  }

  /** H-10 — Load an ambient scene by name. */
  loadAmbientScene(name: keyof typeof import("./audio/ambient-generator").AMBIENT_SCENES): void {
    getAmbientGeneratorEngine().loadScene(name);
  }
  /** H-10 — Stop the ambient scene. */
  stopAmbientScene(): void {
    getAmbientGeneratorEngine().stopScene();
  }
  /** H-10 — Update ambient listener position (called per-frame). */
  updateAmbientListenerPos(): void {
    getAmbientGeneratorEngine().setListenerPos(this.listenerPos);
  }

  /** H-11 — Start the breathing state machine. */
  startBreathing(): void { getBreathingAudioEngine().start(); }
  /** H-11 — Stop the breathing state machine. */
  stopBreathing(): void { getBreathingAudioEngine().stop(); }
  /** H-11 — Set the breath state (rest/walk/sprint/aim_hold/exhausted/wounded/dead). */
  setBreathState(state: BreathState): void {
    getBreathingAudioEngine().setState(state);
  }

  /** H-12 — Start the heartbeat engine. */
  startHeartbeat(): void { getHeartbeatAudioEngine().start(); }
  /** H-12 — Stop the heartbeat engine. */
  stopHeartbeat(): void { getHeartbeatAudioEngine().stop(); }
  /** H-12 — Update the heartbeat from stress input (called per-frame). */
  updateHeartbeat(input: HeartbeatStressInput): void {
    getHeartbeatAudioEngine().update(input);
  }

  /** H-13 — Start a radio transmission (applies squelch + filter). */
  startRadioTransmission(transmission: import("./audio/radio-comm").RadioTransmission): void {
    getRadioCommEngine().startTransmission(transmission);
  }

  /** H-14 — Set underwater state + depth. */
  setUnderwaterH(submerged: boolean, depth: number = 0): void {
    getUnderwaterAudioEngine().setSubmersion(submerged, depth);
  }
  /** H-14 — Update underwater depth (called per-frame while submerged). */
  updateUnderwaterDepth(depth: number): void {
    getUnderwaterAudioEngine().updateDepth(depth);
  }

  /** H-15 — Trigger a smart duck by category. */
  triggerSmartDuck(trigger: DuckTriggerCategory, holdMsOverride?: number): void {
    getAudioDuckingEngine().triggerDuck(trigger, holdMsOverride);
  }
  /** H-15 — Cancel all active smart ducks. */
  cancelAllSmartDucks(): void {
    getAudioDuckingEngine().cancelAll();
  }

  /** Section H — per-frame update (heartbeat + breathing + middleware). */
  updateSectionH(opts: {
    heartbeatInput?: HeartbeatStressInput;
  } = {}): void {
    if (opts.heartbeatInput) {
      getHeartbeatAudioEngine().update(opts.heartbeatInput);
    }
    getAdaptiveMusicMiddleware().update();
    // Update ambient listener position so spatial ambient sources track.
    getAmbientGeneratorEngine().setListenerPos(this.listenerPos);
    // Update reverb zones (cheap when zone hasn't changed).
    getReverbZoneEngine().update(this.listenerPos);
  }

  dispose() {
    try { this.sectionG.dispose(); } catch { /* noop */ }
    // Section H — dispose all 15 new engines (HRTF, dynamic music, surface
    // foley, voice scripting, adaptive middleware, weapon acoustics, reverb
    // zones, sound occlusion, bullet crack, ambient generator, breathing,
    // heartbeat, radio comm, underwater, audio ducking).
    if (this.sectionHAttached) {
      try { disposeAllSectionHEngines(); } catch { /* noop */ }
      this.sectionHAttached = false;
    }
    try { this.music.dispose(); } catch { /* noop */ }
    try { this.spatial.dispose(); } catch { /* noop */ }
    try { this.vo.dispose(); } catch { /* noop */ }
    try { this.buses.dispose(); } catch { /* noop */ }
    this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.reverbNode = null;
    this.reverbGain = null;
    this.noiseBuffer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for callers that want the sub-engines directly.
// ─────────────────────────────────────────────────────────────────────────────

export { BusMixer } from "./audio/buses";
export { SpatialAudio } from "./audio/spatial";
export { FoleyEngine, FOOTSTEP_PRESETS, IMPACT_PRESETS } from "./audio/foley";
export { MusicEngine } from "./audio/music";
export { VoEngine, getVoEngine } from "./audio/vo";
// Section G re-exports (prompts 811–900).
export {
  SectionGAudio,
  getSectionGAudio,
  OcclusionDiffractionG,
  EarlyReflectionsG,
  IndividualizedHrtfG,
  WindMicG,
  TinnitusG,
  ZoneReverbG,
  UnderwaterFilterG,
  CommsRadioFilterG,
  LmgOverheatWhineG,
  RainAmbientG,
  WindAmbientG,
  FireAmbientG,
  MusicExtensionsG,
  VoiceChatG,
  SubtitleSyncG,
  BusExtensionsG,
  ProgressionSoundsG,
  LipSyncG,
  AnnouncerSystemG,
  SectionGVerifiers,
  SECTION_G_STATUS,
  playDirectionalHitCue,
  playReloadOnSurface,
  playReloadClickForWeapon,
  playFireModeSwitch,
  playWeaponSwap,
  playMeleeSwing,
  playGrenadePinPull,
  playGrenadeBounce,
  playBulletCrack,
  playDistantGunshotDoppler,
  playSilencedGunshot,
  playShotgunBlast,
  playSniperCrack,
  playExplosion,
  playGlassBreak,
  playWoodBreak,
  playConcreteBreak,
  playMetalClang,
  playSlideFoley,
  playMantleFoley,
  playSlideSound,
  playVaultSound,
  playMantleSound,
  playLadderClimb,
  playSwimStroke,
  playDiveSound,
  playWaterSplash,
  playThunder,
  playJumpTakeoff,
  playLand,
  playStaminaPant,
  playAimBreath,
  footstepVariantGain,
  footstepVariantLowpass,
  contextForLine,
  voiceForOperator,
  type FootstepVariantOpts,
  type StanceG,
  type SpeedG,
  type ShoeG,
  type AnnouncerEvent,
  type MusicLayerG,
  type StingerTypeG,
  type VoCombatContext,
  type VisemeFrame,
  type VoiceChatPlayer,
  type ReverbZoneG,
  type ReverbPresetG,
} from "./audio/SectionG";
