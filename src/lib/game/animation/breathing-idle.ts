/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * BreathingIdle — breathing idle animation for immersive standing (with
 * winded + injured variants).
 *
 * B-prompt mapping:
 *   B-00036 — breathing idle (calm / winded / injured) for boss NPC.
 *   B-00044 — breathing idle for third-person spectator cam.
 *   B-00077 — breathing idle for shark finisher actor.
 *   B-09933 — breathing idle for ragdoll corpse (post-finisher breathing
 *     before full ragdoll takes over).
 *
 * Design:
 *   Three breathing states, each with distinct frequency + amplitude +
 *   per-bone participation:
 *
 *     CALM    — slow, shallow. 12 breaths/min (0.2 Hz). Subtle chest rise
 *               (~5mm), barely-visible shoulder roll, micro head-bob.
 *     WINDED  — fast, deep. 30 breaths/min (0.5 Hz). Pronounced chest
 *               rise (~2cm), shoulders heave, head bobs with each inhale,
 *               arms sway slightly. Triggered after sprinting / melee.
 *     INJURED — irregular, gasping. 18 breaths/min (0.3 Hz) with periodic
 *               sharp catches (a "hitch" every ~4s simulates a broken rib
 *               catching). Body curls forward ~5°, asymmetric shoulder
 *               movement (favoring the wounded side).
 *
 *   The breathing is implemented as a procedural AnimationClip baked at
 *   construction time. The clip drives the rig's Hips/Spine/Spine1/Spine2/
 *   Neck/Head/LeftArm/RightArm bones with low-amplitude sinusoidal motion
 *   layered with per-state micro-twitches. The clip is looped infinitely
 *   on an AnimationMixer.
 *
 *   Crossfading between states (e.g. calm → winded after sprint) is done
 *   via the standard AnimationAction.crossFadeTo mechanism; the host
 *   calls .setState("winded") and the driver handles the crossfade.
 *
 * SSR-safe: pure THREE + TS; no window/document.
 *
 * Public API:
 *   - BREATHING_PARAMS — per-state tuning constants.
 *   - buildBreathingClip(state, opts?) → THREE.AnimationClip (cached).
 *   - class BreathingIdleDriver — owns a mixer + drives the active clip.
 *   - .setState(state, fadeSec?) → crossfade to a new breathing state.
 *   - .tick(dt) → advance.
 *   - .getState() → current state.
 *   - .setIntensity(0..1) → scale the amplitude (e.g. 0 = no breathing
 *     for dead/ragdolled characters; 1 = full breathing).
 *   - .dispose() → release resources.
 */

import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Types + tuning
// ───────────────────────────────────────────────────────────────────────────

export type BreathingState = "calm" | "winded" | "injured";

export interface BreathingParams {
  /** Breaths per minute. */
  breathsPerMin: number;
  /** Chest rise amplitude (meters). */
  chestRiseM: number;
  /** Shoulder roll amplitude (radians). */
  shoulderRollRad: number;
  /** Head bob amplitude (meters). */
  headBobM: number;
  /** Spine pitch amplitude (radians). */
  spinePitchRad: number;
  /** Arm sway amplitude (radians). */
  armSwayRad: number;
  /** Body curl (forward lean) baseline (radians). */
  bodyCurlRad: number;
  /** Asymmetric shoulder bias (-1..1; +1 = right shoulder favored). */
  asymBias: number;
  /** If true, add an irregular "hitch" every ~4s (injured). */
  hitch: boolean;
}

export const BREATHING_PARAMS: Record<BreathingState, BreathingParams> = {
  calm: {
    breathsPerMin: 12,
    chestRiseM: 0.005,
    shoulderRollRad: 0.01,
    headBobM: 0.002,
    spinePitchRad: 0.005,
    armSwayRad: 0.005,
    bodyCurlRad: 0,
    asymBias: 0,
    hitch: false,
  },
  winded: {
    breathsPerMin: 30,
    chestRiseM: 0.02,
    shoulderRollRad: 0.05,
    headBobM: 0.008,
    spinePitchRad: 0.02,
    armSwayRad: 0.04,
    bodyCurlRad: 0.03,
    asymBias: 0,
    hitch: false,
  },
  injured: {
    breathsPerMin: 18,
    chestRiseM: 0.012,
    shoulderRollRad: 0.03,
    headBobM: 0.005,
    spinePitchRad: 0.015,
    armSwayRad: 0.02,
    bodyCurlRad: 0.09,
    asymBias: 0.4,
    hitch: true,
  },
};

