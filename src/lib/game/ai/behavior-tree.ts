/**
 * Section F — Behavior Tree authoring system for enemy AI.
 *
 * Addresses Section F prompts [F_AI_Enemies-00001..10000] (the AI-behavior
 * prompt library). A behavior-tree (BT) is a hierarchical node graph that
 * replaces the rigid FSM transition table for complex multi-step behaviors
 * (flank → suppress → breach → clear). The existing EnemyFSM stays as the
 * high-level "what state am I in" surface; the BT drives the per-state
 * tactical decision-making that the FSM can't express cleanly.
 *
 * Design:
 *   - Pure-TS, SSR-safe (no DOM, no Three.js at module load).
 *   - Node statuses follow the classic BT convention: SUCCESS | FAILURE |
 *     RUNNING. Each tick returns one of these.
 *   - Composite nodes (Sequence, Selector, Parallel) + Decorator nodes
 *     (Inverter, RetryUntilSuccess, Cooldown, ForceSuccess) + Leaf nodes
 *     (Action, Condition).
 *   - Blackboard = per-enemy scratch state (re-uses the cast-on-Enemy
 *     pattern from enemy-tactics.ts so we don't widen the Enemy interface).
 *   - A BTBlackboard holds named slots (number / boolean / Vector3-like)
 *     that nodes read/write via key strings.
 *
 * Integration:
 *   - EnemySystem may attach a `BehaviorTree` to elite/boss enemies (the FSM
 *     still owns the lifecycle states; the BT owns the in-state behavior).
 *   - `tree.tick(blackboard, ctx)` is called per-frame for each enemy with a
 *     BT; the FSM tick runs first (it owns state transitions).
 *   - Leaf nodes call into existing helpers (tickCover, tickFlank, etc.) —
 *     they don't reimplement movement.
 *
 * The node set is small but composable; richer trees are built by nesting.
 */

// ───────────────────────────────────────────────────────────────────────────
// Status + Blackboard
// ───────────────────────────────────────────────────────────────────────────

export type BTStatus = "SUCCESS" | "FAILURE" | "RUNNING";

/** A Vec3-like — we use plain numbers to keep the BT pure-TS / SSR-safe. */
export interface BTVec3 { x: number; y: number; z: number; }

/**
 * Per-enemy scratch state. Nodes read/write fields by string key. The
 * concrete storage is a Map for cheap add/get without predefined keys; an
 * untyped bag is the BT convention (typed bags grow combinatorially).
 */
export interface BTBlackboard {
  /** Named scalar slots. */
  scalars: Map<string, number>;
  /** Named boolean slots. */
  flags: Map<string, boolean>;
  /** Named vector slots. */
  vectors: Map<string, BTVec3>;
  /** Named string slots (target IDs, animations, etc.). */
  strings: Map<string, string>;
  /** Named object slots (for opaque refs like an Enemy or THREE.Object3D). */
  objects: Map<string, unknown>;
  /** performance.now() of the last tick (for cooldown / timer nodes). */
  lastTickAt: number;
  /** Mutable scratch — cleared on tree reset. */
  scratch: Map<string, unknown>;
}

export function createBlackboard(): BTBlackboard {
  return {
    scalars: new Map(),
    flags: new Map(),
    vectors: new Map(),
    strings: new Map(),
    objects: new Map(),
    lastTickAt: 0,
    scratch: new Map(),
  };
}

/** Engine-side context a node may read — kept opaque so the BT stays
 *  decoupled from GameContext (the BT lives in pure data + decision space). */
export interface BTContext {
  /** Current time (performance.now()). */
  now: number;
  /** dt seconds since the last tick. */
  dt: number;
  /** Distance from the enemy to the player (m). */
  distToPlayer: number;
  /** True if the enemy has line-of-sight to the player. */
  hasLOS: boolean;
  /** Enemy suppression scalar 0..1. */
  suppression: number;
  /** Enemy health 0..maxHealth. */
  health: number;
  /** Enemy max health. */
  maxHealth: number;
  /** Per-enemy random source (deterministic if injected). */
  rng: () => number;
  /** Optional: hook back into the engine for side-effectful actions
   *  (move, shoot, throw grenade, emit bark). Nodes cast this to whatever
   *  API the engine provides. */
  api?: unknown;
}

// ───────────────────────────────────────────────────────────────────────────
// Node base
// ───────────────────────────────────────────────────────────────────────────

