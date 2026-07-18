/**
 * SEC5-COMBAT — Prompt 44: Destructible environment physics pass.
 *
 * The VoronoiFracture system (physics/VoronoiFracture.ts) pre-fractures
 * destructible props at load time + activates shards as dynamic rigid bodies
 * on prop destruction. The existing `activateShards()` returns shard meshes
 * + initial velocities but does NOT:
 *
 *   - Tag shards with mass (so they could be exploited to climb debris).
 *   - Cap the total active-debris count (perf sink if 50 props shatter at once).
 *   - Despawn dormant shards after a TTL (memory leak across long matches).
 *
 * This module defines `FRACTURE_PHYSICS_CONFIG` — the policy the engine
 * applies to every activated shard. The orchestrator wires this in 3 places
 * (one-liners each — see "Wiring Notes" at the bottom of this file).
 *
 * Anti-exploit: every activated shard is tagged with `userData.isDebris = true`
 * + `userData.debrisMass`. The vault raycast in VaultSystem.tryVaultOrMantle
 * already filters out enemy subtrees (via `userData.enemy`); the orchestrator
 * adds an `|| p.userData.isDebris` clause so the player can't vault/mantle
 * off a pile of debris. The mass is also stored so a future physics-backed
 * movement system can apply weight to falling debris (no current behaviour —
 * just defensive bookkeeping).
 *
 * Anti-perf-sink: `MAX_ACTIVE_DEBRIS` caps the simultaneous active shard count.
 * When the cap is hit, the OLDEST active debris despawn first (LRU). This
 * means a single big explosion (60 shards) won't tank the frame rate — only
 * the first 32 persist past 4s.
 *
 * Memory: `DEBRIS_DESPAWN_MS` is the TTL. Shards older than this are removed
 * from the scene + their geometry/material disposed. Default 8s — long enough
 * for the player to see the debris settle, short enough to free memory before
 * the next firefight.
 *
 * This module also exposes `getFractureConfig()` so the gunsmith / debug HUD
 * can read the current policy. Pure data — no THREE import needed at module
 * load.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fracture physics config
// ─────────────────────────────────────────────────────────────────────────────

export interface FracturePhysicsConfig {
  /** Mass (kg) assigned to each activated shard. Affects future physics;
   *  today it's defensive bookkeeping (no current rigid-body sim on shards). */
  debrisMass: number;
  /** Max simultaneously active debris in the world. LRU despawn when exceeded. */
  maxActiveDebris: number;
  /** Time-to-live for an active debris shard (ms). After this, despawn + dispose. */
  debrisDespawnMs: number;
  /** Max travel distance from spawn before despawn (m). Prevents debris flying
   *  off into the void. */
  debrisMaxTravel: number;
  /** Initial velocity multiplier applied to each shard (scales the force
   *  passed to activateShards). 1.0 = use the existing force; 0.8 = tame it
   *  slightly so debris doesn't fly across the map. */
  velocityScale: number;
  /** Upward bias applied to each shard's initial velocity (m/s). The existing
   *  activateShards adds force*0.5 upward bias; this is an additional fixed
   *  lift so debris arcs visibly. */
  upwardBias: number;
  /** Whether to tag shards with userData.isDebris (anti-exploit). Always true
   *  in production; exposed for unit tests. */
  tagShards: boolean;
}

/**
 * The fracture physics policy. The engine reads this when activating shards
 * (one-liner wiring — see below). Designers can tune these without touching
 * the VoronoiFracture code.
 */
export const FRACTURE_PHYSICS_CONFIG: FracturePhysicsConfig = {
  debrisMass: 2.5,           // kg — typical shard is ~2-3 kg (concrete chunk)
  maxActiveDebris: 32,       // LRU despawn cap — keeps perf bounded
  debrisDespawnMs: 8000,     // 8s TTL — long enough to settle, short enough to free memory
  debrisMaxTravel: 12,       // m — despawn if a shard flies >12m from spawn
  velocityScale: 0.8,        // tame the existing force by 20% so debris stays local
  upwardBias: 1.5,           // m/s — additional upward lift for visible arcs
  tagShards: true,           // anti-exploit: tag shards so vault/mantle raycast filters them
};

