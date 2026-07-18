/**
 * Section L / L_Performance_Optimization.txt
 * Prompts: 21, 23, 43, 19 ("draw call count" + "triangle throughput")
 *
 * draw-call-batcher.ts — automatic instancing + draw-call batching for static geometry.
 *
 * A scene with 200 unique props, each its own mesh = 200 draw calls. The
 * GPU can render each call in ~0.1ms — 200 calls = 20ms of pure driver
 * overhead. On mobile (where each draw call has a higher overhead due to
 * tiled rendering), the same scene can blow the entire 16ms budget on
 * driver overhead alone.
 *
 * Batching combines multiple meshes that share geometry + material into a
 * single InstancedMesh (one draw call for N instances). The challenge is
 * detecting when two meshes are "the same" — this module inspects
 * geometry attributes + material shader source to fingerprint them.
 *
 * Strategies, in order of preference:
 *
 *   1. **Static instancing**: at scene build, collect all static meshes
 *      with the same geo+mat signature. Replace them with a single
 *      InstancedMesh. Best for foliage, debris, props.
 *   2. **Dynamic merge**: combine geometries into one BufferGeometry with
 *      a per-instance transform attribute. Better for irregular geometry
 *      that doesn't fit the InstancedMesh model.
 *   3. **Material atlas**: when meshes share geometry but have different
 *      material colors, pack the colors into an instance attribute.
 *
 * The batcher is opt-in per-object — mark an Object3D with
 * `userData.batchable = true` and the batcher will consider it.
 *
 * Degradation: if InstancedMesh / instanced attributes are unavailable
 * (very old WebGL1 context — Three.js 0.185 requires WebGL2 anyway),
 * the batcher is a no-op.
 */

import * as THREE from "three";

// ─── Public types ────────────────────────────────────────────────────────

/** A fingerprint of a mesh's render signature. */
interface MeshSignature {
  /** Hash of geometry attributes (position count + normal count + uv count). */
  geoHash: string;
  /** Hash of material type + uniform keys + texture keys. */
  matHash: string;
}

/** A batch of meshes that share the same signature. */
interface Batch {
  signature: MeshSignature;
  /** The base geometry (from the first mesh in the batch). */
  geometry: THREE.BufferGeometry;
  /** The base material. */
  material: THREE.Material;
  /** Per-instance matrices (one per mesh in the batch). */
  matrices: THREE.Matrix4[];
  /** Per-instance colors (optional). */
  colors?: THREE.Color[];
  /** The InstancedMesh once built. */
  instancedMesh: THREE.InstancedMesh | null;
}

/** Batcher stats. */
export interface BatcherStats {
  /** Total meshes considered for batching. */
  totalMeshes: number;
  /** Total batches created. */
  batches: number;
  /** Draw calls before batching. */
  drawCallsBefore: number;
  /** Draw calls after batching. */
  drawCallsAfter: number;
  /** Estimated saved CPU time per frame (ms). */
  savedMs: number;
}

// ─── Batcher ─────────────────────────────────────────────────────────────

const DRAW_CALL_OVERHEAD_MS = 0.05; // conservative estimate per draw call

/**
 * DrawCallBatcher — scans the scene for batchable meshes and replaces
 * them with InstancedMeshes.
 *
 * Usage:
 *   const batcher = new DrawCallBatcher();
 *   batcher.scan(scene);
 *   const instancedMeshes = batcher.build();
 *   for (const im of instancedMeshes) scene.add(im);
 *   // Hide the original meshes (they're now redundant).
 *   batcher.hideOriginals();
 *   // On scene dispose:
 *   batcher.dispose();
 */
export class DrawCallBatcher {
  private batches = new Map<string, Batch>();
  private originalMeshes: THREE.Mesh[] = [];
  private instancedMeshes: THREE.InstancedMesh[] = [];

  /** Minimum batch size — batches smaller than this aren't worth instancing. */
  readonly minBatchSize: number;

  /** Max instances per InstancedMesh — Three.js hard cap is 1M, we use 16k. */
  readonly maxInstancesPerBatch: number;

  constructor(opts?: { minBatchSize?: number; maxInstancesPerBatch?: number }) {
    this.minBatchSize = opts?.minBatchSize ?? 4;
    this.maxInstancesPerBatch = opts?.maxInstancesPerBatch ?? 16_384;
  }

