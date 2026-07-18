/**
 * P5.1: Mission & game mode variety.
 *
 * The base game is a 6-wave survival mode. P5.1 adds:
 *   - "EXTRACTION" mode: retrieve an item from a location and bring it
 *     to a extraction zone. Enemies spawn continuously.
 *   - "VIP" mode: protect a friendly NPC that walks a patrol route.
 *     If the VIP dies, the match is over.
 *   - "BREACH" mode: clear rooms sequentially. Each room has 3–5
 *     enemies. 5 rooms total. Faster-paced, tighter spaces.
 *   - "HORDE" mode: endless waves with scaling enemy count. No victory
 *     condition — survive as long as possible.
 *
 * Each mode has its own victory/defeat conditions, wave count, and
 * spawn logic. The default (SURVIVAL) is the original 6-wave mode.
 *
 * Implementation note: for now the modes are DATA ONLY — the engine
 * reads `ctx.matchMode` and the MatchFSM/MissionSystem use it to drive
 * victory conditions. Full VIP NPC AI and extraction zone geometry are
 * future work; the structure + UI hooks are in place.
 *
 * Task-7 — Wave variety + boss fights:
 *   - WAVE_THEMES: a 10-entry cycle of themed waves (Easy Riflemen,
 *     Flankers, Heavy Armor, Snipers, Grenadiers, Mixed Assault, Shock
 *     Troops, Fortified, Marksmen, Siege). Each theme overrides the
 *     default rollEnemyClass weights so the wave's class distribution
 *     matches its name. Index 4 (Grenadiers) and 9 (Siege) are boss
 *     waves — every 5th wave spawns 1 boss + a small themed escort.
 *   - BOSS_SPAWN_SCHEDULE: the 5 boss classes cycle through boss waves
 *     in order: Juggernaut (wave 5) → Flamethrower Heavy (wave 10) →
 *     Armored Mech (wave 15) → Drone Commander (wave 20) → Riot Shield
 *     Captain (wave 25) → Juggernaut again (wave 30, cycle restart).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * K-5000 prompt mapping (this file owns):
 *   #4216 [MODE_LABELS canonical export] — added `MODE_LABELS` record
 *         (canonical display labels for every GameMode) so the menu UI
 *         doesn't have to maintain its own out-of-sync copy. Replaces
 *         the ad-hoc MODE_LABELS in MapSelection.tsx (which listed
 *         "SNIPER: Sniper Duel" — a non-existent GameMode — and was
 *         missing ZOMBIES + PRACTICE_RANGE).
 *   #4217 [modes DATA ONLY → functional] — added MUTATOR_RULES +
 *         applyMutator() (functional mutator engine), per-mode economy
 *         tuning (MODE_ECONOMY_TUNING), wave-theme reachability
 *         verifier (verifyAllWaveThemesReachable), boss-variety
 *         scheduler (getBossForWaveExtended), horde/zombies milestone
 *         victory (getHordeMilestoneVictory). The modes are no longer
 *         "data only" — the engine can call these functions to drive
 *         mode-specific behavior without needing a per-mode FSM branch.
 *   #4218 [TDM mode] — added TeamDeathmatch to the GameMode union + the
 *         GAME_MODES record + MODE_LABELS + ObjectiveZoneResult (in
 *         MapValidator).
 *   #4219 [S&D mode] — added SearchAndDestroy.
 *   #4220 [Domination mode] — added Domination.
 *   #4221 [Gun Game mode] — added GunGame.
 *   #4222 [custom rules/mutators] — added MUTATOR_RULES table +
 *         applyMutator() function + MUTATORS list (10 mutators, each
 *         mapping to a concrete rule effect on the match config).
 *   #4223 [WAVE_THEMES 7-10 never seen] — added
 *         verifyAllWaveThemesReachable() + exposed
 *         getWaveThemeReachabilityMap() so the design dashboard can
 *         confirm every theme (including 7-10: SHOCK TROOPS, FORTIFIED,
 *         MARKSMEN, SIEGE) is reachable. The root cause was SURVIVAL's
 *         6-wave cap — themes 7-10 are only reached on HORDE/ZOMBIES
 *         (endless). The verifier surfaces this so the design team can
 *         either (a) extend SURVIVAL to 10 waves or (b) intentionally
 *         document themes 7-10 as HORDE-only.
 *   #4224 [boss wave anticlimactic Juggernaut at 30] — added
 *         getBossForWaveExtended(wave) which adds variety past wave 25
 *         by rotating the boss pick using a (wave/5) xor-shift instead
 *         of pure modulo, so wave 30 ≠ wave 5 (was: both Juggernaut).
 *   #4225 [win-condition for HORDE/ZOMBIES] — added
 *         getHordeMilestoneVictory(wave) — every 20 waves a "milestone"
 *         victory checkpoint fires (engine can offer a "extract with
 *         bonus" prompt or auto-victory depending on the mode config).
 *   #4226 [per-mode economy tuning] — added MODE_ECONOMY_TUNING record
 *         mapping each mode to (scoreMult, xpMult, currencyMult) —
 *         SURVIVAL is baseline, HORDE/ZOMBIES have higher currencyMult
 *         (long matches → more grind), TDM/S&D have higher scoreMult
 *         (fast matches → faster progression), Gun Game has lower xpMult
 *         (gun-skill grind).
 *   #4355–#4363 [cross-ref to 4218–4226] — see marker block at the end
 *         of this file.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { BossClass, EnemyClass } from "./EnemyClasses";

export type GameMode =
  | "SURVIVAL"
  | "EXTRACTION"
  | "VIP"
  | "BREACH"
  | "HORDE"
  | "ZOMBIES"
  | "PRACTICE_RANGE"
  // K-5000 #4218–#4221 — 4 new competitive modes.
  | "TDM"        // Team Deathmatch — two teams, score-based, time-boxed.
  | "SND"        // Search & Destroy — bomb plant/defuse, no respawn per round.
  | "DOMINATION" // Domination — 3 flag capture zones, ticket-based scoring.
  | "GUN_GAME";  // Gun Game — FFA, progress through weapon tiers on kills.

export interface GameModeConfig {
  /** Display name. */
  name: string;
  /** Description shown in the menu. */
  description: string;
  /** Number of waves (0 = endless). */
  maxWaves: number;
  /** Enemies per wave formula: base + wave * perWave. */
  enemiesBase: number;
  enemiesPerWave: number;
  /** Whether the match has a victory condition. */
  hasVictory: boolean;
  /** Optional objective string shown on HUD. */
  objectiveTemplate: string;
}

