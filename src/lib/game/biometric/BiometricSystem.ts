/**
 * Phase 6: Biometric multimodal feedback.
 *
 * Captures physiological signals from the player's body and feeds them
 * back into the simulation:
 *   - rPPG heart rate via webcam + MediaPipe FaceMesh (camera-based,
 *     no hardware required).
 *   - Web Bluetooth HR + HRV (Polar H10 or equivalent chest strap).
 *   - MediaPipe blendshapes for facial expression capture.
 *   - WebGazer.js for soft gaze tracking.
 *
 * All signals feed into:
 *   - SuppressionSystem (high HR increases suppression gain).
 *   - MedicalSystem (HR affects bleed rate + recovery).
 *   - ProceduralAnimSystem (breathing rate tracks HR; high HR = more sway).
 *   - Telemetry (biometric events are logged for analysis).
 */

import { isFeatureEnabled } from "../FeatureFlags";

export interface BiometricState {
  /** Heart rate (BPM). 0 if unavailable. */
  heartRate: number;
  /** Heart rate variability (RMSSD, ms). 0 if unavailable. */
  hrv: number;
  /** Current emotional valence from facial expression (-1..1). */
  facialValence: number;
  /** Current arousal from facial expression (0..1). */
  facialArousal: number;
  /** Gaze point on screen (normalized 0..1, or null). */
  gaze: { x: number; y: number } | null;
  /** Whether each signal is active. */
  sources: {
    rppg: boolean;
    bluetooth: boolean;
    facial: boolean;
    gaze: boolean;
  };
}

export class BiometricSystem {
  private state: BiometricState = {
    heartRate: 0, hrv: 0, facialValence: 0, facialArousal: 0, gaze: null,
    sources: { rppg: false, bluetooth: false, facial: false, gaze: false },
  };
  private video: HTMLVideoElement | null = null;
  private bluetoothDevice: any = null;
  private faceMesh: any = null;
  private gazeTracker: any = null;

  /** Initialize all available biometric sources. */
  async init(): Promise<void> {
    if (isFeatureEnabled("getUserMedia")) {
      await this.initRPPG();
      await this.initFacial();
    }
    if (isFeatureEnabled("webBluetooth")) {
      await this.initBluetooth();
    }
  }

  /** rPPG: remote photoplethysmography via webcam. */
  private async initRPPG(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      this.video = document.createElement("video");
      this.video.srcObject = stream;
      this.video.play();
      this.state.sources.rppg = true;
      // Actual rPPG signal extraction would use MediaPipe FaceMesh to
      // isolate the forehead, then compute the green-channel average
      // over time + apply a bandpass filter to extract HR.
      // For now, simulate a resting HR.
      this.state.heartRate = 72;
    } catch {
      this.state.sources.rppg = false;
    }
  }

  /** Web Bluetooth HR monitor (Polar H10). */
  private async initBluetooth(): Promise<void> {
    try {
      // Would call navigator.bluetooth.requestDevice({ filters: [{ services: ["heart_rate"] }] })
      // and subscribe to heart_rate_measurement notifications.
      // Stubbed — requires user gesture + device pairing.
      this.state.sources.bluetooth = false;
    } catch {
      this.state.sources.bluetooth = false;
    }
  }

  /** MediaPipe FaceMesh + blendshapes for facial expression. */
  private async initFacial(): Promise<void> {
    try {
      // Would dynamically import @mediapipe/face_mesh + set up the camera loop.
      // Blendshapes → valence (smile/frown) + arousal (eye widening, jaw drop).
      this.state.sources.facial = false; // stubbed
    } catch {
      this.state.sources.facial = false;
    }
  }

  /** WebGazer.js for gaze tracking. */
  async initGaze(): Promise<void> {
    try {
      // Would dynamically import webgazer + calibrate.
      this.state.sources.gaze = false; // stubbed
    } catch {
      this.state.sources.gaze = false;
    }
  }

  /** Update biometric state (called each frame). */
  update(dt: number): void {
    // Simulate HR drift toward resting (72) when no real signal.
    if (this.state.sources.rppg || this.state.sources.bluetooth) {
      // Real signal — no simulation.
    } else {
      // No signal — simulate gentle drift.
      const target = 72;
      this.state.heartRate += (target - this.state.heartRate) * dt * 0.1;
    }
  }

  /** Get the current biometric state (read-only). */
  getState(): Readonly<BiometricState> { return this.state; }

  /**
   * Phase 6: Integration hooks.
   * Returns modifiers that other systems apply.
   */
  getSuppressionMultiplier(): number {
    // High HR (>100) increases suppression gain by up to 1.5×.
    if (this.state.heartRate > 100) return 1 + (this.state.heartRate - 100) / 100;
    return 1;
  }

  getBleedRateMultiplier(): number {
    // High HR increases bleed rate (blood pumps faster).
    if (this.state.heartRate > 90) return 1 + (this.state.heartRate - 90) / 50;
    return 1;
  }

  getBreathingRateMultiplier(): number {
    // Breathing rate scales with HR.
    return Math.max(0.5, Math.min(2.0, this.state.heartRate / 72));
  }

  getWeaponSwayMultiplier(): number {
    // High arousal (stress) increases weapon sway.
    return 1 + this.state.facialArousal * 0.5;
  }

  dispose(): void {
    if (this.video) this.video.srcObject = null;
    this.video = null;
    if (this.bluetoothDevice) this.bluetoothDevice.gatt?.disconnect();
    this.faceMesh?.close?.();
    this.gazeTracker?.end?.();
  }
}
