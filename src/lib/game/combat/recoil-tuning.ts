/**
 * SEC5-COMBAT — Prompt 40: Data-driven recoil tuning pass.
 *
 * This module makes the existing `RECOIL_PATTERNS` (in RecoilSystem.ts) auditable
 * WITHOUT redesigning the patterns themselves. It provides:
 *
 *   1. `RECOIL_TUNING_NOTES` — a per-weapon designer note (1-2 sentences) explaining
 *      the design intent for each pattern. This is the "why", not the "what".
 *   2. `validateRecoilPatterns()` — scans all 30 patterns + flags outliers whose
 *      total recoil magnitude is >2x OR <0.5x the per-category average. Outliers
 *      are returned with a verdict ("over"|"under") + the magnitude delta.
 *   3. `getRecoilTuningReport()` — returns a per-category summary (avg magnitude,
 *      avg recovery, avg randomness, min/max) so designers can scan the catalog
 *      at a glance.
 *
 * Magnitude is defined as `Σ |point[0]| + |point[1]|` over the 30-shot pattern —
 * i.e. the total "kick energy" the player must counter over a full mag dump.
 * This is a coarse metric but it's the right shape: a flat-controllable SMG
 * has low magnitude, a hand-cannon has high magnitude, and an outlier is a
 * pattern that's been mis-tuned relative to its category siblings.
 *
 * Tone reference: see src/lib/game/DESIGN.md (tactical-mil-sim-leaning-arcade).
 */

import { RECOIL_PATTERNS } from "../systems/RecoilSystem";
import { WEAPONS, type WeaponType, type WeaponCategory } from "../store";

/** A single designer note for one weapon's recoil pattern. */
export interface RecoilTuningNote {
  /** Weapon slug. */
  slug: WeaponType;
  /** Category (mirrors WEAPONS[slug].category). */
  category: WeaponCategory;
  /** Designer intent — what the pattern is trying to express. */
  intent: string;
  /** Tuning lever the author used to differentiate this gun from its siblings. */
  tuningLever: "recovery" | "randomness" | "vertical_climb" | "horizontal_drift" | "per_shot_kick" | "sustained_climb";
  /** Author tag (who last owned this pattern). */
  author: string;
}

/**
 * Per-weapon designer notes. One entry per weapon in RECOIL_PATTERNS (30).
 * Read alongside the pattern points to understand the design intent.
 */
