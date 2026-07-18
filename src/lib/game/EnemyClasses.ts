import * as THREE from "three";
import type { Enemy } from "./systems/types";
import type { EnemyFSM } from "./fsm/EnemyFSM";

/**
 * P5.2: Enemy class system.
 *
 * Each enemy belongs to a class that determines its stats (health,
 * speed, accuracy, damage), weapon (caliber for audio + tracer color),
 * FSM thresholds (attackRange, suppression tolerance), and visual
 * appearance (suit color, scale).
 *
 * Five normal classes:
 *   - RIFLEMAN: baseline. 100 HP, 2.6 m/s, 0.55 accuracy, rifle audio.
 *   - SNIPER:   high damage, slow ROF, long range. 80 HP, 1.8 m/s,
 *               0.85 accuracy, sniper audio. Stays at range, doesn't push.
 *   - MG:       high HP, suppressive fire. 180 HP, 1.5 m/s, 0.35 accuracy,
 *               smg audio (high ROF). Pins the player, lets others push.
 *   - CQB:      fast, aggressive, short range. 70 HP, 4.0 m/s, 0.7 accuracy,
 *               pistol audio. Rushes the player, attacks at close range.
 *   - COMMANDER: tanky coordinator. 250 HP, 2.2 m/s, 0.5 accuracy, rifle
 *               audio. Triggers flank orders in nearby enemies (future).
 *
 * Task-12 — Four additional normal classes (player-requested):
 *   - MEDIC:      90 HP, 2.4 m/s, 0.45 accuracy, pistol audio. Medical-green
 *                 suit (0x2a4a3a). Heals + revives nearby allies (see
 *                 tickHealAlly in enemy-tactics.ts, gated on class). Defends
 *                 itself with a pistol but prioritizes healing.
 *   - SHIELD:     150 HP, 1.8 m/s, 0.4 accuracy, pistol audio. Front-facing
 *                 ballistic shield (hasShield: true) blocks 80% of front-cone
 *                 damage. Advances slowly, never seeks cover (the shield IS
 *                 its cover). Drops the shield + flees at <30% HP.
 *   - SCOUT:      60 HP, 4.5 m/s (fast), 0.6 accuracy, smg audio. Sprints to
 *                 random patrol points while searching for the player (recon
 *                 behavior gated on class — runs in IDLE). On spotting the
 *                 player, alerts all enemies within 30m (vs the normal 20m
 *                 callout radius). Strafes rapidly in combat, never seeks
 *                 cover, retreats easily (low suppression threshold 0.3).
 *   - SHOTGUNNER: 110 HP, 3.0 m/s, 0.75 accuracy, pistol audio. Rushes the
 *                 player to within 6m then fires a 6-pellet spread (each
 *                 pellet 18-35 damage). Devastating at point-blank.
 *
 * Task-7: Five BOSS classes — Juggernaut, Flamethrower Heavy, Armored
 * Mech, Drone Commander, Riot Shield Captain. Spawned on boss waves
 * (every 5th wave). Each boss has unique stats + visual flair + optional
 * damageReduction / hasShield / reinforcementIntervalSec fields.
 *
 * Task-15: ZOMBIE class — melee-only undead rusher for ZOMBIES mode.
 * 60 HP, 2.8 m/s, accuracy 0 (never shoots), 2m melee attack. Spawned
 * exclusively by EnemySystem.startWave in ZOMBIES mode (bypasses
 * rollEnemyClass entirely). The FSM is also bypassed in EnemySystem.update
 * — zombies never take cover, suppress, or flee. Visual: decayed green-gray
 * skin tone via the standard humanoid mesh recolor.
 *
 * The class is set on spawn (random distribution weighted by wave number,
 * OR overridden by the wave theme's classWeights for themed waves).
 */

export type EnemyClass =
  | "RIFLEMAN"
  | "SNIPER"
  | "MG"
  | "CQB"
  | "COMMANDER"
  | "ZOMBIE"
  // Task-12 — Four additional normal classes (player-requested):
  // MEDIC, SHIELD, SCOUT, SHOTGUNNER. See the docstring above + the
  // per-class config below for stats + special behavior notes.
  | "MEDIC"
  | "SHIELD"
  | "SCOUT"
  | "SHOTGUNNER";

/** Task-7 — Boss classes. */
export type BossClass =
  | "JUGGERNAUT"
  | "FLAMETHROWER_HEAVY"
  | "ARMORED_MECH"
  | "DRONE_COMMANDER"
  | "RIOT_SHIELD_CAPTAIN";

