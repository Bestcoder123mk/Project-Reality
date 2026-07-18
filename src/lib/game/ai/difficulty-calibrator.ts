/**
 * Section F — Difficulty calibration harness.
 *
 * Addresses Section F prompts for "automatic difficulty adjustment based
 * on player performance". Distinct from the existing AIDirector (which
 * modulates per-match pacing within a fixed baseline) — the calibrator
 * tracks player performance ACROSS matches + nudges the baseline difficulty
 * up or down so the next match is appropriately challenging.
 *
 * The calibrator persists to localStorage (browser-only; SSR-safe guard)
 * and exposes a small API the engine reads at match start to choose the
 * starting DifficultyConfig. The director's per-match tuning then layers
 * on top of this baseline.
 *
 * Calibration model:
 *   - Track per-match outcome (kills, deaths, time, wave reached, headshot %).
 *   - Compute a "skill estimate" — a single scalar 0..1 representing the
 *     player's demonstrated skill. Bounded EMA so a fluke match doesn't
 *     shift it wildly.
 *   - Map skill estimate to a baseline difficulty (easy / normal / hard /
 *     expert) using hysteresis bands (so a player near a band edge doesn't
 *     oscillate between matches).
 *   - Expose per-axis sub-tunables (enemyAccuracy, enemyAggression,
 *     enemyHealth, spawnRate) so the engine can apply a fine-grained
 *     baseline rather than a discrete difficulty label.
 *
 * Pure-TS, SSR-safe (localStorage access guarded by typeof check).
 */

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type DifficultyLabel = "easy" | "normal" | "hard" | "expert";

/** Per-axis sub-tunables. Each is a multiplier on the baseline config. */
export interface DifficultyTunables {
  /** Multiplier on enemy accuracy (0.5..1.5). */
  enemyAccuracyMult: number;
  /** Multiplier on enemy aggression / flank probability (0.5..1.5). */
  enemyAggressionMult: number;
  /** Multiplier on enemy health (0.7..1.4). */
  enemyHealthMult: number;
  /** Multiplier on per-wave spawn count (0.7..1.3). */
  spawnRateMult: number;
  /** Multiplier on enemy reaction time (lower = faster; 0.6..1.5). */
  enemyReactionTimeMult: number;
  /** Multiplier on the AI director's maximum intensity spike (0.7..1.3). */
  directorIntensityMult: number;
}

/** Outcome of a single match — pushed by the engine at match end. */
export interface MatchOutcome {
  /** Timestamp (performance.now() or Date.now() — caller's choice). */
  at: number;
  /** Final wave reached (1-based; 0 if lost on wave 1). */
  waveReached: number;
  /** Total waves in the match (so we can compute fraction-progress). */
  totalWaves: number;
  /** Player kills. */
  kills: number;
  /** Player deaths. */
  deaths: number;
  /** Match duration in seconds. */
  durationSec: number;
  /** Headshot fraction (0..1) of total hits. */
  headshotPct: number;
  /** True if the player won (cleared the final wave). */
  won: boolean;
  /** Player's final killstreak. */
  bestKillstreak: number;
}

export interface CalibrationState {
  /** Bounded EMA of player skill (0..1). */
  skillEstimate: number;
  /** Number of matches observed. */
  matchesObserved: number;
  /** Current recommended baseline label. */
  currentLabel: DifficultyLabel;
  /** Current sub-tunables. */
  tunables: DifficultyTunables;
  /** Recent outcomes (capped at 20). */
  recent: MatchOutcome[];
}

// ───────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────

const SKILL_EMA_ALPHA = 0.25;       // Higher = newer matches weigh more.
const MIN_MATCHES_FOR_TUNE = 3;     // Don't tune until we have ≥3 matches.
const MAX_RECENT = 20;              // Cap recent-outcomes memory.
const STORAGE_KEY = "pr-difficulty-calibration-v1";

/** Hysteresis bands — a player must exceed the higher bound to step up
 *  and drop below the lower bound to step down. */
const BANDS: Array<{ label: DifficultyLabel; upFrom: number; downTo: number; tunables: DifficultyTunables }> = [
  {
    label: "easy",
    upFrom: 0.40, downTo: 0.00,
    tunables: {
      enemyAccuracyMult: 0.65,
      enemyAggressionMult: 0.70,
      enemyHealthMult: 0.80,
      spawnRateMult: 0.80,
      enemyReactionTimeMult: 1.40,
      directorIntensityMult: 0.80,
    },
  },
  {
    label: "normal",
    upFrom: 0.65, downTo: 0.30,
    tunables: {
      enemyAccuracyMult: 1.00,
      enemyAggressionMult: 1.00,
      enemyHealthMult: 1.00,
      spawnRateMult: 1.00,
      enemyReactionTimeMult: 1.00,
      directorIntensityMult: 1.00,
    },
  },
  {
    label: "hard",
    upFrom: 0.85, downTo: 0.55,
    tunables: {
      enemyAccuracyMult: 1.25,
      enemyAggressionMult: 1.20,
      enemyHealthMult: 1.15,
      spawnRateMult: 1.15,
      enemyReactionTimeMult: 0.80,
      directorIntensityMult: 1.15,
    },
  },
  {
    label: "expert",
    upFrom: 1.01, downTo: 0.75,
    tunables: {
      enemyAccuracyMult: 1.45,
      enemyAggressionMult: 1.40,
      enemyHealthMult: 1.30,
      spawnRateMult: 1.30,
      enemyReactionTimeMult: 0.65,
      directorIntensityMult: 1.25,
    },
  },
];

