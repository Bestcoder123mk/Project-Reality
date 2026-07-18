import type { GameSystem, GameContext } from "./types";

/**
 * HudSystem — owns the periodic full-HUD sync (called once per frame from the loop)
 * and exposes pushHud / addKillFeed helpers that write to the Zustand store.
 *
 * Per-frame partial updates (pushHud) are scattered across systems; this system
 * only handles the periodic full reconciliation.
 *
 * NOTE: P2.3 will replace this with a sliced, throttled, batched system.
 *
 * HUD-minimap: also publishes live enemy/player positions to
 * `window.__PR_MINIMAP_DATA__` each frame so the React minimap canvas
 * can read them without going through the Zustand store (no re-render cost).
 *
 * Prompt #48 — also drives the low-HP heartbeat audio. Below 40 HP the
 * heart starts beating (slow at 15-40, fast below 15). The audio is
 * synthesized by AudioEngine.heartbeat(); this system throttles the call
 * rate based on HP tier so the beat matches the player's danger level.
 */
export class HudSystem implements GameSystem {
  constructor(private ctx: GameContext) {}

  /** Prompt #48 — next wall-clock time (ms) to fire a heartbeat. */
  private nextHeartbeatAt = 0;

  update(dt: number) {
    this.syncHud();
    this.syncMinimap();
    this.syncTactical();
    this.tickHeartbeat();
  }

  syncHud() {
    const { ctx } = this;
    ctx.pushHud({
      health: Math.max(0, Math.round(ctx.player.health)),
      maxHealth: 100,
      armor: Math.max(0, Math.round(ctx.player.armor)),
      ammo: ctx.weapon.ammo,
      magSize: ctx.weapon.stats.effectiveMagSize,
      reserveAmmo: ctx.weapon.reserveAmmo,
      weaponName: ctx.weapon.stats.name,
      score: ctx.match.score,
      kills: ctx.match.kills,
      deaths: ctx.match.deaths,
      enemiesRemaining: ctx.match.enemiesRemaining,
      totalEnemies: ctx.match.totalEnemiesThisWave,
      reloading: ctx.weapon.reloading,
      reloadProgress: ctx.weapon.reloadPhase,
      wave: ctx.match.wave,
      suppression: ctx.suppression.value,
      casualtyState: ctx.medical.casualtyState,
      bleedRate: ctx.medical.bleedRate,
      medicalInventory: { ...ctx.medical.inventory },
    });
  }

  /** Push live minimap data to the React layer via window globals. */
  private syncMinimap() {
    if (typeof window === "undefined") return;
    const { ctx } = this;
    const blips = ctx.enemies
      .filter((e) => e.alive)
      .map((e) => ({
        x: e.group.position.x,
        z: e.group.position.z,
        kind: "enemy" as "enemy" | "objective",
      }));
    // Objective marker = center of map for now (could be wired to MatchFSM).
    blips.push({ x: 0, z: 0, kind: "objective" as "enemy" | "objective" });
    window.__PR_MINIMAP_DATA__ = {
      playerX: ctx.player.pos.x,
      playerZ: ctx.player.pos.z,
      playerYaw: ctx.player.yaw,
      blips,
    };
    // Realism: publish last damage direction for the HUD directional indicator.
    window.__PR_DAMAGE_DIR__ = {
      dir: ctx.player.lastDamageDir,
      time: ctx.player.lastDamageTime,
    };
    // Dynamic crosshair: publish movement speed + recoil + aiming state so
    // the HUD crosshair can spread based on movement/recoil.
    const speed = Math.hypot(ctx.player.vel.x, ctx.player.vel.z);
    window.__PR_CROSSHAIR_STATE__ = {
      speed,
      recoil: ctx.weapon.recoilOffset,
      aiming: ctx.weapon.aimBlend > 0.5,
      airborne: !ctx.player.onGround,
    };
    // Prompt 8: publish the 4-slot loadout strip data for the HUD.
    window.__PR_LOADOUT_STRIP__ = {
      primary: ctx.weapon.loadout.weapon,
      secondary: ctx.weapon.loadout.secondary,
      melee: ctx.weapon.loadout.melee,
      utility: ctx.weapon.loadout.utility,
      active: ctx.weapon.activeSlotIndex,
      utilityCharges: (ctx as any).grenades?.count ?? 0,
    };
  }

