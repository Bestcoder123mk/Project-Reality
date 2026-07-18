/**
 * P6.4: Settings panel expansion.
 *
 * The base Settings interface has: sensitivity, fov, volume, shadows,
 * quality, showFps. P6.4 extends this with:
 *   - Sensitivity curves (linear, exponential, logarithmic).
 *   - Per-zoom sensitivity multipliers (hip, ADS, scope).
 *   - Audio sub-volumes (master, music, sfx, voice).
 *   - Field-of-view range (60-110).
 *   - Colorblind mode (P6.2).
 *   - Subtitle toggle + speed (P6.3).
 *   - Keybinding map (P6.1).
 *
 * The settings panel UI itself is a React component (in
 * src/components/menu/SettingsPanel.tsx). This module defines the
 * extended Settings type + helpers.
 */

import type { ColorblindMode } from "./Accessibility";
import type { CrosshairSettings, ExtendedSettings as StoreExtendedSettings } from "./store";

export type SensitivityCurve = "linear" | "exponential" | "logarithmic";

export interface ExtendedSettings {
  // Base (existing)
  sensitivity: number;
  fov: number;
  volume: number;
  shadows: boolean;
  quality: "low" | "medium" | "high";
  showFps: boolean;
  // P6.4 additions
  sensitivityCurve: SensitivityCurve;
  hipSensitivity: number;       // multiplier when not aiming
  adsSensitivity: number;       // multiplier when aiming
  scopeSensitivity: number;     // multiplier when scoped (sniper)
  masterVolume: number;         // 0..1
  musicVolume: number;          // 0..1
  sfxVolume: number;            // 0..1
  voiceVolume: number;          // 0..1
  colorblindMode: ColorblindMode;
  subtitlesEnabled: boolean;
  subtitleSpeed: number;        // words per minute (60 = slow, 120 = normal, 180 = fast)
  fovRange: [number, number];   // [min, max] for the slider
  motionBlur: boolean;          // P6.5 post-processing
  bloom: boolean;               // P6.5
  ssao: boolean;                // P6.5
  colorGrading: "none" | "warm" | "cool" | "cinematic";  // P6.5
  /** Task 3 / item 65 — "Reduced effects" preset for low-end devices.
   *  When true, the following systems no-op (return early / render static
   *  mesh / skip simulation):
   *    - ClothSim.updateCloth() — capes + scarves + hair render at their
   *      rest pose (no verlet integration).
   *    - RagdollSystem.update() — dead enemies freeze at their death pose
   *      immediately (no ragdoll physics).
   *    - VoronoiFracture.activateShards() — destructible props disappear
   *      instantly on destruction (no shard scatter physics).
   *  This is the "minimum viable" preset for integrated GPUs / mobile — it
   *  cuts the most expensive per-frame simulation work without removing
   *  rendering (the meshes still draw, they just don't move). */
  reducedEffects: boolean;
  /** Prompt J-4052 — subtitle background customization. 0 = transparent,
   *  1 = solid. Default 0.7 (semi-opaque black panel behind subtitle text
   *  for readability over bright backgrounds). */
  subtitleBackground: number;
  /** Prompt J-4052 — subtitle text color (hex). */
  subtitleColor: string;
  /** Prompt J-4053 — audio ducking. When >0, non-VO audio buses (music,
   *  sfx) are attenuated by N dB while VO is playing so the player can
   *  hear dialogue clearly. Default 6 (moderate ducking). 0 disables. */
  audioDuckDb: number;
  /** Prompt J-4054 — motor assist / one-handed mode. When true, the
   *  engine auto-holds sprint while moving forward, auto-crouches on
   *  backward movement, and remaps combined actions (e.g. reload+interact)
   *  to a single key. Designed for one-handed play + motor impairments. */
  motorAssist: boolean;
  /** Prompt J-4055 — non-VO captions. When true, ambient audio cues
   *  (footsteps, reloads, explosions, glass breaking) are captioned in
   *  addition to VO. The Subtitles system reads this flag. */
  ambientCaptions: boolean;
  /** Prompt J-4057 — dyslexia-friendly font. When true, the UI swaps to
   *  a dyslexia-friendly font (e.g. OpenDyslexic) for body text + HUD
   *  labels. Implemented as a CSS class toggle on <html>. */
  dyslexiaFont: boolean;
  /** Prompt J-4059 — RTL layout. When true, the UI flips to right-to-left
   *  (for Arabic / Hebrew). Implemented via the `dir="rtl"` attribute on
   *  <html> + CSS logical-property mirroring. */
  rtlLayout: boolean;
  /** Prompt J-4065 — hold-vs-toggle per action. Each action maps to a
   *  mode: "hold" (key must be held), "toggle" (tap to flip), or
   *  "press" (one-shot on keydown). Defaults match the original engine
   *  behavior. The InputSystem reads this map to translate key state
   *  into action state. */
  holdToggle: {
    sprint: "hold" | "toggle";
    ads: "hold" | "toggle";
    crouch: "hold" | "toggle";
  };
  /** Prompt J-4066 — practice game speed slider (0.25 – 2.0). 1.0 = real
   *  time. Used in practice mode to slow down or speed up the simulation
   *  for training. Multiplies the engine's fixed dt. */
  practiceGameSpeed: number;
  /** Prompt J-4067 — auto-sprint. When true, the player auto-sprints
   *  when moving forward + not aiming. Reduces RSI for long traversals. */
  autoSprint: boolean;
  /** Prompt J-4068 — adjustable input timing (input buffer in ms).
   *  Actions queued within this window before they're valid (e.g. reload
   *  pressed during fire animation) are buffered + replayed when the
   *  animation finishes. Default 200ms. 0 disables buffering. */
  inputBufferMs: number;
}

