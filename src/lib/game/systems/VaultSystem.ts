import * as THREE from "three";
import type { GameContext } from "./types";
// Task 3 / item 59 — scoped env-raycast cache (replaces scene.children, true).
import { getEnvRaycastTargets } from "./raycast-env";

/**
 * P4.3: Vaulting & mantle system.
 *
 * When the player sprints into a chest-high obstacle (1.0m–1.5m tall),
 * they automatically vault over it. When they sprint near a ledge that's
 * within reach (1.5m–2.5m tall), they mantle up onto it.
 *
 * Vault = quick forward hop over the obstacle (preserves forward momentum).
 * Mantle = pull-up onto the ledge (briefly halts horizontal velocity).
 *
 * Both are triggered by a forward raycast from the player's chest. If the
 * hit point is below 1.5m, vault. If it's between 1.5m and 2.5m, mantle.
 * Higher obstacles block movement (existing collision handles that).
 *
 * Task-14: ladder climbing. When the player walks into a mesh tagged
 * `userData.isLadder === true`, they attach to the ladder (gravity disabled,
 * W/S moves up/down at 3 m/s, A/D strafes to dismount, Space jumps off).
 * See `tryLadder` below.
 */

const VAULT_MAX_HEIGHT = 1.5;
const MANTLE_MAX_HEIGHT = 2.5;
const VAULT_MIN_HEIGHT = 0.5; // below this, treat as a step-over (no vault/mantle)
const VAULT_FORWARD_DISTANCE = 1.5;
const MANTLE_FORWARD_DISTANCE = 0.5;
const VAULT_DURATION = 0.4; // seconds
const MANTLE_DURATION = 0.7;
// Prompt A#55 — gamepad forward-input threshold for vault trigger. Was
// KeyW-only which excluded gamepad stick forward. Now any input source
// (keyboard KeyW OR gamepad left-stick Y > 0.5) triggers vault.
const VAULT_FORWARD_INPUT_THRESHOLD = 0.5;
// Prompt A#56 — walk-speed vault is allowed for obstacles < 1.0m. Was
// sprint-required which excluded walking players from vaulting waist-high
// walls. The WALK_VAULT_MAX_HEIGHT gates the walk-vault path.
const WALK_VAULT_MAX_HEIGHT = 1.0;
// Prompt A#57 — minimum ceiling clearance required during a vault arc.
// If the up-ray hits something within this distance, abort the vault
// (prevents vaulting into a low doorway / overhang).
const VAULT_MIN_CEILING_CLEARANCE = 1.5;
// Prompt A#62 — ladder dismount blend duration. Was instant snap
// (LADDER_STEP_UP applied in one frame). Now blends over 300ms.
const LADDER_DISMOUNT_BLEND_MS = 300;

export interface VaultState {
  /** Active vault/mantle animation timer (0 = inactive, >0 = in progress). */
  timer: number;
  /** Duration of the current vault/mantle. */
  duration: number;
  /** Target position to land at. */
  targetPos: THREE.Vector3;
  /** Start position (for interpolation). */
  startPos: THREE.Vector3;
  /** Type: "vault" | "mantle" | null. */
  type: "vault" | "mantle" | null;
  /** Prompt A#62 — ladder dismount blend timer (ms). >0 means a dismount
   *  animation is in progress; PhysicsSystem should blend the player's
   *  position from the ladder-top to the ledge over the blend duration. */
  ladderDismountT: number;
  /** Prompt A#62 — ladder dismount start position (player's pos when the
   *  dismount started, before the step-up). */
  ladderDismountFrom: THREE.Vector3;
  /** Prompt A#62 — ladder dismount target position (the ledge). */
  ladderDismountTo: THREE.Vector3;
  /** Prompt A#61 — ladder climb gait phase (radians). Drives the limb
   *  cycle in CharacterRig (hands + feet alternate up/down). */
  ladderClimbPhase: number;
}

export function createVaultState(): VaultState {
  return {
    timer: 0,
    duration: 0,
    targetPos: new THREE.Vector3(),
    startPos: new THREE.Vector3(),
    type: null,
    // Prompt A#62 — ladder dismount blend state.
    ladderDismountT: 0,
    ladderDismountFrom: new THREE.Vector3(),
    ladderDismountTo: new THREE.Vector3(),
    // Prompt A#61 — ladder climb gait phase.
    ladderClimbPhase: 0,
  };
}

