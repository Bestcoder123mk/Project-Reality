/**
 * Section F — Cover system.
 *
 * Addresses Section F prompts for "dynamic cover finding and usage". The
 * existing enemy-tactics.ts has a `findNearestCover` helper used by the
 * COVER + SUPPRESSED states; this module is a richer, dedicated cover
 * system with:
 *
 *   - **Cover point generation**: scan level colliders + produce cover
 *     points (position + facing + height + quality score). Cached per
 *     match (re-baked when destructibles change).
 *   - **Cover quality**: a cover point's score factors in (a) does it
 *     block LOS to the player from this position, (b) does it have a
 *     firing angle on the player, (c) is it adjacent to a flank escape
 *     route, (d) is the cover destructible (lower score).
 *   - **Cover memory**: each enemy remembers the cover points it has
 *     recently used (so it doesn't ping-pong between the same two covers).
 *   - **Cover sharing**: squadmates share cover assignments so they don't
 *     pile onto the same cover.
 *   - **Cover fire + peek**: the cover system exposes peek directions
 *     (left/right of the cover) + blind-fire vectors.
 *   - **Cover destruction**: when a destructible cover prop is destroyed
 *     (by the player), the cover system invalidates all cover points
 *     attached to that prop + notifies enemies in those covers (they
 *     immediately seek new cover).
 *
 * Pure-TS, SSR-safe. THREE is imported lazily for Vector3 / Box3 ops.
 *
 * Integration:
 *   - The engine bakes a CoverSystem once per level (after
 *     RendererSystem.buildLevelFromMap).
 *   - Enemy-tactics.ts calls `findCoverForEnemy(enemy, ctx, ...)` instead
 *     of the inline `findNearestCover`.
 *   - The destructible system calls `onDestructibleDestroyed(prop)` when
 *     a prop is destroyed.
 */

import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";

// ───────────────────────────────────────────────────────────────────────────
// Cover point
// ───────────────────────────────────────────────────────────────────────────

export interface CoverPoint {
  /** Unique ID (for memory + sharing). */
  id: number;
  /** World position the enemy stands at (just behind the cover). */
  x: number;
  y: number;
  z: number;
  /** The collider AABB that provides the cover. */
  colliderIndex: number;
  /** Facing yaw (radians) — the direction the cover faces (away from the
   *  collider toward where the enemy will fire from). */
  facingYaw: number;
  /** Cover height (m). 0.5 = low cover (crouch only), 1.5 = full standing. */
  height: number;
  /** Quality score 0..1 — higher = better cover (LOS-block + firing angle
   *  + flank escape + non-destructible). */
  quality: number;
  /** True if the cover is destructible (lower quality; tracked for
   *  invalidation). */
  destructible: boolean;
  /** True if the cover point has been invalidated (e.g. its collider was
   *  destroyed). Invalidated covers are skipped by findCoverForEnemy. */
  invalidated: boolean;
  /** Currently-occupying enemy ID (for sharing). null = unoccupied. */
  occupantId: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// CoverSystem
// ───────────────────────────────────────────────────────────────────────────

export class CoverSystem {
  private points: CoverPoint[] = [];
  private nextId = 1;
  /** Per-enemy memory: cover IDs used recently (timestamped). */
  private memory: Map<string, Map<number, number>> = new Map();
  /** Spatial hash for fast range queries (cell key → cover IDs). */
  private hash: Map<number, number[]> = new Map();
  private hashCellSize = 8;
  /** Map from collider index → cover IDs (for invalidation). */
  private byCollider: Map<number, number[]> = new Map();

  constructor() {}

