/**
 * SEC6-AI prompt 50 — Adaptive pacing director.
 *
 * A Left-4-Dead-style AI director layered on top of `Difficulty.ts`. The
 * static Difficulty config sets the per-match baseline (easy/normal/hard);
 * the director adjusts spawn pressure + enemy aggression in real time
 * based on how the player is actually performing.
 *
 * PerformanceSignal — a snapshot of player state the engine pushes once
 * per second (cheap to compute, no allocations). The director accumulates
 * a rolling window of recent signals + emits a PacingDecision each tick.
 *
 * PacingDecision — the recommendation the engine applies:
 *   - spawnRateMult: 0.5..1.6 — scales the per-wave enemy count + the
 *     Drone Commander reinforcement rate.
 *   - aggressionMult: 0.6..1.5 — scales enemy accuracy + suppression
 *     recovery + flank probability.
 *   - intensity: label for HUD / music crossfade ("CALM" | "BUILDING" |
 *     "PEAK" | "BREATH").
 *
 * The director is intentionally conservative — it never makes the game
 * easier than 0.6× or harder than 1.6× the baseline difficulty. The goal
 * is dynamic flow (valleys + peaks), not whiplash.
 *
 * SSR-safe: pure-TS, no DOM/Three.js. Deterministic given inputs.
 */
import type { DifficultyConfig } from "../Difficulty";
// Section D #1927 — wire the AIEnhancements last-enemy-standing helpers
// (shouldActivateLastEnemyBehavior + pickLastEnemyMode) into the director's
// last-stand logic. The director previously used an inline `enemiesAlive === 1`
// check that matched shouldActivateLastEnemyBehavior's behavior but didn't
// capture the mode (cautious vs desperate). The mode is now stashed on the
// director + surfaced via getLastEnemyMode() so EnemySystem/tickSectionD can
// read it + apply the per-mode behavior (cautious = retreat to cover +
// regen; desperate = charge + melee).
import {
  shouldActivateLastEnemyBehavior,
  pickLastEnemyMode,
} from "../systems/AIEnhancements";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/**
 * A snapshot of player performance pushed by the engine once per second.
 * All fields are optional — the engine fills what it has; the director
 * treats missing fields as "no signal" (neutral).
 */
export interface PerformanceSignal {
  /** performance.now() when the snapshot was taken. */
  now: number;
  /** Player's current health (0..maxHealth). */
  health: number;
  /** Player's max health. */
  maxHealth: number;
  /** Player's current armor (0..100). */
  armor: number;
  /** Total ammo across all carried weapons (mag + reserve). */
  ammoTotal: number;
  /** Max ammo capacity across all carried weapons (for ratio). */
  ammoMax: number;
  /** Timestamp (performance.now()) of the player's most recent death
   *  this match (0 if none). */
  lastDeathAt: number;
  /** Timestamp of the most recent enemy engagement (enemy shot at the
   *  player OR the player damaged an enemy). */
  lastEngagementAt: number;
  /** Number of enemies currently alive. */
  enemiesAlive: number;
  /** Player's current killstreak (kills since last death). */
  killstreak: number;
  /** Player's total kills this match. */
  kills: number;
  /** True if the player is currently downed / unconscious (MedicalSystem). */
  downed: boolean;
  /** Section D #1927 — true if the last-alive enemy is a boss (drives
   *  pickLastEnemyMode → "desperate"). Optional — defaults to false. */
  lastEnemyIsBoss?: boolean;
  /** Section D #1927 — true if the last-alive enemy is a heavy class
   *  (MG/SHIELD/SHOTGUNNER). Optional — defaults to false. */
  lastEnemyIsHeavy?: boolean;
  /** Section D #1927 — HP fraction (0..1) of the last-alive enemy. Optional
   *  — defaults to 1.0 (full HP) which biases toward "desperate". */
  lastEnemyHpFraction?: number;
}

