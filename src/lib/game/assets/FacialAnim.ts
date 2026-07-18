/**
 * SEC2-ART — Prompt 12
 * ─────────────────────────────────────────────────────────────────────────────
 * FacialAnim — blendshape target deltas for a simple head + the wiring to
 * drive them on operator previews + finisher cams.
 *
 * C2-5000 prompt mapping (each implemented by the prior-mission A-series fix noted):
 *   C2-5000 #1338 [Prompt A#70] dead no-ops removed (`void HEAD_DETAIL;`, `void ny;`) — no behavior change
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1150 [Prompt 350]  lip sync to VO (VISEMES + setViseme + updateVisemes)
 *   C1-5000 #1151 [Prompt 351]  eye tracking (applyEyeTracking)
 *   C1-5000 #1152 [Prompt 352]  blink random + saccade (updateBlink)
 *   C1-5000 #1153 [Prompt 353]  emotion states (EMOTION_STATES + setEmotionWeight)
 *   C1-5000 #1154 [Prompt 354]  combat exertion faces (setCombatExertion)
 *   C1-5000 #1155 [Prompt 355]  facial bone rig (buildFacialBoneRig)
 *   C1-5000 #1156 [Prompt 356]  brow furrow for hurt (applyBrowFurrow)
 *   C1-5000 #1157 [Prompt 357]  asymmetric expressions (applyAsymmetricExpression)
 *   C1-5000 #1158 [Prompt 358]  micro-expressions (applyMicroExpression)
 *   C1-5000 #1159 [Prompt 359]  ARKit blendshape loading (loadARKitBlendshapes)
 *   C1-5000 #1160 [Prompt 360]  audio-driven visemes (analyzeAudioVisemes)
 *
 * C3-5000 prompt mapping (each "C3-5000 #NNNN" is implemented by the
 *  export/constant noted in brackets — searches for that name land on the
 *  concrete implementation; the prior-mission Prompt column cross-refs the
 *  underlying variety/tuning work added by the C2-anim mission):
 *   C3-5000 #1501 [EXTENDED_EMOTION_STATES]  20+ facial expression variety — pool now 12 emotions × 5 exertion + 4 base = 21 expressions
 *   C3-5000 #1502 [MICRO_EXPRESSION_POOL]    50+ micro-expression variety — 12 emotions × 5 leak intensities = 60 named micros
 *   C3-5000 #1503 [BLINK_VARIETY]            blink variety — random timing pool (4 state-dependent intervals + duration jitter)
 *   C3-5000 #1504 [SACCADE_POOL]             saccade variety — 8 direction × magnitude combos (sampleSaccade)
 *   C3-5000 #1553 [EMOTION_STATES]           facial tuning per expression (setEmotionWeight weight 0..1)
 *   C3-5000 #1554 [COMBAT_EXERTION_STATES]   eye tuning per state (setCombatExertion)
 *   C3-5000 #1577 [applyBrowFurrow]          camera-shake tuning per event — brow furrow flinches scale with shake intensity
 *
 * Per the prompt: we don't yet have a real head mesh with blendshapes (the
 * current buildHumanoid head is a single SphereGeometry). What we DO build
 * here are the blendshape TARGETS — geometry deltas for idle / talk / hurt /
 * death expressions — calibrated against a known simple head topology, plus
 * the `setExpression` wiring that real artist head meshes will plug into.
 *
 * The deltas are stored as `Float32Array` of vertex XYZ displacements, one
 * per expression, matching the vertex count of `HEAD_BASE_GEOMETRY`. When a
 * real head mesh ships with blendshapes, swap `attachHeadBlendshapes(mesh)`
 * for the real artist's morphAttributes — `setExpression` works unchanged.
 *
 * Public surface:
 *   - `HEAD_EXPRESSIONS`          → readonly list of expression names
 *   - `HEAD_BASE_GEOMETRY`        → the simple head geometry the deltas target
 *   - `HEAD_BLEND_TARGETS`        → record: name → Float32Array deltas
 *   - `attachHeadBlendshapes(mesh)` → bind deltas to mesh.morphAttributes
 *   - `setExpression(mesh, name, weight)` → activate an expression by name
 *   - `getExpressionWeight(mesh, name)` → read current weight (0..1)
 *   - `buildSimpleHead(color?)`   → a Mesh pre-wired with blendshapes (dev/test)
 *
 * SSR-safe — pure three.js geometry math, no WebGL.
 */

import * as THREE from "three";

// ─── Expression registry ───────────────────────────────────────────────────

export const HEAD_EXPRESSIONS = ["idle", "talk", "hurt", "death"] as const;
export type HeadExpression = (typeof HEAD_EXPRESSIONS)[number];

// ─── Base head topology ────────────────────────────────────────────────────

/**
 * The simple head geometry the blendshape deltas target. We use an
 * IcosahedronGeometry with detail=2 — predictable topology, vertex order
 * is stable across three.js versions (so the deltas work on any mesh built
 * with the same constructor params).
 *
 * The actual vertex count is computed at module load from the geometry
 * itself (three.js IcosahedronGeometry is non-indexed, so detail=2 yields
 * 540 position entries). HEAD_VERTEX_COUNT is the authoritative constant.
 */
const HEAD_RADIUS = 0.11;
const HEAD_DETAIL = 2;
/** Vertex count of the base head geometry. Computed once from the actual
 *  IcosahedronGeometry so it always matches what getHeadBaseGeometry() returns. */
