import { describe, it, expect } from "vitest";
import {
  validateMap,
  validateAllMaps,
  validateMapDefinition,
  type MapValidationResult,
} from "../MapValidator";
import { MAP_REGISTRY } from "../MapRegistry";

/**
 * Backlog §2 item 34 — Snapshot tests for MapValidator.ts output on all
 * registered maps.
 *
 * The validator's output is a deterministic, pure-data structure (no
 * THREE dependency, no scene access) — perfect for snapshot testing.
 * The snapshot files (committed to git) record the canonical validation
 * result for each registered map. A change to MapValidator's algorithm,
 * the map definitions, or the tunables (MIN_COVER_PER_ZONE, etc.) will
 * surface as a snapshot diff for designer review.
 *
 * Snapshots live in `src/lib/game/maps/__tests__/__snapshots__/`.
 * Update them with `bun run test -- -u` after an intentional design pass.
 */

const MAP_SLUGS = MAP_REGISTRY.map((m) => m.slug);

describe("MapValidator coverage", () => {
  it("validates every map in MAP_REGISTRY (no map left behind)", () => {
    expect(MAP_SLUGS.length).toBeGreaterThanOrEqual(7); // 7 base maps + sandbox
    for (const slug of MAP_SLUGS) {
      const result = validateMap(slug);
      expect(result, `validateMap(${slug}) returned null`).not.toBeNull();
      expect(result!.slug).toBe(slug);
    }
  });

  it("validateAllMaps returns a result for every registered map", () => {
    const all = validateAllMaps();
    expect(Object.keys(all).sort()).toEqual([...MAP_SLUGS].sort());
  });

  it("validateMap returns null for an unknown slug", () => {
    expect(validateMap("does_not_exist")).toBeNull();
  });
});

describe("MapValidator result shape (invariants for every map)", () => {
  for (const slug of MAP_SLUGS) {
    it(`${slug}: result has the full shape + non-negative counts`, () => {
      const r = validateMap(slug)!;
      expect(typeof r.ok).toBe("boolean");
      expect(Array.isArray(r.spawnSafety)).toBe(true);
      expect(Array.isArray(r.coverDensity)).toBe(true);
      expect(r.coverDensity.length).toBe(9); // 3×3 grid
      expect(typeof r.sightlineLength).toBe("object");
      expect(r.sightlineLength.samples).toBeGreaterThanOrEqual(0);
      expect(r.sightlineLength.min).toBeGreaterThanOrEqual(0);
      expect(r.sightlineLength.max).toBeGreaterThanOrEqual(r.sightlineLength.min);
      expect(r.sightlineLength.distribution.length).toBe(8); // SIGHTLINE_HISTOGRAM_BUCKETS
      expect(r.sightlineLength.bucketEdges.length).toBe(8);
      expect(Array.isArray(r.issues)).toBe(true);
      expect(typeof r.totalCover).toBe("number");
      expect(r.totalCover).toBeGreaterThanOrEqual(0);
      expect(typeof r.bounds).toBe("number");
      expect(r.bounds).toBeGreaterThan(0);
    });

    it(`${slug}: every cover zone has a label + verdict in {sparse,cluttered,ok}`, () => {
      const r = validateMap(slug)!;
      const validLabels = new Set(["NW", "N", "NE", "W", "C", "E", "SW", "S", "SE"]);
      for (const z of r.coverDensity) {
        expect(validLabels.has(z.zone)).toBe(true);
        expect(["sparse", "cluttered", "ok"]).toContain(z.verdict);
        expect(z.ok).toBe(z.verdict === "ok");
        expect(z.count).toBeGreaterThanOrEqual(0);
      }
    });

    it(`${slug}: ok flag matches (issues.length === 0)`, () => {
      const r = validateMap(slug)!;
      expect(r.ok).toBe(r.issues.length === 0);
    });
  }
});

/**
 * Snapshot tests — one snapshot per registered map. The snapshot is the
 * full MapValidationResult (minus the volatile `generatedAt`-style fields
 * the validator doesn't actually emit). These are the canonical "this is
 * what the map looks like to the validator" records.
 *
 * File-based snapshots (not inline) — vitest's inline snapshot writer
 * doesn't support being called from inside a loop because each call
 * rewrites the source location. File-based snapshots are also easier to
 * diff in code review (one file per map under __snapshots__/).
 *
 * Update with `bun run test -- -u` after an intentional design change.
 */
describe("MapValidator snapshots (one per registered map)", () => {
  for (const slug of MAP_SLUGS) {
    it(`${slug}: matches committed snapshot`, () => {
      const r = validateMap(slug)!;
      // Strip nothing — the validator is deterministic. The snapshot will
      // include every field, so a design pass that changes any prop count,
      // spawn position, or sightline length will surface here.
      expect(r).toMatchSnapshot({ slug });
    });
  }
});

/**
 * Pure-function test: validateMapDefinition returns identical output for
 * the same input map (no hidden state, no Math.random). This is the
 * determinism guarantee the snapshot tests rely on.
 */
describe("validateMapDefinition determinism", () => {
  it("two calls on the same map return deep-equal results", () => {
    for (const map of MAP_REGISTRY) {
      const a = validateMapDefinition(map);
      const b = validateMapDefinition(map);
      expect(a).toEqual(b);
    }
  });

  it("mutating the input map's props array changes the result (defensive copy guard)", () => {
    // The validator should NOT mutate its input. But if we mutate the input
    // ourselves between calls, the results should differ.
    const map = MAP_REGISTRY[0];
    const a = validateMapDefinition(map);
    // Shallow-clone + push a fake cover prop.
    const mutated: typeof map = {
      ...map,
      props: [...map.props, { type: "crate", position: [0, 0.6, 0] }],
    };
    const b = validateMapDefinition(mutated);
    expect(b.totalCover).not.toBe(a.totalCover);
  });
});

/**
 * Type-level smoke: the result is JSON-serializable (no THREE.Vector3,
 * no circular refs). The validator is supposed to be pure-TS — this
 * test guards against a future regression that sneaks a THREE import in.
 */
describe("MapValidator result is JSON-serializable", () => {
  for (const slug of MAP_SLUGS) {
    it(`${slug}: result round-trips through JSON.stringify/parse`, () => {
      const r = validateMap(slug)!;
      const json = JSON.stringify(r);
      const parsed = JSON.parse(json) as MapValidationResult;
      expect(parsed.slug).toBe(r.slug);
      expect(parsed.totalCover).toBe(r.totalCover);
      expect(parsed.issues).toEqual(r.issues);
    });
  }
});
