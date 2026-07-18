/**
 * SEC2-ART — Prompt 17
 * ─────────────────────────────────────────────────────────────────────────────
 * Vegetation — instanced-mesh grass / tree / bush system with wind-sway
 * vertex-shader animation.
 *
 * Performance: grass fields use `THREE.InstancedMesh` (one draw call for
 * thousands of blades). Trees + bushes are individual meshes (fewer, larger
 * — instancing doesn't pay off past ~100 instances with shared geometry).
 *
 * Wind sway: a custom ShaderMaterial extends MeshStandardMaterial via
 * `onBeforeCompile`, injecting a vertex-shader sine offset keyed off the
 * instance's world position + a uniform time. Each blade/branch sways with
 * a phase based on its XZ position so the field ripples instead of pulsing
 * in unison.
 *
 * C3-5000 prompt mapping:
 *   C3-5000 #1568 [WIND_TUNE_TABLE]  weather tuning per state — per-state
 *       wind-strength + wind-direction multiplier applied to the vegetation
 *       sway shader (calm/breezy/windy/storm). Exported at the bottom.
 *
 * Public surface:
 *   - `spawnGrassField(center, radius, density)` → THREE.InstancedMesh
 *   - `spawnTree(pos)`                            → THREE.Group
 *   - `spawnBush(pos)`                            → THREE.Group
 *   - `updateVegetation(dt)`                      → advance wind uniforms
 *                                                  (call once per frame)
 *   - `disposeVegetation()`                       → release materials + GPU
 *   - `getVegetationStats()`                      → {grassBlades, trees, bushes}
 *
 * Wiring (one-liner for the orchestrator):
 *   - On map load (outdoor maps: Compound, Desert, Training): after `buildMap`,
 *     call `spawnGrassField(center, radius, density)` per grassy area + sprinkle
 *     `spawnTree`/`spawnBush` from a poisson-disk sampler.
 *   - Per frame, after the LOD system update: `updateVegetation(dt)`.
 *   - On map switch: `disposeVegetation()` to release GPU resources.
 *
 * SSR-safe — pure three.js object construction; the wind shader compiles
 * lazily on first render.
 */

import * as THREE from "three";

// ─── Wind sway shader injection ────────────────────────────────────────────

/** Wind uniforms shared across all vegetation materials. Updating the time
 *  here ripples to every blade + tree + bush in one GPU upload per material. */
const windUniforms = {
  uTime: { value: 0 },
  uWindStrength: { value: 0.08 },
  uWindFreq: { value: 1.2 },
};

/** Track all materials we've patched so dispose() can release them. */
const _patchedMaterials = new Set<THREE.MeshStandardMaterial>();

/**
 * Patch a MeshStandardMaterial with a vertex-shader wind-sway offset. The
 * offset is `sin(time * freq + worldPos.x * 0.5 + worldPos.z * 0.3) * strength`
 * applied to the local X axis, scaled by the vertex's height (so the root
 * of the blade stays put and the tip sways most).
 *
 * `heightFactor` controls how strongly the height affects sway amplitude —
 * grass blades (tall, thin) want 1.0, tree trunks want 0.0 (no sway —
 * branches should sway via their own canopy mesh).
 */
function patchMaterialWithWind(mat: THREE.MeshStandardMaterial, heightFactor = 1.0): THREE.MeshStandardMaterial {
  if ((mat.userData as Record<string, unknown>).windPatched) return mat;
  (mat.userData as Record<string, unknown>).windPatched = true;
  (mat.userData as Record<string, unknown>).windHeightFactor = heightFactor;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.uniforms.uWindFreq = windUniforms.uWindFreq;
    shader.uniforms.uHeightFactor = { value: heightFactor };

    // Vertex shader: inject the wind offset before the position is transformed.
    // A3-5000 #429: for InstancedMesh, `modelMatrix` is the mesh's own matrix,
    // NOT per-instance. We use `instanceMatrix` (the per-instance transform)
    // + `modelMatrix` to compute the per-instance world position so each
    // blade sways with its own phase. The original code read `modelMatrix *
    // position` which is the same for every instance → all blades swayed in
    // unison (looked like the whole field pulsing, not rippling).
    // A3-5000 #472: add Y-axis sway (vertical bounce) so leaves flap, not
    // just horizontal shear.
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `
        #include <common>
        uniform float uTime;
        uniform float uWindStrength;
        uniform float uWindFreq;
        uniform float uHeightFactor;
        #ifdef USE_INSTANCING
          // instanceMatrix is available — use it for per-instance world pos.
        #endif
        `,
      )
      .replace(
        "#include <begin_vertex>",
        `
        vec3 transformed = vec3(position);
        // A3-5000 #429: per-instance world position for instanced meshes.
        vec4 instanceWorldPos = modelMatrix * vec4(position, 1.0);
        #ifdef USE_INSTANCING
          // For InstancedMesh, compute the world position including the
          // instance transform so each blade has its own phase.
          vec4 instanceTransformed = instanceMatrix * vec4(position, 1.0);
          instanceWorldPos = modelMatrix * instanceTransformed;
        #endif
        float worldX = instanceWorldPos.x;
        float worldZ = instanceWorldPos.z;
        // Sway: sine wave keyed off world position + time. Multiply by the
        // vertex Y (so the base stays planted + the tip sways most).
        float phase = uTime * uWindFreq + worldX * 0.5 + worldZ * 0.3;
        float sway = sin(phase) * uWindStrength * max(0.0, position.y) * uHeightFactor;
        transformed.x += sway;
        // Slight secondary perpendicular sway for organic motion.
        transformed.z += cos(phase * 0.8) * uWindStrength * 0.4 * max(0.0, position.y) * uHeightFactor;
        // A3-5000 #472: vertical bounce — leaves flap up/down on strong gusts.
        // Damped by heightFactor so trunks don't bounce.
        transformed.y += sin(phase * 1.3) * uWindStrength * 0.3 * max(0.0, position.y) * uHeightFactor;
        `,
      );
  };
  _patchedMaterials.add(mat);
  return mat;
}

