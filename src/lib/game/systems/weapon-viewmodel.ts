import * as THREE from "three";
import type { GameContext, Enemy } from "./types";
import { buildDetailedWeapon } from "../WeaponBuilder";
import { loadModel } from "../assets/ModelRegistry";
import { useGameStore, type LoadoutConfig, type EffectiveWeaponStats, type WeaponType } from "../store";
import { getOperatorVisual, skinToneHexNum } from "../operators";
import { tacticalFabricTexture } from "../textures";
// Prompt A#45 — import the canonical BASE_POSES so the viewmodel's initial
// pose matches the state machine's idle pose (single source of truth). Also
// imports FPAnimStateMachine for Prompt A#49 (the state machine is
// instantiated in buildWeaponViewmodel + its output is applied each frame
// by PhysicsSystem's viewmodel driver via ctx.weapon.fpStateMachine).
import { FP_BASE_POSES, FPAnimStateMachine } from "../animation/fp-state-machine";

/**
 * Build the first-person weapon viewmodel using the detailed WeaponBuilder.
 * The same 30-60+ part model is used in both the gunsmith display and the
 * first-person view — one model source, consistent detail everywhere.
 *
 * In addition to the weapon, this builds a pair of first-person arms
 * (gloved hands + sleeved forearms) that grip the weapon's foregrip and
 * pistol grip. The arms are children of the gun group so they inherit all
 * viewmodel animation (sway, recoil, sprint, inspect, ADS, reload).
 *
 * Positions the weapon in the bottom-right of the camera view + sets up the
 * muzzle tip Object3D for VFX anchoring. Extracted from WeaponSystem to keep
 * that file under 250 lines.
 */

/** Extended gunParts with first-person arm references (added alongside the
 *  existing gun/mag/handle/muzzleTip keys). The base gunParts type in
 *  types.ts is a fixed interface, so callers cast via this type to access
 *  the arm fields. */
export interface GunPartsWithArms {
  gun: THREE.Group;
  mag?: THREE.Mesh;
  handle?: THREE.Mesh;
  muzzleTip: THREE.Object3D;
  leftArm?: THREE.Group;
  rightArm?: THREE.Group;
  leftHand?: THREE.Group;
  rightHand?: THREE.Group;
}

/** Per-weapon grip positions (in gun-local space) for the first-person arms.
 *  leftHand  = where the support hand grips (foregrip / pump / slide support).
 *  rightHand = where the trigger hand grips the pistol grip.
 *  leftRotX  = forward tilt of the support arm (radians) — matches the
 *              foregrip/handguard angle (slight forward tilt for natural reach;
 *              larger tilt for pumps/pistol-support where the palm faces up).
 *  rightRotX = forward tilt of the trigger arm (radians) — matches the pistol
 *              grip's rearward lean so the hand + forearm align with the grip
 *              axis (the wrist, palm, and forearm form a straight line up the
 *              grip, not a sharp bend at the wrist).
 *  pistolSupport = true for pistols (support hand cups under the slide).
 *
 *  Positions place the WRIST (arm origin) at the lower-middle of the grip —
 *  the hand extends +Y up the grip axis, with the palm wrapping the front
 *  face + fingers curling around the back. The wrist is below + slightly
 *  forward of the grip center so the hand reads as gripping from below
 *  (COD-style "hands reaching up from the bottom of the screen"). */
const GRIP_SPECS: Record<WeaponType, {
  leftHand: [number, number, number];
  rightHand: [number, number, number];
  leftRotX: number;
  rightRotX: number;
  pistolSupport?: boolean;
}> = {
  // AK-74: pistol grip angle ~-0.35 rad, handguard center z=-0.25 (support
  // hand grips the front third at z=-0.30, below the handguard).
  ak74:  { leftHand: [0, -0.07, -0.30], rightHand: [0, -0.13, 0.10], leftRotX: -0.10, rightRotX: -0.32 },
  // M4: pistol grip angle ~-0.28 rad, M-LOK handguard center z=-0.26.
  m4:    { leftHand: [0, -0.07, -0.30], rightHand: [0, -0.13, 0.10], leftRotX: -0.10, rightRotX: -0.25 },
  // MP-7: compact grip angle ~-0.20, vertical foregrip at z=-0.14.
  mp7:   { leftHand: [0, -0.10, -0.14], rightHand: [0, -0.12, 0.08], leftRotX: -0.12, rightRotX: -0.18 },
  // P90: bullpup — rear grip at z=0.12, front grip at z=-0.18.
  p90:   { leftHand: [0, -0.10, -0.18], rightHand: [0, -0.11, 0.12], leftRotX: -0.12, rightRotX: -0.13 },
  // USP-S: grip angle ~-0.15; support hand cups under the slide (z=-0.06).
  usp:   { leftHand: [0, -0.08, -0.06], rightHand: [0, -0.16, 0.04], leftRotX: -0.45, rightRotX: -0.15, pistolSupport: true },
  // Deagle: grip angle ~-0.25; support hand cups under the slide.
  deagle:{ leftHand: [0, -0.10, -0.08], rightHand: [0, -0.14, 0.04], leftRotX: -0.45, rightRotX: -0.22, pistolSupport: true },
  // AWP: thumbhole grip at z=0.22, angle ~-0.25; support hand on the forend
  //  (front of receiver) at z=-0.15.
  awp:   { leftHand: [0, -0.10, -0.15], rightHand: [0, -0.13, 0.20], leftRotX: -0.10, rightRotX: -0.22 },
  // Scout: same thumbhole layout as AWP.
  scout: { leftHand: [0, -0.10, -0.15], rightHand: [0, -0.13, 0.20], leftRotX: -0.10, rightRotX: -0.22 },
  // Nova: pistol grip angle ~-0.25; support hand grips the pump at z=-0.35
  //  (palm wraps from below, larger forward tilt to cup the pump).
  nova:  { leftHand: [0, -0.10, -0.35], rightHand: [0, -0.13, 0.10], leftRotX: -0.30, rightRotX: -0.22 },
  // M249: pistol grip angle ~-0.28; support hand on the heat shield at z=-0.28.
  m249:  { leftHand: [0, -0.08, -0.28], rightHand: [0, -0.14, 0.12], leftRotX: -0.10, rightRotX: -0.25 },

  // ────────────────────────────────────────────────────────────────────
  // Task-5 — new weapons. Grip positions cloned from closest sibling per
  // category. All values are in gun-local meters.
  // ────────────────────────────────────────────────────────────────────

  // ── RIFLE / battle rifle / marksman ── (mirror M4/AK-74 layout)
  hk416:  { leftHand: [0, -0.07, -0.30], rightHand: [0, -0.13, 0.10], leftRotX: -0.10, rightRotX: -0.27 },
  famas:  { leftHand: [0, -0.07, -0.28], rightHand: [0, -0.13, 0.08], leftRotX: -0.12, rightRotX: -0.22 },
  aug:    { leftHand: [0, -0.10, -0.18], rightHand: [0, -0.11, 0.12], leftRotX: -0.12, rightRotX: -0.18 }, // bullpup
  scarh:  { leftHand: [0, -0.07, -0.32], rightHand: [0, -0.13, 0.10], leftRotX: -0.10, rightRotX: -0.30 },
  galil:  { leftHand: [0, -0.07, -0.30], rightHand: [0, -0.13, 0.10], leftRotX: -0.10, rightRotX: -0.32 },
  mk17:   { leftHand: [0, -0.07, -0.32], rightHand: [0, -0.13, 0.10], leftRotX: -0.10, rightRotX: -0.30 },
  mk14:   { leftHand: [0, -0.10, -0.20], rightHand: [0, -0.13, 0.16], leftRotX: -0.10, rightRotX: -0.22 }, // thumbhole

  // ── SMG ── (mirror MP7/P90 layout)
  mp5:    { leftHand: [0, -0.10, -0.18], rightHand: [0, -0.12, 0.08], leftRotX: -0.12, rightRotX: -0.20 },
  ump45:  { leftHand: [0, -0.10, -0.18], rightHand: [0, -0.12, 0.08], leftRotX: -0.12, rightRotX: -0.22 },
  vector: { leftHand: [0, -0.10, -0.14], rightHand: [0, -0.12, 0.06], leftRotX: -0.14, rightRotX: -0.18 },
  pp90m1: { leftHand: [0, -0.10, -0.16], rightHand: [0, -0.11, 0.10], leftRotX: -0.12, rightRotX: -0.16 }, // bullpup

  // ── PISTOL ── (mirror USP/Deagle cupped-slide support)
  glock18: { leftHand: [0, -0.08, -0.06], rightHand: [0, -0.16, 0.04], leftRotX: -0.45, rightRotX: -0.15, pistolSupport: true },
  m1911:   { leftHand: [0, -0.09, -0.07], rightHand: [0, -0.15, 0.04], leftRotX: -0.45, rightRotX: -0.18, pistolSupport: true },
  revolver:{ leftHand: [0, -0.10, -0.08], rightHand: [0, -0.14, 0.04], leftRotX: -0.45, rightRotX: -0.22, pistolSupport: true },

  // ── SNIPER ── (mirror AWP/Scout thumbhole)
  kar98k: { leftHand: [0, -0.10, -0.20], rightHand: [0, -0.13, 0.18], leftRotX: -0.10, rightRotX: -0.20 },
  l115a3: { leftHand: [0, -0.10, -0.15], rightHand: [0, -0.13, 0.20], leftRotX: -0.10, rightRotX: -0.22 },

  // ── SHOTGUN ── (mirror Nova pump-grip)
  m1014:  { leftHand: [0, -0.10, -0.30], rightHand: [0, -0.13, 0.10], leftRotX: -0.25, rightRotX: -0.22 },
  spas12: { leftHand: [0, -0.10, -0.32], rightHand: [0, -0.13, 0.10], leftRotX: -0.30, rightRotX: -0.22 },

  // ── LMG ── (mirror M249 heat-shield support)
  rpk:    { leftHand: [0, -0.08, -0.26], rightHand: [0, -0.14, 0.10], leftRotX: -0.10, rightRotX: -0.30 },
  mk48:   { leftHand: [0, -0.08, -0.28], rightHand: [0, -0.14, 0.12], leftRotX: -0.10, rightRotX: -0.25 },
};

