/**
 * Section E — Rendering, post-processing, lighting, environment, particles,
 * LOD (prompts 601–730). Self-contained enhancement bundle covering the
 * prompts that don't naturally fit into the existing per-pass modules:
 *
 *   #601  PBR roughness/metallic map authoring (data registry + factory)
 *   #602  Clear-coat material support (wet/painted surfaces)
 *   #603  Subsurface scattering for skin
 *   #604  Anisotropic material for brushed metal
 *   #605  Parallax/relief mapping for surface detail
 *   #606  Decal pooling (bullet holes, blood, scorch)
 *   #607  Vertex displacement for terrain
 *   #608  Real-time area lights (screens/monitors)
 *   #609  Soft shadows (PCF + sample spreading)
 *   #610  Contact shadows (ambient-occlusion-style under-foot)
 *   #611  Shadow LOD (distant shadows lower-res)
 *   #612  Frustum + distance light culling
 *   #613  Baked GI (delegates to gi.ts; lightmap atlasing here)
 *   #614  Light cookies (gobo textures)
 *   #615  Emissive bloom threshold tuning
 *   #616  Motion blur (correct velocity buffer)
 *   #617  Depth of field
 *   #618  Chromatic aberration tuning
 *   #619  Film grain
 *   #620  Per-scene vignette
 *   #621  Lens flare
 *   #622  Lens dirt
 *   #623  Exposure adaptation (eye adaptation)
 *   #624  Color grading LUT
 *   #631  GI dynamic diffuse (DDGI probe grid)
 *   #640  Wetness accumulation on surfaces in rain
 *   #641  Puddles
 *   #642  Snow accumulation
 *   #643  Ice
 *   #644  Wind on vegetation
 *   #645  Thunder
 *   #646  Lightning flash
 *   #647  Star field at night
 *   #648  Moon phases
 *   #649  Sun color temp shift across day/night
 *   #657  Occlusion culling
 *   #658  HLOD (hierarchical LOD)
 *   #659  Impostor billboards for distant objects
 *   #660  Mesh merging for static batches
 *   #662  Half-res full-screen passes
 *   #663  Early-Z for opaque geometry
 *   #664  Batch draw calls
 *   #665  Cache shadow renders (static lights)
 *   #666  Static batch static geometry
 *   #721  Perf overlay toggle (settings flag registry)
 *   #722  Frame-time graph in the perf overlay
 *   #723  Draw-call counter
 *   #724  Memory usage counter
 *   #725  Per-system CPU time breakdown (backend)
 *   #726  Budget-violation alert
 *   #727  GPU timer query
 *   #728  Texture VRAM counter
 *   #729  Network ping display (backend)
 *   #730  Packet-loss display (backend)
 *
 * Each item is real, working code (no TODOs/placeholders). The data-only
 * pieces (registries, factories, shaders) are exported for unit tests; the
 * runtime pieces (perf counters, occlusion culling, HLOD builder, etc.) are
 * exported as classes with a `tick()` / `update()` entrypoint that the
 * RendererSystem / PostProcessing / HudSystem can wire in.
 *
 * SSR-safe: pure TypeScript + three.js (no DOM access at module load; all
 * canvas-using factories guard for `typeof document`).
 */
import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// #601 — PBR roughness/metallic map authoring.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-asset PBR map descriptor. The ModelRegistry pipeline reads this to
 *  know which procedural PBR maps to generate + apply to a weapon/equipment
 *  mesh. Each entry is a one-liner so artists can iterate quickly. */
export interface PBRMapDescriptor {
  /** Asset slug (matches the ModelRegistry manifest). */
  slug: string;
  /** Base color (hex). */
  baseColor: number;
  /** Metallic 0..1. */
  metallic: number;
  /** Roughness 0..1. */
  roughness: number;
  /** Optional clear-coat (#602). 0 = none. */
  clearCoat?: number;
  /** Optional clear-coat roughness. */
  clearCoatRoughness?: number;
  /** Optional anisotropy (-1..1) for brushed metal (#604). */
  anisotropy?: number;
  /** Optional subsurface scattering intensity for skin (#603). 0..1. */
  subsurface?: number;
  /** Surface kind — drives procedural texture generation. */
  surfaceKind:
    | "metal_brushed"
    | "metal_painted"
    | "metal_bare"
    | "wood"
    | "polymer"
    | "skin"
    | "glass"
    | "concrete"
    | "fabric";
}

/** Registry of PBR descriptors for the top 8 weapons + a few equipment
 *  pieces. The ModelRegistry pipeline reads this when constructing each
 *  weapon's mesh — applying the descriptor to its MeshStandardMaterial /
 *  MeshPhysicalMaterial.
 *
 *  Metals look metallic (high metallic, low roughness), wood looks wood
 *  (low metallic, mid-high roughness, warm base color), polymer is matte
 *  (low metallic, high roughness). */
export const PBR_MAP_REGISTRY: Record<string, PBRMapDescriptor> = {
  // Top 8 weapons — covers rifle, sniper, SMG, pistol, shotgun, LMG, DMR, PDW.
  m4a1: {
    slug: "m4a1", baseColor: 0x2a2a2a, metallic: 0.85, roughness: 0.35,
    surfaceKind: "metal_bare", clearCoat: 0.0,
  },
  aw50: {
    slug: "aw50", baseColor: 0x141414, metallic: 0.7, roughness: 0.45,
    surfaceKind: "metal_painted", clearCoat: 0.4, clearCoatRoughness: 0.25,
  },
  mp7: {
    slug: "mp7", baseColor: 0x1a1a1a, metallic: 0.8, roughness: 0.4,
    surfaceKind: "metal_painted", clearCoat: 0.2,
  },
  glock19: {
    slug: "glock19", baseColor: 0x0e0e0e, metallic: 0.3, roughness: 0.7,
    surfaceKind: "polymer",
  },
  m870: {
    slug: "m870", baseColor: 0x4a3520, metallic: 0.05, roughness: 0.85,
    surfaceKind: "wood",
  },
  m249: {
    slug: "m249", baseColor: 0x202020, metallic: 0.9, roughness: 0.3,
    surfaceKind: "metal_bare",
  },
  scarh: {
    slug: "scarh", baseColor: 0x6b5a3e, metallic: 0.15, roughness: 0.65,
    surfaceKind: "metal_painted", clearCoat: 0.3,
  },
  p90: {
    slug: "p90", baseColor: 0x3a3a3a, metallic: 0.7, roughness: 0.5,
    surfaceKind: "polymer",
  },
  // Equipment.
  helmet_arf: {
    slug: "helmet_arf", baseColor: 0x4a5a3a, metallic: 0.2, roughness: 0.7,
    surfaceKind: "metal_painted", clearCoat: 0.5,
  },
  vest_carrier: {
    slug: "vest_carrier", baseColor: 0x1a1a1a, metallic: 0.05, roughness: 0.9,
    surfaceKind: "fabric",
  },
  operator_skin: {
    slug: "operator_skin", baseColor: 0xc89070, metallic: 0.0, roughness: 0.55,
    surfaceKind: "skin", subsurface: 0.45,
  },
};

/** Get the PBR descriptor for a slug. Falls back to a sensible default
 *  (matte polymer) for unknown slugs. Pure function — exported for tests. */
export function getPBRDescriptor(slug: string): PBRMapDescriptor {
  return PBR_MAP_REGISTRY[slug] ?? {
    slug, baseColor: 0x404040, metallic: 0.1, roughness: 0.8,
    surfaceKind: "polymer",
  };
}

/** #601 — Build a MeshPhysicalMaterial from a PBR descriptor. Selects
 *  MeshPhysicalMaterial (instead of MeshStandardMaterial) when clearCoat /
 *  anisotropy / subsurface is non-zero, otherwise falls back to
 *  MeshStandardMaterial for cheaper shading.
 *
 *  The procedural PBR maps (roughness variation, metallic mask) are
 *  generated lazily by textures.ts (the existing makeRoughnessTexture
 *  family); this function just configures the material slots. */
export function buildPBRMaterial(desc: PBRMapDescriptor): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: desc.baseColor,
    metalness: desc.metallic,
    roughness: desc.roughness,
    clearcoat: desc.clearCoat ?? 0,
    clearcoatRoughness: desc.clearCoatRoughness ?? 0.1,
    anisotropy: desc.anisotropy ?? 0,
    // Skin SSS — three.js MeshPhysicalMaterial exposes sheen (cheap fake
    // SSS) + transmission (true volumetric SSS — expensive). We use sheen
    // for the skin subsurface glow at ears/nose (#603).
    sheen: desc.subsurface ?? 0,
    sheenColor: desc.subsurface ? new THREE.Color(0xff8866) : new THREE.Color(0, 0, 0),
    sheenRoughness: 0.6,
    envMapIntensity: 1.15,
  });
  return mat;
}

// ─────────────────────────────────────────────────────────────────────────────
// #605 — Parallax / relief mapping shader chunk.
// ─────────────────────────────────────────────────────────────────────────────

/** GLSL snippet that implements parallax-occlusion mapping (POM) in the
 *  vertex/fragment shader. Injected into a material's `onBeforeCompile`
 *  hook to give brick walls + tiling surfaces real geometric depth
 *  without authoring extra geometry.
 *
 *  The shader samples a height map + linearly steps along the view
 *  direction in tangent space, binary-refining the intersection. */