export const DEFAULT_EXTENDED_SETTINGS: ExtendedSettings = {
  sensitivity: 1,
  fov: 80,
  volume: 0.6,
  shadows: true,
  quality: "high",
  showFps: true,
  // P6.4
  sensitivityCurve: "linear",
  hipSensitivity: 1.0,
  adsSensitivity: 0.8,
  scopeSensitivity: 0.5,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.8,
  voiceVolume: 1.0,
  colorblindMode: "none",
  subtitlesEnabled: false,
  subtitleSpeed: 120,
  fovRange: [60, 110],
  motionBlur: false,
  bloom: true,
  ssao: true,
  colorGrading: "cinematic",
  // Task 3 / item 65 — default OFF. The hardware benchmark in
  // graphics-benchmark.ts can auto-enable this when it detects an
  // integrated GPU (already wired via the GPUClass classifyGPU path).
  reducedEffects: false,
  // Prompt J-4052 — subtitle background defaults.
  subtitleBackground: 0.7,
  subtitleColor: "#ffffff",
  // Prompt J-4053 — moderate audio ducking.
  audioDuckDb: 6,
  // Prompt J-4054 — motor assist off by default.
  motorAssist: false,
  // Prompt J-4055 — ambient captions off by default (VO-only is default).
  ambientCaptions: false,
  // Prompt J-4057 — dyslexia font off by default.
  dyslexiaFont: false,
  // Prompt J-4059 — RTL off by default (English source).
  rtlLayout: false,
  // Prompt J-4065 — hold-vs-toggle defaults (sprint=hold, ads=hold, crouch=toggle).
  holdToggle: { sprint: "hold", ads: "hold", crouch: "toggle" },
  // Prompt J-4066 — practice game speed default (real time).
  practiceGameSpeed: 1.0,
  // Prompt J-4067 — auto-sprint off by default.
  autoSprint: false,
  // Prompt J-4068 — input buffer 200ms (industry standard).
  inputBufferMs: 200,
};

/**
 * Apply a sensitivity curve to a raw input value.
 * Used by InputSystem.onMouseMove to translate mouse movement to yaw/pitch.
 */
export function applySensitivityCurve(raw: number, curve: SensitivityCurve, sensitivity: number): number {
  const signed = raw < 0;
  const abs = Math.abs(raw);
  let adjusted: number;
  switch (curve) {
    case "exponential":
      // Exponential: small movements are smaller, large movements are larger.
      adjusted = abs * abs * 0.1 + abs * 0.9;
      break;
    case "logarithmic":
      // Logarithmic: small movements are larger (precision), large movements are smaller.
      adjusted = Math.log(abs + 1) * 5;
      break;
    case "linear":
    default:
      adjusted = abs;
      break;
  }
  return (signed ? -1 : 1) * adjusted * sensitivity;
}

/**
 * Get the effective sensitivity for the current aim state.
 * Used by InputSystem to scale mouse movement.
 */
export function getEffectiveSensitivity(
  settings: ExtendedSettings,
  isAiming: boolean,
  isScoped: boolean,
): number {
  if (isScoped) return settings.sensitivity * settings.scopeSensitivity;
  if (isAiming) return settings.sensitivity * settings.adsSensitivity;
  return settings.sensitivity * settings.hipSensitivity;
}

const SETTINGS_STORAGE_KEY = "pr_extended_settings_v1";

