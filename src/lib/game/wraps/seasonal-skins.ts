/**
 * Section E — Limited-time seasonal skins.
 *
 * Seasonal skins are catalog entries available only during a specific
 * real-world season/event window. Examples:
 *
 *   - Winterfest (Dec 1 – Jan 5): Frostbite Eternal, Aurora Mythic, etc.
 *   - Summer Sun (Jun 1 – Aug 31): Phoenix Ascendant, Inferno Sovereign.
 *   - Halloween (Oct 15 – Nov 5): Spectral Drift Eternal, Void Walker Eternal.
 *   - Anniversary (Mar 1 – Mar 31): Last Light Eternal, Bismuth Crown Eternal.
 *   - Lunar New Year (Feb 1 – Feb 28): Jade Dragon Eternal.
 *   - Festival of Colors (Mar 8 – Mar 22): Holi Sovereign Eternal.
 *   - Retro Wave (Apr 1 – Apr 21): Vaporwave Sovereign.
 *   - Nautical (May 1 – May 31): Kraken's Wrath, Tidal Mythic.
 *
 * This module defines the seasonal schedule (which season is active at a
 * given timestamp), the catalog entries tagged to each season (filtered
 * from skin-catalog.ts), and the availability/preview mechanics for the
 * gunsmith UI (a "limited time" banner with countdown, "returning next
 * season" hint, preview-before-acquire).
 *
 * The actual seasonal-skin acquisition (battle pass rewards, shop bundles)
 * is handled by the meta layer; this module is the authoritative
 * availability + schedule lookup.
 */
import type { SkinCatalogEntry } from "./skin-catalog";

// ─── Season definitions ─────────────────────────────────────────────────────

export type SeasonId =
  | "winterfest"
  | "summer_sun"
  | "halloween"
  | "anniversary"
  | "lunar_new_year"
  | "festival_of_colors"
  | "retro_wave"
  | "nautical";

export interface SeasonDefinition {
  id: SeasonId;
  /** Display name. */
  name: string;
  /** Short description. */
  desc: string;
  /** Hex accent color (for UI theming). */
  accentColor: string;
  /** Seasonal tag — matches `SkinCatalogEntry.seasonalTag`. */
  skinTag: string;
  /** Recurrence pattern — fixed dates per year, or rolling days. */
  recurrence: "fixed_annual" | "rolling_annual";
  /** Month + day range (1-indexed months). For fixed_annual. */
  startMonthDay: [number, number]; // [month, day]
  endMonthDay: [number, number];
  /** Optional banner art URL (used by the gunsmith banner). */
  bannerArt?: string;
}

export const SEASONS: Record<SeasonId, SeasonDefinition> = {
  winterfest: {
    id: "winterfest",
    name: "Winterfest",
    desc: "The cold brings limited arctic + aurora skins.",
    accentColor: "#aaccea",
    skinTag: "winter",
    recurrence: "fixed_annual",
    startMonthDay: [12, 1],
    endMonthDay: [1, 5],
  },
  summer_sun: {
    id: "summer_sun",
    name: "Summer Sun",
    desc: "Heat-reactive + lava skins, here for the burn.",
    accentColor: "#ff8030",
    skinTag: "summer",
    recurrence: "fixed_annual",
    startMonthDay: [6, 1],
    endMonthDay: [8, 31],
  },
  halloween: {
    id: "halloween",
    name: "Spectral Nights",
    desc: "Holographic + void skins for the haunting season.",
    accentColor: "#aa3a8a",
    skinTag: "halloween",
    recurrence: "fixed_annual",
    startMonthDay: [10, 15],
    endMonthDay: [11, 5],
  },
  anniversary: {
    id: "anniversary",
    name: "Anniversary",
    desc: "Celebration mythics — gold + bismuth collectibles.",
    accentColor: "#ffd040",
    skinTag: "anniversary",
    recurrence: "fixed_annual",
    startMonthDay: [3, 1],
    endMonthDay: [3, 31],
  },
  lunar_new_year: {
    id: "lunar_new_year",
    name: "Lunar New Year",
    desc: "Jade + gold collectibles for the new year.",
    accentColor: "#c81428",
    skinTag: "lunar",
    recurrence: "fixed_annual",
    startMonthDay: [2, 1],
    endMonthDay: [2, 28],
  },
  festival_of_colors: {
    id: "festival_of_colors",
    name: "Festival of Colors",
    desc: "Holi powder-splash skins, vibrant + rare.",
    accentColor: "#ff3a3a",
    skinTag: "festival",
    recurrence: "fixed_annual",
    startMonthDay: [3, 8],
    endMonthDay: [3, 22],
  },
  retro_wave: {
    id: "retro_wave",
    name: "Retro Wave",
    desc: "Vaporwave + Memphis throwback skins.",
    accentColor: "#ff6aaa",
    skinTag: "retro",
    recurrence: "fixed_annual",
    startMonthDay: [4, 1],
    endMonthDay: [4, 21],
  },
  nautical: {
    id: "nautical",
    name: "Nautical",
    desc: "Kraken + tidal skins for the high seas.",
    accentColor: "#3a6a8a",
    skinTag: "nautical",
    recurrence: "fixed_annual",
    startMonthDay: [5, 1],
    endMonthDay: [5, 31],
  },
};

