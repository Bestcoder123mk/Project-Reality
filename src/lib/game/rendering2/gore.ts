/**
 * SEC3-RENDER Prompt 27 — Gore / blood system with a hard toggle.
 *
 * Blood decal + hit-reaction system gated behind an explicit settings
 * toggle. Default level is "mild" — tasteful surface splatter + brief
 * blood mist on hit, no dismemberment, no pooling gore. "full" adds
 * impact-direction blood streaks + lingering pools; "off" disables every
 * blood visual (respawns replaced by grey dust).
 *
 * Respects the existing RagdollSystem — does NOT touch ragdoll physics.
 * The ragdoll's bloodied material variant is a separate concern handled
 * by the ragdoll owner; this module only handles:
 *   - Surface decals (projected onto walls/floors at the impact point)
 *   - Hit-direction blood spray particles (impact-driven)
 *   - Optional blood pool that grows over time (only on "full")
 *
 * Public API:
 *   - spawnBloodDecal(pos, dir): impact-driven decal + spray
 *   - setGoreLevel("off" | "mild" | "full"): toggles all visuals
 *   - getGoreLevel(): query the current level
 *
 * The settings persistence layer (ExtendedSettings) owns the user-facing
 * toggle. This module exposes a getter so tests can verify the level
 * without spinning up the settings store.
 */
import * as THREE from "three";

export type GoreLevel = "off" | "mild" | "full";

/** Gore config — per-level rules. Pure data so tests can verify the
 *  gating without a renderer. */
export interface GoreConfig {
  level: GoreLevel;
  /** Surface decal scale range (min, max) in world units. */
  decalScaleMin: number;
  decalScaleMax: number;
  /** Decal color (hex). */
  decalColor: number;
  /** Particle spray count per hit. */
  sprayParticleCount: number;
  /** Spray particle color. */
  sprayColor: number;
  /** Whether to spawn a lingering blood pool. */
  spawnPool: boolean;
  /** Pool growth duration (seconds). */
  poolGrowthDuration: number;
  /** Pool max scale (world units). */
  poolMaxScale: number;
  /** Decal cap (LRU recycle). */
  maxDecals: number;
  /** Mist particle count (fades fast — fine for "mild"). */
  mistParticleCount: number;
}

export const GORE_CONFIGS: Record<GoreLevel, GoreConfig> = {
  off: {
    level: "off",
    decalScaleMin: 0,
    decalScaleMax: 0,
    decalColor: 0x888888,
    sprayParticleCount: 0,
    sprayColor: 0xaaaaaa,
    spawnPool: false,
    poolGrowthDuration: 0,
    poolMaxScale: 0,
    maxDecals: 0,
    mistParticleCount: 0,
  },
  mild: {
    level: "mild",
    decalScaleMin: 0.25,
    decalScaleMax: 0.55,
    decalColor: 0x6a0a0a,
    sprayParticleCount: 8,
    sprayColor: 0x8a1a1a,
    spawnPool: false,
    poolGrowthDuration: 0,
    poolMaxScale: 0,
    maxDecals: 24,
    mistParticleCount: 4,
  },
  full: {
    level: "full",
    decalScaleMin: 0.4,
    decalScaleMax: 0.9,
    decalColor: 0x5a0808,
    sprayParticleCount: 16,
    sprayColor: 0x7a1414,
    spawnPool: true,
    poolGrowthDuration: 2.5,
    poolMaxScale: 1.5,
    maxDecals: 64,
    mistParticleCount: 8,
  },
};

/** Get the active config for a level. Pure function — exported for tests. */
export function getGoreConfig(level: GoreLevel): GoreConfig {
  return GORE_CONFIGS[level];
}

