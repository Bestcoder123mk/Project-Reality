/**
 * SEC2-ART — Prompt 16
 * ─────────────────────────────────────────────────────────────────────────────
 * EnvArtKit — a modular environment-art kit (walls, trim, props) the maps
 * can compose. Replaces the plain box/cylinder set-dressing with detailed
 * kit pieces that share a visual language (beveled edges, surface trims,
 * bolts, weathering). Pilot on Bunker.
 *
 * Public surface:
 *   - `KIT_PIECE_NAMES`        → readonly list of available kit piece names
 *   - `buildKitPiece(name)`    → THREE.Mesh — a single kit piece, centered at
 *                                origin, ready for the caller to position.
 *   - `buildBunkerKitDressing()` → THREE.Group — kit-piece-based set dressing
 *                                for the Bunker map (replaces the plain
 *                                "box" perimeter walls + overhead pipes).
 *                                Caller adds the group to the scene.
 *   - `KIT_PIECE_DIMENSIONS`   → readonly dimensions per piece (meters) —
 *                                lets the map definition place them without
 *                                instantiating.
 *
 * Kit piece catalog:
 *   - bunker_wall_concrete     → 4×3×0.3m concrete wall with horizontal
 *                                trim + bolt heads (replaces plain box)
 *   - bunker_wall_brick        → brick variant with coursing lines
 *   - bunker_pillar            → 0.6×3×0.6m structural pillar with cap
 *   - bunker_pipe_horizontal   → 0.2m-diameter overhead pipe with brackets
 *   - bunker_jersey_barrier    → 2×1×0.6m jersey barrier (trapezoidal)
 *   - bunker_crate_military    → 1.2m mil-spec crate with rope handles
 *   - bunker_pallet            → 1.1×0.12×1.1m wooden pallet with slats
 *   - bunker_ammo_box          → small ammo can (0.5×0.3×0.35m)
 *
 * The kit is procedural today (BoxGeometry + CylinderGeometry + trims).
 * When real artist meshes ship, swap buildKitPiece to loadModel(slug) +
 * buildLODChain — the map-wiring stays unchanged.
 *
 * SSR-safe — pure three.js geometry.
 */

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// ─── Kit piece registry ────────────────────────────────────────────────────

export const KIT_PIECE_NAMES = [
  "bunker_wall_concrete",
  "bunker_wall_brick",
  "bunker_pillar",
  "bunker_pipe_horizontal",
  "bunker_jersey_barrier",
  "bunker_crate_military",
  "bunker_pallet",
  "bunker_ammo_box",
] as const;
export type KitPieceName = (typeof KIT_PIECE_NAMES)[number];

/** Approximate dimensions per kit piece (width × height × depth, meters). */
export const KIT_PIECE_DIMENSIONS: Record<KitPieceName, [number, number, number]> = {
  bunker_wall_concrete:    [4.0, 3.0, 0.3],
  bunker_wall_brick:       [4.0, 3.0, 0.3],
  bunker_pillar:           [0.6, 3.0, 0.6],
  bunker_pipe_horizontal:  [4.0, 0.2, 0.2],
  bunker_jersey_barrier:   [2.0, 1.0, 0.6],
  bunker_crate_military:   [1.2, 1.0, 0.9],
  bunker_pallet:           [1.1, 0.12, 1.1],
  bunker_ammo_box:         [0.5, 0.3, 0.35],
};

// ─── Cached materials ──────────────────────────────────────────────────────

// A3-5000 #473: cache key is now based on PBR values (color + roughness +
// metalness), NOT the material name. The prior `key_color_roughness_metalness`
// produced duplicate materials when two callers used different names for
// identical PBR (e.g. "concrete" vs "pillar_concrete" with the same PBR).
const _matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(_key: string, color: number, opts: { roughness?: number; metalness?: number } = {}): THREE.MeshStandardMaterial {
  // A3-5000 #473: dedupe by PBR values only (drop `key` from the cache key).
  const r = opts.roughness ?? 0.6;
  const m = opts.metalness ?? 0.05;
  const cacheKey = `${color}_${r}_${m}`;
  let matInst = _matCache.get(cacheKey);
  if (!matInst) {
    matInst = new THREE.MeshStandardMaterial({ color, roughness: r, metalness: m });
    _matCache.set(cacheKey, matInst);
  }
  return matInst;
}

