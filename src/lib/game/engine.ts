import * as THREE from "three";
import {
  useGameStore,
  computeWeaponStats,
  type Settings,
  type LoadoutConfig,
  type WeaponType,
} from "./store";
import type { BallisticsMaterial } from "./realism";
import type { GameContext, GameSystem, Deployable } from "./systems/types";
import type { Enemy } from "./systems/types";
import { createContext } from "./systems/context-factory";
import { RendererSystem } from "./systems/RendererSystem";
import { InputSystem } from "./systems/InputSystem";
import { PhysicsSystem } from "./systems/PhysicsSystem";
import { WeaponSystem } from "./systems/WeaponSystem";
import { EnemySystem } from "./systems/EnemySystem";
import { ParticleSystem } from "./systems/ParticleSystem";
import { WeatherSystem } from "./systems/WeatherSystem";
import { MedicalSystem } from "./systems/MedicalSystem";
import { SuppressionSystem } from "./systems/SuppressionSystem";
import { AudioSystem } from "./systems/AudioSystem";
import { HudSystem } from "./systems/HudSystem";
import { ProceduralAnimSystem } from "./systems/ProceduralAnimSystem";
import { StaminaSystem } from "./systems/StaminaSystem";
import { MalfunctionSystem } from "./systems/MalfunctionSystem";
import { MeleeSystem } from "./systems/MeleeSystem";
import { GrenadeSystem } from "./systems/GrenadeSystem";
import { FinisherSystem } from "./systems/FinisherSystem";
import { MatchFSM } from "./fsm/MatchFSM";
import { FrameBudgetProfiler, type QualityTier } from "./systems/FrameBudgetProfiler";
// Section L — Performance Optimization stack init + per-frame tick.
// Wrapped so failures don't break the engine; the stack is null until
// initPerformanceStack() resolves (async — sets up WebGPU, workers, etc.).
import {
  initPerformanceStack,
  tickPerformanceStack,
  disposePerformanceStack,
  type PerformanceStack,
} from "./perf";
import { wireEngineCallbacks } from "./engine-wiring";
import { getMap } from "./maps/MapRegistry";
import { PostProcessing } from "./systems/PostProcessing";
import { GAME_MODES, isVictoryWave, formatObjective, type GameMode } from "./GameModes";
import { MissionSystem } from "./systems/MissionSystem";
import { LODSystem } from "./systems/LODSystem";
import { PickupSystem } from "./systems/PickupSystem";
import { RagdollSystem } from "./systems/RagdollSystem";
import { ProjectileSystem } from "./systems/ProjectileSystem";
import { ImpulsePhysicsBackend } from "./physics/PhysicsBackend";
// Task 3 / item 54 — engine internals split into per-concern sub-modules.
// loop.ts owns the fixed-step constants + the structural interface the loop
// touches; lifecycle.ts re-exports acquireWakeLock (acquired in start(),
// released in dispose()); input.ts documents the input handshake helpers.
// The class itself stays monolithic here — TS doesn't support partial
// classes, and extracting method bodies to standalone functions would
// require widening ~10 `private` fields to `public`, a larger public API
// change than this task warrants. The sub-modules exist as the documented
// extraction point + constants source.
import { FIXED_DT, MAX_ACCUMULATOR, MAX_STEPS_PER_FRAME } from "./engine/loop";
import { acquireWakeLock } from "./engine/lifecycle";
// A2-5000-retry #367-371 — wire AI director / squad-coordinator / companion /
// boss-patterns into the engine loop. The four modules were fully implemented
// by Section D (prompts 501-540) but never called from the engine — the
// director singleton stayed null (so AudioSystem's getAIDirector() fell back),
// squad-coordinator never ticked (so squads never formed), spawnCompanion was
// never called (so VIP/EXTRACTION had no buddy), tickBossPattern was never
// called (so bosses used the normal enemy FSM, not their multi-phase patterns).
import {
  initAIDirector,
  destroyAIDirector,
  type AIDirector,
  type PerformanceSignal,
} from "./ai/director";
import { getSquadCoordinator, type SquadCoordinator } from "./ai/squad-coordinator";
import { spawnCompanion, type Companion } from "./ai/companion";
import { tickBossPattern } from "./ai/boss-patterns";
import { getDifficultyConfig } from "./Difficulty";

/**
 * GameEngine — thin orchestrator. Owns the GameContext (shared mutable state),
 * owns the systems, forwards the per-frame tick to each system, then renders.
 *
 * Public API (preserved from pre-decomposition):
 *   constructor(container, settings, loadout)
 *   start(), setPaused(p), resume(), setSettings(s), restart(), dispose(),
 *   setLoadout(l), setWeapon(w), useMedicalItem(slug)
 */
export class GameEngine {
  private ctx: GameContext;
  private rafId = 0;
  private systems: GameSystem[];
  /** Wave fix: tracks the pending wave-transition setTimeout so it can be
   *  cancelled on death / restart / dispose. Without this, a stale callback
   *  from a previous match can spawn into the new game. */
  private waveTransitionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wave fix: monotonically increasing token incremented on each start() /
   *  restart() call. setTimeout callbacks capture this token and bail out
   *  if the token has changed (defensive against double-fires). */
  private matchGeneration = 0;

  private renderer: RendererSystem;
  private input: InputSystem;
  private weapon: WeaponSystem;
  private enemies: EnemySystem;
  private particles: ParticleSystem;
  private weather: WeatherSystem;
  private medical: MedicalSystem;
  private audioSys: AudioSystem;
  private hud: HudSystem;
  /** P4.2: stamina & sprint economy. */
  stamina: StaminaSystem;
  /** P4.5: weapon malfunctions & jamming. */
  malfunctions: MalfunctionSystem;
  /** P4.6: melee & takedown. */ melee: MeleeSystem;
  /** Grenade throw system (wind-up + release + physics). */
  grenades: GrenadeSystem;
  /** Prompt 11: finisher animations (cinematic kill sequences). */
  finishers: FinisherSystem;
  /** G1.2/G1.3/G1.4 — mode-specific gameplay (VIP, Extraction, Breach). */
  missions: MissionSystem;
  /** Task-14: part-culling LOD system for humanoid enemies. */
  lod: LODSystem;
  /** V3 — health + ammo pickup system (drops from enemy deaths). */
  pickups: PickupSystem;
  /** Task-22 — ragdoll physics for dead enemies. */
  ragdolls: RagdollSystem;
  /** P2.2: authoritative match lifecycle FSM. */
  matchFSM: MatchFSM;
  /** P3.1: per-subsystem frame budget profiler + auto-degrade. */
  profiler: FrameBudgetProfiler;
  /** Section L — Performance Optimization stack. Null until
   *  initPerformanceStack() resolves (async). Per-frame tick wrapped in
   *  try/catch so failures don't break the engine. */
  private perfStack: PerformanceStack | null = null;
  /** Post-processing pipeline (SSAO + bloom + output). */
  postProc: PostProcessing;
  /** REAL-BALLISTICS — traveling bullet system (gravity/drag/penetration/ricochet). */
  projectiles: ProjectileSystem;
  /** Task-13 — slow-mo state machine. Null when no slow-mo is active.
   *  `phase: "slow"` runs at timeScale 0.2; `phase: "ramp"` lerps back to
   *  1.0 over 0.5s. Set by triggerSlowMotion; updated in the loop with
   *  realDt (not scaled) so the slow-mo lasts 1.5s real time, not 1.5s
   *  game time. */
  private slowMoState: { phase: "slow" | "ramp"; remaining: number } | null = null;

  /** ANIM-POLISH — Fixed-step physics accumulator. Carries the leftover
   *  real-time (scaled by timeScale) that hasn't yet been consumed by a
   *  1/60s physics tick. The main loop drains it in FIXED_DT chunks;
   *  whatever remains (0 ≤ accumulator < FIXED_DT) becomes the `alpha`
   *  passed to systems' optional `interpolate(alpha)` method for render-
   *  pose interpolation between physics ticks.
   *
   *  Reset to 0 on start/restart/dispose so a stale debt from a previous
   *  match (or a tab-backgrounding spike) doesn't cause a catch-up burst. */
  private _accumulator = 0;

  /** A2-5000-retry #367 — AIDirector singleton. Initialized in start() via
   *  initAIDirector(getDifficultyConfig(settings.difficulty)) + exposed on
   *  ctx.ai.director so other systems can read its latest PacingDecision.
   *  Destroyed in dispose() via destroyAIDirector (clears the module-level
   *  singleton so a new match / new engine instance starts fresh). */
  private _director: AIDirector | null = null;

  /** A2-5000-retry #370 — Companion instance (VIP / EXTRACTION modes only).
   *  Spawned in start() after buildVip/buildExtraction via spawnCompanion.
   *  Tick + dispose are owned by the engine. Null in SURVIVAL/HORDE/BREACH. */
  private _companion: Companion | null = null;

  /** A2-5000-retry #368 — Accumulator for the 1-second director tick. The
   *  director's own internal TICK_MS=1000 throttle means it only emits a new
   *  PacingDecision once per second, but we still must push a PerformanceSignal
   *  every frame so the rolling window has fresh data. This accumulator
   *  coalesces the per-frame push into a 1Hz cadence (avoids 60× the rolling-
   *  window prune cost for no benefit — the director's decision only updates
   *  once per second anyway). */
  private _directorSigAccumulator = 0;

  /** Prompt #113 — Screen Wake Lock release fn. `null` until start() acquires
   *  the lock; the no-op returned on unsupported browsers is stored + called
   *  harmlessly in dispose(). */
  private _wakeLockRelease: (() => void) | null = null;

  /** Prompt #114 — Bound visibilitychange handler. Stored so dispose() can
   *  removeEventListener cleanly. Null on SSR (no document) — start() only
   *  attaches it when document exists. */
  private _visibilityHandler: (() => void) | null = null;

