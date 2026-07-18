/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * ProceduralRecoil — procedural recoil animation per weapon, applied via a
 * persistent additive AnimationMixer layer.
 *
 * B-prompt mapping:
 *   B-00005 / B-00006 / B-00007 — visor wipe + goggle reflection (recoil
 *     feeds the muzzle-flash reflection direction).
 *   B-00016 / B-00030 / B-00069 / B-00090 — limb-hit flinch overlaps with
 *     the firing weapon's procedural recoil.
 *   B-00032 — weapon-sway inertia (recoil adds momentum to the sway system).
 *   B-00046 / B-00070 / B-00091 / B-000100 — weapon-sway inertia (recoil is
 *     the impulse source).
 *
 * Design:
 *   Each weapon has a RecoilProfile (vertical kick, horizontal, yaw, roll,
 *   chamber impulse, recovery curve, recover duration). On each shot:
 *
 *     1. The system builds a one-shot THREE.AnimationClip from the profile
 *        + caches it (per profile, per weapon). The clip drives the
 *        weapon viewmodel's local position + quaternion.
 *     2. The clip is played as an ADDITIVE blend (clip.blendMode = Additive)
 *        on the persistent recoil layer mixer, so it stacks on top of the
 *        idle / ADS / sway layers.
 *     3. Subsequent shots retrigger the clip from t=0 (overlapping recoil
 *        accumulates naturally — the additive clip's peak adds to the
 *        previous shot's recovering tail, producing the characteristic
 *        "climbing recoil" of full-auto fire).
 *
 *   The recoil profile is fully data-driven so the gunsmith can tweak per-
 *   weapon recoil without touching animation code. Profiles for the
 *   canonical Project Reality weapons are provided as a starting library.
 *
 * SSR-safe: pure THREE + TS; no window/document.
 *
 * Public API:
 *   - RECOIL_PROFILES — per-weapon recoil profile catalog.
 *   - buildRecoilClip(profile) → AnimationClip (cached).
 *   - class ProceduralRecoilLayer — persistent additive layer.
 *   - .trigger(profile, timeScale?) — fire a recoil impulse.
 *   - .tick(dt) — advance the mixer.
 *   - .getRecoilOffset() — current additive offset (for ballistic-camera kick).
 *   - .reset() — cancel all active recoil (e.g. on weapon swap).
 */

import * as THREE from "three";
import type { WeaponType } from "../store";

// ───────────────────────────────────────────────────────────────────────────
// Types + per-weapon profile catalog
// ───────────────────────────────────────────────────────────────────────────

export interface RecoilProfile {
  /** Weapon slug this profile is for. */
  weapon: WeaponType | string;
  /** Vertical kick (radians, peak at the kick instant). */
  verticalKick: number;
  /** Horizontal kick amplitude (radians). Random sign per shot. */
  horizontalKick: number;
  /** Yaw (Z-axis rotation) kick amplitude (radians). */
  yawKick: number;
  /** Roll (X-axis rotation) kick amplitude (radians). */
  rollKick: number;
  /** Position recoil: weapon pushes back into the shoulder (meters). */
  posZKick: number;
  /** Position recoil: weapon kicks up (meters). */
  posYKick: number;
  /** Time from trigger-pull to peak kick (seconds). */
  riseTime: number;
  /** Time from peak to settled (seconds). */
  recoverTime: number;
  /** Recovery curve: "linear" | "exponential" | "spring". */
  recoverCurve: "linear" | "exponential" | "spring";
  /** Spring overshoot (only used if recoverCurve === "spring"). 0..0.3. */
  springOvershoot: number;
  /** Chamber-impulse: an additional small jolt at chamber time (for
   *  bolt-action / pump-action weapons). 0 = none. */
  chamberImpulse?: number;
  /** Chamber-impulse time (seconds after trigger). */
  chamberImpulseTime?: number;
  /** Fire-rate cap for full-auto recoil accumulation (RPM). 0 = semi. */
  fireRateRpm: number;
}

const _rifle = (w: WeaponType, kick = 0.025, h = 0.008): RecoilProfile => ({
  weapon: w,
  verticalKick: kick,
  horizontalKick: h,
  yawKick: h * 0.5,
  rollKick: h * 0.3,
  posZKick: 0.012,
  posYKick: 0.005,
  riseTime: 0.04,
  recoverTime: 0.22,
  recoverCurve: "exponential",
  springOvershoot: 0,
  fireRateRpm: 600,
});

const _pistol = (w: WeaponType, kick = 0.03): RecoilProfile => ({
  weapon: w,
  verticalKick: kick,
  horizontalKick: 0.012,
  yawKick: 0.006,
  rollKick: 0.005,
  posZKick: 0.008,
  posYKick: 0.004,
  riseTime: 0.035,
  recoverTime: 0.16,
  recoverCurve: "spring",
  springOvershoot: 0.1,
  fireRateRpm: 0,
});