// ─── Schedule resolution ────────────────────────────────────────────────────

export interface SeasonWindow {
  season: SeasonDefinition;
  /** Start of the active window (epoch ms). */
  startMs: number;
  /** End of the active window (epoch ms). */
  endMs: number;
  /** Whether the season is currently active. */
  isActive: boolean;
}

/** Convert [month, day] (1-indexed) to a Date for a given year. */
function monthDayToDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

/**
 * Compute the active window for a season in a given year. Handles wrap-around
 * (Winterfest spans Dec 1 → Jan 5, so the active window crosses year-boundary).
 */
export function computeSeasonWindow(season: SeasonDefinition, year: number, now: number = Date.now()): SeasonWindow {
  const start = monthDayToDate(year, season.startMonthDay[0], season.startMonthDay[1]).getTime();
  let end: number;
  let endYear = year;
  // If end month/day is earlier than start, it wraps to next year.
  if (
    season.endMonthDay[0] < season.startMonthDay[0] ||
    (season.endMonthDay[0] === season.startMonthDay[0] && season.endMonthDay[1] < season.startMonthDay[1])
  ) {
    endYear = year + 1;
  }
  end = monthDayToDate(endYear, season.endMonthDay[0], season.endMonthDay[1]).getTime();
  const isActive = now >= start && now < end;
  return { season, startMs: start, endMs: end, isActive };
}

/**
 * Find the currently-active season (if any) for the given timestamp.
 * Iterates all seasons across the current + previous year (to catch
 * Winterfest's Dec→Jan wrap).
 */
export function getActiveSeason(now: number = Date.now()): SeasonWindow | null {
  const date = new Date(now);
  const year = date.getFullYear();
  // Check current year + previous year (Winterfest wrap).
  for (const y of [year, year - 1]) {
    for (const season of Object.values(SEASONS)) {
      const window = computeSeasonWindow(season, y, now);
      if (window.isActive) return window;
    }
  }
  return null;
}

/**
 * Get the next upcoming season (after the current one, or after `now` if
 * no season is currently active). Used by the gunsmith banner to show
 * "Next: Winterfest in 12 days" countdown.
 */
export function getNextSeason(now: number = Date.now()): SeasonWindow | null {
  const date = new Date(now);
  const year = date.getFullYear();
  let best: SeasonWindow | null = null;
  // Look across current + next year.
  for (const y of [year, year + 1]) {
    for (const season of Object.values(SEASONS)) {
      const window = computeSeasonWindow(season, y, now);
      if (window.startMs > now) {
        if (!best || window.startMs < best.startMs) {
          best = window;
        }
      }
    }
  }
  return best;
}

/** Get all season windows for the current year (for the season-overview UI). */
export function getSeasonsForYear(year: number, now: number = Date.now()): SeasonWindow[] {
  return Object.values(SEASONS).map((s) => computeSeasonWindow(s, year, now));
}

// ─── Seasonal skin lookup ───────────────────────────────────────────────────

/**
 * Get all catalog entries tagged with a season. Returns skins regardless of
 * current availability — the UI gates acquire-actions on `getActiveSeason()`.
 */
export function getSeasonalSkins(
  season: SeasonDefinition,
  allEntries: SkinCatalogEntry[],
): SkinCatalogEntry[] {
  return allEntries.filter((e) => e.seasonalTag === season.skinTag);
}

/**
 * Get all currently-available seasonal skins (i.e., the active season's
 * skins). Returns [] if no season is active.
 */
