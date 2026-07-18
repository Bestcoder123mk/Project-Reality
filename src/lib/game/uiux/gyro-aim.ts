/**
 * L1-5000 / prompts 4468,4526,4580,4618,4656,4694,4732: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4770,4808,4846,4884,4922,4960,4998 (Gyro-aim): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * Prompt I-995 / J-4164 — Gyro-aim option (PS5 / Switch).
 *
 * PS5 DualSense + Switch Joycons/Pro expose 3-axis gyro + 3-axis
 * accelerometer via the Gamepad API's extension pose. Chromium 116+
 * surfaces these as `gamepadPose` on the Gamepad object (ChromeOS +
 * Steam Deck trackpads also expose this). Safari/Firefox don't ship
 * the pose extension yet — feature-detection is required.
 *
 * This module exposes:
 *   - `isGyroAimSupported()` — feature-detect (SSR-safe).
 *   - `getGyroAimConfig()` / `setGyroAimEnabled(on)` / `setGyroSensitivity(n)`
 *     — player preference (persisted).
 *   - `pollGyroDelta()` — reads the latest gyro angular-velocity sample
 *     + returns yaw/pitch deltas scaled by sensitivity. The InputSystem
 *     adds these to the look delta alongside the right-stick + mouse.
 *
 * Implementation note: the W3C Gamepad Extensions spec stores gyro
 * data in `gamepad.pose.angularVelocity` (a Float32Array of [x, y, z]).
 * We map x→yaw (controller rotation around the vertical axis) and
 * y→pitch (rotation around the horizontal axis). The mapping is
 * inverted when the player holds the controller flat (Switch
 * tabletop mode) — see `GYRO_HOLD_ORIENTATION`.
 *
 * SSR-safe.
 */

const GYRO_ENABLED_KEY = "pr_gyro_aim_enabled_v1";
const GYRO_SENS_KEY = "pr_gyro_aim_sens_v1";

export type GyroHoldOrientation = "upright" | "flat";

/** Default sensitivity — calibrated to feel like Splatoon's stick+gyro. */
export const DEFAULT_GYRO_SENSITIVITY = 1.0;

/** Feature-detect the Gamepad Pose extension (gyro + accelerometer). */
export function isGyroAimSupported(): boolean {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return false;
  const pads = navigator.getGamepads();
  for (const p of pads) {
    if (!p) continue;
    // The pose extension is non-standard; cast through unknown.
    const pose = (p as unknown as { pose?: { hasOrientation?: boolean; angularVelocity?: Float32Array } }).pose;
    if (pose?.hasOrientation || pose?.angularVelocity) return true;
  }
  return false;
}

export function getGyroAimEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(GYRO_ENABLED_KEY) === "1";
}

export function setGyroAimEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  if (on) localStorage.setItem(GYRO_ENABLED_KEY, "1");
  else localStorage.removeItem(GYRO_ENABLED_KEY);
}

export function getGyroSensitivity(): number {
  if (typeof window === "undefined") return DEFAULT_GYRO_SENSITIVITY;
  const raw = localStorage.getItem(GYRO_SENS_KEY);
  if (!raw) return DEFAULT_GYRO_SENSITIVITY;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_GYRO_SENSITIVITY;
}

export function setGyroSensitivity(n: number): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(GYRO_SENS_KEY, String(n));
}

export interface GyroConfig {
  enabled: boolean;
  sensitivity: number;
  supported: boolean;
}

export function getGyroAimConfig(): GyroConfig {
  return {
    enabled: getGyroAimEnabled(),
    sensitivity: getGyroSensitivity(),
    supported: isGyroAimSupported(),
  };
}

export interface GyroDelta {
  /** Radians — positive = look right. */
  yawDelta: number;
  /** Radians — positive = look up. */
  pitchDelta: number;
}

/**
 * Read the latest gyro sample + return scaled yaw/pitch deltas.
 * Returns zero deltas when gyro is disabled, unsupported, or no
 * gamepad with a pose is connected.
 *
 * The caller (InputSystem) adds these to the right-stick + mouse
 * deltas in the same frame, so gyro + stick compose naturally.
 *
 * @param holdOrientation — controller orientation. "upright" (held
 *   vertically, like a normal pad) is the default. "flat" (laid flat
 *   on a table, Switch tabletop mode) swaps the yaw/pitch axes.
 */
export function pollGyroDelta(holdOrientation: GyroHoldOrientation = "upright"): GyroDelta {
  if (!getGyroAimEnabled() || typeof navigator === "undefined" || !navigator.getGamepads) {
    return { yawDelta: 0, pitchDelta: 0 };
  }
  const pads = navigator.getGamepads();
  for (const p of pads) {
    if (!p) continue;
    const pose = (p as unknown as { pose?: { angularVelocity?: Float32Array | number[] } }).pose;
    const av = pose?.angularVelocity;
    if (!av || av.length < 3) continue;
    const sens = getGyroSensitivity();
    // angularVelocity is in rad/s. Convert to per-frame delta by
    // assuming ~16ms (60fps). The InputSystem will compose + clamp.
    const frameSec = 0.016;
    const x = av[0] * frameSec * sens;
    const y = av[1] * frameSec * sens;
    if (holdOrientation === "flat") {
      return { yawDelta: y, pitchDelta: -x };
    }
    return { yawDelta: x, pitchDelta: -y };
  }
  return { yawDelta: 0, pitchDelta: 0 };
}
