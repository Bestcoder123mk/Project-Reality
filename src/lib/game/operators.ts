/**
 * V3 — Operator catalog.
 *
 * Discrete operator skins (NOT a slider-based avatar creator). Each operator
 * is a complete character identity: callsign, faction, rarity, price, and a
 * visual config consumed by the rig builder (buildHumanoid) to skin the
 * shared humanoid mesh differently. One skeleton, N swappable skins — exactly
 * the architecture the V-Series master prompt specifies.
 *
 * Licensing: all operators are self-designed original characters (no sourced
 * assets). Visual configs are procedural (colors + helmet variants) applied to
 * the in-house humanoid mesh, so there are no third-party licensing concerns.
 */

export type OperatorHelmet = "standard" | "full" | "cap" | "visor";

export interface OperatorVisual {
  /** Jumpsuit base color (hex). */
  suit: string;
  /** Accent color — team stripe on shoulder + visor emissive tint (hex). */
  accent: string;
  /** Plate carrier / vest color (hex). */
  vest: string;
  /** Helmet shell color (hex). */
  helmet: string;
  /** Visor tint (hex) — driven by accent for a cohesive look. */
  visorTint: string;
  /** Skin tone 0..1 (maps to an 8-stop palette). */
  skinTone: number;
  /** Helmet style — drives which head gear the rig builder assembles. */
  helmetStyle: OperatorHelmet;

  // ─── Task 28: granular color overrides (all optional — fall back to
  //     derived defaults when undefined). Backward compatible: existing
  //     presets don't set these, so they render exactly as before.
  /** Iris color (e.g. "#4a3a2a" brown, "#3a5a8a" blue). Default: random. */
  eyeColor?: string;
  /** Lip tint (e.g. "#b06a5a"). Default: fixed natural lip tint. */
  lipColor?: string;
  /** Hair / stubble / eyebrow color. Default: random. */
  hairColor?: string;
  /** Upper jumpsuit / torso color (overrides `suit` for torso + sleeves). */
  shirtColor?: string;
  /** Lower jumpsuit / legs color (overrides `suit` for hips + legs). */
  pantsColor?: string;
  /** Outer jacket layer worn over the shirt. Default: darker `suit` shade. */
  jacketColor?: string;
  /** Backpack color. Default: derived from `vest`. */
  bagColor?: string;
  /** Glove color (overrides `vest` for gloves). Default: `vest`. */
  gloveColor?: string;
  /** Boot color. Default: fixed dark rubber. */
  bootColor?: string;
  /** Pouches + belts color. Default: fixed dark pouch. */
  pouchColor?: string;
  /** Knee pad color. Default: fixed dark pad. */
  kneePadColor?: string;
  /** Elbow pad color. Default: fixed dark pad. */
  elbowPadColor?: string;
  /** Balaclava / face mask color. Default: darker `suit` shade. */
  balaclavaColor?: string;

  // ─── Task 28: accessory toggles (all optional — default true).
  /** Night vision mount on helmet. */
  hasNVG?: boolean;
  /** Ear protection + boom mic headset. */
  hasHeadset?: boolean;
  /** Assault pack on back. */
  hasBackpack?: boolean;
  /** Face mask (for full/visor/standard helmets). */
  hasBalaclava?: boolean;
  /** Knee pads. */
  hasKneePads?: boolean;
  /** Elbow pads. */
  hasElbowPads?: boolean;
  /** Holstered sidearm on thigh. */
  hasSidearm?: boolean;
  /** Tactical glasses under helmet. */
  hasGlasses?: boolean;
}

export interface OperatorCatalogEntry {
  slug: string;
  name: string;
  callsign: string;
  faction: string;
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
  price: number;
  description: string;
  visual: OperatorVisual;
}

/** The 8-stop skin palette (matches context-factory.ts / OperatorPreview3D.tsx). */
export const SKIN_STOPS = [
  "#fce7d4", "#f0c8a8", "#d9a878", "#c08858",
  "#a06840", "#804828", "#603818", "#3a2418",
];

