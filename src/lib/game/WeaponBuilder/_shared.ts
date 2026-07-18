import * as THREE from "three";
import {
  makeBrushedMetalTexture,
  makeParkerizedTexture,
  makePolymerTexture,
  makeWoodGrainTexture,
  makeCarbonFiberTexture,
  makeCamoTexture,
  type CamoPattern,
} from "../textures";
import type { LoadoutConfig, WeaponType, SkinSlug } from "../store";
import { SKINS } from "../store";

// ─── Inline normal-map factories (kept local so this file owns its surface
//     finish — metal brushed grain + wood grain normal maps that give the
//     PBR materials micro-surface detail without depending on extra texture
//     exports from textures.ts). ───

let _metalNormal: THREE.Texture | null = null;
/** Brushed-metal normal map: tight horizontal striations from the machining
 *  direction + scattered pitting. Subtle (low strength) so it reads as
 *  surface finish, not damage. */
export function metalNormalTexture(): THREE.Texture {
  if (_metalNormal) return _metalNormal;
  // A2-5000 #261 — SSR guard: return a plain texture on the server (was
  // unconditional document.createElement which threw during Next.js prerender).
  if (typeof document === "undefined") return new THREE.Texture();
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  // Base flat normal (128,128,255 = neutral).
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, size, size);
  // Horizontal brushed striations — slight blue/red shift along the X axis.
  for (let i = 0; i < 220; i++) {
    const y = Math.random() * size;
    const intensity = 6 + Math.random() * 10;
    ctx.strokeStyle = `rgb(${128 - intensity},${128 + intensity},255)`;
    ctx.lineWidth = 0.5 + Math.random() * 0.8;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 2);
    ctx.stroke();
  }
  // Scattered micro-pits — small dark bumps (low R, high G = downward dent).
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.6 + Math.random() * 1.4;
    ctx.fillStyle = `rgb(${120},${132},255)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace; // normal maps are linear
  _metalNormal = tex;
  return tex;
}

let _woodNormal: THREE.Texture | null = null;
/** Wood-grain normal map: long wavy streaks following the grain + occasional
 *  knot bumps. Gives AK/Nova wood furniture a tactile grain feel. */
export function woodNormalTexture(): THREE.Texture {
  if (_woodNormal) return _woodNormal;
  // A2-5000 #261 — SSR guard.
  if (typeof document === "undefined") return new THREE.Texture();
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, size, size);
  // Grain streaks — long horizontal wavy lines (low-frequency height variation).
  for (let i = 0; i < 40; i++) {
    const y = (i / 40) * size + (Math.random() - 0.5) * 6;
    const intensity = 8 + Math.random() * 14;
    ctx.strokeStyle = `rgb(${128 - intensity},${128 + intensity},255)`;
    ctx.lineWidth = 0.6 + Math.random() * 1.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x < size; x += 6) {
      ctx.lineTo(x, y + Math.sin(x * 0.04 + i) * 2);
    }
    ctx.stroke();
  }
  // Open-pore dots — wood pores read as small dark bumps.
  for (let i = 0; i < 120; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = `rgb(${118},${138},255)`;
    ctx.beginPath();
    ctx.arc(x, y, 0.4 + Math.random() * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  _woodNormal = tex;
  return tex;
}

let _polymerNormal: THREE.Texture | null = null;
/** Polymer normal map: matte pebbled texture (scattered hemispherical bumps)
 *  for plastic furniture — grip, stock, handguard. */
export function polymerNormalTexture(): THREE.Texture {
  if (_polymerNormal) return _polymerNormal;
  // A2-5000 #261 — SSR guard.
  if (typeof document === "undefined") return new THREE.Texture();
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, size, size);
  // Pebble grain — random soft bumps across the surface.
  for (let i = 0; i < 800; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.4 + Math.random() * 1.6;
    const up = Math.random() > 0.5;
    const sh = 6 + Math.random() * 8;
    ctx.fillStyle = up
      ? `rgb(${128 - sh},${128 + sh},255)`
      : `rgb(${128 + sh},${128 - sh},255)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  _polymerNormal = tex;
  return tex;
}

/**
 * Detailed procedural weapon builder.
 *
 * Each weapon is assembled from 30-60+ shaped parts with correct real-world
 * anatomy: upper + lower receivers, barrel with gas block and front sight
 * base, handguard with Picatinny rail segments and vent holes, magazine
 * (curved AK banana, straight STANAG, P90 horizontal, pistol box) with feed
 * lips and baseplate, stock (collapsible M4, fixed AK wood, thumbhole
 * sniper), ergonomic pistol grip with texturing, trigger + trigger guard,
 * charging handle (AR T-handle, AK side handle), selector switch, ejection
 * port with brass deflector, front + rear iron sights, and muzzle device
 * (birdcage flash hider with prongs, compensator with top ports).
 *
 * Per-weapon differentiation:
 *   AK-74:  stamped receiver, curved banana mag, wood furniture, side charge
 *   M4:     billet receiver, straight STANAG mag, polymer furniture, T-handle
 *   MP-7:   compact SMG, horizontal mag, top folder stock, polymer body
 *   P90:    bullpup SMG, top-mounted horizontal drum mag, full polymer shell
 *   USP-S:  polymer frame, slide with serrations, compact
 *   Deagle: polygon barrel, slab slide, wood grips, large frame
 *   AWP-X:  bolt-action, heavy fluted barrel, thumbhole stock, big scope
 *   Scout:  bolt-action, lighter barrel, traditional stock, medium scope
 *   Nova:   pump shotgun, dual barrel, tubular mag, wood pump + stock
 *   M249:   squad automatic weapon, belt-fed box mag (side-mounted), heat
 *           shielded heavy barrel, folding bipod, carrying handle, fixed stock
 *
 * All parts use PBR materials calibrated to the V1.3 table:
 *   gunmetal/steel: metalness 0.95, roughness 0.42
 *   parkerized steel: metalness 0.8, roughness 0.65
 *   polymer: metalness 0.0, roughness 0.5
 *   wood: metalness 0.0, roughness 0.62
 *   brass: metalness 0.9, roughness 0.25
 */

// ─── Material factory ───

export interface WeaponMaterials {
  gunmetal: THREE.MeshStandardMaterial;   // bright blued steel — receiver, barrel
  parkerized: THREE.MeshStandardMaterial; // matte dark — gas block, sights
  polymer: THREE.MeshStandardMaterial;    // black furniture — grip, stock
  darkPolymer: THREE.MeshStandardMaterial;// darker accents
  wood: THREE.MeshStandardMaterial;       // AK/AWP/Nova furniture
  brass: THREE.MeshStandardMaterial;      // visible cartridge in ejection port
  accent: THREE.MeshStandardMaterial;     // skin-color accents
  /** Real glass — MeshPhysicalMaterial with transmission for true refraction.
   *  Used on scope objective/ocular lenses, red-dot windows, holo windows. */
  glass: THREE.MeshPhysicalMaterial;
  glassTinted: THREE.MeshPhysicalMaterial; // slightly green-tinted scope glass
  /** Glowing amber reticle material (additive blend, no depth write). */
  reticleGlow: THREE.MeshBasicMaterial;
  /** Glowing red reticle material for red-dot / holo emitters. */
  reticleRed: THREE.MeshBasicMaterial;
  rubber: THREE.MeshStandardMaterial;     // butt pad, grip texture
  anodized: THREE.MeshStandardMaterial;   // anodized aluminum — rails, accents
  cerakote: THREE.MeshStandardMaterial;   // Cerakote finish — colored, matte
  blued: THREE.MeshStandardMaterial;      // dark blued steel — small parts
  /** Slightly rougher gunmetal for worn/edges — varies roughness so the gun
   *  doesn't look uniformly smooth. */
  wornGunmetal: THREE.MeshStandardMaterial;
  /** Glossy gunmetal — MeshPhysicalMaterial with clearcoat for the
   *  "polished/blue-steel" look on premium skins (gold, neon). Clearcoat adds
   *  a real top-coat reflection over the metal base — reads as a lacquered
   *  or hand-polished finish, distinct from the matte gunmetal. */
  glossyGunmetal: THREE.MeshPhysicalMaterial;
  /** Carbon-fiber weave material — uses makeCarbonFiberTexture as both map
   *  and (subtly) as the roughnessMap so the weave reads as resin-impregnated
   *  fiber, not flat black. Used on the "carbon" skin. */
  carbon: THREE.MeshStandardMaterial;
  /** Camo material — wraps the skin's camo pattern (woodland/tiger/arctic/etc).
   *  Replaces the gunmetal base on camo skins so the receiver + furniture read
   *  as a real camo paint job, not flat color. */
  camo: THREE.MeshStandardMaterial | null;
}

/** Map a skin slug → camo pattern (or null = no camo, use plain material).
 *  Tiger skin → tiger stripe, Arctic skin → arctic camo, others → null. */
export function skinCamoPattern(skinSlug: SkinSlug): CamoPattern | null {
  switch (skinSlug) {
    case "tiger": return "tiger";
    case "arctic": return "arctic";
    // Future: add "woodland", "desert", "urban", "digital" for additional skins.
    default: return null;
  }
}

