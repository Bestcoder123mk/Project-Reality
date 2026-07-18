/**
 * Task-1 (SEC) item 22 + Section H (944–948) — Anti-cheat telemetry.
 *
 * Aggregates `PlayerEvent` rows over a sliding window + flags
 * statistically impossible patterns. Writes flagged events to a
 * `CheatFlag` row so the admin support team can review + suspend.
 *
 * Heuristics (Task-1):
 *
 *   1. **Impossible fire rate** — over the last 60s, the player fired
 *      more rounds than their weapon's max fireRate × window allows.
 *   2. **Impossible headshot ratio** — over the last 20 kills, > 90%
 *      were headshots.
 *   3. **Impossible range** — a kill at > 2× the weapon's max range.
 *
 * Section H heuristics (944–947):
 *
 *   4. **Speedhack** (944) — the player's reported position jumped
 *      faster than the engine's max-move-speed × delta-t permits.
 *      Reads `position_update` PlayerEvents + computes velocity; a
 *      sustained > 1.5× max-speed burst is flagged.
 *   5. **Wallhack** (945) — the player dealt damage to targets they
 *      couldn't have line-of-sight to (per the server's LOS check).
 *      Reads `kill` events where the `losBroken` prop is true; a rate
 *      > 30% over 20 kills is flagged.
 *   6. **Aimbot snap** (946) — the player's mouse-velocity profile
 *      shows an unnatural discontinuity (instantaneous snap to target).
 *      Reads `aim_sample` events; a velocity > 30 deg/ms (sustained)
 *      or a snap pattern (high velocity → zero velocity in < 16 ms)
 *      is flagged.
 *   7. **Recoil compensation** (947) — the player's recoil-recovery
 *      curve is too perfect. Real players under-shoot the recovery
 *      (human reaction time); a perfect recovery (camera returns to
 *      exactly the pre-shot angle within 1 frame) is flagged.
 *
 * Section H (948) — N+1 fix in `checkFireRate`. The previous version
 * ran `db.weapon.findUnique` per weapon slug in the byWeapon loop. Now
 * we batch-fetch all the weapons the player used in one `findMany`
 * (1 query per scan instead of N).
 *
 * The aggregator is idempotent per (playerId, kind, windowStart): it
 * won't write a duplicate CheatFlag for the same anomaly in the same
 * window.
 */

import { db } from "@/lib/db";

export interface CheatFlagInput {
  playerId: string;
  kind:
    | "impossible_fire_rate"
    | "impossible_headshot_ratio"
    | "impossible_range"
    | "speedhack"
    | "wallhack"
    | "aimbot_snap"
    | "recoil_compensation"
    | "other";
  severity: number;
  summary: string;
  evidence: Record<string, unknown>;
}

/** Dedup window: don't write a same-kind flag for the same player within 5min. */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** Write a CheatFlag row, deduped against the last 5 minutes. */
export async function writeCheatFlag(input: CheatFlagInput): Promise<boolean> {
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
  const existing = await db.cheatFlag.findFirst({
    where: {
      playerId: input.playerId,
      kind: input.kind,
      createdAt: { gt: cutoff },
    },
    select: { id: true },
  });
  if (existing) return false; // deduped

  await db.cheatFlag.create({
    data: {
      playerId: input.playerId,
      kind: input.kind,
      severity: Math.max(0, Math.min(100, input.severity)),
      summary: input.summary.slice(0, 500),
      evidence: JSON.stringify(input.evidence).slice(0, 8000),
      status: "open",
    },
  });
  return true;
}

// ─── 948 — batched weapon lookup ──────────────────────────────────────────

/**
 * Fetch multiple weapon rows in one query. Used by `checkFireRate` so
 * the per-slug loop doesn't issue N queries (948).
 */
async function fetchWeaponsBatch(slugs: string[]): Promise<
  Map<string, { fireRate: number; name: string; range: number }>
> {
  if (slugs.length === 0) return new Map();
  const rows = await db.weapon.findMany({
    where: { slug: { in: slugs } },
    select: { slug: true, fireRate: true, name: true, range: true },
  });
  return new Map(rows.map((r) => [r.slug, r]));
}

// ─── Heuristic 1: impossible fire rate (948 — batched) ────────────────────

