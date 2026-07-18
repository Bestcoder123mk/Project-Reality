/**
 * Section F — Breach and clear AI.
 *
 * Addresses Section F prompts for "AI room-clearing tactics" and
 * "CQB breaching". Implements a 4-stage room-clearing sequence:
 *
 *   1. STACK — squad members form up at the door (one on each side).
 *   2. BREACH — one member opens the door / blows it (flashbang optional).
 *   3. ENTER — members flow into the room in a cross pattern (first goes
 *      left, second goes right, third covers the center).
 *   4. CLEAR — call out "room clear" when no enemies remain.
 *
 * The system identifies "rooms" (rectangular regions enclosed by
 * colliders with a single doorway opening) and "doors" (gaps in the
 * collider perimeter). Each room is a BreachTarget.
 *
 * The SquadCoordinator selects a BreachTarget when the squad is in
 * BREACH mode (triggered by the player entering a building / the squad
 * losing LOS in a confined area). Each member is assigned a stage role
 * (stacker, breacher, enterer-1, enterer-2, cover).
 *
 * Pure-TS, SSR-safe. THREE is imported lazily.
 *
 * Integration:
 *   - SquadCoordinator calls `findBreachTargets(ctx)` once per match
 *     (cached).
 *   - When the squad enters BREACH mode, it picks the nearest target +
 *     calls `planBreach(target, members)` to assign roles.
 *   - Each tick, the coordinator calls `tickBreach(squad, target, plan,
 *     ctx, now)` which advances the stage + emits per-member orders.
 */

import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface BreachTarget {
  /** Unique ID. */
  id: number;
  /** Approximate room center. */
  centerX: number;
  centerZ: number;
  /** Approximate room bounds (min/max X/Z). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Doorway position (where the squad stacks + breaches). */
  doorX: number;
  doorZ: number;
  /** Facing yaw the squad should face when stacked at the door (radians). */
  doorFacingYaw: number;
  /** Stack positions (left of door, right of door). */
  stackLeft: { x: number; z: number };
  stackRight: { x: number; z: number };
  /** Entry waypoints — first member goes here, second there, etc. */
  entryPoints: Array<{ x: number; z: number; facingYaw: number }>;
  /** True if the room has been cleared (no living enemies in bounds). */
  cleared: boolean;
}

export type BreachRole = "stacker_left" | "stacker_right" | "breacher" | "enterer_1" | "enterer_2" | "cover" | "idle";

export type BreachStage = "stack" | "breach" | "enter" | "clear" | "done";