export function makeMaterials(skinColor: THREE.Color, skinSlug: SkinSlug = "default"): WeaponMaterials {
  // V2-c — PBR material upgrade: use the realistic procedural textures from
  // textures.ts (brushed metal streaks, parkerized mottling, stippled polymer,
  // ring-pattern wood grain) instead of the simpler metalTexture/woodTexture.
  // The legacy textures are still imported for backward-compat on existing
  // weapon builds that may still reference them by name.
  const metalTex = makeBrushedMetalTexture(skinColor.clone().multiplyScalar(0.72));
  const parkTex = makeParkerizedTexture();
  const polyTex = makePolymerTexture(skinColor.clone().multiplyScalar(0.3));
  const darkPolyTex = makePolymerTexture(skinColor.clone().multiplyScalar(0.2));
  const woodTex = makeWoodGrainTexture();
  const carbonTex = makeCarbonFiberTexture();
  const metalNorm = metalNormalTexture();
  const woodNorm = woodNormalTexture();
  const polyNorm = polymerNormalTexture();
  // Camo texture — only built for camo-pattern skins (tiger, arctic, ...).
  const camoPattern = skinCamoPattern(skinSlug);
  const camoTex = camoPattern ? makeCamoTexture(camoPattern) : null;

  // Brushed-metal base for the gunmetal — horizontal anisotropic streaks give
  // the receiver that CNC-milled look. PBR values: metalness 0.92 (steel-like
  // reflectivity), roughness 0.42 (slightly polished but not mirror).
  return {
    gunmetal: new THREE.MeshStandardMaterial({
      color: skinColor.clone().multiplyScalar(0.72), roughness: 0.42, metalness: 0.95, envMapIntensity: 1.5,
      map: metalTex, normalMap: metalNorm, normalScale: new THREE.Vector2(0.35, 0.35),
    }),
    parkerized: new THREE.MeshStandardMaterial({
      // Parkerized — uses the dedicated mottled parkerized texture for a real
      // phosphate-finish look (matte dark gunmetal with subtle non-uniform
      // color zones). Metalness 0.8 (slightly lower than gunmetal — parkerizing
      // reduces reflectivity), roughness 0.65 (matte).
      color: skinColor.clone().multiplyScalar(0.45), roughness: 0.65, metalness: 0.8, envMapIntensity: 1.2,
      map: parkTex, normalMap: metalNorm, normalScale: new THREE.Vector2(0.5, 0.5),
    }),
    polymer: new THREE.MeshStandardMaterial({
      // Polymer — uses the stippled polymer texture for the grip/stock surface.
      // Metalness 0.0 (plastic, not metal), roughness 0.5 (matte but not chalky).
      color: skinColor.clone().multiplyScalar(0.3), roughness: 0.5, metalness: 0.0, envMapIntensity: 0.9,
      map: polyTex, normalMap: polyNorm, normalScale: new THREE.Vector2(0.6, 0.6),
    }),
    darkPolymer: new THREE.MeshStandardMaterial({
      color: skinColor.clone().multiplyScalar(0.2), roughness: 0.55, metalness: 0.0, envMapIntensity: 0.8,
      map: darkPolyTex, normalMap: polyNorm, normalScale: new THREE.Vector2(0.5, 0.5),
    }),
    wood: new THREE.MeshStandardMaterial({
      // Wood — uses the new ring-pattern wood grain texture (concentric rings +
      // long wavy grain streaks + occasional knots). Far more realistic than
      // the old plank-style woodTexture.
      map: woodTex, color: 0x6b4226, roughness: 0.62, metalness: 0.0, envMapIntensity: 0.8,
      normalMap: woodNorm, normalScale: new THREE.Vector2(0.8, 0.8),
    }),
    brass: new THREE.MeshStandardMaterial({
      color: 0xb8860b, roughness: 0.25, metalness: 0.9, envMapIntensity: 1.3,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: skinColor, roughness: 0.48, metalness: 0.6, emissive: skinColor.clone().multiplyScalar(0.12), envMapIntensity: 1.2,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      // Real glass — transmission gives true refraction through the lens.
      // Slight blue tint + high envMapIntensity catches sky reflections.
      color: 0xb8d8e8, roughness: 0.05, metalness: 0.0,
      transmission: 0.92, thickness: 0.02, ior: 1.5,
      transparent: true, opacity: 0.9,
      envMapIntensity: 2.5,
      clearcoat: 1.0, clearcoatRoughness: 0.04,
      attenuationColor: new THREE.Color(0xa0c8d8), attenuationDistance: 0.4,
      side: THREE.DoubleSide,
    }),
    glassTinted: new THREE.MeshPhysicalMaterial({
      // Slightly green-tinted glass (coated scope lens look).
      color: 0xa8c8a0, roughness: 0.04, metalness: 0.0,
      transmission: 0.88, thickness: 0.02, ior: 1.52,
      transparent: true, opacity: 0.88,
      envMapIntensity: 2.8,
      clearcoat: 1.0, clearcoatRoughness: 0.03,
      attenuationColor: new THREE.Color(0x88b878), attenuationDistance: 0.35,
      side: THREE.DoubleSide,
    }),
    reticleGlow: new THREE.MeshBasicMaterial({
      // Glowing amber reticle — additive blend, no depth write so it always
      // reads on top of the glass. Toned down from 0xff8c1a (bright amber)
      // to 0xff7a14 (deeper, less yellow) — was reading as an "oversized
      // yellow scope" against bright backgrounds.
      color: 0xff7a14, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    reticleRed: new THREE.MeshBasicMaterial({
      // Glowing red dot / holo reticle — bright, additive.
      color: 0xff2018, transparent: true, opacity: 0.98,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    rubber: new THREE.MeshStandardMaterial({
      color: 0x1a1a1c, roughness: 0.85, metalness: 0.0,
    }),
    anodized: new THREE.MeshStandardMaterial({
      // Anodized aluminum — slightly tinted, semi-matte, high metalness.
      color: skinColor.clone().multiplyScalar(0.35), roughness: 0.4, metalness: 0.9, envMapIntensity: 1.4,
      map: metalTex, normalMap: metalNorm, normalScale: new THREE.Vector2(0.3, 0.3),
    }),
    cerakote: new THREE.MeshStandardMaterial({
      // Cerakote — colored matte ceramic finish, low metalness.
      color: skinColor.clone().multiplyScalar(0.55), roughness: 0.55, metalness: 0.3, envMapIntensity: 0.7,
      map: polyTex, normalMap: polyNorm, normalScale: new THREE.Vector2(0.4, 0.4),
    }),
    blued: new THREE.MeshStandardMaterial({
      // Dark blued steel — small parts (pins, screws, sights).
      color: 0x141418, roughness: 0.5, metalness: 0.92, envMapIntensity: 1.1,
      map: parkTex, normalMap: metalNorm, normalScale: new THREE.Vector2(0.4, 0.4),
    }),
    wornGunmetal: new THREE.MeshStandardMaterial({
      // Worn gunmetal — higher roughness + slightly darker for edges/wear marks.
      color: skinColor.clone().multiplyScalar(0.65), roughness: 0.58, metalness: 0.92, envMapIntensity: 1.3,
      map: metalTex, normalMap: metalNorm, normalScale: new THREE.Vector2(0.4, 0.4),
    }),
    glossyGunmetal: new THREE.MeshPhysicalMaterial({
      // Glossy gunmetal — MeshPhysicalMaterial with clearcoat for premium
      // polished finishes (gold / neon / collectible skins). Clearcoat = 1.0
      // gives a strong top-coat reflection; clearcoatRoughness = 0.08 makes
      // it glossy. Base metalness stays high so the underlying steel still
      // shows through the clearcoat.
      color: skinColor.clone().multiplyScalar(0.75), roughness: 0.3, metalness: 0.92,
      envMapIntensity: 1.8,
      clearcoat: 1.0, clearcoatRoughness: 0.08,
      map: metalTex, normalMap: metalNorm, normalScale: new THREE.Vector2(0.25, 0.25),
    }),
    carbon: new THREE.MeshStandardMaterial({
      // Carbon-fiber weave — high metalness (the resin has metallic flake in
      // some weaves) + low-ish roughness so the weave catches glossy highlights.
      // The map IS the weave pattern; we feed it as both map (albedo) and
      // roughnessMap (the dark tows read as slightly rougher, the resin gaps
      // read as glossier — gives the weave real 3D depth under lighting).
      color: 0x1a1a1e, roughness: 0.35, metalness: 0.6, envMapIntensity: 1.4,
      map: carbonTex, roughnessMap: carbonTex,
      normalMap: metalNorm, normalScale: new THREE.Vector2(0.2, 0.2),
    }),
    camo: camoTex
      ? new THREE.MeshStandardMaterial({
          // Camo paint job — uses the camo texture as the albedo map. Slight
          // roughness variation (camo paint is matte but has subtle sheen).
          color: 0xffffff, roughness: 0.55, metalness: 0.15, envMapIntensity: 0.9,
          map: camoTex,
          normalMap: polyNorm, normalScale: new THREE.Vector2(0.3, 0.3),
        })
      : null,
  };
}

/** Pick the receiver material based on skin slug. Premium / collectible skins
 *  get the glossy clearcoat material (gold, neon), carbon-fiber skin gets the
 *  carbon-weave material, camo skins get the camo-paint material, and the
 *  default skin keeps the brushed-metal gunmetal. Returns the gunmetal
 *  fallback if the requested material is null (e.g., camo material is null
 *  for non-camo skins — the pick function handles that gracefully). */
export function pickReceiverMaterial(skinSlug: SkinSlug, mats: WeaponMaterials): THREE.Material {
  switch (skinSlug) {
    case "gold":
    case "neon":
      // Premium polished finishes — clearcoat gloss.
      return mats.glossyGunmetal;
    case "carbon":
      // Carbon-fiber weave.
      return mats.carbon;
    case "tiger":
    case "arctic":
      // Camo paint job.
      return mats.camo ?? mats.gunmetal;
    default:
      return mats.gunmetal;
  }
}

// ─── Reusable part builders ───

/** Add a box part with cast/receive shadow to a group. */
export function part(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  group.add(m);
  return m;
}

/** Add subtle wear/scratch details to a flat receiver surface. Draws 4-6
 *  thin dark scratches + 2-3 brighter wear highlights on the top face of the
 *  receiver, so the gun doesn't look uniformly smooth. Scratches are very
 *  subtle (thin + low-contrast) — read as finish wear, not damage.
 *  `topY` = the receiver's top-face Y (where scratches sit).
 *  `zMin`/`zMax` = the receiver's Z extent (scratches are scattered within).
 *  `w` = receiver width (scratches stay within ±w/2).
 *
 *  B2-5000 #847 — material + geometry pool. The previous code allocated a
 *  fresh `MeshStandardMaterial` + `BoxGeometry` per scratch per weapon; with
 *  30 weapons × 5 scratches = 150 materials + 150 geometries on initial
 *  catalog build. Now both are module-level singletons shared across all
 *  weapons (the scratch color/roughness never varies; geometry is tiny and
 *  re-used per-instance via `mesh.scale.z = len`). */
export function addWearScratches(
  group: THREE.Group,
  mats: WeaponMaterials,
  topY: number,
  zMin: number,
  zMax: number,
  w: number,
  seed = 1,
): void {
  // Seeded RNG for deterministic scratch placement (stable per weapon).
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // B2-5000 #847 — pooled scratch material (single shared instance).
  if (!_scratchMat) {
    _scratchMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0c, roughness: 0.9, metalness: 0.3,
    });
  }
  // B2-5000 #847 — pooled scratch geometry (unit-length box; scaled per scratch).
  if (!_scratchGeo) {
    _scratchGeo = new THREE.BoxGeometry(0.0015, 0.0005, 1);
  }
  const scratchCount = 5;
  for (let i = 0; i < scratchCount; i++) {
    const z = zMin + rng() * (zMax - zMin);
    const x = (rng() - 0.5) * w * 0.7;
    const len = 0.02 + rng() * 0.04;
    const angle = (rng() - 0.5) * 0.6; // slight random yaw
    const scratch = new THREE.Mesh(_scratchGeo, _scratchMat);
    // Scale the unit-Z geometry to the scratch length.
    scratch.scale.set(1, 1, len);
    scratch.position.set(x, topY + 0.0006, z);
    scratch.rotation.y = angle;
    group.add(scratch);
  }
  // Brighter wear highlights — thin lighter lines (rubbed metal edges).
  const highlightMat = mats.wornGunmetal;
  const highlightCount = 3;
  if (!_highlightGeo) {
    _highlightGeo = new THREE.BoxGeometry(0.0012, 0.0004, 1);
  }
  for (let i = 0; i < highlightCount; i++) {
    const z = zMin + rng() * (zMax - zMin);
    const x = (rng() - 0.5) * w * 0.6;
    const len = 0.015 + rng() * 0.025;
    const highlight = new THREE.Mesh(_highlightGeo, highlightMat);
    highlight.scale.set(1, 1, len);
    highlight.position.set(x, topY + 0.0005, z);
    highlight.rotation.y = (rng() - 0.5) * 0.4;
    group.add(highlight);
  }
}

// B2-5000 #847 — pooled scratch material + geometry (shared across all weapons).
let _scratchMat: THREE.MeshStandardMaterial | null = null;
let _scratchGeo: THREE.BoxGeometry | null = null;
let _highlightGeo: THREE.BoxGeometry | null = null;

// B2-5000 #850 — shared muzzle-offset constants. The per-weapon builders
// previously hard-coded arithmetic like `-0.21 - 0.42 + 0.02` (receiverZ +
// barrelLen + tip_offset), which was opaque + brittle. These constants are
// the single source of truth for the muzzle-offset calculation; builders
// compose them via `muzzleOffset(receiverZ, barrelLen)` below.
export const MUZZLE_TIP_OFFSET = 0.02; // small forward offset so muzzle VFX clears the barrel tip.
export function muzzleOffset(receiverRearZ: number, barrelLen: number): number {
  // receiverRearZ is the Z where the barrel starts (negative — barrel points -Z).
  // barrelLen is the barrel length (positive). The muzzle sits at
  // receiverRearZ - barrelLen + tip_offset.
  return receiverRearZ - barrelLen + MUZZLE_TIP_OFFSET;
}

/** Tapered + beveled receiver — wider at the front (mag well), narrower at
 *  the rear (stock interface), with chamfered top edges (the signature
 *  CNC-milled receiver look — sharp 90° corners read as a flat slab; the
 *  small chamfer catches a highlight along the top edge).
 *  Uses a subdivided box with vertex displacement for the taper + chamfer.
 *  The chamfer is applied by pulling the top edge vertices inward by ~6% of
 *  the width, creating a 2mm bevel along the receiver top on both sides. */
export function buildTaperedReceiver(mat: THREE.Material, w: number, h: number, d: number, taperRear = 0.88): THREE.Mesh {
  // Subdivide X by 2, Y by 2, Z by 4 — gives enough vertices for a clean chamfer
  // along the top edges and a smooth taper toward the rear.
  const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 4);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Rear taper — narrow the rear 30% of the receiver (where the stock meets).
    let nx = x;
    let ny = y;
    if (z > d * 0.3) {
      nx = x * taperRear;
      ny = y * 0.92;
    }
    // Front flare — slight widening at the mag well (z < -d*0.2) for a forged
    // lower look (the mag well bulges outward ~3%).
    if (z < -d * 0.2) {
      nx = nx * 1.04;
    }
    // Top chamfer — bevel the top edges (the top 25% of the height). Pulls
    // the top-most X vertices inward by ~6% of the half-width, creating a
    // small chamfer that catches a highlight along the top of the receiver.
    if (y > h * 0.35) {
      const chamferFactor = 0.94;
      // Only chamfer the outermost X vertices (the edges), not the centerline.
      if (Math.abs(nx) > w * 0.2) {
        nx = nx * chamferFactor;
      }
    }
    // Bottom chamfer — same bevel on the bottom edges (the mag well bottom).
    if (y < -h * 0.35) {
      if (Math.abs(nx) > w * 0.2) {
        nx = nx * 0.94;
      }
    }
    pos.setX(i, nx);
    pos.setY(i, ny);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

/** Picatinny rail segment — scalloped profile with evenly spaced cross-slots.
 *  The classic Picatinny 1913 profile has square slot cross-sections separated
 *  by flat traction areas. We model the slot recesses as dark inset boxes
 *  (giving the rail its scalloped look from the side) plus thin dividers that
 *  catch the light. Optional `cover` adds a rubber rail-cover strip on top. */
export function buildRail(mat: THREE.Material, length: number, width = 0.032, height = 0.012, slots = 8, cover = false): THREE.Group {
  const g = new THREE.Group();
  const base = part(g, new THREE.BoxGeometry(width, height, length), mat);
  base.position.y = height / 2;
  // Slot recesses — dark inset boxes that give the rail its scalloped profile.
  const slotSpacing = length / (slots + 1);
  const recessMat = new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 1 });
  for (let i = 0; i < slots; i++) {
    const z = -length / 2 + slotSpacing * (i + 1);
    // Recessed slot (dark valley between dividers).
    const recess = new THREE.Mesh(new THREE.BoxGeometry(width * 0.92, height * 0.5, 0.006), recessMat);
    recess.position.set(0, height * 0.5, z);
    g.add(recess);
    // Divider fin (raised T-section between slots — clamps optics mounts).
    const fin = part(g, new THREE.BoxGeometry(width * 0.96, height * 0.6, 0.0035), mat);
    fin.position.set(0, height * 0.78, z + slotSpacing * 0.5);
  }
  // Optional rubber rail cover — a ribbed strip on top of the rail.
  if (cover) {
    const coverMat = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.85, metalness: 0.0 });
    const coverMesh = new THREE.Mesh(new THREE.BoxGeometry(width * 0.95, height * 0.4, length * 0.9), coverMat);
    coverMesh.position.set(0, height * 1.15, 0);
    g.add(coverMesh);
    // Ribbing — 5 lateral ribs across the cover for grip texture.
    const ribGeo = new THREE.BoxGeometry(width * 0.95, height * 0.15, 0.004);
    for (let i = 0; i < 5; i++) {
      const z = -length * 0.4 + i * (length * 0.2);
      const rib = new THREE.Mesh(ribGeo, coverMat);
      rib.position.set(0, height * 1.4, z);
      g.add(rib);
    }
  }
  return g;
}

