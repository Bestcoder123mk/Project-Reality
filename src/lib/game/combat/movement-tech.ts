/**
 * SEC5-COMBAT — Prompt 43: Movement-tech layer.
 *
 * Audits the existing movement mechanics (slide, mantle, lean, wall-lean) and
 * documents the interaction matrix with stamina + recoil. The audit reads
 * VaultSystem.ts + PhysicsSystem.ts + StaminaSystem.ts and produces a static
 * table of every mechanic the player can perform + its stamina/recoil
 * interaction. If a standard mechanic is missing, this file flags it + the
 * orchestrator can wire a stub.
 *
 * Audit findings (read at import time, exposed as MOVEMENT_TECH_FLAGS):
 *
 *   ✅ Slide      — exists. PhysicsSystem.updateSlide() drives 0.6s slide
 *                   burst, 1.5× sprint speed decaying to 0.4×. Triggered by
 *                   crouch-while-sprinting. Camera lowers -0.15 + pitch +0.1.
 *                   Stamina cost: NONE (sprint-gated; slide doesn't drain).
 *                   Recoil interaction: full recoil applies during slide —
 *                   firing mid-slide is intentionally penalised (you're moving
 *                   fast + low; you can't also be accurate).
 *
 *   ✅ Mantle     — exists. VaultSystem.tryVaultOrMantle() handles 1.5-2.5m
 *                   ledge pull-up. 0.7s mantle duration, camera pitch tilt.
 *                   Stamina cost: NONE (vault/mantle is free, gated only by
 *                   sprint state for trigger — sprint requires stamina).
 *                   Recoil interaction: vault cancels the active recoil
 *                   recovery timer (vault sets vault.timer > 0 →
 *                   PhysicsSystem.updatePlayer skips normal accel path →
 *                   weapon sway continues but the recovery easeOutCubic is
 *                   paused, not reset).
 *
 *   ✅ Vault      — exists (sibling of mantle). 0.5-1.5m obstacles, 0.4s
 *                   parabolic hop. Same stamina/recoil rules as mantle.
 *
 *   ✅ Lean       — exists. PhysicsSystem lines 500-520: hold-based lean via
 *                   BracketLeft / BracketRight. -1 = left, +1 = right, damped
 *                   at rate 10 (or 6 in ADS). ADS lean is halved (0.5 max)
 *                   + the lean lateral offset is capped at 0.25m in ADS vs
 *                   0.5m in hip-fire (prevents wall-clip exploit).
 *                   Stamina cost: NONE.
 *                   Recoil interaction: NONE (lean doesn't change recoil).
 *                   ADS bonus: spread is reduced during ADS (existing
 *                   WeaponSystem logic); lean doesn't multiply that.
 *
 *   ❌ Wall-lean  — MISSING. The existing lean is a free-stand lean (the
 *                   player can lean in open air). Wall-lean is a distinct
 *                   mechanic: the player must have a wall within 0.5m on the
 *                   lean side, the camera should press against the wall, and
 *                   firing from wall-lean should have reduced sway (the wall
 *                   braces the weapon). This is a real gap.
 *
 *                   We add a stub `tryWallLean()` in this file. It's a pure
 *                   function that takes the player position + lean direction
 *                   + a raycaster + the scene, and returns whether wall-lean
 *                   is available. The orchestrator wires this into
 *                   PhysicsSystem.updatePlayer (one-liner) to gate the lean
 *                   lateral offset (reduce to 0.15m if wall-lean is active,
 *                   apply the sway-reduction buff to weapon sway).
 *
 *   ✅ Slide-jump — implicit. Jump (Space) during slide preserves momentum
 *                   (PhysicsSystem line 275: `player.slideTime = 0;`).
 *                   Documented as a movement-tech combo.
 *
 *   ✅ Dive       — exists. PhysicsSystem.updateDive() — dolphin dive
 *                   triggered by crouch-while-sprinting-airborne. 0.6s air
 *                   phase + 0.3s prone recover. Camera punch on land.
 *
 *   ✅ Ladder     — exists. VaultSystem.tryLadder() — forward raycast hits
 *                   userData.isLadder mesh → gravity disabled, W/S climbs at
 *                   3 m/s. Dismount via Space (jump off) or stepping onto
 *                   the ledge.
 *
 * Movement tech is well-covered. Only wall-lean is missing — the stub below
 * provides the gating function so the orchestrator can wire it without
 * touching PhysicsSystem.ts (which is shared).
 */

import * as THREE from "three";
import { getEnvRaycastTargets, isRaycastExcluded } from "../systems/raycast-env";
import type { GameContext } from "../systems/types";

// ─────────────────────────────────────────────────────────────────────────────
// Movement-tech matrix
// ─────────────────────────────────────────────────────────────────────────────

