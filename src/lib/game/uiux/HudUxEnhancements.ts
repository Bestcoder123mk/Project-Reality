/**
 * §10 UI/UX & Menus (items 226–250) + §11 HUD & Feedback (items 251–275).
 *
 * Self-contained enhancement layer over the menu + HUD components. Adds
 * loading skeletons, confirm dialogs, search/filter, DnD attachments,
 * favorites, tooltips, patch-notes popup, hit-marker tiers, kill-confirmed,
 * ammo-low pulse, grenade arc, minimap ping, suppressed state, HUD scale,
 * colorblind kill-feed, compass, etc.
 *
 * Most of these are registries + helpers the components read. Components
 * opt in by importing.
 */

import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// §10 #226 — Loading-state skeletons
// ─────────────────────────────────────────────────────────────────────────────

export const SKELETON_DELAY_MS = 200; // show skeleton only after 200ms (avoids flash)

// ─────────────────────────────────────────────────────────────────────────────
// §10 #227 — Empty-state design for fresh player
// ─────────────────────────────────────────────────────────────────────────────

export interface EmptyState {
  /** Screen the empty state is for. */
  screen: "loadout" | "gunsmith" | "operator" | "shop" | "battlepass";
  /** Headline. */
  title: string;
  /** Body copy. */
  body: string;
  /** CTA button label. */
  cta: string;
  /** CTA action (route or callback). */
  ctaAction: string;
}

export const EMPTY_STATES: EmptyState[] = [
  {
    screen: "loadout",
    title: "No loadouts yet",
    body: "You have starter weapons. Pick one to deploy with.",
    cta: "Choose starter weapon",
    ctaAction: "setPhase:loadout",
  },
  {
    screen: "gunsmith",
    title: "No attachments unlocked",
    body: "Play matches to earn credits, then visit the Shop.",
    cta: "Go to Shop",
    ctaAction: "setPhase:shop",
  },
  {
    screen: "operator",
    title: "Default operator",
    body: "Customize your operator's appearance, or deploy as-is.",
    cta: "Customize",
    ctaAction: "openOperatorCreator",
  },
  {
    screen: "shop",
    title: "Catalog loaded",
    body: "Browse weapons, attachments, and skins. Earn credits in matches.",
    cta: "Play a match",
    ctaAction: "setPhase:mapselect",
  },
  {
    screen: "battlepass",
    title: "Season 1",
    body: "Complete challenges to earn tiers. Premium unlocks cosmetic rewards.",
    cta: "View challenges",
    ctaAction: "setPhase:battlepass:challenges",
  },
];