/** Load extended settings from localStorage (with defaults for missing keys). */
export function loadExtendedSettings(): ExtendedSettings {
  if (typeof window === "undefined") return DEFAULT_EXTENDED_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_EXTENDED_SETTINGS;
    return { ...DEFAULT_EXTENDED_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_EXTENDED_SETTINGS;
  }
}

/** Save extended settings to localStorage. */
export function saveExtendedSettings(settings: ExtendedSettings): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

// ─── Prompt J-4039 — crosshair share codes ───────────────────────────────────

/**
 * J-4039 — crosshair share codes. Serialize a CrosshairSettings blob
 * into a short, pasteable string the player can share with friends. The
 * format is `PR-X<style><color><showDot><length><thickness><gap><outline><dynamicSpread>`
 * where each field is a fixed-width encoded value. The code is ~24 chars
 * + a 4-char checksum so typos are caught.
 *
 * The encoding is intentionally compact + URL-safe (no `+/=`). Decoding
 * is the inverse; an invalid code returns null.
 */

const CROSSHAIR_STYLES_ORDER = ["cross", "circle", "dot", "cross+dot", "T"] as const;

function encodeStyle(s: CrosshairSettings["style"]): string {
  const i = CROSSHAIR_STYLES_ORDER.indexOf(s);
  return i >= 0 ? String(i) : "0";
}
function decodeStyle(s: string): CrosshairSettings["style"] | null {
  const i = parseInt(s, 10);
  if (isNaN(i) || i < 0 || i >= CROSSHAIR_STYLES_ORDER.length) return null;
  return CROSSHAIR_STYLES_ORDER[i];
}

/** Encode a hex color (#RRGGBB) as 6 hex chars (no #). */
function encodeColor(c: string): string {
  return c.replace("#", "").toLowerCase().padStart(6, "0").slice(0, 6);
}
function decodeColor(c: string): string | null {
  if (!/^[0-9a-f]{6}$/.test(c)) return null;
  return `#${c}`;
}

/** Encode a small int (0-99) as 2 chars. */
function encodeInt2(n: number): string {
  return String(Math.max(0, Math.min(99, Math.round(n)))).padStart(2, "0");
}
function decodeInt2(s: string): number | null {
  if (!/^\d{2}$/.test(s)) return null;
  return parseInt(s, 10);
}

/** Encode a boolean as 1 char (0/1). */
function encodeBool(b: boolean): string {
  return b ? "1" : "0";
}
function decodeBool(s: string): boolean | null {
  if (s !== "0" && s !== "1") return null;
  return s === "1";
}

/** Simple checksum: sum of char codes mod 36, encoded as 1 base-36 char. */
function checksum(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return (sum % 36).toString(36);
}

/** Serialize a CrosshairSettings blob into a shareable code. */
export function serializeCrosshairCode(cfg: CrosshairSettings): string {
  // Layout: PR-X + style(1) + color(6) + showDot(1) + length(2) + thickness(2)
  //         + gap(2) + outline(1) + dynamicSpread(1) = 17 chars + "PR-X" = 21
  //         + checksum(1) = 22 chars total.
  const body =
    "PR-X" +
    encodeStyle(cfg.style) +
    encodeColor(cfg.color) +
    encodeBool(cfg.showDot) +
    encodeInt2(cfg.length) +
    encodeInt2(cfg.thickness) +
    encodeInt2(cfg.gap) +
    encodeBool(cfg.outline) +
    encodeBool(cfg.dynamicSpread);
  return body + checksum(body);
}

/** Parse a share code into a CrosshairSettings blob, or null on invalid. */
export function parseCrosshairCode(code: string): CrosshairSettings | null {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed.startsWith("PR-X") || trimmed.length !== 22) return null;
  const body = trimmed.slice(0, 21);
  const check = trimmed.slice(21);
  if (checksum(body) !== check.toLowerCase()) return null;
  let i = 4; // skip "PR-X"
  const style = decodeStyle(body[i]); i += 1;
  const color = decodeColor(body.slice(i, i + 6)); i += 6;
  const showDot = decodeBool(body[i]); i += 1;
  const length = decodeInt2(body.slice(i, i + 2)); i += 2;
  const thickness = decodeInt2(body.slice(i, i + 2)); i += 2;
  const gap = decodeInt2(body.slice(i, i + 2)); i += 2;
  const outline = decodeBool(body[i]); i += 1;
  const dynamicSpread = decodeBool(body[i]);
  if (
    style == null || color == null || showDot == null ||
    length == null || thickness == null || gap == null ||
    outline == null || dynamicSpread == null
  ) {
    return null;
  }
  return {
    style,
    color,
    showDot,
    length,
    thickness,
    gap,
    outline,
    dynamicSpread,
  };
}

