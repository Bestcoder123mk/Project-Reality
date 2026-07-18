/**
 * G4.2 — Difficulty scaling.
 *
 * A single multiplier applied to EnemyClasses' health/accuracy/spawnWeight
 * values. Scales the existing curve, doesn't redesign it. This is an
 * accessibility gap as much as a difficulty one — Easy makes the game
 * approachable for new players, Hard is for veterans.
 *
 * The multipliers are intentionally conservative — the base TTK is already
 * fast and lethal (per the G-series non-goals: "not a generic RPG's 5–15
 * hits per kill curve"). Easy reduces enemy durability + accuracy slightly;
 * Hard increases both + makes dangerous classes spawn more often.
 *
 * Section D (prompts 496–500) — added the "insane" tier + granular AI
 * scaling fields:
 *   - reactionTimeMs: AI reaction delay (Easy 800, Normal 400, Hard 200, Insane 100).
 *   - hitChance:      AI accuracy ceiling (Easy 0.40, Normal 0.60, Hard 0.75, Insane 0.85).
 *   - grenadePerMatch: cap on AI grenade throws (Easy 0, Normal 1, Hard 3, Insane 6).
 *   - coordination:   AI squad-coordination tier (none/basic/flanking/synchronized).
 *   - pickupScarcityMult: med/ammo pickup spawn multiplier (Hard/Insane = fewer).
 *
 * These fields are read by the AI systems (enemy-tactics, EnemySystem,
 * squad-coordinator, PickupSystem) to scale behavior at runtime. The
 * existing fields (healthMult / accuracyMult / damageMult / dangerSpawnMult)
 * remain the primary coarse knobs.
 */
export type Difficulty = "easy" | "normal" | "hard" | "insane";

/** Section D #499 — AI coordination tier. */
export type CoordinationTier = "none" | "basic" | "flanking" | "synchronized";

export interface DifficultyConfig {
  /** Display name. */
  name: string;
  /** Description shown in the settings panel. */
  description: string;
  /** Multiplier applied to enemy base health. */
  healthMult: number;
  /** Multiplier applied to enemy accuracy. */
  accuracyMult: number;
  /** Multiplier applied to dangerous-class spawn weights (MG/COMMANDER/SNIPER). */
  dangerSpawnMult: number;
  /** Multiplier applied to enemy per-shot damage. */
  damageMult: number;
  /** Section D #496 — AI reaction time (ms). Lower = faster reaction.
   *  Read by EnemySystem.update before dispatching an enemyShoot. */
  reactionTimeMs: number;
  /** Section D #497 — AI hit-chance ceiling (0..1). The enemy's class
   *  accuracy is multiplied by min(1, hitChance / classAccuracy) so Easy
   *  can't exceed 40% hit even with a Sniper (0.85 base). */
  hitChance: number;
  /** Section D #498 — Max AI grenade throws per match (0 = never). */
  grenadePerMatch: number;
  /** Section D #499 — AI coordination tier. Drives squad-coordinator
   *  behavior (no comms / basic callouts / flanking / synchronized pushes). */
  coordination: CoordinationTier;
  /** Section D #500 — Pickup scarcity multiplier. Multiplies the
   *  PickupSystem's per-death drop chance (1.0 = full, 0.5 = half).
   *  Hard/Insane = fewer med/ammo pickups. */
  pickupScarcityMult: number;
  /** Section B #154 — per-difficulty recoil multiplier for the PLAYER's
   *  weapon. Easy = 0.6, Normal = 1.0, Hard = 1.3, Insane = 1.6. Read by
   *  WeaponSystem.tryShoot to scale the per-shot recoil amount. */
  recoilMult: number;
  /** Section B #187 — per-difficulty malfunction rate multiplier. Easy = 0.5
   *  (rare jams), Normal = 1.0, Hard = 1.4, Insane = 1.8. Read by
   *  MalfunctionSystem.onShotFired to scale the malfunction probability. */
  malfunctionRateMult: number;
}

