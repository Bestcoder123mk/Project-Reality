import * as THREE from "three";
import { FiniteStateMachine, type FSMTable } from "./FiniteStateMachine";
import type { Enemy } from "../systems/types";

/**
 * EnemyFSM — per-enemy AI state machine.
 *
 *   IDLE → PATROL → CHASE → ATTACK → SUPPRESSED → FLANK → COVER → FLEE → DEAD
 *
 * Transitions are driven by distance to player, line-of-sight,
 * suppression level, and health. Each enemy owns its own FSM instance.
 *
 * Replaces the `e.state: "idle"|"chase"|"attack"|"dead"` string field.
 *
 * Task-5 (AI tactics): added a COVER state that enemies enter when injured
 * or recently damaged. Cover-seeking + peek + blind-fire is implemented in
 * `tickCover` (enemy-tactics.ts). The COVER state is dispatched via the
 * existing `tickChase` route in EnemySystem (COVER state maps to legacy
 * "idle" so `tickChase` runs; tickChase internally routes COVER → tickCover).
 */
export type EnemyFSMState =
  | "IDLE"
  | "PATROL"
  | "CHASE"
  | "ATTACK"
  | "SUPPRESSED"
  | "FLANK"
  | "COVER"
  | "FLEE"
  | "DEAD";

export type EnemyFSMEvent =
  | "spotPlayer"        // gained line of sight
  | "losePlayer"        // lost line of sight
  | "inAttackRange"     // dist < attackRange
  | "outOfAttackRange"  // dist > attackRange
  | "suppressed"        // suppression scalar crossed threshold
  | "recovered"         // suppression decayed
  | "flankOrder"        // commander ordered a flank (random chance in chase)
  | "seekCover"         // Task-5 — injured / recently damaged → seek cover
  | "exitCover"         // Task-5 — held cover long enough, re-engage
  | "moraleBreak"       // G3.3 — low health + no nearby allies → flee
  | "rallied"           // G3.3 — regained composure (health recovered or allies arrived)
  | "killed";           // health <= 0

interface EnemyCtx {
  enemy: Enemy;
}

/**
 * The transition table — exported (§2 QA item 41) so the static checker
 * test (`src/lib/game/fsm/__tests__/EnemyFSM.test.ts`) can introspect
 * every state's outgoing transitions and assert no state is a dead-end
 * (no exits) unless it's explicitly marked terminal (DEAD).
 */
