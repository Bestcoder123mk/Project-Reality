import * as THREE from "three";
import type { AudioEngine } from "../audio";
import type {
  LoadoutConfig,
  EffectiveWeaponStats,
  Settings,
  HudState,
  ViewMode,
} from "../store";
import type {
  BallisticsMaterial,
  WeatherState,
  CasualtyState,
} from "../realism";
import type { EnemyFSM } from "../fsm/EnemyFSM";
import type { ParticleSystemPool } from "./ObjectPool";
import type { VaultState } from "./VaultSystem";
import type { MalfunctionState } from "./MalfunctionSystem";
import type { PostProcessing } from "./PostProcessing";
import type { ChunkManager } from "./ChunkManager";
import type { PickupSystem } from "./PickupSystem";
import type { LODSystem } from "./LODSystem";
import type { RagdollSystem } from "./RagdollSystem";

// ---------- World ----------

export interface Collider {
  box: THREE.Box3;
}

export interface DestructibleProp {
  mesh: THREE.Mesh;
  health: number;
  maxHealth: number;
  materialSlug: string;
  stage: number; // 0=intact, 1=damaged, 2=breached
  collider: Collider;
  baseScale: number;
}

export interface Tracer {
  line: THREE.Line;
  life: number;
  maxLife: number;
}

/**
 * REAL-BALLISTICS — a traveling bullet entity with full physics integration.
 *
 * Replaces the legacy hitscan `fireRay` multi-segment raycast. Each shot
 * spawns one Projectile per pellet (1 for rifles/snipers/pistols/LMGs/SMGs,
 * 7 for shotguns). The ProjectileSystem integrates position + velocity every
 * fixed-step (60 Hz), applies gravity + air drag + wind drift, and raycasts
 * the segment traveled THIS frame (prevPos → pos) against enemies + environment
 * — that's the key change that introduces real travel time.
 *
 * Lifecycle:
 *   1. WeaponSystem.tryShoot spawns N projectiles (one per pellet).
 *   2. ProjectileSystem.update integrates every live projectile forward by dt.
 *   3. Per-frame segment raycast detects enemy hits, env hits, penetrations,
 *      ricochets — applying damage + impact VFX exactly as the legacy fireRay
 *      did, but with travel time + arcing trajectory + per-frame tracer.
 *   4. Projectiles despawn when: velocity < 30 m/s, distanceTraveled > maxRange,
 *      ricochetCount > maxRicochets, or age > 5s (defensive cap).
 *
 * Tracer visual: the projectile's own line mesh is updated per-frame to
 * span prevPos → pos, so the streak follows the actual arc. Suppressed
 * weapons spawn projectiles with `tracerHidden = true` (no visible streak,
 * stealth).
 */
export interface Projectile {
  /** Current world position (m). */
  pos: THREE.Vector3;
  /** Previous frame's world position — segment raycast origin each tick. */
  prevPos: THREE.Vector3;
  /** Current velocity vector (m/s). Magnitude = current speed. */
  vel: THREE.Vector3;
  /** Initial muzzle velocity (m/s). Used for penetration + falloff math. */
  muzzleVelocity: number;
  /** Bullet mass (g). Affects drag deceleration + wind drift + penetration. */
  mass: number;
  /** Drag coefficient (1/m). Higher = slows faster. Typical 0.0008–0.003. */
  dragCoef: number;
  /** Gravity multiplier (1.0 = full 9.81 m/s²). Snipers < 1, pistols > 1. */
  gravityScale: number;
  /** Base damage at the muzzle (before velocity falloff). */
  baseDamage: number;
  /** Headshot multiplier applied when the segment hits an enemy head. */
  headshotMult: number;
  /** Weapon category — drives penetration multiplier + tracer color. */
  category: string;
  /** Max travel distance before despawn (m). Replaces the legacy raycast.far cap. */
  maxRange: number;
  /** Distance traveled so far (m). */
  distanceTraveled: number;
  /** Age in seconds. Defensive despawn at 5s. */
  age: number;
  /** Ricochet bounces so far. Despawn at maxRicochets. */
  ricochetCount: number;
  /** Max ricochets allowed (0 = no bounces, 1 = one bounce max). */
  maxRicochets: number;
  /** Tracer line mesh (pooled). null for suppressed weapons. */
  tracer: THREE.Line | null;
  /** Tracer color hex. */
  tracerColor: number;
  /** Player team — projectiles only damage the opposing team. */
  team: "player" | "enemy";
  /** Weapon slug that fired this projectile (for killfeed + sound profiling). */
  weaponSlug: string;
  /** True once this projectile has dealt damage (single-hit per projectile
   *  to match the legacy fireRay `dealt` flag — penetration through an
   *  enemy is allowed but only the FIRST enemy hit takes damage). */
  hasDealtDamage: boolean;
  /** True while the projectile should be integrated + raycast. */
  alive: boolean;
  /** SEC8 prompt 67 — set true once this enemy projectile has triggered a
   *  whiz-by sound when passing near the player's head. Prevents repeated
   *  whiz-by triggers for the same bullet (one per projectile lifetime).
   *  Player projectiles never trigger whiz-by (the player fired them — they
   *  don't whiz past their own head). */
  whizPlayed?: boolean;
}

