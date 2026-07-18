/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * FacialBlendshapeRig — facial blendshape (morph-target) system for emotions
 * + lip-sync.
 *
 * B-prompt mapping:
 *   B-00039 / B-00066 / B-00080 — facial microexpression of pain
 *   B-00097 — facial microexpression of pain (Operator loadout)
 *   B-00084 — facial microexpression of pain (player FP rig, TSL node)
 *   B-00002 / B-00012 / B-00025 — death-narration voice-line sync (lip-sync)
 *   B-00038 / B-00090 / B-00098 — lip sync for victim ragdolls
 *
 * Design:
 *   - 52 ARKit-compatible blendshapes (the cross-vendor standard) + a small
 *     set of custom blendshapes (eye-dart, sweat, dirt).
 *   - Emotions are PRESET combinations of blendshape weights (Joy, Anger,
 *     Fear, Surprise, Sadness, Disgust, Pain, Dead, Calm). Each preset is
 *     a partial Record<BlendshapeName, number>; weights are blended
 *     additively with a per-preset weight (so an actor can be 0.5 Calm +
 *     0.5 Pain → tense-but-controlled expression).
 *   - Lip-sync: visemes (15 phoneme-based mouth shapes) + a tiny phoneme
 *     timeline. The rig bakes a Three.js KeyframeTrack on the
 *     morphTargetInfluences array so the lip-sync plays back through the
 *     standard AnimationMixer (no per-frame JS overhead).
 *   - Microexpressions: short (0.2-0.6s) one-shot shape combos (pain
 *     flinch, eye-dart, brow-furrow) that can be triggered on top of the
 *     active emotion. Implemented as additional one-shot mixer actions.
 *
 * The rig binds to a THREE.SkinnedMesh (or any Mesh with morphTargets)
 * by name; blendshape names that don't exist on the mesh are silently
 * skipped (graceful fallback for meshes without full ARKit shape sets).
 *
 * SSR-safe: pure-TS + THREE types; no window/document.
 *
 * Public API:
 *   - new FacialBlendshapeRig(mesh, opts?) — bind to a morphed mesh.
 *   - .setEmotion(name, weight?, fadeMs?) — blend to an emotion preset.
 *   - .playLipSync(visemes, durationSec) — play a viseme timeline.
 *   - .stopLipSync() — cancel the running lip-sync action.
 *   - .triggerMicroexpression(name) — fire a one-shot microexpression.
 *   - .setBlendshape(name, weight) — directly set a single shape.
 *   - .tick(dt) — advance internal lerp state (call when no mixer).
 *   - .dispose() — release mixer action handles.
 */

import * as THREE from "three";

// ───────────────────────────────────────────────────────────────────────────
// Blendshape names (ARKit-compatible 52 + custom)
// ───────────────────────────────────────────────────────────────────────────

export const ARKIT_BLENDSHAPES = [
  // Brow
  "BrowInnerUp", "BrowDownLeft", "BrowDownRight", "BrowOuterUpLeft", "BrowOuterUpRight",
  // Cheek
  "CheekPuff", "CheekSquintLeft", "CheekSquintRight",
  // Eye
  "EyeBlinkLeft", "EyeBlinkRight", "EyeLookInLeft", "EyeLookInRight",
  "EyeLookOutLeft", "EyeLookOutRight", "EyeLookUpLeft", "EyeLookUpRight",
  "EyeLookDownLeft", "EyeLookDownRight", "EyeSquintLeft", "EyeSquintRight",
  "EyeWideLeft", "EyeWideRight",
  // Jaw
  "JawOpen", "JawForward", "JawLeft", "JawRight",
  // Mouth
  "MouthClose", "MouthFunnel", "MouthPucker", "MouthLeft", "MouthRight",
  "MouthRollLower", "MouthRollUpper", "MouthShrugLower", "MouthShrugUpper",
  "MouthPressLeft", "MouthPressRight", "MouthLowerDownLeft", "MouthLowerDownRight",
  "MouthUpperUpLeft", "MouthUpperUpRight",
  "MouthFrownLeft", "MouthFrownRight", "MouthSmileLeft", "MouthSmileRight",
  "MouthDimpleLeft", "MouthDimpleRight", "MouthStretchLeft", "MouthStretchRight",
  // Nose
  "NoseSneerLeft", "NoseSneerRight",
] as const;

export type ARKitBlendshape = (typeof ARKIT_BLENDSHAPES)[number];

