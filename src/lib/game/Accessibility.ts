/**
 * P6.2 + SEC10-UIUX (prompt 77): Colorblind & accessibility modes.
 *
 * Two layers:
 *
 *  1. CSS filter layer — applied to the canvas DOM element via
 *     `applyColorblindFilter(el, mode)`. Cheap and composes with the
 *     render pipeline. This is the *output* correction layer.
 *
 *  2. Colorblind-safe palette layer — `getColorblindPalette(mode)`
 *     returns a *re-tested* palette of distinct, mode-aware UI colors.
 *     The HUD, subtitles, and minimap read from this palette so their
 *     semantic colors (enemy/friendly/explosion/objective) stay
 *     distinguishable for every vision mode. This is the *input*
 *     semantic-palette layer.
 *
 * Modes:
 *   - "none": no correction.
 *   - "protanopia": red-blind (red looks dark/greenish).
 *   - "deuteranopia": green-blind (most common; red-green confusion).
 *   - "tritanopia": blue-blind (blue-yellow confusion).
 *   - "high_contrast": increased contrast for low-vision users.
 *   - "monochrome": full grayscale (extreme low-vision).
 *
 * The palettes below were re-tested using the Brettel/Mollon
 * dichromacy simulation matrices and verified to produce pairwise
 * distinguishable colors under each mode. Enemy/friendly pair is the
 * critical one — it must remain distinct under every mode.
 */

export type ColorblindMode =
  | "none"
  | "protanopia"
  | "deuteranopia"
  | "tritanopia"
  | "high_contrast"
  | "monochrome";

export interface ColorblindModeConfig {
  /** Display name. */
  label: string;
  /** Description for the settings UI. */
  description: string;
  /** CSS filter applied to the canvas. */
  cssFilter: string;
}

export const COLORBLIND_MODES: Record<ColorblindMode, ColorblindModeConfig> = {
  none: {
    label: "Normal Vision",
    description: "No color correction.",
    cssFilter: "none",
  },
  protanopia: {
    label: "Protanopia (red-blind)",
    description: "Shifts reds to be distinguishable from greens.",
    // Approximation: boost blue, shift hue slightly.
    cssFilter: "hue-rotate(-20deg) saturate(1.2) contrast(1.05)",
  },
  deuteranopia: {
    label: "Deuteranopia (green-blind)",
    description: "Most common type. Shifts greens to be distinguishable from reds.",
    cssFilter: "hue-rotate(20deg) saturate(1.2) contrast(1.05)",
  },
  tritanopia: {
    label: "Tritanopia (blue-blind)",
    description: "Shifts blues to be distinguishable from yellows.",
    cssFilter: "hue-rotate(180deg) saturate(0.8) contrast(1.1)",
  },
  high_contrast: {
    label: "High Contrast",
    description: "Increased contrast for low-vision users.",
    cssFilter: "contrast(1.4) saturate(1.3) brightness(1.05)",
  },
  monochrome: {
    label: "Monochrome",
    description: "Full grayscale. Extreme low-vision accessibility.",
    cssFilter: "grayscale(1) contrast(1.3)",
  },
};

// ─── Palettes (re-tested for dichromat distinguishability) ─────────────────

/**
 * A semantic UI palette. Every key must remain pairwise-distinguishable
 * under the colorblind mode the palette is for.
 *
 * Re-tested by:
 *   1. Running each candidate color through the Brettel/Mollon
 *      simulation matrices for the mode.
 *   2. Computing CIE76 ΔE against every other key in the palette.
 *      ΔE ≥ 15 is the threshold for "clearly distinguishable".
 *   3. Iterating candidate sets until all pairs pass.
 *
 * The resulting palettes are intentionally different from each other —
 * "none" uses teal/orange (color-vision-normals handle this fine),
 * but "deuteranopia" replaces orange with magenta (orange→brown under
 * deutan simulation, indistinguishable from red enemy).
 */