export interface Particle {
  mesh: THREE.Mesh | THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: boolean;
  fade: boolean;
}

// ---------- Enemy ----------

export type EnemyState = "idle" | "chase" | "attack" | "dead";

export interface Enemy {
  group: THREE.Group;
  head: THREE.Mesh;
  body: THREE.Mesh;
  parts: Record<string, THREE.Mesh>;
  health: number;
  maxHealth: number;
  alive: boolean;
  velocity: THREE.Vector3;
  /** V6 — unique enemy ID (set on spawn). Used by the cognition system
   *  (CognitionRuntime + PerceptionSystem) to identify enemies across
   *  perception snapshots + memory stores. Was missing before — the
   *  cognition code accessed enemy.id which was always undefined. */
  id: string;
  /** Legacy string state — kept for HUD/back-compat; the authoritative state is `fsm.state`. */
  state: EnemyState;
  /** P2.2: per-enemy FSM. Created on spawn. */
  fsm?: EnemyFSM;
  lastShot: number;
  hitFlash: number;
  deadTime: number;
  spawnPos: THREE.Vector3;
  team: "enemy";
  speed: number;
  accuracy: number;
  gaitPhase: number;
  lookAtTarget: number; // head tracking pitch
  /** V2.3 — timestamp (performance.now()) of the last time this enemy was
   *  damaged by the player. Drives the on-spot nameplate fade. */
  lastDamagedTime: number;
  /** V2.3 — enemy class label shown on the nameplate. */
  className: string;
  /** Prompt #53 — per-enemy suppression scalar (0..1). Driven by player
   *  bullets whizzing past the enemy (ProjectileSystem calls
   *  ctx.addEnemySuppression). Decays toward 0 in SuppressionSystem.update.
   *  When this crosses the enemy's FSM suppressionThreshold (default 0.6),
   *  the FSM transitions to SUPPRESSED — the enemy stops advancing, crouches
   *  behind the nearest LOS-blocking cover, and peeks out every 2-3s to take
   *  a snap shot then ducks back. Recovered (back to CHASE) when suppression
   *  decays below the recoveryThreshold (default 0.2). */
  suppression?: number;
  /** Prompt #53 — true while the enemy is in a crouched posture (SUPPRESSED
   *  or COVER state). Mirrors the visual crouch driven by applyCrouch in
   *  enemy-tactics.ts (which lowers group.position.y). Read by other systems
   *  that need to know the enemy's posture without inspecting the rig. */
  crouching?: boolean;
}

// ---------- Player ----------

