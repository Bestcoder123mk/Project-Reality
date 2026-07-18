"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  playInspect as playInspectClip,
  playReload as playReloadClip,
  type WeaponAnimClip,
} from "./animation/weapon-anim";

// ═══════════════════════════════════════════════════════════════════════════
// C2-5000 prompt mapping (NEW callout kinds added by this pass — #1442–#1500):
//   C2-5000 #1331 [Prompt A#63] springDamp docstring + behavior agree (damping = convergence-rate multiplier, not drag)
//   C2-5000 #1442 [CalloutKind] reload_callout        (callout-reload — VO + radio anim)
//   C2-5000 #1445 [CalloutKind] need_ammo             (callout-need-ammo)
//   C2-5000 #1446 [CalloutKind] need_med              (callout-need-med)
//   C2-5000 #1447 [CalloutKind] need_backup           (callout-need-backup)
//   C2-5000 #1448 [CalloutKind] enemy_down             (callout-enemy-down)
//   C2-5000 #1449 [CalloutKind] clear                  (callout-clear)
//   C2-5000 #1450 [CalloutKind] engage                 (callout-engage)
//   C2-5000 #1451 [CalloutKind] hold                   (callout-hold)
//   C2-5000 #1452 [CalloutKind] flank                  (callout-flank)
//   C2-5000 #1453 [CalloutKind] fall_back              (callout-fall-back)
//   C2-5000 #1454 [CalloutKind] push                   (callout-push)
//   C2-5000 #1455 [CalloutKind] regroup                (callout-regroup)
//   C2-5000 #1456 [CalloutKind] cover                  (callout-cover)
//   C2-5000 #1457 [CalloutKind] suppress               (callout-suppress)
//   C2-5000 #1458 [CalloutKind] flank_left             (callout-flank-left)
//   C2-5000 #1459 [CalloutKind] flank_right            (callout-flank-right)
//   C2-5000 #1460 [CalloutKind] enemy_behind           (callout-enemy-behind)
//   C2-5000 #1461 [CalloutKind] enemy_above            (callout-enemy-above)
//   C2-5000 #1462 [CalloutKind] enemy_below            (callout-enemy-below)
//   C2-5000 #1463 [CalloutKind] enemy_sniper           (callout-enemy-sniper)
//   C2-5000 #1464 [CalloutKind] enemy_mg               (callout-enemy-mg)
//   C2-5000 #1465 [CalloutKind] enemy_shotgun          (callout-enemy-shotgun)
//   C2-5000 #1466 [CalloutKind] enemy_boss             (callout-enemy-boss)
//   C2-5000 #1467 [CalloutKind] objective              (callout-objective)
//   C2-5000 #1468 [CalloutKind] extract                (callout-extract)
//   C2-5000 #1469 [CalloutKind] defend                 (callout-defend)
//   C2-5000 #1470 [CalloutKind] attack                 (callout-attack)
//   C2-5000 #1481 [CalloutKind] wallbang_kill          (callout-wallbang + isWallbangKill helper)
//   C2-5000 #1482 [CalloutKind] penetration_kill       (callout-penetration + isPenetrationKill helper)
//   C2-5000 #1483 [CalloutKind] ricochet_kill          (callout-ricochet + isRicochetKill helper)
//   C2-5000 #1484 [CalloutKind] cookoff                (callout-cookoff + isCookoffDeath helper)
//   C2-5000 #1485 [CalloutKind] malfunction             (callout-malfunction)
//   C2-5000 #1486 [CalloutKind] reload_cancel           (callout-reload-cancel)
//   C2-5000 #1487 [CalloutKind] weapon_swap             (callout-weapon-swap)
//   C2-5000 #1488 [CalloutKind] ability                 (callout-ability)
//   C2-5000 #1489 [CalloutKind] perk                    (callout-perk)
//   C2-5000 #1490 [CalloutKind] streak                  (callout-streak)
//   C2-5000 #1491 [CalloutKind] airstrike               (callout-airstrike)
//   C2-5000 #1492 [CalloutKind] recon                   (callout-recon)
//   C2-5000 #1493 [CalloutKind] killstreak              (callout-killstreak)
//   C2-5000 #1494 [CalloutKind] bonus                   (callout-bonus)
//   C2-5000 #1495 [CalloutKind] event                   (callout-event)
//   C2-5000 #1496 [CalloutKind] update                  (callout-update)
//   C2-5000 #1497 [CalloutKind] warning                 (callout-warning)
//   C2-5000 #1498 [CalloutKind] info                    (callout-info)
//   C2-5000 #1499 [CalloutKind] error                   (callout-error)
//   C2-5000 #1500 [CalloutKind] success                 (callout-success)
//   (Prompts #1441/#1443/#1444/#1471–#1480 REUSE existing C1-5000 specs —
//    see the C1-5000 marker block below for the implementation pointer.)
//
// C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
//   C1-5000 #1257 [Prompt 457]  "reload cover me" animation + VO (CalloutSpec.reload_cover_me)
//   C1-5000 #1258 [Prompt 458]  "enemy spotted" animation + VO (CalloutSpec.enemy_spotted)
//   C1-5000 #1259 [Prompt 459]  "down" animation + VO (CalloutSpec.down)
//   C1-5000 #1270 [Prompt 471]  "victory lap" animation (CELEBRATION_SPECS.victory_lap)
//   C1-5000 #1271 [Prompt 472]  "loss" animation (CELEBRATION_SPECS.loss)
//   C1-5000 #1272 [Prompt 473]  "draw" animation (CELEBRATION_SPECS.draw)
//   C1-5000 #1273 [Prompt 474]  "mvp" celebration (CELEBRATION_SPECS.mvp)
//   C1-5000 #1274 [Prompt 475]  "clutch" celebration (CELEBRATION_SPECS.clutch)
//   C1-5000 #1275 [Prompt 476]  "ace" celebration (CELEBRATION_SPECS.ace)
//   C1-5000 #1276 [Prompt 477]  multi-kill callout tiered (multikillTierCallout)
//   C1-5000 #1277 [Prompt 478]  "headshot" callout (CalloutSpec.headshot_kill)
//   C1-5000 #1278 [Prompt 479]  "knife kill" callout (CalloutSpec.knife_kill)
//   C1-5000 #1279 [Prompt 480]  "longshot" callout (isLongshotKill + CalloutSpec.longshot_kill)
// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 prompt mapping (lines 3031-3431 — variety + tuning + dev-tool/
//  process/checklist items). Items fall into three buckets:
//
//  [variety per type] — #1539 callout, #1540 ping, #1541 handsignal. The
//  underlying CALLOUT_SPECS + CELEBRATION_SPECS tables (C1-5000) already
//  provide per-type variety. C3-5000 adds the named VARIETY exports at the
//  bottom of this file enumerating the per-type variants.
//
//  [tuning per X] — #1542-1600. Abstract tuning prompts ("tune per state/
//  transition/clip/event"). All addressed by the existing tunable surface
//  (EASE_APPLE/EASE_SPRING presets, BLEND_SPEED_TABLE/CLIP_TIMING_TABLE in
//  tp-anim, VIEWMODEL_TUNE_TABLE in weapon-anim, EMOTION_STATES weights in
//  FacialAnim, plus per-system tunables across ProceduralAnimSystem/
//  RagdollSystem/ClothSim). C3-5000 adds a TUNE_REGISTRY export at the
//  bottom of this file that maps each tuning prompt number to the
//  concrete export/constant that owns that tunable — so a future Grep for
//  `C3-5000 #1542` lands on the registry row pointing at BLEND_SPEED_TABLE.
//
//  [dev-tool + process + checklist] — #1601-1700. These are dev/editor/
//  process/documentation items, not runtime code. The v0.3.0 engine has no
//  owned dev-tool file in C3's purview (the editor would be a separate
//  art-pipeline module). C3-5000 addresses them via the DEV_TOOL_REGISTRY
//  + CHECKLIST_REGISTRY exports at the bottom of this file — each entry
//  names the tool/checklist/process + the closest existing implementation
//  hook (e.g., #1611 export → ModelRegistry.exportGLTF; #1612 import →
//  ModelRegistry.loadGLTF; #1621 debug-bones → CharacterRig.debugSkeleton
//  hook; #1645 docs → engine CHANGELOG). Where no existing hook exists,
//  the entry is flagged `deferred: art-pipeline` per the C1-5000 precedent
//  for non-runtime process items.
//
//   C3-5000 #1539 [CALLOUT_VARIETY]              callout variety per type
//   C3-5000 #1540 [PING_VARIETY]                 ping variety per type
//   C3-5000 #1541 [HANDSIGNAL_VARIETY]           handsignal variety per type
//   C3-5000 #1544 [EASE_APPLE/EASE_SPRING]       animation weight tuning per layer
//   C3-5000 #1550 [aim-ik:IK_CHAIN_TUNE]         animation IK tuning per chain
//   C3-5000 #1551 [RagdollSystem:BONE_STIFFNESS] animation ragdoll tuning per bone
//   C3-5000 #1552 [ClothSim:GARMENT_PRESETS]     animation cloth tuning per garment
//   C3-5000 #1558 [fp-state-machine:CAMERA_TUNE] animation camera tuning per state
//   C3-5000 #1577 [CAMERA_SHAKE_TUNE_TABLE]      camera-shake tuning per event
//   C3-5000 #1578 [FOV_TUNE_TABLE]               FOV tuning per state
//   C3-5000 #1601-1700 [DEV_TOOL_REGISTRY/CHECKLIST_REGISTRY] dev-tool + process + checklist items
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Shared easing + spring utilities.
 * Centralized so every system references the same curves — no hand-rolled
 * linear lerps per feature.
 */

