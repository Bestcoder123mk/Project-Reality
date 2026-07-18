/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * InspectAnimations — secret per-weapon inspect (spin / examine / field-strip)
 * animations, Rivals-style.
 *
 * B-prompt mapping:
 *   B-00009 — weapon inspect (spin, examine, field-strip) for a boss NPC
 *   B-00027 / B-00073 / B-00086 — inspect for elite enemy / ragdoll / grunt
 *   B-00059 — inspect viewmodel, ragdoll-to-finisher blend (low-end Android)
 *   B-00086 — inspect for enemy grunt (GLSL fragment-shader pass — this TS
 *     module owns the animation tracks; the shader pass is the renderer's job)
 *
 * Design:
 *   Each weapon type gets a unique 3-phase inspect clip:
 *     1. SPIN    (~0.5s) — quick weapon spin on its long axis to show off
 *                  the wrap/skin.
 *     2. EXAMINE (~1.0s) — slow tilt + bring the receiver up to the camera
 *                  for a "checking the chamber" beat.
 *     3. STRIP   (~1.5s) — field-strip: mag out, charging handle pull, bolt
 *                  back, then reassemble. The actual magazine/bolt bones
 *                  are toggled by animation event callbacks (the host can
 *                  register an event listener on the returned clip).
 *
 *   The clips are constructed as THREE.AnimationClip objects whose tracks
 *   target the weapon viewmodel group's position + quaternion (so the host
 *   can bind them via the existing AnimationMixer pattern used by
 *   fp-state-machine.ts).
 *
 *   Heavy weapons (LMG, sniper rifles) get slower, more deliberate
 *   inspects; pistols get a fast twirl; shotguns get a pump-rack flourish.
 *   The inspect key handler can pick a random variant per weapon for
 *   variety ("secret" inspect — Rivals-style).
 *
 * SSR-safe: pure THREE + TS; no window/document.
 *
 * Public API:
 *   - buildInspectClip(weaponSlug, variant?) → THREE.AnimationClip
 *   - playInspect(mixer, weaponSlug, variant?) → THREE.AnimationAction
 *   - INSPECT_VARIANTS — per-weapon variant catalog (for the UI)
 *   - registerInspectEventListener(clip, fn) — wire up field-strip events
 */

import * as THREE from "three";
import type { WeaponType } from "../store";

// ───────────────────────────────────────────────────────────────────────────
// Types + catalog
// ───────────────────────────────────────────────────────────────────────────

export type InspectPhase = "spin" | "examine" | "strip";

export interface InspectBeatTimings {
  spinStart: number;
  spinEnd: number;
  examineStart: number;
  examineEnd: number;
  stripStart: number;
  stripEnd: number;
  /** Total clip duration (seconds). */
  total: number;
}

/** Variant key — each weapon has 1-3 secret variants the player can
 *  trigger by holding inspect longer or pressing a combo. */
export type InspectVariant = "default" | "twirl" | "fieldStrip" | "luckySpin";

export interface InspectSpec {
  /** Beat timings (seconds). */
  timings: InspectBeatTimings;
  /** Spin axis (normalized XYZ). */
  spinAxis: [number, number, number];
  /** Spin rotations (full revolutions during spin beat). */
  spinRevolutions: number;
  /** Examine tilt (radians, Euler XYZ at examine peak). */
  examineTilt: [number, number, number];
  /** Examine position offset (meters, relative to camera). */
  examineOffset: [number, number, number];
  /** Strip: list of named beats + their start/end times (relative to
   *  strip phase start). The host listens for these as AnimationClip
   *  events (THREE.KeyframeTrack doesn't emit mid-clip events natively,
   *  so we surface them via clip.events — see registerInspectEventListener). */
  stripBeats: { name: string; at: number }[];
  /** Secret variants available for this weapon. */
  variants: InspectVariant[];
}

// ───────────────────────────────────────────────────────────────────────────
// Per-weapon specs
// ───────────────────────────────────────────────────────────────────────────