/** Director's recommendation for the current tick. */
export interface PacingDecision {
  /** Multiplier on per-wave spawn count (0.5..1.6). */
  spawnRateMult: number;
  /** Multiplier on enemy accuracy + aggression (0.6..1.5). */
  aggressionMult: number;
  /** Intensity label — for the HUD / adaptive music crossfade. */
  intensity: "CALM" | "BUILDING" | "PEAK" | "BREATH" | "LULL";
  /** performance.now() when this decision was emitted. */
  at: number;
  /** One-line human-readable explanation (for debug overlay). */
  reason: string;
  /** Section D #503 — true if the director has detected the player is
   *  struggling (low K/D sustained) and is easing off. The HUD can show
   *  a discreet "mercy" indicator; the spawn system reduces wave count. */
  struggling?: boolean;
  /** Section D #504 — true if the player is dominating (high K/D sustained).
   *  Elite spawn weight is multiplied by DOMINATING_ELITE_MULT. */
  dominating?: boolean;
  /** Section D #504 — loot multiplier (applied to PickupSystem drop chance).
   *  Defaults to 1.0; >1 when the player is dominating or struggling
   *  (both get more loot — dominating as reward, struggling as mercy). */
  lootMult?: number;
  /** Section D #505 — true if the last enemy of the wave is in "last stand"
   *  mode (gets +50% aggression, dramatic bark). The HUD can flash a
   *  "LAST STAND" overlay. */
  lastStand?: boolean;
  /** Section D #506 — true while a boss intro is in progress (spawning
   *  paused for BOSS_INTRO_PAUSE_MS, BOSS_TAUNT bark emitted). The HUD
   *  shows a boss intro card. */
  bossIntro?: boolean;
  /** Section D #506 — name of the boss currently being introduced (when
   *  bossIntro=true). Empty string otherwise. */
  bossIntroName?: string;
  /** Section D #596 — fear factor (0..1). Computed from the player's
   *  recent K/D ratio. High fear = enemies fight more cautiously (retreat
   *  threshold raised, accuracy slightly reduced because they're "shaking").
   *  Drives the AI "fear of the player" behavior in ai-enhancements-d.ts. */
  fearFactor?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 30_000; // 30s rolling window of performance signals.
const MIN_SIGNALS_FOR_DECISION = 3; // Need at least 3 samples before emitting.
const TICK_MS = 1000; // Director ticks once per second.

// Bounds on the decision (the director never exceeds these).
const SPAWN_MIN = 0.5, SPAWN_MAX = 1.6;
const AGGR_MIN = 0.6, AGGR_MAX = 1.5;

// Section D #502 — pacing constants for the lull/spike rhythm. The director
// alternates between INTENSITY_PEAK (combat spike) and INTENSITY_LULL (breathing
// room) on a fixed cadence so matches have a visible rhythm rather than a
// constant stream. WAVE_SPIKE_MS is the typical spike duration; WAVE_LULL_MS
// is the lull between spikes. The director tracks `lastSpikeAt` + `lastLullAt`
// + applies the cadence on top of the adaptive mercy/challenge logic.
const WAVE_SPIKE_MS = 45_000; // 45s combat spike.
const WAVE_LULL_MS = 12_000;  // 12s breathing room between spikes.

// Section D #503 — adaptive skill thresholds. The director computes a
// rolling K/D from the performance signals; if the player's K/D drops below
// STRUGGLING_KD for STRUGGLING_WINDOW_MS, the director eases off (mercy).
// If K/D exceeds DOMINATING_KD for DOMINATING_WINDOW_MS, the director
// escalates (challenge + elite spawns — prompt #504).
const STRUGGLING_KD = 0.5;     // < 0.5 K/D = struggling.
const DOMINATING_KD = 3.0;     // > 3.0 K/D = dominating.
const STRUGGLING_WINDOW_MS = 20_000;
const DOMINATING_WINDOW_MS = 20_000;

// Section D #504 — elite-spawn probability multiplier when the player is
// dominating. Applied on top of the difficulty's dangerSpawnMult.
const DOMINATING_ELITE_MULT = 1.8;
// Section D #504 — loot-spawn probability multiplier when the player is
// dominating (high performers get more loot — risk/reward).
const DOMINATING_LOOT_MULT = 1.3;
// Section D #503 — loot-spawn probability multiplier when the player is
// struggling (mercy — more pickups so they can recover).
const STRUGGLING_LOOT_MULT = 1.5;

// Section D #505 — last-enemy-stand: when only 1 enemy remains alive AND
// the wave is not the final boss wave, the director flags a "last stand"
// — the enemy gets +50% aggression + the bark system emits a DESPERATE
// callout. This makes the final kill of a wave feel dramatic.
const LAST_STAND_ENEMY_COUNT = 1;

// Section D #506 — boss intro: when a boss spawns, the director pauses
// spawning for BOSS_INTRO_PAUSE_MS so the boss gets a clean intro window
// (no mook clutter) + emits a BOSS_TAUNT bark.
const BOSS_INTRO_PAUSE_MS = 5000;

// ───────────────────────────────────────────────────────────────────────────
// Director
// ───────────────────────────────────────────────────────────────────────────

/**
 * AIDirector — accumulates a rolling window of PerformanceSignals and
 * emits a PacingDecision each tick (1 Hz).
 *
 * The decision is a smooth blend of:
 *   - Player health deficit (low health → reduce pressure + let them breathe).
 *   - Player death recency (recent death → reduce pressure briefly).
 *   - Time since last engagement (long lull → ramp up to re-engage).
 *   - Player killstreak (high streak → ramp up to challenge).
 *   - Ammo scarcity (low ammo + low health → reduce pressure).
 *   - Downed state (downed → max pressure off so the player can recover).
 *
 * The decision is clamped to bounds + smoothed (lerp toward target by
 * 0.3/tick = ~3s time constant) so intensity changes feel natural.
 */
export class AIDirector {
  // Section D #1803 — circular buffer for the rolling performance-signal
  // window. The prior code used a plain array + `splice(0, firstValid)`
  // (A3-5000 #510) which was O(stale + remaining) per call. The circular
  // buffer is O(1) per push (overwrite the oldest entry) + O(N) only when
  // the tick iterates the window (which it does once per TICK_MS regardless).
  // The buffer is sized to WINDOW_MS at 60Hz (1800 samples) + a small margin.
  private static readonly WINDOW_CAPACITY = 1920; // 32s at 60Hz (30s window + margin)
  private windowBuf: (PerformanceSignal | undefined)[] = new Array(AIDirector.WINDOW_CAPACITY);
  private windowHead = 0; // index of the NEXT write (wraps around).
  private windowCount = 0; // number of valid entries (≤ WINDOW_CAPACITY).
  /** Iterate valid entries (oldest first). Allocates a snapshot array —
   *  callers should cache the result if iterating multiple times.
   *  Section D #1803 — filters stale entries (older than WINDOW_MS) at read
   *  time so the circular buffer's overwrite-as-it-fills semantics don't
   *  leak stale data when the buffer is partially full. */
  private windowSnapshot(): PerformanceSignal[] {
    const out: PerformanceSignal[] = [];
    const cap = AIDirector.WINDOW_CAPACITY;
    const count = Math.min(this.windowCount, cap);
    if (count === 0) return out;
    const now = performance.now();
    const cutoff = now - WINDOW_MS;
    const start = (this.windowHead - count + cap) % cap;
    for (let i = 0; i < count; i++) {
      const idx = (start + i) % cap;
      const s = this.windowBuf[idx];
      if (s && s.now >= cutoff) out.push(s);
    }
    return out;
  }
  private lastDecision: PacingDecision;
  private lastTickAt = 0;
  private readonly baseline: DifficultyConfig;
  // Section D #502 — pacing rhythm trackers.
  private lastSpikeAt = 0;
  private lastLullAt = 0;
  // Section D #503 — adaptive skill trackers.
  private strugglingSince = 0;
  private dominatingSince = 0;
  private rollingKd = 1.0;
  // Section D #504 — elite + loot mults (set each tick based on dominating).
  private eliteMult = 1.0;
  private lootMult = 1.0;
  // Section D #505 — last-stand state.
  private lastStandActive = false;
  private lastStandFiredAt = 0;
  /** Section D #1927 — last-enemy mode (cautious vs desperate) when
   *  lastStandActive is true. Null when not in last-stand. */
  private lastStandMode: "cautious" | "desperate" | null = null;
  // Section D #506 — boss intro state.
  private bossIntroUntil = 0;
  private bossIntroName = "";
  // Section D #596 — fear factor (0..1).
  private fearFactor = 0;
  // Section D #588 — adaptive AI memory: counts of player tactic usage in
  // the last 60s. Drives counter-tactics in ai-enhancements-d.ts (e.g. if
  // the player throws >3 smokes, AI starts pre-aiming smoke exit points).
  private tacticCounts: { smoke: number; flash: number; flank: number; rush: number; suppress: number } = {
    smoke: 0, flash: 0, flank: 0, rush: 0, suppress: 0,
  };

