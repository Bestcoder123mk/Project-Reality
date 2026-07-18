import * as THREE from "three";
import type { GameContext, Collider, DestructibleProp } from "../../systems/types";
import type { MapDefinition } from "../MapRegistry";
import {
  sandTexture,
  concreteTexture,
  concreteRoughnessTexture,
} from "../../textures";
import {
  MaterialCache,
  type BuildContext,
  type BuiltMap,
} from "./_shared";
import { buildProp, addAMKEasterEgg } from "./props";
// Section M — photogrammetry PBR material factory for biome ground types.
import { buildPbrMaterial } from "../photogrammetry";

export function buildMap(ctx: GameContext, map: MapDefinition): BuiltMap {
  const { scene } = ctx;
  const matCache = new MaterialCache(scene);

  // Ground plane (always visible — not chunked).
  // K-5000 #4213 — was `new THREE.PlaneGeometry(200, 200)` (hardcoded 200m).
  // On maps with bounds < 100m (compound=45, alley=40, training=32) the
  // ground plane extended far past the playable area, causing the player
  // to see an infinite ground plane beyond the perimeter walls. On maps
  // with bounds > 100m (desert=80, warehouse=70) the plane barely covered
  // the playable area, exposing the void at the edges. Now the plane is
  // sized from `map.bounds` with a 25% margin so it always extends past
  // the perimeter walls but doesn't stretch to infinity.
  const groundExtent = map.bounds * 2.5;
  const groundMat = createGroundMaterial(map.groundMaterial);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundExtent, groundExtent), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Use local arrays so the BuiltMap return value is accurate; push to ctx at the end.
  const newColliders: Collider[] = [];
  const newDestructibles: DestructibleProp[] = [];
  const bctx: BuildContext = {
    scene,
    colliders: newColliders,
    destructibles: newDestructibles,
    matCache,
  };
  const props: THREE.Object3D[] = [];

  // Build each prop (added to the scene directly by builder functions).
  for (const prop of map.props) {
    const obj = buildProp(prop, bctx);
    if (obj) props.push(obj);
  }

  // V6 — Ambient ground detail: scatter small debris (rubble, oil stains,
  // loose sandbags, spent shell casings) across the map to break up the
  // flat ground plane and make the environment feel lived-in. These are
  // purely decorative (no colliders) and cheap (shared geometry + materials).
  const ambientProps = scatterAmbientDetail(map, matCache);
  props.push(...ambientProps);

  // Task-6 — AMK easter egg: a hidden "AMK" spray-paint decal at one unique
  // spot per map. The decal is deterministically placed (mulberry32 hash of
  // map.slug) on the side of a chosen prop facing away from the player
  // spawn. Purely cosmetic — no collider, no raycast — but tagged with
  // userData.isAMKEasterEgg so future engine code can detect "found" events.
  const amkDecal = addAMKEasterEgg(map, scene);
  if (amkDecal) props.push(amkDecal);

  // V6 — Ground dust particles: a low-lying field of slow-drifting dust
  // motes that adds atmospheric depth without performance cost. Uses a
  // single THREE.Points object with ~200 particles, frustum-culled, and
  // rendered with additive blending so it reads as light caught in dust
  // rather than flat dots. Not added to the chunk system (it's one object
  // — cheaper to keep visible than to toggle).
  const dustField = createGroundDust(map);
  scene.add(dustField);

  // Add colliders + destructibles to the context.
  ctx.colliders.push(...newColliders);
  ctx.destructibles.push(...newDestructibles);

  // ─── V2: Chunk streaming — reparent props into grid-cell chunk groups ───
  const chunkSize = 16; // meters per chunk cell
  const chunkGroups = new Map<string, THREE.Group>();
  for (const obj of props) {
    // Compute the prop's chunk key from its world position.
    const cx = Math.floor(obj.position.x / chunkSize);
    const cz = Math.floor(obj.position.z / chunkSize);
    const key = `${cx},${cz}`;
    let group = chunkGroups.get(key);
    if (!group) {
      group = new THREE.Group();
      group.name = `chunk_${key}`;
      // Start invisible — the ChunkManager activates visible chunks.
      group.visible = false;
      // Store grid coords on userData for the ChunkManager to read without parsing.
      group.userData.chunkX = cx;
      group.userData.chunkZ = cz;
      chunkGroups.set(key, group);
      scene.add(group);
    }
    // Reparent the prop from the scene into its chunk group.
    // THREE.Object3D.add() automatically removes from the previous parent.
    group.add(obj);
  }

  return { ground, props, colliders: newColliders, destructibles: newDestructibles, chunkGroups, chunkSize };
}