const _standardSpec = (variants: InspectVariant[]): InspectSpec => ({
  timings: { spinStart: 0.0, spinEnd: 0.55, examineStart: 0.55, examineEnd: 1.55, stripStart: 1.55, stripEnd: 3.05, total: 3.05 },
  spinAxis: [0, 1, 0],
  spinRevolutions: 1.0,
  examineTilt: [0.3, 0.4, 0.1],
  examineOffset: [-0.05, 0.02, -0.1],
  stripBeats: [
    { name: "magOut", at: 0.1 },
    { name: "chargePull", at: 0.55 },
    { name: "boltBack", at: 0.9 },
    { name: "reinsert", at: 1.25 },
    { name: "settle", at: 1.45 },
  ],
  variants,
});

const _pistolSpec: InspectSpec = {
  timings: { spinStart: 0.0, spinEnd: 0.4, examineStart: 0.4, examineEnd: 1.1, stripStart: 1.1, stripEnd: 2.0, total: 2.0 },
  spinAxis: [0, 1, 0.2],
  spinRevolutions: 1.5,
  examineTilt: [0.4, 0.3, 0.2],
  examineOffset: [-0.04, 0.0, -0.08],
  stripBeats: [
    { name: "magOut", at: 0.1 },
    { name: "slideLock", at: 0.4 },
    { name: "reinsert", at: 0.7 },
    { name: "slideRelease", at: 0.85 },
  ],
  variants: ["default", "twirl", "luckySpin"],
};

const _shotgunSpec: InspectSpec = {
  timings: { spinStart: 0.0, spinEnd: 0.65, examineStart: 0.65, examineEnd: 1.85, stripStart: 1.85, stripEnd: 3.85, total: 3.85 },
  spinAxis: [0, 1, 0],
  spinRevolutions: 0.75,
  examineTilt: [0.5, 0.5, 0.0],
  examineOffset: [-0.08, 0.05, -0.12],
  stripBeats: [
    { name: "pumpRack", at: 0.1 },
    { name: "barrelTilt", at: 0.6 },
    { name: "shellCheck", at: 1.1 },
    { name: "pumpReset", at: 1.7 },
  ],
  variants: ["default", "fieldStrip"],
};

const _sniperSpec: InspectSpec = {
  timings: { spinStart: 0.0, spinEnd: 0.7, examineStart: 0.7, examineEnd: 2.0, stripStart: 2.0, stripEnd: 4.0, total: 4.0 },
  spinAxis: [0, 1, 0],
  spinRevolutions: 0.5,
  examineTilt: [0.2, 0.6, 0.0],
  examineOffset: [-0.06, 0.03, -0.1],
  stripBeats: [
    { name: "boltUp", at: 0.1 },
    { name: "boltPull", at: 0.5 },
    { name: "scopeGlint", at: 1.0 },
    { name: "boltForward", at: 1.5 },
    { name: "boltDown", at: 1.85 },
  ],
  variants: ["default", "fieldStrip"],
};

const _lmgSpec: InspectSpec = {
  timings: { spinStart: 0.0, spinEnd: 0.85, examineStart: 0.85, examineEnd: 2.35, stripStart: 2.35, stripEnd: 4.85, total: 4.85 },
  spinAxis: [0, 1, 0],
  spinRevolutions: 0.4,
  examineTilt: [0.35, 0.55, 0.05],
  examineOffset: [-0.07, 0.04, -0.14],
  stripBeats: [
    { name: "coverOpen", at: 0.1 },
    { name: "beltLift", at: 0.6 },
    { name: "boltCheck", at: 1.2 },
    { name: "coverClose", at: 2.0 },
    { name: "settle", at: 2.4 },
  ],
  variants: ["default", "fieldStrip"],
};

/** Per-weapon inspect specs. Maps the canonical WeaponType slugs from
 *  src/lib/game/store.ts to their inspect beat structure. */