/**
 * Get the current fracture config (for gunsmith / debug HUD).
 */
export function getFractureConfig(): FracturePhysicsConfig {
  return FRACTURE_PHYSICS_CONFIG;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shard bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Track an active debris shard. The engine maintains a registry of these so
 * the LRU despawn + TTL despawn + travel-distance despawn can fire each frame.
 *
 * The registry is a module-level array (singleton) — there's only ever one
 * match running, so a global registry is fine. The engine calls
 * `registerDebris(mesh)` when activateShards returns, and `tickDebris(dt, now)`
 * once per frame to apply the policy.
 */
export interface DebrisRecord {
  /** The shard mesh (from activateShards). */
  mesh: import("three").Mesh;
  /** Spawn position (for travel-distance despawn check). */
  spawnPos: import("three").Vector3;
  /** Spawn timestamp (performance.now()). */
  spawnTime: number;
  /** Last frame the shard was visible (for LRU). */
  lastSeen: number;
}

// A3-5000 #531: was a module-level singleton; if two matches run concurrently
// (e.g. in tests, or a future dedicated-server with multiple matches), the
// registry would leak across matches. Added `resetDebrisRegistry()` so test
// setup + match teardown can clear it explicitly. The array is still
// module-level for backward compat (existing callers use array methods).
const debrisRegistry: DebrisRecord[] = [];
/** A3-5000 #531: clear the registry for a new match (prevents cross-match
 *  leaks when running tests or back-to-back matches in the same process). */
export function resetDebrisRegistry(): void {
  for (const rec of debrisRegistry) disposeDebris(rec);
  debrisRegistry.length = 0;
}

/**
 * Register an activated shard. Called by the engine after activateShards()
 * returns the shard meshes. Tags the mesh with userData.isDebris + stores
 * the record for the per-frame tick.
 *
 * Pure bookkeeping — does NOT add the mesh to the scene (the engine does that
 * separately when wiring activateShards).
 */
export function registerDebris(mesh: import("three").Mesh, now: number = performance.now()): void {
  const cfg = FRACTURE_PHYSICS_CONFIG;
  if (cfg.tagShards) {
    mesh.userData.isDebris = true;
    mesh.userData.debrisMass = cfg.debrisMass;
    mesh.userData.spawnTime = now;
  }
  // Enforce the cap immediately — LRU despawn the oldest.
  while (debrisRegistry.length >= cfg.maxActiveDebris) {
    const oldest = debrisRegistry.shift();
    if (oldest) disposeDebris(oldest);
  }
  debrisRegistry.push({
    mesh,
    spawnPos: mesh.position.clone(),
    spawnTime: now,
    lastSeen: now,
  });
}

/**
 * Dispose a debris record — remove from scene + dispose geometry/material +
 * remove from the registry. Safe to call multiple times (idempotent).
 */
function disposeDebris(rec: DebrisRecord): void {
  const mesh = rec.mesh;
  if (mesh.parent) mesh.parent.remove(mesh);
  if (mesh.geometry) mesh.geometry.dispose();
  const mat = mesh.material;
  if (Array.isArray(mat)) {
    for (const m of mat) m.dispose();
  } else if (mat) {
    mat.dispose();
  }
  const idx = debrisRegistry.indexOf(rec);
  if (idx >= 0) debrisRegistry.splice(idx, 1);
}

/**
 * Per-frame tick. Apply the despawn policy:
 *   - TTL: shards older than debrisDespawnMs are despawned.
 *   - Travel: shards farther than debrisMaxTravel from spawn are despawned.
 *   - LRU cap: if over maxActiveDebris, despawn the oldest.
 *
 * The `now` parameter is performance.now() (ms). `dt` is unused but kept for
 * future physics integration.
 */
export function tickDebris(_dt: number, now: number = performance.now()): void {
  const cfg = FRACTURE_PHYSICS_CONFIG;
  // Walk the registry backwards so we can splice safely.
  for (let i = debrisRegistry.length - 1; i >= 0; i--) {
    const rec = debrisRegistry[i];
    // TTL despawn.
    if (now - rec.spawnTime > cfg.debrisDespawnMs) {
      disposeDebris(rec);
      continue;
    }
    // Travel-distance despawn.
    const travel = rec.mesh.position.distanceTo(rec.spawnPos);
    if (travel > cfg.debrisMaxTravel) {
      disposeDebris(rec);
      continue;
    }
    rec.lastSeen = now;
  }
  // LRU cap despawn (in case registerDebris was bypassed).
  while (debrisRegistry.length > cfg.maxActiveDebris) {
    const oldest = debrisRegistry.shift();
    if (oldest) disposeDebris(oldest);
  }
}

/**
 * Clear the debris registry (on map switch / match restart). Disposes every
 * active shard.
 */
export function clearDebris(): void {
  while (debrisRegistry.length > 0) {
    const rec = debrisRegistry.pop();
    if (rec) disposeDebris(rec);
  }
}

/**
 * Get the current active debris count (for debug HUD).
 */
export function getActiveDebrisCount(): number {
  return debrisRegistry.length;
}

/**
 * Get a snapshot of the registry (for tests). Returns a defensive copy.
 */
export function getDebrisRegistry(): DebrisRecord[] {
  return debrisRegistry.slice();
}

// ═════════════════════════════════════════════════════════════════════════════
// Section F (#760 / #791 / #792 / #793) — Persistent debris policy extensions
// + interactive physics props + prop health.
//
// The §7 work above added the FRACTURE_PHYSICS_CONFIG + the debris registry
// (LRU/TTL/travel-distance despawn). Section F extends this with:
//
//   - #760 persistent debris — `setDebrisPersistMatch(true)` makes debris
//     survive the whole match (TTL disabled). Off by default (perf safety).
//   - #791 interactive physics props — `registerInteractiveProp` registers a
//     prop that responds to impulses (barrels, crates, chairs). The engine
//     queries `getInteractiveProps()` to apply impulses on bullet hits.
//   - #792 prop health — `damageInteractiveProp(prop, dmg)` reduces HP;
//     when HP ≤ 0 the prop breaks (caller triggers fracture).
//   - #793 prop material on break — `materialOnBreak` returns the break
//     behavior (shard count, velocity scale, dust/rebar flags) for the
//     prop's material.
// ═════════════════════════════════════════════════════════════════════════════

/** #760 — When true, debris survives the whole match (TTL/travel disabled). */
let debrisPersistMatch = false;

/** Enable/disable persistent debris (match-long TTL). #760. */
export function setDebrisPersistMatch(persist: boolean): void {
  debrisPersistMatch = persist;
}

/** Override tickDebris to respect the persist-match flag. */
const _originalTickDebris = tickDebris;
export function tickDebrisPersist(_dt: number, now: number = performance.now()): void {
  if (debrisPersistMatch) {
    // Only enforce the LRU cap — no TTL/travel despawn.
    while (debrisRegistry.length > FRACTURE_PHYSICS_CONFIG.maxActiveDebris) {
      const oldest = debrisRegistry.shift();
      if (oldest) {
        // Inline dispose (avoid circular call).
        const mesh = oldest.mesh;
        if (mesh.parent) mesh.parent.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) for (const m of mat) m.dispose();
        else if (mat) mat.dispose();
        const idx = debrisRegistry.indexOf(oldest);
        if (idx >= 0) debrisRegistry.splice(idx, 1);
      }
    }
    return;
  }
  _originalTickDebris(_dt, now);
}