/** Custom (non-ARKit) shapes for Project Reality-specific microexpressions. */
export const CUSTOM_BLENDSHAPES = [
  "EyeDart",    // quick lateral eye movement (stress indicator)
  "Sweat",      // forehead sweat sheen
  "Dirt",       // dirt streak intensity
  "Bleeding",   // blood drip from mouth/nose
] as const;
export type CustomBlendshape = (typeof CUSTOM_BLENDSHAPES)[number];

export type BlendshapeName = ARKitBlendshape | CustomBlendshape | string;

// ───────────────────────────────────────────────────────────────────────────
// Emotion presets
// ───────────────────────────────────────────────────────────────────────────

export type EmotionName =
  | "calm" | "joy" | "anger" | "fear" | "surprise"
  | "sadness" | "disgust" | "pain" | "dead" | "shellshock";

/** Emotion presets — partial blendshape weight maps. Weights are in 0..1.
 *  Missing shapes default to 0 (the rig does NOT clear unrelated shapes
 *  automatically; callers should layer emotions or call .clearEmotion()
 *  first). */
export const EMOTION_PRESETS: Record<EmotionName, Partial<Record<BlendshapeName, number>>> = {
  calm: {
    EyeBlinkLeft: 0.05, EyeBlinkRight: 0.05,
    MouthSmileLeft: 0.08, MouthSmileRight: 0.08,
  },
  joy: {
    MouthSmileLeft: 0.9, MouthSmileRight: 0.9,
    CheekSquintLeft: 0.6, CheekSquintRight: 0.6,
    EyeSquintLeft: 0.4, EyeSquintRight: 0.4,
    BrowInnerUp: 0.3,
  },
  anger: {
    BrowDownLeft: 0.9, BrowDownRight: 0.9,
    MouthPressLeft: 0.5, MouthPressRight: 0.5,
    JawForward: 0.3,
    NoseSneerLeft: 0.2, NoseSneerRight: 0.2,
    EyeSquintLeft: 0.5, EyeSquintRight: 0.5,
  },
  fear: {
    EyeWideLeft: 0.9, EyeWideRight: 0.9,
    BrowInnerUp: 0.9, BrowOuterUpLeft: 0.6, BrowOuterUpRight: 0.6,
    JawOpen: 0.4,
    MouthStretchLeft: 0.5, MouthStretchRight: 0.5,
  },
  surprise: {
    EyeWideLeft: 1.0, EyeWideRight: 1.0,
    BrowInnerUp: 1.0, BrowOuterUpLeft: 0.8, BrowOuterUpRight: 0.8,
    JawOpen: 0.7,
    MouthFunnel: 0.4,
  },
  sadness: {
    BrowInnerUp: 0.5, BrowDownLeft: 0.3, BrowDownRight: 0.3,
    MouthFrownLeft: 0.7, MouthFrownRight: 0.7,
    MouthShrugLower: 0.4,
    EyeBlinkLeft: 0.2, EyeBlinkRight: 0.2,
  },
  disgust: {
    NoseSneerLeft: 0.8, NoseSneerRight: 0.8,
    MouthFrownLeft: 0.5, MouthFrownRight: 0.5,
    BrowDownLeft: 0.4, BrowDownRight: 0.4,
    MouthLowerDownLeft: 0.3, MouthLowerDownRight: 0.3,
  },
  pain: {
    EyeSquintLeft: 0.9, EyeSquintRight: 0.9,
    BrowDownLeft: 0.9, BrowDownRight: 0.9,
    MouthPressLeft: 0.7, MouthPressRight: 0.7,
    JawOpen: 0.3,
    NoseSneerLeft: 0.4, NoseSneerRight: 0.4,
    Bleeding: 0.5,
  },
  dead: {
    EyeBlinkLeft: 1.0, EyeBlinkRight: 1.0,
    MouthShrugLower: 0.6,
    JawOpen: 0.2,
    Bleeding: 0.8,
  },
  shellshock: {
    EyeWideLeft: 0.8, EyeWideRight: 0.8,
    EyeDart: 0.7,
    MouthOpen: 0.3,
    JawOpen: 0.2,
    Sweat: 0.9,
  } as Partial<Record<BlendshapeName, number>>,
};

// ───────────────────────────────────────────────────────────────────────────
// Visemes (15) — phoneme-based mouth shapes for lip-sync
// ───────────────────────────────────────────────────────────────────────────

