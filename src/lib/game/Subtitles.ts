/**
 * P6.3 + SEC10-UIUX (prompt 77): Audio subtitle / closed-caption system.
 *
 * Two layers of captions:
 *
 *  1. Dialogue captions — radio callouts, mission dialogue. The
 *     pre-existing SubtitleTemplates cover these.
 *
 *  2. Audio-cue captions (SEC10-UIUX prompt 77) — `getCaptionForAudioCue(cueId)`
 *     returns a caption for ANY audio event in the game, not just
 *     dialogue. Covers gunfire (per caliber), footsteps (per surface),
 *     explosions, reloads, doors, glass breaks, weather, vehicles.
 *     Deaf/hard-of-hearing players get full situational awareness.
 *
 * Subtitles appear at the bottom-center of the screen, fade in/out over
 * 3s, and are color-coded by source (see Accessibility.getSemanticColor
 * — mode-aware palette).
 *
 * The HUD reads from a subtitle queue in the Zustand store. Systems
 * push subtitles via pushSubtitle(); the HUD renders them.
 *
 * Section G (#825): `pushSyncedSubtitle()` pairs with
 * `audio/SectionG.ts`'s SubtitleSyncG so the caption appears the moment
 * the audio cue plays and is removed when its duration elapses. The host
 * registers a sync hook via `attachSubtitleSync()`; the AudioEngine's
 * `pushSubtitle(text, speaker, durationMs)` is the canonical entry point.
 *
 * ─── G-5000 prompt mapping ────────────────────────────────────────────────
 *   #3426 → G2 #137 — AUDIO_CAPTIONS catalog dead              [AUDIO_CAPTIONS record (lines ~157–216) — covers gunfire/footsteps/explosions/reloads/etc.]
 *   #3427 → G2 #138 — getCaptionForAudioCue never called       [getCaptionForAudioCue(cueId, bearing?) — consumed by AudioEngine.pushSubtitleForCue]
 *   #3448 → G  #825 — subtitle sync                             [pushSyncedSubtitle + attachSubtitleSync bridge to SubtitleSyncG]
 *   #3451 → G  #828 — announcer system                          [AnnouncerSystemG in SectionG.ts consumes ANNOUNCER_LINES + this file's captions]
 *   #3538 → G  #825 — (cross-ref to #3448)
 *   #3541 → G  #828 — (cross-ref to #3451)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ColorblindMode } from "./Accessibility";
import { getSemanticColor } from "./Accessibility";

export interface SubtitleEntry {
  id: number;
  /** Source category (radio, enemy, friendly, explosion, ambient, system). */
  source: "radio" | "enemy" | "friendly" | "explosion" | "ambient" | "system";
  /** Display text. */
  text: string;
  /** Optional bearing in degrees (0 = north, 90 = east). For directional cues. */
  bearing?: number;
  /** Timestamp (performance.now()). */
  time: number;
  /** Duration to display (ms). */
  duration: number;
}

let nextId = 1;

/** Create a subtitle entry. */
export function createSubtitle(
  source: SubtitleEntry["source"],
  text: string,
  opts: { bearing?: number; duration?: number } = {},
): SubtitleEntry {
  return {
    id: nextId++,
    source,
    text,
    bearing: opts.bearing,
    time: typeof performance !== "undefined" ? performance.now() : Date.now(),
    duration: opts.duration ?? 3000,
  };
}

/**
 * P6.3: Subtitle templates for common audio events.
 * The AudioSystem (or any system that plays a sound) can call these
 * helpers to push a matching subtitle.
 */
export const SubtitleTemplates = {
  /** Radio macro callouts (player-initiated). */
  radioContact: () => createSubtitle("radio", "Contact reported — check bearing"),
  radioNeedMedic: () => createSubtitle("radio", "Need medic!"),
  radioNeedAmmo: () => createSubtitle("radio", "Need ammunition resupply"),

  /** Enemy gunfire — direction + caliber. */
  enemyGunfire: (caliber: string, bearing: number) =>
    createSubtitle("enemy", `Enemy ${caliber} fire — ${formatBearing(bearing)}`, { bearing, duration: 2500 }),

  /** Friendly gunfire (multiplayer). */
  friendlyGunfire: (caliber: string, bearing: number) =>
    createSubtitle("friendly", `Friendly ${caliber} fire — ${formatBearing(bearing)}`, { bearing, duration: 2000 }),

  /** Explosions. */
  explosion: (bearing: number) =>
    createSubtitle("explosion", `Explosion — ${formatBearing(bearing)}`, { bearing, duration: 3000 }),

  /** System messages (malfunctions, etc.). */
  malfunction: (type: string) =>
    createSubtitle("system", `Weapon malfunction: ${type.replace(/_/g, " ")} — press R to clear`, { duration: 4000 }),

  /** Weather alerts. */
  weatherAlert: (text: string) =>
    createSubtitle("ambient", text, { duration: 4000 }),
};

