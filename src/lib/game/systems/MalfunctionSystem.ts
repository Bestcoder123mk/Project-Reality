import type { GameSystem, GameContext } from "./types";
// A2-5000 #216 — wire JamClearState so clearMalfunction has a progress bar
// (was instant; the spec calls for 0.8–2.0s timed clears).
// A2-5000 #251 — wetWeaponMalfunctionMult for wet-weapon misfire scaling.
import {
  type JamClearState,
  createJamClearState,
  startJamClear,
  updateJamClear,
  wetWeaponMalfunctionMult,
} from "./GunplayEnhancements";

/**
 * P4.5: Weapon malfunctions & jamming.
 *
 * Each weapon has a condition (0..1) that decays with use (firing,
 * reloads, environmental exposure). Lower condition increases the
 * chance of malfunctions per shot:
 *
 *   - "stovepipe" (5%): fired casing sticks in the ejection port.
 *     Player must press the reload key (R) to clear it.
 *   - "failure to feed" (3%): slide locks back, mag not seated.
 *     Player must press R to rack the slide.
 *   - "hard primer" (2%): dead trigger, round didn't fire.
 *     Player must press R to re-rack.
 *
 * All three manifest as: weapon refuses to fire, R key clears it
 * (consumes a round + 0.8s). Tracked via ctx.weapon.malfunction.
 *
 * Condition decay:
 *   - Per shot: -0.0005 (a 30-round mag drops condition by ~1.5%)
 *   - Per reload: -0.005
 *   - In rain: -0.0002/sec (dirt ingress)
 *   - In sand/dust (high wind + low precip): -0.0003/sec
 *
 * Condition can be restored via a "clean weapon" action (P5.x economy
 * will add a gunsmith service). For now, condition decays monotonically
 * within a match; the gunsmith restoration is a future feature.
 *
 * Malfunction chances are scaled by (1 - condition):
 *   stovepipe_chance    = 0.005 * (1 - condition) * 2
 *   failure_to_feed     = 0.003 * (1 - condition) * 2
 *   hard_primer         = 0.002 * (1 - condition) * 2
 * So a pristine weapon (condition=1) never malfunctions; a worn weapon
 * (condition=0.5) has a 1% chance per shot; a badly worn weapon
 * (condition=0.2) has a 1.6% chance per shot.
 */

export type MalfunctionType =
  | "stovepipe"
  | "failure_to_feed"
  | "hard_primer"
  | "double_feed"
  | "misfire" // spec calls this "dud_round" — round fails to ignite
  | "squib_load"
  // A2-5000 #212 — additional malfunction types per spec.
  | "slamfire"      // open-bolt runaway: trigger stuck, weapon keeps firing
  | "bolt_over_base" // cartridge not fully chambered; bolt didn't lock
  | null;

/**
 * Section B — per-malfunction clear procedure. Each malfunction requires a
 * distinct sequence of R-key presses to clear (the spec calls for tap-R
 * twice for stovepipe, hold-R for double feed, etc.). The clearStep field
 * is the current step the player is on (0 = first input).
 */
export interface MalfunctionClearProcedure {
  /** Sequence of inputs required to clear (e.g. ["tap", "tap"] for stovepipe). */
  sequence: Array<"tap" | "hold">;
  /** Hold duration required for "hold" inputs (ms). Default 500. */
  holdMs?: number;
  /** Total clear time once the sequence is complete (ms). */
  clearMs: number;
  /** Animation label (drives the weapon-anim clear clip). */
  animLabel: string;
  /** HUD message shown when the malfunction triggers. */
  hudHint: string;
}

/**
 * Section B — per-malfunction clear procedures.
 *   - stovepipe: tap R twice (rack the slide). ~0.8s.
 *   - failure_to_feed: tap R + hold R (strip mag + rack). ~1.5s.
 *   - hard_primer: tap R (rechamber). ~0.6s.
 *   - double_feed: tap R + hold R + tap R (strip mag + rack + reinsert). ~2.0s.
 *   - misfire: tap R (rechamber). ~0.6s.
 *   - squib_load: hold R for 1.5s (manual barrel clear). ~1.8s.
 *   - A2-5000 #212 — slamfire: hold R to release stuck sear. ~1.2s.
 *   - A2-5000 #212 — bolt_over_base: tap R + tap R (re-rack twice). ~1.0s.
 */
