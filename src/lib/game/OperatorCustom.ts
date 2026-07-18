/**
 * OperatorCustomization — granular per-player operator appearance overrides.
 *
 * Built on top of the discrete operator catalog (OPERATORS in operators.ts).
 * Each player picks a base preset (Warden / Spectre / Nomad / Vanguard /
 * Phantom) and can then override individual visual fields — skin tone, eye
 * color, lip color, hair color, shirt/pants/jacket/vest/helmet/glove/boot/bag/
 * pouch/pad colors, accent stripe, visor tint, helmet style, plus accessory
 * toggles (NVG, headset, backpack, balaclava, knee pads, elbow pads, sidearm,
 * tactical glasses).
 *
 * Task 28 — the granular color fields + accessory toggles are now part of the
 * OperatorVisual interface itself (operators.ts). This file is the
 * customization state layer: it defines the persisted shape, the declarative
 * UI field spec (CUSTOMIZABLE_FIELDS), and helpers for resolving a
 * customization to a concrete OperatorVisual.
 */

import type { OperatorHelmet, OperatorVisual } from "./operators";
import {
  OPERATORS_BY_SLUG,
  STARTER_OPERATOR_SLUG,
  mergeOperatorVisual,
  getOperatorVisual,
} from "./operators";

/**
 * The full set of customizable override fields. Task 28 — this is now an alias
 * for `Partial<OperatorVisual>` (since OperatorVisual itself carries every
 * granular color + accessory toggle). Kept as a named type for store.ts +
 * UI code that references it by name.
 */
export type OperatorCustomizationOverrides = Partial<OperatorVisual>;

/**
 * The persisted customization: a base preset slug + a partial-visual overrides
 * bag. The base preset determines the starting point; overrides are layered
 * on top via mergeOperatorVisual (operators.ts).
 */
export interface OperatorCustomization {
  /** Which preset to start from ("warden", "spectre", etc.). */
  baseSlug: string;
  /** Per-field overrides — see OperatorVisual for the full field list. */
  overrides: OperatorCustomizationOverrides;
}

/** A customization with no overrides — pure base preset (Warden). */
export const DEFAULT_CUSTOMIZATION: OperatorCustomization = {
  baseSlug: STARTER_OPERATOR_SLUG,
  overrides: {},
};

/**
 * Returns true if a customization is at its preset defaults (no overrides
 * applied). Used by the "Reset to Preset" button to indicate state.
 */
export function isPristine(c: OperatorCustomization): boolean {
  return Object.keys(c.overrides).length === 0;
}

/**
 * Builds a customization rooted at the given preset slug with no overrides.
 */
export function customizationFromPreset(slug: string): OperatorCustomization {
  return { baseSlug: slug, overrides: {} };
}

/**
 * Merges a customization's overrides on top of the base preset's OperatorVisual
 * config. Returns the merged OperatorVisual — the canonical appearance config
 * consumed by buildHumanoid. Uses operators.mergeOperatorVisual so undefined
 * keys don't clobber the base preset's required fields.
 */
export function resolveOperatorVisual(c: OperatorCustomization): OperatorVisual {
  const base =
    OPERATORS_BY_SLUG[c.baseSlug]?.visual ??
    OPERATORS_BY_SLUG[STARTER_OPERATOR_SLUG].visual;
  return mergeOperatorVisual(base, c.overrides);
}

// ============================================================================
// CUSTOMIZABLE_FIELDS — declarative spec that drives the customization UI.
// Iterate over this list to generate the color pickers / sliders / toggles /
// selects in OperatorScreen.tsx. Group controls by `group` for section layout.
// ============================================================================

export type CustomizationGroup =
  | "face"
  | "clothing"
  | "gear"
  | "pads"
  | "details"
  | "helmet"
  | "accessories";

export type CustomizationControlType = "color" | "slider" | "toggle" | "select";