export interface EnemyClassConfig {
  /** Display name (for killfeed / HUD). */
  name: string;
  /** Base health. */
  health: number;
  /** Base movement speed (m/s). */
  speed: number;
  /** Accuracy 0..1 (chance to hit per shot at 0 distance). */
  accuracy: number;
  /** Per-shot damage range [min, max]. */
  damageRange: [number, number];
  /** Caliber for audio + tracer color. */
  caliber: "rifle" | "smg" | "sniper" | "pistol";
  /** Shot cooldown range [minMs, maxMs]. */
  shotCooldown: [number, number];
  /** FSM attack range (m). */
  attackRange: number;
  /** FSM suppression threshold (0..1). */
  suppressionThreshold: number;
  /** Suit color (hex). */
  suitColor: number;
  /** Scale multiplier on the humanoid mesh. */
  scale: number;
  /** Weight in spawn distribution (higher = more common). */
  spawnWeight: number;
  /** Minimum wave number to start spawning. */
  minWave: number;
  /** Task-7 — Damage reduction 0..1 (fraction of incoming damage to
   *  subtract). 0 = full damage taken (default for normal classes).
   *  Juggernaut 0.5, Armored Mech 0.6, etc. */
  damageReduction?: number;
  /** Task-7 — Front-facing ballistic shield. When true, bullets that
   *  impact from the enemy's front 120° cone have damage reduced 80%.
   *  Only RIOT_SHIELD_CAPTAIN uses this. */
  hasShield?: boolean;
  /** Task-7 — Reinforcement interval (seconds). When set, the enemy
   *  spawns 1-2 minor escort enemies near itself on this cadence.
   *  Only DRONE_COMMANDER uses this. */
  reinforcementIntervalSec?: number;
  /** Section D #491–495 — class-specific behavior flags. Read by
   *  enemy-tactics.ts to gate per-class behavior. Each flag documents the
   *  prompt it implements. */
  /** #491 — Rifleman: balanced generalist (no special flag — baseline). */
  /** #492 — MG: true if the class needs a bipod-deploy for sustained fire.
   *  When true, the MG suffers an accuracy penalty while moving; the penalty
   *  clears after the MG holds still for > 1s (simulated bipod-deploy). */
  bipodRequired?: boolean;
  /** #492 — MG: true if the class fires a suppressive fire lane (pins the
   *  player independent of hit chance). SuppressionSystem adds extra player
   *  suppression while an MG with suppressiveLane=true is firing. */
  suppressiveLane?: boolean;
  /** #493 — Sniper: true if the class should reposition after every shot
   *  (relocate to a new overwatch position after firing). */
  repositionAfterShot?: boolean;
  /** #493 — Sniper: true if the class has ghillie prone camouflage (harder
   *  to spot when prone / stationary). Read by EnemySystem's perception
   *  check to reduce the player's effective sight range vs this enemy. */
  ghillieProne?: boolean;
  /** #494 — Shotgunner: true if the class sprints to breach doors + rush
   *  the player (no cover-to-cover advance; pure aggression). */
  breachingRush?: boolean;
  /** #495 — Commander: true if the class radiates a command aura (nearby
   *  allies gain an accuracy + aggression buff while within radius). */
  commandAura?: boolean;
  /** #495 — Commander: radius (m) of the command aura. */
  commandAuraRadius?: number;
  /** #495 — Commander: true if the class can call in reinforcements /
   *  artillery (consumes a cooldown; spawns adds or applies AoE). */
  callIn?: boolean;
  /** #495 — Commander: call-in cooldown (seconds). */
  callInCooldownSec?: number;
}

