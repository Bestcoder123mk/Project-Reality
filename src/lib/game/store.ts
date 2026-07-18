import { create } from "zustand";
import { setActiveCustomization } from "./operators";
import {
  DEFAULT_CUSTOMIZATION,
  type OperatorCustomization,
  type OperatorCustomizationOverrides,
} from "./OperatorCustom";
import type { WrapSlug } from "./Wraps";
import type { CharmSlug } from "./Charms";

export type GamePhase = "menu" | "loadout" | "mapselect" | "gunsmith" | "shop" | "packs" | "battlepass" | "tutorial" | "settings" | "operator" | "playing" | "paused" | "dead" | "victory";
export type ViewMode = "first" | "third";

export type WeaponCategory = "RIFLE" | "SMG" | "PISTOL" | "SNIPER" | "SHOTGUN" | "LMG";

/** Weapon slug — matches the DB catalog.
 *  Task-5: expanded from 10 → 30 weapons across all categories. */
export type WeaponType =
  // Original 10
  | "ak74" | "m4" | "mp7" | "p90" | "usp" | "deagle" | "awp" | "scout" | "nova"
  | "m249"
  // Task-5 — RIFLE additions (incl. battle rifle mk17 + marksman mk14)
  | "hk416" | "famas" | "aug" | "scarh" | "galil" | "mk17" | "mk14"
  // Task-5 — SMG additions
  | "mp5" | "ump45" | "vector" | "pp90m1"
  // Task-5 — PISTOL additions
  | "glock18" | "m1911" | "revolver"
  // Task-5 — SNIPER additions
  | "kar98k" | "l115a3"
  // Task-5 — SHOTGUN additions
  | "m1014" | "spas12"
  // Task-5 — LMG additions
  | "rpk" | "mk48";

export type AttachmentType = "MUZZLE" | "SIGHT" | "GRIP" | "MAGAZINE";
export type AttachmentSlug =
  | "none"
  | "suppressor" | "compensator"
  | "red_dot" | "holo" | "acog" | "scope8x"
  | "foregrip" | "angled_grip"
  | "ext_mag" | "quick_mag";

export type SkinSlug = "default" | "gold" | "carbon" | "tiger" | "neon" | "arctic";
export type Rarity = "COMMON" | "RARE" | "EPIC" | "LEGENDARY";

export interface WeaponConfig {
  id: WeaponType;
  name: string;
  category: WeaponCategory;
  damage: number;
  fireRate: number;
  magSize: number;
  reloadTime: number;
  spread: number;
  recoil: number;
  range: number;
  automatic: boolean;
  zoom: number;
  price: number;
  rarity: Rarity;
  /** Task-5 — short flavour/usage description for the loadout + shop UI. */
  description: string;
}

export interface AttachmentConfig {
  slug: AttachmentSlug;
  name: string;
  type: AttachmentType;
  price: number;
  damageMod: number;
  recoilMod: number;
  spreadMod: number;
  rangeMod: number;
  zoomMod: number;
  magSizeMod: number;
  reloadMod: number;
  rarity: Rarity;
}

export interface SkinConfig {
  slug: SkinSlug;
  name: string;
  rarity: Rarity;
  price: number;
  colorHex: string;
}

export interface LoadoutConfig {
  weapon: WeaponType;       // primary weapon (rifle/SMG/shotgun/sniper)
  secondary: WeaponType;    // secondary weapon (pistol)
  melee: string;            // melee weapon slug
  utility: string;          // utility item slug
  muzzle: AttachmentSlug;
  sight: AttachmentSlug;
  grip: AttachmentSlug;
  magazine: AttachmentSlug;
  skin: SkinSlug;
  /** Task-2d — equipped weapon wrap (camo pattern). Defaults to "default". */
  wrap?: WrapSlug;
  /** Task-2d — equipped weapon charm. Defaults to "none". */
  charm?: CharmSlug;
}

export interface EffectiveWeaponStats extends WeaponConfig {
  effectiveDamage: number;
  effectiveFireRate: number;
  effectiveMagSize: number;
  effectiveReloadTime: number;
  effectiveSpread: number;
  effectiveRecoil: number;
  effectiveRange: number;
  effectiveZoom: number;
  scoped: boolean; // true if sight is scope8x or weapon is sniper with scope
}

export interface CrosshairSettings {
  /** "cross" | "circle" | "dot" | "cross+dot" | "T" */
  style: "cross" | "circle" | "dot" | "cross+dot" | "T";
  /** Hex color, e.g. "#00ff88". */
  color: string;
  /** Show a center dot. */
  showDot: boolean;
  /** Length of each crosshair line in px (0-20). */
  length: number;
  /** Thickness of each line in px (1-4). */
  thickness: number;
  /** Gap between center and lines in px (0-20). */
  gap: number;
  /** Add a outline/shadow to the crosshair for visibility. */
  outline: boolean;
  /** Scale up when moving / firing (dynamic spread). */
  dynamicSpread: boolean;
}

export interface OperatorSettings {
  callsign: string;
  facePreset: number;        // 0..11
  skinTone: number;          // 0.0..1.0
  hairStyle: string;         // "buzz"|"fade"|"undercut"|"ponytail"|"bun"|"braids"|"afro"|"bald"
  hairColor: string;         // hex
  facialHair: string;        // "none"|"stubble"|"goatee"|"full"|"mustache"
  eyeColor: string;          // hex
  bodyType: "lean" | "athletic" | "stocky";
  heightCm: number;          // 160..200
  suitColor: string;         // hex (operator suit)
  voicePack: string;         // "us_male_01" etc.
}

export interface ExtendedSettings {
  /** Aim-down-sights sensitivity multiplier (0.2..1.0). */
  aimSensitivity: number;
  /** ADS mode: "hold" = right-click hold, "toggle" = right-click toggle. */
  adsMode: "hold" | "toggle";
  /** Field-of-view lerp speed for ADS (higher = snappier). */
  adsSpeed: number;
  /** Motion-sickness mode: disables head bob + FOV kick. */
  motionSickness: boolean;
  /** Colorblind filter mode. */
  colorblind: "none" | "protanopia" | "deuteranopia" | "tritanopia";
  /** Master volume sub-bus (0..1). */
  masterVolume: number;
  /** SFX volume sub-bus (0..1). */
  sfxVolume: number;
  /** Music volume sub-bus (0..1). */
  musicVolume: number;
  /** Voice volume sub-bus (0..1). */
  voiceVolume: number;
  /** Task 3 / item 65 — "Reduced effects" preset. When true, ClothSim,
   *  RagdollSystem, and VoronoiFracture early-out their per-frame simulation
   *  (meshes still render at their rest pose). Auto-set by the hardware
   *  benchmark on integrated GPUs; user can override in the settings panel. */
  reducedEffects: boolean;
  // ─── J-5000-retry — Section J accessibility/i18n fields. The prior
  //     I-961..I-1000 mission added these to ExtendedSettings.ts (the
  //     separate preset/share-code module) but NOT to the store's
  //     ExtendedSettings interface, so the AccessibilityPanel refs
  //     (`settings.extended.subtitlesEnabled` etc.) failed tsc. Adding
  //     them here so the store-backed `settings.extended` blob is the
  //     single source of truth the panels read/write. ───────────────
  /** J-4051 — subtitles toggle (was visual.subtitles which reset on tab switch). */
  subtitlesEnabled: boolean;
  /** J-4052 — subtitle background opacity (0 = transparent, 1 = solid). */
  subtitleBackground: number;
  /** J-4052 — subtitle text color (hex). */
  subtitleColor: string;
  /** J-4053 — audio ducking in dB (0 = off, 6 = moderate). */
  audioDuckDb: number;
  /** J-4054 — motor assist / one-handed mode. */
  motorAssist: boolean;
  /** J-4055 — non-VO ambient captions. */
  ambientCaptions: boolean;
  /** J-4057 — dyslexia-friendly font toggle. */
  dyslexiaFont: boolean;
  /** J-4059 — RTL layout toggle (Arabic / Hebrew). */
  rtlLayout: boolean;
  /** J-4065 — hold-vs-toggle per action. */
  holdToggle: { sprint: "hold" | "toggle"; ads: "hold" | "toggle"; crouch: "hold" | "toggle" };
  /** J-4066 — practice game speed slider (0.25..2.0). */
  practiceGameSpeed: number;
  /** J-4067 — auto-sprint toggle. */
  autoSprint: boolean;
  /** J-4068 — input buffer window in ms. */
  inputBufferMs: number;
  /** J-4037 — low-health vignette color (hex). Default red (#dc2626).
   *  The HUD's HP-tier vignette reads this so colorblind players can
   *  pick a hue they can distinguish (e.g. amber for protanopia). */
  lowHealthVignetteColor: string;
}

