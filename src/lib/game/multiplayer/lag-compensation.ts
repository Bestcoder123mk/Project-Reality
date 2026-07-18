/**
 * G_Multiplayer_Netcode-00019: Server-side lag compensation (hit rewind).
 *
 * When client A fires at moving client B, A sees B where B was ~RTT/2 ago.
 * If the server validated the hit against B's *current* position, A would
 * miss every shot. Lag compensation rewinds the world to the shooter's
 * fire-time (server time - shooter's ping) and tests the hit at that state.
 *
 * `LagCompensator` keeps a per-entity ring buffer of (timestamp, transform,
 * hitbox) samples. `rewindAndHitTest(shooterId, fireTime, ray)` returns the
 * closest entity the ray hits at the rewound world state, plus the rewind
 * offset (so the server can sanity-check the offset against the shooter's
 * recent ping — too-big offsets mean the shooter is faking lag).
 *
 * Buffer is capped at `maxHistoryMs` (default 250 ms). Hitbox is an AABB;
 * headshot zone is the top `headRatio` of the box.
 */

export interface Transform { x: number; y: number; z: number; yaw: number; }
export interface Hitbox { hx: number; hy: number; hz: number; headRatio: number; }
export interface EntitySample { entityId: string; transform: Transform; hitbox: Hitbox; time: number; }
export interface Ray { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; maxDist: number; }

export interface HitResult {
  entityId: string;
  distance: number;
  headshot: boolean;
  /** ms the world was rewound from "now" to validate this hit. */
  rewindMs: number;
}
export interface LagCompensatorOptions {
  maxHistoryMs?: number;
  /** Reject hits where the rewind exceeds this (anti-fake-lag). Default 400. */
  maxRewindMs?: number;
  /** Reject hits whose rewind is > N× the shooter's recent ping. Default 1.5. */
  pingMultiplier?: number;
}

interface EntityHistory { samples: EntitySample[]; } // sorted ascending by time

const EPS = 1e-8;

export class LagCompensator {
  private opts: Required<LagCompensatorOptions>;
  private history = new Map<string, EntityHistory>();
  private recentPing = new Map<string, number>();

  constructor(opts: LagCompensatorOptions = {}) {
    this.opts = { maxHistoryMs: 250, maxRewindMs: 400, pingMultiplier: 1.5, ...opts };
  }

  recordPing(entityId: string, pingMs: number): void { this.recentPing.set(entityId, pingMs); }

  /** Push a fresh sample for an entity. Old samples past maxHistoryMs are dropped. */
  sample(s: EntitySample): void {
    let h = this.history.get(s.entityId);
    if (!h) { h = { samples: [] }; this.history.set(s.entityId, h); }
    h.samples.push(s);
    const cutoff = s.time - this.opts.maxHistoryMs;
    while (h.samples.length > 1 && h.samples[0].time < cutoff) h.samples.shift();
  }

  /** Rewind the world to `fireTime` (server-time) and ray-test every entity
   * the shooter could have hit. Returns the closest hit, or null if the
   * rewind is implausible (outside buffer window / > N× recent ping). */
  rewindAndHitTest(shooterId: string, fireTime: number, now: number, ray: Ray): HitResult | null {
    const rewindMs = now - fireTime;
    if (rewindMs < 0 || rewindMs > this.opts.maxRewindMs) return null;
    const ping = this.recentPing.get(shooterId);
    if (ping !== undefined && rewindMs > ping * this.opts.pingMultiplier) return null;
    let closest: HitResult | null = null;
    for (const [entityId, h] of this.history) {
      if (entityId === shooterId) continue;
      const sample = this.sampleAt(h, fireTime);
      if (!sample) continue;
      const hit = rayAabb(ray, sample);
      if (!hit || (closest && hit.distance >= closest.distance)) continue;
      closest = { entityId, distance: hit.distance, headshot: hit.headshot, rewindMs };
    }
    return closest;
  }

  private sampleAt(h: EntityHistory, time: number): EntitySample | null {
    const s = h.samples;
    if (s.length === 0) return null;
    if (time <= s[0].time) return s[0];
    if (time >= s[s.length - 1].time) return s[s.length - 1];
    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid].time <= time) lo = mid;
      else hi = mid;
    }
    const a = s[lo];
    const b = s[hi];
    const t = (time - a.time) / Math.max(1, b.time - a.time);
    return {
      entityId: a.entityId,
      time,
      transform: {
        x: a.transform.x + (b.transform.x - a.transform.x) * t,
        y: a.transform.y + (b.transform.y - a.transform.y) * t,
        z: a.transform.z + (b.transform.z - a.transform.z) * t,
        yaw: a.transform.yaw + (b.transform.yaw - a.transform.yaw) * t,
      },
      hitbox: a.hitbox,
    };
  }

  reset(): void { this.history.clear(); this.recentPing.clear(); }
}

/** Slab method ray-AABB test. Returns {distance, headshot} or null. */
function rayAabb(ray: Ray, s: EntitySample): { distance: number; headshot: boolean } | null {
  const { x, y, z } = s.transform;
  const { hx, hy, hz, headRatio } = s.hitbox;
  const minX = x - hx, maxX = x + hx;
  const minY = y - hy, maxY = y + hy;
  const minZ = z - hz, maxZ = z + hz;
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes: Array<[number, number, number, number]> = [
    [ray.ox, ray.dx, minX, maxX],
    [ray.oy, ray.dy, minY, maxY],
    [ray.oz, ray.dz, minZ, maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < EPS) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  const dist = tmin >= 0 ? tmin : tmax;
  if (dist < 0 || dist > ray.maxDist) return null;
  const hitY = ray.oy + ray.dy * dist;
  return { distance: dist, headshot: hitY >= maxY - hy * headRatio };
}
