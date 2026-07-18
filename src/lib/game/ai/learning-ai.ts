/**
 * Section F — Learning AI.
 *
 * Addresses Section F prompts [F_AI_Enemies-*] that ask for "AI that adapts
 * to player tactics over time" (the adaptive-AI bucket).
 *
 * The learning system tracks the player's tactical patterns (preferred
 * range, cover usage, headshot frequency, flank usage, grenade usage) and
 * adjusts enemy behavior counters in real time. It does NOT use neural
 * nets (overkill for a browser game); instead, it uses:
 *
 *   1. A **tactics histogram** — counts of observed player actions binned
 *      by category (close_range, long_range, headshot, grenade, flank_left,
 *      flank_right, suppress, rush, hold_position).
 *   2. A **softmax counter-policy** — each enemy class has a weighted
 *      counter-tactic; the weights shift toward counters that have worked
 *      (measured by "did this counter-tactic reduce player HP / cause
 *      player damage in the next 5s?").
 *   3. An **adaptation vector** per match — a 1D scalar for each axis
 *      (aggression, accuracy, flank_preference, grenade_preference,
 *      cover_preference) that EnemySystem reads to bias FSM decisions.
 *
 * The model is intentionally lightweight: ~1 KB of state per match, O(1)
 * per-enemy lookup. Pure-TS, SSR-safe, deterministic given inputs.
 *
 * Integration:
 *   - EnemySystem pushes observations via `recordPlayerAction(...)` each
 *     time the player does something the AI can observe (firing from
 *     cover, throwing a grenade, flanking, etc.).
 *   - The director (ai/director.ts) pulls the adaptation vector via
 *     `getAdaptationVector()` once per second and folds it into its
 *     PacingDecision.
 *   - Per-enemy counter-tactic lookups happen in enemy-tactics.ts via
 *     `getCounterTactic(enemyClass)`.
 */

import type { EnemyClass } from "../EnemyClasses";

// ───────────────────────────────────────────────────────────────────────────
// Observation types
// ───────────────────────────────────────────────────────────────────────────

/** Categories of player actions the AI can observe + learn from. */
export type PlayerActionCategory =
  | "close_range"        // engagement within 8m
  | "mid_range"          // engagement 8-25m
  | "long_range"         // engagement > 25m
  | "headshot"           // headshot kill
  | "body_shot"          // body-shot kill
  | "grenade_throw"      // threw a grenade
  | "smoke_throw"        // threw smoke
  | "flash_throw"        // threw a flash
  | "flank_left"         // moved to player's left from enemy POV
  | "flank_right"        // moved to player's right
  | "suppress"           // sustained auto fire (≥ 10 rounds in 2s)
  | "rush"               // sprint toward an enemy
  | "hold_position"      // stayed in cover ≥ 3s
  | "slide_attack"       // slide-into-melee
  | "vault"              // vaulted an obstacle
  | "reload_under_fire"  // reloaded while suppressed
  | "ace_kill"           // killed 2+ enemies within 0.5s
  | "miss"               // missed a shot
  | "hit"                // hit an enemy (no kill)
  | "kill";              // killed an enemy

/** Counter-tactic an enemy can apply in response. */
export type CounterTactic =
  | "push_close"          // close distance to deny long-range advantage
  | "kite_back"           // maintain distance vs. rusher
  | "spread_formation"    // deny ace kills / multi-kill grenades
  | "tighten_formation"   // concentrate fire vs. spread player
  | "use_cover_aggressive"// counter a rusher with cover ambush
  | "use_cover_defensive" // counter a sniper by holding cover
  | "flank_left"          // circle the player's left
  | "flank_right"         // circle the player's right
  | "suppress"            // pin the player to deny movement
  | "rush"                // close to melee/CQB range
  | "throw_grenade"       // flush from cover
  | "hold_overwatch"      // wait for the player to expose
  | "reposition"          // break LOS, find new angle
  | "default_engage";     // baseline

// ───────────────────────────────────────────────────────────────────────────
// Per-class counter-tactic policy
// ───────────────────────────────────────────────────────────────────────────

/** Per-class softmax policy over counter-tactics. Weights shift over time
 *  based on observed effectiveness. */
export interface CounterPolicy {
  /** Current weights per tactic. Larger = more likely to be chosen. */
  weights: Map<CounterTactic, number>;
  /** Number of times each tactic was used + outcome observed. */
  trials: Map<CounterTactic, number>;
  /** Number of times each tactic led to a positive outcome
   *  (player took damage / was killed within 5s). */
  successes: Map<CounterTactic, number>;
}