export interface Settings {
  sensitivity: number;
  fov: number;
  volume: number;
  shadows: boolean;
  quality: "low" | "medium" | "high";
  showFps: boolean;
  /** G4.2 — Difficulty multiplier applied to enemy health/accuracy/spawnWeight.
   *  A2-5000-retry #350 — `insane` added (was unreachable: Difficulty.ts
   *  + AIEnhancements.ts already defined the tier + its config, but the
   *  Settings type didn't allow selecting it). The GameplayPanel still
   *  offers only easy/normal/hard (UI section-owned); the store type
   *  widening lets code paths (debug overlay, tests, future UI) set insane
   *  without a runtime cast. */
  difficulty: "easy" | "normal" | "hard" | "insane";
  /** Crosshair customization. */
  crosshair: CrosshairSettings;
  /** Extended gameplay/audio/a11y settings. */
  extended: ExtendedSettings;
}

export interface KillFeedEntry {
  id: number;
  killer: string;
  victim: string;
  weapon: string;
  headshot: boolean;
  time: number;
}

// ---------- P2.3: Sliced HUD types ----------

/** Combat slice — updates every frame (small, motion-critical). */
export interface HudCombatSlice {
  health: number;
  maxHealth: number;
  armor: number;
  ammo: number;
  magSize: number;
  reserveAmmo: number;
  weaponName: string;
  reloading: boolean;
  reloadProgress: number;
  aiming: boolean;
  scoped: boolean;
  viewMode: ViewMode;
}

/** Meta slice — updates at most 5 Hz (wave/score/kills/etc.). */
export interface HudMetaSlice {
  score: number;
  kills: number;
  deaths: number;
  enemiesRemaining: number;
  totalEnemies: number;
  wave: number;
  objective: string;
  fps: number;
  credits: number;
  xpGained: number;
}

/** Realism slice — updates at most 5 Hz (suppression/casualty/weather). */
export interface HudRealismSlice {
  suppression: number;
  casualtyState: "ACTIVE" | "BLEEDING" | "FRACTURED" | "UNCONSCIOUS";
  bleedRate: number;
  medicalInventory: { bandage: number; splint: number; epi: number; medkit: number };
  medicalChannel: { slug: string; progress: number } | null;
  timeOfDay: number;
  weather: string;
  windSpeed: number;
}

/** Transient slice — event-driven (hit markers, damage flash, radio, killfeed). */
export interface HudTransientSlice {
  hitMarker: number;
  /** Task-6: kill-confirmation marker timestamp. Distinct from hitMarker so
   *  the HUD can render a deeper/larger confirmation marker on kill. */
  killMarker: number;
  /** Task-6: headshot-kill marker timestamp. Distinct from killMarker so the
   *  HUD can render a special headshot icon (e.g. red X) on headshot kills. */
  headshotMarker: number;
  /** Task-6: multi-kill notification payload. Set when 2+ kills land within
   *  2s. The HUD renders "DOUBLE KILL", "TRIPLE KILL", etc. */
  multiKill: { text: string; count: number; time: number } | null;
  damageFlash: number;
  killFeed: KillFeedEntry[];
  radioMessage: { text: string; channel: string; time: number } | null;
}

/**
 * HudState — kept as a union of all slices for backward compat.
 * P2.3 components should subscribe to individual slices via selectors.
 */
export interface HudState extends HudCombatSlice, HudMetaSlice, HudRealismSlice, HudTransientSlice {}