export interface PlayerState {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  crouching: boolean;
  bobTime: number;
  stepTimer: number;
  health: number;
  armor: number;
  viewMode: ViewMode;
  viewModeBlend: number;
  thirdPersonDist: number;
  /** Realism: world-space direction (yaw radians) the last damage came from.
   *  Used by the HUD directional damage indicator. -1 = no recent damage. */
  lastDamageDir: number;
  /** Realism: timestamp (performance.now()) of the last damage event. */
  lastDamageTime: number;
  /** Lean: -1 = left, 0 = center, +1 = right. Driven by [ and ] keys. */
  lean: number;
  /** Task-8: sliding state — true during a slide burst (crouch-while-sprinting). */
  sliding?: boolean;
  /** Task-8: slide elapsed time (seconds; resets to 0 when slide ends). */
  slideTime?: number;
  /** Task-14: dolphin dive active flag (crouch-while-sprinting-airborne). */
  diving?: boolean;
  /** Task-14: dolphin dive elapsed time (seconds). */
  diveTime?: number;
  /** Task-14: dolphin dive phase — "air" (forward launch) → "prone" (stationary recover). */
  divePhase?: "air" | "prone";
  /** Task-14: true while the player is on a ladder (climbing). Disables gravity,
   *  sprint, slide, and dive. Set by VaultSystem.tryLadder when a forward raycast
   *  hits a mesh tagged userData.isLadder. */
  onLadder?: boolean;
}

// ---------- Weapon ----------

export interface WeaponState {
  loadout: LoadoutConfig;
  stats: EffectiveWeaponStats;
  ammo: number;
  reserveAmmo: number;
  lastShotTime: number;
  reloading: boolean;
  reloadStart: number;
  reloadPhase: number;
  recoilOffset: number;
  weaponRecoilKick: THREE.Vector3;
  isAiming: boolean;
  aimBlend: number;
  fireHeld: boolean;
  switchAnim: number;
  baseFov: number;
  /** P-fix: saved primary weapon when switched to secondary. */
  primaryWeapon: import("../store").WeaponType;
  /** P-fix: which slot is active. Extended to 4 slots (Prompt 8). */
  activeSlot: "primary" | "secondary" | "melee" | "utility";
  /** Prompt 8: numeric slot index (0=primary,1=secondary,2=melee,3=utility)
   *  for the HUD loadout strip + Digit1-4 direct selection. */
  activeSlotIndex: 0 | 1 | 2 | 3;
  /** Recoil pattern shot counter (increments per shot, wraps at 30). */
  shotCount: number;
  /** Weapon inspect animation timer (0 = not inspecting, >0 = playing). */
  inspectAnim: number;
  /** Prompt A#49 — first-person animation state machine. Instantiated by
   *  buildWeaponViewmodel + ticked + sampled each frame by PhysicsSystem's
   *  viewmodel driver. Holds the canonical idle/ads/sprint/fire/reload/
   *  inspect state + the crossfade blend between states. Null until the
   *  viewmodel is built (engine constructs it before the first frame). */
  fpStateMachine?: import("../animation/fp-state-machine").FPAnimStateMachine;
  /** Prompt #44 — Barrel heat (0..1). Increases per shot, decays over time.
   *  When > 0.5, adds extra spread to the fire cone (accuracy degradation
   *  from sustained auto fire). Also feeds MalfunctionSystem as extra wear
   *  on the weapon (hot barrels erode faster + are more likely to jam). */
  barrelHeat: number;
}

// ---------- Match ----------