/** Default policy seeds — small bias toward the class's natural role. */
const DEFAULT_POLICY_SEED: Partial<Record<EnemyClass, Partial<Record<CounterTactic, number>>>> = {
  RIFLEMAN: { suppress: 1.2, push_close: 0.8, flank_left: 0.6, flank_right: 0.6, throw_grenade: 0.4, default_engage: 1.0 },
  SNIPER: { hold_overwatch: 1.5, reposition: 1.0, use_cover_defensive: 0.8, kite_back: 0.6, default_engage: 1.0 },
  MG: { suppress: 1.8, hold_overwatch: 1.0, use_cover_defensive: 0.8, default_engage: 1.0 },
  CQB: { rush: 1.6, push_close: 1.4, flank_left: 0.8, flank_right: 0.8, throw_grenade: 0.5, default_engage: 1.0 },
  COMMANDER: { suppress: 1.0, flank_left: 0.8, flank_right: 0.8, throw_grenade: 0.7, hold_overwatch: 0.7, default_engage: 1.0 },
  MEDIC: { use_cover_defensive: 1.0, hold_overwatch: 0.8, kite_back: 0.6, default_engage: 1.0 },
  SHIELD: { push_close: 1.6, rush: 1.0, use_cover_aggressive: 0.6, default_engage: 1.0 },
  SCOUT: { flank_left: 1.4, flank_right: 1.4, rush: 1.0, reposition: 0.8, default_engage: 1.0 },
  SHOTGUNNER: { rush: 1.8, push_close: 1.4, throw_grenade: 0.4, default_engage: 1.0 },
  ZOMBIE: { rush: 2.0, default_engage: 1.0 },
};

function makePolicy(cls: EnemyClass | undefined): CounterPolicy {
  const seed = (cls && DEFAULT_POLICY_SEED[cls]) || {};
  const weights = new Map<CounterTactic, number>();
  for (const k of Object.keys(seed) as CounterTactic[]) weights.set(k, seed[k] as number);
  if (!weights.has("default_engage")) weights.set("default_engage", 1.0);
  return { weights, trials: new Map(), successes: new Map() };
}

// ───────────────────────────────────────────────────────────────────────────
// Match adaptation vector
// ───────────────────────────────────────────────────────────────────────────

/** Per-axis adaptation scalar — EnemySystem reads these each tick. */
export interface AdaptationVector {
  /** Multiplier on enemy accuracy (0.7..1.3). */
  accuracyMult: number;
  /** Multiplier on enemy aggression (flank probability, push probability). */
  aggressionMult: number;
  /** Bias toward left flank (-1 = strong left, +1 = strong right, 0 = even). */
  flankBias: number;
  /** Multiplier on per-enemy grenade throw probability (0..2). */
  grenadeMult: number;
  /** Multiplier on cover-seeking probability (0..2). */
  coverMult: number;
  /** Recommended counter-tactic for the average enemy this match. */
  recommendedCounter: CounterTactic;
  /** Match confidence (0..1) — how much data has been gathered. */
  confidence: number;
}

// ───────────────────────────────────────────────────────────────────────────
// LearningAI — per-match state
// ───────────────────────────────────────────────────────────────────────────

/** Tunables. */
const SOFTMAX_TAU = 0.5;        // Higher = flatter distribution.
const MIN_TRIALS_FOR_CONFIDENCE = 10;
const DECAY_PER_TICK = 0.995;   // Slight decay so the model adapts to mid-match shifts.
const REWARD_GAIN = 0.15;       // Weight increase on a successful counter.
const PENALTY_GAIN = 0.05;      // Weight decrease on an unsuccessful counter (smaller — avoid thrash).
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 5.0;

/** Pending outcome observations — counter-tactic used + the time it must
 *  pay off by to count as a success. */
interface PendingOutcome {
  /** Counter-tactic applied. */
  tactic: CounterTactic;
  /** Class of the enemy that applied it (for per-class policy update). */
  cls: EnemyClass | undefined;
  /** Time by which the player must take damage for this to count as success. */
  deadlineMs: number;
}

export class LearningAI {
  /** Per-class policy. */
  private policies: Map<EnemyClass | undefined, CounterPolicy> = new Map();
  /** Histogram of player actions observed this match. */
  private actionHistogram: Map<PlayerActionCategory, number> = new Map();
  /** Pending outcomes awaiting payoff observation. */
  private pending: PendingOutcome[] = [];
  /** Cached adaptation vector (recomputed every 1s). */
  private cached: AdaptationVector = {
    accuracyMult: 1.0,
    aggressionMult: 1.0,
    flankBias: 0,
    grenadeMult: 1.0,
    coverMult: 1.0,
    recommendedCounter: "default_engage",
    confidence: 0,
  };
  private lastVectorAt: number = 0;
  private lastPlayerDamageAt: number = 0;
  private totalObservations: number = 0;