export type VisemeName =
  | "sil" | "PP" | "FF" | "TH" | "DD" | "kk"
  | "CH" | "SS" | "nn" | "RR" | "aa" | "E"
  | "I" | "O" | "U";

/** Map each viseme to a partial blendshape weight set. */
export const VISEME_SHAPES: Record<VisemeName, Partial<Record<BlendshapeName, number>>> = {
  sil: { MouthClose: 0.4, MouthSmileLeft: 0.05, MouthSmileRight: 0.05 },
  PP: { MouthPressLeft: 0.9, MouthPressRight: 0.9, MouthClose: 0.7 },
  FF: { MouthFunnel: 0.6, MouthLowerDownLeft: 0.3, MouthLowerDownRight: 0.3 },
  TH: { JawOpen: 0.2, MouthFunnel: 0.3, TongueOut: 0.6 },
  DD: { JawOpen: 0.3, MouthShrugLower: 0.4 },
  kk: { JawOpen: 0.25, MouthFunnel: 0.3 },
  CH: { MouthPucker: 0.6, JawOpen: 0.2 },
  SS: { MouthSmileLeft: 0.4, MouthSmileRight: 0.4, MouthFunnel: 0.2 },
  nn: { JawOpen: 0.2, MouthShrugLower: 0.3 },
  RR: { MouthPucker: 0.7, MouthFunnel: 0.3 },
  aa: { JawOpen: 0.8, MouthLowerDownLeft: 0.5, MouthLowerDownRight: 0.5 },
  E: { MouthSmileLeft: 0.5, MouthSmileRight: 0.5, JawOpen: 0.2 },
  I: { MouthSmileLeft: 0.6, MouthSmileRight: 0.6, MouthStretchLeft: 0.4, MouthStretchRight: 0.4 },
  O: { MouthPucker: 0.8, JawOpen: 0.3 },
  U: { MouthPucker: 0.95, MouthFunnel: 0.4 },
};

// ───────────────────────────────────────────────────────────────────────────
// Microexpressions (one-shot)
// ───────────────────────────────────────────────────────────────────────────

export type MicroexpressionName =
  | "painFlinch" | "eyeDart" | "browFurrow" | "twitch"
  | "blink" | "doubleBlink" | "snarl";

export interface MicroexpressionDef {
  duration: number; // seconds
  shapes: { name: BlendshapeName; peak: number }[];
  /** Curve type for the shape envelope. */
  curve?: "spike" | "easeInOut";
}

export const MICROEXPRESSIONS: Record<MicroexpressionName, MicroexpressionDef> = {
  painFlinch: {
    duration: 0.35,
    shapes: [
      { name: "EyeSquintLeft", peak: 1.0 },
      { name: "EyeSquintRight", peak: 1.0 },
      { name: "BrowDownLeft", peak: 0.9 },
      { name: "BrowDownRight", peak: 0.9 },
      { name: "MouthPressLeft", peak: 0.7 },
      { name: "MouthPressRight", peak: 0.7 },
    ],
    curve: "spike",
  },
  eyeDart: {
    duration: 0.25,
    shapes: [
      { name: "EyeLookInLeft", peak: 0.8 },
      { name: "EyeLookOutRight", peak: 0.8 },
      { name: "EyeDart", peak: 1.0 },
    ],
    curve: "spike",
  },
  browFurrow: {
    duration: 0.4,
    shapes: [
      { name: "BrowDownLeft", peak: 0.8 },
      { name: "BrowDownRight", peak: 0.8 },
      { name: "NoseSneerLeft", peak: 0.4 },
      { name: "NoseSneerRight", peak: 0.4 },
    ],
    curve: "easeInOut",
  },
  twitch: {
    duration: 0.15,
    shapes: [{ name: "EyeBlinkLeft", peak: 0.9 }],
    curve: "spike",
  },
  blink: {
    duration: 0.12,
    shapes: [
      { name: "EyeBlinkLeft", peak: 1.0 },
      { name: "EyeBlinkRight", peak: 1.0 },
    ],
    curve: "spike",
  },
  doubleBlink: {
    duration: 0.25,
    shapes: [
      { name: "EyeBlinkLeft", peak: 1.0 },
      { name: "EyeBlinkRight", peak: 1.0 },
    ],
    curve: "easeInOut",
  },
  snarl: {
    duration: 0.4,
    shapes: [
      { name: "NoseSneerLeft", peak: 0.9 },
      { name: "NoseSneerRight", peak: 0.9 },
      { name: "MouthFrownLeft", peak: 0.6 },
      { name: "MouthFrownRight", peak: 0.6 },
      { name: "JawForward", peak: 0.4 },
    ],
    curve: "easeInOut",
  },
};

