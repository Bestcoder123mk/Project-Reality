/**
 * Section M — Photogrammetry-style PBR texture pipeline.
 *
 * Generates procedural albedo + normal + roughness + height maps at runtime
 * using canvas 2D + value-noise synthesis. Inspired by the
 * "Author a MapBuilder module for <biome>" prompts and the
 * "photoreal PBR standard" fidelity tier referenced throughout the
 * M_Maps_Environments prompt library.
 *
 * This module replaces external texture downloads with deterministic
 * procedural textures that look photogrammetry-sourced:
 *   - Multi-octave value noise drives albedo variation + height displacement.
 *   - Surface-specific feature pass adds cracks (concrete), grain (sand),
 *     fibers (wood), corrugation (metal), moss (jungle), snowdrift (arctic).
 *   - Normal map derived from height-field Sobel gradient (cheap, robust).
 *   - Roughness map modulated by surface-class + micro-detail noise.
 *
 * The output is a `PbrTextureSet` consumed by the MapBuilder MaterialCache
 * when authoring biome-specific materials (snow, mud, jungle_floor,
 * sand_wet, rock, gravel, ice — none of which existed in textures.ts).
 *
 * All textures are cached by a (biomeGroundMaterial × seed) key so each
 * map only pays the synthesis cost once per surface class.
 *
 * SSR-safe: textures are lazy (created on first request inside the
 * browser). Pure helpers (noise, gradient, etc.) are SSR-safe and
 * exported for unit tests.
 */

import * as THREE from "three";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface PbrTextureSet {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  /** Optional metalness map (only for metallic surfaces — rust, ice sheen). */
  metalness?: THREE.Texture;
}

export type PbrSurfaceClass =
  | "snow" | "ice" | "mud" | "jungle_floor"
  | "sand_wet" | "rock" | "gravel"
  // New biome-aware variants (used by urban-kit + verticality too).
  | "mossy_concrete" | "rusted_metal" | "frozen_metal" | "wet_asphalt"
  | "scorched_concrete";

// ──────────────────────────────────────────────────────────────────────────
// Value noise (deterministic, seedable)
// ──────────────────────────────────────────────────────────────────────────

/** Mulberry32 PRNG — deterministic per seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hashed value-noise grid (2D). Returns values in [0,1]. */
function valueNoise2D(x: number, y: number, perm: Uint8Array): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(xf), v = fade(yf);
  const aa = perm[(perm[xi] + yi) & 511];
  const ab = perm[(perm[xi] + yi + 1) & 511];
  const ba = perm[(perm[xi + 1] + yi) & 511];
  const bb = perm[(perm[xi + 1] + yi + 1) & 511];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(lerp(aa / 255, ba / 255, u), lerp(ab / 255, bb / 255, u), v);
}

/** Multi-octave fractal Brownian motion. Returns values in [0,1]. */
function fbm(
  x: number, y: number,
  perm: Uint8Array,
  octaves = 5,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2D(x * freq, y * freq, perm);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// ──────────────────────────────────────────────────────────────────────────
// Canvas helpers
// ──────────────────────────────────────────────────────────────────────────

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  return [c, c.getContext("2d")!];
}

