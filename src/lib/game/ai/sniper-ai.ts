/**
 * Section F — Sniper AI.
 *
 * Addresses Section F prompts for "sniper reposition, laser-designate
 * airstrike, snipe-and-relocate, thermal-scan sweep, drone scout reveal".
 * The existing EnemyClasses SNIPER has `repositionAfterShot: true` and
 * `ghillieProne: true` flags; this module implements the actual behavior.
 *
 * Behaviors:
 *   - **Overwatch positioning**: the sniper picks an elevated / distant
 *     overwatch position with a clear sightline to the expected player
 *     area. Prefers positions on the level perimeter (so it can't be
 *     flanked easily).
 *   - **Snipe-and-relocate**: after each shot, the sniper moves to a new
 *     overwatch position (so the player can't pin it down).
 *   - **Laser designation**: marks the player with a visible laser for
 *     ~3s; if the player is still marked when the designation completes,
 *     an "airstrike" warning is emitted (engine handles the actual
 *     airstrike effect via a hook).
 *   - **Thermal scan**: a periodic 360° sweep that reveals the player's
 *     position even through light cover (simulates thermal imaging).
 *   - **Drone scout**: the sniper (or commander) deploys a small drone
 *     that flies to the player's LKP + reveals them on the minimap.
 *
 * Per-sniper state: current overwatch position, reposition timer, laser
 * designation state, thermal scan cooldown, drone cooldown.
 *
 * Pure-TS, SSR-safe. THREE is imported lazily.
 *
 * Integration:
 *   - enemy-tactics.ts calls `tickSniperAI(enemy, ctx, lkp, now)` per
 *     frame for enemies with class SNIPER.
 *   - The function returns a SniperOrder the tactics code applies.
 *   - The laser designation + airstrike hook is exposed as
 *     `ctx.sniperLaserDesignate` (engine wires it).
 */

import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface SniperOverwatch {
  /** World position of the overwatch spot. */
  x: number;
  y: number;
  z: number;
  /** Quality score 0..1 — higher = better sightlines + harder to flank. */
  quality: number;
  /** True if currently occupied. */
  occupied: boolean;
}

export interface SniperState {
  /** Current overwatch position index (-1 = moving to a new one). */
  currentOverwatchIdx: number;
  /** performance.now() when the last shot was fired. */
  lastShotAt: number;
  /** Reposition deadline (the sniper moves to a new overwatch after this). */
  repositionAt: number;
  /** True while relocating (moving to a new overwatch). */
  relocating: boolean;
  /** Laser-designation state. */
  laser: {
    active: boolean;
    startedAt: number;
    durationMs: number;
    targetX: number;
    targetY: number;
    targetZ: number;
  } | null;
  /** Thermal scan cooldown (next allowed scan time). */
  nextThermalScanAt: number;
  /** Drone scout cooldown. */
  nextDroneScoutAt: number;
  /** Drone currently active (until this timestamp). */
  droneActiveUntil: number;
  /** Known overwatch positions (cached for this match). */
  overwatchPositions: SniperOverwatch[];
}

