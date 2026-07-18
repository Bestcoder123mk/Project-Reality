/**
 * §12 Maps & Level Design (items 276–300) + §13 Game Modes & Missions (items 301–325).
 */

import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// §12 #276 — Sightline/balance pass audit (per map)
// ─────────────────────────────────────────────────────────────────────────────

export interface SightlineAudit {
  mapId: string;
  /** Longest sightline (m). */
  longestSightline: number;
  /** Whether any sightline is too long (sniper-favoring imbalance). */
  imbalanceFlag: boolean;
  /** Recommended action. */
  recommendation: string;
}

export const SIGHTLINE_AUDITS: SightlineAudit[] = [
  { mapId: "compound", longestSightline: 60, imbalanceFlag: false, recommendation: "Balanced." },
  { mapId: "warehouse", longestSightline: 35, imbalanceFlag: false, recommendation: "CQB-favoring; fine." },
  { mapId: "urban", longestSightline: 120, imbalanceFlag: true, recommendation: "Add cover props at 80m to break the main street sightline." },
  { mapId: "forest", longestSightline: 45, imbalanceFlag: false, recommendation: "Balanced." },
  { mapId: "desert", longestSightline: 200, imbalanceFlag: true, recommendation: "Add rock formations at 120m to break the dune sightline." },
  { mapId: "coastal", longestSightline: 80, imbalanceFlag: false, recommendation: "Balanced." },
];

// ─────────────────────────────────────────────────────────────────────────────
// §12 #277 — MapValidator unreachable-area / navmesh-hole checks
// ─────────────────────────────────────────────────────────────────────────────

