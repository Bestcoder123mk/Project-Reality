import * as THREE from "three";
import type { MapProp, MapDefinition } from "../MapRegistry";
import type { Collider, DestructibleProp } from "../../systems/types";
import { SURFACE_MATERIAL_MAP } from "../../realism";
import type { BuildContext, MaterialTag } from "./_shared";
import {
  NO_RAYCAST,
  tagMesh,
  markCollider,
  noRaycast,
  addBox,
  addCyl,
  addSphere,
  addMesh,
  registerDestructible,
  registerGroupCollider,
  registerTaggedColliders,
} from "./_shared";
import { mergeGeometries, mulberry32, hashString } from "./geometry";

/** Build a single prop (dispatches to legacy or new builder). */
export function buildProp(prop: MapProp, bctx: BuildContext): THREE.Object3D | null {
  // Legacy types — kept verbatim for backward compat.
  switch (prop.type) {
    case "box": {
      const mat = bctx.matCache.getMaterial(prop.material ?? "concrete");
      const size = prop.size ?? [1, 1, 1];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
      mesh.position.set(prop.position[0], prop.position[1], prop.position[2]);
      mesh.rotation.y = prop.rotY ?? 0;
      const surface = prop.surfaceType ?? "concrete";
      tagMesh(mesh, surface, SURFACE_MATERIAL_MAP[surface] ?? "concrete");
      bctx.scene.add(mesh);
      bctx.colliders.push({ box: new THREE.Box3().setFromObject(mesh) });
      return mesh;
    }
    case "cylinder": {
      const mat = bctx.matCache.getMaterial(prop.material ?? "metal");
      const size = prop.size ?? [0.5, 1, 0.5];
      const geo = new THREE.CylinderGeometry(size[0], size[0], size[1], 16);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(prop.position[0], prop.position[1], prop.position[2]);
      const surface = prop.surfaceType ?? "metal";
      tagMesh(mesh, surface, SURFACE_MATERIAL_MAP[surface] ?? "metal");
      bctx.scene.add(mesh);
      bctx.colliders.push({ box: new THREE.Box3().setFromObject(mesh) });
      return mesh;
    }
    case "destructible": {
      const mat = bctx.matCache.getMaterial(prop.material ?? "wood");
      const size = prop.size ?? [1, 1, 1];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
      mesh.position.set(prop.position[0], prop.position[1], prop.position[2]);
      mesh.rotation.y = prop.rotY ?? 0;
      registerDestructible(bctx, mesh, prop.destructibleHp ?? 80, prop.materialSlug ?? "wood", prop.surfaceType ?? "crate");
      return mesh;
    }
  }

  // New tactical prop types.
  const [x, y, z] = prop.position;
  const rotY = prop.rotY ?? 0;
  const color = prop.color;
  const size = prop.size;

  switch (prop.type) {
    case "crate":
      return buildMilitaryCrate(bctx, x, y, z, size?.[0] ?? 1.2, color ?? 0x4a4a2e, rotY);
    case "ammo_box":
      return buildAmmoBox(bctx, x, y, z, rotY);
    case "sandbag_bunker":
      return buildSandbagBunker(bctx, x, y, z, rotY);
    case "barrier":
      return buildConcreteBarrier(bctx, x, y, z, rotY);
    case "hesco":
      return buildHescoBastion(bctx, x, y, z, rotY);
    case "container":
      return buildShippingContainer(bctx, x, y, z, rotY, color ?? 0xa83828);
    case "barrel":
      return buildOilBarrel(bctx, x, y, z, color ?? 0xb33a2a);
    case "pallet":
      return buildPallet(bctx, x, y, z, rotY);
    case "generator":
      return buildGenerator(bctx, x, y, z, rotY);
    case "sandbag_wall":
      return buildSandbagWall(bctx, x, y, z, prop.length ?? 4, rotY);
    case "barricade":
      return buildBarricade(bctx, x, y, z, rotY);
    case "dumpster":
      return buildDumpster(bctx, x, y, z, rotY);
    case "crate_stack":
      return buildCrateStack(bctx, x, y, z);
    case "building":
      return buildBuilding(bctx, {
        x, y, z, rotY,
        width: size?.[0] ?? 8,
        height: size?.[1] ?? 4,
        depth: size?.[2] ?? 8,
        wallMaterial: (prop.material === "metal" ? "metal" : prop.material === "concrete" ? "concrete" : "brick") as "brick" | "concrete" | "metal",
        doorSide: prop.doorSide ?? "south",
        windowsPerWall: prop.windowsPerWall ?? 2,
        color,
      });
    case "ac_unit":
      return buildAcUnit(bctx, x, y, z, rotY);
    case "water_tank":
      return buildWaterTank(bctx, x, y, z);
    case "satellite":
      return buildSatellite(bctx, x, y, z, rotY);
    case "tent":
      return buildTent(bctx, x, y, z, rotY, color);
    case "fuel_bladder":
      return buildFuelBladder(bctx, x, y, z, rotY);
    case "comms_tower":
      return buildCommsTower(bctx, x, y, z);
    case "car":
      return buildCar(bctx, x, y, z, rotY, color ?? 0x3a2a25);
    case "phone_booth":
      return buildPhoneBooth(bctx, x, y, z, rotY);
    case "target":
      return buildTarget(bctx, x, y, z, rotY);
    case "pillar":
      return buildPillar(bctx, x, y, z, size?.[1] ?? 4);
    case "shelf":
      return buildShelf(bctx, x, y, z, rotY);
    case "skybridge":
      return buildSkybridge(bctx, x, y, z, prop.length ?? 10, rotY);
    // ── Task-6 — interactive props ──
    case "glass_panel":
      return buildGlassPanel(bctx, x, y, z, size?.[0] ?? 3, size?.[1] ?? 2, prop.destructibleHp ?? 30, rotY, color);
    case "jump_pad":
      return buildJumpPad(bctx, x, y, z, size?.[0] ?? 1.2);
    default:
      return null;
  }
}

// ============================================================
// Tactical prop builders
// ============================================================

/** Military crate — beveled metal body with reinforcement bands, corner brackets, latch. Stackable. */
export function buildMilitaryCrate(
  bctx: BuildContext, x: number, y: number, z: number,
  size = 1.2, color = 0x4a4a2e, rotY = 0,
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const mat = bctx.matCache.getTinted("metal", color, 0.6, 0.55);
  const bandMat = bctx.matCache.getTinted("metal", 0x1a1a14, 0.5, 0.7);
  const bracketMat = bctx.matCache.getMaterial("oliveDark");
  const s = size;
  const t = s * 0.06; // band thickness

  // Main body (slightly inset so bands read as relief).
  const body = addBox(group, 0, 0, 0, s - t, s, s - t, mat, {
    surface: "crate", materialSlug: "wood", collider: true,
  });
  // Top + bottom reinforcement bands (full perimeter).
  addBox(group, 0, s / 2 - t / 2, 0, s, t, s, bandMat, { surface: "crate", materialSlug: "wood", collider: true, raycast: false });
  addBox(group, 0, -s / 2 + t / 2, 0, s, t, s, bandMat, { surface: "crate", materialSlug: "wood", collider: true, raycast: false });
  // 4 vertical corner brackets.
  const off = s / 2 - t / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addBox(group, sx * off, 0, sz * off, t * 1.4, s, t * 1.4, bracketMat, {
      surface: "crate", materialSlug: "wood", collider: true, raycast: false,
    });
  }
  // Top latch detail.
  addBox(group, 0, s / 2 + t * 0.6, 0, s * 0.3, t * 0.7, s * 0.15, bracketMat, {
    surface: "crate", materialSlug: "wood", collider: true, raycast: false,
  });
  // Stencil plate (small darker inset on front face for "AMMO" feel).
  addBox(group, 0, 0, s / 2 + 0.001, s * 0.5, s * 0.3, 0.01, bandMat, {
    surface: "crate", materialSlug: "wood", collider: false, cast: false, raycast: false,
  });

  body.userData.crateStackable = true;
  registerGroupCollider(bctx, group);
  return group;
}