export const WEAPONS: Record<WeaponType, WeaponConfig> = {
  // ──────────────────────────────────────────────────────────────
  // Original 10 weapons (descriptions backfilled in Task-5).
  // ──────────────────────────────────────────────────────────────
  // REALISM-1 (task F): per-weapon stat differentiation — each weapon has
  // a clear niche (damage / fire rate / mag / range / recoil trade-offs).
  // No weapon is strictly worse than another; each is the best at SOMETHING.
  ak74: { id: "ak74", name: "AK-74", category: "RIFLE", damage: 30, fireRate: 105, magSize: 30, reloadTime: 2200, spread: 0.012, recoil: 0.028, range: 200, automatic: true, zoom: 1.45, price: 0, rarity: "COMMON", description: "Reliable 5.45mm Soviet rifle. Hardest-hitting 5.45/5.56mm rifle — stout recoil is the trade." },
  m4: { id: "m4", name: "M4 Carbine", category: "RIFLE", damage: 26, fireRate: 85, magSize: 30, reloadTime: 2100, spread: 0.010, recoil: 0.018, range: 200, automatic: true, zoom: 1.5, price: 2500, rarity: "RARE", description: "Versatile 5.56mm NATO carbine. Lowest recoil + fastest cyclic of the 5.56 rifles — the laser." },
  mp7: { id: "mp7", name: "MP-7", category: "SMG", damage: 18, fireRate: 70, magSize: 40, reloadTime: 1800, spread: 0.020, recoil: 0.018, range: 120, automatic: true, zoom: 1.3, price: 0, rarity: "COMMON", description: "Compact 4.6mm PDW. Highest-capacity PDW mag (40), softest-shooting — CQB gold standard." },
  p90: { id: "p90", name: "P90", category: "SMG", damage: 16, fireRate: 60, magSize: 50, reloadTime: 2000, spread: 0.022, recoil: 0.016, range: 110, automatic: true, zoom: 1.3, price: 1800, rarity: "RARE", description: "Bullpup 5.7x28mm SMG with the biggest SMG mag (50). Sustained pressure without reloads." },
  usp: { id: "usp", name: "USP-S", category: "PISTOL", damage: 24, fireRate: 180, magSize: 12, reloadTime: 1500, spread: 0.008, recoil: 0.020, range: 100, automatic: false, zoom: 1.35, price: 0, rarity: "COMMON", description: "Suppressed .45 sidearm. Tightest pistol spread + fastest reload — the precision pick." },
  deagle: { id: "deagle", name: "Desert Eagle", category: "PISTOL", damage: 48, fireRate: 300, magSize: 7, reloadTime: 2000, spread: 0.012, recoil: 0.045, range: 120, automatic: false, zoom: 1.4, price: 1200, rarity: "RARE", description: ".50 AE hand-cannon. Highest pistol damage — two-shot kills, kicks like a mule." },
  awp: { id: "awp", name: "AWP-X", category: "SNIPER", damage: 115, fireRate: 900, magSize: 5, reloadTime: 3000, spread: 0.001, recoil: 0.06, range: 400, automatic: false, zoom: 3.5, price: 4500, rarity: "LEGENDARY", description: ".338 Lapua magnum sniper. One-shot torso kill — heavy bolt cycle is the trade." },
  scout: { id: "scout", name: "Scout", category: "SNIPER", damage: 80, fireRate: 650, magSize: 10, reloadTime: 2500, spread: 0.002, recoil: 0.04, range: 350, automatic: false, zoom: 3.0, price: 2000, rarity: "RARE", description: "Lightweight 7.62mm marksman. Fastest sniper bolt cycle + biggest mag — agility pick." },
  nova: { id: "nova", name: "Nova", category: "SHOTGUN", damage: 24, fireRate: 800, magSize: 8, reloadTime: 2600, spread: 0.05, recoil: 0.05, range: 60, automatic: false, zoom: 1.25, price: 1500, rarity: "RARE", description: "Pump 12-gauge. Highest per-shell damage of the shotguns — slowest cyclic is the trade." },
  m249: { id: "m249", name: "M249 SAW", category: "LMG", damage: 25, fireRate: 80, magSize: 100, reloadTime: 4500, spread: 0.018, recoil: 0.025, range: 220, automatic: true, zoom: 1.35, price: 3500, rarity: "EPIC", description: "5.56mm belt-fed LMG. Lowest LMG recoil + biggest mag (100) — suppressive-fire specialist." },

  // ──────────────────────────────────────────────────────────────
  // Task-5 — 20 new weapons across all categories.
  // ──────────────────────────────────────────────────────────────

  // ── RIFLE (incl. battle rifle + marksman, mapped to RIFLE category) ──
  hk416: { id: "hk416", name: "HK416", category: "RIFLE", damage: 27, fireRate: 88, magSize: 30, reloadTime: 2050, spread: 0.007, recoil: 0.016, range: 210, automatic: true, zoom: 1.5, price: 3000, rarity: "EPIC", description: "German piston 5.56mm. Tightest spread + lowest recoil of the rifles — the premium marksman AR." },
  famas: { id: "famas", name: "FAMAS F1", category: "RIFLE", damage: 30, fireRate: 80, magSize: 25, reloadTime: 2300, spread: 0.013, recoil: 0.028, range: 195, automatic: true, zoom: 1.4, price: 2200, rarity: "RARE", description: "French bullpup 5.56mm. Fastest rifle cyclic (80ms) — small 25-round mag is the trade." },
  aug: { id: "aug", name: "AUG A3", category: "RIFLE", damage: 28, fireRate: 92, magSize: 30, reloadTime: 2250, spread: 0.010, recoil: 0.020, range: 230, automatic: true, zoom: 1.65, price: 2600, rarity: "RARE", description: "Austrian bullpup. Longest rifle range (230) + highest zoom (1.65) — the long-range AR niche." },
  scarh: { id: "scarh", name: "SCAR-H", category: "RIFLE", damage: 38, fireRate: 95, magSize: 20, reloadTime: 2400, spread: 0.012, recoil: 0.036, range: 230, automatic: true, zoom: 1.5, price: 3200, rarity: "EPIC", description: "7.62mm battle rifle. Highest 7.62 rifle damage — big kick + small mag are the trades." },
  galil: { id: "galil", name: "Galil ACE 23", category: "RIFLE", damage: 29, fireRate: 100, magSize: 35, reloadTime: 2200, spread: 0.013, recoil: 0.026, range: 200, automatic: true, zoom: 1.45, price: 2000, rarity: "RARE", description: "Israeli 5.56mm. Biggest rifle mag (35) + fastest 5.56 reload — the budget workhorse." },
  mk17: { id: "mk17", name: "Mk17 SCAR", category: "RIFLE", damage: 40, fireRate: 105, magSize: 20, reloadTime: 2500, spread: 0.011, recoil: 0.035, range: 240, automatic: true, zoom: 1.55, price: 3800, rarity: "EPIC", description: "Battle rifle 7.62mm. Heaviest-hitting automatic rifle — slowest 7.62 cyclic is the trade." },
  mk14: { id: "mk14", name: "Mk14 EBR", category: "RIFLE", damage: 46, fireRate: 140, magSize: 15, reloadTime: 2600, spread: 0.008, recoil: 0.038, range: 320, automatic: true, zoom: 2.0, price: 4200, rarity: "LEGENDARY", description: "Marksman 7.62mm. Highest rifle damage + longest range (320) — bridges AR and sniper." },

  // ── SMG ──
  mp5: { id: "mp5", name: "MP5A3", category: "SMG", damage: 20, fireRate: 75, magSize: 30, reloadTime: 1900, spread: 0.014, recoil: 0.013, range: 115, automatic: true, zoom: 1.3, price: 1200, rarity: "COMMON", description: "9mm roller-delayed SMG. Tightest spread + lowest recoil of all SMGs — the iconic laser." },
  ump45: { id: "ump45", name: "UMP-45", category: "SMG", damage: 26, fireRate: 100, magSize: 25, reloadTime: 2100, spread: 0.020, recoil: 0.020, range: 120, automatic: true, zoom: 1.3, price: 1600, rarity: "RARE", description: ".45 ACP SMG. Highest SMG damage per shot — slowest cyclic is the trade." },
  vector: { id: "vector", name: "KRISS Vector", category: "SMG", damage: 17, fireRate: 45, magSize: 25, reloadTime: 2000, spread: 0.017, recoil: 0.010, range: 110, automatic: true, zoom: 1.3, price: 2400, rarity: "EPIC", description: "Super V .45 SMG. Fastest cyclic in the game (45ms) + lowest recoil — eats mags alive." },
  pp90m1: { id: "pp90m1", name: "PP-90M1", category: "SMG", damage: 18, fireRate: 65, magSize: 64, reloadTime: 2400, spread: 0.022, recoil: 0.019, range: 105, automatic: true, zoom: 1.3, price: 2200, rarity: "RARE", description: "Russian 9x19mm helical-mag SMG. Biggest SMG mag (64) — slowest reload is the trade." },

  // ── PISTOL ──
  glock18: { id: "glock18", name: "Glock 18C", category: "PISTOL", damage: 22, fireRate: 90, magSize: 17, reloadTime: 1600, spread: 0.014, recoil: 0.022, range: 95, automatic: true, zoom: 1.3, price: 1500, rarity: "RARE", description: "Full-auto 9mm machine pistol. Only full-auto pistol + biggest pistol mag (17) — spray niche." },
  m1911: { id: "m1911", name: "M1911A1", category: "PISTOL", damage: 36, fireRate: 250, magSize: 7, reloadTime: 1700, spread: 0.010, recoil: 0.030, range: 110, automatic: false, zoom: 1.35, price: 1000, rarity: "COMMON", description: ".45 ACP classic. Best damage-per-shot of the non-cannon pistols — 7 rounds, sharp kick." },
  revolver: { id: "revolver", name: "RSh-12 Revolver", category: "PISTOL", damage: 55, fireRate: 350, magSize: 5, reloadTime: 2200, spread: 0.012, recoil: 0.048, range: 130, automatic: false, zoom: 1.45, price: 2000, rarity: "EPIC", description: ".50 cal revolver. Highest pistol damage + longest pistol range — 5 rounds, brutal kick." },

  // ── SNIPER ──
  kar98k: { id: "kar98k", name: "Kar98k", category: "SNIPER", damage: 85, fireRate: 700, magSize: 5, reloadTime: 2700, spread: 0.002, recoil: 0.045, range: 330, automatic: false, zoom: 2.8, price: 2500, rarity: "RARE", description: "WWII 7.92mm bolt-action. Higher damage than the Scout + faster cycle than the AWP — mid-tier pick." },
  l115a3: { id: "l115a3", name: "L115A3", category: "SNIPER", damage: 125, fireRate: 950, magSize: 5, reloadTime: 3200, spread: 0.0008, recoil: 0.045, range: 500, automatic: false, zoom: 4.0, price: 5000, rarity: "LEGENDARY", description: "British .338 Lapua. Highest sniper damage + longest range (500) — heavy rifle absorbs recoil." },

  // ── SHOTGUN ──
  m1014: { id: "m1014", name: "M1014", category: "SHOTGUN", damage: 22, fireRate: 300, magSize: 7, reloadTime: 2800, spread: 0.055, recoil: 0.045, range: 65, automatic: true, zoom: 1.25, price: 2200, rarity: "RARE", description: "Semi-auto 12-ga. Fastest shotgun cyclic (300ms) — lowest per-shell damage is the trade." },
  spas12: { id: "spas12", name: "SPAS-12", category: "SHOTGUN", damage: 26, fireRate: 500, magSize: 8, reloadTime: 2900, spread: 0.048, recoil: 0.052, range: 75, automatic: false, zoom: 1.28, price: 2600, rarity: "EPIC", description: "Dual-mode 12-ga. Highest shotgun damage + longest range (75) — heaviest kick is the trade." },

  // ── LMG ──
  rpk: { id: "rpk", name: "RPK-74", category: "LMG", damage: 28, fireRate: 95, magSize: 75, reloadTime: 3800, spread: 0.014, recoil: 0.030, range: 230, automatic: true, zoom: 1.4, price: 3800, rarity: "EPIC", description: "Soviet 5.45mm squad auto. Tightest LMG spread + fastest LMG reload — precision LMG niche." },
  mk48: { id: "mk48", name: "Mk48 Mod 1", category: "LMG", damage: 36, fireRate: 85, magSize: 100, reloadTime: 4700, spread: 0.020, recoil: 0.045, range: 250, automatic: true, zoom: 1.45, price: 4500, rarity: "LEGENDARY", description: "7.62mm GPMG. Highest LMG damage + longest range — biggest kick is the trade." },
};

