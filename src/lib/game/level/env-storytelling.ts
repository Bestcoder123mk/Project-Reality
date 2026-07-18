/**
 * SEC9-LEVEL — Prompt 74: Environmental storytelling per map.
 *
 * Scatter non-interactive visual props (documents, photos, graffiti, bullet
 * holes, abandoned personal effects, memorials, log entries) that tell a
 * wordless story per map. The player discovers the story by approaching +
 * looking at the props; an inspect text appears via `window.__PR_INSPECT__`
 * when the player's line of sight lands on a prop within range.
 *
 * Per-map story scripts (at least 3 props per map for the 3 required maps —
 * Bunker, Mansion, Subway — plus extra props on the others):
 *
 *   - Bunker:  "The Last Transmission" — garrison held the line, sent one
 *     final message, was overrun.
 *   - Mansion: "The Field Hospital"    — estate became a field hospital,
 *     abandoned in a hurry as the front collapsed.
 *   - Subway:  "The Last Train"        — station was an evac point; the
 *     last train out was overwhelmed.
 *   - Compound, Warehouse, Rooftops, Desert, Alley, Training, Practice Range:
 *     smaller vignettes (1–3 props each) for atmosphere.
 *
 * All props are non-interactive — they have no colliders + don't affect
 * gameplay. The engine spawns them as instanced meshes (one InstancedMesh
 * per prop type per map) to keep draw calls low. See `buildStoryProps`
 * for the THREE-side builder; this module is data + inspect logic only.
 *
 * `window.__PR_INSPECT__` is the public HUD channel:
 *   - Engine: each frame, calls `findHoveredStoryProp(mapSlug, playerPos, playerYaw)`
 *     and writes `window.__PR_INSPECT__ = result?.inspectText ?? ""`.
 *   - HUD:    reads `window.__PR_INSPECT__` each rAF; if non-empty, renders
 *             the text in a centered inspect prompt (typ. "[E] inspect" or
 *             just the flavor text).
 */

import * as THREE from "three";

// ─── Public types ────────────────────────────────────────────────────────

/** Visual prop archetype. Each maps to a different instanced-mesh builder. */
export type StoryPropType =
  | "document"          // paper / letter / clipboard
  | "photo"             // framed photo on a wall or desk
  | "graffiti"          // spray-painted text/art on a wall
  | "personal_effect"   // abandoned item (toy, watch, glasses, etc.)
  | "damage_pattern"    // bullet holes, scorch marks, blood splatter
  | "warning_sign"      // hazard tape, warning placard
  | "memorial"          // small memorial (cross, candles, photo)
  | "log_entry";        // computer terminal / log book

/** A non-interactive visual prop with optional inspect text. */
export interface StoryProp {
  /** Unique id within the map. */
  id: string;
  /** Visual archetype — drives the instanced-mesh builder. */
  type: StoryPropType;
  /** World position [x, y, z]. */
  position: [number, number, number];
  /** Yaw rotation (radians). */
  rotY?: number;
  /** Optional inspect text — shown when the player hovers + is within range. */
  inspectText?: string;
  /** Color hint (hex) for the instanced mesh. */
  color?: number;
  /** Size override [w, h, d] for the instanced mesh (defaults per type). */
  size?: [number, number, number];
}

/** Per-map story script — array of props + a one-line theme summary. */
export interface MapStoryScript {
  /** Map slug this script belongs to. */
  mapSlug: string;
  /** Story theme (informational — for the design dashboard). */
  theme: string;
  /** One-paragraph story summary (informational). */
  summary: string;
  /** The props scattered across the map. */
  props: StoryProp[];
}

// ─── Tunables ────────────────────────────────────────────────────────────

/** Max distance (m) at which a prop's inspect text is shown. */
export const INSPECT_RANGE = 3.0;
/** Half-angle (radians) of the inspect cone in front of the player.
 *  ≈ 18° — props inside this cone + within range are "hovered". */
export const INSPECT_CONE_HALF_ANGLE = Math.PI / 10;

// ─── Per-map story scripts ───────────────────────────────────────────────

