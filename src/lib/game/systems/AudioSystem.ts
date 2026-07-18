import * as THREE from "three";
import type { GameSystem, GameContext } from "./types";
import type { AudioEngine } from "../audio";
import type { Vec3 } from "../audio/spatial";
import { getAIDirector } from "../ai/director";
// G2 #140/#141/#142 — wire stingers, directional-hit cues, and grenade ticks.
import {
  MUSIC_STINGERS,
  pickDirectionalHitCue,
  grenadeTickInterval,
} from "../audio/AudioEnhancements";

// ─── G-5000 prompt mapping ──────────────────────────────────────────────────
// This file owns the wiring layer that connects AudioEnhancements tables +
// AudioEngine thickness probe to per-frame engine ticks.
//   #3410 → G2 #121 — binary occlusion → thickness-based   [constructor wires setOcclusionThicknessProbe → occlusionThickness() slab-method ray-AABB]
//   #3414 → G2 #125 — single global reverb → zone-based    [update() calls audio.updateReverbZones() per frame]
//   #3428 → G2 #139 — DUCKING_RULES table wired             [BusMixer.duckForTrigger consumed by VoEngine; this file's stinger/directional cues consult the same rules]
//   #3429 → G2 #140 — MUSIC_STINGERS played                 [updateStingers() per-frame; triggerStinger(type) public hook]
//   #3430 → G2 #141 — DIRECTIONAL_HIT_CUES played           [updateDirectionalHitCue() per-frame; reads player.lastDamageTime/dir]
//   #3431 → G2 #142 — grenadeTickInterval wired             [onGrenadeCookTick(remainingMs, totalMs) + onGrenadeCookEnd() public hooks]
//   #3540 → G  #827 — (cross-ref to #3450 — stingers: AudioSystem.triggerStinger is the call site)
//   #3541 → G  #828 — (cross-ref to #3451 — announcer: SectionG.ts AnnouncerSystemG; AudioSystem exposes ctx.audio.announcer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AudioSystem — thin wrapper that exposes AudioEngine methods to other systems
 * via the context. Most audio calls already go through ctx.audio directly;
 * this system is responsible for per-frame listener position sync.
 *
 * SEC8-AUDIO (prompts 61–70):
 *   • Per-frame HRTF listener position + orientation sync (61).
 *   • Line-of-sight occlusion raycast against ctx.colliders for any positional
 *     sound whose source is occluded from the listener (62).
 *   • Music intensity crossfade from the AI director's `intensity` label (70).
 */
export class AudioSystem implements GameSystem {
  // G2 #140 — stinger state. Tracks which stingers have fired this match
  //  so they don't repeat (e.g. last_alive fires once when the player becomes
  //  the last one; clutch fires once when the player kills the final enemy
  //  while below 25% HP).
  private stingerFired: Set<string> = new Set();
  /** Recent enemy-death timestamps (performance.now) for multikill detection. */
  private recentEnemyDeaths: number[] = [];
  /** Previous frame's alive enemy count — used to detect kills. */
  private prevAliveEnemies = 0;
  /** Previous frame's player HP — used to detect damage for directional cues. */
  private prevPlayerHp = 100;
  /** Previous frame's lastDamageTime — used to detect new damage events. */
  private prevDamageTime = 0;
  /** G2 #142 — grenade cook tick state. The GrenadeSystem calls
   *  onGrenadeCookTick() each frame while cooking; AudioSystem schedules the
   *  next tick sound based on grenadeTickInterval(). */
  private grenadeCookLastTickMs = 0;
  private grenadeCookActive = false;

  constructor(private ctx: GameContext) {
    // Wire the occlusion check into the AudioEngine so callers like
    // distantGunshot() / playSpatialFootstep() can ask "is the source blocked
    // from the listener?" without each re-implementing the raycast.
    const audioAny = this.ctx.audio as AudioEngine & {
      setOcclusionProbe?: (fn: ((from: Vec3, to: Vec3) => boolean) | null) => void;
      setOcclusionThicknessProbe?: (fn: ((from: Vec3, to: Vec3) => number) | null) => void;
    };
    if (typeof audioAny.setOcclusionProbe === "function") {
      audioAny.setOcclusionProbe((from, to) => this.isOccluded(from, to));
    }
    // G2 #121 — wire the thickness-aware occlusion probe so distantGunshot /
    // occludedFootstep / distantExplosion can drive a continuous lowpass +
    // gain-reduction curve (1m wall ≠ 5m wall) via occlusionLowpassHz +
    // occlusionGainReductionDb in AudioEnhancements.
    if (typeof audioAny.setOcclusionThicknessProbe === "function") {
      audioAny.setOcclusionThicknessProbe((from, to) => this.occlusionThickness(from, to));
    }
  }

