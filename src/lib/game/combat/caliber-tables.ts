/**
 * Section C — Real ballistic data tables for the 5 core calibers.
 * Sources: Federal, Lake City, Speer, Hornady, Winchester manufacturer
 * published data (ICAO standard atmosphere at sea level).
 *
 * Velocities given in feet-per-second (fps) per spec; a metric (m/s)
 * conversion is included for the ballistic engine.
 */

/** Conversion factor: 1 fps = 0.3048 m/s (exact). */
export const FPS_TO_MPS = 0.3048;

/** A single caliber's real-world ballistic profile. */
export interface CaliberEntry {
  /** Short slug used as the table key. */
  slug: string;
  /** Human-readable designation. */
  name: string;
  /** Bullet mass in grains. */
  massGrains: number;
  /** Bullet mass in grams. */
  massGrams: number;
  /** Muzzle velocity in feet per second (manufacturer spec). */
  muzzleVelocityFps: number;
  /** Muzzle velocity in meters per second. */
  muzzleVelocityMps: number;
  /** G1 ballistic coefficient (dimensionless). */
  g1Bc: number;
  /** Muzzle energy in joules. */
  muzzleEnergyJ: number;
  /** Recommended zero distance in meters. */
  recommendedZeroM: number;
  /** Practical max effective range in meters. */
  maxEffectiveRangeM: number;
  /** Weapon family this caliber belongs to. */
  category: "rifle" | "pistol" | "sniper" | "shotgun";
}

// ─── Per-caliber real data ───────────────────────────────────────────────────

const M855: CaliberEntry = {
  slug: "m855", name: "5.56×45mm NATO M855",
  massGrains: 62, massGrams: 4.01,
  muzzleVelocityFps: 2900, muzzleVelocityMps: 2900 * FPS_TO_MPS,
  g1Bc: 0.304, muzzleEnergyJ: 1640,
  recommendedZeroM: 200, maxEffectiveRangeM: 500, category: "rifle",
};

const M80: CaliberEntry = {
  slug: "m80", name: "7.62×51mm NATO M80",
  massGrains: 147, massGrams: 9.53,
  muzzleVelocityFps: 2600, muzzleVelocityMps: 2600 * FPS_TO_MPS,
  g1Bc: 0.397, muzzleEnergyJ: 3340,
  recommendedZeroM: 300, maxEffectiveRangeM: 800, category: "rifle",
};

const NINE_MM: CaliberEntry = {
  slug: "9mm", name: "9×19mm Parabellum",
  massGrains: 124, massGrams: 8.04,
  muzzleVelocityFps: 1200, muzzleVelocityMps: 1200 * FPS_TO_MPS,
  g1Bc: 0.150, muzzleEnergyJ: 520,
  recommendedZeroM: 25, maxEffectiveRangeM: 50, category: "pistol",
};

const LAPUA_338: CaliberEntry = {
  slug: "338_lm", name: ".338 Lapua Magnum",
  massGrains: 250, massGrams: 16.20,
  muzzleVelocityFps: 3000, muzzleVelocityMps: 3000 * FPS_TO_MPS,
  g1Bc: 0.605, muzzleEnergyJ: 6770,
  recommendedZeroM: 300, maxEffectiveRangeM: 1500, category: "sniper",
};

const TWELVE_GA: CaliberEntry = {
  slug: "12ga_buck", name: "12-Gauge 00 Buckshot",
  massGrains: 480, massGrams: 31.10,
  muzzleVelocityFps: 1325, muzzleVelocityMps: 1325 * FPS_TO_MPS,
  g1Bc: 0.080, muzzleEnergyJ: 2480,
  recommendedZeroM: 25, maxEffectiveRangeM: 50, category: "shotgun",
};

/**
 * Master caliber table — keyed by slug. Real published ballistic data
 * for the 5 core calibers used throughout the combat system.
 */
export const CALIBER_TABLE: Record<string, CaliberEntry> = {
  m855: M855,
  m80: M80,
  "9mm": NINE_MM,
  "338_lm": LAPUA_338,
  "12ga_buck": TWELVE_GA,
};

/** Resolve a caliber entry by slug (falls back to M855). */
export function getCaliber(slug: string): CaliberEntry {
  return CALIBER_TABLE[slug] ?? M855;
}

/** All caliber slugs in stable order. */
export const CALIBER_SLUGS: string[] = Object.keys(CALIBER_TABLE);
