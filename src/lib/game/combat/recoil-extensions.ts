/**
 * B1-5000 — Section B recoil extensions (prompts 609, 611–614, 618–624, 627–630).
 *
 * This module layers the additional recoil features requested by the 5000-prompt
 * Section B (601–767) on top of the existing RecoilSystem + recoil-tuning
 * modules. The existing modules already cover:
 *
 *   602 easeOutCubic recovery         (RecoilSystem.easeOutCubicRecovery)
 *   603 stamina coupling              (RecoilSystem.getStaminaScaledRecoveryMs)
 *   604 difficulty multiplier         (RecoilSystem.DIFFICULTY_RECOIL_MULT)
 *   605 damage sway                   (RecoilSystem.getDamageSwayMult)
 *   615 deterministic seeded PRNG     (recoil-tuning.makeRng / generateRecoilPattern)
 *   616 per-weapon recoveryMs         (RecoilSystem.recoveryMs field)
 *   617 pattern validation on build   (recoil-tuning.validateRecoilPatterns)
 *   625 pattern visualization helpers (recoil-tuning.generateRecoilPattern)
 *   626 pattern comparison helpers    (recoil-tuning — same generator, two seeds)
 *
 * This file adds the missing helpers as pure functions + small data tables.
 * The orchestrator wires them with one-liners in WeaponSystem.tryShoot.
 */

import type { WeaponType } from "../store";
import { RECOIL_PATTERNS, applyRecoilPattern } from "../systems/RecoilSystem";

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 609 — first-shot recoil multiplier (cold-bore / surprise break).
//
// The first shot of a mag kicks more than subsequent shots — the cold bore +
// surprise break + the shooter's flinch. The existing pattern data already
// encodes a "first-shot" feel in the per-weapon patterns (e.g. AWP's first
// sample is 3.0, AUG's first sample is the heaviest). This adds an ENGINE
// multiplier on top of the pattern's first-shot value so the kick is felt
// even when the pattern's first sample isn't deliberately larger.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-category first-shot recoil multiplier. Adds 15–35% on top of the
 *  pattern's first-shot value. Snipers + shotguns get the biggest cold-bore
 *  kick (single-shot weapons where the first shot matters most). */
export const FIRST_SHOT_RECOIL_MULT: Record<string, number> = {
  RIFLE: 1.15,
  SMG: 1.10,
  PISTOL: 1.20,
  SNIPER: 1.35,
  SHOTGUN: 1.30,
  LMG: 1.10,
};

