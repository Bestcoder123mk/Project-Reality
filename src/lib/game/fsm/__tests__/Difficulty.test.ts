import { describe, it, expect } from "vitest";
import {
  DIFFICULTY_CONFIGS,
  getDifficultyConfig,
  aiCanReact,
  aiEffectiveAccuracy,
  aiGrenadeAllowed,
  aiPickupDropMult,
  type Difficulty,
} from "../../Difficulty";

/**
 * Section D #496–500 — Difficulty scaling tests.
 *
 * Verifies the new insane tier + the AI scaling fields (reaction time,
 * hit chance, grenade frequency, coordination tier, pickup scarcity).
 */
describe("Section D #496–500 — Difficulty configs", () => {
  it("has four tiers: easy, normal, hard, insane", () => {
    expect(Object.keys(DIFFICULTY_CONFIGS).sort()).toEqual(
      ["easy", "hard", "insane", "normal"],
    );
  });

  it("easy has the slowest reaction time (800ms)", () => {
    expect(DIFFICULTY_CONFIGS.easy.reactionTimeMs).toBe(800);
  });

  it("insane has the fastest reaction time (100ms)", () => {
    expect(DIFFICULTY_CONFIGS.insane.reactionTimeMs).toBe(100);
  });

  it("reaction time scales monotonically: easy > normal > hard > insane", () => {
    const e = DIFFICULTY_CONFIGS.easy.reactionTimeMs;
    const n = DIFFICULTY_CONFIGS.normal.reactionTimeMs;
    const h = DIFFICULTY_CONFIGS.hard.reactionTimeMs;
    const i = DIFFICULTY_CONFIGS.insane.reactionTimeMs;
    expect(e).toBeGreaterThan(n);
    expect(n).toBeGreaterThan(h);
    expect(h).toBeGreaterThan(i);
  });

  it("hit chance scales: easy 0.40 < normal 0.60 < hard 0.75 < insane 0.85", () => {
    expect(DIFFICULTY_CONFIGS.easy.hitChance).toBe(0.40);
    expect(DIFFICULTY_CONFIGS.normal.hitChance).toBe(0.60);
    expect(DIFFICULTY_CONFIGS.hard.hitChance).toBe(0.75);
    expect(DIFFICULTY_CONFIGS.insane.hitChance).toBe(0.85);
  });

  it("grenade frequency scales: easy 0, normal 1, hard 3, insane 6", () => {
    expect(DIFFICULTY_CONFIGS.easy.grenadePerMatch).toBe(0);
    expect(DIFFICULTY_CONFIGS.normal.grenadePerMatch).toBe(1);
    expect(DIFFICULTY_CONFIGS.hard.grenadePerMatch).toBe(3);
    expect(DIFFICULTY_CONFIGS.insane.grenadePerMatch).toBe(6);
  });

  it("coordination tier scales: none → basic → flanking → synchronized", () => {
    expect(DIFFICULTY_CONFIGS.easy.coordination).toBe("none");
    expect(DIFFICULTY_CONFIGS.normal.coordination).toBe("basic");
    expect(DIFFICULTY_CONFIGS.hard.coordination).toBe("flanking");
    expect(DIFFICULTY_CONFIGS.insane.coordination).toBe("synchronized");
  });

  it("pickup scarcity scales: hard/insane get fewer pickups", () => {
    expect(DIFFICULTY_CONFIGS.easy.pickupScarcityMult).toBe(1.0);
    expect(DIFFICULTY_CONFIGS.normal.pickupScarcityMult).toBe(1.0);
    expect(DIFFICULTY_CONFIGS.hard.pickupScarcityMult).toBeLessThan(1.0);
    expect(DIFFICULTY_CONFIGS.insane.pickupScarcityMult).toBeLessThan(DIFFICULTY_CONFIGS.hard.pickupScarcityMult);
  });

  it("getDifficultyConfig falls back to normal for unknown tiers", () => {
    expect(getDifficultyConfig("unknown").name).toBe("Normal");
  });

  it("getDifficultyConfig returns the correct tier", () => {
    expect(getDifficultyConfig("insane").name).toBe("Insane");
  });
});

describe("Section D #496 — aiCanReact", () => {
  it("returns false before the reaction window elapses", () => {
    const cfg = DIFFICULTY_CONFIGS.easy; // 800ms
    expect(aiCanReact(cfg, 500)).toBe(false);
  });

  it("returns true after the reaction window elapses", () => {
    const cfg = DIFFICULTY_CONFIGS.easy; // 800ms
    expect(aiCanReact(cfg, 800)).toBe(true);
    expect(aiCanReact(cfg, 1000)).toBe(true);
  });

  it("insane reacts much faster than easy", () => {
    const easy = DIFFICULTY_CONFIGS.easy;
    const insane = DIFFICULTY_CONFIGS.insane;
    expect(aiCanReact(insane, 100)).toBe(true);
    expect(aiCanReact(easy, 100)).toBe(false);
  });
});

describe("Section D #497 — aiEffectiveAccuracy", () => {
  it("clamps the class accuracy to the difficulty hit-chance ceiling", () => {
    const easy = DIFFICULTY_CONFIGS.easy; // hitChance 0.40
    // Sniper base accuracy 0.85 — should be clamped to 0.40 on easy.
    expect(aiEffectiveAccuracy(easy, 0.85)).toBeCloseTo(0.40, 2);
  });

  it("does not exceed the difficulty hit-chance ceiling", () => {
    const hard = DIFFICULTY_CONFIGS.hard; // hitChance 0.75
    expect(aiEffectiveAccuracy(hard, 0.85)).toBeLessThanOrEqual(0.75);
  });

  it("scales by accuracyMult for low-accuracy classes", () => {
    const normal = DIFFICULTY_CONFIGS.normal; // accuracyMult 1.0, hitChance 0.60
    // MG base accuracy 0.35 — 0.35 * 1.0 = 0.35 (below ceiling).
    expect(aiEffectiveAccuracy(normal, 0.35)).toBeCloseTo(0.35, 2);
  });
});

describe("Section D #498 — aiGrenadeAllowed", () => {
  it("returns false on easy (cap 0)", () => {
    expect(aiGrenadeAllowed(DIFFICULTY_CONFIGS.easy, 0)).toBe(false);
  });

  it("returns true on normal until 1 throw, then false", () => {
    expect(aiGrenadeAllowed(DIFFICULTY_CONFIGS.normal, 0)).toBe(true);
    expect(aiGrenadeAllowed(DIFFICULTY_CONFIGS.normal, 1)).toBe(false);
  });

  it("returns true on insane until 6 throws", () => {
    expect(aiGrenadeAllowed(DIFFICULTY_CONFIGS.insane, 5)).toBe(true);
    expect(aiGrenadeAllowed(DIFFICULTY_CONFIGS.insane, 6)).toBe(false);
  });
});

describe("Section D #500 — aiPickupDropMult", () => {
  it("returns 1.0 on easy/normal (full pickups)", () => {
    expect(aiPickupDropMult(DIFFICULTY_CONFIGS.easy)).toBe(1.0);
    expect(aiPickupDropMult(DIFFICULTY_CONFIGS.normal)).toBe(1.0);
  });

  it("returns < 1.0 on hard/insane (scarcer pickups)", () => {
    expect(aiPickupDropMult(DIFFICULTY_CONFIGS.hard)).toBeLessThan(1.0);
    expect(aiPickupDropMult(DIFFICULTY_CONFIGS.insane)).toBeLessThan(1.0);
  });
});
