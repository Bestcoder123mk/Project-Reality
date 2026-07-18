import * as THREE from "three";
import type { GameSystem, GameContext, Enemy } from "./types";
import {
  getCombo,
  getComboDamage,
  getComboRange,
  advanceComboIndex,
  getParryWindow,
} from "../combat/melee-depth";
import { canMeleeWallbang } from "../combat/penetration";

/**
 * P4.6: Melee & takedown system.
 *
 * Two melee actions:
 *   - Quick melee (default key: F or V): a fast knife slash in front of
 *     the player. Deals 50 damage to the first enemy within 2.5m.
 *     Does NOT break stealth (enemies within 15m can hear it).
 *   - Takedown (default key: G when behind an enemy): a silent
 *     execution from behind. Requires the enemy to be within 1.8m AND
 *     the player to be behind the enemy's facing direction (within
 *     ±60° of the enemy's back). Instakills. Does NOT alert other
 *     enemies (silent kill animation).
 *
 * Both have a 0.8s cooldown. The slash plays a knife-swipe sound; the
 * takedown plays a softer thud + body-drop sound.
 *
 * The system is event-driven — InputSystem dispatches the melee key,
 * which calls tryMeleeSlash() or tryTakedown() here.
 *
 * SEC5-COMBAT — Prompt 47: combo + parry layer integrated. Each melee key
 * press now advances a 3-hit combo (see combat/melee-depth.ts). The damage
 * + range + cone are read from the per-weapon combo table; the combo index
 * auto-resets if the player doesn't press melee within the combo window.
 *
 * Section B:
 *   #190 — melee lunge arc (player lunges forward ~1m within 2.5m).
 *   #191 — backstab multiplier (2.5× damage from behind, instakill on most classes).
 *   #192 — wallbang melee (knife through thin drywall) — uses canMeleeWallbang.
 *   #193 — melee weapon variety (already in melee-depth.ts: knife, axe, katana,
 *           machete, crowbar, sledgehammer). The system reads the loadout's
 *           melee weapon + applies its stats.
 *   #194 — melee finisher on low-HP enemies (FinisherSystem animation trigger).
 */
export class MeleeSystem implements GameSystem {
  // A2-5000 #226 — initialize to -Infinity so the first melee after page
  // load isn't gated by the 800ms cooldown (was `0`, which blocked the first
  // 800ms window — a bot-test edge case).
  private lastMeleeTime = -Infinity;
  private readonly cooldown = 800; // ms
  private readonly slashRange = 2.5;
  private readonly slashDamage = 50;
  private readonly takedownRange = 1.8;
  private readonly takedownAngle = Math.PI / 3; // 60° from enemy's back

  /** SEC5-COMBAT — Prompt 47: combo state. */
  private comboHitIndex = 0;
  // A2-5000 #226 — combo timer also initialized to -Infinity so the first
  // press starts a fresh combo (was `0`, which the combo-window check read
  // as "just hit" on the very first press).
  private lastComboHitTime = -Infinity;
  /** SEC5-COMBAT — Prompt 47: swing windup start (for parry window checks). */
  private swingWindupStart = 0;
  /** SEC5-COMBAT — Prompt 47: parry window for the currently-equipped melee
   *  weapon. Read by the (future) enemy-melee system to check parry success. */
  private currentParryWindow = 150;

  /**
   * Section B #190 — lunge state. When a slash is initiated within 2.5m of
   * an enemy, the player lunges forward ~1m over 0.15s. The lunge is applied
   * to ctx.player.vel in the player's forward direction.
   */
  private lungeActive = false;
  private lungeEndTime = 0;
  private static readonly LUNGE_DURATION_MS = 150;
  private static readonly LUNGE_DISTANCE_M = 1.0;
  private static readonly LUNGE_TRIGGER_RANGE = 2.5;

  /**
   * Section B #191 — backstab multiplier. A melee hit from behind deals 2.5×
   * damage (instakill on most classes). The system checks the angle between
   * the player's forward direction and the enemy's forward direction; if the
   * player is behind the enemy (within ±60° of the enemy's back), the backstab
   * multiplier applies.
   */
  private static readonly BACKSTAB_MULT = 2.5;
  private static readonly BACKSTAB_ANGLE = Math.PI / 3; // 60°