export const ENEMY_CLASSES: Record<EnemyClass, EnemyClassConfig> = {
  RIFLEMAN: {
    name: "Rifleman", health: 100, speed: 2.6, accuracy: 0.55,
    damageRange: [8, 18], caliber: "rifle", shotCooldown: [700, 1300],
    attackRange: 8, suppressionThreshold: 0.6, suitColor: 0x2a2a30,
    scale: 1.0, spawnWeight: 10, minWave: 1,
  },
  SNIPER: {
    name: "Sniper", health: 80, speed: 1.8, accuracy: 0.85,
    damageRange: [40, 60], caliber: "sniper", shotCooldown: [2000, 3500],
    attackRange: 35, suppressionThreshold: 0.4, suitColor: 0x3a3a2a,
    scale: 1.0, spawnWeight: 2, minWave: 2,
    // Section D #493 — Sniper repositions after every shot (relocate to
    // a new overwatch position) + ghillie prone camouflage (harder to
    // spot when stationary). EnemySystem perception check multiplies
    // the player's effective sight range by 0.5 vs a ghillie-prone
    // sniper that hasn't moved in >2s.
    repositionAfterShot: true,
    ghillieProne: true,
  },
  MG: {
    name: "Machine Gunner", health: 180, speed: 1.5, accuracy: 0.35,
    damageRange: [6, 12], caliber: "smg", shotCooldown: [150, 300],
    attackRange: 15, suppressionThreshold: 0.8, suitColor: 0x2a2a20,
    scale: 1.15, spawnWeight: 1, minWave: 3,
    // Section D #492 — MG suppressive fire lane + bipod-deploy gating.
    // When bipodRequired is true, the MG takes an accuracy penalty while
    // moving (cleared after holding still >1s). suppressiveLane=true
    // means the MG fires a pinning lane — bullets near the player apply
    // extra suppression even on miss (SuppressionSystem scales the
    // near-miss bump by 2× for suppressiveLane enemies).
    bipodRequired: true,
    suppressiveLane: true,
  },
  CQB: {
    name: "CQB", health: 70, speed: 4.0, accuracy: 0.7,
    damageRange: [12, 22], caliber: "pistol", shotCooldown: [400, 800],
    attackRange: 4, suppressionThreshold: 0.5, suitColor: 0x3a2030,
    scale: 0.95, spawnWeight: 3, minWave: 2,
  },
  COMMANDER: {
    name: "Commander", health: 250, speed: 2.2, accuracy: 0.5,
    damageRange: [15, 25], caliber: "rifle", shotCooldown: [600, 1000],
    attackRange: 12, suppressionThreshold: 0.7, suitColor: 0x4a3a1a,
    scale: 1.2, spawnWeight: 1, minWave: 4,
    // Section D #495 — Commander radiates a command aura (allies within
    // 12m gain +15% accuracy + +20% aggression) + can call in
    // reinforcements / artillery on a 30s cooldown. Behavior lives in
    // ai-enhancements-d.ts (tickCommanderAura + tickCommanderCallIn).
    commandAura: true,
    commandAuraRadius: 12,
    callIn: true,
    callInCooldownSec: 30,
  },
  ZOMBIE: {
    // Task-15 — Zombies mode. Melee-only undead rusher. No gun, no cover,
    // no flee — just relentless chase + claw swipe at 2m. Spawned exclusively
    // in ZOMBIES mode (EnemySystem.startWave applies ZOMBIE directly via
    // applyClassToEnemy, bypassing rollEnemyClass). Visual: decayed green-gray
    // skin tone via the standard humanoid mesh recolor — no separate mesh.
    //
    // spawnWeight is 0 (NOT 100 as the task brief suggested) because the
    // brief's "100 = all spawns are zombies" intent is already satisfied by
    // the ZOMBIES-mode spawn override — the value here ONLY affects
    // rollEnemyClass, which is called by the normal SURVIVAL/HORDE/etc.
    // wave themes. None of those themes list ZOMBIE in their classWeights,
    // so a spawnWeight of 100 would leak zombies into every normal wave
    // (where they'd dominate due to the high weight). 0 keeps ZOMBIE
    // exclusive to ZOMBIES mode without touching rollEnemyClass.
    name: "Zombie", health: 60, speed: 2.8, accuracy: 0,
    damageRange: [15, 25], caliber: "pistol", // caliber unused — never shoots
    shotCooldown: [99999, 99999], // never shoots (melee only)
    attackRange: 2, suppressionThreshold: 1.0, // never suppressed
    suitColor: 0x3a4a2a, scale: 0.95, spawnWeight: 0, minWave: 1,
  },
  MEDIC: {
    // Task-12 — Combat medic. Heals + revives nearby allies (see
    // tickMedicHeal in enemy-tactics.ts — behavior is gated on the
    // MEDIC class, not on an FSM state, per the task's final approach).
    // Defends itself with a pistol (caliber "pistol") but prioritizes
    // healing when an ally is below 50% HP within 8m. Visual: medical-
    // green suit (0x2a4a3a). The existing applyClassToEnemy recolors
    // the suit; medics use the medical-green tint as their identifier
    // (a distinct red-cross armband would require a custom mesh — kept
    // out of scope to avoid touching buildHumanoid, which Task 3 owns).
    name: "Medic", health: 90, speed: 2.4, accuracy: 0.45,
    damageRange: [6, 14], caliber: "pistol", shotCooldown: [800, 1400],
    attackRange: 10, suppressionThreshold: 0.5,
    suitColor: 0x2a4a3a, scale: 1.0, spawnWeight: 2, minWave: 2,
  },
  SHIELD: {
    // Task-12 — Ballistic-shield riot trooper. Front-facing shield
    // blocks 80% of damage from the front 120° cone (handled by the
    // existing damageEnemy shield logic — reuses the Task-7 boss
    // hasShield mechanic). Advances slowly toward the player, never
    // seeks cover (the shield IS its cover). Drops the shield + flees
    // at <30% HP (see tickCover / tickAttackMaintainRange class gates
    // in enemy-tactics.ts).
    name: "Shield", health: 150, speed: 1.8, accuracy: 0.4,
    damageRange: [8, 16], caliber: "pistol", shotCooldown: [600, 1000],
    attackRange: 8, suppressionThreshold: 0.8,
    suitColor: 0x2a2a3a, scale: 1.1, spawnWeight: 2, minWave: 3,
    hasShield: true,
  },
  SCOUT: {
    // Task-12 — Fast recon. Sprints to random patrol points while
    // searching for the player (recon behavior gated on class — runs
    // in IDLE via tickChase). On spotting the player, alerts all
    // enemies within 30m (vs the normal 20m callout — see
    // scoutWideCallout in enemy-tactics.ts). Strafes rapidly in
    // combat, never seeks cover, retreats easily (suppression threshold
    // 0.3 — breaks fast under return fire). Fodder class (NOT marked
    // dangerous — does not scale with difficulty dangerSpawnMult).
    name: "Scout", health: 60, speed: 4.5, accuracy: 0.6,
    damageRange: [10, 18], caliber: "smg", shotCooldown: [300, 600],
    attackRange: 12, suppressionThreshold: 0.3,
    suitColor: 0x3a3a2a, scale: 0.95, spawnWeight: 3, minWave: 2,
  },
  SHOTGUNNER: {
    // Task-12 — Close-range burst damage. Rushes the player to within
    // 6m, then fires a 6-pellet spread (each pellet 18-35 damage). The
    // pellet blast is implemented in enemy-tactics.ts (shotgunPelletBlast)
    // — a local helper that replicates enemyShoot's per-shot logic 6×
    // (the spec's "call enemyShoot 6 times" can't be done directly since
    // EnemySystem.ts is read-only; the local helper produces the same
    // gameplay result: 6 independent hit/damage rolls per blast). At
    // point-blank a full blast is devastating (~105 dmg if all pellets
    // hit). caliber "pistol" reuses the pistol audio SFX.
    //
    // Section D #494 — Shotgunner is a breaching rusher: sprints at the
    // player + breaches doors (no cover-to-cover). The breachingRush
    // flag gates the rush behavior in tickShotgunnerRush (already in
    // place via the SHOTGUNNER class gate) + the door-breach logic in
    // ai-enhancements-d.ts.
    name: "Shotgunner", health: 110, speed: 3.0, accuracy: 0.75,
    damageRange: [18, 35], caliber: "pistol", shotCooldown: [700, 1200],
    attackRange: 6, suppressionThreshold: 0.5,
    suitColor: 0x3a2030, scale: 1.05, spawnWeight: 2, minWave: 3,
    breachingRush: true,
  },
};

