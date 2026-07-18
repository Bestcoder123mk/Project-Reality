/**
 * SEC3-RENDER Prompt 21 — Screen-Space Ambient Occlusion.
 *
 * Hemisphere-kernel SSAO post-process pass. Generates a 32-sample kernel
 * (cosine-weighted, deterministic via Fibonacci spiral — same distribution
 * the GI baker uses) + a 4×4 rotation-noise texture for per-pixel kernel
 * rotation (eliminates banding). Reads the depth buffer + reconstructs
 * view-space normals via dFdx/dFdy cross product (no normal render target
 * required — keeps the G-buffer cost zero).
 *
 * Quality gating:
 *   - high/ultra: 32 samples, full radius
 *   - medium:     16 samples, half radius
 *   - low:        disabled
 *
 * Integrates with the existing EffectComposer via a ShaderPass. The host
 * PostProcessing.ts attaches a DepthTexture to renderTarget1 (already done
 * for the existing SSR pass — we reuse it).
 *
 * Pure-logic helpers (kernel + noise generation) are exported so unit tests
 * can verify them without spinning up WebGL.
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/** SSAO configuration — exposed for tests + per-tier defaults. */
export interface SSAOConfig {
  radius: number;       // world-space kernel radius (0.1..2.0)
  intensity: number;    // AO strength multiplier (0.5..4.0)
  bias: number;         // depth-comparison bias to avoid self-occlusion (0.001..0.1)
  samples: number;      // kernel size (8/16/32)
  maxDistance: number;  // view-space falloff distance (0.05..0.5)
}

/** Default per-quality-tier configs. */
export const SSAO_QUALITY_DEFAULTS: Record<"low" | "medium" | "high", SSAOConfig | null> = {
  low: null,
  medium: { radius: 0.3, intensity: 1.2, bias: 0.025, samples: 16, maxDistance: 0.15 },
  high: { radius: 0.5, intensity: 1.5, bias: 0.015, samples: 32, maxDistance: 0.25 },
};

/**
 * Generate a cosine-weighted hemisphere kernel of `n` samples in a unit
 * sphere. Uses the Fibonacci spiral for deterministic, well-distributed
 * samples (no RNG → reproducible across runs + GPU-friendly).
 *
 * Each sample is a vec4 where `.xyz` is the direction and `.w` is the
 * length (radius-falloff weight, biased toward 0 so distant samples
 * contribute less). Exported for unit tests.
 */
export function generateSSAOKernel(n: number): Float32Array {
  const out = new Float32Array(n * 4);
  const golden = 2.39996323;
  for (let i = 0; i < n; i++) {
    // Cosine-weighted hemisphere: more samples near the pole.
    const cosTheta = Math.sqrt(1 - (i + 0.5) / n);
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    const phi = i * golden;
    const x = sinTheta * Math.cos(phi);
    const y = sinTheta * Math.sin(phi);
    const z = cosTheta;
    // Length: scale from 0..1 with a quadratic falloff so closer samples
    // (more likely to find occluders in tight corners) dominate.
    const scale = (i / n);
    const len = 0.1 + 0.9 * scale * scale;
    out[i * 4] = x * len;
    out[i * 4 + 1] = y * len;
    out[i * 4 + 2] = z * len;
    out[i * 4 + 3] = len;
  }
  return out;
}

/**
 * Generate a 4×4 rotation-noise texture as raw RGBA bytes. Each texel is a
 * random rotation vector (cosθ, sinθ, 0, 0) used to rotate the kernel per
 * pixel — eliminates the banding that would otherwise come from a static
 * kernel. Returns a Float32Array (length 4*4*4 = 64) for direct upload to a
 * DataTexture. Exported for unit tests.
 */
export function generateSSAONoise(size = 4): Float32Array {
  const out = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const theta = Math.random() * Math.PI * 2;
    out[i * 4] = Math.cos(theta);
    out[i * 4 + 1] = Math.sin(theta);
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 0;
  }
  return out;
}

