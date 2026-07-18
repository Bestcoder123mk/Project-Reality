import { describe, it, expect } from "vitest";
import { Vector3 } from "three";
import {
  computeDrop,
  computeWindDrift,
  applyBallisticDrop,
  integrateProjectile,
  velocityDamageMult,
  computeRicochet,
  getSurfacePenetrationMult,
  getCategoryPenetrationMult,
  testSurfacePenetration,
  getHitZoneMult,
  classifyHitZone,
  getWeaponBallisticParams,
  getBallisticParams,
  BALLISTIC_PARAMS,
  DEFAULT_BALLISTIC_PARAMS,
  // Section B — advanced ballistics.
  SPEED_OF_SOUND,
  AMMO_TYPES,
  getAmmoType,
  producesSonicCrack,
  transonicDragMult,
  gustWindSpeed,
  coriolisDriftM,
  magnusSpinDriftM,
  gModelDragCoef,
  DEFAULT_BC_BY_CATEGORY,
  spinStabilityScatter,
  computeDestabilizationScatter,
  sniperTraceVisibilityMult,
  TRANSONIC_BAND_LOW,
  TRANSONIC_BAND_HIGH,
} from "../Ballistics";

/**
 * Backlog §2 item 26 — Unit-test Ballistics.ts drop / wind / TOF math
 * against known projectile-motion values.
 *
 * The math:
 *   drop = 0.5 * g * t²          where t = distance / velocity
 *   windDrift = 0.5 * a_wind * t²  where a_wind = (windSpeed * 2) / max(15, damage)
 *
 * Reference values are computed analytically below (independent of the
 * implementation) so a regression that drifts the constants surfaces here.
 */

const G = 9.81; // m/s² — must match BULLET_GRAVITY in Ballistics.ts

describe("Ballistics.computeDrop", () => {
  it("returns 0 at distance 0 (no flight → no drop)", () => {
    expect(computeDrop(0, 800)).toBe(0);
  });

  it("returns 0 for non-positive velocity (can't divide by zero)", () => {
    expect(computeDrop(100, 0)).toBe(0);
    expect(computeDrop(100, -10)).toBe(0);
  });

  it("equals 0.5 * g * (d/v)² for a known rifle round", () => {
    // M4 carbine-ish: 100m shot at 760 m/s.
    const distance = 100;
    const velocity = 760;
    const t = distance / velocity; // ≈ 0.1316 s
    const expected = 0.5 * G * t * t;
    expect(computeDrop(distance, velocity)).toBeCloseTo(expected, 6);
  });

  it("scales quadratically with distance (drop@200m ≈ 4× drop@100m)", () => {
    const v = 760;
    const drop100 = computeDrop(100, v);
    const drop200 = computeDrop(200, v);
    // drop ∝ t² ∝ d²  →  ratio == 4 (within float tolerance)
    expect(drop200 / drop100).toBeCloseTo(4, 3);
  });

  it("drops less for faster bullets (sniper < pistol at same distance)", () => {
    const sniper = BALLISTIC_PARAMS.SNIPER.velocity; // 850 m/s
    const pistol = BALLISTIC_PARAMS.PISTOL.velocity; // 380 m/s
    const distance = 100;
    expect(computeDrop(distance, sniper)).toBeLessThan(computeDrop(distance, pistol));
  });

  it("produces a realistic 100m drop for a 5.56mm rifle (~0.85m at 760 m/s)", () => {
    // Real-world M855 5.56mm at 100m drops ~7cm at 920 m/s muzzle, more at
    // 760 m/s. We assert a sane ballpark (sub-meter at 100m for a rifle).
    const drop = computeDrop(100, 760);
    expect(drop).toBeGreaterThan(0.05);
    expect(drop).toBeLessThan(1.5);
  });
});

