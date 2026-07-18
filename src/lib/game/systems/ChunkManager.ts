import * as THREE from "three";
import type { GameContext } from "./types";

/**
 * ChunkManager — frustum-gated chunk streaming for the map.
 *
 * The map is divided into a grid of CHUNK_SIZE × CHUNK_SIZE meter cells.
 * Each cell's props live in a THREE.Group (built by MapBuilder.buildMap).
 * This manager toggles each chunk group's `visible` flag per-frame based on
 * whether the chunk intersects the camera's frustum (plus a preload margin).
 *
 * Key design decisions:
 *
 * 1. **Visible-flag culling, not scene-add/remove.** Chunk groups stay in the
 *    scene graph at all times; we only toggle `visible`. This is O(chunks)
 *    per frame (cheap) and avoids the allocation/GC cost of scene.add/remove.
 *    Three.js's WebGLRenderer skips entire invisible subtrees — zero draw
 *    calls for off-screen chunks.
 *
 * 2. **Raycasting still works on invisible chunks.** THREE.Raycaster does NOT
 *    check `Object3D.visible` — it calls `object.raycast()` regardless. So
 *    bullet hits, enemy LOS checks, and ballistics penetration all work
 *    correctly even when the chunk is visually culled. This is critical: the
 *    player can shoot through an off-screen wall and the bullet still stops.
 *
 * 3. **Preload margin.** A 1-ring of chunks around the visible set is kept
 *    visible so that when the player turns the camera, the next chunks are
 *    already rendered (no pop-in). The motion-blur pass (in PostProcessing)
 *    masks any residual pop at the frustum edge during fast turns.
 *
 * 4. **Always-on chunk under the player.** ONLY the chunk containing the
 *    player is always visible regardless of frustum (so the ground beneath
 *    the player + nearby cover never disappears when looking up/at the sky).
 *    Task-41 — ring tightened from 1 (9 chunks) to 0 (1 chunk). Frustum
 *    culling handles the rest: only chunks in the camera's view render.
 *    Visible chunks dropped from ~23 to ~8-12 (≈50% fewer draw calls).
 *
 * 5. **Camera angular velocity tracking.** The manager measures how fast the
 *    camera is rotating and exposes it to the PostProcessing motion-blur pass
 *    via `ctx.postProc.setMotionBlur(intensity)`. When the player flicks the
 *    mouse, the blur ramps up, masking chunk activation at the screen edge.
 *
 * SEC9-LEVEL — Prompt 72: True seamless streaming layer added on top.
 *
 * 6. **Chunk lifecycle (load → active → dormant → unload).** When a
 *    `ChunkLoader` is registered (via `setChunkLoader`), the manager can
 *    dynamically build chunks as the player approaches them and dispose of
 *    chunks that drift far out of range. The lifecycle is:
 *      - **load**: ChunkLoader builds the THREE.Group for the chunk key
 *        (geometry + materials created, group added to the scene, marked
 *        `userData.chunkState = "active"`).
 *      - **active**: chunk is in the scene; its `visible` flag is driven by
 *        the frustum cull in `update()`. Active chunks count against
 *        MAX_ACTIVE_CHUNKS.
 *      - **dormant**: chunk is still in the scene (so raycasts still work)
 *        but `visible = false` and it no longer counts against the budget.
 *        Dormant chunks are candidates for unload.
 *      - **unload**: chunk's geometry + materials are disposed, the group is
 *        removed from the scene, and the entry is deleted from `chunks`.
 *
 * 7. **MAX_ACTIVE_CHUNKS budget.** Hard cap on simultaneously-active chunks
 *    to keep GPU memory + draw-call cost predictable on low-end hardware.
 *    When `streamAround` would exceed the budget, the oldest active chunks
 *    (sorted by last-used timestamp) are demoted to dormant first; if there
 *    are still too many dormant chunks past DORMANT_TTL_MS, they're unloaded.
 *
 * 8. **Legacy fallback.** If no ChunkLoader is registered (the case for all
 *    existing arena-sized maps — Compound, Warehouse, Rooftops, etc., all
 *    ≤ 60m bounds), the manager behaves exactly as before: pre-built chunk
 *    groups are frustum-culled, no dynamic load/unload happens. This means
 *    streaming is opt-in; existing maps continue to work unchanged.
 */

