/**
 * Section L / L_Performance_Optimization.txt
 * Prompts: 17, 27, 36, 45, 50 ("GC pauses" + "asset download size")
 *
 * memory-pool.ts — Three.js object pooling for geometries, materials, textures.
 *
 * The existing ObjectPool.ts pools PARTICLES (sprites + meshes + tracers +
 * decals). This module pools the THREE.JS RESOURCES those objects depend
 * on — geometries, materials, textures — which are far more expensive to
 * allocate (driver upload, shader compile) than the wrapper Object3Ds.
 *
 * Patterns pooled:
 *
 *   - **Geometry pool**: a HashMap<geoKey, BufferGeometry> shared across
 *     all instances of the same shape (e.g. all "box-0.15" debris). Each
 *     pooled geometry is reference-counted; dispose() is called when the
 *     count hits zero (NOT before — premature dispose causes the next
 *     instance to re-upload).
 *   - **Material pool**: same pattern for materials. Material instances
 *     with the same shader + uniforms share a single THREE.Material
 *     (with per-instance properties via onBeforeCompile if needed).
 *   - **Texture pool**: textures are deduplicated by URL — the same
 *     "wood_diffuse.jpg" loaded by 5 props uses ONE GPU texture.
 *   - **Disposer**: a stack of strong refs that drains on `flush()`,
 *     useful for level transitions.
 *
 * The pool degrades gracefully — if memory pressure is detected (JS heap
 * above 80% of `jsHeapSizeLimit`), `flushLRU()` evicts the least-recently-
 * used entries (their dispose() is called, freeing VRAM).
 */

import * as THREE from "three";

// ─── Public types ────────────────────────────────────────────────────────

/** Key for a shared geometry — usually the shape signature. */
export type GeometryKey = string;

/** Key for a shared material — usually material slug + variant. */
export type MaterialKey = string;

/** Key for a shared texture — usually the URL. */
export type TextureKey = string;

/** A pooled entry with reference count + LRU timestamp. */
interface PooledEntry<T> {
  /** The pooled object. */
  obj: T;
  /** Current ref count — dispose() is called when this hits 0. */
  refCount: number;
  /** Last frame this entry was acquired (for LRU eviction). */
  lastUsedFrame: number;
}

/** Memory pool stats for the perf overlay. */
export interface MemoryPoolStats {
  geometries: { count: number; bytes: number };
  materials: { count: number; bytes: number };
  textures: { count: number; bytes: number };
  totalBytes: number;
  evictions: number;
}

// ─── Memory pool ─────────────────────────────────────────────────────────

/**
 * ThreeMemoryPool — central registry for shared THREE.js resources.
 *
 * Usage:
 *   const pool = new ThreeMemoryPool();
 *   const geo = pool.acquireGeometry("box-0.15", () => new THREE.BoxGeometry(0.15, 0.15, 0.15));
 *   ... use geo ...
 *   pool.releaseGeometry("box-0.15"); // decrements refcount
 *
 * The factory is called only on first acquire; subsequent acquires return
 * the cached instance + bump the refcount.
 */
export class ThreeMemoryPool {
  private geometries = new Map<GeometryKey, PooledEntry<THREE.BufferGeometry>>();
  private materials = new Map<MaterialKey, PooledEntry<THREE.Material>>();
  private textures = new Map<TextureKey, PooledEntry<THREE.Texture>>();
  private evictions = 0;
  private currentFrame = 0;

  /** Estimate of total pooled VRAM (bytes). */
  private estimateGeoBytes(g: THREE.BufferGeometry): number {
    let bytes = 0;
    for (const k in g.attributes) {
      const attr = g.attributes[k] as THREE.BufferAttribute;
      bytes += attr.array.byteLength;
    }
    if (g.index) bytes += g.index.array.byteLength;
    return bytes;
  }

