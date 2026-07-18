import { describe, it, expect } from "vitest";
import {
  RECOIL_TUNING_NOTES,
  computeRecoilMagnitude,
  validateRecoilPatterns,
  getRecoilTuningReport,
  getRecoilNote,
  makeRng,
  generateRecoilPattern,
} from "../recoil-tuning";
import { RECOIL_PATTERNS } from "../../systems/RecoilSystem";
import type { WeaponType } from "../../store";

/**
 * Backlog §2 item 28 — Unit-test recoil-tuning.ts pattern generation
 * for determinism.
 *
 * The module ships hand-authored patterns in RECOIL_PATTERNS (consumed by
 * the runtime RecoilSystem via Math.random for jitter). For tests + the
 * gunsmith preview we need a deterministic variant — `generateRecoilPattern
 * (slug, seed)` (added in this same Task-2 pass).
 *
 * Invariants:
 *   1. Same seed → byte-identical pattern.
 *   2. Different seeds → different patterns (with very high probability).
 *   3. The seeded pattern preserves the base shape (sum of |x|+|y| differs
 *      from the base by at most 2× the per-shot randomness budget).
 *   4. The PRNG itself (mulberry32) is deterministic across engines.
 *   5. The static validator (validateRecoilPatterns) runs without throwing
 *      on the full 30-weapon catalog.
 */

const SAMPLE_SLUGS = Object.keys(RECOIL_PATTERNS) as WeaponType[];

describe("RECOIL_TUNING_NOTES covers every weapon in RECOIL_PATTERNS", () => {
  it("every pattern has a matching designer note", () => {
    for (const slug of SAMPLE_SLUGS) {
      const note = getRecoilNote(slug);
      expect(note, `missing designer note for ${slug}`).toBeDefined();
      expect(note!.intent.length).toBeGreaterThan(10);
      expect(["recovery", "randomness", "vertical_climb", "horizontal_drift", "per_shot_kick", "sustained_climb"])
        .toContain(note!.tuningLever);
    }
  });
});

describe("computeRecoilMagnitude", () => {
  it("returns 0 for an unknown slug", () => {
    // Cast to satisfy the WeaponType — the function should still handle it.
    expect(computeRecoilMagnitude("nonexistent" as unknown as WeaponType)).toBe(0);
  });

  it("equals Σ |x_i| + |y_i| over the 30-shot pattern", () => {
    for (const slug of SAMPLE_SLUGS) {
      const pattern = RECOIL_PATTERNS[slug];
      const expected = pattern.points.reduce(
        (acc, [x, y]) => acc + Math.abs(x) + Math.abs(y),
        0,
      );
      expect(computeRecoilMagnitude(slug)).toBeCloseTo(expected, 6);
    }
  });

  it("is positive for every real weapon (every pattern kicks)", () => {
    for (const slug of SAMPLE_SLUGS) {
      expect(computeRecoilMagnitude(slug)).toBeGreaterThan(0);
    }
  });
});