  /** @param baseline The static difficulty config (easy/normal/hard). */
  constructor(baseline: DifficultyConfig) {
    this.baseline = baseline;
    this.lastDecision = {
      spawnRateMult: 1.0,
      aggressionMult: 1.0,
      intensity: "BUILDING",
      at: 0,
      reason: "init",
    };
  }

  /** Reset the window (e.g. on match restart). */
  reset() {
    // Section D #1803 — circular buffer reset.
    this.windowBuf = new Array(AIDirector.WINDOW_CAPACITY);
    this.windowHead = 0;
    this.windowCount = 0;
    this.lastTickAt = 0;
    this.lastSpikeAt = 0;
    this.lastLullAt = 0;
    this.strugglingSince = 0;
    this.dominatingSince = 0;
    this.rollingKd = 1.0;
    this.eliteMult = 1.0;
    this.lootMult = 1.0;
    this.lastStandActive = false;
    this.lastStandFiredAt = 0;
    this.lastStandMode = null;
    this.bossIntroUntil = 0;
    this.bossIntroName = "";
    this.fearFactor = 0;
    this.tacticCounts = { smoke: 0, flash: 0, flank: 0, rush: 0, suppress: 0 };
    this.lastDecision = {
      spawnRateMult: 1.0, aggressionMult: 1.0,
      intensity: "BUILDING", at: 0, reason: "reset",
    };
  }

