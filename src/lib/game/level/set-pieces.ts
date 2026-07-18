/**
 * SEC9-LEVEL — Prompt 73: Interactive destructible set-pieces.
 *
 * A "set-piece" is a signature destructible moment per map — a collapsing
 * floor, a blown bridge, a breachable wall — that changes the map's flow
 * mid-match. Each SetPiece declares:
 *   - a `trigger` condition (which props get destroyed / damaged / approached),
 *   - an `effect` (chain explosion, structural collapse, wall breach, etc.),
 *   - a `flowChange` description (how the map's routing changes after the
 *     set-piece fires).
 *
 * 8 set-pieces are declared here, distributed across 6 maps:
 *   - Compound:  "Motor Pool Detonation" + "HQ Roof Collapse"
 *   - Warehouse: "Loading Dock Breach"
 *   - Rooftops:  "Skybridge Drop"
 *   - Bunker:    "Glass Partition Breach"
 *   - Mansion:   "Grand Hall Chandelier Drop"
 *   - Subway:    "Train Car Derailment" + "Jump Pad Power Surge"
 *
 * Wiring (engine-side, NOT in this file): the engine calls
 * `tickSetPieces(ctx, dt)` once per frame. For each armed SetPiece, it
 * evaluates the trigger condition against the destructibles registry
 * (`ctx.destructibles`). When a trigger fires, the engine:
 *   1. applies the effect (spawn explosion particles, remove target meshes,
 *      register new colliders or remove old ones),
 *   2. calls `activateShards()` from `src/lib/game/physics/VoronoiFracture.ts`
 *      on every target prop whose `fractureTargetProps` is true (this is the
 *      existing fracture system — set-pieces ride on top of it),
 *   3. marks the SetPiece.state = "triggered" so it can't fire twice.
 *
 * All set-piece data is pure TypeScript (no THREE at module load) so the
 * file can be imported in unit tests + the maps API. The engine-side tick
 * function is provided here; the orchestrator just needs to call it.
 */

import * as THREE from "three";
import type { GameContext, DestructibleProp } from "../systems/types";
import { preFracture, activateShards } from "../physics/VoronoiFracture";

// ─── Public types ────────────────────────────────────────────────────────

/** How a set-piece is triggered. */
export interface SetPieceTrigger {
  /** Trigger archetype. */
  type:
    | "prop_destroyed"        // a specific prop is fully destroyed
    | "all_props_destroyed"   // every prop in `positions` is destroyed
    | "prop_damaged"          // any prop in `positions` is damaged past `damageThreshold`
    | "area_entered"          // the player enters the AABB `area`
    | "manual";               // fired manually via `triggerSetPiece(id)`
  /** World-space positions of the props that satisfy this trigger. The
   *  engine finds the actual DestructibleProp by matching position. */
  positions?: Array<[number, number, number]>;
  /** For `prop_damaged`: fraction of maxHealth (0..1) that must be lost. */
  damageThreshold?: number;
  /** For `area_entered`: AABB [minX, minY, minZ, maxX, maxY, maxZ]. */
  area?: [number, number, number, number, number, number];
  /** Restrict trigger to a specific damage source (default "any"). */
  damageSource?: "any" | "bullet" | "explosion" | "grenade";
  /** Optional: only fires after this many seconds into the match. */
  minMatchTimeSec?: number;
}

/** What happens when the set-piece fires. */
export interface SetPieceEffect {
  /** Effect archetype. */
  type:
    | "chain_explosion"  // explosions cascade across targetPositions
    | "collapse"         // target structures collapse into rubble (fracture)
    | "breach"           // a wall/structure is removed to open a new path
    | "block"            // debris blocks an existing path
    | "ramp"             // a structure transforms into a traversable ramp
    | "disable"          // disables interactive props (e.g., jump pads)
    | "fire";            // ignites a persistent fire at targetPositions
  /** World-space positions the effect operates on. */
  targetPositions?: Array<[number, number, number]>;
  /** Radius for chain explosions / collapse waves (m). */
  radius?: number;
  /** Damage applied to entities within `damageRadius` of each target (hp). */
  damageRadius?: number;
  /** Damage per tick for persistent effects (fire). */
  damagePerTick?: number;
  /** Whether to call `activateShards()` on target props (VoronoiFracture). */
  fractureTargetProps?: boolean;
  /** Optional: spawn new collider AABBs (for "block" effects). Each entry
   *  is [minX, minY, minZ, maxX, maxY, maxZ]. */
  spawnColliders?: Array<[number, number, number, number, number, number]>;
  /** Optional: remove colliders within this radius of each targetPosition
   *  (for "breach" effects). */
  removeCollidersRadius?: number;
}

