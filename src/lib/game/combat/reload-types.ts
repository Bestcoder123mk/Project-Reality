/**
 * Section D — Magazine Reload Types (Tactical / Speed / Empty).
 *
 * Real-world firearms training distinguishes three reload types:
 *
 *   1. Tactical Reload — magazine is partially full; player retains the
 *      partial mag (drops it into a pouch) and inserts a fresh one. Slow
 *      but preserves remaining ammo in the partial mag.
 *
 *   2. Speed Reload — magazine is dropped on the ground (regardless of
 *      remaining rounds) and replaced with a fresh one. Faster than
 *      tactical, but the dropped mag's rounds are lost (or must be picked
 *      up later).
 *
 *   3. Empty Reload — magazine is empty; bolt is locked back (BHO weapons)
 *      and must be released, OR the charging handle must be racked (non-BHO
 *      weapons). Slowest of the three.
 *
 * The existing `RELOAD_TYPE_STATS` in `sectionB.ts` covers tactical +
 * speed only. This module adds:
 *
 *   1. Three-type enum including "empty".
 *   2. Per-weapon-type reload animation choice.
 *   3. Reload-time calculation factoring in bolt-catch + magazine type.
 *   4. Mag-retention logic (tactical keeps the partial mag in reserve).
 *   5. Per-reload-stage timing (drop mag / insert mag / charge or release).
 */

import type { WeaponType, WeaponCategory } from "../store";
import { WEAPONS } from "../store";
import type { AttachmentSlug } from "../store";
import { supportsBoltHoldOpen } from "./bolt-catch";

// ─────────────────────────────────────────────────────────────────────────────
// Reload type.
// ─────────────────────────────────────────────────────────────────────────────

export type ReloadType = "tactical" | "speed" | "empty";

export interface ReloadTypeSpec {
  type: ReloadType;
  /** Multiplier on base reload time. */
  timeMult: number;
  /** Whether the old mag is retained (partial mags preserved in reserve). */
  retainOldMag: boolean;
  /** Whether the bolt release / charge handle is required (adds time). */
  requiresBoltAction: boolean;
  /** Audio cue slug. */
  audioCue: string;
}