export const ATTACHMENTS: Record<AttachmentSlug, AttachmentConfig | null> = {
  none: null,
  suppressor: { slug: "suppressor", name: "Suppressor", type: "MUZZLE", price: 800, damageMod: 0.9, recoilMod: 0.8, spreadMod: 1.0, rangeMod: 0.85, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 1.0, rarity: "RARE" },
  compensator: { slug: "compensator", name: "Compensator", type: "MUZZLE", price: 600, damageMod: 1.0, recoilMod: 0.7, spreadMod: 1.0, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 1.0, rarity: "COMMON" },
  red_dot: { slug: "red_dot", name: "Red Dot Sight", type: "SIGHT", price: 500, damageMod: 1.0, recoilMod: 1.0, spreadMod: 0.9, rangeMod: 1.0, zoomMod: 1.2, magSizeMod: 1.0, reloadMod: 1.0, rarity: "COMMON" },
  holo: { slug: "holo", name: "Holographic Sight", type: "SIGHT", price: 700, damageMod: 1.0, recoilMod: 1.0, spreadMod: 0.85, rangeMod: 1.0, zoomMod: 1.15, magSizeMod: 1.0, reloadMod: 1.0, rarity: "COMMON" },
  acog: { slug: "acog", name: "ACOG 4x", type: "SIGHT", price: 1200, damageMod: 1.0, recoilMod: 0.95, spreadMod: 0.8, rangeMod: 1.1, zoomMod: 1.8, magSizeMod: 1.0, reloadMod: 1.0, rarity: "RARE" },
  scope8x: { slug: "scope8x", name: "8x Sniper Scope", type: "SIGHT", price: 2000, damageMod: 1.0, recoilMod: 0.9, spreadMod: 0.5, rangeMod: 1.2, zoomMod: 3.0, magSizeMod: 1.0, reloadMod: 1.0, rarity: "LEGENDARY" },
  foregrip: { slug: "foregrip", name: "Vertical Foregrip", type: "GRIP", price: 500, damageMod: 1.0, recoilMod: 0.75, spreadMod: 0.9, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 1.0, rarity: "COMMON" },
  angled_grip: { slug: "angled_grip", name: "Angled Grip", type: "GRIP", price: 500, damageMod: 1.0, recoilMod: 0.85, spreadMod: 0.95, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 0.9, rarity: "COMMON" },
  ext_mag: { slug: "ext_mag", name: "Extended Magazine", type: "MAGAZINE", price: 900, damageMod: 1.0, recoilMod: 1.0, spreadMod: 1.0, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.5, reloadMod: 1.1, rarity: "RARE" },
  quick_mag: { slug: "quick_mag", name: "Quickdraw Magazine", type: "MAGAZINE", price: 700, damageMod: 1.0, recoilMod: 1.0, spreadMod: 1.0, rangeMod: 1.0, zoomMod: 1.0, magSizeMod: 1.0, reloadMod: 0.6, rarity: "COMMON" },
};

export const SKINS: Record<SkinSlug, SkinConfig> = {
  default: { slug: "default", name: "Standard Stock", rarity: "COMMON", price: 0, colorHex: "#3a3a3e" },
  gold: { slug: "gold", name: "Gold Plated", rarity: "LEGENDARY", price: 3000, colorHex: "#d4af37" },
  carbon: { slug: "carbon", name: "Carbon Fiber", rarity: "RARE", price: 1200, colorHex: "#1a1a1e" },
  tiger: { slug: "tiger", name: "Tiger Stripe", rarity: "EPIC", price: 1800, colorHex: "#c87f2a" },
  neon: { slug: "neon", name: "Neon Pulse", rarity: "EPIC", price: 2000, colorHex: "#2af0c8" },
  arctic: { slug: "arctic", name: "Arctic Camo", rarity: "RARE", price: 1000, colorHex: "#e8eef2" },
};

export const RARITY_COLORS: Record<Rarity, string> = {
  COMMON: "#9ca3af",
  RARE: "#3b82f6",
  EPIC: "#a855f7",
  LEGENDARY: "#f59e0b",
};

// ============================================================================
// Task-5/7 — Melee + Utility catalogs.
//
// These power the LoadoutPicker melee/utility slot and the buy-station shop.
// Slugs `knife`, `axe`, `bandage`, `frag`, `smoke` are kept backward-compatible
// with DEFAULT_LOADOUT + the existing LoadoutPicker options.
// ============================================================================

/** Melee weapon stats — swing behaviour + takedown damage. */
export interface MeleeStats {
  /** Damage per swing (HP). */
  damage: number;
  /** Effective reach / throw distance in meters. */
  range: number;
  /** Swing duration in ms (lower = faster). */
  swingTime: number;
  /** Bonus backstab multiplier (1.0 = no bonus, 2.0 = 2x from behind). */
  backstabMult: number;
}

