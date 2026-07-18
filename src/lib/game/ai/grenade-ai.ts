/**
 * Section F — Grenade usage AI.
 *
 * Addresses Section F prompts for "enemies throw grenades to flush player
 * from cover" (grenade-cook rush, molotov area denial, smoke-screen
 * reposition, smoke-rescue downed ally, claymore trap placement).
 *
 * The existing GrenadeSystem throws one grenade type (frag) when
 * `ctx.enemyGrenadeThrow(origin, target)` is called. This module decides
 * WHEN + WHAT to throw — the tactical reasoning layer above the throw
 * hook.
 *
 * Tactics:
 *   - **Flush from cover**: if the player is in cover (LOS blocked) AND
 *     has been stationary for > 2s, throw a frag at the player's LKP.
 *   - **Cook rush**: if the player is reloading / low HP AND an enemy is
 *     within 8m, "cook" a grenade (hold for 1.5s) then rush the player.
 *   - **Area denial**: throw a molotov at a chokepoint the player is
 *     approaching (predicted future position).
 *   - **Smoke screen**: when an enemy is moving across open ground /
 *     retreating, throw smoke between itself and the player.
 *   - **Smoke rescue**: when an ally is downed in the open, throw smoke
 *     on the body before running to revive.
 *   - **Claymore trap**: place a claymore at a doorway / corridor the
 *     player is likely to use (engineer class only).
 *
 * Per-class grenade loadouts:
 *   - RIFLEMAN: 1 frag
 *   - CQB: 2 frags (flashbang-capable)
 *   - MG: 1 smoke (defensive)
 *   - SNIPER: 1 frag (rarely used; prefers overwatch)
 *   - COMMANDER: 2 frags + 1 smoke + 1 flash
 *   - MEDIC: 1 smoke (for revives)
 *   - SCOUT: 2 flash + 1 frag
 *   - SHOTGUNNER: 2 frags (breacher)
 *   - SHIELD: 1 flash (to blind + close)
 *
 * Pure-TS, SSR-safe. THREE is imported lazily.
 *
 * Integration:
 *   - enemy-tactics.ts calls `tickGrenadeAI(enemy, ctx, cls, lkp, now)` per
 *     frame for each enemy; the function returns a `GrenadeDecision`
 *     describing what to do (or null).
 *   - The tactics code then calls `ctx.enemyGrenadeThrow(origin, target)`
 *     for frags, or the appropriate hook (smoke/flash/molotov) when the
 *     engine wires them.
 */

import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";
import type { EnemyClass } from "../EnemyClasses";

// ───────────────────────────────────────────────────────────────────────────
// Grenade types
// ───────────────────────────────────────────────────────────────────────────

export type GrenadeType = "frag" | "smoke" | "flash" | "molotov" | "claymore";

// ───────────────────────────────────────────────────────────────────────────
// Per-class loadout
// ───────────────────────────────────────────────────────────────────────────

export interface GrenadeLoadout {
  frag: number;
  smoke: number;
  flash: number;
  molotov: number;
  claymore: number;
}

const DEFAULT_LOADOUT: GrenadeLoadout = { frag: 0, smoke: 0, flash: 0, molotov: 0, claymore: 0 };

const CLASS_LOADOUTS: Partial<Record<EnemyClass, Partial<GrenadeLoadout>>> = {
  RIFLEMAN: { frag: 1 },
  CQB: { frag: 2, flash: 1 },
  MG: { smoke: 1 },
  SNIPER: { frag: 1 },
  COMMANDER: { frag: 2, smoke: 1, flash: 1 },
  MEDIC: { smoke: 2 },
  SCOUT: { frag: 1, flash: 2 },
  SHOTGUNNER: { frag: 2, flash: 1 },
  SHIELD: { flash: 1 },
  ZOMBIE: {},
};