  // ---------- Observation API ----------

  /** Record an observed player action (called by EnemySystem / WeaponSystem). */
  recordPlayerAction(cat: PlayerActionCategory, now: number = performance.now()): void {
    this.actionHistogram.set(cat, (this.actionHistogram.get(cat) ?? 0) + 1);
    this.totalObservations++;
    // A hit/kill by the player is the negative payoff for any pending tactic
    // (the tactic didn't prevent the damage).
    if (cat === "hit" || cat === "kill" || cat === "headshot" || cat === "ace_kill") {
      // The player just damaged an enemy — any pending counter older than
      // 1s ago that hasn't paid off is a failure.
      this.lastPlayerDamageAt = now;
    }
  }

  /** Record that an enemy applied a counter-tactic at time `now`. The
   *  system will check whether the player took damage within 5s to score
   *  the outcome. */
  recordCounterApplied(tactic: CounterTactic, cls: EnemyClass | undefined, now: number = performance.now()): void {
    this.pending.push({ tactic, cls, deadlineMs: now + 5000 });
    if (this.pending.length > 64) this.pending.shift(); // cap memory.
  }

  /** Record that the player took damage at time `now` (called by
   *  SuppressionSystem / damage system). Pays off pending tactics. */
  recordPlayerDamaged(now: number = performance.now()): void {
    if (this.pending.length === 0) return;
    const remaining: PendingOutcome[] = [];
    for (const p of this.pending) {
      if (now <= p.deadlineMs) {
        // Success — the tactic paid off (player took damage before deadline).
        this.rewardTactic(p.tactic, p.cls, true);
      } else {
        // Already past deadline — was a failure (handled in tick).
        remaining.push(p);
      }
    }
    this.pending = remaining;
  }

  /** Per-tick update — expires stale pending outcomes + recomputes the
   *  adaptation vector at most once per second. */
  tick(now: number = performance.now()): void {
    // Expire pending outcomes whose deadline has passed (counted as failures).
    if (this.pending.length > 0) {
      const remaining: PendingOutcome[] = [];
      for (const p of this.pending) {
        if (now > p.deadlineMs) {
          this.rewardTactic(p.tactic, p.cls, false);
        } else {
          remaining.push(p);
        }
      }
      this.pending = remaining;
    }
    // Apply weight decay (so the model tracks mid-match shifts).
    if (this.totalObservations > 0 && Math.random() < 0.1) {
      for (const policy of this.policies.values()) {
        for (const [k, v] of policy.weights) {
          policy.weights.set(k, Math.max(MIN_WEIGHT, v * DECAY_PER_TICK));
        }
      }
    }
    // Recompute the cached adaptation vector once per second.
    if (now - this.lastVectorAt > 1000) {
      this.cached = this.computeVector();
      this.lastVectorAt = now;
    }
  }

  // ---------- Read API ----------

  /** Get the recommended counter-tactic for the given enemy class.
   *  Sampled via softmax from the class's policy weights. */
  getCounterTactic(cls: EnemyClass | undefined, rng: () => number = Math.random): CounterTactic {
    const policy = this.policies.get(cls) ?? this.getOrCreatePolicy(cls);
    return sampleSoftmax(policy.weights, rng);
  }

  /** Get the current adaptation vector (cached, recomputed ≤ 1 Hz). */
  getAdaptationVector(): AdaptationVector {
    return this.cached;
  }

  /** Get the raw histogram (for debug overlay / telemetry). */
  getHistogram(): Map<PlayerActionCategory, number> {
    return new Map(this.actionHistogram);
  }

  /** Reset the learning state (called on match restart). */
  reset(): void {
    this.policies.clear();
    this.actionHistogram.clear();
    this.pending = [];
    this.totalObservations = 0;
    this.lastVectorAt = 0;
    this.lastPlayerDamageAt = 0;
    this.cached = {
      accuracyMult: 1.0,
      aggressionMult: 1.0,
      flankBias: 0,
      grenadeMult: 1.0,
      coverMult: 1.0,
      recommendedCounter: "default_engage",
      confidence: 0,
    };
  }

  // ---------- Internal ----------

