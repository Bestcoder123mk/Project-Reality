import * as THREE from "three";
import type { GameSystem, GameContext, Enemy, EnemyState } from "./types";
import { maybeTriggerFinisherOnKill } from "./FinisherSystem";
import { buildHumanoid, animateGait } from "./utils";
import { classifyHitZone } from "./Ballistics";
// Task 3 / item 59 — scoped env-raycast cache (replaces scene.children, true).
import { getEnvRaycastTargets } from "./raycast-env";
import { useGameStore } from "../store";
import { EnemyFSM } from "../fsm/EnemyFSM";
import { tickSuppressed, tickFlank, tickChase, tickAttackMaintainRange, tickFlee, tickZombieMelee } from "./enemy-tactics";
import { onFsmTransition, emitBark } from "../ai/barks";
import {
  applyClassToEnemy, applyBossToEnemy, rollEnemyClass, getEnemyClassName,
  getEnemyClassConfig, isBossEnemy,
  BOSS_CLASSES, type EnemyClass,
} from "../EnemyClasses";
import {
  enemiesForWave, isVictoryWave, type GameMode,
  getWaveTheme, getBossForWave,
} from "../GameModes";
import { getDifficultyConfig, aiCanReact, aiEffectiveAccuracy } from "../Difficulty";
import { isNight } from "../realism";
import { preFracture, activateShards } from "../physics/VoronoiFracture";
// Section F — AI orchestrator (new Section F subsystems: learning AI,
// morale, boss phases, cover system, etc.). The orchestrator is a no-op
// until the engine calls initAIOrchestrator(ctx) on match start; the tick
// is guarded so it's safe even if the orchestrator isn't initialized.
import { tickAIOrchestrator } from "../ai/ai-orchestrator";

/**
 * Task-9 (Prompt #84) — Day/night AI detection range.
 *
 * Base sight range (meters). 80m covers the full play area (walls at ±45)
 * during the day so IDLE enemies can spot the player from any spawn point
 * with clear LOS. At night, this is multiplied by NIGHT_SIGHT_MULT (0.6 →
 * 48m) — enemies in the far corners of the map can no longer see the
 * player until they close distance, giving the player more time to set up
 * ambushes at night (the spec's "AI see 40% less far" requirement).
 */
const BASE_SIGHT_RANGE_M = 80;
/** Night sight-range multiplier (0.6 = 40% reduction per spec). */
const NIGHT_SIGHT_MULT = 0.6;

// ───────────────────────────────────────────────────────────────────────────
// Section D #1750 — per-class magazine size + reload duration.
// ───────────────────────────────────────────────────────────────────────────
// Replaces the prior hardcoded MAG_SIZE=7 + RELOAD_MS=1500 with per-class
// values that match the class's weapon profile (MG has a 50-round belt,
// Sniper has a 5-round mag, etc.). Read by EnemySystem.update's reload
// gate so each class reloads at the right cadence.
const CLASS_MAG_SIZE: Partial<Record<EnemyClass, number>> = {
  RIFLEMAN: 30,    // standard 30-round STANAG mag
  SNIPER: 5,       // 5-round bolt-action mag
  MG: 50,          // 50-round belt
  CQB: 12,         // 12-gauge pump (5+1) — using 12 for stagger
  COMMANDER: 30,   // rifle mag (commander carries a rifle)
  ZOMBIE: 9999,    // never reloads (melee only — value is moot)
  MEDIC: 12,       // pistol mag
  SHIELD: 15,      // pistol mag (extended)
  SCOUT: 25,       // SMG mag
  SHOTGUNNER: 6,   // 6-shell tube
};

const CLASS_RELOAD_MS: Partial<Record<EnemyClass, number>> = {
  RIFLEMAN: 1500,
  SNIPER: 2500,    // bolt-action reload is slower
  MG: 3500,        // belt reload is slowest
  CQB: 1200,       // shotgun reload is fast (per-shell, but simplified)
  COMMANDER: 1500,
  ZOMBIE: 99999,   // never reloads
  MEDIC: 1200,     // pistol reload
  SHIELD: 1200,
  SCOUT: 1100,     // SMG reload is fast
  SHOTGUNNER: 1800,
};

// ───────────────────────────────────────────────────────────────────────────
// Section D #1761 — per-class accuracy falloff distance (meters).
// ───────────────────────────────────────────────────────────────────────────
// Replaces the prior uniform `1 - dist / 50` falloff. Snipers stay
// accurate at long range (100m falloff), MGs falloff fast (30m — they're
// suppressive, not precision), CQB/Shotgunners falloff extremely fast
// (their damage is meant to be close-range only).
const CLASS_FALLOFF_DIST: Partial<Record<EnemyClass, number>> = {
  RIFLEMAN: 50,
  SNIPER: 100,     // snipers maintain accuracy at long range
  MG: 30,          // MGs are suppressive — accuracy falls off fast
  CQB: 25,         // CQB is close-range only
  COMMANDER: 60,   // commander has a slightly better rifle
  ZOMBIE: 999,     // zombies never shoot (moot)
  MEDIC: 35,       // pistol — short range
  SHIELD: 30,      // pistol — short range
  SCOUT: 40,       // SMG — mid range
  SHOTGUNNER: 15,  // shotgun — very short range
};

/**
 * EnemySystem — owns enemy spawn, AI update (idle/chase/attack/dead),
 * gait animation, head tracking, shooting, hit flash, death, and removal.
 */
export class EnemySystem implements GameSystem {
  constructor(private ctx: GameContext) {}

  buildEnemy(spawnPos: THREE.Vector3): Enemy {
    const { ctx } = this;
    // Enemy operators wear a darker, hostile-colored tactical suit (dark red/maroon).
    const built = buildHumanoid(0x4a2030);
    built.group.position.copy(spawnPos);
    ctx.scene.add(built.group);
    const e: Enemy = {
      group: built.group,
      head: built.parts.head,
      body: built.parts.body,
      parts: built.parts,
      health: 100, maxHealth: 100, alive: true, velocity: new THREE.Vector3(),
      // V6 — unique ID for the cognition system (perception snapshots +
      // memory stores). Generated from spawn position + timestamp so it's
      // unique across spawns within a match.
      id: `enemy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      state: "idle", lastShot: 0, hitFlash: 0, deadTime: 0,
      spawnPos: spawnPos.clone(), team: "enemy",
      speed: 1.8 + Math.random() * 0.8, accuracy: 0.35 + Math.random() * 0.15,
      gaitPhase: Math.random() * Math.PI * 2, lookAtTarget: 0,
      lastDamagedTime: 0, className: "HOSTILE",
      // Prompt #53 — per-enemy suppression starts at 0. Bumped by player
      // bullets whizzing past (ProjectileSystem → ctx.addEnemySuppression);
      // decays in SuppressionSystem.update. Drives the FSM SUPPRESSED state.
      suppression: 0, crouching: false,
    };
    // P2.2: attach a per-enemy FSM (authoritative state).
    e.fsm = new EnemyFSM(e);
    // Prompt #46 — proper hitbox zones. Each part is tagged with a `hitZone`
    // string ("head" | "chest" | "limb") computed from its name in the rig.
    // WeaponSystem.fireRay / ProjectileSystem read `hitZone` to apply the
    // correct damage multiplier (head 4×, chest 1×, limb 0.7×). The legacy
    // `isHead` boolean is derived from the zone so existing hit-flash +
    // hit-marker logic keeps working.
    const parts: THREE.Mesh[] = Object.values(built.parts);
    for (const p of parts) {
      p.userData.enemy = e;
      p.userData.hitZone = "chest"; // safe default — overwritten below
      p.userData.isHead = false;
    }
    for (const [name, mesh] of Object.entries(built.parts)) {
      const zone = classifyHitZone(name);
      mesh.userData.hitZone = zone;
      mesh.userData.isHead = zone === "head";
    }
    built.group.userData.parts = parts;
    // Section D #1774 — spawn protection. Apply 3s invulnerability on
    // freshly built enemies so they don't get instakilled by a camping
    // player the moment they appear. The damage system reads
    // `e.spawnProtectedUntil` + skips damage while `performance.now() <
    // spawnProtectedUntil`. Cleared after 3s (SPAWN_PROTECTION_MS in
    // spawn-logic.ts). Medic-revived enemies DON'T go through buildEnemy,
    // so they don't get re-protection (they're already in combat).
    try {
      // Lazy-import to avoid a hard dependency at module load.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const spawnLogic = require("../level/spawn-logic") as typeof import("../level/spawn-logic");
      spawnLogic.applySpawnProtection(e as unknown as { spawnProtectedUntil?: number });
    } catch {
      // spawn-logic not available (SSR / pre-init) — apply directly.
      (e as unknown as Record<string, unknown>).spawnProtectedUntil =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) + 3000;
    }
    return e;
  }