export interface MeleeWeaponConfig {
  slug: string;
  name: string;
  price: number;
  rarity: Rarity;
  description: string;
  stats: MeleeStats;
}

/** Utility item stats — area effect, duration, carried quantity. */
export interface UtilityStats {
  /** Effect radius in meters (grenades), or 0 for self-only items (medkit). */
  radius: number;
  /** Effect duration in seconds (smoke cloud, flashbang blind). 0 = instant. */
  duration: number;
  /** Quantity carried per loadout slot. */
  quantity: number;
  /** Cooldown between uses in ms. */
  cooldown: number;
}

export interface UtilityItemConfig {
  slug: string;
  name: string;
  price: number;
  rarity: Rarity;
  description: string;
  stats: UtilityStats;
}

/** Melee catalog — 6 weapons. Slugs `knife` + `axe` match the existing
 *  LoadoutPicker options + DEFAULT_LOADOUT.melee = "knife". */
export const MELEE_WEAPONS: MeleeWeaponConfig[] = [
  { slug: "knife", name: "Combat Knife", price: 0, rarity: "COMMON", description: "Standard-issue 7\" bayonet. Fast slash, silent takedown from behind.", stats: { damage: 50, range: 1.6, swingTime: 380, backstabMult: 2.5 } },
  { slug: "axe", name: "Tactical Axe", price: 600, rarity: "RARE", description: "Folding tomahawk. Slower swing, throw further, hits harder.", stats: { damage: 70, range: 2.4, swingTime: 520, backstabMult: 2.0 } },
  { slug: "katana", name: "Carbon Katana", price: 2400, rarity: "LEGENDARY", description: "Folded-steel blade. Long reach, devastating slash — a statement piece.", stats: { damage: 95, range: 2.8, swingTime: 580, backstabMult: 3.0 } },
  { slug: "machete", name: "Machete", price: 350, rarity: "COMMON", description: "Latin-style brush blade. Wide arc slashes through foliage and foes alike.", stats: { damage: 60, range: 2.2, swingTime: 460, backstabMult: 2.0 } },
  { slug: "crowbar", name: "Crowbar", price: 250, rarity: "COMMON", description: "Headcrab-approved pry bar. Heavy hook, satisfying thwack — silent killer.", stats: { damage: 55, range: 1.9, swingTime: 500, backstabMult: 2.2 } },
  { slug: "sledgehammer", name: "Sledgehammer", price: 900, rarity: "EPIC", description: "8lb engineering hammer. Devastating overhead, kicks like a horse on hit.", stats: { damage: 120, range: 2.0, swingTime: 760, backstabMult: 1.8 } },
];

/** Utility catalog — 6 items. Slugs `bandage`, `frag`, `smoke` match the
 *  existing LoadoutPicker options + DEFAULT_LOADOUT.utility = "bandage". */
export const UTILITY_ITEMS: UtilityItemConfig[] = [
  { slug: "bandage", name: "Bandage x3", price: 50, rarity: "COMMON", description: "Field dressing. Stops bleeding + restores 25 HP per charge. 4s channel.", stats: { radius: 0, duration: 4, quantity: 3, cooldown: 6000 } },
  { slug: "frag", name: "Frag Grenade x2", price: 150, rarity: "COMMON", description: "M67 fragmentation grenade. 5m lethal radius, 12m shrapnel.", stats: { radius: 5, duration: 0, quantity: 2, cooldown: 1500 } },
  { slug: "smoke", name: "Smoke Grenade x1", price: 100, rarity: "COMMON", description: "M18 smoke screen. 20s concealment, 6m cloud — break sightlines instantly.", stats: { radius: 6, duration: 20, quantity: 1, cooldown: 1500 } },
  { slug: "flashbang", name: "Flashbang x2", price: 200, rarity: "RARE", description: "M84 stun grenade. Blinds + deafens targets in 8m for 5s. Pre-entry essential.", stats: { radius: 8, duration: 5, quantity: 2, cooldown: 1500 } },
  { slug: "medkit", name: "Field Medkit", price: 350, rarity: "RARE", description: "Trauma kit. Full HP restore + clears fractures. 8s channel, 1 use.", stats: { radius: 0, duration: 8, quantity: 1, cooldown: 25000 } },
  { slug: "adrenaline", name: "Adrenaline Shot", price: 400, rarity: "EPIC", description: "Auto-injector. Instant 30s stamina-free sprint, no flinch, +20% move speed.", stats: { radius: 0, duration: 30, quantity: 1, cooldown: 45000 } },
];

/** Convenience lookups. */
export const MELEE_WEAPON_MAP: Record<string, MeleeWeaponConfig> = Object.fromEntries(
  MELEE_WEAPONS.map((m) => [m.slug, m]),
);
export const UTILITY_ITEM_MAP: Record<string, UtilityItemConfig> = Object.fromEntries(
  UTILITY_ITEMS.map((u) => [u.slug, u]),
);

// ============================================================================
// Task-13 — Buy Station catalog (between-wave shop).
// ============================================================================

/** A single buy station item. The engine's applyBuyStationPurchase(slug)
 *  switches on `slug` to apply the effect (armor refill, ammo refill, etc.). */
export interface BuyStationItem {
  slug: string;
  name: string;
  price: number;
  /** Emoji or short text shown as the item icon in the overlay. */
  icon: string;
  /** One-line description shown under the name in the overlay. */
  desc: string;
  /** Category grouping for the overlay (Consumables / Grenades / Deployables). */
  category: "Consumable" | "Grenade" | "Deployable";
}

/** The full buy station catalog. Sorted by category then price ascending. */
export const BUY_STATION_CATALOG: BuyStationItem[] = [
  { slug: "armor_plate",  name: "Armor Plate",   price: 50,  icon: "🛡", desc: "Restores armor to 100",          category: "Consumable" },
  { slug: "ammo_box",     name: "Ammo Box",      price: 75,  icon: "📦", desc: "Refills reserve ammo (all weapons)", category: "Consumable" },
  { slug: "medkit",       name: "Medkit",        price: 120, icon: "✚",  desc: "Restores health to 100",         category: "Consumable" },
  { slug: "frag_grenade", name: "Frag Grenade",  price: 100, icon: "💣", desc: "+2 frag grenades (max 4)",       category: "Grenade" },
  { slug: "flashbang",    name: "Flashbang",     price: 80,  icon: "⚡", desc: "+2 flashbangs (max 4)",          category: "Grenade" },
  { slug: "smoke_grenade",name: "Smoke Grenade", price: 80,  icon: "💨", desc: "+2 smoke grenades (max 4)",      category: "Grenade" },
  { slug: "auto_turret",  name: "Auto-Turret",   price: 500, icon: "🔫", desc: "Deploys a turret at your position (30s)", category: "Deployable" },
  { slug: "claymore",     name: "Claymore",      price: 150, icon: "🧨", desc: "Proximity mine (3m blast)",      category: "Deployable" },
  { slug: "c4",           name: "C4 Charge",     price: 200, icon: "🚧", desc: "Proximity charge (5m blast, larger dmg)", category: "Deployable" },
];

export const BODY_TYPES: { slug: "lean" | "athletic" | "stocky"; name: string; scale: number }[] = [
  { slug: "lean", name: "Lean", scale: 0.92 },
  { slug: "athletic", name: "Athletic", scale: 1.0 },
  { slug: "stocky", name: "Stocky", scale: 1.12 },
];

