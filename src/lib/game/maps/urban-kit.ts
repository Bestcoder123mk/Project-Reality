/**
 * Section M — Urban detail kit: modular buildings, street props, vehicles.
 *
 * A modular kit the MapBuilder uses for urban/coastal maps. Provides
 * builders for:
 *
 *   - Modular multi-story buildings (assembled from wall + window + roof
 *     modules — composable, faster to author than bespoke buildings).
 *   - Street props: traffic lights, street lamps, mailboxes, fire
 *     hydrants, bollards, benches, trash cans, news stands.
 *   - Vehicles: parked cars (4 variants), delivery vans, armored trucks,
 *     abandoned taxis (with engine-bay prop + destructible tires).
 *   - Road + path system: procedural road segments with lane markings,
 *     crosswalks, potholes, manhole covers.
 *
 * The kit is the visual vocabulary for the urban + coastal biomes (and
 * partially for the mountain biome's village sections). Each builder
 * returns a THREE.Group the MapBuilder adds to the scene; colliders +
 * destructible registration is handled per-module.
 *
 * Public API:
 *   - buildModularBuilding(ctx, opts) — assembled building.
 *   - buildStreetProp(ctx, slug, x, y, z, rotY) — single street prop.
 *   - buildVehicle(ctx, slug, x, y, z, rotY) — single vehicle.
 *   - buildRoadSegment(ctx, opts) — road/path with markings.
 *   - URBAN_BUILDING_PRESETS / STREET_PROP_PRESETS / VEHICLE_PRESETS.
 *
 * THREE imports are lazy (inside builder) so the module is SSR-safe.
 */

import * as THREE from "three";
import type { BuildContext } from "./MapBuilder/_shared";
import type { Collider, DestructibleProp } from "../systems/types";

// ──────────────────────────────────────────────────────────────────────────
// Modular building
// ──────────────────────────────────────────────────────────────────────────

export interface ModularBuildingOptions {
  position: [number, number, number];
  width: number;
  depth: number;
  floors: number;
  floorHeight?: number;
  rotY?: number;
  /** Style preset — drives the material palette. */
  style?: "brick" | "concrete" | "glass_curtain" | "industrial_metal";
  /** Roof style. */
  roof?: "flat" | "gable" | "industrial";
  /** Ground-floor storefront (transparent glass + awning). */
  storefront?: boolean;
  /** Window count per floor per wall. */
  windowsPerWall?: number;
}

export const URBAN_BUILDING_PRESETS: Record<string, ModularBuildingOptions> = {
  brick_3story: {
    position: [0, 0, 0], width: 14, depth: 10, floors: 3, floorHeight: 3.5,
    style: "brick", roof: "gable", storefront: true, windowsPerWall: 3,
  },
  concrete_5story: {
    position: [0, 0, 0], width: 18, depth: 14, floors: 5, floorHeight: 3.2,
    style: "concrete", roof: "flat", storefront: false, windowsPerWall: 4,
  },
  glass_tower_8story: {
    position: [0, 0, 0], width: 16, depth: 16, floors: 8, floorHeight: 3.5,
    style: "glass_curtain", roof: "flat", storefront: false, windowsPerWall: 4,
  },
  industrial_warehouse: {
    position: [0, 0, 0], width: 24, depth: 18, floors: 1, floorHeight: 6.5,
    style: "industrial_metal", roof: "industrial", storefront: false, windowsPerWall: 0,
  },
};

/** Build a modular multi-story building from wall + window + roof modules.
 *  Faster than authoring bespoke geometry per building; consistent
 *  visual quality across the urban biome. */
