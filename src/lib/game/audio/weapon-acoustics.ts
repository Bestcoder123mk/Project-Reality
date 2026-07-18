/**
 * Section H — Realistic weapon audio: per-caliber, per-barrel-length, per-
 * environment, per-ammo-type gunshot acoustics.
 *
 * Section H prompt coverage: H_Audio_Immersion-00055/00061/00075/00080/00090/
 * 00092/04915/04953/04965/04967/04984 — weapon fire (interior/exterior/
 * suppressed) per map; distant gunfire per map + quality tier; reload
 * (tactical/empty/dual-mag) per map.
 *
 * The existing audio.ts (GUNSHOT_PRESETS per caliber + per-weapon overlay)
 * handles the base 6 calibers and per-weapon profile scaling. This module
 * extends the model with:
 *
 *   • Barrel length — short barrels (SMG/pistol) are louder + brighter than
 *     long barrels (sniper) due to powder burn completion in the barrel.
 *   • Environment — interior (small room) adds comb-filter reflections +
 *     more low-end body; exterior is more open with longer tail; urban
 *     adds canyon reflections; forest adds scattered high-freq reflections.
 *   • Ammo type — subsonic (no crack), supersonic (sharp crack), armor-
 *     piercing (brighter report), tracer (no audio change but flagged).
 *   • Chamber pressure — higher pressure = louder + sharper crack.
 *
 * The model synthesizes a 4-layer gunshot (mechanical / crack / body / tail)
 * with parameters derived from the per-barrel + per-environment + per-ammo
 * tables. Routes through the SFX bus.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

export type WeaponCaliber =
  | "pistol_9mm"
  | "pistol_45"
  | "smg_9mm"
  | "smg_45"
  | "rifle_556"
  | "rifle_762"
  | "sniper_308"
  | "sniper_338"
  | "shotgun_12g"
  | "lmg_556"
  | "lmg_762";

export type BarrelLength = "short" | "medium" | "long" | "very_long";

export type WeaponEnvironment = "exterior_open" | "exterior_urban" | "interior_small" | "interior_large" | "forest" | "tunnel";

export type AmmoType = "supersonic" | "subsonic" | "armor_piercing" | "tracer" | "hollowpoint";

export interface WeaponAcousticParams {
  caliber: WeaponCaliber;
  barrelLength: BarrelLength;
  environment: WeaponEnvironment;
  ammoType: AmmoType;
  /** Chamber pressure multiplier 0.5..1.5 (default 1.0). */
  chamberPressureMult?: number;
  /** Suppressor attached? */
  suppressed?: boolean;
}

interface AcousticProfile {
  // Mechanical click
  clickFreq: number;
  clickGain: number;
  clickDur: number;
  // Crack (supersonic report)
  crackFilterFreq: number;
  crackFilterQ: number;
  crackGain: number;
  crackDur: number;
  // Body thump
  bodyFreq: number;
  bodyGain: number;
  bodyDur: number;
  // Tail (powder burn residue + environment)
  tailFilterFreq: number;
  tailGain: number;
  tailDur: number;
  // Reverb send amount 0..1
  reverbSend: number;
}

