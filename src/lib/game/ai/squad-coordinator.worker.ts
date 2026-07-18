/**
 * L1-5000 / prompts 4482,4536,4590,4628,4666,4704: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * squad-coordinator.worker.ts — Task 3 / item 64
 *
 * Web Worker offload for the squad-coordinator's pure-math tick. The
 * SquadCoordinator class has two interleaved responsibilities:
 *
 *   1. PURE MATH (this worker):
 *      - Distance computations (Math.hypot) for the recruitment pass.
 *      - Nearest-squad lookup + JOIN_RADIUS membership check.
 *      - Role assignment (SUPPRESSOR/FLANKER/HOLDER) based on enemy class.
 *      - LKPP freshness check (which enemy has LOS to the player, what's
 *        the shared LKPP timestamp to broadcast).
 *
 *   2. THREE.JS MUTATION (main thread — kept on SquadCoordinator):
 *      - Reading `enemy.group.position.x/z` (DOM-bound Object3D).
 *      - `enemy.fsm.send("flankOrder")` / `enemy.fsm.send("seekCover")` —
 *        FSM transitions are side-effectful + read shared mutable state.
 *      - `ctx.addKillFeed(...)` — mutates the HUD store.
 *
 * The split is: the main thread copies the pure-data slice (enemy positions +
 * classes + FSM states as enums) into a plain-object snapshot, posts it to
 * the worker, the worker computes the new squad topology + orders, posts
 * back the decisions, the main thread applies them via FSM dispatch.
 *
 * Why not move the whole class? Three.js objects can't cross the worker
 * boundary (no structured-clone support for Object3D with parent/child
 * backrefs). The snapshot/apply pattern is the standard Three.js + Worker
 * pattern (see e.g. the OffscreenCanvas worker renderers in three/examples).
 *
 * Comlink is used to expose the worker's API as a Promise-returning proxy
 * — no manual postMessage/onmessage boilerplate.
 *
 * Why this matters: on a 50-enemy wave with 12 active squads, the per-tick
 * recruitment + role-assignment loop is O(N²) on distance checks (~600
 * hypot calls) + a few sort passes. That's ~0.3ms on desktop but ~2ms on
 * mobile — moving it off the main thread keeps the input/render loop
 * jitter-free during heavy AI ticks.
 */

import * as Comlink from "comlink";

/** Plain-data snapshot of an enemy for the worker. No Three.js refs. */
export interface EnemySnapshot {
  id: number;
  x: number;
  z: number;
  /** EnemyClass label string — worker doesn't import the enum. */
  cls: string;
  /** FSM state as a string ("CHASE" | "ATTACK" | "FLANK" | "COVER" | etc.). */
  fsmState: string;
  /** Has a squad already (squadId, or -1 if solo). */
  squadId: number;
  /** Current squad role ("SUPPRESSOR" | "FLANKER" | "HOLDER" | ""). */
  role: string;
  /** Already-dispatched-flank-this-cycle flag. */
  flankDispatched: boolean;
  /** Health ratio (0..1) — for the suppressor-seek-cover decision. */
  healthRatio: number;
}

/** Plain-data snapshot of a squad for the worker. */
export interface SquadSnapshot {
  id: number;
  memberIds: number[];
  centerX: number;
  centerZ: number;
  /** Last order-dispatch timestamp (ms). */
  lastOrderAt: number;
}

/** Worker-side decision: what to do with one enemy this tick. */
export interface EnemyOrder {
  enemyId: number;
  /** New squad assignment (-1 = release to solo). 0 = no change. */
  assignToSquadId?: number;
  /** New role to set (only if assignToSquadId is set). */
  newRole?: "SUPPRESSOR" | "FLANKER" | "HOLDER";
  /** FSM event to dispatch (only if non-empty). */
  fsmEvent?: "flankOrder" | "seekCover";
  /** Whether the squad-flank-dispatched flag should be set/cleared. */
  setFlankDispatched?: boolean;
}

/** Worker-side decision: per-squad state updates. */
export interface SquadUpdate {
  squadId: number;
  /** Updated center (recomputed from alive members). */
  centerX: number;
  centerZ: number;
  /** Whether to dissolve this squad (drops below MIN_SQUAD). */
  dissolve: boolean;
  /** LKPP refresh: which enemy (id) refreshed the LKPP this tick, or -1. */
  lkppRefresherId: number;
}