// ─── Module-level caches for first-person arms ───
// Materials are cached by color key so both arms (and re-builds on weapon
// switch) share the same material instances — keeps GPU draw calls minimal
// and avoids re-allocating canvas textures on every swap.
const armMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
function cachedMat(
  key: string,
  factory: () => THREE.MeshStandardMaterial,
): THREE.MeshStandardMaterial {
  let m = armMaterialCache.get(key);
  if (!m) { m = factory(); armMaterialCache.set(key, m); }
  return m;
}

// Shared small geometries — created once, reused across all hairs / nails /
// creases on both arms. These are tiny details repeated 20-50× per arm, so
// sharing the BufferGeometry saves ~100 allocations per viewmodel build.
const armGeo = {
  hair: new THREE.CylinderGeometry(0.0008, 0.0005, 0.012, 4),
  nail: new THREE.SphereGeometry(0.0045, 8, 6),
  crease: new THREE.BoxGeometry(0.008, 0.001, 0.003),
};

// Seeded RNG for deterministic arm-hair placement (stable per side, so left
// and right arms have a fixed hair distribution that doesn't reshuffle on
// every weapon-switch rebuild).
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a single ultra-detailed first-person arm (forearm + wrist + hand) in
 *  arm-local space. Origin is at the wrist; the forearm extends DOWN (-Y)
 *  toward the elbow (off-screen below the camera). The hand extends UP (+Y)
 *  with fingers pointing forward (+Z, toward the muzzle) — a natural
 *  "reaching up to grip" pose.
 *
 *  Detail layer (per arm): tapered skin forearm with 4 raised veins + ~24 arm
 *  hairs + wrist crease; rolled-up sleeve cuff (2 stacked tori); gloved hand
 *  with 4 knuckle pads + 3 knuckle creases; 4 fingers × 3 phalanx segments
 *  (proximal + middle gloved, distal skin-tone for fingerless gloves) with 2
 *  joint creases + glove cutoff ring + fingernail + cuticle each; 2-segment
 *  thumb with nail + cuticle. Roughly 85 meshes per arm.
 *
 *  `side` controls the thumb direction (left thumb +X, right thumb -X).
 *  `isPistolSupport` tilts the hand so the palm faces up (cupping the slide). */
