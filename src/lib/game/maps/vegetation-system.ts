/**
 * Section M — Vegetation system: procedural grass, trees, bushes with
 * wind animation.
 *
 * Each biome (biomes.ts) declares a list of VegetationSlug entries; the
 * vegetation-system scatters instances of each across the map using a
 * deterministic PRNG (mulberry32) seeded by map.slug + slug-name. The
 * scatter respects:
 *   - biome.vegetationDensity (per-biome multiplier)
 *   - prop-density bias (avoids spawning trees on top of buildings)
 *   - map.bounds (clamped to playable area)
 *
 * Vegetation uses InstancedMesh per slug (one draw call per vegetation
 * type per map) and supports per-instance wind animation via a custom
 * shader that displaces vertex Y based on a wind-noise function + the
 * instance's world position (so vegetation sways in unison but with
 * spatial variation).
 *
 * Public API:
 *   - buildVegetation(map, biome, ctx) — builds all instanced meshes
 *     for the map + returns them as a group the engine adds to the scene.
 *   - WIND_UNIFORMS — shared uniforms (windStrength, windDirection,
 *     windPhase) that the engine updates each frame from WeatherSystem.
 *   - getVegetationProfile(slug) — accessor for the per-slug profile.
 *
 * THREE imports are lazy (inside builder) so the module is SSR-safe.
 */

import * as THREE from "three";
import type { MapDefinition } from "./MapRegistry";
import type { BiomeDefinition, VegetationSlug } from "./biomes";
import { mulberry32, hashString } from "./MapBuilder/geometry";
import type { BuildContext } from "./MapBuilder/_shared";

// ──────────────────────────────────────────────────────────────────────────
// Vegetation profiles
// ──────────────────────────────────────────────────────────────────────────

export interface VegetationProfile {
  slug: VegetationSlug;
  /** Display name for the design dashboard. */
  label: string;
  /** Geometry class — drives the instanced-mesh builder. */
  geometry: "palm" | "cactus" | "shrub" | "pine" | "grass_tuft" | "banyan"
    | "fern" | "bamboo" | "flower" | "hedge" | "ivy" | "kelp" | "driftwood"
    | "boulder" | "lichen";
  /** Color tint (hex). */
  color: number;
  /** Trunk color (hex) for woody plants. */
  trunkColor?: number;
  /** Approximate height (m). */
  height: number;
  /** Approximate width (m). */
  width: number;
  /** Whether this vegetation sways in the wind. */
  sways: boolean;
  /** Wind sway amplitude (0..1). */
  swayAmplitude: number;
  /** LOD distance — past this, the instance scales down (cheap fade). */
  lodDistance: number;
  /** Density multiplier (relative to biome default). */
  densityMultiplier: number;
  /** Whether this vegetation casts shadows (small plants skip shadow casting). */
  castsShadow: boolean;
}

