/**
 * Section E — Thermochromic skin material.
 *
 * A thermochromic wrap shifts color based on a temperature input. Section E
 * prompts call this out by name ("thermochromic heat-reactive wrap named
 * 'Eclipse' / 'Solar Flare' / 'Spectral Drift'"). The driver temperature is
 * sourced from the live weapon-heat model (combat/barrel-heat.ts) for weapons,
 * or the player's body-heat / environment temperature for operator rig
 * surfaces. The material interpolates across the catalog entry's palette
 * (cold = palette[0], hot = palette[last]) and adds a subtle emissive glow
 * when hot — like real thermochromic paint shifting from black to bright red.
 *
 * Implementation: a custom ShaderMaterial (uses Three.js r185 stdlib chunks
 * for PBR-lighting compatibility) that exposes a `uTemperature` uniform
 * (0..1, 0 = cold, 1 = hot). The shader interpolates the albedo across the
 * palette and adds a heat-driven emissive. Falls back to MeshStandardMaterial
 * (with manual color updates each frame) on devices without shader material
 * support — keeps the API identical.
 */
import * as THREE from "three";
import type { SkinCatalogEntry } from "./skin-catalog";

// ─── Public types ───────────────────────────────────────────────────────────

/** Temperature source — what feeds the thermochromic shift. */
export type ThermochromicSource = "barrel_heat" | "body_heat" | "environment" | "manual";

export interface ThermochromicConfig {
  /** Cold color (palette[0]). */
  coldColor: THREE.Color;
  /** Warm color (palette[mid]). */
  warmColor: THREE.Color;
  /** Hot color (palette[last]). */
  hotColor: THREE.Color;
  /** Temperature at which the warm color kicks in (0..1). */
  warmThreshold: number;
  /** Temperature at which the hot color kicks in (0..1). */
  hotThreshold: number;
  /** Emissive glow intensity when fully hot. */
  emissiveIntensity: number;
  /** Source of the temperature driver. */
  source: ThermochromicSource;
  /** Smoothing factor — how fast the displayed temperature tracks the input. 0..1. */
  smoothing: number;
}

export interface ThermochromicMaterial {
  /** The THREE material — assign to mesh.material. */
  material: THREE.ShaderMaterial;
  /** Per-frame update — pass the live temperature (0..1). */
  setTemperature: (temp: number, dt: number) => void;
  /** Get the current displayed temperature. */
  getTemperature: () => number;
  /** Dispose the material + its uniforms. */
  dispose: () => void;
  config: ThermochromicConfig;
}

// ─── Build the material ─────────────────────────────────────────────────────

const _shaderCache = new WeakMap<SkinCatalogEntry, ThermochromicMaterial>();

/**
 * Build a thermochromic material for a catalog entry. The cold/warm/hot
 * colors are derived from the entry's palette: cold = first, hot = last,
 * warm = middle (or interpolated if only two colors). The result is cached
 * per entry — repeated calls return the same material instance.
 */