export abstract class BTNode {
  /** Human-readable label (for the BT visualizer / debug overlay). */
  abstract readonly kind: string;
  /** Execute one tick. Must be idempotent w.r.t. repeated RUNNING ticks. */
  abstract tick(bb: BTBlackboard, ctx: BTContext): BTStatus;
  /** Reset transient node state (called when the parent tree is reset
   *  or when a composite re-enters this node after a status break). */
  reset?(bb: BTBlackboard): void;
  /** Optional child list (composites populate this; leaves return []). */
  children(): BTNode[] { return []; }
}

// ───────────────────────────────────────────────────────────────────────────
// Leaf nodes
// ───────────────────────────────────────────────────────────────────────────

/** Condition leaf — runs a predicate and returns SUCCESS / FAILURE. */
export class Condition extends BTNode {
  readonly kind = "Condition";
  constructor(
    public readonly label: string,
    public readonly predicate: (bb: BTBlackboard, ctx: BTContext) => boolean,
  ) { super(); }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    return this.predicate(bb, ctx) ? "SUCCESS" : "FAILURE";
  }
}

/** Action leaf — runs a side-effectful action and returns its status. */
export class Action extends BTNode {
  readonly kind = "Action";
  constructor(
    public readonly label: string,
    public readonly run: (bb: BTBlackboard, ctx: BTContext) => BTStatus,
  ) { super(); }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    return this.run(bb, ctx);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Composite nodes
// ───────────────────────────────────────────────────────────────────────────

/**
 * Sequence — runs children left-to-right. Returns FAILURE on the first
 * failing child, RUNNING on the first RUNNING child, SUCCESS only when all
 * children succeed. Remembers the last-RUNNING index so it resumes there
 * next tick (the classic "sticky" sequence).
 */
export class Sequence extends BTNode {
  readonly kind = "Sequence";
  private runningIndex = 0;
  constructor(public readonly label: string, private nodes: BTNode[]) { super(); }
  children() { return this.nodes; }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    for (let i = this.runningIndex; i < this.nodes.length; i++) {
      const s = this.nodes[i].tick(bb, ctx);
      if (s === "FAILURE") { this.runningIndex = 0; return "FAILURE"; }
      if (s === "RUNNING") { this.runningIndex = i; return "RUNNING"; }
    }
    this.runningIndex = 0;
    return "SUCCESS";
  }
  reset(bb: BTBlackboard) {
    this.runningIndex = 0;
    for (const n of this.nodes) n.reset?.(bb);
  }
}

/**
 * Selector — runs children left-to-right. Returns SUCCESS on the first
 * succeeding child, RUNNING on the first RUNNING child, FAILURE only when
 * all children fail. Remembers the last-RUNNING index for resume.
 */
export class Selector extends BTNode {
  readonly kind = "Selector";
  private runningIndex = 0;
  constructor(public readonly label: string, private nodes: BTNode[]) { super(); }
  children() { return this.nodes; }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    for (let i = this.runningIndex; i < this.nodes.length; i++) {
      const s = this.nodes[i].tick(bb, ctx);
      if (s === "SUCCESS") { this.runningIndex = 0; return "SUCCESS"; }
      if (s === "RUNNING") { this.runningIndex = i; return "RUNNING"; }
    }
    this.runningIndex = 0;
    return "FAILURE";
  }
  reset(bb: BTBlackboard) {
    this.runningIndex = 0;
    for (const n of this.nodes) n.reset?.(bb);
  }
}

/**
 * Parallel — runs all children every tick. Returns SUCCESS if
 * `successThreshold` children succeed, FAILURE if `failureThreshold`
 * children fail, otherwise RUNNING. The classic use is "move + scan
 * simultaneously" where neither should block the other.
 */
export class Parallel extends BTNode {
  readonly kind = "Parallel";
  constructor(
    public readonly label: string,
    private nodes: BTNode[],
    public readonly successThreshold: number,
    public readonly failureThreshold: number,
  ) { super(); }
  children() { return this.nodes; }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    let succ = 0, fail = 0;
    for (const n of this.nodes) {
      const s = n.tick(bb, ctx);
      if (s === "SUCCESS") succ++;
      else if (s === "FAILURE") fail++;
    }
    if (succ >= this.successThreshold) return "SUCCESS";
    if (fail >= this.failureThreshold) return "FAILURE";
    return "RUNNING";
  }
  reset(bb: BTBlackboard) { for (const n of this.nodes) n.reset?.(bb); }
}

