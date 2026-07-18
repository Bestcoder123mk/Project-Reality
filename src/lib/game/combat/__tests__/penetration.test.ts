import { describe, it, expect } from "vitest";
import {
  MATERIAL_PENETRATION,
  getPenetration,
  penetrationTell,
  CATEGORY_PENETRATION_MULT,
  effectivePenetrationDepth,
  effectiveDamageFalloff,
  type MaterialPenetrationEntry,
} from "../penetration";

/**
 * Backlog §2 item 27 — Unit-test penetration.ts material thickness → exit
 * velocity curve.
 *
 * The module's API:
 *   - MATERIAL_PENETRATION[slug]         → { penetrationDepthM, damageFalloff, velocityFalloff, tell }
 *   - getPenetration(surface)            → entry (fallback: concrete)
 *   - effectivePenetrationDepth(surface, category) = base × category mult
 *   - effectiveDamageFalloff(surface, category) = base × retain mult (clamped to 1)
 *
 * Invariants tested:
 *   1. Every entry's depth is non-negative.
 *   2. Hard surfaces (concrete, brick, steel) have low depth; soft (foliage,
 *      glass) have high depth.
 *   3. Steel plate is fully impenetrable (depth = 0, falloffs = 0).
 *   4. Per-category multipliers compose correctly with the surface table.
 *   5. Snipers penetrate deeper than pistols for the same surface.
 */

const ALL_SLUGS = Object.keys(MATERIAL_PENETRATION) as Array<keyof typeof MATERIAL_PENETRATION>;

