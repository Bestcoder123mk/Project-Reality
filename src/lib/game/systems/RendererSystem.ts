import * as THREE from "three";
import { CSM } from "three/examples/jsm/csm/CSM.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { SkyShader, DayNightCycle } from "../rendering2/daynight";
import { detectWebGPU, getActivePolicy, getWebGPUCapabilities, type CapabilityTier } from "../rendering2/webgpu-detect";
import type { GameSystem, GameContext } from "./types";
import {
  concreteTexture,
  concreteRoughnessTexture,
  sandTexture,
  woodTexture,
  metalTexture,
  brickTexture,
  particleTexture,
} from "../textures";
import {
  SURFACE_MATERIAL_MAP,
  sunDirection,
  skyColors,
} from "../realism";
import { buildMap, applyMapLighting, clearMap, type MaterialCache } from "../maps/MapBuilder";
import type { MapDefinition } from "../maps/MapRegistry";
import { ChunkManager } from "./ChunkManager";
import {
  shouldEngageSafeMode,
  decayContextLossLog,
  getContextLossCount,
} from "./context-factory";
import { track } from "@/lib/analytics";
import { useGameStore } from "../store";

/** Safe wrapper that returns 0 if localStorage is unavailable. */
function getContextLossCountSafe(): number {
  try { return getContextLossCount(); } catch { return 0; }
}

/**
 * RendererSystem — owns the WebGLRenderer, scene, camera, sky shader, lights,
 * level geometry, and the per-frame render call. Resize handling lives here too.
 */
export class RendererSystem implements GameSystem {
  /** Task-38 — starfield Points (lazily created on first night). Fades in/out
   *  at dusk/dawn via material.opacity. Lives on this system (not the scene
   *  userData) so clearMap() — which wipes scene children — won't accidentally
   *  dispose it. */
  private starfield: THREE.Points | null = null;
  /** Task-3 — cached ground material list for weather wetness (Prompt #9).
   *  A3-5000 #416: was a single cached material; now a list (see
   *  `_groundMaterials` below). These legacy single-material fields are
   *  kept for backward compat but no longer used by applyWetness. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _groundMaterial: THREE.MeshStandardMaterial | null = null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _groundBaseRoughness = 0.95;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _groundBaseEnvMapIntensity = 1.15;
  /** Task-3 — scratch vector for world-position lookups during ground-mesh
   *  detection (avoid per-call allocation). */
  private _scratchVec = new THREE.Vector3();
  /** Task-3 — Cascaded Shadow Maps (CSM) instance. When non-null, CSM
   *  replaces the single sunLight shadow with 3 cascaded shadow frustums
   *  (tight near, soft far) for crisp shadows at all engagement distances.
   *  Falls back to a single 4096 shadow map + 60m frustum if CSM construction
   *  fails (per the task spec's documented fallback). */
  private _csm: CSM | null = null;
  /** Task-3 — tracks which materials have already had csm.setupMaterial()
   *  called so the periodic sweep only touches new materials (cheap). */
  private _csmMaterials: WeakSet<THREE.Material> = new WeakSet();
  /** Task-3 — accumulator for the periodic CSM material sweep (every ~0.5s). */
  private _csmSweepAccum = 0;
  /** Task-3 — scratch vector for CSM light direction sync (avoid per-frame
   *  allocation). The direction the light TRAVELS (from sun position toward
   *  target = -normalize(sunPosition)). */
  private _csmLightDir = new THREE.Vector3();

  /** Prompt A#6 — true iff the boot path forced qualityPreset = "reduced"
   *  because the 24h-rolling context-loss count exceeded the threshold.
   *  Read from localStorage by `shouldEngageSafeMode()` in the constructor.
   *  Once set, this stays true for the lifetime of the engine (a fresh
   *  boot re-evaluates). */
  private _safeMode = false;
  /** Prompt A#6 — accumulator for the per-minute decay check. The decay
   *  function drops the oldest context-loss log entry if it's older than
   *  12h, so a device that had a bad day recovers to full quality after
   *  ~12h of clean uptime. */
  private _safeModeDecayAccum = 0;

  constructor(private ctx: GameContext) {
    // Task 24 — Realistic Shaders + PBR materials: renderer settings only.
    // (Lighting + level building owned by Task 1 — untouched here.)
    //
    // ACESFilmicToneMapping is set in context-factory.ts as the renderer's
    // tone mapping, but we override it to NoToneMapping here so the grade
    // shader (in PostProcessing.ts) is the SOLE tonemapper. This avoids
    // double-tonemap darkening (renderer ACES + grade ACES would compress
    // highlights by ~35% which violates the "do not darken the scene"
    // constraint). With NoToneMapping:
    //   - Materials output HDR linear during RenderPass (no per-material tonemap)
    //   - Grade shader applies ACES (HDR → LDR with cinematic roll-off)
    //   - OutputPass's tonemapping_fragment chunk is a no-op (just does sRGB)
    // The renderer.toneMapping value is still respected by any non-composer
    // direct renders (e.g., the Gunsmith podium), so context-factory's
    // ACESFilmic setting remains the correct fallback for those paths.
    this.ctx.renderer.toneMapping = THREE.NoToneMapping;
    // Per Task 24 spec — exposure 1.0 (context-factory.ts now also sets 1.0;
    // the grade shader's uExposure uniform handles the per-frame exposure
    // boost that compensates for ACES mid-gray darkening, so renderer
    // exposure stays neutral).
    this.ctx.renderer.toneMappingExposure = 1.0;
    // outputColorSpace is already SRGBColorSpace (set in context-factory.ts).
    // Note on useLegacyLights (Task 24 spec): this property was DEPRECATED in
    // Three r155 (renamed from `physicallyCorrectLights` with inverted default
    // `false`) and REMOVED entirely in r165. In r185 lights are ALWAYS
    // physically correct — intensity in candela/lux/nits. No setting needed;
    // the default matches `useLegacyLights = false` (the spec's ask).

    // Task 3 / item 69 — surface the GPU renderer string on window so the
    // perf overlay (PerfOverlay.tsx) can show the actual GPU name (Chrome
    // exposes WEBGL_debug_renderer_info; Firefox/Safari usually don't). The
    // hardware profile is stashed on `renderer._hwProfile` by context-factory.
    if (typeof window !== "undefined") {
      const hw = (this.ctx.renderer as unknown as { _hwProfile?: { renderer?: string; vendor?: string } })._hwProfile;
      if (hw) {
        (window as unknown as { __PR_GPU_INFO?: { vendor?: string; renderer?: string } }).__PR_GPU_INFO = {
          vendor: hw.vendor,
          renderer: hw.renderer,
        };
      }
    }

    // Prompt A#6 — safe-mode boot check. If the device has lost the WebGL
    // context > 2 times in the last 24h (tracked in localStorage by
    // context-factory.ts:incrementContextLossCount), force qualityPreset =
    // "reduced" and skip the heavy post-processing passes (TAA / SSAO /
    // volumetric fog) for this session. A toast is surfaced via the HUD
    // objective so the player knows why graphics are degraded. The count
    // decays by 1 per 12h of clean uptime (see update()).
    this._safeMode = shouldEngageSafeMode();
    if (this._safeMode) {
      try {
        const s = this.ctx.settings;
        // Force the lowest quality preset + flip the ExtendedSettings
        // `reducedEffects` flag (read by ClothSim / RagdollSystem /
        // VoronoiFracture to early-out their per-frame simulation).
        // PostProcessing reads `settings.quality` to gate TAA/SSAO/bloom
        // passes; quality="low" disables all of them.
        s.quality = "low";
        if (s.extended) {
          s.extended.reducedEffects = true;
        }
        track("safe_mode_engaged", { count: getContextLossCountSafe() });
      } catch { /* best-effort */ }
      try {
        // Surface a toast — re-uses the HUD objective line (the same slot
        // used for "Graphics context lost — restoring…"). This is a
        // fire-once notification; the engine's match-start objective set
        // will overwrite it.
        useGameStore.getState().setHud({
          objective: "Safe mode enabled — graphics reduced (repeated context loss).",
        });
      } catch { /* store may be unavailable in tests */ }
    }
  }