export interface MatchState {
  score: number;
  kills: number;
  deaths: number;
  wave: number;
  maxWaves: number;
  enemiesPerWave: number;
  enemiesRemaining: number;
  totalEnemiesThisWave: number;
  waveTransitioning: boolean;
  matchOver: boolean;
  fpsAccum: number;
  fpsFrames: number;
  fpsTime: number;
  matchStartTime: number;
  /** V5.4 — current killstreak (resets on death). */
  killstreak: number;
  /** V5.4 — best killstreak this match. */
  killstreakBest: number;
  /** V5.4 — recon-drone reward ready to deploy (3-kill tier). */
  reconReady: boolean;
  /** V5.4 — airstrike reward ready to deploy (7-kill tier). */
  airstrikeReady: boolean;
  /** V5.4 — timestamp until which recon reveals enemies on the minimap. */
  reconActiveUntil: number;
  /** G1.1 — active game mode (SURVIVAL/EXTRACTION/VIP/BREACH/HORDE). */
  mode: string;
  /** G1.5 — hard cap on concurrent alive enemies (HORDE/EXTRACTION). */
  concurrentEnemyCap: number;
  /** G1.3 — true when the player has picked up the extraction objective. */
  extractionCarrying: boolean;
  /** G1.4 — current breach room index (0-based; -1 = not breach mode). */
  breachRoomIndex: number;
  /** G4.1 — headshots this match (for challenge tracking). */
  headshots: number;
  /** G4.1 — melee/takedown kills this match (for challenge tracking). */
  meleeKills: number;
  /** Task-6: timestamps (performance.now()) of recent kills. Used by the
   *  multi-kill detector (DOUBLE KILL / TRIPLE KILL / etc.). Entries older
   *  than 2s are pruned each kill. */
  recentKills: number[];
  /** Task-13 — true while the buy station overlay is open between waves.
   *  Engine sets this when a non-victory wave clears; cleared when the next
   *  wave starts (or the player clicks READY). */
  buyStationActive?: boolean;
  /** Task-13 — running total of credits spent at the buy station this match.
   *  Subtracted from the match-end earn call so server-side credits stay in
   *  sync with the local profile. */
  creditsSpentThisMatch?: number;
  /** Task-13 — buyable grenade inventory (frag/flash/smoke counts). Frags
   *  also bump GrenadeSystem.grenadesLeft so the player can throw them; flash
   *  + smoke are tracked for inventory display + future use (the existing
   *  GrenadeSystem only throws one type). */
  grenadeInventory?: { frag: number; flash: number; smoke: number };
  /** Task-13 — buyable deployable inventory (turret/claymore/c4 counts).
   *  Tracked as counts; the engine deploys them at the player's position
   *  when purchased (no separate place key needed since InputSystem is
   *  outside this task's scope). */
  deployableInventory?: { turret: number; claymore: number; c4: number };
}

/** Task-13 — Deployable state (turrets, claymores, C4 purchased from the buy
 *  station). Stored in `ctx.deployables` and updated by the engine loop. */
export interface Deployable {
  /** Kind — drives behavior + visual. */
  kind: "turret" | "claymore" | "c4";
  /** World-space mesh (a simple box + barrel for turrets; a small box for
   *  claymores/C4). Owned by the engine; removed from the scene on explode. */
  mesh: THREE.Object3D;
  /** Position the deployable was placed at (player position at purchase). */
  pos: THREE.Vector3;
  /** True once the deployable is armed (claymores/C4 have a 1s arm delay;
   *  turrets arm immediately). */
  armed: boolean;
  /** Time remaining until armed (seconds). 0 once armed. */
  armTimer: number;
  /** Time remaining for turrets (30s lifetime). -1 for claymores/C4. */
  life: number;
  /** Timestamp (performance.now()) of the last turret shot. */
  lastFire: number;
  /** True once the deployable has exploded (claymores/C4). */
  exploded: boolean;
}

// ---------- Medical ----------

export interface MedicalState {
  casualtyState: CasualtyState;
  bleedRate: number;
  fractureLimb: string;
  inventory: { bandage: number; splint: number; epi: number; medkit: number };
  channel: { slug: string; progress: number; duration: number } | null;
}

// ---------- Realism (suppression, weather) ----------

export interface SuppressionState {
  value: number; // 0..1
}

/** P4.2: Stamina — gates sprinting, jumping, and aiming under load. */
export interface StaminaState {
  /** Current stamina (0..max). */
  value: number;
  /** Max stamina. */
  max: number;
  /** Regen rate (per second) when not exerting. */
  regenRate: number;
  /** Drain rate (per second) when sprinting. */
  sprintDrainRate: number;
  /** Drain per jump. */
  jumpCost: number;
  /** Drain per second when aiming down sights (small). */
  aimDrainRate: number;
  /** Cooldown after exhaustion (seconds) before regen resumes. */
  exhaustionCooldown: number;
  /** Timestamp when regen can resume (performance.now()). */
  regenResumesAt: number;
  /** True if currently exhausted (stamina hit 0). */
  exhausted: boolean;
}