export const INSPECT_SPECS: Partial<Record<WeaponType, InspectSpec>> = {
  // Rifles (standard 3.05s inspect).
  ak74: _standardSpec(["default", "fieldStrip", "twirl"]),
  m4: _standardSpec(["default", "fieldStrip", "twirl"]),
  hk416: _standardSpec(["default", "fieldStrip"]),
  famas: _standardSpec(["default", "twirl"]),
  aug: _standardSpec(["default", "fieldStrip"]),
  scarh: _standardSpec(["default", "fieldStrip"]),
  galil: _standardSpec(["default", "twirl"]),
  mk17: _standardSpec(["default", "fieldStrip"]),
  mk14: _standardSpec(["default", "fieldStrip"]),
  // SMGs.
  mp7: _standardSpec(["default", "twirl", "luckySpin"]),
  p90: _standardSpec(["default", "twirl"]),
  mp5: _standardSpec(["default", "twirl"]),
  ump45: _standardSpec(["default", "fieldStrip"]),
  vector: _standardSpec(["default", "twirl", "luckySpin"]),
  pp90m1: _standardSpec(["default", "twirl"]),
  // Pistols.
  usp: _pistolSpec,
  deagle: _pistolSpec,
  glock18: { ..._pistolSpec, variants: ["default", "twirl", "luckySpin"] },
  m1911: _pistolSpec,
  revolver: { ..._pistolSpec, spinRevolutions: 2.0, variants: ["default", "twirl", "luckySpin"] },
  // Snipers.
  awp: _sniperSpec,
  scout: _sniperSpec,
  kar98k: { ..._sniperSpec, spinRevolutions: 0.4, variants: ["default"] },
  l115a3: _sniperSpec,
  // Shotguns.
  nova: _shotgunSpec,
  // LMG.
  m249: _lmgSpec,
};

/** Per-weapon variant catalog exported for the gunsmith/pack UI. */
export const INSPECT_VARIANTS: Partial<Record<WeaponType, InspectVariant[]>> =
  Object.fromEntries(
    Object.entries(INSPECT_SPECS).map(([k, v]) => [k, v!.variants]),
  );

// ───────────────────────────────────────────────────────────────────────────
// Clip builder
// ───────────────────────────────────────────────────────────────────────────

const _DEFAULT_INSPECT_SPEC = _standardSpec(["default"]);

function _getSpec(weaponSlug: WeaponType): InspectSpec {
  return INSPECT_SPECS[weaponSlug] ?? _DEFAULT_INSPECT_SPEC;
}

/** Build a Three.js AnimationClip for the given weapon's inspect sequence.
 *  The clip targets `.position` + `.quaternion` on the viewmodel group
 *  (use clipAction(clip, weaponGroup) to bind). */