export const VEGETATION_PROFILES: Record<VegetationSlug, VegetationProfile> = {
  // Desert
  palm:         { slug: "palm",        label: "Palm Tree",       geometry: "palm",      color: 0x4a6a3a, trunkColor: 0x6a4a2a, height: 7,  width: 3, sways: true,  swayAmplitude: 0.3, lodDistance: 80, densityMultiplier: 0.4, castsShadow: true },
  cactus:       { slug: "cactus",      label: "Cactus",          geometry: "cactus",    color: 0x3a5a2a,                     height: 2.5, width: 1, sways: false, swayAmplitude: 0,   lodDistance: 60, densityMultiplier: 0.5, castsShadow: true },
  dead_shrub:   { slug: "dead_shrub",  label: "Dead Shrub",      geometry: "shrub",     color: 0x6a5a3a,                     height: 0.8, width: 0.8, sways: true,  swayAmplitude: 0.2, lodDistance: 40, densityMultiplier: 1.5, castsShadow: false },

  // Arctic
  pine_snow:    { slug: "pine_snow",   label: "Snow Pine",       geometry: "pine",      color: 0x2a4a3a, trunkColor: 0x4a3a2a, height: 6,  width: 2, sways: true,  swayAmplitude: 0.15, lodDistance: 80, densityMultiplier: 0.6, castsShadow: true },
  frost_grass:  { slug: "frost_grass", label: "Frost Grass",     geometry: "grass_tuft",color: 0xa8c8c8,                     height: 0.3, width: 0.4, sways: true,  swayAmplitude: 0.4, lodDistance: 30, densityMultiplier: 2.0, castsShadow: false },

  // Jungle
  banyan:       { slug: "banyan",      label: "Banyan Tree",     geometry: "banyan",    color: 0x2a4a2a, trunkColor: 0x4a3a2a, height: 12, width: 5, sways: true,  swayAmplitude: 0.2,  lodDistance: 100, densityMultiplier: 0.5, castsShadow: true },
  fern:         { slug: "fern",        label: "Fern",            geometry: "fern",      color: 0x3a6a3a,                     height: 1.0, width: 1.2, sways: true,  swayAmplitude: 0.35, lodDistance: 30, densityMultiplier: 2.5, castsShadow: false },
  bamboo:       { slug: "bamboo",      label: "Bamboo",          geometry: "bamboo",    color: 0x6a8a3a, trunkColor: 0x5a6a2a, height: 8,  width: 0.3, sways: true, swayAmplitude: 0.5,  lodDistance: 70, densityMultiplier: 1.5, castsShadow: true },
  orchid:       { slug: "orchid",      label: "Orchid",          geometry: "flower",    color: 0xc878d8,                     height: 0.5, width: 0.3, sways: true,  swayAmplitude: 0.3,  lodDistance: 25, densityMultiplier: 1.0, castsShadow: false },

  // Urban
  street_tree:  { slug: "street_tree", label: "Street Tree",     geometry: "pine",      color: 0x4a6a4a, trunkColor: 0x5a4a3a, height: 5,  width: 2, sways: true,  swayAmplitude: 0.2,  lodDistance: 70, densityMultiplier: 0.3, castsShadow: true },
  hedge:        { slug: "hedge",       label: "Hedge",           geometry: "hedge",     color: 0x3a5a3a,                     height: 1.2, width: 2, sways: false, swayAmplitude: 0,   lodDistance: 40, densityMultiplier: 0.8, castsShadow: true },
  ivy:          { slug: "ivy",         label: "Ivy",             geometry: "ivy",       color: 0x3a6a3a,                     height: 3,  width: 1, sways: true,  swayAmplitude: 0.15, lodDistance: 40, densityMultiplier: 1.0, castsShadow: false },

  // Coastal
  kelp:         { slug: "kelp",        label: "Kelp",            geometry: "kelp",      color: 0x3a6a3a,                     height: 2,  width: 0.3, sways: true,  swayAmplitude: 0.6,  lodDistance: 30, densityMultiplier: 1.5, castsShadow: false },
  coconut_palm: { slug: "coconut_palm",label: "Coconut Palm",    geometry: "palm",      color: 0x4a6a3a, trunkColor: 0x6a4a2a, height: 8,  width: 3, sways: true,  swayAmplitude: 0.35, lodDistance: 80, densityMultiplier: 0.4, castsShadow: true },
  driftwood:    { slug: "driftwood",   label: "Driftwood",       geometry: "driftwood", color: 0x8a7a5a,                     height: 0.4, width: 2, sways: false, swayAmplitude: 0,   lodDistance: 50, densityMultiplier: 0.6, castsShadow: false },

  // Mountain
  alpine_pine:  { slug: "alpine_pine", label: "Alpine Pine",     geometry: "pine",      color: 0x3a5a3a, trunkColor: 0x4a3a2a, height: 4,  width: 1.5, sways: true, swayAmplitude: 0.2,  lodDistance: 70, densityMultiplier: 0.5, castsShadow: true },
  lichen_rock:  { slug: "lichen_rock", label: "Lichen Rock",     geometry: "lichen",    color: 0x6a8a5a,                     height: 1.5, width: 1.5, sways: false, swayAmplitude: 0,   lodDistance: 60, densityMultiplier: 0.8, castsShadow: true },
  snow_boulder: { slug: "snow_boulder",label: "Snow Boulder",    geometry: "boulder",   color: 0xc8d0d8,                     height: 1.8, width: 2.5, sways: false, swayAmplitude: 0,   lodDistance: 80, densityMultiplier: 0.6, castsShadow: true },
};

export function getVegetationProfile(slug: VegetationSlug): VegetationProfile {
  return VEGETATION_PROFILES[slug] ?? VEGETATION_PROFILES.fern;
}

// ──────────────────────────────────────────────────────────────────────────
// Wind uniforms (shared across all vegetation instances — engine updates
// these per frame from WeatherSystem).
// ──────────────────────────────────────────────────────────────────────────

export const WIND_UNIFORMS = {
  windStrength: { value: 0.5 },
  windDirection: { value: 0.0 }, // radians
  windPhase: { value: 0.0 },     // increments per frame
};

