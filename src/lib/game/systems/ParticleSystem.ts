// ============================================================================
//  ParticleSystem.ts  —  re-export aggregator + class (Task 3 / item 53)
//  The original 2,320-line module was split into per-concern sub-modules
//  under ./ParticleSystem/. This file imports from them and keeps the
//  ParticleSystem class definition (TS doesn't support partial classes,
//  so the class itself stays here — the texture factories, constants, and
//  pooled-type interfaces were the part that benefited from extraction).
//
//  Sub-modules:
//    _shared.ts  — imports, common pool sizing, pooled-type interfaces
//    decals.ts   — bullet-hole / scorch / blood textures + decal cap constants
//    tracers.ts  — TRACER_COLORS + SurfaceVfx map + cached particle texture
//    debris.ts   — ExplosionKind + debris pool sizing
//    weather.ts  — ambient particle (muzzle smoke / ground dust) helpers
// ============================================================================

// Re-export so external imports of named symbols (`DECAL_CAP`,
// `TRACER_COLORS`, `ExplosionKind`, `PooledShell`, ...) still resolve.
export * from "./ParticleSystem/_shared";
export * from "./ParticleSystem/decals";
export * from "./ParticleSystem/tracers";
export * from "./ParticleSystem/debris";
export * from "./ParticleSystem/weather";
// Section E (650–656) — soft particles, GPU instancing, sub-emitters,
// collision, tracer trails, blood pooling, scorch fade.
export * from "./ParticleSystem/section-e";

import * as THREE from "three";
import type { GameSystem, GameContext, Enemy } from "./types";
import type { HudState } from "../store";
import { particleTexture, smokeTexture, bulletHoleTexture } from "../textures";
import { ObjectPool, type PooledParticle, type PooledTracer } from "./ObjectPool";
import type { WeaponType } from "../store";
import { isNight } from "../realism";

// Per-concern imports (constants + texture factories + pooled types).
import {
  SHELL_POOL_SIZE,
  FLASH_POOL_SIZE,
  SHOCKWAVE_POOL_SIZE,
  EXPLOSION_LIGHT_POOL_SIZE,
  SCOPE_GLINT_POOL_SIZE,
  SCOPE_GLINT_LIFETIME,
  type PooledShell,
  type PooledFlash,
  type PooledExplosionLight,
  type PooledShockwave,
  type PooledExplosionDebris,
  type PooledBloodDrip,
  type PooledBloodPool,
  type PooledScopeGlint,
} from "./ParticleSystem/_shared";
import {
  DECAL_CAP,
  DECAL_LIFETIME,
  DECAL_FADE_WINDOW,
  BLOOD_DECAL_CAP,
  BLOOD_DECAL_LIFETIME,
  BLOOD_DECAL_FADE_WINDOW,
  BLOOD_POOL_CAP,
  BLOOD_POOL_MESH_POOL_SIZE,
  BLOOD_DRIP_POOL_SIZE,
  BLOOD_SPLATTER_POOL_SIZE,
  getBulletHoleTexture,
  scorchTexture,
  getScorchTexture,
  bloodSplatterTexture,
  getBloodSplatterTexture,
  bloodPoolTexture,
  getBloodPoolTexture,
  bloodDripTexture,
  getBloodDripTexture,
} from "./ParticleSystem/decals";
import {
  TRACER_COLORS,
  cachedParticleTexture,
  type SurfaceVfx,
  SURFACE_VFX,
} from "./ParticleSystem/tracers";
import {
  EXPLOSION_DEBRIS_POOL_SIZE,
  type ExplosionKind,
} from "./ParticleSystem/debris";

export class ParticleSystem implements GameSystem {
  /** Dedicated shell casing pool — capped at SHELL_POOL_SIZE. */
  private shellPool: ObjectPool<THREE.Mesh>;
  private activeShells: PooledShell[] = [];

  /** Task-25: explosion element pools — flash sphere, shockwave ring,
   *  point light, debris chunk. All pre-allocated; spawnExplosion activates
   *  dormant instances + tracks them in the active arrays for the update loop. */
  private flashPool: ObjectPool<THREE.Mesh>;
  private shockwavePool: ObjectPool<THREE.Mesh>;
  private explosionLightPool: ObjectPool<THREE.PointLight>;
  private explosionDebrisPool: ObjectPool<THREE.Mesh>;
  private activeFlashes: PooledFlash[] = [];
  private activeShockwaves: PooledShockwave[] = [];
  private activeExplosionLights: PooledExplosionLight[] = [];
  private activeExplosionDebris: PooledExplosionDebris[] = [];

  /** Task-32: blood splatter decal pool (separate from bullet-hole decals).
   *  CircleGeometry(0.5,16) meshes with the procedural splatter texture. */
  private bloodDecalPool: ObjectPool<THREE.Mesh>;
  /** Task-32: blood drip streak pool (wall drips). Thin PlaneGeometry with
   *  origin translated to the top center so scale.y growth extends downward. */
  private bloodDripPool: ObjectPool<THREE.Mesh>;
  /** Task-32: blood pool mesh pool (main + satellites, under corpses).
   *  Flat CircleGeometry(0.4,32) discs lying on the ground. */
  private bloodPoolMeshPool: ObjectPool<THREE.Mesh>;
  /** Task-32: active blood splatter decals (lifetime-tracked, 25s). */
  private bloodDecals: THREE.Mesh[] = [];
  /** Task-32: active blood drip streaks (growth + fade tracked). */
  private activeBloodDrips: PooledBloodDrip[] = [];
  /** Task-32: active blood pools (growth + persistence tracked). */
  private activeBloodPools: PooledBloodPool[] = [];

  /** REALISM-1 (task B): scope glint sprite pool — small (4 concurrent),
   *  pre-allocated Sprites with additive blending + warm-white texture. */
  private scopeGlintPool: ObjectPool<THREE.Sprite>;
  private activeScopeGlints: PooledScopeGlint[] = [];

  /** Reusable temp vectors — avoid per-frame allocation. */
  private _tmpA = new THREE.Vector3();
  private _tmpB = new THREE.Vector3();
  private _tmpC = new THREE.Vector3();
  private _tmpD = new THREE.Vector3();
  private _tmpColor = new THREE.Color();