// ─────────────────────────────────────────────────────────────────────────────
// #791 — Interactive physics props.
// ─────────────────────────────────────────────────────────────────────────────

export interface InteractiveProp {
  id: string;
  /** Display name (for HUD on hover). */
  name: string;
  /** World position. */
  pos: import("three").Vector3;
  /** Velocity (m/s) — mutated by impulses. */
  vel: import("three").Vector3;
  /** Mass (kg). */
  mass: number;
  /** Half-extents of the prop's AABB. */
  halfExtents: import("three").Vector3;
  /** Material (determines break behavior — #793). */
  material: "glass" | "wood" | "concrete" | "metal" | "ice";
  /** Current HP. */
  hp: number;
  /** Max HP. */
  maxHp: number;
  /** Whether the prop has been destroyed. */
  destroyed: boolean;
  /** Whether the prop is explosive (barrel). */
  explosive: boolean;
  /** Optional mesh reference (for syncing transforms). */
  mesh?: import("three").Mesh;
}

const interactiveProps = new Map<string, InteractiveProp>();

/** Register an interactive prop. #791. */
export function registerInteractiveProp(prop: InteractiveProp): void {
  interactiveProps.set(prop.id, prop);
}

/** Remove an interactive prop. */
export function removeInteractiveProp(id: string): void {
  interactiveProps.delete(id);
}