/** Olive ammo can with hinged lid, handle, latch. ~0.5m. */
export function buildAmmoBox(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const bodyMat = bctx.matCache.getMaterial("olive");
  const darkMat = bctx.matCache.getMaterial("oliveDark");
  const w = 0.6, h = 0.4, d = 0.4;

  // Body.
  addBox(group, 0, 0, 0, w, h, d, bodyMat, { surface: "crate", materialSlug: "wood", collider: true });
  // Lid (slightly inset on top).
  addBox(group, 0, h / 2 + 0.03, 0, w * 0.96, 0.06, d * 0.96, darkMat, {
    surface: "crate", materialSlug: "wood", collider: true, raycast: false,
  });
  // Hinge cylinder along back of lid.
  addCyl(group, 0, h / 2 + 0.03, -d / 2 + 0.02, 0.03, 0.03, w * 0.9, 8, darkMat, {
    surface: "metal", materialSlug: "sheet_metal", rotX: Math.PI / 2, collider: true, raycast: false,
  });
  // Handle (arched bar across the top).
  const handle = addCyl(group, 0, h / 2 + 0.12, 0, 0.018, 0.018, w * 0.7, 8, darkMat, {
    surface: "metal", materialSlug: "sheet_metal", rotX: Math.PI / 2, collider: true, raycast: false,
  });
  handle.scale.x = 0.6; // flatten a touch
  // Two latches on the front of the lid.
  for (const sx of [-1, 1]) {
    addBox(group, sx * w * 0.3, h / 2 + 0.02, d / 2 + 0.01, 0.05, 0.05, 0.03, darkMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
    });
  }
  // Carrying side brackets.
  for (const sx of [-1, 1]) {
    addBox(group, sx * (w / 2 - 0.02), 0, 0, 0.03, h * 0.7, d * 0.85, darkMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
    });
  }

  registerGroupCollider(bctx, group);
  return group;
}

/** U-shaped sandbag bunker (chest-high cover, open back). */
export function buildSandbagBunker(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const mat = bctx.matCache.getMaterial("sandbag");
  const wallW = 3.5;     // front wall length
  const sideW = 2.5;     // side wall length
  const wallH = 1.3;     // chest-high
  const thick = 0.7;     // wall thickness (2 sandbags deep)

  // Stack sandbags along each wall. Each sandbag is a flattened sphere.
  const bagR = 0.28;
  const rows = 3;
  const colsFront = 6;
  const colsSide = 4;

  // Front wall (along X axis at z = -thick/2).
  buildSandbagRow(group, mat, 0, -thick / 2, wallW, colsFront, rows, bagR, "cover", "sandbag", "x");
  // Left side wall (along Z axis at x = -wallW/2 + thick/2).
  buildSandbagRow(group, mat, -wallW / 2 + thick / 2, sideW / 2, sideW, colsSide, rows, bagR, "cover", "sandbag", "z");
  // Right side wall.
  buildSandbagRow(group, mat, wallW / 2 - thick / 2, sideW / 2, sideW, colsSide, rows, bagR, "cover", "sandbag", "z");

  // Register a single collider for the U-shape bounding region (approximate).
  // Front wall AABB.
  const frontBox = new THREE.Box3(
    new THREE.Vector3(-wallW / 2 - bagR, 0, -thick - bagR),
    new THREE.Vector3(wallW / 2 + bagR, wallH, bagR),
  );
  bctx.colliders.push({ box: frontBox });
  // Left side wall AABB.
  const leftBox = new THREE.Box3(
    new THREE.Vector3(-wallW / 2 - bagR, 0, -thick - bagR),
    new THREE.Vector3(-wallW / 2 + thick + bagR, wallH, sideW + bagR),
  );
  bctx.colliders.push({ box: leftBox });
  // Right side wall AABB.
  const rightBox = new THREE.Box3(
    new THREE.Vector3(wallW / 2 - thick - bagR, 0, -thick - bagR),
    new THREE.Vector3(wallW / 2 + bagR, wallH, sideW + bagR),
  );
  bctx.colliders.push({ box: rightBox });

  return group;
}

/** Build a row of stacked sandbags (helper used by bunker + wall). */
export function buildSandbagRow(
  parent: THREE.Object3D, mat: THREE.Material,
  cx: number, cz: number, length: number, cols: number, rows: number,
  bagR: number, surface: string, materialSlug: string, axis: "x" | "z",
): void {
  const spacing = length / cols;
  for (let r = 0; r < rows; r++) {
    const y = bagR * 0.7 + r * bagR * 1.4;
    const offset = (r % 2) * (spacing / 2); // brick-like offset
    for (let c = 0; c < cols; c++) {
      const along = -length / 2 + spacing / 2 + c * spacing + offset;
      const px = axis === "x" ? cx + along : cx;
      const pz = axis === "z" ? cz + along : cz;
      const bag = addSphere(parent, px, y, pz, bagR, 8, mat, {
        surface, materialSlug, scaleX: 1.2, scaleY: 0.75, scaleZ: 0.9, raycast: false,
      });
      // Slight random rotation for natural look.
      bag.rotation.y = Math.random() * Math.PI;
      bag.rotation.z = (Math.random() - 0.5) * 0.1;
    }
  }
}

/** Concrete Jersey barrier with angled face. */
export function buildConcreteBarrier(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Mesh {
  const mat = bctx.matCache.getMaterial("concrete");
  // 2D profile (side view): wide base, narrow top, sloped face on one side.
  const shape = new THREE.Shape();
  shape.moveTo(-0.4, 0);
  shape.lineTo(0.4, 0);
  shape.lineTo(0.4, 0.3);
  shape.lineTo(0.15, 1.1);
  shape.lineTo(-0.15, 1.1);
  shape.lineTo(-0.15, 0.3);
  shape.lineTo(-0.4, 0);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false, bevelThickness: 0, bevelSize: 0, bevelSegments: 0 });
  geo.translate(0, 0, -1); // center on Z
  geo.rotateY(Math.PI / 2); // length now along X
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  tagMesh(mesh, "concrete", "concrete");
  bctx.scene.add(mesh);
  bctx.colliders.push({ box: new THREE.Box3().setFromObject(mesh) });
  return mesh;
}

/** Hesco bastion — wire mesh container filled with sand. */
export function buildHescoBastion(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const w = 2.2, h = 1.2, d = 1.5;
  const meshMat = bctx.matCache.getMaterial("oliveDark");
  const sandMat = bctx.matCache.getMaterial("sandbag");

  // Sand fill (slightly inset).
  addBox(group, 0, h / 2, 0, w - 0.08, h - 0.08, d - 0.08, sandMat, {
    surface: "cover", materialSlug: "sandbag", collider: true,
  });
  // Wire mesh frame (thin edges).
  const e = 0.03;
  addBox(group, 0, h, 0, w, e, d, meshMat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
  addBox(group, 0, 0, 0, w, e, d, meshMat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
  for (const sx of [-1, 1]) addBox(group, sx * (w / 2 - e / 2), h / 2, 0, e, h, d, meshMat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
  for (const sz of [-1, 1]) addBox(group, 0, h / 2, sz * (d / 2 - e / 2), w, h, e, meshMat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });

  registerGroupCollider(bctx, group);
  return group;
}

/** Shipping container — corrugated sides, door frame, corner castings. Hollow (enterable from one end). */
export function buildShippingContainer(
  bctx: BuildContext, x: number, y: number, z: number,
  rotY = 0, color = 0xa83828,
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  // Pick a container color material.
  const colorTag: MaterialTag = color === 0x2a4a78 ? "containerBlue"
    : color === 0x3a5a3a ? "containerGreen"
    : "containerRed";
  const bodyMat = bctx.matCache.getTinted(colorTag, color, 0.6, 0.55);
  const frameMat = bctx.matCache.getMaterial("oliveDark");
  const floorMat = bctx.matCache.getMaterial("wood");

  const L = 6;   // length (X)
  const W = 2.5; // width (Z)
  const H = 2.6; // height (Y)
  const wallT = 0.08;

  // Floor.
  addBox(group, 0, 0.05, 0, L, 0.1, W, floorMat, { surface: "wood", materialSlug: "wood", collider: true });
  // Roof.
  addBox(group, 0, H - 0.05, 0, L, 0.1, W, bodyMat, { surface: "container", materialSlug: "sheet_metal", collider: true });
  // Two long corrugated sides (Z = ±W/2).
  for (const sz of [-1, 1]) {
    addBox(group, 0, H / 2, sz * (W / 2 - wallT / 2), L, H - 0.1, wallT, bodyMat, {
      surface: "container", materialSlug: "sheet_metal", collider: true,
    });
    // Corrugation ribs (thin vertical strips on the outside face).
    const ribCount = 14;
    for (let i = 0; i < ribCount; i++) {
      const rx = -L / 2 + (i + 0.5) * (L / ribCount);
      addBox(group, rx, H / 2, sz * (W / 2 + 0.01), 0.04, H - 0.2, 0.02, frameMat, {
        surface: "container", materialSlug: "sheet_metal", collider: false, cast: true, raycast: false,
      });
    }
  }
  // Closed short end (X = -L/2).
  addBox(group, -L / 2 + wallT / 2, H / 2, 0, wallT, H - 0.1, W, bodyMat, {
    surface: "container", materialSlug: "sheet_metal", collider: true,
  });
  // Door end (X = +L/2): frame around a 2m × 2.1m opening.
  const doorW = 2.0, doorH = 2.1;
  const sideSegW = (W - doorW) / 2;
  // Left of door.
  if (sideSegW > 0.05) {
    addBox(group, L / 2 - wallT / 2, doorH / 2, -W / 2 + sideSegW / 2, wallT, doorH, sideSegW, bodyMat, {
      surface: "container", materialSlug: "sheet_metal", collider: true,
    });
    addBox(group, L / 2 - wallT / 2, doorH / 2, W / 2 - sideSegW / 2, wallT, doorH, sideSegW, bodyMat, {
      surface: "container", materialSlug: "sheet_metal", collider: true,
    });
  }
  // Above door.
  const aboveH = H - 0.1 - doorH;
  if (aboveH > 0.05) {
    addBox(group, L / 2 - wallT / 2, doorH + aboveH / 2, 0, wallT, aboveH, doorW, bodyMat, {
      surface: "container", materialSlug: "sheet_metal", collider: true,
    });
  }
  // 8 corner castings (small cubes at corners).
  const cs = 0.18;
  for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
    addBox(group, sx * (L / 2 - cs / 2), sy === 0 ? cs / 2 : H - cs / 2, sz * (W / 2 - cs / 2), cs, cs, cs, frameMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: false, raycast: false,
    });
  }
  // Door handle detail (one vertical bar across the door opening, off-center).
  addBox(group, L / 2 + 0.04, H / 2 - 0.2, 0, 0.04, 1.6, 0.05, frameMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });

  registerTaggedColliders(bctx, group);
  return group;
}