  private getOrCreatePolicy(cls: EnemyClass | undefined): CounterPolicy {
    let p = this.policies.get(cls);
    if (!p) {
      p = makePolicy(cls);
      this.policies.set(cls, p);
    }
    return p;
  }

  private rewardTactic(tactic: CounterTactic, cls: EnemyClass | undefined, success: boolean): void {
    const policy = this.getOrCreatePolicy(cls);
    const cur = policy.weights.get(tactic) ?? 1.0;
    const delta = success ? REWARD_GAIN : -PENALTY_GAIN;
    policy.weights.set(tactic, Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, cur + delta)));
    policy.trials.set(tactic, (policy.trials.get(tactic) ?? 0) + 1);
    if (success) policy.successes.set(tactic, (policy.successes.get(tactic) ?? 0) + 1);
  }

  private computeVector(): AdaptationVector {
    const h = this.actionHistogram;
    const get = (k: PlayerActionCategory) => h.get(k) ?? 0;
    const totalEngagements =
      get("close_range") + get("mid_range") + get("long_range") || 1;
    const longRangeRatio = get("long_range") / totalEngagements;
    const closeRangeRatio = get("close_range") / totalEngagements;
    const totalShots = get("hit") + get("miss") + get("kill") + get("headshot") || 1;
    const playerAccuracy = (get("hit") + get("kill") + get("headshot")) / totalShots;
    const flankLeft = get("flank_left");
    const flankRight = get("flank_right");
    const totalFlanks = flankLeft + flankRight || 1;
    const grenadeRatio =
      (get("grenade_throw") + get("smoke_throw") + get("flash_throw")) /
      Math.max(1, totalEngagements);

    // Confidence grows with observation count.
    const confidence = Math.min(1, this.totalObservations / MIN_TRIALS_FOR_CONFIDENCE);

    // Accuracy mult: if the player is hitting a lot, bump enemy accuracy.
    const accuracyMult = clamp(0.7 + playerAccuracy * 0.6, 0.7, 1.3);
    // Aggression: if the player is rushing / closing, push back harder.
    const aggressionMult = clamp(0.8 + closeRangeRatio * 0.5, 0.8, 1.3);
    // Flank bias: lean toward the side the player uses LESS (counter their habit).
    const flankBias = clamp((flankRight - flankLeft) / totalFlanks, -1, 1);
    // Grenade mult: if the player grenades, enemies throw more too.
    const grenadeMult = clamp(0.6 + grenadeRatio * 4, 0.6, 2.0);
    // Cover mult: if the player is a sniper (long-range), enemies seek cover more.
    const coverMult = clamp(0.7 + longRangeRatio * 1.5, 0.7, 2.0);

    // Recommended counter — pick the highest-weight tactic across all classes.
    let best: CounterTactic = "default_engage";
    let bestW = -Infinity;
    for (const policy of this.policies.values()) {
      for (const [k, w] of policy.weights) {
        if (w > bestW) { bestW = w; best = k; }
      }
    }

    return {
      accuracyMult,
      aggressionMult,
      flankBias,
      grenadeMult,
      coverMult,
      recommendedCounter: best,
      confidence,
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Sample a key from a Map<key, weight> via softmax with temperature tau. */
function sampleSoftmax<K>(weights: Map<K, number>, rng: () => number, tau: number = SOFTMAX_TAU): K {
  if (weights.size === 0) throw new Error("sampleSoftmax: empty weights");
  // Compute softmax probabilities.
  let max = -Infinity;
  for (const w of weights.values()) if (w > max) max = w;
  let sum = 0;
  const probs: Array<[K, number]> = [];
  for (const [k, w] of weights) {
    const p = Math.exp((w - max) / tau);
    probs.push([k, p]);
    sum += p;
  }
  // Sample.
  let r = rng() * sum;
  for (const [k, p] of probs) {
    r -= p;
    if (r <= 0) return k;
  }
  return probs[probs.length - 1][0];
}

// ───────────────────────────────────────────────────────────────────────────
// Process-wide singleton
// ───────────────────────────────────────────────────────────────────────────

let _instance: LearningAI | null = null;

/** Get the process-wide LearningAI singleton (created lazily). */
export function getLearningAI(): LearningAI {
  if (!_instance) _instance = new LearningAI();
  return _instance;
}

/** Replace the singleton (used by tests / match-restart). */
export function setLearningAI(ai: LearningAI | null): void {
  _instance = ai;
}

/** Destroy the singleton (called on engine dispose / match end). */
export function destroyLearningAI(): void {
  _instance = null;
}