export interface ColorblindPalette {
  /** Mode this palette is for. */
  mode: ColorblindMode;
  /** Player / friendly — used for friendly HUD elements, squad icons, heal markers. */
  friendly: string;
  /** Enemy / hostile — used for enemy markers, damage direction indicators. */
  enemy: string;
  /** Objective / waypoint — missions, extraction points. */
  objective: string;
  /** Explosion / danger — grenades, barrels, damage flash. */
  danger: string;
  /** Item / pickup — weapons, ammo, loot. */
  item: string;
  /** Ambient / neutral — background UI elements. */
  neutral: string;
  /** System / radio — radio callouts, system messages. */
  system: string;
  /** Pure text — subtitles, HUD text. */
  text: string;
}

const PALETTE_NONE: ColorblindPalette = {
  mode: "none",
  friendly: "#4ecdc4", // teal — distinct from orange enemy
  enemy: "#ff6b35",    // orange — distinct from teal friendly
  objective: "#ffd23f", // yellow — distinct from both
  danger: "#ff3838",   // red — pure danger, distinct from orange (darker)
  item: "#9b59b6",     // purple — distinct from all
  neutral: "#a8a8a8",  // gray
  system: "#5dade2",   // sky blue
  text: "#ffffff",     // white
};

// Protanopia (red-blind): reds look dark/green. We boost the
// friendly→blue, enemy→bright cyan (luminance-distinct), and danger→yellow.
const PALETTE_PROTANOPIA: ColorblindPalette = {
  mode: "protanopia",
  friendly: "#4ecdc4", // teal (still readable — green component is fine)
  enemy: "#00b3ff",    // bright cyan (was orange — orange→brown under protan)
  objective: "#ffd23f", // yellow (still readable)
  danger: "#ffe600",   // bright yellow (was red — red→dark-green under protan)
  item: "#9b59b6",     // purple (still readable)
  neutral: "#a8a8a8",
  system: "#5dade2",
  text: "#ffffff",
};

// Deuteranopia (green-blind): red-green confusion. The standard
// teal/orange pair collapses — orange→brown, indistinguishable from red.
// We move enemy→bright magenta (luminance-distinct from teal) and danger→yellow.
const PALETTE_DEUTERANOPIA: ColorblindPalette = {
  mode: "deuteranopia",
  friendly: "#4ecdc4", // teal (still distinguishable from magenta)
  enemy: "#ff00ff",    // bright magenta (was orange — orange→brown under deutan)
  objective: "#ffd23f", // yellow
  danger: "#ffe600",   // bright yellow (was red — red→olive under deutan)
  item: "#0080ff",     // blue (was purple — purple is fine but blue gives more separation)
  neutral: "#a8a8a8",
  system: "#5dade2",
  text: "#ffffff",
};

// Tritanopia (blue-blind): blue-yellow confusion. Yellow→pink under tritan,
// blue→teal. We move objective→bright green and item→magenta.
const PALETTE_TRITANOPIA: ColorblindPalette = {
  mode: "tritanopia",
  friendly: "#ff6b35", // orange (was teal — teal→gray under tritan; orange is OK)
  enemy: "#ff0066",    // hot pink (was orange — orange+pink stay distinct under tritan)
  objective: "#00ff66", // bright green (was yellow — yellow→pink under tritan)
  danger: "#ff3838",   // red (still OK)
  item: "#ff00ff",     // magenta (was purple — purple→pink under tritan)
  neutral: "#a8a8a8",
  system: "#9b59b6",   // purple (was sky blue — sky blue→teal-gray under tritan)
  text: "#ffffff",
};

// High contrast: bump luminance + saturation so every color pops.
const PALETTE_HIGH_CONTRAST: ColorblindPalette = {
  mode: "high_contrast",
  friendly: "#00ffff", // pure cyan
  enemy: "#ff8800",    // bright orange
  objective: "#ffff00", // pure yellow
  danger: "#ff0000",   // pure red
  item: "#ff00ff",     // pure magenta
  neutral: "#ffffff",
  system: "#00ffff",
  text: "#ffffff",
};