/** Create the ground material based on the map's ground type.
 *  Section M — extended to support new biome ground types
 *  (snow, ice, mud, jungle_floor, sand_wet, rock, gravel) using the
 *  photogrammetry.ts PBR texture pipeline. Falls back to the legacy
 *  procedural textures for the original 4 types. */
export function createGroundMaterial(type: MapDefinition["groundMaterial"]): THREE.Material {
  switch (type) {
    case "sand": {
      const tex = sandTexture(); tex.repeat.set(40, 40);
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
    }
    case "concrete": {
      const tex = concreteTexture(); tex.repeat.set(20, 20);
      const rough = concreteRoughnessTexture(); rough.repeat.set(20, 20);
      return new THREE.MeshStandardMaterial({ map: tex, roughnessMap: rough, roughness: 0.95, metalness: 0 });
    }
    case "grass": {
      return new THREE.MeshStandardMaterial({ color: 0x4a6a3a, roughness: 0.95, metalness: 0 });
    }
    case "asphalt": {
      return new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9, metalness: 0.05 });
    }
    // ── Section M — new biome ground materials (use photogrammetry PBR) ──
    case "snow":
      return buildPbrMaterial("snow", { repeat: 20, roughness: 0.7, metalness: 0 });
    case "ice":
      return buildPbrMaterial("ice", { repeat: 20, roughness: 0.18, metalness: 0.2 });
    case "mud":
      return buildPbrMaterial("mud", { repeat: 20, roughness: 0.95, metalness: 0 });
    case "jungle_floor":
      return buildPbrMaterial("jungle_floor", { repeat: 20, roughness: 0.92, metalness: 0 });
    case "sand_wet":
      return buildPbrMaterial("sand_wet", { repeat: 20, roughness: 0.32, metalness: 0.1 });
    case "rock":
      return buildPbrMaterial("rock", { repeat: 20, roughness: 0.95, metalness: 0 });
    case "gravel":
      return buildPbrMaterial("gravel", { repeat: 20, roughness: 0.95, metalness: 0 });
    default:
      return new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.9 });
  }
}


// ============================================================
// Internal: merge BufferGeometries (lightweight — avoids pulling
// in BufferGeometryUtils just for the target builder).
// ============================================================