const _sniper = (w: WeaponType, kick = 0.07): RecoilProfile => ({
  weapon: w,
  verticalKick: kick,
  horizontalKick: 0.015,
  yawKick: 0.01,
  rollKick: 0.008,
  posZKick: 0.04,
  posYKick: 0.015,
  riseTime: 0.05,
  recoverTime: 0.5,
  recoverCurve: "spring",
  springOvershoot: 0.18,
  chamberImpulse: kick * 0.4,
  chamberImpulseTime: 0.25,
  fireRateRpm: 0,
});

const _shotgun = (w: WeaponType): RecoilProfile => ({
  weapon: w,
  verticalKick: 0.09,
  horizontalKick: 0.02,
  yawKick: 0.015,
  rollKick: 0.012,
  posZKick: 0.05,
  posYKick: 0.02,
  riseTime: 0.055,
  recoverTime: 0.4,
  recoverCurve: "spring",
  springOvershoot: 0.22,
  chamberImpulse: 0.04,
  chamberImpulseTime: 0.35,
  fireRateRpm: 0,
});

const _lmg = (w: WeaponType): RecoilProfile => ({
  weapon: w,
  verticalKick: 0.04,
  horizontalKick: 0.015,
  yawKick: 0.01,
  rollKick: 0.006,
  posZKick: 0.02,
  posYKick: 0.008,
  riseTime: 0.045,
  recoverTime: 0.28,
  recoverCurve: "exponential",
  springOvershoot: 0,
  fireRateRpm: 800,
});

/** Per-weapon recoil profile catalog. */
export const RECOIL_PROFILES: Partial<Record<WeaponType, RecoilProfile>> = {
  // Rifles.
  ak74: { ..._rifle("ak74", 0.032, 0.012), rollKick: 0.008 },
  m4: _rifle("m4", 0.022, 0.007),
  hk416: _rifle("hk416", 0.024, 0.008),
  famas: _rifle("famas", 0.026, 0.009),
  aug: _rifle("aug", 0.024, 0.008),
  scarh: _rifle("scarh", 0.028, 0.009),
  galil: _rifle("galil", 0.03, 0.01),
  mk17: _rifle("mk17", 0.034, 0.011),
  mk14: { ..._rifle("mk14", 0.04, 0.013), fireRateRpm: 0, recoverCurve: "spring", springOvershoot: 0.08 },
  // SMGs.
  mp7: _rifle("mp7", 0.018, 0.006),
  p90: _rifle("p90", 0.016, 0.005),
  mp5: _rifle("mp5", 0.018, 0.006),
  ump45: _rifle("ump45", 0.024, 0.008),
  vector: _rifle("vector", 0.014, 0.005),
  pp90m1: _rifle("pp90m1", 0.016, 0.006),
  // Pistols.
  usp: _pistol("usp", 0.025),
  deagle: _pistol("deagle", 0.06),
  glock18: _pistol("glock18", 0.022),
  m1911: _pistol("m1911", 0.035),
  revolver: _pistol("revolver", 0.07),
  // Snipers.
  awp: _sniper("awp", 0.085),
  scout: _sniper("scout", 0.06),
  kar98k: _sniper("kar98k", 0.075),
  l115a3: _sniper("l115a3", 0.09),
  // Shotguns.
  nova: _shotgun("nova"),
  // LMG.
  m249: _lmg("m249"),
};

const _DEFAULT_PROFILE = _rifle("default", 0.025, 0.008);

/** Get the recoil profile for a weapon, or a sensible default. */
export function getRecoilProfile(weapon: WeaponType | string): RecoilProfile {
  return RECOIL_PROFILES[weapon as WeaponType] ?? _DEFAULT_PROFILE;
}

// ───────────────────────────────────────────────────────────────────────────
// Clip builder (cached per profile)
// ───────────────────────────────────────────────────────────────────────────

const _clipCache = new Map<string, THREE.AnimationClip>();

/** Build a one-shot recoil AnimationClip from a profile. The clip is
 *  ADDITIVE (blendMode = Additive) so it stacks on top of the idle/sway
 *  layers. Cached per profile.weapon + profile.fireRateRpm. */
