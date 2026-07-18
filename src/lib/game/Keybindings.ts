/**
 * P6.1: Keybinding settings — full rebind support.
 *
 * Default keybindings + a rebind map stored in localStorage. The
 * InputSystem reads from this map (falling back to defaults) instead
 * of hardcoding KeyR/KeyV/KeyQ/etc.
 *
 * Each action has a primary + optional secondary binding. Players can
 * rebind any action via the settings UI (P6.4 panel).
 */

export interface KeyBinding {
  /** Action name (e.g. "reload", "sprint", "fire"). */
  action: string;
  /** Display label. */
  label: string;
  /** Default primary key (KeyboardEvent.code). */
  defaultPrimary: string;
  /** Default secondary key (or null). */
  defaultSecondary: string | null;
  /** Category for grouping in the settings UI. */
  category: "movement" | "combat" | "weapons" | "medical" | "social" | "system";
}

export const DEFAULT_BINDINGS: KeyBinding[] = [
  // Movement
  { action: "forward", label: "Move Forward", defaultPrimary: "KeyW", defaultSecondary: null, category: "movement" },
  { action: "backward", label: "Move Backward", defaultPrimary: "KeyS", defaultSecondary: null, category: "movement" },
  { action: "strafeLeft", label: "Strafe Left", defaultPrimary: "KeyA", defaultSecondary: null, category: "movement" },
  { action: "strafeRight", label: "Strafe Right", defaultPrimary: "KeyD", defaultSecondary: null, category: "movement" },
  { action: "jump", label: "Jump", defaultPrimary: "Space", defaultSecondary: null, category: "movement" },
  { action: "crouch", label: "Crouch", defaultPrimary: "ControlLeft", defaultSecondary: "KeyC", category: "movement" },
  { action: "sprint", label: "Sprint", defaultPrimary: "ShiftLeft", defaultSecondary: null, category: "movement" },
  // Combat
  { action: "fire", label: "Fire Weapon", defaultPrimary: "Mouse0", defaultSecondary: null, category: "combat" },
  { action: "aim", label: "Aim Down Sights", defaultPrimary: "Mouse2", defaultSecondary: null, category: "combat" },
  { action: "melee", label: "Melee Slash", defaultPrimary: "KeyF", defaultSecondary: null, category: "combat" },
  { action: "takedown", label: "Silent Takedown", defaultPrimary: "KeyG", defaultSecondary: null, category: "combat" },
  // Weapons
  { action: "reload", label: "Reload", defaultPrimary: "KeyR", defaultSecondary: null, category: "weapons" },
  { action: "weaponNext", label: "Next Weapon", defaultPrimary: "KeyE", defaultSecondary: "WheelDown", category: "weapons" },
  { action: "weaponPrev", label: "Previous Weapon", defaultPrimary: "KeyQ", defaultSecondary: "WheelUp", category: "weapons" },
  { action: "slot1", label: "Select Primary", defaultPrimary: "Digit1", defaultSecondary: null, category: "weapons" },
  { action: "slot2", label: "Select Secondary", defaultPrimary: "Digit2", defaultSecondary: null, category: "weapons" },
  { action: "slot3", label: "Select Melee", defaultPrimary: "Digit3", defaultSecondary: null, category: "weapons" },
  { action: "slot4", label: "Select Utility", defaultPrimary: "Digit4", defaultSecondary: null, category: "weapons" },
  { action: "toggleView", label: "Toggle View Mode", defaultPrimary: "KeyV", defaultSecondary: null, category: "weapons" },
  // Medical
  { action: "bandage", label: "Use Bandage", defaultPrimary: "KeyH", defaultSecondary: null, category: "medical" },
  { action: "splint", label: "Use Splint", defaultPrimary: "KeyJ", defaultSecondary: null, category: "medical" },
  { action: "medkit", label: "Use Medkit", defaultPrimary: "KeyK", defaultSecondary: null, category: "medical" },
  { action: "epi", label: "Use Epi-Pen", defaultPrimary: "KeyL", defaultSecondary: null, category: "medical" },
  // Social
  { action: "radioContact", label: "Radio: Contact", defaultPrimary: "KeyZ", defaultSecondary: null, category: "social" },
  { action: "radioMedic", label: "Radio: Need Medic", defaultPrimary: "KeyX", defaultSecondary: null, category: "social" },
  { action: "radioAmmo", label: "Radio: Need Ammo", defaultPrimary: "KeyC", defaultSecondary: null, category: "social" },
  // System
  { action: "toggleWeather", label: "Toggle Weather Cycle", defaultPrimary: "F1", defaultSecondary: null, category: "system" },
  { action: "pause", label: "Pause / Menu", defaultPrimary: "Escape", defaultSecondary: null, category: "system" },
];