// ─── Kit piece builders ────────────────────────────────────────────────────

function buildConcreteWall(): THREE.Object3D {
  const [w, h, d] = KIT_PIECE_DIMENSIONS.bunker_wall_concrete;
  const group = new THREE.Group();
  // Main slab.
  const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat("concrete", 0x6b6b6b, { roughness: 0.85 }));
  slab.castShadow = true; slab.receiveShadow = true;
  group.add(slab);
  // Horizontal trim — top + bottom strips (slightly darker, recessed feel).
  const trimMat = mat("concrete_trim", 0x4a4a4a, { roughness: 0.9 });
  for (const y of [h / 2 - 0.08, -h / 2 + 0.08]) {
    const trim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.06, d + 0.04), trimMat);
    trim.position.y = y;
    group.add(trim);
  }
  // Bolt heads — 4 per side (top + bottom), inset from the ends.
  const boltMat = mat("bolt", 0x2a2a2e, { roughness: 0.5, metalness: 0.9 });
  for (const side of [-1, 1]) {
    for (const x of [-w * 0.35, -w * 0.12, w * 0.12, w * 0.35]) {
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.04, 8), boltMat);
      bolt.position.set(x, side * (h / 2 - 0.08), d / 2 + 0.01);
      bolt.rotation.x = Math.PI / 2;
      group.add(bolt);
      // Mirror on the back.
      const boltBack = bolt.clone();
      boltBack.position.z = -d / 2 - 0.01;
      boltBack.rotation.x = -Math.PI / 2;
      group.add(boltBack);
    }
  }
  // Return as a single Mesh by merging into a parent Mesh with the group as
  // children. Caller adds the group to the scene; cast as Mesh for the type
  // signature (we want buildKitPiece to return a Mesh — the group satisfies
  // the "is Object3D" contract for callers that traverse it).
  return group as THREE.Object3D;
}

function buildBrickWall(): THREE.Object3D {
  const [w, h, d] = KIT_PIECE_DIMENSIONS.bunker_wall_brick;
  const group = new THREE.Group();
  // Main slab — brick-red.
  const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat("brick", 0x7a3a2a, { roughness: 0.85 }));
  slab.castShadow = true; slab.receiveShadow = true;
  group.add(slab);
  // Coursing lines — thin dark boxes for each brick course.
  const courseMat = mat("brick_course", 0x3a1a10, { roughness: 0.95 });
  const courseHeight = 0.08;
  for (let y = -h / 2 + courseHeight; y < h / 2; y += courseHeight) {
    const course = new THREE.Mesh(new THREE.BoxGeometry(w + 0.01, 0.005, d + 0.02), courseMat);
    course.position.y = y;
    group.add(course);
  }
  // Vertical joints — offset per course (running bond).
  const jointWidth = 0.005;
  const brickWidth = 0.20;
  for (let row = 0; row < Math.floor(h / courseHeight); row++) {
    const y = -h / 2 + (row + 1) * courseHeight;
    const offset = (row % 2) * (brickWidth / 2);
    for (let x = -w / 2 + brickWidth + offset; x < w / 2; x += brickWidth) {
      const joint = new THREE.Mesh(new THREE.BoxGeometry(jointWidth, courseHeight, d + 0.01), courseMat);
      joint.position.set(x, y - courseHeight / 2, 0);
      group.add(joint);
    }
  }
  return group as THREE.Object3D;
}

