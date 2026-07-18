/**
 * L1-5000 / prompts 4462,4463,4464,4520,4521,4522,4574,4575,4576,4612,4613,4614,4650,4651,4652,4688,4689,4690,4726,4727,4728: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4763,4764,4765,4766,4801,4802,4803,4804,4839,4840,4841,4842,4877,4878,4879,4880,4915,4916,4917,4918,4953,4954,4955,4956,4991,4992,4993,4994 (Mobile safe-area + perf + battery saver + data saver): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * Prompt I-989 — Mobile performance mode (auto-detect).
 * Prompt I-990 — Mobile battery saver (cap FPS to 30).
 * Prompt I-991 — Mobile data saver (no asset streaming on cellular).
 *
 * Thin coordination layer over HardwareDetect + the FrameBudgetProfiler.
 * Reads the device class + the player's preferences, returns the
 * effective mobile policy the engine should apply.
 *
 * Public API:
 *   - `getMobilePerfProfile()` — returns the current tier + whether
 *     battery saver + data saver are active.
 *   - `shouldCapFps30()` — true when battery saver is on OR the device
 *     is in the lowest tier. Engine reads this to switch the rAF loop
 *     from every-frame to every-other-frame.
 *   - `shouldSkipAssetStreaming()` — true on cellular + data saver on.
 *     Engine skips the EnvArtKit / vegetation streaming pass.
 *   - `setBatterySaver(on)` / `setDataSaver(on)` — toggle the player
 *     preference (persisted to localStorage).
 *   - `isMobileDevice()` — coarse UA sniff (used by the boot path to
 *     decide whether to even apply the mobile profile).
 *
 * SSR-safe: every function returns safe defaults on the server.
 */

import type { QualityTier } from "../systems/FrameBudgetProfiler";

const BATTERY_SAVER_KEY = "pr_battery_saver_v1";
const DATA_SAVER_KEY = "pr_data_saver_v1";

/** Coarse mobile detection (used by the boot path). */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** Returns the player's battery-saver preference (default off). */
export function getBatterySaver(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(BATTERY_SAVER_KEY) === "1";
}

/** Toggle battery saver (persisted). */
export function setBatterySaver(on: boolean): void {
  if (typeof window === "undefined") return;
  if (on) localStorage.setItem(BATTERY_SAVER_KEY, "1");
  else localStorage.removeItem(BATTERY_SAVER_KEY);
}

/** Returns the player's data-saver preference (default on for cellular). */
export function getDataSaver(): boolean {
  if (typeof window === "undefined") return false;
  const stored = localStorage.getItem(DATA_SAVER_KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  // Default: on when the connection is cellular.
  return getConnectionType() === "cellular";
}

/** Toggle data saver (persisted). */
export function setDataSaver(on: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(DATA_SAVER_KEY, on ? "1" : "0");
}

/** Read the connection type (wifi / cellular / unknown) via Network Information API. */
export function getConnectionType(): "wifi" | "cellular" | "unknown" {
  if (typeof navigator === "undefined") return "unknown";
  const conn = (navigator as unknown as {
    connection?: { effectiveType?: string; type?: string };
  }).connection;
  if (!conn) return "unknown";
  if (conn.type === "wifi") return "wifi";
  if (conn.type === "cellular") return "cellular";
  // effectiveType is "4g" / "3g" / "2g" / "slow-2g" — treat 2g/3g as cellular.
  const eff = conn.effectiveType ?? "4g";
  return eff === "4g" ? "wifi" : "cellular";
}

/** Returns true when the engine should cap the FPS to 30. */
export function shouldCapFps30(tier: QualityTier): boolean {
  if (getBatterySaver()) return true;
  // Lowest tier devices can't sustain 60fps — cap to 30 to keep the
  // frame budget stable.
  return tier === "low";
}

/** Returns true when asset streaming should be skipped (data saver). */
export function shouldSkipAssetStreaming(): boolean {
  return getDataSaver();
}

export interface MobilePerfProfile {
  isMobile: boolean;
  tier: QualityTier | "unknown";
  batterySaver: boolean;
  dataSaver: boolean;
  connection: "wifi" | "cellular" | "unknown";
  capFps30: boolean;
  skipStreaming: boolean;
}

/**
 * Prompt I-989 — Auto-detect the mobile perf profile. Combines
 * `isMobileDevice()`, the HardwareDetect tier (passed in), the player's
 * battery + data saver preferences, and the connection type into a
 * single profile object the engine + HUD read from.
 */
export function getMobilePerfProfile(tier: QualityTier | "unknown" = "unknown"): MobilePerfProfile {
  const isMobile = isMobileDevice();
  const batterySaver = getBatterySaver();
  const dataSaver = getDataSaver();
  const connection = getConnectionType();
  return {
    isMobile,
    tier,
    batterySaver,
    dataSaver,
    connection,
    capFps30: tier !== "unknown" ? shouldCapFps30(tier) : batterySaver,
    skipStreaming: dataSaver || connection === "cellular",
  };
}