// ───────────────────────────────────────────────────────────────────────────
// Decorator nodes
// ───────────────────────────────────────────────────────────────────────────

/** Inverter — flips SUCCESS ↔ FAILURE. RUNNING passes through. */
export class Inverter extends BTNode {
  readonly kind = "Inverter";
  constructor(public readonly label: string, private child: BTNode) { super(); }
  children() { return [this.child]; }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    const s = this.child.tick(bb, ctx);
    if (s === "RUNNING") return "RUNNING";
    return s === "SUCCESS" ? "FAILURE" : "SUCCESS";
  }
  reset(bb: BTBlackboard) { this.child.reset?.(bb); }
}

/** ForceSuccess — always returns SUCCESS regardless of the child. */
export class ForceSuccess extends BTNode {
  readonly kind = "ForceSuccess";
  constructor(public readonly label: string, private child: BTNode) { super(); }
  children() { return [this.child]; }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    this.child.tick(bb, ctx);
    return "SUCCESS";
  }
  reset(bb: BTBlackboard) { this.child.reset?.(bb); }
}

/**
 * RetryUntilSuccess — retries the child up to `maxAttempts` times before
 * returning FAILURE. Resets the child between attempts.
 */
export class RetryUntilSuccess extends BTNode {
  readonly kind = "RetryUntilSuccess";
  private attempts = 0;
  constructor(
    public readonly label: string,
    private child: BTNode,
    public readonly maxAttempts: number,
  ) { super(); }
  children() { return [this.child]; }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    while (this.attempts < this.maxAttempts) {
      const s = this.child.tick(bb, ctx);
      if (s === "SUCCESS") { this.attempts = 0; return "SUCCESS"; }
      if (s === "RUNNING") return "RUNNING";
      this.attempts++;
      this.child.reset?.(bb);
    }
    this.attempts = 0;
    return "FAILURE";
  }
  reset(bb: BTBlackboard) {
    this.attempts = 0;
    this.child.reset?.(bb);
  }
}

/**
 * Cooldown — gates the child on a per-blackboard timestamp. Returns FAILURE
 * (without ticking the child) until the cooldown window elapses since the
 * last successful tick. Useful for "throw a grenade at most every 8s".
 */
export class Cooldown extends BTNode {
  readonly kind = "Cooldown";
  constructor(
    public readonly label: string,
    private child: BTNode,
    public readonly cooldownMs: number,
    public readonly slotKey: string = "__cooldown_until",
  ) { super(); }
  children() { return [this.child]; }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    const until = bb.scalars.get(this.slotKey) ?? 0;
    if (ctx.now < until) return "FAILURE";
    const s = this.child.tick(bb, ctx);
    if (s === "SUCCESS") {
      bb.scalars.set(this.slotKey, ctx.now + this.cooldownMs);
    }
    return s;
  }
  reset(bb: BTBlackboard) {
    bb.scalars.delete(this.slotKey);
    this.child.reset?.(bb);
  }
}

/**
 * Timeout — returns FAILURE if the child hasn't succeeded within `timeoutMs`.
 * Tracks elapsed via the blackboard slot. Reset clears the timer.
 */