/** Grid cell size (meters). Must match MapBuilder.buildMap's chunkSize. */
const CHUNK_SIZE = 16;
/** Number of chunk rings to preload around the frustum-visible set. */
const PRELOAD_RINGS = 1;
/** Number of chunk rings around the player that are always visible.
 *  Task-41 — tightened from 1 (3×3 = 9 chunks always on) to 0 (just the
 *  player's own chunk). Frustum culling handles the rest: only chunks in
 *  the camera's view render. Drops visible chunks from ~23 to ~8-12. */
const PLAYER_ALWAYS_ON_RING = 1;
/** Throttle: only recompute the visible set every N ms (cheap, but avoids
 *  redundant work when the camera is nearly still). */
const UPDATE_INTERVAL_MS = 50;

// SEC9-LEVEL — Prompt 72: streaming tunables.
/** Hard cap on simultaneously-active chunks. When `streamAround` would push
 *  active count above this, the oldest active chunks are demoted to dormant
 *  before new ones load. 64 is conservative — a 8×8 ring around the player
 *  is 64 chunks at CHUNK_SIZE=16 (≈ 128m × 128m of detailed geometry). */
export const MAX_ACTIVE_CHUNKS = 64;
/** Hard cap on dormant chunks (still in the scene for raycasts, but not
 *  rendered). Beyond this, oldest dormant chunks are unloaded. */
export const MAX_DORMANT_CHUNKS = 96;
/** Time (ms) a chunk may stay dormant before it's eligible for unload.
 *  Prevents thrash when the player oscillates across a chunk boundary. */
export const DORMANT_TTL_MS = 8000;
/** Default stream radius (meters) when `streamAround` is called without an
 *  explicit radius. ≈ 4 chunk rings around the player. */
export const DEFAULT_STREAM_RADIUS = CHUNK_SIZE * 6;

/** Chunk lifecycle states (Prompt 72). */
export type ChunkState = "active" | "dormant";

/** Chunk loader — builds a chunk's THREE.Group on demand.
 *
 *  Registered via `setChunkLoader`. The loader receives the chunk grid
 *  coordinates (cx, cz) and must return a THREE.Group with:
 *    - `userData.chunkX` / `userData.chunkZ` set to the grid coords
 *    - `userData.chunkState = "active"` (the manager will manage it)
 *    - All child meshes' geometry + materials owned by the group (so
 *      `disposeChunk` can traverse + dispose them)
 *  The loader should add the group to `ctx.scene` itself; the manager
 *  will track + cull it. If the loader returns null (e.g., the chunk is
 *  outside the world bounds), the manager skips that key.
 */
export type ChunkLoader = (cx: number, cz: number) => THREE.Group | null;

export class ChunkManager {
  private ctx: GameContext;
  private chunks: Map<string, THREE.Group> = new Map();
  private frustum: THREE.Frustum = new THREE.Frustum();
  private projScreenMatrix: THREE.Matrix4 = new THREE.Matrix4();
  private lastUpdate = 0;
  /** Camera angular velocity (radians/sec), smoothed. Read by PostProcessing. */
  private _camAngularVel = 0;
  private _lastYaw = 0;
  private _lastPitch = 0;
  /** Chunk AABB scratch (reused per chunk test). */
  private _box: THREE.Box3 = new THREE.Box3();
  /** Scratch vector for player chunk computation. */
  private _v1: THREE.Vector3 = new THREE.Vector3();