export const MALFUNCTION_CLEAR_PROCEDURES: Record<Exclude<MalfunctionType, null>, MalfunctionClearProcedure> = {
  stovepipe:       { sequence: ["tap", "tap"],                              clearMs: 800,  animLabel: "clear_stovepipe", hudHint: "Stovepipe — tap R twice to rack" },
  failure_to_feed: { sequence: ["tap", "hold"],       holdMs: 500,         clearMs: 1500, animLabel: "clear_failure_to_feed", hudHint: "Failure to feed — tap R, hold R to strip + rack" },
  hard_primer:     { sequence: ["tap"],                                   clearMs: 600,  animLabel: "clear_misfire", hudHint: "Hard primer — tap R to rechamber" },
  double_feed:     { sequence: ["tap", "hold", "tap"], holdMs: 500,         clearMs: 2000, animLabel: "clear_double_feed", hudHint: "Double feed — tap R, hold R, tap R to clear" },
  misfire:         { sequence: ["tap"],                                   clearMs: 600,  animLabel: "clear_misfire", hudHint: "Misfire — tap R to rechamber" },
  squib_load:      { sequence: ["hold"],             holdMs: 1500,        clearMs: 1800, animLabel: "clear_squib", hudHint: "SQUIB LOAD — hold R to clear barrel (DO NOT FIRE)" },
  slamfire:        { sequence: ["hold"],             holdMs: 1200,        clearMs: 1200, animLabel: "clear_slamfire", hudHint: "SLAMFIRE — hold R to release stuck sear" },
  bolt_over_base:  { sequence: ["tap", "tap"],                            clearMs: 1000, animLabel: "clear_bolt_over_base", hudHint: "Bolt over base — tap R twice to re-rack" },
};

/**
 * Section B #293 — malfunction clear mini-game.
 *
 * A timed button press during the clear animation speeds up the clear by
 * ~30%. The mini-game fires a "perfect timing" window halfway through the
 * clear animation — if the player presses R within ±100ms of the window
 * center, the clear completes 30% faster.
 */
export interface ClearMiniGameState {
  /** When the clear started (performance.now()). */
  startedAt: number;
  /** Perfect-timing window center (ms after start). */
  perfectCenterMs: number;
  /** Window half-width (ms). Default 100. */
  windowHalfMs: number;
  /** True once the player hit the perfect-timing window. */
  perfectHit: boolean;
}

/**
 * Section B #293 — start a clear mini-game for the given malfunction.
 *
 * The mini-game is offered for malfunctions whose clearMs > 1000 (double
 * feed, squib load). Short clears (stovepipe, misfire) skip the mini-game
 * — there's no time to time a press in a 600ms clear.
 */
export function startClearMiniGame(malfunction: MalfunctionType, now: number = performance.now()): ClearMiniGameState | null {
  if (!malfunction) return null;
  const proc = MALFUNCTION_CLEAR_PROCEDURES[malfunction];
  if (!proc || proc.clearMs < 1000) return null;
  return {
    startedAt: now,
    perfectCenterMs: proc.clearMs * 0.5,
    windowHalfMs: 100,
    perfectHit: false,
  };
}

/**
 * Section B #293 — check a player input against the mini-game window.
 *
 * Returns true if the input hit the perfect-timing window (the clear will
 * be 30% faster). The state is mutated to mark perfectHit so subsequent
 * inputs don't double-count.
 */
export function checkClearMiniGame(state: ClearMiniGameState, now: number = performance.now()): boolean {
  if (state.perfectHit) return false;
  const elapsed = now - state.startedAt;
  const diff = Math.abs(elapsed - state.perfectCenterMs);
  if (diff <= state.windowHalfMs) {
    state.perfectHit = true;
    return true;
  }
  return false;
}

/** Mini-game bonus: 30% faster clear on perfect-timing hit. */
export const MINI_GAME_CLEAR_BONUS_MULT = 0.7;