/**
 * Task-7 — Boss class configs. Bosses are spawned on boss waves
 * (every 5th wave — see GameModes.getBossForWave). Each boss trades
 * speed/scale for raw durability + a unique mechanic:
 *
 *   JUGGERNAUT         — 600 HP, 50% damage reduction. Slow LMG-platform
 *                        bullet sponge. Scaled 1.5× + darker armor tint
 *                        + shoulder pauldrons.
 *   FLAMETHROWER_HEAVY — 300 HP, medium speed, short-range high-DPS.
 *                        20% damage reduction. Scaled 1.3× + ember tint.
 *   ARMORED_MECH       — 800 HP, very slow, 60% damage reduction, heavy
 *                        damage rifle. Scaled 1.8× + metallic tint.
 *   DRONE_COMMANDER    — 250 HP, fast, calls reinforcements every 8s.
 *                        Scaled 0.9× + blue tactical tint.
 *   RIOT_SHIELD_CAPTAIN— 400 HP, medium speed, front ballistic shield
 *                        blocks 80% of front-cone bullet damage. Player
 *                        must flank. Scaled 1.2× + green-visored tint +
 *                        shield mesh.
 */
export const BOSS_CLASSES: Record<BossClass, EnemyClassConfig> = {
  JUGGERNAUT: {
    name: "Juggernaut", health: 600, speed: 1.2, accuracy: 0.5,
    damageRange: [15, 25], caliber: "smg", shotCooldown: [120, 250],
    attackRange: 18, suppressionThreshold: 0.95,
    suitColor: 0x1a1a22, scale: 1.5, spawnWeight: 0, minWave: 5,
    damageReduction: 0.5, hasShield: false,
  },
  FLAMETHROWER_HEAVY: {
    name: "Flamethrower Heavy", health: 300, speed: 2.2, accuracy: 0.7,
    damageRange: [8, 14], caliber: "smg", shotCooldown: [80, 160],
    attackRange: 8, suppressionThreshold: 0.8,
    suitColor: 0x3a1a0a, scale: 1.3, spawnWeight: 0, minWave: 5,
    damageReduction: 0.2, hasShield: false,
  },
  ARMORED_MECH: {
    name: "Armored Mech", health: 800, speed: 1.0, accuracy: 0.45,
    damageRange: [20, 35], caliber: "rifle", shotCooldown: [600, 1000],
    attackRange: 20, suppressionThreshold: 1.0,
    suitColor: 0x202028, scale: 1.8, spawnWeight: 0, minWave: 5,
    damageReduction: 0.6, hasShield: false,
  },
  DRONE_COMMANDER: {
    name: "Drone Commander", health: 250, speed: 3.5, accuracy: 0.6,
    damageRange: [10, 18], caliber: "rifle", shotCooldown: [500, 900],
    attackRange: 14, suppressionThreshold: 0.6,
    suitColor: 0x1a2a3a, scale: 0.9, spawnWeight: 0, minWave: 5,
    damageReduction: 0.1, hasShield: false,
    reinforcementIntervalSec: 8,
  },
  RIOT_SHIELD_CAPTAIN: {
    name: "Riot Shield Captain", health: 400, speed: 2.0, accuracy: 0.6,
    damageRange: [12, 20], caliber: "pistol", shotCooldown: [400, 700],
    attackRange: 8, suppressionThreshold: 0.7,
    suitColor: 0x2a3a2a, scale: 1.2, spawnWeight: 0, minWave: 5,
    damageReduction: 0.3, hasShield: true,
  },
};