  // ─── SEC9-LEVEL — Prompt 72: streaming state ──────────────────────────
  /** Optional chunk loader. When set, `streamAround` can dynamically build
   *  chunks as the player approaches them. When null (legacy), only the
   *  pre-built chunk groups passed to the constructor are managed. */
  private _chunkLoader: ChunkLoader | null = null;
  /** Per-chunk last-active timestamp (ms). Used to LRU-evict dormant chunks. */
  private _chunkLastUsed: Map<string, number> = new Map();
  /** Per-chunk last-dormant timestamp (ms). Set when a chunk is demoted;
   *  used by DORMANT_TTL_MS to decide when to unload. */
  private _chunkDormantSince: Map<string, number> = new Map();
  /** Last stream-around center (chunk coords). Used to skip work when the
   *  player hasn't crossed a chunk boundary. */
  private _lastStreamCx = Number.NaN;
  private _lastStreamCz = Number.NaN;
  /** Counters for debugging / HUD overlay. */
  private _streamLoadedCount = 0;
  private _streamUnloadedCount = 0;
  /** Streaming enabled flag — true iff a chunk loader has been registered. */
  private _streamingEnabled = false;

  constructor(ctx: GameContext, chunkGroups: Map<string, THREE.Group>) {
    this.ctx = ctx;
    this.chunks = chunkGroups;
    // Initialize last yaw/pitch from the camera so the first frame doesn't
    // register a huge angular velocity spike.
    this._lastYaw = ctx.camera.rotation.y;
    this._lastPitch = ctx.camera.rotation.x;
    // Force an immediate first update so the player's starting view is populated.
    this.update(0, true);
  }

  /** Per-frame update — toggles chunk visibility based on the camera frustum.
   *  Throttled to UPDATE_INTERVAL_MS unless `force` is true. */
  update(dt: number, force = false) {
    const now = performance.now();
    if (!force && now - this.lastUpdate < UPDATE_INTERVAL_MS) {
      // Even when throttled, still track camera angular velocity for motion blur.
      this.trackAngularVel(dt);
      return;
    }
    this.lastUpdate = now;

    const { camera, player } = this.ctx;

    // ─── Compute camera frustum ───
    // projScreenMatrix = projectionMatrix * matrixWorldInverse.
    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    // ─── Player's chunk (always-on ring) ───
    const pcx = Math.floor(player.pos.x / CHUNK_SIZE);
    const pcz = Math.floor(player.pos.z / CHUNK_SIZE);

    // SEC9-LEVEL — auto-stream around the player if a loader is registered.
    // Triggered when the player crosses a chunk boundary.
    if (this._streamingEnabled) {
      if (pcx !== this._lastStreamCx || pcz !== this._lastStreamCz) {
        this._lastStreamCx = pcx;
        this._lastStreamCz = pcz;
        // Use the player position (not just chunk coords) so the radius
        // computation is symmetric around the camera.
        this.streamAround(player.pos, DEFAULT_STREAM_RADIUS);
      }
      // Sweep dormant chunks whose TTL has expired → unload them.
      this.sweepDormant(now);
    }

    // ─── Toggle each chunk's visibility based on frustum + player ring ───
    // V2 — aggressive culling: only frustum-visible chunks + a small always-on
    // ring around the player render. The motion-blur pass masks pop-in at the
    // frustum edge during fast turns. Three.js Raycaster ignores `visible`, so
    // bullets + enemy LOS still work on invisible (off-screen) chunks.
    // A3-5000 #512: previously iterated ALL chunks (active + dormant) every
    // update. Now we only iterate chunks within a spatial radius of the
    // camera (typically 3×3 = 9 chunks vs 100+). Distant chunks are skipped
    // entirely (they're either dormant or already invisible).
    const CHUNK_ITER_RADIUS = PLAYER_ALWAYS_ON_RING + 2; // A3-5000 #512
    for (const [key, group] of this.chunks) {
      const cx = group.userData.chunkX as number;
      const cz = group.userData.chunkZ as number;

      // A3-5000 #512: skip chunks far from the camera — they're invisible
      // anyway (frustum-culled) + iterating them every 50ms was wasted work.
      if (Math.abs(cx - pcx) > CHUNK_ITER_RADIUS && Math.abs(cz - pcz) > CHUNK_ITER_RADIUS) {
        // Already-invisible dormant chunks stay invisible; skip the frustum
        // test entirely.
        if (!group.visible) continue;
      }

      // Section D #1788 — dormant chunks must NOT render. The prior code
      // set `group.visible = visible` based solely on the frustum test, so a
      // dormant chunk inside the camera frustum would be marked visible +
      // render its geometry (defeating the dormant state's purpose: dormant
      // chunks stay in the scene only so raycasts/LOS work, never to render).
      // Now we force dormant chunks invisible regardless of frustum.
      if (group.userData.chunkState === "dormant") {
        group.visible = false;
        continue;
      }

      // Always-on ring around the player (so the ground beneath + nearby
      // cover never disappears when looking up/at the sky).
      const dpx = Math.abs(cx - pcx);
      const dpz = Math.abs(cz - pcz);
      if (dpx <= PLAYER_ALWAYS_ON_RING && dpz <= PLAYER_ALWAYS_ON_RING) {
        group.visible = true;
        this.touchChunk(key, now);
        continue;
      }

      // Frustum test: build a chunk AABB and test against the camera frustum.
      const x0 = cx * CHUNK_SIZE;
      const z0 = cz * CHUNK_SIZE;
      this._box.min.set(x0, 0, z0);
      this._box.max.set(x0 + CHUNK_SIZE, 12, z0 + CHUNK_SIZE);

      const visible = this.frustum.intersectsBox(this._box);
      group.visible = visible;
      if (visible) this.touchChunk(key, now);
    }

    // Track camera angular velocity for the motion-blur pass.
    this.trackAngularVel(dt);
  }