export interface MalfunctionState {
  /** Current malfunction (null = weapon functional). */
  current: MalfunctionType;
  /** Weapon condition (0..1). Decays with use. */
  condition: number;
  /** Timestamp of last malfunction clear (for HUD flash). */
  lastClearedAt: number;
  /** Section B #182 — squib-load flag. When true, the barrel is obstructed
   *  and the next shot is catastrophic (weapon destroyed). Cleared by
   *  holding R for 1.5s (manual barrel clear). */
  barrelObstructed?: boolean;
  /** Section B #293 — current clear mini-game state (null when no clear
   *  in progress). */
  miniGame?: ClearMiniGameState | null;
  /** A2-5000 #216 — interactive jam-clear progress state. When non-null
   *  and `clearing=true`, MalfunctionSystem.update() advances the clear
   *  and finalizes it when complete (consumes ammo per type). */
  jamClear?: JamClearState | null;
}

/**
 * Roll for a malfunction on a single shot.
 * Returns the malfunction type (or null if no malfunction).
 * Scales chance by (1 - condition).
 *
 * Section B #183–186: extended with double_feed, misfire, and squib_load.
 * The squib_load chance is intentionally very low (rare + dramatic per spec).
 */
export function rollMalfunction(condition: number): MalfunctionType {
  const wear = (1 - condition) * 2;
  const stovepipe = 0.005 * wear;
  const failureToFeed = 0.003 * wear;
  const hardPrimer = 0.002 * wear;
  const doubleFeed = 0.0015 * wear; // rarer than stovepipe/FTF
  const misfire = 0.001 * wear;
  const squibLoad = 0.0002 * wear; // VERY rare — dramatic event
  // A2-5000 #212 — additional rare types. slamfire only affects open-bolt
  // weapons (LMGs) but is rolled for all; the engine can filter by class.
  const slamfire = 0.0003 * wear;
  const boltOverBase = 0.0008 * wear;
  const r = Math.random();
  if (r < stovepipe) return "stovepipe";
  if (r < stovepipe + failureToFeed) return "failure_to_feed";
  if (r < stovepipe + failureToFeed + hardPrimer) return "hard_primer";
  if (r < stovepipe + failureToFeed + hardPrimer + doubleFeed) return "double_feed";
  if (r < stovepipe + failureToFeed + hardPrimer + doubleFeed + misfire) return "misfire";
  if (r < stovepipe + failureToFeed + hardPrimer + doubleFeed + misfire + squibLoad) return "squib_load";
  if (r < stovepipe + failureToFeed + hardPrimer + doubleFeed + misfire + squibLoad + slamfire) return "slamfire";
  if (r < stovepipe + failureToFeed + hardPrimer + doubleFeed + misfire + squibLoad + slamfire + boltOverBase) return "bolt_over_base";
  return null;
}

/**
 * Section B #187 — barrel heat multiplier on malfunction rate.
 *
 * Hot barrels jam more often. The heat multiplier scales the malfunction
 * probability by up to 2× at full heat (1.0). Below the heat threshold,
 * no multiplier (the barrel is cool enough to operate normally).
 *
 * A2-5000 #214 — the threshold is now difficulty-scaled (easy=0.6, hard=0.4).
 * Default 0.5 preserves legacy behavior for callers that don't pass a config.
 */
export function getHeatMalfunctionMult(barrelHeat: number, heatThreshold: number = 0.5): number {
  if (barrelHeat <= heatThreshold) return 1.0;
  // Linear from 1.0 at heat=threshold to 2.0 at heat=1.0.
  return 1.0 + ((barrelHeat - heatThreshold) / Math.max(0.01, 1 - heatThreshold));
}

/**
 * A2-5000 #214 — difficulty-scaled heat threshold.
 */
export const DIFFICULTY_HEAT_THRESHOLD: Record<string, number> = {
  easy: 0.60,
  normal: 0.50,
  hard: 0.40,
  insane: 0.35,
};
export function getDifficultyHeatThreshold(diff: string): number {
  return DIFFICULTY_HEAT_THRESHOLD[diff] ?? 0.5;
}

/**
 * Section B #182 — reset malfunction state for a new match.
 *
 * Per the spec, `barrelHeat` is per-match. The MalfunctionSystem should call
 * this on MatchFSM match-start to reset the weapon's heat + condition (fresh
 * weapon at the start of each match). The condition reset is optional —
 * persistence across matches is a separate feature (see prompt #294).
 */
