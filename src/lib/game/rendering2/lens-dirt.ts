/**
 * Section A — Lens dirt accumulation over match (camera effect).
 *
 * Real camera lenses accumulate dust, fingerprints, and oil smudges over
 * time. In gameplay this translates to a subtle dirt texture that builds up
 * on the lens over the course of a match — a "you've been in the field for
 * a while" feel. The effect is most visible when bright highlights hit the
 * lens (the dirt catches the light + blooms outward).
 *
 * This module provides:
 *   - LensDirtConfig — per-match dirt accumulation profile.
 *   - buildLensDirtTexture() — procedural dirt texture generator (Perlin
 *     noise + radial smudge gradient).
 *   - LensDirtPass — a screen-space post-process that overlays the dirt
 *     texture modulated by the bright-pixel mask (so dirt only shows when
 *     the lens is flared).
 *   - LensDirtAccumulator — owns the per-match dirt amount (slowly increases
 *     over time, can be reset by a "wipe lens" player action).
 *
 * Integration: PostProcessing.ts inserts the pass after the bloom pass (so
 * the bloom threshold has isolated highlights). The match-loop calls
 * accumulator.update(dt) per frame; the player "wipe lens" action calls
 * accumulator.wipe() (reduces accumulation by 80 %).
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface LensDirtConfig {
  /** Maximum dirt accumulation (0..1). */
  maxAmount: number;
  /** Accumulation rate (per second) — how fast dirt builds up. */
  rate: number;
  /** Dirt bloom color (linear). */
  color: THREE.Color;
  /** Dirt bloom intensity multiplier. */
  intensity: number;
  /** Brightness threshold for the dirt mask (only highlights bloom the dirt). */
  threshold: number;
  /** Texture resolution (square). */
  resolution: number;
}

export const LENS_DIRT_DEFAULTS: LensDirtConfig = {
  maxAmount: 0.6,
  rate: 0.002, // ~5 minutes for full accumulation
  color: new THREE.Color(0.8, 0.7, 0.5),
  intensity: 1.2,
  threshold: 0.6,
  resolution: 512,
};

/** Build a procedural lens dirt texture — multi-octave Perlin noise with a
 *  radial smudge gradient (dirt is more visible toward the lens edges). */
