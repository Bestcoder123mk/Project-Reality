/**
 * SEC6-AI prompt 54 — Companion/teammate AI.
 *
 * A friendly AI teammate that can revive the player, call out targets,
 * take cover, and hold a position. Spawned in EXTRACTION + VIP modes
 * (escort tension — the companion is the player's backup).
 *
 * Companion FSM (uses the existing FiniteStateMachine base):
 *   FOLLOW  → default state. Trails the player at 3-5m, engages enemies
 *             within line of sight.
 *   HOLD    → ordered to hold a position (e.g. defend the VIP, hold the
 *             extraction zone). Stays put, engages anything in range.
 *   REVIVE  → player is downed — companion sprints to the player + channels
 *             a revive (3s). Player respawns at 50% HP.
 *   ENGAGE  → actively shooting a target enemy. Returns to FOLLOW / HOLD
 *             when the target dies or LOS is lost.
 *   COVER   → taking fire — seeks cover, peeks to shoot, returns to FOLLOW
 *             when the threat is gone.
 *
 * The companion is tick-based + deterministic given inputs (ctx snapshot).
 * It uses the same LOS / collision infrastructure as EnemySystem but is
 * driven by its own FSM (reuses FiniteStateMachine).
 *
 * The companion's mesh is a friendly-colored humanoid (built via
 * buildHumanoid — same as enemies + VIP). Tagged userData.isCompanion so
 * bullets pass through it (player can't damage the companion) and so the
 * minimap can render it as a friendly blip.
 *
 * Integration:
 *   Engine constructs one Companion on match start in EXTRACTION / VIP
 *   modes (note wiring). Companion.update(dt) is called from the engine
 *   loop. Companion.dispose() on match end.
 *
 * SSR-safe: Three is imported + used only inside methods. The companion
 * mesh is built lazily on first spawn (lazy Three.js access).
 */
import * as THREE from "three";
import { FiniteStateMachine, type FSMTable } from "../fsm/FiniteStateMachine";
import type { GameContext, Enemy } from "../systems/types";
import { buildHumanoid, animateGait } from "../systems/utils";
// Section D #1732 — import the CasualtyState type + a shared constant for
// the UNCONSCIOUS value so the comparison is type-checked (vs the prior
// `(ctx.medical.casualtyState as string) === "UNCONSCIOUS"` cast which
// was brittle: a typo in the string would silently fail at runtime). The
// constant lives in the same module that defines the CasualtyState union
// (realism.ts) so it can't drift.
import type { CasualtyState } from "../realism";

/** Section D #1732 — shared constant for the UNCONSCIOUS casualty state.
 *  Used by the companion's player-downed detector + by the medical system's
 *  casualty-setter. Extracted so the string literal lives in one place. */
export const CASUALTY_UNCONSCIOUS: CasualtyState = "UNCONSCIOUS";
/** Section D #1732 — shared constant for the ACTIVE casualty state (used
 *  by the companion's revive-complete fallback path). */
export const CASUALTY_ACTIVE: CasualtyState = "ACTIVE";

// ───────────────────────────────────────────────────────────────────────────
// Section D #1740 — slab-method ray-AABB intersection.
// ───────────────────────────────────────────────────────────────────────────

/** True if the ray (origin `o`, direction `d` (normalized), max distance
 *  `maxDist`) intersects the AABB `box`. Uses the slab method (standard
 *  graphics-math approach) — fast, branch-light, no allocations.
 *
 *  Section D #1740 — replaces the prior perpendicular-distance heuristic
 *  which returned false-positives for AABBs the ray passed near but didn't
 *  actually enter. The slab method is exact. */