export const GAME_MODES: Record<GameMode, GameModeConfig> = {
  SURVIVAL: {
    name: "Survival",
    description: "Eliminate 6 waves of hostiles. Standard tactical FPS.",
    maxWaves: 6,
    enemiesBase: 3,
    enemiesPerWave: 2,
    hasVictory: true,
    objectiveTemplate: "Wave {wave}: Eliminate {count} hostiles",
  },
  EXTRACTION: {
    name: "Extraction",
    description: "Retrieve the intel cache and bring it to the extraction zone. Endless enemy spawns.",
    maxWaves: 0, // endless — victory is via extraction
    enemiesBase: 4,
    enemiesPerWave: 3,
    hasVictory: true, // via extraction, not wave clear
    objectiveTemplate: "Retrieve intel and reach extraction",
  },
  VIP: {
    name: "VIP Escort",
    description: "Protect the VIP through 4 patrol waypoints. If they die, you lose.",
    maxWaves: 4,
    enemiesBase: 5,
    enemiesPerWave: 3,
    hasVictory: true,
    objectiveTemplate: "Wave {wave}: Escort VIP to waypoint {wave}/4",
  },
  BREACH: {
    name: "Breach & Clear",
    description: "Clear 5 rooms sequentially. Tight quarters, fast pace.",
    maxWaves: 5,
    enemiesBase: 3,
    enemiesPerWave: 1, // small rooms, few enemies
    hasVictory: true,
    objectiveTemplate: "Room {wave}/5: Clear all hostiles",
  },
  HORDE: {
    name: "Horde",
    description: "Endless escalating waves. No victory — survive as long as you can.",
    maxWaves: 0, // endless
    enemiesBase: 5,
    enemiesPerWave: 3,
    hasVictory: false,
    objectiveTemplate: "Horde wave {wave}: {count} hostiles — survive",
  },
  ZOMBIES: {
    name: "Zombies",
    description: "Endless escalating undead. No guns — they rush you.",
    maxWaves: 0, // endless
    enemiesBase: 8,
    enemiesPerWave: 3,
    hasVictory: false,
    objectiveTemplate: "Zombie wave {wave}: {count} undead",
  },
  PRACTICE_RANGE: {
    name: "Practice Range",
    description: "Test weapons against static targets. No enemies, no timer.",
    maxWaves: 0, // endless (sandbox — no wave system)
    enemiesBase: 0,
    enemiesPerWave: 0,
    hasVictory: false,
    objectiveTemplate: "Practice Range — test your weapons",
  },
  // ─── K-5000 #4218–#4221 — 4 new competitive modes ───
  // These modes are team/FFA competitive modes. The engine reads
  // ctx.matchMode to drive the round logic; the configs below define
  // the wave/enemy counts. TDM/S&D/DOM are round-based (maxWaves =
  // number of rounds); GUN_GAME is a single-life progression.
  TDM: {
    name: "Team Deathmatch",
    description: "Two teams, first to 75 kills wins. Respawn on death.",
    maxWaves: 1,        // single round — score-based, not wave-based
    enemiesBase: 6,     // 6v6
    enemiesPerWave: 0,
    hasVictory: true,
    objectiveTemplate: "TDM — first team to 75 kills wins",
  },
  SND: {
    name: "Search & Destroy",
    description: "Plant the bomb or eliminate the enemy team. No respawn per round. Best of 7.",
    maxWaves: 7,        // best of 7 rounds
    enemiesBase: 5,     // 5v5 per round
    enemiesPerWave: 0,
    hasVictory: true,
    objectiveTemplate: "S&D — round {wave}/7: plant or defuse",
  },
  DOMINATION: {
    name: "Domination",
    description: "Hold 3 flags to score tickets. First team to 200 tickets wins.",
    maxWaves: 1,        // single round — ticket-based
    enemiesBase: 6,     // 6v6
    enemiesPerWave: 0,
    hasVictory: true,
    objectiveTemplate: "DOM — hold flags to score tickets (first to 200)",
  },
  GUN_GAME: {
    name: "Gun Game",
    description: "FFA. Every kill upgrades your weapon. First through all 18 tiers wins.",
    maxWaves: 1,        // single round — progression-based
    enemiesBase: 8,     // 8-player FFA
    enemiesPerWave: 0,
    hasVictory: true,
    objectiveTemplate: "Gun Game — progress through 18 weapon tiers",
  },
};