describe("Ballistics.computeWindDrift", () => {
  it("returns 0 with no wind", () => {
    expect(computeWindDrift(100, 760, 50, 0)).toBe(0);
  });

  it("returns 0 with no velocity (can't travel)", () => {
    expect(computeWindDrift(100, 0, 50, 10)).toBe(0);
  });

  it("equals 0.5 * a_wind * (d/v)² where a_wind = (windSpeed*2)/max(15,damage)", () => {
    const d = 100, v = 760, dmg = 50, wind = 5;
    const t = d / v;
    const aWind = (wind * 2) / Math.max(15, dmg);
    const expected = 0.5 * aWind * t * t;
    expect(computeWindDrift(d, v, dmg, wind)).toBeCloseTo(expected, 6);
  });

  it("drifts more for lighter (lower-damage) bullets at the same wind", () => {
    // damage acts as mass proxy in windAccel = wind*2 / max(15, damage).
    const light = computeWindDrift(100, 760, 20, 5);  // light
    const heavy = computeWindDrift(100, 760, 80, 5);  // heavy
    expect(light).toBeGreaterThan(heavy);
  });

  it("uses the 15-damage floor for very light projectiles (no divide-by-zero)", () => {
    // damage below 15 → effective damage clamped to 15 → a_wind == wind*2/15.
    const d = 100, v = 760, wind = 5;
    const t = d / v;
    const aWind = (wind * 2) / 15;
    const expected = 0.5 * aWind * t * t;
    expect(computeWindDrift(d, v, 1, wind)).toBeCloseTo(expected, 6);
    expect(computeWindDrift(d, v, 14, wind)).toBeCloseTo(expected, 6);
  });
});

describe("Ballistics.applyBallisticDrop", () => {
  it("bakes drop + wind into the segment direction without allocating a new vector", () => {
    // Use the THREE shim that ships with three (in case vitest imports it).
    // Vector3 imported at top of file
    const dir = new Vector3(1, 0, 0); // shooting +X
    const out = new Vector3();
    const result = applyBallisticDrop(dir, 100, 760, 50, 5, 0, out);
    // Same reference returned (no allocation).
    expect(result).toBe(out);
    // Y component must drop (gravity).
    expect(out.y).toBeLessThan(0);
    // X is the primary direction; wind direction = 0 → cos(0)=1, sin(0)=0,
    // so wind shifts +X. Drop shifts -Y. Resulting vector still unit-length.
    expect(out.length()).toBeCloseTo(1, 5);
  });

  it("produces zero correction when distance=0 + wind=0 (pure direction)", () => {
    // Vector3 imported at top of file
    const dir = new Vector3(0, 0, -1);
    const out = new Vector3();
    applyBallisticDrop(dir, 0, 760, 50, 0, 0, out);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(0, 6);
    expect(out.z).toBeCloseTo(-1, 6);
  });
});