const BUNKER_STORY: StoryProp[] = [
  {
    id: "bunker_log_final_transmission",
    type: "log_entry",
    position: [0, 0.9, 0],
    inspectText: "FINAL TRANSMISSION LOG — 03:47\n\"Holding the line. Send reinforcements. We have wounded.\"\n— Signal lost 03:49.",
    color: 0x2a2a2a,
  },
  {
    id: "bunker_damage_glass",
    type: "damage_pattern",
    position: [0, 1.4, -6],
    inspectText: "Bullet holes pattern the glass partition — the defenders were shot through it.",
    color: 0x101010,
    size: [3, 1.4, 0.05],
  },
  {
    id: "bunker_warning_biohazard",
    type: "warning_sign",
    position: [16, 1.6, -16],
    rotY: Math.PI,
    inspectText: "WARNING — BIOHAZARD QUARANTINE\nDo not enter without MOPP-4. Witness reports of \"aggressive casualties.\"",
    color: 0xc8a000,
    size: [1.0, 0.6, 0.04],
  },
  {
    id: "bunker_photo_family",
    type: "photo",
    position: [-19.5, 1.2, -19.5],
    rotY: Math.PI / 4,
    inspectText: "A faded family photo tucked into the corner of a desk. Two kids, a wife, a dog. The desk's owner never came back for it.",
    color: 0x8a7858,
    size: [0.25, 0.18, 0.02],
  },
  {
    id: "bunker_memorial_se",
    type: "memorial",
    position: [19, 0, 19],
    inspectText: "A field memorial — two candles, a wooden cross, a name scratched into the wall: \"SGT. KOWALSKI — HELD THE LINE.\"",
    color: 0x6a5a3a,
    size: [0.6, 1.2, 0.2],
  },
  {
    id: "bunker_document_roatmap",
    type: "document",
    position: [-8, 0.45, 14],
    rotY: 0.6,
    inspectText: "A creased operations map. Red marks show fallback positions collapsing one by one toward the central command room.",
    color: 0xb0a890,
    size: [0.4, 0.001, 0.3],
  },
];

const MANSION_STORY: StoryProp[] = [
  {
    id: "mansion_doc_triage",
    type: "document",
    position: [0, 0.5, 2],
    inspectText: "A field-hospital triage chart. The names get fewer toward the bottom of the page. The last entry is illegible — the doctor's hand was shaking.",
    color: 0xc0b088,
    size: [0.45, 0.001, 0.32],
  },
  {
    id: "mansion_photo_family",
    type: "photo",
    position: [-22, 1.5, -22],
    rotY: Math.PI,
    inspectText: "A gilt-framed portrait of the family that once lived here. The frame is cracked — a bullet graze, not age.",
    color: 0x8a6840,
    size: [0.5, 0.65, 0.04],
  },
  {
    id: "mansion_graffiti_we_tried",
    type: "graffiti",
    position: [-35.5, 2.0, 8],
    rotY: Math.PI / 2,
    inspectText: "Spray-painted on the perimeter wall in fading red: \"WE TRIED.\"",
    color: 0xa02020,
    size: [2.5, 0.8, 0.04],
  },
  {
    id: "mansion_effect_bear",
    type: "personal_effect",
    position: [3, 0.25, -3],
    inspectText: "A child's stuffed bear, mud-caked. One button eye missing. Found under a cot in what was the pediatric ward.",
    color: 0x8a5a3a,
    size: [0.25, 0.35, 0.2],
  },
  {
    id: "mansion_damage_scorch",
    type: "damage_pattern",
    position: [-16, 0, 18],
    inspectText: "Scorch marks streak the courtyard flagstones — the aftermath of a vehicle-borne attack. The burned-out car still sits at the center.",
    color: 0x101010,
    size: [3, 0.001, 3],
  },
  {
    id: "mansion_warning_quarantine",
    type: "warning_sign",
    position: [22, 1.6, -22],
    rotY: -Math.PI / 4,
    inspectText: "QUARANTINE — INFECTED WARD\nNo exit without decontamination. Last staff rotation: 11 days ago.",
    color: 0xc08000,
    size: [1.0, 0.6, 0.04],
  },
];