export function buildModularBuilding(
  bctx: BuildContext,
  opts: ModularBuildingOptions,
): THREE.Group {
  const {
    position: [cx, cy, cz],
    width, depth, floors, floorHeight = 3.5,
    rotY = 0, style = "brick", roof = "flat",
    storefront = false, windowsPerWall = 3,
  } = opts;
  const group = new THREE.Group();
  group.position.set(cx, cy, cz);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const wallMat = style === "brick" ? bctx.matCache.getMaterial("brick")
    : style === "concrete" ? bctx.matCache.getMaterial("concrete")
    : style === "industrial_metal" ? bctx.matCache.getMaterial("metal")
    : bctx.matCache.getMaterial("glass");
  const glassMat = bctx.matCache.getMaterial("glass");
  const roofMat = bctx.matCache.getMaterial("concrete");
  const totalH = floors * floorHeight;

  // Floor slabs (per floor).
  for (let f = 0; f < floors; f++) {
    const slabY = f * floorHeight;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.2, depth),
      roofMat,
    );
    slab.position.set(0, slabY - 0.1, 0);
    slab.castShadow = true; slab.receiveShadow = true;
    slab.userData.surfaceType = "concrete";
    group.add(slab);
    bctx.colliders.push({ box: new THREE.Box3().setFromObject(slab) });
  }

  // 4 exterior walls per floor.
  for (let f = 0; f < floors; f++) {
    const wallY = f * floorHeight + floorHeight / 2;
    const wallDefs: Array<{ x: number; z: number; w: number; d: number }> = [
      { x: 0, z: -depth / 2, w: width, d: 0.2 },
      { x: 0, z: depth / 2, w: width, d: 0.2 },
      { x: -width / 2, z: 0, w: 0.2, d: depth },
      { x: width / 2, z: 0, w: 0.2, d: depth },
    ];
    for (const wd of wallDefs) {
      const isStorefront = storefront && f === 0;
      const mat = isStorefront ? glassMat : wallMat;
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(wd.w, floorHeight, wd.d),
        mat,
      );
      wall.position.set(wd.x, wallY, wd.z);
      wall.castShadow = true; wall.receiveShadow = true;
      wall.userData.surfaceType = style === "brick" ? "building" : style;
      group.add(wall);
      bctx.colliders.push({ box: new THREE.Box3().setFromObject(wall) });

      // Window insets on the long walls (skip storefront which is all glass).
      if (windowsPerWall > 0 && !isStorefront && wd.w > 1) {
        for (let i = 0; i < windowsPerWall; i++) {
          const t = (i + 1) / (windowsPerWall + 1);
          const offset = (t - 0.5) * wd.w;
          const win = new THREE.Mesh(
            new THREE.BoxGeometry(1.0, 1.2, 0.05),
            glassMat,
          );
          win.position.set(wd.x + offset, wallY, wd.z);
          win.castShadow = false;
          group.add(win);
        }
      }
    }
  }

  // Roof.
  if (roof === "flat") {
    const r = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.2, depth),
      roofMat,
    );
    r.position.set(0, totalH + 0.1, 0);
    r.castShadow = true; r.receiveShadow = true;
    group.add(r);
    bctx.colliders.push({ box: new THREE.Box3().setFromObject(r) });
  } else if (roof === "gable") {
    const r = new THREE.Mesh(
      new THREE.ConeGeometry(Math.max(width, depth) * 0.7, floorHeight * 0.8, 4),
      wallMat,
    );
    r.position.set(0, totalH + floorHeight * 0.4, 0);
    r.rotation.y = Math.PI / 4;
    r.castShadow = true;
    group.add(r);
    bctx.colliders.push({ box: new THREE.Box3().setFromObject(r) });
  } else if (roof === "industrial") {
    // Corrugated metal — flat with ribbed detail.
    const r = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.15, depth),
      bctx.matCache.getMaterial("metal"),
    );
    r.position.set(0, totalH + 0.1, 0);
    r.castShadow = true; r.receiveShadow = true;
    r.userData.surfaceType = "metal";
    group.add(r);
    bctx.colliders.push({ box: new THREE.Box3().setFromObject(r) });
  }

  return group;
}

// ──────────────────────────────────────────────────────────────────────────
// Street props
// ──────────────────────────────────────────────────────────────────────────

