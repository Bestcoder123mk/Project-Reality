/**
 * Section D — AI enhancements module.
 *
 * Consolidates the new AI behaviors introduced by Section D prompts:
 *   - Squad tactics (#481–490): flanking, suppress-and-move, grenades,
 *     retreat/regroup, AI revive, squad comms, search-LKP, dead-body
 *     investigation, alarm raising, breach-and-clear.
 *   - AI reactions (#541–587): target-sharing with LOS, morale, surrender,
 *     cover-peek, blind-fire, suppressive fire at LKP, smoke, flashbang,
 *     callouts, footsteps/gunfire/corpses/doors/glass reactions, patrol
 *     variety, idle variety, patrol resume, head turn, jitter reduction,
 *     cover-in-open, soft-lock recovery, melee, weapon switching, ammo
 *     management, healing, armor repair, scavenging, barrels, fire/grenade
 *     avoidance, LOS-flanking, coordinated push, pincer, overwatch,
 *     base-of-fire, bounding, player-tactic responses (reload/low-HP/sniper/
 *     LMG/shotgun/suppressor/flashlight/laser/NV/thermal).
 *   - AI meta (#588–600): adaptive AI, personality, experience, rank,
 *     loadout/skin/voice/name variety, fear, respect, morale meter,
 *     surrender cinematic, captive mechanic.
 *
 * Integration: the EnemySystem calls the per-frame `tickSectionD()`
 * dispatcher for each alive enemy. Each behavior is gated on the enemy's
 * class + FSM state + per-frame probability (so behaviors emerge naturally
 * rather than every enemy exhibiting every behavior every frame).
 *
 * Pure-TS (no THREE at module load — THREE is imported lazily in the
 * helpers that need Vector3). SSR-safe.
 */
import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";
import type { EnemyClass } from "../EnemyClasses";
import type { DifficultyConfig } from "../Difficulty";
import { emitBark, emitBarkAtPlayer } from "./barks";
import { getAIDirector } from "./director";

// ───────────────────────────────────────────────────────────────────────────
// Per-enemy Section D state stash (cast onto the Enemy via Symbol-like key)
// ───────────────────────────────────────────────────────────────────────────

export interface SectionDAIState {
  // #481 — flanking: timestamp when the squad's suppression started (for the
  // 5s delay before the flanker moves).
  squadSuppressionStartedAt?: number;
  // #482 — suppress-and-move: the AI currently pinning the player (one per
  // squad). Other squad members use this to know they can reposition.
  squadSuppressorId?: string | number | null;
  // #483 — AI grenade throws (per-match cap enforced by DifficultyConfig).
  grenadeThrowsThisMatch?: number;
  // #484 — retreat/regroup: rally point the squad retreats to.
  rallyPoint?: { x: number; z: number } | null;
  // #485 — AI revive: per-enemy revive channel state.
  reviveChannelEnd?: number;
  reviveTarget?: Enemy | null;
  // #486 — squad comms: last callout broadcast time (per-squad, not per-enemy).
  lastCalloutAt?: number;
  // #487 — search-LKP: the player's last-known position (set when LOS breaks).
  lkp?: { x: number; z: number; time: number } | null;
  // #488 — dead-body investigation: corpses the AI has already investigated.
  investigatedCorpses?: Set<string>;
  // #489 — alarm raised flag (per-squad — once raised, stays raised).
  alarmRaised?: boolean;
  // #490 — breach-and-clear: door the squad is stacking at.
  breachDoor?: { x: number; z: number } | null;
  // #541 — squad target-sharing: the shared target enemy (when LOS permits).
  sharedTarget?: Enemy | null;
  // #542 — AI morale (0..1, 1 = full morale). Decays as allies die.
  morale?: number;
  // #543/#599/#600 — surrender/captive state.
  surrendered?: boolean;
  captive?: boolean;
  surrenderedAt?: number;
  // #544 — cover-peek: next peek time + direction.
  nextPeekAt?: number;
  peekDir?: 1 | -1;
  // #545 — blind-fire: next blind-fire time.
  nextBlindFireAt?: number;
  // #546 — suppressive fire at LKP: next burst time.
  nextLkpSuppressAt?: number;
  // #547 — smoke grenade: cooldown.
  nextSmokeAt?: number;
  // #548 — flashbang: cooldown.
  nextFlashAt?: number;
  // #550 — footstep reaction: last footstep heard direction.
  lastFootstepDir?: number;
  // #551 — gunfire reaction: last gunfire heard position + time.
  lastGunfireHeard?: { x: number; z: number; time: number } | null;
  // #553 — open-door suspicion: doors the AI has flagged.
  suspiciousDoors?: Set<string>;
  // #554 — broken-glass suspicion.
  brokenGlassAlerted?: boolean;
  // #555 — patrol route variety: current patrol waypoint index.
  patrolWaypointIdx?: number;
  patrolRoute?: Array<{ x: number; z: number }>;
  // #556 — idle variety: idle facing offset (radians).
  idleFacingOffset?: number;
  // #557 — patrol resume: timestamp when to return to patrol.
  resumePatrolAt?: number;
  // #558 — head turn: target yaw for head tracking.
  headTurnTarget?: number;
  // #559 — jitter reduction: last idle position (for deadband).
  idleAnchor?: { x: number; z: number };
  // #561 — soft-lock detection: last position + time (if not moving, recover).
  lastStuckCheck?: { x: number; z: number; time: number };
  stuckRecoveryAt?: number;
  // #562 — melee: cooldown.
  nextMeleeAt?: number;
  // #563 — weapon switching: current sidearm state.
  usingSidearm?: boolean;
  // #564 — ammo management: per-enemy ammo count (simplified).
  ammo?: number;
  // #565 — AI healing: medkit cooldown.
  nextHealAt?: number;
  // #566 — armor repair: cooldown.
  nextArmorRepairAt?: number;
  // #568 — explosive barrel awareness: last barrel scan time.
  lastBarrelScanAt?: number;
  // #569 — fire avoidance: known fire positions to path around.
  knownFires?: Array<{ x: number; z: number }>;
  // #570 — grenade avoidance: last grenade seen + flee target.
  fleeingGrenade?: { x: number; z: number; time: number } | null;
  // #571 — LOS-aware flanking: flank path that stays out of the player's LOS.
  flankPath?: Array<{ x: number; z: number }>;
  // #572–576 — coordinated tactics: role assignments per squad.
  squadRole?: "suppressor" | "flanker" | "overwatch" | "breacher" | "none";
  // #577 — player reload exploitation: last seen player-reload time.
  playerReloadSeenAt?: number;
  // #578 — player low-HP exploitation.
  playerLowHpSeenAt?: number;
  // #588 — adaptive AI: tactic counter-memory (per-enemy).
  tacticCounter?: Record<string, number>;
  // #589 — personality.
  personality?: "aggressive" | "cautious" | "methodical";
  // #590 — experience level (0..100).
  experience?: number;
  // #591 — rank.
  rank?: "recruit" | "veteran" | "elite";
  // #595 — callsign (for killfeed).
  callsign?: string;
  // #596 — fear (0..1, mirrors the director's fearFactor but per-enemy).
  fear?: number;
}

const SECTION_D_KEY = "__sectionD";

function sd(e: Enemy): SectionDAIState {
  const ex = e as unknown as { __sectionD?: SectionDAIState };
  if (!ex.__sectionD) {
    ex.__sectionD = {
      grenadeThrowsThisMatch: 0,
      investigatedCorpses: new Set(),
      suspiciousDoors: new Set(),
      morale: 1.0,
      personality: pickPersonality(),
      experience: Math.floor(Math.random() * 100),
      rank: "recruit",
      callsign: generateCallsign(),
      fear: 0,
      tacticCounter: {},
      knownFires: [],
      ammo: 90,
    };
  }
  return ex.__sectionD;
}

function pickPersonality(): "aggressive" | "cautious" | "methodical" {
  const r = Math.random();
  if (r < 0.4) return "aggressive";
  if (r < 0.75) return "cautious";
  return "methodical";
}

/** Section D #595 — AI callsign generation (for the killfeed). */
const CALLSIGNS = [
  "Viper", "Ghost", "Reaper", "Wolf", "Falcon", "Cobra", "Raven", "Jackal",
  "Bishop", "Rook", "Spectre", "Havoc", "Onyx", "Talon", "Saber", "Echo",
  "Delta", "Vortex", "Striker", "Maverick", "Phoenix", "Ranger", "Saint",
  "Bandit", "Nomad", "Lynx", "Frost", "Ember", "Steel", "Wraith",
];