export function skinToneHex(t: number): string {
  const idx = Math.min(SKIN_STOPS.length - 1, Math.max(0, Math.floor(t * (SKIN_STOPS.length - 1))));
  return SKIN_STOPS[idx];
}

export function skinToneHexNum(t: number): number {
  return parseInt(skinToneHex(t).replace("#", "0x"));
}

export const OPERATORS: OperatorCatalogEntry[] = [
  {
    slug: "warden",
    name: "Warden",
    callsign: "WARDEN-01",
    faction: "RECON UNIT",
    rarity: "COMMON",
    price: 0,
    description: "Standard-issue reconnaissance operator. Olive drab fatigues, balanced loadout. The every-mission professional.",
    visual: {
      suit: "#3b4a2f",
      accent: "#ff8c1a",
      vest: "#2a3320",
      helmet: "#2a3320",
      visorTint: "#ff8c1a",
      skinTone: 0.35,
      helmetStyle: "standard",
    },
  },
  {
    slug: "spectre",
    name: "Spectre",
    callsign: "SPECTRE-09",
    faction: "ASSAULT CELL",
    rarity: "RARE",
    price: 1200,
    description: "Direct-action assault operator. Charcoal plate carrier, crimson visor, aggressive posture. Built for close quarters.",
    visual: {
      suit: "#1f2226",
      accent: "#e23838",
      vest: "#121417",
      helmet: "#15171a",
      visorTint: "#e23838",
      skinTone: 0.55,
      helmetStyle: "full",
    },
  },
  {
    slug: "nomad",
    name: "Nomad",
    callsign: "NOMAD-22",
    faction: "DESERT CORPS",
    rarity: "RARE",
    price: 1200,
    description: "Arid-environment specialist. Tan desert fatigues, soft cap, sand-worn gear. Thrives where others overheat.",
    visual: {
      suit: "#8a7245",
      accent: "#ffb04a",
      vest: "#6a5a35",
      helmet: "#6a5a35",
      visorTint: "#ffb04a",
      skinTone: 0.45,
      helmetStyle: "cap",
    },
  },
  {
    slug: "vanguard",
    name: "Vanguard",
    callsign: "VANGUARD-07",
    faction: "HEAVY ASSAULT",
    rarity: "EPIC",
    price: 2200,
    description: "Heavy breacher. Reinforced green carrier, full-face tactical visor, layered plates. Walks through walls.",
    visual: {
      suit: "#243a28",
      accent: "#2af0c8",
      vest: "#16241a",
      helmet: "#16241a",
      visorTint: "#2af0c8",
      skinTone: 0.65,
      helmetStyle: "visor",
    },
  },
  {
    slug: "phantom",
    name: "Phantom",
    callsign: "PHANTOM-∞",
    faction: "GHOST DETACHMENT",
    rarity: "LEGENDARY",
    price: 4500,
    description: "Black-ops deniable asset. Matte black fatigues, full-face mirrored visor, no insignia. If you saw it, it wasn't there.",
    visual: {
      suit: "#0c0d10",
      accent: "#a855f7",
      vest: "#050608",
      helmet: "#050608",
      visorTint: "#a855f7",
      skinTone: 0.25,
      helmetStyle: "visor",
    },
  },
];

export const OPERATORS_BY_SLUG: Record<string, OperatorCatalogEntry> = Object.fromEntries(
  OPERATORS.map((o) => [o.slug, o]),
);

/** Default starter operator (owned by every new player). */
export const STARTER_OPERATOR_SLUG = "warden";

/**
 * Active customization slot — set by the game store (setEquippedCustomization)
 * and read by getOperatorVisual so the player avatar + 3D preview reflect
 * persisted overrides. Kept as a module-level variable (not a store import)
 * to avoid a circular import: store.ts -> operators.ts -> store.ts.
 *
 * When the active customization's `baseSlug` matches the slug passed to
 * getOperatorVisual, the overrides are merged on top of the base preset's
 * visual config. Otherwise (e.g. enemies without a slug, or a different
 * preset) the base visual is returned untouched.
 */