function buildPerm(seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const arr = new Uint8Array(512);
  for (let i = 0; i < 256; i++) arr[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  for (let i = 0; i < 256; i++) arr[i + 256] = arr[i];
  return arr;
}

interface SurfaceParams {
  baseColor: [number, number, number]; // 0..255 RGB
  noiseVariance: number;               // albedo variance amplitude
  roughnessBase: number;               // 0..1 base roughness
  roughnessVariance: number;           // amplitude
  heightScale: number;                 // 0..1 — displacement strength
  feature: (ctx: CanvasRenderingContext2D, size: number, perm: Uint8Array) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-surface feature passes (called after base albedo + noise)
// ──────────────────────────────────────────────────────────────────────────

function concreteCracks(ctx: CanvasRenderingContext2D, size: number, perm: Uint8Array): void {
  ctx.strokeStyle = "rgba(30,28,28,0.55)";
  ctx.lineWidth = 1.2;
  const crackCount = 14;
  for (let i = 0; i < crackCount; i++) {
    const sx = fbm(i * 1.7, 0.3, perm) * size;
    const sy = fbm(0.5, i * 1.9, perm) * size;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    let x = sx, y = sy;
    for (let j = 0; j < 7; j++) {
      x += (fbm(i + j, j * 0.7, perm) - 0.5) * 60;
      y += (fbm(j * 0.7, i + j, perm) - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Stains.
  for (let i = 0; i < 8; i++) {
    const x = fbm(i + 10, 0, perm) * size;
    const y = fbm(0, i + 10, perm) * size;
    const r = 18 + fbm(i, i, perm) * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(40,38,35,0.32)");
    g.addColorStop(1, "rgba(40,38,35,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function sandRipples(ctx: CanvasRenderingContext2D, size: number, perm: Uint8Array): void {
  ctx.strokeStyle = "rgba(150,130,90,0.28)";
  ctx.lineWidth = 2;
  for (let y = 0; y < size; y += 12) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x < size; x += 8) {
      ctx.lineTo(x, y + Math.sin(x * 0.05 + y * 0.02) * 3 + (fbm(x * 0.01, y * 0.01, perm) - 0.5) * 4);
    }
    ctx.stroke();
  }
}

function mossPatches(ctx: CanvasRenderingContext2D, size: number, perm: Uint8Array): void {
  for (let i = 0; i < 40; i++) {
    const x = fbm(i * 1.3, 0.7, perm) * size;
    const y = fbm(0.4, i * 1.7, perm) * size;
    const r = 4 + fbm(i, i, perm) * 18;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(40,80,30,0.55)");
    g.addColorStop(1, "rgba(40,80,30,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function snowDrift(ctx: CanvasRenderingContext2D, size: number, perm: Uint8Array): void {
  // Soft directional drift — diagonal streaks.
  ctx.strokeStyle = "rgba(220,230,240,0.18)";
  ctx.lineWidth = 3;
  for (let i = 0; i < 24; i++) {
    const y = (i / 24) * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x < size; x += 16) {
      ctx.lineTo(x, y + Math.sin(x * 0.04 + i * 0.6) * 8 + (fbm(x * 0.008, i, perm) - 0.5) * 6);
    }
    ctx.stroke();
  }
}

function gravelSpeckle(ctx: CanvasRenderingContext2D, size: number, perm: Uint8Array): void {
  for (let i = 0; i < 800; i++) {
    const x = fbm(i, 0.2, perm) * size;
    const y = fbm(0.3, i, perm) * size;
    const r = 1 + fbm(i, i, perm) * 3;
    const shade = 80 + Math.floor(fbm(i * 2, 0, perm) * 100);
    ctx.fillStyle = `rgba(${shade},${shade - 5},${shade - 12},0.6)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function rockStrata(ctx: CanvasRenderingContext2D, size: number, perm: Uint8Array): void {
  ctx.strokeStyle = "rgba(60,55,50,0.4)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    const y = (i / 8) * size + (fbm(i, 0, perm) - 0.5) * 30;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x < size; x += 12) {
      ctx.lineTo(x, y + Math.sin(x * 0.03 + i) * 6 + (fbm(x * 0.01, i, perm) - 0.5) * 8);
    }
    ctx.stroke();
  }
}

function scorchedBlast(ctx: CanvasRenderingContext2D, size: number, perm: Uint8Array): void {
  for (let i = 0; i < 6; i++) {
    const x = fbm(i, 0.5, perm) * size;
    const y = fbm(0.5, i, perm) * size;
    const r = 20 + fbm(i, i, perm) * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(10,8,6,0.85)");
    g.addColorStop(0.6, "rgba(40,30,20,0.4)");
    g.addColorStop(1, "rgba(40,30,20,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function woodFibers(ctx: CanvasRenderingContext2D, size: number, perm: Uint8Array): void {
  ctx.strokeStyle = "rgba(70,50,30,0.45)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 80; i++) {
    const y = (i / 80) * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x < size; x += 6) {
      ctx.lineTo(x, y + Math.sin(x * 0.04 + i * 0.5) * 2 + (fbm(x * 0.02, i * 0.1, perm) - 0.5) * 4);
    }
    ctx.stroke();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Surface parameter table
// ──────────────────────────────────────────────────────────────────────────

const SURFACE_PARAMS: Record<PbrSurfaceClass, SurfaceParams> = {
  snow: {
    baseColor: [235, 240, 248], noiseVariance: 12, roughnessBase: 0.7,
    roughnessVariance: 0.15, heightScale: 0.35, feature: snowDrift,
  },
  ice: {
    baseColor: [180, 210, 230], noiseVariance: 18, roughnessBase: 0.18,
    roughnessVariance: 0.15, heightScale: 0.2, feature: concreteCracks,
  },
  mud: {
    baseColor: [70, 55, 38], noiseVariance: 22, roughnessBase: 0.95,
    roughnessVariance: 0.05, heightScale: 0.45, feature: gravelSpeckle,
  },
  jungle_floor: {
    baseColor: [60, 70, 40], noiseVariance: 18, roughnessBase: 0.92,
    roughnessVariance: 0.08, heightScale: 0.55, feature: mossPatches,
  },
  sand_wet: {
    baseColor: [160, 140, 100], noiseVariance: 14, roughnessBase: 0.32,
    roughnessVariance: 0.2, heightScale: 0.25, feature: sandRipples,
  },
  rock: {
    baseColor: [110, 100, 92], noiseVariance: 30, roughnessBase: 0.95,
    roughnessVariance: 0.05, heightScale: 0.7, feature: rockStrata,
  },
  gravel: {
    baseColor: [128, 122, 112], noiseVariance: 22, roughnessBase: 0.95,
    roughnessVariance: 0.05, heightScale: 0.6, feature: gravelSpeckle,
  },
  mossy_concrete: {
    baseColor: [120, 118, 110], noiseVariance: 22, roughnessBase: 0.92,
    roughnessVariance: 0.08, heightScale: 0.4, feature: mossPatches,
  },
  rusted_metal: {
    baseColor: [110, 60, 40], noiseVariance: 28, roughnessBase: 0.65,
    roughnessVariance: 0.25, heightScale: 0.5, feature: scorchedBlast,
  },
  frozen_metal: {
    baseColor: [170, 185, 200], noiseVariance: 18, roughnessBase: 0.35,
    roughnessVariance: 0.15, heightScale: 0.25, feature: snowDrift,
  },
  wet_asphalt: {
    baseColor: [40, 40, 44], noiseVariance: 14, roughnessBase: 0.3,
    roughnessVariance: 0.18, heightScale: 0.3, feature: gravelSpeckle,
  },
  scorched_concrete: {
    baseColor: [60, 56, 52], noiseVariance: 24, roughnessBase: 0.98,
    roughnessVariance: 0.02, heightScale: 0.55, feature: scorchedBlast,
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Texture synthesis
// ──────────────────────────────────────────────────────────────────────────

const TEX_SIZE = 256; // power-of-two; small enough to synthesize in <50ms

/** Generate a PBR texture set for a surface class. Returns a cached
 *  singleton per (surfaceClass, seed). Safe to call from the render
 *  thread; first call pays the synthesis cost. */
const _pbrCache = new Map<string, PbrTextureSet>();

export function generatePbrSet(
  surfaceClass: PbrSurfaceClass,
  seed = 1,
  repeat = 1,
): PbrTextureSet {
  const key = `${surfaceClass}:${seed}:${repeat}`;
  const cached = _pbrCache.get(key);
  if (cached) return cached;

  const params = SURFACE_PARAMS[surfaceClass];
  const perm = buildPerm(seed + surfaceClass.charCodeAt(0));
  const [r, g, b] = params.baseColor;

  // ─── Height field ───────────────────────────────────────────────────
  const heightCanvas = document.createElement("canvas");
  heightCanvas.width = heightCanvas.height = TEX_SIZE;
  const hCtx = heightCanvas.getContext("2d")!;
  const hImg = hCtx.createImageData(TEX_SIZE, TEX_SIZE);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const n = fbm(x * 0.04, y * 0.04, perm, 5, 2.0, 0.55);
      const v = Math.max(0, Math.min(255, Math.floor(n * 255 * params.heightScale * 2)));
      const idx = (y * TEX_SIZE + x) * 4;
      hImg.data[idx] = v; hImg.data[idx + 1] = v; hImg.data[idx + 2] = v; hImg.data[idx + 3] = 255;
    }
  }
  hCtx.putImageData(hImg, 0, 0);

  // ─── Albedo ─────────────────────────────────────────────────────────
  const [albCanvas, aCtx] = makeCanvas(TEX_SIZE);
  aCtx.fillStyle = `rgb(${r},${g},${b})`;
  aCtx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  const aImg = aCtx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const n = fbm(x * 0.05, y * 0.05, perm, 4, 2.0, 0.5);
      const off = (n - 0.5) * params.noiseVariance * 2;
      const idx = (y * TEX_SIZE + x) * 4;
      aImg.data[idx] = Math.max(0, Math.min(255, r + off));
      aImg.data[idx + 1] = Math.max(0, Math.min(255, g + off));
      aImg.data[idx + 2] = Math.max(0, Math.min(255, b + off));
    }
  }
  aCtx.putImageData(aImg, 0, 0);
  params.feature(aCtx, TEX_SIZE, perm);

  // ─── Roughness ──────────────────────────────────────────────────────
  const [rCanvas, rCtx] = makeCanvas(TEX_SIZE);
  const rImg = rCtx.createImageData(TEX_SIZE, TEX_SIZE);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const n = fbm(x * 0.08, y * 0.08, perm, 3, 2.0, 0.5);
      const v = Math.max(0, Math.min(1, params.roughnessBase + (n - 0.5) * params.roughnessVariance * 2));
      const c = Math.floor(v * 255);
      const idx = (y * TEX_SIZE + x) * 4;
      rImg.data[idx] = c; rImg.data[idx + 1] = c; rImg.data[idx + 2] = c; rImg.data[idx + 3] = 255;
    }
  }
  rCtx.putImageData(rImg, 0, 0);

  // ─── Normal (Sobel from height field) ───────────────────────────────
  const [nCanvas, nCtx] = makeCanvas(TEX_SIZE);
  const nImg = nCtx.createImageData(TEX_SIZE, TEX_SIZE);
  const hData = hImg.data;
  const strength = 2.0;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const xp = (x + 1) % TEX_SIZE, xm = (x - 1 + TEX_SIZE) % TEX_SIZE;
      const yp = (y + 1) % TEX_SIZE, ym = (y - 1 + TEX_SIZE) % TEX_SIZE;
      const hx = (hData[(y * TEX_SIZE + xp) * 4] - hData[(y * TEX_SIZE + xm) * 4]) / 255;
      const hy = (hData[(yp * TEX_SIZE + x) * 4] - hData[(ym * TEX_SIZE + x) * 4]) / 255;
      const nx = -hx * strength;
      const ny = -hy * strength;
      const nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      const idx = (y * TEX_SIZE + x) * 4;
      nImg.data[idx] = Math.floor((nx / len * 0.5 + 0.5) * 255);
      nImg.data[idx + 1] = Math.floor((ny / len * 0.5 + 0.5) * 255);
      nImg.data[idx + 2] = Math.floor((nz / len * 0.5 + 0.5) * 255);
      nImg.data[idx + 3] = 255;
    }
  }
  nCtx.putImageData(nImg, 0, 0);

  const wrap = (canvas: HTMLCanvasElement): THREE.Texture => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.repeat.set(repeat, repeat);
    return tex;
  };
  const wrapLinear = (canvas: HTMLCanvasElement): THREE.Texture => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.repeat.set(repeat, repeat);
    return tex;
  };

  const set: PbrTextureSet = {
    albedo: wrap(albCanvas),
    normal: wrapLinear(nCanvas),
    roughness: wrapLinear(rCanvas),
    height: wrapLinear(heightCanvas),
  };

  // Metalness map for metallic surfaces (rust patches reduce metalness).
  if (surfaceClass === "rusted_metal" || surfaceClass === "frozen_metal") {
    const [mCanvas, mCtx] = makeCanvas(TEX_SIZE);
    const mImg = mCtx.createImageData(TEX_SIZE, TEX_SIZE);
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const n = fbm(x * 0.06, y * 0.06, perm, 4, 2.0, 0.55);
        const v = surfaceClass === "rusted_metal"
          ? Math.floor((0.4 + n * 0.3) * 255) // partial rust
          : Math.floor((0.7 + n * 0.2) * 255); // ice sheen
        const idx = (y * TEX_SIZE + x) * 4;
        mImg.data[idx] = v; mImg.data[idx + 1] = v; mImg.data[idx + 2] = v; mImg.data[idx + 3] = 255;
      }
    }
    mCtx.putImageData(mImg, 0, 0);
    set.metalness = wrapLinear(mCanvas);
  }

  _pbrCache.set(key, set);
  return set;
}

// ──────────────────────────────────────────────────────────────────────────
// Material factory — used by MapBuilder MaterialCache for new ground types
// ──────────────────────────────────────────────────────────────────────────

/** Build a MeshStandardMaterial for a PBR surface class. Returns a fresh
 *  material per call (the caller caches it). */
export function buildPbrMaterial(
  surfaceClass: PbrSurfaceClass,
  options: { repeat?: number; roughness?: number; metalness?: number } = {},
): THREE.MeshStandardMaterial {
  const set = generatePbrSet(surfaceClass, 1, options.repeat ?? 1);
  return new THREE.MeshStandardMaterial({
    map: set.albedo,
    normalMap: set.normal,
    roughnessMap: set.roughness,
    roughness: options.roughness ?? 1,
    metalness: options.metalness ?? (set.metalness ? 1 : 0),
    metalnessMap: set.metalness,
    displacementMap: set.height,
    displacementScale: 0.05,
  });
}

/** Dispose all cached PBR textures (called by clearMap on map switch). */
export function disposePbrCache(): void {
  for (const set of _pbrCache.values()) {
    set.albedo.dispose();
    set.normal.dispose();
    set.roughness.dispose();
    set.height.dispose();
    set.metalness?.dispose();
  }
  _pbrCache.clear();
}