/** Apply a class config to an enemy + its FSM. */
export function applyClassToEnemy(e: Enemy, fsm: EnemyFSM | undefined, cls: EnemyClass, wave: number) {
  const cfg = ENEMY_CLASSES[cls];
  e.maxHealth = cfg.health + wave * 5; // slight wave scaling
  e.health = e.maxHealth;
  // Section D #1767 — cap the per-wave speed bonus so class differences
  // don't dissolve at high waves. The prior code did `cfg.speed + wave * 0.1`
  // which added 2.0 m/s by wave 20 — a 1.0 m/s Mech would reach 3.0 m/s
  // (faster than a base 2.4 Medic), flattening the class roster. The cap
  // (MAX_SPEED_BONUS = 1.0) preserves class identity: a Mech never gets
  // faster than 2.0 m/s, a Medic never faster than 3.4 m/s, etc.
  const MAX_SPEED_BONUS = 1.0;
  const waveBonus = Math.min(MAX_SPEED_BONUS, wave * 0.1);
  e.speed = cfg.speed + waveBonus;
  e.accuracy = cfg.accuracy;
  e.team = "enemy";
  // Stash class info on userData for damage + killfeed lookup.
  (e as unknown as { enemyClass?: EnemyClass }).enemyClass = cls;
  (e as unknown as { bossClass?: BossClass }).bossClass = undefined;
  (e as unknown as { enemyClassName?: string }).enemyClassName = cfg.name;
  (e as unknown as { isBoss?: boolean }).isBoss = false;
  (e as unknown as { damageReduction?: number }).damageReduction = cfg.damageReduction ?? 0;
  (e as unknown as { hasShield?: boolean }).hasShield = cfg.hasShield ?? false;
  (e as unknown as { reinforcementIntervalSec?: number }).reinforcementIntervalSec = undefined;
  // Scale the mesh.
  e.group.scale.setScalar(cfg.scale);
  // Recolor the suit material.
  const bodyMat = e.body.material as { color?: { setHex: (c: number) => void } };
  bodyMat.color?.setHex(cfg.suitColor);
  // FSM thresholds.
  if (fsm) {
    // Section D #1768 — use the public setThresholds API instead of the
    // prior `fsm as unknown as { attackRange; ... }` private-field bypass.
    // The cast worked but bypassed TypeScript's encapsulation + would
    // silently no-op if the FSM's private field names changed.
    fsm.setThresholds({
      attackRange: cfg.attackRange,
      suppressionThreshold: cfg.suppressionThreshold,
      recoveryThreshold: cfg.suppressionThreshold * 0.33,
    });
    // Section D #1713 — mark the FSM as having had its class applied so the
    // tick method's "missing class throws" guard passes.
    fsm.markClassApplied();
  }
  // Task-12 — SHIELD class: add a visible ballistic-shield mesh so the
  // player can see the shield and learn to flank. The shield's damage-
  // blocking logic is in EnemySystem.damageEnemy (reuses the Task-7
  // boss hasShield mechanic). Tagged userData.enemy + isHead=false so
  // (a) WeaponSystem bullets that hit the shield route through
  // damageEnemy (where the shield reduction applies — NOT absorbed as
  // environment), and (b) EnemySystem.isOccluded skips it (otherwise
  // the shield would block the trooper's own LOS to the player).
  if (cls === "SHIELD") addNormalShieldMesh(e);
}

/**
 * Task-12 — Add a visible ballistic-shield mesh to a SHIELD-class enemy.
 * Tall blue-gray translucent box in front of the trooper + a viewport
 * slit. Tagged as an enemy part (userData.enemy + isHead=false) so
 * bullets route through damageEnemy (where the shield's 80% front-cone
 * reduction applies) and LOS checks skip it. Named "normalShield" so
 * enemy-tactics.ts can find + remove it when the trooper drops the
 * shield at <30% HP.
 */
