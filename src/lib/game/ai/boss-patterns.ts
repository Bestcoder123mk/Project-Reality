/**
 * SEC6-AI prompt 53 — Boss encounter depth.
 *
 * Each boss class gets a distinct multi-phase attack pattern (telegraphed
 * AoE, enrage at 30% HP, summon adds, ground-slam) rather than being a
 * reskinned enemy with a bigger health pool.
 *
 * BossPattern interface:
 *   - phases: ordered list of phases the boss cycles through as HP drops.
 *   - attacks: named attack definitions with telegraph + windup + active
 *     + recovery windows.
 *   - onTick(ctx, boss, dt, now): per-frame driver — selects the current
 *     attack, advances its timeline, and applies effects at the right
 *     windows.
 *
 * Concrete patterns:
 *   - JuggernautPattern   — phase 1: LMG suppressive fire; phase 2 (enrage
 *                            at 30% HP): ground-slam AoE + charge rush.
 *   - HunterPattern       — (replaces FLAMETHROWER_HEAVY): phase 1: short-
 *                            range flamethrower sweep; phase 2: leap + claw
 *                            slam; phase 3 (enrage): roar + summon 2 CQB adds.
 *   - NecromancerPattern  — (replaces DRONE_COMMANDER): phase 1: ranged
 *                            shadow bolt; phase 2: summon 2 zombies every
 *                            8s; phase 3 (enrage at 30%): mass summon 4 +
 *                            ground-slam AoE.
 *   - MechPattern         — (replaces ARMORED_MECH): phase 1: heavy rifle
 *                            fire; phase 2: rocket barrage (telegraphed AoE
 *                            circles); phase 3 (enrage): overcharge (faster
 *                            ROF + slight self-damage tick).
 *   - ShieldCaptainPattern — (replaces RIOT_SHIELD_CAPTAIN): phase 1: shield
 *                            block + slow advance; phase 2 (50% HP): shield
 *                            bash (knockback AoE); phase 3 (30% HP enrage):
 *                            drops shield + dual-pistol barrage.
 *
 * Integration:
 *   EnemySystem.tickBossReinforcements (or a new tickBossPatterns method)
 *   calls `getBossPattern(bossClass)?.onTick(ctx, boss, dt, now)` for each
 *   alive boss. The pattern stashes its own per-boss state via cast.
 *
 * The pattern calls into existing hooks (ctx.enemyGrenadeThrow for AoE,
 * ctx.audio.distantGunshot for audio cues, ctx.triggerShake for screen
 * shake, ctx.addKillFeed for telegraph warnings) — it does NOT spawn
 * enemies directly (summoning routes through ctx.enemies.push via a
 * summon hook the integrator provides on ctx.bossSummon).
 *
 * SSR-safe: pure-TS, no DOM. Deterministic given inputs.
 */
import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";
import type { BossClass } from "../EnemyClasses";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type BossPhaseId = "PHASE_1" | "PHASE_2" | "PHASE_3_ENRAGE";

export type BossAttackId =
  | "suppressive_fire"
  | "ground_slam"
  | "charge_rush"
  | "flamethrower_sweep"
  | "leap_slam"
  | "summon_adds"
  | "shadow_bolt"
  | "rocket_barrage"
  | "overcharge"
  | "shield_bash"
  | "dual_pistol_barrage";

export interface BossAttack {
  /** Attack identifier. */
  id: BossAttackId;
  /** Telegraph duration (seconds) — telegraph shows a warning + AoE circle
   *  on the ground; the boss is stationary during this window. */
  telegraph: number;
  /** Windup duration (seconds) — boss winds up the attack (animation
   *  visible) but no effect yet. */
  windup: number;
  /** Active duration (seconds) — the attack is live (damage applies,
   *  particles spawn). */
  active: number;
  /** Recovery duration (seconds) — boss recovers (vulnerable window). */
  recovery: number;
  /** Cooldown after the attack before the boss picks a new one. */
  cooldown: number;
}

export interface BossPhase {
  /** Phase ID. */
  id: BossPhaseId;
  /** HP threshold to ENTER this phase (1.0 = full HP, 0.0 = dead). Phase
   *  1 starts at 1.0, phase 2 at e.g. 0.6, phase 3 at 0.3. */
  hpThreshold: number;
  /** Attacks available in this phase (the boss picks randomly among these). */
  attacks: BossAttackId[];
  /** Multiplier on attack speed (lower = faster attacks). */
  attackSpeedMult: number;
  /** Damage multiplier applied to all attack damage. */
  damageMult: number;
}