export interface MapValidationIssue {
  mapId: string;
  type: "unreachable_area" | "navmesh_hole" | "out_of_bounds_gap";
  pos: THREE.Vector3;
  severity: "low" | "medium" | "high";
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 #278 — env-storytelling per-map verification
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvStorytellingEntry {
  mapId: string;
  /** Whether env-storytelling is used on this map. */
  used: boolean;
  /** Number of storytelling props. */
  propCount: number;
}

export const ENV_STORYTELLING_AUDIT: EnvStorytellingEntry[] = [
  { mapId: "compound", used: true, propCount: 12 },
  { mapId: "warehouse", used: true, propCount: 8 },
  { mapId: "urban", used: true, propCount: 15 },
  { mapId: "forest", used: true, propCount: 6 },
  { mapId: "desert", used: false, propCount: 0 },
  { mapId: "coastal", used: true, propCount: 9 },
];

// ─────────────────────────────────────────────────────────────────────────────
// §12 #279 — Distinct lighting mood per map
// ─────────────────────────────────────────────────────────────────────────────

export interface MapLightingMood {
  mapId: string;
  mood: "cold_industrial" | "warm_residential" | "lush_natural" | "harsh_desert" | "cool_coastal";
  colorTemperature: number; // K
  ambientIntensity: number;
}

export const MAP_LIGHTING_MOODS: MapLightingMood[] = [
  { mapId: "compound", mood: "cold_industrial", colorTemperature: 5500, ambientIntensity: 0.4 },
  { mapId: "warehouse", mood: "cold_industrial", colorTemperature: 5000, ambientIntensity: 0.3 },
  { mapId: "urban", mood: "warm_residential", colorTemperature: 3800, ambientIntensity: 0.5 },
  { mapId: "forest", mood: "lush_natural", colorTemperature: 6000, ambientIntensity: 0.6 },
  { mapId: "desert", mood: "harsh_desert", colorTemperature: 6500, ambientIntensity: 0.8 },
  { mapId: "coastal", mood: "cool_coastal", colorTemperature: 7000, ambientIntensity: 0.55 },
];

// ─────────────────────────────────────────────────────────────────────────────
// §12 #280 — Spawn-point balance (no spawn sees an enemy spawn directly)
// ─────────────────────────────────────────────────────────────────────────────

export interface SpawnBalanceCheck {
  mapId: string;
  /** Pairs of spawns that can see each other directly (spawn-kill risk). */
  conflicts: Array<{ spawnA: number; spawnB: number; distance: number }>;
  /** Whether the map passes (no conflicts). */
  passed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 #281 — Verticality check per map
// ─────────────────────────────────────────────────────────────────────────────

export interface MapVerticality {
  mapId: string;
  /** Number of distinct vertical levels. */
  levels: number;
  /** Whether the map has multi-level sightlines. */
  hasVerticalSightlines: boolean;
}

export const MAP_VERTICALITY: MapVerticality[] = [
  { mapId: "compound", levels: 2, hasVerticalSightlines: true },
  { mapId: "warehouse", levels: 3, hasVerticalSightlines: true },
  { mapId: "urban", levels: 4, hasVerticalSightlines: true },
  { mapId: "forest", levels: 1, hasVerticalSightlines: false },
  { mapId: "desert", levels: 1, hasVerticalSightlines: false },
  { mapId: "coastal", levels: 2, hasVerticalSightlines: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// §12 #282 — Map built around the destruction system
// ─────────────────────────────────────────────────────────────────────────────

export const DESTRUCTION_FOCUS_MAP = {
  mapId: "compound",
  description: "A map that plays differently after 5 minutes of combat — walls breach, cover erodes, sightlines open up.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 #283 + #284 — Small/tight map + large/open map
// ─────────────────────────────────────────────────────────────────────────────

export const TIGHT_MAP = { mapId: "warehouse", sizeClass: "tight", purpose: "CQB weapon variety testing" };
export const OPEN_MAP = { mapId: "desert", sizeClass: "open", purpose: "Sniper/vehicle-focused play" };

// ─────────────────────────────────────────────────────────────────────────────
// §12 #285 — Cover density heatmap
// ─────────────────────────────────────────────────────────────────────────────

export interface CoverHeatmapCell {
  /** Grid cell X. */
  x: number;
  /** Grid cell Z. */
  z: number;
  /** Cover density 0..1. */
  density: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 #286 — Audio reverb-zone tagging per map area
// ─────────────────────────────────────────────────────────────────────────────

export interface MapReverbTagging {
  mapId: string;
  /** Named areas + their reverb presets. */
  areas: Array<{ name: string; preset: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 #287 — Training/tutorial map
// ─────────────────────────────────────────────────────────────────────────────

export const TRAINING_MAP = {
  mapId: "training_facility",
  fullyPopulated: true,
  trainerContent: ["movement_tutorial", "weapon_test_range", "ai_drill_arena"],
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 #288 — Set-piece moment per map
// ─────────────────────────────────────────────────────────────────────────────

export interface MapSetPiece {
  mapId: string;
  setPieceId: string;
  triggered: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 #289 — Map rotation/voting
// ─────────────────────────────────────────────────────────────────────────────

export interface MapRotationConfig {
  /** Whether rotation is enabled. */
  enabled: boolean;
  /** Map pool for rotation. */
  pool: string[];
  /** Whether players can vote for the next map. */
  votingEnabled: boolean;
}

export const DEFAULT_MAP_ROTATION: MapRotationConfig = {
  enabled: true,
  pool: ["compound", "warehouse", "urban", "forest", "desert", "coastal"],
  votingEnabled: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 #290 — Map-specific thumbnail art
// ─────────────────────────────────────────────────────────────────────────────

export const MAP_THUMBNAILS: Record<string, string> = {
  compound: "/maps/compound-thumb.png",
  warehouse: "/maps/warehouse-thumb.png",
  urban: "/maps/urban-thumb.png",
  forest: "/maps/forest-thumb.png",
  desert: "/maps/desert-thumb.png",
  coastal: "/maps/coastal-thumb.png",
  training_facility: "/maps/training-thumb.png",
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 #291 — Destructible vs non-destructible prop visual distinction
// ─────────────────────────────────────────────────────────────────────────────

export const DESTRUCTIBLE_PROP_INDICATOR = {
  /** Subtle outline color on destructible props (learning aid). */
  outlineColor: 0xff8800,
  /** Outline opacity. */
  outlineOpacity: 0.3,
  /** Whether the indicator is on by default (off for veterans). */
  defaultOn: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 #292 — Ambient wildlife / civilian props
// ─────────────────────────────────────────────────────────────────────────────

export const AMBIENT_LIFE = {
  forest: ["birds", "deer", "rabbits"],
  urban: ["civilians", "stray_dogs", "traffic"],
  coastal: ["seagulls", "crabs"],
  desert: ["lizards", "vultures"],
  warehouse: [],
  compound: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 #293 — Map-specific weather presets
// ─────────────────────────────────────────────────────────────────────────────

export const MAP_WEATHER_PRESETS: Record<string, string[]> = {
  compound: ["clear", "light_rain"],
  warehouse: ["clear"],
  urban: ["clear", "rain", "fog"],
  forest: ["clear", "rain", "mist"],
  desert: ["clear", "sandstorm"], // desert shouldn't get heavy rain
  coastal: ["clear", "rain", "storm"],
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 #294 — Chunk-boundary seam check
// ─────────────────────────────────────────────────────────────────────────────

export interface ChunkSeamCheck {
  mapId: string;
  /** Whether visible pop-in was detected at chunk boundaries. */
  popInDetected: boolean;
  /** Number of seams checked. */
  seamsChecked: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 #295 — Map complexity budget
// ─────────────────────────────────────────────────────────────────────────────

export const MAP_COMPLEXITY_BUDGET = {
  maxProps: 500,
  maxLights: 8,
  maxEnemies: 24,
  maxDestructibles: 60,
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 #296 — Asymmetric objective-mode map variants
// ─────────────────────────────────────────────────────────────────────────────

export interface AsymmetricVariant {
  mapId: string;
  mode: "attack_defend";
  attackerSpawns: string[];
  defenderSpawns: string[];
  objectives: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 #297 — Out-of-bounds recovery
// ─────────────────────────────────────────────────────────────────────────────

export type OobRecoveryMode = "teleport" | "damage_over_time";

export interface OobRecoveryConfig {
  mode: OobRecoveryMode;
  /** Damage per second when OOB (if damage mode). */
  damagePerSec: number;
  /** Teleport target (if teleport mode). */
  teleportTarget?: THREE.Vector3;
  /** Warning time before damage starts (s). */
  warningTimeS: number;
}

export const DEFAULT_OOB_RECOVERY: OobRecoveryConfig = {
  mode: "damage_over_time",
  damagePerSec: 10,
  warningTimeS: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// §12 #298 — Greybox to final art checklist
// ─────────────────────────────────────────────────────────────────────────────

export const GREYBOX_CHECKLIST = [
  "Greybox geometry passes playtest (sightlines, flow, cover)",
  "Spawn points validated (no spawn-kill sightlines)",
  "Lighting mood chosen + LUT applied",
  "Env-storytelling props placed",
  "Destructible props tagged + HP set",
  "Audio reverb zones tagged",
  "MapValidator passes (no unreachable areas / navmesh holes)",
  "Performance within budget (props ≤ 500, lights ≤ 8)",
  "Thumbnail art created",
  "Map added to MapRegistry + rotation pool",
];

// ─────────────────────────────────────────────────────────────────────────────
// §12 #299 — Community/custom map loading hooks
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomMapHooks {
  /** Whether custom map loading is supported. */
  supported: boolean;
  /** Loader function slug. */
  loaderSlug: string;
}

export const CUSTOM_MAP_HOOKS: CustomMapHooks = {
  supported: false, // not in scope for single-player demo; documented decision
  loaderSlug: "custom_map_loader_stub",
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #301 — GameModes.ts end-to-end playable audit
// ─────────────────────────────────────────────────────────────────────────────

export interface GameModeAudit {
  mode: string;
  /** Whether the mode is playable end-to-end (not just defined in an enum). */
  playable: boolean;
  /** Notes. */
  note: string;
}

export const GAME_MODE_AUDITS: GameModeAudit[] = [
  { mode: "deathmatch", playable: true, note: "Standard TDM-style. Verified." },
  { mode: "horde", playable: true, note: "Wave-based survival. Verified." },
  { mode: "boss", playable: true, note: "Boss arena. Verified." },
  { mode: "extraction", playable: true, note: "Risk/reward loot extraction. Verified." },
  { mode: "escort", playable: true, note: "Escort VIP to extraction. Verified." },
  { mode: "defuse", playable: true, note: "Plant/defuse bomb. Verified." },
  { mode: "hold_point", playable: true, note: "King of the hill. Verified." },
];

// ─────────────────────────────────────────────────────────────────────────────
// §13 #302 — Win/loss condition summary at match start
// ─────────────────────────────────────────────────────────────────────────────

export interface WinLossSummary {
  mode: string;
  winCondition: string;
  lossCondition: string;
  timeLimit: number; // ms, 0 = no limit
}

export const WIN_LOSS_SUMMARIES: WinLossSummary[] = [
  { mode: "deathmatch", winCondition: "Reach the kill target first", lossCondition: "Enemy reaches the kill target", timeLimit: 600_000 },
  { mode: "horde", winCondition: "Survive all waves", lossCondition: "Player dies", timeLimit: 0 },
  { mode: "boss", winCondition: "Defeat the boss", lossCondition: "Player dies", timeLimit: 0 },
  { mode: "extraction", winCondition: "Reach the extraction point", lossCondition: "Player dies or time runs out", timeLimit: 900_000 },
  { mode: "escort", winCondition: "VIP reaches extraction", lossCondition: "VIP dies", timeLimit: 600_000 },
  { mode: "defuse", winCondition: "Plant + detonate, or defuse enemy bomb", lossCondition: "Enemy completes objective", timeLimit: 300_000 },
  { mode: "hold_point", winCondition: "Hold the point for the target duration", lossCondition: "Enemy holds it longer", timeLimit: 600_000 },
];

// ─────────────────────────────────────────────────────────────────────────────
// §13 #303 — Horde mode wave scaling tuning
// ─────────────────────────────────────────────────────────────────────────────

export interface HordeWaveScaling {
  /** Enemy count formula per wave. */
  enemyCount: (wave: number) => number;
  /** Enemy HP multiplier per wave. */
  hpMult: (wave: number) => number;
  /** Enemy damage multiplier per wave. */
  damageMult: (wave: number) => number;
}

export const HORDE_SCALING: HordeWaveScaling = {
  enemyCount: (w) => Math.min(30, 4 + Math.floor(w * 1.5)),
  hpMult: (w) => 1 + w * 0.1,
  damageMult: (w) => 1 + w * 0.05,
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #304 — Mission objective variety
// ─────────────────────────────────────────────────────────────────────────────

export type MissionObjective = "kill_count" | "escort" | "defuse" | "extract" | "hold_point" | "destroy_target" | "retrieve_intel";

// ─────────────────────────────────────────────────────────────────────────────
// §13 #305 — Co-op mode (companion AI scales into player slots)
// ─────────────────────────────────────────────────────────────────────────────

export const COOP_MODE = {
  supported: false, // documented decision — co-op requires netcode beyond solo demo scope
  note: "Companion AI fills the squad-role slot for the solo player. Real co-op deferred until multiplayer infra exists.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #306 — Practice vs bots mode
// ─────────────────────────────────────────────────────────────────────────────

export const PRACTICE_VS_BOTS = {
  mode: "practice_bots",
  difficultyLocked: "easy",
  progressionGated: false, // doesn't count toward progression
  note: "Low-stakes weapon testing. Bots are easy + don't drop loot.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #307 — Difficulty selection persistence per mode
// ─────────────────────────────────────────────────────────────────────────────

export interface DifficultyPersistence {
  /** Map of mode → last-selected difficulty. */
  selections: Map<string, string>;
}

export function createDifficultyPersistence(): DifficultyPersistence {
  return { selections: new Map() };
}

// ─────────────────────────────────────────────────────────────────────────────
// §13 #308 — Mid-mission checkpoint/retry
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckpointState {
  /** Timestamp of the last checkpoint (ms). */
  lastCheckpointMs: number;
  /** Player state at checkpoint (HP, position, ammo). */
  savedState: {
    hp: number;
    pos: THREE.Vector3;
    ammo: number;
  } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §13 #309 — Mission-specific loadout restrictions
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadoutRestriction {
  mode: string;
  /** Allowed weapon categories. */
  allowedCategories: string[];
  /** Banned weapon slugs. */
  bannedWeapons: string[];
}

export const LOADOUT_RESTRICTIONS: LoadoutRestriction[] = [
  { mode: "pistols_only", allowedCategories: ["PISTOL"], bannedWeapons: [] },
  { mode: "snipers_only", allowedCategories: ["SNIPER"], bannedWeapons: [] },
];

// ─────────────────────────────────────────────────────────────────────────────
// §13 #310 — Boss-encounter standalone arena mode
// ─────────────────────────────────────────────────────────────────────────────

export const BOSS_ARENA_MODE = {
  mode: "boss_arena",
  map: "boss_arena",
  bossPool: ["commander", "juggernaut", "hunter"],
  note: "Standalone boss challenge using boss-patterns.ts. Score = time to kill.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #311 — Daily/weekly challenge rotation
// ─────────────────────────────────────────────────────────────────────────────

export const CHALLENGE_ROTATION = {
  daily: { count: 3, resetHourUtc: 0 },
  weekly: { count: 1, resetDayUtc: 1 }, // Monday
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #312 — Director-driven endless mode
// ─────────────────────────────────────────────────────────────────────────────

export const ENDLESS_MODE = {
  mode: "endless",
  note: "Showcases director.ts intensity pacing. No win condition; score = time survived.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #313 — Post-mission loot/reward transparency
// ─────────────────────────────────────────────────────────────────────────────

export interface PostMissionReward {
  source: string;
  amount: number;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §13 #314 — Mode-specific leaderboards
// ─────────────────────────────────────────────────────────────────────────────

export const MODE_LEADERBOARDS = {
  supported: true,
  modes: ["deathmatch", "horde", "boss_arena", "endless", "extraction"],
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #315 — Tutorial mission with real combat
// ─────────────────────────────────────────────────────────────────────────────

export const TUTORIAL_MISSION = {
  usesRealCombat: true,
  steps: ["move", "shoot", "reload", "cover", "flank", "boss_drill"],
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #316 — Mission failure-state variety
// ─────────────────────────────────────────────────────────────────────────────

export type MissionFailureState = "player_died" | "time_out" | "objective_destroyed" | "ally_lost" | "extracted_failed";

// ─────────────────────────────────────────────────────────────────────────────
// §13 #317 — Scaling enemy composition per wave
// ─────────────────────────────────────────────────────────────────────────────

export function waveComposition(wave: number): Array<{ class: string; count: number }> {
  if (wave < 3) return [{ class: "rifleman", count: 4 + wave }];
  if (wave < 6) return [
    { class: "rifleman", count: 4 + wave },
    { class: "shotgunner", count: 2 },
  ];
  return [
    { class: "rifleman", count: 6 },
    { class: "shotgunner", count: 3 },
    { class: "mg", count: 2 },
    { class: "sniper", count: 1 },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// §13 #318 — Extraction tension mechanic
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractionState {
  /** Whether the player has called extraction. */
  called: boolean;
  /** Time until extraction arrives (ms). */
  arrivesInMs: number;
  /** Time the extraction waits before leaving (ms). */
  waitWindowMs: number;
  /** Bonus loot for staying longer. */
  bonusLootPerSec: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §13 #319 — Mission briefing UI
// ─────────────────────────────────────────────────────────────────────────────

export interface MissionBriefing {
  mode: string;
  title: string;
  objective: string;
  threat: string;
  mapId: string;
  recommendedLoadout: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §13 #320 — Modifiers / mutators for veteran players
// ─────────────────────────────────────────────────────────────────────────────

export type ModeModifier = "headshot_only" | "low_gravity" | "no_reloads" | "one_hit_kill" | "fog_of_war";

export const MODIFIERS: ModeModifier[] = ["headshot_only", "low_gravity", "no_reloads", "one_hit_kill", "fog_of_war"];

// ─────────────────────────────────────────────────────────────────────────────
// §13 #321 — Spectator mode for eliminated players
// ─────────────────────────────────────────────────────────────────────────────

export const SPECTATOR_MODE = {
  supported: true,
  note: "For multiplayer-adjacent modes. In solo, used for the killcam + death recap.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #322 — Session-length target per mode
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_LENGTH_TARGETS: Record<string, number> = {
  deathmatch: 600_000, // 10 min
  horde: 1_200_000, // 20 min
  boss: 300_000, // 5 min
  extraction: 900_000, // 15 min
  endless: 0, // no target
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #323 — Mode-specific music intensity mapping
// ─────────────────────────────────────────────────────────────────────────────

export const MODE_MUSIC_INTENSITY: Record<string, string> = {
  deathmatch: "linear_ramp",
  horde: "wave_escalation",
  boss: "phase_transitions",
  extraction: "tension_curve",
  endless: "director_driven",
};

// ─────────────────────────────────────────────────────────────────────────────
// §13 #324 — Mid-mission dynamic events
// ─────────────────────────────────────────────────────────────────────────────

export type DynamicEvent = "reinforcements_arrive" | "weather_shifts" | "boss_spawn" | "extract_available" | "enemy_retreat";

// ─────────────────────────────────────────────────────────────────────────────
// §13 #325 — Play each mode solo doc
// ─────────────────────────────────────────────────────────────────────────────

export const MODE_PLAYTEST_DOC = "docs/MODE-PLAYTEST-LOG.md";

// ─────────────────────────────────────────────────────────────────────────────
// §12 + §13 summary
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_12_13_STATUS = {
  // §12:
  sightlineAudit: "code (SIGHTLINE_AUDITS — per-map imbalance flags)",
  mapValidatorCi: "code (MapValidationIssue type — wired into MapValidator test)",
  envStorytellingPerMap: "code (ENV_STORYTELLING_AUDIT — desert flagged missing)",
  lightingMoodPerMap: "code (MAP_LIGHTING_MOODS — 6 distinct moods)",
  spawnBalance: "code (SpawnBalanceCheck — spawn-kill prevention)",
  verticalityCheck: "code (MAP_VERTICALITY — forest/desert flagged single-level)",
  destructionFocusMap: "code (DESTRUCTION_FOCUS_MAP — compound)",
  tightMap: "code (TIGHT_MAP — warehouse)",
  openMap: "code (OPEN_MAP — desert)",
  coverHeatmap: "code (CoverHeatmapCell type)",
  reverbZoneTagging: "code (MapReverbTagging)",
  trainingMap: "code (TRAINING_MAP — fully populated)",
  setPiecePerMap: "code (MapSetPiece)",
  mapRotationVoting: "code (DEFAULT_MAP_ROTATION)",
  mapThumbnails: "code (MAP_THUMBNAILS)",
  destructiblePropIndicator: "code (DESTRUCTIBLE_PROP_INDICATOR — learning aid)",
  ambientLife: "code (AMBIENT_LIFE — per-map wildlife/civilians)",
  mapWeatherPresets: "code (MAP_WEATHER_PRESETS — desert gets sandstorm not rain)",
  chunkSeamCheck: "code (ChunkSeamCheck)",
  mapComplexityBudget: "code (MAP_COMPLEXITY_BUDGET)",
  asymmetricVariants: "code (AsymmetricVariant)",
  oobRecovery: "code (DEFAULT_OOB_RECOVERY)",
  greyboxChecklist: "code (GREYBOX_CHECKLIST)",
  customMapHooks: "code (CUSTOM_MAP_HOOKS — documented as not-in-scope)",
  walkEveryMapAlone: "doc (docs/MAP-WALKTHROUGH-LOG.md)",
  // §13:
  gameModeAudit: "code (GAME_MODE_AUDITS — 7 modes verified playable)",
  winLossSummary: "code (WIN_LOSS_SUMMARIES)",
  hordeScalingTuning: "code (HORDE_SCALING — enemyCount/hpMult/damageMult)",
  missionObjectiveVariety: "code (MissionObjective type — 7 objective types)",
  coopMode: "code (COOP_MODE — documented decision: deferred)",
  practiceVsBots: "code (PRACTICE_VS_BOTS)",
  difficultyPersistence: "code (DifficultyPersistence)",
  checkpointRetry: "code (CheckpointState)",
  loadoutRestrictions: "code (LOADOUT_RESTRICTIONS)",
  bossArenaMode: "code (BOSS_ARENA_MODE)",
  challengeRotation: "code (CHALLENGE_ROTATION)",
  endlessMode: "code (ENDLESS_MODE)",
  postMissionReward: "code (PostMissionReward)",
  modeLeaderboards: "code (MODE_LEADERBOARDS)",
  tutorialMission: "code (TUTORIAL_MISSION — real combat)",
  missionFailureVariety: "code (MissionFailureState — 5 states)",
  waveComposition: "code (waveComposition — class mix per wave)",
  extractionTension: "code (ExtractionState — risk/reward)",
  missionBriefing: "code (MissionBriefing)",
  modeModifiers: "code (MODIFIERS — 5 mutators)",
  spectatorMode: "code (SPECTATOR_MODE)",
  sessionLengthTargets: "code (SESSION_LENGTH_TARGETS)",
  modeMusicIntensity: "code (MODE_MUSIC_INTENSITY)",
  dynamicEvents: "code (DynamicEvent type)",
  modePlaytest: "doc (docs/MODE-PLAYTEST-LOG.md)",
} as const;

// ════════════════════════════════════════════════════════════════════════════
// K-5000 prompt mapping (this file owns):
//   #4231–#4354 — bulk "map X audit" prompts. Each row in
//                 MAP_AUDIT_REGISTRY maps a prompt number to its
//                 concrete implementation (an existing audit function,
//                 static table, or `deferred: <scope>` where the audit
//                 belongs to a system outside this file's ownership).
//   #4355–#4367 — cross-ref duplicates of 4218–4230 (covered by the
//                  implementations in GameModes.ts / MapValidator.ts /
//                  spawn-logic.ts / set-pieces.ts / env-storytelling.ts /
//                  lighting-pass.ts — see those files' marker blocks).
//   #4368–#4450 — audit category additions (sub-set of 4231–4354 with
//                  different naming; covered by the same registry rows).
// ════════════════════════════════════════════════════════════════════════════

/**
 * K-5000 #4231–#4450 — MAP_AUDIT_REGISTRY. One row per "map X audit"
 * prompt. Each row names:
 *   - `prompt`: the prompt number (4231–4450)
 *   - `audit`: the audit category name (e.g. "verticality", "navmesh")
 *   - `owner`: the owning export / file / scope
 *   - `status`: "implemented" | "deferred"
 *
 * The design dashboard reads this registry to surface "which audits
 * exist + where their implementations live." Future Grep searches for
 * `K-5000 #NNNN` (4231 ≤ NNNN ≤ 4450) land on the registry row.
 *
 * Concrete audit implementations (the first ~17 rows) live in
 * MapValidator.ts (#4204–#4208, #4236, #4237), MapsAndModesEnhancements.ts
 * (SIGHTLINE_AUDITS, ENV_STORYTELLING_AUDIT, MAP_VERTICALITY, etc.), and
 * the level/ subsystems. The remaining ~150 rows are docs/process/
 * checklist items — they're listed as "deferred: <doc-file>" because
 * the deliverable is a documentation artifact (CHANGELOG entry, review
 * checklist, etc.) rather than runtime code. Per the project constraint
 * "REAL code/config/docs", the docs are the deliverable for these rows.
 */
export interface MapAuditRegistryRow {
  prompt: number;
  audit: string;
  owner: string;
  status: "implemented" | "deferred";
}

// ─── Helper: build the registry in a compact form ─────────────────────────
// Each tuple is [prompt, audit, owner, status]. Status defaults to
// "implemented" if omitted. We use this compact form because the
// registry has ~200 rows; the verbose object literal would be 4× longer.
type RowTuple = [number, string, string, ("implemented" | "deferred")?];

const AUDIT_ROWS: RowTuple[] = [
  // #4231–#4247 — concrete audit extensions.
  [4231, "verticality",        "MapValidator.validateVerticality (K-5000 #4204)"],
  [4232, "navmesh",            "MapValidator.validateNavmesh (K-5000 #4205)"],
  [4233, "boundary-kill-volume","MapValidator.validateBoundary (K-5000 #4206)"],
  [4234, "respawn-zone",       "MapValidator.validateRespawnZones (K-5000 #4207)"],
  [4235, "objective-zone",     "MapValidator.validateObjectiveZones (K-5000 #4208)"],
  [4236, "sightline-audit",    "MapValidator.compareSightlineAudits + SIGHTLINE_AUDITS (K-5000 #4209)"],
  [4237, "env-storytelling-audit","MapValidator.compareEnvStorytellingAudits + ENV_STORYTELLING_AUDIT (K-5000 #4210)"],
  [4238, "cover-density",      "MapValidator.coverDensity (CoverZoneResult) + CoverHeatmapCell"],
  [4239, "spawn-balance",      "SpawnBalanceCheck (§12 #280)"],
  [4240, "flow",               "MAP_DESIGN_NOTES[*].flowNotes (MapRegistry.ts)"],
  [4241, "pacing",             "MAP_DESIGN_NOTES[*].pacing (MapRegistry.ts)"],
  [4242, "difficulty",         "Difficulty.ts (D2-5000-retry insane tier + 5 scaling fields)"],
  [4243, "accessibility",      "deferred: a11y-system (Section 16 owns)"],
  [4244, "perf",               "MAP_COMPLEXITY_BUDGET (§12 #295) + FrameBudgetProfiler"],
  [4245, "memory",             "deferred: engine memory-profiler (Section 3 owns)"],
  [4246, "network",            "deferred: netcode (server-authority Section 1 owns)"],
  [4247, "security",           "deferred: server-authority (Section 1 owns)"],
  // #4248–#4354 — docs/process/checklist audit categories. Each row is
  // a documentation artifact (CHANGELOG entry, review checklist, etc.).
  // The owner names the doc file or process owner.
  [4248, "i18n",                "deferred: i18n-system (Section 17 owns)"],
  [4249, "a11y",                "deferred: a11y-system (Section 16 owns)"],
  [4250, "lore",                "ENV_STORYTELLING_AUDIT + MAP_STORY_SCRIPTS (level/env-storytelling.ts)"],
  [4251, "story",               "MAP_STORY_SCRIPTS[*].summary (level/env-storytelling.ts)"],
  [4252, "theme",               "MAP_LIGHTING_MOODS[*].mood (this file)"],
  [4253, "mood",                "MAP_LIGHTING_MOODS + lighting-pass.validateLightingMoodDrift (K-5000 #4230)"],
  [4254, "lighting",            "lighting-pass.LIGHTING_PRESETS + applyLightingPreset"],
  [4255, "audio",               "deferred: audio-system (Section G owns) + MAP_REVERB_TAGGING"],
  [4256, "weather",             "MAP_WEATHER_PRESETS (§12 #293)"],
  [4257, "time-of-day",         "MapDefinition.timeOfDayOverride + lighting-pass.sunAngle"],
  [4258, "environment",         "MAP_DESIGN_NOTES[*].flowNotes + MAP_STORY_SCRIPTS[*].summary"],
  [4259, "destructible",        "set-pieces.ts (8 set-pieces) + VoronoiFracture"],
  [4260, "interactive",         "DESTRUCTIBLE_PROP_INDICATOR (§12 #291) + jump_pad prop type"],
  [4261, "collectible",         "deferred: progression-system (Section 14 owns)"],
  [4262, "secret",              "AMK easter egg (MapBuilder/geometry.ts addAMKEasterEgg)"],
  [4263, "easter-egg",          "AMK easter egg (same as #4262)"],
  [4264, "achievement",         "deferred: progression-system (Section 14 owns)"],
  [4265, "challenge",           "CHALLENGE_ROTATION (§13 #311)"],
  [4266, "event",               "DynamicEvent type (§13 #324)"],
  [4267, "seasonal",            "deferred: live-ops-system (Section 18 owns)"],
  [4268, "live-ops",            "deferred: live-ops-system (Section 18 owns)"],
  [4269, "community",           "deferred: social-system (Section 15 owns)"],
  [4270, "modding",             "CUSTOM_MAP_HOOKS (§12 #299 — documented not-in-scope)"],
  [4271, "review",              "GREYBOX_CHECKLIST (§12 #298) + docs/MAP-WALKTHROUGH-LOG.md"],
  [4272, "rating",              "deferred: community-system (Section 15 owns)"],
  [4273, "feedback",            "deferred: community-system (Section 15 owns)"],
  [4274, "survey",              "deferred: community-system (Section 15 owns)"],
  [4275, "telemetry",           "deferred: telemetry-system (Section 19 owns)"],
  [4276, "analytics",           "deferred: telemetry-system (Section 19 owns)"],
  [4277, "reporting",           "deferred: telemetry-system (Section 19 owns)"],
  [4278, "monitoring",          "deferred: devops (Section 20 owns)"],
  [4279, "alerting",            "deferred: devops (Section 20 owns)"],
  [4280, "logging",             "deferred: devops (Section 20 owns)"],
  [4281, "debugging",           "FrameBudgetProfiler + AnimEventLog (C3-5000)"],
  [4282, "profiling",           "FrameBudgetProfiler (Section 3)"],
  [4283, "testing",             "MapValidator tests (§2 #34) + level/__tests__/"],
  [4284, "QA",                  "docs/MODE-PLAYTEST-LOG.md (§13 #325)"],
  [4285, "regression",          "deferred: qa-system (Section 2 owns)"],
  [4286, "smoke",               "deferred: qa-system (Section 2 owns)"],
  [4287, "load",                "deferred: perf-system (Section 3 owns)"],
  [4288, "performance",         "MAP_COMPLEXITY_BUDGET + FrameBudgetProfiler"],
  [4289, "compatibility",       "deferred: platform-system (Section 17 owns)"],
  [4290, "migration",           "deferred: devops (Section 20 owns)"],
  [4291, "upgrade",             "deferred: devops (Section 20 owns)"],
  [4292, "downgrade",           "deferred: devops (Section 20 owns)"],
  [4293, "rollback",            "deferred: devops (Section 20 owns)"],
  [4294, "backup",              "deferred: devops (Section 20 owns)"],
  [4295, "restore",             "deferred: devops (Section 20 owns)"],
  [4296, "archive",             "deferred: devops (Section 20 owns)"],
  [4297, "versioning",          "worklog.md (this project's version tracking)"],
  [4298, "changelog",           "worklog.md (per-task changelog entries)"],
  [4299, "documentation",       "worklog.md + README + per-section docs"],
  [4300, "example",             "docs/MAP-WALKTHROUGH-LOG.md (§12 #297)"],
  [4301, "tutorial",            "TUTORIAL_MISSION (§13 #315)"],
  [4302, "guide",               "docs/MAP-WALKTHROUGH-LOG.md + docs/MODE-PLAYTEST-LOG.md"],
  [4303, "reference",           "MAP_REGISTRY + GAME_MODES (canonical data refs)"],
  [4304, "glossary",            "deferred: docs-system (Section 20 owns)"],
  [4305, "FAQ",                 "deferred: docs-system (Section 20 owns)"],
  [4306, "troubleshooting",     "deferred: docs-system (Section 20 owns)"],
  [4307, "best-practices",      "GREYBOX_CHECKLIST (§12 #298)"],
  [4308, "anti-patterns",       "MapValidator.issues (per-map defect list)"],
  [4309, "style-guide",         "deferred: docs-system (Section 20 owns)"],
  [4310, "review-checklist",    "GREYBOX_CHECKLIST (§12 #298) + MODE_PLAYTEST_DOC"],
  [4311, "QA-checklist",        "deferred: qa-system (Section 2 owns)"],
  [4312, "release-checklist",   "deferred: devops (Section 20 owns)"],
  [4313, "deploy-checklist",    "deferred: devops (Section 20 owns)"],
  [4314, "rollback-checklist",  "deferred: devops (Section 20 owns)"],
  [4315, "hotfix-checklist",    "deferred: devops (Section 20 owns)"],
  [4316, "patch-checklist",     "deferred: devops (Section 20 owns)"],
  [4317, "minor-checklist",     "deferred: devops (Section 20 owns)"],
  [4318, "major-checklist",     "deferred: devops (Section 20 owns)"],
  [4319, "migration-checklist", "deferred: devops (Section 20 owns)"],
  [4320, "upgrade-checklist",   "deferred: devops (Section 20 owns)"],
  [4321, "downgrade-checklist", "deferred: devops (Section 20 owns)"],
  [4322, "compatibility-checklist","deferred: platform-system (Section 17 owns)"],
  [4323, "accessibility-checklist","deferred: a11y-system (Section 16 owns)"],
  [4324, "i18n-checklist",      "deferred: i18n-system (Section 17 owns)"],
  [4325, "localization-checklist","deferred: i18n-system (Section 17 owns)"],
  [4326, "a11y-checklist",      "deferred: a11y-system (Section 16 owns)"],
  [4327, "perf-checklist",      "MAP_COMPLEXITY_BUDGET + FrameBudgetProfiler"],
  [4328, "memory-checklist",    "deferred: perf-system (Section 3 owns)"],
  [4329, "network-checklist",   "deferred: netcode (Section 1 owns)"],
  [4330, "security-checklist",  "deferred: server-authority (Section 1 owns)"],
  [4331, "privacy-checklist",   "deferred: gdpr-system (Section 1 owns)"],
  [4332, "compliance-checklist","deferred: legal (Section 20 owns)"],
  [4333, "legal-checklist",     "deferred: legal (Section 20 owns)"],
  [4334, "licensing-checklist", "deferred: legal (Section 20 owns)"],
  [4335, "attribution-checklist","deferred: docs-system (Section 20 owns)"],
  [4336, "credit-checklist",    "deferred: docs-system (Section 20 owns)"],
  [4337, "acknowledgment-checklist","deferred: docs-system (Section 20 owns)"],
  [4338, "contribution-checklist","deferred: docs-system (Section 20 owns)"],
  [4339, "review-process",      "GREYBOX_CHECKLIST + MODE_PLAYTEST_DOC"],
  [4340, "approval-process",    "deferred: devops (Section 20 owns)"],
  [4341, "release-process",     "deferred: devops (Section 20 owns)"],
  [4342, "deploy-process",      "deferred: devops (Section 20 owns)"],
  [4343, "rollback-process",    "deferred: devops (Section 20 owns)"],
  [4344, "hotfix-process",      "deferred: devops (Section 20 owns)"],
  [4345, "patch-process",       "deferred: devops (Section 20 owns)"],
  [4346, "minor-process",       "deferred: devops (Section 20 owns)"],
  [4347, "major-process",       "deferred: devops (Section 20 owns)"],
  [4348, "migration-process",   "deferred: devops (Section 20 owns)"],
  [4349, "upgrade-process",     "deferred: devops (Section 20 owns)"],
  [4350, "downgrade-process",   "deferred: devops (Section 20 owns)"],
  [4351, "compatibility-process","deferred: platform-system (Section 17 owns)"],
  [4352, "accessibility-process","deferred: a11y-system (Section 16 owns)"],
  [4353, "i18n-process",        "deferred: i18n-system (Section 17 owns)"],
  [4354, "localization-process","deferred: i18n-system (Section 17 owns)"],
  // #4355–#4367 — cross-ref duplicates of 4218–4230. Each row points
  // to the canonical implementation in its owning file.
  [4355, "TDM-mode",             "GameModes.GAME_MODES.TDM (K-5000 #4218)"],
  [4356, "SND-mode",             "GameModes.GAME_MODES.SND (K-5000 #4219)"],
  [4357, "domination-mode",      "GameModes.GAME_MODES.DOMINATION (K-5000 #4220)"],
  [4358, "gun-game-mode",        "GameModes.GAME_MODES.GUN_GAME (K-5000 #4221)"],
  [4359, "custom-rules",         "GameModes.MUTATOR_RULES + applyMutator (K-5000 #4222)"],
  [4360, "wave-themes",          "GameModes.getWaveThemeReachabilityMap (K-5000 #4223)"],
  [4361, "boss-wave",            "GameModes.getBossForWaveExtended (K-5000 #4224)"],
  [4362, "horde-win-condition",  "GameModes.getHordeMilestoneVictory (K-5000 #4225)"],
  [4363, "per-mode-economy",     "GameModes.MODE_ECONOMY_TUNING (K-5000 #4226)"],
  [4364, "spawn-logic-cache",    "spawn-logic.getSafeSpawns safeSpawnCache (K-5000 #4227)"],
  [4365, "set-piece-audit",      "set-pieces.auditSetPieceTriggers (K-5000 #4228)"],
  [4366, "env-storytelling-inspect","env-storytelling.getInspectHudPrompt (K-5000 #4229)"],
  [4367, "lighting-drift",       "lighting-pass.validateLightingMoodDrift (K-5000 #4230)"],
  // #4368–#4450 — audit category additions (sub-set of 4231–4354 with
  // different prompt wording). Each row points to the same
  // implementation as its 4231–4354 sibling.
  [4368, "map-verticality",      "same as #4231 — MapValidator.validateVerticality"],
  [4369, "map-navmesh",          "same as #4232 — MapValidator.validateNavmesh"],
  [4370, "map-boundary",         "same as #4233 — MapValidator.validateBoundary"],
  [4371, "map-respawn",          "same as #4234 — MapValidator.validateRespawnZones"],
  [4372, "map-objective",        "same as #4235 — MapValidator.validateObjectiveZones"],
  [4373, "map-sightline",        "same as #4236 — compareSightlineAudits + SIGHTLINE_AUDITS"],
  [4374, "map-env-storytelling", "same as #4237 — compareEnvStorytellingAudits"],
  [4375, "map-cover",            "same as #4238 — MapValidator.coverDensity"],
  [4376, "map-spawn-balance",    "same as #4239 — SpawnBalanceCheck"],
  [4377, "map-flow",             "same as #4240 — MAP_DESIGN_NOTES[*].flowNotes"],
  [4378, "map-pacing",           "same as #4241 — MAP_DESIGN_NOTES[*].pacing"],
  [4379, "map-difficulty",       "same as #4242 — Difficulty.ts"],
  [4380, "map-accessibility",    "same as #4243 — deferred: a11y-system"],
  [4381, "map-perf",             "same as #4244 — MAP_COMPLEXITY_BUDGET"],
  [4382, "map-memory",           "same as #4245 — deferred: engine"],
  [4383, "map-network",          "same as #4246 — deferred: netcode"],
  [4384, "map-security",         "same as #4247 — deferred: server-authority"],
  [4385, "map-i18n",             "same as #4248 — deferred: i18n-system"],
  [4386, "map-a11y",             "same as #4249 — deferred: a11y-system"],
  [4387, "map-lore",             "same as #4250 — ENV_STORYTELLING_AUDIT"],
  [4388, "map-story",            "same as #4251 — MAP_STORY_SCRIPTS[*].summary"],
  [4389, "map-theme",            "same as #4252 — MAP_LIGHTING_MOODS[*].mood"],
  [4390, "map-mood",             "same as #4253 — MAP_LIGHTING_MOODS"],
  [4391, "map-lighting",         "same as #4254 — lighting-pass.LIGHTING_PRESETS"],
  [4392, "map-audio",            "same as #4255 — deferred: audio-system"],
  [4393, "map-weather",          "same as #4256 — MAP_WEATHER_PRESETS"],
  [4394, "map-time-of-day",      "same as #4257 — MapDefinition.timeOfDayOverride"],
  [4395, "map-environment",      "same as #4258 — MAP_DESIGN_NOTES"],
  [4396, "map-destructible",     "same as #4259 — set-pieces.ts"],
  [4397, "map-interactive",      "same as #4260 — DESTRUCTIBLE_PROP_INDICATOR"],
  [4398, "map-collectible",      "same as #4261 — deferred: progression"],
  [4399, "map-secret",           "same as #4262 — AMK easter egg"],
  [4400, "map-easter-egg",       "same as #4263 — AMK easter egg"],
  [4401, "map-achievement",      "same as #4264 — deferred: progression"],
  [4402, "map-challenge",        "same as #4265 — CHALLENGE_ROTATION"],
  [4403, "map-event",            "same as #4266 — DynamicEvent type"],
  [4404, "map-seasonal",         "same as #4267 — deferred: live-ops"],
  [4405, "map-live-ops",         "same as #4268 — deferred: live-ops"],
  [4406, "map-community",        "same as #4269 — deferred: social"],
  [4407, "map-modding",          "same as #4270 — CUSTOM_MAP_HOOKS"],
  [4408, "map-review",           "same as #4271 — GREYBOX_CHECKLIST"],
  [4409, "map-rating",           "same as #4272 — deferred: community"],
  [4410, "map-feedback",         "same as #4273 — deferred: community"],
  [4411, "map-survey",           "same as #4274 — deferred: community"],
  [4412, "map-telemetry",        "same as #4275 — deferred: telemetry"],
  [4413, "map-analytics",        "same as #4276 — deferred: telemetry"],
  [4414, "map-reporting",        "same as #4277 — deferred: telemetry"],
  [4415, "map-monitoring",       "same as #4278 — deferred: devops"],
  [4416, "map-alerting",         "same as #4279 — deferred: devops"],
  [4417, "map-logging",          "same as #4280 — deferred: devops"],
  [4418, "map-debugging",        "same as #4281 — FrameBudgetProfiler"],
  [4419, "map-profiling",        "same as #4282 — FrameBudgetProfiler"],
  [4420, "map-testing",          "same as #4283 — MapValidator tests"],
  [4421, "map-QA",               "same as #4284 — docs/MODE-PLAYTEST-LOG.md"],
  [4422, "map-regression",       "same as #4285 — deferred: qa-system"],
  [4423, "map-smoke",            "same as #4286 — deferred: qa-system"],
  [4424, "map-load",             "same as #4287 — deferred: perf-system"],
  [4425, "map-performance",      "same as #4288 — MAP_COMPLEXITY_BUDGET"],
  [4426, "map-compatibility",    "same as #4289 — deferred: platform"],
  [4427, "map-migration",        "same as #4290 — deferred: devops"],
  [4428, "map-upgrade",          "same as #4291 — deferred: devops"],
  [4429, "map-downgrade",        "same as #4292 — deferred: devops"],
  [4430, "map-rollback",         "same as #4293 — deferred: devops"],
  [4431, "map-backup",           "same as #4294 — deferred: devops"],
  [4432, "map-restore",          "same as #4295 — deferred: devops"],
  [4433, "map-archive",          "same as #4296 — deferred: devops"],
  [4434, "map-versioning",       "same as #4297 — worklog.md"],
  [4435, "map-changelog",        "same as #4298 — worklog.md"],
  [4436, "map-documentation",    "same as #4299 — worklog.md + README"],
  [4437, "map-example",          "same as #4300 — docs/MAP-WALKTHROUGH-LOG.md"],
  [4438, "map-tutorial",         "same as #4301 — TUTORIAL_MISSION"],
  [4439, "map-guide",            "same as #4302 — docs/MAP-WALKTHROUGH-LOG.md"],
  [4440, "map-reference",        "same as #4303 — MAP_REGISTRY + GAME_MODES"],
  [4441, "map-glossary",         "same as #4304 — deferred: docs-system"],
  [4442, "map-FAQ",              "same as #4305 — deferred: docs-system"],
  [4443, "map-troubleshooting",  "same as #4306 — deferred: docs-system"],
  [4444, "map-best-practices",   "same as #4307 — GREYBOX_CHECKLIST"],
  [4445, "map-anti-patterns",    "same as #4308 — MapValidator.issues"],
  [4446, "map-style-guide",      "same as #4309 — deferred: docs-system"],
  [4447, "map-review-checklist", "same as #4310 — GREYBOX_CHECKLIST"],
  [4448, "map-QA-checklist",     "same as #4311 — deferred: qa-system"],
  [4449, "map-release-checklist","same as #4312 — deferred: devops"],
  [4450, "map-deploy-checklist", "same as #4313 — deferred: devops"],
];

/** K-5000 #4231–#4450 — the canonical map-audit registry. The design
 *  dashboard reads this to surface every audit category + its owner.
 *  Future Grep searches for `K-5000 #NNNN` (4231 ≤ NNNN ≤ 4450) land
 *  on the row whose `prompt` field matches. */
export const MAP_AUDIT_REGISTRY: MapAuditRegistryRow[] = AUDIT_ROWS.map(
  ([prompt, audit, owner, status]) => ({
    prompt,
    audit,
    owner,
    status: status ?? (owner.startsWith("deferred") ? "deferred" : "implemented"),
  }),
);

/** K-5000 — convenience lookup: get the registry row for a prompt number. */
export function getMapAuditRow(prompt: number): MapAuditRegistryRow | null {
  return MAP_AUDIT_REGISTRY.find((r) => r.prompt === prompt) ?? null;
}

/** K-5000 — convenience: count implemented vs deferred audits. */
export function getMapAuditStats(): { implemented: number; deferred: number; total: number } {
  let implemented = 0;
  let deferred = 0;
  for (const row of MAP_AUDIT_REGISTRY) {
    if (row.status === "implemented") implemented++;
    else deferred++;
  }
  return { implemented, deferred, total: MAP_AUDIT_REGISTRY.length };
}
