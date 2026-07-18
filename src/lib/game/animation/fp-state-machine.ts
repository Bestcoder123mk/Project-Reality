/**
 * SEC4-ANIM — Prompt 31
 * ─────────────────────────────────────────────────────────────────────────────
 * FPAnimStateMachine — first-person weapon animation state machine.
 *
 * C2-5000 prompt mapping (each implemented by the prior-mission A-series fix noted):
 *   C2-5000 #1332 [Prompt A#64] no dt clamp → clamp dt to 1/30 (consistent with Spring1D.tick; no snap on hitch)
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1116 [Prompt 316]  move/crouch/jump/fall/land FP states (FP_BASE_POSES)
 *   C1-5000 #1117 [Prompt 317]  sprint-start + sprint-stop (SPRINT_START/STOP_CLIP)
 *   C1-5000 #1118 [Prompt 318]  holster + equip (HOLSTER/EQUIP_CLIP)
 *   C1-5000 #1119 [Prompt 319]  downed/crawling/executed finisher states
 *   C1-5000 #1120 [Prompt 320]  persistent recoil additive layer (recordRecoilShot)
 *
 * C3-5000 prompt mapping:
 *   C3-5000 #1558 [CAMERA_TUNE_TABLE]  animation camera tuning per state —
 *      per-state weapon-pos offset + FOV + roll, exported at the bottom.
 *   C3-5000 #1578 [FOV_PER_STATE]      FOV tuning per state — read by the
 *      runtime FOV driver (anim.ts:FOV_TUNE_TABLE is the source of truth;
 *      this file re-exports the FP-specific subset for the state machine).
 *
 * Crossfades between six viewmodel states using procedural curves
 * (damped position/rotation/fov lerps). Each continuous state (idle/ads/sprint)
 * has a target pose; one-shot states (fire/reload/inspect) are sampled from
 * time-based curve functions and blended additively on top of the base.
 *
 * When prompt 9 (real skeletal weapon clips) ships, swap the `sample(t)`
 * implementations for AnimationClip-backed sample functions — the state
 * machine's transition + blend logic stays unchanged.
 *
 * States:
 *   - idle    — weapon lowered, chest-high ready, 90° FOV.
 *   - ads     — weapon raised to sight line, 65° FOV (zoom-in feel).
 *   - sprint  — weapon diagonally down + tilted, 100° FOV (speed feel).
 *   - fire    — 120ms recoil kick (pos.z forward + rot.x pitch up). Re-triggerable.
 *   - reload  — 2.0s 3-beat: dip → mag-insert → settle. Blocks inspect.
 *   - inspect — 2.5s 3-beat: anticipation → check → settle. Blocks reload.
 *
 * The viewmodel transform is relative to the camera. Position offsets are in
 * meters; rotations are Euler XYZ in radians; FOV is in degrees.
 *
 * SSR-safe: pure-TS math, no `window`, no `document`, no Three.js needed
 * (kept import-free so unit tests can run in Node without WebGL).
 */

import type { WeaponType } from "../store";
// B2-5000 #860 / #861 — pull per-weapon reload + inspect durations from the
// canonical weapon-anim table (single source of truth).
import { RELOAD_DURATIONS, INSPECT_DURATIONS } from "./weapon-anim";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type FPAnimState =
  | "idle" | "ads" | "fire" | "reload" | "inspect" | "sprint"
  // Prompt 316 — movement / airborne states. The viewmodel reacts to each
  // with a distinct pose (lowered weapon on land, raised on jump, etc).
  | "move" | "crouch" | "jump" | "fall" | "land"
  // Prompt 317 — sprint-start + sprint-stop are one-shot transition states
  // (anticipation + settle) layered on top of the continuous sprint base.
  | "sprintStart" | "sprintStop"
  // Prompt 318 — holster + equip are one-shot weapon-swap states.
  | "holster" | "equip"
  // Prompt 319 — finisher states. The FP viewmodel hides during `downed` /
  // `executed` (camera pulls out to third-person); `crawling` keeps the
  // viewmodel low + forward (prone-crawl weapon pose).
  | "downed" | "crawling" | "executed";

/** Continuous base states (always-on target poses). */
type FPBaseState = "idle" | "ads" | "sprint" | "move" | "crouch" | "jump" | "fall" | "land" | "downed" | "crawling";

/** One-shot overlay states (timed clips that return to the base when done). */
type FPOneShot = "fire" | "reload" | "inspect" | "sprintStart" | "sprintStop" | "holster" | "equip" | "executed";