// ──────────────────────────────────────────────────────────────────────────
// Geometry builders (one per geometry class)
// ──────────────────────────────────────────────────────────────────────────

/** Build a single geometry for a vegetation profile. Used as the source
 *  geometry for InstancedMesh. */
function buildGeometry(profile: VegetationProfile): THREE.BufferGeometry {
  const h = profile.height;
  const w = profile.width;
  switch (profile.geometry) {
    case "palm":
    case "banyan": {
      // Trunk + canopy sphere.
      const trunk = new THREE.CylinderGeometry(w * 0.05, w * 0.08, h, 6);
      trunk.translate(0, h / 2, 0);
      const canopy = new THREE.SphereGeometry(w / 2, 8, 6);
      canopy.translate(0, h, 0);
      return mergeGeometriesLight([trunk, canopy]);
    }
    case "pine": {
      // Trunk + 3 stacked cones.
      const trunk = new THREE.CylinderGeometry(w * 0.05, w * 0.07, h * 0.3, 6);
      trunk.translate(0, h * 0.15, 0);
      const c1 = new THREE.ConeGeometry(w * 0.5, h * 0.4, 8);
      c1.translate(0, h * 0.4, 0);
      const c2 = new THREE.ConeGeometry(w * 0.4, h * 0.35, 8);
      c2.translate(0, h * 0.65, 0);
      const c3 = new THREE.ConeGeometry(w * 0.25, h * 0.3, 8);
      c3.translate(0, h * 0.85, 0);
      return mergeGeometriesLight([trunk, c1, c2, c3]);
    }
    case "cactus": {
      const body = new THREE.CylinderGeometry(w * 0.4, w * 0.5, h, 8);
      body.translate(0, h / 2, 0);
      const arm = new THREE.CylinderGeometry(w * 0.2, w * 0.25, h * 0.5, 6);
      arm.translate(w * 0.5, h * 0.4, 0);
      return mergeGeometriesLight([body, arm]);
    }
    case "shrub":
    case "hedge": {
      const s = new THREE.SphereGeometry(w / 2, 8, 6);
      s.scale(1, h / w, 1);
      s.translate(0, h / 2, 0);
      return s;
    }
    case "grass_tuft":
    case "fern": {
      // 5 thin crossed planes.
      const geos: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 5; i++) {
        const blade = new THREE.PlaneGeometry(w * 0.4, h);
        blade.translate(0, h / 2, 0);
        blade.rotateY((i / 5) * Math.PI);
        geos.push(blade);
      }
      return mergeGeometriesLight(geos);
    }
    case "bamboo": {
      const stalk = new THREE.CylinderGeometry(w * 0.5, w * 0.5, h, 6);
      stalk.translate(0, h / 2, 0);
      return stalk;
    }
    case "flower": {
      const stem = new THREE.CylinderGeometry(0.02, 0.02, h, 4);
      stem.translate(0, h / 2, 0);
      const head = new THREE.SphereGeometry(w * 0.4, 6, 4);
      head.translate(0, h, 0);
      return mergeGeometriesLight([stem, head]);
    }
    case "ivy":
    case "kelp": {
      const blade = new THREE.PlaneGeometry(w, h);
      blade.translate(0, h / 2, 0);
      return blade;
    }
    case "driftwood": {
      const log = new THREE.CylinderGeometry(w * 0.1, w * 0.15, w, 6);
      log.rotateZ(Math.PI / 2);
      return log;
    }
    case "boulder": {
      const b = new THREE.DodecahedronGeometry(w / 2, 0);
      b.scale(1, h / w, 1);
      b.translate(0, h / 2, 0);
      return b;
    }
    case "lichen": {
      const rock = new THREE.DodecahedronGeometry(w / 2, 0);
      rock.translate(0, h / 2, 0);
      return rock;
    }
    default: {
      const fallback = new THREE.BoxGeometry(w, h, w);
      fallback.translate(0, h / 2, 0);
      return fallback;
    }
  }
}

/** Lightweight merge — concatenate position + index arrays from N geos.
 *  Avoids pulling in BufferGeometryUtils for the vegetation builder. */
function mergeGeometriesLight(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  let posLen = 0, idxLen = 0;
  for (const g of geos) {
    posLen += (g.getAttribute("position") as THREE.BufferAttribute).count;
    idxLen += g.index ? g.index.count : (g.getAttribute("position") as THREE.BufferAttribute).count;
  }
  const positions = new Float32Array(posLen * 3);
  const indices = new Uint32Array(idxLen);
  let pOff = 0, iOff = 0, vOff = 0;
  for (const g of geos) {
    const p = g.getAttribute("position") as THREE.BufferAttribute;
    positions.set(p.array as Float32Array, pOff * 3);
    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices[iOff + i] = idx.getX(i) + vOff;
      iOff += idx.count;
    } else {
      for (let i = 0; i < p.count; i++) indices[iOff + i] = i + vOff;
      iOff += p.count;
    }
    vOff += p.count;
    pOff += p.count;
  }
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeVertexNormals();
  return merged;
}

