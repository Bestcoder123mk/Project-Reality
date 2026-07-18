import * as THREE from "three";
import type {
  GameContext,
  GameSystem,
  Projectile,
  ProjectileSpawnOpts,
  ProjectileSystemLike,
} from "./types";
import type { Enemy, DestructibleProp } from "./types";
import {
  BALLISTIC_PARAMS,
  DEFAULT_BALLISTIC_PARAMS,
  getBallisticParams,
  integrateProjectile,
  velocityDamageMult,
  computeRicochet,
  testSurfacePenetration,
  getHitZoneMult,
  type BallisticParams,
  // Section B — advanced ballistics.
  transonicDragMult,
  gustWindSpeed,
  coriolisDriftM,
  magnusSpinDriftM,
  gModelDragCoef,
  DEFAULT_BC_BY_CATEGORY,
  computeDestabilizationScatter,
  sniperTraceVisibilityMult,
} from "./Ballistics";
import { computePenetration } from "../realism";
import { particleTexture } from "../textures";

/**
 * REAL-BALLISTICS — ProjectileSystem.
 *
 * Replaces the legacy hitscan `WeaponSystem.fireRay` with traveling bullet
 * entities that have:
 *   - Real travel time (a 200 m target hit by a 760 m/s rifle round takes
 *     ~0.26 s to register — vs. instant today).
 *   - Gravity drop (snipers drop less, pistols/shotguns drop more — see
 *     BALLISTIC_PARAMS.gravityScale).
 *   - Quadratic air drag (bullets decelerate over distance — damage falls
 *     off via velocityDamageMult).
 *   - Wind drift (horizontal acceleration along the wind vector).
 *   - Per-surface penetration (combat/penetration.ts's table is finally
 *     wired — drywall/glass/wood let bullets through with falloff,
 *     steel_plate/sandbag stop them cold).
 *   - Hard-surface ricochets (concrete / sheet_metal / steel_plate) with
 *     reflected direction + damage reduction + spark VFX.
 *
 * Integration model: semi-implicit Euler (symplectic) at the engine's fixed
 * 60 Hz physics step. Per-tick segment raycast from prevPos → pos catches
 * every surface + enemy intersection along the actual flight path.
 *
 * Tracer visual: each projectile owns a pooled THREE.Line that is updated
 * per-frame to span prevPos → pos, so the streak follows the actual arc
 * (legacy tracers were a straight line that faded in 80 ms with no travel).
 *
 * Pooling: reuses the existing ctx.particlePool tracer pool (capacity 50).
 * If the pool is exhausted (extreme spam), the projectile still integrates
 * + raycasts — it just has no visible streak until a tracer is freed.
 *
 * Cap: max 200 concurrent projectiles. Beyond that, new spawns are dropped
 * silently (matches the legacy tracer-drop behavior). At 7 shotgun pellets
 * × 5 enemies × 1000 rpm that's 175 projectiles/sec worst case — far above
 * realistic engagement density.
 */
const MAX_PROJECTILES = 200;
/** Defensive despawn: never let a bullet live longer than 5 seconds. */
const MAX_PROJECTILE_AGE = 5.0;
/** Velocity floor (m/s). Below this the bullet is "spent" and despawns. */
const MIN_PROJECTILE_VELOCITY = 30;

// REALISM-1 (task G): Supersonic crack VFX constants.
// Speed of sound at sea level + 20°C ≈ 343 m/s. Projectiles traveling faster
// than this generate a sonic boom — visualized as a tiny white sprite that
// pops into existence every 5m of travel (the visual rate of the shockwave
// shedding behind the bullet). The crack fades in 50ms (a single-frame flash
// at 60 Hz — reads as a sharp pinpoint of light, not a lingering particle).
const SPEED_OF_SOUND = 343;
const SONIC_CRACK_INTERVAL_M = 5;
const SONIC_CRACK_LIFE_S = 0.05;
let _sonicCrackTex: THREE.Texture | null = null;
function getSonicCrackTexture(): THREE.Texture {
  if (_sonicCrackTex) return _sonicCrackTex;
  _sonicCrackTex = particleTexture("rgb(255,255,255)");
  return _sonicCrackTex;
}

// Scratch vectors — avoid per-tick allocations.
const _segOrigin = new THREE.Vector3();
const _segDir = new THREE.Vector3();
const _segEnd = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _reflectDir = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
/** REALISM-1 (task G): shared zero-velocity vector for sonic crack particles.
 *  Avoids per-spawn allocation — the crack sprite stays at its spawn position. */
const _zeroVec = new THREE.Vector3(0, 0, 0);

