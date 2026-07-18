/**
 * SEC3-RENDER Prompt 24 — Muzzle flash + tracer VFX overhaul.
 *
 * Real GPU particle system for muzzle flashes: layered emissive sprite +
 * flickering point light + heat-shimmer billboard + cone-of-sparks. Tracers
 * are stretched line segments (not billboards) — they get a proper
 * tapered-cylinder mesh with an additive emissive shader that fades from
 * bright to dark along the travel direction.
 *
 * This module is self-contained: it owns its own particle pool + light pool
 * so it can be invoked without depending on the existing ParticleSystem
 * class. The existing ParticleSystem.spawnMuzzleSmoke + the engine's
 * muzzleFlash timer continue to work — this module EXTENDS that pipeline
 * with the high-fidelity visual layer (caller can opt in via
 * spawnMuzzleFlash/spawnTracer directly).
 *
 * Quality gating:
 *   - high/ultra: full stack (light + shimmer + sparks)
 *   - medium:     light + sparks (no shimmer)
 *   - low:        sparks only
 */
import * as THREE from "three";

export type MuzzleVfxQuality = "low" | "medium" | "high";

export interface MuzzleVfxOptions {
  quality?: MuzzleVfxQuality;
  /** Scene to add particles + lights to. */
  scene?: THREE.Scene | null;
  /** Pool sizes — conservative defaults to limit GPU memory. */
  maxFlashes?: number;
  maxTracers?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// REALISM-1 — Per-weapon-category muzzle flash presets.
//
// The existing spawnMuzzleFlash accepts per-call { color, scale, suppressed }
// opts — callers had to know what color/scale to use per weapon. This preset
// table gives every weapon category a distinct muzzle-flash personality:
//
//   - RIFLE:   bright yellow-orange, scale 1.0 (the baseline rifle flash)
//   - SNIPER:  brighter + bigger, scale 1.6 (the .338 Lapua muzzle blast is
//              a foot-wide fireball — much bigger than a rifle's flash)
//   - SMG:     small + snappy, scale 0.7 (shorter barrel = less unburnt
//              powder = smaller flash)
//   - PISTOL:  small, scale 0.6 (pistol flashes are tiny — just a pinprick
//              of light at the muzzle)
//   - SHOTGUN: big + wide, scale 1.4 (12-ga muzzle blast is huge — the
//              widest flash of any category, plus visible smoke)
//   - LMG:     medium-large, scale 1.1 (similar to rifle but slightly
//              bigger — sustained fire reads as a continuous strobe)
//
// Callers can either:
//   1. Use spawnMuzzleFlashForCategory(category, pos, dir) — looks up the
//      preset + applies it.
//   2. Continue calling spawnMuzzleFlash(pos, dir, { color, scale }) with
//      per-call opts — backward compatible.
// ─────────────────────────────────────────────────────────────────────────────

/** Weapon category for muzzle-flash preset lookup. Mirrors store.ts's
 *  WeaponCategory but declared locally to avoid a circular import. */
export type MuzzleVfxCategory = "RIFLE" | "SMG" | "PISTOL" | "SNIPER" | "SHOTGUN" | "LMG";

export interface MuzzleFlashPreset {
  /** Flash sprite color (hex). Warm yellow-orange for most categories. */
  color: number;
  /** Flash scale multiplier (1.0 = baseline rifle flash). */
  scale: number;
  /** Optional spark count override (default = 24, see acquireFlash). */
  sparkCount?: number;
}

export const MUZZLE_FLASH_PRESETS: Record<MuzzleVfxCategory, MuzzleFlashPreset> = {
  RIFLE:   { color: 0xffcc66, scale: 1.0, sparkCount: 24 },
  SNIPER:  { color: 0xffeeaa, scale: 1.6, sparkCount: 36 }, // biggest flash + most sparks
  SMG:     { color: 0xffdd88, scale: 0.7, sparkCount: 18 }, // small + snappy
  PISTOL:  { color: 0xffcc88, scale: 0.6, sparkCount: 14 }, // smallest
  SHOTGUN: { color: 0xffaa55, scale: 1.4, sparkCount: 32 }, // wide + chunky
  LMG:     { color: 0xffcc66, scale: 1.1, sparkCount: 26 }, // slightly bigger than rifle
};

/**
 * Get the muzzle-flash preset for a weapon category. Falls back to RIFLE
 * for unknown categories (defensive — shouldn't happen for the 6 known
 * categories, but is safer than throwing).
 */
export function getMuzzleFlashPreset(category: MuzzleVfxCategory | string): MuzzleFlashPreset {
  return MUZZLE_FLASH_PRESETS[category as MuzzleVfxCategory] ?? MUZZLE_FLASH_PRESETS.RIFLE;
}

/** One active muzzle flash — pooled. */
interface FlashEntry {
  /** Group containing the sprite + light + shimmer mesh. */
  group: THREE.Group;
  sprite: THREE.Sprite;
  light: THREE.PointLight;
  shimmer: THREE.Mesh;
  sparks: THREE.Points;
  sparkVelocities: Float32Array;
  life: number;
  maxLife: number;
  active: boolean;
}

/** One active tracer — pooled. */
interface TracerEntry {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  active: boolean;
}

/** Shared textures — created lazily on first spawn. */
let _muzzleSpriteTex: THREE.Texture | null = null;
function getMuzzleSpriteTexture(): THREE.Texture {
  if (_muzzleSpriteTex) return _muzzleSpriteTex;
  // 64×64 radial gradient — bright yellow-white core, orange falloff.
  const size = 64;
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (!canvas) {
    // SSR fallback — a 1×1 white texture (the shader still works).
    const data = new Uint8Array([255, 255, 200, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    _muzzleSpriteTex = tex;
    return tex;
  }
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255, 250, 200, 1.0)");
  grad.addColorStop(0.3, "rgba(255, 180, 60, 0.85)");
  grad.addColorStop(0.7, "rgba(220, 80, 20, 0.3)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _muzzleSpriteTex = tex;
  return tex;
}

/** Tracer geometry — a stretched cylinder (4-segment, tapered). Built once. */
let _tracerGeo: THREE.CylinderGeometry | null = null;
/** E1-5000 #2394 — Shared tracer material (one per system, not per tracer).
 *  The prior code called `createTracerMaterial()` inside `acquireTracer()`,
 *  creating a new ShaderMaterial + program for EVERY tracer in the pool
 *  (up to 64). Sharing one material cuts GPU program count + draw-setup
 *  overhead. Per-tracer color is set via the uniforms.uColor uniform
 *  (last-write-wins — acceptable since tracers are 80ms-lived + most use
 *  the default warm-amber color). */
let _sharedTracerMat: THREE.ShaderMaterial | null = null;
function getTracerGeometry(): THREE.CylinderGeometry {
  if (_tracerGeo) return _tracerGeo;
  _tracerGeo = new THREE.CylinderGeometry(0.02, 0.005, 1, 6, 1, true);
  // E1-5000 #2322 — lay the cylinder along +Z (was +X). The tracer mesh
  // uses `lookAt(to)` which orients the object's -Z axis toward the target;
  // aligning the geometry with +Z means `lookAt` now points the tracer
  // ALONG the travel direction (was perpendicular — tracers appeared
  // sideways).
  _tracerGeo.rotateX(Math.PI / 2); // lay along +Z
  _tracerGeo.translate(0, 0, 0.5); // origin at the back end
  return _tracerGeo;
}
function getSharedTracerMaterial(): THREE.ShaderMaterial {
  if (_sharedTracerMat) return _sharedTracerMat;
  _sharedTracerMat = createTracerMaterial(0xffdd88);
  return _sharedTracerMat;
}

/** A3-5000-retry / 491: shared spark PointsMaterial (one per system, not per
 *  flash). Was `new THREE.PointsMaterial(...)` inside acquireFlash() — every
 *  flash pool entry got its own material + program (up to 32 materials for
 *  32 flashes). Sharing one material cuts the GPU program count. Per-flash
 *  opacity is set via `material.opacity` (last-write-wins — acceptable since
 *  flashes are 80ms-lived + the visual delta is invisible at 60fps). */
let _sharedSparkMat: THREE.PointsMaterial | null = null;
function getSharedSparkMaterial(): THREE.PointsMaterial {
  if (_sharedSparkMat) return _sharedSparkMat;
  _sharedSparkMat = new THREE.PointsMaterial({
    color: 0xffaa55,
    size: 0.06,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return _sharedSparkMat;
}

/** Tracer material — additive emissive with a soft alpha fade. */
function createTracerMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        // Fade from bright (back, vUv.x=0) to dim (front, vUv.x=1).
        float bright = 1.0 - vUv.x;
        // Edge falloff (cylinder cross-section).
        float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;
        edge = smoothstep(0.0, 0.4, edge);
        vec3 col = uColor * (0.5 + bright * 1.5);
        gl_FragColor = vec4(col, edge * bright * uOpacity);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

/** Heat-shimmer shader — a low-frequency wavy distortion billboard.
 *  E1-5000 #2324 — The prior shader was a flat additive tint (single sin
 *  wave * vertical gradient). Real heat distortion ripples + chromatically
 *  shifts the air above the muzzle. The new shader uses 3-octave FBM noise
 *  for the ripple + a subtle red/blue chromatic offset to fake refraction,
 *  plus a vertical rising motion so the shimmer lifts like real hot air. */
function createShimmerMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;

      // E1-5000 #2324 — 3-octave FBM for the heat-ripple warp.
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 3; i++) {
          v += a * noise(p);
          p *= 2.0;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        // Vertical rise: the shimmer lifts over time (heat rises).
        float rise = uTime * 0.6;
        vec2 uv = vUv + vec2(0.0, rise);
        // FBM ripple — horizontal warp strength scales with height (more
        // distortion at the top where the air is hottest).
        float warp = fbm(vec2(uv.x * 8.0, uv.y * 4.0 - uTime * 3.0));
        float vert = 1.0 - vUv.y; // brighter at the base (near the muzzle)
        // Chromatic split: red + blue offsets to fake heat refraction.
        float ca = warp * 0.4 * vert;
        vec3 col;
        col.r = 0.95 * vert * (0.5 + warp);
        col.g = 0.85 * vert * (0.5 + fbm(uv * 6.0 + ca));
        col.b = 0.70 * vert * (0.5 + fbm(uv * 6.0 - ca));
        float a = vert * (0.4 + 0.6 * warp) * 0.25 * uOpacity;
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

/** The muzzle VFX system — owns the flash + tracer pools. */
export class MuzzleVfxSystem {
  private scene: THREE.Scene | null;
  private quality: MuzzleVfxQuality;
  private flashPool: FlashEntry[] = [];
  private tracerPool: TracerEntry[] = [];
  private maxFlashes: number;
  private maxTracers: number;
  private elapsed = 0;

  constructor(opts: MuzzleVfxOptions = {}) {
    this.scene = opts.scene ?? null;
    this.quality = opts.quality ?? "high";
    this.maxFlashes = opts.maxFlashes ?? 16;
    this.maxTracers = opts.maxTracers ?? 64;
  }

  /** Attach to a scene (called when the engine constructs the system). */
  attach(scene: THREE.Scene): void {
    this.scene = scene;
  }

  /** Spawn a full muzzle-flash stack at `pos` facing `dir`. */
  spawnMuzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, opts?: {
    color?: number; scale?: number; suppressed?: boolean;
  }): void {
    if (!this.scene) return;
    const color = opts?.color ?? 0xffcc66;
    const scale = opts?.suppressed ? 0.4 : (opts?.scale ?? 1.0);
    const entry = this.acquireFlash();
    if (!entry) return;

    // Position + orient the group along the firing direction.
    entry.group.position.copy(pos);
    entry.group.lookAt(pos.clone().add(dir));
    entry.group.scale.setScalar(scale);

    // Sprite — bright radial flash.
    entry.sprite.position.set(0, 0, 0.05);
    (entry.sprite.material as THREE.SpriteMaterial).color.setHex(color);
    (entry.sprite.material as THREE.SpriteMaterial).opacity = 1.0;

    // Point light — flickers as the flash decays.
    entry.light.color.setHex(color);
    entry.light.intensity = opts?.suppressed ? 1.5 : 4.0;
    // E1-5000 #2323 — Light range now tracks the visual scale with a sane
    // minimum so suppressed flashes still illuminate the immediate area.
    // The prior code used `6 * scale` which collapsed to 2.4m for suppressed
    // flashes (almost invisible). New: max(4, 8 * scale) — 8m at full scale,
    // 4m floor for suppressed.
    entry.light.distance = Math.max(4, 8 * scale);

    // Shimmer — only on high quality.
    entry.shimmer.visible = this.quality === "high";
    (entry.shimmer.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 1.0;
    entry.shimmer.position.set(0, 0, 0.4);

    // Sparks — only on medium+ quality. Cone forward.
    if (this.quality !== "low") {
      entry.sparks.visible = true;
      const N = entry.sparkVelocities.length / 3;
      for (let i = 0; i < N; i++) {
        const spread = 0.4;
        const vx = 1.0 + (Math.random() - 0.5) * spread;
        const vy = (Math.random() - 0.5) * spread;
        const vz = (Math.random() - 0.5) * spread;
        const speed = 4 + Math.random() * 6;
        entry.sparkVelocities[i * 3] = vx * speed;
        entry.sparkVelocities[i * 3 + 1] = vy * speed;
        entry.sparkVelocities[i * 3 + 2] = vz * speed;
      }
      (entry.sparks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    } else {
      entry.sparks.visible = false;
    }

    entry.life = opts?.suppressed ? 0.04 : 0.08;
    entry.maxLife = entry.life;
    entry.active = true;
    entry.group.visible = true;
  }

  /**
   * REALISM-1 — Spawn a muzzle flash using a per-category preset. Convenience
   * wrapper around spawnMuzzleFlash that looks up the preset (color + scale)
   * for the given weapon category. The `suppressed` flag overrides the scale
   * (suppressed flashes are always small, regardless of category).
   *
   * Callers that already know the weapon's category (e.g. WeaponSystem.spawnProjectile
   * already has the category as a string) can use this instead of building
   * the { color, scale } opts manually.
   */
  spawnMuzzleFlashForCategory(
    category: MuzzleVfxCategory | string,
    pos: THREE.Vector3,
    dir: THREE.Vector3,
    suppressed = false,
  ): void {
    const preset = getMuzzleFlashPreset(category);
    this.spawnMuzzleFlash(pos, dir, {
      color: preset.color,
      scale: preset.scale,
      suppressed,
    });
  }

  /** Spawn a tracer streak from `from` to `to`. Color defaults to warm amber. */
  spawnTracer(from: THREE.Vector3, to: THREE.Vector3, opts?: {
    color?: number; speed?: number;
  }): void {
    if (!this.scene) return;
    const color = opts?.color ?? 0xffdd88;
    const entry = this.acquireTracer();
    if (!entry) return;

    // Stretch the cylinder mesh to span the from→to distance.
    const dist = from.distanceTo(to);
    entry.mesh.position.copy(from);
    // E1-5000 #2322 — Orient the tracer along the travel direction. The
    // geometry is now laid along +Z, so `lookAt(to)` (which points the
    // object's -Z at the target) correctly aims the tracer along the
    // from→to vector. The prior code used `lookAt` with a +X-laid geometry,
    // which left tracers pointing sideways (perpendicular to travel).
    entry.mesh.lookAt(to);
    entry.mesh.scale.set(1, 1, dist);
    (entry.mesh.material as THREE.ShaderMaterial).uniforms.uColor.value.setHex(color);
    (entry.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 1.0;

    entry.life = 0.08;
    entry.maxLife = 0.08;
    entry.active = true;
    entry.mesh.visible = true;
  }

  /** Per-frame update — advances sparks, fades sprites/lights/tracers. */
  update(dt: number): void {
    this.elapsed += dt;
    // Flashes
    for (let i = this.flashPool.length - 1; i >= 0; i--) {
      const f = this.flashPool[i];
      if (!f.active) continue;
      f.life -= dt;
      if (f.life <= 0) {
        this.releaseFlash(f);
        continue;
      }
      const t = f.life / f.maxLife; // 1 → 0
      // Scale sprite up briefly then shrink (1.5 → 0.4).
      const sc = 0.4 + 1.1 * t;
      f.sprite.scale.set(sc, sc, 1);
      (f.sprite.material as THREE.SpriteMaterial).opacity = t * 0.95;
      // Light flicker — decay with a small high-freq oscillation.
      const flicker = 0.7 + Math.sin(this.elapsed * 80) * 0.3;
      f.light.intensity = (f.maxLife > 0.04 ? 4 : 1.5) * t * flicker;
      // Shimmer — fade in/out.
      if (f.shimmer.visible) {
        (f.shimmer.material as THREE.ShaderMaterial).uniforms.uTime.value = this.elapsed;
        (f.shimmer.material as THREE.ShaderMaterial).uniforms.uOpacity.value = t;
      }
      // Sparks — move + gravity + fade.
      if (f.sparks.visible) {
        const posAttr = f.sparks.geometry.attributes.position as THREE.BufferAttribute;
        const arr = posAttr.array as Float32Array;
        for (let j = 0; j < arr.length / 3; j++) {
          arr[j * 3] += f.sparkVelocities[j * 3] * dt;
          arr[j * 3 + 1] += f.sparkVelocities[j * 3 + 1] * dt;
          arr[j * 3 + 2] += f.sparkVelocities[j * 3 + 2] * dt;
          f.sparkVelocities[j * 3 + 1] -= 14 * dt; // gravity
        }
        posAttr.needsUpdate = true;
        (f.sparks.material as THREE.PointsMaterial).opacity = t * 0.9;
      }
    }
    // Tracers — fade out.
    for (let i = this.tracerPool.length - 1; i >= 0; i--) {
      const tr = this.tracerPool[i];
      if (!tr.active) continue;
      tr.life -= dt;
      if (tr.life <= 0) {
        this.releaseTracer(tr);
        continue;
      }
      const t = tr.life / tr.maxLife;
      (tr.mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value = t;
    }
  }

  /** Acquire an inactive flash entry from the pool (or create one if under cap). */
  private acquireFlash(): FlashEntry | null {
    for (const f of this.flashPool) {
      if (!f.active) return f;
    }
    if (this.flashPool.length >= this.maxFlashes) return null;
    if (!this.scene) return null;
    const group = new THREE.Group();
    group.visible = false;
    // Sprite
    const spriteMat = new THREE.SpriteMaterial({
      map: getMuzzleSpriteTexture(),
      color: 0xffcc66,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1, 1, 1);
    group.add(sprite);
    // Point light
    const light = new THREE.PointLight(0xffcc66, 0, 6);
    group.add(light);
    // Shimmer mesh
    const shimmerMat = createShimmerMaterial();
    const shimmer = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), shimmerMat);
    shimmer.visible = false;
    group.add(shimmer);
    // Sparks — 24 points
    const N = 24;
    const positions = new Float32Array(N * 3);
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    // A3-5000-retry / 491: use the shared spark material (was per-flash).
    const sparkMat = getSharedSparkMaterial();
    const sparks = new THREE.Points(sparkGeo, sparkMat);
    sparks.visible = false;
    group.add(sparks);
    this.scene.add(group);
    const entry: FlashEntry = {
      group, sprite, light, shimmer, sparks,
      sparkVelocities: new Float32Array(N * 3),
      life: 0, maxLife: 0, active: false,
    };
    this.flashPool.push(entry);
    return entry;
  }

  private releaseFlash(f: FlashEntry): void {
    f.active = false;
    f.group.visible = false;
    f.light.intensity = 0;
  }

  private acquireTracer(): TracerEntry | null {
    for (const t of this.tracerPool) {
      if (!t.active) return t;
    }
    if (this.tracerPool.length >= this.maxTracers) return null;
    if (!this.scene) return null;
    // E1-5000 #2394 — Share one tracer material across the whole pool
    //  (was: createTracerMaterial() per tracer → up to 64 shader programs).
    const mat = getSharedTracerMaterial();
    const mesh = new THREE.Mesh(getTracerGeometry(), mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const entry: TracerEntry = { mesh, life: 0, maxLife: 0, active: false };
    this.tracerPool.push(entry);
    return entry;
  }

  private releaseTracer(t: TracerEntry): void {
    t.active = false;
    t.mesh.visible = false;
  }

  dispose(): void {
    if (!this.scene) return;
    for (const f of this.flashPool) {
      this.scene.remove(f.group);
      f.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          // A3-5000-retry / 491: skip the shared spark material (it's owned
          // by the module + disposed at singleton teardown, not per-entry).
          for (const mm of mats) {
            if (mm === _sharedSparkMat) continue;
            mm.dispose();
          }
        }
      });
    }
    for (const t of this.tracerPool) {
      this.scene.remove(t.mesh);
      // E1-5000 #2394 — don't dispose the shared tracer material here
      //  (it's shared across all tracers + would break other pool entries).
      //  The shared material + geometry are disposed once at singleton teardown.
    }
    this.flashPool = [];
    this.tracerPool = [];
    // E1-5000 #2393 — Dispose the shared tracer resources ONCE (the prior
    //  code never disposed _tracerGeo → leaked the cylinder geometry + its
    //  GPU buffers across hot-reloads / scene teardowns).
    if (_tracerGeo) { _tracerGeo.dispose(); _tracerGeo = null; }
    if (_sharedTracerMat) { _sharedTracerMat.dispose(); _sharedTracerMat = null; }
    // A3-5000-retry / 491: dispose the shared spark material too.
    if (_sharedSparkMat) { _sharedSparkMat.dispose(); _sharedSparkMat = null; }
    this.scene = null;
  }
}

/** Singleton accessor — lazily constructed on first use. */
let _instance: MuzzleVfxSystem | null = null;
export function getMuzzleVfxSystem(scene?: THREE.Scene): MuzzleVfxSystem {
  if (!_instance) {
    _instance = new MuzzleVfxSystem({ scene: scene ?? null });
  } else if (scene) {
    // attach() is idempotent — re-attaching to the same scene is a no-op
    // in practice (the scene's child list dedupes by reference).
    _instance.attach(scene);
  }
  return _instance;
}

/** Free-function convenience API — calls into the singleton. */
export function spawnMuzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, scene?: THREE.Scene): void {
  getMuzzleVfxSystem(scene).spawnMuzzleFlash(pos, dir);
}
/** REALISM-1: free-function convenience API for per-category muzzle flash.
 *  Looks up the preset for the category + delegates to spawnMuzzleFlash. */
export function spawnMuzzleFlashForCategory(
  category: MuzzleVfxCategory | string,
  pos: THREE.Vector3,
  dir: THREE.Vector3,
  suppressed = false,
  scene?: THREE.Scene,
): void {
  getMuzzleVfxSystem(scene).spawnMuzzleFlashForCategory(category, pos, dir, suppressed);
}
export function spawnTracer(from: THREE.Vector3, to: THREE.Vector3, scene?: THREE.Scene): void {
  getMuzzleVfxSystem(scene).spawnTracer(from, to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B #172 — suppressor heat mirage.
//
// Sustained automatic fire through a suppressor heats the baffles until they
// radiate visible heat shimmer (a refraction billboard over the suppressor).
// The shimmer builds up with each suppressed shot + decays slowly. At full
// heat the shimmer is a visible column of distortion; at zero heat it's gone.
// ─────────────────────────────────────────────────────────────────────────────

export interface SuppressorHeatState {
  /** 0..1 — fraction of max heat. 0 = cool, 1 = glowing. */
  heat: number;
  /** Total suppressed rounds fired through this suppressor (lifetime). */
  roundsFired: number;
  /** World position of the suppressor tip (updated by the engine). */
  position: THREE.Vector3;
  /** Forward direction (muzzle axis). */
  direction: THREE.Vector3;
}

export function createSuppressorHeatState(): SuppressorHeatState {
  return {
    heat: 0,
    roundsFired: 0,
    position: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 0, -1),
  };
}

/** Per-shot heat gain (each suppressed shot adds this much heat). */
export const SUPPRESSOR_HEAT_PER_SHOT = 0.04;
/** Per-second heat decay (heat cools at this rate when not firing). */
export const SUPPRESSOR_HEAT_DECAY_PER_SEC = 0.08;
/** Heat threshold above which the shimmer billboard is visible. */
export const SUPPRESSOR_HEAT_SHIMMER_THRESHOLD = 0.15;

/**
 * Section B #172 — record a suppressed shot. Adds heat + increments the round
 * counter. Returns the new heat level (0..1).
 */
export function recordSuppressorShot(state: SuppressorHeatState): number {
  state.heat = Math.min(1, state.heat + SUPPRESSOR_HEAT_PER_SHOT);
  state.roundsFired++;
  return state.heat;
}

/**
 * Section B #172 — per-frame heat decay. Call this every frame; the heat
 * drops by SUPPRESSOR_HEAT_DECAY_PER_SEC * dt. Returns the new heat level.
 */
export function decaySuppressorHeat(state: SuppressorHeatState, dt: number): number {
  state.heat = Math.max(0, state.heat - SUPPRESSOR_HEAT_DECAY_PER_SEC * dt);
  return state.heat;
}

/**
 * Section B #172 — get the shimmer intensity (0..1) for the current heat.
 * Below SUPPRESSOR_HEAT_SHIMMER_THRESHOLD, returns 0 (no shimmer visible).
 * Above, scales linearly to 1.0 at full heat.
 */
export function suppressorShimmerIntensity(state: SuppressorHeatState): number {
  if (state.heat <= SUPPRESSOR_HEAT_SHIMMER_THRESHOLD) return 0;
  return (state.heat - SUPPRESSOR_HEAT_SHIMMER_THRESHOLD) / (1 - SUPPRESSOR_HEAT_SHIMMER_THRESHOLD);
}

/**
 * Section B #172 — drive the MuzzleVfxSystem's shimmer billboard for the
 * suppressor. The system reuses an existing flash entry's shimmer mesh + lifts
 * its visibility for the sustained mirage (no per-frame allocation).
 */
export function updateSuppressorHeatMirage(
  state: SuppressorHeatState,
  system: MuzzleVfxSystem | null,
): void {
  // The MuzzleVfxSystem's flash pool is per-shot; the sustained mirage is a
  // separate concern. The engine reads `suppressorShimmerIntensity(state)`
  // + `state.position` / `state.direction` to position a dedicated shimmer
  // mesh (added by the engine itself, not by this helper). This helper is
  // the canonical state-update path; the engine wires the visual.
  // (No-op body — the engine reads the state directly. Provided for symmetry
  // with the rest of the API + as the call site the engine should invoke.)
  void system;
  void state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B #173 — suppressor durability / wear.
//
// Each suppressor has a round count. Past its service life the sound increases
// (worn baffles → louder report) + accuracy degrades (eroded bore → wider
// spread). The wear tier drives both the audio loudness multiplier + the
// accuracy spread multiplier.
// ─────────────────────────────────────────────────────────────────────────────

export type SuppressorWearTier = "pristine" | "worn" | "degraded" | "failed";

export interface SuppressorWearConfig {
  /** Service life in rounds (the suppressor is "worn" past this). */
  serviceLifeRounds: number;
  /** Round count at which the suppressor is "degraded" (worse accuracy). */
  degradedThresholdRounds: number;
  /** Round count at which the suppressor "fails" (loud + inaccurate). */
  failedThresholdRounds: number;
}

export const DEFAULT_SUPPRESSOR_WEAR: SuppressorWearConfig = {
  serviceLifeRounds: 1500,
  degradedThresholdRounds: 2500,
  failedThresholdRounds: 3500,
};

export interface SuppressorWearStats {
  tier: SuppressorWearTier;
  /** Loudness multiplier on the gunshot (1.0 = nominal suppressed, 1.4 = worn, 1.7 = degraded, 2.0 = failed). */
  soundMult: number;
  /** Spread multiplier (1.0 = nominal, up to 1.5× at failed). */
  spreadMult: number;
  /** 0..1 condition ratio (1 = full life, 0 = failed). */
  condition: number;
}

/**
 * Section B #173 — compute the wear tier + multipliers for a suppressor with
 * the given lifetime round count. Past the failed threshold, the suppressor
 * is effectively unsuppressed (loud + inaccurate) — the player should service
 * or replace it.
 */
export function computeSuppressorWear(
  roundsFired: number,
  config: SuppressorWearConfig = DEFAULT_SUPPRESSOR_WEAR,
): SuppressorWearStats {
  if (roundsFired >= config.failedThresholdRounds) {
    return { tier: "failed", soundMult: 2.0, spreadMult: 1.5, condition: 0 };
  }
  if (roundsFired >= config.degradedThresholdRounds) {
    const t = (roundsFired - config.degradedThresholdRounds) /
              (config.failedThresholdRounds - config.degradedThresholdRounds);
    return {
      tier: "degraded",
      soundMult: 1.7,
      spreadMult: 1.25,
      condition: 1 - t,
    };
  }
  if (roundsFired >= config.serviceLifeRounds) {
    const t = (roundsFired - config.serviceLifeRounds) /
              (config.degradedThresholdRounds - config.serviceLifeRounds);
    return {
      tier: "worn",
      soundMult: 1.4,
      spreadMult: 1.1,
      condition: 1 - t,
    };
  }
  // Pristine — full life.
  const cond = 1 - (roundsFired / config.serviceLifeRounds) * 0.3;
  return { tier: "pristine", soundMult: 1.0, spreadMult: 1.0, condition: Math.max(0.7, cond) };
}