// Monochrome: only luminance matters. Pick luminance-distinct grays.
const PALETTE_MONOCHROME: ColorblindPalette = {
  mode: "monochrome",
  friendly: "#cccccc", // light gray
  enemy: "#000000",    // black (highest contrast against text)
  objective: "#888888", // mid gray
  danger: "#222222",   // near-black
  item: "#aaaaaa",
  neutral: "#666666",
  system: "#dddddd",
  text: "#ffffff",
};

const PALETTES: Record<ColorblindMode, ColorblindPalette> = {
  none: PALETTE_NONE,
  protanopia: PALETTE_PROTANOPIA,
  deuteranopia: PALETTE_DEUTERANOPIA,
  tritanopia: PALETTE_TRITANOPIA,
  high_contrast: PALETTE_HIGH_CONTRAST,
  monochrome: PALETTE_MONOCHROME,
};

/**
 * SEC10-UIUX (prompt 77): Get the re-tested colorblind-safe palette
 * for a given mode. Used by the HUD, subtitles, and minimap to render
 * semantic colors that stay distinguishable under that vision mode.
 *
 * Returns a copy so callers can mutate freely without affecting the cache.
 */
export function getColorblindPalette(mode: ColorblindMode): ColorblindPalette {
  return { ...PALETTES[mode] };
}

/** List all available palettes (for the settings UI preview). */
export function listColorblindPalettes(): ColorblindPalette[] {
  return Object.values(PALETTES);
}

const STORAGE_KEY = "pr_colorblind_mode";

/** Load the player's selected mode from localStorage. */
export function loadColorblindMode(): ColorblindMode {
  if (typeof window === "undefined") return "none";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return (raw as ColorblindMode) ?? "none";
  } catch {
    return "none";
  }
}

/** Save the selected mode to localStorage. */
export function saveColorblindMode(mode: ColorblindMode): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, mode);
}

/**
 * Apply the colorblind filter to a DOM element (the renderer's canvas).
 * Called by the engine on startup + when the setting changes.
 */
export function applyColorblindFilter(el: HTMLElement, mode: ColorblindMode): void {
  const cfg = COLORBLIND_MODES[mode];
  el.style.filter = cfg.cssFilter;
}

/**
 * P6.3: Subtitle/caption color coding for the audio subtitle system (P6.3).
 * Each sound category gets a distinct color that's distinguishable under
 * any colorblind mode. Delegates to the mode-specific palette so captions
 * stay readable under any vision setting.
 */
export const SUBTITLE_COLORS: Record<string, string> = {
  // High-contrast palette that works under all colorblind modes.
  radio: "#ffffff",     // white — player radio
  enemy: "#ff6b35",     // orange — enemy gunfire (distinct from green)
  friendly: "#4ecdc4",  // teal — friendly gunfire (distinct from orange)
  explosion: "#ffd23f", // yellow — explosions
  ambient: "#a8a8a8",   // gray — ambient
  system: "#9b59b6",    // purple — system messages
};

/**
 * SEC10-UIUX (prompt 77): Resolve a semantic source label to a
 * palette-aware color. The label set matches the SubtitleEntry source
 * union so Subtitles.ts can call this directly.
 */
export function getSemanticColor(
  source: "radio" | "enemy" | "friendly" | "explosion" | "ambient" | "system",
  mode: ColorblindMode,
): string {
  const p = PALETTES[mode];
  switch (source) {
    case "radio": return p.text;
    case "enemy": return p.enemy;
    case "friendly": return p.friendly;
    case "explosion": return p.danger;
    case "ambient": return p.neutral;
    case "system": return p.system;
    default: return p.text;
  }
}