export function buildRecoilClip(profile: RecoilProfile): THREE.AnimationClip {
  const key = `${profile.weapon}_${profile.fireRateRpm}_${profile.recoverCurve}`;
  const cached = _clipCache.get(key);
  if (cached) return cached;

  const total = profile.riseTime + profile.recoverTime;
  const steps = 16;
  const times: number[] = [];
  const posValues: number[] = [];
  const quatValues: number[] = [];

  const horizSign = Math.random() < 0.5 ? -1 : 1;
  const yawSign = Math.random() < 0.5 ? -1 : 1;
  const rollSign = Math.random() < 0.5 ? -1 : 1;

  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();

  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * total;
    times.push(t);

    // ── Envelope ──
    let env: number;
    if (t < profile.riseTime) {
      // Rise: ease-out (fast attack).
      const a = t / profile.riseTime;
      env = 1 - Math.pow(1 - a, 3);
    } else {
      // Recover.
      const a = (t - profile.riseTime) / profile.recoverTime;
      const aClamped = Math.min(1, a);
      if (profile.recoverCurve === "linear") {
        env = 1 - aClamped;
      } else if (profile.recoverCurve === "exponential") {
        env = Math.exp(-3.5 * aClamped);
      } else {
        // spring — damped sine.
        env = Math.exp(-4 * aClamped) * Math.cos(aClamped * Math.PI * 2 * (1 - profile.springOvershoot));
      }
    }
    // Add chamber impulse if applicable.
    if (
      profile.chamberImpulse &&
      profile.chamberImpulseTime !== undefined
    ) {
      const ct = profile.chamberImpulseTime;
      const cEnv = Math.exp(-((t - ct) ** 2) / (2 * 0.04 ** 2));
      env += profile.chamberImpulse * cEnv;
    }

    // ── Position kick ──
    posValues.push(
      horizSign * profile.horizontalKick * env * 0.3, // small X shake
      profile.posYKick * env,
      -profile.posZKick * env, // weapon pushes back (negative Z)
    );

    // ── Quaternion kick (XYZ Euler) ──
    _e.set(
      profile.verticalKick * env,  // pitch up = X rotation
      yawSign * profile.yawKick * env,
      rollSign * profile.rollKick * env,
    );
    _q.setFromEuler(_e);
    quatValues.push(_q.x, _q.y, _q.z, _q.w);
  }

  const posTrack = new THREE.VectorKeyframeTrack(".position", times, posValues);
  const quatTrack = new THREE.QuaternionKeyframeTrack(".quaternion", times, quatValues);
  const clip = new THREE.AnimationClip(
    `recoil_${profile.weapon}`,
    total,
    [posTrack, quatTrack],
    THREE.AnimationClipBlendMode.Additive,
  );
  _clipCache.set(key, clip);
  return clip;
}

// ───────────────────────────────────────────────────────────────────────────
// ProceduralRecoilLayer class
// ───────────────────────────────────────────────────────────────────────────

/** Persistent additive recoil layer. Construct once per weapon viewmodel
 *  + call .trigger() on each shot. */
export class ProceduralRecoilLayer {
  private mixer: THREE.AnimationMixer;
  private ownMixer: boolean;
  private weaponGroup: THREE.Object3D;
  private activeActions: THREE.AnimationAction[] = [];
  private currentOffset = new THREE.Vector3();
  private currentQuat = new THREE.Quaternion();
  private disposed = false;

  constructor(weaponGroup: THREE.Object3D, mixer?: THREE.AnimationMixer) {
    this.weaponGroup = weaponGroup;
    if (mixer) {
      this.mixer = mixer;
      this.ownMixer = false;
    } else {
      this.mixer = new THREE.AnimationMixer(weaponGroup);
      this.ownMixer = true;
    }
  }

  /** Fire a recoil impulse. Subsequent triggers stack on top of the
   *  previous shot's recovering tail (climbing recoil). */
  trigger(profile: RecoilProfile, timeScale: number = 1.0): void {
    if (this.disposed) return;
    const clip = buildRecoilClip(profile);
    const action = this.mixer.clipAction(clip, this.weaponGroup);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;
    action.timeScale = timeScale;
    action.reset().play();
    this.activeActions.push(action);
  }

  /** Advance the mixer + sample the current additive offset (so the
   *  camera can apply a matching kick). */
  tick(dt: number): void {
    if (this.disposed) return;
    if (this.ownMixer) this.mixer.update(dt);

    // Sample the current cumulative additive offset by reading the
    // weaponGroup's local pose delta from the bind pose. (We assume the
    // host applies this BEFORE the sway layer so the offset is just the
    // recoil layer's contribution. If the host interleaves them, the
    // host should call .getRecoilOffset() immediately after tick().)
    this.currentOffset.set(0, 0, 0);
    this.currentQuat.identity();
    // Walk active actions + sum their time-sampled values.
    for (const a of this.activeActions) {
      if (!a.isRunning()) continue;
      const clip = a.getClip();
      const t = a.time;
      // Find pos + quat tracks.
      const posTrack = clip.tracks.find((tr) => tr.name === ".position") as
        | THREE.VectorKeyframeTrack
        | undefined;
      const quatTrack = clip.tracks.find((tr) => tr.name === ".quaternion") as
        | THREE.QuaternionKeyframeTrack
        | undefined;
      if (posTrack) {
        const v = this._sampleVec(posTrack, t);
        this.currentOffset.add(v);
      }
      if (quatTrack) {
        const q = this._sampleQuat(quatTrack, t);
        this.currentQuat.multiply(q);
      }
    }

    // Reap finished actions.
    this.activeActions = this.activeActions.filter((a) => {
      if (!a.isRunning() && a.time >= a.getClip().duration) {
        a.stop();
        this.mixer.uncacheAction(a.getClip());
        return false;
      }
      return true;
    });
  }