export interface BreachPlan {
  targetId: number;
  stage: BreachStage;
  /** Per-member role assignment (enemyId → role). */
  assignments: Map<string, BreachRole>;
  /** Stage-entered timestamps (for stage-duration gating). */
  stageStartedAt: number;
  /** True if a flashbang was thrown at the breach stage. */
  flashThrown: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Room detection — cheap AABB-cluster heuristic
// ───────────────────────────────────────────────────────────────────────────

/** Find breach targets (rooms) in the level. A "room" is a rectangular
 *  region enclosed by colliders with a single doorway gap. We use a
 *  cheap heuristic: scan the level for clusters of 4+ colliders forming
 *  a rough rectangle, then look for the largest gap in the perimeter
 *  (the door).
 *
 *  This is intentionally approximate — perfect room segmentation needs a
 *  navmesh, which is overkill. The heuristic catches the common case
 *  (4-walled rooms with a door). */
export function findBreachTargets(ctx: GameContext): BreachTarget[] {
  const targets: BreachTarget[] = [];
  // Group colliders by spatial proximity (8m buckets).
  const buckets = new Map<string, typeof ctx.colliders>();
  for (const c of ctx.colliders) {
    const center = c.box.getCenter(new THREE.Vector3());
    if (Math.abs(center.x) > 44 || Math.abs(center.z) > 44) continue;
    const key = `${Math.floor(center.x / 12)},${Math.floor(center.z / 12)}`;
    const arr = buckets.get(key) ?? [];
    arr.push(c);
    buckets.set(key, arr);
  }
  let id = 1;
  for (const [, group] of buckets) {
    if (group.length < 4) continue;
    // Compute the bounding box of the cluster.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of group) {
      minX = Math.min(minX, c.box.min.x);
      maxX = Math.max(maxX, c.box.max.x);
      minZ = Math.min(minZ, c.box.min.z);
      maxZ = Math.max(maxZ, c.box.max.z);
    }
    const w = maxX - minX;
    const h = maxZ - minZ;
    // Reject clusters that are too small or too large to be a "room".
    if (w < 4 || h < 4 || w > 20 || h > 20) continue;
    // Room center.
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // Door = the perimeter point with the largest gap between colliders.
    // Cheap heuristic: try each of the 4 sides; pick the side where the
    // gap between the two corner colliders is widest.
    const door = findDoorOnPerimeter(group, minX, maxX, minZ, maxZ);
    if (!door) continue;
    // Stack positions = 1.5m to the left + right of the door.
    const perpX = -Math.sin(door.facingYaw);
    const perpZ = Math.cos(door.facingYaw);
    const stackLeft = { x: door.x + perpX * 1.5, z: door.z + perpZ * 1.5 };
    const stackRight = { x: door.x - perpX * 1.5, z: door.z - perpZ * 1.5 };
    // Entry points — first entrant goes to the far-left corner, second to
    // the far-right, third covers the center.
    const entryPoints = [
      { x: cx - w / 4, z: cz - h / 4, facingYaw: door.facingYaw + Math.PI / 4 },
      { x: cx + w / 4, z: cz + h / 4, facingYaw: door.facingYaw - Math.PI / 4 },
      { x: cx, z: cz, facingYaw: door.facingYaw },
    ];
    targets.push({
      id: id++,
      centerX: cx, centerZ: cz,
      minX, maxX, minZ, maxZ,
      doorX: door.x, doorZ: door.z,
      doorFacingYaw: door.facingYaw,
      stackLeft, stackRight,
      entryPoints,
      cleared: false,
    });
  }
  return targets;
}

/** Find the largest gap in the perimeter of a collider cluster — that's
 *  the door. */
function findDoorOnPerimeter(
  group: THREE.Box3[] | { box: THREE.Box3 }[],
  minX: number, maxX: number, minZ: number, maxZ: number,
): { x: number; z: number; facingYaw: number } | null {
  // Normalize to {box} objects.
  const boxes = (group as Array<{ box?: THREE.Box3 } | THREE.Box3>).map((c) =>
    "box" in c ? (c as { box: THREE.Box3 }).box : c,
  ) as THREE.Box3[];
  // Try the south side (minZ edge).
  const southGaps = findGapsAlong(boxes, "z", minZ, minX, maxX);
  const northGaps = findGapsAlong(boxes, "z", maxZ, minX, maxX);
  const eastGaps = findGapsAlong(boxes, "x", maxX, minZ, maxZ);
  const westGaps = findGapsAlong(boxes, "x", minX, minZ, maxZ);
  const all = [
    ...southGaps.map((g) => ({ ...g, side: "south" as const, facingYaw: 0 })),
    ...northGaps.map((g) => ({ ...g, side: "north" as const, facingYaw: Math.PI })),
    ...eastGaps.map((g) => ({ ...g, side: "east" as const, facingYaw: -Math.PI / 2 })),
    ...westGaps.map((g) => ({ ...g, side: "west" as const, facingYaw: Math.PI / 2 })),
  ];
  if (all.length === 0) return null;
  // Pick the widest gap that's between 1m and 3m (door-sized).
  const doorSized = all.filter((g) => g.width >= 1 && g.width <= 3);
  const pick = (doorSized.length > 0 ? doorSized : all)[0];
  return { x: pick.x, z: pick.z, facingYaw: pick.facingYaw };
}

/** Find gaps (positions where no collider blocks the perimeter) along a
 *  given axis at a fixed coordinate. */