describe("Ballistics.integrateProjectile (semi-implicit Euler)", () => {
  it("free-fall (no drag, no wind) → y(t) = v_y0 * t - 0.5 * g * scale * t² (within Euler truncation error)", () => {
    // Vector3 imported at top of file
    const params = { ...BALLISTIC_PARAMS.RIFLE, dragCoef: 0, gravityScale: 1 };
    const pos = new Vector3(0, 0, 0);
    const vel = new Vector3(0, 100, 0); // straight up at 100 m/s
    // Small dt so the semi-implicit Euler truncation error is negligible
    // (error ≈ 0.5 * g * dt * t² ≈ 5mm at dt=0.001, t=1s — well below the
    // toBeCloseTo(expected, 2) tolerance of 0.005).
    const dt = 0.001;
    const totalT = 1.0;
    const steps = Math.round(totalT / dt);
    for (let i = 0; i < steps; i++) {
      integrateProjectile(pos, vel, dt, params, 0, 0);
    }
    // After 1s with no drag: y = 100*1 - 0.5*9.81*1² ≈ 95.095 m.
    const expected = 100 * totalT - 0.5 * G * totalT * totalT;
    expect(pos.y).toBeCloseTo(expected, 2);
  });

  it("horizontal shot drops under gravity (no drag, no wind)", () => {
    // Vector3 imported at top of file
    const params = { ...BALLISTIC_PARAMS.RIFLE, dragCoef: 0, gravityScale: 1 };
    const pos = new Vector3(0, 1.5, 0);
    const vel = new Vector3(760, 0, 0);
    const dt = 0.001; // 1 ms steps for accuracy
    const target = 100; // 100m
    const steps = Math.round((target / 760) / dt);
    for (let i = 0; i < steps; i++) {
      integrateProjectile(pos, vel, dt, params, 0, 0);
    }
    const t = steps * dt;
    const expectedDrop = 0.5 * G * t * t;
    expect(pos.y).toBeCloseTo(1.5 - expectedDrop, 2);
    expect(pos.x).toBeCloseTo(target, 0); // ~100m downrange
  });

  it("drag decelerates the bullet (velocity decreases over time)", () => {
    // Vector3 imported at top of file
    const params = BALLISTIC_PARAMS.RIFLE; // dragCoef: 0.0014
    const pos = new Vector3(0, 0, 0);
    const vel = new Vector3(760, 0, 0);
    const v0 = vel.length();
    for (let i = 0; i < 100; i++) {
      integrateProjectile(pos, vel, 0.01, params, 0, 0);
    }
    // After 1s of drag, the bullet must be slower than at the start.
    expect(vel.length()).toBeLessThan(v0);
  });

  it("wind bends the trajectory sideways (horizontal accel only)", () => {
    // Vector3 imported at top of file
    const params = { ...BALLISTIC_PARAMS.RIFLE, dragCoef: 0, gravityScale: 0 };
    const posNoWind = new Vector3(0, 0, 0);
    const posWind = new Vector3(0, 0, 0);
    const velNoWind = new Vector3(760, 0, 0);
    const velWind = new Vector3(760, 0, 0);
    const dt = 0.01;
    for (let i = 0; i < 100; i++) {
      integrateProjectile(posNoWind, velNoWind, dt, params, 0, 0);
      // Wind direction = π/2 → sin(π/2)=1 → +Z accel.
      integrateProjectile(posWind, velWind, dt, params, 5, Math.PI / 2);
    }
    // With wind, +Z drifts positive; without, z stays 0.
    expect(posWind.z).toBeGreaterThan(0);
    expect(posNoWind.z).toBeCloseTo(0, 6);
    // Wind doesn't affect Y (it's horizontal-only).
    expect(posWind.y).toBeCloseTo(posNoWind.y, 6);
  });
});

describe("Ballistics.velocityDamageMult", () => {
  it("returns 1.0 at full muzzle velocity (no falloff)", () => {
    expect(velocityDamageMult(760, 760)).toBeCloseTo(1.0, 6);
  });

  it("returns 0.5 floor (0.5 + 0.5*0.4) when v_ratio < 0.4 (very slow)", () => {
    expect(velocityDamageMult(30, 760)).toBeCloseTo(0.5 + 0.5 * 0.4, 6);
    expect(velocityDamageMult(0, 760)).toBeCloseTo(0.5 + 0.5 * 0.4, 6);
  });

  it("scales linearly in the [0.4, 1.0] ratio window", () => {
    // ratio = 0.7 → mult = 0.5 + 0.5*0.7 = 0.85
    const v = 0.7 * 760;
    expect(velocityDamageMult(v, 760)).toBeCloseTo(0.85, 2);
  });

  it("is monotonic in velocity (more speed → more damage)", () => {
    const v0 = velocityDamageMult(200, 760);
    const v1 = velocityDamageMult(400, 760);
    const v2 = velocityDamageMult(760, 760);
    expect(v0).toBeLessThanOrEqual(v1);
    expect(v1).toBeLessThanOrEqual(v2);
  });

  it("returns 1.0 when muzzleVelocity is 0 (defensive guard)", () => {
    expect(velocityDamageMult(100, 0)).toBe(1);
  });
});