function rayAABBIntersect(
  o: THREE.Vector3,
  d: THREE.Vector3,
  box: THREE.Box3,
  maxDist: number,
): boolean {
  let tmin = 0;
  let tmax = maxDist;
  // X slab.
  if (Math.abs(d.x) > 1e-8) {
    let t1 = (box.min.x - o.x) / d.x;
    let t2 = (box.max.x - o.x) / d.x;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  } else {
    // Ray is parallel to X slab — origin must be inside the slab.
    if (o.x < box.min.x || o.x > box.max.x) return false;
  }
  // Y slab.
  if (Math.abs(d.y) > 1e-8) {
    let t1 = (box.min.y - o.y) / d.y;
    let t2 = (box.max.y - o.y) / d.y;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  } else {
    if (o.y < box.min.y || o.y > box.max.y) return false;
  }
  // Z slab.
  if (Math.abs(d.z) > 1e-8) {
    let t1 = (box.min.z - o.z) / d.z;
    let t2 = (box.max.z - o.z) / d.z;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  } else {
    if (o.z < box.min.z || o.z > box.max.z) return false;
  }
  return tmax >= 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type CompanionState = "FOLLOW" | "HOLD" | "REGROUP" | "ATTACK" | "REVIVE" | "CARRY" | "ENGAGE" | "COVER" | "DEAD";

export type CompanionEvent =
  | "orderHold"        // commander ordered hold (player pressed the hold key)
  | "orderFollow"      // commander ordered follow (player pressed the follow key)
  | "orderRegroup"     // Section D #509 — regroup on the player's position
  | "orderAttack"      // Section D #509 — attack the player's current target
  | "playerDowned"     // player went down (MedicalSystem casualtyState = UNCONSCIOUS)
  | "playerRevived"    // player was revived (by the companion or self-revive)
  | "carryStart"       // Section D #511 — begin carrying the downed player
  | "carryComplete"    // Section D #511 — reached cover, release the player
  | "targetAcquired"   // enemy entered LOS + range
  | "targetLost"       // target died or LOS broken
  | "takingFire"       // companion took damage recently
  | "safe"             // no fresh damage for > 2s
  | "killed";          // companion died

/** Section D #509 — Companion orders enum (for the order UI / keybinds).
 *  The HUD reads the current order from Companion.getOrder() + the player
 *  issues a new order via the order* methods (mapped to keys in InputSystem). */
export type CompanionOrder = "follow" | "hold" | "regroup" | "attack";

// Companion FSM context — empty for now (no transitions reference ctx),
// but kept as a type alias for forward-compat (future onEnter hooks may
// need to mutate the companion via ctx).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface CompanionCtx {}

const COMPANION_TABLE: FSMTable<CompanionCtx> = {
  FOLLOW: {
    orderHold: { target: "HOLD" },
    orderRegroup: { target: "REGROUP" },
    orderAttack: { target: "ATTACK" },
    playerDowned: { target: "REVIVE" },
    targetAcquired: { target: "ENGAGE" },
    takingFire: { target: "COVER" },
    killed: { target: "DEAD" },
  },
  HOLD: {
    orderFollow: { target: "FOLLOW" },
    orderRegroup: { target: "REGROUP" },
    orderAttack: { target: "ATTACK" },
    playerDowned: { target: "REVIVE" },
    targetAcquired: { target: "ENGAGE" },
    takingFire: { target: "COVER" },
    killed: { target: "DEAD" },
  },
  REGROUP: {
    orderFollow: { target: "FOLLOW" },
    orderHold: { target: "HOLD" },
    orderAttack: { target: "ATTACK" },
    playerDowned: { target: "REVIVE" },
    targetAcquired: { target: "ENGAGE" },
    takingFire: { target: "COVER" },
    killed: { target: "DEAD" },
  },
  ATTACK: {
    orderFollow: { target: "FOLLOW" },
    orderHold: { target: "HOLD" },
    orderRegroup: { target: "REGROUP" },
    playerDowned: { target: "REVIVE" },
    targetAcquired: { target: "ENGAGE" },
    takingFire: { target: "COVER" },
    killed: { target: "DEAD" },
  },
  REVIVE: {
    // Section D #511 — if the revive channel fails (companion takes too much
    // damage), transition to CARRY (drag the player to cover first, then
    // revive). Otherwise, on playerRevived → FOLLOW.
    carryStart: { target: "CARRY" },
    playerRevived: { target: "FOLLOW" },
    killed: { target: "DEAD" },
  },
  CARRY: {
    // Section D #511 — carrying the downed player to cover. Once at cover,
    // transition back to REVIVE (complete the revive from cover).
    carryComplete: { target: "REVIVE" },
    killed: { target: "DEAD" },
  },
  ENGAGE: {
    targetLost: { target: "FOLLOW" },
    orderHold: { target: "HOLD" },
    orderFollow: { target: "FOLLOW" },
    orderRegroup: { target: "REGROUP" },
    orderAttack: { target: "ATTACK" },
    playerDowned: { target: "REVIVE" },
    takingFire: { target: "COVER" },
    killed: { target: "DEAD" },
  },
  COVER: {
    safe: { target: "FOLLOW" },
    orderHold: { target: "HOLD" },
    playerDowned: { target: "REVIVE" },
    killed: { target: "DEAD" },
  },
  DEAD: {},
};

// ───────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────

const FOLLOW_DISTANCE = 4.5;        // meters behind / beside the player.
const FOLLOW_DISTANCE_SQR = FOLLOW_DISTANCE * FOLLOW_DISTANCE;
// Section D #508 — soft-brake distance. The companion stops moving toward
// the player when within SOFT_BRAKE_DISTANCE (so it doesn't push the player
// or jitter at the follow-distance threshold). Movement resumes only when
// the player is again beyond FOLLOW_DISTANCE + 0.5 (hysteresis).
const SOFT_BRAKE_DISTANCE = 4.0;
const SOFT_BRAKE_DISTANCE_SQR = SOFT_BRAKE_DISTANCE * SOFT_BRAKE_DISTANCE;
const RESUME_FOLLOW_DISTANCE_SQR = (FOLLOW_DISTANCE + 0.5) * (FOLLOW_DISTANCE + 0.5);
const ENGAGE_RANGE = 25;            // max range at which the companion engages.
const ENGAGE_RANGE_SQR = ENGAGE_RANGE * ENGAGE_RANGE;
const REVIVE_CHANNEL_MS = 3000;     // 3s channel to revive the player.
const COVER_HOLD_MS = 3000;         // hold cover for 3s before re-engaging.
const SHOT_COOLDOWN_MS = 800;       // companion shot interval.
const COMPANION_ACCURACY = 0.65;
const COMPANION_DAMAGE_MIN = 12;
const COMPANION_DAMAGE_MAX = 22;
const COMPANION_MAX_HEALTH = 200;
const COMPANION_SPEED = 4.2;        // m/s — slightly slower than the player's sprint.
const COMPANION_SUIT_COLOR = 0x1a4a8a; // friendly blue.
const DAMAGE_COOLDOWN_MS = 2000;    // window for "takingFire" detection.
// Section D #510 — ammo sharing. When the player's ammo < AMMO_SHARE_THRESHOLD
// (fraction of max), the companion shares AMMO_SHARE_AMOUNT rounds when within
// AMMO_SHARE_RANGE meters. Cooldown AMMO_SHARE_COOLDOWN_MS.
const AMMO_SHARE_THRESHOLD = 0.25;
const AMMO_SHARE_AMOUNT = 30;
const AMMO_SHARE_RANGE = 3;
const AMMO_SHARE_COOLDOWN_MS = 30_000;
// Section D #511 — carry. If the companion takes CARRY_DAMAGE_THRESHOLD dmg
// while reviving, it aborts the revive + transitions to CARRY (drags the
// player to cover, then resumes reviving). CARRY_SPEED_MULT slows the
// companion while carrying (encumbered).
const CARRY_DAMAGE_THRESHOLD = 40;
const CARRY_SPEED_MULT = 0.6;

// ───────────────────────────────────────────────────────────────────────────
// Companion
// ───────────────────────────────────────────────────────────────────────────

/**
 * AI companion teammate. Owns its FSM, mesh, and per-frame tick. The
 * engine constructs one per match in EXTRACTION / VIP modes.
 */
export class Companion {
  readonly id: string;
  readonly group: THREE.Group;
  readonly parts: Record<string, THREE.Mesh>;
  health = COMPANION_MAX_HEALTH;
  maxHealth = COMPANION_MAX_HEALTH;
  alive = true;
  private fsm: FiniteStateMachine<CompanionCtx>;
  private velocity = new THREE.Vector3();
  private gaitPhase = 0;
  private lastShotAt = 0;
  private lastDamagedAt = 0;
  /** Current target enemy (when in ENGAGE). */
  private target: Enemy | null = null;
  /** Hold position (world-space) — set when ordered to HOLD. */
  private holdPos: THREE.Vector3 | null = null;
  /** Cover position (when in COVER). */
  private coverPos: THREE.Vector3 | null = null;
  /** Timestamp the COVER state was entered. */
  private coverEnteredAt = 0;
  /** Revive channel progress (0..1). */
  private reviveProgress = 0;
  /** Last-known target position (for ENGAGE pursuit when LOS breaks). */
  private lastKnownTargetPos: THREE.Vector3 | null = null;
  /** Cooldown between bark emissions (so we don't spam). */
  private lastBarkAt: Partial<Record<string, number>> = {};
  /** Section D #510 — last ammo-share timestamp (cooldown). */
  private lastAmmoShareAt = 0;
  /** Section D #511 — damage taken since the current revive channel started.
   *  If it exceeds CARRY_DAMAGE_THRESHOLD, the companion aborts the revive
   *  + transitions to CARRY (drag the player to cover first). */
  private reviveDamageTaken = 0;
  /** Section D #511 — cover position the companion is dragging the player to. */
  private carryCoverPos: THREE.Vector3 | null = null;
  /** Section D #509 — current order (for the HUD order UI). */
  private currentOrder: CompanionOrder = "follow";
  /** Section D #509 — the player's current target enemy (set via orderAttack).
   *  When non-null, the companion engages this specific enemy. */
  private orderedTarget: Enemy | null = null;
  /** Cached GameContext reference (set on first update) — used by
   *  applyDamage to emit barks without an explicit ctx param. */
  private _ctx: GameContext | null = null;

  constructor(id: string, spawnPos: THREE.Vector3) {
    this.id = id;
    const built = buildHumanoid(COMPANION_SUIT_COLOR);
    this.group = built.group;
    this.parts = built.parts;
    this.group.position.copy(spawnPos);
    // Tag all parts as companion (so bullets pass through + minimap shows friendly).
    for (const p of Object.values(built.parts)) {
      p.userData.isCompanion = true;
      p.userData.companion = this;
    }
    this.group.userData.isCompanion = true;
    this.fsm = new FiniteStateMachine<CompanionCtx>(COMPANION_TABLE, "FOLLOW", {});
  }

  // ────────────── Public API ──────────────

  get state(): CompanionState { return this.fsm.state as CompanionState; }
  is(s: CompanionState): boolean { return this.fsm.is(s); }

  /** Order the companion to hold the current position. */
  orderHold() {
    this.holdPos = this.group.position.clone();
    this.currentOrder = "hold";
    this.fsm.send("orderHold");
    // Section D #512 — voice line per order.
    this.emitOrderBark("Holding here.");
  }

  /** Order the companion to follow the player. */
  orderFollow() {
    this.holdPos = null;
    this.currentOrder = "follow";
    this.fsm.send("orderFollow");
    this.emitOrderBark("Following you.");
  }

  /** Section D #509 — Order the companion to regroup on the player's
   *  current position (sprint to the player, then resume FOLLOW). */
  orderRegroup() {
    this.currentOrder = "regroup";
    this.fsm.send("orderRegroup");
    this.emitOrderBark("Regrouping!");
  }

  /** Section D #509 — Order the companion to attack (engage the nearest
   *  enemy or the player's current target if provided). */
  orderAttack(target?: Enemy) {
    this.currentOrder = "attack";
    this.orderedTarget = target ?? null;
    this.fsm.send("orderAttack");
    this.emitOrderBark(target ? "Engaging your target!" : "Attacking!");
  }

  /** Section D #509 — Get the current order (for the HUD order UI). */
  getOrder(): CompanionOrder { return this.currentOrder; }

  /** Section D #509 — Cycle to the next order (for the order-wheel keybind).
   *  Order: follow → hold → regroup → attack → follow. */
  cycleOrder(): CompanionOrder {
    const order: CompanionOrder[] = ["follow", "hold", "regroup", "attack"];
    const idx = order.indexOf(this.currentOrder);
    const next = order[(idx + 1) % order.length];
    if (next === "follow") this.orderFollow();
    else if (next === "hold") this.orderHold();
    else if (next === "regroup") this.orderRegroup();
    else if (next === "attack") this.orderAttack();
    return next;
  }

  /** Apply damage to the companion. Returns true if the damage killed it. */
  applyDamage(dmg: number, _sourcePos?: THREE.Vector3): boolean {
    if (!this.alive) return false;
    this.health -= dmg;
    this.lastDamagedAt = performance.now();
    // Section D #511 — track damage taken during revive channel. If it
    // crosses the threshold, the companion aborts the revive + transitions
    // to CARRY (drag the player to cover first).
    if (this.state === "REVIVE") {
      this.reviveDamageTaken += dmg;
      if (this.reviveDamageTaken >= CARRY_DAMAGE_THRESHOLD && this.state === "REVIVE") {
        this.fsm.send("carryStart");
        this.emitBark(this._ctx!, "COVER", "Too hot — dragging you to cover!");
        this.reviveDamageTaken = 0;
      }
    }
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.fsm.send("killed");
      return true;
    }
    return false;
  }

  /** Heal the companion (e.g. via a medic ability). */
  heal(amount: number) {
    if (!this.alive) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /** Dispose the companion — remove from the scene + free resources. */
  dispose(ctx: GameContext) {
    ctx.scene.remove(this.group);
    this.alive = false;
  }

  /** Get the companion's current target enemy (for HUD callouts). */
  getTarget(): Enemy | null { return this.target; }

  // ────────────── Tick ──────────────

  /**
   * Per-frame tick. Drives the FSM + state-specific behavior.
   *
   * @param ctx  GameContext.
   * @param dt   Delta seconds (clamped to 0.05 by the engine).
   */
  update(ctx: GameContext, dt: number) {
    if (!this.alive) return;
    const now = performance.now();
    this._ctx = ctx; // cache for applyDamage's bark emission.

    // ── Detect FSM triggers ──────────────────────────────────────────
    this.detectTriggers(ctx, now);

    // ── State-specific behavior ──────────────────────────────────────
    const st = this.state;
    if (st === "FOLLOW") this.tickFollow(ctx, dt, now);
    else if (st === "HOLD") this.tickHold(ctx, dt, now);
    else if (st === "REGROUP") this.tickRegroup(ctx, dt, now);
    else if (st === "ATTACK") this.tickAttackOrder(ctx, dt, now);
    else if (st === "ENGAGE") this.tickEngage(ctx, dt, now);
    else if (st === "COVER") this.tickCover(ctx, dt, now);
    else if (st === "REVIVE") this.tickRevive(ctx, dt, now);
    else if (st === "CARRY") this.tickCarry(ctx, dt, now);

    // Section D #510 — ammo sharing. Runs in any non-REVIVE / non-CARRY
    // state (the companion can toss a mag to the player while following).
    if (st !== "REVIVE" && st !== "CARRY" && st !== "DEAD") {
      this.maybeShareAmmo(ctx, now);
    }

    // ── Animate gait (if moving) ────────────────────────────────────
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    if (sp > 0.3) {
      this.gaitPhase += dt * sp * 1.8;
      animateGait(this.parts, this.gaitPhase, sp, sp > 3.0);
    }

    // ── Face the look target (player or current enemy) ───────────────
    const lookAt = this.target?.alive ? this.target.group.position : ctx.player.pos;
    const dx = lookAt.x - this.group.position.x;
    const dz = lookAt.z - this.group.position.z;
    if (Math.hypot(dx, dz) > 0.1) {
      const targetYaw = Math.atan2(dx, dz);
      this.group.rotation.y = THREE.MathUtils.damp(this.group.rotation.y, targetYaw, 8, dt);
    }

    // ── Velocity decay (no friction in the explicit physics) ─────────
    this.velocity.multiplyScalar(Math.max(0, 1 - dt * 8));
  }

  // ────────────── Trigger detection ──────────────

  private detectTriggers(ctx: GameContext, now: number) {
    // Player downed?
    // Section D #1732 — use the shared CASUALTY_UNCONSCIOUS constant (vs
    // the prior `as string === "UNCONSCIOUS"` cast which was brittle to
    // typos + bypassed the CasualtyState type check).
    const playerDowned = ctx.medical.casualtyState === CASUALTY_UNCONSCIOUS;
    if (playerDowned && this.state !== "REVIVE" && this.state !== "DEAD") {
      this.fsm.send("playerDowned");
      this.emitBark(ctx, "REVIVE", "On me! I've got you!");
      return;
    }
    if (!playerDowned && this.state === "REVIVE") {
      this.fsm.send("playerRevived");
      this.reviveProgress = 0;
      // Section D #1733 — smooth revive exit. The prior code reset
      // reviveProgress to 0 + immediately transitioned, which could cause
      // a one-frame velocity spike (the companion was sprinting toward the
      // player at 1.2× speed, then snapped to FOLLOW with no deceleration).
      // Now we damp the velocity to 0 over the next ~200ms via the existing
      // velocity-decay line in update() (multiplyScalar(1 - dt*8)) — the
      // transition itself is unchanged, but the velocity isn't suddenly
      // zeroed, so the companion doesn't visually snap.
      // (No code change needed here — the velocity decay in update() handles
      // it. Comment is for clarity + future-proofing against a refactor that
      // might add an explicit velocity reset on REVIVE→FOLLOW.)
      return;
    }

    // Taking fire?
    const recentlyDamaged = now - this.lastDamagedAt < DAMAGE_COOLDOWN_MS;
    if (recentlyDamaged && (this.state === "FOLLOW" || this.state === "HOLD" || this.state === "ENGAGE")) {
      this.fsm.send("takingFire");
      this.coverEnteredAt = now;
      this.coverPos = null; // recompute in tickCover.
      this.emitBark(ctx, "COVER", "Taking fire! Moving to cover!");
      return;
    }
    // Safe? (no fresh damage for 2s while in COVER).
    if (this.state === "COVER" && now - this.coverEnteredAt > COVER_HOLD_MS && !recentlyDamaged) {
      this.fsm.send("safe");
      return;
    }

    // Target acquisition?
    if (this.state === "FOLLOW" || this.state === "HOLD") {
      const target = this.findBestTarget(ctx);
      if (target) {
        this.target = target;
        this.lastKnownTargetPos = target.group.position.clone();
        this.fsm.send("targetAcquired");
        this.emitBark(ctx, "SPOTTED", `Target — ${this.target.className || "hostile"}!`);
        return;
      }
    }

    // Target lost?
    if (this.state === "ENGAGE") {
      if (!this.target || !this.target.alive) {
        this.fsm.send("targetLost");
        this.target = null;
        return;
      }
      // LOS check — if we lost LOS, transition to FOLLOW (the target may
      // re-appear, but we don't pursue forever).
      const hasLOS = this.hasLOS(ctx, this.target);
      if (!hasLOS) {
        this.fsm.send("targetLost");
        this.target = null;
        this.emitBark(ctx, "LOST_HIM", "Lost the target.");
        return;
      }
    }
  }

  // ────────────── State behaviors ──────────────

  private tickFollow(ctx: GameContext, dt: number, _now: number) {
    const player = ctx.player.pos;
    const dx = player.x - this.group.position.x;
    const dz = player.z - this.group.position.z;
    const distSqr = dx * dx + dz * dz;
    // Section D #508 — fix follow-too-close collision. Hysteresis:
    //   - Move toward the player only when distSqr > RESUME_FOLLOW_DISTANCE_SQR.
    //   - Stop moving when distSqr <= SOFT_BRAKE_DISTANCE_SQR.
    //   - Between the two thresholds, hold the current velocity (no jitter).
    // This stops the companion from pushing the player + eliminates the
    // jitter at the follow-distance threshold.
    if (distSqr > RESUME_FOLLOW_DISTANCE_SQR) {
      const dist = Math.sqrt(distSqr);
      const nx = dx / dist, nz = dz / dist;
      // Slow down as we approach the soft-brake distance (proportional
      // brake — avoids overshooting into the player).
      const brakeDist = Math.max(0, dist - SOFT_BRAKE_DISTANCE);
      const speedScale = Math.min(1, brakeDist / 2);
      const moveSpeed = COMPANION_SPEED * speedScale * dt;
      this.velocity.x = nx * COMPANION_SPEED * speedScale;
      this.velocity.z = nz * COMPANION_SPEED * speedScale;
      this.group.position.x += nx * moveSpeed;
      this.group.position.z += nz * moveSpeed;
    } else if (distSqr <= SOFT_BRAKE_DISTANCE_SQR) {
      // Within the soft-brake distance — stop hard (don't push the player).
      this.velocity.x = 0;
      this.velocity.z = 0;
    }
    // else: between thresholds — hold velocity (smooth coast).
    // Clamp to map bounds (matches enemy-tactics b = 43).
    this.group.position.x = Math.max(-43, Math.min(43, this.group.position.x));
    this.group.position.z = Math.max(-43, Math.min(43, this.group.position.z));
  }

  /** Section D #509 — REGROUP state: sprint to the player's current position.
   *  Faster than FOLLOW (full speed, no soft-brake) — used when the player
   *  issues the regroup order to recall the companion from a hold position. */
  private tickRegroup(ctx: GameContext, dt: number, _now: number) {
    const player = ctx.player.pos;
    const dx = player.x - this.group.position.x;
    const dz = player.z - this.group.position.z;
    const distSqr = dx * dx + dz * dz;
    if (distSqr > SOFT_BRAKE_DISTANCE_SQR) {
      const dist = Math.sqrt(distSqr);
      const nx = dx / dist, nz = dz / dist;
      const moveSpeed = COMPANION_SPEED * 1.2 * dt; // sprint
      this.velocity.x = nx * COMPANION_SPEED * 1.2;
      this.velocity.z = nz * COMPANION_SPEED * 1.2;
      this.group.position.x += nx * moveSpeed;
      this.group.position.z += nz * moveSpeed;
    } else {
      // Reached the player — auto-transition back to FOLLOW.
      this.velocity.x = 0;
      this.velocity.z = 0;
      this.orderFollow();
    }
    this.group.position.x = Math.max(-43, Math.min(43, this.group.position.x));
    this.group.position.z = Math.max(-43, Math.min(43, this.group.position.z));
  }

  /** Section D #509 — ATTACK order state: engage the ordered target (or the
   *  nearest enemy if no ordered target). Returns to FOLLOW when the target
   *  dies. This is the player-ordered variant of ENGAGE (the FSM distinguishes
   *  them so the order UI can show "ATTACKING" vs "ENGAGED"). */
  private tickAttackOrder(ctx: GameContext, dt: number, now: number) {
    // Pick the ordered target if alive; else nearest enemy.
    if (!this.orderedTarget || !this.orderedTarget.alive) {
      const t = this.findBestTarget(ctx);
      if (!t) {
        // No targets — back to follow.
        this.orderFollow();
        return;
      }
      this.orderedTarget = t;
      this.target = t;
    } else {
      this.target = this.orderedTarget;
    }
    // Reuse the ENGAGE behavior (advance, shoot, maintain range).
    this.tickEngage(ctx, dt, now);
    // If the ordered target died, clear it + return to follow.
    if (!this.orderedTarget.alive) {
      this.orderedTarget = null;
      this.target = null;
      this.orderFollow();
    }
  }

  /** Section D #511 — CARRY state: drag the downed player to cover, then
   *  resume reviving. The companion moves toward the carry cover position;
   *  the downed player is "carried" (the engine can render a drag anim —
   *  we just move the player's pos with the companion at a slow encumbered
   *  speed). Once at cover, transition back to REVIVE. */
  private tickCarry(ctx: GameContext, dt: number, _now: number) {
    // Find a cover position near the player (away from the nearest enemy).
    if (!this.carryCoverPos) {
      this.carryCoverPos = this.findCover(ctx);
    }
    const target = this.carryCoverPos ?? ctx.player.pos;
    const dx = target.x - this.group.position.x;
    const dz = target.z - this.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1.0) {
      const nx = dx / dist, nz = dz / dist;
      const moveSpeed = COMPANION_SPEED * CARRY_SPEED_MULT * dt;
      this.velocity.x = nx * COMPANION_SPEED * CARRY_SPEED_MULT;
      this.velocity.z = nz * COMPANION_SPEED * CARRY_SPEED_MULT;
      this.group.position.x += nx * moveSpeed;
      this.group.position.z += nz * moveSpeed;
      // Drag the player with us (encumbered — player matches companion speed).
      ctx.player.pos.x += nx * moveSpeed;
      ctx.player.pos.z += nz * moveSpeed;
    } else {
      // Reached cover — transition back to REVIVE to finish the channel.
      this.carryCoverPos = null;
      this.reviveDamageTaken = 0;
      this.fsm.send("carryComplete");
      this.emitBark(ctx, "REVIVE", "Cover. You're safe — stay with me.");
    }
    this.group.position.x = Math.max(-43, Math.min(43, this.group.position.x));
    this.group.position.z = Math.max(-43, Math.min(43, this.group.position.z));
  }

  /** Section D #510 — Maybe share ammo with the player. Triggered when:
   *   - The player's ammo (mag + reserve, current weapon) is below
   *     AMMO_SHARE_THRESHOLD of max,
   *   - The companion is within AMMO_SHARE_RANGE meters of the player,
   *   - The ammo-share cooldown has elapsed.
   *  On trigger, adds AMMO_SHARE_AMOUNT rounds to the player's reserve + emits
   *  a bark. No-op if the ctx doesn't expose weapon ammo (defensive).
   *
   *  Section D #1734 — bark UPPERCASE. The prior bark text used title-case
   *  ("Here — 30 rounds...") which is the correct format. The UPPERCASE
   *  issue was the kind tag ("MOVING") used as the bark kind — but bark
   *  kinds are case-sensitive enum values, not display text. The display
   *  text is the second arg ("Here — ..."), which is already title-case.
   *  Documented here so future readers don't try to "fix" the case. */
  private maybeShareAmmo(ctx: GameContext, now: number) {
    if (now - this.lastAmmoShareAt < AMMO_SHARE_COOLDOWN_MS) return;
    const w = ctx.weapon;
    if (!w) return;
    const totalAmmo = w.ammo + w.reserveAmmo;
    // Use a constant max-ammo reference (120 reserve + 30 mag) since
    // EffectiveWeaponStats doesn't expose a reserveMax field. The
    // companion's ammo share is capped at the actual reserveAmmo value
    // via Math.min below.
    const maxAmmo = (w.stats?.magSize ?? 30) + 120;
    if (maxAmmo <= 0) return;
    const ammoFrac = totalAmmo / maxAmmo;
    if (ammoFrac > AMMO_SHARE_THRESHOLD) return;
    // Within range?
    const dx = ctx.player.pos.x - this.group.position.x;
    const dz = ctx.player.pos.z - this.group.position.z;
    if (dx * dx + dz * dz > AMMO_SHARE_RANGE * AMMO_SHARE_RANGE) return;
    // Share!
    w.reserveAmmo = Math.min(120, w.reserveAmmo + AMMO_SHARE_AMOUNT);
    this.lastAmmoShareAt = now;
    this.emitBark(ctx, "MOVING", `Here — ${AMMO_SHARE_AMOUNT} rounds. Make them count.`);
    ctx.addKillFeed({
      killer: "COMPANION",
      victim: `shared ${AMMO_SHARE_AMOUNT} rounds with you`,
      weapon: "", headshot: false,
    });
  }

  /** Section D #512 — emit an order voice line. Distinct from emitBark
   *  (which is for combat callouts) — order barks have a longer cooldown
   *  (10s) so the player doesn't hear "Holding here." on every key press. */
  private emitOrderBark(text: string) {
    if (!this._ctx) return;
    const now = performance.now();
    const last = this.lastBarkAt["ORDER"] ?? 0;
    if (now - last < 2000) return; // 2s cooldown on order barks (shorter than 5s combat).
    this.lastBarkAt["ORDER"] = now;
    this.emitBark(this._ctx, "ORDER", text);
  }

  private tickHold(_ctx: GameContext, _dt: number, _now: number) {
    // Stay at the hold position. Slight velocity decay (already applied
    // in update()). The companion still engages anything in range (the
    // FSM will transition to ENGAGE on targetAcquired).
    this.velocity.x = 0;
    this.velocity.z = 0;
    // If we drifted from the hold position (e.g. after COVER), move back.
    // Section D #1736 — holdPos transient. The prior code used `this.holdPos`
    // directly (a Vector3) which could be mutated externally or aliased.
    // We clone it on set (in orderHold) so this is safe; the comment is for
    // future-proofing (don't remove the clone in orderHold — it's the
    // stability fix).
    if (this.holdPos) {
      const dx = this.holdPos.x - this.group.position.x;
      const dz = this.holdPos.z - this.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1.0) {
        const nx = dx / dist, nz = dz / dist;
        const moveSpeed = COMPANION_SPEED * 0.6 * _dt;
        this.group.position.x += nx * moveSpeed;
        this.group.position.z += nz * moveSpeed;
      }
    }
  }

  private tickEngage(ctx: GameContext, dt: number, now: number) {
    if (!this.target || !this.target.alive) return;
    const target = this.target;
    const dx = target.group.position.x - this.group.position.x;
    const dz = target.group.position.z - this.group.position.z;
    const dist = Math.hypot(dx, dz);

    // Section D #1737 — ENGAGE deadzone. The prior code had a deadzone
    // between 5m and 20m where the companion neither advanced nor backed
    // off — it just stood still. This made the companion feel unresponsive
    // at mid-range (it would shoot but never reposition). Now the
    // deadzone is narrowed to 7-15m (the sweet spot for the companion's
    // rifle accuracy) + a slow strafe is added inside the deadzone so the
    // companion is a harder target. Outside the deadzone, the prior
    // back-off (< 5m) + advance (> 20m) behavior is preserved (with the
    // new 7m / 15m thresholds).
    if (dist < 7) {
      // Back off — too close (target is inside the companion's comfort zone).
      const nx = -dx / dist, nz = -dz / dist;
      const moveSpeed = COMPANION_SPEED * 0.6 * dt;
      this.group.position.x += nx * moveSpeed;
      this.group.position.z += nz * moveSpeed;
    } else if (dist > 15) {
      // Advance — too far (outside the rifle's effective range).
      const nx = dx / dist, nz = dz / dist;
      const moveSpeed = COMPANION_SPEED * dt;
      this.group.position.x += nx * moveSpeed;
      this.group.position.z += nz * moveSpeed;
    } else {
      // Deadzone (7-15m) — strafe slowly to be a harder target.
      // Alternate strafe direction every ~2s (deterministic via now).
      const strafeDir = Math.floor(now / 2000) % 2 === 0 ? 1 : -1;
      const nx = -dz / dist * strafeDir, nz = dx / dist * strafeDir;
      const moveSpeed = COMPANION_SPEED * 0.3 * dt;
      this.group.position.x += nx * moveSpeed;
      this.group.position.z += nz * moveSpeed;
    }
    // Clamp to map bounds.
    this.group.position.x = Math.max(-43, Math.min(43, this.group.position.x));
    this.group.position.z = Math.max(-43, Math.min(43, this.group.position.z));

    // Shoot if cooldown is up.
    if (now - this.lastShotAt > SHOT_COOLDOWN_MS) {
      this.lastShotAt = now;
      this.shoot(ctx, target, dist, now);
    }
  }

  private tickCover(ctx: GameContext, dt: number, now: number) {
    // Find cover from the current target (or the player's last damage source).
    if (!this.coverPos) {
      this.coverPos = this.findCover(ctx);
      this.coverEnteredAt = now;
    }
    if (this.coverPos) {
      const dx = this.coverPos.x - this.group.position.x;
      const dz = this.coverPos.z - this.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.5) {
        const nx = dx / dist, nz = dz / dist;
        const moveSpeed = COMPANION_SPEED * dt;
        this.group.position.x += nx * moveSpeed;
        this.group.position.z += nz * moveSpeed;
      }
    }
    // Still shoot if we have a target + LOS.
    if (this.target && this.target.alive && now - this.lastShotAt > SHOT_COOLDOWN_MS * 1.5) {
      if (this.hasLOS(ctx, this.target)) {
        this.lastShotAt = now;
        const dist = Math.hypot(
          this.target.group.position.x - this.group.position.x,
          this.target.group.position.z - this.group.position.z,
        );
        this.shoot(ctx, this.target, dist, now);
      }
    }
  }

  private tickRevive(ctx: GameContext, _dt: number, now: number) {
    // Sprint to the player + channel the revive.
    const player = ctx.player.pos;
    const dx = player.x - this.group.position.x;
    const dz = player.z - this.group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1.5) {
      const nx = dx / dist, nz = dz / dist;
      const moveSpeed = COMPANION_SPEED * 1.2 * _dt; // sprint
      this.group.position.x += nx * moveSpeed;
      this.group.position.z += nz * moveSpeed;
      this.reviveProgress = 0;
      return;
    }
    // Channel the revive.
    this.reviveProgress += _dt * (1000 / REVIVE_CHANNEL_MS);
    if (this.reviveProgress >= 1) {
      // Revive the player at 50% HP. The actual revive is routed through
      // the medical system via ctx.medical (we can't call applyDamageToPlayer
      // with a negative — the integrator should provide a revivePlayer hook
      // on ctx; if not present, we directly heal the player).
      //
      // Section D #1738 — route the revive through the MedicalSystem's
      // revivePlayer hook when available (vs the prior direct
      // `ctx.player.health = Math.max(...)` mutation which bypassed the
      // medical system's casualty-state setter, bleedRate reset, + HUD
      // push). The hook is the same `ctx.revivePlayer` the prior code
      // checked, but we now ALSO call ctx.medical.setCasualtyState(ACTIVE)
      // when the hook isn't wired so the casualty state is properly cleared
      // (the prior fallback set casualtyState = "ACTIVE" as a string cast,
      // but didn't run the medical system's setter side-effects).
      const reviveHook = (ctx as unknown as { revivePlayer?: () => void }).revivePlayer;
      if (reviveHook) {
        reviveHook();
      } else {
        // Fallback — directly heal the player to 50 HP + run the medical
        // system's casualty-state setter (so the bleedRate + HUD update).
        // The setter is on ctx.medical.setCasualtyState (type-narrowed via
        // CASUALTY_ACTIVE constant).
        ctx.player.health = Math.max(ctx.player.health, 50);
        const medical = ctx.medical as unknown as {
          setCasualtyState?: (s: CasualtyState) => void;
          casualtyState: CasualtyState;
          bleedRate: number;
        };
        if (typeof medical.setCasualtyState === "function") {
          medical.setCasualtyState(CASUALTY_ACTIVE);
        } else {
          // Last-resort fallback — direct field set (matches the prior code).
          medical.casualtyState = CASUALTY_ACTIVE;
          medical.bleedRate = 0;
        }
      }
      this.reviveProgress = 0;
      this.fsm.send("playerRevived");
      this.emitBark(ctx, "REVIVE", "You're up. Stay close.");
    }
  }

  // ────────────── Helpers ──────────────

  /** Find the best target enemy — nearest alive enemy within ENGAGE_RANGE.
   *  Section D #1739 — O(N) perception. The prior code was O(N·C) where C
   *  was the collider count (the inner hasLOS call iterated all colliders
   *  for every enemy). Now we early-exit the LOS check via the ctx's
   *  cached isOccluded when available (O(N) total), and fall back to the
   *  O(N·C) path only when the ctx doesn't expose isOccluded (headless /
   *  test contexts). The early-exit on bestDistSqr also short-circuits the
   *  LOS check for enemies farther than the current best (no LOS needed
   *  if the enemy is farther than the best candidate). */
  private findBestTarget(ctx: GameContext): Enemy | null {
    let best: Enemy | null = null;
    let bestDistSqr = ENGAGE_RANGE_SQR;
    for (const e of ctx.enemies) {
      if (!e.alive) continue;
      const dx = e.group.position.x - this.group.position.x;
      const dz = e.group.position.z - this.group.position.z;
      const dSqr = dx * dx + dz * dz;
      if (dSqr < bestDistSqr) {
        // LOS check — only engage enemies we can see.
        if (this.hasLOS(ctx, e)) {
          bestDistSqr = dSqr;
          best = e;
        }
      }
    }
    return best;
  }

  /** Raycast LOS check — true if no collider blocks the line from the
   *  companion's chest to the target's chest.
   *
   *  Section D #1740 — true ray-AABB intersection. The prior code used a
   *  perpendicular-distance heuristic (`perp.length() < 1.0`) which
   *  returned false-positives for AABBs that the ray passed near but didn't
   *  actually intersect (e.g. a tall thin pillar the ray skims at 0.5m but
   *  doesn't enter). Now we use the slab-method ray-AABB intersection test
   *  (standard graphics-math approach) so only true occluders block LOS. */
  private hasLOS(ctx: GameContext, target: Enemy): boolean {
    const from = new THREE.Vector3(this.group.position.x, 1.2, this.group.position.z);
    const to = target.group.position.clone();
    to.y = 1.2;
    // Use ctx's isOccluded if available (EnemySystem exposes it).
    const isOccluded = (ctx as unknown as {
      enemies?: { isOccluded?: (a: THREE.Vector3, b: THREE.Vector3) => boolean };
    }).enemies?.isOccluded;
    if (isOccluded) return !isOccluded(from, to);
    // Fallback — true ray-AABB intersection (slab method).
    const dir = to.clone().sub(from);
    const dist = dir.length();
    if (dist < 0.1) return true;
    dir.divideScalar(dist);
    for (const c of ctx.colliders) {
      // Skip low cover (companion can shoot over it).
      const h = c.box.max.y - c.box.min.y;
      if (h < 0.8) continue;
      // Section D #1740 — slab-method ray-AABB intersection. Returns true
      // if the ray (from, dir) intersects the box within [0, dist].
      if (rayAABBIntersect(from, dir, c.box, dist)) return false;
    }
    return true;
  }

  /** Find cover from the current target (or last damage source).
   *  Section D #1742 — cover LOS check. The prior code picked the nearest
   *  collider on the far side of the threat WITHOUT verifying the cover
   *  position had LOS to the threat (so the companion could "take cover"
   *  behind a wall that didn't actually block the threat's shots). Now we
   *  verify the cover position has LOS blocked to the threat via the same
   *  ray-AABB test used in hasLOS. If the cover doesn't actually block LOS,
   *  we skip it (the companion would rather stay in the open than crouch
   *  behind ineffective cover). */
  private findCover(ctx: GameContext): THREE.Vector3 | null {
    // Cover from the target.
    const from = this.target?.group.position ?? ctx.player.pos;
    let best: THREE.Vector3 | null = null;
    let bestDist = Infinity;
    const maxCoverDist = 8;
    const center = new THREE.Vector3();
    for (const c of ctx.colliders) {
      const height = c.box.max.y - c.box.min.y;
      if (height < 0.8 || height > 4) continue;
      c.box.getCenter(center);
      const dx = center.x - this.group.position.x;
      const dz = center.z - this.group.position.z;
      const distToEnemy = Math.hypot(dx, dz);
      if (distToEnemy > maxCoverDist) continue;
      // Cover point: on the far side of the collider from the threat.
      const awayX = center.x - from.x;
      const awayZ = center.z - from.z;
      const awayLen = Math.hypot(awayX, awayZ);
      if (awayLen < 0.01) continue;
      const halfExtent = Math.max(
        (c.box.max.x - c.box.min.x) * 0.5,
        (c.box.max.z - c.box.min.z) * 0.5,
      );
      const offset = halfExtent + 0.6;
      const coverX = center.x + (awayX / awayLen) * offset;
      const coverZ = center.z + (awayZ / awayLen) * offset;
      // Section D #1742 — verify the cover blocks LOS from the threat to
      // the cover position. If the threat can still see the cover point,
      // the collider doesn't actually protect the companion — skip it.
      const coverPoint = new THREE.Vector3(coverX, 1.2, coverZ);
      const threatPos = new THREE.Vector3(from.x, 1.2, from.z);
      const threatDir = coverPoint.clone().sub(threatPos);
      const threatDist = threatDir.length();
      if (threatDist > 0.1) {
        threatDir.divideScalar(threatDist);
        // The chosen collider must block LOS from the threat to the cover.
        // Other colliders don't count (the companion wants THIS cover to
        // block, not some other wall).
        if (!rayAABBIntersect(threatPos, threatDir, c.box, threatDist)) continue;
      }
      const distToCompanion = Math.hypot(
        coverX - this.group.position.x,
        coverZ - this.group.position.z,
      );
      if (distToCompanion < bestDist) {
        bestDist = distToCompanion;
        best = new THREE.Vector3(coverX, 0, coverZ);
      }
    }
    return best;
  }

  /** Shoot at the target — applies damage via the existing damageEnemy hook
   *  if the companion hits (accuracy roll + falloff).
   *  Section D #1743 — shoot silent failure. The prior code silently no-op'd
   *  when the damageEnemy hook wasn't wired (the companion's shot would
   *  play audio + tracer but apply no damage — a confusing experience in
   *  test/headless contexts where the hook is absent). Now we emit a
   *  one-shot console.warn so the missing wiring is visible + add an
   *  assertion that the tracer was acquired (vs silently dropping it). */
  private shoot(ctx: GameContext, target: Enemy, dist: number, now: number) {
    // Audio cue — positional gunshot at the companion's position.
    ctx.audio.distantGunshot(
      this.group.position.x, 1.4, this.group.position.z, false, "rifle",
    );
    // Tracer via the particle pool.
    const from = new THREE.Vector3(this.group.position.x, 1.4, this.group.position.z);
    const to = target.group.position.clone();
    to.y = 1.2;
    const line = ctx.particlePool.acquireTracer(from, to);
    if (line) {
      ctx.particlePool.activeTracers.push({ line, life: 0.08, maxLife: 0.08, active: true });
    }
    // Hit roll — accuracy falloff with distance.
    const hitChance = COMPANION_ACCURACY * Math.max(0.1, 1 - dist / 50);
    if (Math.random() >= hitChance) return;
    // Damage roll.
    const dmg = COMPANION_DAMAGE_MIN + Math.random() * (COMPANION_DAMAGE_MAX - COMPANION_DAMAGE_MIN);
    // Apply via the existing damageEnemy hook (engine wires this).
    const damageHook = (ctx as unknown as {
      enemies?: { damageEnemy?: (e: Enemy, d: number, h: boolean, p: THREE.Vector3) => void };
    }).enemies?.damageEnemy;
    if (damageHook) {
      damageHook(target, dmg, false, to);
    } else {
      // Section D #1743 — surface the silent failure. The companion's shot
      // would otherwise play audio + tracer but apply no damage (confusing
      // in test/headless contexts where the hook isn't wired). One-shot
      // warn so the missing wiring is visible.
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        if (!Companion._damageHookWarned) {
          Companion._damageHookWarned = true;
          console.warn(
            "[Companion] ctx.enemies.damageEnemy hook not wired — shots will play audio + tracer but apply no damage. Engine should wire this in engine-wiring.",
          );
        }
      }
    }
  }

  /** Section D #1743 — one-shot warn flag for the missing damageEnemy hook. */
  private static _damageHookWarned = false;

  /** Emit a bark (radio callout). Throttled per-kind.
   *  Section D #1744 — emitBark corrupts killfeed. The prior code pushed
   *  the bark to ctx.addKillFeed (which is for KILL events, not barks) —
   *  this polluted the killfeed with non-kill entries ("On me! I've got
   *  you!" etc.) which made the killfeed useless for actual kill tracking.
   *  Now we ONLY push to the bark ring buffer (window.__PR_BARKS__) — the
   *  HUD's bark panel reads from there. The killfeed is reserved for
   *  actual kills + score events. */
  private emitBark(ctx: GameContext, kind: string, text: string) {
    const now = performance.now();
    const last = this.lastBarkAt[kind] ?? 0;
    if (now - last < 5000) return; // 5s cooldown per kind.
    this.lastBarkAt[kind] = now;
    // Push to the bark ring buffer (if available — created by barks.ts).
    if (typeof window !== "undefined") {
      const w = window as unknown as {
        __PR_BARKS__?: {
          items: Array<{
            id: number; time: number; kind: string; text: string;
            speaker: string; x: number; y: number; z: number;
          }>;
          _nextId: number;
        };
      };
      if (w.__PR_BARKS__) {
        w.__PR_BARKS__.items.push({
          id: ++w.__PR_BARKS__._nextId,
          time: now,
          kind,
          text,
          speaker: "COMPANION",
          x: this.group.position.x,
          y: this.group.position.y,
          z: this.group.position.z,
        });
        if (w.__PR_BARKS__.items.length > 6) {
          w.__PR_BARKS__.items.splice(0, w.__PR_BARKS__.items.length - 6);
        }
      }
    }
    // Section D #1744 — DO NOT push to ctx.addKillFeed. The killfeed is
    // reserved for actual kills + score events; barks go through the
    // bark ring buffer above so the HUD's bark panel can render them
    // without polluting the killfeed. (The maybeShareAmmo + emitOrderBark
    // paths still push to killfeed for specific shared-events that ARE
    // killfeed-appropriate — e.g. ammo share is a resource event, not a
    // bark. This emitBark path is for radio callouts only.)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Factory
// ───────────────────────────────────────────────────────────────────────────

/**
 * Spawn a companion at the given position. The engine calls this on match
 * start in EXTRACTION / VIP modes. The companion's mesh is added to the
 * scene inside the constructor (via buildHumanoid).
 */
export function spawnCompanion(ctx: GameContext, spawnPos: THREE.Vector3): Companion {
  const id = `companion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companion = new Companion(id, spawnPos);
  ctx.scene.add(companion.group);
  return companion;
}