  /**
   * Section B #194 — finisher trigger threshold. Enemies below this HP
   * percentage trigger a finisher animation on melee hit (instakill + the
   * FinisherSystem plays the cinematic).
   */
  private static readonly FINISHER_HP_THRESHOLD = 0.20; // 20% HP

  /**
   * A2-5000 #228 — melee accuracy stats. Tracked locally so the HUD +
   * challenges can read melee hit/attempt counts without bloating
   * MatchState (which is shared with other systems).
   */
  private meleeHits = 0;
  private meleeAttempts = 0;
  getMeleeHits(): number { return this.meleeHits; }
  getMeleeAttempts(): number { return this.meleeAttempts; }
  getMeleeAccuracy(): number {
    return this.meleeAttempts > 0 ? this.meleeHits / this.meleeAttempts : 0;
  }

  constructor(private ctx: GameContext) {}

  update(_dt: number) {
    // Section B #190 — lunge physics. While the lunge is active, the player's
    // velocity is boosted forward. The PhysicsSystem integrates this naturally.
    if (this.lungeActive && performance.now() >= this.lungeEndTime) {
      this.lungeActive = false;
    }
    // A2-5000 #227 — combo reset per-frame. The combo index auto-resets if
    // the player hasn't pressed melee within the combo window. Previously
    // this only happened on the next press (HUD showed stale combo progress).
    // Now the HUD reads comboHitIndex directly + this reset keeps it honest.
    if (this.comboHitIndex > 0 && performance.now() - this.lastComboHitTime > 800) {
      this.comboHitIndex = 0;
    }
  }

  /** Quick knife slash. Returns true if an enemy was hit. */
  trySlash(): boolean {
    const { ctx } = this;
    if (ctx.paused || ctx.match.matchOver) return false;
    const now = performance.now();
    if (now - this.lastMeleeTime < this.cooldown) return false;
    // A2-5000 #228 — count every attempt for accuracy stats.
    this.meleeAttempts++;

    // SEC5-COMBAT — Prompt 47: advance the combo index.
    const slug = ctx.weapon.loadout.melee || "knife";
    const msSinceLastHit = now - this.lastComboHitTime;
    // If the combo window expired (or this is the first hit), reset to 0.
    if (msSinceLastHit > 800) {
      this.comboHitIndex = 0;
    } else {
      this.comboHitIndex = advanceComboIndex(slug, this.comboHitIndex, msSinceLastHit);
    }
    const hit = getCombo(slug, this.comboHitIndex);
    const dmg = getComboDamage(slug, this.comboHitIndex);
    const range = getComboRange(slug, this.comboHitIndex);
    this.lastComboHitTime = now;
    this.swingWindupStart = now;
    this.currentParryWindow = getParryWindow(slug);
    this.lastMeleeTime = now;

    // Section B #190 — lunge: if there's an enemy within LUNGE_TRIGGER_RANGE,
    // boost the player forward by LUNGE_DISTANCE_M over LUNGE_DURATION_MS.
    const lungeTarget = this.findEnemyInCone(MeleeSystem.LUNGE_TRIGGER_RANGE, hit.coneHalfAngle);
    if (lungeTarget) {
      this.startLunge();
    }

    // A2-5000 #222 — dedicated melee swing sound (was `ctx.audio.reload()`
    // confessed as a stand-in). playMeleeSwing(impacted=true) layers a
    // whoosh + thud + crack; (impacted=false) is just the whoosh.
    // Find the closest enemy within the combo hit's range + cone.
    const target = this.findEnemyInCone(range, hit.coneHalfAngle);
    ctx.audio.playMeleeSwing(target != null);
    if (target) {
      // A2-5000 #228 — count the hit for accuracy stats.
      this.meleeHits++;
      // Section B #191 — backstab check. If the player is behind the enemy,
      // apply the backstab multiplier (2.5×) and emit a backstab HUD marker.
      const isBackstab = this.isBehindEnemy(target);
      // Section B #194 — finisher check. If the enemy is below the finisher
      // HP threshold, trigger the finisher animation (instakill + cinematic).
      const isFinisher = target.health / target.maxHealth <= MeleeSystem.FINISHER_HP_THRESHOLD;
      let finalDmg = dmg;
      let headshot = false;
      const healthBefore = target.health;
      if (isFinisher) {
        // Finisher = instakill + trigger the FinisherSystem animation.
        finalDmg = target.health + 100;
        this.onFinisher?.(target);
      } else if (isBackstab) {
        // Backstab multiplier (2.5×).
        finalDmg = Math.round(dmg * MeleeSystem.BACKSTAB_MULT);
        headshot = true; // backstab reads as a "headshot" for HUD marker purposes
      }
      // Hit! Apply damage + spawn blood.
      this.onDamageEnemy?.(target, finalDmg, headshot, target.group.position);
      // A2-5000 #221 — direct kill path. Damage-reduction middleware may not
      // actually kill the target (e.g. riot-shield captain from front). For
      // instakill cases (finisher / backstab / takedown) force death via the
      // dedicated kill hook so melee always kills when it should.
      if ((isFinisher || isBackstab) && target.health > 0) {
        this.onKillEnemy?.(target);
      }
      this.onSpawnBlood?.(target.group.position);
      // A2-5000 #220 — defer kill count: target.alive may not yet be false at
      // this tick (death applied next frame by the damage system). Compare
      // health before/after — if it crossed zero, count the kill now.
      if (healthBefore > 0 && (target.health <= 0 || !target.alive)) {
        ctx.match.meleeKills++;
      }
      return true;
    }
    // Section B #192 — wallbang melee: if no direct hit, check for an enemy
    // behind a thin drywall/glass/foliage surface within range. The knife
    // passes through and applies reduced damage to the enemy on the other side.
    const wallbangTarget = this.findWallbangTarget(range);
    if (wallbangTarget) {
      this.meleeHits++; // A2-5000 #228 — wallbang hits count too.
      const healthBefore = wallbangTarget.enemy.health;
      this.onDamageEnemy?.(wallbangTarget.enemy, Math.round(dmg * wallbangTarget.dmgMult), false, wallbangTarget.enemy.group.position);
      this.onSpawnBlood?.(wallbangTarget.enemy.group.position);
      if (healthBefore > 0 && (wallbangTarget.enemy.health <= 0 || !wallbangTarget.enemy.alive)) {
        ctx.match.meleeKills++;
      }
      return true;
    }
    return false;
  }