describe("Ballistics.computeRicochet", () => {
  it("never ricochets off soft surfaces (wood, sand, flesh)", () => {
    // Vector3 imported at top of file
    const n = new Vector3(0, 1, 0); // ground normal up
    const d = new Vector3(0.7, -0.7, 0).normalize(); // 45° downward
    for (const soft of ["wood", "sand", "earth", "glass", "foliage", "drywall", "brick", "sandbag"]) {
      const r = computeRicochet(n, d, soft);
      expect(r.direction).toBeNull();
      expect(r.damageMult).toBe(0);
    }
  });

  it("embeds (no ricochet) when bullet hits perpendicular to surface", () => {
    // Vector3 imported at top of file
    const n = new Vector3(0, 1, 0);
    const d = new Vector3(0, -1, 0); // straight down → dot = -1 → |dot| > 0.91
    const r = computeRicochet(n, d, "concrete");
    expect(r.direction).toBeNull();
  });

  it("embeds when bullet is travelling away from surface (dot >= 0)", () => {
    // Vector3 imported at top of file
    const n = new Vector3(0, 1, 0);
    const d = new Vector3(0, 1, 0); // travelling UP — dot = +1
    const r = computeRicochet(n, d, "steel_plate");
    expect(r.direction).toBeNull();
  });

  it("reflects the bullet direction across the surface normal on a successful ricochet", () => {
    // Vector3 imported at top of file
    const n = new Vector3(0, 1, 0); // ground
    // shallow 20° downward angle — dot = -sin(20°) ≈ -0.342 (in valid range).
    const angle = (20 * Math.PI) / 180;
    const d = new Vector3(Math.cos(angle), -Math.sin(angle), 0);
    // Force the probability roll to succeed by mocking Math.random.
    const orig = Math.random;
    Math.random = () => 0; // always < prob
    try {
      // Steel plate (50% prob).
      const r = computeRicochet(n, d, "steel_plate");
      expect(r.direction).not.toBeNull();
      // Reflected direction should have +Y (bounced up).
      expect(r.direction!.y).toBeGreaterThan(0);
      expect(r.damageMult).toBe(0.5); // RICOCHET_DAMAGE_MULT
      expect(r.range).toBe(10); // RICOCHET_RANGE
    } finally {
      Math.random = orig;
    }
  });

  it("respects the probability gate (low roll → embed, high roll → ricochet)", () => {
    // Vector3 imported at top of file
    const n = new Vector3(0, 1, 0);
    const angle = (20 * Math.PI) / 180;
    const d = new Vector3(Math.cos(angle), -Math.sin(angle), 0);
    const orig = Math.random;
    // Concrete = 0.30 prob. random=0.29 → ricochet; random=0.31 → embed.
    Math.random = () => 0.29;
    const r1 = computeRicochet(n, d, "concrete");
    Math.random = () => 0.31;
    const r2 = computeRicochet(n, d, "concrete");
    Math.random = orig;
    expect(r1.direction).not.toBeNull();
    expect(r2.direction).toBeNull();
  });
});

describe("Ballistics surface penetration table", () => {
  it("returns 0 velocity mult for steel_plate (impenetrable)", () => {
    expect(getSurfacePenetrationMult("steel_plate")).toBe(0);
  });

  it("returns near-1 for foliage/glass (negligible resistance)", () => {
    expect(getSurfacePenetrationMult("foliage")).toBeCloseTo(0.98, 2);
    expect(getSurfacePenetrationMult("glass")).toBeCloseTo(0.95, 2);
  });

  it("falls back to 0.35 (concrete-ish) for unknown surfaces", () => {
    expect(getSurfacePenetrationMult("unobtainium")).toBeCloseTo(0.35, 2);
  });

  it("sniper rounds penetrate more of a surface than pistol rounds", () => {
    expect(getCategoryPenetrationMult("SNIPER")).toBeGreaterThan(getCategoryPenetrationMult("PISTOL"));
  });

  it("testSurfacePenetration composes surface × category multipliers", () => {
    // wood=0.75 × rifle=1.00 → 0.75
    const r = testSurfacePenetration("wood", "RIFLE");
    expect(r.velocityMult).toBeCloseTo(0.75, 2);
    expect(r.penetrates).toBe(true);
    // steel_plate=0 × sniper=1.30 → 0 (impenetrable)
    const steel = testSurfacePenetration("steel_plate", "SNIPER");
    expect(steel.velocityMult).toBe(0);
    expect(steel.penetrates).toBe(false);
    // sandbag=0.05 × shotgun=0.10 → 0.005 (penetrates=false, <0.05)
    const sb = testSurfacePenetration("sandbag", "SHOTGUN");
    expect(sb.penetrates).toBe(false);
  });
});

