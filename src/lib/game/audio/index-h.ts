/**
 * Section H — Audio & Immersion module index.
 *
 * Barrel export for all 15 Section H audio modules. Each module implements a
 * distinct audio feature from the Section H prompt library (5k prompts,
 * H_Audio_Immersion-00001 through -05000).
 *
 * Existing audio infrastructure (already in place):
 *   • audio/buses.ts         — BusMixer (sfx/music/vo/ui + ducking)
 *   • audio/spatial.ts       — SpatialAudio (HRTF panner + occlusion muffle)
 *   • audio/foley.ts         — FoleyEngine (6 surfaces: metal/concrete/sand/
 *                                water/wood/dirt)
 *   • audio/music.ts         — MusicEngine (3-stem calm/engaged/climax)
 *   • audio/vo.ts            — VoEngine (TTS-backed priority queue)
 *   • audio/SectionG.ts      — 90 enhancements (occlusion/diffraction,
 *                                HRTF SOFA, reverb zones, tinnitus, underwater
 *                                filter, comms radio, ambients, stingers, etc.)
 *   • audio/AudioEnhancements.ts — REVERB_PRESETS, MUSIC_STINGERS,
 *                                DUCKING_RULES, FOOTSTEP_SOUND_SETS (9 surfaces)
 *
 * Section H new modules (this directory):
 *   1. hrtf.ts               — HRTF profile manager (anthropometric customization)
 *   2. dynamic-music.ts      — Multi-stem adaptive music w/ horizontal resequencing
 *   3. surface-foley.ts      — Extended surface foley (9 surfaces, shoes, weight)
 *   4. voice-scripting.ts    — Context-aware dialogue w/ branching trees
 *   5. adaptive-middleware.ts — Music middleware w/ cue system + bar-accurate transitions
 *   6. weapon-acoustics.ts   — Per-caliber/barrel/env/ammo acoustic model
 *   7. reverb-zones.ts       — Per-room acoustics w/ multi-zone blending
 *   8. sound-occlusion.ts    — Frequency-dependent transmission loss + diffraction
 *   9. bullet-crack.ts       — Per-caliber supersonic crack + mach cone geometry
 *  10. ambient-generator.ts  — Procedural ambient scene generation
 *  11. breathing-audio.ts    — Breathing state machine synced to stamina
 *  12. heartbeat.ts          — Stress-driven heartbeat w/ BPM modulation
 *  13. radio-comm.ts         — Squad radio comms w/ Brevity codes + squelch
 *  14. underwater-audio.ts   — Depth-based LP filter + bubble sounds
 *  15. audio-ducking.ts      — Smart sidechain ducking w/ priority rules
 *
 * All audio is procedural (no external audio files needed). SSR-safe: every
 * module guards AudioContext access behind `attach()`.
 */

// HRTF profile manager — anthropometric HRTF customization.
export {
  HrtfProfileManager,
  getHrtfProfileManager,
  HRTF_PROFILES,
  DEFAULT_HRTF_PROFILE,
  type HrtfProfile,
} from "./hrtf";

// Dynamic music — multi-stem adaptive music w/ horizontal resequencing.
export {
  DynamicMusicEngine,
  getDynamicMusicEngine,
  DEFAULT_SECTIONS,
  TIER_STEM_GAINS,
  type MusicSection,
  type MusicStem,
  type CombatTier,
  type SectionDef,
} from "./dynamic-music";

// Surface foley — extended surface foley with shoes + weight modulation.
export {
  SurfaceFoleyEngine,
  getSurfaceFoleyEngine,
  EXTENDED_SURFACE_PRESETS,
  SHOE_MODIFIERS,
  type ExtendedSurface,
  type ShoeMaterial,
  type SurfaceFoleyPreset,
  type SurfaceFoleyOpts,
} from "./surface-foley";

// Voice scripting — context-aware dialogue with branching trees.
export {
  VoiceScriptingEngine,
  getVoiceScriptingEngine,
  OPERATOR_ARCHETYPES,
  type CharacterArchetype,
  type CombatPhase,
  type HealthTier,
  type AmmoTier,
  type SquadStatus,
  type VoiceLineContext,
  type VoiceLine,
  type VoiceLineEventId,
} from "./voice-scripting";