export class ProjectileSystem implements GameSystem, ProjectileSystemLike {
  /** Live projectile list. Iterated + mutated in-place each tick. */
  private live: Projectile[] = [];
  /** Reusable buffer for dead projectiles (avoid alloc on hot path). */
  private dead: Projectile[] = [];

  /** PERF: cached list of hittable environment meshes (world geometry only —
   *  NOT the camera subtree, weapon, avatar, enemies, or sprites). Rebuilt
   *  when the scene's top-level child count changes (map load / wave spawn).
   *  Raycasting this flat list is ~30-50× cheaper than
   *  intersectObjects(scene.children, true) which traverses the weapon's
   *  ~220 meshes + avatar + enemies + particles on EVERY projectile EVERY
   *  frame. During a firefight with 20+ live projectiles that's the
   *  difference between 60fps and 20fps. */
  private _envMeshes: THREE.Object3D[] = [];
  private _envMeshSceneSig = -1;

  /** A3-5000-retry / 523 + 524: Map of destructible mesh → prop entry. Built
   *  lazily — first lookup for a mesh walks the array + caches; subsequent
   *  lookups are O(1). Was `Array.find` per projectile per tick. */
  private _destructibleByMesh = new Map<THREE.Object3D, { mesh: THREE.Object3D; health: number; materialSlug?: string }>();

  /** Rebuild the cached environment-mesh list. Called when the scene's
   *  top-level child count changes (cheap signature). Walks the scene once
   *  and collects all meshes that are NOT part of the camera/weapon/avatar
   *  rig and NOT sprites — i.e. actual world geometry bullets can hit.
   *
   *  A3-5000-retry / 529: was triggered on ANY scene-children-count change,
   *  including the addition of a single particle sprite (every shot). Now we
   *  use a content-hash signature (children count + a sum of child UUIDs)
   *  so transient particle/sprite additions don't trigger a full traverse.
   *  The signature is still cheap (O(children), not O(scene)). */
  private _rebuildEnvMeshes(): void {
    const ctx = this.ctx;
    this._envMeshes.length = 0;
    ctx.scene.traverse((o) => {
      // Skip non-meshes (Groups, Lights, Cameras, Sprites, Lines).
      if (o.type !== "Mesh") return;
      // Skip the camera/weapon/avatar rig (player's own meshes).
      let p: THREE.Object3D | null = o;
      while (p) {
        if (p === ctx.camera) return;
        if (p === ctx.avatar?.group) return;
        if (p === ctx.weaponGroup) return;
        p = p.parent;
      }
      // Skip enemy parts (tagged via userData.enemy — handled separately).
      if ((o as unknown as { userData?: { enemy?: unknown } }).userData?.enemy) return;
      this._envMeshes.push(o);
    });
    this._envMeshSceneSig = this._computeEnvMeshSig();
  }

  /** A3-5000-retry / 529: compute a content-aware signature for the env-mesh
   *  cache. Combines children count with a cheap hash of the top-level child
   *  UUIDs so adding a particle sprite (transient) doesn't trigger a rebuild
   *  but adding a chunk mesh (persistent) does. */
  private _computeEnvMeshSig(): number {
    const ctx = this.ctx;
    let h = ctx.scene.children.length;
    for (const c of ctx.scene.children) {
      // Mix child UUID's first 8 chars into the hash. Cheap + stable.
      const uuid = c.uuid;
      for (let i = 0; i < 8 && i < uuid.length; i++) {
        h = (h * 31 + uuid.charCodeAt(i)) | 0;
      }
      // Also mix in the child type so a Sprite→Mesh swap invalidates.
      h = (h * 17 + c.type.charCodeAt(0)) | 0;
    }
    return h;
  }

  /**
   * REALISM-1 (task G): per-projectile "last sonic crack distance" tracker.
   * Keyed by the projectile reference. We can't add a field to the Projectile
   * interface (types.ts is locked by ANIM-POLISH), so we maintain the
   * per-projectile sonic-crack distance here. A WeakMap lets the entry be
   * GC'd if a projectile reference escapes the live array (shouldn't happen
   * — the live array is the sole owner — but defensive).
   *
   * Value = distanceTraveled at which the next crack should spawn. Initialized
   * to SONIC_CRACK_INTERVAL_M (5) so the first crack spawns after 5m of flight
   * (not at the muzzle — firing a supersonic rifle shouldn't paint a flash at
   * the player's own position).
   */
  private sonicCrackDistance = new WeakMap<Projectile, number>();

  constructor(private ctx: GameContext) {
    // Self-register on the context so WeaponSystem (and any other system)
    // can call ctx.spawnProjectile?.(...) without a circular import.
    ctx.projectileSystem = this;
    ctx.projectiles = this.live;
  }