export function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // All input geos are BoxGeometry (position + normal + uv). Merge into one.
  const merged = new THREE.BufferGeometry();
  let posLen = 0, idxLen = 0;
  for (const g of geos) {
    posLen += (g.getAttribute("position") as THREE.BufferAttribute).count;
    idxLen += g.index ? g.index.count : (g.getAttribute("position") as THREE.BufferAttribute).count;
  }
  const positions = new Float32Array(posLen * 3);
  const normals = new Float32Array(posLen * 3);
  const uvs = new Float32Array(posLen * 2);
  const indices = new Uint32Array(idxLen);
  let pOff = 0, iOff = 0, vOff = 0;
  for (const g of geos) {
    const p = g.getAttribute("position") as THREE.BufferAttribute;
    const n = g.getAttribute("normal") as THREE.BufferAttribute;
    const u = g.getAttribute("uv") as THREE.BufferAttribute;
    positions.set(p.array as Float32Array, pOff * 3);
    if (n) normals.set(n.array as Float32Array, pOff * 3);
    if (u) uvs.set(u.array as Float32Array, pOff * 2);
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
  merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  merged.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

// ════════════════════════════════════════════════════════════════════════════
// V6 — Ambient ground detail: scattered debris that makes maps feel lived-in.
//
// Adds small decorative props across the map:
//   - Rubble piles (clusters of small boxes near buildings/walls)
//   - Oil stains (dark decals on the ground — flat circles with low opacity)
//   - Loose sandbags (individual bags scattered near bunkers)
//   - Spent shell casings (tiny brass cylinders in combat areas)
//
// All props are purely decorative (no colliders), use shared geometry +
// cached materials, and are added to the chunk system so they cull at
// distance. Total per-map cost: ~40-80 small meshes, batched into chunk
// groups so the draw-call impact is minimal.
// ════════════════════════════════════════════════════════════════════════════

/** V6 — Deterministic PRNG (mulberry32) so the same map always produces
 *  the same debris layout. Without this, re-entering a map would scatter
 *  debris differently each time, causing visual inconsistency. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** V6 — Scatter ambient ground detail across the map. */
export function scatterAmbientDetail(map: MapDefinition, matCache: MaterialCache): THREE.Object3D[] {
  const rng = mulberry32(hashString(map.slug));
  const bounds = map.bounds;
  const props: THREE.Object3D[] = [];

  // Shared geometries (created once, reused for all debris of that type).
  const rubbleGeo = new THREE.BoxGeometry(0.15, 0.1, 0.12);
  const rubbleGeoLarge = new THREE.BoxGeometry(0.25, 0.18, 0.22);
  const shellCasingGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.05, 5);
  const sandbagGeo = new THREE.BoxGeometry(0.35, 0.18, 0.2);
  const stainGeo = new THREE.CircleGeometry(0.6, 12);

  // Shared materials.
  const rubbleMat = matCache.getMaterial("concrete");
  const rubbleMatDark = new THREE.MeshStandardMaterial({ color: 0x3a3a38, roughness: 0.95, metalness: 0 });
  const shellCasingMat = new THREE.MeshStandardMaterial({ color: 0xb8860b, roughness: 0.4, metalness: 0.8 });
  const sandbagMat = matCache.getMaterial("sandbag") ?? new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.95 });
  const oilStainMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.5, depthWrite: false });

  // ─── Rubble piles near buildings/walls ───
  // Find building/wall props and scatter rubble near them.
  for (const prop of map.props) {
    if (prop.type !== "building" && prop.type !== "box" && prop.type !== "sandbag_bunker") continue;
    const [px, py, pz] = prop.position;
    const rubbleCount = 3 + Math.floor(rng() * 4); // 3-6 pieces per structure
    for (let i = 0; i < rubbleCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = 1.5 + rng() * 2.5;
      const x = px + Math.cos(angle) * dist;
      const z = pz + Math.sin(angle) * dist;
      if (Math.abs(x) > bounds || Math.abs(z) > bounds) continue;
      const useLarge = rng() > 0.6;
      const mesh = new THREE.Mesh(useLarge ? rubbleGeoLarge : rubbleGeo, rng() > 0.5 ? rubbleMat : rubbleMatDark);
      mesh.position.set(x, useLarge ? 0.09 : 0.05, z);
      mesh.rotation.y = rng() * Math.PI * 2;
      mesh.rotation.z = (rng() - 0.5) * 0.3;
      mesh.castShadow = false; // small debris — skip shadow casting
      mesh.receiveShadow = true;
      props.push(mesh);
    }
  }

  // ─── Oil stains in random locations (industrial feel) ───
  const stainCount = 8 + Math.floor(rng() * 6);
  for (let i = 0; i < stainCount; i++) {
    const x = (rng() - 0.5) * bounds * 1.6;
    const z = (rng() - 0.5) * bounds * 1.6;
    if (Math.abs(x) > bounds || Math.abs(z) > bounds) continue;
    const mesh = new THREE.Mesh(stainGeo, oilStainMat);
    mesh.position.set(x, 0.02, z);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = rng() * Math.PI * 2;
    const scale = 0.5 + rng() * 1.5;
    mesh.scale.set(scale, scale, 1);
    mesh.receiveShadow = false;
    props.push(mesh);
  }

  // ─── Spent shell casings in combat areas (near cover/barriers) ───
  for (const prop of map.props) {
    if (prop.type !== "barrier" && prop.type !== "barricade" && prop.type !== "sandbag_wall" && prop.type !== "hesco") continue;
    const [px, , pz] = prop.position;
    const casingCount = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < casingCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = 0.5 + rng() * 1.5;
      const x = px + Math.cos(angle) * dist;
      const z = pz + Math.sin(angle) * dist;
      const mesh = new THREE.Mesh(shellCasingGeo, shellCasingMat);
      mesh.position.set(x, 0.025, z);
      mesh.rotation.x = Math.PI / 2;
      mesh.rotation.y = rng() * Math.PI * 2;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      props.push(mesh);
    }
  }

  // ─── Loose sandbags scattered near bunkers (looks like they fell off) ───
  for (const prop of map.props) {
    if (prop.type !== "sandbag_bunker" && prop.type !== "sandbag_wall") continue;
    const [px, , pz] = prop.position;
    const bagCount = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < bagCount; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = 1.0 + rng() * 1.5;
      const x = px + Math.cos(angle) * dist;
      const z = pz + Math.sin(angle) * dist;
      const mesh = new THREE.Mesh(sandbagGeo, sandbagMat);
      mesh.position.set(x, 0.09, z);
      mesh.rotation.y = rng() * Math.PI * 2;
      mesh.rotation.z = (rng() - 0.5) * 0.2;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      props.push(mesh);
    }
  }

  return props;
}