/** Oil barrel — cylindrical body with rings, cap, dents. Explosive (destructible, hp 30). */
export function buildOilBarrel(
  bctx: BuildContext, x: number, y: number, z: number,
  color = 0xb33a2a,
): THREE.Mesh {
  const bodyMat = bctx.matCache.getTinted("barrel", color, 0.5, 0.7);
  const ringMat = bctx.matCache.getMaterial("oliveDark");

  // Body mesh is the destructible; rings + cap are decorative children (raycast disabled).
  const r = 0.32, h = 1.0;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 18), bodyMat);
  body.position.set(x, y + h / 2, z);
  body.castShadow = true;
  body.receiveShadow = true;
  body.scale.x = 0.97; // slight dent
  bctx.scene.add(body);

  // Decorative rings (top + bottom + middle).
  const ringGeo = new THREE.TorusGeometry(r * 1.01, 0.025, 6, 18);
  for (const yy of [h * 0.18, h * 0.5, h * 0.82]) {
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(0, yy - h / 2, 0);
    ring.rotation.x = Math.PI / 2;
    ring.castShadow = true;
    ring.receiveShadow = true;
    noRaycast(ring);
    body.add(ring);
  }
  // Cap on top.
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.35, r * 0.35, 0.05, 12), ringMat);
  cap.position.set(0, h / 2 + 0.025, 0);
  cap.castShadow = true;
  cap.receiveShadow = true;
  noRaycast(cap);
  body.add(cap);
  // Filler cap (smaller, offset).
  const filler = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.04, 8), ringMat);
  filler.position.set(r * 0.45, h / 2 + 0.02, 0);
  noRaycast(filler);
  body.add(filler);

  registerDestructible(bctx, body, 30, "sheet_metal", "barrel");
  return body;
}

/** Wooden pallet — slatted planks on blocks. Low cover. */
export function buildPallet(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const mat = bctx.matCache.getMaterial("wood");
  const w = 1.2, d = 0.8, h = 0.14;
  const plankT = 0.04;

  // 3 top planks.
  for (let i = 0; i < 3; i++) {
    const pz = -d / 2 + (i + 0.5) * (d / 3);
    addBox(group, 0, h - plankT / 2, pz, w, plankT, d / 3 - 0.04, mat, {
      surface: "crate", materialSlug: "wood", collider: true,
    });
  }
  // 3 bottom planks.
  for (let i = 0; i < 3; i++) {
    const pz = -d / 2 + (i + 0.5) * (d / 3);
    addBox(group, 0, plankT / 2, pz, w, plankT, d / 3 - 0.04, mat, {
      surface: "crate", materialSlug: "wood", collider: true, raycast: false,
    });
  }
  // 9 support blocks (3x3 grid).
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const px = -w / 2 + (i + 0.5) * (w / 3);
    const pz = -d / 2 + (j + 0.5) * (d / 3);
    addBox(group, px, h / 2 - plankT / 2, pz, 0.12, h - plankT * 2, 0.12, mat, {
      surface: "crate", materialSlug: "wood", collider: true, raycast: false,
    });
  }

  registerGroupCollider(bctx, group);
  return group;
}

/** Industrial generator — boxy body with vents, exhaust pipe, control panel, fuel tank. */
export function buildGenerator(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const bodyMat = bctx.matCache.getMaterial("oliveDark");
  const panelMat = bctx.matCache.getTinted("metal", 0x202020, 0.4, 0.6);
  const pipeMat = bctx.matCache.getMaterial("metal");
  const tankMat = bctx.matCache.getMaterial("rust");

  const w = 1.6, h = 1.1, d = 0.85;
  // Main body.
  addBox(group, 0, h / 2, 0, w, h, d, bodyMat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Vent slits on the side (3 recessed dark slots).
  for (let i = 0; i < 3; i++) {
    const px = -w / 3 + i * (w / 3);
    addBox(group, px, h / 2, d / 2 + 0.005, w / 4, h * 0.5, 0.02, panelMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: false, raycast: false,
    });
  }
  // Control panel on the front (a recessed darker rectangle).
  addBox(group, -w / 2 - 0.005, h * 0.65, 0, 0.02, h * 0.4, d * 0.7, panelMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });
  // 2 control knobs.
  for (const sy of [-1, 1]) {
    addCyl(group, -w / 2 - 0.04, h * 0.7, sy * d * 0.18, 0.04, 0.04, 0.04, 8, panelMat, {
      surface: "metal", materialSlug: "sheet_metal", rotZ: Math.PI / 2, collider: false, raycast: false,
    });
  }
  // Exhaust pipe (vertical cylinder at the back-right corner).
  addCyl(group, w / 2 - 0.15, h + 0.4, -d / 2 + 0.1, 0.06, 0.06, 0.9, 12, pipeMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });
  // Exhaust cap (slight cone).
  addCyl(group, w / 2 - 0.15, h + 0.85, -d / 2 + 0.1, 0.08, 0.05, 0.08, 12, pipeMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });
  // Fuel tank (horizontal cylinder on top).
  addCyl(group, 0, h + 0.18, 0, 0.16, 0.16, w * 0.6, 12, tankMat, {
    surface: "metal", materialSlug: "sheet_metal", rotX: Math.PI / 2, collider: true, raycast: false,
  });
  // Base frame.
  addBox(group, 0, 0.05, 0, w + 0.1, 0.1, d + 0.1, panelMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });

  registerGroupCollider(bctx, group);
  return group;
}

/** Straight sandbag wall segment. */
export function buildSandbagWall(bctx: BuildContext, x: number, y: number, z: number, length = 4, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const mat = bctx.matCache.getMaterial("sandbag");
  const bagR = 0.28;
  const cols = Math.max(3, Math.round(length / 0.6));
  const rows = 3;
  const thick = 0.7;
  buildSandbagRow(group, mat, 0, 0, length, cols, rows, bagR, "cover", "sandbag", "x");
  // Back row (offset) for thickness.
  buildSandbagRow(group, mat, 0, thick * 0.5, length, cols, rows, bagR, "cover", "sandbag", "x");

  // Single AABB collider.
  const box = new THREE.Box3(
    new THREE.Vector3(-length / 2 - bagR, 0, -thick - bagR),
    new THREE.Vector3(length / 2 + bagR, rows * bagR * 1.4, bagR),
  );
  bctx.colliders.push({ box });
  return group;
}

/** A-frame wooden plank barricade. */
export function buildBarricade(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const mat = bctx.matCache.getMaterial("wood");
  const darkMat = bctx.matCache.getTinted("wood", 0x4a2a15, 0.9, 0);

  const w = 2.0, h = 1.3, d = 0.6;
  // Two A-frame legs (slanted).
  for (const sx of [-1, 1]) {
    const leg = addBox(group, sx * (w / 4), h / 2, 0, 0.08, h, 0.1, mat, {
      surface: "crate", materialSlug: "wood", collider: true,
    });
    leg.rotation.z = sx * 0.25;
  }
  // Horizontal top plank.
  addBox(group, 0, h - 0.05, 0, w, 0.08, 0.18, mat, { surface: "crate", materialSlug: "wood", collider: true });
  // 3 horizontal slats across the front.
  for (let i = 0; i < 3; i++) {
    const py = 0.2 + i * (h - 0.4) / 2.5;
    addBox(group, 0, py, d / 2 - 0.02, w * 0.85, 0.06, 0.05, darkMat, {
      surface: "crate", materialSlug: "wood", collider: true, raycast: false,
    });
  }
  // Diagonal brace.
  const brace = addBox(group, 0, h / 2, 0, w * 0.7, 0.05, 0.05, darkMat, {
    surface: "crate", materialSlug: "wood", collider: true, raycast: false,
  });
  brace.rotation.z = 0.4;
  // Barbed wire (thin horizontal cylinder on top, dark).
  addCyl(group, 0, h + 0.05, 0, 0.008, 0.008, w, 6, darkMat, {
    surface: "metal", materialSlug: "sheet_metal", rotX: Math.PI / 2, collider: true, raycast: false,
  });

  registerGroupCollider(bctx, group);
  return group;
}