export function buildInspectClip(
  weaponSlug: WeaponType,
  variant: InspectVariant = "default",
): THREE.AnimationClip {
  const spec = _getSpec(weaponSlug);
  const t = spec.timings;
  // ── Spin phase: rotate around spinAxis over [spinStart, spinEnd]. ──
  const spinQuatTrack = (() => {
    const axis = new THREE.Vector3(...spec.spinAxis).normalize();
    const totalAngle = spec.spinRevolutions * Math.PI * 2;
    // Variant: luckySpin doubles revolutions.
    const revs = variant === "luckySpin" ? spec.spinRevolutions * 1.5 : spec.spinRevolutions;
    const angle = revs * Math.PI * 2;
    const steps = 8;
    const times: number[] = [];
    const values: number[] = [];
    const q = new THREE.Quaternion();
    for (let i = 0; i <= steps; i++) {
      const tt = t.spinStart + (t.spinEnd - t.spinStart) * (i / steps);
      const a = (angle * i) / steps;
      q.setFromAxisAngle(axis, a);
      times.push(tt);
      values.push(q.x, q.y, q.z, q.w);
    }
    // Variant: twirl adds a vertical-axis flourish at end of spin.
    if (variant === "twirl") {
      const twirlAxis = new THREE.Vector3(1, 0, 0);
      const q2 = new THREE.Quaternion();
      q2.setFromAxisAngle(twirlAxis, Math.PI * 0.5);
      q.premultiply(q2);
      times.push(t.spinEnd + 0.05);
      values.push(q.x, q.y, q.z, q.w);
    }
    return new THREE.QuaternionKeyframeTrack(".quaternion", times, values);
  })();

  // ── Examine phase: tilt to examineTilt + offset to examineOffset. ──
  const examineQuatTrack = (() => {
    const times = [t.examineStart, (t.examineStart + t.examineEnd) / 2, t.examineEnd];
    const q0 = new THREE.Quaternion(); // identity
    const q1 = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...spec.examineTilt as [number, number, number]),
    );
    const q2 = new THREE.Quaternion(); // back to identity
    const values = [
      q0.x, q0.y, q0.z, q0.w,
      q1.x, q1.y, q1.z, q1.w,
      q2.x, q2.y, q2.z, q2.w,
    ];
    return new THREE.QuaternionKeyframeTrack(".quaternion", times, values);
  })();

  const examinePosTrack = (() => {
    const times = [t.examineStart, (t.examineStart + t.examineEnd) / 2, t.examineEnd];
    const [x, y, z] = spec.examineOffset;
    const values = [0, 0, 0, x, y, z, 0, 0, 0];
    return new THREE.VectorKeyframeTrack(".position", times, values);
  })();

  // ── Strip phase: small vertical bob + side-to-side rotation jitter
  //    (the actual magazine/bolt bones are driven by the host's
  //    event listener; the viewmodel just gently bobs). ──
  const stripPosTrack = (() => {
    const beats = spec.stripBeats;
    const times: number[] = [t.stripStart];
    const values: number[] = [0, 0, 0];
    for (let i = 0; i < beats.length; i++) {
      const tt = t.stripStart + beats[i].at;
      // Bob down 2cm on each strip beat.
      times.push(tt - 0.02);
      values.push(0, 0, 0);
      times.push(tt);
      values.push(0, -0.02, 0);
      times.push(tt + 0.02);
      values.push(0, 0, 0);
    }
    times.push(t.stripEnd);
    values.push(0, 0, 0);
    return new THREE.VectorKeyframeTrack(".position", times, values);
  })();

  const stripQuatTrack = (() => {
    const beats = spec.stripBeats;
    const times: number[] = [t.stripStart];
    const values: number[] = [0, 0, 0, 1];
    const q = new THREE.Quaternion();
    for (const beat of beats) {
      const tt = t.stripStart + beat.at;
      q.setFromEuler(new THREE.Euler(0.1, 0.05, 0));
      times.push(tt);
      values.push(q.x, q.y, q.z, q.w);
      times.push(tt + 0.05);
      values.push(0, 0, 0, 1);
    }
    times.push(t.stripEnd);
    values.push(0, 0, 0, 1);
    return new THREE.QuaternionKeyframeTrack(".quaternion", times, values);
  })();

  // Concatenate the per-phase tracks (each track spans the full clip
  // duration implicitly via its keyframe times; Three.js will interpolate
  // the gaps between phases using the last keyframe of the prior phase).
  // To avoid mid-clip popping, we add a "hold" keyframe at the boundary
  // of each phase. The simplest approach: build one merged quaternion
  // track + one merged position track.
  const mergedQuatTrack = _mergeQuaternionTracks([
    spinQuatTrack,
    examineQuatTrack,
    stripQuatTrack,
  ]);
  const mergedPosTrack = _mergeVectorTracks([
    _makeHoldPosTrack(t.spinStart, t.spinEnd),
    examinePosTrack,
    stripPosTrack,
  ]);

  const clip = new THREE.AnimationClip(
    `inspect_${weaponSlug}_${variant}`,
    t.total,
    [mergedQuatTrack, mergedPosTrack],
  );
  // Attach the strip-beat events as a custom property; the host can
  // register a listener via registerInspectEventListener.
  (clip as unknown as { events?: { name: string; at: number }[] }).events =
    spec.stripBeats.map((b) => ({
      name: b.name,
      at: t.stripStart + b.at,
    }));
  return clip;
}

// ───────────────────────────────────────────────────────────────────────────
// Track-merging helpers
// ───────────────────────────────────────────────────────────────────────────

