import { describe, it, expect } from "vitest";
import { ENEMY_FSM_TABLE, type EnemyFSMState, type EnemyFSMEvent } from "../EnemyFSM";
import { FiniteStateMachine, type FSMTable } from "../FiniteStateMachine";

/**
 * Backlog §2 item 41 — Static checker: does every enemy FSM state have a
 * valid exit transition?
 *
 * A state with zero outgoing transitions is a dead-end: once the FSM
 * enters it, it can never leave. The only state where this is correct is
 * a terminal state (DEAD — the enemy is, well, dead). Every other state
 * must have at least one outgoing transition or the AI will soft-lock.
 *
 * This test scans the table at import time and reports any dead-end
 * states (other than DEAD) as failures. It also verifies:
 *   - Every transition's `target` is itself a defined state in the table.
 *   - Every state can reach DEAD via some event chain (liveness — the
 *     enemy can always die, no matter where it is).
 *   - The `killed` event transitions to DEAD from every non-DEAD state
 *     (so the EnemySystem's death handling can fire from anywhere).
 */

const STATES = Object.keys(ENEMY_FSM_TABLE) as EnemyFSMState[];
const TERMINAL_STATES: EnemyFSMState[] = ["DEAD"];

describe("EnemyFSM table — static structural invariants", () => {
  it("has every expected state (IDLE, PATROL, CHASE, ATTACK, SUPPRESSED, FLANK, COVER, FLEE, DEAD)", () => {
    expect(STATES.sort()).toEqual(
      [
        "ATTACK", "CHASE", "COVER", "DEAD", "FLEE",
        "FLANK", "IDLE", "PATROL", "SUPPRESSED",
      ].sort(),
    );
  });

  it("every non-terminal state has ≥1 outgoing transition (no dead-ends)", () => {
    const deadEnds: EnemyFSMState[] = [];
    for (const state of STATES) {
      if (TERMINAL_STATES.includes(state)) continue;
      const transitions = ENEMY_FSM_TABLE[state];
      const eventCount = transitions ? Object.keys(transitions).length : 0;
      if (eventCount === 0) deadEnds.push(state);
    }
    expect(deadEnds, `states with no exits: ${deadEnds.join(", ")}`).toEqual([]);
  });

  it("terminal states (DEAD) are allowed to have zero outgoing transitions", () => {
    for (const t of TERMINAL_STATES) {
      // Just verify the state exists in the table — its transitions may be
      // empty (correct for DEAD) or non-empty (also fine — e.g. a respawn
      // transition). The structural invariant is that non-terminal states
      // must have ≥1 exit, which is tested above.
      expect(ENEMY_FSM_TABLE[t]).toBeDefined();
    }
  });

  it("every transition's target is a defined state in the table (no orphan targets)", () => {
    const orphans: Array<{ from: EnemyFSMState; event: EnemyFSMEvent; target: string }> = [];
    for (const state of STATES) {
      const transitions = ENEMY_FSM_TABLE[state] ?? {};
      for (const [event, t] of Object.entries(transitions) as Array<[EnemyFSMEvent, { target: string }]>) {
        if (!ENEMY_FSM_TABLE[t.target as EnemyFSMState]) {
          orphans.push({ from: state, event, target: t.target });
        }
      }
    }
    expect(orphans, `transitions pointing at undefined states: ${JSON.stringify(orphans)}`).toEqual([]);
  });
});

