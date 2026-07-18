/**
 * Section H — Frequency-dependent sound occlusion + diffraction.
 *
 * Section H prompt coverage: H_Audio_Immersion-00019/00030/00040/00042/00065/
 * 00092/04962/04986/04997 — distant gunfire per map, ambient wind per map,
 * city traffic per map (occluded behind buildings).
 *
 * The existing AudioSystem.ts implements `occlusionThickness` — sum of wall
 * thicknesses along a segment — and audio.ts's `occlusionParams` maps that
 * to a lowpass cutoff + gain reduction. This module extends that with:
 *
 *   • Frequency-dependent transmission loss — different wall materials
 *     (concrete, glass, wood, drywall, metal) have different absorption
 *     spectra. Concrete attenuates high frequencies heavily; glass passes
 *     highs but cuts lows; drywall is uniformly weak.
 *   • Diffraction shadowing — sound bends around corners. When the LOS is
 *     blocked but a near-corner is reachable within a short detour, the
 *     sound is muffled but not fully cut (perceptual: "around the corner").
 *   • Per-material transmission loss coefficients (low/mid/high) baked into
 *     a 3-band EQ on the occluded signal.
 *
 * The engine wraps a source AudioNode with a per-frequency EQ chain driven
 * by the material + thickness along the listener→source segment. Routes
 * through the SFX bus.
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";

/** Wall material — drives the absorption spectrum. */
export type WallMaterial =
  | "concrete"
  | "brick"
  | "glass"
  | "wood"
  | "drywall"
  | "metal"
  | "earth"
  | "foliage";

export interface MaterialTransmission {
  /** Per-band transmission loss in dB per meter (higher = more attenuation). */
  lowDbPerM: number;
  midDbPerM: number;
  highDbPerM: number;
  /** Cutoff frequency for the "high" band (Hz). */
  highCutoffHz: number;
}

export const MATERIAL_TRANSMISSION: Record<WallMaterial, MaterialTransmission> = {
  // Concrete — heavy, blocks everything but especially highs.
  concrete: { lowDbPerM: 4, midDbPerM: 12, highDbPerM: 25, highCutoffHz: 2000 },
  brick: { lowDbPerM: 3.5, midDbPerM: 10, highDbPerM: 22, highCutoffHz: 2000 },
  // Glass — passes highs, cuts lows (mass law).
  glass: { lowDbPerM: 8, midDbPerM: 5, highDbPerM: 4, highCutoffHz: 4000 },
  // Wood — moderate, fairly uniform.
  wood: { lowDbPerM: 4, midDbPerM: 7, highDbPerM: 10, highCutoffHz: 3000 },
  // Drywall — weak, near-uniform.
  drywall: { lowDbPerM: 2, midDbPerM: 4, highDbPerM: 7, highCutoffHz: 3000 },
  // Metal — thin sheets resonate; mid-band absorption is high.
  metal: { lowDbPerM: 3, midDbPerM: 14, highDbPerM: 8, highCutoffHz: 2500 },
  // Earth (sandbag berm) — heavy, blocks highs aggressively.
  earth: { lowDbPerM: 5, midDbPerM: 14, highDbPerM: 28, highCutoffHz: 1500 },
  // Foliage — minor attenuation, mostly highs.
  foliage: { lowDbPerM: 0.5, midDbPerM: 1.5, highDbPerM: 5, highCutoffHz: 4000 },
};

export interface OcclusionRay {
  /** Total thickness (m) of walls along the segment. */
  thickness: number;
  /** Material of the dominant wall (defaults to concrete). */
  material: WallMaterial;
  /** Number of walls the ray passes through. */
  wallCount: number;
  /** Diffraction detour distance (m, 0 = no detour). */
  diffractionDetour: number;
}

export interface OcclusionParams {
  /** Per-band gain reduction (linear, 0..1). */
  lowGain: number;
  midGain: number;
  highGain: number;
  /** Overall gain reduction (linear, 0..1). */
  overallGain: number;
  /** Whether the sound is occluded at all. */
  blocked: boolean;
}

/**
 * Compute occlusion parameters from a ray. The per-band gains are derived
 * from the material's transmission loss × thickness, with an additional
 * diffraction detour penalty (sounds bending around corners lose ~3dB per
 * meter of detour).
 */
export function computeOcclusion(ray: OcclusionRay): OcclusionParams {
  if (ray.thickness <= 0 && ray.diffractionDetour <= 0) {
    return { lowGain: 1, midGain: 1, highGain: 1, overallGain: 1, blocked: false };
  }
  const mat = MATERIAL_TRANSMISSION[ray.material];
  // Transmission loss per band (dB) = material × thickness.
  const lowDb = mat.lowDbPerM * ray.thickness;
  const midDb = mat.midDbPerM * ray.thickness;
  const highDb = mat.highDbPerM * ray.thickness;
  // Diffraction detour adds ~3dB per meter (independent of material).
  const diffDb = 3 * ray.diffractionDetour;
  const totalLow = lowDb + diffDb;
  const totalMid = midDb + diffDb;
  const totalHigh = highDb + diffDb;
  const toLin = (db: number) => Math.pow(10, -Math.max(0, db) / 20);
  return {
    lowGain: toLin(totalLow),
    midGain: toLin(totalMid),
    highGain: toLin(totalHigh),
    overallGain: toLin((totalLow + totalMid + totalHigh) / 3),
    blocked: true,
  };
}

