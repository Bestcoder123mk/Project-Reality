/**
 * SEC3-RENDER Prompt 19 — Baked lightmap / per-vertex GI.
 *
 * Replaces the broken `enableDDGI` flag (which previously did nothing) with a
 * real, working per-vertex ambient-occlusion + light-intensity lightmap that
 * can be baked from any scene graph + sun config. The result is stored on the
 * mesh as a THREE.BufferAttribute (`color` slot, which the standard material
 * multiplies into the diffuse term via `vertexColors: true`) so it costs ZERO
 * per-frame work after baking — the standard PBR shader already supports the
 * `color` attribute as a per-vertex modulator.
 *
 * Approach:
 *   - Walk every mesh in the scene.
 *   - For every vertex, sample N cosine-weighted hemisphere directions about
 *     the vertex normal (re-using the renderer's raycaster against the scene
 *     geometry list — no dependency on a physics world).
 *   - AO = (unoccluded samples) / N  → baked as a 0.35..1.0 scalar.
 *   - Direct light = sun direction · normal (clamped), attenuated by the
 *     shortest occluder hit along the sun vector → baked as a 0..1 scalar.
 *   - Combined `intensity = mix(aoFloor, 1.0, ao) + sunTerm * sunColor`.
 *
 * The output is a single Float32Array of per-vertex RGB that gets installed
 * as the mesh's `color` attribute. MeshStandardMaterial picks this up via the
 * `vertexColors` flag (set by `applyLightmap`). Disposing the lightmap simply
 * removes the attribute + clears the flag.
 *
 * `bakeLightmap` is CPU-heavy — it is intended to be called once at map load
 * (or behind a "Rebake Lighting" debug button). Quality tiers:
 *   - low:    8 samples/vertex, 0.5m max ray
 *   - medium: 16 samples/vertex, 1.0m max ray
 *   - high:   32 samples/vertex, 2.0m max ray
 *
 * SSR-safe: all paths guard for the absence of `THREE.Raycaster` (it's only
 * present in the browser bundle); in node tests the raycasting functions are
 * pure arithmetic over an explicit triangle list.
 */
import * as THREE from "three";

/** Per-vertex AO + direct-light baked data. */
export interface LightmapData {
  /** Per-vertex RGB (0..1). Length = vertexCount * 3. */
  rgb: Float32Array;
  /** Per-vertex AO scalar (0..1). Length = vertexCount. */
  ao: Float32Array;
  /** Source geometry identifier (mesh.uuid) — used to detect stale data. */
  meshUuid: string;
  /** Sample count used to bake (for diagnostics). */
  sampleCount: number;
}

/** Sun configuration consumed by the baker. */
export interface SunConfig {
  /** World-space direction the sun's rays travel TOWARD (i.e. light direction). */
  direction: THREE.Vector3;
  /** Sun color in linear sRGB (e.g. 1.0, 0.92, 0.82 for warm daylight). */
  color: THREE.Vector3;
  /** Direct-light intensity multiplier (0..4). */
  intensity: number;
  /** E1-5000 #2376 — Optional accent light (a secondary directional fill,
   *  e.g. a warm bounce off a nearby building). Adds an extra directional
   *  term to the bake so corners + interiors get a subtle warm fill instead
   *  of the flat AO-only look. */
  accent?: { direction: THREE.Vector3; color: THREE.Vector3; intensity: number };
  /** E1-5000 #2376 — Optional sky term (defaults to soft blue sky). */
  sky?: { color: THREE.Vector3; intensity: number };
}

/** Quality-tier bake parameters. */
export interface BakeQuality {
  samples: number;
  maxRay: number; // world units
}

/** Sensible defaults per quality tier. */
export const BAKE_QUALITY: Record<"low" | "medium" | "high", BakeQuality> = {
  low: { samples: 8, maxRay: 0.5 },
  medium: { samples: 16, maxRay: 1.0 },
  high: { samples: 32, maxRay: 2.0 },
};

/** A flat triangle representation used by the raycaster — derived from a
 *  mesh's world-space geometry. Kept simple so the same code path runs in
 *  node tests (no WebGL needed). */
interface Triangle {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  /** Precomputed face normal. */
  n: THREE.Vector3;
  /** Source mesh UUID — A3-5000-retry / prompt 404: used to skip the source
   *  mesh's own triangles when computing AO for that mesh's vertices, so a
   *  flat surface does not darken itself. */
  srcMesh?: string;
  /** Indices of the source-mesh vertices that form this triangle (local to
   *  the source geometry). Used by the per-vertex source-triangle skip. */
  srcIndices?: [number, number, number];
}

