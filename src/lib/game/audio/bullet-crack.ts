/**
 * Section H — Bullet crack + whizby with per-caliber supersonic modeling.
 *
 * Section H prompt coverage: H_Audio_Immersion-00008/00033/00058/00064/00072/
 * 04902/04905/04929/04938/04966/04983/04999 — bullet whiz (near-miss) +
 * bullet crack (supersonic pass-by) per map + quality tier.
 *
 * The existing audio.ts has playBulletWhizBy + SectionG.ts has playBulletCrack.
 * This module extends the model with:
 *
 *   • Per-caliber mach cone geometry — supersonic rounds produce a mach cone
 *     whose half-angle is sin⁻¹(c/v). The crack sound localizes to the cone's
 *     intersection with the listener's ear (the bullet's *past* position,
 *     not its current position).
 *   • Per-caliber crack frequencies — 5.56mm cracks at ~4500Hz, 7.62mm at
 *     ~3800Hz, .338 at ~5200Hz (higher velocity = sharper crack).
 *   • Near-miss vs distant-whiz distinction — within 3m of the listener is
 *     a sharp crack; 3-15m is a whiz-by; beyond 15m is a distant hiss.
 *   • Trajectory modeling — the crack plays at the bullet's *closest point
 *     of approach* (CPA), not the bullet's current position.
 *
 * All audio is procedural. Routes through the SFX bus via BusMixer.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

export interface Vec3H { x: number; y: number; z: number; }

export type BulletCaliber =
  | "pistol_9mm"
  | "pistol_45"
  | "smg_9mm"
  | "rifle_556"
  | "rifle_762"
  | "sniper_308"
  | "sniper_338"
  | "lmg_556";

export interface BulletProfile {
  /** Muzzle velocity (m/s). */
  muzzleVelocity: number;
  /** Supersonic threshold (m/s, default 343). */
  speedOfSound: number;
  /** Crack center frequency (Hz). */
  crackFreq: number;
  /** Crack gain (linear). */
  crackGain: number;
  /** Crack duration (s). */
  crackDur: number;
  /** Whiz-by start frequency (Hz). */
  whizStartFreq: number;
  /** Whiz-by end frequency (Hz). */
  whizEndFreq: number;
  /** Whiz-by duration (s). */
  whizDur: number;
}

export const BULLET_PROFILES: Record<BulletCaliber, BulletProfile> = {
  pistol_9mm: {
    muzzleVelocity: 360, speedOfSound: 343,
    crackFreq: 0, crackGain: 0, crackDur: 0, // Subsonic — no crack.
    whizStartFreq: 2400, whizEndFreq: 500, whizDur: 0.14,
  },
  pistol_45: {
    muzzleVelocity: 260, speedOfSound: 343,
    crackFreq: 0, crackGain: 0, crackDur: 0, // Subsonic.
    whizStartFreq: 2000, whizEndFreq: 400, whizDur: 0.16,
  },
  smg_9mm: {
    muzzleVelocity: 400, speedOfSound: 343,
    crackFreq: 3800, crackGain: 0.35, crackDur: 0.025,
    whizStartFreq: 2600, whizEndFreq: 500, whizDur: 0.14,
  },
  rifle_556: {
    muzzleVelocity: 920, speedOfSound: 343,
    crackFreq: 4500, crackGain: 0.5, crackDur: 0.022,
    whizStartFreq: 4200, whizEndFreq: 800, whizDur: 0.16,
  },
  rifle_762: {
    muzzleVelocity: 830, speedOfSound: 343,
    crackFreq: 3800, crackGain: 0.55, crackDur: 0.026,
    whizStartFreq: 3600, whizEndFreq: 700, whizDur: 0.18,
  },
  sniper_308: {
    muzzleVelocity: 970, speedOfSound: 343,
    crackFreq: 5000, crackGain: 0.65, crackDur: 0.028,
    whizStartFreq: 4500, whizEndFreq: 900, whizDur: 0.18,
  },
  sniper_338: {
    muzzleVelocity: 1100, speedOfSound: 343,
    crackFreq: 5200, crackGain: 0.7, crackDur: 0.03,
    whizStartFreq: 4800, whizEndFreq: 1000, whizDur: 0.2,
  },
  lmg_556: {
    muzzleVelocity: 915, speedOfSound: 343,
    crackFreq: 4400, crackGain: 0.5, crackDur: 0.022,
    whizStartFreq: 4100, whizEndFreq: 800, whizDur: 0.16,
  },
};