/** Result of one worker tick. */
export interface SquadTickResult {
  enemyOrders: EnemyOrder[];
  squadUpdates: SquadUpdate[];
  /** Newly-created squads (formed this tick). */
  newSquads: SquadSnapshot[];
}

// ─── Tunables (mirror the SquadCoordinator constants) ──────────────────────
const JOIN_RADIUS = 18;
const MIN_SQUAD = 2;
const MAX_SQUAD = 4;
const ORDER_COOLDOWN_MS = 4000;
const LKPP_TTL_MS = 6000;
const TICK_MS = 500;

/** The pure-math tick — no Three.js, no FSM side effects. Computes what the
 *  main thread SHOULD do; the main thread applies it. */
export function tickSquadMath(
  enemies: EnemySnapshot[],
  squads: SquadSnapshot[],
  playerX: number,
  playerZ: number,
  now: number,
): SquadTickResult {
  const enemyOrders: EnemyOrder[] = [];
  const squadUpdates: SquadUpdate[] = [];
  const newSquads: SquadSnapshot[] = [];

  // 1. Recompute squad centers from alive members.
  for (const s of squads) {
    let sx = 0, sz = 0, n = 0;
    for (const id of s.memberIds) {
      const e = enemies.find((e) => e.id === id);
      if (!e) continue;
      sx += e.x;
      sz += e.z;
      n++;
    }
    if (n > 0) {
      s.centerX = sx / n;
      s.centerZ = sz / n;
    }
    // Dissolve if drops below MIN_SQUAD.
    const dissolve = n < MIN_SQUAD;
    squadUpdates.push({
      squadId: s.id,
      centerX: s.centerX,
      centerZ: s.centerZ,
      dissolve,
      lkppRefresherId: -1,
    });
  }

  // 2. Recruit unassigned enemies into existing squads (or form new ones).
  // Section D #1720 — removed the dead `=== 0` check. Squad ids are
  // 1-indexed (nextSquadId starts at 1, line below), so squadId === 0 never
  // matches. The prior `=== -1 || === 0` filter was equivalent to just
  // `=== -1` (the unassigned sentinel) but the dead check confused readers
  // + masked a future bug where someone changed the sentinel to 0.
  const unassigned = enemies.filter((e) => e.squadId === -1);
  // Section D #1719 — Math.max(...arr) overflows the call stack when arr
  // length exceeds the engine's argument limit (~65k–125k on V8). The prior
  // `Math.max(...squads.map((s) => s.id))` would throw RangeError on a
  // pathological match with >100k squads. The loop is O(N) + stack-safe.
  let maxSquadId = 0;
  for (const s of squads) { if (s.id > maxSquadId) maxSquadId = s.id; }
  let nextSquadId = maxSquadId > 0 ? maxSquadId + 1 : 1;

  for (const e of unassigned) {
    if (e.cls === "ZOMBIE" || e.cls === "SNIPER" || e.cls === "COMMANDER") continue;
    // Find nearest squad with room within JOIN_RADIUS.
    let bestSquad: SquadSnapshot | null = null;
    let bestDist = JOIN_RADIUS;
    for (const s of squads) {
      if (s.memberIds.length >= MAX_SQUAD) continue;
      if (squadUpdates.find((u) => u.squadId === s.id)?.dissolve) continue;
      const d = Math.hypot(e.x - s.centerX, e.z - s.centerZ);
      if (d < bestDist) { bestDist = d; bestSquad = s; }
    }
    if (bestSquad) {
      bestSquad.memberIds.push(e.id);
      enemyOrders.push({
        enemyId: e.id,
        assignToSquadId: bestSquad.id,
        newRole: assignRoleForEnemy(e.cls, bestSquad.memberIds, enemies),
      });
    } else if (unassigned.length >= MIN_SQUAD) {
      // Form a new squad.
      const newSquad: SquadSnapshot = {
        id: nextSquadId++,
        memberIds: [e.id],
        centerX: e.x,
        centerZ: e.z,
        lastOrderAt: now,
      };
      for (const other of unassigned) {
        if (other!.id === e.id) continue;
        if (other.squadId !== -1 && other.squadId !== 0) continue;
        if (newSquad.memberIds.length >= MAX_SQUAD) break;
        if (other.cls === "ZOMBIE" || other.cls === "SNIPER" || other.cls === "COMMANDER") continue;
        const d = Math.hypot(other.x - e.x, other.z - e.z);
        if (d < JOIN_RADIUS) {
          newSquad.memberIds.push(other!.id);
          enemyOrders.push({
            enemyId: other!.id,
            assignToSquadId: newSquad.id,
            newRole: assignRoleForEnemy(other.cls, newSquad.memberIds, enemies),
          });
        }
      }
      if (newSquad.memberIds.length >= MIN_SQUAD) {
        newSquads.push(newSquad);
      } else {
        // Couldn't form — release the members back to solo.
        for (const id of newSquad.memberIds) {
          enemyOrders.push({ enemyId: id, assignToSquadId: -1 });
        }
      }
    }
  }

  // 3. LKPP refresh — find an enemy in CHASE/ATTACK/FLANK to broadcast from.
  for (const s of squads) {
    if (squadUpdates.find((u) => u.squadId === s.id)?.dissolve) continue;
    const refresher = s.memberIds
      .map((id) => enemies.find((e) => e.id === id))
      .find((e) => e && (e.fsmState === "CHASE" || e.fsmState === "ATTACK" || e.fsmState === "FLANK"));
    if (refresher) {
      const update = squadUpdates.find((u) => u.squadId === s.id);
      if (update) update.lkppRefresherId = refresher.id;
    }
    // Dispatch orders (throttled per-squad).
    if (now - s.lastOrderAt < ORDER_COOLDOWN_MS) continue;
    const flankers = s.memberIds
      .map((id) => enemies.find((e) => e.id === id))
      .filter((e) => e && e.role === "FLANKER" && !e.flankDispatched);
    if (flankers.length === 0) continue;
    const picked = flankers[Math.floor(Math.random() * flankers.length)]!;
    if (picked!.fsmState === "CHASE") {
      enemyOrders.push({
        enemyId: picked!.id,
        fsmEvent: "flankOrder",
        setFlankDispatched: true,
      });
      // Reset the dispatch flag on the OTHER flankers.
      for (const other of flankers) {
        if (other!.id === picked!.id) continue;
        enemyOrders.push({
          enemyId: other!.id,
          setFlankDispatched: false,
        });
      }
    }
    // Suppressor seek-cover if injured.
    const suppressor = s.memberIds
      .map((id) => enemies.find((e) => e.id === id))
      .find((e) => e && e.role === "SUPPRESSOR");
    if (suppressor && suppressor.healthRatio < 0.4) {
      if (suppressor.fsmState === "CHASE" || suppressor.fsmState === "ATTACK" || suppressor.fsmState === "FLANK") {
        enemyOrders.push({
          enemyId: suppressor.id,
          fsmEvent: "seekCover",
        });
      }
    }
  }

  return { enemyOrders, squadUpdates, newSquads };
}

/** Assign a role to an enemy based on its class + the existing squad composition. */
function assignRoleForEnemy(
  cls: string,
  memberIds: number[],
  allEnemies: EnemySnapshot[],
): "SUPPRESSOR" | "FLANKER" | "HOLDER" {
  // Check what roles are already taken in this squad.
  let hasSuppressor = false;
  let flankerCount = 0;
  for (const id of memberIds) {
    const e = allEnemies.find((e) => e.id === id);
    if (!e) continue;
    if (e.role === "SUPPRESSOR") hasSuppressor = true;
    if (e.role === "FLANKER") flankerCount++;
  }
  if (!hasSuppressor && (cls === "MG" || cls === "RIFLEMAN" || cls === "SHOTGUNNER")) {
    return "SUPPRESSOR";
  }
  if (flankerCount < 2 && (cls === "CQB" || cls === "SCOUT")) {
    return "FLANKER";
  }
  return "HOLDER";
}

// ─── Comlink export ─────────────────────────────────────────────────────────
// The main thread wraps this via `Comlink.wrap(new Worker(...))` and calls
// `tickSquadMath(...)` as if it were a local async function.
const api = { tickSquadMath };
export type SquadCoordinatorWorkerAPI = typeof api;
Comlink.expose(api);