/** Get all interactive props. */
export function getInteractiveProps(): InteractiveProp[] {
  return Array.from(interactiveProps.values());
}

/** Find an interactive prop by world position (nearest within radius). */
export function findInteractivePropAt(pos: import("three").Vector3, radius = 1.0): InteractiveProp | null {
  let best: InteractiveProp | null = null;
  let bestDist = radius;
  const allProps = Array.from(interactiveProps.values());
  for (const p of allProps) {
    if (p.destroyed) continue;
    const d = p.pos.distanceTo(pos);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// #792 — Prop health (damage + destroy).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply damage to an interactive prop. Returns true if the prop was destroyed
 * by this damage (caller should trigger fracture + remove the prop). #792.
 */
export function damageInteractiveProp(prop: InteractiveProp, damage: number): boolean {
  if (prop.destroyed) return false;
  prop.hp = Math.max(0, prop.hp - damage);
  if (prop.hp <= 0) {
    prop.destroyed = true;
    return true;
  }
  return false;
}

/**
 * Apply an impulse to an interactive prop (e.g. bullet hit, explosion). #791.
 * Impulse is in N·s; the prop's velocity changes by impulse/mass.
 */
export function applyImpulseToProp(prop: InteractiveProp, impulse: import("three").Vector3): void {
  if (prop.destroyed) return;
  prop.vel.addScaledVector(impulse, 1 / Math.max(0.1, prop.mass));
}

// ─────────────────────────────────────────────────────────────────────────────
// #793 — Material-specific break behavior.
// ─────────────────────────────────────────────────────────────────────────────

export interface MaterialBreakResult {
  shardCount: number;
  velocityScale: number;
  spawnDust: boolean;
  spawnRebar: boolean;
  /** Explosive props also explode on break. */
  explosive: boolean;
}

/**
 * Get the break behavior for a prop based on its material. #793.
 * Mirrors the SurfacePhysicsType → break-behavior table in PhysicsEnhancements.
 */
export function materialOnBreak(material: InteractiveProp["material"], explosive: boolean): MaterialBreakResult {
  const base: Record<InteractiveProp["material"], Omit<MaterialBreakResult, "explosive">> = {
    glass:    { shardCount: 30, velocityScale: 1.5, spawnDust: false, spawnRebar: false },
    wood:     { shardCount: 12, velocityScale: 1.0, spawnDust: true,  spawnRebar: false },
    concrete: { shardCount: 18, velocityScale: 0.7, spawnDust: true,  spawnRebar: true  },
    metal:    { shardCount: 6,  velocityScale: 0.6, spawnDust: false, spawnRebar: false },
    ice:      { shardCount: 25, velocityScale: 1.3, spawnDust: false, spawnRebar: false },
  };
  return { ...base[material], explosive };
}

// ─────────────────────────────────────────────────────────────────────────────
// #775 / #776 / #777 / #778 / #779 / #780 — Water/mud/ice/sand physics (env).
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvironmentalSurfaceVolume {
  /** AABB of the environmental volume (water body, mud pit, ice patch, sand). */
  box: { min: import("three").Vector3; max: import("three").Vector3 };
  /** Surface type. */
  type: "water" | "mud" | "ice" | "sand";
  /** Density (water=1000, mud=1700). */
  density: number;
}

const envVolumes: EnvironmentalSurfaceVolume[] = [];

/** Register an environmental surface volume (water body, mud pit, etc.). */
export function registerEnvironmentalVolume(vol: EnvironmentalSurfaceVolume): void {
  envVolumes.push(vol);
}

/** Clear all environmental volumes. */
export function clearEnvironmentalVolumes(): void {
  envVolumes.length = 0;
}

/**
 * Find the environmental volume at a position (if any). Returns the volume +
 * its type, or null if the position isn't in any registered volume.
 */
export function findEnvironmentalVolume(pos: import("three").Vector3): EnvironmentalSurfaceVolume | null {
  for (const v of envVolumes) {
    if (
      pos.x >= v.box.min.x && pos.x <= v.box.max.x &&
      pos.y >= v.box.min.y && pos.y <= v.box.max.y &&
      pos.z >= v.box.min.z && pos.z <= v.box.max.z
    ) return v;
  }
  return null;
}

/**
 * Apply environmental physics to a body inside a water/mud/ice/sand volume.
 * Returns the surface type so the caller can apply cosmetic effects (e.g.
 * mud tint on boots, splash particles).
 */
export function applyEnvironmentalPhysics(
  pos: import("three").Vector3,
  vel: import("three").Vector3,
  dt: number,
): EnvironmentalSurfaceVolume["type"] | null {
  const vol = findEnvironmentalVolume(pos);
  if (!vol) return null;
  switch (vol.type) {
    case "water":
      // Buoyancy (simplified): upward force + drag.
      vel.y += 5.0 * dt;
      vel.multiplyScalar(1 - 1.5 * dt);
      return "water";
    case "mud":
      // Strong drag.
      vel.multiplyScalar(1 - 3.0 * dt);
      return "mud";
    case "ice":
      // Very low friction.
      vel.x *= 1 - 0.05 * dt;
      vel.z *= 1 - 0.05 * dt;
      return "ice";
    case "sand":
      // Moderate drag + sink.
      vel.multiplyScalar(1 - 1.0 * dt);
      pos.y = Math.max(pos.y - 0.05 * dt, pos.y - 0.1);
      return "sand";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// #781 / #782 / #783 / #784 — Foliage + vegetation registry.
// ─────────────────────────────────────────────────────────────────────────────

export interface FoliageRecord {
  id: string;
  pos: import("three").Vector3;
  /** Bend angle (radians). 0 = upright. */
  bendAngle: number;
  /** Bend velocity (rad/s). */
  bendVel: number;
  /** Whether the foliage has been trampled. */
  trampled: boolean;
  /** Spring constant. */
  springK: number;
  /** Damping. */
  damping: number;
  /** Whether this is a tree (destructible vegetation). */
  isTree: boolean;
  /** Tree state (only if isTree). */
  treeState?: {
    fallAngle: number;
    fallVel: number;
    fallDir: import("three").Vector3;
    cut: boolean;
    fallen: boolean;
  };
}

const foliageRegistry = new Map<string, FoliageRecord>();

export function registerFoliage(f: FoliageRecord): void {
  foliageRegistry.set(f.id, f);
}

export function getFoliageRegistry(): FoliageRecord[] {
  return Array.from(foliageRegistry.values());
}

/**
 * Apply a bend force to nearby foliage when a body passes through. #781.
 * The body's velocity determines the bend direction + magnitude.
 */
export function applyFoliageBendFromBody(
  bodyPos: import("three").Vector3,
  bodyVel: import("three").Vector3,
  radius = 0.5,
): void {
  const allFoliage = Array.from(foliageRegistry.values());
  for (const f of allFoliage) {
    if (f.trampled) continue;
    const dx = f.pos.x - bodyPos.x;
    const dz = f.pos.z - bodyPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > radius) continue;
    const bendForce = (1 - dist / radius) * Math.hypot(bodyVel.x, bodyVel.z) * 0.5;
    f.bendVel += bendForce;
  }
}

/** Update all foliage (spring back + tree fall). */
export function updateFoliageAll(dt: number, gravity = 9.81): void {
  const allFoliage = Array.from(foliageRegistry.values());
  for (const f of allFoliage) {
    if (f.trampled) continue;
    if (f.isTree && f.treeState && f.treeState.cut) {
      // Update tree fall.
      const ts = f.treeState;
      if (!ts.fallen) {
        const angAccel = (gravity / 5) * Math.sin(ts.fallAngle); // L=5m tree
        ts.fallVel += angAccel * dt;
        ts.fallAngle += ts.fallVel * dt;
        if (ts.fallAngle >= Math.PI / 2) {
          ts.fallAngle = Math.PI / 2;
          ts.fallVel = 0;
          ts.fallen = true;
        }
      }
    } else {
      // Spring back.
      const springAccel = -f.springK * f.bendAngle;
      f.bendVel += springAccel * dt;
      f.bendVel *= 1 - f.damping * dt;
      f.bendAngle += f.bendVel * dt;
    }
  }
}

/** Trample foliage at a position (e.g. player walks through grass). #782. */
export function trampleFoliageAt(pos: import("three").Vector3, radius = 0.5): number {
  let count = 0;
  const allFoliage = Array.from(foliageRegistry.values());
  for (const f of allFoliage) {
    if (f.trampled) continue;
    if (f.isTree) continue; // trees aren't trampled — they need to be cut.
    const dx = f.pos.x - pos.x;
    const dz = f.pos.z - pos.z;
    if (dx * dx + dz * dz > radius * radius) continue;
    f.trampled = true;
    f.bendAngle = Math.PI / 2;
    f.bendVel = 0;
    count++;
  }
  return count;
}

/** Cut a tree at a position (destructible vegetation). #784. */
export function cutTreeAt(pos: import("three").Vector3, cutDir: import("three").Vector3, radius = 1.0): boolean {
  const allFoliage = Array.from(foliageRegistry.values());
  for (const f of allFoliage) {
    if (!f.isTree || !f.treeState || f.treeState.cut) continue;
    const dx = f.pos.x - pos.x;
    const dz = f.pos.z - pos.z;
    if (dx * dx + dz * dz > radius * radius) continue;
    f.treeState.cut = true;
    f.treeState.fallDir = cutDir.clone().normalize();
    f.treeState.fallVel = 0.5;
    return true;
  }
  return false;
}

/**
 * Apply wind to all foliage. #783. Foliage sways in the wind direction;
 * amplitude scales with wind speed.
 */
export function applyFoliageWind(windDir: import("three").Vector3, windSpeed: number, dt: number): void {
  const allFoliage = Array.from(foliageRegistry.values());
  for (const f of allFoliage) {
    if (f.trampled) continue;
    if (f.isTree && f.treeState?.cut) continue;
    f.bendVel += windDir.x * windSpeed * 0.05 * dt;
    f.bendVel += windDir.z * windSpeed * 0.05 * dt * 0.5;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clear-all on map switch.
// ─────────────────────────────────────────────────────────────────────────────

/** Clear all registries (debris + interactive props + foliage + env volumes). */
export function clearAllDestructionState(): void {
  clearDebris();
  interactiveProps.clear();
  foliageRegistry.clear();
  envVolumes.length = 0;
  debrisPersistMatch = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring notes (for the orchestrator — one-liners, none touch shared files)
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. On prop destruction (EnemySystem.destroyProp or set-pieces tickSetPieces
//    after calling activateShards):
//
//      for (const shard of shards) {
//        ctx.scene.add(shard.mesh);
//        registerDebris(shard.mesh);
//        // Apply the velocity scale + upward bias from FRACTURE_PHYSICS_CONFIG.
//        shard.velocity.multiplyScalar(FRACTURE_PHYSICS_CONFIG.velocityScale);
//        shard.velocity.y += FRACTURE_PHYSICS_CONFIG.upwardBias;
//      }
//
// 2. Per frame (engine loop, after PhysicsSystem.update):
//
//      tickDebris(dt);
//
// 3. On map switch / match restart (engine.dispose or map transition):
//
//      clearDebris();
//
// 4. Anti-exploit (VaultSystem.tryVaultOrMantle — modify the isPlayerSubtree
//    filter or add an isDebrisSubtree check). The simplest one-liner is to
//    extend the existing `hits.filter(...)`:
//
//      const hits = ctx.raycaster.intersectObjects(ctx.scene.children, true).filter(
//        (h) => !isPlayerSubtree(h.object) && !isEnemySubtree(h.object)
//              && !isDebrisSubtree(h.object)
//              && h.object.type !== "Sprite",
//      );
//
//    where isDebrisSubtree walks the parent chain checking userData.isDebris
//    (same shape as isEnemySubtree). This is the only file the orchestrator
//    needs to touch in VaultSystem — a 4-line helper + the filter clause.