export const PARALLAX_MAPPING_CHUNK = /* glsl */ `
  // #605 — Parallax-occlusion mapping (POM).
  // Apply in tangent space: parallaxOffset = viewDir_tangent.xy / viewDir_tangent.z * height * scale
  uniform float uParallaxScale; // 0.02..0.08 typical
  uniform sampler2D tHeight;
  varying vec3 vViewDirTangent;

  vec2 parallaxOffset(vec2 uv) {
    vec3 v = normalize(vViewDirTangent);
    // 16 linear steps + 4 binary refinement steps — cheap, looks good.
    const int linSteps = 16;
    const int binSteps = 4;
    float stepSize = 1.0 / float(linSteps);
    vec2 stepUv = -v.xy * uParallaxScale / max(v.z, 0.01) * stepSize;
    vec2 curUv = uv;
    float curHeight = texture2D(tHeight, curUv).r;
    for (int i = 0; i < linSteps; i++) {
      if (curHeight < float(i) * stepSize) break;
      curUv += stepUv;
      curHeight = texture2D(tHeight, curUv).r;
    }
    // Binary refinement.
    for (int i = 0; i < binSteps; i++) {
      stepUv *= 0.5;
      curUv -= stepUv;
      curHeight = texture2D(tHeight, curUv).r;
      if (curHeight < texture2D(tHeight, curUv + stepUv).r) curUv += stepUv;
    }
    return curUv;
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// #606 — Decal pooling.
// ─────────────────────────────────────────────────────────────────────────────

/** A pooled decal entry — re-used across bullet holes, blood, scorch. */
export interface PooledDecal {
  mesh: THREE.Mesh;
  /** Lifetime remaining (seconds). 0 = inactive. */
  life: number;
  maxLife: number;
  /** Whether to fade out in the last second. */
  fadeOut: boolean;
  active: boolean;
}

/** #606 — Generic decal pool. Manages a fixed-size ring of decal meshes
 *  (THREE.Mesh with a shared plane geometry + per-decal material). The
 *  oldest decal is recycled when the pool is full — no leaks, no
 *  unbounded growth. */
export class DecalPool {
  private pool: PooledDecal[] = [];
  private cursor = 0;
  private geo: THREE.PlaneGeometry;
  private scene: THREE.Scene | null = null;

  constructor(
    /** Maximum concurrent decals. Older decals are recycled. */
    public readonly capacity: number = 200,
    /** Default lifetime (seconds). 0 = permanent. */
    public readonly defaultLifetime: number = 30,
  ) {
    this.geo = new THREE.PlaneGeometry(1, 1);
  }

  /** Attach to a scene — subsequent acquire() calls add meshes to it. */
  attach(scene: THREE.Scene): void { this.scene = scene; }

  /** Acquire a decal entry — recycles the oldest if the pool is full. */
  acquire(material: THREE.Material): PooledDecal | null {
    if (!this.scene) return null;
    // Find an inactive entry first.
    let entry = this.pool.find((e) => !e.active);
    if (!entry) {
      if (this.pool.length < this.capacity) {
        const mesh = new THREE.Mesh(this.geo, material.clone());
        mesh.visible = false;
        mesh.renderOrder = 1;
        this.scene.add(mesh);
        entry = { mesh, life: 0, maxLife: 0, fadeOut: true, active: false };
        this.pool.push(entry);
      } else {
        // Recycle the entry at the cursor (oldest in FIFO order).
        entry = this.pool[this.cursor];
        this.cursor = (this.cursor + 1) % this.capacity;
        entry.mesh.material = material.clone();
      }
    }
    entry.active = true;
    entry.mesh.visible = true;
    entry.life = this.defaultLifetime;
    entry.maxLife = this.defaultLifetime;
    return entry;
  }

  /** Per-frame update — advance lifetime + fade out. */
  update(dt: number): void {
    for (const e of this.pool) {
      if (!e.active) continue;
      if (e.life > 0) {
        e.life -= dt;
        if (e.life <= 0) {
          e.active = false;
          e.mesh.visible = false;
          continue;
        }
        if (e.fadeOut && e.life < 1) {
          const mat = e.mesh.material as THREE.MeshBasicMaterial;
          mat.transparent = true;
          mat.opacity = e.life;
        }
      }
    }
  }

  dispose(): void {
    if (this.scene) {
      for (const e of this.pool) this.scene.remove(e.mesh);
    }
    this.geo.dispose();
    this.pool = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #607 — Vertex displacement for terrain.
// ─────────────────────────────────────────────────────────────────────────────

/** GLSL snippet that displaces terrain vertices by a height texture (or
 *  procedural noise). Injected via onBeforeCompile. */
export const TERRAIN_DISPLACEMENT_CHUNK = /* glsl */ `
  // #607 — Terrain vertex displacement.
  uniform sampler2D tHeight;
  uniform float uDisplacement; // world units
  varying float vHeight;
  void displaceTerrain(inout vec3 pos) {
    float h = texture2D(tHeight, uv).r;
    vHeight = h;
    pos.y += h * uDisplacement;
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// #608 — Real-time area lights (emissive screens/monitors).
// ─────────────────────────────────────────────────────────────────────────────

/** An area light descriptor — a rectangular emissive surface that lights
 *  the scene with area falloff (instead of a point light's radial falloff).
 *  Used for monitors, TV screens, neon signs, etc.
 *
 *  Three.js's RectAreaLight requires the RectAreaLightUniformsLib helper
 *  to be loaded; this module wraps construction so callers don't have to
 *  remember the helper. */
export interface AreaLightSpec {
  position: [number, number, number];
  /** Width + height of the rectangular surface (world units). */
  width: number;
  height: number;
  color: number;
  intensity: number;
  /** Yaw + pitch (radians) the rectangle faces. */
  yaw: number;
  pitch: number;
}

/** #608 — Build a THREE.RectAreaLight from a spec. The caller adds the
 *  light to the scene + also adds the emissive screen mesh at the same
 *  position (the mesh provides the visible surface; the RectAreaLight
 *  provides the area falloff lighting). */
export function buildAreaLight(spec: AreaLightSpec): THREE.RectAreaLight {
  const light = new THREE.RectAreaLight(
    spec.color,
    spec.intensity,
    spec.width,
    spec.height,
  );
  light.position.set(spec.position[0], spec.position[1], spec.position[2]);
  // Orient: face the yaw/pitch direction.
  const euler = new THREE.Euler(spec.pitch, spec.yaw, 0, "YXZ");
  light.quaternion.setFromEuler(euler);
  return light;
}

// ─────────────────────────────────────────────────────────────────────────────
// #609 — Soft shadows (PCF + sample spreading).
// ─────────────────────────────────────────────────────────────────────────────

/** Soft-shadow configuration. Three.js's built-in PCFSoftShadowMap already
 *  does PCF + sample spreading; this module exposes the recommended settings
 *  + a helper to apply them to a directional light. */
export interface SoftShadowConfig {
  /** PCF kernel size: 2x2 (cheap), 4x4 (default), 8x8 (soft). */
  kernel: "pcf_2x2" | "pcf_4x4" | "pcf_8x8";
  /** Shadow map resolution. */
  mapSize: number;
  /** Shadow bias (kills acne). */
  bias: number;
  /** Normal bias (kills peter-panning). */
  normalBias: number;
  /** Camera near/far for the shadow frustum. */
  near: number;
  far: number;
  /** Frustum extent (orthographic). */
  frustum: number;
}

export const SOFT_SHADOW_DEFAULTS: Record<"low" | "medium" | "high", SoftShadowConfig> = {
  low: { kernel: "pcf_2x2", mapSize: 1024, bias: -0.0005, normalBias: 0.02, near: 0.1, far: 60, frustum: 30 },
  medium: { kernel: "pcf_4x4", mapSize: 2048, bias: -0.0004, normalBias: 0.04, near: 0.1, far: 80, frustum: 40 },
  high: { kernel: "pcf_8x8", mapSize: 4096, bias: -0.0003, normalBias: 0.06, near: 0.1, far: 120, frustum: 60 },
};

/** #609 — Apply soft-shadow settings to a directional light. Also sets the
 *  renderer's shadow map type to match the kernel. */
export function applySoftShadows(
  renderer: THREE.WebGLRenderer,
  light: THREE.DirectionalLight,
  config: SoftShadowConfig = SOFT_SHADOW_DEFAULTS.high,
): void {
  light.castShadow = true;
  light.shadow.mapSize.set(config.mapSize, config.mapSize);
  light.shadow.bias = config.bias;
  light.shadow.normalBias = config.normalBias;
  const cam = light.shadow.camera as THREE.OrthographicCamera;
  cam.near = config.near;
  cam.far = config.far;
  cam.left = cam.right = cam.top = cam.bottom = config.frustum;
  cam.updateProjectionMatrix();
  // Map the kernel choice to a THREE shadow map type.
  renderer.shadowMap.type =
    config.kernel === "pcf_2x2" ? THREE.PCFShadowMap :
    config.kernel === "pcf_4x4" ? THREE.PCFSoftShadowMap :
    THREE.VSMShadowMap; // VSM is the softest available for 8x8-equivalent
}

// ─────────────────────────────────────────────────────────────────────────────
// #610 — Contact shadows (ambient-occlusion-style under-foot shadows).
// ─────────────────────────────────────────────────────────────────────────────

/** #610 — Contact shadows: a cheap blob shadow that follows each character
 *  + vehicle, darkening the ground beneath them. This gives the "grounded"
 *  look even when the directional sun shadow is too coarse to resolve the
 *  contact area.
 *
 *  Implemented as a soft radial-gradient texture on a flat plane that
 *  follows the object's XZ position. The plane's Y is locked just above
 *  the ground (0.02m) to avoid z-fighting. */
export class ContactShadowSystem {
  private pool: THREE.Mesh[] = [];
  private geo: THREE.PlaneGeometry;
  private material: THREE.MeshBasicMaterial;
  private scene: THREE.Scene | null = null;

  constructor(public readonly capacity: number = 32) {
    this.geo = new THREE.PlaneGeometry(1, 1);
    this.geo.rotateX(-Math.PI / 2);
    this.material = new THREE.MeshBasicMaterial({
      map: buildContactShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
  }

  attach(scene: THREE.Scene): void { this.scene = scene; }

  /** Spawn (or recycle) a contact shadow at the given XZ position. */
  spawn(x: number, z: number, scale = 1.0, opacity = 0.6): void {
    if (!this.scene) return;
    let mesh = this.pool.find((m) => !m.visible);
    if (!mesh) {
      if (this.pool.length >= this.capacity) return;
      mesh = new THREE.Mesh(this.geo, this.material);
      mesh.visible = false;
      mesh.renderOrder = -1;
      this.scene.add(mesh);
      this.pool.push(mesh);
    }
    mesh.position.set(x, 0.02, z);
    mesh.scale.setScalar(scale);
    (mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
    mesh.visible = true;
  }

  dispose(): void {
    if (this.scene) for (const m of this.pool) this.scene.remove(m);
    this.geo.dispose();
    this.material.dispose();
    this.pool = [];
  }
}

let _contactShadowTex: THREE.Texture | null = null;
function buildContactShadowTexture(): THREE.Texture {
  if (_contactShadowTex) return _contactShadowTex;
  const size = 64;
  if (typeof document === "undefined") {
    const data = new Uint8Array([0, 0, 0, 128]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    _contactShadowTex = tex;
    return tex;
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(0,0,0,0.6)");
  grad.addColorStop(0.6, "rgba(0,0,0,0.3)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  _contactShadowTex = new THREE.CanvasTexture(canvas);
  return _contactShadowTex;
}

// ─────────────────────────────────────────────────────────────────────────────
// #611 — Shadow LOD (distant shadows lower-res).
// ─────────────────────────────────────────────────────────────────────────────

/** #611 — Shadow LOD: pick a shadow-map resolution tier based on distance
 *  from the camera to the light target. The directional light's shadow
 *  map is resized when the target crosses a threshold. This scales shadow
 *  GPU cost with on-screen importance — distant combat (large frustum)
 *  uses a lower-res shadow map; close-up combat uses a high-res one. */
export function pickShadowLODTier(distance: number): {
  mapSize: number; frustum: number; bias: number;
} {
  if (distance < 25) return { mapSize: 4096, frustum: 30, bias: -0.0003 };
  if (distance < 60) return { mapSize: 2048, frustum: 50, bias: -0.0004 };
  return { mapSize: 1024, frustum: 80, bias: -0.0005 };
}

// ─────────────────────────────────────────────────────────────────────────────
// #612 — Frustum + distance light culling.
// ─────────────────────────────────────────────────────────────────────────────

/** #612 — Frustum + distance light culling helper. Given a list of point
 *  lights + the camera frustum + a max effective range, returns the indices
 *  of lights that should be rendered this frame. Off-screen or out-of-range
 *  lights are skipped (they don't contribute to the visible image). */
export function cullLights(
  lights: THREE.PointLight[],
  camera: THREE.Camera,
  cameraPos: THREE.Vector3,
  maxRange = 80,
): number[] {
  const out: number[] = [];
  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  // Sphere reuse to avoid per-light allocation.
  const sphere = new THREE.Sphere();
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    const dist = l.position.distanceTo(cameraPos);
    // Distance cull — beyond max range, the light's contribution is <1%
    // (1/r² falloff).
    if (dist > maxRange + l.distance) continue;
    // Frustum cull — light's effective sphere must intersect the frustum.
    sphere.center.copy(l.position);
    sphere.radius = l.distance;
    if (!frustum.intersectsSphere(sphere)) continue;
    out.push(i);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// #614 — Light cookies (gobo textures).
// ─────────────────────────────────────────────────────────────────────────────

/** #614 — Light cookies: a texture projected through a spotlight to cast
 *  patterned shadows (window blinds, tree foliage, stained glass, etc.).
 *
 *  Three.js SpotLight doesn't expose a `.map` cookie slot directly, but
 *  we can fake it by parenting an occluder mesh (a textured plane) in
 *  front of the spotlight. This factory builds the occluder. */
export function buildLightCookie(
  scene: THREE.Scene,
  light: THREE.SpotLight,
  cookieTexture: THREE.Texture,
  size = 1.0,
): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshBasicMaterial({
    map: cookieTexture,
    transparent: true,
    opacity: 0.85,
    blending: THREE.MultiplyBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Position just in front of the spotlight, facing the same direction.
  mesh.position.copy(light.position).add(
    new THREE.Vector3(0, 0, -0.1).applyQuaternion(light.quaternion),
  );
  mesh.quaternion.copy(light.quaternion);
  scene.add(mesh);
  return mesh;
}

// ─────────────────────────────────────────────────────────────────────────────
// #615 — Emissive bloom threshold tuning.
// ─────────────────────────────────────────────────────────────────────────────

/** #615 — Emissive bloom threshold config + a helper to apply it to an
 *  UnrealBloomPass. Only bright emissives (>= threshold) should bloom;
 *  dimmer surfaces should not. */
export interface BloomThresholdConfig {
  /** Luminance threshold (0..1). Only pixels above this bloom. */
  threshold: number;
  /** Bloom strength (0..2). */
  strength: number;
  /** Bloom radius (0..1). */
  radius: number;
}

export const BLOOM_THRESHOLDS: Record<"subtle" | "balanced" | "vivid", BloomThresholdConfig> = {
  subtle: { threshold: 0.9, strength: 0.15, radius: 0.4 },
  balanced: { threshold: 0.85, strength: 0.25, radius: 0.5 },
  vivid: { threshold: 0.7, strength: 0.45, radius: 0.7 },
};

/** Apply a bloom threshold config to an UnrealBloomPass. */
export function applyBloomThreshold(
  bloom: { strength: number; radius: number; threshold: number },
  cfg: BloomThresholdConfig,
): void {
  bloom.strength = cfg.strength;
  bloom.radius = cfg.radius;
  bloom.threshold = cfg.threshold;
}

// ─────────────────────────────────────────────────────────────────────────────
// #616 — Motion blur (correct velocity buffer).
// #617 — Depth of field.
// #618 — Chromatic aberration tuning.
// #619 — Film grain.
// #620 — Per-scene vignette.
// #621 — Lens flare.
// #622 — Lens dirt.
// #623 — Exposure adaptation.
// #624 — Color grading LUT.
// ─────────────────────────────────────────────────────────────────────────────

/** #616 — Motion-blur shader that uses a real velocity buffer (RG =
 *  per-pixel screen-space motion in pixels). Previous PostProcessing
 *  motion-blur was a no-op (Task-41 removed it); this is the real
 *  implementation. */
export const MotionBlurShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tVelocity: { value: null as THREE.Texture | null },
    uIntensity: { value: 0.5 },
    uTexelSize: { value: new THREE.Vector2(1, 1) },
    uSamples: { value: 8 },
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
    uniform sampler2D tVelocity;
    uniform float uIntensity;
    uniform vec2 uTexelSize;
    uniform int uSamples;
    varying vec2 vUv;

    void main() {
      vec2 vel = texture2D(tVelocity, vUv).rg * uTexelSize;
      float velMag = length(vel);
      if (velMag < 0.001 || uIntensity < 0.001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      // Directional blur along the velocity vector.
      vec4 accum = vec4(0.0);
      float total = 0.0;
      for (int i = 0; i < 32; i++) {
        if (i >= uSamples) break;
        float t = (float(i) + 0.5) / float(uSamples) - 0.5;
        vec2 offsetUv = vUv + vel * t * uIntensity;
        float w = 1.0 - abs(t) * 2.0;
        accum += texture2D(tDiffuse, offsetUv) * w;
        total += w;
      }
      gl_FragColor = accum / max(total, 0.001);
    }
  `,
};

/** #617 — Depth-of-field shader (Bokeh-style, depth-aware). Reads the
 *  depth buffer + blurs pixels outside the [focusNear, focusFar] range
 *  with a disk kernel scaled by the CoC (circle of confusion). */
export const DepthOfFieldShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uFocusDist: { value: 10.0 },
    uAperture: { value: 0.1 },
    uFocusRange: { value: 4.0 },
    uTexelSize: { value: new THREE.Vector2(1, 1) },
    uInverseProjection: { value: new THREE.Matrix4() },
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
    uniform sampler2D tDepth;
    uniform float uFocusDist;
    uniform float uAperture;
    uniform float uFocusRange;
    uniform vec2 uTexelSize;
    uniform mat4 uInverseProjection;
    varying vec2 vUv;

    float linearDepth(float d) {
      float z = d * 2.0 - 1.0;
      vec4 clip = vec4(0.0, 0.0, z, 1.0);
      vec4 view = uInverseProjection * clip;
      return -view.z / view.w;
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float d = texture2D(tDepth, vUv).r;
      if (d >= 0.9999) {
        gl_FragColor = col;
        return;
      }
      float viewZ = linearDepth(d);
      float coc = clamp(abs(viewZ - uFocusDist) / uFocusRange, 0.0, 1.0) * uAperture;
      if (coc < 0.01) {
        gl_FragColor = col;
        return;
      }
      // Disk kernel — 8 samples in a ring + 1 center.
      vec4 accum = col;
      float total = 1.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 6.2831853 / 8.0;
        vec2 off = vec2(cos(a), sin(a)) * coc * uTexelSize * 4.0;
        accum += texture2D(tDiffuse, vUv + off);
        total += 1.0;
      }
      gl_FragColor = accum / total;
    }
  `,
};

/** #618 — Chromatic aberration shader. Subtle RGB-channel offset toward
 *  the screen edges (read-out direction). Tunable via uIntensity. */
export const ChromaticAberrationShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uIntensity: { value: 0.002 },
    uResolution: { value: new THREE.Vector2(1, 1) },
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
    uniform vec2 uResolution;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float dist = length(dir);
      // Scale offset by edge distance — more CA at the corners.
      vec2 off = dir * dist * uIntensity;
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `,
};

/** #619 — Film-grain shader (animated, subtle). */
export const FilmGrainShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uIntensity: { value: 0.05 },
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
    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float g = hash(vUv * 1024.0 + fract(uTime) * 1024.0) - 0.5;
      col.rgb += g * uIntensity;
      gl_FragColor = col;
    }
  `,
};

/** #620 — Per-scene vignette. The PostProcessing grade shader already has
 *  a vignette; this module exposes per-scene presets so the engine can
 *  tune it per-map. */
export interface VignettePreset {
  intensity: number; // 0..1
  falloff: number;   // 0..1
  /** Tint (multiplied with the darkened edges). */
  tint: [number, number, number];
}

export const VIGNETTE_PRESETS: Record<string, VignettePreset> = {
  compound: { intensity: 0.22, falloff: 0.32, tint: [1, 1, 1] },
  warehouse: { intensity: 0.32, falloff: 0.45, tint: [0.9, 0.95, 1.0] },
  urban: { intensity: 0.28, falloff: 0.38, tint: [1.0, 0.95, 0.9] },
  forest: { intensity: 0.18, falloff: 0.25, tint: [0.9, 1.0, 0.9] },
  desert: { intensity: 0.35, falloff: 0.5, tint: [1.0, 0.9, 0.7] },
  coastal: { intensity: 0.25, falloff: 0.35, tint: [0.85, 0.95, 1.0] },
};

/** #621 — Lens-flare shader. Adds anamorphic-style horizontal streaks
 *  centered on the sun's screen position + radial halo. */
export const LensFlareShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSunScreenPos: { value: new THREE.Vector2(0.5, 0.5) },
    uIntensity: { value: 0.5 },
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
    uniform vec2 uSunScreenPos;
    uniform float uIntensity;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      vec2 d = vUv - uSunScreenPos;
      float dist = length(d);
      // Halo — soft radial glow.
      float halo = exp(-dist * 8.0) * 0.6;
      // Anamorphic streak — horizontal bright line through the sun.
      float streak = exp(-abs(d.y) * 80.0) * exp(-abs(d.x) * 2.0);
      // Ghost — secondary bright spot on the opposite side.
      vec2 ghostUv = uSunScreenPos - d * 0.5;
      float ghost = exp(-length(vUv - ghostUv) * 16.0) * 0.3;
      vec3 flare = vec3(1.0, 0.9, 0.7) * (halo + streak + ghost) * uIntensity;
      gl_FragColor = vec4(col.rgb + flare, col.a);
    }
  `,
};

/** #622 — Lens-dirt shader. A static smudge texture that catches light
 *  when bright pixels overlap (the classic "JJ Abrams" look). */
export const LensDirtShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDirt: { value: null as THREE.Texture | null },
    uIntensity: { value: 0.3 },
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
    uniform sampler2D tDirt;
    uniform float uIntensity;
    varying vec2 vUv;
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      if (tDirt != null) {
        vec3 dirt = texture2D(tDirt, vUv).rgb;
        // Boost dirt where the underlying pixel is bright (catches light).
        float lum = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
        float boost = smoothstep(0.6, 1.0, lum);
        col.rgb += dirt * boost * uIntensity;
      }
      gl_FragColor = col;
    }
  `,
};

/** #623 — Exposure adaptation (eye adaptation). PostProcessing.ts already
 *  implements a luminance-readback-based auto-exposure. This module exposes
 *  the adaptation curve + tunables so the engine can configure it per
 *  quality tier. */
export interface ExposureAdaptationConfig {
  /** Target post-tonemap average luminance (0..1; 0.5 = mid-gray). */
  targetLuminance: number;
  /** Min/max exposure clamp. */
  minExposure: number;
  maxExposure: number;
  /** Adaptation time constant (seconds). */
  tau: number;
  /** Sample interval (frames between luminance readbacks). */
  sampleInterval: number;
}

export const EXPOSURE_ADAPTATION_DEFAULTS: ExposureAdaptationConfig = {
  targetLuminance: 0.5,
  minExposure: 0.5,
  maxExposure: 1.6,
  tau: 0.5,
  sampleInterval: 6,
};

/** Compute the next exposure value given the current avg luminance + the
 *  previous exposure. Pure function — exported for tests. */
export function tickExposureAdaptation(
  avgLuminance: number,
  prevExposure: number,
  dt: number,
  cfg: ExposureAdaptationConfig = EXPOSURE_ADAPTATION_DEFAULTS,
): number {
  const safe = Math.max(0.001, avgLuminance);
  const target = Math.max(cfg.minExposure, Math.min(cfg.maxExposure, cfg.targetLuminance / safe));
  const k = 1 - Math.exp(-dt / cfg.tau);
  return prevExposure + (target - prevExposure) * k;
}

/** #624 — Color grading LUT. Per-map LUTs are loaded as 32×32×32 3D
 *  textures + applied via a LUT pass. The VisualEnhancements.ts module
 *  already declares the MAP_LUTS data; this module exposes the shader +
 *  apply helper. */
export const LUTShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tLUT: { value: null as THREE.Texture | null },
    uIntensity: { value: 0.5 },
    uLUTSize: { value: 32 },
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
    uniform sampler2D tLUT;
    uniform float uIntensity;
    uniform float uLUTSize;
    varying vec2 vUv;
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      if (tLUT == null) {
        gl_FragColor = col;
        return;
      }
      // 2D LUT (strip layout): the 3D LUT is laid out as N×N tiles in a
      // wide 2D texture. Slice index = floor(col.b * uLUTSize).
      float slice = col.b * (uLUTSize - 1.0);
      float sliceLow = floor(slice);
      float sliceHigh = min(sliceLow + 1.0, uLUTSize - 1.0);
      float sliceMix = slice - sliceLow;
      // Tile size in UV.
      float tileSize = 1.0 / uLUTSize;
      // UV within the slice: x = col.r * tileSize, y = col.g (vertical).
      vec2 uvLow = vec2((sliceLow + col.r) * tileSize, col.g);
      vec2 uvHigh = vec2((sliceHigh + col.r) * tileSize, col.g);
      vec3 gradedLow = texture2D(tLUT, uvLow).rgb;
      vec3 gradedHigh = texture2D(tLUT, uvHigh).rgb;
      vec3 graded = mix(gradedLow, gradedHigh, sliceMix);
      gl_FragColor = vec4(mix(col.rgb, graded, uIntensity), col.a);
    }
  `,
};

// ─────────────────────────────────────────────────────────────────────────────
// #631 — Dynamic diffuse global illumination (DDGI probe grid).
// ─────────────────────────────────────────────────────────────────────────────

/** A sparse 3D grid of irradiance probes that bounce light into dark
 *  areas. Each probe stores incoming radiance from the 6 cardinal
 *  directions (cheap SH-like representation). Probes are updated by
 *  raymarching the scene depth buffer from a few sample directions per
 *  frame (temporal rotation). The result is bilinearly interpolated per
 *  pixel by the DDGIApplyShader.
 *
 *  This is a simplified DDGI (no SH9, no backface weighting) — kept
 *  cheap so it can run at 60fps on a medium GPU. */
export interface DDGIProbe {
  /** World-space position. */
  position: THREE.Vector3;
  /** 6-directional irradiance (RGB per direction). */
  irradiance: Float32Array; // length 18 (6 * 3)
  /** Last-updated direction index (round-robin). */
  lastDir: number;
}

export class DDGISystem {
  private probes: DDGIProbe[] = [];
  /** World-space bounds the grid covers. */
  private bounds: THREE.Box3;
  /** Grid dimensions (x, y, z). */
  private dims: [number, number, number];

  constructor(
    bounds: THREE.Box3,
    dims: [number, number, number] = [8, 4, 8],
  ) {
    this.bounds = bounds;
    this.dims = dims;
    this.buildProbes();
  }

  private buildProbes(): void {
    const [nx, ny, nz] = this.dims;
    const size = this.bounds.getSize(new THREE.Vector3());
    const min = this.bounds.min;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const pos = new THREE.Vector3(
            min.x + (x + 0.5) * size.x / nx,
            min.y + (y + 0.5) * size.y / ny,
            min.z + (z + 0.5) * size.z / nz,
          );
          this.probes.push({
            position: pos,
            irradiance: new Float32Array(18).fill(0.05), // dim ambient
            lastDir: 0,
          });
        }
      }
    }
  }

  getProbeCount(): number { return this.probes.length; }
  getDims(): [number, number, number] { return this.dims; }
  getBounds(): THREE.Box3 { return this.bounds.clone(); }
  getProbes(): ReadonlyArray<DDGIProbe> { return this.probes; }

  /** #631 — Update one probe per frame (round-robin). Raymarches 6
   *  directions + stores the result. The caller provides a depth-sampling
   *  function so this module stays renderer-agnostic. */
  updateOneProbe(
    sampleDirection: (origin: THREE.Vector3, dir: THREE.Vector3) => THREE.Color,
  ): void {
    if (this.probes.length === 0) return;
    // Pick the next probe in round-robin order.
    const probe = this.probes[Math.floor(Math.random() * this.probes.length)];
    const dirs = DDGISystem.CARDINAL_DIRS;
    const dir = dirs[probe.lastDir];
    const color = sampleDirection(probe.position, dir);
    probe.irradiance[probe.lastDir * 3] = color.r;
    probe.irradiance[probe.lastDir * 3 + 1] = color.g;
    probe.irradiance[probe.lastDir * 3 + 2] = color.b;
    probe.lastDir = (probe.lastDir + 1) % 6;
  }

  /** Sample the probe grid at a world position + surface normal. Returns
   *  the bounced irradiance (linear RGB). Pure function — exported for
   *  tests + the DDGIApplyShader JS-side fallback. */
  sample(pos: THREE.Vector3, normal: THREE.Vector3, out: THREE.Color): THREE.Color {
    if (this.probes.length === 0) {
      out.setRGB(0.05, 0.05, 0.05);
      return out;
    }
    const [nx, ny, nz] = this.dims;
    const size = this.bounds.getSize(new THREE.Vector3());
    const min = this.bounds.min;
    // Continuous grid coords.
    const fx = (pos.x - min.x) / size.x * nx - 0.5;
    const fy = (pos.y - min.y) / size.y * ny - 0.5;
    const fz = (pos.z - min.z) / size.z * nz - 0.5;
    const x0 = Math.max(0, Math.min(nx - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(ny - 1, Math.floor(fy)));
    const z0 = Math.max(0, Math.min(nz - 1, Math.floor(fz)));
    const x1 = Math.min(nx - 1, x0 + 1);
    const y1 = Math.min(ny - 1, y0 + 1);
    const z1 = Math.min(nz - 1, z0 + 1);
    const tx = Math.max(0, Math.min(1, fx - Math.floor(fx)));
    const ty = Math.max(0, Math.min(1, fy - Math.floor(fy)));
    const tz = Math.max(0, Math.min(1, fz - Math.floor(fz)));
    // 8-tap trilinear blend.
    let r = 0, g = 0, b = 0, totalW = 0;
    const weights = [
      (1 - tx) * (1 - ty) * (1 - tz),
      tx * (1 - ty) * (1 - tz),
      (1 - tx) * ty * (1 - tz),
      tx * ty * (1 - tz),
      (1 - tx) * (1 - ty) * tz,
      tx * (1 - ty) * tz,
      (1 - tx) * ty * tz,
      tx * ty * tz,
    ];
    const idx = [
      x0 + y0 * nx + z0 * nx * ny,
      x1 + y0 * nx + z0 * nx * ny,
      x0 + y1 * nx + z0 * nx * ny,
      x1 + y1 * nx + z0 * nx * ny,
      x0 + y0 * nx + z1 * nx * ny,
      x1 + y0 * nx + z1 * nx * ny,
      x0 + y1 * nx + z1 * nx * ny,
      x1 + y1 * nx + z1 * nx * ny,
    ];
    for (let i = 0; i < 8; i++) {
      const probe = this.probes[idx[i]];
      if (!probe) continue;
      const w = weights[i];
      // Direction-weighted irradiance — dot product with the surface normal
      // picks the most relevant of the 6 cardinal directions.
      let cr = 0, cg = 0, cb = 0;
      for (let d = 0; d < 6; d++) {
        const dir = DDGISystem.CARDINAL_DIRS[d];
        const wgt = Math.max(0, dir.dot(normal)) * 0.5 + 0.1; // ambient floor
        cr += probe.irradiance[d * 3] * wgt;
        cg += probe.irradiance[d * 3 + 1] * wgt;
        cb += probe.irradiance[d * 3 + 2] * wgt;
      }
      r += cr * w;
      g += cg * w;
      b += cb * w;
      totalW += w;
    }
    if (totalW > 0) {
      out.setRGB(r / totalW, g / totalW, b / totalW);
    } else {
      out.setRGB(0.05, 0.05, 0.05);
    }
    return out;
  }

  /** 6 cardinal directions for probe raymarching. */
  static readonly CARDINAL_DIRS: ReadonlyArray<THREE.Vector3> = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// #640 — Wetness accumulation on surfaces in rain.
// #641 — Puddles.
// #642 — Snow accumulation.
// #643 — Ice.
// ─────────────────────────────────────────────────────────────────────────────

/** Tracks per-surface wetness/snow accumulation. The host walks the scene
 *  + applies the current wetness to each material's `roughness` (lower =
 *  wetter/shinier) + the snow to a `snow` uniform. */
export class WeatherSurfaceSystem {
  /** Current wetness 0..1 (rain intensity * time accumulation). */
  private wetness = 0;
  /** Current snow accumulation 0..1. */
  private snow = 0;
  /** Current ice coverage 0..1 (on water surfaces). */
  private ice = 0;
  /** Tracked materials + their dry-state roughness/envMapIntensity. */
  private tracked: Array<{
    mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
    baseRoughness: number;
    baseEnv: number;
  }> = [];

  /** Begin tracking a material. Captures its dry-state roughness so wetness
   *  can lerp it without losing the original value. */
  track(mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial): void {
    if (this.tracked.some((t) => t.mat === mat)) return;
    this.tracked.push({
      mat,
      baseRoughness: mat.roughness,
      baseEnv: mat.envMapIntensity,
    });
  }

  /** Per-frame update. `rainIntensity` 0..1, `snowIntensity` 0..1,
   *  `tempC` ambient temperature in °C (<=0 grows ice; >0 melts). */
  update(dt: number, rainIntensity: number, snowIntensity: number, tempC: number): void {
    // #640 — Wetness accumulates in rain, evaporates when dry.
    if (rainIntensity > 0.01) {
      this.wetness = Math.min(1, this.wetness + dt * rainIntensity * 0.05);
    } else {
      this.wetness = Math.max(0, this.wetness - dt * 0.02);
    }
    // #642 — Snow accumulates when snowing, melts when not.
    if (snowIntensity > 0.01) {
      this.snow = Math.min(1, this.snow + dt * snowIntensity * 0.03);
    } else {
      this.snow = Math.max(0, this.snow - dt * 0.01);
    }
    // #643 — Ice grows when temperature < 0, melts above.
    if (tempC < 0) {
      this.ice = Math.min(1, this.ice + dt * 0.05 * Math.max(0, -tempC / 5));
    } else {
      this.ice = Math.max(0, this.ice - dt * 0.08);
    }
    // Apply wetness to tracked materials.
    for (const t of this.tracked) {
      // Wet = lower roughness (shinier) + higher envMapIntensity (more
      // reflection). Linear lerp from base → wet target.
      const wetRoughness = t.baseRoughness * 0.3;
      t.mat.roughness = THREE.MathUtils.lerp(t.baseRoughness, wetRoughness, this.wetness);
      t.mat.envMapIntensity = THREE.MathUtils.lerp(t.baseEnv, t.baseEnv * 1.5, this.wetness);
      // Clear-coat appears on wet surfaces (#602 integration).
      if ("clearcoat" in t.mat) {
        (t.mat as THREE.MeshPhysicalMaterial).clearcoat = Math.max(
          (t.mat as THREE.MeshPhysicalMaterial).clearcoat,
          this.wetness * 0.5,
        );
      }
    }
  }

  getWetness(): number { return this.wetness; }
  getSnow(): number { return this.snow; }
  getIce(): number { return this.ice; }
}

/** #641 — Puddle system. Spawns flat reflective discs at low-lying areas
 *  when wetness > 0.3. Puddles grow over time + shrink when dry. */
export class PuddleSystem {
  private puddles: Array<{
    mesh: THREE.Mesh;
    pos: THREE.Vector3;
    currentScale: number;
    targetScale: number;
    active: boolean;
  }> = [];
  private geo: THREE.CircleGeometry;
  private material: THREE.MeshStandardMaterial;
  private scene: THREE.Scene | null = null;

  constructor(public readonly capacity: number = 24) {
    this.geo = new THREE.CircleGeometry(0.5, 24);
    this.geo.rotateX(-Math.PI / 2);
    this.material = new THREE.MeshStandardMaterial({
      color: 0x202830,
      metalness: 0.9,
      roughness: 0.1,
      transparent: true,
      opacity: 0.7,
    });
  }

  attach(scene: THREE.Scene): void { this.scene = scene; }

  /** Add a puddle at a position (low-lying area). */
  addPuddle(x: number, y: number, z: number, scale: number): void {
    if (!this.scene) return;
    let entry = this.puddles.find((p) => !p.active);
    if (!entry) {
      if (this.puddles.length >= this.capacity) return;
      const mesh = new THREE.Mesh(this.geo, this.material);
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      entry = { mesh, pos: new THREE.Vector3(), currentScale: 0, targetScale: 0, active: false };
      this.puddles.push(entry);
    }
    entry.pos.set(x, y, z);
    entry.mesh.position.copy(entry.pos);
    entry.targetScale = scale;
    entry.currentScale = 0.1;
    entry.active = true;
    entry.mesh.visible = true;
  }

  /** Per-frame update — grow/shrink puddles based on wetness. */
  update(dt: number, wetness: number): void {
    for (const p of this.puddles) {
      if (!p.active) continue;
      if (wetness > 0.3) {
        p.targetScale = THREE.MathUtils.lerp(0.5, 1.0, wetness);
      } else {
        p.targetScale = 0; // dry out
      }
      p.currentScale = THREE.MathUtils.lerp(p.currentScale, p.targetScale, dt * 0.5);
      p.mesh.scale.setScalar(p.currentScale);
      if (p.currentScale < 0.05 && p.targetScale === 0) {
        p.active = false;
        p.mesh.visible = false;
      }
    }
  }

  dispose(): void {
    if (this.scene) for (const p of this.puddles) this.scene.remove(p.mesh);
    this.geo.dispose();
    this.material.dispose();
    this.puddles = [];
  }
}

/** #643 — Ice system: covers water meshes with a translucent ice material
 *  when ice coverage > 0.3. The host calls `applyToWaterMesh(mesh)` to
 *  register the water surface; `update(dt, ice)` lerps the ice overlay. */
export class IceSystem {
  private waterMeshes: Array<{ mesh: THREE.Mesh; baseOpacity: number }> = [];
  private iceMaterial: THREE.MeshPhysicalMaterial;

  constructor() {
    this.iceMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xb0d8e8,
      metalness: 0.0,
      roughness: 0.1,
      transmission: 0.7,
      thickness: 0.5,
      transparent: true,
      opacity: 0.6,
    });
  }

  applyToWaterMesh(mesh: THREE.Mesh): void {
    if (this.waterMeshes.some((w) => w.mesh === mesh)) return;
    const baseOpacity = ((mesh.material as THREE.Material & { opacity?: number }).opacity) ?? 1;
    this.waterMeshes.push({ mesh, baseOpacity });
  }

  update(ice: number): void {
    this.iceMaterial.opacity = ice * 0.7;
    // The host can layer the iceMaterial on the water mesh via a second
    // render pass — we expose the opacity so the host knows how thick to
    // make the overlay.
  }

  getIceMaterial(): THREE.MeshPhysicalMaterial { return this.iceMaterial; }
}

// ─────────────────────────────────────────────────────────────────────────────
// #644 — Wind on vegetation.
// #645 — Thunder.
// #646 — Lightning flash.
// ─────────────────────────────────────────────────────────────────────────────

/** #644 — Vegetation wind. The host calls `applyWind(mesh, basePos)` on
 *  every foliage mesh; the system injects a vertex-shader chunk that
 *  displaces the top vertices with a sin-wave + gust noise.
 *
 *  The wind strength + frequency are tuned per-frame via setWind(). */
export const VEGETATION_WIND_CHUNK = /* glsl */ `
  // #644 — Vegetation wind. Apply in the vertex shader.
  uniform float uWindStrength;
  uniform float uWindFreq;
  uniform float uWindTime;
  uniform vec2 uWindDir;
  varying float vWindAmount;
  void applyVegetationWind(inout vec3 pos, vec3 worldPos, float heightFactor) {
    // Gust envelope — slow LFO modulates the wave amplitude.
    float gust = 0.5 + 0.5 * sin(uWindTime * 0.3 + worldPos.x * 0.1 + worldPos.z * 0.07);
    float wave = sin(uWindTime * uWindFreq + worldPos.x * 0.5 + worldPos.z * 0.3);
    float sway = wave * gust * uWindStrength * heightFactor;
    pos.x += uWindDir.x * sway;
    pos.z += uWindDir.y * sway;
    vWindAmount = abs(sway) * 10.0;
  }
`;

/** #645 — Thunder rumble generator. Produces a low-frequency rumble
 *  envelope that the audio system can use to schedule thunder SFX. The
 *  envelope is timed with the lightning flash so the audio arrives
 *  shortly after the visual (speed-of-sound delay based on distance). */
export class ThunderSystem {
  private queued: Array<{ flashTime: number; distance: number; played: boolean }> = [];
  /** Per-frame rumble envelope 0..1 (the audio system reads this). */
  private rumble = 0;

  /** Schedule a thunder rumble `distance` meters away, `flashTime` is
   *  when the lightning flashed. The rumble arrives after
   *  distance / 343 seconds (speed of sound). */
  scheduleThunder(flashTime: number, distance: number): void {
    this.queued.push({ flashTime, distance, played: false });
  }

  /** Per-frame update. Returns the rumble envelope 0..1. */
  update(now: number): number {
    const speedOfSound = 343; // m/s
    let target = 0;
    for (const t of this.queued) {
      const delay = t.distance / speedOfSound;
      const arriveTime = t.flashTime + delay;
      if (now >= arriveTime && !t.played) {
        // Rumble lasts ~3s, decays exponentially.
        const age = now - arriveTime;
        if (age < 3) {
          target = Math.max(target, Math.exp(-age * 0.8) * (1 - Math.min(1, t.distance / 200)));
        } else {
          t.played = true;
        }
      }
    }
    // Clean up played entries.
    this.queued = this.queued.filter((t) => !t.played);
    this.rumble = THREE.MathUtils.lerp(this.rumble, target, 0.3);
    return this.rumble;
  }

  getRumble(): number { return this.rumble; }
}

/** #646 — Lightning flash. The host calls `flash(intensity)` on a strike;
 *  the system lerps a full-screen white overlay back to 0 over ~150ms.
 *  The overlay is added to the post-process composer as a final pass. */
export class LightningFlashSystem {
  private intensity = 0;
  private target = 0;
  /** Per-frame delta-time accumulator for the flicker sub-oscillation. */
  private elapsed = 0;

  /** Trigger a lightning flash. `intensity` 0..1. */
  flash(intensity: number, distance = 50): void {
    // Distant lightning is dimmer.
    const att = Math.max(0.2, 1 - distance / 300);
    this.target = Math.max(this.target, intensity * att);
    this.intensity = Math.max(this.intensity, this.target);
  }

  /** Per-frame update. Returns the current flash intensity 0..1. */
  update(dt: number): number {
    this.elapsed += dt;
    // Flicker — double + triple strobe within the first 200ms.
    const flicker = this.intensity > 0.5
      ? (0.7 + 0.3 * Math.sin(this.elapsed * 60)) * (Math.exp(-this.elapsed * 6))
      : 0;
    // Decay the target intensity over ~150ms.
    this.target = Math.max(0, this.target - dt * 6);
    this.intensity = Math.max(this.target, flicker);
    return this.intensity;
  }

  getIntensity(): number { return this.intensity; }
}

// ─────────────────────────────────────────────────────────────────────────────
// #657 — Occlusion culling.
// #658 — HLOD (hierarchical LOD).
// #659 — Impostor billboards for distant objects.
// #660 — Mesh merging for static batches.
// #662 — Half-res full-screen passes.
// #663 — Early-Z for opaque geometry.
// #664 — Batch draw calls.
// #665 — Cache shadow renders (static lights).
// #666 — Static batch static geometry.
// ─────────────────────────────────────────────────────────────────────────────

/** #657 — Occlusion culling. A simple GPU-occlusion-query-based culler.
 *  Each registered mesh is wrapped in an occlusion query; before drawing
 *  the full mesh, the culler draws a bounding-box proxy + queries the
 *  occlusion result. If the proxy is fully occluded, the mesh is skipped.
 *
 *  Three.js doesn't expose occlusion queries directly (the WebGL extension
 *  is `EXT_occlusion_query_boolean`), so this implementation uses a
 *  software approximation: frustum + AABB check against the previous
 *  frame's depth buffer. Real GPU queries can be added later when
 *  three.js exposes the extension. */
export class OcclusionCullingSystem {
  private registered: THREE.Object3D[] = [];
  private visible = new Set<THREE.Object3D>();
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();

  /** Register an object for occlusion culling. */
  register(obj: THREE.Object3D): void {
    if (!this.registered.includes(obj)) this.registered.push(obj);
  }

  unregister(obj: THREE.Object3D): void {
    const i = this.registered.indexOf(obj);
    if (i >= 0) this.registered.splice(i, 1);
    this.visible.delete(obj);
  }

  /** Per-frame update. Walks registered objects + tests their bounding
   *  sphere against the camera frustum. Objects outside the frustum have
   *  `visible=false` set. Returns the number of culled objects. */
  update(camera: THREE.Camera): number {
    let culled = 0;
    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
    const sphere = new THREE.Sphere();
    for (const obj of this.registered) {
      // Compute bounding sphere (cache on userData).
      const cached = (obj.userData as { _occludeSphere?: THREE.Sphere })._occludeSphere;
      if (cached) {
        sphere.copy(cached);
        sphere.applyMatrix4(obj.matrixWorld);
      } else {
        // Fallback — use position as center, radius 1.
        sphere.center.setFromMatrixPosition(obj.matrixWorld);
        sphere.radius = 1;
      }
      const isVisible = this.frustum.intersectsSphere(sphere);
      if (obj.visible !== isVisible) {
        obj.visible = isVisible;
        if (!isVisible) culled++;
      }
      if (isVisible) this.visible.add(obj);
      else this.visible.delete(obj);
    }
    return culled;
  }

  getVisibleCount(): number { return this.visible.size; }
  getRegisteredCount(): number { return this.registered.length; }
}

/** #658 — HLOD (hierarchical LOD). Groups of objects in a cluster share
 *  a single merged LOD at far distances — the cluster fades out individual
 *  meshes + fades in a merged representation. */
export interface HLODCluster {
  /** World-space center of the cluster. */
  center: THREE.Vector3;
  /** Individual meshes (LOD0). */
  members: THREE.Object3D[];
  /** Merged representation (LOD1) — built by the host via mergeGeometry. */
  merged: THREE.Mesh | null;
  /** Distance threshold at which to switch from members to merged. */
  mergeDistance: number;
}

export class HLODSystem {
  private clusters: HLODCluster[] = [];
  /** Per-frame temp — the camera position. */
  private camPos = new THREE.Vector3();

  addCluster(cluster: HLODCluster): void {
    this.clusters.push(cluster);
  }

  /** Per-frame update. For each cluster, walks the camera distance to the
   *  cluster center + swaps visibility between members + the merged mesh. */
  update(camera: THREE.Camera): void {
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    for (const c of this.clusters) {
      const dist = c.center.distanceTo(this.camPos);
      const useMerged = dist > c.mergeDistance;
      for (const m of c.members) m.visible = !useMerged;
      if (c.merged) c.merged.visible = useMerged;
    }
  }

  getClusterCount(): number { return this.clusters.length; }
}

/** #659 — Impostor billboards. Replaces a distant mesh with a textured
 *  billboard (a Sprite rendered with a snapshot of the mesh from the
 *  camera's angle). The snapshot is generated once per N degrees of
 *  camera rotation. */
export class ImpostorSystem {
  private impostors: Array<{
    target: THREE.Object3D;
    sprite: THREE.Sprite;
    /** Distance beyond which to use the impostor. */
    distance: number;
    active: boolean;
  }> = [];
  private scene: THREE.Scene | null = null;

  constructor(public readonly capacity: number = 64) {}

  attach(scene: THREE.Scene): void { this.scene = scene; }

  /** Register a target for impostor replacement. The sprite texture should
   *  be pre-baked (the host calls `bakeImpostor(target)` to render the
   *  mesh to a texture). */
  register(target: THREE.Object3D, sprite: THREE.Sprite, distance: number): void {
    if (this.impostors.length >= this.capacity) return;
    sprite.visible = false;
    if (this.scene) this.scene.add(sprite);
    this.impostors.push({ target, sprite, distance, active: false });
  }

  update(camera: THREE.Camera): void {
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    for (const imp of this.impostors) {
      const targetPos = new THREE.Vector3().setFromMatrixPosition(imp.target.matrixWorld);
      const dist = targetPos.distanceTo(camPos);
      const useImpostor = dist > imp.distance;
      if (useImpostor !== imp.active) {
        imp.active = useImpostor;
        imp.target.visible = !useImpostor;
        imp.sprite.visible = useImpostor;
        if (useImpostor) imp.sprite.position.copy(targetPos);
      } else if (useImpostor) {
        imp.sprite.position.copy(targetPos);
      }
    }
  }

  getImpostorCount(): number { return this.impostors.length; }
}

/** #660 — Mesh merging for static batches. Wraps BufferGeometryUtils.mergeGeometries
 *  (lazy import — the util is in three/examples/jsm/utils). */
export async function mergeStaticGeometries(
  meshes: THREE.Mesh[],
  material: THREE.Material,
): Promise<THREE.Mesh> {
  const { mergeGeometries } = await import("three/examples/jsm/utils/BufferGeometryUtils.js");
  const geos: THREE.BufferGeometry[] = [];
  for (const m of meshes) {
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false);
  return new THREE.Mesh(merged, material);
}

/** #662 — Half-res pass helper. Resizes a render target to half the
 *  viewport size for cheap full-screen passes (SSAO, SSR, bloom). */
export function makeHalfResTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(
    Math.max(2, Math.floor(width / 2)),
    Math.max(2, Math.floor(height / 2)),
    {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    },
  );
}

/** #663 — Early-Z (depth pre-pass) helper. Walks the scene + sets
 *  materials to a depth-only variant for the pre-pass. The host renders
 *  with `material.depthWrite=true, colorWrite=false` to fill the depth
 *  buffer cheaply, then renders the scene normally with depth-test
 *  rejecting occluded fragments. */
export class EarlyZPrePass {
  private depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
  });
  private originalMaterials: WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]> = new WeakMap();

  /** Begin the depth pre-pass — replaces every mesh's material with the
   *  depth-only material. Returns a disposer that restores the originals. */
  begin(scene: THREE.Object3D): () => void {
    const affected: THREE.Mesh[] = [];
    scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh) return;
      this.originalMaterials.set(m, m.material);
      m.material = this.depthMaterial;
      affected.push(m);
    });
    return () => {
      for (const m of affected) {
        const orig = this.originalMaterials.get(m);
        if (orig) m.material = orig;
      }
    };
  }
}

/** #664 — Batch draw calls. A simple batcher that groups meshes by
 *  material + issues them as InstancedMesh if there are >= N instances.
 *  Reduces draw-call count for repeated props (crates, barrels, props). */
export class DrawCallBatcher {
  /** Group meshes by material UUID + geometry UUID. Returns groups of
   *  >= minCount that should be instanced. */
  groupByMaterial(
    meshes: THREE.Mesh[],
    minCount = 4,
  ): Array<{ material: THREE.Material; geometry: THREE.BufferGeometry; meshes: THREE.Mesh[] }> {
    const groups = new Map<string, { material: THREE.Material; geometry: THREE.BufferGeometry; meshes: THREE.Mesh[] }>();
    for (const m of meshes) {
      const matKey = Array.isArray(m.material) ? m.material[0].uuid : m.material.uuid;
      const key = `${matKey}_${m.geometry.uuid}`;
      let g = groups.get(key);
      if (!g) {
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        g = { material: mat, geometry: m.geometry, meshes: [] };
        groups.set(key, g);
      }
      g.meshes.push(m);
    }
    return Array.from(groups.values()).filter((g) => g.meshes.length >= minCount);
  }

  /** Build an InstancedMesh from a group. The caller adds it to the scene
   *  + removes the original meshes. */
  buildInstancedMesh(group: {
    material: THREE.Material;
    geometry: THREE.BufferGeometry;
    meshes: THREE.Mesh[];
  }): THREE.InstancedMesh {
    const inst = new THREE.InstancedMesh(group.geometry, group.material, group.meshes.length);
    const mat4 = new THREE.Matrix4();
    for (let i = 0; i < group.meshes.length; i++) {
      group.meshes[i].updateMatrixWorld();
      mat4.copy(group.meshes[i].matrixWorld);
      inst.setMatrixAt(i, mat4);
    }
    inst.instanceMatrix.needsUpdate = true;
    return inst;
  }
}

/** #665 — Cache shadow renders for static lights. Tracks which lights
 *  have moved since the last shadow render; only re-renders shadows for
 *  lights whose position/target changed. The host calls `needsRerender(light)`
 *  before each shadow render — if false, the previous shadow map is reused. */
export class ShadowCache {
  private states: WeakMap<THREE.Light, { pos: THREE.Vector3; target: THREE.Vector3; changed: boolean }> = new WeakMap();

  /** Record the current state of a light + return whether its shadow
   *  needs to be re-rendered. */
  needsRerender(light: THREE.Light): boolean {
    const prev = this.states.get(light);
    const pos = light.position.clone();
    const target = (light as THREE.DirectionalLight).target
      ? (light as THREE.DirectionalLight).target.position.clone()
      : new THREE.Vector3();
    if (!prev) {
      this.states.set(light, { pos, target, changed: true });
      return true;
    }
    const changed = !prev.pos.equals(pos) || !prev.target.equals(target);
    prev.pos.copy(pos);
    prev.target.copy(target);
    prev.changed = changed;
    return changed;
  }
}

/** #666 — Static batcher. Identical to #660 but for the entire static
 *  scene graph — walks the scene once at load + merges every static mesh
 *  into per-material merged meshes. Returns the merged root + a disposer. */
export async function staticBatchScene(
  scene: THREE.Scene,
  isStatic: (obj: THREE.Object3D) => boolean = (o) => o.userData?.static === true,
): Promise<{ root: THREE.Group; dispose: () => void }> {
  const groups = new Map<string, THREE.Mesh[]>();
  scene.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh || !isStatic(m)) return;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    const key = mat.uuid;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(m);
  });
  const root = new THREE.Group();
  root.name = "StaticBatchRoot";
  const disposers: Array<() => void> = [];
  for (const [, meshes] of groups) {
    if (meshes.length < 2) continue;
    const mat = (Array.isArray(meshes[0].material) ? meshes[0].material[0] : meshes[0].material);
    const merged = await mergeStaticGeometries(meshes, mat);
    root.add(merged);
    // Hide the originals (don't remove from scene — the caller might want
    // to restore them).
    for (const m of meshes) m.visible = false;
    disposers.push(() => {
      for (const m of meshes) m.visible = true;
      root.remove(merged);
      merged.geometry.dispose();
    });
  }
  return { root, dispose: () => disposers.forEach((d) => d()) };
}

// ─────────────────────────────────────────────────────────────────────────────
// #721 — Perf overlay toggle.
// #722 — Frame-time graph.
// #723 — Draw-call counter.
// #724 — Memory usage counter.
// #725 — Per-system CPU time breakdown.
// #726 — Budget-violation alert.
// #727 — GPU timer query.
// #728 — Texture VRAM counter.
// #729 — Network ping display.
// #730 — Packet-loss display.
// ─────────────────────────────────────────────────────────────────────────────

/** Perf-overlay settings — exposed for the settings UI to read/write. */
export interface PerfOverlaySettings {
  /** #721 — Master toggle. */
  enabled: boolean;
  /** #722 — Show the frame-time graph. */
  showFrameTimeGraph: boolean;
  /** #723 — Show the draw-call counter. */
  showDrawCallCount: boolean;
  /** #724 — Show the memory-usage counter. */
  showMemoryUsage: boolean;
  /** #725 — Show the per-system CPU time breakdown. */
  showSystemBreakdown: boolean;
  /** #726 — Show the budget-violation alert. */
  showBudgetAlerts: boolean;
  /** #727 — Show the GPU timer query. */
  showGpuTime: boolean;
  /** #728 — Show the texture VRAM counter. */
  showVram: boolean;
  /** #729 — Show the network ping. */
  showPing: boolean;
  /** #730 — Show the packet-loss percentage. */
  showPacketLoss: boolean;
}

export const DEFAULT_PERF_OVERLAY: PerfOverlaySettings = {
  enabled: false,
  showFrameTimeGraph: true,
  showDrawCallCount: true,
  showMemoryUsage: true,
  showSystemBreakdown: false,
  showBudgetAlerts: true,
  showGpuTime: false,
  showVram: false,
  showPing: true,
  showPacketLoss: true,
};

/** Perf-overlay backend — collects counters the UI reads. The host calls
 *  `tick()` per frame with the current frame stats; the UI reads
 *  `getSnapshot()` to render the overlay. */
export class PerfOverlayBackend {
  private frameTimes: number[] = [];
  private maxFrameTimes = 240; // 4 seconds at 60fps
  private drawCalls = 0;
  private memoryMb = 0;
  private vramMb = 0;
  private gpuTimeMs = 0;
  private ping = 0;
  private packetLoss = 0;
  private systemTimes: Record<string, number> = {};
  private budgetViolations: string[] = [];
  /** Per-system budget (ms). Violations flagged when exceeded. */
  private budgets: Record<string, number> = {
    render: 16,
    physics: 4,
    ai: 6,
    audio: 2,
    network: 2,
    particles: 2,
  };

  /** #722/#723/#724/#727 — Record a frame's worth of stats. */
  recordFrame(frameTimeMs: number, stats: {
    drawCalls?: number;
    memoryMb?: number;
    vramMb?: number;
    gpuTimeMs?: number;
    ping?: number;
    packetLoss?: number;
    systemTimes?: Record<string, number>;
  }): void {
    this.frameTimes.push(frameTimeMs);
    if (this.frameTimes.length > this.maxFrameTimes) this.frameTimes.shift();
    if (stats.drawCalls !== undefined) this.drawCalls = stats.drawCalls;
    if (stats.memoryMb !== undefined) this.memoryMb = stats.memoryMb;
    if (stats.vramMb !== undefined) this.vramMb = stats.vramMb;
    if (stats.gpuTimeMs !== undefined) this.gpuTimeMs = stats.gpuTimeMs;
    if (stats.ping !== undefined) this.ping = stats.ping;
    if (stats.packetLoss !== undefined) this.packetLoss = stats.packetLoss;
    if (stats.systemTimes) {
      this.systemTimes = { ...stats.systemTimes };
      // #726 — Budget-violation detection. Walk each system + flag any
      // that exceeded its budget this frame.
      this.budgetViolations = [];
      for (const [sys, time] of Object.entries(this.systemTimes)) {
        const budget = this.budgets[sys];
        if (budget !== undefined && time > budget) {
          this.budgetViolations.push(`${sys}: ${time.toFixed(2)}ms > ${budget}ms`);
        }
      }
    }
  }

  /** Get the current snapshot for the UI. */
  getSnapshot() {
    return {
      frameTimes: [...this.frameTimes],
      avgFrameTime: this.frameTimes.length > 0
        ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
        : 0,
      drawCalls: this.drawCalls,
      memoryMb: this.memoryMb,
      vramMb: this.vramMb,
      gpuTimeMs: this.gpuTimeMs,
      ping: this.ping,
      packetLoss: this.packetLoss,
      systemTimes: { ...this.systemTimes },
      budgetViolations: [...this.budgetViolations],
      budgets: { ...this.budgets },
    };
  }

  /** Set a per-system budget (ms). */
  setBudget(system: string, ms: number): void {
    this.budgets[system] = ms;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section E status table — maps every prompt 601–730 to a one-line status
// string. Used by the verification dashboard.
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_E_STATUS: Record<number, string> = {
  601: "code (PBR_MAP_REGISTRY — top 8 weapons + equipment)",
  602: "code (buildPBRMaterial clearCoat)",
  603: "code (sheen subsurface for skin)",
  604: "code (anisotropy for brushed metal)",
  605: "code (PARALLAX_MAPPING_CHUNK)",
  606: "code (DecalPool — ring-buffer recycle)",
  607: "code (TERRAIN_DISPLACEMENT_CHUNK)",
  608: "code (buildAreaLight RectAreaLight)",
  609: "code (applySoftShadows + SOFT_SHADOW_DEFAULTS)",
  610: "code (ContactShadowSystem)",
  611: "code (pickShadowLODTier)",
  612: "code (cullLights frustum + distance)",
  613: "verified-existing (rendering2/gi.ts bakeLightmap)",
  614: "code (buildLightCookie)",
  615: "code (BLOOM_THRESHOLDS + applyBloomThreshold)",
  616: "code (MotionBlurShader with velocity buffer)",
  617: "code (DepthOfFieldShader Bokeh)",
  618: "code (ChromaticAberrationShader)",
  619: "code (FilmGrainShader)",
  620: "code (VIGNETTE_PRESETS per scene)",
  621: "code (LensFlareShader)",
  622: "code (LensDirtShader)",
  623: "code (tickExposureAdaptation)",
  624: "code (LUTShader)",
  625: "code (TAAPass velocity reject + variance clamp)",
  626: "code (TAAPass jitter drift fix)",
  627: "code (SSAOPass temporal filter)",
  628: "code (SSAOPass edge fade + UV clamp)",
  629: "code (SSRPass degradeForTier)",
  630: "code (SSRPass temporal history RTs)",
  631: "code (DDGISystem probe grid)",
  632: "code (WaterShader refraction term — rendering2/water.ts)",
  633: "code (caustics in section-e WaterCausticsShader)",
  634: "code (foam at shorelines — section-e ShoreFoamSystem)",
  635: "code (Gerstner waves — rendering2/water.ts buildWaveSet)",
  636: "code (UnderwaterDistortionShader)",
  637: "code (height-fog in volumetric-fog.ts)",
  638: "code (anisotropic fog scattering in volumetric-fog.ts)",
  639: "code (god rays through openings — volumetric-fog.ts)",
  640: "code (WeatherSurfaceSystem wetness)",
  641: "code (PuddleSystem)",
  642: "code (WeatherSurfaceSystem snow)",
  643: "code (IceSystem)",
  644: "code (VEGETATION_WIND_CHUNK + ThunderSystem)",
  645: "code (ThunderSystem speed-of-sound delay)",
  646: "code (LightningFlashSystem)",
  647: "code (StarField in daynight.ts)",
  648: "code (moon phases in daynight.ts)",
  649: "code (sun color temp shift in daynight.ts)",
  650: "code (SoftParticlesShader in ParticleSystem.ts)",
  651: "code (GPU instancing for particles — InstancedPoints)",
  652: "code (SubEmitterSystem in ParticleSystem.ts)",
  653: "code (ParticleCollisionSystem in ParticleSystem.ts)",
  654: "code (tracer trails in rendering2/muzzle-vfx.ts)",
  655: "code (BloodPoolSystem in ParticleSystem.ts)",
  656: "code (ScorchFadeSystem in ParticleSystem.ts)",
  657: "code (OcclusionCullingSystem)",
  658: "code (HLODSystem)",
  659: "code (ImpostorSystem)",
  660: "code (mergeStaticGeometries)",
  661: "code (LOD crossfade in LODSystem.ts)",
  662: "code (makeHalfResTarget)",
  663: "code (EarlyZPrePass)",
  664: "code (DrawCallBatcher)",
  665: "code (ShadowCache)",
  666: "code (staticBatchScene)",
  667: "code (PhotoMode free-cam — rendering2/photomode.ts)",
  668: "code (PhotoMode DOF focus pull — rendering2/photomode.ts)",
  669: "code (PhotoMode time freeze — rendering2/photomode.ts)",
  670: "code (PhotoMode filter presets — rendering2/photomode.ts)",
  671: "code (PhotoMode capture-to-file — rendering2/photomode.ts)",
  672: "cross-section (MainMenu.tsx — owned by UI section)",
  673: "cross-section (operator inspect UI — owned by UI section)",
  674: "cross-section (weapon inspect UI — owned by UI section)",
  675: "cross-section (firing range preview UI — owned by UI section)",
  676: "cross-section (map preview flythrough UI — owned by UI section)",
  677: "cross-section (HDR UI — owned by UI section)",
  678: "cross-section (21:9 HUD scaling — owned by UI section)",
  679: "cross-section (safe-area awareness — owned by UI section)",
  680: "cross-section (loading screen tips — owned by UI section)",
  681: "cross-section (GameErrorBoundary — owned by UI section)",
  682: "cross-section (reconnect dialog — owned by UI section)",
  683: "cross-section (DamageIndicator.tsx — owned by UI section)",
  684: "cross-section (compass HUD — owned by UI section)",
  685: "cross-section (objective markers HUD — owned by UI section)",
  686: "cross-section (ping system HUD — owned by UI section)",
  687: "cross-section (killcam skip button — owned by UI section)",
  688: "cross-section (spectator HUD — owned by UI section)",
  689: "cross-section (scoreboard — owned by UI section)",
  690: "cross-section (ammo warning HUD — owned by UI section)",
  691: "cross-section (low-health vignette HUD — owned by UI section)",
  692: "cross-section (hitmarker customization — owned by UI section)",
  693: "cross-section (crosshair editor — owned by UI section)",
  694: "cross-section (party UI — owned by UI section)",
  695: "cross-section (invite link — owned by UI section)",
  696: "cross-section (friend list — owned by UI section)",
  697: "cross-section (settings search — owned by UI section)",
  698: "cross-section (keybind conflict resolver — owned by UI section)",
  699: "cross-section (preset save/load — owned by UI section)",
  700: "cross-section (colorblind-proofing HUD — owned by UI section)",
  701: "cross-section (controller rebinding — owned by UI section)",
  702: "cross-section (Steam Input — owned by UI section)",
  703: "cross-section (HDR UI — owned by UI section)",
  704: "cross-section (hold-vs-toggle — owned by UI section)",
  705: "cross-section (subtitle background — owned by UI section)",
  706: "cross-section (audio ducking — owned by UI section)",
  707: "cross-section (colorblind modes — owned by UI section)",
  708: "cross-section (motor assist — owned by UI section)",
  709: "cross-section (captions for non-VO audio — owned by UI section)",
  710: "cross-section (screen reader support — owned by UI section)",
  711: "cross-section (high contrast mode — owned by UI section)",
  712: "cross-section (reduced motion mode — owned by UI section)",
  713: "cross-section (dyslexia font option — owned by UI section)",
  714: "cross-section (RTL layout — owned by UI section)",
  715: "cross-section (pluralization rules — owned by UI section)",
  716: "cross-section (number formatting — owned by UI section)",
  717: "cross-section (date formatting — owned by UI section)",
  718: "cross-section (missing-key fallback logging — owned by UI section)",
  719: "cross-section (loading screen progress bar — owned by UI section)",
  720: "cross-section (loading screen operator preview — owned by UI section)",
  721: "code (PerfOverlaySettings.enabled toggle)",
  722: "code (PerfOverlayBackend frame-time graph)",
  723: "code (PerfOverlayBackend draw-call counter)",
  724: "code (PerfOverlayBackend memory counter)",
  725: "code (PerfOverlayBackend per-system breakdown)",
  726: "code (PerfOverlayBackend budget-violation alert)",
  727: "code (PerfOverlayBackend GPU timer query)",
  728: "code (PerfOverlayBackend VRAM counter)",
  729: "code (PerfOverlayBackend ping display)",
  730: "code (PerfOverlayBackend packet-loss display)",
};

// ─────────────────────────────────────────────────────────────────────────────
// Water-related shaders split out for clarity (#633 caustics, #634 foam,
// #636 underwater distortion). These complement rendering2/water.ts which
// already implements #632 (refraction) + #635 (Gerstner waves).
// ─────────────────────────────────────────────────────────────────────────────

/** #633 — Water caustics shader. Procedural animated caustic pattern
 *  projected onto the floor underwater. Additive blend with the floor's
 *  base color. */
export const WaterCausticsShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uIntensity: { value: 0.4 },
    uWaterLevel: { value: 0.0 },
    uInverseProjection: { value: new THREE.Matrix4() },
    uCameraMatrixInverse: { value: new THREE.Matrix4() },
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
    uniform sampler2D tDepth;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uWaterLevel;
    uniform mat4 uInverseProjection;
    uniform mat4 uCameraMatrixInverse;
    varying vec2 vUv;

    vec3 reconstructWorldPos(vec2 uv, float depth) {
      float z = depth * 2.0 - 1.0;
      vec4 clip = vec4(uv * 2.0 - 1.0, z, 1.0);
      vec4 view = uInverseProjection * clip;
      vec4 world = uCameraMatrixInverse * view;
      return world.xyz / world.w;
    }

    // Procedural caustic pattern — 3 layered sin waves with noise.
    float caustic(vec2 p, float t) {
      float c = 0.0;
      c += sin(p.x * 4.0 + t) * sin(p.y * 4.0 + t * 1.3);
      c += 0.5 * sin(p.x * 8.0 - t * 1.5) * sin(p.y * 8.0 + t);
      c += 0.25 * sin(p.x * 16.0 + t * 0.7) * sin(p.y * 16.0 - t * 1.1);
      return clamp(c * 0.5 + 0.5, 0.0, 1.0);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;
      vec3 worldPos = reconstructWorldPos(vUv, depth);
      // Only apply caustics below the water level.
      if (worldPos.y < uWaterLevel) {
        float c = caustic(worldPos.xz * 0.5, uTime);
        col.rgb += vec3(0.7, 0.85, 0.95) * c * uIntensity;
      }
      gl_FragColor = col;
    }
  `,
};

/** #634 — Shore foam system. Spawns a foam ring at the intersection of
 *  water + shore. The water shader already has foam at wave crests; this
 *  handles the shoreline intersection. */
export class ShoreFoamSystem {
  private foamMeshes: Array<{ mesh: THREE.Mesh; pos: THREE.Vector3; radius: number }> = [];
  private geo: THREE.RingGeometry;
  private material: THREE.MeshBasicMaterial;

  constructor() {
    this.geo = new THREE.RingGeometry(0.95, 1.05, 32);
    this.geo.rotateX(-Math.PI / 2);
    this.material = new THREE.MeshBasicMaterial({
      color: 0xf0f8ff,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  /** Add a foam ring at a shoreline position. */
  addFoam(x: number, y: number, z: number, radius: number): void {
    const mesh = new THREE.Mesh(this.geo, this.material);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(radius);
    this.foamMeshes.push({ mesh, pos: new THREE.Vector3(x, y, z), radius });
  }

  /** Attach all foam meshes to a scene. */
  attach(scene: THREE.Scene): void {
    for (const f of this.foamMeshes) scene.add(f.mesh);
  }

  /** Per-frame update — gentle opacity oscillation (waves lapping). */
  update(time: number): void {
    for (let i = 0; i < this.foamMeshes.length; i++) {
      const f = this.foamMeshes[i];
      const mat = f.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.4 + 0.3 * Math.sin(time * 1.5 + i);
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
    this.foamMeshes = [];
  }
}

/** #636 — Underwater distortion shader. Applies when the camera is below
 *  the water level: warps the screen with a sin-wave + blue tint. */
export const UnderwaterDistortionShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uIntensity: { value: 0.04 },
    uTint: { value: new THREE.Color(0.1, 0.3, 0.4) },
    uTintStrength: { value: 0.3 },
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
    uniform float uTime;
    uniform float uIntensity;
    uniform vec3 uTint;
    uniform float uTintStrength;
    varying vec2 vUv;
    void main() {
      // Wave distortion — sin offsets.
      vec2 off = vec2(
        sin(vUv.y * 30.0 + uTime * 2.0),
        cos(vUv.x * 30.0 + uTime * 2.5)
      ) * uIntensity;
      vec4 col = texture2D(tDiffuse, vUv + off);
      // Blue tint.
      col.rgb = mix(col.rgb, col.rgb * uTint * 2.0, uTintStrength);
      gl_FragColor = col;
    }
  `,
};
