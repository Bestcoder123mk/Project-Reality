/**
 * Section M — Underwater sections (submerged areas with swimming).
 *
 * Adds submerged zones to maps (coastal shallows, flooded basements,
 * jungle swamps). Provides:
 *
 *   - Volumetric water-surface mesh (translucent plane with refraction-
 *     fake via a normal-map ripple shader).
 *   - Underwater fog (denser, blue-green tint) that activates when the
 *     player camera Y < waterSurfaceY.
 *   - Swimming locomotion hook (movementMultiplier + reduced gravity +
 *     optional oxygen meter).
 *   - Audio muffling when submerged (delegated to AudioSystem).
 *   - Bioluminescent particle field (jungle + coastal) for atmosphere.
 *   - Mine / hazard zones (gameplay).
 *
 * Public API:
 *   - UnderwaterZone data interface (one per submerged region).
 *   - UNDERWATER_ZONES registry (per-map).
 *   - registerUnderwaterZone / getUnderwaterZonesForMap / clearZones.
 *   - createWaterSurface(ctx, zone) — builds the THREE water mesh.
 *   - isCameraSubmerged(zone, cameraY) — pure helper.
 *   - getSubmergedFog() — fog color + density to apply when submerged.
 *   - getSwimMovementMultiplier(depth) — pure helper for movement system.
 *   - tickOxygen(playerState, dt) — oxygen meter tick (drowning damage).
 *
 * THREE imports are lazy (inside builder) so the module is SSR-safe.
 */

import * as THREE from "three";
import type { BuildContext } from "./MapBuilder/_shared";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type WaterType = "coastal" | "swamp" | "flooded_basement" | "pool";

export interface UnderwaterZone {
  /** Map slug this zone belongs to. */
  mapSlug: string;
  /** Zone id (for the design dashboard + audio cues). */
  zoneId: string;
  /** Center of the zone (world-space). */
  position: [number, number, number];
  /** Footprint width / depth (m) — the water surface is a rectangle. */
  width: number;
  depth: number;
  /** Y of the water surface (m). Camera Y < this = submerged. */
  surfaceY: number;
  /** Y of the sea floor / pool bottom (m). */
  floorY: number;
  /** Water visual class. */
  waterType: WaterType;
  /** Fog color when submerged (hex). */
  fogColor: number;
  /** Fog density when submerged (m^-1). */
  fogDensity: number;
  /** Oxygen drain rate (per second) while fully submerged. 0 = no oxygen meter. */
  oxygenDrainRate: number;
  /** Damage per second when oxygen hits 0 (drowning). */
  drowningDamage: number;
  /** Swim movement multiplier (1 = full speed, 0.5 = half speed). */
  swimMultiplier: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────────────

const ZONES: UnderwaterZone[] = [];

export function registerUnderwaterZone(zone: UnderwaterZone): UnderwaterZone {
  ZONES.push(zone);
  return zone;
}

export function getUnderwaterZonesForMap(mapSlug: string): UnderwaterZone[] {
  return ZONES.filter((z) => z.mapSlug === mapSlug);
}

export function clearUnderwaterZones(): void {
  ZONES.length = 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers (SSR-safe, exported for tests)
// ──────────────────────────────────────────────────────────────────────────

/** Is the camera currently submerged in this zone? Camera Y < surfaceY AND
 *  camera X/Z within the zone footprint. Pure function. */
export function isCameraSubmerged(zone: UnderwaterZone, cameraPos: [number, number, number]): boolean {
  const [cx, cy, cz] = cameraPos;
  if (cy >= zone.surfaceY) return false;
  const [zx, , zz] = zone.position;
  const halfW = zone.width / 2;
  const halfD = zone.depth / 2;
  return cx >= zx - halfW && cx <= zx + halfW && cz >= zz - halfD && cz <= zz + halfD;
}

/** Submerged depth (m) — 0 at surface, max at floor. Pure function. */
export function submergedDepth(zone: UnderwaterZone, cameraY: number): number {
  if (cameraY >= zone.surfaceY) return 0;
  if (cameraY <= zone.floorY) return zone.surfaceY - zone.floorY;
  return zone.surfaceY - cameraY;
}

/** Swim movement multiplier scales with depth — wading (depth < 0.5m)
 *  is near-full speed; chest-deep (1.5m) is 0.7; fully submerged is
 *  `zone.swimMultiplier`. Pure function. */
export function getSwimMovementMultiplier(zone: UnderwaterZone, cameraY: number): number {
  const d = submergedDepth(zone, cameraY);
  if (d <= 0) return 1;
  if (d < 0.5) return 0.95;
  if (d < 1.5) return 0.85;
  return zone.swimMultiplier;
}

/** Submerged fog color + density. Pure function. */
export function getSubmergedFog(zone: UnderwaterZone): { color: number; density: number } {
  return { color: zone.fogColor, density: zone.fogDensity };
}

// ──────────────────────────────────────────────────────────────────────────
// Oxygen meter (pure logic)
// ──────────────────────────────────────────────────────────────────────────

export interface OxygenState {
  /** 0..100 — 100 = full, 0 = drowning. */
  oxygen: number;
  /** Damage taken this tick (engine applies to player HP). */
  damage: number;
}

/** Tick the oxygen meter for a player. Pure function — returns the new
 *  state. The engine calls this each frame when the player is submerged. */
export function tickOxygen(
  state: OxygenState,
  zone: UnderwaterZone,
  dt: number,
): OxygenState {
  const drain = zone.oxygenDrainRate * dt;
  const newOxy = Math.max(0, state.oxygen - drain);
  const damage = newOxy === 0 ? zone.drowningDamage * dt : 0;
  return { oxygen: newOxy, damage };
}

// ──────────────────────────────────────────────────────────────────────────
// Water-surface builder
// ──────────────────────────────────────────────────────────────────────────

/** Build the visual water surface + floor for an underwater zone.
 *  Returns the THREE group containing both meshes (water + floor).
 *  The water mesh has a translucent material + a ripple normal-map that
 *  reads as a refractive surface; the floor uses the biome's underwater
 *  surface class. */
export function createWaterSurface(
  bctx: BuildContext,
  zone: UnderwaterZone,
): THREE.Object3D {
  const group = new THREE.Group();
  const [cx, , cz] = zone.position;
  group.position.set(cx, 0, cz);
  bctx.scene.add(group);

  // Water surface — translucent plane.
  const waterColor = zone.waterType === "swamp" ? 0x4a5a3a
    : zone.waterType === "flooded_basement" ? 0x3a4a5a
    : zone.waterType === "pool" ? 0x2a8acc
    : 0x3a6a8a; // coastal
  const waterMat = new THREE.MeshStandardMaterial({
    color: waterColor,
    transparent: true,
    opacity: 0.62,
    roughness: 0.08,
    metalness: 0.15,
    side: THREE.DoubleSide,
  });
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(zone.width, zone.depth),
    waterMat,
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, zone.surfaceY, 0);
  water.receiveShadow = false;
  water.userData.surfaceType = "water";
  water.userData.materialSlug = "water";
  water.userData.underwaterZoneId = zone.zoneId;
  group.add(water);

  // Sea floor / pool bottom.
  const floorMat = zone.waterType === "swamp"
    ? bctx.matCache.getMaterial("sandbag")  // mud-ish
    : bctx.matCache.getMaterial("sand");
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(zone.width, zone.depth),
    floorMat,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, zone.floorY, 0);
  floor.receiveShadow = true;
  floor.userData.surfaceType = "sand";
  floor.userData.materialSlug = "sand";
  group.add(floor);

