import * as THREE from "three";
import {
  tacticalFabricTexture, tacticalPlateTexture, helmetTexture, metalRoughTexture, bootTexture,
  skinNormalTexture, fabricNormalTexture, kevlarNormalTexture, metalNormalTexture, leatherNormalTexture,
} from "../textures";
import { getOperatorVisual, skinToneHexNum, type OperatorVisual } from "../operators";

// ════════════════════════════════════════════════════════════════════════════
// V4 — Production tactical operator model.
//
// Replaces the V3 placeholder (capsules + boxes) with an anatomically tapered
// humanoid wearing layered tactical gear: plate carrier vest with MOLLE
// pouches, detailed helmet with NVG mount + side rails + headset, combat
// boots with sole detail, knee/elbow pads, tactical belt with holster +
// sidearm, and a small assault pack.
//
// Caching strategy (a humanoid renders ~70 meshes; dozens of enemies render
// at once, so we MUST share GPU resources aggressively):
//   - Geometries (immutable) are shared across every humanoid via geoCache.
//   - Procedural canvas textures (expensive ~256x256 allocations) are cached
//     by (type, color) in texCache — without this, 30 enemies would allocate
//     ~180 canvases on spawn.
//   - Fixed-color materials (pouch, belt, weapon, boot, pad) are shared via
//     fixedMatCache — their color never changes.
//   - Colored materials that don't get hit-flashed or class-recolored
//     (visor, accent, glove, balaclava) are cached by color in coloredMatCache.
//   - Per-call materials (suit, vest, helmet, skin) are created fresh each
//     call so each enemy has its own emissive state for hit-flash + its own
//     color for class recoloring. They reference the cached textures, so
//     canvas allocation only happens once per unique color.
//
// Total mesh count per humanoid: ~70 (vs ~40 in V3). Draw calls stay
// manageable because shared geometries/materials let the WebGL backend keep
// GPU buffers resident across instances.
// ════════════════════════════════════════════════════════════════════════════

const geoCache = new Map<string, THREE.BufferGeometry>();
const texCache = new Map<string, THREE.Texture>();
const fixedMatCache = new Map<string, THREE.MeshStandardMaterial>();
const coloredMatCache = new Map<string, THREE.MeshStandardMaterial>();

function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key) as T | undefined;
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}
function tex(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = texCache.get(key);
  if (!t) { t = make(); texCache.set(key, t); }
  return t;
}
function fixedMat(key: string, make: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = fixedMatCache.get(key);
  if (!m) { m = make(); fixedMatCache.set(key, m); }
  return m;
}
function coloredMat(key: string, make: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = coloredMatCache.get(key);
  if (!m) { m = make(); coloredMatCache.set(key, m); }
  return m;
}

// ─── Cached geometry helpers ────────────────────────────────────────────────
// CylinderGeometry(radiusTop, radiusBottom, height, radialSegments, ...)
function cyl(rt: number, rb: number, h: number, segs = 10): THREE.CylinderGeometry {
  return geo(`cyl_${rt.toFixed(4)}_${rb.toFixed(4)}_${h.toFixed(4)}_${segs}`, () => new THREE.CylinderGeometry(rt, rb, h, segs, 1));
}
function sph(r: number, ws = 12, hs = 10): THREE.SphereGeometry {
  return geo(`sph_${r.toFixed(4)}_${ws}_${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
}
function sphPartial(r: number, ws: number, hs: number, ph0: number, phl: number, th0: number, thl: number): THREE.SphereGeometry {
  return geo(`sphp_${r.toFixed(4)}_${ws}_${hs}_${ph0.toFixed(3)}_${phl.toFixed(3)}_${th0.toFixed(3)}_${thl.toFixed(3)}`, () => new THREE.SphereGeometry(r, ws, hs, ph0, phl, th0, thl));
}
function box(w: number, h: number, d: number, ws = 1, hs = 1, ds = 1): THREE.BoxGeometry {
  return geo(`box_${w.toFixed(4)}_${h.toFixed(4)}_${d.toFixed(4)}_${ws}_${hs}_${ds}`, () => new THREE.BoxGeometry(w, h, d, ws, hs, ds));
}
function torGeo(r: number, tube: number, rs = 6, ts = 14): THREE.TorusGeometry {
  return geo(`tor_${r.toFixed(4)}_${tube.toFixed(4)}_${rs}_${ts}`, () => new THREE.TorusGeometry(r, tube, rs, ts));
}
// Partial cylinder (for curved visor glass).
function cylArc(r: number, h: number, segs: number, th0: number, thl: number): THREE.CylinderGeometry {
  return geo(`cyla_${r.toFixed(4)}_${h.toFixed(4)}_${segs}_${th0.toFixed(3)}_${thl.toFixed(3)}`, () => new THREE.CylinderGeometry(r, r, h, segs, 1, false, th0, thl));
}

/** Anatomical tapered torso — box with waist + chest taper + pectoral bulge. */
function torsoGeo(): THREE.BoxGeometry {
  return geo("torso_anatomical_v4", () => {
    const g = new THREE.BoxGeometry(0.50, 0.65, 0.30, 1, 5, 1);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const ny = y / 0.325; // -1 at bottom, +1 at top
      let xScale = 1.0, zScale = 1.0;
      if (ny < 0) {
        // Lower torso — waist narrows toward belt.
        const t = (ny + 1) * 0.5; // 0 at bottom, 0.5 at middle
        xScale = 0.78 + t * 0.44; // 0.78 → 1.0
        zScale = 0.85 + t * 0.30; // 0.85 → 1.0
      } else {
        // Upper torso — chest expands (pec bulge), shoulders stay wide.
        const t = ny;
        xScale = 1.0 + Math.sin(t * Math.PI) * 0.06;
        zScale = 1.0 + Math.sin(t * Math.PI) * 0.10;
      }
      pos.setX(i, pos.getX(i) * xScale);
      pos.setZ(i, pos.getZ(i) * zScale);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  });
}

/** Anatomical hips/pelvis — narrower than torso, slightly rounded bottom. */
function hipsGeo(): THREE.BoxGeometry {
  return geo("hips_v4", () => {
    const g = new THREE.BoxGeometry(0.42, 0.16, 0.28, 1, 2, 1);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < 0) {
        const t = (y + 0.08) / 0.08;
        pos.setX(i, pos.getX(i) * (0.92 + t * 0.08));
      }
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  });
}

/**
 * Anatomical skull head (Task 20) — sphere deformed for jaw taper, forehead
 * bulge, and cheekbone width. The base sphere is 0.13 radius, baked with the
 * (0.95, 1.05, 1.0) scale that the old simple head sphere used, so the head
 * sits in the same world bounds (head center y=1.65, top y≈1.787, bottom
 * y≈1.513). The jaw taper narrows the lower 80% of the head toward the chin,
 * the forehead bulges forward slightly above the eyes, and the cheekbones
 * widen at cheek level for an anatomical skull silhouette.
 */
function headSkullGeo(): THREE.BufferGeometry {
  return geo("head_skull_v1", () => {
    const g = new THREE.SphereGeometry(0.13, 16, 14);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const ny = y / 0.13; // -1 at bottom (chin), +1 at top (crown)
      let xScale = 0.95;   // base width scale (matches old head.scale.x).
      let yScale = 1.05;   // base height scale (matches old head.scale.y).
      let zScale = 1.0;    // base depth scale.
      // Jaw taper: narrow the lower portion (chin/jaw area) toward the chin.
      if (ny < -0.2) {
        const t = (-0.2 - ny) / 0.8; // 0 at ny=-0.2, 1 at ny=-1.0 (chin)
        xScale *= 1.0 - t * 0.35;    // narrow to 65% width at chin
        zScale *= 1.0 - t * 0.20;    // narrow to 80% depth at chin
      }
      // Forehead: slight forward bulge for the upper face.
      if (ny > 0.2 && z > 0) {
        const t = Math.min(1, (ny - 0.2) / 0.6);
        zScale *= 1.0 + Math.sin(t * Math.PI) * 0.05;
      }
      // Cheekbones: widen slightly at cheek level (front of face only).
      if (ny > -0.25 && ny < 0.05 && z > 0) {
        const t = 1.0 - Math.abs(ny + 0.1) / 0.35;
        xScale *= 1.0 + t * 0.05;
      }
      pos.setX(i, x * xScale);
      pos.setY(i, y * yScale);
      pos.setZ(i, z * zScale);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  });
}

// ─── Material factories ─────────────────────────────────────────────────────
// Per-call materials (must be unique per enemy so hit-flash + class recolor
// don't bleed across enemies). The expensive part (canvas texture) is cached.

function makeSuitMat(suitHex: number): THREE.MeshStandardMaterial {
  const fabric = tex(`fabric_${suitHex.toString(16)}`, () => tacticalFabricTexture(suitHex));
  const fabricRough = tex(`fabricR_${suitHex.toString(16)}`, () => tacticalFabricTexture(suitHex, true));
  // Task 33 — woven fabric normal map (warp + weft threads). Cached globally
  // (color-independent) so all suit colors share one normal map texture.
  const fabricNormal = tex("fabricNormal_global", () => fabricNormalTexture());
  return new THREE.MeshStandardMaterial({
    color: suitHex, map: fabric, roughnessMap: fabricRough,
    normalMap: fabricNormal, normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.85, metalness: 0.0,
  });
}
function makeVestMat(vestHex: number): THREE.MeshStandardMaterial {
  const plate = tex("plate_v4", () => tacticalPlateTexture());
  // Task 33 — kevlar weave normal map (tight diagonal aramid pattern).
  const kevlarNormal = tex("kevlarNormal_global", () => kevlarNormalTexture());
  return new THREE.MeshStandardMaterial({
    color: vestHex, map: plate, normalMap: kevlarNormal,
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.65, metalness: 0.1,
  });
}
function makeHelmetMat(helmetHex: number): THREE.MeshStandardMaterial {
  const helmet = tex("helmet_v4", () => helmetTexture());
  // Task 33 — helmet shell uses the fabric weave normal (composite shell).
  const fabricNormal = tex("fabricNormal_global", () => fabricNormalTexture());
  return new THREE.MeshStandardMaterial({
    color: helmetHex, map: helmet, normalMap: fabricNormal,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.55, metalness: 0.15,
  });
}
function makeSkinMat(skinHex: number): THREE.MeshStandardMaterial {
  // Task 33 — skin pores + wrinkles normal map. Cached globally (color-
  // independent) so all skin tones share one 256x256 normal map texture.
  const skinNormal = tex("skinNormal_global", () => skinNormalTexture());
  // Task 33 — subsurface scattering approximation: warm emissive tint makes
  // the skin look like it has depth (light bleeds through thin areas like
  // ears, nose, fingertips). Roughness 0.72 reads as slightly shiny (skin
  // has natural oils), not dry like fabric.
  return new THREE.MeshStandardMaterial({
    color: skinHex, normalMap: skinNormal,
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.72, metalness: 0.0,
    emissive: 0x2a1a10, emissiveIntensity: 0.06,
  });
}

// Colored materials cached by color (not hit-flashed, not class-recolorable).
function makeVisorMat(visorTintHex: number): THREE.MeshStandardMaterial {
  return coloredMat(`visor_${visorTintHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, roughness: 0.15, metalness: 0.7,
    transparent: true, opacity: 0.92,
    emissive: visorTintHex, emissiveIntensity: 0.45,
  }));
}
function makeAccentMat(accentHex: number): THREE.MeshStandardMaterial {
  return coloredMat(`accent_${accentHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: accentHex, roughness: 0.5, metalness: 0.2,
    emissive: accentHex, emissiveIntensity: 0.25,
  }));
}
// Task 28 — glove color is now an independent granular field (defaults to vest).
// Task 33 — pebbled leather normal map for tactical glove leather.
function makeGloveMat(gloveHex: number): THREE.MeshStandardMaterial {
  const leatherNormal = tex("leatherNormal_global", () => leatherNormalTexture());
  return coloredMat(`glove_${gloveHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: gloveHex, roughness: 0.7, metalness: 0.05,
    normalMap: leatherNormal, normalScale: new THREE.Vector2(0.7, 0.7),
  }));
}
// Task 28 — balaclava color is now an independent granular field (defaults to
// a darker shade of the suit). Caller computes the actual hex.
function makeBalaclavaMat(balaclavaHex: number): THREE.MeshStandardMaterial {
  return coloredMat(`balaclava_${balaclavaHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: balaclavaHex, roughness: 0.9, metalness: 0.0,
  }));
}
// Task 28 — outer jacket layer (worn over the shirt). Same fabric texture as
// the suit, distinct color.
function makeJacketMat(jacketHex: number): THREE.MeshStandardMaterial {
  const fabric = tex(`fabric_${jacketHex.toString(16)}`, () => tacticalFabricTexture(jacketHex));
  const fabricRough = tex(`fabricR_${jacketHex.toString(16)}`, () => tacticalFabricTexture(jacketHex, true));
  // Task 33 — woven fabric normal map (matches suit fabric weave).
  const fabricNormal = tex("fabricNormal_global", () => fabricNormalTexture());
  return coloredMat(`jacket_${jacketHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: jacketHex, map: fabric, roughnessMap: fabricRough,
    normalMap: fabricNormal, normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.88, metalness: 0.0,
  }));
}
// Task 28 — backpack color (defaults to a darker shade of the vest).
function makeBagMat(bagHex: number): THREE.MeshStandardMaterial {
  return coloredMat(`bag_${bagHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: bagHex, roughness: 0.8, metalness: 0.05,
  }));
}
// Task 28 — boot color override (defaults to fixed dark rubber).
// Task 33 — pebbled leather normal map for boot leather.
function makeBootMatOverride(bootHex: number): THREE.MeshStandardMaterial {
  const boot = tex("boot_v4", () => bootTexture());
  const leatherNormal = tex("leatherNormal_global", () => leatherNormalTexture());
  return coloredMat(`bootOvr_${bootHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: bootHex, map: boot, roughness: 0.7, metalness: 0.05,
    normalMap: leatherNormal, normalScale: new THREE.Vector2(0.8, 0.8),
  }));
}
// Task 28 — pouch color override (defaults to fixed dark pouch).
function makePouchMatOverride(pouchHex: number): THREE.MeshStandardMaterial {
  return coloredMat(`pouchOvr_${pouchHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: pouchHex, roughness: 0.75, metalness: 0.05,
  }));
}
// Task 28 — pad color override (knee + elbow, defaults to fixed dark pad).
function makePadMatOverride(padHex: number): THREE.MeshStandardMaterial {
  return coloredMat(`padOvr_${padHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: padHex, roughness: 0.65, metalness: 0.1,
  }));
}
// Task 28 — lip color override (defaults to fixed natural tint 0xb06a5a).
function makeLipMat(lipHex: number): THREE.MeshStandardMaterial {
  return coloredMat(`lip_${lipHex.toString(16)}`, () => new THREE.MeshStandardMaterial({
    color: lipHex, roughness: 0.6, metalness: 0.0,
  }));
}