export const ENEMY_FSM_TABLE: FSMTable<EnemyCtx> = {
  IDLE: {
    spotPlayer: { target: "CHASE" },
    // §2 QA item 41 — the static checker test caught that IDLE + PATROL
    // had no `killed` transition. A stealth headshot from behind on an
    // IDLE enemy would have soft-locked the FSM (send("killed") returned
    // false, the enemy stayed in IDLE). Added here so `markDead()` works
    // from every state.
    killed: { target: "DEAD", onEnter: ({ enemy }) => { enemy.alive = false; enemy.deadTime = performance.now(); } },
  },
  PATROL: {
    spotPlayer: { target: "CHASE" },
    killed: { target: "DEAD", onEnter: ({ enemy }) => { enemy.alive = false; enemy.deadTime = performance.now(); } },
  },
  CHASE: {
    inAttackRange: { target: "ATTACK" },
    suppressed: { target: "SUPPRESSED" },
    flankOrder: { target: "FLANK" },
    seekCover: { target: "COVER" },
    moraleBreak: { target: "FLEE" },
    killed: { target: "DEAD", onEnter: ({ enemy }) => { enemy.alive = false; enemy.deadTime = performance.now(); } },
  },
  // Section D #1707 — ATTACK now has a flankOrder transition (was CHASE-only).
  // The prior table only allowed flanking from CHASE, so once an enemy
  // entered ATTACK it could never flank even if a Commander issued the
  // order. Now ATTACK→FLANK is valid; the tick method below fires the
  // flankOrder event from ATTACK state too (lone-wolf + Commander-driven).
  ATTACK: {
    outOfAttackRange: { target: "CHASE" },
    suppressed: { target: "SUPPRESSED" },
    flankOrder: { target: "FLANK" },
    seekCover: { target: "COVER" },
    moraleBreak: { target: "FLEE" },
    killed: { target: "DEAD", onEnter: ({ enemy }) => { enemy.alive = false; enemy.deadTime = performance.now(); } },
  },
  SUPPRESSED: {
    recovered: { target: "CHASE" },
    killed: { target: "DEAD", onEnter: ({ enemy }) => { enemy.alive = false; enemy.deadTime = performance.now(); } },
  },
  FLANK: {
    inAttackRange: { target: "ATTACK" },
    seekCover: { target: "COVER" },
    moraleBreak: { target: "FLEE" },
    killed: { target: "DEAD", onEnter: ({ enemy }) => { enemy.alive = false; enemy.deadTime = performance.now(); } },
  },
  // Task-5 — COVER: injured / pinned enemy holds a cover position, peeks out
  // to shoot, blind-fires when suppressed, and throws grenades. After ~3s
  // with no further damage, it re-engages (exitCover → ATTACK). If an ally
  // nearby dies (or by chance when very low HP), it can morale-break to FLEE.
  COVER: {
    exitCover: { target: "ATTACK", onEnter: ({ enemy }) => { clearCoverTimers(enemy); } },
    suppressed: { target: "SUPPRESSED" },
    moraleBreak: { target: "FLEE", onEnter: ({ enemy }) => { clearCoverTimers(enemy); } },
    killed: { target: "DEAD", onEnter: ({ enemy }) => { enemy.alive = false; enemy.deadTime = performance.now(); } },
    // Section D #1712 — __reset handler fired by FiniteStateMachine.reset()
    // when the FSM is reset out of COVER (e.g. on match restart / enemy
    // respawn). Cleans the per-enemy COVER sub-state timers so they don't
    // persist into the new match.
    __reset: { target: "IDLE", onExit: ({ enemy }) => { clearCoverTimers(enemy); } },
  },
  // G3.3 — FLEE: enemy sprints away from the player. Recovers (rallies) if
  // health regenerates above the threshold or allies arrive nearby, or after
  // a 3s flee duration (re-engage rather than fleeing forever).
  FLEE: {
    rallied: { target: "CHASE", onEnter: ({ enemy }) => { clearFleeTimer(enemy); } },
    seekCover: { target: "COVER", onEnter: ({ enemy }) => { clearFleeTimer(enemy); } },
    killed: { target: "DEAD", onEnter: ({ enemy }) => { enemy.alive = false; enemy.deadTime = performance.now(); } },
    // Section D #1712 — __reset handler fired by FiniteStateMachine.reset()
    // when the FSM is reset out of FLEE. Cleans the per-enemy fleeEnterTime
    // so a reset enemy doesn't think it's been fleeing since the prior match.
    __reset: { target: "IDLE", onExit: ({ enemy }) => { clearFleeTimer(enemy); } },
  },
  DEAD: {},
};

/** Task-5 — clear the per-enemy COVER sub-state timers when leaving COVER.
 *  Resets the cover entry timestamp + the cover behavior sub-state so a
 *  fresh COVER entry starts a clean peek cycle. */
function clearCoverTimers(enemy: Enemy) {
  const ex = enemy as unknown as {
    coverEnterTime?: number;
    coverCacheTime?: number;
    coverCachePos?: THREE.Vector3 | null;
    coverPeekUntil?: number;
    coverIsPeeking?: boolean;
    coverNextActionAt?: number;
    coverPeekDir?: 1 | -1;
    coverNextBlindFireAt?: number;
  };
  ex.coverEnterTime = undefined;
  ex.coverCacheTime = undefined;
  ex.coverCachePos = undefined;
  ex.coverPeekUntil = undefined;
  ex.coverIsPeeking = undefined;
  ex.coverNextActionAt = undefined;
  ex.coverPeekDir = undefined;
  ex.coverNextBlindFireAt = undefined;
}