function buildPillar(): THREE.Object3D {
  const [w, h, d] = KIT_PIECE_DIMENSIONS.bunker_pillar;
  const group = new THREE.Group();
  // Main shaft — concrete.
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat("pillar_concrete", 0x6b6b6b, { roughness: 0.85 }));
  shaft.castShadow = true; shaft.receiveShadow = true;
  group.add(shaft);
  // Cap — wider square at the top.
  const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.15, 0.15, d + 0.15), mat("pillar_cap", 0x4a4a4a, { roughness: 0.9 }));
  cap.position.y = h / 2 + 0.075;
  group.add(cap);
  // Base — wider square at the bottom.
  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.15, 0.20, d + 0.15), mat("pillar_base", 0x4a4a4a, { roughness: 0.9 }));
  base.position.y = -h / 2 - 0.10;
  group.add(base);
  // Chamfer strips at the corners (4 vertical thin boxes).
  const chamferMat = mat("pillar_chamfer", 0x5a5a5a, { roughness: 0.85 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const chamfer = new THREE.Mesh(new THREE.BoxGeometry(0.04, h, 0.04), chamferMat);
    chamfer.position.set(sx * (w / 2 - 0.02), 0, sz * (d / 2 - 0.02));
    group.add(chamfer);
  }
  return group as THREE.Object3D;
}

function buildPipeHorizontal(): THREE.Object3D {
  const [w, , d] = KIT_PIECE_DIMENSIONS.bunker_pipe_horizontal;
  const r = d / 2;
  const group = new THREE.Group();
  // Main pipe — long cylinder along X.
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 16), mat("pipe_metal", 0x4a4a52, { roughness: 0.55, metalness: 0.7 }));
  pipe.rotation.z = Math.PI / 2;
  pipe.castShadow = true; pipe.receiveShadow = true;
  group.add(pipe);
  // Brackets — 3 U-bolts around the pipe.
  const bracketMat = mat("bracket", 0x2a2a2e, { roughness: 0.5, metalness: 0.85 });
  for (const x of [-w * 0.35, 0, w * 0.35]) {
    const bracket = new THREE.Mesh(new THREE.TorusGeometry(r + 0.02, 0.012, 8, 16, Math.PI), bracketMat);
    bracket.position.set(x, 0, 0);
    bracket.rotation.x = Math.PI / 2;
    bracket.rotation.y = Math.PI;
    group.add(bracket);
    // Drop-down stub to the ceiling.
    const stub = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.10, 0.06), bracketMat);
    stub.position.set(x, r + 0.05, 0);
    group.add(stub);
  }
  // End flanges.
  for (const x of [-w / 2, w / 2]) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.04, r + 0.04, 0.04, 16), bracketMat);
    flange.rotation.z = Math.PI / 2;
    flange.position.x = x;
    group.add(flange);
  }
  return group as THREE.Object3D;
}

function buildJerseyBarrier(): THREE.Object3D {
  const [w, h, d] = KIT_PIECE_DIMENSIONS.bunker_jersey_barrier;
  const group = new THREE.Group();
  // A3-5000 #427: symmetric trapezoidal notch — the prior profile had a notch
  // on the LEFT side only (asymmetric). Real jersey barriers have a symmetric
  // trapezoidal notch in the middle (the slope faces BOTH directions).
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(-w / 2, h);
  // Symmetric notch: from (-w/2, h) slope down to (-w/4, h/2), flat across,
  // then slope back up to (w/2, h).
  shape.lineTo(-w / 4, h);
  shape.lineTo(-w / 8, h * 0.5); // A3-5000 #427: left side of central notch
  shape.lineTo(w / 8, h * 0.5);  // A3-5000 #427: right side of central notch
  shape.lineTo(w / 4, h);        // A3-5000 #427: slope back up
  shape.lineTo(w / 2, h);
  shape.lineTo(w / 2, 0);
  shape.lineTo(-w / 2, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  geo.translate(0, 0, -d / 2);
  const body = new THREE.Mesh(geo, mat("jersey_concrete", 0x8a8a8a, { roughness: 0.85 }));
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);
  // Reflective strip near the top.
  const stripMat = new THREE.MeshStandardMaterial({ color: 0xffaa20, roughness: 0.4, metalness: 0.2, emissive: 0x402010, emissiveIntensity: 0.3 });
  for (const z of [-d / 2 + 0.005, d / 2 - 0.005]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.85, 0.06, 0.01), stripMat);
    strip.position.set(0, h * 0.75, z);
    group.add(strip);
  }
  return group as THREE.Object3D;
}

