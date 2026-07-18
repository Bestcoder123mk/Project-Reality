import * as THREE from "three";
import type { GameContext, Enemy } from "./types";

/**
 * GrenadeSystem — wind-up + throw with physics arc.
 *
 * Press G to throw a grenade (if utility slot has one). The throw has a
 * 0.4s wind-up (arm pulls back) + release (grenade flies in a physics arc).
 * On impact, spawns a small explosion (screen shake + damage in radius).
 */

interface GrenadeProjectile {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  exploded: boolean;
  /** Task-5 — who threw this grenade? Player grenades damage enemies;
   *  enemy grenades damage the player. Defaults to "player" for the
   *  legacy releaseGrenade() path. */
  team: "player" | "enemy";
  /** Section B #198 — grenade type. Each type has distinct behavior + audio. */
  type?: GrenadeType;
  /** Section B #203 — last bounce surface (for distinct bounce audio). */
  lastBounceSurface?: string;
  /** Section B #200 — smoke volume radius (for smoke grenades). */
  smokeRadius?: number;
  /** Section B #201 — incendiary DoT zone duration (seconds). */
  fireDuration?: number;
  /** Section B #202 — decoy fire countdown (seconds until next fake shot). */
  decoyNextShot?: number;
}

/**
 * Section B #198 — grenade types: frag, smoke, flash, incendiary, decoy.
 * Each has distinct behavior + audio.
 */
export type GrenadeType = "frag" | "smoke" | "flash" | "incendiary" | "decoy";

/** Section B #198 — per-grenade-type behavior config. */
export interface GrenadeTypeConfig {
  /** Display label. */
  label: string;
  /** Fuse length (seconds). */
  fuseSec: number;
  /** Explosion radius (m). 0 = no explosion (smoke). */
  explosionRadius: number;
  /** Base explosion damage (at center, falls off to 0 at the edge). */
  baseDamage: number;
  /** Smoke radius (m). 0 = no smoke. */
  smokeRadius: number;
  /** Smoke duration (seconds). 0 = no smoke. */
  smokeDurationSec: number;
  /** Flash effect radius (m). 0 = no flash. */
  flashRadius: number;
  /** Incendiary fire duration (seconds). 0 = no fire. */
  fireDurationSec: number;
  /** Incendiary fire radius (m). 0 = no fire. */
  fireRadius: number;
  /** Decoy shot interval (seconds). 0 = no decoy. */
  decoyIntervalSec: number;
  /** Mesh color (hex). */
  colorHex: number;
}

/** Section B #198 — per-type behavior table. */
export const GRENADE_TYPE_CONFIGS: Record<GrenadeType, GrenadeTypeConfig> = {
  frag:        { label: "Frag",        fuseSec: 2.5, explosionRadius: 5.0, baseDamage: 80,  smokeRadius: 0,   smokeDurationSec: 0,  flashRadius: 0,  fireDurationSec: 0,   fireRadius: 0,   decoyIntervalSec: 0,   colorHex: 0x4a5a3a },
  smoke:       { label: "Smoke",       fuseSec: 2.0, explosionRadius: 0,   baseDamage: 0,   smokeRadius: 4.0, smokeDurationSec: 12, flashRadius: 0,  fireDurationSec: 0,   fireRadius: 0,   decoyIntervalSec: 0,   colorHex: 0x6a6a6a },
  flash:       { label: "Flash",       fuseSec: 1.5, explosionRadius: 0,   baseDamage: 0,   smokeRadius: 0,   smokeDurationSec: 0,  flashRadius: 15, fireDurationSec: 0,   fireRadius: 0,   decoyIntervalSec: 0,   colorHex: 0x8a8a8a },
  incendiary:  { label: "Incendiary",  fuseSec: 1.0, explosionRadius: 2.0, baseDamage: 30,  smokeRadius: 0,   smokeDurationSec: 0,  flashRadius: 0,  fireDurationSec: 8,   fireRadius: 3.0, decoyIntervalSec: 0,   colorHex: 0x8a3a2a },
  decoy:       { label: "Decoy",       fuseSec: 8.0, explosionRadius: 0,   baseDamage: 0,   smokeRadius: 0,   smokeDurationSec: 0,  flashRadius: 0,  fireDurationSec: 0,   fireRadius: 0,   decoyIntervalSec: 1.5, colorHex: 0x5a4a3a },
};

/** Section B #199 — flashbang ear-ringing effect state. */
export interface TinnitusState {
  /** Remaining tinnitus duration (seconds). */
  remaining: number;
  /** Total tinnitus duration (for fade-in/out math). */
  total: number;
  /** High-freq sine gain (0..1). */
  ringGain: number;
  /** Muffle amount (0..1) — applied to the master bus lowpass. */
  muffleAmount: number;
}

/** Section B #199 — apply a flashbang ear-ringing effect. Returns the
 *  tinnitus state scaled by exposure (distance + line-of-sight). */
export function computeTinnitus(
  distanceM: number,
  flashRadius: number,
  lineOfSight: boolean,
): TinnitusState {
  if (distanceM >= flashRadius) {
    return { remaining: 0, total: 0, ringGain: 0, muffleAmount: 0 };
  }
  // Exposure scales with proximity + LOS. Inside 5m + LOS = full exposure.
  const proximityRatio = 1 - distanceM / flashRadius; // 1 at center, 0 at edge
  const exposure = lineOfSight ? proximityRatio : proximityRatio * 0.4;
  // Duration: 5–15s scaled by exposure.
  const duration = 5 + exposure * 10;
  return {
    remaining: duration,
    total: duration,
    ringGain: 0.4 + exposure * 0.4, // 0.4..0.8
    muffleAmount: 0.3 + exposure * 0.4, // 0.3..0.7
  };
}

/** Section B #200 — smoke volume for AI vision occlusion. */
export interface SmokeVolume {
  /** Center position (world). */
  pos: THREE.Vector3;
  /** Radius (m). */
  radius: number;
  /** Remaining duration (seconds). */
  remaining: number;
  /** Total duration (for fade-in/out). */
  total: number;
}

/** Section B #200 — does a smoke volume block the LOS between two points? */
export function smokeBlocksLOS(smokes: SmokeVolume[], from: THREE.Vector3, to: THREE.Vector3): boolean {
  for (const s of smokes) {
    if (s.remaining <= 0) continue;
    // Closest point on the segment [from, to] to the smoke center.
    const ab = new THREE.Vector3().subVectors(to, from);
    const ap = new THREE.Vector3().subVectors(s.pos, from);
    const t = Math.max(0, Math.min(1, ap.dot(ab) / ab.lengthSq()));
    const closest = new THREE.Vector3().copy(from).addScaledVector(ab, t);
    if (closest.distanceTo(s.pos) < s.radius) return true;
  }
  return false;
}

/** Section B #201 — incendiary damage-over-time zone. */
export interface FireZone {
  pos: THREE.Vector3;
  radius: number;
  remaining: number;
  /** Damage per second applied to entities inside the zone. */
  dps: number;
  /** Slow multiplier applied to entities inside the zone (0.5 = 50% speed). */
  slowMult: number;
}