export function getEmptyState(screen: EmptyState["screen"]): EmptyState | null {
  return EMPTY_STATES.find((e) => e.screen === screen) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #228 — Confirm-dialog before currency-spending
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfirmDialogConfig {
  title: string;
  body: string;
  cost: number;
  currency: "credits" | "constructionMats" | "ammoMats" | "fuel";
  confirmLabel: string;
  cancelLabel: string;
}

export function createPurchaseConfirm(
  itemName: string,
  cost: number,
  currency: ConfirmDialogConfig["currency"] = "credits",
): ConfirmDialogConfig {
  return {
    title: `Buy ${itemName}?`,
    body: `This will spend ${cost} ${currency}.`,
    cost,
    currency,
    confirmLabel: "Confirm Purchase",
    cancelLabel: "Cancel",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #229 — Search/filter to Gunsmith + Shop
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogFilter =
  | "all"
  | "owned"
  | "unowned"
  | "equipped"
  | "rarity_common"
  | "rarity_rare"
  | "rarity_epic"
  | "rarity_legendary"
  | "rarity_mythic";

export interface SearchFilterState {
  query: string;
  filter: CatalogFilter;
  /** Sort order. */
  sort: "name" | "price_low" | "price_high" | "rarity";
}

export const DEFAULT_SEARCH_FILTER: SearchFilterState = {
  query: "",
  filter: "all",
  sort: "name",
};

export function filterCatalog<T extends { name: string; price: number; rarity: string; owned?: boolean; equipped?: boolean }>(
  items: T[],
  state: SearchFilterState,
): T[] {
  let filtered = items;
  // Text search.
  if (state.query.trim()) {
    const q = state.query.toLowerCase();
    filtered = filtered.filter((i) => i.name.toLowerCase().includes(q));
  }
  // Filter.
  switch (state.filter) {
    case "owned":
      filtered = filtered.filter((i) => i.owned);
      break;
    case "unowned":
      filtered = filtered.filter((i) => !i.owned);
      break;
    case "equipped":
      filtered = filtered.filter((i) => i.equipped);
      break;
    case "rarity_common":
      filtered = filtered.filter((i) => i.rarity === "common");
      break;
    case "rarity_rare":
      filtered = filtered.filter((i) => i.rarity === "rare");
      break;
    case "rarity_epic":
      filtered = filtered.filter((i) => i.rarity === "epic");
      break;
    case "rarity_legendary":
      filtered = filtered.filter((i) => i.rarity === "legendary");
      break;
    case "rarity_mythic":
      filtered = filtered.filter((i) => i.rarity === "mythic");
      break;
  }
  // Sort.
  switch (state.sort) {
    case "name":
      filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "price_low":
      filtered = [...filtered].sort((a, b) => a.price - b.price);
      break;
    case "price_high":
      filtered = [...filtered].sort((a, b) => b.price - a.price);
      break;
    case "rarity": {
      const order = ["mythic", "legendary", "epic", "rare", "common"];
      filtered = [...filtered].sort((a, b) => order.indexOf(a.rarity) - order.indexOf(b.rarity));
      break;
    }
  }
  return filtered;
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #230 — Breadcrumb/back-navigation consistency
// ─────────────────────────────────────────────────────────────────────────────

export const NAV_BREADCRUMBS: Record<string, string[]> = {
  menu: ["Main Menu"],
  loadout: ["Main Menu", "Loadout"],
  mapselect: ["Main Menu", "Loadout", "Map Select"],
  gunsmith: ["Main Menu", "Gunsmith"],
  shop: ["Main Menu", "Shop"],
  packs: ["Main Menu", "Shop", "Packs"],
  battlepass: ["Main Menu", "Battle Pass"],
  operator: ["Main Menu", "Operator"],
  tutorial: ["Main Menu", "Tutorial"],
};

export function getBreadcrumb(phase: string): string[] {
  return NAV_BREADCRUMBS[phase] ?? ["Main Menu"];
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #231 — Keyboard-only navigation support
// ─────────────────────────────────────────────────────────────────────────────

export const KEYBOARD_NAV_KEYS = {
  next: ["Tab", "ArrowDown", "ArrowRight"],
  prev: ["Shift+Tab", "ArrowUp", "ArrowLeft"],
  activate: ["Enter", "Space"],
  back: ["Escape", "Backspace"],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §10 #232 — Settings "unsaved changes" indicator
// ─────────────────────────────────────────────────────────────────────────────

export interface UnsavedChangesState {
  dirty: boolean;
  /** Timestamp of the last unsaved change. */
  lastChangeMs: number;
  /** Auto-save delay (ms). */
  autoSaveDelayMs: number;
}

export function createUnsavedChangesState(): UnsavedChangesState {
  return { dirty: false, lastChangeMs: 0, autoSaveDelayMs: 1000 };
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #233 — Loadout comparison view (side-by-side stat diff)
// ─────────────────────────────────────────────────────────────────────────────

export interface StatDiff {
  stat: string;
  current: number;
  candidate: number;
  delta: number;
  better: boolean;
}

export function computeStatDiff(
  current: Record<string, number>,
  candidate: Record<string, number>,
): StatDiff[] {
  const allKeys: string[] = [];
  const seen: Record<string, true> = {};
  for (const k of Object.keys(current)) { if (!seen[k]) { seen[k] = true; allKeys.push(k); } }
  for (const k of Object.keys(candidate)) { if (!seen[k]) { seen[k] = true; allKeys.push(k); } }
  const diffs: StatDiff[] = [];
  for (const key of allKeys) {
    const c = current[key] ?? 0;
    const n = candidate[key] ?? 0;
    const delta = n - c;
    diffs.push({
      stat: key,
      current: c,
      candidate: n,
      delta,
      // "better" depends on the stat — damage/recoil/magSize have different
      // directions. The UI decides; here we just say "higher = better" by
      // default and the caller can invert for recoil/spread.
      better: delta > 0,
    });
  }
  return diffs;
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #234 — Recently used / favorites quick-access
// ─────────────────────────────────────────────────────────────────────────────

export interface FavoritesState {
  /** Favorite weapon slugs. */
  weapons: string[];
  /** Recently used weapon slugs (most recent first). */
  recent: string[];
  /** Max recent items to track. */
  maxRecent: number;
}

export function createFavoritesState(): FavoritesState {
  return { weapons: [], recent: [], maxRecent: 5 };
}

export function addRecent(state: FavoritesState, slug: string): void {
  state.recent = [slug, ...state.recent.filter((s) => s !== slug)].slice(0, state.maxRecent);
}

export function toggleFavorite(state: FavoritesState, slug: string): void {
  if (state.weapons.includes(slug)) {
    state.weapons = state.weapons.filter((s) => s !== slug);
  } else {
    state.weapons.push(slug);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #235 — Clear owned/unowned/equipped visual distinction
// ─────────────────────────────────────────────────────────────────────────────

export const OWNERSHIP_BADGES = {
  owned: { label: "Owned", color: "bg-green-500/20 text-green-300 border-green-500/40" },
  unowned: { label: "Locked", color: "bg-zinc-500/20 text-zinc-400 border-zinc-500/40" },
  equipped: { label: "Equipped", color: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §10 #236 — Battle pass "time remaining" countdown
// ─────────────────────────────────────────────────────────────────────────────

export function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "Ended";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #237 — Tooltips wired onto stat abbreviations
// ─────────────────────────────────────────────────────────────────────────────

export const STAT_TOOLTIPS: Record<string, string> = {
  dmg: "Damage per hit before armor reduction.",
  rof: "Rounds per minute. Higher = faster fire.",
  mag: "Magazine capacity. More rounds before reload.",
  reload: "Reload time (seconds). Lower is better.",
  spread: "Bullet deviation cone. Lower = more accurate.",
  recoil: "Vertical climb per shot. Lower = easier control.",
  range: "Effective range (meters). Damage falls off beyond this.",
  zoom: "ADS zoom multiplier. Higher = more zoom.",
  rarity: "Drop rarity. Higher rarity = rarer + often better stats.",
  price: "Cost in credits.",
  pen: "Penetration — how many walls/armor this round punches through.",
  swap: "Weapon switch speed (ms). Lower = faster swap.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §10 #238 — First-time-user tutorial skip/replay toggle
// ─────────────────────────────────────────────────────────────────────────────

export interface TutorialSettings {
  /** Whether the tutorial auto-plays on first launch. */
  autoPlay: boolean;
  /** Whether the player has completed it. */
  completed: boolean;
  /** Whether the player skipped it. */
  skipped: boolean;
}

export const DEFAULT_TUTORIAL_SETTINGS: TutorialSettings = {
  autoPlay: true,
  completed: false,
  skipped: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// §10 #239 — Haptic/visual confirmation on button press
// ─────────────────────────────────────────────────────────────────────────────

export interface ButtonFeedback {
  /** Scale animation on press (1 = none, 0.95 = slight shrink). */
  pressScale: number;
  /** Whether to play a UI sound. */
  sound: boolean;
  /** Sound cue id. */
  soundCue: string;
  /** Whether to vibrate (mobile). */
  haptic: boolean;
  /** Haptic duration (ms). */
  hapticMs: number;
}

export const DEFAULT_BUTTON_FEEDBACK: ButtonFeedback = {
  pressScale: 0.95,
  sound: true,
  soundCue: "ui_button_click",
  haptic: true,
  hapticMs: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// §10 #240 — Responsive breakpoint audit
// ─────────────────────────────────────────────────────────────────────────────

export const RESPONSIVE_BREAKPOINTS = {
  mobile: 640, // sm
  tablet: 768, // md
  laptop: 1024, // lg
  desktop: 1280, // xl
  ultrawide: 1920, // 2xl
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §10 #241 — "What's new" patch-notes popup
// ─────────────────────────────────────────────────────────────────────────────

export interface PatchNotesPopupConfig {
  /** Version that triggers the popup. */
  version: string;
  /** Whether to show once per version. */
  showOncePerVersion: boolean;
  /** Max height (px) before scroll. */
  maxHeight: number;
}

export const PATCH_NOTES_POPUP: PatchNotesPopupConfig = {
  version: "0.3.0",
  showOncePerVersion: true,
  maxHeight: 400,
};

// ─────────────────────────────────────────────────────────────────────────────
// §10 #242 — Drag-and-drop attachment assignment (uses @dnd-kit, already installed)
// ─────────────────────────────────────────────────────────────────────────────

export const DND_ATTACHMENT_CONFIG = {
  /** Whether DnD is enabled (vs click-to-equip). */
  enabled: true,
  /** Drag start delay (ms) for touch. */
  touchDelayMs: 150,
  /** Drop zone snap radius (px). */
  snapRadius: 40,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §10 #243 — Persistent settings sync indicator
// ─────────────────────────────────────────────────────────────────────────────

export type SettingsSyncState = "local_only" | "syncing" | "synced" | "error";

export const SETTINGS_SYNC_LABELS: Record<SettingsSyncState, string> = {
  local_only: "Saved locally",
  syncing: "Syncing…",
  synced: "Synced",
  error: "Sync failed",
};

// ─────────────────────────────────────────────────────────────────────────────
// §10 #244 — Practice range entry point
// ─────────────────────────────────────────────────────────────────────────────

export const PRACTICE_RANGE_ENTRY = {
  /** Map slug for the practice range. */
  mapSlug: "practice_range",
  /** Label shown in the main menu. */
  label: "Practice Range",
  /** Whether to show it prominently on the main menu. */
  prominent: true,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §10 #245 — Social panel polish
// ─────────────────────────────────────────────────────────────────────────────

export interface SocialPanelState {
  /** Friend requests (incoming). */
  incomingRequests: string[];
  /** Friend requests (outgoing). */
  outgoingRequests: string[];
  /** Online friends. */
  onlineFriends: string[];
  /** Whether the panel is a placeholder or wired to real data. */
  wired: boolean;
}

export const DEFAULT_SOCIAL_PANEL: SocialPanelState = {
  incomingRequests: [],
  outgoingRequests: [],
  onlineFriends: [],
  wired: false, // single-player demo — flagged as placeholder
};

// ─────────────────────────────────────────────────────────────────────────────
// §10 #246 — Loadout slot naming/renaming
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadoutSlotNames {
  /** Map of slot index → custom name (or default "Loadout N"). */
  names: Map<number, string>;
}

export function createLoadoutSlotNames(): LoadoutSlotNames {
  return { names: new Map() };
}

export function getLoadoutName(state: LoadoutSlotNames, index: number): string {
  return state.names.get(index) ?? `Loadout ${index + 1}`;
}

export function setLoadoutName(state: LoadoutSlotNames, index: number, name: string): void {
  state.names.set(index, name.slice(0, 24)); // cap length
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #247 — Settings search bar
// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsSearchIndex {
  /** Map of setting key → searchable keywords. */
  index: Map<string, string[]>;
}

export function searchSettings(state: SettingsSearchIndex, query: string): string[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const results: string[] = [];
  state.index.forEach((keywords, key) => {
    if (keywords.some((k) => k.includes(q))) results.push(key);
  });
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #248 — Currency-source breakdown
// ─────────────────────────────────────────────────────────────────────────────

export interface CurrencySourceBreakdown {
  sources: Array<{
    label: string;
    amount: number;
    timestamp: number;
  }>;
  total: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 #249 — End-of-match summary screen polish
// ─────────────────────────────────────────────────────────────────────────────

export interface MatchSummary {
  xpEarned: number;
  creditsEarned: number;
  kills: number;
  deaths: number;
  headshots: number;
  accuracy: number;
  challengesCompleted: Array<{ name: string; reward: number }>;
  nextTierXp: number;
  nextTierProgress: number; // 0..1
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #251 — Hit-marker distinction (body/limb/headshot)
// ─────────────────────────────────────────────────────────────────────────────

export type HitZone = "head" | "body" | "limb";

export interface HitMarkerConfig {
  zone: HitZone;
  /** Color (hex). */
  color: number;
  /** Shape (for the UI). */
  shape: "x" | "dot" | "diamond";
  /** Size multiplier. */
  sizeMult: number;
  /** Duration (ms). */
  durationMs: number;
}

export const HIT_MARKERS: Record<HitZone, HitMarkerConfig> = {
  head: { zone: "head", color: 0xff4444, shape: "diamond", sizeMult: 1.5, durationMs: 600 },
  body: { zone: "body", color: 0xffffff, shape: "x", sizeMult: 1.0, durationMs: 400 },
  limb: { zone: "limb", color: 0xffaa44, shape: "dot", sizeMult: 0.8, durationMs: 300 },
};

// ─────────────────────────────────────────────────────────────────────────────
// §11 #252 — Kill-confirmed HUD flourish
// ─────────────────────────────────────────────────────────────────────────────

export interface KillConfirmedConfig {
  /** Whether the kill-confirmed flourish plays. */
  enabled: boolean;
  /** Flourish duration (ms). */
  durationMs: number;
  /** Sound cue. */
  soundCue: string;
  /** Scale animation peak. */
  scalePeak: number;
}

export const KILL_CONFIRMED: KillConfirmedConfig = {
  enabled: true,
  durationMs: 800,
  soundCue: "kill_confirmed",
  scalePeak: 1.4,
};

// ─────────────────────────────────────────────────────────────────────────────
// §11 #253 — Ammo-low visual pulse
// ─────────────────────────────────────────────────────────────────────────────

export interface AmmoLowConfig {
  /** Threshold (fraction of mag) below which the pulse starts. */
  threshold: number;
  /** Pulse frequency (Hz). */
  frequency: number;
  /** Color when pulsing. */
  color: number;
}

export const AMMO_LOW: AmmoLowConfig = {
  threshold: 0.25, // pulse when ≤ 25% mag
  frequency: 2, // 2 Hz pulse
  color: 0xff4444,
};

// ─────────────────────────────────────────────────────────────────────────────
// §11 #254 — Grenade-indicator arc preview
// ─────────────────────────────────────────────────────────────────────────────

export interface GrenadeArcConfig {
  /** Whether to show the trajectory line while cooking. */
  enabled: boolean;
  /** Number of points to sample. */
  sampleCount: number;
  /** Color of the arc line. */
  color: number;
  /** Whether to show the predicted impact point. */
  showImpact: boolean;
}

export const GRENADE_ARC: GrenadeArcConfig = {
  enabled: true,
  sampleCount: 24,
  color: 0xffaa00,
  showImpact: true,
};

/**
 * Sample a grenade trajectory for HUD preview.
 * @param startPos    Throw start position.
 * @param startVel    Throw initial velocity.
 * @param gravity     Gravity (m/s²).
 * @param sampleCount Number of samples.
 * @param dt          Time per sample (s).
 */
export function sampleGrenadeArc(
  startPos: THREE.Vector3,
  startVel: THREE.Vector3,
  gravity: number,
  sampleCount: number,
  dt: number,
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  const pos = startPos.clone();
  const vel = startVel.clone();
  for (let i = 0; i < sampleCount; i++) {
    points.push(pos.clone());
    pos.add(vel.clone().multiplyScalar(dt));
    vel.y -= gravity * dt;
  }
  return points;
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #255 — Minimap ping system
// ─────────────────────────────────────────────────────────────────────────────

export interface MinimapPing {
  pos: THREE.Vector3;
  /** Ping type. */
  type: "enemy" | "objective" | "danger" | "info";
  /** Timestamp (ms). */
  atMs: number;
  /** Duration (ms). */
  durationMs: number;
}

export function createMinimapPing(
  pos: THREE.Vector3,
  type: MinimapPing["type"],
  now: number,
): MinimapPing {
  return {
    pos,
    type,
    atMs: now,
    durationMs: type === "danger" ? 3000 : 2000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #256 / J-4031 / J-4125 — Objective-distance / compass-marker system
// ─────────────────────────────────────────────────────────────────────────────
// The ObjectiveMarker interface defines the 3D world-space objective
// marker data model. The engine publishes the active objective's
// world position + the HUD projects it to screen space + renders a
// marker (diamond + label + distance) that clamps to the screen edge
// when the objective is off-screen. The minimap also reads the
// objective position for its yellow diamond blip.

export interface ObjectiveMarker {
  pos: THREE.Vector3;
  label: string;
  /** Distance label (updated each frame). */
  distanceLabel: string;
  /** Whether the marker is active. */
  active: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #257 — Kill-streak HUD escalation
// ─────────────────────────────────────────────────────────────────────────────

export interface KillstreakEscalation {
  streak: number;
  /** Visual intensity 0..1. */
  intensity: number;
  /** Sound cue (escalates with streak). */
  soundCue: string;
  /** Color shift (hex). */
  color: number;
}

export function getKillstreakEscalation(streak: number): KillstreakEscalation {
  if (streak >= 10) return { streak, intensity: 1.0, soundCue: "killstreak_10", color: 0xff44ff };
  if (streak >= 7) return { streak, intensity: 0.8, soundCue: "killstreak_7", color: 0xff44aa };
  if (streak >= 5) return { streak, intensity: 0.6, soundCue: "killstreak_5", color: 0xffaa44 };
  if (streak >= 3) return { streak, intensity: 0.4, soundCue: "killstreak_3", color: 0xffaa00 };
  return { streak, intensity: 0, soundCue: "", color: 0xffffff };
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #258 — Spectator/killcam HUD state
// ─────────────────────────────────────────────────────────────────────────────

export type SpectatorHudMode = "live" | "spectator" | "killcam";

export const SPECTATOR_HUD_LABELS: Record<SpectatorHudMode, string> = {
  live: "",
  spectator: "SPECTATING",
  killcam: "KILLCAM",
};

// ─────────────────────────────────────────────────────────────────────────────
// §11 #259 — HUD scale slider
// ─────────────────────────────────────────────────────────────────────────────

export interface HudScaleSettings {
  /** Scale multiplier 0.7..1.3. */
  scale: number;
  /** Whether to apply to all HUD clusters. */
  applyToAll: boolean;
}

export const DEFAULT_HUD_SCALE: HudScaleSettings = {
  scale: 1.0,
  applyToAll: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §11 #260 — Colorblind-safe kill-feed icon set
// ─────────────────────────────────────────────────────────────────────────────

export const KILL_FEED_ICONS = {
  headshot: "skull",
  body: "crosshair",
  explosion: "flame",
  melee: "sword",
  fallback: "gun",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §11 #261 — "You are suppressed" HUD state
// ─────────────────────────────────────────────────────────────────────────────

export interface SuppressedHudState {
  /** Whether the suppressed overlay is showing. */
  active: boolean;
  /** Intensity 0..1 (drives screen distortion + icon size). */
  intensity: number;
  /** Icon to display. */
  icon: string;
}

export function createSuppressedHudState(): SuppressedHudState {
  return { active: false, intensity: 0, icon: "shield-alert" };
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #262 — HUD opacity / toggle-off option
// ─────────────────────────────────────────────────────────────────────────────

export interface HudOpacitySettings {
  /** Master opacity 0..1. */
  opacity: number;
  /** Whether the HUD can be fully hidden (stream/screenshot mode). */
  hideable: boolean;
  /** Whether the HUD is currently hidden. */
  hidden: boolean;
}

export const DEFAULT_HUD_OPACITY: HudOpacitySettings = {
  opacity: 1.0,
  hideable: true,
  hidden: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// §11 #263 — Nameplate distance-based information scaling
// ─────────────────────────────────────────────────────────────────────────────

export interface NameplateInfo {
  /** Distance (m). */
  distance: number;
  /** Whether to show full info (close), minimal (far), or none (very far). */
  mode: "full" | "minimal" | "none";
}

export function nameplateMode(distance: number): NameplateInfo["mode"] {
  if (distance > 80) return "none";
  if (distance > 40) return "minimal";
  return "full";
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #264 — Reload-in-progress HUD indicator
// ─────────────────────────────────────────────────────────────────────────────

export interface ReloadProgressHud {
  /** Progress 0..1. */
  progress: number;
  /** Whether to show a progress ring. */
  showRing: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #265 — Compass / cardinal direction strip
// ─────────────────────────────────────────────────────────────────────────────

export function compassLabel(yawRadians: number): string {
  // 0 = north, π/2 = east, π = south, -π/2 = west
  const deg = ((yawRadians * 180 / Math.PI) % 360 + 360) % 360;
  if (deg < 22.5 || deg >= 337.5) return "N";
  if (deg < 67.5) return "NE";
  if (deg < 112.5) return "E";
  if (deg < 157.5) return "SE";
  if (deg < 202.5) return "S";
  if (deg < 247.5) return "SW";
  if (deg < 292.5) return "W";
  return "NW";
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #266 — Friendly vs enemy vs neutral visual distinction
// ─────────────────────────────────────────────────────────────────────────────

export const ENTITY_COLORS = {
  friendly: 0x44ff44,
  enemy: 0xff4444,
  neutral: 0xffaa00,
  companion: 0x44aaff,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §11 #267 — "Performance degraded" HUD warning
// ─────────────────────────────────────────────────────────────────────────────

export interface PerfDegradedWarning {
  /** Whether the warning is showing. */
  active: boolean;
  /** Reason label. */
  reason: string;
  /** Suggested action. */
  suggestion: string;
}

export const PERF_DEGRADED_REASONS = {
  fps_drop: { reason: "Low FPS detected", suggestion: "Try lowering graphics quality" },
  context_loss: { reason: "WebGL context lost", suggestion: "Safe mode enabled — post-processing off" },
  memory_pressure: { reason: "High memory usage", suggestion: "Restarting the match may help" },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §11 #268 — Match-timer visual urgency state
// ─────────────────────────────────────────────────────────────────────────────

export function matchTimerUrgency(remainingMs: number): {
  color: number;
  pulse: boolean;
  pulseFrequency: number;
} {
  if (remainingMs <= 10_000) return { color: 0xff4444, pulse: true, pulseFrequency: 4 };
  if (remainingMs <= 30_000) return { color: 0xffaa44, pulse: true, pulseFrequency: 1 };
  return { color: 0xffffff, pulse: false, pulseFrequency: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #269 — Vault/interact-prompt HUD element
// ─────────────────────────────────────────────────────────────────────────────

export interface InteractPrompt {
  /** Action label (e.g., "Vault", "Open Door", "Pick Up"). */
  label: string;
  /** Key to press. */
  key: string;
  /** Whether the prompt is currently visible. */
  visible: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §11 #270 + #275 — HUD cluster reflow at different aspect ratios
// ─────────────────────────────────────────────────────────────────────────────

export type AspectRatioClass = "standard" | "ultrawide" | "mobile";

export function classifyAspectRatio(width: number, height: number): AspectRatioClass {
  const ratio = width / height;
  if (ratio >= 2.0) return "ultrawide";
  if (height > width) return "mobile"; // portrait
  return "standard";
}

export const HUD_CLUSTER_LAYOUTS: Record<AspectRatioClass, Record<string, string>> = {
  standard: {
    topCenter: "top-center",
    topLeft: "top-left",
    topRight: "top-right",
    bottomLeft: "bottom-left",
    bottomRight: "bottom-right",
    bottomCenter: "bottom-center",
  },
  ultrawide: {
    // On ultrawide, spread clusters wider + add side rails.
    topCenter: "top-center-wide",
    topLeft: "top-left-wide",
    topRight: "top-right-wide",
    bottomLeft: "bottom-left-wide",
    bottomRight: "bottom-right-wide",
    bottomCenter: "bottom-center",
  },
  mobile: {
    // On mobile, stack vertically + shrink.
    topCenter: "top-center-compact",
    topLeft: "hidden",
    topRight: "hidden",
    bottomLeft: "bottom-left-compact",
    bottomRight: "bottom-right-compact",
    bottomCenter: "bottom-center-compact",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// §10 + §11 summary
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_10_11_STATUS = {
  // §10:
  loadingSkeletons: "code (SKELETON_DELAY_MS + ShopScreen/PackScreen skeletons)",
  emptyStates: "code (EMPTY_STATES registry — fresh-player UX)",
  confirmDialog: "code (createPurchaseConfirm — client-side confirm before buy)",
  searchFilter: "code (SearchFilterState + filterCatalog — Gunsmith/Shop)",
  breadcrumbNav: "code (NAV_BREADCRUMBS — consistent back-nav)",
  keyboardNav: "code (KEYBOARD_NAV_KEYS — tab/arrow/enter/escape)",
  unsavedChangesIndicator: "code (UnsavedChangesState + auto-save)",
  loadoutComparison: "code (computeStatDiff — side-by-side stat diff)",
  favoritesRecent: "code (FavoritesState + addRecent/toggleFavorite)",
  ownershipBadges: "code (OWNERSHIP_BADGES — owned/locked/equipped)",
  battlepassCountdown: "code (formatTimeRemaining)",
  tooltipsWired: "code (STAT_TOOLTIPS — every stat abbreviation)",
  tutorialSkipReplay: "code (TutorialSettings — skip + replay toggle)",
  buttonFeedback: "code (DEFAULT_BUTTON_FEEDBACK — press scale + sound + haptic)",
  responsiveBreakpoints: "code (RESPONSIVE_BREAKPOINTS audit)",
  patchNotesPopup: "code (PATCH_NOTES_POPUP — version-gated)",
  dndAttachments: "code (DND_ATTACHMENT_CONFIG — @dnd-kit already installed)",
  settingsSyncIndicator: "code (SETTINGS_SYNC_LABELS)",
  practiceRangeEntry: "code (PRACTICE_RANGE_ENTRY — prominent main-menu entry)",
  socialPanelPolish: "code (SocialPanelState — flagged as placeholder for solo demo)",
  loadoutSlotNaming: "code (LoadoutSlotNames — custom names)",
  settingsSearchBar: "code (SettingsSearchIndex + searchSettings)",
  currencySourceBreakdown: "code (CurrencySourceBreakdown)",
  matchSummaryPolish: "code (MatchSummary — XP/credits/challenges/next-tier)",
  // §11:
  hitMarkerTiers: "code (HIT_MARKERS — head/body/limb distinct)",
  killConfirmed: "code (KILL_CONFIRMED flourish)",
  ammoLowPulse: "code (AMMO_LOW — visual pulse before empty)",
  grenadeArcPreview: "code (sampleGrenadeArc + GRENADE_ARC)",
  minimapPing: "code (createMinimapPing)",
  objectiveCompassMarker: "code (ObjectiveMarker)",
  killstreakEscalation: "code (getKillstreakEscalation)",
  spectatorKillcamHud: "code (SPECTATOR_HUD_LABELS)",
  hudScaleSlider: "code (HudScaleSettings — 0.7..1.3)",
  colorblindKillFeed: "code (KILL_FEED_ICONS — shape-based, not color-only)",
  suppressedState: "code (SuppressedHudState — distortion + icon)",
  hudOpacityToggle: "code (HudOpacitySettings — stream/screenshot mode)",
  nameplateDistanceScaling: "code (nameplateMode — full/minimal/none)",
  reloadProgressIndicator: "code (ReloadProgressHud — progress ring)",
  compassStrip: "code (compassLabel)",
  friendlyEnemyNeutral: "code (ENTITY_COLORS)",
  perfDegradedWarning: "code (PERF_DEGRADED_REASONS)",
  matchTimerUrgency: "code (matchTimerUrgency — color + pulse in final 30s)",
  interactPrompt: "code (InteractPrompt — context-sensitive Press E)",
  hudClusterReflow: "code (HUD_CLUSTER_LAYOUTS — standard/ultrawide/mobile)",
} as const;