// ─── Face detail materials (Task 20) ────────────────────────────────────────
// Cached by color so per-enemy random iris/hair colors don't allocate a fresh
// material per enemy (with only 4 iris colors + 3 hair colors, at most 7 unique
// materials exist across all humanoids). Not hit-flashed, not class-recolorable.
function makeIrisMat(color: number): THREE.MeshStandardMaterial {
  return coloredMat(`iris_${color.toString(16).padStart(6, "0")}`, () => new THREE.MeshStandardMaterial({
    color, roughness: 0.25, metalness: 0.1,
    emissive: color, emissiveIntensity: 0.18,
  }));
}
function makeHairMat(color: number): THREE.MeshStandardMaterial {
  return coloredMat(`hair_${color.toString(16).padStart(6, "0")}`, () => new THREE.MeshStandardMaterial({
    color, roughness: 0.9, metalness: 0.0,
  }));
}

// Fixed-color materials (shared across ALL humanoids — color never changes).
function pouchMat(): THREE.MeshStandardMaterial {
  return fixedMat("pouch_v4", () => new THREE.MeshStandardMaterial({
    color: 0x1a1a1e, roughness: 0.75, metalness: 0.05,
  }));
}
function beltMat(): THREE.MeshStandardMaterial {
  // Task 33 — pebbled leather normal map for the tactical belt.
  const leatherNormal = tex("leatherNormal_global", () => leatherNormalTexture());
  return fixedMat("belt_v4", () => new THREE.MeshStandardMaterial({
    color: 0x2a2a2e, roughness: 0.8, metalness: 0.0,
    normalMap: leatherNormal, normalScale: new THREE.Vector2(0.6, 0.6),
  }));
}
function weaponMat(): THREE.MeshStandardMaterial {
  const metal = tex("metal_v4", () => metalRoughTexture());
  // Task 33 — brushed metal normal map for machined metal gear (weapon
  // frames, buckles, rails, NVG mounts).
  const metalNormal = tex("metalNormal_global", () => metalNormalTexture());
  return fixedMat("weapon_v4", () => new THREE.MeshStandardMaterial({
    color: 0x2a2a2e, map: metal, roughness: 0.4, metalness: 0.7,
    normalMap: metalNormal, normalScale: new THREE.Vector2(0.4, 0.4),
  }));
}
function bootMat(): THREE.MeshStandardMaterial {
  const boot = tex("boot_v4", () => bootTexture());
  // Task 33 — pebbled leather normal map for combat boot leather.
  const leatherNormal = tex("leatherNormal_global", () => leatherNormalTexture());
  return fixedMat("boot_v4", () => new THREE.MeshStandardMaterial({
    color: 0x141416, map: boot, roughness: 0.7, metalness: 0.05,
    normalMap: leatherNormal, normalScale: new THREE.Vector2(0.8, 0.8),
  }));
}
function padMat(): THREE.MeshStandardMaterial {
  return fixedMat("pad_v4", () => new THREE.MeshStandardMaterial({
    color: 0x0e0e10, roughness: 0.65, metalness: 0.1,
  }));
}

/**
 * Build a COD-style tactical operator figure from primitive shapes with PBR
 * materials. Proportions: ~1.85m tall, athletic build, head:torso:leg ratio
 * ~1:3:4, shoulder width ~0.5m.
 *
 * `suitColor` overrides the base jumpsuit color (for enemy team colors).
 * `skinColor` is the skin tone (used when the face is visible — cap helmet).
 * `operatorSlug` (optional) drives a full OperatorVisual config that
 * customizes suit, vest, helmet, visor tint, accent stripe, and helmet
 * style — producing the 5 discrete operator identities.
 *
 * Returns `{ group, parts }` where `parts` is a named mesh dictionary used by
 * `animateGait` (limb swing), `EnemyClasses.applyClassToEnemy` (suit recolor
 * via `parts.body.material`), and `EnemySystem` (hit-flash via
 * `parts.{body,head,vest,helmet}.material` + headshot flag on
 * `parts.{head,helmet}`).
 */