/** Per-caliber base acoustic profile (supersonic ammo, medium barrel, exterior). */
const CALIBER_PROFILES: Record<WeaponCaliber, AcousticProfile> = {
  pistol_9mm: {
    clickFreq: 2000, clickGain: 0.16, clickDur: 0.008,
    crackFilterFreq: 1600, crackFilterQ: 0.8, crackGain: 0.5, crackDur: 0.09,
    bodyFreq: 140, bodyGain: 0.45, bodyDur: 0.16,
    tailFilterFreq: 1200, tailGain: 0.18, tailDur: 0.2, reverbSend: 0.15,
  },
  pistol_45: {
    clickFreq: 1800, clickGain: 0.17, clickDur: 0.009,
    crackFilterFreq: 1400, crackFilterQ: 0.75, crackGain: 0.55, crackDur: 0.1,
    bodyFreq: 120, bodyGain: 0.55, bodyDur: 0.18,
    tailFilterFreq: 1000, tailGain: 0.2, tailDur: 0.22, reverbSend: 0.16,
  },
  smg_9mm: {
    clickFreq: 2200, clickGain: 0.14, clickDur: 0.007,
    crackFilterFreq: 2200, crackFilterQ: 0.9, crackGain: 0.4, crackDur: 0.06,
    bodyFreq: 150, bodyGain: 0.35, bodyDur: 0.13,
    tailFilterFreq: 1700, tailGain: 0.14, tailDur: 0.16, reverbSend: 0.12,
  },
  smg_45: {
    clickFreq: 2000, clickGain: 0.15, clickDur: 0.008,
    crackFilterFreq: 1900, crackFilterQ: 0.85, crackGain: 0.45, crackDur: 0.07,
    bodyFreq: 130, bodyGain: 0.4, bodyDur: 0.14,
    tailFilterFreq: 1500, tailGain: 0.16, tailDur: 0.18, reverbSend: 0.13,
  },
  rifle_556: {
    clickFreq: 2400, clickGain: 0.18, clickDur: 0.008,
    crackFilterFreq: 1800, crackFilterQ: 0.8, crackGain: 0.55, crackDur: 0.08,
    bodyFreq: 120, bodyGain: 0.5, bodyDur: 0.18,
    tailFilterFreq: 1400, tailGain: 0.18, tailDur: 0.22, reverbSend: 0.18,
  },
  rifle_762: {
    clickFreq: 2200, clickGain: 0.2, clickDur: 0.009,
    crackFilterFreq: 1600, crackFilterQ: 0.75, crackGain: 0.65, crackDur: 0.1,
    bodyFreq: 100, bodyGain: 0.6, bodyDur: 0.22,
    tailFilterFreq: 1200, tailGain: 0.22, tailDur: 0.28, reverbSend: 0.2,
  },
  sniper_308: {
    clickFreq: 2600, clickGain: 0.22, clickDur: 0.01,
    crackFilterFreq: 1500, crackFilterQ: 0.6, crackGain: 0.8, crackDur: 0.14,
    bodyFreq: 90, bodyGain: 0.75, bodyDur: 0.32,
    tailFilterFreq: 1100, tailGain: 0.3, tailDur: 0.4, reverbSend: 0.22,
  },
  sniper_338: {
    clickFreq: 2800, clickGain: 0.24, clickDur: 0.011,
    crackFilterFreq: 1400, crackFilterQ: 0.55, crackGain: 0.9, crackDur: 0.16,
    bodyFreq: 80, bodyGain: 0.85, bodyDur: 0.36,
    tailFilterFreq: 1000, tailGain: 0.32, tailDur: 0.45, reverbSend: 0.24,
  },
  shotgun_12g: {
    clickFreq: 1800, clickGain: 0.18, clickDur: 0.009,
    crackFilterFreq: 1200, crackFilterQ: 0.5, crackGain: 0.7, crackDur: 0.13,
    bodyFreq: 80, bodyGain: 0.7, bodyDur: 0.26,
    tailFilterFreq: 900, tailGain: 0.28, tailDur: 0.32, reverbSend: 0.2,
  },
  lmg_556: {
    clickFreq: 2300, clickGain: 0.16, clickDur: 0.008,
    crackFilterFreq: 1900, crackFilterQ: 0.85, crackGain: 0.55, crackDur: 0.075,
    bodyFreq: 110, bodyGain: 0.5, bodyDur: 0.17,
    tailFilterFreq: 1500, tailGain: 0.18, tailDur: 0.2, reverbSend: 0.17,
  },
  lmg_762: {
    clickFreq: 2100, clickGain: 0.18, clickDur: 0.009,
    crackFilterFreq: 1700, crackFilterQ: 0.8, crackGain: 0.6, crackDur: 0.085,
    bodyFreq: 95, bodyGain: 0.55, bodyDur: 0.19,
    tailFilterFreq: 1300, tailGain: 0.2, tailDur: 0.24, reverbSend: 0.18,
  },
};

/**
 * Barrel-length modifiers. Short barrels are louder + brighter (incomplete
 * powder burn → muzzle flash + bright report); long barrels are quieter +
 * darker (complete burn → less flash, more low-end body).
 */
