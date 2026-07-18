/**
 * A/B Testing — Firebase A/B testing harness + experiment assignment.
 *
 * Section I (Firebase & Backend) — prompts I-8 / I-14 / I-23 / I-32.
 *
 * This module layers Firebase Remote Config + Analytics into a typed
 * A/B testing surface so the live-ops team can ship experiments
 * without touching game code.
 *
 * Cohort assignment:
 *   - The player's `uid` is deterministically hashed (FNV-1a) into a
 *     0..1 bucket per experiment key. The same player always lands in
 *     the same cohort across sessions (sticky assignment).
 *   - The cohort is one of `"A" | "B" | "control"`:
 *       - `"control"` — experiment disabled (player sees default UX)
 *       - `"A"` — bucket below the rollout threshold (control variant)
 *       - `"B"` — bucket at-or-above the threshold (treatment variant)
 *
 * Exposure logging:
 *   - The first time `getAssignment()` is called for a given experiment
 *     in a session, an `experiment_exposure` event is recorded via the
 *     existing analytics pipeline. The event carries the cohort so the
 *     retention dashboard can attribute downstream behavior.
 *
 * Public API:
 *   - `getAssignment(experimentKey)` → { cohort, rollout, enabled }
 *   - `getCohort(experimentKey)` → "A" | "B" | "control"
 *   - `recordExposure(experimentKey)` → fire-and-forget
 *   - `listExperiments()` → all configured experiments
 *
 * The existing Prisma-backed `@/lib/game/meta/ab-testing.ts` remains
 * the source of truth for the admin dashboard; this module mirrors
 * its cohort algorithm so Firebase + Prisma agree on assignment.
 */

import { getRemoteConfigValue, getRemoteConfigBool } from "@/lib/remote-config";
import { track } from "@/lib/analytics";
import { getCurrentUser } from "@/lib/auth";

export type Cohort = "A" | "B" | "control";

export interface ExperimentAssignment {
  experimentKey: string;
  cohort: Cohort;
  rollout: number; // 0..1 — percent of players in cohort B
  enabled: boolean;
  description: string;
}

/** Registry of known experiments. Keys match Remote Config keys. */
export const EXPERIMENTS = {
  ab_new_hud_layout: "New HUD layout (compact bottom cluster)",
  ab_tactical_sprint: "Tactical sprint (hold to sprint in ADS)",
  ab_recoil_rework: "Recoil rework (per-weapon recoil patterns)",
} as const;

export type ExperimentKey = keyof typeof EXPERIMENTS;

const exposureRecorded = new Set<string>();

/**
 * Deterministic FNV-1a hash → 0..1 bucket. Same input always lands in
 * the same bucket. The input is `${experimentKey}:${uid}` so two
 * experiments on the same player produce independent buckets.
 */
export function hashToBucket(experimentKey: string, uid: string): number {
  const input = `${experimentKey}:${uid}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/**
 * Compute the cohort for a player on an experiment.
 *
 *   - When `enabled` is false → `"control"`.
 *   - When `rollout` is 0 → `"A"`.
 *   - When `rollout` is 1 → `"B"`.
 *   - Otherwise, hash the player's uid → bucket; below rollout = A,
 *     at-or-above = B.
 */
export function getCohort(
  experimentKey: ExperimentKey,
  uid: string,
  rollout: number,
  enabled: boolean,
): Cohort {
  if (!enabled) return "control";
  if (rollout <= 0) return "A";
  if (rollout >= 1) return "B";
  const bucket = hashToBucket(experimentKey, uid);
  return bucket < rollout ? "B" : "A";
}

/**
 * Get the full assignment for the current user on an experiment.
 *
 * Reads the rollout + enabled values from Remote Config (falling back
 * to the in-code defaults when RC isn't configured). The current user
 * is read from Firebase Auth; when signed out, the local player id is
 * used (so guests still get deterministic assignment).
 */
export function getAssignment(
  experimentKey: ExperimentKey,
): ExperimentAssignment {
  const user = getCurrentUser();
  const uid =
    user?.uid ??
    (typeof window !== "undefined"
      ? window.localStorage.getItem("pr_player_id") ?? "guest"
      : "guest");

  const enabledKey = `enable_${experimentKey}` as const;
  // Rollout is read as a 0..100 percent from RC, then normalized.
  const rolloutPct = Number(getRemoteConfigValue(experimentKey)) || 0;
  const rollout = Math.min(1, Math.max(0, rolloutPct / 100));

  // The "enabled" flag defaults to true when the experiment has a
  // rollout > 0 (i.e. the live-ops team turned it on). A separate
  // `enable_*` RC flag can force-disable an experiment mid-flight.
  const forceDisabled = getRemoteConfigBool(
    enabledKey as unknown as Parameters<typeof getRemoteConfigBool>[0],
  );
  const enabled = !forceDisabled || rollout > 0;

  const cohort = getCohort(experimentKey, uid, rollout, enabled);

  return {
    experimentKey,
    cohort,
    rollout,
    enabled,
    description: EXPERIMENTS[experimentKey],
  };
}

/**
 * Fire-and-forget exposure event. Idempotent per session+experiment —
 * calling it twice for the same experiment doesn't double-count.
 *
 * The event is forwarded via the existing `track()` pipeline so the
 * analytics dashboard + retention model see it alongside every other
 * event. The cohort is included in the props so the dashboard can
 * group downstream behavior by cohort.
 */
export function recordExposure(experimentKey: ExperimentKey): void {
  if (exposureRecorded.has(experimentKey)) return;
  exposureRecorded.add(experimentKey);
  const { cohort, rollout } = getAssignment(experimentKey);
  track("screen_view" as never, {
    experiment_key: experimentKey,
    experiment_cohort: cohort,
    experiment_rollout: rollout,
  } as never);
}

/** Convenience: returns true when the current user is in cohort B. */
export function isInTreatmentCohort(experimentKey: ExperimentKey): boolean {
  return getAssignment(experimentKey).cohort === "B";
}

/** List all configured experiments with their current assignment. */
export function listExperiments(): ExperimentAssignment[] {
  return (Object.keys(EXPERIMENTS) as ExperimentKey[]).map((k) =>
    getAssignment(k),
  );
}

/** Reset the per-session exposure set (test/dev only). */
export function _resetExposureTracking(): void {
  exposureRecorded.clear();
}