// ───────────────────────────────────────────────────────────────────────────
// FacialBlendshapeRig class
// ───────────────────────────────────────────────────────────────────────────

export interface FacialRigOptions {
  /** Optional external mixer (if the host already has one). If omitted,
   *  the rig creates its own mixer bound to the mesh. */
  mixer?: THREE.AnimationMixer;
  /** Default emotion fade time (seconds). */
  defaultFadeSec?: number;
  /** Microexpression idle frequency — chance per second of a random
   *  blink / eye-dart. 0 disables idle microexpressions. */
  idleMicroRate?: number;
}

export class FacialBlendshapeRig {
  private mesh: THREE.Mesh;
  private mixer: THREE.AnimationMixer;
  private ownMixer: boolean;
  private morphDict: Map<string, number> = new Map(); // name → morphTargetIndex
  private currentEmotion: EmotionName | null = null;
  private emotionWeight = 1.0;
  private lipSyncAction: THREE.AnimationAction | null = null;
  private microActions: THREE.AnimationAction[] = [];
  private defaultFade: number;
  private idleMicroRate: number;
  private idleTimer = 0;
  private disposed = false;

  constructor(mesh: THREE.Mesh, opts: FacialRigOptions = {}) {
    this.mesh = mesh;
    this.defaultFade = opts.defaultFadeSec ?? 0.2;
    this.idleMicroRate = opts.idleMicroRate ?? 0.5;
    // Build morph-target dictionary.
    const morphs = mesh.morphTargetDictionary;
    const dict = morphs ?? {};
    for (const [name, idx] of Object.entries(dict)) {
      this.morphDict.set(name, idx as number);
    }
    // Mixer — own or shared.
    if (opts.mixer) {
      this.mixer = opts.mixer;
      this.ownMixer = false;
    } else {
      this.mixer = new THREE.AnimationMixer(mesh);
      this.ownMixer = true;
    }
  }

  /** Returns true if a blendshape exists on this mesh. */
  hasBlendshape(name: BlendshapeName): boolean {
    return this.morphDict.has(name);
  }

  /** Directly set a single blendshape weight (0..1). No-op if shape
   *  doesn't exist on the mesh. */
  setBlendshape(name: BlendshapeName, weight: number): void {
    const idx = this.morphDict.get(name);
    if (idx === undefined) return;
    const infl = this.mesh.morphTargetInfluences;
    if (!infl) return;
    infl[idx] = Math.max(0, Math.min(1, weight));
  }

  /** Get the current weight of a blendshape (0 if absent). */
  getBlendshape(name: BlendshapeName): number {
    const idx = this.morphDict.get(name);
    if (idx === undefined) return 0;
    return this.mesh.morphTargetInfluences?.[idx] ?? 0;
  }

  /** Blend toward an emotion preset. Weight 0..1 controls the intensity;
   *  fadeSec is the crossfade time (default 0.2s). */
  setEmotion(
    emotion: EmotionName,
    weight: number = 1.0,
    fadeSec?: number,
  ): void {
    if (this.disposed) return;
    const fade = fadeSec ?? this.defaultFade;
    this.currentEmotion = emotion;
    this.emotionWeight = weight;
    const preset = EMOTION_PRESETS[emotion];
    // For each shape in the preset, lerp toward target*weight.
    // For shapes NOT in the preset but in the rig, lerp toward 0 (so
    // switching from "joy" to "anger" properly clears the smile).
    const shapesToClear = new Set<string>();
    for (const name of this.morphDict.keys()) {
      if (!(name in preset)) shapesToClear.add(name);
    }
    const startWeights = new Map<string, number>();
    for (const name of [...Object.keys(preset), ...shapesToClear]) {
      startWeights.set(name, this.getBlendshape(name));
    }
    // Build a tiny one-shot clip that drives these shapes over `fade` sec.
    const tracks: THREE.KeyframeTrack[] = [];
    for (const name of [...Object.keys(preset), ...shapesToClear]) {
      const idx = this.morphDict.get(name);
      if (idx === undefined) continue;
      const target = (preset[name] ?? 0) * weight;
      const start = startWeights.get(name) ?? 0;
      tracks.push(
        new THREE.NumberKeyframeTrack(
          `.morphTargetInfluences[${idx}]`,
          [0, fade],
          [start, target],
        ),
      );
    }
    if (tracks.length === 0) return;
    const clip = new THREE.AnimationClip(`emotion_${emotion}`, fade, tracks);
    const action = this.mixer.clipAction(clip, this.mesh);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.reset().play();
    // Stop any prior emotion action (we keep them in microActions list
    // but with a "emotion" tag — simplest: just let them finish; the new
    // action's clampWhenFinished will overwrite at end).
  }

