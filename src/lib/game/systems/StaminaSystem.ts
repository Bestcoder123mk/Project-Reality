import type { GameSystem, GameContext, StaminaState } from "./types";

/**
 * StaminaSystem — P4.2 stamina & sprint economy.
 *
 * Stamina gates sprinting, jumping, and (slightly) aiming. When stamina
 * hits 0, the player is "exhausted" and cannot sprint until stamina
 * regenerates past a recovery threshold after a cooldown.
 *
 * The system reads input (ShiftLeft for sprint, Space for jump, weapon.isAiming)
 * and mutates ctx.stamina. PhysicsSystem reads ctx.stamina.exhausted to gate
 * sprinting; PhysicsSystem consults ctx.stamina.value >= jumpCost before
 * allowing a jump.
 *
 * HUD integration: pushHud with a `stamina` field is left for P6.4 settings
 * panel expansion (the HUD widget itself).
 */

/**
 * P4.2: Try to consume stamina for a jump. Returns true if jump is allowed.
 * Mutates the state (consumes jumpCost, may set exhausted).
 *
 * Pure function — callable from any system with access to the StaminaState.
 */
export function tryJump(s: StaminaState): boolean {
  if (s.exhausted) return false;
  if (s.value < s.jumpCost) return false;
  s.value -= s.jumpCost;
  if (s.value <= 0) {
    s.exhausted = true;
    s.regenResumesAt = performance.now() + s.exhaustionCooldown * 1000;
  }
  return true;
}

/** P4.2: Is sprinting currently allowed? Pure function. */
export function canSprint(s: StaminaState): boolean {
  return !s.exhausted && s.value > 0;
}

export class StaminaSystem implements GameSystem {
  constructor(private ctx: GameContext) {}

  update(dt: number) {
    const { ctx } = this;
    const s = ctx.stamina;
    const now = performance.now();
    const isSprinting = ctx.keys["ShiftLeft"] && ctx.keys["KeyW"] && !ctx.player.crouching && !ctx.weapon.isAiming;
    const isAiming = ctx.weapon.isAiming;

    if (s.exhausted && now < s.regenResumesAt) {
      // In exhaustion cooldown — no regen, no sprint.
      return;
    }
    if (s.exhausted && now >= s.regenResumesAt && s.value >= s.max * 0.3) {
      // Recovered enough to clear the exhausted flag.
      s.exhausted = false;
    }

    if (isSprinting && !s.exhausted) {
      s.value = Math.max(0, s.value - s.sprintDrainRate * dt);
      if (s.value <= 0) {
        s.exhausted = true;
        s.regenResumesAt = now + s.exhaustionCooldown * 1000;
      }
    } else if (isAiming) {
      // Aiming drains a small amount (steady aim fatigue).
      s.value = Math.max(0, s.value - s.aimDrainRate * dt);
      // Regen is paused while aiming.
    } else {
      // Regen.
      const regenRate = s.exhausted ? s.regenRate * 0.5 : s.regenRate;
      s.value = Math.min(s.max, s.value + regenRate * dt);
    }
  }

  /** P4.2: Instance method that delegates to the pure function (for convenience). */
  tryJump(): boolean { return tryJump(this.ctx.stamina); }
  canSprint(): boolean { return canSprint(this.ctx.stamina); }
}
