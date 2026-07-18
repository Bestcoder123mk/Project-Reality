/**
 * L1-5000 / prompts 4467,4525,4579,4617,4655,4693,4731: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4769,4807,4845,4883,4921,4959,4997 (Controller layouts): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * Prompt I-994 / J-4163 — Controller layout per platform (Xbox / PlayStation / Switch).
 *
 * Maps each in-game action to the canonical button on each platform's
 * gamepad. The InputSystem reads the active platform (auto-detected
 * from the connected gamepad's `id` string) + looks up the layout to
 * decide which button index fires which action.
 *
 * The button indices come from the W3C Gamepad spec's Standard Mapping
 * (https://www.w3.org/TR/gamepad/#remapping), so the Xbox layout is
 * the "natural" one. PS5 + Switch layouts are remappings of the same
 * indices with platform-specific labels.
 *
 * Public API:
 *   - `CONTROLLER_LAYOUTS` — the per-platform layout table.
 *   - `detectControllerPlatform(gamepadId)` — sniff the platform from
 *     the gamepad id string. Returns "xbox" | "playstation" | "switch"
 *     | "generic".
 *   - `getControllerLayout(id?)` — returns the layout for the active
 *     gamepad (or "xbox" as the default for unrecognized pads).
 */

import { GAMEPAD_BUTTONS } from "./gamepad";

export type ControllerPlatform = "xbox" | "playstation" | "switch" | "generic";

/** In-game actions the controller layout maps to buttons. */
export type ControllerAction =
  | "move"
  | "look"
  | "fire"
  | "aim"
  | "reload"
  | "jump"
  | "crouch"
  | "sprint"
  | "melee"
  | "takedown"
  | "weaponNext"
  | "weaponPrev"
  | "slot1"
  | "slot2"
  | "slot3"
  | "slot4"
  | "pause"
  | "map";

export interface ControllerBinding {
  /** Action name. */
  action: ControllerAction;
  /** Button index (GAMEPAD_BUTTONS) or stick index (GAMEPAD_STICKS). */
  input: number | "leftStick" | "rightStick" | "leftTrigger" | "rightTrigger";
  /** Platform-specific label for the UI ("A", "Cross", "B"). */
  label: string;
}

export interface ControllerLayout {
  platform: ControllerPlatform;
  /** Display name for the settings UI. */
  label: string;
  bindings: ControllerBinding[];
}

const B = GAMEPAD_BUTTONS;

// ── Xbox layout (Standard Mapping) ──────────────────────────────────────────

const XBOX_LAYOUT: ControllerLayout = {
  platform: "xbox",
  label: "Xbox",
  bindings: [
    { action: "move", input: "leftStick", label: "Left Stick" },
    { action: "look", input: "rightStick", label: "Right Stick" },
    { action: "fire", input: "rightTrigger", label: "RT" },
    { action: "aim", input: "leftTrigger", label: "LT" },
    { action: "reload", input: B.X, label: "X" },
    { action: "jump", input: B.A, label: "A" },
    { action: "crouch", input: B.B, label: "B" },
    { action: "sprint", input: B.L_STICK, label: "Left Stick (click)" },
    { action: "melee", input: B.RB, label: "RB" },
    { action: "takedown", input: B.LB, label: "LB" },
    { action: "weaponNext", input: B.DPAD_RIGHT, label: "D-Pad →" },
    { action: "weaponPrev", input: B.DPAD_LEFT, label: "D-Pad ←" },
    { action: "slot1", input: B.DPAD_UP, label: "D-Pad ↑" },
    { action: "slot2", input: B.DPAD_DOWN, label: "D-Pad ↓" },
    { action: "pause", input: B.START, label: "Menu" },
    { action: "map", input: B.BACK, label: "View" },
  ],
};

// ── PlayStation layout (DualSense) ──────────────────────────────────────────