export function buildHumanoid(
  suitColor: number,
  skinColor = 0x9a7a5a,
  operatorSlug?: string | null,
  /**
   * Task 28 — optional per-call customization overrides. Merged onto the
   * preset's base visual via getOperatorVisual → mergeOperatorVisual. This is
   * what the customization studio passes while the user is dragging color
   * sliders (live preview). Existing callers don't pass it (backward compat).
   */
  customOverride?: Partial<OperatorVisual>,
): {
  group: THREE.Group;
  parts: Record<string, THREE.Mesh>;
} {
  const group = new THREE.Group();

  // Resolve operator visual config (falls back to suitColor/skinColor).
  // Task 28 — pass customOverride to merge per-call color/toggle overrides.
  const op = operatorSlug ? getOperatorVisual(operatorSlug, customOverride) : null;
  const suitHex = op ? parseInt(op.suit.replace("#", "0x")) : suitColor;
  const vestHex = op ? parseInt(op.vest.replace("#", "0x")) : 0x2c4f7c;
  const helmetHex = op ? parseInt(op.helmet.replace("#", "0x")) : 0x2c4f7c;
  const visorTintHex = op ? parseInt(op.visorTint.replace("#", "0x")) : 0xff8c1a;
  const accentHex = op ? parseInt(op.accent.replace("#", "0x")) : 0xff8c1a;
  const skinHex = op ? skinToneHexNum(op.skinTone) : skinColor;
  const helmetStyle = op ? op.helmetStyle : "standard";

  // ─── Task 28: granular color resolution (fall back to derived defaults) ──
  /** Darken a hex color by `factor` (0..1) — used for derived defaults. */
  const darken = (hex: number, factor: number): number => {
    const r = Math.round(((hex >> 16) & 0xff) * factor);
    const g = Math.round(((hex >> 8) & 0xff) * factor);
    const b = Math.round((hex & 0xff) * factor);
    return (r << 16) | (g << 8) | b;
  };
  const parseHex = (s: string): number => parseInt(s.replace("#", "0x"));

  // Clothing — shirt (torso + sleeves), pants (hips + legs), jacket (outer).
  // When shirtColor/pantsColor are undefined, both fall back to suitHex → the
  // shared suitMatV is used (so applyClassToEnemy recolor works for enemies).
  const shirtHex = op?.shirtColor ? parseHex(op.shirtColor) : suitHex;
  const pantsHex = op?.pantsColor ? parseHex(op.pantsColor) : suitHex;
  const jacketHex = op?.jacketColor ? parseHex(op.jacketColor) : darken(suitHex, 0.72);

  // Gear — bag, glove, boot, pouch, pads, balaclava.
  const bagHex = op?.bagColor ? parseHex(op.bagColor) : darken(vestHex, 0.85);
  const gloveHex = op?.gloveColor ? parseHex(op.gloveColor) : vestHex;
  const bootHex = op?.bootColor ? parseHex(op.bootColor) : 0x141416;       // matches fixed bootMat
  const pouchHex = op?.pouchColor ? parseHex(op.pouchColor) : 0x1a1a1e;    // matches fixed pouchMat
  const kneePadHex = op?.kneePadColor ? parseHex(op.kneePadColor) : 0x0e0e10;   // matches fixed padMat
  const elbowPadHex = op?.elbowPadColor ? parseHex(op.elbowPadColor) : 0x0e0e10;
  const balaclavaHex = op?.balaclavaColor ? parseHex(op.balaclavaColor) : darken(suitHex, 0.45);

  // Face — eye/lip/hair. null = random (preserves Task 20 variety for enemies).
  const eyeColorNum: number | null = op?.eyeColor ? parseHex(op.eyeColor) : null;
  const lipColorNum = op?.lipColor ? parseHex(op.lipColor) : 0xb06a5a;
  const hairColorNum: number | null = op?.hairColor ? parseHex(op.hairColor) : null;

  // Accessory toggles — default true (false for glasses — only show if opted in).
  const hasNVG = op?.hasNVG ?? true;
  const hasHeadset = op?.hasHeadset ?? true;
  const hasBackpack = op?.hasBackpack ?? true;
  const hasBalaclavaToggle = op?.hasBalaclava ?? true;
  const hasKneePads = op?.hasKneePads ?? true;
  const hasElbowPads = op?.hasElbowPads ?? true;
  const hasSidearm = op?.hasSidearm ?? true;
  const hasGlasses = op?.hasGlasses ?? false;

  // Per-call materials (must be unique per enemy for hit-flash + class recolor).
  // Task 28 — when shirtHex == pantsHex (no overrides), share ONE material
  // instance so applyClassToEnemy's body.material recolor also reaches the legs
  // (preserves the existing enemy class-color behavior). When they differ
  // (player customized), allocate separate materials.
  const sameSuitColor = shirtHex === pantsHex;
  const shirtMatV = makeSuitMat(shirtHex);
  const pantsMatV = sameSuitColor ? shirtMatV : makeSuitMat(pantsHex);
  const vestMatV = makeVestMat(vestHex);
  const helmetMatV = makeHelmetMat(helmetHex);
  const skinMatV = makeSkinMat(skinHex);
  // Cached colored materials (not hit-flashed, not class-recolorable).
  const visorMatV = makeVisorMat(visorTintHex);
  const accentMatV = makeAccentMat(accentHex);
  const gloveMatV = makeGloveMat(gloveHex);
  const balaclavaMatV = makeBalaclavaMat(balaclavaHex);
  const jacketMatV = makeJacketMat(jacketHex);
  const bagMatV = makeBagMat(bagHex);
  // Task 28 — fixed materials are used when no per-color override is set
  // (preserves the cross-humanoid sharing optimization for enemies); per-color
  // materials are used when the player has customized that field.
  const bootMatV = op?.bootColor ? makeBootMatOverride(bootHex) : bootMat();
  const pouchMatV = op?.pouchColor ? makePouchMatOverride(pouchHex) : pouchMat();
  const kneePadMatV = op?.kneePadColor ? makePadMatOverride(kneePadHex) : padMat();
  const elbowPadMatV = op?.elbowPadColor ? makePadMatOverride(elbowPadHex) : padMat();
  const lipMatV = op?.lipColor ? makeLipMat(lipColorNum) : null;
  // Shared fixed-color materials.
  const beltMatV = beltMat();
  const weaponMatV = weaponMat();

  // Helper: add a mesh to the group + parts dict + set shadow flags.
  // Returns the mesh so the caller can set rotation/scale afterwards.
  const parts: Record<string, THREE.Mesh> = {};
  function add(name: string, mesh: THREE.Mesh, x = 0, y = 0, z = 0, shadow = true): THREE.Mesh {
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    group.add(mesh);
    parts[name] = mesh;
    return mesh;
  }

  // ═══ Torso ═══════════════════════════════════════════════════════════════
  // Task 28 — torso (body + abdomen) uses the shirt color; pelvis uses the
  // pants color. When shirtColor == pantsColor (no override), both share the
  // same suitMatV instance (preserves applyClassToEnemy recolor behavior).
  add("body", new THREE.Mesh(torsoGeo(), shirtMatV), 0, 1.15, 0);
  // Lower torso fill (between vest bottom and belt).
  add("abdomen", new THREE.Mesh(box(0.36, 0.14, 0.26), shirtMatV), 0, 0.80, 0);
  // Pelvis.
  add("hips", new THREE.Mesh(hipsGeo(), pantsMatV), 0, 0.72, 0);
  // Accent team stripe on left shoulder (operator identity).
  add("shoulderStripe", new THREE.Mesh(box(0.025, 0.16, 0.30), accentMatV), -0.26, 1.42, 0, false);

  // ═══ Task 33: Collarbones (clavicles) — LOD1 ═══════════════════════════════
  // Two thin horizontal skin-colored cylinders on the chest top, just below the
  // neck. Visible above the vest neckline + below the neck when the head turns.
  // Each clavicle runs from the sternum (center) outward to the shoulder joint.
  const clavGeoL = cyl(0.012, 0.010, 0.18, 6);
  const clavL = add("collarboneL", new THREE.Mesh(clavGeoL, skinMatV), -0.09, 1.46, 0.08, false);
  clavL.rotation.z = Math.PI / 2;        // lay flat horizontally (along X)
  clavL.rotation.x = -0.15;              // slight downward tilt toward shoulder
  const clavR = add("collarboneR", new THREE.Mesh(clavGeoL, skinMatV), 0.09, 1.46, 0.08, false);
  clavR.rotation.z = Math.PI / 2;
  clavR.rotation.x = -0.15;

  // ═══ Task 33: Abdominal crease lines — LOD1 ═══════════════════════════════
  // Two thin horizontal dark lines on the lower torso (above the belt) that
  // suggest abdominal definition. Only visible if the vest doesn't cover them
  // (the vest bottom is at y≈1.0, the creases are at y≈0.86 + 0.90 — above
  // the belt at y=0.84 but below the vest bottom). The creases read through
  // the shirt as shadow lines.
  const abCreaseMat = fixedMat("abCrease_v1", () => new THREE.MeshStandardMaterial({
    color: 0x1a1208, roughness: 0.9, metalness: 0.0,
  }));
  add("abCreaseUpper", new THREE.Mesh(box(0.30, 0.004, 0.012), abCreaseMat), 0, 0.90, 0.13, false);
  add("abCreaseLower", new THREE.Mesh(box(0.28, 0.004, 0.012), abCreaseMat), 0, 0.86, 0.13, false);

  // ═══ Task 28: Outer jacket layer (worn over the shirt) ═════════════════════
  // Two open-front panels over the torso — a slightly larger box than the
  // body, split into left + right halves with a small gap (open front). Reads
  // as a tactical jacket or overshirt. Hidden when jacketColor is undefined
  // AND no shirt/pants override is set (avoids a redundant layer for presets
  // that don't customize clothing — the suit already covers the torso).
  if (op?.jacketColor || op?.shirtColor || op?.pantsColor) {
    // Left front panel — covers the left chest, open at center.
    add("jacketPanelL", new THREE.Mesh(box(0.21, 0.50, 0.12), jacketMatV), -0.115, 1.18, 0.06);
    // Right front panel — covers the right chest, open at center.
    add("jacketPanelR", new THREE.Mesh(box(0.21, 0.50, 0.12), jacketMatV), 0.115, 1.18, 0.06);
    // Back panel — single piece covering the upper back.
    add("jacketBack", new THREE.Mesh(box(0.46, 0.52, 0.06), jacketMatV), 0, 1.18, -0.10);
    // Collar — thin raised band at the top of the jacket (neck opening).
    add("jacketCollar", new THREE.Mesh(torGeo(0.085, 0.018, 6, 14), jacketMatV), 0, 1.42, 0, false);
  }

  // ═══ Plate carrier vest ═══════════════════════════════════════════════════
  // Front plate — 'vest' is the canonical name used by EnemySystem hit-flash.
  add("vest", new THREE.Mesh(box(0.42, 0.46, 0.10), vestMatV), 0, 1.16, 0.17);
  // Back plate.
  add("vestBack", new THREE.Mesh(box(0.42, 0.46, 0.08), vestMatV), 0, 1.16, -0.17);
  // Side panels — wrap the vest around the torso.
  add("vestSideL", new THREE.Mesh(box(0.08, 0.40, 0.24), vestMatV), -0.24, 1.16, 0);
  add("vestSideR", new THREE.Mesh(box(0.08, 0.40, 0.24), vestMatV), 0.24, 1.16, 0);
  // Padded shoulder straps (over the shoulders).
  add("lShoulderStrap", new THREE.Mesh(box(0.12, 0.10, 0.28), vestMatV), -0.22, 1.40, 0);
  add("rShoulderStrap", new THREE.Mesh(box(0.12, 0.10, 0.28), vestMatV), 0.22, 1.40, 0);

  // ═══ Task 33: Shoulder pads — LOD2 ═════════════════════════════════════════
  // Athletic-build shoulder pads that widen the silhouette from 0.48m to 0.52m
  // at the shoulder line. Slightly flattened spheres capping the shoulder
  // joints, just outside the existing shoulder straps. Reads as a more athletic
  // proportion (delta-elite operator build, not slim civilian).
  const lShoulderPad = add("lShoulderPad", new THREE.Mesh(sph(0.085, 10, 8), vestMatV), -0.27, 1.42, 0);
  lShoulderPad.scale.set(0.9, 0.7, 1.0);
  const rShoulderPad = add("rShoulderPad", new THREE.Mesh(sph(0.085, 10, 8), vestMatV), 0.27, 1.42, 0);
  rShoulderPad.scale.set(0.9, 0.7, 1.0);

  // ═══ Task 33: Plate carrier edge bevel + stitch lines — LOD1 ═══════════════
  // A slightly larger box behind the main vest panel so the edges read as thick
  // (beveled plate profile). Plus 4 thin dark stitch lines along the vest edges
  // (top, bottom, left, right) — the signature tactical-gear stitching pattern.
  add("vestEdgeBevel", new THREE.Mesh(box(0.44, 0.48, 0.08), vestMatV), 0, 1.16, 0.135, false);
  const stitchMat = fixedMat("vestStitch_v1", () => new THREE.MeshStandardMaterial({
    color: 0x080808, roughness: 0.9, metalness: 0.0,
  }));
  // Top + bottom horizontal stitch lines.
  add("vestStitchTop", new THREE.Mesh(box(0.42, 0.004, 0.012), stitchMat), 0, 1.395, 0.225, false);
  add("vestStitchBottom", new THREE.Mesh(box(0.42, 0.004, 0.012), stitchMat), 0, 0.930, 0.225, false);
  // Left + right vertical stitch lines.
  add("vestStitchLeft", new THREE.Mesh(box(0.004, 0.46, 0.012), stitchMat), -0.215, 1.16, 0.225, false);
  add("vestStitchRight", new THREE.Mesh(box(0.004, 0.46, 0.012), stitchMat), 0.215, 1.16, 0.225, false);

  // Magazine pouches on vest front (4 pouches).
  for (let i = 0; i < 4; i++) {
    add(`magPouch_${i}`, new THREE.Mesh(box(0.07, 0.11, 0.05), pouchMatV), -0.105 + i * 0.07, 1.02, 0.23);
  }
  // ═══ Task 33: Magazine pouch pull-tabs — LOD1 ══════════════════════════════
  // A thin loop at the top of each mag pouch (for fast mag extraction). Small
  // torus + a tiny vertical cylinder suggests the pull-tab webbing strap.
  const pullTabMat = fixedMat("pullTab_v1", () => new THREE.MeshStandardMaterial({
    color: 0x1a1a1a, roughness: 0.85, metalness: 0.0,
  }));
  for (let i = 0; i < 4; i++) {
    const px = -0.105 + i * 0.07;
    // Vertical strap cylinder.
    add(`magPullTab_${i}`, new THREE.Mesh(cyl(0.003, 0.003, 0.022, 5), pullTabMat), px, 1.090, 0.260, false);
    // Loop at the top (small flattened torus).
    const loop = add(`magPullLoop_${i}`, new THREE.Mesh(torGeo(0.008, 0.002, 5, 10), pullTabMat), px, 1.105, 0.260, false);
    loop.rotation.x = Math.PI / 2;
    loop.scale.set(1, 0.5, 1);
  }
  // Utility pouches on vest sides.
  add("utilPouchL", new THREE.Mesh(box(0.09, 0.16, 0.10), pouchMatV), -0.27, 1.04, 0.10);
  add("utilPouchR", new THREE.Mesh(box(0.09, 0.16, 0.10), pouchMatV), 0.27, 1.04, 0.10);
  // Chest admin pouch (small, top center of vest).
  add("adminPouch", new THREE.Mesh(box(0.12, 0.06, 0.05), pouchMatV), 0, 1.36, 0.22, false);

  // ═══ Tactical belt ═══════════════════════════════════════════════════════
  add("belt", new THREE.Mesh(box(0.44, 0.06, 0.30), beltMatV), 0, 0.84, 0);
  add("buckle", new THREE.Mesh(box(0.07, 0.045, 0.025), weaponMatV), 0, 0.84, 0.16, false);
  // Hip pouches (left + right).
  add("hipPouchL", new THREE.Mesh(box(0.10, 0.10, 0.13), pouchMatV), -0.25, 0.74, 0);
  add("hipPouchR", new THREE.Mesh(box(0.10, 0.10, 0.13), pouchMatV), 0.25, 0.74, 0);

  // ═══ Task 33: Belt loops + knife sheath — LOD1 ═════════════════════════════
  // 3 thin loops around the belt (front-left, front-right, back) — the loops
  // that hold the belt to the pants. Plus a small knife sheath on the left side
  // (a thin angled dark box with a small handle sticking out the top).
  const beltLoopMat = pouchMatV; // same material as pouches (webbing color)
  // Front-left belt loop.
  const blFrontL = add("beltLoopFrontL", new THREE.Mesh(torGeo(0.035, 0.006, 5, 10), beltLoopMat), -0.10, 0.84, 0.155, false);
  blFrontL.rotation.x = Math.PI / 2;
  blFrontL.scale.set(1.0, 1.0, 0.8);
  // Front-right belt loop.
  const blFrontR = add("beltLoopFrontR", new THREE.Mesh(torGeo(0.035, 0.006, 5, 10), beltLoopMat), 0.10, 0.84, 0.155, false);
  blFrontR.rotation.x = Math.PI / 2;
  blFrontR.scale.set(1.0, 1.0, 0.8);
  // Back belt loop.
  const blBack = add("beltLoopBack", new THREE.Mesh(torGeo(0.035, 0.006, 5, 10), beltLoopMat), 0, 0.84, -0.155, false);
  blBack.rotation.x = Math.PI / 2;
  blBack.scale.set(1.0, 1.0, 0.8);
  // Knife sheath — thin angled dark box on the left side of the belt.
  const knifeSheath = add("knifeSheath", new THREE.Mesh(box(0.04, 0.16, 0.025), pouchMatV), -0.24, 0.78, 0.10, false);
  knifeSheath.rotation.z = 0.15; // slight inward tilt
  // Knife handle sticking out the top (small metallic cylinder + crossguard).
  add("knifeHandle", new THREE.Mesh(cyl(0.008, 0.008, 0.045, 6), weaponMatV), -0.24, 0.88, 0.10, false);
  add("knifeGuard", new THREE.Mesh(box(0.028, 0.008, 0.012), weaponMatV), -0.24, 0.865, 0.10, false);

  // ═══ Neck + Head + Face detail (Task 20: ultra-detailed humanoid head) ═══
  add("neck", new THREE.Mesh(cyl(0.07, 0.085, 0.12, 10), shirtMatV), 0, 1.55, 0);

  // ═══ Task 33: Neck muscles (sternocleidomastoid) — LOD1 ════════════════════
  // Two thin skin-colored cylinders running diagonally from behind the ear to
  // the collarbone — the sternocleidomastoid muscles that define the neck.
  // Visible when the head turns (the muscles tense + become prominent). Skin-
  // colored, sitting just outside the neck cylinder on each side.
  const scmGeo = cyl(0.014, 0.010, 0.16, 6);
  const scmL = add("neckMuscleL", new THREE.Mesh(scmGeo, skinMatV), -0.055, 1.55, 0.040, false);
  scmL.rotation.z = -0.35; // tilt from behind-ear (top) to collarbone (bottom)
  scmL.rotation.x = 0.10;
  const scmR = add("neckMuscleR", new THREE.Mesh(scmGeo, skinMatV), 0.055, 1.55, 0.040, false);
  scmR.rotation.z = 0.35;
  scmR.rotation.x = 0.10;
  // Balaclava (lower-face covering) — for "full"/"visor" helmets, covers the
  // chin/jaw/mouth but leaves the eyes/eyebrows exposed above the cheekbone
  // line so they read through the helmet's visor slit. For "standard" the
  // lower face is intentionally left visible (no balaclava — the visor covers
  // the eyes and the nose/lips below are exposed). For "cap" the full face is
  // visible (no balaclava).
  // Task 28 — hasBalaclava toggle (default true) lets the player hide the
  // balaclava even on full/visor helmets (exposing the lower face).
  if ((helmetStyle === "full" || helmetStyle === "visor") && hasBalaclavaToggle) {
    const balaclava = add("balaclava", new THREE.Mesh(
      sphPartial(0.140, 12, 10, 0, Math.PI * 2, Math.PI * 0.50, Math.PI * 0.50),
      balaclavaMatV,
    ), 0, 1.585, 0.005);
    balaclava.scale.set(0.95, 1.05, 1.0);
  }
  // Head — anatomical skull (jaw taper, forehead bulge, cheekbones).
  add("head", new THREE.Mesh(headSkullGeo(), skinMatV), 0, 1.65, 0);

  // ─── Face detail (LOD-gated — see LODSystem.ts) ───────────────────────────
  // Anatomical face parts: eyes, eyelids, eyelashes, eyebrows, nose, lips,
  // ears, cheekbones, stubble, hair. LOD tiers:
  //   LOD1 (15-30m): eyelashes, stubble, philtrum, nostrils, cheekbones,
  //                  ear inner curve, mouth line.
  //   LOD2 (30-50m): eyebrows, eyelids, lips, nose bridge + tip, ears, hair.
  //   LOD3 (>50m):   all face detail hidden — only head + eyes (alive glow).
  //   Core:          head, eyeSclera, eyeIris, eyePupil (always visible).

  // Eye positions — at eye level, in front of the head surface.
  // eyeDX is half the inter-pupillary distance (~0.035 → 7cm apart, close to
  // the spec's ~0.05 guideline while leaving a small gap between the scleras).
  const eyeY = 1.685;
  const eyeZ = 0.118;
  const eyeDX = 0.035;

  // Sclera (white of eye) — wet-look, slight emissive for catch-light.
  const scleraMat = fixedMat("sclera_v1", () => new THREE.MeshStandardMaterial({
    color: 0xf0f0e8, roughness: 0.3, metalness: 0.0,
    emissive: 0x0a0a08, emissiveIntensity: 0.05,
  }));
  // Iris — Task 28: eyeColor override (if set) replaces the per-humanoid
  // random iris color. Cached by color so only a few unique iris materials
  // exist across all humanoids (4 random colors + N custom eye colors).
  const irisColors = [0x4a3a2a, 0x3a5a8a, 0x3a6a4a, 0x6a5a3a];
  const irisColor = eyeColorNum ?? irisColors[Math.floor(Math.random() * irisColors.length)];
  const irisMat = makeIrisMat(irisColor);
  const pupilMat = fixedMat("pupil_v1", () => new THREE.MeshStandardMaterial({
    color: 0x050505, roughness: 0.15, metalness: 0.0,
  }));

  // ─── Eyes (CORE — always visible for the "alive" reading) ──────────────
  // Sclera sphere (radius 0.022) sits in a slight eye socket depression; the
  // iris (flattened disc) + pupil sit in front of the sclera so the eye reads
  // as a colored disc with a black center from any angle.
  add("eyeScleraL", new THREE.Mesh(sph(0.022, 10, 8), scleraMat), -eyeDX, eyeY, eyeZ);
  const irisL = add("eyeIrisL", new THREE.Mesh(sph(0.012, 10, 8), irisMat), -eyeDX, eyeY, eyeZ + 0.018);
  irisL.scale.set(1, 1, 0.4); // flatten to a disc facing forward
  add("eyePupilL", new THREE.Mesh(sph(0.005, 8, 6), pupilMat), -eyeDX, eyeY, eyeZ + 0.024);

  add("eyeScleraR", new THREE.Mesh(sph(0.022, 10, 8), scleraMat), eyeDX, eyeY, eyeZ);
  const irisR = add("eyeIrisR", new THREE.Mesh(sph(0.012, 10, 8), irisMat), eyeDX, eyeY, eyeZ + 0.018);
  irisR.scale.set(1, 1, 0.4);
  add("eyePupilR", new THREE.Mesh(sph(0.005, 8, 6), pupilMat), eyeDX, eyeY, eyeZ + 0.024);

  // ─── Eyelids (LOD2) — thin skin-colored strips above/below each eye ─────
  // The upper lid is a thin tilted box just above the eye; the lower lid is a
  // thin tilted box just below. Together they frame the eye and give a hooded
  // look (the sclera doesn't read as a blank white sphere).
  const upperLidL = add("eyeUpperLidL", new THREE.Mesh(box(0.044, 0.005, 0.012), skinMatV), -eyeDX, eyeY + 0.020, eyeZ + 0.010);
  upperLidL.rotation.x = -0.3;
  const upperLidR = add("eyeUpperLidR", new THREE.Mesh(box(0.044, 0.005, 0.012), skinMatV), eyeDX, eyeY + 0.020, eyeZ + 0.010);
  upperLidR.rotation.x = -0.3;
  const lowerLidL = add("eyeLowerLidL", new THREE.Mesh(box(0.040, 0.004, 0.010), skinMatV), -eyeDX, eyeY - 0.020, eyeZ + 0.008);
  lowerLidL.rotation.x = 0.3;
  const lowerLidR = add("eyeLowerLidR", new THREE.Mesh(box(0.040, 0.004, 0.010), skinMatV), eyeDX, eyeY - 0.020, eyeZ + 0.008);
  lowerLidR.rotation.x = 0.3;

  // ─── Eyelashes (LOD1) — 8 tiny dark cylinders per eye along the upper lid
  // Subtle but present — gives the eye a defined lash line. Fanned outward
  // (each lash tilts away from the eye center) and tilted forward slightly.
  const lashMat = fixedMat("lash_v1", () => new THREE.MeshStandardMaterial({
    color: 0x1a1208, roughness: 0.8, metalness: 0.0,
  }));
  const lashGeo = cyl(0.0006, 0.0006, 0.007, 4);
  const lashCount = 8;
  for (let i = 0; i < lashCount; i++) {
    const t = i / (lashCount - 1) - 0.5; // -0.5 to +0.5
    const angle = t * 1.0;               // -0.5 to +0.5 rad (about ±29°)
    const r = 0.024;                     // slightly larger than sclera (0.022)
    // Position along the curve of the upper eyelid edge (top of the eye orbit).
    const px = Math.sin(angle) * r;
    const py = Math.cos(angle) * r * 0.6 + 0.014;
    const pz = Math.cos(angle) * r * 0.5 + 0.008;
    const lashL = add(`eyelashL${i}`, new THREE.Mesh(lashGeo, lashMat), -eyeDX + px, eyeY + py, eyeZ + pz);
    lashL.rotation.x = -0.4 + Math.cos(angle) * 0.1; // tilt forward
    lashL.rotation.z = angle * 0.5;                   // fan outward
    const lashR = add(`eyelashR${i}`, new THREE.Mesh(lashGeo, lashMat), eyeDX + px, eyeY + py, eyeZ + pz);
    lashR.rotation.x = -0.4 + Math.cos(angle) * 0.1;
    lashR.rotation.z = angle * 0.5;
  }

  // ─── Eyebrows (LOD2) — thin angled strips above each eye, dark hair color
  // Slight arch (outer end higher than inner) for a relaxed, alert expression.
  const browMat = fixedMat("brow_v1", () => new THREE.MeshStandardMaterial({
    color: 0x2a1a0a, roughness: 0.85, metalness: 0.0,
  }));
  const browGeo = box(0.05, 0.008, 0.012);
  const browL = add("eyebrowL", new THREE.Mesh(browGeo, browMat), -eyeDX, eyeY + 0.030, eyeZ + 0.005);
  browL.rotation.z = -0.08; // outer end up, inner end down (relaxed arch)
  const browR = add("eyebrowR", new THREE.Mesh(browGeo, browMat), eyeDX, eyeY + 0.030, eyeZ + 0.005);
  browR.rotation.z = 0.08;

  // ─── Nose (LOD2: bridge + tip; LOD1: nostrils) ──────────────────────────
  // Bridge — thin tapered box from between the eyes down to the tip.
  const noseBridge = add("noseBridge", new THREE.Mesh(box(0.022, 0.075, 0.022), skinMatV), 0, 1.635, eyeZ + 0.005);
  noseBridge.scale.set(1, 1, 0.7);
  // Tip — small sphere at the bottom of the bridge.
  add("noseTip", new THREE.Mesh(sph(0.018, 8, 6), skinMatV), 0, 1.600, eyeZ + 0.015);
  // Nostrils — two small dark spheres on the underside of the tip.
  const nostrilMat = fixedMat("nostril_v1", () => new THREE.MeshStandardMaterial({
    color: 0x1a0a08, roughness: 0.9, metalness: 0.0,
  }));
  add("nostrilL", new THREE.Mesh(sph(0.005, 6, 5), nostrilMat), -0.008, 1.595, eyeZ + 0.018);
  add("nostrilR", new THREE.Mesh(sph(0.005, 6, 5), nostrilMat), 0.008, 1.595, eyeZ + 0.018);

  // ═══ Task 33: Nose detail (bridge highlight + septum) — LOD1 ════════════════
  // Bridge highlight — a subtle raised line along the top of the nose bridge
  // (slightly lighter skin tone catches more light, defining the nose ridge).
  // Septum — thin vertical divider between the nostrils (skin-colored wall).
  const noseHighlightMat = fixedMat("noseHighlight_v1", () => new THREE.MeshStandardMaterial({
    color: 0xe0c8a8, roughness: 0.7, metalness: 0.0,
    emissive: 0x2a1a10, emissiveIntensity: 0.04,
  }));
  const noseHighlight = add("noseBridgeHighlight", new THREE.Mesh(
    cyl(0.004, 0.005, 0.07, 5), noseHighlightMat,
  ), 0, 1.635, eyeZ + 0.018, false);
  noseHighlight.rotation.x = Math.PI / 2; // lay along the bridge (Z axis)
  // Septum — thin skin-colored wall between the nostrils, slightly behind them.
  const septum = add("noseSeptum", new THREE.Mesh(box(0.006, 0.014, 0.010), skinMatV), 0, 1.592, eyeZ + 0.013, false);
  septum.scale.set(1, 1, 0.7);

  // ─── Mouth + Lips (LOD2: lips; LOD1: mouth line + philtrum) ─────────────
  // Lips are tinted slightly redder than the skin (natural lip tint). The
  // mouth line is a thin dark crease between the lips. The philtrum is the
  // vertical groove between the nose and the upper lip.
  const lipMat = fixedMat("lip_v1", () => new THREE.MeshStandardMaterial({
    color: 0xb06a5a, roughness: 0.6, metalness: 0.0,
  }));
  const mouthLineMat = fixedMat("mouthline_v1", () => new THREE.MeshStandardMaterial({
    color: 0x3a1a14, roughness: 0.9, metalness: 0.0,
  }));
  // Upper lip — thin curved strip below the nose.
  const upperLip = add("upperLip", new THREE.Mesh(box(0.06, 0.012, 0.012), lipMat), 0, 1.575, eyeZ + 0.002);
  upperLip.scale.set(1, 1, 0.5);
  // Lower lip — slightly fuller curved strip below the upper lip.
  const lowerLip = add("lowerLip", new THREE.Mesh(box(0.05, 0.015, 0.012), lipMat), 0, 1.560, eyeZ + 0.002);
  lowerLip.scale.set(1, 1, 0.5);
  // Mouth line — thin dark crease between the lips.
  const mouthLine = add("mouthLine", new THREE.Mesh(box(0.055, 0.003, 0.008), mouthLineMat), 0, 1.568, eyeZ + 0.004);
  mouthLine.scale.set(1, 1, 0.5);
  // Philtrum — subtle vertical groove between nose and upper lip.
  const philtrum = add("philtrum", new THREE.Mesh(box(0.012, 0.022, 0.004), mouthLineMat), 0, 1.590, eyeZ - 0.002);
  philtrum.scale.set(1, 1, 0.5);

  // ═══ Task 33: Lip detail (seam + cupids bow) — LOD1 ═════════════════════════
  // Lip seam — a thin darker line right at the boundary between the upper +
  // lower lips (a slightly darker, sharper version of the existing mouth line,
  // positioned just above it to emphasize the lip seam). Cupid's bow — the
  // V-shaped notch on the upper lip at the center, between the two peaks of
  // the bow. Approximated by a small inverted-V dark line.
  const lipSeamMat = fixedMat("lipSeam_v1", () => new THREE.MeshStandardMaterial({
    color: 0x2a1010, roughness: 0.85, metalness: 0.0,
  }));
  // Lip seam — slightly thicker + darker than mouthLine, positioned just above
  // (closer to the upper lip edge) for the lip boundary definition.
  const lipSeam = add("lipSeam", new THREE.Mesh(box(0.058, 0.0025, 0.006), lipSeamMat), 0, 1.571, eyeZ + 0.005, false);
  lipSeam.scale.set(1, 1, 0.5);
  // Cupid's bow — small inverted-V mark at the center top of the upper lip.
  // Approximated as two short angled dark lines meeting at the center.
  const bowSeg = cyl(0.0015, 0.0015, 0.012, 4);
  const bowL = add("cupidsBowL", new THREE.Mesh(bowSeg, lipSeamMat), -0.005, 1.583, eyeZ + 0.006, false);
  bowL.rotation.z = -0.5; // angle up to the left
  const bowR = add("cupidsBowR", new THREE.Mesh(bowSeg, lipSeamMat), 0.005, 1.583, eyeZ + 0.006, false);
  bowR.rotation.z = 0.5; // angle up to the right

  // ─── Ears (LOD2: ear; LOD1: inner curve) — oval shapes on the head sides
  // Each ear — flattened sphere (scaled thin in X) on the side of the head.
  const earL = add("earL", new THREE.Mesh(sph(0.030, 10, 8), skinMatV), -0.130, 1.660, 0);
  earL.scale.set(0.35, 1.0, 1.0); // flatten in X (head side direction)
  const earR = add("earR", new THREE.Mesh(sph(0.030, 10, 8), skinMatV), 0.130, 1.660, 0);
  earR.scale.set(0.35, 1.0, 1.0);
  // Inner curve — thinner darker torus suggesting the helix + antihelix.
  const earInnerMat = fixedMat("earInner_v1", () => new THREE.MeshStandardMaterial({
    color: 0x6a4a30, roughness: 0.85, metalness: 0.0,
  }));
  const earInnerGeo = torGeo(0.018, 0.004, 6, 10);
  const earInnerL = add("earInnerL", new THREE.Mesh(earInnerGeo, earInnerMat), -0.140, 1.660, 0);
  earInnerL.rotation.y = Math.PI / 2; // ring around Y axis (facing sideways)
  earInnerL.scale.set(0.7, 1, 1);
  const earInnerR = add("earInnerR", new THREE.Mesh(earInnerGeo, earInnerMat), 0.140, 1.660, 0);
  earInnerR.rotation.y = Math.PI / 2;
  earInnerR.scale.set(0.7, 1, 1);

  // ═══ Task 33: Ear detail (concha + tragus) — LOD1 ═══════════════════════════
  // Concha — the bowl-shaped depression in the center of the ear (a small
  // darker flattened sphere pressed into the ear surface, suggesting the
  // hollow). Tragus — the small bump in front of the ear canal (the little
  // flap of cartilage that protects the canal opening). Both are subtle but
  // add real anatomical detail to the ear silhouette.
  const conchaMat = fixedMat("earConcha_v1", () => new THREE.MeshStandardMaterial({
    color: 0x8a6048, roughness: 0.9, metalness: 0.0,
  }));
  // Concha — small darker flattened sphere pressed into the center of each ear.
  const earConchaL = add("earConchaL", new THREE.Mesh(sph(0.012, 8, 6), conchaMat), -0.142, 1.660, 0.005, false);
  earConchaL.scale.set(0.6, 1.0, 0.8); // thin in X (pressed flat against head)
  const earConchaR = add("earConchaR", new THREE.Mesh(sph(0.012, 8, 6), conchaMat), 0.142, 1.660, 0.005, false);
  earConchaR.scale.set(0.6, 1.0, 0.8);
  // Tragus — small skin-colored bump in front of the ear canal (slightly
  // forward + below the concha, on the cheek side of the ear).
  const tragusL = add("earTragusL", new THREE.Mesh(sph(0.008, 8, 6), skinMatV), -0.135, 1.658, 0.020, false);
  tragusL.scale.set(0.7, 0.9, 0.8);
  const tragusR = add("earTragusR", new THREE.Mesh(sph(0.008, 8, 6), skinMatV), 0.135, 1.658, 0.020, false);
  tragusR.scale.set(0.7, 0.9, 0.8);

  // ─── Cheekbone highlights (LOD1) — subtle raised areas on the cheeks ────
  const cheekL = add("cheekL", new THREE.Mesh(sph(0.018, 8, 6), skinMatV), -0.060, 1.640, eyeZ - 0.005);
  cheekL.scale.set(0.8, 0.8, 0.4);
  const cheekR = add("cheekR", new THREE.Mesh(sph(0.018, 8, 6), skinMatV), 0.060, 1.640, eyeZ - 0.005);
  cheekR.scale.set(0.8, 0.8, 0.4);

  // ─── Stubble (LOD1) — subtle darker tint on the jaw/chin area ───────────
  // A thin partial-sphere shell slightly darker than the skin, low opacity,
  // covering the lower face (jaw/chin). Reads as a 5-o'clock shadow.
  const stubbleMat = fixedMat("stubble_v1", () => new THREE.MeshStandardMaterial({
    color: 0x4a3a2a, roughness: 0.9, metalness: 0.0,
    transparent: true, opacity: 0.3,
  }));
  const stubble = add("stubble", new THREE.Mesh(
    sphPartial(0.135, 12, 8, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.35),
    stubbleMat,
  ), 0, 1.620, 0.005);
  stubble.scale.set(0.95, 1.05, 1.0);

  // ─── Head hair (cap helmet only — LOD2) — short military buzz-cut ───────
  // Visible under the patrol cap (the cap covers the crown, the hair shows at
  // the sides/back below the cap edge). Random hair color per humanoid.
  if (helmetStyle === "cap") {
    const hairColors = [0x2a1a0a, 0x4a3a2a, 0x6a5a3a]; // black, brown, dirty blonde
    const hairColor = hairColors[Math.floor(Math.random() * hairColors.length)];
    const hairMat = makeHairMat(hairColor);
    const hair = add("hair", new THREE.Mesh(
      sphPartial(0.138, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
      hairMat,
    ), 0, 1.65, 0);
    hair.scale.set(0.95, 1.05, 1.0);
  }

  // ═══ Helmet (style varies per operator) ═══════════════════════════════════
  // All helmets get: NVG mount, side rails (except cap), velcro patch panel.

  if (helmetStyle === "cap") {
    // Soft patrol cap — face fully visible. Desert/woods operator look.
    const helmetShell = add("helmet", new THREE.Mesh(
      sphPartial(0.16, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.2),
      helmetMatV,
    ), 0, 1.74, 0);
    helmetShell.scale.set(1.05, 0.85, 1.15);
    add("capBrim", new THREE.Mesh(box(0.30, 0.025, 0.10), helmetMatV), 0, 1.69, 0.14);
    // Accent headband (operator color) — the cap's "visor".
    const visor = add("visor", new THREE.Mesh(torGeo(0.155, 0.015, 6, 18), accentMatV), 0, 1.68, 0);
    visor.rotation.x = Math.PI / 2;
    visor.scale.set(1, 1, 0.65);
    // NVG mount on cap (small box on front). Task 28 — hasNVG toggle.
    if (hasNVG) add("nvg", new THREE.Mesh(box(0.05, 0.04, 0.04), weaponMatV), 0, 1.78, 0.13, false);
  } else if (helmetStyle === "full") {
    // Full enclosed helmet — covers entire face, narrow glowing visor slit.
    const helmetShell = add("helmet", new THREE.Mesh(
      sphPartial(0.17, 18, 14, 0, Math.PI * 2, 0, Math.PI / 1.35),
      helmetMatV,
    ), 0, 1.70, 0);
    helmetShell.scale.set(1.02, 1.10, 1.18);
    // Jaw/chin guard (lower hemisphere).
    const jaw = add("jaw", new THREE.Mesh(
      sphPartial(0.15, 12, 8, 0, Math.PI * 2, Math.PI / 2.0, Math.PI / 2.5),
      helmetMatV,
    ), 0, 1.60, 0.02);
    jaw.scale.set(1.0, 0.75, 1.05);
    // Narrow visor slit — glowing accent.
    add("visor", new THREE.Mesh(box(0.26, 0.035, 0.04), visorMatV), 0, 1.68, 0.14);
    // Front brim.
    add("fullBrim", new THREE.Mesh(box(0.30, 0.025, 0.06), helmetMatV), 0, 1.76, 0.14);
    // NVG mount on front. Task 28 — hasNVG toggle.
    if (hasNVG) add("nvg", new THREE.Mesh(box(0.06, 0.05, 0.05), weaponMatV), 0, 1.78, 0.14, false);
    // Side rails (left/right).
    add("railL", new THREE.Mesh(box(0.04, 0.08, 0.10), weaponMatV), -0.17, 1.70, 0.05, false);
    add("railR", new THREE.Mesh(box(0.04, 0.08, 0.10), weaponMatV), 0.17, 1.70, 0.05, false);
  } else if (helmetStyle === "visor") {
    // Full-face tactical visor helmet — mirrored glass covers the whole face.
    const helmetShell = add("helmet", new THREE.Mesh(
      sphPartial(0.17, 18, 14, 0, Math.PI * 2, 0, Math.PI / 1.5),
      helmetMatV,
    ), 0, 1.70, 0);
    helmetShell.scale.set(1.06, 1.10, 1.20);
    // Full-face visor (curved cylinder section, mirrored glass).
    const visor = add("visor", new THREE.Mesh(
      cylArc(0.14, 0.14, 16, -Math.PI / 2.2, Math.PI / 1.1),
      visorMatV,
    ), 0, 1.68, 0.05);
    visor.rotation.z = Math.PI / 2;
    visor.scale.set(1, 1, 0.75);
    // NVG mount flipped up on top. Task 28 — hasNVG toggle.
    if (hasNVG) {
      const nvg = add("nvg", new THREE.Mesh(box(0.07, 0.05, 0.06), weaponMatV), 0, 1.80, 0.08, false);
      nvg.rotation.x = -0.5;
    }
    // Side rails.
    add("railL", new THREE.Mesh(box(0.04, 0.08, 0.10), weaponMatV), -0.18, 1.70, 0.05, false);
    add("railR", new THREE.Mesh(box(0.04, 0.08, 0.10), weaponMatV), 0.18, 1.70, 0.05, false);
  } else {
    // standard — full-face helmet + curved visor (Warden).
    const helmetShell = add("helmet", new THREE.Mesh(
      sphPartial(0.17, 18, 14, 0, Math.PI * 2, 0, Math.PI / 1.5),
      helmetMatV,
    ), 0, 1.70, 0);
    helmetShell.scale.set(1.02, 1.08, 1.15);
    // Visor — curved cylinder section.
    const visor = add("visor", new THREE.Mesh(
      cylArc(0.13, 0.09, 14, -Math.PI / 3, Math.PI * 2 / 3),
      visorMatV,
    ), 0, 1.68, 0.04);
    visor.rotation.z = Math.PI / 2;
    visor.scale.set(1, 1, 0.65);
    // Front brim.
    add("stdBrim", new THREE.Mesh(box(0.30, 0.025, 0.06), helmetMatV), 0, 1.68, 0.16);
    // NVG mount on front. Task 28 — hasNVG toggle.
    if (hasNVG) add("nvg", new THREE.Mesh(box(0.06, 0.05, 0.05), weaponMatV), 0, 1.78, 0.13, false);
    // Side rails.
    add("railL", new THREE.Mesh(box(0.04, 0.08, 0.10), weaponMatV), -0.17, 1.70, 0.05, false);
    add("railR", new THREE.Mesh(box(0.04, 0.08, 0.10), weaponMatV), 0.17, 1.70, 0.05, false);
  }

  // Velcro patch panel on helmet top (small flat box). Task 28 — adds a flag
  // patch (small colored rectangle) on top of the existing patch panel.
  add("patchPanel", new THREE.Mesh(box(0.06, 0.02, 0.06), pouchMatV), 0, 1.81, 0, false);
  // Flag patch — small accent-colored rectangle on the patch panel (moral
  // patch / blood type patch / flag). LOD1 detail.
  add("helmetFlagPatch", new THREE.Mesh(box(0.04, 0.005, 0.025), accentMatV), 0, 1.822, 0.005, false);

  // ═══ Task 33: Helmet rail detail slots — LOD1 ══════════════════════════════
  // 4 small rectangular cutouts along each helmet side rail (for mounting
  // lights/lasers — the signature Picatinny-slot look). Built as 4 small thin
  // dark boxes per rail (only for helmet styles that have rails — full/visor/
  // standard; not cap which has no rails).
  if (helmetStyle === "full" || helmetStyle === "visor" || helmetStyle === "standard") {
    const railSlotMat = fixedMat("railSlot_v1", () => new THREE.MeshStandardMaterial({
      color: 0x050505, roughness: 0.9, metalness: 0.1,
    }));
    const railSlotGeo = box(0.005, 0.008, 0.018);
    // Rail X offset (matches the existing side-rail positions per style).
    const railX = helmetStyle === "visor" ? 0.18 : 0.17;
    // 4 slots along the Z axis of each rail (cut into the rail surface).
    for (let i = 0; i < 4; i++) {
      const sz = 0.075 - i * 0.022;
      add(`railSlotL_${i}`, new THREE.Mesh(railSlotGeo, railSlotMat), -railX - 0.022, 1.70, sz, false);
      add(`railSlotR_${i}`, new THREE.Mesh(railSlotGeo, railSlotMat), railX + 0.022, 1.70, sz, false);
    }
  }

  // ═══ Task 28: Tactical glasses (under helmet, optional) ═══════════════════
  // Thin curved lenses over the eyes — only shown when hasGlasses is true.
  // Reads as protective eyewear ( Revision Sawfly / ESS ICE profile).
  if (hasGlasses) {
    const lensMat = coloredMat("tacGlasses_v1", () => new THREE.MeshStandardMaterial({
      color: 0x101820, roughness: 0.15, metalness: 0.4,
      transparent: true, opacity: 0.7,
      emissive: 0x0a1018, emissiveIntensity: 0.1,
    }));
    // Left lens — flattened sphere over the left eye.
    const lensL = add("tacLensL", new THREE.Mesh(sph(0.026, 10, 8), lensMat), -eyeDX, eyeY - 0.003, eyeZ + 0.014);
    lensL.scale.set(1.1, 0.8, 0.5);
    // Right lens — flattened sphere over the right eye.
    const lensR = add("tacLensR", new THREE.Mesh(sph(0.026, 10, 8), lensMat), eyeDX, eyeY - 0.003, eyeZ + 0.014);
    lensR.scale.set(1.1, 0.8, 0.5);
    // Bridge — thin connector across the nose.
    add("tacLensBridge", new THREE.Mesh(box(0.018, 0.005, 0.008), lensMat), 0, eyeY - 0.003, eyeZ + 0.014, false);
    // Temple arms — thin boxes extending back along the head sides.
    add("tacLensArmL", new THREE.Mesh(box(0.005, 0.008, 0.07), lensMat), -0.115, eyeY, eyeZ - 0.01, false);
    add("tacLensArmR", new THREE.Mesh(box(0.005, 0.008, 0.07), lensMat), 0.115, eyeY, eyeZ - 0.01, false);
  }

  // ═══ Headset ═════════════════════════════════════════════════════════════
  // Task 28 — hasHeadset toggle (default true). Ear cups + boom mic + antenna
  // are skipped entirely when the player opts out.
  if (hasHeadset) {
    // Ear cups (left + right) — flattened spheres over the ears.
    const earCupL = add("earCupL", new THREE.Mesh(sph(0.045, 10, 8), pouchMatV), -0.175, 1.68, 0.02, false);
    earCupL.scale.set(0.6, 1, 1);
    const earCupR = add("earCupR", new THREE.Mesh(sph(0.045, 10, 8), pouchMatV), 0.175, 1.68, 0.02, false);
    earCupR.scale.set(0.6, 1, 1);
    // Boom mic (left side, arm extending forward).
    const boomMicArm = add("boomMicArm", new THREE.Mesh(cyl(0.008, 0.008, 0.12, 4), weaponMatV), -0.17, 1.68, 0.10, false);
    boomMicArm.rotation.z = Math.PI / 2.5;
    add("boomMicHead", new THREE.Mesh(sph(0.018, 8, 6), pouchMatV), -0.12, 1.70, 0.14, false);
    // Headset antenna (small wire from left ear cup).
    const antenna = add("antenna", new THREE.Mesh(cyl(0.006, 0.003, 0.10, 4), weaponMatV), -0.19, 1.76, -0.05, false);
    antenna.rotation.z = 0.3;
  }

  // ═══ Arms (anatomical tapered cylinders) ═══════════════════════════════════
  // Shoulder joints (spheres at shoulder — fill the gap between torso and arm).
  // Task 28 — arms use shirtMatV (sleeves are part of the shirt).
  add("lShoulderJoint", new THREE.Mesh(sph(0.075, 10, 8), shirtMatV), -0.27, 1.40, 0);
  add("rShoulderJoint", new THREE.Mesh(sph(0.075, 10, 8), shirtMatV), 0.27, 1.40, 0);
  // Upper arms (jumpsuit sleeve) — tapered cylinder, shoulder→elbow.
  // Top radius 0.068 (shoulder), bottom 0.055 (elbow), height 0.26.
  const upperArmG = cyl(0.068, 0.055, 0.26, 10);
  add("larm", new THREE.Mesh(upperArmG, shirtMatV), -0.27, 1.27, 0);
  add("rarm", new THREE.Mesh(upperArmG, shirtMatV), 0.27, 1.27, 0);
  // Elbow pads (dark rounded shell over the elbow joint).
  // Task 28 — hasElbowPads toggle + elbowPadColor override.
  if (hasElbowPads) {
    const lElbowPad = add("lElbowPad", new THREE.Mesh(sph(0.062, 10, 8), elbowPadMatV), -0.27, 1.13, 0.02);
    lElbowPad.scale.set(1, 0.7, 1.1);
    const rElbowPad = add("rElbowPad", new THREE.Mesh(sph(0.062, 10, 8), elbowPadMatV), 0.27, 1.13, 0.02);
    rElbowPad.scale.set(1, 0.7, 1.1);
  }
  // Forearms (sleeve over forearm) — tapered cylinder, elbow→wrist.
  // Top radius 0.055 (elbow), bottom 0.042 (wrist), height 0.24.
  const forearmG = cyl(0.055, 0.042, 0.24, 10);
  // Task 33 — anatomical forearm muscle bulge: scale the forearm slightly
  // wider in the middle (the brachioradialis + flexor mass bulges between
  // elbow and wrist). scale.x = 1.08 at the midpoint tapering to 1.0 at both
  // ends. Applied via individual mesh scale so the shared geometry cache stays
  // intact (the scale is per-mesh, not per-geometry).
  const larmLower = add("larmLower", new THREE.Mesh(forearmG, shirtMatV), -0.27, 1.00, 0);
  larmLower.scale.set(1.08, 1.0, 1.08); // muscle bulge
  const rarmLower = add("rarmLower", new THREE.Mesh(forearmG, shirtMatV), 0.27, 1.00, 0);
  rarmLower.scale.set(1.08, 1.0, 1.08);

  // ═══ Task 33: Forearm veins + crease lines — LOD1 ═══════════════════════════
  // The forearm already has the muscle bulge (above). Add 2 more raised vein
  // branches per forearm (thin skin-tone-tinted cylinders running along the
  // forearm) + a thin wrist crease line. Veins are subtle — slightly darker
  // than the skin so they read as raised vessels under the sleeve.
  const veinMat = fixedMat("forearmVein_v1", () => new THREE.MeshStandardMaterial({
    color: 0x4a2a1a, roughness: 0.8, metalness: 0.0,
  }));
  const veinGeo = cyl(0.0025, 0.0025, 0.18, 4);
  // Left forearm — 2 vein branches running diagonally down the forearm.
  const veinL1 = add("forearmVeinL1", new THREE.Mesh(veinGeo, veinMat), -0.262, 1.00, 0.045, false);
  veinL1.rotation.z = 0.15;
  const veinL2 = add("forearmVeinL2", new THREE.Mesh(veinGeo, veinMat), -0.278, 1.00, 0.040, false);
  veinL2.rotation.z = -0.10;
  // Right forearm — 2 vein branches (mirror image).
  const veinR1 = add("forearmVeinR1", new THREE.Mesh(veinGeo, veinMat), 0.262, 1.00, 0.045, false);
  veinR1.rotation.z = -0.15;
  const veinR2 = add("forearmVeinR2", new THREE.Mesh(veinGeo, veinMat), 0.278, 1.00, 0.040, false);
  veinR2.rotation.z = 0.10;

  // Gloves (distinct material) — short cylinder at the wrist.
  const gloveG = cyl(0.045, 0.040, 0.08, 8);
  add("lglove", new THREE.Mesh(gloveG, gloveMatV), -0.27, 0.86, 0);
  add("rglove", new THREE.Mesh(gloveG, gloveMatV), 0.27, 0.86, 0);

  // ═══ Legs (anatomical tapered cylinders) ═══════════════════════════════════
  // Hip joints (spheres at hip — fill the gap between pelvis and thigh).
  // Task 28 — legs use pantsMatV (pants cover the hips + legs).
  add("lHipJoint", new THREE.Mesh(sph(0.085, 10, 8), pantsMatV), -0.13, 0.72, 0);
  add("rHipJoint", new THREE.Mesh(sph(0.085, 10, 8), pantsMatV), 0.13, 0.72, 0);
  // Thighs (jumpsuit) — tapered cylinder, hip→knee.
  // Top radius 0.098 (hip), bottom 0.072 (knee), height 0.42.
  const thighG = cyl(0.098, 0.072, 0.42, 12);
  add("lleg", new THREE.Mesh(thighG, pantsMatV), -0.13, 0.55, 0);
  add("rleg", new THREE.Mesh(thighG, pantsMatV), 0.13, 0.55, 0);
  // Knee pads (dark rounded shell over the knee).
  // Task 28 — hasKneePads toggle + kneePadColor override.
  if (hasKneePads) {
    const lKneePad = add("lKneePad", new THREE.Mesh(sph(0.085, 10, 8), kneePadMatV), -0.13, 0.34, 0.04);
    lKneePad.scale.set(1.1, 0.7, 1.2);
    const rKneePad = add("rKneePad", new THREE.Mesh(sph(0.085, 10, 8), kneePadMatV), 0.13, 0.34, 0.04);
    rKneePad.scale.set(1.1, 0.7, 1.2);
  }
  // Shins (jumpsuit pants) — tapered cylinder, knee→ankle.
  // Top radius 0.072 (knee), bottom 0.052 (ankle), height 0.30.
  const shinG = cyl(0.072, 0.052, 0.30, 12);
  // Task 33 — anatomical calf muscle bulge: scale the upper third of the shin
  // slightly wider (the gastrocnemius + soleus muscle mass bulges at the top
  // of the calf). Per-mesh scale keeps the shared geometry cache intact.
  const lshin = add("lshin", new THREE.Mesh(shinG, pantsMatV), -0.13, 0.19, 0);
  lshin.scale.set(1.10, 1.0, 1.06); // calf bulge (wider in X, slightly in Z)
  const rshin = add("rshin", new THREE.Mesh(shinG, pantsMatV), 0.13, 0.19, 0);
  rshin.scale.set(1.10, 1.0, 1.06);
  // Boot uppers (leather) — tapered cylinder covering ankle.
  const bootUpperG = cyl(0.060, 0.055, 0.08, 10);
  add("lBootUpper", new THREE.Mesh(bootUpperG, bootMatV), -0.13, 0.02, 0.02);
  add("rBootUpper", new THREE.Mesh(bootUpperG, bootMatV), 0.13, 0.02, 0.02);
  // Boot soles (rubber, wider than shin) — animated by animateGait (llegBoot/rlegBoot).
  const soleG = box(0.18, 0.05, 0.28);
  add("llegBoot", new THREE.Mesh(soleG, bootMatV), -0.13, -0.02, 0.03);
  add("rlegBoot", new THREE.Mesh(soleG, bootMatV), 0.13, -0.02, 0.03);

  // ═══ Task 33: Boot sole tread — LOD1 ════════════════════════════════════════
  // 5 thin horizontal tread bars across the bottom of each boot sole (grip
  // pattern). Built as thin dark boxes pressed into the bottom of the sole,
  // suggesting the rubber tread blocks of a combat boot.
  const treadMat = fixedMat("bootTread_v1", () => new THREE.MeshStandardMaterial({
    color: 0x050505, roughness: 0.95, metalness: 0.0,
  }));
  const treadGeo = box(0.16, 0.012, 0.018);
  for (let i = 0; i < 5; i++) {
    // Spread across the sole length (Z axis): from heel (-0.10) to toe (+0.14).
    const tz = -0.09 + i * 0.052;
    add(`lBootTread_${i}`, new THREE.Mesh(treadGeo, treadMat), -0.13, -0.042, tz, false);
    add(`rBootTread_${i}`, new THREE.Mesh(treadGeo, treadMat), 0.13, -0.042, tz, false);
  }

  // ═══ Task 28: Boot detail (toe caps + laces) — LOD1 ═══════════════════════
  // Toe caps — reinforced front boxes on each boot sole (steel-toe profile).
  add("lBootToeCap", new THREE.Mesh(box(0.16, 0.025, 0.05), bootMatV), -0.13, -0.005, 0.16, false);
  add("rBootToeCap", new THREE.Mesh(box(0.16, 0.025, 0.05), bootMatV), 0.13, -0.005, 0.16, false);
  // Boot laces — 3 thin crisscrossing cylinders per boot across the upper.
  const laceMat = coloredMat("lace_v1", () => new THREE.MeshStandardMaterial({
    color: 0x1a1a1a, roughness: 0.85, metalness: 0.0,
  }));
  const laceGeo = cyl(0.0025, 0.0025, 0.08, 4);
  for (let i = 0; i < 3; i++) {
    const ly = 0.045 - i * 0.012;
    // Left boot — diagonal lace segments.
    const laceL1 = add(`lBootLace_${i}a`, new THREE.Mesh(laceGeo, laceMat), -0.135, ly, 0.04, false);
    laceL1.rotation.z = 0.7;
    const laceL2 = add(`lBootLace_${i}b`, new THREE.Mesh(laceGeo, laceMat), -0.125, ly, 0.04, false);
    laceL2.rotation.z = -0.7;
    // Right boot — diagonal lace segments.
    const laceR1 = add(`rBootLace_${i}a`, new THREE.Mesh(laceGeo, laceMat), 0.135, ly, 0.04, false);
    laceR1.rotation.z = -0.7;
    const laceR2 = add(`rBootLace_${i}b`, new THREE.Mesh(laceGeo, laceMat), 0.125, ly, 0.04, false);
    laceR2.rotation.z = 0.7;
  }

  // ═══ Task 28: Glove fingernails (LOD1) ════════════════════════════════════
  // The third-person hands are simple glove cylinders (no finger mesh). Add 4
  // small nail-shaped flattened spheres on the bottom of each glove (where the
  // fingertips would be) — gives the hands a defined "finger" silhouette. The
  // FP arms already have detailed nails (Task 20); this brings the third-person
  // hands up to the same level of detail.
  // Task 33 — nails are now repositioned to the tip of the new 3-segment
  // fingers (built below), so they sit at the actual fingertip (y≈0.765)
  // instead of the bottom of the glove cylinder (y=0.825). Part names
  // preserved (lgloveNail_0..3, rgloveNail_0..3) — just repositioned.
  const nailMat = coloredMat("gloveNail_v1", () => new THREE.MeshStandardMaterial({
    color: 0xe8d8c8, roughness: 0.3, metalness: 0.0,
    emissive: 0xe8d8c8, emissiveIntensity: 0.05,
  }));
  const nailGeo = sph(0.006, 6, 5);

  // ═══ Task 33: 3-segment finger joints (LOD1) ════════════════════════════════
  // Each humanoid hand gets 4 fingers × 3 segments (proximal/middle/distal) +
  // 1 thumb × 2 segments + 4 knuckle bumps + 2 crease lines per finger. Curl
  // is approximated by tilting each segment forward (rotation.x) + offsetting
  // forward in Z — reads as a relaxed half-curl grip pose (not flat hands).
  // Total: 24 finger segments + 4 thumb segments + 8 knuckle bumps + 16 crease
  // lines = 52 new meshes per humanoid (LOD1-gated so they cull at 15m+).
  const knuckleMat = fixedMat("hpKnuckle_v1", () => new THREE.MeshStandardMaterial({
    color: 0x1a1a1a, roughness: 0.75, metalness: 0.05,
  }));
  const creaseMat = fixedMat("hpFingerCrease_v1", () => new THREE.MeshStandardMaterial({
    color: 0x080808, roughness: 0.9, metalness: 0.0,
  }));
  const fingerCreaseGeo = box(0.008, 0.0015, 0.004);

  // 4 fingers per hand, fanned across the front of the glove. Each finger is
  // a chain of 3 segments + 2 crease lines + 1 knuckle bump.
  const fingerXs = [-0.018, -0.006, 0.006, 0.018]; // matches existing nail X positions
  for (let i = 0; i < 4; i++) {
    const fx = fingerXs[i];
    // Proximal segment — gloved tapered cylinder just below the glove edge.
    // y=0.815 (top at 0.8275 = glove bottom + 0.0075 overlap), length 0.025.
    const proxL = add(`lFinger_${i}_prox`, new THREE.Mesh(
      cyl(0.0058, 0.0050, 0.025, 6), gloveMatV,
    ), -0.27 + fx, 0.815, 0.024, false);
    proxL.rotation.x = 0.10; // slight forward tilt
    const proxR = add(`rFinger_${i}_prox`, new THREE.Mesh(
      cyl(0.0058, 0.0050, 0.025, 6), gloveMatV,
    ), 0.27 + fx, 0.815, 0.024, false);
    proxR.rotation.x = 0.10;
    // Middle segment — slightly smaller, tilted more forward.
    const midL = add(`lFinger_${i}_mid`, new THREE.Mesh(
      cyl(0.0050, 0.0040, 0.022, 6), gloveMatV,
    ), -0.27 + fx, 0.792, 0.030, false);
    midL.rotation.x = 0.22;
    const midR = add(`rFinger_${i}_mid`, new THREE.Mesh(
      cyl(0.0050, 0.0040, 0.022, 6), gloveMatV,
    ), 0.27 + fx, 0.792, 0.030, false);
    midR.rotation.x = 0.22;
    // Distal segment — fingertip (skin-tone for fingerless glove), most curled.
    const distL = add(`lFinger_${i}_dist`, new THREE.Mesh(
      cyl(0.0040, 0.0030, 0.020, 6), skinMatV,
    ), -0.27 + fx, 0.770, 0.038, false);
    distL.rotation.x = 0.38;
    const distR = add(`rFinger_${i}_dist`, new THREE.Mesh(
      cyl(0.0040, 0.0030, 0.020, 6), skinMatV,
    ), 0.27 + fx, 0.770, 0.038, false);
    distR.rotation.x = 0.38;
    // Knuckle bump — small darker sphere at the top of the proximal segment
    // (just below the glove edge). Reads as the MCP joint bulge.
    const knuckL = add(`lFingerKnuckle_${i}`, new THREE.Mesh(sph(0.006, 6, 5), knuckleMat), -0.27 + fx, 0.825, 0.026, false);
    knuckL.scale.set(1, 0.7, 1.0);
    const knuckR = add(`rFingerKnuckle_${i}`, new THREE.Mesh(sph(0.006, 6, 5), knuckleMat), 0.27 + fx, 0.825, 0.026, false);
    knuckR.scale.set(1, 0.7, 1.0);
    // Crease line 1 — between proximal and middle.
    add(`lFingerCrease_${i}_1`, new THREE.Mesh(fingerCreaseGeo, creaseMat), -0.27 + fx, 0.803, 0.027, false);
    add(`rFingerCrease_${i}_1`, new THREE.Mesh(fingerCreaseGeo, creaseMat), 0.27 + fx, 0.803, 0.027, false);
    // Crease line 2 — between middle and distal.
    add(`lFingerCrease_${i}_2`, new THREE.Mesh(fingerCreaseGeo, creaseMat), -0.27 + fx, 0.781, 0.034, false);
    add(`rFingerCrease_${i}_2`, new THREE.Mesh(fingerCreaseGeo, creaseMat), 0.27 + fx, 0.781, 0.034, false);
    // Fingernail — repositioned to the tip of the distal segment (y≈0.762).
    const nailL = add(`lgloveNail_${i}`, new THREE.Mesh(nailGeo, nailMat), -0.27 + fx, 0.762, 0.044, false);
    nailL.scale.set(1, 0.4, 1.3);
    const nailR = add(`rgloveNail_${i}`, new THREE.Mesh(nailGeo, nailMat), 0.27 + fx, 0.762, 0.044, false);
    nailR.scale.set(1, 0.4, 1.3);
  }

  // ═══ Task 33: Thumb (2-segment, angled outward) — LOD1 ══════════════════════
  // Each thumb is 2 segments (proximal + distal) angled outward from the side
  // of the glove (left thumb to -X, right thumb to +X). Reads as a relaxed
  // thumb resting against the side of the leg.
  // Left thumb — angled to -X.
  const thumbProxL = add("lThumb_prox", new THREE.Mesh(
    cyl(0.0070, 0.0055, 0.024, 6), gloveMatV,
  ), -0.295, 0.825, 0.018, false);
  thumbProxL.rotation.z = -0.45;  // angle outward to -X
  thumbProxL.rotation.x = 0.15;
  const thumbDistL = add("lThumb_dist", new THREE.Mesh(
    cyl(0.0050, 0.0040, 0.018, 6), skinMatV,
  ), -0.310, 0.805, 0.022, false);
  thumbDistL.rotation.z = -0.45;
  thumbDistL.rotation.x = 0.30;
  // Right thumb — angled to +X (mirror).
  const thumbProxR = add("rThumb_prox", new THREE.Mesh(
    cyl(0.0070, 0.0055, 0.024, 6), gloveMatV,
  ), 0.295, 0.825, 0.018, false);
  thumbProxR.rotation.z = 0.45;
  thumbProxR.rotation.x = 0.15;
  const thumbDistR = add("rThumb_dist", new THREE.Mesh(
    cyl(0.0050, 0.0040, 0.018, 6), skinMatV,
  ), 0.310, 0.805, 0.022, false);
  thumbDistR.rotation.z = 0.45;
  thumbDistR.rotation.x = 0.30;

  // ═══ Task 28: Wrist watch on left wrist (LOD1) ═════════════════════════════
  // Small dark band (torus around the wrist) + metallic face (small box on the
  // front of the wrist). Reads as a tactical watch (G-Shock profile).
  const watchBandMat = coloredMat("watchBand_v1", () => new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, roughness: 0.7, metalness: 0.2,
  }));
  const watchFaceMat = coloredMat("watchFace_v1", () => new THREE.MeshStandardMaterial({
    color: 0x1a2a1a, roughness: 0.2, metalness: 0.6,
    emissive: 0x0a1a0a, emissiveIntensity: 0.3,
  }));
  const watchBand = add("watchBand", new THREE.Mesh(torGeo(0.046, 0.008, 6, 12), watchBandMat), -0.27, 0.88, 0, false);
  watchBand.rotation.x = Math.PI / 2;
  watchBand.scale.set(1, 1, 0.6);
  add("watchFace", new THREE.Mesh(box(0.025, 0.025, 0.008), watchFaceMat), -0.27, 0.88, 0.05, false);

  // ═══ Task 28: Vest detail (MOLLE webbing + mag flaps + ID badge + rank) ═══
  // MOLLE webbing — 4 thin horizontal strips across the vest front (the
  // signature modular attachment grid pattern).
  const molleMat = coloredMat("molle_v1", () => new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, roughness: 0.8, metalness: 0.05,
  }));
  for (let i = 0; i < 4; i++) {
    const my = 1.30 - i * 0.10;
    add(`molleStrip_${i}`, new THREE.Mesh(box(0.36, 0.006, 0.018), molleMat), 0, my, 0.225, false);
  }
  // Magazine pouch flaps — small hinged lids on top of each mag pouch.
  for (let i = 0; i < 4; i++) {
    const flap = add(`magPouchFlap_${i}`, new THREE.Mesh(box(0.075, 0.018, 0.012), pouchMatV), -0.105 + i * 0.07, 1.08, 0.255, false);
    flap.rotation.x = -0.15;
  }
  // ID badge — small card on the upper-right chest (admin pouch area).
  const badgeMat = coloredMat("idBadge_v1", () => new THREE.MeshStandardMaterial({
    color: 0xe0e0d0, roughness: 0.4, metalness: 0.1,
  }));
  add("idBadge", new THREE.Mesh(box(0.05, 0.035, 0.005), badgeMat), 0.10, 1.32, 0.227, false);
  // Shoulder rank insignia — small accent-colored bars on each shoulder strap.
  for (let i = 0; i < 2; i++) {
    add(`rankL_${i}`, new THREE.Mesh(box(0.03, 0.005, 0.018), accentMatV), -0.22, 1.45 + i * 0.008, 0.06, false);
    add(`rankR_${i}`, new THREE.Mesh(box(0.03, 0.005, 0.018), accentMatV), 0.22, 1.45 + i * 0.008, 0.06, false);
  }

  // ═══ Task 28: Belt buckle emblem (star/eagle) ═════════════════════════════
  // Small metallic star-like shape on top of the existing buckle — a 5-point
  // star approximated by a thin flattened octahedron (rotated 45°).
  const emblemMat = coloredMat("buckleEmblem_v1", () => new THREE.MeshStandardMaterial({
    color: 0xc8a848, roughness: 0.3, metalness: 0.85,
    emissive: 0xc8a848, emissiveIntensity: 0.1,
  }));
  const emblem = add("buckleEmblem", new THREE.Mesh(sph(0.014, 6, 5), emblemMat), 0, 0.84, 0.175, false);
  emblem.scale.set(1, 1, 0.3); // flat against the buckle face

  // ═══ Thigh pouches (left + right) ═════════════════════════════════════════
  add("lThighPouch", new THREE.Mesh(box(0.07, 0.20, 0.13), pouchMatV), -0.21, 0.52, 0.02);
  add("rThighPouch", new THREE.Mesh(box(0.07, 0.20, 0.13), pouchMatV), 0.21, 0.52, 0.02);

  // ═══ Sidearm holster on right thigh ═══════════════════════════════════════
  // Task 28 — hasSidearm toggle (default true). Holster + sidearm skipped when
  // the player opts out.
  if (hasSidearm) {
    add("holster", new THREE.Mesh(box(0.06, 0.16, 0.13), pouchMatV), 0.24, 0.46, -0.08);
    // Sidearm (frame + grip) — 'egun' points to the frame (existing semantic).
    add("egun", new THREE.Mesh(box(0.035, 0.04, 0.10), weaponMatV), 0.24, 0.55, -0.10, false);
    add("sidearmGrip", new THREE.Mesh(box(0.035, 0.10, 0.04), weaponMatV), 0.24, 0.50, -0.13, false);
  }

  // ═══ Backpack (small assault pack on back) ════════════════════════════════
  // Task 28 — hasBackpack toggle (default true). Backpack + flap + straps +
  // hydration tube skipped when the player opts out.
  if (hasBackpack) {
    add("backpack", new THREE.Mesh(box(0.32, 0.40, 0.18), bagMatV), 0, 1.20, -0.22);
    add("backpackFlap", new THREE.Mesh(box(0.30, 0.10, 0.04), bagMatV), 0, 1.36, -0.30);
    // Backpack straps (over the shoulders, on top of vest straps).
    add("lBackpackStrap", new THREE.Mesh(box(0.04, 0.40, 0.03), bagMatV), -0.14, 1.20, -0.18, false);
    add("rBackpackStrap", new THREE.Mesh(box(0.04, 0.40, 0.03), bagMatV), 0.14, 1.20, -0.18, false);

    // ─── Task 28: Hydration tube (LOD2) ────────────────────────────────────
    // Thin curved tube from the top of the backpack (water bladder) over the
    // left shoulder strap to the chest. Two angled thin cylinders approximate
    // the curve. LOD2 detail.
    const tubeMat = coloredMat("hydroTube_v1", () => new THREE.MeshStandardMaterial({
      color: 0x2a3a2a, roughness: 0.6, metalness: 0.1,
    }));
    // Segment 1 — from backpack top up + over the shoulder.
    const tubeSeg1 = add("hydroTubeSeg1", new THREE.Mesh(cyl(0.005, 0.005, 0.18, 6), tubeMat), -0.08, 1.36, -0.20, false);
    tubeSeg1.rotation.x = -0.6;
    tubeSeg1.rotation.z = 0.4;
    // Segment 2 — from the shoulder down to the chest (where the mouthpiece
    // would be clipped to the vest strap).
    const tubeSeg2 = add("hydroTubeSeg2", new THREE.Mesh(cyl(0.005, 0.005, 0.16, 6), tubeMat), -0.18, 1.28, 0.02, false);
    tubeSeg2.rotation.x = 0.5;
    tubeSeg2.rotation.z = 0.3;
    // Mouthpiece — small bulb at the end of the tube.
    add("hydroTubeMouthpiece", new THREE.Mesh(sph(0.009, 8, 6), tubeMat), -0.20, 1.22, 0.06, false);
  }

  // ═══ Task 33: Relaxed stance — hip shift + shoulder drop ═══════════════════
  // The model otherwise stands perfectly straight (rigid). Apply a subtle
  // relaxed stance by shifting the hips 0.02m right (weight on right leg) +
  // dropping the right shoulder 0.01m. This makes the pose look natural, not
  // rigid. Applied AFTER all parts are positioned so it's a body-relative
  // offset (not a per-part rebuild). Hips shift via the hips/abdomen/belt
  // positions; right shoulder drop via the rShoulderJoint/rShoulderStrap/
  // rShoulderPad positions.
  //
  // Note: animateGait overrides these positions every frame for moving gait +
  // resets them to neutral when stationary. So this relaxed stance only reads
  // when the humanoid is freshly built (before the first animateGait call) OR
  // when the breathing idle is active (which preserves body.position.x =
  // breatheSway, NOT the rigid 0). For a permanent relaxed stance, the
  // breathing idle would need updating too — but for the build-pose purpose
  // (3D menu preview, fresh enemy spawns), this is sufficient.
  if (parts.hips) parts.hips.position.x += 0.02;
  if (parts.abdomen) parts.abdomen.position.x += 0.02;
  if (parts.belt) parts.belt.position.x += 0.02;
  if (parts.buckle) parts.buckle.position.x += 0.02;
  if (parts.rShoulderJoint) parts.rShoulderJoint.position.y -= 0.01;
  if (parts.rShoulderStrap) parts.rShoulderStrap.position.y -= 0.01;
  if (parts.rShoulderPad) parts.rShoulderPad.position.y -= 0.01;
  if (parts.rShoulderStrap) parts.rShoulderStrap.position.x += 0.005; // slight inward shift
  if (parts.rShoulderPad) parts.rShoulderPad.position.x += 0.005;

  return { group, parts };
}