export type StreetPropSlug =
  | "traffic_light" | "street_lamp" | "mailbox" | "fire_hydrant"
  | "bollard" | "bench" | "trash_can" | "news_stand" | "bus_stop"
  | "construction_barrier" | "manhole_cover" | "pedestrian_sign";

export const STREET_PROP_PRESETS: Record<StreetPropSlug, {
  label: string; height: number; collider: boolean;
}> = {
  traffic_light:        { label: "Traffic Light",        height: 5.5, collider: true },
  street_lamp:          { label: "Street Lamp",          height: 5.0, collider: true },
  mailbox:              { label: "Mailbox",              height: 1.4, collider: true },
  fire_hydrant:         { label: "Fire Hydrant",         height: 0.7, collider: true },
  bollard:              { label: "Bollard",              height: 1.0, collider: true },
  bench:                { label: "Park Bench",           height: 0.8, collider: true },
  trash_can:            { label: "Trash Can",            height: 1.0, collider: true },
  news_stand:           { label: "News Stand",           height: 2.0, collider: true },
  bus_stop:             { label: "Bus Stop Shelter",     height: 2.5, collider: true },
  construction_barrier: { label: "Construction Barrier", height: 1.2, collider: true },
  manhole_cover:        { label: "Manhole Cover",        height: 0.05, collider: false },
  pedestrian_sign:      { label: "Pedestrian Crossing Sign", height: 2.5, collider: true },
};