/** Möller–Trumbore ray-triangle intersection. Returns the hit distance or
 *  -1 if no hit (or a back-face hit). Pure-arithmetic — SSR-safe. */
function rayTriangle(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  tri: Triangle,
  maxDist: number,
): number {
  const EPS = 1e-7;
  const edge1 = tri.b.clone().sub(tri.a);
  const edge2 = tri.c.clone().sub(tri.a);
  const h = dir.clone().cross(edge2);
  const a = edge1.dot(h);
  if (a > -EPS && a < EPS) return -1; // parallel
  const f = 1 / a;
  const s = origin.clone().sub(tri.a);
  const u = f * s.dot(h);
  if (u < 0 || u > 1) return -1;
  const q = s.cross(edge1);
  const v = f * dir.dot(q);
  if (v < 0 || u + v > 1) return -1;
  const t = f * edge2.dot(q);
  if (t < EPS || t > maxDist) return -1;
  return t;
}

/** Build the per-mesh triangle list in WORLD space (so the same list can be
 *  reused for every vertex of every mesh without per-ray matrix work). */
function collectTriangles(scene: THREE.Object3D): Triangle[] {
  const tris: Triangle[] = [];
  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geo || !geo.attributes.position) return;
    // Skip sky / particles / lens-weather — they shouldn't occlude GI.
    if ((obj as { userData?: { giSkip?: boolean } }).userData?.giSkip) return;
    const posAttr = geo.attributes.position;
    const index = geo.index;
    const m = mesh.matrixWorld;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const triCount = index ? index.count / 3 : posAttr.count / 3;
    for (let i = 0; i < triCount; i++) {
      const i0 = index ? index.getX(i * 3) : i * 3;
      const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
      const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;
      a.fromBufferAttribute(posAttr, i0).applyMatrix4(m);
      b.fromBufferAttribute(posAttr, i1).applyMatrix4(m);
      c.fromBufferAttribute(posAttr, i2).applyMatrix4(m);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
      tris.push({ a: a.clone(), b: b.clone(), c: c.clone(), n, srcMesh: mesh.uuid, srcIndices: [i0, i1, i2] });
    }
  });
  return tris;
}

/** Cosine-weighted hemisphere sample around `normal` using deterministic
 *  Fibonacci spiral — gives well-distributed samples with no RNG. */
export function hemisphereSample(
  i: number,
  n: number,
  normal: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const golden = 2.39996323; // π * (3 - √5)
  const phi = i * golden;
  // Cosine-weighted distribution: more samples near the pole.
  const cosTheta = Math.sqrt(1 - (i + 0.5) / n);
  const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
  const lx = sinTheta * Math.cos(phi);
  const ly = sinTheta * Math.sin(phi);
  const lz = cosTheta;
  // Build a TBN basis from `normal`.
  const up = Math.abs(normal.y) < 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const tx = new THREE.Vector3().crossVectors(normal, up).normalize();
  const ty = new THREE.Vector3().crossVectors(normal, tx).normalize();
  out.set(
    tx.x * lx + ty.x * ly + normal.x * lz,
    tx.y * lx + ty.y * ly + normal.y * lz,
    tx.z * lx + ty.z * ly + normal.z * lz,
  ).normalize();
  return out;
}

/** Compute ambient occlusion (0..1) + direct sun term (0..1) for a single
 *  vertex. Pure-arithmetic; exported so unit tests can verify the math
 *  without a full scene. */