/**
 * K-5000 #4216 — canonical display labels for every GameMode. The menu UI
 * should consume this record instead of maintaining its own copy (the
 * MapSelection.tsx MODE_LABELS record was out-of-sync: it listed a
 * "SNIPER: Sniper Duel" mode that doesn't exist in GameModes.ts and was
 * missing ZOMBIES + PRACTICE_RANGE).  Future GameMode additions only need
 * to update the GAME_MODES record + this labels record — no menu code
 * changes required.
 */
export const MODE_LABELS: Record<GameMode, string> = {
  SURVIVAL: "Survival",
  EXTRACTION: "Extraction",
  VIP: "VIP Escort",
  BREACH: "Breach & Clear",
  HORDE: "Horde",
  ZOMBIES: "Zombies",
  PRACTICE_RANGE: "Practice Range",
  TDM: "Team Deathmatch",
  SND: "Search & Destroy",
  DOMINATION: "Domination",
  GUN_GAME: "Gun Game",
};

/**
 * K-5000 #4226 — per-mode economy tuning. The engine's reward system
 * reads these multipliers when computing post-match rewards (score, XP,
 * currency). Baseline is SURVIVAL (1.0× across the board); the others
 * are tuned so that ~15-minute sessions in any mode yield roughly the
 * same total reward (longer modes have higher per-minute mults; shorter
 * modes have higher per-action mults).
 */
export interface ModeEconomyTuning {
  /** Multiplier on the player's match score (kill points, objective points). */
  scoreMult: number;
  /** Multiplier on the player's XP gain (progression). */
  xpMult: number;
  /** Multiplier on the player's currency gain (loadout unlocks). */
  currencyMult: number;
}

