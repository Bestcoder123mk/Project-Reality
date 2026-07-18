/**
 * §8 Audio — backlog items 176–200.
 *
 * Self-contained enhancement layer over audio.ts, buses.ts, music.ts,
 * spatial.ts, foley.ts, vo.ts. Adds reverb zones, music stingers, footstep
 * surface variety, audio ducking, positional reload, distinct silenced
 * profiles, audio settings granularity, low-HP heartbeat variation,
 * grenade cook-off ticking, empty-mag cues, positional AI barks,
 * underwater filter, directional-hit cue, layered reload foley, multi-wall
 * occlusion, subtitle sync, wind-whistle, mode-specific stingers, crowd
 * ambience, audio test mode, sound-based detection difficulty, blind audio
 * playtest template.
 *
 * ─── G-5000 prompt mapping ────────────────────────────────────────────────
 * This file owns the data tables + helpers consumed by audio.ts and
 * AudioSystem.ts. The wiring sites are owned by those files.
 *   #3414 → G2 #125 — single global reverb → zone-based    [REVERB_PRESETS (6 presets) + findReverbZone + ReverbZone type]
 *   #3428 → G2 #139 — DUCKING_RULES table dead              [DUCKING_RULES table; consumed by BusMixer.duckForTrigger]
 *   #3429 → G2 #140 — MUSIC_STINGERS never played           [MUSIC_STINGERS table; consumed by AudioSystem.updateStingers]
 *   #3430 → G2 #141 — DIRECTIONAL_HIT_CUES never played     [DIRECTIONAL_HIT_CUES + pickDirectionalHitCue; consumed by AudioSystem.updateDirectionalHitCue]
 *   #3431 → G2 #142 — grenadeTickInterval never called      [grenadeTickInterval(remainingMs, totalMs); consumed by AudioSystem.onGrenadeCookTick]
 *   #3539 → G  #826 — (cross-ref to #3449 — zone reverb helpers used by ZoneReverbG)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// §8 #176 — HRTF orientation verification (doc + test cue)
// ─────────────────────────────────────────────────────────────────────────────

export const HRTF_TEST_CUE = {
  /** Play a sound source rotating around the player's head to verify HRTF. */
  cueId: "hrtf_test_rotation",
  /** Duration (s) for a full 360° rotation. */
  rotationDurationS: 8,
  /** Test instructions for the player. */
  instructions:
    "Close your eyes. A sound source will rotate around your head. Verify you can localize it (front, right, back, left) using stereo headphones only.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §8 #177 — Footstep surface-type sound sets
// ─────────────────────────────────────────────────────────────────────────────

export type FootstepSurface =
  | "metal"
  | "wood"
  | "grass"
  | "water"
  | "sand"
  | "dirt"
  | "concrete"
  | "snow"
  | "gravel";

export interface FootstepSoundSet {
  surface: FootstepSurface;
  /** Sound file slugs for variety (random per step). */
  variants: string[];
  /** Volume multiplier (some surfaces are quieter). */
  volumeMult: number;
  /** Pitch multiplier. */
  pitchMult: number;
}

export const FOOTSTEP_SOUND_SETS: Record<FootstepSurface, FootstepSoundSet> = {
  metal: { surface: "metal", variants: ["footstep_metal_1", "footstep_metal_2", "footstep_metal_3"], volumeMult: 0.8, pitchMult: 1.0 },
  wood: { surface: "wood", variants: ["footstep_wood_1", "footstep_wood_2", "footstep_wood_3"], volumeMult: 0.7, pitchMult: 1.0 },
  grass: { surface: "grass", variants: ["footstep_grass_1", "footstep_grass_2", "footstep_grass_3"], volumeMult: 0.5, pitchMult: 1.0 },
  water: { surface: "water", variants: ["footstep_water_1", "footstep_water_2"], volumeMult: 0.9, pitchMult: 0.9 },
  sand: { surface: "sand", variants: ["footstep_sand_1", "footstep_sand_2"], volumeMult: 0.4, pitchMult: 0.95 },
  dirt: { surface: "dirt", variants: ["footstep_dirt_1", "footstep_dirt_2", "footstep_dirt_3"], volumeMult: 0.6, pitchMult: 1.0 },
  concrete: { surface: "concrete", variants: ["footstep_concrete_1", "footstep_concrete_2", "footstep_concrete_3"], volumeMult: 0.75, pitchMult: 1.0 },
  snow: { surface: "snow", variants: ["footstep_snow_1", "footstep_snow_2"], volumeMult: 0.5, pitchMult: 0.9 },
  gravel: { surface: "gravel", variants: ["footstep_gravel_1", "footstep_gravel_2", "footstep_gravel_3"], volumeMult: 0.7, pitchMult: 1.05 },
};