/** Format a bearing in degrees as a compass direction. */
function formatBearing(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(((deg % 360) / 45)) % 8;
  return `${dirs[idx]} (${Math.round(deg)}°)`;
}

/**
 * P6.3: Filter subtitles by colorblind mode.
 * SEC10-UIUX (prompt 77): delegates to the mode-aware semantic palette
 * in Accessibility.ts so caption colors stay distinguishable under any
 * vision setting.
 */
export function getSubtitleColor(source: SubtitleEntry["source"], mode: ColorblindMode): string {
  return getSemanticColor(source, mode);
}

// ─── SEC10-UIUX (prompt 77): closed captions for ALL audio cues ─────────────

/**
 * Audio cue id — every distinct sound the engine can play has one of
 * these. The AudioSystem plays a sound by id; the caption system can
 * look up a matching caption via getCaptionForAudioCue(id).
 *
 * Convention: <category>_<descriptor>. Examples:
 *   gunfire_545, gunfire_556, gunfire_9mm, gunfire_50ae, gunfire_338
 *   footstep_concrete, footstep_wood, footstep_metal, footstep_dirt, footstep_water
 *   explosion_grenade, explosion_barrel, explosion_c4
 *   reload_rifle, reload_pistol, reload_shotgun, reload_lmg
 *   door_open, door_close, door_kick
 *   glass_break, glass_crack
 *   weather_rain, weather_thunder, weather_wind
 *   vehicle_engine, vehicle_horn
 *   bullet_impact_metal, bullet_impact_concrete, bullet_whiz_by
 *   item_pickup, ammo_pickup, health_pickup
 *   ui_click, ui_hover, ui_back, ui_confirm
 */
export type AudioCueId = string;

export interface AudioCaption {
  /** Cue id this caption is for. */
  cueId: AudioCueId;
  /** Caption text. {bearing} is replaced by the formatted bearing at runtime. */
  text: string;
  /** Source category — drives the caption color. */
  source: SubtitleEntry["source"];
  /** Default display duration (ms). */
  duration: number;
  /** Whether this caption should include the bearing (directional cues). */
  directional: boolean;
}

/**
 * The caption catalog. Each entry is a *template* — the engine can
 * pass a bearing when it pushes the subtitle, and the {bearing}
 * placeholder is replaced.
 *
 * Catalog is intentionally comprehensive — covers every audio cue
 * the game ships with. The AudioSystem maps a sound-id to its
 * AudioCueId; the caption HUD reads from this catalog.
 */