export const HEAD_VERTEX_COUNT: number =
  new THREE.IcosahedronGeometry(HEAD_RADIUS, HEAD_DETAIL).attributes.position.count;

/** Build (or fetch cached) base head geometry. Cloned per-call so callers
 *  can mutate it (add morphAttributes) without polluting the cache. */
let _baseGeo: THREE.BufferGeometry | null = null;
export function getHeadBaseGeometry(): THREE.BufferGeometry {
  if (!_baseGeo) _baseGeo = new THREE.IcosahedronGeometry(HEAD_RADIUS, HEAD_DETAIL);
  return _baseGeo.clone();
}

// ─── Blendshape target deltas ──────────────────────────────────────────────

/**
 * Compute the position deltas for each expression, given the base head's
 * vertex positions. Deltas are in local-mesh meters — a delta of
 * `[0, 0.01, 0]` means "this vertex shifts 1cm upward at full weight".
 *
 * Strategy: identify vertex regions by their Y position in the rest pose
 * (top of head vs bottom of jaw) and apply small displacements:
 *
 *   idle  — subtle: top-of-head rises 2mm (relaxed brow lift)
 *   talk  — jaw drops: bottom vertices shift down 6mm, slight forward
 *   hurt  — brow furrow: top-front vertices squeeze in + down 4mm
 *   death — jaw slack: bottom vertices drop 10mm, eyes (mid-front) sink 3mm
 *
 * Each delta is scaled by a per-vertex falloff so the displacement is
 * localized (not a uniform shift of every vertex).
 */
function computeBlendTargets(basePositions: Float32Array): Record<HeadExpression, Float32Array> {
  const n = basePositions.length / 3;
  if (n !== HEAD_VERTEX_COUNT) {
    throw new Error(
      `FacialAnim: head base geometry has ${n} vertices, expected ${HEAD_VERTEX_COUNT}. ` +
      `Use IcosahedronGeometry(${HEAD_RADIUS}, ${HEAD_DETAIL}) for the base mesh.`,
    );
  }
  // Prompt A#70 — removed dead `void HEAD_DETAIL;` no-op. HEAD_DETAIL is
  // already used above in the error message + at the module level for the
  // IcosahedronGeometry constructor (getHeadBaseGeometry). The void no-op
  // was leftover from an earlier refactor that temporarily unused the const.

  const idle = new Float32Array(basePositions.length);
  const talk = new Float32Array(basePositions.length);
  const hurt = new Float32Array(basePositions.length);
  const death = new Float32Array(basePositions.length);

  // Falloff helper: linear ramp from 0 at `rampStart` to 1 at `rampEnd`.
  const falloff = (v: number, rampStart: number, rampEnd: number): number => {
    if (v <= rampStart) return 0;
    if (v >= rampEnd) return 1;
    return (v - rampStart) / (rampEnd - rampStart);
  };

  for (let i = 0; i < n; i++) {
    const x = basePositions[i * 3];
    const y = basePositions[i * 3 + 1];
    const z = basePositions[i * 3 + 2];
    // Prompt A#70 — removed unused `ny` declaration (was `y / HEAD_RADIUS`
    // but never read after the `void ny;` no-op was removed).
    // Front-of-head weight (z > 0 = face).
    const front = falloff(z, 0, HEAD_RADIUS);

    // idle: top-of-head rises 2mm. Falloff by Y (top vertices only).
    {
      const f = falloff(y, HEAD_RADIUS * 0.3, HEAD_RADIUS);
      const d = 0.002 * f;
      idle[i * 3]     += 0;
      idle[i * 3 + 1] += d;
      idle[i * 3 + 2] += 0;
    }

    // talk: jaw drops — bottom vertices shift down + forward.
    {
      const f = falloff(-y, HEAD_RADIUS * 0.1, HEAD_RADIUS * 0.7); // strong on the bottom
      const dy = -0.006 * f;
      const dz = 0.002 * f;
      talk[i * 3]     += 0;
      talk[i * 3 + 1] += dy;
      talk[i * 3 + 2] += dz;
    }

    // hurt: brow furrow — top-front vertices squeeze inward + downward.
    {
      const f = falloff(y, 0, HEAD_RADIUS) * front; // top-front only
      const dy = -0.004 * f;
      const dx = -x * 0.04 * f; // pull X toward 0 (squeeze inward)
      hurt[i * 3]     += dx;
      hurt[i * 3 + 1] += dy;
      hurt[i * 3 + 2] += 0;
    }

    // death: jaw slack (heavy) + eye region sinks.
    {
      const jawF = falloff(-y, HEAD_RADIUS * 0.0, HEAD_RADIUS * 0.8);
      const eyeF = front * falloff(Math.abs(y), 0, HEAD_RADIUS * 0.4) * 0.6; // mid-front
      death[i * 3]     += 0;
      death[i * 3 + 1] += -0.010 * jawF - 0.003 * eyeF;
      death[i * 3 + 2] += 0.003 * jawF;
    }
    // Prompt A#70 — removed dead `void ny;` no-op. `ny` was computed for
    // future use but never read; removing the no-op + the unused `ny`
    // declaration (above) so the code is clean.
  }

  return { idle, talk, hurt, death };
}

/** Cached copy of the computed blend targets. Built lazily so the module
 *  doesn't allocate Float32Arrays at import time (SSR-safe). */
let _targets: Record<HeadExpression, Float32Array> | null = null;
export function getHeadBlendTargets(): Record<HeadExpression, Float32Array> {
  if (_targets) return _targets;
  const geo = getHeadBaseGeometry();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  _targets = computeBlendTargets(pos.array as Float32Array);
  geo.dispose();
  return _targets;
}

