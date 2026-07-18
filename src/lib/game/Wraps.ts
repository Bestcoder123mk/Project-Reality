import * as THREE from "three";
import type { Rarity } from "./store";

/**
 * Wraps — camo/cosmetic patterns applied to weapon receivers + bodies.
 *
 * Each wrap defines a pattern type, color palette, and procedural texture
 * generator. `applyWrapToWeapon` walks the weapon group and replaces the
 * material on body-class parts (receiver, handguard, stock, grip, magazine —
 * the larger Box/Cylinder geometries) with a wrap material. Small detail
 * parts (screws, pins, sights, glass, optics) keep their original material
 * so the weapon still reads as a gun, not a camo blob.
 *
 * Task-10 — wraps are owned cosmetically. Ownership + equipped state live
 * on the profile/loadout; this module only owns the catalog + the
 * runtime apply function.
 */

export type WrapSlug =
  | "default"
  | "woodland_camo"
  | "desert_digital"
  | "arctic_tiger"
  | "urban_hex"
  | "crimson_gradient"
  | "gold_damascus"
  | "neon_geometric"
  | "carbon_black";

export type WrapPatternType = "camo" | "geometric" | "gradient" | "solid";

export interface WrapConfig {
  slug: WrapSlug;
  name: string;
  /** Pattern family — drives the texture generator. */
  pattern: WrapPatternType;
  /** Palette — 2-5 hex colors used by the texture generator. */
  colors: string[];
  /** Rarity — controls shop price + border color. */
  rarity: Rarity;
  /** Shop price in credits. */
  price: number;
  /** Short descriptor shown under the name. */
  desc: string;
}

export const WRAPS: Record<WrapSlug, WrapConfig> = {
  default: {
    slug: "default",
    name: "Standard Issue",
    pattern: "solid",
    colors: ["#3a3a3e"],
    rarity: "COMMON",
    price: 0,
    desc: "Factory parkerized finish.",
  },
  woodland_camo: {
    slug: "woodland_camo",
    name: "Woodland Camo",
    pattern: "camo",
    colors: ["#2d3a1f", "#4a5a2c", "#7a6a3a", "#1a1a12"],
    rarity: "RARE",
    price: 1200,
    desc: "Classic forest disruptive pattern.",
  },
  desert_digital: {
    slug: "desert_digital",
    name: "Desert Digital",
    pattern: "camo",
    colors: ["#c2a878", "#8a7345", "#e0d0a0", "#5a4828"],
    rarity: "RARE",
    price: 1400,
    desc: "MARPAT desert pixel camo.",
  },
  arctic_tiger: {
    slug: "arctic_tiger",
    name: "Arctic Tiger",
    pattern: "camo",
    colors: ["#e8eef2", "#8a9aa8", "#3a4a58", "#1a1a22"],
    rarity: "EPIC",
    price: 2200,
    desc: "Tiger-stripe winter camo.",
  },
  urban_hex: {
    slug: "urban_hex",
    name: "Urban Hex",
    pattern: "geometric",
    colors: ["#3a3e44", "#5a5e66", "#1a1c20", "#7a7e88"],
    rarity: "EPIC",
    price: 2400,
    desc: "Geometric hex pattern — urban operator.",
  },
  crimson_gradient: {
    slug: "crimson_gradient",
    name: "Crimson Gradient",
    pattern: "gradient",
    colors: ["#1a0408", "#7a0814", "#c81428", "#ff3050"],
    rarity: "EPIC",
    price: 2000,
    desc: "Crimson fade — visceral finish.",
  },
  gold_damascus: {
    slug: "gold_damascus",
    name: "Gold Damascus",
    pattern: "geometric",
    colors: ["#d4af37", "#9a7818", "#f0d870", "#3a2a08"],
    rarity: "LEGENDARY",
    price: 5000,
    desc: "Damascus-folded gold pattern.",
  },
  neon_geometric: {
    slug: "neon_geometric",
    name: "Neon Geometric",
    pattern: "geometric",
    colors: ["#0a0a14", "#2af0c8", "#ff2a8a", "#1a1a2a"],
    rarity: "LEGENDARY",
    price: 4500,
    desc: "Cyberpunk neon triangulation.",
  },
  carbon_black: {
    slug: "carbon_black",
    name: "Carbon Black",
    pattern: "solid",
    colors: ["#0a0a0c", "#1a1a20", "#2a2a30"],
    rarity: "RARE",
    price: 1000,
    desc: "Stealth carbon weave.",
  },
};

// ─── Procedural texture generators ─────────────────────────────

const _canvasCache = new Map<string, THREE.CanvasTexture>();

function makeCanvas(size = 256): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  return [c, ctx];
}