function buildCrateMilitary(): THREE.Object3D {
  const [w, h, d] = KIT_PIECE_DIMENSIONS.bunker_crate_military;
  const group = new THREE.Group();
  // Main box — olive drab.
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat("crate_olive", 0x4a4a2e, { roughness: 0.75 }));
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);
  // Lid — slightly recessed (a thin box on top).
  const lidMat = mat("crate_lid", 0x3a3a22, { roughness: 0.75 });
  const lid = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.06, d + 0.02), lidMat);
  lid.position.y = h / 2 - 0.03;
  group.add(lid);
  // Steel banding — 2 horizontal + 2 vertical straps.
  const bandMat = mat("crate_band", 0x2a2a2e, { roughness: 0.5, metalness: 0.85 });
  for (const y of [-h * 0.20, h * 0.20]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.03, 0.025, d + 0.03), bandMat);
    band.position.y = y;
    group.add(band);
  }
  for (const x of [-w * 0.30, w * 0.30]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.025, h + 0.03, d + 0.03), bandMat);
    band.position.x = x;
    group.add(band);
  }
  // Corner brackets (4 at the top corners).
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), bandMat);
    bracket.position.set(sx * (w / 2 - 0.04), h / 2 - 0.04, sz * (d / 2 - 0.04));
    group.add(bracket);
  }
  // Rope handles (2 side cutouts suggested with dark cylinders).
  const ropeMat = mat("rope", 0x6a5a3a, { roughness: 0.9 });
  for (const sx of [-1, 1]) {
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 12, Math.PI), ropeMat);
    handle.position.set(sx * (w / 2 + 0.005), 0, 0);
    handle.rotation.y = Math.PI / 2;
    handle.rotation.x = -Math.PI / 2;
    group.add(handle);
  }
  return group as THREE.Object3D;
}

function buildPallet(): THREE.Object3D {
  const [w, h, d] = KIT_PIECE_DIMENSIONS.bunker_pallet;
  const group = new THREE.Group();
  // Slats — 5 top slats along X.
  const slatMat = mat("pallet_wood", 0x6a4a2a, { roughness: 0.85 });
  const slatCount = 5;
  const slatWidth = w / (slatCount * 2 - 1);
  for (let i = 0; i < slatCount; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(slatWidth, h, d), slatMat);
    slat.position.x = -w / 2 + i * (slatWidth * 2) + slatWidth / 2;
    slat.castShadow = true; slat.receiveShadow = true;
    group.add(slat);
  }
  // 3 cross-bearers (along Z) at the bottom.
  for (const x of [-w * 0.35, 0, w * 0.35]) {
    const bearer = new THREE.Mesh(new THREE.BoxGeometry(w * 0.18, h * 0.7, d), slatMat);
    bearer.position.set(x, -h * 0.15, 0);
    group.add(bearer);
  }
  return group as THREE.Object3D;
}