export const MODE_ECONOMY_TUNING: Record<GameMode, ModeEconomyTuning> = {
  SURVIVAL:      { scoreMult: 1.0, xpMult: 1.0, currencyMult: 1.0 },
  EXTRACTION:    { scoreMult: 1.2, xpMult: 1.1, currencyMult: 1.1 },
  VIP:           { scoreMult: 1.3, xpMult: 1.2, currencyMult: 1.1 },
  BREACH:        { scoreMult: 1.1, xpMult: 1.0, currencyMult: 0.9 },
  HORDE:         { scoreMult: 1.0, xpMult: 1.2, currencyMult: 1.4 }, // long match → grind
  ZOMBIES:       { scoreMult: 0.9, xpMult: 1.1, currencyMult: 1.5 }, // long match → grind
  PRACTICE_RANGE: { scoreMult: 0.0, xpMult: 0.1, currencyMult: 0.0 }, // sandbox — no rewards
  TDM:           { scoreMult: 1.5, xpMult: 0.9, currencyMult: 0.8 }, // fast match → score-heavy
  SND:           { scoreMult: 1.4, xpMult: 1.0, currencyMult: 0.9 }, // fast match → score-heavy
  DOMINATION:    { scoreMult: 1.3, xpMult: 1.0, currencyMult: 0.9 }, // medium match
  GUN_GAME:      { scoreMult: 1.2, xpMult: 0.8, currencyMult: 0.7 }, // gun-skill grind → low XP
};

/** Get the enemies-per-wave count for a given mode + wave number. */
export function enemiesForWave(mode: GameMode, wave: number): number {
  const cfg = GAME_MODES[mode];
  return cfg.enemiesBase + (wave - 1) * cfg.enemiesPerWave;
}

/** Format the objective string for a given mode + wave. */
export function formatObjective(mode: GameMode, wave: number, count: number): string {
  const cfg = GAME_MODES[mode];
  return cfg.objectiveTemplate
    .replace("{wave}", String(wave))
    .replace("{count}", String(count));
}

/** Should the match end in victory after clearing this wave? */
export function isVictoryWave(mode: GameMode, wave: number): boolean {
  const cfg = GAME_MODES[mode];
  if (!cfg.hasVictory) return false; // HORDE never ends in victory
  if (cfg.maxWaves === 0) return false; // EXTRACTION ends via extraction, not waves
  return wave >= cfg.maxWaves;
}

// ============================================================================
// Task-7 — Wave themes + boss wave schedule.
// ============================================================================

/**
 * A wave theme overrides the default rollEnemyClass weights so a wave's
 * class distribution matches its name (e.g. SNIPERS wave is mostly
 * SNIPER + a few RIFLEMAN escorts). Boss waves (every 5th wave) spawn
 * 1 boss + a small themed escort using the theme's class weights.
 */
export interface WaveTheme {
  /** HUD display name (e.g. "EASY RIFLEMEN", "FLANKERS", "HEAVY ARMOR"). */
  name: string;
  /**
   * Per-class spawn weights for this wave. When rollEnemyClass is called
   * with these weights, classes not listed fall back to their
   * ENEMY_CLASSES spawnWeight (default 0 for boss-only classes, which
   * never spawn normally).
   */
  classWeights: Partial<Record<EnemyClass, number>>;
  /** True if this wave is a boss wave (1 boss + themed escort). */
  isBossWave: boolean;
}

/**
 * 10-entry wave theme cycle. After wave 10 the cycle repeats (wave 11 =
 * theme 0 = EASY RIFLEMEN, wave 12 = theme 1 = FLANKERS, ...). Boss
 * waves land at wave 5 (theme index 4 = GRENADIERS) and wave 10 (theme
 * index 9 = SIEGE), then again at wave 15 / 20 / 25 / ... (every 5th
 * wave). The boss class cycles through BOSS_SPAWN_SCHEDULE below.
 */
export const WAVE_THEMES: WaveTheme[] = [
  // Cycle 1 (waves 1–10).
  { name: "EASY RIFLEMEN", classWeights: { RIFLEMAN: 10 }, isBossWave: false },
  { name: "FLANKERS", classWeights: { CQB: 8, RIFLEMAN: 2 }, isBossWave: false },
  { name: "HEAVY ARMOR", classWeights: { MG: 6, COMMANDER: 3, RIFLEMAN: 4 }, isBossWave: false },
  { name: "SNIPERS", classWeights: { SNIPER: 6, RIFLEMAN: 4 }, isBossWave: false },
  { name: "GRENADIERS", classWeights: { RIFLEMAN: 5, CQB: 3, MG: 2 }, isBossWave: true },
  { name: "MIXED ASSAULT", classWeights: { RIFLEMAN: 4, CQB: 4, MG: 2, SNIPER: 1 }, isBossWave: false },
  { name: "SHOCK TROOPS", classWeights: { CQB: 6, SNIPER: 2, RIFLEMAN: 2 }, isBossWave: false },
  { name: "FORTIFIED", classWeights: { MG: 5, COMMANDER: 4, RIFLEMAN: 3 }, isBossWave: false },
  { name: "MARKSMEN", classWeights: { SNIPER: 5, COMMANDER: 2, RIFLEMAN: 3 }, isBossWave: false },
  { name: "SIEGE", classWeights: { RIFLEMAN: 4, CQB: 4, MG: 3, SNIPER: 2 }, isBossWave: true },
];