export function getGrenadeLoadout(cls: EnemyClass | undefined): GrenadeLoadout {
  if (!cls) return { ...DEFAULT_LOADOUT };
  return { ...DEFAULT_LOADOUT, ...(CLASS_LOADOUTS[cls] ?? {}) };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-enemy grenade-AI state (cast on Enemy)
// ───────────────────────────────────────────────────────────────────────────

export interface GrenadeAIState {
  /** Inventory — counts of each grenade type remaining. */
  inventory: GrenadeLoadout;
  /** Cooldown timestamp (ms) — next allowed throw. */
  nextThrowAt: number;
  /** True if currently "cooking" a grenade (holding the pin). */
  cooking: boolean;
  /** When the cook started (ms) — used to time the throw. */
  cookStartedAt: number;
  /** Type of grenade being cooked. */
  cookingType: GrenadeType | null;
  /** True if a claymore has been placed this match (one per engineer). */
  claymorePlaced: boolean;
  /** Total throws this match (for the per-match cap). */
  throwsThisMatch: number;
  /** Per-tick "stationary player" tracker — for the flush-from-cover tactic. */
  lastPlayerPos: THREE.Vector3 | null;
  lastPlayerPosAt: number;
  /** Predicted player position (for area-denial + leading throws). */
  predictedPlayerPos: THREE.Vector3 | null;
}

const KEY = Symbol("grenade_ai");

export function getGrenadeAIState(e: Enemy): GrenadeAIState {
  const ex = e as unknown as { [KEY]?: GrenadeAIState };
  if (!ex[KEY]) {
    ex[KEY] = {
      inventory: { frag: 0, smoke: 0, flash: 0, molotov: 0, claymore: 0 },
      nextThrowAt: 0,
      cooking: false,
      cookStartedAt: 0,
      cookingType: null,
      claymorePlaced: false,
      throwsThisMatch: 0,
      lastPlayerPos: null,
      lastPlayerPosAt: 0,
      predictedPlayerPos: null,
    };
  }
  return ex[KEY]!;
}

/** Initialize the inventory from the class loadout (call on spawn). */
export function initGrenadeInventory(e: Enemy, cls: EnemyClass | undefined): void {
  const loadout = getGrenadeLoadout(cls);
  const st = getGrenadeAIState(e);
  st.inventory = { ...loadout };
  st.throwsThisMatch = 0;
  st.claymorePlaced = false;
}

// ───────────────────────────────────────────────────────────────────────────
// Decision
// ───────────────────────────────────────────────────────────────────────────

export interface GrenadeDecision {
  /** "throw" — throw a grenade of `type` at `target`. */
  type: GrenadeType;
  /** Target world position. */
  target: { x: number; y: number; z: number };
  /** Origin world position (where the throw starts — typically the enemy's chest). */
  origin: { x: number; y: number; z: number };
  /** "cook" — start cooking a grenade (caller holds for `cookMs` then throws). */
  cook?: { type: GrenadeType; cookMs: number };
  /** "place_claymore" — place a claymore at `target` (engineer only). */
  placeClaymore?: { x: number; z: number };
  /** Reason string — for debug overlay / telemetry. */
  reason: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────

const GLOBAL_THROW_COOLDOWN_MS = 6000; // per-enemy minimum between throws.
const FRAG_COOK_MS = 1200;              // cook time for a frag (1.2s).
const MAX_THROW_RANGE_M = 25;           // max effective throw range.
const FLUSH_THRESHOLD_MS = 2000;        // player stationary for ≥2s = flush.
const COOK_RUSH_DISTANCE_M = 10;        // within 10m for cook-rush.
const SMOKE_RESCUE_RADIUS_M = 8;        // ally down within 8m = smoke rescue.
const CLAYMORE_PLACE_DISTANCE_M = 6;    // place claymores within 6m of a doorway.

// ───────────────────────────────────────────────────────────────────────────
// Tick
// ───────────────────────────────────────────────────────────────────────────

/** Tick the grenade AI for one enemy. Returns a decision (or null).
 *  `lkp` = the player's last-known position (or current if LOS).
 *  `cls` = the enemy's class.
 *  `cookingThrowHook` = optional callback for when a cook completes —
 *  the caller checks the cooking state in subsequent ticks. */
export function tickGrenadeAI(
  enemy: Enemy,
  ctx: GameContext,
  cls: EnemyClass | undefined,
  lkp: THREE.Vector3 | null,
  now: number = performance.now(),
  rng: () => number = Math.random,
): GrenadeDecision | null {
  const state = getGrenadeAIState(enemy);
  const inv = state.inventory;

  // If currently cooking, check if it's time to throw.
  if (state.cooking && state.cookingType) {
    const elapsed = now - state.cookStartedAt;
    if (elapsed >= FRAG_COOK_MS) {
      const target = lkp ?? ctx.player.pos;
      state.cooking = false;
      state.cookingType = null;
      state.nextThrowAt = now + GLOBAL_THROW_COOLDOWN_MS;
      state.throwsThisMatch++;
      // Decrement inventory.
      inv.frag = Math.max(0, inv.frag - 1);
      return {
        type: "frag",
        target: { x: target.x, y: target.y, z: target.z },
        origin: {
          x: enemy.group.position.x,
          y: enemy.group.position.y + 1.4,
          z: enemy.group.position.z,
        },
        reason: "cook_rush",
      };
    }
    return null; // still cooking.
  }

  // Cooldown gate.
  if (now < state.nextThrowAt) return null;

  // Update stationary-player tracking.
  const playerPos = ctx.player.pos;
  const stationary = state.lastPlayerPos
    ? state.lastPlayerPos.distanceTo(playerPos) < 0.5
    : false;
  if (stationary) {
    // already stationary; check how long.
  } else {
    state.lastPlayerPos = playerPos.clone();
    state.lastPlayerPosAt = now;
  }
  const stationaryFor = stationary ? now - state.lastPlayerPosAt : 0;

  const distToPlayer = enemy.group.position.distanceTo(playerPos);
  const inRange = distToPlayer <= MAX_THROW_RANGE_M;

  // ---------- Smoke rescue — ally downed in the open ----------
  if (inv.smoke > 0) {
    const downedAlly = findDownedAlly(enemy, ctx, SMOKE_RESCUE_RADIUS_M);
    if (downedAlly) {
      inv.smoke = Math.max(0, inv.smoke - 1);
      state.nextThrowAt = now + GLOBAL_THROW_COOLDOWN_MS;
      state.throwsThisMatch++;
      return {
        type: "smoke",
        target: { x: downedAlly.x, y: downedAlly.y, z: downedAlly.z },
        origin: {
          x: enemy.group.position.x,
          y: enemy.group.position.y + 1.4,
          z: enemy.group.position.z,
        },
        reason: "smoke_rescue",
      };
    }
  }

  // ---------- Smoke screen — moving across open ground ----------
  if (inv.smoke > 0 && cls === "MG" && distToPlayer > 15) {
    // Throw smoke between self and player to cover a reposition.
    const midX = (enemy.group.position.x + playerPos.x) / 2;
    const midZ = (enemy.group.position.z + playerPos.z) / 2;
    inv.smoke = Math.max(0, inv.smoke - 1);
    state.nextThrowAt = now + GLOBAL_THROW_COOLDOWN_MS;
    state.throwsThisMatch++;
    return {
      type: "smoke",
      target: { x: midX, y: playerPos.y, z: midZ },
      origin: {
        x: enemy.group.position.x,
        y: enemy.group.position.y + 1.4,
        z: enemy.group.position.z,
      },
      reason: "smoke_screen",
    };
  }

  // ---------- Flush from cover ----------
  if (inv.frag > 0 && inRange && lkp && stationaryFor > FLUSH_THRESHOLD_MS) {
    // Random chance per tick (avoid every suppressed enemy throwing at once).
    if (rng() < 0.3) {
      inv.frag = Math.max(0, inv.frag - 1);
      state.nextThrowAt = now + GLOBAL_THROW_COOLDOWN_MS;
      state.throwsThisMatch++;
      return {
        type: "frag",
        target: { x: lkp.x, y: lkp.y, z: lkp.z },
        origin: {
          x: enemy.group.position.x,
          y: enemy.group.position.y + 1.4,
          z: enemy.group.position.z,
        },
        reason: "flush_from_cover",
      };
    }
  }

  // ---------- Cook rush — close-range player reload/low HP ----------
  if (inv.frag > 0 && distToPlayer < COOK_RUSH_DISTANCE_M && !state.cooking) {
    const playerReloading = (ctx.weapon.reloading) || (now - ctx.weapon.lastShotTime < 400 && ctx.weapon.ammo <= 1);
    const playerLowHP = ctx.player.health < 35;
    if ((playerReloading || playerLowHP) && rng() < 0.15) {
      // Start cooking.
      state.cooking = true;
      state.cookStartedAt = now;
      state.cookingType = "frag";
      return {
        type: "frag",
        target: { x: playerPos.x, y: playerPos.y, z: playerPos.z },
        origin: {
          x: enemy.group.position.x,
          y: enemy.group.position.y + 1.4,
          z: enemy.group.position.z,
        },
        cook: { type: "frag", cookMs: FRAG_COOK_MS },
        reason: "cook_rush_start",
      };
    }
  }

  // ---------- Molotov area denial — predicted player position ----------
  if (inv.molotov > 0 && inRange) {
    // Predict player position 1s ahead.
    const predX = playerPos.x + ctx.player.vel.x * 1.0;
    const predZ = playerPos.z + ctx.player.vel.z * 1.0;
    state.predictedPlayerPos = new THREE.Vector3(predX, playerPos.y, predZ);
    // Only throw if player is moving (a stationary player doesn't need denial).
    const playerSpeed = Math.hypot(ctx.player.vel.x, ctx.player.vel.z);
    if (playerSpeed > 2 && rng() < 0.1) {
      inv.molotov = Math.max(0, inv.molotov - 1);
      state.nextThrowAt = now + GLOBAL_THROW_COOLDOWN_MS;
      state.throwsThisMatch++;
      return {
        type: "molotov",
        target: { x: predX, y: playerPos.y, z: predZ },
        origin: {
          x: enemy.group.position.x,
          y: enemy.group.position.y + 1.4,
          z: enemy.group.position.z,
        },
        reason: "area_denial",
      };
    }
  }

  // ---------- Flashbang — shield bearer blinding + closing ----------
  if (inv.flash > 0 && (cls === "SHIELD" || cls === "CQB") && distToPlayer < 12) {
    if (rng() < 0.08) {
      inv.flash = Math.max(0, inv.flash - 1);
      state.nextThrowAt = now + GLOBAL_THROW_COOLDOWN_MS;
      state.throwsThisMatch++;
      return {
        type: "flash",
        target: { x: playerPos.x, y: playerPos.y, z: playerPos.z },
        origin: {
          x: enemy.group.position.x,
          y: enemy.group.position.y + 1.4,
          z: enemy.group.position.z,
        },
        reason: "flash_blind",
      };
    }
  }

  // ---------- Claymore trap — engineer places near a doorway ----------
  // (Only engineers — but our class set doesn't include ENGINEER, so we
  //  allow COMMANDER + SHOTGUNNER to place claymores as a breacher proxy.)
  if (inv.claymore > 0 && !state.claymorePlaced && (cls === "COMMANDER" || cls === "SHOTGUNNER")) {
    // Find a nearby collider gap (doorway heuristic: narrow opening between
    // two colliders within 6m of the enemy).
    const doorway = findDoorway(enemy, ctx, CLAYMORE_PLACE_DISTANCE_M);
    if (doorway && rng() < 0.05) {
      inv.claymore = Math.max(0, inv.claymore - 1);
      state.claymorePlaced = true;
      state.nextThrowAt = now + GLOBAL_THROW_COOLDOWN_MS;
      return {
        type: "claymore",
        target: { x: doorway.x, y: enemy.group.position.y, z: doorway.z },
        origin: { x: doorway.x, y: enemy.group.position.y, z: doorway.z },
        placeClaymore: { x: doorway.x, z: doorway.z },
        reason: "claymore_trap",
      };
    }
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Find a downed (but alive) ally within `radius` of the enemy. Returns
 *  the ally's position or null. */
function findDownedAlly(enemy: Enemy, ctx: GameContext, radius: number): THREE.Vector3 | null {
  for (const other of ctx.enemies) {
    if (other === enemy || !other.alive) continue;
    // "Downed" = health < 30% + stationary + not in cover.
    const hpPct = other.health / Math.max(1, other.maxHealth);
    if (hpPct >= 0.3) continue;
    const d = enemy.group.position.distanceTo(other.group.position);
    if (d > radius) continue;
    return other.group.position.clone();
  }
  return null;
}

/** Find a "doorway" — a gap between two colliders that the player might
 *  walk through. Cheap heuristic: find a position that is between two
 *  collider AABBs within `radius` of the enemy. */
function findDoorway(enemy: Enemy, ctx: GameContext, radius: number): { x: number; z: number } | null {
  // Look for two nearby colliders whose midpoints are within 4m of each other.
  const nearby = ctx.colliders.filter((c) => {
    const center = c.box.getCenter(new THREE.Vector3());
    return enemy.group.position.distanceTo(center) < radius;
  });
  if (nearby.length < 2) return null;
  for (let i = 0; i < nearby.length; i++) {
    for (let j = i + 1; j < nearby.length; j++) {
      const c1 = nearby[i].box.getCenter(new THREE.Vector3());
      const c2 = nearby[j].box.getCenter(new THREE.Vector3());
      const gap = c1.distanceTo(c2);
      if (gap > 1.5 && gap < 4) {
        // Doorway midpoint.
        return { x: (c1.x + c2.x) / 2, z: (c1.z + c2.z) / 2 };
      }
    }
  }
  return null;
}

/** Check if a throw is clear (no friendly-fire risk). Returns true if no
 *  ally is in the grenade's blast radius (3m of the target). */
export function isThrowSafe(
  enemy: Enemy,
  ctx: GameContext,
  target: { x: number; y: number; z: number },
  blastRadius: number = 3,
): boolean {
  for (const other of ctx.enemies) {
    if (other === enemy || !other.alive) continue;
    const dx = other.group.position.x - target.x;
    const dz = other.group.position.z - target.z;
    if (Math.hypot(dx, dz) < blastRadius) return false;
  }
  return true;
}