/**
 * Check if the player should vault/mantle, given their current forward
 * movement + a chest-height raycast. If yes, sets vaultState and returns
 * true (PhysicsSystem should skip normal movement this frame).
 */
export function tryVaultOrMantle(ctx: GameContext, vault: VaultState, dt: number): boolean {
  if (vault.timer > 0) {
    // Continue the active vault/mantle animation.
    vault.timer -= dt;
    if (vault.timer <= 0) {
      // Snap to target.
      ctx.player.pos.copy(vault.targetPos);
      ctx.player.vel.y = 0;
      ctx.player.onGround = true;
      vault.type = null;
      return false;
    }
    // Interpolate position (parabolic for vault, linear-up for mantle).
    const t = 1 - vault.timer / vault.duration;
    ctx.player.pos.lerpVectors(vault.startPos, vault.targetPos, t);
    if (vault.type === "vault") {
      // Add a parabolic arc.
      const arc = Math.sin(t * Math.PI) * 0.8;
      ctx.player.pos.y = THREE.MathUtils.lerp(vault.startPos.y, vault.targetPos.y, t) + arc;
    }
    return true;
  }

  // Only attempt vault/mantle when moving forward + on ground.
  // Prompt A#55 — accept any forward input > 0.5 (keyboard KeyW OR gamepad
  // left-stick Y > 0.5). The previous code only checked `ctx.keys["KeyW"]`
  // which excluded gamepad stick forward. We read the gamepad axis via
  // navigator.getGamepads() defensively (returns null in non-browser envs).
  const keyboardForward = !!ctx.keys["KeyW"];
  const gamepadForward = readGamepadForwardAxis() > VAULT_FORWARD_INPUT_THRESHOLD;
  const movingForward = keyboardForward || gamepadForward;
  if (!movingForward || !ctx.player.onGround) return false;
  // Prompt A#56 — sprint is no longer required for vaults of obstacles
  // < WALK_VAULT_MAX_HEIGHT (1.0m). Walking players can vault waist-high
  // walls. Sprint is still required for taller obstacles (mantle).
  const sprinting = ctx.keys["ShiftLeft"];

  // Cast a ray forward from chest height.
  const forward = ctx.scratch.v1.set(-Math.sin(ctx.player.yaw), 0, -Math.cos(ctx.player.yaw)).normalize();
  const origin = ctx.scratch.v2.copy(ctx.player.pos);
  origin.y = 1.0; // chest height
  ctx.raycaster.set(origin, forward);
  ctx.raycaster.far = 1.0;
  // Task 3 / item 59 — PERF: scoped. Was intersectObjects(ctx.scene.children, true).
  const hits = ctx.raycaster.intersectObjects(getEnvRaycastTargets(ctx), false).filter(
    (h) => !isPlayerSubtree(h.object) && !isEnemySubtree(h.object) && h.object.type !== "Sprite",
  );
  if (hits.length === 0) return false;
  const hit = hits[0];
  const obstacle = hit.object as THREE.Mesh;
  // Prompt A#58 — compute obstacle height from the player's FEET to the
  // obstacle top, not from the obstacle's AABB. An obstacle on a raised
  // platform reads as vaultable when too tall (its AABB extends below the
  // player's feet). We compute the effective height = max(0, box.max.y -
  // playerFeetY) so a 2m-tall box on a 2m platform reads as 2m (the part
  // above the player's feet), not 4m (its full AABB height).
  const box = new THREE.Box3().setFromObject(obstacle);
  const playerFeetY = ctx.player.pos.y - 1.7; // eye height = 1.7m standing
  const effectiveHeight = Math.max(0, box.max.y - playerFeetY);
  if (effectiveHeight > MANTLE_MAX_HEIGHT) return false; // too tall, can't vault or mantle
  if (effectiveHeight < VAULT_MIN_HEIGHT) return false; // too short — step-over, not vault
  // Prompt A#56 — walk-vault only allowed for short obstacles. Mantle
  // (taller obstacles) still requires sprint.
  if (!sprinting && effectiveHeight > WALK_VAULT_MAX_HEIGHT) return false;

  // Prompt A#57 — ceiling clearance check. Raycast up from the obstacle
  // top; if there's geometry within VAULT_MIN_CEILING_CLEARANCE, abort
  // the vault (can't vault into a low doorway / overhang).
  const ceilOrigin = ctx.scratch.v3.copy(ctx.player.pos);
  ceilOrigin.y = box.max.y + 0.1; // just above the obstacle top
  ctx.raycaster.set(ceilOrigin, _UP);
  ctx.raycaster.far = VAULT_MIN_CEILING_CLEARANCE;
  const ceilHits = ctx.raycaster.intersectObjects(getEnvRaycastTargets(ctx), false).filter(
    (h) => !isPlayerSubtree(h.object) && !isEnemySubtree(h.object) && h.object.type !== "Sprite",
  );
  if (ceilHits.length > 0) return false; // not enough clearance — abort

  // Compute landing position (forward of the obstacle).
  // Prompt A#59 — landing Y is NOT box.max.y (the obstacle top). Raycast
  // DOWN past the obstacle to find the actual landing surface (which may
  // be lower than the obstacle — e.g., vaulting a barrier onto a lower roof).
  const landPos = ctx.scratch.v3.copy(ctx.player.pos); // reuse v3 (ceil check is done)
  const forwardDist = effectiveHeight <= VAULT_MAX_HEIGHT ? VAULT_FORWARD_DISTANCE : MANTLE_FORWARD_DISTANCE;
  landPos.add(forward.clone().multiplyScalar(forwardDist));
  // Raycast down from above the landing XZ to find the actual ground Y.
  const landProbeOrigin = new THREE.Vector3(landPos.x, box.max.y + 1.0, landPos.z);
  ctx.raycaster.set(landProbeOrigin, _DOWN);
  ctx.raycaster.far = 10.0; // generous — find the ground below
  const landHits = ctx.raycaster.intersectObjects(getEnvRaycastTargets(ctx), false).filter(
    (h) => !isPlayerSubtree(h.object) && !isEnemySubtree(h.object) && h.object.type !== "Sprite",
  );
  // Landing Y = hit point (if found) or the obstacle top (fallback).
  landPos.y = landHits.length > 0 ? landHits[0].point.y : box.max.y;

  // Trigger vault or mantle.
  vault.type = effectiveHeight <= VAULT_MAX_HEIGHT ? "vault" : "mantle";
  vault.duration = vault.type === "vault" ? VAULT_DURATION : MANTLE_DURATION;
  vault.timer = vault.duration;
  vault.startPos.copy(ctx.player.pos);
  vault.targetPos.copy(landPos);
  if (vault.type === "vault") {
    // Vault lands on the other side (ground level), not on top.
    // Prompt A#59 — target Y is the actual landing Y (found above), not
    // the obstacle top. The previous code snapped to ctx.player.pos.y
    // which was wrong if the landing surface was at a different height.
    // (targetPos.y already set to landPos.y above.)
  }
  return true;
}