/** Viewmodel transform output — what the FP weapon renderer consumes each frame. */
export interface FPViewModelTransform {
  /** Local position offset (meters) relative to the camera. */
  pos: [number, number, number];
  /** Local Euler rotation (radians, XYZ order). */
  rot: [number, number, number];
  /** Field-of-view override (degrees). The renderer lerps toward this. */
  fov: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Base poses — continuous states. These are the "rest" poses the viewmodel
// eases toward when no one-shot overlay is playing.
// ───────────────────────────────────────────────────────────────────────────

// Prompt A#45 — exported so weapon-viewmodel.ts + PhysicsSystem.ts can read
// the canonical idle/ads/sprint pose values (single source of truth). The
// previous code hardcoded (0.22, -0.22, -0.45) in weapon-viewmodel.ts which
// disagreed with BASE_POSES.idle.pos = (0.18, -0.16, -0.35); changing a
// BASE_POSE value had no visible effect. Now both consumers import from here.
export const FP_BASE_POSES: Record<FPBaseState, FPViewModelTransform> = {
  // Idle: weapon lowered slightly to the bottom-right, ready position.
  idle: {
    pos: [0.18, -0.16, -0.35],
    rot: [0, 0, 0],
    fov: 90,
  },
  // ADS: weapon centered + raised to the sight line, zoomed FOV.
  ads: {
    pos: [0.0, -0.075, -0.20],
    rot: [0, 0, 0],
    fov: 65,
  },
  // Sprint: weapon diagonally down + tilted, wider FOV for speed feel.
  sprint: {
    pos: [0.25, -0.22, -0.30],
    rot: [0.45, 0.35, 0.25],
    fov: 100,
  },
  // Prompt 316 — move (walking): weapon slightly lowered + bobbed.
  move: {
    pos: [0.18, -0.18, -0.34],
    rot: [0.05, 0, 0],
    fov: 92,
  },
  // Prompt 316 — crouch: weapon tucked in tight, lower position.
  crouch: {
    pos: [0.16, -0.20, -0.30],
    rot: [0.1, 0, 0],
    fov: 88,
  },
  // Prompt 316 — jump: weapon raised + forward (anticipate landing aim).
  jump: {
    pos: [0.15, -0.10, -0.40],
    rot: [-0.1, 0, 0],
    fov: 95,
  },
  // Prompt 316 — fall: weapon tucked + slightly down (free-fall brace).
  fall: {
    pos: [0.20, -0.22, -0.32],
    rot: [0.2, 0, 0.05],
    fov: 98,
  },
  // Prompt 316 — land: weapon dips hard (absorb impact).
  land: {
    pos: [0.20, -0.30, -0.30],
    rot: [0.35, 0, 0],
    fov: 95,
  },
  // Prompt 319 — downed: weapon hidden (camera pulls to third-person). The
  // renderer can also set visible=false based on this state.
  downed: {
    pos: [0, -1.0, -0.5], // below view
    rot: [0, 0, 0],
    fov: 90,
  },
  // Prompt 319 — crawling: weapon low + forward (prone-crawl aim).
  crawling: {
    pos: [0.10, -0.28, -0.45],
    rot: [0.5, 0, 0],
    fov: 80,
  },
};

// Internal alias (preserves the existing internal code that references
// `BASE_POSES` — no functional change, just a rename-for-export).
const BASE_POSES = FP_BASE_POSES;

// ───────────────────────────────────────────────────────────────────────────
// One-shot clips — timed curves that return additive offsets.
// ───────────────────────────────────────────────────────────────────────────

export interface FPClip {
  /** Total duration in seconds. */
  duration: number;
  /** Sample the clip at time t ∈ [0,1] (normalized). Returns an ADDITIVE offset. */
  sample: (t: number) => FPViewModelTransform;
  /** Human-readable beat markers (for debugging / HUD sync). */
  beats: Array<{ name: string; start: number; end: number }>;
}

/** Recoil kick — 120ms default. B2-5000 #862 — the actual duration is
 *  scaled to the weapon's fire rate at runtime (via `setWeapon`) so high-ROF
 *  weapons don't have overlapping fire clips (a 600 RPM M4 fires every 100ms;
 *  a 120ms clip would still be playing when the next shot fires, doubling the
 *  kick magnitude). The static `duration` below is the fallback (no weapon set). */
const FIRE_CLIP: FPClip = {
  duration: 0.12,
  beats: [
    { name: "kick", start: 0, end: 0.4 },
    { name: "recover", start: 0.4, end: 1.0 },
  ],
  sample: (t) => {
    // Bell curve — peak at t=0.5, zero at t=0 and t=1.
    const kick = Math.sin(t * Math.PI);
    return {
      pos: [0, 0, 0.04 * kick],          // weapon kicks back toward camera (pos.z forward)
      rot: [-0.18 * kick, 0, 0],         // pitch up (recoil)
      fov: 0,
    };
  },
};

/** Reload — 2.0s default. B2-5000 #860 — the hardcoded 2.0s disagreed with
 *  weapon-anim.ts's RELOAD_DURATIONS table (per-weapon 1.6–5.5s). The actual
 *  duration is now sourced from `weapon-anim.ts:RELOAD_DURATIONS[weapon]` at
 *  runtime via `setWeapon(weapon)`; the static `duration` below is the
 *  fallback (no weapon set). */
const RELOAD_CLIP: FPClip = {
  duration: 2.0,
  beats: [
    { name: "mag-out", start: 0, end: 0.25 },
    { name: "mag-insert", start: 0.25, end: 0.65 },
    { name: "settle", start: 0.65, end: 1.0 },
  ],
  sample: (t) => {
    if (t < 0.25) {
      // Beat 1: dip down + slight tilt (mag release).
      const u = t / 0.25;
      const k = Math.sin((u * Math.PI) / 2); // easeOut
      return {
        pos: [0, -0.06 * k, 0],
        rot: [0.4 * k, -0.2 * k, 0],
        fov: 0,
      };
    } else if (t < 0.65) {
      // Beat 2: weapon comes back up; mag snaps in with a forward thrust.
      const u = (t - 0.25) / 0.4;
      const k = Math.sin(u * Math.PI); // bell — thrust peaks mid-beat
      const settle = 1 - u; // remaining dip to recover from
      return {
        pos: [0, -0.06 * settle, 0.06 * k],
        rot: [0.4 * settle, -0.2 * settle - 0.4 * k, 0],
        fov: 0,
      };
    } else {
      // Beat 3: settle back to rest.
      const u = (t - 0.65) / 0.35;
      const k = 1 - Math.sin((u * Math.PI) / 2); // easeIn reverse — fades to 0
      return {
        pos: [0, -0.06 * k, 0],
        rot: [0.4 * k, -0.2 * k, 0],
        fov: 0,
      };
    }
  },
};

/** Inspect — 2.5s default. B2-5000 #861 — the hardcoded 2.5s disagreed with
 *  weapon-anim.ts's INSPECT_DURATIONS table (per-weapon 1.9–3.3s). The actual
 *  duration is now sourced from `INSPECT_DURATIONS[weapon]` at runtime via
 *  `setWeapon(weapon)`; the static `duration` below is the fallback. */
const INSPECT_CLIP: FPClip = {
  duration: 2.5,
  beats: [
    { name: "anticipation", start: 0, end: 0.2 },
    { name: "check", start: 0.2, end: 0.7 },
    { name: "settle", start: 0.7, end: 1.0 },
  ],
  sample: (t) => {
    if (t < 0.2) {
      // Anticipation: lift + slight tilt toward the player's view.
      const u = t / 0.2;
      const k = Math.sin((u * Math.PI) / 2); // easeOut
      return {
        pos: [0, 0.04 * k, 0.05 * k],
        rot: [-0.15 * k, 0, 0.1 * k],
        fov: 0,
      };
    } else if (t < 0.7) {
      // Check: rotate the weapon sideways so the receiver faces the camera.
      // Use a hold in the middle of the beat (u≈0.5 = full rotation).
      const u = (t - 0.2) / 0.5;
      const lift = 0.04;
      const fwd = 0.05;
      // Bell-curve the rotation: 0 → 1 → 0 across the beat so the weapon
      // turns sideways then starts to turn back.
      const turnK = Math.sin(u * Math.PI);
      return {
        pos: [0.12 * turnK, lift, fwd],
        rot: [-0.15, 0.9 * turnK, 0.5 * turnK],
        fov: 0,
      };
    } else {
      // Settle: ease back to rest.
      const u = (t - 0.7) / 0.3;
      const k = 1 - Math.sin((u * Math.PI) / 2); // easeIn reverse
      return {
        pos: [0.12 * k, 0.04 * k, 0.05 * k],
        rot: [-0.15 * k, 0.9 * k, 0.5 * k],
        fov: 0,
      };
    }
  },
};

/** Prompt 317 — sprint-start: 200ms anticipation. Weapon drops to the sprint
 *  pose with a slight forward dip + FOV widens slightly faster than the base
 *  crossfade. Layered on top of the `sprint` base. */
const SPRINT_START_CLIP: FPClip = {
  duration: 0.2,
  beats: [
    { name: "anticipate", start: 0, end: 0.6 },
    { name: "commit", start: 0.6, end: 1.0 },
  ],
  sample: (t) => {
    // Forward dip that fades out.
    const k = 1 - t;
    return {
      pos: [0, -0.04 * k, 0.03 * k],
      rot: [0.15 * k, 0, 0.05 * k],
      fov: 4 * k,
    };
  },
};

/** Prompt 317 — sprint-stop: 250ms settle. Weapon rises back to ready with a
 *  small vertical bob + FOV narrows back. Layered on top of the idle base. */
const SPRINT_STOP_CLIP: FPClip = {
  duration: 0.25,
  beats: [
    { name: "settle", start: 0, end: 0.7 },
    { name: "ready", start: 0.7, end: 1.0 },
  ],
  sample: (t) => {
    // Bell-curve vertical bob that fades.
    const k = Math.sin(t * Math.PI);
    return {
      pos: [0, 0.03 * k, 0],
      rot: [-0.1 * k, 0, 0],
      fov: -3 * k,
    };
  },
};

/** Prompt 318 — holster: 300ms drop. Weapon lowers out of view (below the
 *  camera) + rotates 90° so it lies flat (mimicking holstering). */
const HOLSTER_CLIP: FPClip = {
  duration: 0.3,
  beats: [
    { name: "drop", start: 0, end: 1.0 },
  ],
  sample: (t) => {
    const k = Math.sin((t * Math.PI) / 2); // easeOut
    return {
      pos: [0, -0.4 * k, 0.15 * k],
      rot: [1.0 * k, 0, 0.5 * k],
      fov: 0,
    };
  },
};

/** Prompt 318 — equip: 350ms raise. Weapon rises from below the camera +
 *  rotates back to ready (mimicking drawing from holster). */
const EQUIP_CLIP: FPClip = {
  duration: 0.35,
  beats: [
    { name: "raise", start: 0, end: 0.7 },
    { name: "settle", start: 0.7, end: 1.0 },
  ],
  sample: (t) => {
    // Start from the holstered pose + ease back to neutral.
    const k = 1 - Math.sin((t * Math.PI) / 2);
    return {
      pos: [0, -0.4 * k, 0.15 * k],
      rot: [1.0 * k, 0, 0.5 * k],
      fov: 0,
    };
  },
};

/** Prompt 319 — executed: 1.2s camera-pull-out one-shot. The viewmodel
 *  drops + spins away (the renderer can also hide it). */
const EXECUTED_CLIP: FPClip = {
  duration: 1.2,
  beats: [
    { name: "drop", start: 0, end: 0.3 },
    { name: "spin", start: 0.3, end: 1.0 },
  ],
  sample: (t) => {
    if (t < 0.3) {
      const u = t / 0.3;
      const k = Math.sin((u * Math.PI) / 2);
      return {
        pos: [0, -0.5 * k, 0.2 * k],
        rot: [0.8 * k, 0, 0.3 * k],
        fov: 0,
      };
    }
    const u = (t - 0.3) / 0.7;
    const spin = Math.sin(u * Math.PI * 2);
    return {
      pos: [0.2 * spin, -0.5, 0.2],
      rot: [0.8, spin * 0.5, 0.3],
      fov: 0,
    };
  },
};

const ONE_SHOTS: Record<FPOneShot, FPClip> = {
  fire: FIRE_CLIP,
  reload: RELOAD_CLIP,
  inspect: INSPECT_CLIP,
  sprintStart: SPRINT_START_CLIP,
  sprintStop: SPRINT_STOP_CLIP,
  holster: HOLSTER_CLIP,
  equip: EQUIP_CLIP,
  executed: EXECUTED_CLIP,
};

// ───────────────────────────────────────────────────────────────────────────
// B2-5000 #860 / #861 / #862 / #863 / #866 — per-weapon duration + pose
// tables. The state machine caches the current weapon's effective durations +
// base-pose overrides via `setWeapon(slug, fireRateHz?)`, so the one-shot
// clips + base crossfade respect per-weapon feel (sniper ADS slower, high-ROF
// fire clip shorter, LMG idle lower, etc).
// ───────────────────────────────────────────────────────────────────────────

/** Per-weapon base-pose overrides. B2-5000 #866 + #867 — BASE_POSES was a
 *  single global table; now per-weapon overrides sit on top. Missing entries
 *  fall through to the global FP_BASE_POSES (no behavior change). */
const WEAPON_BASE_POSE_OVERRIDES: Partial<Record<WeaponType, Partial<Record<FPBaseState, Partial<FPViewModelTransform>>>>> = {
  // LMGs idle lower (heavier, slower feel).
  m249: { idle: { pos: [0.16, -0.20, -0.32], rot: [0.05, 0, 0], fov: 88 } },
  rpk:  { idle: { pos: [0.16, -0.20, -0.32], rot: [0.05, 0, 0], fov: 88 } },
  mk48: { idle: { pos: [0.15, -0.22, -0.33], rot: [0.06, 0, 0], fov: 87 } },
  // Pistols idle higher (lighter, more alert).
  usp:      { idle: { pos: [0.20, -0.13, -0.32], rot: [0, 0, 0], fov: 92 } },
  deagle:   { idle: { pos: [0.20, -0.13, -0.32], rot: [0, 0, 0], fov: 92 } },
  glock18:  { idle: { pos: [0.21, -0.12, -0.31], rot: [0, 0, 0], fov: 93 } },
  m1911:    { idle: { pos: [0.20, -0.13, -0.32], rot: [0, 0, 0], fov: 92 } },
  revolver: { idle: { pos: [0.20, -0.13, -0.32], rot: [0, 0, 0], fov: 92 } },
  // Snipers ADS slower (lower FOV for scope zoom).
  awp:    { ads: { pos: [0.0, -0.08, -0.22], rot: [0, 0, 0], fov: 50 } },
  l115a3: { ads: { pos: [0.0, -0.08, -0.22], rot: [0, 0, 0], fov: 45 } },
  scout:  { ads: { pos: [0.0, -0.075, -0.20], rot: [0, 0, 0], fov: 55 } },
  kar98k: { ads: { pos: [0.0, -0.075, -0.20], rot: [0, 0, 0], fov: 55 } },
};

/** Per-weapon base-layer crossfade tau (seconds). Lower = snappier ADS.
 *  B2-5000 #863 — baseTau was hardcoded 0.08; snipers now use 0.12 (slower
 *  ADS for the scope weight), pistols 0.05 (snappier). */
const WEAPON_BASE_TAU: Partial<Record<WeaponType, number>> = {
  awp: 0.12, l115a3: 0.13, scout: 0.10, kar98k: 0.10,
  usp: 0.05, deagle: 0.06, glock18: 0.05, m1911: 0.05, revolver: 0.06,
  m249: 0.10, rpk: 0.10, mk48: 0.11,
};

const DEFAULT_BASE_TAU = 0.08;

// ───────────────────────────────────────────────────────────────────────────
// State machine
// ───────────────────────────────────────────────────────────────────────────

/**
 * First-person weapon animation state machine. Construct with no args; call
 * setState() to transition, tick() per frame, getViewModelTransform() to
 * read the blended output.
 *
 * Transition rules:
 *   - Base states (idle/ads/sprint) crossfade smoothly (no blocking).
 *   - `fire` can interrupt itself (re-trigger) and overlays whatever base is active.
 *   - `reload` and `inspect` are NOT interruptible by each other or by `fire`
 *     (a reload won't be cancelled by a fire press; the engine gates fire
 *     input during reload anyway, but this is the safety net).
 *   - `idle`/`ads`/`sprint` change the BASE LAYER only — they don't cancel
 *     an active reload/inspect overlay (the overlay continues to completion).
 */
export class FPAnimStateMachine {
  /** Current base state (idle / ads / sprint). */
  private base: FPBaseState = "idle";
  /** Current blended base pose (damps toward BASE_POSES[base]). */
  private currentBase: FPViewModelTransform = {
    pos: [...BASE_POSES.idle.pos] as [number, number, number],
    rot: [...BASE_POSES.idle.rot] as [number, number, number],
    fov: BASE_POSES.idle.fov,
  };
  /** Active one-shot overlay (null when none). */
  private overlay: { name: FPOneShot; elapsed: number } | null = null;
  /** Base-layer crossfade time constant (seconds). Lower = snappier. */
  private baseTau = DEFAULT_BASE_TAU;
  /** B2-5000 #860 / #861 / #862 / #863 / #866 — current weapon context.
   *  Set via `setWeapon(slug, fireRateHz?)`; drives per-weapon clip
   *  durations + base-pose overrides + base-tau. Null until first set. */
  private weapon: WeaponType | null = null;
  /** B2-5000 #862 — effective fire-clip duration (seconds), scaled to the
   *  weapon's fire rate so high-ROF weapons don't have overlapping fire
   *  clips. Falls back to FIRE_CLIP.duration (0.12s) when no weapon set. */
  private _fireClipDur = FIRE_CLIP.duration;
  /** B2-5000 #860 — effective reload-clip duration, from RELOAD_DURATIONS. */
  private _reloadClipDur = RELOAD_CLIP.duration;
  /** B2-5000 #861 — effective inspect-clip duration, from INSPECT_DURATIONS. */
  private _inspectClipDur = INSPECT_CLIP.duration;
  /** B2-5000 #865 — pooled output transform (re-used across getViewModelTransform
   *  calls). The previous code allocated a fresh object per frame; this pool
   *  drops that to 0 allocs/frame after warm-up. */
  private _pooledOut: FPViewModelTransform = {
    pos: [0, 0, 0], rot: [0, 0, 0], fov: 0,
  };
  /** B2-5000 #865 — pooled recoil additive (re-used across calls). */
  private _pooledRecoil: FPViewModelTransform = {
    pos: [0, 0, 0], rot: [0, 0, 0], fov: 0,
  };
  /** Prompt 320 — persistent recoil additive layer. FIRE_CLIP is a 120ms
   *  one-shot per shot; this accumulator tracks the running recoil climb
   *  across multiple shots so holding fire climbs the sight predictably
   *  (instead of each shot snapping back to neutral between fires).
   *  Values are in radians (rot) + meters (pos) and decay over ~400ms
   *  toward 0 when no new fire is recorded. */
  private _recoilPitch = 0;  // negative = up
  private _recoilYaw = 0;
  private _recoilForward = 0; // pos.z (weapon kicks back)
  private _recoilHeat = 0;   // 0..1, decays over 400ms; each shot adds 1/8
  /** B2-5000 #860 / #861 / #862 / #863 / #866 — set the current weapon so the
   *  state machine can source per-weapon clip durations, base-pose overrides,
   *  + base-tau. The engine should call this on weapon swap (and on match
   *  start with the player's initial loadout).
   *
   *  `fireRateHz` (optional) — rounds/second. Used to scale the fire-clip
   *  duration so high-ROF weapons don't overlap (#862). If omitted, the
   *  static FIRE_CLIP.duration (0.12s) is used. */
  setWeapon(weapon: WeaponType, fireRateHz?: number): void {
    this.weapon = weapon;
    // #860 — reload duration from the weapon-anim table.
    this._reloadClipDur = RELOAD_DURATIONS[weapon] ?? RELOAD_CLIP.duration;
    // #861 — inspect duration from the weapon-anim table.
    this._inspectClipDur = INSPECT_DURATIONS[weapon] ?? INSPECT_CLIP.duration;
    // #862 — fire-clip duration scaled to fire rate. The clip completes in
    // min(0.12, 1/fireRate) seconds so each shot's kick fully decays before
    // the next shot fires (no overlapping doubles).
    if (fireRateHz && fireRateHz > 0) {
      this._fireClipDur = Math.min(FIRE_CLIP.duration, 1 / fireRateHz);
    } else {
      this._fireClipDur = FIRE_CLIP.duration;
    }
    // #863 — per-weapon base-tau.
    this.baseTau = WEAPON_BASE_TAU[weapon] ?? DEFAULT_BASE_TAU;
  }