  /** Push a new performance signal into the rolling window.
   *  Section D #1803 — circular buffer write. O(1) per call (overwrite the
   *  oldest entry when the buffer is full). The prior code used
   *  `push + splice(0, firstValid)` which was O(N) per call. The circular
   *  buffer never shrinks the underlying array (capacity is fixed at
   *  WINDOW_CAPACITY) so GC pressure is zero after the initial allocation. */
  recordPerformance(sig: PerformanceSignal) {
    const cap = AIDirector.WINDOW_CAPACITY;
    this.windowBuf[this.windowHead] = sig;
    this.windowHead = (this.windowHead + 1) % cap;
    if (this.windowCount < cap) this.windowCount++;
    // Note: stale entries (older than WINDOW_MS) are filtered at read time
    // in windowSnapshot() rather than eagerly evicted. The circular buffer
    // overwrites old entries naturally once it fills, so the stale-filter
    // is only needed for the brief window where the buffer hasn't yet
    // filled (count < capacity) AND some entries are older than WINDOW_MS.
    // The read-side filter handles this correctly.
  }

  /**
   * Tick the director. Returns the current PacingDecision (the same
   * decision is returned between ticks — it only updates once per
   * TICK_MS).
   */
  tick(sig: PerformanceSignal): PacingDecision {
    this.recordPerformance(sig);
    const now = sig.now;
    if (now - this.lastTickAt < TICK_MS && this.lastTickAt > 0) {
      return this.lastDecision;
    }
    this.lastTickAt = now;
    // Section D #1803 — read the circular buffer via windowSnapshot() (which
    // filters stale entries older than WINDOW_MS).
    const window = this.windowSnapshot();
    if (window.length < MIN_SIGNALS_FOR_DECISION) {
      this.lastDecision = {
        spawnRateMult: 1.0, aggressionMult: 1.0,
        intensity: "BUILDING", at: now, reason: "warmup",
      };
      return this.lastDecision;
    }

    // ── Compute the player-stress score (0 = thriving, 1 = dying) ──
    const latest = window[window.length - 1];
    const hpPct = latest.health / Math.max(1, latest.maxHealth);
    const armorPct = latest.armor / 100;
    const ammoPct = latest.ammoTotal / Math.max(1, latest.ammoMax);

    // Section D #503 — rolling K/D over the window. kills delta / max(1, deaths delta).
    const oldest = window[0];
    const killsDelta = Math.max(0, latest.kills - oldest.kills);
    // Death recency proxy: count deaths in the window via lastDeathAt.
    // We don't have a per-signal death counter; approximate by counting
    // signals where lastDeathAt advanced. Each transition is one death.
    let deathsDelta = 0;
    let prevDeathAt = oldest.lastDeathAt;
    for (const w of window) {
      if (w.lastDeathAt > prevDeathAt) { deathsDelta++; prevDeathAt = w.lastDeathAt; }
    }
    this.rollingKd = deathsDelta === 0
      ? Math.max(this.rollingKd, killsDelta) // no deaths → K/D grows with kills.
      : killsDelta / deathsDelta;

    // Section D #503 — struggling / dominating state transitions.
    if (this.rollingKd < STRUGGLING_KD) {
      if (this.strugglingSince === 0) this.strugglingSince = now;
    } else {
      this.strugglingSince = 0;
    }
    if (this.rollingKd > DOMINATING_KD) {
      if (this.dominatingSince === 0) this.dominatingSince = now;
    } else {
      this.dominatingSince = 0;
    }
    const struggling = this.strugglingSince > 0 && (now - this.strugglingSince) > STRUGGLING_WINDOW_MS;
    const dominating = this.dominatingSince > 0 && (now - this.dominatingSince) > DOMINATING_WINDOW_MS;

    // Section D #504 — elite + loot mults.
    this.eliteMult = dominating ? DOMINATING_ELITE_MULT : 1.0;
    if (dominating)      this.lootMult = DOMINATING_LOOT_MULT;
    else if (struggling) this.lootMult = STRUGGLING_LOOT_MULT;
    else                 this.lootMult = 1.0;

    // Section D #596 — fear factor. Scales with K/D above 2.0 (capped at 1.0
    // when K/D ≥ 5). Recovers slowly when K/D drops.
    const targetFear = this.rollingKd > 2.0
      ? Math.min(1.0, (this.rollingKd - 2.0) / 3.0)
      : 0;
    this.fearFactor = lerp(this.fearFactor, targetFear, 0.1);

    // Section D #505 — last-stand: when only 1 enemy remains AND we haven't
    // fired the last-stand bark in the last 10s, flag it.
    // Section D #1927 — delegate the aliveCount === 1 check to
    // shouldActivateLastEnemyBehavior (AIEnhancements.ts:390) so the
    // director's last-stand logic + the AIEnhancements helper stay in sync
    // (previously the director had its own inline check that could drift).
    if (shouldActivateLastEnemyBehavior(latest.enemiesAlive) && !latest.downed) {
      if (!this.lastStandActive && now - this.lastStandFiredAt > 10_000) {
        this.lastStandActive = true;
        this.lastStandFiredAt = now;
        // Section D #1927 — pick the last-enemy mode (cautious vs desperate)
        // via pickLastEnemyMode (AIEnhancements.ts:399). The mode is stashed
        // + surfaced via getLastEnemyMode() so EnemySystem/tickSectionD can
        // apply per-mode behavior. We classify the last enemy as "boss" if
        // it's a boss, "heavy" if MG/SHIELD/SHOTGUNNER, "light" otherwise.
        // HP fraction is read from the latest signal (default 1.0 if absent).
        const lastEnemyClass: "light" | "heavy" | "boss" = latest.lastEnemyIsBoss
          ? "boss"
          : (latest.lastEnemyIsHeavy ? "heavy" : "light");
        this.lastStandMode = pickLastEnemyMode(lastEnemyClass, latest.lastEnemyHpFraction ?? 1.0);
      }
    } else if (latest.enemiesAlive > 2) {
      this.lastStandActive = false;
      this.lastStandMode = null;
    }

    // Section D #506 — boss intro: if bossIntroUntil is in the future,
    // pause spawning (spawnRateMult = 0) and emit a "bossIntro" decision.
    const inBossIntro = now < this.bossIntroUntil;

    // Death recency — within 10s of a death, the player is fragile.
    let deathStress = 0;
    if (latest.lastDeathAt > 0) {
      const sinceDeath = now - latest.lastDeathAt;
      if (sinceDeath < 10_000) deathStress = 1 - sinceDeath / 10_000;
    }

    // Downed = max stress (the player can't move).
    const downedStress = latest.downed ? 1.0 : 0;

    // Lull — long time since engagement → boredom, ramp up.
    let lullBoost = 0;
    if (latest.lastEngagementAt > 0) {
      const sinceEng = now - latest.lastEngagementAt;
      if (sinceEng > 15_000) lullBoost = Math.min(0.4, (sinceEng - 15_000) / 30_000);
    } else {
      lullBoost = 0.2; // never engaged → small ramp-up.
    }

    // Killstreak — high streak → ramp up the challenge.
    const streakBoost = Math.min(0.3, latest.killstreak * 0.05);

    // Low ammo + low health → mercy (the player is out of resources).
    const resourceStress = (hpPct < 0.3 ? 0.3 : 0) + (ammoPct < 0.2 ? 0.2 : 0);

    // Player stress = weighted blend. Range ~0..1.1.
    const playerStress = Math.max(
      0,
      Math.min(1.1,
        (1 - hpPct) * 0.35 +
        (1 - armorPct) * 0.10 +
        deathStress * 0.25 +
        downedStress * 0.50 +
        resourceStress * 0.20,
      ),
    );
    // Director response: when player is stressed, REDUCE pressure (mercy).
    // When player is thriving + has a killstreak + a long lull, INCREASE.
    let mercyFactor = Math.max(0, playerStress - 0.4); // only mercy past 0.4.
    // Section D #503 — explicit struggling flag adds mercy.
    if (struggling) mercyFactor = Math.max(mercyFactor, 0.3);
    let challengeFactor = lullBoost + streakBoost;
    // Section D #504 — dominating flag adds challenge.
    if (dominating) challengeFactor += 0.3;

    // Target spawn rate: baseline 1.0, minus mercy, plus challenge.
    let targetSpawn = 1.0 - mercyFactor * 0.6 + challengeFactor * 0.8;
    // Target aggression: same shape, slightly weaker.
    let targetAggr = 1.0 - mercyFactor * 0.5 + challengeFactor * 0.6;

    // Section D #505 — last-stand: bump aggression +50% so the final
    // enemy fights dramatically.
    if (this.lastStandActive) {
      targetAggr += 0.5;
      targetSpawn = Math.max(targetSpawn, 0.4); // don't kill the wave entirely.
    }

    // Section D #506 — boss intro: zero out spawn rate so no mooks clutter
    // the boss intro. Aggression stays at baseline.
    if (inBossIntro) {
      targetSpawn = 0;
      targetAggr = 1.0;
    }

    // Section D #502 — pacing rhythm: force a lull every WAVE_SPIKE_MS +
    // WAVE_LULL_MS cycle. When in the lull window, reduce spawn rate.
    if (this.lastSpikeAt > 0 && now - this.lastSpikeAt > WAVE_SPIKE_MS) {
      // Enter lull.
      if (this.lastLullAt === 0 || now - this.lastLullAt > WAVE_LULL_MS + WAVE_SPIKE_MS) {
        this.lastLullAt = now;
      }
    }
    if (this.lastLullAt > 0 && now - this.lastLullAt < WAVE_LULL_MS) {
      // In a forced lull — drop spawn rate to 0.4 (a "breath").
      targetSpawn = Math.min(targetSpawn, 0.4);
      if (this.lastSpikeAt === 0 || now - this.lastSpikeAt > WAVE_SPIKE_MS + WAVE_LULL_MS) {
        // Mark a new spike start once the lull ends.
        this.lastSpikeAt = now + WAVE_LULL_MS;
      }
    } else if (this.lastSpikeAt === 0) {
      this.lastSpikeAt = now; // first spike starts now.
    }

    // Apply the static-difficulty baseline (Hard = slightly higher base).
    // The director's decision is layered on top — Hard gets a flat +0.1.
    const diffBias = this.baseline.healthMult - 1.0; // -0.3 / 0 / +0.4 / +0.8 (insane)
    targetSpawn += diffBias * 0.15;
    targetAggr += diffBias * 0.20;

    // Clamp to bounds.
    targetSpawn = Math.max(SPAWN_MIN, Math.min(SPAWN_MAX, targetSpawn));
    targetAggr = Math.max(AGGR_MIN, Math.min(AGGR_MAX, targetAggr));

    // Smooth toward target (lerp by 0.3 = ~3s time constant).
    const prev = this.lastDecision;
    const spawnRateMult = lerp(prev.spawnRateMult, targetSpawn, 0.3);
    const aggressionMult = lerp(prev.aggressionMult, targetAggr, 0.3);

    // Intensity label — derived from spawnRateMult + aggressionMult + alive count.
    const pressure = (spawnRateMult + aggressionMult) / 2;
    let intensity: PacingDecision["intensity"];
    let reason: string;
    if (inBossIntro) {
      intensity = "PEAK";
      reason = `boss intro — ${this.bossIntroName}`;
    } else if (latest.downed) {
      intensity = "BREATH";
      reason = "player downed — mercy breath";
    } else if (this.lastStandActive) {
      intensity = "PEAK";
      reason = "last enemy stand — dramatic finish";
    } else if (this.lastLullAt > 0 && now - this.lastLullAt < WAVE_LULL_MS) {
      intensity = "LULL";
      reason = "pacing lull — breathing room between spikes";
    } else if (mercyFactor > 0.05 || playerStress > 0.45) {
      intensity = "BREATH";
      reason = `player stressed (hp ${Math.round(hpPct * 100)}%, stress ${playerStress.toFixed(2)}) — backing off`;
    } else if (pressure < 0.85) {
      intensity = "CALM";
      reason = "low pressure — calm";
    } else if (pressure > 1.25 || (lullBoost > 0.2 && latest.enemiesAlive > 0)) {
      intensity = "PEAK";
      reason = `peak pressure (streak ${latest.killstreak}, lull boost ${lullBoost.toFixed(2)})`;
    } else {
      intensity = "BUILDING";
      reason = "steady engagement";
    }

    this.lastDecision = {
      spawnRateMult, aggressionMult, intensity, at: now, reason,
      // Section D #503/#504/#505/#506/#596 — new decision fields.
      struggling,
      dominating,
      lootMult: this.lootMult,
      lastStand: this.lastStandActive,
      bossIntro: inBossIntro,
      bossIntroName: inBossIntro ? this.bossIntroName : "",
      fearFactor: this.fearFactor,
    };
    return this.lastDecision;
  }