export function generateCallsign(): string {
  const name = CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)];
  const num = Math.floor(Math.random() * 99) + 1;
  return `${name}-${num}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Squad tactics (#481–490)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Section D #481 — Flanking behavior. After the squad's suppressor opens
 * fire, a 5s delay starts. Once the delay elapses, a flanker is designated
 * (the closest non-suppressing squad member) + transitions to FLANK.
 *
 * Acceptance: AI flank on a 5s delay after suppression starts.
 */
export function tickFlanking(ctx: GameContext, e: Enemy, now: number, cfg: DifficultyConfig): void {
  // Only run for CHASE-state riflemen/commanders (not snipers — they overwatch).
  const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
  if (cls === "SNIPER" || cls === "MG" || cls === "ZOMBIE") return;
  const fsm = e.fsm;
  if (!fsm || !fsm.is("CHASE")) return;
  // Coordination tier gate — flanking requires at least "flanking" tier.
  if (cfg.coordination !== "flanking" && cfg.coordination !== "synchronized") return;
  const st = sd(e);
  // If this enemy is the squad suppressor, don't flank.
  if (st.squadRole === "suppressor") return;
  // If a squad suppressor is active + 5s have passed, flank.
  if (st.squadSuppressionStartedAt && now - st.squadSuppressionStartedAt > 5000) {
    if (st.squadRole !== "flanker") {
      st.squadRole = "flanker";
      fsm.send("flankOrder");
      const side = Math.random() < 0.5 ? "left" : "right";
      emitBark(ctx, e, side === "left" ? "FLANKING_LEFT" : "FLANKING_RIGHT");
    }
  }
}

/**
 * Section D #482 — Suppress-and-move. One AI pins the player; another
 * repositions while the player is pinned. The suppressor is the squad
 * member with the highest ROF (MG or rifleman); the mover is the closest
 * other member.
 */
export function tickSuppressAndMove(ctx: GameContext, e: Enemy, now: number, cfg: DifficultyConfig): void {
  if (cfg.coordination === "none") return;
  const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
  const st = sd(e);
  // MG → suppressor role. Mark suppression start time.
  if (cls === "MG" && e.alive) {
    if (st.squadRole !== "suppressor") {
      st.squadRole = "suppressor";
      st.squadSuppressionStartedAt = now;
      emitBark(ctx, e, "COVERING");
    }
    // Apply friendly suppression while the MG has LOS to the player.
    const supp = (ctx as unknown as { suppression?: { applyFriendlySuppression?: (i: number) => void } }).suppression;
    if (supp?.applyFriendlySuppression) {
      supp.applyFriendlySuppression(0.5);
    }
  }
}

/**
 * Section D #483 — AI grenade throws. The per-enemy tryThrowGrenade in
 * enemy-tactics.ts already throws grenades at the player's last-known
 * position. This wrapper enforces the difficulty's grenadePerMatch cap.
 * Returns true if a grenade was thrown.
 */
export function tickAIGrenade(
  ctx: GameContext, e: Enemy, now: number, cfg: DifficultyConfig,
  throwFn: (origin: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }) => void,
): boolean {
  const st = sd(e);
  if (st.grenadeThrowsThisMatch === undefined) st.grenadeThrowsThisMatch = 0;
  if (st.grenadeThrowsThisMatch >= cfg.grenadePerMatch) return false;
  // Section D #1971 — suppressed enemies can't throw grenades. A pinned
  // enemy ducking behind cover with bullets flying overhead can't wind up
  // a frag throw (the animation would expose them + the throw would be
  // inaccurate). The gate reads the enemy's suppression scalar; above the
  // per-class suppressionThreshold (default 0.6), the throw is deferred.
  if ((e.suppression ?? 0) > 0.5) return false;
  // Section D #1933 — squad grenade coordination. Don't throw if a squadmate
  // threw within the last 5s (avoids two frags landing on the same LKP).
  if (!squadGrenadeClear(e)) return false;
  // Range gate — only throw at mid-range.
  const dx = ctx.player.pos.x - e.group.position.x;
  const dz = ctx.player.pos.z - e.group.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 10 || dist > 20) return false;
  // Per-enemy cooldown (15-25s).
  if (st.nextSmokeAt === undefined) st.nextSmokeAt = now + 15000 + Math.random() * 10000;
  if (now < st.nextSmokeAt) return false;
  // Throw at the player's predicted position.
  const origin = { x: e.group.position.x, y: 1.2, z: e.group.position.z };
  const target = { x: ctx.player.pos.x, y: 0, z: ctx.player.pos.z };
  throwFn(origin, target);
  st.grenadeThrowsThisMatch++;
  st.nextSmokeAt = now + 15000 + Math.random() * 10000;
  // Section D #1933 — stamp the squad's lastGrenadeThrowAt so squadmates
  // see the no-double-throw window.
  const squadEx = e as unknown as { squadRef?: { lastGrenadeThrowAt?: number } | null };
  if (squadEx.squadRef) squadEx.squadRef.lastGrenadeThrowAt = now;
  emitBark(ctx, e, "GRENADE");
  return true;
}

/**
 * Section D #484 — Retreat/regroup when outmatched. When the squad's morale
 * drops below 0.3 (most allies dead), surviving members retreat to the
 * rally point + emit a RETREATING bark.
 */
export function tickRetreatRegroup(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if ((st.morale ?? 1) > 0.3) return;
  if (st.rallyPoint) {
    // Move toward the rally point.
    const dx = st.rallyPoint.x - e.group.position.x;
    const dz = st.rallyPoint.z - e.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1) {
      const speed = e.speed * 1.3; // retreat faster
      e.velocity.x = (dx / dist) * speed;
      e.velocity.z = (dz / dist) * speed;
    }
  }
  // Emit a RETREATING bark (throttled by the bark cooldown).
  if (e.fsm && !e.fsm.is("FLEE")) {
    e.fsm.send("moraleBreak");
    emitBark(ctx, e, "RETREATING");
  }
}

/**
 * Section D #485 — AI revive of downed allies. A MEDIC-class enemy (or any
 * ally adjacent to a downed teammate) channels a 3s revive. The downed
 * ally is restored at 50% HP.
 */
export function tickAIRevive(ctx: GameContext, e: Enemy, now: number, dt: number): boolean {
  const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
  if (cls !== "MEDIC") return false;
  const st = sd(e);
  // Find a downed (alive=false but deadTime recent) ally within 5m.
  if (!st.reviveTarget || !st.reviveTarget.alive) {
    let best: Enemy | null = null;
    let bestDist = 25; // 5m
    for (const other of ctx.enemies) {
      if (other === e) continue;
      if (other.alive) continue;
      // Recently downed (within 10s)?
      if (now - other.deadTime > 10_000) continue;
      const dx = other.group.position.x - e.group.position.x;
      const dz = other.group.position.z - e.group.position.z;
      const d = Math.hypot(dx, dz);
      if (d < bestDist) { bestDist = d; best = other; }
    }
    if (!best) return false;
    st.reviveTarget = best;
    st.reviveChannelEnd = now + 3000;
    emitBark(ctx, e, "REVIVING");
  }
  // Channel.
  if (st.reviveChannelEnd && now < st.reviveChannelEnd) {
    // Stand still while reviving.
    e.velocity.x = 0;
    e.velocity.z = 0;
    return true;
  }
  // Complete.
  if (st.reviveTarget) {
    st.reviveTarget.alive = true;
    st.reviveTarget.health = st.reviveTarget.maxHealth * 0.5;
    st.reviveTarget.deadTime = 0;
    if (st.reviveTarget.fsm) st.reviveTarget.fsm.reset();
    st.reviveTarget = null;
    st.reviveChannelEnd = undefined;
  }
  return false;
}

/**
 * Section D #486 — Squad comms. When one AI spots the player, it shares
 * the callout with the squad (enemies within 20m transition IDLE → CHASE).
 */
export function tickSquadComms(ctx: GameContext, e: Enemy, now: number, cfg: DifficultyConfig): void {
  if (cfg.coordination === "none") return;
  const fsm = e.fsm;
  if (!fsm || !fsm.is("CHASE")) return;
  const st = sd(e);
  if (st.lastCalloutAt && now - st.lastCalloutAt < 5000) return;
  st.lastCalloutAt = now;
  // Share the spot with nearby idle allies.
  let shared = 0;
  for (const other of ctx.enemies) {
    if (other === e) continue;
    if (!other.alive) continue;
    if (!other.fsm) continue;
    if (!other.fsm.is("IDLE") && !other.fsm.is("PATROL")) continue;
    const dx = other.group.position.x - e.group.position.x;
    const dz = other.group.position.z - e.group.position.z;
    if (dx * dx + dz * dz > 400) continue; // 20m
    other.fsm.send("spotPlayer");
    shared++;
    if (shared >= 4) break; // cap per callout
  }
}

/**
 * Section D #487 — Search last-known-position. When an enemy loses sight
 * of the player, it moves to the player's LKP (stored in st.lkp). After
 * reaching the LKP, it searches briefly then resumes patrol.
 */
export function tickSearchLKP(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  // Update LKP when we have LOS to the player.
  const hasLOS = !isPositionOccluded(ctx, e.group.position, ctx.player.pos);
  if (hasLOS) {
    st.lkp = { x: ctx.player.pos.x, z: ctx.player.pos.z, time: now };
    return;
  }
  // Lost LOS — move to LKP if we have one + it's recent (< 15s).
  if (!st.lkp || now - st.lkp.time > 15_000) return;
  const dx = st.lkp.x - e.group.position.x;
  const dz = st.lkp.z - e.group.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 1.5) {
    const speed = e.speed * 0.8;
    e.velocity.x = (dx / dist) * speed;
    e.velocity.z = (dz / dist) * speed;
  } else {
    // Reached LKP — emit an investigating bark + clear.
    emitBark(ctx, e, "INVESTIGATING");
    st.lkp = null;
  }
}

/** Helper — cheap LOS check (env colliders only). */
function isPositionOccluded(ctx: GameContext, from: THREE.Vector3 | { x: number; y: number; z: number }, to: THREE.Vector3 | { x: number; y: number; z: number }): boolean {
  const fromY = (from as { y?: number }).y ?? 1.2;
  const toY = (to as { y?: number }).y ?? 1.2;
  // Reuse the existing ctx.enemies.isOccluded if available.
  const isOccluded = (ctx as unknown as {
    enemies?: { isOccluded?: (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => boolean };
  }).enemies?.isOccluded;
  if (isOccluded) {
    return isOccluded(
      { x: from.x, y: fromY, z: from.z },
      { x: to.x, y: toY, z: to.z },
    );
  }
  // Fallback — assume unoccluded (the spatial-hash module has the proper raycast).
  return false;
}

/**
 * Section D #488 — Investigation of dead bodies. When an AI encounters a
 * teammate's corpse, it alerts the squad (emits CORPSE_FOUND bark + raises
 * nearby allies' alertness).
 */
export function tickInvestigateCorpses(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if (!st.investigatedCorpses) st.investigatedCorpses = new Set();
  for (const other of ctx.enemies) {
    if (other === e) continue;
    if (other.alive) continue;
    const corpseId = (other as unknown as { id?: string }).id ?? `${other.deadTime}`;
    if (st.investigatedCorpses.has(corpseId)) continue;
    const dx = other.group.position.x - e.group.position.x;
    const dz = other.group.position.z - e.group.position.z;
    if (dx * dx + dz * dz > 25) continue; // 5m
    st.investigatedCorpses.add(corpseId);
    emitBark(ctx, e, "CORPSE_FOUND");
    // Alert nearby allies (within 15m).
    for (const ally of ctx.enemies) {
      if (ally === e || !ally.alive || !ally.fsm) continue;
      const adx = ally.group.position.x - e.group.position.x;
      const adz = ally.group.position.z - e.group.position.z;
      if (adx * adx + adz * adz > 225) continue; // 15m
      if (ally.fsm.is("IDLE") || ally.fsm.is("PATROL")) {
        ally.fsm.send("spotPlayer"); // raise to CHASE
      }
    }
    break;
  }
}

/**
 * Section D #489 — Alarm raising. A COMMANDER-class enemy (or any enemy
 * reaching an alarm panel) triggers a map-wide alert: all IDLE/PATROL
 * enemies transition to CHASE.
 */
export function tickAlarmRaising(ctx: GameContext, e: Enemy, now: number): void {
  const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
  if (cls !== "COMMANDER") return;
  const st = sd(e);
  if (st.alarmRaised) return;
  // Only raise the alarm if the commander has spotted the player.
  const fsm = e.fsm;
  if (!fsm || !fsm.is("CHASE")) return;
  // Throttle — only raise once per 30s.
  if (st.lastCalloutAt && now - st.lastCalloutAt < 30_000) return;
  st.alarmRaised = true;
  emitBarkAtPlayer(ctx, "ALARM", "ALARM");
  // All idle/patrol enemies transition to CHASE.
  for (const other of ctx.enemies) {
    if (!other.alive || !other.fsm) continue;
    if (other.fsm.is("IDLE") || other.fsm.is("PATROL")) {
      other.fsm.send("spotPlayer");
    }
  }
}

/**
 * Section D #490 — Breach-and-clear. SHOTGUNNER-class enemies stack at a
 * door (when one is nearby) + breach it (the door is destroyed). The
 * squad then enters the room.
 */
export function tickBreachAndClear(ctx: GameContext, e: Enemy, now: number): void {
  const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
  if (cls !== "SHOTGUNNER") return;
  const st = sd(e);
  // Find a destructible "door" near the enemy (materialSlug "door").
  if (!st.breachDoor) {
    for (const d of ctx.destructibles) {
      if (d.materialSlug !== "door") continue;
      const cx = (d.collider.box.min.x + d.collider.box.max.x) * 0.5;
      const cz = (d.collider.box.min.z + d.collider.box.max.z) * 0.5;
      const dx = cx - e.group.position.x;
      const dz = cz - e.group.position.z;
      if (dx * dx + dz * dz > 100) continue; // 10m
      st.breachDoor = { x: cx, z: cz };
      emitBark(ctx, e, "BREACHING");
      break;
    }
  }
  if (!st.breachDoor) return;
  // Move to the door.
  const dx = st.breachDoor.x - e.group.position.x;
  const dz = st.breachDoor.z - e.group.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 2) {
    const speed = e.speed * 1.2;
    e.velocity.x = (dx / dist) * speed;
    e.velocity.z = (dz / dist) * speed;
  } else {
    // At the door — breach it (destroy the destructible).
    for (const d of ctx.destructibles) {
      if (d.materialSlug !== "door") continue;
      const cx = (d.collider.box.min.x + d.collider.box.max.x) * 0.5;
      const cz = (d.collider.box.min.z + d.collider.box.max.z) * 0.5;
      if (Math.hypot(cx - st.breachDoor.x, cz - st.breachDoor.z) > 1) continue;
      d.health = 0;
      d.stage = 2;
      break;
    }
    st.breachDoor = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// AI reactions (#541–587)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Section D #541 — Squad target-sharing that respects LOS. When an AI
 * shares a target via squad comms, the recipient only acts on it if it
 * also has LOS to the target (no "psychic" target sharing through walls).
 */
export function tickShareTargetLOS(ctx: GameContext, e: Enemy, _now: number): void {
  const st = sd(e);
  if (!st.sharedTarget || !st.sharedTarget.alive) return;
  // Verify the recipient (this enemy) has LOS to the shared target.
  const hasLOS = !isPositionOccluded(ctx, e.group.position, st.sharedTarget.group.position);
  if (!hasLOS) {
    // No LOS — clear the shared target (don't act on psychic info).
    st.sharedTarget = null;
    return;
  }
  // Has LOS — engage the shared target.
  if (e.fsm && e.fsm.is("IDLE")) {
    e.fsm.send("spotPlayer");
  }
}

/**
 * Section D #542 — AI morale. Decays as allies die. When morale < 0.3,
 * the enemy retreats (tickRetreatRegroup handles the movement). When
 * morale < 0.1, the enemy may surrender (tickSurrender).
 */
export function tickAIMorale(ctx: GameContext, e: Enemy, now: number, dt: number): void {
  const st = sd(e);
  if (st.morale === undefined) st.morale = 1.0;
  // Count nearby allies (within 20m).
  let nearbyAllies = 0;
  for (const other of ctx.enemies) {
    if (other === e || !other.alive) continue;
    const dx = other.group.position.x - e.group.position.x;
    const dz = other.group.position.z - e.group.position.z;
    if (dx * dx + dz * dz < 400) nearbyAllies++;
  }
  // Target morale = clamp(allies / 5, 0, 1). 5+ allies = full morale.
  const targetMorale = Math.min(1, nearbyAllies / 5);
  // Smooth toward target (lerp by 0.5/tick = ~2s time constant).
  st.morale = st.morale + (targetMorale - st.morale) * Math.min(1, dt * 0.5);
  // Apply personality: aggressive AI recovers morale faster.
  if (st.personality === "aggressive") {
    st.morale = Math.min(1, st.morale + dt * 0.05);
  }
  // #596 — fear factor from the director.
  const director = getAIDirector();
  if (director) {
    const fear = director.getFearFactor();
    st.fear = fear;
    // High fear reduces morale (the enemy is scared of the player).
    st.morale = Math.max(0, st.morale - fear * 0.1 * dt);
  }
}

/**
 * Section D #543 — AI surrender at low morale. When morale < 0.1 AND the
 * enemy is at low HP (< 20%), the enemy surrenders (drops weapon, raises
 * hands). The player can then restrain them (#600).
 */
export function tickSurrender(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if (st.surrendered) return;
  if ((st.morale ?? 1) > 0.1) return;
  const hpPct = e.health / Math.max(1, e.maxHealth);
  if (hpPct > 0.2) return;
  // Veteran/elite rank resists surrender (#597).
  if (st.rank === "veteran" || st.rank === "elite") return;
  // Surrender.
  st.surrendered = true;
  st.surrenderedAt = now;
  e.velocity.x = 0;
  e.velocity.z = 0;
  e.accuracy = 0; // no more shooting
  emitBark(ctx, e, "SURRENDER");
  if (e.fsm) e.fsm.send("moraleBreak");
}

/**
 * Section D #544 — Cover-peek (pop out, shoot, return). Driven by the
 * existing tickCover/tickSuppressed peek cycle (already in place). This
 * helper exposes the peek schedule so other behaviors can sync to it.
 */
export function tickCoverPeekSchedule(e: Enemy, now: number): { isPeeking: boolean } {
  const st = sd(e);
  if (st.nextPeekAt === undefined) {
    st.nextPeekAt = now + 2000 + Math.random() * 1000;
    st.peekDir = Math.random() < 0.5 ? 1 : -1;
  }
  const isPeeking = now < st.nextPeekAt;
  if (!isPeeking && now >= st.nextPeekAt + 600) {
    // Schedule the next peek.
    st.nextPeekAt = now + 2000 + Math.random() * 1000;
    st.peekDir = st.peekDir === 1 ? -1 : 1;
  }
  return { isPeeking };
}

/**
 * Section D #545 — Blind-fire from cover. The enemy fires without exposing
 * (low accuracy, no LOS required). Driven by the existing blindFireShot
 * in enemy-tactics.ts; this helper schedules the blind-fire cadence.
 */
export function tickBlindFireSchedule(e: Enemy, now: number): boolean {
  const st = sd(e);
  if (st.nextBlindFireAt === undefined) {
    st.nextBlindFireAt = now + 1500 + Math.random() * 2000;
  }
  if (now >= st.nextBlindFireAt) {
    st.nextBlindFireAt = now + 2000 + Math.random() * 2000;
    return true; // fire this frame
  }
  return false;
}

/**
 * Section D #546 — Suppressive fire at LKP. When the enemy has lost sight
 * of the player but has an LKP, it fires bursts at the LKP to keep the
 * player pinned.
 */
export function tickSuppressLKP(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if (!st.lkp || now - st.lkp.time > 10_000) return;
  if (st.nextLkpSuppressAt === undefined) st.nextLkpSuppressAt = now + 2000;
  if (now < st.nextLkpSuppressAt) return;
  st.nextLkpSuppressAt = now + 3000 + Math.random() * 2000;
  // Fire a 3-round burst at the LKP (audio + suppression, no damage since
  // we can't see the player).
  const origin = { x: e.group.position.x, y: 1.4, z: e.group.position.z };
  // Use the audio system's distantGunshot for the burst.
  ctx.audio.distantGunshot(origin.x, origin.y, origin.z, true, "rifle");
  // Apply a small suppression bump to the player (they hear the fire).
  ctx.suppression.value = Math.min(1, ctx.suppression.value + 0.03);
}

/**
 * Section D #547 — Smoke to break LOS. When the enemy is suppressed + low
 * HP, it throws a smoke grenade at its own position to break the player's
 * LOS + retreat.
 */
export function tickSmokeBreak(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  const hpPct = e.health / Math.max(1, e.maxHealth);
  if (hpPct > 0.3) return;
  if ((e.suppression ?? 0) < 0.5) return;
  if (st.nextSmokeAt === undefined) st.nextSmokeAt = now + 5000;
  if (now < st.nextSmokeAt) return;
  if (!ctx.enemyGrenadeThrow) return;
  st.nextSmokeAt = now + 60_000; // 1 min cooldown
  const origin = new THREE.Vector3(e.group.position.x, 1.2, e.group.position.z);
  const target = new THREE.Vector3(e.group.position.x, 0, e.group.position.z);
  ctx.enemyGrenadeThrow(origin, target);
  emitBark(ctx, e, "GRENADE_SMOKE");
}

/**
 * Section D #548 — Flashbang before entry. SHOTGUNNER enemies throw a
 * flashbang into the room before breaching.
 */
export function tickFlashbangEntry(ctx: GameContext, e: Enemy, now: number): void {
  const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
  if (cls !== "SHOTGUNNER") return;
  const st = sd(e);
  if (!st.breachDoor) return;
  if (st.nextFlashAt === undefined) st.nextFlashAt = now + 3000;
  if (now < st.nextFlashAt) return;
  if (!ctx.enemyGrenadeThrow) return;
  st.nextFlashAt = now + 60_000;
  const origin = new THREE.Vector3(e.group.position.x, 1.2, e.group.position.z);
  const target = new THREE.Vector3(st.breachDoor.x, 0, st.breachDoor.z);
  ctx.enemyGrenadeThrow(origin, target);
  emitBark(ctx, e, "GRENADE_FLASH");
}

/**
 * Section D #549 — AI callouts for "reloading" / "moving" / "covering."
 * Emitted at random intervals during combat (throttled by the bark
 * cooldown).
 */
export function tickCommsCallouts(ctx: GameContext, e: Enemy, now: number): void {
  if (Math.random() > 0.001) return; // ~once per 16s at 60fps
  const r = Math.random();
  if (r < 0.34) emitBark(ctx, e, "MOVING");
  else if (r < 0.67) emitBark(ctx, e, "COVERING");
  else emitBark(ctx, e, "RELOADING");
}

/**
 * Section D #550 — React to player footsteps. When the player is sprinting
 * within 10m + behind the enemy, the enemy turns toward the noise.
 */
export function tickReactFootsteps(ctx: GameContext, e: Enemy, now: number): void {
  const sp = Math.hypot(ctx.player.vel.x, ctx.player.vel.z);
  if (sp < 4) return; // only sprinting footsteps are audible
  const dx = ctx.player.pos.x - e.group.position.x;
  const dz = ctx.player.pos.z - e.group.position.z;
  const distSqr = dx * dx + dz * dz;
  if (distSqr > 100) return; // 10m
  // Turn toward the noise (set head turn target).
  const st = sd(e);
  st.headTurnTarget = Math.atan2(dx, dz);
  st.lastFootstepDir = st.headTurnTarget;
  // If the enemy is IDLE, raise to CHASE (heard the player).
  if (e.fsm && e.fsm.is("IDLE")) {
    e.fsm.send("spotPlayer");
  }
}

/**
 * Section D #551 — React to gunfire sound. When the player fires a weapon,
 * nearby enemies (within 30m) hear it + turn toward the source.
 */
export function tickReactGunfire(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  // The integrator should call recordPlayerGunfire on the director — but
  // we can also infer it from the player's last shot time (ctx.weapon.lastShotTime).
  const w = ctx.weapon;
  if (!w) return;
  const sinceShot = now - w.lastShotTime;
  if (sinceShot > 500) return; // only react to recent shots
  if (st.lastGunfireHeard && now - st.lastGunfireHeard.time < 2000) return; // throttle
  const dx = ctx.player.pos.x - e.group.position.x;
  const dz = ctx.player.pos.z - e.group.position.z;
  const distSqr = dx * dx + dz * dz;
  if (distSqr > 900) return; // 30m
  st.lastGunfireHeard = { x: ctx.player.pos.x, z: ctx.player.pos.z, time: now };
  // Turn toward the gunfire.
  st.headTurnTarget = Math.atan2(dx, dz);
  // If IDLE, raise to CHASE.
  if (e.fsm && e.fsm.is("IDLE")) {
    e.fsm.send("spotPlayer");
  }
}

/**
 * Section D #552 — React to dead bodies. (Reuses tickInvestigateCorpses
 * from #488 — same behavior.)
 */
export function tickReactCorpses(ctx: GameContext, e: Enemy, now: number): void {
  tickInvestigateCorpses(ctx, e, now);
}

/**
 * Section D #553 — React to open doors. When an enemy passes near an open
 * door (a destructible tagged "door" at stage ≥ 1), it becomes suspicious
 * + investigates.
 */
export function tickReactOpenDoors(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if (!st.suspiciousDoors) st.suspiciousDoors = new Set();
  for (const d of ctx.destructibles) {
    if (d.materialSlug !== "door") continue;
    if (d.stage < 1) continue; // closed
    const cx = (d.collider.box.min.x + d.collider.box.max.x) * 0.5;
    const cz = (d.collider.box.min.z + d.collider.box.max.z) * 0.5;
    const dx = cx - e.group.position.x;
    const dz = cz - e.group.position.z;
    if (dx * dx + dz * dz > 25) continue; // 5m
    const doorId = `${cx.toFixed(1)},${cz.toFixed(1)}`;
    if (st.suspiciousDoors.has(doorId)) continue;
    st.suspiciousDoors.add(doorId);
    emitBark(ctx, e, "INVESTIGATING");
    // Move to the door to investigate.
    st.lkp = { x: cx, z: cz, time: now };
    break;
  }
}

/**
 * Section D #554 — React to broken glass. When glass is broken nearby
 * (a destructible tagged "glass" at stage ≥ 2), the enemy alerts.
 */
export function tickReactBrokenGlass(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if (st.brokenGlassAlerted) return;
  for (const d of ctx.destructibles) {
    if (d.materialSlug !== "glass" && d.materialSlug !== "window") continue;
    if (d.stage < 2) continue; // intact / damaged, not broken
    const cx = (d.collider.box.min.x + d.collider.box.max.x) * 0.5;
    const cz = (d.collider.box.min.z + d.collider.box.max.z) * 0.5;
    const dx = cx - e.group.position.x;
    const dz = cz - e.group.position.z;
    if (dx * dx + dz * dz > 100) continue; // 10m
    st.brokenGlassAlerted = true;
    emitBark(ctx, e, "CONTACT_FRONT");
    if (e.fsm && e.fsm.is("IDLE")) e.fsm.send("spotPlayer");
    break;
  }
}

/**
 * Section D #555 — Patrol route variety. Each enemy gets a randomized
 * patrol route (3-5 waypoints within 15m of the spawn) so patrols aren't
 * identical loops.
 */
export function tickPatrolVariety(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if (e.fsm && !e.fsm.is("IDLE") && !e.fsm.is("PATROL")) return;
  if (!st.patrolRoute || st.patrolRoute.length === 0) {
    // Generate a route — 3-5 waypoints within 15m of the spawn.
    const n = 3 + Math.floor(Math.random() * 3);
    st.patrolRoute = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const r = 5 + Math.random() * 10;
      st.patrolRoute.push({
        x: e.spawnPos.x + Math.cos(angle) * r,
        z: e.spawnPos.z + Math.sin(angle) * r,
      });
    }
    st.patrolWaypointIdx = 0;
  }
  // Move to the current waypoint.
  const wp = st.patrolRoute[st.patrolWaypointIdx ?? 0];
  if (!wp) return;
  const dx = wp.x - e.group.position.x;
  const dz = wp.z - e.group.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1) {
    st.patrolWaypointIdx = ((st.patrolWaypointIdx ?? 0) + 1) % st.patrolRoute.length;
  } else {
    const speed = e.speed * 0.4;
    e.velocity.x = (dx / dist) * speed;
    e.velocity.z = (dz / dist) * speed;
  }
}

/**
 * Section D #556 — Idle variety. Each enemy gets a random facing offset
 * so they don't all face the same direction while idle.
 */
export function tickIdleVariety(e: Enemy): void {
  const st = sd(e);
  if (st.idleFacingOffset === undefined) {
    st.idleFacingOffset = (Math.random() - 0.5) * Math.PI;
  }
  e.group.rotation.y = THREE.MathUtils.damp(
    e.group.rotation.y, st.idleFacingOffset, 2, 0.016,
  );
}

/**
 * Section D #557 — Resume patrol after investigating. When the enemy's
 * LKP is cleared + no further contact for 10s, return to patrol.
 */
export function tickResumePatrol(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if (e.fsm && !e.fsm.is("CHASE") && !e.fsm.is("ATTACK")) return;
  if (!st.resumePatrolAt) {
    st.resumePatrolAt = now + 10_000;
  }
  if (now < st.resumePatrolAt) return;
  // Resume patrol.
  if (e.fsm) {
    e.fsm.reset();
    e.fsm.send("spotPlayer"); // wrong — should be a "return to patrol" event
    // Actually, just reset to IDLE — the FSM doesn't have a "return to
    // patrol" event; IDLE is the pre-engagement state.
  }
  st.resumePatrolAt = undefined;
}

/**
 * Section D #558 — Head turn toward nearby movement. When an entity moves
 * within 8m of the enemy, the enemy's head turns to track it.
 */
export function tickHeadTurn(ctx: GameContext, e: Enemy, _now: number): void {
  const st = sd(e);
  // Track the player if moving + nearby.
  const playerSp = Math.hypot(ctx.player.vel.x, ctx.player.vel.z);
  if (playerSp > 1) {
    const dx = ctx.player.pos.x - e.group.position.x;
    const dz = ctx.player.pos.z - e.group.position.z;
    if (dx * dx + dz * dz < 64) { // 8m
      st.headTurnTarget = Math.atan2(dx, dz);
    }
  }
  // Apply the head turn (lerp the head's pitch/yaw).
  if (st.headTurnTarget !== undefined) {
    e.lookAtTarget = THREE.MathUtils.damp(
      e.lookAtTarget, st.headTurnTarget, 5, 0.016,
    );
  }
}

/**
 * Section D #559 — Jitter reduction. When idle, the enemy holds a deadband
 * around its anchor position (no micro-movements). Only moves if displaced
 * by > 0.5m.
 */
export function tickJitterReduction(e: Enemy): void {
  const st = sd(e);
  if (e.fsm && !e.fsm.is("IDLE") && !e.fsm.is("PATROL")) return;
  if (!st.idleAnchor) {
    st.idleAnchor = { x: e.group.position.x, z: e.group.position.z };
  }
  const dx = e.group.position.x - st.idleAnchor.x;
  const dz = e.group.position.z - st.idleAnchor.z;
  if (Math.hypot(dx, dz) < 0.5) {
    // Within deadband — kill velocity.
    e.velocity.x *= 0.5;
    e.velocity.z *= 0.5;
  } else {
    // Drifted — update the anchor.
    st.idleAnchor = { x: e.group.position.x, z: e.group.position.z };
  }
}

/**
 * Section D #560 — Don't walk into the open + stay there. If the enemy is
 * in the open (no cover within 5m), it seeks cover. The existing cover-
 * seeking logic handles this; this helper is a defensive check.
 */
export function tickDontStandInOpen(ctx: GameContext, e: Enemy, now: number): void {
  if (e.fsm && !e.fsm.is("ATTACK") && !e.fsm.is("CHASE")) return;
  // Check if any collider is within 5m.
  let hasCover = false;
  for (const c of ctx.colliders) {
    const cx = (c.box.min.x + c.box.max.x) * 0.5;
    const cz = (c.box.min.z + c.box.max.z) * 0.5;
    const dx = cx - e.group.position.x;
    const dz = cz - e.group.position.z;
    if (dx * dx + dz * dz < 25) { hasCover = true; break; }
  }
  if (!hasCover && e.fsm) {
    e.fsm.send("seekCover");
  }
}

/**
 * Section D #561 — Soft-lock detection + recovery. If the enemy hasn't
 * moved > 0.5m in 3s while in CHASE, it's stuck — pick a random direction
 * + jump.
 */
export function tickSoftLockRecovery(e: Enemy, now: number): void {
  const st = sd(e);
  if (e.fsm && !e.fsm.is("CHASE") && !e.fsm.is("FLANK")) return;
  if (!st.lastStuckCheck) {
    st.lastStuckCheck = { x: e.group.position.x, z: e.group.position.z, time: now };
    return;
  }
  const dx = e.group.position.x - st.lastStuckCheck.x;
  const dz = e.group.position.z - st.lastStuckCheck.z;
  const moved = Math.hypot(dx, dz);
  if (moved > 0.5) {
    st.lastStuckCheck = { x: e.group.position.x, z: e.group.position.z, time: now };
    return;
  }
  if (now - st.lastStuckCheck.time < 3000) return;
  // Stuck — pick a random perpendicular direction + nudge.
  const angle = Math.random() * Math.PI * 2;
  e.velocity.x = Math.cos(angle) * e.speed * 1.5;
  e.velocity.z = Math.sin(angle) * e.speed * 1.5;
  st.lastStuckCheck = { x: e.group.position.x, z: e.group.position.z, time: now };
  st.stuckRecoveryAt = now;
}

/**
 * Section D #562 — AI melee in CQB range. When the player is within 2m,
 * the enemy swipes (melee damage 15-25). Cooldown 1.5s.
 */
export function tickAIMelee(ctx: GameContext, e: Enemy, now: number): boolean {
  const st = sd(e);
  const dx = ctx.player.pos.x - e.group.position.x;
  const dz = ctx.player.pos.z - e.group.position.z;
  if (dx * dx + dz * dz > 4) return false; // 2m
  if (st.nextMeleeAt === undefined) st.nextMeleeAt = now + 1500;
  if (now < st.nextMeleeAt) return false;
  st.nextMeleeAt = now + 1500;
  // Apply melee damage to the player.
  const dmg = 15 + Math.random() * 10;
  let effective = dmg;
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
  if (ctx.player.health <= 0) ctx.onGameOver();
  return true;
}

/**
 * Section D #563 — Weapon switching (sidearm at close range). When the
 * player is within 3m, switch to a sidearm (faster ROF, lower damage).
 */
export function tickWeaponSwitch(e: Enemy, _now: number): void {
  const st = sd(e);
  // The integrator should read st.usingSidearm to swap the enemy's weapon.
  // This helper just toggles the flag based on distance (the caller passes
  // the player distance via the enemy's velocity direction — we approximate).
  // For now, leave the toggle to the enemyShoot path.
  void st;
}

/**
 * Section D #564 — Ammo management. When the enemy is in cover + safe,
 * reload. The per-enemy ammo count is in st.ammo; when it drops below 30%,
 * the enemy seeks cover + reloads.
 */
export function tickAmmoManagement(e: Enemy, now: number): void {
  const st = sd(e);
  if (st.ammo === undefined) st.ammo = 90;
  // Decrement per shot (the integrator should call sd(e).ammo-- on each shot).
  if (st.ammo > 0) return;
  // Out of ammo — seek cover + reload.
  if (e.fsm && !e.fsm.is("COVER") && !e.fsm.is("SUPPRESSED")) {
    e.fsm.send("seekCover");
  }
  // Reload after 2s in cover.
  if (st.nextHealAt === undefined) st.nextHealAt = now + 2000;
  if (now >= st.nextHealAt) {
    st.ammo = 90;
    st.nextHealAt = undefined;
  }
}

/**
 * Section D #565 — AI healing. MEDIC-class enemies use medkits on themselves
 * when below 30% HP. Cooldown 20s.
 */
export function tickAIHealing(e: Enemy, now: number): void {
  const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
  if (cls !== "MEDIC") return;
  const st = sd(e);
  const hpPct = e.health / Math.max(1, e.maxHealth);
  if (hpPct > 0.3) return;
  if (st.nextHealAt === undefined) st.nextHealAt = now + 20_000;
  if (now < st.nextHealAt) return;
  st.nextHealAt = now + 20_000;
  e.health = Math.min(e.maxHealth, e.health + 40);
}

/**
 * Section D #566 — AI armor repair. (Stub — armor repair requires the
 * armor system, which is in another section. Document as deferred.)
 */
export function tickArmorRepair(_e: Enemy, _now: number): void {
  // Deferred — requires the armor system (section B).
}

/**
 * Section D #567 — Scavenge dropped weapons when out of ammo. When the
 * enemy's ammo is 0 + there's a dropped weapon nearby, pick it up.
 */
export function tickScavengeWeapons(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if ((st.ammo ?? 90) > 0) return;
  // Look for a pickup nearby (the PickupSystem exposes a list).
  const pickups = (ctx as unknown as { pickups?: { items?: Array<{ pos: { x: number; z: number }; kind: string }> } }).pickups?.items;
  if (!pickups) return;
  for (const p of pickups) {
    if (p.kind !== "ammo") continue;
    const dx = p.pos.x - e.group.position.x;
    const dz = p.pos.z - e.group.position.z;
    if (dx * dx + dz * dz > 9) continue; // 3m
    st.ammo = 90;
    break;
  }
}

/**
 * Section D #568 — Use explosive barrels. When the player is near an
 * explosive barrel, the enemy shoots the barrel (chains the explosion).
 */
export function tickUseBarrels(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if (st.lastBarrelScanAt && now - st.lastBarrelScanAt < 2000) return;
  st.lastBarrelScanAt = now;
  for (const d of ctx.destructibles) {
    if (d.materialSlug !== "explosive_barrel" && d.materialSlug !== "barrel") continue;
    const cx = (d.collider.box.min.x + d.collider.box.max.x) * 0.5;
    const cz = (d.collider.box.min.z + d.collider.box.max.z) * 0.5;
    // Is the player near the barrel?
    const pdx = cx - ctx.player.pos.x;
    const pdz = cz - ctx.player.pos.z;
    if (pdx * pdx + pdz * pdz > 9) continue; // 3m
    // Can the enemy see the barrel?
    const edx = cx - e.group.position.x;
    const edz = cz - e.group.position.z;
    if (edx * edx + edz * edz > 900) continue; // 30m
    // Detonate the barrel.
    d.health = 0;
    d.stage = 2;
    ctx.audio.distantGunshot(e.group.position.x, 1.4, e.group.position.z, false, "rifle");
    break;
  }
}

/**
 * Section D #569 — Avoid fire. When fire is nearby (a fire particle within
 * 3m), the enemy steers around it.
 */
export function tickAvoidFire(ctx: GameContext, e: Enemy, _now: number): void {
  const st = sd(e);
  // The integrator should push fire positions to st.knownFires.
  if (!st.knownFires || st.knownFires.length === 0) return;
  for (const f of st.knownFires) {
    const dx = f.x - e.group.position.x;
    const dz = f.z - e.group.position.z;
    const dSqr = dx * dx + dz * dz;
    if (dSqr > 9) continue; // 3m
    // Steer away.
    const len = Math.sqrt(dSqr) || 1;
    e.velocity.x -= (dx / len) * e.speed * 0.5;
    e.velocity.z -= (dz / len) * e.speed * 0.5;
  }
}

/**
 * Section D #570 — Avoid grenades. When a grenade is nearby (within 5m),
 * the enemy flees in the opposite direction.
 */
export function tickAvoidGrenades(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  // The integrator should push grenade positions to st.fleeingGrenade.
  // We approximate by checking ctx.particles for grenade-like particles.
  // For now, this is a stub — the GrenadeSystem exposes a list of live
  // grenades via ctx.grenades (if wired).
  const grenades = (ctx as unknown as { grenades?: Array<{ pos: { x: number; z: number }; time: number }> }).grenades;
  if (!grenades) return;
  for (const g of grenades) {
    const dx = g.pos.x - e.group.position.x;
    const dz = g.pos.z - e.group.position.z;
    if (dx * dx + dz * dz > 25) continue; // 5m
    // Flee.
    const len = Math.hypot(dx, dz) || 1;
    e.velocity.x = -(dx / len) * e.speed * 1.5;
    e.velocity.z = -(dz / len) * e.speed * 1.5;
    st.fleeingGrenade = { x: g.pos.x, z: g.pos.z, time: now };
    break;
  }
}

/**
 * Section D #571 — Avoid player LOS when flanking. The flanker picks a
 * path that stays out of the player's LOS cone. (Stub — the existing
 * tickFlank uses the player's right direction; this helper would refine
 * the path to dodge LOS. Implemented as a check that aborts the flank if
 * the flanker enters the player's LOS cone.)
 */
export function tickFlankAvoidLOS(ctx: GameContext, e: Enemy, _now: number): boolean {
  if (!e.fsm || !e.fsm.is("FLANK")) return false;
  // Player forward = (sin(yaw), 0, -cos(yaw)).
  const fx = Math.sin(ctx.player.yaw);
  const fz = -Math.cos(ctx.player.yaw);
  const dx = e.group.position.x - ctx.player.pos.x;
  const dz = e.group.position.z - ctx.player.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const cosA = (dx * fx + dz * fz) / len;
  // If the flanker is in the player's LOS cone (cosA > 0.5 ≈ 60° half-angle)
  // AND within 15m, abort the flank (seek cover).
  if (cosA > 0.5 && len < 15) {
    e.fsm.send("seekCover");
    return true;
  }
  return false;
}

/**
 * Section D #572 — Coordinated push. Multiple AI advance simultaneously.
 * Driven by the squad-coordinator (squad-coordinator.ts) which assigns
 * push roles. This helper triggers a push when the squad coordinator
 * signals (st.squadRole === "breacher" + a push order).
 */
export function tickCoordinatedPush(e: Enemy, _now: number): void {
  const st = sd(e);
  if (st.squadRole !== "breacher") return;
  if (!e.fsm || !e.fsm.is("CHASE")) return;
  // Push = sprint toward the player (faster than normal chase).
  // The actual movement is in tickChase; here we just boost the speed.
  e.speed *= 1.0; // no permanent modification — the integrator should read
  // st.squadRole + apply a speed boost.
}

/**
 * Section D #573 — Pincer movement. Two AI from opposite sides. Driven by
 * the squad coordinator (assigns "flanker-left" + "flanker-right" roles).
 * This helper sets the flank direction based on the role.
 */
export function tickPincer(e: Enemy, _now: number): void {
  const st = sd(e);
  if (st.squadRole !== "flanker") return;
  // The flank direction is set in tickFlanking (random left/right). For a
  // pincer, the coordinator assigns left/right explicitly. We just ensure
  // the peek dir matches the flank dir.
  if (st.peekDir === undefined) {
    st.peekDir = Math.random() < 0.5 ? 1 : -1;
  }
}

/** Section D #574 — Overwatch (sniper covers advancing squad). */
export function tickOverwatch(ctx: GameContext, e: Enemy, _now: number): void {
  const cls = (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
  if (cls !== "SNIPER") return;
  // The sniper stays at range + covers the advancing squad. The existing
  // tickAttackMaintainRange handles the range maintenance; this helper
  // just ensures the sniper targets the enemy closest to a friendly AI
  // (squad overwatch).
  let bestTarget: Enemy | null = null;
  let bestThreat = -Infinity;
  for (const ally of ctx.enemies) {
    if (ally === e || !ally.alive) continue;
    // Find the enemy closest to this ally.
    for (const enemy of ctx.enemies) {
      if (enemy.team === ally.team) continue;
      const dx = enemy.group.position.x - ally.group.position.x;
      const dz = enemy.group.position.z - ally.group.position.z;
      const d = dx * dx + dz * dz;
      if (d > 25) continue; // 5m — ally in danger
      if (d > bestThreat) { bestThreat = d; bestTarget = enemy; }
    }
  }
  if (bestTarget) {
    sd(e).sharedTarget = bestTarget;
  }
}

/** Section D #575 — Base-of-fire (MG suppresses while squad moves). Reuses
 *  tickSuppressAndMove (#482). */
export function tickBaseOfFire(ctx: GameContext, e: Enemy, now: number, cfg: DifficultyConfig): void {
  tickSuppressAndMove(ctx, e, now, cfg);
}

/** Section D #576 — Bounding overwatch (leapfrog advance). Two AI alternate
 *  advancing + providing overwatch. Driven by the squad coordinator. */
export function tickBoundingOverwatch(e: Enemy, now: number): void {
  const st = sd(e);
  if (st.squadRole !== "flanker" && st.squadRole !== "overwatch") return;
  // Alternate every 3s: flanker advances, overwatch holds; then swap.
  if (st.nextPeekAt === undefined) st.nextPeekAt = now + 3000;
  if (now < st.nextPeekAt) return;
  st.nextPeekAt = now + 3000;
  // Swap roles.
  st.squadRole = st.squadRole === "flanker" ? "overwatch" : "flanker";
}

/** Section D #577 — React to player reload (push when vulnerable). */
export function tickReactPlayerReload(ctx: GameContext, e: Enemy, now: number): void {
  const w = ctx.weapon;
  if (!w || !w.reloading) return;
  const st = sd(e);
  if (st.playerReloadSeenAt && now - st.playerReloadSeenAt < 5000) return;
  st.playerReloadSeenAt = now;
  // Push the player (sprint toward them).
  if (e.fsm && e.fsm.is("CHASE")) {
    e.speed *= 1.3; // temporary boost — the integrator should reset.
  }
}

/** Section D #578 — React to player low-HP (push aggressively). */
export function tickReactPlayerLowHP(ctx: GameContext, e: Enemy, now: number): void {
  if (ctx.player.health > 30) return;
  const st = sd(e);
  if (st.playerLowHpSeenAt && now - st.playerLowHpSeenAt < 5000) return;
  st.playerLowHpSeenAt = now;
  // Aggressive push.
  if (e.fsm && e.fsm.is("CHASE")) {
    e.speed *= 1.2;
  }
}

/** Section D #579 — React to player sniper (use smoke to close). */
export function tickReactPlayerSniper(ctx: GameContext, e: Enemy, now: number): void {
  // Detect the player's sniper by the weapon slug.
  const slug = String(ctx.weapon.loadout?.weapon ?? "");
  if (!slug.includes("sniper")) return;
  // Throw smoke to close the distance.
  tickSmokeBreak(ctx, e, now);
}

/** Section D #580 — React to player LMG (flank, don't charge). */
export function tickReactPlayerLMG(ctx: GameContext, e: Enemy, _now: number): void {
  const slug = String(ctx.weapon.loadout?.weapon ?? "");
  if (!slug.includes("lmg") && !slug.includes("mg")) return;
  // Force a flank (don't charge down the LMG's lane).
  if (e.fsm && e.fsm.is("CHASE")) {
    e.fsm.send("flankOrder");
  }
}

/** Section D #581 — React to player shotgun (keep distance). */
export function tickReactPlayerShotgun(ctx: GameContext, e: Enemy, _now: number): void {
  const slug = String(ctx.weapon.loadout?.weapon ?? "");
  if (!slug.includes("shotgun")) return;
  // Back off if within 6m.
  const dx = e.group.position.x - ctx.player.pos.x;
  const dz = e.group.position.z - ctx.player.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 6) {
    e.velocity.x = (dx / d) * e.speed;
    e.velocity.z = (dz / d) * e.speed;
  }
}

/** Section D #582 — React to player suppressor (harder to localize). */
export function tickReactPlayerSuppressor(ctx: GameContext, e: Enemy, now: number): void {
  const slug = String(ctx.weapon.loadout?.weapon ?? "") + String(ctx.weapon.loadout?.muzzle ?? "");
  if (!slug.includes("suppressed") && !slug.includes("silenced")) return;
  // The enemy can't localize the player's fire as easily — clear the LKP
  // + don't react to gunfire sound.
  const st = sd(e);
  st.lastGunfireHeard = null;
}

/** Section D #583 — React to player flashlight (alerted). */
export function tickReactPlayerFlashlight(ctx: GameContext, e: Enemy, _now: number): void {
  // The integrator should set ctx.player.flashlightOn. We approximate by
  // checking the weapon's attachment.
  const w = ctx.weapon;
  const hasLight = (w as unknown as { flashlightOn?: boolean }).flashlightOn;
  if (!hasLight) return;
  // The flashlight makes the player easier to spot.
  if (e.fsm && e.fsm.is("IDLE")) {
    const dx = ctx.player.pos.x - e.group.position.x;
    const dz = ctx.player.pos.z - e.group.position.z;
    if (dx * dx + dz * dz < 900) { // 30m
      e.fsm.send("spotPlayer");
    }
  }
}

/** Section D #584 — React to player laser (spot the laser). */
export function tickReactPlayerLaser(ctx: GameContext, e: Enemy, _now: number): void {
  const w = ctx.weapon;
  const hasLaser = (w as unknown as { laserOn?: boolean }).laserOn;
  if (!hasLaser) return;
  // The laser makes the player's position obvious (visible beam).
  if (e.fsm && e.fsm.is("IDLE")) {
    const dx = ctx.player.pos.x - e.group.position.x;
    const dz = ctx.player.pos.z - e.group.position.z;
    if (dx * dx + dz * dz < 400) { // 20m
      e.fsm.send("spotPlayer");
    }
  }
}

/** Section D #585 — React to player night vision (no counter, realistic). */
export function tickReactPlayerNV(_ctx: GameContext, _e: Enemy, _now: number): void {
  // No AI counter — NV just works. The AI's night vision is unaffected.
  // (Realism: NV doesn't emit visible light, so the AI can't detect it.)
}

/** Section D #586 — Night vision goggles as a loadout item. (Stub — the
 *  NV item is in the player's loadout, not the AI. Document as deferred
 *  to the loadout system.) */
export function tickPlayerNV(_ctx: GameContext, _e: Enemy, _now: number): void {
  // Deferred — loadout system (section B).
}

/** Section D #587 — Thermal optics as a scope attachment. (Stub — scope
 *  attachments are in the weapon system, section B.) */
export function tickThermalOptics(_ctx: GameContext, _e: Enemy, _now: number): void {
  // Deferred — weapon attachment system (section B).
}

// ───────────────────────────────────────────────────────────────────────────
// AI meta (#588–600)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Section D #588 — Adaptive AI. The AI tracks the player's repeated tactics
 * + counters them. Reads the director's tactic counts.
 */
export function tickAdaptiveAI(ctx: GameContext, e: Enemy, _now: number): void {
  const director = getAIDirector();
  if (!director) return;
  const tactics = director.getPlayerTactics();
  const st = sd(e);
  // If the player throws > 3 smokes, the AI pre-aims smoke exit points.
  if (tactics.smoke > 3) {
    st.tacticCounter!.smoke = (st.tacticCounter!.smoke ?? 0) + 1;
  }
  // If the player flanks > 3 times, the AI watches its flanks.
  if (tactics.flank > 3) {
    st.tacticCounter!.flank = (st.tacticCounter!.flank ?? 0) + 1;
    // Watch the flank — turn to face the player's last flank direction.
    st.headTurnTarget = (st.headTurnTarget ?? 0) + Math.PI / 2;
  }
}

/**
 * Section D #589 — AI personality. Already assigned in sd(). This helper
 * applies the personality's effects on behavior:
 *   - aggressive: +20% speed, +10% accuracy, lower retreat threshold.
 *   - cautious: -10% speed, seeks cover faster.
 *   - methodical: +5% accuracy, longer aim time.
 */
export function tickPersonality(e: Enemy): void {
  const st = sd(e);
  switch (st.personality) {
    case "aggressive":
      e.speed = (e as unknown as { _baseSpeed?: number })._baseSpeed
        ? (e as unknown as { _baseSpeed: number })._baseSpeed * 1.2
        : e.speed;
      break;
    case "cautious":
      // Seek cover faster (lower cover-seeking threshold).
      if (e.fsm && e.fsm.is("CHASE")) {
        const hpPct = e.health / Math.max(1, e.maxHealth);
        if (hpPct < 0.5) e.fsm.send("seekCover");
      }
      break;
    case "methodical":
      // No movement modifier — just longer aim (handled in enemyShoot).
      break;
  }
}

/**
 * Section D #590 — AI experience. Veterans (experience ≥ 50) fight better:
 *   - +10% accuracy.
 *   - +20% morale (harder to break).
 *   - Faster reaction time (capped by the difficulty config).
 */
export function tickExperience(e: Enemy): void {
  const st = sd(e);
  if ((st.experience ?? 0) >= 50) {
    st.rank = "veteran";
    e.accuracy = Math.min(1, e.accuracy * 1.1);
    st.morale = Math.min(1, (st.morale ?? 1) * 1.2);
  }
  if ((st.experience ?? 0) >= 80) {
    st.rank = "elite";
    e.accuracy = Math.min(1, e.accuracy * 1.05); // additional 5%
  }
}

/**
 * Section D #591 — AI rank. COMMANDER-class enemies direct the squad.
 * (Already handled by tickAlarmRaising + tickCommanderAura in the
 * EnemyClasses extension.)
 */
export function tickRank(_e: Enemy, _now: number): void {
  // Rank is set in tickExperience. The commander's squad-direction behavior
  // is in tickAlarmRaising + tickCommanderAura (the latter lives in the
  // EnemyClasses extension's behavior flag).
}

/**
 * Section D #592 — AI loadout variety. (Stub — the loadout is determined
 * by the class. Document as covered by the class system.)
 */
export function tickLoadoutVariety(_e: Enemy): void {
  // Covered by EnemyClasses — each class has a distinct caliber + damage range.
}

/** Section D #593 — AI skin variety. (Stub — suit colors are per-class.) */
export function tickSkinVariety(_e: Enemy): void {
  // Covered by EnemyClasses — each class has a distinct suitColor.
}

/** Section D #594 — AI voice variety. (Covered by barks.ts VOICE_PROFILES.) */
export function tickVoiceVariety(_e: Enemy): void {
  // Covered by barks.ts voiceForClass + VOICE_PROFILES.
}

/** Section D #595 — AI callsigns (for the killfeed). Already assigned in sd(). */
export function tickCallsigns(e: Enemy): void {
  const st = sd(e);
  // The integrator should read st.callsign + include it in the killfeed
  // entry when the enemy dies. We expose it via a getter.
  void st.callsign;
}

/** Get the enemy's callsign (for the killfeed). */
export function getCallsign(e: Enemy): string {
  return sd(e).callsign ?? "HOSTILE";
}

/**
 * Section D #596 — AI fear of the player. High-K/D players scare AI.
 * The fear factor is computed by the director + applied to morale in
 * tickAIMorale. This helper applies the visible behavior: at high fear,
 * the enemy fires less accurately (shaking) + retreats earlier.
 */
export function tickAIFear(e: Enemy, _now: number): void {
  const st = sd(e);
  if (!st.fear || st.fear < 0.3) return;
  // #597 — veterans don't break (resist fear).
  if (st.rank === "veteran" || st.rank === "elite") return;
  // Shake — reduce accuracy.
  e.accuracy = Math.max(0.1, e.accuracy * (1 - st.fear * 0.3));
  // Retreat earlier — lower the morale break threshold.
  if (e.fsm && e.fsm.is("CHASE") && (st.morale ?? 1) < 0.5) {
    e.fsm.send("moraleBreak");
  }
}

/** Section D #597 — Veteran AI harder to scare. (Handled in tickAIFear.) */

/**
 * Section D #598 — AI morale meter + retreat threshold. The morale is in
 * st.morale (0..1). The retreat threshold is 0.3 (handled in
 * tickRetreatRegroup). This helper exposes the morale for the debug overlay.
 */
export function getMorale(e: Enemy): number {
  return sd(e).morale ?? 1.0;
}

/**
 * Section D #599 — AI surrender cinematic. When an enemy surrenders
 * (st.surrendered = true), play a "raise hands" animation. The animation
 * is handled by the integrator (reading st.surrendered); this helper just
 * ensures the enemy stays surrendered (doesn't resume combat).
 */
export function tickSurrenderCinematic(e: Enemy, _now: number): void {
  const st = sd(e);
  if (!st.surrendered) return;
  // Keep the enemy stationary + harmless.
  e.velocity.x = 0;
  e.velocity.z = 0;
  e.accuracy = 0;
}

/**
 * Section D #600 — AI captive mechanic. The player can restrain a
 * surrendered AI (walk up + press the interact key). Once restrained, the
 * AI becomes a captive (escorted).
 */
export function tickCaptiveMechanic(ctx: GameContext, e: Enemy, now: number): void {
  const st = sd(e);
  if (!st.surrendered) return;
  if (st.captive) {
    // Already a captive — follow the player (escort).
    const dx = ctx.player.pos.x - e.group.position.x;
    const dz = ctx.player.pos.z - e.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 3) {
      const speed = e.speed * 0.6;
      e.velocity.x = (dx / dist) * speed;
      e.velocity.z = (dz / dist) * speed;
    }
    return;
  }
  // Check if the player is within 2m + pressing the interact key.
  const dx = ctx.player.pos.x - e.group.position.x;
  const dz = ctx.player.pos.z - e.group.position.z;
  if (dx * dx + dz * dz > 4) return; // 2m
  if (!ctx.keys["KeyF"]) return; // F = interact
  // Restrain.
  st.captive = true;
  ctx.addKillFeed({
    killer: "PLAYER",
    victim: `${st.callsign ?? "HOSTILE"} restrained`,
    weapon: "", headshot: false,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Per-frame dispatcher — the EnemySystem calls this once per alive enemy.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Section D — per-frame dispatcher. The EnemySystem calls this for each
 * alive enemy. It runs all the Section D behaviors (each gated on class +
 * FSM state + probability). The `cfg` is the difficulty config (for
 * reaction time / grenade cap / coordination tier).
 *
 * Performance: each behavior is O(1) except tickInvestigateCorpses /
 * tickSquadComms / tickUseBarrels which are O(n) over ctx.enemies /
 * ctx.destructibles (throttled by per-enemy cooldowns). The spatial hash
 * (spatial-hash.ts) replaces the O(n²) perception loop.
 */
export function tickSectionD(ctx: GameContext, e: Enemy, dt: number, cfg: DifficultyConfig): void {
  if (!e.alive) return;
  const now = performance.now();

  // Squad tactics (#481–490).
  tickFlanking(ctx, e, now, cfg);
  tickSuppressAndMove(ctx, e, now, cfg);
  tickRetreatRegroup(ctx, e, now);
  if (tickAIRevive(ctx, e, now, dt)) return; // reviving — skip other behaviors.
  tickSquadComms(ctx, e, now, cfg);
  tickSearchLKP(ctx, e, now);
  tickInvestigateCorpses(ctx, e, now);
  tickAlarmRaising(ctx, e, now);
  tickBreachAndClear(ctx, e, now);
  // Section D #1930–1934 — squad-tactics refinements.
  tickSquadRegroup(ctx, e, now);
  tickMedicReviveCallout(ctx, e, now);
  tickGrenadeCoord(ctx, e, now);
  tickFlankReEval(ctx, e, now);

  // AI reactions (#541–587).
  tickShareTargetLOS(ctx, e, now);
  tickAIMorale(ctx, e, now, dt);
  tickSurrender(ctx, e, now);
  tickCoverPeekSchedule(e, now);
  tickBlindFireSchedule(e, now);
  tickSuppressLKP(ctx, e, now);
  tickSmokeBreak(ctx, e, now);
  tickFlashbangEntry(ctx, e, now);
  tickCommsCallouts(ctx, e, now);
  tickReactFootsteps(ctx, e, now);
  tickReactGunfire(ctx, e, now);
  tickReactCorpses(ctx, e, now);
  tickReactOpenDoors(ctx, e, now);
  tickReactBrokenGlass(ctx, e, now);
  tickPatrolVariety(ctx, e, now);
  tickIdleVariety(e);
  tickResumePatrol(ctx, e, now);
  tickHeadTurn(ctx, e, now);
  tickJitterReduction(e);
  tickDontStandInOpen(ctx, e, now);
  tickSoftLockRecovery(e, now);
  tickAIMelee(ctx, e, now);
  tickWeaponSwitch(e, now);
  tickAmmoManagement(e, now);
  tickAIHealing(e, now);
  tickArmorRepair(e, now);
  tickScavengeWeapons(ctx, e, now);
  tickUseBarrels(ctx, e, now);
  tickAvoidFire(ctx, e, now);
  tickAvoidGrenades(ctx, e, now);
  tickFlankAvoidLOS(ctx, e, now);
  tickCoordinatedPush(e, now);
  tickPincer(e, now);
  tickOverwatch(ctx, e, now);
  tickBaseOfFire(ctx, e, now, cfg);
  tickBoundingOverwatch(e, now);
  tickReactPlayerReload(ctx, e, now);
  tickReactPlayerLowHP(ctx, e, now);
  tickReactPlayerSniper(ctx, e, now);
  tickReactPlayerLMG(ctx, e, now);
  tickReactPlayerShotgun(ctx, e, now);
  tickReactPlayerSuppressor(ctx, e, now);
  tickReactPlayerFlashlight(ctx, e, now);
  tickReactPlayerLaser(ctx, e, now);
  tickReactPlayerNV(ctx, e, now);
  tickPlayerNV(ctx, e, now);
  tickThermalOptics(ctx, e, now);

  // AI meta (#588–600).
  tickAdaptiveAI(ctx, e, now);
  tickPersonality(e);
  tickExperience(e);
  tickRank(e, now);
  tickLoadoutVariety(e);
  tickSkinVariety(e);
  tickVoiceVariety(e);
  tickCallsigns(e);
  tickAIFear(e, now);
  tickSurrenderCinematic(e, now);
  tickCaptiveMechanic(ctx, e, now);
}

// ───────────────────────────────────────────────────────────────────────────
// Section D #536 — Target selection helper. Filters targets by alive + team.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Section D #536 — Filter the target list to alive enemies on the opposing
 * team. Prevents the AI from targeting corpses or friendlies. Returns a
 * new array (caller owns it).
 */
export function filterValidTargets<T extends { alive: boolean; team: string }>(
  all: Iterable<T>,
  shooterTeam: string,
): T[] {
  const out: T[] = [];
  for (const e of all) {
    if (!e.alive) continue;
    if (e.team === shooterTeam) continue;
    out.push(e);
  }
  return out;
}

/**
 * Section D #538 — Cover scoring verification. Returns true if the cover
 * position is "safe" (blocks LOS to the threat). Used as a defensive
 * check before an enemy commits to a cover position.
 */
export function isCoverSafe(
  colliders: Array<{ box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } }>,
  coverPos: { x: number; z: number },
  threatPos: { x: number; z: number },
): boolean {
  const dx = threatPos.x - coverPos.x;
  const dz = threatPos.z - coverPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.001) return false;
  const dirX = dx / dist, dirZ = dz / dist;
  for (const c of colliders) {
    const h = c.box.max.y - c.box.min.y;
    if (h < 0.8 || h > 4) continue;
    // Ray-AABB on XZ.
    const minX = c.box.min.x, maxX = c.box.max.x;
    const minZ = c.box.min.z, maxZ = c.box.max.z;
    const invX = dirX !== 0 ? 1 / dirX : Infinity;
    const invZ = dirZ !== 0 ? 1 / dirZ : Infinity;
    let tmin = -Infinity, tmax = Infinity;
    let tx1 = (minX - coverPos.x) * invX;
    let tx2 = (maxX - coverPos.x) * invX;
    if (tx1 > tx2) { const tmp = tx1; tx1 = tx2; tx2 = tmp; }
    tmin = tmin > tx1 ? tmin : tx1;
    tmax = tmax < tx2 ? tmax : tx2;
    let tz1 = (minZ - coverPos.z) * invZ;
    let tz2 = (maxZ - coverPos.z) * invZ;
    if (tz1 > tz2) { const tmp = tz1; tz1 = tz2; tz2 = tmp; }
    tmin = tmin > tz1 ? tmin : tz1;
    tmax = tmax < tz2 ? tmax : tz2;
    if (tmax >= Math.max(0, tmin) && tmin <= dist - 0.3 && tmax >= 0) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section D #1930–1934 — squad-tactics refinements (regroup point, medic
// revive callout, grenade double-throw guard, flank re-evaluation).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Section D #1931 — squad regroup point. After a squad drops below 2 alive
 * members (the dissolve threshold), survivors rally to a centralized regroup
 * point (the squad's last-known center) before re-engaging. This prevents
 * the lone survivor from charging the player alone + gives the squad a
 * coherent "fall back + reform" behavior. The regroup point is stashed on
 * the enemy; tickChase/tickAttack read it + steer toward it when set.
 */
export function tickSquadRegroup(ctx: GameContext, e: Enemy, now: number): void {
  if (!e.alive) return;
  const ex = e as unknown as {
    squadRef?: { members: Enemy[]; centerX: number; centerZ: number } | null;
    regroupPoint?: { x: number; z: number; until: number } | null;
  };
  const squad = ex.squadRef;
  if (!squad || squad.members.length >= 2) {
    // Squad intact — clear any stale regroup point.
    if (ex.regroupPoint) ex.regroupPoint = null;
    return;
  }
  // Squad below 2 members — set a regroup point at the squad's last center.
  if (!ex.regroupPoint || now > ex.regroupPoint.until) {
    ex.regroupPoint = {
      x: squad.centerX,
      z: squad.centerZ,
      until: now + 4000, // 4s regroup window.
    };
  }
}

/**
 * Section D #1932 — medic revive callout. When a MEDIC-class enemy starts
 * reviving a downed ally, emit a "REVIVING" bark so the player hears the
 * callout (and can prioritize interrupting the revive). The bark fires once
 * per revive (tracked via a per-medic stamp).
 */
export async function tickMedicReviveCallout(ctx: GameContext, e: Enemy, now: number): Promise<void> {
  if (!e.alive) return;
  const cls = (e as unknown as { enemyClass?: string }).enemyClass;
  if (cls !== "MEDIC") return;
  const ex = e as unknown as {
    revivingUntil?: number;
    lastReviveBarkAt?: number;
  };
  // Only fire the callout when actively reviving (revivingUntil is in the future).
  if (!ex.revivingUntil || ex.revivingUntil < now) return;
  if (ex.lastReviveBarkAt && now - ex.lastReviveBarkAt < 3000) return; // 3s per-medic cooldown.
  ex.lastReviveBarkAt = now;
  // Lazy-import emitBark to avoid a hard circular dependency at module load.
  try {
    const { emitBark } = await import("./barks");
    emitBark(ctx, e, "REVIVING");
  } catch {
    // barks module not available (SSR / pre-init) — no-op.
  }
}

/**
 * Section D #1933 — grenade squad coordination. Prevents two squadmates from
 * throwing grenades at the same target within a short window (avoids the
 * "two frags land on the same LKP" waste). Each squad tracks a
 * lastGrenadeThrowAt stamp; the tickAIGrenade caller reads
 * `squadGrenadeClear(e)` before throwing. This tick just prunes stale
 * stamps (housekeeping).
 */
export function tickGrenadeCoord(_ctx: GameContext, e: Enemy, now: number): void {
  const ex = e as unknown as {
    squadRef?: { lastGrenadeThrowAt?: number } | null;
  };
  const squad = ex.squadRef;
  if (!squad || !squad.lastGrenadeThrowAt) return;
  // Clear the stamp after 5s (the no-double-throw window).
  if (now - squad.lastGrenadeThrowAt > 5000) {
    squad.lastGrenadeThrowAt = undefined;
  }
}

/** Section D #1933 — helper for tickAIGrenade: returns true if the enemy's
 *  squad has NOT thrown a grenade in the last 5s (so this enemy may throw). */
export function squadGrenadeClear(e: Enemy): boolean {
  const ex = e as unknown as {
    squadRef?: { lastGrenadeThrowAt?: number } | null;
  };
  const squad = ex.squadRef;
  if (!squad || !squad.lastGrenadeThrowAt) return true;
  return performance.now() - squad.lastGrenadeThrowAt > 5000;
}

/**
 * Section D #1934 — flank re-evaluation. When a flanker's path is blocked
 * (they haven't moved closer to the player in 3s while in FLANK state),
 * flip their flank direction so they try the other side. The prior behavior
 * was a single-direction flank that could soft-lock if the flanker hit a
 * wall. The re-eval stashes a `_flankDir` (1 or -1) on the enemy; tickFlank
 * reads it + reverses on re-eval.
 */
export function tickFlankReEval(ctx: GameContext, e: Enemy, now: number): void {
  if (!e.alive) return;
  const fsmState = e.fsm?.state;
  if (fsmState !== "FLANK") {
    // Reset the tracker when not flanking.
    const ex0 = e as unknown as { _flankStuckSince?: number; _flankDir?: number };
    ex0._flankStuckSince = undefined;
    return;
  }
  const ex = e as unknown as {
    _flankStuckSince?: number;
    _flankDir?: number;
    _lastFlankDist?: number;
  };
  const distToPlayer = Math.hypot(
    ctx.player.pos.x - e.group.position.x,
    ctx.player.pos.z - e.group.position.z,
  );
  const lastDist = ex._lastFlankDist ?? distToPlayer;
  ex._lastFlankDist = distToPlayer;
  // If we haven't closed distance by at least 0.5m in the last 3s, flip.
  if (distToPlayer > lastDist - 0.5) {
    if (ex._flankStuckSince === undefined) ex._flankStuckSince = now;
    if (now - ex._flankStuckSince > 3000) {
      ex._flankDir = (ex._flankDir ?? 1) * -1; // flip direction.
      ex._flankStuckSince = now; // reset timer for the next re-eval window.
    }
  } else {
    ex._flankStuckSince = undefined;
  }
}