let _activeCustomization: { baseSlug: string; overrides: Partial<OperatorVisual> } | null = null;

/**
 * Sets the active customization. Called by the game store when the equipped
 * customization changes (initial load from API + user edits in the
 * customization studio). Pass `null` to clear.
 */
export function setActiveCustomization(c: { baseSlug: string; overrides: Partial<OperatorVisual> } | null): void {
  _activeCustomization = c;
}

/**
 * Task 28 — Merge a customization override onto a preset base visual.
 *
 * Behavior:
 *   - Required fields (suit, accent, vest, helmet, visorTint, skinTone,
 *     helmetStyle) come from `base` unless explicitly overridden in `custom`.
 *   - Optional granular color fields (eyeColor, shirtColor, etc.) are taken
 *     from `custom` if defined, otherwise left `undefined` (so buildHumanoid
 *     falls back to the derived default — see utils.ts).
 *   - Optional accessory toggles (hasNVG, hasHeadset, etc.) are taken from
 *     `custom` if defined, otherwise left `undefined` (buildHumanoid treats
 *     undefined as "default true" via the `?? true` pattern).
 *
 * Pure function — does not mutate `base` or `custom`. Returns a new object.
 */
export function mergeOperatorVisual(
  base: OperatorVisual,
  custom: Partial<OperatorVisual>,
): OperatorVisual {
  // Strip `undefined` keys from `custom` so they don't clobber `base`'s
  // required fields with undefined (Object spread preserves undefined values).
  const defined: Partial<OperatorVisual> = {};
  for (const key in custom) {
    const v = (custom as Record<string, unknown>)[key];
    if (v !== undefined) {
      (defined as Record<string, unknown>)[key] = v;
    }
  }
  return { ...base, ...defined };
}

/**
 * Look up an operator's visual config by slug (falls back to Warden). If the
 * active customization's baseSlug matches, the overrides are merged on top so
 * the player's persisted appearance (suit/vest/helmet/visor/skin/helmet style)
 * is returned. Non-active slugs (enemies, other presets) return the base.
 *
 * Task 28 — an optional `customOverride` can be passed to merge additional
 * per-call overrides on top of the active customization. This is what the
 * customization studio calls while the user is dragging color sliders (live
 * preview without committing to the active customization). Existing callers
 * don't pass it (backward compatible — presets render unchanged).
 */
export function getOperatorVisual(
  slug: string | null | undefined,
  customOverride?: Partial<OperatorVisual>,
): OperatorVisual {
  const base =
    slug && OPERATORS_BY_SLUG[slug]
      ? OPERATORS_BY_SLUG[slug].visual
      : OPERATORS_BY_SLUG[STARTER_OPERATOR_SLUG].visual;
  // Start with the active persisted customization (if the slug matches).
  let merged: OperatorVisual = base;
  if (_activeCustomization && _activeCustomization.baseSlug === slug) {
    merged = mergeOperatorVisual(merged, _activeCustomization.overrides);
  }
  // Layer on any per-call override (live preview from the customization UI).
  if (customOverride && Object.keys(customOverride).length > 0) {
    merged = mergeOperatorVisual(merged, customOverride);
  }
  return merged;
}

/** Rarity → hex color (shared with the weapon-skin rarity language). */
export const OPERATOR_RARITY_COLORS: Record<string, string> = {
  COMMON: "#9ca3af",
  RARE: "#3b82f6",
  EPIC: "#a855f7",
  LEGENDARY: "#f59e0b",
};

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3868 (operator inspect) — DONE in OperatorCustom.ts:inspectOperator.
// 3869 (operator abilities/perks differentiation / A-53) — DONE in
//        OperatorCustom.ts:OPERATOR_ABILITIES + OPERATOR_PERKS.
// The inspect + ability catalogs live in OperatorCustom.ts (the per-player
// customization layer) so the engine can resolve the operator's full
// visual + ability state in one call. This file owns the base catalog
// (OPERATORS + OPERATORS_BY_SLUG + mergeOperatorVisual); the per-operator
// abilities/perks are layered on top in OperatorCustom.ts.