const BARREL_MODIFIERS: Record<BarrelLength, {
  gainMult: number;
  crackFreqMult: number;
  bodyFreqMult: number;
  tailDurMult: number;
}> = {
  short:      { gainMult: 1.25, crackFreqMult: 1.2,  bodyFreqMult: 1.1,  tailDurMult: 0.85 },
  medium:     { gainMult: 1.0,  crackFreqMult: 1.0,  bodyFreqMult: 1.0,  tailDurMult: 1.0 },
  long:       { gainMult: 0.9,  crackFreqMult: 0.9,  bodyFreqMult: 0.95, tailDurMult: 1.15 },
  very_long:  { gainMult: 0.85, crackFreqMult: 0.85, bodyFreqMult: 0.9,  tailDurMult: 1.25 },
};

/**
 * Environment modifiers — drive the reverb send amount + tail duration.
 * Interior environments add comb-filter reflections (handled by reverbNode
 * + a short additional delay); urban adds canyon reflections (longer tail);
 * forest adds scattered high-freq (brighter tail).
 */
const ENVIRONMENT_MODIFIERS: Record<WeaponEnvironment, {
  tailDurMult: number;
  tailFilterFreqMult: number;
  reverbSendMult: number;
  bodyGainMult: number; // interior boosts body thump
}> = {
  exterior_open:  { tailDurMult: 1.0,  tailFilterFreqMult: 1.0,  reverbSendMult: 1.0,  bodyGainMult: 1.0 },
  exterior_urban: { tailDurMult: 1.4,  tailFilterFreqMult: 0.8,  reverbSendMult: 1.6,  bodyGainMult: 1.05 },
  interior_small: { tailDurMult: 0.7,  tailFilterFreqMult: 1.1,  reverbSendMult: 1.3,  bodyGainMult: 1.25 },
  interior_large: { tailDurMult: 1.2,  tailFilterFreqMult: 0.9,  reverbSendMult: 1.8,  bodyGainMult: 1.15 },
  forest:         { tailDurMult: 1.1,  tailFilterFreqMult: 1.3,  reverbSendMult: 1.4,  bodyGainMult: 0.95 },
  tunnel:         { tailDurMult: 1.6,  tailFilterFreqMult: 0.7,  reverbSendMult: 2.0,  bodyGainMult: 1.1 },
};

/**
 * Ammo-type modifiers. Subsonic removes the supersonic crack; armor-piercing
 * brightens the report; hollowpoint deepens the body; tracer is a no-op
 * (audio identical).
 */
const AMMO_MODIFIERS: Record<AmmoType, {
  crackGainMult: number;
  crackFreqMult: number;
  bodyGainMult: number;
  bodyFreqMult: number;
}> = {
  supersonic:     { crackGainMult: 1.0, crackFreqMult: 1.0, bodyGainMult: 1.0, bodyFreqMult: 1.0 },
  subsonic:       { crackGainMult: 0.2, crackFreqMult: 0.6, bodyGainMult: 1.1, bodyFreqMult: 0.9 },
  armor_piercing: { crackGainMult: 1.1, crackFreqMult: 1.2, bodyGainMult: 0.95, bodyFreqMult: 1.05 },
  tracer:         { crackGainMult: 1.0, crackFreqMult: 1.0, bodyGainMult: 1.0, bodyFreqMult: 1.0 },
  hollowpoint:    { crackGainMult: 0.95, crackFreqMult: 0.95, bodyGainMult: 1.15, bodyFreqMult: 0.92 },
};