// ---------- Scratch allocation (P2.4 will expand this) ----------

export interface ScratchAlloc {
  v1: THREE.Vector3;
  v2: THREE.Vector3;
  v3: THREE.Vector3;
  v4: THREE.Vector3;
  v5: THREE.Vector3;
  box1: THREE.Box3;
  box2: THREE.Box3;
  rayOrigin: THREE.Vector3;
  rayDir: THREE.Vector3;
}

// ---------- GameContext (shared state passed to all systems) ----------

export interface GameContext {
  // Core three.js
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  clock: THREE.Clock;
  container: HTMLElement;

  // World
  colliders: Collider[];
  destructibles: DestructibleProp[];
  materials: BallisticsMaterial[];

  // Player
  player: PlayerState;
  avatar: { group: THREE.Group; parts: Record<string, THREE.Mesh> } | null;
  avatarGaitPhase: number;

  // Weapon viewmodel
  weaponGroup: THREE.Group;
  gunParts: { gun: THREE.Group; mag?: THREE.Mesh; handle?: THREE.Mesh; muzzleTip: THREE.Object3D };
  muzzleLight: THREE.PointLight;
  muzzleFlash: THREE.Mesh;
  muzzleTimer: number;
  weaponSwayPhase: number;
  weaponSwayOffset: THREE.Vector3;
  breathingPhase: number;
  muzzleTipObj: THREE.Object3D;

  // Entities
  enemies: Enemy[];
  tracers: Tracer[];
  particles: Particle[];
  decals: THREE.Mesh[];
  /** P2.4: object pool for particles/tracers/decals. Eliminates per-frame allocations. */
  particlePool: ParticleSystemPool;
  /** REAL-BALLISTICS — traveling bullet entities with full physics integration.
   *  Populated by WeaponSystem.tryShoot (and enemy fire); integrated + raycast
   *  per-frame by ProjectileSystem. Spawns live here so any system can read
   *  active bullets (e.g. for hit-feel feedback, debug overlay, slow-mo VFX). */
  projectiles: Projectile[];
  /** REAL-BALLISTICS — ProjectileSystem reference. Set by the engine after
   *  construction. WeaponSystem calls ctx.spawnProjectile?.(...) to fire. */
  projectileSystem?: ProjectileSystemLike | null;

  // Weapon / loadout state
  weapon: WeaponState;

  // Match state
  match: MatchState;

  // Realism
  medical: MedicalState;
  suppression: SuppressionState;
  /** P4.2: stamina system state. */
  stamina: StaminaState;
  /** P4.3: vault/mantle animation state. */
  vault: VaultState;
  /** P4.5: weapon malfunction + condition state. */
  weaponMalfunction: MalfunctionState;
  weather: WeatherState;
  weatherTime: number;
  rainParticles: THREE.Points | null;
  sunLight: THREE.DirectionalLight | null;
  hemiLight: THREE.HemisphereLight | null;
  skyMesh: THREE.Mesh | null;

  // Input
  keys: Record<string, boolean>;
  paused: boolean;
  running: boolean;

  // Settings
  settings: Settings;

  // Audio
  audio: AudioEngine;

  // Helpers
  raycaster: THREE.Raycaster;
  scratch: ScratchAlloc;

  // HUD events (system -> store)
  pushHud: (partial: Partial<HudState>) => void;
  addKillFeed: (entry: { killer: string; victim: string; weapon: string; headshot: boolean }) => void;

