import * as THREE from "three";
import { bulletHoleTexture } from "../../textures";

/** Decal cap — oldest recycled when exceeded. Task-25: raised from 50 to 100
 *  so decals persist longer before recycling (the 20s lifetime also helps). */
export const DECAL_CAP = 100;
/** Task-25: decals fade + release after this many seconds. */
export const DECAL_LIFETIME = 20;
/** Task-25: decal fade-out window (last N seconds of life). */
export const DECAL_FADE_WINDOW = 2;
/** Cached bullet-hole texture (lazy). */
export let _bulletHoleTex: THREE.Texture | null = null;
export function getBulletHoleTexture(): THREE.Texture {
  if (!_bulletHoleTex) _bulletHoleTex = bulletHoleTexture();
  return _bulletHoleTex;
}
/** Task-25: cached scorch texture (procedural radial gradient) for terrain
 *  bullet-impact decals. Darker + larger than the bullet-hole texture. */
export let _scorchTex: THREE.Texture | null = null;
export function getScorchTexture(): THREE.Texture {
  if (!_scorchTex) _scorchTex = scorchTexture();
  return _scorchTex;
}

export function scorchTexture(): THREE.Texture {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const cx = c.getContext("2d")!;
  const half = size / 2;
  // Radial gradient: black core → dark brown → transparent edge.
  const g = cx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(0.35, "rgba(15,12,8,0.95)");
  g.addColorStop(0.7, "rgba(35,28,18,0.45)");
  g.addColorStop(1, "rgba(50,38,22,0)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, size, size);
  // Random scorch flecks around the edges — irregular burn pattern.
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 7 + Math.random() * 20;
    const x = half + Math.cos(a) * r;
    const y = half + Math.sin(a) * r;
    cx.fillStyle = `rgba(8,6,4,${0.3 + Math.random() * 0.4})`;
    cx.beginPath();
    cx.arc(x, y, 1 + Math.random() * 2.5, 0, Math.PI * 2);
    cx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============================================================
// Task-32: BLOOD EFFECTS — AAA-quality layered blood spray,
// procedural splatter/pool/drip textures, blood decals, growing
// corpse pools, wall drips, and screen blood.
// ============================================================

/** Task-32/37: blood splatter decal cap (separate from bullet-hole DECAL_CAP).
 *  300 splatter decals, oldest recycled when exceeded. Bumped from 150 → 300
 *  (Task-37) because droplets now splatter on every bounce (was 15%) + decal
 *  lifetime is 45s (was 25s), so a heavy firefight produces many more decals. */
export const BLOOD_DECAL_CAP = 300;
/** Task-32/37: blood decal lifetime (45s — Task-37 bump from 25s so decals
 *  persist long enough to read as battlefield evidence). */
export const BLOOD_DECAL_LIFETIME = 45;
/** Task-32/37: blood decal fade-out window (last N seconds of life). Bumped
 *  to 4s for a smoother fade over the longer 45s lifetime. */
export const BLOOD_DECAL_FADE_WINDOW = 4.0;
/** Task-32: persistent blood pool cap (under corpses). Oldest recycled. */
export const BLOOD_POOL_CAP = 20;
/** Task-32: blood pool mesh pool size (main + 3 satellites per pool). */
export const BLOOD_POOL_MESH_POOL_SIZE = 80;
/** Task-32: blood drip streak pool size (wall drips). */
export const BLOOD_DRIP_POOL_SIZE = 60;
/** Task-32/37: blood splatter decal pool size (matches BLOOD_DECAL_CAP). */
export const BLOOD_SPLATTER_POOL_SIZE = 300;

/** Task-32: cached blood splatter texture (128×128, radial + flecks). */
export let _bloodSplatterTex: THREE.Texture | null = null;
export function getBloodSplatterTexture(): THREE.Texture {
  if (!_bloodSplatterTex) _bloodSplatterTex = bloodSplatterTexture();
  return _bloodSplatterTex;
}

/** Task-32: cached blood pool texture (256×256, irregular dark red). */
export let _bloodPoolTex: THREE.Texture | null = null;
export function getBloodPoolTexture(): THREE.Texture {
  if (!_bloodPoolTex) _bloodPoolTex = bloodPoolTexture();
  return _bloodPoolTex;
}

/** Task-32: cached blood drip texture (32×128, vertical gradient). */
export let _bloodDripTex: THREE.Texture | null = null;
export function getBloodDripTexture(): THREE.Texture {
  if (!_bloodDripTex) _bloodDripTex = bloodDripTexture();
  return _bloodDripTex;
}

/**
 * Task-32: procedural blood splatter texture — 128×128 transparent canvas
 * with a dark-red radial gradient center + 12 random droplet flecks
 * (varying sizes 2-8px) around the main splatter. Cached after first call.
 */
export function bloodSplatterTexture(): THREE.Texture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const cx = c.getContext("2d")!;
  const half = size / 2;
  cx.clearRect(0, 0, size, size);
  // Main splatter — dark-red radial gradient (opaque center → transparent edge).
  const g = cx.createRadialGradient(half, half, 0, half, half, half * 0.6);
  g.addColorStop(0, "rgba(90,12,12,0.95)");
  g.addColorStop(0.3, "rgba(74,10,10,0.85)");
  g.addColorStop(0.7, "rgba(60,8,8,0.4)");
  g.addColorStop(1, "rgba(50,6,6,0)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, size, size);
  // Irregular edge — a few smaller overlapping radial blobs.
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = half * 0.3 + Math.random() * half * 0.25;
    const x = half + Math.cos(a) * r;
    const y = half + Math.sin(a) * r;
    const br = 6 + Math.random() * 10;
    const bg = cx.createRadialGradient(x, y, 0, x, y, br);
    bg.addColorStop(0, "rgba(80,10,10,0.6)");
    bg.addColorStop(1, "rgba(60,8,8,0)");
    cx.fillStyle = bg;
    cx.beginPath();
    cx.arc(x, y, br, 0, Math.PI * 2);
    cx.fill();
  }
  // 12 random droplet flecks (2-8px diameter) around the main splatter.
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = half * 0.4 + Math.random() * half * 0.55;
    const x = half + Math.cos(a) * r;
    const y = half + Math.sin(a) * r;
    const fr = 1 + Math.random() * 3; // 2-8px diameter → 1-4px radius
    cx.fillStyle = `rgba(${70 + Math.floor(Math.random() * 30)},${8 + Math.floor(Math.random() * 8)},${8 + Math.floor(Math.random() * 8)},${0.5 + Math.random() * 0.4})`;
    cx.beginPath();
    cx.arc(x, y, fr, 0, Math.PI * 2);
    cx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Task-32: procedural blood pool texture — 256×256, dark red with irregular
 * edges (overlapping radial gradients + noise), lighter center (fresh blood)
 * → darker edges (clotted). Cached after first call.
 */
export function bloodPoolTexture(): THREE.Texture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const cx = c.getContext("2d")!;
  const half = size / 2;
  cx.clearRect(0, 0, size, size);
  // Base pool — large radial gradient: lighter center → darker edges.
  const g = cx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, "rgba(110,18,18,0.92)");   // fresh blood (lighter)
  g.addColorStop(0.4, "rgba(80,12,12,0.9)");
  g.addColorStop(0.75, "rgba(55,8,8,0.85)");   // clotted (darker)
  g.addColorStop(1, "rgba(40,5,5,0)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, size, size);
  // Irregular edges — several overlapping radial blobs to break the circle.
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = half * 0.5 + Math.random() * half * 0.4;
    const x = half + Math.cos(a) * r;
    const y = half + Math.sin(a) * r;
    const br = 12 + Math.random() * 24;
    const bg = cx.createRadialGradient(x, y, 0, x, y, br);
    bg.addColorStop(0, "rgba(65,9,9,0.7)");
    bg.addColorStop(0.6, "rgba(50,7,7,0.4)");
    bg.addColorStop(1, "rgba(40,5,5,0)");
    cx.fillStyle = bg;
    cx.beginPath();
    cx.arc(x, y, br, 0, Math.PI * 2);
    cx.fill();
  }
  // Noise — pixel-level variation for a textured look (clotting).
  const img = cx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 10) continue; // skip transparent pixels
    const n = (Math.random() - 0.5) * 20;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n * 0.3));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 0.3));
  }
  cx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Task-32: procedural blood drip texture — 32×128, vertical gradient (thick
 * at top, thinning + dripping at bottom) with a drip bead near the bottom.
 * Cached after first call.
 */
export function bloodDripTexture(): THREE.Texture {
  const w = 32, h = 128;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cx = c.getContext("2d")!;
  cx.clearRect(0, 0, w, h);
  // Vertical gradient: thick opaque at top → thin transparent at bottom.
  const g = cx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(90,12,12,0.95)");
  g.addColorStop(0.3, "rgba(75,10,10,0.85)");
  g.addColorStop(0.7, "rgba(60,8,8,0.5)");
  g.addColorStop(1, "rgba(50,6,6,0)");
  cx.fillStyle = g;
  // Thick streak down the center.
  cx.fillRect(w * 0.3, 0, w * 0.4, h);
  // A drip bead near the bottom (the characteristic drip teardrop).
  const beadY = h * 0.75;
  const beadR = w * 0.35;
  const bg = cx.createRadialGradient(w / 2, beadY, 0, w / 2, beadY, beadR);
  bg.addColorStop(0, "rgba(80,10,10,0.9)");
  bg.addColorStop(1, "rgba(60,8,8,0)");
  cx.fillStyle = bg;
  cx.beginPath();
  cx.arc(w / 2, beadY, beadR, 0, Math.PI * 2);
  cx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