export function resetMalfunctionForMatch(state: MalfunctionState, resetCondition: boolean = true): void {
  state.current = null;
  state.lastClearedAt = 0;
  state.barrelObstructed = false;
  state.miniGame = null;
  if (resetCondition) state.condition = 1.0;
}

/**
 * P4.5: Weapon malfunction system.
 *
 * WeaponSystem.tryShoot consults ctx.weaponMalfunction.current before
 * firing. If a malfunction is active, the shot is refused and the player
 * hears a "click" + sees a HUD prompt. Pressing R clears the malfunction
 * (consumes 0.8s, consumes a round for stovepipe/failure_to_feed).
 *
 * The system also tracks condition decay per shot and per environmental
 * exposure (rain, dust).
 */
export class MalfunctionSystem implements GameSystem {
  constructor(private ctx: GameContext & { weaponMalfunction?: MalfunctionState }) {}

  update(dt: number) {
    const m = this.ctx.weaponMalfunction;
    if (!m) return;
    // Environmental condition decay.
    // A2-5000 #213 — the old `0.0002 * dt` constant was negligible over a
    // 5-minute rainstorm (0.06 total). Raised to 0.001/sec (0.06/min) so a
    // 5-min storm drops condition by ~0.30 (significant). Wind/dust similarly.
    if (this.ctx.weather.precipitation > 0.3) {
      m.condition = Math.max(0, m.condition - 0.001 * dt);
    }
    if (this.ctx.weather.windSpeed > 8 && this.ctx.weather.precipitation < 0.1) {
      m.condition = Math.max(0, m.condition - 0.0015 * dt);
    }
    // A2-5000 #216 — advance the interactive jam-clear progress. When
    // complete, finalize the clear (consume ammo per type, reset state).
    if (m.jamClear?.clearing) {
      const progress = updateJamClear(m.jamClear, performance.now());
      this.ctx.pushHud({ reloadProgress: progress, reloading: true });
      if (progress >= 1) {
        this.finalizeClear();
      }
    }
  }

