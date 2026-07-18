import type { GameSystem, GameContext, Enemy } from "./types";

/**
 * SuppressionSystem — owns the suppression scalar (R3.2).
 * Decays toward 0 over time. Effects on sway/spread are read by other systems.
 *
 * Task-6: now also drives the post-processing suppression visual — when
 * `suppression.value > 0.4`, the screen desaturates + the vignette tightens
 * to sell the "pinned down" feel. Below the threshold (and as it decays) the
 * grade lerps back to baseline (saturation 0.95, vignette 0.22). The visual
 * mapping is monotonic across the full 0..1 range so the effect ramps
 * smoothly rather than snapping.
 *
 * Prompt #53 — now also owns PER-ENEMY suppression. Each enemy has a
 * `e.suppression` scalar (0..1) that is bumped by player bullets whizzing
 * past them (ProjectileSystem calls `ctx.addEnemySuppression(e, amt)`).
 * The system decays every enemy's suppression each frame at 0.2/s (same
 * rate as the player's). The FSM reads `e.suppression` (via the
 * `enemySuppression` field in the tick situation) and transitions to the
 * SUPPRESSED state when it crosses the per-class suppressionThreshold
 * (default 0.6). tickSuppressed (enemy-tactics.ts) then implements the
 * duck/peek/cover behavior. Recovery (back to CHASE) fires when suppression
 * decays below the recoveryThreshold (default 0.2).
 *
 * Why per-enemy (vs the previous shared ctx.suppression.value): the player's
 * suppression reflects "I am being shot at" (the screen desaturates, the
 * camera shakes). Driving enemy SUPPRESSED state from that scalar meant ALL
 * enemies ducked whenever the player was pinned — which is the opposite of
 * the intended realism (enemies should duck when the PLAYER suppresses THEM,
 * not when they suppress the player). Per-enemy suppression fixes this: a
 * burst from the player's LMG that flies over an enemy's head pins THAT
 * enemy, while enemies elsewhere keep advancing.
 *
 * Section D #519 — screen-blur coupling. When suppression > 0.5, the system
 * drives a screen-blur pass (via ctx.postProc.setBlur) in addition to the
 * desaturation/vignette. The blur scales linearly from 0 (at 0.5) to 1.5px
 * (at 1.0) — enough to read as "vision narrowing under fire" without being
 * disorienting.
 *
 * Section D #520 — AI panic animation. When an enemy's suppression crosses
 * 0.8 (panic threshold), the system sets `e.panic = true`. The animation
 * system reads this to play a panic flinch (head duck + weapon dip). Cleared
 * when suppression drops below 0.4.
 *
 * Section D #521 — snap-to-cover on suppression. When an enemy's suppression
 * crosses the suppressionThreshold for the first time (rising edge), the
 * system emits a `snapToCover` flag on the enemy. tickSuppressed reads this
 * to skip the slow "look for cover" path + snap directly to the nearest
 * cover position.
 *
 * Section D #522 — friendly suppression of the player. Incoming enemy fire
 * applies suppression to the player via addSuppression(). The ProjectileSystem
 * already calls this on near-miss; the SuppressionSystem exposes a helper
 * `applyFriendlySuppression(intensity)` for the AI to call when laying down
 * suppressive fire (MG suppressiveLane).
 *
 * Section D #523 — suppression accuracy penalty. The player's accuracy is
 * degraded while suppressed. The system exposes `getPlayerAccuracyPenalty()`
 * returning 0..0.5 (0 = no penalty, 0.5 = half accuracy at full suppression).
 * WeaponSystem reads this + multiplies the weapon's base accuracy.
 */
export class SuppressionSystem implements GameSystem {
  constructor(private ctx: GameContext) {}