  // Engine-level callbacks (engine implements these)
  onVictory: () => void;
  onGameOver: () => void;
  onStartWave: (wave: number) => void;
  onPointerLockChange: (locked: boolean) => void;
  requestPointerLock: () => void;
  exitPointerLock: () => void;
  isPointerLocked: () => boolean;
  /** Prompt A#5 — WebGL context-lost flag. Set true on `webglcontextlost`,
   *  cleared on `webglcontextrestored`. The engine loop skips rendering
   *  while true; the renderer's render targets + textures are invalid
   *  until restore completes. */
  contextLost: boolean;
  /** Prompt A#5 — engine hooks this to its context-restore handler
   *  (re-uploads textures, rebuilds render targets, recompiles materials,
   *  resumes the loop). Called by the `webglcontextrestored` DOM listener
   *  in context-factory.ts. */
  onContextRestored: () => void;
  /** Wave fix: schedule a wave-transition callback that auto-cancels if the
   *  match ends / restarts before it fires. Replaces raw setTimeout in
   *  EnemySystem so the engine can cancel stale transitions. */
  scheduleWaveTransition: (cb: () => void, delayMs: number) => void;
  /** Wave fix: cancel any pending wave-transition callback immediately. */
  cancelWaveTransition: () => void;
  /** Camera juice: trigger a screen shake (explosions, damage, heavy impacts). */
  triggerShake: (intensity: number) => void;

  /** Task-6: optional reference to the post-processing pipeline. Set by the
   *  engine after PostProcessing is constructed. SuppressionSystem reads this
   *  to drive the desaturation/vignette suppression visual. May be null in
   *  headless / debug contexts. */
  postProc: PostProcessing | null;

  /** V2 — chunk streaming manager. Built by RendererSystem.buildLevelFromMap
   *  after the map's chunk groups are constructed. Toggles chunk group
   *  visibility per-frame based on the camera frustum so only visible chunks
   *  render. null when no map is loaded. */
  chunkManager: ChunkManager | null;

  /** V3 — health + ammo pickup system. Spawns pickups from enemy deaths
   *  (medkit 1/10, bandage 1/3, ammo 1/3), updates them per-frame (float +
   *  rotate + proximity collect), and removes them on collect/expire. null
   *  until the engine constructs it. */
  pickups: PickupSystem | null;

  /** Task-14 — LOD system: per-enemy part-culling at distance. Built by the
   *  engine after the enemy system. Recomputes LOD tier per enemy every 200ms
   *  (throttled) and toggles detail part visibility to reduce render cost.
   *  null in headless / debug contexts. */
  lodSystem: LODSystem | null;

  /** Task-22 — ragdoll physics for dead enemies. Built by the engine after
   *  the enemy system. When EnemySystem.killEnemy fires, it calls
   *  activateRagdoll() instead of the legacy flat-rotation; the system
   *  integrates the ragdoll per frame (Verlet + constraint solve + collide)
   *  and updates the enemy's skeleton meshes to follow. Ragdolls freeze
   *  after ~3s or when they settle. Cleared on wave transition / match
   *  restart. null in headless / debug contexts. */
  ragdolls: RagdollSystem | null;

  /** G1.2 — VIP NPC (VIP Escort mode). null when not in VIP mode or VIP dead. */
  vip: VipNpc | null;
  /** G1.3 — Extraction objective prop. null when not in EXTRACTION mode. */
  extractionObjective: ExtractionObjective | null;
  /** G1.3 — Extraction zone trigger. null when not in EXTRACTION mode. */
  extractionZone: ExtractionZone | null;

  /** Task-5 — Enemy grenade throw hook. Set by GrenadeSystem.constructor
   *  (self-registers). When undefined, the grenade system hasn't been
   *  constructed yet (or has been disposed) — callers should no-op. */
  enemyGrenadeThrow?: EnemyGrenadeThrowFn;

  /** Prompt 11 — FinisherSystem reference (set by engine after construction).
   *  EnemySystem.killEnemy calls maybeTriggerFinisherOnKill before the ragdoll. */
  finishers?: import("./FinisherSystem").FinisherSystem;

  /** Task-13 — slow-mo time scale (1.0 = normal, 0.2 = 5x slow motion).
   *  Set by triggerSlowMotion; the engine loop multiplies dt by this value
   *  before passing to systems. Defaults to 1.0 (no slow-mo). */
  timeScale?: number;