/** Build a DataTexture from the noise array (cached per-pass). */
function buildNoiseTexture(): THREE.DataTexture {
  const data = generateSSAONoise(4);
  const tex = new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat, THREE.FloatType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** SSAO shader — hemisphere kernel + depth-reconstructed normals. */
export const SSAOShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    tNoise: { value: null as THREE.Texture | null },
    /** E1-5000 #2312/#2313 — Kernel uniform array (replaces the 64-wide
     *  DataTexture, which was (a) slower — a dependent texture fetch per
     *  sample vs a uniform read, and (b) sized to 64 regardless of the
     *  actual sample count, wasting bandwidth). Sized to 64 (the max);
     *  the shader iterates only `uKernelSize` elements. */
    uKernelArray: { value: Array.from({ length: 64 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uKernelSize: { value: 32 },
    uProjection: { value: new THREE.Matrix4() },
    uInverseProjection: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uNoiseScale: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 0.5 },
    uIntensity: { value: 1.5 },
    uBias: { value: 0.015 },
    uMaxDistance: { value: 0.25 },
    /** #627 — Previous-frame AO result (RG: AO + validity). When present,
     *  the shader blends the current AO with the previous frame's AO using
     *  a velocity-weighted exponential moving average. This dramatically
     *  reduces per-frame flicker (the classic SSAO "noise crawl"). */
    tHistoryAO: { value: null as THREE.Texture | null },
    /** #627 — Per-pixel velocity (RG = screen-space motion, in pixels).
     *  Used to reproject the history AO sample + reject history on fast
     *  motion (otherwise the temporal filter would smear during camera
     *  cuts). */
    tVelocity: { value: null as THREE.Texture | null },
    /** #627 — Temporal blend factor (0..1; 0.85 = mostly history). */
    uTemporalBlend: { value: 0.85 },
    /** E1-5000 #2307 — Uniform bool flags that replace the invalid
     *  `sampler2D != null` GLSL comparisons (illegal in WebGL1, always
     *  true in WebGL2 — so the prior temporal-filter branch never fired
     *  correctly). The host sets these from JS. */
    uHasHistory: { value: 0 },
    uHasVelocity: { value: 0 },
    /** #628 — Edge-fade margin (pixels). Samples within this many pixels
     *  of the screen edge are attenuated (linear ramp to 0 at the edge)
     *  to avoid the screen-edge bleeding that comes from sampling outside
     *  the depth buffer's valid range. */
    uEdgeFade: { value: 8.0 },
    /** #628 — Projected-sample UV clamp: samples whose projected UV falls
     *  outside [uEdgeClampMin, 1-uEdgeClampMin] are discarded (they would
     *  sample the depth texture's repeat border + produce false AO). */
    uEdgeClampMin: { value: 0.003 },
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
    uniform sampler2D tNoise;
    // E1-5000 #2313 — uniform array kernel (faster than DataTexture fetch).
    uniform vec4 uKernelArray[64];
    uniform int uKernelSize;
    uniform mat4 uProjection;
    uniform mat4 uInverseProjection;
    uniform vec2 uResolution;
    uniform vec2 uNoiseScale;
    uniform float uRadius;
    uniform float uIntensity;
    uniform float uBias;
    uniform float uMaxDistance;
    uniform sampler2D tHistoryAO;
    uniform sampler2D tVelocity;
    uniform float uTemporalBlend;
    uniform int uHasHistory;
    uniform int uHasVelocity;
    uniform float uEdgeFade;
    uniform float uEdgeClampMin;
    varying vec2 vUv;

    vec3 reconstructViewPos(vec2 uv, float depth) {
      float z = depth * 2.0 - 1.0;
      vec4 clip = vec4(uv * 2.0 - 1.0, z, 1.0);
      vec4 view = uInverseProjection * clip;
      // E1-5000 #2305 — guard against divide-by-zero (w=0 happens for the
      // far plane / sky pixels, which would propagate NaN through the
      // rest of the SSAO math).
      return view.xyz / max(abs(view.w), 1e-6);
    }

    // #628 — Edge-fade factor: attenuate AO near screen borders so samples
    // that fall outside the depth buffer's valid range don't bleed
    // black/white AO streaks into the visible region.
    float edgeFade(vec2 uv) {
      vec2 d = min(uv, 1.0 - uv);
      float m = min(d.x, d.y);
      return smoothstep(0.0, uEdgeFade / max(uResolution.x, uResolution.y), m);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;
      // Sky — no AO.
      if (depth >= 0.9999) {
        gl_FragColor = col;
        return;
      }
      vec3 viewPos = reconstructViewPos(vUv, depth);
      // Reconstruct normal from depth derivatives (cheaper than a normal RT).
      vec3 dFdxView = dFdx(viewPos);
      vec3 dFdyView = dFdy(viewPos);
      // E1-5000 #2305 — Epsilon-guard the cross product before normalize.
      // On flat surfaces (constant depth) dFdx/dFdy are zero → cross is zero
      // → normalize produces NaN that propagates into the AO term + turns
      // the whole screen black. Fall back to the up vector when degenerate.
      vec3 crossN = cross(dFdxView, dFdyView);
      float crossLen = length(crossN);
      vec3 normal = crossLen > 1e-6 ? crossN / crossLen : vec3(0.0, 0.0, 1.0);
      if (normal.z < 0.0) normal = -normal;

      // Per-pixel rotation from the noise texture.
      vec3 rotSample = texture2D(tNoise, vUv * uNoiseScale).xyz;
      float rotAngle = atan(rotSample.y, rotSample.x);
      float c = cos(rotAngle);
      float s = sin(rotAngle);
      // E1-5000 #2311 — TBN basis: pick 'up' = (0,1,0) by default (matches
      // the hemisphere kernel's pole), falling back to (1,0,0) only when the
      // normal is nearly parallel to Y (the prior code used (0,0,1) which
      // was degenerate for the common ground-facing normal (0,0,1) — the
      // cross product was zero on flat ground, producing NaN tangents).
      vec3 up = abs(normal.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 tangent = normalize(cross(up, normal));
      vec3 bitangent = cross(normal, tangent);
      mat3 TBN = mat3(tangent, bitangent, normal);

      // Accumulate occlusion.
      float occlusion = 0.0;
      for (int i = 0; i < 64; i++) {
        if (i >= uKernelSize) break;
        // E1-5000 #2312/#2313 — Sample the kernel from a uniform array
        // (faster than the DataTexture fetch — one ALU vs a dependent
        // texture read — and sized exactly to uKernelSize so we don't
        // waste bandwidth on the 64-wide texture the prior code allocated).
        vec4 sampleK = uKernelArray[i];
        // Apply per-pixel rotation about the normal (2D rotation in the
        // tangent plane).
        vec3 rotated;
        rotated.x = c * sampleK.x - s * sampleK.y;
        rotated.y = s * sampleK.x + c * sampleK.y;
        rotated.z = sampleK.z;
        vec3 sampleDir = normalize(TBN * rotated) * sampleK.w;
        vec3 samplePos = viewPos + sampleDir * uRadius;
        // Project samplePos back to screen space.
        vec4 offset = uProjection * vec4(samplePos, 1.0);
        offset.xy /= offset.w;
        offset.xy = offset.xy * 0.5 + 0.5;
        // #628 — Skip samples whose projected UV falls outside the valid
        // depth-buffer range (these would sample the wrap border and
        // produce false AO at the screen edges).
        if (offset.x < uEdgeClampMin || offset.x > 1.0 - uEdgeClampMin ||
            offset.y < uEdgeClampMin || offset.y > 1.0 - uEdgeClampMin) {
          continue;
        }
        float sampleDepth = texture2D(tDepth, offset.xy).r;
        vec3 sampleViewPos = reconstructViewPos(offset.xy, sampleDepth);
        // E1-5000 #2310 — Epsilon-guard the rangeCheck denominator. The
        // prior uMaxDistance / abs(zDiff) divided by zero when the
        // sample landed on the same depth as the fragment (common on
        // flat surfaces), producing inf/NaN that corrupted the AO term.
        float zDiff = abs(viewPos.z - sampleViewPos.z);
        float rangeCheck = smoothstep(0.0, 1.0, uMaxDistance / max(zDiff, 1e-4));
        if (sampleViewPos.z >= samplePos.z + uBias) {
          occlusion += 1.0 * rangeCheck;
        }
      }
      occlusion = 1.0 - (occlusion / float(uKernelSize)) * uIntensity;
      occlusion = clamp(occlusion, 0.0, 1.0);
      // #628 — Apply the edge-fade so screen-edge samples don't bleed.
      occlusion = mix(1.0, occlusion, edgeFade(vUv));

      // #627 — Temporal filter: blend the current AO with the previous
      // frame's AO reprojected along the per-pixel velocity. Reduces
      // per-frame flicker + crawl. Disabled (no history texture) on the
      // first frame; falls back to a non-temporal result.
      // E1-5000 #2307 — Use uniform bool flags (the prior 'sampler != null'
      // tests were no-ops in WebGL2 + illegal in WebGL1, so the temporal
      // filter never actually ran).
      if (uHasHistory == 1 && uTemporalBlend > 0.001) {
        vec2 histUv = vUv;
        float velMag = 0.0;
        if (uHasVelocity == 1) {
          vec2 vel = texture2D(tVelocity, vUv).rg;
          velMag = length(vel);
          histUv = vUv - vel / uResolution;
        }
        float historyAO = 1.0;
        // Only sample the history if the reprojected UV is in-bounds.
        if (histUv.x >= 0.0 && histUv.x <= 1.0 && histUv.y >= 0.0 && histUv.y <= 1.0) {
          historyAO = texture2D(tHistoryAO, histUv).r;
        }
        // Reject history on fast motion (velMag in pixels) — keeps the
        // temporal filter from smearing during camera cuts.
        float reject = clamp(velMag / 16.0, 0.0, 1.0);
        float blend = mix(uTemporalBlend, 0.0, reject);
        occlusion = mix(occlusion, historyAO, blend);
      }

      // Modulate the diffuse color by the AO term.
      gl_FragColor = vec4(col.rgb * occlusion, col.a);
    }
  `,
};

/** SSAO post-process pass — wraps the shader + manages the kernel + noise textures. */
export class SSAOPass {
  readonly pass: ShaderPass;
  private enabled = true;
  private noiseTexture: THREE.DataTexture;
  /** E1-5000 #2312/#2313 — Kernel kept as a uniform vec4 array on the
   *  CPU side (uploaded to `uKernelArray`). No DataTexture needed. */
  private kernelArray: THREE.Vector4[];
  private config: SSAOConfig;
  /** #627 — ping-pong history RTs for the temporal filter. Null until
   *  setSize is called (the host allocates them at the right resolution). */
  private historyA: THREE.WebGLRenderTarget | null = null;
  private historyB: THREE.WebGLRenderTarget | null = null;
  private historyReadIndex: 0 | 1 = 0;

  constructor(config: SSAOConfig = SSAO_QUALITY_DEFAULTS.high ?? {
    radius: 0.5, intensity: 1.5, bias: 0.015, samples: 32, maxDistance: 0.25,
  }) {
    this.config = { ...config };
    this.pass = new ShaderPass(SSAOShader);
    // E1-5000 #2312/#2313 — Build the kernel as a uniform vec4 array
    // (sized to 64, the max — only the first `samples` entries are filled).
    // The prior code allocated a 64-wide DataTexture even for 16-sample
    // configs, wasting bandwidth + adding a dependent texture fetch per
    // sample. The uniform array is both smaller + faster.
    const kernelData = generateSSAOKernel(this.config.samples);
    this.kernelArray = Array.from({ length: 64 }, (_, i) => {
      const o = i * 4;
      return new THREE.Vector4(
        i < this.config.samples ? kernelData[o] : 0,
        i < this.config.samples ? kernelData[o + 1] : 0,
        i < this.config.samples ? kernelData[o + 2] : 0,
        i < this.config.samples ? kernelData[o + 3] : 0,
      );
    });
    this.noiseTexture = buildNoiseTexture();
    // Apply uniforms.
    const u = this.pass.material.uniforms;
    u.uKernelArray.value = this.kernelArray;
    u.uKernelSize.value = this.config.samples;
    u.tNoise.value = this.noiseTexture;
    u.uRadius.value = this.config.radius;
    u.uIntensity.value = this.config.intensity;
    u.uBias.value = this.config.bias;
    u.uMaxDistance.value = this.config.maxDistance;
  }

  /** Set the kernel radius (world-space units). */
  setRadius(r: number): void {
    this.config.radius = Math.max(0.01, r);
    (this.pass.material.uniforms.uRadius.value as number) = this.config.radius;
  }

  /** Set the AO intensity multiplier. */
  setIntensity(i: number): void {
    this.config.intensity = Math.max(0, i);
    (this.pass.material.uniforms.uIntensity.value as number) = this.config.intensity;
  }

  /** Set the depth-comparison bias (avoids self-occlusion acne). */
  setBias(b: number): void {
    this.config.bias = Math.max(0, b);
    (this.pass.material.uniforms.uBias.value as number) = this.config.bias;
  }

  /** Enable/disable the pass. */
  setEnabled(v: boolean): void {
    this.enabled = v;
    this.pass.enabled = v;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Set the depth texture (must be the same one RenderPass writes to). */
  setDepthTexture(tex: THREE.DepthTexture): void {
    (this.pass.material.uniforms.tDepth.value as THREE.DepthTexture | null) = tex;
  }

  /** Per-frame uniform refresh — push the camera projection matrices. */
  update(camera: THREE.Camera): void {
    if (!this.enabled) return;
    camera.updateMatrixWorld();
    const u = this.pass.material.uniforms;
    (u.uProjection.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (u.uInverseProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
  }

  /** Resize hook — updates resolution + noise scale. */
  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    // Noise tiles every 4 pixels (matches the 4×4 noise texture).
    (this.pass.material.uniforms.uNoiseScale.value as THREE.Vector2).set(w / 4, h / 4);
    // #627 — allocate (or resize) the temporal-filter history RTs.
    if (!this.historyA) {
      this.historyA = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.historyB = this.historyA.clone();
    } else {
      this.historyA.setSize(w, h);
      this.historyB?.setSize(w, h);
    }
  }

  /** #627 — Advance the temporal filter: swap history ping-pong RTs + bind
   *  the read history to the shader. Called by the host AFTER each SSAO
   *  render so the next frame reads from the freshly-written history. */
  advanceHistory(): void {
    this.historyReadIndex = this.historyReadIndex === 0 ? 1 : 0;
    const read = this.historyReadIndex === 0 ? this.historyA : this.historyB;
    (this.pass.material.uniforms.tHistoryAO.value as THREE.Texture | null) =
      read ? read.texture : null;
    // E1-5000 #2307 — flip the uniform bool flag so the GLSL temporal
    // branch actually fires (replaces the invalid `sampler != null` test).
    (this.pass.material.uniforms.uHasHistory.value as number) = read ? 1 : 0;
  }

  /** #627 — Get the history RT the host should render INTO this frame
   *  (i.e. the OPPOSITE of the read target). */
  getHistoryWriteTarget(): THREE.WebGLRenderTarget | null {
    return this.historyReadIndex === 0 ? this.historyB : this.historyA;
  }

  /** #627 — Attach a per-pixel velocity buffer for the temporal filter. */
  setVelocityTexture(tex: THREE.Texture | null): void {
    (this.pass.material.uniforms.tVelocity.value as THREE.Texture | null) = tex;
    // E1-5000 #2307 — flip the uniform bool flag (replaces invalid sampler test).
    (this.pass.material.uniforms.uHasVelocity.value as number) = tex ? 1 : 0;
  }

  /** #627 — Set the temporal blend factor (0 = no temporal, 1 = frozen). */
  setTemporalBlend(b: number): void {
    (this.pass.material.uniforms.uTemporalBlend.value as number) =
      THREE.MathUtils.clamp(b, 0, 1);
  }

  /** #628 — Set the edge-fade margin (in pixels). */
  setEdgeFade(px: number): void {
    (this.pass.material.uniforms.uEdgeFade.value as number) = Math.max(0, px);
  }

  /** #628 — Set the projected-sample UV clamp (samples outside
   *  [min, 1-min] are discarded). */
  setEdgeClampMin(min: number): void {
    (this.pass.material.uniforms.uEdgeClampMin.value as number) =
      THREE.MathUtils.clamp(min, 0, 0.1);
  }

  /** A3-5000 #483: enable/disable temporal filtering. The history RTs are
   *  allocated in setSize(); this flag controls whether the host composites
   *  the history texture. Default true. */
  private temporalEnabled = true;
  setTemporalEnabled(v: boolean): void { this.temporalEnabled = v; }
  isTemporalEnabled(): boolean { return this.temporalEnabled; }

  /** A3-5000 #484: enable half-res mode. The host renders the SSAO pass at
   *  half resolution when true. The history RTs are also half-res in that
   *  case (the host calls setSize(w/2, h/2)). Default false (full-res). */
  private halfRes = false;
  setHalfRes(v: boolean): void { this.halfRes = v; }
  isHalfRes(): boolean { return this.halfRes; }

  dispose(): void {
    this.pass.dispose();
    this.noiseTexture.dispose();
    this.historyA?.dispose();
    this.historyB?.dispose();
    this.historyA = null;
    this.historyB = null;
  }

  /** Read-only access to the current config (for tests + diagnostics). */
  getConfig(): Readonly<SSAOConfig> {
    return this.config;
  }
}