  /** V2 + V5.4 — Publish killstreak state + enemy nameplate data for the
   *  tactical HUD components (KillstreakTracker, EnemyNameplate). Reads
   *  happen via rAF in the React layer so there's no per-frame re-render. */
  private syncTactical() {
    if (typeof window === "undefined") return;
    const { ctx } = this;
    const now = performance.now();
    // Killstreak + reward readiness.
    window.__PR_KILLSTREAK__ = {
      streak: ctx.match.killstreak,
      best: ctx.match.killstreakBest,
      reconReady: ctx.match.reconReady,
      airstrikeReady: ctx.match.airstrikeReady,
      reconActive: now < ctx.match.reconActiveUntil,
      reconRemainingMs: Math.max(0, ctx.match.reconActiveUntil - now),
    };
    // Enemy nameplate data: world position + health + class + last-damaged
    // time for every alive enemy. The React layer projects to screen + picks
    // the crosshair target / recently-damaged ones to render.
    const cam = ctx.camera;
    window.__PR_NAMEPLATES__ = ctx.enemies
      .filter((e) => e.alive)
      .map((e) => {
        const p = e.group.position;
        return {
          x: p.x,
          y: p.y + 2.1, // above the head
          z: p.z,
          health: e.health,
          maxHealth: e.maxHealth,
          className: e.className,
          lastDamaged: e.lastDamagedTime,
          // Was this enemy damaged in the last 2s? Drives nameplate fade.
          recent: now - e.lastDamagedTime < 2000,
        };
      });
    // Camera basis for screen projection (forward + right + up + position).
    ctx.scratch.v1.set(0, 0, -1).applyQuaternion(cam.quaternion); // forward
    ctx.scratch.v2.set(1, 0, 0).applyQuaternion(cam.quaternion);  // right
    window.__PR_CAMERA_BASIS__ = {
      pos: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      forward: { x: ctx.scratch.v1.x, y: ctx.scratch.v1.y, z: ctx.scratch.v1.z },
      right: { x: ctx.scratch.v2.x, y: ctx.scratch.v2.y, z: ctx.scratch.v2.z },
      fov: cam.fov,
      aspect: cam.aspect,
    };
  }

  /**
   * Prompt #48 — low-HP heartbeat driver. Reads the player's current HP
   * and fires AudioEngine.heartbeat() at a tier-appropriate rate:
   *
   *   HP > 40:   no heartbeat (player is healthy — silence).
   *   HP 15-40:  1 beat per second (slow, ominous — "you're hurt").
   *   HP < 15:   2 beats per second (fast, panicked — "you're dying").
   *
   * The visual vignette / blood overlay is driven by the React HUD layer
   * (HUD.tsx) based on the same HP value pushed via syncHud. This method
   * only handles the audio side — kept here so the heartbeat runs at the
   * engine's fixed update rate (no React re-render churn on the audio path).
   *
   * Defensive: the player can be dead (HP = 0) — no heartbeat in that case
   * either (the death screen handles its own audio).
   */
  private tickHeartbeat() {
    const hp = this.ctx.player.health;
    if (hp <= 0 || hp >= 40) {
      // Reset the timer so the first beat fires immediately on dropping below 40.
      this.nextHeartbeatAt = 0;
      return;
    }
    const now = performance.now();
    if (now < this.nextHeartbeatAt) return;
    // Slow tier (15-40): 1000ms between beats. Fast tier (<15): 500ms.
    // The interval ramps continuously with HP so the beat visibly
    // accelerates as the player bleeds out (no abrupt tier jump).
    const intervalMs = hp < 15 ? 500 : 1000;
    this.nextHeartbeatAt = now + intervalMs;
    this.ctx.audio.heartbeat();
  }
}

declare global {
  interface Window {
    __PR_KILLSTREAK__?: {
      streak: number;
      best: number;
      reconReady: boolean;
      airstrikeReady: boolean;
      reconActive: boolean;
      reconRemainingMs: number;
    };
    __PR_NAMEPLATES__?: Array<{
      x: number; y: number; z: number;
      health: number; maxHealth: number;
      className: string; lastDamaged: number; recent: boolean;
    }>;
    __PR_CAMERA_BASIS__?: {
      pos: { x: number; y: number; z: number };
      forward: { x: number; y: number; z: number };
      right: { x: number; y: number; z: number };
      fov: number; aspect: number;
    };
    __PR_CROSSHAIR_STATE__?: {
      speed: number;
      recoil: number;
      aiming: boolean;
      airborne: boolean;
    };
    __PR_DAMAGE_DIR__?: {
      dir: number;
      time: number;
    };
    __PR_MINIMAP_DATA__?: {
      playerX: number;
      playerZ: number;
      playerYaw: number;
      blips: Array<{ x: number; z: number; kind: "enemy" | "objective" }>;
    };
    __PR_DAMAGE_NUMBERS__?: {
      items: Array<{
        id: number;
        x: number; y: number; z: number;
        damage: number;
        headshot: boolean;
        kill: boolean;
        time: number;
      }>;
    };
    __PR_LOADOUT_STRIP__?: {
      primary: string;
      secondary: string;
      melee: string;
      utility: string;
      active: 0 | 1 | 2 | 3;
      utilityCharges: number;
    };
  }
}