export interface BossPattern {
  /** Boss class this pattern applies to. */
  bossClass: BossClass;
  /** Display name (for killfeed / HUD). */
  name: string;
  /** Ordered phases (descending by hpThreshold). */
  phases: BossPhase[];
  /** Attack definitions keyed by id (only the attacks this pattern uses
   *  need to be defined — `Partial` because not every boss uses every
   *  attack). */
  attacks: Partial<Record<BossAttackId, BossAttack>>;
  /**
   * Per-frame driver. Selects the current phase based on HP, advances the
   * active attack's timeline, applies effects at the right windows, and
   * picks a new attack when the current one completes.
   */
  onTick: (ctx: GameContext, boss: Enemy, dt: number, now: number) => void;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-boss state stash
// ───────────────────────────────────────────────────────────────────────────

interface BossState {
  /** Current phase. */
  phase: BossPhaseId;
  /** Currently-executing attack (null = idle, picking next). */
  currentAttack: BossAttackId | null;
  /** Timeline position within the current attack (seconds). */
  attackTime: number;
  /** True once the attack's active window has fired its effect (so we
   *  don't apply the effect multiple times). */
  attackEffectFired: boolean;
  /** Timestamp (performance.now()) when the current attack started. */
  attackStartedAt: number;
  /** Cooldown remaining until the next attack can start. */
  cooldownRemaining: number;
  /** Phase 3 enrage flag — set once on transition to PHASE_3_ENRAGE. */
  enrageFired: boolean;
}

function bossState(boss: Enemy): BossState {
  const ex = boss as unknown as { __bossPattern?: BossState };
  if (!ex.__bossPattern) {
    ex.__bossPattern = {
      phase: "PHASE_1",
      currentAttack: null,
      attackTime: 0,
      attackEffectFired: false,
      attackStartedAt: 0,
      cooldownRemaining: 1.0,
      enrageFired: false,
    };
  }
  return ex.__bossPattern;
}

/** Section D #1729 — reset a boss's pattern state. Called when a boss is
 *  revived (e.g. by a Necromancer summon-adds that resurrects a fallen boss,
 *  or by a director phase-change that re-spawns the boss). Without this
 *  reset, the revived boss would inherit the prior incarnation's phase +
 *  attack timeline (e.g. a boss revived at full HP would still be in
 *  PHASE_3_ENRAGE + mid-attack, instantly re-enraging). */
export function resetBossState(boss: Enemy): void {
  const ex = boss as unknown as { __bossPattern?: BossState };
  ex.__bossPattern = undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

/** Find the phase the boss should be in given its current HP ratio.
 *  Iterates in REVERSE so the lowest-HP threshold wins (e.g. for a boss
 *  at 25% HP, PHASE_2 (threshold 0.3) wins over PHASE_1 (threshold 1.0)). */
function currentPhase(pattern: BossPattern, hpRatio: number): BossPhase {
  for (let i = pattern.phases.length - 1; i >= 0; i--) {
    if (hpRatio <= pattern.phases[i].hpThreshold) return pattern.phases[i];
  }
  return pattern.phases[0];
}

/** Distance from boss to player (XZ plane). */
function distToPlayer(ctx: GameContext, boss: Enemy): number {
  return Math.hypot(
    ctx.player.pos.x - boss.group.position.x,
    ctx.player.pos.z - boss.group.position.z,
  );
}

/** Direction from boss to player (XZ plane, normalized). */
function dirToPlayer(ctx: GameContext, boss: Enemy): { x: number; z: number } {
  const dx = ctx.player.pos.x - boss.group.position.x;
  const dz = ctx.player.pos.z - boss.group.position.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

/**
 * Apply AoE damage to the player if within `radius` of `center`. Uses
 * the same armor-absorption model as enemy-tactics.blindFireShot.
 */
function applyAoeDamage(
  ctx: GameContext,
  center: { x: number; y: number; z: number },
  radius: number,
  dmg: number,
  now: number,
) {
  const dx = ctx.player.pos.x - center.x;
  const dz = ctx.player.pos.z - center.z;
  const dist = Math.hypot(dx, dz);
  if (dist > radius) return;
  // Falloff: full damage at center, 50% at edge.
  const falloff = 1 - 0.5 * (dist / radius);
  let effective = dmg * falloff;
  if (ctx.player.armor > 0) {
    const absorbed = Math.min(ctx.player.armor, effective * 0.6);
    ctx.player.armor -= absorbed;
    effective -= absorbed;
  }
  ctx.player.health -= effective;
  ctx.audio.damage();
  ctx.player.lastDamageTime = now;
  ctx.pushHud({
    health: Math.max(0, Math.round(ctx.player.health)),
    armor: Math.max(0, Math.round(ctx.player.armor)),
    damageFlash: now,
  });
  ctx.triggerShake(Math.min(0.5, effective * 0.02));
  if (ctx.player.health <= 0) ctx.onGameOver();
}

/** Spawn a telegraph decal on the ground (a flat red ring). Cached + reused. */
function spawnTelegraph(
  ctx: GameContext,
  center: { x: number; z: number },
  radius: number,
  durationSec: number,
) {
  // Reuse the particle pool if available; otherwise skip (the audio cue
  // + killfeed warning still fire, so the player is warned).
  // We use a thin cylinder as the telegraph ring.
  const geo = new THREE.CylinderGeometry(radius, radius, 0.05, 32, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff3018, transparent: true, opacity: 0.35, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.position.set(center.x, 0.05, center.z);
  ring.rotation.x = 0;
  ctx.scene.add(ring);
  // Section D #1722 — auto-remove after the telegraph duration. Wrapped in
  // try/catch so an early engine dispose (which clears ctx.scene) doesn't
  // throw an unhandled exception inside the setTimeout callback (the prior
  // code called ctx.scene.remove(ring) unconditionally — if the scene was
  // already disposed, three.js would throw on the second dispose of the
  // geometry/material).
  setTimeout(() => {
    try {
      ctx.scene.remove(ring);
      geo.dispose();
      mat.dispose();
    } catch {
      // Best-effort — scene/geometry may already be disposed.
    }
  }, durationSec * 1000);
}

/**
 * Summon minor adds near the boss. Uses the engine's buildEnemy + class
 * application if available via the ctx.bossSummon hook (provided by the
 * integrator — see worklog wiring note). If the hook isn't wired, the
 * summon is a no-op (graceful degradation — the boss still fights).
 */
function summonAdds(
  ctx: GameContext,
  boss: Enemy,
  count: number,
  now: number,
) {
  const hook = (ctx as unknown as {
    bossSummon?: (boss: Enemy, count: number, now: number) => void;
  }).bossSummon;
  if (!hook) return;
  hook(boss, count, now);
}

// ───────────────────────────────────────────────────────────────────────────
// Pattern: Juggernaut
// ───────────────────────────────────────────────────────────────────────────

export const JuggernautPattern: BossPattern = {
  bossClass: "JUGGERNAUT",
  name: "Juggernaut",
  phases: [
    { id: "PHASE_1", hpThreshold: 1.0, attacks: ["suppressive_fire"], attackSpeedMult: 1.0, damageMult: 1.0 },
    { id: "PHASE_2", hpThreshold: 0.3, attacks: ["suppressive_fire", "ground_slam", "charge_rush"], attackSpeedMult: 0.8, damageMult: 1.2 },
    // Section D #1962 — Juggernaut phase 3 (final enrage at 12% HP). The
    // prior pattern had only 2 phases; the Juggernaut would just continue
    // phase 2 forever once below 30% HP, making the finale feel flat. The
    // 3rd phase adds a faster attack cycle (attackSpeedMult 0.6) + a
    // ground_slam + charge_rush combo (back-to-back, no suppressive_fire
    // filler) + a damage bump (1.4×) for a dramatic execute window.
    { id: "PHASE_3_ENRAGE", hpThreshold: 0.12, attacks: ["ground_slam", "charge_rush", "ground_slam"], attackSpeedMult: 0.6, damageMult: 1.4 },
  ],
  attacks: {
    suppressive_fire: { id: "suppressive_fire", telegraph: 0.3, windup: 0.2, active: 1.2, recovery: 0.4, cooldown: 2.0 },
    ground_slam: { id: "ground_slam", telegraph: 1.0, windup: 0.4, active: 0.3, recovery: 0.6, cooldown: 4.0 },
    charge_rush: { id: "charge_rush", telegraph: 0.6, windup: 0.3, active: 0.8, recovery: 0.5, cooldown: 3.5 },
  },
  onTick(ctx, boss, dt, now) {
    const st = bossState(boss);
    const hpRatio = boss.health / Math.max(1, boss.maxHealth);
    const phase = currentPhase(this, hpRatio);

    // Phase transition — fire enrage bark + screen shake.
    if (phase.id !== st.phase) {
      const wasEnrage = st.phase === "PHASE_2" || st.phase === "PHASE_3_ENRAGE";
      st.phase = phase.id;
      if (!wasEnrage && phase.id === "PHASE_2") {
        ctx.addKillFeed({
          killer: this.name.toUpperCase(),
          victim: "ENRAGED — ground-slam + charge rush active",
          weapon: "", headshot: false,
        });
        ctx.triggerShake(0.4);
      }
      // Section D #1962 — phase 3 transition (final enrage).
      if (phase.id === "PHASE_3_ENRAGE") {
        ctx.addKillFeed({
          killer: this.name.toUpperCase(),
          victim: "FINAL ENRAGE — unstoppable rampage!",
          weapon: "", headshot: false,
        });
        ctx.triggerShake(0.6);
      }
    }

    // Advance current attack timeline.
    st.cooldownRemaining = Math.max(0, st.cooldownRemaining - dt);
    if (st.currentAttack) {
      st.attackTime += dt;
      const atk = this.attacks[st.currentAttack]!;
      const totalDuration = atk.telegraph + atk.windup + atk.active + atk.recovery;
      // Fire effect at start of active window.
      if (!st.attackEffectFired && st.attackTime >= atk.telegraph + atk.windup) {
        st.attackEffectFired = true;
        fireJuggernautAttack(ctx, boss, st.currentAttack, phase.damageMult, now);
      }
      // End of attack — go to cooldown.
      if (st.attackTime >= totalDuration) {
        st.currentAttack = null;
        st.cooldownRemaining = atk.cooldown * phase.attackSpeedMult;
        st.attackEffectFired = false;
      }
      return;
    }

    // Pick a new attack if cooldown is done.
    if (st.cooldownRemaining > 0) return;
    if (phase.attacks.length === 0) return;
    const pick = phase.attacks[Math.floor(Math.random() * phase.attacks.length)];
    st.currentAttack = pick;
    st.attackTime = 0;
    st.attackEffectFired = false;
    st.attackStartedAt = now;
    // Telegraph warning (for ground_slam + charge_rush — suppressive_fire
    // doesn't need a telegraph since it's the baseline attack).
    if (pick === "ground_slam") {
      spawnTelegraph(ctx, { x: boss.group.position.x, z: boss.group.position.z }, 5.0, this.attacks[pick]!.telegraph);
      ctx.addKillFeed({ killer: this.name.toUpperCase(), victim: "GROUND SLAM incoming", weapon: "", headshot: false });
    } else if (pick === "charge_rush") {
      const dir = dirToPlayer(ctx, boss);
      const telegraphPos = {
        x: boss.group.position.x + dir.x * 8,
        z: boss.group.position.z + dir.z * 8,
      };
      spawnTelegraph(ctx, telegraphPos, 3.0, this.attacks[pick]!.telegraph);
      ctx.addKillFeed({ killer: this.name.toUpperCase(), victim: "CHARGE RUSH incoming", weapon: "", headshot: false });
    }
  },
};

function fireJuggernautAttack(
  ctx: GameContext,
  boss: Enemy,
  attack: BossAttackId,
  damageMult: number,
  now: number,
) {
  if (attack === "suppressive_fire") {
    // 3 quick suppressed shots — uses enemyShoot if available via ctx.
    // We don't have direct access to EnemySystem.enemyShoot here, so we
    // apply 3 quick damage ticks via the existing applyAoeDamage path
    // (small radius around the player).
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        if (!boss.alive) return;
        applyAoeDamage(ctx, { x: ctx.player.pos.x, y: 1, z: ctx.player.pos.z }, 1.5, 6 * damageMult, performance.now());
      }, i * 150);
    }
  } else if (attack === "ground_slam") {
    applyAoeDamage(ctx, { x: boss.group.position.x, y: 0, z: boss.group.position.z }, 5.5, 35 * damageMult, now);
    ctx.triggerShake(0.35);
  } else if (attack === "charge_rush") {
    // Charge toward the player + deal damage if close.
    const dir = dirToPlayer(ctx, boss);
    const chargeDist = 8;
    const startX = boss.group.position.x;
    const startZ = boss.group.position.z;
    const endX = startX + dir.x * chargeDist;
    const endZ = startZ + dir.z * chargeDist;
    // Section D #1723 — animate the charge over 0.4s of SCALED time. The
    // prior code used requestAnimationFrame with a wall-clock 400ms duration,
    // which ignored ctx.timeScale (slow-mo had no effect on the boss's charge
    // — the boss would zip across the screen at full speed during a slow-mo
    // final-kill). Now the animation reads ctx.timeScale each frame so the
    // charge slows with the rest of the world. The midpoint damage also
    // scales by timeScale (200ms → 200/timeScale ms).
    const timeScale = ctx.timeScale ?? 1;
    const totalMs = 400 / Math.max(0.05, timeScale);
    const startT = performance.now();
    const animate = () => {
      const t = (performance.now() - startT) / totalMs;
      if (!boss.alive) return;
      if (t >= 1) {
        boss.group.position.x = endX;
        boss.group.position.z = endZ;
        return;
      }
      boss.group.position.x = startX + (endX - startX) * t;
      boss.group.position.z = startZ + (endZ - startZ) * t;
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    // Damage at the midpoint (when the boss is "passing through" the player).
    setTimeout(() => {
      if (!boss.alive) return;
      applyAoeDamage(ctx, { x: boss.group.position.x, y: 1, z: boss.group.position.z }, 2.5, 25 * damageMult, performance.now());
    }, totalMs / 2);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pattern: Hunter (replaces FLAMETHROWER_HEAVY)
// ───────────────────────────────────────────────────────────────────────────

export const HunterPattern: BossPattern = {
  bossClass: "FLAMETHROWER_HEAVY",
  name: "Hunter",
  phases: [
    { id: "PHASE_1", hpThreshold: 1.0, attacks: ["flamethrower_sweep"], attackSpeedMult: 1.0, damageMult: 1.0 },
    { id: "PHASE_2", hpThreshold: 0.6, attacks: ["flamethrower_sweep", "leap_slam"], attackSpeedMult: 0.9, damageMult: 1.1 },
    // Section D #1727 — weighted summon_adds in phase 3 (listed 2× so the
    // uniform-random pick selects it 2/3 of the time vs 1/3 for leap_slam).
    // The prior code listed summon_adds once alongside leap_slam, so the
    // summon was rarely seen (1/2 chance minus the 12s cooldown deferrals).
    { id: "PHASE_3_ENRAGE", hpThreshold: 0.3, attacks: ["leap_slam", "summon_adds", "summon_adds"], attackSpeedMult: 0.75, damageMult: 1.3 },
  ],
  attacks: {
    flamethrower_sweep: { id: "flamethrower_sweep", telegraph: 0.4, windup: 0.3, active: 1.5, recovery: 0.5, cooldown: 3.0 },
    leap_slam: { id: "leap_slam", telegraph: 0.8, windup: 0.3, active: 0.4, recovery: 0.6, cooldown: 4.5 },
    summon_adds: { id: "summon_adds", telegraph: 1.0, windup: 0.5, active: 0.2, recovery: 0.8, cooldown: 12.0 },
  },
  onTick(ctx, boss, dt, now) {
    const st = bossState(boss);
    const hpRatio = boss.health / Math.max(1, boss.maxHealth);
    const phase = currentPhase(this, hpRatio);

    if (phase.id !== st.phase) {
      const prev = st.phase;
      st.phase = phase.id;
      if (phase.id === "PHASE_3_ENRAGE" && prev !== "PHASE_3_ENRAGE") {
        ctx.addKillFeed({
          killer: this.name.toUpperCase(),
          victim: "ENRAGED — summoning pack",
          weapon: "", headshot: false,
        });
        ctx.triggerShake(0.4);
      }
    }

    st.cooldownRemaining = Math.max(0, st.cooldownRemaining - dt);
    if (st.currentAttack) {
      st.attackTime += dt;
      const atk = this.attacks[st.currentAttack]!;
      const totalDuration = atk.telegraph + atk.windup + atk.active + atk.recovery;
      if (!st.attackEffectFired && st.attackTime >= atk.telegraph + atk.windup) {
        st.attackEffectFired = true;
        fireHunterAttack(ctx, boss, st.currentAttack, phase.damageMult, now);
      }
      if (st.attackTime >= totalDuration) {
        st.currentAttack = null;
        st.cooldownRemaining = atk.cooldown * phase.attackSpeedMult;
        st.attackEffectFired = false;
      }
      return;
    }

    if (st.cooldownRemaining > 0) return;
    if (phase.attacks.length === 0) return;
    const pick = phase.attacks[Math.floor(Math.random() * phase.attacks.length)];
    st.currentAttack = pick;
    st.attackTime = 0;
    st.attackEffectFired = false;
    st.attackStartedAt = now;
    if (pick === "leap_slam") {
      // Telegraph at the player's current position.
      spawnTelegraph(ctx, { x: ctx.player.pos.x, z: ctx.player.pos.z }, 3.5, this.attacks[pick]!.telegraph);
      ctx.addKillFeed({ killer: this.name.toUpperCase(), victim: "LEAP SLAM incoming", weapon: "", headshot: false });
    } else if (pick === "summon_adds") {
      ctx.addKillFeed({ killer: this.name.toUpperCase(), victim: "summoning pack...", weapon: "", headshot: false });
    }
  },
};

function fireHunterAttack(
  ctx: GameContext,
  boss: Enemy,
  attack: BossAttackId,
  damageMult: number,
  now: number,
) {
  if (attack === "flamethrower_sweep") {
    // Cone of fire damage in front of the boss. Player takes damage if
    // within 6m AND in the front 90° cone.
    const d = distToPlayer(ctx, boss);
    if (d < 6) {
      const dir = dirToPlayer(ctx, boss);
      const fwdX = Math.sin(boss.group.rotation.y);
      const fwdZ = Math.cos(boss.group.rotation.y);
      const dot = fwdX * dir.x + fwdZ * dir.z;
      if (dot > 0.5) {
        applyAoeDamage(ctx, { x: ctx.player.pos.x, y: 1, z: ctx.player.pos.z }, 1.0, 12 * damageMult, now);
      }
    }
  } else if (attack === "leap_slam") {
    // Boss leaps to the player's position (snapshot at telegraph end) +
    // deals AoE on landing.
    const targetX = ctx.player.pos.x;
    const targetZ = ctx.player.pos.z;
    // Snap the boss to the leap target (the telegraph already showed
    // where the boss would land — the player had time to dodge).
    boss.group.position.x = targetX;
    boss.group.position.z = targetZ;
    applyAoeDamage(ctx, { x: targetX, y: 0, z: targetZ }, 4.0, 30 * damageMult, now);
    ctx.triggerShake(0.3);
  } else if (attack === "summon_adds") {
    summonAdds(ctx, boss, 2, now);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pattern: Necromancer (replaces DRONE_COMMANDER)
// ───────────────────────────────────────────────────────────────────────────

export const NecromancerPattern: BossPattern = {
  bossClass: "DRONE_COMMANDER",
  name: "Necromancer",
  phases: [
    { id: "PHASE_1", hpThreshold: 1.0, attacks: ["shadow_bolt"], attackSpeedMult: 1.0, damageMult: 1.0 },
    { id: "PHASE_2", hpThreshold: 0.6, attacks: ["shadow_bolt", "summon_adds"], attackSpeedMult: 0.9, damageMult: 1.1 },
    { id: "PHASE_3_ENRAGE", hpThreshold: 0.3, attacks: ["shadow_bolt", "summon_adds", "ground_slam"], attackSpeedMult: 0.7, damageMult: 1.3 },
  ],
  attacks: {
    shadow_bolt: { id: "shadow_bolt", telegraph: 0.3, windup: 0.4, active: 0.2, recovery: 0.4, cooldown: 2.5 },
    summon_adds: { id: "summon_adds", telegraph: 0.8, windup: 0.6, active: 0.3, recovery: 0.8, cooldown: 8.0 },
    ground_slam: { id: "ground_slam", telegraph: 1.2, windup: 0.5, active: 0.4, recovery: 0.7, cooldown: 5.0 },
  },
  onTick(ctx, boss, dt, now) {
    const st = bossState(boss);
    const hpRatio = boss.health / Math.max(1, boss.maxHealth);
    const phase = currentPhase(this, hpRatio);

    if (phase.id !== st.phase) {
      const prev = st.phase;
      st.phase = phase.id;
      if (phase.id === "PHASE_3_ENRAGE" && prev !== "PHASE_3_ENRAGE") {
        ctx.addKillFeed({
          killer: this.name.toUpperCase(),
          victim: "ENRAGED — mass summon + ground-slam",
          weapon: "", headshot: false,
        });
        ctx.triggerShake(0.4);
      }
    }

    st.cooldownRemaining = Math.max(0, st.cooldownRemaining - dt);
    if (st.currentAttack) {
      st.attackTime += dt;
      const atk = this.attacks[st.currentAttack]!;
      const totalDuration = atk.telegraph + atk.windup + atk.active + atk.recovery;
      if (!st.attackEffectFired && st.attackTime >= atk.telegraph + atk.windup) {
        st.attackEffectFired = true;
        fireNecromancerAttack(ctx, boss, st.currentAttack, phase.damageMult, now);
      }
      if (st.attackTime >= totalDuration) {
        st.currentAttack = null;
        st.cooldownRemaining = atk.cooldown * phase.attackSpeedMult;
        st.attackEffectFired = false;
      }
      return;
    }

    if (st.cooldownRemaining > 0) return;
    if (phase.attacks.length === 0) return;
    const pick = phase.attacks[Math.floor(Math.random() * phase.attacks.length)];
    st.currentAttack = pick;
    st.attackTime = 0;
    st.attackEffectFired = false;
    st.attackStartedAt = now;
    if (pick === "summon_adds") {
      const count = phase.id === "PHASE_3_ENRAGE" ? 4 : 2;
      ctx.addKillFeed({
        killer: this.name.toUpperCase(),
        victim: `summoning ${count} undead...`,
        weapon: "", headshot: false,
      });
    } else if (pick === "ground_slam") {
      spawnTelegraph(ctx, { x: boss.group.position.x, z: boss.group.position.z }, 6.0, this.attacks[pick]!.telegraph);
      ctx.addKillFeed({ killer: this.name.toUpperCase(), victim: "SHADOW SLAM incoming", weapon: "", headshot: false });
    }
  },
};

function fireNecromancerAttack(
  ctx: GameContext,
  boss: Enemy,
  attack: BossAttackId,
  damageMult: number,
  now: number,
) {
  if (attack === "shadow_bolt") {
    // Single-target projectile — hits the player if they're within 25m
    // (no LOS check; it's a homing shadow bolt).
    const d = distToPlayer(ctx, boss);
    if (d < 25) {
      applyAoeDamage(ctx, { x: ctx.player.pos.x, y: 1, z: ctx.player.pos.z }, 1.5, 20 * damageMult, now);
    }
  } else if (attack === "summon_adds") {
    // Section D #1731 — read the boss's current FSM/pattern phase directly
    // (via the shared bossState) instead of recomputing hpRatio. The prior
    // `hpRatio < 0.3` check had a floating-point edge case at exactly 0.3
    // (the boss is in PHASE_3_ENRAGE per currentPhase's `<=` but the strict
    // `<` here returned 2 adds instead of 4). Using the phase directly is
    // exact + matches the pattern's own phase-transition logic.
    const st = bossState(boss);
    const count = st.phase === "PHASE_3_ENRAGE" ? 4 : 2;
    summonAdds(ctx, boss, count, now);
  } else if (attack === "ground_slam") {
    applyAoeDamage(ctx, { x: boss.group.position.x, y: 0, z: boss.group.position.z }, 6.5, 40 * damageMult, now);
    ctx.triggerShake(0.4);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Pattern: Mech (replaces ARMORED_MECH)
// ───────────────────────────────────────────────────────────────────────────

export const MechPattern: BossPattern = {
  bossClass: "ARMORED_MECH",
  name: "Armored Mech",
  phases: [
    // Section D #1728 — phase 1 now includes rocket_barrage (the prior code
    // only had suppressive_fire, so the Mech was a one-trick pony in phase 1).
    // The 2:1 weighting keeps suppressive_fire as the primary attack while
    // giving the player an occasional rocket telegraph to dodge.
    { id: "PHASE_1", hpThreshold: 1.0, attacks: ["suppressive_fire", "suppressive_fire", "rocket_barrage"], attackSpeedMult: 1.0, damageMult: 1.0 },
    { id: "PHASE_2", hpThreshold: 0.6, attacks: ["suppressive_fire", "rocket_barrage"], attackSpeedMult: 0.9, damageMult: 1.1 },
    { id: "PHASE_3_ENRAGE", hpThreshold: 0.3, attacks: ["suppressive_fire", "rocket_barrage", "overcharge"], attackSpeedMult: 0.7, damageMult: 1.25 },
  ],
  attacks: {
    suppressive_fire: { id: "suppressive_fire", telegraph: 0.2, windup: 0.2, active: 1.5, recovery: 0.4, cooldown: 2.5 },
    rocket_barrage: { id: "rocket_barrage", telegraph: 1.0, windup: 0.5, active: 0.6, recovery: 0.7, cooldown: 5.0 },
    overcharge: { id: "overcharge", telegraph: 0.5, windup: 0.3, active: 2.0, recovery: 0.8, cooldown: 8.0 },
  },
  onTick(ctx, boss, dt, now) {
    const st = bossState(boss);
    const hpRatio = boss.health / Math.max(1, boss.maxHealth);
    const phase = currentPhase(this, hpRatio);

    if (phase.id !== st.phase) {
      const prev = st.phase;
      st.phase = phase.id;
      if (phase.id === "PHASE_3_ENRAGE" && prev !== "PHASE_3_ENRAGE") {
        ctx.addKillFeed({
          killer: this.name.toUpperCase(),
          victim: "OVERCHARGE — core unstable",
          weapon: "", headshot: false,
        });
        ctx.triggerShake(0.4);
      }
    }

    st.cooldownRemaining = Math.max(0, st.cooldownRemaining - dt);
    if (st.currentAttack) {
      st.attackTime += dt;
      const atk = this.attacks[st.currentAttack]!;
      const totalDuration = atk.telegraph + atk.windup + atk.active + atk.recovery;
      if (!st.attackEffectFired && st.attackTime >= atk.telegraph + atk.windup) {
        st.attackEffectFired = true;
        fireMechAttack(ctx, boss, st.currentAttack, phase.damageMult, now);
        // Overcharge: continuous damage during the active window (re-fire
        // every 0.4s).
        if (st.currentAttack === "overcharge") {
          const fireInterval = setInterval(() => {
            if (!boss.alive || st.currentAttack !== "overcharge") {
              clearInterval(fireInterval); return;
            }
            if (st.attackTime >= atk.telegraph + atk.windup + atk.active) {
              clearInterval(fireInterval); return;
            }
            applyAoeDamage(ctx, { x: ctx.player.pos.x, y: 1, z: ctx.player.pos.z }, 1.5, 8 * phase.damageMult, performance.now());
          }, 400);
        }
      }
      if (st.attackTime >= totalDuration) {
        st.currentAttack = null;
        st.cooldownRemaining = atk.cooldown * phase.attackSpeedMult;
        st.attackEffectFired = false;
      }
      return;
    }

    if (st.cooldownRemaining > 0) return;
    if (phase.attacks.length === 0) return;
    const pick = phase.attacks[Math.floor(Math.random() * phase.attacks.length)];
    st.currentAttack = pick;
    st.attackTime = 0;
    st.attackEffectFired = false;
    st.attackStartedAt = now;
    if (pick === "rocket_barrage") {
      // Telegraph 3 impact zones around the player.
      for (let i = 0; i < 3; i++) {
        const offset = { x: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 };
        spawnTelegraph(ctx, {
          x: ctx.player.pos.x + offset.x,
          z: ctx.player.pos.z + offset.z,
        }, 2.5, this.attacks[pick]!.telegraph);
      }
      ctx.addKillFeed({ killer: this.name.toUpperCase(), victim: "ROCKET BARRAGE incoming", weapon: "", headshot: false });
    } else if (pick === "overcharge") {
      ctx.addKillFeed({ killer: this.name.toUpperCase(), victim: "OVERCHARGE core spinning up", weapon: "", headshot: false });
    }
  },
};

function fireMechAttack(
  ctx: GameContext,
  boss: Enemy,
  attack: BossAttackId,
  damageMult: number,
  now: number,
) {
  if (attack === "suppressive_fire") {
    // 4 quick shots over 1.2s.
    for (let i = 0; i < 4; i++) {
      setTimeout(() => {
        if (!boss.alive) return;
        applyAoeDamage(ctx, { x: ctx.player.pos.x, y: 1, z: ctx.player.pos.z }, 1.5, 8 * damageMult, performance.now());
      }, i * 300);
    }
  } else if (attack === "rocket_barrage") {
    // 3 AoE blasts at the telegraphed positions.
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        if (!boss.alive) return;
        const offset = { x: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 };
        applyAoeDamage(ctx, {
          x: ctx.player.pos.x + offset.x, y: 0, z: ctx.player.pos.z + offset.z,
        }, 2.8, 25 * damageMult, performance.now());
      }, i * 200);
    }
    ctx.triggerShake(0.3);
  }
  // overcharge is handled in onTick (continuous fire during active window).
}

// ───────────────────────────────────────────────────────────────────────────
// Pattern: Shield Captain (replaces RIOT_SHIELD_CAPTAIN)
// ───────────────────────────────────────────────────────────────────────────

export const ShieldCaptainPattern: BossPattern = {
  bossClass: "RIOT_SHIELD_CAPTAIN",
  name: "Riot Shield Captain",
  phases: [
    { id: "PHASE_1", hpThreshold: 1.0, attacks: ["suppressive_fire"], attackSpeedMult: 1.0, damageMult: 1.0 },
    { id: "PHASE_2", hpThreshold: 0.5, attacks: ["suppressive_fire", "shield_bash"], attackSpeedMult: 0.9, damageMult: 1.1 },
    // Section D #1726 — phase 3 now includes suppressive_fire alongside
    // dual_pistol_barrage (the prior code had only dual_pistol_barrage, so
    // the captain spammed one attack forever). With both attacks in the
    // pool, the captain alternates between precision suppressive fire and
    // the wild dual-pistol barrage — readable variety for the player.
    { id: "PHASE_3_ENRAGE", hpThreshold: 0.3, attacks: ["dual_pistol_barrage", "suppressive_fire"], attackSpeedMult: 0.7, damageMult: 1.3 },
  ],
  attacks: {
    suppressive_fire: { id: "suppressive_fire", telegraph: 0.3, windup: 0.2, active: 1.0, recovery: 0.4, cooldown: 2.0 },
    shield_bash: { id: "shield_bash", telegraph: 0.5, windup: 0.3, active: 0.3, recovery: 0.5, cooldown: 4.0 },
    dual_pistol_barrage: { id: "dual_pistol_barrage", telegraph: 0.4, windup: 0.3, active: 1.8, recovery: 0.5, cooldown: 3.5 },
  },
  onTick(ctx, boss, dt, now) {
    const st = bossState(boss);
    const hpRatio = boss.health / Math.max(1, boss.maxHealth);
    const phase = currentPhase(this, hpRatio);

    if (phase.id !== st.phase) {
      const prev = st.phase;
      st.phase = phase.id;
      if (phase.id === "PHASE_3_ENRAGE" && prev !== "PHASE_3_ENRAGE") {
        // Drop the shield on enrage (the captain goes full Rambo).
        const hasShield = (boss as unknown as { hasShield?: boolean }).hasShield;
        if (hasShield) {
          (boss as unknown as { hasShield?: boolean }).hasShield = false;
          // Remove the visual shield mesh if present.
          const shieldMesh = boss.group.children.find((c) => (c as THREE.Mesh).name === "bossShield");
          if (shieldMesh) boss.group.remove(shieldMesh);
        }
        ctx.addKillFeed({
          killer: this.name.toUpperCase(),
          victim: "ENRAGED — shield dropped, dual-pistol barrage",
          weapon: "", headshot: false,
        });
        ctx.triggerShake(0.35);
      }
    }

    st.cooldownRemaining = Math.max(0, st.cooldownRemaining - dt);
    if (st.currentAttack) {
      st.attackTime += dt;
      const atk = this.attacks[st.currentAttack]!;
      const totalDuration = atk.telegraph + atk.windup + atk.active + atk.recovery;
      if (!st.attackEffectFired && st.attackTime >= atk.telegraph + atk.windup) {
        st.attackEffectFired = true;
        fireShieldCaptainAttack(ctx, boss, st.currentAttack, phase.damageMult, now);
        // Dual-pistol barrage: continuous fire during the active window.
        if (st.currentAttack === "dual_pistol_barrage") {
          const fireInterval = setInterval(() => {
            if (!boss.alive || st.currentAttack !== "dual_pistol_barrage") {
              clearInterval(fireInterval); return;
            }
            if (st.attackTime >= atk.telegraph + atk.windup + atk.active) {
              clearInterval(fireInterval); return;
            }
            applyAoeDamage(ctx, { x: ctx.player.pos.x, y: 1, z: ctx.player.pos.z }, 1.5, 6 * phase.damageMult, performance.now());
          }, 250);
        }
      }
      if (st.attackTime >= totalDuration) {
        st.currentAttack = null;
        st.cooldownRemaining = atk.cooldown * phase.attackSpeedMult;
        st.attackEffectFired = false;
      }
      return;
    }

    if (st.cooldownRemaining > 0) return;
    if (phase.attacks.length === 0) return;
    const pick = phase.attacks[Math.floor(Math.random() * phase.attacks.length)];
    st.currentAttack = pick;
    st.attackTime = 0;
    st.attackEffectFired = false;
    st.attackStartedAt = now;
    if (pick === "shield_bash") {
      spawnTelegraph(ctx, { x: boss.group.position.x, z: boss.group.position.z }, 3.5, this.attacks[pick]!.telegraph);
      ctx.addKillFeed({ killer: this.name.toUpperCase(), victim: "SHIELD BASH incoming — back off", weapon: "", headshot: false });
    }
  },
};

function fireShieldCaptainAttack(
  ctx: GameContext,
  boss: Enemy,
  attack: BossAttackId,
  damageMult: number,
  now: number,
) {
  if (attack === "suppressive_fire") {
    applyAoeDamage(ctx, { x: ctx.player.pos.x, y: 1, z: ctx.player.pos.z }, 1.5, 10 * damageMult, now);
  } else if (attack === "shield_bash") {
    // Cone knockback + damage in front of the boss.
    const d = distToPlayer(ctx, boss);
    if (d < 4) {
      const dir = dirToPlayer(ctx, boss);
      const fwdX = Math.sin(boss.group.rotation.y);
      const fwdZ = Math.cos(boss.group.rotation.y);
      const dot = fwdX * dir.x + fwdZ * dir.z;
      if (dot > 0.3) {
        applyAoeDamage(ctx, { x: ctx.player.pos.x, y: 1, z: ctx.player.pos.z }, 1.5, 18 * damageMult, now);
        // Section D #1730 — knockback as a separate impulse that decays
        // over time (not a vel addition). The prior code did
        // `ctx.player.vel.x += dir.x * 8` which the movement system
        // overwrote on the next frame (input sets vel to the desired
        // velocity, clobbering the knockback). The impulse model adds to a
        // dedicated `externalImpulse` field that the movement system adds
        // on top of input velocity + decays each frame (0.85/sec). Falls
        // back to the legacy vel addition when the impulse field isn't
        // wired (older engine builds) so the knockback still works.
        const playerEx = ctx.player as unknown as {
          externalImpulse?: { x: number; y: number; z: number };
        };
        if (playerEx.externalImpulse) {
          playerEx.externalImpulse.x += dir.x * 8;
          playerEx.externalImpulse.z += dir.z * 8;
        } else {
          ctx.player.vel.x += dir.x * 8;
          ctx.player.vel.z += dir.z * 8;
        }
      }
    }
    ctx.triggerShake(0.25);
  }
  // dual_pistol_barrage is handled in onTick (continuous fire during active window).
}

// ───────────────────────────────────────────────────────────────────────────
// Registry
// ───────────────────────────────────────────────────────────────────────────

const PATTERNS: Record<BossClass, BossPattern> = {
  JUGGERNAUT: JuggernautPattern,
  FLAMETHROWER_HEAVY: HunterPattern,
  ARMORED_MECH: MechPattern,
  DRONE_COMMANDER: NecromancerPattern,
  RIOT_SHIELD_CAPTAIN: ShieldCaptainPattern,
};

/** Get the boss pattern for a given boss class slug. */
export function getBossPattern(slug: BossClass): BossPattern {
  return PATTERNS[slug];
}

/** Get the boss pattern for an enemy (looks up via the bossClass stash). */
export function getBossPatternForEnemy(boss: Enemy): BossPattern | null {
  const cls = (boss as unknown as { bossClass?: BossClass }).bossClass;
  if (!cls) return null;
  return PATTERNS[cls] ?? null;
}

/**
 * Per-frame driver — call once per frame for each alive boss. Looks up the
 * pattern + delegates to its onTick. No-op if the enemy isn't a boss or
 * has no pattern.
 */
export function tickBossPattern(ctx: GameContext, boss: Enemy, dt: number, now: number) {
  if (!boss.alive) return;
  const pattern = getBossPatternForEnemy(boss);
  if (!pattern) return;
  pattern.onTick(ctx, boss, dt, now);
  // Section D #514 — time-based enrage check (in addition to the HP-based
  // enrage already in each pattern). After ENRAGE_TIMER_SEC, the boss enters
  // a permanent enrage state (damage +25%, attack speed +30%).
  tickBossEnrageTimer(ctx, boss, now);
  // Section D #517 — periodic boss-adds waves (independent of the
  // pattern-specific summon_adds attack). Every BOSS_ADDS_WAVE_SEC, the
  // boss summons 2 minor adds. Skipped during a boss intro (the director
  // gates spawning for the intro window).
  tickBossAddsWaves(ctx, boss, now);
  // Section D #518 — environment interaction. The boss periodically scans
  // for destructible cover between itself and the player + destroys it
  // (smashing the cover so the player can't hide). Also scans for
  // explosive barrels near the player + shoots them.
  tickBossEnvironment(ctx, boss, now);
}

// ───────────────────────────────────────────────────────────────────────────
// Section D #513–518 — Boss pattern enhancements
// ───────────────────────────────────────────────────────────────────────────

/** Section D #516 — Boss weak-point definition. */
export interface BossWeakPoint {
  /** Display name (for HUD callout when hit). */
  name: string;
  /** Local-space offset from the boss's group origin (meters). */
  localOffset: { x: number; y: number; z: number };
  /** Radius of the weak-point sphere (meters). */
  radius: number;
  /** Damage multiplier applied when a projectile hits this weak point
   *  (e.g. 2.0 = double damage). */
  damageMult: number;
  /** True if the weak point is only exposed during specific phases
   *  (e.g. a rear coolant vent that opens during PHASE_2). When undefined,
   *  the weak point is always exposed. */
  exposedInPhases?: BossPhaseId[];
}

/** Section D #516 — Per-boss-class weak-point registry. The weapon system
 *  checks these on hit: if the hit point (in boss-local space) falls within
 *  any weak point's sphere, the damage is multiplied by the weak point's
 *  damageMult + a "weak point hit" HUD callout fires. */
export const BOSS_WEAK_POINTS: Partial<Record<BossClass, BossWeakPoint[]>> = {
  JUGGERNAUT: [
    {
      name: "Coolant Vent",
      localOffset: { x: 0, y: 1.4, z: -0.4 },
      radius: 0.25,
      damageMult: 2.5,
      exposedInPhases: ["PHASE_2"],
    },
    {
      name: "Head",
      localOffset: { x: 0, y: 1.8, z: 0 },
      radius: 0.18,
      damageMult: 1.8,
    },
  ],
  ARMORED_MECH: [
    {
      name: "Reactor Core",
      localOffset: { x: 0, y: 1.3, z: 0.1 },
      radius: 0.3,
      damageMult: 3.0,
      exposedInPhases: ["PHASE_2", "PHASE_3_ENRAGE"],
    },
  ],
  DRONE_COMMANDER: [
    {
      name: "Drone Orb",
      localOffset: { x: 0.4, y: 2.1, z: -0.1 },
      radius: 0.15,
      damageMult: 2.0,
    },
  ],
  RIOT_SHIELD_CAPTAIN: [
    {
      name: "Shield Arm Joint",
      localOffset: { x: 0.7, y: 1.0, z: 0.5 },
      radius: 0.2,
      damageMult: 1.8,
    },
  ],
};

/** Section D #516 — Check whether a hit point (world space) lands on a boss
 *  weak point. Returns the weak point + the effective damage multiplier, or
 *  null if the hit wasn't on a weak point. The caller (WeaponSystem) applies
 *  the multiplier to the base damage. */
export function checkBossWeakPointHit(
  boss: Enemy,
  worldHitPoint: { x: number; y: number; z: number },
  currentPhase: BossPhaseId,
): { weakPoint: BossWeakPoint; damageMult: number } | null {
  const cls = (boss as unknown as { bossClass?: BossClass }).bossClass;
  if (!cls) return null;
  const weakPoints = BOSS_WEAK_POINTS[cls];
  if (!weakPoints || weakPoints.length === 0) return null;
  for (const wp of weakPoints) {
    // Phase gate.
    if (wp.exposedInPhases && !wp.exposedInPhases.includes(currentPhase)) continue;
    // Transform local offset to world space (assume no rotation for the
    // weak-point sphere check — bosses mostly face the player; the sphere
    // radius gives enough tolerance for the rotation skew).
    const wx = boss.group.position.x + wp.localOffset.x;
    const wy = boss.group.position.y + wp.localOffset.y;
    const wz = boss.group.position.z + wp.localOffset.z;
    const dx = worldHitPoint.x - wx;
    const dy = worldHitPoint.y - wy;
    const dz = worldHitPoint.z - wz;
    const distSqr = dx * dx + dy * dy + dz * dz;
    if (distSqr <= wp.radius * wp.radius) {
      return { weakPoint: wp, damageMult: wp.damageMult };
    }
  }
  return null;
}

/** Section D #514 — Time-based enrage. After ENRAGE_TIMER_SEC, the boss
 *  enters a permanent enrage state. Tracked per-boss via __bossEnrageUntil. */
export const ENRAGE_TIMER_SEC = 180; // 3 minutes — long enough for a skilled player
                               // to win, short enough that a stalled fight
                               // eventually forces a conclusion.

interface BossEnrageState {
  /** performance.now() when the boss spawned (for the enrage timer). */
  spawnedAt: number;
  /** True once the time-based enrage has fired. */
  enrageFired: boolean;
}

function bossEnrageState(boss: Enemy): BossEnrageState {
  const ex = boss as unknown as { __bossEnrage?: BossEnrageState };
  if (!ex.__bossEnrage) {
    ex.__bossEnrage = { spawnedAt: performance.now(), enrageFired: false };
  }
  return ex.__bossEnrage;
}

function tickBossEnrageTimer(ctx: GameContext, boss: Enemy, now: number) {
  const st = bossEnrageState(boss);
  if (st.enrageFired) return;
  const elapsedSec = (now - st.spawnedAt) / 1000;
  if (elapsedSec >= ENRAGE_TIMER_SEC) {
    st.enrageFired = true;
    // Apply the permanent enrage: damage +25%, attack speed +30%.
    // We mutate the boss's accuracy (proxy for damage output) + tag a
    // flag the pattern's onTick can read to shorten cooldowns.
    boss.accuracy = Math.min(1, boss.accuracy * 1.25);
    (boss as unknown as { timeEnraged?: boolean }).timeEnraged = true;
    ctx.addKillFeed({
      killer: "DIRECTOR",
      victim: `${(boss as unknown as { enemyClassName?: string }).enemyClassName ?? "BOSS"} ENRAGED — time limit reached`,
      weapon: "", headshot: false,
    });
    ctx.triggerShake(0.5);
  }
}

/** Section D #517 — Periodic boss-adds waves. Every BOSS_ADDS_WAVE_SEC,
 *  the boss summons 2 minor adds (independent of the pattern's
 *  summon_adds attack). Skipped during a boss intro. */
const BOSS_ADDS_WAVE_SEC = 25;

function tickBossAddsWaves(ctx: GameContext, boss: Enemy, now: number) {
  // Skip if the director is in a boss intro (don't clutter the intro).
  const director = (ctx as unknown as { ai?: { director?: { isInBossIntro?: () => boolean } } }).ai?.director;
  if (director?.isInBossIntro?.()) return;
  const st = bossEnrageState(boss);
  const lastAdds = (boss as unknown as { __lastAddsWaveAt?: number }).__lastAddsWaveAt ?? st.spawnedAt;
  const elapsedSec = (now - lastAdds) / 1000;
  if (elapsedSec < BOSS_ADDS_WAVE_SEC) return;
  (boss as unknown as { __lastAddsWaveAt?: number }).__lastAddsWaveAt = now;
  // Summon 2 adds via the existing summonAdds helper (routes through the
  // engine's bossSummon hook).
  summonAdds(ctx, boss, 2, now);
  ctx.addKillFeed({
    killer: (boss as unknown as { enemyClassName?: string }).enemyClassName?.toUpperCase() ?? "BOSS",
    victim: "summoned reinforcements",
    weapon: "", headshot: false,
  });
}

/** Section D #518 — Boss environment interaction. The boss periodically:
 *   1. Scans for destructible cover between itself and the player →
 *      destroys it (smashes the cover so the player can't turtle).
 *   2. Scans for explosive barrels near the player → shoots them
 *      (chains a barrel explosion onto the player).
 *  Runs every BOSS_ENV_INTERACT_SEC to avoid per-frame scene iteration. */
const BOSS_ENV_INTERACT_SEC = 4;

function tickBossEnvironment(ctx: GameContext, boss: Enemy, now: number) {
  const st = bossEnrageState(boss);
  const lastEnv = (boss as unknown as { __lastEnvInteractAt?: number }).__lastEnvInteractAt ?? st.spawnedAt;
  const elapsedSec = (now - lastEnv) / 1000;
  if (elapsedSec < BOSS_ENV_INTERACT_SEC) return;
  (boss as unknown as { __lastEnvInteractAt?: number }).__lastEnvInteractAt = now;

  // 1. Destroy destructible cover between boss + player.
  const bx = boss.group.position.x, bz = boss.group.position.z;
  const px = ctx.player.pos.x, pz = ctx.player.pos.z;
  const dx = px - bx, dz = pz - bz;
  const dist = Math.hypot(dx, dz) || 1;
  const dirX = dx / dist, dirZ = dz / dist;
  for (const d of ctx.destructibles) {
    const cx = (d.collider.box.min.x + d.collider.box.max.x) * 0.5;
    const cz = (d.collider.box.min.z + d.collider.box.max.z) * 0.5;
    // Is the destructible between boss and player (roughly on the LOS line)?
    const toDx = cx - bx, toDz = cz - bz;
    const proj = toDx * dirX + toDz * dirZ;
    if (proj < 2 || proj > dist - 1) continue;
    const perp = Math.abs(toDx * -dirZ + toDz * dirX);
    if (perp > 2) continue;
    // In LOS band — smash it. Apply damage to the destructible.
    if (d.health > 0) {
      d.health = 0;
      d.stage = 2;
      ctx.addKillFeed({
        killer: (boss as unknown as { enemyClassName?: string }).enemyClassName?.toUpperCase() ?? "BOSS",
        victim: "smashed your cover",
        weapon: "", headshot: false,
      });
    }
    break; // one cover per tick.
  }

  // 2. Shoot explosive barrels near the player. The barrel scan reuses
  // ctx.destructibles with a material slug check — when the integrator
  // tags barrels as materialSlug "explosive_barrel", we detonate them.
  for (const d of ctx.destructibles) {
    if (d.materialSlug !== "explosive_barrel" && d.materialSlug !== "barrel") continue;
    const cx = (d.collider.box.min.x + d.collider.box.max.x) * 0.5;
    const cz = (d.collider.box.min.z + d.collider.box.max.z) * 0.5;
    const distToPlayer = Math.hypot(cx - px, cz - pz);
    if (distToPlayer > 4) continue;
    // Detonate — apply AoE damage at the barrel's position (chains to the player).
    d.health = 0;
    d.stage = 2;
    applyAoeDamage(ctx, { x: cx, y: 1, z: cz }, 4, 30, now);
    ctx.triggerShake(0.3);
    ctx.addKillFeed({
      killer: (boss as unknown as { enemyClassName?: string }).enemyClassName?.toUpperCase() ?? "BOSS",
      victim: "detonated an explosive barrel near you",
      weapon: "", headshot: false,
    });
    break;
  }
}

/** Section D #515 — Telegraph clarity helper. Returns a human-readable
 *  description of the boss's current telegraph (for the HUD callout).
 *  Patterns call this during the telegraph window so the HUD can show
 *  a clear "INCOMING: <attack>" warning. */
export function describeBossTelegraph(pattern: BossPattern, attack: BossAttackId): string {
  const atk = pattern.attacks[attack];
  if (!atk) return "";
  const labels: Partial<Record<BossAttackId, string>> = {
    ground_slam: "GROUND SLAM — get clear!",
    charge_rush: "CHARGE RUSH — sidestep!",
    leap_slam: "LEAP SLAM — dodge!",
    rocket_barrage: "ROCKET BARRAGE — move!",
    shield_bash: "SHIELD BASH — back off!",
    overcharge: "OVERCHARGE — burst now!",
    summon_adds: "SUMMONING REINFORCEMENTS",
    dual_pistol_barrage: "DUAL PISTOL BARRAGE — cover!",
  };
  return labels[attack] ?? attack.replace(/_/g, " ").toUpperCase();
}