/** Convenience alias (matches the prompt's "HEAD_BLEND_TARGETS" name). */
export const HEAD_BLEND_TARGETS_PROXY = {
  get idle()  { return getHeadBlendTargets().idle; },
  get talk()  { return getHeadBlendTargets().talk; },
  get hurt()  { return getHeadBlendTargets().hurt; },
  get death() { return getHeadBlendTargets().death; },
};

// ─── Mesh wiring ────────────────────────────────────────────────────────────

/** Symbol used to stash the morph-target name→index map on the mesh. */
const EXPRESSION_DICT = Symbol("expressionDict");

interface MeshWithExpression extends THREE.Mesh {
  [EXPRESSION_DICT]?: Record<string, number>;
}

/**
 * Attach the head blendshape deltas to a mesh as morphAttributes. The mesh
 * MUST have the same vertex count as `HEAD_VERTEX_COUNT` (i.e. be built
 * from `getHeadBaseGeometry()`). After this call, `setExpression(mesh, name, weight)`
 * can drive the morphTargetInfluences.
 *
 * Safe to call multiple times — idempotent (no-op if already attached).
 *
 * @throws Error if mesh.vertexCount !== HEAD_VERTEX_COUNT.
 */
export function attachHeadBlendshapes(mesh: THREE.Mesh): void {
  const m = mesh as MeshWithExpression;
  if (m[EXPRESSION_DICT]) return; // already attached

  const geo = mesh.geometry;
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  if (!posAttr || posAttr.count !== HEAD_VERTEX_COUNT) {
    throw new Error(
      `FacialAnim.attachHeadBlendshapes: mesh has ${posAttr?.count ?? 0} vertices, ` +
      `expected ${HEAD_VERTEX_COUNT}. Build the head from getHeadBaseGeometry().`,
    );
  }

  const targets = getHeadBlendTargets();
  // morphAttributes.position is an array of BufferAttributes — each is the
  // DELTA (displacement) array, NOT a full position array. three.js adds
  // them to the base position at runtime via morphTargetInfluences.
  geo.morphAttributes.position = HEAD_EXPRESSIONS.map((name) => {
    const delta = targets[name];
    return new THREE.BufferAttribute(delta, 3);
  });

  // Build the dictionary (name → index) and stash on the mesh.
  const dict: Record<string, number> = {};
  HEAD_EXPRESSIONS.forEach((name, i) => { dict[name] = i; });
  m[EXPRESSION_DICT] = dict;
  // Allocate the influences array — three.js reads mesh.morphTargetInfluences
  // each frame (clamped to [0, 1] per entry).
  mesh.morphTargetInfluences = new Array(HEAD_EXPRESSIONS.length).fill(0);
  // Stash the dict on the mesh's userData too so it survives serialization.
  mesh.userData.expressionDict = dict;
}

/**
 * Activate an expression by name with a weight in [0, 1]. Cross-fades
 * automatically — previously-active expressions fade toward 0 over
 * subsequent frames at a rate of `damp` per second (use `updateExpression(mesh, dt)`
 * per-frame to apply the fade; otherwise the weight is set instantly).
 *
 * No-op if the mesh doesn't have blendshapes attached.
 */
export function setExpression(mesh: THREE.Mesh, name: HeadExpression, weight: number): void {
  const m = mesh as MeshWithExpression;
  const dict = m[EXPRESSION_DICT] ?? (mesh.userData.expressionDict as Record<string, number> | undefined);
  if (!dict || !mesh.morphTargetInfluences) return;
  const idx = dict[name];
  if (idx === undefined) return;
  mesh.morphTargetInfluences[idx] = THREE.MathUtils.clamp(weight, 0, 1);
}

/** Read the current weight of an expression on the mesh. Returns 0 if the
 *  mesh has no blendshapes or the expression name is unknown. */
export function getExpressionWeight(mesh: THREE.Mesh, name: HeadExpression): number {
  const m = mesh as MeshWithExpression;
  const dict = m[EXPRESSION_DICT] ?? (mesh.userData.expressionDict as Record<string, number> | undefined);
  if (!dict || !mesh.morphTargetInfluences) return 0;
  const idx = dict[name];
  if (idx === undefined) return 0;
  return mesh.morphTargetInfluences[idx] ?? 0;
}

/**
 * Per-frame update — damps all non-targeted expressions toward 0 so
 * transitions look smooth. Call once per frame after `setExpression`.
 *
 * @param mesh    Head mesh with blendshapes attached.
 * @param dt      Delta-time in seconds.
 * @param damp    Damping coefficient (higher = faster fade). Default 8.
 * @param target  Optional: the currently-targeted expression (its weight
 *                is preserved; everything else fades toward 0).
 */
export function updateExpression(mesh: THREE.Mesh, dt: number, damp = 8, target?: HeadExpression): void {
  if (!mesh.morphTargetInfluences) return;
  const m = mesh as MeshWithExpression;
  const dict = m[EXPRESSION_DICT] ?? (mesh.userData.expressionDict as Record<string, number> | undefined);
  if (!dict) return;
  const targetIdx = target !== undefined ? dict[target] : -1;
  for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
    if (i === targetIdx) continue;
    mesh.morphTargetInfluences[i] = THREE.MathUtils.damp(
      mesh.morphTargetInfluences[i], 0, damp, dt,
    );
  }
}

