/**
 * L1-5000 / prompts 4451,4509,4563,4601,4639,4677,4715: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4753,4791,4829,4867,4905,4943,4981 (Crash reporting): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * SEC12-PLATFORM prompt 99 — Crash-free session rate as a tracked metric.
 *
 * Target: 99.5%+ crash-free sessions. A session is "crash-free" when
 * the player's session_start event has a matching session_end event
 * (or inactivity-timeout close) WITHOUT any CrashReport row tied to
 * the session id.
 *
 * Reads from the existing CrashReport table (populated by the
 * `/api/telemetry/errors` route from SEC1) + the PlayerSession table
 * (populated by the SEC11 retention layer).
 *
 * Public API:
 *   - `getCrashFreeRate(windowHours)` — reads CrashReport +
 *     PlayerSession over the last N hours, returns the rate + raw
 *     counts.
 *   - `isCrashFreeTargetMet(windowHours)` — boolean gate the admin
 *     dashboard / alerting pipeline reads.
 *   - `CRASH_FREE_TARGET` — the 99.5% target constant.
 *   - `getCrashTrend(windowHours, bucketHours)` — time-series for the
 *     admin dashboard's crash-free sparkline.
 */

import { db } from "@/lib/db";

// ── Constants ──────────────────────────────────────────────────────────────

/** The 99.5% crash-free target. Below this, the admin dashboard flags red. */
export const CRASH_FREE_TARGET = 0.995;

// ── Types ──────────────────────────────────────────────────────────────────

export interface CrashFreeRateResult {
  /** Window length in hours. */
  windowHours: number;
  /** ISO timestamp the query started from (window start). */
  windowStart: string;
  /** ISO timestamp the query ended at (now). */
  windowEnd: string;
  /** Total sessions in the window. */
  totalSessions: number;
  /** Sessions that ended in a crash (CrashReport with matching sessionId). */
  crashedSessions: number;
  /** Sessions that ended cleanly. */
  crashFreeSessions: number;
  /** Crash-free rate (0..1). 0.995 = 99.5%. */
  rate: number;
  /** True when `rate >= CRASH_FREE_TARGET`. */
  meetsTarget: boolean;
  /** Delta vs target (positive = above target, negative = below). */
  deltaVsTarget: number;
}

export interface CrashTrendBucket {
  /** ISO timestamp of the bucket start. */
  bucketStart: string;
  /** Total sessions in the bucket. */
  totalSessions: number;
  /** Crashed sessions in the bucket. */
  crashedSessions: number;
  /** Crash-free rate (0..1) for the bucket. 0 when no sessions. */
  rate: number;
}

export interface CrashTrendResult {
  windowHours: number;
  bucketHours: number;
  buckets: CrashTrendBucket[];
  /** Overall rate across the whole window. */
  overall: CrashFreeRateResult;
}

// ── Pure helpers (unit-testable without DB) ────────────────────────────────

/**
 * Compute the crash-free rate from raw counts. Pure function — the
 * DB-facing `getCrashFreeRate` calls this with the real counts; tests
 * call it with synthetic counts.
 *
 *   rate = (total - crashed) / total
 *
 * Returns 1.0 when total is 0 (no sessions → vacuously crash-free).
 */
export function computeCrashFreeRate(totalSessions: number, crashedSessions: number): number {
  if (totalSessions <= 0) return 1;
  if (crashedSessions < 0) crashedSessions = 0;
  if (crashedSessions > totalSessions) crashedSessions = totalSessions;
  const free = totalSessions - crashedSessions;
  return free / totalSessions;
}

/** Boolean gate: rate >= target. */
export function isRateMeetingTarget(rate: number, target = CRASH_FREE_TARGET): boolean {
  return rate >= target;
}

/**
 * Bucket a timestamp into N-hour buckets. Used by `getCrashTrend` to
 * build the sparkline. Pure function — testable without DB.
 */
export function bucketTimestamp(ts: Date, bucketHours: number): Date {
  const bucketMs = bucketHours * 3_600_000;
  return new Date(Math.floor(ts.getTime() / bucketMs) * bucketMs);
}

// ── DB-facing functions ────────────────────────────────────────────────────