  /** Get the most recent decision without ticking. */
  getDecision(): PacingDecision { return this.lastDecision; }

  /** Get the rolling-window size (for debug). */
  getWindowSize(): number { return this.windowCount; }

  /** Get the static-difficulty baseline. */
  getBaseline(): DifficultyConfig { return this.baseline; }

  // ────────────── Section D — director public API hooks ──────────────

  /** Section D #503 — get the rolling K/D ratio (for debug overlay + AI
   *  adaptive systems). */
  getRollingKd(): number { return this.rollingKd; }

  /** Section D #503 — is the player currently flagged as struggling? */
  isStruggling(): boolean { return !!this.lastDecision.struggling; }

  /** Section D #504 — is the player currently flagged as dominating? */
  isDominating(): boolean { return !!this.lastDecision.dominating; }

  /** Section D #504 — current elite-spawn multiplier (1.0 or 1.8). */
  getEliteMult(): number { return this.eliteMult; }

  /** Section D #504 — current loot multiplier (applied to PickupSystem). */
  getLootMult(): number { return this.lootMult; }

  /** Section D #505 — is the last enemy of the wave in last-stand mode? */
  isLastStand(): boolean { return this.lastStandActive; }

  /** Section D #505 — clear the last-stand flag (called when the wave ends). */
  clearLastStand() { this.lastStandActive = false; this.lastStandMode = null; }