  constructor(private ctx: GameContext) {
    this.shellPool = new ObjectPool<THREE.Mesh>(SHELL_POOL_SIZE, () => {
      // Brass cylinder — material is recolored per-eject by weapon type.
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.06, 6),
        new THREE.MeshStandardMaterial({ color: 0xb8862a, metalness: 0.85, roughness: 0.35 }),
      );
      m.castShadow = true;
      m.visible = false;
      ctx.scene.add(m);
      return m;
    });

    // Task-25: explosion flash sphere — bright emissive yellow-white.
    this.flashPool = new ObjectPool<THREE.Mesh>(FLASH_POOL_SIZE, () => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({
          color: 0xffeeaa,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        }),
      );
      m.visible = false;
      ctx.scene.add(m);
      return m;
    });

    // Task-25: shockwave ring — flat ring that expands on the ground.
    this.shockwavePool = new ObjectPool<THREE.Mesh>(SHOCKWAVE_POOL_SIZE, () => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.7, 1.0, 32),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        }),
      );
      m.visible = false;
      ctx.scene.add(m);
      return m;
    });

    // Task-25: explosion point light — bright orange flash that decays.
    this.explosionLightPool = new ObjectPool<THREE.PointLight>(EXPLOSION_LIGHT_POOL_SIZE, () => {
      const l = new THREE.PointLight(0xffaa44, 0, 15, 2);
      l.visible = false;
      ctx.scene.add(l);
      return l;
    });

    // Task-25: explosion debris chunk — small dark box with gravity + bounce.
    this.explosionDebrisPool = new ObjectPool<THREE.Mesh>(EXPLOSION_DEBRIS_POOL_SIZE, () => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95, metalness: 0.05 }),
      );
      m.castShadow = true;
      m.visible = false;
      ctx.scene.add(m);
      return m;
    });

    // Task-32: blood splatter decal pool — flat circle with procedural
    // splatter texture. Oriented to surface normals. Capped at 150.
    this.bloodDecalPool = new ObjectPool<THREE.Mesh>(BLOOD_SPLATTER_POOL_SIZE, () => {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(0.5, 16),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          side: THREE.DoubleSide,
        }),
      );
      m.visible = false;
      ctx.scene.add(m);
      return m;
    });

    // Task-32: blood drip streak pool — thin elongated plane with the drip
    // texture. Geometry origin is translated to the top center (-0.2 on Y)
    // so scaling Y extends the streak downward from its anchor point.
    this.bloodDripPool = new ObjectPool<THREE.Mesh>(BLOOD_DRIP_POOL_SIZE, () => {
      const geo = new THREE.PlaneGeometry(0.06, 0.4);
      geo.translate(0, -0.2, 0); // origin at top center
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          side: THREE.DoubleSide,
        }),
      );
      m.visible = false;
      ctx.scene.add(m);
      return m;
    });

    // Task-32: blood pool mesh pool — flat disc with pool texture. Used for
    // both main pools and satellite pools. CircleGeometry(0.4, 32) for smooth
    // edges. Pre-rotated to lie flat on the ground (rotation.x = -π/2).
    this.bloodPoolMeshPool = new ObjectPool<THREE.Mesh>(BLOOD_POOL_MESH_POOL_SIZE, () => {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(0.4, 32),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          side: THREE.DoubleSide,
        }),
      );
      m.rotation.x = -Math.PI / 2; // lie flat on ground
      m.visible = false;
      ctx.scene.add(m);
      return m;
    });

    // Task-25: expose this ParticleSystem on ctx so WeaponSystem + GrenadeSystem
    // can call spawnExplosion + spawnDebris via the (ctx as unknown as { particles? })
    // cast pattern. The cast pattern is already used in engine.ts +
    // GrenadeSystem.ts; without this assignment it silently no-ops at runtime.
    // We assign the unwrapped instance — the FrameBudgetProfiler only wraps
    // update(), so spawn methods are unaffected.
    (ctx as unknown as { particles?: ParticleSystem }).particles = this;

    // REALISM-1 (task B): scope glint sprite pool — 4 warm-white additive
    // billboards. Small pool (rare event — at most a handful of snipers are
    // scoped in on the player at once). Texture is a soft radial gradient
    // that reads as a bright pinpoint from any angle (Sprites always face
    // the camera, so the glint automatically billboards).
    this.scopeGlintPool = new ObjectPool<THREE.Sprite>(SCOPE_GLINT_POOL_SIZE, () => {
      const tex = cachedParticleTexture("rgb(255,245,204)"); // 0xfff5cc warm white
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: 0xfff5cc,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true, // glint is occluded by geometry between the sniper + the camera
      });
      const s = new THREE.Sprite(mat);
      s.scale.setScalar(0.18); // ~18 cm — reads as a lens pinpoint at engagement range
      s.visible = false;
      s.frustumCulled = false; // glint is tiny — never cull it
      ctx.scene.add(s);
      return s;
    });
  }

  // ============================================================
  // TRACERS — bright elongated streaks, color-coded per weapon.
  // ============================================================

  /**
   * Spawn a tracer from `from` to `to`. Optional `colorHex` overrides the
   * default warm tracer color (used for weapon-coded + enemy-red tracers).
   */
  spawnTracer(from: THREE.Vector3, to: THREE.Vector3, colorHex?: number) {
    const { ctx } = this;
    const line = ctx.particlePool.acquireTracer(from, to);
    if (!line) return; // pool exhausted — drop tracer silently
    const entry: PooledTracer = { line, life: 0.08, maxLife: 0.08, active: true };
    ctx.particlePool.activeTracers.push(entry);
    const mat = line.material as THREE.LineBasicMaterial;
    mat.color.setHex(colorHex ?? 0xffdd88);
    // Task-9 (Prompt #84) — Day/night affects tracer visibility. At night,
    // tracers are 1.5× brighter so the player can read incoming fire against
    // the dark sky (the spec's "multiply tracer opacity by 1.5"). Clamped to
    // 1.0 because LineBasicMaterial.opacity is in [0,1] — a daytime 0.95
    // tracer becomes a capped 1.0 at night (already maxed), while a dimmed
    // tracer (e.g. suppressed 0.4) becomes 0.6 → visibly brighter.
    const nightBoost = isNight(ctx.weather.timeOfDay) ? 1.5 : 1.0;
    mat.opacity = Math.min(1.0, 0.95 * nightBoost);
  }

  // ============================================================
  // REALISM-1 (task B) — SNIPER SCOPE GLINT.
  // Spawns a warm-white additive billboard at the sniper's position that
  // flickers on a sin-wave for ~1.5s. Mimics the sun catching the ocular
  // lens of a scoped rifle — gives the player a counter-play tell against
  // scoped enemies.
  //
  // The sprite is a THREE.Sprite so it always faces the camera (billboards
  // automatically). Additive blending makes it read as a bright pinpoint
  // against any backdrop. depthTest=true keeps it occluded by geometry
  // between the sniper + the camera (the glint vanishes when the sniper
  // ducks behind cover — the sun can't catch a lens it can't see).
  //
  // TODO: wire from EnemySystem — call ctx.particles.spawnScopeGlint(sniperPos, aimDir)
  //       when a sniper enemy enters the "scoped in on player" state. The
  //       orchestrator can wire this without touching EnemySystem directly
  //       (e.g. by exposing a hook on the enemy cognition state).
  // ============================================================

  /**
   * Spawn a sniper scope glint at `origin` (the sniper's eye position),
   * facing `direction` (the sniper's aim direction — ignored for the visual
   * since Sprites billboard, but kept on the signature for future
   * angle-dependent intensity tuning + caller symmetry with spawnTracer).
   */
  spawnScopeGlint(origin: THREE.Vector3, direction: THREE.Vector3): void {
    const sprite = this.scopeGlintPool.acquire();
    if (!sprite) return; // pool exhausted — drop silently (rare event, so OK)
    // Position the glint slightly above + ahead of the sniper's eye so it
    // reads as coming from the scope ocular, not the eye itself.
    sprite.position.copy(origin).addScaledVector(direction, 0.15);
    sprite.position.y += 0.05;
    const mat = sprite.material as THREE.SpriteMaterial;
    mat.color.setHex(0xfff5cc); // warm white — matches the spec
    mat.opacity = 1.0;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    mat.depthTest = true;
    sprite.scale.setScalar(0.18 + Math.random() * 0.04); // slight size variance
    sprite.visible = true;
    this.activeScopeGlints.push({
      sprite,
      life: SCOPE_GLINT_LIFETIME,
      maxLife: SCOPE_GLINT_LIFETIME,
      phase: Math.random() * Math.PI * 2,          // random phase so glints don't sync
      flickerFreq: 10 + Math.random() * 6,         // 10–16 Hz — sun-catch shimmer
      active: true,
    });
  }

  // ============================================================
  // A3-5000-retry / 435 — TAPERED RIBBON TRACER.
  // The legacy `spawnTracer` uses LineBasicMaterial (1px wireframe — no
  // thickness, no per-vertex color, no taper). This method spawns a tapered
  // cylinder mesh (similar to MuzzleVfxSystem.spawnTracer) for callers that
  // want a more realistic tracer. The legacy line tracer is retained for
  // backward compat + low-quality fallback.
  // ============================================================

  /** Cached tapered-cylinder geometry for ribbon tracers. */
  private _ribbonTracerGeo: THREE.CylinderGeometry | null = null;
  /** Cached shared material for ribbon tracers (per-instance color via uniform). */
  private _ribbonTracerMat: THREE.ShaderMaterial | null = null;

  /** A3-5000-retry / 435: spawn a tapered ribbon tracer (cylinder mesh) from
   *  `from` to `to`. Visually thicker than the line tracer + tapered at the
   *  far end. Falls back to `spawnTracer` (line) if the cylinder can't be
   *  created (e.g. SSR / pool exhausted). */
  spawnTracerRibbon(from: THREE.Vector3, to: THREE.Vector3, colorHex?: number): void {
    const { ctx } = this;
    // Lazily build the shared geometry + material.
    if (!this._ribbonTracerGeo) {
      this._ribbonTracerGeo = new THREE.CylinderGeometry(0.015, 0.003, 1, 6, 1, true);
      this._ribbonTracerGeo.rotateX(Math.PI / 2);
      this._ribbonTracerGeo.translate(0, 0, 0.5);
    }
    if (!this._ribbonTracerMat) {
      this._ribbonTracerMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xffdd88) },
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
            // Taper alpha toward the back (uv.y=0) so the tracer fades into nothing.
            float taper = smoothstep(0.0, 0.3, vUv.y);
            gl_FragColor = vec4(uColor, uOpacity * taper);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
    }
    // Acquire a mesh from the pool (use the debris mesh pool — it's Mesh-shaped).
    const mesh = ctx.particlePool.acquireMesh(new THREE.Color(colorHex ?? 0xffdd88));
    if (!mesh) {
      // Fallback to the line tracer.
      this.spawnTracer(from, to, colorHex);
      return;
    }
    // Swap the mesh's material to the ribbon tracer material.
    mesh.material = this._ribbonTracerMat;
    // Position + orient the cylinder from `from` to `to`.
    mesh.position.copy(from);
    mesh.lookAt(to);
    const len = from.distanceTo(to);
    mesh.scale.set(1, 1, len);
    mesh.visible = true;
    ctx.particlePool.activeParticles.push({
      mesh, velocity: new THREE.Vector3(), life: 0.08, maxLife: 0.08,
      gravity: false, fade: true, active: true,
    });
  }

  // ============================================================
  // A3-5000-retry / 436 — SCOPE GLINT WIRING FROM ENEMY SYSTEM.
  // The spawnScopeGlint method existed but was never called from gameplay
  // (the comment was a TODO). This helper lets the EnemySystem / AI director
  // trigger a glint for a sniper enemy that's "scoped in on player". The
  // actual wire is in EnemySystem's scoped-state transition; this method
  // is the canonical entry point so the wire is a one-liner.
  // ============================================================

  /** A3-5000-retry / 436: trigger a scope glint for a sniper enemy. Called
   *  by EnemySystem when a sniper enters the "scoped in on player" state.
   *  `enemyEyePos` is the sniper's eye world position; `aimDir` is the
   *  normalized direction from the sniper to the player. The glint is
   *  dropped silently if the pool is exhausted (rare). */
  triggerScopeGlintForSniper(enemyEyePos: THREE.Vector3, aimDir: THREE.Vector3): void {
    // The glint is only visible when the sniper is roughly facing the camera
    // (the sun catches the ocular lens from the player's POV). Cheap dot test.
    const { ctx } = this;
    if (ctx.camera) {
      const camDir = new THREE.Vector3();
      ctx.camera.getWorldDirection(camDir);
      // If the sniper's aim is roughly toward the camera, the ocular lens
      // faces the camera → glint visible. Use a wide cone (dot > -0.5).
      if (aimDir.dot(camDir.negate()) < -0.5) return;
    }
    this.spawnScopeGlint(enemyEyePos, aimDir);
  }

  // ============================================================
  // BULLET IMPACTS — sparks + debris + smoke + decal (per surface).
  // ============================================================

  /** Legacy entrypoint — delegates to spawnBulletImpact with concrete. */
  spawnImpact(point: THREE.Vector3, normal: THREE.Vector3) {
    this.spawnBulletImpact(point, normal, "concrete");
  }

  /**
   * Spawn a full bullet-impact VFX stack on a surface:
   *   - 4-16 bright yellow-orange sparks (more for metal surfaces)
   *   - 4-10 colored debris particles (concrete dust, wood chips, metal flakes…)
   *   - 1 small expanding grey smoke puff that fades in ~0.5s
   *   - 1 surface-tinted bullet-hole decal (capped at 50, oldest recycled)
   *
   * `surfaceType` is the ballistics material slug (concrete/wood/sheet_metal/…).
   */
  spawnBulletImpact(point: THREE.Vector3, normal: THREE.Vector3, surfaceType?: string) {
    const { ctx } = this;
    const vfx = SURFACE_VFX[surfaceType ?? "concrete"] ?? SURFACE_VFX.concrete;
    const pool = ctx.particlePool;

    // === Sparks — bright yellow-orange additive particles, fly outward. ===
    const sparkTex = cachedParticleTexture(`rgb(${(vfx.sparkColor >> 16) & 0xff},${(vfx.sparkColor >> 8) & 0xff},${vfx.sparkColor & 0xff})`);
    for (let i = 0; i < vfx.sparkCount; i++) {
      const s = pool.acquireSprite(sparkTex, 0xffffff);
      if (!s) break;
      s.scale.setScalar(0.06 + Math.random() * 0.04);
      s.position.copy(point).add(normal.clone().multiplyScalar(0.02));
      // Velocity: outward cone along normal + random spread.
      const vel = normal.clone().multiplyScalar(3 + Math.random() * 3);
      vel.x += (Math.random() - 0.5) * 5;
      vel.y += (Math.random() - 0.5) * 5 + 1.5;
      vel.z += (Math.random() - 0.5) * 5;
      pool.activeParticles.push({
        mesh: s, velocity: vel, life: 0.25 + Math.random() * 0.15, maxLife: 0.4,
        gravity: true, fade: true, active: true,
      });
    }

    // === Debris — small dark chunks colored per surface. ===
    this._tmpColor.setHex(vfx.debrisColor);
    for (let i = 0; i < vfx.debrisCount; i++) {
      const m = pool.acquireMesh(this._tmpColor);
      if (!m) break;
      const sc = 0.5 + Math.random() * 0.6;
      m.scale.set(sc, sc, sc);
      m.position.copy(point).add(normal.clone().multiplyScalar(0.02));
      const vel = normal.clone().multiplyScalar(2 + Math.random() * 2);
      vel.x += (Math.random() - 0.5) * 4;
      vel.y += Math.random() * 3 + 1;
      vel.z += (Math.random() - 0.5) * 4;
      pool.activeParticles.push({
        mesh: m, velocity: vel, life: 0.8 + Math.random() * 0.4, maxLife: 1.2,
        gravity: true, fade: true, active: true,
      });
    }

    // === Smoke puff — small expanding grey sprite, fades in ~0.5s. ===
    const smoke = pool.acquireSprite(smokeTexture(), 0xffffff);
    if (smoke) {
      (smoke.material as THREE.SpriteMaterial).opacity = 0.55;
      smoke.scale.setScalar(vfx.smokeScale);
      smoke.position.copy(point).add(normal.clone().multiplyScalar(0.05));
      const vel = normal.clone().multiplyScalar(0.6).add(
        new THREE.Vector3((Math.random() - 0.5) * 0.4, Math.random() * 0.4 + 0.2, (Math.random() - 0.5) * 0.4),
      );
      pool.activeParticles.push({
        mesh: smoke, velocity: vel, life: 0.5, maxLife: 0.5,
        gravity: false, fade: true, active: true,
      });
    }

    // === Decal — surface-tinted bullet hole (capped at DECAL_CAP). ===
    // Task-25: terrain hits (normal mostly up + low hit-point Y) get a darker,
    // larger scorch-mark decal with a procedural radial-gradient texture.
    // Wall/prop hits keep the existing bullet-hole texture + surface color.
    const decal = pool.acquireDecal(point, normal);
    if (decal) {
      const mat = decal.material as THREE.MeshBasicMaterial;
      // Terrain detection: normal points up (flat ground) AND hit-point is
      // low (below 1.5m — excludes crate/barrel/container tops which are
      // typically 1m+). This catches the ground mesh (no userData.surfaceType
      // → defaults to "concrete") + any low-lying flat surfaces.
      const isTerrain = normal.y > 0.85 && point.y < 1.5;
      if (isTerrain) {
        mat.map = getScorchTexture();
        mat.color.setHex(0x1a1a1a);
        mat.opacity = 0.92;
        // Larger scale for terrain (0.08 base radius × 3.0-3.8 ≈ 0.24-0.30m
        // — a satisfying scorch mark, not a pinprick).
        const s = 3.0 + Math.random() * 0.8;
        decal.scale.set(s, s, s);
      } else {
        mat.map = getBulletHoleTexture();
        mat.color.setHex(vfx.decalColor);
        mat.opacity = 0.92;
        const s = vfx.decalScale + Math.random() * 0.6;
        decal.scale.set(s, s, s);
      }
      mat.transparent = true;
      mat.needsUpdate = true;
      decal.rotation.z = Math.random() * Math.PI * 2;
      // Task-25: track spawn time + base opacity for the 20s lifetime fade.
      decal.userData.spawnTime = performance.now();
      decal.userData.baseOpacity = mat.opacity;
      ctx.decals.push(decal);
      // Ring buffer: cap at DECAL_CAP, recycle oldest.
      while (ctx.decals.length > DECAL_CAP) {
        const old = ctx.decals.shift();
        if (!old) break;
        old.visible = false;
        (old.material as THREE.MeshBasicMaterial).opacity = 0;
        pool.decalPool.release(old);
      }
    }
  }

  /**
   * Prompt #35 — Penetration exit-hole decal.
   *
   * When a bullet penetrates a surface (drywall, wood, sheet metal, etc.),
   * spawn a small dark decal on the FAR side of the surface — the bullet's
   * exit hole. The decal sits at `exitPoint` (computed by the caller as
   * `hitPoint + bulletDir * penetrationDepth`) and is oriented to the
   * inverted surface normal so it lies flat against the far face.
   *
   * Visual: small (0.05–0.10 m radius — half the size of the entry bullet
   * hole) dark-charcoal decal with a faint surface tint. A tiny dust puff
   * spawns at the exit point too, reading as debris blowing out the far
   * side of the wall.
   *
   * Cap: shares the existing DECAL_CAP (100) ring buffer with entry-side
   * bullet-hole decals so the total decal population stays bounded.
   */
  spawnExitHole(
    exitPoint: THREE.Vector3,
    entryNormal: THREE.Vector3,
    surfaceType?: string,
  ) {
    const { ctx } = this;
    const pool = ctx.particlePool;
    // The far-face normal is the inverted entry normal — the decal sits on
    // the opposite side of the wall, facing away from the shooter.
    const exitNormal = this._tmpExitNormal.copy(entryNormal).multiplyScalar(-1);
    // Surface VFX (decalColor, debrisColor) — declared before the decal
    // block so the debris puff below can reuse it without re-looking-up.
    const vfx = SURFACE_VFX[surfaceType ?? "concrete"] ?? SURFACE_VFX.concrete;
    const decal = pool.acquireDecal(exitPoint, exitNormal);
    if (decal) {
      const mat = decal.material as THREE.MeshBasicMaterial;
      mat.map = getBulletHoleTexture();
      // Dark charcoal with a faint surface tint — exit holes read darker
      // than entry holes (no scorch ring, just the puncture mark).
      // Blend the surface's decalColor toward black (40%) so the exit hole
      // is recognisably darker than the entry-side decal on the same wall.
      const tintR = ((vfx.decalColor >> 16) & 0xff) * 0.4;
      const tintG = ((vfx.decalColor >> 8) & 0xff) * 0.4;
      const tintB = (vfx.decalColor & 0xff) * 0.4;
      mat.color.setRGB(tintR / 255, tintG / 255, tintB / 255);
      mat.opacity = 0.88;
      // Spec: 0.05–0.10 m radius. Base decal geometry is CircleGeometry(0.08,
      // 8) → 0.08 m radius at scale 1. Scale 0.8–1.25 → 0.064–0.100 m radius.
      const s = 0.8 + Math.random() * 0.45;
      decal.scale.set(s, s, s);
      mat.transparent = true;
      mat.depthWrite = false;
      mat.needsUpdate = true;
      decal.rotation.z = Math.random() * Math.PI * 2;
      // Track spawn time + base opacity for the 20s lifetime fade (same
      // mechanism as entry-side bullet holes — the engine's decal fade
      // pass treats them identically).
      decal.userData.spawnTime = performance.now();
      decal.userData.baseOpacity = mat.opacity;
      ctx.decals.push(decal);
      while (ctx.decals.length > DECAL_CAP) {
        const old = ctx.decals.shift();
        if (!old) break;
        old.visible = false;
        (old.material as THREE.MeshBasicMaterial).opacity = 0;
        pool.decalPool.release(old);
      }
    }

    // === Tiny debris puff on the exit side — reads as wall material
    // blowing out the far face. Reuses the same sprite/debris path as the
    // entry-side impact but with fewer + dimmer particles so the exit
    // reads as a subdued "puff" rather than a full impact. ===
    const debrisTex = cachedParticleTexture(
      `rgb(${(vfx.debrisColor >> 16) & 0xff},${(vfx.debrisColor >> 8) & 0xff},${vfx.debrisColor & 0xff})`,
    );
    for (let i = 0; i < 4; i++) {
      const s = pool.acquireSprite(debrisTex, 0xffffff);
      if (!s) break;
      s.scale.setScalar(0.04 + Math.random() * 0.03);
      s.position.copy(exitPoint).add(exitNormal.clone().multiplyScalar(0.02));
      // Velocity: outward cone along the exit normal + gravity.
      const vel = exitNormal.clone().multiplyScalar(1.2 + Math.random() * 1.5);
      vel.x += (Math.random() - 0.5) * 2.5;
      vel.y += (Math.random() - 0.5) * 2.5;
      vel.z += (Math.random() - 0.5) * 2.5;
      pool.activeParticles.push({
        mesh: s, velocity: vel, life: 0.35 + Math.random() * 0.2, maxLife: 0.55,
        gravity: true, fade: true, active: true,
      });
    }
  }

  /** Scratch vector for spawnExitHole's exit-normal computation (avoids
   *  per-call allocation on the hot penetration path). */
  private _tmpExitNormal = new THREE.Vector3();

  // ============================================================
  // BLOOD — Task-32 AAA layered spray (mist + droplets + chunks),
  // procedural splatter/pool/drip decals, growing corpse pools,
  // wall drips, and screen blood.
  // ============================================================

  /** Legacy entrypoint — non-directional upward spray. */
  spawnBlood(point: THREE.Vector3) {
    this.spawnBloodSpray(point, new THREE.Vector3(0, 1, 0), 10, false);
  }

  /**
   * Task-32/37: Spawn a directional AAA blood spray — three layered particle
   * systems that all fire in the bullet's travel direction (cone half-angle
   * 0.3 rad). Task-37 bumped every dimension (size, color, lifetime, count,
   * velocity) so blood is unambiguously visible in normal gameplay:
   *
   *   1. MIST — 15-20 large bright-red (0xff2020) additive particles (0.06m)
   *      that travel fast (10-15 m/s) + far, fading in 0.8s. The fine aerosol
   *      from a high-velocity hit. Additive blending acts as the emissive /
   *      glow component so the mist reads even in dark areas. Headshots
   *      double the count + use a finer 0.05m scale.
   *   2. DROPLETS — 25-35 medium bright-red (0xcc1818) particles (0.12m) that
   *      arc with gravity + bounce once on the ground (100% chance to leave a
   *      small splatter decal where they land — Task-37 bump from 15%).
   *      Lifetime 2.5s.
   *   3. CHUNKS — 8-12 large bright-red (0x8a1010) particles (0.20m) that
   *      fall fast (gravity 14 m/s², vs the default 12). Read as tissue
   *      debris. Lifetime 3.0s.
   *
   * Velocity scaling: bigger weapons (more damage) spawn proportionally more
   * blood — the `amount` parameter scales all three layer counts (amount=10
   * → 1×, amount=18 boss → 1.8×).
   *
   * Headshot multiplier: 2× all layer counts + finer mist (0.05m vs 0.06m).
   *
   * After the spray, a procedural blood splatter decal is placed behind the
   * target (oriented to the inverse bullet direction). On walls (horizontal
   * normal), 3-4 drip streaks spawn below the splatter and grow downward.
   *
   * Kill detection: if the closest enemy to the hit point has health ≤ 0
   * (already decremented by damageEnemy before this call) but is still alive
   * (killEnemy hasn't run yet), this is the kill shot — a growing blood pool
   * spawns under the enemy. The pool follows the ragdoll's chest during its
   * 3s growth, then persists.
   */
  spawnBloodSpray(point: THREE.Vector3, direction: THREE.Vector3, amount: number, headshot: boolean) {
    const { ctx } = this;
    const pool = ctx.particlePool;
    const dirN = direction.clone().normalize();

    // Task-32: velocity scaling — bigger weapons (more damage) = more blood.
    // amount=10 (normal hit) → 1×, amount=18 (boss) → 1.8×.
    const dmgMult = Math.max(0.5, amount / 10);
    // Task-32: headshot multiplier — 2× all counts + finer mist.
    const headMult = headshot ? 2 : 1;

    // Build a cone basis: dirN (forward), and two perpendicular axes.
    // All 3 layers spray in the bullet's travel direction (cone half-angle 0.3).
    const up = Math.abs(dirN.y) > 0.95 ? this._tmpA.set(1, 0, 0) : this._tmpA.set(0, 1, 0);
    const right = this._tmpB.crossVectors(dirN, up).normalize();
    const upCone = new THREE.Vector3().crossVectors(right, dirN).normalize();
    const CONE_HALF_ANGLE = 0.3; // radians

    // ─── Layer 1: MIST — large bright-red additive particles, fast + far. ───
    // Task-37: bumped size (0.04→0.06), count (8-12→15-20), speed (8-12→10-15),
    // lifetime (0.4→0.8s), color (0xc93030→0xff2020 brighter), opacity (0.9→1.0).
    // Additive blending is the emissive/glow component — it adds the particle
    // color to the framebuffer so the mist reads as glowing even in dark areas
    // (sprites don't support `emissive` directly, but additive blending on a
    // bright color achieves the same visual effect).
    // Task-41 — reduced count (15-20→8-12) for perf. Still visible (additive
    // blend on bright red reads at any count) but ~40% fewer particles per
    // blood event. Pool size unchanged (200 sprites pre-allocated).
    const mistCount = Math.floor((8 + Math.random() * 4) * dmgMult * headMult);
    const mistTex = cachedParticleTexture("rgb(255,32,32)"); // 0xff2020 brighter red
    const mistScale = headshot ? 0.05 : 0.06;
    for (let i = 0; i < mistCount; i++) {
      const s = pool.acquireSprite(mistTex, 0xffffff);
      if (!s) break;
      s.scale.setScalar(mistScale + Math.random() * 0.02);
      s.position.copy(point);
      // Uniform cone sampling within CONE_HALF_ANGLE.
      const cosA = Math.cos(CONE_HALF_ANGLE * Math.random());
      const sinA = Math.sin(CONE_HALF_ANGLE * Math.random());
      const azim = Math.random() * Math.PI * 2;
      const speed = 10 + Math.random() * 5; // fast: 10-15 m/s (Task-37 bump)
      const vel = new THREE.Vector3()
        .addScaledVector(dirN, speed * cosA)
        .addScaledVector(right, speed * sinA * Math.cos(azim))
        .addScaledVector(upCone, speed * sinA * Math.sin(azim));
      const mat = s.material as THREE.SpriteMaterial;
      mat.blending = THREE.AdditiveBlending; // bright additive mist (glow)
      mat.opacity = 1.0;
      mat.depthWrite = false;
      pool.activeParticles.push({
        mesh: s, velocity: vel,
        life: 0.6 + Math.random() * 0.2, maxLife: 0.8, // fade in 0.8s (Task-37)
        gravity: false, fade: true, active: true,
      });
    }

    // ─── Layer 2: DROPLETS — medium bright-red particles, arc + bounce once. ───
    // Task-37: bumped size (0.08→0.12), count (15-20→25-35), speed (4-7→7-11),
    // lifetime (1.5→2.5s), color (0x8a1a1a→0xcc1818 brighter).
    // Task-41 — reduced count (25-35→15-20) for perf. Still produces a clear
    // blood spray pattern (every droplet splatters on bounce per Task-37) but
    // ~40% fewer particles per event. Pool size unchanged.
    const dropletCount = Math.floor((15 + Math.random() * 5) * dmgMult * headMult);
    const dropletTex = cachedParticleTexture("rgb(204,24,24)"); // 0xcc1818 brighter red
    for (let i = 0; i < dropletCount; i++) {
      const s = pool.acquireSprite(dropletTex, 0xffffff);
      if (!s) break;
      s.scale.setScalar(0.12 + Math.random() * 0.03);
      s.position.copy(point);
      const cosA = Math.cos(CONE_HALF_ANGLE * Math.random());
      const sinA = Math.sin(CONE_HALF_ANGLE * Math.random());
      const azim = Math.random() * Math.PI * 2;
      const speed = 7 + Math.random() * 4; // medium: 7-11 m/s (Task-37 bump)
      const vel = new THREE.Vector3()
        .addScaledVector(dirN, speed * cosA)
        .addScaledVector(right, speed * sinA * Math.cos(azim))
        .addScaledVector(upCone, speed * sinA * Math.sin(azim));
      vel.y += 1.0; // slight upward bias for arc
      const mat = s.material as THREE.SpriteMaterial;
      mat.blending = THREE.NormalBlending;
      mat.opacity = 1;
      // Tag for bounce-once behavior + ground splatter chance (update loop).
      s.userData.bloodDroplet = true;
      s.userData.bounceCount = 0;
      pool.activeParticles.push({
        mesh: s, velocity: vel,
        life: 2.0 + Math.random() * 0.5, maxLife: 2.5, // 2.5s lifetime (Task-37)
        gravity: true, fade: true, active: true,
      });
    }

    // ─── Layer 3: CHUNKS — large bright-red particles, fall fast (gravity 14). ───
    // Task-37: bumped size (0.15→0.20), count (4-6→8-12), lifetime (1.0→3.0s),
    // color (0x4a0a0a→0x8a1010 brighter).
    // Task-41 — reduced count (8-12→4-6) for perf. Chunks are large +
    // long-lived so 4-6 still reads clearly as tissue debris.
    const chunkCount = Math.floor((4 + Math.random() * 2) * dmgMult * headMult);
    const chunkTex = cachedParticleTexture("rgb(138,16,16)"); // 0x8a1010 brighter red
    for (let i = 0; i < chunkCount; i++) {
      const s = pool.acquireSprite(chunkTex, 0xffffff);
      if (!s) break;
      s.scale.setScalar(0.20 + Math.random() * 0.05);
      s.position.copy(point);
      const cosA = Math.cos(CONE_HALF_ANGLE * Math.random());
      const sinA = Math.sin(CONE_HALF_ANGLE * Math.random());
      const azim = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 2; // slow forward: 2-4 m/s
      const vel = new THREE.Vector3()
        .addScaledVector(dirN, speed * cosA)
        .addScaledVector(right, speed * sinA * Math.cos(azim))
        .addScaledVector(upCone, speed * sinA * Math.sin(azim));
      vel.y += 0.5; // slight upward bias
      const mat = s.material as THREE.SpriteMaterial;
      mat.blending = THREE.NormalBlending;
      mat.opacity = 1;
      s.userData.customGravity = 14; // fall fast (gravity 14 vs default 12)
      pool.activeParticles.push({
        mesh: s, velocity: vel,
        life: 2.5 + Math.random() * 0.5, maxLife: 3.0, // 3.0s lifetime (Task-37)
        gravity: true, fade: true, active: true,
      });
    }

    // ─── Blood splatter decal behind the target (procedural texture). ───
    // Project a splatter decal slightly behind the hit point (opposite bullet
    // dir) so it reads as blood that exited the far side of the body. On
    // walls (horizontal normal), drip streaks spawn below the splatter.
    // Task-37: bumped scaleMult (1.4/2.0 → 3.5/4.5) so decals are nearly
    // double the previous size — bigger blood splatters read clearly at range.
    const decalPos = point.clone().add(dirN.clone().multiplyScalar(0.15));
    const decalNormal = dirN.clone().negate();
    this.spawnBloodSplatterDecal(decalPos, decalNormal, headshot ? 4.5 : 3.5);

    // ─── Kill detection — spawn a growing blood pool under the corpse. ───
    // damageEnemy decrements e.health BEFORE calling onSpawnBloodSpray, and
    // killEnemy runs AFTER. So if the closest enemy has health ≤ 0 but is
    // still alive, this is the kill shot — spawn a blood pool at the enemy's
    // ground position. The pool follows the ragdoll's chest during growth.
    //
    // Task-37 fix: the previous check used the full 3D distance from the
    // enemy's group origin (at the feet, y=0) to the hit point. A headshot
    // hit point sits ~1.6m above the feet, so the 3D distance was ~1.6m —
    // just above the 1.5m threshold, causing headshot kills to MISS the
    // blood-pool spawn. Switched to HORIZONTAL distance (XZ only) so the
    // hit height no longer disqualifies the kill, and bumped the threshold
    // to 2.0m to be safe against off-center hits on moving enemies.
    let killTarget: Enemy | null = null;
    let bestDist = 2.0; // max HORIZONTAL distance to consider (Task-37: 1.5 → 2.0)
    for (const en of ctx.enemies) {
      if (!en.alive) continue;
      if (en.health > 0) continue; // not dying from this hit
      // Task-37: horizontal distance only — ignores hit height so headshots
      // (hit point ~1.6m above the feet) still trigger the blood pool.
      const dx = en.group.position.x - point.x;
      const dz = en.group.position.z - point.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestDist) {
        bestDist = d;
        killTarget = en;
      }
    }
    if (killTarget) {
      const poolPos = killTarget.group.position.clone();
      poolPos.y = 0.02; // ground level
      this.spawnBloodPool(poolPos, killTarget);
    }
  }

  /**
   * Task-32/37: Spawn a blood splatter decal on a surface at `point` with
   * normal `normal`. Uses the procedural bloodSplatterTexture (radial
   * gradient + 12 droplet flecks). Oriented to the surface normal. On
   * vertical surfaces (walls, where |normal.y| < 0.3), also spawns 3-4 drip
   * streaks below the splatter that grow downward over 2s.
   *
   * `scaleMult` controls the base decal scale. Task-37 bumped the standard
   * values from (1.4 normal / 2.0 headshot) to (3.5 normal / 4.5 headshot),
   * nearly doubling decal size so splatters read at combat range. Final
   * scale = scaleMult + [0,1.0) random jitter → 3.5-4.5 normal / 4.5-5.5
   * headshot. Droplet-impact splatters use scaleMult = 0.8 (small ground
   * spatter, Task-37 bump from 0.7).
   */
  spawnBloodSplatterDecal(point: THREE.Vector3, normal: THREE.Vector3, scaleMult = 1.4) {
    const decal = this.bloodDecalPool.acquire();
    if (!decal) return; // pool exhausted — drop silently
    const mat = decal.material as THREE.MeshBasicMaterial;
    mat.map = getBloodSplatterTexture();
    mat.color.setHex(0xffffff); // texture provides the color
    mat.opacity = 0.8;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.needsUpdate = true;
    // Position slightly off the surface to avoid z-fighting.
    decal.position.copy(point).add(normal.clone().multiplyScalar(0.012));
    // Orient to the surface normal (face the normal direction).
    decal.lookAt(point.clone().add(normal));
    decal.rotation.z = Math.random() * Math.PI * 2; // random spin
    // Task-37: bumped the random scale jitter from 0.8 → 1.0 so the decal
    // range covers 3.5-4.5 (normal) / 4.5-5.5 (headshot) — matches spec.
    const sc = scaleMult + Math.random() * 1.0;
    decal.scale.set(sc, sc, sc);
    decal.visible = true;
    // Track spawn time + base opacity for the 45s lifetime fade (Task-37).
    decal.userData.spawnTime = performance.now();
    decal.userData.baseOpacity = mat.opacity;
    this.bloodDecals.push(decal);
    // Cap blood decals — recycle oldest when exceeded.
    while (this.bloodDecals.length > BLOOD_DECAL_CAP) {
      const old = this.bloodDecals.shift();
      if (!old) break;
      old.visible = false;
      (old.material as THREE.MeshBasicMaterial).opacity = 0;
      this.bloodDecalPool.release(old);
    }

    // Wall detection: if the normal is mostly horizontal (|y| < 0.3), it's a
    // vertical surface — spawn 3-4 drip streaks below the splatter.
    if (Math.abs(normal.y) < 0.3) {
      const dripCount = 3 + Math.floor(Math.random() * 2);
      for (let i = 0; i < dripCount; i++) {
        this.spawnBloodDrip(point, normal);
      }
    }
  }

  /**
   * Task-32: Spawn a single blood drip streak on a wall below `point`. The
   * drip is a thin elongated plane with the drip texture, anchored at the top.
   * It grows downward over 2s (scale.y 0.1 → 1.0) then fades over 2-4s.
   */
  private spawnBloodDrip(point: THREE.Vector3, normal: THREE.Vector3) {
    const drip = this.bloodDripPool.acquire();
    if (!drip) return;
    const mat = drip.material as THREE.MeshBasicMaterial;
    mat.map = getBloodDripTexture();
    mat.color.setHex(0xffffff);
    mat.opacity = 0.85;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.needsUpdate = true;
    // Position: on the wall surface, slightly offset horizontally + below.
    drip.position.copy(point).add(normal.clone().multiplyScalar(0.013));
    drip.position.x += (Math.random() - 0.5) * 0.2;
    drip.position.y -= 0.1 + Math.random() * 0.2; // 0.1-0.3m below splatter
    // Orient to face the wall normal.
    drip.lookAt(point.clone().add(normal));
    drip.scale.set(1, 0.1, 1); // start thin, grow downward
    drip.visible = true;
    drip.userData.baseOpacity = 0.85;
    this.activeBloodDrips.push({
      mesh: drip,
      growProgress: 0,
      life: 4 + Math.random() * 2, // 4-6s total (2s grow + 2-4s fade)
      maxLife: 5,
      active: true,
    });
  }

  /**
   * Task-32/37: Spawn a growing blood pool at the given ground position. The
   * pool starts at 10% scale and grows to 100% over 3s. The base
   * CircleGeometry radius is 0.4m, scaled by `baseScale` — Task-37 bumped
   * `baseScale` from 1.0 → 3.0 so the final pool radius is 1.2m (was 0.4m),
   * matching the spec's "0.8m → 1.2m" target. 2-3 smaller satellite pools
   * spawn around the main pool for an irregular shape.
   *
   * If `followTarget` is provided (an enemy with `body` + `alive` fields), the
   * pool follows the body's world XZ position during the 3s growth (so it
   * stays under the ragdoll as it settles). After growth, the pool is static
   * and persists until BLOOD_POOL_CAP is exceeded (oldest recycled).
   *
   * Material: bright red (0x8a1010 — Task-37 bump from 0x5a0a0a so the pool
   * reads as fresh wet blood, not dried), opacity 0.85. The procedural
   * bloodPoolTexture provides the irregular shape (lighter fresh center →
   * darker clotted edges).
   */
  spawnBloodPool(point: THREE.Vector3, followTarget?: { body: THREE.Mesh; alive: boolean } | null) {
    const tex = getBloodPoolTexture();

    // Main pool disc.
    const main = this.bloodPoolMeshPool.acquire();
    if (!main) return; // pool exhausted — drop silently
    const mat = main.material as THREE.MeshBasicMaterial;
    mat.map = tex;
    mat.color.setHex(0x8a1010); // Task-37: brighter red (was 0x5a0a0a)
    mat.opacity = 0.85;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.needsUpdate = true;
    main.position.copy(point);
    main.position.y = 0.02; // ground level (avoid z-fighting)
    main.rotation.x = -Math.PI / 2; // lie flat
    main.rotation.z = Math.random() * Math.PI * 2;
    main.scale.setScalar(0.1); // start small (10%)
    main.visible = true;

    // 2-3 satellite pools for irregular shape.
    const satCount = 2 + Math.floor(Math.random() * 2);
    const satellites: THREE.Mesh[] = [];
    for (let i = 0; i < satCount; i++) {
      const sat = this.bloodPoolMeshPool.acquire();
      if (!sat) break;
      const satMat = sat.material as THREE.MeshBasicMaterial;
      satMat.map = tex;
      satMat.color.setHex(0x6a0c0c); // Task-37: brighter (was 0x4a0808)
      satMat.opacity = 0.75;
      satMat.transparent = true;
      satMat.depthWrite = false;
      satMat.needsUpdate = true;
      const angle = (i / satCount) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 0.4 + Math.random() * 0.25; // Task-37: 0.4-0.65m offset (was 0.3-0.5)
      const offset = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
      sat.position.copy(point).add(offset);
      sat.position.y = 0.02;
      sat.rotation.x = -Math.PI / 2;
      sat.rotation.z = Math.random() * Math.PI * 2;
      sat.scale.setScalar(0.1);
      sat.visible = true;
      sat.userData.offset = offset;
      // Task-37: smaller satellite scale (0.3-0.5, was 0.6-0.9) so the
      // satellites read as peripheral spatter rather than competing pools
      // now that the main pool is 3× larger.
      sat.userData.baseScale = 0.3 + Math.random() * 0.2;
      satellites.push(sat);
    }

    this.activeBloodPools.push({
      mesh: main,
      satellites,
      followTarget: followTarget ?? null,
      growProgress: 0,
      // Task-37: baseScale 3.0 (was 1.0) → final radius = 0.4m × 3.0 = 1.2m.
      baseScale: 3.0,
      active: true,
    });

    // Cap blood pools — recycle oldest when exceeded.
    while (this.activeBloodPools.length > BLOOD_POOL_CAP) {
      const old = this.activeBloodPools.shift();
      if (!old) break;
      old.mesh.visible = false;
      (old.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
      this.bloodPoolMeshPool.release(old.mesh);
      for (const sat of old.satellites) {
        sat.visible = false;
        (sat.material as THREE.MeshBasicMaterial).opacity = 0;
        this.bloodPoolMeshPool.release(sat);
      }
    }
  }

  /**
   * Task-32: Splash blood on the camera (screen blood). Pushes a HUD update
   * that triggers a red vignette overlay. The intensity scales the effect.
   *
   * Reuses the existing `damageFlash` HUD field — HUD.tsx already renders a
   * red radial vignette for 350ms after damageFlash is set. The `screenBlood`
   * field is cast through for forward compatibility: once HUD.tsx + store.ts
   * are updated to render a persistent splatter texture overlay (3s fade),
   * this field will drive it.
   *
   * Call this when the player takes damage at close range (e.g. from
   * EnemySystem.onApplyDamageToPlayer when the attacker is within ~3m).
   */
  spawnScreenBlood(intensity: number) {
    const now = performance.now();
    // Push damageFlash to trigger the existing red vignette overlay (HUD.tsx).
    // Also push screenBlood (cast) for future HUD support.
    const payload: Partial<HudState> & Record<string, unknown> = {
      damageFlash: now,
      screenBlood: intensity,
    };
    this.ctx.pushHud(payload as Partial<HudState>);
  }

  // ============================================================
  // GLASS SHATTER — transparent shards + crash sound.
  // ============================================================

  /**
   * Spawn a glass-shatter burst: 10-15 small transparent shards that fly
   * outward from the break point along the surface normal. Plays a sharp
   * high-pitched crash cue (reuses the headshot ding — closest available
   * crystalline sound without editing audio.ts).
   */
  spawnGlassShatter(point: THREE.Vector3, normal: THREE.Vector3) {
    const { ctx } = this;
    const pool = ctx.particlePool;
    const shardCount = 10 + Math.floor(Math.random() * 6);
    const dirN = normal.clone().normalize();
    // Build cone basis for the shatter spread.
    const up = Math.abs(dirN.y) > 0.95 ? this._tmpA.set(1, 0, 0) : this._tmpA.set(0, 1, 0);
    const right = this._tmpB.crossVectors(dirN, up).normalize();
    const upCone = new THREE.Vector3().crossVectors(right, dirN).normalize();

    this._tmpColor.setHex(0xb8d4e8); // glass tint from DEFAULT_MATERIALS
    for (let i = 0; i < shardCount; i++) {
      const m = pool.acquireMesh(this._tmpColor);
      if (!m) break;
      // Elongated shard: thin scale on one axis.
      const sx = 0.4 + Math.random() * 0.6;
      const sy = 0.2 + Math.random() * 0.3;
      const sz = 0.4 + Math.random() * 0.6;
      m.scale.set(sx, sy, sz);
      m.position.copy(point).add(dirN.clone().multiplyScalar(0.05));
      // Cone spread outward from the break point.
      const spread = 0.4 + Math.random() * 0.6;
      const azimuth = Math.random() * Math.PI * 2;
      const vel = dirN.clone().multiplyScalar(2 + Math.random() * 4)
        .add(right.clone().multiplyScalar(Math.cos(azimuth) * spread * 3))
        .add(upCone.clone().multiplyScalar(Math.sin(azimuth) * spread * 3));
      vel.y += 0.5 + Math.random() * 1.5;
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.transparent = true;
      mat.opacity = 0.85;
      mat.metalness = 0.1;
      mat.roughness = 0.05;
      pool.activeParticles.push({
        mesh: m, velocity: vel, life: 1.0 + Math.random() * 0.5, maxLife: 1.5,
        gravity: true, fade: true, active: true,
      });
    }
    // Sparkle flash — a few bright white sparks for the glint of breaking glass.
    const sparkTex = cachedParticleTexture("rgb(255,255,255)");
    for (let i = 0; i < 6; i++) {
      const s = pool.acquireSprite(sparkTex, 0xffffff);
      if (!s) break;
      s.scale.setScalar(0.05 + Math.random() * 0.05);
      s.position.copy(point).add(dirN.clone().multiplyScalar(0.04));
      const vel = dirN.clone().multiplyScalar(2 + Math.random() * 3)
        .add(new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 2 + 1, (Math.random() - 0.5) * 4));
      pool.activeParticles.push({
        mesh: s, velocity: vel, life: 0.2 + Math.random() * 0.1, maxLife: 0.3,
        gravity: true, fade: true, active: true,
      });
    }

    // Glass crash cue — reuse the existing headshotDing (two high-pitched
    // sines) as the closest crystalline "tink" available without editing
    // audio.ts. The visual disambiguates it from an actual headshot.
    ctx.audio.headshotDing();
  }

  // ============================================================
  // DEBRIS (legacy prop destruction) — generic colored chunks.
  // ============================================================

  /** Spawn debris (used by EnemySystem.destroyProp). */
  spawnDebris(point: THREE.Vector3, color: THREE.Color, count = 14) {
    const { ctx } = this;
    for (let i = 0; i < count; i++) {
      const m = ctx.particlePool.acquireMesh(color);
      if (!m) break;
      m.position.copy(point);
      const vel = new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 5 + 2, (Math.random() - 0.5) * 6);
      ctx.particlePool.activeParticles.push({ mesh: m, velocity: vel, life: 1.2, maxLife: 1.2, gravity: true, fade: true, active: true });
    }
  }

  // ============================================================
  // EXPLOSIONS — Task-25 cinematic layered VFX.
  //   Flash → Fireball → Smoke → Shockwave → Debris → Dust
  //   + point light + screen shake + FOV punch + barrel chain reaction.
  // ============================================================

  /**
   * Task-25: Spawn a cinematic layered explosion at `point`.
   *
   * Stages (all spawned together for a layered effect):
   *   1. Initial flash — bright emissive sphere (0.5m → scale*2m in 0.1s).
   *      Plus a point light (intensity 10, distance 15m, color 0xffaa44, 0.2s).
   *   2. Fireball — 15-25 orange-red additive particles expanding + rising
   *      (0.3m → ~1.5m, 0.6s lifetime).
   *   3. Smoke cloud — 8-12 dark grey particles (0x2a2a2a, opacity 0.7 → 0)
   *      that expand + rise slowly (1m → 4m, 2s lifetime).
   *   4. Shockwave ring — flat ring on the ground that expands
   *      (0.5m → scale*3m in 0.3s, white → transparent).
   *   5. Debris — 10-15 small dark chunks with gravity + one bounce (3s life).
   *   6. Dust — 6-8 tan/brown particles near the ground that expand + fade
   *      (1.5s lifetime).
   *
   * Per-kind tuning:
   *   grenade — scale 1.0, medium fireball + smoke, shake 0.5, FOV punch +1.5.
   *   barrel  — scale 1.5, more fireball, shake 0.7, FOV punch +3.0.
   *             Chain reaction: scans for other barrels within 3m and
   *             schedules them to explode 0.3s later (recursive).
   *   c4      — scale 2.0, most debris, shake 0.9, FOV punch +5.0.
   *
   * All elements are pooled — flash/shockwave/debris/light use dedicated
   * ObjectPools; fireball/smoke/dust reuse the existing sprite/mesh pool.
   */
  spawnExplosion(point: THREE.Vector3, scale: number, kind: ExplosionKind) {
    const { ctx } = this;
    const pool = ctx.particlePool;

    // Per-kind tuning.
    // Task-41 — reduced all counts by ~30% for perf. Explosions are still
    // cinematic (flash + light + shockwave unchanged; only the pooled
    // particle counts shrink). Pools unchanged (pre-allocated).
    const fireballCount = kind === "grenade" ? 10 : kind === "barrel" ? 15 : 17;
    const smokeCount    = kind === "grenade" ? 6  : kind === "barrel" ? 8  : 8;
    const debrisCount   = kind === "grenade" ? 7  : kind === "barrel" ? 8  : 10;
    const dustCount     = kind === "grenade" ? 4  : kind === "barrel" ? 5  : 6;
    const shakeIntensity = kind === "grenade" ? 0.5 : kind === "barrel" ? 0.7 : 0.9;
    const fovPunch       = kind === "grenade" ? 1.5 : kind === "barrel" ? 3.0 : 5.0;

    // ─── 1. INITIAL FLASH — bright emissive sphere that scales up + fades. ───
    const flash = this.flashPool.acquire();
    if (flash) {
      const mat = flash.material as THREE.MeshBasicMaterial;
      mat.color.setHex(0xffeeaa);
      mat.opacity = 1;
      flash.position.copy(point);
      flash.scale.setScalar(0.5);
      flash.visible = true;
      this.activeFlashes.push({
        mesh: flash,
        life: 0.1, maxLife: 0.1,
        scaleStart: 0.5, scaleEnd: scale * 2,
        active: true,
      });
    }

    // ─── Point light at the explosion position (0xffaa44, 10 intensity, 0.2s). ───
    const light = this.explosionLightPool.acquire();
    if (light) {
      light.position.copy(point);
      light.color.setHex(0xffaa44);
      light.intensity = 10;
      light.distance = 15;
      light.visible = true;
      this.activeExplosionLights.push({
        light, life: 0.2, maxLife: 0.2, active: true,
      });
    }

    // ─── 2. FIREBALL — 15-25 orange-red additive particles, expand + rise. ───
    const fireballTex = cachedParticleTexture("rgb(255,120,40)");
    for (let i = 0; i < fireballCount; i++) {
      const s = pool.acquireSprite(fireballTex, 0xffffff);
      if (!s) break;
      const sc = 0.3 + Math.random() * 0.2;
      s.scale.setScalar(sc);
      s.position.copy(point);
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.2 + 0.3;
      const vel = new THREE.Vector3(
        Math.cos(a) * r * (2 + Math.random() * 3),
        1.5 + Math.random() * 3,
        Math.sin(a) * r * (2 + Math.random() * 3),
      ).multiplyScalar(scale);
      const mat = s.material as THREE.SpriteMaterial;
      mat.blending = THREE.AdditiveBlending;
      mat.color.setHex(Math.random() < 0.5 ? 0xff6622 : 0xffaa44);
      mat.opacity = 1;
      pool.activeParticles.push({
        mesh: s, velocity: vel, life: 0.5 + Math.random() * 0.1, maxLife: 0.6,
        gravity: false, fade: true, active: true,
      });
    }

    // ─── 3. SMOKE CLOUD — 8-12 dark grey particles, expand + rise slowly. ───
    // Smoke lingers after the fireball fades (2s lifetime vs 0.6s fireball).
    const smokeTex = smokeTexture();
    for (let i = 0; i < smokeCount; i++) {
      const s = pool.acquireSprite(smokeTex, 0x2a2a2a);
      if (!s) break;
      const sc = 1.0 + Math.random() * 0.5;
      s.scale.setScalar(sc * scale);
      // Offset slightly so the cloud isn't a single point.
      s.position.copy(point).add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.5,
        Math.random() * 0.6,
        (Math.random() - 0.5) * 0.5,
      ));
      const a = Math.random() * Math.PI * 2;
      const vel = new THREE.Vector3(
        Math.cos(a) * (1 + Math.random()),
        0.5 + Math.random() * 1.5,
        Math.sin(a) * (1 + Math.random()),
      ).multiplyScalar(scale);
      const mat = s.material as THREE.SpriteMaterial;
      mat.color.setHex(0x2a2a2a);
      mat.opacity = 0.7;
      mat.blending = THREE.NormalBlending;
      pool.activeParticles.push({
        mesh: s, velocity: vel, life: 1.8 + Math.random() * 0.4, maxLife: 2.0,
        gravity: false, fade: true, active: true,
      });
    }

    // ─── 4. SHOCKWAVE RING — flat ring on the ground, expands + fades. ───
    const shockwave = this.shockwavePool.acquire();
    if (shockwave) {
      const mat = shockwave.material as THREE.MeshBasicMaterial;
      mat.color.setHex(0xffffff);
      mat.opacity = 0.8;
      shockwave.position.copy(point);
      // Lie flat on the ground (ring is in XY plane by default; rotate -π/2
      // around X to lie in XZ plane). Keep slightly above ground to avoid
      // z-fighting with the floor.
      shockwave.position.y = Math.max(0.02, point.y - 0.05);
      shockwave.rotation.x = -Math.PI / 2;
      shockwave.rotation.z = Math.random() * Math.PI * 2;
      shockwave.scale.setScalar(0.5);
      shockwave.visible = true;
      this.activeShockwaves.push({
        mesh: shockwave,
        life: 0.3, maxLife: 0.3,
        scaleStart: 0.5, scaleEnd: scale * 3,
        active: true,
      });
    }

    // ─── 5. DEBRIS — 10-15 small dark chunks with gravity + one bounce. ───
    for (let i = 0; i < debrisCount; i++) {
      const m = this.explosionDebrisPool.acquire();
      if (!m) break;
      m.position.copy(point);
      m.scale.setScalar(0.6 + Math.random() * 0.8);
      m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      const a = Math.random() * Math.PI * 2;
      const upBias = 3 + Math.random() * 4;
      const horiz = 4 + Math.random() * 4;
      const vel = new THREE.Vector3(
        Math.cos(a) * horiz,
        upBias,
        Math.sin(a) * horiz,
      ).multiplyScalar(scale);
      const angVel = new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
      );
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.color.setHex(0x1a1a1a);
      mat.opacity = 1;
      mat.transparent = false;
      m.visible = true;
      this.activeExplosionDebris.push({
        mesh: m, velocity: vel, angVel,
        life: 3.0, maxLife: 3.0,
        bounceCount: 0, settled: false, active: true,
      });
    }

    // ─── 6. DUST — 6-8 tan/brown particles near the ground, expand + fade. ───
    const dustTex = smokeTexture();
    for (let i = 0; i < dustCount; i++) {
      const s = pool.acquireSprite(dustTex, 0xc9b08a);
      if (!s) break;
      const sc = 0.5 + Math.random() * 0.3;
      s.scale.setScalar(sc * scale);
      // Spawn low to the ground so the dust appears to kick up from the floor.
      s.position.copy(point).add(new THREE.Vector3(
        (Math.random() - 0.5) * 1.0,
        0.1 + Math.random() * 0.2,
        (Math.random() - 0.5) * 1.0,
      ));
      const a = Math.random() * Math.PI * 2;
      const vel = new THREE.Vector3(
        Math.cos(a) * (2 + Math.random() * 2),
        0.3 + Math.random() * 0.5,
        Math.sin(a) * (2 + Math.random() * 2),
      ).multiplyScalar(scale);
      const mat = s.material as THREE.SpriteMaterial;
      mat.color.setHex(0xc9b08a);
      mat.opacity = 0.6;
      mat.blending = THREE.NormalBlending;
      pool.activeParticles.push({
        mesh: s, velocity: vel, life: 1.2 + Math.random() * 0.3, maxLife: 1.5,
        gravity: false, fade: true, active: true,
      });
    }

    // ─── Screen shake per kind. ───
    ctx.triggerShake(shakeIntensity);

    // ─── FOV punch — brief spike in camera.fov; PhysicsSystem dampens it back. ───
    if (fovPunch > 0) {
      // Compute the current FOV target (baseFov, or baseFov/zoom if ADS).
      const baseFov = ctx.weapon.baseFov;
      const targetFov = ctx.weapon.isAiming ? baseFov / ctx.weapon.stats.effectiveZoom : baseFov;
      ctx.camera.fov = targetFov + fovPunch;
      ctx.camera.updateProjectionMatrix();
      // PhysicsSystem.update dampens camera.fov back to targetFov at rate ~12/s,
      // so the punch recovers in ~0.2-0.4s naturally.
    }

    // ─── Audio — reuse the distant sniper cue as the boom. ───
    ctx.audio.distantGunshot(point.x, point.y, point.z, false, "sniper");

    // ─── Chain reaction for barrels — schedule a 0.3s delayed scan for
    //      nearby barrels + recursively explode them. ───
    if (kind === "barrel") {
      this.scheduleBarrelChainReaction(point);
    }
  }

  /**
   * Task-25: Schedule a barrel chain-reaction scan 300ms after a barrel
   * explosion. Scans `ctx.destructibles` for intact barrels (surfaceType
   * "barrel") within 3m of the origin (excluding the already-destroyed
   * origin barrel — it's already been removed from ctx.destructibles by
   * the time the timer fires). Each found barrel:
   *   - has its health set to 0
   *   - is removed from the scene + ctx.destructibles + ctx.colliders
   *     (replicates EnemySystem.destroyProp cleanup)
   *   - has spawnExplosion called at its position (recursive — the new
   *     explosion schedules its own chain scan, propagating the chain).
   */
  private scheduleBarrelChainReaction(originPoint: THREE.Vector3) {
    const { ctx } = this;
    setTimeout(() => {
      // Snapshot the destructibles array — we modify it during iteration.
      const candidates = ctx.destructibles.slice();
      for (const prop of candidates) {
        if (prop.health <= 0) continue;
        if (prop.mesh.userData.surfaceType !== "barrel") continue;
        const dist = prop.mesh.position.distanceTo(originPoint);
        // Within 3m + a small min-distance to avoid re-exploding the origin.
        if (dist < 0.5 || dist > 3.0) continue;
        // Destroy the chained barrel.
        const propPos = prop.mesh.position.clone();
        const colorMat = (prop.mesh.material as THREE.MeshStandardMaterial).color;
        prop.health = 0;
        prop.mesh.removeFromParent();
        const ci = ctx.colliders.indexOf(prop.collider);
        if (ci >= 0) ctx.colliders.splice(ci, 1);
        const di = ctx.destructibles.indexOf(prop);
        if (di >= 0) ctx.destructibles.splice(di, 1);
        // Small debris burst from the barrel itself (in addition to the
        // explosion's own debris — reads as the barrel "popping" open).
        this.spawnDebris(propPos, colorMat, 10);
        // Recursive explosion — this schedules the next chain scan.
        this.spawnExplosion(propPos, 1.5, "barrel");
      }
    }, 300);
  }

  // ============================================================
  // DECAL LIFETIME — Task-25: 20s persistence with fade-out.
  // ============================================================

  /** Task-25: release a decal back to the pool + remove from ctx.decals. */
  private releaseDecal(decal: THREE.Mesh) {
    decal.visible = false;
    (decal.material as THREE.MeshBasicMaterial).opacity = 0;
    this.ctx.particlePool.decalPool.release(decal);
    const i = this.ctx.decals.indexOf(decal);
    if (i >= 0) this.ctx.decals.splice(i, 1);
  }

  // ============================================================
  // SHELL CASINGS — pooled brass with physics (gravity, spin, bounce).
  // ============================================================

  /**
   * Eject a shell casing from the weapon's ejection port. Per-weapon:
   *   - pistol/rifle/sniper: small brass cylinder (color 0xb8862a)
   *   - shotgun: red plastic shell (color 0xb33a2a, larger)
   *
   * Casings are pooled (cap 30 active). They eject up-right with random
   * spin, fall under gravity, bounce once off the ground with damping,
   * then settle and fade out after ~3s.
   */
  ejectShell(weaponType: WeaponType) {
    const { ctx } = this;
    const mesh = this.shellPool.acquire();
    if (!mesh) return; // pool exhausted — drop casing silently

    // Position at the ejection port (right side of weapon, near the chamber).
    // Use the muzzleTip world position offset to the right + slightly back.
    ctx.gunParts.muzzleTip.getWorldPosition(this._tmpA);
    // Camera right vector in world space.
    ctx.camera.getWorldDirection(this._tmpB);
    const right = new THREE.Vector3().crossVectors(this._tmpB, new THREE.Vector3(0, 1, 0)).normalize();
    const ejectPos = this._tmpA.clone()
      .add(right.multiplyScalar(0.15))
      .add(new THREE.Vector3(0, -0.05, 0));
    mesh.position.copy(ejectPos);

    // Per-weapon color + scale.
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const isShotgun = weaponType === "nova";
    if (isShotgun) {
      mat.color.setHex(0xb33a2a); // red plastic
      mat.metalness = 0.1;
      mat.roughness = 0.6;
      mesh.scale.set(1.4, 1.6, 1.4);
    } else if (weaponType === "deagle" || weaponType === "awp" || weaponType === "scout") {
      mat.color.setHex(0xcaa23a); // larger brass for big calibers
      mat.metalness = 0.9;
      mat.roughness = 0.3;
      mesh.scale.set(1.2, 1.4, 1.2);
    } else {
      mat.color.setHex(0xb8862a); // standard brass
      mat.metalness = 0.85;
      mat.roughness = 0.35;
      mesh.scale.set(1, 1, 1);
    }
    mat.opacity = 1;
    mat.transparent = false;
    mesh.visible = true;
    // Random initial rotation.
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

    // Ejection velocity: up-right + forward (opposite the ejection port side).
    const forward = this._tmpB.clone().multiplyScalar(-1);
    const vel = right.clone().multiplyScalar(2.5 + Math.random() * 1.5) // right
      .add(new THREE.Vector3(0, 1.8 + Math.random() * 0.8, 0)) // up
      .add(forward.multiplyScalar(0.5 + Math.random() * 0.5)); // slightly back
    // Angular velocity — random spin on all axes.
    const angVel = new THREE.Vector3(
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 18,
    );

    this.activeShells.push({
      mesh, velocity: vel, angVel,
      life: 3.0, maxLife: 3.0, settled: false, active: true,
    });
  }

  // ============================================================
  // MUZZLE SMOKE — small grey puff that drifts up + fades.
  // ============================================================

  /**
   * Spawn a muzzle smoke puff at the muzzle position. Drifts up + slightly
   * forward, fades in ~0.4s. Suppressed weapons get a bigger, longer-lived
   * puff (quieter signature, more visible vapor).
   */
  spawnMuzzleSmoke(point: THREE.Vector3, forward: THREE.Vector3, suppressed: boolean) {
    const { ctx } = this;
    const smoke = ctx.particlePool.acquireSprite(smokeTexture(), 0xffffff);
    if (!smoke) return;
    const mat = smoke.material as THREE.SpriteMaterial;
    mat.opacity = suppressed ? 0.55 : 0.35;
    const sc = suppressed ? 0.45 : 0.28;
    smoke.scale.setScalar(sc);
    smoke.position.copy(point).add(forward.clone().multiplyScalar(0.08));
    const vel = forward.clone().multiplyScalar(0.6)
      .add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.6 + Math.random() * 0.4, (Math.random() - 0.5) * 0.3));
    const life = suppressed ? 0.55 : 0.4;
    ctx.particlePool.activeParticles.push({
      mesh: smoke, velocity: vel, life, maxLife: life,
      gravity: false, fade: true, active: true,
    });
  }

  // ============================================================
  // UPDATE — particles, tracers, shells, muzzle flash timer.
  // ============================================================

  update(dt: number) {
    const { ctx } = this;
    const pool = ctx.particlePool;
    // --- Particles (in-place; release dead ones). ---
    for (let i = pool.activeParticles.length - 1; i >= 0; i--) {
      const p = pool.activeParticles[i];
      p.life -= dt;
      if (p.life <= 0) {
        pool.releaseParticle(p);
        pool.activeParticles.splice(i, 1);
        continue;
      }
      if (p.gravity) {
        // Task-32: support per-particle custom gravity (blood chunks use 14).
        const g = (p.mesh.userData.customGravity as number | undefined) ?? 12;
        p.velocity.y -= g * dt;
      }
      p.mesh.position.addScaledVector(p.velocity, dt);
      // Task-32: blood droplets bounce once on ground impact, then settle.
      // Task-37: 100% chance to leave a small ground splatter decal on bounce
      // (was 15%) — guarantees visible blood on the ground after every hit.
      if (p.mesh.userData.bloodDroplet && p.mesh.position.y < 0.03) {
        p.mesh.position.y = 0.03;
        const bounced = (p.mesh.userData.bounceCount as number) ?? 0;
        if (bounced < 1 && Math.abs(p.velocity.y) > 0.5) {
          // Bounce with damping.
          p.velocity.y = -p.velocity.y * 0.35;
          p.velocity.x *= 0.6;
          p.velocity.z *= 0.6;
          p.mesh.userData.bounceCount = 1;
          // Task-37: always leave a small ground splatter decal on bounce
          // (was 15% chance). scaleMult 0.8 (slight bump from 0.7) so each
          // droplet spatter is clearly visible on the ground.
          this.spawnBloodSplatterDecal(
            this._tmpC.set(p.mesh.position.x, 0.02, p.mesh.position.z),
            this._tmpD.set(0, 1, 0),
            0.8,
          );
        } else {
          // Settle — stop moving.
          p.velocity.set(0, 0, 0);
          p.mesh.userData.bounceCount = 2;
        }
      }
      if (p.fade) {
        const a = p.life / p.maxLife;
        if (p.mesh instanceof THREE.Sprite) (p.mesh.material as THREE.SpriteMaterial).opacity = a;
        else {
          (p.mesh.material as THREE.MeshStandardMaterial).opacity = a;
          (p.mesh.material as THREE.MeshStandardMaterial).transparent = true;
        }
      }
      if (p.mesh instanceof THREE.Sprite && !p.gravity) p.mesh.scale.setScalar(p.mesh.scale.x + dt * 0.8);
    }
    // --- Tracers — fade out the traveling bullet streak. ---
    for (let i = pool.activeTracers.length - 1; i >= 0; i--) {
      const t = pool.activeTracers[i];
      t.life -= dt;
      const lifeRatio = t.life / t.maxLife;
      (t.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, lifeRatio) * 0.95;
      if (t.life <= 0) {
        pool.releaseTracer(t);
        pool.activeTracers.splice(i, 1);
      }
    }
    // --- Shell casings — physics: gravity, spin, bounce, settle, fade. ---
    for (let i = this.activeShells.length - 1; i >= 0; i--) {
      const sh = this.activeShells[i];
      sh.life -= dt;
      if (sh.life <= 0) {
        sh.mesh.visible = false;
        this.shellPool.release(sh.mesh);
        this.activeShells.splice(i, 1);
        continue;
      }
      if (!sh.settled) {
        // Gravity.
        sh.velocity.y -= 14 * dt;
        sh.mesh.position.addScaledVector(sh.velocity, dt);
        // Spin.
        sh.mesh.rotation.x += sh.angVel.x * dt;
        sh.mesh.rotation.y += sh.angVel.y * dt;
        sh.mesh.rotation.z += sh.angVel.z * dt;
        // Ground bounce (y=0 is the floor — casings rest on the ground plane).
        if (sh.mesh.position.y < 0.02) {
          sh.mesh.position.y = 0.02;
          if (Math.abs(sh.velocity.y) > 0.5) {
            // Bounce with damping.
            sh.velocity.y = -sh.velocity.y * 0.35;
            sh.velocity.x *= 0.6;
            sh.velocity.z *= 0.6;
            sh.angVel.multiplyScalar(0.5);
          } else {
            // Settle — stop moving, just spin down + fade.
            sh.settled = true;
            sh.velocity.set(0, 0, 0);
            sh.angVel.multiplyScalar(0.3);
          }
        }
      } else {
        // Settled: spin down.
        sh.angVel.multiplyScalar(1 - Math.min(1, dt * 4));
        sh.mesh.rotation.x += sh.angVel.x * dt;
        sh.mesh.rotation.y += sh.angVel.y * dt;
        sh.mesh.rotation.z += sh.angVel.z * dt;
      }
      // Fade out in the last 0.5s of life.
      if (sh.life < 0.5) {
        const mat = sh.mesh.material as THREE.MeshStandardMaterial;
        mat.transparent = true;
        mat.opacity = sh.life / 0.5;
      }
    }
    // --- Muzzle flash timer. ---
    if (ctx.muzzleTimer > 0) {
      // Task-6: enhance the muzzle flash with a scale-up + fade animation +
      // a small per-frame Z flicker so the burst feels like a multi-point
      // star rather than a static sprite. lifeRatio goes 1 → 0 as the flash
      // decays; we scale from 1.4× (early pop) down to 0.7× (late fade) and
      // fade opacity 0.95 → 0 over the same window.
      const MUZZLE_FLASH_DURATION = 0.05; // matches WeaponSystem's unsuppressed timer
      const lifeRatio = Math.max(0, Math.min(1, ctx.muzzleTimer / MUZZLE_FLASH_DURATION));
      const flash = ctx.muzzleFlash;
      if (flash.visible) {
        const baseScale = (flash.userData.baseScale as number | undefined) ?? flash.scale.x;
        const animScale = baseScale * (0.7 + 0.7 * lifeRatio); // 1.4× → 0.7× as it decays
        flash.scale.set(animScale, animScale, animScale);
        flash.rotation.z += dt * 18; // flicker spin
        const mat = flash.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.95 * lifeRatio;
        mat.transparent = true;
      }
      ctx.muzzleTimer -= dt;
      if (ctx.muzzleTimer <= 0) { ctx.muzzleFlash.visible = false; ctx.muzzleLight.intensity = 0; }
      else ctx.muzzleLight.intensity = THREE.MathUtils.damp(ctx.muzzleLight.intensity, 0, 30, dt);
    }

    // ─── Task-25: explosion flash spheres — scale up + fade out. ───
    for (let i = this.activeFlashes.length - 1; i >= 0; i--) {
      const f = this.activeFlashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.mesh.visible = false;
        (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
        this.flashPool.release(f.mesh);
        this.activeFlashes.splice(i, 1);
        continue;
      }
      // lifeRatio goes 1 → 0; scale eases from scaleStart → scaleEnd.
      const t = 1 - (f.life / f.maxLife);
      const s = f.scaleStart + (f.scaleEnd - f.scaleStart) * t;
      f.mesh.scale.setScalar(s);
      const mat = f.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = f.life / f.maxLife;
    }

    // ─── Task-25: explosion point lights — decay intensity to 0. ───
    for (let i = this.activeExplosionLights.length - 1; i >= 0; i--) {
      const el = this.activeExplosionLights[i];
      el.life -= dt;
      if (el.life <= 0) {
        el.light.visible = false;
        el.light.intensity = 0;
        this.explosionLightPool.release(el.light);
        this.activeExplosionLights.splice(i, 1);
        continue;
      }
      // Intensity decays from 10 → 0 over the lifetime.
      el.light.intensity = 10 * (el.life / el.maxLife);
    }

    // ─── Task-25: shockwave rings — expand + fade out. ───
    for (let i = this.activeShockwaves.length - 1; i >= 0; i--) {
      const sw = this.activeShockwaves[i];
      sw.life -= dt;
      if (sw.life <= 0) {
        sw.mesh.visible = false;
        (sw.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
        this.shockwavePool.release(sw.mesh);
        this.activeShockwaves.splice(i, 1);
        continue;
      }
      const t = 1 - (sw.life / sw.maxLife);
      const s = sw.scaleStart + (sw.scaleEnd - sw.scaleStart) * t;
      sw.mesh.scale.setScalar(s);
      const mat = sw.mesh.material as THREE.MeshBasicMaterial;
      // Fade from white → transparent.
      mat.opacity = 0.8 * (sw.life / sw.maxLife);
    }

    // ─── Task-25: explosion debris — gravity + one bounce + fade out. ───
    for (let i = this.activeExplosionDebris.length - 1; i >= 0; i--) {
      const d = this.activeExplosionDebris[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.mesh.visible = false;
        (d.mesh.material as THREE.MeshStandardMaterial).opacity = 0;
        this.explosionDebrisPool.release(d.mesh);
        this.activeExplosionDebris.splice(i, 1);
        continue;
      }
      if (!d.settled) {
        // Gravity.
        d.velocity.y -= 14 * dt;
        d.mesh.position.addScaledVector(d.velocity, dt);
        // Spin.
        d.mesh.rotation.x += d.angVel.x * dt;
        d.mesh.rotation.y += d.angVel.y * dt;
        d.mesh.rotation.z += d.angVel.z * dt;
        // Ground bounce (one bounce max, then settle).
        if (d.mesh.position.y < 0.05) {
          d.mesh.position.y = 0.05;
          if (d.bounceCount < 1 && Math.abs(d.velocity.y) > 0.5) {
            // Bounce with damping.
            d.velocity.y = -d.velocity.y * 0.4;
            d.velocity.x *= 0.6;
            d.velocity.z *= 0.6;
            d.angVel.multiplyScalar(0.5);
            d.bounceCount++;
          } else {
            // Settle — stop moving, spin down.
            d.settled = true;
            d.velocity.set(0, 0, 0);
            d.angVel.multiplyScalar(0.3);
          }
        }
      } else {
        // Settled: spin down.
        d.angVel.multiplyScalar(1 - Math.min(1, dt * 4));
        d.mesh.rotation.x += d.angVel.x * dt;
        d.mesh.rotation.y += d.angVel.y * dt;
        d.mesh.rotation.z += d.angVel.z * dt;
      }
      // Fade out in the last 0.5s of life.
      if (d.life < 0.5) {
        const dmat = d.mesh.material as THREE.MeshStandardMaterial;
        dmat.transparent = true;
        dmat.opacity = d.life / 0.5;
      }
    }

    // ─── REALISM-1 (task B): scope glints — sin-wave intensity flicker + ───
    //    envelope fade-in / fade-out. Opacity = envelope * (0.5 + 0.5 * sin),
    //    where envelope ramps 0→1 over the first 15% of life (fade-in) and
    //    1→0 over the last 30% (fade-out). The sin flicker (10–16 Hz) mimics
    //    the sun catching the ocular lens — bright pinpoints winking on/off.
    for (let i = this.activeScopeGlints.length - 1; i >= 0; i--) {
      const g = this.activeScopeGlints[i];
      g.life -= dt;
      if (g.life <= 0) {
        g.sprite.visible = false;
        (g.sprite.material as THREE.SpriteMaterial).opacity = 0;
        this.scopeGlintPool.release(g.sprite);
        this.activeScopeGlints.splice(i, 1);
        continue;
      }
      const lifeRatio = g.life / g.maxLife;          // 1 → 0 over lifetime
      // Envelope: fade-in over first 15% (0.85→1.0), hold, fade-out over last 30% (1.0→0).
      let envelope: number;
      if (lifeRatio > 0.85) {
        envelope = (1.0 - lifeRatio) / 0.15;          // fade-in: 0 → 1
      } else if (lifeRatio < 0.30) {
        envelope = lifeRatio / 0.30;                  // fade-out: 0 → 1
      } else {
        envelope = 1.0;
      }
      // Sin-wave flicker — 0.5 + 0.5 * sin so it pulses between 0 and 1.
      const t = (g.maxLife - g.life) * g.flickerFreq * Math.PI * 2;
      const flicker = 0.5 + 0.5 * Math.sin(t + g.phase);
      const mat = g.sprite.material as THREE.SpriteMaterial;
      mat.opacity = envelope * (0.35 + 0.65 * flicker);
      // Scale subtly breathes with the flicker — ±8%.
      const scaleBase = 0.18;
      const scaleBreath = 1 + 0.08 * flicker;
      g.sprite.scale.setScalar(scaleBase * scaleBreath);
    }

    // ─── Task-25: decal lifetime — fade out in the last DECAL_FADE_WINDOW
    //    seconds + release after DECAL_LIFETIME. ───
    const now = performance.now();
    for (let i = ctx.decals.length - 1; i >= 0; i--) {
      const decal = ctx.decals[i];
      const spawnTime = (decal.userData.spawnTime as number | undefined) ?? now;
      const age = (now - spawnTime) / 1000;
      if (age >= DECAL_LIFETIME) {
        this.releaseDecal(decal);
        continue;
      }
      // Fade out in the last DECAL_FADE_WINDOW seconds.
      if (age > DECAL_LIFETIME - DECAL_FADE_WINDOW) {
        const baseOp = (decal.userData.baseOpacity as number | undefined) ?? 0.85;
        const fadeRatio = Math.max(0, (DECAL_LIFETIME - age) / DECAL_FADE_WINDOW);
        (decal.material as THREE.MeshBasicMaterial).opacity = baseOp * fadeRatio;
      }
    }

    // ─── Task-32: blood drip streaks — grow downward over 2s, then fade. ───
    for (let i = this.activeBloodDrips.length - 1; i >= 0; i--) {
      const d = this.activeBloodDrips[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.mesh.visible = false;
        (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
        this.bloodDripPool.release(d.mesh);
        this.activeBloodDrips.splice(i, 1);
        continue;
      }
      // Grow downward: scale.y from 0.1 → 1.0 over the first 2s.
      if (d.growProgress < 1) {
        d.growProgress = Math.min(1, d.growProgress + dt / 2);
        d.mesh.scale.y = 0.1 + 0.9 * d.growProgress;
      }
      // Fade out in the last 2s of life.
      if (d.life < 2) {
        const baseOp = (d.mesh.userData.baseOpacity as number) ?? 0.85;
        (d.mesh.material as THREE.MeshBasicMaterial).opacity = baseOp * (d.life / 2);
      }
    }

    // ─── Task-32: blood pools — grow over 3s, follow enemy chest, persist. ───
    for (const p of this.activeBloodPools) {
      if (p.growProgress < 1) {
        p.growProgress = Math.min(1, p.growProgress + dt / 3);
        const s = 0.1 + 0.9 * p.growProgress;
        p.mesh.scale.setScalar(s * p.baseScale);
        for (const sat of p.satellites) {
          const satBase = (sat.userData.baseScale as number) ?? 0.7;
          sat.scale.setScalar(s * satBase);
        }
        // Follow enemy chest during growth (so pool stays under the ragdoll
        // as it settles). Uses the body's world position projected to XZ.
        if (p.followTarget && !p.followTarget.alive) {
          const chest = p.followTarget.body.getWorldPosition(this._tmpC);
          p.mesh.position.x = chest.x;
          p.mesh.position.z = chest.z;
          for (const sat of p.satellites) {
            const off = sat.userData.offset as THREE.Vector3;
            sat.position.x = chest.x + off.x;
            sat.position.z = chest.z + off.z;
          }
        }
      }
      // Pools persist after growth — no life decrement. Oldest recycled by
      // the cap check in spawnBloodPool when BLOOD_POOL_CAP is exceeded.
    }

    // ─── Task-32/37: blood splatter decal lifetime — fade + release after 45s. ───
    for (let i = this.bloodDecals.length - 1; i >= 0; i--) {
      const decal = this.bloodDecals[i];
      const spawnTime = (decal.userData.spawnTime as number) ?? now;
      const age = (now - spawnTime) / 1000;
      if (age >= BLOOD_DECAL_LIFETIME) {
        decal.visible = false;
        (decal.material as THREE.MeshBasicMaterial).opacity = 0;
        this.bloodDecalPool.release(decal);
        this.bloodDecals.splice(i, 1);
        continue;
      }
      // Fade out in the last BLOOD_DECAL_FADE_WINDOW seconds.
      if (age > BLOOD_DECAL_LIFETIME - BLOOD_DECAL_FADE_WINDOW) {
        const baseOp = (decal.userData.baseOpacity as number) ?? 0.8;
        const fadeRatio = Math.max(0, (BLOOD_DECAL_LIFETIME - age) / BLOOD_DECAL_FADE_WINDOW);
        (decal.material as THREE.MeshBasicMaterial).opacity = baseOp * fadeRatio;
      }
    }
  }

  dispose() {
    // Release all active decals back to the pool before disposing.
    for (const d of this.ctx.decals) {
      d.visible = false;
      (d.material as THREE.MeshBasicMaterial).opacity = 0;
      this.ctx.particlePool.decalPool.release(d);
    }
    this.ctx.decals = [];
    // Release all active shells.
    for (const sh of this.activeShells) {
      sh.mesh.visible = false;
      this.shellPool.release(sh.mesh);
    }
    this.activeShells = [];
    // Dispose shell pool geometries/materials.
    this.shellPool.forEachAll((m) => {
      this.ctx.scene.remove(m);
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    });
    // Task-25: release + dispose explosion element pools.
    for (const f of this.activeFlashes) {
      f.mesh.visible = false;
      this.flashPool.release(f.mesh);
    }
    this.activeFlashes = [];
    this.flashPool.forEachAll((m) => {
      this.ctx.scene.remove(m);
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    });
    for (const sw of this.activeShockwaves) {
      sw.mesh.visible = false;
      this.shockwavePool.release(sw.mesh);
    }
    this.activeShockwaves = [];
    this.shockwavePool.forEachAll((m) => {
      this.ctx.scene.remove(m);
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    });
    for (const el of this.activeExplosionLights) {
      el.light.visible = false;
      el.light.intensity = 0;
      this.explosionLightPool.release(el.light);
    }
    this.activeExplosionLights = [];
    this.explosionLightPool.forEachAll((l) => {
      this.ctx.scene.remove(l);
    });
    for (const d of this.activeExplosionDebris) {
      d.mesh.visible = false;
      this.explosionDebrisPool.release(d.mesh);
    }
    this.activeExplosionDebris = [];
    this.explosionDebrisPool.forEachAll((m) => {
      this.ctx.scene.remove(m);
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    });
    // Task-32: release + dispose blood effect pools (splatter decals, drips,
    // pools under corpses). All meshes are removed from the scene + their
    // geometries/materials disposed to avoid GPU memory leaks on unmount.
    for (const d of this.bloodDecals) {
      d.visible = false;
      (d.material as THREE.MeshBasicMaterial).opacity = 0;
      this.bloodDecalPool.release(d);
    }
    this.bloodDecals = [];
    this.bloodDecalPool.forEachAll((m) => {
      this.ctx.scene.remove(m);
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    });
    for (const d of this.activeBloodDrips) {
      d.mesh.visible = false;
      (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
      this.bloodDripPool.release(d.mesh);
    }
    this.activeBloodDrips = [];
    this.bloodDripPool.forEachAll((m) => {
      this.ctx.scene.remove(m);
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    });
    for (const p of this.activeBloodPools) {
      p.mesh.visible = false;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
      this.bloodPoolMeshPool.release(p.mesh);
      for (const sat of p.satellites) {
        sat.visible = false;
        (sat.material as THREE.MeshBasicMaterial).opacity = 0;
        this.bloodPoolMeshPool.release(sat);
      }
    }
    this.activeBloodPools = [];
    this.bloodPoolMeshPool.forEachAll((m) => {
      this.ctx.scene.remove(m);
      (m.material as THREE.Material).dispose();
      m.geometry.dispose();
    });
    // REALISM-1 (task B): release + dispose scope glint pool.
    for (const g of this.activeScopeGlints) {
      g.sprite.visible = false;
      (g.sprite.material as THREE.SpriteMaterial).opacity = 0;
      this.scopeGlintPool.release(g.sprite);
    }
    this.activeScopeGlints = [];
    this.scopeGlintPool.forEachAll((s) => {
      this.ctx.scene.remove(s);
      (s.material as THREE.Material).dispose();
    });
    this.ctx.particlePool.dispose();
  }
}