// Adaptive middleware — cue system + bar-accurate transitions.
export {
  AdaptiveMusicMiddleware,
  getAdaptiveMusicMiddleware,
  CUE_DEFS,
  type CueId,
  type CueDef,
  type CueSynth,
} from "./adaptive-middleware";

// Weapon acoustics — per-caliber/barrel/env/ammo acoustic model.
export {
  WeaponAcousticsEngine,
  getWeaponAcousticsEngine,
  CALIBER_PROFILES,
  suggestBarrelLength,
  suggestCaliber,
  type WeaponCaliber,
  type BarrelLength,
  type WeaponEnvironment,
  type AmmoType,
  type WeaponAcousticParams,
} from "./weapon-acoustics";

// Reverb zones — per-room acoustics w/ multi-zone blending.
export {
  ReverbZoneEngine,
  getReverbZoneEngine,
  REVERB_PRESETS_H,
  type ReverbEnvironmentH,
  type ReverbZoneH,
  type ReverbPresetH,
} from "./reverb-zones";

// Sound occlusion — frequency-dependent transmission loss + diffraction.
export {
  SoundOcclusionEngine,
  getSoundOcclusionEngine,
  MATERIAL_TRANSMISSION,
  computeOcclusion,
  guessWallMaterial,
  type WallMaterial,
  type MaterialTransmission,
  type OcclusionRay,
  type OcclusionParams,
} from "./sound-occlusion";

// Bullet crack — per-caliber supersonic crack + mach cone geometry.
export {
  BulletCrackEngine,
  getBulletCrackEngine,
  BULLET_PROFILES,
  type BulletCaliber,
  type BulletProfile,
  type Vec3H,
} from "./bullet-crack";

// Ambient generator — procedural ambient scene generation.
export {
  AmbientGeneratorEngine,
  getAmbientGeneratorEngine,
  AMBIENT_SCENES,
  type AmbientSourceH,
  type AmbientSourceDef,
  type AmbientSceneDef,
} from "./ambient-generator";

// Breathing audio — full breathing state machine synced to stamina.
export {
  BreathingAudioEngine,
  getBreathingAudioEngine,
  BREATH_PROFILES,
  deriveBreathState,
  type BreathState,
  type BreathProfile,
} from "./breathing-audio";

// Heartbeat — stress-driven heartbeat with BPM modulation.
export {
  HeartbeatAudioEngine,
  getHeartbeatAudioEngine,
  type HeartbeatStressInput,
} from "./heartbeat";

// Vitals audio — unified breathing + heartbeat orchestrator (one attach / start /
// update / stop / dispose lifecycle driven by a single VitalsInput snapshot).
export {
  VitalsAudioEngine,
  getVitalsAudioEngine,
  resetVitalsAudioEngine,
  type VitalsInput,
  type VitalsAudioSnapshot,
} from "./breathing-heartbeat";

// Radio comm — squad radio comms with Brevity codes + squelch.
export {
  RadioCommEngine,
  getRadioCommEngine,
  BREVITY_CODES,
  type BrevityCode,
  type RadioTransmission,
} from "./radio-comm";

// Underwater audio — depth-based LP filter + bubble sounds.
export {
  UnderwaterAudioEngine,
  getUnderwaterAudioEngine,
} from "./underwater-audio";

// Audio ducking — smart sidechain ducking with priority rules.
export {
  AudioDuckingEngine,
  getAudioDuckingEngine,
  SMART_DUCK_RULES,
  type DuckCurve,
  type DuckTriggerCategory,
  type SmartDuckRule,
} from "./audio-ducking";

/**
 * Convenience: attach ALL Section H engines to a given AudioContext + BusMixer.
 * Used by AudioEngine.init() to wire all sub-engines in one call.
 */