/** Takedown pins — two small domed cylinders on the receiver side (AR-style
 *  front + rear pivot pins). Adds the manufacturing detail that breaks up the
 *  otherwise flat receiver slab. */
export function buildTakedownPins(mats: WeaponMaterials, z1: number, z2: number, side = 1): THREE.Group {
  const g = new THREE.Group();
  const pinGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.012, 10);
  const domeGeo = new THREE.SphereGeometry(0.0065, 8, 6);
  for (const z of [z1, z2]) {
    const pin = new THREE.Mesh(pinGeo, mats.blued);
    pin.rotation.z = Math.PI / 2; // axis along X
    pin.position.set(side * 0.025, 0, z);
    g.add(pin);
    const dome = new THREE.Mesh(domeGeo, mats.blued);
    dome.position.set(side * 0.031, 0, z);
    dome.scale.set(0.6, 1, 1);
    g.add(dome);
  }
  return g;
}

/** Receiver rivets — a row of small domed cylinders on the receiver side
 *  (AK-style stamped-receiver rivet pattern). */
export function buildRivets(mats: WeaponMaterials, zs: number[], side = 1, y = 0): THREE.Group {
  const g = new THREE.Group();
  const rivetGeo = new THREE.SphereGeometry(0.0045, 8, 6);
  for (const z of zs) {
    const rivet = new THREE.Mesh(rivetGeo, mats.parkerized);
    rivet.position.set(side * 0.029, y, z);
    rivet.scale.set(0.55, 1, 1);
    g.add(rivet);
  }
  return g;
}

/** Serial number / manufacturer logo decal — a small dark plane with the
 *  skin accent color border, placed on the receiver side. Reads as a stamped
 *  marking at close range. */
export function buildMarkingDecal(mats: WeaponMaterials, x: number, y: number, z: number, w = 0.03, h = 0.008): THREE.Group {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.9, metalness: 0.2 }),
  );
  bg.position.set(x, y, z);
  bg.rotation.y = x > 0 ? Math.PI / 2 : -Math.PI / 2;
  g.add(bg);
  // Accent border (thin frame around the decal).
  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 1.1, h * 1.4),
    mats.accent,
  );
  frame.position.set(x - Math.sign(x) * 0.0002, y, z - 0.0001);
  frame.rotation.y = x > 0 ? Math.PI / 2 : -Math.PI / 2;
  g.add(frame);
  return g;
}

/** Barrel with stepped profile (thicker at chamber, thinner at muzzle) +
 *  gas block + optional fluting (longitudinal grooves for heat dissipation
 *  + weight reduction — signature on precision/sniper barrels).
 *  The chamber has a slight cone reinforcement (the visible "shank" where
 *  the barrel threads into the receiver), and the muzzle thread ring is a
 *  raised collar (the visible seat for the muzzle device). */
export function buildBarrel(
  mats: WeaponMaterials,
  length: number,
  baseR = 0.022,
  muzzleR = 0.018,
  withGasBlock = true,
  gasBlockZ = 0,
  fluted = false,
): THREE.Group {
  const g = new THREE.Group();
  // Chamber reinforcement — thicker section at the receiver end.
  const chamber = new THREE.Mesh(new THREE.CylinderGeometry(baseR * 1.3, baseR, 0.08, 24), mats.gunmetal);
  chamber.rotation.x = Math.PI / 2; chamber.position.z = -0.04; chamber.castShadow = true; g.add(chamber);
  // Chamber step ring — small collar where the chamber meets the main barrel
  // (a visible step that catches a highlight — real barrel profile detail).
  const step = new THREE.Mesh(new THREE.TorusGeometry(baseR * 1.05, 0.0014, 6, 20), mats.parkerized);
  step.rotation.x = Math.PI / 2; step.position.z = -0.08; g.add(step);
  // Main barrel — stepped profile.
  const mainLen = length - 0.08;
  const main = new THREE.Mesh(new THREE.CylinderGeometry(muzzleR, baseR, mainLen, 24), mats.gunmetal);
  main.rotation.x = Math.PI / 2; main.position.z = -0.08 - mainLen / 2; main.castShadow = true; g.add(main);
  // Fluting — 6 longitudinal grooves along the main barrel (sniper/heavy
  // barrel treatment). Built as thin dark boxes laid along the barrel surface.
  if (fluted) {
    const fluteMat = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.85, metalness: 0.6 });
    const fluteLen = mainLen * 0.75;
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const r = muzzleR * 0.98;
      const flute = new THREE.Mesh(
        new THREE.BoxGeometry(0.0028, fluteLen, 0.0035),
        fluteMat,
      );
      // Orient along the barrel (Y axis of the box → barrel -Z axis).
      flute.rotation.x = Math.PI / 2;
      flute.rotation.y = angle;
      flute.position.set(
        Math.cos(angle) * r,
        Math.sin(angle) * r,
        -0.08 - mainLen / 2,
      );
      g.add(flute);
    }
  }
  // Muzzle thread ring — raised collar at the muzzle end (seat for the device).
  const thread = new THREE.Mesh(new THREE.CylinderGeometry(muzzleR * 1.18, muzzleR * 1.1, 0.022, 18), mats.parkerized);
  thread.rotation.x = Math.PI / 2; thread.position.z = -length + 0.011; thread.castShadow = true; g.add(thread);
  // Thread groove — a thin dark recessed ring just behind the thread (the
  // actual threaded section reads as a darker band).
  const threadGroove = new THREE.Mesh(new THREE.TorusGeometry(muzzleR * 1.05, 0.001, 4, 18),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
  threadGroove.rotation.x = Math.PI / 2;
  threadGroove.position.z = -length + 0.022; g.add(threadGroove);
  // Gas block (rifles only) — a tapered block with a gas tube on top.
  if (withGasBlock) {
    // Gas block body — slightly tapered (wider at top where the tube mounts).
    const gb = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.022, 0.06, 8),
      mats.parkerized,
    );
    gb.rotation.x = Math.PI / 2; gb.position.set(0, 0.005, gasBlockZ); gb.castShadow = true; g.add(gb);
    // Gas block top — a flat-topped mounting platform for the front sight base.
    const gbTop = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.05), mats.parkerized);
    gbTop.position.set(0, 0.024, gasBlockZ); g.add(gbTop);
    // Gas tube — thin cylinder from the gas block back toward the receiver
    // (slightly raised above the barrel — visible as the signature AR/AK
    // gas tube running parallel to the barrel).
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.16, 12), mats.parkerized);
    tube.rotation.x = Math.PI / 2; tube.position.set(0, 0.030, gasBlockZ + 0.1); tube.castShadow = true; g.add(tube);
    // Gas tube cap — small flange at the receiver end (where the tube seats).
    const tubeCap = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.008, 0.014, 12), mats.parkerized);
    tubeCap.rotation.x = Math.PI / 2; tubeCap.position.set(0, 0.030, gasBlockZ + 0.18); g.add(tubeCap);
    // Front sight post on the gas block (AK-style — the front sight sits
    // directly above the gas block).
    const sightPost = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.028, 0.007), mats.parkerized);
    sightPost.position.set(0, 0.042, gasBlockZ - 0.005); g.add(sightPost);
    // Front sight protective ears — two small wings on either side of the
    // post (so the sight doesn't get knocked out of alignment).
    for (const sx of [-0.011, 0.011]) {
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.020, 0.010), mats.parkerized);
      ear.position.set(sx, 0.038, gasBlockZ - 0.005); g.add(ear);
    }
  }
  return g;
}

/** Birdcage flash hider — slotted cylinder with visible prongs (top + bottom
 *  slots, closed bottom for muzzle blast deflection). The classic A2-style
 *  birdcage has 3 top slots + 3 bottom slots with the very bottom closed to
 *  prevent dust signature when prone. */
export function buildFlashHider(mats: WeaponMaterials, length = 0.06): THREE.Group {
  const g = new THREE.Group();
  // Body — slight taper (wider at the muzzle end).
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.017, length, 18), mats.parkerized);
  body.rotation.x = Math.PI / 2; body.position.z = -length / 2; body.castShadow = true; g.add(body);
  // Top vent slots — 3 dark recesses on top (the birdcage prongs).
  const slotMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 });
  for (let i = 0; i < 3; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.005, 0.010), slotMat);
    slot.position.set(0, 0.014, -0.012 - i * 0.014); g.add(slot);
  }
  // Bottom vent slots — 3 dark recesses on the bottom (alternating with top).
  for (let i = 0; i < 3; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.005, 0.010), slotMat);
    slot.position.set(0, -0.014, -0.019 - i * 0.014); g.add(slot);
  }
  // Solid bottom face — the A2 birdcage's signature closed bottom (no slot
  // on the very bottom, prevents kicking up dust when prone).
  // (Already a closed cylinder — no extra mesh needed.)
  // Front crown — slightly wider ring at the muzzle tip (visible from the
  // front as a chamfered crown).
  const crown = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.0014, 6, 18), mats.parkerized);
  crown.rotation.x = Math.PI / 2; crown.position.z = -length + 0.001; g.add(crown);
  return g;
}

/** Compensator / muzzle brake — cylinder with top ports (to reduce muzzle
 *  climb) + side vents. The classic compensator has 2-3 large top ports cut
 *  diagonally to vent gas upward, countering recoil climb. */
export function buildCompensator(mats: WeaponMaterials, length = 0.05): THREE.Group {
  const g = new THREE.Group();
  // Body — slight taper (wider at the back).
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.022, length, 18), mats.parkerized);
  body.rotation.x = Math.PI / 2; body.position.z = -length / 2; body.castShadow = true; g.add(body);
  const slotMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 });
  // Top ports — 3 large rectangular cuts on top (gas vents upward to counter
  // muzzle climb). The cuts are angled forward at the back face (the diagonal
  // cut signature of compensators).
  const portCount = length > 0.055 ? 3 : 2;
  for (let i = 0; i < portCount; i++) {
    const port = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.007, 0.010), slotMat);
    port.position.set(0, 0.014, -0.012 - i * 0.014); g.add(port);
  }
  // Side vents — 2 small round holes on each side (lateral gas dispersion).
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const vent = new THREE.Mesh(new THREE.CircleGeometry(0.003, 10), slotMat);
      vent.position.set(sx * 0.020, 0, -0.014 - i * 0.014);
      vent.rotation.y = sx * Math.PI / 2;
      g.add(vent);
    }
  }
  // Front crown — chamfered muzzle tip (visible from the front).
  const crown = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.0012, 6, 18), mats.parkerized);
  crown.rotation.x = Math.PI / 2; crown.position.z = -length + 0.001; g.add(crown);
  return g;
}