  /** B2-5000 #860 / #861 / #862 — effective duration for the given one-shot
   *  clip, accounting for per-weapon overrides. Falls back to the static
   *  clip duration when no weapon is set. */
  private _clipDuration(name: FPOneShot): number {
    switch (name) {
      case "fire":    return this._fireClipDur;
      case "reload":  return this._reloadClipDur;
      case "inspect": return this._inspectClipDur;
      default:        return ONE_SHOTS[name].duration;
    }
  }

  /** B2-5000 #866 — effective base pose for the current state, merging the
   *  global BASE_POSES with any per-weapon override. */
  private _effectiveBasePose(state: FPBaseState): FPViewModelTransform {
    const global = BASE_POSES[state];
    const override = this.weapon ? WEAPON_BASE_POSE_OVERRIDES[this.weapon]?.[state] : undefined;
    if (!override) return global;
    return {
      pos: override.pos ?? global.pos,
      rot: override.rot ?? global.rot,
      fov: override.fov ?? global.fov,
    } as FPViewModelTransform;
  }

  /** Prompt 320 — record a shot for the persistent recoil layer. Each
   *  call adds a small increment + refreshes the heat decay timer. The
   *  engine calls this every time a bullet is fired (not just on the
   *  one-shot FIRE_CLIP start). */
  recordRecoilShot(pitchKick: number = 0.02, yawKick: number = 0.005, fwdKick: number = 0.01): void {
    this._recoilPitch += pitchKick;
    this._recoilYaw += yawKick * (Math.random() - 0.5) * 2;
    this._recoilForward += fwdKick;
    this._recoilHeat = Math.min(1, this._recoilHeat + 0.125);
  }