const DEFAULT_TUNABLES: DifficultyTunables = BANDS[1].tunables;
const DEFAULT_STATE: CalibrationState = {
  skillEstimate: 0.5,
  matchesObserved: 0,
  currentLabel: "normal",
  tunables: DEFAULT_TUNABLES,
  recent: [],
};

// ───────────────────────────────────────────────────────────────────────────
// Calibrator
// ───────────────────────────────────────────────────────────────────────────

export class DifficultyCalibrator {
  private state: CalibrationState;

  constructor(initial?: Partial<CalibrationState>) {
    this.state = { ...DEFAULT_STATE, ...initial };
  }

  /** Record a match outcome + recompute the skill estimate + label. */
  recordMatch(outcome: MatchOutcome): CalibrationState {
    this.state.recent.unshift(outcome);
    if (this.state.recent.length > MAX_RECENT) this.state.recent.length = MAX_RECENT;
    this.state.matchesObserved++;

    // Compute instantaneous skill score from this match's outcome.
    const skillScore = this.scoreOutcome(outcome);
    // EMA update.
    const a = SKILL_EMA_ALPHA;
    this.state.skillEstimate = this.state.matchesObserved === 1
      ? skillScore
      : (1 - a) * this.state.skillEstimate + a * skillScore;

    // Only adjust the label after enough matches.
    if (this.state.matchesObserved >= MIN_MATCHES_FOR_TUNE) {
      this.state.currentLabel = this.pickLabel(this.state.currentLabel, this.state.skillEstimate);
      this.state.tunables = BANDS.find((b) => b.label === this.state.currentLabel)?.tunables ?? DEFAULT_TUNABLES;
    }
    this.persist();
    return this.getState();
  }

  /** Get the current calibration state (a snapshot — callers should not
   *  mutate). */
  getState(): CalibrationState {
    return {
      skillEstimate: this.state.skillEstimate,
      matchesObserved: this.state.matchesObserved,
      currentLabel: this.state.currentLabel,
      tunables: { ...this.state.tunables },
      recent: [...this.state.recent],
    };
  }

  /** Force a label (used by the settings UI "I want easy/hard" override). */
  overrideLabel(label: DifficultyLabel): void {
    this.state.currentLabel = label;
    this.state.tunables = BANDS.find((b) => b.label === label)?.tunables ?? DEFAULT_TUNABLES;
    this.persist();
  }

  /** Reset to defaults (called by the settings "Reset difficulty" button). */
  reset(): void {
    this.state = { ...DEFAULT_STATE, recent: [] };
    this.persist();
  }

  // ---------- Internal ----------

  /** Score a single match outcome on a 0..1 skill axis. */
  private scoreOutcome(o: MatchOutcome): number {
    // Wave progress (0..0.5 weight): reaching all waves = 0.5; reaching half = 0.25.
    const waveFrac = o.totalWaves > 0 ? o.waveReached / o.totalWaves : 0;
    // K/D (0..0.25 weight): K/D ≥ 3 = full; K/D = 1 = half; K/D ≤ 0.3 = 0.
    const kd = o.deaths > 0 ? o.kills / o.deaths : o.kills;
    const kdScore = clamp(Math.min(kd, 3) / 3, 0, 1);
    // Headshot accuracy (0..0.1 weight).
    const hsScore = clamp(o.headshotPct, 0, 1);
    // Win bonus (0..0.15 weight).
    const winBonus = o.won ? 1 : 0;
    return clamp(waveFrac * 0.5 + kdScore * 0.25 + hsScore * 0.1 + winBonus * 0.15, 0, 1);
  }

  /** Pick a new label using hysteresis: only step up if skill ≥ band.upFrom,
   *  only step down if skill < band.downTo. */
  private pickLabel(current: DifficultyLabel, skill: number): DifficultyLabel {
    const idx = BANDS.findIndex((b) => b.label === current);
    if (idx < 0) return "normal";
    const band = BANDS[idx];
    if (skill >= band.upFrom && idx < BANDS.length - 1) {
      return BANDS[idx + 1].label;
    }
    if (skill < band.downTo && idx > 0) {
      return BANDS[idx - 1].label;
    }
    return current;
  }

  // ---------- Persistence ----------

  private persist(): void {
    if (typeof localStorage === "undefined") return; // SSR guard.
    try {
      const serializable = {
        skillEstimate: this.state.skillEstimate,
        matchesObserved: this.state.matchesObserved,
        currentLabel: this.state.currentLabel,
        tunables: this.state.tunables,
        recent: this.state.recent.slice(0, MAX_RECENT),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    } catch {
      // Quota-exceeded / serialization error — silently drop; calibration
      // is best-effort + the in-memory state still works.
    }
  }

  private static load(): Partial<CalibrationState> | null {
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as Partial<CalibrationState>;
    } catch {
      return null;
    }
  }

  // ---------- Static factory ----------

  /** Create a calibrator, hydrating from localStorage if available. */
  static create(): DifficultyCalibrator {
    const loaded = DifficultyCalibrator.load();
    return new DifficultyCalibrator(loaded ?? undefined);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ───────────────────────────────────────────────────────────────────────────
// Process-wide singleton
// ───────────────────────────────────────────────────────────────────────────

let _instance: DifficultyCalibrator | null = null;

/** Get the process-wide calibrator (lazy-initialized from localStorage). */
export function getDifficultyCalibrator(): DifficultyCalibrator {
  if (!_instance) _instance = DifficultyCalibrator.create();
  return _instance;
}

/** Replace the singleton (used by tests). */
export function setDifficultyCalibrator(c: DifficultyCalibrator | null): void {
  _instance = c;
}