describe("makeRng (mulberry32) determinism", () => {
  it("returns the same sequence for the same seed", () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("returns a different sequence for different seeds", () => {
    const a = makeRng(1);
    const b = makeRng(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("produces floats in [0, 1)", () => {
    const rng = makeRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("handles seed = 0 without producing a degenerate sequence", () => {
    const rng = makeRng(0);
    const first = rng();
    const second = rng();
    expect(first).not.toBe(second);
    // Not all zeros
    const sample = Array.from({ length: 5 }, () => rng());
    expect(sample.some((v) => v > 0.01)).toBe(true);
  });
});

describe("generateRecoilPattern determinism (item 28 core)", () => {
  it("returns null for an unknown weapon slug", () => {
    expect(generateRecoilPattern("nonexistent" as unknown as WeaponType, 123)).toBeNull();
  });

  it("same seed → byte-identical pattern (deep equality)", () => {
    for (const slug of SAMPLE_SLUGS) {
      const a = generateRecoilPattern(slug, 12345);
      const b = generateRecoilPattern(slug, 12345);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.points).toEqual(b!.points);
      expect(a!.seed).toBe(b!.seed);
      expect(a!.recoveryMs).toBe(b!.recoveryMs);
    }
  });

  it("different seeds → different patterns (at least one point differs)", () => {
    for (const slug of SAMPLE_SLUGS) {
      const a = generateRecoilPattern(slug, 1);
      const b = generateRecoilPattern(slug, 999);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      // At least one of the 30 points must differ.
      const anyDiff = a!.points.some(([ax, ay], i) => {
        const [bx, by] = b!.points[i];
        return ax !== bx || ay !== by;
      });
      // For zero-randomness weapons this could theoretically be false,
      // but every weapon in the catalog has randomness > 0.
      expect(anyDiff, `${slug}: seed 1 vs 999 produced identical patterns`).toBe(true);
    }
  });

  it("preserves the base shape: seeded magnitude ≈ base magnitude (within ±2×randomness budget)", () => {
    // The jitter is ±r/2 per axis per shot. Over 30 shots × 2 axes = 60
    // samples, the worst-case drift is 60 * (r/2) = 30r. We allow 2× that
    // as headroom (random drift can't exceed r per axis per shot).
    for (const slug of SAMPLE_SLUGS) {
      const base = RECOIL_PATTERNS[slug];
      const seeded = generateRecoilPattern(slug, 12345);
      const baseMag = base.points.reduce((s, [x, y]) => s + Math.abs(x) + Math.abs(y), 0);
      const seededMag = seeded!.points.reduce((s, [x, y]) => s + Math.abs(x) + Math.abs(y), 0);
      const tolerance = 60 * base.randomness; // 2 axes × 30 shots × r/2 × 2 (headroom)
      expect(Math.abs(seededMag - baseMag)).toBeLessThan(tolerance + 0.001);
    }
  });

  it("returns the expected metadata (slug, seed, recoveryMs, randomness)", () => {
    const p = generateRecoilPattern("ak74", 42);
    expect(p).not.toBeNull();
    expect(p!.slug).toBe("ak74");
    expect(p!.seed).toBe(42);
    expect(p!.recoveryMs).toBe(RECOIL_PATTERNS.ak74.recoveryMs);
    expect(p!.randomness).toBe(RECOIL_PATTERNS.ak74.randomness);
    expect(p!.points.length).toBe(30);
  });

  it("seed = 0 works (no degenerate output)", () => {
    const p = generateRecoilPattern("m4", 0);
    expect(p).not.toBeNull();
    expect(p!.points.length).toBe(30);
    // Not all zeros — the base pattern's first shot is non-zero.
    expect(p!.points[0][0] + p!.points[0][1]).not.toBe(0);
  });
});

describe("validateRecoilPatterns (catalog sanity check)", () => {
  it("audits every weapon in RECOIL_PATTERNS", () => {
    const result = validateRecoilPatterns();
    expect(result.weaponCount).toBe(SAMPLE_SLUGS.length);
    expect(result.categoryAverages).toBeDefined();
    for (const cat of ["RIFLE", "SMG", "PISTOL", "SNIPER", "SHOTGUN", "LMG"] as const) {
      expect(result.categoryAverages[cat]).toBeGreaterThanOrEqual(0);
    }
  });

  it("outliers (if any) include the full metadata for designer review", () => {
    const result = validateRecoilPatterns();
    for (const o of result.outliers) {
      expect(o.slug).toBeDefined();
      expect(o.category).toBeDefined();
      expect(o.magnitude).toBeGreaterThan(0);
      expect(o.categoryAverage).toBeGreaterThanOrEqual(0);
      expect(["over", "under"]).toContain(o.verdict);
      expect(typeof o.intent).toBe("string");
      expect(o.ratio).toBeGreaterThan(0);
    }
  });
});

describe("getRecoilTuningReport", () => {
  it("returns a per-category summary covering every populated category", () => {
    const report = getRecoilTuningReport();
    expect(report.categories.length).toBeGreaterThan(0);
    expect(report.weaponCount).toBe(SAMPLE_SLUGS.length);
    for (const c of report.categories) {
      expect(c.weaponCount).toBeGreaterThan(0);
      expect(c.maxMagnitude).toBeGreaterThanOrEqual(c.minMagnitude);
      expect(c.avgMagnitude).toBeGreaterThanOrEqual(c.minMagnitude);
      expect(c.avgMagnitude).toBeLessThanOrEqual(c.maxMagnitude);
    }
  });
});