  update(dt: number) {
    const { ctx } = this;
    // Player's suppression — decays toward 0.
    // Section D #1972 — exponential decay (vs the prior linear `value - 0.2*dt`).
    // Exponential decay feels more natural: suppression drops fast at first
    // (the player feels relief quickly once fire stops) then tapers (a tiny
    // residue lingers for a moment). The decay rate (0.5/s half-life ≈ 70%
    // gone in 1s, 95% in 3s) matches the "pin duration ≈ 2-3s after fire
    // stops" target. Linear decay at 0.2/s took 5s to fully clear, which
    // felt sluggish + kept the screen blurred too long.
    const SUPPRESSION_DECAY_PER_SEC = 0.5; // 50% of remaining per second.
    const decayFactor = Math.pow(1 - SUPPRESSION_DECAY_PER_SEC, dt);
    ctx.suppression.value = ctx.suppression.value * decayFactor;
    if (ctx.suppression.value < 1e-4) ctx.suppression.value = 0;
    ctx.pushHud({ suppression: ctx.suppression.value });

    // Task-6: drive the post-proc suppression visual. Lerp saturation from
    // 0.95 (baseline near-full color) down to 0.5 (heavy desaturation) and
    // vignette from 0.22 (baseline light) up to 0.5 (heavy tunnel vision) as
    // suppression climbs to 1. Only takes visible effect above ~0.4.
    const pp = ctx.postProc;
    if (pp) {
      const s = ctx.suppression.value;
      // Smoothstep the input so the visual is barely perceptible under 0.4
      // and ramps hard above it — matches the "pinned" threshold feel.
      const t = s < 0.4 ? 0 : (s - 0.4) / 0.6;
      const sm = t * t * (3 - 2 * t); // smoothstep
      pp.setSaturation(0.95 - 0.45 * sm);
      pp.setVignette(0.22 + 0.28 * sm);
      // Subtle bloom lift so bright sources (muzzle flashes) read through the desaturation.
      pp.setBloomStrength(0.18 + 0.12 * sm);
      // Section D #519 — screen-blur coupling. The blur ramps from 0 at
      // suppression=0.5 to 1.5px at suppression=1.0. Skipped if the post-proc
      // pipeline doesn't expose setBlur (older integrations).
      const blurT = s < 0.5 ? 0 : (s - 0.5) / 0.5;
      const blurPx = blurT * 1.5;
      const ppBlur = (pp as unknown as { setBlur?: (px: number) => void }).setBlur;
      if (ppBlur) ppBlur(blurPx);
    }

    // Prompt #53 — decay per-enemy suppression. Same exponential rate as the
    // player's (Section D #1972 — 0.5/s) so a full suppression bar (1.0)
    // decays to ~5% in 3s. The FSM's recoveryThreshold (default 0.2) is
    // crossed after ~2.3s — that's the effective "pin duration" once the
    // player stops suppressing.
    // Skip dead enemies (no point decaying a dead man's suppression).
    const enemies = ctx.enemies;
    const ENEMY_DECAY_PER_SEC = 0.5;
    const enemyDecayFactor = Math.pow(1 - ENEMY_DECAY_PER_SEC, dt);
    for (let i = 0, n = enemies.length; i < n; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      if (e.suppression !== undefined && e.suppression > 0) {
        e.suppression = e.suppression * enemyDecayFactor;
        // Clamp at 0 so the field doesn't hold a tiny float residue forever.
        if (e.suppression < 1e-4) e.suppression = 0;
        // Section D #520 — panic animation flag. Set when suppression > 0.8
        // (panic threshold); cleared when it drops below 0.4. The animation
        // system reads e.panic to play a flinch.
        const ex = e as unknown as { panic?: boolean };
        if (e.suppression > 0.8) ex.panic = true;
        else if (e.suppression < 0.4) ex.panic = false;
      }
    }
  }

  /** Add suppression from a near-miss or explosion (player's suppression). */
  addSuppression(amount: number) {
    this.ctx.suppression.value = Math.min(1, this.ctx.suppression.value + amount);
  }

  /**
   * Section D #522 — Apply friendly (enemy→player) suppression. Called by
   * the AI when laying down suppressive fire (MG suppressiveLane) — even
   * without a near-miss, sustained fire in the player's direction applies
   * a trickle of suppression (the bullets aren't hitting but the player
   * hears them + feels pinned). `intensity` is 0..1; the actual suppression
   * added is intensity * 0.04 (so a 5s burst at intensity 1.0 adds ~0.2
   * suppression — enough to blur the screen but not enough to fully pin).
   */
  applyFriendlySuppression(intensity: number) {
    const amount = Math.max(0, Math.min(1, intensity)) * 0.04;
    this.ctx.suppression.value = Math.min(1, this.ctx.suppression.value + amount);
  }