  startWave(wave: number) {
    const { ctx } = this;
    const mode = ctx.match.mode as GameMode;
    ctx.match.wave = wave;

    // Task-15 — PRACTICE_RANGE: sandbox mode. No enemies, no wave system —
    // the player just shoots static target silhouettes to test weapons.
    // Skip the entire spawn/themed-wave/boss-wave flow. The HUD objective
    // tells the player how to exit (ESC), since there's no win condition.
    if (mode === "PRACTICE_RANGE") {
      ctx.match.enemiesPerWave = 0;
      ctx.match.totalEnemiesThisWave = 0;
      ctx.match.enemiesRemaining = 0;
      ctx.pushHud({
        wave,
        enemiesRemaining: 0,
        totalEnemies: 0,
        objective: "PRACTICE RANGE — shoot the targets. Press ESC to exit.",
      });
      return;
    }

    // Task-15 — ZOMBIES: endless waves of melee-only zombies. Override the
    // normal wave theme system — all spawns are the ZOMBIE class (no bosses,
    // no themed escorts). Zombies spawn in numbers (enemiesBase 8 + 3/wave)
    // because they're individually weak (60 HP, no ranged). They're
    // force-spawned into CHASE so they immediately rush the player from all
    // directions — COD-Zombies style "they always know where you are".
    if (mode === "ZOMBIES") {
      const diffCfg = getDifficultyConfig(useGameStore.getState().settings.difficulty);
      let count = enemiesForWave(mode, wave);
      const aliveNow = ctx.enemies.filter((e) => e.alive).length;
      const cap = ctx.match.concurrentEnemyCap;
      if (aliveNow + count > cap) count = Math.max(0, cap - aliveNow);
      ctx.match.enemiesPerWave = count;
      ctx.match.totalEnemiesThisWave = count;
      ctx.match.enemiesRemaining = count;
      const spawnPoints = this.getSpawnPoints(count);
      for (const sp of spawnPoints) {
        const e = this.buildEnemy(sp);
        applyClassToEnemy(e, e.fsm, "ZOMBIE", wave);
        e.maxHealth = Math.round(e.maxHealth * diffCfg.healthMult);
        e.health = e.maxHealth;
        // Accuracy stays 0 — zombies never shoot. (Don't apply diffCfg.accuracyMult.)
        e.accuracy = 0;
        (e as unknown as { damageMult?: number }).damageMult = diffCfg.damageMult;
        e.className = "UNDEAD";
        // Force-spot the player so the zombie starts chasing immediately
        // (skips the IDLE→CHASE contact dance — zombies always know where
        // you are). EnemySystem.update's isZombie branch bypasses the FSM
        // tick anyway, but forcing CHASE here keeps the FSM state consistent
        // for any external readers (minimap, recon drone markers, etc.).
        e.fsm?.send("spotPlayer");
        (e as unknown as { firstSeenAt?: number }).firstSeenAt = performance.now();
        ctx.enemies.push(e);
      }
      ctx.pushHud({
        wave,
        enemiesRemaining: ctx.match.enemiesRemaining,
        totalEnemies: ctx.match.totalEnemiesThisWave,
        objective: `WAVE ${wave} — ${count} UNDEAD`,
      });
      ctx.addKillFeed({
        killer: "SYSTEM",
        victim: `Wave ${wave} — ${count} undead incoming`,
        weapon: "", headshot: false,
      });
      return;
    }

    // Task-7 — wave theme + boss wave selection.
    const theme = getWaveTheme(wave);
    const bossClass = getBossForWave(wave);
    const isBossWaveFlag = bossClass !== null;

    // G1.1 — enemiesForWave() is the base spawn count for the mode.
    // Task-7 — boss waves override: 1 boss + a small themed escort
    // (3 + 1 per 10 waves, capped to keep the concurrent budget sane).
    let count: number;
    if (isBossWaveFlag) {
      const escortBase = 3 + Math.floor(wave / 10); // wave 5 → 3, wave 15 → 4, wave 25 → 5
      count = 1 + escortBase;
    } else {
      count = enemiesForWave(mode, wave);
    }
    // G1.5 — HORDE/EXTRACTION: cap concurrent alive enemies so the renderer
    // never holds more than it can handle. Score/wave keeps climbing; only
    // the concurrent count is bounded. Difficulty plateaus, not climbs forever.
    const aliveNow = ctx.enemies.filter((e) => e.alive).length;
    const cap = ctx.match.concurrentEnemyCap;
    if (aliveNow + count > cap) {
      count = Math.max(isBossWaveFlag ? 1 : 0, cap - aliveNow);
    }
    ctx.match.enemiesPerWave = count;
    ctx.match.totalEnemiesThisWave = count;
    ctx.match.enemiesRemaining = count;
    const spawnPoints = this.getSpawnPoints(count);
    // G4.2 — read the difficulty setting + apply multipliers to enemy stats.
    const diffCfg = getDifficultyConfig(useGameStore.getState().settings.difficulty);

    if (isBossWaveFlag && bossClass) {
      // ---- Boss wave: spawn 1 boss at spawnPoints[0], escorts after. ----
      const bossSpawn = spawnPoints[0] ?? new THREE.Vector3(0, 0, -40);
      const boss = this.buildEnemy(bossSpawn);
      applyBossToEnemy(boss, boss.fsm, bossClass, wave);
      // G4.2 — apply difficulty multipliers on top of the boss base stats.
      boss.maxHealth = Math.round(boss.maxHealth * diffCfg.healthMult);
      boss.health = boss.maxHealth;
      boss.accuracy = Math.min(0.95, boss.accuracy * diffCfg.accuracyMult);
      (boss as unknown as { damageMult?: number }).damageMult = diffCfg.damageMult;
      boss.className = BOSS_CLASSES[bossClass].name.toUpperCase();
      ctx.enemies.push(boss);

      // Themed escorts use the wave theme's class weights.
      for (let i = 1; i < count; i++) {
        const e = this.buildEnemy(spawnPoints[i]);
        const cls = rollEnemyClass(wave, diffCfg.dangerSpawnMult, theme.classWeights);
        applyClassToEnemy(e, e.fsm, cls, wave);
        e.maxHealth = Math.round(e.maxHealth * diffCfg.healthMult);
        e.health = e.maxHealth;
        e.accuracy = Math.min(0.95, e.accuracy * diffCfg.accuracyMult);
        (e as unknown as { damageMult?: number }).damageMult = diffCfg.damageMult;
        e.className = getEnemyClassName(e).toUpperCase();
        ctx.enemies.push(e);
      }

      // Boss spawn flourish — alert + shake + killfeed.
      const bossName = BOSS_CLASSES[bossClass].name.toUpperCase();
      ctx.triggerShake(0.3);
      ctx.addKillFeed({
        killer: "⚠ BOSS", victim: bossName, weapon: "incoming", headshot: false,
      });
      ctx.pushHud({
        wave,
        enemiesRemaining: ctx.match.enemiesRemaining,
        totalEnemies: ctx.match.totalEnemiesThisWave,
        objective: `WAVE ${wave} — ⚠ BOSS: ${bossName} (${theme.name} ESCORT)`,
      });
      ctx.addKillFeed({
        killer: "SYSTEM",
        victim: `Wave ${wave} — ${theme.name} escort incoming`,
        weapon: "", headshot: false,
      });
    } else {
      // ---- Normal themed wave: spawn the themed mix. ----
      for (const sp of spawnPoints) {
        const e = this.buildEnemy(sp);
        // Task-7 — use the wave theme's class weights instead of the
        // default rollEnemyClass weights (so SNIPERS wave is mostly
        // snipers, FLANKERS wave is mostly CQB, etc.).
        const cls = rollEnemyClass(wave, diffCfg.dangerSpawnMult, theme.classWeights);
        applyClassToEnemy(e, e.fsm, cls, wave);
        // G4.2 — apply difficulty multipliers on top of the class base stats.
        e.maxHealth = Math.round(e.maxHealth * diffCfg.healthMult);
        e.health = e.maxHealth;
        e.accuracy = Math.min(0.95, e.accuracy * diffCfg.accuracyMult);
        // Stash the damage multiplier for enemyShoot to apply.
        (e as unknown as { damageMult?: number }).damageMult = diffCfg.damageMult;
        // V2.3 — surface the class name for the on-spot nameplate.
        // Section D #1770 — keep title-case (the prior code .toUpperCase()'d
        // the class name, producing "RIFLEMAN" / "SNIPER" / "SHOTGUNNER" —
        // shouty + inconsistent with the title-case names used everywhere
        // else: EnemyClasses cfg.name ("Rifleman"), killfeed, barks, etc.
        // Title-case matches the rest of the UI.
        e.className = getEnemyClassName(e);
        ctx.enemies.push(e);
      }
      // Task-7 — HUD objective shows the wave theme name (e.g.
      // "WAVE 3 — HEAVY ARMOR") so the player knows what's coming.
      const objective = `WAVE ${wave} — ${theme.name}`;
      ctx.pushHud({
        wave, enemiesRemaining: ctx.match.enemiesRemaining,
        totalEnemies: ctx.match.totalEnemiesThisWave, objective,
      });
      ctx.addKillFeed({
        killer: "SYSTEM", victim: `Wave ${wave} — ${theme.name} incoming`,
        weapon: "", headshot: false,
      });
    }
  }