// ════════════════════════════════════════════════════════════════════════════
// Task 34 — Fluid gait + idle animation.
//
// Per-humanoid animation state (smoothed amplitude, accel tracking, idle
// micro-motion scheduling) is stored in a module-level WeakMap keyed by
// parts.body. This keeps the animateGait/animateIdle signatures unchanged
// (no breaking change to PhysicsSystem/EnemySystem callers) AND avoids any
// per-frame allocation — the state object is created once per humanoid on
// the first call and reused for the humanoid's lifetime. When the body
// mesh is GC'd (enemy removed from the scene), the state entry is GC'd too.
//
// Damping uses THREE.MathUtils.damp (exponential approach, frame-rate
// independent). For underdamped spring behaviour (overshoot + settle, used
// in ProceduralAnimSystem hit reactions + PhysicsSystem landing impact) we
// integrate a velocity + position pair directly with F = -k*x - c*v.
// ════════════════════════════════════════════════════════════════════════════

interface GaitState {
  /** Smoothed gait amplitude (damped toward target for fluid speed transitions). */
  sAmp: number;
  /** Previous frame's speed (for acceleration = Δv/Δt). */
  pSpeed: number;
  /** Smoothed acceleration (damped; drives forward/backward lean). */
  sAccel: number;
  /** Wall-clock time of the previous call (seconds; 0 = first call). */
  pT: number;
  // ── Idle-only state ──
  /** Weight-shift direction (-1 left foot loaded, +1 right foot loaded). */
  wShift: number;
  /** Weight-shift target direction (the side we're shifting toward). */
  wShiftTgt: number;
  /** Wall-clock time when the next weight shift should trigger. */
  wShiftNext: number;
  /** Micro-look yaw target (radians; small ±0.06 for "looking around"). */
  hYawT: number;
  /** Micro-look yaw (damped toward hYawT). */
  hYaw: number;
  /** Micro-look pitch target. */
  hPitchT: number;
  /** Micro-look pitch (damped). */
  hPitch: number;
  /** Wall-clock time when the next micro-look should trigger. */
  hNext: number;
  /** Arm micro-adjustment target (small ±0.04). */
  aAdjT: number;
  /** Arm micro-adjustment (damped). */
  aAdj: number;
  /** Wall-clock time when the next arm adjustment should trigger. */
  aNext: number;
}