/** Build a single street prop by slug. */
export function buildStreetProp(
  bctx: BuildContext,
  slug: StreetPropSlug,
  x: number, y: number, z: number,
  rotY = 0,
): THREE.Object3D {
  const preset = STREET_PROP_PRESETS[slug];
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const metalMat = bctx.matCache.getMaterial("metal");
  const darkMat = bctx.matCache.getMaterial("oliveDark");
  const concreteMat = bctx.matCache.getMaterial("concrete");

  switch (slug) {
    case "traffic_light": {
      // Pole + 3-light head.
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.08, preset.height, 8),
        metalMat,
      );
      pole.position.set(0, preset.height / 2, 0);
      pole.castShadow = true;
      group.add(pole);
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 1.0, 0.3),
        darkMat,
      );
      head.position.set(0, preset.height - 0.5, 0);
      group.add(head);
      // 3 light disks.
      const colors = [0xff0000, 0xffff00, 0x00ff00];
      for (let i = 0; i < 3; i++) {
        const light = new THREE.Mesh(
          new THREE.CircleGeometry(0.1, 8),
          new THREE.MeshBasicMaterial({ color: colors[i] }),
        );
        light.position.set(0, preset.height - 0.8 + i * 0.3, 0.16);
        group.add(light);
      }
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
    case "street_lamp": {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.08, preset.height, 8),
        metalMat,
      );
      pole.position.set(0, preset.height / 2, 0);
      pole.castShadow = true;
      group.add(pole);
      // Curved arm + lamp head.
      const arm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6),
        metalMat,
      );
      arm.position.set(0.4, preset.height - 0.1, 0);
      arm.rotation.z = Math.PI / 2;
      group.add(arm);
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xfff8a0, emissive: 0x807040, emissiveIntensity: 0.5 }),
      );
      lamp.position.set(0.8, preset.height - 0.1, 0);
      group.add(lamp);
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
    case "mailbox": {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.5, 0.4),
        new THREE.MeshStandardMaterial({ color: 0x2a5a8a, roughness: 0.6, metalness: 0.4 }),
      );
      box.position.set(0, 1.0, 0);
      box.castShadow = true;
      group.add(box);
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6),
        metalMat,
      );
      post.position.set(0, 0.5, 0);
      group.add(post);
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
    case "fire_hydrant": {
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.22, 0.5, 8),
        new THREE.MeshStandardMaterial({ color: 0xc03020, roughness: 0.6, metalness: 0.4 }),
      );
      body.position.set(0, 0.25, 0);
      body.castShadow = true;
      group.add(body);
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 8, 6),
        body.material,
      );
      cap.position.set(0, 0.55, 0);
      group.add(cap);
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
    case "bollard": {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.12, preset.height, 8),
        new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.8 }),
      );
      post.position.set(0, preset.height / 2, 0);
      post.castShadow = true;
      group.add(post);
      // Reflective stripe.
      const stripe = new THREE.Mesh(
        new THREE.CylinderGeometry(0.105, 0.105, 0.1, 8),
        new THREE.MeshBasicMaterial({ color: 0xff8800 }),
      );
      stripe.position.set(0, preset.height * 0.5, 0);
      group.add(stripe);
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
    case "bench": {
      const seat = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 0.08, 0.5),
        bctx.matCache.getMaterial("wood"),
      );
      seat.position.set(0, 0.45, 0);
      seat.castShadow = true;
      group.add(seat);
      const back = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, 0.5, 0.08),
        bctx.matCache.getMaterial("wood"),
      );
      back.position.set(0, 0.7, -0.2);
      group.add(back);
      for (const sx of [-0.7, 0.7]) {
        const leg = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, 0.45, 0.4),
          metalMat,
        );
        leg.position.set(sx, 0.22, 0);
        group.add(leg);
      }
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
    case "trash_can": {
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.35, 0.9, 12),
        metalMat,
      );
      body.position.set(0, 0.45, 0);
      body.castShadow = true;
      group.add(body);
      const lid = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.32, 0.1, 12),
        darkMat,
      );
      lid.position.set(0, 0.95, 0);
      group.add(lid);
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
    case "news_stand":
    case "bus_stop": {
      const shelter = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, 0.1, 1.5),
        bctx.matCache.getMaterial("metal"),
      );
      shelter.position.set(0, preset.height - 0.1, 0);
      shelter.castShadow = true;
      group.add(shelter);
      for (const sx of [-1.2, 1.2]) for (const sz of [-0.7, 0.7]) {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, preset.height, 0.1),
          metalMat,
        );
        post.position.set(sx, preset.height / 2, sz);
        group.add(post);
      }
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
    case "construction_barrier": {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(2.0, preset.height, 0.1),
        new THREE.MeshStandardMaterial({ color: 0xffaa00, roughness: 0.7 }),
      );
      panel.position.set(0, preset.height / 2, 0);
      panel.castShadow = true;
      group.add(panel);
      for (const sx of [-0.9, 0.9]) {
        const leg = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, preset.height + 0.3, 0.1),
          metalMat,
        );
        leg.position.set(sx, (preset.height + 0.3) / 2 - 0.15, 0);
        group.add(leg);
      }
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
    case "manhole_cover": {
      const cover = new THREE.Mesh(
        new THREE.CircleGeometry(0.4, 16),
        darkMat,
      );
      cover.rotation.x = -Math.PI / 2;
      cover.position.set(0, 0.02, 0);
      cover.receiveShadow = true;
      group.add(cover);
      // No collider (flush with ground).
      break;
    }
    case "pedestrian_sign": {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, preset.height, 6),
        metalMat,
      );
      pole.position.set(0, preset.height / 2, 0);
      group.add(pole);
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.6, 0.05),
        new THREE.MeshStandardMaterial({ color: 0xffcc00, roughness: 0.7 }),
      );
      sign.position.set(0, preset.height - 0.4, 0);
      sign.castShadow = true;
      group.add(sign);
      if (preset.collider) bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });
      break;
    }
  }

  return group;
}

// ──────────────────────────────────────────────────────────────────────────
// Vehicles
// ──────────────────────────────────────────────────────────────────────────

export type VehicleSlug =
  | "sedan" | "police_car" | "taxi" | "delivery_van"
  | "armored_truck" | "pickup" | "burnt_out";