function _mergeQuaternionTracks(
  tracks: THREE.QuaternionKeyframeTrack[],
): THREE.QuaternionKeyframeTrack {
  const times: number[] = [];
  const values: number[] = [];
  for (const tr of tracks) {
    for (let i = 0; i < tr.times.length; i++) {
      times.push(tr.times[i]);
      values.push(tr.values[i * 4], tr.values[i * 4 + 1], tr.values[i * 4 + 2], tr.values[i * 4 + 3]);
    }
  }
  return new THREE.QuaternionKeyframeTrack(".quaternion", times, values);
}

function _mergeVectorTracks(
  tracks: THREE.VectorKeyframeTrack[],
): THREE.VectorKeyframeTrack {
  const times: number[] = [];
  const values: number[] = [];
  for (const tr of tracks) {
    for (let i = 0; i < tr.times.length; i++) {
      times.push(tr.times[i]);
      values.push(tr.values[i * 3], tr.values[i * 3 + 1], tr.values[i * 3 + 2]);
    }
  }
  return new THREE.VectorKeyframeTrack(".position", times, values);
}

function _makeHoldPosTrack(start: number, end: number): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(
    ".position",
    [start, end],
    [0, 0, 0, 0, 0, 0],
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Convenience: play inspect on a mixer
// ───────────────────────────────────────────────────────────────────────────

/** Build + play an inspect animation. Returns the running AnimationAction
 *  (or null if the weapon has no spec). */
export function playInspect(
  mixer: THREE.AnimationMixer,
  weaponGroup: THREE.Object3D,
  weaponSlug: WeaponType,
  variant: InspectVariant = "default",
): THREE.AnimationAction | null {
  if (!INSPECT_SPECS[weaponSlug]) return null;
  const clip = buildInspectClip(weaponSlug, variant);
  const action = mixer.clipAction(clip, weaponGroup);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.reset().play();
  return action;
}

// ───────────────────────────────────────────────────────────────────────────
// Strip-beat event listener (the host wires magazine/bolt bone toggles)
// ───────────────────────────────────────────────────────────────────────────

export type InspectEventListener = (eventName: string, timeSec: number) => void;

/** Register a listener that fires when each strip-beat event passes.
 *  The host should call .update(dt) on the mixer each frame (already
 *  required for animation playback); this helper installs a polling
 *  wrapper that checks clip time vs. event times.
 *
 *  Returns an unsubscribe function. */
export function registerInspectEventListener(
  mixer: THREE.AnimationMixer,
  clip: THREE.AnimationClip,
  action: THREE.AnimationAction,
  listener: InspectEventListener,
): () => void {
  const events = (clip as unknown as { events?: { name: string; at: number }[] }).events ?? [];
  if (events.length === 0) return () => { /* no-op */ };
  let lastTime = action.time;
  let fired = new Set<number>();
  // Reset fired set when the action restarts.
  const interval = setInterval(() => {
    if (!action.isRunning()) return;
    const now = action.time;
    // Detect wrap-around (loop restart).
    if (now < lastTime - 0.01) fired.clear();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (fired.has(i)) continue;
      if (lastTime <= ev.at && ev.at <= now) {
        fired.add(i);
        try {
          listener(ev.name, ev.at);
        } catch {
          // ignore listener errors
        }
      }
    }
    lastTime = now;
  }, 16); // ~60Hz polling — cheap, no per-frame JS overhead on the render loop.
  return () => clearInterval(interval);
}

/** Get the inspect spec for a weapon (or null if absent). */
export function getInspectSpec(weaponSlug: WeaponType): InspectSpec | null {
  return INSPECT_SPECS[weaponSlug] ?? null;
}

/** Pick a random secret variant for the given weapon. Returns "default"
 *  if no variants defined. */
export function randomInspectVariant(weaponSlug: WeaponType): InspectVariant {
  const spec = INSPECT_SPECS[weaponSlug];
  if (!spec || spec.variants.length === 0) return "default";
  return spec.variants[Math.floor(Math.random() * spec.variants.length)];
}
