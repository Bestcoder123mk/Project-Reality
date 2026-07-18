/**
 * Section F — Perception model tuning.
 *
 * Addresses Section F prompts for "realistic vision cones, hearing
 * thresholds, smell (for tracking)".
 *
 * The existing EnemySystem has a simple LOS check (`hasLOS` boolean) +
 * a fixed sight range (BASE_SIGHT_RANGE_M = 80, × 0.6 at night). This
 * module layers a richer perception model on top:
 *
 *   - **Vision cone**: enemies have a horizontal FOV (default 110°, narrower
 *     for snipers) + a vertical FOV (60°). Outside the cone, the enemy can't
 *     see the player even with clear LOS. Inside the cone, detection
 *     probability falls off with distance + illumination.
 *   - **Illumination**: at night, the vision range + cone shrink; muzzle
 *     flashes + the player's flashlight/laser momentarily boost detection.
 *   - **Hearing**: footsteps, gunshots, grenade explosions, glass breaking,
 *     doors opening all emit acoustic events. Each has a radius + a
 *     decibel-like loudness. The enemy "hears" the event if within radius,
 *     then turns toward it (curiosity) or moves to investigate.
 *   - **Smell (tracking)**: blood trails (player bleeding) leave scent
 *     markers; a "tracker" class (or any enemy with `canTrack=true`) can
 *     follow them up to N seconds after they were left. Simulates a dog
 *     / cyber-tracker following a wounded player.
 *   - **Detection meter**: per-enemy 0..1 detection scalar that fills
 *     when the player is in-cone + in-range + illuminated; decays when
 *     not. The FSM transitions IDLE→CHASE when the meter crosses a
 *     threshold (vs. the current instant-LOS gate). This gives the player
 *     a brief "I'm being seen" warning before the AI fully spots them.
 *
 * Pure-TS, SSR-safe. THREE is imported lazily in the spatial helpers.
 *
 * Integration:
 *   - EnemySystem calls `tickPerception(enemy, ctx)` per-frame for each
 *     alive enemy. The function updates the per-enemy detection meter
 *     (stashed via cast) + returns a PerceptionSnapshot.
 *   - The FSM tick reads the snapshot to drive the spotPlayer / losePlayer
 *     events (gated on the meter crossing threshold rather than raw LOS).
 *   - The acoustic + scent event queues are pushed by other systems
 *     (WeaponSystem for gunshots, MovementFeelSystem for footsteps, the
 *     damage system for blood trails).
 */

import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";
import type { EnemyClass } from "../EnemyClasses";

// ───────────────────────────────────────────────────────────────────────────
// Per-class perception profile
// ───────────────────────────────────────────────────────────────────────────

export interface PerceptionProfile {
  /** Horizontal field of view (degrees, total). Default 110. */
  fovHorizontalDeg: number;
  /** Vertical field of view (degrees, total). Default 60. */
  fovVerticalDeg: number;
  /** Maximum vision range (m). Default 80. */
  sightRangeM: number;
  /** Detection rate — how fast the detection meter fills when the player
   *  is in-cone + in-range (per second). Default 1.0 (1s to fully spot). */
  detectionRate: number;
  /** Decay rate — how fast the meter decays when the player is out of view
   *  (per second). Default 0.5 (2s to forget). */
  decayRate: number;
  /** Threshold at which the FSM fires spotPlayer (0..1). Default 0.7. */
  spotThreshold: number;
  /** Threshold below which the FSM fires losePlayer (0..1). Default 0.2. */
  loseThreshold: number;
  /** Hearing sensitivity multiplier (1.0 = baseline; 1.5 = enhanced
   *  hearing e.g. scout; 0.5 = hard-of-hearing e.g. zombie). */
  hearingMult: number;
  /** True if the enemy can track blood/scent trails. */
  canTrack: boolean;
  /** Night-vision multiplier on sightRangeM at night (1.0 = no penalty,
   *  0.6 = standard human, 1.2 = NVG-equipped). */
  nightSightMult: number;
  /** True if the enemy wears NVG / thermal (gives full night vision + can
   *  see through light foliage). */
  hasNightVision: boolean;
}