describe("Ballistics hitzone classification", () => {
  it("head parts get 4× damage multiplier", () => {
    expect(getHitZoneMult("head")).toBe(4.0);
    expect(classifyHitZone("head")).toBe("head");
    expect(classifyHitZone("helmet")).toBe("head");
    expect(classifyHitZone("neck")).toBe("head");
    expect(classifyHitZone("eyeL")).toBe("head");
  });

  it("chest parts get 1× damage multiplier", () => {
    expect(getHitZoneMult("chest")).toBe(1.0);
    expect(classifyHitZone("body")).toBe("chest");
    expect(classifyHitZone("vest")).toBe("chest");
    expect(classifyHitZone("abdomen")).toBe("chest");
  });

  it("limb parts get 0.7× damage multiplier (default for unknown parts)", () => {
    expect(getHitZoneMult("limb")).toBe(0.7);
    expect(classifyHitZone("lArm")).toBe("limb");
    expect(classifyHitZone("rLeg")).toBe("limb");
    expect(classifyHitZone("")).toBe("limb"); // empty
    expect(classifyHitZone("unknownPouch")).toBe("limb");
  });

  it("falls back to 1× for undefined/unknown zone string", () => {
    expect(getHitZoneMult(undefined)).toBe(1.0);
    expect(getHitZoneMult("nonexistent_zone")).toBe(1.0);
  });
});

describe("Ballistics per-weapon overrides", () => {
  it("returns the category baseline for weapons without overrides", () => {
    const m4 = getWeaponBallisticParams("m4", "RIFLE");
    expect(m4.velocity).toBe(BALLISTIC_PARAMS.RIFLE.velocity);
    expect(m4.mass).toBe(BALLISTIC_PARAMS.RIFLE.mass);
  });

  it("merges per-weapon override onto the category baseline (AK-74 = 5.45mm)", () => {
    const ak = getWeaponBallisticParams("ak74", "RIFLE");
    expect(ak.velocity).toBe(900); // override
    expect(ak.mass).toBe(3.4);     // override
    expect(ak.dragCoef).toBe(0.0013); // override
    expect(ak.gravityScale).toBe(0.95); // override
    expect(ak.dropMultiplier).toBe(BALLISTIC_PARAMS.RIFLE.dropMultiplier); // inherited
  });

  it("falls back to RIFLE baseline for unknown categories", () => {
    expect(getBallisticParams("UNKNOWN_CATEGORY")).toBe(DEFAULT_BALLISTIC_PARAMS);
  });
});

// ============================================================================
// Section B — Prompts 161–166 + 286: advanced ballistics tests.
// ============================================================================

describe("Section B — subsonic ammo (#161)", () => {
  it("subsonic ammo type flagged correctly", () => {
    expect(AMMO_TYPES.subsonic.subsonic).toBe(true);
    expect(AMMO_TYPES.fmj.subsonic).toBe(false);
  });
  it("subsonic bullets produce no sonic crack", () => {
    const sub = getAmmoType("subsonic");
    expect(producesSonicCrack(400, sub)).toBe(false);
  });
  it("supersonic FMJ produces sonic crack", () => {
    const fmj = getAmmoType("fmj");
    expect(producesSonicCrack(800, fmj)).toBe(true);
    expect(producesSonicCrack(300, fmj)).toBe(false);
  });
  it("subsonic reduces suppression", () => {
    expect(AMMO_TYPES.subsonic.suppressionMult).toBeLessThan(0.5);
  });
});

describe("Section B — transonic destabilization (#162)", () => {
  it("drag multiplier is 1.0 outside the transonic band", () => {
    expect(transonicDragMult(200)).toBe(1.0);
    expect(transonicDragMult(500)).toBe(1.0);
  });
  it("drag multiplier peaks at Mach 1", () => {
    const peak = transonicDragMult(SPEED_OF_SOUND);
    const edge = transonicDragMult(TRANSONIC_BAND_LOW + 1);
    expect(peak).toBeGreaterThan(edge);
    expect(peak).toBeGreaterThan(1.0);
  });
  it("transonic band is centered on Mach 1", () => {
    expect(TRANSONIC_BAND_LOW).toBeLessThan(SPEED_OF_SOUND);
    expect(TRANSONIC_BAND_HIGH).toBeGreaterThan(SPEED_OF_SOUND);
  });
});