  /** Called by WeaponSystem after each successful shot. Rolls for malfunction. */
  onShotFired() {
    const m = this.ctx.weaponMalfunction;
    if (!m) {
      // A2-5000 #218 — weaponMalfunction state is optional; if uninitialized,
      // the weapon never malfunctions silently. Warn once so the missing
      // wiring is visible in the console (rather than a silent no-op).
      if (!(this as unknown as { _warned?: boolean })._warned) {
        (this as unknown as { _warned?: boolean })._warned = true;
        console.warn("[MalfunctionSystem] ctx.weaponMalfunction is undefined — weapon will never malfunction. Initialize via resetMalfunctionForMatch().");
      }
      return;
    }
    // Base per-shot condition decay.
    let decay = 0.0005;
    // Prompt #44 — sustained auto-fire heats the barrel, which accelerates
    // wear. Above the 0.5 heat threshold, each shot decays condition up to
    // 2× faster (at full heat). This makes LMG mag dumps noticeably degrade
    // the weapon — the player has to let the barrel cool or risk a jam.
    const heat = this.ctx.weapon?.barrelHeat ?? 0;
    if (heat > 0.5) {
      const heatWearMult = 1 + (heat - 0.5) * 2; // 1.0 at 0.5, 2.0 at 1.0
      decay *= heatWearMult;
    }
    m.condition = Math.max(0, m.condition - decay);
    if (m.current) return; // already malfunctioning
    // Section B #186 — squib load: barrel obstructed. The next shot is
    // catastrophic (weapon destroyed). The player must clear the barrel
    // before firing again.
    if (m.barrelObstructed) {
      // Catastrophic weapon damage — drop condition to 0 + flag the weapon
      // as destroyed (engine reads barrelObstructed + can disable the weapon).
      m.condition = 0;
      m.current = "squib_load";
      m.barrelObstructed = false;
      this.ctx.audio.emptyClick();
      this.ctx.pushHud({ objective: `CATASTROPHIC SQUIB — weapon damaged!` });
      return;
    }
    // Prompt #44 — barrel heat also raises the *immediate* malfunction
    // chance (independent of long-term condition). A hot barrel is more
    // likely to cook off a round or stick a casing. We model this by
    // passing an "effective condition" to rollMalfunction that's reduced
    // by up to 40% at full heat. At heat=1.0 + condition=0.8 (good gun),
    // effective condition = 0.8 * 0.6 = 0.48 → wear = (1-0.48)*2 = 1.04 →
    // stovepipe chance ≈ 0.005 * 1.04 ≈ 0.52% per shot. A2-5000 #215:
    // the doc previously claimed "~1%" which was off by ~2× — corrected.
    //
    // Section B #187 — apply the heat malfunction multiplier on top. The
    // multiplier scales the per-shot jam probability directly (rather than
    // reducing condition further, which would compound with the decay above).
    // A2-5000 #214 — heat threshold is difficulty-scaled.
    const diff = (this.ctx as unknown as { difficulty?: string }).difficulty ?? "normal";
    const heatThreshold = getDifficultyHeatThreshold(diff);
    const heatMult = getHeatMalfunctionMult(heat, heatThreshold);
    // A2-5000 #251 — wetWeaponMalfunctionMult (was exported but never called).
    // Wet weapons (rain/swim) misfire up to 4× more. The engine sets
    // ctx.weather.wetness (0..1); here we apply the mult on top of heatMult.
    const wetness = (this.ctx.weather as unknown as { wetness?: number }).wetness ?? 0;
    const wetMult = wetness > 0 ? wetWeaponMalfunctionMult(wetness, 1) : 1;
    const effectiveCondition = m.condition * (1 - heat * 0.4);
    // Section B #187 — roll malfunction with the heat multiplier. We do this
    // by inflating the wear factor passed to rollMalfunction.
    const adjustedCondition = Math.max(0, 1 - (1 - effectiveCondition) * heatMult * wetMult);
    const malfunction = rollMalfunction(adjustedCondition);
    if (malfunction) {
      m.current = malfunction;
      // Section B #186 — squib load sets the barrelObstructed flag so the
      // NEXT shot (after the clear) is catastrophic if the player fires
      // without clearing. For squib_load we set the obstructed flag AFTER
      // the current malfunction is cleared (so the player has to clear the
      // squib, then if they fire again without manually clearing the barrel,
      // it's catastrophic).
      if (malfunction === "squib_load") {
        // Squib itself doesn't set the obstructed flag yet — the obstructed
        // flag is set when the player attempts to clear it but doesn't fully
        // clear the barrel. For now, mark the barrel as obstructed on the
        // squib itself so the player must clear it before firing.
        m.barrelObstructed = true;
      }
      // Section B #189 — distinct audible click + HUD hint for the jam.
      this.ctx.audio.emptyClick();
      const proc = MALFUNCTION_CLEAR_PROCEDURES[malfunction];
      const hint = proc?.hudHint ?? `Malfunction: ${malfunction.replace(/_/g, " ")} — press R to clear`;
      this.ctx.pushHud({ objective: hint });
      // Section B #188 — start the clear animation (engine reads m.current
      // + MALFUNCTION_CLEAR_PROCEDURES[m.current].animLabel to play the
      // matching clear clip).
      // Section B #293 — start the mini-game for long clears.
      m.miniGame = startClearMiniGame(malfunction);
    }
  }

  /** Called by WeaponSystem on reload. Decays condition + clears malfunction. */
  onReloadStart() {
    const m = this.ctx.weaponMalfunction;
    if (!m) return;
    m.condition = Math.max(0, m.condition - 0.005);
  }

  /**
   * Called when the player presses R while a malfunction is active.
   * A2-5000 #216 — starts the interactive jam-clear (was instant). The
   * clear completes over `proc.clearMs` via the update() loop. Returns
   * true to skip the normal reload while clearing.
   */
  clearMalfunction(): boolean {
    const m = this.ctx.weaponMalfunction;
    if (!m || !m.current) return false;
    // If a clear is already in progress, ignore subsequent R presses.
    if (m.jamClear?.clearing) return true;
    const proc = MALFUNCTION_CLEAR_PROCEDURES[m.current];
    let clearMs = proc?.clearMs ?? 800;
    // Section B #293 — apply the mini-game bonus if the player hit the
    // perfect-timing window.
    if (m.miniGame?.perfectHit) {
      clearMs = Math.round(clearMs * MINI_GAME_CLEAR_BONUS_MULT);
    }
    // A2-5000 #216 — start the timed clear.
    if (!m.jamClear) m.jamClear = createJamClearState();
    m.jamClear.durationMs = clearMs;
    startJamClear(m.jamClear, performance.now());
    return true;
  }

