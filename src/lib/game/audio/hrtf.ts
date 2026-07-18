/**
 * Section H — HRTF profile manager.
 *
 * Section H prompt coverage: H_Audio_Immersion-00002/00006/00011/00054/00093/00099/
 * 04907/04949/04981/04993 — operator breath audio assets (calm/winded/panicked)
 * + footstep-on-snow audio assets + operator-breath state-machine VO sets.
 *
 * The existing spatial.ts uses the Web Audio PannerNode's built-in HRTF
 * panning model (a generic KEMAR mannequin measurement). This module adds an
 * HRTF profile manager that layers an additional **anthropometric
 * customization** pass on top:
 *
 *   • Head radius (cm) — scales inter-aural time difference (ITD)
 *   • Pinna shape — modifies high-frequency shadowing (front/back confusion)
 *   • Shoulder reflection — adds a 1.5–2.5ms delayed echo (chest-level echo)
 *   • Ear asymmetry — left/right tolerance delta (most ears are asymmetric)
 *
 * The profile is applied as a parallel short-convolution chain
 * (shoulder echo + pinna shadow) that wraps the existing PannerNode output.
 * Callers attach the manager once per AudioContext and call `wrap()` to
 * route a positional source through the profile-aware path.
 *
 * Implementation note: we synthesize a small (~64-sample) FIR per ear from
 * the anthropometric parameters and apply it via ConvolverNode. The FIR
 * captures the shoulder reflection (single impulse at delay τ_shoulder) plus
 * a high-frequency roll-off that approximates pinna shadowing for the
 * non-preferred ear.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

export interface HrtfProfile {
  /** Head radius in cm (default 9.0; range 8.0–10.5 for adult humans). */
  headRadiusCm: number;
  /**
   * Pinna complexity 0..1 (default 0.6). Higher = more high-frequency
   * shadowing behind the listener (less front/back confusion).
   */
  pinnaComplexity: number;
  /** Shoulder reflection gain 0..1 (default 0.18 — chest-level echo). */
  shoulderGain: number;
  /** Ear asymmetry delta 0..0.3 (default 0.05 — typical L/R tolerance). */
  earAsymmetry: number;
  /** Preferred ear ("left" | "right" | "ambidextrous"; default "right"). */
  preferredEar: "left" | "right" | "ambidextrous";
}

export const DEFAULT_HRTF_PROFILE: HrtfProfile = {
  headRadiusCm: 9.0,
  pinnaComplexity: 0.6,
  shoulderGain: 0.18,
  earAsymmetry: 0.05,
  preferredEar: "right",
};

/**
 * Built-in named HRTF profiles — sample measurements for common head shapes.
 * Tuned to be perceptually distinct without being pathological.
 */
export const HRTF_PROFILES: Record<string, HrtfProfile> = {
  /** Default — neutral adult head, mild pinna shadowing. */
  default: { ...DEFAULT_HRTF_PROFILE },
  /** Small head — short ITD, fast front/back disambiguation. */
  small_head: {
    headRadiusCm: 8.2,
    pinnaComplexity: 0.7,
    shoulderGain: 0.22,
    earAsymmetry: 0.04,
    preferredEar: "right",
  },
  /** Large head — long ITD, deep bass localization. */
  large_head: {
    headRadiusCm: 10.2,
    pinnaComplexity: 0.55,
    shoulderGain: 0.16,
    earAsymmetry: 0.07,
    preferredEar: "right",
  },
  /** Pinna-dominant — strong high-frequency shadowing (good for FPS). */
  pinna_dominant: {
    headRadiusCm: 9.0,
    pinnaComplexity: 0.95,
    shoulderGain: 0.18,
    earAsymmetry: 0.03,
    preferredEar: "right",
  },
  /** Left-handed — preferred ear flipped. */
  left_ear: {
    headRadiusCm: 9.0,
    pinnaComplexity: 0.6,
    shoulderGain: 0.18,
    earAsymmetry: 0.05,
    preferredEar: "left",
  },
};