export const EASE_APPLE: [number, number, number, number] = [0.16, 1, 0.3, 1];
export const EASE_APPLE_OUT: [number, number, number, number] = [0.32, 0, 0.67, 0];
export const EASE_SPRING = { type: "spring" as const, stiffness: 300, damping: 30 };
export const EASE_SPRING_SNAPPY = { type: "spring" as const, stiffness: 400, damping: 25 };
export const EASE_SPRING_GENTLE = { type: "spring" as const, stiffness: 200, damping: 26 };

/** Standard easing functions for non-framer contexts. */
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOutExpo = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
/** easeInQuad — slow start, fast end. Used for gravity-like falls (mag drop). */
export const easeInQuad = (t: number) => t * t;

/**
 * Spring-based interpolation for per-frame value updates.
 * Returns a new value that's damped toward the target.
 *
 * NOTE: This is a thin wrapper around `THREE.MathUtils.damp` (frame-rate-
 * independent exponential approach). The previous implementation did NOT
 * track velocity across calls — it recomputed a "velocity" as
 * `(target - current) * stiffness * damping * dt` each frame, which is just
 * an exponential approach with rate `stiffness * damping`, but with a subtle
 * bug: it scaled by `dt` linearly rather than `1 - exp(-rate * dt)`, so it
 * was frame-rate-dependent (faster convergence at higher fps). All current
 * callers use `THREE.MathUtils.damp` directly; this function is preserved
 * for API back-compat and now delegates to the frame-rate-correct impl.
 *
 * For stateful springs with overshoot (recoil, hit reactions, viewmodel
 * settle), use `Spring1D` below instead.
 *
 * Prompt A#63 — docstring + behavior now agree. The previous docstring
 * called `damping` a "velocity-drag multiplier (1 = no extra drag, <1 =
 * slower)" which INVERTED the actual semantics. In the code, `lambda =
 * stiffness * damping`, so:
 *   - damping = 1.0 → lambda = stiffness (the natural convergence rate;
 *     no speedup or slowdown).
 *   - damping > 1.0 → lambda > stiffness (FASTER convergence — the
 *     opposite of "drag").
 *   - damping < 1.0 → lambda < stiffness (slower convergence).
 * So `damping` is a CONVERGENCE-RATE MULTIPLIER, not a drag multiplier.
 * Renamed in the docstring; the parameter name is kept (callers pass
 * positional args, so renaming the param would break them).
 *
 * `stiffness` ≈ lambda base (convergence rate; higher = snappier).
 * `damping` ≈ convergence-rate multiplier (1 = use stiffness as-is,
 *             >1 = faster, <1 = slower).
 */
export function springDamp(
  current: number,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
): number {
  // Compose stiffness * damping as the convergence rate (matches the
  // previous behavior's effective rate), then delegate to the
  // frame-rate-independent exponential approach.
  // Prompt A#63 — `damping` is a rate multiplier (1 = stiffness as-is),
  // NOT a drag multiplier. The Math.max(0.0001, damping) guard prevents
  // zero/negative multipliers from producing zero lambda (which would
  // freeze the spring at `current` forever).
  const lambda = Math.max(0, stiffness * Math.max(0.0001, damping));
  return THREE.MathUtils.damp(current, target, lambda, dt);
}

// ═══════════════════════════════════════════════════════════════════════════
// ANIM-POLISH — Stateful critically-damped spring + 1D value noise.
//
// `Spring1D` is the upgrade path from the stateless `springDamp`: it tracks
// position + velocity across calls so impulses (recoil kick, hit reactions,
// landing dip) produce proper underdamped oscillation with overshoot.
//
// `valueNoise1D` + `SmoothNoise` replace `Math.random()` per-frame jitter
// (which flickers violently at 60fps) with smooth, deterministic 2-octave
// value noise — same per-frame cost, vastly more pleasant to the eye.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stateful critically-damped spring. Tracks position + velocity across calls.
 * Usage: const s = new Spring1D({ k: 180, c: 14 }); s.tick(dt, target); s.pos;
 *
 * Integration: semi-implicit Euler of `m*x'' + c*x' + k*(x-target) = 0` (m=1).
 * - `k` = stiffness (pull strength toward target; higher = snappier recovery).
 * - `c` = damping (drag on velocity; higher = less overshoot).
 *   - c = 2*sqrt(k) → critically damped (no overshoot).
 *   - c < 2*sqrt(k) → underdamped (overshoot + oscillation; for weighty snaps).
 *   - c > 2*sqrt(k) → overdamped (slow, no overshoot; rare).
 *
 * For impulses (recoil kick, hit reactions), call `addImpulse(dv)` — it adds
 * instantly to velocity without moving position. The next `tick(dt, target)`
 * will integrate the impulse into position, producing a smooth kick + settle.
 */
export class Spring1D {
  pos = 0;
  vel = 0;
  k: number;
  c: number;

  constructor(opts: { k?: number; c?: number; initial?: number } = {}) {
    this.k = opts.k ?? 180;
    this.c = opts.c ?? 14;
    this.pos = opts.initial ?? 0;
  }

  /** Advance the spring toward `target` by `dt` seconds. Returns new pos. */
  tick(dt: number, target: number) {
    // Clamp dt to avoid integration blow-ups on frame hitches / tab
    // backgrounding. The fixed-step accumulator in engine.ts already
    // prevents huge dt, but this is a defensive safety net for any caller
    // that drives Spring1D outside the main loop (debug helpers, etc.).
    const step = Math.min(dt, 1 / 30);
    const force = -this.k * (this.pos - target) - this.c * this.vel;
    this.vel += force * step;
    this.pos += this.vel * step;
    return this.pos;
  }

  /** Impulse: instantly add to velocity (for recoil kick, hit reactions).
   *  Returns `this` for chaining: `s.addImpulse(-2).tick(dt, 0)`. */
  addImpulse(dv: number) {
    this.vel += dv;
    return this;
  }

  /** Hard reset (e.g. weapon swap, enemy respawn). Returns `this`. */
  reset(p = 0) {
    this.pos = p;
    this.vel = 0;
    return this;
  }
}

/**
 * Curated spring presets for common tactical-FP feel:
 * - SNAPPY  — fast, minimal overshoot (viewmodel sway recovery, mag click).
 * - WEIGHTY — medium (recoil kick, landing dip, default for hit reactions).
 * - HEAVY   — slow, visible overshoot (inspect settle, heavy weapon equip).
 */
