/**
 * L1-5000 / prompts 4469,4527,4581,4619,4657,4695,4733: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4771,4809,4847,4885,4923,4961,4999 (Haptics): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * Prompt I-996 / J-4165 — Haptics system (controller vibration per event).
 *
 * Wraps the Gamepad API's `vibrationActuator.playEffect()` (the W3C
 * draft spec for rumble/haptics) + the legacy `navigator.vibrate()`
 * (mobile). The engine + UI call `triggerHaptic(event)` on fire,
 * damage, explosion, UI click, etc. — the system looks up the
 * pattern for the event + fires the actuator.
 *
 * DualSense haptics + adaptive triggers are surfaced via a separate
 * extension (see adaptive-triggers.ts). This module covers the
 * lowest-common-denominator: simple rumble patterns that work on
 * every gamepad + mobile.
 *
 * Public API:
 *   - `HAPTIC_EVENTS` — catalog of named events + their patterns.
 *   - `triggerHaptic(event, intensity?)` — fire the pattern. No-op
 *     when the player has haptics disabled or no actuator is present.
 *   - `getHapticsEnabled()` / `setHapticsEnabled(on)` — player pref.
 *   - `isHapticsSupported()` — feature-detect.
 *
 * SSR-safe.
 */

const HAPTICS_ENABLED_KEY = "pr_haptics_enabled_v1";

/** Named haptic events. */
export type HapticEvent =
  | "fire"
  | "fireHeavy"
  | "melee"
  | "damage"
  | "explosion"
  | "uiClick"
  | "uiHover"
  | "reload"
  | "takedown"
  | "lowAmmo"
  | "emptyClick";

export interface HapticPattern {
  /** Duration in ms (rumble burst length). */
  duration: number;
  /** 0..1 — weak (UI hover) to strong (explosion). */
  strongMagnitude: number;
  /** 0..1 — secondary motor (high-frequency). */
  weakMagnitude: number;
  /** Optional delay before the burst (for multi-tap patterns). */
  startDelay: number;
}

/** Catalog of named haptic patterns. */
export const HAPTIC_EVENTS: Record<HapticEvent, HapticPattern> = {
  fire: { duration: 60, strongMagnitude: 0.3, weakMagnitude: 0.6, startDelay: 0 },
  fireHeavy: { duration: 120, strongMagnitude: 0.6, weakMagnitude: 0.8, startDelay: 0 },
  melee: { duration: 200, strongMagnitude: 0.8, weakMagnitude: 0.4, startDelay: 0 },
  damage: { duration: 250, strongMagnitude: 1.0, weakMagnitude: 0.5, startDelay: 0 },
  explosion: { duration: 500, strongMagnitude: 1.0, weakMagnitude: 1.0, startDelay: 0 },
  uiClick: { duration: 30, strongMagnitude: 0.1, weakMagnitude: 0.2, startDelay: 0 },
  uiHover: { duration: 15, strongMagnitude: 0.05, weakMagnitude: 0.1, startDelay: 0 },
  reload: { duration: 100, strongMagnitude: 0.4, weakMagnitude: 0.3, startDelay: 0 },
  takedown: { duration: 400, strongMagnitude: 1.0, weakMagnitude: 0.7, startDelay: 0 },
  lowAmmo: { duration: 50, strongMagnitude: 0.2, weakMagnitude: 0.3, startDelay: 0 },
  emptyClick: { duration: 25, strongMagnitude: 0.1, weakMagnitude: 0.05, startDelay: 0 },
};

/** Feature-detect haptics support (gamepad actuator OR navigator.vibrate). */
export function isHapticsSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.vibrate === "function") return true;
  if (!navigator.getGamepads) return false;
  const pads = navigator.getGamepads();
  for (const p of pads) {
    if (!p) continue;
    const actuator = (p as unknown as {
      vibrationActuator?: { playEffect?: unknown };
    }).vibrationActuator;
    if (actuator?.playEffect) return true;
  }
  return false;
}

export function getHapticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(HAPTICS_ENABLED_KEY) !== "0";
}

export function setHapticsEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(HAPTICS_ENABLED_KEY, on ? "1" : "0");
}

/**
 * Fire a haptic pattern. No-op when:
 *   - haptics disabled in settings
 *   - no gamepad connected + no navigator.vibrate
 *   - the actuator rejects the pattern (already in use)
 *
 * @param intensity — 0..1 multiplier on the pattern's magnitudes.
 */
export async function triggerHaptic(
  event: HapticEvent,
  intensity = 1.0,
): Promise<void> {
  if (!getHapticsEnabled()) return;
  const pattern = HAPTIC_EVENTS[event];
  if (!pattern) return;
  const strong = Math.min(1, pattern.strongMagnitude * intensity);
  const weak = Math.min(1, pattern.weakMagnitude * intensity);

  // Try the gamepad actuator first (higher fidelity).
  if (typeof navigator !== "undefined" && navigator.getGamepads) {
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (!p) continue;
      const actuator = (p as unknown as {
        vibrationActuator?: {
          playEffect?: (
            type: "dual-rumble" | "rumblerumble",
            params: Record<string, unknown>,
          ) => Promise<void>;
        };
      }).vibrationActuator;
      if (actuator?.playEffect) {
        try {
          await actuator.playEffect("dual-rumble", {
            startDelay: pattern.startDelay,
            duration: pattern.duration,
            strongMagnitude: strong,
            weakMagnitude: weak,
          });
          return;
        } catch {
          // Actuator busy or pattern rejected — fall through to navigator.vibrate.
        }
      }
    }
  }

  // Fallback: navigator.vibrate (mobile only, single motor).
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(pattern.duration);
    } catch {
      /* ignore */
    }
  }
}