  /** Prompt A#6 — accumulator for the per-minute decay check (separated
   *  from _lastDecayCheck to keep the field declarations together). */
  private _lastDecayCheck = 0;

  /** Section A — WebGPU capability tier (probed once at boot, cached). */
  private _webgpuTier: CapabilityTier | null = null;
  /** Section A — WebGPU probe result (logged once for diagnostics). */
  private _webgpuProbed = false;

  /** Section A — probe WebGPU capability at boot + cache the tier. Safe to
   *  call from the constructor (the probe is async but the sync cache is
   *  populated lazily on first read). The host RendererSystem uses this to
   *  decide whether to enable RT shadows + neural GI (WebGPU) or fall back
   *  to the screen-space variants (WebGL2). */
  private async _probeWebGPU(): Promise<void> {
    if (this._webgpuProbed) return;
    this._webgpuProbed = true;
    try {
      const caps = await detectWebGPU();
      // Import classifyTier lazily (it's already imported at the top).
      const { classifyTier } = await import("../rendering2/webgpu-detect");
      this._webgpuTier = classifyTier(caps);
      console.log(`[RendererSystem] WebGPU tier: ${this._webgpuTier} (available=${caps.available}${caps.vendor ? `, vendor=${caps.vendor}` : ""})`);
    } catch (err) {
      console.warn("[RendererSystem] WebGPU probe failed:", err);
      this._webgpuTier = "webgl2-fallback";
    }
  }

  /** Section A — get the cached WebGPU tier (probes on first call). */
  getWebGPUTier(): CapabilityTier {
    if (!this._webgpuProbed) {
      // Kick off the async probe — the sync return falls back to "webgl2-fallback"
      // for the first frame, then the cached value is read on subsequent frames.
      void this._probeWebGPU();
    }
    return this._webgpuTier ?? "webgl2-fallback";
  }

  /** Section A — get the active backend policy (feature gates). The host
   *  reads this to decide which Section A passes are allowed at the current
   *  tier (e.g. rayTracedShadows is gated to "ultra" + "high" only). */
  getActiveBackendPolicy() {
    return getActivePolicy();
  }

  /** Section A — sync access to the cached WebGPU capability snapshot. */
  getWebGPUCaps() {
    return getWebGPUCapabilities();
  }

  /**
   * Phase 10: Build level from a MapDefinition.
   * Replaces the hardcoded buildLevel() with data-driven map loading.
   */
  buildLevelFromMap(map: MapDefinition) {
    clearMap(this.ctx);
    // Task-3 — invalidate the cached ground material so the next
    // updateWeatherVisuals call re-detects the new map's ground mesh
    // (the old mesh + material were disposed by clearMap).
    // A3-5000 #416: also invalidate the multi-material list.
    this._groundMaterial = null;
    this._groundMaterialsPopulated = false;
    this._groundMaterials = [];
    // Task-3 — clear the CSM material WeakSet so the new level's materials
    // get csm.setupMaterial() called on the next sweep (old materials were
    // disposed by clearMap; the WeakSet entries will be GC'd eventually but
    // we proactively reset so the next sweep re-visits everything).
    this._csmMaterials = new WeakSet();
    const built = buildMap(this.ctx, map);
    applyMapLighting(this.ctx, map);
    // V2 — create the chunk streaming manager from the built chunk groups.
    // The manager toggles chunk group visibility per-frame based on the
    // camera frustum, so only visible chunks render.
    if (built.chunkGroups.size > 0) {
      this.ctx.chunkManager = new ChunkManager(this.ctx, built.chunkGroups);
    }
    // Set player spawn.
    this.ctx.player.pos.set(map.playerSpawn[0], map.playerSpawn[1], map.playerSpawn[2]);
    // Set time-of-day override if specified.
    if (map.timeOfDayOverride !== null) {
      this.ctx.weather.timeOfDay = map.timeOfDayOverride;
    }
    this.updateWeatherVisuals();
    // Task-3 — initial CSM material sweep so all static level geometry
    // materials are set up before the first render.
    this._initialCSMSweep();
  }