const SUBWAY_STORY: StoryProp[] = [
  {
    id: "subway_log_departure",
    type: "log_entry",
    position: [-25, 1.0, -25],
    inspectText: "DEPARTURE LOG — TICKET BOOTH\nLAST TRAIN: 14:23 — DESTINATION: NORTH TERMINAL — STATUS: FULL.\nNext scheduled train: never.",
    color: 0x2a2a2a,
  },
  {
    id: "subway_warning_evac",
    type: "warning_sign",
    position: [0, 2.5, 32],
    inspectText: "EVACUATION POINT — WAIT FOR ESCORT\nDo not board trains without escort. Hold your child's hand. Stay calm.",
    color: 0xa02020,
    size: [1.4, 0.7, 0.04],
  },
  {
    id: "subway_photo_train",
    type: "photo",
    position: [-12, 1.0, -8],
    inspectText: "A photo tucked into a train-car seat — a family of four at a birthday party. The ticket stub next to it is for the 14:23.",
    color: 0x8a7858,
    size: [0.25, 0.18, 0.02],
  },
  {
    id: "subway_graffiti_never_made_it",
    type: "graffiti",
    position: [-19.5, 2.5, -10],
    rotY: Math.PI / 2,
    inspectText: "Scratched into the concourse wall, then traced over with spray paint so it wouldn't fade: \"WE NEVER MADE IT OUT.\"",
    color: 0xa02020,
    size: [3, 0.9, 0.04],
  },
  {
    id: "subway_memorial_platform",
    type: "memorial",
    position: [0, 0, -38],
    inspectText: "A platform-side memorial — candles burned down to stubs, photos in ziplock bags, names scratched into the tile: 47 of them.",
    color: 0x6a5a3a,
    size: [1.5, 1.0, 0.3],
  },
  {
    id: "subway_damage_jumpad",
    type: "damage_pattern",
    position: [12, 1.0, -15],
    inspectText: "Bullet holes stitch across the wall behind the jump pad — the last stand was here. Casings pile in the corner.",
    color: 0x101010,
    size: [2, 1.2, 0.05],
  },
];

// Smaller vignettes for the other maps (atmosphere only — not required by the
// spec, but included so every map feels like a place with a past).
const COMPOUND_STORY: StoryProp[] = [
  {
    id: "compound_doc_intel",
    type: "document",
    position: [0, 0.5, 1.5],
    inspectText: "An intel briefing on the compound's defenses, last updated 6 days ago. The defensive positions on the east side have been crossed out and replaced with \"OVERWHELMED.\"",
    color: 0xb0a890,
    size: [0.4, 0.001, 0.3],
  },
  {
    id: "compound_warning_motorpool",
    type: "warning_sign",
    position: [28, 1.6, 22],
    rotY: Math.PI,
    inspectText: "MOTOR POOL — FUEL HAZARD\nNo open flame within 20m. Barrels contain unleaded fuel.",
    color: 0xc08000,
    size: [0.9, 0.55, 0.04],
  },
  {
    id: "compound_memorial_tower",
    type: "memorial",
    position: [-40, 0, -40],
    inspectText: "A wooden cross at the base of the NW watchtower — \"PFC ROSSI. FELL WATCHING.\"",
    color: 0x6a5a3a,
    size: [0.4, 1.0, 0.15],
  },
];

const WAREHOUSE_STORY: StoryProp[] = [
  {
    id: "warehouse_doc_manifest",
    type: "document",
    position: [0, 0.5, 10],
    inspectText: "A shipping manifest. The last inbound shipment was 9 days ago — \"MEDICAL SUPPLIES, URGENT.\" It never arrived at the field hospital.",
    color: 0xc0b088,
    size: [0.4, 0.001, 0.3],
  },
  {
    id: "warehouse_graffiti_loader",
    type: "graffiti",
    position: [-34.5, 3.0, -10],
    rotY: Math.PI / 2,
    inspectText: "Chalked on the loading-bay wall: \"LOADER 3 NEVER CAME BACK.\"",
    color: 0xd0d0d0,
    size: [2.5, 0.7, 0.04],
  },
];