function findGapsAlong(
  boxes: THREE.Box3[],
  axis: "x" | "z",
  fixedVal: number,
  minOther: number,
  maxOther: number,
): Array<{ x: number; z: number; width: number; facingYaw: number }> {
  // Build a coverage array along the perpendicular axis.
  const len = maxOther - minOther;
  if (len <= 0) return [];
  const resolution = 0.5; // 0.5m sampling.
  const samples = Math.ceil(len / resolution);
  const covered = new Array<boolean>(samples).fill(false);
  for (const b of boxes) {
    // For axis='z', fixedVal is minZ/maxZ; we sweep along X.
    const boxMin = axis === "z" ? b.min.x : b.min.z;
    const boxMax = axis === "z" ? b.max.x : b.max.z;
    const boxFixedMin = axis === "z" ? b.min.z : b.min.x;
    const boxFixedMax = axis === "z" ? b.max.z : b.max.x;
    if (fixedVal < boxFixedMin - 0.5 || fixedVal > boxFixedMax + 0.5) continue;
    const startIdx = Math.max(0, Math.floor((boxMin - minOther) / resolution));
    const endIdx = Math.min(samples, Math.ceil((boxMax - minOther) / resolution));
    for (let i = startIdx; i < endIdx; i++) covered[i] = true;
  }
  // Find runs of uncovered samples.
  const gaps: Array<{ x: number; z: number; width: number; facingYaw: number }> = [];
  let i = 0;
  while (i < samples) {
    if (covered[i]) { i++; continue; }
    let j = i;
    while (j < samples && !covered[j]) j++;
    const startVal = minOther + i * resolution;
    const endVal = minOther + j * resolution;
    const midVal = (startVal + endVal) / 2;
    const width = endVal - startVal;
    gaps.push({
      x: axis === "z" ? midVal : fixedVal,
      z: axis === "z" ? fixedVal : midVal,
      width,
      facingYaw: 0, // filled by caller.
    });
    i = j;
  }
  return gaps;
}

// ───────────────────────────────────────────────────────────────────────────
// Breach planning + execution
// ───────────────────────────────────────────────────────────────────────────

const STACK_DURATION_MS = 1500;
const BREACH_DURATION_MS = 800;
const ENTER_DURATION_MS = 2500;

/** Plan a breach on the given target. Assigns roles to the squad members. */
export function planBreach(
  target: BreachTarget,
  members: Enemy[],
  now: number = performance.now(),
): BreachPlan {
  const assignments = new Map<string, BreachRole>();
  const alive = members.filter((m) => m.alive);
  for (let i = 0; i < alive.length; i++) {
    let role: BreachRole;
    if (i === 0) role = "stacker_left";
    else if (i === 1) role = "stacker_right";
    else if (i === 2) role = "breacher";
    else if (i === 3) role = "enterer_1";
    else if (i === 4) role = "enterer_2";
    else role = "cover";
    assignments.set(alive[i].id, role);
  }
  return {
    targetId: target.id,
    stage: "stack",
    assignments,
    stageStartedAt: now,
    flashThrown: false,
  };
}

/** Per-member order — what this member should do this tick. */
export interface BreachOrder {
  /** Desired world position. */
  x: number;
  z: number;
  /** Desired facing yaw. */
  yaw: number;
  /** "throw_flash" — throw a flashbang at the door (breacher only). */
  throwFlash?: boolean;
  /** "fire" — fire at the player if visible (enterers). */
  fire?: boolean;
  /** "advance" — keep moving toward the desired position. */
  advance?: boolean;
  /** Stage transition bark (for the barks library). */
  barkKind?: "BREACH_STACK" | "BREACH_BREACH" | "BREACH_CLEAR" | "BREACH_HOLD";
}