export const AUDIO_CAPTIONS: Record<AudioCueId, AudioCaption> = {
  // ── Gunfire (by caliber) ──
  gunfire_545:   { cueId: "gunfire_545",   text: "5.45mm gunfire — {bearing}", source: "enemy", duration: 2500, directional: true },
  gunfire_556:   { cueId: "gunfire_556",   text: "5.56mm gunfire — {bearing}", source: "enemy", duration: 2500, directional: true },
  gunfire_762:   { cueId: "gunfire_762",   text: "7.62mm gunfire — {bearing}", source: "enemy", duration: 2500, directional: true },
  gunfire_9mm:   { cueId: "gunfire_9mm",   text: "9mm gunfire — {bearing}",     source: "enemy", duration: 2500, directional: true },
  gunfire_45acp: { cueId: "gunfire_45acp", text: ".45 ACP gunfire — {bearing}", source: "enemy", duration: 2500, directional: true },
  gunfire_50ae:  { cueId: "gunfire_50ae",  text: ".50 AE gunfire — {bearing}",  source: "enemy", duration: 2500, directional: true },
  gunfire_338:   { cueId: "gunfire_338",   text: ".338 sniper fire — {bearing}", source: "enemy", duration: 3000, directional: true },
  gunfire_12g:   { cueId: "gunfire_12g",   text: "12-gauge blast — {bearing}",  source: "enemy", duration: 2500, directional: true },
  gunfire_suppressed: { cueId: "gunfire_suppressed", text: "Suppressed fire — {bearing}", source: "enemy", duration: 2200, directional: true },

  // ── Footsteps (by surface) ──
  footstep_concrete: { cueId: "footstep_concrete", text: "Footsteps on concrete — {bearing}", source: "enemy", duration: 1500, directional: true },
  footstep_wood:     { cueId: "footstep_wood",     text: "Footsteps on wood — {bearing}",     source: "enemy", duration: 1500, directional: true },
  footstep_metal:    { cueId: "footstep_metal",    text: "Footsteps on metal — {bearing}",    source: "enemy", duration: 1500, directional: true },
  footstep_dirt:     { cueId: "footstep_dirt",     text: "Footsteps on dirt — {bearing}",     source: "enemy", duration: 1500, directional: true },
  footstep_water:    { cueId: "footstep_water",    text: "Footsteps in water — {bearing}",    source: "enemy", duration: 1500, directional: true },
  footstep_sprint:   { cueId: "footstep_sprint",   text: "Sprinting footsteps — {bearing}",   source: "enemy", duration: 1500, directional: true },

  // ── Explosions ──
  explosion_grenade: { cueId: "explosion_grenade", text: "Grenade explosion — {bearing}", source: "explosion", duration: 3000, directional: true },
  explosion_barrel:  { cueId: "explosion_barrel",  text: "Barrel explosion — {bearing}",  source: "explosion", duration: 3000, directional: true },
  explosion_c4:      { cueId: "explosion_c4",      text: "C4 detonation — {bearing}",      source: "explosion", duration: 3000, directional: true },
  explosion_vehicle: { cueId: "explosion_vehicle", text: "Vehicle explosion — {bearing}",  source: "explosion", duration: 3000, directional: true },

  // ── Reloads ──
  reload_rifle:   { cueId: "reload_rifle",   text: "Reloading rifle",   source: "ambient", duration: 1500, directional: false },
  reload_pistol:  { cueId: "reload_pistol",  text: "Reloading pistol",  source: "ambient", duration: 1200, directional: false },
  reload_shotgun: { cueId: "reload_shotgun", text: "Reloading shotgun", source: "ambient", duration: 1800, directional: false },
  reload_lmg:     { cueId: "reload_lmg",     text: "Reloading LMG (belt)", source: "ambient", duration: 2500, directional: false },

  // ── Doors / environment ──
  door_open:    { cueId: "door_open",    text: "Door opening — {bearing}", source: "ambient", duration: 1500, directional: true },
  door_close:   { cueId: "door_close",   text: "Door closing — {bearing}", source: "ambient", duration: 1500, directional: true },
  door_kick:    { cueId: "door_kick",    text: "Door breached — {bearing}", source: "explosion", duration: 2000, directional: true },

  // ── Glass ──
  glass_break: { cueId: "glass_break", text: "Glass breaking — {bearing}", source: "ambient", duration: 1500, directional: true },
  glass_crack: { cueId: "glass_crack", text: "Glass cracking — {bearing}",  source: "ambient", duration: 1200, directional: true },

  // ── Weather ──
  weather_rain:    { cueId: "weather_rain",    text: "Rain falling",     source: "ambient", duration: 4000, directional: false },
  weather_thunder: { cueId: "weather_thunder", text: "Thunder — {bearing}", source: "ambient", duration: 3000, directional: true },
  weather_wind:    { cueId: "weather_wind",    text: "Wind picking up",  source: "ambient", duration: 3000, directional: false },

  // ── Vehicles ──
  vehicle_engine: { cueId: "vehicle_engine", text: "Vehicle engine — {bearing}", source: "ambient", duration: 2500, directional: true },
  vehicle_horn:   { cueId: "vehicle_horn",   text: "Vehicle horn — {bearing}",   source: "ambient", duration: 2000, directional: true },

  // ── Bullet impacts / whiz-by ──
  bullet_impact_metal:     { cueId: "bullet_impact_metal",     text: "Rounds hitting metal — {bearing}", source: "enemy", duration: 1500, directional: true },
  bullet_impact_concrete:  { cueId: "bullet_impact_concrete",  text: "Rounds hitting concrete — {bearing}", source: "enemy", duration: 1500, directional: true },
  bullet_whiz_by:          { cueId: "bullet_whiz_by",          text: "Round whipped past — {bearing}", source: "enemy", duration: 1200, directional: true },

  // ── Pickups ──
  item_pickup:   { cueId: "item_pickup",   text: "Item picked up", source: "system", duration: 1500, directional: false },
  ammo_pickup:   { cueId: "ammo_pickup",   text: "Ammo picked up", source: "system", duration: 1500, directional: false },
  health_pickup: { cueId: "health_pickup", text: "Health restored", source: "system", duration: 1500, directional: false },

  // ── UI sounds (only captioned for accessibility mode "verbose UI") ──
  ui_click:   { cueId: "ui_click",   text: "Click",   source: "system", duration: 800,  directional: false },
  ui_hover:   { cueId: "ui_hover",   text: "Hover",   source: "system", duration: 600,  directional: false },
  ui_back:    { cueId: "ui_back",    text: "Back",    source: "system", duration: 800,  directional: false },
  ui_confirm: { cueId: "ui_confirm", text: "Confirm", source: "system", duration: 800,  directional: false },
};