  private estimateTexBytes(t: THREE.Texture): number {
    const img = t.image as HTMLImageElement | { width?: number; height?: number } | undefined;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    return w * h * 4; // RGBA8
  }

  private estimateMatBytes(_m: THREE.Material): number {
    // Materials are small but each shader variant consumes ~8KB of program
    // storage. Use a flat 8KB estimate.
    return 8 * 1024;
  }

  // ── Geometry ──────────────────────────────────────────────────────────

  /** Acquire a shared geometry. Factory runs only on first acquire. */
  acquireGeometry(key: GeometryKey, factory: () => THREE.BufferGeometry): THREE.BufferGeometry {
    this.currentFrame++;
    let entry = this.geometries.get(key);
    if (!entry) {
      const geo = factory();
      entry = { obj: geo, refCount: 0, lastUsedFrame: this.currentFrame };
      this.geometries.set(key, entry);
    }
    entry.refCount++;
    entry.lastUsedFrame = this.currentFrame;
    return entry.obj;
  }

  /** Release a geometry (decrement refcount). */
  releaseGeometry(key: GeometryKey): void {
    const entry = this.geometries.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.obj.dispose();
      this.geometries.delete(key);
    }
  }

  // ── Material ──────────────────────────────────────────────────────────

  /** Acquire a shared material. */
  acquireMaterial(key: MaterialKey, factory: () => THREE.Material): THREE.Material {
    this.currentFrame++;
    let entry = this.materials.get(key);
    if (!entry) {
      const mat = factory();
      entry = { obj: mat, refCount: 0, lastUsedFrame: this.currentFrame };
      this.materials.set(key, entry);
    }
    entry.refCount++;
    entry.lastUsedFrame = this.currentFrame;
    return entry.obj;
  }

  /** Release a material. */
  releaseMaterial(key: MaterialKey): void {
    const entry = this.materials.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.obj.dispose();
      this.materials.delete(key);
    }
  }

  // ── Texture ───────────────────────────────────────────────────────────

  /** Acquire a shared texture. */
  acquireTexture(key: TextureKey, factory: () => THREE.Texture): THREE.Texture {
    this.currentFrame++;
    let entry = this.textures.get(key);
    if (!entry) {
      const tex = factory();
      entry = { obj: tex, refCount: 0, lastUsedFrame: this.currentFrame };
      this.textures.set(key, entry);
    }
    entry.refCount++;
    entry.lastUsedFrame = this.currentFrame;
    return entry.obj;
  }

  /** Release a texture. */
  releaseTexture(key: TextureKey): void {
    const entry = this.textures.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.obj.dispose();
      this.textures.delete(key);
    }
  }

  // ── LRU eviction ──────────────────────────────────────────────────────

  /**
   * Flush the LRU entries until pooled bytes drops below `targetBytes`.
   * Disposes + removes entries with the smallest `lastUsedFrame` first.
   * Entries with refCount > 0 are skipped (still in use).
   */
  flushLRU(targetBytes: number): number {
    const all: Array<{ key: string; entry: PooledEntry<any>; bytes: number; kind: "geo" | "mat" | "tex" }> = [];
    for (const [k, e] of this.geometries) all.push({ key: k, entry: e, bytes: this.estimateGeoBytes(e.obj), kind: "geo" });
    for (const [k, e] of this.materials) all.push({ key: k, entry: e, bytes: this.estimateMatBytes(e.obj), kind: "mat" });
    for (const [k, e] of this.textures) all.push({ key: k, entry: e, bytes: this.estimateTexBytes(e.obj), kind: "tex" });

    all.sort((a, b) => a.entry.lastUsedFrame - b.entry.lastUsedFrame);

    let currentBytes = all.reduce((s, e) => s + e.bytes, 0);
    for (const e of all) {
      if (currentBytes <= targetBytes) break;
      if (e.entry.refCount > 0) continue; // still in use
      e.entry.obj.dispose();
      if (e.kind === "geo") this.geometries.delete(e.key);
      else if (e.kind === "mat") this.materials.delete(e.key);
      else this.textures.delete(e.key);
      currentBytes -= e.bytes;
      this.evictions++;
    }
    return currentBytes;
  }

  /**
   * Auto-flush based on detected JS heap pressure. If `performance.memory`
   * is available, flushes when usedJSHeapSize > 80% of jsHeapSizeLimit.
   * Returns the new estimated total bytes.
   */
  autoFlush(): number {
    const mem = (performance as any).memory;
    if (!mem) return this.totalBytes();
    if (mem.usedJSHeapSize < mem.jsHeapSizeLimit * 0.8) return this.totalBytes();
    // Flush to 50% of the limit.
    return this.flushLRU(mem.jsHeapSizeLimit * 0.5);
  }

  /** Total estimated pooled bytes. */
  totalBytes(): number {
    let sum = 0;
    for (const e of this.geometries.values()) sum += this.estimateGeoBytes(e.obj);
    for (const e of this.materials.values()) sum += this.estimateMatBytes(e.obj);
    for (const e of this.textures.values()) sum += this.estimateTexBytes(e.obj);
    return sum;
  }

  /** Snapshot for diagnostics. */
  stats(): MemoryPoolStats {
    let geoBytes = 0, matBytes = 0, texBytes = 0;
    for (const e of this.geometries.values()) geoBytes += this.estimateGeoBytes(e.obj);
    for (const e of this.materials.values()) matBytes += this.estimateMatBytes(e.obj);
    for (const e of this.textures.values()) texBytes += this.estimateTexBytes(e.obj);
    return {
      geometries: { count: this.geometries.size, bytes: geoBytes },
      materials: { count: this.materials.size, bytes: matBytes },
      textures: { count: this.textures.size, bytes: texBytes },
      totalBytes: geoBytes + matBytes + texBytes,
      evictions: this.evictions,
    };
  }

  /** Dispose everything. */
  dispose(): void {
    for (const e of this.geometries.values()) e.obj.dispose();
    for (const e of this.materials.values()) e.obj.dispose();
    for (const e of this.textures.values()) e.obj.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _pool: ThreeMemoryPool | null = null;

export function getThreeMemoryPool(): ThreeMemoryPool {
  if (!_pool) _pool = new ThreeMemoryPool();
  return _pool;
}

export function resetThreeMemoryPool(): void {
  _pool?.dispose();
  _pool = null;
}

// ─── Disposable stack helper ─────────────────────────────────────────────

/**
 * DisposableStack — for level transitions. Acquire resources into the
 * stack, then `dispose()` to release them all at once.
 */
export class DisposableStack {
  private entries: Array<{ kind: "geo" | "mat" | "tex"; key: string; pool: ThreeMemoryPool }> = [];

  constructor(private pool: ThreeMemoryPool) {}

  acquireGeometry(key: GeometryKey, factory: () => THREE.BufferGeometry): THREE.BufferGeometry {
    this.entries.push({ kind: "geo", key, pool: this.pool });
    return this.pool.acquireGeometry(key, factory);
  }

  acquireMaterial(key: MaterialKey, factory: () => THREE.Material): THREE.Material {
    this.entries.push({ kind: "mat", key, pool: this.pool });
    return this.pool.acquireMaterial(key, factory);
  }

  acquireTexture(key: TextureKey, factory: () => THREE.Texture): THREE.Texture {
    this.entries.push({ kind: "tex", key, pool: this.pool });
    return this.pool.acquireTexture(key, factory);
  }

  /** Release everything in this stack. */
  dispose(): void {
    for (const e of this.entries) {
      if (e.kind === "geo") e.pool.releaseGeometry(e.key);
      else if (e.kind === "mat") e.pool.releaseMaterial(e.key);
      else e.pool.releaseTexture(e.key);
    }
    this.entries = [];
  }
}