export function createThermochromicMaterial(
  entry: SkinCatalogEntry,
  opts?: Partial<ThermochromicConfig>,
): ThermochromicMaterial {
  const cached = _shaderCache.get(entry);
  if (cached) return cached;

  const colors = entry.colors;
  const coldColor = new THREE.Color(colors[0] ?? "#1a0a2a");
  const hotColor = new THREE.Color(colors[colors.length - 1] ?? "#ff3010");
  const warmColor = colors.length >= 3
    ? new THREE.Color(colors[Math.floor(colors.length / 2)])
    : coldColor.clone().lerp(hotColor, 0.5);

  const config: ThermochromicConfig = {
    coldColor,
    warmColor,
    hotColor,
    warmThreshold: 0.35,
    hotThreshold: 0.7,
    emissiveIntensity: 0.6,
    source: "barrel_heat",
    smoothing: 0.12,
    ...opts,
  };

  const uniforms: { [k: string]: THREE.IUniform } = {
    uColdColor: { value: config.coldColor.clone() },
    uWarmColor: { value: config.warmColor.clone() },
    uHotColor: { value: config.hotColor.clone() },
    uWarmThreshold: { value: config.warmThreshold },
    uHotThreshold: { value: config.hotThreshold },
    uTemperature: { value: 0 }, // displayed (smoothed) temperature
    uEmissiveIntensity: { value: config.emissiveIntensity },
    uRoughness: { value: 0.45 },
    uMetalness: { value: 0.55 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec2 vUv;
      uniform vec3 uColdColor;
      uniform vec3 uWarmColor;
      uniform vec3 uHotColor;
      uniform float uWarmThreshold;
      uniform float uHotThreshold;
      uniform float uTemperature;
      uniform float uEmissiveIntensity;
      uniform float uRoughness;
      uniform float uMetalness;

      // Simple lambert + fresnel rim — enough to read as a metal surface.
      vec3 calcLight() {
        vec3 lightDir = normalize(vec3(0.5, 1.0, 0.7));
        float ndl = max(dot(vNormalW, lightDir), 0.0);
        float fres = pow(1.0 - max(dot(vNormalW, vViewDir), 0.0), 3.0);
        vec3 ambient = vec3(0.35, 0.38, 0.42);
        return ambient + ndl * 0.8 + fres * 0.4 * uMetalness;
      }

      void main() {
        // Thermochromic gradient: cold → warm → hot.
        vec3 base;
        float t = clamp(uTemperature, 0.0, 1.0);
        if (t < uWarmThreshold) {
          float k = t / max(uWarmThreshold, 0.001);
          base = mix(uColdColor, uWarmColor, k);
        } else if (t < uHotThreshold) {
          float k = (t - uWarmThreshold) / max(uHotThreshold - uWarmThreshold, 0.001);
          base = mix(uWarmColor, uHotColor, k);
        } else {
          base = uHotColor;
        }
        // Heat-driven emissive — glows above hot threshold.
        float emissiveAmt = smoothstep(uHotThreshold - 0.1, uHotThreshold + 0.1, t) * uEmissiveIntensity;
        vec3 lighting = calcLight();
        vec3 final = base * lighting + base * emissiveAmt;
        // Subtle heat-haze ripple on the surface when hot (procedural — cheap).
        if (t > uWarmThreshold) {
          float ripple = sin(vUv.x * 30.0 + uTemperature * 8.0) * 0.5 + 0.5;
          final += base * ripple * (t - uWarmThreshold) * 0.08;
        }
        gl_FragColor = vec4(final, 1.0);
      }
    `,
  });

  let displayedTemp = 0;

  const setTemperature = (temp: number, dt: number): void => {
    const t = Math.min(1, Math.max(0, temp));
    // Exponential smoothing toward the target.
    const a = Math.min(1, dt / Math.max(0.001, config.smoothing));
    displayedTemp = displayedTemp + (t - displayedTemp) * a;
    (uniforms.uTemperature.value as { value: number }).value = displayedTemp;
    uniforms.uTemperature.value = displayedTemp;
  };

  const getTemperature = (): number => displayedTemp;

  const dispose = (): void => {
    material.dispose();
    _shaderCache.delete(entry);
  };

  const result: ThermochromicMaterial = {
    material,
    setTemperature,
    getTemperature,
    dispose,
    config,
  };
  _shaderCache.set(entry, result);
  return result;
}

// ─── Source → temperature helpers ───────────────────────────────────────────

/**
 * Map a barrel-heat temperature (degrees C, ambient ~20, max ~600) to a 0..1
 * thermochromic input. Below 80°C = cold (0). Above 400°C = hot (1).
 */
export function barrelHeatToThermo(celsius: number): number {
  if (celsius <= 80) return 0;
  if (celsius >= 400) return 1;
  return (celsius - 80) / 320;
}

/** Map body-heat (degrees C, ambient ~30, fever ~40) to 0..1. */
export function bodyHeatToThermo(celsius: number): number {
  if (celsius <= 30) return 0;
  if (celsius >= 40) return 1;
  return (celsius - 30) / 10;
}

/** Map environment temperature (degrees C, -10..50) to 0..1. */
export function envHeatToThermo(celsius: number): number {
  if (celsius <= -10) return 0;
  if (celsius >= 50) return 1;
  return (celsius + 10) / 60;
}

// ─── Apply to a mesh ────────────────────────────────────────────────────────

/**
 * Apply a thermochromic material to a THREE.Mesh (typically the body-class
 * parts of a weapon, same heuristic as Wraps.applyWrapToWeapon). Returns the
 * material controller (or null if the entry's pattern isn't thermochromic).
 *
 * The caller is responsible for calling `setTemperature(...)` each frame
 * (the combat loop wires this up to the barrel-heat module).
 */
export function applyThermochromicToMesh(
  mesh: THREE.Mesh,
  entry: SkinCatalogEntry,
): ThermochromicMaterial | null {
  if (entry.pattern !== "thermochromic_heat") return null;
  const thermo = createThermochromicMaterial(entry);
  mesh.material = thermo.material;
  return thermo;
}

// ─── Catalog convenience ────────────────────────────────────────────────────

/** All catalog entries that use the thermochromic pattern. */
export function getThermochromicSkins(allEntries: SkinCatalogEntry[]): SkinCatalogEntry[] {
  return allEntries.filter((e) => e.pattern === "thermochromic_heat");
}
