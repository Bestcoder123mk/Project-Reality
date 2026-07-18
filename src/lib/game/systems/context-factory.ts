import * as THREE from "three";
import { AudioEngine } from "../audio";
import {
  computeWeaponStats,
  useGameStore,
  type Settings,
  type LoadoutConfig,
  type HudState,
  type EffectiveWeaponStats,
  type ViewMode,
} from "../store";
import {
  DEFAULT_MATERIALS,
  type BallisticsMaterial,
  type WeatherState,
  type CasualtyState,
} from "../realism";
import { particleTexture, muzzleFlashTexture } from "../textures";
import type { GameContext, ScratchAlloc } from "./types";
import { buildHumanoid } from "./utils";
import { ParticleSystemPool } from "./ObjectPool";
import { detectHardware, TIER_CONFIG, type HardwareProfile } from "./HardwareDetect";
import { createVaultState } from "./VaultSystem";
import type { MalfunctionState } from "./MalfunctionSystem";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { applyTacticalEnvironment } from "../rendering/TacticalEnvironment";
import { track } from "@/lib/analytics";

/**
 * Bootstrap a fully-initialized GameContext: WebGL renderer, scene, camera,
 * audio, weapon viewmodel scaffolding, avatar, scratch allocation, and all
 * shared mutable state. The engine constructor calls this then attaches systems.
 */
/**
 * A3-5000 #541 — server-authoritative spawn options.
 *
 * Previously `createContext` hardcoded the player's spawn position to
 * (0, 1.7, 18) and the match mode to "SURVIVAL" — single-player only.
 * Multiplayer / server-driven modes had no way to inject a spawn point
 * chosen by the server. This options bag allows the caller (the engine,
 * which in MP receives the spawn from the network handshake) to supply
 * a server-authoritative spawn position + match mode. When omitted, the
 * legacy single-player defaults are preserved (backward-compat).
 */
export interface CreateContextOptions {
  /** Server-authoritative spawn position (player feet). Default: (0, 1.7, 18). */
  spawn?: THREE.Vector3;
  /** Server-authoritative spawn yaw (radians). Default: Math.PI (facing -Z). */
  spawnYaw?: number;
  /** Match mode override. Default: "SURVIVAL" (single-player). */
  matchMode?: string;
  /** When true, the context is part of a server-authoritative match
   *  (spawn position + match mode were supplied by the server). */
  serverAuthoritative?: boolean;
}