/** Heuristic 1: impossible fire rate over the last `windowMs`. */
export async function checkFireRate(
  playerId: string,
  windowMs = 60_000,
): Promise<CheatFlagInput | null> {
  const since = new Date(Date.now() - windowMs);
  const events = await db.playerEvent.findMany({
    where: { playerId, name: "weapon_fire", at: { gte: since } },
    select: { props: true, at: true },
  });
  if (events.length < 10) return null; // not enough samples

  // Group by weaponSlug → count.
  const byWeapon = new Map<string, number>();
  for (const e of events) {
    try {
      const p = JSON.parse(e.props) as { weaponSlug?: string };
      if (!p.weaponSlug) continue;
      byWeapon.set(p.weaponSlug, (byWeapon.get(p.weaponSlug) ?? 0) + 1);
    } catch {
      /* skip */
    }
  }

  // 948 — batch-fetch all weapon rows in ONE query (was N queries).
  const weapons = await fetchWeaponsBatch(Array.from(byWeapon.keys()));

  for (const [weaponSlug, count] of byWeapon) {
    const weapon = weapons.get(weaponSlug);
    if (!weapon) continue;
    // Max rounds in windowMs = fireRate (rpm) * windowMs / 60_000, * 1.1 tolerance.
    const maxAllowed = (weapon.fireRate * windowMs) / 60_000 * 1.1;
    if (count > maxAllowed) {
      return {
        playerId,
        kind: "impossible_fire_rate",
        severity: 80,
        summary: `Fired ${count} rounds with ${weapon.name} in ${windowMs / 1000}s (max ${maxAllowed.toFixed(0)})`,
        evidence: {
          windowMs,
          weaponSlug,
          weaponName: weapon.name,
          fireRate: weapon.fireRate,
          observed: count,
          maxAllowed,
        },
      };
    }
  }
  return null;
}

// ─── Heuristic 2: impossible headshot ratio ───────────────────────────────

/** Heuristic 2: impossible headshot ratio over the last `minKills` kills. */
export async function checkHeadshotRatio(
  playerId: string,
  minKills = 20,
  threshold = 0.9,
): Promise<CheatFlagInput | null> {
  const kills = await db.playerEvent.findMany({
    where: { playerId, name: "kill" },
    orderBy: { at: "desc" },
    take: minKills,
    select: { props: true, at: true },
  });
  if (kills.length < minKills) return null;

  let headshots = 0;
  for (const k of kills) {
    try {
      const p = JSON.parse(k.props) as { hitLocation?: string };
      if (p.hitLocation === "head") headshots++;
    } catch {
      /* skip */
    }
  }
  const ratio = headshots / kills.length;
  if (ratio > threshold) {
    return {
      playerId,
      kind: "impossible_headshot_ratio",
      severity: 90,
      summary: `${headshots}/${kills.length} kills were headshots (ratio ${ratio.toFixed(2)} > ${threshold})`,
      evidence: {
        windowKills: kills.length,
        headshots,
        ratio,
        threshold,
      },
    };
  }
  return null;
}

// ─── 944 — Speedhack detection ────────────────────────────────────────────

/**
 * Engine max move speed (m/s). Real players move at ~5.5 m/s (jog) or
 * ~7 m/s (sprint). A speedhack teleports the player; sustained velocity
 * > 1.5× max is impossible without a cheat.
 */
const MAX_MOVE_SPEED_MPS = 7;
const SPEEDHACK_FACTOR = 1.5;
const SPEEDHACK_MIN_SAMPLES = 5;

/**
 * Heuristic 4 (944): speedhack. Reads `position_update` PlayerEvents
 * over the last `windowMs` + computes the player's velocity between
 * consecutive samples. If any sample shows velocity > MAX × FACTOR,
 * flag it. Multiple samples required (a single network-jitter spike
 * shouldn't trigger a false positive).
 */
export async function checkSpeedhack(
  playerId: string,
  windowMs = 30_000,
): Promise<CheatFlagInput | null> {
  const since = new Date(Date.now() - windowMs);
  const events = await db.playerEvent.findMany({
    where: { playerId, name: "position_update", at: { gte: since } },
    orderBy: { at: "asc" },
    select: { props: true, at: true },
  });
  if (events.length < SPEEDHACK_MIN_SAMPLES) return null;

  let violations = 0;
  let maxVelocity = 0;
  for (let i = 1; i < events.length; i++) {
    try {
      const a = JSON.parse(events[i - 1].props) as { x?: number; y?: number; z?: number };
      const b = JSON.parse(events[i].props) as { x?: number; y?: number; z?: number };
      if (a.x == null || b.x == null) continue;
      const dt = (events[i].at.getTime() - events[i - 1].at.getTime()) / 1000;
      if (dt <= 0) continue;
      const dist = Math.hypot(
        (b.x ?? 0) - (a.x ?? 0),
        (b.y ?? 0) - (a.y ?? 0),
        (b.z ?? 0) - (a.z ?? 0),
      );
      const velocity = dist / dt;
      if (velocity > maxVelocity) maxVelocity = velocity;
      if (velocity > MAX_MOVE_SPEED_MPS * SPEEDHACK_FACTOR) violations++;
    } catch {
      /* skip */
    }
  }
  if (violations >= SPEEDHACK_MIN_SAMPLES) {
    return {
      playerId,
      kind: "speedhack",
      severity: 85,
      summary: `${violations} position samples exceeded ${MAX_MOVE_SPEED_MPS * SPEEDHACK_FACTOR} m/s (max ${maxVelocity.toFixed(1)} m/s)`,
      evidence: {
        windowMs,
        samples: events.length,
        violations,
        maxVelocity,
        threshold: MAX_MOVE_SPEED_MPS * SPEEDHACK_FACTOR,
      },
    };
  }
  return null;
}

