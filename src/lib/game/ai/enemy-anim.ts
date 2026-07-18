/**
 * SEC6-AI prompt 51 — Enemy combat animation (hit-react blending layer).
 *
 * Until real skeletal rigs land (prompt 32), this is a procedural stand-in
 * that triggers a visible flinch/stagger on the enemy mesh when damaged:
 *   - Scale dip (squash): the enemy visibly "compresses" along the damage
 *     axis for ~150ms.
 *   - Rotation lerp: the enemy's group.rotation pitches/yaws toward the
 *     damage direction (knock-back feel).
 *   - Severity scales the magnitude: light hit = 0.06 scale dip + 0.1 rad,
 *     heavy hit / headshot = 0.18 scale dip + 0.3 rad + longer recovery.
 *
 * This is the BRIDGE that prompt 32 (real rigs) will later drive with
 * skeletal clips — same `triggerHitReact(enemy, dir, severity)` entry
 * point, just swap the internal implementation to drive an
 * `AnimationAction` blend tree instead of mesh transforms.
 *
 * Per-enemy hit-react state is stashed via cast (avoid touching the shared
 * Enemy interface). The integrator (EnemySystem.damageEnemy) calls
 * `triggerHitReact(e, dir, severity)` after applying damage, then
 * `updateHitReacts(ctx, dt)` once per frame to integrate active reacts.
 *
 * SSR-safe: Three is imported but only used inside methods (no top-level
 * vector allocation). Deterministic given inputs.
 */
import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/** Damage direction (world-space, normalized) — the direction the damage
 *  traveled FROM (i.e. toward the enemy). The enemy leans AWAY from this. */
export type HitReactDir = THREE.Vector3;

/** Severity buckets — drive magnitude + recovery time. */
export type HitReactSeverity = "light" | "medium" | "heavy" | "headshot";

interface HitReactState {
  /** True while a hit-react is actively animating. */
  active: boolean;
  /** Elapsed time in the react (seconds). */
  elapsed: number;
  /** Total duration of the react (seconds). */
  duration: number;
  /** Damage direction (world-space, normalized). */
  dirX: number;
  dirZ: number;
  /** Peak magnitude (radians of rotation, scale-dip depth). */
  magnitude: number;
  /** Peak scale-dip (e.g. 0.06 = 6% smaller along the damage axis). */
  squashDepth: number;
  /** Original scale (saved on activation, restored on completion). */
  origScaleX: number;
  origScaleY: number;
  origScaleZ: number;
  /** Original rotation (saved on activation, restored on completion). */
  origRotX: number;
  origRotY: number;
  /** Prompt A#71 — per-enemy retrigger cooldown (seconds). Decremented in
   *  updateHitReacts; while > 0, equal-or-weaker hits are skipped so
   *  back-to-back same-severity hits don't snap the enemy back to peak.
   *  The previous `hasFired` field (removed by Prompt A#74) was a dead
   *  no-op that never gated anything. */
  cooldown: number;
}

/** Per-enemy stash (cast onto the Enemy). */
interface EnemyAnimExtra {
  __hitReact?: HitReactState;
}

function ex(e: Enemy): EnemyAnimExtra {
  return e as unknown as EnemyAnimExtra;
}

// ───────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────

const SEVERITY_PARAMS: Record<HitReactSeverity, {
  duration: number;
  magnitude: number;
  squash: number;
}> = {
  light:    { duration: 0.12, magnitude: 0.10, squash: 0.06 },
  medium:   { duration: 0.18, magnitude: 0.18, squash: 0.10 },
  heavy:    { duration: 0.28, magnitude: 0.30, squash: 0.18 },
  headshot: { duration: 0.36, magnitude: 0.42, squash: 0.22 },
};

// Prompt A#71 — per-enemy retrigger cooldown. Equal-or-weaker hits within
// this window after the previous trigger are skipped (prevents snap-back).
const HIT_REACT_COOLDOWN_S = 0.15;

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

/**
 * Trigger a hit-react on the enemy. Idempotent — calling while a react is
 * already active RE-TRIGGERS it with the new (presumably stronger) params
 * if the new severity is heavier; otherwise the existing react continues.
 *
 * @param enemy The enemy to animate.
 * @param dir   World-space direction the damage traveled (FROM the source
 *              TOWARD the enemy). Normalized internally.
 * @param severity Severity bucket (drives magnitude + duration).
 */
export function triggerHitReact(
  enemy: Enemy,
  dir: HitReactDir,
  severity: HitReactSeverity,
) {
  if (!enemy || !enemy.alive) return;
  const st = ensureState(enemy);
  const params = SEVERITY_PARAMS[severity];

  // Prompt A#71 — was `params.magnitude < st.magnitude` which is false for
  // equal severity, so two medium hits in 200ms re-triggered from t=0
  // mid-recovery. Now: `<=` skips equal-or-weaker while active. A per-enemy
  // cooldown (decremented in updateHitReacts) also prevents back-to-back
  // equal-severity triggers from snapping the enemy back to peak.
  if (st.active && params.magnitude <= st.magnitude) return;
  if (st.cooldown > 0) return;
  st.cooldown = HIT_REACT_COOLDOWN_S;

  // Normalize direction (use only XZ plane — pitch is approximated via
  // the body's existing lookAtTarget).
  let dx = dir.x, dz = dir.z;
  const len = Math.hypot(dx, dz);
  if (len > 0.0001) { dx /= len; dz /= len; } else { dx = 0; dz = 1; }

  // Save original transforms (only if not currently mid-react — otherwise
  // we'd save the partially-animated state).
  if (!st.active) {
    st.origScaleX = enemy.group.scale.x;
    st.origScaleY = enemy.group.scale.y;
    st.origScaleZ = enemy.group.scale.z;
    st.origRotX = enemy.group.rotation.x;
    st.origRotY = enemy.group.rotation.y;
  }

  st.active = true;
  st.elapsed = 0;
  st.duration = params.duration;
  st.dirX = dx;
  st.dirZ = dz;
  st.magnitude = params.magnitude;
  st.squashDepth = params.squash;
}