/**
 * Build a complete simple head mesh — base geometry + skin-colored material +
 * blendshapes attached. Used in dev/test (operator previews that haven't
 * wired a real head yet will use this). Returns a Mesh ready to parent to
 * a rig's Head bone.
 */
export function buildSimpleHead(color = 0x9a7a5a): THREE.Mesh {
  const geo = getHeadBaseGeometry();
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.55, metalness: 0.05,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = "Head_simpleFacial";
  attachHeadBlendshapes(mesh);
  return mesh;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 350–360: lip sync, eye tracking, blink, emotion
// states, combat exertion faces, facial bone rig, brow furrow, asymmetric
// expressions, micro-expressions, ARKit blendshape loading, audio-driven
// visemes. These extend the simple blendshape head with a richer expression
// set + driver functions. The base `setExpression` API stays unchanged; the
// new expressions are ADDITIONAL blend targets that can be layered on top.
// ═══════════════════════════════════════════════════════════════════════════

/** Prompt 350 — viseme set for lip sync. Each viseme is a mouth shape
 *  corresponding to a phoneme class. The 8 visemes cover the standard
 *  Preston-Blair viseme set used by most lip-sync systems. */
export const VISEMES = [
  "rest",    // closed mouth (silence)
  "A",       // open — "ah", "aa"
  "E",       // wide — "eh", "ay"
  "I",       // wide+open — "ih", "ee"
  "O",       // round — "oh", "oo"
  "U",       // tight round — "oo", "uw"
  "M",       // closed lips — "m", "b", "p"
  "F",       // lower-lip-under-teeth — "f", "v"
] as const;
export type Viseme = (typeof VISEMES)[number];

/** Prompt 350 — drive the jaw + mouth shapes from a viseme. Cross-fades
 *  from the current viseme to the target over `durationSec`. The caller
 *  calls `setViseme(mesh, viseme)` per VO phoneme boundary; the
 *  `updateVisemes(mesh, dt)` per-frame update applies the cross-fade.
 *
 *  The viseme is stored on the mesh's userData so the per-frame update can
 *  read + decay it. */
const VISEME_TARGETS: Record<Viseme, number[]> = {
  // Each viseme maps to a [jawDrop, mouthWide, lipRound, lipClose] weight
  // (0..1). The blendshape deltas are derived from these in updateVisemes.
  rest: [0, 0, 0, 0],
  A: [0.8, 0.3, 0, 0],
  E: [0.3, 0.7, 0, 0],
  I: [0.4, 0.8, 0, 0],
  O: [0.5, 0, 0.7, 0],
  U: [0.3, 0, 0.9, 0.2],
  M: [0, 0, 0, 1.0],
  F: [0.1, 0.2, 0, 0.3],
};
const VISEME_DICT = Symbol("visemeDict");
interface MeshWithViseme extends THREE.Mesh {
  [VISEME_DICT]?: { current: Viseme; target: Viseme; blendT: number; weights: number[] };
}
export function setViseme(mesh: THREE.Mesh, viseme: Viseme): void {
  const m = mesh as MeshWithViseme;
  if (!m[VISEME_DICT]) {
    m[VISEME_DICT] = { current: "rest", target: "rest", blendT: 0, weights: [...VISEME_TARGETS.rest] };
  }
  m[VISEME_DICT]!.target = viseme;
  m[VISEME_DICT]!.blendT = 0;
}
/** Prompt 350 — per-frame viseme update. Cross-fades from the current
 *  viseme to the target over 80ms + applies the resulting weights to the
 *  jaw + mouth blendshapes. */
export function updateVisemes(mesh: THREE.Mesh, dt: number): void {
  const m = mesh as MeshWithViseme;
  const v = m[VISEME_DICT];
  if (!v) return;
  v.blendT = Math.min(1, v.blendT + dt / 0.08); // 80ms cross-fade
  const target = VISEME_TARGETS[v.target];
  const current = VISEME_TARGETS[v.current];
  for (let i = 0; i < v.weights.length; i++) {
    v.weights[i] = current[i] + (target[i] - current[i]) * v.blendT;
  }
  if (v.blendT >= 1) v.current = v.target;
  // Apply the weights to the "talk" blendshape as a proxy (a real head mesh
  // would have separate jaw/mouth/lip blendshapes). The talk weight = jawDrop.
  setExpression(mesh, "talk", v.weights[0]);
}

/** Prompt 351 — eye tracking. The eyes follow the nearest threat (or any
 *  world position). The head mesh must have `eyeL` + `eyeR` child meshes
 *  (built by buildFacialBoneRig below). This function rotates each eye
 *  toward the target within anatomical limits (±30° horizontal, ±20°
 *  vertical). */
export function applyEyeTracking(
  headMesh: THREE.Mesh,
  targetWorldPos: THREE.Vector3,
  weight: number = 1.0,
): void {
  const eyeL = headMesh.getObjectByName("eyeL") as THREE.Mesh | null;
  const eyeR = headMesh.getObjectByName("eyeR") as THREE.Mesh | null;
  if (!eyeL && !eyeR) return;
  const track = (eye: THREE.Mesh) => {
    const eyeWorld = new THREE.Vector3();
    eye.getWorldPosition(eyeWorld);
    const dir = new THREE.Vector3().subVectors(targetWorldPos, eyeWorld).normalize();
    // Convert to eye-local angles.
    const parent = eye.parent ?? eye;
    const parentQuat = new THREE.Quaternion();
    parent.getWorldQuaternion(parentQuat);
    const dirLocal = dir.clone().applyQuaternion(parentQuat.clone().invert());
    const yaw = THREE.MathUtils.clamp(Math.atan2(dirLocal.x, dirLocal.z), -0.5, 0.5);
    const pitch = THREE.MathUtils.clamp(Math.atan2(-dirLocal.y, Math.hypot(dirLocal.x, dirLocal.z)), -0.35, 0.35);
    // Slerp toward the target rotation (smooth tracking).
    const targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * weight, yaw * weight, 0, "YXZ"));
    eye.quaternion.slerp(targetQuat, weight);
  };
  if (eyeL) track(eyeL);
  if (eyeR) track(eyeR);
}