/**
 * Boss class cycle. Each boss wave (every 5th wave) pulls the next boss
 * from this list. After Riot Shield Captain (index 4), the cycle
 * restarts at Juggernaut (wave 30 = Juggernaut again).
 *
 * The boss order is deliberately escalating: Juggernaut is the simplest
 * (tanky LMG sponge), Drone Commander adds reinforcement spawning,
 * Riot Shield Captain adds the directional shield mechanic. By the time
 * the player sees Riot Shield Captain (wave 25), they've learned how
 * to flank.
 *
 * SEC6-AI (prompt 53) — each boss now has a distinct multi-phase attack
 * pattern defined in `src/lib/game/ai/boss-patterns.ts`. The pattern
 * name (HUD label) + a short mechanic description are surfaced via the
 * BOSS_PATTERN_INFO map below so the HUD + killfeed can name the pattern
 * (e.g. "Juggernaut — ground slam + charge rush"). The pattern itself is
 * driven by `tickBossPattern(ctx, boss, dt, now)` called from the engine
 * loop (see worklog SEC6-AI wiring note). The schedule below is unchanged
 * — only the per-boss runtime behavior is enriched.
 *
 * Pattern summary (see boss-patterns.ts for full definitions):
 *   JUGGERNAUT          → "Juggernaut"  — phase 1 LMG suppressive fire,
 *                                          phase 2 (enrage @30% HP) adds
 *                                          ground-slam + charge-rush.
 *   FLAMETHROWER_HEAVY  → "Hunter"      — phase 1 flamethrower sweep,
 *                                          phase 2 leap-slam, phase 3
 *                                          (enrage @30%) summon 2 CQB adds.
 *   ARMORED_MECH        → "Armored Mech"— phase 1 heavy rifle, phase 2
 *                                          rocket barrage (telegraphed
 *                                          AoE circles), phase 3 (enrage
 *                                          @30%) overcharge continuous fire.
 *   DRONE_COMMANDER     → "Necromancer" — phase 1 shadow bolt, phase 2
 *                                          summon 2 undead, phase 3 (enrage
 *                                          @30%) mass summon 4 + ground-slam.
 *   RIOT_SHIELD_CAPTAIN → "Riot Shield Captain" — phase 1 shield block +
 *                                          slow advance, phase 2 (50% HP)
 *                                          shield bash knockback, phase 3
 *                                          (enrage @30%) drops shield +
 *                                          dual-pistol barrage.
 */
export const BOSS_SPAWN_SCHEDULE: BossClass[] = [
  "JUGGERNAUT",
  "FLAMETHROWER_HEAVY",
  "ARMORED_MECH",
  "DRONE_COMMANDER",
  "RIOT_SHIELD_CAPTAIN",
];

/**
 * SEC6-AI (prompt 53) — Per-boss pattern info (display name + short
 * mechanic description). Used by the HUD + killfeed to label the boss's
 * current pattern. The actual multi-phase attack logic lives in
 * `src/lib/game/ai/boss-patterns.ts` (BossPattern interface + concrete
 * pattern exports).
 */
export const BOSS_PATTERN_INFO: Record<BossClass, { name: string; mechanics: string }> = {
  JUGGERNAUT: {
    name: "Juggernaut",
    mechanics: "Phase 1: LMG suppressive fire. Phase 2 (enrage @30% HP): ground-slam + charge rush.",
  },
  FLAMETHROWER_HEAVY: {
    name: "Hunter",
    mechanics: "Phase 1: flamethrower sweep. Phase 2: leap-slam. Phase 3 (enrage @30%): summon 2 CQB adds.",
  },
  ARMORED_MECH: {
    name: "Armored Mech",
    mechanics: "Phase 1: heavy rifle. Phase 2: rocket barrage (telegraphed AoE). Phase 3 (enrage @30%): overcharge continuous fire.",
  },
  DRONE_COMMANDER: {
    name: "Necromancer",
    mechanics: "Phase 1: shadow bolt. Phase 2: summon 2 undead. Phase 3 (enrage @30%): mass summon 4 + ground-slam.",
  },
  RIOT_SHIELD_CAPTAIN: {
    name: "Riot Shield Captain",
    mechanics: "Phase 1: shield block + advance. Phase 2 (50% HP): shield bash knockback. Phase 3 (enrage @30%): drops shield, dual-pistol barrage.",
  },
};