const DEFAULT_PROFILE: PerceptionProfile = {
  fovHorizontalDeg: 110,
  fovVerticalDeg: 60,
  sightRangeM: 80,
  detectionRate: 1.0,
  decayRate: 0.5,
  spotThreshold: 0.7,
  loseThreshold: 0.2,
  hearingMult: 1.0,
  canTrack: false,
  nightSightMult: 0.6,
  hasNightVision: false,
};

/** Per-class overrides — keyed by EnemyClass. */
const CLASS_PROFILES: Partial<Record<EnemyClass, Partial<PerceptionProfile>>> = {
  RIFLEMAN: {},
  SNIPER: {
    fovHorizontalDeg: 50,            // narrow focused FOV (looking through scope)
    sightRangeM: 120,                // can see further
    detectionRate: 0.8,              // slower to acquire (scoped)
    hasNightVision: true,            // sniper has NVG
    nightSightMult: 1.0,
  },
  MG: {
    fovHorizontalDeg: 90,
    sightRangeM: 60,
    detectionRate: 0.7,              // focused on suppression lane
  },
  CQB: {
    fovHorizontalDeg: 130,           // wide awareness for room-clearing
    sightRangeM: 35,
    detectionRate: 1.4,              // fast acquisition
    hearingMult: 1.2,
  },
  COMMANDER: {
    fovHorizontalDeg: 120,
    sightRangeM: 90,
    detectionRate: 1.1,
    hasNightVision: true,
    nightSightMult: 1.0,
  },
  ZOMBIE: {
    fovHorizontalDeg: 220,           // nearly all-around
    sightRangeM: 25,
    detectionRate: 1.6,
    decayRate: 0.1,                  // never forgets prey
    hearingMult: 1.8,                // very sensitive hearing
    canTrack: true,                  // can smell blood
  },
  MEDIC: {
    fovHorizontalDeg: 120,
    sightRangeM: 70,
    hearingMult: 1.1,
  },
  SHIELD: {
    fovHorizontalDeg: 90,            // shield blocks peripheral vision
    sightRangeM: 50,
    detectionRate: 0.8,
  },
  SCOUT: {
    fovHorizontalDeg: 140,
    sightRangeM: 100,
    detectionRate: 1.5,              // fast spotter
    hearingMult: 1.4,
    canTrack: true,                  // tracker class
  },
  SHOTGUNNER: {
    fovHorizontalDeg: 120,
    sightRangeM: 30,
    detectionRate: 1.3,
    hearingMult: 1.1,
  },
};