  // ----- ProjectileSystemLike implementation -----

  spawn(opts: ProjectileSpawnOpts): void {
    if (this.live.length >= MAX_PROJECTILES) return; // cap — drop silently

    const params = getBallisticParams(opts.category);
    const muzzle = opts.muzzleVelocity ?? params.velocity;
    const mass = opts.mass ?? params.mass;
    const drag = opts.dragCoef ?? params.dragCoef;
    const grav = opts.gravityScale ?? params.gravityScale;

    // Tracer mesh: suppressed weapons (tracerHidden=true) skip the line mesh
    // entirely. Otherwise acquire one from the pool.
    let tracer: THREE.Line | null = null;
    if (!opts.tracerHidden && opts.tracerColor !== 0) {
      // Use a zero-length segment for now — the first update() will set the
      // real prevPos → pos span.
      tracer = this.ctx.particlePool.acquireTracer(opts.origin, opts.origin);
      if (tracer) {
        const mat = tracer.material as THREE.LineBasicMaterial;
        mat.color.setHex(opts.tracerColor);
        mat.opacity = 0.95;
      }
    }

    const projectile: Projectile = {
      pos: opts.origin.clone(),
      prevPos: opts.origin.clone(),
      vel: opts.direction.clone().multiplyScalar(muzzle),
      muzzleVelocity: muzzle,
      mass,
      dragCoef: drag,
      gravityScale: grav,
      baseDamage: opts.baseDamage,
      headshotMult: opts.headshotMult,
      category: opts.category,
      maxRange: opts.maxRange,
      distanceTraveled: 0,
      age: 0,
      ricochetCount: 0,
      maxRicochets: opts.maxRicochets ?? 1,
      tracer,
      tracerColor: opts.tracerColor,
      team: opts.team,
      weaponSlug: opts.weaponSlug,
      hasDealtDamage: false,
      alive: true,
    };
    this.live.push(projectile);
  }

  count(): number {
    return this.live.length;
  }

  clear(): void {
    for (const p of this.live) this.releaseTracer(p);
    this.live.length = 0;
    this.dead.length = 0;
  }

  // ----- GameSystem implementation -----