  /** Reset all blendshapes to 0 over fadeSec. */
  clearEmotion(fadeSec?: number): void {
    if (this.disposed) return;
    const fade = fadeSec ?? this.defaultFade;
    this.currentEmotion = null;
    const tracks: THREE.KeyframeTrack[] = [];
    for (const [name, idx] of this.morphDict) {
      const start = this.getBlendshape(name);
      if (start === 0) continue;
      tracks.push(
        new THREE.NumberKeyframeTrack(
          `.morphTargetInfluences[${idx}]`,
          [0, fade],
          [start, 0],
        ),
      );
    }
    if (tracks.length === 0) return;
    const clip = new THREE.AnimationClip("emotion_clear", fade, tracks);
    const action = this.mixer.clipAction(clip, this.mesh);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.reset().play();
  }

  /** Play a viseme timeline as a lip-sync animation. */
  playLipSync(
    visemes: { viseme: VisemeName; time: number; duration: number }[],
    totalDurationSec?: number,
  ): void {
    if (this.disposed) return;
    this.stopLipSync();
    if (visemes.length === 0) return;
    // Build a KeyframeTrack per blendshape touched by any viseme.
    // Each viseme contributes a triangular envelope: 0 → peak → 0 over
    // its duration, centered at `time`.
    const touched = new Set<BlendshapeName>();
    for (const v of visemes) {
      const shapes = VISEME_SHAPES[v.viseme];
      for (const k of Object.keys(shapes)) touched.add(k);
    }
    const tracks: THREE.KeyframeTrack[] = [];
    const total =
      totalDurationSec ??
      Math.max(...visemes.map((v) => v.time + v.duration)) + 0.05;
    for (const shapeName of touched) {
      const idx = this.morphDict.get(shapeName);
      if (idx === undefined) continue;
      // For each viseme that touches this shape, add a triangular envelope.
      const keyframes: { t: number; v: number }[] = [];
      for (const v of visemes) {
        const shapes = VISEME_SHAPES[v.viseme];
        const peak = shapes[shapeName] ?? 0;
        if (peak === 0) continue;
        const start = Math.max(0, v.time);
        const mid = v.time + v.duration * 0.5;
        const end = Math.min(total, v.time + v.duration);
        keyframes.push({ t: start, v: 0 });
        keyframes.push({ t: mid, v: peak });
        keyframes.push({ t: end, v: 0 });
      }
      if (keyframes.length === 0) continue;
      keyframes.sort((a, b) => a.t - b.t);
      // Merge duplicate timestamps by keeping the max.
      const merged: { t: number; v: number }[] = [];
      for (const k of keyframes) {
        const last = merged[merged.length - 1];
        if (last && Math.abs(last.t - k.t) < 1e-4) {
          last.v = Math.max(last.v, k.v);
        } else {
          merged.push({ ...k });
        }
      }
      const times = new Float32Array(merged.map((k) => k.t));
      const values = new Float32Array(merged.map((k) => k.v));
      tracks.push(
        new THREE.NumberKeyframeTrack(
          `.morphTargetInfluences[${idx}]`,
          times,
          values,
        ),
      );
    }
    if (tracks.length === 0) return;
    const clip = new THREE.AnimationClip("lipsync", total, tracks);
    const action = this.mixer.clipAction(clip, this.mesh);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.reset().play();
    this.lipSyncAction = action;
  }

  /** Stop any running lip-sync action immediately. */
  stopLipSync(): void {
    if (this.lipSyncAction) {
      this.lipSyncAction.stop();
      this.lipSyncAction.reset();
      this.mixer.uncacheAction(this.lipSyncAction.getClip());
      this.lipSyncAction = null;
    }
  }