const gaitStateMap = new WeakMap<THREE.Object3D, GaitState>();

function makeGaitState(): GaitState {
  return {
    sAmp: 0, pSpeed: 0, sAccel: 0, pT: 0,
    wShift: 0, wShiftTgt: 0, wShiftNext: 0,
    hYawT: 0, hYaw: 0, hPitchT: 0, hPitch: 0, hNext: 0,
    aAdjT: 0, aAdj: 0, aNext: 0,
  };
}

function getGaitState(parts: Record<string, THREE.Mesh>): GaitState {
  const key = parts.body ?? parts.head ?? parts.lleg;
  if (!key) return makeGaitState();
  let s = gaitStateMap.get(key);
  if (!s) {
    s = makeGaitState();
    gaitStateMap.set(key, s);
  }
  return s;
}

/**
 * Animate humanoid idle — breathing, weight shift, micro-movements.
 *
 * Called directly by ProceduralAnimSystem for stationary enemies, and
 * indirectly (via animateGait) when the player avatar's speed < 0.5.
 *
 * Uses wall-clock `time` (seconds) so the breathing cycle continues even
 * when animateGait's `phase` argument isn't advancing. The cycle is purely
 * cosmetic — the rate (0.3 Hz) is the human breathing cadence at rest.
 *
 * Layered motions:
 *   - Breathing (0.3 Hz): chest scale + body rise/fall + shoulder rise/fall.
 *   - Weight shift: every 4-6s, shift weight from one foot to the other
 *     (subtle hip tilt + hip lateral shift). Damped for a slow transition.
 *   - Micro-look: every 1.5-4s, pick a new random look direction (±3°).
 *     Damped so the head turns gradually.
 *   - Arm micro-adjustments: every 2-5s, subtle arm position shuffle.
 *   - Relaxed pose: shoulders drop, elbows slightly bent, knees soft.
 */