export interface CustomizableField {
  /** Override key this control reads/writes. */
  key: keyof OperatorCustomizationOverrides;
  /** Human-readable label shown next to the control. */
  label: string;
  /** Section grouping in the UI. */
  group: CustomizationGroup;
  /** Control type. */
  type: CustomizationControlType;
  /** For sliders: min/max/step. */
  min?: number;
  max?: number;
  step?: number;
  /** For selects: options. */
  options?: { value: string; label: string }[];
}

/**
 * The declarative spec. OperatorScreen.tsx iterates over this list, groups by
 * `group`, and renders the appropriate control. Adding a new customizable
 * field is a one-line change here.
 */
export const CUSTOMIZABLE_FIELDS: CustomizableField[] = [
  // ─── Face ───────────────────────────────────────────────────────────────
  { key: "skinTone", label: "Skin Tone", group: "face", type: "slider", min: 0, max: 1, step: 0.05 },
  { key: "eyeColor", label: "Eye Color", group: "face", type: "color" },
  { key: "lipColor", label: "Lip Color", group: "face", type: "color" },
  { key: "hairColor", label: "Hair Color", group: "face", type: "color" },

  // ─── Clothing ───────────────────────────────────────────────────────────
  { key: "shirtColor", label: "Shirt", group: "clothing", type: "color" },
  { key: "pantsColor", label: "Pants", group: "clothing", type: "color" },
  { key: "jacketColor", label: "Jacket", group: "clothing", type: "color" },

  // ─── Gear ───────────────────────────────────────────────────────────────
  { key: "vest", label: "Vest", group: "gear", type: "color" },
  { key: "helmet", label: "Helmet", group: "gear", type: "color" },
  { key: "gloveColor", label: "Gloves", group: "gear", type: "color" },
  { key: "bootColor", label: "Boots", group: "gear", type: "color" },
  { key: "bagColor", label: "Backpack", group: "gear", type: "color" },
  { key: "pouchColor", label: "Pouches", group: "gear", type: "color" },

  // ─── Pads ───────────────────────────────────────────────────────────────
  { key: "kneePadColor", label: "Knee Pads", group: "pads", type: "color" },
  { key: "elbowPadColor", label: "Elbow Pads", group: "pads", type: "color" },
  { key: "balaclavaColor", label: "Balaclava", group: "pads", type: "color" },

  // ─── Details ────────────────────────────────────────────────────────────
  { key: "accent", label: "Accent Stripe", group: "details", type: "color" },
  { key: "visorTint", label: "Visor Tint", group: "details", type: "color" },

  // ─── Helmet Style ───────────────────────────────────────────────────────
  {
    key: "helmetStyle",
    label: "Helmet Style",
    group: "helmet",
    type: "select",
    options: [
      { value: "standard", label: "Standard" },
      { value: "full", label: "Full" },
      { value: "cap", label: "Cap" },
      { value: "visor", label: "Visor" },
    ],
  },

  // ─── Accessories ────────────────────────────────────────────────────────
  { key: "hasNVG", label: "NVG Mount", group: "accessories", type: "toggle" },
  { key: "hasHeadset", label: "Headset", group: "accessories", type: "toggle" },
  { key: "hasBackpack", label: "Backpack", group: "accessories", type: "toggle" },
  { key: "hasBalaclava", label: "Balaclava", group: "accessories", type: "toggle" },
  { key: "hasKneePads", label: "Knee Pads", group: "accessories", type: "toggle" },
  { key: "hasElbowPads", label: "Elbow Pads", group: "accessories", type: "toggle" },
  { key: "hasSidearm", label: "Sidearm", group: "accessories", type: "toggle" },
  { key: "hasGlasses", label: "Tactical Glasses", group: "accessories", type: "toggle" },
];

/** Groups in display order (matches the task spec layout). */
export const CUSTOMIZATION_GROUP_ORDER: CustomizationGroup[] = [
  "face",
  "clothing",
  "gear",
  "pads",
  "details",
  "helmet",
  "accessories",
];

/** Human-readable group labels for section headers. */
export const CUSTOMIZATION_GROUP_LABELS: Record<CustomizationGroup, string> = {
  face: "Face",
  clothing: "Clothing",
  gear: "Gear",
  pads: "Pads",
  details: "Details",
  helmet: "Helmet Style",
  accessories: "Accessories",
};

