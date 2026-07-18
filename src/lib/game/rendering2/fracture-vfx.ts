/**
 * SEC3-RENDER Prompt 26 — Destruction debris + dust VFX.
 *
 * Each fracture event spawns:
 *   1. A dust puff (a soft expanding sprite that fades to grey over ~0.8s).
 *   2. N debris chunks — small box meshes with physics (gravity + bounce +
 *      angular velocity) that scatter outward from the impact point.
 *   3. A lingering screen-space dust haze that the host can attach to the
 *      PostProcessing composer as a ShaderPass — a per-frame "haze intensity"
 *      uniform that the fracture VFX system bumps up on each fracture event
 *      and decays smoothly over ~2s.
 *
 * The chunk + dust pools are owned by this module — no dependency on
 * VoronoiFracture (which produces shard geometry). The host calls
 * `spawnDebris(pos, count)` from the destruction physics event; this
 * module handles the visual layer.
 *
 * Quality gating:
 *   - high/ultra: full stack (dust + debris + haze pass)
 *   - medium:     dust + debris (no haze pass)
 *   - low:        debris only (cheapest)
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export type FractureVfxQuality = "low" | "medium" | "high";

export interface FractureVfxOptions {
  quality?: FractureVfxQuality;
  scene?: THREE.Scene | null;
  maxDebris?: number;
  maxDust?: number;
}

interface DebrisEntry {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  angular: THREE.Vector3;
  life: number;
  maxLife: number;
  active: boolean;
  settled: boolean;
}

interface DustEntry {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  active: boolean;
}

/** Dust haze shader — soft brownish-tan tint that fades in/out. */
export const DustHazeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uIntensity: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uIntensity;
    uniform float uTime;
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      if (uIntensity > 0.001) {
        // A3-5000-retry / 493: 3-octave FBM dust noise (was single-octave hash —
        // looked like TV static, not realistic drifting dust). 3 octaves give
        // soft, cloud-like density variation.
        vec2 p = vUv * 200.0 + uTime * 4.0;
        float n = 0.0;
        float a = 0.5;
        float w = 0.0;
        for (int i = 0; i < 3; i++) {
          n += a * hash21(floor(p));
          w += a;
          p *= 2.13;
          a *= 0.5;
        }
        n /= w;
        // Center-weighted (more dust in the middle of the screen).
        vec2 c = vUv - 0.5;
        float center = 1.0 - smoothstep(0.0, 0.6, length(c));
        float haze = uIntensity * center * (0.4 + 0.6 * n);
        // Tan/brown tint for concrete dust; mixes toward warm grey.
        col.rgb = mix(col.rgb, vec3(0.7, 0.62, 0.52), haze * 0.5);
        col.rgb += haze * 0.05;
      }
      gl_FragColor = col;
    }
  `,
};

/** Shared dust sprite texture — radial gradient, soft grey. */
let _dustTex: THREE.Texture | null = null;
function getDustTexture(): THREE.Texture {
  if (_dustTex) return _dustTex;
  const size = 64;
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) {
    // SSR fallback.
    const data = new Uint8Array([180, 170, 150, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    _dustTex = tex;
    return tex;
  }
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(180, 170, 150, 0.85)");
  grad.addColorStop(0.5, "rgba(150, 140, 120, 0.4)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  _dustTex = tex;
  return tex;
}

/** Shared debris geometries — A3-5000-retry / 494: was a single BoxGeometry
 *  (all chunks identical). Now a small pool of 4 shape variants so chunks
 *  have visual variation. The system picks one at random per debris spawn.
 *  All 4 are disposed in the module-level `disposeFractureVfxGeometries()`
 *  (called by the engine teardown / context-loss path). */
const _debrisGeos: THREE.BoxGeometry[] = [
  new THREE.BoxGeometry(0.12, 0.1, 0.14),
  new THREE.BoxGeometry(0.1, 0.14, 0.08),  // flatter slab
  new THREE.BoxGeometry(0.14, 0.08, 0.12),  // wider slab
  new THREE.BoxGeometry(0.09, 0.11, 0.16),  // long shard
];
function randomDebrisGeo(): THREE.BoxGeometry {
  return _debrisGeos[Math.floor(Math.random() * _debrisGeos.length)];
}

/** A3-5000-retry / 430: dispose the shared debris geometries + the dust
 *  texture. Called by the engine teardown / context-loss path. Without this,
 *  the module-level singletons leak GPU memory across context-loss rebuilds. */
export function disposeFractureVfxGeometries(): void {
  for (const g of _debrisGeos) g.dispose();
  if (_dustTex) { _dustTex.dispose(); _dustTex = null; }
}

/** Fracture VFX system — owns dust + debris pools + the haze pass. */
export class FractureVfxSystem {
  private scene: THREE.Scene | null;
  private quality: FractureVfxQuality;
  private debrisPool: DebrisEntry[] = [];
  private dustPool: DustEntry[] = [];
  private maxDebris: number;
  private maxDust: number;
  /** The haze pass — only constructed on high quality. */
  public hazePass: ShaderPass | null = null;
  private hazeIntensity = 0;
  private elapsed = 0;

  constructor(opts: FractureVfxOptions = {}) {
    this.scene = opts.scene ?? null;
    this.quality = opts.quality ?? "high";
    this.maxDebris = opts.maxDebris ?? 256;
    this.maxDust = opts.maxDust ?? 32;
    if (this.quality === "high") {
      this.hazePass = new ShaderPass(DustHazeShader);
    }
  }

  attach(scene: THREE.Scene): void {
    this.scene = scene;
  }

  /** Spawn a single dust puff at `pos` (expands + fades over ~0.8s). */
  spawnDustCloud(pos: THREE.Vector3, opts?: {
    color?: number; scale?: number; velocity?: THREE.Vector3;
  }): void {
    if (!this.scene || this.quality === "low") return;
    const color = opts?.color ?? 0xaaaaaa;
    const scale = opts?.scale ?? 1.0;
    const entry = this.acquireDust();
    if (!entry) return;
    entry.sprite.position.copy(pos);
    entry.sprite.scale.setScalar(0.4 * scale);
    const mat = entry.sprite.material as THREE.SpriteMaterial;
    mat.color.setHex(color);
    mat.opacity = 0.7;
    entry.velocity.copy(opts?.velocity ?? new THREE.Vector3(0, 1.2, 0));
    entry.life = 0.8;
    entry.maxLife = 0.8;
    entry.active = true;
    entry.sprite.visible = true;
  }

  /** Spawn N debris chunks from `pos` — small boxes that scatter with
   *  physics (gravity + ground bounce + spin). */
  spawnDebris(pos: THREE.Vector3, count: number, opts?: {
    color?: number; force?: number;
  }): void {
    if (!this.scene) return;
    const color = opts?.color ?? 0x665544;
    const force = opts?.force ?? 4;
    for (let i = 0; i < count; i++) {
      const entry = this.acquireDebris();
      if (!entry) break;
      entry.mesh.position.copy(pos);
      const sc = 0.5 + Math.random() * 1.0;
      entry.mesh.scale.set(sc, sc, sc);
      entry.mesh.rotation.set(
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
      );
      (entry.mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
      // Random outward velocity.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5;
      const speed = force * (0.6 + Math.random() * 0.8);
      entry.velocity.set(
        Math.cos(theta) * Math.cos(phi) * speed,
        Math.sin(phi) * speed + force * 0.4,
        Math.sin(theta) * Math.cos(phi) * speed,
      );
      entry.angular.set(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
      );
      entry.life = 3 + Math.random() * 2;
      entry.maxLife = entry.life;
      entry.active = true;
      entry.settled = false;
      entry.mesh.visible = true;
    }
    // Bump the haze intensity — capped at 1.0.
    if (this.hazePass) {
      this.hazeIntensity = Math.min(1, this.hazeIntensity + 0.15 * Math.sqrt(count));
    }
  }

  /** Combined helper — spawn dust + debris + bump haze in one call. */
  spawnFractureVfx(pos: THREE.Vector3, opts?: {
    debrisCount?: number; color?: number; force?: number;
  }): void {
    const count = opts?.debrisCount ?? 12;
    this.spawnDebris(pos, count, opts);
    this.spawnDustCloud(pos, { color: opts?.color, scale: 1.2 });
  }

  /** Optional terrain-height sampler — A3-5000-retry / 432: lets debris rest
   *  on the actual terrain instead of the hardcoded y=0.05 floor. Without this,
   *  hilly maps show debris bouncing in mid-air or sinking into slopes. */
  private _terrainSampler: ((x: number, z: number) => number) | null = null;
  /** A3-5000-retry / 432: register a terrain-height sampler. */
  setTerrainSampler(sampler: ((x: number, z: number) => number) | null): void {
    this._terrainSampler = sampler;
  }

  /** Per-frame update — advances dust + debris + haze decay. */
  update(dt: number): void {
    this.elapsed += dt;
    // Dust puffs — expand + fade + drift upward.
    for (let i = this.dustPool.length - 1; i >= 0; i--) {
      const d = this.dustPool[i];
      if (!d.active) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.active = false;
        d.sprite.visible = false;
        continue;
      }
      const t = d.life / d.maxLife; // 1 → 0
      // Expand (1 → 3x).
      const sc = 0.4 * (1 + (1 - t) * 2);
      d.sprite.scale.set(sc, sc, 1);
      // Drift up + slight horizontal noise.
      d.sprite.position.addScaledVector(d.velocity, dt);
      d.velocity.multiplyScalar(0.92); // drag
      (d.sprite.material as THREE.SpriteMaterial).opacity = t * 0.7;
    }
    // Debris — gravity + bounce + spin + fade.
    for (let i = this.debrisPool.length - 1; i >= 0; i--) {
      const d = this.debrisPool[i];
      if (!d.active) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.active = false;
        d.mesh.visible = false;
        continue;
      }
      if (!d.settled) {
        d.velocity.y -= 14 * dt;
        d.mesh.position.addScaledVector(d.velocity, dt);
        d.mesh.rotation.x += d.angular.x * dt;
        d.mesh.rotation.y += d.angular.y * dt;
        d.mesh.rotation.z += d.angular.z * dt;
        // A3-5000-retry / 432: query the terrain height (was hardcoded y=0.05 —
        // debris bounced in mid-air on hilly maps or sank into slopes).
        const groundY = this._terrainSampler
          ? this._terrainSampler(d.mesh.position.x, d.mesh.position.z) + 0.05
          : 0.05;
        // Ground bounce.
        if (d.mesh.position.y < groundY) {
          d.mesh.position.y = groundY;
          if (Math.abs(d.velocity.y) > 0.5) {
            d.velocity.y = -d.velocity.y * 0.4;
            d.velocity.x *= 0.6;
            d.velocity.z *= 0.6;
            d.angular.multiplyScalar(0.5);
          } else {
            d.settled = true;
            d.velocity.set(0, 0, 0);
            d.angular.multiplyScalar(0.3);
          }
        }
      } else {
        d.angular.multiplyScalar(1 - Math.min(1, dt * 3));
      }
      // A3-5000-retry / 431: fade WITHOUT toggling transparent mid-frame.
      // `transparent` is set ONCE at creation (acquireDebris). Only `opacity`
      // changes — no shader recompile hitch.
      if (d.life < 0.5) {
        const mat = d.mesh.material as THREE.MeshStandardMaterial;
        mat.opacity = d.life / 0.5;
      } else {
        // Reset opacity to 1 when not fading (in case the entry is reused).
        const mat = d.mesh.material as THREE.MeshStandardMaterial;
        if (mat.opacity < 1) mat.opacity = 1;
      }
    }
    // Haze decay — exponential back to 0 over ~2s.
    if (this.hazePass && this.hazeIntensity > 0) {
      this.hazeIntensity = Math.max(0, this.hazeIntensity - dt * 0.5);
      (this.hazePass.material.uniforms.uIntensity.value as number) = this.hazeIntensity;
      (this.hazePass.material.uniforms.uTime.value as number) = this.elapsed;
    }
  }

  private acquireDebris(): DebrisEntry | null {
    for (const d of this.debrisPool) {
      if (!d.active) return d;
    }
    if (this.debrisPool.length >= this.maxDebris || !this.scene) return null;
    // A3-5000-retry / 431: set transparent=true ONCE at creation (was toggled
    // mid-frame in update() — forced a shader recompile hitch every fade).
    // A3-5000-retry / 494: pick a random geometry variant for shape variation.
    const mat = new THREE.MeshStandardMaterial({ color: 0x665544, roughness: 0.9, transparent: true, opacity: 1 });
    const mesh = new THREE.Mesh(randomDebrisGeo(), mat);
    mesh.castShadow = true;
    mesh.visible = false;
    this.scene.add(mesh);
    const entry: DebrisEntry = {
      mesh, velocity: new THREE.Vector3(),
      angular: new THREE.Vector3(), life: 0, maxLife: 0,
      active: false, settled: false,
    };
    this.debrisPool.push(entry);
    return entry;
  }

  private acquireDust(): DustEntry | null {
    for (const d of this.dustPool) {
      if (!d.active) return d;
    }
    if (this.dustPool.length >= this.maxDust || !this.scene) return null;
    const mat = new THREE.SpriteMaterial({
      map: getDustTexture(),
      color: 0xaaaaaa,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    this.scene.add(sprite);
    const entry: DustEntry = {
      sprite, velocity: new THREE.Vector3(),
      life: 0, maxLife: 0, active: false,
    };
    this.dustPool.push(entry);
    return entry;
  }

  dispose(): void {
    if (!this.scene) return;
    // A3-5000-retry / 466: dispose per-debris geometries + materials (was
    // only removing meshes from the scene — geometries + materials leaked).
    // Note: the geometries are SHARED (4 variants in _debrisGeos), so we
    // dedupe via a Set before disposing.
    const seenGeo = new Set<THREE.BufferGeometry>();
    for (const d of this.debrisPool) {
      this.scene.remove(d.mesh);
      if (!seenGeo.has(d.mesh.geometry)) {
        d.mesh.geometry?.dispose?.();
        seenGeo.add(d.mesh.geometry);
      }
      (d.mesh.material as THREE.Material).dispose();
    }
    for (const d of this.dustPool) {
      this.scene.remove(d.sprite);
      // Dust sprite materials are per-entry (created in acquireDust). Dispose.
      (d.sprite.material as THREE.Material).dispose();
    }
    this.hazePass?.dispose();
    this.debrisPool = [];
    this.dustPool = [];
    this.scene = null;
  }
}

/** Singleton accessor. */
let _instance: FractureVfxSystem | null = null;
export function getFractureVfxSystem(scene?: THREE.Scene): FractureVfxSystem {
  if (!_instance) {
    _instance = new FractureVfxSystem({ scene: scene ?? null });
  } else if (scene) {
    _instance.attach(scene);
  }
  return _instance;
}

/** Free-function convenience API. */
export function spawnDustCloud(pos: THREE.Vector3, scene?: THREE.Scene): void {
  getFractureVfxSystem(scene).spawnDustCloud(pos);
}
export function spawnDebris(pos: THREE.Vector3, count: number, scene?: THREE.Scene): void {
  getFractureVfxSystem(scene).spawnDebris(pos, count);
}
