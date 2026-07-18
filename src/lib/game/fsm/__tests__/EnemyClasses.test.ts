import { describe, it, expect } from "vitest";
import {
  ENEMY_CLASSES,
  BOSS_CLASSES,
  getEnemyClassConfig,
  type EnemyClass,
} from "../../EnemyClasses";

/**
 * Section D #491–495 — Class differentiation tests.
 * Verifies the class-specific behavior flags are set correctly.
 */
describe("Section D #491 — Rifleman (generalist)", () => {
  it("Rifleman has balanced stats (no specialization flags)", () => {
    const cfg = ENEMY_CLASSES.RIFLEMAN;
    expect(cfg.bipodRequired).toBeUndefined();
    expect(cfg.suppressiveLane).toBeUndefined();
    expect(cfg.repositionAfterShot).toBeUndefined();
    expect(cfg.ghillieProne).toBeUndefined();
    expect(cfg.breachingRush).toBeUndefined();
    expect(cfg.commandAura).toBeUndefined();
  });

  it("Rifleman has mid-tier accuracy + speed", () => {
    const cfg = ENEMY_CLASSES.RIFLEMAN;
    expect(cfg.accuracy).toBeGreaterThanOrEqual(0.5);
    expect(cfg.accuracy).toBeLessThanOrEqual(0.65);
    expect(cfg.speed).toBeGreaterThanOrEqual(2.0);
    expect(cfg.speed).toBeLessThanOrEqual(3.0);
  });
});

describe("Section D #492 — MG (bipod + suppressive lane)", () => {
  it("MG has bipodRequired=true", () => {
    expect(ENEMY_CLASSES.MG.bipodRequired).toBe(true);
  });

  it("MG has suppressiveLane=true", () => {
    expect(ENEMY_CLASSES.MG.suppressiveLane).toBe(true);
  });

  it("MG has high HP (180) — bullet sponge", () => {
    expect(ENEMY_CLASSES.MG.health).toBeGreaterThanOrEqual(150);
  });

  it("MG has a low accuracy (0.35) — suppressive, not lethal", () => {
    expect(ENEMY_CLASSES.MG.accuracy).toBeLessThanOrEqual(0.45);
  });
});

describe("Section D #493 — Sniper (reposition + ghillie)", () => {
  it("Sniper has repositionAfterShot=true", () => {
    expect(ENEMY_CLASSES.SNIPER.repositionAfterShot).toBe(true);
  });

  it("Sniper has ghillieProne=true", () => {
    expect(ENEMY_CLASSES.SNIPER.ghillieProne).toBe(true);
  });

  it("Sniper has high accuracy (0.85)", () => {
    expect(ENEMY_CLASSES.SNIPER.accuracy).toBeGreaterThanOrEqual(0.8);
  });

  it("Sniper has a long attack range (35m)", () => {
    expect(ENEMY_CLASSES.SNIPER.attackRange).toBeGreaterThanOrEqual(30);
  });
});

describe("Section D #494 — Shotgunner (breaching rush)", () => {
  it("Shotgunner has breachingRush=true", () => {
    expect(ENEMY_CLASSES.SHOTGUNNER.breachingRush).toBe(true);
  });

  it("Shotgunner has high speed (≥ 3.0 m/s) — rusher", () => {
    expect(ENEMY_CLASSES.SHOTGUNNER.speed).toBeGreaterThanOrEqual(3.0);
  });

  it("Shotgunner has a short attack range (≤ 8m) — CQB", () => {
    expect(ENEMY_CLASSES.SHOTGUNNER.attackRange).toBeLessThanOrEqual(8);
  });
});

describe("Section D #495 — Commander (aura + call-in)", () => {
  it("Commander has commandAura=true", () => {
    expect(ENEMY_CLASSES.COMMANDER.commandAura).toBe(true);
  });

  it("Commander has a command aura radius (≥ 8m)", () => {
    expect(ENEMY_CLASSES.COMMANDER.commandAuraRadius).toBeGreaterThanOrEqual(8);
  });

  it("Commander has callIn=true", () => {
    expect(ENEMY_CLASSES.COMMANDER.callIn).toBe(true);
  });

  it("Commander has a call-in cooldown", () => {
    expect(ENEMY_CLASSES.COMMANDER.callInCooldownSec).toBeGreaterThan(0);
  });

  it("Commander has high HP (≥ 200) — tanky coordinator", () => {
    expect(ENEMY_CLASSES.COMMANDER.health).toBeGreaterThanOrEqual(200);
  });
});

/**
 * Section D — verify all normal classes are present.
 */
describe("Section D — class registry completeness", () => {
  it("has all 9 normal classes (RIFLEMAN, SNIPER, MG, CQB, COMMANDER, ZOMBIE, MEDIC, SHIELD, SCOUT, SHOTGUNNER)", () => {
    const expected: EnemyClass[] = [
      "RIFLEMAN", "SNIPER", "MG", "CQB", "COMMANDER",
      "ZOMBIE", "MEDIC", "SHIELD", "SCOUT", "SHOTGUNNER",
    ];
    expect(Object.keys(ENEMY_CLASSES).sort()).toEqual(expected.sort());
  });

  it("has all 5 boss classes", () => {
    expect(Object.keys(BOSS_CLASSES).sort()).toEqual(
      ["ARMORED_MECH", "DRONE_COMMANDER", "FLAMETHROWER_HEAVY", "JUGGERNAUT", "RIOT_SHIELD_CAPTAIN"],
    );
  });

  it("getEnemyClassConfig returns the normal config for non-boss enemies", () => {
    const e = { enemyClass: "RIFLEMAN" } as unknown as Parameters<typeof getEnemyClassConfig>[0];
    expect(getEnemyClassConfig(e)?.name).toBe("Rifleman");
  });
});