export const DIFFICULTY_CONFIGS: Record<Difficulty, DifficultyConfig> = {
  easy: {
    name: "Easy",
    description: "Forgiving combat. Enemies are less durable and less accurate. Recommended for new operators.",
    healthMult: 0.7,
    accuracyMult: 0.6,
    dangerSpawnMult: 0.5,
    damageMult: 0.7,
    // Section D — AI scaling for Easy. Slow reactions, low hit rate, no
    // grenades, no coordination, full pickups (mercy).
    reactionTimeMs: 800,
    hitChance: 0.40,
    grenadePerMatch: 0,
    coordination: "none",
    pickupScarcityMult: 1.0,
    recoilMult: 0.6,
    malfunctionRateMult: 0.5,
  },
  normal: {
    name: "Normal",
    description: "Balanced tactical combat. The intended Project Reality experience.",
    healthMult: 1.0,
    accuracyMult: 1.0,
    dangerSpawnMult: 1.0,
    damageMult: 1.0,
    reactionTimeMs: 400,
    hitChance: 0.60,
    grenadePerMatch: 1,
    coordination: "basic",
    pickupScarcityMult: 1.0,
    recoilMult: 1.0,
    malfunctionRateMult: 1.0,
  },
  hard: {
    name: "Hard",
    description: "Lethal, punishing combat. Enemies are tougher, deadlier, and elite classes spawn more often.",
    healthMult: 1.4,
    accuracyMult: 1.3,
    dangerSpawnMult: 1.8,
    damageMult: 1.3,
    reactionTimeMs: 200,
    hitChance: 0.75,
    grenadePerMatch: 3,
    coordination: "flanking",
    pickupScarcityMult: 0.6,
    recoilMult: 1.3,
    malfunctionRateMult: 1.4,
  },
  insane: {
    name: "Insane",
    description: "Nightmare. Near-instant AI reactions, deadly accuracy, synchronized squad tactics. For veterans only.",
    healthMult: 1.8,
    accuracyMult: 1.5,
    dangerSpawnMult: 2.4,
    damageMult: 1.6,
    reactionTimeMs: 100,
    hitChance: 0.85,
    grenadePerMatch: 6,
    coordination: "synchronized",
    pickupScarcityMult: 0.35,
    recoilMult: 1.6,
    malfunctionRateMult: 1.8,
  },
};

/** Get the difficulty config for a given setting (falls back to normal). */
export function getDifficultyConfig(diff: string): DifficultyConfig {
  return DIFFICULTY_CONFIGS[diff as Difficulty] ?? DIFFICULTY_CONFIGS.normal;
}

// ───────────────────────────────────────────────────────────────────────────
// Section D — runtime scaling helpers (prompts 496–500)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Section D #496 — Apply the difficulty reaction-time gate. Returns true
 * if `msSinceLastSeen` is past the difficulty's reaction window (the AI
 * has "noticed" the player and may shoot). Used by EnemySystem before
 * dispatching enemyShoot so Easy AI doesn't snap-fire on sight.
 */
export function aiCanReact(cfg: DifficultyConfig, msSinceLastSeen: number): boolean {
  return msSinceLastSeen >= cfg.reactionTimeMs;
}

/**
 * Section D #497 — Clamp an enemy's class accuracy to the difficulty's
 * hit-chance ceiling. Returns the effective accuracy to use for the
 * hit roll.
 */
export function aiEffectiveAccuracy(cfg: DifficultyConfig, classAccuracy: number): number {
  // Multiply by accuracyMult (legacy coarse knob) then clamp to hitChance.
  return Math.min(cfg.hitChance, classAccuracy * cfg.accuracyMult);
}

/**
 * Section D #498 — Returns true if the AI is allowed to throw another
 * grenade this match (given the current throw count + difficulty cap).
 */
export function aiGrenadeAllowed(cfg: DifficultyConfig, throwsThisMatch: number): boolean {
  return throwsThisMatch < cfg.grenadePerMatch;
}

/**
 * Section D #500 — Returns the per-death pickup drop chance multiplier
 * for the current difficulty. PickupSystem multiplies its base drop
 * chance (e.g. 1/10 medkit) by this value.
 */
export function aiPickupDropMult(cfg: DifficultyConfig): number {
  return cfg.pickupScarcityMult;
}

/**
 * Section B #154 — get the player's recoil multiplier for the given
 * difficulty. WeaponSystem.tryShoot multiplies the per-shot recoil by this.
 */
export function playerRecoilMult(cfg: DifficultyConfig): number {
  return cfg.recoilMult ?? 1.0;
}

/**
 * Section B #187 — get the malfunction rate multiplier for the given
 * difficulty. MalfunctionSystem.onShotFired multiplies the per-shot jam
 * probability by this.
 */
export function malfunctionRateMult(cfg: DifficultyConfig): number {
  return cfg.malfunctionRateMult ?? 1.0;
}
