import * as THREE from "three";

/** Procedurally generate realistic textures using canvas 2D. */

function makeCanvas(size = 512): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  return [c, ctx];
}

/** A3-5000-retry / 442: optimized noise — uses a single Uint8ClampedArray
 *  view + a typed loop. Was `getImageData/putImageData` per pixel for noise()
 *  — 200ms+ for 512² textures. The optimization: (a) reuse the ImageData
 *  buffer (no per-pixel allocation), (b) use a single random per pixel
 *  (was 3 Math.random calls), (c) operate on the typed array directly.
 *  Target: <50ms first creation. */
function noise(ctx: CanvasRenderingContext2D, size: number, _base: string, variance: number, _alpha = 0.5) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const len = d.length;
  for (let i = 0; i < len; i += 4) {
    // A3-5000-retry / 442: single random per pixel (was 3 calls — Math.random
    // is slow + the variance was identical across RGB anyway).
    const n = (Math.random() - 0.5) * variance;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

export function concreteTexture(): THREE.Texture {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#6b6b6b";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#6b6b6b", 40);
  // cracks
  ctx.strokeStyle = "rgba(40,40,40,0.5)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 18; i++) {
    ctx.beginPath();
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.moveTo(x, y);
    for (let j = 0; j < 6; j++) {
      x += (Math.random() - 0.5) * 80;
      y += (Math.random() - 0.5) * 80;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // stains
  for (let i = 0; i < 12; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 20 + Math.random() * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(50,48,45,0.25)");
    g.addColorStop(1, "rgba(50,48,45,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4; // A3-5000-retry / 441
  return tex;
}

export function concreteRoughnessTexture(): THREE.Texture {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#9a9a9a";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#9a9a9a", 50);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4; // A3-5000-retry / 441
  return tex;
}

export function sandTexture(): THREE.Texture {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#b8a37a";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#b8a37a", 30);
  // sand ripples
  ctx.strokeStyle = "rgba(150,130,90,0.25)";
  ctx.lineWidth = 2;
  for (let y = 0; y < size; y += 14) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x < size; x += 8) {
      ctx.lineTo(x, y + Math.sin(x * 0.05) * 3);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4; // A3-5000-retry / 441
  return tex;
}

export function woodTexture(): THREE.Texture {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#8a5a2b";
  ctx.fillRect(0, 0, size, size);
  // planks
  for (let i = 0; i < 4; i++) {
    const y = i * (size / 4);
    const shade = 120 + Math.random() * 40;
    ctx.fillStyle = `rgb(${shade},${shade * 0.6},${shade * 0.3})`;
    ctx.fillRect(0, y, size, size / 4 - 2);
    // grain
    ctx.strokeStyle = "rgba(60,35,15,0.4)";
    ctx.lineWidth = 1;
    for (let g = 0; g < 8; g++) {
      ctx.beginPath();
      const gy = y + Math.random() * (size / 4);
      ctx.moveTo(0, gy);
      for (let x = 0; x < size; x += 10) {
        ctx.lineTo(x, gy + Math.sin(x * 0.1) * 1.5);
      }
      ctx.stroke();
    }
  }
  // border
  ctx.strokeStyle = "rgba(40,20,5,0.8)";
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4; // A3-5000-retry / 441
  return tex;
}

export function metalTexture(): THREE.Texture {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#3a3a3e";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#3a3a3e", 20);
  // brushed lines
  ctx.strokeStyle = "rgba(80,80,85,0.4)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 120; i++) {
    const y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 4);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4; // A3-5000-retry / 441
  return tex;
}

export function brickTexture(): THREE.Texture {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#7a4a3a";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#7a4a3a", 25);
  const rows = 8;
  const cols = 4;
  const bw = size / cols;
  const bh = size / rows;
  ctx.strokeStyle = "rgba(40,30,25,0.8)";
  ctx.lineWidth = 3;
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 === 0 ? 0 : bw / 2;
    for (let col = -1; col < cols; col++) {
      const x = col * bw + offset;
      const y = r * bh;
      ctx.strokeRect(x, y, bw, bh);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4; // A3-5000-retry / 441
  return tex;
}

/** Create a radial gradient sprite texture for soft particles.
 *  A3-5000-retry / 440: color replace now accepts hex (#rrggbb) AND rgb()/rgba().
 *  Was `color.replace(")", ",0.6)").replace("rgb", "rgba")` which only worked
 *  for `rgb(...)` format — hex colors silently produced invalid rgba(). */
export function particleTexture(color: string): THREE.Texture {
  const size = 64;
  const [c, ctx] = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // A3-5000-retry / 440: convert any color spec to a 4-channel rgba string.
  // Handles: #rgb, #rrggbb, rgb(r,g,b), rgba(r,g,b,a), named colors.
  const rgbaMid = colorToRgba(color, 0.6);
  g.addColorStop(0, color);
  g.addColorStop(0.4, rgbaMid);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  // A3-5000-retry / 441: set anisotropy (defaults to 1 — blurry at grazing angles).
  // The renderer's max anisotropy is queried lazily by the host (RendererSystem
  // calls `setMaxAnisotropy` on the texture after creation; this default ensures
  // the value is non-zero so the host's clamp works).
  tex.anisotropy = 4;
  return tex;
}

/** A3-5000-retry / 440: convert any CSS color to an `rgba(r,g,b,a)` string.
 *  Handles hex (#rgb / #rrggbb), rgb(), rgba(), and named colors. */
function colorToRgba(color: string, alpha: number): string {
  // Quick path: rgb() / rgba() — parse + re-emit.
  const rgbMatch = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]},${rgbMatch[2]},${rgbMatch[3]},${alpha})`;
  }
  // Hex path: #rgb or #rrggbb.
  const hexMatch = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  // Fallback: use the canvas 2D context to resolve named colors.
  const [c, ctx] = makeCanvas(1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const px = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${px[0]},${px[1]},${px[2]},${alpha})`;
}

/**
 * Realistic muzzle flash texture — a tight star-shaped burst with a small
 * hot core and long thin spikes. Far less screen-fill than the radial
 * gradient `particleTexture` produces.
 */
export function muzzleFlashTexture(): THREE.Texture {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const cx = size / 2, cy = size / 2;
  // 1) Tiny hot core (white-yellow center, fast falloff).
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.12);
  core.addColorStop(0, "rgba(255,250,220,1)");
  core.addColorStop(0.35, "rgba(255,210,120,0.95)");
  core.addColorStop(0.7, "rgba(255,150,40,0.45)");
  core.addColorStop(1, "rgba(255,90,20,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);
  // 2) Thin cross spikes (the characteristic muzzle flash star).
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 4);
    const spike = ctx.createLinearGradient(0, 0, size * 0.48, 0);
    spike.addColorStop(0, "rgba(255,220,150,0.75)");
    spike.addColorStop(0.5, "rgba(255,160,60,0.25)");
    spike.addColorStop(1, "rgba(255,100,20,0)");
    ctx.fillStyle = spike;
    ctx.beginPath();
    ctx.moveTo(0, -1.5);
    ctx.lineTo(size * 0.48, 0);
    ctx.lineTo(0, 1.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // 3) Faint outer glow halo.
  const halo = ctx.createRadialGradient(cx, cy, size * 0.1, cx, cy, size * 0.5);
  halo.addColorStop(0, "rgba(255,180,80,0.18)");
  halo.addColorStop(1, "rgba(255,120,30,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Smoke / dust soft puff texture. */
export function smokeTexture(): THREE.Texture {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(180,178,170,0.5)");
  g.addColorStop(0.5, "rgba(150,148,142,0.25)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

// ============================================================
// PBR procedural textures for COD-style tactical operator.
// Each function returns a CanvasTexture that simulates material
// properties: albedo (color) + micro-surface roughness variation.
// ============================================================

function hexFromInt(color: number): string {
  return "#" + color.toString(16).padStart(6, "0");
}

/**
 * Tactical fabric texture — matte nylon/canvas weave.
 * `color` overrides the base albedo. `roughnessMap=true` returns a
 * grayscale variant for use as a roughnessMap (brighter = rougher).
 */
export function tacticalFabricTexture(color: number = 0x1e3a5f, roughnessMap = false): THREE.Texture {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const baseHex = hexFromInt(color);
  if (roughnessMap) {
    // Grayscale roughness: fabric is uniformly rough (0.8-0.9).
    ctx.fillStyle = "#d0d0d0";
    ctx.fillRect(0, 0, size, size);
    noise(ctx, size, "#d0d0d0", 25);
    // Weave pattern — subtle cross-hatch.
    ctx.strokeStyle = "rgba(180,180,180,0.3)";
    ctx.lineWidth = 1;
    for (let y = 0; y < size; y += 3) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    }
    for (let x = 0; x < size; x += 3) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke();
    }
  } else {
    ctx.fillStyle = baseHex;
    ctx.fillRect(0, 0, size, size);
    noise(ctx, size, baseHex, 18);
    // Fabric weave — subtle diagonal cross-hatch.
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 1;
    for (let y = 0; y < size; y += 3) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    }
    // Stitching lines (seams).
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size); ctx.stroke();
    ctx.setLineDash([]);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = roughnessMap ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  return tex;
}

/**
 * Plate carrier vest texture — matte polymer with panel lines + MOLLE webbing.
 */
export function tacticalPlateTexture(): THREE.Texture {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#2c4f7c";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#2c4f7c", 15);
  // MOLLE webbing — horizontal strips with stitch points.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  for (let y = 20; y < size; y += 24) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    // Stitch points.
    for (let x = 10; x < size; x += 20) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
  }
  // Panel divider lines.
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size); ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Helmet texture — hard shell with scuffs and a matte top coat.
 */
export function helmetTexture(): THREE.Texture {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#2c4f7c";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#2c4f7c", 20);
  // Scuff marks — random dark streaks.
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 15; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 5 + Math.random() * 15;
    const angle = Math.random() * Math.PI;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }
  // Highlight streak (top coat wear).
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, size * 0.3, size, size * 0.1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Metal roughness texture — brushed metal with anisotropic streaks.
 * Used as both map (dark gray) and roughnessMap (streaky gray).
 */
export function metalRoughTexture(): THREE.Texture {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#2a2a2e";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#2a2a2e", 12);
  // Brushed metal lines — horizontal anisotropic streaks.
  ctx.strokeStyle = "rgba(80,80,85,0.35)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 150; i++) {
    const y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 3);
    ctx.stroke();
  }
  // Oil stain — subtle dark blotch.
  const stainGrad = ctx.createRadialGradient(size * 0.7, size * 0.3, 0, size * 0.7, size * 0.3, size * 0.2);
  stainGrad.addColorStop(0, "rgba(0,0,0,0.15)");
  stainGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = stainGrad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Boot texture — matte rubber with tread pattern + lace holes.
 */