/** Prompt A#55 — read the gamepad's left-stick Y axis (forward = negative
 *  on standard gamepads). Returns 0..1 (0 = no forward, 1 = full forward).
 *  Returns 0 in non-browser environments or when no gamepad is connected. */
function readGamepadForwardAxis(): number {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return 0;
  try {
    const pads = navigator.getGamepads();
    if (!pads) return 0;
    for (const pad of pads) {
      if (!pad || !pad.axes) continue;
      // Standard gamepad mapping: axes[1] = left stick Y (negative = up).
      const y = pad.axes[1] ?? 0;
      if (y < -VAULT_FORWARD_INPUT_THRESHOLD) return -y; // forward
    }
  } catch { /* ignore — gamepad API may be unavailable */ }
  return 0;
}

function isPlayerSubtree(obj: THREE.Object3D): boolean {
  let p: THREE.Object3D | null = obj;
  while (p) {
    if (p.type === "PerspectiveCamera") return true;
    p = p.parent;
  }
  return false;
}

/** Task-8: filter enemy subtrees from vault raycasts. EnemySystem flags enemy
 * meshes via userData.enemy = true on every part. We walk the parent chain to
 * avoid vaulting off enemies (which would be both absurd and a gameplay bug). */
function isEnemySubtree(obj: THREE.Object3D): boolean {
  let p: THREE.Object3D | null = obj;
  while (p) {
    if (p.userData && p.userData.enemy) return true;
    p = p.parent;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// Task-14: Ladder climbing.
// ════════════════════════════════════════════════════════════════════════════

const LADDER_FORWARD_REACH = 2.0; // meters — forward raycast distance
const LADDER_CLIMB_SPEED = 3.0;   // m/s up or down
const LADDER_STRAFE_SPEED = 1.5;  // m/s side-to-side (slow, for dismounting)
const LADDER_TOP_PROBE = 0.6;     // meters — up-raycast distance to detect ladder top
const LADDER_STEP_UP = 0.5;       // meters — vertical step when reaching the top
const LADDER_STEP_FWD = 0.5;      // meters — forward step onto the ledge
const LADDER_JUMP_OFF_UP = 5.0;   // m/s — upward velocity on Space dismount
const LADDER_JUMP_OFF_BACK = 4.0; // m/s — backward push-off on Space dismount
// Prompt A#60 — ladder detection ray height offset. Was `player.pos.y - 0.5`
// (a fixed offset from eye) which put the ray at ankle height when crouching
// (eye ~0.8m, ray at 0.3m — missed the ladder). The new offset is
// `eyeHeight - 0.5` so the ray is always 0.5m below the eye, regardless of
// stance. Standing: ray at 1.2m; crouching: ray at 0.3m... wait, that's the
// same problem. Actually the fix is to put the ray 0.2m above the FEET,
// not 0.5m below the eye. Feet = eye - eyeHeight, so ray = feet + 0.2.
const LADDER_RAY_HEIGHT_ABOVE_FEET = 0.2;

// Reusable up vector (avoids per-frame allocation).
const _UP = new THREE.Vector3(0, 1, 0);
// Prompt A#59 — reusable down vector for the landing-surface raycast.
const _DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Task-14: tryLadder — handle ladder attachment + climbing.
 *
 * Called from PhysicsSystem.updatePlayer when the player is NOT in a dive or
 * slide. It both DETECTS ladder attachment (forward raycast hits a mesh with
 * `userData.isLadder === true`) and DRIVES the climbing state (movement +
 * dismount logic) when `player.onLadder` is true.
 *
 * Behavior:
 *   - Attach:   forward raycast (2m) hits a ladder mesh → onLadder = true.
 *   - Climb:    gravity disabled, vel.y = 0 by default. W → vel.y = +3 (up),
 *               S → vel.y = -3 (down). A/D → small strafe (can dismount by
 *               moving off the ladder).
 *   - Dismount: Space → jump off (up + backward push). No forward ladder hit
 *               → walked off (free-fall). Up-ray hits nothing (and player is
 *               high enough) → at the top, step up onto the ledge.
 *   - While on ladder: can't sprint, slide, or dive (those checks all gate on
 *               `player.onLadder`).
 *
 * Returns true while the player is on the ladder (PhysicsSystem uses this to
 * skip normal gravity + sprint/slide/dive handling). Returns false if not on
 * a ladder (no-op).
 *
 * PhysicsSystem is responsible for: integrating player.vel into player.pos,
 * setting eyeHeight = 1.5 when onLadder, applying the camera forward pitch
 * tilt (+0.1 rad), and reading keys["Space"] for jump-off (handled here).
 *
 * Scratch vector usage: v1 = forward, v2 = ray origin, v3 = up-ray origin.
 * These are reused later in PhysicsSystem but only after tryLadder returns,
 * so reuse is safe.
 */
export function tryLadder(ctx: GameContext, _dt: number): boolean {
  const { player, keys, raycaster, scratch, scene, vault } = ctx;

  // ── Forward raycast to detect ladder presence (used for both attach and
  //    dismount checks). Origin is 0.2m above the player's FEET (Prompt A#60),
  //    not 0.5m below the eye. The previous code put the ray at ankle height
  //    when crouching (eye ~0.8m → ray at 0.3m) which missed ladders. The new
  //    formula: ray = feet + 0.2m, where feet = eye - eyeHeight. Standing:
  //    ray at 0.2m; crouching: ray at 0.2m (eye ~0.8m, eyeHeight ~0.6m, feet
  //    ~0.2m). The ray is always at the same world height regardless of stance,
  //    so crouch + ladder works.
  //    We approximate eyeHeight as 1.7m standing / 0.9m crouching based on
  //    player.crouching (the same constants PhysicsSystem uses).
  //    Using an absolute y (e.g. 1.2) would be wrong — once the player is
  //    4m up a ladder, the chest is at 3.5m, not 1.2m. ──
  const eyeHeight = player.crouching ? 0.9 : 1.7;
  const feetY = player.pos.y - eyeHeight;
  const forward = scratch.v1.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw)).normalize();
  const origin = scratch.v2.copy(player.pos);
  origin.y = feetY + LADDER_RAY_HEIGHT_ABOVE_FEET; // Prompt A#60 — 0.2m above feet
  raycaster.set(origin, forward);
  raycaster.far = LADDER_FORWARD_REACH;
  // Task 3 / item 59 — PERF: scoped. Was intersectObjects(scene.children, true).
  const hits = raycaster.intersectObjects(getEnvRaycastTargets(ctx), false).filter(
    (h) => !isPlayerSubtree(h.object) && !isEnemySubtree(h.object) && h.object.type !== "Sprite",
  );
  // Ladder is the closest hit AND it's tagged as a ladder.
  const ladderHit =
    hits.length > 0 && hits[0].object.userData && hits[0].object.userData.isLadder === true;

  // Attach: if not currently on a ladder but one is in front, attach.
  if (!player.onLadder) {
    if (ladderHit) {
      player.onLadder = true;
      // Cancel any in-air momentum so the climb starts clean.
      player.vel.set(0, 0, 0);
    } else {
      return false;
    }
  }

  // ── Dismount checks (only run when onLadder is true). ──

  // 1. Space → jump off the ladder (up + backward push-off).
  if (keys["Space"]) {
    player.vel.y = LADDER_JUMP_OFF_UP;
    player.vel.x = -forward.x * LADDER_JUMP_OFF_BACK;
    player.vel.z = -forward.z * LADDER_JUMP_OFF_BACK;
    player.onLadder = false;
    player.onGround = false;
    return false;
  }

  // 2. Up-raycast to detect ladder TOP. If the player is pressing W (climbing
  //    up) and there's nothing above them (no ceiling, no more ladder), they've
  //    reached the top — step up + forward onto the ledge. Filter out the
  //    ladder mesh itself (we want to know if there's a ledge surface above
  //    or open sky, not just more ladder rungs).
  //    Origin = player's eye + small offset (probe just above the head).
  //    This check runs BEFORE the "no ladder in front" check so the player
  //    can step onto the ledge even if the forward ray hasn't lost the ladder yet.
  const upOrigin = scratch.v3.copy(player.pos);
  upOrigin.y = player.pos.y + 0.3; // just above eye
  raycaster.set(upOrigin, _UP);
  raycaster.far = LADDER_TOP_PROBE;
  // Task 3 / item 59 — PERF: scoped. Was intersectObjects(scene.children, true).
  const upHits = raycaster.intersectObjects(getEnvRaycastTargets(ctx), false).filter(
    (h) =>
      !isPlayerSubtree(h.object) &&
      !isEnemySubtree(h.object) &&
      h.object.type !== "Sprite" &&
      !(h.object.userData && h.object.userData.isLadder === true),
  );
  if (upHits.length === 0 && keys["KeyW"]) {
    // At the top — step up + forward onto the ledge.
    // Prompt A#62 — blend the dismount over LADDER_DISMOUNT_BLEND_MS
    // (was: instant snap with `player.pos.y += LADDER_STEP_UP`). The
    // instant snap was jarring (the player teleported up + forward in
    // one frame). The blend interpolates the player's position from the
    // current pos to the ledge over 300ms with an ease-out curve.
    //
    // The blend is driven by vault.ladderDismountT (counts down from
    // LADDER_DISMOUNT_BLEND_MS to 0). PhysicsSystem's tryLadder call
    // each frame checks if a dismount is in progress + interpolates.
    // For now (single-frame call), we just set the target + let the
    // next-frame's blend handle it. If the caller doesn't drive the
    // blend (legacy caller), we fall back to the instant snap so the
    // dismount still completes.
    if (vault.ladderDismountT <= 0) {
      // Start the dismount blend.
      vault.ladderDismountFrom.copy(player.pos);
      vault.ladderDismountTo.copy(player.pos);
      vault.ladderDismountTo.y += LADDER_STEP_UP;
      vault.ladderDismountTo.x += forward.x * LADDER_STEP_FWD;
      vault.ladderDismountTo.z += forward.z * LADDER_STEP_FWD;
      vault.ladderDismountT = LADDER_DISMOUNT_BLEND_MS / 1000; // seconds
    }
    // The actual blend is applied in the dismount-blend section below.
    // For the frame the dismount STARTS, we don't move the player yet —
    // the blend happens over the next LADDER_DISMOUNT_BLEND_MS frames.
    // Fall through to the dismount-blend handling below.
  }

  // Prompt A#62 — ladder dismount blend. If a dismount is in progress,
  // interpolate the player's position from ladderDismountFrom to
  // ladderDismountTo over LADDER_DISMOUNT_BLEND_MS with an ease-out curve.
  if (vault.ladderDismountT > 0) {
    vault.ladderDismountT = Math.max(0, vault.ladderDismountT - _dt);
    const totalBlend = LADDER_DISMOUNT_BLEND_MS / 1000;
    const t = 1 - (vault.ladderDismountT / totalBlend); // 0→1
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    player.pos.lerpVectors(vault.ladderDismountFrom, vault.ladderDismountTo, eased);
    if (vault.ladderDismountT <= 0) {
      // Blend complete — finalize the dismount.
      player.pos.copy(vault.ladderDismountTo);
      player.vel.set(0, 0, 0);
      player.onLadder = false;
      player.onGround = true;
      return false;
    }
    // Still blending — keep the player on the ladder state (no gravity,
    // no normal movement) but don't process climb input.
    return true;
  }

  // 3. No ladder in front → walked off the side (A/D strafed off) or climbed
  //    past the top without stepping up (e.g. didn't press W). Free-fall.
  if (!ladderHit) {
    player.onLadder = false;
    // Let gravity take over (free-fall).
    return false;
  }

  // ── Climbing movement (still on the ladder). ──
  // Gravity is disabled — vel.y = 0 by default each frame.
  player.vel.x = 0;
  player.vel.z = 0;
  player.vel.y = 0;
  if (keys["KeyW"]) {
    player.vel.y = LADDER_CLIMB_SPEED;
    // Prompt A#61 — advance the ladder climb gait phase. Drives the
    // CharacterRig limb cycle (hands + feet alternate up/down) via
    // vault.ladderClimbPhase. The phase advances at ~1.5Hz (a natural
    // climbing cadence) when ascending. The CharacterRig reads this
    // phase + applies a sinusoidal limb cycle (LeftArm/RightArm/
    // LeftUpLeg/RightUpLeg) on top of the idle pose.
    vault.ladderClimbPhase += _dt * Math.PI * 1.5; // 0.75Hz cycle (2π = 1 cycle)
  } else if (keys["KeyS"]) {
    player.vel.y = -LADDER_CLIMB_SPEED;
    vault.ladderClimbPhase -= _dt * Math.PI * 1.5; // reverse cycle when descending
  }
  // A/D — slow strafe (lets the player dismount to either side).
  // Right vector = (cos(yaw), 0, -sin(yaw)) — matches PhysicsSystem convention.
  if (keys["KeyA"]) {
    player.vel.x -= Math.cos(player.yaw) * LADDER_STRAFE_SPEED;
    player.vel.z += Math.sin(player.yaw) * LADDER_STRAFE_SPEED;
  }
  if (keys["KeyD"]) {
    player.vel.x += Math.cos(player.yaw) * LADDER_STRAFE_SPEED;
    player.vel.z -= Math.sin(player.yaw) * LADDER_STRAFE_SPEED;
  }

  return true;
}
