/**
 * Section C — Thermal and night-vision scope rendering configuration.
 *
 * Exposes two presets consumed by the post-processing pipeline:
 *   • THERMAL_PRESET — hot-white / ironbow palette, smoke penetration,
 *     gain, kelvin window, sensor-bloom susceptibility.
 *   • NV_PRESET      — phosphor green / white phosphor, gain, bloom,
 *     scintillation noise, FOV reduction.
 */

/** Thermal color palette options. */
export type ThermalPalette = "white_hot" | "black_hot" | "iron" | "red_hot";

/** Thermal scope render configuration. */
export interface ThermalPreset {
  enabled: true;
  palette: ThermalPalette;
  /** Min kelvin mapped to the palette floor (~0 °C). */
  minKelvin: number;
  /** Max kelvin mapped to the palette ceiling (~60 °C). */
  maxKelvin: number;
  /** Contrast-curve gain multiplier. */
  gain: number;
  /** Fraction of smoke attenuation applied (0 = see through fully). */
  smokeAttenuation: number;
  /** Auto-gain control sensitivity 0..1. */
  agcSensitivity: number;
}

/** Night-vision scope render configuration. */
export interface NVPreset {
  enabled: true;
  /** Phosphor color: classic green (PVS-14) or modern white phosphor. */
  phosphor: "green" | "white";
  /** Gain 0..2. */
  gain: number;
  /** Bloom radius in screen px at 1080p. */
  bloomPx: number;
  /** Scintillation noise amount 0..1. */
  noise: number;
  /** FOV reduction factor (1.0 = none; 0.7 = 30 % narrower). */
  fovReduction: number;
  /** Battery drain per second (0..1). */
  drainPerS: number;
}

// ─── Presets ─────────────────────────────────────────────────────────────────

/**
 * Default thermal scope preset. White-hot palette with a tight 0–60 °C
 * kelvin window, light smoke penetration (thermal sees through most
 * battlefield smoke), and moderate AGC.
 */
export const THERMAL_PRESET: ThermalPreset = {
  enabled: true,
  palette: "white_hot",
  minKelvin: 273,
  maxKelvin: 333,
  gain: 1.2,
  smokeAttenuation: 0.15,
  agcSensitivity: 0.6,
};

/**
 * Default night-vision preset. Classic green phosphor (PVS-14 style),
 * moderate gain, visible bloom + scintillation, 15 % FOV crop.
 */
export const NV_PRESET: NVPreset = {
  enabled: true,
  phosphor: "green",
  gain: 1.0,
  bloomPx: 3,
  noise: 0.18,
  fovReduction: 0.85,
  drainPerS: 0.004,
};

/** Map a kelvin temperature to an RGB triple under the given palette. */
export function thermalColor(tempK: number, palette: ThermalPalette): { r: number; g: number; b: number } {
  const t = Math.max(0, Math.min(1, (tempK - 273) / 60));
  switch (palette) {
    case "white_hot": return { r: t, g: t, b: t };
    case "black_hot": return { r: 1 - t, g: 1 - t, b: 1 - t };
    case "red_hot":   return { r: t, g: t * t * 0.4, b: t * t * 0.1 };
    case "iron": {
      if (t < 0.25) return { r: 0, g: 0, b: 0.5 + t };
      if (t < 0.5)  return { r: (t - 0.25) * 4, g: 0, b: 0.5 - (t - 0.25) };
      if (t < 0.75) return { r: 1, g: (t - 0.5) * 4, b: 0 };
      return { r: 1, g: 1, b: (t - 0.75) * 4 };
    }
  }
}

/** Fraction of visibility through smoke for the given optic (0..1). */
export function smokeVisibility(thermal: boolean, nv: boolean): number {
  if (thermal) return 1 - THERMAL_PRESET.smokeAttenuation;
  if (nv) return 0.55;
  return 0.05;
}
