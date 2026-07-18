/**
 * Section D — Weapon Engraving System.
 *
 * Real-world gunsmiths offer custom engravings: scrollwork, family crests,
 * names, kill counts, military insignia. Engraving is permanent (carved
 * into the metal), unlike paint jobs (which can be re-applied).
 *
 * This module:
 *   1. Defines engraving types (text, scrollwork, insignia, kill marks).
 *   2. Specifies where on the weapon an engraving can go.
 *   3. Generates the SVG / canvas path for rendering the engraving.
 *   4. Computes the cost (credits) for the engraving.
 *   5. Tracks engraved kill counts (engraving updates with milestones).
 *
 * Engine integration: the WeaponBuilder reads `engravingDecalPaths()` to
 * apply the engraving texture; the HudSystem reads `engravingLabel()` for
 * the inspect UI; the Gunsmith reads `engravingOptions()` for the UI.
 */

import type { WeaponType } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Engraving types.
// ─────────────────────────────────────────────────────────────────────────────

export type EngravingType =
  | "text"          // custom text (name, motto, serial number).
  | "scrollwork"    // floral / vine pattern.
  | "insignia"      // military unit insignia.
  | "kill_marks"    // tally marks for confirmed kills.
  | "headshot_marks" // marks for confirmed headshots.
  | "family_crest"  // pre-designed crest patterns.
  | "kanji"         // Japanese characters.
  | "latin_phrase"; // pre-set Latin phrases.

export interface EngravingTypeSpec {
  type: EngravingType;
  /** Cost (credits). */
  cost: number;
  /** Maximum character count (for text-based engravings). */
  maxChars: number;
  /** Whether the engraving is text or graphical. */
  isText: boolean;
  /** Label for the UI. */
  label: string;
}

export const ENGRAVING_TYPE_SPECS: Record<EngravingType, EngravingTypeSpec> = {
  text:            { type: "text", cost: 500, maxChars: 24, isText: true,  label: "Custom Text" },
  scrollwork:      { type: "scrollwork", cost: 2500, maxChars: 0, isText: false, label: "Scrollwork" },
  insignia:        { type: "insignia", cost: 1800, maxChars: 0, isText: false, label: "Unit Insignia" },
  kill_marks:      { type: "kill_marks", cost: 100, maxChars: 0, isText: false, label: "Kill Marks" },
  headshot_marks:  { type: "headshot_marks", cost: 100, maxChars: 0, isText: false, label: "Headshot Marks" },
  family_crest:    { type: "family_crest", cost: 3500, maxChars: 0, isText: false, label: "Family Crest" },
  kanji:           { type: "kanji", cost: 800, maxChars: 4, isText: true,  label: "Kanji" },
  latin_phrase:    { type: "latin_phrase", cost: 600, maxChars: 32, isText: true,  label: "Latin Phrase" },
};

// Pre-set Latin phrases (real-world martial mottos).
export const LATIN_PHRASES: string[] = [
  "Memento Mori",
  "Sic Semper Tyrannis",
  "Si Vis Pacem Para Bellum",
  "Aut Vincere Aut Mori",
  "De Oppresso Liber",
  "Semper Fidelis",
  "Death Before Dishonor",
  "Veni Vidi Vici",
  "Mors Ab Alto",
  "Nemo Me Impune Lacessit",
];

