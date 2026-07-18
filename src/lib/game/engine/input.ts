/**
 * engine/input.ts — Input + loadout/weapon control concern (Task 3 / item 54).
 *
 * Extracted from the original engine.ts monolith. Owns the public methods
 * that mutate the player's input state or loadout:
 *   - setLoadout(loadout)  — swap the active loadout (delegates to WeaponSystem).
 *   - setWeapon(w)         — swap the active weapon slot.
 *   - useMedicalItem(slug) — trigger a medical action.
 *   - sendRadioMacro(type) — push a radio message to the HUD.
 *   - toggleViewMode()     — switch first-person ↔ third-person.
 *   - resume()             — re-engage pointer lock (input handshake).
 *
 * Why split: groups every "the player did something on the input side"
 * entry point in one place, separate from the fixed-step loop (loop.ts) and
 * the match lifecycle (lifecycle.ts). Makes it easier to audit input
 * authority for the server-reconciliation work (Task 1) and to wire
 * alternate input devices (Task 17 — controller / touch).
 */

import type { LoadoutConfig, WeaponType } from "../store";
import { useGameStore } from "../store";
import type { EngineLike } from "./loop";

/** Structural interface the input concern needs from the engine. */
export interface InputEngineLike {
  ctx: {
    avatar?: { group: { visible: boolean } };
    player: { viewMode: "first" | "third" };
    requestPointerLock(): void;
  };
  weapon: {
    setLoadout(loadout: LoadoutConfig): void;
    setWeapon(w: WeaponType): void;
  };
  medical: { useMedicalItem(slug: string): void };
  /** ENGAGE-FIX flag — set true by resume(), cleared 500ms after a successful
   *  pointer lock. The onPointerLockChange handler reads it to skip the
   *  pause transition during the unadjustedMovement lock→unlock→lock cycle. */
  _engageInProgress: boolean;
}

/** Re-engage pointer lock. The GameCanvas [phase,locked] effect unpauses the
 *  engine once lock is actually acquired. This prevents the "Click to Engage"
 *  overlay from staying visible while the game runs underneath when
 *  pointer-lock is in its ~1.3s cooldown. */
export function resumeEngine(e: InputEngineLike): void {
  e._engageInProgress = true;
  e.ctx.requestPointerLock();
}

/** Swap the active loadout (delegates to WeaponSystem). */
export function setLoadout(e: InputEngineLike, loadout: LoadoutConfig): void {
  e.weapon.setLoadout(loadout);
}

/** Swap the active weapon slot. */
export function setWeapon(e: InputEngineLike, w: WeaponType): void {
  e.weapon.setWeapon(w);
}

/** Trigger a medical action (bandage / splint / epi / medkit). */
export function useMedicalItem(e: InputEngineLike, slug: string): void {
  e.medical.useMedicalItem(slug);
}

/** Push a radio macro ("enemy spotted", "need backup", etc.) to the HUD. */
export function sendRadioMacro(e: InputEngineLike, type: string): void {
  const m = RADIO_MACROS[type];
  if (m) useGameStore.getState().setHud({ radioMessage: { ...m, time: performance.now() } });
}

/** Toggle first-person ↔ third-person view. */
export function toggleViewMode(e: InputEngineLike): void {
  const ctx = e.ctx;
  ctx.player.viewMode = ctx.player.viewMode === "first" ? "third" : "first";
  if (ctx.avatar) ctx.avatar.group.visible = ctx.player.viewMode === "third";
}

/** Radio macro definitions — kept here with the input concern (player intent)
 *  rather than scattered in engine.ts. Extend this map to add new macros. */
export const RADIO_MACROS: Record<string, { text: string; icon: string; channel: string }> = {
  enemy_spotted: { text: "Enemy spotted", icon: "👁", channel: "tactical" },
  need_backup: { text: "Need backup", icon: "🆘", channel: "tactical" },
  pushing: { text: "Pushing", icon: "➡️", channel: "tactical" },
  rotating: { text: "Rotating", icon: "🔄", channel: "tactical" },
};