  update(_dt: number) {
    const { ctx } = this;
    // Position — already pushed by AudioEngine.setListenerPos; keep that path
    // (some legacy callers write directly through ctx.audio.setListenerPos).
    ctx.audio.setListenerPos(ctx.player.pos.x, ctx.player.pos.y, ctx.player.pos.z);

    // Orientation — HRTF panning needs both position + orientation each frame.
    // (Prompt #61: required for true 3D HRTF; without it the PannerNode falls
    // back to a default forward vector and left/right cues are wrong.)
    const audio = ctx.audio as AudioEngine & {
      setListenerOrientation?: (yaw: number, pitch: number) => void;
      updateReverbZones?: () => void;
    };
    audio.setListenerOrientation?.(ctx.player.yaw, ctx.player.pitch);

    // G2 #125 — evaluate the reverb zone at the listener's position each
    // frame. Cheap when the zone hasn't changed (no-op inside updateReverbZones).
    audio.updateReverbZones?.();

    // G2 #140 — stinger triggers (multikill / clutch / last_alive).
    this.updateStingers();

    // G2 #141 — directional-hit cue on damage.
    this.updateDirectionalHitCue();

    // Adaptive music: drive the crossfade from the AI director's intensity
    // output when the director is initialized (Prompt #70). If the director
    // isn't running (headless / pre-match), fall back to a simple alive-enemy
    // heuristic so combat feels at least somewhat reactive.
    //
    // Section G note: the director emits a "LULL" label that the music engine
    // doesn't know about — we coerce it to "BREATH" (the closest equivalent
    // in the DirectorIntensityLabel union) before forwarding.
    const audioAny = ctx.audio as AudioEngine & {
      setMusicIntensityByDirector?: (i: "CALM" | "BUILDING" | "PEAK" | "BREATH") => void;
    };
    if (typeof audioAny.setMusicIntensityByDirector === "function") {
      const director = getAIDirector();
      const rawLabel = director ? director.getDecision().intensity : this.fallbackIntensity();
      const label: "CALM" | "BUILDING" | "PEAK" | "BREATH" =
        rawLabel === "LULL" ? "BREATH" : rawLabel;
      audioAny.setMusicIntensityByDirector(label);
    }

    // Section G (prompts 811–900) — per-frame update for sub-systems that
    // need it: wind-in-mic rumble, zone reverb re-evaluation, voice-chat
    // VAD, subtitle expiry. The wind speed comes from WeatherSystem when
    // available; otherwise we pass 0 (no rumble).
    const windSpeed = this.readWindSpeed();
    const sectionGAudio = ctx.audio as AudioEngine & {
      updateSectionG?: (windSpeed: number) => void;
    };
    sectionGAudio.updateSectionG?.(windSpeed);

    // Section H — per-frame update for sub-systems that need it: heartbeat
    // (BPM modulation), breathing (state machine tick), adaptive middleware
    // (cue expiry + hit-point intensity decay), ambient generator (listener
    // position sync for spatial ambient sources), and reverb zones (zone
    // re-evaluation). The heartbeat input is derived from player state.
    const sectionHAudio = ctx.audio as AudioEngine & {
      updateSectionH?: (opts: {
        heartbeatInput?: {
          health: number;
          recentDamageMs: number[];
          isSprinting: boolean;
          underFire: boolean;
          stamina: number;
          nowMs: number;
        };
      }) => void;
    };
    if (typeof sectionHAudio.updateSectionH === "function") {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const recentDamageMs = this.collectRecentDamageMs(now);
      sectionHAudio.updateSectionH({
        heartbeatInput: {
          health: ctx.player.health,
          recentDamageMs,
          isSprinting: !!ctx.player.sprinting,
          underFire: (ctx.player.suppression ?? 0) > 0.5,
          stamina: (ctx.player.stamina ?? 1),
          nowMs: now,
        },
      });
    }
  }

  /**
   * Section H — collect recent player-damage timestamps (last 5s) for the
   * heartbeat engine's hit-point intensity. The HudSystem already tracks
   * damage events; this is a best-effort read from ctx.player if available.
   * Returns an empty array when no damage-tracking field is present.
   */
  private collectRecentDamageMs(now: number): number[] {
    const player = this.ctx.player as typeof this.ctx.player & {
      damageEvents?: number[];
      lastDamageTime?: number;
    };
    if (Array.isArray(player.damageEvents)) {
      return player.damageEvents.filter((t) => now - t < 5000);
    }
    // Fallback: if lastDamageTime is recent, treat it as a single event.
    if (typeof player.lastDamageTime === "number") {
      const perfNow = typeof performance !== "undefined" ? performance.now() : Date.now();
      // lastDamageTime is on the AudioContext clock (seconds) — convert
      // approximately to a performance.now() timestamp if it's within 5s.
      if (perfNow - player.lastDamageTime * 1000 < 5000 && perfNow - player.lastDamageTime * 1000 > 0) {
        return [player.lastDamageTime * 1000];
      }
    }
    return [];
  }