  /**
   * Section D #523 — Get the player's current accuracy penalty from
   * suppression. Returns 0..0.5 (0 = no penalty at suppression=0, 0.5 =
   * half accuracy at suppression=1). WeaponSystem multiplies the weapon's
   * base accuracy by (1 - penalty).
   */
  getPlayerAccuracyPenalty(): number {
    // Linear ramp from 0 (suppression=0) to 0.5 (suppression=1).
    return Math.max(0, Math.min(0.5, this.ctx.suppression.value * 0.5));
  }

  /**
   * Prompt #53 — Add suppression to a specific enemy. Called by
   * ProjectileSystem when a player projectile passes within ~2m of the enemy
   * (a near-miss). Each pass adds ~0.15 — a sustained burst of 4-5 bullets
   * near an enemy pushes them past the 0.6 suppressionThreshold and triggers
   * the SUPPRESSED FSM state (duck behind cover, peek, blind-fire).
   *
   * Clamped to [0, 1]. No-op if the enemy is dead.
   *
   * Section D #521 — snap-to-cover. On the rising edge across the suppression
   * threshold (0.6 default), the system sets `e.snapToCover = true` so the
   * tickSuppressed behavior knows to skip the slow cover-search path + snap
   * directly to the nearest cover.
   *
   * Section D #1781 — distance falloff. The `amount` is scaled by the bullet's
   * distance to the enemy (closer = more suppression). The caller passes the
   * bullet's closest-approach distance; the system applies a linear falloff
   * from 1.0 at 0m to 0.0 at FALLOFF_DIST. Without this, a bullet whizzing
   * 5m past an enemy applied the same suppression as one grazing their helmet
   * — the AI snapped to cover from across the room, which felt unfair.
   */
  addEnemySuppression(e: Enemy, amount: number, bulletDistToEnemy?: number) {
    if (!e.alive) return;
    // Section D #1781 — distance falloff. Scale the amount by the bullet's
    // closest-approach distance (0m = full, FALLOFF_DIST = 0). If the caller
    // doesn't pass a distance, apply the full amount (preserves the prior
    // contract for callers that don't compute distance).
    const FALLOFF_DIST = 3; // 3m max suppression radius
    let scaledAmount = amount;
    if (bulletDistToEnemy !== undefined) {
      const falloff = Math.max(0, 1 - bulletDistToEnemy / FALLOFF_DIST);
      scaledAmount = amount * falloff;
    }
    const cur = e.suppression ?? 0;
    const next = Math.min(1, Math.max(0, cur + scaledAmount));
    // Section D #521 — rising-edge snap-to-cover flag.
    const ex = e as unknown as { snapToCover?: boolean; _prevSupp?: number };
    const prev = ex._prevSupp ?? 0;
    // Default threshold is 0.6; read the per-enemy threshold if set.
    const threshold = (e as unknown as { suppressionThreshold?: number }).suppressionThreshold ?? 0.6;
    if (prev < threshold && next >= threshold) {
      ex.snapToCover = true;
    }
    ex._prevSupp = next;
    e.suppression = next;
  }

  /**
   * Section D #1780 — friendly suppression. Enemies suppress each other when
   * one enemy's bullet passes near another enemy (friendly-fire suppression).
   * The amount is reduced by FRIENDLY_SUPPRESSION_MULT (0.5× — friendly fire
   * is less suppressive than enemy fire because the target knows their
   * teammate is behind them, not a hostile). The caller (ProjectileSystem)
   * passes the source enemy so the system can skip self-suppression (an
   * enemy's own bullet doesn't suppress them).
   *
   * The distance falloff (#1781) applies via the shared addEnemySuppression
   * helper — this method just multiplies by the friendly-fire factor + skips
   * self-suppression.
   */
  addFriendlyEnemySuppression(target: Enemy, source: Enemy, amount: number, bulletDistToTarget?: number) {
    if (target === source) return; // no self-suppression
    if (!target.alive || !source.alive) return;
    const FRIENDLY_SUPPRESSION_MULT = 0.5;
    this.addEnemySuppression(target, amount * FRIENDLY_SUPPRESSION_MULT, bulletDistToTarget);
  }

  /**
   * Section D #521 — Clear the snap-to-cover flag. Called by tickSuppressed
   * after the enemy has snapped to cover (so the flag doesn't re-trigger).
   */
  clearSnapToCover(e: Enemy) {
    const ex = e as unknown as { snapToCover?: boolean };
    ex.snapToCover = false;
  }
}
