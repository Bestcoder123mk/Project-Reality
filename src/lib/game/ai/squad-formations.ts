/**
 * Section F — Squad formation tactics.
 *
 * Addresses Section F prompts for "wedge, line, column, diamond formations".
 *
 * Each formation is a set of relative offsets (one per squad member) the
 * squad members steer toward when in formation-travel mode. Formations are
 * oriented along the squad's direction of travel (heading), with optional
 * facing rotations so each member covers a different sector.
 *
 * Design:
 *   - Pure-TS, SSR-safe. THREE is imported lazily in the position-math
 *     helper.
 *   - A SquadFormation holds an ordered list of offsets + per-slot role
 *     ("leader", "rear", "left_flank", "right_flank"). The squad
 *     coordinator assigns the i-th member to the i-th slot.
 *   - The formation's center + heading is recomputed each tick from the
 *     actual squad-member positions; the offset is added to the center to
 *     get each member's desired position.
 *   - Formation travel is gated by the squad coordinator: when the squad
 *     is in "advancing" mode, members steer toward their formation slot;
 *     when contact is made, the formation breaks (members seek cover
 *     individually).
 *
 * Integration:
 *   - The existing SquadCoordinator (squad-coordinator.ts) instantiates a
 *     formation per squad via `pickFormation(formationType, memberCount)`.
 *   - Each tick, the coordinator calls `computeFormationPositions(squad,
 *     formation, heading, center)` to get per-member desired positions.
 *   - Enemy-tactics.ts steers each member toward its desired position when
 *     the FSM is in CHASE / PATROL and the squad's mode is "advancing".
 */

import * as THREE from "three";
import type { Enemy } from "../systems/types";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type FormationType = "wedge" | "line" | "column" | "diamond" | "file" | "echelon_left" | "echelon_right";

export type FormationSlotRole =
  | "leader"
  | "rear"
  | "left_flank"
  | "right_flank"
  | "center"
  | "scout";

export interface FormationSlot {
  /** Forward offset (m) — along the heading vector. Positive = front. */
  forward: number;
  /** Lateral offset (m) — perpendicular to the heading. Positive = right. */
  lateral: number;
  /** Slot role — drives which enemy class is assigned (e.g. leader =
   *  COMMANDER, scout = SCOUT, rear = MG). */
  role: FormationSlotRole;
  /** Facing offset (radians) relative to the heading. 0 = face forward,
   *  π = face rear, π/2 = face right. */
  facingOffset: number;
}

export interface SquadFormation {
  type: FormationType;
  /** Ordered list of slots. Length matches the squad size. */
  slots: FormationSlot[];
  /** Inter-member spacing (m) — multiplies the slot offsets. */
  spacing: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Formation builders
// ───────────────────────────────────────────────────────────────────────────

/** Build a wedge (V) formation for `n` members. The leader is at the
 *  point; pairs trail behind in expanding V legs. Each member covers a
 *  forward-sector angle (left / right alternating). */
function buildWedge(n: number): SquadFormation {
  const slots: FormationSlot[] = [];
  slots.push({ forward: 0, lateral: 0, role: "leader", facingOffset: 0 });
  for (let i = 1; i < n; i++) {
    const pair = Math.ceil(i / 2);
    const side = i % 2 === 1 ? -1 : 1; // -1 = left, +1 = right
    slots.push({
      forward: -pair * 2,                  // behind the leader
      lateral: side * pair * 2,            // out to the side
      role: side < 0 ? "left_flank" : "right_flank",
      facingOffset: side * Math.PI / 6,    // angled outward 30°
    });
  }
  return { type: "wedge", slots, spacing: 4 };
}

/** Build a line abreast formation. Members line up side-by-side, all
 *  facing forward. Good for sweeping a wide area. */
function buildLine(n: number): SquadFormation {
  const slots: FormationSlot[] = [];
  const half = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const lateral = (i - half) * 2;
    slots.push({
      forward: 0,
      lateral,
      role: i === 0 ? "leader" : i === n - 1 ? "rear" : "center",
      facingOffset: 0,
    });
  }
  return { type: "line", slots, spacing: 3 };
}

/** Build a column (single file) formation. Members line up behind the
 *  leader. Good for moving through narrow corridors. */
function buildColumn(n: number): SquadFormation {
  const slots: FormationSlot[] = [];
  for (let i = 0; i < n; i++) {
    slots.push({
      forward: -i * 2,
      lateral: i % 2 === 0 ? -0.5 : 0.5,  // slight stagger to avoid blue-on-blue
      role: i === 0 ? "leader" : i === n - 1 ? "rear" : "center",
      facingOffset: i === 0 ? 0 : Math.PI, // rear faces backward, mid faces sideways-ish
    });
  }
  return { type: "column", slots, spacing: 2 };
}

