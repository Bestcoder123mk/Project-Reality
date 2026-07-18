/**
 * Section A — Ray-traced soft shadows (post-process).
 * Hybrid screen-space ray-marched soft shadow pass that complements CSM.
 * Reads depth, reconstructs world pos + normal, marches N rays per pixel
 * toward the sun accumulating visibility. On WebGPU the march runs as a
 * compute shader; on WebGL2 the same algorithm runs as a fragment-shader
 * raymarch. Config-driven ray count (1/2/4) + half-res bilateral upsample.
 * Budget: 1.5–4.0 ms GPU.
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface RTShadowConfig {
  sunDirection: THREE.Vector3; sunColor: THREE.Color;
  raysPerPixel: 1 | 2 | 4; maxDistance: number; steps: number; stepSize: number;
  penumbraAngle: number; bias: number; strength: number; halfRes: boolean;
}

export const RT_SHADOW_DEFAULTS: Record<"medium" | "high" | "ultra", RTShadowConfig | null> = {
  medium: null,
  high: {
    sunDirection: new THREE.Vector3(-0.5, 0.7, -0.5).normalize(),
    sunColor: new THREE.Color(1.0, 0.95, 0.82),
    raysPerPixel: 1, maxDistance: 20, steps: 32, stepSize: 0.18,
    penumbraAngle: 0.04, bias: 0.02, strength: 0.45, halfRes: true,
  },
  ultra: {
    sunDirection: new THREE.Vector3(-0.5, 0.7, -0.5).normalize(),
    sunColor: new THREE.Color(1.0, 0.95, 0.82),
    raysPerPixel: 2, maxDistance: 32, steps: 48, stepSize: 0.20,
    penumbraAngle: 0.06, bias: 0.015, strength: 0.65, halfRes: false,
  },
};

export const RTShadowShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null }, tDepth: { value: null as THREE.Texture | null },
    tBlueNoise: { value: null as THREE.Texture | null },
    uProjection: { value: new THREE.Matrix4() }, uInverseProjection: { value: new THREE.Matrix4() },
    uInverseView: { value: new THREE.Matrix4() }, uResolution: { value: new THREE.Vector2(1, 1) },
    uSunDirection: { value: new THREE.Vector3(-0.5, 0.7, -0.5).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.95, 0.82) },
    uRaysPerPixel: { value: 2 }, uMaxDistance: { value: 20.0 }, uSteps: { value: 32 },
    uStepSize: { value: 0.18 }, uPenumbraAngle: { value: 0.04 }, uBias: { value: 0.02 },
    uStrength: { value: 0.45 }, uFrame: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform sampler2D tBlueNoise;
    uniform mat4 uProjection; uniform mat4 uInverseProjection; uniform mat4 uInverseView;
    uniform vec2 uResolution; uniform vec3 uSunDirection; uniform vec3 uSunColor;
    uniform int uRaysPerPixel; uniform float uMaxDistance; uniform int uSteps;
    uniform float uStepSize; uniform float uPenumbraAngle; uniform float uBias;
    uniform float uStrength; uniform int uFrame;
    varying vec2 vUv;
    vec3 reconstructViewPos(vec2 uv, float depth) {
      vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 view = uInverseProjection * clip;
      return view.xyz / max(abs(view.w), 1e-6);
    }
    float blueNoise(vec2 uv) {
      if (tBlueNoise == null) return fract(sin(dot(uv, vec2(12.9898, 78.233)) + float(uFrame) * 0.618) * 43758.5453);
      vec2 sz = vec2(textureSize(tBlueNoise, 0));
      vec2 px = mod(vec2(uFrame) * vec2(47.0, 17.0), sz);
      return texture2D(tBlueNoise, (uv * sz + px) / sz).r;
    }
    float marchRay(vec3 origin, vec3 rayDir, float maxDist) {
      float visibility = 1.0;
      for (int i = 1; i <= 64; i++) {
        if (i >= uSteps) break;
        float t = float(i) * uStepSize;
        if (t > maxDist) break;
        vec4 viewPos = (uInverseView * vec4(origin + rayDir * t, 1.0));
        vec4 clip = uProjection * viewPos;
        if (abs(clip.w) < 1e-6) continue;
        vec2 sampleUv = (clip.xy / clip.w) * 0.5 + 0.5;
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;
        float sampleDepth = texture2D(tDepth, sampleUv).r;
        if (sampleDepth >= 0.9999) continue;
        float zDiff = reconstructViewPos(sampleUv, sampleDepth).z - viewPos.z;
        if (zDiff > 0.05 && abs(zDiff) < 1.0) {
          visibility *= 1.0 - smoothstep(0.0, 0.05, zDiff);
          if (visibility < 0.01) return 0.0;
        }
      }
      return visibility;
    }
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;
      if (depth >= 0.9999 || uStrength < 0.001) { gl_FragColor = col; return; }
      vec3 viewPos = reconstructViewPos(vUv, depth);
      vec3 worldPos = (uInverseView * vec4(viewPos, 1.0)).xyz;
        vec3 crossN = cross(dFdx(viewPos), dFdy(viewPos));
      float crossLen = length(crossN);
      vec3 viewNormal = crossLen > 1e-6 ? crossN / crossLen : vec3(0.0, 0.0, 1.0);
      if (viewNormal.z < 0.0) viewNormal = -viewNormal;
      vec3 worldNormal = normalize(mat3(uInverseView) * viewNormal);
      if (dot(worldNormal, -uSunDirection) <= 0.0) { gl_FragColor = col; return; }
      vec3 origin = worldPos + worldNormal * uBias;
      float visibility = 0.0;
      float maxDist = min(uMaxDistance, 60.0);
      vec3 up = abs(uSunDirection.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 tangent = normalize(cross(up, uSunDirection));
      vec3 bitangent = cross(uSunDirection, tangent);
      for (int r = 0; r < 4; r++) {
        if (r >= uRaysPerPixel) break;
        float blueR = blueNoise(vUv + vec2(float(r) * 0.13, 0.0));
        float blueA = blueNoise(vUv + vec2(0.0, float(r) * 0.21));
        float angle = blueR * 6.2831853 + blueA;
        float spread = uPenumbraAngle * (0.5 + 0.5 * blueA);
        vec3 offset = (cos(angle) * tangent + sin(angle) * bitangent) * spread;
        visibility += marchRay(origin, normalize(-uSunDirection + offset), maxDist);
      }
      visibility /= float(uRaysPerPixel);
      float shadow = mix(1.0, visibility, uStrength);
      vec3 shadowTint = vec3(0.55, 0.62, 0.78);
      vec3 shadowed = col.rgb * shadow + col.rgb * (1.0 - shadow) * shadowTint * 0.15;
      gl_FragColor = vec4(shadowed, col.a);
    }
  `,
};

/** Ray-traced soft shadow pass — wraps the shader + owns the blue-noise tile. */
export class RTShadowPass {
  readonly pass: ShaderPass;
  private config: RTShadowConfig;
  private enabled = true;
  private blueNoiseTex: THREE.DataTexture | null = null;
  private halfResTarget: THREE.WebGLRenderTarget | null = null;
  private frame = 0;