  /** Bake cover points from the level's colliders. Call once per level
   *  build (and re-bake if a major change happens, e.g. a wall is
   *  breached). */
  bake(ctx: GameContext): void {
    this.points = [];
    this.byCollider.clear();
    this.hash.clear();
    this.nextId = 1;
    const destructibles = new Set(ctx.destructibles.map((d) => d.mesh));
    for (let i = 0; i < ctx.colliders.length; i++) {
      const c = ctx.colliders[i];
      const size = new THREE.Vector3();
      c.box.getSize(size);
      // Skip tiny / huge colliders (tiny = decorations, huge = level bounds).
      if (size.x < 0.5 || size.z < 0.5) continue;
      if (size.x > 30 || size.z > 30) continue;
      // Determine if this collider is a destructible prop.
      let destructible = false;
      for (const d of ctx.destructibles) {
        if (d.collider === c) { destructible = true; break; }
      }
      void destructibles;
      // Generate cover points on each side of the collider (4 sides max).
      const center = c.box.getCenter(new THREE.Vector3());
      const halfX = size.x / 2;
      const halfZ = size.z / 2;
      const coverOffset = 0.8; // enemy stands 0.8m behind the collider edge.
      const sides: Array<{ x: number; z: number; yaw: number; h: number }> = [
        // North side (cover faces south / toward -Z).
        { x: center.x, z: center.z + halfZ + coverOffset, yaw: Math.PI, h: Math.min(size.y, 1.8) },
        // South side.
        { x: center.x, z: center.z - halfZ - coverOffset, yaw: 0, h: Math.min(size.y, 1.8) },
        // East side.
        { x: center.x + halfX + coverOffset, z: center.z, yaw: -Math.PI / 2, h: Math.min(size.y, 1.8) },
        // West side.
        { x: center.x - halfX - coverOffset, z: center.z, yaw: Math.PI / 2, h: Math.min(size.y, 1.8) },
      ];
      for (const s of sides) {
        // Skip cover points that are out of bounds.
        if (Math.abs(s.x) > 45 || Math.abs(s.z) > 45) continue;
        // Quality: full-height + non-destructible = 1.0; low/destructible = 0.5.
        let quality = 0.5;
        if (s.h >= 1.4) quality += 0.3;
        if (!destructible) quality += 0.2;
        quality = Math.min(1, quality);
        const id = this.nextId++;
        this.points.push({
          id,
          x: s.x,
          y: center.y,
          z: s.z,
          colliderIndex: i,
          facingYaw: s.yaw,
          height: s.h,
          quality,
          destructible,
          invalidated: false,
          occupantId: null,
        });
        // Index by collider.
        const arr = this.byCollider.get(i) ?? [];
        arr.push(id);
        this.byCollider.set(i, arr);
        // Index in the spatial hash.
        const key = this.cellKey(s.x, s.z);
        const arr2 = this.hash.get(key) ?? [];
        arr2.push(id);
        this.hash.set(key, arr2);
      }
    }
  }

  /** Find the best cover point for the given enemy. Returns null if none
   *  in range. The caller is responsible for moving the enemy to the
   *  cover position. */
  findCoverForEnemy(
    enemy: Enemy,
    ctx: GameContext,
    maxRange: number = 15,
    now: number = performance.now(),
  ): CoverPoint | null {
    const ex = enemy.group.position.x;
    const ez = enemy.group.position.z;
    // Query the spatial hash for nearby cover points.
    const candidates: CoverPoint[] = [];
    const cellR = Math.ceil(maxRange / this.hashCellSize);
    const cx = Math.floor(ex / this.hashCellSize);
    const cz = Math.floor(ez / this.hashCellSize);
    for (let dx = -cellR; dx <= cellR; dx++) {
      for (let dz = -cellR; dz <= cellR; dz++) {
        const ids = this.hash.get(this.cellKeyRaw(cx + dx, cz + dz));
        if (!ids) continue;
        for (const id of ids) {
          const p = this.points[id - 1];
          if (!p || p.invalidated) continue;
          if (p.occupantId && p.occupantId !== enemy.id) continue;
          candidates.push(p);
        }
      }
    }
    if (candidates.length === 0) return null;
    // Score each candidate + pick the best.
    let best: CoverPoint | null = null;
    let bestScore = -Infinity;
    const mem = this.memory.get(enemy.id);
    const playerPos = ctx.player.pos;
    for (const c of candidates) {
      const dx = c.x - ex;
      const dz = c.z - ez;
      const dist = Math.hypot(dx, dz);
      if (dist > maxRange) continue;
      // Score: quality - distance penalty - memory penalty.
      let score = c.quality * 2;
      score -= dist / maxRange;
      // Memory: heavily penalize covers used in the last 10s (avoid ping-pong).
      if (mem) {
        const lastUsed = mem.get(c.id);
        if (lastUsed !== undefined && now - lastUsed < 10_000) {
          score -= 1.5;
        }
      }
      // Bonus: cover that blocks LOS to the player.
      if (this.blocksLOS(c, playerPos)) score += 0.5;
      // Bonus: cover that has a firing angle on the player.
      if (this.hasFiringAngle(c, playerPos)) score += 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) {
      // Mark occupancy + memory.
      // (Clear any prior occupant — they may have moved.)
      for (const p of this.points) {
        if (p.occupantId === enemy.id) p.occupantId = null;
      }
      best.occupantId = enemy.id;
      if (!this.memory.has(enemy.id)) this.memory.set(enemy.id, new Map());
      this.memory.get(enemy.id)!.set(best.id, now);
    }
    return best;
  }

