import { describe, it, expect } from "vitest";
import {
  applySpawnProtection,
  isSpawnProtected,
  SPAWN_PROTECTION_MS,
  recordSpawnCampEvent,
  isSpawnCamped,
  clearSpawnCampEvents,
  CAMPING_THRESHOLD,
  selectSpawnAntiCamp,
  selectFlankSpawn,
  shouldDeferSpawn,
  computeMaxAliveCap,
} from "../../level/spawn-logic";

/**
 * Section D #529 — Spawn protection tests.
 * Freshly spawned entities must be invulnerable for SPAWN_PROTECTION_MS (3s).
 */
describe("Section D #529 — Spawn protection", () => {
  it("applySpawnProtection sets spawnProtectedUntil to now + SPAWN_PROTECTION_MS", () => {
    const entity: { spawnProtectedUntil?: number } = {};
    const now = 10000;
    applySpawnProtection(entity, now);
    expect(entity.spawnProtectedUntil).toBe(now + SPAWN_PROTECTION_MS);
  });

  it("isSpawnProtected returns true within the protection window", () => {
    const entity: { spawnProtectedUntil?: number } = {};
    applySpawnProtection(entity, 10000);
    expect(isSpawnProtected(entity, 10000)).toBe(true);
    expect(isSpawnProtected(entity, 12000)).toBe(true);
    expect(isSpawnProtected(entity, 13000)).toBe(false); // expired
  });

  it("isSpawnProtected returns false when no protection was applied", () => {
    expect(isSpawnProtected({}, 10000)).toBe(false);
  });
});

/**
 * Section D #530 — Spawn camping prevention tests.
 * A spawn point is "camped" if CAMPING_THRESHOLD+ events occurred within
 * CAMPING_RADIUS in the last CAMPING_WINDOW_MS.
 */
describe("Section D #530 — Spawn camping prevention", () => {
  it("isSpawnCamped returns false with no events", () => {
    clearSpawnCampEvents();
    expect(isSpawnCamped([0, 0, 0], 10000)).toBe(false);
  });

  it("isSpawnCamped returns true after CAMPING_THRESHOLD events near the spawn", () => {
    clearSpawnCampEvents();
    const spawn: [number, number, number] = [10, 0, 10];
    for (let i = 0; i < CAMPING_THRESHOLD; i++) {
      recordSpawnCampEvent(spawn, 10000 + i);
    }
    expect(isSpawnCamped(spawn, 10500)).toBe(true);
  });

  it("isSpawnCamped returns false when events are far from the spawn", () => {
    clearSpawnCampEvents();
    const farSpawn: [number, number, number] = [100, 0, 100];
    const campedSpawn: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < CAMPING_THRESHOLD; i++) {
      recordSpawnCampEvent(farSpawn, 10000 + i);
    }
    expect(isSpawnCamped(campedSpawn, 10500)).toBe(false);
  });

  it("clearSpawnCampEvents resets the buffer", () => {
    recordSpawnCampEvent([0, 0, 0], 10000);
    clearSpawnCampEvents();
    expect(isSpawnCamped([0, 0, 0], 10000)).toBe(false);
  });
});

/**
 * Section D #532 — Max-alive cap tests.
 */
describe("Section D #532 — Max-alive cap", () => {
  it("shouldDeferSpawn returns true when aliveCount >= cap", () => {
    expect(shouldDeferSpawn(10, 10)).toBe(true);
    expect(shouldDeferSpawn(11, 10)).toBe(true);
    expect(shouldDeferSpawn(9, 10)).toBe(false);
  });

  it("shouldDeferSpawn respects the spawnRateMult (lower mult = lower cap)", () => {
    // Base cap 10, spawnRateMult 0.5 → effective cap 5.
    expect(shouldDeferSpawn(5, 10, 0.5)).toBe(true);
    expect(shouldDeferSpawn(4, 10, 0.5)).toBe(false);
  });

  it("computeMaxAliveCap scales with spawnRateMult", () => {
    expect(computeMaxAliveCap(10, 1.0)).toBe(10);
    expect(computeMaxAliveCap(10, 0.5)).toBe(5);
    expect(computeMaxAliveCap(10, 1.6)).toBe(16);
    // Floor + min 1.
    expect(computeMaxAliveCap(10, 0.01)).toBe(1);
  });
});

/**
 * Section D #531 — Dynamic spawn (flank) tests.
 */
describe("Section D #531 — Dynamic flank spawn", () => {
  it("selectFlankSpawn returns null when no candidates exist (empty map)", () => {
    const result = selectFlankSpawn(
      "nonexistent-map",
      { x: 0, y: 0, z: 0 },
      0,
      [],
    );
    expect(result).toBeNull();
  });
});

/**
 * Section D #530 — Anti-camp selectSpawn wrapper tests.
 */
describe("Section D #530 — selectSpawnAntiCamp", () => {
  it("returns null when the map has no spawns", () => {
    clearSpawnCampEvents();
    const result = selectSpawnAntiCamp(
      "nonexistent-map",
      { x: 0, y: 0, z: 0 },
      [],
      0,
    );
    expect(result).toBeNull();
  });
});