/** Metal dumpster with hinged lid, wheels. */
export function buildDumpster(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const bodyMat = bctx.matCache.getTinted("metal", 0x2a5a4a, 0.6, 0.5);
  const lidMat = bctx.matCache.getTinted("metal", 0x1a3a30, 0.6, 0.5);
  const wheelMat = bctx.matCache.getMaterial("rubber");

  const w = 1.8, h = 1.1, d = 1.2, t = 0.05;
  // Body — built from 4 sloped walls + floor (use boxes; the slope is approximated by tilt).
  // Floor.
  addBox(group, 0, t / 2, 0, w, t, d, bodyMat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Front wall (slightly sloped outward at top).
  const front = addBox(group, 0, h / 2 + t, -d / 2 + t / 2, w, h, t, bodyMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true,
  });
  front.rotation.x = -0.08; front.position.z = -d / 2 + t / 2 + 0.04;
  // Back wall (vertical).
  addBox(group, 0, h / 2 + t, d / 2 - t / 2, w, h, t, bodyMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true,
  });
  // Side walls (sloped to match front).
  for (const sx of [-1, 1]) {
    const side = addBox(group, sx * (w / 2 - t / 2), h / 2 + t, 0, t, h, d, bodyMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: true,
    });
    side.rotation.y = sx * 0.04;
  }
  // Lid (hinged at back, slightly open).
  const lid = addBox(group, 0, h + t + 0.05, d / 2 - 0.1, w - 0.1, 0.04, d - 0.1, lidMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true,
  });
  lid.rotation.x = -0.35;
  lid.position.set(0, h + t + 0.1, d / 2 - 0.2);
  // 4 wheels (corners).
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addCyl(group, sx * (w / 2 - 0.15), 0.12, sz * (d / 2 - 0.15), 0.12, 0.12, 0.08, 12, wheelMat, {
      surface: "metal", materialSlug: "sheet_metal", rotX: Math.PI / 2, collider: true, raycast: false,
    });
  }
  // Lid handle.
  addBox(group, 0, h + t + 0.18, -d / 2 + 0.25, 0.3, 0.04, 0.04, lidMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });

  registerTaggedColliders(bctx, group);
  return group;
}

/** Stack of 2-3 mixed crates at varied rotations.
 *  Children are built at world positions (each registers its own collider
 *  in world space), then re-parented to a container group using `attach`
 *  so their world transforms — and therefore their colliders — stay valid. */
export function buildCrateStack(bctx: BuildContext, x: number, y: number, z: number): THREE.Group {
  // Build children at world positions (each registers its own collider).
  const c1 = buildMilitaryCrate(bctx, x, y + 0.6, z, 1.2, 0x4a4a2e, 0.15);
  const c2 = buildMilitaryCrate(bctx, x + 0.05, y + 1.8, z + 0.05, 0.9, 0x3a3a24, -0.4);
  const c3 = buildAmmoBox(bctx, x - 0.1, y + 2.65, z + 0.1, 0.6);

  // Group them via `attach` so world transforms (and the already-registered
  // colliders) are preserved.
  const group = new THREE.Group();
  group.position.set(x, y, z);
  bctx.scene.add(group);
  group.attach(c1);
  group.attach(c2);
  group.attach(c3);
  return group;
}

// ============================================================
// Building (modular walls with door + windows)
// ============================================================

export interface BuildingOpts {
  x: number; y: number; z: number;
  width: number;   // X
  height: number;  // Y
  depth: number;   // Z
  rotY?: number;
  wallMaterial?: "brick" | "concrete" | "metal";
  doorSide?: "north" | "south" | "east" | "west";
  windowsPerWall?: number;
  color?: number;
}

/** Modular enterable building: 4 walls with window gaps + door opening, flat roof, interior floor. */
export function buildBuilding(bctx: BuildContext, opts: BuildingOpts): THREE.Group {
  const {
    x, y, z, width, height, depth,
    rotY = 0,
    wallMaterial = "brick",
    doorSide = "south",
    windowsPerWall = 2,
    color,
  } = opts;

  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const wallMatTag: MaterialTag = wallMaterial === "metal" ? "metal"
    : wallMaterial === "concrete" ? "concrete"
    : "brick";
  const wallMat = color !== undefined
    ? bctx.matCache.getTinted(wallMatTag, color, undefined, undefined)
    : bctx.matCache.getMaterial(wallMatTag);
  const concreteMat = bctx.matCache.getMaterial("concrete");
  const glassMat = bctx.matCache.getMaterial("glass");

  const t = 0.25; // wall thickness

  // Floor slab.
  addBox(group, 0, -0.05, 0, width, 0.1, depth, concreteMat, {
    surface: "concrete", materialSlug: "concrete", collider: false, receive: true,
  });
  // Roof slab.
  addBox(group, 0, height + 0.1, 0, width + 0.3, 0.2, depth + 0.3, concreteMat, {
    surface: "concrete", materialSlug: "concrete", collider: true,
  });

  // Helper to build a wall in local space.
  // Wall runs along X axis at local Z = zPos; if rotY=π/2, it runs along Z.
  const buildWall = (
    wallLength: number, wallH: number,
    localX: number, localZ: number, rot: number, hasDoor: boolean,
  ) => {
    const wallGroup = new THREE.Group();
    wallGroup.position.set(localX, 0, localZ);
    wallGroup.rotation.y = rot;
    group.add(wallGroup);

    const surface = wallMaterial === "metal" ? "container" : "building";
    const materialSlug = wallMaterial === "metal" ? "sheet_metal" : "brick";

    // Knee wall (below windows).
    const kneeH = 0.8;
    addBox(wallGroup, 0, kneeH / 2, 0, wallLength, kneeH, t, wallMat, {
      surface, materialSlug, collider: true,
    });
    // Header (above windows).
    const headerH = 0.5;
    addBox(wallGroup, 0, wallH - headerH / 2, 0, wallLength, headerH, t, wallMat, {
      surface, materialSlug, collider: true,
    });
    // Mid section (windows or door).
    const midH = wallH - kneeH - headerH;
    const midY = kneeH + midH / 2;

    if (hasDoor) {
      const doorW = 1.6, doorH = 2.2;
      const sideW = (wallLength - doorW) / 2;
      if (sideW > 0.05) {
        addBox(wallGroup, -wallLength / 2 + sideW / 2, midY, 0, sideW, midH, t, wallMat, {
          surface, materialSlug, collider: true,
        });
        addBox(wallGroup, wallLength / 2 - sideW / 2, midY, 0, sideW, midH, t, wallMat, {
          surface, materialSlug, collider: true,
        });
      }
      const aboveDoorH = wallH - headerH - doorH;
      if (aboveDoorH > 0.05) {
        addBox(wallGroup, 0, doorH + aboveDoorH / 2, 0, doorW, aboveDoorH, t, wallMat, {
          surface, materialSlug, collider: true,
        });
      }
      // Small window on each side of the door (glass, no collider).
      const glassGeo = new THREE.PlaneGeometry(sideW * 0.6, midH * 0.5);
      for (const sx of [-1, 1]) {
        const g = new THREE.Mesh(glassGeo, glassMat);
        g.position.set(sx * (sideW * 0.5 + 0.1), midY, t / 2 + 0.02);
        g.castShadow = false;
        g.receiveShadow = false;
        wallGroup.add(g);
      }
    } else if (windowsPerWall > 0) {
      const segW = wallLength / windowsPerWall;
      // Vertical mullions.
      for (let i = 0; i <= windowsPerWall; i++) {
        const mx = -wallLength / 2 + i * segW;
        addBox(wallGroup, mx, midY, 0, 0.18, midH, t, wallMat, {
          surface, materialSlug, collider: true,
        });
      }
      // Horizontal mid-rail through window centers.
      addBox(wallGroup, 0, midY, 0, wallLength, 0.1, t, wallMat, {
        surface, materialSlug, collider: true, raycast: false,
      });
      // Glass panes (no collider).
      const paneGeo = new THREE.PlaneGeometry(segW - 0.3, midH - 0.25);
      for (let i = 0; i < windowsPerWall; i++) {
        const cx = -wallLength / 2 + (i + 0.5) * segW;
        const g = new THREE.Mesh(paneGeo, glassMat);
        g.position.set(cx, midY, t / 2 + 0.02);
        g.castShadow = false;
        g.receiveShadow = false;
        wallGroup.add(g);
        // Inner pane (back side of wall).
        const g2 = g.clone();
        g2.position.z = -t / 2 - 0.02;
        g2.rotation.y = Math.PI;
        wallGroup.add(g2);
      }
    } else {
      // Solid mid wall.
      addBox(wallGroup, 0, midY, 0, wallLength, midH, t, wallMat, {
        surface, materialSlug, collider: true,
      });
    }
  };

  // 4 walls.
  buildWall(width, height, 0, -depth / 2, 0, doorSide === "north");        // North (z = -depth/2)
  buildWall(width, height, 0, depth / 2, Math.PI, doorSide === "south");   // South (z = +depth/2)
  buildWall(depth, height, width / 2, 0, Math.PI / 2, doorSide === "east"); // East (x = +width/2)
  buildWall(depth, height, -width / 2, 0, -Math.PI / 2, doorSide === "west"); // West

  // Register per-segment colliders (now that the group is in the scene).
  registerTaggedColliders(bctx, group);
  return group;
}