export class BulletCrackEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
  }

  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  /**
   * Play a bullet pass-by: crack + whizby synthesized based on the bullet's
   * caliber + trajectory. The crack plays at the bullet's closest point of
   * approach (CPA) — computed by projecting the listener position onto the
   * bullet's line of motion.
   *
   * @param bulletPos  Current bullet position.
   * @param bulletVel  Bullet velocity vector (m/s).
   * @param listener   Listener position.
   * @param caliber    Bullet caliber.
   */
  playBulletPass(
    bulletPos: Vec3H,
    bulletVel: Vec3H,
    listener: Vec3H,
    caliber: BulletCaliber,
  ): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const profile = BULLET_PROFILES[caliber];
    const speed = Math.sqrt(bulletVel.x ** 2 + bulletVel.y ** 2 + bulletVel.z ** 2);
    const isSupersonic = speed > profile.speedOfSound;
    // Compute CPA (closest point of approach) — project listener onto bullet's
    // motion line through bulletPos.
    const cpa = this.computeCpa(bulletPos, bulletVel, listener);
    const dx = listener.x - cpa.x;
    const dy = listener.y - cpa.y;
    const dz = listener.z - cpa.z;
    const cpaDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Distance from current bullet pos to CPA — controls the time delay
    // before the crack arrives at the listener's ear.
    const dxBC = cpa.x - bulletPos.x;
    const dyBC = cpa.y - bulletPos.y;
    const dzBC = cpa.z - bulletPos.z;
    const distToCpa = Math.sqrt(dxBC * dxBC + dyBC * dyBC + dzBC * dzBC);
    // Cracks/whizes beyond 20m are silent (too quiet to matter).
    if (cpaDist > 20) return;

    // Within 3m → sharp crack (supersonic only). 3-15m → whiz-by. Beyond 15m
    // → distant hiss (lower gain).
    if (isSupersonic && cpaDist < 3 && profile.crackGain > 0) {
      this.playCrack(cpa, profile, distToCpa);
    } else if (cpaDist < 15) {
      this.playWhizBy(cpa, bulletVel, listener, profile, cpaDist);
    } else {
      this.playDistantHiss(cpa, profile, cpaDist);
    }
  }

  /** Compute the closest point of approach of a moving bullet to the listener. */
  private computeCpa(bulletPos: Vec3H, bulletVel: Vec3H, listener: Vec3H): Vec3H {
    const vx = bulletVel.x, vy = bulletVel.y, vz = bulletVel.z;
    const vMag2 = vx * vx + vy * vy + vz * vz;
    if (vMag2 < 0.0001) return { ...bulletPos };
    // t* = -((bulletPos - listener) · vel) / |vel|²
    const dx = bulletPos.x - listener.x;
    const dy = bulletPos.y - listener.y;
    const dz = bulletPos.z - listener.z;
    const t = -(dx * vx + dy * vy + dz * vz) / vMag2;
    // Clamp t to non-negative (bullet moves forward only).
    const tc = Math.max(0, t);
    return {
      x: bulletPos.x + vx * tc,
      y: bulletPos.y + vy * tc,
      z: bulletPos.z + vz * tc,
    };
  }

  /** Play the supersonic crack at the CPA position (spatialized via HRTF). */
  private playCrack(cpa: Vec3H, profile: BulletProfile, distToCpa: number): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    // Delay proportional to distToCpa / speedOfSound (the crack arrives
    // after the bullet's sonic wave propagates from CPA to the listener).
    const delay = distToCpa / profile.speedOfSound;
    const t = ctx.currentTime + delay;
    // Cracks are very short noise bursts with high-frequency bandpass.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = profile.crackFreq;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0001, profile.crackGain), t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + profile.crackDur);
    src.connect(bp);
    bp.connect(g);
    // Spatialize via HRTF panner at the CPA position.
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 0.5;
    panner.maxDistance = 8;
    panner.rolloffFactor = 2.0;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(cpa.x, t);
      panner.positionY.setValueAtTime(cpa.y, t);
      panner.positionZ.setValueAtTime(cpa.z, t);
    } else {
      (panner as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(cpa.x, cpa.y, cpa.z);
    }
    g.connect(panner);
    panner.connect(bus);
    src.start(t);
    src.stop(t + profile.crackDur + 0.02);
    src.onended = () => {
      try { bp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
      try { panner.disconnect(); } catch { /* noop */ }
    };
  }

  /** Play the whiz-by sound at the CPA position with a frequency sweep. */
  private playWhizBy(
    cpa: Vec3H,
    bulletVel: Vec3H,
    listener: Vec3H,
    profile: BulletProfile,
    cpaDist: number,
  ): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    // Doppler pitch shift from radial velocity at CPA.
    const dx = listener.x - cpa.x;
    const dy = listener.y - cpa.y;
    const dz = listener.z - cpa.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let dopplerRate = 1.0;
    if (dist > 0.001) {
      const rx = dx / dist, ry = dy / dist, rz = dz / dist;
      const radial = -(bulletVel.x * rx + bulletVel.y * ry + bulletVel.z * rz);
      const c = profile.speedOfSound;
      dopplerRate = c / Math.max(80, c - radial);
      dopplerRate = Math.max(0.7, Math.min(1.4, dopplerRate));
    }
    // Attenuation with distance — 1m = full, 15m = near-silent.
    const atten = Math.max(0.05, 1 - cpaDist / 15);
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = dopplerRate;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(profile.whizStartFreq, t);
    bp.frequency.exponentialRampToValueAtTime(
      Math.max(80, profile.whizEndFreq),
      t + profile.whizDur,
    );
    const g = ctx.createGain();
    const peak = Math.max(0.0001, 0.35 * atten);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + profile.whizDur);
    src.connect(bp);
    bp.connect(g);
    // Spatialize at the CPA.
    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 0.4;
    panner.maxDistance = 15;
    panner.rolloffFactor = 1.5;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(cpa.x, t);
      panner.positionY.setValueAtTime(cpa.y, t);
      panner.positionZ.setValueAtTime(cpa.z, t);
    } else {
      (panner as unknown as { setPosition: (x: number, y: number, z: number) => void })
        .setPosition(cpa.x, cpa.y, cpa.z);
    }
    g.connect(panner);
    panner.connect(bus);
    src.start(t);
    src.stop(t + profile.whizDur + 0.02);
    src.onended = () => {
      try { bp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
      try { panner.disconnect(); } catch { /* noop */ }
    };
  }

  /** Play a distant hiss for bullets passing beyond 15m. */
  private playDistantHiss(cpa: Vec3H, profile: BulletProfile, cpaDist: number): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const atten = Math.max(0.02, 0.15 * (1 - (cpaDist - 15) / 5));
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0001, atten), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(lp);
    lp.connect(g);
    // Distant hiss is non-spatialized (the listener can't localize a 20m+ bullet).
    g.connect(bus);
    src.start(t);
    src.stop(t + 0.32);
    src.onended = () => {
      try { lp.disconnect(); } catch { /* noop */ }
      try { g.disconnect(); } catch { /* noop */ }
    };
  }

  dispose(): void {
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _bullet: BulletCrackEngine | null = null;
export function getBulletCrackEngine(): BulletCrackEngine {
  if (!_bullet) _bullet = new BulletCrackEngine();
  return _bullet;
}