function addNormalShieldMesh(e: Enemy) {
  // De-dupe: never add twice.
  if ((e.group as unknown as { __shieldMesh?: boolean }).__shieldMesh) return;
  (e.group as unknown as { __shieldMesh?: boolean }).__shieldMesh = true;

  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a2a, emissive: 0x0a0a1a, emissiveIntensity: 0.3,
    metalness: 0.6, roughness: 0.4, transparent: true, opacity: 0.9,
  });
  const shieldGeo = new THREE.BoxGeometry(1.1, 1.45, 0.1);
  const shield = new THREE.Mesh(shieldGeo, shieldMat);
  shield.position.set(0, 0.8, 0.5);
  shield.castShadow = true;
  shield.name = "normalShield";
  shield.userData.enemy = e;
  shield.userData.isHead = false;
  e.group.add(shield);

  // Viewport slit (lighter band across the upper shield).
  // Section D #1725 — parent the slit to the SHIELD mesh (not the enemy
  // group) so it moves with the shield + is removed automatically when
  // the shield is dropped at <30% HP (enemy-tactics.ts find +
  // removeByName("normalShield")). The prior code added the slit as a
  // sibling of the shield (both children of e.group), so when the shield
  // was dropped, the slit lingered as a floating band. Now the slit is a
  // child of the shield — when the shield is removed, the slit goes with it.
  const slitMat = new THREE.MeshStandardMaterial({
    color: 0x4a4a6a, emissive: 0x2a2a4a, emissiveIntensity: 0.3,
  });
  const slitGeo = new THREE.BoxGeometry(0.7, 0.07, 0.04);
  const slit = new THREE.Mesh(slitGeo, slitMat);
  slit.position.set(0, 0.4, 0.06);
  slit.userData.enemy = e;
  slit.userData.isHead = false;
  slit.name = "normalShieldSlit";
  shield.add(slit);
}

/**
 * Task-7 — Apply a boss class config to an enemy + its FSM. Bosses
 * override the normal class: bigger scale, unique color, optional
 * damageReduction / hasShield / reinforcementIntervalSec, and isBoss=true
 * so the kill path can grant bonus score + bigger juice.
 *
 * Bosses still use the same buildHumanoid mesh (Task 3 owns that). We
 * add visual flair by:
 *   - Scaling the group (1.5–1.8×).
 *   - Recoloring the suit material to a distinctive boss tint.
 *   - Adding a small extra mesh (shoulder pauldrons for Juggernaut,
 *     shield box for Riot Shield Captain, antenna for Drone Commander).
 */
export function applyBossToEnemy(e: Enemy, fsm: EnemyFSM | undefined, bossClass: BossClass, wave: number) {
  const cfg = BOSS_CLASSES[bossClass];
  e.maxHealth = cfg.health + wave * 10; // stronger wave scaling for bosses
  e.health = e.maxHealth;
  e.speed = cfg.speed;
  e.accuracy = cfg.accuracy;
  e.team = "enemy";
  // Stash class info on userData for damage + killfeed lookup.
  // We set enemyClass to RIFLEMAN as a sane fallback for enemy-tactics
  // (which switches on EnemyClass). The authoritative config is read
  // via the bossClass field.
  (e as unknown as { enemyClass?: EnemyClass }).enemyClass = "RIFLEMAN";
  (e as unknown as { bossClass?: BossClass }).bossClass = bossClass;
  (e as unknown as { enemyClassName?: string }).enemyClassName = cfg.name;
  (e as unknown as { isBoss?: boolean }).isBoss = true;
  (e as unknown as { damageReduction?: number }).damageReduction = cfg.damageReduction ?? 0;
  (e as unknown as { hasShield?: boolean }).hasShield = cfg.hasShield ?? false;
  (e as unknown as { reinforcementIntervalSec?: number }).reinforcementIntervalSec = cfg.reinforcementIntervalSec;
  (e as unknown as { lastReinforcementAt?: number }).lastReinforcementAt = performance.now();
  // Scale the mesh (bosses are visually larger).
  e.group.scale.setScalar(cfg.scale);
  // Recolor the suit material with the boss tint.
  const bodyMat = e.body.material as { color?: { setHex: (c: number) => void } };
  bodyMat.color?.setHex(cfg.suitColor);
  // FSM thresholds — bosses are fearless (high suppression threshold).
  if (fsm) {
    // Section D #1768 — use the public setThresholds API (no private-field bypass).
    fsm.setThresholds({
      attackRange: cfg.attackRange,
      suppressionThreshold: cfg.suppressionThreshold,
      recoveryThreshold: cfg.suppressionThreshold * 0.33,
    });
    // Section D #1713 — mark the FSM as having had its boss class applied.
    fsm.markClassApplied();
  }
  // Visual flair: add a small distinguishing mesh as a child of the group.
  addBossVisualFlair(e, bossClass);
}