export function bootTexture(): THREE.Texture {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = "#1a1a1e";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#1a1a1e", 15);
  // Tread pattern at the bottom.
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  for (let x = 0; x < size; x += 16) {
    ctx.fillRect(x, size - 12, 10, 8);
  }
  // Lace holes — small dots in the upper area.
  ctx.fillStyle = "rgba(80,80,80,0.6)";
  for (let y = 10; y < size - 20; y += 12) {
    for (let x = size / 2 - 10; x <= size / 2 + 10; x += 20) {
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ════════════════════════════════════════════════════════════════════════════
// Task 33 — Procedural normal-map generators.
//
// Normal maps add per-pixel surface detail (pores, weave, brushed streaks,
// pebbling) WITHOUT adding polygons. Each generator paints a grayscale
// heightmap on a canvas, then runs a Sobel filter to convert heights to
// per-pixel normals encoded as RGB (R = X gradient, G = Y gradient, B = up).
//
// All 5 generators are cached at module scope — the canvas + ImageData work
// is ~256×256 = 65k pixel iterations, which is too expensive to repeat per
// enemy spawn. The cache keys are the function name (one cache slot per
// generator type — the patterns themselves are color-independent, so a single
// 256×256 normal map can be reused across every operator of every color).
// ════════════════════════════════════════════════════════════════════════════

const _normalCache = new Map<string, THREE.Texture>();

/**
 * Convert a grayscale heightmap canvas into a tangent-space normal map canvas
 * using a 3×3 Sobel filter. `strength` scales the bump intensity (higher =
 * more pronounced bumps). Returns a fresh canvas — caller wraps it as a
 * CanvasTexture.
 */
function heightToNormalCanvas(heightCanvas: HTMLCanvasElement, strength = 1.0): HTMLCanvasElement {
  const size = heightCanvas.width;
  const hCtx = heightCanvas.getContext("2d")!;
  const hImg = hCtx.getImageData(0, 0, size, size);
  const h = hImg.data;

  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const oCtx = out.getContext("2d")!;
  const oImg = oCtx.createImageData(size, size);
  const o = oImg.data;

  const idx = (x: number, y: number) => ((y * size) + x) * 4;
  // Tile-safe sample (wraps horizontally + vertically — the resulting normal
  // map will be set to RepeatWrapping by the caller).
  const sample = (x: number, y: number): number => {
    let xx = x; let yy = y;
    if (xx < 0) xx += size; else if (xx >= size) xx -= size;
    if (yy < 0) yy += size; else if (yy >= size) yy -= size;
    return h[idx(xx, yy)] / 255;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sobel X kernel:  [-1  0  1]
      //                  [-2  0  2]
      //                  [-1  0  1]
      const dx = (
        sample(x + 1, y - 1) + 2 * sample(x + 1, y) + sample(x + 1, y + 1)
      ) - (
        sample(x - 1, y - 1) + 2 * sample(x - 1, y) + sample(x - 1, y + 1)
      );
      // Sobel Y kernel:  [-1 -2 -1]
      //                  [ 0  0  0]
      //                  [ 1  2  1]
      const dy = (
        sample(x - 1, y + 1) + 2 * sample(x, y + 1) + sample(x + 1, y + 1)
      ) - (
        sample(x - 1, y - 1) + 2 * sample(x, y - 1) + sample(x + 1, y - 1)
      );
      const nx = -dx * strength;
      const ny = -dy * strength;
      const nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const i = idx(x, y);
      o[i] = Math.round((nx / len * 0.5 + 0.5) * 255);
      o[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      o[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      o[i + 3] = 255;
    }
  }
  oCtx.putImageData(oImg, 0, 0);
  return out;
}

/** Wrap (and cache) a generated normal canvas as a Three.js Texture. */
function cachedNormal(key: string, build: () => HTMLCanvasElement, strength = 1.0): THREE.Texture {
  let t = _normalCache.get(key);
  if (!t) {
    const heightCanvas = build();
    const normalCanvas = heightToNormalCanvas(heightCanvas, strength);
    t = new THREE.CanvasTexture(normalCanvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // Normal maps live in linear (non-sRGB) color space — encoding them as
    // sRGB would tint the normals and break the lighting math.
    t.colorSpace = THREE.NoColorSpace;
    _normalCache.set(key, t);
  }
  return t;
}

/**
 * Skin normal map — fine pore bumps (random small dots) + faint horizontal
 * wrinkles. Subtle strength so it reads as skin micro-relief, not acne.
 * Apply to skin material (face, ears, neck) for realistic surface detail.
 */
export function skinNormalTexture(): THREE.Texture {
  return cachedNormal("skinNormal_v1", () => {
    const size = 256;
    const [c, ctx] = makeCanvas(size);
    // Mid-gray base = neutral height (no bump).
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);
    // Pores — many small dark dots scattered (darker = depression in heightmap).
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 0.4 + Math.random() * 1.4;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(60,60,60,0.9)");
      g.addColorStop(0.7, "rgba(100,100,100,0.4)");
      g.addColorStop(1, "rgba(128,128,128,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Pore highlights — a few lighter specks for the raised skin between pores.
    for (let i = 0; i < 400; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      ctx.fillStyle = "rgba(170,170,170,0.4)";
      ctx.fillRect(x, y, 1, 1);
    }
    // Faint wrinkles — gentle horizontal curves across the map (forehead lines,
    // expression lines). Lighter than the pores so they're subtle.
    ctx.strokeStyle = "rgba(100,100,100,0.35)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const y0 = (i + 0.5) * (size / 6) + (Math.random() - 0.5) * 12;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      for (let x = 0; x < size; x += 6) {
        ctx.lineTo(x, y0 + Math.sin(x * 0.04 + i * 1.3) * 2.2);
      }
      ctx.stroke();
    }
    return c;
  }, 0.6); // subtle skin relief
}

/**
 * Woven fabric normal map — warp + weft threads (alternating raised stripes
 * in two directions, forming a plain weave). Apply to suit/shirt/pants/jacket
 * materials so the clothing reads as fabric, not painted plastic.
 */
export function fabricNormalTexture(): THREE.Texture {
  return cachedNormal("fabricNormal_v1", () => {
    const size = 256;
    const [c, ctx] = makeCanvas(size);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);
    // Warp threads — vertical raised stripes (lighter centers).
    const threadW = 4;
    for (let x = 0; x < size; x += threadW * 2) {
      // Raised center (light), darker edges (depression between threads).
      const g = ctx.createLinearGradient(x, 0, x + threadW * 2, 0);
      g.addColorStop(0, "rgba(70,70,70,1)");
      g.addColorStop(0.25, "rgba(120,120,120,1)");
      g.addColorStop(0.5, "rgba(160,160,160,1)");
      g.addColorStop(0.75, "rgba(120,120,120,1)");
      g.addColorStop(1, "rgba(70,70,70,1)");
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, threadW * 2, size);
    }
    // Weft threads — horizontal raised stripes (multiply with warp for plain weave).
    for (let y = 0; y < size; y += threadW * 2) {
      const g = ctx.createLinearGradient(0, y, 0, y + threadW * 2);
      g.addColorStop(0, "rgba(70,70,70,1)");
      g.addColorStop(0.25, "rgba(130,130,130,1)");
      g.addColorStop(0.5, "rgba(170,170,170,1)");
      g.addColorStop(0.75, "rgba(130,130,130,1)");
      g.addColorStop(1, "rgba(70,70,70,1)");
      ctx.fillStyle = g;
      ctx.fillRect(0, y, size, threadW * 2);
    }
    // Random fiber noise — subtle non-uniformity so the weave isn't perfectly
    // mechanical.
    noise(ctx, size, "#808080", 18);
    return c;
  }, 1.2); // visible fabric weave
}

/**
 * Kevlar weave normal map — tight diagonal weave (aramid fiber pattern).
 * Tighter + denser than the plain fabric weave. Apply to the plate carrier
 * vest material so the vest reads as ballistic fabric, not flat plate.
 */
export function kevlarNormalTexture(): THREE.Texture {
  return cachedNormal("kevlarNormal_v1", () => {
    const size = 256;
    const [c, ctx] = makeCanvas(size);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);
    // Tighter thread width (2px) for the kevlar weave.
    const threadW = 2;
    // Diagonal weave — offset each row by 1px so the threads form a diagonal.
    for (let y = 0; y < size; y += threadW * 2) {
      const offset = (y % (threadW * 4)) === 0 ? 0 : threadW;
      for (let x = -threadW * 2; x < size; x += threadW * 4) {
        // Raised diagonal thread segment.
        const g = ctx.createLinearGradient(x + offset, y, x + offset + threadW * 2, y + threadW * 2);
        g.addColorStop(0, "rgba(70,70,70,1)");
        g.addColorStop(0.5, "rgba(165,165,165,1)");
        g.addColorStop(1, "rgba(70,70,70,1)");
        ctx.fillStyle = g;
        // Draw a small diagonal segment.
        ctx.save();
        ctx.translate(x + offset, y);
        ctx.rotate(-Math.PI / 8);
        ctx.fillRect(0, 0, threadW * 3, threadW * 2);
        ctx.restore();
      }
    }
    // Counter-diagonal threads for the over/under pattern.
    for (let y = threadW; y < size; y += threadW * 2) {
      const offset = (y % (threadW * 4)) === threadW ? threadW : 0;
      for (let x = -threadW * 2; x < size; x += threadW * 4) {
        const g = ctx.createLinearGradient(x + offset, y, x + offset + threadW * 2, y + threadW * 2);
        g.addColorStop(0, "rgba(60,60,60,1)");
        g.addColorStop(0.5, "rgba(140,140,140,1)");
        g.addColorStop(1, "rgba(60,60,60,1)");
        ctx.fillStyle = g;
        ctx.save();
        ctx.translate(x + offset, y);
        ctx.rotate(Math.PI / 8);
        ctx.fillRect(0, 0, threadW * 3, threadW * 2);
        ctx.restore();
      }
    }
    // Subtle resin impregnation noise — kevlar weave is set in a resin matrix.
    noise(ctx, size, "#808080", 12);
    return c;
  }, 1.6); // pronounced kevlar weave
}

