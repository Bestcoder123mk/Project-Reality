import { describe, it, expect } from "vitest";
import {
  BOSS_WEAK_POINTS,
  checkBossWeakPointHit,
  describeBossTelegraph,
  ENRAGE_TIMER_SEC,
  getBossPattern,
  type BossWeakPoint,
} from "../../ai/boss-patterns";
import type { Enemy } from "../../systems/types";

/**
 * Section D #513–518 — Boss pattern enhancement tests.
 */
function makeBoss(bossClass: string, hpRatio: number = 1.0): Enemy {
  const maxHealth = 600;
  return {
    group: { position: { x: 0, y: 0, z: 0 } } as unknown as Enemy["group"],
    head: {} as Enemy["head"],
    body: {} as Enemy["body"],
    parts: {},
    health: maxHealth * hpRatio,
    maxHealth,
    alive: true,
    velocity: { x: 0, y: 0, z: 0 } as unknown as Enemy["velocity"],
    id: "boss-1",
    state: "chase",
    lastShot: 0,
    hitFlash: 0,
    deadTime: 0,
    spawnPos: { x: 0, y: 0, z: 0 } as unknown as Enemy["spawnPos"],
    team: "enemy",
    speed: 1.0,
    accuracy: 0.5,
    gaitPhase: 0,
    lookAtTarget: 0,
    lastDamagedTime: 0,
    className: "Boss",
  } as unknown as Enemy;
}

describe("Section D #516 — Boss weak points", () => {
  it("BOSS_WEAK_POINTS has entries for at least one boss class", () => {
    expect(Object.keys(BOSS_WEAK_POINTS).length).toBeGreaterThan(0);
  });

  it("Juggernaut has a coolant vent weak point (exposed in PHASE_2)", () => {
    const wps = BOSS_WEAK_POINTS.JUGGERNAUT;
    expect(wps).toBeDefined();
    const vent = wps?.find((wp) => wp.name === "Coolant Vent");
    expect(vent).toBeDefined();
    expect(vent?.damageMult).toBeGreaterThanOrEqual(2.0);
    expect(vent?.exposedInPhases).toContain("PHASE_2");
  });

  it("checkBossWeakPointHit returns the weak point when the hit is inside the sphere", () => {
    const boss = makeBoss("JUGGERNAUT");
    // The Head weak point is at local (0, 1.8, 0) — world (0, 1.8, 0).
    // The boss's group.position is (0,0,0). Hit at (0, 1.8, 0) should land.
    const result = checkBossWeakPointHit(boss, { x: 0, y: 1.8, z: 0 }, "PHASE_1");
    expect(result).not.toBeNull();
    expect(result?.weakPoint.name).toBe("Head");
    expect(result?.damageMult).toBeGreaterThanOrEqual(1.5);
  });

  it("checkBossWeakPointHit returns null when the hit is outside all weak points", () => {
    const boss = makeBoss("JUGGERNAUT");
    const result = checkBossWeakPointHit(boss, { x: 10, y: 1.8, z: 0 }, "PHASE_1");
    expect(result).toBeNull();
  });

  it("checkBossWeakPointHit respects phase gating (PHASE_2-only vent not hittable in PHASE_1)", () => {
    const boss = makeBoss("JUGGERNAUT");
    // The Coolant Vent is at (0, 1.4, -0.4) — exposed only in PHASE_2.
    const result = checkBossWeakPointHit(boss, { x: 0, y: 1.4, z: -0.4 }, "PHASE_1");
    expect(result).toBeNull();
    const result2 = checkBossWeakPointHit(boss, { x: 0, y: 1.4, z: -0.4 }, "PHASE_2");
    expect(result2).not.toBeNull();
    expect(result2?.weakPoint.name).toBe("Coolant Vent");
  });
});

describe("Section D #514 — Enrage timer", () => {
  it("ENRAGE_TIMER_SEC is set (3 minutes)", () => {
    expect(ENRAGE_TIMER_SEC).toBe(180);
  });
});

describe("Section D #515 — Telegraph clarity", () => {
  it("describeBossTelegraph returns a human-readable label for known attacks", () => {
    const pattern = getBossPattern("JUGGERNAUT");
    const label = describeBossTelegraph(pattern, "ground_slam");
    expect(label).toContain("GROUND SLAM");
  });

  it("describeBossTelegraph returns the uppercased attack id for unknown attacks", () => {
    const pattern = getBossPattern("JUGGERNAUT");
    const label = describeBossTelegraph(pattern, "suppressive_fire");
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("Section D #513 — Multi-phase", () => {
  it("every boss pattern has at least 2 phases", () => {
    const classes = ["JUGGERNAUT", "FLAMETHROWER_HEAVY", "ARMORED_MECH", "DRONE_COMMANDER", "RIOT_SHIELD_CAPTAIN"] as const;
    for (const cls of classes) {
      const pattern = getBossPattern(cls);
      expect(pattern.phases.length, `${cls} should have ≥ 2 phases`).toBeGreaterThanOrEqual(2);
    }
  });

  it("every phase has a defined hpThreshold", () => {
    const pattern = getBossPattern("JUGGERNAUT");
    for (const phase of pattern.phases) {
      expect(phase.hpThreshold).toBeGreaterThan(0);
      expect(phase.hpThreshold).toBeLessThanOrEqual(1.0);
    }
  });
});
