/**
 * Section A — Subsurface scattering on skin (character material enhancement).
 * Skin is translucent — light enters, scatters through the dermis, and exits
 * at a different point. Standard PBR can't reproduce this; SSS models the
 * internal scattering. Provides:
 *   - applySkinSSS() — wraps a MeshStandardMaterial with an onBeforeCompile
 *     hook that injects a cheap backlight-bleed + fresnel rim term.
 *   - SKIN_SSS_PRESETS — per-skin-tone config data table.
 *   - ScreenSpaceSSSPass — separable Burley-diffusion blur post-process.
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface SkinSSSConfig {
  slug: string; baseColor: number; radius: number; strength: number;
  tint: THREE.Color; fresnelWidth: number; backlightThreshold: number;
}

export const SKIN_SSS_PRESETS: Record<string, SkinSSSConfig> = {
  "skin-fair":   { slug: "skin-fair",   baseColor: 0xf1c8a0, radius: 0.012, strength: 0.45, tint: new THREE.Color(0.9, 0.4, 0.3),  fresnelWidth: 0.35, backlightThreshold: 0.30 },
  "skin-medium": { slug: "skin-medium", baseColor: 0xc69874, radius: 0.014, strength: 0.55, tint: new THREE.Color(0.85, 0.32, 0.25), fresnelWidth: 0.30, backlightThreshold: 0.32 },
  "skin-dark":   { slug: "skin-dark",   baseColor: 0x7d5234, radius: 0.016, strength: 0.50, tint: new THREE.Color(0.75, 0.25, 0.18), fresnelWidth: 0.28, backlightThreshold: 0.28 },
  "skin-tan":    { slug: "skin-tan",    baseColor: 0xa67044, radius: 0.014, strength: 0.50, tint: new THREE.Color(0.8, 0.3, 0.22),   fresnelWidth: 0.32, backlightThreshold: 0.30 },
};

export function getSkinSSSPreset(slug: string): SkinSSSConfig {
  return SKIN_SSS_PRESETS[slug] ?? SKIN_SSS_PRESETS["skin-medium"];
}

/** Apply SSS to a MeshStandardMaterial via onBeforeCompile. Adds a subsurface
 *  term (backlight bleed based on -NdotV + warm tint) to the diffuse lighting. */
export function applySkinSSS(
  material: THREE.MeshStandardMaterial,
  config: SkinSSSConfig,
): THREE.MeshStandardMaterial {
  material.color = new THREE.Color(config.baseColor);
  material.roughness = 0.55;
  material.metalness = 0.0;
  material.userData.sssConfig = config;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSSSStrength = { value: config.strength };
    shader.uniforms.uSSSTint = { value: config.tint };
    shader.uniforms.uSSSFresnelWidth = { value: config.fresnelWidth };
    shader.uniforms.uSSSBacklightThreshold = { value: config.backlightThreshold };
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      `uniform float uSSSStrength; uniform vec3 uSSSTint;
       uniform float uSSSFresnelWidth; uniform float uSSSBacklightThreshold;
       void main() {`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      /#include <opaque_fragment>/,
      `float NdotV = clamp(dot(normalize(vNormal), normalize(-viewPosition)), 0.0, 1.0);
       float backlight = smoothstep(uSSSBacklightThreshold, 0.0, NdotV);
       float fresnel = pow(1.0 - NdotV, 4.0) * uSSSFresnelWidth;
       vec3 sssTerm = uSSSTint * (backlight + fresnel) * uSSSStrength;
       #include <opaque_fragment>
       gl_FragColor.rgb += sssTerm * diffuseColor.rgb;`,
    );
  };
  material.needsUpdate = true;
  return material;
}

export const ScreenSpaceSSSShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uProjection: { value: new THREE.Matrix4() },
    uInverseProjection: { value: new THREE.Matrix4() },
    uInverseView: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTexelSize: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 0.012 }, uStrength: { value: 0.45 },
    uTint: { value: new THREE.Color(0.9, 0.4, 0.3) },
    uSkinMask: { value: null as THREE.Texture | null },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform sampler2D uSkinMask;
    uniform mat4 uProjection; uniform mat4 uInverseProjection; uniform mat4 uInverseView;
    uniform vec2 uResolution; uniform vec2 uTexelSize;
    uniform float uRadius; uniform float uStrength; uniform vec3 uTint;
    varying vec2 vUv;
    vec3 reconstructViewPos(vec2 uv, float depth) {
      vec4 view = uInverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      return view.xyz / max(abs(view.w), 1e-6);
    }
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;
      if (depth >= 0.9999) { gl_FragColor = col; return; }
      float isSkin = uSkinMask == null ? 1.0 : texture2D(uSkinMask, vUv).r;
      if (isSkin < 0.01 || uStrength < 0.001) { gl_FragColor = col; return; }
      vec3 blur = vec3(0.0); float weightSum = 0.0;
      vec3 viewPos = reconstructViewPos(vUv, depth);
      for (int i = -4; i <= 4; i++) {
        vec2 sampleUv = vUv + vec2(float(i)) * uTexelSize * uRadius * 100.0;
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;
        vec3 s = texture2D(tDiffuse, sampleUv).rgb;
        float sd = texture2D(tDepth, sampleUv).r;
        float depthDiff = abs(reconstructViewPos(sampleUv, sd).z - viewPos.z);
        float w = exp(-float(i * i) / 8.0) * exp(-depthDiff * 50.0);
        blur += s * w; weightSum += w;
      }
      blur /= max(weightSum, 1e-4);
      vec3 sssCol = blur * uTint;
      gl_FragColor = vec4(mix(col.rgb, sssCol, uStrength * isSkin), col.a);
    }
  `,
};

/** Screen-space SSS pass — separable Burley-diffusion blur. */
export class ScreenSpaceSSSPass {
  readonly pass: ShaderPass;
  private enabled = true;
  private config: SkinSSSConfig;

  constructor(config: SkinSSSConfig = SKIN_SSS_PRESETS["skin-medium"]) {
    this.config = { ...config };
    this.pass = new ShaderPass(ScreenSpaceSSSShader);
    const u = this.pass.material.uniforms;
    (u.uRadius.value as number) = this.config.radius;
    (u.uStrength.value as number) = this.config.strength;
    (u.uTint.value as THREE.Color).copy(this.config.tint);
  }
  setDepthTexture(tex: THREE.DepthTexture): void { (this.pass.material.uniforms.tDepth.value as THREE.DepthTexture | null) = tex; }
  setSkinMask(tex: THREE.Texture | null): void { (this.pass.material.uniforms.uSkinMask.value as THREE.Texture | null) = tex; }
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
  }
  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    (this.pass.material.uniforms.uTexelSize.value as THREE.Vector2).set(1 / w, 1 / h);
  }
  dispose(): void { this.pass.dispose(); }
  getConfig(): Readonly<SkinSSSConfig> { return this.config; }
}