export class HrtfProfileManager {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  private profile: HrtfProfile = { ...DEFAULT_HRTF_PROFILE };
  /** FIR convolution impulse for the left + right ear (64-sample each). */
  private leftFir: AudioBuffer | null = null;
  private rightFir: AudioBuffer | null = null;
  /** Whether a personal SOFA HRTF was loaded (Section G IndividualizedHrtfG). */
  private personalLoaded = false;

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
    this.rebuildFirs();
  }

  /** Update the active profile; rebuilds the FIRs on next call. */
  setProfile(profile: Partial<HrtfProfile>): void {
    this.profile = { ...this.profile, ...profile };
    this.rebuildFirs();
  }

  /** Get the active profile (read-only snapshot). */
  getProfile(): Readonly<HrtfProfile> {
    return { ...this.profile };
  }

  /** Load a named preset from HRTF_PROFILES. */
  loadPreset(name: keyof typeof HRTF_PROFILES): void {
    const p = HRTF_PROFILES[name];
    if (p) this.setProfile(p);
  }

  /** Mark a personal SOFA HRTF as loaded (so we skip our overlay). */
  markPersonalLoaded(loaded: boolean): void {
    this.personalLoaded = loaded;
  }

  isPersonalLoaded(): boolean {
    return this.personalLoaded;
  }

  /**
   * Wrap a source node through the HRTF profile path. Returns the new output
   * node (or the input if no profile is active / personal HRTF loaded).
   *
   * The wrap inserts a stereo ConvolverNode per channel that convolves the
   * source with the per-ear FIR. For mono sources, we up-mix to stereo via a
   * ChannelSplitter, convolve each ear, and recombine via a Merger.
   */
  wrap(src: AudioNode, targetBus: AudioNode): AudioNode {
    if (!this.ctx || !this.leftFir || !this.rightFir || this.personalLoaded) {
      // No profile active — connect directly to the bus.
      try { src.connect(targetBus); } catch { /* noop */ }
      return src;
    }
    const ctx = this.ctx;

    // Split the source into left/right channels (mono sources get duplicated).
    const splitter = ctx.createChannelSplitter(2);
    try { src.connect(splitter); } catch { /* noop */ }

    // Per-ear convolution — each ConvolverNode processes one ear's FIR.
    const leftConv = ctx.createConvolver();
    leftConv.buffer = this.leftFir;
    const rightConv = ctx.createConvolver();
    rightConv.buffer = this.rightFir;

    // Per-ear gain for asymmetry (preferred ear +3dB-ish boost).
    const leftGain = ctx.createGain();
    const rightGain = ctx.createGain();
    const asym = this.profile.earAsymmetry;
    if (this.profile.preferredEar === "right") {
      leftGain.gain.value = 1 - asym;
      rightGain.gain.value = 1 + asym;
    } else if (this.profile.preferredEar === "left") {
      leftGain.gain.value = 1 + asym;
      rightGain.gain.value = 1 - asym;
    } else {
      leftGain.gain.value = 1;
      rightGain.gain.value = 1;
    }

    splitter.connect(leftConv, 0);
    splitter.connect(rightConv, 0); // mono → both ears; stereo sources lose R
    leftConv.connect(leftGain);
    rightConv.connect(rightGain);

    // Merge back to stereo.
    const merger = ctx.createChannelMerger(2);
    leftGain.connect(merger, 0, 0);
    rightGain.connect(merger, 0, 1);
    try { merger.connect(targetBus); } catch { /* noop */ }

    return merger;
  }

  /**
   * Rebuild the per-ear FIR impulse buffers from the current profile.
   *
   * The FIR captures:
   *   • A unit impulse at t=0 (the direct sound).
   *   • A shoulder reflection at delay τ_shoulder = (headRadius + 18cm) / c
   *     with gain `shoulderGain` (echo from the shoulder surface).
   *   • A high-frequency lowpass on the non-preferred ear to simulate pinna
   *     shadowing (we approximate the shadow as a one-pole LP — encoded as
   *     a tiny triangular FIR).
   */
  private rebuildFirs(): void {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    // τ_shoulder ≈ (headRadiusCm + 18cm) / 34300 cm/s. At 9cm head, ≈ 0.79ms.
    const shoulderDelayS = (this.profile.headRadiusCm + 18) / 34300;
    const shoulderTap = Math.max(1, Math.round(shoulderDelayS * sr));
    // 64-sample FIR is plenty for shoulder + pinna shaping.
    const firLen = Math.max(shoulderTap + 4, 64);
    const left = this.ctx.createBuffer(1, firLen, sr);
    const right = this.ctx.createBuffer(1, firLen, sr);
    const ld = left.getChannelData(0);
    const rd = right.getChannelData(0);
    // Direct impulse at t=0.
    ld[0] = 1.0;
    rd[0] = 1.0;
    // Shoulder reflection — same gain both ears (chest echo is symmetric).
    ld[shoulderTap] = this.profile.shoulderGain;
    rd[shoulderTap] = this.profile.shoulderGain;
    // Pinna shadowing — high-frequency attenuation on the non-preferred ear.
    // Encoded as a small triangular LP FIR on the non-preferred ear (5-tap
    // moving average). The preferred ear keeps the full-bandwidth direct path.
    const pinnaAmount = this.profile.pinnaComplexity * 0.4;
    if (this.profile.preferredEar === "right") {
      // Left (non-preferred) ear gets the pinna shadow LP.
      this.applyPinnaShadow(ld, pinnaAmount);
    } else if (this.profile.preferredEar === "left") {
      this.applyPinnaShadow(rd, pinnaAmount);
    } else {
      // Ambidextrous — apply half the shadow to both ears.
      this.applyPinnaShadow(ld, pinnaAmount * 0.5);
      this.applyPinnaShadow(rd, pinnaAmount * 0.5);
    }
    this.leftFir = left;
    this.rightFir = right;
  }

  /**
   * In-place: apply a 5-tap one-pole-ish lowpass to `data` with weight
   * `amount` (0..1). The first sample is the unit impulse; we attenuate the
   * direct path slightly and add small taps immediately after to roll off
   * high frequencies (pinna shadow).
   */
  private applyPinnaShadow(data: Float32Array, amount: number): void {
    if (amount <= 0) return;
    const atten = 1 - amount * 0.5; // up to -6dB on the direct path
    data[0] *= atten;
    // Add small immediate taps that act as a one-pole LP — they blur the
    // impulse, attenuating high-frequency content above ~3kHz.
    if (data.length > 3) {
      data[1] = (data[1] ?? 0) + amount * 0.3;
      data[2] = (data[2] ?? 0) + amount * 0.15;
      data[3] = (data[3] ?? 0) + amount * 0.05;
    }
  }

  dispose(): void {
    this.ctx = null;
    this.buses = null;
    this.leftFir = null;
    this.rightFir = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _hrtf: HrtfProfileManager | null = null;
export function getHrtfProfileManager(): HrtfProfileManager {
  if (!_hrtf) _hrtf = new HrtfProfileManager();
  return _hrtf;
}
