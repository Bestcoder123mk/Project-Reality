/**
 * Section D — Custom Paint Jobs.
 *
 * Real-world gunsmiths offer custom paint jobs: Cerakote (ceramic-based
 * finish), Duracoat (polymer-based), hydro-dipping (water-transfer printing),
 * and rattle-can (spray paint). Each has different durability, finish
 * quality, and pattern options.
 *
 * The existing `SKINS` system in `store.ts` provides 6 simple color
 * finishes. This module adds a richer paint-job system:
 *
 *   1. Paint system types (cerakote / duracoat / hydro / spray / anodized).
 *   2. Pattern presets (solid, two-tone, camo, digital camo, splatter, marble).
 *   3. Per-pattern color palettes.
 *   4. Paint durability (affects how the paint wears over time).
 *   5. Paint application hints — which weapon parts receive which color.
 *
 * Engine integration: the Wraps/Skins system reads `paintJobRecipe()` to
 * generate the texture; the weapon-wear module reads `paintWearModifier()`
 * to know how the paint degrades; the Gunsmith reads `paintOptions()` for
 * the customization UI.
 */

import type { WeaponType } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Paint systems.
// ─────────────────────────────────────────────────────────────────────────────

export type PaintSystem =
  | "cerakote"    // ceramic-based, oven-cured, very durable.
  | "duracoat"    // polymer-based, air-dry, good durability.
  | "hydro"       // hydro-dip water-transfer printing.
  | "anodized"    // anodized aluminum (only for aluminum parts).
  | "spray"       // rattle-can spray paint (least durable).
  | "parkerized"  // phosphate finish (military).
  | "blued"       // traditional firearm bluing.
  | "raw";        // raw unfinished metal.

export interface PaintSystemSpec {
  system: PaintSystem;
  /** Durability (0..1, 1 = most durable). */
  durability: number;
  /** Cost (credits) — rough price for a full paint job. */
  cost: number;
  /** Number of colors supported. */
  maxColors: number;
  /** Surface finish (matte / satin / gloss). */
  finish: "matte" | "satin" | "gloss";
  /** Reflectivity (0..1). */
  reflectivity: number;
  /** Whether the system supports patterns (camo, hydro). */
  supportsPatterns: boolean;
}

export const PAINT_SYSTEM_SPECS: Record<PaintSystem, PaintSystemSpec> = {
  cerakote: { system: "cerakote", durability: 0.95, cost: 1200, maxColors: 3, finish: "matte", reflectivity: 0.10, supportsPatterns: true },
  duracoat: { system: "duracoat", durability: 0.80, cost: 800, maxColors: 3, finish: "satin", reflectivity: 0.20, supportsPatterns: true },
  hydro:    { system: "hydro", durability: 0.70, cost: 1000, maxColors: 8, finish: "gloss", reflectivity: 0.30, supportsPatterns: true },
  anodized: { system: "anodized", durability: 0.90, cost: 1500, maxColors: 1, finish: "satin", reflectivity: 0.25, supportsPatterns: false },
  spray:    { system: "spray", durability: 0.40, cost: 100, maxColors: 2, finish: "matte", reflectivity: 0.05, supportsPatterns: false },
  parkerized: { system: "parkerized", durability: 0.85, cost: 500, maxColors: 1, finish: "matte", reflectivity: 0.08, supportsPatterns: false },
  blued:    { system: "blued", durability: 0.60, cost: 300, maxColors: 1, finish: "gloss", reflectivity: 0.40, supportsPatterns: false },
  raw:      { system: "raw", durability: 0.30, cost: 0, maxColors: 0, finish: "matte", reflectivity: 0.60, supportsPatterns: false },
};

// ─────────────────────────────────────────────────────────────────────────────
// Paint patterns.
// ─────────────────────────────────────────────────────────────────────────────

export type PaintPattern =
  | "solid"
  | "two_tone"
  | "camo_woodland"
  | "camo_desert"
  | "camo_arctic"
  | "camo_urban"
  | "camo_digital"
  | "camo_tiger"
  | "splatter"
  | "marble"
  | "hydro_skull"
  | "hydro_flag"
  | "hydro_carbon"
  | "hydro_flames"
  | "hydro_stars";

export interface PaintPatternSpec {
  pattern: PaintPattern;
  /** Number of colors required. */
  colorCount: number;
  /** Whether the pattern requires hydro-dip or stencil. */
  requiresHydro: boolean;
  /** Human-readable label. */
  label: string;
}