  /** Silent takedown from behind. Returns true if a takedown was performed. */
  tryTakedown(): boolean {
    const { ctx } = this;
    if (ctx.paused || ctx.match.matchOver) return false;
    const now = performance.now();
    if (now - this.lastMeleeTime < this.cooldown) return false;
    // A2-5000 #228 — count takedown attempts too.
    this.meleeAttempts++;
    // Find an enemy within takedownRange AND behind the player's view
    // (i.e. player is behind the enemy).
    const target = this.findTakedownTarget();
    if (!target) return false;
    this.lastMeleeTime = now;
    this.meleeHits++;
    // Instakill + silent. Use damageEnemy with a huge damage value.
    const healthBefore = target.health;
    this.onDamageEnemy?.(target, target.health + 100, true, target.group.position);
    // A2-5000 #221 — direct kill path for takedowns (damage middleware may
    // not actually kill shielded enemies; takedowns must always kill).
    if (target.health > 0) {
      this.onKillEnemy?.(target);
    }
    this.onSpawnBlood?.(target.group.position);
    // A2-5000 #220 — defer kill count via health check.
    if (healthBefore > 0 && (target.health <= 0 || !target.alive)) {
      ctx.match.meleeKills++;
    }
    // Takedowns don't alert other enemies (silent). The hitMarker sound
    // is also suppressed — only a soft thud.
    // A2-5000 #222 — dedicated melee swing sound (impacted=true for the thud).
    ctx.audio.playMeleeSwing(true);
    return true;
  }

  /**
   * Section B #190 — start a forward lunge. Boosts the player's velocity
   * in their forward direction by LUNGE_DISTANCE_M / LUNGE_DURATION_MS (m/s).
   */
  private startLunge() {
    const { ctx } = this;
    this.lungeActive = true;
    this.lungeEndTime = performance.now() + MeleeSystem.LUNGE_DURATION_MS;
    // Forward direction = (-sin(yaw), 0, -cos(yaw)) — matches PhysicsSystem.
    const fwd = new THREE.Vector3(-Math.sin(ctx.player.yaw), 0, -Math.cos(ctx.player.yaw));
    const lungeSpeed = MeleeSystem.LUNGE_DISTANCE_M / (MeleeSystem.LUNGE_DURATION_MS / 1000);
    ctx.player.vel.addScaledVector(fwd, lungeSpeed);
  }