export const DEFAULT_LOADOUT: LoadoutConfig = {
  weapon: "ak74",
  secondary: "usp",
  melee: "knife",
  utility: "bandage",
  muzzle: "none",
  sight: "none",
  grip: "none",
  magazine: "none",
  skin: "default",
};

export function computeWeaponStats(loadout: LoadoutConfig): EffectiveWeaponStats {
  const base = WEAPONS[loadout.weapon];
  const muzzle = ATTACHMENTS[loadout.muzzle];
  const sight = ATTACHMENTS[loadout.sight];
  const grip = ATTACHMENTS[loadout.grip];
  const mag = ATTACHMENTS[loadout.magazine];

  const damageMod = (muzzle?.damageMod ?? 1);
  const recoilMod = (muzzle?.recoilMod ?? 1) * (grip?.recoilMod ?? 1) * (sight?.recoilMod ?? 1);
  const spreadMod = (sight?.spreadMod ?? 1) * (grip?.spreadMod ?? 1);
  const rangeMod = (muzzle?.rangeMod ?? 1) * (sight?.rangeMod ?? 1);
  const zoomMod = (sight?.zoomMod ?? 1);
  const magSizeMod = (mag?.magSizeMod ?? 1);
  const reloadMod = (mag?.reloadMod ?? 1) * (grip?.reloadMod ?? 1);

  const scoped = loadout.sight === "scope8x" || base.category === "SNIPER";

  return {
    ...base,
    effectiveDamage: base.damage * damageMod,
    effectiveFireRate: base.fireRate,
    effectiveMagSize: Math.round(base.magSize * magSizeMod),
    effectiveReloadTime: Math.round(base.reloadTime * reloadMod),
    effectiveSpread: base.spread * spreadMod,
    effectiveRecoil: base.recoil * recoilMod,
    effectiveRange: Math.round(base.range * rangeMod),
    effectiveZoom: base.zoom * zoomMod,
    scoped,
  };
}

const defaultHud: HudState = {
  health: 100,
  maxHealth: 100,
  armor: 100,
  ammo: 30,
  magSize: 30,
  reserveAmmo: 90,
  weaponName: "AK-74",
  score: 0,
  kills: 0,
  deaths: 0,
  enemiesRemaining: 0,
  totalEnemies: 0,
  reloading: false,
  reloadProgress: 0,
  hitMarker: 0,
  killMarker: 0,
  headshotMarker: 0,
  multiKill: null,
  damageFlash: 0,
  killFeed: [],
  wave: 1,
  objective: "Eliminate all hostiles",
  fps: 0,
  aiming: false,
  scoped: false,
  viewMode: "first",
  credits: 500,
  xpGained: 0,
  suppression: 0,
  casualtyState: "ACTIVE",
  bleedRate: 0,
  medicalInventory: { bandage: 3, splint: 1, epi: 1, medkit: 1 },
  medicalChannel: null,
  timeOfDay: 9,
  weather: "CLEAR",
  windSpeed: 3,
  radioMessage: null,
};

interface PlayerProfile {
  credits: number;
  level: number;
  xp: number;
  ownedWeapons: WeaponType[];
  ownedAttachments: AttachmentSlug[];
  ownedSkins: SkinSlug[];
  /** Task-2d — owned wraps (camo patterns). Always includes "default". */
  ownedWraps: WrapSlug[];
  /** Task-2d — owned charms. Empty array means none owned. */
  ownedCharms: CharmSlug[];
  loadout: LoadoutConfig;
  battlePassTier: number;
  battlePassXp: number;
  battlePassPremium: boolean;
}

interface GameStore {
  phase: GamePhase;
  locked: boolean;
  settings: Settings;
  /** Full HUD state — kept for backward compat. Components should prefer
   *  the sliced selectors (hudCombat/hudMeta/hudRealism/hudTransient) below. */
  hud: HudState;
  // P2.3: sliced HUD state — independent reactivity.
  hudCombat: HudCombatSlice;
  hudMeta: HudMetaSlice;
  hudRealism: HudRealismSlice;
  hudTransient: HudTransientSlice;
  selectedWeapon: WeaponType;
  loadout: LoadoutConfig;
  /** Phase 10: selected map slug. */
  selectedMap: string;
  /** Phase 10: selected game mode. */
  selectedMode: string;
  profile: PlayerProfile;
  profileLoading: boolean;
  /** Operator (character) appearance settings. */
  operator: OperatorSettings;
  /** V3 — equipped operator slug (discrete skin). Drives the avatar + preview. */
  equippedOperatorSlug: string;
  /** V3 — operator slugs owned by the player. */
  ownedOperators: string[];
  /** V3 — set the equipped operator slug. */
  setEquippedOperator: (slug: string) => void;
  /** V3 — set the owned operator slugs. */
  setOwnedOperators: (slugs: string[]) => void;
  /**
   * V3.1 — Task 29: equipped granular operator customization. Drives the
   * 3D preview + in-game avatar (suit/vest/helmet/visor/skin/helmet style
   * overrides are consumed by getOperatorVisual/buildHumanoid). Extended
   * fields (eye/lip/hair/pants/jacket/glove/boot/bag/pouch/pad colors +
   * accessory toggles) persist + drive the customization UI; future rig
   * builder pass will consume them.
   */
  equippedCustomization: OperatorCustomization;
  /** V3.1 — set the equipped customization (also pushes to operators.ts module slot). */
  setEquippedCustomization: (c: OperatorCustomization) => void;
  /** V3.1 — patch a single override field (imperative helper for the UI). */
  patchCustomizationOverride: (key: keyof OperatorCustomizationOverrides, value: unknown) => void;
  /** V3.1 — reset overrides to the given preset's defaults (keeps baseSlug). */
  resetCustomizationToPreset: (slug: string) => void;
  startMatch: () => void;
  setPhase: (p: GamePhase) => void;
  setLocked: (b: boolean) => void;
  setSettings: (s: Partial<Settings>) => void;
  /** Update crosshair sub-settings. */
  setCrosshair: (c: Partial<CrosshairSettings>) => void;
  /** Update extended sub-settings (audio buses, a11y, ADS). */
  setExtended: (e: Partial<ExtendedSettings>) => void;
  /** Update operator appearance. */
  setOperator: (o: Partial<OperatorSettings>) => void;
  setSelectedWeapon: (w: WeaponType) => void;
  setLoadout: (l: Partial<LoadoutConfig>) => void;
  /** Phase 10: set selected map. */
  setSelectedMap: (slug: string) => void;
  /** Phase 10: set selected game mode. */
  setSelectedMode: (mode: string) => void;
  setHud: (partial: Partial<HudState>) => void;
  /** P2.3: Batch + throttle HUD updates. Combat slice updates immediately
   *  (every frame); meta and realism slices flush at most 5 Hz; transient
   *  is event-driven. The engine calls flushHud() at the end of each tick. */
  batchHud: (partial: Partial<HudState>) => void;
  flushHud: (now: number) => void;
  addKillFeed: (entry: Omit<KillFeedEntry, "id" | "time">) => void;
  resetHud: () => void;
  setProfile: (p: Partial<PlayerProfile>) => void;
  setProfileLoading: (b: boolean) => void;
  /** Task-13 — true while the buy station overlay is open between waves. */
  buyStationOpen: boolean;
  /** Task-13 — the buy station item catalog (constant). */
  buyStationItems: BuyStationItem[];
  /** Task-13 — running total of credits spent at the buy station this match.
   *  Reset to 0 on startMatch; read by the engine at match end to subtract
   *  from the earn call (server-side credits stay in sync with local). */
  buyStationCreditsSpent: number;
  /** Task-13 — engine-side effect applicator. Registered by the engine in
   *  its constructor; called by buyStationPurchase after credits are
   *  validated + deducted locally. Returns true if the effect was applied
   *  (the purchase is then committed). */
  buyStationApplyEffect?: (slug: string) => boolean;
  /** Task-13 — engine-side "READY" handler. Registered by the engine; called
   *  by the BuyStationOverlay's READY button to close the overlay and
   *  immediately start the next wave (cancelling the 15s timer). */
  buyStationReadyHandler?: () => void;
  /** Task-13 — set the engine-side effect applicator. */
  setBuyStationApplyEffect: (fn: ((slug: string) => boolean) | undefined) => void;
  /** Task-13 — set the engine-side READY handler. */
  setBuyStationReadyHandler: (fn: (() => void) | undefined) => void;
  /** Task-13 — open/close the buy station overlay. */
  setBuyStationOpen: (v: boolean) => void;
  /** Task-13 — purchase an item from the buy station. Validates credits,
   *  calls the engine-side effect applicator, then deducts credits locally
   *  and tracks the spend for the match-end earn call. Returns { ok, error }.
   *  Note: server-side persistence happens at match end via /api/player/earn
   *  (the spend is subtracted from the earn credits). */
  buyStationPurchase: (slug: string) => { ok: boolean; error?: string };
  /** Task-13 — READY button handler. Closes the overlay and calls the
   *  engine-side ready handler (which cancels the 15s timer + starts the
   *  next wave). */
  buyStationReady: () => void;
}