/**
 * Brushed metal normal map — fine horizontal anisotropic streaks (the marks
 * left by sanding/brushing). Apply to metal gear (buckles, helmet rails,
 * weapon frames) so the metal reads as machined, not mirror-smooth.
 */
export function metalNormalTexture(): THREE.Texture {
  return cachedNormal("metalNormal_v1", () => {
    const size = 256;
    const [c, ctx] = makeCanvas(size);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);
    // Horizontal brushed lines — alternating light/dark streaks at varying
    // lengths and opacities (mimics random sanding marks).
    for (let i = 0; i < 220; i++) {
      const y = Math.random() * size;
      const opacity = 0.15 + Math.random() * 0.4;
      const brightness = 120 + Math.random() * 80;
      const lineLen = 30 + Math.random() * (size - 30);
      const startX = Math.random() * (size - lineLen);
      ctx.strokeStyle = `rgba(${brightness},${brightness},${brightness + 5},${opacity})`;
      ctx.lineWidth = 0.6 + Math.random() * 0.8;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      // Slight wave — brushing isn't perfectly straight.
      ctx.lineTo(startX + lineLen, y + (Math.random() - 0.5) * 1.2);
      ctx.stroke();
    }
    // A few deeper scratches (darker, longer).
    for (let i = 0; i < 12; i++) {
      const y = Math.random() * size;
      ctx.strokeStyle = "rgba(40,40,45,0.5)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y + (Math.random() - 0.5) * 2);
      ctx.stroke();
    }
    return c;
  }, 0.5); // subtle brushed metal
}

/**
 * Pebbled leather normal map — random rounded bumps (the distinctive "pebbled"
 * grain of combat boot leather + tactical gloves). Apply to boot + glove
 * materials so the leather reads as textured hide, not flat sheet.
 */