export type MovementMechanic =
  | "slide"
  | "vault"
  | "mantle"
  | "lean"
  | "wall_lean"
  | "slide_jump"
  | "dive"
  | "ladder"
  | "sprint"
  | "crouch"
  | "jump";

export interface MovementTechFlag {
  mechanic: MovementMechanic;
  /** Whether the mechanic is currently implemented in the engine. */
  implemented: boolean;
  /** Trigger (input + state precondition). */
  trigger: string;
  /** Stamina cost (0 = none, or "gated by sprint" if it requires sprint). */
  staminaCost: number | "gated_by_sprint";
  /** Recoil interaction — what firing-during-this-mechanic does to recoil. */
  recoilInteraction: "none" | "full" | "reduced" | "paused" | "cancelled";
  /** Where the mechanic is implemented (file:method, or "stub" if missing). */
  location: string;
  /** Designer note. */
  note: string;
}

/**
 * The movement-tech matrix. Read by the gunsmith + movement-tutorial UI + the
 * orchestrator's "is everything wired" check.
 */
export const MOVEMENT_TECH_FLAGS: Record<MovementMechanic, MovementTechFlag> = {
  slide: {
    mechanic: "slide",
    implemented: true,
    trigger: "Crouch (Ctrl/C) while sprinting forward on ground",
    staminaCost: "gated_by_sprint",
    recoilInteraction: "full",
    location: "PhysicsSystem.updateSlide",
    note: "0.6s slide burst, 1.5× → 0.4× sprint speed. Camera lowers -0.15 + pitch +0.1. Firing mid-slide is intentionally penalised.",
  },
  vault: {
    mechanic: "vault",
    implemented: true,
    trigger: "Sprint forward into 0.5-1.5m obstacle (chest raycast)",
    staminaCost: "gated_by_sprint",
    recoilInteraction: "paused",
    location: "VaultSystem.tryVaultOrMantle",
    note: "0.4s parabolic hop over chest-high cover. Preserves forward momentum. Recoil recovery timer paused during vault.",
  },
  mantle: {
    mechanic: "mantle",
    implemented: true,
    trigger: "Sprint forward into 1.5-2.5m ledge (chest raycast)",
    staminaCost: "gated_by_sprint",
    recoilInteraction: "paused",
    location: "VaultSystem.tryVaultOrMantle",
    note: "0.7s pull-up onto ledge. Briefly halts horizontal velocity. Camera pitch tilt during animation.",
  },
  lean: {
    mechanic: "lean",
    implemented: true,
    trigger: "Hold [ (left) or ] (right)",
    staminaCost: 0,
    recoilInteraction: "none",
    location: "PhysicsSystem.updatePlayer (lines 500-520)",
    note: "Free-stand lean. ±1 lean value damped at rate 10. ADS halves lean (0.5 max) + caps lateral offset at 0.25m to prevent wall-clip.",
  },
  wall_lean: {
    mechanic: "wall_lean",
    implemented: true,
    trigger: "Hold [ or ] with a wall within 0.5m on the lean side",
    staminaCost: 0,
    recoilInteraction: "reduced",
    location: "combat/movement-tech.ts:tryWallLean + PhysicsSystem.updatePlayer",
    note: "Prompt A#111 — wired. PhysicsSystem.updatePlayer calls tryWallLean(ctx,...) after computing player.lean; wallLeanBuffs() reduces the lateral offset to 30% + applies a 40% sway-reduction buff when a wall is detected on the lean side.",
  },
  slide_jump: {
    mechanic: "slide_jump",
    implemented: true,
    trigger: "Press Space during slide",
    staminaCost: "gated_by_sprint",
    recoilInteraction: "full",
    location: "PhysicsSystem.updatePlayer (slide-jump preserves momentum)",
    note: "Jump cancels slide but preserves forward momentum. Stamina cost = jumpCost (25). Used for slide-hop rotations.",
  },
  dive: {
    mechanic: "dive",
    implemented: true,
    trigger: "Crouch while sprinting + airborne",
    staminaCost: "gated_by_sprint",
    recoilInteraction: "cancelled",
    location: "PhysicsSystem.updateDive",
    note: "Dolphin dive — 0.6s air launch (12 m/s forward) + 0.3s prone recover. Screen shake on land. Firing cancelled during prone phase.",
  },
  ladder: {
    mechanic: "ladder",
    implemented: true,
    trigger: "Walk into mesh tagged userData.isLadder",
    staminaCost: 0,
    recoilInteraction: "full",
    location: "VaultSystem.tryLadder",
    note: "Gravity disabled, W/S climbs at 3 m/s. A/D strafes at 1.5 m/s to dismount. Space jumps off (5 m/s up + 4 m/s back).",
  },
  sprint: {
    mechanic: "sprint",
    implemented: true,
    trigger: "Hold Shift + W (not crouching, not ADS)",
    staminaCost: 20, // sprintDrainRate per second
    recoilInteraction: "full",
    location: "StaminaSystem.update + PhysicsSystem.updatePlayer",
    note: "8.2 m/s base. Drains stamina at 20/s — 5s window. Exhausted at 0 stamina, regen paused for 2.5s.",
  },
  crouch: {
    mechanic: "crouch",
    implemented: true,
    trigger: "Hold Ctrl/C (toggle in settings)",
    staminaCost: 0,
    recoilInteraction: "reduced",
    location: "PhysicsSystem.updatePlayer",
    note: "Reduces movement speed + camera height. Spread + recoil reduced during crouch (existing WeaponSystem logic).",
  },
  jump: {
    mechanic: "jump",
    implemented: true,
    trigger: "Press Space on ground",
    staminaCost: 25, // jumpCost
    recoilInteraction: "full",
    location: "StaminaSystem.tryJump + PhysicsSystem.updatePlayer",
    note: "Costs 25 stamina. Crouch-while-sprinting-airborne triggers dive instead.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Wall-lean stub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stub for wall-lean detection. Pure function — the orchestrator wires this
 * into PhysicsSystem.updatePlayer (after the existing lean computation) to
 * gate the lean lateral offset + apply a sway-reduction buff when the player
 * is leaning against a wall.
 *
 * Prompt A#110 — was `raycaster.intersectObjects(scene.children, true)` which
 * recursed the whole scene graph (camera + enemies + sprites + every weapon
 * mesh). Now uses the shared `getEnvRaycastTargets(ctx)` cache.
 *
 * @param ctx        GameContext (owns the env raycast target cache).
 * @param playerPos  Player world position.
 * @param yaw        Player yaw (radians).
 * @param leanDir    -1 for left, +1 for right (matches player.lean sign).
 * @param raycaster  THREE.Raycaster (caller owns + reuses).
 * @param wallLeanReach Max distance to detect a wall (default 0.5m).
 * @returns          True if there's a wall on the lean side within reach.
 */
export function tryWallLean(
  ctx: GameContext,
  playerPos: THREE.Vector3,
  yaw: number,
  leanDir: number,
  raycaster: THREE.Raycaster,
  wallLeanReach = 0.5,
): boolean {
  if (leanDir === 0) return false;
  // Right vector = (cos(yaw), 0, -sin(yaw)) — matches PhysicsSystem convention.
  // Lean left = -right, lean right = +right.
  const sideDir = new THREE.Vector3(Math.cos(yaw) * leanDir, 0, -Math.sin(yaw) * leanDir);
  const origin = playerPos.clone();
  origin.y = 1.0; // chest height
  raycaster.set(origin, sideDir);
  raycaster.far = wallLeanReach;
  // Prompt A#110 / A#3 — PERF: scoped. Was intersectObjects(scene.children, true).
  // The env cache already excludes camera/enemy/sprite/HUD/viewmodel, so the
  // inline filter is just defensive (in case the cache lags a scene mutation).
  const hits = raycaster.intersectObjects(getEnvRaycastTargets(ctx), false);
  for (const h of hits) {
    if (!isRaycastExcluded(h.object, ctx)) return true;
  }
  return false;
}

/**
 * Compute the effective lean offset multiplier given whether wall-lean is
 * active. Wall-lean reduces the lateral offset (the camera presses against the
 * wall rather than poking through it) AND applies a sway-reduction buff (the
 * wall braces the weapon).
 *
 * Returns:
 *   - offsetMult: 1.0 (free lean) or 0.3 (wall-lean — 30% of the free offset).
 *   - swayMult:   1.0 (free lean) or 0.6 (wall-lean — 40% sway reduction).
 */
export function wallLeanBuffs(isWallLeaning: boolean): { offsetMult: number; swayMult: number } {
  if (isWallLeaning) return { offsetMult: 0.3, swayMult: 0.6 };
  return { offsetMult: 1.0, swayMult: 1.0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the list of implemented movement mechanics (for the movement tutorial UI).
 */
export function getImplementedMechanics(): MovementMechanic[] {
  return (Object.values(MOVEMENT_TECH_FLAGS) as MovementTechFlag[])
    .filter((f) => f.implemented)
    .map((f) => f.mechanic);
}

/**
 * Get the list of missing movement mechanics (for the "to-do" view).
 */
export function getMissingMechanics(): MovementMechanic[] {
  return (Object.values(MOVEMENT_TECH_FLAGS) as MovementTechFlag[])
    .filter((f) => !f.implemented)
    .map((f) => f.mechanic);
}

/**
 * Get the full movement-tech matrix (for the gunsmith / dashboard UI).
 */
export function getMovementTechMatrix(): MovementTechFlag[] {
  return Object.values(MOVEMENT_TECH_FLAGS) as MovementTechFlag[];
}
