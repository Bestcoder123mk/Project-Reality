import * as THREE from "three";
import type { Particle, Tracer } from "./types";

/**
 * ObjectPool — generic ring-buffer pool for reusable objects.
 * Eliminates per-frame allocations by recycling dormant instances.
 *
 * P2.4: used for particles (Sprites + small Meshes), tracers (THREE.Line),
 * and decals (THREE.Mesh). Each pool pre-allocates a fixed population at
 * construction; spawn() activates a dormant one, retire() returns it.
 */
export class ObjectPool<T> {
  private items: T[];
  private active = new Set<T>();
  private head = 0;
  readonly capacity: number;

  constructor(capacity: number, factory: (i: number) => T) {
    this.capacity = capacity;
    this.items = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.items[i] = factory(i);
  }

  /** Acquire an inactive item (or null if all are active). */
  acquire(): T | null {
    for (let i = 0; i < this.capacity; i++) {
      const idx = (this.head + i) % this.capacity;
      const item = this.items[idx];
      if (!this.active.has(item)) {
        this.active.add(item);
        this.head = (idx + 1) % this.capacity;
        return item;
      }
    }
    return null; // pool exhausted
  }

  /** Return an item to the pool. */
  release(item: T) { this.active.delete(item); }

  /** Iterate over all currently-active items. */
  forEachActive(fn: (item: T) => void) {
    for (const item of this.active) fn(item);
  }

  /** All active items (for in-place mutation). */
  activeItems(): T[] { return Array.from(this.active); }

  /** Count of active items. */
  get activeCount(): number { return this.active.size; }

  /** Iterate over ALL items (active + dormant) — e.g. for dispose(). */
  forEachAll(fn: (item: T) => void) {
    for (const item of this.items) fn(item);
  }

  // ─── Task 3 / item 56 — generic ObjectPool<T> usage report ──────────────
  // Exposed so the perf overlay + dev-only memory audit can summarize every
  // active pool in one shot (active/capacity/utilization%). The same shape
  // is returned by the specialized pools' `stats()` method, but this is the
  // generic version that any ObjectPool<T> consumer can call.
  /** Usage snapshot for this pool — active count, capacity, utilization %,
   *  and lifetime acquire/release counters. Active==capacity means the pool
   *  is saturated (further `acquire()` calls return null + the caller
   *  typically drops the effect). */
  usageReport(): PoolUsageReport {
    return {
      active: this.active.size,
      capacity: this.capacity,
      utilization: this.capacity > 0 ? this.active.size / this.capacity : 0,
      // Note: this generic pool doesn't track lifetime spawn/drop counters —
      // those live on the specialized wrapper (ParticleSystemPool) which
      // wraps acquire() to count spawns + drops. The generic report leaves
      // them as 0 so callers iterating heterogeneous pools don't see `null`.
      lifetimeAcquires: 0,
      lifetimeDrops: 0,
    };
  }
}

/** Task 3 / item 56 — generic pool usage report shape. Returned by
 *  `ObjectPool.usageReport()` and surfaced by the perf overlay as a per-pool
 *  table. Saturated pools (utilization === 1) are the most actionable: any
 *  further effect of that type is being dropped on the floor. */
export interface PoolUsageReport {
  /** Currently-active (borrowed) items. */
  active: number;
  /** Total items pre-allocated at construction. */
  capacity: number;
  /** active / capacity, 0..1. */
  utilization: number;
  /** Lifetime count of `acquire()` calls that returned a non-null item.
   *  0 when the wrapper doesn't track this (generic ObjectPool). */
  lifetimeAcquires: number;
  /** Lifetime count of `acquire()` calls that returned null because the
   *  pool was saturated. 0 when the wrapper doesn't track this. */
  lifetimeDrops: number;
}

// ---------- P2.4 specialized pools ----------

