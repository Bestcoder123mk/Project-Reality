/**
 * Section A — Film grain per-ISO (camera effect).
 *
 * Real photographic film grain varies with ISO sensitivity:
 *   - Low ISO (100): tight, fine grain, barely visible.
 *   - Mid ISO (400): moderate grain, visible in shadows.
 *   - High ISO (3200): coarse, clumpy grain, visible everywhere.
 *
 * Real digital sensors exhibit similar noise: photon shot noise + read noise
 * scales with the gain (ISO). The existing grade shader has a single grain
 * uniform; this module extends that with a per-ISO data table + a grain
 * intensity/size curve that matches real film stock characteristics.
 *
 * Integration: PostProcessing.ts constructs a FilmGrainPerISO instance + the
 * HUD/gameplay code calls setISO() when the player enters a low-light area
 * (analogous to a camera auto-ISO bump). The instance pushes the
 * intensity/size to the grade shader's uGrain + a new uGrainSize uniform.
 */
import * as THREE from "three";

export interface FilmGrainPreset {
  /** ISO value (100/200/400/800/1600/3200/6400). */
  iso: number;
  /** Grain intensity (0..0.1 — typical range). */
  intensity: number;
  /** Grain size (texels; smaller = finer grain). */
  size: number;
  /** Grain color saturation (0 = monochrome, 1 = full color noise). */
  colorSaturation: number;
  /** Grain contrast (0..1). */
  contrast: number;
}

/** Per-ISO film grain data table — modeled on Kodak Portra + Ilford HP5
 *  stocks. Linear interpolation between entries. */
export const FILM_GRAIN_PRESETS: FilmGrainPreset[] = [
  { iso: 100, intensity: 0.005, size: 0.5, colorSaturation: 0.4, contrast: 0.5 },
  { iso: 200, intensity: 0.008, size: 0.6, colorSaturation: 0.45, contrast: 0.55 },
  { iso: 400, intensity: 0.014, size: 0.8, colorSaturation: 0.5, contrast: 0.6 },
  { iso: 800, intensity: 0.022, size: 1.0, colorSaturation: 0.55, contrast: 0.65 },
  { iso: 1600, intensity: 0.035, size: 1.3, colorSaturation: 0.6, contrast: 0.7 },
  { iso: 3200, intensity: 0.055, size: 1.7, colorSaturation: 0.65, contrast: 0.75 },
  { iso: 6400, intensity: 0.085, size: 2.2, colorSaturation: 0.7, contrast: 0.8 },
];

/** Interpolate the grain preset for an arbitrary ISO value. Pure function. */
export function getGrainForISO(iso: number): FilmGrainPreset {
  // Clamp to the table range.
  if (iso <= FILM_GRAIN_PRESETS[0].iso) return { ...FILM_GRAIN_PRESETS[0] };
  if (iso >= FILM_GRAIN_PRESETS[FILM_GRAIN_PRESETS.length - 1].iso) {
    return { ...FILM_GRAIN_PRESETS[FILM_GRAIN_PRESETS.length - 1] };
  }
  // Linear interpolation between the two nearest entries (in log space — ISO
  // is logarithmic, so we interpolate in log space for natural transitions).
  const logIso = Math.log2(iso);
  for (let i = 0; i < FILM_GRAIN_PRESETS.length - 1; i++) {
    const a = FILM_GRAIN_PRESETS[i];
    const b = FILM_GRAIN_PRESETS[i + 1];
    if (iso >= a.iso && iso <= b.iso) {
      const t = (logIso - Math.log2(a.iso)) / (Math.log2(b.iso) - Math.log2(a.iso));
      return {
        iso,
        intensity: THREE.MathUtils.lerp(a.intensity, b.intensity, t),
        size: THREE.MathUtils.lerp(a.size, b.size, t),
        colorSaturation: THREE.MathUtils.lerp(a.colorSaturation, b.colorSaturation, t),
        contrast: THREE.MathUtils.lerp(a.contrast, b.contrast, t),
      };
    }
  }
  return { ...FILM_GRAIN_PRESETS[3] }; // fallback
}

/** Film grain per-ISO controller — owns the current ISO + drives the grade
 *  shader uniforms. */