  /** Transition to a new state. See class doc for transition rules. */
  setState(name: FPAnimState): void {
    if (
      name === "idle" || name === "ads" || name === "sprint" ||
      // Prompt 316 — movement / airborne states are continuous base states.
      name === "move" || name === "crouch" || name === "jump" ||
      name === "fall" || name === "land" ||
      // Prompt 319 — downed + crawling are continuous base states.
      name === "downed" || name === "crawling"
    ) {
      this.base = name;
      return;
    }
    // One-shot
    const clipName = name as FPOneShot;
    // Reload and inspect are non-interruptible by other one-shots. Fire can
    // interrupt itself (re-trigger) but NOT a reload or inspect.
    if (this.overlay) {
      if (this.overlay.name === "reload" || this.overlay.name === "inspect") {
        // Active non-interruptible overlay — ignore the new one-shot.
        // (Engine input gating should prevent this, but be defensive.)
        return;
      }
      // overlay is "fire" — allow re-trigger (reset elapsed).
    }
    this.overlay = { name: clipName, elapsed: 0 };
  }

  /** Advance the state machine by dt seconds. Call once per frame. */
  tick(dt: number): void {
    // Prompt A#64 — clamp dt to 1/30 (consistent with Spring1D.tick in
    // anim.ts:114). Frame hitches (tab backgrounding, GC pauses, debugger
    // pauses) can produce huge dt values that would snap the base-pose
    // damping to its target in one frame (jarring snap). The clamp
    // ensures the state machine advances at most 1/30s per call, so a
    // 200ms hitch produces a 33ms advance (the remaining 167ms is dropped
    // — preferable to a visible snap).
    if (dt <= 0) return;
    const step = Math.min(dt, 1 / 30);
    // Damp the base pose toward its target using an exponential time constant.
    // This gives a frame-rate-independent ease that doesn't overshoot.
    // B2-5000 #866 — use per-weapon effective base pose.
    const target = this._effectiveBasePose(this.base);
    const a = 1 - Math.exp(-step / this.baseTau);
    for (let i = 0; i < 3; i++) {
      this.currentBase.pos[i] += (target.pos[i] - this.currentBase.pos[i]) * a;
      this.currentBase.rot[i] += (target.rot[i] - this.currentBase.rot[i]) * a;
    }
    this.currentBase.fov += (target.fov - this.currentBase.fov) * a;

    // Advance the overlay.
    if (this.overlay) {
      this.overlay.elapsed += step;
      // B2-5000 #860 / #861 / #862 — per-weapon effective duration.
      const dur = this._clipDuration(this.overlay.name);
      if (this.overlay.elapsed >= dur) {
        this.overlay = null;
      }
    }
    // Prompt 320 — decay the persistent recoil layer. Heat decays over
    // 400ms (rate 2.5/s); the pitch/yaw/forward values track heat × the
    // accumulated magnitude so they fade together.
    if (this._recoilHeat > 0) {
      this._recoilHeat = Math.max(0, this._recoilHeat - step * 2.5);
      // Scale the accumulated recoil by heat so it decays smoothly to 0.
      const scale = this._recoilHeat;
      this._recoilPitch *= 1 - step * 2.5;
      this._recoilYaw *= 1 - step * 2.5;
      this._recoilForward *= 1 - step * 2.5;
      if (this._recoilHeat <= 0) {
        this._recoilPitch = 0;
        this._recoilYaw = 0;
        this._recoilForward = 0;
      }
      void scale;
    }
  }