export function computeVertexAO(
  vertex: THREE.Vector3,
  normal: THREE.Vector3,
  tris: Triangle[],
  sunDir: THREE.Vector3,
  samples: number,
  maxRay: number,
  /** A3-5000-retry / prompt 404: optional set of triangle indices to skip
   *  (the source-triangle indices for this vertex). Prevents flat surfaces
   *  from darkening themselves. */
  skipTriIndices?: Set<number>,
  /** A3-5000-retry / prompt 450: optional sky color (linear sRGB) + intensity.
   *  Adds a sky term: `skyDotN * skyColor * skyIntensity` when the sky ray
   *  is unoccluded. */
  sky?: { color: THREE.Vector3; intensity: number },
  /** E1-5000 #2376 — optional accent light (secondary directional fill). */
  accent?: { direction: THREE.Vector3; color: THREE.Vector3; intensity: number },
): { ao: number; sun: number; sky: number; accent: number } {
  let occluded = 0;
  let sunBlocked = false;
  let skyBlocked = false;
  let accentBlocked = false;
  const sampleDir = new THREE.Vector3();
  // Sun ray first — if it's unoccluded, the vertex gets the direct term.
  const sunDotN = Math.max(0, normal.dot(sunDir.clone().negate()));
  // The sun ray travels TOWARD the sun; we cast in `-sunDir` from the vertex
  // (light travels along `sunDir` so we look back along it for occluders).
  const sunRayDir = sunDir.clone().negate().normalize();
  // Sky ray — straight up. Used for the sky term (prompt 450).
  const skyRayDir = new THREE.Vector3(0, 1, 0);
  const skyDotN = Math.max(0, normal.dot(skyRayDir));
  // E1-5000 #2376 — Accent ray (secondary fill light).
  const accentRayDir = accent ? accent.direction.clone().negate().normalize() : null;
  const accentDotN = accent ? Math.max(0, normal.dot(accent!.direction.clone().negate())) : 0;
  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti];
    if (skipTriIndices?.has(ti)) continue; // A3-5000-retry / 404: skip source tri
    if (!sunBlocked) {
      if (rayTriangle(vertex, sunRayDir, t, maxRay) > 0) {
        // E1-5000 #2329 — Back-face test (corrected: see comment above).
        if (t.n.dot(sunRayDir) > 0) sunBlocked = true;
      }
    }
    if (sky && !skyBlocked && skyDotN > 0) {
      if (rayTriangle(vertex, skyRayDir, t, maxRay) > 0) skyBlocked = true;
    }
    if (accent && !accentBlocked && accentDotN > 0 && accentRayDir) {
      if (rayTriangle(vertex, accentRayDir, t, maxRay) > 0) accentBlocked = true;
    }
    if (sunBlocked && (!sky || skyBlocked) && (!accent || accentBlocked)) break;
  }
  // Hemisphere samples for AO.
  for (let i = 0; i < samples; i++) {
    hemisphereSample(i, samples, normal, sampleDir);
    for (let ti = 0; ti < tris.length; ti++) {
      if (skipTriIndices?.has(ti)) continue; // A3-5000-retry / 404: skip source tri
      if (rayTriangle(vertex, sampleDir, tris[ti], maxRay) > 0) {
        occluded++;
        break;
      }
    }
  }
  const ao = 1 - occluded / samples; // 1 = fully unoccluded
  const sun = sunBlocked ? 0 : sunDotN;
  // A3-5000-retry / 450: sky term — gives vertices under open sky a blue
  // ambient fill, preventing the flat AO-only look.
  const skyTerm = sky && !skyBlocked ? skyDotN * sky.intensity : 0;
  // E1-5000 #2376 — Accent term (one-bounce fill approximation: the sky term
  // already provides the multi-bounce sky fill; the accent adds a directional
  // warm fill as a cheap proxy for one bounce off nearby surfaces).
  const accentTerm = accent && !accentBlocked ? accentDotN * accent.intensity : 0;
  return { ao, sun, sky: skyTerm, accent: accentTerm };
}

/**
 * Bake a per-vertex AO + direct-sun lightmap for a scene.
 *
 * @param scene      The scene graph (meshes must have geometry + position attributes).
 * @param sunConfig  Sun direction (the vector the sun's light travels ALONG) + color + intensity.
 * @param quality    Samples/vertex + max ray length.
 * @returns A map of mesh.uuid → LightmapData.
 */