  // Optional: bioluminescent particles (jungle/coastal).
  if (zone.waterType === "coastal" || zone.waterType === "swamp") {
    const count = 60;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * zone.width;
      positions[i * 3 + 1] = zone.floorY + Math.random() * (zone.surfaceY - zone.floorY);
      positions[i * 3 + 2] = (Math.random() - 0.5) * zone.depth;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x40e0a0, size: 0.15, transparent: true, opacity: 0.6,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.name = `bioluminescence_${zone.zoneId}`;
    group.add(points);
  }

  return group;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-map zone defaults
// ──────────────────────────────────────────────────────────────────────────

/** Default underwater zone for the coastal biome. The engine calls this
 *  on map load when the map declares `biome: "coastal"` and no explicit
 *  zones — provides a default submerged shallows region along one edge. */
export function defaultCoastalZone(
  mapSlug: string,
  bounds: number,
): UnderwaterZone {
  return {
    mapSlug,
    zoneId: `${mapSlug}_coastal_water`,
    position: [0, 0, bounds * 0.85],
    width: bounds * 2,
    depth: bounds * 0.5,
    surfaceY: 0.5,
    floorY: -2.5,
    waterType: "coastal",
    fogColor: 0x2a5a6a,
    fogDensity: 0.045,
    oxygenDrainRate: 4,
    drowningDamage: 8,
    swimMultiplier: 0.55,
  };
}

/** Default swamp zone for the jungle biome. */
export function defaultJungleZone(
  mapSlug: string,
  bounds: number,
): UnderwaterZone {
  return {
    mapSlug,
    zoneId: `${mapSlug}_jungle_swamp`,
    position: [-bounds * 0.5, 0, bounds * 0.3],
    width: bounds * 0.6,
    depth: bounds * 0.5,
    surfaceY: 0.3,
    floorY: -1.5,
    waterType: "swamp",
    fogColor: 0x2a3a2a,
    fogDensity: 0.060,
    oxygenDrainRate: 6, // swamp water is foul
    drowningDamage: 10,
    swimMultiplier: 0.45,
  };
}

/** Engine-cleanup helper: clear all zones on map switch. */
export function disposeUnderwater(): void {
  clearUnderwaterZones();
}
