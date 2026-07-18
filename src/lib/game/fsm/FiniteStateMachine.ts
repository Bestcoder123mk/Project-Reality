/**
 * A generic data-driven finite state machine.
 *
 * The transition table is a plain object lookup keyed by `currentState -> eventName`.
 * Each entry is `{ target: StateName, onEnter?: (ctx) => void, onExit?: (ctx) => void }`.
 * No switch statements — all data.
 *
 * Used by MatchFSM (match lifecycle) and EnemyFSM (per-enemy AI).
 */
export type FSMState = string;
export type FSMEvent = string;

export interface FSMTransition<Ctx> {
  target: FSMState;
  onEnter?: (ctx: Ctx) => void;
  onExit?: (ctx: Ctx) => void;
}

export type FSMTable<Ctx> = Record<FSMState, Record<FSMEvent, FSMTransition<Ctx> | undefined>>;

export class FiniteStateMachine<Ctx = unknown> {
  private current: FSMState;
  private table: FSMTable<Ctx>;
  private ctx: Ctx;
  private history: { from: FSMState; event: FSMEvent; to: FSMState; at: number }[] = [];

  constructor(table: FSMTable<Ctx>, initial: FSMState, ctx: Ctx) {
    this.table = table;
    this.current = initial;
    this.ctx = ctx;
  }

  /** Current state name. */
  get state(): FSMState { return this.current; }

  /** Is the FSM currently in `s`? */
  is(s: FSMState): boolean { return this.current === s; }

  /** Is the FSM in any of the given states? */
  isIn(...states: FSMState[]): boolean { return states.includes(this.current); }

  /** Send an event. Returns true if a transition occurred.
   *
   *  Section D #1711 — dropped events (no transition registered for the
   *  current state + event) now surface via the optional `onDropEvent`
   *  callback (set by the owner) + a console.warn in dev. The prior code
   *  returned false silently, masking FSM-table bugs where a caller sent
   *  an event the table didn't handle (e.g. sending "seekCover" from
   *  PATROL — the table has no such transition, so the enemy stayed in
   *  PATROL with no diagnostic). */
  send(event: FSMEvent): boolean {
    const transitions = this.table[this.current];
    if (!transitions) {
      this._dropEvent(event, `no transitions registered for state "${this.current}"`);
      return false;
    }
    const t = transitions[event];
    if (!t) {
      this._dropEvent(event, `no transition from "${this.current}" on event "${event}"`);
      return false;
    }
    const from = this.current;
    const onExit = this.table[from]?.[event]?.onExit;
    onExit?.(this.ctx);
    this.current = t.target;
    t.onEnter?.(this.ctx);
    this.history.push({ from, event, to: t.target, at: performance.now() });
    if (this.history.length > 32) this.history.shift();
    return true;
  }

  /** Section D #1711 — drop-event callback. Set by the FSM owner to surface
   *  dropped events (e.g. EnemyFSM routes these to a debug bark or a
   *  telemetry counter). */
  onDropEvent?: (event: FSMEvent, reason: string) => void;

  /** Section D #1711 — internal helper for the drop-event path. */
  private _dropEvent(event: FSMEvent, reason: string): void {
    if (typeof console !== "undefined" && console.warn) {
      console.warn(`[FSM] dropped event "${event}" — ${reason}`);
    }
    this.onDropEvent?.(event, reason);
  }

  /** Reset to a state without firing transitions.
   *
   *  Section D #1712 — fires the current state's `__reset` event handler's
   *  onExit if one is registered (so per-state timers like COVER's
   *  coverEnterTime / FLEE's fleeEnterTime get cleaned when the FSM is
   *  reset on match restart / enemy respawn). The prior code set `current`
   *  directly without firing any onExit, so stale timers persisted on the
   *  enemy object across resets. The `__reset` event is a convention (not
   *  a real transition); states that need cleanup register it in the table
   *  with only an `onExit` (the `target` is ignored since reset sets the
   *  state explicitly). */
  reset(s: FSMState) {
    // Fire the current state's __reset onExit if registered.
    const resetTransition = this.table[this.current]?.["__reset"];
    resetTransition?.onExit?.(this.ctx);
    this.current = s;
    this.history = [];
  }

  /** Recent transition history (newest last). */
  getHistory() { return [...this.history]; }
}