describe("Section B — wind gusts (#163)", () => {
  it("gust adds ±30% to base wind", () => {
    const base = 10;
    const g1 = gustWindSpeed(base, 0, 0);
    const g2 = gustWindSpeed(base, 2.5, 0); // 5s period peak
    expect(g1).toBeGreaterThan(0);
    expect(g2).toBeGreaterThan(0);
    // Gust is non-constant — different times give different wind speeds.
    expect(g1).not.toBe(g2);
  });
  it("gust is 0 when base wind is 0", () => {
    expect(gustWindSpeed(0, 100, 0)).toBe(0);
  });
});

describe("Section B — Coriolis + spin drift (#164)", () => {
  it("Coriolis drift is 0 below 800m", () => {
    expect(coriolisDriftM(500, 0.6, 45, 0)).toBe(0);
  });
  it("Coriolis drift is non-zero at 1000m mid-latitude", () => {
    const drift = coriolisDriftM(1000, 1.2, 45, 0);
    expect(Math.abs(drift)).toBeGreaterThan(0);
    expect(Math.abs(drift)).toBeLessThan(0.5); // small (~10cm)
  });
  it("Magnus spin drift is 0 below 800m", () => {
    expect(magnusSpinDriftM(500)).toBe(0);
  });
  it("Magnus spin drift is non-zero at 1500m", () => {
    expect(magnusSpinDriftM(1500)).toBeGreaterThan(0);
  });
});

describe("Section B — G1/G7 drag model (#165)", () => {
  it("G7 (sniper) has lower drag than G1 at high Mach", () => {
    const bc1 = { model: "G1" as const, bc: 0.305 };
    const bc7 = { model: "G7" as const, bc: 0.220 };
    const baseline = 0.0014;
    const drag1 = gModelDragCoef(800, bc1, baseline);
    const drag7 = gModelDragCoef(800, bc7, baseline);
    // G7 should produce less drag at high velocity (more aerodynamic).
    expect(drag7).toBeLessThan(drag1);
  });
  it("drag peaks at Mach 1 (transonic)", () => {
    const bc = DEFAULT_BC_BY_CATEGORY.RIFLE;
    const baseline = 0.0014;
    const subDrag = gModelDragCoef(200, bc, baseline);
    const mach1Drag = gModelDragCoef(SPEED_OF_SOUND, bc, baseline);
    const superDrag = gModelDragCoef(600, bc, baseline);
    expect(mach1Drag).toBeGreaterThan(subDrag);
    expect(mach1Drag).toBeGreaterThan(superDrag);
  });
});

describe("Section B — spin rate decay (#166)", () => {
  it("scatter is 0 inside 800m", () => {
    expect(spinStabilityScatter(1.0, 500)).toBe(0);
  });
  it("scatter grows past 800m at long flight times", () => {
    const scatter = spinStabilityScatter(2.0, 1500);
    expect(Math.abs(scatter)).toBeGreaterThan(0);
  });
  it("combined destabilization scatter is small", () => {
    const s = computeDestabilizationScatter(400, 1.5, 1000);
    expect(Math.abs(s.lateral)).toBeLessThan(0.01);
    expect(Math.abs(s.vertical)).toBeLessThan(0.01);
  });
});

describe("Section B — sniper trace visibility (#286)", () => {
  it("sniper trace fades with velocity", () => {
    const v1 = sniperTraceVisibilityMult(900, 900, true);
    const v2 = sniperTraceVisibilityMult(100, 900, true);
    expect(v1).toBeGreaterThan(v2);
  });
  it("non-sniper returns 1.0", () => {
    expect(sniperTraceVisibilityMult(500, 900, false)).toBe(1.0);
  });
});