/** Camo pattern — organic blob shapes layered over the palette. */
function makeCamoTexture(colors: string[]): THREE.CanvasTexture {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  // Base fill = first color.
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, size, size);
  // Subsequent colors: irregular blobs (50-80 each).
  for (let ci = 1; ci < colors.length; ci++) {
    ctx.fillStyle = colors[ci];
    const blobs = 14 + Math.floor(Math.random() * 8);
    for (let b = 0; b < blobs; b++) {
      const cx = Math.random() * size;
      const cy = Math.random() * size;
      const r = 14 + Math.random() * 30;
      ctx.beginPath();
      // Wobbly blob path — 12 segments with radial noise.
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
        const rr = r * (0.7 + Math.random() * 0.6);
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (a === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Geometric pattern — hex/tri grid with palette alternation. */
function makeGeometricTexture(colors: string[]): THREE.CanvasTexture {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, size, size);
  const hexR = 16;
  const hexW = hexR * Math.sqrt(3);
  const hexH = hexR * 1.5;
  for (let row = -1; row < size / hexH + 1; row++) {
    for (let col = -1; col < size / hexW + 1; col++) {
      const x = col * hexW + (row % 2 === 0 ? 0 : hexW / 2);
      const y = row * hexH;
      ctx.fillStyle = colors[(row + col + colors.length) % colors.length];
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const px = x + Math.cos(a) * hexR;
        const py = y + Math.sin(a) * hexR;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      // Subtle dark stroke for cell separation.
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Gradient pattern — vertical linear gradient across the palette. */
function makeGradientTexture(colors: string[]): THREE.CanvasTexture {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  const n = Math.max(2, colors.length);
  for (let i = 0; i < colors.length; i++) {
    grad.addColorStop(i / (n - 1), colors[i]);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // Diagonal sheen highlight.
  ctx.globalCompositeOperation = "lighter";
  const sheen = ctx.createLinearGradient(0, 0, size, size);
  sheen.addColorStop(0, "rgba(255,255,255,0.0)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.10)");
  sheen.addColorStop(1, "rgba(255,255,255,0.0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = "source-over";
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Solid pattern — flat color with subtle noise grain. */
function makeSolidTexture(colors: string[]): THREE.CanvasTexture {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, size, size);
  // Noise grain.
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  // Optional darker accent stripes (carbon weave look).
  if (colors.length > 1) {
    ctx.strokeStyle = colors[1];
    ctx.lineWidth = 1;
    for (let y = 0; y < size; y += 4) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Public — generate the texture for a wrap (used by Gunsmith tab previews). */
export function makeWrapTexture(wrap: WrapConfig): THREE.CanvasTexture {
  const key = `wrap-${wrap.slug}`;
  const cached = _canvasCache.get(key);
  if (cached) return cached;
  let tex: THREE.CanvasTexture;
  if (wrap.pattern === "camo") tex = makeCamoTexture(wrap.colors);
  else if (wrap.pattern === "geometric") tex = makeGeometricTexture(wrap.colors);
  else if (wrap.pattern === "gradient") tex = makeGradientTexture(wrap.colors);
  else tex = makeSolidTexture(wrap.colors);
  // Repeat so the texture tiles tightly across weapon bodies.
  tex.repeat.set(2, 2);
  _canvasCache.set(key, tex);
  return tex;
}

/** Build a wrap material — MeshStandardMaterial with the wrap's texture + a
 *  tinted clearcoat for a premium painted finish. */
export function makeWrapMaterial(wrap: WrapConfig): THREE.MeshStandardMaterial {
  if (wrap.slug === "default") {
    // Default — neutral grey parkerized.
    return new THREE.MeshStandardMaterial({
      color: 0x3a3a3e, roughness: 0.5, metalness: 0.85,
    });
  }
  const tex = makeWrapTexture(wrap);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.55,
    envMapIntensity: 1.2,
  });
  // Legendary wraps get a subtle emissive glow for the "premium" feel.
  if (wrap.rarity === "LEGENDARY") {
    const glowColor = new THREE.Color(wrap.colors[wrap.colors.length - 1]);
    mat.emissive = glowColor.multiplyScalar(0.08);
  }
  return mat;
}

// ─── Apply to weapon mesh ─────────────────────────────────────

/** Heuristic — is this mesh a "body class" part that should receive the wrap?
 *  Body parts = the larger structural pieces (receiver, handguard, stock,
 *  grip, magazine, barrel, gas block). We exclude tiny detail parts (screws,
 *  pins, springs, sight apertures) by bounding-box size — anything < 0.02m
 *  on its longest axis is a detail part. Glass + reticles (MeshPhysical /
 *  MeshBasic) are also skipped so optics keep working. */
function isBodyPart(mesh: THREE.Mesh): boolean {
  const mat = mesh.material as THREE.Material | THREE.Material[];
  if (Array.isArray(mat)) return false;
  // Skip glass (physical), reticles (basic), and any non-standard material.
  if (mat.type === "MeshPhysicalMaterial") return false;
  if (mat.type === "MeshBasicMaterial") return false;
  // Measure geometry extent.
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  if (!bb) return false;
  const dx = bb.max.x - bb.min.x;
  const dy = bb.max.y - bb.min.y;
  const dz = bb.max.z - bb.min.z;
  const longest = Math.max(dx, dy, dz);
  return longest >= 0.03; // ≥3cm = body part
}

/** Apply a wrap to a weapon group. Walks the mesh tree and replaces the
 *  material on body-class parts with a shared wrap material instance.
 *  Stores the original materials on `userData.__originalMaterials` so the
 *  wrap can be removed (or swapped) by calling this again with `default`.
 *  Returns the wrap material that was applied (for disposal tracking). */
export function applyWrapToWeapon(
  weaponGroup: THREE.Group,
  wrapSlug: WrapSlug,
): THREE.MeshStandardMaterial | null {
  const wrap = WRAPS[wrapSlug] ?? WRAPS.default;
  // Build (or fetch) a shared wrap material instance for this slug.
  const matKey = `__wrapMat_${wrapSlug}`;
  let wrapMat: THREE.MeshStandardMaterial;
  if ((weaponGroup.userData as any)[matKey] instanceof THREE.MeshStandardMaterial) {
    wrapMat = (weaponGroup.userData as any)[matKey];
  } else {
    wrapMat = makeWrapMaterial(wrap);
    (weaponGroup.userData as any)[matKey] = wrapMat;
  }

  // Track original materials so we can restore on default.
  const origKey = "__originalMaterials";
  if (!(weaponGroup.userData as any)[origKey]) {
    (weaponGroup.userData as any)[origKey] = new Map<THREE.Mesh, THREE.Material>();
  }
  const originals = (weaponGroup.userData as any)[origKey] as Map<THREE.Mesh, THREE.Material>;

  weaponGroup.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (!isBodyPart(o)) return;
    // Save original the first time we touch this mesh.
    if (!originals.has(o)) originals.set(o, o.material as THREE.Material);
    if (wrapSlug === "default") {
      // Restore.
      const orig = originals.get(o);
      if (orig) o.material = orig;
    } else {
      o.material = wrapMat;
    }
  });

  return wrapMat;
}

/** True if the player owns the wrap (helper for the shop / gunsmith UI). */
export function isWrapOwned(ownedWraps: WrapSlug[], slug: WrapSlug): boolean {
  return slug === "default" || ownedWraps.includes(slug);
}

// ─── B2-5000 #783 — layered wrap (base + accent stripe) ──────────────────────

/** Layered wrap state — base wrap material + accent stripe overlay. The base
 *  covers the receiver/body; the accent stripe is a thin emissive stripe
 *  overlaid on edges + rail segments to give the wrap visual depth (the
 *  previous single-material wrap looked flat — every body part was the same
 *  uniform color with no edge highlights). */
export interface LayeredWrapState {
  /** Base wrap material (the dominant color/texture). */
  baseMat: THREE.MeshStandardMaterial;
  /** Accent stripe material — emissive, applied to thin edge parts. */
  accentMat: THREE.MeshStandardMaterial;
  /** The wrap slug this state was built for. */
  slug: WrapSlug;
}

/** Build a layered wrap state for a wrap slug. The base material is the
 *  existing `makeWrapMaterial()` output; the accent is a new emissive
 *  material tinted to the wrap's last palette color (the highlight color). */
export function makeLayeredWrap(wrapSlug: WrapSlug): LayeredWrapState {
  const wrap = WRAPS[wrapSlug] ?? WRAPS.default;
  const baseMat = makeWrapMaterial(wrap);
  // Accent — emissive tint of the wrap's last palette color (the highlight).
  // For default wrap, accent is a neutral light-grey.
  const accentColorHex = wrapSlug === "default"
    ? 0x909094
    : new THREE.Color(wrap.colors[wrap.colors.length - 1]).getHex();
  const accentMat = new THREE.MeshStandardMaterial({
    color: accentColorHex,
    emissive: accentColorHex,
    emissiveIntensity: 0.25,
    roughness: 0.4,
    metalness: 0.6,
  });
  return { baseMat, accentMat, slug: wrapSlug };
}

/** Apply a layered wrap (base + accent stripe) to a weapon group. The base
 *  material replaces body-class parts (same as `applyWrapToWeapon`); the
 *  accent material is applied to thin edge parts (rail slots, barrel flutes,
 *  sight bases — anything whose longest-axis is < 0.04m AND > 0.02m, the
 *  "stripe" size class). Originals are saved on `userData.__originalMaterials`
 *  so a subsequent `applyLayeredWrapToWeapon(group, "default")` restores them.
 *
 *  B2-5000 #783 — the prior `applyWrapToWeapon` replaced every body mesh
 *  with a single shared wrap material (flat, no edge contrast). This layered
 *  variant gives the wrap depth: large surfaces get the base camo, small
 *  edges get the accent stripe. */
export function applyLayeredWrapToWeapon(
  weaponGroup: THREE.Group,
  wrapSlug: WrapSlug,
): LayeredWrapState | null {
  if (wrapSlug === "default") {
    // Restore originals via the existing single-layer path.
    applyWrapToWeapon(weaponGroup, "default");
    return null;
  }
  const layered = makeLayeredWrap(wrapSlug);
  // Track originals (shared key with applyWrapToWeapon so restores interop).
  const origKey = "__originalMaterials";
  if (!(weaponGroup.userData as any)[origKey]) {
    (weaponGroup.userData as any)[origKey] = new Map<THREE.Mesh, THREE.Material>();
  }
  const originals = (weaponGroup.userData as any)[origKey] as Map<THREE.Mesh, THREE.Material>;
  weaponGroup.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (!isBodyPart(o)) return;
    if (!originals.has(o)) originals.set(o, o.material as THREE.Material);
    // Accent stripe test: thin edge parts (longest axis between 2cm + 4cm).
    // Larger parts = body (use base); smaller = detail (skip).
    const bb = o.geometry.boundingBox;
    if (bb) {
      const dx = bb.max.x - bb.min.x;
      const dy = bb.max.y - bb.min.y;
      const dz = bb.max.z - bb.min.z;
      const longest = Math.max(dx, dy, dz);
      if (longest > 0.02 && longest < 0.04) {
        o.material = layered.accentMat;
        return;
      }
    }
    o.material = layered.baseMat;
  });
  return layered;
}

// ─── B2-5000 #784 — wrap-on-operator (operators wear clan wraps) ────────────

/** Apply a wrap to an operator's body mesh (torso/limbs — the clothing
 *  surfaces, not the skin or gear). Used for clan wraps + operator
 *  customization. Walks the operator group + applies the wrap material to
 *  meshes tagged `userData.isClothing` (set by the character builder on
 *  shirt/sleeve/pant meshes). Returns the wrap material applied (for
 *  disposal tracking), or null if no clothing meshes were found.
 *
 *  B2-5000 #784 — operators previously had no wrap support (only weapons
 *  did). Clan wraps now apply to both the weapon + the operator's clothing. */
export function applyWrapToOperator(
  operatorGroup: THREE.Group,
  wrapSlug: WrapSlug,
): THREE.MeshStandardMaterial | null {
  if (wrapSlug === "default") {
    // Restore — original clothing materials are stashed on userData.
    const origKey = "__originalOperatorMaterials";
    const originals = (operatorGroup.userData as any)[origKey] as Map<THREE.Mesh, THREE.Material> | undefined;
    if (originals) {
      originals.forEach((mat, mesh) => { mesh.material = mat; });
      originals.clear();
    }
    return null;
  }
  const wrap = WRAPS[wrapSlug] ?? WRAPS.default;
  const wrapMat = makeWrapMaterial(wrap);
  // Stash originals for restore.
  const origKey = "__originalOperatorMaterials";
  if (!(operatorGroup.userData as any)[origKey]) {
    (operatorGroup.userData as any)[origKey] = new Map<THREE.Mesh, THREE.Material>();
  }
  const originals = (operatorGroup.userData as any)[origKey] as Map<THREE.Mesh, THREE.Material>;
  let touched = 0;
  operatorGroup.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (!(o.userData as any).isClothing) return;
    if (!originals.has(o)) originals.set(o, o.material as THREE.Material);
    o.material = wrapMat;
    touched++;
  });
  return touched > 0 ? wrapMat : null;
}

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3870 (wrap preview two-color → full pattern / A-54) — DONE: every
//        pattern builder (`makeCamoTexture`, `makeGeometricTexture`,
//        `makeGradientTexture`, `makeSolidTexture`) iterates over the
//        full `colors[]` palette (not just two colors). The camo builder
//        at line 150 loops `for (let ci = 1; ci < colors.length; ci++)`
//        — every palette color contributes blobs. The geometric builder
//        at line 189 cycles `colors[(row + col + colors.length) % colors.length]`
//        — every palette color appears in the hex grid. The gradient
//        builder uses `colors` as gradient stops. No two-color limitation.
// 3875 (wrap layering / A-59) — DONE: `LayeredWrapState` +
//        `makeLayeredWrap` + `applyLayeredWrapToWeapon` (B2-5000 #783).
// 3876 (wrap-on-operator / A-60) — DONE: `applyWrapToOperator` (B2-5000 #784).