export function getActiveSeasonalSkins(
  allEntries: SkinCatalogEntry[],
  now: number = Date.now(),
): SkinCatalogEntry[] {
  const active = getActiveSeason(now);
  if (!active) return [];
  return getSeasonalSkins(active.season, allEntries);
}

// ─── Availability checks ────────────────────────────────────────────────────

export interface SkinAvailability {
  /** Whether the skin can currently be acquired. */
  available: boolean;
  /** Reason if unavailable. */
  reason?: string;
  /** The season the skin belongs to (if seasonal). */
  season?: SeasonDefinition;
  /** When the skin next becomes available (epoch ms, if scheduled). */
  nextAvailableMs?: number;
  /** Human-readable countdown (e.g., "in 12 days"). */
  nextAvailableLabel?: string;
}

/**
 * Check the availability of a catalog entry. Seasonal skins are only
 * available during their active window. Non-seasonal skins are always
 * available.
 */
export function checkSkinAvailability(
  entry: SkinCatalogEntry,
  now: number = Date.now(),
): SkinAvailability {
  if (!entry.seasonalTag) {
    return { available: true };
  }
  // Find the season with this tag.
  const season = Object.values(SEASONS).find((s) => s.skinTag === entry.seasonalTag);
  if (!season) {
    return { available: true }; // unknown tag — treat as always available
  }
  // Is the season currently active?
  const active = getActiveSeason(now);
  if (active && active.season.id === season.id) {
    return { available: true, season };
  }
  // Find the next window for this season.
  const date = new Date(now);
  const year = date.getFullYear();
  let next: SeasonWindow | null = null;
  for (const y of [year, year + 1]) {
    const w = computeSeasonWindow(season, y, now);
    if (w.startMs > now) {
      if (!next || w.startMs < next.startMs) next = w;
    }
  }
  return {
    available: false,
    reason: `Returns during ${season.name}`,
    season,
    nextAvailableMs: next?.startMs,
    nextAvailableLabel: next ? formatCountdown(next.startMs - now) : undefined,
  };
}

/** Format a millisecond duration as a human-readable countdown. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (days >= 1) return `in ${days}d ${hours}h`;
  if (hours >= 1) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

// ─── Seasonal banner UI data ────────────────────────────────────────────────

export interface SeasonBannerData {
  /** The active season (or null if none). */
  activeSeason: SeasonDefinition | null;
  /** Time until the active season ends (ms). */
  endsInMs: number;
  /** The next upcoming season (or null). */
  nextSeason: SeasonDefinition | null;
  /** Time until the next season starts (ms). */
  nextStartsInMs: number;
  /** Number of seasonal skins currently available. */
  activeSkinCount: number;
  /** Whether to show the "limited time" banner. */
  showBanner: boolean;
}

/**
 * Compute the season banner data for the gunsmith UI. The banner shows the
 * active season's name + countdown to its end + the number of seasonal
 * skins available now.
 */
export function computeSeasonBanner(
  allEntries: SkinCatalogEntry[],
  now: number = Date.now(),
): SeasonBannerData {
  const active = getActiveSeason(now);
  const next = getNextSeason(now);
  const activeSkins = active ? getSeasonalSkins(active.season, allEntries) : [];
  return {
    activeSeason: active?.season ?? null,
    endsInMs: active ? active.endMs - now : 0,
    nextSeason: next?.season ?? null,
    nextStartsInMs: next ? next.startMs - now : 0,
    activeSkinCount: activeSkins.length,
    showBanner: active !== null,
  };
}

// ─── Seasonal skin exclusivity + recall ─────────────────────────────────────

/**
 * Section E "limited-time seasonal skins" — skins acquired during a season
 * are kept permanently (they don't expire from the player's inventory when
 * the season ends), but they can only be ACQUIRED during the season. After
 * the season, they show a "Returning next [Season Name]" hint in the shop.
 *
 * Players who already own a seasonal skin can equip + trade it year-round
 * (subject to the normal trade rules — see skin-trading.ts).
 */

/** Whether an owned seasonal skin can be equipped right now. (Always true — ownership is permanent.) */
export function canEquipSeasonalSkin(entry: SkinCatalogEntry): boolean {
  return true; // owned seasonal skins are always equippable
}

/** Whether a seasonal skin can be acquired right now (i.e., its season is active). */
export function canAcquireSeasonalSkin(entry: SkinCatalogEntry, now: number = Date.now()): boolean {
  if (!entry.seasonalTag) return true;
  return checkSkinAvailability(entry, now).available;
}