function buildFirstPersonArm(
  side: "left" | "right",
  suitColor: number,
  vestColor: number,
  skinTone: number,
  isPistolSupport: boolean,
): { arm: THREE.Group; hand: THREE.Group } {
  const arm = new THREE.Group();
  const skinColorNum = skinToneHexNum(skinTone);

  // ─── Materials (cached by color key) ───
  const sleeveMat = cachedMat(`fpSleeve:${suitColor}`, () => new THREE.MeshStandardMaterial({
    color: suitColor,
    map: tacticalFabricTexture(suitColor),
    roughness: 0.85, metalness: 0.0,
  }));
  const gloveMat = cachedMat(`fpGlove:${vestColor}`, () => new THREE.MeshStandardMaterial({
    color: vestColor,
    roughness: 0.7, metalness: 0.05,
  }));
  const cuffMat = cachedMat(`fpCuff:${vestColor}`, () => new THREE.MeshStandardMaterial({
    color: new THREE.Color(vestColor).multiplyScalar(0.6),
    roughness: 0.8, metalness: 0.0,
  }));
  const knuckleMat = cachedMat(`fpKnuckle:${vestColor}`, () => new THREE.MeshStandardMaterial({
    color: new THREE.Color(vestColor).multiplyScalar(0.85),
    roughness: 0.7, metalness: 0.05,
  }));
  const skinMat = cachedMat(`fpSkin:${skinTone}`, () => new THREE.MeshStandardMaterial({
    color: skinColorNum,
    roughness: 0.72, metalness: 0.0,
    emissive: 0x2a1a10, emissiveIntensity: 0.08, // subsurface warm tint
  }));
  const veinMat = cachedMat(`fpVein:${skinTone}`, () => {
    // Blend skin tone with a bluish tint for under-skin veins.
    const c = new THREE.Color(skinColorNum).lerp(new THREE.Color(0x4a6688), 0.45);
    return new THREE.MeshStandardMaterial({
      color: c, roughness: 0.8, metalness: 0.0,
      transparent: true, opacity: 0.85,
    });
  });
  const nailMat = cachedMat(`fpNail`, () => new THREE.MeshStandardMaterial({
    color: 0xe8d8c8, roughness: 0.3, metalness: 0.0,
    emissive: 0xe8d8c8, emissiveIntensity: 0.05, // healthy sheen
  }));
  const hairMat = cachedMat(`fpHair`, () => new THREE.MeshStandardMaterial({
    color: 0x3a2a1a, roughness: 0.9, metalness: 0.0,
  }));
  const creaseMat = cachedMat(`fpCrease:${skinTone}`, () => new THREE.MeshStandardMaterial({
    color: new THREE.Color(skinColorNum).multiplyScalar(0.6), // skin darkened 40%
    roughness: 0.85, metalness: 0.0,
  }));

  const ns = (m: THREE.Mesh) => { m.castShadow = false; m.receiveShadow = false; };

  // ─── Forearm ───
  // Visible skin portion (wrist → mid-forearm): tapered cylinder, thinner at
  // the wrist (0.026) thickening slightly toward the elbow (0.030).
  const skinLen = 0.055;
  const foreSkin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.026, 0.030, skinLen, 16),
    skinMat,
  );
  foreSkin.position.set(0, -skinLen / 2, 0);
  ns(foreSkin); arm.add(foreSkin);

  // Sleeve portion (mid-forearm → elbow, mostly off-screen): tapered cylinder
  // in tactical fabric, thickening from 0.030 → 0.044 at the elbow.
  const sleeveLen = 0.125;
  const foreSleeve = new THREE.Mesh(
    new THREE.CylinderGeometry(0.030, 0.044, sleeveLen, 16),
    sleeveMat,
  );
  foreSleeve.position.set(0, -skinLen - sleeveLen / 2, 0);
  ns(foreSleeve); arm.add(foreSleeve);

  // Rolled-up sleeve cuff — two stacked tori at the skin/sleeve junction,
  // giving the appearance of folded-back fabric.
  const cuff1 = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.009, 8, 18), cuffMat);
  cuff1.rotation.x = Math.PI / 2;
  cuff1.position.set(0, -skinLen, 0);
  ns(cuff1); arm.add(cuff1);
  const cuff2 = new THREE.Mesh(new THREE.TorusGeometry(0.031, 0.008, 8, 18), cuffMat);
  cuff2.rotation.x = Math.PI / 2;
  cuff2.position.set(0, -skinLen + 0.013, 0);
  ns(cuff2); arm.add(cuff2);

  // ─── Veins (4 curved tubes running along the visible skin portion) ───
  // Each is a TubeGeometry along a CatmullRomCurve3, slightly raised above
  // the skin surface, bluer than the skin, semi-transparent to read as
  // under-skin. Visible when the player looks down at the forearm.
  const veinYs = [-0.006, -0.020, -0.035, -0.048];
  const veinDefs = [
    { xs: [0.018, 0.022, 0.019, 0.021], zs: [0.012, 0.014, 0.011, 0.013], r: 0.0040 },
    { xs: [-0.014, -0.018, -0.013, -0.016], zs: [0.014, 0.013, 0.015, 0.012], r: 0.0035 },
    { xs: [0.005, 0.008, 0.004, 0.006], zs: [0.018, 0.020, 0.017, 0.019], r: 0.0030 },
    { xs: [-0.020, -0.023, -0.019, -0.022], zs: [0.010, 0.012, 0.009, 0.011], r: 0.0030 },
  ];
  for (const vd of veinDefs) {
    const curve = new THREE.CatmullRomCurve3(
      veinYs.map((y, i) => new THREE.Vector3(vd.xs[i], y, vd.zs[i])),
    );
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 12, vd.r, 6, false),
      veinMat,
    );
    ns(tube); arm.add(tube);
  }

  // ─── Arm hair (28 tiny cylinders, biased to top + sides of forearm) ───
  // Each hair is a thin cylinder (r=0.0008, len=0.012) positioned on the
  // skin surface, oriented radially outward + slightly downward. Subtle but
  // visible on close inspection — adds the organic realism the user asked for.
  const rng = mulberry32(side === "left" ? 0x9e3779b1 : 0x85ebca77);
  for (let i = 0; i < 28; i++) {
    // Angle around forearm: -0.65π .. +0.65π (spans front + sides, skips back
    // where the arm presses against the body and wouldn't be visible).
    const a = (rng() - 0.5) * Math.PI * 1.3;
    const y = -0.008 - rng() * 0.040;
    const r = 0.0275;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    if (z < -0.004) continue; // skip back of arm
    // Direction: radially outward + slightly downward (per-hair jitter).
    const dir = new THREE.Vector3(x, -0.28 - rng() * 0.25, z).normalize();
    // Shift the hair center half a length outward so it starts at the surface.
    const center = new THREE.Vector3(x, y, z).add(dir.clone().multiplyScalar(0.006));
    const hair = new THREE.Mesh(armGeo.hair, hairMat);
    hair.position.copy(center);
    hair.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    ns(hair); arm.add(hair);
  }

  // ─── Wrist crease — thin torus at the wrist joint (skin fold) ───
  const wristCrease = new THREE.Mesh(
    new THREE.TorusGeometry(0.0245, 0.0015, 4, 14),
    creaseMat,
  );
  wristCrease.rotation.x = Math.PI / 2;
  wristCrease.position.set(0, -0.004, 0);
  ns(wristCrease); arm.add(wristCrease);

  // ─── Wrist joint — small sphere (carpal bones under skin) ───
  const wrist = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 10), skinMat);
  wrist.position.set(0, 0, 0);
  ns(wrist); arm.add(wrist);

  // ═══ Hand group (palm + fingers + thumb) ═══
  // Origin at the wrist; hand extends +Y. PhysicsSystem resets
  // rightHand.position.y to `0.005 - kick*0.3` each frame, so the default Y
  // here MUST stay 0.005 for the fire-recoil wrist flex to animate correctly.
  const hand = new THREE.Group();
  hand.position.set(0, 0.005, 0);
  arm.add(hand);

  // Palm — beveled box, wider at the knuckle line (+Y) for anatomical taper.
  const palmGeo = new THREE.BoxGeometry(0.05, 0.05, 0.045, 1, 2, 1);
  const pp = palmGeo.attributes.position;
  for (let i = 0; i < pp.count; i++) {
    if (pp.getY(i) > 0) pp.setX(i, pp.getX(i) * 1.08);
    if (Math.abs(pp.getZ(i)) > 0.02) pp.setY(i, pp.getY(i) * 0.96);
  }
  pp.needsUpdate = true;
  palmGeo.computeVertexNormals();
  const palm = new THREE.Mesh(palmGeo, gloveMat);
  palm.position.set(0, 0.028, 0);
  ns(palm); hand.add(palm);

  // Knuckle pads — 4 flattened spheres on the back of the hand (+Y side).
  const knuckleXs = [-0.018, -0.006, 0.006, 0.018];
  for (const kx of knuckleXs) {
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 6), knuckleMat);
    k.position.set(kx, 0.054, 0.010);
    k.scale.set(1, 0.7, 1.2); // flat + elongated front-to-back
    ns(k); hand.add(k);
  }
  // Knuckle creases — 3 thin dark lines in the gaps between knuckles.
  for (let i = 0; i < 3; i++) {
    const cx = -0.012 + i * 0.012;
    const cr = new THREE.Mesh(armGeo.crease, creaseMat);
    cr.position.set(cx, 0.052, 0.012);
    ns(cr); hand.add(cr);
  }

  // ─── Fingers (index / middle / ring / pinky) ───
  // Each finger is built as a chain of THREE nested joint groups so any joint
  // can curl independently — PhysicsSystem drives these each frame to perform
  // the reload animation (relaxed grip → mag grip → fist → press → knife-hand).
  //
  //   mcpGroup (at the knuckle)            rotation.x = MCP joint curl
  //     ├─ proximal segment mesh
  //     └─ pipGroup (at the PIP joint)     rotation.x = PIP joint curl
  //          ├─ joint crease
  //          ├─ middle segment mesh
  //          └─ dipGroup (at the DIP joint) rotation.x = DIP joint curl
  //               ├─ glove cutoff ring
  //               ├─ joint crease
  //               ├─ distal segment mesh (skin-tone fingertip)
  //               ├─ fingernail
  //               └─ cuticle
  //
  // Positive rotation.x curls the fingertip DOWN toward the palm (closes the
  // grip); 0 = finger straight; ~π/2 = full fist.
  const fingerDefs: {
    x: number;
    lens: [number, number, number];
    rad: [[number, number], [number, number], [number, number]];
  }[] = [
    { x: -0.018, lens: [0.016, 0.013, 0.011], rad: [[0.0065, 0.0055], [0.0055, 0.0045], [0.0045, 0.0035]] }, // index
    { x: -0.006, lens: [0.018, 0.014, 0.012], rad: [[0.0070, 0.0060], [0.0060, 0.0050], [0.0050, 0.0040]] }, // middle (longest)
    { x:  0.006, lens: [0.016, 0.013, 0.010], rad: [[0.0065, 0.0055], [0.0055, 0.0045], [0.0045, 0.0035]] }, // ring
    { x:  0.018, lens: [0.013, 0.011, 0.009], rad: [[0.0055, 0.0045], [0.0045, 0.0038], [0.0038, 0.0030]] }, // pinky (shortest)
  ];
  const fy = 0.050; // finger center Y (knuckle line, near palm top)
  // Collect joint references for PhysicsSystem to animate. Format:
  //   fingerJoints[i] = [mcpGroup, pipGroup, dipGroup]  for finger i
  const fingerJoints: THREE.Group[][] = [];
  for (const fd of fingerDefs) {
    // MCP joint group — at the front face of the palm (knuckle line).
    const mcp = new THREE.Group();
    mcp.position.set(fd.x, fy, 0.022);
    hand.add(mcp);

    // Proximal segment mesh — gloved tapered cylinder, extends +Z.
    const [rProxBase, rProxTip] = fd.rad[0];
    const proxLen = fd.lens[0];
    const proxSeg = new THREE.Mesh(
      new THREE.CylinderGeometry(rProxTip, rProxBase, proxLen, 8), gloveMat,
    );
    proxSeg.rotation.x = Math.PI / 2;
    proxSeg.position.set(0, 0, proxLen / 2);
    ns(proxSeg); mcp.add(proxSeg);

    // PIP joint group — at the distal end of the proximal segment.
    const pip = new THREE.Group();
    pip.position.set(0, 0, proxLen);
    mcp.add(pip);

    // Joint crease between proximal and middle.
    const crease1 = new THREE.Mesh(armGeo.crease, creaseMat);
    crease1.position.set(0, 0.002, 0);
    ns(crease1); pip.add(crease1);

    // Middle segment mesh — gloved tapered cylinder.
    const [rMidBase, rMidTip] = fd.rad[1];
    const midLen = fd.lens[1];
    const midSeg = new THREE.Mesh(
      new THREE.CylinderGeometry(rMidTip, rMidBase, midLen, 8), gloveMat,
    );
    midSeg.rotation.x = Math.PI / 2;
    midSeg.position.set(0, 0, midLen / 2);
    ns(midSeg); pip.add(midSeg);

    // DIP joint group — at the distal end of the middle segment.
    const dip = new THREE.Group();
    dip.position.set(0, 0, midLen);
    pip.add(dip);

    // Glove cutoff ring at the middle→distal boundary (fingerless edge).
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(rMidTip + 0.0012, 0.0015, 4, 10), cuffMat,
    );
    ring.rotation.x = Math.PI / 2;
    ns(ring); dip.add(ring);

    // Joint crease between middle and distal.
    const crease2 = new THREE.Mesh(armGeo.crease, creaseMat);
    crease2.position.set(0, 0.002, 0.001);
    ns(crease2); dip.add(crease2);

    // Distal segment mesh — skin-tone rounded fingertip (elongated sphere).
    const distR = fd.rad[2][1];
    const distLen = fd.lens[2];
    const distSeg = new THREE.Mesh(
      new THREE.SphereGeometry(distR, 8, 6), skinMat,
    );
    distSeg.scale.set(1, distLen / (distR * 2), 1); // elongate along local Y → world Z
    distSeg.rotation.x = Math.PI / 2;
    distSeg.position.set(0, 0, distLen / 2);
    ns(distSeg); dip.add(distSeg);

    // Fingernail — flattened oval (scaled sphere) on top of the distal segment.
    const nail = new THREE.Mesh(armGeo.nail, nailMat);
    nail.scale.set(1, 0.3, 1.4); // flat (Y) + elongated (Z) → nail shape
    nail.position.set(0, distR + 0.0012, distLen * 0.42);
    ns(nail); dip.add(nail);

    // Cuticle — thin dark line at the nail base (reuse crease geometry).
    const cuticle = new THREE.Mesh(armGeo.crease, creaseMat);
    cuticle.position.set(0, distR + 0.0008, distLen * 0.18);
    ns(cuticle); dip.add(cuticle);

    fingerJoints.push([mcp, pip, dip]);
  }
  // Expose finger joints for the reload animation driver.
  hand.userData.fingerJoints = fingerJoints;

  // ─── Thumb (2 segments, angled away from the palm ~40°) ───
  // The thumb wraps around the weapon's pistol grip — its position relative
  // to the palm is critical for the grip to read correctly. Left thumb rests
  // on +X side (toward selector), right thumb on -X side.
  //
  // Chain (same pattern as the fingers):
  //   thumbBase (rotation.y = outward angle, fixed)
  //     └─ thumbMcp (rotation.x = MCP curl)
  //          ├─ proximal mesh
  //          └─ thumbIp (rotation.x = IP curl)
  //               ├─ distal mesh + crease + cutoff + nail + cuticle
  const thumbDir = side === "left" ? 1 : -1;
  const thumbBase = new THREE.Group();
  thumbBase.position.set(thumbDir * 0.029, 0.036, 0.014);
  thumbBase.rotation.y = thumbDir * -0.5;  // angle outward
  thumbBase.rotation.z = thumbDir * -0.15; // slight upward tilt
  hand.add(thumbBase);

  // MCP joint group (curls the whole thumb).
  const thumbMcp = new THREE.Group();
  thumbBase.add(thumbMcp);

  // Thumb proximal — gloved tapered cylinder.
  const thumbProxLen = 0.020;
  const thumbProx = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0065, 0.008, thumbProxLen, 8), gloveMat,
  );
  thumbProx.rotation.x = Math.PI / 2;
  thumbProx.position.set(0, 0, thumbProxLen / 2);
  ns(thumbProx); thumbMcp.add(thumbProx);

  // IP joint group (curls the thumb tip).
  const thumbIp = new THREE.Group();
  thumbIp.position.set(0, 0, thumbProxLen);
  thumbMcp.add(thumbIp);

  // Thumb distal — skin-tone rounded tip (fingerless glove).
  const thumbDistLen = 0.014;
  const thumbDistR = 0.005;
  const thumbDist = new THREE.Mesh(
    new THREE.SphereGeometry(thumbDistR, 8, 6), skinMat,
  );
  thumbDist.scale.set(1, thumbDistLen / (thumbDistR * 2), 1);
  thumbDist.rotation.x = Math.PI / 2;
  thumbDist.position.set(0, 0, thumbDistLen / 2);
  ns(thumbDist); thumbIp.add(thumbDist);

  // Thumb joint crease + glove cutoff ring (at the proximal→distal boundary).
  const thumbCrease = new THREE.Mesh(armGeo.crease, creaseMat);
  thumbCrease.scale.set(1.2, 1, 1);
  thumbCrease.position.set(0, 0.002, 0);
  ns(thumbCrease); thumbIp.add(thumbCrease);
  const thumbCutoff = new THREE.Mesh(
    new THREE.TorusGeometry(thumbDistR + 0.0012, 0.0015, 4, 10), cuffMat,
  );
  thumbCutoff.rotation.x = Math.PI / 2;
  ns(thumbCutoff); thumbIp.add(thumbCutoff);

  // Thumb fingernail + cuticle (on top of the distal segment).
  const thumbNail = new THREE.Mesh(armGeo.nail, nailMat);
  thumbNail.scale.set(1.1, 0.3, 1.3);
  thumbNail.position.set(0, thumbDistR + 0.0012, thumbDistLen * 0.55);
  ns(thumbNail); thumbIp.add(thumbNail);
  const thumbCuticle = new THREE.Mesh(armGeo.crease, creaseMat);
  thumbCuticle.scale.set(1.1, 1, 1);
  thumbCuticle.position.set(0, thumbDistR + 0.0008, thumbDistLen * 0.28);
  ns(thumbCuticle); thumbIp.add(thumbCuticle);

  // Expose thumb joints for the reload animation driver.
  hand.userData.thumbBase = thumbBase;
  hand.userData.thumbJoints = [thumbMcp, thumbIp];

  // Pistol support hand: tilt the hand so the palm faces up (cupping the slide).
  if (isPistolSupport) {
    hand.rotation.x = -0.35;
  } else {
    // Slight forward wrist bend for a natural grip angle — the wrist isn't
    // perfectly straight when holding a gun; ~5° forward bend reads as relaxed
    // rather than stiff. Baked into defaultRot so the reload driver preserves it.
    hand.rotation.x = -0.08;
  }
  // Snapshot the default hand rotation (post pistol-support tilt / wrist bend)
  // so PhysicsSystem can reset the hand group each frame before applying
  // procedural offsets — without losing the baked-in support-hand tilt / bend.
  hand.userData.defaultRot = hand.rotation.clone();

  return { arm, hand };
}