export const RECOIL_TUNING_NOTES: Record<WeaponType, RecoilTuningNote> = {
  // ── RIFLE ──
  ak74:    { slug: "ak74",    category: "RIFLE",  intent: "Stout vertical climb with progressive horizontal drift — the workhorse AK feel. Late shots pull down (compensation).", tuningLever: "horizontal_drift", author: "SEC1" },
  m4:      { slug: "m4",      category: "RIFLE",  intent: "Tighter than the AK-74. Linear vertical climb, minimal horizontal drift. Mid-tier carbine baseline.", tuningLever: "vertical_climb", author: "SEC5" },
  hk416:   { slug: "hk416",   category: "RIFLE",  intent: "Piston system runs flatter than the M4. Lowest vertical climb in the rifle class — rewards burst discipline.", tuningLever: "per_shot_kick", author: "SEC1" },
  famas:   { slug: "famas",   category: "RIFLE",  intent: "Bullpup high ROF — snappier vertical climb than the M4. Small mag punishes mag-dumping.", tuningLever: "vertical_climb", author: "SEC1" },
  aug:     { slug: "aug",     category: "RIFLE",  intent: "Bullpup smooth + controllable. Sits between the M4 and HK416 — premium but accessible.", tuningLever: "sustained_climb", author: "SEC1" },
  scarh:   { slug: "scarh",   category: "RIFLE",  intent: "7.62mm battle rifle — heavier kick per shot than 5.56mm rifles. Pattern rewards tapping.", tuningLever: "per_shot_kick", author: "SEC1" },
  galil:   { slug: "galil",   category: "RIFLE",  intent: "AK-derived 5.56mm. Stout vertical kick, slightly tighter than the AK-74.", tuningLever: "vertical_climb", author: "SEC1" },
  mk17:    { slug: "mk17",    category: "RIFLE",  intent: "Heavier 7.62mm battle rifle — similar to SCAR-H but stouter. Highest per-shot kick in the rifle class.", tuningLever: "per_shot_kick", author: "SEC1" },
  mk14:    { slug: "mk14",    category: "RIFLE",  intent: "Marksman 7.62mm — semi-auto feel with substantial kick per shot. Bridges AR and sniper.", tuningLever: "per_shot_kick", author: "SEC1" },

  // ── SMG ──
  mp7:     { slug: "mp7",     category: "SMG",    intent: "Compact PDW — soft per-shot kick, big mag. Low skill floor, ideal CQB.", tuningLever: "per_shot_kick", author: "SEC1" },
  p90:     { slug: "p90",     category: "SMG",    intent: "Bullpup 5.7mm — even softer than the MP7. Sustained pressure without recoil management.", tuningLever: "sustained_climb", author: "SEC1" },
  mp5:     { slug: "mp5",     category: "SMG",    intent: "9mm roller-delayed — very flat, easy to control. CQB gold standard baseline.", tuningLever: "vertical_climb", author: "SEC1" },
  ump45:   { slug: "ump45",   category: "SMG",    intent: ".45 ACP SMG — heavier per-shot kick than MP5, slower recovery. Trade mag size for damage.", tuningLever: "per_shot_kick", author: "SEC1" },
  vector:  { slug: "vector",  category: "SMG",    intent: "1200 RPM Super V — flat recoil mitigation, but climbs fast. Lowest per-shot kick in class.", tuningLever: "per_shot_kick", author: "SEC1" },
  pp90m1:  { slug: "pp90m1",  category: "SMG",    intent: "Russian 9x19mm helical-mag — similar to MP7 but with bigger mag. Relentless rate of fire.", tuningLever: "sustained_climb", author: "SEC1" },

  // ── PISTOL ──
  usp:     { slug: "usp",     category: "PISTOL", intent: "Suppressed 9mm — first-shot kick is the highest in the pattern (1.2 vertical), then settles. .45 ACP weight.", tuningLever: "per_shot_kick", author: "SEC5" },
  deagle:  { slug: "deagle",  category: "PISTOL", intent: ".50 AE hand-cannon — 2.0 first-shot kick. Two-shot kills, kicks like a mule.", tuningLever: "per_shot_kick", author: "SEC1" },
  glock18: { slug: "glock18", category: "PISTOL", intent: "Full-auto 9mm machine pistol — kicks hard per shot in rapid succession. Spray-and-pray backup.", tuningLever: "sustained_climb", author: "SEC1" },
  m1911:   { slug: "m1911",   category: "PISTOL", intent: ".45 ACP classic — 1.4 first-shot kick, substantial but recoverable. Seven authoritative rounds.", tuningLever: "per_shot_kick", author: "SEC1" },
  revolver:{ slug: "revolver",category: "PISTOL", intent: ".50 cal hand-cannon — Deagle-like but stouter (2.2 first-shot). Five rounds, each a stagger.", tuningLever: "per_shot_kick", author: "SEC1" },

  // ── SNIPER ──
  awp:     { slug: "awp",     category: "SNIPER", intent: ".338 Lapua — 3.0 first-shot kick, very tight randomness. One-shot decision.", tuningLever: "per_shot_kick", author: "SEC1" },
  scout:   { slug: "scout",   category: "SNIPER", intent: "Lightweight 7.62mm — 2.2 first-shot kick, faster cycle than the AWP. Marksman baseline.", tuningLever: "per_shot_kick", author: "SEC1" },
  kar98k:  { slug: "kar98k",  category: "SNIPER", intent: "Mauser 7.92mm — sharp bolt-action kick, slightly less than AWP. Classic WWII marksman feel.", tuningLever: "per_shot_kick", author: "SEC1" },
  l115a3:  { slug: "l115a3",  category: "SNIPER", intent: ".338 Lapua British sniper — heaviest kick in class (3.2 first-shot). Very tight randomness.", tuningLever: "per_shot_kick", author: "SEC1" },

  // ── SHOTGUN ──
  nova:    { slug: "nova",    category: "SHOTGUN",intent: "Pump-action 12-gauge — 2.5 first-shot kick, big randomness (0.70). Budget shotgun baseline.", tuningLever: "per_shot_kick", author: "SEC1" },
  m1014:   { slug: "m1014",   category: "SHOTGUN",intent: "Semi-auto 12-gauge — slightly less per-shot than Nova (gas system absorbs). Seven rapid shells.", tuningLever: "per_shot_kick", author: "SEC1" },
  spas12:  { slug: "spas12",  category: "SHOTGUN",intent: "Dual-mode 12-gauge — pump recoil like Nova, slightly stouter. Premium shotgun rewards control.", tuningLever: "per_shot_kick", author: "SEC5" },

  // ── LMG ──
  m249:    { slug: "m249",    category: "LMG",    intent: "5.56mm belt-fed SAW — strong initial vertical climb (heavy bolt + belt feed), then sustained controllable climb. Lower horizontal drift than rifles (7kg mass).", tuningLever: "sustained_climb", author: "SEC1" },
  rpk:     { slug: "rpk",     category: "LMG",    intent: "5.45mm squad auto — similar to M249 but slightly snappier per shot. Drum-fed.", tuningLever: "per_shot_kick", author: "SEC1" },
  mk48:    { slug: "mk48",    category: "LMG",    intent: "7.62mm GPMG — heavier than M249, more vertical climb. 100 rounds of belt-fed annihilation.", tuningLever: "vertical_climb", author: "SEC1" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Magnitude math
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the total recoil magnitude for a pattern.
 *
 * Magnitude = Σ (|x_i| + |y_i|) over all 30 points.
 *
 * This is the "total kick energy" the player must counter over a full mag dump.
 * It's a coarse metric — it can't tell a "tight vertical climb" pattern from a
 * "wide horizontal spray" pattern at equal magnitude — but it correctly identifies
 * patterns that are mis-tuned relative to their category siblings.
 */
export function computeRecoilMagnitude(slug: WeaponType): number {
  const pattern = RECOIL_PATTERNS[slug];
  if (!pattern) return 0;
  let sum = 0;
  for (const [x, y] of pattern.points) {
    sum += Math.abs(x) + Math.abs(y);
  }
  return sum;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface RecoilOutlier {
  slug: WeaponType;
  category: WeaponCategory;
  magnitude: number;
  categoryAverage: number;
  /** "over" = >2x average, "under" = <0.5x average. */
  verdict: "over" | "under";
  /** Ratio of this weapon's magnitude to the category average (e.g. 2.4 = 2.4x). */
  ratio: number;
  /** Designer note (from RECOIL_TUNING_NOTES). */
  intent: string;
}

export interface RecoilValidationResult {
  /** All outliers found (may be empty). */
  outliers: RecoilOutlier[];
  /** Per-category averages. */
  categoryAverages: Record<WeaponCategory, number>;
  /** Total weapons audited. */
  weaponCount: number;
  /** True if no outliers found. */
  ok: boolean;
}

/**
 * Validate every recoil pattern against its category average.
 *
 * An outlier is a weapon whose total magnitude is either:
 *   - >2.0× the category average (over-tuned — kicks too hard for its class)
 *   - <0.5× the category average (under-tuned — kicks too soft for its class)
 *
 * Outliers aren't necessarily bugs — a "premium marksman" weapon in the RIFLE
 * category (e.g. MK14) legitimately kicks harder than a 5.56mm carbine. The
 * validator flags these for designer review, not auto-correction.
 */
export function validateRecoilPatterns(): RecoilValidationResult {
  // Group weapons by category.
  const byCat: Record<WeaponCategory, WeaponType[]> = {
    RIFLE: [], SMG: [], PISTOL: [], SNIPER: [], SHOTGUN: [], LMG: [],
  };
  for (const slug of Object.keys(RECOIL_PATTERNS) as WeaponType[]) {
    const cat = WEAPONS[slug]?.category;
    if (!cat) continue;
    byCat[cat].push(slug);
  }

  // Compute per-category averages.
  const categoryAverages = {} as Record<WeaponCategory, number>;
  for (const cat of Object.keys(byCat) as WeaponCategory[]) {
    const slugs = byCat[cat];
    if (slugs.length === 0) {
      categoryAverages[cat] = 0;
      continue;
    }
    const total = slugs.reduce((acc, s) => acc + computeRecoilMagnitude(s), 0);
    categoryAverages[cat] = total / slugs.length;
  }

  // Flag outliers.
  const outliers: RecoilOutlier[] = [];
  for (const cat of Object.keys(byCat) as WeaponCategory[]) {
    const avg = categoryAverages[cat];
    if (avg <= 0) continue;
    for (const slug of byCat[cat]) {
      const mag = computeRecoilMagnitude(slug);
      const ratio = mag / avg;
      if (ratio > 2.0) {
        outliers.push({
          slug, category: cat, magnitude: mag, categoryAverage: avg,
          verdict: "over", ratio, intent: RECOIL_TUNING_NOTES[slug]?.intent ?? "",
        });
      } else if (ratio < 0.5) {
        outliers.push({
          slug, category: cat, magnitude: mag, categoryAverage: avg,
          verdict: "under", ratio, intent: RECOIL_TUNING_NOTES[slug]?.intent ?? "",
        });
      }
    }
  }

  return {
    outliers,
    categoryAverages,
    weaponCount: Object.keys(RECOIL_PATTERNS).length,
    ok: outliers.length === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning report
// ─────────────────────────────────────────────────────────────────────────────

export interface CategorySummary {
  category: WeaponCategory;
  weaponCount: number;
  /** Average total magnitude across the category. */
  avgMagnitude: number;
  /** Min/max magnitude in the category. */
  minMagnitude: number;
  maxMagnitude: number;
  /** Average recovery time (ms). */
  avgRecoveryMs: number;
  /** Average randomness. */
  avgRandomness: number;
  /** Weapon slug with the highest magnitude. */
  hardest: WeaponType;
  /** Weapon slug with the lowest magnitude. */
  softest: WeaponType;
}

export interface RecoilTuningReport {
  categories: CategorySummary[];
  /** Total weapons covered. */
  weaponCount: number;
  /** Outliers from validateRecoilPatterns(). */
  outliers: RecoilOutlier[];
}

/**
 * Get a per-category summary of the recoil catalog. Use for the gunsmith
 * dashboard, designer audit reports, or a CLI lint pass.
 */
export function getRecoilTuningReport(): RecoilTuningReport {
  const byCat: Record<WeaponCategory, WeaponType[]> = {
    RIFLE: [], SMG: [], PISTOL: [], SNIPER: [], SHOTGUN: [], LMG: [],
  };
  for (const slug of Object.keys(RECOIL_PATTERNS) as WeaponType[]) {
    const cat = WEAPONS[slug]?.category;
    if (!cat) continue;
    byCat[cat].push(slug);
  }

  const categories: CategorySummary[] = [];
  for (const cat of Object.keys(byCat) as WeaponCategory[]) {
    const slugs = byCat[cat];
    if (slugs.length === 0) continue;
    const mags = slugs.map((s) => computeRecoilMagnitude(s));
    const recovs = slugs.map((s) => RECOIL_PATTERNS[s].recoveryMs);
    const rands = slugs.map((s) => RECOIL_PATTERNS[s].randomness);
    const minMag = Math.min(...mags);
    const maxMag = Math.max(...mags);
    categories.push({
      category: cat,
      weaponCount: slugs.length,
      avgMagnitude: mags.reduce((a, b) => a + b, 0) / mags.length,
      minMagnitude: minMag,
      maxMagnitude: maxMag,
      avgRecoveryMs: recovs.reduce((a, b) => a + b, 0) / recovs.length,
      avgRandomness: rands.reduce((a, b) => a + b, 0) / rands.length,
      hardest: slugs[mags.indexOf(maxMag)],
      softest: slugs[mags.indexOf(minMag)],
    });
  }

  return {
    categories,
    weaponCount: Object.keys(RECOIL_PATTERNS).length,
    outliers: validateRecoilPatterns().outliers,
  };
}

/**
 * Convenience accessor: get the designer note for one weapon.
 */
export function getRecoilNote(slug: WeaponType): RecoilTuningNote | undefined {
  return RECOIL_TUNING_NOTES[slug];
}

// ─────────────────────────────────────────────────────────────────────────────
// §2 QA (backlog item 28) — Seeded per-weapon pattern generator.
//
// `RECOIL_PATTERNS` is a hand-authored table of fixed (x,y) offsets. The
// runtime RecoilSystem applies a per-shot randomization using `Math.random`,
// which makes the actual recoil path non-deterministic — fine in gameplay
// but a problem for gunsmith previews, automated visual regression, and
// any test that asserts "same weapon → same pattern".
//
// `generateRecoilPattern(slug, seed)` is the deterministic variant: it takes
// the weapon's base pattern + a seed and produces a fully-resolved (jitter
// applied) pattern that is byte-identical for the same (slug, seed) pair.
// The runtime RecoilSystem can opt into this when running in "preview mode"
// (gunsmith dot-plot) — gameplay still uses the Math.random path so the
// pattern stays lively in actual combat.
//
// The PRNG is mulberry32 (public domain, well-mixed, 32-bit state). It is
// deterministic across JS engines (no BigInt, no platform random).
// ─────────────────────────────────────────────────────────────────────────────

/** Seeded PRNG — mulberry32. Returns a function that produces floats in [0, 1). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GeneratedPattern {
  /** The weapon slug this pattern was generated for. */
  slug: WeaponType;
  /** The seed used. */
  seed: number;
  /** The fully-resolved 30-shot (x,y) pattern (jitter baked in). */
  points: [number, number][];
  /** The pattern's recovery (ms) and randomness factor (mirrored from base). */
  recoveryMs: number;
  randomness: number;
}

/**
 * Deterministically generate a fully-resolved recoil pattern for a weapon.
 *
 * Same (slug, seed) → byte-identical `points` array.
 * Different seeds → different jitter (the points array differs).
 *
 * The jitter follows the existing RecoilSystem convention: each axis of
 * each shot gets `±randomness * 0.5` of additional offset, drawn from the
 * seeded PRNG. The base pattern's deterministic shape is preserved — only
 * the per-shot random component is seeded.
 *
 * Returns `null` for unknown weapon slugs (mirrors RECOIL_PATTERNS lookup).
 */
export function generateRecoilPattern(slug: WeaponType, seed: number): GeneratedPattern | null {
  const base = RECOIL_PATTERNS[slug];
  if (!base) return null;
  const rng = makeRng(seed);
  const r = base.randomness;
  const points: [number, number][] = base.points.map(([x, y]) => {
    // Centered jitter in [-r/2, +r/2] per axis.
    const jx = (rng() - 0.5) * r;
    const jy = (rng() - 0.5) * r;
    return [x + jx, y + jy];
  });
  return {
    slug,
    seed,
    points,
    recoveryMs: base.recoveryMs,
    randomness: base.randomness,
  };
}
