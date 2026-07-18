/**
 * Section A — Thermal bloom from hot barrels (weapon VFX).
 * Sustained weapon fire heats the barrel to several hundred °C. Hot metal
 * radiates IR (Stefan-Boltzmann: P = εσT⁴) — invisible to the naked eye but
 * visible to thermal cameras + produces a faint red glow at very high temps.
 * Provides:
 *   - THERMAL_PROFILES — per-weapon thermal config data table.
 *   - ThermalBarrelSystem — owns per-weapon barrel-temperature state.
 *   - ThermalBloomPass — screen-space bloom halo + heat-haze distortion.
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface ThermalProfile {
  slug: string;
  heatPerRound: number; coolingRate: number;
  glowThreshold: number; hazeThreshold: number; redHotThreshold: number;
  bloomColor: THREE.Color;
}

export const THERMAL_PROFILES: Record<string, ThermalProfile> = {
  "ak-74": { slug: "ak-74", heatPerRound: 4.5, coolingRate: 12, glowThreshold: 200, hazeThreshold: 150, redHotThreshold: 500, bloomColor: new THREE.Color(0.9, 0.25, 0.1) },
  "m4a1":  { slug: "m4a1",  heatPerRound: 3.8, coolingRate: 14, glowThreshold: 220, hazeThreshold: 180, redHotThreshold: 550, bloomColor: new THREE.Color(0.85, 0.2, 0.08) },
  "mp5":   { slug: "mp5",   heatPerRound: 2.5, coolingRate: 16, glowThreshold: 180, hazeThreshold: 140, redHotThreshold: 420, bloomColor: new THREE.Color(0.95, 0.3, 0.12) },
  "rpk":   { slug: "rpk",   heatPerRound: 5.5, coolingRate: 9,  glowThreshold: 230, hazeThreshold: 190, redHotThreshold: 600, bloomColor: new THREE.Color(0.85, 0.18, 0.06) },
  "sr-25": { slug: "sr-25", heatPerRound: 8.0, coolingRate: 8,  glowThreshold: 250, hazeThreshold: 200, redHotThreshold: 650, bloomColor: new THREE.Color(0.8, 0.15, 0.05) },
};

export function getThermalProfile(slug: string): ThermalProfile {
  return THERMAL_PROFILES[slug] ?? THERMAL_PROFILES["ak-74"];
}

export interface BarrelThermalState {
  weaponId: string; slug: string; temperature: number; ambient: number;
}

/** Owns the per-weapon barrel-temperature state + publishes a hot-barrel mask. */
export class ThermalBarrelSystem {
  private states: Map<string, BarrelThermalState> = new Map();
  private enabled = true;
  private maskTexture: THREE.DataTexture;
  private maskData: Uint8Array;
  private maskSize = 64;

  constructor() {
    this.maskData = new Uint8Array(this.maskSize * this.maskSize * 4);
    this.maskTexture = new THREE.DataTexture(this.maskData, this.maskSize, this.maskSize, THREE.RGBAFormat);
    this.maskTexture.needsUpdate = true;
  }
  registerWeapon(weaponId: string, slug: string): void {
    this.states.set(weaponId, { weaponId, slug, temperature: 20, ambient: 20 });
  }
  unregisterWeapon(weaponId: string): void { this.states.delete(weaponId); }
  recordRoundFired(weaponId: string, rounds = 1): void {
    const s = this.states.get(weaponId);
    if (!s) return;
    s.temperature += getThermalProfile(s.slug).heatPerRound * rounds;
  }
  getTemperature(weaponId: string): number { return this.states.get(weaponId)?.temperature ?? 20; }
  getGlowAmount(weaponId: string): number {
    const s = this.states.get(weaponId);
    if (!s) return 0;
    const p = getThermalProfile(s.slug);
    if (s.temperature < p.glowThreshold) return 0;
    return THREE.MathUtils.smoothstep(s.temperature, p.glowThreshold, p.redHotThreshold);
  }
  update(dt: number): void {
    if (!this.enabled) return;
    for (const s of this.states.values()) {
      const p = getThermalProfile(s.slug);
      const diff = s.temperature - s.ambient;
      s.temperature -= Math.min(diff, p.coolingRate * dt);
    }
  }
  /** Refresh the mask texture from per-weapon glow/haze amounts. Host samples
   *  this in the bloom pass. Entries written in weaponId order. */
  updateMask(): void {
    this.maskData.fill(0);
    let i = 0;
    const max = this.maskSize * this.maskSize;
    for (const s of this.states.values()) {
      if (i >= max) break;
      const p = getThermalProfile(s.slug);
      const glow = this.getGlowAmount(s.weaponId);
      const haze = s.temperature > p.hazeThreshold
        ? THREE.MathUtils.smoothstep(s.temperature, p.hazeThreshold, p.redHotThreshold) : 0;
      const o = i * 4;
      this.maskData[o] = Math.round(glow * 255);
      this.maskData[o + 1] = Math.round(haze * 255);
      this.maskData[o + 2] = 0;
      this.maskData[o + 3] = 255;
      i++;
    }
    this.maskTexture.needsUpdate = true;
  }
  getMaskTexture(): THREE.DataTexture { return this.maskTexture; }
  setEnabled(v: boolean): void { this.enabled = v; }
  isEnabled(): boolean { return this.enabled; }
  getMaskSize(): number { return this.maskSize; }
  getWeaponCount(): number { return this.states.size; }
}