export function createContext(
  container: HTMLElement,
  settings: Settings,
  loadout: LoadoutConfig,
  opts: CreateContextOptions = {},
): GameContext {
  const stats: EffectiveWeaponStats = computeWeaponStats(loadout);
  // A3-5000 #541 — server-authoritative spawn (defaults preserve SP behavior).
  const spawnPos = opts.spawn ? opts.spawn.clone() : new THREE.Vector3(0, 1.7, 18);
  const spawnYaw = opts.spawnYaw ?? Math.PI;
  const matchMode = opts.matchMode ?? "SURVIVAL";

  const w = container.clientWidth;
  const h = container.clientHeight;
  // Task-41 — antialias=false (was `settings.quality !== "low"`). MSAA is
  // expensive (4× the fragment shader cost on edges) and redundant — FXAA
  // in PostProcessing handles edge AA cheaply. Disabling MSAA halves GPU
  // fill rate on edge-heavy scenes (the operators have ~220 meshes each).
  // powerPreference="high-performance" already set — hints the GPU to use
  // the dedicated card on dual-GPU laptops.
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: "high-performance",
  });
  // P3.3: detect hardware capability and apply initial tier.
  const hwProfile = detectHardware(renderer.getContext() as WebGL2RenderingContext);
  const tierConfig = TIER_CONFIG[hwProfile.tier];
  renderer.setSize(w, h);
  // Task-41 — cap pixel ratio at 1.5 (was tierConfig.pixelRatio which could
  // be up to 2). Most monitors can't show the difference between 1.5 and 2.0
  // pixel ratio, but 2.0 doubles the GPU fill rate (2× the fragments per
  // pixel). Capping at 1.5 keeps the image crisp on hi-DPI displays while
  // halving the fill rate on 2x-DPI laptops. min(tierConfig.pixelRatio, 1.5)
  // preserves the hardware tier cap (low-end tiers may already cap below 1.5).
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, tierConfig.pixelRatio, 1.5));
  renderer.shadowMap.enabled = settings.shadows && hwProfile.tier !== "low";
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Task 24 — ACES Filmic tone mapping is the renderer's default tonemapper
  // (industry-standard cinematic curve). RendererSystem's constructor overrides
  // it to NoToneMapping so the PostProcessing grade shader's ACES function is
  // the SOLE tonemapper (no double-tonemap darkening — see RendererSystem.ts).
  // The ACESFilmicToneMapping setting here remains the fallback for any
  // non-composer direct render paths (e.g. the Gunsmith podium).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;   // Task 24 spec — exposure 1.0 (keep map visible).
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Note on useLegacyLights: this property was REMOVED in Three r155+ (the
  // deprecated `physicallyCorrectLights` was renamed to `useLegacyLights` in
  // r155 with inverted default `false`, then removed entirely in r165). In
  // r185 lights are ALWAYS physically correct — intensity in candela/lux/nits.
  // No setting needed; the default matches `useLegacyLights = false`.

  // V1.3 — PBR reflections: tactical-dusk HDRI environment (procedurally
  // generated via PMREMGenerator). Gives gunmetal, glass, polymer, and visors
  // real reflections — the single biggest "looks real" lever per the master
  // prompt. Falls back to RoomEnvironment if the tactical env fails to build.
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xc9b896, 0.012);
  try {
    const applied = applyTacticalEnvironment(scene, renderer);
    if (!applied) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    }
  } catch {
    // Environment unavailable — materials still render, just without reflections.
  }
  container.appendChild(renderer.domElement);
  // Stash hardware profile on the renderer for the profiler to read.
  (renderer as unknown as { _hwProfile?: HardwareProfile })._hwProfile = hwProfile;

  // Prompt #124 / A#5 — WebGL context-loss recovery. The GPU process can kill
  // the drawing surface at any time (driver crash, OS memory pressure, GPU
  // switched on a dual-GPU laptop, tab suspended for too long). Three.js can
  // recover from a lost context if we (a) preventDefault on the lost event
  // so the canvas isn't torn down, then (b) on `webglcontextrestored` walk
  // every texture + material + render target and mark them for re-upload.
  //
  // The previous implementation forced a full `window.location.reload()` on
  // context loss — that worked but lost the in-progress match. Prompt A#5
  // replaces it with an in-place recovery path:
  //   1. On `webglcontextlost`: preventDefault, set ctx.contextLost=true,
  //      surface a HUD note. The engine loop skips rendering while the flag
  //      is set (the renderer's render targets are invalid).
  //   2. On `webglcontextrestored`: clear the flag, call ctx.onContextRestored
  //      (engine.handleContextRestored → renderer.handleContextRestored +
  //      postProc.handleContextRestored), which re-uploads textures,
  //      rebuilds render targets, and recompiles materials.
  //   3. If onContextRestored throws (unusual but possible — a material
  //      references a texture that was disposed mid-restore), fall back to
  //      the reload path so the user isn't stuck on a black screen.
  //
  // Prompt A#6 — safe mode: every context loss increments a 24h-rolling
  // counter in localStorage. If the count exceeds 2 in 24h, the next boot
  // sets qualityPreset = "reduced" and skips TAA/SSAO/volumetric fog (see
  // RendererSystem.checkSafeMode()). The counter is incremented here, on
  // the lost event.
  //
  // The listeners are attached AFTER ctx is built (below) so they can
  // safely reference ctx.contextLost + ctx.onContextRestored.

  const camera = new THREE.PerspectiveCamera(settings.fov, w / h, 0.05, 500);
  camera.position.set(0, 1.7, 18);
  const raycaster = new THREE.Raycaster();
  raycaster.camera = camera;

  const clock = new THREE.Clock();
  const audio = new AudioEngine();
  audio.init();
  audio.setVolume(settings.volume);

  const weaponGroup = new THREE.Group();
  camera.add(weaponGroup);
  scene.add(camera);

  const muzzleLight = new THREE.PointLight(0xffaa44, 0, 5, 1.8);
  scene.add(muzzleLight);
  // Smaller, tighter muzzle flash plane (was 0.4 — far too big with additive blending).
  // 0.18 × 0.18 + tighter texture keeps the burst compact and avoids blowing out the screen.
  const muzzleFlash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 0.18),
    new THREE.MeshBasicMaterial({
      map: muzzleFlashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.9,
    }),
  );
  muzzleFlash.visible = false;
  // Render order so the flash draws over the weapon but doesn't z-fight.
  muzzleFlash.renderOrder = 999;
  weaponGroup.add(muzzleFlash);

  // V3 — Operator appearance: build the avatar from the equipped operator
  // slug (discrete skin). Falls back to the legacy slider-based operator
  // settings if no slug is set, for backward compatibility.
  const equippedSlug = useGameStore.getState().equippedOperatorSlug;
  const opStore = useGameStore.getState().operator;
  // V3 — read the persisted customization overrides so the in-game avatar
  // wears the player's chosen colors + accessories.
  const customState = useGameStore.getState().equippedCustomization;
  const customOverride = customState && customState.baseSlug === equippedSlug
    ? customState.overrides
    : undefined;
  const suitColor = parseInt(opStore.suitColor.replace("#", "0x"));
  // Skin tone: lerp across an 8-stop palette from #FCE7D4 to #3A2418.
  const skinStops = [0xfce7d4, 0xf0c8a8, 0xd9a878, 0xc08858, 0xa06840, 0x804828, 0x603818, 0x3a2418];
  const toneIdx = Math.min(skinStops.length - 1, Math.max(0, Math.floor(opStore.skinTone * (skinStops.length - 1))));
  const skinColor = skinStops[toneIdx];
  const avatarBuilt = buildHumanoid(suitColor, skinColor, equippedSlug, customOverride);
  avatarBuilt.group.visible = false;
  scene.add(avatarBuilt.group);

  const scratch: ScratchAlloc = {
    v1: new THREE.Vector3(),
    v2: new THREE.Vector3(),
    v3: new THREE.Vector3(),
    v4: new THREE.Vector3(),
    v5: new THREE.Vector3(),
    box1: new THREE.Box3(),
    box2: new THREE.Box3(),
    rayOrigin: new THREE.Vector3(),
    rayDir: new THREE.Vector3(),
  };

  // P2.4: particle/tracer/decal object pool. Eliminates per-frame allocations.
  const particlePool = new ParticleSystemPool(scene, particleTexture);

  // P-fix: Pointer lock cooldown tracking. Browsers block re-locking for
  // ~1.25s after exit; we track the last exit and swallow requests during
  // the cooldown to avoid SecurityError throws.
  let lastPointerLockExit = 0;
  const POINTER_LOCK_COOLDOWN_MS = 1300; // browsers use ~1250ms; pad to 1300ms.
  document.addEventListener("pointerlockchange", () => {
    if (!document.pointerLockElement) lastPointerLockExit = performance.now();
  });

  // Prompt A#1 — `pointerlockerror` retry. If the browser refuses the lock
  // (most commonly because the `unadjustedMovement:true` option is rejected
  // on some Linux/Wayland compositors, OR the canvas isn't yet focusable
  // immediately after mount), retry ONCE with a vanilla
  // requestPointerLock() (no options). The previous code only handled the
  // Promise-rejection path; this catches the synchronous error path too.
  let _pointerLockErrorRetried = false;
  document.addEventListener("pointerlockerror", () => {
    if (_pointerLockErrorRetried) return; // one retry per engage cycle
    _pointerLockErrorRetried = true;
    const el = renderer.domElement;
    // Defer to next frame so we're outside the event-dispatch context
    // (calling requestPointerLock synchronously from the error handler can
    // re-throw on some browsers).
    requestAnimationFrame(() => {
      try { el.requestPointerLock(); } catch { /* ignore */ }
    });
  });

  const ctx: GameContext = {
    scene, camera, renderer, clock, container,
    colliders: [],
    destructibles: [],
    materials: DEFAULT_MATERIALS,
    player: {
      // A3-5000 #541 — spawn position + yaw come from opts (server-
      // authoritative in MP; defaults preserve the legacy SP spawn).
      pos: spawnPos,
      vel: new THREE.Vector3(),
      yaw: spawnYaw,
      pitch: 0,
      onGround: true,
      crouching: false,
      bobTime: 0,
      stepTimer: 0,
      health: 100,
      armor: 100,
      viewMode: "first" as ViewMode,
      viewModeBlend: 0,
      thirdPersonDist: 3.4,
      lastDamageDir: -1,
      lastDamageTime: 0,
      lean: 0,
    },
    avatar: avatarBuilt,
    avatarGaitPhase: 0,
    weaponGroup,
    gunParts: { gun: new THREE.Group(), muzzleTip: new THREE.Object3D() },
    muzzleLight,
    muzzleFlash,
    muzzleTimer: 0,
    weaponSwayPhase: 0,
    weaponSwayOffset: new THREE.Vector3(),
    breathingPhase: 0,
    muzzleTipObj: new THREE.Object3D(),
    enemies: [],
    tracers: [],
    particles: [],
    decals: [],
    particlePool,
    // REAL-BALLISTICS — traveling bullet entities. Populated by
    // ProjectileSystem.spawn() (called from WeaponSystem.tryShoot + enemy
    // fire); integrated + raycast per-frame by ProjectileSystem.update().
    projectiles: [],
    projectileSystem: null,
    weapon: {
      loadout,
      stats,
      ammo: stats.effectiveMagSize,
      reserveAmmo: stats.effectiveMagSize * 3,
      lastShotTime: 0,
      reloading: false,
      reloadStart: 0,
      reloadPhase: 0,
      recoilOffset: 0,
      weaponRecoilKick: new THREE.Vector3(),
      isAiming: false,
      aimBlend: 0,
      fireHeld: false,
      switchAnim: 0,
      baseFov: settings.fov,
      primaryWeapon: loadout.weapon,
      activeSlot: "primary",
      activeSlotIndex: 0,
      shotCount: 0,
      inspectAnim: 0,
      // Prompt #44 — barrel starts cold (0.0). Climbs per shot, decays per frame.
      barrelHeat: 0,
    },
    match: {
      score: 0, kills: 0, deaths: 0, wave: 1, maxWaves: 6,
      enemiesPerWave: 4, enemiesRemaining: 0, totalEnemiesThisWave: 0,
      waveTransitioning: false, matchOver: false,
      fpsAccum: 0, fpsFrames: 0, fpsTime: 0, matchStartTime: 0,
      killstreak: 0, killstreakBest: 0, reconReady: false, airstrikeReady: false,
      reconActiveUntil: 0,
      // A3-5000 #541 — match mode can be overridden by the caller (server-
      // authoritative in MP; defaults to SURVIVAL for single-player).
      mode: matchMode as GameContext["match"]["mode"], concurrentEnemyCap: 99, extractionCarrying: false,
      breachRoomIndex: -1, headshots: 0, meleeKills: 0, recentKills: [],
    },
    medical: {
      casualtyState: "ACTIVE" as CasualtyState,
      bleedRate: 0,
      fractureLimb: "",
      inventory: { bandage: 3, splint: 1, epi: 1, medkit: 1 },
      channel: null,
    },
    suppression: { value: 0 },
    stamina: {
      value: 100, max: 100, regenRate: 15, sprintDrainRate: 25, jumpCost: 20,
      aimDrainRate: 2, exhaustionCooldown: 3, regenResumesAt: 0, exhausted: false,
    },
    vault: createVaultState(),
    weaponMalfunction: { current: null, condition: 1, lastClearedAt: 0 } as MalfunctionState,
    weather: { timeOfDay: 9, cloudCover: 0.3, precipitation: 0, windSpeed: 3, windDirection: 0.5, fogDensity: 0.012, wetness: 0 } as WeatherState,
    weatherTime: 0,
    rainParticles: null,
    sunLight: null,
    hemiLight: null,
    skyMesh: null,
    keys: {},
    paused: false,
    running: false,
    settings,
    audio,
    raycaster,
    scratch,
    pushHud: (partial: Partial<HudState>) => useGameStore.getState().setHud(partial),
    addKillFeed: (entry) => useGameStore.getState().addKillFeed(entry),
    onVictory: () => {},
    onGameOver: () => {},
    onStartWave: () => {},
    onPointerLockChange: () => {},
    // Prompt A#5 — context-loss state. `contextLost` is set true by the
    // webglcontextlost listener (attached after ctx construction below);
    // the engine loop checks this and skips rendering while true.
    // `onContextRestored` is the engine's restore entry point — it's a
    // no-op stub here, the engine overrides it in its constructor.
    contextLost: false,
    onContextRestored: () => {},
    // P-fix: Pointer lock requests are rate-limited by the browser. After
    // exiting, the browser imposes a ~1.25s cooldown before a new request
    // can succeed. Calling requestPointerLock() during that window throws
    // a SecurityError. We track the last exit time and silently swallow
    // requests made within the cooldown window — the user can click again
    // after the cooldown passes.
    //
    // Prompt #108 — unadjustedMovement: ask the browser to deliver raw HID
    // mouse deltas (no OS acceleration curve / ballistics applied). This
    // gives the linear "1:1 mouse-to-view" feel every competitive FPS
    // expects. Chromium-based browsers support `unadjustedMovement: true`;
    // Firefox + Safari ignore the option (their default is already linear
    // for pointer-lock). When the option is requested but rejected (some
    // Linux Wayland compositors refuse it), fall back to a vanilla
    // requestPointerLock() so the game still locks.
    requestPointerLock: () => {
      const el = renderer.domElement;
      // Already locked — no-op.
      if (document.pointerLockElement === el) return;
      // Cooldown check: browser blocks re-lock for ~1.25s after exit.
      const now = performance.now();
      if (now - lastPointerLockExit < POINTER_LOCK_COOLDOWN_MS) return;
      // Reset the one-shot pointerlockerror retry flag for this engage cycle.
      _pointerLockErrorRetried = false;
      // Prompt A#1 — defer the actual requestPointerLock() to the next
      // animation frame. On a cold mount the canvas element may not yet be
      // considered focusable by the browser (layout hasn't settled, the
      // element hasn't been painted), causing the first click to silently
      // fail. Calling from a rAF callback guarantees the element is in the
      // DOM + laid out, so the first click engages on the first try.
      const attemptLock = () => {
        try {
          let attempted = false;
          if ("requestPointerLock" in Element.prototype) {
            try {
              const p = el.requestPointerLock({ unadjustedMovement: true } as PointerLockOptions) as
                | Promise<void>
                | undefined;
              attempted = true;
              if (p && typeof p.catch === "function") {
                p.catch(() => {
                  // Rejection — fall back to vanilla lock immediately.
                  try { el.requestPointerLock(); } catch { /* ignore */ }
                });
              }
            } catch {
              // Synchronous throw with the option — fall back.
              try { el.requestPointerLock(); } catch { /* ignore */ }
            }
          }
          // Fallback: if the option path wasn't attempted (feature missing), or
          // as a safety net for silent failures, also try a plain lock. We delay
          // 300ms so we don't double-lock if the option succeeded.
          if (!attempted) {
            el.requestPointerLock();
          } else {
            setTimeout(() => {
              if (!document.pointerLockElement) {
                try { el.requestPointerLock(); } catch { /* ignore */ }
              }
            }, 300);
          }
        } catch {
          try { el.requestPointerLock(); } catch { /* ignore */ }
        }
      };
      // Use rAF for the first-frame-after-mount case. Subsequent calls (user
      // clicked engage overlay) also benefit — the rAF callback runs after
      // the browser has processed the click event + settled layout.
      requestAnimationFrame(attemptLock);
    },
    exitPointerLock: () => {
      if (document.pointerLockElement) {
        document.exitPointerLock();
        lastPointerLockExit = performance.now();
      }
    },
    isPointerLocked: () => document.pointerLockElement === renderer.domElement,
    // Wave fix: no-op stubs — the engine overrides these in its constructor.
    // Without these defaults, callers that touched ctx.scheduleWaveTransition
    // before the engine wired it up would crash with "not a function".
    scheduleWaveTransition: (cb: () => void, delayMs: number) => {
      // Fallback: raw setTimeout (engine replaces with a cancellable version).
      setTimeout(cb, delayMs);
    },
    cancelWaveTransition: () => {},
    // Camera juice: no-op stub — engine overrides with physics.triggerShake.
    triggerShake: (_intensity: number) => {},
    // Task-6: post-processing pipeline ref — engine sets this after PostProcessing is built.
    postProc: null,
    // V2 — chunk streaming manager — RendererSystem sets this after buildMap.
    chunkManager: null,
    // V3 — health + ammo pickup system — engine sets this after construction.
    pickups: null,
    // Task-14 — LOD system — engine sets this after constructing LODSystem.
    lodSystem: null,
    // Task-22 — ragdoll physics — engine sets this after constructing RagdollSystem.
    ragdolls: null,
    // G1.2/G1.3 — mode-specific entities, null until the engine builds them.
    vip: null,
    extractionObjective: null,
    extractionZone: null,
  };

  // Patch engine-level callbacks after engine construction.
  // (Engine overrides these in its constructor.)

  // Prompt A#5 — attach the WebGL context-loss / restore listeners now
  // that ctx exists. The lost listener sets ctx.contextLost=true so the
  // engine loop skips rendering; the restore listener clears the flag +
  // calls ctx.onContextRestored (engine hooks it). Falls back to a full
  // reload if restore throws (defensive — shouldn't happen in practice).
  renderer.domElement.addEventListener(
    "webglcontextlost",
    (e: Event) => {
      e.preventDefault();
      ctx.contextLost = true;
      // Prompt A#6 — increment the 24h rolling context-loss counter.
      try {
        incrementContextLossCount();
        const count = getContextLossCount();
        track("context_lost", { count, safeMode: count > 2 ? 1 : 0 });
      } catch { /* analytics best-effort */ }
      try {
        useGameStore.getState().setHud({
          objective: "Graphics context lost — restoring…",
        });
      } catch {
        /* store unavailable (SSR / mid-dispose) — ignore */
      }
    },
    false,
  );
  renderer.domElement.addEventListener(
    "webglcontextrestored",
    () => {
      try {
        ctx.contextLost = false;
        ctx.onContextRestored();
      } catch {
        // Restore threw — fall back to reload so the user isn't stuck.
        try { window.location.reload(); } catch { /* ignore */ }
      }
    },
    false,
  );

  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt A#6 — safe-mode context-loss counter (24h rolling window).