/**
 * Randomizes all color + slider override fields (accessories left alone —
 * randomizing booleans produces a chaotic look). Returns a fresh overrides
 * bag; caller wraps with { baseSlug, overrides } to form a customization.
 *
 * I-5000 #3819 / A-560 — guarded `suit`. The prior code set `suit: hex()`
 * directly, but if `hex()` returned an invalid value (e.g. NaN coerced to
 * "NaN0000" via a Math.random bug), the `suit` field would be invalid +
 * `mergeOperatorVisual` would propagate it. The fix: validate the hex
 * output + fall back to a known-good color when invalid. All required
 * OperatorVisual fields are now guaranteed to be set to a valid value.
 */
export function randomizeOverrides(): OperatorCustomizationOverrides {
  const hex = () => {
    const raw = Math.floor(Math.random() * 0xffffff);
    if (!Number.isFinite(raw) || raw < 0 || raw > 0xffffff) {
      // I-5000 #3819 — fallback for the (impossible-in-practice but
      // defensive) case where Math.random returns an out-of-range value.
      return "#000000";
    }
    return (
      "#" +
      raw.toString(16).padStart(6, "0")
    );
  };
  const overrides: OperatorCustomizationOverrides = {
    suit: hex(),
    accent: hex(),
    vest: hex(),
    helmet: hex(),
    visorTint: hex(),
    skinTone: Math.min(1, Math.max(0, Math.random())),
    helmetStyle: (["standard", "full", "cap", "visor"] as OperatorHelmet[])[
      Math.floor(Math.random() * 4)
    ],
    eyeColor: hex(),
    lipColor: hex(),
    hairColor: hex(),
    shirtColor: hex(),
    pantsColor: hex(),
    jacketColor: hex(),
    gloveColor: hex(),
    bootColor: hex(),
    bagColor: hex(),
    pouchColor: hex(),
    kneePadColor: hex(),
    elbowPadColor: hex(),
    balaclavaColor: hex(),
  };
  // I-5000 #3819 — final guard: ensure every required field is a valid
  // hex string (or number for skinTone). If any failed validation, fall
  // back to the Warden preset's values (the safest default).
  const required = ["suit", "accent", "vest", "helmet", "visorTint"] as const;
  for (const k of required) {
    const v = overrides[k];
    if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) {
      // Replace with a known-good fallback.
      (overrides as Record<string, unknown>)[k] = "#3b4a2f"; // Warden suit color
    }
  }
  if (typeof overrides.skinTone !== "number" || !Number.isFinite(overrides.skinTone)) {
    overrides.skinTone = 0.35; // Warden skin tone
  }
  return overrides;
}

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3819 (undefined suit guarded) — DONE: hex() validates + fallback above.
// 3868 (operator inspect)       — NEW: `inspectOperator` below.
// 3869 (operator abilities/perks differentiation) — NEW: `OPERATOR_ABILITIES` + `OPERATOR_PERKS` below.

/**
 * I-5000 #3868 — Operator inspect. Returns the full operator catalog
 * entry + the resolved visual config (base preset merged with the
 * active customization, if any). The UI's "Inspect" panel renders this
 * verbatim — callsign, faction, rarity, price, description, and the
 * visual config (so the 3D preview matches the persisted appearance).
 */
export function inspectOperator(slug: string): {
  slug: string;
  name: string;
  callsign: string;
  faction: string;
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
  price: number;
  description: string;
  visual: OperatorVisual;
} | null {
  const entry = OPERATORS_BY_SLUG[slug];
  if (!entry) return null;
  return {
    slug: entry.slug,
    name: entry.name,
    callsign: entry.callsign,
    faction: entry.faction,
    rarity: entry.rarity,
    price: entry.price,
    description: entry.description,
    visual: getOperatorVisual(slug),
  };
}

// `getOperatorVisual` is imported at the top of this file (alongside
// OPERATORS_BY_SLUG etc.) — kept there to avoid a mid-file import.