/** Tick the breach plan. Returns per-member orders + updates the stage. */
export function tickBreach(
  plan: BreachPlan,
  target: BreachTarget,
  members: Enemy[],
  ctx: GameContext,
  now: number = performance.now(),
): { orders: Map<string, BreachOrder>; stage: BreachStage } {
  const orders = new Map<string, BreachOrder>();
  const elapsed = now - plan.stageStartedAt;

  // ---------- Stage transitions ----------
  switch (plan.stage) {
    case "stack": {
      // Stack: all members move to their stack positions.
      for (const m of members) {
        if (!m.alive) continue;
        const role = plan.assignments.get(m.id) ?? "idle";
        let pos: { x: number; z: number };
        let yaw: number;
        if (role === "stacker_left") { pos = target.stackLeft; yaw = target.doorFacingYaw; }
        else if (role === "stacker_right") { pos = target.stackRight; yaw = target.doorFacingYaw; }
        else if (role === "breacher") { pos = target.stackLeft; yaw = target.doorFacingYaw; }
        else { pos = target.stackRight; yaw = target.doorFacingYaw; }
        orders.set(m.id, { x: pos.x, z: pos.z, yaw, advance: true, barkKind: "BREACH_STACK" });
      }
      // Advance to breach when all stackers are in position OR 1.5s elapses.
      if (elapsed > STACK_DURATION_MS) {
        plan.stage = "breach";
        plan.stageStartedAt = now;
      }
      break;
    }
    case "breach": {
      // Breach: the breacher throws a flashbang (if available) + opens the door.
      for (const m of members) {
        if (!m.alive) continue;
        const role = plan.assignments.get(m.id) ?? "idle";
        const order: BreachOrder = {
          x: target.stackLeft.x,
          z: target.stackLeft.z,
          yaw: target.doorFacingYaw,
          advance: false,
          barkKind: "BREACH_BREACH",
        };
        if (role === "breacher" && !plan.flashThrown) {
          order.throwFlash = true;
          plan.flashThrown = true;
        }
        orders.set(m.id, order);
      }
      if (elapsed > BREACH_DURATION_MS) {
        plan.stage = "enter";
        plan.stageStartedAt = now;
      }
      break;
    }
    case "enter": {
      // Enter: members flow into the room in a cross pattern.
      let entererIdx = 0;
      for (const m of members) {
        if (!m.alive) continue;
        const role = plan.assignments.get(m.id) ?? "idle";
        let pos: { x: number; z: number };
        let yaw: number;
        if (role === "enterer_1" && target.entryPoints[0]) {
          pos = target.entryPoints[0]; yaw = target.entryPoints[0].facingYaw;
        } else if (role === "enterer_2" && target.entryPoints[1]) {
          pos = target.entryPoints[1]; yaw = target.entryPoints[1].facingYaw;
        } else if (role === "breacher" && target.entryPoints[2]) {
          pos = target.entryPoints[2]; yaw = target.entryPoints[2].facingYaw;
        } else {
          // Cover members hold at the door.
          pos = target.stackLeft; yaw = target.doorFacingYaw;
        }
        orders.set(m.id, {
          x: pos.x, z: pos.z, yaw,
          advance: true, fire: true,
          barkKind: "BREACH_BREACH",
        });
        entererIdx++;
      }
      if (elapsed > ENTER_DURATION_MS) {
        plan.stage = "clear";
        plan.stageStartedAt = now;
      }
      break;
    }
    case "clear": {
      // Clear: check if any enemies remain in the room bounds.
      const enemiesInRoom = ctx.enemies.filter((e) =>
        e.alive &&
        e.group.position.x >= target.minX && e.group.position.x <= target.maxX &&
        e.group.position.z >= target.minZ && e.group.position.z <= target.maxZ,
      );
      target.cleared = enemiesInRoom.length === 0;
      for (const m of members) {
        if (!m.alive) continue;
        orders.set(m.id, {
          x: target.centerX,
          z: target.centerZ,
          yaw: target.doorFacingYaw,
          fire: !target.cleared,
          advance: !target.cleared,
          barkKind: target.cleared ? "BREACH_CLEAR" : "BREACH_HOLD",
        });
      }
      if (target.cleared) {
        plan.stage = "done";
      }
      break;
    }
    case "done": {
      // Done — members return to normal behavior.
      for (const m of members) {
        if (!m.alive) continue;
        orders.set(m.id, {
          x: m.group.position.x,
          z: m.group.position.z,
          yaw: m.group.rotation.y,
        });
      }
      break;
    }
  }
  void ctx;
  return { orders, stage: plan.stage };
}

// ───────────────────────────────────────────────────────────────────────────
// Pick the nearest un-cleared breach target to a position.
// ───────────────────────────────────────────────────────────────────────────

export function pickNearestBreachTarget(
  targets: BreachTarget[],
  x: number,
  z: number,
): BreachTarget | null {
  let best: BreachTarget | null = null;
  let bestD = Infinity;
  for (const t of targets) {
    if (t.cleared) continue;
    const d = Math.hypot(t.centerX - x, t.centerZ - z);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}