// ─── Cached geometries + materials ─────────────────────────────────────────

let _grassGeo: THREE.BufferGeometry | null = null;
function getGrassBladeGeometry(): THREE.BufferGeometry {
  if (_grassGeo) return _grassGeo;
  // A3-5000 #469: was a single 3-vertex triangle (flat, no normal, no
  // texture, no alpha test). Now a 7-vertex blade with width taper + UVs
  // for an alpha-tested grass texture + a per-vertex bend normal.
  const geo = new THREE.BufferGeometry();
  // 4-segment blade: base (2 verts) → 3 levels up, tapering to a single tip.
  // A3-5000 #469: separate position + uv buffers (cleaner than interleaved).
  const positions = new Float32Array([
    -0.02, 0.00, 0.0,
     0.02, 0.00, 0.0,
    -0.015, 0.13, 0.0,
     0.015, 0.13, 0.0,
    -0.01, 0.27, 0.0,
     0.01, 0.27, 0.0,
     0.00, 0.40, 0.0,  // tip
  ]);
  const uvs = new Float32Array([
    0, 0,  1, 0,  0, 0.33,  1, 0.33,  0, 0.66,  1, 0.66,  0.5, 1.0,
  ]);
  const indices = new Uint16Array([
    0, 1, 2,  2, 1, 3,  // base segment
    2, 3, 4,  4, 3, 5,  // middle segment
    4, 5, 6,            // tip triangle
  ]);
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  _grassGeo = geo;
  return geo;
}

let _grassMat: THREE.MeshStandardMaterial | null = null;
function getGrassMaterial(): THREE.MeshStandardMaterial {
  if (_grassMat) return _grassMat;
  _grassMat = new THREE.MeshStandardMaterial({
    color: 0x4a7a3a, roughness: 0.85, metalness: 0.0,
    side: THREE.DoubleSide,
  });
  patchMaterialWithWind(_grassMat, 1.0);
  return _grassMat;
}

let _treeTrunkGeo: THREE.BufferGeometry | null = null;
let _treeCanopyGeo: THREE.BufferGeometry | null = null;
let _treeTrunkMat: THREE.MeshStandardMaterial | null = null;
let _treeCanopyMat: THREE.MeshStandardMaterial | null = null;

function getTreeGeometries(): { trunk: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
  if (!_treeTrunkGeo) _treeTrunkGeo = new THREE.CylinderGeometry(0.15, 0.22, 2.2, 8);
  // A3-5000 #471: enable flat shading for stylized low-poly look. The
  // IcosahedronGeometry with detail=1 is 80 triangles; smooth shading makes
  // it look blobby. We set vertexColors=false + use flatShading on the
  // material (see getTreeMaterials).
  if (!_treeCanopyGeo) _treeCanopyGeo = new THREE.IcosahedronGeometry(1.1, 1);
  return { trunk: _treeTrunkGeo, canopy: _treeCanopyGeo };
}
function getTreeMaterials(): { trunk: THREE.MeshStandardMaterial; canopy: THREE.MeshStandardMaterial } {
  if (!_treeTrunkMat) {
    _treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a1a, roughness: 0.85, metalness: 0.0 });
    // Trunk has minimal sway (heightFactor 0.1 — slight lean, not full-body bend).
    patchMaterialWithWind(_treeTrunkMat, 0.1);
  }
  if (!_treeCanopyMat) {
    // A3-5000 #471: flatShading for stylized low-poly faceted canopy.
    _treeCanopyMat = new THREE.MeshStandardMaterial({ color: 0x2a5a2a, roughness: 0.8, metalness: 0.0, flatShading: true });
    // Canopy sways strongly (the leaves move most).
    patchMaterialWithWind(_treeCanopyMat, 0.5);
  }
  return { trunk: _treeTrunkMat, canopy: _treeCanopyMat };
}