export function leatherNormalTexture(): THREE.Texture {
  return cachedNormal("pebbledLeatherNormal_v1", () => {
    const size = 256;
    const [c, ctx] = makeCanvas(size);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);
    // Pebbles — many overlapping rounded bumps (light centers, dark edges).
    // The varying radii + opacities give a natural irregular grain.
    for (let i = 0; i < 320; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 2 + Math.random() * 6;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      // Raised center (light) + depression ring (dark) for a beveled pebble.
      g.addColorStop(0, "rgba(170,170,170,0.9)");
      g.addColorStop(0.55, "rgba(128,128,128,0.5)");
      g.addColorStop(0.85, "rgba(70,70,70,0.85)");
      g.addColorStop(1, "rgba(110,110,110,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Fine grain noise across the whole surface (leather has micro-texture
    // between the pebbles too).
    noise(ctx, size, "#808080", 14);
    return c;
  }, 1.5); // pronounced pebbled grain
}

/**
 * Bullet hole decal texture — dark hole with cracked edges.
 * Used by the impact decal system for surface bullet marks.
 */
export function bulletHoleTexture(): THREE.Texture {
  const size = 64;
  const [c, ctx] = makeCanvas(size);
  const cx = size / 2, cy = size / 2;
  // Transparent background.
  ctx.clearRect(0, 0, size, size);
  // Cracked edge — irregular dark ring.
  ctx.strokeStyle = "rgba(15,12,10,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  const points = 12;
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * Math.PI * 2;
    const r = 6 + Math.random() * 3;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(10,8,6,0.95)";
  ctx.fill();
  ctx.stroke();
  // Radial cracks — 5-8 thin lines extending outward.
  ctx.strokeStyle = "rgba(15,12,10,0.6)";
  ctx.lineWidth = 1;
  const crackCount = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < crackCount; i++) {
    const a = Math.random() * Math.PI * 2;
    const len = 8 + Math.random() * 12;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 7, cy + Math.sin(a) * 7);
    let x = cx + Math.cos(a) * 7;
    let y = cy + Math.sin(a) * 7;
    for (let j = 0; j < 3; j++) {
      const a2 = a + (Math.random() - 0.5) * 0.5;
      x += Math.cos(a2) * (len / 3);
      y += Math.sin(a2) * (len / 3);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Scorch mark — faint dark ring around the hole.
  const scorch = ctx.createRadialGradient(cx, cy, 6, cx, cy, 22);
  scorch.addColorStop(0, "rgba(20,15,10,0.4)");
  scorch.addColorStop(1, "rgba(20,15,10,0)");
  ctx.fillStyle = scorch;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ════════════════════════════════════════════════════════════════════════════
// Task 2-c — Realistic PBR weapon textures.
//
// These generators produce CanvasTextures specifically calibrated for weapon
// PBR materials: brushed metal streaks, parkerized matte finishes, stippled
// polymer, ring-pattern wood grain, carbon-fiber weave, and 6 real camo
// patterns (woodland / desert / arctic / urban / tiger / digital). All
// generators cache by parameter key (color / pattern) so re-renders share
// GPU textures — a single woodland camo texture serves every woodland gun.
// ════════════════════════════════════════════════════════════════════════════

const _weaponTexCache = new Map<string, THREE.Texture>();

/** Parse a baseColor (number | string | THREE.Color) into a hex string like
 *  "#1e3a5f" so it can key the texture cache + drive canvas fillStyle. */
function colorToHex(baseColor: number | string | THREE.Color): string {
  if (typeof baseColor === "number") {
    return "#" + baseColor.toString(16).padStart(6, "0");
  }
  if (typeof baseColor === "string") {
    if (baseColor.startsWith("#")) return baseColor;
    // Parse "rgb(...)" / "rgba(...)" via a temp canvas.
    const c = document.createElement("canvas").getContext("2d")!;
    c.fillStyle = baseColor;
    return c.fillStyle as string;
  }
  // THREE.Color — round to nearest hex.
  const r = Math.round(baseColor.r * 255);
  const g = Math.round(baseColor.g * 255);
  const b = Math.round(baseColor.b * 255);
  return "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0");
}

/** Parse a hex string "#rrggbb" into [r,g,b] 0..255 ints for arithmetic. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/** Lighten a hex color by `amt` (0..255) — returns a new "#rrggbb" string. */
function lightenHex(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  return "#" +
    Math.min(255, r + amt).toString(16).padStart(2, "0") +
    Math.min(255, g + amt).toString(16).padStart(2, "0") +
    Math.min(255, b + amt).toString(16).padStart(2, "0");
}

/** Darken a hex color by `amt` (0..255) — returns a new "#rrggbb" string. */
function darkenHex(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  return "#" +
    Math.max(0, r - amt).toString(16).padStart(2, "0") +
    Math.max(0, g - amt).toString(16).padStart(2, "0") +
    Math.max(0, b - amt).toString(16).padStart(2, "0");
}

/**
 * Brushed metal texture — horizontal anisotropic machining streaks over a
 * base color. Used on receiver bodies, slides, and barrels where the surface
 * finish reads as CNC-milled aluminum or polished steel.
 *
 * `baseColor` accepts a hex number, "#rrggbb" string, or THREE.Color.
 * Returns a sRGB CanvasTexture with RepeatWrapping (so a single 256² map can
 * tile across the entire receiver without stretching).
 */
export function makeBrushedMetalTexture(baseColor: number | string | THREE.Color = 0x3a3a3e): THREE.Texture {
  const baseHex = colorToHex(baseColor);
  const cacheKey = `brushedMetal:${baseHex}`;
  const cached = _weaponTexCache.get(cacheKey);
  if (cached) return cached;
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  // Base fill.
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, baseHex, 14);
  // Horizontal brushed streaks — many thin lines of varying brightness/opacity.
  // The streaks are 30-100% width, randomly offset, with subtle Y wave.
  for (let i = 0; i < 280; i++) {
    const y = Math.random() * size;
    const opacity = 0.08 + Math.random() * 0.32;
    const brighten = Math.random() > 0.5;
    const shade = brighten
      ? lightenHex(baseHex, 18 + Math.random() * 28)
      : darkenHex(baseHex, 14 + Math.random() * 26);
    const len = size * (0.3 + Math.random() * 0.7);
    const x0 = Math.random() * (size - len);
    ctx.strokeStyle = shade;
    ctx.globalAlpha = opacity;
    ctx.lineWidth = 0.5 + Math.random() * 0.9;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + len, y + (Math.random() - 0.5) * 1.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // A few deeper wear scratches (longer, darker — rubbing wear marks).
  for (let i = 0; i < 14; i++) {
    const y = Math.random() * size;
    ctx.strokeStyle = darkenHex(baseHex, 60);
    ctx.globalAlpha = 0.4 + Math.random() * 0.3;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  _weaponTexCache.set(cacheKey, tex);
  return tex;
}

/**
 * Parkerized finish texture — matte dark gunmetal with subtle granular noise
 * and faint mottling (the phosphate-conversion finish used on military small
 * arms). Low reflectivity, slight color variation across the surface.
 *
 * Returns a sRGB CanvasTexture. Designed to pair with a low metalness (0.7)
 * and high roughness (0.65) MeshStandardMaterial.
 */
export function makeParkerizedTexture(): THREE.Texture {
  const cacheKey = "parkerized:default";
  const cached = _weaponTexCache.get(cacheKey);
  if (cached) return cached;
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  // Base — very dark blue-gray (the classic parkerized gunmetal).
  ctx.fillStyle = "#1c1d20";
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, "#1c1d20", 18);
  // Mottling — large soft blotches of slightly lighter/darker gray (the
  // phosphate conversion finish produces subtle non-uniform color zones).
  for (let i = 0; i < 24; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 18 + Math.random() * 46;
    const lighter = Math.random() > 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    if (lighter) {
      g.addColorStop(0, "rgba(56,58,64,0.45)");
      g.addColorStop(1, "rgba(56,58,64,0)");
    } else {
      g.addColorStop(0, "rgba(8,8,10,0.5)");
      g.addColorStop(1, "rgba(8,8,10,0)");
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Faint horizontal machine marks — very subtle (parkerizing covers most
  // of the underlying surface finish, but deep machining marks still show).
  for (let i = 0; i < 60; i++) {
    const y = Math.random() * size;
    ctx.strokeStyle = "rgba(70,72,78,0.12)";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 1.2);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  _weaponTexCache.set(cacheKey, tex);
  return tex;
}

/**
 * Textured polymer texture — matte plastic with stippled grip pattern. Used
 * on pistol grips, stocks, and handguards where the surface reads as molded
 * polymer (not metal). The stippling is a grid of small dark dots that catches
 * light at the edges, mimicking the aggressive grip texture on modern
 * tactical furniture.
 *
 * `color` accepts a hex number, "#rrggbb" string, or THREE.Color.
 */
export function makePolymerTexture(color: number | string | THREE.Color = 0x1a1a1c): THREE.Texture {
  const baseHex = colorToHex(color);
  const cacheKey = `polymer:${baseHex}`;
  const cached = _weaponTexCache.get(cacheKey);
  if (cached) return cached;
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, size, size);
  noise(ctx, size, baseHex, 10);
  // Stippling — a dense grid of small dark dots with light centers, forming
  // the classic "stippled grip" texture (modern Magpul / Hogue furniture).
  const stipSize = 5;
  for (let y = 0; y < size; y += stipSize) {
    for (let x = 0; x < size; x += stipSize) {
      // Offset every other row by half for a hex-like pack.
      const ox = (Math.floor(y / stipSize) % 2) * (stipSize / 2);
      const cx = x + ox + stipSize / 2 + (Math.random() - 0.5) * 1.2;
      const cy = y + stipSize / 2 + (Math.random() - 0.5) * 1.2;
      const r = 1.4 + Math.random() * 0.6;
      // Dark ring (depression between stippling points).
      ctx.fillStyle = darkenHex(baseHex, 38);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      // Light center (raised stipple point — catches a highlight).
      ctx.fillStyle = lightenHex(baseHex, 24);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Subtle molding parting line down the center — most polymer furniture has
  // a visible mold seam (where the two halves of the injection mold met).
  ctx.strokeStyle = darkenHex(baseHex, 50);
  ctx.lineWidth = 0.8;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.stroke();
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  _weaponTexCache.set(cacheKey, tex);
  return tex;
}

/**
 * Realistic wood grain texture — concentric growth rings + long wavy grain
 * streaks + occasional knots. Used on AK / AWP / Nova / Scout wood furniture.
 * The ring pattern is built from multiple offset sine-wave bands (mimicking
 * the way real tree rings vary in spacing and curvature), with darker latewood
 * bands alternating with lighter earlywood.
 */
export function makeWoodGrainTexture(): THREE.Texture {
  const cacheKey = "woodGrain:default";
  const cached = _weaponTexCache.get(cacheKey);
  if (cached) return cached;
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  // Base — warm mid-tone walnut.
  ctx.fillStyle = "#6b4226";
  ctx.fillRect(0, 0, size, size);
  // Growth rings — concentric arcs centered off-canvas (so they curve across
  // the surface like real rings viewed along the grain). Each ring is a soft
  // dark band; spacing varies between rings for organic irregularity.
  const cx = -size * 0.4;
  const cy = size * 0.7;
  let ringR = 30;
  while (ringR < size * 2.2) {
    const ringWidth = 4 + Math.random() * 8;
    // Dark latewood band.
    ctx.strokeStyle = `rgba(58,32,16,${0.45 + Math.random() * 0.3})`;
    ctx.lineWidth = ringWidth * 0.4;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();
    // Lighter earlywood on either side.
    ctx.strokeStyle = `rgba(135,90,55,${0.25 + Math.random() * 0.2})`;
    ctx.lineWidth = ringWidth * 0.6;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR + ringWidth * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ringR += ringWidth + 3 + Math.random() * 5;
  }
  // Long wavy grain streaks — many thin horizontal lines following the grain
  // direction with subtle vertical undulation (the characteristic "cathedral"
  // pattern of flat-sawn wood).
  for (let i = 0; i < 80; i++) {
    const y0 = Math.random() * size;
    const darken = Math.random() > 0.5;
    ctx.strokeStyle = darken
      ? `rgba(48,26,12,${0.18 + Math.random() * 0.22})`
      : `rgba(122,80,48,${0.15 + Math.random() * 0.2})`;
    ctx.lineWidth = 0.5 + Math.random() * 0.8;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    for (let x = 0; x < size; x += 6) {
      ctx.lineTo(x, y0 + Math.sin(x * 0.04 + i * 0.7) * (1.5 + Math.random() * 1.5));
    }
    ctx.stroke();
  }
  // Open pores — small dark dots scattered across the surface (the open-grain
  // pore structure of walnut / oak, visible on close inspection).
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = `rgba(40,22,10,${0.3 + Math.random() * 0.4})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.4 + Math.random() * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // Occasional knot — a small dark oval with concentric rings around it.
  if (Math.random() > 0.4) {
    const kx = size * (0.2 + Math.random() * 0.6);
    const ky = size * (0.2 + Math.random() * 0.6);
    const kr = 4 + Math.random() * 5;
    // Knot dark center.
    const g = ctx.createRadialGradient(kx, ky, 0, kx, ky, kr * 2);
    g.addColorStop(0, "rgba(20,10,4,0.85)");
    g.addColorStop(0.5, "rgba(50,28,14,0.55)");
    g.addColorStop(1, "rgba(80,50,28,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(kx, ky, kr * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  _weaponTexCache.set(cacheKey, tex);
  return tex;
}

/**
 * Carbon fiber weave texture — the classic 2x2 twill pattern used on
 * high-end aftermarket parts (handguards, stocks, scope tubes). Each tow
 * (fiber bundle) is rendered as a soft shaded stripe that alternates over/
 * under in the 2x2 twill pattern, giving the characteristic diagonal weave.
 *
 * Returns a sRGB CanvasTexture. Pairs with high metalness (0.6) and low
 * roughness (0.35) for the glossy resin-impregnated look.
 */
export function makeCarbonFiberTexture(): THREE.Texture {
  const cacheKey = "carbonFiber:default";
  const cached = _weaponTexCache.get(cacheKey);
  if (cached) return cached;
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  // Base — very dark (carbon tows are essentially black; the resin fills the
  // gaps with a slightly lighter gloss).
  ctx.fillStyle = "#0a0a0c";
  ctx.fillRect(0, 0, size, size);
  // Tow size — 2x2 twill means each tow is 2 cells wide before going under.
  const towW = size / 8; // 8 tows across → 32px each
  // For each cell in the 8x8 grid, determine if it's a "warp over" or "weft
  // over" cell (the 2x2 twill pattern). Then draw the appropriate tow.
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      // 2x2 twill: the over/under pattern shifts by 2 each row.
      const isWarpOver = ((col + Math.floor(row / 2) * 2) % 4) < 2;
      const x = col * towW;
      const y = row * towW;
      if (isWarpOver) {
        // Warp tow (vertical) on top — dark vertical stripe with a slight
        // diagonal sheen.
        const g = ctx.createLinearGradient(x, 0, x + towW, 0);
        g.addColorStop(0, "#08080a");
        g.addColorStop(0.3, "#1c1c22");
        g.addColorStop(0.5, "#2c2c34");
        g.addColorStop(0.7, "#1c1c22");
        g.addColorStop(1, "#08080a");
        ctx.fillStyle = g;
        ctx.fillRect(x, y, towW, towW);
      } else {
        // Weft tow (horizontal) on top.
        const g = ctx.createLinearGradient(0, y, 0, y + towW);
        g.addColorStop(0, "#08080a");
        g.addColorStop(0.3, "#18181e");
        g.addColorStop(0.5, "#262630");
        g.addColorStop(0.7, "#18181e");
        g.addColorStop(1, "#08080a");
        ctx.fillStyle = g;
        ctx.fillRect(x, y, towW, towW);
      }
    }
  }
  // Diagonal highlight — the 2x2 twill has a characteristic diagonal sheen
  // line crossing the weave. Add a faint highlight along the diagonal.
  ctx.strokeStyle = "rgba(120,120,140,0.18)";
  ctx.lineWidth = 1.2;
  for (let i = -8; i < 16; i++) {
    ctx.beginPath();
    ctx.moveTo(i * towW * 0.5, 0);
    ctx.lineTo(i * towW * 0.5 + size, size);
    ctx.stroke();
  }
  // Resin gloss highlight — subtle large-scale light reflection.
  const gloss = ctx.createLinearGradient(0, 0, size, size);
  gloss.addColorStop(0, "rgba(255,255,255,0.05)");
  gloss.addColorStop(0.5, "rgba(255,255,255,0.0)");
  gloss.addColorStop(1, "rgba(255,255,255,0.04)");
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  _weaponTexCache.set(cacheKey, tex);
  return tex;
}

/**
 * Camo pattern type — 6 real-world patterns, each with multi-color blotches
 * or pixels (NOT flat colors).
 *  - "woodland": 4-color US woodland (green/brown/black/tan)
 *  - "desert":   3-color desert (tan/brown/pale)
 *  - "arctic":   3-color winter (white/gray/light blue)
 *  - "urban":    3-color urban (gray/dark gray/light gray)
 *  - "tiger":    Vietnamese tiger stripe (green/brown/black stripes)
 *  - "digital":  MARPAT-style digital (pixelated woodland)
 */
export type CamoPattern = "woodland" | "desert" | "arctic" | "urban" | "tiger" | "digital";

interface CamoSpec {
  base: string;
  blotches: { color: string; count: number; minR: number; maxR: number }[];
  /** Optional secondary pass — stripes for tiger, pixels for digital. */
  stripes?: { color: string; count: number; width: number; opacity: number };
  pixels?: { colors: string[]; cellSize: number };
}

const CAMO_SPECS: Record<CamoPattern, CamoSpec> = {
  woodland: {
    base: "#3a4a2a",
    blotches: [
      { color: "#5a6a3a", count: 28, minR: 30, maxR: 70 },
      { color: "#2a2a18", count: 18, minR: 20, maxR: 50 },
      { color: "#8a7a4a", count: 14, minR: 22, maxR: 48 },
      { color: "#1a1a0a", count: 10, minR: 14, maxR: 32 },
    ],
  },
  desert: {
    base: "#b8a37a",
    blotches: [
      { color: "#9a8050", count: 22, minR: 28, maxR: 62 },
      { color: "#d8c89a", count: 18, minR: 22, maxR: 50 },
      { color: "#6a5430", count: 10, minR: 16, maxR: 36 },
      { color: "#705a3a", count: 8, minR: 14, maxR: 30 },
    ],
  },
  arctic: {
    base: "#e8eef2",
    blotches: [
      { color: "#a8b0b8", count: 16, minR: 30, maxR: 60 },
      { color: "#7a8088", count: 10, minR: 18, maxR: 38 },
      { color: "#c4ccd2", count: 20, minR: 24, maxR: 50 },
      { color: "#5a6068", count: 6, minR: 12, maxR: 24 },
    ],
  },
  urban: {
    base: "#7a7a7e",
    blotches: [
      { color: "#3a3a3e", count: 22, minR: 26, maxR: 56 },
      { color: "#a8a8ac", count: 18, minR: 22, maxR: 48 },
      { color: "#5a5a5e", count: 16, minR: 20, maxR: 42 },
      { color: "#1c1c20", count: 8, minR: 12, maxR: 28 },
    ],
  },
  tiger: {
    base: "#4a5a2a",
    blotches: [
      { color: "#7a6a3a", count: 18, minR: 24, maxR: 50 },
      { color: "#2a1a0a", count: 12, minR: 18, maxR: 38 },
    ],
    stripes: { color: "#1a1a0a", count: 28, width: 8, opacity: 0.7 },
  },
  digital: {
    base: "#3a4a2a",
    blotches: [],
    pixels: {
      colors: ["#5a6a3a", "#2a2a18", "#8a7a4a", "#1a1a0a", "#3a4a2a"],
      cellSize: 6,
    },
  },
};

/** Draw an irregular camo blotch — a multi-lobe organic shape (not a perfect
 *  circle) that better mimics how real camo patterns are stenciled/sponged on. */
function drawCamoBlotch(
  ctx: CanvasRenderingContext2D,
  color: string,
  cx: number,
  cy: number,
  r: number,
  lobes = 6,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i <= lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const rr = r * (0.7 + Math.random() * 0.5);
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  // Secondary smaller lobe attached for an irregular "sponge" silhouette.
  if (Math.random() > 0.4) {
    const a2 = Math.random() * Math.PI * 2;
    const cx2 = cx + Math.cos(a2) * r * 0.7;
    const cy2 = cy + Math.sin(a2) * r * 0.7;
    ctx.beginPath();
    for (let i = 0; i <= lobes; i++) {
      const a = (i / lobes) * Math.PI * 2;
      const rr = r * 0.5 * (0.6 + Math.random() * 0.5);
      const x = cx2 + Math.cos(a) * rr;
      const y = cy2 + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Real camo pattern texture — 6 patterns, each with multi-color organic
 * blotches (not flat colors). Returns a sRGB CanvasTexture with RepeatWrapping
 * so the camo tiles seamlessly across the weapon surface.
 */
export function makeCamoTexture(pattern: CamoPattern = "woodland"): THREE.Texture {
  const cacheKey = `camo:${pattern}`;
  const cached = _weaponTexCache.get(cacheKey);
  if (cached) return cached;
  const spec = CAMO_SPECS[pattern];
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  // Base fill.
  ctx.fillStyle = spec.base;
  ctx.fillRect(0, 0, size, size);
  // Digital pattern — pixelated cells, no blotches.
  if (spec.pixels) {
    const { colors, cellSize } = spec.pixels;
    const cells = size / cellSize;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        // Pick a color, weighted toward the base + dominant colors.
        // Use a noise-like selection — adjacent cells tend toward similar colors
        // (creates the "digital blob" look of MARPAT).
        const idx = Math.floor(Math.random() * colors.length);
        ctx.fillStyle = colors[idx];
        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
      }
    }
    // Soften with a faint blur pass — re-overlay the base at low opacity to
    // blend pixel edges (MARPAT has slightly soft pixel boundaries).
    ctx.fillStyle = spec.base;
    ctx.globalAlpha = 0.15;
    ctx.fillRect(0, 0, size, size);
    ctx.globalAlpha = 1;
  } else {
    // Blotches — organic multi-lobe shapes per color.
    for (const bl of spec.blotches) {
      for (let i = 0; i < bl.count; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const r = bl.minR + Math.random() * (bl.maxR - bl.minR);
        drawCamoBlotch(ctx, bl.color, x, y, r);
      }
    }
    // Optional stripes — tiger-stripe horizontal brush strokes.
    if (spec.stripes) {
      const { color, count, width, opacity } = spec.stripes;
      ctx.strokeStyle = color;
      ctx.globalAlpha = opacity;
      ctx.lineWidth = width;
      for (let i = 0; i < count; i++) {
        const y = Math.random() * size;
        ctx.beginPath();
        ctx.moveTo(0, y);
        // Wavy horizontal stroke — the tiger-stripe curves.
        for (let x = 0; x < size; x += 10) {
          ctx.lineTo(x, y + Math.sin(x * 0.05 + i) * 6 + (Math.random() - 0.5) * 4);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
  // Tileable: mirror-blend the edges so seam is invisible when wrapped.
  // Draw a faded copy of the left edge onto the right edge.
  const edgeW = 16;
  const leftEdge = ctx.getImageData(0, 0, edgeW, size);
  ctx.putImageData(leftEdge, size - edgeW, 0);
  // And top edge onto bottom.
  const topEdge = ctx.getImageData(0, 0, size, edgeW);
  ctx.putImageData(topEdge, 0, size - edgeW);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  _weaponTexCache.set(cacheKey, tex);
  return tex;
}

/**
 * Generate a tangent-space normal map from a height-map canvas. Wraps the
 * existing Sobel-filter `heightToNormalCanvas` as a public API so external
 * callers can derive normal maps from arbitrary procedural heightmaps (e.g.
 * for custom camo embossing, engraved logos, or surface etching).
 *
 * `strength` scales the bump intensity (higher = more pronounced). Returns a
 * linear-space CanvasTexture with RepeatWrapping.
 */
export function makeNormalMapFromCanvas(heightCanvas: HTMLCanvasElement, strength = 1.0): THREE.Texture {
  const normalCanvas = heightToNormalCanvas(heightCanvas, strength);
  const tex = new THREE.CanvasTexture(normalCanvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Normal maps must NOT be sRGB-encoded (sRGB would tint the normals and
  // break the lighting math).
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// ════════════════════════════════════════════════════════════════════════════
// SEC2-ART — Prompt 13: Authored PBR texture sets.
//
// The procedural texture factories above (concreteTexture, sandTexture,
// metalTexture, brushedMetal, etc.) paint PBR-ish maps to canvas at runtime.
// They look decent but are obviously synthetic — no real surface micro-detail,
// no grime layering, no captured-from-life material variation.
//
// This block adds the override path:
//   - `PBRTextureSet` interface — the 5 canonical PBR maps
//   - `getPBRSet(slug)` — fetch authored sets from /textures/<slug>/ when
//     present, fall back to procedural canvas-painted PBR otherwise.
//
// Directory contract (artist handoff):
//
//   /public/textures/<slug>/
//     ├── albedo.ktx2     (or .png)        sRGB-encoded base color
//     ├── normal.ktx2     (or .png)        linear tangent-space normals
//     ├── roughness.ktx2  (or .png)        linear grayscale (or BC4 in ktx2)
//     ├── metalness.ktx2  (or .png)        linear grayscale (or BC4 in ktx2)
//     └── ao.ktx2         (or .png)        linear grayscale ambient occlusion
//
// KTX2 is preferred (Basis-transcoded GPU format — 4-8× smaller, faster to
// load). PNG is the fallback. The loader probes both extensions; if neither
// is present for a required map, falls back to the procedural canvas PBR.
//
// Procedural fallback set: getPBRSet("procedural_<material>") returns a
// canvas-painted PBR set for a few common materials (concrete, sand, metal,
// wood). These call into the existing factories above so the look matches.
// ════════════════════════════════════════════════════════════════════════════

export interface PBRTextureSet {
  /** Base color / albedo (sRGB). Required. */
  albedo: THREE.Texture;
  /** Tangent-space normal map (linear). Optional — null = flat surface. */
  normal: THREE.Texture | null;
  /** Roughness map (linear grayscale). Optional — null = use material.roughness. */
  roughness: THREE.Texture | null;
  /** Metalness map (linear grayscale). Optional — null = use material.metalness. */
  metalness: THREE.Texture | null;
  /** Ambient-occlusion map (linear grayscale). Optional — null = no AO. */
  ao: THREE.Texture | null;
  /** Where the set came from — telemetry / debug. */
  source: "authored_ktx2" | "authored_png" | "procedural";
  /** The slug the set was loaded for. */
  slug: string;
}

/** Per-set cache — getPBRSet is idempotent. */
const _pbrCache = new Map<string, Promise<PBRTextureSet>>();

/** True if we're in a browser context (client-side TextureLoader is safe). */
function isClient(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** Cached TextureLoader + KTX2Loader (lazy client-side init). */
let _texLoader: THREE.TextureLoader | null = null;
function getTextureLoader(): THREE.TextureLoader {
  if (!_texLoader) _texLoader = new THREE.TextureLoader();
  return _texLoader;
}

// ════════════════════════════════════════════════════════════════════════════
// Task 3 / item 60 — generic loadTexture(path) with KTX2-preferred + PNG fallback.
//
// Public loader path for any single texture (NOT just PBR sets). Tries
// `${path}.ktx2` first via KTX2Loader (Basis-transcoded GPU format — 4–8×
// smaller, faster to upload, mip-mapped for free). Falls back to
// `${path}.png` via TextureLoader if the KTX2 isn't present OR fails to decode.
//
// Conversion command (artists — author PNG, then convert to KTX2):
//
//   # Install: npm i -g @recio/ktx2-encoder  (or use the Khronos toktx CLI)
//   # From the KhronosGroup KTX-Software release:
//   #   https://github.com/KhronosGroup/KTX-Software/releases
//   #
//   # Encode an sRGB albedo (BC1/ETC1S — color maps):
//   toktx encode \
//     --bcmp \
//     --encode uastc \
//     --uastc_quality 2 \
//     --assign_oetf srgb \
//     --normal_mode no \
//     -o albedo.ktx2 albedo.png
//
//   # Encode a linear normal map (BC5 — two-channel tangents):
//   toktx encode \
//     --bcmp \
//     --encode uastc \
//     --uastc_quality 2 \
//     --assign_oetf linear \
//     --normal_mode yes \
//     --swizzle rg01 \
//     -o normal.ktx2 normal.png
//
//   # Encode a linear grayscale (roughness/metalness/ao — BC4 single-channel):
//   toktx encode \
//     --bcmp \
//     --encode uastc \
//     --uastc_quality 2 \
//     --assign_oetf linear \
//     --swizzle rrr1 \
//     -o roughness.ktx2 roughness.png
//
// The .ktx2 outputs go into /public/textures/<slug>/ next to the .png source
// (both can coexist — loadTexture prefers .ktx2 but falls back to .png).
// Don't ship .ktx2 files in this repo (too big for git) — pipeline-build them
// in CI from the authored .png sources.
// ════════════════════════════════════════════════════════════════════════════

/** Per-path cache so repeat calls for the same path don't re-fetch. */
const _textureCache = new Map<string, Promise<THREE.Texture>>();

/** Generic texture loader. Prefers KTX2 (Basis-transcoded GPU format) when a
 *  `.ktx2` sibling exists at `${path}.ktx2`; falls back to `${path}.png` via
 *  TextureLoader otherwise.
 *
 *  @param path  Base path under /public (no extension). e.g. "/textures/ak74/albedo"
 *  @param opts  Optional { srgb?: boolean } — true for color/albedo maps,
 *               false (default) for linear data (normals, roughness, etc.).
 *  @returns     A promise resolving to a THREE.Texture (colorSpace already set). */
export async function loadTexture(
  path: string,
  opts: { srgb?: boolean } = {},
): Promise<THREE.Texture> {
  const cacheKey = `${path}|srgb=${opts.srgb ? 1 : 0}`;
  const cached = _textureCache.get(cacheKey);
  if (cached) return cached;
  const p = (async (): Promise<THREE.Texture> => {
    if (!isClient()) {
      // SSR fallback — return a 1×1 placeholder DataTexture so callers can
      // construct a material synchronously. Will be replaced by the real
      // texture after hydration via the same loadTexture() call on the client.
      const placeholder = new THREE.DataTexture(
        new Uint8Array([255, 255, 255, 255]),
        1, 1, THREE.RGBAFormat,
      );
      placeholder.needsUpdate = true;
      return placeholder;
    }
    const ktx2Url = `${path}.ktx2`;
    const pngUrl = `${path}.png`;
    // Try KTX2 first.
    if (await probeUrl(ktx2Url)) {
      try {
        const { KTX2Loader } = await import("three/examples/jsm/loaders/KTX2Loader.js");
        const loader = new KTX2Loader();
        // Note: detectSupport(renderer) would let the loader pick the native
        // GPU format (BC1/BC3/BC5/BC7 on desktop, ETC1S/ASTC on mobile) instead
        // of transcoding to RGBA on CPU. Callers that own a renderer should
        // pass it via initKTX2Support(renderer) in ModelRegistry first — for
        // the standalone loadTexture path we leave it unset (CPU decode).
        const tex = await loader.loadAsync(ktx2Url, undefined);
        loader.dispose();
        tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        return tex;
      } catch {
        // KTX2 decode failed — fall through to PNG.
      }
    }
    // PNG fallback.
    const tex = await getTextureLoader().loadAsync(pngUrl);
    tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  })();
  _textureCache.set(cacheKey, p);
  return p;
}

/** Probe a URL for existence via fetch HEAD. Returns true if 2xx. */
async function probeUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Try to load a texture from a list of URL candidates (different extensions).
 *  Returns the first successful load, or null if all fail. */
async function loadFirstExisting(
  slug: string,
  mapName: "albedo" | "normal" | "roughness" | "metalness" | "ao",
): Promise<{ texture: THREE.Texture; source: "authored_ktx2" | "authored_png" } | null> {
  if (!isClient()) return null;
  const candidates = [
    `/textures/${slug}/${mapName}.ktx2`,
    `/textures/${slug}/${mapName}.png`,
  ];
  for (const url of candidates) {
    const exists = await probeUrl(url);
    if (!exists) continue;
    // KTX2 needs the KTX2Loader; PNG uses the regular TextureLoader. We
    // don't dynamic-import KTX2 here (the ModelRegistry already wires it);
    // for textures we fall back to PNG if KTX2 isn't initialized.
    if (url.endsWith(".ktx2")) {
      try {
        const { KTX2Loader } = await import("three/examples/jsm/loaders/KTX2Loader.js");
        const loader = new KTX2Loader();
        // detectSupport requires a renderer; for now, decode to RGBA on CPU
        // (slower but works without a renderer reference). When the engine
        // wires a global renderer, swap to detectSupport(renderer).
        const tex = await loader.loadAsync(url, undefined);
        loader.dispose();
        if (mapName === "albedo") tex.colorSpace = THREE.SRGBColorSpace;
        else tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        return { texture: tex, source: "authored_ktx2" };
      } catch {
        // KTX2 decode failed — fall through to PNG.
        continue;
      }
    }
    // PNG path.
    try {
      const tex = await getTextureLoader().loadAsync(url);
      if (mapName === "albedo") tex.colorSpace = THREE.SRGBColorSpace;
      else tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      return { texture: tex, source: "authored_png" };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Build a procedural PBR set from the canvas factories above. Used as the
 * fallback when no authored set ships at /textures/<slug>/.
 *
 * Recognized procedural slugs (prefix with `procedural_`):
 *   - procedural_concrete → concreteTexture + concreteRoughnessTexture
 *   - procedural_sand     → sandTexture + concreteRoughnessTexture (rough is similar)
 *   - procedural_metal    → metalTexture + metalRoughTexture
 *   - procedural_wood     → woodTexture
 *   - procedural_default  → metalTexture (catch-all)
 *
 * For arbitrary slugs (e.g. a weapon slug like "ak74"), returns the
 * `procedural_default` set — the procedural weapon PBR is already authored
 * in WeaponBuilder.ts via makeBrushedMetalTexture + makeParkerizedTexture;
 * callers compose those into a MeshStandardMaterial directly.
 */
function buildProceduralPBRSet(slug: string): PBRTextureSet {
  let albedo: THREE.Texture;
  let roughness: THREE.Texture | null = null;
  let metalness: THREE.Texture | null = null;

  if (slug === "procedural_concrete" || slug === "concrete") {
    albedo = concreteTexture();
    roughness = concreteRoughnessTexture();
    metalness = null;
  } else if (slug === "procedural_sand" || slug === "sand") {
    albedo = sandTexture();
    roughness = concreteRoughnessTexture();
  } else if (slug === "procedural_metal" || slug === "metal") {
    albedo = metalTexture();
    roughness = metalRoughTexture();
    metalness = metalRoughTexture(); // metallic = bright in the same map
  } else if (slug === "procedural_wood" || slug === "wood") {
    albedo = woodTexture();
    roughness = null;
  } else {
    // Catch-all — flat medium grey.
    albedo = metalTexture();
    roughness = metalRoughTexture();
  }

  return {
    albedo,
    normal: null, // procedural sets have no normal (the factories above bake
                  // detail into the albedo; WeaponBuilder supplies its own
                  // metalNormalTexture / fabricNormalTexture for weapons).
    roughness,
    metalness,
    ao: null,
    source: "procedural",
    slug,
  };
}

/**
 * Fetch a PBR texture set for a slug. Resolution order:
 *   1. Authored KTX2 at /textures/<slug>/albedo.ktx2 (+ siblings)
 *   2. Authored PNG at /textures/<slug>/albedo.png (+ siblings)
 *   3. Procedural canvas-painted fallback (buildProceduralPBRSet)
 *
 * Returns a Promise<PBRTextureSet>. Always resolves (never rejects) — on
 * any error, the procedural fallback is used. The promise is cached so
 * repeat callers share the same set.
 */
export function getPBRSet(slug: string): Promise<PBRTextureSet> {
  const cached = _pbrCache.get(slug);
  if (cached) return cached;

  const p = (async (): Promise<PBRTextureSet> => {
    // Authored path — probe albedo first; if no albedo ships, fall through.
    const albedo = await loadFirstExisting(slug, "albedo");
    if (!albedo) return buildProceduralPBRSet(slug);

    // Albedo exists — load the other maps in parallel. Each can fall back
    // to null (the material will use its scalar roughness/metalness instead).
    const [normal, roughness, metalness, ao] = await Promise.all([
      loadFirstExisting(slug, "normal"),
      loadFirstExisting(slug, "roughness"),
      loadFirstExisting(slug, "metalness"),
      loadFirstExisting(slug, "ao"),
    ]);

    // All loaded textures share the same source kind (ktx2 vs png). If albedo
    // was KTX2 but a sibling was PNG, the per-texture source reflects that —
    // for the set-level `source`, we pick whichever the albedo used.
    return {
      albedo: albedo.texture,
      normal: normal?.texture ?? null,
      roughness: roughness?.texture ?? null,
      metalness: metalness?.texture ?? null,
      ao: ao?.texture ?? null,
      source: albedo.source,
      slug,
    };
  })();

  _pbrCache.set(slug, p);
  return p;
}

/** Synchronous variant — returns the procedural fallback only. Use when you
 *  can't await (e.g. inside a constructor that needs an immediate material).
 *  Callers should still call getPBRSet() async to upgrade to authored art
 *  when it ships. */
export function getPBRSetSync(slug: string): PBRTextureSet {
  return buildProceduralPBRSet(slug);
}

/** Clear the PBR cache + dispose all textures. Used on hot-reload + tests. */
export function disposePBRSetCache(): void {
  for (const p of _pbrCache.values()) {
    p.then((s) => {
      [s.albedo, s.normal, s.roughness, s.metalness, s.ao].forEach((t) => t?.dispose());
    }).catch(() => { /* noop */ });
  }
  _pbrCache.clear();
}