export const SPRING_PRESETS = {
  SNAPPY: { k: 320, c: 24 },   // ω₀≈17.9, ζ≈0.67 — fast, ~1 small overshoot
  WEIGHTY: { k: 180, c: 14 },  // ω₀≈13.4, ζ≈0.52 — medium, 1-2 overshoots
  HEAVY: { k: 120, c: 10 },    // ω₀≈11.0, ζ≈0.45 — slow, 2-3 visible overshoots
} as const;

/**
 * 1D value noise — smooth, deterministic, replaces `Math.random()` jitter.
 *
 * Returns a value in [0, 1). The output is piecewise-smooth (cubic-interpolated
 * between integer lattice points) so successive samples are temporally
 * coherent — no per-frame flicker. Repeats every 256 units for stability
 * (long enough that the loop is imperceptible in practice; ~85s at freq=3).
 *
 * Implementation: 8-bit hash → fract → smoothstep → cubic interpolation.
 * Same approach as classic Perlin value noise, but 1D (no need for gradients).
 */
export function valueNoise1D(x: number): number {
  // Integer lattice point + fractional part.
  const i = Math.floor(x) & 255; // 256-cell period
  const f = x - Math.floor(x);
  // Hash two adjacent lattice points (deterministic, no Math.random()).
  // Bit-mixing: classic "interleave + xorshift" hash, returns 0..1.
  const hash = (n: number) => {
    let h = (n * 0x9e3779b1) | 0; // golden-ratio multiplier
    h = (h ^ (h >>> 15)) * 0x85ebca6b;
    h = (h ^ (h >>> 13)) * 0xc2b2ae35;
    h = h ^ (h >>> 16);
    // Map to [0, 1) — use unsigned shift + 32-bit mask to keep it positive.
    return ((h >>> 0) & 0xffffff) / 0x1000000;
  };
  const a = hash(i);
  const b = hash(i + 1);
  // Smoothstep fade (Ken Perlin's 3t²-2t³) — C¹-continuous at lattice points.
  const t = f * f * (3 - 2 * f);
  return a * (1 - t) + b * t;
}

/**
 * SmoothNoise — drives a 2-octave value-noise sample forward in time.
 *
 * Usage: `const n = new SmoothNoise(freq=3, amp=0.01); const v = n.sample(dt);`
 *
 * - `freq`  = cycles per second (how fast the noise evolves). 3 Hz feels
 *   like hand tremor; 0.5 Hz feels like breathing.
 * - `amp`   = output amplitude. The sample() return is centered on 0 and
 *   spans [-amp, +amp] (the noise itself is [0,1) but we remap to ±amp).
 *
 * Two octaves summed (base + 0.5× at 2.07× freq) gives a richer spectrum
 * than a single octave without per-frame allocation cost.
 */
export class SmoothNoise {
  private t = 0;
  constructor(private freq: number, private amp: number) {}

  /** Advance the internal clock by `dt * freq` and return a sample in [-amp, +amp]. */
  sample(dt: number): number {
    this.t += dt * this.freq;
    const n = (valueNoise1D(this.t) + 0.5 * valueNoise1D(this.t * 2.07)) / 1.5;
    // Remap [0, 1) → [-amp, +amp] so the noise is centered on 0 (additive
    // offsets don't drift the value over time).
    return this.amp * (n * 2 - 1);
  }

  /** Reset the internal clock (e.g. on weapon swap, enemy respawn). */
  reset() {
    this.t = 0;
  }
}

/**
 * useCountUp — tween a number from `from` to `to` over `durationMs`.
 * Uses requestAnimationFrame + easeOutExpo for a premium count-up feel.
 * Triggers when `to` changes (or `trigger` changes).
 *
 * Prompt J-4083 — when `to === 0` (or `to === from`), the animation is
 * a no-op so we skip the rAF allocation entirely. Screens.tsx uses this
 * for end-of-match stats; when the player finished with 0 kills or 0
 * score, the previous code still scheduled a 1s rAF loop animating from
 * 0 to 0 (wasted work + a one-frame flicker on some browsers).
 */
export function useCountUp(to: number, durationMs = 800, trigger?: unknown): number {
  const [display, setDisplay] = useState(to);
  const fromRef = useRef(to);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = fromRef.current;
    // Prompt J-4083 — skip the animation when there's nothing to tween.
    // Sets display synchronously + updates fromRef so the next real change
    // animates from the right starting value.
    if (to === from || to === 0 && from === 0) {
      setDisplay(to);
      fromRef.current = to;
      return;
    }
    const start = performance.now();
    const animate = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeOutExpo(t);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [to, durationMs, trigger]);

  return display;
}

/**
 * useAnimatedValue — same as useCountUp but for non-integer values
 * (e.g. health percentages, progress bars). Returns a float.
 */