  /** Prompt #114 — Tracks whether we paused due to tab-hidden. Used so the
   *  "Click to Engage" overlay (the resume() call from GameCanvas) is shown
   *  when the user comes back, rather than auto-resuming and yanking them
   *  back into the game without consent. */
  private _pausedByVisibility = false;

  /** ENGAGE-FIX: true while the user is in the "Click to Engage" → pointer-lock
   *  flow. Set by resume() (called when the user clicks the engage overlay).
   *  Cleared 500ms after a successful lock. While true, the onPointerLockChange
   *  handler does NOT transition to the "paused" phase on intermediate unlocks
   *  (the unadjustedMovement option can cause a brief lock→unlock→lock cycle). */
  private _engageInProgress = false;

  constructor(
    container: HTMLElement,
    settings: Settings,
    loadout: LoadoutConfig,
    // A3-5000 #541 — pass-through server-authoritative spawn options to
    // createContext. Optional — single-player callers omit it and get the
    // legacy hardcoded spawn defaults.
    contextOpts?: Parameters<typeof createContext>[3],
  ) {
    this.ctx = createContext(container, settings, loadout, contextOpts);
    this.ctx.onVictory = () => this.victory();
    this.ctx.onGameOver = () => this.gameOver();
    this.ctx.onStartWave = (wave: number) => this.enemies.startWave(wave);
    // Prompt A#5 — wire the context-restore handler. context-factory.ts
    // attaches the `webglcontextlost` + `webglcontextrestored` DOM
    // listeners; the restore listener calls ctx.onContextRestored which
    // dispatches to RendererSystem.handleContextRestored() (re-uploads
    // textures + materials, rebuilds render targets, renders one frame
    // immediately so the user doesn't see a black flash).
    this.ctx.onContextRestored = () => {
      try {
        this.renderer.handleContextRestored();
      } catch (err) {
        // Restore threw — re-throw so context-factory's try/catch falls
        // back to a full reload (the user gets a fresh match rather than
        // a frozen screen).
        throw err;
      }
    };
    // Task-13 — initialize the new context fields (context-factory.ts is
    // outside this task's scope, so we set defaults here).
    this.ctx.timeScale = 1.0;
    this.ctx.deployables = [];
    this.ctx.match.buyStationActive = false;
    this.ctx.match.creditsSpentThisMatch = 0;
    this.ctx.match.grenadeInventory = { frag: 0, flash: 0, smoke: 0 };
    this.ctx.match.deployableInventory = { turret: 0, claymore: 0, c4: 0 };
    // A2-5000-retry #367-371 — initialize the AI subsystem slots on ctx.
    // The actual singletons are constructed lazily in start() (director +
    // companion are per-match; squad-coordinator is process-wide via its
    // own getSquadCoordinator() getter). Null here so callers in headless /
    // pre-start contexts can `?.` no-op.
    this.ctx.ai = { director: null, squads: null, companion: null };
    // Task-13 — wire the buy station + slow-mo hooks.
    this.ctx.onWaveCleared = (wave: number) => this.onWaveCleared(wave);
    this.ctx.triggerSlowMotion = (durationMs: number) => this.triggerSlowMotion(durationMs);
    // Task-13 — register the engine-side buy station effect applicator +
    // READY handler so the store can call them via callbacks.
    useGameStore.getState().setBuyStationApplyEffect((slug: string) => this.applyBuyStationPurchase(slug));
    useGameStore.getState().setBuyStationReadyHandler(() => this.readyUp());
    // Wave fix: expose a way for EnemySystem to register / clear the wave-
    // transition setTimeout so the engine can cancel it on death / restart.
    this.ctx.scheduleWaveTransition = (cb: () => void, delayMs: number) => {
      if (this.waveTransitionTimer) clearTimeout(this.waveTransitionTimer);
      const gen = this.matchGeneration;
      this.waveTransitionTimer = setTimeout(() => {
        this.waveTransitionTimer = null;
        // Bail out if the match has been restarted / ended since scheduling.
        if (gen !== this.matchGeneration) return;
        if (this.ctx.match.matchOver) return;
        cb();
      }, delayMs);
    };
    this.ctx.cancelWaveTransition = () => {
      if (this.waveTransitionTimer) { clearTimeout(this.waveTransitionTimer); this.waveTransitionTimer = null; }
    };
    // Camera juice: wire triggerShake to the physics system.
    this.ctx.triggerShake = (intensity: number) => this.physics.triggerShake(intensity);
    this.ctx.onPointerLockChange = (locked: boolean) => {
      useGameStore.getState().setLocked(locked);
      // Task-13 — when the buy station is open, pointer lock is intentionally
      // released (so the player can use the mouse to click shop items). Don't
      // transition to the "paused" phase in that case — the buy station
      // overlay is the active UI, not the pause screen.
      //
      // ENGAGE-FIX: also skip the pause transition during the initial "Click
      // to Engage" flow. The unadjustedMovement pointer-lock option (Prompt
      // #108) can cause a brief lock→unlock→lock cycle: the browser engages
      // the lock, immediately rejects the unadjustedMovement option, exits,
      // then the context-factory's 300ms fallback re-locks with vanilla
      // requestPointerLock(). Without this guard, the intermediate unlock
      // fires setPhase("paused") and the phase gets stuck — the GameCanvas
      // [phase,locked] effect sees phase="paused" and keeps the game paused
      // even after the re-lock succeeds. The _engageInProgress flag is set
      // by resume() and cleared 500ms after a successful lock.
      if (!locked && this.ctx.running && !this.ctx.match.matchOver && !this.ctx.match.buyStationActive && !this._engageInProgress) {
        useGameStore.getState().setPhase("paused");
      }
      if (locked) {
        // Clear the engage-in-progress flag shortly after a successful lock
        // — 500ms is enough for the unadjustedMovement retry cycle to settle.
        if (this._engageInProgress) {
          setTimeout(() => { this._engageInProgress = false; }, 500);
        }
      }
    };

    // Construct systems.
    this.renderer = new RendererSystem(this.ctx);
    this.input = new InputSystem(this.ctx);
    this.physics = new PhysicsSystem(this.ctx);
    this.weapon = new WeaponSystem(this.ctx);
    this.enemies = new EnemySystem(this.ctx);
    this.particles = new ParticleSystem(this.ctx);
    // REAL-BALLISTICS — ProjectileSystem must be constructed after
    // ParticleSystem (it depends on ctx.particlePool for tracer meshes)
    // and before the engine's first tick. It self-registers on
    // ctx.projectileSystem + ctx.projectiles via its constructor.
    this.projectiles = new ProjectileSystem(this.ctx);
    this.ctx.projectileSystem = this.projectiles;
    this.weather = new WeatherSystem(this.ctx);
    this.medical = new MedicalSystem(this.ctx);
    this.suppression = new SuppressionSystem(this.ctx);
    this.audioSys = new AudioSystem(this.ctx);
    this.hud = new HudSystem(this.ctx);
    this.procAnim = new ProceduralAnimSystem(this.ctx);
    this.stamina = new StaminaSystem(this.ctx);
    this.malfunctions = new MalfunctionSystem(this.ctx); this.melee = new MeleeSystem(this.ctx);
    this.grenades = new GrenadeSystem(this.ctx);
    this.finishers = new FinisherSystem(this.ctx);
    this.ctx.finishers = this.finishers;
    this.missions = new MissionSystem(this.ctx);
    // Task-14: LOD system — part-culling for humanoid enemies at distance.
    // Constructed after the enemy system + exposed on the context so any
    // system can call refreshEnemy() after spawning. Updated each frame in
    // the loop (after the enemy system).
    this.lod = new LODSystem(this.ctx);
    this.ctx.lodSystem = this.lod;

    // V3 — Pickup system (health + ammo drops from enemy deaths).
    // Exposed on ctx so EnemySystem.killEnemy can call ctx.pickups?.spawnFromKill(pos).
    this.pickups = new PickupSystem(this.ctx);
    this.ctx.pickups = this.pickups;

    // Task-22 — Ragdoll system (Verlet physics for dead enemies). Constructed
    // after the enemy system + exposed on ctx so EnemySystem.killEnemy can
    // call ctx.ragdolls?.activateRagdoll(). Updated each frame in the loop
    // (after the enemy system, before render) so newly-dead enemies are
    // integrated on the same frame they died.
    this.ragdolls = new RagdollSystem(this.ctx);
    this.ctx.ragdolls = this.ragdolls;

    // P3.1: wrap each system with the frame budget profiler + auto-degrade.
    this.profiler = new FrameBudgetProfiler(this.ctx);
    this.profiler.onDegrade((_from, to) => this.ctx.pushHud({ objective: `Quality auto-degraded to ${to.toUpperCase()} to maintain framerate` }));
    this.systems = this.profiler.wrapAll({
      physics: this.physics, enemies: this.enemies, particles: this.particles,
      suppression: this.suppression, medical: this.medical, weather: this.weather,
      procAnim: this.procAnim, weapon: this.weapon, audio: this.audioSys, hud: this.hud,
      stamina: this.stamina, malfunctions: this.malfunctions, melee: this.melee,
      projectiles: this.projectiles,
    });

    // Section L — Performance Optimization stack init. Async (WebGPU
    // adapter request, worker pool start, GPU buffer allocation). The
    // stack starts null + the per-frame tick no-ops until init resolves.
    // Wrapped in try/catch so a failure doesn't break engine construction.
    try {
      const isMobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      const tier = this.profiler.tier;
      initPerformanceStack({
        renderer: this.ctx.renderer,
        profiler: this.profiler,
        tier,
        isMobile,
      }).then((stack) => {
        this.perfStack = stack;
      }).catch((err) => {
        console.warn("[Engine] Performance stack init failed — running without Section L systems:", err);
      });
    } catch (err) {
      console.warn("[Engine] Performance stack init threw — running without Section L systems:", err);
    }

    // P2.2: construct the match FSM with handlers that delegate to engine methods.
    this.matchFSM = new MatchFSM(this.ctx, {
      onVictory: () => this.victory(), onGameOver: () => this.gameOver(),
      onStartNextWave: () => this.enemies.startWave(this.ctx.match.wave + 1),
      onReset: () => { /* start() handles reset */ },
    });
    this.wireCallbacks();
    // Post-processing pipeline (SSAO + bloom + output).
    this.postProc = new PostProcessing(this.ctx);
    // Task-6: expose the post-proc pipeline on the context so SuppressionSystem
    // can drive the desaturation/vignette suppression visual.
    this.ctx.postProc = this.postProc;
    // Build the world.
    this.renderer.buildSky();
    this.renderer.buildLights();
    // Phase 10: build level from selected map (or fallback to legacy).
    const mapDef = getMap(useGameStore.getState().selectedMap);
    if (mapDef) this.renderer.buildLevelFromMap(mapDef); else this.renderer.buildLevel();
    this.weapon.buildWeapon();
    this.renderer.updateWeatherVisuals();

    // Task-9 (Prompt #33) — Real impulse physics backend for fracture
    // shards. Instantiated AFTER the level is built (so ctx.colliders is
    // populated with all the level's wall/floor/cover colliders) + fed
    // every static collider as a static body so dynamic shard bodies
    // collide with the world geometry. Stepped at the fixed 60 Hz physics
    // tick (in the loop below). Owned by the engine + exposed on ctx so
    // EnemySystem.spawnFractureShards can add dynamic shard bodies.
    try {
      const backend = new ImpulsePhysicsBackend();
      // init() is async but resolves immediately (no real async work). The
      // .then() registers colliders once init resolves; .catch() ensures a
      // rejection doesn't become an unhandled floating promise.
      backend.init().then(() => {
        // Register every existing level collider as a static body. New
        // dynamic shard bodies added later will collide with these.
        for (const c of this.ctx.colliders) {
          backend.addStaticCollider({
            min: c.box.min.clone(),
            max: c.box.max.clone(),
          });
        }
      }).catch((err) => {
        console.warn("[Engine] ImpulsePhysicsBackend collider registration failed:", err);
      });
      this.ctx.physicsBackend = backend;
    } catch (err) {
      console.warn("[Engine] ImpulsePhysicsBackend init failed — fracture shards will not simulate:", err);
    }
  }
  private physics: PhysicsSystem;
  private suppression: SuppressionSystem;
  private procAnim: ProceduralAnimSystem;
  /** Wire system-to-system callbacks (delegated to engine-wiring.ts). */
  private wireCallbacks() { wireEngineCallbacks(this); }
  // ---------- Match lifecycle ----------
  private victory() {
    const { ctx } = this;
    ctx.match.matchOver = true;
    // Wave fix: cancel any pending wave transition — match is over.
    if (this.waveTransitionTimer) { clearTimeout(this.waveTransitionTimer); this.waveTransitionTimer = null; }
    // Task-13 — buy station + slow-mo cleanup: ensure the overlay is closed
    // (defensive — it should already be closed by the time victory fires)
    // and the time scale is restored to normal.
    if (ctx.match.buyStationActive) {
      ctx.match.buyStationActive = false;
      useGameStore.getState().setBuyStationOpen(false);
    }
    this.slowMoState = null;
    ctx.timeScale = 1.0;
    if (ctx.postProc) {
      ctx.postProc.setSaturation(0.95);
      ctx.postProc.setVignette(0.22);
    }
    // Wave fix: set FSM state directly (no onEnter → no recursion). The
    // previous flow was: killEnemy → ctx.onVictory → engine.victory →
    // matchFSM.waveCleared → ctx.onVictory → engine.victory → …
    this.matchFSM.markVictory();
    if (document.pointerLockElement) document.exitPointerLock();
    this.reportEarnings("VICTORY");
    useGameStore.getState().setPhase("victory");
  }