// ============================================================
// Additional themed builders (Rooftops / Desert / Urban / Training)
// ============================================================

/** Rooftop AC unit — boxy body with fan grille + fins. */
export function buildAcUnit(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const bodyMat = bctx.matCache.getMaterial("oliveDark");
  const finMat = bctx.matCache.getTinted("metal", 0x606060, 0.4, 0.7);
  const fanMat = bctx.matCache.getTinted("metal", 0x202020, 0.6, 0.5);

  const w = 1.5, h = 0.9, d = 1.0;
  // Body.
  addBox(group, 0, h / 2, 0, w, h, d, bodyMat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Top fan housing (raised cylinder).
  addCyl(group, 0, h + 0.08, 0, 0.35, 0.35, 0.16, 16, bodyMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });
  // Fan blades (cross of thin boxes).
  for (let i = 0; i < 4; i++) {
    const blade = addBox(group, 0, h + 0.18, 0, 0.6, 0.01, 0.08, fanMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: false, cast: false, raycast: false,
    });
    blade.rotation.y = (i * Math.PI) / 4;
  }
  // Side fins (louvers).
  for (let i = 0; i < 5; i++) {
    addBox(group, w / 2 + 0.01, 0.2 + i * 0.12, 0, 0.02, 0.08, d * 0.85, finMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: false, raycast: false,
    });
    addBox(group, -w / 2 - 0.01, 0.2 + i * 0.12, 0, 0.02, 0.08, d * 0.85, finMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: false, raycast: false,
    });
  }

  registerGroupCollider(bctx, group);
  return group;
}

/** Cylindrical water tank with conical top + intake pipe. */
export function buildWaterTank(bctx: BuildContext, x: number, y: number, z: number): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  bctx.scene.add(group);

  const bodyMat = bctx.matCache.getTinted("metal", 0x6a7078, 0.55, 0.55);
  const darkMat = bctx.matCache.getMaterial("oliveDark");
  const r = 1.0, h = 2.4;

  // Body.
  addCyl(group, 0, h / 2, 0, r, r, h, 18, bodyMat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Conical top.
  addCyl(group, 0, h + 0.3, 0, 0.1, r, 0.7, 18, bodyMat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
  // Rings (3 horizontal reinforcement bands).
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.005, 0.04, 6, 18), darkMat);
    ring.position.set(0, h * (0.2 + i * 0.3), 0);
    ring.rotation.x = Math.PI / 2;
    ring.castShadow = true;
    noRaycast(ring);
    group.add(ring);
  }
  // Intake pipe.
  addCyl(group, r + 0.15, h * 0.7, 0, 0.08, 0.08, 0.4, 8, darkMat, {
    surface: "metal", materialSlug: "sheet_metal", rotZ: Math.PI / 2, collider: true, raycast: false,
  });
  // Base ring.
  addCyl(group, 0, 0.05, 0, r * 1.1, r * 1.1, 0.1, 18, darkMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });

  registerGroupCollider(bctx, group);
  return group;
}

/** Satellite dish on a pole. */
export function buildSatellite(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const dishMat = bctx.matCache.getTinted("metal", 0x9a9a9a, 0.4, 0.7);
  const poleMat = bctx.matCache.getMaterial("oliveDark");
  // Pole.
  addCyl(group, 0, 1.0, 0, 0.06, 0.06, 2.0, 8, poleMat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Dish (a shallow sphere section).
  const dishGeo = new THREE.SphereGeometry(0.7, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2.6);
  const dish = new THREE.Mesh(dishGeo, dishMat);
  dish.position.set(0, 1.9, 0);
  dish.rotation.x = Math.PI * 0.78;
  dish.castShadow = true;
  dish.receiveShadow = true;
  markCollider(dish);
  group.add(dish);
  // LNB arm (small cylinder pointing toward dish focus).
  addCyl(group, 0, 1.85, 0.45, 0.02, 0.02, 0.5, 6, poleMat, {
    surface: "metal", materialSlug: "sheet_metal", rotX: -1.0, collider: true, raycast: false,
  });
  // LNB (small box at end of arm).
  addBox(group, 0, 1.7, 0.65, 0.08, 0.06, 0.12, poleMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });

  registerGroupCollider(bctx, group);
  return group;
}

/** Military command tent — box body + pyramid roof, fabric material. */
export function buildTent(bctx: BuildContext, x: number, y: number, z: number, rotY = 0, color?: number): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const fabricMat = bctx.matCache.getTinted("canvas", color ?? 0x5a5a3a, 0.95, 0);
  const w = 4.0, h = 2.2, d = 3.0;
  // Body (4 walls).
  addBox(group, 0, h / 2, -d / 2, w, h, 0.05, fabricMat, { surface: "cover", materialSlug: "sandbag", collider: true });
  addBox(group, 0, h / 2, d / 2, w, h, 0.05, fabricMat, { surface: "cover", materialSlug: "sandbag", collider: true });
  addBox(group, -w / 2, h / 2, 0, 0.05, h, d, fabricMat, { surface: "cover", materialSlug: "sandbag", collider: true });
  // Right wall with door slit (two segments).
  addBox(group, w / 2, h * 0.65, -d / 4 - 0.4, 0.05, h * 1.3, d / 2 - 0.8, fabricMat, { surface: "cover", materialSlug: "sandbag", collider: true });
  addBox(group, w / 2, h * 0.65, d / 4 + 0.4, 0.05, h * 1.3, d / 2 - 0.8, fabricMat, { surface: "cover", materialSlug: "sandbag", collider: true });
  // Roof (4-sided pyramid via ConeGeometry).
  const roof = new THREE.Mesh(new THREE.ConeGeometry(w * 0.72, 1.4, 4), fabricMat);
  roof.position.set(0, h + 0.7, 0);
  roof.rotation.y = Math.PI / 4;
  roof.scale.z = d / w;
  roof.castShadow = true;
  roof.receiveShadow = true;
  markCollider(roof);
  group.add(roof);
  // Floor (tarp).
  addBox(group, 0, 0.02, 0, w - 0.1, 0.04, d - 0.1, fabricMat, {
    surface: "cover", materialSlug: "sandbag", collider: false, raycast: false,
  });

  registerTaggedColliders(bctx, group);
  return group;
}

/** Fuel bladder — flattened cylinder laying on its side, rubber material. */
export function buildFuelBladder(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const mat = bctx.matCache.getTinted("rubber", 0x3a2a1a, 0.85, 0.1);
  const capMat = bctx.matCache.getMaterial("oliveDark");
  // Body (horizontal cylinder).
  addCyl(group, 0, 0.6, 0, 0.7, 0.7, 2.4, 16, mat, {
    surface: "metal", materialSlug: "sheet_metal", rotX: Math.PI / 2, collider: true,
  });
  // 2 fill caps on top.
  for (const sx of [-0.5, 0.5]) {
    addCyl(group, sx, 1.25, 0, 0.1, 0.1, 0.1, 8, capMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
    });
  }
  // Strap bands (3 torus rings around the body).
  for (const sx of [-0.7, 0, 0.7]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.04, 6, 16), capMat);
    ring.position.set(sx, 0.6, 0);
    ring.rotation.y = Math.PI / 2;
    ring.castShadow = true;
    noRaycast(ring);
    group.add(ring);
  }

  registerGroupCollider(bctx, group);
  return group;
}