  /** Fire a one-shot microexpression on top of the active emotion. */
  triggerMicroexpression(name: MicroexpressionName): void {
    if (this.disposed) return;
    const def = MICROEXPRESSIONS[name];
    if (!def) return;
    const tracks: THREE.KeyframeTrack[] = [];
    const start = this.mixer.time;
    for (const shape of def.shapes) {
      const idx = this.morphDict.get(shape.name);
      if (idx === undefined) continue;
      const baseline = this.getBlendshape(shape.name);
      const peak = Math.min(1, baseline + shape.peak);
      let env: number[];
      if (def.curve === "spike") {
        // Fast attack (25%), slow release (75%).
        env = [
          baseline,
          peak,
          peak * 0.5,
          baseline,
        ];
      } else {
        // easeInOut — symmetric triangle.
        env = [baseline, peak, baseline];
      }
      const times = def.curve === "spike"
        ? [start, start + def.duration * 0.25, start + def.duration * 0.6, start + def.duration]
        : [start, start + def.duration * 0.5, start + def.duration];
      tracks.push(
        new THREE.NumberKeyframeTrack(
          `.morphTargetInfluences[${idx}]`,
          times,
          env,
        ),
      );
    }
    if (tracks.length === 0) return;
    const clip = new THREE.AnimationClip(`micro_${name}`, def.duration, tracks);
    const action = this.mixer.clipAction(clip, this.mesh);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.reset().play();
    this.microActions.push(action);
    // Trim finished micro actions.
    this.microActions = this.microActions.filter((a) => a.isRunning());
  }

  /** Advance the rig's internal state. Call this each frame with the
   *  delta time. If you're using a shared mixer, the host already calls
   *  mixer.update(dt) — but tick() also drives the idle microexpression
   *  RNG, so call it regardless. */
  tick(dt: number): void {
    if (this.disposed) return;
    if (this.ownMixer) this.mixer.update(dt);
    // Idle microexpressions (random blinks / eye-darts).
    if (this.idleMicroRate > 0) {
      this.idleTimer += dt;
      // Probability of firing this frame ≈ rate * dt.
      if (Math.random() < this.idleMicroRate * dt) {
        const r = Math.random();
        if (r < 0.7) this.triggerMicroexpression("blink");
        else if (r < 0.9) this.triggerMicroexpression("eyeDart");
        else this.triggerMicroexpression("browFurrow");
      }
    }
  }

  /** Get the active emotion (or null). */
  getActiveEmotion(): EmotionName | null {
    return this.currentEmotion;
  }

  /** Release mixer + actions. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLipSync();
    for (const a of this.microActions) {
      a.stop();
      this.mixer.uncacheAction(a.getClip());
    }
    this.microActions = [];
    if (this.ownMixer) this.mixer.uncacheRoot(this.mesh);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Phoneme → Viseme helper (very simple English approximation)
// ───────────────────────────────────────────────────────────────────────────

const PHONEME_TO_VISEME: Record<string, VisemeName> = {
  AA: "aa", AE: "aa", AH: "aa", AO: "O", AW: "O", AY: "aa",
  EH: "E", ER: "RR", EY: "E",
  IH: "I", IY: "I",
  OW: "O", OY: "O",
  UH: "U", UW: "U",
  B: "PP", P: "PP", M: "PP",
  F: "FF", V: "FF",
  TH: "TH", DH: "TH",
  T: "DD", D: "DD", N: "nn", L: "nn",
  K: "kk", G: "kk", NG: "kk",
  CH: "CH", JH: "CH", SH: "SS", ZH: "SS",
  S: "SS", Z: "SS",
  R: "RR",
  W: "U", Y: "I",
  HH: "sil",
  "_": "sil",
};

/** Convert a phoneme string timeline (e.g. from a TTS engine) into a
 *  viseme timeline suitable for playLipSync. Each phoneme is given an
 *  equal duration unless overridden. */
export function phonemesToVisemes(
  phonemes: string[],
  perPhonemeSec = 0.08,
): { viseme: VisemeName; time: number; duration: number }[] {
  const out: { viseme: VisemeName; time: number; duration: number }[] = [];
  let t = 0;
  for (const p of phonemes) {
    const v = PHONEME_TO_VISEME[p.toUpperCase()] ?? "sil";
    out.push({ viseme: v, time: t, duration: perPhonemeSec });
    t += perPhonemeSec;
  }
  return out;
}