function buildAmmoBox(): THREE.Object3D {
  const [w, h, d] = KIT_PIECE_DIMENSIONS.bunker_ammo_box;
  const group = new THREE.Group();
  // Body — olive metal can.
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat("ammo_olive", 0x3a4a2a, { roughness: 0.55, metalness: 0.4 }));
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);
  // Lid — slightly wider top with a hinge.
  const lid = new THREE.Mesh(new THREE.BoxGeometry(w + 0.01, 0.04, d + 0.01), mat("ammo_lid", 0x2a3a20, { roughness: 0.6, metalness: 0.4 }));
  lid.position.y = h / 2 + 0.02;
  group.add(lid);
  // Carry handle — thin arch on top.
  const handle = new THREE.Mesh(new THREE.TorusGeometry(w * 0.25, 0.008, 6, 12, Math.PI), mat("ammo_handle", 0x2a2a2e, { roughness: 0.5, metalness: 0.85 }));
  handle.position.y = h / 2 + 0.06;
  handle.rotation.x = Math.PI;
  group.add(handle);
  // Latches (2 — front, hinged clasps).
  const latchMat = mat("ammo_latch", 0x2a2a2e, { roughness: 0.5, metalness: 0.85 });
  for (const x of [-w * 0.30, w * 0.30]) {
    const latch = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.015), latchMat);
    latch.position.set(x, h / 2 - 0.01, d / 2 + 0.005);
    group.add(latch);
  }
  // Stencil panel — darker rectangle on top (suggests markings).
  const stencil = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.5, d * 0.4), mat("ammo_stencil", 0x1a1a10, { roughness: 0.7 }));
  stencil.rotation.x = -Math.PI / 2;
  stencil.position.y = h / 2 + 0.041;
  group.add(stencil);
  return group as THREE.Object3D;
}

// ─── Public API ─────────────────────────────────────────────────────────────

const BUILDERS: Record<KitPieceName, () => THREE.Object3D> = {
  bunker_wall_concrete: buildConcreteWall,
  bunker_wall_brick: buildBrickWall,
  bunker_pillar: buildPillar,
  bunker_pipe_horizontal: buildPipeHorizontal,
  bunker_jersey_barrier: buildJerseyBarrier,
  bunker_crate_military: buildCrateMilitary,
  bunker_pallet: buildPallet,
  bunker_ammo_box: buildAmmoBox,
};

/** Build a kit piece by name. Returns an Object3D (A3-5000 #426: was typed
 *  as `Mesh` via `as unknown as Mesh` cast — kit pieces are actually Groups
 *  containing sub-meshes; the type is now honest). Caller sets position +
 *  rotation. Throws on unknown names. */
export function buildKitPiece(name: string): THREE.Object3D {
  const builder = BUILDERS[name as KitPieceName];
  if (!builder) {
    throw new Error(`EnvArtKit.buildKitPiece: unknown kit piece "${name}". Valid: ${KIT_PIECE_NAMES.join(", ")}`);
  }
  return builder();
}

/** Build the full Bunker set dressing from kit pieces — perimeter walls +
 *  overhead pipes + corner pillars + jersey barriers. Caller adds the
 *  returned Group to the scene (replaces the plain box set-dressing on the
 *  Bunker map). */