export interface SniperOrder {
  /** "reposition" — move to a new overwatch position. */
  reposition?: { x: number; z: number };
  /** "hold_overwatch" — stay put + scan for the player. */
  holdOverwatch?: boolean;
  /** "fire" — take the shot (caller handles the actual projectile spawn). */
  fire?: { targetX: number; targetY: number; targetZ: number };
  /** "laser_designate" — start a laser designation on the player. */
  laserDesignate?: { targetX: number; targetY: number; targetZ: number; durationMs: number };
  /** "thermal_scan" — perform a thermal sweep (reveals player position). */
  thermalScan?: boolean;
  /** "drone_scout" — deploy a scout drone. */
  droneScout?: { targetX: number; targetZ: number };
  /** "laser_airstrike" — fire the airstrike (designation completed). */
  laserAirstrike?: { targetX: number; targetY: number; targetZ: number };
  /** Reason string — for debug overlay. */
  reason: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────

const REPOSITION_AFTER_SHOT_MS = 1500; // 1.5s after shot, relocate.
const MIN_OVERWATCH_RANGE_M = 25;
const MAX_OVERWATCH_RANGE_M = 45;
const LASER_DURATION_MS = 3000;
const LASER_COOLDOWN_MS = 15000;
const THERMAL_SCAN_DURATION_MS = 1200;
const THERMAL_SCAN_COOLDOWN_MS = 10000;
const THERMAL_SCAN_RADIUS_M = 40;
const DRONE_SCOUT_COOLDOWN_MS = 30000;
const DRONE_SCOUT_DURATION_MS = 8000;
const SNIPER_SHOT_COOLDOWN_MS = 2500;

// ───────────────────────────────────────────────────────────────────────────
// Per-enemy state (cast on Enemy)
// ───────────────────────────────────────────────────────────────────────────

const KEY = Symbol("sniper_ai");

export function getSniperState(e: Enemy): SniperState {
  const ex = e as unknown as { [KEY]?: SniperState };
  if (!ex[KEY]) {
    ex[KEY] = {
      currentOverwatchIdx: -1,
      lastShotAt: 0,
      repositionAt: 0,
      relocating: false,
      laser: null,
      nextThermalScanAt: 0,
      nextDroneScoutAt: 0,
      droneActiveUntil: 0,
      overwatchPositions: [],
    };
  }
  return ex[KEY]!;
}

// ───────────────────────────────────────────────────────────────────────────
// Overwatch position discovery
// ───────────────────────────────────────────────────────────────────────────

/** Discover candidate overwatch positions for the sniper. Called once
 *  per match (cached on the SniperState). Heuristic: scan the level
 *  perimeter at 8 evenly-spaced angles + score each by sightline quality. */
export function discoverOverwatchPositions(ctx: GameContext): SniperOverwatch[] {
  const positions: SniperOverwatch[] = [];
  const N = 12;
  const radius = 38;
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (Math.abs(x) > 43 || Math.abs(z) > 43) continue;
    // Quality: higher = further from the level center (harder to flank) +
    //  has clear LOS to the center.
    const distFromCenter = Math.hypot(x, z);
    let quality = clamp01(distFromCenter / radius);
    // Check LOS to a few interior points.
    let clearCount = 0;
    for (let j = 0; j < 5; j++) {
      const tx = (Math.random() - 0.5) * 30;
      const tz = (Math.random() - 0.5) * 30;
      if (hasClearLine(new THREE.Vector3(x, 1.6, z), new THREE.Vector3(tx, 1.6, tz), ctx)) {
        clearCount++;
      }
    }
    quality = (quality + clearCount / 5) / 2;
    positions.push({ x, y: 0, z, quality, occupied: false });
  }
  return positions;
}

/** Pick the best unoccupied overwatch position, biased away from the
 *  player (so the sniper prefers distant overwatch). */
