/**
 * Section A — Photogrammetry asset pipeline (procedural PBR texture generation).
 *
 * Photogrammetry assets are typically delivered as raw photos + a high-poly
 * mesh. This module provides a procedural generator that synthesises a
 * physically-plausible PBR map set (albedo, normal, roughness, metallic, AO)
 * from a single source texture (or a solid base color). Useful for:
 *
 *   - Shipping placeholder PBR maps for assets that haven't been authored yet.
 *   - Augmenting real photogrammetry textures with the missing map channels
 *     (e.g. derive roughness from a luminance-thresholded albedo).
 *   - Generating tiling variants at runtime (avoiding texture-memory bloat).
 *
 * The generator is CPU-side (Comlink-friendly) + deterministic (hash-seeded).
 * It produces DataTextures suitable for direct upload to a material.
 *
 * Integration: the ModelRegistry pipeline calls `generatePBRSet()` per asset
 * slug + caches the result on the material registry.
 */
import * as THREE from "three";

export type SurfaceKind =
  | "metal_brushed"
  | "metal_painted"
  | "metal_bare"
  | "metal_rusty"
  | "concrete"
  | "brick"
  | "wood"
  | "plastic"
  | "rubber"
  | "fabric"
  | "stone"
  | "sand"
  | "snow"
  | "ice"
  | "skin";

export interface PhotogrammetryConfig {
  /** Surface kind — drives procedural pattern generation. */
  surfaceKind: SurfaceKind;
  /** Source texture (albedo) — if absent, the baseColor is used as a flat
   *  albedo and procedural detail is layered on top. */
  sourceTexture?: THREE.Texture | null;
  /** Base color (used as the flat albedo when sourceTexture is absent). */
  baseColor: THREE.Color;
  /** Tile resolution (square). Default 256. */
  resolution: number;
  /** Random seed (deterministic). */
  seed: number;
  /** Metallic override (0..1) — when not null, overrides the surface-kind
   *  default. */
  metallicOverride?: number;
  /** Roughness override (0..1). */
  roughnessOverride?: number;
  /** Tile the result (RepeatWrapping). Default true. */
  tile: boolean;
}

export interface PBRSet {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  roughness: THREE.DataTexture;
  metallic: THREE.DataTexture;
  ao: THREE.DataTexture;
  /** Packed descriptor (for the material registry). */
  descriptor: {
    surfaceKind: SurfaceKind;
    metallic: number;
    roughness: number;
    baseColor: THREE.Color;
  };
}

/** Default metallic/roughness per surface kind. */
export const SURFACE_KIND_DEFAULTS: Record<SurfaceKind, { metallic: number; roughness: number }> = {
  metal_brushed: { metallic: 0.95, roughness: 0.4 },
  metal_painted: { metallic: 0.7, roughness: 0.5 },
  metal_bare: { metallic: 1.0, roughness: 0.3 },
  metal_rusty: { metallic: 0.4, roughness: 0.85 },
  concrete: { metallic: 0.0, roughness: 0.9 },
  brick: { metallic: 0.0, roughness: 0.92 },
  wood: { metallic: 0.0, roughness: 0.78 },
  plastic: { metallic: 0.0, roughness: 0.45 },
  rubber: { metallic: 0.0, roughness: 0.95 },
  fabric: { metallic: 0.0, roughness: 0.85 },
  stone: { metallic: 0.0, roughness: 0.85 },
  sand: { metallic: 0.0, roughness: 1.0 },
  snow: { metallic: 0.0, roughness: 0.6 },
  ice: { metallic: 0.0, roughness: 0.05 },
  skin: { metallic: 0.0, roughness: 0.55 },
};

/** Hash-based pseudo-random number generator (deterministic, seeded). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 2D value noise (smooth interpolation between random lattice points). */
function valueNoise(rng: () => number, size: number): Float32Array {
  // Generate a small lattice + bilinearly upsample.
  const latticeSize = 16;
  const lattice = new Float32Array(latticeSize * latticeSize);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * latticeSize;
      const v = (y / size) * latticeSize;
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const x1 = (x0 + 1) % latticeSize, y1 = (y0 + 1) % latticeSize;
      const fx = u - x0, fy = v - y0;
      // Smoothstep interpolation.
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const a = lattice[y0 * latticeSize + x0];
      const b = lattice[y0 * latticeSize + x1];
      const c = lattice[y1 * latticeSize + x0];
      const d = lattice[y1 * latticeSize + x1];
      const top = a + (b - a) * sx;
      const bot = c + (d - c) * sx;
      out[y * size + x] = top + (bot - top) * sy;
    }
  }
  return out;
}

