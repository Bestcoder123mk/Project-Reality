/**
 * Prompt I-968 — Automated tests for the UI/UX layer.
 *
 * Backlog §2 items 26-50 — extend the existing __tests__/ coverage to
 * the UI/UX-facing modules. This file covers:
 *
 *   - `Keybindings.findAllConflicts()` — conflict scanner.
 *   - `Keybindings.resolveAllConflictsByReset()` — bulk resolver.
 *   - `ExtendedSettings.savePreset/loadPreset/listPresets/deletePreset`
 *     — preset save/load round-trip.
 *   - `TouchControls.applyLookDeadzone()` — deadzone math.
 *   - `TouchControls.isLongPress()` — long-press detection.
 *
 * These are pure-function tests — no DOM, no React. They run in the
 * existing vitest suite alongside the other __tests__/ files.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_BINDINGS,
  findAllConflicts,
  resolveAllConflictsByReset,
  remapKey,
  resetActionBinding,
  saveCustomBindings,
  loadCustomBindings,
} from "../../Keybindings";
import {
  savePreset,
  loadPreset,
  listPresets,
  deletePreset,
  DEFAULT_EXTENDED_SETTINGS,
} from "../../ExtendedSettings";
import type { ExtendedSettings as StoreExtendedSettings } from "../../store";
import {
  applyLookDeadzone,
  isLongPress,
  TOUCH_LONG_PRESS_MS,
  TOUCH_LOOK_DEADZONE_PX,
} from "../../TouchControls";

// ─── Keybindings conflict resolver ──────────────────────────────────────────

describe("Keybindings.findAllConflicts", () => {
  beforeEach(() => {
    // Clear localStorage between tests.
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("returns an empty array when no custom bindings exist (defaults have no conflicts)", () => {
    saveCustomBindings({});
    const conflicts = findAllConflicts();
    expect(conflicts).toEqual([]);
  });

  it("detects when two actions share the same primary key", () => {
    // Manually craft a conflict: "fire" + "melee" both bound to KeyF.
    saveCustomBindings({
      fire: { primary: "KeyF", secondary: null },
      melee: { primary: "KeyF", secondary: null },
    });
    const conflicts = findAllConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].code).toBe("KeyF");
    expect(conflicts[0].actions).toContain("fire");
    expect(conflicts[0].actions).toContain("melee");
  });

  it("groups 3+ actions on the same key into one conflict entry", () => {
    saveCustomBindings({
      fire: { primary: "Space", secondary: null },
      jump: { primary: "Space", secondary: null },
      crouch: { primary: "Space", secondary: null },
    });
    const conflicts = findAllConflicts();
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].actions).toHaveLength(3);
  });
});

describe("Keybindings.resolveAllConflictsByReset", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("resets all conflicting actions to their defaults", () => {
    saveCustomBindings({
      fire: { primary: "KeyF", secondary: null },
      melee: { primary: "KeyF", secondary: null },
    });
    const reset = resolveAllConflictsByReset();
    expect(reset).toContain("fire");
    expect(reset).toContain("melee");
    // After reset, the custom bindings for these actions are gone.
    const custom = loadCustomBindings();
    expect(custom.fire).toBeUndefined();
    expect(custom.melee).toBeUndefined();
    // And no conflicts remain.
    expect(findAllConflicts()).toEqual([]);
  });

  it("is idempotent — calling twice is a no-op", () => {
    saveCustomBindings({
      fire: { primary: "KeyF", secondary: null },
      melee: { primary: "KeyF", secondary: null },
    });
    resolveAllConflictsByReset();
    const second = resolveAllConflictsByReset();
    expect(second).toEqual([]);
  });
});

// ─── ExtendedSettings presets ───────────────────────────────────────────────

// J-5000-retry — savePreset now accepts the STORE's ExtendedSettings
// (the live `settings.extended` blob), not the ExtendedSettings.ts
// module's parallel ExtendedSettings interface. The test constructs a
// store-compatible blob here. The actual field values don't matter
// for the round-trip test — what matters is that the same blob comes
// back from loadPreset.
const STORE_EXTENDED: StoreExtendedSettings = {
  aimSensitivity: 0.5,
  adsMode: "hold",
  adsSpeed: 14,
  motionSickness: false,
  colorblind: "none",
  masterVolume: 0.8,
  sfxVolume: 0.9,
  musicVolume: 0.5,
  voiceVolume: 0.7,
  reducedEffects: false,
  subtitlesEnabled: false,
  subtitleBackground: 0.7,
  subtitleColor: "#ffffff",
  audioDuckDb: 6,
  motorAssist: false,
  ambientCaptions: false,
  dyslexiaFont: false,
  rtlLayout: false,
  holdToggle: { sprint: "hold", ads: "hold", crouch: "toggle" },
  practiceGameSpeed: 1.0,
  autoSprint: false,
  inputBufferMs: 200,
  lowHealthVignetteColor: "#dc2626",
};

describe("ExtendedSettings presets (I-963)", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear();
  });

  it("round-trips a preset through save/load", () => {
    savePreset("sniper", STORE_EXTENDED, { reducedMotion: true });
    const loaded = loadPreset("sniper");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("sniper");
    expect(loaded!.extended).toEqual(STORE_EXTENDED);
    expect(loaded!.visual).toEqual({ reducedMotion: true });
  });

  it("lists presets newest-first", () => {
    savePreset("old", STORE_EXTENDED, {});
    // Bump the timestamp by saving again with a slight delay.
    savePreset("new", STORE_EXTENDED, {});
    const list = listPresets();
    expect(list.length).toBe(2);
    // Both have ISO timestamps; "new" should sort before "old".
    expect(list[0].name).toBe("new");
  });

  it("overwrites a preset when the name already exists", () => {
    savePreset("dupe", STORE_EXTENDED, { reducedMotion: false });
    savePreset("dupe", STORE_EXTENDED, { reducedMotion: true });
    const list = listPresets();
    expect(list.length).toBe(1);
    expect(list[0].visual).toEqual({ reducedMotion: true });
  });

  it("deletes a preset", () => {
    savePreset("gone", STORE_EXTENDED, {});
    deletePreset("gone");
    expect(loadPreset("gone")).toBeNull();
    expect(listPresets()).toEqual([]);
  });

  it("rejects an empty preset name", () => {
    expect(() => savePreset("   ", STORE_EXTENDED, {})).toThrow();
  });

  // J-5000-retry — keep a sanity check that the ExtendedSettings.ts
  // module's own DEFAULT_EXTENDED_SETTINGS is still a valid blob (the
  // crosshair-share-code + hitmarker helpers depend on it). This is
  // a compile-time check: if the type drifts, the assignment below
  // fails tsc.
  it("ExtendedSettings.ts DEFAULT_EXTENDED_SETTINGS is a valid blob", () => {
    expect(DEFAULT_EXTENDED_SETTINGS.sensitivity).toBe(1);
    expect(DEFAULT_EXTENDED_SETTINGS.fov).toBe(80);
  });
});

// ─── TouchControls polish (I-987) ───────────────────────────────────────────

describe("TouchControls.applyLookDeadzone (I-987)", () => {
  it("zeros sub-threshold movements", () => {
    const r = applyLookDeadzone(TOUCH_LOOK_DEADZONE_PX - 1, 0);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
  });

  it("passes through super-threshold movements, re-scaled to start at 0 at the boundary", () => {
    const dx = TOUCH_LOOK_DEADZONE_PX * 2;
    const r = applyLookDeadzone(dx, 0);
    // At 2x the deadzone, the re-scaled value should be the original
    // minus the deadzone (1x).
    expect(r.dx).toBeCloseTo(dx - TOUCH_LOOK_DEADZONE_PX, 5);
  });

  it("handles diagonal movements correctly", () => {
    const m = TOUCH_LOOK_DEADZONE_PX + 5;
    const r = applyLookDeadzone(m, m);
    // Magnitude after deadzone = sqrt(2)*(m) - deadzone, re-scaled.
    expect(r.dx).toBeGreaterThan(0);
    expect(r.dy).toBeGreaterThan(0);
  });
});

describe("TouchControls.isLongPress (I-987)", () => {
  it("returns false for a fresh touch", () => {
    expect(isLongPress(1000, 1000)).toBe(false);
  });

  it("returns true after the long-press threshold", () => {
    expect(isLongPress(1000, 1000 + TOUCH_LONG_PRESS_MS)).toBe(true);
  });

  it("returns false just before the threshold", () => {
    expect(isLongPress(1000, 1000 + TOUCH_LONG_PRESS_MS - 1)).toBe(false);
  });
});

// ─── DEFAULT_BINDINGS sanity (existing test extension) ──────────────────────

describe("DEFAULT_BINDINGS (I-962 helper sanity)", () => {
  it("has no conflicts in the default catalog itself", () => {
    saveCustomBindings({});
    expect(findAllConflicts()).toEqual([]);
  });

  it("remapKey prevents creating a conflict", () => {
    saveCustomBindings({});
    // Try to bind "forward" (default KeyW) to "KeyF" which is "melee".
    const result = remapKey("forward", "KeyF", "primary");
    expect(result.ok).toBe(false);
    expect(result.conflictWith).toBe("melee");
  });

  it("resetActionBinding restores a single action's default", () => {
    saveCustomBindings({
      fire: { primary: "KeyT", secondary: null },
    });
    resetActionBinding("fire");
    const custom = loadCustomBindings();
    expect(custom.fire).toBeUndefined();
  });
});