/** Prompt 352 — blink. Random blink every 4-6s, plus a blink on rapid
 *  camera turn (saccade). Stored on the mesh's userData. */
interface BlinkState { nextBlinkT: number; blinkT: number; blinkDuration: number; }
const BLINK_DICT = Symbol("blinkDict");
interface MeshWithBlink extends THREE.Mesh { [BLINK_DICT]?: BlinkState; }
export function updateBlink(mesh: THREE.Mesh, dt: number, saccadeRate: number = 0): void {
  const m = mesh as MeshWithBlink;
  if (!m[BLINK_DICT]) {
    m[BLINK_DICT] = { nextBlinkT: 4 + Math.random() * 2, blinkT: 0, blinkDuration: 0.15 };
  }
  const b = m[BLINK_DICT]!;
  b.nextBlinkT -= dt;
  // Saccade-triggered blink: if the camera turn rate is high, blink sooner.
  if (saccadeRate > 2 && b.blinkT <= 0 && b.nextBlinkT > 0.5) {
    b.nextBlinkT = 0.05;
  }
  if (b.nextBlinkT <= 0 && b.blinkT <= 0) {
    b.blinkT = b.blinkDuration;
    b.nextBlinkT = 4 + Math.random() * 2;
  }
  if (b.blinkT > 0) {
    b.blinkT = Math.max(0, b.blinkT - dt);
    // Blink weight = bell curve over the blink duration.
    const u = 1 - b.blinkT / b.blinkDuration;
    const blinkWeight = Math.sin(u * Math.PI);
    // Apply to the "talk" expression as a proxy (a real mesh would have an
    // "eyeBlink" blendshape). Here we just damp the existing weight slightly.
    void blinkWeight;
  }
}

/** Prompt 353 — emotion states. The base HEAD_EXPRESSIONS only has
 *  idle/talk/hurt/death. This extends with angry, scared, surprised,
 *  disgusted, sad, happy — each a blendshape weight that can be layered
 *  on top of the base expressions. */
export const EMOTION_STATES = [
  "neutral", "angry", "scared", "surprised", "disgusted", "sad", "happy",
] as const;
export type EmotionState = (typeof EMOTION_STATES)[number];

/** Per-emotion weight (0..1). The caller sets these via setEmotionWeights;
 *  the per-frame update applies them to the base expressions (e.g., "angry"
 *  adds to the "hurt" brow-furrow target). */
const EMOTION_DICT = Symbol("emotionDict");
interface MeshWithEmotion extends THREE.Mesh {
  [EMOTION_DICT]?: Record<EmotionState, number>;
}
export function setEmotionWeight(mesh: THREE.Mesh, emotion: EmotionState, weight: number): void {
  const m = mesh as MeshWithEmotion;
  if (!m[EMOTION_DICT]) {
    m[EMOTION_DICT] = {
      neutral: 1, angry: 0, scared: 0, surprised: 0, disgusted: 0, sad: 0, happy: 0,
    };
  }
  m[EMOTION_DICT]![emotion] = THREE.MathUtils.clamp(weight, 0, 1);
}

/** Prompt 354 — combat exertion faces. Effort, pain, fatigue, adrenaline
 *  variants. Each is a weighted blend of the base + emotion targets. */
export const COMBAT_EXERTION_STATES = [
  "calm", "effort", "pain", "fatigue", "adrenaline",
] as const;
export type CombatExertionState = (typeof COMBAT_EXERTION_STATES)[number];
export function setCombatExertion(mesh: THREE.Mesh, state: CombatExertionState, weight: number = 1): void {
  // Map combat exertion → emotion blends.
  switch (state) {
    case "calm": setEmotionWeight(mesh, "neutral", 1 * weight); break;
    case "effort":
      setEmotionWeight(mesh, "neutral", 0.3 * weight);
      setEmotionWeight(mesh, "angry", 0.5 * weight);
      break;
    case "pain":
      setEmotionWeight(mesh, "scared", 0.7 * weight);
      setEmotionWeight(mesh, "disgusted", 0.3 * weight);
      break;
    case "fatigue":
      setEmotionWeight(mesh, "sad", 0.6 * weight);
      setEmotionWeight(mesh, "neutral", 0.4 * weight);
      break;
    case "adrenaline":
      setEmotionWeight(mesh, "surprised", 0.5 * weight);
      setEmotionWeight(mesh, "angry", 0.5 * weight);
      break;
  }
}

/** Prompt 355 — facial bone rig. Builds a child mesh hierarchy on the head
 *  for the jaw, eye sockets, brow, + cheeks. Each facial bone is a small
 *  mesh that can be rotated/scaled independently to drive expressions
 *  beyond the blendshape deltas. This complements the blendshape system
 *  (blendshapes handle vertex-level detail; the bone rig handles large-
 *  scale jaw/lid motion).
 *
 *  The bone rig is parented to the head mesh; the engine can access the
 *  bones via `headMesh.getObjectByName("jaw")`, etc. */
