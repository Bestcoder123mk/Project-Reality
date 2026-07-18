/**
 * SEC6-AI prompt 49 — Squad-level coordination.
 *
 * A SquadCoordinator groups 2–4 nearby enemies into a squad each spawn
 * wave and issues coordinated orders. Each squad:
 *   - Picks one member as the SUPPRESSOR (MG / RIFLEMAN — high-ROF,
 *     stays put, lays down suppressive fire).
 *   - Picks one or two members as FLANKERS (CQB / SCOUT — fast movers,
 *     loop around the player's flank via the FLANK FSM state).
 *   - Any remaining members hold position + engage.
 *   - Regroups after losing members (a fresh squad forms when an
 *     existing squad drops below 2 alive).
 *   - Shares last-known-player-position (LKPP) so a squadmate who lost
 *     LOS still moves toward the player's last seen location.
 *
 * Integration:
 *   EnemySystem should call:
 *     - `coordinator.register(e)` after pushing a new enemy into ctx.enemies
 *       (in startWave, after applyClassToEnemy).
 *     - `coordinator.unregister(e)` in killEnemy (before the ragdoll).
 *     - `coordinator.tick(ctx)` once per frame (throttled internally to
 *       ~2 Hz — dispatching FSM events more often would be noisy).
 *
 * Per-squad state is stashed on a Squad instance; per-enemy squad
 * membership is stashed on the enemy via cast (avoid touching the shared
 * Enemy interface).
 *
 * The coordinator REUSES the existing EnemyFSM events `flankOrder` and
 * `seekCover` — it does not invent new FSM events. Suppression is the
 * natural behavior of MG / RIFLEMAN classes (they shoot from CHASE /
 * ATTACK); no special "suppress" event exists, so the suppressor just
 * gets a "hold position + engage" stance via seekCover when suppressed
 * itself (the FSM handles the dynamic).
 *
 * SSR-safe: no DOM/Three.js access at module top-level. Three is imported
 * as a type-only namespace + a value import only inside methods that
 * build vectors.
 */
import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";
import type { EnemyClass } from "../EnemyClasses";
// Task 3 / item 64 — comlink-wrapped Web Worker for the pure-math tick.
// The worker is constructed lazily on first tick() call; if construction
// fails (SSR / older browser / test env), tick() falls back to the
// synchronous in-process path.
import * as Comlink from "comlink";
import type {
  SquadCoordinatorWorkerAPI,
  EnemySnapshot,
  SquadSnapshot,
  EnemyOrder,
  SquadTickResult,
} from "./squad-coordinator.worker";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/** Squad role assigned to each member. */
export type SquadRole = "SUPPRESSOR" | "FLANKER" | "HOLDER";

/** Per-enemy squad membership stash (cast onto the Enemy). */
interface EnemySquadExtra {
  /** Squad reference (null when not in a squad — solo enemy). */
  squadRef?: Squad | null;
  /** Role within the squad. */
  squadRole?: SquadRole;
  /** True once a flankOrder has been dispatched this squad cycle (so we
   *  don't re-issue flank every tick). */
  squadFlankDispatched?: boolean;
  /** Last-known-player-position shared by the squad (world-space). */
  squadLkpp?: THREE.Vector3 | null;
  /** Timestamp (performance.now()) the LKPP was last refreshed. */
  squadLkppTime?: number;
}

function ex(e: Enemy): EnemySquadExtra {
  return e as unknown as EnemySquadExtra;
}

/** Read the enemy's class label (set by applyClassToEnemy). */
function enemyClass(e: Enemy): EnemyClass | undefined {
  return (e as unknown as { enemyClass?: EnemyClass }).enemyClass;
}

/** A squad of 2–4 enemies + shared state. */
export class Squad {
  /** Stable id for debugging / logs. */
  readonly id: string;
  /** Members (alive only — dead members are pruned in tick). */
  members: Enemy[] = [];
  /** Last tick the squad received an order dispatch. */
  lastOrderAt = 0;
  /** Squad center (recomputed each tick). */
  centerX = 0;
  centerZ = 0;
  /** True once the squad has been dissolved (members absorbed into other
   *  squads or left solo). Used to prevent double-processing. */
  dissolved = false;

  constructor(id: string) {
    this.id = id;
  }