/**
 * Task-7 — Add a small extra mesh to the boss's group so it reads as
 * distinct from normal enemies at a glance. Uses basic geometries +
 * materials — disposed when the group is removed from the scene.
 *
 * IMPORTANT: every flair mesh is tagged with `userData.enemy = e` so
 * (a) the WeaponSystem bullet raycast treats hits on them as enemy
 * hits (applying damage via damageEnemy — the Riot Shield Captain's
 * shield damage reduction logic then runs), and (b) the EnemySystem
 * LOS check skips them (otherwise the shield would block the captain's
 * own LOS to the player). `userData.isHead = false` ensures flair
 * meshes never trigger headshot bonus damage.
 */
function addBossVisualFlair(e: Enemy, bossClass: BossClass) {
  // De-dupe: never add twice (applyBossToEnemy is called once per spawn,
  // but be defensive in case of re-application).
  if ((e.group as unknown as { __bossFlair?: boolean }).__bossFlair) return;
  (e.group as unknown as { __bossFlair?: boolean }).__bossFlair = true;

  /** Tag a flair mesh so bullet raycasts + LOS checks treat it as part of the enemy. */
  const tag = (m: THREE.Mesh) => {
    m.userData.enemy = e;
    m.userData.isHead = false;
  };

  if (bossClass === "JUGGERNAUT") {
    // Shoulder pauldrons — two armored boxes on the shoulders.
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a12, metalness: 0.75, roughness: 0.35,
    });
    const plateGeo = new THREE.BoxGeometry(0.42, 0.32, 0.42);
    const left = new THREE.Mesh(plateGeo, plateMat);
    left.position.set(-0.52, 1.35, 0);
    left.castShadow = true;
    tag(left);
    e.group.add(left);
    const right = new THREE.Mesh(plateGeo, plateMat);
    right.position.set(0.52, 1.35, 0);
    right.castShadow = true;
    tag(right);
    e.group.add(right);
  } else if (bossClass === "FLAMETHROWER_HEAVY") {
    // Twin fuel tanks on the back — warm ember emissive.
    const tankMat = new THREE.MeshStandardMaterial({
      color: 0x4a1a05, emissive: 0x3a0a02, emissiveIntensity: 0.4,
      metalness: 0.4, roughness: 0.5,
    });
    const tankGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.6, 12);
    const lt = new THREE.Mesh(tankGeo, tankMat);
    lt.position.set(-0.28, 1.25, -0.25);
    lt.castShadow = true;
    tag(lt);
    e.group.add(lt);
    const rt = new THREE.Mesh(tankGeo, tankMat);
    rt.position.set(0.28, 1.25, -0.25);
    rt.castShadow = true;
    tag(rt);
    e.group.add(rt);
  } else if (bossClass === "ARMORED_MECH") {
    // Heavy chest plate + head crest — bulkier silhouette.
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0x303038, metalness: 0.85, roughness: 0.25,
    });
    const plateGeo = new THREE.BoxGeometry(0.7, 0.55, 0.45);
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.set(0, 1.3, 0.05);
    plate.castShadow = true;
    tag(plate);
    e.group.add(plate);
    // Crest on head.
    const crestGeo = new THREE.BoxGeometry(0.15, 0.18, 0.4);
    const crest = new THREE.Mesh(crestGeo, plateMat);
    crest.position.set(0, 1.78, 0);
    tag(crest);
    e.group.add(crest);
  } else if (bossClass === "DRONE_COMMANDER") {
    // Antenna + small drone orb hovering above the right shoulder.
    const antMat = new THREE.MeshStandardMaterial({
      color: 0x2a4a6a, emissive: 0x102030, emissiveIntensity: 0.5,
      metalness: 0.6, roughness: 0.4,
    });
    const antGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6);
    const ant = new THREE.Mesh(antGeo, antMat);
    ant.position.set(0.4, 1.85, -0.1);
    tag(ant);
    e.group.add(ant);
    // Red blinking orb at the antenna tip — drone commander signature.
    const orbMat = new THREE.MeshStandardMaterial({
      color: 0xff3018, emissive: 0xff2010, emissiveIntensity: 1.0,
    });
    const orbGeo = new THREE.SphereGeometry(0.06, 8, 8);
    const orb = new THREE.Mesh(orbGeo, orbMat);
    orb.position.set(0.4, 2.1, -0.1);
    orb.name = "bossDroneOrb";
    tag(orb);
    e.group.add(orb);
  } else if (bossClass === "RIOT_SHIELD_CAPTAIN") {
    // Ballistic shield — a tall green-tinted box in front of the captain.
    // The shield's damage-blocking logic is in EnemySystem.damageEnemy
    // (checks the angle between the player and the enemy's facing).
    // The mesh itself is tagged as an enemy part so bullets that hit it
    // route through damageEnemy (where the shield reduction applies) —
    // NOT as environment (which would absorb the bullet for free).
    const shieldMat = new THREE.MeshStandardMaterial({
      color: 0x1a2a1a, emissive: 0x0a1a0a, emissiveIntensity: 0.35,
      metalness: 0.55, roughness: 0.4, transparent: true, opacity: 0.92,
    });
    const shieldGeo = new THREE.BoxGeometry(1.4, 1.7, 0.12);
    const shield = new THREE.Mesh(shieldGeo, shieldMat);
    shield.position.set(0, 0.95, 0.55);
    shield.castShadow = true;
    shield.name = "bossShield";
    tag(shield);
    e.group.add(shield);
    // Small viewport slit (lighter band across the upper shield).
    const slitMat = new THREE.MeshStandardMaterial({
      color: 0x6a8a6a, emissive: 0x2a4a2a, emissiveIntensity: 0.3,
    });
    const slitGeo = new THREE.BoxGeometry(0.9, 0.08, 0.04);
    const slit = new THREE.Mesh(slitGeo, slitMat);
    slit.position.set(0, 1.4, 0.62);
    tag(slit);
    e.group.add(slit);
  }
}