export function animateIdle(parts: Record<string, THREE.Mesh>, time: number) {
  const s = getGaitState(parts);
  // Compute dt from wall-clock (clamped — matches the engine's 0.05s cap).
  let dt = time - s.pT;
  if (s.pT === 0 || dt <= 0 || dt > 0.05) dt = 0.016;
  s.pT = time;

  // ─── Breathing (0.3 Hz ≈ 1.88 rad/s) ────────────────────────────────────
  const breatheRate = 1.88;
  const breathe = Math.sin(time * breatheRate);              // -1..1
  const breatheY = breathe * 0.008;                           // 8mm body bob
  const breatheRotX = breathe * 0.012;                        // subtle chest pitch
  const breatheSway = Math.sin(time * 0.6) * 0.003;          // slow lateral drift

  // ─── Weight shift (trigger every 4-6s) ──────────────────────────────────
  if (time >= s.wShiftNext) {
    // Alternate sides, or pick the opposite foot when starting from neutral.
    s.wShiftTgt = s.wShiftTgt === 0
      ? (Math.random() < 0.5 ? -1 : 1)
      : -s.wShiftTgt;
    s.wShiftNext = time + 4 + Math.random() * 2;
  }
  // Slow 3/s damping → ~0.33s transition (smooth weight transfer).
  s.wShift = THREE.MathUtils.damp(s.wShift, s.wShiftTgt, 3, dt);

  // ─── Micro-look (trigger every 1.5-4s) ──────────────────────────────────
  if (time >= s.hNext) {
    s.hYawT = (Math.random() - 0.5) * 0.12;                   // ±0.06 rad ≈ ±3.4°
    s.hPitchT = (Math.random() - 0.5) * 0.08;
    s.hNext = time + 1.5 + Math.random() * 2.5;
  }
  s.hYaw = THREE.MathUtils.damp(s.hYaw, s.hYawT, 4, dt);
  s.hPitch = THREE.MathUtils.damp(s.hPitch, s.hPitchT, 4, dt);

  // ─── Arm micro-adjustments (trigger every 2-5s) ─────────────────────────
  if (time >= s.aNext) {
    s.aAdjT = (Math.random() - 0.5) * 0.08;
    s.aNext = time + 2 + Math.random() * 3;
  }
  s.aAdj = THREE.MathUtils.damp(s.aAdj, s.aAdjT, 3, dt);

  // ─── Body — breathing bob + slow sway + relaxed lean ────────────────────
  parts.body.position.y = 1.15 + breatheY;
  parts.body.position.x = breatheSway;
  // Subtle forward pitch with each inhale (chest rises → torso tips forward).
  parts.body.rotation.x = THREE.MathUtils.damp(parts.body.rotation.x, breatheRotX * 0.5, 5, dt);
  // Torso follows the head's micro-look (slightly).
  parts.body.rotation.y = THREE.MathUtils.damp(parts.body.rotation.y, s.hYaw * 0.3, 4, dt);
  // Weight-shift tilt: one shoulder drops (loaded side).
  // Task 33 — add a small permanent right-shoulder-drop baseline (0.008 rad).
  // Positive rotation.z tilts the body so the right shoulder drops + left
  // rises (the body rotation pivots around the spine). This persists the
  // build-pose right-shoulder-drop into the idle animation.
  parts.body.rotation.z = THREE.MathUtils.damp(parts.body.rotation.z, s.wShift * 0.025 + 0.008, 4, dt);

  // ─── Hips — weight shift (pelvis tilts + shifts toward loaded foot) ─────
  // Task 33 — baseline +0.02m rightward offset biases the weight onto the
  // right leg (relaxed stance). The wShift oscillation still happens on top
  // of this baseline, so the operator occasionally shifts weight to the left
  // leg too. Without this baseline, the build-pose relaxed stance gets damped
  // back to 0 after a few seconds of idle (the damp target was 0 + wShift*0.015).
  if (parts.hips) {
    parts.hips.rotation.z = THREE.MathUtils.damp(parts.hips.rotation.z, s.wShift * 0.04, 4, dt);
    parts.hips.position.x = THREE.MathUtils.damp(parts.hips.position.x, 0.02 + s.wShift * 0.015, 4, dt);
  }

  // ─── Vest — chest breathing (scale + position) ──────────────────────────
  if (parts.vest) {
    parts.vest.position.y = 1.16 + breatheY * 0.8;
    parts.vest.position.x = breatheSway;
    parts.vest.scale.y = 1.0 + breathe * 0.02;
    parts.vest.scale.x = 1.0 + breathe * 0.015;
  }

  // ─── Head / helmet / visor / nvg — breathing + micro-look ───────────────
  // Vestibulo-ocular reflex: head stays relatively level (only 30% of body bob).
  const headY = 1.65 + breatheY * 0.3;
  const headX = breatheSway * 0.5;
  if (parts.head) {
    parts.head.position.y = headY;
    parts.head.position.x = headX;
    parts.head.rotation.x = THREE.MathUtils.damp(parts.head.rotation.x, s.hPitch, 5, dt);
    parts.head.rotation.y = THREE.MathUtils.damp(parts.head.rotation.y, s.hYaw, 5, dt);
  }
  if (parts.helmet) {
    parts.helmet.position.y = 1.70 + breatheY * 0.3;
    parts.helmet.position.x = headX;
  }
  if (parts.visor) {
    parts.visor.position.y = 1.68 + breatheY * 0.3;
    parts.visor.position.x = headX;
  }
  if (parts.nvg) {
    parts.nvg.position.y = 1.78 + breatheY * 0.3;
    parts.nvg.position.x = headX;
  }

  // ─── Backpack — breathing sway (slightly delayed = inertia) ─────────────
  if (parts.backpack) {
    parts.backpack.position.y = 1.20 + breatheY * 0.5;
    parts.backpack.position.x = breatheSway * 0.6;
    parts.backpack.rotation.x = THREE.MathUtils.damp(parts.backpack.rotation.x, 0, 5, dt);
  }
  if (parts.backpackFlap) {
    parts.backpackFlap.position.y = 1.36 + breatheY * 0.5;
    parts.backpackFlap.position.x = breatheSway * 0.6;
  }

  // ─── Arms — relaxed pose with micro-adjustments ─────────────────────────
  // Shoulders drop slightly (arms hang naturally, not stiff).
  parts.larm.rotation.x = THREE.MathUtils.damp(parts.larm.rotation.x, breatheRotX * 0.3 + s.aAdj * 0.5, 4, dt);
  parts.rarm.rotation.x = THREE.MathUtils.damp(parts.rarm.rotation.x, -breatheRotX * 0.3 + s.aAdj * 0.5, 4, dt);
  // Elbows slightly bent (relaxed, not locked straight).
  if (parts.larmLower) parts.larmLower.rotation.x = THREE.MathUtils.damp(parts.larmLower.rotation.x, 0.08 + s.aAdj * 0.3, 5, dt);
  if (parts.rarmLower) parts.rarmLower.rotation.x = THREE.MathUtils.damp(parts.rarmLower.rotation.x, 0.08 - s.aAdj * 0.3, 5, dt);
  // Wrists relaxed (slight rotation).
  if (parts.lglove) parts.lglove.rotation.z = THREE.MathUtils.damp(parts.lglove.rotation.z, 0.04, 5, dt);
  if (parts.rglove) parts.rglove.rotation.z = THREE.MathUtils.damp(parts.rglove.rotation.z, -0.04, 5, dt);

  // ─── Legs — soft knees (not locked) + weight shift ──────────────────────
  parts.lleg.rotation.x = THREE.MathUtils.damp(parts.lleg.rotation.x, 0.02, 5, dt);
  parts.rleg.rotation.x = THREE.MathUtils.damp(parts.rleg.rotation.x, 0.02, 5, dt);
  // Loaded leg straightens slightly; unloaded leg softens (slight extra bend).
  if (parts.lshin) parts.lshin.rotation.x = THREE.MathUtils.damp(parts.lshin.rotation.x, -0.04 - s.wShift * 0.02, 5, dt);
  if (parts.rshin) parts.rshin.rotation.x = THREE.MathUtils.damp(parts.rshin.rotation.x, -0.04 + s.wShift * 0.02, 5, dt);

  // Boots damp to neutral.
  if (parts.llegBoot) {
    parts.llegBoot.position.z = THREE.MathUtils.damp(parts.llegBoot.position.z, 0.03, 6, dt);
    parts.llegBoot.position.y = THREE.MathUtils.damp(parts.llegBoot.position.y, -0.02, 6, dt);
  }
  if (parts.rlegBoot) {
    parts.rlegBoot.position.z = THREE.MathUtils.damp(parts.rlegBoot.position.z, 0.03, 6, dt);
    parts.rlegBoot.position.y = THREE.MathUtils.damp(parts.rlegBoot.position.y, -0.02, 6, dt);
  }
  if (parts.lBootUpper) {
    parts.lBootUpper.position.z = THREE.MathUtils.damp(parts.lBootUpper.position.z, 0.02, 6, dt);
    parts.lBootUpper.position.y = THREE.MathUtils.damp(parts.lBootUpper.position.y, 0.02, 6, dt);
  }
  if (parts.rBootUpper) {
    parts.rBootUpper.position.z = THREE.MathUtils.damp(parts.rBootUpper.position.z, 0.02, 6, dt);
    parts.rBootUpper.position.y = THREE.MathUtils.damp(parts.rBootUpper.position.y, 0.02, 6, dt);
  }
}