/** Build a diamond formation — all-around defense. The leader is in the
 *  front, a rear guard behind, and two flankers on the sides. */
function buildDiamond(n: number): SquadFormation {
  const slots: FormationSlot[] = [];
  slots.push({ forward: 3, lateral: 0, role: "leader", facingOffset: 0 });
  if (n >= 2) slots.push({ forward: -3, lateral: 0, role: "rear", facingOffset: Math.PI });
  if (n >= 3) slots.push({ forward: 0, lateral: -3, role: "left_flank", facingOffset: -Math.PI / 2 });
  if (n >= 4) slots.push({ forward: 0, lateral: 3, role: "right_flank", facingOffset: Math.PI / 2 });
  // Additional members fill the inner ring.
  for (let i = 4; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    slots.push({
      forward: Math.cos(angle) * 1.5,
      lateral: Math.sin(angle) * 1.5,
      role: "center",
      facingOffset: angle,
    });
  }
  return { type: "diamond", slots, spacing: 3 };
}

/** File = single column with tighter spacing. */
function buildFile(n: number): SquadFormation {
  const f = buildColumn(n);
  f.type = "file";
  f.spacing = 1.5;
  return f;
}

/** Echelon left — diagonal line, left side forward. Good for protecting
 *  a flank on the right. */
function buildEchelonLeft(n: number): SquadFormation {
  const slots: FormationSlot[] = [];
  for (let i = 0; i < n; i++) {
    slots.push({
      forward: i * 1.5,
      lateral: -i * 2,
      role: i === 0 ? "leader" : "center",
      facingOffset: -Math.PI / 6,
    });
  }
  return { type: "echelon_left", slots, spacing: 3 };
}

function buildEchelonRight(n: number): SquadFormation {
  const slots: FormationSlot[] = [];
  for (let i = 0; i < n; i++) {
    slots.push({
      forward: i * 1.5,
      lateral: i * 2,
      role: i === 0 ? "leader" : "center",
      facingOffset: Math.PI / 6,
    });
  }
  return { type: "echelon_right", slots, spacing: 3 };
}

// ───────────────────────────────────────────────────────────────────────────
// Registry
// ───────────────────────────────────────────────────────────────────────────

const BUILDERS: Record<FormationType, (n: number) => SquadFormation> = {
  wedge: buildWedge,
  line: buildLine,
  column: buildColumn,
  diamond: buildDiamond,
  file: buildFile,
  echelon_left: buildEchelonLeft,
  echelon_right: buildEchelonRight,
};

/** Pick a formation for the given type + member count. */
export function pickFormation(type: FormationType, memberCount: number): SquadFormation {
  const n = Math.max(1, Math.min(8, memberCount)); // cap at 8 slots.
  return BUILDERS[type](n);
}

/** Pick a sensible default formation for a squad of size n. Heuristic:
 *   - 1-2 members → file
 *   - 3-4 members → wedge
 *   - 5-6 members → diamond
 *   - 7-8 members → line
 */
export function defaultFormationForSize(n: number): FormationType {
  if (n <= 2) return "file";
  if (n <= 4) return "wedge";
  if (n <= 6) return "diamond";
  return "line";
}

// ───────────────────────────────────────────────────────────────────────────
// Per-member desired-position computation
// ───────────────────────────────────────────────────────────────────────────

const _vForward = new THREE.Vector3();
const _vRight = new THREE.Vector3();
const _vDesired = new THREE.Vector3();

/** Compute the desired world position for the i-th slot of `formation`.
 *  `center` is the formation's anchor (typically the leader's position);
 *  `headingYaw` is the squad's facing yaw (radians, 0 = +Z). */
export function computeSlotPosition(
  formation: SquadFormation,
  slotIndex: number,
  center: THREE.Vector3,
  headingYaw: number,
  out?: THREE.Vector3,
): THREE.Vector3 {
  const slot = formation.slots[slotIndex];
  if (!slot) return out ?? center.clone();
  // Forward = (sin(yaw), 0, cos(yaw)) — matches the engine's yaw convention.
  _vForward.set(Math.sin(headingYaw), 0, Math.cos(headingYaw));
  // Right = forward rotated -90° around Y.
  _vRight.set(_vForward.z, 0, -_vForward.x);
  const s = formation.spacing;
  _vDesired
    .copy(center)
    .addScaledVector(_vForward, slot.forward * s)
    .addScaledVector(_vRight, slot.lateral * s);
  return (out ?? new THREE.Vector3()).copy(_vDesired);
}