  /** Read the current wind speed from WeatherSystem (if attached to the
   *  context). Returns 0 when the WeatherSystem isn't running (no rumble). */
  private readWindSpeed(): number {
    const ws = (this.ctx as unknown as { weather?: { windSpeed?: number } | (() => number) }).weather;
    if (!ws) return 0;
    if (typeof ws === "function") {
      try { return ws(); } catch { return 0; }
    }
    return typeof ws.windSpeed === "number" ? ws.windSpeed : 0;
  }

  /** Fallback music intensity label when the AI director isn't initialized
   *  (e.g. before the match starts or in headless contexts). Derives a coarse
   *  label from the alive enemy count so combat still cues the music. */
  private fallbackIntensity(): "CALM" | "BUILDING" | "PEAK" | "BREATH" {
    const n = this.ctx.enemies.filter((e) => e.alive).length;
    if (n === 0) return "CALM";
    if (n <= 3) return "BUILDING";
    return "PEAK";
  }

  /**
   * Line-of-sight occlusion check (Prompt #62).
   *
   * Casts a ray from `from` (typically the listener / camera) to `to` (the
   * sound source) and returns true if any of ctx.colliders' bounding boxes
   * intersect the segment strictly between the two endpoints. The check is
   * cheap (one ray vs. AABB per collider — at most a few dozen colliders).
   *
   * The endpoint surfaces are intentionally excluded (we don't want the
   * collider the player is standing on or the one the source is on to count
   * as "blocking" — those are surfaces, not walls).
   */
  isOccluded(from: Vec3, to: Vec3): boolean {
    const ctx = this.ctx;
    const colliders = ctx.colliders;
    if (!colliders || colliders.length === 0) return false;

    // Reusable scratch — _segDir / _segOrigin live on the AudioSystem instance
    // so we don't allocate per call. Allocated once at construction.
    const losOrigin = this._losOrigin;
    const losDir = this._losDir;
    losOrigin.set(from.x, from.y, from.z);
    const toV = this._tmpTo;
    toV.set(to.x, to.y, to.z);
    losDir.copy(toV).sub(losOrigin);
    const dist = losDir.length();
    if (dist < 0.001) return false;
    losDir.multiplyScalar(1 / dist);

    this._raycaster.set(losOrigin, losDir);
    this._raycaster.far = dist;

    for (let i = 0; i < colliders.length; i++) {
      const box = colliders[i].box;
      if (!box) continue;
      // Cheap reject: if either endpoint is inside the box, skip (surface the
      // listener/source is standing on shouldn't count as occlusion).
      if (box.containsPoint(losOrigin) || box.containsPoint(toV)) continue;
      const hit = this._raycaster.ray.intersectBox(box, this._losHit);
      if (hit) {
        const t = losOrigin.distanceTo(hit);
        // Strictly between the two endpoints (not at the source surface).
        if (t > 0.05 && t < dist - 0.05) return true;
      }
    }
    return false;
  }