/**
 * Animate humanoid gait — natural walking/running animation.
 *
 * Layered motions (Task 34 fluid upgrades):
 *   θ_thigh(t)  = A * sin(phase)                       — leg swing
 *   θ_knee(t)   = smoothstep(max(0, sin(phase+0.5)))   — knee bend (swing phase)
 *   θ_ankle(t)  = sin(phase + π/4) * 0.04              — subtle ankle roll
 *   θ_shoulder  = -A * 0.7 * sin(phase)                — arm counter-swing
 *   θ_elbow     = smoothstep(max(0, sin(phase)))       — elbow bends in back-swing
 *   θ_wrist     = sin(phase) * 0.05                    — subtle wrist rotation
 *   y_bob(t)    = |sin(2*phase)| * B                   — vertical bob (2× step freq)
 *   x_sway(t)   = sin(phase) * S                       — lateral sway (1× step freq)
 *   x_hip(t)    = sin(phase) * S * 0.5                 — hip side-to-side shift
 *   θ_hipYaw    = sin(phase) * 0.06                    — pelvis rotation per step
 *   θ_spineYaw  = -sin(phase) * 0.04                   — counter-rotation (shoulders stay forward)
 *   y_head(t)   = y_bob * 0.3                          — vestibulo-ocular reflex (head stable)
 *   θ_accelLean = clamp(accel * 0.015, ±0.15)          — forward lean when accelerating
 *
 * Where:
 *   A = amplitude (0.5 walk, 0.9 run) — DAMPED toward target for fluid
 *       speed transitions (no snap when sprint starts/stops).
 *   ω = angular frequency = speed * cadence (1.6 walk, 2.4 run).
 *   φ = phase (alternates legs by π).
 *
 * Stochasticity: removed (the smoothed amplitude + accel lean already break
 * the mechanical look; per-frame random noise fights the fluid damping).
 *
 * When speed < 0.5, delegates to animateIdle (breathing + weight shift +
 * micro-movements) so stationary humanoids aren't frozen. The existing
 * call sites that pass phase=0 speed=0 (player avatar in PhysicsSystem,
 * vaulting) automatically get idle motion.
 */