/** Comms tower — lattice truss with antenna mast. */
export function buildCommsTower(bctx: BuildContext, x: number, y: number, z: number): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  bctx.scene.add(group);

  const mat = bctx.matCache.getMaterial("oliveDark");
  const H = 9.0; // total height
  const baseW = 1.4;
  // 4 corner legs (slightly tapered toward top).
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2 + Math.PI / 4;
    const bx = Math.cos(angle) * baseW / 2;
    const bz = Math.sin(angle) * baseW / 2;
    const tx = Math.cos(angle) * 0.3;
    const tz = Math.sin(angle) * 0.3;
    // Approximate leg as a thin tilted box.
    const len = H;
    const leg = addBox(group, (bx + tx) / 2, H / 2, (bz + tz) / 2, 0.08, len, 0.08, mat, {
      surface: "metal", materialSlug: "sheet_metal", collider: true,
    });
    leg.rotation.x = (tz - bz) * 0.12;
    leg.rotation.z = -(tx - bx) * 0.12;
  }
  // Horizontal cross-braces at 4 levels.
  for (let lvl = 0; lvl < 4; lvl++) {
    const py = 0.8 + lvl * 2.0;
    const w = baseW * (1 - lvl * 0.18);
    // Square ring (4 thin boxes).
    addBox(group, 0, py, -w / 2, w, 0.05, 0.05, mat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
    addBox(group, 0, py, w / 2, w, 0.05, 0.05, mat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
    addBox(group, -w / 2, py, 0, 0.05, 0.05, w, mat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
    addBox(group, w / 2, py, 0, 0.05, 0.05, w, mat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
    // X diagonals.
    const d = addBox(group, 0, py, 0, w * 1.4, 0.04, 0.04, mat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
    d.rotation.y = Math.PI / 4;
    const d2 = addBox(group, 0, py, 0, w * 1.4, 0.04, 0.04, mat, { surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false });
    d2.rotation.y = -Math.PI / 4;
  }
  // Antenna mast on top.
  addCyl(group, 0, H + 1.0, 0, 0.05, 0.05, 2.0, 8, mat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Dish at top.
  const dish = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.6), mat);
  dish.position.set(0, H + 2.1, 0);
  dish.rotation.x = Math.PI * 0.7;
  dish.castShadow = true;
  markCollider(dish);
  group.add(dish);

  registerGroupCollider(bctx, group);
  return group;
}

/** Burnt car — body, cabin, 4 wheels. Charred color. */
export function buildCar(bctx: BuildContext, x: number, y: number, z: number, rotY = 0, color = 0x3a2a25): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const bodyMat = bctx.matCache.getTinted("charred", color, 0.9, 0.2);
  const glassMat = bctx.matCache.getTinted("glass", 0x1a1a1a, 0.4, 0.3);
  (glassMat as THREE.MeshStandardMaterial).opacity = 0.5;
  const wheelMat = bctx.matCache.getMaterial("rubber");

  const w = 1.8, h = 0.7, d = 4.0;
  // Lower body.
  addBox(group, 0, h / 2 + 0.2, 0, w, h, d, bodyMat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Cabin (smaller box on top, slightly tapered).
  addBox(group, 0, h + 0.6, -0.2, w * 0.9, 0.8, d * 0.55, bodyMat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Windows (thin dark planes).
  const winGeo = new THREE.PlaneGeometry(w * 0.85, 0.55);
  for (const sz of [-1, 1]) {
    const g = new THREE.Mesh(winGeo, glassMat);
    g.position.set(sz * (w / 2 + 0.01), h + 0.6, -0.2);
    g.rotation.y = Math.PI / 2;
    g.castShadow = false;
    group.add(g);
  }
  for (const sx of [-1, 1]) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(d * 0.5, 0.55), glassMat);
    g.position.set(sx * 0.35, h + 0.6, d * 0.275 - 0.2);
    g.rotation.y = sx > 0 ? 0 : Math.PI;
    g.castShadow = false;
    group.add(g);
  }
  // 4 wheels.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addCyl(group, sx * (w / 2 - 0.05), 0.35, sz * (d / 2 - 0.6), 0.35, 0.35, 0.2, 14, wheelMat, {
      surface: "metal", materialSlug: "sheet_metal", rotX: Math.PI / 2, collider: true, raycast: false,
    });
  }
  // Bumpers.
  for (const sz of [-1, 1]) {
    addBox(group, 0, 0.4, sz * (d / 2 + 0.05), w, 0.15, 0.1, bodyMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
    });
  }

  registerTaggedColliders(bctx, group);
  return group;
}

/** Phone booth — tall thin glass box. */
export function buildPhoneBooth(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const frameMat = bctx.matCache.getTinted("metal", 0x1a3a5a, 0.4, 0.6);
  const glassMat = bctx.matCache.getTinted("glass", 0x88aacc, 0.15, 0.3);
  (glassMat as THREE.MeshStandardMaterial).opacity = 0.45;
  const w = 0.9, h = 2.4, d = 0.9, t = 0.05;
  // Frame: 4 vertical posts + roof + floor.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addBox(group, sx * (w / 2 - t / 2), h / 2, sz * (d / 2 - t / 2), t, h, t, frameMat, {
      surface: "metal", materialSlug: "sheet_metal", collider: true,
    });
  }
  // Roof.
  addBox(group, 0, h, 0, w, 0.1, d, frameMat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Floor.
  addBox(group, 0, 0.05, 0, w, 0.1, d, frameMat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  // Glass walls (4 sides).
  const glassGeo = new THREE.PlaneGeometry(w - t * 2, h - 0.2);
  for (const sz of [-1, 1]) {
    const g = new THREE.Mesh(glassGeo, glassMat);
    g.position.set(0, h / 2, sz * (d / 2 + 0.01));
    g.castShadow = false;
    group.add(g);
  }
  for (const sx of [-1, 1]) {
    const g = new THREE.Mesh(glassGeo, glassMat);
    g.position.set(sx * (w / 2 + 0.01), h / 2, 0);
    g.rotation.y = Math.PI / 2;
    g.castShadow = false;
    group.add(g);
  }
  // Phone box inside (small dark box).
  addBox(group, 0, 1.2, -d / 2 + 0.15, 0.4, 0.6, 0.1, frameMat, {
    surface: "metal", materialSlug: "sheet_metal", collider: false, raycast: false,
  });

  registerTaggedColliders(bctx, group);
  return group;
}

/** Training target silhouette — humanoid-shaped, destructible. */
export function buildTarget(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Mesh {
  const mat = bctx.matCache.getTinted("metal", 0xb03020, 0.7, 0.3);
  // Build the target as a single mesh by merging humanoid-shaped boxes.
  const geos: THREE.BufferGeometry[] = [];
  // Head.
  const head = new THREE.BoxGeometry(0.25, 0.3, 0.05);
  head.translate(0, 1.65, 0);
  geos.push(head);
  // Torso.
  const torso = new THREE.BoxGeometry(0.55, 0.8, 0.05);
  torso.translate(0, 1.1, 0);
  geos.push(torso);
  // Pelvis.
  const pelvis = new THREE.BoxGeometry(0.5, 0.2, 0.05);
  pelvis.translate(0, 0.6, 0);
  geos.push(pelvis);
  // Legs.
  const legL = new THREE.BoxGeometry(0.2, 0.6, 0.05);
  legL.translate(-0.13, 0.3, 0);
  geos.push(legL);
  const legR = new THREE.BoxGeometry(0.2, 0.6, 0.05);
  legR.translate(0.13, 0.3, 0);
  geos.push(legR);
  // Shoulders.
  const sh = new THREE.BoxGeometry(0.7, 0.15, 0.05);
  sh.translate(0, 1.5, 0);
  geos.push(sh);

  const merged = mergeGeometries(geos);
  const mesh = new THREE.Mesh(merged, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  mesh.scale.set(1, 1, 0.5); // flatten to a silhouette plate
  registerDestructible(bctx, mesh, 100, "sheet_metal", "metal");
  return mesh;
}

/** Concrete pillar (cylindrical). */
export function buildPillar(bctx: BuildContext, x: number, y: number, z: number, height = 4): THREE.Mesh {
  const mat = bctx.matCache.getMaterial("concrete");
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, height, 16), mat);
  mesh.position.set(x, y + height / 2, z);
  tagMesh(mesh, "concrete", "concrete");
  bctx.scene.add(mesh);
  bctx.colliders.push({ box: new THREE.Box3().setFromObject(mesh) });
  return mesh;
}

/** Warehouse shelf — tall metal rack with horizontal shelves. */
export function buildShelf(bctx: BuildContext, x: number, y: number, z: number, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const mat = bctx.matCache.getMaterial("oliveDark");
  const w = 2.0, h = 3.0, d = 0.6;
  // 4 vertical posts.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addBox(group, sx * (w / 2 - 0.04), h / 2, sz * (d / 2 - 0.04), 0.08, h, 0.08, mat, {
      surface: "metal", materialSlug: "sheet_metal", collider: true,
    });
  }
  // 5 horizontal shelves.
  for (let i = 0; i < 5; i++) {
    const py = 0.1 + i * (h - 0.2) / 4;
    addBox(group, 0, py, 0, w, 0.04, d, mat, { surface: "metal", materialSlug: "sheet_metal", collider: true });
  }
  // Back braces (X).
  const d1 = addBox(group, 0, h / 2, -d / 2 + 0.02, w * 1.4, 0.04, 0.04, mat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });
  d1.rotation.z = Math.atan2(h, w);
  const d2 = addBox(group, 0, h / 2, -d / 2 + 0.02, w * 1.4, 0.04, 0.04, mat, {
    surface: "metal", materialSlug: "sheet_metal", collider: true, raycast: false,
  });
  d2.rotation.z = -Math.atan2(h, w);

  registerGroupCollider(bctx, group);
  return group;
}

