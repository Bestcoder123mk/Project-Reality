import { describe, it, expect } from "vitest";
import {
  SpatialHash,
  envLosBlocked,
  envLosBlockedRespectGlass,
  friendlyInLineOfFire,
  getEnemySpatialHash,
  type SpatialEntity,
  type GlassCollider,
} from "../../ai/spatial-hash";

/**
 * Section D #533 — Spatial hash tests.
 * Verifies the O(n) perception replacement for the O(n²) nested loop.
 */
describe("Section D #533 — SpatialHash", () => {
  function makeEntity(id: number, x: number, z: number, team: "player" | "enemy" = "enemy"): SpatialEntity {
    return { id, x, y: 0, z, team, alive: true };
  }

  it("queryRadius returns entities within the radius", () => {
    const hash = new SpatialHash<SpatialEntity>();
    hash.rebuild([
      makeEntity(1, 0, 0),
      makeEntity(2, 5, 0),
      makeEntity(3, 15, 0),
    ]);
    const out = hash.queryRadius(0, 0, 6);
    expect(out.map((e) => e.id).sort()).toEqual([1, 2]);
  });

  it("queryRadius excludes dead entities", () => {
    const hash = new SpatialHash<SpatialEntity>();
    const dead = makeEntity(1, 0, 0);
    dead.alive = false;
    hash.rebuild([dead, makeEntity(2, 1, 0)]);
    const out = hash.queryRadius(0, 0, 5);
    expect(out.map((e) => e.id)).toEqual([2]);
  });

  it("queryRadius returns an empty array when no entities are in range", () => {
    const hash = new SpatialHash<SpatialEntity>();
    hash.rebuild([makeEntity(1, 100, 100)]);
    const out = hash.queryRadius(0, 0, 5);
    expect(out).toEqual([]);
  });

  it("querySegment returns entities along the ray", () => {
    const hash = new SpatialHash<SpatialEntity>();
    hash.rebuild([
      makeEntity(1, 0, 0),
      makeEntity(2, 5, 0),
      makeEntity(3, 10, 0),
      makeEntity(4, 0, 20), // off the ray
    ]);
    const out = hash.querySegment(0, 0, 10, 0);
    const ids = out.map((e) => e.id).sort();
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).not.toContain(4);
  });

  it("size() returns the total entity count", () => {
    const hash = new SpatialHash<SpatialEntity>();
    hash.rebuild([makeEntity(1, 0, 0), makeEntity(2, 100, 100)]);
    expect(hash.size()).toBe(2);
  });

  it("handles negative coordinates", () => {
    const hash = new SpatialHash<SpatialEntity>();
    hash.rebuild([makeEntity(1, -10, -10), makeEntity(2, -12, -10)]);
    const out = hash.queryRadius(-10, -10, 5);
    expect(out.map((e) => e.id).sort()).toEqual([1, 2]);
  });

  it("getEnemySpatialHash returns a singleton", () => {
    const a = getEnemySpatialHash();
    const b = getEnemySpatialHash();
    expect(a).toBe(b);
  });
});

/**
 * Section D #534 — Scoped LOS raycast tests.
 */
describe("Section D #534 — envLosBlocked", () => {
  function makeBox(x: number, z: number, w: number, h: number, d: number): GlassCollider {
    return {
      box: {
        min: { x: x - w / 2, y: 0, z: z - d / 2 },
        max: { x: x + w / 2, y: h, z: z + d / 2 },
      },
    };
  }

  it("returns false when no colliders block the ray", () => {
    expect(envLosBlocked([], 0, 0, 10, 0)).toBe(false);
  });

  it("returns true when a collider blocks the ray", () => {
    const wall = makeBox(5, 0, 1, 2, 4); // 1m wide, 2m tall, 4m deep — blocks.
    expect(envLosBlocked([wall], 0, 0, 10, 0)).toBe(true);
  });

  it("returns false when the collider is too short (< 0.8m)", () => {
    const lowCover = makeBox(5, 0, 1, 0.5, 4); // 0.5m tall — too short.
    expect(envLosBlocked([lowCover], 0, 0, 10, 0)).toBe(false);
  });

  it("returns false when the collider is off the ray", () => {
    const offRay = makeBox(5, 20, 1, 2, 4); // 20m off the ray.
    expect(envLosBlocked([offRay], 0, 0, 10, 0)).toBe(false);
  });
});

/**
 * Section D #540 — Glass occlusion tests.
 * Glass should block AI vision but NOT bullets. envLosBlockedRespectGlass
 * skips glass colliders; envLosBlocked (used for bullets) doesn't.
 */
describe("Section D #540 — Glass occlusion", () => {
  function makeGlass(x: number, z: number): GlassCollider {
    return {
      box: {
        min: { x: x - 0.5, y: 0, z: z - 2 },
        max: { x: x + 0.5, y: 2, z: z + 2 },
      },
      isGlass: true,
    };
  }

  it("envLosBlockedRespectGlass skips glass (vision passes through)", () => {
    const glass = makeGlass(5, 0);
    expect(envLosBlockedRespectGlass([glass], 0, 0, 10, 0)).toBe(false);
  });

  it("envLosBlocked (bullets) still hits glass", () => {
    const glass = makeGlass(5, 0);
    expect(envLosBlocked([glass], 0, 0, 10, 0)).toBe(true);
  });
});

/**
 * Section D #539 — Friendly fire LOS check tests.
 */
describe("Section D #539 — friendlyInLineOfFire", () => {
  function makeEntity(id: number, x: number, z: number, team: "enemy" = "enemy"): SpatialEntity {
    return { id, x, y: 0, z, team, alive: true };
  }

  it("returns true when an ally is in the line of fire", () => {
    const hash = new SpatialHash<SpatialEntity>();
    hash.rebuild([
      makeEntity(2, 5, 0), // ally in the ray
    ]);
    // Shooter at (0,0) firing at (10,0); ally at (5,0) — directly in the ray.
    expect(friendlyInLineOfFire(hash, 0, 0, 10, 0, 1, "enemy")).toBe(true);
  });

  it("returns false when no ally is in the line of fire", () => {
    const hash = new SpatialHash<SpatialEntity>();
    hash.rebuild([
      makeEntity(2, 5, 10), // ally 10m off the ray
    ]);
    expect(friendlyInLineOfFire(hash, 0, 0, 10, 0, 1, "enemy")).toBe(false);
  });

  it("returns false when the only entity in the ray is the shooter", () => {
    const hash = new SpatialHash<SpatialEntity>();
    hash.rebuild([
      makeEntity(1, 0, 0), // the shooter itself
    ]);
    expect(friendlyInLineOfFire(hash, 0, 0, 10, 0, 1, "enemy")).toBe(false);
  });

  it("returns false when the entity in the ray is on a different team", () => {
    const hash = new SpatialHash<SpatialEntity>();
    const player: SpatialEntity = { id: 2, x: 5, y: 0, z: 0, team: "player", alive: true };
    hash.rebuild([player]);
    expect(friendlyInLineOfFire(hash, 0, 0, 10, 0, 1, "enemy")).toBe(false);
  });
});
