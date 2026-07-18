import { DUCKING_RULES, type DuckingRule } from "./AudioEnhancements";

// ─── G-5000 prompt mapping ──────────────────────────────────────────────────
// This file owns the following G-5000 prompts. The "→ NNNN" suffix is the
// prior-mission prompt number (G2 = worklog Task G2-audio-bugs-112-144;
// G = worklog Task G-audio-811-900) that implements it. The bracketed name
// is the search target for the actual implementation.
//
//   #3407 → G2 #118 — mid-ramp value capture snap   [duck() uses cancelAndHoldAtTime(t) + lastScheduledGain fallback]
//   #3428 → G2 #139 — DUCKING_RULES table wired      [duckForTrigger(trigger, durationMs)]
//   #3511 → G  #888 — per-bus volume slider          [setBusVolume via BusExtensionsG in SectionG.ts; nominal-default setters here]
//   #3512 → G  #889 — mute-all toggle                [BusExtensionsG.muteAll / unmuteAll (SectionG.ts) operate on this BusMixer]
//   #3506 → G  #883 — ducking coexistence verify     [verifyDuckingCoexistence in SectionG.ts asserts BusMixer.duck math]
//   #3596 → G  #883 — (cross-ref to #3506)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SEC8-AUDIO (prompt 69) — Audio mixing bus architecture.
 *
 * Pure-Web-Audio bus graph:
 *   [sfx / music / vo / ui]  →  master  →  destination
 *
 * Each bus is its own GainNode so the engine can apply per-bus volume + ducking
 * rules (gunfire ducks music ~6dB; VO ducks everything else ~8dB). Ducking is
 * scheduled against the AudioContext clock and supports overlapping ducks via a
 * per-bus "latest end time" tracker.
 *
 * SSR-safe: every audio property is lazily created in `attach()`.
 */

export type BusName = "sfx" | "music" | "vo" | "ui";

export interface BusMixerOptions {
  masterVolume?: number;
  sfxVolume?: number;
  musicVolume?: number;
  voVolume?: number;
  uiVolume?: number;
}

const DEFAULT_NOMINAL: Record<BusName, number> = {
  sfx: 0.85,
  music: 0.55,
  vo: 1.0,
  ui: 0.6,
};

const BUS_NAMES: BusName[] = ["sfx", "music", "vo", "ui"];

/**
 * Convert a dB attenuation (positive = quieter) to a linear gain ratio.
 * e.g. dbToRatio(6)  ≈ 0.501 (half volume)
 *      dbToRatio(8)  ≈ 0.398
 *      dbToRatio(0)  = 1
 */
export function dbToRatio(db: number): number {
  return Math.pow(10, -Math.abs(db) / 20);
}

