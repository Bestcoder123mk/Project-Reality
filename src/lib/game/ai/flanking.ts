/**
 * Section F — Coordinated flanking behavior.
 *
 * Addresses Section F prompts for "enemies coordinate to flank the player"
 * (the spot-and-flank, flank-left sweep, flank-right sweep, leapfrog
 * advance, bounding overwatch behaviors — at least 8 distinct prompts).
 *
 * The existing SquadCoordinator dispatches the FSM `flankOrder` event; this
 * module computes the actual flank trajectory + coordinates multiple
 * flankers (left + right pincer) + bounding overwatch (one member moves
 * while another suppresses).
 *
 * Design:
 *   - Pure-TS, SSR-safe. THREE is imported lazily.
 *   - A FlankPlan describes a single flanker's arc: start, pivot, end,
 *     side, and an ETA. The flanker steers along the arc via the existing
 *     enemy-tactics movement helpers.
 *   - The FlankCoordinator holds up to 2 active flank plans per squad
 *     (left + right pincer). When one flanker completes the arc, the
 *     coordinator may dispatch a new one if the squad is still in contact.
 *   - Bounding overwatch: the coordinator alternates which member moves
 *     vs. which holds + suppresses. The "bounder" sprints to a new piece
 *     of cover; the "overwatcher" lays down suppressive fire on the player.
 *
 * Integration:
 *   - SquadCoordinator calls `planFlank(...)` when it dispatches
 *     `flankOrder` on an enemy.
 *   - Enemy-tactics.ts reads the active FlankPlan for an enemy in the
 *     FLANK state + steers toward the next waypoint.
 *   - SquadCoordinator ticks `updateBoundingOverwatch(...)` once per
 *     second to alternate mover / suppressor roles.
 */

import * as THREE from "three";
import type { Enemy } from "../systems/types";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type FlankSide = "left" | "right";

export interface FlankWaypoint {
  x: number;
  z: number;
  /** True if this waypoint is a "pause + peek" point (the flanker stops,
   *  peeks around cover, fires a snapshot, then continues). */
  peek?: boolean;
}

export interface FlankPlan {
  /** The enemy executing this flank. */
  enemyId: string;
  /** Side (left or right). */
  side: FlankSide;
  /** Ordered list of waypoints (start → pivot → end). */
  waypoints: FlankWaypoint[];
  /** Current waypoint index (0-based). */
  currentWaypoint: number;
  /** performance.now() when the flank was planned. */
  startedAt: number;
  /** Estimated duration (ms). */
  etaMs: number;
  /** True once the flanker has reached the final waypoint. */
  completed: boolean;
  /** True if the flank was aborted (suppressed, lost LOS, died). */
  aborted: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-enemy flank state (stashed via cast on Enemy)
// ───────────────────────────────────────────────────────────────────────────

const FLANK_KEY = Symbol("flank_plan");

export function getFlankPlan(e: Enemy): FlankPlan | null {
  return (e as unknown as { [FLANK_KEY]?: FlankPlan | null })[FLANK_KEY] ?? null;
}

export function setFlankPlan(e: Enemy, plan: FlankPlan | null): void {
  (e as unknown as { [FLANK_KEY]?: FlankPlan | null })[FLANK_KEY] = plan;
}

// ───────────────────────────────────────────────────────────────────────────
// Plan a flank — compute the arc of waypoints from the enemy's current
// position to a firing position on the player's flank.
// ───────────────────────────────────────────────────────────────────────────

/** Tunables. */
const FLANK_RADIUS_MIN = 8;     // m — minimum arc radius.
const FLANK_RADIUS_MAX = 20;    // m — maximum arc radius.
const FLANK_DEPTH = 6;          // m — how far behind the player the arc ends.
const FLANK_PEEK_CHANCE = 0.4;  // chance each waypoint is a peek point.
const FLANK_ABORT_SUPPRESSION = 0.7; // abort if suppression ≥ this.

/** Compute a flank plan for the given enemy.
 *  `enemyPos` = enemy's current world position.
 *  `playerPos` = player's current world position.
 *  `side` = which side to flank.
 *  `rng` = random source (deterministic if injected).
 */
export function planFlank(
  enemy: Enemy,
  enemyPos: THREE.Vector3,
  playerPos: THREE.Vector3,
  side: FlankSide,
  rng: () => number = Math.random,
  now: number = performance.now(),
): FlankPlan {
  const radius = FLANK_RADIUS_MIN + rng() * (FLANK_RADIUS_MAX - FLANK_RADIUS_MIN);
  // Vector from player to enemy.
  const dx = enemyPos.x - playerPos.x;
  const dz = enemyPos.z - playerPos.z;
  const dist = Math.hypot(dx, dz) || 1;
  // Unit vector from player to enemy.
  const ux = dx / dist;
  const uz = dz / dist;
  // Perpendicular (rotate ±90°). side=left = -90°, side=right = +90°.
  const sign = side === "right" ? 1 : -1;
  const px = -uz * sign;
  const pz = ux * sign;
  // Pivot = the player's flank position (radius to the side).
  const pivotX = playerPos.x + px * radius;
  const pivotZ = playerPos.z + pz * radius;
  // End = a firing position behind the player (so the flanker ends up at
  // the player's flank, not their front).
  const endX = playerPos.x + ux * FLANK_DEPTH * -0.3 + px * radius * 0.7;
  const endZ = playerPos.z + uz * FLANK_DEPTH * -0.3 + pz * radius * 0.7;

  // Build the waypoint list: start (current position) → 1-2 intermediate
  // points along the arc → pivot → end. Mark some as peek points.
  const waypoints: FlankWaypoint[] = [];
  waypoints.push({ x: enemyPos.x, z: enemyPos.z });
  // Intermediate arc points.
  const arcPoints = 2;
  for (let i = 1; i <= arcPoints; i++) {
    const t = i / (arcPoints + 1);
    const ax = enemyPos.x + (pivotX - enemyPos.x) * t;
    const az = enemyPos.z + (pivotZ - enemyPos.z) * t;
    waypoints.push({ x: ax, z: az, peek: rng() < FLANK_PEEK_CHANCE });
  }
  waypoints.push({ x: pivotX, z: pivotZ, peek: true });
  waypoints.push({ x: endX, z: endZ });

  // ETA: rough estimate based on arc length + enemy speed.
  const arcLen = approxArcLength(waypoints);
  const speed = enemy.speed || 2.5;
  const etaMs = (arcLen / speed) * 1000;

  return {
    enemyId: enemy.id,
    side,
    waypoints,
    currentWaypoint: 0,
    startedAt: now,
    etaMs,
    completed: false,
    aborted: false,
  };
}

/** Sum of segment lengths between waypoints. */
function approxArcLength(waypoints: FlankWaypoint[]): number {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const dx = waypoints[i].x - waypoints[i - 1].x;
    const dz = waypoints[i].z - waypoints[i - 1].z;
    total += Math.hypot(dx, dz);
  }
  return total;
}