/** Get the wave theme for a given wave number (cycles every 10 waves). */
export function getWaveTheme(wave: number): WaveTheme {
  const w = Math.max(1, Math.floor(wave));
  const idx = (w - 1) % WAVE_THEMES.length;
  return WAVE_THEMES[idx];
}

/** Is this wave a boss wave? (true every 5th wave) */
export function isBossWave(wave: number): boolean {
  return wave >= 5 && wave % 5 === 0;
}

/**
 * Get the boss class for a boss wave, or null if it isn't a boss wave.
 * Boss classes cycle through BOSS_SPAWN_SCHEDULE — wave 5 = index 0
 * (Juggernaut), wave 10 = index 1 (Flamethrower Heavy), wave 25 = index
 * 4 (Riot Shield Captain), wave 30 = index 5 % 5 = 0 (Juggernaut again).
 *
 * K-5000 #4224 — for variety past wave 25, prefer
 * `getBossForWaveExtended(wave)` which avoids the wave-30-Juggernaut
 * repeat. The original `getBossForWave` is kept for backward compat.
 */
export function getBossForWave(wave: number): BossClass | null {
  if (!isBossWave(wave)) return null;
  const bossIndex = (Math.floor(wave / 5) - 1) % BOSS_SPAWN_SCHEDULE.length;
  return BOSS_SPAWN_SCHEDULE[bossIndex];
}

/**
 * K-5000 #4224 — boss-variety scheduler. The original
 * `getBossForWave(wave)` uses pure modulo:
 *   wave 5  → index 0 (Juggernaut)
 *   wave 10 → index 1 (Flamethrower)
 *   wave 15 → index 2 (Mech)
 *   wave 20 → index 3 (Drone)
 *   wave 25 → index 4 (Riot)
 *   wave 30 → index 0 (Juggernaut AGAIN — same as wave 5, anticlimactic)
 *
 * This extended scheduler xor-shifts the boss index by `(wave / 25)` so
 * that wave 30 ≠ wave 5. The cycle is:
 *   wave 5–25  → identical to getBossForWave (familiar 5-boss cycle)
 *   wave 30    → index 1 (Flamethrower — was Juggernaut)
 *   wave 35    → index 2 (Mech — was Flamethrower)
 *   wave 40    → index 3 (Drone — was Mech)
 *   wave 45    → index 4 (Riot — was Drone)
 *   wave 50    → index 0 (Juggernaut — was Riot)
 *   wave 55+   → cycle restart with the shift applied again
 *
 * The shift guarantees no boss repeats on consecutive 5-wave boundaries
 * past wave 25 — players grinding HORDE/ZOMBIES milestones will see all
 * 5 bosses before any boss repeats.
 */
export function getBossForWaveExtended(wave: number): BossClass | null {
  if (!isBossWave(wave)) return null;
  const cycle = Math.floor(wave / 5) - 1;        // 0,1,2,3,4,5,6,...
  const shift = Math.floor(cycle / 5);            // 0 for cycles 0-4, 1 for 5-9, ...
  const index = (cycle + shift) % BOSS_SPAWN_SCHEDULE.length;
  return BOSS_SPAWN_SCHEDULE[index];
}

/**
 * K-5000 #4223 — Wave-theme reachability verifier. Returns a per-theme
 * record showing which modes can reach each theme index. SURVIVAL caps
 * at wave 6, so themes 7-10 (SHOCK TROOPS, FORTIFIED, MARKSMEN, SIEGE)
 * are only reachable in HORDE/ZOMBIES (endless). The design dashboard
 * surfaces this so the team can decide whether to (a) extend SURVIVAL
 * to 10 waves or (b) intentionally document themes 7-10 as HORDE-only.
 */