export const ThermalBloomShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tThermalMask: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTexelSize: { value: new THREE.Vector2(1, 1) },
    uBloomColor: { value: new THREE.Color(0.9, 0.25, 0.1) },
    uIntensity: { value: 1.0 }, uHazeAmount: { value: 0.3 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform sampler2D tThermalMask;
    uniform vec2 uResolution; uniform vec2 uTexelSize;
    uniform vec3 uBloomColor; uniform float uIntensity;
    uniform float uHazeAmount; uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      if (uIntensity < 0.001) { gl_FragColor = col; return; }
      vec4 mask = texture2D(tThermalMask, vUv);
      float glow = mask.r;
      float haze = mask.g;
      vec3 bloom = vec3(0.0);
      float weightSum = 0.0;
      if (glow > 0.01) {
        for (int dx = -4; dx <= 4; dx++) for (int dy = -4; dy <= 4; dy++) {
          vec2 sampleUv = vUv + vec2(float(dx), float(dy)) * uTexelSize * 4.0;
          if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) continue;
          float g = exp(-float(dx * dx + dy * dy) / 16.0);
          float m = texture2D(tThermalMask, sampleUv).r;
          bloom += uBloomColor * m * g; weightSum += g;
        }
        bloom /= max(weightSum, 1e-4);
      }
      col.rgb += bloom * uIntensity;
      if (haze > 0.01 && uHazeAmount > 0.001) {
        float shimmer = sin(vUv.y * 50.0 + uTime * 5.0) * 0.5 + 0.5;
        vec2 hazeOffset = vec2(0.0, shimmer * uTexelSize.y * 2.0) * haze * uHazeAmount;
        col.rgb = mix(col.rgb, texture2D(tDiffuse, vUv + hazeOffset).rgb, haze * uHazeAmount * 0.5);
      }
      gl_FragColor = col;
    }
  `,
};

/** Thermal bloom pass — adds the bloom halo + heat haze from hot barrels. */
export class ThermalBloomPass {
  readonly pass: ShaderPass;
  private enabled = true;
  private bloomColor: THREE.Color;
  private elapsed = 0;

  constructor(bloomColor: THREE.Color = new THREE.Color(0.9, 0.25, 0.1)) {
    this.bloomColor = bloomColor.clone();
    this.pass = new ShaderPass(ThermalBloomShader);
    (this.pass.material.uniforms.uBloomColor.value as THREE.Color).copy(this.bloomColor);
  }
  setThermalMask(tex: THREE.Texture): void { (this.pass.material.uniforms.tThermalMask.value as THREE.Texture | null) = tex; }
  setIntensity(i: number): void { (this.pass.material.uniforms.uIntensity.value as number) = THREE.MathUtils.clamp(i, 0, 4); }
  setHazeAmount(h: number): void { (this.pass.material.uniforms.uHazeAmount.value as number) = THREE.MathUtils.clamp(h, 0, 1); }
  setBloomColor(c: THREE.Color): void {
    this.bloomColor.copy(c);
    (this.pass.material.uniforms.uBloomColor.value as THREE.Color).copy(c);
  }
  setEnabled(v: boolean): void { this.enabled = v; this.pass.enabled = v; }
  isEnabled(): boolean { return this.enabled; }
  update(dt: number): void {
    if (!this.enabled) return;
    this.elapsed += dt;
    (this.pass.material.uniforms.uTime.value as number) = this.elapsed;
  }
  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
    (this.pass.material.uniforms.uTexelSize.value as THREE.Vector2).set(1 / w, 1 / h);
  }
  dispose(): void { this.pass.dispose(); }
}