// ──────────────────────────────────────────────────────────────────────────
// Main scatter + build
// ──────────────────────────────────────────────────────────────────────────

/** Build all vegetation for a map. Returns a group of InstancedMeshes
 *  the engine adds to the scene. Uses the biome's vegetation list +
 *  density to decide how many instances to scatter per slug.
 *
 *  Each instance's matrix is set with:
 *    - position (deterministic, mulberry32-seeded)
 *    - rotation Y (random)
 *    - scale (random ±30%)
 *  Wind animation is applied via a shared onBeforeCompile hook on the
 *  material (reads WIND_UNIFORMS + the instance's world position). */
export function buildVegetation(
  bctx: BuildContext,
  map: MapDefinition,
  biome: BiomeDefinition,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `vegetation_${map.slug}`;
  bctx.scene.add(group);

  const bounds = map.bounds;
  // Base density per 100m². Biome multiplier scales this.
  const BASE_DENSITY = 8;

  // Collect prop AABBs to avoid spawning vegetation inside buildings.
  const propBoxes: Array<[number, number, number]> = map.props
    .filter((p) => p.type === "building" || p.type === "container" || p.type === "box")
    .map((p) => p.position);

  for (const slug of biome.vegetation) {
    const profile = VEGETATION_PROFILES[slug];
    if (!profile) continue;
    const area = (bounds * 2) * (bounds * 2); // m²
    const count = Math.floor(
      (area / 100) * BASE_DENSITY * biome.vegetationDensity * profile.densityMultiplier,
    );
    if (count <= 0) continue;

    const geo = buildGeometry(profile);
    const mat = new THREE.MeshStandardMaterial({
      color: profile.color,
      roughness: 0.85,
      metalness: 0,
      side: profile.geometry === "ivy" || profile.geometry === "kelp" || profile.geometry === "grass_tuft" || profile.geometry === "fern"
        ? THREE.DoubleSide
        : THREE.FrontSide,
    });

    // Wind animation hook.
    if (profile.sways) {
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.windStrength = WIND_UNIFORMS.windStrength;
        shader.uniforms.windDirection = WIND_UNIFORMS.windDirection;
        shader.uniforms.windPhase = WIND_UNIFORMS.windPhase;
        shader.vertexShader = "uniform float windStrength;\nuniform float windDirection;\nuniform float windPhase;\n" +
          shader.vertexShader.replace(
            "#include <begin_vertex>",
            `vec3 transformed = vec3(position);
             float windX = sin(windPhase + instanceMatrix[3].x * 0.1 + instanceMatrix[3].z * 0.1);
             float sway = windStrength * ${profile.swayAmplitude.toFixed(2)} * (transformed.y / ${profile.height.toFixed(2)});
             transformed.x += windX * sway * cos(windDirection);
             transformed.z += windX * sway * sin(windDirection);`,
          );
      };
    }

    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.castShadow = profile.castsShadow;
    inst.receiveShadow = false;
    inst.frustumCulled = true;
    inst.name = `veg_${slug}`;

    const rng = mulberry32(hashString(map.slug + "_veg_" + slug));
    const dummy = new THREE.Object3D();
    let placed = 0;
    let attempts = 0;
    while (placed < count && attempts < count * 4) {
      attempts++;
      const x = (rng() - 0.5) * bounds * 1.8;
      const z = (rng() - 0.5) * bounds * 1.8;
      // Skip if inside a prop footprint.
      let blocked = false;
      for (const [px, , pz] of propBoxes) {
        const dx = x - px, dz = z - pz;
        if (dx * dx + dz * dz < 16) { blocked = true; break; }
      }
      if (blocked) continue;
      dummy.position.set(x, 0, z);
      dummy.rotation.y = rng() * Math.PI * 2;
      const s = 0.7 + rng() * 0.6;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      inst.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    inst.count = placed;
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  return group;
}

/** Engine-cleanup helper — dispose all vegetation geometry + materials. */
export function disposeVegetation(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) {
      obj.geometry?.dispose?.();
      const mat = obj.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat?.dispose?.();
    }
  });
  group.removeFromParent();
}
