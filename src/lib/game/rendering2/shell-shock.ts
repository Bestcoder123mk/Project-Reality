/**
 * Section A — Shell-shock desaturation curve (combat feedback).
 *
 * When a player takes damage or experiences a near-miss (suppression), the
 * brain's fight-or-flight response constricts peripheral vision + drains
 * color perception. Realistic shell-shock visual feedback:
 *
 *   - Progressive desaturation (color drains to grayscale).
 *   - Red-tinted shadows (blood-pressure visual).
 *   - Vignette tightening (tunnel vision).
 *   - Subtle chromatic aberration (neural overload).
 *
 * This module provides a config-driven data table + a post-process pass that
 * applies all four effects together, driven by a single "shock" value (0..1).
 * The host (MedicalSystem / SuppressionSystem) calls setShockLevel() per
 * frame; the pass applies the curve to the rendered scene.
 *
 * Integration: PostProcessing.ts inserts this pass AFTER the grade pass +
 * BEFORE FXAA (so FXAA still smooths the desaturated edges). The pass is
 * always constructed but has no effect at shockLevel=0.
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface ShellShockConfig {
  /** Maximum desaturation (0..1). 1 = full grayscale at max shock. */
  maxDesaturation: number;
  /** Maximum red tint (0..1). */
  maxRedTint: number;
  /** Maximum vignette tightening (0..1). */
  maxVignette: number;
  /** Maximum chromatic aberration (texels). */
  maxChromaticAberration: number;
  /** Recovery time constant (seconds). The pass lerps the actual shock level
   *  toward the target at this rate. */
  recoveryTau: number;
  /** Damage threshold — shock level only rises above this when the player
   *  takes damage (per-frame target shock). */
  damageThreshold: number;
  /** Curve exponent — controls the non-linearity of the desaturation curve.
   *  Higher = sharper onset (more realistic shell-shock). */
  curveExponent: number;
}

export const SHELL_SHOCK_DEFAULTS: ShellShockConfig = {
  maxDesaturation: 0.85,
  maxRedTint: 0.25,
  maxVignette: 0.5,
  maxChromaticAberration: 0.004,
  recoveryTau: 1.5,
  damageThreshold: 0.15,
  curveExponent: 1.8,
};

export const ShellShockShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTexelSize: { value: new THREE.Vector2(1, 1) },
    uShock: { value: 0 }, // 0..1 — current shock level
    uMaxDesaturation: { value: 0.85 },
    uMaxRedTint: { value: 0.25 },
    uMaxVignette: { value: 0.5 },
    uMaxChromaticAberration: { value: 0.004 },
    uCurveExponent: { value: 1.8 },
    uTime: { value: 0 },
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
    uniform vec2 uResolution;
    uniform vec2 uTexelSize;
    uniform float uShock;
    uniform float uMaxDesaturation;
    uniform float uMaxRedTint;
    uniform float uMaxVignette;
    uniform float uMaxChromaticAberration;
    uniform float uCurveExponent;
    uniform float uTime;
    varying vec2 vUv;

    // Apply the shell-shock curve — non-linear (curveExponent) so the first
    // 30 % of shock level produces 70 % of the visible effect.
    float curve(float t) {
      return pow(clamp(t, 0.0, 1.0), uCurveExponent);
    }

    void main() {
      if (uShock < 0.001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      float shock = curve(uShock);
      // Chromatic aberration — sample 3 channels at slightly offset UVs.
      float caAmount = uMaxChromaticAberration * shock;
      vec3 col;
      if (caAmount > 0.0001) {
        vec2 dir = vUv - 0.5;
        col.r = texture2D(tDiffuse, vUv + dir * caAmount).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - dir * caAmount).b;
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }
      // Desaturation — lerp toward luminance.
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float desat = uMaxDesaturation * shock;
      col = mix(col, vec3(lum), desat);
      // Red tint in the shadows — blood-pressure visual.
      float shadowMask = 1.0 - smoothstep(0.0, 0.4, lum);
      vec3 redTint = vec3(0.6, 0.05, 0.05);
      col = mix(col, col * redTint + col * 0.3, uMaxRedTint * shock * shadowMask);
      // Vignette tightening — tunnel vision.
      float vig = 1.0 - smoothstep(0.3, 0.7, length(vUv - 0.5));
      col *= mix(1.0, vig, uMaxVignette * shock);
      // Subtle frame jitter (camera shake feel) — sample the time-modulated
      // noise to add 1-2 pixels of jitter.
      float jitter = sin(uTime * 60.0 + vUv.y * 100.0) * shock * 0.001;
      col += jitter;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/** Shell-shock post-process pass. */
export class ShellShockPass {
  readonly pass: ShaderPass;
  private config: ShellShockConfig;
  private enabled = true;
  private targetShock = 0;
  private currentShock = 0;
  private elapsed = 0;

  constructor(config: ShellShockConfig = { ...SHELL_SHOCK_DEFAULTS }) {
    this.config = { ...config };
    this.pass = new ShaderPass(ShellShockShader);
    this.applyConfig();
  }

  private applyConfig(): void {
    const u = this.pass.material.uniforms;
    (u.uMaxDesaturation.value as number) = this.config.maxDesaturation;
    (u.uMaxRedTint.value as number) = this.config.maxRedTint;
    (u.uMaxVignette.value as number) = this.config.maxVignette;
    (u.uMaxChromaticAberration.value as number) = this.config.maxChromaticAberration;
    (u.uCurveExponent.value as number) = this.config.curveExponent;
  }

  /** Set the target shock level (0..1). The pass smoothly lerps the actual
   *  shock level toward this target (configurable via recoveryTau). */
  setShockLevel(level: number): void {
    this.targetShock = THREE.MathUtils.clamp(level, 0, 1);
  }

  /** Trigger an instant shock spike (e.g. on damage taken) — sets both the
   *  target AND the current shock level so the effect is immediate. */
  triggerSpike(level: number): void {
    const l = THREE.MathUtils.clamp(level, 0, 1);
    this.targetShock = l;
    this.currentShock = Math.max(this.currentShock, l);
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.pass.enabled = v;
  }
  isEnabled(): boolean { return this.enabled; }

  /** Per-frame update — advances the shock-level lerp + the time uniform. */
  update(dt: number): void {
    if (!this.enabled) return;
    this.elapsed += dt;
    (this.pass.material.uniforms.uTime.value as number) = this.elapsed;
    // Lerp toward the target at the recovery rate.
    const k = 1 - Math.exp(-dt / this.config.recoveryTau);
    this.currentShock += (this.targetShock - this.currentShock) * k;
    (this.pass.material.uniforms.uShock.value as number) = this.currentShock;
  }

  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    (this.pass.material.uniforms.uTexelSize.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  dispose(): void {
    this.pass.dispose();
  }

  getConfig(): Readonly<ShellShockConfig> { return this.config; }
  getCurrentShock(): number { return this.currentShock; }
  getTargetShock(): number { return this.targetShock; }
}