/** Compute the desired position for every slot. Returns an array (length =
 *  formation.slots.length). The caller owns the array (no caching). */
export function computeFormationPositions(
  formation: SquadFormation,
  center: THREE.Vector3,
  headingYaw: number,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < formation.slots.length; i++) {
    out.push(computeSlotPosition(formation, i, center, headingYaw));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-enemy formation stash (cast on Enemy — same convention as enemy-tactics)
// ───────────────────────────────────────────────────────────────────────────

export interface FormationMemberState {
  /** Squad ID this enemy belongs to (-1 = unassigned). */
  squadId: number;
  /** Slot index within the formation. */
  slotIndex: number;
  /** Desired position this tick (updated by the coordinator). */
  desiredX: number;
  desiredZ: number;
  /** Desired facing yaw (radians). */
  desiredYaw: number;
  /** True while the enemy is in formation-travel mode. */
  inFormation: boolean;
}

const FORMATION_KEY = Symbol("formation");

/** Read (or lazily create) the per-enemy formation state. */
export function getFormationState(e: Enemy): FormationMemberState {
  const ex = e as unknown as { [FORMATION_KEY]?: FormationMemberState };
  if (!ex[FORMATION_KEY]) {
    ex[FORMATION_KEY] = {
      squadId: -1,
      slotIndex: 0,
      desiredX: 0,
      desiredZ: 0,
      desiredYaw: 0,
      inFormation: false,
    };
  }
  return ex[FORMATION_KEY]!;
}

/** Clear the formation state (e.g. when the squad breaks contact). */
export function clearFormationState(e: Enemy): void {
  const ex = e as unknown as { [FORMATION_KEY]?: FormationMemberState };
  if (ex[FORMATION_KEY]) {
    ex[FORMATION_KEY].inFormation = false;
    ex[FORMATION_KEY].squadId = -1;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Formation behavior helpers
// ───────────────────────────────────────────────────────────────────────────

/** Decide whether a squad should break formation. Returns true if the
 *  squad is in contact (any member within `contactRangeM` of an enemy +
 *  has LOS) or any member is below `breakHpPct` of max HP. */
export function shouldBreakFormation(
  members: Enemy[],
  contactRangeM: number = 20,
  breakHpPct: number = 0.3,
  playerPos?: THREE.Vector3,
): boolean {
  if (!playerPos) return false;
  for (const m of members) {
    if (!m.alive) continue;
    const dist = m.group.position.distanceTo(playerPos);
    if (dist < contactRangeM) return true;
    const hpPct = m.health / Math.max(1, m.maxHealth);
    if (hpPct < breakHpPct) return true;
  }
  return false;
}

/** Compute the squad's heading from the leader's velocity (or facing if
 *  stationary). Falls back to a heading toward the player if the leader
 *  isn't moving. */
export function computeSquadHeading(
  members: Enemy[],
  fallbackYaw: number = 0,
): number {
  if (members.length === 0) return fallbackYaw;
  const leader = members[0];
  if (!leader.alive) return fallbackYaw;
  const vx = leader.velocity.x;
  const vz = leader.velocity.z;
  if (Math.abs(vx) > 0.01 || Math.abs(vz) > 0.01) {
    return Math.atan2(vx, vz);
  }
  return leader.group.rotation.y || fallbackYaw;
}

/** Assign slot indices to squad members based on their class. The leader
 *  (COMMANDER) takes slot 0; SCOUT takes the scout slot; MG takes rear;
 *  everyone else fills by class priority. */
export function assignSlotsByClass(
  members: Enemy[],
  formation: SquadFormation,
): void {
  // Build a class→priority map.
  const priority: Record<string, number> = {
    COMMANDER: 0,
    SCOUT: 1,
    SHOTGUNNER: 2,
    CQB: 3,
    RIFLEMAN: 4,
    MG: 5,
    MEDIC: 6,
    SHIELD: 7,
    SNIPER: 8,
    ZOMBIE: 9,
  };
  const sorted = [...members].sort((a, b) => {
    const ca = (a as unknown as { enemyClass?: string }).enemyClass ?? "RIFLEMAN";
    const cb = (b as unknown as { enemyClass?: string }).enemyClass ?? "RIFLEMAN";
    return (priority[ca] ?? 5) - (priority[cb] ?? 5);
  });
  for (let i = 0; i < sorted.length; i++) {
    const st = getFormationState(sorted[i]);
    st.slotIndex = i % formation.slots.length;
    st.inFormation = true;
  }
}