export function getPerceptionProfile(cls: EnemyClass | undefined): PerceptionProfile {
  if (!cls) return { ...DEFAULT_PROFILE };
  return { ...DEFAULT_PROFILE, ...(CLASS_PROFILES[cls] ?? {}) };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-enemy perception state (stashed via cast on the Enemy)
// ───────────────────────────────────────────────────────────────────────────

export interface PerceptionState {
  /** Detection meter 0..1. */
  meter: number;
  /** Last known player position (set when meter ≥ spotThreshold). */
  lkp: THREE.Vector3 | null;
  /** Timestamp the LKP was set (ms). */
  lkpAt: number;
  /** Last acoustic event the enemy noticed (for the curiosity turn). */
  lastHeard: { x: number; z: number; at: number; kind: AcousticKind } | null;
  /** Scent trail the enemy is currently following (oldest-first). */
  scentTrail: Array<{ x: number; z: number; at: number }>;
  /** Whether the player is currently in the enemy's vision cone. */
  inCone: boolean;
  /** Effective sight range this tick (after night + illumination mods). */
  effectiveSightM: number;
  /** True if the enemy was alerted this tick (heard something + turned). */
  alertedThisTick: boolean;
}

const PERCEPTION_KEY = Symbol("perception");

function ps(e: Enemy): PerceptionState {
  const ex = e as unknown as { [PERCEPTION_KEY]?: PerceptionState };
  if (!ex[PERCEPTION_KEY]) {
    ex[PERCEPTION_KEY] = {
      meter: 0,
      lkp: null,
      lkpAt: 0,
      lastHeard: null,
      scentTrail: [],
      inCone: false,
      effectiveSightM: 80,
      alertedThisTick: false,
    };
  }
  return ex[PERCEPTION_KEY]!;
}

/** Public read accessor — used by EnemySystem / FSM for the spotPlayer gate. */
export function getPerceptionState(e: Enemy): PerceptionState {
  return ps(e);
}

// ───────────────────────────────────────────────────────────────────────────
// Acoustic events
// ───────────────────────────────────────────────────────────────────────────

export type AcousticKind =
  | "footstep"
  | "gunshot"
  | "explosion"
  | "glass_break"
  | "door_open"
  | "door_kick"
  | "voice"
  | "reload"
  | "grenade_pin"
  | "vault"
  | "slide";

/** Acoustic event descriptor — pushed by the system that caused the sound. */
export interface AcousticEvent {
  /** World position of the source. */
  x: number;
  y: number;
  z: number;
  /** Kind — drives the radius + loudness. */
  kind: AcousticKind;
  /** Loudness 0..1 (1 = max audible). */
  loudness: number;
  /** performance.now() timestamp. */
  at: number;
}

/** Per-kind radius (m) at loudness=1.0. The actual radius scales linearly
 *  with loudness (a quiet footstep at loudness=0.3 reaches 0.3 × 6m = 1.8m). */
const ACOUSTIC_RADIUS: Record<AcousticKind, number> = {
  footstep: 8,
  gunshot: 60,
  explosion: 120,
  glass_break: 20,
  door_open: 10,
  door_kick: 15,
  voice: 30,
  reload: 12,
  grenade_pin: 8,
  vault: 10,
  slide: 6,
};

/** A queue of recent acoustic events. Capped; older events dropped. */
export class AcousticBus {
  private events: AcousticEvent[] = [];
  private cap: number;

  constructor(cap = 64) { this.cap = cap; }

  push(ev: AcousticEvent): void {
    this.events.push(ev);
    if (this.events.length > this.cap) this.events.shift();
  }

  /** Drain events newer than `sinceMs`. The caller processes them and
   *  discards them after (so each event is consumed by at most one tick). */
  drain(sinceMs: number): AcousticEvent[] {
    const out = this.events.filter((e) => e.at >= sinceMs);
    this.events = this.events.filter((e) => e.at < sinceMs);
    return out;
  }

  clear(): void { this.events = []; }
}

// ───────────────────────────────────────────────────────────────────────────
// Scent trail (blood drops from a wounded player)
// ───────────────────────────────────────────────────────────────────────────

export interface ScentMarker {
  x: number;
  z: number;
  at: number;
  /** Intensity 0..1 (more blood = stronger scent). */
  intensity: number;
}

export class ScentTrail {
  private markers: ScentMarker[] = [];
  private cap: number;
  /** How long a marker stays detectable (ms). */
  private ttlMs: number;

  constructor(cap = 32, ttlMs = 15_000) {
    this.cap = cap;
    this.ttlMs = ttlMs;
  }

  drop(x: number, z: number, intensity: number, at: number): void {
    this.markers.push({ x, z, at, intensity });
    if (this.markers.length > this.cap) this.markers.shift();
  }

  /** Get the freshest N markers newer than ttlMs. */
  fresh(at: number, max = 8): ScentMarker[] {
    return this.markers
      .filter((m) => at - m.at < this.ttlMs)
      .slice(-max);
  }

  clear(): void { this.markers = []; }
}

// ───────────────────────────────────────────────────────────────────────────
// Vision-cone check
// ───────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the target lies within the enemy's vision cone. The cone
 * is centered on the enemy's facing direction (yaw derived from group
 * rotation Y). Vertical FOV is applied if the target is significantly above
 * or below the enemy's eye height.
 *
 * Re-uses the scratch Vector3 to avoid per-call allocation.
 */
const _vTmp = new THREE.Vector3();
const _vForward = new THREE.Vector3();
const _vToTarget = new THREE.Vector3();