const ROOFTOPS_STORY: StoryProp[] = [
  {
    id: "rooftops_doc_observer",
    type: "document",
    position: [-22, 1.6, -22],
    inspectText: "A spotter's logbook — last entry 4 days ago. \"0400: movement on the south bridge. 0500: lost contact with Rooftop 6.\" No further entries.",
    color: 0xb0a890,
    size: [0.3, 0.001, 0.22],
  },
  {
    id: "rooftops_graffiti_rooftop6",
    type: "graffiti",
    position: [0, 1.0, -39.5],
    inspectText: "Spray-painted on the parapet facing south: \"ROOFTOP 6 — GONE.\"",
    color: 0xa02020,
    size: [2.5, 0.7, 0.04],
  },
];

const DESERT_STORY: StoryProp[] = [
  {
    id: "desert_doc_patrol",
    type: "document",
    position: [0, 0.5, 0],
    inspectText: "A patrol log on the command-tent desk. The last patrol east never returned. The next patrol has been \"postponed indefinitely.\"",
    color: 0xc0b088,
    size: [0.4, 0.001, 0.3],
  },
  {
    id: "desert_warning_fuel",
    type: "warning_sign",
    position: [-27, 1.4, 8],
    rotY: 0,
    inspectText: "FUEL FARM — NO SMOKING\nViolators will be shot on sight. There is no water to put out a fuel fire.",
    color: 0xc08000,
    size: [1.0, 0.6, 0.04],
  },
];

const ALLEY_STORY: StoryProp[] = [
  {
    id: "alley_graffiti_quarantine",
    type: "graffiti",
    position: [-34, 3, 0],
    rotY: Math.PI / 2,
    inspectText: "Spray-painted across the storefront shutter: \"QUARANTINE — DO NOT ENTER.\" Below it, in a different hand: \"WE LIVE HERE.\"",
    color: 0xa02020,
    size: [3, 1.0, 0.04],
  },
  {
    id: "alley_doc_raid",
    type: "document",
    position: [-30, 0.5, -34],
    inspectText: "A raid warrant on the floor of a corner store. The date is 3 weeks ago. The suspect was never found.",
    color: 0xc0b088,
    size: [0.4, 0.001, 0.3],
  },
];

const TRAINING_STORY: StoryProp[] = [
  {
    id: "training_doc_curriculum",
    type: "document",
    position: [-22, 0.5, 1.5],
    inspectText: "A training curriculum posted in the CQB house. The last class graduated 2 months ago. The next class is \"pending instructor availability.\"",
    color: 0xb0a890,
    size: [0.4, 0.001, 0.3],
  },
  {
    id: "training_warning_range",
    type: "warning_sign",
    position: [-3, 1.6, 30],
    inspectText: "FIRING RANGE — EYE + EAR PROTECTION MANDATORY\nNo loaded weapons behind the firing line.",
    color: 0xc08000,
    size: [1.2, 0.6, 0.04],
  },
];

const PRACTICE_RANGE_STORY: StoryProp[] = [
  {
    id: "practice_doc_zero",
    type: "document",
    position: [0, 0.5, 53],
    inspectText: "A weapons-zeroing card — fill in your name, weapon, optic, and the click adjustments for 25m and 50m. The previous user's name has been scratched out.",
    color: 0xc0b088,
    size: [0.4, 0.001, 0.3],
  },
];

// ─── Map story registry ──────────────────────────────────────────────────

export const MAP_STORY_SCRIPTS: Record<string, MapStoryScript> = {
  bunker: {
    mapSlug: "bunker",
    theme: "The Last Transmission",
    summary: "The garrison held the line, sent one final message, was overrun.",
    props: BUNKER_STORY,
  },
  mansion: {
    mapSlug: "mansion",
    theme: "The Field Hospital",
    summary: "The estate became a field hospital, abandoned in a hurry as the front collapsed.",
    props: MANSION_STORY,
  },
  subway: {
    mapSlug: "subway",
    theme: "The Last Train",
    summary: "The station was an evacuation point; the last train out was overwhelmed.",
    props: SUBWAY_STORY,
  },
  compound: {
    mapSlug: "compound",
    theme: "The Overrun Perimeter",
    summary: "The compound's east defenses were marked \"OVERWHELMED\" on the last intel update.",
    props: COMPOUND_STORY,
  },
  warehouse: {
    mapSlug: "warehouse",
    theme: "The Missing Shipment",
    summary: "The last medical shipment never arrived; Loader 3 never came back.",
    props: WAREHOUSE_STORY,
  },
  rooftops: {
    mapSlug: "rooftops",
    theme: "The Lost Watch",
    summary: "The rooftop spotter network lost contact with Rooftop 6 at 0500.",
    props: ROOFTOPS_STORY,
  },
  desert: {
    mapSlug: "desert",
    theme: "The Vanished Patrol",
    summary: "The last east patrol never returned; further patrols postponed.",
    props: DESERT_STORY,
  },
  alley: {
    mapSlug: "alley",
    theme: "The Quarantine",
    summary: "A raid warrant, a quarantine notice, a neighborhood that refused to leave.",
    props: ALLEY_STORY,
  },
  training: {
    mapSlug: "training",
    theme: "The Empty Schoolhouse",
    summary: "The training schedule reads \"pending instructor availability\" — for months now.",
    props: TRAINING_STORY,
  },
  practice_range: {
    mapSlug: "practice_range",
    theme: "The Previous Shooter",
    summary: "A zeroing card with the previous user's name scratched out.",
    props: PRACTICE_RANGE_STORY,
  },
};