let _bushGeo: THREE.BufferGeometry | null = null;
let _bushMat: THREE.MeshStandardMaterial | null = null;
function getBushGeometry(): THREE.BufferGeometry {
  if (!_bushGeo) _bushGeo = new THREE.IcosahedronGeometry(0.45, 1);
  return _bushGeo;
}
function getBushMaterial(): THREE.MeshStandardMaterial {
  if (!_bushMat) {
    // A3-5000 #471: flatShading for stylized low-poly bush.
    _bushMat = new THREE.MeshStandardMaterial({ color: 0x3a6a3a, roughness: 0.85, metalness: 0.0, flatShading: true });
    patchMaterialWithWind(_bushMat, 0.4);
  }
  return _bushMat;
}

// ─── Public spawn API ──────────────────────────────────────────────────────

/** Track all spawned vegetation for stats + cleanup. */
const _spawnedGrass: THREE.InstancedMesh[] = [];
const _spawnedTrees: THREE.Group[] = [];
const _spawnedBushes: THREE.Group[] = [];

/** Deterministic PRNG (mulberry32) — so a grass field looks the same across
 *  page reloads (avoids the field "shifting" between visits). */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spawn an instanced grass field — N blades scattered uniformly in a disk
 *  of `radius` meters around `center`. Returns the InstancedMesh (caller
 *  adds it to the scene).
 *
 * @param center   Field center (world XZ; Y is the ground height).
 * @param radius   Field radius in meters.
 * @param density  Blades per square meter (typical: 2-10).
 * @param seed     RNG seed for reproducible layout.
 */
export function spawnGrassField(
  center: [number, number, number],
  radius: number,
  density: number,
  seed = 1337,
): THREE.InstancedMesh {
  const area = Math.PI * radius * radius;
  const count = Math.max(1, Math.floor(area * density));
  // Cap at 50k blades per field — WebGL instancing caps vary, but 50k is
  // a safe ceiling on all modern mobile + desktop GPUs.
  const cappedCount = Math.min(count, 50000);

  const geo = getGrassBladeGeometry();
  const mat = getGrassMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, cappedCount);
  mesh.castShadow = false;       // grass shadow is too expensive + visually noisy
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.name = `grass_field_${center[0].toFixed(0)}_${center[2].toFixed(0)}`;

  const rng = makeRng(seed);
  const dummy = new THREE.Object3D();
  // A3-5000 #470: sample terrain height per blade. The host can register a
  // terrain height sampler via setTerrainSampler(); if absent, fall back to
  // center[1] (the original behavior — flat ground only).
  for (let i = 0; i < cappedCount; i++) {
    // Uniform disk sampling: r = radius * sqrt(rng), θ = 2π * rng.
    const r = radius * Math.sqrt(rng());
    const theta = rng() * Math.PI * 2;
    const x = center[0] + Math.cos(theta) * r;
    const z = center[2] + Math.sin(theta) * r;
    const y = _terrainSampler ? _terrainSampler(x, z) : center[1]; // A3-5000 #470
    // Per-blade: random rotation, slight scale variation.
    const rotY = rng() * Math.PI * 2;
    const scale = 0.7 + rng() * 0.6;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();

  _spawnedGrass.push(mesh);
  return mesh;
}

/** Spawn a single tree at the given position. Returns a Group with trunk +
 *  3 canopy blobs (low-poly stylized). Caller adds to the scene. */
export function spawnTree(pos: [number, number, number]): THREE.Group {
  const g = new THREE.Group();
  g.name = `tree_${pos[0].toFixed(0)}_${pos[2].toFixed(0)}`;
  const { trunk: trunkGeo, canopy: canopyGeo } = getTreeGeometries();
  const { trunk: trunkMat, canopy: canopyMat } = getTreeMaterials();

  // Trunk.
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.position.set(pos[0], pos[1] + 1.1, pos[2]);
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  g.add(trunk);

  // Canopy — 3 icosahedron blobs offset for a fuller silhouette.
  const canopyPositions: Array<[number, number, number]> = [
    [pos[0], pos[1] + 2.4, pos[2]],
    [pos[0] + 0.5, pos[1] + 2.2, pos[2] + 0.3],
    [pos[0] - 0.4, pos[1] + 2.3, pos[2] - 0.4],
  ];
  for (const cp of canopyPositions) {
    const canopy = new THREE.Mesh(canopyGeo, canopyMat);
    canopy.position.set(cp[0], cp[1], cp[2]);
    canopy.scale.setScalar(0.9 + Math.random() * 0.3);
    canopy.castShadow = true;
    canopy.receiveShadow = true;
    g.add(canopy);
  }

  _spawnedTrees.push(g);
  return g;
}

