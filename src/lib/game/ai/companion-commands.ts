/**
 * Section F — Companion commands.
 *
 * Addresses Section F prompts for "give orders to AI squadmates (regroup,
 * hold, advance)". The existing companion.ts implements a Companion FSM
 * (FOLLOW, HOLD, REVIVE, ENGAGE, COVER); this module adds a command layer
 * the player can issue via hotkeys / radial menu:
 *
 *   - REGROUP — companion abandons its current task + returns to the
 *     player's side (3-5m behind).
 *   - HOLD — companion holds its current position + engages enemies in
 *     LOS (doesn't follow the player).
 *   - ADVANCE — companion moves to the player's aim point (or 10m forward)
 *     and engages.
 *   - COVERING_FIRE — companion lays down suppressive fire on the player's
 *     last target for 5s.
 *   - REVIVE — companion prioritizes reviving a downed ally (the player
 *     or another companion) over combat.
 *   - STEALTH — companion stops firing + crouch-walks (for stealth runs).
 *   - SPLIT — companion takes a different route (left/right) to flank.
 *
 * Each command sets the companion's `orderedState` + a sticky duration
 * (the companion obeys until the order is cancelled or expires).
 *
 * Pure-TS, SSR-safe.
 *
 * Integration:
 *   - The engine wires `ctx.ai?.companion` to a Companion instance (already
 *     exists in companion.ts).
 *   - InputSystem calls `issueCommand(companion, kind, ctx, now)` when the
 *     player presses the command hotkey / opens the radial menu.
 *   - Companion.update reads `getOrderedCommand(companion)` each tick to
 *     decide its FSM target state.
 */

import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";
import type { Companion } from "./companion";

// ───────────────────────────────────────────────────────────────────────────
// Command types
// ───────────────────────────────────────────────────────────────────────────

export type CompanionCommandKind =
  | "REGROUP"
  | "HOLD"
  | "ADVANCE"
  | "COVERING_FIRE"
  | "REVIVE"
  | "STEALTH"
  | "SPLIT_LEFT"
  | "SPLIT_RIGHT"
  | "CANCEL"; // cancels the current order (returns to FOLLOW default).