/** Skybridge — enclosed walkway between buildings. */
export function buildSkybridge(bctx: BuildContext, x: number, y: number, z: number, length = 10, rotY = 0): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const bodyMat = bctx.matCache.getMaterial("concrete");
  const glassMat = bctx.matCache.getMaterial("glass");
  const w = 2.4, h = 2.6;
  // Floor.
  addBox(group, 0, -h / 2, 0, length, 0.2, w, bodyMat, { surface: "concrete", materialSlug: "concrete", collider: true });
  // Roof.
  addBox(group, 0, h / 2, 0, length, 0.2, w, bodyMat, { surface: "concrete", materialSlug: "concrete", collider: true });
  // Side walls (low, with glass above).
  for (const sz of [-1, 1]) {
    addBox(group, 0, -h / 2 + 0.5, sz * (w / 2 - 0.05), length, 1.0, 0.1, bodyMat, {
      surface: "concrete", materialSlug: "concrete", collider: true,
    });
  }
  // Glass upper walls.
  const glassGeo = new THREE.PlaneGeometry(length - 0.4, 1.2);
  for (const sz of [-1, 1]) {
    const g = new THREE.Mesh(glassGeo, glassMat);
    g.position.set(0, 0.3, sz * (w / 2 + 0.01));
    g.castShadow = false;
    group.add(g);
  }
  // End walls (with door openings).
  for (const sx of [-1, 1]) {
    addBox(group, sx * (length / 2 - 0.05), 0, 0, 0.1, h, w, bodyMat, {
      surface: "concrete", materialSlug: "concrete", collider: true,
    });
  }

  registerTaggedColliders(bctx, group);
  return group;
}

// ============================================================
// Task-6 — Interactive props: breakable glass + jump pads
// ============================================================

/**
 * Breakable glass panel — transparent, shatters on bullet/grenade hit.
 *
 * Registered as a destructible with low HP so the existing DestructibleSystem
 * handles the hit + shatter response. The material uses the cached "glass"
 * tint (semi-transparent, low opacity) so it reads as a real pane of glass.
 * A thin frame surrounds the pane (drawn from the cached metal material) so
 * the panel reads as a mounted window, not a floating sheet.
 *
 * The panel is bullet-permeable before breaking — bullets raycast against
 * the destructible parent mesh (registered as a collider) so they correctly
 * register a hit + apply damage. After HP drops to 0 the destructible system
 * removes the mesh, opening the sightline.
 *
 * @param w  Width (X) of the pane.
 * @param h  Height (Y) of the pane.
 * @param hp Hit points before shatter (default 30 = 1-2 bullets).
 * @param rotY Yaw rotation (orient the pane in any direction).
 * @param tint Optional color tint (defaults to the standard glass tint).
 */
export function buildGlassPanel(
  bctx: BuildContext, x: number, y: number, z: number,
  w = 3, h = 2, hp = 30, rotY = 0, tint?: number,
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y + h / 2, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  // Glass pane — semi-transparent MeshStandardMaterial. We clone the cached
  // "glass" material so a per-panel tint doesn't leak to other glass props.
  const glassBase = bctx.matCache.getMaterial("glass") as THREE.MeshStandardMaterial;
  const glassMat = tint !== undefined
    ? glassBase.clone()
    : glassBase;
  if (tint !== undefined) {
    glassMat.color = new THREE.Color(tint);
  }
  // Pane geometry — thin along Z, wide along X + Y. Frame thickness 0.04m.
  const t = 0.04;
  const pane = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), glassMat);
  pane.castShadow = false;       // glass doesn't cast visible shadows
  pane.receiveShadow = false;
  pane.userData.surfaceType = "glass";
  pane.userData.materialSlug = "glass";
  pane.userData.destructible = true;
  pane.userData.isGlassPanel = true;
  group.add(pane);

  // Thin metal frame (4 strips around the pane). Frame is non-destructible
  // and not raycast so the pane is the only hit target on this prop.
  const frameMat = bctx.matCache.getMaterial("metal");
  const fw = 0.06;
  // Top + bottom strips.
  for (const fy of [h / 2 + fw / 2, -h / 2 - fw / 2]) {
    const strip = addBox(group, 0, fy, 0, w + fw * 2, fw, t + 0.01, frameMat, {
      surface: "metal", materialSlug: "metal", raycast: false,
    });
    strip.castShadow = true;
  }
  // Left + right strips.
  for (const fx of [w / 2 + fw / 2, -w / 2 - fw / 2]) {
    const strip = addBox(group, fx, 0, 0, fw, h, t + 0.01, frameMat, {
      surface: "metal", materialSlug: "metal", raycast: false,
    });
    strip.castShadow = true;
  }

  // Register the pane as a destructible so DestructibleSystem handles damage.
  // Use a temporary world-position registration: the destructible system
  // expects the mesh to be in world space, so we register a collider from
  // the pane's world bounding box (computed via setFromObject on the pane).
  const collider: Collider = { box: new THREE.Box3().setFromObject(pane) };
  bctx.colliders.push(collider);
  const prop: DestructibleProp = {
    mesh: pane,
    health: hp,
    maxHealth: hp,
    materialSlug: "glass",
    stage: 0,
    collider,
    baseScale: 1,
  };
  bctx.destructibles.push(prop);

  return group;
}

/**
 * Jump pad — cylindrical pad that boosts the player upward when stepped on.
 *
 * Visual: a low cylindrical disk (radius ~1.2m, height 0.2m) with a glowing
 * top ring + concentric circle texture. The disk is a solid collider so the
 * player can stand on it; the top face is tagged `userData.isJumpPad = true`
 * + `userData.jumpPadForce = 12` (m/s upward velocity) so the engine's
 * player-physics loop can detect the step-on event and apply the boost.
 *
 * Synergy with grenade boosting: a player who grenade-boosts onto a jump pad
 * gets a stacked upward velocity, reaching otherwise inaccessible rooftops.
 *
 * The boost value is intentionally tuned (12 m/s) so a single pad lifts the
 * player ~7m — enough to clear a one-story rooftop or skybridge. The pad
 * also has a 0.5s cooldown (userData.jumpPadCooldown) so bounce-camping
 * doesn't trivialize verticality.
 *
 * @param radius Pad radius (default 1.2m).
 */
export function buildJumpPad(
  bctx: BuildContext, x: number, y: number, z: number, radius = 1.2,
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  bctx.scene.add(group);

  // ── Pad base (solid disk — registered as a collider so the player can
  //    stand on it. Top face is tagged as a jump pad for engine pickup.)
  const baseMat = bctx.matCache.getMaterial("oliveDark");
  const baseH = 0.2;
  const base = addCyl(group, 0, baseH / 2, 0, radius, radius, baseH, 24, baseMat, {
    surface: "metal", materialSlug: "metal", collider: true,
  });
  base.userData.isJumpPad = true;
  base.userData.jumpPadForce = 12;        // m/s upward boost
  base.userData.jumpPadCooldown = 0.5;    // seconds between boosts
  base.userData.jumpPadLastTrigger = 0;   // last trigger time (perf.now ms)

  // ── Glowing top ring (visual indicator that this pad is interactive).
  //    Drawn as a thin torus using a MeshBasicMaterial so it reads as an
  //    emissive LED ring regardless of scene lighting.
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x2af0c8 });
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.85, 0.04, 8, 32),
    ringMat,
  );
  ring.position.set(0, baseH + 0.01, 0);
  ring.rotation.x = Math.PI / 2; // lay flat
  ring.castShadow = false;
  ring.receiveShadow = false;
  noRaycast(ring);
  group.add(ring);

  // ── Concentric circle texture on the top face — procedural CanvasTexture
  //    so the pad reads as a "launch pad" with visible mechanics (target
  //    reticle + hazard stripes) without needing an external asset.
  const topTex = getJumpPadTopTexture();
  const topMat = new THREE.MeshStandardMaterial({
    map: topTex,
    emissive: 0x2af0c8,
    emissiveMap: topTex,
    emissiveIntensity: 0.6,
    roughness: 0.4,
    metalness: 0.3,
  });
  const top = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.78, 24),
    topMat,
  );
  top.position.set(0, baseH + 0.005, 0);
  top.rotation.x = -Math.PI / 2; // face up
  top.castShadow = false;
  top.receiveShadow = false;
  noRaycast(top);
  group.add(top);

  // ── Side hazard stripes — 4 thin yellow/black chevrons around the rim
  //    so the pad is visible from any angle (not just top-down).
  const stripeMat = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.05, 0.05),
      stripeMat,
    );
    stripe.position.set(
      Math.cos(angle) * radius * 0.95,
      baseH * 0.5,
      Math.sin(angle) * radius * 0.95,
    );
    stripe.rotation.y = -angle + Math.PI / 2;
    stripe.castShadow = false;
    noRaycast(stripe);
    group.add(stripe);
  }

  return group;
}