  /** Build static level geometry (walls, cover, crates, barrels). Legacy fallback. */
  buildLevel() {
    // Task-3 — invalidate the cached ground material so the next
    // updateWeatherVisuals call re-detects the new legacy ground mesh.
    this._groundMaterial = null;
    // A3-5000 #416: also invalidate the multi-material list.
    this._groundMaterialsPopulated = false;
    this._groundMaterials = [];
    // Task-3 — clear the CSM material WeakSet (mirrors buildLevelFromMap).
    this._csmMaterials = new WeakSet();
    const { scene, colliders, destructibles } = this.ctx;
    const concrete = concreteTexture();
    concrete.repeat.set(20, 20);
    const concreteRough = concreteRoughnessTexture();
    concreteRough.repeat.set(20, 20);

    const groundMat = new THREE.MeshStandardMaterial({ map: sandTexture(), roughnessMap: concreteRough, roughness: 0.95, metalness: 0.0 });
    groundMat.map!.repeat.set(40, 40);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const wallMat = new THREE.MeshStandardMaterial({ map: concrete.clone(), roughnessMap: concreteRough.clone(), roughness: 0.9, metalness: 0.05 });
    (wallMat.map as THREE.Texture).repeat.set(10, 3);
    const wallH = 8; const bound = 45;
    this.addBox(0, wallH / 2, -bound, bound * 2 + 4, wallH, 2, wallMat);
    this.addBox(0, wallH / 2, bound, bound * 2 + 4, wallH, 2, wallMat);
    this.addBox(-bound, wallH / 2, 0, 2, wallH, bound * 2 + 4, wallMat);
    this.addBox(bound, wallH / 2, 0, 2, wallH, bound * 2 + 4, wallMat);

    const brick = new THREE.MeshStandardMaterial({ map: brickTexture(), roughness: 0.92, metalness: 0.02 });
    (brick.map as THREE.Texture).repeat.set(3, 2);
    this.addBox(0, 3, 0, 14, 6, 14, brick);
    this.addBox(0, 6.5, 0, 14.4, 1, 14.4, wallMat);
    this.addBox(-25, 4, -25, 12, 8, 12, brick);
    this.addBox(25, 4, -25, 12, 8, 12, brick);
    this.addBox(-25, 4, 25, 12, 8, 12, brick);
    this.addBox(25, 4, 25, 12, 8, 12, brick);

    const coverMat = new THREE.MeshStandardMaterial({ map: sandTexture(), color: 0xc9b08a, roughness: 1, metalness: 0 });
    this.addBox(-12, 0.75, 8, 6, 1.5, 1.2, coverMat);
    this.addBox(12, 0.75, -8, 6, 1.5, 1.2, coverMat);
    this.addBox(8, 0.75, 15, 1.2, 1.5, 6, coverMat);
    this.addBox(-8, 0.75, -15, 1.2, 1.5, 6, coverMat);

    const wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.85, metalness: 0 });
    const crateSize = 2;
    const cratePositions: [number, number, number][] = [
      [-15, 0, 5], [-15, 2, 5], [-13, 0, 7], [15, 0, -5], [15, 2, -5], [17, 0, -7],
      [5, 0, 22], [7, 0, 22], [-5, 0, -22], [-7, 0, -22], [20, 0, 10], [20, 2, 10],
      [-20, 0, -10], [-20, 2, -10],
    ];
    for (const [x, y, z] of cratePositions) {
      this.addDestructible(x, y + crateSize / 2, z, crateSize, crateSize, crateSize, wood.clone(), "wood", 80, "crate");
    }

    const metal = new THREE.MeshStandardMaterial({ map: metalTexture(), color: 0xb5563a, roughness: 0.55, metalness: 0.65 });
    this.addBox(-30, 1.75, 0, 5, 3.5, 8, metal);
    this.addBox(30, 1.75, 0, 5, 3.5, 8, metal);
    const metal2 = new THREE.MeshStandardMaterial({ map: metalTexture(), color: 0x3a6a5a, roughness: 0.55, metalness: 0.65 });
    this.addBox(0, 1.75, -32, 8, 3.5, 5, metal2);
    this.addBox(0, 1.75, 32, 8, 3.5, 5, metal2);

    const barrelMat = new THREE.MeshStandardMaterial({ color: 0xb33a2a, roughness: 0.5, metalness: 0.7 });
    const barrelPositions: [number, number][] = [[-18, 12], [18, -12], [22, 18], [-22, -18], [10, 28], [-10, -28]];
    for (const [x, z] of barrelPositions) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.6, 16), barrelMat);
      b.position.set(x, 0.8, z); b.castShadow = true; b.receiveShadow = true;
      scene.add(b);
      colliders.push({ box: new THREE.Box3().setFromObject(b) });
    }
    // Task-3 — initial CSM material sweep (mirrors buildLevelFromMap).
    this._initialCSMSweep();
  }

  /** Add a static collider box. */
  addBox(x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material, surfaceType = "concrete"): THREE.Mesh {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.surfaceType = surfaceType;
    mesh.userData.materialSlug = SURFACE_MATERIAL_MAP[surfaceType] ?? "concrete";
    this.ctx.scene.add(mesh);
    this.ctx.colliders.push({ box: new THREE.Box3().setFromObject(mesh) });
    return mesh;
  }

  /** Add a destructible prop with multi-stage health. */
  addDestructible(x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material, materialSlug: string, hp: number, surfaceType = "wood"): THREE.Mesh {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.surfaceType = surfaceType;
    mesh.userData.materialSlug = materialSlug;
    mesh.userData.destructible = true;
    this.ctx.scene.add(mesh);
    const collider = { box: new THREE.Box3().setFromObject(mesh) };
    this.ctx.colliders.push(collider);
    this.ctx.destructibles.push({ mesh, health: hp, maxHealth: hp, materialSlug, stage: 0, collider, baseScale: 1 });
    return mesh;
  }

  /** Build sky shader sphere + sun disk.
   *  A3-5000 #444: use SkyShader from rendering2/daynight.ts which includes
   *  a sun disc + halo + atmospheric scattering tint. The prior inline
   *  shader only had a gradient mix.
   *  A3-5000 #418: set renderOrder=-1 + depthTest=false so the sky dome
   *  renders behind everything (was depthWrite:false + transparent:true
   *  with no explicit renderOrder — starfield could render behind the sky
   *  depending on draw order).
   *  A3-5000 #443: the sun sphere's position is tracked in `this._sunMesh`
   *  so updateWeatherVisuals can move it with sunLight.position (was fixed
   *  at (-80, 70, -120) → at night the sun sphere was still visible). */
  buildSky() {
    const skyGeo = new THREE.SphereGeometry(300, 32, 16);
    // A3-5000 #444: prefer the richer SkyShader from daynight.ts (has sun disc).
    let skyMat: THREE.ShaderMaterial;
    try {
      skyMat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms),
        vertexShader: SkyShader.vertexShader,
        fragmentShader: SkyShader.fragmentShader,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false, // A3-5000 #418: always behind scene geometry
      });
    } catch {
      // Fallback to the original inline gradient shader.
      skyMat = new THREE.ShaderMaterial({
        uniforms: {
          topColor: { value: new THREE.Color(0x4a6a8a) },
          midColor: { value: new THREE.Color(0xb8a37a) },
          bottomColor: { value: new THREE.Color(0xd4c4a0) },
        },
        vertexShader: `varying vec3 vWorldPos; void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vWorldPos=wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }`,
        fragmentShader: `uniform vec3 topColor; uniform vec3 midColor; uniform vec3 bottomColor; varying vec3 vWorldPos; void main(){ float h=normalize(vWorldPos).y; vec3 col; if(h>0.0){ col=mix(midColor,topColor,smoothstep(0.0,0.6,h)); } else { col=mix(midColor,bottomColor,smoothstep(0.0,-0.3,h)); } gl_FragColor=vec4(col,1.0); }`,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false, // A3-5000 #418
      });
    }
    this.ctx.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.ctx.skyMesh.renderOrder = -1; // A3-5000 #418: draw sky first
    this.ctx.scene.add(this.ctx.skyMesh);

    // A3-5000 #443: track the sun mesh so updateWeatherVisuals can move it.
    const sun = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 16), new THREE.MeshBasicMaterial({ color: 0xfff2d0, fog: false }));
    sun.position.set(-80, 70, -120);
    sun.renderOrder = -0.5; // A3-5000 #418: draw sun after sky but before world
    this._sunMesh = sun; // A3-5000 #443
    this.ctx.scene.add(sun);

    // E1-5000 #2371 — construct the canonical DayNightCycle (single sky system).
    // Initialized to the weather's current time-of-day; update(dt) advances it
    // + updateWeatherVisuals reads the synced time-of-day for sky/sun rendering.
    this._dayNight = new DayNightCycle();
    this._dayNight.setTimeOfDay(this.ctx.weather.timeOfDay);
  }

  /** A3-5000 #443: sun mesh reference (set in buildSky, moved in
   *  updateWeatherVisuals to track sunLight.position). */
  private _sunMesh: THREE.Mesh | null = null;
  /** E1-5000 #2371 — DayNightCycle instance. Wired as the CANONICAL
   *  time-of-day + sun-position authority so there's a single sky system
   *  (the prior code had a parallel DayNightCycle class in rendering2/daynight.ts
   *  that was never constructed — the RendererSystem re-implemented time-of-day
   *  math inline). The RendererSystem still owns the sky MESH + lights (deeply
   *  integrated with CSM/wetness/fog), but reads time-of-day + sun direction
   *  from this instance. */
  private _dayNight: DayNightCycle | null = null;

  /** Build hemisphere + directional sun + fill lights.
   *  V2 — brighter baseline so the map is always clearly visible.
   *  Boosted hemi intensity, added a persistent ambient floor, raised sun
   *  minimum, and added a warm fill so shadows aren't crushed.
   *
   *  Task-3 — Cascaded Shadow Maps (CSM). Attempts to construct a 3-cascade
   *  CSM (2048 shadow map per cascade, tight-near/soft-far practical split,
   *  100m radius coverage). CSM replaces the single sunLight shadow with 3
   *  cascaded frustums so shadows stay crisp from melee range out to the
   *  play-area edge. The sunLight is retained as the lighting reference
   *  (its color + intensity are synced to the CSM cascade lights every
   *  frame in updateWeatherVisuals) but its own shadow casting is disabled
   *  to avoid double-shadowing.
   *
   *  CSM injects a global shader chunk (`lights_fragment_begin`) that
   *  requires every lit material to have `csm.setupMaterial()` called so
   *  the per-cascade `CSM_cascades` uniform is injected. Materials without
   *  it fall back to the standard loop that adds ALL 3 cascade lights →
   *  3× over-bright. To handle dynamically spawned materials (enemies,
   *  pickups, finisher bosses, ragdolls), a periodic sweep in update()
   *  walks the scene + calls setupMaterial on any new material (tracked
   *  via a WeakSet so the cost is O(new materials) not O(all materials)).
   *
   *  If CSM construction throws (e.g. on a GPU lacking the required shader
   *  features), we fall back to the spec's documented single-light setup:
   *  4096 shadow map + 60m frustum + per-frame shadow-camera follow. */
  buildLights() {
    const { scene } = this.ctx;
    // Persistent ambient floor — guarantees the map never goes pitch black.
    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambient);
    this.ctx.hemiLight = new THREE.HemisphereLight(0xcbdcf0, 0x9a8a6a, 0.85);
    scene.add(this.ctx.hemiLight);
    this.ctx.sunLight = new THREE.DirectionalLight(0xffe8c4, 2.6);
    this.ctx.sunLight.position.set(-60, 70, -80);

    // ─── Task-3 — CSM attempt (quality-adaptive) ───
    // CSM cost scales linearly with cascades × shadowMapSize². 3×2048 = 3 extra
    // full-scene renders per frame at 4M texels each — that's the #1 GPU cost
    // on most hardware. Scale by detected tier:
    //   ultra/high: 3 cascades × 2048 (crisp shadows at range)
    //   medium:     2 cascades × 1024 (good balance)
    //   low:        skip CSM, single 1024 shadow map (perf-first)
    //
    // Task 3 / item 57 — integrated-GPU auto-degrade. CSM's per-frame cost
    // is brutal on integrated parts (Intel UHD, Mali, Adreno, Apple M-series
    // unified memory) because they share system RAM with the CPU. We read the
    // hardware profile's GPU classification + drop the cascade count one
    // tier (high→medium, medium→low, low→skip) when an integrated GPU is
    // detected. The user can still override via the settings panel — this is
    // the auto-detected starting point only.
    const hwProfileFull = (this.ctx.renderer as unknown as { _hwProfile?: { tier: string; renderer?: string; isMobile?: boolean; deviceMemoryGB?: number; cores?: number } })._hwProfile;
    const tier = hwProfileFull?.tier ?? "high";
    // Task 3 / item 57 — classify the GPU as discrete/integrated/unknown and
    // downgrade the effective shadow tier by one step on integrated parts.
    const isIntegrated = (() => {
      if (!hwProfileFull) return false;
      // Cheap inlined check — the full HardwareDetect.classifyGPU regex list
      // lives in HardwareDetect.ts but we want to avoid the import here (the
      // renderer system already imports a lot). Match a small high-signal
      // subset: mobile + low memory + known-integrated name patterns.
      const r = hwProfileFull.renderer ?? "";
      if (hwProfileFull.isMobile) return true;
      if (hwProfileFull.deviceMemoryGB !== undefined && hwProfileFull.deviceMemoryGB <= 2) return true;
      if (/intel.*hd|intel.*uhd|intel.*iris|radeon.*vega.*\b(8|11)\b|radeon.*graphics|mali-|adreno|powervr|apple.*m\d|apple gpu/i.test(r)) return true;
      return false;
    })();
    const effectiveTier = isIntegrated
      ? (tier === "ultra" ? "high" : tier === "high" ? "medium" : tier === "medium" ? "low" : "low")
      : tier;
    if (isIntegrated) {
      console.log(`[RendererSystem] Integrated GPU detected (renderer="${hwProfileFull?.renderer ?? "?"}") — auto-degrading shadow tier ${tier}→${effectiveTier}.`);
    }
    const csmCascades = effectiveTier === "low" ? 0 : effectiveTier === "medium" ? 2 : 3;
    const csmMapSize = effectiveTier === "medium" ? 1024 : 2048;
    let csmActive = false;
    if (csmCascades > 0) {
      try {
        this._csm = new CSM({
          camera: this.ctx.camera,
          parent: scene,
          cascades: csmCascades,
          shadowMapSize: csmMapSize,
          lightIntensity: 2.6,         // synced from sunLight each frame
          lightDirection: new THREE.Vector3(-1, -1, -1).normalize(),
          lightNear: 1,
          lightFar: 250,
          lightMargin: 30,
          maxFar: 200,                  // ~100m radius coverage
          mode: "practical",            // tight near, soft far
        });
        // CSM handles shadows now — disable sunLight's own shadow map.
        this.ctx.sunLight.castShadow = false;
        // Task-3 — DO NOT add sunLight to the scene when CSM is active. The
        // CSM shader chunk's non-shadow-light loop would add sunLight's diffuse
        // ON TOP of the CSM cascade's diffuse → ~1.7× over-bright. By keeping
        // sunLight out of the scene graph, it acts purely as a JS reference
        // (for position/color/intensity that PostProcessing's vol fog + the
        // sky/sun mesh positioning read), while the CSM cascade lights provide
        // all directional diffuse + shadow. CSM lights are synced from
        // sunLight each frame in updateShadowFollow.
        // (sunLight.target is also kept out — CSM lights have their own targets
        // managed by CSM.update().)
        // Tighten CSM shadow biases for the map size (smaller texels → smaller
        // bias). CSM applies the same bias to all cascades.
        for (const light of this._csm.lights) {
          light.shadow.bias = -0.0003;
          light.shadow.normalBias = 0.02;
        }
        csmActive = true;
        console.log(`[RendererSystem] CSM active (${csmCascades} cascades, ${csmMapSize}/cascade, tier=${tier}).`);
      } catch (err) {
        console.warn("[RendererSystem] CSM unavailable, falling back to single-light shadows:", err);
        this._csm = null;
      }
    } else {
      console.log(`[RendererSystem] CSM skipped (tier=${tier}), using single shadow map.`);
      this._csm = null;
    }

    if (csmActive) {
      // sunLight stays OUT of the scene (CSM lights provide all directional
      // diffuse). sunLight is kept as a JS reference for position/color/
      // intensity that other systems read (PostProcessing vol fog, sky/sun
      // mesh positioning, RendererSystem.updateShadowFollow CSM sync).
      // Intentionally do NOT scene.add(sunLight) or scene.add(sunLight.target).
    } else {
      // ─── Fallback: single 4096 shadow map + 60m frustum (per spec) ───
      // sunLight IS added to the scene (it's the sole directional light +
      // shadow caster in the fallback path).
      scene.add(this.ctx.sunLight);
      scene.add(this.ctx.sunLight.target);
      this.ctx.sunLight.castShadow = true;
      this.ctx.sunLight.shadow.mapSize.set(4096, 4096);
      this.ctx.sunLight.shadow.camera.near = 1;
      this.ctx.sunLight.shadow.camera.far = 250;
      // Task-3 — 60m frustum half-extent per the spec's fallback. Covers the
      // ~100m play area (walls at ±45) at ~68 texels/meter (4096/60).
      const s = 60;
      this.ctx.sunLight.shadow.camera.left = -s; this.ctx.sunLight.shadow.camera.right = s; this.ctx.sunLight.shadow.camera.top = s; this.ctx.sunLight.shadow.camera.bottom = -s;
      this.ctx.sunLight.shadow.bias = -0.0002;
      this.ctx.sunLight.shadow.normalBias = 0.025;
    }

    // Warm key fill from the opposite side — lifts shadowed faces.
    // A3-5000 #417: CSM's shader chunk expects ALL directional lights to be
    // cascades. Adding non-CSM DirectionalLights breaks the model (the chunk
    // sums ALL directional lights → over-bright + the cascade uniforms aren't
    // applied to the non-CSM lights → they render unlit black).
    // Fix: use RectAreaLight (which is NOT a DirectionalLight) for fill + rim
    // when CSM is active. RectAreaLight doesn't go through the directional
    // light loop so CSM's chunk isn't affected. In the fallback path
    // (no CSM), keep DirectionalLight fill + rim (cheaper + correct).
    if (csmActive) {
      try {
        // RectAreaLight requires the RectAreaLightUniformsLib helper to be
        // loaded; the import at the top of the file inits it lazily here.
        RectAreaLightUniformsLib.init();
        const fill = new THREE.RectAreaLight(0xa8c0e0, 0.65, 50, 50);
        fill.position.set(50, 40, 60);
        fill.lookAt(0, 0, 0);
        scene.add(fill);
        const rim = new THREE.RectAreaLight(0x8090b0, 0.4, 50, 50);
        rim.position.set(0, 30, -60);
        rim.lookAt(0, 0, 0);
        scene.add(rim);
      } catch {
        // RectAreaLightUniformsLib unavailable — skip fill/rim (CSM provides
        // sufficient diffuse anyway).
      }
    } else {
      const fill = new THREE.DirectionalLight(0xa8c0e0, 0.65);
      fill.position.set(50, 40, 60);
      scene.add(fill);
      // Cool rim light from behind for separation against the sky.
      const rim = new THREE.DirectionalLight(0x8090b0, 0.4);
      rim.position.set(0, 30, -60);
      scene.add(rim);
    }
  }

  /** Task-3 — Per-frame shadow update. Dispatches to CSM (if active) or the
   *  single-light shadow-camera follow (fallback).
   *
   *  CSM path: syncs the cascade lights' direction from sunLight.position,
   *  then calls csm.update() which recenters each cascade's shadow frustum
   *  on the camera's view frustum (tight near, soft far). Also runs a
   *  periodic material sweep so dynamically-spawned materials get
   *  setupMaterial() called (required for correct CSM-aware lighting).
   *
   *  Fallback path: recenters the single sunLight's shadow camera on the
   *  player's (x,z) position so the 60m shadow frustum always covers the
   *  player's vicinity at maximum texel density. */
  updateShadowFollow() {
    const { sunLight, player } = this.ctx;
    if (!sunLight) return;

    if (this._csm) {
      // ─── CSM path ───
      // Sync the CSM light direction from sunLight.position (the direction
      // the light TRAVELS = -normalize(sunPosition), since sunLight.position
      // points FROM origin TO the sun).
      const sp = sunLight.position;
      // Guard against a zero position (shouldn't happen, but defensive —
      // CSM.update() would NaN out otherwise).
      const len = Math.hypot(sp.x, sp.y, sp.z);
      if (len > 0.001) {
        this._csmLightDir.set(-sp.x, -sp.y, -sp.z).multiplyScalar(1 / len);
        this._csm.lightDirection.copy(this._csmLightDir);
      }
      // Sync the CSM cascade lights' color + intensity from sunLight
      // (updateWeatherVisuals sets these per time-of-day; we mirror them
      // to all cascades so the lit color matches the visible sun).
      for (const light of this._csm.lights) {
        light.color.copy(sunLight.color);
        light.intensity = sunLight.intensity;
      }
      // Update the cascade frustums (recenters on the camera's view frustum).
      try {
        this._csm.update();
      } catch (err) {
        // If CSM update throws (e.g. camera frustum degenerate), log + keep
        // CSM active. Removing CSM at runtime would leave already-compiled
        // materials with the CSM shader chunk + USE_CSM define but no CSM
        // cascade lights to drive it — they'd render unlit. Safer to skip
        // this update + retry next frame (the cascade lights stay at their
        // last known good positions; shadows may be 1 frame stale).
        console.warn("[RendererSystem] CSM update threw (non-fatal, retrying next frame):", err);
      }
      return;
    }

    // ─── Fallback: single-light shadow-camera follow ───
    if (!sunLight.castShadow) return;
    // Player's (x,z) — keep y=0 so the shadow camera centers on the ground
    // plane (the shadow frustum extends ±60 in x/z around this point).
    const px = player.pos.x;
    const pz = player.pos.z;
    // Preserve the sun's current (sy, offset) — set by updateWeatherVisuals
    // based on time of day. Only the (x,z) follows the player.
    const sy = sunLight.position.y;
    // The sun's (x,z) relative to its target (origin in updateWeatherVisuals)
    // gives the light direction. We translate both position + target by the
    // player's (x,z) so the direction is preserved.
    const dirX = sunLight.position.x - sunLight.target.position.x;
    const dirZ = sunLight.position.z - sunLight.target.position.z;
    sunLight.target.position.set(px, 0, pz);
    sunLight.position.set(px + dirX, sy, pz + dirZ);
    sunLight.target.updateMatrixWorld();
    sunLight.shadow.camera.updateProjectionMatrix();
  }

  /** Task-3 — Walk the scene + call csm.setupMaterial() on any new
   *  MeshStandardMaterial / MeshPhysicalMaterial that hasn't been set up
   *  yet (tracked via WeakSet). Required because CSM's injected shader
   *  chunk needs the per-cascade `CSM_cascades` uniform on every lit
   *  material; without it, materials fall back to the standard loop that
   *  adds ALL 3 cascade lights → 3× over-bright.
   *
   *  A3-5000 #455: also handle custom ShaderMaterials that use the CSM
   *  shader chunk (via `material.onBeforeCompile` injection). The prior code
   *  only set up `isMeshStandardMaterial` — custom ShaderMaterials using the
   *  CSM chunk got no per-cascade uniforms → rendered unlit/black.
   *  We detect CSM-aware custom materials via `material.defines?.USE_CSM`
   *  (CSM.setupMaterial sets this define) or `material.userData.csmRequired`.
   *
   *  Called once after buildLevel (initial sweep) + every ~0.5s in update()
   *  to catch dynamically-spawned materials (enemies, pickups, ragdolls,
   *  finisher bosses). The WeakSet makes the per-call cost O(new materials)
   *  not O(all materials) — already-setup materials are skipped via a Set
   *  membership check (O(1)). */
  private _setupCSMMaterials() {
    if (!this._csm) return;
    const csm = this._csm;
    const seen = this._csmMaterials;
    this.ctx.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of materials) {
        if (!m) continue;
        if (seen.has(m)) continue;
        const std = m as THREE.MeshStandardMaterial;
        if (std.isMeshStandardMaterial) {
          try {
            csm.setupMaterial(std);
            std.needsUpdate = true;
          } catch (err) {
            console.warn("[RendererSystem] CSM setupMaterial failed for a material:", err);
          }
        } else if (m instanceof THREE.ShaderMaterial) {
          // A3-5000 #455: custom ShaderMaterial using the CSM chunk.
          const wantsCSM = (m.defines && (m.defines as Record<string, unknown>).USE_CSM) ||
            (m.userData && (m.userData as Record<string, unknown>).csmRequired);
          if (wantsCSM) {
            try {
              csm.setupMaterial(m as unknown as THREE.MeshStandardMaterial);
              m.needsUpdate = true;
            } catch (err) {
              console.warn("[RendererSystem] CSM setupMaterial failed for a custom ShaderMaterial:", err);
            }
          }
        }
        seen.add(m);
      }
    });
  }

  /** R6.1 + Task-38 — Update sky colors, sun position, fog, and rain based on
   *  weather state. Called every 2s from WeatherSystem (throttled) so the
   *  day/night cycle visibly progresses.
   *
   *  Task-38 lighting model:
   *    - Midday (tod ≈ 12): bright white-yellow sun (~2.6 intensity), short
   *      shadows (sun high in sky).
   *    - Dawn/dusk (tod 6-8am, 5-7pm): warm orange sun (~0.6-1.5 intensity),
   *      long shadows (sun low on horizon).
   *    - Night (tod 22-4): dim blue moonlight (0.3 intensity, color 0x4a5a7a),
   *      moon replaces sun from the opposite direction (above horizon).
   *    - Smooth `nightness` factor (0 day, 1 deep night) lerps intensity +
   *      color so transitions are continuous — no popping at dawn/dusk edges.
   *    - Visibility floor preserved (sun >= 0.3, hemi >= 0.4) per Lead
   *      constraint — the map is ALWAYS clearly visible.
   *    - Starfield (500 white dots on a 250m hemisphere) fades in at dusk and
   *      out at dawn (opacity = nightness).
   *    - Fog thickens slightly at night (0.006 day → 0.015 night) for
   *      atmosphere, but never thick enough to hide the map.
   */
  updateWeatherVisuals() {
    const { weather, skyMesh, sunLight, hemiLight, scene } = this.ctx;
    const tod = weather.timeOfDay;
    const colors = skyColors(tod);
    if (skyMesh) {
      const mat = skyMesh.material as THREE.ShaderMaterial;
      // buildSky() has two possible shaders: the primary one (SkyShader from
      // rendering2/daynight.ts) uses uSunDirection/uSunColor/uZenithColor/
      // uHorizonColor/uTime; only the fallback (used if the primary shader's
      // construction throws) has topColor/midColor/bottomColor. The primary
      // shader construction doesn't actually throw, so this block was always
      // running against a material that didn't have these uniforms — this
      // guard prevents that crash. Weather-reactive gloom tinting simply
      // doesn't apply to the atmospheric SkyShader for now.
      if (mat.uniforms.topColor && mat.uniforms.midColor && mat.uniforms.bottomColor) {
        const wetBias = weather.wetness * weather.wetness;
        const gloomR = 0.2, gloomG = 0.22, gloomB = 0.26;
        const topR = colors.top[0] * (1 - wetBias) + gloomR * wetBias;
        const topG = colors.top[1] * (1 - wetBias) + gloomG * wetBias;
        const topB = colors.top[2] * (1 - wetBias) + gloomB * wetBias;
        const midR = colors.mid[0] * (1 - wetBias) + gloomR * wetBias;
        const midG = colors.mid[1] * (1 - wetBias) + gloomG * wetBias;
        const midB = colors.mid[2] * (1 - wetBias) + gloomB * wetBias;
        const botR = colors.bottom[0] * (1 - wetBias) + gloomR * wetBias;
        const botG = colors.bottom[1] * (1 - wetBias) + gloomG * wetBias;
        const botB = colors.bottom[2] * (1 - wetBias) + gloomB * wetBias;
        (mat.uniforms.topColor.value as THREE.Color).setRGB(topR, topG, topB);
        (mat.uniforms.midColor.value as THREE.Color).setRGB(midR, midG, midB);
        (mat.uniforms.bottomColor.value as THREE.Color).setRGB(botR, botG, botB);
      }
    }
    const sd = sunDirection(tod);
    const sunDist = 100;
    const nightness = this.computeNightness(tod); // 0 day → 1 deep night

    // ─── Sun / moon position ───
    // During the day the sun arcs east → west above the horizon (sd.elevation
    // ranges 0..π/2..0). At night the sun is below the horizon (negative
    // elevation), so we instead light from the opposite direction with the
    // moon above the horizon. A min y floor keeps dawn/dusk shadows from
    // stretching infinitely while still reading as "long" per spec.
    let sx: number, sy: number, sz: number;
    if (nightness > 0.5) {
      // Moon: opposite azimuth, elevation mirrored above horizon.
      sx = -Math.cos(sd.azimuth) * Math.cos(Math.abs(sd.elevation)) * sunDist;
      sy = Math.max(40, Math.sin(Math.abs(sd.elevation)) * sunDist);
      sz = -Math.sin(sd.azimuth) * Math.cos(Math.abs(sd.elevation)) * sunDist;
    } else {
      sx = Math.cos(sd.azimuth) * Math.cos(sd.elevation) * sunDist;
      // Allow the sun to dip low at dawn/dusk for long shadows, but keep a
      // 15m floor so shadow cascades don't degenerate.
      sy = Math.max(15, Math.sin(sd.elevation) * sunDist);
      sz = Math.sin(sd.azimuth) * Math.cos(sd.elevation) * sunDist;
    }

    if (sunLight) {
      sunLight.position.set(sx, sy, sz);
      sunLight.target.position.set(0, 0, 0);

      // A3-5000 #443: move the visible sun sphere to track sunLight.position
      // (was fixed at (-80, 70, -120) — at night the sun sphere was still
      // visible above the horizon). Position at a scaled offset so the sphere
      // sits well inside the sky dome along the light's direction.
      if (this._sunMesh) {
        const dir = sunLight.position.clone().normalize();
        this._sunMesh.position.copy(dir.multiplyScalar(150));
        // Hide the sun sphere at night (elevation ≤ 0 → below horizon).
        this._sunMesh.visible = sy > 5;
      }

      const cloudDim = 1 - weather.cloudCover * 0.35;

      // Day intensity peaks at noon (sd.intensity → 1), floors at 0.6 at the
      // horizon edges. Night intensity is the dim moonlight floor (0.3).
      const dayIntensity = Math.max(0.6, Math.max(0, sd.intensity) * 2.6) * cloudDim;
      const nightIntensity = 0.3 * cloudDim;
      sunLight.intensity = nightness * nightIntensity + (1 - nightness) * dayIntensity;

      // Color: warm orange (0xffb870) at dawn/dusk edges, white-yellow
      // (0xffe8c4) at midday, dim blue (0x4a5a7a) moonlight at night.
      const dayColorMid = new THREE.Color(0xffe8c4);
      const dayColorWarm = new THREE.Color(0xffb870);
      const nightColor = new THREE.Color(0x4a5a7a);
      // Warmth — 1 at horizon edges (low sun), 0 at midday. Only meaningful
      // during the day (nightness = 0).
      const warmth = (tod >= 6 && tod <= 18) ? Math.max(0, 1 - Math.max(0, sd.intensity) * 2.5) : 1;
      const dayColor = dayColorMid.clone().lerp(dayColorWarm, warmth);
      const finalColor = dayColor.lerp(nightColor, nightness);
      sunLight.color.copy(finalColor);
    }

    if (hemiLight) {
      // Min hemi 0.4 at night (per spec visibility floor), max(0.6, …) day.
      const dayHemi = Math.max(0.6, 0.85 * (1 - weather.cloudCover * 0.2));
      const nightHemi = 0.4;
      hemiLight.intensity = nightness * nightHemi + (1 - nightness) * dayHemi;

      const daySkyColor = new THREE.Color(0xcbdcf0);
      const dayGroundColor = new THREE.Color(0x9a8a6a);
      const nightSkyColor = new THREE.Color(0x4a5a7a);
      const nightGroundColor = new THREE.Color(0x3a3a4a);
      hemiLight.color.copy(daySkyColor.clone().lerp(nightSkyColor, nightness));
      hemiLight.groundColor.copy(dayGroundColor.clone().lerp(nightGroundColor, nightness));
    }

    // ─── Fog — slightly thicker at night (0.015) for atmosphere, thinner day (0.006) ───
    const baseFog = 0.006 + nightness * 0.009;
    const rainFog = weather.precipitation > 0.3 ? 0.018 : 0;
    const fogDensity = baseFog + rainFog + weather.fogDensity;
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.density = fogDensity;
      // Task-3 — fog color also lerps toward the wet gloom color so rainy
      // weather reads consistently across sky + fog + horizon haze.
      const wetFog = weather.wetness * weather.wetness;
      const fogR = colors.mid[0] * 0.85 * (1 - wetFog) + 0.2 * wetFog;
      const fogG = colors.mid[1] * 0.85 * (1 - wetFog) + 0.22 * wetFog;
      const fogB = colors.mid[2] * 0.85 * (1 - wetFog) + 0.26 * wetFog;
      scene.fog.color.setRGB(fogR, fogG, fogB);
    }

    // ─── Starfield — fade in at dusk, fade out at dawn ───
    if (nightness > 0.01) {
      if (!this.starfield) this.starfield = this.createStarfield();
      this.starfield.visible = true;
      (this.starfield.material as THREE.PointsMaterial).opacity = nightness;
    } else if (this.starfield) {
      this.starfield.visible = false;
    }

    // ─── Task-3 — Surface wetness (Prompt #9). Lerp the ground material's
    //   roughness DOWN (glossier) + envMapIntensity UP (sharper sky reflection)
    //   based on weather.wetness (0=dry, 1=soaking). Wet asphalt reflects the
    //   sky like a mirror — the single biggest "rainy day" visual cue.
    //   - roughness: dry 0.95 → wet 0.30 (per Prompt #9 spec; water film
    //     is smooth but not a perfect mirror at 0.3 — preserves surface texture)
    //   - envMapIntensity: dry 1.15 → wet 3.0 (mirror-like sky reflection;
    //     acts as the clearcoat-like boost the spec asks for)
    //   The lerp is biased so even light rain (wetness=0.3) produces a
    //   visible sheen — dry→wet is more visually dramatic than the linear
    //   wetness value would suggest. ───
    this.applyWetness(weather.wetness);
  }

  /** Task-3 — Find + cache the ground material on first call, then apply
   *  wetness by lerping the cached dry-state roughness + envMapIntensity.
   *
   *  A3-5000 #416: previously only wetted ONE cached ground material. Now we
   *  wet ALL ground-type materials (multiple ground meshes: roads, sidewalks,
   *  walls-as-floors in multi-level maps). The cache stores a list of
   *  { mat, baseRoughness, baseEnvMapIntensity } tuples; applyWetness walks
   *  the list + lerps each.
   *  A3-5000 #415: findGroundMaterial now checks orientation (geometry normal
   *  must point up) — was matching any unrotated mesh with rotX ≈ 0, which
   *  caught large vertical facades in the XY plane (rotX = 0, width ≥ 50).
   */
  private applyWetness(wetness: number) {
    // A3-5000 #416: cache a LIST of ground materials, not just one.
    if (!this._groundMaterialsPopulated) {
      this._groundMaterials = this.findAllGroundMaterials();
      this._groundMaterialsPopulated = true;
      if (this._groundMaterials.length === 0) return;
      for (const entry of this._groundMaterials) {
        entry.baseRoughness = entry.mat.roughness;
        entry.baseEnvMapIntensity = entry.mat.envMapIntensity ?? 1.0;
      }
    }
    const w = Math.min(1, Math.max(0, wetness));
    const wetBias = w * w;
    for (const entry of this._groundMaterials) {
      entry.mat.roughness = entry.baseRoughness * (1 - wetBias) + 0.30 * wetBias;
      entry.mat.envMapIntensity = entry.baseEnvMapIntensity * (1 - wetBias) + 3.0 * wetBias;
    }
  }

  /** A3-5000 #416: list of ground materials + their dry-state baselines. */
  private _groundMaterials: Array<{ mat: THREE.MeshStandardMaterial; baseRoughness: number; baseEnvMapIntensity: number }> = [];
  private _groundMaterialsPopulated = false;
  /** A3-5000 #415 / #416: walk the scene for ALL ground-like meshes + collect
   *  their materials. The orientation check (geometry normal pointing up)
   *  prevents vertical facades from being mistaken for ground. */
  private findAllGroundMaterials(): Array<{ mat: THREE.MeshStandardMaterial; baseRoughness: number; baseEnvMapIntensity: number }> {
    const out: Array<{ mat: THREE.MeshStandardMaterial; baseRoughness: number; baseEnvMapIntensity: number }> = [];
    this.ctx.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry as THREE.PlaneGeometry;
      const params = geo?.parameters as { width?: number; height?: number } | undefined;
      if (!params) return;
      const w = params.width ?? 0;
      const h = params.height ?? 0;
      if (Math.max(w, h) < 50) return;
      // A3-5000 #415: orientation check — compute the geometry's world-space
      // normal. A PlaneGeometry in the XY plane has normal +Z; rotated -π/2
      // around X, its normal becomes +Y (up). A vertical facade in the XY
      // plane (rotX = 0) has normal ±Z (NOT up) → reject.
      const normal = new THREE.Vector3(0, 0, 1).applyEuler(mesh.rotation);
      if (normal.y < 0.85) return; // A3-5000 #415: require near-up normal
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        out.push({
          mat: mat as THREE.MeshStandardMaterial,
          baseRoughness: (mat as THREE.MeshStandardMaterial).roughness,
          baseEnvMapIntensity: (mat as THREE.MeshStandardMaterial).envMapIntensity ?? 1.0,
        });
      }
    });
    return out;
  }

  /** Task-38 — Smooth "nightness" factor (0 = full day, 1 = full night).
   *  Dawn fades 4-6am (1→0), dusk fades 6-10pm (0→1). Between 10pm-4am it's
   *  full night; between 6am-6pm it's full day. */
  private computeNightness(tod: number): number {
    if (tod >= 22 || tod < 4) return 1; // deep night
    if (tod >= 4 && tod < 6) return (6 - tod) / 2; // dawn fade
    if (tod >= 6 && tod < 18) return 0; // day
    if (tod >= 18 && tod < 22) return (tod - 18) / 4; // dusk fade
    return 1;
  }

  /** Task-38 — Build the starfield: 500 white points scattered on the upper
   *  hemisphere of a 250m sphere (inside the 300m sky dome). Fog disabled so
   *  distant stars stay visible at night. */
  private createStarfield(): THREE.Points {
    const count = 500;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Uniformly distribute on upper hemisphere via (u, v) parametrization.
      const u = Math.random();
      const v = Math.random() * 0.5; // 0..0.5 → upper hemisphere only
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(1 - 2 * v); // 0..π/2
      const r = 250;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.7,
      transparent: true,
      opacity: 0,
      fog: false,
      sizeAttenuation: true,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false; // sky — always render regardless of camera
    points.renderOrder = -1; // behind world geometry
    this.ctx.scene.add(points);
    return points;
  }

  /** Muzzle flash texture (used by WeaponSystem too). */
  muzzleTexture() {
    return particleTexture("rgb(255,200,80)");
  }

  update(dt: number) {
    // Prompt A#5 — skip all rendering work while the WebGL context is
    // lost. The renderer's render targets + textures are invalid; calling
    // renderer.render() would throw or render garbage. The
    // `webglcontextrestored` listener calls handleContextRestored() which
    // re-establishes the GPU state + renders one frame, then the loop
    // resumes normally.
    if (this.ctx.contextLost) return;
    // Section A — kick off the WebGPU probe on first update (so it doesn't
    // block the constructor). The result is cached + read by the host on
    // subsequent frames.
    if (!this._webgpuProbed) void this._probeWebGPU();
    // E1-5000 #2371 — advance the canonical DayNightCycle (single sky system).
    // Syncs weather.timeOfDay from the cycle so updateWeatherVisuals renders
    // the correct sky/sun. The DayNightCycle's autoAdvanceRate drives the
    // time-of-day forward; updateWeatherVisuals (called below by the engine
    // or on weather changes) reads weather.timeOfDay.
    if (this._dayNight) {
      this._dayNight.update(dt);
      // Sync the weather time-of-day from the cycle (the cycle is the authority).
      this.ctx.weather.timeOfDay = this._dayNight.getTimeOfDay();
    }
    // Render call is invoked from engine loop after all systems update.
    // We don't render here to keep the system boundary clean — engine calls renderer.render.
    // Task-3 — per-frame shadow update: CSM cascade recentering (if active) or
    // single-light shadow-camera follow (fallback). Cheap (no GPU work — just
    // matrix updates that the next shadow render will pick up).
    this.updateShadowFollow();
    // Task-3 — periodic CSM material sweep (every ~0.5s). Catches dynamically
    // spawned materials (enemies, pickups, ragdolls, finisher bosses) so they
    // get csm.setupMaterial() called — required for correct CSM-aware lighting
    // (without it, materials fall back to the standard loop that adds all 3
    // cascade lights → 3× over-bright). The WeakSet makes the per-call cost
    // O(new materials) not O(all materials).
    if (this._csm) {
      this._csmSweepAccum += dt;
      if (this._csmSweepAccum >= 0.5) {
        this._csmSweepAccum = 0;
        this._setupCSMMaterials();
      }
    }
    // Prompt A#6 — decay the context-loss log once per minute so a device
    // that had a bad day recovers to full quality after ~12h of clean
    // uptime. The decay function drops log entries older than 12h.
    this._lastDecayCheck += dt;
    if (this._lastDecayCheck >= 60) {
      this._lastDecayCheck = 0;
      try { decayContextLossLog(); } catch { /* best-effort */ }
    }
  }

  /** Task-3 — Initial CSM material sweep. Called once after the level is
   *  built (from buildLevelFromMap + buildLevel) so all static level geometry
   *  materials get csm.setupMaterial() called before the first render.
   *  Dynamic materials (enemies, etc.) are caught by the periodic sweep in
   *  update(). */
  private _initialCSMSweep() {
    if (!this._csm) return;
    this._setupCSMMaterials();
  }

  onResize() {
    const { camera, renderer, container } = this.ctx;
    const w = container.clientWidth; const h = container.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Prompt A#5 — WebGL context-loss recovery.
  // ─────────────────────────────────────────────────────────────────────────

  /** Called by the engine on `webglcontextrestored` (via ctx.onContextRestored).
   *  Walks every texture + material in the scene + texture registry, marks
   *  them for re-upload to the new WebGL context, rebuilds render targets,
   *  and forces a CSM material re-sweep so the cascade shadow shaders
   *  recompile. After this returns, the engine loop resumes rendering.
   *
   *  Three.js's WebGLRenderer automatically re-uploads textures + shaders
   *  on the next render call IF `texture.needsUpdate` / `material.needsUpdate`
   *  is set. The walk below sets those flags on every GPU resource we know
   *  about; the next render frame re-establishes the entire GPU state.
   *
   *  Acceptance: simulate context loss via chrome://gpu "Lose context" —
   *  the match resumes within 2s with no black screen. */
  handleContextRestored(): void {
    const { scene, renderer } = this.ctx;
    // 1. Walk every Mesh + Line + Points in the scene + mark materials
    //    + textures for re-upload. The traverse is O(N meshes) which on
    //    this codebase is ~600 objects — fast (<5ms).
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Mark material(s) for recompile.
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m) continue;
        m.needsUpdate = true;
        // Walk material uniforms for textures + mark them dirty.
        const std = m as THREE.MeshStandardMaterial;
        const texProps: (keyof THREE.MeshStandardMaterial)[] = [
          "map", "normalMap", "roughnessMap", "metalnessMap", "aoMap",
          "emissiveMap", "bumpMap", "displacementMap", "alphaMap",
          "envMap",
        ];
        for (const k of texProps) {
          const t = std[k] as unknown as THREE.Texture | null | undefined;
          if (t) t.needsUpdate = true;
        }
      }
      // Mark geometry for re-upload (WebGLBuffer is invalidated).
      const geo = mesh.geometry;
      if (geo) geo.dispose(); // dispose forces re-upload on next render
    });
    // 2. Force the renderer's internal state to refresh — Three.js
    //    WebGLRenderer auto-detects context loss on the next render call,
    //    but calling setViewport + setSize re-establishes the GL viewport
    //    + scissor state immediately.
    try {
      const w = this.ctx.container.clientWidth;
      const h = this.ctx.container.clientHeight;
      renderer.setSize(w, h);
      renderer.setViewport(0, 0, w, h);
    } catch { /* best-effort */ }
    // 3. Reset the CSM material WeakSet so all materials get
    //    csm.setupMaterial() re-called (the CSM shader chunk is compiled
    //    into each material; the compile cache was invalidated by context
    //    loss). The next update() tick's periodic sweep (or the immediate
    //    _initialCSMSweep call below) re-visits every material.
    this._csmMaterials = new WeakSet();
    try { this._setupCSMMaterials(); } catch { /* best-effort */ }
    // 4. Invalidate the env-raycast-target cache (the scene graph is
    //    unchanged but the GPU resources are new — the cache is keyed on
    //    scene.children.length so it'd still be valid, but the GPU-side
    //    VBOs are stale; the cache holds Object3D refs not GPU refs so
    //    this is just defensive).
    // (No import to avoid a cycle — the cache auto-rebuilds on sig change.)
    // 5. If PostProcessing exists, signal it to rebuild its render
    //    targets (the WebGLFramebuffers are invalidated by context loss).
    const postProc = this.ctx.postProc as unknown as
      | { handleContextRestored?: () => void }
      | null;
    if (postProc?.handleContextRestored) {
      try { postProc.handleContextRestored(); } catch { /* best-effort */ }
    }
    // 6. Render one frame immediately so the user sees the restored
    //    scene without waiting for the next loop tick (eliminates the
    //    "black flash" between restore + first render).
    try {
      renderer.render(scene, this.ctx.camera);
    } catch { /* best-effort — next loop tick will render */ }
  }
}