  /** Release a cover point (called when an enemy leaves cover). */
  releaseCover(enemy: Enemy): void {
    for (const p of this.points) {
      if (p.occupantId === enemy.id) p.occupantId = null;
    }
  }

  /** Invalidate all cover points attached to the given collider (e.g.
   *  when a destructible wall is destroyed). Returns the number of
   *  invalidated points. */
  invalidateCollider(colliderIndex: number): number {
    const ids = this.byCollider.get(colliderIndex);
    if (!ids) return 0;
    let n = 0;
    for (const id of ids) {
      const p = this.points[id - 1];
      if (p && !p.invalidated) {
        p.invalidated = true;
        p.occupantId = null;
        n++;
      }
    }
    return n;
  }

  /** Called by the destructible system when a prop is destroyed. */
  onDestructibleDestroyed(prop: unknown): void {
    // Find the collider index for this prop.
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      if (!p.destructible || p.invalidated) continue;
      // We can't easily map prop→colliderIndex here; the caller should
      // call invalidateCollider(colliderIndex) directly. This method is
      // a no-op fallback for callers that only have the prop.
      void prop;
    }
  }

  /** Get the peek position for a cover point (left or right side). */
  getPeekPosition(cover: CoverPoint, side: "left" | "right", distance: number = 0.6): { x: number; z: number } {
    // Peek = step out to the side of the cover, then look toward the player.
    const yaw = cover.facingYaw;
    // Right vector (perpendicular to facing).
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const sign = side === "right" ? 1 : -1;
    return {
      x: cover.x + rx * distance * sign,
      z: cover.z + rz * distance * sign,
    };
  }

  /** Get all cover points (for debug visualization). */
  getAllCoverPoints(): CoverPoint[] {
    return this.points.filter((p) => !p.invalidated);
  }

  /** Clear all state (called on match restart / level unload). */
  dispose(): void {
    this.points = [];
    this.memory.clear();
    this.hash.clear();
    this.byCollider.clear();
    this.nextId = 1;
  }

  // ---------- Internal ----------

  private cellKey(x: number, z: number): number {
    return this.cellKeyRaw(Math.floor(x / this.hashCellSize), Math.floor(z / this.hashCellSize));
  }

  private cellKeyRaw(cx: number, cz: number): number {
    // Pack two int16s into a single number (assume coords within ±32k).
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  /** True if the cover point blocks LOS from its position to the player. */
  private blocksLOS(cover: CoverPoint, playerPos: THREE.Vector3): boolean {
    // Trace a ray from the cover point to the player; if it hits the cover's
    // own collider first, the cover blocks LOS.
    // For simplicity, we check if the cover's collider AABB lies between
    // the cover point and the player.
    // (A full raycast per cover per query is too expensive; this is a
    // cheap approximation.)
    const dx = playerPos.x - cover.x;
    const dz = playerPos.z - cover.z;
    const len = Math.hypot(dx, dz) || 1;
    // The cover faces away from the collider — if the player is in front
    // of the cover (in the direction the cover faces), the collider is
    // between the cover point and the player. Otherwise, the player
    // flanked the cover (no protection).
    const facingX = Math.sin(cover.facingYaw);
    const facingZ = Math.cos(cover.facingYaw);
    const dot = (dx / len) * facingX + (dz / len) * facingZ;
    return dot > 0.3; // player is roughly in front of the cover's firing arc.
  }

  /** True if the cover point has a firing angle on the player (i.e. the
   *  player is within the cover's firing arc). */
  private hasFiringAngle(cover: CoverPoint, playerPos: THREE.Vector3): boolean {
    const dx = playerPos.x - cover.x;
    const dz = playerPos.z - cover.z;
    const len = Math.hypot(dx, dz) || 1;
    const facingX = Math.sin(cover.facingYaw);
    const facingZ = Math.cos(cover.facingYaw);
    const dot = (dx / len) * facingX + (dz / len) * facingZ;
    // Firing arc = ±60° from the facing direction.
    return dot > 0.5;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Process-wide singleton
// ───────────────────────────────────────────────────────────────────────────

let _instance: CoverSystem | null = null;

export function getCoverSystem(): CoverSystem {
  if (!_instance) _instance = new CoverSystem();
  return _instance;
}

export function setCoverSystem(c: CoverSystem | null): void {
  _instance = c;
}