export function bakeLightmap(
  scene: THREE.Object3D,
  sunConfig: SunConfig,
  quality: BakeQuality = BAKE_QUALITY.medium,
): Map<string, LightmapData> {
  const out = new Map<string, LightmapData>();
  // Collect world-space triangles ONCE — reused for every vertex of every mesh.
  const tris = collectTriangles(scene);
  const sunDir = sunConfig.direction.clone().normalize();
  // AO floor — never go pitch-black so corners still read.
  const AO_FLOOR = 0.35;
  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geo || !geo.attributes.position) return;
    if ((obj as { userData?: { giSkip?: boolean } }).userData?.giSkip) return;
    const posAttr = geo.attributes.position;
    const count = posAttr.count;
    const rgb = new Float32Array(count * 3);
    const ao = new Float32Array(count);
    // A3-5000-retry / 405: removed unused `inv` matrix (was `void inv;` — dead code).
    const worldV = new THREE.Vector3();
    const worldN = new THREE.Vector3();
    const normalAttr = geo.attributes.normal;
    // Reusable sun color (cloned to avoid mutating the caller's vector).
    const sunCol = sunConfig.color.clone().multiplyScalar(sunConfig.intensity);
    // A3-5000-retry / 404: build a per-vertex skip set — for vertex i, skip
    // every triangle that has i as one of its srcIndices. This is the source-
    // triangle skip the prompt requires (flat surfaces don't darken themselves).
    const trisByVertex = new Map<number, Set<number>>();
    for (let ti = 0; ti < tris.length; ti++) {
      const t = tris[ti];
      if (t.srcMesh !== mesh.uuid || !t.srcIndices) continue;
      for (const vi of t.srcIndices) {
        let s = trisByVertex.get(vi);
        if (!s) { s = new Set<number>(); trisByVertex.set(vi, s); }
        s.add(ti);
      }
    }
    // A3-5000-retry / 450: optional sky term (defaults to a soft blue sky).
    const sky = (sunConfig as SunConfig & { sky?: { color: THREE.Vector3; intensity: number } }).sky
      ?? { color: new THREE.Vector3(0.45, 0.6, 0.85), intensity: 0.25 };
    // E1-5000 #2376 — accent light (optional secondary directional fill).
    const accent = sunConfig.accent;
    for (let i = 0; i < count; i++) {
      worldV.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      if (normalAttr) {
        worldN.fromBufferAttribute(normalAttr, i).transformDirection(mesh.matrixWorld).normalize();
      } else {
        worldN.set(0, 1, 0);
      }
      const skip = trisByVertex.get(i);
      const { ao: a, sun: s, sky: sk, accent: ac } = computeVertexAO(
        worldV, worldN, tris, sunDir, quality.samples, quality.maxRay, skip, sky, accent,
      );
      ao[i] = a;
      // Combined baked term: ambient (AO-modulated) + direct sun + sky fill + accent.
      const ambient = AO_FLOOR + (1 - AO_FLOOR) * a;
      const r = ambient + s * sunCol.x + sk * sky.color.x + ac * (accent ? accent.color.x : 0);
      const g = ambient + s * sunCol.y + sk * sky.color.y + ac * (accent ? accent.color.y : 0);
      const b = ambient + s * sunCol.z + sk * sky.color.z + ac * (accent ? accent.color.z : 0);
      // Store in LINEAR space — applyLightmap sets vertexColors=true so the
      // standard material multiplies this into the diffuse term in linear.
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = b;
    }
    out.set(mesh.uuid, { rgb, ao, meshUuid: mesh.uuid, sampleCount: quality.samples });
  });
  return out;
}

/**
 * Apply a baked lightmap to a mesh. Installs the `color` attribute + flips
 * `vertexColors=true` on every material slot. Returns a disposer that
 * restores the mesh to its pre-bake state.
 */
export function applyLightmap(
  mesh: THREE.Mesh,
  lightmap: LightmapData,
): () => void {
  const geo = mesh.geometry as THREE.BufferGeometry;
  const prevColor = geo.getAttribute("color") as THREE.BufferAttribute | undefined;
  const prevVertexColors: boolean[] = [];
  // A3-5000-retry / 406: preserve existing vertex colors. If the mesh
  // already has a `color` attribute (e.g. procedural humanoids use it for
  // tint), we multiply the baked GI into the existing colors instead of
  // overwriting them. This keeps tint information while still applying AO.
  let outRgb = lightmap.rgb;
  if (prevColor && prevColor.itemSize === 3) {
    const prevArr = prevColor.array as ArrayLike<number>;
    const merged = new Float32Array(lightmap.rgb.length);
    for (let i = 0; i < merged.length; i++) {
      merged[i] = lightmap.rgb[i] * (prevArr[i] as number);
    }
    outRgb = merged;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(outRgb, 3));
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mats.forEach((m, i) => {
    if (m && "vertexColors" in m) {
      prevVertexColors[i] = (m as THREE.MeshStandardMaterial).vertexColors;
      (m as THREE.MeshStandardMaterial).vertexColors = true;
      (m as THREE.MeshStandardMaterial).needsUpdate = true;
    }
  });
  return () => {
    if (prevColor) geo.setAttribute("color", prevColor);
    else geo.deleteAttribute("color");
    mats.forEach((m, i) => {
      if (m && "vertexColors" in m) {
        (m as THREE.MeshStandardMaterial).vertexColors = prevVertexColors[i] ?? false;
        (m as THREE.MeshStandardMaterial).needsUpdate = true;
      }
    });
  };
}

