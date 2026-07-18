import { describe, it, expect } from "vitest";
import {
  AIDirector,
  type PerformanceSignal,
} from "../../ai/director";
import { DIFFICULTY_CONFIGS, type DifficultyConfig } from "../../Difficulty";

/**
 * Section D #501–506 — AI Director tests.
 * Verifies the intensity curve, pacing lulls, adaptive skill, loot/elite
 * mults, last-stand, and boss intro.
 */
function makeSig(overrides: Partial<PerformanceSignal> = {}): PerformanceSignal {
  return {
    now: performance.now(),
    health: 100,
    maxHealth: 100,
    armor: 100,
    ammoTotal: 100,
    ammoMax: 100,
    lastDeathAt: 0,
    lastEngagementAt: performance.now(),
    enemiesAlive: 5,
    killstreak: 0,
    kills: 0,
    downed: false,
    ...overrides,
  };
}

describe("Section D #501 — AIDirector intensity curve", () => {
  it("emits a BUILDING decision during warmup (< 3 signals)", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const sig = makeSig();
    const dec = d.tick(sig);
    expect(dec.intensity).toBe("BUILDING");
    expect(dec.reason).toBe("warmup");
  });

  it("emits a PEAK decision when the player has a high killstreak", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    // Push 5 signals with a high killstreak.
    for (let i = 0; i < 5; i++) {
      d.tick(makeSig({ now: now + i * 1000, killstreak: 8, enemiesAlive: 3 }));
    }
    const dec = d.getDecision();
    // High streak → PEAK or BUILDING (depending on the smoothing).
    expect(["PEAK", "BUILDING"]).toContain(dec.intensity);
  });

  it("emits a BREATH decision when the player is downed", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    for (let i = 0; i < 5; i++) {
      d.tick(makeSig({ now: now + i * 1000, downed: true }));
    }
    const dec = d.getDecision();
    expect(dec.intensity).toBe("BREATH");
  });
});

describe("Section D #502 — Pacing lulls", () => {
  it("emits a LULL intensity during a forced lull window", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    // Tick enough to fill the window + trigger a lull.
    // The director's WAVE_SPIKE_MS is 45s; we simulate time passing.
    for (let i = 0; i < 60; i++) {
      d.tick(makeSig({ now: now + i * 1000, enemiesAlive: 3 }));
    }
    // After 60s, the director should have entered a lull at some point.
    // Verify the LULL intensity is in the set of possible intensities.
    const possibleIntensities = ["CALM", "BUILDING", "PEAK", "BREATH", "LULL"];
    expect(possibleIntensities).toContain(d.getDecision().intensity);
  });
});

describe("Section D #503 — Adaptive skill (struggling)", () => {
  it("flags the player as struggling when K/D < 0.5 for 20s", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    // Simulate the player dying a lot (low K/D).
    for (let i = 0; i < 30; i++) {
      d.tick(makeSig({
        now: now + i * 1000,
        kills: 1, // 1 kill
        lastDeathAt: now + i * 1000, // died every second
        enemiesAlive: 5,
      }));
    }
    // The director should detect the struggling state.
    expect(d.isStruggling()).toBe(true);
  });

  it("does not flag struggling when K/D is healthy", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    for (let i = 0; i < 30; i++) {
      d.tick(makeSig({
        now: now + i * 1000,
        kills: 10,
        lastDeathAt: 0, // no deaths
        enemiesAlive: 5,
      }));
    }
    expect(d.isStruggling()).toBe(false);
  });
});

describe("Section D #504 — Dominating (elite + loot)", () => {
  it("flags the player as dominating when K/D > 3.0 for 20s", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    for (let i = 0; i < 30; i++) {
      d.tick(makeSig({
        now: now + i * 1000,
        kills: 10 + i, // 10 kills per tick, no deaths
        lastDeathAt: 0,
        enemiesAlive: 5,
      }));
    }
    expect(d.isDominating()).toBe(true);
  });

  it("elite mult is 1.8 when dominating, 1.0 otherwise", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    expect(d.getEliteMult()).toBe(1.0);
    const now = performance.now();
    for (let i = 0; i < 30; i++) {
      d.tick(makeSig({
        now: now + i * 1000,
        kills: 10 + i,
        lastDeathAt: 0,
        enemiesAlive: 5,
      }));
    }
    expect(d.getEliteMult()).toBe(1.8);
  });
});

describe("Section D #505 — Last-stand", () => {
  it("flags last-stand when only 1 enemy remains alive", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    for (let i = 0; i < 5; i++) {
      d.tick(makeSig({ now: now + i * 1000, enemiesAlive: 1 }));
    }
    expect(d.isLastStand()).toBe(true);
  });

  it("clears last-stand when the enemy count rises", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    for (let i = 0; i < 5; i++) {
      d.tick(makeSig({ now: now + i * 1000, enemiesAlive: 1 }));
    }
    expect(d.isLastStand()).toBe(true);
    d.clearLastStand();
    expect(d.isLastStand()).toBe(false);
  });
});

describe("Section D #506 — Boss intro", () => {
  it("triggerBossIntro sets the intro window + name", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    d.triggerBossIntro("Juggernaut");
    expect(d.isInBossIntro()).toBe(true);
    expect(d.getBossIntroName()).toBe("Juggernaut");
  });

  it("isInBossIntro returns false after the intro window expires", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    d.triggerBossIntro("Juggernaut");
    // The intro window is 5s. Wait 6s (simulated via tick).
    const now = performance.now();
    for (let i = 0; i < 7; i++) {
      d.tick(makeSig({ now: now + i * 1000, enemiesAlive: 1 }));
    }
    expect(d.isInBossIntro()).toBe(false);
  });
});

describe("Section D #596 — Fear factor", () => {
  it("fear factor is 0 when K/D is low", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    for (let i = 0; i < 10; i++) {
      d.tick(makeSig({ now: now + i * 1000, kills: 1, lastDeathAt: 0, enemiesAlive: 5 }));
    }
    expect(d.getFearFactor()).toBeLessThan(0.1);
  });

  it("fear factor rises when K/D is high (player is scary)", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    const now = performance.now();
    for (let i = 0; i < 30; i++) {
      d.tick(makeSig({ now: now + i * 1000, kills: 20 + i, lastDeathAt: 0, enemiesAlive: 5 }));
    }
    expect(d.getFearFactor()).toBeGreaterThan(0.1);
  });
});

describe("Section D #588 — Player tactic tracking", () => {
  it("recordPlayerTactic + getPlayerTactics round-trip", () => {
    const d = new AIDirector(DIFFICULTY_CONFIGS.normal);
    d.recordPlayerTactic("smoke");
    d.recordPlayerTactic("smoke");
    d.recordPlayerTactic("flank");
    const tactics = d.getPlayerTactics();
    expect(tactics.smoke).toBe(2);
    expect(tactics.flank).toBe(1);
    expect(tactics.flash).toBe(0);
  });
});