  /**
   * G2 #121 — total wall thickness (m) along the segment from→to. Uses the
   * slab-method ray-AABB intersection to compute the entry and exit t-values
   * for each collider; the difference (t_exit - t_entry) is the thickness
   * through that box (in meters, since `losDir` is normalized). Summed across
   * all intersected colliders. Returns 0 when the segment is unobstructed.
   *
   * Used by AudioEngine.occlusionParams() to drive a continuous lowpass +
   * gain-reduction curve (via occlusionLowpassHz + occlusionGainReductionDb)
   * so a 1m wall attenuates less than a 5m wall (was: binary 350Hz cutoff).
   */
  occlusionThickness(from: Vec3, to: Vec3): number {
    const ctx = this.ctx;
    const colliders = ctx.colliders;
    if (!colliders || colliders.length === 0) return 0;

    const losOrigin = this._losOrigin;
    const losDir = this._losDir;
    losOrigin.set(from.x, from.y, from.z);
    const toV = this._tmpTo;
    toV.set(to.x, to.y, to.z);
    losDir.copy(toV).sub(losOrigin);
    const dist = losDir.length();
    if (dist < 0.001) return 0;
    losDir.multiplyScalar(1 / dist);

    let totalThickness = 0;
    for (let i = 0; i < colliders.length; i++) {
      const box = colliders[i].box;
      if (!box) continue;
      // Cheap reject: if either endpoint is inside the box, skip (surface the
      // listener/source is standing on shouldn't count as occlusion).
      if (box.containsPoint(losOrigin) || box.containsPoint(toV)) continue;
      // Slab method: for each axis, compute entry/exit t-values; the
      // intersection is [max(tmin_x, tmin_y, tmin_z), min(tmax_x, tmax_y, tmax_z)].
      let tmin = -Infinity, tmax = Infinity;
      const ox = losOrigin.x, oy = losOrigin.y, oz = losOrigin.z;
      const dx = losDir.x, dy = losDir.y, dz = losDir.z;
      const minx = box.min.x, miny = box.min.y, minz = box.min.z;
      const maxx = box.max.x, maxy = box.max.y, maxz = box.max.z;
      // X axis
      if (Math.abs(dx) < 1e-6) {
        if (ox < minx || ox > maxx) continue;
      } else {
        const t1 = (minx - ox) / dx, t2 = (maxx - ox) / dx;
        const tn = Math.min(t1, t2), tf = Math.max(t1, t2);
        if (tn > tmin) tmin = tn;
        if (tf < tmax) tmax = tf;
        if (tmin > tmax) continue;
      }
      // Y axis
      if (Math.abs(dy) < 1e-6) {
        if (oy < miny || oy > maxy) continue;
      } else {
        const t1 = (miny - oy) / dy, t2 = (maxy - oy) / dy;
        const tn = Math.min(t1, t2), tf = Math.max(t1, t2);
        if (tn > tmin) tmin = tn;
        if (tf < tmax) tmax = tf;
        if (tmin > tmax) continue;
      }
      // Z axis
      if (Math.abs(dz) < 1e-6) {
        if (oz < minz || oz > maxz) continue;
      } else {
        const t1 = (minz - oz) / dz, t2 = (maxz - oz) / dz;
        const tn = Math.min(t1, t2), tf = Math.max(t1, t2);
        if (tn > tmin) tmin = tn;
        if (tf < tmax) tmax = tf;
        if (tmin > tmax) continue;
      }
      // Strictly between the two endpoints (not at the source surface).
      if (tmax > 0.05 && tmin < dist - 0.05) {
        const entry = Math.max(0.05, tmin);
        const exit = Math.min(dist - 0.05, tmax);
        if (exit > entry) totalThickness += (exit - entry);
      }
    }
    return totalThickness;
  }

  /** Update listener orientation (yaw/pitch) — call when view changes externally. */
  setListenerOrientation(yaw: number, pitch: number) {
    const audio = this.ctx.audio as unknown as AudioEngine & { setListenerOrientation?: (yaw: number, pitch: number) => void };
    audio.setListenerOrientation?.(yaw, pitch);
  }

