import { FiniteStateMachine, type FSMTable } from "./FiniteStateMachine";
import type { GameContext } from "../systems/types";

/**
 * MatchFSM — authoritative match lifecycle state machine.
 *
 *   BRIEFING → DEPLOYING → IN_PROGRESS → WAVE_TRANSITION → IN_PROGRESS (loop)
 *                                                   ↘ VICTORY | DEFEAT → POST_MATCH
 *
 * Events: startMatch, deployComplete, waveCleared, playerDead, allWavesCleared, restart
 *
 * Replaces ad-hoc boolean flags: this.paused (only `running` loop gate remains),
 * this.matchOver, this.waveTransitioning.
 */
export type MatchState =
  | "BRIEFING"
  | "DEPLOYING"
  | "IN_PROGRESS"
  | "WAVE_TRANSITION"
  | "VICTORY"
  | "DEFEAT"
  | "POST_MATCH";

export type MatchEvent =
  | "startMatch"
  | "deployComplete"
  | "waveCleared"
  | "playerDead"
  | "vipKilled"
  | "allWavesCleared"
  | "restart";

interface MatchFSMContext {
  ctx: GameContext;
  onVictory: () => void;
  onGameOver: () => void;
  onStartNextWave: () => void;
  onReset: () => void;
}

/**
 * MatchFSM — wraps a data-driven FSM with match-specific helpers.
 *
 * The transition table is a plain object lookup keyed by `state -> event`.
 * Each entry is `{ target, onEnter?, onExit? }`. No switch statements.
 *
 * Helper methods (waveCleared, startNextWave, restart) handle the few cases
 * where the transition target depends on runtime state (e.g. last-wave
 * victory vs. mid-match wave transition).
 */
export class MatchFSM {
  private fsm: FiniteStateMachine<MatchFSMContext>;
  private ctxRef: MatchFSMContext;

  constructor(
    ctx: GameContext,
    handlers: {
      onVictory: () => void;
      onGameOver: () => void;
      onStartNextWave: () => void;
      onReset: () => void;
    },
  ) {
    const cleanTable: FSMTable<MatchFSMContext> = {
      BRIEFING: {
        startMatch: {
          target: "DEPLOYING",
          onEnter: ({ ctx }) => {
            ctx.match.matchOver = false;
            ctx.match.waveTransitioning = false;
          },
        },
      },
      DEPLOYING: {
        deployComplete: {
          target: "IN_PROGRESS",
          onEnter: ({ onStartNextWave }) => { onStartNextWave(); },
        },
      },
      IN_PROGRESS: {
        playerDead: {
          target: "DEFEAT",
          onEnter: ({ ctx, onGameOver }) => { ctx.match.matchOver = true; onGameOver(); },
        },
        // G1.2 — VIP death is a defeat in VIP Escort mode.
        vipKilled: {
          target: "DEFEAT",
          onEnter: ({ ctx, onGameOver }) => { ctx.match.matchOver = true; onGameOver(); },
        },
      },
      WAVE_TRANSITION: {
        startNextWave: {
          target: "IN_PROGRESS",
          onEnter: ({ ctx, onStartNextWave }) => {
            ctx.match.waveTransitioning = false;
            onStartNextWave();
          },
        },
      },
      VICTORY: {
        restart: { target: "BRIEFING", onEnter: ({ onReset }) => onReset() },
      },
      DEFEAT: {
        restart: { target: "BRIEFING", onEnter: ({ onReset }) => onReset() },
      },
      POST_MATCH: {
        restart: { target: "BRIEFING", onEnter: ({ onReset }) => onReset() },
      },
    };
    this.ctxRef = { ctx, ...handlers };
    this.fsm = new FiniteStateMachine(cleanTable, "BRIEFING", this.ctxRef);
  }

  get state(): MatchState { return this.fsm.state as MatchState; }
  is(s: MatchState): boolean { return this.fsm.is(s); }
  isIn(...s: MatchState[]): boolean { return this.fsm.isIn(...s); }