describe("MATERIAL_PENETRATION table integrity", () => {
  it("has all 10 expected material slugs", () => {
    expect(ALL_SLUGS.sort()).toEqual(
      [
        "brick", "concrete", "drywall", "earth", "foliage",
        "glass", "sandbag", "sheet_metal", "steel_plate", "wood",
      ].sort(),
    );
  });

  it("every entry has non-negative penetration depth", () => {
    for (const slug of ALL_SLUGS) {
      const e = MATERIAL_PENETRATION[slug];
      expect(e.penetrationDepthM).toBeGreaterThanOrEqual(0);
    }
  });

  it("every entry has damage + velocity falloff in [0, 1]", () => {
    for (const slug of ALL_SLUGS) {
      const e = MATERIAL_PENETRATION[slug];
      expect(e.damageFalloff).toBeGreaterThanOrEqual(0);
      expect(e.damageFalloff).toBeLessThanOrEqual(1);
      expect(e.velocityFalloff).toBeGreaterThanOrEqual(0);
      expect(e.velocityFalloff).toBeLessThanOrEqual(1);
    }
  });

  it("every entry has a non-empty tell (label + vfxSlug + audioSlug)", () => {
    for (const slug of ALL_SLUGS) {
      const t = MATERIAL_PENETRATION[slug].tell;
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.vfxSlug.length).toBeGreaterThan(0);
      expect(t.audioSlug.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});

describe("material thickness → exit velocity curve", () => {
  it("steel_plate is fully impenetrable (depth 0, all falloffs 0)", () => {
    const e = MATERIAL_PENETRATION.steel_plate;
    expect(e.penetrationDepthM).toBe(0);
    expect(e.damageFalloff).toBe(0);
    expect(e.velocityFalloff).toBe(0);
  });

  it("soft surfaces penetrate more than hard surfaces", () => {
    const soft: MaterialPenetrationEntry = MATERIAL_PENETRATION.foliage;
    const hard: MaterialPenetrationEntry = MATERIAL_PENETRATION.concrete;
    expect(soft.penetrationDepthM).toBeGreaterThan(hard.penetrationDepthM);
    expect(soft.velocityFalloff).toBeGreaterThan(hard.velocityFalloff);
    expect(soft.damageFalloff).toBeGreaterThan(hard.damageFalloff);
  });

  it("the depth ordering matches the design intent", () => {
    // foliage (0.80) > glass (0.50) > drywall (0.40) > wood (0.30) >
    // sheet_metal (0.12) > brick (0.10) > concrete (0.08) > earth (0.05) >
    // sandbag (0.02) > steel_plate (0.00).
    const expected = [
      ["foliage", 0.80],
      ["glass", 0.50],
      ["drywall", 0.40],
      ["wood", 0.30],
      ["sheet_metal", 0.12],
      ["brick", 0.10],
      ["concrete", 0.08],
      ["earth", 0.05],
      ["sandbag", 0.02],
      ["steel_plate", 0.00],
    ] as const;
    for (const [slug, expectedDepth] of expected) {
      expect(MATERIAL_PENETRATION[slug].penetrationDepthM).toBeCloseTo(expectedDepth, 6);
    }
  });

  it("the falloff ordering also matches (lighter falloff for soft surfaces)", () => {
    const soft = MATERIAL_PENETRATION.glass.damageFalloff;     // 0.95
    const wood = MATERIAL_PENETRATION.wood.damageFalloff;      // 0.70
    const metal = MATERIAL_PENETRATION.sheet_metal.damageFalloff; // 0.50
    const brick = MATERIAL_PENETRATION.brick.damageFalloff;    // 0.40
    const concrete = MATERIAL_PENETRATION.concrete.damageFalloff; // 0.35
    const sand = MATERIAL_PENETRATION.sandbag.damageFalloff;   // 0.05
    expect(soft).toBeGreaterThan(wood);
    expect(wood).toBeGreaterThan(metal);
    expect(metal).toBeGreaterThan(brick);
    expect(brick).toBeGreaterThan(concrete);
    expect(concrete).toBeGreaterThan(sand);
  });
});

describe("getPenetration accessor", () => {
  it("returns the matching entry for a known slug", () => {
    expect(getPenetration("wood")).toBe(MATERIAL_PENETRATION.wood);
  });

  it("falls back to concrete for unknown slugs", () => {
    expect(getPenetration("unobtainium")).toBe(MATERIAL_PENETRATION.concrete);
  });
});

describe("penetrationTell accessor", () => {
  it("returns the tell for a known surface", () => {
    const t = penetrationTell("sheet_metal");
    expect(t).toBe(MATERIAL_PENETRATION.sheet_metal.tell);
  });

  it("returns the concrete tell for unknown surfaces", () => {
    expect(penetrationTell("???")).toBe(MATERIAL_PENETRATION.concrete.tell);
  });
});

describe("per-category penetration multipliers", () => {
  it("has all six weapon categories", () => {
    expect(Object.keys(CATEGORY_PENETRATION_MULT).sort()).toEqual(
      ["LMG", "PISTOL", "RIFLE", "SHOTGUN", "SMG", "SNIPER"],
    );
  });

  it("sniper > LMG > rifle > SMG > pistol > shotgun (heavy rounds penetrate more)", () => {
    const s = CATEGORY_PENETRATION_MULT;
    expect(s.SNIPER).toBeGreaterThan(s.LMG);
    expect(s.LMG).toBeGreaterThan(s.RIFLE);
    expect(s.RIFLE).toBeGreaterThan(s.SMG);
    expect(s.SMG).toBeGreaterThan(s.PISTOL);
    expect(s.PISTOL).toBeGreaterThan(s.SHOTGUN);
  });

  it("effectivePenetrationDepth composes surface × category", () => {
    // wood=0.30 × sniper=1.30 = 0.39
    expect(effectivePenetrationDepth("wood", "SNIPER")).toBeCloseTo(0.39, 4);
    // concrete=0.08 × pistol=0.50 = 0.04
    expect(effectivePenetrationDepth("concrete", "PISTOL")).toBeCloseTo(0.04, 4);
    // steel_plate=0 × sniper=1.30 = 0
    expect(effectivePenetrationDepth("steel_plate", "SNIPER")).toBe(0);
  });

  it("unknown categories fall back to 1.0 (rifle baseline)", () => {
    expect(effectivePenetrationDepth("wood", "PLASMA_RIFLE")).toBeCloseTo(0.30, 4);
  });
});

describe("effectiveDamageFalloff", () => {
  it("returns 0 for steel_plate (impenetrable, regardless of category)", () => {
    expect(effectiveDamageFalloff("steel_plate", "SNIPER")).toBe(0);
    expect(effectiveDamageFalloff("steel_plate", "PISTOL")).toBe(0);
  });

  it("snipers retain more damage through a surface than pistols", () => {
    const sn = effectiveDamageFalloff("wood", "SNIPER");
    const ps = effectiveDamageFalloff("wood", "PISTOL");
    expect(sn).toBeGreaterThan(ps);
  });

  it("clamps the multiplier to 1.0 (no >100% damage through surfaces)", () => {
    // Foliage base = 0.98, sniper retain = 1.05 → 1.029 → clamp to 1.0.
    expect(effectiveDamageFalloff("foliage", "SNIPER")).toBeLessThanOrEqual(1.0);
    expect(effectiveDamageFalloff("foliage", "SNIPER")).toBeCloseTo(1.0, 2);
  });

  it("falls back to 1.0 retain mult for unknown categories (no clamp violation)", () => {
    const r = effectiveDamageFalloff("wood", "PLASMA_RIFLE");
    expect(r).toBeCloseTo(0.70, 4); // wood base × 1.0
  });
});