  /**
   * G2 #140 — evaluate stinger triggers each frame.
   *
   *  • multikill: 3+ enemies died within 2s → play stinger once per multikill
   *    event (resets after 3s of no kills).
   *  • clutch: player kills the final enemy while below 25% HP → play once.
   *  • last_alive: not auto-triggered (would need MP context); callers can
   *    invoke `triggerStinger("last_alive")` directly when the conditions
   *    arise (e.g. when a squadmate dies leaving the player last).
   *
   * Stingers fire at most once per match per type (Set tracking). Reset
   * externally by calling `resetStingers()` on round start.
   */
  private updateStingers(): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const aliveCount = this.ctx.enemies.filter((e) => e.alive).length;
    // Detect enemy deaths this frame.
    if (aliveCount < this.prevAliveEnemies) {
      const deaths = this.prevAliveEnemies - aliveCount;
      for (let i = 0; i < deaths; i++) this.recentEnemyDeaths.push(now);
    }
    this.prevAliveEnemies = aliveCount;
    // Trim recentDeaths to within the 2s window.
    this.recentEnemyDeaths = this.recentEnemyDeaths.filter((t) => now - t < 2000);
    // Multikill: 3+ kills in 2s → trigger once; suppress for 3s after firing.
    if (
      this.recentEnemyDeaths.length >= 3 &&
      !this.stingerFired.has("multikill_recent")
    ) {
      this.triggerStinger("multikill");
      this.stingerFired.add("multikill_recent");
      // Reset the recent-window flag after 3s so a new multikill can fire.
      setTimeout(() => this.stingerFired.delete("multikill_recent"), 3000);
    }
    // Clutch: final enemy of the wave just died AND player is below 25% HP.
    const hp = this.ctx.player.health;
    const wasFinalKill = aliveCount === 0 && this.prevAliveEnemies > 0;
    if (wasFinalKill && hp < 25 && hp > 0 && !this.stingerFired.has("clutch")) {
      this.triggerStinger("clutch");
      this.stingerFired.add("clutch");
    }
  }

  /** G2 #140 — manually trigger a stinger (callable from any system). */
  triggerStinger(type: keyof typeof MUSIC_STINGERS): void {
    const audio = this.ctx.audio as AudioEngine & {
      playMusicStinger?: (type: string) => void;
    };
    audio.playMusicStinger?.(type);
  }

  /** G2 #140 — reset stinger one-shot tracking (call on round start). */
  resetStingers(): void {
    this.stingerFired.clear();
    this.recentEnemyDeaths = [];
  }

  /**
   * G2 #141 — play a directional-hit cue when the player takes damage.
   *
   *  Detects new damage events via `player.lastDamageTime` changing. Computes
   *  the hit angle relative to the player's facing (`lastDamageDir - yaw`)
   *  and picks a directional cue (front / side_left / side_right / behind)
   *  via `pickDirectionalHitCue`. Plays it through the AudioEngine's spatial
   *  pass so the cue localizes to the hit direction.
   */
  private updateDirectionalHitCue(): void {
    const player = this.ctx.player;
    if (player.lastDamageTime !== this.prevDamageTime) {
      this.prevDamageTime = player.lastDamageTime;
      // Only fire on actual damage (HP decreased) — lastDamageTime may update
      // on armor-only hits which we still want to cue.
      if (player.health < this.prevPlayerHp) {
        // Angle relative to player facing. lastDamageDir is a world yaw; the
        // player's yaw is also world. The relative angle is the difference.
        let rel = player.lastDamageDir - player.yaw;
        // Normalize to [-π, π].
        while (rel > Math.PI) rel -= 2 * Math.PI;
        while (rel < -Math.PI) rel += 2 * Math.PI;
        const cueId = pickDirectionalHitCue(rel);
        // Play via the UI bus (cue is a non-spatial indicator like the hit
        // marker — directional information is carried by which cue plays,
        // not by the spatial position of the cue).
        const audio = this.ctx.audio as AudioEngine & {
          playUi?: (name: string) => void;
        };
        audio.playUi?.(cueId);
      }
    }
    this.prevPlayerHp = player.health;
  }

  /**
   * G2 #142 — grenade cook-off ticking. GrenadeSystem should call this each
   * frame while a grenade is cooking. The tick interval speeds up as the
   * fuse runs down (1000ms → 200ms over the fuse duration). Plays a UI tick
   * at each interval.
   *
   * @param remainingFuseMs  Remaining fuse time (ms).
   * @param totalFuseMs      Total fuse time (ms).
   */
  onGrenadeCookTick(remainingFuseMs: number, totalFuseMs: number): void {
    if (!this.grenadeCookActive) {
      this.grenadeCookActive = true;
      this.grenadeCookLastTickMs = 0;
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const interval = grenadeTickInterval(remainingFuseMs, totalFuseMs);
    if (this.grenadeCookLastTickMs === 0 || now - this.grenadeCookLastTickMs >= interval) {
      this.grenadeCookLastTickMs = now;
      const audio = this.ctx.audio as AudioEngine & {
        playUi?: (name: string) => void;
      };
      audio.playUi?.("tick");
    }
  }

  /** G2 #142 — signal that grenade cooking ended (resets tick state). */
  onGrenadeCookEnd(): void {
    this.grenadeCookActive = false;
    this.grenadeCookLastTickMs = 0;
  }

  dispose() {
    // Detach the occlusion probe so a disposed AudioSystem doesn't get called
    // back from a still-alive AudioEngine.
    const audioAny = this.ctx.audio as AudioEngine & {
      setOcclusionProbe?: (fn: ((from: Vec3, to: Vec3) => boolean) | null) => void;
    };
    if (typeof audioAny.setOcclusionProbe === "function") {
      audioAny.setOcclusionProbe(null);
    }
    this.ctx.audio.dispose();
  }

  // ── Scratch fields (allocated once at construction; reused per call to
  //    avoid per-frame allocations on the occlusion raycast hot path). ──
  private _losOrigin = new THREE.Vector3();
  private _losDir = new THREE.Vector3();
  private _losBox = new THREE.Box3();
  private _losHit = new THREE.Vector3();
  private _tmpTo = new THREE.Vector3();
  private _raycaster = new THREE.Raycaster();
}