/** Cached blood decal texture — radial gradient + irregular edge. */
let _bloodDecalTex: THREE.Texture | null = null;
function getBloodDecalTexture(): THREE.Texture {
  if (_bloodDecalTex) return _bloodDecalTex;
  const size = 64;
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) {
    const data = new Uint8Array([90, 10, 10, 220]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    _bloodDecalTex = tex;
    return tex;
  }
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(120, 20, 20, 0.95)");
  grad.addColorStop(0.6, "rgba(80, 10, 10, 0.7)");
  grad.addColorStop(0.9, "rgba(60, 5, 5, 0.3)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // Irregular edge — random darker patches.
  ctx.globalCompositeOperation = "multiply";
  for (let i = 0; i < 8; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 4 + Math.random() * 8;
    const g2 = ctx.createRadialGradient(x, y, 0, x, y, r);
    g2.addColorStop(0, "rgba(60, 0, 0, 0.6)");
    g2.addColorStop(1, "rgba(60, 0, 0, 0)");
    ctx.fillStyle = g2;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  _bloodDecalTex = tex;
  return tex;
}

interface BloodDecal {
  mesh: THREE.Mesh;
  life: number;     // seconds remaining (for pool growth)
  maxLife: number;
  growing: boolean;
  startScale: number;
  endScale: number;
  active: boolean;
}

interface BloodSprayParticle {
  mesh: THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  active: boolean;
}

/** The gore system — singleton, hard-gated by gore level. */
export class GoreSystem {
  private scene: THREE.Scene | null;
  private level: GoreLevel;
  private decals: BloodDecal[] = [];
  private sprays: BloodSprayParticle[] = [];
  private decalGeo: THREE.PlaneGeometry;
  /** E1-5000 #2325 — Cap on active spray particles. The prior code
   *  unboundedly created new sprites in acquireSpray() → on a sustained
   *  firefight the spray pool grew without limit (memory + draw calls). */
  private readonly maxSprays = 256;
  /** E1-5000 #2326/#2327 — Decal fade-out duration (seconds). After a
   *  decal's growth phase completes (or immediately for non-pool decals),
   *  it fades to zero opacity over this duration, then is recycled. */
  private readonly decalFadeDuration = 8.0;

  constructor(opts: { scene?: THREE.Scene | null; level?: GoreLevel } = {}) {
    this.scene = opts.scene ?? null;
    // Default to "mild" per the spec — tasteful, not gratuitous.
    this.level = opts.level ?? "mild";
    this.decalGeo = new THREE.PlaneGeometry(1, 1);
  }

  attach(scene: THREE.Scene): void {
    this.scene = scene;
  }

  /** Set the gore level. "off" disables every blood visual immediately. */
  setGoreLevel(level: GoreLevel): void {
    this.level = level;
    if (level === "off") {
      // Hide all active decals + sprays.
      for (const d of this.decals) {
        d.active = false;
        d.mesh.visible = false;
      }
      for (const s of this.sprays) {
        s.active = false;
        s.mesh.visible = false;
      }
    }
  }

  getGoreLevel(): GoreLevel {
    return this.level;
  }

  /** Spawn a blood decal + impact spray at `pos` (world-space), projected
   *  against the surface whose normal is `dir`. The host (RagdollSystem /
   *  EnemySystem / Ballistics) calls this on every hit when the level allows. */
  spawnBloodDecal(pos: THREE.Vector3, dir: THREE.Vector3, opts?: {
    scale?: number; force?: number;
  }): void {
    if (this.level === "off" || !this.scene) return;
    const cfg = GORE_CONFIGS[this.level];
    const force = opts?.force ?? 1.0;
    const scale = opts?.scale ?? THREE.MathUtils.lerp(cfg.decalScaleMin, cfg.decalScaleMax, Math.random());

    // === Surface decal — projected against the wall/floor at `pos`. ===
    if (cfg.maxDecals > 0) {
      const entry = this.acquireDecal();
      if (entry) {
        entry.mesh.position.copy(pos).addScaledVector(dir, 0.02); // offset to avoid z-fighting
        // Orient the plane along the surface normal.
        const lookTarget = pos.clone().add(dir);
        entry.mesh.lookAt(lookTarget);
        entry.mesh.scale.setScalar(scale);
        const mat = entry.mesh.material as THREE.MeshBasicMaterial;
        mat.color.setHex(cfg.decalColor);
        mat.opacity = 0.85;
        // Random spin in local space — set on the mesh's Z rotation (the
        // plane is already oriented along the surface normal via lookAt, so
        // spinning on its local Z axis spins the decal in its plane).
        entry.mesh.rotateZ(Math.random() * Math.PI * 2);
        entry.life = cfg.poolGrowthDuration || 0.5;
        entry.maxLife = entry.life;
        entry.growing = cfg.spawnPool;
        entry.startScale = scale;
        entry.endScale = cfg.spawnPool ? scale + cfg.poolMaxScale : scale;
        entry.active = true;
        entry.mesh.visible = true;
        // E1-5000 #2328 — surface decals (non-growing) render above pools.
        entry.mesh.renderOrder = cfg.spawnPool ? 1 : 3;
      }
    }

    // === Impact spray — short-lived blood particles along the impact
    //     direction (cone). Respects ragdoll — pure visual layer. ===
    if (cfg.sprayParticleCount > 0) {
      for (let i = 0; i < cfg.sprayParticleCount; i++) {
        const s = this.acquireSpray();
        if (!s) break;
        s.mesh.position.copy(pos);
        s.mesh.scale.setScalar(0.05 + Math.random() * 0.05);
        (s.mesh.material as THREE.SpriteMaterial).color.setHex(cfg.sprayColor);
        (s.mesh.material as THREE.SpriteMaterial).opacity = 0.9;
        // Cone velocity along dir + spread.
        const spread = 0.6;
        const v = dir.clone().multiplyScalar(force * (2 + Math.random() * 3));
        v.x += (Math.random() - 0.5) * spread * 4;
        v.y += (Math.random() - 0.5) * spread * 4 + 0.5;
        v.z += (Math.random() - 0.5) * spread * 4;
        s.velocity.copy(v);
        s.life = 0.4 + Math.random() * 0.3;
        s.maxLife = s.life;
        s.active = true;
        s.mesh.visible = true;
      }
    }

    // === Brief blood mist — sparse, slow particles for atmosphere. ===
    if (cfg.mistParticleCount > 0) {
      for (let i = 0; i < cfg.mistParticleCount; i++) {
        const s = this.acquireSpray();
        if (!s) break;
        s.mesh.position.copy(pos);
        s.mesh.scale.setScalar(0.15 + Math.random() * 0.1);
        (s.mesh.material as THREE.SpriteMaterial).color.setHex(0xaa3030);
        (s.mesh.material as THREE.SpriteMaterial).opacity = 0.3;
        const v = new THREE.Vector3(
          (Math.random() - 0.5) * 1.5,
          0.5 + Math.random() * 0.5,
          (Math.random() - 0.5) * 1.5,
        );
        s.velocity.copy(v);
        s.life = 0.5 + Math.random() * 0.3;
        s.maxLife = s.life;
        s.active = true;
        s.mesh.visible = true;
      }
    }
  }

  /** Per-frame update — grows pools + advances spray particles.
   *  E1-5000 #2326/#2327 — decals now FADE OUT (the prior code only grew
   *  them + left them forever, so a long match covered every surface in
   *  permanent blood). Pools fade after their growth phase; surface decals
   *  fade on a fixed timer. */
  update(dt: number): void {
    // Decals — grow if "full" level pool, then fade out.
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      if (!d.active) continue;
      d.life -= dt;
      if (d.life <= 0) {
        // E1-5000 #2326/#2327 — fade-out phase: lerp opacity to 0 over
        // decalFadeDuration, then recycle.
        const fadeT = THREE.MathUtils.clamp(-d.life / this.decalFadeDuration, 0, 1);
        const mat = d.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = (1 - fadeT) * 0.85;
        if (fadeT >= 1) {
          d.active = false;
          d.mesh.visible = false;
          continue;
        }
      } else if (d.growing) {
        const t = 1 - d.life / d.maxLife; // 0 → 1
        const sc = THREE.MathUtils.lerp(d.startScale, d.endScale, t);
        d.mesh.scale.setScalar(sc);
      }
    }
    // Sprays — gravity + fade.
    for (let i = this.sprays.length - 1; i >= 0; i--) {
      const s = this.sprays[i];
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      s.velocity.y -= 14 * dt;
      s.mesh.position.addScaledVector(s.velocity, dt);
      const t = s.life / s.maxLife;
      (s.mesh.material as THREE.SpriteMaterial).opacity = t * 0.9;
    }
  }

  private acquireDecal(): BloodDecal | null {
    // LRU recycle — oldest inactive first, else create.
    for (const d of this.decals) {
      if (!d.active) return d;
    }
    const cfg = GORE_CONFIGS[this.level];
    if (this.decals.length >= cfg.maxDecals && this.decals.length > 0) {
      // Recycle the oldest decal (front of the list).
      return this.decals[0];
    }
    if (!this.scene) return null;
    const mat = new THREE.MeshBasicMaterial({
      map: getBloodDecalTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const mesh = new THREE.Mesh(this.decalGeo, mat);
    mesh.visible = false;
    // E1-5000 #2328 — Correct decal render-order layering. Pools (floor,
    // growing) render at renderOrder=1 (lowest — they sit on the ground);
    // surface decals (walls, non-growing) render at renderOrder=3 (higher —
    // they sit on top of pools at the wall/floor junction). The prior code
    // used renderOrder=1 for everything, causing wall decals to z-fight
    // with pools + occasionally render underneath them.
    mesh.renderOrder = 1; // default for pools; overridden for surface decals
    this.scene.add(mesh);
    const entry: BloodDecal = {
      mesh, life: 0, maxLife: 0, growing: false,
      startScale: 0, endScale: 0, active: false,
    };
    this.decals.push(entry);
    return entry;
  }

  private acquireSpray(): BloodSprayParticle | null {
    for (const s of this.sprays) {
      if (!s.active) return s;
    }
    // E1-5000 #2325 — Cap the spray pool. The prior code unboundedly
    // created new sprites → memory + draw-call leak on sustained fire.
    if (this.sprays.length >= this.maxSprays) return null;
    if (!this.scene) return null;
    const mat = new THREE.SpriteMaterial({
      color: 0x8a1a1a,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    this.scene.add(sprite);
    const entry: BloodSprayParticle = {
      mesh: sprite, velocity: new THREE.Vector3(),
      life: 0, maxLife: 0, active: false,
    };
    this.sprays.push(entry);
    return entry;
  }

  dispose(): void {
    if (!this.scene) return;
    // E1-5000 #2391 — Dispose decal + spray materials + geometries (the
    // prior code only removed meshes from the scene, leaking their GPU
    // resources across hot-reloads / scene teardowns).
    for (const d of this.decals) {
      this.scene.remove(d.mesh);
      (d.mesh.material as THREE.Material).dispose();
    }
    for (const s of this.sprays) {
      this.scene.remove(s.mesh);
      (s.mesh.material as THREE.Material).dispose();
    }
    this.decalGeo.dispose();
    this.decals = [];
    this.sprays = [];
    this.scene = null;
  }
}

/** Singleton accessor. */
let _instance: GoreSystem | null = null;
export function getGoreSystem(scene?: THREE.Scene): GoreSystem {
  if (!_instance) {
    _instance = new GoreSystem({ scene: scene ?? null });
  } else if (scene) {
    _instance.attach(scene);
  }
  return _instance;
}

/** Free-function convenience API — calls into the singleton. */
export function spawnBloodDecal(pos: THREE.Vector3, dir: THREE.Vector3, scene?: THREE.Scene): void {
  getGoreSystem(scene).spawnBloodDecal(pos, dir);
}
export function setGoreLevel(level: GoreLevel): void {
  getGoreSystem().setGoreLevel(level);
}