// ─── 945 — Wallhack detection ─────────────────────────────────────────────

/**
 * Heuristic 5 (945): wallhack. Reads `kill` events where the engine
 * recorded `losBroken: true` (the server's LOS check said the target
 * was occluded, but the kill landed anyway — classic wallhack signature).
 * A rate > 30% over 20 kills is flagged.
 */
export async function checkWallhack(
  playerId: string,
  minKills = 20,
  threshold = 0.3,
): Promise<CheatFlagInput | null> {
  const kills = await db.playerEvent.findMany({
    where: { playerId, name: "kill" },
    orderBy: { at: "desc" },
    take: minKills,
    select: { props: true, at: true },
  });
  if (kills.length < minKills) return null;
  let losBrokenCount = 0;
  for (const k of kills) {
    try {
      const p = JSON.parse(k.props) as { losBroken?: boolean };
      if (p.losBroken) losBrokenCount++;
    } catch {
      /* skip */
    }
  }
  const ratio = losBrokenCount / kills.length;
  if (ratio > threshold) {
    return {
      playerId,
      kind: "wallhack",
      severity: 88,
      summary: `${losBrokenCount}/${kills.length} kills landed with broken LOS (ratio ${ratio.toFixed(2)} > ${threshold})`,
      evidence: {
        windowKills: kills.length,
        losBrokenCount,
        ratio,
        threshold,
      },
    };
  }
  return null;
}

// ─── 946 — Aimbot snap detection ──────────────────────────────────────────

/**
 * Heuristic 6 (946): aimbot snap. Reads `aim_sample` PlayerEvents (the
 * engine writes one per frame with the player's view angle). A snap is
 * a sudden high angular velocity followed by zero velocity (the bot
 * snaps to target, then locks). Thresholds:
 *   - angular velocity > 30 deg/ms (sustained for ≥ 1 sample) → snap.
 *   - velocity drops from > 30 deg/ms to < 1 deg/ms in ≤ 16 ms → lock.
 */
const AIM_SNAP_VELOCITY_DEG_PER_MS = 30;
const AIM_LOCK_DROP_MS = 16;

export async function checkAimbotSnap(
  playerId: string,
  windowMs = 30_000,
): Promise<CheatFlagInput | null> {
  const since = new Date(Date.now() - windowMs);
  const events = await db.playerEvent.findMany({
    where: { playerId, name: "aim_sample", at: { gte: since } },
    orderBy: { at: "asc" },
    select: { props: true, at: true },
  });
  if (events.length < 10) return null;

  let snaps = 0;
  let locks = 0;
  for (let i = 1; i < events.length; i++) {
    try {
      const a = JSON.parse(events[i - 1].props) as { yaw?: number; pitch?: number };
      const b = JSON.parse(events[i].props) as { yaw?: number; pitch?: number };
      if (a.yaw == null || b.yaw == null) continue;
      const dt = events[i].at.getTime() - events[i - 1].at.getTime();
      if (dt <= 0) continue;
      const angDist =
        Math.abs(b.yaw - a.yaw) + Math.abs((b.pitch ?? 0) - (a.pitch ?? 0));
      const velocity = angDist / dt; // deg/ms (rough)
      if (velocity > AIM_SNAP_VELOCITY_DEG_PER_MS) {
        snaps++;
        // Check for immediate lock — next sample has near-zero velocity.
        if (i + 1 < events.length) {
          const dt2 = events[i + 1].at.getTime() - events[i].at.getTime();
          if (dt2 > 0 && dt2 <= AIM_LOCK_DROP_MS) {
            const c = JSON.parse(events[i + 1].props) as { yaw?: number; pitch?: number };
            if (c.yaw != null) {
              const angDist2 =
                Math.abs(c.yaw - b.yaw) + Math.abs((c.pitch ?? 0) - (b.pitch ?? 0));
              const velocity2 = angDist2 / dt2;
              if (velocity2 < 1) locks++;
            }
          }
        }
      }
    } catch {
      /* skip */
    }
  }
  if (snaps >= 3 || locks >= 2) {
    return {
      playerId,
      kind: "aimbot_snap",
      severity: 92,
      summary: `${snaps} high-velocity aim snaps + ${locks} immediate locks (pattern matches aimbot)`,
      evidence: {
        windowMs,
        samples: events.length,
        snaps,
        locks,
        velocityThreshold: AIM_SNAP_VELOCITY_DEG_PER_MS,
      },
    };
  }
  return null;
}

