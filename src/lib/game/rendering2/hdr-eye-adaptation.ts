/**
 * Section A — HDR eye adaptation (rod/cone model).
 *
 * The human eye has two photoreceptor systems:
 *   - Rods: low-light vision, slow adaptation (~7 minutes), monochromatic.
 *   - Cones: bright-light vision, fast adaptation (~5 seconds), full color.
 *
 * Realistic eye adaptation alternates between these systems based on the
 * scene luminance — dark scenes use rod vision (slower adaptation, blue-shift
 * via Purkinje effect), bright scenes use cone vision (fast adaptation,
 * normal color). This module implements a dual-state adaptation model that
 * drives the grade shader's exposure + a subtle blue-shift at night.
 *
 * Integration: PostProcessing.ts constructs an HDREyeAdaptation instance +
 * calls `update(dt, avgLuminance)` per frame (the existing luminance-readback
 * hook feeds this). The instance returns the target exposure + Purkinje shift
 * which the grade shader blends toward. The existing single-state eye
 * adaptation in PostProcessing.ts is preserved as a fallback for low quality.
 */
import * as THREE from "three";

export interface EyeAdaptationConfig {
  /** Rod adaptation time constant (seconds). Slow — ~7 min for full dark. */
  rodTau: number;
  /** Cone adaptation time constant (seconds). Fast — ~5 s. */
  coneTau: number;
  /** Luminance threshold for rod/cone crossover (cd/m²). Below = rods. */
  rodConeThreshold: number;
  /** Target luminance after adaptation (cd/m²). */
  targetLuminance: number;
  /** Minimum exposure (dark scenes). */
  minExposure: number;
  /** Maximum exposure (bright scenes). */
  maxExposure: number;
  /** Purkinje shift strength (0..1) — blue tint at low luminance. */
  purkinjeStrength: number;
  /** Purkinje blue-shift color (linear RGB). */
  purkinjeColor: THREE.Color;
}

export const EYE_ADAPTATION_DEFAULTS: EyeAdaptationConfig = {
  rodTau: 60.0,
  coneTau: 2.5,
  rodConeThreshold: 0.05,
  targetLuminance: 0.5,
  minExposure: 0.4,
  maxExposure: 1.6,
  purkinjeStrength: 0.5,
  purkinjeColor: new THREE.Color(0.4, 0.55, 0.9),
};

export interface EyeAdaptationState {
  /** Current rod-system exposure (slowly adapting). */
  rodExposure: number;
  /** Current cone-system exposure (fast adapting). */
  coneExposure: number;
  /** Rod/cone blend factor (0 = full cones, 1 = full rods). */
  rodConeBlend: number;
  /** Final composited exposure. */
  exposure: number;
  /** Purkinjee shift color (additive tint at low luminance). */
  purkinjeShift: THREE.Color;
  /** Last sampled average luminance. */
  avgLuminance: number;
}

/** Compute the target exposure for a given average luminance. Pure function. */
export function computeTargetExposure(
  avgLuminance: number,
  config: EyeAdaptationConfig,
): number {
  const safeLum = Math.max(0.0001, avgLuminance);
  // Target exposure = targetLuminance / avgLuminance (clamped).
  const raw = config.targetLuminance / safeLum;
  return THREE.MathUtils.clamp(raw, config.minExposure, config.maxExposure);
}

/** Compute the rod/cone blend factor for a given luminance. Pure function. */
export function computeRodConeBlend(
  avgLuminance: number,
  config: EyeAdaptationConfig,
): number {
  // Smoothstep crossover around the rodConeThreshold.
  const t = THREE.MathUtils.smoothstep(
    avgLuminance,
    config.rodConeThreshold * 0.5,
    config.rodConeThreshold * 2.0,
  );
  // t=1 (bright) → full cones (blend=0). t=0 (dark) → full rods (blend=1).
  return 1.0 - t;
}