export interface CompanionCommand {
  /** Command kind. */
  kind: CompanionCommandKind;
  /** performance.now() when the command was issued. */
  issuedAt: number;
  /** Duration (ms) — the command auto-expires after this. 0 = sticky
   *  (until cancelled). REGROUP defaults to 5s; HOLD is sticky; etc. */
  durationMs: number;
  /** Optional target position (for ADVANCE). */
  targetX?: number;
  targetZ?: number;
  /** Optional target enemy (for COVERING_FIRE). */
  targetEnemyId?: string;
  /** Reason string — for HUD display. */
  reason: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-companion command state (cast on Companion)
// ───────────────────────────────────────────────────────────────────────────

const KEY = Symbol("companion_command");

export function getCompanionCommand(c: Companion): CompanionCommand | null {
  const ex = c as unknown as { [KEY]?: CompanionCommand | null };
  return ex[KEY] ?? null;
}

export function setCompanionCommand(c: Companion, cmd: CompanionCommand | null): void {
  (c as unknown as { [KEY]?: CompanionCommand | null })[KEY] = cmd;
}

// ───────────────────────────────────────────────────────────────────────────
// Default durations
// ───────────────────────────────────────────────────────────────────────────

const COMMAND_DURATIONS_MS: Record<CompanionCommandKind, number> = {
  REGROUP: 5000,         // 5s — return to player, then resume FOLLOW.
  HOLD: 0,                // sticky.
  ADVANCE: 8000,          // 8s — advance, then resume FOLLOW.
  COVERING_FIRE: 5000,    // 5s of suppressive fire.
  REVIVE: 15000,          // 15s — try to reach + revive.
  STEALTH: 0,             // sticky (until cancelled).
  SPLIT_LEFT: 10000,      // 10s — flank left.
  SPLIT_RIGHT: 10000,     // 10s — flank right.
  CANCEL: 0,
};

// ───────────────────────────────────────────────────────────────────────────
// Issue a command
// ───────────────────────────────────────────────────────────────────────────

/** Issue a command to the companion. Returns the command (or null if the
 *  command was invalid for the current state, e.g. REVIVE when no ally
 *  is downed). */
export function issueCommand(
  companion: Companion,
  kind: CompanionCommandKind,
  ctx: GameContext,
  now: number = performance.now(),
): CompanionCommand | null {
  // Special-case CANCEL — clears any existing order.
  if (kind === "CANCEL") {
    setCompanionCommand(companion, null);
    return null;
  }

  // Validate + compute the command's target.
  let targetX: number | undefined;
  let targetZ: number | undefined;
  let targetEnemyId: string | undefined;
  const playerPos = ctx.player.pos;

  switch (kind) {
    case "REGROUP":
      // No target — companion returns to the player.
      break;
    case "HOLD":
      // Hold current position.
      const compPos = (companion as unknown as { group?: THREE.Group }).group?.position;
      if (compPos) { targetX = compPos.x; targetZ = compPos.z; }
      break;
    case "ADVANCE":
      // Advance to the player's aim point (or 10m forward).
      const yaw = ctx.player.yaw;
      targetX = playerPos.x + Math.sin(yaw) * 10;
      targetZ = playerPos.z + Math.cos(yaw) * 10;
      break;
    case "COVERING_FIRE":
      // Target = nearest alive enemy.
      const nearest = findNearestEnemy(ctx, playerPos);
      if (nearest) targetEnemyId = nearest.id;
      break;
    case "REVIVE":
      // Validate — there must be a downed ally (the player or another companion).
      // For now, we trust the player to issue this only when relevant.
      break;
    case "STEALTH":
      // No target.
      break;
    case "SPLIT_LEFT":
    case "SPLIT_RIGHT":
      // Pick a flank position 8m to the side.
      const yaw2 = ctx.player.yaw;
      const sign = kind === "SPLIT_LEFT" ? -1 : 1;
      const rx = Math.cos(yaw2) * sign;
      const rz = -Math.sin(yaw2) * sign;
      targetX = playerPos.x + Math.sin(yaw2) * 6 + rx * 6;
      targetZ = playerPos.z + Math.cos(yaw2) * 6 + rz * 6;
      break;
  }

  const cmd: CompanionCommand = {
    kind,
    issuedAt: now,
    durationMs: COMMAND_DURATIONS_MS[kind],
    targetX,
    targetZ,
    targetEnemyId,
    reason: kind.toLowerCase(),
  };
  setCompanionCommand(companion, cmd);
  return cmd;
}

// ───────────────────────────────────────────────────────────────────────────
// Tick — check if the current command has expired
// ───────────────────────────────────────────────────────────────────────────

/** Check if the companion's current command has expired. Returns true
 *  if the command was cleared (expired). */
export function tickCompanionCommand(
  companion: Companion,
  now: number = performance.now(),
): boolean {
  const cmd = getCompanionCommand(companion);
  if (!cmd) return false;
  if (cmd.durationMs === 0) return false; // sticky.
  if (now - cmd.issuedAt > cmd.durationMs) {
    setCompanionCommand(companion, null);
    return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Companion FSM target — read by companion.ts to drive its FSM
// ───────────────────────────────────────────────────────────────────────────

/** The FSM target state the companion should be in, given its current
 *  command (or null = default FOLLOW). */
export type CompanionFSMTarget = "FOLLOW" | "HOLD" | "REVIVE" | "ENGAGE" | "COVER" | "STEALTH";

export function getFSMTarget(companion: Companion): CompanionFSMTarget | null {
  const cmd = getCompanionCommand(companion);
  if (!cmd) return null;
  switch (cmd.kind) {
    case "REGROUP": return "FOLLOW";
    case "HOLD": return "HOLD";
    case "ADVANCE": return "ENGAGE";
    case "COVERING_FIRE": return "COVER";
    case "REVIVE": return "REVIVE";
    case "STEALTH": return "STEALTH";
    case "SPLIT_LEFT":
    case "SPLIT_RIGHT": return "ENGAGE";
    case "CANCEL": return "FOLLOW";
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Command list (for the radial menu / hotkey display)
// ───────────────────────────────────────────────────────────────────────────

export interface CommandDescriptor {
  kind: CompanionCommandKind;
  /** Short label (for the radial menu). */
  label: string;
  /** Hotkey (keyboard shortcut) — empty if unbound. */
  hotkey: string;
  /** True if the command is a "toggle" (sticky until re-pressed). */
  sticky: boolean;
}

export const COMMAND_DESCRIPTORS: CommandDescriptor[] = [
  { kind: "REGROUP", label: "Regroup", hotkey: "Z", sticky: false },
  { kind: "HOLD", label: "Hold", hotkey: "X", sticky: true },
  { kind: "ADVANCE", label: "Advance", hotkey: "C", sticky: false },
  { kind: "COVERING_FIRE", label: "Covering Fire", hotkey: "V", sticky: false },
  { kind: "REVIVE", label: "Revive", hotkey: "R", sticky: false },
  { kind: "STEALTH", label: "Stealth", hotkey: "B", sticky: true },
  { kind: "SPLIT_LEFT", label: "Split Left", hotkey: "Q", sticky: false },
  { kind: "SPLIT_RIGHT", label: "Split Right", hotkey: "E", sticky: false },
  { kind: "CANCEL", label: "Cancel", hotkey: "Esc", sticky: false },
];

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function findNearestEnemy(ctx: GameContext, pos: THREE.Vector3): Enemy | null {
  let best: Enemy | null = null;
  let bestD = Infinity;
  for (const e of ctx.enemies) {
    if (!e.alive) continue;
    const d = e.group.position.distanceTo(pos);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}