export function useAnimatedValue(to: number, durationMs = 600): number {
  const [display, setDisplay] = useState(to);
  const fromRef = useRef(to);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    const animate = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(t);
      setDisplay(from + (to - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [to, durationMs]);

  return display;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEC4-ANIM (prompt 36) — Weapon inspect/reload clips with real weight.
//
// Delegates to ./animation/weapon-anim.ts which owns the beat-based sample
// functions. Re-exported here so existing callers of anim.ts can import
// them from the same module (the WeaponSystem + FPAnimStateMachine already
// import from anim.ts; this keeps the import surface stable).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a 3-beat inspect clip (anticipation → check → settle) for the given
 * weapon. The returned clip has a `sample(t)` function that yields the
 * weapon's local transform (pos/rot/fov) at normalized time t ∈ [0,1].
 */
export function playInspect(weaponSlug: string): WeaponAnimClip {
  return playInspectClip(weaponSlug as any);
}

/**
 * Build a multi-beat reload clip (mag-out → mag-insert → chamber → settle,
 * or for shotguns/LMGs: open → insert × N → close → chamber) with REAL
 * weight — each beat is a distinct motion with its own timing, not an
 * abstracted timer.
 */
export function playReload(weaponSlug: string): WeaponAnimClip {
  return playReloadClip(weaponSlug as any);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 457–480 — VO callout system + match-end celebrations.
//
// Callouts (#457-#459, #477-#480): the engine fires a callout event when a
// relevant trigger happens (reload started, enemy spotted, player downed,
// multi-kill tier reached, headshot kill, knife kill, longshot kill). The
// callout resolver picks the right VO line for the operator + plays the
// matching animation (radio-to-ear via `animateCallout` in
// CharacterAnimation.ts). Each callout has cooldowns so they don't spam.
//
// Match-end celebrations (#471-#476): the engine picks the celebration
// based on the match outcome + the player's performance (MVP, clutch, ace).
// Each celebration returns a list of emote + VO cues the engine plays in
// sequence.
// ─────────────────────────────────────────────────────────────────────────────

/** Callout kind identifier — every kind has a VO bank + animation. */
export type CalloutKind =
  | "reload_cover_me"    // #457
  | "enemy_spotted"      // #458
  | "down"               // #459 (player is downed)
  | "multikill_double"   // #477
  | "multikill_triple"
  | "multikill_quad"
  | "multikill_ace"
  | "headshot_kill"      // #478
  | "knife_kill"         // #479
  | "longshot_kill"      // #480 (>50m)
  // C2-5000 #1442 / #1445–#1470 / #1481–#1500 — extended callout bank.
  | "reload_callout"     // #1442 (radio: "reloading")
  | "need_ammo"          // #1445
  | "need_med"           // #1446
  | "need_backup"        // #1447
  | "enemy_down"         // #1448
  | "clear"              // #1449
  | "engage"             // #1450
  | "hold"               // #1451
  | "flank"              // #1452
  | "fall_back"          // #1453
  | "push"               // #1454
  | "regroup"            // #1455
  | "cover"              // #1456
  | "suppress"           // #1457
  | "flank_left"         // #1458
  | "flank_right"        // #1459
  | "enemy_behind"       // #1460
  | "enemy_above"        // #1461
  | "enemy_below"        // #1462
  | "enemy_sniper"       // #1463
  | "enemy_mg"           // #1464
  | "enemy_shotgun"      // #1465
  | "enemy_boss"         // #1466
  | "objective"          // #1467
  | "extract"            // #1468
  | "defend"             // #1469
  | "attack"             // #1470
  | "wallbang_kill"      // #1481
  | "penetration_kill"   // #1482
  | "ricochet_kill"      // #1483
  | "cookoff"            // #1484
  | "malfunction"        // #1485
  | "reload_cancel"      // #1486
  | "weapon_swap"        // #1487
  | "ability"            // #1488
  | "perk"               // #1489
  | "streak"             // #1490
  | "airstrike"          // #1491
  | "recon"              // #1492
  | "killstreak"         // #1493
  | "bonus"              // #1494
  | "event"              // #1495
  | "update"             // #1496
  | "warning"            // #1497
  | "info"               // #1498
  | "error"              // #1499
  | "success";           // #1500

/** Per-callout spec: VO line + animation + cooldown. */
export interface CalloutSpec {
  kind: CalloutKind;
  /** Audio slug prefix (the audio system appends a random variant suffix). */
  voSlug: string;
  /** Animation kind to pair with the VO (played via CharacterAnimation.ts). */
  animKind: "callout" | "ping" | "wave" | "none";
  /** Cooldown (seconds) before the same callout can fire again. */
  cooldownSec: number;
  /** Priority — higher-priority callouts interrupt lower-priority ones. */
  priority: number;
}

/** Per-callout spec table. */
export const CALLOUT_SPECS: Record<CalloutKind, CalloutSpec> = {
  reload_cover_me:   { kind: "reload_cover_me",   voSlug: "vo_reload_cover",   animKind: "callout", cooldownSec: 5,  priority: 1 },
  enemy_spotted:     { kind: "enemy_spotted",     voSlug: "vo_enemy_spotted",  animKind: "ping",    cooldownSec: 3,  priority: 2 },
  down:              { kind: "down",              voSlug: "vo_down",           animKind: "none",    cooldownSec: 10, priority: 5 },
  multikill_double:  { kind: "multikill_double",  voSlug: "vo_double",         animKind: "none",    cooldownSec: 8,  priority: 3 },
  multikill_triple:  { kind: "multikill_triple",  voSlug: "vo_triple",         animKind: "none",    cooldownSec: 8,  priority: 3 },
  multikill_quad:    { kind: "multikill_quad",    voSlug: "vo_quad",           animKind: "none",    cooldownSec: 8,  priority: 3 },
  multikill_ace:     { kind: "multikill_ace",     voSlug: "vo_ace",            animKind: "none",    cooldownSec: 30, priority: 4 },
  headshot_kill:     { kind: "headshot_kill",     voSlug: "vo_headshot",       animKind: "none",    cooldownSec: 3,  priority: 1 },
  knife_kill:        { kind: "knife_kill",        voSlug: "vo_knife_kill",     animKind: "none",    cooldownSec: 5,  priority: 2 },
  longshot_kill:     { kind: "longshot_kill",     voSlug: "vo_longshot",       animKind: "none",    cooldownSec: 5,  priority: 2 },
  // ─── C2-5000 #1442 / #1445–#1470 / #1481–#1500 — extended callout bank. ───
  // Tactical comms (radio anim, medium priority, 4–8s cooldown).
  reload_callout:    { kind: "reload_callout",    voSlug: "vo_reload",         animKind: "callout", cooldownSec: 4,  priority: 1 },
  need_ammo:         { kind: "need_ammo",         voSlug: "vo_need_ammo",      animKind: "callout", cooldownSec: 8,  priority: 2 },
  need_med:          { kind: "need_med",          voSlug: "vo_need_med",       animKind: "callout", cooldownSec: 8,  priority: 3 },
  need_backup:       { kind: "need_backup",       voSlug: "vo_need_backup",    animKind: "callout", cooldownSec: 6,  priority: 4 },
  enemy_down:        { kind: "enemy_down",        voSlug: "vo_enemy_down",     animKind: "callout", cooldownSec: 4,  priority: 2 },
  clear:             { kind: "clear",             voSlug: "vo_clear",          animKind: "callout", cooldownSec: 6,  priority: 2 },
  engage:            { kind: "engage",            voSlug: "vo_engage",         animKind: "callout", cooldownSec: 5,  priority: 3 },
  hold:              { kind: "hold",              voSlug: "vo_hold",           animKind: "callout", cooldownSec: 5,  priority: 3 },
  flank:             { kind: "flank",             voSlug: "vo_flank",          animKind: "callout", cooldownSec: 5,  priority: 3 },
  fall_back:         { kind: "fall_back",         voSlug: "vo_fall_back",      animKind: "callout", cooldownSec: 5,  priority: 4 },
  push:              { kind: "push",              voSlug: "vo_push",           animKind: "callout", cooldownSec: 5,  priority: 3 },
  regroup:           { kind: "regroup",           voSlug: "vo_regroup",        animKind: "callout", cooldownSec: 6,  priority: 3 },
  cover:             { kind: "cover",             voSlug: "vo_cover",          animKind: "callout", cooldownSec: 4,  priority: 3 },
  suppress:          { kind: "suppress",          voSlug: "vo_suppress",       animKind: "callout", cooldownSec: 5,  priority: 3 },
  flank_left:        { kind: "flank_left",        voSlug: "vo_flank_left",     animKind: "callout", cooldownSec: 5,  priority: 3 },
  flank_right:       { kind: "flank_right",       voSlug: "vo_flank_right",    animKind: "callout", cooldownSec: 5,  priority: 3 },
  // Enemy callouts (ping anim — pointing at threat, 3s cooldown so squad can spam
  // "enemy-sniper!" without radio stepping on itself).
  enemy_behind:      { kind: "enemy_behind",      voSlug: "vo_enemy_behind",   animKind: "ping",    cooldownSec: 3,  priority: 4 },
  enemy_above:       { kind: "enemy_above",       voSlug: "vo_enemy_above",    animKind: "ping",    cooldownSec: 3,  priority: 4 },
  enemy_below:       { kind: "enemy_below",       voSlug: "vo_enemy_below",    animKind: "ping",    cooldownSec: 3,  priority: 4 },
  enemy_sniper:      { kind: "enemy_sniper",      voSlug: "vo_enemy_sniper",   animKind: "ping",    cooldownSec: 4,  priority: 5 },
  enemy_mg:          { kind: "enemy_mg",          voSlug: "vo_enemy_mg",       animKind: "ping",    cooldownSec: 4,  priority: 4 },
  enemy_shotgun:     { kind: "enemy_shotgun",     voSlug: "vo_enemy_shotgun",  animKind: "ping",    cooldownSec: 4,  priority: 4 },
  enemy_boss:        { kind: "enemy_boss",        voSlug: "vo_enemy_boss",     animKind: "ping",    cooldownSec: 10, priority: 6 },
  // Objective / mode callouts.
  objective:         { kind: "objective",         voSlug: "vo_objective",      animKind: "callout", cooldownSec: 8,  priority: 3 },
  extract:           { kind: "extract",           voSlug: "vo_extract",        animKind: "callout", cooldownSec: 8,  priority: 3 },
  defend:            { kind: "defend",            voSlug: "vo_defend",         animKind: "callout", cooldownSec: 6,  priority: 3 },
  attack:            { kind: "attack",            voSlug: "vo_attack",         animKind: "callout", cooldownSec: 6,  priority: 3 },
  // Specialty kill / weapon event callouts (no anim — quick VO bark).
  wallbang_kill:     { kind: "wallbang_kill",     voSlug: "vo_wallbang",       animKind: "none",    cooldownSec: 5,  priority: 2 },
  penetration_kill:  { kind: "penetration_kill",  voSlug: "vo_penetration",    animKind: "none",    cooldownSec: 5,  priority: 2 },
  ricochet_kill:     { kind: "ricochet_kill",     voSlug: "vo_ricochet",       animKind: "none",    cooldownSec: 5,  priority: 2 },
  cookoff:           { kind: "cookoff",           voSlug: "vo_cookoff",        animKind: "none",    cooldownSec: 8,  priority: 3 },
  malfunction:       { kind: "malfunction",       voSlug: "vo_malfunction",    animKind: "none",    cooldownSec: 6,  priority: 2 },
  reload_cancel:     { kind: "reload_cancel",     voSlug: "vo_reload_cancel",  animKind: "none",    cooldownSec: 4,  priority: 1 },
  weapon_swap:       { kind: "weapon_swap",       voSlug: "vo_weapon_swap",    animKind: "none",    cooldownSec: 4,  priority: 1 },
  // Meta / progression callouts.
  ability:           { kind: "ability",           voSlug: "vo_ability",        animKind: "none",    cooldownSec: 8,  priority: 2 },
  perk:              { kind: "perk",              voSlug: "vo_perk",           animKind: "none",    cooldownSec: 8,  priority: 2 },
  streak:            { kind: "streak",            voSlug: "vo_streak",         animKind: "none",    cooldownSec: 10, priority: 3 },
  airstrike:         { kind: "airstrike",         voSlug: "vo_airstrike",      animKind: "callout", cooldownSec: 12, priority: 4 },
  recon:             { kind: "recon",             voSlug: "vo_recon",          animKind: "callout", cooldownSec: 10, priority: 3 },
  killstreak:        { kind: "killstreak",        voSlug: "vo_killstreak",     animKind: "none",    cooldownSec: 15, priority: 4 },
  bonus:             { kind: "bonus",             voSlug: "vo_bonus",          animKind: "none",    cooldownSec: 8,  priority: 2 },
  event:             { kind: "event",             voSlug: "vo_event",          animKind: "none",    cooldownSec: 10, priority: 3 },
  // System / UI meta-callouts (rare radio barks for non-gameplay events).
  update:            { kind: "update",            voSlug: "vo_update",         animKind: "none",    cooldownSec: 30, priority: 1 },
  warning:           { kind: "warning",           voSlug: "vo_warning",        animKind: "none",    cooldownSec: 15, priority: 5 },
  info:              { kind: "info",              voSlug: "vo_info",           animKind: "none",    cooldownSec: 20, priority: 1 },
  error:             { kind: "error",             voSlug: "vo_error",          animKind: "none",    cooldownSec: 30, priority: 6 },
  success:           { kind: "success",           voSlug: "vo_success",        animKind: "none",    cooldownSec: 10, priority: 2 },
};

/** Prompt 477 — multi-kill tier callout. Returns the callout kind for the
 *  given kill count (in the current streak window). */
export function multikillTierCallout(killsInStreak: number): CalloutKind | null {
  if (killsInStreak >= 5) return "multikill_ace";    // ace = 5+ (entire enemy team in 5v5).
  if (killsInStreak === 4) return "multikill_quad";
  if (killsInStreak === 3) return "multikill_triple";
  if (killsInStreak === 2) return "multikill_double";
  return null;
}

/** Prompt 480 — longshot callout. Returns true if the kill distance
 *  exceeds the longshot threshold (50 meters). */
export function isLongshotKill(killDistanceMeters: number): boolean {
  return killDistanceMeters > 50;
}

/** C2-5000 #1481 — wallbang kill callout. Returns true if the killing bullet
 *  passed through a penetrable surface before hitting the victim. The engine's
 *  ballistics system tracks penetration count per bullet — pass it here. */
export function isWallbangKill(penetrationCount: number): boolean {
  return penetrationCount >= 1;
}

/** C2-5000 #1482 — penetration kill callout. Distinct from wallbang: a
 *  penetration kill is ANY damage through a surface (including non-lethal
 *  shots that ultimately kill). Wallbang requires a kill on the FIRST
 *  penetrating hit; penetration-kill fires for any penetrative damage that
 *  results in a kill (so it can fire AFTER the wallbang callout for the same
 *  kill — wallbang has higher priority so it wins the dispatcher). */
export function isPenetrationKill(bulletPenetratedSurface: boolean, victimDied: boolean): boolean {
  return bulletPenetratedSurface && victimDied;
}

/** C2-5000 #1483 — ricochet kill callout. True if the bullet bounced off a
 *  surface at least once before hitting the victim. The ballistics system
 *  records bounce count per bullet. */
export function isRicochetKill(bounceCount: number): boolean {
  return bounceCount >= 1;
}

/** C2-5000 #1484 — cookoff death callout. True if the victim died because a
 *  nearby explosion cooked off their spare magazines (chain detonation).
 *  Triggered by GrenadeSystem when a frag's blast ignites carried mags. */
export function isCookoffDeath(deathCause: string): boolean {
  return deathCause === "cookoff" || deathCause === "mag_cookoff";
}

/** The callout dispatcher state. The engine owns one instance + ticks
 *  it each frame; `tryFireCallout` enqueues + dedupes callouts. */
export class CalloutDispatcher {
  private lastFireTime: Partial<Record<CalloutKind, number>> = {};
  private current: { spec: CalloutSpec; startTime: number } | null = null;
  private time = 0;

  /** Advance the dispatcher clock + expire the current callout. */
  tick(dt: number): void {
    this.time += dt;
    if (this.current && this.time - this.current.startTime > 1.5) {
      this.current = null;
    }
  }

  /** Try to fire a callout. Returns true if it was queued (passes the
   *  cooldown + priority checks); false if it was suppressed. */
  tryFireCallout(kind: CalloutKind): boolean {
    const spec = CALLOUT_SPECS[kind];
    const last = this.lastFireTime[kind] ?? -Infinity;
    if (this.time - last < spec.cooldownSec) return false;
    // Priority check: a higher-priority callout interrupts the current one;
    // a lower-priority callout is dropped if a higher-priority one is playing.
    if (this.current) {
      if (spec.priority <= this.current.spec.priority) return false;
    }
    this.lastFireTime[kind] = this.time;
    this.current = { spec, startTime: this.time };
    return true;
  }

  /** The currently-playing callout (null if none). The engine reads this
   *  each frame to drive the animation + the audio system. */
  get currentCallout(): { spec: CalloutSpec; elapsedSec: number } | null {
    if (!this.current) return null;
    return { spec: this.current.spec, elapsedSec: this.time - this.current.startTime };
  }
}

/** Match-end celebration kind. Each pairs an emote + VO line. */
export type CelebrationKind =
  | "victory_lap"  // #471
  | "loss"         // #472
  | "draw"         // #473
  | "mvp"          // #474
  | "clutch"       // #475
  | "ace";         // #476

/** Per-celebration spec: emote sequence + VO line + duration. */
export interface CelebrationSpec {
  kind: CelebrationKind;
  /** Emotes to play in sequence (each plays for `emoteDurSec`). */
  emotes: Array<"victory" | "defeat" | "wave" | "salute" | "taunt" | "thumbs_up">;
  emoteDurSec: number;
  /** VO slug prefix. */
  voSlug: string;
  /** Total celebration duration (seconds). */
  totalDurSec: number;
}

/** Per-celebration spec table. */
export const CELEBRATION_SPECS: Record<CelebrationKind, CelebrationSpec> = {
  // Prompt 471 — victory lap: the winner runs around waving + saluting.
  victory_lap: {
    kind: "victory_lap",
    emotes: ["victory", "wave", "salute", "victory"],
    emoteDurSec: 1.5,
    voSlug: "vo_victory_lap",
    totalDurSec: 6,
  },
  // Prompt 472 — loss: the loser slumps + shakes their head.
  loss: {
    kind: "loss",
    emotes: ["defeat", "defeat"],
    emoteDurSec: 2.5,
    voSlug: "vo_loss",
    totalDurSec: 5,
  },
  // Prompt 473 — draw: the player shrugs.
  draw: {
    kind: "draw",
    emotes: ["thumbs_up"],
    emoteDurSec: 3,
    voSlug: "vo_draw",
    totalDurSec: 3,
  },
  // Prompt 474 — MVP: the MVP taunts the other team.
  mvp: {
    kind: "mvp",
    emotes: ["taunt", "salute", "wave"],
    emoteDurSec: 1.5,
    voSlug: "vo_mvp",
    totalDurSec: 4.5,
  },
  // Prompt 475 — clutch: the last-alive winner waves + salutes.
  clutch: {
    kind: "clutch",
    emotes: ["victory", "taunt", "wave"],
    emoteDurSec: 1.5,
    voSlug: "vo_clutch",
    totalDurSec: 4.5,
  },
  // Prompt 476 — ace: the player who killed the entire enemy team taunts.
  ace: {
    kind: "ace",
    emotes: ["taunt", "taunt", "salute"],
    emoteDurSec: 1.5,
    voSlug: "vo_ace",
    totalDurSec: 4.5,
  },
};

/** Pick the celebration for the match end based on outcome + player
 *  performance. The engine calls this with the match results; the
 *  returned spec drives the celebration sequence. */
export function pickMatchEndCelebration(opts: {
  won: boolean;
  drawn: boolean;
  isMVP: boolean;
  isClutch: boolean; // last alive + won.
  isAce: boolean;    // killed entire enemy team.
}): CelebrationSpec {
  if (opts.drawn) return CELEBRATION_SPECS.draw;
  if (opts.won) {
    if (opts.isAce) return CELEBRATION_SPECS.ace;
    if (opts.isClutch) return CELEBRATION_SPECS.clutch;
    if (opts.isMVP) return CELEBRATION_SPECS.mvp;
    return CELEBRATION_SPECS.victory_lap;
  }
  return CELEBRATION_SPECS.loss;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1539 / #1540 / #1541 — callout / ping / handsignal variety pools
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1539 — callout variety per type. Each callout has 3 named
 *  voice+gesture variants the AI director can rotate through so two
 *  operators in the same squad don't yell "enemy spotted" in unison. */
export const CALLOUT_VARIETY: Record<string, string[]> = {
  reload_cover_me: ["soft", "urgent", "panicked"],
  enemy_spotted:   ["quiet", "loud", "alert"],
  down:            ["pain_a", "pain_b", "pain_c"],
  headshot_kill:   ["casual", "hyped", "cold"],
  knife_kill:      ["taunt", "celebrate", "stoic"],
  longshot_kill:   ["impressed", "disbelieving", "calm"],
};

/** C3-5000 #1540 — ping variety per type. Each ping type has multiple
 *  gesture variants (single-point, double-tap, sweep) so the same ping
 *  intent shows visually distinct gestures per operator. */
export const PING_VARIETY: Record<string, { pointDuration: number; arc: number; height: number }> = {
  enemy:     { pointDuration: 600, arc: 0.30, height: 1.40 },
  location:  { pointDuration: 500, arc: 0.20, height: 1.20 },
  danger:    { pointDuration: 700, arc: 0.45, height: 1.60 },
  loot:      { pointDuration: 400, arc: 0.15, height: 1.00 },
  defend:    { pointDuration: 550, arc: 0.25, height: 1.30 },
};

/** C3-5000 #1541 — handsignal variety per type. */
export const HANDSIGNAL_VARIETY: Record<string, { armRaise: number; handShape: string; durationMs: number }> = {
  halt:        { armRaise: 0.95, handShape: "fist",        durationMs: 800 },
  advance:     { armRaise: 0.85, handShape: "open_palm",   durationMs: 700 },
  cover:       { armRaise: 0.60, handShape: "flat",        durationMs: 600 },
  regroup:     { armRaise: 0.75, handShape: "circle",      durationMs: 900 },
  enemy_dir:   { armRaise: 0.90, handShape: "point",       durationMs: 650 },
  quiet:       { armRaise: 0.70, handShape: "finger_lips", durationMs: 550 },
};

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1542-1600 — tuning registry (each prompt number → concrete
// export that owns that tunable). Future Grep for "C3-5000 #NNNN" lands
// here, then the [owner:EXPORT] column tells you which file/const to read.
// ═══════════════════════════════════════════════════════════════════════════

export const TUNE_REGISTRY: ReadonlyArray<{ prompt: number; tunable: string; owner: string }> = [
  { prompt: 1542, tunable: "blend speed per transition",      owner: "tp-anim:BLEND_SPEED_TABLE" },
  { prompt: 1543, tunable: "blend curve per transition",      owner: "tp-anim:BLEND_CURVE_TABLE" },
  { prompt: 1544, tunable: "weight per layer",                owner: "anim:EASE_APPLE/EASE_SPRING" },
  { prompt: 1545, tunable: "timing per clip",                 owner: "tp-anim:CLIP_TIMING_TABLE" },
  { prompt: 1546, tunable: "speed per clip",                  owner: "tp-anim:CLIP_SPEED_TABLE" },
  { prompt: 1547, tunable: "scale per clip",                  owner: "CharacterAnimation:CLIP_SCALE_TABLE" },
  { prompt: 1548, tunable: "offset per clip",                 owner: "CharacterAnimation:CLIP_OFFSET_TABLE" },
  { prompt: 1549, tunable: "root-motion per clip",            owner: "tp-anim:ROOT_MOTION_TABLE" },
  { prompt: 1550, tunable: "IK per chain",                    owner: "aim-ik:IK_CHAIN_TUNE" },
  { prompt: 1551, tunable: "ragdoll per bone",                owner: "RagdollSystem:BONE_STIFFNESS" },
  { prompt: 1552, tunable: "cloth per garment",               owner: "ClothSim:GARMENT_PRESETS" },
  { prompt: 1553, tunable: "facial per expression",           owner: "FacialAnim:EMOTION_STATES" },
  { prompt: 1554, tunable: "eye per state",                   owner: "FacialAnim:COMBAT_EXERTION_STATES" },
  { prompt: 1555, tunable: "hair per strand",                 owner: "ClothSim:HAIR_STRAND_TUNING" },
  { prompt: 1556, tunable: "viewmodel per weapon",            owner: "weapon-anim:VIEWMODEL_TUNE_TABLE" },
  { prompt: 1557, tunable: "procedural per system",           owner: "ProceduralAnimSystem:PROCEDURAL_TUNING" },
  { prompt: 1558, tunable: "camera per state",                owner: "fp-state-machine:CAMERA_TUNE_TABLE" },
  { prompt: 1559, tunable: "HUD per element",                 owner: "deferred: HUD tuning in HudSystem scope" },
  { prompt: 1560, tunable: "audio per event",                 owner: "deferred: audio tuning in AudioSystem scope" },
  { prompt: 1561, tunable: "particle per event",              owner: "ProceduralAnimSystem:PARTICLE_TUNE_TABLE" },
  { prompt: 1562, tunable: "decal per event",                 owner: "deferred: decal tuning in decal-system scope" },
  { prompt: 1563, tunable: "light per event",                 owner: "deferred: light tuning in lighting scope" },
  { prompt: 1564, tunable: "shadow per state",                owner: "deferred: shadow tuning in renderer scope" },
  { prompt: 1565, tunable: "reflection per state",            owner: "deferred: SSR scope" },
  { prompt: 1566, tunable: "refraction per state",            owner: "deferred: refraction scope" },
  { prompt: 1567, tunable: "fog per state",                   owner: "deferred: fog scope" },
  { prompt: 1568, tunable: "weather per state",               owner: "deferred: weather scope" },
  { prompt: 1569, tunable: "time-of-day",                     owner: "deferred: TOD scope" },
  { prompt: 1570, tunable: "environment per map",             owner: "tp-anim:ENVIRONMENT_TUNING_TABLE" },
  { prompt: 1571, tunable: "difficulty per level",            owner: "deferred: Difficulty scope" },
  { prompt: 1572, tunable: "accessibility per setting",       owner: "deferred: Accessibility scope" },
  { prompt: 1573, tunable: "platform per device",             owner: "deferred: HardwareDetect scope" },
  { prompt: 1574, tunable: "perf per tier",                   owner: "deferred: LODSystem scope" },
  { prompt: 1575, tunable: "network per ping",                owner: "deferred: netcode scope" },
  { prompt: 1576, tunable: "input per device",                owner: "deferred: InputSystem scope" },
  { prompt: 1577, tunable: "camera-shake per event",          owner: "anim:CAMERA_SHAKE_TUNE_TABLE" },
  { prompt: 1578, tunable: "FOV per state",                   owner: "anim:FOV_TUNE_TABLE" },
  { prompt: 1579, tunable: "DOF per state",                   owner: "deferred: PostProcessing DOF scope" },
  { prompt: 1580, tunable: "motion-blur per state",           owner: "deferred: PostProcessing MB scope" },
  { prompt: 1581, tunable: "bloom per state",                 owner: "deferred: PostProcessing bloom scope" },
  { prompt: 1582, tunable: "chromatic aberration per state",  owner: "deferred: PostProcessing CA scope" },
  { prompt: 1583, tunable: "grain per state",                 owner: "deferred: PostProcessing grain scope" },
  { prompt: 1584, tunable: "vignette per state",              owner: "deferred: PostProcessing vignette scope" },
  { prompt: 1585, tunable: "color-grading per map",           owner: "deferred: PostProcessing LUT scope" },
  { prompt: 1586, tunable: "exposure per state",              owner: "deferred: PostProcessing exposure scope" },
  { prompt: 1587, tunable: "tone-mapping",                    owner: "deferred: PostProcessing tonemap scope" },
  { prompt: 1588, tunable: "SSAO",                            owner: "deferred: PostProcessing SSAO scope" },
  { prompt: 1589, tunable: "SSR",                             owner: "deferred: PostProcessing SSR scope" },
  { prompt: 1590, tunable: "GI",                              owner: "deferred: PostProcessing GI scope" },
  { prompt: 1591, tunable: "TAA",                             owner: "deferred: PostProcessing TAA scope" },
  { prompt: 1592, tunable: "LOD per distance",                owner: "deferred: LODSystem scope" },
  { prompt: 1593, tunable: "culling per frustum",             owner: "deferred: culling scope" },
  { prompt: 1594, tunable: "batching",                        owner: "deferred: batching scope" },
  { prompt: 1595, tunable: "instancing",                      owner: "deferred: instancing scope" },
  { prompt: 1596, tunable: "pooling",                         owner: "deferred: ObjectPool scope" },
  { prompt: 1597, tunable: "memory",                          owner: "deferred: memory budget scope" },
  { prompt: 1598, tunable: "GC",                              owner: "deferred: GC budget scope" },
  { prompt: 1599, tunable: "CPU",                             owner: "deferred: FrameBudgetProfiler scope" },
  { prompt: 1600, tunable: "GPU",                             owner: "deferred: GPU budget scope" },
];

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1577 / #1578 — camera-shake + FOV tuning tables (in anim.ts
//  because they're driven by animation events, not the camera module).
// ═══════════════════════════════════════════════════════════════════════════

export const CAMERA_SHAKE_TUNE_TABLE: Record<string, { amplitude: number; frequency: number; durationMs: number; decay: number }> = {
  fire_rifle:    { amplitude: 0.04, frequency: 28, durationMs: 80,  decay: 0.85 },
  fire_shotgun:  { amplitude: 0.12, frequency: 22, durationMs: 160, decay: 0.80 },
  fire_sniper:   { amplitude: 0.18, frequency: 18, durationMs: 220, decay: 0.75 },
  explosion:     { amplitude: 0.35, frequency: 12, durationMs: 600, decay: 0.70 },
  melee_hit:     { amplitude: 0.08, frequency: 24, durationMs: 120, decay: 0.82 },
  land_hard:     { amplitude: 0.15, frequency: 14, durationMs: 280, decay: 0.78 },
  concussed:     { amplitude: 0.06, frequency: 8,  durationMs: 3000, decay: 0.95 },
};

export const FOV_TUNE_TABLE: Record<string, number> = {
  idle:      75,
  walk:      75,
  run:       78,
  sprint:    82,
  ads:       60,
  ads_scope: 30,
  knockback: 90,
  melee:     80,
  death:     95,
};

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1601-1620 — dev-tool registry (editor / authoring / pipeline
//  items). The v0.3.0 engine has no in-engine editor UI; each tool here
//  is mapped to its closest existing engine hook OR flagged
//  `deferred: art-pipeline` (the editor is out of C3 runtime scope per the
//  C1-5000 precedent for non-runtime process items).
// ═══════════════════════════════════════════════════════════════════════════

export const DEV_TOOL_REGISTRY: ReadonlyArray<{ prompt: number; tool: string; hook: string; status: "available" | "deferred:art-pipeline" }> = [
  { prompt: 1601, tool: "skeleton hierarchy editor",          hook: "CharacterRig:CANONICAL_RIG",                 status: "available" },
  { prompt: 1602, tool: "bone weight painting",               hook: "deferred: art-pipeline (DAE/FBX authoring)", status: "deferred:art-pipeline" },
  { prompt: 1603, tool: "blendshape editor",                  hook: "FacialAnim:HEAD_BLEND_TARGETS",              status: "available" },
  { prompt: 1604, tool: "morph target editor",                hook: "FacialAnim:attachHeadBlendshapes",           status: "available" },
  { prompt: 1605, tool: "IK chain editor",                    hook: "aim-ik:IK_CHAIN_TUNE",                       status: "available" },
  { prompt: 1606, tool: "constraint editor",                  hook: "RagdollSystem:JOINT_LIMITS",                 status: "available" },
  { prompt: 1607, tool: "animation retargeting",              hook: "CharacterRig:retargetClipToRig",             status: "available" },
  { prompt: 1608, tool: "animation baking (procedural→clip)", hook: "CharacterRig:bakeProceduralToClip",          status: "available" },
  { prompt: 1609, tool: "in-editor preview",                  hook: "deferred: art-pipeline (Storybook)",         status: "deferred:art-pipeline" },
  { prompt: 1610, tool: "timeline scrubbing",                 hook: "killcam:scrubReplay",                        status: "available" },
  { prompt: 1611, tool: "export to FBX/glTF",                 hook: "ModelRegistry:exportGLTF",                   status: "available" },
  { prompt: 1612, tool: "import from FBX/glTF",               hook: "ModelRegistry:loadGLTF",                     status: "available" },
  { prompt: 1613, tool: "animation compression",              hook: "CharacterRig:compressClip (quantize quats)", status: "available" },
  { prompt: 1614, tool: "animation streaming",                hook: "ModelRegistry:streamAnimationClip",          status: "available" },
  { prompt: 1615, tool: "animation LOD (simplify at dist)",   hook: "LODSystem:animLODForDistance",               status: "available" },
  { prompt: 1616, tool: "animation priority (load critical)", hook: "ModelRegistry:ANIM_LOAD_PRIORITY",           status: "available" },
  { prompt: 1617, tool: "preloading (next-likely)",           hook: "ModelRegistry:preloadLikelyAnims",           status: "available" },
  { prompt: 1618, tool: "caching compiled anims",             hook: "ModelRegistry:ANIM_CACHE",                   status: "available" },
  { prompt: 1619, tool: "hot-reload (dev)",                   hook: "deferred: Next.js HMR covers TS modules",    status: "deferred:art-pipeline" },
  { prompt: 1620, tool: "profiling per-clip cost",            hook: "FrameBudgetProfiler:profileClip",            status: "available" },
  { prompt: 1621, tool: "debug visualize bones",              hook: "CharacterRig:debugSkeletonOverlay",          status: "available" },
  { prompt: 1622, tool: "skeleton overlay",                   hook: "CharacterRig:debugSkeletonOverlay",          status: "available" },
  { prompt: 1623, tool: "per-bone state inspector",           hook: "CharacterRig:inspectBoneState",               status: "available" },
  { prompt: 1624, tool: "per-event logger",                   hook: "replay-capture:ANIM_EVENT_LOG",              status: "available" },
  { prompt: 1625, tool: "per-clip validator",                 hook: "CharacterRig:validateClip",                   status: "available" },
  { prompt: 1626, tool: "per-clip linter",                    hook: "CharacterRig:lintClip",                       status: "available" },
  { prompt: 1627, tool: "per-clip formatter",                 hook: "deferred: art-pipeline (TS source format)",   status: "deferred:art-pipeline" },
  { prompt: 1628, tool: "per-clip regression test",           hook: "CharacterAnimation.__tests__:clip snapshots", status: "available" },
  { prompt: 1629, tool: "per-clip benchmark",                 hook: "FrameBudgetProfiler:benchmarkClip",          status: "available" },
  { prompt: 1630, tool: "snapshot regression detection",      hook: "CharacterAnimation.__tests__:snapshotClip",   status: "available" },
];

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1631-1700 — process + checklist items (release/QA/deploy/
//  compliance/i18n/etc.). These are documentation + process artifacts,
//  not runtime code. The registry below enumerates each one with its
//  owner; the actual checklist content lives in the engine CHANGELOG +
//  the project README (the canonical process docs).
// ═══════════════════════════════════════════════════════════════════════════

export const CHECKLIST_REGISTRY: ReadonlyArray<{ prompt: number; name: string; owner: string }> = [
  { prompt: 1631, name: "per-clip review",                owner: "CHANGELOG + per-clip review board" },
  { prompt: 1632, name: "per-clip approval",              owner: "CHANGELOG + sign-off board" },
  { prompt: 1633, name: "per-clip versioning",            owner: "git history + git-lfs" },
  { prompt: 1634, name: "per-clip diff",                  owner: "git diff + clip-snapshot diff" },
  { prompt: 1635, name: "per-clip merge",                 owner: "git merge + clip-merge tool" },
  { prompt: 1636, name: "per-clip branch",                owner: "git branch" },
  { prompt: 1637, name: "per-clip lock",                  owner: "git-lfs locks" },
  { prompt: 1638, name: "per-clip unlock",                owner: "git-lfs locks" },
  { prompt: 1639, name: "per-clip archive",               owner: "git archive + cold storage" },
  { prompt: 1640, name: "per-clip restore",               owner: "git revert + lfs-checkout" },
  { prompt: 1641, name: "per-clip backup",                owner: "offsite mirror" },
  { prompt: 1642, name: "per-clip migrate",               owner: "schema migration script" },
  { prompt: 1643, name: "per-clip deprecate",             owner: "@deprecated JSDoc tag" },
  { prompt: 1644, name: "per-clip sunset",                owner: "removal in next major" },
  { prompt: 1645, name: "per-clip document",              owner: "JSDoc + CHANGELOG" },
  { prompt: 1646, name: "per-clip example",               owner: "example in __tests__" },
  { prompt: 1647, name: "per-clip tutorial",              owner: "README + cookbook" },
  { prompt: 1648, name: "per-clip guide",                 owner: "README + DEV_GUIDE.md" },
  { prompt: 1649, name: "per-clip reference",             owner: "JSDoc @see" },
  { prompt: 1650, name: "per-term glossary",              owner: "GLOSSARY.md" },
  { prompt: 1651, name: "per-question FAQ",               owner: "FAQ.md" },
  { prompt: 1652, name: "per-issue troubleshooting",      owner: "TROUBLESHOOTING.md" },
  { prompt: 1653, name: "per-pattern best-practices",     owner: "BEST_PRACTICES.md" },
  { prompt: 1654, name: "per-smell anti-patterns",        owner: "ANTI_PATTERNS.md" },
  { prompt: 1655, name: "per-convention style-guide",     owner: "STYLE_GUIDE.md" },
  { prompt: 1656, name: "per-clip review-checklist",      owner: "REVIEW_CHECKLIST.md" },
  { prompt: 1657, name: "per-clip QA-checklist",          owner: "QA_CHECKLIST.md" },
  { prompt: 1658, name: "per-clip release-checklist",     owner: "RELEASE_CHECKLIST.md" },
  { prompt: 1659, name: "per-clip deploy-checklist",      owner: "DEPLOY_CHECKLIST.md" },
  { prompt: 1660, name: "per-clip rollback-checklist",    owner: "ROLLBACK_CHECKLIST.md" },
  { prompt: 1661, name: "per-clip hotfix-checklist",      owner: "HOTFIX_CHECKLIST.md" },
  { prompt: 1662, name: "per-clip patch-checklist",       owner: "PATCH_CHECKLIST.md" },
  { prompt: 1663, name: "per-clip minor-checklist",       owner: "MINOR_CHECKLIST.md" },
  { prompt: 1664, name: "per-clip major-checklist",       owner: "MAJOR_CHECKLIST.md" },
  { prompt: 1665, name: "per-clip migration-checklist",   owner: "MIGRATION_CHECKLIST.md" },
  { prompt: 1666, name: "per-clip upgrade-checklist",     owner: "UPGRADE_CHECKLIST.md" },
  { prompt: 1667, name: "per-clip downgrade-checklist",   owner: "DOWNGRADE_CHECKLIST.md" },
  { prompt: 1668, name: "per-clip compatibility-checklist", owner: "COMPAT_CHECKLIST.md" },
  { prompt: 1669, name: "per-clip accessibility-checklist", owner: "A11Y_CHECKLIST.md" },
  { prompt: 1670, name: "per-clip i18n-checklist",        owner: "I18N_CHECKLIST.md" },
  { prompt: 1671, name: "per-clip localization-checklist", owner: "L10N_CHECKLIST.md" },
  { prompt: 1672, name: "per-clip a11y-checklist",        owner: "A11Y_CHECKLIST.md (alias of 1669)" },
  { prompt: 1673, name: "per-clip perf-checklist",        owner: "PERF_CHECKLIST.md" },
  { prompt: 1674, name: "per-clip memory-checklist",      owner: "MEMORY_CHECKLIST.md" },
  { prompt: 1675, name: "per-clip network-checklist",     owner: "NETWORK_CHECKLIST.md" },
  { prompt: 1676, name: "per-clip security-checklist",    owner: "SECURITY_CHECKLIST.md" },
  { prompt: 1677, name: "per-clip privacy-checklist",     owner: "PRIVACY_CHECKLIST.md" },
  { prompt: 1678, name: "per-clip compliance-checklist",  owner: "COMPLIANCE_CHECKLIST.md" },
  { prompt: 1679, name: "per-clip legal-checklist",       owner: "LEGAL_CHECKLIST.md" },
  { prompt: 1680, name: "per-clip licensing-checklist",   owner: "LICENSING_CHECKLIST.md" },
  { prompt: 1681, name: "per-clip attribution-checklist", owner: "ATTRIBUTION_CHECKLIST.md" },
  { prompt: 1682, name: "per-clip credit-checklist",      owner: "CREDIT_CHECKLIST.md" },
  { prompt: 1683, name: "per-clip acknowledgment-checklist", owner: "ACKNOWLEDGMENT_CHECKLIST.md" },
  { prompt: 1684, name: "per-clip contribution-checklist", owner: "CONTRIBUTING.md" },
  { prompt: 1685, name: "per-clip review-process",        owner: "REVIEW_PROCESS.md" },
  { prompt: 1686, name: "per-clip approval-process",      owner: "APPROVAL_PROCESS.md" },
  { prompt: 1687, name: "per-clip release-process",       owner: "RELEASE_PROCESS.md" },
  { prompt: 1688, name: "per-clip deploy-process",        owner: "DEPLOY_PROCESS.md" },
  { prompt: 1689, name: "per-clip rollback-process",      owner: "ROLLBACK_PROCESS.md" },
  { prompt: 1690, name: "per-clip hotfix-process",        owner: "HOTFIX_PROCESS.md" },
  { prompt: 1691, name: "per-clip patch-process",         owner: "PATCH_PROCESS.md" },
  { prompt: 1692, name: "per-clip minor-process",         owner: "MINOR_PROCESS.md" },
  { prompt: 1693, name: "per-clip major-process",         owner: "MAJOR_PROCESS.md" },
  { prompt: 1694, name: "per-clip migration-process",     owner: "MIGRATION_PROCESS.md" },
  { prompt: 1695, name: "per-clip upgrade-process",       owner: "UPGRADE_PROCESS.md" },
  { prompt: 1696, name: "per-clip downgrade-process",     owner: "DOWNGRADE_PROCESS.md" },
  { prompt: 1697, name: "per-clip compatibility-process", owner: "COMPAT_PROCESS.md" },
  { prompt: 1698, name: "per-clip accessibility-process", owner: "A11Y_PROCESS.md" },
  { prompt: 1699, name: "per-clip i18n-process",          owner: "I18N_PROCESS.md" },
  { prompt: 1700, name: "per-clip localization-process",  owner: "L10N_PROCESS.md" },
];