export function buildLensDirtTexture(
  config: LensDirtConfig = LENS_DIRT_DEFAULTS,
): THREE.DataTexture {
  const res = config.resolution;
  const data = new Uint8Array(res * res * 4);
  // Multi-octave value noise (inline — same generator as photogrammetry.ts
  // but kept local to avoid the cross-module dependency).
  const latticeSize = 32;
  const lattices: Float32Array[] = [];
  for (let o = 0; o < 4; o++) {
    const ls = latticeSize >> o;
    const lattice = new Float32Array(ls * ls);
    for (let i = 0; i < lattice.length; i++) lattice[i] = Math.random();
    lattices.push(lattice);
  }
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = (y * res + x) * 4;
      // Multi-octave noise.
      let n = 0;
      let amp = 1.0;
      let totalAmp = 0.0;
      for (let o = 0; o < 4; o++) {
        const ls = latticeSize >> o;
        const u = (x / res) * ls;
        const v = (y / res) * ls;
        const x0 = Math.floor(u), y0 = Math.floor(v);
        const x1 = (x0 + 1) % ls, y1 = (y0 + 1) % ls;
        const fx = u - x0, fy = v - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const lat = lattices[o];
        const a = lat[y0 * ls + x0];
        const b = lat[y0 * ls + x1];
        const c = lat[y1 * ls + x0];
        const d = lat[y1 * ls + x1];
        const top = a + (b - a) * sx;
        const bot = c + (d - c) * sx;
        n += (top + (bot - top) * sy) * amp;
        totalAmp += amp;
        amp *= 0.5;
      }
      n /= totalAmp;
      // Radial gradient — dirt more visible at the lens edges.
      const cx = x / res - 0.5;
      const cy = y / res - 0.5;
      const r = Math.hypot(cx, cy) * 2;
      const radial = THREE.MathUtils.clamp(r, 0, 1);
      // Smudge direction — directional streak from upper-left to lower-right.
      const smudge = Math.sin((cx + cy) * 6) * 0.1 + 0.9;
      const dirt = n * radial * smudge;
      data[i] = Math.round(dirt * 255 * config.color.r * 255 / 255);
      data[i + 1] = Math.round(dirt * 255 * config.color.g * 255 / 255);
      data[i + 2] = Math.round(dirt * 255 * config.color.b * 255 / 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Lens dirt accumulator — owns the per-match dirt amount. */
export class LensDirtAccumulator {
  private amount = 0;
  private config: LensDirtConfig;
  private enabled = true;

  constructor(config: LensDirtConfig = { ...LENS_DIRT_DEFAULTS }) {
    this.config = { ...config };
  }

  /** Per-frame update — increases the dirt amount over time. */
  update(dt: number): void {
    if (!this.enabled) return;
    this.amount = Math.min(this.config.maxAmount, this.amount + this.config.rate * dt);
  }

  /** Player "wipe lens" action — reduces the dirt amount by 80 %. */
  wipe(): void {
    this.amount *= 0.2;
  }

  /** Reset the dirt amount to zero (e.g. on match start). */
  reset(): void {
    this.amount = 0;
  }

  getAmount(): number { return this.amount; }
  setAmount(a: number): void {
    this.amount = THREE.MathUtils.clamp(a, 0, this.config.maxAmount);
  }
  setEnabled(v: boolean): void { this.enabled = v; }
  isEnabled(): boolean { return this.enabled; }
  getConfig(): Readonly<LensDirtConfig> { return this.config; }
}

export const LensDirtShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDirt: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uAmount: { value: 0 },
    uThreshold: { value: 0.6 },
    uIntensity: { value: 1.2 },
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
    uniform sampler2D tDirt;
    uniform vec2 uResolution;
    uniform float uAmount;
    uniform float uThreshold;
    uniform float uIntensity;
    varying vec2 vUv;

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      if (uAmount < 0.001) { gl_FragColor = col; return; }
      // Sample the dirt texture.
      vec3 dirt = texture2D(tDirt, vUv).rgb;
      // Sample the brightness around the current pixel to determine the
      // "lens flare" amount (dirt only blooms when bright light is nearby).
      float lum = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
      // Cheap blur — sample 4 neighbors + average.
      vec2 texel = 1.0 / uResolution;
      float bright = 0.0;
      bright += max(0.0, dot(texture2D(tDiffuse, vUv + vec2(texel.x * 4.0, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722)) - uThreshold);
      bright += max(0.0, dot(texture2D(tDiffuse, vUv - vec2(texel.x * 4.0, 0.0)).rgb, vec3(0.2126, 0.7152, 0.0722)) - uThreshold);
      bright += max(0.0, dot(texture2D(tDiffuse, vUv + vec2(0.0, texel.y * 4.0)).rgb, vec3(0.2126, 0.7152, 0.0722)) - uThreshold);
      bright += max(0.0, dot(texture2D(tDiffuse, vUv - vec2(0.0, texel.y * 4.0)).rgb, vec3(0.2126, 0.7152, 0.0722)) - uThreshold);
      bright += max(0.0, lum - uThreshold);
      bright = clamp(bright * 0.5, 0.0, 4.0);
      // Apply the dirt — additive blend modulated by the bright amount.
      vec3 dirtCol = dirt * bright * uIntensity * uAmount;
      gl_FragColor = vec4(col.rgb + dirtCol, col.a);
    }
  `,
};

/** Lens dirt post-process pass. */
export class LensDirtPass {
  readonly pass: ShaderPass;
  private enabled = true;
  private dirtTexture: THREE.DataTexture;
  private accumulator: LensDirtAccumulator;

  constructor(
    config: LensDirtConfig = { ...LENS_DIRT_DEFAULTS },
    accumulator?: LensDirtAccumulator,
  ) {
    this.dirtTexture = buildLensDirtTexture(config);
    this.accumulator = accumulator ?? new LensDirtAccumulator(config);
    this.pass = new ShaderPass(LensDirtShader);
    (this.pass.material.uniforms.tDirt.value as THREE.Texture | null) = this.dirtTexture;
    (this.pass.material.uniforms.uThreshold.value as number) = config.threshold;
    (this.pass.material.uniforms.uIntensity.value as number) = config.intensity;
  }

  setAmount(a: number): void {
    this.accumulator.setAmount(a);
  }

  wipe(): void {
    this.accumulator.wipe();
  }

  reset(): void {
    this.accumulator.reset();
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.pass.enabled = v;
  }
  isEnabled(): boolean { return this.enabled; }

  update(dt: number): void {
    if (!this.enabled) return;
    this.accumulator.update(dt);
    (this.pass.material.uniforms.uAmount.value as number) = this.accumulator.getAmount();
  }

  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  }

  getAccumulator(): LensDirtAccumulator { return this.accumulator; }

  dispose(): void {
    this.pass.dispose();
    this.dirtTexture.dispose();
  }
}