/** P2.3: keys that belong to each slice. Used to route batched updates. */
const COMBAT_KEYS = new Set<keyof HudCombatSlice>([
  "health", "maxHealth", "armor", "ammo", "magSize", "reserveAmmo",
  "weaponName", "reloading", "reloadProgress", "aiming", "scoped", "viewMode",
]);
const META_KEYS = new Set<keyof HudMetaSlice>([
  "score", "kills", "deaths", "enemiesRemaining", "totalEnemies",
  "wave", "objective", "fps", "credits", "xpGained",
]);
const REALISM_KEYS = new Set<keyof HudRealismSlice>([
  "suppression", "casualtyState", "bleedRate", "medicalInventory",
  "medicalChannel", "timeOfDay", "weather", "windSpeed",
]);
const TRANSIENT_KEYS = new Set<keyof HudTransientSlice>([
  "hitMarker", "killMarker", "headshotMarker", "multiKill",
  "damageFlash", "killFeed", "radioMessage",
]);

/** P2.3: 5 Hz throttle window in ms. */
const HUD_THROTTLE_MS = 200;

function splitPartial(partial: Partial<HudState>) {
  const combat: Partial<HudCombatSlice> = {};
  const meta: Partial<HudMetaSlice> = {};
  const realism: Partial<HudRealismSlice> = {};
  const transient: Partial<HudTransientSlice> = {};
  for (const k of Object.keys(partial) as (keyof HudState)[]) {
    if (COMBAT_KEYS.has(k as keyof HudCombatSlice)) (combat as any)[k] = partial[k];
    else if (META_KEYS.has(k as keyof HudMetaSlice)) (meta as any)[k] = partial[k];
    else if (REALISM_KEYS.has(k as keyof HudRealismSlice)) (realism as any)[k] = partial[k];
    else if (TRANSIENT_KEYS.has(k as keyof HudTransientSlice)) (transient as any)[k] = partial[k];
  }
  return { combat, meta, realism, transient };
}