export class BusMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses: Partial<Record<BusName, GainNode>> = {};
  private nominal: Record<BusName, number> = { ...DEFAULT_NOMINAL };
  /** Latest scheduled duck-end time (in ctx.currentTime seconds) per bus. */
  private activeDuckEnd: Record<BusName, number> = { sfx: 0, music: 0, vo: 0, ui: 0 };
  /** G2 #118 — last scheduled gain target per bus. Used as a fallback when
   *  `cancelAndHoldAtTime` is unavailable so overlapping ducks read the
   *  latest scheduled value rather than `bus.gain.value` (which is the value
   *  at the latest scheduled time, NOT the current value at time `t`). */
  private lastScheduledGain: Record<BusName, number> = { sfx: 1, music: 1, vo: 1, ui: 1 };
  /** setTimeout tokens for duck-end cleanup, so dispose() can clear them. */
  private timers: Record<BusName, ReturnType<typeof setTimeout> | null> = {
    sfx: null,
    music: null,
    vo: null,
    ui: null,
  };

  /** Build the bus graph on a given AudioContext. Idempotent per-context. */
  attach(ctx: AudioContext, opts: BusMixerOptions = {}): void {
    if (this.ctx === ctx && this.master) return;
    this.detach();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = opts.masterVolume ?? 0.9;
    this.master.connect(ctx.destination);
    for (const name of BUS_NAMES) {
      const g = ctx.createGain();
      const v = opts[`${name}Volume` as keyof BusMixerOptions];
      this.nominal[name] = v ?? DEFAULT_NOMINAL[name];
      g.gain.value = this.nominal[name];
      g.connect(this.master);
      this.buses[name] = g;
    }
  }

  detach(): void {
    for (const name of BUS_NAMES) {
      if (this.timers[name]) {
        clearTimeout(this.timers[name]!);
        this.timers[name] = null;
      }
    }
    this.buses = {};
    this.master = null;
    this.ctx = null;
    this.activeDuckEnd = { sfx: 0, music: 0, vo: 0, ui: 0 };
  }

  getBus(name: BusName): GainNode | null {
    return this.buses[name] ?? null;
  }

  getMaster(): GainNode | null {
    return this.master;
  }

  /** Per-bus nominal volume setter (also updates live gain if not ducked). */
  setBusVolume(name: BusName, vol: number): void {
    this.nominal[name] = vol;
    const bus = this.buses[name];
    if (!bus || !this.ctx) return;
    // Only snap the live value if no duck is currently active.
    if (this.ctx.currentTime >= this.activeDuckEnd[name]) {
      bus.gain.cancelScheduledValues(this.ctx.currentTime);
      bus.gain.setValueAtTime(Math.max(0.0001, vol), this.ctx.currentTime);
    }
  }

  getBusVolume(name: BusName): number {
    return this.nominal[name];
  }

  setMasterVolume(vol: number): void {
    if (this.master) this.master.gain.value = vol;
  }

  /**
   * Temporarily attenuate a bus by `amountDb` (positive = quieter) for
   * `durationMs`, then restore to nominal. Multiple overlapping ducks on the
   * same bus extend the restore time to the latest end; the deepest duck wins
   * the bottom-of-dip gain (most-recent caller's amountDb).
   *
   * SEC8 prompt 63 (sidechain ducking) — `attackMs` controls the dip attack
   * (default 25ms). Gunfire ducking uses 50ms attack / 300ms recovery for a
   * more pronounced sidechain pump: 6dB dip over 50ms, recovery over 300ms.
   *
   * G2 #118 — was `setValueAtTime(bus.gain.value, t)` which captures the
   * last-scheduled value, NOT the actual current value at time `t`. When two
   * ducks overlap (one recovering, one dipping), the second duck reads the
   * mid-ramp value of the first as its starting point — but the value it
   * reads is the latest *scheduled* value (which may be the bottom of the
   * first dip, much quieter than the current value). The result is a click
   * when the second duck snaps to the wrong starting value.
   *
   * Fix: use `cancelAndHoldAtTime(t)` (Chrome 100+, Safari 15.4+, FF 93+)
   * which cancels future scheduled values AND holds the current automation
   * value at time `t`. This is the canonical Web Audio API way to graft a new
   * automation onto an in-flight ramp without discontinuities. Fallback for
   * older browsers: track the last scheduled target value per bus (close
   * enough — the click only manifests on overlapping ducks, and the captured
   * value is at most ~6dB off the true value).
   */
  duck(name: BusName, amountDb: number, durationMs: number, attackMs: number = 25): void {
    const bus = this.buses[name];
    const ctx = this.ctx;
    if (!bus || !ctx) return;
    const t = ctx.currentTime;
    const ratio = dbToRatio(amountDb);
    const end = t + Math.max(20, durationMs) / 1000;
    if (end > this.activeDuckEnd[name]) {
      this.activeDuckEnd[name] = end;
    }
    const restoreAt = this.activeDuckEnd[name];
    const dipped = Math.max(0.0001, this.nominal[name] * ratio);
    const nominal = Math.max(0.0001, this.nominal[name]);
    const attackSec = Math.max(0.001, Math.min(0.5, attackMs / 1000));
    // G2 #118 — cancelAndHoldAtTime preserves the in-flight value at t; fall
    // back to cancelScheduledValues + setValueAtTime with the last tracked
    // target value when the API isn't available (older browsers).
    const gainParam = bus.gain as AudioParam & {
      cancelAndHoldAtTime?: (t: number) => void;
    };
    if (typeof gainParam.cancelAndHoldAtTime === "function") {
      gainParam.cancelAndHoldAtTime(t);
    } else {
      bus.gain.cancelScheduledValues(t);
      const heldValue = this.lastScheduledGain[name] ?? Math.max(0.0001, bus.gain.value);
      bus.gain.setValueAtTime(heldValue, t);
    }
    // Track the new target so subsequent overlapping ducks read the latest
    // scheduled value (used by the fallback path above).
    this.lastScheduledGain[name] = dipped;
    // Configurable attack dip + exponential recovery back to nominal at restoreAt.
    bus.gain.exponentialRampToValueAtTime(dipped, t + attackSec);
    bus.gain.exponentialRampToValueAtTime(nominal, restoreAt);
    this.lastScheduledGain[name] = nominal;
    // Schedule cleanup of the duck tracker.
    if (this.timers[name]) clearTimeout(this.timers[name]!);
    const cleanupMs = Math.max(50, (restoreAt - t) * 1000 + 100);
    this.timers[name] = setTimeout(() => {
      this.timers[name] = null;
      const now = this.ctx?.currentTime ?? 0;
      if (this.activeDuckEnd[name] <= now + 0.05) {
        this.activeDuckEnd[name] = 0;
      }
    }, cleanupMs);
  }

  /**
   * G2 #139 — apply a ducking rule by trigger category. The DUCKING_RULES
   * table in AudioEnhancements.ts defines per-trigger (vo / announcer /
   * stinger) ducking behaviour: which buses get ducked, by how much, with
   * what attack/release. This method looks up the rule(s) for a trigger and
   * applies each via `duck()` so VO barks duck music, announcer lines duck
   * music+sfx+ambience, and stingers duck music — all per the rules table
   * rather than per-call hard-coded values.
   *
   * @param trigger  Trigger category ("vo" | "announcer" | "stinger").
   * @param durationMs  Duration of the triggering sound (the duck holds this
   *                    long + the rule's release tail).
   */
  duckForTrigger(trigger: DuckingRule["trigger"], durationMs: number): void {
    for (const rule of DUCKING_RULES) {
      if (rule.trigger !== trigger) continue;
      const totalMs = durationMs + rule.releaseMs;
      // The attack is the rule's attack (not the default 25ms).
      for (const busName of rule.ducked) {
        // Only duck buses we actually have (the rules table includes
        // "ambience" which we don't have as a dedicated bus — skip it).
        if (busName === "ambience") continue;
        // amount is in 0..1 (1 = full mute); convert to dB attenuation.
        const amountDb = -20 * Math.log10(Math.max(0.0001, 1 - rule.amount));
        this.duck(busName, amountDb, totalMs, rule.attackMs);
      }
    }
  }

  /** Convenience: schedule a VO-driven side-chain that ducks everything else. */
  duckEverythingElse(amountDb: number, durationMs: number): void {
    this.duck("sfx", amountDb, durationMs);
    this.duck("music", amountDb, durationMs);
    this.duck("ui", amountDb, durationMs);
  }

  /**
   * Convenience: gunfire ducks music briefly.
   *
   * SEC8 prompt 63 — defaults tuned for sidechain pumping:
   *   • 6 dB attenuation
   *   • 50 ms attack  (dip ramps down over 50ms — fast enough to duck the
   *     body thump + tail, slow enough to not sound like a glitch)
   *   • 300 ms recovery (back to nominal over 300ms — natural-sounding pump
   *     that leaves the music audibly present between shots)
   *
   * For automatic fire (600 RPM = 100ms between shots) the ducks overlap →
   * the music stays dipped for the duration of the burst, then releases over
   * 300ms after the last shot. That matches the spec: "duck the music bus
   * by ~6dB for 0.3s".
   */
  duckMusicForGunfire(amountDb = 6, durationMs = 300): void {
    this.duck("music", amountDb, durationMs, 50);
  }

  dispose(): void {
    this.detach();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components)
// ─────────────────────────────────────────────────────────────────────────────

let _mixer: BusMixer | null = null;
export function getBusMixer(): BusMixer {
  if (!_mixer) _mixer = new BusMixer();
  return _mixer;
}