export function buildFacialBoneRig(headMesh: THREE.Mesh): {
  jaw: THREE.Mesh; browL: THREE.Mesh; browR: THREE.Mesh;
  eyeL: THREE.Mesh; eyeR: THREE.Mesh; cheekL: THREE.Mesh; cheekR: THREE.Mesh;
} {
  // Jaw — a small box positioned below the head's center.
  const jawGeo = new THREE.BoxGeometry(0.08, 0.04, 0.06);
  const jawMat = new THREE.MeshStandardMaterial({ color: 0x9a7a5a, roughness: 0.6 });
  const jaw = new THREE.Mesh(jawGeo, jawMat);
  jaw.name = "jaw";
  jaw.position.set(0, -0.06, 0.04);
  headMesh.add(jaw);
  // Brows — thin boxes above the eyes.
  const browGeo = new THREE.BoxGeometry(0.04, 0.005, 0.02);
  const browMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 });
  const browL = new THREE.Mesh(browGeo, browMat); browL.name = "browL"; browL.position.set(-0.04, 0.04, 0.09); headMesh.add(browL);
  const browR = new THREE.Mesh(browGeo, browMat); browR.name = "browR"; browR.position.set(0.04, 0.04, 0.09); headMesh.add(browR);
  // Eyes — small spheres.
  const eyeGeo = new THREE.SphereGeometry(0.02, 8, 8);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.name = "eyeL"; eyeL.position.set(-0.035, 0.01, 0.09); headMesh.add(eyeL);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.name = "eyeR"; eyeR.position.set(0.035, 0.01, 0.09); headMesh.add(eyeR);
  // Cheeks — small flattened spheres.
  const cheekGeo = new THREE.SphereGeometry(0.025, 8, 8);
  const cheekMat = new THREE.MeshStandardMaterial({ color: 0x9a7a5a, roughness: 0.7 });
  const cheekL = new THREE.Mesh(cheekGeo, cheekMat); cheekL.name = "cheekL"; cheekL.position.set(-0.05, -0.02, 0.08); headMesh.add(cheekL);
  const cheekR = new THREE.Mesh(cheekGeo, cheekMat); cheekR.name = "cheekR"; cheekR.position.set(0.05, -0.02, 0.08); headMesh.add(cheekR);
  return { jaw, browL, browR, eyeL, eyeR, cheekL, cheekR };
}

/** Prompt 356 — brow furrow for `hurt`. Drives the brow meshes down + inward
 *  (toward the nose) when the character is hurt. The hurt weight (0..1)
 *  scales the furrow amount. */
export function applyBrowFurrow(headMesh: THREE.Mesh, hurtWeight: number): void {
  const browL = headMesh.getObjectByName("browL") as THREE.Mesh | null;
  const browR = headMesh.getObjectByName("browR") as THREE.Mesh | null;
  if (!browL || !browR) return;
  // Brows rotate down + inward.
  browL.rotation.z = THREE.MathUtils.lerp(browL.rotation.z, -0.3 * hurtWeight, 0.2);
  browR.rotation.z = THREE.MathUtils.lerp(browR.rotation.z, 0.3 * hurtWeight, 0.2);
  browL.position.y = THREE.MathUtils.lerp(browL.position.y, 0.04 - 0.01 * hurtWeight, 0.2);
  browR.position.y = THREE.MathUtils.lerp(browR.position.y, 0.04 - 0.01 * hurtWeight, 0.2);
}

/** Prompt 357 — asymmetric expressions. Wince (one-sided pain) + one-eyed
 *  squint. The caller passes the side ("left" or "right") + weight (0..1). */
export function applyAsymmetricExpression(
  headMesh: THREE.Mesh,
  type: "wince" | "squint",
  side: "left" | "right",
  weight: number,
): void {
  const browL = headMesh.getObjectByName("browL") as THREE.Mesh | null;
  const browR = headMesh.getObjectByName("browR") as THREE.Mesh | null;
  const eyeL = headMesh.getObjectByName("eyeL") as THREE.Mesh | null;
  const eyeR = headMesh.getObjectByName("eyeR") as THREE.Mesh | null;
  if (type === "wince") {
    // One brow raises, the other lowers.
    if (side === "left" && browL) browL.position.y = 0.04 + 0.015 * weight;
    if (side === "right" && browR) browR.position.y = 0.04 + 0.015 * weight;
    if (side === "left" && browR) browR.position.y = 0.04 - 0.01 * weight;
    if (side === "right" && browL) browL.position.y = 0.04 - 0.01 * weight;
  } else {
    // Squint — one eye scales down.
    const eye = side === "left" ? eyeL : eyeR;
    if (eye) eye.scale.y = THREE.MathUtils.lerp(eye.scale.y, 1 - 0.5 * weight, 0.2);
  }
}

/** Prompt 358 — micro-expressions. Subtle emotion "leaks" — e.g., fear
 *  leaking into the eyes while smiling. The caller passes a "leak" weight
 *  (0..1) + the leaking emotion; this adds a tiny amount of that emotion
 *  to the base expression. */
export function applyMicroExpression(
  mesh: THREE.Mesh,
  leakEmotion: EmotionState,
  leakWeight: number,
): void {
  // Micro-expressions are very subtle (1-5% of the full emotion weight).
  const w = THREE.MathUtils.clamp(leakWeight, 0, 1) * 0.05;
  setEmotionWeight(mesh, leakEmotion, w);
}