/** Task-5 — clear the per-enemy FLEE enter timestamp when leaving FLEE. */
function clearFleeTimer(enemy: Enemy) {
  const ex = enemy as unknown as { fleeEnterTime?: number };
  ex.fleeEnterTime = undefined;
}

/**
 * Per-enemy FSM wrapper.
 *
 * The actual transition triggers (distance checks, LOS, suppression) are
 * evaluated each frame by EnemySystem and dispatched via `send()`.
 *
 * Thresholds are tunable per-enemy (e.g. CQB class has shorter attackRange).
 */
export class EnemyFSM {
  private fsm: FiniteStateMachine<EnemyCtx>;
  private attackRange: number;
  private suppressionThreshold: number;
  private recoveryThreshold: number;
  /** Task-5 — direct ref to the owning enemy so we can stamp per-enemy AI
   *  timers (coverEnterTime, fleeEnterTime) without reaching into the FSM's
   *  private ctx. */
  private enemy: Enemy;
  /** Section D #1713 — true once applyClassToEnemy (or applyBossToEnemy) has
   *  configured this FSM's per-class thresholds. The tick method throws if
   *  the class was never applied — the prior code silently fell back to
   *  rifleman defaults (attackRange=8, suppressionThreshold=0.6), so a
   *  spawn-path bug that skipped applyClassToEnemy would produce enemies
   *  that fought like riflemen regardless of their actual class. */
  private classApplied = false;

  constructor(enemy: Enemy, opts: { attackRange?: number; suppressionThreshold?: number; recoveryThreshold?: number } = {}) {
    this.attackRange = opts.attackRange ?? 8;
    this.suppressionThreshold = opts.suppressionThreshold ?? 0.6;
    this.recoveryThreshold = opts.recoveryThreshold ?? 0.2;
    this.enemy = enemy;
    this.fsm = new FiniteStateMachine(ENEMY_FSM_TABLE, "IDLE", { enemy });
  }

  /** Section D #1713 — mark this FSM as having had its per-class thresholds
   *  applied (by applyClassToEnemy / applyBossToEnemy). Called from
   *  EnemyClasses.ts after the class config mutates the FSM fields. */
  markClassApplied(): void { this.classApplied = true; }

  /** Section D #1768 — public API for setting the per-class thresholds.
   *  Replaces the prior `fsm as unknown as { attackRange; ... }` private-
   *  field bypass in EnemyClasses.applyClassToEnemy / applyBossToEnemy. */
  setThresholds(opts: { attackRange: number; suppressionThreshold: number; recoveryThreshold?: number }): void {
    this.attackRange = opts.attackRange;
    this.suppressionThreshold = opts.suppressionThreshold;
    if (opts.recoveryThreshold !== undefined) this.recoveryThreshold = opts.recoveryThreshold;
  }

  get state(): EnemyFSMState { return this.fsm.state as EnemyFSMState; }
  is(s: EnemyFSMState): boolean { return this.fsm.is(s); }
  isIn(...s: EnemyFSMState[]): boolean { return this.fsm.isIn(...s); }

  get attackRangeMeters() { return this.attackRange; }

  /** Task-5 — Expose the raw FSM event send (was previously only on the
   *  private FiniteStateMachine). EnemySystem uses this for direct
   *  transitions driven by squad-level coordination (contact callouts:
   *  `other.fsm.send("spotPlayer")`; Commander flank orders:
   *  `f.fsm.send("flankOrder")`). Exposing it here fixes pre-existing
   *  TS2339 errors without changing the FSM's transition semantics. */
  send(event: EnemyFSMEvent): boolean { return this.fsm.send(event); }

