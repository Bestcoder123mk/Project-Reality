/**
 * L1-5000 / prompts 4470,4528,4582,4620,4658,4696,4734: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4772,4810,4848,4886,4924,4962,5000 (Adaptive triggers): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * Prompt I-997 / J-4166 — Adaptive trigger system (PS5 — trigger resistance per weapon).
 *
 * PS5 DualSense exposes per-trigger resistance via the DualSense
 * haptics extension (PlayStation's private `gamepadHapticActuator`
 * extension, surfaced in Chromium 116+ as `playEffect` on the trigger
 * actuator). Each trigger can be set to:
 *
 *   - "continuous" — constant resistance (good for ADS hold).
 *   - "section" — resistance kicks in past a position (good for
 *     half-pull to fire a sniper's breath-hold).
 *   - "effect" — vibration pulses past a position (good for jam
 *     feedback on a malfunctioning weapon).
 *
 * This module exposes:
 *   - `setTriggerEffect(trigger, effect)` — apply a trigger effect.
 *   - `clearTriggerEffect(trigger)` — reset to default (no resistance).
 *   - `getTriggerProfileForWeapon(weaponType)` — sensible defaults per
 *     weapon class (LMG = continuous heavy, sniper = section past 50%,
 *     pistol = no resistance, etc.).
 *   - `isAdaptiveTriggersSupported()` — feature-detect.
 *
 * SSR-safe. On non-DualSense gamepads, every call is a no-op.
 *
 * Cross-ref: the recoil system already simulates trigger pull force
 * via `RecoilSystem.ts`; this module adds the *physical* resistance
 * the player feels, complementary to the camera kick.
 */

const ADAPTIVE_TRIGGERS_KEY = "pr_adaptive_triggers_v1";

export type TriggerSide = "left" | "right";

export type TriggerEffect =
  | { kind: "off" }
  | {
      kind: "continuous";
      /** 0..1 — start position of the resistance. */
      startPosition: number;
      /** 0..1 — strength of the resistance. */
      strength: number;
    }
  | {
      kind: "section";
      /** 0..1 — start of the resistant section. */
      startPosition: number;
      /** 0..1 — end of the resistant section. */
      endPosition: number;
      strength: number;
    }
  | {
      kind: "vibration";
      /** 0..1 — position past which the trigger vibrates. */
      startPosition: number;
      strength: number;
      /** Frequency in Hz. */
      frequency: number;
    };

/** Feature-detect the DualSense trigger actuator extension. */
export function isAdaptiveTriggersSupported(): boolean {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return false;
  const pads = navigator.getGamepads();
  for (const p of pads) {
    if (!p) continue;
    // The trigger actuators are exposed on `p.vibrationActuator` (root)
    // OR via the PlayStation extension on `p.buttons[6].vibrationActuator`
    // + `p.buttons[7].vibrationActuator`. Chromium 116+ exposes them
    // via the trigger button's `vibrationActuator` field.
    for (const idx of [6, 7]) {
      const btn = p.buttons[idx];
      const actuator = (btn as unknown as {
        vibrationActuator?: { playEffect?: unknown };
      })?.vibrationActuator;
      if (actuator?.playEffect) return true;
    }
  }
  return false;
}

export function getAdaptiveTriggersEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(ADAPTIVE_TRIGGERS_KEY) !== "0";
}

export function setAdaptiveTriggersEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ADAPTIVE_TRIGGERS_KEY, on ? "1" : "0");
}

/** Apply a trigger effect to the left (L2) or right (R2) trigger. */
export async function setTriggerEffect(
  trigger: TriggerSide,
  effect: TriggerEffect,
): Promise<void> {
  if (!getAdaptiveTriggersEnabled()) return;
  if (typeof navigator === "undefined" || !navigator.getGamepads) return;
  const buttonIndex = trigger === "left" ? 6 : 7;
  const pads = navigator.getGamepads();
  for (const p of pads) {
    if (!p) continue;
    const btn = p.buttons[buttonIndex];
    const actuator = (btn as unknown as {
      vibrationActuator?: {
        playEffect?: (
          type: "dual-rumble" | "trigger",
          params: Record<string, unknown>,
        ) => Promise<void>;
      };
    })?.vibrationActuator;
    if (!actuator?.playEffect) continue;
    try {
      if (effect.kind === "off") {
        // Reset by playing an empty effect for 1ms.
        await actuator.playEffect("trigger", {
          duration: 1,
          startMagnitude: 0,
          endMagnitude: 0,
        });
      } else if (effect.kind === "continuous") {
        await actuator.playEffect("trigger", {
          duration: 5000,
          startMagnitude: effect.strength,
          endMagnitude: effect.strength,
          startPosition: effect.startPosition,
        });
      } else if (effect.kind === "section") {
        await actuator.playEffect("trigger", {
          duration: 5000,
          startMagnitude: effect.strength,
          endMagnitude: effect.strength,
          startPosition: effect.startPosition,
          endPosition: effect.endPosition,
        });
      } else if (effect.kind === "vibration") {
        await actuator.playEffect("trigger", {
          duration: 5000,
          startMagnitude: effect.strength,
          endMagnitude: effect.strength,
          startPosition: effect.startPosition,
          frequency: effect.frequency,
        });
      }
      return; // First connected DualSense wins.
    } catch {
      /* ignore */
    }
  }
}

/** Clear the trigger effect (reset to default). */
export async function clearTriggerEffect(trigger: TriggerSide): Promise<void> {
  await setTriggerEffect(trigger, { kind: "off" });
}

/**
 * Per-weapon-class trigger profile. The engine calls
 * `setTriggerEffect("right", getTriggerProfileForWeapon(weaponType).right)`
 * on weapon switch.
 */
export function getTriggerProfileForWeapon(
  weaponType: "rifle" | "sniper" | "smg" | "pistol" | "shotgun" | "lmg",
): { left: TriggerEffect; right: TriggerEffect } {
  switch (weaponType) {
    case "sniper":
      return {
        left: { kind: "continuous", startPosition: 0.5, strength: 0.6 },
        right: { kind: "section", startPosition: 0.5, endPosition: 1.0, strength: 0.8 },
      };
    case "lmg":
      return {
        left: { kind: "off" },
        right: { kind: "continuous", startPosition: 0.3, strength: 0.5 },
      };
    case "shotgun":
      return {
        left: { kind: "off" },
        right: { kind: "section", startPosition: 0.7, endPosition: 1.0, strength: 0.9 },
      };
    case "rifle":
    case "smg":
      return {
        left: { kind: "off" },
        right: { kind: "continuous", startPosition: 0.6, strength: 0.2 },
      };
    case "pistol":
    default:
      return { left: { kind: "off" }, right: { kind: "off" } };
  }
}