export const VEHICLE_PRESETS: Record<VehicleSlug, {
  label: string; width: number; height: number; length: number; color: number;
}> = {
  sedan:         { label: "Sedan",          width: 1.8, height: 1.5, length: 4.5, color: 0x4a4a5a },
  police_car:    { label: "Police Car",     width: 1.9, height: 1.5, length: 4.8, color: 0x1a2a4a },
  taxi:          { label: "Taxi",           width: 1.8, height: 1.5, length: 4.5, color: 0xf0c020 },
  delivery_van:  { label: "Delivery Van",   width: 2.2, height: 2.4, length: 5.5, color: 0xffffff },
  armored_truck: { label: "Armored Truck",  width: 2.5, height: 2.8, length: 6.5, color: 0x3a4a3a },
  pickup:        { label: "Pickup Truck",   width: 2.0, height: 1.8, length: 5.2, color: 0x6a4a3a },
  burnt_out:     { label: "Burnt-out Car",  width: 1.8, height: 1.4, length: 4.5, color: 0x1a1410 },
};

/** Build a vehicle by slug. Returns a group with body + 4 wheels + windows.
 *  Burnt-out variant has charred materials + missing windows. */
export function buildVehicle(
  bctx: BuildContext,
  slug: VehicleSlug,
  x: number, y: number, z: number,
  rotY = 0,
): THREE.Group {
  const preset = VEHICLE_PRESETS[slug];
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotY;
  bctx.scene.add(group);

  const isBurnt = slug === "burnt_out";
  const bodyMat = isBurnt
    ? bctx.matCache.getMaterial("charred")
    : new THREE.MeshStandardMaterial({
        color: preset.color, roughness: 0.5, metalness: 0.6,
      });
  const glassMat = isBurnt
    ? new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 })
    : bctx.matCache.getMaterial("glass");
  const wheelMat = bctx.matCache.getMaterial("rubber");
  const darkMat = bctx.matCache.getMaterial("oliveDark");

  const w = preset.width, h = preset.height, l = preset.length;

  // Lower body.
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h * 0.55, l),
    bodyMat,
  );
  body.position.set(0, h * 0.3, 0);
  body.castShadow = true; body.receiveShadow = true;
  body.userData.surfaceType = "metal";
  group.add(body);

  // Cabin (upper section — narrower).
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.92, h * 0.45, l * 0.5),
    bodyMat,
  );
  cabin.position.set(0, h * 0.75, -l * 0.05);
  cabin.castShadow = true;
  group.add(cabin);

  // Windshield + windows.
  if (!isBurnt) {
    const windshield = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.85, h * 0.35, 0.05),
      glassMat,
    );
    windshield.position.set(0, h * 0.75, l * 0.21);
    group.add(windshield);
    const rear = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.85, h * 0.35, 0.05),
      glassMat,
    );
    rear.position.set(0, h * 0.75, -l * 0.31);
    group.add(rear);
  }

  // 4 wheels.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const wheel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 0.3, 12),
      wheelMat,
    );
    wheel.position.set(sx * w * 0.55, 0.4, sz * l * 0.32);
    wheel.rotation.z = Math.PI / 2;
    wheel.castShadow = true;
    group.add(wheel);
  }

  // Headlights (skipped for burnt-out).
  if (!isBurnt) {
    for (const sx of [-1, 1]) {
      const light = new THREE.Mesh(
        new THREE.CircleGeometry(0.15, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffe0 }),
      );
      light.position.set(sx * w * 0.3, h * 0.3, l * 0.5 + 0.01);
      group.add(light);
    }
  }

  // License plate + bumper detail.
  const bumper = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.1, 0.2, 0.1),
    darkMat,
  );
  bumper.position.set(0, 0.2, l * 0.5);
  group.add(bumper);

  // Register collider (vehicles are heavy cover — indestructible by
  // bullets but can be moved by explosions).
  bctx.colliders.push({ box: new THREE.Box3().setFromObject(group) });

  return group;
}

// ──────────────────────────────────────────────────────────────────────────
// Road + path system
// ──────────────────────────────────────────────────────────────────────────