// ───────────────────────────────────────────────────────────────────────────
// Tick a flank plan — advance the waypoint index when the enemy reaches
// the current waypoint.
// ───────────────────────────────────────────────────────────────────────────

const WAYPOINT_REACHED_M = 1.2;

/** Tick a flank plan. Returns the next desired position (the current
 *  waypoint) or null if the flank is complete/aborted. Also handles the
 *  peek pause (the flanker holds for ~0.6s at a peek point). */
export function tickFlankPlan(
  plan: FlankPlan,
  enemy: Enemy,
  now: number = performance.now(),
): { desiredX: number; desiredZ: number; peeking: boolean } | null {
  if (plan.completed || plan.aborted) return null;
  // Abort if heavily suppressed.
  if ((enemy.suppression ?? 0) >= FLANK_ABORT_SUPPRESSION) {
    plan.aborted = true;
    return null;
  }
  // Advance through waypoints.
  while (plan.currentWaypoint < plan.waypoints.length) {
    const wp = plan.waypoints[plan.currentWaypoint];
    const dx = wp.x - enemy.group.position.x;
    const dz = wp.z - enemy.group.position.z;
    const d = Math.hypot(dx, dz);
    if (d > WAYPOINT_REACHED_M) {
      // Not there yet — return this waypoint as the desired position.
      // If it's a peek point, set the peeking flag (caller holds for ~0.6s).
      return { desiredX: wp.x, desiredZ: wp.z, peeking: !!wp.peek && d < 3 };
    }
    // Reached this waypoint — advance.
    plan.currentWaypoint++;
  }
  // All waypoints reached — flank complete.
  plan.completed = true;
  void now;
  return null;
}

/** Decide which side to flank based on the squad's existing flankers +
 *  the player's last movement direction (counter their dodge). */
export function pickFlankSide(
  existing: FlankPlan[],
  playerVel: THREE.Vector3,
  rng: () => number = Math.random,
): FlankSide {
  // If we already have a left flanker, send right (pincer), and vice versa.
  const hasLeft = existing.some((p) => p.side === "left" && !p.completed && !p.aborted);
  const hasRight = existing.some((p) => p.side === "right" && !p.completed && !p.aborted);
  if (hasLeft && !hasRight) return "right";
  if (hasRight && !hasLeft) return "left";
  // No active flanker — pick the side OPPOSITE the player's lateral
  // movement (so we go where they're not looking to dodge).
  if (Math.abs(playerVel.x) > 0.5) {
    return playerVel.x > 0 ? "left" : "right";
  }
  return rng() < 0.5 ? "left" : "right";
}

