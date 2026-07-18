/**
 * Section C — Per-weapon recoil pattern randomization (anti-macro seed).
 *
 * A fixed recoil pattern is macro-friendly: a scripted compensator can
 * learn the pattern and apply the inverse pull, hitting the same point
 * of impact every magazine. This module seeds per-shot jitter from a
 * deterministic hash of (weaponId, seed, shotIndex) so that:
 *   1. The same (weapon, seed, shot) always yields the same recoil →
 *      server-side hit validation works (deterministic replay).
 *   2. Different matches (different seed) produce visibly different
 *      patterns → a macro that hard-codes one pattern fails next match.
 */

/** A single sample in a recoil pattern (vertical + horizontal offset). */
export interface RecoilSample {
  /** Shot index within the magazine (0-based). */
  shotIndex: number;
  /** Vertical kick in milliradians (+ = up). */
  verticalMrad: number;
  /** Horizontal drift in milliradians (+ = right). */
  horizontalMrad: number;
}

/** Per-weapon recoil tuning (base pattern characteristics). */
export interface WeaponRecoilConfig {
  /** Base vertical kick per shot (mrad). */
  verticalBase: number;
  /** Base horizontal wander amplitude (mrad). */
  horizontalAmplitude: number;
  /** Per-shot randomness factor 0..1. */
  randomness: number;
  /** Recoil recovery rate (mrad/s). */
  recoveryPerS: number;
  /** Cyclic fire rate (rounds/min) — drives sample count. */
  cyclicRpm: number;
}

/** Default recoil configs for a handful of weapon archetypes. */
export const WEAPON_RECOIL_CONFIG: Record<string, WeaponRecoilConfig> = {
  m4:        { verticalBase: 1.4, horizontalAmplitude: 0.4, randomness: 0.30, recoveryPerS: 8, cyclicRpm: 800 },
  ak74:      { verticalBase: 1.8, horizontalAmplitude: 0.6, randomness: 0.40, recoveryPerS: 7, cyclicRpm: 650 },
  scarh:     { verticalBase: 2.4, horizontalAmplitude: 0.5, randomness: 0.30, recoveryPerS: 6, cyclicRpm: 600 },
  mp5:       { verticalBase: 0.8, horizontalAmplitude: 0.3, randomness: 0.25, recoveryPerS: 10,cyclicRpm: 800 },
  awp:       { verticalBase: 6.0, horizontalAmplitude: 0.8, randomness: 0.20, recoveryPerS: 3, cyclicRpm: 40  },
  m1014:     { verticalBase: 4.0, horizontalAmplitude: 1.0, randomness: 0.50, recoveryPerS: 4, cyclicRpm: 240 },
};

// ─── Deterministic PRNG (FNV-1a hash + Mulberry32) ───────────────────────────

/** FNV-1a 32-bit string hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 — fast, well-distributed deterministic PRNG. */
function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Combine weaponId + seed into a per-weapon deterministic seed. */
export function hashWeaponSeed(weaponId: string, seed: number): number {
  return (fnv1a(weaponId) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
}

/**
 * Generate a full deterministic recoil pattern for one magazine of a
 * weapon. The pattern is stable for the same (weaponId, seed) pair, so
 * the server can re-derive it for hit validation; different seeds yield
 * visibly different patterns (anti-macro).
 *
 * @param weaponId   Weapon slug (e.g. "m4", "ak74").
 * @param seed       Match-wide seed (one per match, from the server).
 * @param shotCount  Number of shots to generate (default 30 = full mag).
 * @returns Array of RecoilSample, one per shot index.
 */
export function seededRecoilPattern(
  weaponId: string,
  seed: number,
  shotCount: number = 30,
): RecoilSample[] {
  const config = WEAPON_RECOIL_CONFIG[weaponId] ?? WEAPON_RECOIL_CONFIG.m4;
  const weaponSeed = hashWeaponSeed(weaponId, seed);
  const rng = makeSeededRng(weaponSeed);

  // Gaussian-ish (sum of two uniforms) for natural-looking jitter.
  const gauss = () => (rng() + rng() - 1) * 0.5;

  const samples: RecoilSample[] = [];
  for (let i = 0; i < shotCount; i++) {
    // Per-shot seed mixed in so successive shots differ.
    const shotSeed = (weaponSeed + Math.imul(i, 0x9e3779b1)) >>> 0;
    const shotRng = makeSeededRng(shotSeed);
    const shotGauss = () => (shotRng() + shotRng() - 1) * 0.5;

    // Vertical: base kick + accumulated climb (cyclic barrel rise) + jitter.
    const climb = config.verticalBase * (1 + i * 0.02);
    const verticalMrad = climb + shotGauss() * config.randomness * 0.5;

    // Horizontal: drift accumulates over a mag dump (barrel whip) + jitter.
    const driftAccum = 0.005 * i * (shotRng() > 0.5 ? 1 : -1);
    const horizontalMrad =
      gauss() * config.horizontalAmplitude +
      shotGauss() * config.randomness * 0.4 +
      driftAccum;

    samples.push({
      shotIndex: i,
      verticalMrad,
      horizontalMrad,
    });
  }
  return samples;
}

/** Generate a fresh match seed (called by the server at match start). */
export function generateMatchSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff)) >>> 0;
}