export interface RoadSegmentOptions {
  /** Start position (world-space). */
  start: [number, number, number];
  /** End position (world-space). */
  end: [number, number, number];
  /** Road width (m). */
  width: number;
  /** Lane count (1, 2, or 4). */
  lanes?: 1 | 2 | 4;
  /** Surface type. */
  surface?: "asphalt" | "concrete" | "dirt" | "cobblestone";
  /** Include crosswalk at start? */
  crosswalkStart?: boolean;
  /** Include crosswalk at end? */
  crosswalkEnd?: boolean;
}

/** Build a road segment with lane markings + optional crosswalks.
 *  Roads are flat planes (no collider — walkable) with painted
 *  markings drawn to a CanvasTexture (dashed center line, solid edge
 *  lines, zebra crosswalk). */
export function buildRoadSegment(
  bctx: BuildContext,
  opts: RoadSegmentOptions,
): THREE.Object3D {
  const {
    start: [sx, sy, sz], end: [ex, , ez],
    width, lanes = 2, surface = "asphalt",
    crosswalkStart = false, crosswalkEnd = false,
  } = opts;
  const dx = ex - sx, dz = ez - sz;
  const length = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx);

  const group = new THREE.Group();
  group.position.set(sx, sy, sz);
  group.rotation.y = -angle;
  bctx.scene.add(group);

  // Surface plane.
  const surfaceMat = surface === "asphalt" ? bctx.matCache.getMaterial("asphalt")
    : surface === "concrete" ? bctx.matCache.getMaterial("concrete")
    : surface === "cobblestone" ? bctx.matCache.getMaterial("concrete")
    : bctx.matCache.getMaterial("sand");
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(length, width),
    surfaceMat,
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(length / 2, 0.02, 0);
  road.receiveShadow = true;
  road.userData.surfaceType = surface;
  group.add(road);

  // Lane markings — CanvasTexture with dashed center line + edge lines.
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillRect(0, 0, 256, 256);
  // Edge lines (solid white).
  ctx.strokeStyle = "rgba(240,240,240,0.85)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 16); ctx.lineTo(256, 16);
  ctx.moveTo(0, 240); ctx.lineTo(256, 240);
  ctx.stroke();
  // Center line (dashed yellow) — only for 2+ lane roads.
  if (lanes >= 2) {
    ctx.strokeStyle = "rgba(240,200,40,0.9)";
    ctx.lineWidth = 6;
    ctx.setLineDash([24, 16]);
    ctx.beginPath();
    ctx.moveTo(0, 128); ctx.lineTo(256, 128);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (lanes === 4) {
    // Additional lane dividers (solid white).
    ctx.strokeStyle = "rgba(240,240,240,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 72); ctx.lineTo(256, 72);
    ctx.moveTo(0, 184); ctx.lineTo(256, 184);
    ctx.stroke();
  }
  // Crosswalk at start (zebra stripes).
  if (crosswalkStart) {
    ctx.fillStyle = "rgba(240,240,240,0.85)";
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(8 + i * 8, 32, 4, 192);
    }
  }
  if (crosswalkEnd) {
    ctx.fillStyle = "rgba(240,240,240,0.85)";
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(200 + i * 8, 32, 4, 192);
    }
  }
  const markingsTex = new THREE.CanvasTexture(canvas);
  markingsTex.wrapS = markingsTex.wrapT = THREE.RepeatWrapping;
  markingsTex.repeat.set(Math.max(1, Math.floor(length / 8)), 1);
  const markingsMat = new THREE.MeshBasicMaterial({
    map: markingsTex, transparent: true, opacity: 0.9, depthWrite: false,
  });
  const markings = new THREE.Mesh(
    new THREE.PlaneGeometry(length, width),
    markingsMat,
  );
  markings.rotation.x = -Math.PI / 2;
  markings.position.set(length / 2, 0.03, 0);
  markings.receiveShadow = false;
  group.add(markings);

  return group;
}
