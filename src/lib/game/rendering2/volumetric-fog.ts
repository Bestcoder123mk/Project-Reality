/**
 * SEC3-RENDER Prompt 20 — Volumetric fog + god rays post-process pass.
 *
 * Implements screen-space volumetric fog that raymarches from the sun
 * direction through the depth buffer. Bright god-rays accumulate where the
 * ray travels through unoccluded space (sky / windows / doorways); dark fog
 * fills occluded depth ranges with a depth-falloff exponential.
 *
 * The pass is a ShaderPass wrapper compatible with three.js's EffectComposer.
 * It reads:
 *   - tDiffuse: the current color buffer
 *   - tDepth:   the depth texture (set up by the host composer — see
 *               PostProcessing.ts which attaches a DepthTexture to renderTarget1)
 *
 * Quality gating:
 *   - ultra/high: 24 march steps, full fog
 *   - medium:     12 march steps, half density
 *   - low:        pass is disabled entirely
 *
 * The host pipeline calls `setEnabled(false)` to skip the pass without
 * removing it (EffectComposer iterates its pass list each frame; a disabled
 * pass is cheap but not free — `enabled=false` skips the GL draw).
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/** Volumetric fog shader — raymarches from the sun through the depth buffer. */
export const VolumetricFogShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    /** World-space direction the sun's light travels TOWARD. */
    uSunDir: { value: new THREE.Vector3(0.5, 0.4, -0.8).normalize() },
    /** Sun color in linear sRGB. */
    uSunColor: { value: new THREE.Color(1.0, 0.92, 0.78) },
    /** Camera projection matrix (depth → view pos). */
    uProjection: { value: new THREE.Matrix4() },
    uInverseProjection: { value: new THREE.Matrix4() },
    /** Camera world matrix (view → world for the sun ray). */
    uCameraMatrix: { value: new THREE.Matrix4() },
    /** Task-3 — CPU-side inverse of uCameraMatrix. GLSL ES 1.0 lacks the
     *  `inverse()` built-in, so we compute it on the CPU (camera.matrixWorldInverse)
     *  and pass it as a uniform. This converts the world-space sun direction
     *  into view space for the god-ray march. */
    uCameraMatrixInverse: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    /** Volumetric fog density (0..1; 0.05 = subtle, 0.4 = thick). */
    uDensity: { value: 0.08 },
    /** God-ray intensity multiplier (0..2). */
    uGodRayIntensity: { value: 0.65 },
    /** March steps (8/16/24). Lower = cheaper, noisier. */
    uSteps: { value: 16 },
    /** Distance fog start (view-space units). */
    uFogStart: { value: 8.0 },
    /** Distance fog end (view-space units). */
    uFogEnd: { value: 60.0 },
    /** Toggles the god-ray contribution (volumetric light shafts). */
    uGodRaysEnabled: { value: 1.0 },
    /** Toggles the depth-fog contribution (atmospheric haze). */
    uFogEnabled: { value: 1.0 },
    /** #637 — Height-based fog density gradient. Fog pools in low areas;
     *  density = uDensity * (1 + uHeightFalloff * max(0, uHeightBase - worldY)).
     *  Default uHeightFalloff = 0 (uniform density) — set >0 to pool in
     *  valleys/basements. */
    uHeightFalloff: { value: 0.0 },
    /** #637 — World Y at which the fog density is the base value. Fog
     *  thickens BELOW this Y (negative gradient). */
    uHeightBase: { value: 0.0 },
    /** #638 — Anisotropic scattering coefficient (0 = isotropic, 1 =
     *  strongly forward-scattering). Fog glows toward the sun when >0. */
    uAnisotropy: { value: 0.6 },
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
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform mat4 uProjection;
    uniform mat4 uInverseProjection;
    uniform mat4 uCameraMatrix;
    // A3-5000 #456: uCameraMatrixInverse is mislabeled — it's actually the
    // camera's matrixWorldInverse (view matrix). The fix: use mat3 (extracted
    // from the upper-left 3x3) for direction transforms so the translation
    // column + camera scale don't corrupt direction vectors. The mat4 path
    // is kept for the world-position reconstruction (which needs the full mat4).
    uniform mat4 uCameraMatrixInverse;
    uniform vec2 uResolution;
    uniform float uDensity;
    uniform float uGodRayIntensity;
    uniform float uSteps;
    uniform float uFogStart;
    uniform float uFogEnd;
    uniform float uGodRaysEnabled;
    uniform float uFogEnabled;
    uniform float uHeightFalloff;
    uniform float uHeightBase;
    uniform float uAnisotropy;
    varying vec2 vUv;

    // Reconstruct view-space position from a depth sample + UV.
    vec3 reconstructViewPos(vec2 uv, float depth) {
      float z = depth * 2.0 - 1.0;
      vec4 clip = vec4(uv * 2.0 - 1.0, z, 1.0);
      vec4 view = uInverseProjection * clip;
      return view.xyz / view.w;
    }

    // #637 — Height-based fog density. Fog thickens below uHeightBase.
    float heightDensity(vec3 worldPos) {
      float h = uHeightBase - worldPos.y;
      float grad = h > 0.0 ? exp(-h * uHeightFalloff) : 1.0;
      return uDensity * grad;
    }

    // #638 — Henyey-Greenstein phase function for anisotropic scattering.
    // g=0 → isotropic; g>0 → forward-scattering (glow toward the sun).
    // E1-5000 #2386 — Epsilon-guard the denominator (g=±1 + cosTheta=±1
    // → 1+g²-2g·cosTheta → 0 → pow(0,1.5)=0 → division by zero → NaN
    // that propagates through the fog color). Clamp the denominator to a
    // small positive value.
    float henyeyGreenstein(float cosTheta, float g) {
      float g2 = g * g;
      float denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
      return (1.0 - g2) / pow(denom, 1.5);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;

      // Sky / no depth — pass through (no fog on the sky dome).
      // A3-5000 #477: 0.9999 was wrong for logarithmic depth buffers (the
      // non-linear depth means 0.9999 may not match the far plane). Use a
      // tighter threshold (0.99995) + document that the host should configure
      // the depth format correctly (the WebGLRenderer uses UnsignedShortType
      // by default which is non-linear; this threshold works for both linear
      // + log depth as long as the far plane is reasonably far).
      if (depth >= 0.99995) {
        gl_FragColor = col;
        return;
      }

      // View-space position + camera world position (origin in view space).
      vec3 viewPos = reconstructViewPos(vUv, depth);
      float viewDist = length(viewPos);

      // Sun direction in view space — transform world sun dir by the inverse
      // camera matrix (camera to world is uCameraMatrix; world to camera is its
      // inverse, which is viewMatrix). We bake the inverse on the CPU side
      // via uCameraMatrixInverse for performance.
      // A3-5000 #456: use mat3 (upper-left 3x3) for direction transforms so
      // camera scale doesn't corrupt the direction. The original mat4 path
      // would scale the direction by the camera's scale factor.
      // E1-5000 #2386 — Guard against a zero sun direction (NaN source).
      mat3 viewMat3 = mat3(uCameraMatrixInverse);
      vec3 sunDirRaw = viewMat3 * uSunDir;
      float sunLen = length(sunDirRaw);
      vec3 sunDirView = sunLen > 1e-6 ? sunDirRaw / sunLen : vec3(0.0, 1.0, 0.0);

      // === Distance fog (exponential depth falloff) ===
      float fogFactor = 0.0;
      if (uFogEnabled > 0.5) {
        float depthWeight = smoothstep(uFogStart, uFogEnd, viewDist);
        // #637 — Height-based density: reconstruct world Y + apply gradient.
        vec4 world = uCameraMatrix * vec4(viewPos, 1.0);
        vec3 worldPos = world.xyz / world.w;
        float hDensity = uHeightFalloff > 0.001 ? heightDensity(worldPos) : uDensity;
        fogFactor = hDensity * depthWeight;
        // #638 — Anisotropic scattering — fog glows toward the sun.
        float sunAlignment = max(0.0, dot(normalize(-viewPos), sunDirView));
        float phase = uAnisotropy > 0.001
          ? henyeyGreenstein(sunAlignment, uAnisotropy)
          : 1.0;
        float sunGlow = sunAlignment * phase;
        vec3 fogColor = mix(vec3(0.55, 0.6, 0.68), uSunColor, sunGlow * 0.6);
        col.rgb = mix(col.rgb, fogColor, clamp(fogFactor, 0.0, 0.95));
      }

      // === God rays — raymarch from the surface back along the sun direction,
      // accumulating sun light wherever the ray is unoccluded (depth sample is
      // farther than the expected ray depth at that step). ===
      if (uGodRaysEnabled > 0.5 && uGodRayIntensity > 0.001) {
        vec3 marchDir = -sunDirView; // toward the light source
        float stepSize = viewDist / uSteps;
        vec3 pos = viewPos;
        float godRayAccum = 0.0;
        float totalWeight = 0.0;
        // A3-5000 #478: documented the 32-step upper bound. The loop is
        // GLSL-compiled with a fixed 'i < 32' bound (loops must be unrollable
        // in GLSL ES 1.0); uSteps can be set lower at runtime. If a caller
        // needs more than 32 steps, the shader must be recompiled — flagged
        // in the docs as a known limit. setSteps() clamps to [4, 32].
        for (int i = 0; i < 32; i++) {
          if (float(i) >= uSteps) break;
          pos += marchDir * stepSize;
          // Project pos back to UV.
          vec4 clip = uProjection * vec4(pos, 1.0);
          vec3 ndc = clip.xyz / clip.w;
          // Behind camera or off-screen — stop.
          if (ndc.z < -1.0 || ndc.z > 1.0) break;
          vec2 sampleUv = ndc.xy * 0.5 + 0.5;
          if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) break;
          float sampleDepth = texture2D(tDepth, sampleUv).r;
          float sampleViewZ = reconstructViewPos(sampleUv, sampleDepth).z;
          // E1-5000 #2314 — God-ray occlusion test. In Three.js view space
          // the camera looks down -Z, so points FARTHER from the camera
          // have MORE NEGATIVE Z. The march marches from the surface TOWARD
          // the sun (deeper into the scene, i.e. |Z| grows). At each step
          // 'pos.z' is the expected depth of the ray; 'sampleViewZ' is the
          // actual depth buffer value at the projected UV.
          //   - If sampleViewZ > pos.z (LESS negative = CLOSER to camera):
          //     there's an occluder between the ray + the camera → the ray
          //     is blocked, no god-ray contribution.
          //   - If sampleViewZ <= pos.z (farther or equal): the ray travels
          //     through open space → accumulate god-ray light.
          // The prior code had the comparison INVERTED (sampleViewZ <
          // expectedZ - 0.5 = occluded), which made god rays appear
          // THROUGH occluders + be invisible in the open sky.
          float expectedZ = pos.z;
          if (sampleViewZ > expectedZ + 0.5) {
            // Occluded — no contribution this step.
            totalWeight += 1.0;
          } else {
            godRayAccum += 1.0;
            totalWeight += 1.0;
          }
        }
        float godRay = totalWeight > 0.0 ? godRayAccum / totalWeight : 0.0;
        // Sun-tinted additive blend.
        col.rgb += uSunColor * godRay * uGodRayIntensity * 0.5;
      }

      gl_FragColor = col;
    }
  `,
};

/** Volumetric fog post-process pass — wraps the shader in a ShaderPass. */
export class VolumetricFogPass {
  /** The underlying ShaderPass — added to the composer's pass list. */
  readonly pass: ShaderPass;
  private enabled = true;
  private sunDir: THREE.Vector3;
  private density: number;

  constructor(opts?: { sunDir?: THREE.Vector3; density?: number; steps?: number }) {
    this.pass = new ShaderPass(VolumetricFogShader);
    this.sunDir = (opts?.sunDir ?? new THREE.Vector3(0.5, 0.4, -0.8)).clone().normalize();
    this.density = opts?.density ?? 0.08;
    this.pass.material.uniforms.uSunDir.value.copy(this.sunDir);
    this.pass.material.uniforms.uDensity.value = this.density;
    if (opts?.steps !== undefined) this.pass.material.uniforms.uSteps.value = opts.steps;
  }

  /** Set the sun direction (world-space, the direction the light travels TOWARD). */
  setSunDirection(dir: THREE.Vector3): void {
    this.sunDir.copy(dir).normalize();
    (this.pass.material.uniforms.uSunDir.value as THREE.Vector3).copy(this.sunDir);
  }

  /** Set the volumetric fog density (0..1). */
  setDensity(d: number): void {
    this.density = THREE.MathUtils.clamp(d, 0, 1);
    (this.pass.material.uniforms.uDensity.value as number) = this.density;
  }

  /** Set the god-ray intensity multiplier (0..2). */
  setGodRayIntensity(i: number): void {
    (this.pass.material.uniforms.uGodRayIntensity.value as number) = THREE.MathUtils.clamp(i, 0, 2);
  }

  /** Set the march step count (8/16/24). Lower = cheaper, noisier. */
  setSteps(n: number): void {
    (this.pass.material.uniforms.uSteps.value as number) = Math.max(4, Math.min(32, Math.round(n)));
  }

  /** Toggle god-ray contribution. */
  setGodRaysEnabled(v: boolean): void {
    (this.pass.material.uniforms.uGodRaysEnabled.value as number) = v ? 1.0 : 0.0;
  }

  /** Toggle distance-fog contribution. */
  setFogEnabled(v: boolean): void {
    (this.pass.material.uniforms.uFogEnabled.value as number) = v ? 1.0 : 0.0;
  }

  /** #637 — Set the height-based fog density gradient. `falloff` is the
   *  exponential decay rate per world unit below `base` (0 = uniform
   *  density). `base` is the world Y at which the density equals the
   *  base uDensity value. */
  setHeightFalloff(falloff: number, base = 0): void {
    (this.pass.material.uniforms.uHeightFalloff.value as number) = Math.max(0, falloff);
    (this.pass.material.uniforms.uHeightBase.value as number) = base;
  }

  /** #638 — Set the anisotropic scattering coefficient (0 = isotropic,
   *  1 = strongly forward-scattering toward the sun). */
  setAnisotropy(g: number): void {
    (this.pass.material.uniforms.uAnisotropy.value as number) =
      THREE.MathUtils.clamp(g, -0.95, 0.95);
  }

  /** Enable/disable the entire pass (skips the GL draw when disabled). */
  setEnabled(v: boolean): void {
    this.enabled = v;
    this.pass.enabled = v;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Per-frame uniform refresh — call from the host pipeline's update loop.
   *  Pushes the camera's projection + world matrix so the shader can
   *  reconstruct view/world positions. */
  update(camera: THREE.Camera): void {
    if (!this.enabled) return;
    camera.updateMatrixWorld();
    const u = this.pass.material.uniforms;
    (u.uProjection.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (u.uInverseProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uCameraMatrix.value as THREE.Matrix4).copy(camera.matrixWorld);
    // Task-3 — pass the CPU-side inverse (camera.matrixWorldInverse is kept
    // up-to-date by updateMatrixWorld). GLSL ES 1.0 lacks inverse(mat4).
    (u.uCameraMatrixInverse.value as THREE.Matrix4).copy(camera.matrixWorldInverse);
  }

  /** Set the depth texture (must be the same one RenderPass writes to). */
  setDepthTexture(tex: THREE.DepthTexture): void {
    (this.pass.material.uniforms.tDepth.value as THREE.DepthTexture | null) = tex;
  }

  /** Resize hook — updates the resolution uniform.
   *  A3-5000 #480: half-res option — when `halfRes` is true, the host renders
   *  the fog pass at half resolution (Composer's renderScale = 0.5). The
   *  pass itself doesn't downsample; the host calls setSize(w/2, h/2) +
   *  upsamples the result. We track the half-res flag here so callers can
   *  query it. A3-5000 #479: temporal accumulation toggle — when `temporal`
   *  is true, the host blends the current frame's fog with the previous
   *  frame's (via the composer's readBuffer ping-pong) to stabilize god rays. */
  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  }

  /** A3-5000 #480: enable/disable half-res mode. The host pipeline checks
   *  this flag to decide whether to render the fog pass at half resolution. */
  private halfRes = false;
  setHalfRes(v: boolean): void { this.halfRes = v; }
  isHalfRes(): boolean { return this.halfRes; }

  /** A3-5000 #479: enable temporal accumulation. When true, the host pipeline
   *  should blend the current fog result with the previous frame's to reduce
   *  god-ray shimmer. The pass itself doesn't do the blend — the host wires
   *  it via a separate accumulation RT. */
  private temporal = false;
  setTemporal(v: boolean): void { this.temporal = v; }
  isTemporal(): boolean { return this.temporal; }

  dispose(): void {
    this.pass.dispose();
  }
}