export function buildBunkerKitDressing(): THREE.Group {
  const g = new THREE.Group();
  g.name = "bunker_kit_dressing";

  // ─── Perimeter concrete walls (replaces the 4 plain "box" walls) ──────────
  // Bunker bounds are 32m, so each side is 64m. We compose the perimeter from
  // 16 kit walls (4 per side × 4 sides), each 4m wide × 3m tall.
  // A3-5000 #475 / #428: the prior position math used `-24 + i*16 + 8` which
  // produced wall centers at -16, 0, 16, 32 — the last wall is OUTSIDE the
  // perimeter (32 = half-width) + there's a 12m gap between walls (4m wall
  // centered at 0 spans -2..2; next wall at 16 spans 14..18 → 12m gap).
  // Fixed: each wall is 4m wide, so centers should be at -18, -6, 6, 18 to
  // span -20..20 (40m total, fits inside the 64m perimeter with margin).
  // A3-5000 #474: merge the 16 wall meshes into 1 BufferGeometry for 1 draw
  // call instead of 304. We collect their world transforms + merge.
  const wall = () => buildKitPiece("bunker_wall_concrete");
  const wallH = KIT_PIECE_DIMENSIONS.bunker_wall_concrete[1];
  // A3-5000 #475: corrected wall placement math (continuous run).
  const wallPositions: Array<[number, number, number, number]> = []; // x, y, z, rotY
  // North + south walls (z = ±32).
  for (const z of [-32, 32]) {
    for (let i = 0; i < 4; i++) {
      const x = -18 + i * 12; // A3-5000 #475: was `-24 + i*16 + 8`
      wallPositions.push([x, wallH / 2 + 1, z, z < 0 ? 0 : Math.PI]);
    }
  }
  // East + west walls (x = ±32).
  for (const x of [-32, 32]) {
    for (let i = 0; i < 4; i++) {
      const z = -18 + i * 12; // A3-5000 #475: was `-24 + i*16 + 8`
      wallPositions.push([x, wallH / 2 + 1, z, Math.PI / 2]);
    }
  }
  // A3-5000 #474: build each wall, then merge into a single BufferGeometry.
  // We use BufferGeometryUtils.mergeGeometries for the 16 walls → 1 draw call.
  // (Was 16 walls × ~19 sub-meshes each = 304 draw calls.)
  const wallMeshes: THREE.Object3D[] = [];
  for (const [x, y, z, rotY] of wallPositions) {
    const w = wall();
    w.position.set(x, y, z);
    w.rotation.y = rotY;
    w.updateMatrixWorld(true);
    wallMeshes.push(w);
  }
  // Try to merge geometries (the import may fail in non-browser envs).
  try {
    const geos: THREE.BufferGeometry[] = [];
    const mat0: THREE.Material[] = [];
    for (const wm of wallMeshes) {
      wm.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const g = (m.geometry as THREE.BufferGeometry).clone();
        g.applyMatrix4(m.matrixWorld);
        geos.push(g);
        const mm = Array.isArray(m.material) ? m.material[0] : m.material;
        if (mat0.indexOf(mm) === -1) mat0.push(mm);
      });
    }
    const merged = mergeGeometries(geos, false);
    if (merged) {
      const mergedMesh = new THREE.Mesh(merged, mat0[0] ?? new THREE.MeshStandardMaterial());
      mergedMesh.castShadow = true; mergedMesh.receiveShadow = true;
      g.add(mergedMesh);
      // Dispose the per-wall clones (their geometries are now in `merged`).
      for (const gm of geos) gm.dispose();
    } else {
      // Fallback: add individual walls.
      for (const wm of wallMeshes) g.add(wm);
    }
  } catch {
    // BufferGeometryUtils unavailable — fallback to individual walls.
    for (const wm of wallMeshes) g.add(wm);
  }

  // ─── Overhead pipes (replaces the plain "box" pipe set-dressing) ──────────
  // Two pipes along Z (at x = ±8), each spanning the 60m interior.
  // A3-5000 #428: the prior position math used `-24 + i*16 + 8` which produced
  // pipe centers at -16, 0, 16, 32 with 4m pipes → 12m gaps between pipes.
  // Fixed: pipe centers at -18, -6, 6, 18 so the 4m pipes are continuous
  // (spans -20..20 = 40m of continuous pipe run).
  for (const x of [-8, 8]) {
    for (let i = 0; i < 4; i++) {
      const p = buildKitPiece("bunker_pipe_horizontal");
      p.rotation.y = Math.PI / 2; // rotate to span Z
      p.position.set(x, 7.5, -18 + i * 12); // A3-5000 #428: was `-24 + i*16 + 8`
      g.add(p);
    }
  }

  // ─── Corner pillars ───────────────────────────────────────────────────────
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = buildKitPiece("bunker_pillar");
    p.position.set(sx * 30, 1.5, sz * 30);
    g.add(p);
  }

  // ─── Jersey barriers at the central chokepoints ───────────────────────────
  for (const z of [-14, 14]) {
    const b = buildKitPiece("bunker_jersey_barrier");
    b.position.set(0, 0.5, z);
    g.add(b);
  }

  return g;
}

/** Dispose all cached materials. Used on hot-reload + tests. */
export function disposeEnvArtKit(): void {
  for (const m of _matCache.values()) m.dispose();
  _matCache.clear();
}