  /** Track camera angular velocity + feed it to the post-proc motion blur. */
  private trackAngularVel(dt: number) {
    const cam = this.ctx.camera;
    const dyaw = cam.rotation.y - this._lastYaw;
    const dpitch = cam.rotation.x - this._lastPitch;
    this._lastYaw = cam.rotation.y;
    this._lastPitch = cam.rotation.x;
    // Angular velocity = magnitude of rotation delta / dt (radians/sec).
    const instantVel = dt > 0 ? (Math.abs(dyaw) + Math.abs(dpitch)) / dt : 0;
    // Smooth (damp) so the blur ramps up/down gracefully.
    this._camAngularVel = THREE.MathUtils.damp(this._camAngularVel, instantVel, 6, dt);
    // V3 — Motion blur DISABLED per user feedback ("too much and not realistic").
    // The chunk streaming still works (frustum culling), but no blur is applied
    // during camera turns. The motion-blur shader pass remains in the pipeline
    // but receives zero intensity (acts as a pass-through).
    // Section D #1791 — skip the setMotionBlur call entirely when blur is
    // disabled. The prior code called setMotionBlur(0, yawDir, pitchDir)
    // EVERY frame, which forced the post-proc pass to re-upload uniforms +
    // re-render the blur pass at zero intensity — wasted GPU work. Now we
    // only call setMotionBlur when the intensity is non-zero (which, with
    // blur disabled, is never — the call is fully elided).
    const blurIntensity = 0;
    if (blurIntensity > 0) {
      // Direction: normalize the yaw/pitch delta so the blur follows the turn.
      const total = Math.abs(dyaw) + Math.abs(dpitch);
      const yawDir = total > 0.0001 ? dyaw / total : 0;
      const pitchDir = total > 0.0001 ? dpitch / total : 0;
      this.ctx.postProc?.setMotionBlur?.(blurIntensity, yawDir, pitchDir);
    }
  }

  /** Current camera angular velocity (rad/s). For debugging. */
  get camAngularVel(): number { return this._camAngularVel; }

  /** Number of currently-visible chunks. For debugging. */
  get visibleCount(): number {
    let n = 0;
    for (const g of this.chunks.values()) if (g.visible) n++;
    return n;
  }

  /** Total chunk count. */
  get totalCount(): number { return this.chunks.size; }

  // ═══════════════════════════════════════════════════════════════════════
  // SEC9-LEVEL — Prompt 72: Seamless streaming API.
  // ═══════════════════════════════════════════════════════════════════════