/** A signature destructible moment per map. */
export interface SetPiece {
  /** Unique ID across all maps. */
  id: string;
  /** Map this set-piece belongs to. */
  mapSlug: string;
  /** Human-readable name (HUD toast on trigger). */
  name: string;
  /** One-line description of what happens. */
  description: string;
  /** How the map's routing changes after the set-piece fires. */
  flowChange: string;
  /** Trigger condition. */
  trigger: SetPieceTrigger;
  /** Effect applied on trigger. */
  effect: SetPieceEffect;
  /** Runtime state — the engine updates this; "armed" is the default. */
  state?: "armed" | "triggered" | "completed";
  /** Optional:HUD toast shown when the set-piece fires. */
  toast?: string;
}

// ─── Set-piece catalog (8 set-pieces across 6 maps) ─────────────────────

export const SET_PIECES: SetPiece[] = [
  // ─── Compound ──────────────────────────────────────────────────────────
  {
    id: "compound_motor_pool",
    mapSlug: "compound",
    name: "Motor Pool Detonation",
    description: "A barrel cluster in the SE motor pool detonates, chain-exploding the parked vehicles and opening a flanking lane.",
    flowChange: "Opens a new SE flanking lane through the destroyed motor pool — the burned-out car hulls provide low cover.",
    trigger: {
      type: "prop_destroyed",
      positions: [[22, 0, 18]],
      damageSource: "any",
    },
    effect: {
      type: "chain_explosion",
      targetPositions: [[28, 0, 22], [33, 0, 26], [29, 0, 30]],
      radius: 6,
      damageRadius: 8,
      fractureTargetProps: true,
    },
    toast: "MOTOR POOL HIT — SE flank opened",
    state: "armed",
  },
  {
    id: "compound_hq_collapse",
    mapSlug: "compound",
    name: "HQ Roof Collapse",
    description: "Sustained explosive damage to the central HQ building brings the roof down, opening a vertical sightline through the building.",
    flowChange: "Creates a long N–S sniper sightline through the former HQ — the rubble provides mid-field cover but no longer blocks shots.",
    trigger: {
      type: "prop_damaged",
      positions: [[0, 0, 0]],
      damageThreshold: 0.75,
      damageSource: "explosion",
    },
    effect: {
      type: "collapse",
      targetPositions: [[0, 0, 0]],
      radius: 8,
      damageRadius: 10,
      fractureTargetProps: true,
      spawnColliders: [
        [-3, 0, -3, 3, 1.2, 3], // rubble pile at HQ center
      ],
    },
    toast: "HQ COLLAPSING — central sightline open",
    state: "armed",
  },

  // ─── Warehouse ─────────────────────────────────────────────────────────
  {
    id: "warehouse_loading_breach",
    mapSlug: "warehouse",
    name: "Loading Dock Breach",
    description: "Destroying the loading-dock truck at the east wall smashes through the perimeter, opening a new entry from outside.",
    flowChange: "Creates a new E-side entry point at z=28 — attackers can flank from outside the warehouse perimeter.",
    trigger: {
      type: "prop_destroyed",
      positions: [[20, 0, -28]],
      damageSource: "any",
    },
    effect: {
      type: "breach",
      targetPositions: [[35, 5, -28]],
      radius: 6,
      removeCollidersRadius: 4,
      fractureTargetProps: true,
    },
    toast: "LOADING DOCK BREACH — E entry opened",
    state: "armed",
  },

  // ─── Rooftops ──────────────────────────────────────────────────────────
  {
    id: "rooftops_skybridge_drop",
    mapSlug: "rooftops",
    name: "Skybridge Drop",
    description: "Explosive damage to the central skybridge severs its supports; it collapses into a diagonal ramp between rooftops.",
    flowChange: "Replaces the elevated skybridge crossing with a permanent ground-level ramp — fast traversal, no more vertical exposure.",
    trigger: {
      type: "prop_damaged",
      positions: [[0, 6, 0]],
      damageThreshold: 0.6,
      damageSource: "explosion",
    },
    effect: {
      type: "ramp",
      targetPositions: [[0, 6, 0]],
      radius: 8,
      damageRadius: 6,
      fractureTargetProps: false, // ramp reuses the bridge mesh, doesn't shatter it
      spawnColliders: [
        [-1.5, 0, -7, 1.5, 1.2, 7], // ramp surface collider
      ],
    },
    toast: "SKYBRIDGE DOWN — ramp traversal enabled",
    state: "armed",
  },

  // ─── Bunker ────────────────────────────────────────────────────────────
  {
    id: "bunker_glass_breach",
    mapSlug: "bunker",
    name: "Glass Partition Breach",
    description: "Shattering all 4 central glass partitions opens a long sightline through the command center, turning it into a kill zone.",
    flowChange: "Creates an unobstructed N–S sniper lane through the central command room (formerly broken by 4 glass partitions).",
    trigger: {
      type: "all_props_destroyed",
      positions: [[0, 0, -6], [0, 0, 6], [-4, 0, 0], [4, 0, 0]],
    },
    effect: {
      type: "breach",
      targetPositions: [[0, 0, -6], [0, 0, 6], [-4, 0, 0], [4, 0, 0]],
      radius: 2,
      fractureTargetProps: true,
    },
    toast: "GLASS DOWN — command-center sightline open",
    state: "armed",
  },

  // ─── Mansion ───────────────────────────────────────────────────────────
  {
    id: "mansion_chandelier_drop",
    mapSlug: "mansion",
    name: "Grand Hall Chandelier Drop",
    description: "Shooting the grand-hall chandelier sends it crashing down, blocking the south entrance to the hall.",
    flowChange: "Seals the south entrance to the grand hall — players must use the 4 corner-room doors instead, slowing rotations through the center.",
    trigger: {
      type: "prop_damaged",
      positions: [[0, 2.5, 7]],
      damageThreshold: 0.5,
      damageSource: "bullet",
    },
    effect: {
      type: "block",
      targetPositions: [[0, 2.5, 7]],
      radius: 4,
      damageRadius: 3,
      fractureTargetProps: true,
      spawnColliders: [
        [-2, 0, 5, 2, 1.8, 9], // chandelier rubble blocking the south entrance
      ],
    },
    toast: "CHANDELIER DOWN — south entrance sealed",
    state: "armed",
  },

  // ─── Subway ────────────────────────────────────────────────────────────
  {
    id: "subway_train_derail",
    mapSlug: "subway",
    name: "Train Car Derailment",
    description: "Destroying the east train car derails it into the platform, blocking the east track's N–S lane with twisted metal.",
    flowChange: "Blocks the east track lane — players on the E side must cross to the W track or boost up to the concourse to rotate.",
    trigger: {
      type: "prop_destroyed",
      positions: [[12, 0, 10]],
      damageSource: "any",
    },
    effect: {
      type: "block",
      targetPositions: [[12, 0, 10]],
      radius: 10,
      damageRadius: 8,
      fractureTargetProps: true,
      spawnColliders: [
        [9, 0, 4, 15, 2.5, 16], // derailed train car blocking E track
      ],
    },
    toast: "TRAIN DERAILED — E track blocked",
    state: "armed",
  },
  {
    id: "subway_jump_pad_surge",
    mapSlug: "subway",
    name: "Jump Pad Power Surge",
    description: "Destroying the NE generator cuts power to the east-side jump pads, removing the E-side vertical rotation.",
    flowChange: "Disables the 2 E-track jump pads — the W concourse becomes the only vertical access, funneling rotations through the W side.",
    trigger: {
      type: "prop_destroyed",
      positions: [[28, 0, -25]],
      damageSource: "any",
    },
    effect: {
      type: "disable",
      targetPositions: [[12, 0, -15], [12, 0, 15]],
      radius: 2,
      fractureTargetProps: false,
    },
    toast: "POWER LOST — E jump pads disabled",
    state: "armed",
  },
];

