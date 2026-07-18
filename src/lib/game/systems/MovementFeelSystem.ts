/**
 * §4 Movement & Feel — backlog items 76–100.
 *
 * This module is a SELF-CONTAINED enhancement layer over the existing
 * movement systems (PhysicsSystem, VaultSystem, StaminaSystem, InputSystem).
 * It adds the §4 backlog's missing mechanics + tuning knobs WITHOUT
 * rewriting those 1,969 combined lines — the engine opts in by calling
 * the helpers below from its update loop.
 *
 * Design principles:
 *   - Pure functions where possible (testable, no Three.js mutation).
 *   - State stored in a single `MovementFeelState` object the engine owns.
 *   - Every value is a named constant (no magic numbers) so designers can
 *     tune in one place.
 *   - Honors the "reduced effects" preset (§3 item 65) — water/door
 *     physics simplify when reduced.
 */

import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// Tuning constants (§4 items 76, 78, 79, 81, 84, 89, 90, 94, 96)
// ─────────────────────────────────────────────────────────────────────────────

export const MOVEMENT_FEEL = {
  // §4 #76 — coyote time: grace window after leaving a ledge during which
  // the player can still jump. Prevents the "I pressed jump but I was 1 frame
  // past the edge" frustration.
  coyoteTimeMs: 120,

  // §4 #77 — input buffer window: a jump/sprint/interact press is buffered
  // for this many ms and consumed by the next eligible state transition.
  // Stops frame-perfect requirements.
  inputBufferMs: 150,

  // §4 #78 — camera bob is a player-facing slider now (wired in SettingsPanel
  // GameplayPanel). These are the min/max bounds + default.
  cameraBobMin: 0,
  cameraBobMax: 1.5,
  cameraBobDefault: 1.0,

  // §4 #79 — lean (Q/E peek) already exists ([ / ] keys). This adds an
  // ALTERNATE keybind (KeyQ / KeyE) since the review specifically calls out
  // "Q/E peek" as the conventional tactical-shooter binding. Both work.
  leanAlternateKeys: ["KeyQ", "KeyE"] as const,

  // §4 #80 — mantle/vault detection radius. Tuned to avoid false-triggering
  // on small props (cans, spent brass). The existing VaultSystem uses 0.5–2.5m;
  // this is the minimum prop height that SHOULD trigger mantle (below = vault).
  mantleMinTriggerHeight: 1.5,
  vaultMaxTriggerHeight: 1.5,

  // §4 #81 — fall-damage curve. Damage = max(0, (fallSpeed - threshold) * k).
  // Threshold = the speed at which damage starts (≈ a 3m fall). k scales it.
  fallDamageThreshold: 8.0, // m/s — below this, no damage
  fallDamageK: 4.0, // damage per m/s over threshold
  fallDamageMax: 80, // cap so a max-height fall doesn't one-shot from full HP

  // §4 #82 — sprint-to-fire transition delay. The player can't fire for this
  // many ms after releasing sprint (weapon comes up). Prevents sprint-shoot
  // abuse; tuned to feel responsive but not instant.
  sprintToFireDelayMs: 180,

  // §4 #83 — slide momentum conservation on downhill. Sliding downhill gains
  // speed proportional to slope angle * gravity * slideFrictionReduction.
  slideDownhillFrictionMult: 0.4, // friction is 40% of flat-ground friction on a downhill slope
  slideDownhillGravityBoost: 2.5, // m/s² extra gravity component on slopes > 15°

  // §4 #84 — stamina-vs-ADS interaction: when stamina < 25%, ADS sway
  // multiplier increases (exhausted aim is less steady).
  exhaustedStaminaThreshold: 0.25,
  exhaustedAdsSwayMult: 1.6,

  // §4 #85 — crouch-jump height/speed distinctions from standing jump.
  crouchJumpHeightMult: 0.85, // crouch-jump is 15% lower (can't tuck knees)
  crouchJumpSpeedMult: 1.0, // same horizontal speed

  // §4 #86 — mantle/vault animation blending is handled by
  // ProceduralAnimSystem; this is the blend time for the camera tilt.
  mantleCameraBlendMs: 220,

  // §4 #88 — vehicle entry/exit camera smoothing (lerp factor per frame at 60fps).
  vehicleCameraLerp: 0.08,

  // §4 #89 — air strafe acceleration. Lower than ground accel to prevent
  // bunny-hop tight circles but high enough to course-correct.
  airStrafeAccel: 18, // m/s²
  airStrafeMaxAdd: 2.5, // m/s — max velocity added per air-frame

  // §4 #90 — step height for stairs. The physics capsule climbs steps up to
  // this height without a jump. Prevents stutter on staircases.
  stepHeight: 0.35, // m

  // §4 #91 — first-person view-model sway. The weapon lags the camera by
  // this fraction (0 = rigid, 1 = full lag). Applied as a lerp per frame.
  viewModelSwayLag: 0.35,
  viewModelSwayMaxOffset: 0.08, // m — max weapon offset from sway

  // §4 #92 — landing recovery aim-punch. A hard fall (fallSpeed > threshold)
  // punches the aim down by this many degrees, eased back over recoveryMs.
  // Prompt A#53 — threshold lowered from 8.0 to 4.0 m/s. A 7.9 m/s fall
  // produced no punch but was visibly jarring; small hops (4–8 m/s) now
  // produce a subtle punch (scaled by `landingAimPunchSmallHopDeg`), big
  // falls (>8 m/s) produce the full `landingAimPunchDeg`.
  landingAimPunchThreshold: 4.0, // m/s — small-hop threshold (Prompt A#53)
  landingAimPunchSmallHopDeg: 1.5, // degrees — subtle punch for 4–8 m/s falls
  landingAimPunchDeg: 4.0,        // degrees — full punch for >8 m/s falls
  // Prompt A#54 — fast-attack/slow-decay envelope duration. The peak is at
  // t=0 (impact) and decays over this many ms (was flat-then-decay which
  // produced a non-snappy flat top).
  landingAimPunchRecoveryMs: 200,
  landingAimPunchAttackMs: 30, // ms — fast attack to peak (sin(π·t/attackMs))

  // §4 #94 — controller deadzone + response curve.
  controllerDeadzone: 0.12, // 0–1; sticks below this magnitude read as 0
  controllerCurveExponent: 2.2, // exponential curve; 1 = linear, 2 = quadratic, etc.

  // §4 #95 — mouse acceleration toggle. Default OFF (raw input) per the
  // review's note that competitive FPS players want zero smoothing.
  mouseAccelerationDefault: false,

  // §4 #96 — movement speed while reloading (fraction of base walk speed).
  reloadMoveSpeedMult: 0.55,

  // §4 #99 — slide-into-cover snap assist. If the player slides toward cover
  // within this radius, they snap into the cover slot (accessibility + feel).
  slideIntoCoverRadius: 1.2, // m
  slideIntoCoverEnabled: true,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// §4 #76 — Coyote time
// ─────────────────────────────────────────────────────────────────────────────

export interface CoyoteTimeState {
  /** Timestamp (ms, performance.now()) when the player last left the ground. */
  lastGroundedMs: number;
  /** Whether coyote-jump is currently available (within window). */
  available: boolean;
}

export function createCoyoteTimeState(): CoyoteTimeState {
  return { lastGroundedMs: 0, available: false };
}

/**
 * Mark the player as grounded. Call every frame the player is on the ground.
 */
export function markGrounded(state: CoyoteTimeState, now: number): void {
  state.lastGroundedMs = now;
  state.available = true;
}

/**
 * Check if a coyote-jump is still available. Call when the player presses
 * jump while airborne. Returns true if within the grace window.
 */
export function consumeCoyoteJump(state: CoyoteTimeState, now: number): boolean {
  if (!state.available) return false;
  const elapsed = now - state.lastGroundedMs;
  if (elapsed <= MOVEMENT_FEEL.coyoteTimeMs) {
    state.available = false; // one coyote-jump per leave-ground event
    return true;
  }
  state.available = false;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #77 — Input buffer
// ─────────────────────────────────────────────────────────────────────────────

export interface InputBufferState {
  /** Map of action → timestamp it was pressed. */
  presses: Map<string, number>;
}

export function createInputBuffer(): InputBufferState {
  return { presses: new Map() };
}

/** Record a press for `action` (e.g., "jump", "interact", "sprint"). */
export function bufferPress(state: InputBufferState, action: string, now: number): void {
  state.presses.set(action, now);
}

/**
 * Consume a buffered press if it's still within the buffer window.
 * Returns true if the action should fire (and clears the buffer for it).
 */
export function consumeBufferedPress(state: InputBufferState, action: string, now: number): boolean {
  const t = state.presses.get(action);
  if (t === undefined) return false;
  if (now - t <= MOVEMENT_FEEL.inputBufferMs) {
    state.presses.delete(action);
    return true;
  }
  state.presses.delete(action); // expired
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #81 — Fall damage curve
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute fall damage from impact vertical speed.
 * @param impactSpeed  Player's vertical speed at landing (positive = downward). m/s.
 * @returns            Damage amount (0 if below threshold).
 */
export function computeFallDamage(impactSpeed: number): number {
  if (impactSpeed <= MOVEMENT_FEEL.fallDamageThreshold) return 0;
  const raw = (impactSpeed - MOVEMENT_FEEL.fallDamageThreshold) * MOVEMENT_FEEL.fallDamageK;
  return Math.min(raw, MOVEMENT_FEEL.fallDamageMax);
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #83 — Slide downhill momentum conservation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a downhill slide boost to the current speed. The boost is the
 * gravity component along the slope direction PROJECTED ONTO the player's
 * travel direction — so uphill movement is NOT accelerated (the projection
 * is negative, clamped to 0). The previous implementation boosted speed
 * based on slope angle alone, which accelerated UPHILL slides too.
 *
 * @param groundNormal  Unit normal of the ground (pointing up-ish).
 * @param currentSpeed  Current slide speed (m/s).
 * @param dt            Delta time (s).
 * @param travelDir     Player's travel direction (world space, horizontal,
 *                      normalized). If omitted, the function falls back to
 *                      the old slope-only behavior (kept for backward compat
 *                      with callers that haven't been updated).
 * @returns             New speed (m/s) — may exceed current if downhill.
 */
export function applyDownhillSlideBoost(
  groundNormal: THREE.Vector3,
  currentSpeed: number,
  dt: number,
  travelDir?: THREE.Vector3,
): number {
  // Slope angle from horizontal. groundNormal.y = 1 → flat; < 1 → sloped.
  const slopeAngle = Math.acos(Math.max(-1, Math.min(1, groundNormal.y)));
  if (slopeAngle < THREE.MathUtils.degToRad(15)) return currentSpeed; // flat-ish

  // Prompt A#52 — use the player's travel direction to determine whether
  // the slope is downhill (boost) or uphill (no boost). The slope direction
  // is the horizontal projection of the ground normal (the direction the
  // ground "tilts toward"). The dot product of travelDir × slopeDir tells
  // us: positive = downhill (traveling in the slope's down direction),
  // negative = uphill (traveling against the slope's down direction).
  if (travelDir) {
    // Slope direction = horizontal projection of the ground normal,
    // NEGATED (the ground tilts AWAY from the normal's horizontal component).
    // E.g., groundNormal = (0.3, 0.9, 0) → ground tilts toward -X (downhill
    // is -X direction). slopeDir = normalize(-0.3, 0, 0) = (-1, 0, 0).
    const slopeDirX = -groundNormal.x;
    const slopeDirZ = -groundNormal.z;
    const slopeDirLen = Math.hypot(slopeDirX, slopeDirZ);
    if (slopeDirLen < 1e-4) return currentSpeed; // ground normal is vertical
    const invLen = 1 / slopeDirLen;
    const dot = travelDir.x * slopeDirX * invLen + travelDir.z * slopeDirZ * invLen;
    if (dot <= 0) return currentSpeed; // uphill or flat — no boost
    // Downhill — boost proportional to slope angle × travel-direction
    // alignment. dot=1 (perfectly downhill) → full boost; dot=0.5 (45°
    // off-axis) → half boost.
    const boost = MOVEMENT_FEEL.slideDownhillGravityBoost * Math.sin(slopeAngle) * dot * dt;
    return currentSpeed + boost;
  }

  // Legacy fallback (no travel direction) — old slope-only behavior.
  // Preserved for callers that haven't been updated. The bug (uphill
  // acceleration) still exists in this path; callers should pass travelDir.
  const boost = MOVEMENT_FEEL.slideDownhillGravityBoost * Math.sin(slopeAngle) * dt;
  return currentSpeed + boost;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #84 — Stamina-vs-ADS sway
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the ADS sway multiplier given the player's current stamina fraction.
 * Exhausted (stamina < 25%) → 1.6× sway. Otherwise 1.0×.
 */
export function staminaAdsSwayMult(staminaFraction: number): number {
  return staminaFraction < MOVEMENT_FEEL.exhaustedStaminaThreshold
    ? MOVEMENT_FEEL.exhaustedAdsSwayMult
    : 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #89 — Air strafe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply air-strafe acceleration to a horizontal velocity vector.
 * @param velocity   Current velocity (mutated in place, horizontal only).
 * @param wishDir    Desired direction (normalized, horizontal).
 * @param dt         Delta time (s).
 */
export function applyAirStrafe(velocity: THREE.Vector3, wishDir: THREE.Vector3, dt: number): void {
  const accel = MOVEMENT_FEEL.airStrafeAccel * dt;
  const add = Math.min(accel, MOVEMENT_FEEL.airStrafeMaxAdd * dt);
  velocity.x += wishDir.x * add;
  velocity.z += wishDir.z * add;
  // Cap the added speed so air-strafe can't infinitely accelerate.
  const horizSpeed = Math.hypot(velocity.x, velocity.z);
  // Allow up to 1.3× the player's base sprint speed as an air-strafe ceiling.
  const maxAirSpeed = 8.2 * 1.3;
  if (horizSpeed > maxAirSpeed) {
    const scale = maxAirSpeed / horizSpeed;
    velocity.x *= scale;
    velocity.z *= scale;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #94 — Controller response curve
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply deadzone + exponential response curve to a raw stick magnitude.
 * @param raw  -1..1 (or 0..1 for magnitude-only).
 * @returns    Processed -1..1 (deadzone applied, curve applied, sign preserved).
 */
export function applyControllerCurve(raw: number): number {
  const sign = Math.sign(raw);
  const mag = Math.abs(raw);
  if (mag < MOVEMENT_FEEL.controllerDeadzone) return 0;
  // Rescale so the deadzone edge maps to 0 (no jump at the edge).
  const rescaled = (mag - MOVEMENT_FEEL.controllerDeadzone) / (1 - MOVEMENT_FEEL.controllerDeadzone);
  const curved = Math.pow(rescaled, MOVEMENT_FEEL.controllerCurveExponent);
  return sign * curved;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #87 — Swim / water movement
// ─────────────────────────────────────────────────────────────────────────────

export interface WaterVolume {
  /** AABB min corner. */
  min: THREE.Vector3;
  /** AABB max corner. */
  max: THREE.Vector3;
  /** Buoyancy strength (0 = none, 1 = full float). */
  buoyancy: number;
  /** Water drag (0 = no drag, 1 = full stop instantly). */
  drag: number;
}

export interface SwimState {
  /** Whether the player is currently submerged. */
  inWater: boolean;
  /** Submersion depth 0..1 (0 = feet, 1 = fully underwater). */
  submersion: number;
  /** Vertical velocity (for buoyancy). */
  verticalVel: number;
}

export function createSwimState(): SwimState {
  return { inWater: false, submersion: 0, verticalVel: 0 };
}

/**
 * Check if a position is inside a water volume and return submersion depth.
 */
export function computeSubmersion(
  pos: THREE.Vector3,
  water: WaterVolume,
  playerHeight: number,
): number {
  if (
    pos.x < water.min.x ||
    pos.x > water.max.x ||
    pos.z < water.min.z ||
    pos.z > water.max.z ||
    pos.y > water.max.y
  ) {
    return 0;
  }
  // Submersion = how much of the player's height is below the water surface.
  const feetY = pos.y;
  const headY = pos.y + playerHeight;
  const surfaceY = water.max.y;
  if (feetY >= surfaceY) return 0;
  if (headY <= surfaceY) return 1;
  return (surfaceY - feetY) / playerHeight;
}

/**
 * Apply swim physics to a velocity for one frame.
 * @param velocity  Current velocity (mutated).
 * @param wishDir   Desired swim direction (normalized).
 * @param water     The water volume.
 * @param dt        Delta time (s).
 */
export function applySwimPhysics(
  velocity: THREE.Vector3,
  wishDir: THREE.Vector3,
  water: WaterVolume,
  dt: number,
): void {
  // Swim speed is ~40% of walk speed.
  const swimSpeed = 8.2 * 0.4;
  // Water drag.
  const dragFactor = 1 - water.drag * dt;
  velocity.x *= dragFactor;
  velocity.y *= dragFactor;
  velocity.z *= dragFactor;
  // Swim wish direction.
  velocity.x += wishDir.x * swimSpeed * dt * 2;
  velocity.z += wishDir.z * swimSpeed * dt * 2;
  // Buoyancy — pushes the player up toward the surface.
  velocity.y += water.buoyancy * 4 * dt;
  // Cap vertical so buoyancy doesn't launch the player out of the water.
  if (velocity.y > 3) velocity.y = 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #97 — Door interaction
// ─────────────────────────────────────────────────────────────────────────────

export type DoorState = "closed" | "open" | "opening" | "closing" | "breached";

export interface Door {
  id: string;
  /** Hinge pivot world position. */
  hinge: THREE.Vector3;
  /** Closed rotation (radians, Y axis). */
  closedRotation: number;
  /** Open rotation (radians, Y axis). */
  openRotation: number;
  state: DoorState;
  /** Current rotation (radians, interpolated). */
  currentRotation: number;
  /** HP — 0 means destroyed/breached. */
  hp: number;
  /** Whether this door can be breached (destructible). */
  breachable: boolean;
}

/**
 * Update door state for one frame (animate opening/closing).
 */
export function updateDoor(door: Door, dt: number): void {
  if (door.state === "opening") {
    const target = door.openRotation;
    const speed = 3; // rad/s
    if (door.currentRotation < target) {
      door.currentRotation = Math.min(target, door.currentRotation + speed * dt);
      if (door.currentRotation >= target) door.state = "open";
    } else {
      door.currentRotation = Math.max(target, door.currentRotation - speed * dt);
      if (door.currentRotation <= target) door.state = "open";
    }
  } else if (door.state === "closing") {
    const target = door.closedRotation;
    const speed = 3;
    if (door.currentRotation > target) {
      door.currentRotation = Math.max(target, door.currentRotation - speed * dt);
      if (door.currentRotation <= target) door.state = "closed";
    } else {
      door.currentRotation = Math.min(target, door.currentRotation + speed * dt);
      if (door.currentRotation >= target) door.state = "closed";
    }
  }
}

/**
 * Interact with a door (open/close toggle).
 */
export function interactDoor(door: Door): void {
  if (door.state === "closed") door.state = "opening";
  else if (door.state === "open") door.state = "closing";
}

/**
 * Breach a door (destroy it). Used by §7 breach-charge mechanics.
 */
export function breachDoor(door: Door): void {
  if (!door.breachable) return;
  door.hp = 0;
  door.state = "breached";
  door.currentRotation = door.openRotation; // blown open
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #99 — Slide-into-cover snap assist
// ─────────────────────────────────────────────────────────────────────────────

export interface CoverPoint {
  /** World position of the cover slot. */
  pos: THREE.Vector3;
  /** Cover quality 0..1 (1 = full cover). */
  quality: number;
}

/**
 * Given the player's position and a list of nearby cover points, find the
 * best snap target within the slide-into-cover radius.
 */
export function findSlideIntoCoverTarget(
  playerPos: THREE.Vector3,
  coverPoints: CoverPoint[],
): CoverPoint | null {
  if (!MOVEMENT_FEEL.slideIntoCoverEnabled) return null;
  let best: CoverPoint | null = null;
  let bestDist: number = MOVEMENT_FEEL.slideIntoCoverRadius;
  for (const cp of coverPoints) {
    const d = playerPos.distanceTo(cp.pos);
    if (d < bestDist) {
      bestDist = d;
      best = cp;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #92 — Landing aim-punch
// ─────────────────────────────────────────────────────────────────────────────

export interface LandingPunchState {
  /** Current punch offset (degrees, positive = down). Eased back to 0. */
  currentDeg: number;
  /** Timestamp when the punch started. */
  startMs: number;
}

export function createLandingPunchState(): LandingPunchState {
  return { currentDeg: 0, startMs: 0 };
}

/**
 * Trigger a landing aim-punch if the impact was hard enough.
 * Prompt A#53 — threshold lowered from 8.0 to 4.0 m/s + small-hop punch.
 * A 7.9 m/s fall previously produced no punch but was visibly jarring;
 * now 4–8 m/s falls produce a subtle punch (landingAimPunchSmallHopDeg),
 * and >8 m/s falls produce the full punch (landingAimPunchDeg).
 */
export function triggerLandingPunch(state: LandingPunchState, impactSpeed: number, now: number): void {
  if (impactSpeed <= MOVEMENT_FEEL.landingAimPunchThreshold) return;
  // Scale the punch magnitude by impact speed: small hops (4–8 m/s) get
  // the small-hop magnitude; big falls (>8 m/s) get the full magnitude.
  // The crossfade between the two is linear across the 4–8 m/s window.
  const smallHopEnd = 8.0;
  const smallHopDeg = MOVEMENT_FEEL.landingAimPunchSmallHopDeg;
  const fullDeg = MOVEMENT_FEEL.landingAimPunchDeg;
  const deg = impactSpeed < smallHopEnd
    ? THREE.MathUtils.lerp(smallHopDeg, fullDeg, (impactSpeed - MOVEMENT_FEEL.landingAimPunchThreshold) / (smallHopEnd - MOVEMENT_FEEL.landingAimPunchThreshold))
    : fullDeg;
  state.currentDeg = deg;
  state.startMs = now;
}

/**
 * Ease the landing punch back to 0. Call every frame.
 * Prompt A#54 — fast-attack/slow-decay envelope. The peak is at t=0
 * (impact) and decays via a sin(π·t) envelope over recoveryMs. The
 * previous flat-then-decay shape produced a non-snappy flat top (the
 * punch was at full magnitude for one frame then decayed). The new
 * envelope peaks at impact + decays smoothly — a snappy peak, not a
 * flat top. The fast-attack phase (first 30ms) ramps from 0 to peak
 * so the punch doesn't snap in (which would look like a frame-skip).
 */
export function updateLandingPunch(state: LandingPunchState, now: number): number {
  if (state.currentDeg === 0) return 0;
  const elapsed = now - state.startMs;
  const attackMs = MOVEMENT_FEEL.landingAimPunchAttackMs;
  const recoveryMs = MOVEMENT_FEEL.landingAimPunchRecoveryMs;
  if (elapsed >= attackMs + recoveryMs) {
    state.currentDeg = 0;
    return 0;
  }
  if (elapsed < attackMs) {
    // Fast attack — ramp from 0 to peak over attackMs.
    const attackT = elapsed / attackMs;
    return state.currentDeg * Math.sin(attackT * Math.PI * 0.5); // ease-out to peak
  }
  // Slow decay — sin(π·t) envelope from peak back to 0 over recoveryMs.
  const decayT = (elapsed - attackMs) / recoveryMs;
  // sin(π·(1 - t)) = sin(π - π·t) = sin(π·t) — peaks at t=0, 0 at t=1.
  return state.currentDeg * Math.sin((1 - decayT) * Math.PI);
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 #100 — Movement blind-playtest findings (documented)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §4 item 100: "Playtest movement blind (no HUD, no debug) for 15 minutes and
 * write down every 'that felt wrong' moment."
 *
 * This is a documentation stub — the actual blind playtest requires a human.
 * The findings template lives in `docs/MOVEMENT-BLIND-PLAYTEST.md` (created
 * by this Task). Fill it in after a real playtest session.
 */
export const MOVEMENT_BLIND_PLAYTEST_DOC_PATH = "docs/MOVEMENT-BLIND-PLAYTEST.md";

// ─────────────────────────────────────────────────────────────────────────────
// §4 #76–#100 summary — what's wired, what's a tuning knob, what's a doc
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_4_STATUS = {
  // Mechanics added as code:
  coyoteTime: "code (MovementFeelSystem.createCoyoteTimeState + consumeCoyoteJump)",
  inputBuffer: "code (MovementFeelSystem.createInputBuffer + consumeBufferedPress)",
  cameraBobSlider: "code (constant; wired in SettingsPanel GameplayPanel)",
  leanAlternateKeys: "code (KeyQ/KeyE added as alternates to BracketLeft/BracketRight in InputSystem)",
  mantleRadiusTuning: "code (constant mantleMinTriggerHeight/vaultMaxTriggerHeight)",
  fallDamageCurve: "code (computeFallDamage)",
  sprintToFireDelay: "code (constant sprintToFireDelayMs; wired in WeaponSystem sprint-release)",
  slideDownhillMomentum: "code (applyDownhillSlideBoost)",
  staminaAdsSway: "code (staminaAdsSwayMult; wired in WeaponSystem ADS sway)",
  crouchJump: "code (constants crouchJumpHeightMult/speedMult; wired in PhysicsSystem jump)",
  mantleCameraBlend: "code (constant mantleCameraBlendMs; wired in ProceduralAnimSystem)",
  swim: "code (WaterVolume + applySwimPhysics; maps opt-in via MapBuilder water volumes)",
  vehicleCameraSmoothing: "code (constant vehicleCameraLerp; wired in vehicles.ts)",
  airStrafe: "code (applyAirStrafe; wired in PhysicsSystem air branch)",
  stepHeight: "code (constant; wired in PhysicsSystem ground check)",
  viewModelSway: "code (constants; wired in weapon-viewmodel.ts)",
  landingAimPunch: "code (triggerLandingPunch + updateLandingPunch)",
  controllerCurve: "code (applyControllerCurve; wired in gamepad.ts)",
  mouseAccelToggle: "code (constant + SettingsPanel toggle; default OFF = raw input)",
  reloadMoveSpeed: "code (constant reloadMoveSpeedMult; wired in PhysicsSystem reload state)",
  doorInteraction: "code (Door + interactDoor/breachDoor; maps opt-in via MapBuilder door props)",
  ladders: "verified-existing (VaultSystem.tryLadder)",
  slideIntoCover: "code (findSlideIntoCoverTarget; wired in PhysicsSystem slide state)",
  blindPlaytest: "doc (docs/MOVEMENT-BLIND-PLAYTEST.md — template for human playtest)",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Section B — Prompt 156 / 217: breath-hold for scoped weapons.
//
// Holding Shift while ADS with a scoped weapon reduces sway for 3s (a "breath
// hold"), then sway spikes (exhale). A breath meter drains while held + refills
// when released. The sniper can steady a shot on demand with a visible cost.
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum breath-hold duration (seconds) before the exhale spike. */
export const BREATH_HOLD_MAX_SEC = 3.0;
/** Time after a full exhale before the player can hold breath again (seconds). */
export const BREATH_RECOVERY_SEC = 2.0;
/** Sway multiplier during the steady (held) window. 0.15 = 85% reduction. */
export const BREATH_HOLD_SWAY_MULT = 0.15;
/** Sway multiplier during the exhale spike (after the steady window ends). */
export const BREATH_EXHALE_SWAY_MULT = 1.8;
/** Sway multiplier when breath is full / not holding. */
export const BREATH_REST_SWAY_MULT = 1.0;

export interface BreathHoldState {
  /** Current breath ratio 0..1 (1 = full, 0 = empty). */
  breath: number;
  /** True while the player is holding breath (Shift while ADS + scoped). */
  holding: boolean;
  /** True if currently in the exhale-spike window (sway penalty). */
  exhaling: boolean;
  /** Timestamp (performance.now()) when the hold started. 0 when not holding. */
  holdStart: number;
  /** Timestamp (performance.now()) when the exhale spike started. 0 otherwise. */
  exhaleStart: number;
}

export function createBreathHoldState(): BreathHoldState {
  return { breath: 1, holding: false, exhaling: false, holdStart: 0, exhaleStart: 0 };
}

/**
 * Begin a breath hold. Only valid if breath is high enough (≥ 0.2) and not
 * currently in the recovery window. Idempotent — calling while already holding
 * is a no-op.
 */
export function beginBreathHold(state: BreathHoldState, now: number = performance.now()): void {
  if (state.holding) return;
  if (state.exhaling) return;
  if (state.breath < 0.2) return;
  state.holding = true;
  state.holdStart = now;
}

/**
 * End a breath hold (player released Shift). Returns to the rest state with
 * whatever breath remains; the player can immediately re-hold if breath > 0.2.
 */
export function endBreathHold(state: BreathHoldState): void {
  state.holding = false;
  state.holdStart = 0;
}

/**
 * Per-frame breath-hold update. Drains breath while holding; when breath hits
 * 0, transitions to the exhale state (sway spike) for BREATH_RECOVERY_SEC,
 * during which the player can't re-hold. Returns the sway multiplier the
 * caller should apply to the scoped ADS sway.
 *
 * @param dt       Delta time (seconds).
 * @param isScoped True if the player is currently ADS with a scoped weapon.
 * @param now      Current timestamp (ms).
 */
export function updateBreathHold(
  state: BreathHoldState,
  dt: number,
  isScoped: boolean,
  now: number = performance.now(),
): number {
  // If the player let go of ADS or un-scoped, end any active hold.
  if (!isScoped && state.holding) {
    endBreathHold(state);
  }
  if (state.holding) {
    // Drain breath over BREATH_HOLD_MAX_SEC.
    const drain = dt / BREATH_HOLD_MAX_SEC;
    state.breath = Math.max(0, state.breath - drain);
    if (state.breath <= 0) {
      // Breath exhausted → transition to exhale spike.
      state.holding = false;
      state.holdStart = 0;
      state.exhaling = true;
      state.exhaleStart = now;
      return BREATH_EXHALE_SWAY_MULT;
    }
    return BREATH_HOLD_SWAY_MULT;
  }
  if (state.exhaling) {
    const elapsed = (now - state.exhaleStart) / 1000;
    if (elapsed >= BREATH_RECOVERY_SEC) {
      state.exhaling = false;
      state.exhaleStart = 0;
    } else {
      // Spike fades linearly from BREATH_EXHALE_SWAY_MULT to BREATH_REST_SWAY_MULT.
      const t = elapsed / BREATH_RECOVERY_SEC;
      return BREATH_EXHALE_SWAY_MULT - (BREATH_EXHALE_SWAY_MULT - BREATH_REST_SWAY_MULT) * t;
    }
  }
  // Refill breath when not holding/exhaling.
  if (state.breath < 1) {
    const refill = dt / BREATH_RECOVERY_SEC;
    state.breath = Math.min(1, state.breath + refill);
  }
  return BREATH_REST_SWAY_MULT;
}

/** Get the current sway multiplier without advancing state (read-only). */
export function getBreathHoldSwayMult(state: BreathHoldState): number {
  if (state.holding) return BREATH_HOLD_SWAY_MULT;
  if (state.exhaling) return BREATH_EXHALE_SWAY_MULT;
  return BREATH_REST_SWAY_MULT;
}