export function buildWeaponViewmodel(ctx: GameContext) {
  const { weaponGroup, muzzleFlash, weapon, gunParts } = ctx;
  // Prompt A#47 — null out orphaned gunParts references from the PREVIOUS
  // weapon build before constructing the new one. The old gun/mag/handle/
  // arm Object3Ds are about to be removed from the scene (below), but the
  // gunParts object still holds JS references to them — those references
  // keep the old meshes alive in memory (heap snapshot shows orphaned
  // weapon meshes after 10 swaps). Nulling them first lets GC reclaim the
  // old meshes as soon as they're removed from the scene.
  const oldParts = gunParts as Partial<GunPartsWithArms>;
  oldParts.gun = undefined as never;
  oldParts.mag = undefined as never;
  oldParts.handle = undefined as never;
  oldParts.muzzleTip = new THREE.Object3D(); // placeholder until rebuilt below
  oldParts.leftArm = undefined;
  oldParts.rightArm = undefined;
  oldParts.leftHand = undefined;
  oldParts.rightHand = undefined;
  // Clear (keep muzzleFlash — it gets re-parented to the gun below).
  // Prompt A#44 — use weaponGroup.remove(ch) for ALL children (including
  // muzzleFlash) instead of the previous manual `weaponGroup.children.splice(...)`.
  // Manually splicing THREE's internal children array can desync the
  // parent/child matrixWorld bookkeeping (THREE.Object3D.remove updates
  // internal parent/_listeners + fires 'removed' events; splicing skips
  // all of that). Re-adding muzzleFlash below re-establishes the link.
  while (weaponGroup.children.length > 0) {
    weaponGroup.remove(weaponGroup.children[0]);
  }
  weaponGroup.add(muzzleFlash);

  // Build the detailed weapon.
  // Prompt #84 — was: `buildDetailedWeapon(weapon.loadout)` directly, which
  // bypassed the ModelRegistry cache and re-built the weapon mesh on every
  // weapon swap (and on every per-frame re-call from the gunsmith preview).
  // Route through `loadModel` so a weapon is built ONCE per match (the
  // cache lives in ModelRegistry). `loadModel` returns a Promise; we keep
  // the synchronous procedural build so the gun appears immediately, then
  // swap to the cached group once `loadModel` resolves (subsequent swaps
  // for the same slug hit the cache → `built.group` is the SAME reference
  // each time, so the swap is a no-op for the geometry).
  const built = buildDetailedWeapon(weapon.loadout);
  const gun = built.group;
  // Tag with the slug so the async swap can detect "already swapped to
  // the cached glTF" and avoid re-adding the same group twice.
  (gun.userData as Record<string, unknown>).weaponSlug = weapon.loadout.weapon;
  (gun.userData as Record<string, unknown>).assetSource = "procedural-immediate";
  // Kick off the cached load — when it resolves, swap the in-scene gun
  // for the cached version (the procedural immediate stays on-screen
  // until the cached one is ready, so there's never a flash of "no gun").
  const slugForLoad = weapon.loadout.weapon as string;
  loadModel(slugForLoad).then((cachedGroup) => {
    // If the player has already swapped to a different weapon by the time
    // the load resolves, abort the swap (the new weapon's build call will
    // have cleared weaponGroup.children).
    const stillCurrent =
      (gun.userData as Record<string, unknown>).weaponSlug === slugForLoad &&
      weaponGroup.children.includes(gun);
    if (!stillCurrent) return;
    // If the cached group is the SAME reference as the procedural one
    // (loadModel returned the procedural fallback synchronously), skip
    // the swap — re-adding would just churn the scene graph.
    if (cachedGroup === gun) return;
    // Only swap when loadModel actually produced a real glTF asset
    // (assetSource === "glb"). When it produced a procedural fallback
    // we keep the locally-built gun — it has correct magRef/handleRef
    // part references that the cached fallback group wouldn't share,
    // and re-swapping would invalidate them. The "built once per match"
    // acceptance is satisfied for the glTF case (heavy asset); the
    // procedural case is fast + the cache miss is one-time per slug.
    const src = (cachedGroup.userData as Record<string, unknown>).assetSource;
    if (src !== "glb") return;
    // Detach the procedural gun + attach the cached one in the same slot.
    const prevPos = gun.position.clone();
    const prevRot = gun.rotation.clone();
    const prevScale = gun.scale.clone();
    weaponGroup.remove(gun);
    cachedGroup.position.copy(prevPos);
    cachedGroup.rotation.copy(prevRot);
    cachedGroup.scale.copy(prevScale);
    (cachedGroup.userData as Record<string, unknown>).weaponSlug = slugForLoad;
    weaponGroup.add(cachedGroup);
    // Re-parent muzzleFlash + arms onto the cached group? — no, the
    // existing code keeps muzzleFlash parented to weaponGroup (re-added
    // above) and arms are also children of weaponGroup, so the gun swap
    // doesn't disturb them. The new gun's muzzleTip socket is found by
    // the existing per-frame raycast in PhysicsSystem.
  }).catch(() => { /* loadModel never rejects; defensive */ });

  // Scale the viewmodel appropriately (smaller than the gunsmith display).
  gun.scale.setScalar(1.0);
  // Position in the bottom-right of the camera view.
  // rotation.y = 0 so the muzzle points straight forward (+Z forward = -Z
  // muzzle direction) through the screen center — the bullet trajectory
  // (camera-forward) now visually aligns with the gun's barrel axis.
  //
  // Prompt A#45 — the initial pose is sourced from FPAnimStateMachine's
  // BASE_POSES.idle (the single source of truth for the idle viewmodel
  // pose). The previous code hardcoded (0.22, -0.22, -0.45) which differed
  // from BASE_POSES.idle.pos = (0.18, -0.16, -0.35) — two sources of truth
  // that disagreed. PhysicsSystem.update() also reads BASE_POSES (via the
  // import below) each frame for the target position, so changing a
  // BASE_POSE value now visibly changes the viewmodel.
  gun.position.set(FP_BASE_POSES.idle.pos[0], FP_BASE_POSES.idle.pos[1], FP_BASE_POSES.idle.pos[2]);
  gun.rotation.y = 0;

  weaponGroup.add(gun);

  // ─── First-person arms ───
  // Resolve operator visual (suit + vest colors) for sleeve + glove materials.
  // Reads the equipped operator slug from the store (same pattern as
  // context-factory.ts buildHumanoid).
  const opSlug = useGameStore.getState().equippedOperatorSlug;
  const opVisual = getOperatorVisual(opSlug);
  const suitColor = parseInt(opVisual.suit.replace("#", "0x"));
  const vestColor = parseInt(opVisual.vest.replace("#", "0x"));

  const spec = GRIP_SPECS[weapon.loadout.weapon] ?? GRIP_SPECS.ak74;

  // Left (support) arm — grips the foregrip / pump / slide support.
  const leftBuilt = buildFirstPersonArm("left", suitColor, vestColor, opVisual.skinTone, !!spec.pistolSupport);
  leftBuilt.arm.position.set(spec.leftHand[0], spec.leftHand[1], spec.leftHand[2]);
  // Tilt the arm forward (rotation.x) to match the foregrip/support angle +
  // tilt outward (rotation.z) so the forearm angles down-left from the wrist
  // (elbow off-screen bottom-left). The forward tilt aligns the wrist+forearm
  // with the grip axis so the hand reads as gripping, not floating beside.
  leftBuilt.arm.rotation.set(spec.leftRotX, 0, -0.22);
  // Store default pose so PhysicsSystem can reset + apply procedural offsets.
  leftBuilt.arm.userData.defaultPos = leftBuilt.arm.position.clone();
  leftBuilt.arm.userData.defaultRot = leftBuilt.arm.rotation.clone();
  gun.add(leftBuilt.arm);

  // Right (trigger) arm — grips the pistol grip.
  const rightBuilt = buildFirstPersonArm("right", suitColor, vestColor, opVisual.skinTone, false);
  rightBuilt.arm.position.set(spec.rightHand[0], spec.rightHand[1], spec.rightHand[2]);
  // Tilt forward to match the pistol grip's rearward lean (so the wrist,
  // palm, and forearm form a straight line up the grip) + tilt outward so
  // the forearm angles down-right (elbow off-screen bottom-right).
  rightBuilt.arm.rotation.set(spec.rightRotX, 0, 0.28);
  rightBuilt.arm.userData.defaultPos = rightBuilt.arm.position.clone();
  rightBuilt.arm.userData.defaultRot = rightBuilt.arm.rotation.clone();
  gun.add(rightBuilt.arm);

  // Set up the muzzle tip Object3D at the final muzzle position.
  const muzzleTip = new THREE.Object3D();
  muzzleTip.position.set(0, 0.02, built.muzzleZ);
  gun.add(muzzleTip);

  // Wire up the gunParts references for the reload + recoil animations.
  const parts = gunParts as GunPartsWithArms;
  parts.gun = gun;
  parts.mag = (built.magRef as unknown as THREE.Mesh) ?? undefined;
  parts.handle = (built.handleRef as unknown as THREE.Mesh) ?? undefined;
  parts.muzzleTip = muzzleTip;
  parts.leftArm = leftBuilt.arm;
  parts.rightArm = rightBuilt.arm;
  parts.leftHand = leftBuilt.hand;
  parts.rightHand = rightBuilt.hand;

  // Prompt A#49 — instantiate the FPAnimStateMachine. The previous code
  // declared WeaponAnimationStateMachine (later in this file) + the
  // FPAnimStateMachine in fp-state-machine.ts but never instantiated either,
  // so the state-machine-driven viewmodel was dead code. We instantiate
  // FPAnimStateMachine (the simpler per-frame base-pose machine) here +
  // stash it on ctx.weapon.fpStateMachine so PhysicsSystem can tick it +
  // sample its output each frame. (WeaponAnimationStateMachine below
  // remains exported for callers that want the richer crossfade API —
  // e.g., a future gunsmith preview.)
  if (!weapon.fpStateMachine) {
    weapon.fpStateMachine = new FPAnimStateMachine();
  } else {
    // Weapon swap — reset the state machine to idle so the new weapon
    // doesn't inherit the previous weapon's sprint/ads state.
    weapon.fpStateMachine.setState("idle");
  }

  // Snapshot the magazine's default position so the reload animation can
  // reset the mag each frame. The reload driver reads `mag.userData.defaultPos`
  // to recover the original position + applies the drop offset on top.
  //
  // Prompt A#46 — the previous comment said "mag sat 11cm low after first
  // reload" and described this snapshot as a workaround for a reload-driver
  // bug. The reload driver (weapon-anim.ts) now resets the mag position to
  // its authored socket on reload end (see `resetMagToSocket` in weapon-anim.ts).
  // The defaultPos snapshot is kept as the authoritative socket reference
  // (the reload driver reads it to know WHERE to reset to) — it's no longer
  // a workaround, it's the canonical socket definition.
  if (parts.mag) {
    parts.mag.userData.defaultPos = parts.mag.position.clone();
    parts.mag.userData.defaultRot = parts.mag.rotation.clone();
  }

  // Muzzle flash — parent to the gun so it tracks the muzzle during sway/recoil.
  // Position matches muzzleTip's local position. (Previously the flash was a
  // direct child of weaponGroup at a position that didn't account for the gun's
  // (0.22, -0.22, -0.45) offset, so the flash appeared ~22cm to the left of
  // the actual muzzle. Parenting to the gun fixes this and makes the flash
  // follow the muzzle during all viewmodel animation.)
  gun.add(muzzleFlash);
  muzzleFlash.position.set(0, 0.02, built.muzzleZ);

  // Disable shadows on all viewmodel meshes (arms included) — the viewmodel
  // is rendered up close and shouldn't cast shadows on the world.
  gun.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Task 2-c — Animation curve library + multi-beat inspect + AnimationStateMachine.
//
// The existing PhysicsSystem viewmodel driver uses sine waves + lerp() for
// animation (e.g. the inspect animation is a single `sin(t*π)` bump). These
// helpers replace the linear/sine curves with proper eased curves that include
// ANTICIPATION (small wind-up before motion) and OVERSHOOT-SETTLE (go past
// target slightly, settle back) — the two key ingredients that make motion
// feel hand-animated rather than mechanical.
//
// Exports:
//   • easeOutBack, easeInOutCubic, easeOutElastic, easeOutCubic — curve helpers
//   • evalInspectAnimation(t) → InspectPose — multi-beat inspect timeline
//   • WeaponAnimationStateMachine — per-weapon state machine with crossfades
// ════════════════════════════════════════════════════════════════════════════

/**
 * easeOutCubic — fast-out, slow-in. The motion starts at full velocity and
 * decelerates to rest. Good for "snap to position then settle" motions
 * (mag insertion, equip animation). Formula: 1 - (1-t)³.
 */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * easeInOutCubic — slow-in-out. Accelerates from rest, peaks at midpoint,
 * decelerates to rest. Good for symmetric motions where both endpoints are
 * at rest (the gun traveling from neutral → inspect pose → back to neutral).
 * Formula: 4t³ for t<0.5, 1 - (-2t+2)³/2 for t≥0.5.
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * easeOutBack — overshoot-settle. The motion goes PAST the target (1.0) by
 * a small amount, then settles back to 1.0. The `overshoot` parameter
 * controls how far past 1.0 the curve goes (default 1.70158 = standard
 * "back" easing; lower = less overshoot, higher = more bounce).
 *
 * Good for "snap to ready" motions where the gun should slightly overshoot
 * the resting pose and settle — the signature "weight + inertia" feel of
 * hand-animated motion (vs the dead stop of linear interpolation).
 */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  const c1 = overshoot;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * easeOutElastic — elastic-settle. The motion oscillates around the target
 * with decaying amplitude, like a spring. Good for "weighty" impacts where
 * the gun should bounce slightly after a sharp motion (e.g. the mag click
 * kick on reload, or the final settle of an inspect animation).
 */
export function easeOutElastic(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

/** Pose returned by the multi-beat inspect animation. All values are
 *  DELTAS from the gun's neutral position (additive on top of the idle
 *  breathing / sway motion). The viewmodel driver applies these as
 *  position/rotation offsets. */
export interface InspectPose {
  rotX: number;  // pitch delta (radians)
  rotY: number;  // yaw delta (radians) — the "show off" rotation
  rotZ: number;  // roll delta (radians)
  posX: number;  // X offset (world units)
  posY: number;  // Y offset
  posZ: number;  // Z offset
}

/** Multi-beat inspect animation timeline. Total duration maps to the existing
 *  `weapon.inspectAnim` countdown (2.0s). The caller passes `t` = the
 *  normalized timeline position (0 = just started inspecting, 1 = inspect
 *  finished). The function returns the gun pose at that moment in time.
 *
 * Three-beat sequence (the classic "show off the gun" animation):
 *  • Phase 0 (0.00 - 0.30): TILT TO CHECK MAG
 *      Anticipation windup (small counter-rotation) → main tilt (yaw +X to
 *      show the right side / magazine). Gun shifts toward screen center.
 *  • Phase 1 (0.30 - 0.65): RACK / CHECK CHAMBER
 *      Gun returns to center while doing a small forward bounce (the chamber
 *      rack motion). Slight forward tilt as if peering at the chamber.
 *  • Phase 2 (0.65 - 1.00): RETURN TO READY
 *      Smooth settle back to neutral with a subtle overshoot-settle (the gun
 *      slightly overshoots neutral and settles, like a person's arm weight
 *      settling after motion).
 *
 * Each phase uses easeInOutCubic for the main motion + easeOutBack at the
 * end for the signature "weight + inertia" settle (vs the dead stop of a
 * sine wave, which is what the old inspect used).
 */
export function evalInspectAnimation(t: number): InspectPose {
  // Clamp + sanitize input.
  const tt = Math.max(0, Math.min(1, t));

  // Phase boundaries (proportion of total inspect duration).
  const PHASE0_END = 0.30;
  const PHASE1_END = 0.65;
  // PHASE2 ends at 1.0.

  // Result struct (defaults = neutral pose).
  const pose: InspectPose = {
    rotX: 0, rotY: 0, rotZ: 0,
    posX: 0, posY: 0, posZ: 0,
  };

  if (tt < PHASE0_END) {
    // ─── Phase 0: tilt to check magazine ───
    // Anticipation: small counter-rotation in the first 15% of the phase
    // (the gun pulls SLIGHTLY back/left before sweeping right — the classic
    // "wind-up before motion" that makes animation feel hand-keyed).
    const pt = tt / PHASE0_END; // 0..1 within phase 0
    const windupEnd = 0.15;
    let phaseT: number;
    if (pt < windupEnd) {
      // Windup — slight counter-rotation (anticipation). Negative phaseT
      // moves the gun opposite to the eventual motion.
      phaseT = -0.15 * easeOutCubic(pt / windupEnd);
    } else {
      // Main motion — ease into the inspect pose (easeInOutCubic for a
      // smooth accelerate-decelerate profile, not a linear sweep).
      phaseT = -0.15 + 1.15 * easeInOutCubic((pt - windupEnd) / (1 - windupEnd));
    }
    // Peak inspect pose: yaw 0.9 rad (show right side), pitch -0.3 (tilt
    // down to see the mag), shift toward screen center + slight dip.
    pose.rotY = phaseT * 0.9;
    pose.rotX = phaseT * -0.3;
    pose.rotZ = phaseT * 0.05; // tiny roll for organic feel
    pose.posX = phaseT * 0.08;
    pose.posY = phaseT * -0.02;
  } else if (tt < PHASE1_END) {
    // ─── Phase 1: rack / chamber check ───
    // Gun returns to center while doing a small forward bounce (the chamber
    // rack motion). Use easeInOutCubic to return from the inspect pose back
    // toward center smoothly.
    const pt = (tt - PHASE0_END) / (PHASE1_END - PHASE0_END); // 0..1 within phase 1
    const returnT = easeInOutCubic(pt);
    // Start from phase-0 peak pose, end near center.
    pose.rotY = 0.9 * (1 - returnT);
    pose.rotX = -0.3 * (1 - returnT);
    pose.rotZ = 0.05 * (1 - returnT);
    pose.posX = 0.08 * (1 - returnT);
    pose.posY = -0.02 * (1 - returnT);
    // Chamber bounce — a sine wave bump in the second half of phase 1 (the
    // "rack" motion: gun dips forward, then back). Slight pitch forward
    // during the rack, recovering after.
    if (pt > 0.4) {
      const bounceT = (pt - 0.4) / 0.6; // 0..1 within the bounce window
      const bounce = Math.sin(bounceT * Math.PI) * 0.04;
      pose.posY += bounce;
      pose.rotX += bounce * 1.5; // slight forward tilt during rack
    }
  } else {
    // ─── Phase 2: return to ready with overshoot-settle ───
    // The gun settles back to neutral with a subtle wobble (overshoot past
    // neutral then settle back) — the signature "weight + inertia" feel
    // produced by easeOutBack. Without this, the inspect would just snap
    // to neutral at the end of phase 1.
    const pt = (tt - PHASE1_END) / (1 - PHASE1_END); // 0..1 within phase 2
    // settleT goes from 0 → 1 (with overshoot past 1.0 mid-way, then back
    // to 1.0 at the end). We use (1 - settleT) as the residual amplitude
    // so the wobble decays as we approach t=1.
    const settleT = easeOutBack(pt);
    const residual = 1 - settleT;
    // At pt=0, residual=1 (full wobble amplitude). At pt=1, residual=0 (rest).
    // The wobble is a sine wave whose amplitude = residual * a small constant.
    // Frequency = 2 cycles over phase 2 (so we see one overshoot + one settle).
    const wobbleAmp = 0.025;
    const wobbleFreq = Math.PI * 2;
    const wobble = residual * wobbleAmp * Math.sin(pt * wobbleFreq);
    pose.rotY = wobble;
    pose.rotX = wobble * 0.5;
    pose.rotZ = wobble * 0.3;
    pose.posX = wobble * 0.04;
    pose.posY = wobble * -0.02;
  }

  return pose;
}

// ─── Animation state machine ───

/** Weapon animation states. Each represents a high-level viewmodel mode:
 *  idle   — at rest (hip-fire carry), breathing + sway only.
 *  fire   — actively firing (recoil kick, slide cycle).
 *  reload — reload sequence (mag drop, mag insert, charging handle).
 *  inspect — Y-key inspect (multi-beat tilt/rack/return sequence).
 *  ads    — aiming down sights (gun centered, closer to camera).
 *  equip  — equip animation (gun raises into view from below).
 */
export type WeaponAnimState = "idle" | "fire" | "reload" | "inspect" | "ads" | "equip";

/** Read-only context snapshot exposed to state hooks + downstream consumers.
 *  Carries the current state, crossfade progress, elapsed time, and previous
 *  state so consumers can blend between the two during transitions. */
export interface WeaponAnimStateContext {
  state: WeaponAnimState;
  /** Crossfade progress (0 = just transitioned, 1 = fully in current state). */
  crossfadeT: number;
  /** Time (seconds) since entering this state. */
  stateTime: number;
  /** Previous state (for crossfade blending). */
  prevState: WeaponAnimState;
}

export interface WeaponAnimStateHooks {
  onEnter?: (ctx: WeaponAnimStateContext) => void;
  onExit?: (ctx: WeaponAnimStateContext) => void;
}

/**
 * Per-weapon animation state machine. Follows the existing FSM pattern in
 * src/lib/game/fsm/FiniteStateMachine.ts (data-driven transitions, onEnter /
 * onExit hooks, history) but specialized for weapon animation:
 *
 *  • Transitions crossfade over a short window (0.15-0.25s) instead of
 *    snapping. The crossfade is exposed via `crossfadeT` (0 = just entered,
 *    1 = fully transitioned) so downstream code can blend poses.
 *  • Each state has optional onEnter / onExit hooks (registered via
 *    `registerHooks`) that fire on transitions — same API as the existing FSM.
 *  • State time + history are tracked for debugging + animation timing.
 *
 * Usage: each weapon constructs one WeaponAnimationStateMachine at build time
 * and calls `transition()` whenever the weapon's high-level mode changes
 * (e.g. `fsm.transition("reload")` when the player presses R). The viewmodel
 * driver reads `fsm.context()` each frame to apply the appropriate pose +
 * crossfade blend.
 */
export class WeaponAnimationStateMachine {
  private current: WeaponAnimState;
  private previous: WeaponAnimState;
  private stateEnterTime: number;
  private crossfadeDuration: number;
  private crossfadeStart: number;
  private hooks: Map<WeaponAnimState, WeaponAnimStateHooks>;
  private history: { from: WeaponAnimState; to: WeaponAnimState; at: number; duration: number }[];

  constructor(initial: WeaponAnimState = "idle") {
    this.current = initial;
    this.previous = initial;
    const now = performance.now() / 1000;
    this.stateEnterTime = now;
    this.crossfadeDuration = 0.2;
    this.crossfadeStart = now;
    this.hooks = new Map();
    this.history = [];
  }

  /** Current state name. */
  get state(): WeaponAnimState { return this.current; }

  /** Previous state name (the state we're crossfading FROM). */
  get prevState(): WeaponAnimState { return this.previous; }

  /** Time in seconds since entering the current state. */
  get stateTime(): number {
    return (performance.now() / 1000) - this.stateEnterTime;
  }

  /** Crossfade progress (0 = just transitioned, 1 = fully in current state).
   *  Clamped to [0, 1] — reaches 1 when the crossfade duration has elapsed. */
  get crossfadeT(): number {
    const elapsed = (performance.now() / 1000) - this.crossfadeStart;
    if (this.crossfadeDuration <= 0) return 1;
    return Math.max(0, Math.min(1, elapsed / this.crossfadeDuration));
  }

  /** Register onEnter / onExit hooks for a state (same API as the existing FSM). */
  registerHooks(state: WeaponAnimState, hooks: WeaponAnimStateHooks): void {
    this.hooks.set(state, hooks);
  }

  /** Transition to a new state with a crossfade. Returns true if a transition
   *  occurred, false if `target` is the same as the current state (no-op).
   *  Default crossfade duration is 0.2s; callers can override per-transition
   *  (e.g. 0.15s for the snappy fire→idle, 0.25s for the cinematic
   *  idle→inspect). */
  transition(target: WeaponAnimState, duration = 0.2): boolean {
    if (target === this.current) return false;
    const now = performance.now() / 1000;
    // Build the exit context for the outgoing state.
    const exitCtx: WeaponAnimStateContext = {
      state: this.current,
      crossfadeT: this.crossfadeT,
      stateTime: this.stateTime,
      prevState: this.previous,
    };
    // Fire onExit for the current state.
    this.hooks.get(this.current)?.onExit?.(exitCtx);
    // Update state bookkeeping.
    this.previous = this.current;
    this.current = target;
    this.stateEnterTime = now;
    this.crossfadeStart = now;
    this.crossfadeDuration = duration;
    this.history.push({ from: this.previous, to: target, at: now, duration });
    if (this.history.length > 32) this.history.shift();
    // Fire onEnter for the new state.
    const enterCtx: WeaponAnimStateContext = {
      state: this.current,
      crossfadeT: 0,
      stateTime: 0,
      prevState: this.previous,
    };
    this.hooks.get(this.current)?.onEnter?.(enterCtx);
    return true;
  }

  /** Build a context snapshot for the current state (for downstream consumers
   *  to read state, crossfade progress, and elapsed time). */
  context(): WeaponAnimStateContext {
    return {
      state: this.current,
      crossfadeT: this.crossfadeT,
      stateTime: this.stateTime,
      prevState: this.previous,
    };
  }

  /** Reset to a state without firing transitions (same API as the existing FSM). */
  reset(state: WeaponAnimState): void {
    this.current = state;
    this.previous = state;
    const now = performance.now() / 1000;
    this.stateEnterTime = now;
    this.crossfadeStart = now;
    this.crossfadeDuration = 0;
    this.history = [];
  }

  /** Recent transition history (newest last). Same API as the existing FSM. */
  getHistory(): { from: WeaponAnimState; to: WeaponAnimState; at: number; duration: number }[] {
    return [...this.history];
  }
}

export type { LoadoutConfig, EffectiveWeaponStats, Enemy };