export interface BreathingClipOptions {
  /** Override the clip duration (seconds). Default 6s (one full breath
   *  cycle ~5x for calm; ~2.5x for winded). */
  duration?: number;
  /** Sample rate (Hz). Default 30. */
  sampleHz?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Clip builder (cached per state)
// ───────────────────────────────────────────────────────────────────────────

const _clipCache = new Map<BreathingState, THREE.AnimationClip>();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

const BREATHING_BONES = [
  "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  "LeftArm", "RightArm",
];

/** Build a procedural breathing AnimationClip for the given state.
 *  The clip drives the rig's spine chain + head + arms with low-amplitude
 *  sinusoidal motion. Cached per state. */
export function buildBreathingClip(
  state: BreathingState,
  opts: BreathingClipOptions = {},
): THREE.AnimationClip {
  const cached = _clipCache.get(state);
  if (cached && !opts.duration && !opts.sampleHz) return cached;

  const params = BREATHING_PARAMS[state];
  const dur = opts.duration ?? 6.0;
  const hz = opts.sampleHz ?? 30;
  const steps = Math.max(2, Math.floor(dur * hz));
  const dt = dur / steps;

  const times = new Float32Array(steps + 1);
  const boneRots: Record<string, number[]> = {};
  const hipsPos: number[] = [];
  for (const b of BREATHING_BONES) boneRots[b] = [];

  const breathHz = params.breathsPerMin / 60; // cycles per second
  // Inhale = first half of the cycle (chest expands); exhale = second half.
  // Model the breath envelope as a sine for simplicity, with a sharper
  // inhale (asymmetric) for winded + injured states.
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    times[i] = t;
    const phase = (t * breathHz) % 1; // 0..1
    let breath: number;
    if (state === "calm") {
      breath = Math.sin(phase * Math.PI * 2);
    } else {
      // Asymmetric — fast inhale, slow exhale.
      const inhale = Math.pow(Math.sin(phase * Math.PI), 2);
      const exhale = -Math.pow(Math.sin((phase - 0.5) * Math.PI * 2), 2) * 0.7;
      breath = phase < 0.5 ? inhale : exhale;
    }

    // Injured hitch: every ~4s, add a sharp catch.
    let hitchOffset = 0;
    if (params.hitch) {
      const hitchPhase = (t % 4) / 4;
      // Sharp narrow spike at hitchPhase = 0.5.
      const d = Math.abs(hitchPhase - 0.5);
      hitchOffset = Math.exp(-(d * d) / 0.002) * 0.6;
      // The hitch momentarily REVERSES the breath (sharp gasp).
      breath -= hitchOffset;
    }

    // ── Hips position: subtle vertical bob (chest rise). ──
    hipsPos.push(0, params.chestRiseM * breath, 0);

    // ── Spine chain: pitch forward on exhale, back on inhale. ──
    const spinePitch = params.spinePitchRad * breath + params.bodyCurlRad;
    _e.set(spinePitch, 0, 0);
    _q.setFromEuler(_e);
    boneRots.Spine.push(_q.x, _q.y, _q.z, _q.w);

    // Spine1 + Spine2: slightly less than Spine (distributed).
    _e.set(spinePitch * 0.7, 0, 0);
    _q.setFromEuler(_e);
    boneRots.Spine1.push(_q.x, _q.y, _q.z, _q.w);
    boneRots.Spine2.push(_q.x, _q.y, _q.z, _q.w);

    // ── Neck: small pitch opposite to spine (head steady). ──
    _e.set(-spinePitch * 0.3, 0, 0);
    _q.setFromEuler(_e);
    boneRots.Neck.push(_q.x, _q.y, _q.z, _q.w);

    // ── Head: tiny bob + pitch with breath. ──
    _e.set(params.headBobM * 0.05 * breath, 0, 0);
    _q.setFromEuler(_e);
    boneRots.Head.push(_q.x, _q.y, _q.z, _q.w);

    // ── Arms: shoulder roll + slight sway. Asymmetric for injured. ──
    const rollL = params.shoulderRollRad * breath + params.armSwayRad * breath * 0.5;
    const rollR = params.shoulderRollRad * breath - params.armSwayRad * breath * 0.5;
    _e.set(0, 0, rollL + params.asymBias * 0.02);
    _q.setFromEuler(_e);
    boneRots.LeftArm.push(_q.x, _q.y, _q.z, _q.w);
    _e.set(0, 0, -rollR - params.asymBias * 0.02);
    _q.setFromEuler(_e);
    boneRots.RightArm.push(_q.x, _q.y, _q.z, _q.w);

    // ── Hips: tiny pitch (counter-balance for body curl). ──
    _e.set(-spinePitch * 0.2, 0, 0);
    _q.setFromEuler(_e);
    boneRots.Hips.push(_q.x, _q.y, _q.z, _q.w);
  }

  const tracks: THREE.KeyframeTrack[] = [
    new THREE.VectorKeyframeTrack("Hips.position", Array.from(times), hipsPos),
  ];
  for (const b of BREATHING_BONES) {
    tracks.push(
      new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, Array.from(times), boneRots[b]),
    );
  }
  const clip = new THREE.AnimationClip(`breathing_${state}`, dur, tracks);
  if (!opts.duration && !opts.sampleHz) {
    _clipCache.set(state, clip);
  }
  return clip;
}

// ───────────────────────────────────────────────────────────────────────────
// BreathingIdleDriver class
// ───────────────────────────────────────────────────────────────────────────