/** Fractal Brownian Motion — multi-octave value noise. */
function fbm(rng: () => number, size: number, octaves: number): Float32Array {
  const out = new Float32Array(size * size);
  let amplitude = 1.0;
  let totalAmp = 0.0;
  for (let o = 0; o < octaves; o++) {
    const noise = valueNoise(rng, size);
    for (let i = 0; i < out.length; i++) out[i] += noise[i] * amplitude;
    totalAmp += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= totalAmp;
  return out;
}

/** Generate a complete PBR set from a config. CPU-side, deterministic. */
export function generatePBRSet(config: PhotogrammetryConfig): PBRSet {
  const res = config.resolution;
  const rng = makeRng(config.seed);
  const defaults = SURFACE_KIND_DEFAULTS[config.surfaceKind];
  const metallic = config.metallicOverride ?? defaults.metallic;
  const roughness = config.roughnessOverride ?? defaults.roughness;

  // Allocate buffers.
  const albedoData = new Uint8Array(res * res * 4);
  const normalData = new Uint8Array(res * res * 4);
  const roughData = new Uint8Array(res * res * 4);
  const metalData = new Uint8Array(res * res * 4);
  const aoData = new Uint8Array(res * res * 4);

  // Generate per-surface-kind patterns.
  const baseNoise = fbm(rng, res, 4);
  const detailNoise = fbm(rng, res, 6);

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = (y * res + x) * 4;
      const n = baseNoise[y * res + x];
      const d = detailNoise[y * res + x];
      const albedo = config.baseColor.clone();
      let r = 0, g = 0, b = 0;
      let ao = 1.0;
      let rough = roughness;
      let metal = metallic;
      // Surface-kind-specific modulation.
      switch (config.surfaceKind) {
        case "concrete":
          albedo.multiplyScalar(0.85 + n * 0.3);
          rough = roughness * (0.85 + d * 0.3);
          ao = 0.7 + n * 0.3;
          break;
        case "brick":
          // Brick pattern: alternating rows of red rectangles.
          {
            const row = Math.floor(y / (res / 8));
            const col = Math.floor((x + (row % 2) * (res / 16)) / (res / 4));
            const inMortar = (y % (res / 8) < 2) || (x % (res / 4) < 2);
            if (inMortar) {
              albedo.setRGB(0.5, 0.48, 0.45);
              rough = 1.0;
              ao = 0.5;
            } else {
              albedo.setRGB(0.6 + n * 0.1, 0.25 + n * 0.05, 0.18 + n * 0.05);
              rough = 0.92 - d * 0.1;
              ao = 0.8 + n * 0.2;
            }
            void col;
          }
          break;
        case "wood":
          // Wood grain — directional high-frequency noise.
          {
            const grain = Math.sin(x * 0.3 + n * 4) * 0.5 + 0.5;
            albedo.setRGB(0.45 + grain * 0.2, 0.30 + grain * 0.15, 0.18 + grain * 0.08);
            rough = roughness * (0.9 + grain * 0.15);
            ao = 0.75 + d * 0.25;
          }
          break;
        case "metal_brushed":
        case "metal_bare":
          albedo.multiplyScalar(0.85 + d * 0.2);
          rough = roughness * (0.85 + d * 0.25);
          ao = 0.95;
          break;
        case "metal_rusty":
          // Rust = high-frequency orange noise mixed with dark patches.
          {
            const rust = d * 0.7 + n * 0.3;
            albedo.setRGB(
              0.45 + rust * 0.4,
              0.22 + rust * 0.2,
              0.10 + rust * 0.08,
            );
            rough = 0.85 - rust * 0.2;
            metal = metallic * (1 - rust);
            ao = 0.6 + d * 0.4;
          }
          break;
        case "plastic":
        case "rubber":
          albedo.multiplyScalar(0.9 + n * 0.2);
          rough = roughness * (0.9 + d * 0.2);
          ao = 0.85;
          break;
        case "stone":
          albedo.multiplyScalar(0.7 + n * 0.4);
          rough = roughness * (0.85 + d * 0.2);
          ao = 0.65 + n * 0.35;
          break;
        case "sand":
          albedo.multiplyScalar(0.85 + n * 0.2);
          rough = roughness * (0.95 + d * 0.05);
          ao = 0.85;
          break;
        case "snow":
          albedo.setRGB(0.92, 0.94, 0.98);
          rough = roughness * (0.85 + d * 0.2);
          ao = 0.8 + n * 0.2;
          break;
        case "ice":
          albedo.setRGB(0.75, 0.85, 0.95);
          rough = roughness * (0.5 + d * 0.5);
          ao = 0.9;
          break;
        case "skin":
          albedo.setRGB(0.85 + n * 0.1, 0.65 + n * 0.1, 0.55 + n * 0.08);
          rough = 0.55 + d * 0.15;
          ao = 0.9;
          break;
        default:
          albedo.multiplyScalar(0.85 + n * 0.2);
      }
      // Pack RGB.
      r = THREE.MathUtils.clamp(albedo.r, 0, 1) * 255;
      g = THREE.MathUtils.clamp(albedo.g, 0, 1) * 255;
      b = THREE.MathUtils.clamp(albedo.b, 0, 1) * 255;
      albedoData[i] = r | 0;
      albedoData[i + 1] = g | 0;
      albedoData[i + 2] = b | 0;
      albedoData[i + 3] = 255;
      // Normal map — derive from height gradient of the base noise.
      const hL = baseNoise[y * res + Math.max(0, x - 1)];
      const hR = baseNoise[y * res + Math.min(res - 1, x + 1)];
      const hD = baseNoise[Math.max(0, y - 1) * res + x];
      const hU = baseNoise[Math.min(res - 1, y + 1) * res + x];
      const dx = (hR - hL) * 0.5;
      const dy = (hU - hD) * 0.5;
      const nx = -dx * 4;
      const ny = -dy * 4;
      const nz = 1.0;
      const nLen = Math.hypot(nx, ny, nz);
      normalData[i] = ((nx / nLen) * 0.5 + 0.5) * 255 | 0;
      normalData[i + 1] = ((ny / nLen) * 0.5 + 0.5) * 255 | 0;
      normalData[i + 2] = ((nz / nLen) * 0.5 + 0.5) * 255 | 0;
      normalData[i + 3] = 255;
      // Roughness map.
      const roughVal = THREE.MathUtils.clamp(rough, 0, 1) * 255 | 0;
      roughData[i] = roughVal;
      roughData[i + 1] = roughVal;
      roughData[i + 2] = roughVal;
      roughData[i + 3] = 255;
      // Metallic map.
      const metalVal = THREE.MathUtils.clamp(metal, 0, 1) * 255 | 0;
      metalData[i] = metalVal;
      metalData[i + 1] = metalVal;
      metalData[i + 2] = metalVal;
      metalData[i + 3] = 255;
      // AO map.
      const aoVal = THREE.MathUtils.clamp(ao, 0, 1) * 255 | 0;
      aoData[i] = aoVal;
      aoData[i + 1] = aoVal;
      aoData[i + 2] = aoVal;
      aoData[i + 3] = 255;
    }
  }

  const wrap = config.tile ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  const makeTex = (data: Uint8Array) => {
    const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
    tex.wrapS = wrap;
    tex.wrapT = wrap;
    tex.needsUpdate = true;
    return tex;
  };
  return {
    albedo: makeTex(albedoData),
    normal: makeTex(normalData),
    roughness: makeTex(roughData),
    metallic: makeTex(metalData),
    ao: makeTex(aoData),
    descriptor: {
      surfaceKind: config.surfaceKind,
      metallic,
      roughness,
      baseColor: config.baseColor.clone(),
    },
  };
}

/** Apply a generated PBR set to a MeshStandardMaterial. */
export function applyPBRSet(
  material: THREE.MeshStandardMaterial,
  set: PBRSet,
  repeat = 1,
): void {
  material.map = set.albedo;
  material.normalMap = set.normal;
  material.roughnessMap = set.roughness;
  material.metalnessMap = set.metallic;
  material.aoMap = set.ao;
  material.roughness = 1.0;
  material.metalness = 1.0;
  for (const t of [set.albedo, set.normal, set.roughness, set.metallic, set.ao]) {
    t.repeat.set(repeat, repeat);
  }
  material.needsUpdate = true;
}

/** Dispose a PBR set's textures. */
export function disposePBRSet(set: PBRSet): void {
  set.albedo.dispose();
  set.normal.dispose();
  set.roughness.dispose();
  set.metallic.dispose();
  set.ao.dispose();
}