  /**
   * A2-5000 #216 — finalizes the jam-clear once updateJamClear reports
   * completion. Consumes ammo per malfunction type (#217: hard_primer /
   * misfire don't consume — the round is still in chamber, racking just
   * seats it; stovepipe/FTF/double_feed eject the bad round).
   */
  private finalizeClear(): void {
    const m = this.ctx.weaponMalfunction;
    if (!m || !m.current) return;
    const cleared = m.current;
    m.current = null;
    m.lastClearedAt = performance.now();
    m.miniGame = null;
    if (m.jamClear) m.jamClear.clearing = false;
    // Section B #186 — squib clears the barrel obstruction.
    m.barrelObstructed = false;
    // A2-5000 #217 — per-type ammo consumption. Ejection-type malfunctions
    // consume a round (the bad round is ejected). Chamber-locked malfunctions
    // don't consume — the round is still in the chamber; racking just re-seats.
    const EJECT_TYPES = new Set(["stovepipe", "failure_to_feed", "double_feed", "bolt_over_base"]);
    if (EJECT_TYPES.has(cleared) && this.ctx.weapon.ammo > 0) {
      this.ctx.weapon.ammo--;
    }
    this.ctx.pushHud({
      objective: `Wave ${this.ctx.match.wave}: Eliminate ${this.ctx.match.enemiesPerWave} hostiles`,
      ammo: this.ctx.weapon.ammo,
      reloading: false,
      reloadProgress: 0,
    });
  }

  /** A2-5000 #216 — current jam-clear progress (0..1) for HUD rendering. */
  getJamClearProgress(): number {
    const m = this.ctx.weaponMalfunction;
    if (!m?.jamClear?.clearing) return 0;
    return updateJamClear(m.jamClear, performance.now());
  }

  /** Returns true if the weapon is currently malfunctioning (cannot fire). */
  isJammed(): boolean {
    const m = this.ctx.weaponMalfunction;
    return !!m?.current;
  }