// Stored in localStorage as `pr_context_loss_log` = JSON array of timestamps.
// On boot, RendererSystem.checkSafeMode() reads this + decides whether to
// force qualityPreset = "reduced".
// ─────────────────────────────────────────────────────────────────────────────

const CONTEXT_LOSS_LS_KEY = "pr_context_loss_log";
const CONTEXT_LOSS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const CONTEXT_LOSS_SAFE_MODE_THRESHOLD = 2;          // >2 losses in 24h → safe mode
const CONTEXT_LOSS_DECAY_MS = 12 * 60 * 60 * 1000;   // decay 1 per 12h of clean uptime

/** Read the rolling 24h context-loss count from localStorage. */
export function getContextLossCount(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(CONTEXT_LOSS_LS_KEY);
    if (!raw) return 0;
    const arr = JSON.parse(raw) as number[];
    if (!Array.isArray(arr)) return 0;
    const cutoff = Date.now() - CONTEXT_LOSS_WINDOW_MS;
    return arr.filter((t) => typeof t === "number" && t > cutoff).length;
  } catch {
    return 0;
  }
}

/** Append a context-loss timestamp to the rolling log (Prompt A#6). */
export function incrementContextLossCount(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(CONTEXT_LOSS_LS_KEY);
    const arr = raw ? (JSON.parse(raw) as number[]) : [];
    if (!Array.isArray(arr)) return;
    arr.push(Date.now());
    // Trim entries older than the 24h window so the log doesn't grow
    // unbounded across long sessions.
    const cutoff = Date.now() - CONTEXT_LOSS_WINDOW_MS;
    const trimmed = arr.filter((t) => typeof t === "number" && t > cutoff);
    window.localStorage.setItem(CONTEXT_LOSS_LS_KEY, JSON.stringify(trimmed));
  } catch {
    /* localStorage unavailable — best-effort */
  }
}