  private getSpawnPoints(n: number): THREE.Vector3[] {
    // Section D #1771 + #1792 — spawn-logic.ts integration. The prior code
    // returned a fixed 10-point list + cycled (`cands[i % cands.length]`)
    // which stacked enemies on the same point when n > 10 (#1772). Now we
    // delegate to spawn-logic.ts's selectSpawns (which uses the current
    // map's enemySpawns list + the anti-camping filter + the LOS-cone
    // bias). Falls back to the legacy fixed-point list when:
    //   - the store doesn't have a selectedMap (SSR / pre-init),
    //   - the map has no enemySpawns,
    //   - spawn-logic returns fewer than n spawns.
    // The fallback ALSO deduplicates (adds jitter so stacked spawns don't
    // overlap) so #1772 is fixed in both paths.
    const mapSlug = (typeof useGameStore !== "undefined" && useGameStore.getState?.().selectedMap) || "";
    if (mapSlug) {
      try {
        // Lazy-import to avoid a hard dependency at module load (spawn-logic
        // imports MapValidator which is heavy).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const spawnLogic = require("../level/spawn-logic") as typeof import("../level/spawn-logic");
        const playerPos = this.ctx.player.pos;
        const playerYaw = this.ctx.player.yaw;
        // Maintain a per-EnemySystem recent-spawns list (pruned each call).
        if (!this._recentSpawns) this._recentSpawns = [];
        spawnLogic.pruneRecentSpawns(this._recentSpawns);
        // Section D #1793 — class-aware spawn. Snipers should spawn far from
        // the player (they're long-range). We don't know the class at
        // getSpawnPoints time (the caller rolls the class AFTER), so we
        // bias the whole wave toward far spawns (the bias helps snipers
        // + doesn't hurt other classes — they just spawn a bit farther).
        const spawns = spawnLogic.selectSpawns(
          mapSlug, playerPos, this._recentSpawns, playerYaw, n,
          { farPlayerDist: 35, minPlayerDist: 15 },
        );
        if (spawns.length >= Math.min(n, 1)) {
          return spawns.map((s) => new THREE.Vector3(s[0], s[1], s[2]));
        }
      } catch {
        // Fall through to legacy.
      }
    }
    // Legacy fallback — fixed 10-point list + jitter to prevent stacking.
    const cands: THREE.Vector3[] = [
      new THREE.Vector3(-38, 0, -38), new THREE.Vector3(38, 0, -38), new THREE.Vector3(-38, 0, 38), new THREE.Vector3(38, 0, 38),
      new THREE.Vector3(0, 0, -40), new THREE.Vector3(0, 0, 40), new THREE.Vector3(-40, 0, 0), new THREE.Vector3(40, 0, 0),
      new THREE.Vector3(-30, 0, 30), new THREE.Vector3(30, 0, -30),
    ];
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const base = cands[i % cands.length].clone();
      // Section D #1772 — n>10 stacking. The prior code stacked enemies on
      // the same point when n > 10 (cands has 10 entries). Now we add a
      // per-spawn jitter (1.5m radius) so stacked spawns don't overlap.
      // The jitter is deterministic via index (no RNG) so spawns are stable
      // across reloads.
      if (i >= cands.length) {
        const jitterAngle = (i * 0.7) % (Math.PI * 2);
        const jitterR = 1.5 + (i % 3) * 0.5;
        base.x += Math.cos(jitterAngle) * jitterR;
        base.z += Math.sin(jitterAngle) * jitterR;
      }
      pts.push(base);
    }
    return pts;
  }

  /** Section D #1771 — recent-spawn positions for spawn-logic's anti-stacking
   *  filter. Lazy-initialized on first getSpawnPoints call. */
  private _recentSpawns: import("../level/spawn-logic").RecentSpawn[] | null = null;

  update(dt: number) {
    const { ctx } = this;
    // Task-9 (Prompt #33) — Always tick fracture shards (even during wave
    // transitions / practice range / match-over) so they continue to fall
    // + fade + despawn. Runs before the early-return checks below so
    // visual continuity is preserved across state transitions.
    this.updateShards(dt);
    if (ctx.match.matchOver || ctx.match.waveTransitioning) return;
    // Task-15 — PRACTICE_RANGE: no enemies exist in this mode (startWave
    // spawns 0), so the per-enemy loop + commander coordination + boss
    // reinforcement tick are all no-ops. Skip them entirely to save the
    // per-frame iteration overhead (and to make the intent explicit).
    if ((ctx.match.mode as GameMode) === "PRACTICE_RANGE") return;
    const now = performance.now();
    // Section D #1756 — rebuild the collider spatial hash once per tick
    // (before the per-enemy loop) so enemyCollides is O(1) average. Cheap
    // (one pass over ctx.colliders ~100 items) — pays for itself in the
    // 30-enemy loop that follows.
    this._rebuildColliderGrid();
    for (const e of ctx.enemies) {
      if (!e.alive) {
        if (now - e.deadTime > 6000) { e.group.position.y -= dt * 0.2; if (e.group.position.y < -2) ctx.scene.remove(e.group); }
        continue;
      }
      // Section D #1745 — shared scratch corruption. The prior code used
      // ctx.scratch.v1.copy(ctx.player.pos).sub(e.group.position) which
      // mutated the shared scratch vector — if any per-enemy sub-system
      // (enemy-tactics, etc.) also used ctx.scratch.v1 in the same frame,
      // the value would be corrupted. Now we use a per-iteration local
      // Vector3 (allocated once per enemy per frame, ~30 allocs/frame at
      // 30 enemies = negligible GC vs the corruption bug).
      const toPlayer = ctx.player.pos.clone().sub(e.group.position);
      toPlayer.y = 0;
      const dist = toPlayer.length();
      toPlayer.normalize();
      const targetAngle = Math.atan2(toPlayer.x, toPlayer.z);
      e.group.rotation.y = THREE.MathUtils.damp(e.group.rotation.y, targetAngle, 8, dt);

      // Task-15 — ZOMBIE class: bypass the FSM entirely. Zombies never
      // suppress, take cover, or flee — they always rush the player + claw
      // swipe at 2m. The melee attack routes through onApplyDamageToPlayer
      // (same path as enemyShoot — armor absorption, HUD damage flash, and
      // the directional damage indicator all fire correctly).
      const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
      const isZombie = cls === "ZOMBIE";
      // Section D #1746 — `running` was computed BEFORE the FSM tick, so the
      // gait animation used the pre-tick distance even after the FSM
      // transitioned the enemy to a new state (e.g. CHASE→ATTACK at close
      // range would still animate as "running" because dist was > 12 when
      // it was measured). Now we compute `running` AFTER the FSM tick so
      // the gait matches the post-tick state. The variable is declared
      // here (without a value) + assigned after the tick; the zombie
      // branch sets it directly (zombies always run).
      let running: boolean;
      const collidesFn = (en: Enemy) => this.enemyCollides(en);

      if (isZombie) {
        // Zombie: skip the FSM tick, tactic dispatch, and shooting. The
        // zombie's "attack" is a melee swipe (handled inside tickZombieMelee
        // via meleeFn → onApplyDamageToPlayer). e.state is set to "chase"
        // so the gait animation runs + any external state readers (minimap,
        // recon drone markers) see the zombie as actively pursuing.
        e.state = "chase";
        running = dist > 6; // zombies always rush — running threshold lower.
        const meleeFn = (dmg: number, hitLoc?: "torso" | "limb" | "head") =>
          this.onApplyDamageToPlayer?.(dmg, hitLoc, e.group.position.clone());
        tickZombieMelee(ctx, e, dt, dist, toPlayer, collidesFn, meleeFn);
      } else {
        // P2.2: tick the FSM with current tactical situation.
        // LOS check: raycast from enemy chest to player. isOccluded() filters
        // out enemy meshes so the enemy's own body doesn't block LOS.
        // Task-9 (Prompt #84) — Day/night affects AI detection range. At
        // night (tod < 6 or > 18), enemies see 40% less far — their sight
        // range is multiplied by 0.6 (BASE_SIGHT_RANGE_M=80 → 48m at night).
        // The raycast LOS check is skipped entirely when the player is beyond
        // the sight range, so the FSM's IDLE→CHASE "spotPlayer" transition
        // can't fire from outside the (night-reduced) detection envelope.
        // Once an enemy HAS spotted the player (CHASE/ATTACK/FLANK), the
        // sight range no longer applies — they maintain tracking via the
        // FSM's existing LOS/memory logic (a spotted player who runs into
        // the dark doesn't instantly vanish).
        const inDetectionState =
          e.fsm?.state === "IDLE" || e.fsm?.state === "PATROL";
        let hasLOS: boolean;
        if (inDetectionState) {
          // A3-5000 #511: perception throttle — LOS check every frame for every
          // enemy was 1800 raycasts/sec. We throttle to ~10Hz per enemy using
          // a per-enemy clock (stored on the enemy's AI extra state). The
          // state machine still sees a fresh LOS reading ~10×/sec which is
          // well above the FSM's transition rate.
          const ai = (e as unknown as { _lastLOSCheckAt?: number });
          const now = performance.now();
          const PERCEPTION_INTERVAL_MS = 100; // 10 Hz
          if (ai._lastLOSCheckAt !== undefined && now - ai._lastLOSCheckAt < PERCEPTION_INTERVAL_MS) {
            // Reuse the last LOS result (cached on the enemy).
            hasLOS = (e as unknown as { _cachedLOS?: boolean })._cachedLOS ?? false;
          } else {
            ai._lastLOSCheckAt = now;
            const night = isNight(ctx.weather.timeOfDay);
            const sightRange = night
              ? BASE_SIGHT_RANGE_M * NIGHT_SIGHT_MULT
              : BASE_SIGHT_RANGE_M;
            hasLOS = dist <= sightRange && !this.isOccluded(
              new THREE.Vector3(e.group.position.x, 1.2, e.group.position.z),
              ctx.player.pos,
            );
            (e as unknown as { _cachedLOS?: boolean })._cachedLOS = hasLOS;
          }
        } else {
          hasLOS = !this.isOccluded(
            new THREE.Vector3(e.group.position.x, 1.2, e.group.position.z),
            ctx.player.pos,
          );
        }
        // G3.2 — capture the pre-tick FSM state to detect IDLE→CHASE transitions
        // (for contact call-outs).
        const prevState = e.fsm?.state ?? "IDLE";
        // G3.3 — count nearby living allies for the morale-break check.
        // Section D #1747 — nearbyAllies breaks at 1. The prior code did
        // `if (nearbyAllies >= 1) break;` so the count was always 0 or 1.
        // The FSM's morale-break check needs the ACTUAL count (it uses
        // `allies === 0` for the break, so 0 vs 1 is the only meaningful
        // distinction — but the variable was named "Count" which lied
        // about its semantics). Now we return the actual count (no break)
        // + add a separate `hasNearbyAlly` flag for the early-exit fast
        // path. The FSM contract is unchanged (it still treats allies===0
        // as "alone"), but the field is honest about its value. Perf:
        // the loop is still O(N) per enemy (N=enemies), so N² total — but
        // the early-exit on the fast path is preserved via `hasNearbyAlly`.
        let nearbyAllies = 0;
        let hasNearbyAlly = false;
        for (const ally of ctx.enemies) {
          if (ally === e || !ally.alive) continue;
          const ad = Math.hypot(
            ally.group.position.x - e.group.position.x,
            ally.group.position.z - e.group.position.z,
          );
          if (ad < 15) {
            nearbyAllies++;
            if (!hasNearbyAlly) hasNearbyAlly = true;
          }
        }
        // Avoid unused-var warning — `hasNearbyAlly` is exposed for
        // future FSM hooks that want a fast "any ally?" check without
        // scanning the full count.
        void hasNearbyAlly;
        e.fsm?.tick({
          // Prompt #53 — pass the PER-ENEMY suppression scalar (not the
          // player's ctx.suppression.value). The FSM transitions to SUPPRESSED
          // when this crosses the per-class suppressionThreshold (default 0.6).
          // Player bullets whizzing past the enemy bump e.suppression via
          // ctx.addEnemySuppression (wired in engine-wiring.ts).
          distToPlayer: dist, hasLOS, enemySuppression: e.suppression ?? 0,
          health: e.health, maxHealth: e.maxHealth,
          flankChance: dist > 12 && dist < 25 ? 0.0008 : 0,
          nearbyAllyCount: nearbyAllies,
        });
        // G3.2 — Contact call-out: if this enemy just transitioned IDLE→CHASE
        // (spotted the player), nearby IDLE enemies without LOS get a chance to
        // transition straight to CHASE (simulates a shouted callout).
        const newState = e.fsm?.state ?? "IDLE";
        if (prevState === "IDLE" && newState === "CHASE") {
          (e as unknown as { firstSeenAt?: number }).firstSeenAt = now;
          this.alertNearbyEnemies(e, now);
        }
        // Prompt #57 — AI barks reference real game state. Wire the FSM
        // transition hook so each state change emits the appropriate bark
        // (SPOTTED on IDLE→CHASE, FLANKING on CHASE→FLANK, SUPPRESSED on
        // →SUPPRESSED/COVER, LOST_HIM/REGROUP on →FLEE, DOWN on →DEAD).
        // For CHASE→FLANK, compute the flank side (left/right relative to
        // the player's facing) so the bark reads "Flanking left!" /
        // "Flanking right!" — matches the prompt's directional example.
        if (prevState !== newState) {
          let flankSide: "left" | "right" | undefined;
          if (prevState === "CHASE" && newState === "FLANK") {
            // Player's right vector (yaw convention: forward = (sin, 0, cos)).
            const prx = Math.cos(ctx.player.yaw);
            const prz = -Math.sin(ctx.player.yaw);
            // Vector from player to enemy (where the flanker is starting from).
            const ex = e.group.position.x - ctx.player.pos.x;
            const ez = e.group.position.z - ctx.player.pos.z;
            // Dot with player's right: positive = enemy is on player's right
            // (flanking right), negative = enemy is on player's left.
            flankSide = (prx * ex + prz * ez) >= 0 ? "right" : "left";
          }
          onFsmTransition(ctx, e, prevState, newState, flankSide);
        }
        // Derive legacy string state from FSM (data-driven lookup).
        // Section D #1748 — fsmStateMap COVER missing. The prior map
        // omitted COVER (which fell through to the default "idle" via
        // the `?? "idle"` fallback). The behavior was correct (COVER →
        // "idle" → tickChase → tickCover via class gate) but the intent
        // was implicit. Now COVER is explicit in the map so the contract
        // is documented + a refactor that adds a new COVER-specific
        // state string won't silently fall through.
        const fsmStateMap: Record<string, EnemyState> = {
          IDLE: "idle", PATROL: "idle", CHASE: "chase", FLANK: "chase",
          ATTACK: "attack", SUPPRESSED: "chase", FLEE: "chase", COVER: "idle",
          DEAD: "dead",
        };
        e.state = fsmStateMap[e.fsm?.state ?? "IDLE"] ?? "idle";
        // Section D #1746 — compute `running` AFTER the FSM tick so the
        // gait animation matches the post-tick state (was computed before
        // the tick, leading to a one-frame mismatch on state transitions).
        running = dist > 12 && (e.fsm?.state === "CHASE" || e.fsm?.state === "FLANK");

        // P4.1: FSM-state-specific behavior (delegated to enemy-tactics.ts).
        const fsmState = e.fsm?.state ?? "IDLE";
        const shootFn = (en: Enemy, d: number) => this.enemyShoot(en, d);
        if (fsmState === "SUPPRESSED") {
          tickSuppressed(ctx, e, dt, collidesFn);
        } else if (fsmState === "FLANK") {
          tickFlank(ctx, e, dt, hasLOS, now, dist, toPlayer, shootFn, collidesFn);
        } else if (fsmState === "FLEE") {
          // G3.3 — Flee: sprint away from the player, don't shoot.
          tickFlee(ctx, e, dt, toPlayer, collidesFn);
        } else if (fsmState === "ATTACK") {
          // G2.3 — Snipers/MG back away to maintain their engagement range
          // if the player rushes in. Uses the FSM's per-class attackRange.
          const ar = e.fsm?.attackRangeMeters ?? 8;
          tickAttackMaintainRange(ctx, e, dt, dist, toPlayer, ar, collidesFn);
        } else if (e.state === "chase" || e.state === "idle") {
          tickChase(ctx, e, dt, now, toPlayer, collidesFn);
        }

        // Shooting: enemies shoot when in ATTACK state, or in CHASE state
        // within 35m (with a lower per-frame probability for easier gameplay).
        // G3.3 — FLEEing enemies don't shoot (they're running away).
        // "Spotted you" beat: the first shot after acquiring a target has a
        // 0.5s delay (simulating the enemy raising their weapon).
        // Prompt #57 — RELOAD barks: enemies track a per-enemy shot counter
        // (`shotsFired`); every MAG_SIZE shots, they pause for RELOAD_MS to
        // reload + emit a "Reloading! Cover me!" bark. While reloading,
        // shooting is suppressed. This makes the bark fire on actual state
        // change (magazine empty → reload), not a random timer.
        // Section D #1749 — firstSeenAt NaN guard. The prior code used
        // `(e as ...).firstSeenAt!` (non-null assertion) which produced
        // NaN arithmetic when firstSeenAt was undefined (enemies spawned
        // directly into CHASE via the ZOMBIES-mode spotPlayer fast-path
        // never had firstSeenAt set). `now - undefined = NaN`, and
        // `NaN < 500` is false — so isAcquiring was safely false, but the
        // intent was opaque. Now we explicitly check for undefined + use
        // Infinity as the fallback (so the comparison is well-defined).
        const firstSeenAt = (e as unknown as { firstSeenAt?: number }).firstSeenAt ?? Infinity;
        const isAcquiring = e.lastShot === 0 && now - firstSeenAt < 500;
        const aiExtra = e as unknown as {
          shotsFired?: number;
          reloadingUntil?: number;
          lastReloadBarkAt?: number;
        };
        // Section D #1750 — per-class MAG_SIZE + RELOAD_MS. The prior
        // hardcoded MAG_SIZE=7 + RELOAD_MS=1500 made MG (which should
        // have a 50-round belt) reload after 7 shots + Sniper (5-round
        // mag) reload after 7 shots — both wrong. Now we read from the
        // class config via a lookup table. Falls back to the rifleman
        // defaults if the class isn't recognized.
        const clsForReload = (e as unknown as { enemyClass?: EnemyClass }).enemyClass ?? "RIFLEMAN";
        const MAG_SIZE = CLASS_MAG_SIZE[clsForReload] ?? 7;
        const RELOAD_MS = CLASS_RELOAD_MS[clsForReload] ?? 1500;
        const isReloading = (aiExtra.reloadingUntil ?? 0) > now;
        // Section D #1751 — shot cooldown overrides class. The prior
        // `900 + Math.random() * 600` cooldown was hardcoded; class configs
        // define per-class shotCooldown ranges that were ignored. Now we
        // use clsCfg.shotCooldown for the per-class fire rate.
        const clsCfg = getEnemyClassConfig(e);
        const shotCooldownRange = clsCfg?.shotCooldown ?? [700, 1300];
        const shotCooldown = shotCooldownRange[0] + Math.random() * (shotCooldownRange[1] - shotCooldownRange[0]);
        const canShoot = !isReloading && fsmState !== "FLEE" && fsmState !== "SUPPRESSED" &&
          (e.state === "attack" || (e.state === "chase" && dist < 35 && Math.random() < 0.02));
        if (canShoot) {
          // Section D #1919 — difficulty reaction-time gate. The prior code
          // let enemies fire the moment the cooldown elapsed, so Easy AI
          // snap-fired on sight (800ms reaction time ignored). Now we gate
          // the FIRST shot after spotting on aiCanReact(diffCfg, msSinceFirstSeen)
          // — Easy AI waits 800ms after first sight before its first shot;
          // Insane AI fires in 100ms. Subsequent shots are gated only by
          // the per-class shotCooldown (the reaction gate is a one-shot
          // acquisition delay, not a per-shot delay).
          const diffCfg = getDifficultyConfig(useGameStore.getState().settings.difficulty);
          const msSinceFirstSeen = now - firstSeenAt;
          const reactionOk = e.lastShot !== 0 || aiCanReact(diffCfg, msSinceFirstSeen);
          if (reactionOk && !isAcquiring && now - e.lastShot > shotCooldown) {
            e.lastShot = now;
            this.enemyShoot(e, dist);
            // Prompt #57 — increment the magazine counter; reload when empty.
            aiExtra.shotsFired = (aiExtra.shotsFired ?? 0) + 1;
            if ((aiExtra.shotsFired ?? 0) >= MAG_SIZE) {
              aiExtra.reloadingUntil = now + RELOAD_MS;
              aiExtra.shotsFired = 0;
              // Section D #1752 — RELOADING bark per-enemy cooldown. The
              // prior bark had a global per-kind cooldown (5s) so multiple
              // enemies reloading in the same window only fired one bark.
              // Now we use a per-enemy cooldown (lastReloadBarkAt) so each
              // enemy's reload is announced independently. The global
              // bark-kind cooldown in barks.ts still applies (prevents
              // spam if the SAME enemy reloads twice in 5s — but that's
              // already prevented by the reload duration).
              const lastReloadBark = aiExtra.lastReloadBarkAt ?? 0;
              if (now - lastReloadBark > 5000) {
                aiExtra.lastReloadBarkAt = now;
                emitBark(ctx, e, "RELOADING");
              }
            }
          }
        }
      }

      // Gait animation (all moving states — zombies + FSM-driven enemies).
      const sp = Math.hypot(e.velocity.x, e.velocity.z);
      if (sp > 0.3) {
        e.gaitPhase += dt * sp * (running ? 2.4 : 1.6);
        animateGait(e.parts, e.gaitPhase, sp, running);
      }

      if (e.hitFlash > 0) {
        e.hitFlash -= dt;
        const on = e.hitFlash > 0 ? 0.6 : 0;
        // Flash the body + head emissive. Materials are shared per-enemy
        // (buildHumanoid creates new materials each call), so this only
        // affects this specific enemy.
        (e.body.material as THREE.MeshStandardMaterial).emissive.setRGB(on, 0, 0);
        (e.head.material as THREE.MeshStandardMaterial).emissive.setRGB(on, 0, 0);
        // Also flash the vest + helmet for a more visible hit response.
        if (e.parts.vest) (e.parts.vest.material as THREE.MeshStandardMaterial).emissive.setRGB(on * 0.5, 0, 0);
        if (e.parts.helmet) (e.parts.helmet.material as THREE.MeshStandardMaterial).emissive.setRGB(on * 0.5, 0, 0);
      }
    }
    // G3.1 — Commander-triggered flanking coordination. Throttled to ~2 Hz
    // (every 500ms) to avoid per-frame overhead.
    this.updateCommanderCoordination(now);
    // Task-7 — Drone Commander reinforcement spawning (throttled to ~2 Hz;
    // the actual spawn interval is per-boss via reinforcementIntervalSec).
    this.tickBossReinforcements(now);
    // Section F — Tick the AI orchestrator (learning AI, morale, boss
    // phases, cover system). No-op until the engine calls
    // initAIOrchestrator(ctx) on match start; the tick is guarded so it's
    // safe even if the orchestrator isn't initialized (it returns early).
    try { tickAIOrchestrator(ctx, dt); } catch { /* no-op — orchestrator optional */ }
  }

  /**
   * Task-7 — Drone Commander reinforcement tick. Every boss with a
   * `reinforcementIntervalSec` set (currently only DRONE_COMMANDER)
   * periodically spawns 1–2 minor CQB escort enemies near itself. The
   * reinforcements do NOT count toward `enemiesRemaining` (they're
   * bonus pressure, not wave-clear objectives) and are removed on
   * wave transition like all other enemies.
   *
   * Capped by `concurrentEnemyCap` so HORDE mode doesn't overflow.
   * Throttled externally to ~2 Hz (every 500ms) — the per-boss
   * interval check is cheap.
   */
  private lastBossReinforcementTick = 0;
  private tickBossReinforcements(now: number) {
    if (now - this.lastBossReinforcementTick < 500) return;
    this.lastBossReinforcementTick = now;
    const { ctx } = this;
    if (ctx.match.matchOver || ctx.match.waveTransitioning) return;
    const diffCfg = getDifficultyConfig(useGameStore.getState().settings.difficulty);
    for (const boss of ctx.enemies) {
      if (!boss.alive) continue;
      const interval = (boss as unknown as { reinforcementIntervalSec?: number }).reinforcementIntervalSec;
      if (!interval) continue;
      const last = (boss as unknown as { lastReinforcementAt?: number }).lastReinforcementAt ?? now;
      if (now - last < interval * 1000) continue;
      // Time to spawn reinforcements. Only fire if the boss is engaged
      // (CHASE / ATTACK / FLANK) — no point spawning idle drones.
      const fsmState = boss.fsm?.state;
      if (fsmState !== "CHASE" && fsmState !== "ATTACK" && fsmState !== "FLANK") {
        // Reset the timer so we don't fire the moment the boss spots the player.
        (boss as unknown as { lastReinforcementAt?: number }).lastReinforcementAt = now;
        continue;
      }
      (boss as unknown as { lastReinforcementAt?: number }).lastReinforcementAt = now;
      const want = 1 + Math.floor(Math.random() * 2); // 1 or 2
      const aliveNow = ctx.enemies.filter((e) => e.alive).length;
      const allowed = Math.max(0, Math.min(want, ctx.match.concurrentEnemyCap - aliveNow));
      if (allowed === 0) continue;
      for (let i = 0; i < allowed; i++) {
        // Spawn near the boss (within 3m) — CQB rushers are the drone swarm.
        const offset = new THREE.Vector3(
          (Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6,
        );
        const sp = boss.group.position.clone().add(offset);
        sp.y = 0;
        // Clamp inside the map bounds (matches enemy-tactics b = 43).
        sp.x = Math.max(-43, Math.min(43, sp.x));
        sp.z = Math.max(-43, Math.min(43, sp.z));
        const minion = this.buildEnemy(sp);
        applyClassToEnemy(minion, minion.fsm, "CQB", ctx.match.wave);
        minion.maxHealth = Math.round(minion.maxHealth * diffCfg.healthMult);
        minion.health = minion.maxHealth;
        minion.accuracy = Math.min(0.95, minion.accuracy * diffCfg.accuracyMult);
        (minion as unknown as { damageMult?: number }).damageMult = diffCfg.damageMult;
        minion.className = "DRONE";
        // Task-7 — flag as a reinforcement: killEnemy still grants score +
        // kill count, but does NOT decrement enemiesRemaining (so the wave
        // only ends when the boss + its starting escort are dead, not when
        // the player farms spawned drones).
        (minion as unknown as { isReinforcement?: boolean }).isReinforcement = true;
        // Force-spawn into CHASE so the drone immediately pressures the player.
        minion.fsm?.send("spotPlayer");
        (minion as unknown as { firstSeenAt?: number }).firstSeenAt = now;
        ctx.enemies.push(minion);
      }
      ctx.addKillFeed({
        killer: "DRONE COMMANDER",
        victim: `Reinforcements inbound — ${allowed} drone(s)`,
        weapon: "", headshot: false,
      });
    }
  }

  /** G3.2 — Contact call-out: when an enemy spots the player (IDLE→CHASE),
   *  nearby IDLE enemies without their own LOS get a ~40% chance to transition
   *  straight to CHASE. Simulates a shouted callout spreading through the squad. */
  private alertNearbyEnemies(spotter: Enemy, now: number) {
    const { ctx } = this;
    const calloutRadius = 20;
    for (const other of ctx.enemies) {
      if (other === spotter || !other.alive) continue;
      if (other.fsm?.state !== "IDLE") continue;
      const d = Math.hypot(
        other.group.position.x - spotter.group.position.x,
        other.group.position.z - spotter.group.position.z,
      );
      if (d > calloutRadius) continue;
      // 40% chance to be alerted by the callout.
      if (Math.random() < 0.4) {
        other.fsm?.send("spotPlayer");
        (other as unknown as { firstSeenAt?: number }).firstSeenAt = now;
      }
    }
  }

  /** G3.1 — Commander coordination. A live COMMANDER-class enemy in CHASE or
   *  ATTACK periodically selects 1–2 nearby non-Commander enemies in CHASE and
   *  triggers their `flankOrder` event directly. Killing the Commander stops
   *  new coordinated flanks, giving players a reason to prioritize it.
   *  Throttled to ~2 Hz (every 500ms).
   *
   *  Section D #1753 — Commander excludes bosses. The prior code required
   *  `enemyClass === "COMMANDER"` which excluded bosses (bosses stash their
   *  class as `bossClass`, not `enemyClass`). Now bosses with the command
   *  ability (Drone Commander) can also coordinate flanks. The check is:
   *  `enemyClass === "COMMANDER" || bossClass === "DRONE_COMMANDER"`.
   *
   *  Section D #1754 — Commander flank only CHASE. The prior code required
   *  `fsm.state === "CHASE"` for flank candidates — ATTACK enemies (already
   *  engaged) couldn't be ordered to flank. Now we also accept ATTACK (mirrors
   *  the #1707 EnemyFSM fix that lets ATTACK flank via the lone-wolf path).
   *
   *  Section D #1755 — biased shuffle. The prior code used
   *  `candidates.sort(() => Math.random() - 0.5)` which is biased (the sort
   *  comparator isn't transitive — V8's sort produces a non-uniform
   *  distribution). Now we use Fisher-Yates (uniform). */
  private lastCommanderTick = 0;
  private updateCommanderCoordination(now: number) {
    if (now - this.lastCommanderTick < 500) return;
    this.lastCommanderTick = now;
    const { ctx } = this;
    for (const cmd of ctx.enemies) {
      if (!cmd.alive) continue;
      const cls = (cmd as unknown as { enemyClass?: EnemyClass }).enemyClass;
      const bossCls = (cmd as unknown as { bossClass?: string }).bossClass;
      // Section D #1753 — include bosses (Drone Commander) as coordinators.
      const isCommander = cls === "COMMANDER" || bossCls === "DRONE_COMMANDER";
      if (!isCommander) continue;
      const cmdState = cmd.fsm?.state;
      if (cmdState !== "CHASE" && cmdState !== "ATTACK") continue;
      // Stash the last-flank-order timestamp on the Commander.
      const cmdExtra = cmd as unknown as { lastFlankOrder?: number };
      if (cmdExtra.lastFlankOrder && now - cmdExtra.lastFlankOrder < 4000) continue;
      cmdExtra.lastFlankOrder = now;
      // Find 1–2 nearby non-Commander enemies in CHASE to flank.
      const candidates = ctx.enemies.filter((e) => {
        if (e === cmd || !e.alive) return false;
        const c = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
        const bc = (e as unknown as { bossClass?: string }).bossClass;
        // Exclude other commanders + drone commanders (don't flank yourself).
        if (c === "COMMANDER" || bc === "DRONE_COMMANDER") return false;
        // Section D #1754 — accept CHASE or ATTACK (was CHASE only).
        if (e.fsm?.state !== "CHASE" && e.fsm?.state !== "ATTACK") return false;
        const d = Math.hypot(
          e.group.position.x - cmd.group.position.x,
          e.group.position.z - cmd.group.position.z,
        );
        return d < 25;
      });
      // Section D #1755 — Fisher-Yates shuffle (uniform random). The prior
      // `candidates.sort(() => Math.random() - 0.5)` was biased.
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      const flankers = candidates.slice(0, 2);
      for (const f of flankers) {
        f.fsm?.send("flankOrder");
      }
      if (flankers.length > 0) {
        ctx.addKillFeed({
          killer: "COMMANDER", victim: `Coordinated flank — ${flankers.length} unit(s)`,
          weapon: "", headshot: false,
        });
      }
    }
  }

  private enemyCollides(e: Enemy): boolean {
    const { ctx } = this;
    const r = 0.5;
    // Prompt #53 — reduce the collision capsule height when the enemy is
    // crouching (SUPPRESSED / COVER state). Standing capsule is y=0.1..2.0
    // (1.9m tall); crouching is y=0.1..1.3 (1.2m tall). This lets a crouched
    // enemy fit behind lower cover without colliding with it, and matches
    // the visual crouch driven by applyCrouch (group.position.y is lowered
    // by ~0.35m when crouching — the rig meshes follow).
    //
    // Section D #1745 — use a LOCAL Box3 (not ctx.scratch.box1) so the
    // collision check doesn't corrupt the shared scratch vector if any
    // sub-system reads ctx.scratch.box1 in the same frame. The per-call
    // allocation is cheap (Box3 is a plain object with two Vector3 fields).
    //
    // Section D #1756 — spatial partition. The prior code iterated ALL
    // colliders (O(C) per enemy, O(N·C) total). Now we use the collider
    // spatial hash (rebuilt once per tick in update() via
    // `_rebuildColliderGrid`) so only the colliders in the enemy's 3×3
    // neighborhood are checked. Falls back to the full scan if the grid
    // isn't built (e.g. before the first update() call).
    const box = new THREE.Box3();
    box.min.set(e.group.position.x - r, 0.1, e.group.position.z - r);
    box.max.set(e.group.position.x + r, e.crouching ? 1.3 : 2, e.group.position.z + r);
    // Section D #1756 — scoped collider check via the spatial grid.
    const nearby = this._nearbyColliders(e.group.position.x, e.group.position.z);
    const list = nearby.length > 0 ? nearby : ctx.colliders;
    return list.some((c) => box.intersectsBox(c.box));
  }

  /** Section D #1756 — spatial hash grid for colliders. Rebuilt once per
   *  tick (in update()) so enemyCollides is O(1) average per enemy. Cells
   *  are 4m (the max collider half-extent in the standard map) so the 3×3
   *  neighborhood covers a 12m × 12m area around the enemy. */
  private _colliderGrid = new Map<string, typeof this.ctx.colliders>();
  private _colliderGridCell = 4;
  private _colliderGridBuiltAt = 0;
  private _rebuildColliderGrid(): void {
    const { ctx } = this;
    this._colliderGrid.clear();
    for (const c of ctx.colliders) {
      const cx = Math.floor((c.box.min.x + c.box.max.x) * 0.5 / this._colliderGridCell);
      const cz = Math.floor((c.box.min.z + c.box.max.z) * 0.5 / this._colliderGridCell);
      const key = `${cx},${cz}`;
      let arr = this._colliderGrid.get(key);
      if (!arr) { arr = []; this._colliderGrid.set(key, arr); }
      arr.push(c);
    }
    this._colliderGridBuiltAt = performance.now();
  }
  private _nearbyColliders(x: number, z: number): typeof this.ctx.colliders {
    const cx = Math.floor(x / this._colliderGridCell);
    const cz = Math.floor(z / this._colliderGridCell);
    const out: typeof this.ctx.colliders = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const arr = this._colliderGrid.get(`${cx + dx},${cz + dz}`);
        if (arr) for (const c of arr) out.push(c);
      }
    }
    return out;
  }

  private enemyShoot(e: Enemy, dist: number) {
    const { ctx } = this;
    // P5.2 + Task-7: read class config for damage + caliber. Bosses use
    // the BOSS_CLASSES config (looked up via getEnemyClassConfig), so
    // Juggernaut hits like an LMG and the Riot Shield Captain's pistol
    // sounds right.
    const clsCfg = getEnemyClassConfig(e);
    const origin = e.group.position.clone(); origin.y = 1.2;

    // G1.2 — VIP Escort: enemies have a 25% chance to target the VIP instead
    // of the player when the VIP is alive, in range, and in LOS. This creates
    // the escort tension — the player must protect the VIP from focused fire.
    const vip = ctx.vip;
    let targetIsVip = false;
    if (vip && vip.alive && Math.random() < 0.25) {
      const vipDist = origin.distanceTo(vip.group.position);
      // Section D #1759 + #1760 — VIP blocks own LOS. The prior isOccluded
      // check raycast against env targets which INCLUDE the VIP's mesh (VIP
      // is a humanoid built via buildHumanoid, tagged userData.isVip=true).
      // The VIP's own mesh blocked the LOS check from the enemy to the VIP,
      // so the VIP was almost never targetable. Now isOccluded skips VIP
      // meshes (see the isOccluded fix below) so the enemy can target the VIP.
      if (vipDist < 30 && !this.isOccluded(origin, vip.group.position.clone())) {
        targetIsVip = true;
      }
    }

    // Hit chance: accuracy * distance falloff. Min 15% at any range so
    // enemies are less lethal (was 30% — too punishing for new players).
    // Section D #1761 — per-class falloff. The prior `1 - targetDist / 50`
    // falloff was the same for all classes — Snipers (high accuracy, long
    // range) had the same falloff as MGs (low accuracy, short range), so
    // at long range the Sniper's accuracy advantage was wasted. Now each
    // class has its own falloff distance (Sniper 100m, Rifleman 50m, MG 30m,
    // CQB 25m) — Snipers stay accurate at range, MGs falloff fast (they're
    // suppressive, not precision).
    const target = targetIsVip ? vip!.group.position.clone() : ctx.player.pos.clone();
    const targetDist = targetIsVip ? origin.distanceTo(target) : dist;
    const clsForFalloff = (e as unknown as { enemyClass?: EnemyClass }).enemyClass ?? "RIFLEMAN";
    const falloffDist = CLASS_FALLOFF_DIST[clsForFalloff] ?? 50;
    // Section D #1762 — VIP hit chance. The prior formula gave the VIP a
    // ~7.65% hit chance (0.55 * (1 - 30/50) * 0.3 occluded-mult = 0.066).
    // The occluded multiplier was applied even when the enemy had LOS
    // (because the VIP's own mesh blocked the LOS check, so isOccluded
    // returned true). Now that isOccluded skips VIP meshes (#1759), the
    // occluded multiplier doesn't fire — VIP hit chance is the full 0.22.
    const hitChance = e.accuracy * Math.max(0.15, 1 - targetDist / falloffDist);
    const occluded = this.isOccluded(origin, target);
    const caliber = clsCfg?.caliber ?? (e.speed > 4 ? "rifle" : "smg");
    ctx.audio.distantGunshot(origin.x, origin.y, origin.z, occluded, caliber);
    // Task-6: enemy tracers are red-tinted (0xff3344) so the player can
    // distinguish incoming fire from their own weapon-coded tracers.
    this.onSpawnTracer?.(origin, target, 0xff3344);
    const dmgRange = clsCfg?.damageRange ?? [8, 18];
    // G4.2 — apply the per-enemy difficulty damage multiplier.
    const dmgMult = (e as unknown as { damageMult?: number }).damageMult ?? 1;
    // Section D #1763 — Riot Shield multiplicative. The shield's 0.2x
    // multiplier + the boss damageReduction (e.g. Juggernaut 0.5x) stack
    // multiplicatively (0.2 * 0.5 = 0.1 = 90% reduction). This is
    // intentional — the Riot Shield Captain's shield is its primary defense,
    // and the damageReduction is its armor. Documented here so future
    // readers don't try to "fix" the stacking (it's a feature, not a bug).
    const effectiveHitChance = occluded ? hitChance * 0.3 : hitChance;
    if (Math.random() < effectiveHitChance) {
      if (targetIsVip) {
        // G1.2 — damage the VIP via the MissionSystem.
        this.onDamageVip?.((dmgRange[0] + Math.random() * (dmgRange[1] - dmgRange[0])) * dmgMult);
      } else {
        // Realism: pass the enemy world position so the medical system can
        // record the damage source direction for the HUD directional indicator.
        this.onApplyDamageToPlayer?.((dmgRange[0] + Math.random() * (dmgRange[1] - dmgRange[0])) * dmgMult, "torso", origin);
      }
    }
    // R3.2: Suppression — near misses raise suppression (player only, not VIP)
    if (!targetIsVip) {
      const d = origin.distanceTo(ctx.player.pos), supp = d < 5 ? 0.18 : d < 15 ? 0.08 : 0;
      if (supp) ctx.suppression.value = Math.min(1, ctx.suppression.value + supp);
    }
  }
  /** G1.2 — Hook for MissionSystem.damageVip (wired by engine-wiring). */
  onDamageVip?: (dmg: number) => void;
  onSpawnTracer?: (from: THREE.Vector3, to: THREE.Vector3, colorHex?: number) => void;
  onApplyDamageToPlayer?: (dmg: number, hitLocation?: "torso" | "limb" | "head", sourcePos?: THREE.Vector3) => void;

  /** R6.3 — Check if line of sight is occluded by geometry.
   *  Filters out: camera/weapon/avatar subtrees, sprites, AND enemy meshes
   *  (so enemies don't block their own LOS with their body parts).
   *
   *  Section D #1757 — non-recursive raycast. The prior code used
   *  `intersectObjects(targets, false)` (non-recursive) which skipped
   *  children of nested groups. Chunk-streamed env props are parented to
   *  chunk Groups; non-recursive raycast missed them entirely (enemies
   *  could see through walls). Now we use `true` (recursive) so nested
   *  colliders block. Perf: getEnvRaycastTargets returns a flat list of
   *  leaf meshes, so the recursive flag is a no-op for the cached path —
   *  but it's correct for the fallback path (uncached) where the targets
   *  may include groups.
   *
   *  Section D #1758 — companion blocks LOS. The prior code skipped enemy
   *  meshes (userData.enemy) but NOT companion meshes (userData.isCompanion)
   *  — the companion's body blocked the enemy's LOS to the player. Now we
   *  also skip companion meshes (documented: the companion is friendly, so
   *  enemies can shoot through it — this matches the bullets-pass-through
   *  behavior in WeaponSystem).
   *
   *  Section D #1759 + #1760 — VIP blocks own LOS. The VIP's mesh
   *  (userData.isVip) was NOT skipped, so the VIP blocked the enemy's LOS
   *  to itself (the enemy couldn't target the VIP). Now we skip VIP meshes
   *  in the LOS check so the enemy can target the VIP. The VIP is still
   *  protected by the player's escort duty — the enemy has to get into LOS
   *  first, but once there, the VIP's own mesh doesn't block the shot. */
  isOccluded(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const { ctx } = this;
    const dir = to.clone().sub(from);
    const dist = dir.length();
    dir.normalize();
    ctx.raycaster.set(from, dir);
    ctx.raycaster.far = dist - 0.5;
    // Section D #1757 — recursive (true) so nested chunk-group children block.
    const hits = ctx.raycaster.intersectObjects(getEnvRaycastTargets(ctx), true);
    return hits.some((h) => {
      // Skip camera/weapon/avatar subtrees.
      if (this.isInCameraSubtree(h.object)) return false;
      // Skip sprites (particles, tracers, decals).
      if (h.object.type === "Sprite") return false;
      // Skip enemy meshes — enemies don't block their own LOS.
      if ((h.object as THREE.Mesh).userData?.enemy) return false;
      // Section D #1758 — skip companion meshes (friendly, bullets pass through).
      if ((h.object as THREE.Mesh).userData?.isCompanion) return false;
      // Section D #1759 + #1760 — skip VIP meshes (so the VIP doesn't block
      // the enemy's LOS to the VIP itself; the VIP is still protected by
      // cover / player escort, but its own mesh isn't a shield).
      if ((h.object as THREE.Mesh).userData?.isVip) return false;
      // Skip the muzzle flash mesh.
      if (h.object === ctx.muzzleFlash) return false;
      return true;
    });
  }

  private isInCameraSubtree(obj: THREE.Object3D): boolean {
    let p: THREE.Object3D | null = obj;
    while (p) { if (p === this.ctx.camera || p === this.ctx.avatar?.group) return true; p = p.parent; }
    return false;
  }

  damageEnemy(e: Enemy, dmg: number, headshot: boolean, point: THREE.Vector3) {
    const { ctx } = this;
    if (!e.alive) return;

    // Section D #1774 — spawn protection. Skip damage entirely while the
    // enemy is spawn-protected (3s invuln after spawn). The visual cue is
    // the responsibility of the renderer (a faint shield bubble); here we
    // just no-op the damage. Headshots + limb hits are all skipped (the
    // enemy is invulnerable, not just damage-reduced).
    const spawnProtectedUntil = (e as unknown as Record<string, unknown>).spawnProtectedUntil as number | undefined;
    if (spawnProtectedUntil !== undefined && performance.now() < spawnProtectedUntil) {
      return;
    }

    // Task-7 — Boss damage reduction (Juggernaut 50%, Armored Mech 60%, etc.).
    // Applied before the shield check so a shielded boss reduces damage twice
    // only when the shield is bypassed (the shield reduction is multiplicative
    // on the post-armor amount).
    const damageReduction = (e as unknown as { damageReduction?: number }).damageReduction ?? 0;
    let effectiveDmg = dmg * (1 - damageReduction);

    // Task-7 — Boss ballistic shield (Riot Shield Captain). The shield is a
    // front-facing box; bullets that hit from the enemy's front 120° cone
    // (dot > 0.5 between the player-to-enemy vector and the enemy's forward
    // vector) have damage reduced 80%. To bypass, the player must strafe
    // around the captain fast enough to get behind its current facing — the
    // enemy's rotation is damped at 8/sec so quick flanking works.
    const hasShield = (e as unknown as { hasShield?: boolean }).hasShield ?? false;
    if (hasShield && effectiveDmg > 0) {
      const toPlayer = ctx.scratch.v2.copy(ctx.player.pos).sub(e.group.position);
      toPlayer.y = 0;
      const distToPlayer = toPlayer.length();
      if (distToPlayer > 0.01) {
        toPlayer.divideScalar(distToPlayer);
        // Enemy forward vector from yaw (default Three.js forward is +Z).
        const forwardX = Math.sin(e.group.rotation.y);
        const forwardZ = Math.cos(e.group.rotation.y);
        const dot = forwardX * toPlayer.x + forwardZ * toPlayer.z;
        if (dot > 0.5) {
          // Player is in the enemy's front 120° cone — shield blocks.
          effectiveDmg *= 0.2;
          // Throttled HUD cue so the player learns the shield mechanic.
          const now = performance.now();
          const lastShieldNote = (e as unknown as { lastShieldNote?: number }).lastShieldNote ?? 0;
          if (now - lastShieldNote > 1800) {
            (e as unknown as { lastShieldNote?: number }).lastShieldNote = now;
            ctx.pushHud({ objective: "⦻ SHIELD BLOCKED — flank the captain!" });
          }
        }
      }
    }

    e.health -= effectiveDmg;
    e.hitFlash = 0.15;
    // V2.3 — stamp last-damaged time so the on-spot nameplate lingers ~2s.
    e.lastDamagedTime = performance.now();
    ctx.audio.hitMarker();
    if (headshot) ctx.audio.headshotDing();

    // ── DAMAGE NUMBERS (Prompt 9) ────────────────────────────────────
    // Publish a floating damage number event to the React HUD via the
    // window global (same rAF-poll pattern as the minimap — no re-renders).
    // Headshots get bigger/gold numbers; kills get a red "ELIMINATED" tag.
    if (typeof window !== "undefined") {
      const dn = window.__PR_DAMAGE_NUMBERS__ ?? { items: [], _nextId: 0 } as any;
      const id = (dn._nextId ?? 0) + 1;
      dn._nextId = id;
      dn.items.push({
        id,
        x: point.x, y: point.y + 0.3, z: point.z,
        damage: Math.round(effectiveDmg),
        headshot,
        kill: e.health <= 0,
        time: performance.now(),
      });
      // Cap the pool to prevent memory growth during LMG bursts.
      if (dn.items.length > 80) dn.items.splice(0, dn.items.length - 80);
      window.__PR_DAMAGE_NUMBERS__ = dn;
    }

    // Task-6: directional blood spray — cone of red particles in the bullet's
    // travel direction (from player to hit point). Headshots get a bigger,
    // finer mist. The legacy onSpawnBlood hook is replaced by onSpawnBloodSpray.
    const bloodDir = point.clone().sub(ctx.player.pos).normalize();
    // Task-7 — boss blood spray is bigger (they're bigger targets).
    const bloodAmount = isBossEnemy(e) ? 18 : 10;
    this.onSpawnBloodSpray?.(point, bloodDir, bloodAmount, headshot);

    // Distinct hit reactions by hit location.
    // Headshot: smooth spring-driven snap-back + extra blood + screen shake.
    // Body: stagger backward + hit flash.
    // Limb: flinch + reduced mobility (brief speed penalty).
    if (headshot) {
      // ANIM-POLISH — seed the headshot impulse via userData instead of
      // writing `head.rotation.x = -0.8` directly. ProceduralAnimSystem
      // reads this on its next tick + applies an impulse to the head spring
      // (smooth, weighty snap with 2-3 overshoots, ~0.5s total — vs the
      // legacy instant snap which was jarring + was overwritten next frame
      // by head tracking anyway).
      //
      // We use Math.max with the existing value so a double-headshot (e.g.
      // a shotgun pellet landing in the same frame as a rifle round) doesn't
      // clobber the larger impulse — the bigger snap wins.
      const ud = e.group.userData as { headshotImpulse?: number };
      const mag = isBossEnemy(e) ? 6.0 : 8.0; // bosses are heavier → smaller snap
      ud.headshotImpulse = Math.max(ud.headshotImpulse ?? 0, mag);
      // Screen shake — headshots feel impactful. Bigger shake on bosses.
      ctx.triggerShake(isBossEnemy(e) ? 0.25 : 0.15);
      // Hit marker stays longer for headshots.
      ctx.pushHud({ hitMarker: performance.now() + 200 });
    } else {
      // Body/limb hit: stagger the enemy backward slightly.
      // Bosses are too heavy to stagger — skip the knockback.
      // Section D #1764 — knockback stacks. The prior code added a small
      // random position nudge per hit which STACKED (multiple LMG hits
      // would gradually push the enemy out of position). Now we use an
      // impulse model (stash a knockbackImpulse on the enemy that the
      // movement system consumes + decays over ~0.2s, mirroring the
      // ShieldCaptain's bash fix at #1730). This means repeated hits
      // accumulate as impulses (which decay) rather than as permanent
      // position offsets. Falls back to the legacy nudge if the impulse
      // hook isn't consumed (graceful degrade).
      if (!isBossEnemy(e)) {
        const knockbackMag = 0.5;
        // Direction from the damage source to the enemy (away from the player).
        const kx = e.group.position.x - ctx.player.pos.x;
        const kz = e.group.position.z - ctx.player.pos.z;
        const klen = Math.hypot(kx, kz) || 1;
        const ix = (kx / klen) * knockbackMag;
        const iz = (kz / klen) * knockbackMag;
        const enemyImpulse = e as unknown as {
          knockbackImpulse?: { x: number; z: number; expiresAt: number };
        };
        const nowMs = performance.now();
        if (enemyImpulse.knockbackImpulse && enemyImpulse.knockbackImpulse.expiresAt > nowMs) {
          // Accumulate (cap at 3× to prevent runaway pushback from sustained fire).
          const existing = enemyImpulse.knockbackImpulse;
          existing.x = Math.max(-1.5, Math.min(1.5, existing.x + ix));
          existing.z = Math.max(-1.5, Math.min(1.5, existing.z + iz));
          existing.expiresAt = nowMs + 200;
        } else {
          enemyImpulse.knockbackImpulse = {
            x: ix, z: iz, expiresAt: nowMs + 200,
          };
        }
        // Brief speed penalty (hit stagger).
        e.speed *= 0.85;
        setTimeout(() => { e.speed /= 0.85; }, 300);
      }
      ctx.pushHud({ hitMarker: performance.now() });
    }

    if (e.health <= 0) this.killEnemy(e, headshot);
  }
  /** Legacy blood hook (still wired for melee). Prefer onSpawnBloodSpray for
   *  bullet hits — that one carries direction + headshot for a proper cone. */
  onSpawnBlood?: (point: THREE.Vector3) => void;
  /** Task-6: directional blood spray hook (bullet hits). */
  onSpawnBloodSpray?: (point: THREE.Vector3, direction: THREE.Vector3, amount: number, headshot: boolean) => void;

  killEnemy(e: Enemy, headshot: boolean) {
    const { ctx } = this;
    const mode = ctx.match.mode as GameMode;
    // Prompt 11 — maybe trigger a cinematic finisher (15% chance on any kill).
    // The finisher handles the death sequence itself (ragdoll override), so
    // we still proceed with the score/wave bookkeeping below.
    if (ctx.finishers) {
      maybeTriggerFinisherOnKill(ctx, e);
    }
    e.alive = false; e.state = "dead"; e.deadTime = performance.now();
    e.fsm?.markDead();
    // Prompt #57 — "Target down!" bark: emit from a nearby ALLY witnessing
    // the death (vs the DOWN bark the dying enemy itself would emit). Pick
    // the nearest alive ally within 20m + emit the ALLY_DOWN bark from its
    // position. Skipped in ZOMBIES mode (zombies don't talk) + when no
    // nearby ally is alive. The bark's per-kind global cooldown (2.5s)
    // prevents spam when multiple enemies die in a chain reaction.
    // Section D #1766 — witness is reviver. The prior code picked ANY
    // nearby ally as the witness (including the medic that's about to
    // revive the downed enemy). Now we role-discriminate: if a MEDIC is
    // nearby, the medic emits a REVIVING bark ("Medic! On him!") instead
    // of ALLY_DOWN — the medic is about to act, not mourn. Non-medic
    // allies still emit ALLY_DOWN. This makes the bark role-aware + gives
    // the player an audio cue that a medic is incoming (so they can
    // prioritize the medic to prevent the revive).
    if (mode !== "ZOMBIES") {
      let witness: Enemy | null = null;
      let witnessDist = 20;
      let medicWitness: Enemy | null = null;
      let medicDist = 20;
      for (const ally of ctx.enemies) {
        if (ally === e || !ally.alive) continue;
        const d = Math.hypot(
          ally.group.position.x - e.group.position.x,
          ally.group.position.z - e.group.position.z,
        );
        const allyCls = (ally as unknown as { enemyClass?: EnemyClass }).enemyClass;
        // Track the nearest medic separately (medic gets the REVIVING bark).
        if (allyCls === "MEDIC" && d < medicDist) {
          medicDist = d;
          medicWitness = ally;
        }
        // Track the nearest non-medic ally for the ALLY_DOWN bark.
        if (allyCls !== "MEDIC" && d < witnessDist) {
          witnessDist = d;
          witness = ally;
        }
      }
      // Prefer the medic's REVIVING bark if a medic is nearby (the medic
      // is about to act — its bark is more informative than a generic
      // ALLY_DOWN). If no medic, fall back to the nearest ally's ALLY_DOWN.
      if (medicWitness) {
        emitBark(ctx, medicWitness, "REVIVING");
      } else if (witness) {
        emitBark(ctx, witness, "ALLY_DOWN");
      }
    }
    // Wave fix: never decrement below zero. If enemiesRemaining is already
    // <= 0 (e.g. extra enemies from a stale wave transition or a duplicate
    // spawn), don't drive it negative — that would re-trigger the wave-clear
    // branch and schedule a duplicate transition.
    // Task-7 — Drone Commander reinforcements (isReinforcement=true) do NOT
    // decrement enemiesRemaining: they're bonus pressure, not wave-clear
    // objectives. The wave still ends when the boss + its starting escort
    // are dead. Score + kill count are still granted for reinforcement kills.
    const isReinforcement = (e as unknown as { isReinforcement?: boolean }).isReinforcement === true;
    if (!isReinforcement && ctx.match.enemiesRemaining > 0) {
      ctx.match.enemiesRemaining--;
    }
    ctx.match.kills++;
    // G4.1 — track headshots for challenge progress.
    if (headshot) ctx.match.headshots++;
    ctx.match.score += headshot ? 150 : 100;
    // V5.4 — Killstreak mechanic: increment streak, grant rewards at 3 + 7.
    ctx.match.killstreak++;
    if (ctx.match.killstreak > ctx.match.killstreakBest) {
      ctx.match.killstreakBest = ctx.match.killstreak;
    }
    if (ctx.match.killstreak >= 3 && !ctx.match.reconReady) {
      ctx.match.reconReady = true;
      ctx.pushHud({ objective: "RECON DRONE READY — press 4 to deploy" });
    }
    if (ctx.match.killstreak >= 7 && !ctx.match.airstrikeReady) {
      ctx.match.airstrikeReady = true;
      ctx.pushHud({ objective: "AIRSTRIKE READY — press 5 to deploy" });
    }
    ctx.audio.enemyDeath();
    // Task-22 — Ragdoll physics on death. Replace the legacy flat-rotation
    // (e.group.rotation.x = -π/2, position.y = 0.3) with a Verlet ragdoll
    // that makes the enemy collapse naturally. The death impulse direction
    // is computed from the player's position to the enemy's position
    // (since killEnemy's signature doesn't carry the bullet direction —
    // damageEnemy does, but we're not allowed to change damageEnemy). The
    // impulse magnitude scales with the equipped weapon's damage so bigger
    // guns produce more knockback. Falls through gracefully (no ragdoll →
    // no visual change) if the RagdollSystem isn't constructed yet.
    if (ctx.ragdolls) {
      const dir = ctx.scratch.v3.copy(e.group.position).sub(ctx.player.pos);
      dir.y = 0; // horizontal impulse direction (gravity handles the fall)
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); else dir.normalize();
      ctx.ragdolls.activateRagdoll(e, dir, headshot, ctx.weapon.stats.damage);
    } else {
      // Fallback (no RagdollSystem): legacy flat-rotation.
      e.group.rotation.x = -Math.PI / 2; e.group.position.y = 0.3;
    }
    ctx.addKillFeed({ killer: "YOU", victim: getEnemyClassName(e), weapon: ctx.weapon.stats.name, headshot });
    // V3 — spawn a health/ammo pickup at the kill position (medkit 1/10,
    // bandage 1/3, ammo 1/3). The PickupSystem handles the drop roll + visual.
    ctx.pickups?.spawnFromKill(e.group.position);
    // V5.5 — Kill-confirmation juice: brief screen shake + extended hit marker
    // so the kill beat reads as impactful (currently under-sold vs other feedback).
    // Task-7 — boss kills get a bigger shake (0.5) + bonus score + a dedicated
    // HUD banner that flashes "BOSS ELIMINATED" so the climax reads.
    const bossKill = isBossEnemy(e);
    if (bossKill) {
      ctx.match.score += 500; // bonus score for the boss takedown
      ctx.triggerShake(0.5);
    } else {
      ctx.triggerShake(headshot ? 0.3 : 0.18);
    }

    // Task-6: distinct kill + headshot markers + multi-kill notification.
    // The kill marker is a separate HUD field so the crosshair can render a
    // bigger/deeper confirmation marker (vs the hit marker). Headshot kills
    // get a gold headshot marker. Multi-kills (2+ within 2s) push a
    // "DOUBLE KILL" / "TRIPLE KILL" / etc. banner.
    const now = performance.now();
    const MULTI_KILL_WINDOW = 2000;
    // Prune stale kill timestamps, push the new one.
    const recent = ctx.match.recentKills.filter((t) => now - t < MULTI_KILL_WINDOW);
    recent.push(now);
    ctx.match.recentKills = recent;

    const multiKillText = (() => {
      const n = recent.length;
      if (n < 2) return null;
      if (n === 2) return "DOUBLE KILL";
      if (n === 3) return "TRIPLE KILL";
      if (n === 4) return "QUAD KILL";
      if (n === 5) return "MEGA KILL";
      if (n === 6) return "ULTRA KILL";
      return "MONSTER KILL";
    })();

    ctx.pushHud({
      kills: ctx.match.kills,
      score: ctx.match.score,
      enemiesRemaining: ctx.match.enemiesRemaining,
      hitMarker: now + 220, // longer-than-normal hit marker on kill
      killMarker: now,       // Task-6: kill confirmation marker
      headshotMarker: headshot ? now : 0, // Task-6: headshot-kill marker (gold)
      multiKill: multiKillText ? { text: multiKillText, count: recent.length, time: now } : null,
    });

    // Task-7 — Boss death reward: dedicated HUD banner + bonus score killfeed
    // entry so the boss kill beat reads as a clear climax (vs just another
    // kill marker). The score was already incremented above; this entry just
    // makes the +500 visible in the killfeed.
    if (bossKill) {
      const bossName = getEnemyClassName(e).toUpperCase();
      ctx.pushHud({
        objective: `BOSS ELIMINATED — ${bossName} — +500 score`,
      });
      ctx.addKillFeed({
        killer: "YOU", victim: `BOSS: ${bossName}`,
        weapon: "+500", headshot,
      });
    }
    if (ctx.match.enemiesRemaining <= 0 && !ctx.match.waveTransitioning && !ctx.match.matchOver) {
      // G1.1 — mode-aware victory check via isVictoryWave(). HORDE never
      // ends in victory (hasVictory=false); EXTRACTION ends via extraction
      // (maxWaves=0); SURVIVAL/VIP/BREACH end when the last wave is cleared.
      if (isVictoryWave(mode, ctx.match.wave)) {
        // Task-13 — Slow-mo final kill: trigger cinematic slow-motion before
        // the victory screen appears. The engine's triggerSlowMotion handler
        // sets ctx.timeScale = 0.2 for 1.5s, ramps back to 1.0 over 0.5s,
        // applies post-proc desaturation/vignette, and finally calls
        // victory(). Falls back to the immediate onVictory path if the hook
        // isn't wired (e.g. headless / debug contexts).
        if (ctx.triggerSlowMotion) {
          ctx.triggerSlowMotion(1500);
        } else {
          ctx.onVictory();
        }
      } else {
        // Wave fix: route the setTimeout through the engine so it can be
        // cancelled on death / restart. The guard above ensures this only
        // fires once per wave even if multiple enemies die in the same frame.
        ctx.match.waveTransitioning = true;
        const nextWave = ctx.match.wave + 1;
        // Task-13 — buy station: extend the wave-transition timer to 15s so
        // the player has time to shop. The onWaveCleared hook opens the
        // overlay; the player can click READY to start the next wave early
        // (engine cancels this timer + immediately starts the next wave).
        ctx.match.buyStationActive = true;
        ctx.scheduleWaveTransition(() => {
          for (const en of ctx.enemies) ctx.scene.remove(en.group);
          ctx.enemies = [];
          // Task-22 — clear ragdolls along with the enemies so they don't
          // hold stale references to the removed groups.
          ctx.ragdolls?.clear();
          ctx.onStartWave(nextWave);
          ctx.match.waveTransitioning = false;
          // Task-13 — close buy station when the next wave starts (timeout path).
          if (ctx.match.buyStationActive) {
            ctx.match.buyStationActive = false;
            useGameStore.getState().setBuyStationOpen(false);
          }
        }, 15000);
        // Task-13 — notify the engine to open the buy station overlay.
        // Engine wires onWaveCleared to push the HUD objective + set
        // store.buyStationOpen = true.
        ctx.onWaveCleared?.(ctx.match.wave);
      }
    }
  }

  destroyProp(prop: import("./types").DestructibleProp) {
    const { ctx } = this;
    const pos = prop.mesh.position;
    const colorMat = (prop.mesh.material as THREE.MeshStandardMaterial).color;
    // P2.4: use pooled debris via ParticleSystem hook.
    this.onSpawnDebris?.(pos, colorMat, 14);
    // Task-9 (Prompt #33) — Voronoi fracture on real geometry. Pre-fracture
    // the prop's mesh into 4-8 voronoi shards, spawn each as a dynamic body
    // in the ImpulsePhysicsBackend (with outward velocity from the prop's
    // center), and add a Three.js mesh per shard. Shards fall with real
    // physics (gravity + AABB collision vs level colliders + each other),
    // then fade out + despawn after 10s (see updateShards). Uses the
    // original material (cloned per shard) so fractured pieces read as the
    // same surface type as the intact prop. Skipped if the physics backend
    // isn't available (headless / pre-init) — the prop just disappears as
    // before. preFracture may also return <4 shards for very small props
    // (the cell-clipping filter rejects degenerate cells); in that case we
    // fall back to the legacy disappear behavior.
    this.spawnFractureShards(prop);
    // V2 — props now live inside chunk groups, not the scene root. Use
    // removeFromParent() so the mesh is detached regardless of its parent.
    prop.mesh.removeFromParent();
    const ci = ctx.colliders.indexOf(prop.collider); if (ci >= 0) ctx.colliders.splice(ci, 1);
    const di = ctx.destructibles.indexOf(prop); if (di >= 0) ctx.destructibles.splice(di, 1);
  }
  onSpawnDebris?: (point: THREE.Vector3, color: THREE.Color, count: number) => void;

  // ============================================================
  // Task-9 (Prompt #33) — Voronoi fracture shard management.
  //
  // Active shards: { mesh, bodyId, spawnTime, fadeStart }. Each shard's
  // mesh transform is synced from its physics body every tick (the body
  // owns the canonical position; the mesh is a pure render proxy). Shards
  // fade out over the last 1s of their 10s lifetime, then are removed +
  // their bodies released. The list is iterated in-place with swap-pop
  // (no per-frame allocations).
  // ============================================================

  /** Tracked active fracture shard. */
  private _shards: Array<{
    mesh: THREE.Mesh;
    bodyId: number;
    spawnTime: number;
    /** True once the fade-out has started (last 1s of life). */
    fading: boolean;
  }> = [];

  /** Lifetime before a shard despawns (seconds). Per spec — 10s. */
  private static readonly SHARD_LIFETIME_S = 10;
  /** Fade-out window (last N seconds of life). */
  private static readonly SHARD_FADE_WINDOW_S = 1;
  /** Number of voronoi shards per fracture (spec: 4-8). */
  private static readonly SHARD_COUNT = 6;
  /** Outward velocity magnitude (m/s) for spawned shards. */
  private static readonly SHARD_FORCE = 4.5;

  /**
   * Task-9 — Pre-fracture the prop's mesh into voronoi shards, spawn each
   * as a dynamic body in the physics backend + a Three.js mesh in the scene.
   * Called from destroyProp. No-op if the physics backend is unavailable
   * (the prop just disappears as before).
   */
  private spawnFractureShards(prop: import("./types").DestructibleProp): void {
    const { ctx } = this;
    const backend = ctx.physicsBackend;
    if (!backend) return; // no physics — fall back to legacy disappear
    // The prop mesh may be parented to a chunk group; compute its world
    // AABB + world position so shards spawn at the correct world location.
    const mesh = prop.mesh;
    mesh.updateMatrixWorld(true);
    // preFracture uses setFromObject which respects world transforms.
    const fractured = preFracture(mesh, EnemySystem.SHARD_COUNT);
    if (fractured.shards.length < 4) return; // too few shards — skip
    // Impact point = prop center (shards fly outward from the center).
    const aabb = fractured.aabb;
    const impactPoint = aabb.min.clone().add(aabb.max).multiplyScalar(0.5);
    const activated = activateShards(fractured, impactPoint, EnemySystem.SHARD_FORCE);
    if (activated.length === 0) return;
    const now = performance.now();
    for (const { mesh: shardMesh, velocity, center } of activated) {
      // Add the shard mesh to the scene root (not the chunk group — chunk
      // streaming would cull it when the player walks away, but the shard
      // may roll/slide into a different chunk).
      ctx.scene.add(shardMesh);
      // Add a dynamic body sized to the shard's local AABB. The shard mesh
      // geometry is in local space (vertices relative to `center`), so the
      // body's half-extents come from the local-space bounding box.
      const localBox = new THREE.Box3().setFromObject(shardMesh);
      // setFromObject returns a world-space box; convert back to local by
      // subtracting the mesh's current world position.
      const halfExtents = new THREE.Vector3();
      localBox.getSize(halfExtents).multiplyScalar(0.5);
      // Clamp half-extents to a sane minimum so very thin shards still
      // collide (avoids tunneling through the floor).
      halfExtents.x = Math.max(0.05, halfExtents.x);
      halfExtents.y = Math.max(0.05, halfExtents.y);
      halfExtents.z = Math.max(0.05, halfExtents.z);
      const bodyId = backend.addDynamicBody({
        position: center,
        mass: halfExtents.x * halfExtents.y * halfExtents.z * 200, // density 200 kg/m³
        box: {
          min: halfExtents.clone().multiplyScalar(-1),
          max: halfExtents.clone(),
        },
      });
      // Apply the outward velocity as an impulse (Δv = J / m; impulse = m·v).
      const body = backend.getDynamicBodies().find((b) => b.id === bodyId);
      const mass = body?.mass ?? 1;
      backend.applyImpulse(bodyId, velocity.clone().multiplyScalar(mass));
      this._shards.push({
        mesh: shardMesh,
        bodyId,
        spawnTime: now,
        fading: false,
      });
    }
  }

  /**
   * Task-9 — Per-frame shard update. Syncs each shard mesh's transform
   * from its physics body, then fades + despawns shards that have lived
   * past SHARD_LIFETIME_S. Called from update() before any early-return
   * so shards always tick (even during wave transitions / match-over).
   */
  private updateShards(dt: number): void {
    const { ctx } = this;
    if (this._shards.length === 0) return;
    const backend = ctx.physicsBackend;
    if (!backend) return;
    const now = performance.now();
    const lifetimeMs = EnemySystem.SHARD_LIFETIME_S * 1000;
    const fadeMs = EnemySystem.SHARD_FADE_WINDOW_S * 1000;
    // Iterate in-place with swap-pop (no per-frame allocation).
    for (let i = 0; i < this._shards.length; /* noop */) {
      const s = this._shards[i];
      const age = now - s.spawnTime;
      // Sync mesh transform from physics body.
      const xf = backend.getBodyTransform(s.bodyId);
      if (xf) {
        s.mesh.position.copy(xf.position);
        s.mesh.quaternion.copy(xf.rotation);
      }
      // Fade out over the last SHARD_FADE_WINDOW_S seconds of life.
      if (age > lifetimeMs - fadeMs && !s.fading) {
        s.fading = true;
        const mats = Array.isArray(s.mesh.material) ? s.mesh.material : [s.mesh.material];
        for (const m of mats) {
          (m as THREE.Material).transparent = true;
          (m as THREE.Material).depthWrite = false;
        }
      }
      if (s.fading) {
        const fadeT = Math.max(0, Math.min(1, (lifetimeMs - age) / fadeMs));
        const mats = Array.isArray(s.mesh.material) ? s.mesh.material : [s.mesh.material];
        for (const m of mats) {
          (m as THREE.Material).opacity = fadeT;
        }
      }
      // Despawn when lifetime expires.
      if (age >= lifetimeMs) {
        ctx.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        const mats = Array.isArray(s.mesh.material) ? s.mesh.material : [s.mesh.material];
        for (const m of mats) m.dispose();
        backend.removeBody(s.bodyId);
        // Swap-pop: move last element into i, then drop the tail.
        const last = this._shards.length - 1;
        this._shards[i] = this._shards[last];
        this._shards.pop();
        // Don't increment i — re-process the swapped-in element.
      } else {
        i++;
      }
    }
  }

  clearEnemies() {
    const { ctx } = this;
    for (const e of ctx.enemies) ctx.scene.remove(e.group);
    ctx.enemies = [];
  }

  /** V5.4 — Deploy recon drone: reveals all enemies on the minimap for 8s. */
  deployRecon(): boolean {
    const { ctx } = this;
    if (!ctx.match.reconReady || ctx.match.matchOver) return false;
    ctx.match.reconReady = false;
    ctx.match.reconActiveUntil = performance.now() + 8000;
    ctx.pushHud({ objective: "RECON DRONE DEPLOYED — enemies marked 8s" });
    ctx.audio.enemyDeath(); // reuse an existing cue as the deploy sound
    return true;
  }

  /** V5.4 — Deploy airstrike: damages every alive enemy for 60 HP. */
  deployAirstrike(): boolean {
    const { ctx } = this;
    if (!ctx.match.airstrikeReady || ctx.match.matchOver) return false;
    ctx.match.airstrikeReady = false;
    ctx.triggerShake(0.5);
    for (const e of ctx.enemies) {
      if (!e.alive) continue;
      // 60 HP AoE — may kill weaker enemies outright.
      this.damageEnemy(e, 60, false, e.group.position.clone());
    }
    ctx.pushHud({ objective: "AIRSTRIKE INBOUND — hostiles suppressed" });
    return true;
  }
}

export { useGameStore };