// ─── Public accessors ────────────────────────────────────────────────────

/** Get the story script for a map (props + theme + summary). */
export function getStoryScript(mapSlug: string): MapStoryScript | null {
  return MAP_STORY_SCRIPTS[mapSlug] ?? null;
}

/** Get just the story props for a map. Empty array if no script. */
export function getStoryProps(mapSlug: string): StoryProp[] {
  return MAP_STORY_SCRIPTS[mapSlug]?.props ?? [];
}

/** Get all map story scripts (for the design dashboard). */
export function getAllStoryScripts(): MapStoryScript[] {
  return Object.values(MAP_STORY_SCRIPTS);
}

// ─── Inspect logic ───────────────────────────────────────────────────────

/** Internal: squared distance between a prop position and a world point. */
function dist2(
  propPos: [number, number, number],
  world: { x: number; y: number; z: number },
): number {
  const dx = propPos[0] - world.x;
  const dy = propPos[1] - world.y;
  const dz = propPos[2] - world.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Internal: is the prop in front of the player (inside the inspect cone)?
 *  Player forward is derived from yaw: forward = (sin(yaw), 0, -cos(yaw)) in
 *  the same convention as PlayerState (yaw=0 looks toward -Z, +yaw turns
 *  clockwise viewed from above). */
function isInInspectCone(
  propPos: [number, number, number],
  playerPos: { x: number; y: number; z: number },
  playerYaw: number,
): boolean {
  const dx = propPos[0] - playerPos.x;
  const dz = propPos[2] - playerPos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return true; // prop is on top of the player — treat as in-cone
  // Forward direction (yaw convention: forward = (sin(yaw), 0, -cos(yaw))).
  const fx = Math.sin(playerYaw);
  const fz = -Math.cos(playerYaw);
  // cos(angle) = (dx*fz + dz*fz) / len
  const cosA = (dx * fx + dz * fz) / len;
  // cosA >= cos(halfAngle)  ⟺  angle <= halfAngle
  return cosA >= Math.cos(INSPECT_CONE_HALF_ANGLE);
}

/** Find the story prop the player is currently hovering on (looking at + in
 *  range). Returns null if no prop qualifies. The engine calls this each
 *  frame and writes `window.__PR_INSPECT__ = result?.inspectText ?? ""`. */
export function findHoveredStoryProp(
  mapSlug: string,
  playerPos: { x: number; y: number; z: number },
  playerYaw: number,
  maxDist: number = INSPECT_RANGE,
): StoryProp | null {
  const props = getStoryProps(mapSlug);
  if (props.length === 0) return null;
  const maxDist2 = maxDist * maxDist;
  let best: StoryProp | null = null;
  let bestDist2 = Infinity;
  for (const p of props) {
    if (!p.inspectText) continue;
    const d2 = dist2(p.position, playerPos);
    if (d2 > maxDist2) continue;
    if (!isInInspectCone(p.position, playerPos, playerYaw)) continue;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      best = p;
    }
  }
  return best;
}

/** Convenience: get the inspect text for the currently-hovered prop.
 *  Returns "" if nothing is hovered. */