/**
 * Task-7 — Unified class-config lookup. Returns the BossClassConfig if
 * the enemy is a boss, else the EnemyClassConfig, else null. Used by
 * EnemySystem.enemyShoot to read damageRange / caliber / shotCooldown
 * without caring whether the enemy is a boss or normal class.
 */
export function getEnemyClassConfig(e: Enemy): EnemyClassConfig | null {
  const bossClass = (e as unknown as { bossClass?: BossClass }).bossClass;
  if (bossClass) return BOSS_CLASSES[bossClass];
  const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
  if (cls) return ENEMY_CLASSES[cls];
  return null;
}

/**
 * Pick a random enemy class for spawning, weighted by spawnWeight + minWave.
 * Higher waves unlock more dangerous classes.
 *
 * G4.2 — `dangerSpawnMult` scales the spawn weight of elite classes
 * (MG/SNIPER/COMMANDER) so Hard difficulty throws more of them at the player.
 *
 * Task-7 — `customWeights` overrides the per-class spawnWeight (used by
 * WAVE_THEMES to bias a wave's class distribution, e.g. SNIPERS wave is
 * mostly SNIPER + a few RIFLEMAN escorts). When a class isn't in
 * customWeights, falls back to its ENEMY_CLASSES spawnWeight.
 */
export function rollEnemyClass(
  wave: number,
  dangerSpawnMult: number = 1,
  customWeights?: Partial<Record<EnemyClass, number>>,
): EnemyClass {
  const eligible = (Object.keys(ENEMY_CLASSES) as EnemyClass[])
    .filter((c) => wave >= ENEMY_CLASSES[c].minWave);
  // Task-12 — isDangerous marks classes that should scale up with the
  // difficulty's dangerSpawnMult (Hard throws more of them). MEDIC +
  // SHIELD + SHOTGUNNER are dangerous (high-impact). SCOUT is fodder
  // (fast but fragile — spawns in numbers, doesn't scale). ZOMBIE has
  // spawnWeight 0 (exclusively spawned via the ZOMBIES-mode override),
  // so its danger flag is moot — listed for completeness.
  const isDangerous = (c: EnemyClass) =>
    c === "MG" ||
    c === "SNIPER" ||
    c === "COMMANDER" ||
    c === "MEDIC" ||
    c === "SHIELD" ||
    c === "SHOTGUNNER";
  const weights = eligible.map((c) => {
    const baseW = customWeights?.[c] ?? ENEMY_CLASSES[c].spawnWeight;
    return isDangerous(c) ? baseW * dangerSpawnMult : baseW;
  });
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) {
    // Section D #1769 — warn on the silent RIFLEMAN fallback. The prior
    // code returned "RIFLEMAN" silently when no classes were eligible
    // (e.g. a wave-theme with customWeights that all resolved to 0), which
    // masked spawn-config bugs. The warn fires once per call so the dev
    // console shows the wave + eligible-class count for diagnosis.
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        `[rollEnemyClass] no eligible classes for wave ${wave} (eligible=${eligible.length}, ` +
        `customWeights=${customWeights ? Object.keys(customWeights).length : "none"}) — falling back to RIFLEMAN`,
      );
    }
    return "RIFLEMAN";
  }
  let r = Math.random() * totalWeight;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i];
    if (r <= 0) return eligible[i];
  }
  // Section D #1769 — warn on the unreachable final fallback (floating-point
  // rounding could in theory land here).
  if (typeof console !== "undefined" && console.warn) {
    console.warn(`[rollEnemyClass] exhaustive-pick fallback (rounding) — returning RIFLEMAN`);
  }
  return "RIFLEMAN";
}

/** Get the class name for killfeed display. */
export function getEnemyClassName(e: Enemy): string {
  return (e as unknown as { enemyClassName?: string }).enemyClassName ?? "Hostile";
}

/** Task-7 — Is this enemy a boss? */
export function isBossEnemy(e: Enemy): boolean {
  return (e as unknown as { isBoss?: boolean }).isBoss === true;
}