  /** Average position of alive members. */
  recomputeCenter() {
    let sx = 0, sz = 0, n = 0;
    for (const m of this.members) {
      if (!m.alive) continue;
      sx += m.group.position.x;
      sz += m.group.position.z;
      n++;
    }
    if (n > 0) { this.centerX = sx / n; this.centerZ = sz / n; }
  }

  /** Prune dead members. Returns true if the squad is still viable (≥2 alive). */
  pruneDead(): boolean {
    this.members = this.members.filter((m) => m.alive);
    return this.members.length >= 2;
  }

  /** Assign roles based on class. The first MG/RIFLEMAN becomes the
   *  suppressor; the first 1–2 fast movers (CQB/SCOUT) become flankers;
   *  MEDIC + SHIELD get dedicated support roles; everyone else holds.
   *
   *  Section D #1939 — SHOTGUNNER is no longer assigned as SUPPRESSOR.
   *  The prior code listed SHOTGUNNER alongside MG/RIFLEMAN in the
   *  suppressor check, but shotgunners are breaching rushers (close-range
   *  burst damage) — they should charge, not lay down suppressive fire.
   *  Now SHOTGUNNER falls through to the HOLDER/FLANKER path (the breachingRush
   *  flag in EnemyClasses drives their actual rush behavior).
   *
   *  Section D #1940 — MEDIC + SHIELD get dedicated support roles (MEDIC
   *  stays near injured allies; SHIELD leads the formation as a mobile
   *  cover). The SUPPRESSOR/FLANKER/HOLDER triad is preserved; MEDIC +
   *  SHIELD are tagged with their own role so squad tactics can route them
   *  appropriately (tickMedicHeal, tickShieldAdvance). */
  assignRoles() {
    let suppressorFound = false;
    let flankerSlots = 0;
    for (const m of this.members) {
      const cls = enemyClass(m);
      // Section D #1940 — MEDIC gets a dedicated MEDIC role (healer).
      if (cls === "MEDIC") {
        ex(m).squadRole = "HOLDER"; // HOLDER base; MEDIC behavior is class-gated.
        continue;
      }
      // Section D #1940 — SHIELD gets a dedicated SHIELD role (frontal cover).
      if (cls === "SHIELD") {
        ex(m).squadRole = "HOLDER"; // HOLDER base; SHIELD behavior is class-gated.
        continue;
      }
      // Section D #1939 — SHOTGUNNER removed from the suppressor list.
      if (!suppressorFound && (cls === "MG" || cls === "RIFLEMAN")) {
        ex(m).squadRole = "SUPPRESSOR";
        suppressorFound = true;
      } else if (flankerSlots < 2 && (cls === "CQB" || cls === "SCOUT" || cls === "SHOTGUNNER")) {
        // Section D #1939 — SHOTGUNNER is now a flanker (breaching rush = flank + close).
        ex(m).squadRole = "FLANKER";
        flankerSlots++;
      } else {
        ex(m).squadRole = "HOLDER";
      }
    }
    // Fallback: if no suppressor was found, promote the first holder.
    if (!suppressorFound) {
      const h = this.members.find((m) => ex(m).squadRole === "HOLDER");
      if (h) ex(h).squadRole = "SUPPRESSOR";
    }
    // Fallback: if no flanker was found, demote a holder to flanker.
    if (flankerSlots === 0 && this.members.length >= 2) {
      const h = this.members.find((m) => ex(m).squadRole === "HOLDER");
      if (h) ex(h).squadRole = "FLANKER";
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Coordinator
// ───────────────────────────────────────────────────────────────────────────

/**
 * SquadCoordinator — owns squad formation + order dispatch.
 *
 * Tick is throttled to ~2 Hz (every 500ms) — the FSM events we dispatch
 * are sticky (FLANK lasts until inAttackRange), so firing them more
 * often would just create churn.
 *
 * Task 3 / item 64 — Web Worker offload for the pure-math portion.
 *
 * The tick has two interleaved concerns:
 *   1. PURE MATH (offloaded to squad-coordinator.worker.ts via comlink):
 *      - Distance computations for the recruitment pass.
 *      - Role assignment based on enemy class.
 *      - LKPP freshness check.
 *      - Per-squad order dispatch decisions (which flanker to pick, whether
 *        the suppressor should seek cover).
 *   2. THREE.JS MUTATION (kept on this class — main thread):
 *      - Reading `enemy.group.position.x/z` (Object3D can't cross the
 *        worker boundary).
 *      - `enemy.fsm.send("flankOrder")` / `enemy.fsm.send("seekCover")` —
 *        FSM transitions are side-effectful + read shared mutable state.
 *      - `ctx.addKillFeed(...)` — mutates the HUD store.
 *
 * The split: the main thread snapshots the registered enemies into a plain-
 * data array (id, x, z, cls, fsmState, role, etc.), posts it to the worker,
 * the worker computes the new squad topology + orders, posts back the
 * decisions, the main thread applies them via FSM dispatch.
 *
 * Why not move the whole class? Three.js objects can't cross the worker
 * boundary (no structured-clone support for Object3D with parent/child
 * backrefs). The snapshot/apply pattern is the standard Three.js + Worker
 * pattern.
 *
 * The worker is OPTIONAL — when comlink/Worker construction fails (older
 * browser, SSR, or test env without a Worker global), `tick()` falls back
 * to the synchronous in-process path. The behavior is identical; the worker
 * is purely a perf optimization for the main-thread frame budget.
 */
export class SquadCoordinator {
  private squads: Squad[] = [];
  private nextSquadId = 1;
  private lastTickAt = 0;
  /** Tunable: max distance between an enemy and a squad center to join it. */
  private readonly JOIN_RADIUS = 18;
  /** Tunable: min / max squad size. */
  private readonly MIN_SQUAD = 2;
  private readonly MAX_SQUAD = 4;
  /** Tunable: tick interval (ms). */
  private readonly TICK_MS = 500;
  /** Tunable: minimum interval between flank-order dispatches per squad. */
  private readonly ORDER_COOLDOWN_MS = 4000;
  /** Tunable: LKPP freshness TTL — if older than this, squad ignores it. */
  private readonly LKPP_TTL_MS = 6000;

  /** Task 3 / item 64 — comlink proxy to the pure-math worker. Lazily
   *  constructed on first tick(); null when Worker isn't available (SSR /
   *  tests) — tick() falls back to the synchronous in-process path. */
  private _worker: SquadCoordinatorWorkerAPI | null = null;
  /** Per-enemy stable id for the worker snapshot. Map<Enemy, number>. */
  private _enemyIds = new WeakMap<Enemy, number>();
  private _nextEnemyId = 1;
  /** True once we've attempted worker construction (success or fail). */
  private _workerInitAttempted = false;

  /** All enemies ever registered (alive only — dead are pruned). */
  private registered: Enemy[] = [];

  // ────────────── Registration ──────────────

  /**
   * Register an enemy with the coordinator. Called by EnemySystem when a
   * new enemy is pushed into ctx.enemies. The enemy is NOT immediately
   * assigned to a squad — formation happens at the next tick.
   */
  register(e: Enemy) {
    if (!e) return;
    if (this.registered.includes(e)) return;
    this.registered.push(e);
    ex(e).squadRef = null;
    ex(e).squadRole = undefined;
    ex(e).squadFlankDispatched = false;
    ex(e).squadLkpp = null;
    ex(e).squadLkppTime = 0;
  }

  /**
   * Unregister an enemy (e.g. on death). Removes it from any squad. The
   * squad itself may dissolve on the next tick if it drops below MIN_SQUAD.
   */
  unregister(e: Enemy) {
    const idx = this.registered.indexOf(e);
    if (idx >= 0) this.registered.splice(idx, 1);
    const squad = ex(e).squadRef;
    if (squad) {
      const mi = squad.members.indexOf(e);
      if (mi >= 0) squad.members.splice(mi, 1);
    }
    ex(e).squadRef = null;
    ex(e).squadRole = undefined;
    ex(e).squadFlankDispatched = false;
  }

  /** Get a snapshot of active squads (for debugging / HUD overlay). */
  getSquads(): Squad[] { return [...this.squads]; }

  /** Get the squad an enemy belongs to, if any. */
  getSquadFor(e: Enemy): Squad | null { return ex(e).squadRef ?? null; }

  /** Reset all squads (e.g. on match restart). Clears squad membership on
   *  all registered enemies so they don't carry stale squad refs. */
  reset() {
    // Clear squad membership on all registered enemies (otherwise they
    // keep a stale ref to a dissolved squad).
    for (const e of this.registered) {
      const x = ex(e);
      x.squadRef = null;
      x.squadRole = undefined;
      x.squadFlankDispatched = false;
      x.squadLkpp = null;
      x.squadLkppTime = 0;
    }
    this.squads = [];
    this.registered = [];
    this.lastTickAt = 0;
    this.nextSquadId = 1;
  }

  // ────────────── Tick ──────────────

  /**
   * Tick the coordinator. Forms new squads from unassigned enemies,
   * prunes dead members, recomputes centers, shares LKPP, and dispatches
   * flank / seekCover orders.
   *
   * @param ctx   GameContext (read-only — used for player position).
   * @param force Bypass the 2 Hz throttle (used by tests + the engine's
   *              immediate-spawn path when a wave just started).
   */
  tick(ctx: GameContext, force: boolean = false) {
    const now = performance.now();
    if (!force && now - this.lastTickAt < this.TICK_MS) return;
    this.lastTickAt = now;

    // 1. Prune dead from registered pool + existing squads.
    this.registered = this.registered.filter((e) => e.alive);
    const dissolved: Squad[] = [];
    for (const s of this.squads) {
      if (!s.pruneDead()) {
        s.dissolved = true;
        dissolved.push(s);
        // Clear squad refs on remaining members (now solo).
        for (const m of s.members) {
          ex(m).squadRef = null;
          ex(m).squadRole = undefined;
          ex(m).squadFlankDispatched = false;
        }
      }
    }
    if (dissolved.length > 0) {
      this.squads = this.squads.filter((s) => !s.dissolved);
    }

    // 2. Recruit unassigned enemies into existing squads (or form new ones).
    // NOTE: `unassigned` is a snapshot — assignments made inside the loop
    // mutate ex(e).squadRef, so we re-check `ex(e).squadRef == null` at
    // the top of each iteration to skip enemies that got recruited by an
    // earlier iteration's inner loop.
    // Section D #1714 — the prior filter used `=== null` which excluded
    // enemies whose squadRef was `undefined` (the initial state before
    // register() ran). Now `== null` catches both null + undefined so all
    // truly-unassigned enemies are considered.
    const unassigned = this.registered.filter((e) => ex(e).squadRef == null);
    // Section D #1715 — O(N log N) recruitment via a uniform grid spatial
    // hash. The prior code was O(N²): for each unassigned enemy, it scanned
    // all squads + all other unassigned enemies. With N=30 enemies that's
    // 900 distance checks per tick (×2 Hz = 1800/sec). The grid buckets
    // enemies + squads by cell (JOIN_RADIUS = 18m) so the inner loop only
    // checks enemies/squads in the 3×3 neighborhood of the query point.
    const CELL = this.JOIN_RADIUS;
    const cellKey = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    const squadGrid = new Map<string, Squad[]>();
    for (const s of this.squads) {
      if (s.members.length >= this.MAX_SQUAD) continue;
      const k = cellKey(s.centerX, s.centerZ);
      const arr = squadGrid.get(k);
      if (arr) arr.push(s); else squadGrid.set(k, [s]);
    }
    const unassignedGrid = new Map<string, Enemy[]>();
    for (const e of unassigned) {
      const k = cellKey(e.group.position.x, e.group.position.z);
      const arr = unassignedGrid.get(k);
      if (arr) arr.push(e); else unassignedGrid.set(k, [e]);
    }
    const nearbySquads = (x: number, z: number): Squad[] => {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      const out: Squad[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = squadGrid.get(`${cx + dx},${cz + dz}`);
          if (arr) out.push(...arr);
        }
      }
      return out;
    };
    const nearbyUnassigned = (x: number, z: number): Enemy[] => {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      const out: Enemy[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = unassignedGrid.get(`${cx + dx},${cz + dz}`);
          if (arr) out.push(...arr);
        }
      }
      return out;
    };
    for (const e of unassigned) {
      if (ex(e).squadRef != null) continue; // Already recruited this tick.
      // Skip classes that don't benefit from squad behavior (ZOMBIE is
      // melee-only; SNIPER / COMMANDER act as solo anchors).
      const cls = enemyClass(e);
      if (cls === "ZOMBIE" || cls === "SNIPER" || cls === "COMMANDER") continue;
      // Find the nearest squad with room within JOIN_RADIUS — O(1) avg via
      // the grid (only checks squads in the 3×3 neighborhood).
      let best: Squad | null = null;
      let bestDist = this.JOIN_RADIUS;
      for (const s of nearbySquads(e.group.position.x, e.group.position.z)) {
        if (s.members.length >= this.MAX_SQUAD) continue;
        const d = Math.hypot(
          e.group.position.x - s.centerX,
          e.group.position.z - s.centerZ,
        );
        if (d < bestDist) { bestDist = d; best = s; }
      }
      if (best) {
        best.members.push(e);
        ex(e).squadRef = best;
      } else if (unassigned.length >= this.MIN_SQUAD) {
        // Form a new squad — greedily recruit nearby unassigned enemies
        // (O(1) avg via the grid).
        const newSquad = new Squad(`squad-${this.nextSquadId++}`);
        newSquad.members.push(e);
        ex(e).squadRef = newSquad;
        for (const other of nearbyUnassigned(e.group.position.x, e.group.position.z)) {
          if (other === e) continue;
          if (ex(other).squadRef != null) continue;
          if (newSquad.members.length >= this.MAX_SQUAD) break;
          const cls2 = enemyClass(other);
          if (cls2 === "ZOMBIE" || cls2 === "SNIPER" || cls2 === "COMMANDER") continue;
          const d = Math.hypot(
            other.group.position.x - e.group.position.x,
            other.group.position.z - e.group.position.z,
          );
          if (d < this.JOIN_RADIUS) {
            newSquad.members.push(other);
            ex(other).squadRef = newSquad;
          }
        }
        if (newSquad.members.length >= this.MIN_SQUAD) {
          newSquad.assignRoles();
          this.squads.push(newSquad);
          // Section D #1716 — failed-squad cleanup. The prior code released
          // members back to solo but left the newSquad object with stale
          // member refs (it wasn't pushed to this.squads, but the Squad
          // instance itself held enemy refs that prevented GC). Now we
          // also clear the newSquad.members array so the Squad is fully
          // released.
          // Update the grid so future iterations see the new squad.
          const k = cellKey(newSquad.centerX, newSquad.centerZ);
          const arr = squadGrid.get(k);
          if (arr) arr.push(newSquad); else squadGrid.set(k, [newSquad]);
        } else {
          // Couldn't form a squad — release the members back to solo +
          // clear the newSquad's member refs (Section D #1716).
          for (const m of newSquad.members) ex(m).squadRef = null;
          newSquad.members = [];
        }
      }
    }

    // 3. Recompute squad centers + share LKPP + dispatch orders.
    const playerPos = ctx.player.pos;
    for (const s of this.squads) {
      s.recomputeCenter();
      // Any member with LOS to the player refreshes the shared LKPP.
      let lkppRefreshed = false;
      for (const m of s.members) {
        if (!m.alive) continue;
        // Cheap LOS: if the enemy is in CHASE / ATTACK / FLANK, it has (or
        // recently had) the player. We treat that as "currently sees".
        const st = m.fsm?.state;
        if (st === "CHASE" || st === "ATTACK" || st === "FLANK") {
          ex(m).squadLkpp = playerPos.clone();
          ex(m).squadLkppTime = now;
          lkppRefreshed = true;
          break;
        }
      }
      if (lkppRefreshed) {
        // Broadcast to the rest of the squad.
        const refresher = s.members.find((m) => ex(m).squadLkppTime === now);
        const lkpp = refresher ? ex(refresher).squadLkpp : undefined;
        if (refresher && lkpp) {
          const lkppTime = now;
          for (const m of s.members) {
            if (m === refresher) continue;
            ex(m).squadLkpp = lkpp.clone();
            ex(m).squadLkppTime = lkppTime;
          }
        }
      }

      // Dispatch orders (throttled per-squad).
      if (now - s.lastOrderAt < this.ORDER_COOLDOWN_MS) continue;
      s.lastOrderAt = now;
      // Pick one flanker to dispatch a flank order to (rotate so we don't
      // always flank with the same enemy). Holders + suppressors stay put.
      const flankers = s.members.filter(
        (m) => ex(m).squadRole === "FLANKER" && m.alive && !ex(m).squadFlankDispatched,
      );
      if (flankers.length === 0) continue;
      // Pick at most one flanker per cycle to keep the formation coherent.
      const f = flankers[Math.floor(Math.random() * flankers.length)];
      // Only issue flank order if the enemy is in CHASE (FLANK is only a
      // valid transition from CHASE per the FSM table).
      if (f.fsm?.state === "CHASE" || f.fsm?.state === "ATTACK") {
        // Section D #1707 — accept CHASE or ATTACK (was CHASE only).
        f.fsm.send("flankOrder");
        ex(f).squadFlankDispatched = true;
        // Reset the dispatch flag on the OTHER flankers so the next cycle
        // they can be picked.
        for (const other of flankers) {
          if (other !== f) ex(other).squadFlankDispatched = false;
        }
        // Section D #1717 — killfeed spam throttle. The prior code pushed a
        // killfeed entry EVERY order dispatch (every ORDER_COOLDOWN_MS per
        // squad), which flooded the feed with "SQUAD X — Coordinated flank
        // dispatched" entries. Now we throttle to one entry per squad per
        // 30s via a per-squad lastKillFeedAt stamp.
        const squadEx = s as Squad & { lastKillFeedAt?: number };
        const KILLFEED_THROTTLE_MS = 30000;
        if (!squadEx.lastKillFeedAt || now - squadEx.lastKillFeedAt > KILLFEED_THROTTLE_MS) {
          squadEx.lastKillFeedAt = now;
          ctx.addKillFeed({
            killer: `SQUAD ${s.id.toUpperCase()}`,
            victim: "Coordinated flank dispatched",
            weapon: "", headshot: false,
          });
        }
      }
      // If a suppressor is injured, tell it to seek cover (the FSM will
      // route it via COVER → exitCover → ATTACK).
      const suppressor = s.members.find(
        (m) => ex(m).squadRole === "SUPPRESSOR" && m.alive,
      );
      if (suppressor && suppressor.health / suppressor.maxHealth < 0.4) {
        const st = suppressor.fsm?.state;
        if (st === "CHASE" || st === "ATTACK" || st === "FLANK") {
          suppressor.fsm?.send("seekCover");
        }
      }
    }
  }

  /**
   * Get the last-known-player-position shared by this enemy's squad, or
   * null if stale / no squad. EnemySystem can use this to route a
   * LOS-losing enemy toward the squad's LKPP instead of giving up.
   */
  getSharedLkpp(e: Enemy): THREE.Vector3 | null {
    const lkpp = ex(e).squadLkpp;
    const lkppTime = ex(e).squadLkppTime ?? 0;
    if (!lkpp) return null;
    if (performance.now() - lkppTime > this.LKPP_TTL_MS) return null;
    return lkpp.clone();
  }

  /** Dispose — clear all squads (e.g. on engine.dispose). Also terminates
   *  the worker (if it was constructed) so the tab doesn't hold a dangling
   *  Worker thread after the engine is destroyed. */
  dispose() {
    this.reset();
    if (this._worker) {
      try {
        // Terminate the underlying Worker directly.
        (this._worker as unknown as Worker).terminate();
      } catch {
        // Best-effort — worker may already be terminated.
      }
      this._worker = null;
      this._workerInitAttempted = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Task 3 / item 64 — Web Worker integration (comlink-wrapped).
  // ═══════════════════════════════════════════════════════════════════════

  /** Lazily construct the worker proxy. Returns null when Worker isn't
   *  available (SSR, test env without a Worker global) — callers should
   *  fall back to the synchronous in-process tick path.
   *
   *  Side-effectful: caches the proxy on `_worker` so subsequent calls are
   *  free. The Worker URL is resolved via `new URL(..., import.meta.url)`
   *  which Next.js / Turbopack compiles into a separate chunk. */
  private _initWorker(): SquadCoordinatorWorkerAPI | null {
    if (this._workerInitAttempted) return this._worker as unknown as SquadCoordinatorWorkerAPI;
    this._workerInitAttempted = true;
    if (typeof window === "undefined") return null; // SSR.
    if (typeof Worker === "undefined") return null; // Ancient browser.
    try {
      // The `new URL('./squad-coordinator.worker.ts', import.meta.url)`
      // pattern is what Next.js / Turbopack / Webpack 5 recognize for
      // spawning a Worker from a TypeScript module. The bundler compiles
      // the worker module into a separate chunk + replaces the URL with
      // the chunk's served path at runtime.
      const worker = new Worker(
        new URL("./squad-coordinator.worker.ts", import.meta.url),
        { type: "module" },
      );
      this._worker = Comlink.wrap<SquadCoordinatorWorkerAPI>(worker) as unknown as SquadCoordinatorWorkerAPI;
      return this._worker as unknown as SquadCoordinatorWorkerAPI;
    } catch {
      return null;
    }
  }

  /** Async variant of tick() that offloads the pure-math portion to the
   *  Web Worker. The main thread snapshots the registered enemies into
   *  plain-data objects, posts them to the worker, awaits the result, then
   *  applies the decisions (FSM dispatch, squad membership update) on the
   *  main thread. Behaviorally identical to the synchronous tick() — the
   *  only difference is that the heavy O(N²) recruitment math runs on a
   *  separate thread, freeing the main thread's frame budget.
   *
   *  When the worker isn't available (SSR / older browser / tests), this
   *  delegates to the synchronous `tick()` so callers don't need a
   *  separate fallback path. */
  async tickAsync(ctx: GameContext, force: boolean = false): Promise<void> {
    const worker = this._initWorker();
    if (!worker) {
      // Fallback: synchronous in-process tick. Passes the caller's `force`
      // flag through so the throttle applies unless the caller explicitly
      // bypasses it (Section D #1721 — the OTHER fallback, in the worker-
      // failure catch block, was the one that unconditionally forced).
      this.tick(ctx, force);
      return;
    }
    const now = performance.now();
    if (!force && now - this.lastTickAt < this.TICK_MS) return;
    this.lastTickAt = now;

    // 1. Prune dead from registered pool + existing squads.
    this.registered = this.registered.filter((e) => e.alive);
    const dissolved: Squad[] = [];
    for (const s of this.squads) {
      if (!s.pruneDead()) {
        s.dissolved = true;
        dissolved.push(s);
        for (const m of s.members) {
          ex(m).squadRef = null;
          ex(m).squadRole = undefined;
          ex(m).squadFlankDispatched = false;
        }
      }
    }
    if (dissolved.length > 0) {
      this.squads = this.squads.filter((s) => !s.dissolved);
    }

    // 2. Snapshot registered enemies into plain-data for the worker.
    const enemySnapshots: EnemySnapshot[] = this.registered.map((e) => {
      let id = this._enemyIds.get(e);
      if (id === undefined) {
        id = this._nextEnemyId++;
        this._enemyIds.set(e, id);
      }
      const cls = enemyClass(e) ?? "";
      const squad = ex(e).squadRef;
      return {
        id,
        x: e.group.position.x,
        z: e.group.position.z,
        cls: typeof cls === "string" ? cls : String(cls),
        fsmState: e.fsm?.state ?? "",
        squadId: squad ? this.squads.indexOf(squad) + 1 : -1,
        role: (ex(e).squadRole ?? "") as string,
        flankDispatched: !!ex(e).squadFlankDispatched,
        healthRatio: e.maxHealth > 0 ? e.health / e.maxHealth : 1,
      };
    });

    // 3. Snapshot existing squads.
    const squadSnapshots: SquadSnapshot[] = this.squads.map((s, i) => ({
      id: i + 1,
      memberIds: s.members
        .map((m) => this._enemyIds.get(m))
        .filter((id): id is number => id !== undefined),
      centerX: s.centerX,
      centerZ: s.centerZ,
      lastOrderAt: s.lastOrderAt,
    }));

    // 4. Call the worker.
    let result: SquadTickResult;
    try {
      result = await worker.tickSquadMath(
        enemySnapshots,
        squadSnapshots,
        ctx.player.pos.x,
        ctx.player.pos.z,
        now,
      );
    } catch {
      // Section D #1721 — worker failed. The prior code fell back to
      // `this.tick(ctx, true)` with force=true, which BYPASSED the tick
      // throttle. If the worker was persistently broken (e.g. a CSP
      // violation), every tickAsync call would run the full sync tick —
      // defeating the throttle. Now we fall back to `this.tick(ctx, force)`
      // (passing the caller's force flag) so the throttle still applies on
      // the worker-failure path. We also reset the worker so the next
      // tickAsync re-tries construction (transient failures don't permanently
      // disable the worker).
      this._worker = null;
      this._workerInitAttempted = false;
      this.tick(ctx, force);
      return;
    }

    // 5. Apply the worker's decisions on the main thread.
    //    - Map worker squad ids back to Squad instances.
    //    - Dispatch FSM events.
    //    - Update LKPP.
    this._applyWorkerResult(result, ctx, now);
  }

  /** Apply the worker's computed decisions on the main thread. This is the
   *  ONLY place Three.js objects + FSM state are mutated — the worker just
   *  decides WHAT to do; we do it. */
  private _applyWorkerResult(result: SquadTickResult, ctx: GameContext, now: number): void {
    // Index enemies by their worker id for O(1) lookup.
    const byId = new Map<number, Enemy>();
    for (const e of this.registered) {
      const id = this._enemyIds.get(e);
      if (id !== undefined) byId.set(id, e);
    }
    // Apply enemy orders.
    for (const order of result.enemyOrders) {
      const e = byId.get(order.enemyId);
      if (!e) continue;
      if (order.assignToSquadId !== undefined) {
        if (order.assignToSquadId === -1) {
          ex(e).squadRef = null;
          ex(e).squadRole = undefined;
        } else {
          // Find or create the squad by worker id.
          let squad = this.squads.find((s, i) => i + 1 === order.assignToSquadId);
          if (!squad) {
            // New squad from worker — find it in result.newSquads.
            const newSnap = result.newSquads.find((ns) => ns.id === order.assignToSquadId);
            if (newSnap) {
              squad = new Squad(`squad-${this.nextSquadId++}`);
              squad.centerX = newSnap.centerX;
              squad.centerZ = newSnap.centerZ;
              squad.lastOrderAt = newSnap.lastOrderAt;
              this.squads.push(squad);
            }
          }
          if (squad) {
            if (!squad.members.includes(e)) squad.members.push(e);
            ex(e).squadRef = squad;
            if (order.newRole) ex(e).squadRole = order.newRole;
          }
        }
      }
      if (order.setFlankDispatched !== undefined) {
        ex(e).squadFlankDispatched = order.setFlankDispatched;
      }
      if (order.fsmEvent) {
        const st = e.fsm?.state;
        if (order.fsmEvent === "flankOrder" && (st === "CHASE" || st === "ATTACK")) {
          // Section D #1718 — capture the squad id BEFORE calling
          // e.fsm.send("flankOrder") so the killfeed entry shows the
          // correct squad id even if the FSM transition clears squadRef
          // (e.g. the flanker's new state triggers a dissolve). The prior
          // code read `ex(e).squadRef` AFTER the send, which could be null
          // mid-transition → "SQUAD ?" corruption in the killfeed.
          const squadId = (ex(e).squadRef as Squad | null)?.id ?? "?";
          e.fsm?.send("flankOrder");
          ctx.addKillFeed({
            killer: `SQUAD ${squadId.toUpperCase()}`,
            victim: "Coordinated flank dispatched",
            weapon: "", headshot: false,
          });
        } else if (order.fsmEvent === "seekCover") {
          if (st === "CHASE" || st === "ATTACK" || st === "FLANK") {
            e.fsm?.send("seekCover");
          }
        }
      }
    }
    // Apply squad updates (recompute center + LKPP refresh).
    for (const upd of result.squadUpdates) {
      const squad = this.squads.find((s, i) => i + 1 === upd.squadId);
      if (!squad) continue;
      if (upd.dissolve) {
        for (const m of squad.members) {
          ex(m).squadRef = null;
          ex(m).squadRole = undefined;
          ex(m).squadFlankDispatched = false;
        }
        squad.dissolved = true;
        continue;
      }
      squad.centerX = upd.centerX;
      squad.centerZ = upd.centerZ;
      // LKPP refresh.
      if (upd.lkppRefresherId > 0) {
        const refresher = byId.get(upd.lkppRefresherId);
        if (refresher) {
          const lkpp = ctx.player.pos.clone();
          ex(refresher).squadLkpp = lkpp;
          ex(refresher).squadLkppTime = now;
          for (const m of squad.members) {
            if (m === refresher) continue;
            ex(m).squadLkpp = lkpp.clone();
            ex(m).squadLkppTime = now;
          }
        }
      }
    }
    // Prune dissolved squads.
    this.squads = this.squads.filter((s) => !s.dissolved);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Singleton accessor (the engine constructs one + wires it on ctx.ai.squads)
// ───────────────────────────────────────────────────────────────────────────

let _coordinator: SquadCoordinator | null = null;

/** Get the process-wide SquadCoordinator singleton. */
export function getSquadCoordinator(): SquadCoordinator {
  if (!_coordinator) _coordinator = new SquadCoordinator();
  return _coordinator;
}