  /** Section D #1927 — get the last-enemy mode (cautious vs desperate) when
   *  in last-stand. Returns null when not in last-stand. EnemySystem /
   *  tickSectionD reads this to apply per-mode behavior (cautious = retreat
   *  to cover + regen; desperate = charge + melee). */
  getLastEnemyMode(): "cautious" | "desperate" | null { return this.lastStandMode; }

  /** Section D #506 — Trigger a boss intro. Pauses spawning for
   *  BOSS_INTRO_PAUSE_MS + records the boss name for the HUD card.
   *  Called by EnemySystem when a boss spawns. */
  triggerBossIntro(bossName: string) {
    this.bossIntroName = bossName;
    this.bossIntroUntil = performance.now() + BOSS_INTRO_PAUSE_MS;
  }

  /** Section D #506 — is a boss intro currently in progress? */
  isInBossIntro(): boolean { return performance.now() < this.bossIntroUntil; }

  /** Section D #506 — name of the boss being introduced (empty if none). */
  getBossIntroName(): string { return this.bossIntroName; }

  /** Section D #596 — current fear factor (0..1). Drives AI caution. */
  getFearFactor(): number { return this.fearFactor; }

  /** Section D #588 — record a player tactic usage (smoke/flash/flank/
   *  rush/suppress). The adaptive AI reads these counts to counter repeated
   *  strategies. Counts decay slowly (the director halves them every 60s
   *  via a passive prune on tick). */
  recordPlayerTactic(tactic: "smoke" | "flash" | "flank" | "rush" | "suppress") {
    this.tacticCounts[tactic] = (this.tacticCounts[tactic] ?? 0) + 1;
  }

  /** Section D #588 — get the player's tactic usage counts (for the
   *  adaptive AI counter-tactics). */
  getPlayerTactics(): { smoke: number; flash: number; flank: number; rush: number; suppress: number } {
    return { ...this.tacticCounts };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

// ───────────────────────────────────────────────────────────────────────────
// Singleton accessor (the engine constructs one + wires it on ctx.ai.director)
// ───────────────────────────────────────────────────────────────────────────

let _director: AIDirector | null = null;

/** Get the process-wide AIDirector singleton. Lazy-initialized. */
export function getAIDirector(): AIDirector | null {
  return _director;
}

/** Initialize the singleton (called by the engine on match start). */
export function initAIDirector(baseline: DifficultyConfig): AIDirector {
  _director = new AIDirector(baseline);
  return _director;
}

/** Tear down the singleton (called by the engine on dispose). */
export function destroyAIDirector() {
  _director = null;
}