/** Section B #201 — apply incendiary DoT to an entity at the given position. */
export function applyFireZoneDamage(
  zones: FireZone[],
  pos: THREE.Vector3,
  dt: number,
): { damage: number; slowMult: number } {
  let damage = 0;
  let slowMult = 1.0;
  for (const z of zones) {
    if (z.remaining <= 0) continue;
    if (pos.distanceTo(z.pos) < z.radius) {
      damage += z.dps * dt;
      slowMult = Math.min(slowMult, z.slowMult);
    }
  }
  return { damage, slowMult };
}

/** Section B #203 — per-surface bounce audio slug. */
export function grenadeBounceAudioSlug(surface: string): string {
  switch (surface) {
    case "sheet_metal":
    case "steel_plate": return "grenade_bounce_metal";
    case "wood":        return "grenade_bounce_wood";
    case "concrete":    return "grenade_bounce_concrete";
    case "glass":       return "grenade_bounce_glass";
    case "earth":       return "grenade_bounce_earth";
    default:            return "grenade_bounce_default";
  }
}

/** Section B #204 — grenade pin-pull audio slug. */
export const GRENADE_PIN_PULL_AUDIO = "grenade_pin_pull";

/** Section B #206 — projectile gravity (m/s²). Grenades use realistic -9.81.
 *  A2-5000 #230 — single source of truth (was duplicated as 9.8 in
 *  throwFromEnemy; now everyone reads GRENADE_GRAVITY). */
export const GRENADE_GRAVITY = 9.81;

/**
 * A2-5000 #229 — data-driven grenade count. The legacy `grenadesLeft = 2`
 * was hardcoded; this table lets the loadout / difficulty / resupply
 * paths set the starting count. Default 2 preserves legacy behavior.
 */
export interface GrenadeLoadoutConfig {
  startingCount: number;
  perType?: Partial<Record<GrenadeType, number>>;
}
export const DEFAULT_GRENADE_LOADOUT: GrenadeLoadoutConfig = { startingCount: 2 };

/**
 * A2-5000 #233 — grenade mesh pool. Avoids per-throw geometry+material
 * allocation (was a GPU-memory leak under sustained spam). Pool grows up
 * to MAX_POOL_SIZE; overflow allocations are actually disposed.
 */