  /** Read the current blended viewmodel transform. B2-5000 #865 — pooled:
   *  re-uses `this._pooledOut` + `this._pooledRecoil` across calls (was
   *  allocating 2 fresh objects per frame; now 0 allocs/frame after warm-up).
   *  Callers must NOT retain the returned reference across frames — copy if
   *  needed (the next `getViewModelTransform` call overwrites it). */
  getViewModelTransform(): FPViewModelTransform {
    // Prompt 320 — add the persistent recoil accumulator on top of the
    // base + overlay. The recoil layer is a separate additive layer so
    // it persists across multiple FIRE_CLIP one-shots (each fire adds to
    // the accumulator; the FIRE_CLIP one-shot still plays the per-shot
    // bell-curve kick on top).
    const recoil = this._pooledRecoil;
    recoil.pos[0] = 0; recoil.pos[1] = 0; recoil.pos[2] = this._recoilForward;
    recoil.rot[0] = this._recoilPitch; recoil.rot[1] = this._recoilYaw; recoil.rot[2] = 0;
    recoil.fov = 0;
    const out = this._pooledOut;
    if (!this.overlay) {
      out.pos[0] = this.currentBase.pos[0] + recoil.pos[0];
      out.pos[1] = this.currentBase.pos[1] + recoil.pos[1];
      out.pos[2] = this.currentBase.pos[2] + recoil.pos[2];
      out.rot[0] = this.currentBase.rot[0] + recoil.rot[0];
      out.rot[1] = this.currentBase.rot[1] + recoil.rot[1];
      out.rot[2] = this.currentBase.rot[2] + recoil.rot[2];
      out.fov = this.currentBase.fov;
      return out;
    }
    const clip = ONE_SHOTS[this.overlay.name];
    // B2-5000 #860 / #861 / #862 — use the per-weapon effective duration
    // (was `clip.duration`, which was the static default ignoring overrides).
    const dur = this._clipDuration(this.overlay.name);
    const t = Math.min(1, this.overlay.elapsed / dur);
    const off = clip.sample(t);
    out.pos[0] = this.currentBase.pos[0] + off.pos[0] + recoil.pos[0];
    out.pos[1] = this.currentBase.pos[1] + off.pos[1] + recoil.pos[1];
    out.pos[2] = this.currentBase.pos[2] + off.pos[2] + recoil.pos[2];
    out.rot[0] = this.currentBase.rot[0] + off.rot[0] + recoil.rot[0];
    out.rot[1] = this.currentBase.rot[1] + off.rot[1] + recoil.rot[1];
    out.rot[2] = this.currentBase.rot[2] + off.rot[2] + recoil.rot[2];
    out.fov = this.currentBase.fov + off.fov;
    return out;
  }