  private gameOver() {
    const { ctx } = this;
    ctx.match.matchOver = true;
    ctx.match.deaths++;
    // V5.4 — killstreak resets on death.
    ctx.match.killstreak = 0;
    ctx.match.reconReady = false;
    ctx.match.airstrikeReady = false;
    // Wave fix: cancel any pending wave transition — match is over.
    if (this.waveTransitionTimer) { clearTimeout(this.waveTransitionTimer); this.waveTransitionTimer = null; }
    // Task-13 — buy station + slow-mo cleanup on death.
    if (ctx.match.buyStationActive) {
      ctx.match.buyStationActive = false;
      useGameStore.getState().setBuyStationOpen(false);
    }
    this.slowMoState = null;
    ctx.timeScale = 1.0;
    if (ctx.postProc) {
      ctx.postProc.setSaturation(0.95);
      ctx.postProc.setVignette(0.22);
    }
    // Wave fix: set FSM state directly (no onEnter → no recursion).
    this.matchFSM.markDefeat();
    if (document.pointerLockElement) document.exitPointerLock();
    this.reportEarnings("DEFEAT");
    useGameStore.getState().setPhase("dead");
    ctx.pushHud({ deaths: ctx.match.deaths });
  }

  private reportEarnings(result: "VICTORY" | "DEFEAT") {
    const { ctx } = this;
    // Task-13 — subtract buy-station spend from the credits sent to the
    // server so server-side player.credits stays in sync with the local
    // profile (which was deducted during purchases). Clamped to ≥ 0 so a
    // spend-heavy match doesn't send negative credits to the server.
    //
    // Read the live buy-station spend from the store (not the stale
    // ctx.match.creditsSpentThisMatch field, which was never wired from the
    // store). Without this, buy-station purchases would be "free" — the
    // server would credit the full gross back at match end.
    const creditsSpent = useGameStore.getState().buyStationCreditsSpent
      ?? ctx.match.creditsSpentThisMatch
      ?? 0;
    const gross = ctx.match.score + (result === "VICTORY" ? 500 : 0);
    const credits = Math.max(0, gross - creditsSpent);
    const xp = ctx.match.kills * 50 + ctx.match.wave * 100 + (result === "VICTORY" ? 300 : 0);
    // HUD shows the credits earned THIS match (not the player's balance).
    ctx.pushHud({ credits, xpGained: xp });
    // G4.1 — pass headshots + meleeKills so the challenge system can track them.
    //
    // Fire + handle the response so we can refresh the local profile
    // immediately on the victory/defeat screen. A swallowed 404 here was the
    // root cause of the "credits don't go up" bug — the endpoint didn't exist
    // and the .catch(()=>{}) hid the failure. Now we both create the endpoint
    // and propagate the new balance into the store on success.
    fetch("/api/player/earn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credits, xp, kills: ctx.match.kills, wave: ctx.match.wave, result,
        headshots: ctx.match.headshots, melee: ctx.match.meleeKills,
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { player?: { credits: number; xp: number; level: number }; battlePassXp?: number } | null) => {
        if (!data?.player) return;
        // Update the local profile so the victory/defeat screen shows the
        // new credits + level immediately, without a /api/player round-trip.
        useGameStore.getState().setProfile({
          credits: data.player.credits,
          xp: data.player.xp,
          level: data.player.level,
          battlePassXp: data.battlePassXp ?? useGameStore.getState().profile.battlePassXp,
        });
      })
      .catch((err) => {
        console.error("[reportEarnings] /api/player/earn failed", err);
      });
  }

  private static RADIO_MACROS: Record<string, { text: string; channel: string }> = {
    contact: { text: "Contact reported — check bearing", channel: "SQUAD" },
    need_medic: { text: "Need medic!", channel: "SQUAD" },
    need_ammo: { text: "Need ammunition resupply", channel: "SQUAD" },
  };

  private sendRadioMacro(type: string) {
    const m = GameEngine.RADIO_MACROS[type];
    if (m) useGameStore.getState().setHud({ radioMessage: { ...m, time: performance.now() } });
  }

  private toggleViewMode() {
    const { ctx } = this;
    ctx.player.viewMode = ctx.player.viewMode === "first" ? "third" : "first";
    if (ctx.avatar) ctx.avatar.group.visible = ctx.player.viewMode === "third";
    ctx.pushHud({ viewMode: ctx.player.viewMode });
  }

  // ---------- Task-13: Buy Station + slow-mo final kill ----------

  /** Task-13 — Called by EnemySystem.killEnemy when a non-victory wave is
   *  cleared. Opens the buy station overlay (the 15s wave-transition timer
   *  is already scheduled by EnemySystem) + pushes a HUD objective + exits
   *  pointer lock so the player can use the mouse to click shop items. */
  private onWaveCleared(wave: number) {
    const { ctx } = this;
    useGameStore.getState().setBuyStationOpen(true);
    ctx.pushHud({
      objective: `WAVE ${wave} CLEARED — BUY STATION OPEN. Click READY to deploy (15s).`,
    });
    // Release pointer lock so the player can mouse-over + click shop items.
    // The engine's onPointerLockChange handler skips the "paused" transition
    // while buyStationActive is true, so the game stays in the "playing"
    // phase with the buy station overlay as the active UI.
    if (document.pointerLockElement) ctx.exitPointerLock();
  }

  /** Task-13 — Trigger cinematic slow-motion. Called by EnemySystem.killEnemy
   *  on the final-wave final-kill. Sets timeScale=0.2, applies post-proc
   *  desaturation/vignette, and after 1.5s + 0.5s ramp calls victory().
   *  Real-time duration is 2.0s (the slow-mo state tracks real time, not
   *  scaled game time, so the effect lasts 2s on the wall clock). */
  private triggerSlowMotion(durationMs: number) {
    const { ctx } = this;
    // Defensive: if the match is already over (e.g. player died same frame),
    // skip the slow-mo and call victory directly.
    if (ctx.match.matchOver) { this.victory(); return; }
    this.slowMoState = { phase: "slow", remaining: durationMs / 1000 };
    ctx.timeScale = 0.2;
    // Cinematic post-proc: heavy desaturation + vignette boost.
    if (ctx.postProc) {
      ctx.postProc.setSaturation(0.4);
      ctx.postProc.setVignette(0.6);
    }
  }

  /** Task-13 — Per-frame slow-mo state update. Uses REAL dt (not scaled)
   *  so the slow-mo lasts 1.5s on the wall clock. After the slow phase,
   *  ramps timeScale back to 1.0 over 0.5s, restores post-proc, and
   *  calls victory() once. Bails out (no victory call) if the match
   *  ended via gameOver() during the slow-mo. */
  private updateSlowMo(realDt: number) {
    if (!this.slowMoState) return;
    const { ctx } = this;
    // If the match ended during slow-mo (gameOver fired), abort + restore.
    if (ctx.match.matchOver) {
      this.slowMoState = null;
      ctx.timeScale = 1.0;
      if (ctx.postProc) { ctx.postProc.setSaturation(0.95); ctx.postProc.setVignette(0.22); }
      return;
    }
    this.slowMoState.remaining -= realDt;
    if (this.slowMoState.remaining <= 0) {
      if (this.slowMoState.phase === "slow") {
        // Transition to the 0.5s ramp phase.
        this.slowMoState = { phase: "ramp", remaining: 0.5 };
      } else {
        // Ramp complete: restore time scale + post-proc, fire victory.
        this.slowMoState = null;
        ctx.timeScale = 1.0;
        if (ctx.postProc) { ctx.postProc.setSaturation(0.95); ctx.postProc.setVignette(0.22); }
        this.victory();
        return;
      }
    }
    // During the ramp phase, lerp timeScale from 0.2 → 1.0.
    if (this.slowMoState.phase === "ramp") {
      const t = 1 - Math.max(0, this.slowMoState.remaining / 0.5);
      ctx.timeScale = 0.2 + (1.0 - 0.2) * t;
    }
  }

  /** Task-13 — Apply a buy station purchase. Registered as the store's
   *  buyStationApplyEffect callback; called after credits are validated.
   *  Returns true if the effect was applied (the purchase is committed);
   *  false aborts the purchase with no deduction. */
  private applyBuyStationPurchase = (slug: string): boolean => {
    const { ctx } = this;
    const inv = ctx.match.grenadeInventory ?? (ctx.match.grenadeInventory = { frag: 0, flash: 0, smoke: 0 });
    const depInv = ctx.match.deployableInventory ?? (ctx.match.deployableInventory = { turret: 0, claymore: 0, c4: 0 });
    switch (slug) {
      case "armor_plate":
        ctx.player.armor = 100;
        ctx.pushHud({ armor: 100 });
        return true;
      case "ammo_box":
        ctx.weapon.reserveAmmo = ctx.weapon.stats.effectiveMagSize * 3;
        ctx.pushHud({ reserveAmmo: ctx.weapon.reserveAmmo });
        return true;
      case "medkit":
        ctx.player.health = 100;
        ctx.pushHud({ health: 100, maxHealth: 100 });
        return true;
      case "frag_grenade": {
        if (inv.frag >= 4) return false;
        inv.frag = Math.min(4, inv.frag + 2);
        // Also bump the GrenadeSystem's grenadesLeft so the player can
        // actually throw them with G. The field is private; cast to access.
        const gs = this.grenades as unknown as { grenadesLeft: number };
        gs.grenadesLeft = Math.min(4, gs.grenadesLeft + 2);
        return true;
      }
      case "flashbang":
        if (inv.flash >= 4) return false;
        inv.flash = Math.min(4, inv.flash + 2);
        return true;
      case "smoke_grenade":
        if (inv.smoke >= 4) return false;
        inv.smoke = Math.min(4, inv.smoke + 2);
        return true;
      case "auto_turret":
        depInv.turret += 1;
        this.deployTurret();
        return true;
      case "claymore":
        depInv.claymore += 1;
        this.deployExplosive("claymore");
        return true;
      case "c4":
        depInv.c4 += 1;
        this.deployExplosive("c4");
        return true;
      default:
        return false;
    }
  };

  /** Task-13 — "READY" handler. Closes the buy station overlay, cancels the
   *  15s wave-transition timer, and immediately starts the next wave. Mirrors
   *  the scheduleWaveTransition callback in EnemySystem.killEnemy. */
  private readyUp = () => {
    const { ctx } = this;
    if (!ctx.match.buyStationActive) return;
    ctx.match.buyStationActive = false;
    useGameStore.getState().setBuyStationOpen(false);
    ctx.cancelWaveTransition();
    // Trigger the wave transition immediately (same as the 15s timer cb).
    const nextWave = ctx.match.wave + 1;
    for (const en of ctx.enemies) ctx.scene.remove(en.group);
    ctx.enemies = [];
    ctx.onStartWave(nextWave);
    ctx.match.waveTransitioning = false;
  };

  /** Task-13 — Deploy an auto-turret at the player's position. The turret
   *  is a simple box base + barrel mesh; it auto-fires at the nearest enemy
   *  within 25m every 400ms for 30s, then despawns. */
  private deployTurret() {
    const { ctx } = this;
    if (!ctx.deployables) ctx.deployables = [];
    const group = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.6, metalness: 0.4 }),
    );
    base.position.y = 0.25;
    base.castShadow = true;
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.5, metalness: 0.7 }),
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.45, 0.3);
    barrel.castShadow = true;
    group.add(base, barrel);
    // Place 1.5m in front of the player (along their facing direction).
    const forward = new THREE.Vector3(-Math.sin(ctx.player.yaw), 0, -Math.cos(ctx.player.yaw));
    group.position.copy(ctx.player.pos).addScaledVector(forward, 1.5);
    group.position.y = 0;
    ctx.scene.add(group);
    ctx.deployables.push({
      kind: "turret", mesh: group, pos: group.position.clone(),
      armed: true, armTimer: 0, life: 30, lastFire: 0, exploded: false,
    });
    ctx.pushHud({ objective: "AUTO-TURRET DEPLOYED — 30s active" });
  }

  /** Task-13 — Deploy a claymore or C4 at the player's position. Has a 1s
   *  arm delay, then detonates when an enemy comes within range (3m for
   *  claymores, 5m for C4 — C4 is treated as a stronger proximity charge
   *  since InputSystem is outside this task's scope and we can't add a
   *  dedicated detonate key). */
  private deployExplosive(kind: "claymore" | "c4") {
    const { ctx } = this;
    if (!ctx.deployables) ctx.deployables = [];
    const color = kind === "claymore" ? 0x4a3a2a : 0x4a2a2a;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.15, 0.2),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.3 }),
    );
    mesh.castShadow = true;
    const forward = new THREE.Vector3(-Math.sin(ctx.player.yaw), 0, -Math.cos(ctx.player.yaw));
    mesh.position.copy(ctx.player.pos).addScaledVector(forward, 1.0);
    mesh.position.y = 0.1;
    ctx.scene.add(mesh);
    ctx.deployables.push({
      kind, mesh, pos: mesh.position.clone(),
      armed: false, armTimer: 1.0, life: -1, lastFire: 0, exploded: false,
    });
  }

  /** Task-13 — Per-frame deployable update. Turrets auto-fire at nearby
   *  enemies + tick down their 30s lifetime; claymores/C4 arm after 1s and
   *  detonate on proximity. Uses real dt for timers (lifetime + arm delay)
   *  and real dt for turret fire cadence (which is timestamp-based). */
  private updateDeployables(realDt: number) {
    const { ctx } = this;
    const deps = ctx.deployables;
    if (!deps || deps.length === 0) return;
    for (let i = deps.length - 1; i >= 0; i--) {
      const d = deps[i];
      // Arm timer (claymores/C4).
      if (!d.armed && d.armTimer > 0) {
        d.armTimer -= realDt;
        if (d.armTimer <= 0) d.armed = true;
      }
      if (d.kind === "turret") {
        d.life -= realDt;
        if (d.life <= 0) {
          ctx.scene.remove(d.mesh);
          deps.splice(i, 1);
          continue;
        }
        // Auto-fire at the nearest enemy within 25m every 400ms.
        const now = performance.now();
        if (now - d.lastFire > 400) {
          let nearest: Enemy | null = null;
          let nearestDist = 25;
          for (const e of ctx.enemies) {
            if (!e.alive) continue;
            const dist = e.group.position.distanceTo(d.pos);
            if (dist < nearestDist) { nearestDist = dist; nearest = e; }
          }
          if (nearest) {
            d.lastFire = now;
            // Damage via the weapon system's onDamageEnemy hook (already
            // wired to enemies.damageEnemy).
            this.weapon.onDamageEnemy?.(nearest, 18, false, nearest.group.position.clone());
            // Tracer from the turret barrel to the target.
            this.enemies.onSpawnTracer?.(
              new THREE.Vector3(d.pos.x, 1.0, d.pos.z),
              nearest.group.position.clone(),
              0xffaa44,
            );
            // Rotate the turret to face the target.
            const dir = nearest.group.position.clone().sub(d.pos);
            d.mesh.rotation.y = Math.atan2(dir.x, dir.z);
            // Turret gunshot sound.
            ctx.audio.distantGunshot(d.pos.x, 1.0, d.pos.z, false, "smg");
          }
        }
      } else if (d.kind === "claymore" || d.kind === "c4") {
        if (!d.armed) continue;
        const radius = d.kind === "claymore" ? 3 : 5;
        let detonated = false;
        for (const e of ctx.enemies) {
          if (!e.alive) continue;
          const dist = e.group.position.distanceTo(d.pos);
          if (dist < radius) { detonated = true; break; }
        }
        if (detonated) {
          this.explodeDeployable(d);
          deps.splice(i, 1);
        }
      }
    }
  }

  /** Task-13 — Detonate a claymore or C4: damage enemies in radius + screen
   *  shake + particle explosion + remove the mesh. */
  private explodeDeployable(d: Deployable) {
    const { ctx } = this;
    d.exploded = true;
    const radius = d.kind === "claymore" ? 4 : 6;
    const baseDmg = d.kind === "claymore" ? 120 : 200;
    for (const e of ctx.enemies) {
      if (!e.alive) continue;
      const dist = e.group.position.distanceTo(d.pos);
      if (dist < radius) {
        const dmg = baseDmg * (1 - dist / radius);
        // damageEnemy handles death + score + wave-clear logic.
        this.enemies.damageEnemy(e, dmg, false, e.group.position.clone());
      }
    }
    // Particle explosion via the existing particle system hook.
    (ctx as unknown as { particles?: { spawnImpact?: (p: THREE.Vector3, n: THREE.Vector3) => void } }).particles?.spawnImpact?.(
      d.pos.clone(),
      new THREE.Vector3(0, 1, 0),
    );
    ctx.triggerShake(d.kind === "c4" ? 0.5 : 0.3);
    ctx.audio.distantGunshot(d.pos.x, d.pos.y, d.pos.z, false, "sniper");
    ctx.scene.remove(d.mesh);
  }

  // ---------- Public API ----------

  start() {
    const { ctx } = this;
    ctx.running = true; ctx.paused = false; ctx.match.matchOver = false;
    ctx.player.health = 100; ctx.player.armor = 100;
    ctx.player.vel.set(0, 0, 0);
    ctx.player.yaw = Math.PI; ctx.player.pitch = 0;
    ctx.weapon.stats = computeWeaponStats(ctx.weapon.loadout);
    ctx.weapon.ammo = ctx.weapon.stats.effectiveMagSize;
    ctx.weapon.reserveAmmo = ctx.weapon.stats.effectiveMagSize * 3;
    ctx.weapon.activeSlot = "primary"; ctx.weapon.activeSlotIndex = 0; ctx.weapon.primaryWeapon = ctx.weapon.loadout.weapon;
    // Prompt #44 — fresh match = cold barrel. (setLoadout also resets this on
    // weapon switch, but the engine's start() path may bypass setLoadout when
    // reusing the existing loadout — belt-and-suspenders reset here.)
    ctx.weapon.barrelHeat = 0;
    ctx.suppression.value = 0; ctx.stamina.value = ctx.stamina.max; ctx.stamina.exhausted = false; ctx.stamina.regenResumesAt = 0;
    ctx.weaponMalfunction.current = null; ctx.weaponMalfunction.condition = 1; ctx.medical.casualtyState = "ACTIVE"; ctx.medical.bleedRate = 0; ctx.medical.fractureLimb = "";
    ctx.medical.channel = null; ctx.medical.inventory = { bandage: 3, splint: 1, epi: 1, medkit: 1 };
    ctx.weatherTime = 0;
    ctx.weather = { timeOfDay: 9, cloudCover: 0.3, precipitation: 0, windSpeed: 3, windDirection: 0.5, fogDensity: 0.012, wetness: 0 };
    // Wave fix: reset match counters and clear any leftover wave-transition timer
    // so a stale callback from a previous match can't spawn into the new game.
    this.matchGeneration++;          // invalidate any pending setTimeouts
    ctx.match.wave = 0;          // startWave(1) will set this to 1
    ctx.match.enemiesPerWave = 0;
    ctx.match.totalEnemiesThisWave = 0;
    ctx.match.enemiesRemaining = 0;
    ctx.match.waveTransitioning = false;
    // V5.4 — reset killstreak + rewards on match start.
    ctx.match.killstreak = 0;
    ctx.match.killstreakBest = 0;
    ctx.match.reconReady = false;
    ctx.match.airstrikeReady = false;
    ctx.match.reconActiveUntil = 0;
    // G1.1 — read the selected game mode from the store + apply its config.
    const mode = (useGameStore.getState().selectedMode as GameMode) || "SURVIVAL";
    const modeCfg = GAME_MODES[mode] ?? GAME_MODES.SURVIVAL;
    ctx.match.mode = mode;
    ctx.match.maxWaves = modeCfg.maxWaves;
    ctx.match.extractionCarrying = false;
    ctx.match.breachRoomIndex = -1;
    // G1.5 — HORDE/EXTRACTION get a concurrent-enemy cap so the renderer
    // never holds more enemies at once than it can handle. Score/wave still
    // climbs forever; only concurrent count is bounded.
    ctx.match.concurrentEnemyCap = (mode === "HORDE") ? 12 : (mode === "EXTRACTION") ? 10 : 99;
    // G4.1 — reset headshot/melee counters for challenge tracking.
    ctx.match.headshots = 0;
    ctx.match.meleeKills = 0;
    // Task-6: reset multi-kill tracker.
    ctx.match.recentKills = [];
    // Task-13 — reset buy station + deployable + slow-mo state for the new match.
    ctx.match.buyStationActive = false;
    ctx.match.creditsSpentThisMatch = 0;
    ctx.match.grenadeInventory = { frag: 0, flash: 0, smoke: 0 };
    ctx.match.deployableInventory = { turret: 0, claymore: 0, c4: 0 };
    ctx.timeScale = 1.0;
    this.slowMoState = null;
    // Clear any leftover deployables from the previous match.
    if (ctx.deployables) {
      for (const d of ctx.deployables) ctx.scene.remove(d.mesh);
      ctx.deployables = [];
    }
    useGameStore.getState().setBuyStationOpen(false);
    useGameStore.getState().setBuyStationApplyEffect((slug: string) => this.applyBuyStationPurchase(slug));
    useGameStore.getState().setBuyStationReadyHandler(() => this.readyUp());
    if (this.waveTransitionTimer) { clearTimeout(this.waveTransitionTimer); this.waveTransitionTimer = null; }
    // Phase 10: rebuild level from selected map on each match start.
    const mapDef = getMap(useGameStore.getState().selectedMap);
    if (mapDef) {
      this.renderer.buildLevelFromMap(mapDef);
      // V2 — face the map center (0,0,0) from the spawn point so the player
      // immediately sees the buildings/cover instead of the empty perimeter wall.
      // forward = (-sin(yaw), 0, -cos(yaw)); we want forward = normalize(center - spawn).
      const sp = mapDef.playerSpawn;
      const dx = 0 - sp[0], dz = 0 - sp[2];
      ctx.player.yaw = Math.atan2(-dx, -dz);
    } else {
      ctx.player.pos.set(0, 1.7, 18);
    }
    fetch("/api/ballistics/materials").then(r => r.json()).then(d => { if (d.materials) ctx.materials = d.materials as BallisticsMaterial[]; }).catch(() => {});
    fetch("/api/medical/items").then(r => r.json()).then(d => {
      if (d.inventory) ctx.medical.inventory = { bandage: d.inventory.bandage ?? 3, splint: d.inventory.splint ?? 1, epi: d.inventory.epi ?? 1, medkit: d.inventory.medkit ?? 1 };
    }).catch(() => {});
    this.enemies.clearEnemies();
    // V3 — clear any leftover pickups from the previous match.
    this.pickups?.clearPickups();
    // Task-22 — clear any leftover ragdolls from the previous match.
    this.ragdolls?.clear();
    // G1.2/G1.3 — clean up any mode-specific entities from the previous match.
    if (ctx.vip) { ctx.scene.remove(ctx.vip.group); ctx.vip = null; }
    if (ctx.extractionObjective) { ctx.scene.remove(ctx.extractionObjective.mesh); ctx.extractionObjective = null; }
    if (ctx.extractionZone) { ctx.scene.remove(ctx.extractionZone.mesh); ctx.extractionZone = null; }
    ctx.clock.start();
    // ANIM-POLISH — reset the fixed-step accumulator so a stale debt from
    // a previous match (or a tab-backgrounding spike during the load screen)
    // doesn't cause a catch-up burst on the first frame of the new match.
    this._accumulator = 0;
    // Wave fix: do NOT call matchFSM.startMatch() — its DEPLOYING→IN_PROGRESS
    // onEnter handler triggers onStartNextWave which would spawn a wave
    // (ctx.match.wave + 1) before we set ctx.match.wave = 1, then startWave(1)
    // spawns again → 12 enemies instead of 5. Drive the FSM directly to
    // IN_PROGRESS without firing onStartNextWave, then explicitly startWave(1).
    this.matchFSM.skipToInProgress();
    this.loop();
    this.enemies.startWave(1);
    // G1.2/G1.3/G1.4 — build mode-specific entities after the level + first wave.
    if (mode === "VIP") this.missions.buildVip();
    if (mode === "EXTRACTION") this.missions.buildExtraction();
    if (mode === "BREACH") this.missions.buildBreach();
    // A2-5000-retry #367/#368 — initialize the AI director singleton on
    // match start with the current difficulty config as the baseline. The
    // director's rolling-window pacing analysis (CALM / BUILDING / PEAK /
    // BREATH) reads the player's per-frame PerformanceSignal (health,
    // armor, ammo, killstreak, deaths, etc.) and emits a PacingDecision
    // (spawnRateMult / aggressionMult) once per second. Other systems
    // read `ctx.ai.director.getDecision()` to apply the multiplier;
    // AudioSystem reads `getAIDirector()` for adaptive music crossfade.
    // Without this init call, the singleton stayed null + every consumer
    // silently fell back (AudioSystem never crossfaded, AI never scaled).
    try {
      this._director = initAIDirector(
        getDifficultyConfig(useGameStore.getState().settings.difficulty),
      );
      this.ctx.ai!.director = this._director;
      this._directorSigAccumulator = 0;
    } catch (err) {
      console.warn("[Engine] AIDirector init failed — pacing analysis disabled:", err);
      this._director = null;
      this.ctx.ai!.director = null;
      this._directorSigAccumulator = 0;
    }
    // A2-5000-retry #369 — SquadCoordinator is a process-wide singleton
    // (getSquadCoordinator() lazily constructs on first call). Expose it on
    // ctx.ai.squads so other systems can read squad state + the engine can
    // tick it per-frame. The coordinator's own register/unregister of
    // individual enemies belongs to EnemySystem (startWave + killEnemy
    // hooks), but the per-frame tick is the engine's integration point.
    try {
      this.ctx.ai!.squads = getSquadCoordinator();
    } catch (err) {
      console.warn("[Engine] SquadCoordinator acquisition failed — squad coordination disabled:", err);
      this.ctx.ai!.squads = null;
    }
    // A2-5000-retry #370 — Spawn a companion in VIP + EXTRACTION modes
    // (the buddy who revives the player, shares ammo, draws fire). The
    // companion spawns at the player's position + is ticked per-frame in
    // the loop. Disposed on match end / restart. Null in SURVIVAL/HORDE/
    // BREACH (those modes have no companion support).
    if (mode === "VIP" || mode === "EXTRACTION") {
      try {
        const spawnPos = ctx.player.pos.clone().add(new THREE.Vector3(2, 0, 0));
        this._companion = spawnCompanion(ctx, spawnPos);
        this.ctx.ai!.companion = this._companion;
      } catch (err) {
        console.warn("[Engine] Companion spawn failed — VIP/EXTRACTION will not have a buddy:", err);
        this._companion = null;
        this.ctx.ai!.companion = null;
      }
    } else {
      this._companion = null;
      this.ctx.ai!.companion = null;
    }
    this.hud.syncHud();
    this.renderer.updateWeatherVisuals();
    // SEC8 prompt 70 — start the adaptive music engine on match start. The
    // AudioSystem drives stem crossfades each frame from the AI director's
    // intensity label (CALM / BUILDING / PEAK / BREATH). Caches the latest
    // intensity until the engine is started, so the first frame applies the
    // current CALM pad.
    try { ctx.audio.startMusic(); } catch { /* SSR / autoplay-blocked — no-op */ }
    useGameStore.getState().setLocked(false);

    // Prompt #113 — Screen Wake Lock: prevent the display from sleeping while
    // the player is in a match. acquireWakeLock() is async + feature-detected;
    // on unsupported browsers it resolves to a no-op release fn. The browser
    // auto-releases the lock when the tab is backgrounded — we re-acquire it
    // in the visibilitychange handler below when the tab comes back.
    if (typeof navigator !== "undefined") {
      // Release any previous lock first (start() may be called via restart()
      // on a hot reload without dispose()).
      this._wakeLockRelease?.();
      this._wakeLockRelease = null;
      void acquireWakeLock().then((release) => {
        // Only store if we're still running (dispose() may have fired).
        if (this.ctx.running) this._wakeLockRelease = release;
        else release();
      });
    }

    // Prompt #114 — Page Visibility API pause. When the tab is hidden the
    // browser already throttles RAF to ~1 fps, but we also explicitly pause
    // the game loop (so systems don't fire half-rate physics steps that would
    // let enemies teleport-kill the player) + suspend the AudioContext (so
    // distant gunshots don't keep rendering in the background). On return we
    // resume the AudioContext but DO NOT auto-unpause — the player must click
    // to re-engage pointer lock (handled by GameCanvas's resume() flow), so
    // they don't get yanked back into a firefight without consent.
    if (typeof document !== "undefined" && !this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.hidden) {
          // Going hidden: pause + suspend audio. Skip if the match is already
          // over (victory/defeat screen is already showing — no gameplay to pause).
          if (this.ctx.running && !this.ctx.match.matchOver && !this.ctx.paused) {
            this.ctx.paused = true;
            this._pausedByVisibility = true;
            // Surface a HUD note so the player sees why (if they alt-tab back
            // mid-pause the "Click to Engage" overlay is the primary cue).
            this.ctx.pushHud({ objective: "PAUSED — tab returned to background" });
          }
          try { this.ctx.audio.suspend(); } catch { /* no AudioContext — ignore */ }
          // The browser auto-releases the wake lock when the tab hides; we
          // forget our handle so the visibility handler's "show" branch can
          // re-acquire a fresh one below.
          this._wakeLockRelease?.();
          this._wakeLockRelease = null;
        } else {
          // Coming back into focus: resume audio (so the click that re-engages
          // pointer lock has working sound), but leave `paused` true so the
          // "Click to Engage" overlay stays up — the player clicks to re-lock
          // which calls resume() → requestPointerLock → unpause via the
          // existing GameCanvas [phase,locked] effect.
          try { this.ctx.audio.resume(); } catch { /* ignore */ }
          // Re-acquire the wake lock (browser auto-released it on hide).
          if (typeof navigator !== "undefined" && !this._wakeLockRelease) {
            void acquireWakeLock().then((release) => {
              if (this.ctx.running) this._wakeLockRelease = release;
              else release();
            });
          }
        }
      };
      document.addEventListener("visibilitychange", this._visibilityHandler);
    }
  }

  setPaused(p: boolean) {
    this.ctx.paused = p;
    // Prompt #114 — clearing the pause (via the GameCanvas "click to engage"
    // flow) also clears the visibility-pause tracking flag, so the next
    // visibilitychange-hidden event can re-trigger a fresh auto-pause.
    if (!p) this._pausedByVisibility = false;
  }
  /** Resume from pause — request pointer lock; the GameCanvas [phase,locked]
   *  effect unpauses the engine once lock is actually acquired. This prevents
   *  the "Click to Engage" overlay from staying visible while the game runs
   *  underneath when pointer-lock is in its ~1.3s cooldown.
   *
   *  ENGAGE-FIX: sets _engageInProgress so the onPointerLockChange handler
   *  doesn't transition to "paused" phase during the unadjustedMovement
   *  lock→unlock→lock retry cycle. */
  resume() {
    this._engageInProgress = true;
    this.ctx.requestPointerLock();
  }

  /** DEBUG-ONLY: expose kill-all-enemies + wave info on window so the
   *  wave-transition fix can be verified from the browser console without
   *  needing pointer lock + aiming. Stripped from production builds by
   *  Next.js tree-shaking if `__PR_DEBUG` is never referenced elsewhere.
   *  Wired in GameCanvas after engine creation. */
  attachDebugHelpers() {
    if (typeof window === "undefined") return;
    const dbg = {
      killAllEnemies: () => {
        const enemies = [...this.ctx.enemies];
        for (const e of enemies) {
          if (e.alive) this.enemies.damageEnemy(e, 9999, false, e.group.position.clone());
        }
      },
      // V3 — kill only ONE enemy (for ragdoll testing without clearing the wave).
      killOneEnemy: () => {
        const e = this.ctx.enemies.find((en) => en.alive);
        if (e) this.enemies.damageEnemy(e, 9999, false, e.group.position.clone());
        return e ? "killed one" : "no alive enemy";
      },
      // V3 — ragdoll debug: active count + positions.
      ragdollInfo: () => ({
        active: (this.ctx.ragdolls as unknown as { count?: number })?.count ?? 0,
        positions: (this.ctx.ragdolls as unknown as { ragdollPositions?: () => [number, number, number][] })?.ragdollPositions?.() ?? [],
      }),
      waveInfo: () => ({
        wave: this.ctx.match.wave,
        maxWaves: this.ctx.match.maxWaves,
        enemiesRemaining: this.ctx.match.enemiesRemaining,
        enemiesOnScreen: this.ctx.enemies.filter((e) => e.alive).length,
        waveTransitioning: this.ctx.match.waveTransitioning,
        matchOver: this.ctx.match.matchOver,
      }),
      // DEBUG: inspect enemy FSM states + distances for AI debugging.
      enemyStates: () => this.ctx.enemies.filter((e) => e.alive).map((e, i) => ({
        idx: i,
        fsm: e.fsm?.state ?? "none",
        legacy: e.state,
        dist: Math.hypot(e.group.position.x - this.ctx.player.pos.x, e.group.position.z - this.ctx.player.pos.z).toFixed(1),
        pos: [Math.round(e.group.position.x), Math.round(e.group.position.z)],
        lastShot: e.lastShot > 0 ? Math.round((performance.now() - e.lastShot) / 1000) + "s ago" : "never",
      })),
      // Realism: simulate damage from a random direction to test the
      // directional damage indicator without needing enemies to hit you.
      damageFromDirection: (worldYaw: number, dmg = 15) => {
        const dist = 8;
        const src = {
          x: this.ctx.player.pos.x + Math.sin(worldYaw) * dist,
          y: 1.2,
          z: this.ctx.player.pos.z + Math.cos(worldYaw) * dist,
          clone() { return { x: src.x, y: src.y, z: src.z } as unknown as import("three").Vector3; },
        } as unknown as import("three").Vector3;
        this.medical.applyDamageToPlayer(dmg, "torso", src);
      },
      // Muzzle-flash fix verification: force-fire the weapon bypassing the
      // pointer-lock check so the new (much smaller) flash can be inspected.
      forceFire: () => {
        const ctx = this.ctx;
        const w = ctx.weapon;
        if (w.ammo <= 0) w.ammo = w.stats.effectiveMagSize;
        w.lastShotTime = 0;
        // Call tryShoot but bypass the pointer-lock check by temporarily
        // pretending we're locked. Side-effect: muzzle flash + light + audio.
        const orig = ctx.isPointerLocked;
        ctx.isPointerLocked = () => true;
        try { this.weapon.tryShoot(); } finally { ctx.isPointerLocked = orig; }
      },
      // V2 — chunk streaming debug: visible/total chunks + camera angular velocity.
      chunkInfo: () => ({
        visible: this.ctx.chunkManager?.visibleCount ?? 0,
        total: this.ctx.chunkManager?.totalCount ?? 0,
        camAngularVel: this.ctx.chunkManager?.camAngularVel ?? 0,
      }),
      // V2 — simulate a camera yaw rotation to test chunk streaming + motion blur.
      // Rotates the player's yaw by `deltaRad` radians. The next frame's
      // ChunkManager.update() will recompute the frustum + toggle chunks, and
      // the motion-blur pass will ramp up based on the angular velocity.
      simulateTurn: (deltaRad: number) => {
        this.ctx.player.yaw += deltaRad;
      },
      // V3 — player position + orientation debug (for WASD direction verification).
      playerInfo: () => ({
        pos: [Math.round(this.ctx.player.pos.x * 10) / 10, Math.round(this.ctx.player.pos.y * 10) / 10, Math.round(this.ctx.player.pos.z * 10) / 10],
        yaw: Math.round(this.ctx.player.yaw * 100) / 100,
        pitch: Math.round(this.ctx.player.pitch * 100) / 100,
        vel: [Math.round(this.ctx.player.vel.x * 100) / 100, 0, Math.round(this.ctx.player.vel.z * 100) / 100],
        onGround: this.ctx.player.onGround,
      }),
      // V3 — simulate a key press (sets keys[code]=true for one frame).
      simKey: (code: string, durationMs = 100) => {
        this.ctx.keys[code] = true;
        setTimeout(() => { this.ctx.keys[code] = false; }, durationMs);
      },
      // V3 — pickup debug: current count + spawn a test pickup at the player.
      pickupInfo: () => ({
        count: this.ctx.pickups?.count ?? 0,
        positions: (this.ctx.pickups as unknown as { pickupPositions?: () => [number, number, number][] })?.pickupPositions?.() ?? [],
      }),
      spawnPickup: (kind: "medkit" | "bandage" | "ammo") => {
        this.ctx.pickups?.spawn(kind, this.ctx.player.pos);
      },
      // V3 — teleport the player to a position (for pickup testing).
      teleport: (x: number, y: number, z: number) => {
        this.ctx.player.pos.set(x, y, z);
        this.ctx.player.vel.set(0, 0, 0);
      },
    };
    (window as unknown as { __PR_DEBUG?: unknown }).__PR_DEBUG = dbg;
    // AAA prompt 7 — expose a profiler snapshot for the dev perf overlay.
    (window as unknown as { __PR_PERF?: unknown }).__PR_PERF = {
      snapshot: () => this.profiler.snapshot(),
      fps: () => this.profiler.fps,
      avgFrameMs: () => this.profiler.avgFrameMs,
      tier: () => this.profiler.tier,
    };
  }

  /** V5 — Debounced shadow-toggle traverse. The original implementation did
   *  a full scene.traverse on every settings.shadows change, which (during
   *  a settings-panel drag of a shadow toggle) could fire dozens of times
   *  per second. Each traverse walks every mesh in the level + every enemy
   *  body part (~70 meshes × N enemies) and forces a shader recompile.
   *
   *  We now coalesce rapid changes into a single traverse on the next frame.
   *  The shader recompile is what actually applies the new shadowMap.enabled
   *  value to compiled programs; batching it eliminates the per-drag stutter.
   */
  private shadowTogglePending = false;
  private scheduleShadowToggle() {
    if (this.shadowTogglePending) return;
    this.shadowTogglePending = true;
    requestAnimationFrame(() => {
      this.shadowTogglePending = false;
      const { ctx } = this;
      ctx.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) (m as THREE.MeshStandardMaterial).needsUpdate = true;
        }
      });
    });
  }

  setSettings(s: Partial<Settings>) {
    const { ctx } = this;
    ctx.settings = { ...ctx.settings, ...s };
    if (s.fov) { ctx.weapon.baseFov = s.fov; if (!ctx.weapon.isAiming) { ctx.camera.fov = s.fov; ctx.camera.updateProjectionMatrix(); } }
    if (s.volume !== undefined) ctx.audio.setVolume(ctx.settings.volume);
    if (s.shadows !== undefined) {
      ctx.renderer.shadowMap.enabled = s.shadows;
      this.scheduleShadowToggle();
    }
  }
  restart() { this.start(); }
  setLoadout(loadout: LoadoutConfig) { this.weapon.setLoadout(loadout); }
  setWeapon(w: WeaponType) { this.weapon.setWeapon(w); }
  useMedicalItem(slug: string) { this.medical.useMedicalItem(slug); }

  dispose() {
    cancelAnimationFrame(this.rafId);
    // ANIM-POLISH — clear the fixed-step accumulator so a re-constructed
    // engine doesn't inherit a stale debt.
    this._accumulator = 0;
    // Prompt #113 — release the Screen Wake Lock so the display can sleep
    // after the player exits the match (otherwise closing the tab via
    // navigation away from the canvas would leave the screen on).
    this._wakeLockRelease?.();
    this._wakeLockRelease = null;
    // Prompt #114 — remove the visibilitychange listener so a re-constructed
    // engine doesn't get double-fire events from two stale handlers.
    if (this._visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }
    this._pausedByVisibility = false;
    // Wave fix: cancel any pending wave transition so it can't fire post-dispose.
    this.matchGeneration++;
    if (this.waveTransitionTimer) { clearTimeout(this.waveTransitionTimer); this.waveTransitionTimer = null; }
    // Task-13 — clean up deployables + unregister buy station callbacks so
    // a stale engine ref isn't held by the (possibly reused) store.
    if (this.ctx.deployables) {
      for (const d of this.ctx.deployables) this.ctx.scene.remove(d.mesh);
      this.ctx.deployables = [];
    }
    this.slowMoState = null;
    this.ctx.timeScale = 1.0;
    useGameStore.getState().setBuyStationApplyEffect(undefined);
    useGameStore.getState().setBuyStationReadyHandler(undefined);
    useGameStore.getState().setBuyStationOpen(false);
    this.input.dispose();
    this.audioSys.dispose();
    this.particles.dispose?.();
    // REAL-BALLISTICS — release any in-flight projectiles + their tracer meshes.
    this.projectiles?.dispose?.();
    this.grenades?.dispose();
    this.pickups?.dispose();
    this.ragdolls?.dispose();
    this.postProc?.dispose();
    // Task-9 — release the impulse physics backend (frees its body Maps +
    // AABB arrays). Defensive: dispose may run before init's .then() fires
    // if the engine is torn down quickly — dispose() is a no-op in that case.
    this.ctx.physicsBackend?.dispose();
    // A2-5000-retry #367 — destroy the AIDirector singleton so the next
    // match / new engine instance starts fresh (the singleton is module-
    // scoped in director.ts; without destroy, a stale director with the
    // previous match's rolling window would persist into the new match).
    try { destroyAIDirector(); } catch { /* no-op */ }
    this._director = null;
    // A2-5000-retry #370 — dispose the companion (removes its mesh from the
    // scene + clears its FSM state). Null in modes without a companion.
    try { this._companion?.dispose(this.ctx); } catch { /* no-op */ }
    this._companion = null;
    if (this.ctx.ai) {
      this.ctx.ai.director = null;
      this.ctx.ai.companion = null;
      // Squads singleton is process-wide — leave it for the next match.
    }
    // Section L — tear down the performance stack (workers, GPU buffers,
    // texture streaming cache, etc.). Wrapped in try/catch so a failure
    // doesn't block the rest of dispose().
    try {
      if (this.perfStack) {
        disposePerformanceStack();
        this.perfStack = null;
      }
    } catch (err) {
      console.warn("[Engine] Performance stack dispose failed:", err);
    }
    this.ctx.renderer.dispose();
    if (this.ctx.renderer.domElement.parentElement === this.ctx.container) this.ctx.container.removeChild(this.ctx.renderer.domElement);
  }

  // ---------- Loop ----------
  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    const t0 = performance.now();
    // Task-13 — track real dt (for slow-mo state + FPS + post-proc) and
    // scaled dt (for system updates — multiplied by ctx.timeScale so the
    // slow-mo final-kill effect actually slows the world down).
    const realDt = Math.min(this.ctx.clock.getDelta(), 0.05);
    this.updateSlowMo(realDt);
    if (!this.ctx.paused && this.ctx.running) {
      // ANIM-POLISH — fixed-step accumulator (60 Hz physics tick).
      //
      // The previous loop passed variable `scaledDt` to every system, which
      // meant physics integration (springs, damp, position integration) was
      // frame-rate-dependent — at 144 Hz the gun would settle faster than
      // at 60 Hz, and frame hitches caused visible position jumps. The
      // fixed-step accumulator decouples physics from render: systems
      // always tick at 1/60s, the accumulator carries the leftover into
      // the next frame, and `alpha` (leftover / FIXED_DT) is passed to
      // systems that implement `interpolate(alpha)` for render-pose
      // interpolation between physics ticks. Systems that don't implement
      // `interpolate` just render with the latest physics pose (existing
      // behavior — still smoother than variable-dt because physics is now
      // deterministic at 60 Hz).
      //
      // Slow-mo: `timeScale` multiplies the real dt BEFORE it enters the
      // accumulator, so a 0.25× slow-mo runs the 60 Hz physics at 15 Hz-
      // equivalent wall time (correct: the world slows down, but each tick
      // is still a clean 1/60s of game time).
      //
      // Spiral-of-death guard: if the tab was backgrounded + realDt would
      // pile up > 0.25s of physics debt, clamp the accumulator to 0.25s
      // (caps at ~15 catch-up steps; the steps<5 cap below also prevents
      // a runaway).
      // Task 3 / item 54 — FIXED_DT / MAX_ACCUMULATOR / MAX_STEPS_PER_FRAME
      // imported from ./engine/loop.
      this._accumulator += realDt * (this.ctx.timeScale ?? 1);
      if (this._accumulator > MAX_ACCUMULATOR) this._accumulator = MAX_ACCUMULATOR;
      let steps = 0;
      while (this._accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        // Run every system + every non-system per-frame updater at the
        // fixed timestep. They all receive FIXED_DT (not scaledDt) so the
        // physics is deterministic at 60 Hz regardless of the render fps.
        for (const sys of this.systems) sys.update(FIXED_DT);
        this.grenades.update(FIXED_DT); // grenade physics + explosions
        this.finishers.update(FIXED_DT); // Prompt 11 — finisher animation sequences
        this.missions.update(FIXED_DT); // G1.2/G1.3/G1.4 — mode-specific gameplay
        // Task-13 — update buy-station deployables (turrets fire, claymores/C4
        // arm + detonate). Uses FIXED_DT so they tick at the same rate as
        // the rest of the world (slow-mo scales the accumulator, not the dt).
        this.updateDeployables(FIXED_DT);
        // Task-14 — LOD: cull enemy detail parts at distance. Runs after the
        // enemy system (so newly-spawned enemies exist) + before render.
        // Throttled internally to one recompute per enemy per 200ms.
        this.ctx.lodSystem?.update(FIXED_DT);
        // Task-22 — ragdoll physics: integrate active ragdolls (Verlet +
        // constraint solve + collide + mesh update). Runs after the enemy
        // system (so newly-dead enemies are activated) + before render.
        // Frozen ragdolls are skipped internally — they cost ~0 CPU.
        this.ctx.ragdolls?.update(FIXED_DT);
        // V2 — chunk streaming: toggle chunk visibility based on camera frustum.
        // Runs after physics (so the camera position is final) + before render.
        this.ctx.chunkManager?.update(FIXED_DT);
        // V3 — pickups: float/rotate/proximity-collect. Runs after physics (so
        // the player position is final) + after enemy system (so new pickups
        // from this frame's kills are updated).
        this.ctx.pickups?.update(FIXED_DT);
        // Task-3 — RendererSystem per-frame update: CSM cascade recentering
        // (or single-light shadow-camera follow in the fallback) + periodic
        // CSM material sweep. Runs at the END of the fixed-step loop so the
        // player position is final (the shadow follow recenters on the
        // player). Previously this was defined but never called — the shadow
        // camera stayed at world origin. Now wired so shadows track the player.
        this.renderer.update(FIXED_DT);
        // Task-9 (Prompt #33) — Step the impulse physics backend so fracture
        // shards integrate gravity + collide with the level's static bodies
        // + each other. EnemySystem.updateShards reads back the body
        // transforms to update the shard meshes' positions. Runs at the
        // fixed 60 Hz tick (semi-implicit Euler — variable dt would cause
        // tunneling + non-deterministic collision response).
        this.ctx.physicsBackend?.step(FIXED_DT);
        // A2-5000-retry #367/#368 — Tick the AI director. Push a fresh
        // PerformanceSignal every frame (the director's rolling window
        // prunes to WINDOW_MS=30s) but only call `tick` once per second
        // (TICK_MS=1000 internal throttle — the decision only updates at
        // 1Hz, so calling more often wastes the prune). The signal is a
        // snapshot of the player's current state (health/armor/ammo +
        // match K/D + engagement recency) so the director can compute the
        // rolling stress score + emit CALM / BUILDING / PEAK / BREATH.
        if (this._director) {
          this._directorSigAccumulator += FIXED_DT;
          if (this._directorSigAccumulator >= 1.0) {
            this._directorSigAccumulator = 0;
            try {
              const sig: PerformanceSignal = {
                now: performance.now(),
                health: this.ctx.player.health,
                maxHealth: 100,
                armor: this.ctx.player.armor,
                ammoTotal: this.ctx.weapon.ammo + this.ctx.weapon.reserveAmmo,
                ammoMax: (this.ctx.weapon.stats.effectiveMagSize ?? 0) * 4,
                lastDeathAt: 0,
                lastEngagementAt: this.ctx.player.lastDamageTime,
                enemiesAlive: this.ctx.enemies.filter((e) => e.alive).length,
                killstreak: this.ctx.match.killstreak,
                kills: this.ctx.match.kills,
                downed: this.ctx.medical.casualtyState !== "ACTIVE",
              };
              this._director.tick(sig);
            } catch (err) {
              // Defensive — a director tick throwing shouldn't kill the loop.
              console.warn("[Engine] AIDirector.tick threw:", err);
            }
          }
        }
        // A2-5000-retry #369 — Tick the squad coordinator once per frame.
        // The coordinator throttles itself to ~2Hz internally; calling it
        // every frame is cheap (early-return on the throttle). The
        // coordinator dispatches FSM events (flankOrder / seekCover) to
        // individual enemies — without this tick, squads never form +
        // flanking behaviors never fire.
        try {
          this.ctx.ai?.squads?.tick(this.ctx);
        } catch (err) {
          console.warn("[Engine] SquadCoordinator.tick threw:", err);
        }
        // A2-5000-retry #371 — Tick boss patterns. Iterate every alive
        // enemy + call tickBossPattern (the function no-ops internally if
        // the enemy has no `bossClass` stash, so non-bosses cost ~nothing).
        // This is the engine-level integration point called out in the
        // boss-patterns.ts docstring: "driven by `tickBossPattern(ctx,
        // boss, dt, now)` called from the engine". Without this, bosses
        // used the normal enemy FSM (no phase transitions, no enrage, no
        // adds waves, no environment smash).
        try {
          const now = performance.now();
          for (const en of this.ctx.enemies) {
            if (en.alive) tickBossPattern(this.ctx, en, FIXED_DT, now);
          }
        } catch (err) {
          console.warn("[Engine] tickBossPattern threw:", err);
        }
        // A2-5000-retry #370 — Tick the companion (VIP / EXTRACTION modes).
        // The companion FSM (FOLLOW / HOLD / REGROUP / ATTACK / REVIVE /
        // CARRY / ENGAGE / COVER / DEAD) reads the player + nearest enemy
        // state each frame + updates its mesh. Null in modes without a
        // companion — `?.` no-ops.
        try {
          this._companion?.update(this.ctx, FIXED_DT);
        } catch (err) {
          console.warn("[Engine] Companion.update threw:", err);
        }
        this._accumulator -= FIXED_DT;
        steps++;
      }
      // Render-pose interpolation: pass alpha (leftover / FIXED_DT, in [0,1))
      // to systems that implement `interpolate(alpha)`. Opt-in — systems
      // that don't implement it just render with the latest physics pose
      // (the existing behavior, which is still smoother than variable-dt
      // because physics is now deterministic at 60 Hz).
      const alpha = this._accumulator / FIXED_DT;
      for (const sys of this.systems) {
        if (sys.interpolate) sys.interpolate(alpha);
      }
      // FPS counter uses real dt so the displayed FPS stays accurate during
      // slow-mo (otherwise it would show 5x the real FPS).
      this.ctx.match.fpsAccum += realDt; this.ctx.match.fpsFrames++; this.ctx.match.fpsTime += realDt;
      if (this.ctx.match.fpsTime >= 0.5) {
        this.ctx.pushHud({ fps: Math.round(this.ctx.match.fpsFrames / this.ctx.match.fpsAccum) });
        this.ctx.match.fpsAccum = 0; this.ctx.match.fpsFrames = 0; this.ctx.match.fpsTime = 0;
      }
      useGameStore.getState().flushHud(performance.now());
    }
    const renderStart = performance.now();
    // V5 — Skip the GPU render when the document is hidden. The browser
    // already throttles RAF to ~1 fps when the tab is in the background,
    // so systems continue to tick (game state stays coherent), but the
    // expensive composer + render call is wasted work the user can't see.
    // The WebGL context may also be suspended by the browser, making the
    // render a pure no-op anyway. Skipping it saves the post-proc CPU
    // pass + the composer's per-pass setup overhead.
    //
    // Prompt A#5 — also skip when the WebGL context is lost. The
    // renderer's render targets + textures are invalid until
    // `webglcontextrestored` fires + handleContextRestored() completes.
    if (!document.hidden && !this.ctx.contextLost) {
      // V1.3: always-on post-process baseline (grade + vignette + FXAA), with
      // SSAO + bloom layered on for high quality. Falls back to raw render only
      // if the composer failed to initialize on this GPU.
      this.postProc.update(realDt);
      if (this.postProc.shouldUseComposer) {
        this.postProc.render();
      } else {
        this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
      }
    }
    this.profiler.recordPhase("render", performance.now() - renderStart);
    this.profiler.recordFrame(performance.now() - t0);

    // Section L — Performance Optimization stack per-frame tick. No-ops
    // until init resolves (perfStack === null). Wrapped in try/catch so
    // a failure in any sub-system doesn't break the engine loop.
    if (this.perfStack) {
      try {
        const frameMs = performance.now() - t0;
        const subsystemTimings = this.profiler.snapshot().map((t) => ({
          name: t.name,
          avgMs: t.avgMs,
        }));
        tickPerformanceStack(this.perfStack, {
          camera: this.ctx.camera,
          // Use a monotonic timestamp as the frame index — the streaming
          // manager uses it only for LRU ordering, so the actual value
          // doesn't matter as long as it's strictly increasing.
          frameIndex: Math.floor(performance.now()),
          frameMs,
          subsystemTimings,
        });
      } catch (err) {
        // Don't kill the loop — log + null out the stack so we don't
        // keep retrying a broken stack.
        console.warn("[Engine] Performance stack tick failed — disabling:", err);
        this.perfStack = null;
      }
    }
  };
}