// ─── Prompt J-4038 — hitmarker customization ────────────────────────────────

/**
 * J-4038 — hitmarker customization. The base CrosshairSettings covers
 * the crosshair itself; hitmarker-specific tweaks (color, size, duration,
 * sound on hit) live here as a separate persisted blob. The Crosshair
 * component reads these via `loadHitmarkerSettings()`.
 */
export interface HitmarkerSettings {
  /** Hit (body shot) color (hex). */
  hitColor: string;
  /** Kill color (hex). */
  killColor: string;
  /** Headshot color (hex). */
  headshotColor: string;
  /** Hit marker duration in ms (60-500). */
  hitDurationMs: number;
  /** Kill marker duration in ms (200-1000). */
  killDurationMs: number;
  /** Scale multiplier (0.5-2.0). */
  scale: number;
  /** Play a UI sound on hit (the sound itself is in audio.ts). */
  soundOnHit: boolean;
}

export const DEFAULT_HITMARKER_SETTINGS: HitmarkerSettings = {
  hitColor: "#f87171",
  killColor: "#ffffff",
  headshotColor: "#ffd24a",
  hitDurationMs: 180,
  killDurationMs: 400,
  scale: 1.0,
  soundOnHit: true,
};

const HITMARKER_KEY = "pr_hitmarker_settings_v1";

export function loadHitmarkerSettings(): HitmarkerSettings {
  if (typeof window === "undefined") return DEFAULT_HITMARKER_SETTINGS;
  try {
    const raw = localStorage.getItem(HITMARKER_KEY);
    if (!raw) return DEFAULT_HITMARKER_SETTINGS;
    return { ...DEFAULT_HITMARKER_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_HITMARKER_SETTINGS;
  }
}

export function saveHitmarkerSettings(s: HitmarkerSettings): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HITMARKER_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

// ─── Prompt I-963 — Preset save/load ─────────────────────────────────────────

/**
 * Prompt I-963 — Settings preset save/load.
 *
 * A preset is a named snapshot of the full ExtendedSettings blob +
 * the VisualSettings UI-only toggles (passed in by the caller — the
 * SettingsPanel lifts that state). Stored in localStorage under
 * `pr_settings_presets_v1` as `{ [name]: { extended, visual, at } }`.
 *
 * The store's `Settings` blob (sensitivity/fov/quality/etc.) is *not*
 * part of a preset — those values live in the zustand store and are
 * already persisted by `store.ts`. Presets layer on top: a preset
 * captures the extended + visual values, and `applyPreset()` writes
 * them back to the store + visual state.
 */

const PRESETS_STORAGE_KEY = "pr_settings_presets_v1";

export interface SettingsPreset {
  /** User-supplied name (1-32 chars). */
  name: string;
  /** Snapshot of the store's ExtendedSettings blob (the live
   *  `settings.extended` from the zustand store — NOT this module's
   *  ExtendedSettings interface, which is a parallel type used only
   *  by the crosshair-share-code + hitmarker helpers). The
   *  SettingsPanel passes `settings.extended` straight through. */
  extended: StoreExtendedSettings;
  /** Snapshot of the panel's VisualSettings (passed in by the caller). */
  visual: Record<string, unknown>;
  /** ISO timestamp of the save. */
  at: string;
}

/** List all saved presets (newest first). */
export function listPresets(): SettingsPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw) as Record<string, SettingsPreset>;
    return Object.values(map).sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** Save a preset (overwrites if the name already exists).
 *  `extended` is the store's ExtendedSettings blob (the live
 *  `settings.extended` from the zustand store). */
export function savePreset(name: string, extended: StoreExtendedSettings, visual: Record<string, unknown>): SettingsPreset {
  if (typeof window === "undefined") {
    return { name, extended, visual, at: new Date().toISOString() };
  }
  const trimmed = name.trim().slice(0, 32);
  if (!trimmed) throw new Error("Preset name cannot be empty");
  const map = (() => {
    try {
      const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, SettingsPreset>) : {};
    } catch {
      return {};
    }
  })();
  const preset: SettingsPreset = {
    name: trimmed,
    extended,
    visual,
    at: new Date().toISOString(),
  };
  map[trimmed] = preset;
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(map));
  return preset;
}

/** Load a preset by name. Returns null if not found. */
export function loadPreset(name: string): SettingsPreset | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, SettingsPreset>;
    return map[name] ?? null;
  } catch {
    return null;
  }
}

/** Delete a preset by name. */
export function deletePreset(name: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, SettingsPreset>;
    delete map[name];
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}