  /** Get the current additive recoil offset (position, meters). */
  getRecoilOffset(): THREE.Vector3 {
    return this.currentOffset.clone();
  }

  /** Get the current additive recoil quaternion. */
  getRecoilQuat(): THREE.Quaternion {
    return this.currentQuat.clone();
  }

  /** Get the current vertical kick (radians) — convenience for the
   *  camera-tilt system. */
  getVerticalKickRad(): number {
    const e = new THREE.Euler().setFromQuaternion(this.currentQuat, "XYZ");
    return e.x;
  }

  /** Cancel all active recoil (e.g. on weapon swap). */
  reset(): void {
    for (const a of this.activeActions) {
      a.stop();
      this.mixer.uncacheAction(a.getClip());
    }
    this.activeActions = [];
    this.currentOffset.set(0, 0, 0);
    this.currentQuat.identity();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    if (this.ownMixer) {
      this.mixer.uncacheRoot(this.weaponGroup);
    }
  }

  private _sampleVec(track: THREE.VectorKeyframeTrack, t: number): THREE.Vector3 {
    const times = track.times;
    const values = track.values;
    if (t <= times[0]) return new THREE.Vector3(values[0], values[1], values[2]);
    if (t >= times[times.length - 1]) {
      const i = times.length - 1;
      return new THREE.Vector3(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]);
    }
    let lo = 0, hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    const a = (t - times[lo]) / (times[hi] - times[lo] || 1);
    const v0 = new THREE.Vector3(values[lo * 3], values[lo * 3 + 1], values[lo * 3 + 2]);
    const v1 = new THREE.Vector3(values[hi * 3], values[hi * 3 + 1], values[hi * 3 + 2]);
    return v0.lerp(v1, a);
  }

  private _sampleQuat(track: THREE.QuaternionKeyframeTrack, t: number): THREE.Quaternion {
    const times = track.times;
    const values = track.values;
    if (t <= times[0]) return new THREE.Quaternion(values[0], values[1], values[2], values[3]);
    if (t >= times[times.length - 1]) {
      const i = times.length - 1;
      return new THREE.Quaternion(values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]);
    }
    let lo = 0, hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    const a = (t - times[lo]) / (times[hi] - times[lo] || 1);
    const q0 = new THREE.Quaternion(values[lo * 4], values[lo * 4 + 1], values[lo * 4 + 2], values[lo * 4 + 3]);
    const q1 = new THREE.Quaternion(values[hi * 4], values[hi * 4 + 1], values[hi * 4 + 2], values[hi * 4 + 3]);
    return new THREE.Quaternion().copy(q0).slerp(q1, a);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Convenience helpers
// ───────────────────────────────────────────────────────────────────────────

/** Singleton per-weapon recoil layer registry (lazy, keyed by Object3D
 *  uuid). Engines that re-use the same viewmodel group across weapon
 *  swaps can reuse the layer. */
const _layerRegistry = new Map<string, ProceduralRecoilLayer>();

export function getRecoilLayer(weaponGroup: THREE.Object3D): ProceduralRecoilLayer {
  let layer = _layerRegistry.get(weaponGroup.uuid);
  if (!layer) {
    layer = new ProceduralRecoilLayer(weaponGroup);
    _layerRegistry.set(weaponGroup.uuid, layer);
  }
  return layer;
}

export function disposeAllRecoilLayers(): void {
  for (const layer of _layerRegistry.values()) layer.dispose();
  _layerRegistry.clear();
}

/** Quick top-level trigger helper for callers that don't want to manage
 *  a layer instance. Uses the singleton layer for the given viewmodel. */
export function fireRecoil(
  weaponGroup: THREE.Object3D,
  weapon: WeaponType | string,
): void {
  const layer = getRecoilLayer(weaponGroup);
  layer.trigger(getRecoilProfile(weapon));
}

/** Quick top-level tick helper — ticks the singleton layer. */
export function tickRecoil(weaponGroup: THREE.Object3D, dt: number): void {
  const layer = _layerRegistry.get(weaponGroup.uuid);
  if (layer) layer.tick(dt);
}