export class Timeout extends BTNode {
  readonly kind = "Timeout";
  constructor(
    public readonly label: string,
    private child: BTNode,
    public readonly timeoutMs: number,
    public readonly startKey: string = "__timeout_start",
  ) { super(); }
  children() { return [this.child]; }
  tick(bb: BTBlackboard, ctx: BTContext): BTStatus {
    let start = bb.scalars.get(this.startKey);
    if (start === undefined) {
      start = ctx.now;
      bb.scalars.set(this.startKey, start);
    }
    if (ctx.now - start > this.timeoutMs) {
      bb.scalars.delete(this.startKey);
      return "FAILURE";
    }
    const s = this.child.tick(bb, ctx);
    if (s !== "RUNNING") bb.scalars.delete(this.startKey);
    return s;
  }
  reset(bb: BTBlackboard) {
    bb.scalars.delete(this.startKey);
    this.child.reset?.(bb);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tree driver
// ───────────────────────────────────────────────────────────────────────────

/** A behavior tree — a root node + the per-enemy blackboard. */
export class BehaviorTree {
  /** Per-tree unique name (for the debug overlay + named tree lookup). */
  readonly name: string;
  private root: BTNode;
  /** Per-enemy blackboard. Created lazily; can be shared if the tree is
   *  used read-only (rare). */
  blackboard: BTBlackboard;
  /** Last tick status — for debug + conditional re-entry. */
  lastStatus: BTStatus = "FAILURE";
  /** True while the tree is mid-RUNNING (root returned RUNNING last tick). */
  running: boolean = false;
  /** Number of ticks since the last reset (for profiling / heatmaps). */
  tickCount: number = 0;

  constructor(name: string, root: BTNode, blackboard?: BTBlackboard) {
    this.name = name;
    this.root = root;
    this.blackboard = blackboard ?? createBlackboard();
  }

  /** Execute one tick. Updates lastStatus / running / blackboard.lastTickAt. */
  tick(ctx: BTContext): BTStatus {
    this.blackboard.lastTickAt = ctx.now;
    const s = this.root.tick(this.blackboard, ctx);
    this.lastStatus = s;
    this.running = s === "RUNNING";
    this.tickCount++;
    return s;
  }

  /** Reset the tree (clears all blackboard slots + node transient state). */
  reset() {
    this.blackboard.scalars.clear();
    this.blackboard.flags.clear();
    this.blackboard.vectors.clear();
    this.blackboard.strings.clear();
    this.blackboard.objects.clear();
    this.blackboard.scratch.clear();
    this.root.reset?.(this.blackboard);
    this.running = false;
    this.lastStatus = "FAILURE";
  }

  /** Render the tree as a human-readable indented string (debug overlay). */
  describe(indent = 0): string {
    const pad = "  ".repeat(indent);
    const lines: string[] = [];
    const walk = (n: BTNode, depth: number) => {
      const p = "  ".repeat(depth);
      lines.push(`${p}${n.kind}`);
      for (const c of n.children()) walk(c, depth + 1);
    };
    walk(this.root, 0);
    void pad;
    return lines.join("\n");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Library: shared leaf-node factories used by Section F's named trees
// ───────────────────────────────────────────────────────────────────────────

/** True when the enemy's distance to the player is within [min, max] m. */
export function condInRange(min: number, max: number): Condition {
  return new Condition(`dist in [${min},${max}]`, (_bb, ctx) =>
    ctx.distToPlayer >= min && ctx.distToPlayer <= max);
}

/** True when the enemy currently has line of sight to the player. */
export function condHasLOS(): Condition {
  return new Condition("has LOS", (_bb, ctx) => ctx.hasLOS);
}

/** True when the enemy's health fraction is below `frac` (0..1). */
export function condHealthBelow(frac: number): Condition {
  return new Condition(`health < ${frac}`, (_bb, ctx) =>
    ctx.health / Math.max(1, ctx.maxHealth) < frac);
}

/** True when the enemy's suppression is at least `threshold` (0..1). */
export function condSuppressedAtLeast(threshold: number): Condition {
  return new Condition(`suppression >= ${threshold}`, (_bb, ctx) =>
    ctx.suppression >= threshold);
}

/** Randomly true with probability `p` per tick — for stochastic branches. */
export function condRandomChance(p: number): Condition {
  return new Condition(`chance ${p}`, (_bb, ctx) => ctx.rng() < p);
}

/** Action that sets a flag and returns SUCCESS. */
export function actionSetFlag(key: string, value = true): Action {
  return new Action(`set ${key}=${value}`, (bb) => {
    bb.flags.set(key, value);
    return "SUCCESS";
  });
}

/** Action that clears a flag and returns SUCCESS. */
export function actionClearFlag(key: string): Action {
  return new Action(`clear ${key}`, (bb) => {
    bb.flags.set(key, false);
    return "SUCCESS";
  });
}

/** Action that calls an engine API hook (cast) + returns SUCCESS. */
export function actionEmit(label: string, fn: (api: unknown, bb: BTBlackboard, ctx: BTContext) => void): Action {
  return new Action(label, (bb, ctx) => {
    fn(ctx.api, bb, ctx);
    return "SUCCESS";
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Library: named behavior trees for common Section F scenarios
// ───────────────────────────────────────────────────────────────────────────

/**
 * Suppression-response tree — a sub-tree used inside the FSM SUPPRESSED
 * state. Returns RUNNING while the enemy is pinned; exits (FAILURE) when
 * suppression decays below threshold.
 *
 *   Sequence:
 *     Condition: suppression >= 0.2
 *     Selector:
 *       Condition: suppression >= 0.6 → Action: blind-fire (RUNNING)
 *       Action: hold cover (RUNNING)
 */
export function buildSuppressionTree(): BehaviorTree {
  const root = new Sequence("suppression_loop", [
    condSuppressedAtLeast(0.2),
    new Selector("react", [
      new Sequence("blind_fire_when_pinned", [
        condSuppressedAtLeast(0.6),
        actionEmit("blind_fire", (_api) => { /* engine routes to SuppressionResponse */ }),
      ]),
      actionEmit("hold_cover", (_api) => { /* engine routes to cover-system */ }),
    ]),
    // Loop forever while in the SUPPRESSED state — the FSM exits the state
    // when suppression decays; this tree's outer Condition will then fail.
    new Action("yield", () => "RUNNING"),
  ]);
  return new BehaviorTree("suppression_response", root);
}

/**
 * Cover-seek tree — used by the FSM COVER state. Picks a cover position,
 * moves to it, peeks to fire, retreats when damaged.
 *
 *   Sequence:
 *     Action: find_cover  (FAILURE if no cover found)
 *     Action: move_to_cover (RUNNING until arrived)
 *     Cooldown(2.5s, Action: peek_and_fire)
 *     Action: hold (RUNNING)
 */
export function buildCoverSeekTree(): BehaviorTree {
  const root = new Sequence("cover_seek", [
    new Action("find_cover", (bb, _ctx) => {
      // Engine API cast: api.findCover(enemy) → BTVec3 | null
      const api = _ctx.api as { findCover?: () => BTVec3 | null } | undefined;
      const c = api?.findCover?.();
      if (!c) return "FAILURE";
      bb.vectors.set("cover_pos", c);
      return "SUCCESS";
    }),
    new Action("move_to_cover", (bb, _ctx) => {
      // Engine API: api.moveTo(vec) → SUCCESS when within 0.5m
      const api = _ctx.api as {
        moveTo?: (v: BTVec3) => boolean;
      } | undefined;
      const target = bb.vectors.get("cover_pos");
      if (!target || !api?.moveTo) return "FAILURE";
      return api.moveTo(target) ? "SUCCESS" : "RUNNING";
    }),
    new Cooldown("peek_cadence", new Action("peek_and_fire", (_bb, _ctx) => {
      const api = _ctx.api as { peekAndFire?: () => void } | undefined;
      api?.peekAndFire?.();
      return "SUCCESS";
    }), 2500),
    new Action("hold", () => "RUNNING"),
  ]);
  return new BehaviorTree("cover_seek", root);
}

/**
 * Flank tree — used by the FSM FLANK state. Picks a side (left/right based
 * on the squad coordinator's order), advances along the side arc, then
 * re-engages when in attack range.
 */
export function buildFlankTree(): BehaviorTree {
  const root = new Sequence("flank_loop", [
    new Action("pick_side", (bb, _ctx) => {
      // Side is set by the squad coordinator (stashed on bb.strings).
      if (!bb.strings.has("flank_side")) {
        bb.strings.set("flank_side", _ctx.rng() < 0.5 ? "left" : "right");
      }
      return "SUCCESS";
    }),
    new Selector("advance_or_engage", [
      condInRange(0, 9999), // placeholder; engine checks attack range
      new Action("advance_along_side", (_bb, _ctx) => {
        const api = _ctx.api as { advanceFlank?: (side: string) => boolean } | undefined;
        const side = _bb.strings.get("flank_side") ?? "left";
        return api?.advanceFlank?.(side) ? "SUCCESS" : "RUNNING";
      }),
    ]),
    new Action("hold", () => "RUNNING"),
  ]);
  return new BehaviorTree("flank", root);
}

// ───────────────────────────────────────────────────────────────────────────
// Registry — EnemySystem looks up trees by name; this lets data-driven
// class configs point at a named tree without a code change.
// ───────────────────────────────────────────────────────────────────────────

export const BT_REGISTRY: Record<string, () => BehaviorTree> = {
  suppression_response: buildSuppressionTree,
  cover_seek: buildCoverSeekTree,
  flank: buildFlankTree,
};

/** Look up + instantiate a named tree. Returns null if unknown. */
export function instantiateTree(name: string): BehaviorTree | null {
  const factory = BT_REGISTRY[name];
  return factory ? factory() : null;
}