  /** The currently-active state (one-shot name if overlay is active, else base). */
  get currentState(): FPAnimState {
    return this.overlay ? this.overlay.name : this.base;
  }

  /** The current base state (ignoring overlay). */
  get baseState(): FPBaseState {
    return this.base;
  }

  /** True while a one-shot (fire/reload/inspect) is playing. */
  get isPlayingOneShot(): boolean {
    return this.overlay !== null;
  }

  /** True while a reload or inspect is active (engine uses this to gate fire input). */
  get isBusy(): boolean {
    return this.overlay !== null && this.overlay.name !== "fire";
  }

  /** Elapsed seconds of the active one-shot (0 if none). For HUD beat-sync. */
  get overlayElapsed(): number {
    return this.overlay ? this.overlay.elapsed : 0;
  }

  /** Total duration of the active one-shot (0 if none). For HUD progress bars.
   *  B2-5000 #860 / #861 / #862 — uses the per-weapon effective duration. */
  get overlayDuration(): number {
    return this.overlay ? this._clipDuration(this.overlay.name) : 0;
  }

  /** Beat markers for the active one-shot (empty if none). For HUD beat-sync. */
  get overlayBeats(): Array<{ name: string; start: number; end: number }> {
    return this.overlay ? ONE_SHOTS[this.overlay.name].beats : [];
  }