/** Prompt A#6 — should the boot path engage safe mode? True iff the
 *  24h-rolling context-loss count exceeds the threshold. RendererSystem
 *  constructor reads this; if true, qualityPreset is forced to "reduced"
 *  + a toast is surfaced. The threshold is `>` (so 2 losses = OK, 3rd =
 *  safe mode). */
export function shouldEngageSafeMode(): boolean {
  return getContextLossCount() > CONTEXT_LOSS_SAFE_MODE_THRESHOLD;
}

/** Prompt A#6 — decay the context-loss log by one entry per 12h of clean
 *  uptime (called from RendererSystem.update() once per minute). This lets
 *  a device that had a bad day recover to full quality after a day of
 *  stability, rather than being stuck in safe mode forever. */
export function decayContextLossLog(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(CONTEXT_LOSS_LS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw) as number[];
    if (!Array.isArray(arr) || arr.length === 0) return;
    // Drop the oldest entry if it's older than the decay window.
    const cutoff = Date.now() - CONTEXT_LOSS_DECAY_MS;
    const trimmed = arr.filter((t) => typeof t === "number" && t > cutoff);
    if (trimmed.length !== arr.length) {
      window.localStorage.setItem(CONTEXT_LOSS_LS_KEY, JSON.stringify(trimmed));
    }
  } catch {
    /* ignore */
  }
}

/** Helper type re-exported for the engine. */
export type { BallisticsMaterial };