/** HDREyeAdaptation — owns the rod/cone state + advances it per frame. */
export class HDREyeAdaptation {
  private config: EyeAdaptationConfig;
  private state: EyeAdaptationState;
  private enabled = true;

  constructor(config: EyeAdaptationConfig = { ...EYE_ADAPTATION_DEFAULTS }) {
    this.config = { ...config };
    this.state = {
      rodExposure: config.targetLuminance,
      coneExposure: config.targetLuminance,
      rodConeBlend: 0,
      exposure: config.targetLuminance,
      purkinjeShift: new THREE.Color(0, 0, 0),
      avgLuminance: config.targetLuminance,
    };
  }

  /** Advance the adaptation state toward the new average luminance. Returns
   *  the current exposure + Purkinjee shift (for the host to apply). */
  update(dt: number, avgLuminance: number): EyeAdaptationState {
    if (!this.enabled) return this.state;
    this.state.avgLuminance = avgLuminance;
    const target = computeTargetExposure(avgLuminance, this.config);
    const blend = computeRodConeBlend(avgLuminance, this.config);
    this.state.rodConeBlend = blend;
    // Rods adapt slowly, cones adapt fast — exponential approach.
    const rodK = 1 - Math.exp(-dt / this.config.rodTau);
    const coneK = 1 - Math.exp(-dt / this.config.coneTau);
    this.state.rodExposure += (target - this.state.rodExposure) * rodK;
    this.state.coneExposure += (target - this.state.coneExposure) * coneK;
    // Composite exposure — blend rod + cone by the rod/cone factor.
    this.state.exposure = THREE.MathUtils.lerp(
      this.state.coneExposure,
      this.state.rodExposure,
      blend,
    );
    // Purkinje shift — blue tint proportional to rod activation.
    const purkinjee = this.config.purkinjeStrength * blend;
    this.state.purkinjeShift.copy(this.config.purkinjeColor).multiplyScalar(purkinjee);
    return this.state;
  }

  /** Reset the adaptation state to neutral (e.g. on map load). */
  reset(): void {
    this.state.rodExposure = this.config.targetLuminance;
    this.state.coneExposure = this.config.targetLuminance;
    this.state.rodConeBlend = 0;
    this.state.exposure = this.config.targetLuminance;
    this.state.purkinjeShift.set(0, 0, 0);
    this.state.avgLuminance = this.config.targetLuminance;
  }

  setEnabled(v: boolean): void { this.enabled = v; }
  isEnabled(): boolean { return this.enabled; }

  getConfig(): Readonly<EyeAdaptationConfig> { return this.config; }
  getState(): Readonly<EyeAdaptationState> { return this.state; }
}

/** Eye-adaptation post-process fragment shader chunk — for the host to inject
 *  into the grade shader (or as a standalone pass). This applies the
 *  Purkinjee blue-shift AFTER tonemapping (so the shift is applied in display
 *  RGB space, which matches how the human eye perceives the effect). */
export const PURKINJE_SHIFT_CHUNK = /* glsl */ `
  // === Purkinje shift (rod vision blue tint at low luminance) ===
  // Applied post-tonemap — additive blue tint proportional to the rod
  // activation (driven by uRodConeBlend from the host).
  uniform float uRodConeBlend;
  uniform vec3 uPurkinjeColor;
  uniform float uPurkinjeStrength;
  vec3 applyPurkinjeeShift(vec3 c) {
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float shift = uPurkinjeStrength * uRodConeBlend * (1.0 - smoothstep(0.0, 0.3, lum));
    return c + uPurkinjeColor * shift;
  }
`;

/** Eye-adaptation uniforms — for the host to inject into the grade shader. */
export function buildEyeAdaptationUniforms() {
  return {
    uRodConeBlend: { value: 0 },
    uPurkinjeeColor: { value: new THREE.Color(0.4, 0.55, 0.9) },
    uPurkinjeeStrength: { value: 0.5 },
  };
}