const PS_LAYOUT: ControllerLayout = {
  platform: "playstation",
  label: "PlayStation (DualSense)",
  bindings: [
    { action: "move", input: "leftStick", label: "Left Stick" },
    { action: "look", input: "rightStick", label: "Right Stick" },
    { action: "fire", input: "rightTrigger", label: "R2" },
    { action: "aim", input: "leftTrigger", label: "L2" },
    { action: "reload", input: B.X, label: "Square" }, // X button index = Square on PS
    { action: "jump", input: B.A, label: "Cross" },
    { action: "crouch", input: B.B, label: "Circle" },
    { action: "sprint", input: B.L_STICK, label: "L3" },
    { action: "melee", input: B.RB, label: "R1" },
    { action: "takedown", input: B.LB, label: "L1" },
    { action: "weaponNext", input: B.DPAD_RIGHT, label: "D-Pad →" },
    { action: "weaponPrev", input: B.DPAD_LEFT, label: "D-Pad ←" },
    { action: "slot1", input: B.DPAD_UP, label: "D-Pad ↑" },
    { action: "slot2", input: B.DPAD_DOWN, label: "D-Pad ↓" },
    { action: "pause", input: B.START, label: "Options" },
    { action: "map", input: B.BACK, label: "Create" },
  ],
};

// ── Switch layout (Joycons / Pro Controller) ─────────────────────────────────

const SWITCH_LAYOUT: ControllerLayout = {
  platform: "switch",
  label: "Switch (Pro / Joycons)",
  bindings: [
    { action: "move", input: "leftStick", label: "Left Stick" },
    { action: "look", input: "rightStick", label: "Right Stick" },
    { action: "fire", input: "rightTrigger", label: "ZR" },
    { action: "aim", input: "leftTrigger", label: "ZL" },
    { action: "reload", input: B.X, label: "Y" }, // X index = Y on Switch (Nintendo A/B swap)
    { action: "jump", input: B.A, label: "B" },
    { action: "crouch", input: B.B, label: "A" },
    { action: "sprint", input: B.L_STICK, label: "L3" },
    { action: "melee", input: B.RB, label: "R" },
    { action: "takedown", input: B.LB, label: "L" },
    { action: "weaponNext", input: B.DPAD_RIGHT, label: "D-Pad →" },
    { action: "weaponPrev", input: B.DPAD_LEFT, label: "D-Pad ←" },
    { action: "slot1", input: B.DPAD_UP, label: "D-Pad ↑" },
    { action: "slot2", input: B.DPAD_DOWN, label: "D-Pad ↓" },
    { action: "pause", input: B.START, label: "Plus" },
    { action: "map", input: B.BACK, label: "Minus" },
  ],
};

export const CONTROLLER_LAYOUTS: Record<ControllerPlatform, ControllerLayout> = {
  xbox: XBOX_LAYOUT,
  playstation: PS_LAYOUT,
  switch: SWITCH_LAYOUT,
  // Generic fallback — uses the Xbox layout (Standard Mapping).
  generic: { ...XBOX_LAYOUT, platform: "generic", label: "Generic Gamepad" },
};

/**
 * Sniff the controller platform from the gamepad id string. The browser
 * populates `id` with the vendor + product name, e.g.:
 *   - "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)"
 *   - "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"
 *   - "Joy-Con (L+R) (Vendor: 057e Product: 200e)"
 *
 * Falls back to "generic" for unknown pads.
 */
export function detectControllerPlatform(gamepadId: string): ControllerPlatform {
  const id = gamepadId.toLowerCase();
  if (id.includes("xbox") || id.includes("045e")) return "xbox";
  if (id.includes("dualsense") || id.includes("dualshock") || id.includes("054c")) return "playstation";
  if (id.includes("joy-con") || id.includes("pro controller") || id.includes("057e")) return "switch";
  return "generic";
}

/**
 * Returns the layout for the active gamepad. If no gamepad is connected
 * (or the gamepad id isn't recognized), returns the Xbox layout (the
 * Standard Mapping default).
 */
export function getControllerLayout(id?: string): ControllerLayout {
  if (!id) return CONTROLLER_LAYOUTS.xbox;
  return CONTROLLER_LAYOUTS[detectControllerPlatform(id)];
}