export function attachAllSectionHEngines(
  ctx: AudioContext,
  buses: import("./buses").BusMixer,
  noiseBuffer: AudioBuffer,
  reverbSend?: AudioNode | null,
): {
  hrtf: import("./hrtf").HrtfProfileManager;
  dynamicMusic: import("./dynamic-music").DynamicMusicEngine;
  surfaceFoley: import("./surface-foley").SurfaceFoleyEngine;
  voiceScripting: import("./voice-scripting").VoiceScriptingEngine;
  middleware: import("./adaptive-middleware").AdaptiveMusicMiddleware;
  weapon: import("./weapon-acoustics").WeaponAcousticsEngine;
  reverb: import("./reverb-zones").ReverbZoneEngine;
  occlusion: import("./sound-occlusion").SoundOcclusionEngine;
  bullet: import("./bullet-crack").BulletCrackEngine;
  ambient: import("./ambient-generator").AmbientGeneratorEngine;
  breathing: import("./breathing-audio").BreathingAudioEngine;
  heartbeat: import("./heartbeat").HeartbeatAudioEngine;
  radio: import("./radio-comm").RadioCommEngine;
  underwater: import("./underwater-audio").UnderwaterAudioEngine;
  ducking: import("./audio-ducking").AudioDuckingEngine;
} {
  const hrtf = getHrtfProfileManager();
  hrtf.attach(ctx, buses);
  const dynamicMusic = getDynamicMusicEngine();
  dynamicMusic.attach(ctx, buses, noiseBuffer);
  const surfaceFoley = getSurfaceFoleyEngine();
  surfaceFoley.attach(ctx, buses, noiseBuffer);
  const voiceScripting = getVoiceScriptingEngine(); // pure data — no attach
  void voiceScripting;
  const middleware = getAdaptiveMusicMiddleware();
  middleware.attach(ctx, buses, noiseBuffer, dynamicMusic);
  const weapon = getWeaponAcousticsEngine();
  weapon.attach(ctx, buses, noiseBuffer, reverbSend ?? null);
  const reverb = getReverbZoneEngine();
  reverb.attach(ctx, buses);
  const occlusion = getSoundOcclusionEngine();
  occlusion.attach(ctx, buses);
  const bullet = getBulletCrackEngine();
  bullet.attach(ctx, buses, noiseBuffer);
  const ambient = getAmbientGeneratorEngine();
  ambient.attach(ctx, buses, noiseBuffer);
  const breathing = getBreathingAudioEngine();
  breathing.attach(ctx, buses, noiseBuffer);
  const heartbeat = getHeartbeatAudioEngine();
  heartbeat.attach(ctx, buses);
  const radio = getRadioCommEngine();
  radio.attach(ctx, buses, noiseBuffer);
  const underwater = getUnderwaterAudioEngine();
  underwater.attach(ctx, buses, noiseBuffer);
  const ducking = getAudioDuckingEngine();
  ducking.attach(ctx, buses);
  return {
    hrtf, dynamicMusic, surfaceFoley, voiceScripting,
    middleware, weapon, reverb, occlusion, bullet,
    ambient, breathing, heartbeat, radio, underwater, ducking,
  };
}

/**
 * Dispose ALL Section H engines. Used by AudioEngine.dispose().
 */
export function disposeAllSectionHEngines(): void {
  try { getHrtfProfileManager().dispose(); } catch { /* noop */ }
  try { getDynamicMusicEngine().dispose(); } catch { /* noop */ }
  try { getSurfaceFoleyEngine().dispose(); } catch { /* noop */ }
  try { getAdaptiveMusicMiddleware().dispose(); } catch { /* noop */ }
  try { getWeaponAcousticsEngine().dispose(); } catch { /* noop */ }
  try { getReverbZoneEngine().dispose(); } catch { /* noop */ }
  try { getSoundOcclusionEngine().dispose(); } catch { /* noop */ }
  try { getBulletCrackEngine().dispose(); } catch { /* noop */ }
  try { getAmbientGeneratorEngine().dispose(); } catch { /* noop */ }
  try { getBreathingAudioEngine().dispose(); } catch { /* noop */ }
  try { getHeartbeatAudioEngine().dispose(); } catch { /* noop */ }
  try { getRadioCommEngine().dispose(); } catch { /* noop */ }
  try { getUnderwaterAudioEngine().dispose(); } catch { /* noop */ }
  try { getAudioDuckingEngine().dispose(); } catch { /* noop */ }
}