  /** Tick the FSM with the current tactical situation. */
  tick(situation: {
    distToPlayer: number;
    hasLOS: boolean;
    enemySuppression: number; // 0..1
    health: number;
    maxHealth: number;
    flankChance?: number; // 0..1 chance to flank this tick (only checked in CHASE)
    nearbyAllyCount?: number; // G3.3 — living allies within ~15m
    /** Task-5 — true if the enemy was damaged within the last ~1.5s. */
    damagedRecently?: boolean;
    /** Task-5 — performance.now() timestamp of the current tick. */
    now?: number;
    /** Task-5 — number of nearby allies that died in the last ~2s (for
     *  COVER → FLEE morale break). 0 if none. */
    nearbyRecentDeaths?: number;
  }) {
    if (this.fsm.is("DEAD")) return;
    // Section D #1713 — throw if the class was never applied. The prior
    // code silently used rifleman defaults, masking spawn-path bugs. The
    // throw is dev-time-only — production builds can set
    // `this.classApplied = true` defensively in the constructor if needed.
    if (!this.classApplied) {
      throw new Error(
        "EnemyFSM.tick called before applyClassToEnemy/applyBossToEnemy — " +
        "the FSM is using rifleman defaults which masks spawn-path bugs. " +
        "Call fsm.markClassApplied() after configuring the class.",
      );
    }
    const now = situation.now ?? performance.now();

    // Death check (highest priority)
    if (situation.health <= 0) { this.fsm.send("killed"); return; }

    const hpPct = situation.health / (situation.maxHealth || 100);
    const allies = situation.nearbyAllyCount ?? 1;
    // Task-5 — damagedRecently: passed in by EnemySystem if it computes it;
    // otherwise fall back to checking this enemy's lastDamagedTime stamp
    // (set by EnemySystem.damageEnemy). 1.5s window matches the task spec.
    let damagedRecently = situation.damagedRecently ?? false;
    if (!damagedRecently && this.enemy.lastDamagedTime > 0) {
      damagedRecently = now - this.enemy.lastDamagedTime < 1500;
    }
    const nearbyRecentDeaths = situation.nearbyRecentDeaths ?? 0;

    // ---------- COVER state lifecycle ----------
    if (this.fsm.is("COVER")) {
      const st = this.enemy as unknown as { coverEnterTime?: number };
      if (st.coverEnterTime === undefined) st.coverEnterTime = now;
      const timeInCover = now - st.coverEnterTime;

      // Morale break — only after 1s in cover (avoids instant flee on entry).
      // Fires when an ally nearby died (chance-based) OR the enemy is at
      // very low HP and isolated (~0.5% per tick ≈ 26% per second).
      if (timeInCover > 1000) {
        if (nearbyRecentDeaths > 0 && Math.random() < 0.5) {
          this.fsm.send("moraleBreak"); return;
        }
        if (hpPct < 0.15 && allies === 0 && Math.random() < 0.005) {
          this.fsm.send("moraleBreak"); return;
        }
      }
      // Re-engage after 3s in cover AND no fresh damage in the last 1.5s.
      if (timeInCover > 3000 && !damagedRecently) {
        this.fsm.send("exitCover"); return;
      }
      // Section D #1709 — safety exit gated on damage. The prior code
      // unconditionally forced exitCover after 8s, which broke the cover
      // stalemate for an enemy being actively suppressed (it would pop out
      // into incoming fire + get gunned down). Now the safety valve only
      // fires if the enemy hasn't been damaged recently — i.e. the player
      // has stopped shooting + the enemy is safe to re-engage. An enemy
      // under sustained fire stays pinned (the player's grenade is the
      // intended flush).
      if (timeInCover > 8000 && !damagedRecently) {
        this.fsm.send("exitCover"); return;
      }
      // Otherwise hold cover (tickCover in enemy-tactics handles the
      // cover-seeking + peek + blind-fire behavior).
      return;
    }

    // ---------- FLEE state lifecycle ----------
    if (this.fsm.is("FLEE")) {
      const st = this.enemy as unknown as { fleeEnterTime?: number };
      if (st.fleeEnterTime === undefined) st.fleeEnterTime = now;
      const timeFleeing = now - st.fleeEnterTime;
      // Rally if health recovered above 35% or allies arrived.
      if (hpPct > 0.35 || allies > 0) {
        this.fsm.send("rallied"); return;
      }
      // After 3s of fleeing, re-engage (don't flee forever).
      if (timeFleeing > 3000) {
        this.fsm.send("rallied"); return;
      }
      // Otherwise keep fleeing — tickFlee handles movement.
      return;
    }

    // ---------- Seek cover from ATTACK / CHASE / FLANK ----------
    // Task-5 — ATTACK/CHASE/FLANK → COVER when injured (< 40% HP) or freshly
    // damaged. SUPPRESSED is its own cover-like state; IDLE enemies haven't
    // spotted the player yet.
    if (!this.fsm.is("SUPPRESSED") && !this.fsm.is("IDLE") && !this.fsm.is("PATROL")) {
      const shouldSeekCover = hpPct < 0.4 || (damagedRecently && hpPct < 0.7);
      if (shouldSeekCover) {
        this.fsm.send("seekCover"); return;
      }
    }

    // ---------- Morale break (low HP + alone) ----------
    // G3.3 — enemies at <20% health with no nearby allies flee. Only fires
    // when not already in FLEE/SUPPRESSED/COVER (those states handle their
    // own exits above). Skipped if the enemy is actively seeking cover —
    // cover is preferred over flee when available.
    if (!this.fsm.is("SUPPRESSED") && !this.fsm.is("IDLE") && !this.fsm.is("PATROL")) {
      if (hpPct < 0.2 && allies === 0) {
        this.fsm.send("moraleBreak"); return;
      }
    }

    // ---------- Suppression ----------
    if (!this.fsm.is("SUPPRESSED") && situation.enemySuppression >= this.suppressionThreshold) {
      this.fsm.send("suppressed"); return;
    }
    if (this.fsm.is("SUPPRESSED") && situation.enemySuppression <= this.recoveryThreshold) {
      // Section D #1708 — return after the recovered transition so the
      // onEnter/onExit hooks fire cleanly for the SUPPRESSED→CHASE transition.
      // The prior code fell through to the range-based checks below, which
      // could fire a second transition (e.g. CHASE→ATTACK via inAttackRange)
      // in the SAME tick — the FSM history would record SUPPRESSED→CHASE
      // →ATTACK but external observers (barks, squad-coordinator) only saw
      // the final state, missing the intermediate CHASE. Returning here
      // gives hooks a clean single-transition tick.
      this.fsm.send("recovered");
      return;
    }

    // ---------- Range-based transitions ----------
    if (this.fsm.is("CHASE")) {
      if (situation.distToPlayer <= this.attackRange) { this.fsm.send("inAttackRange"); return; }
      // G3.1 — per-enemy random flankChance removed; flanking is now
      // Commander-driven (see EnemySystem.updateCommanderCoordination).
      // A tiny residual chance keeps lone-wolf flanks possible when no
      // Commander is alive, so the behavior never fully disappears.
      if (situation.flankChance && Math.random() < situation.flankChance * 0.15) { this.fsm.send("flankOrder"); return; }
    }
    // Section D #1707 — ATTACK can also flank (was CHASE-only). The lone-wolf
    // flank chance is lower in ATTACK (the enemy is already in firing range
    // + flanking from ATTACK means giving up a clean shot). Commander-driven
    // flankOrders from ATTACK go through the same path (the squad-coordinator
    // calls fsm.send("flankOrder") directly, which the table now accepts).
    if (this.fsm.is("ATTACK")) {
      if (situation.distToPlayer > this.attackRange + 2) { this.fsm.send("outOfAttackRange"); return; }
      if (situation.flankChance && Math.random() < situation.flankChance * 0.07) { this.fsm.send("flankOrder"); return; }
    }
    if (this.fsm.is("FLANK") && situation.distToPlayer <= this.attackRange) {
      this.fsm.send("inAttackRange");
    }

    // G3.2 — IDLE → CHASE: enemies spot the player when they have LOS.
    // (Previously auto-spotted every tick regardless of LOS.) Contact
    // call-outs (nearby enemies alerting each other) are handled in
    // EnemySystem.update() via the FSM's spotPlayer event.
    if (this.fsm.is("IDLE") && situation.hasLOS) {
      this.fsm.send("spotPlayer");
    }
  }

  /** Mark this enemy as dead (e.g. killed by player). */
  markDead() { this.fsm.send("killed"); }

  /** Reset to IDLE for spawn. */
  reset() { this.fsm.reset("IDLE"); }
}