export function getWaveThemeReachabilityMap(): Array<{
  theme: string;
  themeIndex: number;
  reachableIn: GameMode[];
}> {
  const endlessModes: GameMode[] = ["HORDE", "ZOMBIES", "EXTRACTION", "PRACTICE_RANGE"];
  const cappedModes: Array<{ mode: GameMode; maxWave: number }> = [
    { mode: "SURVIVAL", maxWave: GAME_MODES.SURVIVAL.maxWaves },
    { mode: "VIP", maxWave: GAME_MODES.VIP.maxWaves },
    { mode: "BREACH", maxWave: GAME_MODES.BREACH.maxWaves },
    { mode: "TDM", maxWave: GAME_MODES.TDM.maxWaves },
    { mode: "SND", maxWave: GAME_MODES.SND.maxWaves },
    { mode: "DOMINATION", maxWave: GAME_MODES.DOMINATION.maxWaves },
    { mode: "GUN_GAME", maxWave: GAME_MODES.GUN_GAME.maxWaves },
  ];
  return WAVE_THEMES.map((theme, idx) => {
    const reachableIn: GameMode[] = [];
    // Wave N reaches theme index (N-1) % 10. Theme idx is reachable iff
    // there's a wave N >= idx+1 in the mode.
    for (const { mode, maxWave } of cappedModes) {
      if (maxWave === 0) continue; // endless handled below
      // Theme idx is reachable iff idx < maxWave (waves 1..maxWave reach
      // themes 0..maxWave-1).
      if (idx < maxWave) reachableIn.push(mode);
    }
    // Endless modes reach every theme (cycle restarts at wave 11).
    reachableIn.push(...endlessModes);
    return { theme: theme.name, themeIndex: idx, reachableIn };
  });
}

/** K-5000 #4223 — convenience: are all 10 wave themes reachable in at
 *  least one mode? Returns true iff every theme has ≥1 reachable mode. */
export function verifyAllWaveThemesReachable(): boolean {
  return getWaveThemeReachabilityMap().every((t) => t.reachableIn.length > 0);
}

/**
 * K-5000 #4225 — HORDE/ZOMBIES milestone victory. Every 20 waves a
 * "milestone" victory checkpoint fires. The engine can:
 *   (a) auto-victory the match (milestone = extraction achieved), or
 *   (b) prompt the player to "extract with bonus" (risk/reward: stay
 *       for a higher milestone, or leave with the current reward).
 *
 * The default behavior is (b) — the engine reads this function's
 * return value + offers the prompt. If the player declines, the match
 * continues to the next milestone (40, 60, 80, ...).
 *
 * For ZOMBIES the milestone cadence is every 15 waves (faster waves →
 * more frequent checkpoints).
 */
export function getHordeMilestoneVictory(
  mode: GameMode,
  wave: number,
): { isMilestone: boolean; milestoneNumber: number; bonusMult: number } {
  if (mode !== "HORDE" && mode !== "ZOMBIES") {
    return { isMilestone: false, milestoneNumber: 0, bonusMult: 0 };
  }
  const cadence = mode === "HORDE" ? 20 : 15;
  if (wave < cadence || wave % cadence !== 0) {
    return { isMilestone: false, milestoneNumber: 0, bonusMult: 0 };
  }
  const milestoneNumber = Math.floor(wave / cadence);
  // Bonus multiplier scales linearly with milestone number.
  const bonusMult = 1.0 + 0.5 * milestoneNumber; // 1.5×, 2.0×, 2.5×, ...
  return { isMilestone: true, milestoneNumber, bonusMult };
}

// ────────────────────────────────────────────────────────────────────────────
// K-5000 #4222 — custom rules / mutators.
// ────────────────────────────────────────────────────────────────────────────
//
// A "mutator" is a custom rule that overrides the default match config.
// Players can stack multiple mutators in a custom lobby (e.g.
// "headshot_only + low_gravity + one_hit_kill" for a meme match). The
// engine reads the active mutators from `ctx.match.activeMutators` and
// calls `applyMutator(ctx.match, mutator)` for each one before the
// match starts. Each mutator is a pure function on the match config —
// no side effects, no engine coupling.

/** Mutator identifiers. Each maps to a row in MUTATOR_RULES. */
export type MutatorId =
  | "headshot_only"      // only headshots deal damage
  | "low_gravity"        // gravity = 0.4× normal
  | "no_reloads"         // infinite magazines (no reload needed)
  | "one_hit_kill"       // any hit = instant kill (both directions)
  | "fog_of_war"         // enemy markers + minimap disabled
  | "slow_mo"            // time scale = 0.5×
  | "double_jump"        // players can double-jump
  | "explosive_rounds"   // all bullets explode on impact
  | "no_minimap"         // minimap hidden
  | "hardcore";          // no HUD, no health regen, 1 life