export function animateGait(parts: Record<string, THREE.Mesh>, phase: number, speed: number, running: boolean) {
  // ─── Idle delegation (speed < 0.5) ────────────────────────────────────────
  if (speed < 0.5) {
    animateIdle(parts, performance.now() * 0.001);
    return;
  }

  const s = getGaitState(parts);
  // Wall-clock dt for damping (clamped — matches engine's 0.05s cap).
  const now = performance.now() * 0.001;
  let dt = now - s.pT;
  if (s.pT === 0 || dt <= 0 || dt > 0.05) dt = 0.016;
  s.pT = now;

  // ─── Smoothed amplitude (fluid speed transitions) ────────────────────────
  // Damp toward target amplitude (8/s λ → ~0.125s transition). Without this,
  // starting/stopping a sprint would snap the gait amplitude from 0 to 0.9
  // in one frame, which reads as mechanical.
  const speedFactor = Math.min(speed / 4, 1.2);
  const targetAmp = (running ? 0.9 : 0.5) * speedFactor;
  s.sAmp = THREE.MathUtils.damp(s.sAmp, targetAmp, 8, dt);
  const amplitude = s.sAmp;

  const bobAmp = (running ? 0.06 : 0.04) * speedFactor;
  const swayAmp = (running ? 0.03 : 0.02) * speedFactor;

  // ─── Acceleration lean (forward when accelerating, back when decelerating) ─
  // accel = Δv/Δt. Clamp to ±30 m/s² (avoid teleport spikes), damp for smoothness.
  const rawAccel = (speed - s.pSpeed) / Math.max(dt, 0.001);
  s.pSpeed = speed;
  const clampedAccel = THREE.MathUtils.clamp(rawAccel, -30, 30);
  s.sAccel = THREE.MathUtils.damp(s.sAccel, clampedAccel, 5, dt);
  // Positive accel → lean forward (rotation.x > 0 in this rig).
  const accelLean = THREE.MathUtils.clamp(s.sAccel * 0.015, -0.15, 0.15);

  // Reset vest scale (animateIdle scales the vest for chest breathing).
  if (parts.vest) {
    parts.vest.scale.y = THREE.MathUtils.damp(parts.vest.scale.y, 1.0, 8, dt);
    parts.vest.scale.x = THREE.MathUtils.damp(parts.vest.scale.x, 1.0, 8, dt);
  }

  // ─── Leg swing — thighs pivot at hip ─────────────────────────────────────
  const swing = Math.sin(phase) * amplitude;
  const swing2 = Math.sin(phase + Math.PI) * amplitude;
  parts.lleg.rotation.x = swing;
  parts.rleg.rotation.x = swing2;

  // ─── Knee bend — smoother curve (smoothstep on the liftoff half-wave) ─────
  // The knee bends during the swing phase (foot lifted) + straightens when
  // planted. smoothstep gives a much softer ramp-up/down than the raw
  // half-wave rectified sin used previously.
  const lLift = Math.max(0, Math.sin(phase + 0.5));
  const lLiftS = lLift * lLift * (3 - 2 * lLift); // smoothstep
  const lshinBend = lLiftS * 0.5 * speedFactor;
  const rLift = Math.max(0, Math.sin(phase + Math.PI + 0.5));
  const rLiftS = rLift * rLift * (3 - 2 * rLift);
  const rshinBend = rLiftS * 0.5 * speedFactor;
  if (parts.lshin) parts.lshin.rotation.x = -lshinBend;
  if (parts.rshin) parts.rshin.rotation.x = -rshinBend;

  // ─── Ankle roll — subtle foot roll on plant (adds realism) ───────────────
  if (parts.llegBoot) {
    parts.llegBoot.rotation.z = Math.sin(phase + Math.PI * 0.25) * 0.04 * speedFactor;
  }
  if (parts.rlegBoot) {
    parts.rlegBoot.rotation.z = Math.sin(phase + Math.PI + Math.PI * 0.25) * 0.04 * speedFactor;
  }

  // Boot soles + boot uppers follow the shin's foot liftoff.
  const ldz = Math.sin(phase) * 0.05 * speedFactor;
  const ldy = Math.max(0, Math.sin(phase)) * 0.03 * speedFactor;
  const rdz = Math.sin(phase + Math.PI) * 0.05 * speedFactor;
  const rdy = Math.max(0, Math.sin(phase + Math.PI)) * 0.03 * speedFactor;
  if (parts.llegBoot) {
    parts.llegBoot.position.z = 0.03 + ldz;
    parts.llegBoot.position.y = -0.02 + ldy;
  }
  if (parts.rlegBoot) {
    parts.rlegBoot.position.z = 0.03 + rdz;
    parts.rlegBoot.position.y = -0.02 + rdy;
  }
  if (parts.lBootUpper) {
    parts.lBootUpper.position.z = 0.02 + ldz;
    parts.lBootUpper.position.y = 0.02 + ldy;
  }
  if (parts.rBootUpper) {
    parts.rBootUpper.position.z = 0.02 + rdz;
    parts.rBootUpper.position.y = 0.02 + rdy;
  }

  // ─── Hip sway + hip rotation (pelvis moves with each step) ───────────────
  // Weight transfers side-to-side: the loaded hip rises + the pelvis rotates
  // slightly with each step. Damped so the hip motion lags the legs a touch
  // (pelvis has more inertia than a thigh).
  if (parts.hips) {
    parts.hips.position.x = THREE.MathUtils.damp(parts.hips.position.x, Math.sin(phase) * swayAmp * 0.5, 10, dt);
    parts.hips.rotation.y = THREE.MathUtils.damp(parts.hips.rotation.y, Math.sin(phase) * 0.06 * speedFactor, 10, dt);
    parts.hips.rotation.z = THREE.MathUtils.damp(parts.hips.rotation.z, 0, 6, dt);
  }

  // ─── Arm swing — shoulder drives, elbow bends during back-swing ──────────
  // Left arm: back-swing = sin(phase) > 0 (left leg forward, arm back).
  // Right arm: back-swing = sin(phase+π) > 0 = sin(phase) < 0.
  parts.larm.rotation.x = -swing * 0.7;
  parts.rarm.rotation.x = -swing2 * 0.7;
  const lBack = Math.max(0, Math.sin(phase));
  const lBackS = lBack * lBack * (3 - 2 * lBack);
  const lElbowBend = lBackS * 0.4 * speedFactor;
  const rBack = Math.max(0, Math.sin(phase + Math.PI));
  const rBackS = rBack * rBack * (3 - 2 * rBack);
  const rElbowBend = rBackS * 0.4 * speedFactor;
  if (parts.larmLower) parts.larmLower.rotation.x = -swing * 0.15 + lElbowBend;
  if (parts.rarmLower) parts.rarmLower.rotation.x = -swing2 * 0.15 + rElbowBend;
  // Wrist rotation — subtle, follows the arm swing.
  if (parts.lglove) parts.lglove.rotation.z = Math.sin(phase) * 0.05 * speedFactor;
  if (parts.rglove) parts.rglove.rotation.z = -Math.sin(phase) * 0.05 * speedFactor;

  // ─── Body bob — vertical at 2× step freq, lateral at 1× step freq ────────
  const bob = Math.abs(Math.sin(phase * 2)) * bobAmp;
  parts.body.position.y = 1.15 + bob;
  parts.body.position.x = Math.sin(phase) * swayAmp;
  // Forward lean when running + acceleration lean (forward on accel, back on decel).
  parts.body.rotation.x = (running ? 0.12 * speedFactor : 0) + accelLean;
  // Spine counter-rotation — opposes the hip rotation so the shoulders stay
  // roughly facing forward (natural walking counter-rotation).
  parts.body.rotation.y = -Math.sin(phase) * 0.04 * speedFactor;
  // Damp body roll to 0 (clean up any leftover from idle weight-shift).
  parts.body.rotation.z = THREE.MathUtils.damp(parts.body.rotation.z, 0, 8, dt);

  // ─── Head bob — vestibulo-ocular reflex (head stays relatively stable) ───
  // Damped to 30% of the body bob so the eyes stay level (the neck absorbs
  // 70% of the up/down motion — the same reflex that lets you walk without
  // the world bouncing).
  const headBob = bob * 0.3;
  const headSway = Math.sin(phase) * swayAmp * 0.3;
  if (parts.head) {
    parts.head.position.y = 1.65 + headBob;
    parts.head.position.x = headSway;
    // Damp head rotation to 0 (clean up any idle micro-look).
    parts.head.rotation.x = THREE.MathUtils.damp(parts.head.rotation.x, 0, 6, dt);
    parts.head.rotation.y = THREE.MathUtils.damp(parts.head.rotation.y, 0, 6, dt);
  }
  if (parts.helmet) {
    parts.helmet.position.y = 1.70 + headBob;
    parts.helmet.position.x = headSway;
  }
  if (parts.visor) {
    parts.visor.position.y = 1.68 + headBob;
    parts.visor.position.x = headSway;
  }
  if (parts.nvg) {
    parts.nvg.position.y = 1.78 + headBob;
    parts.nvg.position.x = headSway;
  }

  // Vest follows body bob (vest is the chest — should bob with torso).
  if (parts.vest) {
    parts.vest.position.y = 1.16 + bob * 0.8;
    parts.vest.position.x = Math.sin(phase) * swayAmp;
  }

  // Backpack follows body bob (slightly reduced for inertia).
  if (parts.backpack) {
    parts.backpack.position.y = 1.20 + bob * 0.6;
    parts.backpack.position.x = Math.sin(phase) * swayAmp * 0.7;
    parts.backpack.rotation.x = running ? Math.sin(phase * 2) * 0.03 * speedFactor : 0;
  }
  if (parts.backpackFlap) {
    parts.backpackFlap.position.y = 1.36 + bob * 0.6;
    parts.backpackFlap.position.x = Math.sin(phase) * swayAmp * 0.7;
  }
}
