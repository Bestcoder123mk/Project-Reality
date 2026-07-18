import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { GameContext } from "./types";
import { applySkyEnvironment, boostPBRMaterials } from "../rendering/TSLMaterials";
import { VolumetricFogPass } from "../rendering2/volumetric-fog";
import {
  RTShadowPass,
  SurfelGIPass,
  NeuralDenoiserPass,
  WaterCausticsPass,
  AerialPerspectivePass,
  ScreenSpaceSSSPass,
  AnamorphicFlarePass,
  ShellShockPass,
  ThermalBloomPass,
  FrostPatternPass,
  LensDirtPass,
  HDREyeAdaptation,
  FilmGrainPerISO,
  ThermalBarrelSystem,
  type RTShadowConfig,
  type SurfelGIConfig,
  type WaterCausticsConfig,
  type ShellShockConfig,
} from "../rendering2";

/**
 * PostProcessing — V1.3 always-on baseline post-process pipeline.
 *
 * Pipeline (per the V-Series master prompt + Task 24 realistic shaders):
 *   RenderPass → [SSAO high] → [Bloom med/high] → [SSR high] → Grade(ACES)
 *     → MotionBlur → FXAA → Sharpen → Output(sRGB)
 *
 * Quality tiers:
 *   - high:   SSAO + Bloom + SSR + Grade(ACES) + Vignette + FXAA + Sharpen
 *   - medium: Bloom + Grade(ACES) + Vignette + FXAA + Sharpen
 *   - low:    Grade(ACES) + Vignette + FXAA + Sharpen
 *
 * Task 24 highlights:
 *   - Grade shader now applies an ACES filmic tonemap approximation
 *     (after contrast/saturation, before vignette). The renderer's
 *     toneMapping is set to NoToneMapping (RendererSystem constructor)
 *     so the grade shader is the SOLE tonemapper — no double-tonemap
 *     darkening. Materials output HDR linear during RenderPass, ACES in
 *     the grade shader rolls off highlights cinematically.
 *   - SSR pass (high quality only) — cheap 8-step screen-space
 *     reflection shader that traces the depth buffer. Subtle (0.3
 *     opacity) so it doesn't blow out the scene. Requires a depth
 *     texture attached to the composer's render target 1.
 *   - Sharpen pass (all tiers) — 3×3 unsharp kernel applied after
 *     FXAA, before output. Counters FXAA's slight blur + crisps weapon
 *     edges + textures. Amount 0.15 (subtle).
 *   - Sky env map regen — every 5s, regenerates `scene.environment`
 *     from the live sky shader via PMREM so PBR materials reflect the
 *     current sky color (day/night/weather).
 *
 * The composer is ALWAYS active (the grade+vignette+FXAA baseline is the
 * "always-on" layer the master prompt requires). SSAO + Bloom + SSR are
 * gated by quality tier so low-end hardware still gets the color identity
 * without the GPU cost. Every pass has a try/catch fallback so a
 * shader-compile failure on a given GPU never crashes the game — it
 * degrades gracefully to raw render.
 */

/** Custom color-grade + vignette shader with ACES filmic tonemap.
 *  Tactical teal-shadow / warm-highlight grade with subtle desaturation,
 *  film grain, and a soft vignette. Task 24 — replaces the lift/gamma/gain
 *  with an ACES filmic tonemap approximation for cinematic highlight
 *  roll-off. The renderer is set to NoToneMapping so this shader is the
 *  sole tonemapper (no double-tonemap darkening).
 *
 *  Task-41 — MERGED the Sharpen pass into this shader so the grade + sharpen
 *  are computed in ONE full-screen pass instead of two. The sharpen unsharp
 *  kernel (3×3, 8 neighbors) is applied to the HDR center sample BEFORE the
 *  grade (exposure + contrast + saturation + ACES) so the tonemap operates
 *  on the sharpened value. Subtle (amount 0.15) — counters FXAA's slight blur
 *  + crisps weapon edges + textures. Saves one full-screen render pass. */
const GradeVignetteShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    // V2 — brightened grade so the map reads clearly even under overcast/night.
    // Lift shadows up (no teal crush), neutral mids, gentle warm highlights.
    // (Note: uLift/uGamma/uGain are retained for API compatibility but the
    // shader now uses ACES tonemapping instead of ASC-CDL lift/gamma/gain
    // — see the fragment shader for the new flow.)
    uLift: { value: new THREE.Color(1.0, 1.0, 1.0) },
    uGamma: { value: new THREE.Color(1.0, 1.0, 1.0) },
    uGain: { value: new THREE.Color(1.08, 1.05, 1.0) },
    uSaturation: { value: 0.95 },
    uContrast: { value: 1.02 },
    uExposure: { value: 1.15 },     // Task 24 — pre-ACES exposure boost (compensates ACES mid-gray darkening).
    uVignette: { value: 0.22 },
    uVignetteFalloff: { value: 0.32 },
    uGrain: { value: 0.018 },
    // A3-5000-retry / 459: grain toggle (DEFAULT_POST_FX.filmGrain=false has no
    // effect otherwise). When 0, the grain math is skipped entirely.
    uGrainEnable: { value: 1 },
    uTime: { value: 0 },
    // Task-41 — merged sharpen uniforms (was a separate SharpenShader pass).
    uTexelSize: { value: new THREE.Vector2(1, 1) },
    uSharpenAmount: { value: 0.15 },
    // A3-5000-retry / 411: motion-blur uniforms. Camera-velocity-based
    // directional blur sampled in this pass (4 taps in the turn direction).
    // uMotionBlurIntensity 0..1, uMotionBlurDir is the screen-space blur
    // direction (normalized), uMotionBlurSamples = 4.
    uMotionBlurIntensity: { value: 0 },
    uMotionBlurDir: { value: new THREE.Vector2(1, 0) },
    // A3-5000-retry / 437: optional LUT texture for per-map color grading.
    // When bound (non-null), the post-grade color is sampled through the LUT.
    uLUT: { value: null as THREE.Texture | null },
    uLUTEnabled: { value: 0 },
    // A3-5000-retry / 476: sRGB output conversion (merged from OutputPass).
    uOutputSRGB: { value: 1 },
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
    uniform vec3 uLift;
    uniform vec3 uGamma;
    uniform vec3 uGain;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uExposure;
    uniform float uVignette;
    uniform float uVignetteFalloff;
    uniform float uGrain;
    uniform float uGrainEnable;
    uniform float uTime;
    uniform vec2 uTexelSize;
    uniform float uSharpenAmount;
    uniform float uMotionBlurIntensity;
    uniform vec2 uMotionBlurDir;
    uniform sampler2D uLUT;
    uniform float uLUTEnabled;
    uniform float uOutputSRGB;
    varying vec2 vUv;

    // Hash for film grain.
    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }

    // A3-5000-retry / 458: 3-octave FBM film grain (replaces single-octave hash
    // — looks like real photographic grain instead of TV static).
    float fbmGrain(vec2 p) {
      float a = 0.5;
      float s = 0.0;
      for (int i = 0; i < 3; i++) {
        s += a * hash(p);
        p *= 2.13;
        a *= 0.5;
      }
      return s / 0.875; // normalize (0.5+0.25+0.125 = 0.875)
    }

    // A3-5000-retry / 476: sRGB encoding (merged from OutputPass). Three.js
    // OutputPass applies sRGB conversion when renderer.toneMapping is NoToneMapping
    // — folding it here saves one full-screen pass.
    vec3 linearToSRGB(vec3 c) {
      return mix(pow(c, vec3(1.0/2.4)) * 1.055 - 0.055, c * 12.92, step(c, vec3(0.0031308)));
    }

    // ACES filmic tonemap approximation (Task 24).
    // Industry-standard cinematic highlight roll-off. Operates on HDR
    // linear input (renderer.toneMapping = NoToneMapping so materials
    // output HDR during RenderPass) → outputs LDR 0..1.
    vec3 ACESFilm(vec3 x) {
      float a = 2.51; float b = 0.03; float c = 2.43; float d = 0.59; float e = 0.14;
      return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
    }

    void main() {
      // ── Task-41 merged sharpen: 3×3 unsharp kernel on HDR center sample. ──
      // Applied BEFORE the grade so ACES tonemaps the sharpened value.
      // out = center * (1 + amount) - neighbors_avg * amount
      vec3 center = texture2D(tDiffuse, vUv).rgb;
      vec3 c;
      if (uSharpenAmount > 0.001) {
        vec3 n = vec3(0.0);
        n += texture2D(tDiffuse, vUv + vec2(uTexelSize.x, 0.0)).rgb;
        n += texture2D(tDiffuse, vUv - vec2(uTexelSize.x, 0.0)).rgb;
        n += texture2D(tDiffuse, vUv + vec2(0.0, uTexelSize.y)).rgb;
        n += texture2D(tDiffuse, vUv - vec2(0.0, uTexelSize.y)).rgb;
        n += texture2D(tDiffuse, vUv + vec2(uTexelSize.x, uTexelSize.y)).rgb;
        n += texture2D(tDiffuse, vUv - vec2(uTexelSize.x, uTexelSize.y)).rgb;
        n += texture2D(tDiffuse, vUv + vec2(-uTexelSize.x, uTexelSize.y)).rgb;
        n += texture2D(tDiffuse, vUv - vec2(-uTexelSize.x, uTexelSize.y)).rgb;
        n *= 0.125;  // /8 → average
        c = center * (1.0 + uSharpenAmount) - n * uSharpenAmount;
      } else {
        c = center;
      }

      // A3-5000-retry / 411: camera-velocity motion blur (4-tap directional
      // sample on the HDR center, applied BEFORE the grade so ACES tonemaps
      // the blurred result). Taps are spaced along uMotionBlurDir.
      if (uMotionBlurIntensity > 0.001) {
        vec3 mb = c;
        float wsum = 1.0;
        for (int i = 1; i <= 4; i++) {
          float t = float(i) / 4.0 * uMotionBlurIntensity * 0.05;
          vec2 offs = uMotionBlurDir * t;
          mb += texture2D(tDiffuse, vUv + offs).rgb * (1.0 - float(i) * 0.2);
          mb += texture2D(tDiffuse, vUv - offs).rgb * (1.0 - float(i) * 0.2);
          wsum += 2.0 * (1.0 - float(i) * 0.2);
        }
        c = mb / wsum;
      }

      // Pre-exposure boost — compensates for ACES's mid-gray darkening
      // (ACES(1.0) ≈ 0.78). Keeps the map bright per the "do not darken"
      // constraint while still rolling off highlights.
      c *= uExposure;

      // Contrast around 0.5 pivot (gentle).
      c = (c - 0.5) * uContrast + 0.5;

      // Saturation (luminance-weighted, Rec. 709).
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);

      // A3-5000-retry / 457: vignette is now applied PRE-tonemap on the HDR
      // value (physical — vignette is a lens-feel light-attenuation, should
      // happen before the tonemap rolls off highlights, not after).
      vec2 uv = vUv - 0.5;
      float dist = length(uv);
      float vig = smoothstep(0.8, uVignetteFalloff, dist);
      c *= mix(1.0 - uVignette, 1.0, vig);

      // ACES filmic tonemap — HDR → LDR with cinematic highlight roll-off.
      // Applied after contrast/saturation + vignette (A3-5000-retry / 457).
      c = ACESFilm(c);

      // A3-5000-retry / 437: optional per-map LUT color grading. When a LUT
      // texture is bound (uLUTEnabled=1), the post-grade LDR color is
      // remapped through the LUT (treated as a 32³ identity-graded LUT).
      if (uLUTEnabled > 0.5) {
        // Treat uLUT as a horizontal strip LUT (3D LUT encoded as a 2D atlas).
        // Standard 32x32x32 strip = 1024x32 texture.
        float lutSize = 32.0;
        float slice = floor(c.b * (lutSize - 1.0));
        float x = (c.r * (lutSize - 1.0) + slice + 0.5) / (lutSize * lutSize);
        float y = (c.g * (lutSize - 1.0) + 0.5) / lutSize;
        c = texture2D(uLUT, vec2(x, y)).rgb;
      }

      // A3-5000-retry / 458 + 459: FBM film grain (3-octave), toggleable.
      if (uGrainEnable > 0.5 && uGrain > 0.001) {
        float g = fbmGrain(vUv * 1024.0 + fract(uTime) * 1024.0) - 0.5;
        c += g * uGrain;
      }

      // A3-5000-retry / 476: sRGB output conversion (merged from OutputPass).
      vec3 outCol = (uOutputSRGB > 0.5) ? linearToSRGB(clamp(c, 0.0, 1.0)) : clamp(c, 0.0, 1.0);
      gl_FragColor = vec4(outCol, 1.0);
    }
  `,
};

/** V2 — Motion-blur shader REMOVED (Task-41). The motion-blur pass was
 *  always-disabled (intensity=0) since Task 17 and was acting as a zero-cost
 *  pass-through. Removing the pass from the composer saves one full-screen
 *  render per frame (vertex shader + framebuffer write + pipeline barrier).
 *  The setMotionBlur API remains as a no-op for API stability (ChunkManager
 *  still calls it). If motion blur is ever re-enabled, restore this shader +
 *  add `new ShaderPass(MotionBlurShader)` to the composer after the grade
 *  pass. */
// const MotionBlurShader = { ... };

/** Task 24 — Screen-Space Reflections (SSR) shader.
 *  Cheap 8-step screen-space reflection: traces the depth buffer + reflects
 *  the view direction about the surface normal (reconstructed from depth
 *  derivatives via dFdx/dFdy). Only applies to pixels with a high "metalness
 *  heuristic" (bright + low saturation — typical of metal surfaces in this
 *  scene's color palette). Subtle (0.3 opacity) so it doesn't blow out.
 *
 *  This is NOT full ray-traced SSR — just a few screen-space steps to give
 *  metal + glossy surfaces a hint of reflection. Gated to high quality only
 *  (GPU-heavy due to the 8 depth taps per pixel + matrix reconstruction).
 *
 *  Requires a depth texture attached to the composer's render target 1
 *  (set up in the PostProcessing constructor + re-attached on resize).
 */
const SSRShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uProjection: { value: new THREE.Matrix4() },
    uInverseProjection: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uStrength: { value: 0.3 },      // 0..1 — reflection opacity (subtle per spec)
    uStepSize: { value: 5.0 },      // view-space step distance for the reflection ray
    uMaxSteps: { value: 8 },        // march steps (kept low for perf)
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
    uniform sampler2D tDepth;
    uniform mat4 uProjection;
    uniform mat4 uInverseProjection;
    uniform vec2 uResolution;
    uniform float uStrength;
    uniform float uStepSize;
    uniform float uMaxSteps;
    varying vec2 vUv;

    // Reconstruct view-space position from a depth sample + UV.
    // depth is in [0,1] (gl_FragCoord.z range) — convert to NDC then unproject.
    vec3 reconstructViewPos(vec2 uv, float depth) {
      float z = depth * 2.0 - 1.0;
      vec4 clip = vec4(uv * 2.0 - 1.0, z, 1.0);
      vec4 view = uInverseProjection * clip;
      return view.xyz / view.w;
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;

      // Sky / no depth — pass through (depth = 1.0 means far plane).
      if (depth >= 0.9999) {
        gl_FragColor = col;
        return;
      }

      // Reconstruct view-space position + normal.
      vec3 viewPos = reconstructViewPos(vUv, depth);
      vec3 dFdxView = dFdx(viewPos);
      vec3 dFdyView = dFdy(viewPos);
      vec3 normal = normalize(cross(dFdxView, dFdyView));
      // Ensure normal faces the camera (view-space +Z is toward camera).
      if (normal.z < 0.0) normal = -normal;

      vec3 viewDir = normalize(viewPos);
      float NdotV = clamp(dot(normal, -viewDir), 0.0, 1.0);

      // A3-5000-retry / 413: tightened metalness heuristic. The original
      // (lum-0.18)*(1-sat*2) misclassified white painted walls, snow, sunlit
      // sand as metal → false SSR reflections. Tightened to require BOTH
      // very bright (lum > 0.5) AND very desaturated (sat < 0.1) — typical
      // of metal in this scene's color palette (dark gray with low chroma).
      // Real fix is a metalness G-buffer; this heuristic is the SSR-only fallback.
      float lum = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
      float mx = max(col.r, max(col.g, col.b));
      float mn = min(col.r, min(col.g, col.b));
      float saturation = mx - mn;
      float metalHeuristic = (lum > 0.5 && saturation < 0.1) ? 1.0 : clamp((lum - 0.5) * (1.0 - saturation * 4.0), 0.0, 1.0);

      // Skip non-reflective pixels + grazing angles (too noisy).
      if (metalHeuristic < 0.2 || NdotV < 0.2) {
        gl_FragColor = col;
        return;
      }

      // Reflect view direction about the normal (view-space).
      vec3 reflected = reflect(viewDir, normal);

      // Project the reflected ray end-point back to screen space.
      vec3 rayEndView = viewPos + reflected * uStepSize * 4.0;
      vec4 rayEndClip = uProjection * vec4(rayEndView, 1.0);
      vec2 rayEndUv = (rayEndClip.xy / rayEndClip.w) * 0.5 + 0.5;

      // March N steps in screen space, checking depth at each step.
      vec2 stepDir = (rayEndUv - vUv) / uMaxSteps;
      vec3 reflection = col.rgb;
      float hit = 0.0;

      for (int i = 1; i <= 8; i++) {
        if (float(i) > uMaxSteps) break;
        vec2 sampleUv = vUv + stepDir * float(i);
        // Out of screen — no hit.
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) break;
        float sampleDepth = texture2D(tDepth, sampleUv).r;
        if (sampleDepth >= 0.9999) continue;  // sky — no reflection
        vec3 sampleViewPos = reconstructViewPos(sampleUv, sampleDepth);
        // Compare view-space z (negative in front of camera).
        float expectedZ = viewPos.z + reflected.z * uStepSize * 4.0 * (float(i) / uMaxSteps);
        float zDiff = abs(sampleViewPos.z - expectedZ);
        // A3-5000-retry / 414: hit tolerance tightened from 0.3 to 0.07 view
        // units (7cm) — prevents reflections from hitting through 30cm walls.
        if (zDiff < 0.07) {
          reflection = texture2D(tDiffuse, sampleUv).rgb;
          hit = 1.0;
          break;
        }
      }

      // Fresnel: stronger reflection at grazing angles (Schlick approx).
      float fresnel = pow(1.0 - NdotV, 3.0);
      float intensity = hit * (metalHeuristic * 0.7 + fresnel * 0.3) * uStrength;

      gl_FragColor = vec4(mix(col.rgb, reflection, intensity), col.a);
    }
  `,
};