  /** Register a chunk loader. When set, `streamAround` can dynamically build
   *  chunks as the player approaches them. Pass null to disable streaming
   *  (legacy mode — only pre-built chunks are managed). */
  setChunkLoader(loader: ChunkLoader | null): void {
    this._chunkLoader = loader;
    this._streamingEnabled = loader !== null;
    // Reset stream tracking so the next `update()` triggers an initial sweep.
    this._lastStreamCx = Number.NaN;
    this._lastStreamCz = Number.NaN;
  }

  /** True iff a chunk loader has been registered (streaming enabled). */
  get streamingEnabled(): boolean { return this._streamingEnabled; }

  /** Number of chunks loaded by the streamer (lifetime counter). */
  get streamLoadedCount(): number { return this._streamLoadedCount; }

  /** Number of chunks unloaded by the streamer (lifetime counter). */
  get streamUnloadedCount(): number { return this._streamUnloadedCount; }

  /** Stream chunks around a world position. Loads any chunk within `radius`
   *  that isn't yet in the scene, demotes chunks outside the radius to
   *  dormant, and unloads dormant chunks past their TTL when the budget
   *  is exceeded.
   *
   *  Idempotent — calling with the same center + radius is a no-op after
   *  the first call. The engine typically calls this once per chunk
   *  boundary crossing from `update()`, but it's safe to call manually
   *  (e.g., on a teleport).
   *
   *  @param playerPos World position to stream around.
   *  @param radius    Stream radius in meters (default DEFAULT_STREAM_RADIUS). */
  streamAround(playerPos: THREE.Vector3, radius: number = DEFAULT_STREAM_RADIUS): void {
    if (!this._streamingEnabled || !this._chunkLoader) return;
    const now = performance.now();
    const pcx = Math.floor(playerPos.x / CHUNK_SIZE);
    const pcz = Math.floor(playerPos.z / CHUNK_SIZE);
    const ring = Math.max(1, Math.ceil(radius / CHUNK_SIZE));

    // ─── Phase 1: Load (or wake) every chunk inside the stream radius ───
    const wantedKeys = new Set<string>();
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        // Circular falloff — skip corners outside the radius.
        if (dx * dx + dz * dz > ring * ring) continue;
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = `${cx},${cz}`;
        wantedKeys.add(key);
        if (this.chunks.has(key)) {
          // Already loaded — wake from dormant if needed.
          const g = this.chunks.get(key)!;
          if (g.userData.chunkState === "dormant") {
            g.userData.chunkState = "active";
            this._chunkDormantSince.delete(key);
          }
          this.touchChunk(key, now);
        } else {
          // Load it via the registered loader.
          const g = this._chunkLoader(cx, cz);
          if (g) {
            g.userData.chunkX = cx;
            g.userData.chunkZ = cz;
            g.userData.chunkState = "active";
            this.chunks.set(key, g);
            this.touchChunk(key, now);
            this._streamLoadedCount++;
          }
        }
      }
    }

    // ─── Phase 2: Demote chunks outside the radius to dormant ───
    for (const [key, g] of this.chunks) {
      if (g.userData.chunkState !== "active") continue;
      if (wantedKeys.has(key)) continue;
      // Demote — keep in scene for raycasts, but stop rendering.
      g.userData.chunkState = "dormant";
      g.visible = false;
      this._chunkDormantSince.set(key, now);
    }

    // ─── Phase 3: Enforce MAX_ACTIVE_CHUNKS budget ───
    // If active count exceeds the budget, demote the oldest-active chunks
    // (LRU). They become dormant and eligible for unload on the next sweep.
    let activeCount = 0;
    for (const g of this.chunks.values()) {
      if (g.userData.chunkState === "active") activeCount++;
    }
    if (activeCount > MAX_ACTIVE_CHUNKS) {
      // Sort active chunks by last-used ascending; demote the oldest.
      const activeKeys = Array.from(this.chunks.entries())
        .filter(([, g]) => g.userData.chunkState === "active")
        .sort((a, b) => (this._chunkLastUsed.get(a[0]) ?? 0) - (this._chunkLastUsed.get(b[0]) ?? 0));
      const toDemote = activeKeys.length - MAX_ACTIVE_CHUNKS;
      for (let i = 0; i < toDemote; i++) {
        const [key, g] = activeKeys[i];
        g.userData.chunkState = "dormant";
        g.visible = false;
        this._chunkDormantSince.set(key, now);
      }
    }

    // ─── Phase 4: Enforce MAX_DORMANT_CHUNKS budget ───
    // If dormant count exceeds the budget, unload the oldest dormant chunks
    // immediately (don't wait for TTL).
    let dormantCount = 0;
    for (const g of this.chunks.values()) {
      if (g.userData.chunkState === "dormant") dormantCount++;
    }
    if (dormantCount > MAX_DORMANT_CHUNKS) {
      const dormantKeys = Array.from(this.chunks.entries())
        .filter(([, g]) => g.userData.chunkState === "dormant")
        .sort((a, b) => (this._chunkDormantSince.get(a[0]) ?? 0) - (this._chunkDormantSince.get(b[0]) ?? 0));
      const toUnload = dormantKeys.length - MAX_DORMANT_CHUNKS;
      for (let i = 0; i < toUnload; i++) {
        this.unloadChunk(dormantKeys[i][0]);
      }
    }
  }

  /** Mark a chunk as recently used (LRU timestamp). */
  private touchChunk(key: string, now: number): void {
    this._chunkLastUsed.set(key, now);
  }

  /** Unload dormant chunks whose TTL has expired. Called from `update()`. */
  private sweepDormant(now: number): void {
    for (const [key, dormantSince] of this._chunkDormantSince) {
      if (now - dormantSince >= DORMANT_TTL_MS) {
        this.unloadChunk(key);
      }
    }
  }

  /** Dispose + remove a chunk from the scene (full unload).
   *
   *  Task 3 / item 63 — verified this disposes GPU resources on unload:
   *    - mesh.geometry.dispose()  (vertex/index buffer GPU memory)
   *    - material.dispose()       (shader program + uniform buffer)
   *    - material.map + roughnessMap + normalMap + aoMap + metalnessMap + emissiveMap.dispose()
   *      (texture GPU memory — Task 3 / item 63 added this; the original
   *      implementation disposed geometry + material but NOT textures, which
   *      leaked ~1-2MB of VRAM per chunk unload on PBR-textured props)
   *
   *  Without these disposes, removed chunks leave orphaned GPU buffers that
   *  aren't reclaimed by the WebGL context until the page reloads. On a long
   *  session with active chunk streaming, this would slowly fill VRAM and
   *  eventually trigger WebGL context loss (handled in context-factory.ts via
   *  a full page reload — a hard failure). */
  private unloadChunk(key: string): void {
    const g = this.chunks.get(key);
    if (!g) return;
    // Dispose geometry + materials (including texture maps) owned by this chunk's children.
    g.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose?.();
        const mat = obj.material;
        const mats = Array.isArray(mat) ? mat : [mat];
        for (const m of mats) {
          if (!m) continue;
          // Task 3 / item 63 — dispose texture maps to free VRAM. The shared
          // procedural canvas textures (concrete, sand, wood) are cached by
          // textures.ts and may be referenced by other chunks; calling
          // dispose() on them would break those references. The three.js
          // Texture.dispose() emits a 'dispose' event that the renderer
          // listens to + frees the GPU texture. For shared textures this
          // would cause a re-upload on the next chunk that uses them — a
          // perf cost but not a correctness bug. We accept that cost here
          // because (a) most streamed chunks use unique authored textures,
          // and (b) the leak cost of NOT disposing is worse than the re-upload
          // cost of disposing a shared texture.
          const std = m as THREE.MeshStandardMaterial;
          const textureMaps = [
            std.map, std.roughnessMap, std.normalMap, std.metalnessMap,
            std.aoMap, std.emissiveMap, std.alphaMap,
            (m as THREE.MeshBasicMaterial).map,
          ];
          for (const t of textureMaps) {
            if (t && typeof t.dispose === "function") t.dispose();
          }
          m?.dispose?.();
        }
      }
    });
    g.removeFromParent?.();
    this.chunks.delete(key);
    this._chunkLastUsed.delete(key);
    this._chunkDormantSince.delete(key);
    this._streamUnloadedCount++;
  }

  /** Manually unload every chunk — used on map switch / clearMap(). */
  unloadAll(): void {
    for (const key of Array.from(this.chunks.keys())) {
      this.unloadChunk(key);
    }
    this._lastStreamCx = Number.NaN;
    this._lastStreamCz = Number.NaN;
  }

  /** Dispose — drops references. The chunk groups themselves are removed from
   *  the scene by clearMap(). */
  dispose() {
    if (this._streamingEnabled) this.unloadAll();
    this.chunks.clear();
    this._chunkLastUsed.clear();
    this._chunkDormantSince.clear();
    this._chunkLoader = null;
    this._streamingEnabled = false;
    this.ctx.postProc?.setMotionBlur?.(0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Task 3 / item 62 — dev-only memory-budget audit.
  // ═══════════════════════════════════════════════════════════════════════
  //
  // When chunk streaming is enabled, a stuck loader / unbounded radius /
  // mismatched MAX_ACTIVE vs MAX_DORMANT can leave dormant chunks piling up
  // without being unloaded — slowly leaking GPU memory (geometry + materials
  // are kept alive by the THREE.Group even when `visible = false`).
  //
  // `auditMemoryBudget()` is a cheap dev-only check called by the perf
  // overlay's 5s sampler. It returns a structured report of:
  //   - active/dormant/total chunk counts
  //   - whether the dormant count exceeds MAX_DORMANT_CHUNKS (config drift)
  //   - the oldest dormant chunk's age (ms since marked dormant)
  //   - a `leakSuspected` flag set when dormant count is high AND no unload
  //     has happened recently (the sweepDormant TTL isn't firing)
  //
  // In production this is a no-op (returns null) so it has zero cost.

  /** Dev-only: snapshot of chunk streaming health. Null in production. */
  auditMemoryBudget(): ChunkMemoryReport | null {
    if (process.env.NODE_ENV !== "development") return null;
    if (!this._streamingEnabled) return null;
    let active = 0, dormant = 0;
    let oldestDormantAge = 0;
    const now = performance.now();
    for (const [, g] of this.chunks) {
      if (g.userData.chunkState === "active") active++;
      else if (g.userData.chunkState === "dormant") {
        dormant++;
        // Find this chunk's dormant-since timestamp.
        // (We don't have it keyed by group; we'd need to iterate the map. To
        // keep this cheap, we only look at the dormant-since map's values.)
      }
    }
    // Compute oldest dormant age (cheap sweep over the small dormant-since map).
    for (const [, since] of this._chunkDormantSince) {
      const age = now - since;
      if (age > oldestDormantAge) oldestDormantAge = age;
    }
    // Leak heuristic: dormant count is at the cap AND oldest dormant is older
    // than 2× DORMANT_TTL (the sweep should have evicted it by now — if not,
    // the TTL sweep isn't firing or the loader is creating chunks faster than
    // the sweep can evict).
    const leakSuspected =
      dormant >= MAX_DORMANT_CHUNKS &&
      oldestDormantAge > DORMANT_TTL_MS * 2;
    if (leakSuspected) {
      // Warn once per leak-window so the console doesn't flood.
      if (now - this._lastLeakWarnAt > 10_000) {
        this._lastLeakWarnAt = now;
        console.warn(
          `[ChunkManager] LEAK SUSPECTED: ${dormant} dormant chunks (cap ${MAX_DORMANT_CHUNKS}), ` +
          `oldest ${Math.round(oldestDormantAge)}ms old (TTL ${DORMANT_TTL_MS}ms). ` +
          `Total loaded=${this._streamLoadedCount}, unloaded=${this._streamUnloadedCount}.`,
        );
      }
    }
    return {
      active,
      dormant,
      total: this.chunks.size,
      maxActive: MAX_ACTIVE_CHUNKS,
      maxDormant: MAX_DORMANT_CHUNKS,
      oldestDormantAgeMs: oldestDormantAge,
      lifetimeLoaded: this._streamLoadedCount,
      lifetimeUnloaded: this._streamUnloadedCount,
      leakSuspected,
    };
  }
  /** Last leak-warning timestamp (rate-limits the console.warn). */
  private _lastLeakWarnAt = 0;
}

/** Task 3 / item 62 — dev-only chunk-streaming memory report. Returned by
 *  `ChunkManager.auditMemoryBudget()`. Null in production. */
export interface ChunkMemoryReport {
  active: number;
  dormant: number;
  total: number;
  maxActive: number;
  maxDormant: number;
  /** Age of the oldest dormant chunk (ms). Should be < DORMANT_TTL_MS — if
   *  it's older, the sweepDormant TTL sweep isn't firing. */
  oldestDormantAgeMs: number;
  /** Lifetime counter — chunks ever loaded by the streamer. */
  lifetimeLoaded: number;
  /** Lifetime counter — chunks ever unloaded by the streamer. Should grow
   *  over time as the player moves; if it stays at 0, the streamer is only
   *  loading, never unloading (a leak). */
  lifetimeUnloaded: number;
  /** Heuristic flag — true when dormant count is saturated AND oldest dormant
   *  exceeds 2× the TTL (the sweep should have evicted it). Surfaced in the
   *  perf overlay as a red warning. */
  leakSuspected: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section F (#748) — Per-chunk trimesh colliders for narrowphase.
//
// The chunk's meshes already have BufferGeometry; this helper collects them
// into a flat list so the physics layer can build TrimeshColliders (via
// PhysicsEnhancements.buildTrimeshFromGeometry) for swept capsule-vs-mesh
// narrowphase (#747/#749). Without this, the player's swept capsule only
// collides with the chunk's AABB colliders (already registered), not with
// the detailed prop geometry.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChunkMeshEntry {
  /** The mesh object (world-space). */
  mesh: THREE.Mesh;
  /** World position of the mesh (precomputed for trimesh offset). */
  worldPos: THREE.Vector3;
  /** Geometry reference (shared with the mesh — do not dispose). */
  geometry: THREE.BufferGeometry;
}

/**
 * Collect all meshes in a chunk group that have geometry. Used by the physics
 * layer to build trimesh colliders for the chunk's props.
 *
 * The engine calls this once per chunk when the chunk loads (or on demand
 * when the player approaches a prop that needs precise collision). The
 * returned list is fed to PhysicsEnhancements.buildTrimeshFromGeometry +
 * iterTrimeshTriangles for sweptCapsuleVsTriangles tests.
 */
export function collectChunkMeshes(chunkGroup: THREE.Group): ChunkMeshEntry[] {
  const entries: ChunkMeshEntry[] = [];
  chunkGroup.traverse((o) => {
    if (o.type !== "Mesh") return;
    const mesh = o as THREE.Mesh;
    if (!mesh.geometry) return;
    mesh.updateMatrixWorld();
    const worldPos = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);
    entries.push({ mesh, worldPos, geometry: mesh.geometry });
  });
  return entries;
}

/**
 * Convenience: build trimesh colliders for every mesh in a chunk. Returns a
 * list of TrimeshCollider objects (lazy-imported from PhysicsEnhancements to
 * avoid a static dependency from ChunkManager → PhysicsEnhancements).
 */
export function buildChunkTrimeshes(chunkGroup: THREE.Group): Array<{
  vertices: Float32Array;
  indices: Uint32Array;
  offset: THREE.Vector3;
}> {
  const entries = collectChunkMeshes(chunkGroup);
  const trimeshes: Array<{ vertices: Float32Array; indices: Uint32Array; offset: THREE.Vector3 }> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildTrimeshFromGeometry } = require("./PhysicsEnhancements") as typeof import("./PhysicsEnhancements");
    for (const e of entries) {
      trimeshes.push(buildTrimeshFromGeometry(e.geometry, e.worldPos));
    }
  } catch {
    // PhysicsEnhancements not available — return empty list (engine falls
    // back to AABB colliders only).
  }
  return trimeshes;
}