/** Cached top-face CanvasTexture for jump pads. Concentric rings +
 *  hazard chevrons + center reticle. */
let _jumpPadTopTex: THREE.Texture | null = null;
export function getJumpPadTopTexture(): THREE.Texture {
  if (_jumpPadTopTex) return _jumpPadTopTex;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Background — dark olive.
  ctx.fillStyle = "#1a1f14";
  ctx.fillRect(0, 0, size, size);
  // Concentric rings (4 — alternating dark + light).
  const cx = size / 2, cy = size / 2;
  for (let i = 4; i >= 1; i--) {
    ctx.beginPath();
    ctx.arc(cx, cy, (i / 4) * (size / 2 - 8), 0, Math.PI * 2);
    ctx.strokeStyle = i % 2 === 0 ? "#2af0c8" : "#1a4a3a";
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  // Center reticle — crosshair.
  ctx.strokeStyle = "#2af0c8";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 24, cy); ctx.lineTo(cx + 24, cy);
  ctx.moveTo(cx, cy - 24); ctx.lineTo(cx, cy + 24);
  ctx.stroke();
  // Center dot.
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#2af0c8";
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _jumpPadTopTex = tex;
  return tex;
}

// ============================================================
// Task-6 — AMK easter egg.
//
// Adds a hidden "AMK" spray-paint decal to every map at one unique spot
// deterministically chosen from map.slug via mulberry32. The decal is a
// flat plane with a CanvasTexture (spray-paint + drip style) and is
// placed on a vertical surface near a chosen prop (container / building
// wall / crate side) so it reads as graffiti, not a floating billboard.
//
// The decal is small (~1m wide), uses additive-free transparent blending,
// and is rotated to face away from the player spawn so it's findable
// only by explorers. userData.isAMKEasterEgg = true lets the engine
// detect "found" events in the future.
// ============================================================

/** Cached CanvasTexture for the AMK decal — spray-paint style with a
 *  rough edge + drip, sized 256x256. */
let _amkDecalTex: THREE.Texture | null = null;
export function getAMKDecalTexture(): THREE.Texture {
  if (_amkDecalTex) return _amkDecalTex;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Fully transparent background — only the painted pixels render.
  ctx.clearRect(0, 0, size, size);
  // Spray-paint "AMK" in a heavy stencil font. Use a layered approach:
  // first a darker "shadow" layer (offset by 2px), then the bright top
  // layer. This simulates real spray paint where ink leaks under the
  // stencil edges.
  const drawStencil = (color: string, dx: number, dy: number) => {
    ctx.fillStyle = color;
    ctx.font = "bold 110px Arial Black, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Add subtle per-letter splatter by drawing each glyph multiple times
    // with tiny random offsets.
    const letters = ["A", "M", "K"];
    const spacing = 64;
    letters.forEach((ch, i) => {
      const lx = size / 2 + (i - 1) * spacing + dx;
      const ly = size / 2 + dy;
      for (let s = 0; s < 8; s++) {
        const jx = (Math.random() - 0.5) * 6;
        const jy = (Math.random() - 0.5) * 6;
        ctx.fillText(ch, lx + jx, ly + jy);
      }
    });
  };
  // Dark under-layer (offset).
  drawStencil("rgba(20, 14, 10, 0.85)", 2, 3);
  // Bright top layer — neon magenta so it reads as graffiti.
  drawStencil("rgba(220, 40, 180, 0.95)", 0, 0);
  // Add a few drip blobs below the letters.
  ctx.fillStyle = "rgba(180, 30, 150, 0.75)";
  for (let i = 0; i < 6; i++) {
    const dx = 60 + Math.random() * 136;
    const dy = 160 + Math.random() * 50;
    const r = 2 + Math.random() * 4;
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Tiny "found me?" inscription in the corner.
  ctx.fillStyle = "rgba(220, 220, 220, 0.55)";
  ctx.font = "italic 12px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText("— you found me —", size - 12, size - 10);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _amkDecalTex = tex;
  return tex;
}

/**
 * Add the AMK easter-egg decal to the map at a unique hidden spot.
 *
 * Picks a target prop from the map's prop list (prefers containers,
 * buildings, and large crates — surfaces big enough for graffiti) using a
 * deterministic mulberry32 hash of `map.slug + "_amk"` so each map's
 * decal is at a fixed, findable location. The decal is placed on the
 * side of the chosen prop facing away from the player spawn (so it's
 * behind the obvious cover, not in plain sight).
 *
 * The decal is a flat plane (~1m wide) with the cached AMK CanvasTexture
 * + transparent alpha. It's marked `userData.isAMKEasterEgg = true` so
 * future engine code can detect "found" events + reward the player.
 */
export function addAMKEasterEgg(
  map: MapDefinition,
  scene: THREE.Scene,
): THREE.Object3D | null {
  // Deterministic RNG from map slug.
  const rng = mulberry32(hashString(map.slug + "_amk"));

  // Preferred prop types for placing the decal — surfaces large enough to
  // host a 1m-wide graffiti tag + visible from the side.
  const preferredTypes = ["container", "building", "crate_stack", "hesco", "sandbag_wall", "skybridge", "pallet"];
  const candidates = map.props.filter((p) => preferredTypes.includes(p.type));
  if (candidates.length === 0) return null;

  // Pick a random candidate (deterministic via rng).
  const target = candidates[Math.floor(rng() * candidates.length)];
  const [px, py, pz] = target.position;

  // Compute the surface normal — we want to place the decal on the side
  // of the prop facing AWAY from the player spawn, so the player has to
  // walk around it to find the decal.
  const [sx, , sz] = map.playerSpawn;
  const dx = px - sx;
  const dz = pz - sz;
  const len = Math.hypot(dx, dz) || 1;
  // Direction from spawn to prop — decal faces the same direction (away
  // from spawn) so it's on the far side of the prop.
  const nx = dx / len;
  const nz = dz / len;

  // Offset from the prop center along the surface normal so the decal
  // sits just outside the prop's surface. Use a generous offset (1.6m) so
  // the decal clearly clears the prop geometry regardless of prop size.
  const offset = 1.6;
  // Vertical offset — push the decal up to roughly chest height (1.4m) on
  // the prop's side. For low props (pallet, sandbag_wall), this places the
  // decal just above the prop top so it reads as graffiti on the wall
  // behind, not on the prop itself.
  const yOffset = 1.4;

  const decalX = px + nx * offset;
  const decalY = py + yOffset;
  const decalZ = pz + nz * offset;

  // Decal mesh — flat plane (1m wide, 1m tall) facing back toward the prop.
  const tex = getAMKDecalTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,        // don't occlude props behind
    polygonOffset: true,      // prevent z-fighting with prop surface
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), mat);
  decal.position.set(decalX, decalY, decalZ);
  // Rotate so the plane faces back toward the prop (i.e. its normal
  // points back toward the prop, which is at -nx,-nz from the decal).
  decal.rotation.y = Math.atan2(nx, nz) + Math.PI;
  decal.castShadow = false;
  decal.receiveShadow = false;
  decal.userData.isAMKEasterEgg = true;
  decal.userData.amkMapSlug = map.slug;
  // Disable raycast so bullets don't hit the decal (it's purely cosmetic).
  noRaycast(decal);
  scene.add(decal);
  return decal;
}

// ============================================================
// Lighting + clear (with floor enforcement)
// ============================================================

/** Apply a map's lighting configuration to the scene.
 *  Enforces visibility floor per Lead constraint:
 *    sun intensity >= 1.0, hemi intensity >= 0.5, fog density <= 0.015. */
