/**
 * Section A — Anamorphic lens flares (cinematic camera effect).
 *
 * Anamorphic lenses (used in film production) produce horizontal blue streaks
 * from bright light sources — the iconic "J.J. Abrams" flare. The effect
 * comes from the lens's cylindrical element which spreads highlights
 * horizontally (perpendicular to the squeeze direction).
 *
 * This module provides a screen-space anamorphic-flare post-process pass that:
 *   - Thresholds the HDR color buffer to isolate bright highlights.
 *   - Applies a wide horizontal Gaussian blur (16-tap) — the streak.
 *   - Tints the streak blue (typical anamorphic color).
 *   - Adds the streak back to the color buffer additively.
 *
 * Integration: PostProcessing.ts inserts this pass AFTER the bloom pass (so
 * the bloom threshold has already isolated highlights) + BEFORE the grade pass
 * (so the streak is tonemapped with the rest of the scene).
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface AnamorphicFlareConfig {
  /** Highlight threshold (0..1 in HDR linear). Only pixels brighter than this
   *  contribute to the streak. */
  threshold: number;
  /** Streak width (pixels). 1 = no streak, 8 = wide cinematic streak. */
  width: number;
  /** Streak intensity (0..2). */
  intensity: number;
  /** Streak tint (linear color). Blue is the classic anamorphic tint. */
  tint: THREE.Color;
  /** Number of horizontal blur taps (8/16/32). */
  samples: number;
  /** Half-res toggle — render the streak at half res for perf. */
  halfRes: boolean;
}

export const ANAMORPHIC_FLARE_DEFAULTS: AnamorphicFlareConfig = {
  threshold: 0.85,
  width: 6,
  intensity: 0.4,
  tint: new THREE.Color(0.4, 0.6, 1.0),
  samples: 16,
  halfRes: true,
};

export const AnamorphicFlareShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTexelSize: { value: new THREE.Vector2(1, 1) },
    uThreshold: { value: 0.85 },
    uWidth: { value: 6 },
    uIntensity: { value: 0.4 },
    uTint: { value: new THREE.Color(0.4, 0.6, 1.0) },
    uSamples: { value: 16 },
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
    uniform float uThreshold;
    uniform float uWidth;
    uniform float uIntensity;
    uniform vec3 uTint;
    uniform int uSamples;
    varying vec2 vUv;

    // Compute the streak at the current pixel — horizontal Gaussian blur
    // applied ONLY to pixels above the threshold (highlights).
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      if (uIntensity < 0.001) { gl_FragColor = col; return; }
      // Threshold the HDR color to isolate highlights.
      vec3 center = col.rgb;
      float lum = dot(center, vec3(0.2126, 0.7152, 0.0722));
      if (lum < uThreshold) {
        // Even non-highlight pixels get the streak — that's the point
        // (the streak extends BEYOND the bright source). But we still need
        // the blur to be center-weighted. Fall through to the blur pass.
      }
      // Horizontal Gaussian blur — 16 taps (configurable).
      vec3 streak = vec3(0.0);
      float weightSum = 0.0;
      for (int i = -16; i <= 16; i++) {
        if (abs(float(i)) > float(uSamples)) continue;
        vec2 sampleUv = vUv + vec2(float(i) * uWidth * uTexelSize.x, 0.0);
        if (sampleUv.x < 0.0 || sampleUv.x > 1.0) continue;
        vec3 s = texture2D(tDiffuse, sampleUv).rgb;
        float sLum = dot(s, vec3(0.2126, 0.7152, 0.0722));
        // Threshold — only bright pixels contribute to the streak.
        float bright = max(0.0, sLum - uThreshold) / max(0.001, 1.0 - uThreshold);
        // Gaussian weight (sigma = uSamples / 3).
        float g = exp(-float(i * i) / (2.0 * float(uSamples / 3) * float(uSamples / 3)));
        streak += s * bright * g;
        weightSum += g;
      }
      streak /= max(weightSum, 1e-4);
      // Tint + intensity.
      vec3 tinted = streak * uTint * uIntensity;
      // Additive blend.
      gl_FragColor = vec4(col.rgb + tinted, col.a);
    }
  `,
};

/** Anamorphic flare pass. */
export class AnamorphicFlarePass {
  readonly pass: ShaderPass;
  private config: AnamorphicFlareConfig;
  private enabled = true;

  constructor(config: AnamorphicFlareConfig = { ...ANAMORPHIC_FLARE_DEFAULTS }) {
    this.config = { ...config };
    this.pass = new ShaderPass(AnamorphicFlareShader);
    this.applyConfig();
  }

  private applyConfig(): void {
    const u = this.pass.material.uniforms;
    (u.uThreshold.value as number) = this.config.threshold;
    (u.uWidth.value as number) = this.config.width;
    (u.uIntensity.value as number) = this.config.intensity;
    (u.uTint.value as THREE.Color).copy(this.config.tint);
    (u.uSamples.value as number) = this.config.samples;
  }

  setThreshold(t: number): void {
    this.config.threshold = THREE.MathUtils.clamp(t, 0, 1);
    (this.pass.material.uniforms.uThreshold.value as number) = this.config.threshold;
  }

  setIntensity(i: number): void {
    this.config.intensity = THREE.MathUtils.clamp(i, 0, 2);
    (this.pass.material.uniforms.uIntensity.value as number) = this.config.intensity;
  }

  setTint(c: THREE.Color): void {
    (this.pass.material.uniforms.uTint.value as THREE.Color).copy(c);
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.pass.enabled = v;
  }
  isEnabled(): boolean { return this.enabled; }

  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    (this.pass.material.uniforms.uTexelSize.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  dispose(): void {
    this.pass.dispose();
  }

  getConfig(): Readonly<AnamorphicFlareConfig> { return this.config; }
}