  /**
   * Section B #191 — is the player behind the enemy (within ±60° of the
   * enemy's back)? The enemy's forward direction is read via world quaternion
   * (A2-5000 #224 — was `e.group.rotation.y` only, wrong with root motion /
   * parent transforms). The player is behind if the vector from enemy to
   * player is within ±60° of the enemy's BACK direction.
   */
  private isBehindEnemy(enemy: Enemy): boolean {
    const { ctx } = this;
    const toPlayer = new THREE.Vector3().subVectors(ctx.player.pos, enemy.group.position);
    toPlayer.y = 0;
    if (toPlayer.lengthSq() < 0.001) return false;
    toPlayer.normalize();
    // A2-5000 #224 — use world quaternion (handles parent transforms / root motion).
    const enemyForward = new THREE.Vector3(0, 0, 1);
    enemy.group.getWorldQuaternion(_worldQuat);
    enemyForward.applyQuaternion(_worldQuat);
    enemyForward.y = 0;
    if (enemyForward.lengthSq() < 0.001) return false;
    enemyForward.normalize();
    // The player is behind the enemy if the dot product of (toPlayer) and
    // (enemyForward) is NEGATIVE (player is opposite of where enemy looks)
    // — and within the backstab angle of the enemy's back direction.
    const dot = toPlayer.dot(enemyForward.clone().negate());
    return dot >= Math.cos(MeleeSystem.BACKSTAB_ANGLE);
  }