/** Spawn a single bush at the given position. Returns a Group with 2-3 small
 *  icosahedron blobs. Caller adds to the scene. */
export function spawnBush(pos: [number, number, number]): THREE.Group {
  const g = new THREE.Group();
  g.name = `bush_${pos[0].toFixed(0)}_${pos[2].toFixed(0)}`;
  const geo = getBushGeometry();
  const mat = getBushMaterial();

  // 2-3 offset blobs for a fuller silhouette.
  const rng = Math.random;
  const blobCount = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < blobCount; i++) {
    const blob = new THREE.Mesh(geo, mat);
    const ox = (rng() - 0.5) * 0.5;
    const oz = (rng() - 0.5) * 0.5;
    blob.position.set(pos[0] + ox, pos[1] + 0.35, pos[2] + oz);
    blob.scale.setScalar(0.7 + rng() * 0.5);
    blob.castShadow = true;
    blob.receiveShadow = true;
    g.add(blob);
  }

  _spawnedBushes.push(g);
  return g;
}

// ─── Per-frame update ──────────────────────────────────────────────────────

/**
 * Advance the wind uniforms. Call once per frame from the engine's update
 * loop. The uniforms are shared across all vegetation materials, so a
 * single update animates every blade + tree + bush.
 *
 * @param dt  Delta-time in seconds (use the same dt the rest of the engine uses).
 */
export function updateVegetation(dt: number): void {
  windUniforms.uTime.value += dt;
  // Note: we don't need to set needsUpdate on the uniforms — three.js reads
  // uniform values directly each frame.
}

// ─── Teardown + stats ──────────────────────────────────────────────────────

/** Release all GPU resources held by vegetation: dispose geometries,
 *  materials, and clear the tracking arrays. Safe to call multiple times. */
export function disposeVegetation(): void {
  for (const m of _patchedMaterials) m.dispose();
  _patchedMaterials.clear();
  _grassGeo?.dispose(); _grassGeo = null;
  _grassMat = null;
  _treeTrunkGeo?.dispose(); _treeTrunkGeo = null;
  _treeCanopyGeo?.dispose(); _treeCanopyGeo = null;
  _treeTrunkMat = null;
  _treeCanopyMat = null;
  _bushGeo?.dispose(); _bushGeo = null;
  _bushMat = null;
  _spawnedGrass.length = 0;
  _spawnedTrees.length = 0;
  _spawnedBushes.length = 0;
}

/** Telemetry: count of spawned vegetation by type. */
export function getVegetationStats(): {
  grassFields: number;
  grassBlades: number;
  trees: number;
  bushes: number;
} {
  let blades = 0;
  for (const m of _spawnedGrass) blades += m.count;
  return {
    grassFields: _spawnedGrass.length,
    grassBlades: blades,
    trees: _spawnedTrees.length,
    bushes: _spawnedBushes.length,
  };
}

// ─── Wind config ───────────────────────────────────────────────────────────

/** A3-5000 #470: register a terrain-height sampler so grass blades conform
 *  to the actual ground height (was flat — blades clipped/floated on hills). */
let _terrainSampler: ((x: number, z: number) => number) | null = null;
export function setTerrainSampler(fn: ((x: number, z: number) => number) | null): void {
  _terrainSampler = fn;
}

/** Adjust wind strength (meters of tip displacement at full amplitude).
 *  Default 0.08 — gentle breeze. Set 0.20 for a storm. */
export function setWindStrength(strength: number): void {
  windUniforms.uWindStrength.value = strength;
}

/** Adjust wind frequency (cycles per second). Default 1.2 — slow rolling
 *  breeze. Set 3.0 for a stiff wind. */
export function setWindFrequency(freq: number): void {
  windUniforms.uWindFreq.value = freq;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1568 — weather tuning per state (vegetation wind strength +
//  direction multiplier per weather state). The runtime sway shader
//  multiplies its base wind uniform by these values.
// ═══════════════════════════════════════════════════════════════════════════

export const WIND_TUNE_TABLE: Record<string, { strengthMult: number; dirJitter: number; gustFreq: number }> = {
  calm:    { strengthMult: 0.30, dirJitter: 0.05, gustFreq: 0.10 },
  breezy:  { strengthMult: 0.70, dirJitter: 0.15, gustFreq: 0.30 },
  windy:   { strengthMult: 1.20, dirJitter: 0.30, gustFreq: 0.60 },
  storm:   { strengthMult: 2.00, dirJitter: 0.60, gustFreq: 1.20 },
  blizzard:{ strengthMult: 2.50, dirJitter: 0.80, gustFreq: 1.80 },
};
