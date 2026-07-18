/**
 * G_Multiplayer_Netcode-00006: 60 Hz tick-rate validation.
 *
 * The game loop targets 60 Hz (16.67 ms/tick). Drift causes:
 *
 *   - < 60 Hz: remote players stutter, hit-reg rewinds land in the wrong
 *     frame, melee rollback corrupts.
 *   - > 60 Hz: the server burns CPU + sends redundant snapshots, Cloud Run
 *     concurrency caps hurt.
 *
 * This validator runs alongside the game loop. The caller calls
 * `tick(now)` each frame; `validate()` returns a report with:
 *
 *   - mean / p50 / p95 / p99 inter-tick interval
 *   - hz estimate (1000 / mean)
 *   - drift flags: under-ticked (hz < 58), over-ticked (hz > 62),
 *     jitter (p99 - p50 > 8 ms)
 *   - a `severity` (ok / warn / critical) so the caller can decide whether
 *     to throttle, reduce snapshot rate, or trigger a reconnect.
 *
 * Window is a 1 s rolling ring (60 samples); O(1) per tick.
 */

export type TickSeverity = "ok" | "warn" | "critical";

export interface TickReport {
  hz: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  jitterMs: number;
  underTicked: boolean;
  overTicked: boolean;
  severity: TickSeverity;
  samples: number;
}

export interface TickValidatorOptions {
  /** Target tick interval (ms). Default 1000 / 60 ≈ 16.67. */
  targetMs?: number;
  /** Sample window size (ticks). Default 60. */
  window?: number;
  /** Below this hz → underTicked. Default 58. */
  minHz?: number;
  /** Above this hz → overTicked. Default 62. */
  maxHz?: number;
  /** Jitter threshold for warn (p99 - p50). Default 8. */
  warnJitterMs?: number;
  /** Jitter threshold for critical. Default 20. */
  criticalJitterMs?: number;
  /** hz threshold for critical. Default ±5 from target. */
  criticalHzDelta?: number;
}

const TARGET = 1000 / 60;

export class TickRateValidator {
  private opts: Required<TickValidatorOptions>;
  private intervals: number[] = [];
  private lastTickMs: number | null = null;

  constructor(opts: TickValidatorOptions = {}) {
    this.opts = {
      targetMs: TARGET,
      window: 60,
      minHz: 58,
      maxHz: 62,
      warnJitterMs: 8,
      criticalJitterMs: 20,
      criticalHzDelta: 5,
      ...opts,
    };
  }

  /** Record a tick. `now` should be `performance.now()` or `Date.now()`. */
  tick(now: number): void {
    if (this.lastTickMs !== null) {
      const dt = now - this.lastTickMs;
      this.intervals.push(dt);
      if (this.intervals.length > this.opts.window) this.intervals.shift();
    }
    this.lastTickMs = now;
  }

  /** Compute the current tick-rate report. */
  validate(): TickReport {
    const n = this.intervals.length;
    if (n === 0) {
      return {
        hz: 0,
        meanMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        jitterMs: 0,
        underTicked: false,
        overTicked: false,
        severity: "ok",
        samples: 0,
      };
    }
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const hz = 1000 / mean;
    const p50 = sorted[Math.floor(n * 0.5)];
    const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
    const p99 = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
    const jitter = p99 - p50;
    const under = hz < this.opts.minHz;
    const over = hz > this.opts.maxHz;
    const targetHz = 1000 / this.opts.targetMs;
    const severity: TickSeverity = jitter >= this.opts.criticalJitterMs
      || Math.abs(hz - targetHz) >= this.opts.criticalHzDelta
      ? "critical"
      : jitter >= this.opts.warnJitterMs || under || over
        ? "warn"
        : "ok";
    return {
      hz,
      meanMs: mean,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      jitterMs: jitter,
      underTicked: under,
      overTicked: over,
      severity,
      samples: n,
    };
  }

  reset(): void {
    this.intervals = [];
    this.lastTickMs = null;
  }
}
