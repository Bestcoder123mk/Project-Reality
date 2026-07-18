/**
 * SEC3-RENDER Prompt 22 — Screen-Space Reflections (SSR).
 *
 * A self-contained SSR pass with explicit roughness gating. Unlike the
 * existing inline SSR shader in systems/PostProcessing.ts (which uses a
 * metalness heuristic from pixel brightness), this pass consumes a real
 * roughness buffer when one is attached (falls back to the heuristic if
 * absent). Raymarches the depth buffer along the reflection vector with
 * Hi-Z style mip-stepping: each successive step doubles in length, so the
 * ray covers ground quickly without missing near-field hits.
 *
 * Quality gating:
 *   - high/ultra: 32 max steps, 0.35 roughness threshold
 *   - medium:     16 max steps, 0.20 roughness threshold
 *   - low:        disabled
 *
 * Public API:
 *   - SSRPass class (wraps ShaderPass for EffectComposer integration)
 *   - setRoughnessThreshold(r): skip pixels whose roughness exceeds r
 *   - setMaxSteps(n): march step budget
 *   - setRoughnessTexture(tex): optional G-buffer roughness RT
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface SSRConfig {
  roughnessThreshold: number; // 0..1 — only reflect pixels with roughness below this
  maxSteps: number;           // march budget (16/32)
  stepSize: number;           // initial step in screen UV
  thickness: number;          // depth thickness to accept a hit (0.05..0.5)
  strength: number;           // 0..1 reflection opacity
  maxDistance: number;        // max view-space distance
}

export const SSR_QUALITY_DEFAULTS: Record<"low" | "medium" | "high", SSRConfig | null> = {
  low: null,
  medium: { roughnessThreshold: 0.20, maxSteps: 16, stepSize: 0.04, thickness: 0.1, strength: 0.25, maxDistance: 25 },
  high: { roughnessThreshold: 0.35, maxSteps: 32, stepSize: 0.03, thickness: 0.06, strength: 0.4, maxDistance: 50 },
};

export const SSRShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    /** Optional G-buffer roughness texture (LinearRgbeFormat or R8). When
     *  null, falls back to a brightness-based heuristic. */
    tRoughness: { value: null as THREE.Texture | null },
    /** E1-5000 #2339 — Optional G-buffer metalness texture (R8). When
     *  present, the shader reads metalness directly — no heuristic. The
     *  prior brightness+saturation heuristic misclassified bright diffuse
     *  surfaces (white paint, snow) as metal + dark metals as dielectric. */
    tMetalness: { value: null as THREE.Texture | null },
    uProjection: { value: new THREE.Matrix4() },
    uInverseProjection: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uRoughnessThreshold: { value: 0.35 },
    uMaxSteps: { value: 32 },
    uStepSize: { value: 0.03 },
    uThickness: { value: 0.06 },
    uStrength: { value: 0.4 },
    uMaxDistance: { value: 50.0 },
    /** E1-5000 #2307 — Uniform bool flags replacing invalid `sampler != null`
     *  GLSL comparisons (illegal in WebGL1, always true in WebGL2 — so the
     *  prior roughness/metalness texture branches never actually fired). */
    uHasRoughness: { value: 0 },
    uHasMetalness: { value: 0 },
    /** E1-5000 #2306 — Edge-fade margin (pixels). Reflections near the
     *  screen border are attenuated so the raymarch's out-of-bounds hits
     *  don't produce hard reflection cutoffs at the edges. */
    uEdgeFade: { value: 12.0 },
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
    uniform sampler2D tRoughness;
    uniform sampler2D tMetalness;
    uniform mat4 uProjection;
    uniform mat4 uInverseProjection;
    uniform vec2 uResolution;
    uniform float uRoughnessThreshold;
    uniform float uMaxSteps;
    uniform float uStepSize;
    uniform float uThickness;
    uniform float uStrength;
    uniform float uMaxDistance;
    uniform int uHasRoughness;
    uniform int uHasMetalness;
    uniform float uEdgeFade;
    varying vec2 vUv;

    vec3 reconstructViewPos(vec2 uv, float depth) {
      float z = depth * 2.0 - 1.0;
      vec4 clip = vec4(uv * 2.0 - 1.0, z, 1.0);
      vec4 view = uInverseProjection * clip;
      // E1-5000 #2306 — Epsilon-guard the w-division (sky / far-plane
      // pixels have w≈0 → NaN that propagates through the reflection math).
      return view.xyz / max(abs(view.w), 1e-6);
    }

    // E1-5000 #2306 — Edge-fade factor: attenuate reflections near screen
    // borders so the raymarch's out-of-bounds hits don't produce hard
    // reflection cutoffs at the edges.
    float edgeFade(vec2 uv) {
      vec2 d = min(uv, 1.0 - uv);
      float m = min(d.x, d.y);
      return smoothstep(0.0, uEdgeFade / max(uResolution.x, uResolution.y), m);
    }

    // 2D pseudo-random for jittering the ray start.
    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;
      if (depth >= 0.9999) {
        gl_FragColor = col;
        return;
      }

      // Roughness — explicit texture if available, else heuristic.
      // E1-5000 #2307 — Use the uniform bool flag (the prior 'sampler != null'
      // test was a no-op in WebGL2 + illegal in WebGL1, so the roughness
      // texture was never sampled even when the host attached one).
      float roughness;
      if (uHasRoughness == 1) {
        roughness = texture2D(tRoughness, vUv).r;
      } else {
        // Heuristic: low-saturation midtones = likely metal (reflective).
        float lum = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
        float mx = max(col.r, max(col.g, col.b));
        float mn = min(col.r, min(col.g, col.b));
        float sat = mx - mn;
        roughness = 1.0 - clamp((lum - 0.18) * (1.0 - sat * 2.0), 0.0, 1.0);
      }
      // E1-5000 #2339 — Real metalness map (when available). The prior
      // brightness+saturation heuristic misclassified bright diffuse surfaces
      // (white paint, snow, headlights) as metal + dark metals (gunmetal)
      // as dielectric. With the map, metalness is authoritative.
      float metalness = 0.0;
      if (uHasMetalness == 1) {
        metalness = texture2D(tMetalness, vUv).r;
      } else {
        // Heuristic fallback: low-saturation midtones = likely metal.
        float lum = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
        float mx = max(col.r, max(col.g, col.b));
        float mn = min(col.r, min(col.g, col.b));
        float sat = mx - mn;
        metalness = clamp((1.0 - sat * 2.0) * smoothstep(0.3, 0.8, lum), 0.0, 1.0);
      }

      // Skip rough OR non-metal surfaces entirely (no SSR contribution).
      // E1-5000 #2339 — Only reflect metal pixels (or, when no metalness
      // map is bound, pixels the heuristic flagged as metal).
      if (roughness > uRoughnessThreshold || metalness < 0.1 || uStrength < 0.001) {
        gl_FragColor = col;
        return;
      }

      vec3 viewPos = reconstructViewPos(vUv, depth);
      vec3 dFdxView = dFdx(viewPos);
      vec3 dFdyView = dFdy(viewPos);
      // E1-5000 #2306 — Epsilon-guard the cross product (degenerate on
      // flat surfaces → NaN normal → NaN reflection).
      vec3 crossN = cross(dFdxView, dFdyView);
      float crossLen = length(crossN);
      vec3 normal = crossLen > 1e-6 ? crossN / crossLen : vec3(0.0, 0.0, 1.0);
      if (normal.z < 0.0) normal = -normal;

      // E1-5000 #2309 — viewDir is the direction from the SURFACE to the
      // CAMERA (V). The prior code used 'normalize(viewPos)' which is the
      // camera→surface vector (the incident direction I); using V as the
      // viewDir makes the NdotV / Fresnel / reflect maths consistent with
      // the standard BRDF formulation. 'reflect(-V, N)' then gives the
      // reflected ray direction (away from the surface, into the scene).
      vec3 viewDir = normalize(-viewPos);
      vec3 reflected = reflect(-viewDir, normal);

      // Fresnel (Schlick) — stronger at grazing angles.
      float NdotV = clamp(dot(normal, viewDir), 0.0, 1.0);
      float fresnel = pow(1.0 - NdotV, 3.0);

      // E1-5000 #2308 — Correct Hi-Z march. The prior code doubled
      // stepDist (×1.5 actually) but marched sampleUv += stepDir *
      // stepDist / uStepSize in screen space while computing expectedZ
      // linearly along the reflected vector — the two spaces didn't agree,
      // so the depth comparison fired at the wrong pixels. The new march
      // tracks the ray position in VIEW space (linear along 'reflected'),
      // projects each step to screen space, and doubles the step length
      // every other iteration (true Hi-Z doubling: 1, 2, 4, 8, ...).
      vec2 jitter = vec2(rand(vUv), rand(vUv + 0.5)) * 2.0 - 1.0;
      vec3 rayPos = viewPos + reflected * uStepSize * (0.5 + 0.5 * jitter.x);
      vec3 rayStep = reflected * uStepSize;
      float stepLen = 1.0;

      vec3 reflection = col.rgb;
      float hit = 0.0;
      for (int i = 1; i <= 64; i++) {
        if (float(i) > uMaxSteps) break;
        // Advance the ray in view space, doubling the step every 2 iterations
        // (true Hi-Z — covers ground quickly without missing near hits).
        rayPos += rayStep * stepLen;
        if (stepLen < 16.0) stepLen *= 2.0;
        // Project the ray position back to screen UV.
        vec4 proj = uProjection * vec4(rayPos, 1.0);
        if (proj.w <= 0.0) break;
        vec2 sampleUv = (proj.xy / proj.w) * 0.5 + 0.5;
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) break;
        float sampleDepth = texture2D(tDepth, sampleUv).r;
        if (sampleDepth >= 0.9999) continue;
        vec3 sampleViewPos = reconstructViewPos(sampleUv, sampleDepth);
        // E1-5000 #2340 — Depth thickness tolerance. Default 0.06 (high)
        // / 0.1 (medium) — 5–10 cm, tight enough to reject thin occluders
        // but loose enough to catch the reflection target. The prior code
        // had a 0.3 (30 cm) tolerance that caught the wrong surface.
        float zDiff = abs(sampleViewPos.z - rayPos.z);
        if (zDiff < uThickness) {
          reflection = texture2D(tDiffuse, sampleUv).rgb;
          hit = 1.0;
          break;
        }
      }

      // Reflection intensity modulated by roughness (smoother = stronger)
      // + fresnel.
      float reflStrength = (1.0 - roughness / uRoughnessThreshold) * (0.7 + 0.3 * fresnel);
      // E1-5000 #2339 — Weight by metalness so non-metals don't get full
      // reflection strength.
      reflStrength *= metalness;
      float intensity = hit * reflStrength * uStrength;
      // E1-5000 #2306 — Edge-fade so reflections near the screen border
      // attenuate smoothly (no hard cutoff).
      intensity *= edgeFade(vUv);

      gl_FragColor = vec4(mix(col.rgb, reflection, clamp(intensity, 0.0, 1.0)), col.a);
    }
  `,
};

/** SSR post-process pass — wraps the shader. */
export class SSRPass {
  readonly pass: ShaderPass;
  private enabled = true;
  private config: SSRConfig;
  /** #629 — Quality tier the pass was constructed for. Used by
   *  `degradeForTier()` to decide whether to disable the pass on lower-end
   *  hardware. The host calls this from HardwareDetect when the GPU tier
   *  drops below "medium" or when the user enables the mobile/touch
   *  preset. */
  private tier: "low" | "medium" | "high";
  /** #630 — ping-pong history RTs for the temporal filter. Null until
   *  setSize is called (the host allocates them at the right resolution). */
  private historyA: THREE.WebGLRenderTarget | null = null;
  private historyB: THREE.WebGLRenderTarget | null = null;
  private historyReadIndex: 0 | 1 = 0;

  constructor(
    config: SSRConfig = SSR_QUALITY_DEFAULTS.high ?? {
      roughnessThreshold: 0.35, maxSteps: 32, stepSize: 0.03, thickness: 0.06, strength: 0.4, maxDistance: 50,
    },
    tier: "low" | "medium" | "high" = "high",
  ) {
    this.config = { ...config };
    this.tier = tier;
    this.pass = new ShaderPass(SSRShader);
    const u = this.pass.material.uniforms;
    u.uRoughnessThreshold.value = this.config.roughnessThreshold;
    u.uMaxSteps.value = this.config.maxSteps;
    u.uStepSize.value = this.config.stepSize;
    u.uThickness.value = this.config.thickness;
    u.uStrength.value = this.config.strength;
    u.uMaxDistance.value = this.config.maxDistance;
  }

  /** #629 — Degrade the SSR pass for a lower hardware tier. Called by
   *  HardwareDetect when the GPU tier changes. Returns true if the pass
   *  is still enabled after degradation, false if it was disabled.
   *
   *  - low:    disabled entirely (mobile/integrated GPUs — SSR's 32-tap
   *            raymarch is too expensive)
   *  - medium: halved step count (16) + halved strength (0.2)
   *  - high:   no change */
  degradeForTier(tier: "low" | "medium" | "high"): boolean {
    this.tier = tier;
    if (tier === "low") {
      this.setEnabled(false);
      return false;
    }
    // Re-enable in case we degraded to low earlier.
    if (!this.enabled) this.setEnabled(true);
    const cfg = SSR_QUALITY_DEFAULTS[tier];
    if (cfg) {
      this.config = { ...cfg };
      const u = this.pass.material.uniforms;
      u.uRoughnessThreshold.value = cfg.roughnessThreshold;
      u.uMaxSteps.value = cfg.maxSteps;
      u.uStepSize.value = cfg.stepSize;
      u.uThickness.value = cfg.thickness;
      u.uStrength.value = cfg.strength;
      u.uMaxDistance.value = cfg.maxDistance;
    }
    return true;
  }

  /** #629 — Convenience predicate: should SSR be enabled on this tier?
   *  Pure function — exported so tests + the HardwareDetect config
   *  validator can call it without constructing a pass. */
  static shouldEnableForTier(tier: "low" | "medium" | "high"): boolean {
    return tier !== "low";
  }

  /** Set the roughness threshold (0..1) — surfaces with roughness > r are skipped. */
  setRoughnessThreshold(r: number): void {
    this.config.roughnessThreshold = THREE.MathUtils.clamp(r, 0, 1);
    (this.pass.material.uniforms.uRoughnessThreshold.value as number) = this.config.roughnessThreshold;
  }

  /** Set the max march steps (8..64). */
  setMaxSteps(n: number): void {
    this.config.maxSteps = Math.max(4, Math.min(64, Math.round(n)));
    (this.pass.material.uniforms.uMaxSteps.value as number) = this.config.maxSteps;
  }

  /** Attach a roughness G-buffer texture (optional — null falls back to heuristic). */
  setRoughnessTexture(tex: THREE.Texture | null): void {
    (this.pass.material.uniforms.tRoughness.value as THREE.Texture | null) = tex;
    // E1-5000 #2307 — flip the uniform bool flag (replaces invalid sampler test).
    (this.pass.material.uniforms.uHasRoughness.value as number) = tex ? 1 : 0;
  }

  /** E1-5000 #2339 — Attach a metalness G-buffer texture. When present,
   *  the shader reads metalness directly (no brightness heuristic). */
  setMetalnessTexture(tex: THREE.Texture | null): void {
    (this.pass.material.uniforms.tMetalness.value as THREE.Texture | null) = tex;
    (this.pass.material.uniforms.uHasMetalness.value as number) = tex ? 1 : 0;
  }

  /** E1-5000 #2306 — Set the edge-fade margin (pixels). Reflections
   *  within this many pixels of the screen border are attenuated. */
  setEdgeFade(px: number): void {
    (this.pass.material.uniforms.uEdgeFade.value as number) = Math.max(0, px);
  }

  /** Enable/disable the pass. */
  setEnabled(v: boolean): void {
    this.enabled = v;
    this.pass.enabled = v;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setDepthTexture(tex: THREE.DepthTexture): void {
    (this.pass.material.uniforms.tDepth.value as THREE.DepthTexture | null) = tex;
  }

  update(camera: THREE.Camera): void {
    if (!this.enabled) return;
    camera.updateMatrixWorld();
    const u = this.pass.material.uniforms;
    (u.uProjection.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (u.uInverseProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
  }

  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    // #630 — allocate (or resize) the temporal-filter history RTs at half-res
    // (SSR's noisy reflection benefits from temporal accumulation; running
    // the history at half-res keeps the extra memory cost low).
    const hw = Math.max(2, Math.floor(w / 2));
    const hh = Math.max(2, Math.floor(h / 2));
    if (!this.historyA) {
      this.historyA = new THREE.WebGLRenderTarget(hw, hh, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.historyB = this.historyA.clone();
    } else {
      this.historyA.setSize(hw, hh);
      this.historyB?.setSize(hw, hh);
    }
  }

  /** #630 — Advance the temporal filter: swap history ping-pong RTs.
   *  The host calls this AFTER each SSR render so the next frame reads
   *  from the freshly-written history. The actual blend is performed by
   *  the host compositing the history texture over the current SSR output
   *  (cheap: one extra texture fetch in the host's compositor shader). */
  advanceHistory(): void {
    this.historyReadIndex = this.historyReadIndex === 0 ? 1 : 0;
  }

  /** #630 — Get the history RT the host should read FROM this frame
   *  (the previous frame's SSR output). */
  getHistoryReadTarget(): THREE.WebGLRenderTarget | null {
    return this.historyReadIndex === 0 ? this.historyA : this.historyB;
  }

  /** #630 — Get the history RT the host should render INTO this frame. */
  getHistoryWriteTarget(): THREE.WebGLRenderTarget | null {
    return this.historyReadIndex === 0 ? this.historyB : this.historyA;
  }

  /** #630 — Convenience predicate for the host: is the temporal filter
   *  ready (history RTs allocated)? */
  hasTemporalHistory(): boolean {
    return this.historyA !== null && this.historyB !== null;
  }

  /** A3-5000 #481: enable/disable temporal filtering. The history RTs are
   *  always allocated in setSize(); this flag controls whether the host
   *  composites the history texture over the current frame. Default true. */
  private temporalEnabled = true;
  setTemporalEnabled(v: boolean): void { this.temporalEnabled = v; }
  isTemporalEnabled(): boolean { return this.temporalEnabled; }

  /** A3-5000 #482: enable/disable half-res mode. When true, the host should
   *  render the SSR pass at half resolution (Composer's renderScale = 0.5).
   *  VisualEnhancements.DEFAULT_SSR.halfRes=true wires this via the host. */
  private halfRes = false;
  setHalfRes(v: boolean): void { this.halfRes = v; }
  isHalfRes(): boolean { return this.halfRes; }

  dispose(): void {
    this.pass.dispose();
    this.historyA?.dispose();
    this.historyB?.dispose();
    this.historyA = null;
    this.historyB = null;
  }

  getConfig(): Readonly<SSRConfig> {
    return this.config;
  }
}