export function getInspectText(
  mapSlug: string,
  playerPos: { x: number; y: number; z: number },
  playerYaw: number,
  maxDist: number = INSPECT_RANGE,
): string {
  return findHoveredStoryProp(mapSlug, playerPos, playerYaw, maxDist)?.inspectText ?? "";
}

// ────────────────────────────────────────────────────────────────────────────
// K-5000 prompt mapping (this file owns):
//   #4229 [env-storytelling inspect HUD prompt] — new
//         `getInspectHudPrompt(mapSlug, playerPos, playerYaw)` function
//         returns the formatted HUD prompt the engine should render when
//         the player hovers a story prop. Previously the HUD only showed
//         the raw inspect text (the engine wrote `inspectText` to
//         `window.__PR_INSPECT__` directly), which meant the player had
//         no affordance to press a key to inspect — they'd just see
//         flavor text appear. Now the prompt is "[E] Inspect — <text>"
//         (or just "[E] Inspect" if no inspect text is set), signaling
//         the inspect interaction + showing the flavor text in the same
//         HUD element.
//   #4366 [cross-ref to 4229] — see marker above.
// ────────────────────────────────────────────────────────────────────────────

/** K-5000 #4229 — HUD key the player presses to inspect a hovered story
 *  prop. Defaults to "E" (the de-facto FPS interact key). Configurable
 *  via setInspectHudKey() so the engine's input-remap system can sync. */
let _inspectHudKey = "E";

/** K-5000 #4229 — set the inspect HUD key (called by the engine's
 *  input-remap system on keybind changes). */
export function setInspectHudKey(key: string): void {
  _inspectHudKey = key.toUpperCase().slice(0, 4);
}

/** K-5000 #4229 — get the formatted HUD prompt for the currently-hovered
 *  story prop. Returns "" if nothing is hovered. Format:
 *    "[E] Inspect — FINAL TRANSMISSION LOG — 03:47\n..."
 *  or just "[E] Inspect" if the prop has no inspectText (still signals
 *  the interaction). The HUD reads this via `window.__PR_INSPECT_HUD__`
 *  (set by the engine each frame) OR by direct call. */
export function getInspectHudPrompt(
  mapSlug: string,
  playerPos: { x: number; y: number; z: number },
  playerYaw: number,
  maxDist: number = INSPECT_RANGE,
): string {
  const hovered = findHoveredStoryProp(mapSlug, playerPos, playerYaw, maxDist);
  if (!hovered) return "";
  const key = `[${_inspectHudKey}]`;
  if (hovered.inspectText) {
    return `${key} Inspect — ${hovered.inspectText}`;
  }
  return `${key} Inspect`;
}

// ─── window.__PR_INSPECT_HUD__ global declaration ─────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  interface Window {
    /** SEC9-LEVEL — Prompt 74: the inspect text the HUD should render this
     *  frame. The engine sets it each frame via `findHoveredStoryProp`;
     *  the HUD reads it via rAF. Empty string = no inspect prompt.
     *
     *  K-5000 #4229 — superseded by __PR_INSPECT_HUD__ (the formatted
     *  prompt with the inspect-key affordance). Kept for backward compat
     *  with HUDs that render the raw inspect text. */
    __PR_INSPECT__?: string;
    /** K-5000 #4229 — the formatted HUD prompt for the currently-hovered
     *  story prop. Format: "[E] Inspect — <inspectText>". Empty string
     *  = no prop hovered. The HUD should prefer this over __PR_INSPECT__
     *  so the player sees the inspect-key affordance. */
    __PR_INSPECT_HUD__?: string;
  }
}

// ─── THREE-side builder (lazy — called by the engine on map load) ────────

/** Build all story props for a map as instanced meshes + add them to the
 *  scene. Returns the array of instanced meshes (so the engine can dispose
 *  them on map switch). Each prop type gets its own InstancedMesh. */
