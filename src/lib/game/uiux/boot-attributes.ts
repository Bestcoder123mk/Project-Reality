/**
 * Prompt I-977 — Apply boot-time data-attributes to <html>.
 *
 * Reads the player's VisualSettings + ExtendedSettings from localStorage
 * (or falls back to defaults) and writes the relevant ones as data-*
 * attributes on <html> so the first paint already has the right CSS
 * selectors active (no FOUC where motion is full-strength for one
 * frame before the reduced-motion class kicks in).
 *
 * The SettingsPanel calls `applyBootDataAttributes()` again whenever
 * the player changes a relevant setting (reducedMotion, colorblindMode)
 * so the update is live without a reload.
 *
 * SSR-safe: no-ops on the server.
 */

import {
  loadExtendedSettings,
  DEFAULT_EXTENDED_SETTINGS,
} from "../ExtendedSettings";

const VISUAL_KEY = "pr_visual_settings_v1";

interface LiftedVisualSettings {
  reducedMotion?: boolean;
}

function loadVisualSettings(): LiftedVisualSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(VISUAL_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as LiftedVisualSettings;
  } catch {
    return {};
  }
}

/** Persist the lifted VisualSettings blob (called by SettingsPanel). */
export function saveVisualSettingsBlob(visual: LiftedVisualSettings): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(VISUAL_KEY, JSON.stringify(visual));
  } catch {
    /* ignore */
  }
}

/** Apply the player's accessibility data-attributes to <html>. */
export function applyBootDataAttributes(): void {
  if (typeof window === "undefined") return;
  const ext = loadExtendedSettings();
  const visual = loadVisualSettings();
  const root = document.documentElement;
  // I-977 / J-4058 / J-4104 — reduced motion. The data-attribute is
  // read by globals.css `[data-reduced-motion="true"]` selectors that
  // force `animation: none !important` + `transition: none !important`
  // on every element. This is the ENFORCEMENT layer — players who opt
  // into reduced motion get it site-wide regardless of which
  // component's CSS would otherwise animate. Mirrors the OS-level
  // `prefers-reduced-motion: reduce` media query but lets the player
  // override the OS setting in-game.
  root.setAttribute(
    "data-reduced-motion",
    String(Boolean(visual.reducedMotion)),
  );
  // Existing P6.2 — colorblind mode (mirrored from Accessibility.ts).
  root.setAttribute("data-colorblind", ext.colorblindMode ?? "none");
  // Prompt J-4057 — dyslexia-friendly font toggle.
  root.setAttribute("data-dyslexia-font", String(Boolean(ext.dyslexiaFont)));
  // Prompt J-4059 — RTL layout (mirrors the document's text direction).
  // We set the `dir` attribute + the matching `lang` so screen readers
  // pronounce content in the right language. The actual locale→RTL
  // mapping lives in i18n.ts (isRTL); here we only honor the explicit
  // player override (rtlLayout flag in ExtendedSettings).
  if (ext.rtlLayout) {
    root.setAttribute("dir", "rtl");
  } else {
    root.setAttribute("dir", "ltr");
  }
}

/** Read the current reduced-motion flag (for the SettingsPanel checkbox). */
export function getReducedMotionSetting(): boolean {
  return Boolean(loadVisualSettings().reducedMotion);
}

/** Read the current extended settings (or defaults). */
export function getBootExtendedSettings() {
  return loadExtendedSettings() ?? DEFAULT_EXTENDED_SETTINGS;
}