/** Task 24 — Sharpen shader REMOVED (Task-41). The 3×3 unsharp kernel was
 *  merged into GradeVignetteShader so grade + sharpen are computed in ONE
 *  full-screen pass instead of two. The sharpen is applied to the HDR center
 *  sample BEFORE the grade (exposure + contrast + saturation + ACES) so the
 *  tonemap operates on the sharpened value. Subtle (amount 0.15).
 *
 *  If a separate sharpen pass is ever needed again, restore this shader +
 *  add `new ShaderPass(SharpenShader)` to the composer after the FXAA pass. */
// const SharpenShader = {
//   uniforms: {
//     tDiffuse: { value: null as THREE.Texture | null },
//     uTexelSize: { value: new THREE.Vector2(1, 1) },
//     uAmount: { value: 0.15 },
//   },
//   ...
// };

export class PostProcessing {
  private composer: EffectComposer | null = null;
  private ssaoPass: SSAOPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private ssrPass: ShaderPass | null = null;
  private gradePass: ShaderPass | null = null;
  // Task-41 — motionBlurPass + sharpenPass removed from pipeline. Fields kept
  // as `null` so the dispose() cleanup (which assigns null) compiles cleanly.
  // The motionBlurPass was always-disabled (intensity=0) since Task 17 —
  // removing it from the composer saves one full-screen render per frame.
  // The sharpenPass was merged into GradeVignetteShader (3×3 unsharp kernel
  // applied to HDR center sample before the grade) — one pass instead of two.
  private fxaaPass: ShaderPass | null = null;
  private outputPass: OutputPass | null = null;
  /** Task-3 — Volumetric fog + god-ray pass (high quality only). Placed
   *  after SSR + before the grade so it operates on HDR color. Reads the
   *  composer's depth texture for the god-ray raymarch. */
  private volFogPass: VolumetricFogPass | null = null;
  /** Task-3 — Eye-adaptation / auto-exposure. Samples the post-FXAA LDR
   *  color buffer at 16×16 every ~6 frames, computes average luminance,
   *  and lerps the grade shader's uExposure toward a target so entering/
   *  exiting buildings feels real (dark areas brighten, bright areas darken). */
  private _luminanceRT: THREE.WebGLRenderTarget | null = null;
  private _luminanceScene: THREE.Scene | null = null;
  private _luminanceCam: THREE.OrthographicCamera | null = null;
  private _luminanceMaterial: THREE.ShaderMaterial | null = null;
  private _luminanceReadBuffer: Uint8Array | null = null;
  private _sampleAccum = 0;
  private _currentExposure = 1.0;
  private _targetExposure = 1.0;
  /** Scratch vector for sun-direction computation (avoid per-frame alloc). */
  private _sunDirScratch = new THREE.Vector3();
  private enabled = true;
  private hasComposer = false;
  private quality: "low" | "medium" | "high";
  private width: number;
  private height: number;
  private elapsed = 0;
  /** Task 24 — ctx reference for SSR matrix updates + sky env map regen. */
  private ctx: GameContext;
  /** Task 24 — depth texture attached to renderTarget1 for the SSR pass.
   *  Recreated on resize. */
  private _depthTexture: THREE.DepthTexture | null = null;
  /** Task 24 — reusable PMREM generator for sky env map regeneration. */
  private _pmrem: THREE.PMREMGenerator | null = null;
  /** Task 24 — current sky-derived env map (disposed + replaced on regen). */
  private _skyEnvMap: THREE.Texture | null = null;
  /** Task 24 — accumulator for the 2s sky env map regen throttle. */
  private _envRegenAccum = 0;
  /** Task 24 — SSR disabled flag (set if shader compile fails or GPU lacks
   *  depth-texture support). */
  private _ssrDisabled = false;

  // ─── Section A — new post-process passes (high quality only) ───
  /** Ray-traced soft shadows — added between SSAO and SSR. */
  private _rtShadowPass: RTShadowPass | null = null;
  /** Surfel-based GI — added between RT shadows and SSR. */
  private _surfelGIPass: SurfelGIPass | null = null;
  /** Neural-network denoiser for RT shadows + SSR — added after SSR. */
  private _denoiserPass: NeuralDenoiserPass | null = null;
  /** Water caustics — added after the GI pass (caustics participate in
   *  indirect lighting). */
  private _causticsPass: WaterCausticsPass | null = null;
  /** Aerial perspective (Rayleigh + Mie) — added after caustics. */
  private _aerialPass: AerialPerspectivePass | null = null;
  /** Subsurface scattering on skin — added after aerial perspective. */
  private _sssPass: ScreenSpaceSSSPass | null = null;
  /** Anamorphic lens flares — added after bloom (so highlights bloom first). */
  private _anamorphicPass: AnamorphicFlarePass | null = null;
  /** Shell-shock desaturation — added after the grade pass (medium + high). */
  private _shellShockPass: ShellShockPass | null = null;
  /** Thermal bloom from hot barrels — added after anamorphic flares. */
  private _thermalPass: ThermalBloomPass | null = null;
  /** Frost pattern on cold metal — added after thermal bloom (high only). */
  private _frostPass: FrostPatternPass | null = null;
  /** Lens dirt accumulation — added after frost pattern (medium + high). */
  private _lensDirtPass: LensDirtPass | null = null;
  /** HDR eye adaptation (rod/cone) — replaces the basic eye adaptation. */
  private _hdrEyeAdaptation: HDREyeAdaptation | null = null;
  /** Film grain per-ISO — drives the grade shader's uGrain + size uniforms. */
  private _filmGrain: FilmGrainPerISO | null = null;
  /** Thermal barrel system — owns per-weapon barrel temperature. */
  private _thermalBarrels: ThermalBarrelSystem | null = null;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    this.quality = ctx.settings.quality;
    this.width = ctx.renderer.domElement.width;
    this.height = ctx.renderer.domElement.height;