/** Prompt 609 — get the first-shot recoil multiplier for a weapon's category. */
export function firstShotRecoilMult(category: string, shotIndex: number): number {
  if (shotIndex !== 0) return 1.0;
  return FIRST_SHOT_RECOIL_MULT[category] ?? 1.15;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 611 — separate vertical vs horizontal recoil.
//
// The existing applyRecoilPattern applies the same `recoilAmount` to both X
// (horizontal) and Y (vertical). The sectionB.ts MUZZLE_STATS table already
// has distinct verticalRecoilMult + horizontalRecoilMult per muzzle device.
// This helper takes those multipliers + returns the split (vx, vy) so the
// caller can apply them independently. The default (1.0, 1.0) preserves the
// existing behavior when no attachment multipliers are passed.
// ─────────────────────────────────────────────────────────────────────────────

export interface AxisRecoilMult {
  vertical: number;
  horizontal: number;
}

/** Prompt 611 — split recoil into vertical + horizontal components with
 *  per-axis multipliers. Falls back to (1,1) so callers without attachment
 *  data get the legacy unified-recoil behavior. */
export function splitRecoilAxes(
  baseRecoil: { x: number; y: number },
  mult: AxisRecoilMult = { vertical: 1.0, horizontal: 1.0 },
): { x: number; y: number } {
  return {
    x: baseRecoil.x * mult.horizontal,
    y: baseRecoil.y * mult.vertical,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 612 — pattern loop reset on mag-dump end.
//
// The existing `applyRecoilPattern` uses `shotIndex % pattern.points.length`
// so the pattern loops indefinitely. After a 30-shot mag dump the pattern
// restarts but the accumulated `recoilOffset` doesn't, producing a jarring
// pattern restart with the player still aimed high. This helper returns
// whether the pattern index should reset (mag change) + the engine uses it
// in WeaponSystem.startReload to zero `shotCount`.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 612 — should the recoil pattern index reset? Returns true on a mag
 *  change (reload or swap). The engine calls this + zeros `shotCount` so the
 *  next burst starts a fresh pattern. */
export function shouldResetPatternOnMagChange(
  isReloading: boolean,
  isSwapping: boolean,
): boolean {
  return isReloading || isSwapping;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 614 — recoil reset on weapon switch.
//
// `selectSlot` doesn't reset `recoilOffset`/`shotCount`; switching mid-burst
// carries accumulation. This helper returns the reset state so the caller
// applies it.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 614 — return the post-switch recoil state. Zeros accumulated offset
 *  + shot count so switching weapons doesn't carry the previous weapon's
 *  accumulated climb. */
export function resetRecoilOnSwitch(): { recoilOffset: number; shotCount: number } {
  return { recoilOffset: 0, shotCount: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 618 — recoil kick to camera.
//
// The existing tryShoot applies `ctx.player.pitch += recoil.y * 0.015` and
// `ctx.player.yaw -= recoil.x * 0.015`. The 0.015 multiplier is the camera
// kick. This helper exposes the camera-kick multipliers as data so the
// per-category feel can be tuned without touching WeaponSystem. The existing
// values (0.015 / 0.015) are the defaults.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-category camera kick multipliers (rad per unit recoil). Heavier
 *  weapons kick the camera more (sniper 0.025, pistol 0.010). */
export const CAMERA_KICK_MULT: Record<string, AxisRecoilMult> = {
  RIFLE: { vertical: 0.015, horizontal: 0.015 },
  SMG: { vertical: 0.012, horizontal: 0.012 },
  PISTOL: { vertical: 0.010, horizontal: 0.010 },
  SNIPER: { vertical: 0.025, horizontal: 0.018 },
  SHOTGUN: { vertical: 0.022, horizontal: 0.020 },
  LMG: { vertical: 0.018, horizontal: 0.016 },
};

/** Prompt 618 — get the per-category camera kick multipliers for a shot. */
export function cameraKickForCategory(category: string): AxisRecoilMult {
  return CAMERA_KICK_MULT[category] ?? CAMERA_KICK_MULT.RIFLE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 619 — recoil smoothing for full-auto (sustained fire climbing).
//
// Full-auto fire should climb predictably. The first shot kicks full, the
// second adds 95% of its pattern value, the third 92%, etc — converging to
// ~80% per shot after 10 rounds. This makes a mag dump feel like a smooth
// ramp rather than identical per-shot kicks. The smoothing multiplier is
// applied on top of the pattern value.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 619 — sustained-fire smoothing multiplier. Shot 0 = 1.0 (full kick),
 *  shot 9+ = 0.80 (80% per shot). Linear ramp between. */
export function sustainedFireSmoothingMult(shotIndex: number): number {
  if (shotIndex <= 0) return 1.0;
  if (shotIndex >= 10) return 0.80;
  // Linear from 1.0 at shot 0 → 0.80 at shot 10.
  return 1.0 - 0.02 * shotIndex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 620–623 — recoil reset on landing + penalties for sliding/falling/
// prone-diving.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 620 — reset accumulated recoil on landing (jump interrupts burst →
 *  recoil resets when the player lands). Returns the reset state. */
export function resetRecoilOnLanding(): { recoilOffset: number } {
  return { recoilOffset: 0 };
}

/** Per-motion-state recoil spread multiplier. Sliding/falling/prone-diving
 *  shots are inaccurate. Returns a multiplier on the base spread. */
export const MOTION_RECOIL_PENALTY: Record<string, number> = {
  sliding: 2.0,    // Prompt 621 — sliding fire has huge spread (2×)
  falling: 1.7,    // Prompt 622 — airborne fire inaccurate (1.7×)
  proneDiving: 2.2,// Prompt 623 — dive fire inaccurate (2.2×)
  grounded: 1.0,
  sprinting: 1.4,
};

/** Prompts 621–623 — get the motion-state recoil + spread penalty. Returns 1.0
 *  for normal grounded fire. */
export function motionStatePenalty(state: "sliding" | "falling" | "proneDiving" | "grounded" | "sprinting"): number {
  return MOTION_RECOIL_PENALTY[state] ?? 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 624 — recoil recovery disabled while firing.
//
// Recovery should only happen between shots. While the trigger is held, the
// accumulated `recoilOffset` shouldn't decay. The engine uses this gate in
// the per-frame recovery loop. Returns true if recovery should be skipped
// this frame.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 624 — should the recoil recovery be skipped this frame? True while
 *  the trigger is held (the player is firing); false between shots. */
export function shouldSkipRecoveryWhileFiring(
  fireHeld: boolean,
  msSinceLastShot: number,
  fireRateMs: number,
): boolean {
  // If the trigger is held AND the last shot was within 1.5× the fire rate
  // (i.e. we're in a burst), skip recovery. Otherwise allow recovery.
  if (!fireHeld) return false;
  return msSinceLastShot < fireRateMs * 1.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 627 — recoil pattern randomization (±5% per shot).
//
// The existing applyRecoilPattern already adds per-shot randomization from
// the per-weapon `randomness` field (0.18–0.70 per weapon). This helper adds
// a SECONDARY ±5% randomization on top so patterns aren't robotically
// identical even at minimum randomness. Returns the randomized recoil value.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 627 — add ±5% randomization on top of the per-shot recoil. */
export function addPatternRandomization(recoil: { x: number; y: number }): { x: number; y: number } {
  const r = 0.05;
  return {
    x: recoil.x * (1 + (Math.random() - 0.5) * 2 * r),
    y: recoil.y * (1 + (Math.random() - 0.5) * 2 * r),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 628 — recoil pattern seed display for competitive.
//
// For competitive modes the recoil pattern seed is displayed so patterns are
// reproducible + auditable. This helper formats the seed for HUD display.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 628 — format the pattern seed for competitive HUD display. Returns
 *  an 8-character hex string. */
export function formatRecoilSeed(seed: number): string {
  return (seed >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 629–630 — recoil "bloom" (sustained-fire spread) + "settle" (1s
// no-fire reduces accumulated recoil faster).
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 629 — sustained-fire bloom. The base spread increases by `bloomPerShot`
 *  per shot, capped at `maxBloom`. Returns the bloom-added spread. */
export function sustainedFireBloom(
  shotIndex: number,
  bloomPerShot: number = 0.02,
  maxBloom: number = 0.30,
): number {
  return Math.min(maxBloom, shotIndex * bloomPerShot);
}

/** Prompt 630 — settle bonus. Not firing for `SETTLE_THRESHOLD_MS` reduces
 *  accumulated recoil faster. Returns the recovery multiplier (1.0 normal,
 *  2.0 settled). */
export const SETTLE_THRESHOLD_MS = 1000;
export const SETTLE_BONUS_MULT = 2.0;

export function recoilSettleMult(msSinceLastShot: number): number {
  if (msSinceLastShot < SETTLE_THRESHOLD_MS) return 1.0;
  return SETTLE_BONUS_MULT;
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined per-shot recoil helper. The orchestrator can call this to apply
// the full Section B recoil math in one place — first-shot bonus, axis split,
// sustained-fire smoothing, motion-state penalty, pattern randomization.
// Returns the final (camera-pitch, camera-yaw) delta to apply.
// ─────────────────────────────────────────────────────────────────────────────

export interface RecoilShotInput {
  weapon: WeaponType;
  category: string;
  shotIndex: number;
  baseRecoilAmount: number;
  axisMult?: AxisRecoilMult;
  motionState?: "sliding" | "falling" | "proneDiving" | "grounded" | "sprinting";
  /** Apply ±5% per-shot randomization (Prompt 627). Default true. */
  applyRandomization?: boolean;
}

export interface RecoilShotResult {
  /** Camera pitch delta (radians). Positive = up. */
  pitchDelta: number;
  /** Camera yaw delta (radians). Positive = right. */
  yawDelta: number;
  /** Weapon viewmodel kick (z = vertical, x = horizontal). */
  weaponKick: { x: number; z: number };
  /** The raw post-axis post-smoothing recoil for diagnostics. */
  raw: { x: number; y: number };
}

/** Compute the full per-shot recoil for the camera + viewmodel. Applies:
 *   1. The base pattern (applyRecoilPattern)
 *   2. First-shot multiplier (#609)
 *   3. Axis split (#611)
 *   4. Sustained-fire smoothing (#619)
 *   5. Motion-state penalty (#621–623)
 *   6. ±5% randomization (#627)
 *   7. Camera kick multipliers (#618)
 */
export function computeRecoilShot(input: RecoilShotInput): RecoilShotResult {
  const base = applyRecoilPattern(input.weapon, input.shotIndex, input.baseRecoilAmount);
  const firstShot = firstShotRecoilMult(input.category, input.shotIndex);
  const smoothed = sustainedFireSmoothingMult(input.shotIndex);
  const motion = input.motionState ? motionStatePenalty(input.motionState) : 1.0;
  let x = base.x * firstShot * smoothed * motion;
  let y = base.y * firstShot * smoothed * motion;
  // Axis split (vertical vs horizontal) from muzzle/foregrip attachments.
  if (input.axisMult) {
    const split = splitRecoilAxes({ x, y }, input.axisMult);
    x = split.x;
    y = split.y;
  }
  // ±5% per-shot randomization.
  if (input.applyRandomization !== false) {
    const r = addPatternRandomization({ x, y });
    x = r.x;
    y = r.y;
  }
  // Camera kick multipliers.
  const cam = cameraKickForCategory(input.category);
  return {
    pitchDelta: y * cam.vertical,
    yawDelta: -x * cam.horizontal,
    weaponKick: { x: x * 0.02, z: 0.06 + y * 0.02 },
    raw: { x, y },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern presence check — convenience for build-time validation.
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if the weapon has a non-empty recoil pattern authored. */
export function hasRecoilPattern(weapon: WeaponType): boolean {
  const p = RECOIL_PATTERNS[weapon];
  return !!p && p.points.length > 0;
}