/**
 * Update all active hit-reacts. Call once per frame from EnemySystem.update
 * (or a dedicated AISystem.update). Integrates the active reacts toward
 * their peak (first half) and back to rest (second half).
 *
 * @param ctx  GameContext (used to iterate ctx.enemies).
 * @param dt   Delta seconds (clamped to 0.05 by the engine).
 */
export function updateHitReacts(ctx: GameContext, dt: number) {
  for (const e of ctx.enemies) {
    if (!e.alive) continue;
    const st = ex(e).__hitReact;
    if (!st || !st.active) continue;

    st.elapsed += dt;
    const t = st.elapsed / st.duration; // 0..1
    if (t >= 1) {
      // Restore original transforms.
      e.group.scale.set(st.origScaleX, st.origScaleY, st.origScaleZ);
      e.group.rotation.x = st.origRotX;
      e.group.rotation.y = st.origRotY;
      st.active = false;
      continue;
    }

    // Prompt A#72 — fast-attack / slow-decay envelope. The previous bell
    // `Math.sin(t * π)` peaked at t=0.5 (windup == recovery), but real
    // hit-reacts snap FAST then recover SLOWLY. New envelope peaks at
    // t=0.2: smooth sin attack over [0, 0.2], smooth cos decay over
    // [0.2, 1]. Peak value = 1 at t=0.2; 0 at t=0 and t=1.
    const ATTACK_END = 0.2;
    const env = t < ATTACK_END
      ? Math.sin((t / ATTACK_END) * (Math.PI / 2))
      : Math.cos(((t - ATTACK_END) / (1 - ATTACK_END)) * (Math.PI / 2));
    const mag = st.magnitude * env;
    const squash = st.squashDepth * env;

    // Prompt A#71 — decrement the retrigger cooldown.
    if (st.cooldown > 0) st.cooldown = Math.max(0, st.cooldown - dt);

    // Rotation: pitch back (away from damage source) + slight yaw twist.
    // The damage direction is the direction TOWARD the enemy from the
    // source — lean the enemy backward along that axis (negative pitch =
    // chest up = backward lean). Plus a yaw twist proportional to the
    // lateral component of the damage direction.
    e.group.rotation.x = st.origRotX - mag * 0.6; // pitch back
    // Lateral twist: if damage came from the right (dx>0), twist yaw right.
    e.group.rotation.y = st.origRotY + mag * 0.3 * st.dirX;

    // Scale dip: compress along the damage axis (X if dx dominates, Z if
    // dz dominates). We do a simple average — both axes dip slightly.
    // Also do a small Y-axis stretch (the "squash & stretch" principle —
    // when compressed horizontally, stretch vertically).
    // Prompt A#73 — volume-conserving squash & stretch. The previous code
    // used `yStretch = 1 + squash * 0.5` independently of xDip/zDip, so a
    // headshot (squash=0.22) lost ~21% of volume (0.78·1.11·0.78 ≈ 0.676).
    // Now: yStretch is derived so xDip · yStretch · zDip = 1 (volume preserved).
    const xDip = 1 - squash * Math.abs(st.dirX);
    const zDip = 1 - squash * Math.abs(st.dirZ);
    const yStretch = (xDip > 1e-6 && zDip > 1e-6) ? 1 / (xDip * zDip) : 1;
    e.group.scale.set(
      st.origScaleX * xDip,
      st.origScaleY * yStretch,
      st.origScaleZ * zDip,
    );
  }
}

/** Returns true if the enemy is currently in an active hit-react. */
export function isHitReactActive(enemy: Enemy): boolean {
  const st = ex(enemy).__hitReact;
  return !!st && st.active;
}

/**
 * Compute a severity bucket from raw damage + headshot flag. Used by the
 * integrator (EnemySystem.damageEnemy) so it doesn't have to guess.
 *
 *   - headshot         → "headshot"
 *   - dmg >= 50        → "heavy"
 *   - dmg >= 20        → "medium"
 *   - else             → "light"
 */
export function severityFromDamage(dmg: number, headshot: boolean): HitReactSeverity {
  if (headshot) return "headshot";
  if (dmg >= 50) return "heavy";
  if (dmg >= 20) return "medium";
  return "light";
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────────

function ensureState(e: Enemy): HitReactState {
  const exSt = ex(e);
  if (!exSt.__hitReact) {
    exSt.__hitReact = {
      active: false,
      elapsed: 0,
      duration: 0,
      dirX: 0,
      dirZ: 1,
      magnitude: 0,
      squashDepth: 0,
      origScaleX: 1, origScaleY: 1, origScaleZ: 1,
      origRotX: 0, origRotY: 0,
      cooldown: 0,
    };
  }
  return exSt.__hitReact;
}