/** Suppressor — stepped/ridged tube with end cap + engraved markings. Real
 *  suppressors have a stepped profile (wider blast baffle at the front, narrower
 *  tube toward the rear) + axial grooves for grip + an engraved dark band with
 *  model markings (the signature "cereal box" engraving on commercial cans). */
export function buildSuppressor(mats: WeaponMaterials, length = 0.2): THREE.Group {
  const g = new THREE.Group();
  const r = 0.032;
  // Main body — tube with a slight taper (narrower at the rear where it threads).
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.94, length, 24), mats.parkerized);
  body.rotation.x = Math.PI / 2; body.position.z = -length / 2; body.castShadow = true; g.add(body);
  // Rear thread boss — the narrower threaded section that mates with the barrel.
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.78, r * 0.85, 0.020, 20), mats.parkerized);
  boss.rotation.x = Math.PI / 2; boss.position.z = -0.010; boss.castShadow = true; g.add(boss);
  // Front blast baffle — slightly wider section at the muzzle end (the high-
  // pressure section that takes the brunt of the muzzle blast).
  const blast = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.06, r, 0.025, 24), mats.parkerized);
  blast.rotation.x = Math.PI / 2; blast.position.z = -length + 0.012; blast.castShadow = true; g.add(blast);
  // End cap — flat face at the muzzle (with a small bore recess).
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.05, r * 1.06, 0.008, 24), mats.parkerized);
  cap.rotation.x = Math.PI / 2; cap.position.z = -length + 0.001; cap.castShadow = true; g.add(cap);
  // Bore recess — small dark circle on the end-cap face (the bullet's exit hole).
  const bore = new THREE.Mesh(new THREE.CircleGeometry(0.005, 12),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
  bore.position.set(0, 0, -length - 0.0002); g.add(bore);
  // Stepped ridges — 3 raised rings around the tube body (signature look of
  // modern sealed suppressors like the SureFire/SilencerCo models).
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.02, 0.0018, 6, 24), mats.parkerized);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = -0.05 - i * ((length - 0.10) / 2);
    g.add(ring);
  }
  // Engraved markings — a thin dark recessed band near the rear (model + serial
  // marking engraving — visible at close range as a darker band on the tube).
  const engraveMat = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.95, metalness: 0.4 });
  const engrave = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.005, r * 1.005, 0.022, 24), engraveMat);
  engrave.rotation.x = Math.PI / 2; engrave.position.z = -0.035; g.add(engrave);
  // Engraved text lines — 3 thin raised lines across the band (suggests text).
  for (let i = 0; i < 3; i++) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.0006, 0.0015), mats.blued);
    line.position.set(0, r * 1.01, -0.028 - i * 0.005); g.add(line);
  }
  return g;
}

/** Iron sights — front post + rear aperture. Includes a tritium dot on the
 *  front sight post (small emissive sphere) for low-light visibility, and
 *  optional flip-up detail (angled rear sight wing suggesting a foldable BUIS). */
export function buildIronSights(mats: WeaponMaterials, frontZ: number, rearZ: number): THREE.Group {
  const g = new THREE.Group();
  // Front sight base + post.
  const fBase = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.015), mats.parkerized);
  fBase.position.set(0, 0.055, frontZ); g.add(fBase);
  // Front sight base "wings" — two small protective ears on either side of
  // the post (signature AR/AK front sight look).
  for (const sx of [-0.013, 0.013]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.022, 0.012), mats.parkerized);
    wing.position.set(sx, 0.063, frontZ); g.add(wing);
  }
  const fPost = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.022, 0.003), mats.parkerized);
  fPost.position.set(0, 0.078, frontZ); g.add(fPost);
  // Tritium dot — small white-green emissive sphere on the front of the post.
  // Visible in low light as a glowing dot — modern tritium night sight.
  const tritMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xc8ffd0, emissiveIntensity: 0.9, roughness: 0.4,
  });
  const tritDot = new THREE.Mesh(new THREE.SphereGeometry(0.0018, 8, 6), tritMat);
  tritDot.position.set(0, 0.085, frontZ - 0.002); g.add(tritDot);
  // Rear sight base + aperture.
  const rBase = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.02), mats.parkerized);
  rBase.position.set(0, 0.05, rearZ); g.add(rBase);
  // Rear sight protective wings — two small ears beside the aperture.
  for (const sx of [-0.018, 0.018]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.018, 0.014), mats.parkerized);
    wing.position.set(sx, 0.062, rearZ); g.add(wing);
  }
  const rAperture = new THREE.Mesh(new THREE.TorusGeometry(0.008, 0.003, 6, 12), mats.parkerized);
  rAperture.position.set(0, 0.066, rearZ); g.add(rAperture);
  // Rear aperture tritium dot — small dot below the aperture for low-light alignment.
  const tritRear = new THREE.Mesh(new THREE.SphereGeometry(0.0014, 8, 6), tritMat);
  tritRear.position.set(0, 0.058, rearZ - 0.001); g.add(tritRear);
  return g;
}

/** Collapsible M4 stock — 4-position with tube + buttplate. Buffer tube has
 *  visible position notches (engraved lines) so the adjustable length-of-pull
 *  reads clearly. */
export function buildM4Stock(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Buffer tube — cylinder extending rearward.
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.18, 14), mats.parkerized);
  tube.rotation.x = Math.PI / 2; tube.position.set(0, -0.01, 0.14); tube.castShadow = true; g.add(tube);
  // Buffer tube position notches — 4 engraved lines (the M4's 4 stock positions:
  // closed, 1/2, 3/4, full). Dark thin boxes on the side of the tube.
  const notchMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 });
  for (let i = 0; i < 4; i++) {
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.002, 0.004), notchMat);
    notch.position.set(0.018, -0.01, 0.10 + i * 0.022); g.add(notch);
    // Mirror notch on the other side.
    const notch2 = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.002, 0.004), notchMat);
    notch2.position.set(-0.018, -0.01, 0.10 + i * 0.022); g.add(notch2);
  }
  // Stock body — slides on the tube.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.14), mats.polymer);
  body.position.set(0, -0.02, 0.26); body.castShadow = true; g.add(body);
  // Stock body texturing — vertical ridges on the side for grip (stippled look).
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.06, 0.003), mats.darkPolymer);
      ridge.position.set(side * 0.031, -0.02, 0.21 + i * 0.03); g.add(ridge);
    }
  }
  // Cheek rest — slight raised ridge on top.
  const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.015, 0.1), mats.polymer);
  cheek.position.set(0, 0.02, 0.26); g.add(cheek);
  // Buttplate — curved rubber pad.
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.092, 0.012), mats.rubber);
  pad.position.set(0, -0.02, 0.335); g.add(pad);
  // Buttplate horizontal grooves — 3 lines for non-slip texture.
  for (let i = 0; i < 3; i++) {
    const groove = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.0015, 0.002), notchMat);
    groove.position.set(0, -0.035 + i * 0.018, 0.341); g.add(groove);
  }
  // Sling loop.
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.01, 0.003, 6, 10), mats.parkerized);
  loop.position.set(0.03, -0.04, 0.24); g.add(loop);
  // Adjustment lever — small latch under the stock body (the M4's signature
  // release lever that locks the stock into one of the 4 positions).
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.008, 0.012), mats.parkerized);
  lever.position.set(0, -0.07, 0.20); g.add(lever);
  return g;
}

/** Fixed AK wood stock — traditional thumbhole-ish shape. */
export function buildAkStock(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Stock body — angled wood block.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.085, 0.24), mats.wood);
  body.position.set(0, -0.03, 0.3); body.rotation.x = -0.05; body.castShadow = true; g.add(body);
  // Comb — raised top edge.
  const comb = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.18), mats.wood);
  comb.position.set(0, 0.015, 0.3); g.add(comb);
  // Buttplate — steel.
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.09, 0.01), mats.parkerized);
  pad.position.set(0, -0.035, 0.42); g.add(pad);
  // Sling swivel.
  const swivel = new THREE.Mesh(new THREE.TorusGeometry(0.008, 0.003, 6, 10), mats.parkerized);
  swivel.position.set(0, -0.06, 0.26); swivel.rotation.x = Math.PI / 2; g.add(swivel);
  return g;
}

/** Thumbhole sniper stock — for AWP/Scout. Adjustable cheek riser + recoil pad. */
export function buildSniperStock(mats: WeaponMaterials, useWood = false): THREE.Group {
  const g = new THREE.Group();
  const stockMat = useWood ? mats.wood : mats.darkPolymer;
  // Main stock body.
  // B2-5000 #852 — named so callers can look it up via getObjectByName
  // (snipers.ts was using blind children[0] index, which broke when this
  // builder reordered its children).
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.3), stockMat);
  body.name = "stock_body";
  body.position.set(0, -0.04, 0.33); body.castShadow = true; g.add(body);
  // Adjustable cheek riser — raised cheek rest on a vertical post (suggests
  // height-adjustability for scope-eye alignment).
  const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.025, 0.16), stockMat);
  cheek.position.set(0, 0.02, 0.32); g.add(cheek);
  // Cheek riser adjustment wheel — small knurled cylinder on the side.
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 12), mats.blued);
  wheel.rotation.z = Math.PI / 2; wheel.position.set(0.028, 0.03, 0.32); g.add(wheel);
  // Adjustment wheel knurling — 8 small notches around the circumference.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.0015, 0.013), mats.blued);
    notch.position.set(0.028 + Math.cos(a) * 0.008, 0.03 + Math.sin(a) * 0.008, 0.32);
    g.add(notch);
  }
  // Pistol grip extension.
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.1, 0.05), stockMat);
  grip.position.set(0, -0.07, 0.22); grip.rotation.x = -0.25; g.add(grip);
  // Buttplate — thick rubber recoil pad with horizontal grooves.
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.025, 16), mats.rubber);
  pad.rotation.x = Math.PI / 2; pad.position.set(0, -0.04, 0.485); g.add(pad);
  // Recoil pad grooves — 3 horizontal lines for grip texture on the pad.
  for (let i = 0; i < 3; i++) {
    const groove = new THREE.Mesh(
      new THREE.BoxGeometry(0.085, 0.0015, 0.002),
      new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }),
    );
    groove.position.set(0, -0.04 - 0.018 + i * 0.018, 0.498);
    g.add(groove);
  }
  // Bipod adapter — small Picatinny rail segment under the fore-end.
  const bipodAdapter = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.012, 0.05), mats.parkerized);
  bipodAdapter.position.set(0, -0.092, 0.18); g.add(bipodAdapter);
  // Adapter cross-slot (for the bipod clamp).
  const adapterSlot = new THREE.Mesh(new THREE.BoxGeometry(0.033, 0.005, 0.005),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
  adapterSlot.position.set(0, -0.098, 0.18); g.add(adapterSlot);
  return g;
}

/** Ergonomic pistol grip — angled with vertical texturing ridges + stippled
 *  side panels (modern competition-grip style). */
export function buildPistolGrip(mats: WeaponMaterials, height = 0.13, angle = -0.3): THREE.Group {
  const g = new THREE.Group();
  // Main grip body — slightly tapered box.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.042, height, 0.055), mats.polymer);
  body.position.set(0, -height / 2, 0); body.rotation.x = angle; body.castShadow = true; g.add(body);
  // Front strap texturing — vertical ridges on the front face.
  for (let i = 0; i < 4; i++) {
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.003, height * 0.7, 0.005), mats.darkPolymer);
    ridge.position.set(0, -height / 2, 0.025); ridge.rotation.x = angle;
    ridge.position.y -= i * (height * 0.18) - height * 0.27;
    g.add(ridge);
  }
  // Side stippling — small raised dots on the side panels (anti-slip texture).
  // Built as a grid of tiny boxes on each side of the grip.
  const stipMat = mats.darkPolymer;
  const stipGeo = new THREE.BoxGeometry(0.001, 0.002, 0.002);
  const stipRows = 5;
  const stipCols = 3;
  for (const side of [-1, 1]) {
    for (let r = 0; r < stipRows; r++) {
      for (let c = 0; c < stipCols; c++) {
        const dot = new THREE.Mesh(stipGeo, stipMat);
        const yy = -height * 0.15 - r * (height * 0.16);
        const zz = -0.012 + c * 0.012;
        // Apply the grip tilt to the dot position.
        dot.position.set(side * 0.022, yy * Math.cos(angle) - zz * Math.sin(angle), yy * Math.sin(angle) + zz * Math.cos(angle));
        g.add(dot);
      }
    }
  }
  // Beavertail — extension at the top rear for hand web.
  const beaver = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.03, 0.025), mats.polymer);
  beaver.position.set(0, 0.005, -0.02); g.add(beaver);
  // Grip base plug — small removable weight plug at the bottom (modern grip).
  const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.008, 10), mats.blued);
  plug.rotation.x = angle; plug.position.set(0, -height + 0.002, 0); g.add(plug);
  return g;
}