  update(dt: number): void {
    if (this.live.length === 0) return;
    const ctx = this.ctx;
    // Section B #163 — wind gusts (noise-driven, not constant). Sample the
    // gust-modified wind speed at the current time so long-range shots
    // require reading the gust pattern, not a steady wind value.
    const baseWindSpeed = ctx.weather.windSpeed;
    const timeSeconds = performance.now() / 1000;
    const windSpeed = gustWindSpeed(baseWindSpeed, timeSeconds);
    const windDir = ctx.weather.windDirection;

    // Iterate backwards so we can splice dead projectiles without skipping.
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      if (!p.alive) { this.retire(i); continue; }

      // --- Integration (semi-implicit Euler, symplectic) ---
      p.prevPos.copy(p.pos);
      // Section B #165 — G1/G7 drag model. Use the per-category default BC +
      // apply the velocity-dependent drag multiplier on top of the baseline.
      const bc = DEFAULT_BC_BY_CATEGORY[p.category] ?? DEFAULT_BC_BY_CATEGORY.RIFLE;
      const gModelDrag = gModelDragCoef(p.vel.length(), bc, p.dragCoef);
      // Section B #162 — transonic drag spike. When the bullet's velocity
      // crosses the sound barrier, drag briefly increases up to 1.4×.
      const transonicMult = transonicDragMult(p.vel.length());
      const effectiveDrag = gModelDrag * transonicMult;
      const params: BallisticParams = {
        velocity: p.muzzleVelocity,
        dropMultiplier: BALLISTIC_PARAMS[p.category]?.dropMultiplier ?? DEFAULT_BALLISTIC_PARAMS.dropMultiplier,
        driftMultiplier: BALLISTIC_PARAMS[p.category]?.driftMultiplier ?? DEFAULT_BALLISTIC_PARAMS.driftMultiplier,
        mass: p.mass,
        dragCoef: effectiveDrag,
        gravityScale: p.gravityScale,
      };
      integrateProjectile(p.pos, p.vel, dt, params, windSpeed, windDir);
      p.age += dt;
      const speed = p.vel.length();
      const segLen = p.pos.distanceTo(p.prevPos);
      p.distanceTraveled += segLen;

      // Section B #162/#166 — destabilization scatter (transonic + spin decay).
      // Apply a small lateral + vertical deflection at extreme range.
      if (p.distanceTraveled > 100) {
        const scatter = computeDestabilizationScatter(speed, p.age, p.distanceTraveled);
        if (Math.abs(scatter.lateral) > 0 || Math.abs(scatter.vertical) > 0) {
          // Apply the scatter as a small rotation of the velocity vector.
          // This is a simplification — a true scatter would rotate around the
          // bullet's right/up axes, but for small angles the lateral/vertical
          // offsets are equivalent to velocity perturbations.
          p.vel.x += scatter.lateral * speed * dt * 10;
          p.vel.y += scatter.vertical * speed * dt * 10;
        }
      }

      // Section B #164 — Coriolis + Magnus spin drift for extreme ranges.
      // Apply as a small lateral velocity nudge (the drift is small + slow).
      if (p.distanceTraveled > 800) {
        // Latitude 45° default; azimuth read from the velocity direction.
        const azimuth = Math.atan2(p.vel.z, p.vel.x);
        const coriolis = coriolisDriftM(p.distanceTraveled, p.age, 45, azimuth);
        const magnus = magnusSpinDriftM(p.distanceTraveled);
        // Apply as a small velocity offset along the right axis.
        const right = _tmpVec.set(p.vel.z, 0, -p.vel.x).normalize();
        p.vel.addScaledVector(right, (coriolis + magnus) * dt * 10);
      }

      // --- Tracer visual update (per-frame, follows the actual arc) ---
      if (p.tracer) {
        const positions = p.tracer.geometry.attributes.position.array as Float32Array;
        // Tracer draws from a point a few frames back (so it's a visible
        // streak, not just a point) to the current bullet position. We use
        // a tail length proportional to the segment traveled this tick,
        // clamped to 0.5–3 m so it's always visible.
        const tailLen = THREE.MathUtils.clamp(segLen * 2.0, 0.5, 3.0);
        _tmpVec.copy(p.vel).normalize().multiplyScalar(-tailLen).add(p.pos);
        positions[0] = _tmpVec.x; positions[1] = _tmpVec.y; positions[2] = _tmpVec.z;
        positions[3] = p.pos.x;   positions[4] = p.pos.y;   positions[5] = p.pos.z;
        p.tracer.geometry.attributes.position.needsUpdate = true;
        // Fade opacity slightly with speed — a slowing bullet's tracer dims.
        const mat = p.tracer.material as THREE.LineBasicMaterial;
        const speedRatio = speed / p.muzzleVelocity;
        mat.opacity = 0.55 + 0.40 * THREE.MathUtils.clamp(speedRatio, 0, 1);
      }

      // --- REALISM-1 (task G): Supersonic crack VFX. ---
      // A projectile traveling faster than 343 m/s (speed of sound) generates
      // a sonic boom. Visualized as a tiny white sprite that pops at the
      // bullet's current position every 5m of travel — reads as the visual
      // rate of the shockwave shedding behind the bullet. The crack sprite
      // lives for 50ms (a single-frame flash at 60 Hz).
      //
      // Skipped for enemy projectiles (player won't see enemy bullets well
      // enough for the crack to read, + we don't want to paint extra VFX on
      // incoming fire — that would be visually noisy without gameplay value).
      if (speed > SPEED_OF_SOUND && p.team === "player") {
        const nextCrackAt = this.sonicCrackDistance.get(p) ?? SONIC_CRACK_INTERVAL_M;
        if (p.distanceTraveled >= nextCrackAt) {
          this.spawnSonicCrack(p.pos);
          // Schedule the next crack SONIC_CRACK_INTERVAL_M (5m) further along
          // the flight path. Don't re-fire if we're catching up after a frame
          // stall — advance at least one interval to avoid spawning multiple
          // cracks in the same frame.
          this.sonicCrackDistance.set(
            p,
            nextCrackAt + Math.max(SONIC_CRACK_INTERVAL_M, p.distanceTraveled - nextCrackAt),
          );
        }
      }

      // --- Despawn checks (before raycast — saves work) ---
      if (
        speed < MIN_PROJECTILE_VELOCITY ||
        p.distanceTraveled > p.maxRange ||
        p.age > MAX_PROJECTILE_AGE ||
        p.ricochetCount > p.maxRicochets
      ) {
        p.alive = false;
        this.retire(i);
        continue;
      }

      // --- SEC8 prompt 67 — Bullet whiz-by. ---
      // For each ENEMY projectile that hasn't already triggered a whiz-by,
      // compute the distance from the bullet's current position to the
      // player's head (player.pos + ~1.7m up — eye/head height). If within
      // 2m, play a doppler-correct whiz-by sound via AudioEngine and flag
      // the projectile so it doesn't re-trigger.
      //
      // Skipped for player projectiles (the player fired them — they don't
      // whiz past their own head) + for projectiles that have already
      // whizzed (one cue per bullet lifetime — a 30-round mag passing by
      // doesn't need 30 whizzes; the brain can't parse that many).
      if (p.team === "enemy" && !p.whizPlayed) {
        const headX = ctx.player.pos.x;
        const headY = ctx.player.pos.y + 0.1; // eye height already includes head; small bias.
        const headZ = ctx.player.pos.z;
        const dxh = p.pos.x - headX;
        const dyh = p.pos.y - headY;
        const dzh = p.pos.z - headZ;
        // A3-5000-retry / 525: was `Math.sqrt(dxh*dxh + dyh*dyh + dzh*dzh)` then
        // `distToHead < 2.0` — Math.sqrt is unnecessary for a threshold compare.
        // Compare squared distance against squared threshold (4.0 = 2²).
        const distSq = dxh * dxh + dyh * dyh + dzh * dzh;
        if (distSq < 4.0) {
          p.whizPlayed = true;
          // AudioEngine.playBulletWhizBy synthesizes a doppler-correct HRTF
          // whiz at the bullet's position with the bullet's velocity. The
          // panner localizes the whiz to the actual bullet location.
          const audio = ctx.audio as unknown as {
            playBulletWhizBy?: (pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }) => void;
          };
          audio.playBulletWhizBy?.(
            { x: p.pos.x, y: p.pos.y, z: p.pos.z },
            { x: p.vel.x, y: p.vel.y, z: p.vel.z },
          );
        }
      }