function pickOverwatch(state: SniperState, playerPos: THREE.Vector3): SniperOverwatch | null {
  let best: SniperOverwatch | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < state.overwatchPositions.length; i++) {
    const p = state.overwatchPositions[i];
    if (p.occupied) continue;
    const distToPlayer = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
    if (distToPlayer < MIN_OVERWATCH_RANGE_M || distToPlayer > MAX_OVERWATCH_RANGE_M) continue;
    // Score: quality + distance from current position (prefer new spots).
    const score = p.quality * 2 + Math.random() * 0.3;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

// ───────────────────────────────────────────────────────────────────────────
// Tick
// ───────────────────────────────────────────────────────────────────────────

/** Tick the sniper AI. Returns the order for this frame (or null if no
 *  action — the sniper holds position). */
export function tickSniperAI(
  enemy: Enemy,
  ctx: GameContext,
  hasLOS: boolean,
  lkp: THREE.Vector3 | null,
  now: number = performance.now(),
  rng: () => number = Math.random,
): SniperOrder | null {
  const state = getSniperState(enemy);
  // Lazy-init overwatch positions.
  if (state.overwatchPositions.length === 0) {
    state.overwatchPositions = discoverOverwatchPositions(ctx);
  }

  const playerPos = ctx.player.pos;
  const distToPlayer = enemy.group.position.distanceTo(playerPos);

  // ---------- Laser designation completion ----------
  if (state.laser && state.laser.active) {
    const elapsed = now - state.laser.startedAt;
    if (elapsed >= state.laser.durationMs) {
      // Designation complete — fire airstrike.
      const target = { x: state.laser.targetX, y: state.laser.targetY, z: state.laser.targetZ };
      state.laser = null;
      return {
        laserAirstrike: target,
        holdOverwatch: true,
        reason: "laser_airstrike_complete",
      };
    }
    // Continue designating.
    return {
      holdOverwatch: true,
      laserDesignate: {
        targetX: state.laser.targetX,
        targetY: state.laser.targetY,
        targetZ: state.laser.targetZ,
        durationMs: state.laser.durationMs,
      },
      reason: "laser_designating",
    };
  }

  // ---------- Start laser designation (rare, high-impact) ----------
  if (!state.laser && hasLOS && now - state.lastShotAt > LASER_COOLDOWN_MS &&
      distToPlayer > 20 && rng() < 0.02) {
    state.laser = {
      active: true,
      startedAt: now,
      durationMs: LASER_DURATION_MS,
      targetX: playerPos.x,
      targetY: playerPos.y,
      targetZ: playerPos.z,
    };
    return {
      laserDesignate: {
        targetX: playerPos.x,
        targetY: playerPos.y,
        targetZ: playerPos.z,
        durationMs: LASER_DURATION_MS,
      },
      holdOverwatch: true,
      reason: "laser_designate_start",
    };
  }

  // ---------- Thermal scan ----------
  if (now > state.nextThermalScanAt && !hasLOS && rng() < 0.05) {
    state.nextThermalScanAt = now + THERMAL_SCAN_COOLDOWN_MS;
    return {
      thermalScan: true,
      holdOverwatch: true,
      reason: "thermal_scan",
    };
  }

  // ---------- Drone scout ----------
  if (now > state.nextDroneScoutAt && !hasLOS && lkp && rng() < 0.03) {
    state.nextDroneScoutAt = now + DRONE_SCOUT_COOLDOWN_MS;
    state.droneActiveUntil = now + DRONE_SCOUT_DURATION_MS;
    return {
      droneScout: { targetX: lkp.x, targetZ: lkp.z },
      holdOverwatch: true,
      reason: "drone_scout",
    };
  }

  // ---------- Reposition after shot ----------
  if (state.relocating) {
    // Already relocating — check if we've arrived.
    if (state.currentOverwatchIdx >= 0) {
      const target = state.overwatchPositions[state.currentOverwatchIdx];
      const d = Math.hypot(target.x - enemy.group.position.x, target.z - enemy.group.position.z);
      if (d < 1.5) {
        state.relocating = false;
        state.lastShotAt = 0; // ready to shoot again.
      } else {
        return { reposition: { x: target.x, z: target.z }, reason: "relocating" };
      }
    }
  }

  // ---------- Fire on the player ----------
  if (hasLOS && !state.relocating && now - state.lastShotAt > SNIPER_SHOT_COOLDOWN_MS) {
    state.lastShotAt = now;
    state.repositionAt = now + REPOSITION_AFTER_SHOT_MS;
    return {
      fire: { targetX: playerPos.x, targetY: playerPos.y + 1.4, targetZ: playerPos.z },
      holdOverwatch: true,
      reason: "snipe",
    };
  }

  // ---------- Reposition after shot ----------
  if (state.repositionAt > 0 && now > state.repositionAt && !state.relocating) {
    const next = pickOverwatch(state, playerPos);
    if (next) {
      // Free the current overwatch slot.
      if (state.currentOverwatchIdx >= 0) {
        state.overwatchPositions[state.currentOverwatchIdx].occupied = false;
      }
      // Find the index of the chosen position.
      const idx = state.overwatchPositions.indexOf(next);
      state.currentOverwatchIdx = idx;
      next.occupied = true;
      state.relocating = true;
      state.repositionAt = 0;
      return { reposition: { x: next.x, z: next.z }, reason: "reposition_after_shot" };
    }
  }

  // ---------- Initial overwatch placement ----------
  if (state.currentOverwatchIdx < 0 && !state.relocating) {
    const next = pickOverwatch(state, playerPos);
    if (next) {
      const idx = state.overwatchPositions.indexOf(next);
      state.currentOverwatchIdx = idx;
      next.occupied = true;
      state.relocating = true;
      return { reposition: { x: next.x, z: next.z }, reason: "initial_overwatch" };
    }
  }

  // Default: hold overwatch.
  return { holdOverwatch: true, reason: "hold" };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

function hasClearLine(origin: THREE.Vector3, target: THREE.Vector3, ctx: GameContext): boolean {
  const dir = new THREE.Vector3().subVectors(target, origin);
  const dist = dir.length();
  if (dist < 0.01) return true;
  dir.divideScalar(dist);
  for (const c of ctx.colliders) {
    const box = c.box;
    let tmin = 0, tmax = dist;
    let blocked = true;
    for (const ax of ["x", "y", "z"] as const) {
      const o = origin[ax];
      const d = dir[ax];
      const bmin = box.min[ax];
      const bmax = box.max[ax];
      if (Math.abs(d) < 1e-8) {
        if (o < bmin || o > bmax) { blocked = false; break; }
      } else {
        let t1 = (bmin - o) / d;
        let t2 = (bmax - o) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { blocked = false; break; }
      }
    }
    if (blocked) return false;
  }
  return true;
}

/** Public: get the thermal-scan radius (for the engine's reveal effect). */
export function getThermalScanRadius(): number {
  return THERMAL_SCAN_RADIUS_M;
}

/** Public: get the thermal-scan duration (for the engine's reveal timer). */
export function getThermalScanDurationMs(): number {
  return THERMAL_SCAN_DURATION_MS;
}

/** Public: get the drone-scout duration (for the engine's reveal timer). */
export function getDroneScoutDurationMs(): number {
  return DRONE_SCOUT_DURATION_MS;
}