/** V6 — Hash a string to a 32-bit integer (for deterministic PRNG seeding). */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x6D2B79F5);
  }
  return h >>> 0;
}

/**
 * V6 — Create a low-lying ground dust particle field for atmospheric depth.
 *
 * Returns a THREE.Points object with ~200 dust motes scattered across the
 * map bounds, floating 0.5-2.5m above the ground. The motes are:
 *   - Tiny (0.03-0.06 size) so they read as dust, not snow.
 *   - Semi-transparent with additive blending so they catch the light.
 *   - Frustum-culled (the whole field culls when the player looks away).
 *   - Depth-write disabled so they don't occlude props behind them.
 *
 * The dust doesn't animate (animation would require a per-frame update
 * that the engine doesn't currently drive for map objects — the visual
 * benefit of static dust is still significant: it fills the "empty air"
 * between the player and distant props with subtle light scatter).
 */
export function createGroundDust(map: MapDefinition): THREE.Points {
  const rng = mulberry32(hashString(map.slug + "_dust"));
  const bounds = map.bounds;
  const count = 200;

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Scatter across the map bounds (with some margin so dust extends
    // slightly past the playable area).
    positions[i * 3] = (rng() - 0.5) * bounds * 2;
    positions[i * 3 + 1] = 0.5 + rng() * 2.0; // 0.5-2.5m above ground
    positions[i * 3 + 2] = (rng() - 0.5) * bounds * 2;
    sizes[i] = 0.03 + rng() * 0.03;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  // V6 — Use a small radial-gradient canvas texture for each dust mote
  // so they're soft circles, not hard squares. Cached at module scope.
  const dustTex = getDustTexture();

  const mat = new THREE.PointsMaterial({
    map: dustTex,
    color: 0xfff0d0,       // warm dust color (catches the sun)
    size: 0.05,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,             // dust fades into fog at distance
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = true;
  points.renderOrder = 1; // render after opaque props, before transparent overlays
  points.name = "ground_dust";
  return points;
}

/** V6 — Cached radial-gradient texture for dust motes (soft circles). */
let _dustTex: THREE.Texture | null = null;
export function getDustTexture(): THREE.Texture {
  if (_dustTex) return _dustTex;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2,
  );
  grad.addColorStop(0.0, "rgba(255,240,208,1.0)");
  grad.addColorStop(0.4, "rgba(255,240,208,0.5)");
  grad.addColorStop(1.0, "rgba(255,240,208,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _dustTex = tex;
  return tex;
}