export function isInVisionCone(
  enemy: Enemy,
  target: THREE.Vector3,
  profile: PerceptionProfile,
): boolean {
  // Forward direction from the enemy's yaw.
  const yaw = enemy.group.rotation.y;
  _vForward.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
  _vToTarget.set(
    target.x - enemy.group.position.x,
    0,
    target.z - enemy.group.position.z,
  );
  const dist = _vToTarget.length();
  if (dist < 0.01) return true;
  _vToTarget.divideScalar(dist);
  const cosHoriz = _vToTarget.dot(_vForward);
  // cosHalfAngle: 1 = straight ahead, 0 = 90° to the side.
  const halfHoriz = THREE.MathUtils.degToRad(profile.fovHorizontalDeg / 2);
  if (cosHoriz < Math.cos(halfHoriz)) return false;
  // Vertical FOV check (only if the height delta is meaningful).
  const dy = target.y - (enemy.group.position.y + 1.6); // eye height ~1.6m
  if (Math.abs(dy) > 0.5) {
    const vertAngle = Math.atan2(Math.abs(dy), Math.max(0.01, dist));
    const halfVert = THREE.MathUtils.degToRad(profile.fovVerticalDeg / 2);
    if (vertAngle > halfVert) return false;
  }
  void _vTmp;
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Detection-meter tick
// ───────────────────────────────────────────────────────────────────────────

export interface PerceptionSnapshot {
  /** Whether the player is currently spotted (meter ≥ spotThreshold). */
  spotted: boolean;
  /** Whether the player was just lost (meter dropped below loseThreshold). */
  lost: boolean;
  /** Whether the enemy should turn to investigate a sound. */
  investigateTurn: { x: number; z: number } | null;
  /** Whether the enemy is currently tracking a scent trail. */
  trackingScent: boolean;
  /** The current detection meter (0..1) — for HUD awareness indicator. */
  meter: number;
}

/** Tick the perception model for one enemy. Returns a snapshot of decisions
 *  the FSM / tactics code should apply this frame. */
export function tickPerception(
  enemy: Enemy,
  ctx: GameContext,
  cls: EnemyClass | undefined,
  acousticBus: AcousticBus,
  scentTrail: ScentTrail,
  isNight: boolean,
  now: number = performance.now(),
  dt: number = 0.016,
): PerceptionSnapshot {
  const profile = getPerceptionProfile(cls);
  const state = ps(enemy);
  state.alertedThisTick = false;

  // ---------- Vision ----------
  const playerPos = ctx.player.pos;
  const eyePos = _vTmp.set(playerPos.x, playerPos.y + 1.6, playerPos.z);
  const dist = enemy.group.position.distanceTo(eyePos);
  // Effective sight range: base × night mult × (illumination modifier).
  let nightMult = 1.0;
  if (isNight) {
    nightMult = profile.hasNightVision ? 1.0 : profile.nightSightMult;
  }
  // Player illumination: muzzle flashes (recentlyFired), flashlight, laser.
  // For now we use a simple heuristic: if the player fired recently, they're
  // fully illuminated (muzzle flash). Otherwise ambient.
  const recentlyFired = now - (ctx.weapon.lastShotTime ?? 0) < 200;
  const illumination = recentlyFired ? 1.0 : (isNight ? 0.4 : 0.9);
  const effectiveSightM = profile.sightRangeM * nightMult * (0.6 + 0.4 * illumination);
  state.effectiveSightM = effectiveSightM;

  const inCone = isInVisionCone(enemy, eyePos, profile);
  state.inCone = inCone;

  let canSee = false;
  if (inCone && dist <= effectiveSightM) {
    // LOS check — re-use the existing env-raycast helper if available.
    canSee = hasClearLOS(enemy.group.position, eyePos, ctx);
  }

  if (canSee) {
    // Meter fills based on: distance (closer = faster), illumination, profile.
    const distFactor = 1.0 - clamp01(dist / Math.max(1, effectiveSightM));
    const fill = profile.detectionRate * dt * (0.5 + 0.5 * distFactor) * illumination;
    state.meter = clamp01(state.meter + fill);
    if (state.meter >= profile.spotThreshold && state.lkp === null) {
      state.lkp = eyePos.clone();
      state.lkpAt = now;
    } else if (state.meter >= profile.spotThreshold) {
      // Already spotted — keep refreshing the LKP.
      if (state.lkp) state.lkp.copy(eyePos);
      state.lkpAt = now;
    }
  } else {
    // Meter decays.
    state.meter = clamp01(state.meter - profile.decayRate * dt);
    if (state.meter < profile.loseThreshold && state.lkp) {
      state.lkp = null;
    }
  }

  // ---------- Hearing ----------
  // Drain acoustic events from the last ~200ms (one frame's worth).
  const heard = acousticBus.drain(now - 200);
  let investigateTurn: { x: number; z: number } | null = null;
  for (const ev of heard) {
    const radius = ACOUSTIC_RADIUS[ev.kind] * ev.loudness * profile.hearingMult;
    const dx = ev.x - enemy.group.position.x;
    const dz = ev.z - enemy.group.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= radius * radius) {
      // Heard it. If loud or close, the enemy turns to investigate.
      // Quiet footsteps only nudge a stationary enemy.
      const loudEnough = ev.loudness > 0.4 || ev.kind === "gunshot" || ev.kind === "explosion";
      if (loudEnough || (ev.loudness > 0.2 && state.meter < 0.3)) {
        investigateTurn = { x: ev.x, z: ev.z };
        state.lastHeard = { x: ev.x, z: ev.z, at: now, kind: ev.kind };
        state.alertedThisTick = true;
      }
      // A loud noise can bump the meter slightly (alertness).
      if (ev.kind === "gunshot" || ev.kind === "explosion") {
        state.meter = clamp01(state.meter + 0.1 * ev.loudness);
      }
      break; // one event per tick is enough.
    }
  }

  // ---------- Scent / tracking ----------
  let trackingScent = false;
  if (profile.canTrack) {
    const fresh = scentTrail.fresh(now, 4);
    if (fresh.length > 0) {
      // Find the nearest marker; if within detection radius, follow trail.
      let best: ScentMarker | null = null;
      let bestD = Infinity;
      for (const m of fresh) {
        const dx = m.x - enemy.group.position.x;
        const dz = m.z - enemy.group.position.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best && bestD < 100) { // 10m tracking radius.
        trackingScent = true;
        state.scentTrail = fresh.map((m) => ({ x: m.x, z: m.z, at: m.at }));
        // Scent bumps the meter (smelling the player).
        state.meter = clamp01(state.meter + 0.05);
      }
    }
  }

  // ---------- FSM decisions ----------
  const spotted = state.meter >= profile.spotThreshold && canSee;
  const lost = state.meter < profile.loseThreshold && state.lkp === null;

  return {
    spotted,
    lost,
    investigateTurn,
    trackingScent,
    meter: state.meter,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Cheap LOS check against ctx.colliders (AABB). Slab method.
 *  Returns true if no collider AABB blocks the segment origin→target. */
function hasClearLOS(origin: THREE.Vector3, target: THREE.Vector3, ctx: GameContext): boolean {
  // Re-use the shared raycaster if available; otherwise AABB slab.
  const dir = _vToTarget.set(target.x - origin.x, target.y - origin.y, target.z - origin.z);
  const dist = dir.length();
  if (dist < 0.01) return true;
  dir.divideScalar(dist);
  for (const c of ctx.colliders) {
    const box = c.box;
    // Slab method.
    let tmin = 0, tmax = dist;
    for (const ax of ["x", "y", "z"] as const) {
      const o = origin[ax];
      const d = dir[ax];
      const bmin = box.min[ax];
      const bmax = box.max[ax];
      if (Math.abs(d) < 1e-8) {
        if (o < bmin || o > bmax) { tmin = 1; tmax = 0; break; }
      } else {
        let t1 = (bmin - o) / d;
        let t2 = (bmax - o) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) break;
      }
    }
    if (tmin <= tmax) return false; // blocked.
  }
  return true;
}