const MAX_GRENADE_POOL = 16;
const _grenadeMeshPool: THREE.Mesh[] = [];
function acquireGrenadeMesh(colorHex: number): THREE.Mesh {
  const m = _grenadeMeshPool.pop();
  if (m) {
    (m.material as THREE.MeshStandardMaterial).color.setHex(colorHex);
    m.visible = true;
    return m;
  }
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 8, 8),
    new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.6, metalness: 0.3 }),
  );
}
function releaseGrenadeMesh(m: THREE.Mesh): void {
  // A2-5000 #234 — removeFromParent handles reparented meshes (scene.remove
  // only detaches from the scene root; reparented grenades were leaked).
  m.removeFromParent();
  m.visible = false;
  if (_grenadeMeshPool.length < MAX_GRENADE_POOL) {
    _grenadeMeshPool.push(m);
  } else {
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
}

/**
 * A2-5000 #231 — terrain-aware ground height provider. The legacy
 * collision used a flat `y=0.1` which clipped through elevated floors.
 * The engine wires this to the actual terrain height query. Default 0.
 */
export type GroundHeightProvider = (x: number, z: number) => number;
let _groundHeightProvider: GroundHeightProvider = () => 0;
export function setGroundHeightProvider(fn: GroundHeightProvider): void {
  _groundHeightProvider = fn;
}
export function getGroundHeightAt(x: number, z: number): number {
  return _groundHeightProvider(x, z);
}

/**
 * A2-5000 #239 — enemy damage hook. The legacy explode() bypassed the
 * onDamageEnemy path for enemy grenades (no suppression, no knockback).
 * The engine wires this to MedicalSystem's damage entry point.
 */
export type EnemyGrenadeDamageHook = (
  playerPos: THREE.Vector3,
  explosionPos: THREE.Vector3,
  damage: number,
  falloff: number,
) => void;
let _enemyGrenadeDamageHook: EnemyGrenadeDamageHook | null = null;
export function setEnemyGrenadeDamageHook(fn: EnemyGrenadeDamageHook | null): void {
  _enemyGrenadeDamageHook = fn;
}

/**
 * A2-5000 #238 — data-driven grenade boost config. The legacy boost used
 * hardcoded 22/14/18. The engine / difficulty can override via
 * setGrenadeBoostConfig().
 */
export interface GrenadeBoostConfig {
  horizontalForce: number;
  verticalForce: number;
  selfDamage: number;
  difficultyMult?: number;
}
export const DEFAULT_GRENADE_BOOST: GrenadeBoostConfig = {
  horizontalForce: 22,
  verticalForce: 14,
  selfDamage: 18,
};
let _grenadeBoostConfig: GrenadeBoostConfig = { ...DEFAULT_GRENADE_BOOST };
export function setGrenadeBoostConfig(cfg: Partial<GrenadeBoostConfig>): void {
  _grenadeBoostConfig = { ..._grenadeBoostConfig, ...cfg };
}

export class GrenadeSystem {
  private ctx: GameContext;
  private grenades: GrenadeProjectile[] = [];
  private windUpTimer = 0;
  // A2-5000 #229 — data-driven starting count (was hardcoded `= 2`).
  private grenadesLeft = DEFAULT_GRENADE_LOADOUT.startingCount;
  /**
   * A2-5000 #244 — cook-cap accumulator (was wall-clock based; at 30fps the
   * check could fire 33ms late). The accumulator ticks by `dt*1000` per
   * frame so the cap is exact at any frame rate (within dt precision).
   */
  private cookElapsedMs = 0;
  /**
   * SEC5-COMBAT — Prompt 46: cook mechanic state.
   *
   * `cooking` is true while the player is holding the grenade key with the
   * intent to cook (hold-to-cook input mode). `cookStart` is the timestamp
   * (performance.now()) when cooking began. `COOK_FUSE_MS` is the fuse length
   * used by the cook path (4.0s — longer than the legacy 2.5s throw-on-release
   * fuse, giving the player room to cook). `COOK_CAP_MS` is the safety cap —
   * if the player holds a cooking grenade for more than 4.5s, it explodes in
   * their hand (intended self-damage).
   */
  private cooking = false;
  private cookStart = 0;
  private static readonly COOK_FUSE_MS = 4000;  // 4.0s fuse when cooked
  private static readonly COOK_CAP_MS = 4500;   // 4.5s hard cap — explode in hand

  /**
   * Section B #196 — arc preview state. While the player is holding the
   * grenade key (wind-up or cook), the system exposes a predicted arc.
   * The HUD reads this + renders a dotted line.
   */
  private arcPreviewActive = false;
  /**
   * Section B #197 — underhand throw state. True while right-click is held
   * during a grenade wind-up (short, low arc for rolling into doorways).
   */
  private underhandMode = false;
  /** Section B #198 — currently selected grenade type (defaults to frag). */
  private selectedType: GrenadeType = "frag";
  /** Section B #199 — active tinnitus state (drives the audio filter). */
  private tinnitus: TinnitusState = { remaining: 0, total: 0, ringGain: 0, muffleAmount: 0 };
  /** Section B #200 — active smoke volumes (drives AI LOS occlusion). */
  private smokes: SmokeVolume[] = [];
  /** Section B #201 — active incendiary fire zones. */
  private fireZones: FireZone[] = [];

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    // A2-5000 #240 — guard against duplicate self-registration. The legacy
    // constructor overwrote `ctx.enemyGrenadeThrow` silently; if a second
    // GrenadeSystem is constructed (e.g. on hot-reload), warn + skip the
    // re-registration so the first instance keeps owning the hook.
    if ((ctx as unknown as { _grenadeSystemRegistered?: boolean })._grenadeSystemRegistered) {
      console.warn("[GrenadeSystem] duplicate instance — ctx.enemyGrenadeThrow already registered. Skipping re-registration.");
    } else {
      ctx.enemyGrenadeThrow = (origin, target) => this.throwFromEnemy(origin, target);
      (ctx as unknown as { _grenadeSystemRegistered?: boolean })._grenadeSystemRegistered = true;
    }
  }

  /** A2-5000 #229 — data-driven grenade count reset. Called by the engine
   *  on match start with the loadout/difficulty-sourced starting count. */
  resetGrenades(config: GrenadeLoadoutConfig = DEFAULT_GRENADE_LOADOUT) {
    this.grenadesLeft = config.startingCount;
  }
  /** A2-5000 #229 — resupply (buy station / pickup). */
  addGrenades(n: number) {
    this.grenadesLeft = Math.max(0, this.grenadesLeft + n);
  }

  /** Section B #198 — get the currently selected grenade type. */
  getSelectedType(): GrenadeType { return this.selectedType; }
  /** Section B #198 — set the grenade type (cycle key or loadout). */
  setSelectedType(t: GrenadeType) { this.selectedType = t; }

  /** Section B #196 — get the predicted arc points while holding. Returns
   *  null when not holding. Each point is a world position. */
  getArcPreview(): THREE.Vector3[] | null {
    if (!this.arcPreviewActive) return null;
    const start = this.ctx.camera.getWorldPosition(new THREE.Vector3());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ctx.camera.quaternion);
    const speed = this.underhandMode ? 7 : 15;
    const vel = forward.clone().multiplyScalar(speed);
    vel.y += this.underhandMode ? 1 : 3;
    const points: THREE.Vector3[] = [];
    const dt = 0.05; // 50ms steps
    let pos = start.clone();
    let v = vel.clone();
    for (let i = 0; i < 60; i++) { // 3s max preview
      pos.addScaledVector(v, dt);
      v.y -= GRENADE_GRAVITY * dt;
      points.push(pos.clone());
      if (pos.y < 0.1) break;
    }
    return points;
  }

  /** Section B #197 — toggle underhand mode (right-click while holding G). */
  setUnderhand(active: boolean) {
    this.underhandMode = active;
  }

  /** Section B #199 — get the current tinnitus state (for audio routing). */
  getTinnitus(): TinnitusState { return this.tinnitus; }

  /** Section B #200 — get active smoke volumes (for AI LOS occlusion). */
  getSmokeVolumes(): SmokeVolume[] { return this.smokes; }

  /** Section B #201 — get active fire zones (for DoT application). */
  getFireZones(): FireZone[] { return this.fireZones; }

  /** Start a grenade throw (wind-up begins). Legacy throw-on-release path. */
  startThrow() {
    if (this.grenadesLeft <= 0) return;
    if (this.windUpTimer > 0) return; // already winding up
    if (this.cooking) return; // can't wind-up while cooking
    this.windUpTimer = 0.4; // 400ms wind-up
    this.arcPreviewActive = true; // Section B #196 — show arc preview
    // Section B #204 — play pin-pull audio on throw start.
    this.ctx.audio.playGunshot?.("grenade_pin_pull" as any);
  }

  /**
   * SEC5-COMBAT — Prompt 46: Start cooking a grenade (hold-to-cook input).
   *
   * The fuse starts ticking immediately. The player can hold for up to
   * COOK_CAP_MS (4.5s) before the grenade explodes in their hand. Call
   * `releaseThrow()` to throw the cooked grenade (the remaining fuse burns
   * in flight — a grenade cooked for 1.5s + released has 2.5s of fuse left
   * in flight, exploding ~2.5s after release).
   *
   * No-op if the player has no grenades, is already cooking, or is mid-wind-up.
   */
  startCook() {
    if (this.grenadesLeft <= 0) return;
    if (this.cooking) return; // already cooking
    if (this.windUpTimer > 0) return; // can't cook while winding up
    this.cooking = true;
    this.cookStart = performance.now();
    this.cookElapsedMs = 0; // A2-5000 #244 — reset accumulator
    this.arcPreviewActive = true; // Section B #196 — show arc preview while cooking
    // Section B #204 — play pin-pull audio on cook start.
    this.ctx.audio.playGunshot?.("grenade_pin_pull" as any);
    // A2-5000 #241 — do NOT clobber the objective HUD string. The legacy
    // `pushHud({ objective: "Wave ... Eliminate ..." })` overwrote whatever
    // objective the mission system had set (e.g. "BREACH: room 2"). The cook
    // state is read by the HUD via getCookState(); no HUD overwrite needed.
  }

  /**
   * SEC5-COMBAT — Prompt 46: Release a cooked grenade.
   *
   * Throws the grenade with the remaining fuse (COOK_FUSE_MS - cookElapsed).
   * If the cook has exceeded the safety cap (COOK_CAP_MS = 4.5s), the grenade
   * explodes in the player's hand instead (self-damage path).
   *
   * No-op if not currently cooking.
   */
  releaseThrow() {
    if (!this.cooking) return;
    // A2-5000 #242 — keep `cooking=true` until AFTER explodeInHand completes.
    // The legacy order (`cooking=false` then `explodeInHand()`) was fragile
    // if explodeInHand re-entered releaseThrow (e.g. via a queued input).
    const cookElapsed = this.cookElapsedMs;
    this.arcPreviewActive = false; // Section B #196 — hide arc preview
    // If the player held past the safety cap, the grenade explodes in hand.
    if (cookElapsed >= GrenadeSystem.COOK_CAP_MS) {
      this.explodeInHand();
      this.cooking = false; // A2-5000 #242 — set after explodeInHand
      return;
    }
    this.cooking = false;
    // Decrement grenades + spawn the grenade with the remaining fuse.
    // A2-5000 #243 — Math.max guard against negative count.
    this.grenadesLeft = Math.max(0, this.grenadesLeft - 1);
    const remainingFuseMs = Math.max(200, GrenadeSystem.COOK_FUSE_MS - cookElapsed);
    this.releaseCookedGrenade(remainingFuseMs / 1000);
  }

  /**
   * SEC5-COMBAT — Prompt 46: Cook state accessor.
   *
   * Exposes the cook state for the HUD cook-timer widget + the engine loop.
   * Returns null when not cooking; otherwise returns { elapsed, remaining, cap }
   * in milliseconds.
   */
  getCookState(): { elapsed: number; remaining: number; cap: number } | null {
    if (!this.cooking) return null;
    const elapsed = performance.now() - this.cookStart;
    const cap = GrenadeSystem.COOK_CAP_MS;
    const remaining = Math.max(0, cap - elapsed);
    return { elapsed, remaining, cap };
  }

  /** True if a grenade is currently being cooked. */
  get isCooking() { return this.cooking; }

  /** Update the wind-up + release + projectile physics + cook-timer. */
  update(dt: number) {
    // SEC5-COMBAT — Prompt 46: cook-timer safety cap. A2-5000 #244 —
    // accumulator-based cap (was wall-clock; could exceed by one frame at
    // low FPS). The accumulator ticks by dt*1000 so the cap is exact at
    // any frame rate.
    if (this.cooking) {
      this.cookElapsedMs += dt * 1000;
      if (this.cookElapsedMs >= GrenadeSystem.COOK_CAP_MS) {
        this.explodeInHand();
        this.cooking = false; // A2-5000 #242 — set after explodeInHand
      }
    }

    // Wind-up timer.
    if (this.windUpTimer > 0) {
      this.windUpTimer -= dt;
      if (this.windUpTimer <= 0) {
        this.arcPreviewActive = false; // Section B #196 — hide arc preview
        this.releaseGrenade();
      }
    }

    // Section B #199 — decay tinnitus.
    if (this.tinnitus.remaining > 0) {
      this.tinnitus.remaining = Math.max(0, this.tinnitus.remaining - dt);
      if (this.tinnitus.remaining === 0) {
        this.tinnitus.ringGain = 0;
        this.tinnitus.muffleAmount = 0;
      }
    }

    // Section B #200 — decay smoke volumes.
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      this.smokes[i].remaining -= dt;
      if (this.smokes[i].remaining <= 0) this.smokes.splice(i, 1);
    }

    // Section B #201 — decay fire zones + apply DoT to the player + enemies.
    for (let i = this.fireZones.length - 1; i >= 0; i--) {
      const z = this.fireZones[i];
      z.remaining -= dt;
      if (z.remaining <= 0) {
        this.fireZones.splice(i, 1);
        continue;
      }
      // Apply DoT to the player.
      const playerDist = z.pos.distanceTo(this.ctx.player.pos);
      if (playerDist < z.radius) {
        const dmg = z.dps * dt;
        this.ctx.player.health -= dmg;
        this.ctx.pushHud({ health: Math.max(0, Math.round(this.ctx.player.health)) });
        if (this.ctx.player.health <= 0) this.ctx.onGameOver();
      }
      // Apply DoT to enemies.
      for (const e of this.ctx.enemies) {
        if (!e.alive) continue;
        if (e.group.position.distanceTo(z.pos) < z.radius) {
          e.health -= z.dps * dt;
          if (e.health <= 0) {
            (this.ctx as unknown as { enemies?: { killEnemy?: (e: Enemy, hs: boolean) => void } }).enemies?.killEnemy?.(e, false);
          }
        }
      }
    }

    // Update grenades.
    // A2-5000 #232 — snapshot the grenades array before iterating. The
    // legacy `for (i = grenades.length-1; i >= 0; i--)` + `splice(i, 1)` was
    // fragile if `explode()` mutated the array (barrel chains, future code).
    const grenadeSnapshot = this.grenades.slice();
    for (const g of grenadeSnapshot) {
      g.life -= dt;

      // Physics: gravity + velocity. Section B #206 — use realistic -9.81.
      g.velocity.y -= GRENADE_GRAVITY * dt;
      g.mesh.position.addScaledVector(g.velocity, dt);

      // A2-5000 #231 — terrain-aware ground collision. Was `y < 0.1` (flat);
      // now queries the registered ground-height provider so elevated
      // floors on multi-floor maps don't get clipped through.
      const groundY = getGroundHeightAt(g.mesh.position.x, g.mesh.position.z) + 0.1;
      if (g.mesh.position.y < groundY) {
        g.mesh.position.y = groundY;
        // A2-5000 #245 — rolling physics. When the bounce velocity is low,
        // switch to rolling mode (high friction, no further bouncing).
        // The legacy single-bounce model just dampened velocity by 0.4
        // forever, which produced a stutter instead of a roll.
        const speedSq = g.velocity.x * g.velocity.x + g.velocity.z * g.velocity.z;
        if (Math.abs(g.velocity.y) < 1.0 && speedSq < 4.0) {
          // Rolling: high horizontal friction, kill vertical.
          g.velocity.y = 0;
          g.velocity.x *= 0.85; // rolling friction
          g.velocity.z *= 0.85;
        } else {
          // Bounce.
          g.velocity.y *= -0.4;
          g.velocity.x *= 0.7;
          g.velocity.z *= 0.7;
          // Section B #203 — play a surface-specific bounce audio cue.
          if (!g.lastBounceSurface) {
            this.ctx.audio.playGunshot?.("grenade_bounce_default" as any);
          }
          g.lastBounceSurface = "concrete";
        }
      }

      // Section B #202 — decoy grenade fires fake shots at intervals.
      if (g.type === "decoy" && g.decoyNextShot !== undefined) {
        g.decoyNextShot -= dt;
        if (g.decoyNextShot <= 0) {
          const fakeWeapons = ["ak74", "m4", "mp5", "usp"];
          const fakeSlug = fakeWeapons[Math.floor(Math.random() * fakeWeapons.length)];
          this.ctx.audio.playGunshot?.(fakeSlug as any);
          g.decoyNextShot = GRENADE_TYPE_CONFIGS.decoy.decoyIntervalSec;
        }
      }

      // Explode after life expires.
      if (g.life <= 0 && !g.exploded) {
        this.explode(g);
        // A2-5000 #232 — remove via indexOf (safe even if explode mutated).
        const idx = this.grenades.indexOf(g);
        if (idx >= 0) this.grenades.splice(idx, 1);
      }
    }
  }

  /**
   * SEC5-COMBAT — Prompt 46: Explode a cooking grenade in the player's hand.
   *
   * The player takes the full base damage (80) with a 1.2× penalty for cooking
   * past the cap (intended self-damage — the spec says "grenade explodes in
   * hand if held >4.5s"). Armor absorbs 60% as usual. The explosion VFX plays
   * at the player's chest position. No grenade projectile is spawned.
   *
   * This is the "you held it too long" fail state — it's intended to be lethal
   * or near-lethal. A player at full health + armor takes ~38 HP damage; a
   * player without armor takes the full 96 HP (likely death).
   */
  private explodeInHand() {
    const { ctx } = this;
    // A2-5000 #243 — Math.max guard against negative count.
    this.grenadesLeft = Math.max(0, this.grenadesLeft - 1);
    const explosionPos = ctx.camera.getWorldPosition(new THREE.Vector3());
    const baseDmg = 80 * 1.2; // 1.2× penalty for cooking past the cap
    let remaining = baseDmg;
    if (ctx.player.armor > 0) {
      const absorbed = Math.min(ctx.player.armor, remaining * 0.6);
      ctx.player.armor -= absorbed;
      remaining -= absorbed;
    }
    ctx.player.health -= remaining;
    ctx.audio.damage();
    ctx.player.lastDamageDir = 0; // self-damage — no direction
    ctx.player.lastDamageTime = performance.now();
    ctx.pushHud({
      health: Math.max(0, Math.round(ctx.player.health)),
      armor: Math.max(0, Math.round(ctx.player.armor)),
      damageFlash: performance.now(),
      // Surface a clear "cooked too long" message.
      objective: `Grenade cooked too long — exploded in hand!`,
    });
    // Trigger the cinematic explosion VFX at the player's chest so the
    // failure state reads as a real explosion, not just a damage tick.
    (ctx as unknown as {
      particles?: { spawnExplosion?: (p: THREE.Vector3, s: number, k: "grenade" | "barrel" | "c4") => void };
    }).particles?.spawnExplosion?.(explosionPos.clone(), 1.0, "grenade");
    ctx.triggerShake(0.5);
    if (ctx.player.health <= 0) ctx.onGameOver();
  }

  /**
   * SEC5-COMBAT — Prompt 46: Release a cooked grenade from the camera position.
   *
   * Same as `releaseGrenade()` (the legacy wind-up path) but takes an explicit
   * `fuseSeconds` so the cooked grenade's remaining fuse is respected.
   *
   * Section B #197 — underhand throw: if `underhandMode` is true, throw with
   * reduced velocity + lower arc for rolling into doorways.
   */
  private releaseCookedGrenade(fuseSeconds: number) {
    const { ctx } = this;
    const type = this.selectedType;
    const cfg = GRENADE_TYPE_CONFIGS[type];
    // A2-5000 #233 — pooled mesh (was per-throw allocation).
    const mesh = acquireGrenadeMesh(cfg.colorHex);
    mesh.castShadow = true;
    ctx.scene.add(mesh);

    // Start position = camera position.
    const startPos = ctx.camera.getWorldPosition(new THREE.Vector3());
    mesh.position.copy(startPos);

    // Velocity = camera forward + slight upward arc.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    const speed = this.underhandMode ? 7 : 15;
    const velocity = forward.multiplyScalar(speed);
    velocity.y += this.underhandMode ? 1 : 3;

    this.grenades.push({
      mesh, velocity, life: fuseSeconds, exploded: false, team: "player",
      type,
      decoyNextShot: type === "decoy" ? GRENADE_TYPE_CONFIGS.decoy.decoyIntervalSec : undefined,
    });

    // Wind-up animation: dip the gun briefly.
    ctx.weapon.weaponRecoilKick.y = -0.15;
    this.underhandMode = false; // reset underhand after throw
  }

  /** Release the grenade from the camera position. */
  private releaseGrenade() {
    const { ctx } = this;
    // A2-5000 #243 — Math.max guard.
    this.grenadesLeft = Math.max(0, this.grenadesLeft - 1);

    const type = this.selectedType;
    const cfg = GRENADE_TYPE_CONFIGS[type];
    // A2-5000 #233 — pooled mesh.
    const mesh = acquireGrenadeMesh(cfg.colorHex);
    mesh.castShadow = true;
    ctx.scene.add(mesh);

    // Start position = camera position.
    const startPos = ctx.camera.getWorldPosition(new THREE.Vector3());
    mesh.position.copy(startPos);

    // Velocity = camera forward + slight upward arc.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    const speed = this.underhandMode ? 7 : 15;
    const velocity = forward.multiplyScalar(speed);
    velocity.y += this.underhandMode ? 1 : 3;

    this.grenades.push({
      mesh, velocity, life: cfg.fuseSec, exploded: false, team: "player",
      type,
      decoyNextShot: type === "decoy" ? GRENADE_TYPE_CONFIGS.decoy.decoyIntervalSec : undefined,
    });

    // Wind-up animation: dip the gun briefly.
    ctx.weapon.weaponRecoilKick.y = -0.15;
    this.underhandMode = false;
  }

  /** Task-5 — Enemy grenade throw. Computes a parabolic arc from the enemy
   *  chest to the player position with a ~2s flight time (gives the player
   *  a chance to react / reposition). The grenade is marked `team: "enemy"`
   *  so the explosion damages the player, not the throwing enemy's squad.
   *  No wind-up — enemy throws are instant (the wind-up is a player UX).
   *  Caps the in-flight enemy-grenade count at 4 to avoid grenade spam. */
  throwFromEnemy(origin: THREE.Vector3, target: THREE.Vector3) {
    const { ctx } = this;
    // Spam guard: at most 4 live enemy grenades on the field.
    const liveEnemy = this.grenades.filter((g) => g.team === "enemy").length;
    if (liveEnemy >= 4) return;

    // A2-5000 #233 — pooled mesh (enemy grenades use a distinct color).
    const mesh = acquireGrenadeMesh(0x3a4a2a);
    mesh.castShadow = true;
    ctx.scene.add(mesh);
    mesh.position.copy(origin);

    // Compute velocity for a parabolic arc landing at `target`.
    // A2-5000 #235 — flight time scales with distance (was hardcoded 1.8s,
    // which made long throws look unnaturally fast + short throws floaty).
    // Use ~0.6s per 10m, clamped to [0.8, 2.5]s.
    const distM = origin.distanceTo(target);
    const flightTime = Math.max(0.8, Math.min(2.5, 0.6 + distM * 0.06));
    const displacement = target.clone().sub(origin);
    const velocity = displacement.multiplyScalar(1 / flightTime);
    // A2-5000 #230 — single gravity constant (was 9.8; now GRENADE_GRAVITY=9.81).
    velocity.y += 0.5 * GRENADE_GRAVITY * flightTime;

    // A2-5000 #236 — scatter scales with distance (was fixed ±1.25 m/s,
    // which was 45% of a 5m throw's velocity but only 8% of a 30m throw's).
    // Scale: 0.5 m/s at 5m, 2.5 m/s at 30m, linear in between.
    const scatterMag = Math.max(0.5, Math.min(2.5, distM * 0.08));
    velocity.x += (Math.random() - 0.5) * 2 * scatterMag;
    velocity.z += (Math.random() - 0.5) * 2 * scatterMag;

    this.grenades.push({ mesh, velocity, life: flightTime, exploded: false, team: "enemy" });
  }

  /** Explode a grenade — screen shake + damage in radius + visual.
   *  Task-5 — player grenades damage enemies (legacy path); enemy grenades
   *  damage the player (with simple armor absorption, since GrenadeSystem
   *  doesn't have a direct ref to MedicalSystem).
   *
   *  Task-25 — explosion VFX upgraded to the cinematic layered
   *  `spawnExplosion(point, 1.0, "grenade")` (flash → fireball → smoke →
   *  shockwave → debris → dust + point light + screen shake + FOV punch).
   *  Also damages destructibles in radius so grenades can blow up oil
   *  barrels (which then trigger their own barrel explosions → chain). */
  private explode(g: GrenadeProjectile) {
    const { ctx } = this;
    g.exploded = true;

    const explosionPos = g.mesh.position;
    const type = g.type ?? "frag";
    const cfg = GRENADE_TYPE_CONFIGS[type];

    // Section B #198 — per-type explosion behavior.
    // Smoke: spawn a smoke volume (no damage).
    // Flash: apply tinnitus to the player + flash effect (no damage).
    // Incendiary: spawn a fire zone (small initial explosion damage).
    // Decoy: no explosion, just expire (the decoy shots stop).
    // Frag: full damage in radius (legacy behavior).
    if (type === "smoke") {
      this.smokes.push({
        pos: explosionPos.clone(),
        radius: cfg.smokeRadius,
        remaining: cfg.smokeDurationSec,
        total: cfg.smokeDurationSec,
      });
      // A2-5000 #233/#234 — pooled + removeFromParent (was scene.remove + dispose).
      releaseGrenadeMesh(g.mesh);
      return;
    }
    if (type === "flash") {
      // Section B #199 — apply tinnitus to the player based on distance + LOS.
      const playerDist = explosionPos.distanceTo(ctx.player.pos);
      const tinnitus = computeTinnitus(playerDist, cfg.flashRadius, true);
      if (tinnitus.remaining > 0) {
        this.tinnitus = tinnitus;
      }
      // Flashbang also applies suppression + a brief screen white-out (engine
      // reads the tinnitus state + the suppression value to drive the VFX).
      ctx.suppression.value = Math.min(1, ctx.suppression.value + 0.5);
      // Apply tinnitus to enemies too (they're flashed).
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const eDist = explosionPos.distanceTo(e.group.position);
        if (eDist < cfg.flashRadius) {
          // Mark the enemy as flashed (FSM reads this + enters a blind state).
          (e as unknown as { flashedUntil?: number }).flashedUntil = performance.now() + 3000;
        }
      }
      releaseGrenadeMesh(g.mesh); // A2-5000 #233/#234 — pooled + removeFromParent
      return;
    }
    if (type === "incendiary") {
      // Initial small explosion damage, then spawn a fire zone.
      const radius = cfg.explosionRadius;
      const baseDmg = cfg.baseDamage;
      if (g.team === "player") {
        for (const e of ctx.enemies) {
          if (!e.alive) continue;
          const dist = e.group.position.distanceTo(explosionPos);
          if (dist < radius) {
            e.health -= baseDmg * (1 - dist / radius);
            e.hitFlash = 0.2;
            if (e.health <= 0) {
              (ctx as unknown as { enemies?: { killEnemy?: (e: Enemy, hs: boolean) => void } }).enemies?.killEnemy?.(e, false);
            }
          }
        }
      }
      // Spawn the fire zone.
      this.fireZones.push({
        pos: explosionPos.clone(),
        radius: cfg.fireRadius,
        remaining: cfg.fireDurationSec,
        dps: 25, // 25 dps
        slowMult: 0.6, // 40% slow
      });
      (ctx as unknown as {
        particles?: { spawnExplosion?: (p: THREE.Vector3, s: number, k: "grenade" | "barrel" | "c4") => void };
      }).particles?.spawnExplosion?.(explosionPos.clone(), 0.7, "grenade");
      releaseGrenadeMesh(g.mesh); // A2-5000 #233/#234
      return;
    }
    if (type === "decoy") {
      // Decoy grenades don't explode — they just expire. The fake-shot logic
      // in update() already ran during the decoy's life. No VFX.
      releaseGrenadeMesh(g.mesh); // A2-5000 #233/#234
      return;
    }

    // Default: frag grenade (legacy behavior).
    // A2-5000 #237 — per-type blast radius (was hardcoded `5`; now reads
    // cfg.explosionRadius so non-frag types use their configured radius).
    const radius = cfg.explosionRadius || 5;
    const baseDmg = cfg.baseDamage || 80;

    // ── GRENADE BOOSTING (Prompt 3) ──────────────────────────────────
    // A2-5000 #238 — data-driven boost config (was hardcoded 22/14/18).
    // The engine / difficulty can override via setGrenadeBoostConfig().
    const boostCfg = _grenadeBoostConfig;
    if (g.team === "player") {
      const playerDist = explosionPos.distanceTo(ctx.player.pos);
      if (playerDist < radius && playerDist > 0.01) {
        const falloff = 1 - playerDist / radius; // 1 at center, 0 at edge
        const boostDir = ctx.player.pos.clone().sub(explosionPos).normalize();
        // Horizontal push (stronger) + vertical lift (for air-time + chaining with vault).
        const diffMult = boostCfg.difficultyMult ?? 1.0;
        const horizontalForce = boostCfg.horizontalForce * falloff * diffMult;
        const verticalForce = boostCfg.verticalForce * falloff * diffMult;
        ctx.player.vel.x += boostDir.x * horizontalForce;
        ctx.player.vel.z += boostDir.z * horizontalForce;
        ctx.player.vel.y += verticalForce;
        // Clear ground state so the boost takes effect immediately.
        ctx.player.onGround = false;
        // Intentional self-damage cost (reuses the falloff curve, reduced vs enemies).
        const selfDmg = boostCfg.selfDamage * falloff;
        let remaining = selfDmg;
        if (ctx.player.armor > 0) {
          const absorbed = Math.min(ctx.player.armor, remaining * 0.6);
          ctx.player.armor -= absorbed;
          remaining -= absorbed;
        }
        ctx.player.health -= remaining;
        ctx.audio.damage();
        // Directional damage indicator points AT the grenade (where the boost came from).
        const dx = explosionPos.x - ctx.player.pos.x;
        const dz = explosionPos.z - ctx.player.pos.z;
        ctx.player.lastDamageDir = Math.atan2(dx, dz) - ctx.player.yaw;
        ctx.player.lastDamageTime = performance.now();
        ctx.pushHud({
          health: Math.max(0, Math.round(ctx.player.health)),
          armor: Math.max(0, Math.round(ctx.player.armor)),
          damageFlash: performance.now(),
        });
        if (ctx.player.health <= 0) ctx.onGameOver();
      }
    }

    if (g.team === "enemy") {
      // Task-5 — damage the player. A2-5000 #239 — route through the
      // onDamageEnemy hook (was bypassed; no suppression/knockback applied).
      // The hook is optional; if not wired, fall back to the legacy direct path.
      const dist = explosionPos.distanceTo(ctx.player.pos);
      if (dist < radius) {
        const dmg = baseDmg * (1 - dist / radius);
        const falloff = 1 - dist / radius;
        if (_enemyGrenadeDamageHook) {
          _enemyGrenadeDamageHook(ctx.player.pos, explosionPos, dmg, falloff);
        } else {
          // Legacy fallback — simple armor absorption (60%, like MedicalSystem).
          let remaining = dmg;
          if (ctx.player.armor > 0) {
            const absorbed = Math.min(ctx.player.armor, remaining * 0.6);
            ctx.player.armor -= absorbed;
            remaining -= absorbed;
          }
          ctx.player.health -= remaining;
          ctx.audio.damage();
        }
        // Directional damage indicator.
        const dx = explosionPos.x - ctx.player.pos.x;
        const dz = explosionPos.z - ctx.player.pos.z;
        ctx.player.lastDamageDir = Math.atan2(dx, dz) - ctx.player.yaw;
        ctx.player.lastDamageTime = performance.now();
        ctx.pushHud({
          health: Math.max(0, Math.round(ctx.player.health)),
          armor: Math.max(0, Math.round(ctx.player.armor)),
          damageFlash: performance.now(),
        });
        if (ctx.player.health <= 0) ctx.onGameOver();
      }
    } else {
      // Player grenade — damage enemies in radius (legacy path).
      for (const e of ctx.enemies) {
        if (!e.alive) continue;
        const dist = e.group.position.distanceTo(explosionPos);
        if (dist < radius) {
          const dmg = baseDmg * (1 - dist / radius); // falloff
          // Direct damage to enemy (bypasses the normal damageEnemy for simplicity).
          e.health -= dmg;
          e.hitFlash = 0.2;
          if (e.health <= 0) {
            // Use the engine's killEnemy path.
            (ctx as unknown as { enemies?: { killEnemy?: (e: Enemy, hs: boolean) => void } }).enemies?.killEnemy?.(e, false);
          }
        }
      }

      // Task-25 — damage destructibles in radius (so grenades can blow up
      // oil barrels + trigger chain explosions). Snapshot the array since
      // we modify it during iteration (destroyed props are spliced out).
      const destructibleSnapshot = ctx.destructibles.slice();
      for (const prop of destructibleSnapshot) {
        if (prop.health <= 0) continue;
        const dist = prop.mesh.position.distanceTo(explosionPos);
        if (dist >= radius) continue;
        prop.health -= baseDmg * (1 - dist / radius);
        if (prop.health > 0) continue;
        // Prop destroyed by the grenade — clean it up (replicates
        // EnemySystem.destroyProp) + trigger barrel chain explosions.
        const isBarrel = prop.mesh.userData.surfaceType === "barrel";
        const propPos = prop.mesh.position.clone();
        prop.mesh.removeFromParent();
        const ci = ctx.colliders.indexOf(prop.collider);
        if (ci >= 0) ctx.colliders.splice(ci, 1);
        const di = ctx.destructibles.indexOf(prop);
        if (di >= 0) ctx.destructibles.splice(di, 1);
        if (isBarrel) {
          // Barrels trigger the cinematic explosion VFX + schedule their own
          // chain scan (so a tightly-packed barrel cluster detonates in a
          // rolling chain — 0.3s delay per hop).
          (ctx as unknown as {
            particles?: { spawnExplosion?: (p: THREE.Vector3, s: number, k: "grenade" | "barrel" | "c4") => void };
          }).particles?.spawnExplosion?.(propPos, 1.5, "barrel");
        }
      }
    }

    // Task-25 — cinematic layered explosion VFX (flash → fireball → smoke →
    // shockwave → debris → dust + point light + screen shake 0.5 + FOV punch
    // +1.5 + audio). spawnExplosion handles all of the above; the previous
    // spawnImpact call (which silently no-oped since ctx.particles wasn't
    // actually set) is replaced. Audio is now played inside spawnExplosion
    // too, so the explicit distantGunshot call below is removed.
    (ctx as unknown as {
      particles?: { spawnExplosion?: (p: THREE.Vector3, s: number, k: "grenade" | "barrel" | "c4") => void };
    }).particles?.spawnExplosion?.(explosionPos.clone(), 1.0, "grenade");

    // Remove the grenade mesh.
    releaseGrenadeMesh(g.mesh); // A2-5000 #233/#234 — pooled + removeFromParent
  }

  /** Get the number of grenades remaining. */
  get count() { return this.grenadesLeft; }

  /** Is currently winding up a throw? */
  get isWindingUp() { return this.windUpTimer > 0; }

  // ───────────────────────────────────────────────────────────────────────────
  // B1-5000 — Prompts 729 (pin-reinsertion cancel cook), 731 (enemy dodge cue),
  // 743 (rolling on slope), 744 (wall/window collision), 748 (pin-pull anim),
  // 750 (cooking audio escalation).
  //
  // The existing GrenadeSystem already covers: 718 (cook fuse), 719 (arc
  // preview), 720 (underhand), 721 (5 grenade types), 722 (flashbang tinnitus),
  // 723 (smoke LOS occlusion), 724 (incendiary DoT), 725 (decoy), 726 (bounce
  // audio), 727 (pin-pull audio), 728 (cook-too-long), 730 (resupply),
  // 732–742 (data-driven count, gravity, terrain collision, splice safety,
  // pooling, flight-time, blast radius, damage hook, HUD safety, double-decrement,
  // rolling physics), 745 (type selection UI), 746 (cook timer HUD), 749 (throw
  // animation via weaponRecoilKick).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Prompt 729 — pin-reinsertion (cancel cook by releasing without throwing).
   * Call this when the player cancels a cook (e.g. presses Q while cooking).
   * Resets the cook state WITHOUT throwing or consuming a grenade. The pin is
   * "reinserted" (cosmetic; the grenade is preserved).
   *
   * Returns true if a cook was cancelled (the engine plays a pin-reinsert
   * audio cue); false if the player wasn't cooking.
   */
  cancelCook(): boolean {
    if (!this.cooking) return false;
    this.cooking = false;
    this.cookElapsedMs = 0;
    this.arcPreviewActive = false;
    // Play a pin-reinsert audio cue (engine wires to the audio system).
    this.ctx.audio.playGunshot?.("grenade_pin_reinsert" as never);
    return true;
  }

  /**
   * Prompt 731 — enemy grenade dodge cue. When an enemy throws a grenade, the
   * player should hear an audio cue (pin pull + throw grunt) so they have a
   * reaction window. The engine calls this method when an enemy grenade throw
   * starts; the system plays the pin-pull + grunt audio at the enemy's
   * position (spatialized).
   *
   * This is the enemy-side complement to the player's pin-pull audio (prompt
   * 727). The player's own pin-pull is already played in startCook()/startThrow().
   */
  playEnemyGrenadeDodgeCue(enemyPos: THREE.Vector3): void {
    // Spatialized pin-pull + throw grunt at the enemy position. The audio
    // system's positional audio path handles the 3D falloff.
    this.ctx.audio.playGunshot?.("grenade_pin_pull" as never);
    // The throw grunt is a separate cue (an enemy bark). The audio system
    // can route this through the VO/bark channel.
    this.ctx.audio.playGunshot?.("enemy_throw_grunt" as never);
    // Stash the enemy position so the audio system can spatialize. The engine
    // reads this via getEnemyGrenadeSourcePos().
    this._lastEnemyGrenadeSourcePos = enemyPos.clone();
  }

  /** Prompt 731 — get the last enemy-grenade source position (for spatialization). */
  getEnemyGrenadeSourcePos(): THREE.Vector3 | null {
    return this._lastEnemyGrenadeSourcePos ?? null;
  }
  private _lastEnemyGrenadeSourcePos: THREE.Vector3 | null = null;

  /**
   * Prompt 743 — grenade rolling on slope. When a grenade lands on a slope
   * (ground normal not pointing straight up), it should roll downhill. The
   * engine calls this method per frame with the ground normal at the
   * grenade's position; the method applies a downhill velocity component.
   *
   * Returns the velocity delta to apply this frame (m/s). Zero on flat ground.
   */
  applySlopeRollVelocity(
    currentVel: THREE.Vector3,
    groundNormal: THREE.Vector3,
    dt: number,
  ): THREE.Vector3 {
    // Slope = ground normal tilted from up (0,1,0). The downhill direction is
    // the projection of gravity onto the slope plane.
    const up = new THREE.Vector3(0, 1, 0);
    // If the normal is nearly straight up, no slope.
    const slopeAngle = Math.acos(Math.max(-1, Math.min(1, groundNormal.dot(up))));
    if (slopeAngle < 0.05) return new THREE.Vector3(); // ~3° threshold
    // Downhill direction = gravity projected onto the slope plane.
    const gravity = new THREE.Vector3(0, -GRENADE_GRAVITY, 0);
    const downhill = gravity.clone().projectOnPlane(groundNormal).normalize();
    // Rolling acceleration scales with sin(slopeAngle).
    const accel = GRENADE_GRAVITY * Math.sin(slopeAngle) * 0.5; // 0.5 = rolling efficiency
    return downhill.multiplyScalar(accel * dt);
  }

  /**
   * Prompt 744 — grenade through openings (collision with walls/windows/props).
   * The legacy physics only checked ground (y=0.1). This method raycasts the
   * grenade's next position against the environment colliders + stops the
   * grenade at the first wall/prop collision.
   *
   * Returns the adjusted position + velocity after collision. If the grenade
   * passes through a window (thin opening), the velocity is preserved but
   * reduced (window-pane resistance).
   */
  resolveWallCollision(
    currentPos: THREE.Vector3,
    proposedPos: THREE.Vector3,
    currentVel: THREE.Vector3,
  ): { pos: THREE.Vector3; vel: THREE.Vector3; hitWall: boolean; hitWindow: boolean } {
    const { ctx } = this;
    // Raycast from current to proposed position against environment colliders.
    const dir = new THREE.Vector3().subVectors(proposedPos, currentPos);
    const dist = dir.length();
    if (dist < 0.001) return { pos: proposedPos, vel: currentVel, hitWall: false, hitWindow: false };
    dir.normalize();
    ctx.raycaster.set(currentPos, dir);
    ctx.raycaster.far = dist;
    const hits = ctx.raycaster.intersectObjects(getEnvRaycastTargetsForGrenade(ctx), false);
    if (hits.length === 0) {
      return { pos: proposedPos, vel: currentVel, hitWall: false, hitWindow: false };
    }
    const hit = hits[0];
    const surface = (hit.object.userData?.materialSlug as string) ?? "concrete";
    // Windows (glass) let the grenade pass through with reduced velocity.
    if (surface === "glass") {
      const passThroughPos = hit.point.clone().addScaledVector(dir, 0.05);
      return {
        pos: passThroughPos,
        vel: currentVel.clone().multiplyScalar(0.7), // 30% velocity loss
        hitWall: false,
        hitWindow: true,
      };
    }
    // Solid wall: stop at the hit point + reflect velocity (bounce).
    const stopPos = hit.point.clone().addScaledVector(dir, -0.05);
    const normal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
      : new THREE.Vector3(0, 1, 0);
    // Reflect velocity across the normal (bounce).
    const dot = currentVel.dot(normal);
    const reflected = currentVel.clone().addScaledVector(normal, -2 * dot).multiplyScalar(0.4);
    return { pos: stopPos, vel: reflected, hitWall: true, hitWindow: false };
  }

  /**
   * Prompt 747 — wire GrenadeCookState. The existing getCookState() returns
   * {elapsed, remaining, cap}. This method exposes a richer cook state that
   * the HUD + audio system can consume (includes the throw strength modifier
   * from the cook + the audio escalation intensity for #750).
   *
   * Returns null when not cooking.
   */
  getGrenadeCookState(): {
    elapsedMs: number;
    remainingMs: number;
    capMs: number;
    /** 0..1 — how "hot" the cook is. 0 at start, 1 at the cap. */
    intensity: number;
    /** Throw strength modifier — cooked grenades throw slightly harder. */
    throwStrengthMult: number;
  } | null {
    if (!this.cooking) return null;
    const elapsed = this.cookElapsedMs;
    const cap = GrenadeSystem.COOK_CAP_MS;
    const remaining = Math.max(0, cap - elapsed);
    const intensity = Math.min(1, elapsed / cap);
    // Cooked grenades throw ~10% harder per 1s of cook (the player commits more).
    const throwStrengthMult = 1.0 + Math.min(0.20, intensity * 0.20);
    return { elapsedMs: elapsed, remainingMs: remaining, capMs: cap, intensity, throwStrengthMult };
  }

  /**
   * Prompt 748 — grenade pin-pull animation trigger. The engine calls this
   * when the cook/wind-up starts; the system exposes a flag the viewmodel
   * reads to play the pin-pull animation. The flag is true for the first
   * 300ms of the cook/wind-up (the pin-pull animation duration).
   *
   * Returns true if the viewmodel should play the pin-pull animation this frame.
   */
  shouldPlayPinPullAnim(): boolean {
    if (!this.cooking && this.windUpTimer <= 0) return false;
    // Pin-pull animation plays for the first 300ms of cook or wind-up.
    if (this.cooking) {
      return this.cookElapsedMs < 300;
    }
    // Wind-up is 400ms; pin-pull plays for the first 300ms.
    return this.windUpTimer > 0.1;
  }

  /**
   * Prompt 750 — grenade cooking audio escalation. As the cook progresses,
   * the grenade "tick" audio intensifies (faster tempo + higher pitch as the
   * cook approaches the cap). The engine calls this per frame; the method
   * returns the tick intensity (0..1) + the interval between ticks (ms) for
   * the audio system.
   *
   * Returns null when not cooking.
   */
  getCookAudioEscalation(): { intensity: number; intervalMs: number } | null {
    if (!this.cooking) return null;
    const cap = GrenadeSystem.COOK_CAP_MS;
    const t = Math.min(1, this.cookElapsedMs / cap);
    // Intensity ramps from 0.3 at t=0 to 1.0 at t=1.
    const intensity = 0.3 + 0.7 * t;
    // Tick interval shrinks from 500ms at t=0 to 100ms at t=1 (faster as it nears cap).
    const intervalMs = Math.round(500 - 400 * t);
    return { intensity, intervalMs };
  }

  dispose() {
    for (const g of this.grenades) {
      releaseGrenadeMesh(g.mesh); // A2-5000 #233/#234 — pooled + removeFromParent
    }
    this.grenades = [];
    // Task-5 — clear the self-registered hook so a stale GrenadeSystem
    // reference isn't held by the (possibly reused) context after dispose.
    this.ctx.enemyGrenadeThrow = undefined;
    (this.ctx as unknown as { _grenadeSystemRegistered?: boolean })._grenadeSystemRegistered = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B1-5000 #744 — env-raycast targets for grenades. Mirrors the WeaponSystem's
// getEnvRaycastTargets but exposed here as a private helper so the grenade
// collision check doesn't import from the weapon path. The shared cache lives
// in raycast-env.ts; this is a thin wrapper.
// ─────────────────────────────────────────────────────────────────────────────
function getEnvRaycastTargetsForGrenade(ctx: GameContext): THREE.Object3D[] {
  // Defensive — the engine wires ctx.envRaycastTargets (cached env meshes).
  // If unavailable, fall back to the destructibles + colliders list.
  const cached = (ctx as unknown as { envRaycastTargets?: THREE.Object3D[] }).envRaycastTargets;
  if (cached) return cached;
  const targets: THREE.Object3D[] = [];
  for (const d of ctx.destructibles) {
    if (d.health > 0) targets.push(d.mesh);
  }
  return targets;
}