export function buildStoryProps(
  mapSlug: string,
  scene: THREE.Scene,
): THREE.InstancedMesh[] {
  const props = getStoryProps(mapSlug);
  if (props.length === 0) return [];

  // Group props by type so we can build one InstancedMesh per type.
  const byType = new Map<StoryPropType, StoryProp[]>();
  for (const p of props) {
    const arr = byType.get(p.type) ?? [];
    arr.push(p);
    byType.set(p.type, arr);
  }

  const meshes: THREE.InstancedMesh[] = [];
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  for (const [type, list] of byType) {
    // Pick geometry + material per type.
    let geo: THREE.BufferGeometry;
    let mat: THREE.Material;
    const defaultColor = list[0]?.color ?? 0x888888;
    switch (type) {
      case "document":
        geo = new THREE.PlaneGeometry(0.4, 0.3);
        mat = new THREE.MeshStandardMaterial({ color: defaultColor, roughness: 0.95, side: THREE.DoubleSide });
        break;
      case "photo":
        geo = new THREE.BoxGeometry(0.3, 0.4, 0.02);
        mat = new THREE.MeshStandardMaterial({ color: defaultColor, roughness: 0.4, metalness: 0.1 });
        break;
      case "graffiti":
        geo = new THREE.PlaneGeometry(2.5, 0.7);
        mat = new THREE.MeshBasicMaterial({ color: defaultColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
        break;
      case "personal_effect":
        geo = new THREE.BoxGeometry(0.25, 0.3, 0.2);
        mat = new THREE.MeshStandardMaterial({ color: defaultColor, roughness: 0.7 });
        break;
      case "damage_pattern":
        geo = new THREE.PlaneGeometry(2, 1);
        mat = new THREE.MeshBasicMaterial({ color: defaultColor, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
        break;
      case "warning_sign":
        geo = new THREE.PlaneGeometry(1.0, 0.6);
        mat = new THREE.MeshStandardMaterial({ color: defaultColor, roughness: 0.4, emissive: defaultColor, emissiveIntensity: 0.15, side: THREE.DoubleSide });
        break;
      case "memorial":
        geo = new THREE.BoxGeometry(0.5, 1.0, 0.15);
        mat = new THREE.MeshStandardMaterial({ color: defaultColor, roughness: 0.85 });
        break;
      case "log_entry":
        geo = new THREE.BoxGeometry(0.3, 0.4, 0.05);
        mat = new THREE.MeshStandardMaterial({ color: defaultColor, roughness: 0.6, metalness: 0.2 });
        break;
      default:
        continue; // unknown type — skip
    }

    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    inst.castShadow = false;
    inst.receiveShadow = false;
    inst.userData.isStoryProp = true;
    inst.userData.storyPropType = type;
    inst.userData.mapSlug = mapSlug;
    list.forEach((p, i) => {
      dummy.position.set(p.position[0], p.position[1], p.position[2]);
      dummy.rotation.set(0, p.rotY ?? 0, 0);
      // Scale to the prop's size override if provided (assumes default geo dims).
      const sizeOverride = p.size;
      if (sizeOverride) {
        const defaultW = (geo as THREE.PlaneGeometry).parameters?.width
          ?? (geo as THREE.BoxGeometry).parameters?.width ?? 1;
        const defaultH = (geo as THREE.PlaneGeometry).parameters?.height
          ?? (geo as THREE.BoxGeometry).parameters?.height ?? 1;
        const defaultD = (geo as THREE.BoxGeometry).parameters?.depth ?? 0.02;
        dummy.scale.set(
          sizeOverride[0] / defaultW,
          sizeOverride[1] / defaultH,
          sizeOverride[2] / defaultD,
        );
      } else {
        dummy.scale.set(1, 1, 1);
      }
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      // Per-instance color (if provided) — uses the InstancedColor attribute.
      color.setHex(p.color ?? defaultColor);
      inst.setColorAt(i, color);
      // Store the prop id on the instance for raycast lookup.
      // (InstancedMesh doesn't have per-instance userData, so the engine
      //  maps instanceId → prop id by index in the same order.)
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);
    meshes.push(inst);
  }
  return meshes;
}

/** Dispose all story-prop instanced meshes for a map (call on map switch).
 *  Returns the number of meshes disposed. */
export function disposeStoryProps(meshes: THREE.InstancedMesh[]): number {
  let n = 0;
  for (const m of meshes) {
    m.geometry?.dispose?.();
    const mat = m.material;
    if (Array.isArray(mat)) {
      for (const mm of mat) mm?.dispose?.();
    } else {
      mat?.dispose?.();
    }
    m.removeFromParent?.();
    n++;
  }
  return n;
}