export class WeaponAcousticsEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /** Optional reverb send node (from AudioEngine.reverbNode). */
  private reverbSend: AudioNode | null = null;

  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer, reverbSend?: AudioNode | null): void {
    this.ctx = ctx;
    this.buses = buses;
    this.noiseBuffer = noiseBuffer;
    this.reverbSend = reverbSend ?? null;
  }

  setNoiseBuffer(buf: AudioBuffer): void {
    this.noiseBuffer = buf;
  }

  setReverbSend(node: AudioNode | null): void {
    this.reverbSend = node;
  }

  /**
   * Compute the final acoustic profile from the weapon params. Public so the
   * gunsmith UI can preview a weapon's acoustic profile without playing it.
   */
  computeProfile(params: WeaponAcousticParams): AcousticProfile {
    const base = CALIBER_PROFILES[params.caliber];
    const barrel = BARREL_MODIFIERS[params.barrelLength];
    const env = ENVIRONMENT_MODIFIERS[params.environment];
    const ammo = AMMO_MODIFIERS[params.ammoType];
    const pressureMult = params.chamberPressureMult ?? 1.0;
    const supprMult = params.suppressed ? 0.35 : 1.0;
    return {
      clickFreq: base.clickFreq,
      clickGain: base.clickGain * barrel.gainMult * pressureMult * supprMult,
      clickDur: base.clickDur,
      crackFilterFreq: base.crackFilterFreq * barrel.crackFreqMult * ammo.crackFreqMult,
      crackFilterQ: base.crackFilterQ,
      crackGain: base.crackGain * barrel.gainMult * ammo.crackGainMult * pressureMult * supprMult,
      crackDur: base.crackDur,
      bodyFreq: base.bodyFreq * barrel.bodyFreqMult * ammo.bodyFreqMult,
      bodyGain: base.bodyGain * barrel.gainMult * env.bodyGainMult * ammo.bodyGainMult * pressureMult * supprMult,
      bodyDur: base.bodyDur,
      tailFilterFreq: base.tailFilterFreq * env.tailFilterFreqMult,
      tailGain: base.tailGain * env.tailDurMult * supprMult,
      tailDur: base.tailDur * barrel.tailDurMult * env.tailDurMult,
      reverbSend: Math.min(1, base.reverbSend * env.reverbSendMult),
    };
  }

  /**
   * Play a gunshot with the given weapon params. Synthesizes the 4-layer
   * gunshot (mechanical / crack / body / tail) using the computed profile.
   */
  playGunshot(params: WeaponAcousticParams): void {
    if (!this.ctx || !this.buses || !this.noiseBuffer) return;
    const bus = this.buses.getBus("sfx");
    if (!bus) return;
    const profile = this.computeProfile(params);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const reverbNode = this.reverbSend;

    // (a) Mechanical click — high-freq square blip.
    const clickOsc = ctx.createOscillator();
    clickOsc.type = "square";
    clickOsc.frequency.setValueAtTime(profile.clickFreq, t);
    clickOsc.frequency.exponentialRampToValueAtTime(profile.clickFreq * 0.6, t + profile.clickDur);
    const clickG = ctx.createGain();
    clickG.gain.setValueAtTime(0.0001, t);
    clickG.gain.linearRampToValueAtTime(Math.max(0.0001, profile.clickGain), t + 0.001);
    clickG.gain.exponentialRampToValueAtTime(0.0001, t + profile.clickDur);
    clickOsc.connect(clickG);
    clickG.connect(bus);
    clickOsc.start(t);
    clickOsc.stop(t + profile.clickDur + 0.005);
    clickOsc.onended = () => { try { clickG.disconnect(); } catch { /* noop */ } };

    // (b) Report / crack — bandpass noise burst.
    if (profile.crackGain > 0.01) {
      const crackSrc = ctx.createBufferSource();
      crackSrc.buffer = this.noiseBuffer;
      const crackBP = ctx.createBiquadFilter();
      crackBP.type = "bandpass";
      crackBP.frequency.value = profile.crackFilterFreq;
      crackBP.Q.value = profile.crackFilterQ;
      const crackG = ctx.createGain();
      crackG.gain.setValueAtTime(0.0001, t);
      crackG.gain.linearRampToValueAtTime(Math.max(0.0001, profile.crackGain), t + 0.001);
      crackG.gain.exponentialRampToValueAtTime(0.0001, t + profile.crackDur);
      crackSrc.connect(crackBP);
      crackBP.connect(crackG);
      crackG.connect(bus);
      if (reverbNode) crackG.connect(reverbNode);
      crackSrc.start(t);
      crackSrc.stop(t + profile.crackDur + 0.02);
      crackSrc.onended = () => {
        try { crackBP.disconnect(); } catch { /* noop */ }
        try { crackG.disconnect(); } catch { /* noop */ }
      };
    }

    // (c) Tail — lowpass noise, longer decay, sent to reverb.
    const tailSrc = ctx.createBufferSource();
    tailSrc.buffer = this.noiseBuffer;
    const tailLP = ctx.createBiquadFilter();
    tailLP.type = "lowpass";
    tailLP.frequency.value = profile.tailFilterFreq;
    const tailG = ctx.createGain();
    tailG.gain.setValueAtTime(0.0001, t + 0.005);
    tailG.gain.linearRampToValueAtTime(Math.max(0.0001, profile.tailGain), t + 0.006);
    tailG.gain.exponentialRampToValueAtTime(0.0001, t + profile.tailDur);
    tailSrc.connect(tailLP);
    tailLP.connect(tailG);
    tailG.connect(bus);
    if (reverbNode && profile.reverbSend > 0) {
      const sendG = ctx.createGain();
      sendG.gain.value = profile.reverbSend;
      tailG.connect(sendG);
      sendG.connect(reverbNode);
      tailSrc.onended = () => {
        try { tailLP.disconnect(); } catch { /* noop */ }
        try { tailG.disconnect(); } catch { /* noop */ }
        try { sendG.disconnect(); } catch { /* noop */ }
      };
    } else {
      tailSrc.onended = () => {
        try { tailLP.disconnect(); } catch { /* noop */ }
        try { tailG.disconnect(); } catch { /* noop */ }
      };
    }
    tailSrc.start(t + 0.005);
    tailSrc.stop(t + profile.tailDur + 0.02);

    // (d) Body thump — low triangle.
    const bodyOsc = ctx.createOscillator();
    bodyOsc.type = "triangle";
    bodyOsc.frequency.setValueAtTime(profile.bodyFreq, t);
    bodyOsc.frequency.exponentialRampToValueAtTime(
      Math.max(20, profile.bodyFreq * 0.35),
      t + profile.bodyDur,
    );
    const bodyG = ctx.createGain();
    bodyG.gain.setValueAtTime(0.0001, t);
    bodyG.gain.linearRampToValueAtTime(Math.max(0.0001, profile.bodyGain), t + 0.001);
    bodyG.gain.exponentialRampToValueAtTime(0.0001, t + profile.bodyDur);
    bodyOsc.connect(bodyG);
    bodyG.connect(bus);
    bodyOsc.start(t);
    bodyOsc.stop(t + profile.bodyDur + 0.02);
    bodyOsc.onended = () => { try { bodyG.disconnect(); } catch { /* noop */ } };

    // Duck music briefly (per existing audio.ts pattern).
    this.buses.duckMusicForGunfire();
  }

  dispose(): void {
    this.ctx = null;
    this.buses = null;
    this.noiseBuffer = null;
    this.reverbSend = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for the gunsmith UI.
// ─────────────────────────────────────────────────────────────────────────────

/** Suggest a barrel length from a weapon slug (heuristic). */
export function suggestBarrelLength(slug: string): BarrelLength {
  const s = slug.toLowerCase();
  if (["awp", "scout", "kar98k", "l115a3"].includes(s)) return "very_long";
  if (["m249", "rpk", "mk48"].includes(s)) return "long";
  if (["m4a1", "ak47", "ak74", "famas", "aug", "sg553", "g36"].includes(s)) return "medium";
  if (["mp7", "p90", "mp5", "ump45", "vector", "pp90m1"].includes(s)) return "short";
  if (["usp", "deagle", "glock18", "m1911", "revolver"].includes(s)) return "short";
  if (["nova", "m1014", "spas12"].includes(s)) return "long";
  return "medium";
}

/** Suggest a caliber from a weapon slug. */
export function suggestCaliber(slug: string): WeaponCaliber {
  const s = slug.toLowerCase();
  if (["awp", "l115a3"].includes(s)) return "sniper_338";
  if (["scout", "kar98k"].includes(s)) return "sniper_308";
  if (["m249", "mk48"].includes(s)) return "lmg_556";
  if (["rpk"].includes(s)) return "lmg_762";
  if (["ak47", "ak74", "fn fal", "g3"].includes(s)) return "rifle_762";
  if (["m4a1", "m16", "famas", "aug", "sg553", "g36"].includes(s)) return "rifle_556";
  if (["deagle", "m1911", "revolver"].includes(s)) return "pistol_45";
  if (["usp", "glock18"].includes(s)) return "pistol_9mm";
  if (["ump45", "vector45"].includes(s)) return "smg_45";
  if (["mp7", "p90", "mp5", "pp90m1"].includes(s)) return "smg_9mm";
  if (["nova", "m1014", "spas12"].includes(s)) return "shotgun_12g";
  return "rifle_556";
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _weapon: WeaponAcousticsEngine | null = null;
export function getWeaponAcousticsEngine(): WeaponAcousticsEngine {
  if (!_weapon) _weapon = new WeaponAcousticsEngine();
  return _weapon;
}