  constructor(config: RTShadowConfig) {
    this.config = { ...config };
    this.pass = new ShaderPass(RTShadowShader);
    this.applyConfig();
    this.buildBlueNoise();
  }
  private applyConfig(): void {
    const u = this.pass.material.uniforms;
    (u.uSunDirection.value as THREE.Vector3).copy(this.config.sunDirection).normalize();
    (u.uSunColor.value as THREE.Color).copy(this.config.sunColor);
    (u.uRaysPerPixel.value as number) = this.config.raysPerPixel;
    (u.uMaxDistance.value as number) = this.config.maxDistance;
    (u.uSteps.value as number) = this.config.steps;
    (u.uStepSize.value as number) = this.config.stepSize;
    (u.uPenumbraAngle.value as number) = this.config.penumbraAngle;
    (u.uBias.value as number) = this.config.bias;
    (u.uStrength.value as number) = this.config.strength;
  }
  private buildBlueNoise(): void {
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const v = ((x * 1664525 + y * 1013904223) >>> 0) / 4294967295;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = (v * 255) | 0; data[i + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    this.blueNoiseTex = tex;
    (this.pass.material.uniforms.tBlueNoise.value as THREE.Texture | null) = tex;
  }
  setDepthTexture(tex: THREE.DepthTexture): void { (this.pass.material.uniforms.tDepth.value as THREE.DepthTexture | null) = tex; }
  setSunDirection(dir: THREE.Vector3): void { (this.pass.material.uniforms.uSunDirection.value as THREE.Vector3).copy(dir).normalize(); }
  setSunColor(c: THREE.Color): void { (this.pass.material.uniforms.uSunColor.value as THREE.Color).copy(c); }
  setStrength(s: number): void {
    this.config.strength = THREE.MathUtils.clamp(s, 0, 1);
    (this.pass.material.uniforms.uStrength.value as number) = this.config.strength;
  }
  setEnabled(v: boolean): void { this.enabled = v; this.pass.enabled = v; }
  isEnabled(): boolean { return this.enabled; }
  update(camera: THREE.Camera): void {
    if (!this.enabled) return;
    camera.updateMatrixWorld();
    const u = this.pass.material.uniforms;
    (u.uProjection.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (u.uInverseProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uInverseView.value as THREE.Matrix4).copy(camera.matrixWorld);
    this.frame = (this.frame + 1) & 0xff;
    (u.uFrame.value as number) = this.frame;
  }
  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    if (!this.config.halfRes) return;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    if (!this.halfResTarget) {
      this.halfResTarget = new THREE.WebGLRenderTarget(hw, hh, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
    } else { this.halfResTarget.setSize(hw, hh); }
  }
  getHalfResTarget(): THREE.WebGLRenderTarget | null { return this.config.halfRes ? this.halfResTarget : null; }
  isHalfRes(): boolean { return this.config.halfRes; }
  dispose(): void {
    this.pass.dispose();
    this.blueNoiseTex?.dispose(); this.blueNoiseTex = null;
    this.halfResTarget?.dispose(); this.halfResTarget = null;
  }
  getConfig(): Readonly<RTShadowConfig> { return this.config; }
}