export function getFootstepSound(surface: FootstepSurface): string {
  const set = FOOTSTEP_SOUND_SETS[surface];
  return set.variants[Math.floor(Math.random() * set.variants.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #178 — Reverb zones per environment
// ─────────────────────────────────────────────────────────────────────────────

export type ReverbPreset = "indoor" | "outdoor" | "tunnel" | "warehouse" | "cavern" | "alley";

export interface ReverbZone {
  /** AABB bounds of the zone. */
  min: [number, number, number];
  max: [number, number, number];
  preset: ReverbPreset;
  /** Reverb decay (s). */
  decay: number;
  /** Wet/dry mix 0..1. */
  wet: number;
}

export const REVERB_PRESETS: Record<ReverbPreset, Omit<ReverbZone, "min" | "max" | "preset">> = {
  indoor: { decay: 0.8, wet: 0.2 },
  outdoor: { decay: 0.3, wet: 0.05 },
  tunnel: { decay: 2.5, wet: 0.6 },
  warehouse: { decay: 1.6, wet: 0.4 },
  cavern: { decay: 3.5, wet: 0.7 },
  alley: { decay: 1.0, wet: 0.3 },
};

/**
 * Find the reverb zone containing a position. Returns null if none.
 */
export function findReverbZone(pos: [number, number, number], zones: ReverbZone[]): ReverbZone | null {
  for (const z of zones) {
    if (
      pos[0] >= z.min[0] && pos[0] <= z.max[0] &&
      pos[1] >= z.min[1] && pos[1] <= z.max[1] &&
      pos[2] >= z.min[2] && pos[2] <= z.max[2]
    ) {
      return z;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #179 — Dynamic music stinger for clutch moments
// ─────────────────────────────────────────────────────────────────────────────

export type StingerType = "last_alive" | "clutch" | "multikill" | "downed_enemy" | "victory_close";

export interface MusicStinger {
  type: StingerType;
  /** Sound file slug. */
  cueId: string;
  /** Music duck amount 0..1 (1 = full duck while stinger plays). */
  duckAmount: number;
  /** Duration (s). */
  durationS: number;
}

export const MUSIC_STINGERS: Record<StingerType, MusicStinger> = {
  last_alive: { type: "last_alive", cueId: "stinger_last_alive", duckAmount: 0.6, durationS: 4 },
  clutch: { type: "clutch", cueId: "stinger_clutch", duckAmount: 0.5, durationS: 3 },
  multikill: { type: "multikill", cueId: "stinger_multikill", duckAmount: 0.4, durationS: 2 },
  downed_enemy: { type: "downed_enemy", cueId: "stinger_downed_enemy", duckAmount: 0.3, durationS: 1.5 },
  victory_close: { type: "victory_close", cueId: "stinger_victory_close", duckAmount: 0.7, durationS: 5 },
};

// ─────────────────────────────────────────────────────────────────────────────
// §8 #180 — Distinct death/downed audio cue
// ─────────────────────────────────────────────────────────────────────────────

export const DEATH_CUES = {
  player_downed: "player_downed_cue",
  enemy_downed: "enemy_downed_cue",
  enemy_killed: "enemy_killed_cue", // distinct from hit-marker
  player_killed: "player_killed_cue",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §8 #181 — Ambient environmental audio loops per map
// ─────────────────────────────────────────────────────────────────────────────

export type AmbientType = "wind" | "distant_traffic" | "birds" | "rain" | "city_hum" | "forest" | "industrial_hum" | "ocean";

export interface MapAmbient {
  mapId: string;
  primary: AmbientType;
  /** Optional secondary layer (lower volume). */
  secondary?: AmbientType;
  /** Volume 0..1. */
  volume: number;
}

export const MAP_AMBIENTS: MapAmbient[] = [
  { mapId: "compound", primary: "wind", secondary: "distant_traffic", volume: 0.4 },
  { mapId: "warehouse", primary: "industrial_hum", volume: 0.5 },
  { mapId: "urban", primary: "city_hum", secondary: "distant_traffic", volume: 0.6 },
  { mapId: "forest", primary: "forest", secondary: "birds", volume: 0.5 },
  { mapId: "desert", primary: "wind", volume: 0.7 },
  { mapId: "coastal", primary: "ocean", secondary: "wind", volume: 0.6 },
];

export function getMapAmbient(mapId: string): MapAmbient | null {
  return MAP_AMBIENTS.find((a) => a.mapId === mapId) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #182 — Audio ducking verification (VO barks duck gunfire)
// ─────────────────────────────────────────────────────────────────────────────

export interface DuckingRule {
  /** The bus that triggers ducking. */
  trigger: "vo" | "announcer" | "stinger";
  /** The buses to duck. */
  ducked: Array<"music" | "sfx" | "ambience">;
  /** Duck amount 0..1 (1 = full mute while trigger plays). */
  amount: number;
  /** Attack (ms). */
  attackMs: number;
  /** Release (ms). */
  releaseMs: number;
}

export const DUCKING_RULES: DuckingRule[] = [
  { trigger: "vo", ducked: ["music"], amount: 0.4, attackMs: 50, releaseMs: 300 },
  { trigger: "announcer", ducked: ["music", "sfx", "ambience"], amount: 0.7, attackMs: 30, releaseMs: 500 },
  { trigger: "stinger", ducked: ["music"], amount: 0.6, attackMs: 20, releaseMs: 400 },
];

// ─────────────────────────────────────────────────────────────────────────────
// §8 #183 — Positional audio for reload sounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the 3D position for a reload sound. Should be the weapon's world
 * position (not center-panned).
 */
export function getReloadSoundPosition(weaponPos: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  // Slightly offset toward the right ear (right-handed weapon hold).
  return {
    x: weaponPos.x + 0.15,
    y: weaponPos.y - 0.1,
    z: weaponPos.z,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #184 — Distinct silenced-weapon audio profile
// ─────────────────────────────────────────────────────────────────────────────

export interface SilencedProfile {
  /** Sound slug (different timbre from unsilenced). */
  cueId: string;
  /** Volume multiplier (much quieter). */
  volumeMult: number;
  /** Whether the mechanical crack is removed. */
  noCrack: boolean;
  /** High-frequency rolloff (silenced = darker). */
  rolloffHz: number;
}

export const SILENCED_PROFILES: Record<string, SilencedProfile> = {
  rifle: { cueId: "rifle_fire_silenced", volumeMult: 0.3, noCrack: true, rolloffHz: 3000 },
  pistol: { cueId: "pistol_fire_silenced", volumeMult: 0.25, noCrack: true, rolloffHz: 3500 },
  smg: { cueId: "smg_fire_silenced", volumeMult: 0.3, noCrack: true, rolloffHz: 3200 },
};

// ─────────────────────────────────────────────────────────────────────────────
// §8 #185 — Audio settings granularity (separate sliders)
// ─────────────────────────────────────────────────────────────────────────────

export interface AudioSettings {
  master: number; // 0..1
  music: number;
  sfx: number;
  voice: number;
  ui: number;
  ambience: number;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  master: 1.0,
  music: 0.7,
  sfx: 0.9,
  voice: 0.8,
  ui: 0.6,
  ambience: 0.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// §8 #186 — Low-health heartbeat variation
// ─────────────────────────────────────────────────────────────────────────────

export interface HeartbeatState {
  /** Whether heartbeat is playing. */
  active: boolean;
  /** Current BPM. */
  bpm: number;
  /** Last beat timestamp (ms). */
  lastBeatMs: number;
  /** Variation seed (so it doesn't get monotonous). */
  variationSeed: number;
}

export function createHeartbeatState(): HeartbeatState {
  return { active: false, bpm: 80, lastBeatMs: 0, variationSeed: 0 };
}

/**
 * Update heartbeat based on HP fraction. Returns whether a beat should
 * play this frame.
 */
export function updateHeartbeat(
  state: HeartbeatState,
  hpFraction: number,
  now: number,
): boolean {
  if (hpFraction > 0.35) {
    state.active = false;
    return false;
  }
  state.active = true;
  // BPM scales from 80 (full HP threshold) to 140 (near death).
  state.bpm = 80 + Math.round((1 - hpFraction / 0.35) * 60);
  // Add slight variation (±5 BPM) using the seed to avoid monotony.
  state.variationSeed = (state.variationSeed + 1) % 100;
  const variation = ((state.variationSeed * 7) % 11) - 5;
  const effectiveBpm = state.bpm + variation;
  const beatIntervalMs = 60_000 / effectiveBpm;
  if (now - state.lastBeatMs >= beatIntervalMs) {
    state.lastBeatMs = now;
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #187 — Grenade cook-off ticking sound
// ─────────────────────────────────────────────────────────────────────────────

export const GRENADE_COOK_TICK_CUE = "grenade_cook_tick";

/**
 * Get the tick interval (ms) based on remaining fuse. Ticks speed up as
 * the fuse runs down.
 */
export function grenadeTickInterval(remainingFuseMs: number, totalFuseMs: number): number {
  const progress = 1 - remainingFuseMs / totalFuseMs;
  // 1000ms → 200ms as the fuse runs down.
  return 1000 - 800 * progress;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #188 — Empty-mag reload cue (distinct from dry-fire click)
// ─────────────────────────────────────────────────────────────────────────────

export const EMPTY_MAG_CUE = "empty_mag_reload_prompt";

// ─────────────────────────────────────────────────────────────────────────────
// §8 #189 — Positional AI barks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the 3D position for an AI bark. Should be the AI's world position
 * (not centered).
 */
export function getAIBarkPosition(aiPos: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return aiPos; // barks come from the AI's mouth
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #190 — Underwater audio filter
// ─────────────────────────────────────────────────────────────────────────────

export interface UnderwaterFilterState {
  /** Whether the filter is active. */
  active: boolean;
  /** Lowpass cutoff (Hz) — underwater muffles high frequencies. */
  cutoffHz: number;
  /** Gain reduction (dB). */
  gainReductionDb: number;
}

export function createUnderwaterFilter(): UnderwaterFilterState {
  return { active: false, cutoffHz: 800, gainReductionDb: -6 };
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #191 — Directional "flanked/shot from behind" cue
// ─────────────────────────────────────────────────────────────────────────────

export interface DirectionalHitCue {
  /** Angle (radians) relative to player facing. 0 = front, π = behind. */
  angle: number;
  /** Cue sound slug. */
  cueId: string;
}

export const DIRECTIONAL_HIT_CUES = {
  front: "hit_cue_front",
  side_left: "hit_cue_side_left",
  side_right: "hit_cue_side_right",
  behind: "hit_cue_behind",
} as const;

/**
 * Pick the directional cue based on the hit angle relative to player facing.
 */
export function pickDirectionalHitCue(hitAngle: number): string {
  const abs = Math.abs(hitAngle);
  if (abs < Math.PI / 4) return DIRECTIONAL_HIT_CUES.front;
  if (hitAngle < -Math.PI / 4 && hitAngle > -3 * Math.PI / 4) return DIRECTIONAL_HIT_CUES.side_left;
  if (hitAngle > Math.PI / 4 && hitAngle < 3 * Math.PI / 4) return DIRECTIONAL_HIT_CUES.side_right;
  return DIRECTIONAL_HIT_CUES.behind;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #192 — Per-weapon reload foley variety (layered)
// ─────────────────────────────────────────────────────────────────────────────

export interface ReloadFoleyLayer {
  /** Layer name. */
  name: "mag_out" | "mag_in" | "bolt_rack" | "safety_click";
  /** Sound slug. */
  cueId: string;
  /** Time offset within the reload (s). */
  offsetS: number;
  /** Volume 0..1. */
  volume: number;
}

export const RELOAD_FOLEY_LAYERS: Record<string, ReloadFoleyLayer[]> = {
  rifle: [
    { name: "mag_out", cueId: "rifle_mag_out", offsetS: 0, volume: 0.8 },
    { name: "mag_in", cueId: "rifle_mag_in", offsetS: 0.8, volume: 0.9 },
    { name: "bolt_rack", cueId: "rifle_bolt_rack", offsetS: 1.5, volume: 0.7 },
  ],
  pistol: [
    { name: "mag_out", cueId: "pistol_mag_out", offsetS: 0, volume: 0.7 },
    { name: "mag_in", cueId: "pistol_mag_in", offsetS: 0.5, volume: 0.8 },
    { name: "safety_click", cueId: "pistol_safety", offsetS: 1.0, volume: 0.5 },
  ],
  sniper: [
    { name: "mag_out", cueId: "sniper_mag_out", offsetS: 0, volume: 0.7 },
    { name: "mag_in", cueId: "sniper_mag_in", offsetS: 1.2, volume: 0.8 },
    { name: "bolt_rack", cueId: "sniper_bolt_rack", offsetS: 2.0, volume: 0.9 },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// §8 #193 — Multi-wall occlusion (thickness-based)
// ─────────────────────────────────────────────────────────────────────────────

export interface OcclusionRay {
  /** Total wall thickness the sound passes through (m). */
  totalThickness: number;
  /** Number of walls. */
  wallCount: number;
}

/**
 * Compute the occlusion gain reduction (dB) based on total wall thickness.
 * Each meter of wall ≈ -3dB. Binary occluded/not is replaced with a curve.
 */
export function occlusionGainReductionDb(ray: OcclusionRay): number {
  return -3 * ray.totalThickness;
}

/**
 * Compute the occlusion lowpass cutoff (Hz). More walls = darker.
 */
export function occlusionLowpassHz(ray: OcclusionRay): number {
  return Math.max(200, 8000 - ray.totalThickness * 1500);
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #194 — Subtitle audio-sync verification
// ─────────────────────────────────────────────────────────────────────────────

export interface SubtitleEntry {
  /** Text to display. */
  text: string;
  /** Speaker name. */
  speaker: string;
  /** Audio cue id this subtitle is synced to. */
  audioCueId: string;
  /** Display duration (ms). */
  durationMs: number;
}

export interface SubtitleSyncState {
  /** Current displayed subtitle (or null). */
  current: SubtitleEntry | null;
  /** Timestamp the subtitle was displayed (ms). */
  shownAtMs: number;
}

export function createSubtitleSyncState(): SubtitleSyncState {
  return { current: null, shownAtMs: 0 };
}

/**
 * Show a subtitle synced to an audio cue. Call when the audio cue plays.
 */
export function showSubtitle(state: SubtitleSyncState, entry: SubtitleEntry, now: number): void {
  state.current = entry;
  state.shownAtMs = now;
}

/**
 * Update subtitle state. Clears the subtitle if its duration has elapsed.
 */
export function updateSubtitle(state: SubtitleSyncState, now: number): void {
  if (!state.current) return;
  if (now - state.shownAtMs >= state.current.durationMs) {
    state.current = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #195 — Dynamic wind-strength affects whistling sound
// ─────────────────────────────────────────────────────────────────────────────

export interface WindAudioState {
  /** Current wind speed (m/s). */
  windSpeed: number;
  /** Whistle volume 0..1 (driven by wind speed). */
  whistleVolume: number;
  /** Whistle pitch (driven by wind speed). */
  whistlePitch: number;
}

export function updateWindAudio(state: WindAudioState, windSpeed: number): void {
  state.windSpeed = windSpeed;
  // Whistle only above 5 m/s, ramps to full at 20 m/s.
  state.whistleVolume = Math.max(0, Math.min(1, (windSpeed - 5) / 15));
  // Pitch rises with wind speed.
  state.whistlePitch = 0.8 + windSpeed * 0.04;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #196 — Distinct victory/defeat stingers per game mode
// ─────────────────────────────────────────────────────────────────────────────

export type GameModeStinger = "victory" | "defeat";

export const MODE_STINGERS: Record<string, Record<GameModeStinger, string>> = {
  default: { victory: "stinger_victory", defeat: "stinger_defeat" },
  horde: { victory: "stinger_horde_victory", defeat: "stinger_horde_defeat" },
  boss: { victory: "stinger_boss_victory", defeat: "stinger_boss_defeat" },
  extraction: { victory: "stinger_extraction_victory", defeat: "stinger_extraction_defeat" },
};

export function getModeStinger(mode: string, type: GameModeStinger): string {
  return (MODE_STINGERS[mode] ?? MODE_STINGERS.default)[type];
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #197 — Crowd/spectator ambience
// ─────────────────────────────────────────────────────────────────────────────

export const CROWD_AMBIENCE = {
  cheer: "crowd_cheer",
  gasp: "crowd_gasp",
  clap: "crowd_clap",
  boo: "crowd_boo",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §8 #198 — Audio test mode in settings
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIO_TEST_CUES = [
  { id: "music_test", label: "Music", category: "music" as const },
  { id: "sfx_test_gunfire", label: "Gunfire", category: "sfx" as const },
  { id: "sfx_test_footstep", label: "Footstep", category: "sfx" as const },
  { id: "voice_test", label: "Voice", category: "voice" as const },
  { id: "ui_test_click", label: "UI Click", category: "ui" as const },
  { id: "ambience_test_wind", label: "Ambience", category: "ambience" as const },
];

// ─────────────────────────────────────────────────────────────────────────────
// §8 #199 — Sound-based enemy detection difficulty
// ─────────────────────────────────────────────────────────────────────────────

export const SOUND_DETECTION_MULT: Record<string, number> = {
  easy: 0.5, // louder footsteps (easier to detect)
  normal: 1.0,
  hard: 1.5, // quieter footsteps (harder to detect)
  insane: 2.0,
};

/**
 * Get the footstep loudness multiplier for a difficulty.
 */
export function footstepLoudnessMult(difficulty: string): number {
  return SOUND_DETECTION_MULT[difficulty] ?? 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 #200 — Blind audio playtest doc
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIO_BLIND_PLAYTEST_DOC_PATH = "docs/AUDIO-BLIND-PLAYTEST.md";

// ─────────────────────────────────────────────────────────────────────────────
// §8 summary
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_8_STATUS = {
  hrtfVerify: "code+doc (HRTF_TEST_CUE — player-runnable localization test)",
  footstepSurfaceVariety: "code (FOOTSTEP_SOUND_SETS — 9 surface types)",
  reverbZones: "code (ReverbZone + REVERB_PRESETS + findReverbZone)",
  musicStingers: "code (MUSIC_STINGERS — last_alive/clutch/multikill/downed/victory_close)",
  deathDownedCue: "code (DEATH_CUES — distinct from hit-marker)",
  ambientLoops: "code (MAP_AMBIENTS — per-map primary + secondary layers)",
  audioDucking: "code (DUCKING_RULES — VO/announcer/stinger duck music/sfx/ambience)",
  positionalReload: "code (getReloadSoundPosition — weapon-localized)",
  silencedProfile: "code (SILENCED_PROFILES — distinct timbre, no mechanical crack)",
  audioSettingsGranularity: "code (AudioSettings — master/music/sfx/voice/ui/ambience sliders)",
  lowHealthHeartbeat: "code (updateHeartbeat — BPM scales with HP loss, ±5 variation)",
  grenadeCookTick: "code (grenadeTickInterval + GRENADE_COOK_TICK_CUE)",
  emptyMagCue: "code (EMPTY_MAG_CUE — distinct from dry-fire click)",
  positionalAIBarks: "code (getAIBarkPosition — enemy-localized)",
  underwaterFilter: "code (UnderwaterFilterState — lowpass + gain reduction)",
  directionalHitCue: "code (pickDirectionalHitCue — front/side/behind)",
  reloadFoleyLayers: "code (RELOAD_FOLEY_LAYERS — mag-out/in/bolt-rack/safety layered)",
  multiWallOcclusion: "code (occlusionGainReductionDb + occlusionLowpassHz — thickness-based)",
  subtitleSync: "code (SubtitleSyncState — audio-cue-synced display)",
  windWhistle: "code (updateWindAudio — wind speed drives whistle volume + pitch)",
  modeStingers: "code (MODE_STINGERS — per-mode victory/defeat)",
  crowdAmbience: "code (CROWD_AMBIENCE — cheer/gasp/clap/boo)",
  audioTestMode: "code (AUDIO_TEST_CUES — settings play-each-category)",
  soundDetectionDifficulty: "code (footstepLoudnessMult — easy=loud, insane=quiet)",
  blindAudioPlaytest: "doc (docs/AUDIO-BLIND-PLAYTEST.md — eyes-closed match template)",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Section G (prompts 811–900) — pointer table.
//
// The full Section G implementation lives in `src/lib/game/audio/SectionG.ts`
// (~1000 LOC, 90 prompts). The orchestrator can read SECTION_G_STATUS from
// there for a per-prompt status report. The helpers below are stubs that
// delegate to the SectionG module — they exist so callers that already
// import from `audio/AudioEnhancements.ts` can reach the new functionality
// without churn.
// ─────────────────────────────────────────────────────────────────────────────

export {
  SECTION_G_STATUS as SECTION_G_STATUS_POINTER,
  getSectionGAudio as getSectionGAudioPointer,
  type SectionGAudio as SectionGAudioPointer,
} from "./SectionG";
