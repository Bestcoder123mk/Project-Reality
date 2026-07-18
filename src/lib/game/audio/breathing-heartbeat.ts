/**
 * Section H — Unified vitals audio (breathing + heartbeat) orchestrator.
 *
 * Section H prompt coverage: H_Audio_Immersion-00002/00006/00011/00054/00093/
 * 04907/04949/04981/04993 — operator breath (calm/winded/panicked) + heartbeat
 * audio assets for the kill-cam, jungle ambush, indoor CQB, snowy mountain,
 * night ops, and main-menu maps at multiple quality tiers.
 *
 * The Section H prompt library repeatedly pairs breath state with heartbeat
 * state — they share a single set of player vitals inputs (stamina, health,
 * sprinting, aiming, under fire, recently damaged, dead). The split modules
 * `breathing-audio.ts` (stamina-driven breath state machine) and
 * `heartbeat.ts` (stress-driven BPM modulation) each expose their own
 * attach/start/update/stop/dispose, which forces the engine wiring to keep
 * two parallel lifecycles in sync.
 *
 * This module bridges the two into a single `VitalsAudioEngine` so callers
 * can drive both from one vitals snapshot:
 *
 *   const vitals = getVitalsAudioEngine();
 *   vitals.attach(ctx, buses, noiseBuffer);
 *   vitals.start();
 *   // per frame:
 *   vitals.update({
 *     stamina: 0.62, health: 42,
 *     isSprinting: true, isAiming: false, isMoving: true,
 *     isDead: false, underFire: false, nowMs: performance.now(),
 *     recentDamageMs: [...],
 *   });
 *   // on death / unload:
 *   vitals.dispose();
 *
 * Internally the engine forwards the breath derivation to the
 * `BreathingAudioEngine` and the heartbeat stress input to the
 * `HeartbeatAudioEngine`. Both sub-engines remain independently usable for
 * callers that only need one of the two vitals streams (e.g. the kill-cam
 * only plays the breath; the low-HP red zone only plays the heartbeat).
 *
 * SSR-safe: every AudioContext touch is guarded by `attach()`.
 */

import type { BusMixer } from "./buses";
import {
  BreathingAudioEngine,
  BREATH_PROFILES,
  deriveBreathState,
  getBreathingAudioEngine,
  type BreathState,
  type BreathProfile,
} from "./breathing-audio";
import {
  HeartbeatAudioEngine,
  getHeartbeatAudioEngine,
  type HeartbeatStressInput,
} from "./heartbeat";

export type { BreathState, BreathProfile, HeartbeatStressInput };
export { BREATH_PROFILES, deriveBreathState };

/**
 * Unified vitals snapshot — what the gameplay layer knows about the player
 * each frame. Both the breath state machine and the heartbeat stress model
 * derive their targets from this single object.
 */
export interface VitalsInput {
  /** Player stamina 0..1 (1 = full). */
  stamina: number;
  /** Player health 0..100. */
  health: number;
  /** Currently sprinting? */
  isSprinting: boolean;
  /** Currently aiming down sights? */
  isAiming: boolean;
  /** Currently moving (not idle)? */
  isMoving: boolean;
  /** Currently dead (drives the final-gasp + heartbeat halt)? */
  isDead: boolean;
  /** Currently under fire (suppression > 0.5)? */
  underFire: boolean;
  /** Recent damage event timestamps (ms, performance.now or Date.now). */
  recentDamageMs?: number[];
  /** Current time (ms). Defaults to performance.now(). */
  nowMs?: number;
}

/**
 * Read-only snapshot of the vitals engine's current state — used by the HUD
 * (breath-rate meter, heart-rate indicator, low-HP pulse overlay).
 */
export interface VitalsAudioSnapshot {
  breathState: BreathState;
  breathBpm: number;
  heartBpm: number;
  heartGain: number;
  started: boolean;
}

/**
 * VitalsAudioEngine — wraps a BreathingAudioEngine + HeartbeatAudioEngine pair
 * behind a single attach/start/update/stop/dispose lifecycle.
 *
 * Both sub-engines are obtained from their canonical singletons by default so
 * that callers that grab one independently (e.g. the kill-cam grabs the breath
 * engine to play a one-shot gasp) see the same instance the unified engine
 * uses. For tests or sandboxed setups, the constructor accepts injectable
 * sub-engine instances.
 */