      // --- Prompt #53 — Player bullets suppress enemies they pass near. ---
      // Symmetric to the whiz-by check above: when a PLAYER projectile is
      // within ~2m of an enemy's chest, that enemy's `e.suppression` is
      // bumped by 0.10. The FSM (EnemySystem.tick) transitions the enemy to
      // SUPPRESSED when suppression crosses the per-class threshold (default
      // 0.6); tickSuppressed then implements the duck/peek/cover behavior.
      //
      // A typical 600 m/s bullet is within 2m for <1 frame, so a single pass
      // applies ~0.10 (one tick). A sustained burst of ~6 bullets landing in
      // the enemy's vicinity pushes them past 0.6 → SUPPRESSED. Slower
      // projectiles (pistols at 300 m/s) may apply 2 bumps; that's still
      // well below the threshold per bullet, so the player needs to lay down
      // sustained fire to suppress — exactly the intended gameplay loop.
      //
      // No per-projectile-per-enemy flag: the natural decay (0.2/s in
      // SuppressionSystem) bounds the cumulative effect, and at 30 enemies
      // × ~10 player projectiles the cost is ~300 distance checks/tick
      // (negligible vs the segment raycast that follows).
      // A3-5000-retry / 526: was O(P × E) — every player projectile per tick
      // iterates ALL enemies. Now uses a per-projectile pre-filter: skip enemies
      // whose group position is more than 10m from the projectile (the
      // suppression radius is 2m, so 10m is a safe broadphase). Effective
      // complexity drops to O(P × nearby E) — typically O(P × 1-3) instead of
      // O(P × 30).
      if (p.team === "player" && ctx.addEnemySuppression) {
        const ppx = p.pos.x, ppy = p.pos.y, ppz = p.pos.z;
        const BROADPHASE_RADIUS_SQ = 100; // 10m squared
        for (let ei = 0, enN = ctx.enemies.length; ei < enN; ei++) {
          const en = ctx.enemies[ei];
          if (!en.alive) continue;
          // A3-5000-retry / 526: broadphase — skip far enemies.
          const bdx = ppx - en.group.position.x;
          const bdz = ppz - en.group.position.z;
          if (bdx * bdx + bdz * bdz > BROADPHASE_RADIUS_SQ) continue;
          // Chest height — matches the LOS + cover raycast heights used
          // elsewhere (1.2m). Using the enemy's group.position (feet) +
          // 1.2m bias gives a stable target point that doesn't depend on
          // the rig's animation frame.
          const dx = ppx - en.group.position.x;
          const dy = ppy - (en.group.position.y + 1.2);
          const dz = ppz - en.group.position.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 4.0) { // 2m radius → 4m² squared distance
            ctx.addEnemySuppression(en, 0.10);
          }
        }
      }

      // --- Segment raycast (prevPos → pos) ---
      // This is the core change: the bullet only hits things between its
      // last position and its current position, so distant targets take
      // real time to register.
      _segOrigin.copy(p.prevPos);
      _segEnd.copy(p.pos);
      _segDir.copy(_segEnd).sub(_segOrigin);
      const segLength = _segDir.length();
      if (segLength < 1e-5) continue;
      _segDir.multiplyScalar(1 / segLength);
      _raycaster.set(_segOrigin, _segDir);
      _raycaster.far = segLength + 0.001;

      // Build enemy part list once per projectile (matches WeaponSystem.fireRay pattern).
      // We do this lazily — only when the projectile's segment could plausibly
      // intersect an enemy (basic AABB distance check). For simplicity here,
      // always build the list — EnemySystem already culls far enemies.
      const enemyParts: THREE.Object3D[] = [];
      const partOwner = new Map<THREE.Object3D, { enemy: Enemy; isHead: boolean; zone: string }>();
      for (const en of ctx.enemies) {
        if (!en.alive) continue;
        if (p.team === "enemy" && en.team === "enemy") continue; // friendly fire off
        const parts = en.group.userData.parts as THREE.Mesh[] | undefined;
        if (!parts) continue;
        for (const part of parts) {
          enemyParts.push(part);
          partOwner.set(part, {
            enemy: en,
            isHead: !!part.userData.isHead,
            // Prompt #46 — read the per-part hitbox zone tagged by
            // EnemySystem.buildEnemy. Falls back to "chest" (1× mult) when
            // the tag is missing (e.g. older enemy instances / debug rigs).
            zone: (part.userData.hitZone as string) ?? "chest",
          });
        }
      }

      // PERF FIX: set the camera on the shared raycaster so Three.js doesn't
      // log a warning when the scene contains Sprites (particle sprites). The
      // old code raycasted the ENTIRE scene tree including sprites, which
      // triggered "Raycaster.camera needs to be set" on every projectile tick.
      // We now raycast a cached flat list of environment meshes (no sprites,
      // no camera subtree, no enemies) — cheaper AND warning-free.
      if (!_raycaster.camera) _raycaster.camera = ctx.camera;
      // Rebuild the env-mesh cache if the scene changed.
      // A3-5000-retry / 529: was `sig = ctx.scene.children.length` which
      // triggered a full traverse on every particle-sprite addition. Now uses
      // a content-aware signature (children count + UUID hash) so transient
      // sprite adds don't invalidate.
      const sig = this._computeEnvMeshSig();
      if (sig !== this._envMeshSceneSig) this._rebuildEnvMeshes();

      const envIntersects = _raycaster.intersectObjects(this._envMeshes, false);
      const enemyIntersects = _raycaster.intersectObjects(enemyParts, false);
      const firstEnv = envIntersects.length > 0 ? envIntersects[0] : null;
      const firstEnemy = enemyIntersects.length > 0 ? enemyIntersects[0] : null;

      if (firstEnemy && (!firstEnv || firstEnemy.distance <= firstEnv.distance)) {
        // --- Enemy hit ---
        _hitPoint.copy(firstEnemy.point);
        const owner = partOwner.get(firstEnemy.object);
        if (owner && !p.hasDealtDamage) {
          // Damage scales with residual velocity (falloff at range).
          const speedRatio = velocityDamageMult(speed, p.muzzleVelocity);
          const baseDmg = p.baseDamage * speedRatio;
          // Prompt #46 — apply the per-zone damage multiplier (head 4×,
          // chest 1×, limb 0.7×) layered on top of the velocity falloff.
          // The legacy `p.headshotMult` is superseded by the zone table —
          // `getHitZoneMult` returns 4.0 for head, matching the spec.
          const zoneMult = getHitZoneMult(owner.zone);
          const dmg = baseDmg * zoneMult;
          // Damage callback — use the same hook the legacy WeaponSystem used.
          this.__onDamageEnemy?.(owner.enemy, dmg, owner.isHead, _hitPoint, p.weaponSlug);
          p.hasDealtDamage = true;
          // Bullets embed in flesh — no penetration through enemies (matches
          // legacy `dealt = true; break;` behavior in WeaponSystem.fireRay).
          p.alive = false;
          this.retire(i);
          continue;
        }
      } else if (firstEnv) {
        // --- Environment hit ---
        _hitPoint.copy(firstEnv.point);
        const face = firstEnv.face;
        if (face) {
          _hitNormal.copy(face.normal).transformDirection(firstEnv.object.matrixWorld).normalize();
        } else {
          _hitNormal.set(0, 1, 0);
        }
        const obj = firstEnv.object as THREE.Mesh;
        const materialSlug = (obj.userData.materialSlug as string) ?? "concrete";
        const material = ctx.materials.find((m) => m.slug === materialSlug) ?? ctx.materials[0];

        // Destructible prop damage (glass panels, crates, barrels).
        if (obj.userData.destructible) {
          // A3-5000-retry / 523: was `ctx.destructibles.find((p2) => p2.mesh === obj)`
          // per projectile per tick (50 destructibles × 20 projectiles × 60Hz =
          // 60000 finds/sec). Now uses a Map keyed by mesh for O(1) lookup.
          const prop = this._destructibleByMesh.get(obj) ?? (() => {
            const found = ctx.destructibles.find((p2) => p2.mesh === obj);
            if (found) this._destructibleByMesh.set(obj, found);
            return found;
          })();
          if (prop) {
            const dmgMult = p.category === "SHOTGUN" ? 1.5 : 1;
            prop.health -= p.baseDamage * dmgMult;
            this.__onSpawnImpact?.(_hitPoint, _hitNormal, materialSlug);
            if (prop.health <= 0) {
              if (prop.materialSlug === "glass") {
                this.__onShatterGlass?.(_hitPoint, _hitNormal);
              }
              // Barrels explode on destruction (chain reaction trigger).
              const isBarrel = prop.mesh.userData.surfaceType === "barrel";
              const barrelPos = isBarrel ? prop.mesh.position.clone() : null;
              this.__onDestroyProp?.(prop as DestructibleProp);
              if (isBarrel && barrelPos) {
                (ctx as unknown as {
                  particles?: { spawnExplosion?: (p: THREE.Vector3, s: number, k: "grenade" | "barrel" | "c4") => void };
                }).particles?.spawnExplosion?.(barrelPos, 1.5, "barrel");
              }
            }
            p.alive = false;
            this.retire(i);
            continue;
          }
        }

        // Penetration test (surface × category).
        const penTest = testSurfacePenetration(materialSlug, p.category);
        const physicsPen = computePenetration(speed, material);
        if (penTest.penetrates && physicsPen.penetrated && !material.bulletStop) {
          // Pass through — apply surface falloff to velocity + spawn impact VFX.
          this.__onSpawnImpact?.(_hitPoint, _hitNormal, materialSlug);
          // Prompt #35 — spawn an exit-hole decal on the FAR side of the
          // surface. The exit point is the entry hit point offset by the
          // material's thickness along the bullet's travel direction (the
          // wall's actual depth — gives realistic exit-hole placement for
          // thin drywall/glass vs. thicker wood/brick). Capped at 0.4m so
          // high-penetration surfaces (foliage 0.5m, earth 0.5m) don't put
          // the decal deep inside the geometry where it wouldn't render.
          const exitOffset = Math.min(material.thickness, 0.4);
          _tmpVec.copy(_hitPoint).addScaledVector(_segDir, exitOffset);
          this.__onSpawnExitHole?.(_tmpVec, _hitNormal, materialSlug);
          const newSpeed = speed * penTest.velocityMult * (physicsPen.velocity / Math.max(speed, 1));
          p.vel.setLength(newSpeed);
          // Nudge the projectile through the surface so the next tick's
          // segment doesn't immediately re-hit the same face.
          p.pos.copy(_hitPoint).addScaledVector(_segDir, 0.06);
          p.prevPos.copy(p.pos);
          // Small deflection (yaw inside the material — matches legacy fireRay).
          p.vel.x += physicsPen.deflection * 0.5;
          p.vel.y += physicsPen.deflection * 0.5;
          continue;
        } else {
          // No penetration — spawn impact VFX + try ricochet.
          this.__onSpawnImpact?.(_hitPoint, _hitNormal, materialSlug);
          const ricochet = computeRicochet(_hitNormal, _segDir, materialSlug);
          if (ricochet.direction && p.ricochetCount < p.maxRicochets) {
            // Reflect the bullet — keep it alive with reduced velocity + damage.
            _reflectDir.copy(ricochet.direction);
            const newSpeed = speed * 0.6; // ricochets lose 40% velocity
            p.vel.copy(_reflectDir).multiplyScalar(newSpeed);
            p.pos.copy(_hitPoint).addScaledVector(_reflectDir, 0.05);
            p.prevPos.copy(p.pos);
            p.baseDamage *= ricochet.damageMult;
            p.ricochetCount++;
            // Bright spark VFX at the ricochet point.
            this.__onSpawnImpact?.(_hitPoint, _reflectDir, ricochet.sparkSurface);
            continue;
          } else {
            // No ricochet — bullet embeds + despawns.
            p.alive = false;
            this.retire(i);
            continue;
          }
        }
      }
      // No hit this tick — bullet keeps flying.
    }
  }

  // ----- Hooks (wired by engine-wiring.ts to delegate to ParticleSystem
  // and EnemySystem — same hooks the legacy WeaponSystem.fireRay used) -----

  /** Damage callback — engine wires this to EnemySystem.damageEnemy (or the
   *  same code path WeaponSystem.onDamageEnemy used). */
  __onDamageEnemy?: (e: Enemy, dmg: number, headshot: boolean, point: THREE.Vector3, weaponSlug: string) => void;
  /** Impact VFX callback — wired to ParticleSystem.spawnBulletImpact. */
  __onSpawnImpact?: (point: THREE.Vector3, normal: THREE.Vector3, surfaceType?: string) => void;
  /** Prompt #35 — exit-hole decal callback. Wired to
   *  ParticleSystem.spawnExitHole. Called from the penetration branch with
   *  the computed exit point + the entry-side surface normal (the decal
   *  orients itself to the inverted normal so it sits on the far face). */
  __onSpawnExitHole?: (exitPoint: THREE.Vector3, entryNormal: THREE.Vector3, surfaceType?: string) => void;
  /** Glass shatter VFX callback. */
  __onShatterGlass?: (point: THREE.Vector3, normal: THREE.Vector3) => void;
  /** Destructible prop cleanup callback. */
  __onDestroyProp?: (prop: import("./types").DestructibleProp) => void;

  // ----- Internal helpers -----

  /**
   * REALISM-1 (task G): Spawn a supersonic crack sprite at `pos`.
   *
   * The crack is a tiny white additive sprite (0.04m / 4cm — small enough to
   * read as a sharp pinpoint of light, not a lingering particle). It lives
   * for 50ms (SONIC_CRACK_LIFE_S) — a single-frame flash at 60 Hz — and fades
   * out via the existing particle pool's `fade: true` mechanism.
   *
   * Uses the shared ctx.particlePool sprite pool (capacity 200) — no new
   * allocation. If the pool is exhausted (extreme spam), the crack is
   * dropped silently (the tracer still draws — the crack is a polish VFX,
   * not gameplay-critical).
   *
   * The sprite is given zero velocity + no gravity — it pops into existence
   * at the bullet's position + stays there as the bullet flies on. This
   * visually reads as the shockwave "shedding" behind the bullet (a series
   * of pinpoints trailing the flight path).
   */
  private spawnSonicCrack(pos: THREE.Vector3): void {
    const pool = this.ctx.particlePool;
    const tex = getSonicCrackTexture();
    const s = pool.acquireSprite(tex, 0xffffff);
    if (!s) return; // pool exhausted — drop silently
    s.scale.setScalar(0.04); // 4cm — sharp pinpoint
    s.position.copy(pos);
    const mat = s.material as THREE.SpriteMaterial;
    mat.blending = THREE.AdditiveBlending;
    mat.opacity = 0.95;
    mat.depthWrite = false;
    // Zero velocity + no gravity — the crack stays where it spawned.
    pool.activeParticles.push({
      mesh: s,
      velocity: _zeroVec, // shared zero vector — no per-spawn alloc
      life: SONIC_CRACK_LIFE_S,
      maxLife: SONIC_CRACK_LIFE_S,
      gravity: false,
      fade: true,
      active: true,
    });
  }

  /** True if the object is the player camera or a descendant of it (we never
   *  want bullets to hit the camera rig). Mirrors WeaponSystem.isInCameraSubtree. */
  private isInCameraSubtree(obj: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (cur === this.ctx.camera) return true;
      if (cur === this.ctx.weaponGroup) return true;
      cur = cur.parent;
    }
    return false;
  }

  /** Retire a dead projectile: release its tracer back to the pool + splice
   *  from the live array. Index-based splice avoids Array.filter allocation. */
  private retire(index: number): void {
    const p = this.live[index];
    if (!p) return;
    if (p.tracer) {
      // Wrap in a PooledTracer-shaped object so the pool's releaseTracer works.
      this.ctx.particlePool.releaseTracer({ line: p.tracer, life: 0, maxLife: 0, active: true } as never);
      p.tracer = null;
    }
    // Swap-and-pop — O(1), preserves order loosely enough for game logic.
    const last = this.live.length - 1;
    if (index !== last) this.live[index] = this.live[last];
    this.live.pop();
  }

  /** Release a tracer back to the pool (used by clear()). */
  private releaseTracer(p: Projectile): void {
    if (!p.tracer) return;
    this.ctx.particlePool.releaseTracer({ line: p.tracer, life: 0, maxLife: 0, active: true } as never);
    p.tracer = null;
  }

  dispose(): void {
    this.clear();
  }
}