/**
 * I-5000 #3869 / A-53 — Operator ability + perk differentiation. Each
 * operator now has a signature ability (active, cooldown-based) + a
 * passive perk (always-on). The catalog below defines the per-operator
 * abilities + perks; the engine reads this to wire the gameplay effects
 * (the wiring itself is in WeaponSystem / MovementFeelSystem — out of
 * this file's scope). The `OPERATOR_ABILITIES` + `OPERATOR_PERKS`
 * registries are the canonical source of truth for what each operator
 * does differently.
 */
export interface OperatorAbility {
  slug: string;
  operatorSlug: string;
  name: string;
  description: string;
  cooldownSec: number;
  durationSec: number;
  effect:
    | "thermal_vision" // see enemies through walls for duration
    | "speed_boost" // +30% move speed for duration
    | "damage_resist" // -40% damage taken for duration
    | "ammo_refill" // instant magazine refill
    | "recon_ping" // ping all enemies in radius
    | "cloak" // invisibility for duration
    | "shield" // deployable cover
    | "grenade_rain"; // call in 3 grenades on marked position
}

export const OPERATOR_ABILITIES: OperatorAbility[] = [
  { slug: "warden_recon_ping", operatorSlug: "warden", name: "Recon Ping", description: "Ping all enemies within 50m for 3s", cooldownSec: 45, durationSec: 3, effect: "recon_ping" },
  { slug: "spectre_cloak", operatorSlug: "spectre", name: "Cloak", description: "Invisibility for 5s", cooldownSec: 60, durationSec: 5, effect: "cloak" },
  { slug: "nomad_speed_boost", operatorSlug: "nomad", name: "Adrenaline", description: "+30% move speed for 8s", cooldownSec: 40, durationSec: 8, effect: "speed_boost" },
  { slug: "vanguard_shield", operatorSlug: "vanguard", name: "Deploy Shield", description: "Deploy a ballistic shield cover", cooldownSec: 35, durationSec: 20, effect: "shield" },
  { slug: "phantom_thermal", operatorSlug: "phantom", name: "Thermal Vision", description: "See enemies through walls for 6s", cooldownSec: 50, durationSec: 6, effect: "thermal_vision" },
];

export interface OperatorPerk {
  slug: string;
  operatorSlug: string;
  name: string;
  description: string;
  effect:
    | "faster_aim" // -10% ADS time
    | "faster_reload" // -15% reload time
    | "extra_ammo" // +25% magazine capacity
    | "faster_move" // +5% move speed
    | "reduced_recoil" // -10% recoil
    | "faster_ability_cd" // -20% ability cooldown
    | "silent_steps" // reduced footstep audibility
    | "bonus_credits"; // +10% credits per match
}

export const OPERATOR_PERKS: OperatorPerk[] = [
  { slug: "warden_perk", operatorSlug: "warden", name: "Steady Aim", description: "-10% ADS time", effect: "faster_aim" },
  { slug: "spectre_perk", operatorSlug: "spectre", name: "Silent Steps", description: "Reduced footstep audibility", effect: "silent_steps" },
  { slug: "nomad_perk", operatorSlug: "nomad", name: "Light Pack", description: "+5% move speed", effect: "faster_move" },
  { slug: "vanguard_perk", operatorSlug: "vanguard", name: "Heavy Mag", description: "+25% magazine capacity", effect: "extra_ammo" },
  { slug: "phantom_perk", operatorSlug: "phantom", name: "Quick Reset", description: "-20% ability cooldown", effect: "faster_ability_cd" },
];

/** Look up an operator's ability. Returns null for unknown operators. */
export function getOperatorAbility(operatorSlug: string): OperatorAbility | null {
  return OPERATOR_ABILITIES.find((a) => a.operatorSlug === operatorSlug) ?? null;
}

/** Look up an operator's perk. Returns null for unknown operators. */
export function getOperatorPerk(operatorSlug: string): OperatorPerk | null {
  return OPERATOR_PERKS.find((p) => p.operatorSlug === operatorSlug) ?? null;
}