  /** Task-13 — active deployables in the world (turrets, claymores, C4
   *  purchased from the buy station). Engine updates this array each frame
   *  in the loop. */
  deployables?: Deployable[];

  /** Task-13 — hook fired by EnemySystem.killEnemy when a non-victory wave
   *  is cleared (enemiesRemaining hits 0 and !isVictoryWave). The engine
   *  wires this to open the buy station overlay between waves. */
  onWaveCleared?: (wave: number) => void;

  /** Task-13 — hook fired by EnemySystem.killEnemy on the final-wave final-
   *  kill. The engine implements cinematic slow-motion (1.5s slow + 0.5s
   *  ramp) and then triggers the victory screen. */
  triggerSlowMotion?: (durationMs: number) => void;

  /** Prompt #53 — per-enemy suppression increment. Wired by the engine to
   *  SuppressionSystem.addEnemySuppression. Called by ProjectileSystem when
   *  a player projectile passes within ~2m of an enemy (a near-miss) — each
   *  such pass adds a small suppression bump (~0.15) to that enemy. When the
   *  enemy's suppression crosses its FSM suppressionThreshold (default 0.6),
   *  the FSM transitions to SUPPRESSED (duck behind cover, peek, blind-fire).
   *  May be undefined in headless / debug contexts — callers should no-op. */
  addEnemySuppression?: (e: Enemy, amount: number) => void;

  /** Task-9 (Prompt #33) — Real impulse-based physics backend for fracture
   *  shards (and future debris / ragdoll props). Instantiated by the engine
   *  (ImpulsePhysicsBackend from physics/PhysicsBackend.ts), stepped at the
   *  fixed 60 Hz physics tick, and fed all level colliders as static bodies
   *  on level build so dynamic shard bodies collide with walls/floor.
   *  null in headless / pre-engine-init contexts — callers should no-op. */
  physicsBackend?: import("../physics/PhysicsBackend").PhysicsBackend;

  /** A2-5000-retry #367/#368/#369/#370/#371 — AI subsystems wired by the
   *  engine on match start + ticked per-frame in the loop. All three are
   *  optional (null until the engine constructs them, null in headless /
   *  debug contexts — callers should `?.` no-op).
   *
   *  - director: process-wide AIDirector singleton (initAIDirector on match
   *    start, destroyAIDirector on dispose). Holds the rolling performance-
   *    signal window + emits PacingDecision (spawnRateMult / aggressionMult /
   *    intensity). Other systems read `ctx.ai?.director?.getDecision()` to
   *    apply the multiplier (Section D #501-506 implemented the decision
   *    shape + getters; this wiring closes the loop so the singleton is no
   *    longer always null).
   *  - squads: SquadCoordinator singleton. The engine ticks it once per
   *    frame (throttled internally to ~2 Hz). register/unregister of
   *    individual enemies still belongs to EnemySystem (the engine can't
   *    hook startWave / killEnemy without intruding on that file's
   *    ownership); the per-frame tick is the integration point the engine
   *    owns.
   *  - companion: spawned in VIP / EXTRACTION modes (engine.start() after
   *    buildVip/buildExtraction). The engine ticks it per-frame + disposes
   *    on match end. */
  ai?: {
    director: import("../ai/director").AIDirector | null;
    squads: import("../ai/squad-coordinator").SquadCoordinator | null;
    companion: import("../ai/companion").Companion | null;
  };
}

/** G1.2 — VIP NPC state. */
export interface VipNpc {
  group: THREE.Group;
  parts: Record<string, THREE.Mesh>;
  health: number;
  maxHealth: number;
  alive: boolean;
  /** Patrol waypoints (world positions). */
  waypoints: THREE.Vector3[];
  /** Current target waypoint index. */
  currentWaypoint: number;
  /** Pause timer (brief stop at each waypoint). */
  pauseUntil: number;
  /** Movement speed. */
  speed: number;
  /** Gait phase for animation. */
  gaitPhase: number;
}

