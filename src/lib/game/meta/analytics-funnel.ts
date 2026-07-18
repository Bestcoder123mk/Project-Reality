/**
 * SEC11-META — Player journey analytics funnel.
 *
 * Reconstructs the player journey as an ordered funnel so the LiveOps
 * team can see where players drop off: install → tutorial → first match
 * → second match → first purchase → D7 retained → D30 retained.
 *
 * Input is a stream of PlayerEvents (from /api/telemetry/events). The
 * funnel is computed in-memory on a per-cohort basis (cohort = first-
 * session date bucket). Results are returned in a dashboard-friendly
 * shape with conversion % between each step.
 *
 * Public API:
 *   - `AnalyticsFunnel.define(steps)` → void
 *   - `AnalyticsFunnel.compute(events, cohort)` → FunnelReport
 *   - `AnalyticsFunnel.steps()` → registered steps
 */

export type FunnelEventName =
  | "session_start"
  | "tutorial_complete"
  | "match_start"
  | "shop_buy"
  | "battlepass_claim";

export interface FunnelStep {
  id: string;
  label: string;
  /** Event that qualifies a player for this step. */
  event: FunnelEventName;
  /** Optional predicate over event props. */
  predicate?: (props: Record<string, unknown>) => boolean;
}

export interface PlayerEventRecord {
  playerId: string;
  event: FunnelEventName;
  props: Record<string, unknown>;
  ts: string;
  firstSessionAt: string;
}

export interface FunnelStepResult {
  stepId: string;
  label: string;
  players: number;
  conversionFromPrev: number; // 0..100
  conversionFromStart: number; // 0..100
  medianSecondsFromPrev: number;
}

export interface FunnelReport {
  cohort: string;
  cohortSize: number;
  windowDays: number;
  steps: FunnelStepResult[];
  generatedAt: string;
}

const DEFAULT_STEPS: FunnelStep[] = [
  { id: "install", label: "Install", event: "session_start" },
  { id: "tutorial", label: "Tutorial Complete", event: "tutorial_complete" },
  { id: "first_match", label: "First Match", event: "match_start" },
  { id: "second_match", label: "Second Match", event: "match_start" },
  { id: "first_purchase", label: "First Purchase", event: "shop_buy" },
];

export class AnalyticsFunnel {
  private steps: FunnelStep[];

  constructor(steps: FunnelStep[] = DEFAULT_STEPS) {
    this.steps = steps;
  }

  define(steps: FunnelStep[]): void {
    this.steps = steps;
  }

  stepsList(): FunnelStep[] {
    return [...this.steps];
  }

  /**
   * Compute the funnel for a single cohort. A player "advances" to step N
   * only after qualifying for step N-1 — strict ordering enforced via
   * timestamps per player.
   */
  compute(events: PlayerEventRecord[], cohort: string, windowDays = 30): FunnelReport {
    const cutoffMs = windowDays * 86_400_000;
    const byPlayer = new Map<string, PlayerEventRecord[]>();
    for (const e of events) {
      if (cohort !== "*" && e.firstSessionAt.slice(0, 10) !== cohort) continue;
      const arr = byPlayer.get(e.playerId) ?? [];
      arr.push(e);
      byPlayer.set(e.playerId, arr);
    }

    const stepPlayers = new Array(this.steps.length).fill(0);
    const stepGaps: number[][] = this.steps.map(() => []);

    for (const [, playerEvents] of byPlayer) {
      const sorted = playerEvents.slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      const firstTs = sorted.length ? new Date(sorted[0].ts).getTime() : 0;
      let prevTs = firstTs;
      for (let i = 0; i < this.steps.length; i++) {
        const step = this.steps[i];
        const match = sorted.find(
          (e) =>
            e.event === step.event &&
            (!step.predicate || step.predicate(e.props)) &&
            new Date(e.ts).getTime() - firstTs <= cutoffMs &&
            new Date(e.ts).getTime() >= prevTs,
        );
        if (!match) break;
        stepPlayers[i] += 1;
        stepGaps[i].push((new Date(match.ts).getTime() - prevTs) / 1000);
        prevTs = new Date(match.ts).getTime();
      }
    }

    const cohortSize = byPlayer.size;
    const steps: FunnelStepResult[] = this.steps.map((s, i) => {
      const prev = i === 0 ? cohortSize : stepPlayers[i - 1];
      const median = this.median(stepGaps[i]);
      return {
        stepId: s.id,
        label: s.label,
        players: stepPlayers[i],
        conversionFromPrev: prev > 0 ? (stepPlayers[i] / prev) * 100 : 0,
        conversionFromStart: cohortSize > 0 ? (stepPlayers[i] / cohortSize) * 100 : 0,
        medianSecondsFromPrev: median,
      };
    });

    return { cohort, cohortSize, windowDays, steps, generatedAt: new Date().toISOString() };
  }

  private median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
}