export const PAINT_PATTERNS: Record<PaintPattern, PaintPatternSpec> = {
  solid:           { pattern: "solid",           colorCount: 1, requiresHydro: false, label: "Solid" },
  two_tone:        { pattern: "two_tone",        colorCount: 2, requiresHydro: false, label: "Two-Tone" },
  camo_woodland:   { pattern: "camo_woodland",   colorCount: 4, requiresHydro: false, label: "Woodland Camo" },
  camo_desert:     { pattern: "camo_desert",     colorCount: 3, requiresHydro: false, label: "Desert Camo" },
  camo_arctic:     { pattern: "camo_arctic",     colorCount: 3, requiresHydro: false, label: "Arctic Camo" },
  camo_urban:      { pattern: "camo_urban",      colorCount: 3, requiresHydro: false, label: "Urban Camo" },
  camo_digital:    { pattern: "camo_digital",    colorCount: 4, requiresHydro: false, label: "Digital Camo" },
  camo_tiger:      { pattern: "camo_tiger",      colorCount: 3, requiresHydro: false, label: "Tiger Stripe" },
  splatter:        { pattern: "splatter",        colorCount: 3, requiresHydro: false, label: "Splatter" },
  marble:          { pattern: "marble",          colorCount: 2, requiresHydro: false, label: "Marble" },
  hydro_skull:     { pattern: "hydro_skull",     colorCount: 4, requiresHydro: true,  label: "Skull Hydro-Dip" },
  hydro_flag:      { pattern: "hydro_flag",      colorCount: 4, requiresHydro: true,  label: "Flag Hydro-Dip" },
  hydro_carbon:    { pattern: "hydro_carbon",    colorCount: 2, requiresHydro: true,  label: "Carbon Fiber Hydro-Dip" },
  hydro_flames:    { pattern: "hydro_flames",    colorCount: 3, requiresHydro: true,  label: "Flames Hydro-Dip" },
  hydro_stars:     { pattern: "hydro_stars",     colorCount: 3, requiresHydro: true,  label: "Stars Hydro-Dip" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Paint job recipe — a complete customization spec.
// ─────────────────────────────────────────────────────────────────────────────

export interface PaintJobRecipe {
  /** Paint system. */
  system: PaintSystem;
  /** Pattern. */
  pattern: PaintPattern;
  /** Color palette (hex strings, length = pattern.colorCount). */
  colors: string[];
  /** Which parts to paint. */
  parts: PaintPart[];
  /** Optional clear-coat layer. */
  clearCoat: boolean;
}

export type PaintPart =
  | "receiver"
  | "barrel"
  | "handguard"
  | "stock"
  | "magazine"
  | "grip"
  | "sights"
  | "muzzle_device";

export const ALL_PAINT_PARTS: PaintPart[] = [
  "receiver", "barrel", "handguard", "stock", "magazine", "grip", "sights", "muzzle_device",
];

/** Default paint job — raw parkerized finish on receiver only. */
export function defaultPaintJob(weapon: WeaponType): PaintJobRecipe {
  void weapon;
  return {
    system: "parkerized",
    pattern: "solid",
    colors: ["#3a3a3e"],
    parts: ["receiver", "barrel"],
    clearCoat: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern → texture generation hints.
// ─────────────────────────────────────────────────────────────────────────────

export interface PaintTextureHints {
  /** Base color (the dominant color). */
  baseColor: string;
  /** Secondary color (for camo / patterns). */
  secondaryColor?: string;
  /** Tertiary color. */
  tertiaryColor?: string;
  /** Quaternary color. */
  quaternaryColor?: string;
  /** Pattern scale (relative to weapon size). Smaller = tighter pattern. */
  patternScale: number;
  /** Reflectivity multiplier. */
  reflectivity: number;
  /** Roughness multiplier (inverse of gloss). */
  roughness: number;
}

/**
 * Compute texture-generation hints from a paint recipe.
 * The actual texture is generated by the WeaponBuilder materials system.
 */
export function paintTextureHints(recipe: PaintJobRecipe): PaintTextureHints {
  const sysSpec = PAINT_SYSTEM_SPECS[recipe.system];
  const patternSpec = PAINT_PATTERNS[recipe.pattern];

  const baseColor = recipe.colors[0] ?? "#3a3a3e";
  const secondaryColor = recipe.colors[1];
  const tertiaryColor = recipe.colors[2];
  const quaternaryColor = recipe.colors[3];

  // Pattern scale — camo patterns are large, hydro-dips are medium, splatter is small.
  let patternScale = 1.0;
  if (recipe.pattern.startsWith("camo")) patternScale = 0.4;
  else if (recipe.pattern.startsWith("hydro")) patternScale = 0.6;
  else if (recipe.pattern === "splatter") patternScale = 0.2;
  else if (recipe.pattern === "marble") patternScale = 0.5;

  // Reflectivity.
  let reflectivity = sysSpec.reflectivity;
  let roughness = sysSpec.finish === "gloss" ? 0.2 : sysSpec.finish === "satin" ? 0.5 : 0.8;
  if (recipe.clearCoat) {
    reflectivity += 0.15;
    roughness = Math.max(0.1, roughness - 0.2);
  }

  void patternSpec;

  return {
    baseColor, secondaryColor, tertiaryColor, quaternaryColor,
    patternScale, reflectivity, roughness,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wear interaction — paint degrades with weapon wear.
// ─────────────────────────────────────────────────────────────────────────────

export interface PaintWearState {
  /** Paint wear fraction (0..1, 1 = paint gone). */
  paintWear: number;
  /** Areas where the paint has worn off (high-friction surfaces). */
  wornAreas: PaintPart[];
  /** Color fade (0..1, 1 = full fade). */
  fade: number;
}

export function initPaintWear(): PaintWearState {
  return { paintWear: 0, wornAreas: [], fade: 0 };
}

/**
 * Apply weapon wear to the paint.
 * @param paintState Current paint wear state.
 * @param weaponWearFraction The weapon's overall wear (0..1).
 * @param system Paint system durability.
 */
export function applyWeaponWearToPaint(
  paintState: PaintWearState,
  weaponWearFraction: number,
  system: PaintSystem,
): PaintWearState {
  const sysSpec = PAINT_SYSTEM_SPECS[system];
  // Paint wears faster than the underlying metal (it's a finish, not the steel).
  // Low-durability paints (spray) wear 3× faster than cerakote.
  const wearMult = 1 / sysSpec.durability;
  const paintWear = Math.min(1, weaponWearFraction * wearMult * 0.8);

  // High-friction surfaces wear first: receiver edges, handguard rail, magwell.
  const wornAreas: PaintPart[] = [];
  if (paintWear > 0.2) wornAreas.push("receiver");
  if (paintWear > 0.4) wornAreas.push("handguard");
  if (paintWear > 0.6) wornAreas.push("magazine");
  if (paintWear > 0.8) wornAreas.push("barrel", "grip", "stock");

  // UV fade from sun exposure — proportional to weapon wear (proxy for age).
  const fade = paintWear * 0.3;

  return { paintWear, wornAreas, fade };
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers.
// ─────────────────────────────────────────────────────────────────────────────

export function paintSystemLabel(system: PaintSystem): string {
  const labels: Record<PaintSystem, string> = {
    cerakote: "Cerakote", duracoat: "Duracoat", hydro: "Hydro-Dip",
    anodized: "Anodized", spray: "Spray Paint", parkerized: "Parkerized",
    blued: "Blued", raw: "Raw",
  };
  return labels[system];
}

export function paintSystemColor(system: PaintSystem): string {
  switch (system) {
    case "cerakote":   return "#10b981"; // green = premium
    case "duracoat":   return "#84cc16";
    case "hydro":      return "#3b82f6";
    case "anodized":   return "#8b5cf6";
    case "spray":      return "#9ca3af";
    case "parkerized": return "#f59e0b";
    case "blued":      return "#06b6d4";
    case "raw":        return "#6b7280";
  }
}

/** All paint systems available in the gunsmith. */
export function paintOptions(): { system: PaintSystem; spec: PaintSystemSpec }[] {
  return (Object.keys(PAINT_SYSTEM_SPECS) as PaintSystem[])
    .map((s) => ({ system: s, spec: PAINT_SYSTEM_SPECS[s] }));
}

/** All patterns available for a paint system. */
export function patternsForSystem(system: PaintSystem): PaintPatternSpec[] {
  const sysSpec = PAINT_SYSTEM_SPECS[system];
  if (!sysSpec.supportsPatterns) {
    return [PAINT_PATTERNS.solid, PAINT_PATTERNS.two_tone];
  }
  return Object.values(PAINT_PATTERNS);
}

/** Cost estimate for a paint job. */
export function paintJobCost(recipe: PaintJobRecipe): number {
  const sysSpec = PAINT_SYSTEM_SPECS[recipe.system];
  const patternSpec = PAINT_PATTERNS[recipe.pattern];
  let cost = sysSpec.cost;
  // Multi-color patterns cost more.
  cost += (patternSpec.colorCount - 1) * 100;
  // More parts cost more.
  cost += recipe.parts.length * 50;
  // Clear coat.
  if (recipe.clearCoat) cost += 200;
  return cost;
}

/** Whether the paint job is valid (colors match pattern, parts non-empty). */
export function validatePaintJob(recipe: PaintJobRecipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const patternSpec = PAINT_PATTERNS[recipe.pattern];
  if (recipe.colors.length !== patternSpec.colorCount) {
    errors.push(`Pattern "${patternSpec.label}" requires ${patternSpec.colorCount} colors (got ${recipe.colors.length}).`);
  }
  if (recipe.parts.length === 0) {
    errors.push("At least one part must be selected for painting.");
  }
  if (patternSpec.requiresHydro && recipe.system !== "hydro") {
    errors.push(`Pattern "${patternSpec.label}" requires the hydro-dip system.`);
  }
  return { valid: errors.length === 0, errors };
}
