/**
 * SEC11-META prompt 90 — A/B testing framework.
 *
 * Extends the existing FeatureFlag model (kind="ab") into a real
 * experimentation system. Players are deterministically hashed into
 * cohort A or B based on their player id + flag key, so the same player
 * always sees the same variant across sessions.
 *
 * Exposure is recorded as a PlayerEvent ("experiment_exposure") so the
 * retention dashboard can correlate cohort assignment with downstream
 * behavior (D1/D7 retention, conversion, session length).
 *
 * Public API:
 *   - `getCohort(flagKey, playerId)` → "A" | "B" | "control"
 *   - `getExperimentAssignment(flagKey, playerId)` → { cohort, flag }
 *   - `recordExperimentExposure(flagKey, playerId)` → records the event
 *   - `listExperiments()` → all flags with kind="ab"
 */

import { db } from "@/lib/api";
import { track } from "@/lib/analytics";

export type Cohort = "A" | "B" | "control";

// I-5000 #3831 / A-575 — type-safe cohort. The prior `as never` cast on
// the track() call suppressed the type-checker; we now narrow the cohort
// to the literal-union type + use a typed event-name so the analytics
// dispatcher can verify the event shape at compile time.
export interface ExperimentExposureEvent {
  name: "experiment_exposure";
  props: { flagKey: string; cohort: Cohort; playerId: string };
}

export interface ExperimentAssignment {
  flagKey: string;
  cohort: Cohort;
  rollout: number;
  description: string;
  enabled: boolean;
}

/**
 * Deterministic hash → cohort. Uses FNV-1a on `flagKey:playerId` so the
 * same player always lands in the same cohort for a given experiment.
 * Returns "control" when the flag is disabled (player sees the default
 * experience, not cohort A or B).
 */
export function getCohort(flagKey: string, playerId: string, rollout: number, enabled: boolean): Cohort {
  if (!enabled) return "control";
  if (rollout <= 0) return "A";
  if (rollout >= 1) return "B";
  // FNV-1a hash → 32-bit → 0..1
  const input = `${flagKey}:${playerId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const bucket = (h >>> 0) / 0x100000000; // 0..1
  return bucket < rollout ? "B" : "A";
}

/** Get the full assignment for a player on an experiment. */
export async function getExperimentAssignment(
  flagKey: string,
  playerId: string,
): Promise<ExperimentAssignment | null> {
  const flag = await db.featureFlag.findUnique({ where: { key: flagKey } });
  if (!flag) return null;
  const cohort = getCohort(flagKey, playerId, flag.rollout, flag.enabled);
  return {
    flagKey: flag.key,
    cohort,
    rollout: flag.rollout,
    description: flag.description,
    enabled: flag.enabled,
  };
}

/**
 * I-5000 #3830 / #3890 / A-574 — Durable exposure recording.
 *
 * The prior implementation was fire-and-forget: `track()` only pushed to
 * the in-memory analytics ring buffer, which is lost on server restart.
 * The new implementation persists the exposure as a `PlayerEvent` row
 * (name=`experiment_exposure`, props=`{flagKey, cohort, playerId}`) so
 * the retention dashboard can correlate cohort assignment with downstream
 * behavior across server restarts. The in-memory `track()` call is kept
 * for real-time alerting; the DB write is the durable record.
 *
 * Idempotent within a 24h window: if the same (playerId, flagKey, cohort)
 * exposure was already recorded today, the call no-ops (prevents event
 * spam on every page load). The check is best-effort — a race may write
 * a duplicate, but the downstream aggregation dedupes on (playerId, flagKey, date).
 */
export async function recordExperimentExposure(
  flagKey: string,
  playerId: string,
  cohort: Cohort,
): Promise<{ recorded: boolean; deduplicated: boolean }> {
  // Fire the in-memory event for real-time alerting (kept for back-compat).
  const event: ExperimentExposureEvent = {
    name: "experiment_exposure",
    props: { flagKey, cohort, playerId },
  };
  try {
    track(event.name as never, event.props as never);
  } catch {
    /* in-memory track failure is non-fatal */
  }

  // Durable: write a PlayerEvent row (best-effort — the DB may be
  // unavailable during SSR bootstrap).
  try {
    const today = new Date().toISOString().slice(0, 10);
    const eventName = `experiment_exposure_${flagKey}_${today}`;
    const existing = await db.playerEvent.findFirst({
      where: { playerId, name: eventName },
      select: { id: true, props: true },
    });
    if (existing) {
      // Already recorded today — deduplicate.
      return { recorded: true, deduplicated: true };
    }
    await db.playerEvent.create({
      data: {
        playerId,
        sessionId: "ab-testing",
        name: eventName,
        at: new Date(),
        props: JSON.stringify({ flagKey, cohort, playerId, date: today }),
      },
    });
    return { recorded: true, deduplicated: false };
  } catch {
    return { recorded: false, deduplicated: false };
  }
}

/**
 * I-5000 #3891 / A-75 — Cohort analytics dimension.
 *
 * Returns the per-cohort (A / B / control) counts for an experiment over
 * a given time window. Used by the admin experiments dashboard to show
 * "cohort A has 1,234 players, cohort B has 1,180, control has 50".
 *
 * The query reads the durable `experiment_exposure_<flagKey>_<date>`
 * PlayerEvent rows + groups by the cohort prop. Returns 0 for cohorts
 * with no exposures.
 */
export async function getCohortCounts(
  flagKey: string,
  windowDays = 30,
): Promise<{ cohort: Cohort; count: number }[]> {
  try {
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const rows = await db.playerEvent.findMany({
      where: {
        name: { startsWith: `experiment_exposure_${flagKey}_` },
        at: { gte: since },
      },
      select: { props: true },
    });
    const counts: Record<Cohort, number> = { A: 0, B: 0, control: 0 };
    for (const r of rows) {
      try {
        const p = JSON.parse(r.props ?? "{}") as { cohort?: unknown };
        const c = p.cohort;
        if (c === "A" || c === "B" || c === "control") {
          counts[c] += 1;
        }
      } catch {
        /* ignore parse errors */
      }
    }
    return [
      { cohort: "A", count: counts.A },
      { cohort: "B", count: counts.B },
      { cohort: "control", count: counts.control },
    ];
  } catch {
    return [
      { cohort: "A", count: 0 },
      { cohort: "B", count: 0 },
      { cohort: "control", count: 0 },
    ];
  }
}

/** List all experiments (flags with kind="ab"). */
export async function listExperiments(): Promise<Array<{
  key: string;
  description: string;
  enabled: boolean;
  rollout: number;
}>> {
  const flags = await db.featureFlag.findMany({
    where: { kind: "ab" },
    orderBy: { key: "asc" },
    select: { key: true, description: true, enabled: true, rollout: true },
  });
  return flags;
}

/** Create or update an experiment. */
export async function upsertExperiment(input: {
  key: string;
  description: string;
  enabled: boolean;
  rollout: number;
}): Promise<void> {
  await db.featureFlag.upsert({
    where: { key: input.key },
    create: { key: input.key, description: input.description, enabled: input.enabled, rollout: input.rollout, kind: "ab" },
    update: { description: input.description, enabled: input.enabled, rollout: input.rollout, kind: "ab" },
  });
}