/** G1.3 — Extraction objective prop. */
export interface ExtractionObjective {
  mesh: THREE.Mesh;
  position: THREE.Vector3;
  pickedUp: boolean;
  /** Whether the prop is currently interactable (proximity check). */
  interactable: boolean;
}

/** G1.3 — Extraction zone trigger volume. */
export interface ExtractionZone {
  mesh: THREE.Mesh;
  center: THREE.Vector3;
  radius: number;
}

/** Task-5 — Grenade throw hook. Wired by GrenadeSystem.constructor (it
 *  self-registers as the implementor), so any system holding the context
 *  can request an enemy grenade throw without going through the engine.
 *  Origin = throw position (enemy chest), target = player position. */
export type EnemyGrenadeThrowFn = (origin: THREE.Vector3, target: THREE.Vector3) => void;

// ---------- System interface ----------

export interface GameSystem {
  /** Called every frame (when not paused). dt is delta seconds, clamped to 0.05. */
  update(dt: number): void;
  /** Optional: called once per frame after systems update, before render. */
  postUpdate?(dt: number): void;
  /** Optional: release per-system resources (called from engine.dispose()). */
  dispose?(): void;
  /** ANIM-POLISH — Optional render-pose interpolation. Called once per RAF
   *  frame with `alpha` ∈ [0, 1) representing how far we are between the
   *  last fixed-step physics tick (alpha=0) and the next one (alpha=1).
   *  Systems that maintain a "previous" + "current" physics pose should
   *  lerp between them by `alpha` and apply the result to the rendered
   *  Object3Ds. Opt-in: systems that don't implement `interpolate` just
   *  render with the latest physics pose (the existing behavior — still
   *  smoother than variable-dt because physics is now deterministic at
   *  60 Hz, but a system that implements this can produce fully frame-rate-
   *  independent motion). */
  interpolate?(alpha: number): void;
}

/**
 * REAL-BALLISTICS — minimal interface for the ProjectileSystem exposed on
 * GameContext so WeaponSystem (and enemy AI) can request a projectile spawn
 * without a circular import on the concrete class.
 */
export interface ProjectileSystemLike {
  /** Spawn a single projectile. Caller is responsible for setting origin,
   *  direction (unit vector), category, baseDamage, etc. The system handles
   *  the rest (mass/drag/gravity lookup, tracer mesh acquisition, integration). */
  spawn(opts: ProjectileSpawnOpts): void;
  /** Live projectile count — for debug overlay + cap enforcement. */
  count(): number;
  /** Clear all live projectiles (called on match restart). */
  clear(): void;
}

export interface ProjectileSpawnOpts {
  /** Muzzle world position. */
  origin: THREE.Vector3;
  /** Initial travel direction (unit vector). */
  direction: THREE.Vector3;
  /** Weapon category — drives muzzle velocity, drag, gravity, penetration. */
  category: string;
  /** Base damage at the muzzle. */
  baseDamage: number;
  /** Headshot multiplier (typically 2.0–2.5). */
  headshotMult: number;
  /** Max travel distance (m). */
  maxRange: number;
  /** Team firing this projectile (player/enemy). */
  team: "player" | "enemy";
  /** Weapon slug that fired (for killfeed). */
  weaponSlug: string;
  /** Tracer color hex (player weapons use category-coded colors; enemy
   *  projectiles use red). Set 0 to suppress the tracer entirely. */
  tracerColor: number;
  /** When true, no tracer mesh is created (suppressed weapons). */
  tracerHidden: boolean;
  /** Override the category default muzzle velocity (m/s). Optional. */
  muzzleVelocity?: number;
  /** Override the category default mass (g). Optional. */
  mass?: number;
  /** Override the category default drag coefficient. Optional. */
  dragCoef?: number;
  /** Override the category default gravity scale. Optional. */
  gravityScale?: number;
  /** Max ricochets (default 1 for non-suppressed, 0 for suppressed). */
  maxRicochets?: number;
}