/** Curved AK banana magazine with bakelite-style horizontal ribbing. */
export function buildAkMag(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Curved body — built from a series of stacked, offset segments.
  const segments = 5;
  const segH = 0.04;
  const curveOffset = 0.012;
  for (let i = 0; i < segments; i++) {
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.05, segH, 0.025), mats.polymer);
    seg.position.set(0, -i * segH, -i * curveOffset);
    seg.castShadow = true; g.add(seg);
  }
  // Bakelite-style horizontal ribbing — 3 raised ribs on each side of the mag
  // (the classic AK steel-mag rib pattern that also acts as a round-count
  // witness marker). Dark polymer ribs on the side of the body.
  const ribMat = mats.darkPolymer;
  for (let i = 0; i < 3; i++) {
    const yy = -0.02 - i * 0.05;
    const zz = -i * 0.015 - 0.003;
    for (const sx of [-1, 1]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.006, 0.022), ribMat);
      rib.position.set(sx * 0.026, yy, zz); g.add(rib);
    }
  }
  // Side witness holes — 2 small dark dots indicating round count (bakelite
  // mags often have witness holes at 10/20/30 rounds).
  const holeMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 });
  for (let i = 0; i < 2; i++) {
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.002, 8), holeMat);
    hole.position.set(0.0251, -0.04 - i * 0.06, -0.012 - i * 0.018);
    hole.rotation.y = Math.PI / 2; g.add(hole);
  }
  // Feed lips — reinforced top.
  const lips = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.015, 0.028), mats.parkerized);
  lips.position.set(0, 0.01, 0); g.add(lips);
  // Baseplate.
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.012, 0.03), mats.darkPolymer);
  base.position.set(0, -segments * segH - 0.005, -segments * curveOffset); g.add(base);
  // Baseplate catch — small protrusion on the front (where the mag catch engages).
  const catchMesh = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.006, 0.004), mats.parkerized);
  catchMesh.position.set(0, -0.018, 0.014); g.add(catchMesh);
  return g;
}

/** Straight STANAG magazine (M4/MP7) with witness window + visible rounds. */
export function buildStanagMag(mats: WeaponMaterials, height = 0.18, w = 0.04): THREE.Group {
  const g = new THREE.Group();
  // Slightly tapered body.
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, height, 0.025), mats.polymer);
  body.position.set(0, -height / 2, 0); body.castShadow = true; g.add(body);
  // Feed lips.
  const lips = new THREE.Mesh(new THREE.BoxGeometry(w + 0.002, 0.012, 0.028), mats.parkerized);
  lips.position.set(0, 0.006, 0); g.add(lips);
  // Baseplate — slightly wider with a visible seam.
  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.006, 0.012, 0.028), mats.darkPolymer);
  base.position.set(0, -height - 0.005, 0); g.add(base);
  // Baseplate seam — thin dark line where the baseplate meets the body.
  const seam = new THREE.Mesh(new THREE.BoxGeometry(w + 0.008, 0.0015, 0.03),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
  seam.position.set(0, -height + 0.001, 0); g.add(seam);
  // Mag release catch — small notch on the side (where the mag catch engages).
  const catchMesh = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.012, 0.012), mats.parkerized);
  catchMesh.position.set(w / 2 + 0.0015, -0.02, 0); g.add(catchMesh);
  // Witness window — a translucent rectangular window on the side showing
  // the brass rounds inside. Pmag-style.
  const winMat = new THREE.MeshStandardMaterial({
    color: 0x14181a, roughness: 0.25, metalness: 0.1,
    transparent: true, opacity: 0.55,
  });
  const winH = Math.min(height * 0.55, 0.11);
  const winY = -height * 0.5;
  const window = new THREE.Mesh(new THREE.PlaneGeometry(0.018, winH), winMat);
  window.position.set(w / 2 + 0.0008, winY, 0);
  window.rotation.y = Math.PI / 2;
  g.add(window);
  // Visible rounds inside the window — a stack of small brass cylinders.
  const roundCount = Math.max(3, Math.floor(winH / 0.014));
  const roundSpacing = winH / roundCount;
  for (let i = 0; i < roundCount; i++) {
    const round = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, 0.022, 8), mats.brass);
    round.rotation.z = Math.PI / 2; // axis along X (visible from the side)
    round.position.set(w / 2 + 0.0008, winY + winH / 2 - i * roundSpacing - roundSpacing * 0.5, 0);
    g.add(round);
  }
  return g;
}

/** P90 horizontal magazine — top-mounted translucent drum holding 50 rounds
 *  of 5.7x28mm in a rotary spool (the P90's signature magazine). The shell
 *  is translucent polymer so you can see the rounds; here we model the shell
 *  + a visible row of brass rounds through the window. */
export function buildP90Mag(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Horizontal body sitting on top of the weapon — slightly tapered (wider
  // at the rear where the magazine engages the feed).
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.040, 0.036, 0.28, 16),
    mats.darkPolymer);
  body.rotation.x = Math.PI / 2; body.position.set(0, 0.06, -0.05); body.castShadow = true; g.add(body);
  // Top spine — the magazine's central spine that separates the live-round
  // track from the empty-track on the other side.
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.080, 0.006, 0.28), mats.darkPolymer);
  spine.position.set(0, 0.082, -0.05); g.add(spine);
  // Translucent side windows on both sides — the P90 mag is famously
  // translucent so you can see the round count.
  const winMat = new THREE.MeshPhysicalMaterial({
    color: 0x303a2e, roughness: 0.15, metalness: 0.0,
    transmission: 0.55, thickness: 0.008, ior: 1.45,
    transparent: true, opacity: 0.55,
    envMapIntensity: 1.5,
    side: THREE.DoubleSide,
  });
  for (const sx of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.04), winMat);
    win.position.set(sx * 0.041, 0.06, -0.05);
    win.rotation.y = sx * Math.PI / 2;
    g.add(win);
  }
  // Visible rounds — a row of small brass cylinders along the magazine spine
  // (the round stack visible through the translucent shell).
  const roundCount = 8;
  for (let i = 0; i < roundCount; i++) {
    const z = -0.17 + i * (0.24 / (roundCount - 1));
    const round = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.06, 8), mats.brass);
    round.rotation.z = Math.PI / 2;
    round.position.set(0, 0.07, z);
    g.add(round);
  }
  // Rear magazine catch — small lever at the back.
  const catchMesh = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.012, 0.012), mats.parkerized);
  catchMesh.position.set(0, 0.06, 0.10); g.add(catchMesh);
  // Front magazine lip — the curved feed lip at the muzzle end.
  const lip = new THREE.Mesh(new THREE.BoxGeometry(0.080, 0.010, 0.012), mats.parkerized);
  lip.position.set(0, 0.06, -0.19); g.add(lip);
  return g;
}

/** Trigger + trigger guard with a curved-blade trigger (modern match-grade
 *  style) and a squared guard. */
export function buildTriggerGroup(mats: WeaponMaterials, z = 0.1): THREE.Group {
  const g = new THREE.Group();
  // Trigger guard — squared D-shape (modern AR-style).
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.005, 6, 14, Math.PI), mats.parkerized);
  guard.position.set(0, -0.05, z); guard.rotation.x = Math.PI; g.add(guard);
  // Guard front + rear vertical struts (squared-off look).
  const strutGeo = new THREE.BoxGeometry(0.005, 0.022, 0.005);
  const strutF = new THREE.Mesh(strutGeo, mats.parkerized);
  strutF.position.set(0, -0.04, z - 0.022); g.add(strutF);
  const strutR = new THREE.Mesh(strutGeo, mats.parkerized);
  strutR.position.set(0, -0.04, z + 0.022); g.add(strutR);
  // Trigger — curved blade (built from a thin box + a curved bezier-ish strip).
  // The blade face is concave toward the rear so the finger rests naturally.
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.026, 0.005), mats.blued);
  trigger.position.set(0, -0.055, z); g.add(trigger);
  // Curved trigger face — a thin angled box that gives the trigger its
  // signature concave shape (faces the rear, angled forward at the bottom).
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.022, 0.003), mats.blued);
  face.position.set(0, -0.055, z + 0.003);
  face.rotation.x = -0.25; // tilt forward at the bottom
  g.add(face);
  // Trigger pin — small horizontal cylinder through the receiver.
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.03, 8), mats.blued);
  pin.rotation.z = Math.PI / 2; pin.position.set(0, -0.04, z);
  g.add(pin);
  return g;
}

/** AR-style T-shaped charging handle. */
export function buildTHandle(mats: WeaponMaterials, z = 0.25): THREE.Group {
  const g = new THREE.Group();
  // Rear pull tab — T-shape.
  const tab = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.012, 0.015), mats.parkerized);
  tab.position.set(0, 0.035, z); g.add(tab);
  // Shaft going into the receiver.
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.008, 0.04), mats.parkerized);
  shaft.position.set(0, 0.035, z - 0.025); g.add(shaft);
  return g;
}

/** AK-style side charging handle. */
export function buildSideHandle(mats: WeaponMaterials, z = 0.1): THREE.Group {
  const g = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.04, 10), mats.parkerized);
  handle.rotation.z = Math.PI / 2; handle.position.set(0.04, 0.03, z); g.add(handle);
  // Knob on the end.
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), mats.parkerized);
  knob.position.set(0.06, 0.03, z); g.add(knob);
  return g;
}

/** Ejection port — a dark rectangular recess on the right side of the receiver. */
export function buildEjectionPort(mats: WeaponMaterials, z = 0): THREE.Group {
  const g = new THREE.Group();
  const port = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.02, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
  port.position.set(0.04, 0.02, z); g.add(port);
  // Visible brass cartridge.
  const brass = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.025, 8), mats.brass);
  brass.rotation.z = Math.PI / 2; brass.position.set(0.045, 0.02, z); g.add(brass);
  // Brass deflector — small bump behind the port.
  const deflector = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.015, 0.015), mats.gunmetal);
  deflector.position.set(0.04, 0.03, z - 0.04); g.add(deflector);
  return g;
}

/** Selector switch — fire mode selector on the side, with S/1/F markings
 *  (Safe / Semi / Full) indicated by small accent dots. */
export function buildSelector(mats: WeaponMaterials, z = 0.05): THREE.Group {
  const g = new THREE.Group();
  // Selector pivot disk — round plate on the receiver side.
  const disk = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.004, 16), mats.parkerized);
  disk.rotation.z = Math.PI / 2; disk.position.set(-0.044, 0.02, z); g.add(disk);
  // Selector lever — the actual switch (pointing up = safe, modern AR-style).
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.025, 0.012), mats.parkerized);
  lever.position.set(-0.048, 0.02, z); lever.rotation.z = 0.3; g.add(lever);
  // Mode markings — 3 small accent dots in an arc (Safe / Semi / Auto).
  const markGeo = new THREE.SphereGeometry(0.0018, 6, 4);
  const angles = [0.8, 0.35, -0.1]; // arc from safe → semi → auto
  for (let i = 0; i < angles.length; i++) {
    const mark = new THREE.Mesh(markGeo, i === 0 ? mats.accent : mats.blued);
    const a = angles[i];
    mark.position.set(-0.05, 0.02 + Math.sin(a) * 0.018, z + Math.cos(a) * 0.018);
    g.add(mark);
  }
  return g;
}

/** Bolt handle for sniper rifles. */
export function buildBoltHandle(mats: WeaponMaterials, z = 0.15): THREE.Group {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.04, 10), mats.parkerized);
  shaft.rotation.z = Math.PI / 2; shaft.position.set(0.05, 0.04, z); g.add(shaft);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), mats.parkerized);
  knob.position.set(0.07, 0.04, z); g.add(knob);
  return g;
}

/** Optic mount — scope rings + base. The rings clamp around the scope tube
 *  (sized for the tightened 0.020 tube radius). */