export class FilmGrainPerISO {
  private iso = 400;
  private currentPreset: FilmGrainPreset;
  /** Auto-ISO mode — the controller automatically adjusts ISO based on the
   *  scene's average luminance (darker scene → higher ISO → more grain). */
  private autoISO = true;
  private enabled = true;
  /** Target ISO for auto mode (smoothed to avoid sudden grain pops). */
  private targetISO = 400;
  /** Auto-ISO tuning parameters. */
  private autoISOMin = 100;
  private autoISOMax = 3200;
  private autoISOLowLum = 0.05;   // luminance below which ISO climbs
  private autoISOHighLum = 0.6;   // luminance above which ISO drops

  constructor(initialISO = 400) {
    this.iso = initialISO;
    this.currentPreset = getGrainForISO(initialISO);
  }

  /** Set the ISO directly (disables auto-ISO). */
  setISO(iso: number): void {
    this.iso = THREE.MathUtils.clamp(iso, 50, 25600);
    this.autoISO = false;
    this.currentPreset = getGrainForISO(this.iso);
  }

  /** Enable auto-ISO mode. */
  setAutoISO(enabled: boolean): void {
    this.autoISO = enabled;
  }

  /** Update the controller — in auto mode, drives the ISO from the scene
   *  luminance. Returns the current grain preset (for the host to push to
   *  the grade shader). */
  update(dt: number, avgLuminance: number): FilmGrainPreset {
    if (!this.enabled) return this.currentPreset;
    if (this.autoISO) {
      // Map luminance → target ISO. Dark scenes climb to autoISOMax; bright
      // scenes drop to autoISOMin.
      const t = THREE.MathUtils.smoothstep(
        avgLuminance,
        this.autoISOLowLum,
        this.autoISOHighLum,
      );
      // Inverse — darker = higher ISO.
      const logTarget = THREE.MathUtils.lerp(
        Math.log2(this.autoISOMax),
        Math.log2(this.autoISOMin),
        t,
      );
      this.targetISO = Math.pow(2, logTarget);
      // Smoothly approach the target ISO (avoid sudden grain pops).
      const k = 1 - Math.exp(-dt / 1.5);
      this.iso = THREE.MathUtils.lerp(this.iso, this.targetISO, k);
      this.currentPreset = getGrainForISO(this.iso);
    }
    return this.currentPreset;
  }

  setEnabled(v: boolean): void { this.enabled = v; }
  isEnabled(): boolean { return this.enabled; }

  getISO(): number { return this.iso; }
  getPreset(): Readonly<FilmGrainPreset> { return this.currentPreset; }
  isAutoISO(): boolean { return this.autoISO; }

  /** Push the current grain preset to a target uniform set (typically the
   *  grade shader's uniforms). Returns the modified uniforms for chaining. */
  applyToUniforms(uniforms: {
    uGrain: { value: number };
    uGrainSize?: { value: number };
    uGrainColorSaturation?: { value: number };
    uGrainContrast?: { value: number };
    uGrainEnable?: { value: number };
  }): void {
    uniforms.uGrain.value = this.enabled ? this.currentPreset.intensity : 0;
    if (uniforms.uGrainSize) uniforms.uGrainSize.value = this.currentPreset.size;
    if (uniforms.uGrainColorSaturation) uniforms.uGrainColorSaturation.value = this.currentPreset.colorSaturation;
    if (uniforms.uGrainContrast) uniforms.uGrainContrast.value = this.currentPreset.contrast;
    if (uniforms.uGrainEnable) uniforms.uGrainEnable.value = this.enabled ? 1 : 0;
  }
}

/** Per-ISO grain fragment shader chunk — for the host to inject into the
 *  grade shader. Replaces the existing single-grain-uniform chunk with the
 *  per-ISO multi-uniform chunk. */
export const PER_ISO_GRAIN_CHUNK = /* glsl */ `
  uniform float uGrainSize;
  uniform float uGrainColorSaturation;
  uniform float uGrainContrast;
  float perIsoGrain(vec2 uv, float t) {
    // Multi-octave FBM at the per-ISO grain size.
    float a = 0.5;
    float s = 0.0;
    vec2 p = uv * mix(256.0, 1024.0, 1.0 / uGrainSize) + fract(t) * 1024.0;
    for (int i = 0; i < 3; i++) {
      vec2 h = fract(p * vec2(443.897, 441.423));
      h += dot(h, h.yx + 19.19);
      s += a * fract((h.x + h.y) * h.x);
      p *= 2.13;
      a *= 0.5;
    }
    s = (s - 0.5) * uGrainContrast;
    return s;
  }
`;