/**
 * ParticlePool — pre-allocates a fixed population of THREE.Sprite (for sparks/
 * smoke/blood) and THREE.Mesh (for debris). spawn* methods activate a dormant
 * instance and configure it; updateParticles retires dead ones back to the pool.
 *
 * Pool sizes are constants at the top, tunable.
 */
export const PARTICLE_SPRITE_POOL_SIZE = 200;
export const PARTICLE_MESH_POOL_SIZE = 60;
export const TRACER_POOL_SIZE = 50;
export const DECAL_POOL_SIZE = 40;

/** Tracked active particle entry — the pool item + its lifetime/velocity. */
export interface PooledParticle {
  mesh: THREE.Mesh | THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: boolean;
  fade: boolean;
  active: boolean;
}

/** Tracked active tracer entry. */
export interface PooledTracer {
  line: THREE.Line;
  life: number;
  maxLife: number;
  active: boolean;
}

/**
 * ParticleSystemPool — owns the THREE objects + the active-entry metadata.
 * ParticleSystem uses this instead of pushing to ctx.particles.
 *
 * P3.2: pool sizes are exposed as mutable static fields so they can be
 * tuned without code changes (e.g. from a debug overlay or settings panel).
 * Pool utilization stats are exposed via stats() for the debug overlay.
 */
export class ParticleSystemPool {
  spritePool: ObjectPool<THREE.Sprite>;
  meshPool: ObjectPool<THREE.Mesh>;
  tracerPool: ObjectPool<THREE.Line>;
  decalPool: ObjectPool<THREE.Mesh>;
  /** Active particle metadata — same shape as Particle, with `active` flag. */
  activeParticles: PooledParticle[] = [];
  activeTracers: PooledTracer[] = [];
  /** P3.2: total spawn count (for stats). */
  private spawnCount = 0;
  /** P3.2: total drop count (pool-exhausted events). */
  private dropCount = 0;