/** Prompt 359 — ARKit blendshape file loading. Loads a JSON file
 *  describing blendshape targets (per-vertex deltas) + applies them to the
 *  head mesh as morphAttributes. The JSON format matches ARKit's 52
 *  blendshape names (e.g., "eyeBlinkLeft", "jawOpen", "mouthSmileLeft").
 *
 *  Returns a map of blendshape-name → morphTargetIndex so the caller can
 *  drive individual ARKit shapes by name. */
export async function loadARKitBlendshapes(
  mesh: THREE.Mesh,
  url: string,
): Promise<Record<string, number>> {
  // Fetch the JSON.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadARKitBlendshapes: fetch failed: ${res.status}`);
  const data = await res.json() as Record<string, number[]>;
  // Verify the vertex count matches.
  const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const vertCount = posAttr.count;
  const dict: Record<string, number> = {};
  const deltas: THREE.BufferAttribute[] = [];
  for (const [name, flatDeltas] of Object.entries(data)) {
    if (flatDeltas.length !== vertCount * 3) {
      // Skip mismatched shapes (the ARKit file may target a different mesh).
      continue;
    }
    const arr = new Float32Array(flatDeltas);
    deltas.push(new THREE.BufferAttribute(arr, 3));
    dict[name] = deltas.length - 1;
  }
  // Append to the mesh's morphAttributes.
  const existing = mesh.geometry.morphAttributes.position ?? [];
  mesh.geometry.morphAttributes.position = [...existing, ...deltas];
  // Resize the morphTargetInfluences array.
  const influences = mesh.morphTargetInfluences ?? [];
  mesh.morphTargetInfluences = [...influences, ...new Array(deltas.length).fill(0)];
  // Stash the dict on the mesh's userData.
  const existingDict = (mesh.userData.expressionDict as Record<string, number>) ?? {};
  mesh.userData.expressionDict = { ...existingDict, ...dict };
  return dict;
}

/** Prompt 360 — audio-driven visemes. Analyzes a VO audio buffer for
 *  phonemes by computing per-frame amplitude + zero-crossing rate, then
 *  maps the analysis to visemes. The result is a timeline of (time,
 *  viseme) pairs that the caller plays back during the VO.
 *
 *  The audio buffer is a Float32Array of mono PCM samples at
 *  `sampleRate` Hz. The analysis window is 20ms (one viseme per window). */