/**
 * Compute the crash-free rate over the last `windowHours` hours.
 *
 *   - Sessions = PlayerSession rows with startedAt >= windowStart.
 *   - Crashed sessions = sessions whose sessionId appears in CrashReport
 *     with at >= windowStart.
 *
 * The match is on `sessionId` (a stable uuid per session, generated
 * client-side + sent with every event). When a session has multiple
 * crash reports, it counts as one crashed session (we use `distinct`
 * on sessionId).
 */
export async function getCrashFreeRate(windowHours = 24): Promise<CrashFreeRateResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowHours * 3_600_000);

  const [totalSessions, crashedSessionRows] = await Promise.all([
    db.playerSession.count({
      where: { startedAt: { gte: windowStart } },
    }),
    db.crashReport.findMany({
      where: { at: { gte: windowStart } },
      select: { sessionId: true },
      distinct: ["sessionId"],
    }),
  ]);

  // Crashed sessions = distinct crashReport.sessionId values that ALSO
  // have a playerSession row in the window. (A crash report without a
  // matching session row is a session that crashed before the
  // session_start event was persisted — count it as a crashed session
  // anyway, since the player experienced a crash.)
  const crashedSessionIds = new Set(crashedSessionRows.map((r) => r.sessionId));
  const crashedSessions = crashedSessionIds.size;

  const rate = computeCrashFreeRate(totalSessions, crashedSessions);
  const meetsTarget = isRateMeetingTarget(rate);

  return {
    windowHours,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    totalSessions,
    crashedSessions,
    crashFreeSessions: totalSessions - crashedSessions,
    rate,
    meetsTarget,
    deltaVsTarget: rate - CRASH_FREE_TARGET,
  };
}

/** Boolean gate the admin dashboard / alerting pipeline reads. */
export async function isCrashFreeTargetMet(windowHours = 24): Promise<boolean> {
  const r = await getCrashFreeRate(windowHours);
  return r.meetsTarget;
}

/**
 * Time-series of crash-free rate over the last `windowHours`, bucketed
 * into `bucketHours` chunks. Used by the admin dashboard's sparkline.
 *
 * Buckets align to `bucketHours` boundaries (UTC). The last bucket is
 * partial (from the last boundary to now) — its rate reflects the
 * in-progress window.
 */
export async function getCrashTrend(
  windowHours = 168, // 1 week default
  bucketHours = 24, // 1-day buckets default
): Promise<CrashTrendResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowHours * 3_600_000);
  const bucketMs = bucketHours * 3_600_000;

  const [sessions, crashes] = await Promise.all([
    db.playerSession.findMany({
      where: { startedAt: { gte: windowStart } },
      select: { sessionId: true, startedAt: true },
    }),
    db.crashReport.findMany({
      where: { at: { gte: windowStart } },
      select: { sessionId: true, at: true },
    }),
  ]);

  // Bucket sessions by startedAt.
  const sessionBuckets = new Map<number, Set<string>>();
  for (const s of sessions) {
    const bucket = Math.floor(s.startedAt.getTime() / bucketMs) * bucketMs;
    if (!sessionBuckets.has(bucket)) sessionBuckets.set(bucket, new Set());
    sessionBuckets.get(bucket)!.add(s.sessionId);
  }

  // Bucket crashed sessions by their first crash at.
  const crashBuckets = new Map<number, Set<string>>();
  for (const c of crashes) {
    const bucket = Math.floor(c.at.getTime() / bucketMs) * bucketMs;
    if (!crashBuckets.has(bucket)) crashBuckets.set(bucket, new Set());
    crashBuckets.get(bucket)!.add(c.sessionId);
  }

  // Build the bucket list — every bucket between windowStart and now,
  // even empty ones (so the sparkline shows gaps).
  const buckets: CrashTrendBucket[] = [];
  for (let t = Math.floor(windowStart.getTime() / bucketMs) * bucketMs; t <= now.getTime(); t += bucketMs) {
    const sessionSet = sessionBuckets.get(t);
    const crashSet = crashBuckets.get(t);
    const total = sessionSet?.size ?? 0;
    const crashed = crashSet?.size ?? 0;
    const rate = computeCrashFreeRate(total, crashed);
    buckets.push({
      bucketStart: new Date(t).toISOString(),
      totalSessions: total,
      crashedSessions: crashed,
      rate,
    });
  }

  const overall = await getCrashFreeRate(windowHours);
  return {
    windowHours,
    bucketHours,
    buckets,
    overall,
  };
}