  constructor(private scene: THREE.Scene, textureFactory: (color: string) => THREE.Texture) {
    // Sprite pool: pre-build 200 sprites with placeholder materials.
    this.spritePool = new ObjectPool(PARTICLE_SPRITE_POOL_SIZE, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
      s.visible = false;
      scene.add(s);
      return s;
    });
    // Mesh pool: pre-build 60 small box meshes for debris.
    this.meshPool = new ObjectPool(PARTICLE_MESH_POOL_SIZE, () => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.15), new THREE.MeshStandardMaterial({ roughness: 0.8 }));
      m.visible = false;
      m.castShadow = true;
      scene.add(m);
      return m;
    });
    // Tracer pool: 50 thin lines.
    this.tracerPool = new ObjectPool(TRACER_POOL_SIZE, () => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const mat = new THREE.LineBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      scene.add(line);
      return line;
    });
    // Decal pool: 40 small circle decals.
    this.decalPool = new ObjectPool(DECAL_POOL_SIZE, () => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(0.08, 8), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
      m.visible = false;
      scene.add(m);
      return m;
    });
  }

  /** Acquire a sprite for a spark/smoke/blood particle. Returns null if pool exhausted. */
  acquireSprite(texture: THREE.Texture, color: number): THREE.Sprite | null {
    const s = this.spritePool.acquire();
    if (!s) { this.dropCount++; return null; }
    this.spawnCount++;
    const mat = s.material as THREE.SpriteMaterial;
    mat.map = texture;
    mat.color.setHex(color);
    mat.opacity = 1;
    s.visible = true;
    return s;
  }

  /** Acquire a mesh for a debris particle. */
  acquireMesh(color: THREE.Color): THREE.Mesh | null {
    const m = this.meshPool.acquire();
    if (!m) { this.dropCount++; return null; }
    this.spawnCount++;
    (m.material as THREE.MeshStandardMaterial).color.copy(color);
    (m.material as THREE.MeshStandardMaterial).opacity = 1;
    (m.material as THREE.MeshStandardMaterial).transparent = false;
    m.visible = true;
    return m;
  }

  /** Acquire a tracer line. */
  acquireTracer(from: THREE.Vector3, to: THREE.Vector3): THREE.Line | null {
    const line = this.tracerPool.acquire();
    if (!line) { this.dropCount++; return null; }
    this.spawnCount++;
    const positions = line.geometry.attributes.position.array as Float32Array;
    positions[0] = from.x; positions[1] = from.y; positions[2] = from.z;
    positions[3] = to.x; positions[4] = to.y; positions[5] = to.z;
    line.geometry.attributes.position.needsUpdate = true;
    (line.material as THREE.LineBasicMaterial).opacity = 0.9;
    line.visible = true;
    return line;
  }

  /** Acquire a decal mesh. */
  acquireDecal(point: THREE.Vector3, normal: THREE.Vector3): THREE.Mesh | null {
    const d = this.decalPool.acquire();
    if (!d) { this.dropCount++; return null; }
    this.spawnCount++;
    d.position.copy(point).add(normal.clone().multiplyScalar(0.01));
    d.lookAt(point.clone().add(normal));
    (d.material as THREE.MeshBasicMaterial).opacity = 0.85;
    d.visible = true;
    return d;
  }

  /** P3.2: snapshot of pool utilization (for debug overlay). */
  stats() {
    return {
      sprites: { active: this.spritePool.activeCount, capacity: this.spritePool.capacity },
      meshes: { active: this.meshPool.activeCount, capacity: this.meshPool.capacity },
      tracers: { active: this.tracerPool.activeCount, capacity: this.tracerPool.capacity },
      decals: { active: this.decalPool.activeCount, capacity: this.decalPool.capacity },
      spawnCount: this.spawnCount,
      dropCount: this.dropCount,
    };
  }

  /** Task 3 / item 56 — per-pool usage report for the perf overlay / dev-only
   *  memory audit. Returns the generic `PoolUsageReport` shape for every
   *  underlying ObjectPool, plus the lifetime spawn/drop counters (which the
   *  generic `ObjectPool.usageReport()` leaves at 0 — the wrapper is the
   *  authoritative source for those). */
  poolReport(): Record<string, PoolUsageReport & { spawnCount: number; dropCount: number }> {
    return {
      sprites: { ...this.spritePool.usageReport(), spawnCount: this.spawnCount, dropCount: this.dropCount },
      meshes:  { ...this.meshPool.usageReport(),  spawnCount: this.spawnCount, dropCount: this.dropCount },
      tracers: { ...this.tracerPool.usageReport(), spawnCount: this.spawnCount, dropCount: this.dropCount },
      decals:  { ...this.decalPool.usageReport(),  spawnCount: this.spawnCount, dropCount: this.dropCount },
    };
  }

  /** Retire a particle back to its pool. */
  releaseParticle(p: PooledParticle) {
    p.active = false;
    p.mesh.visible = false;
    if (p.mesh instanceof THREE.Sprite) this.spritePool.release(p.mesh);
    else this.meshPool.release(p.mesh);
  }

  releaseTracer(t: PooledTracer) {
    t.active = false;
    t.line.visible = false;
    (t.line.material as THREE.LineBasicMaterial).opacity = 0;
    this.tracerPool.release(t.line);
  }

  /** Dispose all pooled objects (call from engine.dispose). */
  dispose() {
    this.spritePool.forEachAll((s) => { this.scene.remove(s); (s.material as THREE.SpriteMaterial).dispose(); });
    this.meshPool.forEachAll((m) => { this.scene.remove(m); (m.material as THREE.Material).dispose(); m.geometry.dispose(); });
    this.tracerPool.forEachAll((l) => { this.scene.remove(l); (l.material as THREE.Material).dispose(); l.geometry.dispose(); });
    this.decalPool.forEachAll((d) => { this.scene.remove(d); (d.material as THREE.Material).dispose(); d.geometry.dispose(); });
    this.activeParticles = [];
    this.activeTracers = [];
  }
}

/** Legacy compat re-exports. */
export type { Particle, Tracer };