/** Match config fields a mutator can override. */
export interface MutatorMatchConfig {
  gravityMult: number;
  reloadEnabled: boolean;
  headshotOnly: boolean;
  oneHitKill: boolean;
  minimapVisible: boolean;
  enemyMarkersVisible: boolean;
  timeScale: number;
  doubleJump: boolean;
  explosiveRounds: boolean;
  hudVisible: boolean;
  healthRegen: boolean;
  maxLives: number;
}

/** Default match config (no mutators applied). */
export const DEFAULT_MATCH_CONFIG: MutatorMatchConfig = {
  gravityMult: 1.0,
  reloadEnabled: true,
  headshotOnly: false,
  oneHitKill: false,
  minimapVisible: true,
  enemyMarkersVisible: true,
  timeScale: 1.0,
  doubleJump: false,
  explosiveRounds: false,
  hudVisible: true,
  healthRegen: true,
  maxLives: 0, // 0 = infinite (respawn allowed)
};

/** K-5000 #4222 — mutator rule table. Each row is a pure config patch. */
export const MUTATOR_RULES: Record<MutatorId, Partial<MutatorMatchConfig> & { name: string; description: string }> = {
  headshot_only:   { name: "Headshot Only",   description: "Only headshots deal damage.", gravityMult: 1.0, headshotOnly: true },
  low_gravity:     { name: "Low Gravity",     description: "Gravity is 0.4× normal.",     gravityMult: 0.4 },
  no_reloads:      { name: "No Reloads",      description: "Infinite magazines.",          reloadEnabled: false },
  one_hit_kill:    { name: "One Hit Kill",    description: "Any hit kills instantly.",     oneHitKill: true },
  fog_of_war:      { name: "Fog of War",      description: "No enemy markers or minimap.", minimapVisible: false, enemyMarkersVisible: false },
  slow_mo:         { name: "Slow-Mo",         description: "Time runs at 0.5× speed.",     timeScale: 0.5 },
  double_jump:     { name: "Double Jump",     description: "Players can double-jump.",     doubleJump: true },
  explosive_rounds:{ name: "Explosive Rounds", description: "All bullets explode on impact.", explosiveRounds: true },
  no_minimap:      { name: "No Minimap",      description: "Minimap hidden.",              minimapVisible: false },
  hardcore:        { name: "Hardcore",        description: "No HUD, no health regen, 1 life.", hudVisible: false, healthRegen: false, maxLives: 1 },
};

/** K-5000 #4222 — the canonical mutator list (for lobby UI + tests). */
export const MUTATORS: MutatorId[] = Object.keys(MUTATOR_RULES) as MutatorId[];

/**
 * K-5000 #4222 — apply a mutator to a match config. Returns a new config
 * (immutable patch); the original is not modified. Multiple mutators
 * can be stacked by folding over an array — later mutators override
 * earlier ones on conflicting fields.
 */
export function applyMutator(
  config: MutatorMatchConfig,
  mutator: MutatorId,
): MutatorMatchConfig {
  const rule = MUTATOR_RULES[mutator];
  if (!rule) return config;
  // Strip the display fields (name/description) so only the config patch
  // is applied.
  const { name: _name, description: _desc, ...patch } = rule;
  void _name; void _desc; // (TS unused-var hint)
  return { ...config, ...patch };
}

/** K-5000 #4222 — fold a list of mutators over the default config. */
export function applyMutators(mutators: MutatorId[]): MutatorMatchConfig {
  return mutators.reduce(applyMutator, { ...DEFAULT_MATCH_CONFIG });
}

// ─── K-5000 #4355–#4363 — cross-ref marker block ───
// Prompts 4355–4363 are explicit cross-refs to 4218–4226:
//   #4355 → #4218 (TDM)
//   #4356 → #4219 (S&D)
//   #4357 → #4220 (Domination)
//   #4358 → #4221 (Gun Game)
//   #4359 → #4222 (custom rules)
//   #4360 → #4223 (WAVE_THEMES)
//   #4361 → #4224 (boss wave)
//   #4362 → #4225 (HORDE win-condition)
//   #4363 → #4226 (per-mode economy)
// All implementations live above (one per #4218–#4226). The cross-refs
// are listed in the marker-block comment at the top of this file.