/**
 * Bake + apply in one call for every mesh in the scene that received a
 * lightmap. Returns an aggregate disposer that undoes all installs.
 *
 * This is the entrypoint RenderPipeline.ts calls when `enableDDGI=true`.
 */
export function bakeAndApplyLightmaps(
  scene: THREE.Object3D,
  sunConfig: SunConfig,
  quality?: BakeQuality,
): () => void {
  const maps = bakeLightmap(scene, sunConfig, quality);
  const disposers: Array<() => void> = [];
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const lm = maps.get(mesh.uuid);
    if (lm) disposers.push(applyLightmap(mesh, lm));
  });
  return () => disposers.forEach((d) => d());
}

/**
 * A3-5000-retry / 449: async chunked baker — yields to the main thread every
 * `yieldEvery` vertices so a bake does not freeze the UI. The full Web-Worker
 * move (5B ray-triangle tests moved off-main) is the long-term target; this
 * chunked-yield fallback is the surgical mitigation that ships now.
 */
export async function bakeLightmapAsync(
  scene: THREE.Object3D,
  sunConfig: SunConfig,
  quality: BakeQuality = BAKE_QUALITY.medium,
  yieldEvery = 256,
): Promise<Map<string, LightmapData>> {
  const out = new Map<string, LightmapData>();
  const tris = collectTriangles(scene);
  const sunDir = sunConfig.direction.clone().normalize();
  const AO_FLOOR = 0.35;
  const sky = (sunConfig as SunConfig & { sky?: { color: THREE.Vector3; intensity: number } }).sky
    ?? { color: new THREE.Vector3(0.45, 0.6, 0.85), intensity: 0.25 };
  scene.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geo || !geo.attributes.position) return;
    if ((obj as { userData?: { giSkip?: boolean } }).userData?.giSkip) return;
    meshes.push(mesh);
  });
  for (const mesh of meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.attributes.position;
    const count = posAttr.count;
    const rgb = new Float32Array(count * 3);
    const ao = new Float32Array(count);
    const worldV = new THREE.Vector3();
    const worldN = new THREE.Vector3();
    const normalAttr = geo.attributes.normal;
    const sunCol = sunConfig.color.clone().multiplyScalar(sunConfig.intensity);
    const trisByVertex = new Map<number, Set<number>>();
    for (let ti = 0; ti < tris.length; ti++) {
      const t = tris[ti];
      if (t.srcMesh !== mesh.uuid || !t.srcIndices) continue;
      for (const vi of t.srcIndices) {
        let s = trisByVertex.get(vi);
        if (!s) { s = new Set<number>(); trisByVertex.set(vi, s); }
        s.add(ti);
      }
    }
    for (let i = 0; i < count; i++) {
      worldV.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      if (normalAttr) {
        worldN.fromBufferAttribute(normalAttr, i).transformDirection(mesh.matrixWorld).normalize();
      } else {
        worldN.set(0, 1, 0);
      }
      const skip = trisByVertex.get(i);
      const { ao: a, sun: s, sky: sk } = computeVertexAO(
        worldV, worldN, tris, sunDir, quality.samples, quality.maxRay, skip, sky,
      );
      ao[i] = a;
      const ambient = AO_FLOOR + (1 - AO_FLOOR) * a;
      rgb[i * 3] = ambient + s * sunCol.x + sk * sky.color.x;
      rgb[i * 3 + 1] = ambient + s * sunCol.y + sk * sky.color.y;
      rgb[i * 3 + 2] = ambient + s * sunCol.z + sk * sky.color.z;
      if ((i & (yieldEvery - 1)) === 0 && i > 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
    out.set(mesh.uuid, { rgb, ao, meshUuid: mesh.uuid, sampleCount: quality.samples });
  }
  return out;
}

/** Build a SunConfig from a sun direction + color hex + intensity. */
export function makeSunConfig(
  dir: THREE.Vector3,
  colorHex: number,
  intensity: number,
): SunConfig {
  const c = new THREE.Color(colorHex);
  return {
    direction: dir.clone().normalize(),
    color: new THREE.Vector3(c.r, c.g, c.b),
    intensity,
  };
}