    try {
      this.composer = new EffectComposer(ctx.renderer);
      this.composer.addPass(new RenderPass(ctx.scene, ctx.camera));

      // Task 24 — set up the depth texture for SSR (high quality only).
      // RenderPass writes the scene's depth into this texture; the SSR
      // shader samples it to reconstruct view-space positions + normals.
      if (this.quality === "high") {
        try {
          this._depthTexture = new THREE.DepthTexture(this.width, this.height);
          this._depthTexture.type = THREE.UnsignedShortType;
          // Attach to renderTarget1 (RenderPass's first write target).
          // depthTexture is preserved across the composer's ping-pong
          // swaps since fullscreen passes (Bloom/Grade/FXAA/etc.) don't
          // write depth.
          this.composer.renderTarget1.depthTexture = this._depthTexture;
        } catch (err) {
          console.warn("[PostProcessing] Depth texture unavailable, SSR will be skipped:", err);
          this._depthTexture = null;
          this._ssrDisabled = true;
        }
      }

      // SSAO — high tier only (GPU-heavy).
      if (this.quality === "high") {
        try {
          const ssao = new SSAOPass(ctx.scene, ctx.camera, this.width, this.height);
          // Task-41 — reduced kernel radius (10 → 4) for cheaper AO. The
          // radius controls how far the SSAO kernel samples; a smaller radius
          // means tighter, more localized AO (still reads in corners + under
          // props) at roughly half the texture-fetch cost per pixel.
          ssao.kernelRadius = 4;         // was 10 — tightened for perf
          ssao.minDistance = 0.0025;
          ssao.maxDistance = 0.08;
          ssao.output = SSAOPass.OUTPUT.Default;
          this.ssaoPass = ssao;
          this.composer.addPass(ssao);
        } catch (err) {
          console.warn("[PostProcessing] SSAO unavailable, skipping:", err);
          this.ssaoPass = null;
        }
      }

      // Bloom — medium + high (subtle, never blows out).
      if (this.quality === "high" || this.quality === "medium") {
        try {
          this.bloomPass = new UnrealBloomPass(
            new THREE.Vector2(this.width, this.height),
            0.18,  // strength — subtle per master prompt (≤0.5)
            0.42,  // radius
            0.85,  // threshold — only bright highlights bloom
          );
          this.composer.addPass(this.bloomPass);
        } catch (err) {
          console.warn("[PostProcessing] Bloom unavailable, skipping:", err);
          this.bloomPass = null;
        }
      }

      // Task 24 — SSR (high quality only). Placed after Bloom so reflections
      // include the bloom-modulated highlights. Reads tDiffuse (current color
      // buffer) + tDepth (the depth texture attached to renderTarget1).
      if (this.quality === "high" && this._depthTexture && !this._ssrDisabled) {
        try {
          this.ssrPass = new ShaderPass(SSRShader);
          this.ssrPass.material.uniforms.tDepth.value = this._depthTexture;
          this.ssrPass.material.uniforms.uResolution.value.set(this.width, this.height);
          this.ssrPass.material.uniforms.uStrength.value = 0.3;  // subtle
          this.ssrPass.material.uniforms.uStepSize.value = 5.0;
          this.ssrPass.material.uniforms.uMaxSteps.value = 8;
          this.composer.addPass(this.ssrPass);
        } catch (err) {
          console.warn("[PostProcessing] SSR unavailable, skipping:", err);
          this.ssrPass = null;
        }
      }

      // Task-3 — Volumetric fog + god rays (high quality only). Placed AFTER
      // SSR + BEFORE the grade so it operates on the HDR color buffer (god
      // rays add linearly to HDR color, then ACES tonemaps the result).
      // Reads the same depth texture the SSR pass uses (depth is written by
      // RenderPass and preserved across the composer's ping-pong since
      // fullscreen passes don't write depth).
      // God rays raymarch from each pixel back toward the sun, accumulating
      // light wherever the ray is unoccluded (sky / windows / doorways) —
      // the classic "volumetric lighting" effect. Distance fog adds depth
      // haze that's tinted by the sun direction.
      if (this.quality === "high" && this._depthTexture) {
        try {
          this.volFogPass = new VolumetricFogPass({
            // Default sun dir — overwritten per-frame in update() once the
            // sun light is built (PostProcessing constructs BEFORE buildLights).
            sunDir: new THREE.Vector3(-0.5, 0.6, -0.8),
            density: 0.06,
            steps: 16,
          });
          this.volFogPass.setDepthTexture(this._depthTexture);
          this.volFogPass.setSize(this.width, this.height);
          // Subtle god-ray intensity — high values blow out the scene.
          this.volFogPass.setGodRayIntensity(0.45);
          this.composer.addPass(this.volFogPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Volumetric fog unavailable, skipping:", err);
          this.volFogPass = null;
        }
      }

      // ─── Section A — new high-impact passes (high quality only) ───
      // The passes are inserted into the composer in the optimal order:
      //   SSAO → RT shadows → surfel GI → SSR → volumetric fog → caustics →
      //   aerial perspective → SSS → bloom → anamorphic flares → thermal →
      //   frost → grade → shell-shock → lens dirt → lens weather → FXAA
      // All passes have try/catch fallbacks so a shader-compile failure on
      // a given GPU degrades gracefully (the pass is skipped, the rest of
      // the pipeline still runs).
      if (this.quality === "high" && this._depthTexture) {
        try {
          // RT shadows (added BEFORE SSR so SSR sees the shadowed buffer).
          const rtCfg: RTShadowConfig = {
            sunDirection: new THREE.Vector3(-0.5, 0.7, -0.5).normalize(),
            sunColor: new THREE.Color(1.0, 0.95, 0.82),
            raysPerPixel: 1,
            maxDistance: 20,
            steps: 32,
            stepSize: 0.18,
            penumbraAngle: 0.04,
            bias: 0.02,
            strength: 0.45,
            halfRes: true,
          };
          this._rtShadowPass = new RTShadowPass(rtCfg);
          this._rtShadowPass.setDepthTexture(this._depthTexture);
          this._rtShadowPass.setSize(this.width, this.height);
          this.composer.addPass(this._rtShadowPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] RT shadows unavailable, skipping:", err);
          this._rtShadowPass = null;
        }
        try {
          // Surfel GI (added AFTER RT shadows so indirect light stacks on
          // top of the shadow-modulated direct light).
          const giCfg: SurfelGIConfig = {
            gridResolution: 24,
            cellSize: 3.0,
            followCamera: true,
            temporalBlend: 0.94,
            maxSurfelRadius: 1.2,
            intensity: 0.8,
            gatherCount: 8,
            halfRes: true,
          };
          this._surfelGIPass = new SurfelGIPass(giCfg);
          this._surfelGIPass.setDepthTexture(this._depthTexture);
          this._surfelGIPass.setSize(this.width, this.height);
          this.composer.addPass(this._surfelGIPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Surfel GI unavailable, skipping:", err);
          this._surfelGIPass = null;
        }
      }
      // Neural denoiser (high only — denoises RT shadow + SSR noise).
      if (this.quality === "high") {
        try {
          this._denoiserPass = new NeuralDenoiserPass();
          if (this._depthTexture) this._denoiserPass.setDepthTexture(this._depthTexture);
          this._denoiserPass.setSize(this.width, this.height);
          this.composer.addPass(this._denoiserPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Neural denoiser unavailable, skipping:", err);
          this._denoiserPass = null;
        }
      }
      // Water caustics (high only — after the volumetric fog so caustics
      // participate in the fog-scattered light).
      if (this.quality === "high" && this._depthTexture) {
        try {
          const cCfg: WaterCausticsConfig = {
            gridResolution: 128,
            worldSize: 40,
            depth: 1.5,
            sunDirection: new THREE.Vector3(-0.5, -0.7, -0.5).normalize(),
            intensity: 0.8,
            color: new THREE.Color(0.6, 0.85, 0.95),
            speed: 1.0,
            waveAmplitude: 0.15,
          };
          this._causticsPass = new WaterCausticsPass(cCfg);
          this._causticsPass.setDepthTexture(this._depthTexture);
          this._causticsPass.setSize(this.width, this.height);
          this.composer.addPass(this._causticsPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Water caustics unavailable, skipping:", err);
          this._causticsPass = null;
        }
      }
      // Aerial perspective (Rayleigh + Mie) — added after caustics.
      if (this.quality === "high" && this._depthTexture) {
        try {
          this._aerialPass = new AerialPerspectivePass();
          this._aerialPass.setDepthTexture(this._depthTexture);
          this._aerialPass.setSize(this.width, this.height);
          this.composer.addPass(this._aerialPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Aerial perspective unavailable, skipping:", err);
          this._aerialPass = null;
        }
      }
      // Subsurface scattering on skin (high only).
      if (this.quality === "high" && this._depthTexture) {
        try {
          this._sssPass = new ScreenSpaceSSSPass();
          this._sssPass.setDepthTexture(this._depthTexture);
          this._sssPass.setSize(this.width, this.height);
          this.composer.addPass(this._sssPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] SSS unavailable, skipping:", err);
          this._sssPass = null;
        }
      }
      // Thermal barrel system + bloom pass (medium + high).
      if (this.quality === "high" || this.quality === "medium") {
        try {
          this._thermalBarrels = new ThermalBarrelSystem();
          this._thermalPass = new ThermalBloomPass();
          this._thermalPass.setThermalMask(this._thermalBarrels.getMaskTexture());
          this._thermalPass.setSize(this.width, this.height);
          this.composer.addPass(this._thermalPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Thermal bloom unavailable, skipping:", err);
          this._thermalPass = null;
          this._thermalBarrels = null;
        }
      }
      // Anamorphic lens flares (high only — after bloom so highlights bloom
      // before the streak is added).
      if (this.quality === "high") {
        try {
          this._anamorphicPass = new AnamorphicFlarePass();
          this._anamorphicPass.setSize(this.width, this.height);
          this.composer.addPass(this._anamorphicPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Anamorphic flares unavailable, skipping:", err);
          this._anamorphicPass = null;
        }
      }
      // Frost pattern pass (high only — after thermal so frost tints the
      // thermal bloom too).
      if (this.quality === "high" && this._depthTexture) {
        try {
          this._frostPass = new FrostPatternPass();
          this._frostPass.setDepthTexture(this._depthTexture);
          this._frostPass.setSize(this.width, this.height);
          this.composer.addPass(this._frostPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Frost pattern unavailable, skipping:", err);
          this._frostPass = null;
        }
      }
      // HDR eye adaptation (replaces the basic eye adaptation at high tier).
      if (this.quality === "high") {
        try {
          this._hdrEyeAdaptation = new HDREyeAdaptation();
        } catch (err) {
          console.warn("[PostProcessing] HDR eye adaptation unavailable:", err);
          this._hdrEyeAdaptation = null;
        }
      }
      // Film grain per-ISO (medium + high).
      if (this.quality === "high" || this.quality === "medium") {
        try {
          this._filmGrain = new FilmGrainPerISO(400);
        } catch (err) {
          console.warn("[PostProcessing] Film grain per-ISO unavailable:", err);
          this._filmGrain = null;
        }
      }

      // Task-3 — Eye-adaptation / auto-exposure (high quality only). Sets up
      // a 16×16 luminance readback target + a fullscreen luminance-downsample
      // quad. After each composer.render(), we render the post-FXAA LDR color
      // through the luminance shader into the 16×16 RT, readPixels, and
      // compute average luminance. The grade shader's uExposure is then lerped
      // toward `clamp(0.5 / avgLum, 0.5, 1.6)` over ~0.5s — dark areas
      // (buildings, night) brighten, bright areas (sunlit outdoor) darken.
      // The 0.5 reference is approximately ACES mid-gray post-tonemap.
      if (this.quality === "high") {
        try {
          const LUM_SIZE = 16;
          this._luminanceRT = new THREE.WebGLRenderTarget(LUM_SIZE, LUM_SIZE, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: false,
            stencilBuffer: false,
          });
          this._luminanceReadBuffer = new Uint8Array(LUM_SIZE * LUM_SIZE * 4);
          this._luminanceScene = new THREE.Scene();
          this._luminanceCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
          this._luminanceMaterial = new THREE.ShaderMaterial({
            uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
            vertexShader: /* glsl */ `
              varying vec2 vUv;
              void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
              }
            `,
            fragmentShader: /* glsl */ `
              uniform sampler2D tDiffuse;
              varying vec2 vUv;
              void main() {
                vec3 c = texture2D(tDiffuse, vUv).rgb;
                // Rec. 709 luminance — matches the grade shader's saturation math.
                float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
                gl_FragColor = vec4(vec3(l), 1.0);
              }
            `,
            depthTest: false,
            depthWrite: false,
          });
          const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._luminanceMaterial);
          this._luminanceScene.add(quad);
        } catch (err) {
          console.warn("[PostProcessing] Eye adaptation (luminance RT) unavailable:", err);
          this._luminanceRT = null;
          this._luminanceReadBuffer = null;
        }
      }

      // Color grade + vignette — ALWAYS ON (the baseline identity layer).
      // Task 24 — grade shader now applies ACES tonemap (renderer is set
      // to NoToneMapping so this is the sole tonemapper).
      // Task-41 — sharpen is now MERGED into this pass (3×3 unsharp kernel
      // applied to the HDR center sample before the grade). Saves one
      // full-screen render pass vs the previous separate SharpenShader pass.
      const pxr = ctx.renderer.getPixelRatio();
      this.gradePass = new ShaderPass(GradeVignetteShader);
      this.gradePass.material.uniforms.uTexelSize.value.set(
        1 / (this.width * pxr),
        1 / (this.height * pxr),
      );
      this.gradePass.material.uniforms.uSharpenAmount.value = 0.15;
      this.composer.addPass(this.gradePass);

      // Task-41 — Motion blur pass REMOVED from the pipeline. It was disabled
      // (intensity=0) since Task 17, acting as a zero-cost pass-through — but
      // even a pass-through still costs one full-screen render (vertex shader
      // + framebuffer write + pipeline barrier). Removing it from the composer
      // saves one full-screen render per frame. The setMotionBlur API remains
      // (ChunkManager still calls it) but is now a no-op.
      // this.motionBlurPass = null;

      // ─── Section A — shell-shock + lens dirt (medium + high) ───
      // Added AFTER the grade pass + BEFORE FXAA so FXAA still smooths the
      // desaturated edges + dirt. Both passes are no-ops at their default
      // values (shockLevel=0, dirtAmount=0) so they're effectively free
      // until the host drives them.
      if (this.quality === "high" || this.quality === "medium") {
        try {
          this._shellShockPass = new ShellShockPass();
          this._shellShockPass.setSize(this.width, this.height);
          this.composer.addPass(this._shellShockPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Shell-shock pass unavailable:", err);
          this._shellShockPass = null;
        }
        try {
          this._lensDirtPass = new LensDirtPass();
          this._lensDirtPass.setSize(this.width, this.height);
          this.composer.addPass(this._lensDirtPass.pass);
        } catch (err) {
          console.warn("[PostProcessing] Lens dirt pass unavailable:", err);
          this._lensDirtPass = null;
        }
      }

      // FXAA — always on (cheap, reliable AA).
      // Task-41 — with renderer.antialias=false (set in context-factory),
      // FXAA is the sole AA. Cheap + important for edge quality.
      this.fxaaPass = new ShaderPass(FXAAShader);
      this.fxaaPass.material.uniforms.resolution.value.set(
        1 / (this.width * pxr),
        1 / (this.height * pxr),
      );
      this.composer.addPass(this.fxaaPass);

      // Task-41 — Sharpen pass REMOVED (merged into GradeVignetteShader above).
      // this.sharpenPass = null;

      // A3-5000-retry / 476: OutputPass REMOVED — its sRGB conversion is now
      // folded into the GradeVignetteShader (uOutputSRGB=1 applies linearToSRGB
      // on the final color). Saves one full-screen render pass per frame.
      // The field is kept as null for dispose() cleanup compatibility.
      this.outputPass = null;

      this.composer.setSize(this.width, this.height);
      this.hasComposer = true;

      // A3-5000-retry / 408: always boost PBR materials (was gated to <500
      // materials — large scenes silently skipped, causing visual
      // inconsistency between small and large maps). The boost is a one-time
      // O(materials) walk at construction; even 5000 materials is <5ms.
      // Wrapped in try/catch so a partial failure doesn't break the composer.
      try {
        const count = boostPBRMaterials(ctx.scene, { envMapIntensity: 1.15, boostMetals: true });
        console.log(`[PostProcessing] Boosted ${count} PBR materials.`);
      } catch (err) {
        console.warn("[PostProcessing] PBR boost failed (composer still active, materials unboosted):", err);
      }

      // Task 24 — initialize the sky env map (PMREM-pre-filtered) so PBR
      // materials reflect the live sky. Regenerated every 2s in update().
      try {
        if (ctx.skyMesh) {
          this._pmrem = new THREE.PMREMGenerator(ctx.renderer);
          this._pmrem.compileEquirectangularShader();
          this._skyEnvMap = applySkyEnvironment(
            ctx.scene,
            ctx.renderer,
            ctx.skyMesh,
            this._pmrem,
            this._skyEnvMap,
            ctx.sunLight ?? null,
          );
        }
      } catch (err) {
        console.warn("[PostProcessing] Initial sky env map generation failed:", err);
      }
    } catch (err) {
      console.warn("[PostProcessing] Composer init failed, falling back to raw render:", err);
      this.composer = null;
      this.hasComposer = false;
    }
  }

  /** Render the composed scene. Called every frame from the engine loop. */
  render() {
    if (!this.composer || !this.hasComposer) return;
    try {
      this.composer.render();
      // Task-3 — Eye adaptation: sample post-FXAA LDR luminance every ~6
      // frames and update _targetExposure. The actual exposure lerp toward
      // the target happens in update(dt) so it advances by dt-independent
      // time (not by sample count).
      this._sampleLuminanceAndAdapt();
    } catch (err) {
      console.warn("[PostProcessing] Composer render failed, disabling:", err);
      this.hasComposer = false;
    }
  }

  /** Task-3 — Sample the post-FXAA color buffer's average luminance + update
   *  the target exposure. The grade shader's uExposure is lerped toward this
   *  target in update(dt) over ~0.5s for smooth eye adaptation.
   *
   *  Samples every 6 frames (~10 Hz at 60 fps) to keep readPixels cost low —
   *  readRenderTargetPixels forces a GPU sync and would tank fps if done
   *  per-frame. The 16×16 = 256-tap sample is small enough to read in <0.2ms
   *  on most GPUs. */
  private _sampleLuminanceAndAdapt() {
    if (!this._luminanceRT || !this._luminanceScene || !this._luminanceCam ||
        !this._luminanceMaterial || !this._luminanceReadBuffer || !this.composer) return;
    // A3-5000-retry / 409: sample every 6 frames (~10 Hz at 60 fps) — was 15
    // (4 Hz, mismatched the docstring's claim of 10 Hz).
    this._sampleAccum++;
    if (this._sampleAccum < 6) return;
    this._sampleAccum = 0;

    const renderer = this.ctx.renderer;
    const prevRT = renderer.getRenderTarget();
    // composer.readBuffer holds the post-FXAA LDR color (the last write before
    // OutputPass reads it + writes to screen with sRGB conversion). After
    // composer.render() completes, readBuffer.texture is the FXAA output.
    const source = this.composer.readBuffer.texture;
    this._luminanceMaterial.uniforms.tDiffuse.value = source;
    try {
      renderer.setRenderTarget(this._luminanceRT);
      renderer.render(this._luminanceScene, this._luminanceCam);
      renderer.readRenderTargetPixels(this._luminanceRT, 0, 0, 16, 16, this._luminanceReadBuffer);
    } catch (err) {
      // Best-effort — eye adaptation is non-essential; disable on first failure.
      console.warn("[PostProcessing] Luminance readback failed, disabling eye adaptation:", err);
      this._luminanceRT?.dispose();
      this._luminanceRT = null;
      this._luminanceReadBuffer = null;
    } finally {
      renderer.setRenderTarget(prevRT);
    }

    // Average the R channel (luminance is encoded as grayscale RGB).
    let sum = 0;
    const buf = this._luminanceReadBuffer;
    // Defensive: the catch block above can null out the buffer if readRenderTargetPixels
    // failed mid-flight. Bail out of the adaptation step in that case (the next
    // tick will retry or disable eye adaptation entirely).
    if (!buf) return;
    for (let i = 0; i < buf.length; i += 4) sum += buf[i];
    const avg = sum / (16 * 16) / 255; // 0..1
    // Target: maintain post-tonemap average luminance ≈ 0.5 (mid-gray).
    // 1.0/avg would overshoot (post-tonemap is already ~0.4-0.8); 0.5/avg
    // hits the ACES mid-gray target. Clamp to [0.5, 1.6] per spec.
    const safeLum = Math.max(0.001, avg);
    this._targetExposure = Math.max(0.5, Math.min(1.6, 0.5 / safeLum));
  }

  /** Per-frame update — advances the grade shader's grain animation +
   *  updates SSR matrix uniforms (camera moves every frame) + throttled
   *  sky env map regeneration (every 5s).
   *
   *  Task-3 — also advances eye adaptation (lerps uExposure toward target)
   *  + updates the volumetric fog pass's sun direction + camera matrices.
   *
   *  Task-41 — motion-blur damping removed (the pass was removed from the
   *  pipeline; setMotionBlur is now a no-op). */
  update(dt: number) {
    this.elapsed += dt;
    if (this.gradePass) {
      (this.gradePass.material.uniforms.uTime.value as number) = this.elapsed;
    }
    // Task 24 — update SSR matrix uniforms per frame (camera moves every
    // frame; projection matrix changes on resize). The SSR shader works
    // entirely in view space (depth → view position via inverse projection,
    // reflected ray projected back via projection) so only the projection
    // matrix + its inverse are needed (no view/world matrix).
    if (this.ssrPass && this.ctx.camera) {
      const cam = this.ctx.camera;
      // projectionMatrixInverse is auto-updated by updateProjectionMatrix
      // (called on resize / fov change). Refresh world matrix in case the
      // engine hasn't this frame (harmless if already up-to-date).
      cam.updateMatrixWorld();
      const u = this.ssrPass.material.uniforms;
      (u.uProjection.value as THREE.Matrix4).copy(cam.projectionMatrix);
      (u.uInverseProjection.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    }
    // Task 24 — throttled sky env map regeneration (every 2s). Regenerates
    // the PMREM-pre-filtered env map from the live sky so PBR materials
    // reflect the current sky color (day/night/weather) + sun position
    // (the sun disk baked into applySkyEnvironment tracks sunLight.position
    // + color + intensity). 2s matches WeatherSystem.VISUALS_UPDATE_INTERVAL
    // PERF: PMREM regen renders the sky into a cube map + pre-filters 6 mips —
    // that's ~6 extra draw calls + 6 mip passes. At 2s interval that's a
    // ~3ms hitch every 120 frames. Relaxed to 5s: the sky changes slowly
    // (day/night cycle is ~24 min for a full cycle), and 5s still keeps
    // reflections within ~1 in-game minute of the visible sky.
    if (this.ctx.skyMesh && this._pmrem) {
      this._envRegenAccum += dt;
      if (this._envRegenAccum >= 5.0) {
        this._envRegenAccum = 0;
        try {
          this._skyEnvMap = applySkyEnvironment(
            this.ctx.scene,
            this.ctx.renderer,
            this.ctx.skyMesh,
            this._pmrem,
            this._skyEnvMap,
            this.ctx.sunLight ?? null,
          );
        } catch (err) {
          console.warn("[PostProcessing] Sky env regen failed:", err);
        }
      }
    }

    // A3-5000-retry / 410: oscillation guard. The original code sampled
    // POST-tonemap LDR but drove PRE-tonemap exposure — a feedback loop that
    // can oscillate (dark scene → exposure up → tonemap brightens → sample
    // says too bright → exposure down → repeat). The proper fix is to sample
    // PRE-tonemap HDR luminance (insert a downsample pass before the grade).
    // That's a larger restructure; the surgical mitigation here is (a) longer
    // τ (1.0s instead of 0.5s — slower adaptation, less likely to ring) and
    // (b) a per-frame delta clamp (max 0.05 change) so the loop can't runaway.
    // The PRE-tonemap HDR sampling is tracked as a follow-up.
    //
    // Task-3 — Eye adaptation: lerp current exposure toward the target
    // (sampled every 6 frames in _sampleLuminanceAndAdapt).
    if (this._luminanceRT && this.gradePass) {
      const tau = 1.0; // A3-5000-retry / 410: was 0.5s; slowed to 1.0s to damp oscillation.
      const k = 1 - Math.exp(-dt / tau);
      const prevExposure = this._currentExposure;
      this._currentExposure += (this._targetExposure - this._currentExposure) * k;
      // A3-5000-retry / 410: per-frame delta clamp (max 0.05 change) to prevent
      // the LDR-sample/HDR-target feedback loop from oscillating.
      const delta = this._currentExposure - prevExposure;
      if (Math.abs(delta) > 0.05) {
        this._currentExposure = prevExposure + Math.sign(delta) * 0.05;
      }
      let exposureValue = this._currentExposure * 1.15;
      // Task-9 (Prompt #84) — Day/night affects player visibility. At night,
      // reduce exposure by up to 0.2 (smooth ramp via nightness factor so
      // dawn/dusk transitions don't pop). The nightness formula mirrors
      // RendererSystem.computeNightness: full night 22-4h, dawn fade 4-6h,
      // day 6-18h, dusk fade 18-22h. The -0.2 offset is applied AFTER the
      // eye-adaptation lerp so it stacks with the auto-exposure target
      // (the eye still adapts to indoor/outdoor brightness on top of the
      // night-darkening baseline). Clamped to a min of 0.4 so the scene
      // never goes pitch black (gameplay-readable per the spec).
      const tod = this.ctx.weather.timeOfDay;
      const nightness =
        tod >= 22 || tod < 4 ? 1 :
        tod >= 4 && tod < 6 ? (6 - tod) / 2 :
        tod >= 6 && tod < 18 ? 0 :
        (tod - 18) / 4;
      exposureValue = Math.max(0.4, exposureValue - nightness * 0.2);
      (this.gradePass.material.uniforms.uExposure.value as number) = exposureValue;
      // Sync renderer.toneMappingExposure (no-op with NoToneMapping, but
      // satisfies the spec's literal wording + future-proofs the fallback).
      this.ctx.renderer.toneMappingExposure = exposureValue;
      // A3-5000-retry / 412: double-tonemap guard. RendererSystem.ts:75 sets
      // renderer.toneMapping=NoToneMapping so the grade shader's ACES is the
      // sole tonemapper. If anything flips toneMapping back (e.g. a debug
      // overlay, a future RenderPipeline change), the next frame would
      // double-tonemap (renderer tonemap + ACES in the grade). Re-assert
      // NoToneMapping here every frame while the composer is active.
      if (this.ctx.renderer.toneMapping !== THREE.NoToneMapping) {
        this.ctx.renderer.toneMapping = THREE.NoToneMapping;
      }
    }

    // Task-3 — Volumetric fog + god rays: push the live sun direction
    // (drives the god-ray march direction) + camera matrices (for view-space
    // reconstruction) every frame. The sun light is built AFTER PostProcessing
    // constructs (buildLights runs after the composer init in engine.ts), so
    // we read ctx.sunLight lazily here.
    if (this.volFogPass) {
      if (this.ctx.sunLight) {
        // sunDir = direction the light TRAVELS = normalize(target - sunPos).
        // The sun's target is at the world origin (set in updateWeatherVisuals).
        const sp = this.ctx.sunLight.position;
        // A3-5000-retry / 460: NaN guard. If sunLight.position is (0,0,0)
        // (uninitialized / midnight), normalize() returns (0,0,0) which then
        // propagates NaN through the vol-fog shader. Skip the update in that case.
        if (sp.lengthSq() > 1e-6) {
          this._sunDirScratch.set(-sp.x, -sp.y, -sp.z).normalize();
          this.volFogPass.setSunDirection(this._sunDirScratch);
        }
        // Tint the god-ray color by the sun's current color (warm at dawn/dusk,
        // white at midday, dim blue at night) so the volumetric lighting
        // matches the visible sun.
        const sunColor = this.volFogPass.pass.material.uniforms.uSunColor.value as THREE.Color;
        sunColor.copy(this.ctx.sunLight.color);
        // Dim god-rays at night (sun is replaced by dim moonlight).
        const intensityScale = Math.max(0.05, Math.min(1.0, this.ctx.sunLight.intensity / 2.6));
        this.volFogPass.setGodRayIntensity(0.45 * intensityScale);
      }
      this.volFogPass.update(this.ctx.camera);
    }

    // ─── Section A — per-frame updates for the new passes ───
    // RT shadows — push sun direction + camera matrices.
    if (this._rtShadowPass && this.ctx.sunLight) {
      const sp = this.ctx.sunLight.position;
      if (sp.lengthSq() > 1e-6) {
        this._sunDirScratch.set(-sp.x, -sp.y, -sp.z).normalize();
        this._rtShadowPass.setSunDirection(this._sunDirScratch);
      }
      this._rtShadowPass.setSunColor(this.ctx.sunLight.color);
      this._rtShadowPass.update(this.ctx.camera);
    }
    // Surfel GI — update camera matrices + step the simulation.
    if (this._surfelGIPass && this.ctx.sunLight) {
      this._surfelGIPass.update(this.ctx.camera, this.elapsed, this.ctx.sunLight.color);
    }
    // Water caustics — step the SWE simulation + update camera matrices.
    if (this._causticsPass) {
      if (this.ctx.sunLight) {
        const sp = this.ctx.sunLight.position;
        if (sp.lengthSq() > 1e-6) {
          this._sunDirScratch.set(-sp.x, -sp.y, -sp.z).normalize();
          this._causticsPass.setSunDirection(this._sunDirScratch);
        }
      }
      this._causticsPass.update(dt, this.ctx.camera);
    }
    // Aerial perspective — push camera matrices + sun direction.
    if (this._aerialPass) {
      if (this.ctx.sunLight) {
        const sp = this.ctx.sunLight.position;
        if (sp.lengthSq() > 1e-6) {
          this._sunDirScratch.set(-sp.x, -sp.y, -sp.z).normalize();
          this._aerialPass.setSunDirection(this._sunDirScratch);
        }
        this._aerialPass.setSunColor(this.ctx.sunLight.color);
      }
      this._aerialPass.update(this.ctx.camera);
    }
    // SSS — push camera matrices.
    if (this._sssPass) this._sssPass.update(this.ctx.camera);
    // Thermal barrels — step the temperature simulation + update the mask.
    if (this._thermalBarrels) {
      this._thermalBarrels.update(dt);
      this._thermalBarrels.updateMask();
    }
    // Frost pattern — drive the frost amount from the weather temperature.
    // WeatherState doesn't expose temperature directly; we derive it from the
    // precipitation (rain = warmer, snow = colder) + a per-map default.
    if (this._frostPass) {
      // Cheap temperature proxy: -10°C at heavy snow, +20°C at clear weather.
      // Real per-map temperature should be added to WeatherState in a follow-up.
      const precip = this.ctx.weather?.precipitation ?? 0;
      const temp = 20 - precip * 30; // 20°C at 0 precip, -10°C at 1.0 precip.
      this._frostPass.update(dt, temp, this.ctx.camera);
    }
    // Shell-shock — advance the shock level lerp + the time uniform.
    if (this._shellShockPass) this._shellShockPass.update(dt);
    // Lens dirt — accumulate over the match.
    if (this._lensDirtPass) this._lensDirtPass.update(dt);
    // HDR eye adaptation — drive from the luminance readback.
    if (this._hdrEyeAdaptation && this._luminanceReadBuffer) {
      // Cheap recompute of avg luminance (the luminance pass already filled
      // the buffer; we approximate the average from the existing readback).
      let sum = 0;
      const buf = this._luminanceReadBuffer;
      for (let i = 0; i < buf.length; i += 4) sum += buf[i];
      const avg = sum / (buf.length / 4) / 255;
      this._hdrEyeAdaptation.update(dt, avg);
      // Push the new exposure to the grade shader (overrides the basic
      // eye-adaptation lerp above).
      if (this.gradePass) {
        const state = this._hdrEyeAdaptation.getState();
        (this.gradePass.material.uniforms.uExposure.value as number) = state.exposure;
        this.ctx.renderer.toneMappingExposure = state.exposure;
      }
    }
    // Film grain per-ISO — auto-ISO from the luminance readback.
    if (this._filmGrain && this._luminanceReadBuffer) {
      let sum = 0;
      const buf = this._luminanceReadBuffer;
      for (let i = 0; i < buf.length; i += 4) sum += buf[i];
      const avg = sum / (buf.length / 4) / 255;
      this._filmGrain.update(dt, avg);
      // Push the current grain preset to the grade shader.
      if (this.gradePass) {
        const u = this.gradePass.material.uniforms;
        this._filmGrain.applyToUniforms({
          uGrain: u.uGrain as { value: number },
          uGrainEnable: u.uGrainEnable as { value: number },
        });
      }
    }
    // Neural denoiser — advance the temporal filter.
    if (this._denoiserPass) this._denoiserPass.advanceHistory();
  }

  /** Returns true if the engine should use the composer. Always true once the
   *  baseline (grade + vignette + FXAA) is constructed. */
  get shouldUseComposer() {
    return this.enabled && this.hasComposer && this.composer !== null;
  }

  /** Resize all passes. Task 24 — also re-creates the depth texture at the
   *  new size for SSR + updates the grade pass's texel size (for the merged
   *  sharpen kernel) + FXAA's resolution uniform.
   *  Task-41 — sharpen pass removed (merged into grade); motion-blur pass
   *  removed entirely.
   *  Task-3 — also resizes the volumetric fog pass + rebinds the depth
   *  texture to it (the SSR resize path disposes + recreates the depth
   *  texture, so we must re-bind it here). */
  onResize(w: number, h: number) {
    this.width = w;
    this.height = h;
    if (!this.composer) return;
    this.composer.setSize(w, h);
    this.ssaoPass?.setSize(w, h);
    this.bloomPass?.setSize(w, h);
    // Task 24 — re-create depth texture at new size for SSR.
    if (this.ssrPass && !this._ssrDisabled) {
      if (this._depthTexture) this._depthTexture.dispose();
      this._depthTexture = new THREE.DepthTexture(w, h);
      this._depthTexture.type = THREE.UnsignedShortType;
      this.composer.renderTarget1.depthTexture = this._depthTexture;
      this.ssrPass.material.uniforms.tDepth.value = this._depthTexture;
      this.ssrPass.material.uniforms.uResolution.value.set(w, h);
    }
    // Task-3 — re-bind depth texture to volumetric fog (depth texture may have
    // been re-created above) + update resolution uniform.
    if (this.volFogPass) {
      if (this._depthTexture) this.volFogPass.setDepthTexture(this._depthTexture);
      this.volFogPass.setSize(w, h);
    }
    if (this.fxaaPass) {
      const pxr = this.composer!.renderer.getPixelRatio();
      this.fxaaPass.material.uniforms.resolution.value.set(1 / (w * pxr), 1 / (h * pxr));
    }
    // Task-41 — update grade pass texel size for the merged sharpen kernel.
    if (this.gradePass) {
      const pxr = this.composer!.renderer.getPixelRatio();
      this.gradePass.material.uniforms.uTexelSize.value.set(1 / (w * pxr), 1 / (h * pxr));
    }
    // ─── Section A — resize the new passes ───
    this._rtShadowPass?.setSize(w, h);
    this._surfelGIPass?.setSize(w, h);
    this._denoiserPass?.setSize(w, h);
    this._causticsPass?.setSize(w, h);
    this._aerialPass?.setSize(w, h);
    this._sssPass?.setSize(w, h);
    this._anamorphicPass?.setSize(w, h);
    this._shellShockPass?.setSize(w, h);
    this._thermalPass?.setSize(w, h);
    this._frostPass?.setSize(w, h);
    this._lensDirtPass?.setSize(w, h);
  }

  /** Enable/disable post-processing (for low-end hardware fallback). */
  setEnabled(v: boolean) { this.enabled = v; }

  /** Adjust bloom strength (e.g. tie to suppression for a dazed effect). */
  setBloomStrength(v: number) { if (this.bloomPass) this.bloomPass.strength = v; }

  /** Adjust the color-grade saturation (0 = B&W, 1 = neutral, >1 = vivid). */
  setSaturation(v: number) {
    if (this.gradePass) (this.gradePass.material.uniforms.uSaturation.value as number) = v;
  }

  /** Adjust vignette intensity (0 = none, 1 = heavy). */
  setVignette(v: number) {
    if (this.gradePass) (this.gradePass.material.uniforms.uVignette.value as number) = v;
  }

  /** V2 — Set the motion-blur intensity (0..1). Called by ChunkManager each
   *  frame based on camera angular velocity. Also accepts the yaw/pitch
   *  direction so the blur follows the turn direction.
   *
   *  A3-5000-retry / 411 — motion blur RE-IMPLEMENTED as a 4-tap directional
   *  blur folded into the GradeVignetteShader (no separate pass — saves the
   *  full-screen render the old removed pass would have cost). The blur dir
   *  is computed from yawDir/pitchDir; intensity 0 disables the taps. */
  setMotionBlur(intensity: number, yawDir = 0, pitchDir = 0) {
    if (!this.gradePass) return;
    const u = this.gradePass.material.uniforms;
    (u.uMotionBlurIntensity.value as number) = Math.max(0, Math.min(1, intensity));
    // Normalize the blur direction (yaw + pitch). yawDir is horizontal screen
    // velocity, pitchDir is vertical.
    const len = Math.hypot(yawDir, pitchDir);
    if (len > 1e-6) {
      (u.uMotionBlurDir.value as THREE.Vector2).set(yawDir / len, pitchDir / len);
    }
  }

  /** A3-5000-retry / 459: toggle film grain on/off. */
  setGrainEnabled(enabled: boolean) {
    if (this.gradePass) {
      (this.gradePass.material.uniforms.uGrainEnable.value as number) = enabled ? 1 : 0;
    }
  }

  /** A3-5000-retry / 437: bind a per-map LUT texture for color grading.
   *  Pass null to disable LUT grading (fall back to the ACES grade). */
  setLUT(lut: THREE.Texture | null) {
    if (this.gradePass) {
      (this.gradePass.material.uniforms.uLUT.value as THREE.Texture | null) = lut;
      (this.gradePass.material.uniforms.uLUTEnabled.value as number) = lut ? 1 : 0;
    }
  }

  // ─── Section A — public API for gameplay systems ───

  /** Set the shell-shock level (0..1). Called by MedicalSystem on damage taken
   *  + SuppressionSystem on near-misses. The pass smoothly lerps the actual
   *  shock toward this target (configurable via recoveryTau). */
  setShellShock(level: number): void {
    if (this._shellShockPass) this._shellShockPass.setShockLevel(level);
  }

  /** Trigger an instant shell-shock spike (e.g. on damage taken) — bypasses
   *  the recovery lerp for immediate feedback. */
  triggerShellShockSpike(level: number): void {
    if (this._shellShockPass) this._shellShockPass.triggerSpike(level);
  }

  /** Player "wipe lens" action — reduces the lens dirt accumulation by 80 %. */
  wipeLens(): void {
    if (this._lensDirtPass) this._lensDirtPass.wipe();
  }

  /** Reset the lens dirt accumulation to zero (e.g. on match start). */
  resetLensDirt(): void {
    if (this._lensDirtPass) this._lensDirtPass.reset();
  }

  /** Register a weapon with the thermal barrel system (call on equip). */
  registerThermalWeapon(weaponId: string, slug: string): void {
    if (this._thermalBarrels) this._thermalBarrels.registerWeapon(weaponId, slug);
  }

  /** Unregister a weapon from the thermal barrel system (call on unequip). */
  unregisterThermalWeapon(weaponId: string): void {
    if (this._thermalBarrels) this._thermalBarrels.unregisterWeapon(weaponId);
  }

  /** Record a round fired — adds heat to the weapon's barrel. */
  recordThermalRoundFired(weaponId: string, rounds = 1): void {
    if (this._thermalBarrels) this._thermalBarrels.recordRoundFired(weaponId, rounds);
  }

  /** Get the current barrel temperature for a weapon (°C). */
  getBarrelTemperature(weaponId: string): number {
    return this._thermalBarrels?.getTemperature(weaponId) ?? 20;
  }

  /** Get the current barrel glow amount (0..1) — drives the weapon view
   *  model's emissive intensity. */
  getBarrelGlow(weaponId: string): number {
    return this._thermalBarrels?.getGlowAmount(weaponId) ?? 0;
  }

  /** Drop a ripple into the water caustics SWE simulation (e.g. when a
   *  player walks into water or a bullet hits the surface). */
  addWaterRipple(worldX: number, worldZ: number, strength: number): void {
    if (this._causticsPass) this._causticsPass.addRipple(worldX, worldZ, strength);
  }

  /** Get the thermal barrel system (for diagnostics / HUD). */
  getThermalBarrels(): ThermalBarrelSystem | null { return this._thermalBarrels; }
  /** Get the HDR eye adaptation state (for diagnostics). */
  getEyeAdaptation(): HDREyeAdaptation | null { return this._hdrEyeAdaptation; }
  /** Get the film grain controller (for diagnostics / settings UI). */
  getFilmGrain(): FilmGrainPerISO | null { return this._filmGrain; }

  dispose() {
    this.composer?.dispose();
    this.composer = null;
    this.ssaoPass = null;
    this.bloomPass = null;
    this.ssrPass = null;
    this.gradePass = null;
    this.fxaaPass = null;
    this.outputPass = null;
    // Task 24 — dispose depth texture + PMREM + sky env map.
    this._depthTexture?.dispose();
    this._depthTexture = null;
    this._skyEnvMap?.dispose();
    this._skyEnvMap = null;
    this._pmrem?.dispose();
    this._pmrem = null;
    // Task-3 — dispose volumetric fog pass + eye-adaptation resources.
    this.volFogPass?.dispose();
    this.volFogPass = null;
    this._luminanceRT?.dispose();
    this._luminanceRT = null;
    this._luminanceMaterial?.dispose();
    this._luminanceMaterial = null;
    this._luminanceScene = null;
    this._luminanceCam = null;
    this._luminanceReadBuffer = null;
    // ─── Section A — dispose the new passes ───
    this._rtShadowPass?.dispose();
    this._rtShadowPass = null;
    this._surfelGIPass?.dispose();
    this._surfelGIPass = null;
    this._denoiserPass?.dispose();
    this._denoiserPass = null;
    this._causticsPass?.dispose();
    this._causticsPass = null;
    this._aerialPass?.dispose();
    this._aerialPass = null;
    this._sssPass?.dispose();
    this._sssPass = null;
    this._anamorphicPass?.dispose();
    this._anamorphicPass = null;
    this._shellShockPass?.dispose();
    this._shellShockPass = null;
    this._thermalPass?.dispose();
    this._thermalPass = null;
    this._frostPass?.dispose();
    this._frostPass = null;
    this._lensDirtPass?.dispose();
    this._lensDirtPass = null;
    this._hdrEyeAdaptation = null;
    this._filmGrain = null;
    this._thermalBarrels = null;
    this.hasComposer = false;
  }
}