export function buildScopeRings(mats: WeaponMaterials, z1: number, z2: number): THREE.Group {
  const g = new THREE.Group();
  for (const z of [z1, z2]) {
    // Two ring halves (front + back of each ring clamp) — torus around the tube.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.005, 8, 18), mats.parkerized);
    ring.rotation.x = Math.PI / 2; ring.position.set(0, 0.043, z); g.add(ring);
    // Ring saddle — the lower cradle that the scope rests in.
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.018, 0.012), mats.parkerized);
    saddle.position.set(0, 0.034, z); g.add(saddle);
    // Base block — Picatinny clamp bottom.
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.014, 0.014), mats.parkerized);
    base.position.set(0, 0.025, z); g.add(base);
    // Cross-slot — the Picatinny slot recess the clamp engages into.
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.004, 0.004),
      new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
    slot.position.set(0, 0.018, z); g.add(slot);
    // Clamp screw — small knurled knob on the side of the ring.
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.012, 8), mats.blued);
    screw.rotation.z = Math.PI / 2; screw.position.set(0.018, 0.045, z); g.add(screw);
  }
  return g;
}

/** Build a thin scope reticle (crosshair + mildots + amber center) at the
 *  focal plane. The reticle mesh is built in the scope-local XY plane (Z=0)
 *  and positioned by the caller. Uses thin dark lines for the crosshair +
 *  small dark dots for mildots + a glowing amber center dot.
 *  Center dot is small (1mm radius) and dimmer than V1.3 — was reading as
 *  an "oversized yellow scope" against bright backgrounds. */
export function buildScopeReticle(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Crosshair — thin dark lines (subdivision for crispness).
  const lineMat = mats.blued;
  const lineW = 0.0005; // 0.5mm — thin enough to read as a precision wire
  const lineLen = 0.032; // 3.2cm — spans most of the FOV (scaled to tube)
  // Horizontal line (split into two so the center is clear for the dot).
  const hL = new THREE.Mesh(new THREE.BoxGeometry(lineLen / 2 - 0.0015, lineW, 0.0002), lineMat);
  hL.position.x = -(lineLen / 4 + 0.0008); g.add(hL);
  const hR = new THREE.Mesh(new THREE.BoxGeometry(lineLen / 2 - 0.0015, lineW, 0.0002), lineMat);
  hR.position.x = (lineLen / 4 + 0.0008); g.add(hR);
  // Vertical line.
  const vT = new THREE.Mesh(new THREE.BoxGeometry(lineW, lineLen / 2 - 0.0015, 0.0002), lineMat);
  vT.position.y = (lineLen / 4 + 0.0008); g.add(vT);
  const vB = new THREE.Mesh(new THREE.BoxGeometry(lineW, lineLen / 2 - 0.0015, 0.0002), lineMat);
  vB.position.y = -(lineLen / 4 + 0.0008); g.add(vB);
  // Mildots — 4 small dark dots along each axis at fixed milliradian offsets.
  for (const d of [0.006, 0.012, 0.018]) {
    for (const [sx, sy] of [[d, 0], [-d, 0], [0, d], [0, -d]] as const) {
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0007, 10), lineMat);
      dot.position.set(sx, sy, 0.0001); g.add(dot);
    }
  }
  // Center amber dot — small (1mm) + dimmer so it reads as a precision aiming
  // point, not a giant glowing yellow blob.
  const center = new THREE.Mesh(new THREE.CircleGeometry(0.0010, 14), mats.reticleGlow);
  center.position.z = 0.0002; g.add(center);
  return g;
}

/** Full telescopic scope — tube + objective bell + ocular bell + turrets +
 *  REAL GLASS lenses (MeshPhysicalMaterial with transmission) + a thin
 *  crosshair reticle at the focal plane + sun shade on the objective + throw
 *  lever for quick-detach. The glass is visibly transparent + reflective.
 *  Proportions are tightened (tube 0.020 → was 0.024) so the scope reads as
 *  a real precision optic, not an oversized tube. */
export function buildScope(mats: WeaponMaterials, length = 0.24, objR = 0.026): THREE.Group {
  const g = new THREE.Group();
  const tubeR = 0.020; // tightened — proportional to a real 30mm scope tube
  // Main tube.
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(tubeR, tubeR, length, 24), mats.parkerized);
  tube.rotation.x = Math.PI / 2; tube.position.z = -0.02; tube.castShadow = true; g.add(tube);
  // Tube knurling rings — 3 thin raised rings around the tube body for grip
  // when adjusting eye relief (real scope body detail).
  for (const rz of [-0.04, 0.0, 0.04]) {
    const knurl = new THREE.Mesh(new THREE.TorusGeometry(tubeR + 0.0008, 0.0012, 6, 24), mats.parkerized);
    knurl.rotation.x = Math.PI / 2; knurl.position.z = -0.02 + rz; g.add(knurl);
  }
  // Objective bell (front, wider) — tapered cone shape.
  const obj = new THREE.Mesh(new THREE.CylinderGeometry(objR, tubeR + 0.002, 0.042, 24), mats.parkerized);
  obj.rotation.x = Math.PI / 2; obj.position.z = -0.02 - length / 2 + 0.021; g.add(obj);
  // Sun shade — short cylinder extension on the objective (anti-glare tube).
  const sunShade = new THREE.Mesh(new THREE.CylinderGeometry(objR * 0.96, objR, 0.028, 24), mats.parkerized);
  sunShade.rotation.x = Math.PI / 2;
  sunShade.position.set(0, 0, -0.02 - length / 2 + 0.042 + 0.014);
  sunShade.castShadow = true; g.add(sunShade);
  // Ocular bell (rear) — tapered cone.
  const occ = new THREE.Mesh(new THREE.CylinderGeometry(tubeR + 0.006, tubeR, 0.038, 24), mats.parkerized);
  occ.rotation.x = Math.PI / 2; occ.position.z = -0.02 + length / 2 - 0.019; g.add(occ);
  // Ocular focus ring — ribbed for grip (adjusts diopter for eye focus).
  const focusRing = new THREE.Mesh(new THREE.CylinderGeometry(tubeR + 0.008, tubeR + 0.006, 0.014, 24), mats.parkerized);
  focusRing.rotation.x = Math.PI / 2;
  focusRing.position.set(0, 0, -0.02 + length / 2 - 0.005);
  g.add(focusRing);
  // Focus ring knurling — 12 axial ribs around the ring.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.0014, 0.014, 0.0014), mats.parkerized);
    rib.position.set(Math.cos(a) * (tubeR + 0.009), Math.sin(a) * (tubeR + 0.009), -0.02 + length / 2 - 0.005);
    rib.rotation.z = a;
    g.add(rib);
  }
  // Objective lens — real glass disc with volume (thin cylinder) for refraction.
  // Slightly green-tinted (coated scope glass look).
  const objLensGeo = new THREE.CylinderGeometry(objR * 0.92, objR * 0.92, 0.0035, 28);
  const objLens = new THREE.Mesh(objLensGeo, mats.glassTinted);
  objLens.rotation.x = Math.PI / 2;
  objLens.position.set(0, 0, -0.02 - length / 2 + 0.042 + 0.028 - 0.002);
  g.add(objLens);
  // Ocular lens — clearer glass (the eye side).
  const occLensGeo = new THREE.CylinderGeometry(tubeR * 0.92, tubeR * 0.92, 0.0035, 28);
  const occLens = new THREE.Mesh(occLensGeo, mats.glass);
  occLens.rotation.x = Math.PI / 2;
  occLens.position.set(0, 0, -0.02 + length / 2 - 0.002);
  g.add(occLens);
  // Reticle — thin crosshair + mildots + amber center, at the focal plane
  // (midway between lenses, slightly toward the ocular for the eye to focus).
  const reticle = buildScopeReticle(mats);
  reticle.position.set(0, 0, -0.02 + length / 2 - 0.022);
  g.add(reticle);
  // Lens reflection rings — thin emissive rings on the objective lens edges
  // to read as coated glass (the signature purple/green lens-flare of scopes).
  const coatMat = new THREE.MeshBasicMaterial({
    color: 0x6a8aff, transparent: true, opacity: 0.30,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const coatRing = new THREE.Mesh(new THREE.TorusGeometry(objR * 0.88, 0.0007, 4, 32), coatMat);
  coatRing.rotation.x = Math.PI / 2;
  coatRing.position.set(0, 0, -0.02 - length / 2 + 0.042 + 0.028 - 0.003);
  g.add(coatRing);
  // Elevation turret (top) — adjustment knob for vertical zero.
  const turretBase = new THREE.Mesh(new THREE.CylinderGeometry(tubeR + 0.006, tubeR + 0.004, 0.012, 16), mats.parkerized);
  turretBase.position.set(0, tubeR + 0.006, -0.02); g.add(turretBase);
  const turretTop = new THREE.Mesh(new THREE.CylinderGeometry(tubeR + 0.005, tubeR + 0.006, 0.012, 16), mats.blued);
  turretTop.position.set(0, tubeR + 0.018, -0.02); g.add(turretTop);
  // Turret knurling — 8 axial lines around the turret top (for grip when
  // turning the adjustment).
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const k = new THREE.Mesh(new THREE.BoxGeometry(0.0008, 0.011, 0.0008), mats.parkerized);
    k.position.set(Math.cos(a) * (tubeR + 0.006), tubeR + 0.018, -0.02 + Math.sin(a) * (tubeR + 0.006));
    g.add(k);
  }
  // Windage turret (right side) — adjustment knob for horizontal zero.
  const wtBase = new THREE.Mesh(new THREE.CylinderGeometry(tubeR + 0.006, tubeR + 0.004, 0.012, 16), mats.parkerized);
  wtBase.rotation.z = Math.PI / 2; wtBase.position.set(tubeR + 0.006, 0, -0.02); g.add(wtBase);
  const wtTop = new THREE.Mesh(new THREE.CylinderGeometry(tubeR + 0.005, tubeR + 0.006, 0.012, 16), mats.blued);
  wtTop.rotation.z = Math.PI / 2; wtTop.position.set(tubeR + 0.018, 0, -0.02); g.add(wtTop);
  // Parallax turret (left side, opposite the windage) — adjustable objective
  // dial (high-end scope detail).
  const ptBase = new THREE.Mesh(new THREE.CylinderGeometry(tubeR + 0.004, tubeR + 0.003, 0.010, 16), mats.parkerized);
  ptBase.rotation.z = Math.PI / 2; ptBase.position.set(-(tubeR + 0.005), 0, -0.02); g.add(ptBase);
  // Magnification ring (around the rear bell — adjustable zoom).
  const magRing = new THREE.Mesh(new THREE.TorusGeometry(tubeR + 0.009, 0.0035, 8, 24), mats.parkerized);
  magRing.position.set(0, 0, -0.02 + length / 2 - 0.04); g.add(magRing);
  // Throw lever — small lever on the magnification ring for fast zoom changes
  // (signature on tactical scopes).
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.014, 0.004), mats.blued);
  lever.position.set(tubeR + 0.012, 0.005, -0.02 + length / 2 - 0.04); g.add(lever);
  return g;
}

/** Red dot sight — compact tube + REAL GLASS window (front + rear) with a
 *  glowing red dot projected onto the rear lens. The glass is transparent so
 *  you can see through it; the dot is additive-blended so it stays bright
 *  against any background. */
export function buildRedDot(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Tube.
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.06, 16), mats.parkerized);
  tube.rotation.x = Math.PI / 2; tube.position.z = -0.03; g.add(tube);
  // Front + rear glass windows (real glass with volume for refraction).
  const glassGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.003, 22);
  const frontGlass = new THREE.Mesh(glassGeo, mats.glass);
  frontGlass.rotation.x = Math.PI / 2; frontGlass.position.z = -0.06; g.add(frontGlass);
  const rearGlass = new THREE.Mesh(glassGeo, mats.glass);
  rearGlass.rotation.x = Math.PI / 2; rearGlass.position.z = -0.001; g.add(rearGlass);
  // Glowing red dot — projected on the rear glass, facing the eye.
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.002, 14), mats.reticleRed);
  dot.position.z = 0.001; g.add(dot);
  // Base.
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.015, 0.04), mats.parkerized);
  base.position.set(0, -0.025, -0.03); g.add(base);
  return g;
}

/** Holographic sight — square REAL GLASS window with a glowing holographic
 *  reticle (ring + center dot) projected onto it. The window is transparent
 *  so the player sees through it; the reticle is additive-blended. */