const STORAGE_KEY = "pr_keybindings_v1";

/** Load the user's custom bindings from localStorage. */
export function loadCustomBindings(): Record<string, { primary: string; secondary: string | null }> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Save custom bindings to localStorage. */
export function saveCustomBindings(bindings: Record<string, { primary: string; secondary: string | null }>): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
}

/** Reset to defaults (clears localStorage). */
export function resetBindings(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Resolve the active key for an action (custom or default).
 * Returns [primary, secondary].
 */
export function resolveBinding(action: string): [string, string | null] {
  const custom = loadCustomBindings();
  const def = DEFAULT_BINDINGS.find((b) => b.action === action);
  if (!def) return ["", null];
  const c = custom[action];
  if (c) return [c.primary, c.secondary];
  return [def.defaultPrimary, def.defaultSecondary];
}

/**
 * P6.1: Map an action to the KeyboardEvent.code values that should
 * trigger it. Used by InputSystem to check `keys[code]`.
 */
export function getActiveKeysForAction(action: string): string[] {
  const [primary, secondary] = resolveBinding(action);
  return [primary, ...(secondary ? [secondary] : [])].filter(Boolean);
}

// ─── SEC10-UIUX (prompt 77): full input remapping ──────────────────────────

export type BindingSlot = "primary" | "secondary";

export interface RemapResult {
  ok: boolean;
  /** If ok is false, the action whose binding was in conflict. */
  conflictWith?: string;
  /** Human-readable reason for failure. */
  reason?: string;
}

/**
 * Find which action (if any) currently uses the given key code.
 * Returns null if the key is free. Used for conflict detection.
 */
export function findActionForKey(code: string): { action: string; slot: BindingSlot } | null {
  const custom = loadCustomBindings();
  for (const def of DEFAULT_BINDINGS) {
    const c = custom[def.action];
    const primary = c?.primary ?? def.defaultPrimary;
    const secondary = c?.secondary ?? def.defaultSecondary;
    if (primary === code) return { action: def.action, slot: "primary" };
    if (secondary === code) return { action: def.action, slot: "secondary" };
  }
  return null;
}

/**
 * SEC10-UIUX (prompt 77): Remap an action's primary or secondary binding.
 *
 * - Validates the action exists in DEFAULT_BINDINGS.
 * - Validates the new key is non-empty + not already bound to another
 *   action (returns a conflict result without writing).
 * - Persists to localStorage.
 * - Returns the resolved binding for the caller to apply live.
 *
 * To clear a binding (e.g. unbind a secondary), pass `null` as newKey
 * when slot === "secondary"; primary cannot be cleared.
 */
export function remapKey(action: string, newKey: string | null, slot: BindingSlot = "primary"): RemapResult {
  const def = DEFAULT_BINDINGS.find((b) => b.action === action);
  if (!def) {
    return { ok: false, reason: `Unknown action: ${action}` };
  }
  if (slot === "primary" && !newKey) {
    return { ok: false, reason: "Primary binding cannot be cleared" };
  }
  // Conflict check — skip when the key matches the *other* slot of the
  // same action (that's a swap, not a conflict).
  if (newKey) {
    const conflict = findActionForKey(newKey);
    if (conflict && conflict.action !== action) {
      return {
        ok: false,
        conflictWith: conflict.action,
        reason: `Key ${newKey} already bound to "${conflict.action}"`,
      };
    }
  }

  const custom = loadCustomBindings();
  const existing = custom[action] ?? {
    primary: def.defaultPrimary,
    secondary: def.defaultSecondary,
  };
  const updated = {
    primary: slot === "primary" ? (newKey ?? existing.primary) : existing.primary,
    secondary: slot === "secondary" ? newKey : existing.secondary,
  };
  custom[action] = updated;
  saveCustomBindings(custom);
  return { ok: true };
}

/**
 * SEC10-UIUX (prompt 77): Get the key code currently bound to an action's
 * slot (primary or secondary). Falls back to the default if no custom
 * binding is set.
 */
export function getKeyForAction(action: string, slot: BindingSlot = "primary"): string | null {
  const def = DEFAULT_BINDINGS.find((b) => b.action === action);
  if (!def) return null;
  const custom = loadCustomBindings();
  const c = custom[action];
  if (c) return slot === "primary" ? c.primary : c.secondary;
  return slot === "primary" ? def.defaultPrimary : def.defaultSecondary;
}

/**
 * SEC10-UIUX (prompt 77): Reset a single action's bindings to defaults.
 */
export function resetActionBinding(action: string): void {
  const def = DEFAULT_BINDINGS.find((b) => b.action === action);
  if (!def) return;
  const custom = loadCustomBindings();
  delete custom[action];
  saveCustomBindings(custom);
}

/**
 * Prompt I-962 — Keybind conflict resolver.
 *
 * `findAllConflicts()` scans every action's primary + secondary binding
 * (custom or default) and groups actions by the key code they share. A
 * "conflict" is any key code claimed by 2+ actions. With `remapKey`'s
 * conflict-prevention, conflicts should normally be empty — this scanner
 * exists for the settings UI's "Conflict Resolver" panel: it surfaces
 * leftover conflicts (from manual localStorage edits, schema migrations,
 * or a future "import profile" flow) and offers a one-click reset to
 * defaults for the affected actions.
 *
 * Returns an array of conflict groups, each with the shared key code +
 * the actions that claim it. Empty array = no conflicts.
 */
export interface KeybindConflict {
  /** The shared KeyboardEvent.code that's claimed by 2+ actions. */
  code: string;
  /** Human-readable form of `code` (via formatKeyCode). */
  display: string;
  /** Actions (by action id) that currently claim this key. */
  actions: string[];
  /** Display labels for the conflicting actions. */
  labels: string[];
}

export function findAllConflicts(): KeybindConflict[] {
  const custom = loadCustomBindings();
  // Map: keyCode -> [{ action, label }]
  const map = new Map<string, { action: string; label: string }[]>();
  for (const def of DEFAULT_BINDINGS) {
    const c = custom[def.action];
    const primary = c?.primary ?? def.defaultPrimary;
    const secondary = c?.secondary ?? def.defaultSecondary;
    for (const code of [primary, secondary]) {
      if (!code) continue;
      if (!map.has(code)) map.set(code, []);
      map.get(code)!.push({ action: def.action, label: def.label });
    }
  }
  const conflicts: KeybindConflict[] = [];
  for (const [code, actions] of map) {
    if (actions.length < 2) continue;
    conflicts.push({
      code,
      display: formatKeyCode(code),
      actions: actions.map((a) => a.action),
      labels: actions.map((a) => a.label),
    });
  }
  // Stable order — by display name.
  conflicts.sort((a, b) => a.display.localeCompare(b.display));
  return conflicts;
}

/**
 * Prompt I-962 — Bulk-resolve every detected conflict by resetting the
 * affected actions to their default bindings. Returns the list of actions
 * that were reset (so the UI can show a toast like "Reset 4 actions to
 * defaults"). Idempotent — calling twice is safe; the second call is a
 * no-op (no conflicts to find).
 */
export function resolveAllConflictsByReset(): string[] {
  const conflicts = findAllConflicts();
  const actions = new Set<string>();
  for (const c of conflicts) {
    for (const a of c.actions) actions.add(a);
  }
  for (const a of actions) resetActionBinding(a);
  return Array.from(actions);
}

/**
 * SEC10-UIUX (prompt 77): Format a KeyboardEvent.code for display.
 * "KeyW" → "W", "Digit1" → "1", "Mouse0" → "LMB", "Mouse2" → "RMB".
 */
export function formatKeyCode(code: string): string {
  if (!code) return "—";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Mouse0") return "LMB";
  if (code === "Mouse1") return "MMB";
  if (code === "Mouse2") return "RMB";
  if (code === "WheelUp") return "Wheel↑";
  if (code === "WheelDown") return "Wheel↓";
  if (code === "Space") return "Space";
  if (code === "ShiftLeft") return "L-Shift";
  if (code === "ShiftRight") return "R-Shift";
  if (code === "ControlLeft") return "L-Ctrl";
  if (code === "ControlRight") return "R-Ctrl";
  if (code === "AltLeft") return "L-Alt";
  if (code === "AltRight") return "R-Alt";
  if (code === "Escape") return "Esc";
  if (code.startsWith("Arrow")) return code.replace("Arrow", "");
  if (code.startsWith("F") && /^F\d+$/.test(code)) return code;
  return code;
}