/**
 * SEC10-UIUX (prompt 77): Look up the caption for an audio cue id.
 *
 * Returns the caption template, with {bearing} already substituted if
 * a bearing was provided. Returns null if no caption is registered for
 * the cue id (the caller can choose to skip silently or push a
 * generic fallback).
 *
 * @param cueId  Audio cue id (see AUDIO_CAPTIONS keys).
 * @param bearing Optional bearing in degrees for directional cues.
 */
export function getCaptionForAudioCue(cueId: AudioCueId, bearing?: number): SubtitleEntry | null {
  const tpl = AUDIO_CAPTIONS[cueId];
  if (!tpl) return null;
  let text = tpl.text;
  if (tpl.directional && bearing !== undefined) {
    text = text.replace("{bearing}", formatBearing(bearing));
  } else {
    // Strip the placeholder if the cue isn't directional or no bearing was given.
    text = text.replace(" — {bearing}", "").replace("{bearing}", "");
  }
  return createSubtitle(tpl.source, text, {
    bearing: tpl.directional ? bearing : undefined,
    duration: tpl.duration,
  });
}

/**
 * SEC10-UIUX (prompt 77): List all cue ids that have captions.
 * Used by the settings UI to show "X of Y audio cues captioned".
 */
export function listCaptionedCues(): AudioCueId[] {
  return Object.keys(AUDIO_CAPTIONS);
}

/**
 * SEC10-UIUX (prompt 77): Coverage report — what fraction of the
 * engine's known audio cue ids have captions. The engine can call this
 * to verify no audio cue silently bypasses the caption system.
 */
export function getCaptionCoverage(knownCueIds: AudioCueId[]): {
  total: number;
  captioned: number;
  missing: AudioCueId[];
} {
  const missing: AudioCueId[] = [];
  let captioned = 0;
  for (const id of knownCueIds) {
    if (AUDIO_CAPTIONS[id]) captioned++;
    else missing.push(id);
  }
  return { total: knownCueIds.length, captioned, missing };
}

// ─── Section G (#825): audio-synced subtitle bridge ──────────────────────

/**
 * Synced-subtitle push callback shape. The host (HUD store) registers one;
 * `pushSyncedSubtitle()` invokes it with a freshly-built SubtitleEntry.
 */
export type SyncedSubtitlePushFn = (entry: SubtitleEntry) => void;

let _syncPushFn: SyncedSubtitlePushFn | null = null;

/**
 * Register the host's subtitle push callback. The AudioEngine calls
 * `pushSyncedSubtitle(text, speaker, durationMs)` whenever it plays a cue
 * that should be captioned; this bridge invokes the registered callback
 * with a freshly-built SubtitleEntry.
 *
 * Section G (#825): the AudioEngine's `pushSubtitle()` method delegates
 * here so subtitle timing is locked to the audio cue's start time.
 */
export function attachSubtitleSync(fn: SyncedSubtitlePushFn | null): void {
  _syncPushFn = fn;
}

/** Push a synced subtitle (called from AudioEngine.pushSubtitle). */
export function pushSyncedSubtitle(
  text: string,
  speaker: string,
  durationMs: number,
): SubtitleEntry | null {
  if (!_syncPushFn) return null;
  const source = mapSpeakerToSource(speaker);
  const entry = createSubtitle(source, `${speaker}: ${text}`, { duration: durationMs });
  _syncPushFn(entry);
  return entry;
}

/** Map a speaker label to a SubtitleEntry["source"] category. */
function mapSpeakerToSource(speaker: string): SubtitleEntry["source"] {
  const s = speaker.toUpperCase();
  if (s === "ANNOUNCER" || s === "SYSTEM") return "system";
  if (s === "RADIO") return "radio";
  if (s === "ENEMY") return "enemy";
  if (s === "FRIENDLY") return "friendly";
  if (s === "EXPLOSION") return "explosion";
  return "ambient";
}