export function buildHolo(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Window frame.
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.05, 0.05), mats.parkerized);
  frame.position.set(0, 0.015, -0.03); g.add(frame);
  // Holographic window — real transparent glass (thin box for volume).
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.042, 0.042), mats.glass);
  glass.position.set(0, 0.02, -0.055); g.add(glass);
  // Holographic reticle — glowing ring + center dot + stadia lines, on the
  // glass surface facing the eye. Additive blend keeps it bright.
  const reticleZ = -0.054;
  // Outer ring (circle reticle).
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0009, 6, 28), mats.reticleRed);
  ring.position.set(0, 0.02, reticleZ); g.add(ring);
  // Center dot.
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0014, 14), mats.reticleRed);
  dot.position.set(0, 0.02, reticleZ); g.add(dot);
  // Top stadia line (above the ring).
  const topLine = new THREE.Mesh(new THREE.BoxGeometry(0.0008, 0.006, 0.0002), mats.reticleRed);
  topLine.position.set(0, 0.02 + 0.018, reticleZ); g.add(topLine);
  // Bottom stadia line.
  const botLine = new THREE.Mesh(new THREE.BoxGeometry(0.0008, 0.006, 0.0002), mats.reticleRed);
  botLine.position.set(0, 0.02 - 0.018, reticleZ); g.add(botLine);
  // Base.
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.015, 0.045), mats.parkerized);
  base.position.set(0, -0.02, -0.03); g.add(base);
  return g;
}

/** ACOG — fixed 4x scope with carry handle. Real glass objective + ocular
 *  lenses + a triangular post reticle at the focal plane. */
export function buildAcog(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Body.
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.16, 16), mats.parkerized);
  body.rotation.x = Math.PI / 2; body.position.z = -0.04; g.add(body);
  // Objective.
  const obj = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.022, 0.03, 16), mats.parkerized);
  obj.rotation.x = Math.PI / 2; obj.position.z = -0.135; g.add(obj);
  // Ocular.
  const occ = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.022, 0.03, 16), mats.parkerized);
  occ.rotation.x = Math.PI / 2; occ.position.z = 0.035; g.add(occ);
  // Lenses — real glass (thin cylinders with volume).
  const objLensGeo = new THREE.CylinderGeometry(0.020, 0.020, 0.003, 22);
  const objLens = new THREE.Mesh(objLensGeo, mats.glassTinted);
  objLens.rotation.x = Math.PI / 2; objLens.position.z = -0.151; g.add(objLens);
  const occLensGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.003, 22);
  const occLens = new THREE.Mesh(occLensGeo, mats.glass);
  occLens.rotation.x = Math.PI / 2; occLens.position.z = 0.051; g.add(occLens);
  // Reticle — triangular post (ACOG signature) at the focal plane.
  const reticle = new THREE.Group();
  // Vertical line below the triangle.
  const lineMat = mats.blued;
  const vline = new THREE.Mesh(new THREE.BoxGeometry(0.0008, 0.030, 0.0002), lineMat);
  vline.position.y = -0.005; reticle.add(vline);
  // Triangle tip (amber, glowing — the ACOG's signature glowing tip).
  const triTip = new THREE.Mesh(new THREE.CircleGeometry(0.002, 3), mats.reticleGlow);
  triTip.position.y = 0.012; reticle.add(triTip);
  reticle.position.set(0, 0, 0.045); g.add(reticle);
  // Carry handle on top.
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.02, 0.1), mats.parkerized);
  handle.position.set(0, 0.03, -0.04); g.add(handle);
  // Base.
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.015, 0.08), mats.parkerized);
  base.position.set(0, -0.025, -0.04); g.add(base);
  return g;
}

// ─── Pistol slide with serrations ───

/** Pistol slide — beveled top + cocking serrations (front + rear) + ejection
 *  port + front sight post + rear sight notch + loaded chamber indicator.
 *  The beveled top edge (chamfered corners) is the signature of a real
 *  forged/machined slide — sharp 90° corners read as a flat slab. */
export function buildSlide(mats: WeaponMaterials, length: number, w: number, h: number, serrations = true): THREE.Group {
  const g = new THREE.Group();
  // Slide body — beveled by subdividing + chamfering the top corners.
  const geo = new THREE.BoxGeometry(w, h, length, 2, 2, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // Top chamfer — bevel the top edges.
    if (y > h * 0.35) {
      if (Math.abs(x) > w * 0.2) {
        pos.setX(i, x * 0.86);
      }
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const slide = new THREE.Mesh(geo, mats.gunmetal);
  slide.castShadow = true; g.add(slide);
  // Top rib — raised center rib along the slide top (the flat top of a real
  // pistol slide where the sight mounts).
  const rib = new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, 0.003, length * 0.9), mats.gunmetal);
  rib.position.y = h / 2 + 0.0005; g.add(rib);
  // Rear cocking serrations — 5 thin angled recesses at the back of the slide.
  if (serrations) {
    const serrMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 });
    for (let i = 0; i < 5; i++) {
      const serr = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, h * 0.7, 0.003), serrMat);
      serr.position.set(0, 0, length / 2 - 0.012 - i * 0.005); g.add(serr);
    }
    // Front cocking serrations — 4 thin recesses at the front (modern slides
    // have serrations at both ends for press-check manipulation).
    for (let i = 0; i < 4; i++) {
      const serr = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, h * 0.7, 0.003), serrMat);
      serr.position.set(0, 0, -length / 2 + 0.012 + i * 0.005); g.add(serr);
    }
  }
  // Ejection port — dark rectangular cutout on the right side.
  const port = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, h * 0.55, 0.028),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
  port.position.set(w * 0.32, h * 0.18, -length * 0.15); g.add(port);
  // Loaded chamber indicator — small brass dot visible at the ejection port
  // (a loaded round's primer, visible through the port).
  const lci = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 8, 6), mats.brass);
  lci.position.set(w * 0.32, h * 0.18, -length * 0.15); g.add(lci);
  // Front sight — thin post on the front of the slide.
  const fSight = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.010, 0.005), mats.parkerized);
  fSight.position.set(0, h / 2 + 0.005, -length / 2 + 0.018); g.add(fSight);
  // Front sight tritium dot — small white-green emissive dot for low light.
  const fTrit = new THREE.Mesh(new THREE.SphereGeometry(0.0016, 6, 4),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xc8ffd0, emissiveIntensity: 0.9 }));
  fTrit.position.set(0, h / 2 + 0.011, -length / 2 + 0.018); g.add(fTrit);
  // Rear sight — wide notch sight (a U-notch with two tritium dots).
  const rSightBase = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.008, 0.010), mats.parkerized);
  rSightBase.position.set(0, h / 2 + 0.004, length / 2 - 0.018); g.add(rSightBase);
  // Rear sight notch — thin dark slot in the center of the rear sight.
  const notch = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.005, 0.011),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
  notch.position.set(0, h / 2 + 0.005, length / 2 - 0.018); g.add(notch);
  // Rear sight tritium dots — 2 dots flanking the notch for low-light alignment.
  for (const sx of [-0.007, 0.007]) {
    const rTrit = new THREE.Mesh(new THREE.SphereGeometry(0.0014, 6, 4),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xc8ffd0, emissiveIntensity: 0.9 }));
    rTrit.position.set(sx, h / 2 + 0.008, length / 2 - 0.018); g.add(rTrit);
  }
  return g;
}

// ════════════════════════════════════════════════════════════════════════════
// Task 2-c — Enhanced part builders (beveled receivers, extruded rails,
// ribbed grips, curved mags). These are NEW helpers that build on the same
// pattern as the existing buildTaperedReceiver / buildRail / buildPistolGrip
// but use THREE.ExtrudeGeometry for proper beveled edges + multiple thin
// cylinders for ribbed grips. They coexist with the originals — existing
// weapon builds still call buildTaperedReceiver, but new/refreshed builds
// can opt into the higher-detail versions.
// ════════════════════════════════════════════════════════════════════════════

/** Beveled/chamfered receiver built from ExtrudeGeometry. The receiver profile
 *  is drawn as a 2D shape (rounded rectangle with chamfered top corners) then
 *  extruded along Z with a small bevel applied to all edges. This produces
 *  the CNC-milled look — real receivers have small chamfers along every edge
 *  (sharp 90° corners read as a flat slab; the chamfer catches a highlight).
 *
 *  `w` = receiver width (X), `h` = height (Y), `d` = depth (Z, extrude length).
 *  `taperRear` narrows the rear 30% of the receiver toward the stock interface.
 *  Returns a Mesh positioned with the receiver center at origin, extending -Z. */
export function buildBeveledReceiver(mat: THREE.Material, w: number, h: number, d: number, taperRear = 0.9): THREE.Mesh {
  // 2D profile — a rounded rectangle with a chamfered top. Drawn in the XY
  // plane; ExtrudeGeometry will sweep it along +Z (we then rotate so it lies
  // along -Z to match the existing buildTaperedReceiver convention).
  const shape = new THREE.Shape();
  const hw = w / 2;
  const hh = h / 2;
  const chamfer = Math.min(h * 0.12, 0.008); // chamfer size scales with height
  // Start at bottom-left, go clockwise.
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  // Bottom-right chamfer (45° cut).
  shape.lineTo(hw, hh - chamfer);
  shape.lineTo(hw - chamfer, hh);
  shape.lineTo(-hw + chamfer, hh);
  // Top-left chamfer.
  shape.lineTo(-hw, hh - chamfer);
  shape.lineTo(-hw, -hh);

  const extrudeOpts: THREE.ExtrudeGeometryOptions = {
    depth: d,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.003,
    bevelOffset: 0,
    bevelSegments: 2,
    steps: 1,
    curveSegments: 4,
  };
  const geo = new THREE.ExtrudeGeometry(shape, extrudeOpts);
  // ExtrudeGeometry extrudes along +Z starting at z=0; translate so the
  // geometry is centered on Z (extrude centered at -d/2..+d/2 → shift -d/2).
  geo.translate(0, 0, -d / 2);
  // Now rotate so the long axis lies along -Z (matching buildTaperedReceiver
  // which uses BoxGeometry centered on origin with depth along Z). The shape
  // was drawn in XY → already correct; no rotation needed.

  // Rear taper — narrow the rear 30% of the receiver (where the stock mates).
  // Displace vertices in the rear (z > d*0.2) inward by taperRear on X, and
  // slightly compress Y for a forged-receiver look. (Same approach as
  // buildTaperedReceiver but applied to the extruded geometry.)
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let nx = x;
    let ny = y;
    if (z > d * 0.2) {
      nx = x * taperRear;
      ny = y * 0.94;
    }
    // Front flare — slight widening at the mag well (z < -d*0.2).
    if (z < -d * 0.2) {
      nx = nx * 1.04;
    }
    pos.setX(i, nx);
    pos.setY(i, ny);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Extruded Picatinny rail with notched slot cross-section. The rail profile
 *  is drawn as a 2D shape with the scalloped slot pattern already cut in (the
 *  classic Picatinny 1913 profile — square slots separated by flat traction
 *  areas), then extruded along the rail length. This gives a single solid
 *  mesh with proper slot geometry (vs the existing buildRail which assembles
 *  the rail from a base box + many individual slot recess meshes).
 *
 *  `length` = rail length (Z). `width` = rail width (X). `height` = rail
 *  height (Y). `slots` = number of cross-slots. `cover` adds a rubber rail
 *  cover on top (same as buildRail). */
export function buildPicatinnyRailExtruded(
  mat: THREE.Material,
  length: number,
  width = 0.032,
  height = 0.012,
  slots = 8,
  cover = false,
): THREE.Group {
  const g = new THREE.Group();
  // 2D profile — drawn in the XZ plane (so extrude along Y gives the rail its
  // height). The profile is the rail's SIDE silhouette: a flat top with
  // periodic square notches cut down into it (the Picatinny slot pattern).
  // We then rotate the extruded mesh so the long axis lies along Z (matching
  // the existing buildRail convention).
  const shape = new THREE.Shape();
  const hw = width / 2;
  const hh = height / 2;
  const slotSpacing = length / (slots + 1);
  const slotWidth = 0.006;
  const slotDepth = height * 0.45;
  // Bottom of the rail (flat).
  shape.moveTo(-length / 2, -hh);
  shape.lineTo(length / 2, -hh);
  // Right side up to the top.
  shape.lineTo(length / 2, hh);
  // Top edge with notches — walk leftward, cutting a notch at each slot position.
  let x = length / 2;
  for (let i = 0; i < slots; i++) {
    const slotCenter = -length / 2 + slotSpacing * (i + 1);
    const slotRight = slotCenter + slotWidth / 2;
    const slotLeft = slotCenter - slotWidth / 2;
    // Flat segment from current x to slot right edge.
    shape.lineTo(slotRight, hh);
    // Down into the notch.
    shape.lineTo(slotRight, hh - slotDepth);
    shape.lineTo(slotLeft, hh - slotDepth);
    // Back up to the top.
    shape.lineTo(slotLeft, hh);
    x = slotLeft;
  }
  // Final flat segment to the left edge.
  shape.lineTo(-length / 2, hh);
  shape.lineTo(-length / 2, -hh);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.0008,
    bevelSize: 0.0008,
    bevelSegments: 1,
    steps: 1,
  });
  // ExtrudeGeometry extrudes along +Z by `width`. We want the rail's width
  // along X, so rotate the geometry 90° about Y to swap X↔Z.
  geo.rotateY(Math.PI / 2);
  // After rotateY(π/2), the extruded width is along X (correct) and the shape
  // lies in the YZ plane (correct — length is Z, height is Y).
  // Center the geometry on X (it's currently offset by width/2).
  geo.translate(0, 0, 0);

  const railMesh = new THREE.Mesh(geo, mat);
  railMesh.castShadow = true;
  railMesh.receiveShadow = true;
  g.add(railMesh);

  // Optional rubber rail cover — same as the original buildRail.
  if (cover) {
    const coverMat = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.85, metalness: 0.0 });
    const coverMesh = new THREE.Mesh(new THREE.BoxGeometry(width * 0.95, height * 0.4, length * 0.9), coverMat);
    coverMesh.position.set(0, height * 0.7, 0);
    g.add(coverMesh);
    const ribGeo = new THREE.BoxGeometry(width * 0.95, height * 0.15, 0.004);
    for (let i = 0; i < 5; i++) {
      const z = -length * 0.4 + i * (length * 0.2);
      const rib = new THREE.Mesh(ribGeo, coverMat);
      rib.position.set(0, height * 0.95, z);
      g.add(rib);
    }
  }
  return g;
}