describe("EnemyFSM — death reachability (liveness check)", () => {
  it("every non-DEAD state has a `killed` transition to DEAD", () => {
    // The EnemySystem dispatches `killed` whenever health <= 0. If any
    // non-DEAD state lacks a `killed` transition, the enemy can soft-lock
    // at zero HP (alive=false never gets set, the ragdoll never spawns).
    const missing: EnemyFSMState[] = [];
    for (const state of STATES) {
      if (state === "DEAD") continue;
      const t = ENEMY_FSM_TABLE[state]?.killed;
      if (!t || t.target !== "DEAD") missing.push(state);
    }
    expect(missing, `states missing a killed→DEAD transition: ${missing.join(", ")}`).toEqual([]);
  });

  it("DEAD state is reachable from every state via killed (BFS over the table)", () => {
    // Build an adjacency list and BFS from each state to DEAD.
    const adj: Record<string, string[]> = {};
    for (const state of STATES) {
      const transitions = ENEMY_FSM_TABLE[state] ?? {};
      adj[state] = Object.values(transitions).map((t) => t.target);
    }
    function canReachDead(from: string): boolean {
      if (from === "DEAD") return true;
      const visited = new Set<string>([from]);
      const queue: string[] = [from];
      while (queue.length > 0) {
        const s = queue.shift()!;
        for (const next of adj[s] ?? []) {
          if (next === "DEAD") return true;
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    }
    for (const state of STATES) {
      expect(canReachDead(state), `${state} cannot reach DEAD`).toBe(true);
    }
  });
});

describe("EnemyFSM — runtime sanity (instance behavior)", () => {
  // Build a minimal mock Enemy that satisfies the table's onEnter hooks.
  function makeMockEnemy() {
    return {
      alive: true,
      deadTime: 0,
      lastDamagedTime: 0,
      // Stub any other fields the onEnter hooks might touch.
    } as unknown as import("../../systems/types").Enemy;
  }

  it("the FSM transitions IDLE → CHASE on spotPlayer", () => {
    const fsm = new FiniteStateMachine(ENEMY_FSM_TABLE as unknown as FSMTable<unknown>, "IDLE", {});
    expect(fsm.state).toBe("IDLE");
    expect(fsm.send("spotPlayer")).toBe(true);
    expect(fsm.state).toBe("CHASE");
  });

  it("the FSM transitions CHASE → ATTACK on inAttackRange", () => {
    const fsm = new FiniteStateMachine(ENEMY_FSM_TABLE as unknown as FSMTable<unknown>, "CHASE", {});
    fsm.send("inAttackRange");
    expect(fsm.state).toBe("ATTACK");
  });

  it("the FSM transitions ATTACK → DEAD on killed (and runs the onEnter hook)", () => {
    const enemy = makeMockEnemy();
    const fsm = new FiniteStateMachine(ENEMY_FSM_TABLE as unknown as FSMTable<{ enemy: typeof enemy }>, "ATTACK", { enemy });
    fsm.send("killed");
    expect(fsm.state).toBe("DEAD");
    expect(enemy.alive).toBe(false);
    expect(enemy.deadTime).toBeGreaterThan(0);
  });

  it("the FSM stays in DEAD on subsequent events (terminal)", () => {
    const enemy = makeMockEnemy();
    const fsm = new FiniteStateMachine(ENEMY_FSM_TABLE as unknown as FSMTable<{ enemy: typeof enemy }>, "DEAD", { enemy });
    // No outgoing transitions from DEAD — every send returns false.
    expect(fsm.send("killed")).toBe(false);
    expect(fsm.send("spotPlayer")).toBe(false);
    expect(fsm.state).toBe("DEAD");
  });

  it("every non-terminal state has a path back to CHASE (recovery)", () => {
    // Design invariant: CHASE is the "engaged" hub state. Every combat
    // state should be able to route back to CHASE (directly or via
    // ATTACK → outOfAttackRange → CHASE) so the AI doesn't get stuck.
    function canReachChase(from: string): boolean {
      if (from === "CHASE") return true;
      const visited = new Set<string>([from]);
      const queue: string[] = [from];
      const adj: Record<string, string[]> = {};
      for (const state of STATES) {
        adj[state] = Object.values(ENEMY_FSM_TABLE[state] ?? {}).map((t) => t.target);
      }
      while (queue.length > 0) {
        const s = queue.shift()!;
        for (const next of adj[s] ?? []) {
          if (next === "CHASE") return true;
          if (next === "DEAD") continue; // terminal, can't route through it
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    }
    // PATROL + IDLE don't have explicit recovery transitions (they're
    // pre-engagement states) — the spotPlayer event moves them to CHASE.
    // Every other non-terminal state should be able to reach CHASE.
    for (const state of STATES) {
      if (state === "DEAD" || state === "IDLE" || state === "PATROL") continue;
      expect(canReachChase(state), `${state} cannot reach CHASE`).toBe(true);
    }
  });
});