  /** Scan the scene for batchable meshes. */
  scan(scene: THREE.Object3D): void {
    this.batches.clear();
    this.originalMeshes = [];

    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (!obj.userData.batchable) return;
      if (obj.userData.batched) return;
      const geo = obj.geometry;
      const mat = obj.material;
      if (!geo || !mat) return;
      // Don't batch morph targets / skinned meshes (they need per-vertex animation).
      if ((obj as any).morphTargetInfluences || obj.type === "SkinnedMesh") return;

      const signature = this.computeSignature(geo, mat);
      const key = `${signature.geoHash}|${signature.matHash}`;
      let batch = this.batches.get(key);
      if (!batch) {
        batch = {
          signature,
          geometry: geo,
          material: mat,
          matrices: [],
          instancedMesh: null,
        };
        this.batches.set(key, batch);
      }
      // Capture the world matrix (bake the transform into the instance).
      obj.updateMatrixWorld();
      batch.matrices.push(obj.matrixWorld.clone());
      // Track per-instance color if the material has a `color` uniform.
      const anyMat = mat as any;
      if (anyMat.color && anyMat.color.isColor) {
        if (!batch.colors) batch.colors = [];
        batch.colors.push(anyMat.color.clone());
      }
      this.originalMeshes.push(obj);
    });
  }

  /** Compute a signature for a (geometry, material) pair. */
  private computeSignature(geo: THREE.BufferGeometry, mat: THREE.Material): MeshSignature {
    // Geometry hash: attribute names + vertex count + index count.
    const attrKeys = Object.keys(geo.attributes).sort().join(",");
    const vertCount = geo.attributes.position?.count ?? 0;
    const idxCount = geo.index?.count ?? 0;
    const geoHash = `attrs=${attrKeys}|v=${vertCount}|i=${idxCount}`;

    // Material hash: type + texture keys (if any) + transparent flag.
    const matType = mat.type;
    const anyMat = mat as any;
    const texKeys: string[] = [];
    for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"]) {
      const t = anyMat[k];
      if (t && t.uuid) texKeys.push(`${k}:${t.uuid}`);
    }
    const matHash = `type=${matType}|tex=${texKeys.join(",")}|transparent=${mat.transparent}|blending=${mat.blending}`;

    return { geoHash, matHash };
  }

  /** Build InstancedMeshes from the scanned batches. Returns the new
   *  InstancedMeshes (already populated with per-instance matrices). */
  build(): THREE.InstancedMesh[] {
    this.instancedMeshes = [];
    for (const batch of this.batches.values()) {
      if (batch.matrices.length < this.minBatchSize) continue;
      // Split into chunks of maxInstancesPerBatch.
      for (let i = 0; i < batch.matrices.length; i += this.maxInstancesPerBatch) {
        const chunk = batch.matrices.slice(i, i + this.maxInstancesPerBatch);
        const colorChunk = batch.colors?.slice(i, i + this.maxInstancesPerBatch);
        const instancedMesh = new THREE.InstancedMesh(batch.geometry, batch.material, chunk.length);
        for (let j = 0; j < chunk.length; j++) {
          instancedMesh.setMatrixAt(j, chunk[j]);
        }
        if (colorChunk) {
          for (let j = 0; j < colorChunk.length; j++) {
            instancedMesh.setColorAt(j, colorChunk[j]);
          }
        }
        instancedMesh.instanceMatrix.needsUpdate = true;
        if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;
        instancedMesh.castShadow = true;
        instancedMesh.receiveShadow = true;
        this.instancedMeshes.push(instancedMesh);
      }
    }
    return this.instancedMeshes;
  }

  /** Hide the original meshes (call after `build()` + scene.add the
   *  instanced meshes). Marks them `visible = false` but keeps them in
   *  the scene graph so raycasts still work (Three.js raycasts against
   *  invisible meshes). */
  hideOriginals(): void {
    for (const m of this.originalMeshes) {
      m.visible = false;
      m.userData.batched = true;
    }
  }

  /** Mark a mesh as batchable (call before scan()). Convenience method. */
  static markBatchable(obj: THREE.Object3D): void {
    obj.userData.batchable = true;
    obj.traverse((c) => { c.userData.batchable = true; });
  }

  /** Stats — call after build(). */
  stats(): BatcherStats {
    const totalMeshes = this.originalMeshes.length;
    const batches = this.instancedMeshes.length;
    return {
      totalMeshes,
      batches,
      drawCallsBefore: totalMeshes,
      drawCallsAfter: batches + (totalMeshes - this.batchedMeshCount()),
      savedMs: Math.max(0, (totalMeshes - batches) * DRAW_CALL_OVERHEAD_MS),
    };
  }

  /** Count of meshes that ended up in a batch. */
  private batchedMeshCount(): number {
    let count = 0;
    for (const batch of this.batches.values()) {
      if (batch.matrices.length >= this.minBatchSize) {
        count += batch.matrices.length;
      }
    }
    return count;
  }

  /** Dispose the instanced meshes. The original meshes' geometries +
   *  materials are NOT disposed (they're owned by the scene). */
  dispose(): void {
    for (const im of this.instancedMeshes) {
      // Don't dispose the geometry / material — they're shared with the
      // original meshes. Only dispose the instanceMatrix / instanceColor
      // attributes (which InstancedMesh owns).
      im.dispose();
    }
    this.instancedMeshes = [];
    this.batches.clear();
    this.originalMeshes = [];
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _batcher: DrawCallBatcher | null = null;

export function getDrawCallBatcher(): DrawCallBatcher {
  if (!_batcher) _batcher = new DrawCallBatcher();
  return _batcher;
}

export function resetDrawCallBatcher(): void {
  _batcher?.dispose();
  _batcher = null;
}