export const RELOAD_TYPE_SPECS: Record<ReloadType, ReloadTypeSpec> = {
  tactical: {
    type: "tactical",
    timeMult: 1.0,
    retainOldMag: true,
    requiresBoltAction: false,
    audioCue: "reload_tactical",
  },
  speed: {
    type: "speed",
    timeMult: 0.65, // 35% faster
    retainOldMag: false,
    requiresBoltAction: false,
    audioCue: "reload_speed",
  },
  empty: {
    type: "empty",
    timeMult: 1.35, // 35% slower (must chamber a round)
    retainOldMag: true, // empty mag dropped, but no rounds to lose
    requiresBoltAction: true,
    audioCue: "reload_empty",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-stage timing.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReloadStageTimings {
  /** Stage 1: mag drop / mag retrieval from pouch (ms). */
  magDropMs: number;
  /** Stage 2: mag insertion (ms). */
  magInsertMs: number;
  /** Stage 3: bolt release / charge handle (ms, 0 if not required). */
  boltActionMs: number;
  /** Total reload time (ms). */
  totalMs: number;
}

/**
 * Compute per-stage reload timings.
 *
 * Real-world reference:
 *   • Tactical reload: 1.5-3 sec (rifle), 1.5-2 sec (pistol).
 *   • Speed reload: 1-2 sec (rifle), 1-1.5 sec (pistol).
 *   • Empty reload: 2-4 sec (rifle, BHO), 3-5 sec (rifle, charge handle).
 */
export function computeReloadTimings(
  weapon: WeaponType,
  type: ReloadType,
  magazine: AttachmentSlug = "none",
): ReloadStageTimings {
  const cfg = WEAPONS[weapon];
  if (!cfg) {
    return { magDropMs: 0, magInsertMs: 0, boltActionMs: 0, totalMs: 0 };
  }
  const spec = RELOAD_TYPE_SPECS[type];

  // Base reload time from gameplay stat.
  const baseMs = cfg.reloadTime;
  const totalMs = Math.round(baseMs * spec.timeMult);

  // Distribute across stages based on reload type.
  let magDropFrac = 0.30;
  let magInsertFrac = 0.50;
  let boltActionFrac = 0.20;

  if (type === "speed") {
    // Speed reload: drop is fast (just release), insert is normal.
    magDropFrac = 0.20;
    magInsertFrac = 0.65;
    boltActionFrac = 0.15;
  } else if (type === "empty") {
    // Empty reload: drop is fast (mag is empty), insert is normal, bolt action takes longer.
    magDropFrac = 0.25;
    magInsertFrac = 0.45;
    boltActionFrac = 0.30;
  }

  // Magazine attachment affects timing.
  // Extended mag: +20% reload time (heavier).
  // Quick mag: -40% reload time.
  // Drum: +50% reload time.
  let magMult = 1.0;
  if (magazine === "ext_mag") magMult = 1.2;
  else if (magazine === "quick_mag") magMult = 0.6;

  const magDropMs = Math.round(totalMs * magDropFrac * magMult);
  const magInsertMs = Math.round(totalMs * magInsertFrac * magMult);

  // Bolt action stage.
  let boltActionMs = 0;
  if (type === "empty") {
    const supportsBho = supportsBoltHoldOpen(weapon);
    boltActionMs = supportsBho
      ? Math.round(totalMs * boltActionFrac * 0.5)  // BHO release is fast
      : Math.round(totalMs * boltActionFrac * 1.2); // charge handle is slow
  }

  return { magDropMs, magInsertMs, boltActionMs, totalMs: magDropMs + magInsertMs + boltActionMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reload-type selection logic — based on player input + mag state.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReloadContext {
  /** Rounds currently in the magazine. */
  currentRounds: number;
  /** Magazine capacity. */
  magCapacity: number;
  /** Whether the player held the reload key (speed reload) or tapped (tactical). */
  heldReloadKey: boolean;
  /** Whether the player is moving (movement slows reloads). */
  isMoving: boolean;
}

/**
 * Decide which reload type applies based on context.
 *   • Mag empty → always "empty".
 *   • Mag non-empty + held key → "speed".
 *   • Mag non-empty + tapped key → "tactical".
 */
export function selectReloadType(ctx: ReloadContext): ReloadType {
  if (ctx.currentRounds === 0) return "empty";
  return ctx.heldReloadKey ? "speed" : "tactical";
}

// ─────────────────────────────────────────────────────────────────────────────
// Magazine retention — for tactical reloads, the partial mag is preserved.
// ─────────────────────────────────────────────────────────────────────────────

export interface MagazineInstance {
  /** Magazine ID (unique within the player's inventory). */
  id: string;
  /** Rounds currently in this magazine. */
  rounds: number;
  /** Magazine capacity. */
  capacity: number;
  /** Attachment slug (default / ext_mag / quick_mag / drum). */
  type: AttachmentSlug;
}

/**
 * Apply a reload to the player's magazine inventory.
 *
 * @param mags All magazines of this weapon the player owns.
 * @param activeMagIndex Index of the currently-inserted magazine.
 * @param reloadType Reload type chosen.
 * @param newMagRounds The fresh mag's round count (from inventory).
 * @returns Updated mags array + new active index + dropped mag (if speed reload).
 */
export function applyReload(
  mags: MagazineInstance[],
  activeMagIndex: number,
  reloadType: ReloadType,
  newMagRounds: number,
): {
  mags: MagazineInstance[];
  newActiveIndex: number;
  droppedMag: MagazineInstance | null;
} {
  if (activeMagIndex < 0 || activeMagIndex >= mags.length) {
    return { mags, newActiveIndex: activeMagIndex, droppedMag: null };
  }

  const activeMag = mags[activeMagIndex];
  let droppedMag: MagazineInstance | null = null;

  // Speed reload: drop the partial mag on the ground.
  if (reloadType === "speed" && activeMag.rounds > 0) {
    droppedMag = { ...activeMag };
  }

  // Tactical reload: keep the partial mag in inventory (rotate to back).
  // Empty reload: the empty mag stays in inventory (no rounds to lose).
  // (No-clone for empty; the mag is "refilled" by being swapped out.)

  // Find the next mag with the most rounds.
  let bestIdx = -1;
  let bestRounds = -1;
  for (let i = 0; i < mags.length; i++) {
    if (i === activeMagIndex) continue;
    if (mags[i].rounds > bestRounds) {
      bestRounds = mags[i].rounds;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return { mags, newActiveIndex: activeMagIndex, droppedMag };

  // Update the "best" mag's round count to the fresh mag's rounds (simulates
  // pulling a fresh mag from inventory and inserting it).
  const newMags = mags.slice();
  newMags[bestIdx] = { ...newMags[bestIdx], rounds: newMagRounds };

  return { mags: newMags, newActiveIndex: bestIdx, droppedMag };
}

// ─────────────────────────────────────────────────────────────────────────────
// Movement penalty + injury penalty.
// ─────────────────────────────────────────────────────────────────────────────

/** Apply a movement penalty to the reload time. */
export function applyMovementPenalty(timings: ReloadStageTimings, isMoving: boolean): ReloadStageTimings {
  if (!isMoving) return timings;
  const mult = 1.2; // 20% slower while moving.
  return {
    magDropMs: Math.round(timings.magDropMs * mult),
    magInsertMs: Math.round(timings.magInsertMs * mult),
    boltActionMs: Math.round(timings.boltActionMs * mult),
    totalMs: Math.round(timings.totalMs * mult),
  };
}

/** Apply an injury penalty (low HP = slow reload). */
export function applyInjuryPenalty(timings: ReloadStageTimings, hpRatio: number): ReloadStageTimings {
  if (hpRatio >= 0.5) return timings;
  const mult = 1.0 + (0.5 - hpRatio) * 0.8; // up to 40% slower at 0 HP.
  return {
    magDropMs: Math.round(timings.magDropMs * mult),
    magInsertMs: Math.round(timings.magInsertMs * mult),
    boltActionMs: Math.round(timings.boltActionMs * mult),
    totalMs: Math.round(timings.totalMs * mult),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD helpers.
// ─────────────────────────────────────────────────────────────────────────────

export function reloadTypeLabel(type: ReloadType): string {
  switch (type) {
    case "tactical": return "TACTICAL RELOAD";
    case "speed":    return "SPEED RELOAD";
    case "empty":    return "EMPTY RELOAD";
  }
}

export function reloadTypeColor(type: ReloadType): string {
  switch (type) {
    case "tactical": return "#3b82f6"; // blue
    case "speed":    return "#f59e0b"; // amber
    case "empty":    return "#ef4444"; // red
  }
}

/** Progress-bar stages — used by the HUD to show 3-stage progress. */
export function reloadStages(type: ReloadType, timings: ReloadStageTimings): { label: string; durationMs: number }[] {
  const stages: { label: string; durationMs: number }[] = [
    { label: "DROP", durationMs: timings.magDropMs },
    { label: "INSERT", durationMs: timings.magInsertMs },
  ];
  if (type === "empty" && timings.boltActionMs > 0) {
    stages.push({ label: "CHAMBER", durationMs: timings.boltActionMs });
  }
  return stages;
}

/** Category-based default reload type (for AI / NPCs). */
export function defaultReloadTypeForCategory(category: WeaponCategory): ReloadType {
  // NPCs typically tactical-reload unless they're out.
  void category;
  return "tactical";
}