export class SoundOcclusionEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  /** Cached ray probe (set by AudioSystem). */
  private rayProbe: ((from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => OcclusionRay | null) | null = null;

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  /**
   * Install (or detach) the occlusion ray probe. AudioSystem calls this at
   * construction time with a probe that raycasts against ctx.colliders and
   * returns the total wall thickness + dominant material + diffraction detour.
   */
  setRayProbe(probe: ((from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => OcclusionRay | null) | null): void {
    this.rayProbe = probe;
  }

  /**
   * Compute the occlusion params for a listener→source segment. When no
   * probe is installed (e.g. before AudioSystem is constructed), returns
   * unblocked.
   */
  getOcclusion(listener: { x: number; y: number; z: number }, source: { x: number; y: number; z: number }): OcclusionParams {
    if (!this.rayProbe) {
      return { lowGain: 1, midGain: 1, highGain: 1, overallGain: 1, blocked: false };
    }
    const ray = this.rayProbe(listener, source);
    if (!ray) {
      return { lowGain: 1, midGain: 1, highGain: 1, overallGain: 1, blocked: false };
    }
    return computeOcclusion(ray);
  }

  /**
   * Wrap a source AudioNode through a 3-band EQ chain that applies the
   * occlusion params. Returns the new output node (or the input if unblocked).
   *
   * The chain is: source → lowShelf → midPeak → highShelf → overallGain → target.
   */
  wrapSource(
    source: AudioNode,
    params: OcclusionParams,
    targetBus: AudioNode,
  ): AudioNode {
    if (!this.ctx) {
      try { source.connect(targetBus); } catch { /* noop */ }
      return source;
    }
    if (!params.blocked) {
      try { source.connect(targetBus); } catch { /* noop */ }
      return source;
    }
    const ctx = this.ctx;
    // Low shelf at 250Hz.
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 250;
    lowShelf.gain.value = 20 * Math.log10(Math.max(0.0001, params.lowGain));
    // Mid peak at 1kHz.
    const midPeak = ctx.createBiquadFilter();
    midPeak.type = "peaking";
    midPeak.frequency.value = 1000;
    midPeak.Q.value = 0.7;
    midPeak.gain.value = 20 * Math.log10(Math.max(0.0001, params.midGain));
    // High shelf at 4kHz.
    const highShelf = ctx.createBiquadFilter();
    highShelf.type = "highshelf";
    highShelf.frequency.value = 4000;
    highShelf.gain.value = 20 * Math.log10(Math.max(0.0001, params.highGain));
    // Overall gain.
    const overall = ctx.createGain();
    overall.gain.value = Math.max(0.0001, params.overallGain);
    try {
      source.connect(lowShelf);
      lowShelf.connect(midPeak);
      midPeak.connect(highShelf);
      highShelf.connect(overall);
      overall.connect(targetBus);
    } catch { /* noop */ }
    return overall;
  }

  dispose(): void {
    this.ctx = null;
    this.buses = null;
    this.rayProbe = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _occlusion: SoundOcclusionEngine | null = null;
export function getSoundOcclusionEngine(): SoundOcclusionEngine {
  if (!_occlusion) _occlusion = new SoundOcclusionEngine();
  return _occlusion;
}

/**
 * Heuristic: guess a wall material from a collider box's dimensions + name.
 * Used by AudioSystem to map collider geometry to a WallMaterial for the
 * occlusion ray probe. Concrete by default; wood for thin sheets; glass for
 * very thin boxes; metal for boxes with "metal"/"steel" in the name.
 */
export function guessWallMaterial(boxName: string, thicknessM: number): WallMaterial {
  const n = (boxName ?? "").toLowerCase();
  if (n.includes("glass")) return "glass";
  if (n.includes("wood") || n.includes("plank")) return "wood";
  if (n.includes("metal") || n.includes("steel") || n.includes("iron")) return "metal";
  if (n.includes("drywall") || n.includes("plaster")) return "drywall";
  if (n.includes("brick")) return "brick";
  if (n.includes("earth") || n.includes("sand")) return "earth";
  if (n.includes("foliage") || n.includes("bush") || n.includes("leaves")) return "foliage";
  // Thin sheets (<0.1m) are likely glass/drywall; thick (>0.3m) are concrete.
  if (thicknessM < 0.08) return "glass";
  if (thicknessM < 0.15) return "wood";
  return "concrete";
}