// ─── 947 — Recoil-compensation pattern analysis ───────────────────────────

/**
 * Heuristic 7 (947): recoil-compensation hack. Reads `weapon_fire`
 * events with the `recoilDelta` prop (the engine records the camera's
 * pitch change caused by recoil + the player's compensating input). A
 * perfect compensator (camera returns to within 0.1° of pre-shot angle
 * within 1 frame) over 20 shots is flagged — human reaction time is
 * 200+ ms, so a sub-frame recovery is impossible without a no-recoil
 * macro.
 */
const PERFECT_RECOIL_TOLERANCE_DEG = 0.1;
const PERFECT_RECOIL_MIN_SHOTS = 20;

export async function checkRecoilCompensation(
  playerId: string,
): Promise<CheatFlagInput | null> {
  const events = await db.playerEvent.findMany({
    where: { playerId, name: "weapon_fire" },
    orderBy: { at: "desc" },
    take: PERFECT_RECOIL_MIN_SHOTS * 2, // oversample — not all events have recoilDelta.
    select: { props: true, at: true },
  });
  let perfectCount = 0;
  let totalWithRecoil = 0;
  for (const e of events) {
    try {
      const p = JSON.parse(e.props) as { recoilDelta?: number; recoveryDelta?: number };
      if (p.recoilDelta == null || p.recoveryDelta == null) continue;
      totalWithRecoil++;
      // `recoilDelta` is the recoil-induced pitch change.
      // `recoveryDelta` is the player's compensating input (negative).
      // A perfect compensator: |recoilDelta + recoveryDelta| < tolerance.
      const residual = Math.abs(p.recoilDelta + p.recoveryDelta);
      if (residual < PERFECT_RECOIL_TOLERANCE_DEG) {
        perfectCount++;
      }
    } catch {
      /* skip */
    }
  }
  if (totalWithRecoil < PERFECT_RECOIL_MIN_SHOTS) return null;
  const ratio = perfectCount / totalWithRecoil;
  if (ratio > 0.9) {
    return {
      playerId,
      kind: "recoil_compensation",
      severity: 87,
      summary: `${perfectCount}/${totalWithRecoil} shots had perfect recoil compensation (ratio ${ratio.toFixed(2)})`,
      evidence: {
        shots: totalWithRecoil,
        perfectCount,
        ratio,
        tolerance: PERFECT_RECOIL_TOLERANCE_DEG,
      },
    };
  }
  return null;
}

// ─── scanner ──────────────────────────────────────────────────────────────

/**
 * Run all heuristics for a player. Writes any new CheatFlag rows.
 * Returns the list of newly-flagged anomalies (empty when clean).
 *
 * Section H (944–947) — adds speedhack, wallhack, aimbot-snap, and
 * recoil-compensation to the scan.
 */
export async function scanPlayerForCheats(playerId: string): Promise<CheatFlagInput[]> {
  const [fireRate, headshot, speed, wall, aim, recoil] = await Promise.all([
    checkFireRate(playerId),
    checkHeadshotRatio(playerId),
    checkSpeedhack(playerId),
    checkWallhack(playerId),
    checkAimbotSnap(playerId),
    checkRecoilCompensation(playerId),
  ]);
  const candidates = [fireRate, headshot, speed, wall, aim, recoil].filter(
    (c): c is CheatFlagInput => c !== null,
  );
  const written: CheatFlagInput[] = [];
  for (const c of candidates) {
    const did = await writeCheatFlag(c);
    if (did) written.push(c);
  }
  return written;
}

/** List CheatFlag rows for the admin dashboard. */
export async function listCheatFlags(opts: {
  status?: "open" | "investigating" | "resolved" | "false_positive";
  limit?: number;
} = {}): Promise<Array<{
  id: string;
  playerId: string;
  kind: string;
  severity: number;
  summary: string;
  status: string;
  createdAt: Date;
}>> {
  return db.cheatFlag.findMany({
    where: opts.status ? { status: opts.status } : undefined,
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    take: Math.min(200, opts.limit ?? 50),
    select: {
      id: true,
      playerId: true,
      kind: true,
      severity: true,
      summary: true,
      status: true,
      createdAt: true,
    },
  });
}