export const useGameStore = create<GameStore>((set, get) => {
  // P2.3: pending batched updates + last-flush timestamps.
  let pendingCombat: Partial<HudCombatSlice> = {};
  let pendingMeta: Partial<HudMetaSlice> = {};
  let pendingRealism: Partial<HudRealismSlice> = {};
  let pendingTransient: Partial<HudTransientSlice> = {};
  let lastMetaFlush = 0;
  let lastRealismFlush = 0;

  return {
    phase: "menu",
    locked: false,
    settings: {
      sensitivity: 1,
      fov: 80,
      volume: 0.6,
      shadows: true,
      quality: "medium",
      showFps: true,
      difficulty: "normal",
      crosshair: {
        style: "cross+dot",
        color: "#00ff88",
        showDot: true,
        length: 8,
        thickness: 2,
        gap: 4,
        outline: true,
        dynamicSpread: true,
      },
      extended: {
        aimSensitivity: 0.5,
        adsMode: "hold",
        adsSpeed: 14,
        motionSickness: false,
        colorblind: "none",
        masterVolume: 0.8,
        sfxVolume: 0.9,
        musicVolume: 0.5,
        voiceVolume: 0.7,
        // Task 3 / item 65 — default OFF. Hardware benchmark auto-enables
        // this on integrated GPUs (see HardwareDetect.classifyGPU).
        reducedEffects: false,
        // ─── J-5000-retry — Section J defaults (mirror ExtendedSettings.ts). ───
        subtitlesEnabled: false,
        subtitleBackground: 0.7,
        subtitleColor: "#ffffff",
        audioDuckDb: 6,
        motorAssist: false,
        ambientCaptions: false,
        dyslexiaFont: false,
        rtlLayout: false,
        holdToggle: { sprint: "hold", ads: "hold", crouch: "toggle" },
        practiceGameSpeed: 1.0,
        autoSprint: false,
        inputBufferMs: 200,
        // J-4037 — default low-health vignette is red (matches the
        // genre-standard "blood on the screen" cue). Colorblind
        // players can swap to amber/yellow via the settings panel.
        lowHealthVignetteColor: "#dc2626",
      },
    },
    operator: {
      callsign: "OPERATOR",
      facePreset: 0,
      skinTone: 0.35,
      hairStyle: "fade",
      hairColor: "#2a1a10",
      facialHair: "stubble",
      eyeColor: "#4a6a8a",
      bodyType: "athletic",
      heightCm: 180,
      suitColor: "#2f4a6a",
      voicePack: "us_male_01",
    },
    hud: { ...defaultHud },
    hudCombat: { ...defaultHud },
    hudMeta: { ...defaultHud },
    hudRealism: { ...defaultHud },
    hudTransient: { ...defaultHud },
    selectedWeapon: "ak74",
    loadout: { ...DEFAULT_LOADOUT },
    selectedMap: "compound",
    selectedMode: "SURVIVAL",
    profile: {
      credits: 500,
      level: 1,
      xp: 0,
      ownedWeapons: ["ak74", "mp7", "usp"],
      ownedAttachments: [],
      ownedSkins: ["default"],
      ownedWraps: ["default"],
      ownedCharms: [],
      loadout: { ...DEFAULT_LOADOUT },
      battlePassTier: 0,
      battlePassXp: 0,
      battlePassPremium: false,
    },
    profileLoading: false,
    equippedOperatorSlug: "warden",
    ownedOperators: ["warden"],
    // V3.1 — Task 29: granular operator customization (base preset + overrides).
    equippedCustomization: DEFAULT_CUSTOMIZATION,
    // Task-13 — buy station overlay state (closed by default).
    buyStationOpen: false,
    buyStationItems: BUY_STATION_CATALOG,
    buyStationCreditsSpent: 0,
    buyStationApplyEffect: undefined,
    buyStationReadyHandler: undefined,
    setEquippedOperator: (slug) => set({ equippedOperatorSlug: slug }),
    setOwnedOperators: (slugs) => set({ ownedOperators: slugs }),
    // V3.1 — Task 29: customization state setters.
    setEquippedCustomization: (c) => {
      // Push the visual-override subset to operators.ts so getOperatorVisual
      // (and thus buildHumanoid) sees the merged visual on the next call.
      setActiveCustomization({ baseSlug: c.baseSlug, overrides: c.overrides });
      set({ equippedCustomization: c });
    },
    patchCustomizationOverride: (key, value) => {
      set((st) => {
        const next: OperatorCustomization = {
          baseSlug: st.equippedCustomization.baseSlug,
          overrides: { ...st.equippedCustomization.overrides, [key]: value },
        };
        setActiveCustomization({ baseSlug: next.baseSlug, overrides: next.overrides });
        return { equippedCustomization: next };
      });
    },
    resetCustomizationToPreset: (slug) => {
      const next: OperatorCustomization = { baseSlug: slug, overrides: {} };
      setActiveCustomization({ baseSlug: slug, overrides: {} });
      set({ equippedCustomization: next });
    },
    startMatch: () => set({
      phase: "playing",
      hud: { ...defaultHud },
      hudCombat: { ...defaultHud },
      hudMeta: { ...defaultHud },
      hudRealism: { ...defaultHud },
      hudTransient: { ...defaultHud },
      // Task-13 — reset buy station state on match start.
      buyStationOpen: false,
      buyStationCreditsSpent: 0,
    }),
    setPhase: (p) => set({ phase: p }),
    setLocked: (b) => set({ locked: b }),
    setSettings: (s) => set((st) => ({ settings: { ...st.settings, ...s } })),
    setCrosshair: (c) => set((st) => ({ settings: { ...st.settings, crosshair: { ...st.settings.crosshair, ...c } } })),
    setExtended: (e) => set((st) => ({ settings: { ...st.settings, extended: { ...st.settings.extended, ...e } } })),
    setOperator: (o) => set((st) => ({ operator: { ...st.operator, ...o } })),
    setSelectedWeapon: (w) => set({ selectedWeapon: w }),
    setLoadout: (l) => set((st) => ({ loadout: { ...st.loadout, ...l }, profile: { ...st.profile, loadout: { ...st.profile.loadout, ...l } } })),
    setSelectedMap: (slug) => set({ selectedMap: slug }),
    setSelectedMode: (mode) => set({ selectedMode: mode }),
    setHud: (partial) => {
      // Backward-compat: write through to all slices immediately.
      const { combat, meta, realism, transient } = splitPartial(partial);
      set((st) => ({
        hud: { ...st.hud, ...partial },
        hudCombat: { ...st.hudCombat, ...combat },
        hudMeta: { ...st.hudMeta, ...meta },
        hudRealism: { ...st.hudRealism, ...realism },
        hudTransient: { ...st.hudTransient, ...transient },
      }));
    },
    batchHud: (partial) => {
      // P2.3: accumulate into pending buckets; combat always flushes next tick.
      const { combat, meta, realism, transient } = splitPartial(partial);
      Object.assign(pendingCombat, combat);
      Object.assign(pendingMeta, meta);
      Object.assign(pendingRealism, realism);
      Object.assign(pendingTransient, transient);
    },
    flushHud: (now) => {
      // Combat + transient flush immediately (motion-critical / event-driven).
      // Meta + realism throttle to 5 Hz.
      const combatReady = Object.keys(pendingCombat).length > 0;
      const transientReady = Object.keys(pendingTransient).length > 0;
      const metaReady = Object.keys(pendingMeta).length > 0 && (now - lastMetaFlush) >= HUD_THROTTLE_MS;
      const realismReady = Object.keys(pendingRealism).length > 0 && (now - lastRealismFlush) >= HUD_THROTTLE_MS;
      if (!combatReady && !transientReady && !metaReady && !realismReady) return;
      const combatSnap = combatReady ? pendingCombat : {};
      const transientSnap = transientReady ? pendingTransient : {};
      const metaSnap = metaReady ? pendingMeta : {};
      const realismSnap = realismReady ? pendingRealism : {};
      // Clear flushed buckets (keep throttled ones until they flush).
      if (combatReady) pendingCombat = {};
      if (transientReady) pendingTransient = {};
      if (metaReady) { pendingMeta = {}; lastMetaFlush = now; }
      if (realismReady) { pendingRealism = {}; lastRealismFlush = now; }
      set((st) => {
        const hud = { ...st.hud, ...combatSnap, ...transientSnap, ...metaSnap, ...realismSnap };
        return {
          hud,
          hudCombat: combatReady ? { ...st.hudCombat, ...combatSnap } : st.hudCombat,
          hudTransient: transientReady ? { ...st.hudTransient, ...transientSnap } : st.hudTransient,
          hudMeta: metaReady ? { ...st.hudMeta, ...metaSnap } : st.hudMeta,
          hudRealism: realismReady ? { ...st.hudRealism, ...realismSnap } : st.hudRealism,
        };
      });
    },
    addKillFeed: (entry) => {
      const id = Date.now() + Math.random();
      const full: KillFeedEntry = { ...entry, id, time: performance.now() };
      // P2.3: route killfeed through the transient slice.
      set((st) => {
        const killFeed = [full, ...st.hudTransient.killFeed].slice(0, 5);
        return {
          hud: { ...st.hud, killFeed },
          hudTransient: { ...st.hudTransient, killFeed },
        };
      });
    },
    resetHud: () => set({ hud: { ...defaultHud }, hudCombat: { ...defaultHud }, hudMeta: { ...defaultHud }, hudRealism: { ...defaultHud }, hudTransient: { ...defaultHud } }),
    setProfile: (p) => set((st) => ({ profile: { ...st.profile, ...p } })),
    setProfileLoading: (b) => set({ profileLoading: b }),
    // Task-13 — Buy station overlay actions.
    setBuyStationOpen: (v) => set({ buyStationOpen: v }),
    setBuyStationApplyEffect: (fn) => set({ buyStationApplyEffect: fn }),
    setBuyStationReadyHandler: (fn) => set({ buyStationReadyHandler: fn }),
    buyStationPurchase: (slug) => {
      const st = get();
      const item = st.buyStationItems.find((i) => i.slug === slug);
      if (!item) return { ok: false, error: "Unknown item" };
      if (st.profile.credits < item.price) return { ok: false, error: "Not enough credits" };
      // Apply the effect via the engine-side callback. If the engine isn't
      // registered yet (e.g. the buy station opened before the engine wired
      // its callback), abort — no deduction, no effect.
      const applied = st.buyStationApplyEffect?.(slug) ?? false;
      if (!applied) return { ok: false, error: "Effect not applied" };
      // Commit the purchase: deduct credits locally + track spend for the
      // match-end earn call (server-side credits stay in sync).
      set((s) => ({
        profile: { ...s.profile, credits: s.profile.credits - item.price },
        buyStationCreditsSpent: s.buyStationCreditsSpent + item.price,
      }));
      return { ok: true };
    },
    buyStationReady: () => {
      // Close the overlay first so the player sees the world again, then
      // fire the engine-side handler (cancels the 15s timer + starts the
      // next wave).
      set({ buyStationOpen: false });
      get().buyStationReadyHandler?.();
    },
  };
});
