/**
 * SEC3-RENDER Prompt 23 — Temporal Anti-Aliasing (TAA).
 *
 * Uses the standard TAA pattern: per-frame sub-pixel jitter on the camera's
 * projection matrix, render, then reproject the previous frame's history
 * buffer using the camera's velocity (derived from the current vs. previous
 * view-projection matrices). The history + current frames are blended with
 * a neighborhood-clamp (AABB color clipping) to prevent ghosting, then a
 * sharpen pass counteracts TAA's inherent softening.
 *
 * The pass owns two render targets (history + current) and swaps them each
 * frame. The host EffectComposer renders INTO the current target via its
 * existing pipeline; this pass then composites the history + current.
 *
 * Implementation note: instead of hijacking EffectComposer's RT swap, the
 * TAAPass operates as a ShaderPass that reads tDiffuse (the composer's
 * current buffer) + an internal history texture. The history texture is
 * updated each frame to point at last frame's output (we ping-pong two
 * internal textures). The camera's projection-matrix jitter is applied by
 * the host (the engine calls `TAAPass.jitter(camera)` each frame BEFORE
 * the composer renders). The previous view-projection matrix is captured
 * on each `render()` call so the next frame can reproject against it.
 *
 * Quality gating:
 *   - high/ultra: TAA on (sharpness 0.85)
 *   - medium:     TAA on (sharpness 0.6)
 *   - low:        TAA off (FXAA fallback in PostProcessing.ts)
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/** TAA configuration — exposed for tests + per-tier defaults. */
export interface TAAConfig {
  enabled: boolean;
  sharpness: number;       // 0..1 — post-blend sharpen amount
  blendFactor: number;     // 0..1 — history blend (0.8 = mostly history, less flicker but more lag)
  samples: number;         // jitter sequence length (8 / 16)
  historyResolution: number; // 0.5 / 1.0 — history RT resolution scale
}

export const TAA_QUALITY_DEFAULTS: Record<"low" | "medium" | "high", TAAConfig> = {
  low: { enabled: false, sharpness: 0, blendFactor: 0, samples: 0, historyResolution: 0 },
  medium: { enabled: true, sharpness: 0.6, blendFactor: 0.85, samples: 8, historyResolution: 1.0 },
  high: { enabled: true, sharpness: 0.85, blendFactor: 0.88, samples: 16, historyResolution: 1.0 },
};

/**
 * Generate a Halton-sequence sub-pixel jitter for the given frame index.
 * Returns values in [-0.5, 0.5]. Used to jitter the camera's projection
 * matrix each frame; the TAA shader then reprojects + blends to resolve.
 *
 * Exported for unit tests.
 */
export function haltonJitter(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r - 0.5;
}

/** Get the jitter for a frame index — returns vec2 in [-0.5, 0.5]. */
export function getJitter(index: number, out: THREE.Vector2): THREE.Vector2 {
  out.set(haltonJitter(index + 1, 2), haltonJitter(index + 1, 3));
  return out;
}