// Pre-set Kanji characters with their meanings.
export const KANJI_PRESETS: { kanji: string; meaning: string }[] = [
  { kanji: "侍", meaning: "Samurai" },
  { kanji: "武士道", meaning: "Way of the Warrior" },
  { kanji: "死亡", meaning: "Death" },
  { kanji: "運命", meaning: "Fate" },
  { kanji: "名誉", meaning: "Honor" },
  { kanji: "戦士", meaning: "Warrior" },
  { kanji: "影", meaning: "Shadow" },
  { kanji: "魂", meaning: "Soul" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Engraving placement — where on the weapon it goes.
// ─────────────────────────────────────────────────────────────────────────────

export type EngravingPlacement =
  | "receiver_top"     // top of receiver, behind the charging handle.
  | "receiver_side"    // side of receiver (most common).
  | "barrel"           // barrel (between chamber and gas block).
  | "magazine_well"    // mag well (visible from below).
  | "stock"            // stock (wooden stocks especially).
  | "dust_cover"       // dust cover (AK pattern).
  | "bolt_handle"      // bolt handle knob (snipers).
  | "trigger_guard";   // trigger guard (subtle).

export interface EngravingPlacementSpec {
  placement: EngravingPlacement;
  /** Maximum engraving size (mm²). */
  maxSizeMm2: number;
  /** Whether the placement is on a curved surface. */
  curved: boolean;
  /** Visibility (0..1, 1 = most visible). */
  visibility: number;
  /** Label for the UI. */
  label: string;
}

export const ENGRAVING_PLACEMENTS: Record<EngravingPlacement, EngravingPlacementSpec> = {
  receiver_top:   { placement: "receiver_top",   maxSizeMm2: 200,  curved: false, visibility: 0.6, label: "Receiver Top" },
  receiver_side:  { placement: "receiver_side",  maxSizeMm2: 600,  curved: false, visibility: 1.0, label: "Receiver Side" },
  barrel:         { placement: "barrel",         maxSizeMm2: 300,  curved: true,  visibility: 0.7, label: "Barrel" },
  magazine_well:  { placement: "magazine_well",  maxSizeMm2: 150,  curved: false, visibility: 0.4, label: "Magazine Well" },
  stock:          { placement: "stock",          maxSizeMm2: 800,  curved: false, visibility: 0.8, label: "Stock" },
  dust_cover:     { placement: "dust_cover",     maxSizeMm2: 400,  curved: true,  visibility: 0.9, label: "Dust Cover" },
  bolt_handle:    { placement: "bolt_handle",    maxSizeMm2: 50,   curved: true,  visibility: 0.5, label: "Bolt Handle" },
  trigger_guard:  { placement: "trigger_guard",  maxSizeMm2: 100,  curved: true,  visibility: 0.3, label: "Trigger Guard" },
};

// Per-weapon compatible placements.
const WEAPON_PLACEMENTS: Partial<Record<WeaponType, EngravingPlacement[]>> = {
  // AR-pattern: receiver side + dust cover + barrel + mag well.
  m4:   ["receiver_side", "dust_cover", "barrel", "magazine_well"],
  hk416: ["receiver_side", "dust_cover", "barrel", "magazine_well"],
  scarh: ["receiver_side", "barrel", "magazine_well"],
  // AK-pattern: dust cover (large flat surface) + receiver side.
  ak74: ["dust_cover", "receiver_side"],
  galil: ["dust_cover", "receiver_side"],
  // Snipers: receiver side + stock + bolt handle.
  awp:    ["receiver_side", "stock", "bolt_handle"],
  l115a3: ["receiver_side", "stock", "bolt_handle"],
  kar98k: ["receiver_side", "stock", "bolt_handle"],
  // Pistols: receiver side (slide).
  usp:    ["receiver_side"],
  deagle: ["receiver_side", "barrel"],
  m1911:  ["receiver_side"],
  // Shotguns: receiver side + stock.
  nova:   ["receiver_side", "stock"],
  spas12: ["receiver_side", "stock"],
  // LMGs: receiver side + barrel.
  m249:   ["receiver_side", "barrel"],
  mk48:   ["receiver_side", "barrel"],
};

export function engravingPlacementsFor(weapon: WeaponType): EngravingPlacement[] {
  return WEAPON_PLACEMENTS[weapon] ?? ["receiver_side"];
}

// ─────────────────────────────────────────────────────────────────────────────
// Engraving recipe.
// ─────────────────────────────────────────────────────────────────────────────

export interface EngravingRecipe {
  /** Engraving type. */
  type: EngravingType;
  /** Where on the weapon. */
  placement: EngravingPlacement;
  /** Text content (for text-based engravings). */
  text?: string;
  /** Font size (mm). */
  fontSizeMm: number;
  /** Fill color (engravings can be filled with black/gold/silver). */
  fillColor: EngravingFill;
  /** Whether to add a border. */
  border: boolean;
}

export type EngravingFill = "none" | "black" | "gold" | "silver" | "copper" | "red";

export const ENGRAVING_FILL_COLORS: Record<EngravingFill, string> = {
  none: "#3a3a3e",
  black: "#0a0a0a",
  gold: "#d4af37",
  silver: "#c0c0c0",
  copper: "#b87333",
  red: "#dc2626",
};

/** Default engraving recipe. */
export function defaultEngraving(): EngravingRecipe {
  return {
    type: "text",
    placement: "receiver_side",
    text: "",
    fontSizeMm: 4,
    fillColor: "none",
    border: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG path generation — for the WeaponBuilder to render to a texture.
// ─────────────────────────────────────────────────────────────────────────────

export interface EngravingRenderSpec {
  /** SVG path data or text. */
  data: string;
  /** Width (mm). */
  widthMm: number;
  /** Height (mm). */
  heightMm: number;
  /** Fill color hex. */
  fillHex: string;
  /** Stroke (border) color hex, or null for no border. */
  strokeHex: string | null;
  /** Opacity (0..1). */
  opacity: number;
}

/**
 * Generate the render spec for an engraving. Returns the SVG path data
 * or text content + dimensions for the WeaponBuilder to bake into a texture.
 */
export function engravingRenderSpec(recipe: EngravingRecipe): EngravingRenderSpec {
  const placement = ENGRAVING_PLACEMENTS[recipe.placement];
  const typeSpec = ENGRAVING_TYPE_SPECS[recipe.type];
  const fillHex = ENGRAVING_FILL_COLORS[recipe.fillColor];

  // Default dimensions based on placement.
  let widthMm = Math.sqrt(placement.maxSizeMm2) * 1.5;
  let heightMm = Math.sqrt(placement.maxSizeMm2) * 0.5;

  // Text engraving.
  if (typeSpec.isText) {
    const text = recipe.text ?? "";
    // Width = font size × char count.
    widthMm = Math.min(widthMm, recipe.fontSizeMm * text.length * 0.6);
    heightMm = recipe.fontSizeMm * 1.2;
    return {
      data: text,
      widthMm, heightMm,
      fillHex,
      strokeHex: recipe.border ? "#1a1a1a" : null,
      opacity: 1.0,
    };
  }

  // Graphical engravings — return an SVG path placeholder.
  let svgPath = "";
  switch (recipe.type) {
    case "scrollwork":
      // Curving vine pattern.
      svgPath = "M0,10 Q10,0 20,10 T40,10 T60,10 T80,10";
      widthMm = 80; heightMm = 20;
      break;
    case "insignia":
      // Star + laurel.
      svgPath = "M50,10 L60,40 L90,40 L65,55 L75,85 L50,65 L25,85 L35,55 L10,40 L40,40 Z";
      widthMm = 100; heightMm = 100;
      break;
    case "kill_marks":
      // Tally marks — one per kill.
      svgPath = "M0,10 L0,40 M10,10 L10,40 M20,10 L20,40 M30,10 L30,40 M40,5 L45,45";
      widthMm = 50; heightMm = 50;
      break;
    case "headshot_marks":
      // Crosshair circles.
      svgPath = "M20,0 A20,20 0 1,1 19.99,0 Z M60,0 A20,20 0 1,1 59.99,0 Z";
      widthMm = 100; heightMm = 40;
      break;
    case "family_crest":
      // Shield outline.
      svgPath = "M50,5 L95,5 L95,50 Q95,85 50,95 Q5,85 5,50 L5,5 Z";
      widthMm = 100; heightMm = 100;
      break;
  }

  return {
    data: svgPath,
    widthMm, heightMm,
    fillHex,
    strokeHex: recipe.border ? "#1a1a1a" : null,
    opacity: 0.8,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kill-mark engraving — updates with milestone kills.
// ─────────────────────────────────────────────────────────────────────────────

export interface KillMarkEngravingState {
  /** Confirmed kills (total). */
  kills: number;
  /** Confirmed headshots. */
  headshots: number;
  /** Milestone engravings unlocked (every 50 kills + every 25 headshots). */
  milestones: string[];
}

export function initKillMarkEngraving(): KillMarkEngravingState {
  return { kills: 0, headshots: 0, milestones: [] };
}

/** Record a kill; returns updated state + the milestone reached (if any). */
export function recordKill(
  state: KillMarkEngravingState,
  isHeadshot: boolean,
): { state: KillMarkEngravingState; milestone: string | null } {
  const newKills = state.kills + 1;
  const newHeadshots = state.headshots + (isHeadshot ? 1 : 0);
  let milestone: string | null = null;

  // Kill milestones.
  if (newKills === 10) milestone = "First Blood";
  else if (newKills === 50) milestone = "Veteran";
  else if (newKills === 100) milestone = "Centurion";
  else if (newKills === 250) milestone = "Reaper";
  else if (newKills === 500) milestone = "Legend";
  else if (newKills === 1000) milestone = "Mythic";

  // Headshot milestones.
  if (newHeadshots === 25) milestone = "Marksman";
  else if (newHeadshots === 100) milestone = "Sharpshooter";
  else if (newHeadshots === 250) milestone = "Sniper Elite";

  const milestones = milestone ? [...state.milestones, milestone] : state.milestones;
  return {
    state: { kills: newKills, headshots: newHeadshots, milestones },
    milestone,
  };
}

/** Format the kill-mark label. */
export function killMarkLabel(state: KillMarkEngravingState): string {
  const kills = "†".repeat(Math.min(50, state.kills));
  const headshots = "⊕".repeat(Math.min(25, state.headshots));
  return `${kills}${headshots}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI helpers.
// ─────────────────────────────────────────────────────────────────────────────

export function engravingLabel(recipe: EngravingRecipe): string {
  const typeSpec = ENGRAVING_TYPE_SPECS[recipe.type];
  const placement = ENGRAVING_PLACEMENTS[recipe.placement];
  if (typeSpec.isText && recipe.text) {
    return `"${recipe.text}" — ${placement.label}`;
  }
  return `${typeSpec.label} — ${placement.label}`;
}

export function engravingOptions(weapon: WeaponType): { type: EngravingType; spec: EngravingTypeSpec }[] {
  return (Object.keys(ENGRAVING_TYPE_SPECS) as EngravingType[])
    .map((t) => ({ type: t, spec: ENGRAVING_TYPE_SPECS[t] }));
}

export function engravingCost(recipe: EngravingRecipe): number {
  const typeSpec = ENGRAVING_TYPE_SPECS[recipe.type];
  let cost = typeSpec.cost;
  if (recipe.fillColor !== "none") cost += 200;
  if (recipe.border) cost += 100;
  return cost;
}

export function validateEngraving(recipe: EngravingRecipe): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const typeSpec = ENGRAVING_TYPE_SPECS[recipe.type];
  if (typeSpec.isText) {
    if (!recipe.text || recipe.text.length === 0) {
      errors.push("Text engraving requires text content.");
    } else if (recipe.text.length > typeSpec.maxChars) {
      errors.push(`Text exceeds ${typeSpec.maxChars} characters.`);
    }
  }
  return { valid: errors.length === 0, errors };
}