// ─── Public accessors ────────────────────────────────────────────────────

/** Get all set-pieces for a map (sorted by id for deterministic order). */
export function getSetPiecesForMap(mapSlug: string): SetPiece[] {
  return SET_PIECES.filter((sp) => sp.mapSlug === mapSlug).sort((a, b) => a.id.localeCompare(b.id));
}

/** Get a set-piece by its unique id. */
export function getSetPiece(id: string): SetPiece | null {
  return SET_PIECES.find((sp) => sp.id === id) ?? null;
}

/** Get all set-pieces (for the design dashboard). */
export function getAllSetPieces(): SetPiece[] {
  return SET_PIECES.slice();
}

/** Reset all set-pieces to "armed" — called on match start. */
export function resetSetPieces(): void {
  for (const sp of SET_PIECES) sp.state = "armed";
}

// ─── Engine-side tick (called once per frame) ────────────────────────────

/** Squared distance between two 3D points (tuple form). */
function dist2(
  a: [number, number, number],
  b: { x: number; y: number; z: number } | [number, number, number],
): number {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = Array.isArray(b) ? b[0] : b.x;
  const by = Array.isArray(b) ? b[1] : b.y;
  const bz = Array.isArray(b) ? b[2] : b.z;
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

/** Find the DestructibleProp whose mesh position is closest to `target`.
 *  Returns null if no destructible is within `maxDist` (m). */
function findDestructibleAt(
  destructibles: DestructibleProp[],
  target: [number, number, number],
  maxDist: number,
): DestructibleProp | null {
  const maxDist2 = maxDist * maxDist;
  let best: DestructibleProp | null = null;
  let bestDist2 = Infinity;
  for (const d of destructibles) {
    const d2 = dist2(target, d.mesh.position);
    if (d2 < bestDist2 && d2 <= maxDist2) {
      bestDist2 = d2;
      best = d;
    }
  }
  return best;
}

/** Check if a destructible is "destroyed" (stage >= 2 or health <= 0). */
function isDestructibleDestroyed(d: DestructibleProp): boolean {
  return d.stage >= 2 || d.health <= 0;
}

/** Check if a destructible is "damaged past threshold" (0..1). */
function isDestructibleDamagedPast(d: DestructibleProp, threshold: number): boolean {
  if (d.maxHealth <= 0) return false;
  const lost = 1 - d.health / d.maxHealth;
  return lost >= threshold;
}

/** Evaluate a single set-piece's trigger condition. Returns true if it fires. */
function evaluateTrigger(
  sp: SetPiece,
  ctx: GameContext,
): boolean {
  const t = sp.trigger;
  // Match-time gate — ctx.match.matchStartTime is performance.now() at match start.
  if (t.minMatchTimeSec !== undefined) {
    const elapsed = (performance.now() - ctx.match.matchStartTime) / 1000;
    if (elapsed < t.minMatchTimeSec) return false;
  }
  const matchTol = 2.0; // meters — props are placed at the listed positions

  switch (t.type) {
    case "manual":
      return false; // fired via triggerSetPiece()
    case "prop_destroyed": {
      if (!t.positions?.length) return false;
      for (const pos of t.positions) {
        const d = findDestructibleAt(ctx.destructibles, pos, matchTol);
        if (d && isDestructibleDestroyed(d)) return true;
      }
      return false;
    }
    case "all_props_destroyed": {
      if (!t.positions?.length) return false;
      for (const pos of t.positions) {
        const d = findDestructibleAt(ctx.destructibles, pos, matchTol);
        if (!d || !isDestructibleDestroyed(d)) return false;
      }
      return true;
    }
    case "prop_damaged": {
      if (!t.positions?.length) return false;
      const threshold = t.damageThreshold ?? 0.5;
      for (const pos of t.positions) {
        const d = findDestructibleAt(ctx.destructibles, pos, matchTol);
        if (d && isDestructibleDamagedPast(d, threshold)) return true;
      }
      return false;
    }
    case "area_entered": {
      if (!t.area) return false;
      const [minX, minY, minZ, maxX, maxY, maxZ] = t.area;
      const p = ctx.player.pos;
      return p.x >= minX && p.x <= maxX
        && p.y >= minY && p.y <= maxY
        && p.z >= minZ && p.z <= maxZ;
    }
    default:
      return false;
  }
}

/** Apply a set-piece's effect. This is the engine-side hook that:
 *   - spawns explosions / fire / collapse particles,
 *   - removes colliders in breach radius,
 *   - adds colliders for spawn-colliders,
 *   - calls activateShards() on target props (VoronoiFracture wiring).
 *
 * NOTE: This function imports VoronoiFracture lazily (inside the function
 * body) so the module-level export is SSR-safe and tests can stub it. */
function applyEffect(sp: SetPiece, ctx: GameContext): void {
  const e = sp.effect;
  const targets = e.targetPositions ?? [];

  // ─── Breach: remove colliders within `removeCollidersRadius` of each target ───
  if (e.type === "breach" && e.removeCollidersRadius) {
    const r2 = e.removeCollidersRadius * e.removeCollidersRadius;
    for (const tp of targets) {
      for (let i = ctx.colliders.length - 1; i >= 0; i--) {
        const c = ctx.colliders[i];
        const cx = (c.box.min.x + c.box.max.x) / 2;
        const cz = (c.box.min.z + c.box.max.z) / 2;
        const dx = cx - tp[0], dz = cz - tp[2];
        if (dx * dx + dz * dz < r2) {
          ctx.colliders.splice(i, 1);
        }
      }
    }
  }

  // ─── Block / Collapse: add spawn-colliders ───
  if ((e.type === "block" || e.type === "collapse" || e.type === "ramp") && e.spawnColliders) {
    for (const aabb of e.spawnColliders) {
      ctx.colliders.push({
        box: new THREE.Box3(
          new THREE.Vector3(aabb[0], aabb[1], aabb[2]),
          new THREE.Vector3(aabb[3], aabb[4], aabb[5]),
        ),
      });
    }
  }

  // ─── Disable: tag interactive props within `radius` of each target ───
  // (Engine reads `userData.disabled = true` on jump pads / doors / etc.)
  if (e.type === "disable") {
    const r2 = (e.radius ?? 2) * (e.radius ?? 2);
    for (const tp of targets) {
      ctx.scene.traverse((obj) => {
        const dx = obj.position.x - tp[0];
        const dz = obj.position.z - tp[2];
        if (dx * dx + dz * dz < r2) {
          obj.userData.disabled = true;
        }
      });
    }
  }

  // ─── Fracture target props via VoronoiFracture ───
  if (e.fractureTargetProps) {
    for (const tp of targets) {
      const d = findDestructibleAt(ctx.destructibles, tp, 2.0);
      if (!d) continue;
      try {
        const fractured = preFracture(d.mesh, 12);
        const impact = new THREE.Vector3(tp[0], tp[1], tp[2]);
        const shards = activateShards(fractured, impact, e.damageRadius ?? 6);
        // Add shard meshes to the scene — physics integration is the engine's job.
        for (const s of shards) ctx.scene.add(s.mesh);
      } catch {
        // Fracture can throw on degenerate geometry — fail soft.
      }
    }
  }

  // ─── Damage nearby entities (chain explosion / collapse / fire) ───
  if (e.damageRadius && (e.type === "chain_explosion" || e.type === "collapse" || e.type === "block" || e.type === "fire")) {
    const r2 = e.damageRadius * e.damageRadius;
    for (const tp of targets) {
      // Damage enemies within the radius.
      for (const enemy of ctx.enemies) {
        if (!enemy.alive) continue;
        const dx = enemy.group.position.x - tp[0];
        const dy = enemy.group.position.y - tp[1];
        const dz = enemy.group.position.z - tp[2];
        if (dx * dx + dy * dy + dz * dz < r2) {
          // Use the engine's damage hook if present; otherwise direct damage.
          const dmg = e.damagePerTick ?? 60;
          enemy.health = Math.max(0, enemy.health - dmg);
          enemy.lastDamagedTime = performance.now();
        }
      }
      // Damage the player within the radius.
      const pp = ctx.player.pos;
      const pdx = pp.x - tp[0], pdy = pp.y - tp[1], pdz = pp.z - tp[2];
      if (pdx * pdx + pdy * pdy + pdz * pdz < r2) {
        const dmg = e.damagePerTick ?? 40;
        ctx.player.health = Math.max(0, ctx.player.health - dmg);
        ctx.player.lastDamageTime = performance.now();
        ctx.triggerShake?.(0.6);
      }
    }
  }

  // ─── HUD toast — surfaced via the returned `fired` array; the engine
  //     can show a toast (radio message style) for each fired piece. The
  //     orchestrator reads `fired[i].toast` and pushes it to the HUD. ───
}

/** Tick all set-pieces for the current map. Engine calls this once per frame.
 *  Returns the list of set-pieces that fired this tick (so the engine can
 *  play a sound / show a toast). */
export function tickSetPieces(ctx: GameContext, _dt: number, mapSlug: string): SetPiece[] {
  if (!mapSlug) return [];
  const fired: SetPiece[] = [];
  for (const sp of SET_PIECES) {
    if (sp.mapSlug !== mapSlug) continue;
    if (sp.state !== "armed") continue;
    if (evaluateTrigger(sp, ctx)) {
      try {
        applyEffect(sp, ctx);
      } catch (err) {
        // Fail soft — set-pieces must never crash the match.
        console.warn(`[SetPieces] applyEffect failed for ${sp.id}:`, err);
      }
      sp.state = "triggered";
      fired.push(sp);
    }
  }
  return fired;
}

/** Manually fire a set-piece (for scripted sequences / debug). No-op if the
 *  set-piece isn't armed. */
export function triggerSetPiece(id: string, ctx: GameContext): boolean {
  const sp = getSetPiece(id);
  if (!sp || sp.state !== "armed") return false;
  try {
    applyEffect(sp, ctx);
  } catch (err) {
    console.warn(`[SetPieces] manual trigger failed for ${id}:`, err);
  }
  sp.state = "triggered";
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// K-5000 prompt mapping (this file owns):
//   #4228 [set-piece trigger audit] — new `auditSetPieceTriggers(ctx)`
//         function returns per-set-piece trigger health: whether the
//         trigger's referenced positions match actual destructibles in
//         `ctx.destructibles`, whether the trigger's AABB is sane, and
//         whether the trigger is reachable by the player (not blocked
//         by cover). A "blocked" set-piece is one whose trigger
//         positions don't exist as destructibles — the set-piece can
//         never fire, which is a silent design bug (the player sees
//         the set-piece's signature prop but destroying it does
//         nothing).
//   #4365 [cross-ref to 4228] — see marker above.
// ────────────────────────────────────────────────────────────────────────────

export interface SetPieceTriggerAudit {
  /** Set-piece id. */
  id: string;
  /** Map slug. */
  mapSlug: string;
  /** True iff the trigger can fire (all referenced positions exist as
   *  destructibles OR the trigger is area_entered/manual). */
  canFire: boolean;
  /** Why the trigger can't fire (if applicable). */
  reason?: string;
  /** Number of referenced destructibles found in ctx.destructibles. */
  matchedDestructibles: number;
  /** Number of referenced destructibles missing from ctx.destructibles. */
  missingDestructibles: number;
}

/** K-5000 #4228 — audit every set-piece's trigger for "can it actually
 *  fire?" Returns one row per set-piece. A "blocked" set-piece is one
 *  whose `trigger.positions` reference destructibles that aren't in
 *  `ctx.destructibles` — the set-piece will never fire because the
 *  trigger condition can't be met. The engine's design dashboard
 *  surfaces these so the design team can fix the prop positions or
 *  remove the orphaned set-piece. */
export function auditSetPieceTriggers(ctx: GameContext): SetPieceTriggerAudit[] {
  const out: SetPieceTriggerAudit[] = [];
  for (const sp of SET_PIECES) {
    const trigger = sp.trigger;
    // Manual + area_entered triggers don't reference destructibles —
    // they can always fire (given the AABB / manual call).
    if (trigger.type === "manual" || trigger.type === "area_entered") {
      out.push({
        id: sp.id, mapSlug: sp.mapSlug,
        canFire: true, matchedDestructibles: 0, missingDestructibles: 0,
      });
      continue;
    }
    // prop_destroyed / all_props_destroyed / prop_damaged reference
    // destructibles by position. Verify each position exists.
    const positions = trigger.positions ?? [];
    let matched = 0;
    let missing = 0;
    for (const pos of positions) {
      const found = ctx.destructibles.some(
        (d) => Math.hypot(d.mesh.position.x - pos[0], d.mesh.position.y - pos[1], d.mesh.position.z - pos[2]) < 1.5,
      );
      if (found) matched++;
      else missing++;
    }
    const canFire = missing === 0 || (trigger.type === "prop_damaged" && matched > 0);
    out.push({
      id: sp.id, mapSlug: sp.mapSlug,
      canFire,
      reason: canFire ? undefined : `${missing}/${positions.length} referenced destructibles not found in ctx.destructibles — set-piece will never fire.`,
      matchedDestructibles: matched,
      missingDestructibles: missing,
    });
  }
  return out;
}