// ───────────────────────────────────────────────────────────────────────────
// Bounding overwatch — alternate mover / suppressor roles
// ───────────────────────────────────────────────────────────────────────────

export type OverwatchRole = "mover" | "suppressor" | "idle";

export interface OverwatchAssignment {
  enemyId: string;
  role: OverwatchRole;
  /** performance.now() when this assignment started. */
  startedAt: number;
  /** Duration (ms) before the next swap. */
  durationMs: number;
}

const OVERWATCH_KEY = Symbol("overwatch");

export function getOverwatchAssignment(e: Enemy): OverwatchAssignment | null {
  return (e as unknown as { [OVERWATCH_KEY]?: OverwatchAssignment | null })[OVERWATCH_KEY] ?? null;
}

export function setOverwatchAssignment(e: Enemy, a: OverwatchAssignment | null): void {
  (e as unknown as { [OVERWATCH_KEY]?: OverwatchAssignment | null })[OVERWATCH_KEY] = a;
}

/** Compute the next bounding-overwatch role assignment for a squad. The
 *  squad splits into two groups: movers (advance ~5m to new cover) and
 *  suppressors (hold + suppress). Roles swap on a fixed cadence.
 *
 *  `members` = alive squad members.
 *  `boundDurationMs` = how long each bound lasts (default 3000ms). */
export function updateBoundingOverwatch(
  members: Enemy[],
  boundDurationMs: number = 3000,
  now: number = performance.now(),
): void {
  if (members.length === 0) return;
  // Even-indexed members move on even bounds, odd-indexed on odd bounds.
  // Determine the current bound number (swaps every boundDurationMs).
  const boundIndex = Math.floor(now / boundDurationMs);
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (!m.alive) {
      setOverwatchAssignment(m, null);
      continue;
    }
    const isMover = (i + boundIndex) % 2 === 0;
    const role: OverwatchRole = isMover ? "mover" : "suppressor";
    const existing = getOverwatchAssignment(m);
    if (existing && existing.role === role) {
      // No change — keep the existing assignment.
      continue;
    }
    setOverwatchAssignment(m, {
      enemyId: m.id,
      role,
      startedAt: now,
      durationMs: boundDurationMs,
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Leapfrog advance — sequential bound forward (no role swap; instead each
// member takes turns being the mover while ALL others overwatch).
// ───────────────────────────────────────────────────────────────────────────

/** Compute which member should be the leapfrog mover this tick. Rotates
 *  through members in order, spending `boundDurationMs` per move. */
export function leapfrogMoverIndex(
  members: Enemy[],
  boundDurationMs: number = 2500,
  now: number = performance.now(),
): number {
  if (members.length === 0) return -1;
  const alive = members.filter((m) => m.alive).length;
  if (alive === 0) return -1;
  const boundIndex = Math.floor(now / boundDurationMs);
  return boundIndex % members.length;
}

// ───────────────────────────────────────────────────────────────────────────
// Coordinated pincer — plan both a left + right flank simultaneously
// ───────────────────────────────────────────────────────────────────────────

/** Plan a coordinated pincer: send one member left, one right, while a
 *  third (if available) stays as the suppressor. Returns the plans.
 *  Caller assigns them to the chosen members. */
export function planPincer(
  flankers: Array<{ enemy: Enemy; pos: THREE.Vector3 }>,
  playerPos: THREE.Vector3,
  rng: () => number = Math.random,
  now: number = performance.now(),
): FlankPlan[] {
  if (flankers.length === 0) return [];
  const plans: FlankPlan[] = [];
  // First flanker goes left, second right (if any).
  const sides: FlankSide[] = ["left", "right", "left", "right"];
  for (let i = 0; i < Math.min(flankers.length, 4); i++) {
    plans.push(planFlank(flankers[i].enemy, flankers[i].pos, playerPos, sides[i], rng, now));
  }
  return plans;
}

// ───────────────────────────────────────────────────────────────────────────
// Spot-and-flank — when a member spots the player, dispatch flank orders
// ───────────────────────────────────────────────────────────────────────────

/** Decide whether a spotter should call for a flank. Returns the chosen
 *  flanker's slot index (or -1 = no flank). Heuristic: if the spotter has
 *  been engaging the player for `engagedForMs` ms AND there's an available
 *  non-flanking squadmate AND the player hasn't moved much (good flank
 *  opportunity). */
export function shouldCallFlank(
  engagedForMs: number,
  availableFlankers: number,
  playerMovement: number, // m/s of player lateral movement.
  rng: () => number = Math.random,
): boolean {
  if (engagedForMs < 2000) return false;
  if (availableFlankers <= 0) return false;
  // Less likely to flank a fast-moving player (harder to circle).
  const speedFactor = Math.max(0, 1 - playerMovement / 6);
  const chance = 0.15 * speedFactor;
  return rng() < chance;
}
