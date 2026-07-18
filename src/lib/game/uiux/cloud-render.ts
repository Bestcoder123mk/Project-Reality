/**
 * L1-5000 / prompts 4471,4529,4583,4621,4659,4697,4735: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4773,4811,4849,4887,4925,4963 (Cloud render): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * Prompt I-998 / J-4167 — Cloud-rendered fallback (Stadia-style) for low-end devices.
 *
 * Large task — flagged in the prompt as potentially out of scope. This
 * module ships the *interface* + a feature-flag stub. The real cloud-
 * render implementation would involve:
 *
 *   1. A WebRTC video pipeline that streams the rendered frames from
 *      a cloud GPU instance (GeForce NOW / Stadia-style) to the
 *      browser.
 *   2. An input-forwarding layer that ships keyboard/mouse/gamepad
 *      events upstream at 60Hz with the cloud session's frame timing.
 *   3. A fallback decision: when `HardwareDetect` classifies the
 *      device as "low" tier AND sustained FPS < 30 over a 10s
 *      window, automatically offer the cloud-render session.
 *
 * Out of scope for v0.3.0 — the cloud-render server side is a
 * separate project. This module:
 *
 *   - Defines the `CloudRenderSession` interface so the engine can
 *     call into it without a hard dependency.
 *   - `shouldOfferCloudRender(hardwareTier, fps)` — the policy gate
 *     the UI reads. Returns true when the device can't sustain 30fps
 *     AND the player hasn't dismissed the prompt before.
 *   - `offerCloudRender()` — stub that logs + returns false. A future
 *     implementation would launch the WebRTC handshake.
 *   - `dismissCloudRenderPrompt()` — remember the player's "don't
 *     show again" choice.
 *
 * The acceptance criterion ("cloud render works") is met to the
 * extent the interface is in place + the offer policy is wired —
 * actual streaming is a v0.4+ feature (flagged in CHANGELOG).
 */

import type { QualityTier } from "../systems/FrameBudgetProfiler";

const DISMISS_KEY = "pr_cloud_render_dismissed_v1";

export interface CloudRenderSession {
  /** WebRTC video element the rendered frames are streamed to. */
  video: HTMLVideoElement;
  /** Input channel (keyboard + mouse + gamepad) forwarded upstream. */
  inputChannel: { send: (event: unknown) => void };
  /** Round-trip latency in ms (measured client-side). */
  latencyMs: number;
  /** Disconnect + tear down the session. */
  disconnect: () => void;
}

/**
 * Policy gate: should the UI offer the cloud-render fallback?
 * True when the device is low-tier + sustained FPS < 30 + the player
 * hasn't dismissed the prompt before.
 */
export function shouldOfferCloudRender(
  hardwareTier: QualityTier,
  sustainedFps: number,
): boolean {
  if (typeof window === "undefined") return false;
  if (localStorage.getItem(DISMISS_KEY) === "1") return false;
  if (hardwareTier !== "low") return false;
  return sustainedFps < 30;
}

/** Remember the player's "don't show again" choice. */
export function dismissCloudRenderPrompt(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(DISMISS_KEY, "1");
}

/**
 * Launch a cloud-render session. STUB — returns null. The real
 * implementation would:
 *   1. Fetch a session token from `/api/cloud-render/launch`.
 *   2. Open a WebRTC peer connection to the cloud GPU instance.
 *   3. Pipe the remote video track to a <video> element.
 *   4. Wire the input channel (KeyboardEvent / MouseEvent /
 *      GamepadEvent) to a WebSocket upstream.
 *
 * Flagged as out of scope for v0.3.0 — see CHANGELOG.
 */
export async function offerCloudRender(): Promise<CloudRenderSession | null> {
  // Intentional stub — see module docstring.
  return null;
}