  /** Current condition (0..1). */
  getCondition(): number {
    return this.ctx.weaponMalfunction?.condition ?? 1;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // B1-5000 — Prompts 681 (match-start reset hook), 690 (per-weapon reliability),
  // 696 (cook-off), 698 (reload-induced malfunction), 699 (clear-failure RNG).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Prompt 681 — match-start reset hook. The existing `resetMalfunctionForMatch`
   * pure helper resets the state; the engine calls this method on MatchFSM
   * match-start to ensure the weapon's heat + condition are fresh per match.
   *
   * A2-5000 already fixed the barrelHeat reset in WeaponSystem; this is the
   * canonical hook for the malfunction side (condition + current jam +
   * mini-game + jamClear).
   */
  onMatchStart(): void {
    const m = this.ctx.weaponMalfunction;
    if (!m) return;
    resetMalfunctionForMatch(m, true);
    // Prompt 681 — also reset the barrel heat via the weapon state. The engine
    // reads ctx.weapon.barrelHeat; the prior A3-5000 fix did this in WeaponSystem
    // on swap-away; this is the match-start equivalent.
    if (this.ctx.weapon) this.ctx.weapon.barrelHeat = 0;
  }

  /**
   * Prompt 690 — per-weapon reliability multiplier. Each weapon has a
   * `reliability` stat (0..1, where 1 = never fails). The AK-74 (looser
   * tolerances) sits at 0.85; the HK416 (high-quality piston system) at 0.97.
   * The multiplier scales the malfunction chance per shot — a less reliable
   * weapon fails more often at the same condition.
   *
   * The engine applies this multiplier on top of the existing condition-based
   * roll. Default 1.0 preserves the legacy behavior for weapons without an
   * explicit reliability stat.
   */
  static readonly WEAPON_RELIABILITY: Record<string, number> = {
    // RIFLES — AK family is least reliable, HK416 most reliable.
    ak74: 0.85, galil: 0.87, scarh: 0.92, mk17: 0.92, mk14: 0.90,
    m4: 0.93, hk416: 0.97, famas: 0.90, aug: 0.94,
    // SMGs — blowback systems are generally reliable.
    mp7: 0.95, p90: 0.93, mp5: 0.96, ump45: 0.94, vector: 0.91, pp90m1: 0.88,
    // PISTOLS — simple blowback, very reliable.
    usp: 0.98, deagle: 0.92, glock18: 0.97, m1911: 0.95, revolver: 0.99,
    // SNIPERS — bolt-action is mechanically simple, very reliable.
    awp: 0.97, scout: 0.96, kar98k: 0.93, l115a3: 0.97,
    // SHOTGUNS — pump/semi, generally reliable.
    nova: 0.95, m1014: 0.92, spas12: 0.90,
    // LMGs — sustained fire is hard on the system; belt-feeds less reliable.
    m249: 0.88, rpk: 0.86, mk48: 0.85,
  };

  /** Prompt 690 — get the per-weapon reliability multiplier (1 - malfunction
   *  chance scale). Returns 1.0 for unknown weapons (no extra failure rate). */
  static getReliabilityMult(weaponSlug: string): number {
    return MalfunctionSystem.WEAPON_RELIABILITY[weaponSlug] ?? 1.0;
  }

  /**
   * Prompt 696 — cook-off. A hot barrel (heat ≥ 0.95) can fire a chambered
   * round without a trigger pull — the heat ignites the primer. The engine
   * calls this method per frame; if it returns true, the weapon cooks off a
   * round (the engine applies the shot).
   *
   * Returns true with probability scales by how far above the threshold the
   * heat is. At heat = 0.95 it's ~0.1% per frame; at heat = 1.0 it's ~2%
   * per frame (a mag-dump-cooked LMG will cook off within ~1s of stopping).
   */
  tryCookOff(barrelHeat: number, hasRoundChambered: boolean): boolean {
    if (!hasRoundChambered) return false;
    if (barrelHeat < 0.95) return false;
    // Probability per frame: 0.1% at heat=0.95, 2% at heat=1.0.
    const over = (barrelHeat - 0.95) / 0.05; // 0..1
    const prob = 0.001 + 0.019 * over;
    return Math.random() < prob;
  }

  /**
   * Prompt 698 — reload-induced malfunction. A damaged mag (low condition mag
   * or a mag picked up from the ground) can cause a double-feed on reload.
   * Returns the malfunction type to apply (or null if no reload-induced
   * malfunction).
   *
   * The engine calls this on reload completion. The chance scales with the
   * mag's condition (0..1, where 1 = pristine). At mag condition = 0.3 the
   * chance is ~5%; at 0.0 it's ~15%.
   */
  rollReloadMalfunction(magCondition: number): MalfunctionType {
    if (magCondition >= 0.5) return null;
    // Chance scales inversely with mag condition.
    const chance = (0.5 - magCondition) * 0.3; // 0 at 0.5, 0.15 at 0.0
    if (Math.random() >= chance) return null;
    // Damaged mags cause double-feed or failure_to_feed.
    return Math.random() < 0.5 ? "double_feed" : "failure_to_feed";
  }

  /**
   * Prompt 699 — clear-failure RNG. A malfunction clear can fail (the casing
   * is stuck + requires a second rack). Returns true if the clear fails —
   * the engine should restart the clear sequence (the player must press R
   * again). Chance scales with the malfunction type + weapon condition.
   *
   * Stovepipes + double feeds have a 5–10% clear-failure chance; squib loads
   * never fail (the manual barrel-clear is thorough). Worn weapons fail more.
   */
  rollClearFailure(malfunction: MalfunctionType, condition: number): boolean {
    if (!malfunction) return false;
    if (malfunction === "squib_load") return false; // always clears on first try
    // Base chance per malfunction type.
    const baseChance: Record<Exclude<MalfunctionType, null>, number> = {
      stovepipe: 0.05,
      failure_to_feed: 0.08,
      hard_primer: 0.03,
      double_feed: 0.10,
      misfire: 0.02,
      squib_load: 0,
      slamfire: 0.06,
      bolt_over_base: 0.08,
    };
    const base = baseChance[malfunction] ?? 0.05;
    // Worn weapons (low condition) fail more often. At condition=0, 2× the
    // base chance; at condition=1, 1× the base chance.
    const wearMult = 1 + (1 - Math.max(0, Math.min(1, condition))) * 1;
    return Math.random() < base * wearMult;
  }
}