  /**
   * Section B #192 — find an enemy on the other side of a thin drywall/glass/
   * foliage surface. Returns the enemy + the residual damage multiplier if
   * a wallbang is possible, null otherwise.
   *
   * The system raycasts forward from the player. If it hits a soft surface
   * (drywall/foliage/glass) thin enough to wallbang, it continues the raycast
   * past the surface + looks for an enemy within the slash range.
   */
  private findWallbangTarget(range: number): { enemy: Enemy; dmgMult: number } | null {
    const { ctx } = this;
    // Forward direction.
    const fwd = new THREE.Vector3(-Math.sin(ctx.player.yaw), 0, -Math.cos(ctx.player.yaw));
    const origin = ctx.player.pos.clone();
    origin.y = 1.0;
    ctx.raycaster.set(origin, fwd);
    ctx.raycaster.far = range;
    // Look for a destructible prop (the wall) within range.
    for (const prop of ctx.destructibles) {
      if (prop.health <= 0) continue;
      const hits = ctx.raycaster.intersectObject(prop.mesh, false);
      if (hits.length === 0) continue;
      const hit = hits[0];
      const surface = prop.materialSlug;
      // Approximate the surface thickness from the prop's bounding box along
      // the ray direction. For thin walls this is ~0.05m; for thick walls
      // (concrete) it's >0.2m. Use the prop's bounding box depth as a proxy.
      const box = new THREE.Box3().setFromObject(prop.mesh);
      const size = new THREE.Vector3();
      box.getSize(size);
      const thickness = Math.min(size.x, size.y, size.z);
      const wallbang = canMeleeWallbang(surface, thickness);
      if (!wallbang.canWallbang) continue;
      // Continue the raycast past the wall to find an enemy within range.
      const pastOrigin = hit.point.clone().addScaledVector(fwd, 0.1);
      ctx.raycaster.set(pastOrigin, fwd);
      ctx.raycaster.far = range - hit.distance;
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const parts = e.group.userData.parts as THREE.Mesh[] | undefined;
        if (!parts) continue;
        const eHits = ctx.raycaster.intersectObjects(parts, false);
        if (eHits.length > 0) {
          return { enemy: e, dmgMult: wallbang.residualDamageMult };
        }
      }
    }
    return null;
  }

  /**
   * SEC5-COMBAT — Prompt 47: Get the current combo hit index (0, 1, or 2).
   * Exposed for the HUD combo-progress widget.
   */
  getComboIndex(): number { return this.comboHitIndex; }

  /**
   * SEC5-COMBAT — Prompt 47: Get the parry window (ms) for the currently-
   * equipped melee weapon. The (future) enemy-melee system reads this to
   * check whether a player swing can be parried.
   */
  getActiveParryWindow(): number { return this.currentParryWindow; }

  /**
   * SEC5-COMBAT — Prompt 47: Is the player currently in a swing windup
   * (i.e. within the parry window of the last swing)?
   */
  isInParryWindow(now: number = performance.now()): boolean {
    return now - this.swingWindupStart < this.currentParryWindow;
  }

  /** Find the closest enemy within range and within the player's view cone.
   *  A2-5000 #223 — cone is now 3D (was 2D horizontal-only, ignored pitch —
   *  enemies above/below the player were hit even outside the view frustum).
   *  A3-5000 #530: per-call scratch vectors (was shared ctx.scratch.v1/v2 —
   *  if onDamageEnemy used scratch, the cone was corrupted mid-loop). */
  private findEnemyInCone(range: number, halfCone: number): Enemy | null {
    const { ctx } = this;
    // A3-5000 #530: per-call scratch (avoids corruption if onDamageEnemy
    // uses ctx.scratch).
    const playerForward = ctx.camera.getWorldDirection(new THREE.Vector3());
    const toEnemy = new THREE.Vector3();
    let best: Enemy | null = null;
    let bestDist = Infinity;
    for (const e of ctx.enemies) {
      if (!e.alive) continue;
      toEnemy.copy(e.group.position).sub(ctx.player.pos);
      // A2-5000 #223 — don't flatten Y; the cone check is now 3D.
      const dist = toEnemy.length();
      if (dist > range) continue;
      toEnemy.normalize();
      const dot = toEnemy.dot(playerForward);
      if (dot < Math.cos(halfCone)) continue; // outside view cone
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    return best;
  }

  /** Find an enemy that the player can takedown (player is behind enemy).
   *  A2-5000 #224 — enemy forward read via world quaternion.
   *  A2-5000 #225 — takedown cone is 60° (was 120° due to a half-angle bug). */
  private findTakedownTarget(): Enemy | null {
    const { ctx } = this;
    // A2-5000 #225 — cone half-angle = takedownAngle / 2. The previous check
    // `dot < -Math.cos(takedownAngle)` allowed a 2× takedownAngle arc (120°
    // instead of 60°). The fix uses half the angle so the cone matches the
    // spec's 60° arc behind the enemy.
    const coneHalf = this.takedownAngle / 2;
    for (const e of ctx.enemies) {
      if (!e.alive) continue;
      const toPlayer = ctx.scratch.v1.copy(ctx.player.pos).sub(e.group.position);
      toPlayer.y = 0;
      const dist = toPlayer.length();
      if (dist > this.takedownRange) continue;
      toPlayer.normalize();
      // A2-5000 #224 — enemy forward via world quaternion (handles parents).
      const enemyForward = ctx.scratch.v2.set(0, 0, 1);
      e.group.getWorldQuaternion(_worldQuat);
      enemyForward.applyQuaternion(_worldQuat);
      enemyForward.y = 0;
      if (enemyForward.lengthSq() < 0.001) continue;
      enemyForward.normalize();
      // Player should be behind the enemy (dot of player-from-enemy and
      // enemy-forward should be sufficiently negative).
      const dot = toPlayer.dot(enemyForward);
      if (dot < -Math.cos(coneHalf)) {
        return e;
      }
    }
    return null;
  }

  // Hooks wired by engine.
  onDamageEnemy?: (e: Enemy, dmg: number, headshot: boolean, point: THREE.Vector3) => void;
  onSpawnBlood?: (point: THREE.Vector3) => void;
  /** Section B #194 — finisher trigger. Called when a melee hit on a low-HP
   *  enemy triggers the finisher animation. The engine wires this to
   *  FinisherSystem.playFinisher(enemy). */
  onFinisher?: (enemy: Enemy) => void;
  /** A2-5000 #221 — direct kill path. Called when an instakill melee (backstab,
   *  takedown, finisher) should bypass damage-reduction middleware and force
   *  the enemy dead. The engine wires this to the same path that handles
   *  `enemy.health = 0` + death animation + ragdoll. */
  onKillEnemy?: (enemy: Enemy) => void;
}

// A2-5000 #224 — shared scratch quaternion (avoids per-call allocation in
// the per-enemy loops in isBehindEnemy + findTakedownTarget).
const _worldQuat = new THREE.Quaternion();