/** Ribbed pistol grip — multiple thin cylinders stacked along the grip axis
 *  form the ribbed/textured surface. An alternative to buildPistolGrip that
 *  uses real cylinder geometry for the ribs (vs the box ridges in the original)
 *  — gives a more organic, Magpul-style grip texture.
 *
 *  `height` = grip height, `angle` = rearward tilt (radians). The ribs are
 *  horizontal cylinders wrapping the grip's front face (the part the fingers
 *  curl around). */
export function buildRibbedGrip(mats: WeaponMaterials, height = 0.13, angle = -0.3): THREE.Group {
  const g = new THREE.Group();
  // Main grip body — slightly tapered box (same as buildPistolGrip).
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.042, height, 0.055), mats.polymer);
  body.position.set(0, -height / 2, 0); body.rotation.x = angle; body.castShadow = true; g.add(body);
  // Horizontal rib cylinders — 6 thin cylinders stacked along the grip front.
  // Each cylinder is oriented along X (across the grip width) and positioned
  // on the front face. The slight overlap creates a continuous ribbed texture.
  const ribCount = 6;
  const ribGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 0.04, 10);
  for (let i = 0; i < ribCount; i++) {
    const t = i / (ribCount - 1); // 0..1
    const yLocal = -height * 0.10 - t * height * 0.75;
    const zLocal = 0.025; // front face of the grip
    // Apply the grip tilt to position the rib along the angled grip axis.
    const y = yLocal * Math.cos(angle) - zLocal * Math.sin(angle);
    const z = yLocal * Math.sin(angle) + zLocal * Math.cos(angle);
    const rib = new THREE.Mesh(ribGeo, mats.darkPolymer);
    rib.rotation.z = Math.PI / 2; // axis along X
    // Tilt the rib slightly to match the grip angle (so it's perpendicular
    // to the grip axis, not the world Y).
    rib.rotation.x = angle;
    rib.position.set(0, y, z);
    g.add(rib);
  }
  // Side stippling — small raised dots on the side panels (reuses the
  // buildPistolGrip stippling pattern, but now over the ribbed front).
  const stipMat = mats.darkPolymer;
  const stipGeo = new THREE.BoxGeometry(0.001, 0.002, 0.002);
  const stipRows = 5;
  const stipCols = 3;
  for (const side of [-1, 1]) {
    for (let r = 0; r < stipRows; r++) {
      for (let c = 0; c < stipCols; c++) {
        const dot = new THREE.Mesh(stipGeo, stipMat);
        const yy = -height * 0.15 - r * (height * 0.16);
        const zz = -0.012 + c * 0.012;
        dot.position.set(side * 0.022, yy * Math.cos(angle) - zz * Math.sin(angle), yy * Math.sin(angle) + zz * Math.cos(angle));
        g.add(dot);
      }
    }
  }
  // Beavertail — extension at the top rear.
  const beaver = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.03, 0.025), mats.polymer);
  beaver.position.set(0, 0.005, -0.02); g.add(beaver);
  // Grip base plug.
  const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.008, 10), mats.blued);
  plug.rotation.x = angle; plug.position.set(0, -height + 0.002, 0); g.add(plug);
  return g;
}

/** Curved magazine with smooth banana curve (STANAG / AK style). Built from a
 *  LatheGeometry-like sweep of a small box cross-section along a curved path,
 *  using a CatmullRomCurve3 + TubeGeometry-derived approach. The result is a
 *  smooth curved magazine body (vs the existing buildAkMag which approximates
 *  the curve with 5 stacked offset boxes — visible "stairsteps" between segs).
 *
 *  `height` = total mag height (along the curve), `w` = mag width,
 *  `curveAmount` = how much the mag curves forward (0 = straight, 0.04 = AK
 *  banana). `segments` = path resolution. */
export function buildCurvedMagazine(
  mats: WeaponMaterials,
  height = 0.20,
  w = 0.04,
  curveAmount = 0.03,
  segments = 12,
): THREE.Group {
  const g = new THREE.Group();
  // Build a curved path — the magazine centerline curves forward (toward -Z)
  // as it descends (toward -Y). CatmullRomCurve3 gives a smooth curve through
  // 4 control points (top of mag, two intermediate, bottom).
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    const y = -t * height;
    // Quadratic curve forward — curve accelerates toward the bottom (banana).
    const z = -curveAmount * t * t;
    pts.push(new THREE.Vector3(0, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  // Sample the curve at `segments` points; at each point, place a thin box
  // cross-section oriented tangent to the curve. The slight overlap between
  // adjacent segments creates a continuous curved body.
  const dMat = mats.darkPolymer;
  const segH = height / segments * 1.2; // overlap 20% for seamless join
  for (let i = 0; i < segments; i++) {
    const t = i / (segments - 1);
    const p = curve.getPoint(t);
    const tangent = curve.getTangent(t);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(w, segH, 0.025), dMat);
    seg.position.copy(p);
    // Orient the segment so its local Y axis aligns with the curve tangent.
    const up = new THREE.Vector3(0, 1, 0);
    seg.quaternion.setFromUnitVectors(up, tangent.clone().normalize());
    seg.castShadow = true;
    g.add(seg);
  }
  // Feed lips — reinforced top.
  const lips = new THREE.Mesh(new THREE.BoxGeometry(w + 0.002, 0.015, 0.028), mats.parkerized);
  lips.position.set(0, 0.01, 0); g.add(lips);
  // Baseplate — at the bottom of the curve, oriented tangent to the curve end.
  const endTangent = curve.getTangent(1).normalize();
  const endPos = curve.getPoint(1);
  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.006, 0.012, 0.030), mats.darkPolymer);
  base.position.copy(endPos).add(endTangent.clone().multiplyScalar(-0.006));
  const up = new THREE.Vector3(0, 1, 0);
  base.quaternion.setFromUnitVectors(up, endTangent);
  g.add(base);
  // Side witness ribs — 3 raised ribs on each side (round-count markers).
  for (let i = 0; i < 3; i++) {
    const t = 0.25 + i * 0.22;
    const p = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    for (const sx of [-1, 1]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.006, 0.022), mats.darkPolymer);
      rib.position.copy(p).add(new THREE.Vector3(sx * (w / 2 + 0.0015), 0, 0));
      rib.quaternion.setFromUnitVectors(up, tangent);
      g.add(rib);
    }
  }
  return g;
}

// ═════════════════════════════════════════════════════════════════════════════
// Section D — Weapon Stat Interfaces (used by real-catalog.ts + Gunsmith UI)
// ═════════════════════════════════════════════════════════════════════════════
// These types extend the WeaponBuilder shared module with real-world weapon
// stat dimensions that the 3D mesh builders don't care about, but the Gunsmith
// tuning-bench UI + the real-catalog data table do. Keeping them in _shared
// lets both WeaponBuilder/* and combat/* import the same shape.

/** Real-world barrel profile (mass + contour). Affects heat capacity, whip,
 *  and harmonics. */
export type BarrelProfile =
  | "pencil"    // lightweight, thin — fast handling, whippy
  | "light"     // government profile front half
  | "standard"  // M4 gov-profile — most common
  | "heavy"     // HBAR — sustained fire, heavier
  | "bull"      // maximum stiffness — precision rifles
  | "fluted"    // heavy profile with flutes (mass reduction + surface area)
  | "medium";   // between standard and heavy

/** Real-world recoil classification by impulse magnitude. */
export type RecoilImpulseClass = "low" | "moderate" | "high" | "extreme";

/** Real-world recoil measurement — verified from manufacturer + military
 *  references. Used by the Gunsmith tuning bench + the recoil system. */
export interface RecoilStats {
  /** Vertical recoil per shot in MOA (measured at the shoulder, free-recoil). */
  verticalMoa: number;
  /** Horizontal (lateral) recoil per shot in MOA. */
  horizontalMoa: number;
  /** Free-recoil impulse in Newton-seconds (N·s). */
  impulseNs: number;
  /** Free-recoil energy in Joules. */
  energyJ: number;
  /** Muzzle climb in deg/sec during sustained full-auto fire. */
  climbDegPerSec: number;
  /** Recoil classification — for the spec card. */
  impulseClass: RecoilImpulseClass;
}

/** Real-world stock type — affects ergonomics + length-of-pull. */
export type StockType =
  | "fixed"        // fixed stock (A2, hunting)
  | "collapsible"  // 4-6 position adjustable (M4)
  | "folding"      // side-folding (AKS, SCAR)
  | "bullpup"      // magazine behind the trigger (AUG, P90)
  | "telescoping"  // sliding collapsible
  | "pistol"       // no stock (pistol)
  | "none";        // receiver-only (some SMGs)

/** Real-world handguard type — affects attachment rail system. */
export type HandguardType =
  | "picatinny_full"   // full-length Picatinny quad-rail (RIS / RAS)
  | "picatinny_top"    // top Picatinny only, M-LOK sides/bottom (modern)
  | "mlok_full"        // M-LOK slots all around
  | "keymod_full"      // KeyMod slots all around
  | "polymer"          // smooth polymer handguard (AK, hunting)
  | "tube"             // circular tube (MP5, UMP)
  | "wood"             // wood handguard (classic AK, hunting)
  | "none";

/** Real-world trigger characteristics. */
export interface TriggerSpec {
  /** Trigger pull weight in Newtons (real-world measured). 1 N ≈ 0.225 lbf. */
  pullWeightN: number;
  /** Trigger pull length before the break (mm). */
  creepMm: number;
  /** Reset distance from the break back to reset (mm). */
  resetMm: number;
  /** Trigger type. */
  type: "single_stage" | "two_stage" | "double_action" | "single_action" | "binary";
}

/** Real-world muzzle device class. */
export type MuzzleDeviceClass =
  | "flash_hider"     // A2 birdcage — reduces flash
  | "compensator"     // redirects gas upward (reduces climb)
  | "muzzle_brake"    // redirects gas sideways (reduces felt recoil)
  | "suppressor"      // sound + flash suppressor
  | "blast_regulator" // visible blast forwarding (PCA / Levang)
  | "linear_comp"     // forward-redirecting comp (KX3, Noveske)
  | "thread_protector" // bare threads
  | "none";

/** Real-world ergonomics rating — for the Gunsmith spec card.
 *  0..10 scale, based on real-world reviews + mil-spec benchmarks. */
export interface ErgonomicsRating {
  /** Handling — how natural the weapon points + transitions. */
  handling: number;
  /** Recoil control — how well the stock + grip mitigate recoil. */
  recoilControl: number;
  /** Trigger quality — break, reset, takeup. */
  trigger: number;
  /** Modularity — attachment + accessory options. */
  modularity: number;
  /** Maintenance — field-strip + cleaning ease. */
  maintenance: number;
  /** Sighting — sight radius + sight picture quality. */
  sighting: number;
}

/** Real-world manufacturer / provenance block. */
export interface WeaponProvenance {
  manufacturer: string;
  countryOfOrigin: string;
  yearDesigned: number;
  yearInService: number;
  /** Primary user (military / police force). */
  primaryUser: string;
  /** Conflicts the weapon has seen (for historical context). */
  conflicts?: string[];
}