  /** Engine-level events. */
  startMatch() { this.fsm.send("startMatch"); this.fsm.send("deployComplete"); }
  playerDead() { this.fsm.send("playerDead"); }
  /** G1.2 — VIP killed (VIP Escort defeat condition). */
  vipKilled() { this.fsm.send("vipKilled"); }

  /** Wave fix: jump straight to IN_PROGRESS without firing the DEPLOYING
   *  onEnter (which calls onStartNextWave). The engine explicitly calls
   *  enemies.startWave(1) after this, so we avoid the duplicate-spawn bug
   *  where the FSM would trigger startWave(ctx.match.wave + 1) = startWave(2)
   *  before the engine resets wave to 1. */
  skipToInProgress() {
    this.fsm.reset("IN_PROGRESS");
  }

  /** Wave cleared — transitions to VICTORY (if last wave) or WAVE_TRANSITION. */
  waveCleared() {
    const { ctx } = this.ctxRef;
    // Wave fix: if the FSM has already transitioned to VICTORY, bail out.
    // engine.victory() calls waveCleared() which would call onVictory() →
    // engine.victory() → waveCleared() → … infinite recursion. The FSM
    // state check is the reliable single-source-of-truth guard.
    if (this.fsm.is("VICTORY") || this.fsm.is("DEFEAT")) return;
    if (ctx.match.wave >= ctx.match.maxWaves) {
      ctx.match.matchOver = true;
      this.fsm.reset("VICTORY");
      this.ctxRef.onVictory();
    } else {
      ctx.match.waveTransitioning = true;
      this.fsm.reset("WAVE_TRANSITION");
    }
  }

  /** Wave fix: transition FSM to VICTORY without firing onEnter (no
   *  recursion risk). Used by engine.victory() to keep the FSM state
   *  in sync without re-entering the onVictory callback chain. */
  markVictory() {
    if (!this.fsm.is("VICTORY")) {
      this.ctxRef.ctx.match.matchOver = true;
      this.fsm.reset("VICTORY");
    }
  }

  /** Wave fix: transition FSM to DEFEAT without firing onEnter. */
  markDefeat() {
    if (!this.fsm.is("DEFEAT")) {
      this.ctxRef.ctx.match.matchOver = true;
      this.fsm.reset("DEFEAT");
    }
  }

  /** Start the next wave after a wave transition. */
  startNextWave() {
    if (this.fsm.is("WAVE_TRANSITION")) {
      this.ctxRef.ctx.match.waveTransitioning = false;
      this.ctxRef.onStartNextWave();
      this.fsm.reset("IN_PROGRESS");
    }
  }

  /** Player requested restart from victory/defeat screen. */
  restart() {
    this.fsm.send("restart");
    this.fsm.send("startMatch");
    this.fsm.send("deployComplete");
  }

  /** True when the match loop should tick gameplay systems. */
  get shouldTickGameplay(): boolean {
    return this.fsm.is("IN_PROGRESS") || this.fsm.is("WAVE_TRANSITION") || this.fsm.is("DEPLOYING");
  }

  /** True when the match is over (victory or defeat). */
  get matchOver(): boolean {
    return this.fsm.is("VICTORY") || this.fsm.is("DEFEAT") || this.fsm.is("POST_MATCH");
  }

  /** Derive the UI-facing phase string from the FSM state (data-driven lookup). */
  toGamePhase(): "menu" | "playing" | "paused" | "dead" | "victory" {
    const map: Record<MatchState, "menu" | "playing" | "paused" | "dead" | "victory"> = {
      BRIEFING: "playing", DEPLOYING: "playing", IN_PROGRESS: "playing", WAVE_TRANSITION: "playing",
      VICTORY: "victory", DEFEAT: "dead", POST_MATCH: "menu",
    };
    return map[this.fsm.state as MatchState] ?? "menu";
  }
}