export class VitalsAudioEngine {
  private readonly breath: BreathingAudioEngine;
  private readonly heart: HeartbeatAudioEngine;
  private started = false;
  private lastSnapshot: VitalsAudioSnapshot = {
    breathState: "rest",
    breathBpm: BREATH_PROFILES.rest.bpm,
    heartBpm: 60,
    heartGain: 0,
    started: false,
  };

  constructor(opts?: {
    breath?: BreathingAudioEngine;
    heart?: HeartbeatAudioEngine;
  }) {
    this.breath = opts?.breath ?? getBreathingAudioEngine();
    this.heart = opts?.heart ?? getHeartbeatAudioEngine();
  }

  /**
   * Attach to an AudioContext + BusMixer. The breathing engine also needs a
   * noise buffer for its filtered-noise breath synthesis.
   */
  attach(ctx: AudioContext, buses: BusMixer, noiseBuffer: AudioBuffer): void {
    this.breath.attach(ctx, buses, noiseBuffer);
    this.heart.attach(ctx, buses);
  }

  /** Re-supply the noise buffer (used by AudioSystem when it regenerates one). */
  setNoiseBuffer(buf: AudioBuffer): void {
    this.breath.setNoiseBuffer(buf);
  }

  /** Start both sub-engines. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.breath.start();
    this.heart.start();
    this.lastSnapshot.started = true;
  }

  /** Stop both sub-engines (halts scheduling but does not dispose). */
  stop(): void {
    this.started = false;
    this.breath.stop();
    this.heart.stop();
    this.lastSnapshot.started = false;
  }

  /**
   * Per-frame vitals update. Derives BreathState from stamina + flags and
   * forwards the heartbeat stress input. Both sub-engines ramp their internal
   * targets smoothly so this is safe to call at any cadence (1Hz is fine,
   * 60Hz is ideal).
   */
  update(input: VitalsInput): void {
    const nowMs = input.nowMs ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
    // Breathing — derive state from stamina + health + movement flags.
    const breathState = deriveBreathState({
      stamina: input.stamina,
      health: input.health,
      isSprinting: input.isSprinting,
      isAiming: input.isAiming,
      isMoving: input.isMoving,
      isDead: input.isDead,
    });
    this.breath.setState(breathState);
    // Heartbeat — forward the stress input.
    const heartInput: HeartbeatStressInput = {
      health: input.health,
      recentDamageMs: input.recentDamageMs ?? [],
      isSprinting: input.isSprinting,
      underFire: input.underFire,
      stamina: input.stamina,
      nowMs,
    };
    this.heart.update(heartInput);
    // Refresh snapshot.
    this.lastSnapshot = {
      breathState,
      breathBpm: this.breath.getCurrentBpm(),
      heartBpm: this.heart.getCurrentBpm(),
      heartGain: this.heart.getCurrentGain(),
      started: this.started,
    };
  }

  /** Read-only vitals snapshot for the HUD. */
  getSnapshot(): VitalsAudioSnapshot {
    return { ...this.lastSnapshot };
  }

  /** True if both sub-engines are started. */
  isRunning(): boolean {
    return this.started;
  }

  /** Direct accessors (for callers that need one sub-engine only). */
  getBreathEngine(): BreathingAudioEngine { return this.breath; }
  getHeartEngine(): HeartbeatAudioEngine { return this.heart; }

  /** Dispose both sub-engines. The unified engine cannot be restarted after this. */
  dispose(): void {
    this.stop();
    try { this.breath.dispose(); } catch { /* noop */ }
    try { this.heart.dispose(); } catch { /* noop */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _vitals: VitalsAudioEngine | null = null;

/**
 * Get the shared VitalsAudioEngine singleton. By default the breathing +
 * heartbeat sub-engines are also their respective singletons, so callers that
 * grab one of them directly see the same instance the unified engine uses.
 */
export function getVitalsAudioEngine(): VitalsAudioEngine {
  if (!_vitals) _vitals = new VitalsAudioEngine();
  return _vitals;
}

/**
 * Reset the singleton. Used by engine.dispose() + tests. Does NOT dispose the
 * underlying sub-engine singletons (call getBreathingAudioEngine().dispose()
 * / getHeartbeatAudioEngine().dispose() explicitly if you want that).
 */
export function resetVitalsAudioEngine(): void {
  _vitals = null;
}