export class BreathingIdleDriver {
  private mixer: THREE.AnimationMixer;
  private ownMixer: boolean;
  private root: THREE.Object3D;
  private currentState: BreathingState = "calm";
  private activeAction: THREE.AnimationAction | null = null;
  private fadingAction: THREE.AnimationAction | null = null;
  private intensity = 1.0;
  private disposed = false;

  constructor(root: THREE.Object3D, mixer?: THREE.AnimationMixer) {
    this.root = root;
    if (mixer) {
      this.mixer = mixer;
      this.ownMixer = false;
    } else {
      this.mixer = new THREE.AnimationMixer(root);
      this.ownMixer = true;
    }
    // Auto-start in calm state.
    this.play("calm", 0);
  }

  /** Play a breathing state. Internal helper. */
  private play(state: BreathingState, fadeSec: number): void {
    const clip = buildBreathingClip(state);
    const action = this.mixer.clipAction(clip, this.root);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.timeScale = 1.0;
    action.weight = this.intensity;
    if (fadeSec > 0 && this.activeAction) {
      // Crossfade from active → new.
      this.activeAction.crossFadeTo(action, fadeSec, false);
      this.fadingAction = this.activeAction;
      // Schedule cleanup of the fading action.
      const fading = this.fadingAction;
      setTimeout(() => {
        if (fading === this.fadingAction) {
          fading.stop();
          this.mixer.uncacheAction(fading.getClip());
          this.fadingAction = null;
        }
      }, fadeSec * 1000 + 50);
    } else {
      action.play();
      if (this.activeAction) {
        this.activeAction.stop();
        this.mixer.uncacheAction(this.activeAction.getClip());
      }
    }
    action.play();
    this.activeAction = action;
    this.currentState = state;
  }

  /** Crossfade to a new breathing state. */
  setState(state: BreathingState, fadeSec: number = 0.3): void {
    if (this.disposed) return;
    if (state === this.currentState) return;
    this.play(state, fadeSec);
  }

  /** Advance the driver. Host should call this each frame. */
  tick(dt: number): void {
    if (this.disposed) return;
    if (this.ownMixer) this.mixer.update(dt);
  }

  /** Get the current breathing state. */
  getState(): BreathingState {
    return this.currentState;
  }

  /** Scale the breathing amplitude (0 = no breathing; 1 = full). Useful
   *  for fading out breathing when a character dies or goes ragdoll. */
  setIntensity(intensity: number): void {
    this.intensity = Math.max(0, Math.min(1, intensity));
    if (this.activeAction) {
      this.activeAction.weight = this.intensity;
    }
  }

  /** Get the current intensity. */
  getIntensity(): number {
    return this.intensity;
  }

  /** Quick-set the state from a game-context heuristic (e.g. stamina +
   *  health → breathing state). */
  setStateFromVitals(stamina01: number, health01: number): void {
    if (health01 < 0.3) {
      this.setState("injured");
    } else if (stamina01 < 0.3) {
      this.setState("winded");
    } else {
      this.setState("calm");
    }
  }

  /** Stop the breathing (e.g. when the character dies). */
  stop(fadeSec: number = 0.2): void {
    if (this.disposed || !this.activeAction) return;
    this.activeAction.fadeOut(fadeSec);
    const fading = this.activeAction;
    setTimeout(() => {
      fading.stop();
      this.mixer.uncacheAction(fading.getClip());
    }, fadeSec * 1000 + 50);
    this.activeAction = null;
  }

  /** Resume breathing after a .stop() call. */
  resume(state?: BreathingState, fadeSec: number = 0.3): void {
    if (this.disposed) return;
    this.play(state ?? this.currentState, fadeSec);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeAction) {
      this.activeAction.stop();
      this.mixer.uncacheAction(this.activeAction.getClip());
      this.activeAction = null;
    }
    if (this.fadingAction) {
      this.fadingAction.stop();
      this.mixer.uncacheAction(this.fadingAction.getClip());
      this.fadingAction = null;
    }
    if (this.ownMixer) {
      this.mixer.uncacheRoot(this.root);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Singleton per-rig driver registry (lazy, keyed by Object3D uuid)
// ───────────────────────────────────────────────────────────────────────────

const _driverRegistry = new Map<string, BreathingIdleDriver>();

export function getBreathingDriver(root: THREE.Object3D): BreathingIdleDriver {
  let driver = _driverRegistry.get(root.uuid);
  if (!driver) {
    driver = new BreathingIdleDriver(root);
    _driverRegistry.set(root.uuid, driver);
  }
  return driver;
}

export function disposeAllBreathingDrivers(): void {
  for (const d of _driverRegistry.values()) d.dispose();
  _driverRegistry.clear();
}

/** Quick top-level helper: set the breathing state on the singleton driver
 *  for the given rig. */
export function setBreathingState(
  root: THREE.Object3D,
  state: BreathingState,
  fadeSec?: number,
): void {
  getBreathingDriver(root).setState(state, fadeSec);
}

/** Quick top-level helper: tick the singleton driver. */
export function tickBreathing(root: THREE.Object3D, dt: number): void {
  const d = _driverRegistry.get(root.uuid);
  if (d) d.tick(dt);
}