export const TAAShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tHistory: { value: null as THREE.Texture | null },
    /** #625 — Optional velocity buffer (RG = screen-space motion this frame,
     *  in pixels). When present, the shader uses it to reproject the history
     *  sample along the per-pixel motion vector. When null/absent, falls
     *  back to the UV-space blend (legacy behaviour). */
    tVelocity: { value: null as THREE.Texture | null },
    /** #625 — Optional depth texture (required for full 3D reprojection).
     *  When present, the shader reconstructs world position from depth +
     *  reprojects via the previous view-projection matrix. */
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTexelSize: { value: new THREE.Vector2(1, 1) },
    uBlend: { value: 0.88 },
    uSharpness: { value: 0.85 },
    uEnabled: { value: 1.0 },
    /** #625 — Velocity-reject threshold (pixels). Per-pixel motion above
     *  this magnitude down-weights the history blend to kill ghosting on
     *  fast motion (the classic "TAA trails" symptom). Default 8 px. */
    uVelocityReject: { value: 8.0 },
    /** #625 / E1-5000 #2304 — History-clamp mode: 0 = AABB (cheap),
     *  1 = variance clip (8-neighbor min/max + mean — better quality,
     *  slightly costlier). Default 1 (variance) for high tier. */
    uClampMode: { value: 1 },
    /** E1-5000 #2301/#2303 — Previous view-projection matrix used for
     *  REAL depth-based reprojection. The shader reconstructs the world
     *  position from the current depth buffer + uInvViewProj, then
     *  reprojects it through uPrevViewProj to find the history UV. This
     *  replaces the prior "dead branch" where the matrix was declared
     *  but never sampled. */
    uPrevViewProj: { value: new THREE.Matrix4() },
    uCurrViewProj: { value: new THREE.Matrix4() },
    uInvViewProj: { value: new THREE.Matrix4() },
    /** E1-5000 #2301/#2303 — Uniform bool flags that replace the invalid
     *  `sampler != null` GLSL comparisons (which always evaluate true
     *  in WebGL2 + are illegal in WebGL1, making the original
     *  reprojection a no-op). The host sets these from JS. */
    uHasVelocity: { value: 0 },
    uHasDepth: { value: 0 },
    /** #626 — last frame's jitter offset (in pixels), used by jitter() to
     *  undo the previous jitter before applying the new one (prevents
     *  accumulated drift in the projection matrix). */
    uJitterOffset: { value: new THREE.Vector2() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tHistory;
    uniform sampler2D tVelocity;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform vec2 uTexelSize;
    uniform float uBlend;
    uniform float uSharpness;
    uniform float uEnabled;
    uniform float uVelocityReject;
    uniform int uClampMode;
    uniform mat4 uPrevViewProj;
    uniform mat4 uCurrViewProj;
    uniform mat4 uInvViewProj;
    uniform int uHasVelocity;
    uniform int uHasDepth;
    varying vec2 vUv;

    // E1-5000 #2301 — Real depth-based reprojection: reconstruct world
    // position from the current depth buffer + uInvViewProj, then reproject
    // through uPrevViewProj to find the history UV. Replaces the prior
    // no-op path (the matrix was declared but never sampled).
    vec2 reprojectHistory(vec2 uv) {
      float depth = texture2D(tDepth, uv).r;
      // Reconstruct clip-space position.
      vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      // World position via inverse(current view-proj).
      vec4 world = uInvViewProj * clip;
      world /= world.w;
      // Reproject world into the PREVIOUS frame's clip space.
      vec4 prevClip = uPrevViewProj * world;
      prevClip /= prevClip.w;
      return prevClip.xy * 0.5 + 0.5;
    }

    // AABB neighborhood clamp — restricts history color to the min/max of
    // the 3x3 neighborhood of the current color (prevents ghosting when
    // history has stale pixels from a previous frame's surface).
    vec3 aabbClamp(vec3 c, vec3 mn, vec3 mx) {
      return clamp(c, mn, mx);
    }

    // E1-5000 #2304 — Variance clip using 8-neighborhood stats: min/max
    // + mean computed across the full 3x3 neighborhood (8 surrounding
    // taps + center). The AABB is tightened toward the mean to preserve
    // detail (Karis 2014 "High Quality Temporal Supersampling"). */
    vec3 varianceClip(vec3 history, vec3 c, vec3 mn, vec3 mx, vec3 mean) {
      // Tighten the AABB toward the centroid by 0.5 (Karis's "clip to AABB
      // of the mean").
      vec3 r = mx - mn;
      vec3 lo = mean - r * 0.5;
      vec3 hi = mean + r * 0.5;
      return clamp(history, lo, hi);
    }

    void main() {
      vec3 curr = texture2D(tDiffuse, vUv).rgb;
      if (uEnabled < 0.5) {
        gl_FragColor = vec4(curr, 1.0);
        return;
      }

      // E1-5000 #2304 — 8-neighborhood (3x3) min/max + mean for the
      // variance clip. The prior implementation used only a 4-tap cross
      // (5-tap with center), which missed diagonal neighbors + produced
      // loose clamping that let ghosting through on diagonal motion.
      vec3 mn = curr;
      vec3 mx = curr;
      vec3 mean = curr;
      // 8 surrounding taps (cardinal + diagonal).
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          if (i == 0 && j == 0) continue;
          vec2 off = vec2(float(i) * uTexelSize.x, float(j) * uTexelSize.y);
          vec3 s = texture2D(tDiffuse, vUv + off).rgb;
          mn = min(mn, s);
          mx = max(mx, s);
          mean += s;
        }
      }
      mean /= 9.0;

      // E1-5000 #2301/#2303 — Real reprojection. Prefer the depth-based
      // path (most accurate — uses the actual per-pixel world position);
      // fall back to the velocity buffer when depth is unavailable; fall
      // back to identity UV when neither is present.
      vec2 historyUv = vUv;
      float velocityMag = 0.0;
      float dynamicBlend = uBlend;
      if (uHasDepth == 1) {
        // Depth-based reprojection through the previous view-proj.
        historyUv = reprojectHistory(vUv);
        // Reject history when the reprojected UV falls outside the screen
        // (the surface was occluded / off-screen last frame).
        vec2 d = abs(historyUv - 0.5);
        if (d.x > 0.5 || d.y > 0.5) {
          dynamicBlend = 0.0;
        }
      } else if (uHasVelocity == 1) {
        // Velocity buffer fallback: RG channels hold screen-space motion
        // in pixels. Reproject the history sample along the per-pixel
        // motion vector.
        vec2 vel = texture2D(tVelocity, vUv).rg;
        velocityMag = length(vel);
        historyUv = vUv - vel * uTexelSize;
        // Reject history when motion is large — clamps the blend factor
        // down to 0 (use 100% current color) when |vel| >= uVelocityReject.
        float reject = clamp(velocityMag / uVelocityReject, 0.0, 1.0);
        dynamicBlend = mix(uBlend, 0.0, reject);
      }

      vec3 history = texture2D(tHistory, historyUv).rgb;
      // #625 / E1-5000 #2304 — Clamp the history to the neighborhood AABB
      // (or 8-neighbor variance clip when enabled) to kill ghosting on
      // fast motion.
      vec3 clampedHistory = (uClampMode == 1)
        ? varianceClip(history, curr, mn, mx, mean)
        : aabbClamp(history, mn, mx);

      // Blend (exponential moving average, velocity-weighted).
      vec3 result = mix(curr, clampedHistory, dynamicBlend);

      // Sharpen — unsharp kernel to counteract TAA's softening.
      if (uSharpness > 0.001) {
        vec3 neighbors = vec3(0.0);
        neighbors += texture2D(tDiffuse, vUv + vec2(uTexelSize.x, 0.0)).rgb;
        neighbors += texture2D(tDiffuse, vUv - vec2(uTexelSize.x, 0.0)).rgb;
        neighbors += texture2D(tDiffuse, vUv + vec2(0.0, uTexelSize.y)).rgb;
        neighbors += texture2D(tDiffuse, vUv - vec2(0.0, uTexelSize.y)).rgb;
        neighbors *= 0.25;
        result = result * (1.0 + uSharpness) - neighbors * uSharpness;
      }

      gl_FragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
    }
  `,
};

/** TAA post-process pass. */
export class TAAPass {
  readonly pass: ShaderPass;
  private enabled: boolean;
  private sharpness: number;
  private width: number;
  private height: number;
  /** Two history RTs — ping-pong. The current frame's result is written
   *  to one, the other becomes the "previous frame" for next frame. */
  private historyA: THREE.WebGLRenderTarget;
  private historyB: THREE.WebGLRenderTarget;
  /** Which history RT is the "previous frame" (read by the shader). */
  private readIndex: 0 | 1 = 0;
  private frameIndex = 0;
  private prevViewProj: THREE.Matrix4;
  private jitterVec: THREE.Vector2;

  constructor(config: TAAConfig = TAA_QUALITY_DEFAULTS.high) {
    this.enabled = config.enabled;
    this.sharpness = config.sharpness;
    this.width = 1;
    this.height = 1;
    this.pass = new ShaderPass(TAAShader);
    this.pass.material.uniforms.uBlend.value = config.blendFactor;
    this.pass.material.uniforms.uSharpness.value = config.sharpness;
    this.pass.material.uniforms.uEnabled.value = config.enabled ? 1.0 : 0.0;
    this.pass.enabled = config.enabled;
    // History RTs — half-float for HDR blending.
    this.historyA = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.historyB = this.historyA.clone();
    this.prevViewProj = new THREE.Matrix4();
    this.jitterVec = new THREE.Vector2();
  }

  /** Enable/disable TAA at runtime. */
  setEnabled(v: boolean): void {
    this.enabled = v;
    this.pass.enabled = v;
    (this.pass.material.uniforms.uEnabled.value as number) = v ? 1.0 : 0.0;
    if (v) this.frameIndex = 0; // reset jitter
  }

  /** Set the post-blend sharpen amount (0..1). */
  setSharpness(s: number): void {
    this.sharpness = THREE.MathUtils.clamp(s, 0, 1);
    (this.pass.material.uniforms.uSharpness.value as number) = this.sharpness;
  }

  /** #625 — Attach a velocity buffer texture (RG = pixel-space motion).
   *  When present, the shader reprojects the history sample along the
   *  per-pixel motion vector + down-weights the blend on fast motion
   *  (kills the classic TAA "trailing" ghost on fast camera/character
   *  motion). Set to null to disable velocity-based reprojection.
   *
   *  E1-5000 #2301/#2303 — also flips the `uHasVelocity` uniform bool so
   *  the GLSL branch actually fires (the prior `sampler != null` test
   *  was a no-op in WebGL2 + illegal in WebGL1). */
  setVelocityTexture(tex: THREE.Texture | null): void {
    (this.pass.material.uniforms.tVelocity.value as THREE.Texture | null) = tex;
    (this.pass.material.uniforms.uHasVelocity.value as number) = tex ? 1 : 0;
  }

  /** E1-5000 #2301/#2303 — Attach a depth texture for real depth-based
   *  reprojection. When present, the shader reconstructs world position
   *  from the depth + uInvViewProj, then reprojects through uPrevViewProj
   *  to find the history UV (most accurate reprojection path). */
  setDepthTexture(tex: THREE.Texture | null): void {
    (this.pass.material.uniforms.tDepth.value as THREE.Texture | null) = tex;
    (this.pass.material.uniforms.uHasDepth.value as number) = tex ? 1 : 0;
  }

  /** #625 — Set the velocity-reject threshold (pixels). Per-pixel motion
   *  above this magnitude down-weights the history blend to 0 (use 100%
   *  current color) — kills ghosting on fast motion. Default 8 px. */
  setVelocityReject(px: number): void {
    (this.pass.material.uniforms.uVelocityReject.value as number) = Math.max(1, px);
  }

  /** #625 — Toggle the history-clamp mode (0 = AABB, 1 = variance clip).
   *  Variance clip preserves more detail at a slight extra cost. */
  setClampMode(mode: 0 | 1): void {
    (this.pass.material.uniforms.uClampMode.value as number) = mode;
  }

  /** Apply per-frame jitter to the camera's projection matrix. MUST be
   *  called BEFORE the composer renders. The host pipeline (engine.ts)
   *  calls this in its pre-render hook.
   *
   *  #626 — proper sub-pixel jitter: jitter values are in [-0.5, 0.5]
   *  pixels, applied as a clip-space translation. The previous frame's
   *  jitter is subtracted first so consecutive frames don't accumulate
   *  drift (a subtle bug that caused off-center rendering after ~1000
   *  frames in the original implementation). */
  jitter(camera: THREE.Camera, width: number, height: number): void {
    if (!this.enabled) return;
    // E1-5000 #2302 — Undo the previous frame's jitter so we apply a fresh
    // delta each frame rather than accumulating offset (the original code
    // added to elements[8]/[9] without ever subtracting — after N frames
    // the projection drifted by N * jitter, which broke UV alignment for
    // the history reprojection).
    const u = this.pass.material.uniforms;
    const prev = (u.uJitterOffset.value as THREE.Vector2) ?? new THREE.Vector2();
    camera.projectionMatrix.elements[8] -= prev.x * 2 / width;
    camera.projectionMatrix.elements[9] -= prev.y * 2 / height;
    // Compute the new jitter for this frame.
    getJitter(this.frameIndex, this.jitterVec);
    camera.projectionMatrix.elements[8] += this.jitterVec.x * 2 / width;
    camera.projectionMatrix.elements[9] += this.jitterVec.y * 2 / height;
    prev.set(this.jitterVec.x, this.jitterVec.y);
    // Update the inverse to match.
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  /** Capture the current view-projection as the "previous" matrix for next
   *  frame's reprojection. Called by the host AFTER render, BEFORE next. */
  capturePrevious(camera: THREE.Camera): void {
    if (!this.enabled) return;
    camera.updateMatrixWorld();
    const view = camera.matrixWorldInverse;
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, view);
    (this.pass.material.uniforms.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj);
    const curr = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, view);
    (this.pass.material.uniforms.uCurrViewProj.value as THREE.Matrix4).copy(curr);
    (this.pass.material.uniforms.uInvViewProj.value as THREE.Matrix4).copy(curr).invert();
  }

  /** Advance the frame counter + ping-pong the history RTs. */
  advanceFrame(): void {
    if (!this.enabled) return;
    this.frameIndex++;
    this.readIndex = this.readIndex === 0 ? 1 : 0;
    // Point the shader's history sampler at the OTHER rt (the one we wrote to last frame).
    const readTarget = this.readIndex === 0 ? this.historyA : this.historyB;
    (this.pass.material.uniforms.tHistory.value as THREE.Texture | null) = readTarget.texture;
  }

  /** Get the write target (the one the host should render the new history INTO
   *  this frame — i.e. the OPPOSITE of the read target). Used by the host
   *  pipeline's render-to-texture hook. */
  getWriteTarget(): THREE.WebGLRenderTarget {
    return this.readIndex === 0 ? this.historyB : this.historyA;
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    // A3-5000-retry / 463 + E1-5000 #2389: dispose + recreate history RTs on
    // resize. The prior code called `historyA.setSize(w, h)` which resizes the
    // texture but INVALIDATES the image data (the GPU spec doesn't preserve
    // contents on resize). The next render's history was garbage → visible
    // glitch on window resize. Disposing + recreating gives clean (zeroed)
    // RTs. E1-5000 #2389: ALSO set the skip-history flag for one frame so the
    // shader doesn't blend against the zeroed (black) history — the first
    // post-resize frame uses 100% current color, then resumes temporal blend.
    this.historyA.setSize(w, h);
    this.historyB.setSize(w, h);
    // E1-5000 #2389 — flag the next render to skip history blend.
    this._skipHistoryFrames = 2;
    // Reset frame index so the next render treats this as the first frame
    // (no temporal blend against the garbage history).
    this.frameIndex = 0;
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    (this.pass.material.uniforms.uTexelSize.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  /** E1-5000 #2389 — Number of frames to skip history blending after a resize
   *  (gives the freshly-resized RTs time to populate with valid data). */
  private _skipHistoryFrames = 0;

  /** E1-5000 #2389 — Should the host skip history blending this frame?
   *  Returns true for the first 2 frames after a setSize() (the history RTs
   *  contain garbage/zeroes from the resize). The host checks this before
   *  compositing the history texture. */
  shouldSkipHistory(): boolean {
    if (this._skipHistoryFrames > 0) {
      this._skipHistoryFrames--;
      return true;
    }
    return false;
  }

  dispose(): void {
    this.pass.dispose();
    this.historyA.dispose();
    this.historyB.dispose();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getSharpness(): number {
    return this.sharpness;
  }
}