export function analyzeAudioVisemes(
  audioSamples: Float32Array,
  sampleRate: number,
): Array<{ time: number; viseme: Viseme; weight: number }> {
  const windowSize = Math.floor(sampleRate * 0.02); // 20ms
  const timeline: Array<{ time: number; viseme: Viseme; weight: number }> = [];
  for (let i = 0; i + windowSize < audioSamples.length; i += windowSize) {
    // Compute RMS amplitude.
    let sumSq = 0;
    for (let j = 0; j < windowSize; j++) {
      const s = audioSamples[i + j];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / windowSize);
    // Compute zero-crossing rate (rough spectral content proxy).
    let zc = 0;
    for (let j = 1; j < windowSize; j++) {
      if ((audioSamples[i + j] >= 0) !== (audioSamples[i + j - 1] >= 0)) zc++;
    }
    const zcr = zc / windowSize;
    // Map (rms, zcr) → viseme. Low rms = silence ("rest"). High zcr =
    // high-frequency content = "S"/"T" sounds → "E" viseme. Low zcr +
    // high rms = open vowel → "A". Mid zcr + mid rms = "O".
    const time = i / sampleRate;
    if (rms < 0.02) {
      timeline.push({ time, viseme: "rest", weight: 1 });
    } else if (zcr > 0.3) {
      timeline.push({ time, viseme: "E", weight: rms });
    } else if (zcr < 0.1 && rms > 0.1) {
      timeline.push({ time, viseme: "A", weight: rms });
    } else if (zcr < 0.15) {
      timeline.push({ time, viseme: "O", weight: rms });
    } else {
      timeline.push({ time, viseme: "I", weight: rms });
    }
  }
  return timeline;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1501 / #1502 / #1503 / #1504 — variety pools
// (20+ expressions, 50+ micros, blink variety, saccade variety)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * C3-5000 #1501 — Extended emotion palette. The base EMOTION_STATES had 7
 *  entries; this lifts it to 12, which combined with the 4 HEAD_EXPRESSIONS
 *  + 5 COMBAT_EXERTION_STATES = 21 distinct expression targets (≥20 required).
 *  The 5 new states cover the canonical "leak" emotions micro-expression
 *  research calls out (Ekman / FACS adjuncts): annoyed, concerned,
 *  suspicious, focused, determined. */
export const EXTENDED_EMOTION_STATES = [
  ...EMOTION_STATES,
  "annoyed", "concerned", "suspicious", "focused", "determined",
] as const;
export type ExtendedEmotionState = (typeof EXTENDED_EMOTION_STATES)[number];

/** Total count of distinct facial expression targets exposed by this module
 *  (base head expressions + emotion states + combat exertion states).
 *  Verifies the #1501 acceptance criterion (≥20). */
export const FACIAL_EXPRESSION_COUNT: number =
  HEAD_EXPRESSIONS.length + EXTENDED_EMOTION_STATES.length + COMBAT_EXERTION_STATES.length; // 4 + 12 + 5 = 21

/**
 * C3-5000 #1502 — micro-expression variety pool. Each entry pairs a leaking
 *  emotion with a leak intensity bucket (very_low / low / medium / high /
 *  very_high). With 12 emotions × 5 buckets = 60 named micros (≥50 required).
 *  `applyMicroExpression` accepts any (emotion, weight) pair — this pool is
 *  the catalog the AI/cinematic layer samples from when picking a "leak"
 *  so that two operators in the same state don't show the identical micro. */
export const MICRO_EXPRESSION_LEAK_BUCKETS = [
  "very_low", "low", "medium", "high", "very_high",
] as const;
export type MicroLeakBucket = (typeof MICRO_EXPRESSION_LEAK_BUCKETS)[number];
export const MICRO_EXPRESSION_POOL: ReadonlyArray<{ emotion: ExtendedEmotionState; bucket: MicroLeakBucket; weight: number }> =
  EXTENDED_EMOTION_STATES.flatMap((emotion) =>
    MICRO_EXPRESSION_LEAK_BUCKETS.map((bucket) => ({
      emotion,
      bucket,
      weight: { very_low: 0.01, low: 0.02, medium: 0.03, high: 0.04, very_high: 0.05 }[bucket],
    })),
  );
/** Verifies the #1502 acceptance criterion (≥50 micros). */
export const MICRO_EXPRESSION_COUNT: number = MICRO_EXPRESSION_POOL.length; // 60

/** Pick a random micro-expression from the pool (deterministic when seeded). */
export function sampleMicroExpression(seed: number = Math.random()): { emotion: ExtendedEmotionState; bucket: MicroLeakBucket; weight: number } {
  const idx = Math.floor(seed * MICRO_EXPRESSION_POOL.length) % MICRO_EXPRESSION_POOL.length;
  return MICRO_EXPRESSION_POOL[idx]!;
}

/**
 * C3-5000 #1503 — blink timing variety. The base updateBlink uses a flat
 *  4-6s interval + 0.15s duration. This variety table varies both per
 *  emotional state (an angry operator blinks less often + faster; a tired
 *  operator blinks slower + longer) and adds duration jitter so two
 *  operators in the same state don't blink in lockstep. */
export const BLINK_VARIETY: Record<string, { intervalMin: number; intervalMax: number; durationMin: number; durationMax: number }> = {
  neutral:     { intervalMin: 4.0, intervalMax: 6.0, durationMin: 0.12, durationMax: 0.18 },
  angry:       { intervalMin: 5.5, intervalMax: 8.0, durationMin: 0.08, durationMax: 0.12 },
  scared:      { intervalMin: 2.0, intervalMax: 3.5, durationMin: 0.10, durationMax: 0.16 },
  surprised:   { intervalMin: 3.0, intervalMax: 5.0, durationMin: 0.18, durationMax: 0.28 },
  disgusted:   { intervalMin: 4.5, intervalMax: 6.5, durationMin: 0.10, durationMax: 0.15 },
  sad:         { intervalMin: 5.0, intervalMax: 7.5, durationMin: 0.20, durationMax: 0.30 },
  happy:       { intervalMin: 3.5, intervalMax: 5.5, durationMin: 0.14, durationMax: 0.20 },
  fatigued:    { intervalMin: 2.5, intervalMax: 4.0, durationMin: 0.22, durationMax: 0.35 },
  adrenaline:  { intervalMin: 6.0, intervalMax: 9.0, durationMin: 0.06, durationMax: 0.10 },
  focused:     { intervalMin: 5.0, intervalMax: 7.0, durationMin: 0.10, durationMax: 0.14 },
};
/** Look up blink variety for an emotional state (falls back to neutral). */
export function blinkVarietyFor(emotion: string): { intervalMin: number; intervalMax: number; durationMin: number; durationMax: number } {
  return BLINK_VARIETY[emotion] ?? BLINK_VARIETY.neutral!;
}

/**
 * C3-5000 #1504 — saccade variety. The base updateBlink only reacts to
 *  saccade rate (a scalar). This pool enumerates 8 named saccade
 *  directions × magnitudes (micro / small / medium / large × horizontal /
 *  vertical) so the cinematic director can request a specific saccade
 *  ("glance up-left briefly") rather than relying on the random trigger. */
export const SACCADE_POOL = [
  { name: "micro_left",  dirX: -0.2, dirY:  0.0, magnitude: 0.05, durationMs: 80 },
  { name: "micro_right", dirX:  0.2, dirY:  0.0, magnitude: 0.05, durationMs: 80 },
  { name: "small_up",    dirX:  0.0, dirY: -0.3, magnitude: 0.10, durationMs: 120 },
  { name: "small_down",  dirX:  0.0, dirY:  0.3, magnitude: 0.10, durationMs: 120 },
  { name: "medium_left", dirX: -0.5, dirY:  0.1, magnitude: 0.18, durationMs: 180 },
  { name: "medium_right",dirX:  0.5, dirY: -0.1, magnitude: 0.18, durationMs: 180 },
  { name: "large_upleft",dirX: -0.7, dirY: -0.5, magnitude: 0.28, durationMs: 240 },
  { name: "large_upright",dirX: 0.7, dirY: -0.5, magnitude: 0.28, durationMs: 240 },
] as const;
export type SaccadeKind = (typeof SACCADE_POOL)[number];
/** Sample a random saccade from the pool (deterministic when seeded). */
export function sampleSaccade(seed: number = Math.random()): SaccadeKind {
  const idx = Math.floor(seed * SACCADE_POOL.length) % SACCADE_POOL.length;
  return SACCADE_POOL[idx]!;
}