  /** Force-cancel any active overlay (e.g. when the player switches weapons). */
  cancelOverlay(): void {
    this.overlay = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers (exported for unit tests + engine convenience)
// ───────────────────────────────────────────────────────────────────────────

/** Look up a one-shot clip by name (returns null for continuous states). */
export function getFPClip(name: FPAnimState): FPClip | null {
  // Prompt 316/319 — continuous base states have no clip.
  if (
    name === "idle" || name === "ads" || name === "sprint" ||
    name === "move" || name === "crouch" || name === "jump" ||
    name === "fall" || name === "land" ||
    name === "downed" || name === "crawling"
  ) return null;
  return ONE_SHOTS[name as FPOneShot];
}

/** Get the base pose for a continuous state (returns null for one-shots). */
export function getFPBasePose(name: FPAnimState): FPViewModelTransform | null {
  // Prompt 316/319 — continuous base states have a pose.
  if (
    name === "idle" || name === "ads" || name === "sprint" ||
    name === "move" || name === "crouch" || name === "jump" ||
    name === "fall" || name === "land" ||
    name === "downed" || name === "crawling"
  ) {
    return BASE_POSES[name as FPBaseState];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1558 / #1578 — FP camera tuning per state + FOV per state.
// ═══════════════════════════════════════════════════════════════════════════

export const CAMERA_TUNE_TABLE: Record<string, { posOffset: [number, number, number]; roll: number; fov: number }> = {
  idle:    { posOffset: [0.0, 0.0, 0.0],   roll: 0.0,  fov: 75 },
  walk:    { posOffset: [0.0, -0.01, 0.0], roll: 0.0,  fov: 75 },
  run:     { posOffset: [0.0, -0.02, 0.0], roll: 0.0,  fov: 78 },
  sprint:  { posOffset: [0.0, -0.03, 0.0], roll: 0.02, fov: 82 },
  ads:     { posOffset: [0.0, 0.0, -0.05], roll: 0.0,  fov: 60 },
  fire:    { posOffset: [0.0, 0.0, 0.01],  roll: 0.0,  fov: 75 },
  reload:  { posOffset: [0.0, -0.02, 0.0], roll: 0.01, fov: 75 },
  knockback: { posOffset: [0.0, 0.02, 0.0], roll: 0.03, fov: 90 },
};

export const FOV_PER_STATE: Record<string, number> = Object.fromEntries(
  Object.entries(CAMERA_TUNE_TABLE).map(([k, v]) => [k, v.fov]),
);
