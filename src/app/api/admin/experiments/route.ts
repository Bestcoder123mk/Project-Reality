import { NextResponse, type NextRequest } from "next/server";
import { listExperiments, upsertExperiment, getCohortCounts } from "@/lib/game/meta/ab-testing";
import { withAdminAudit } from "@/lib/security/audit-log";
import { adminExperimentSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { sanitizeFreeText } from "@/lib/security/sanitize";

/**
 * GET  /api/admin/experiments — list all A/B experiments + their cohort counts.
 * POST /api/admin/experiments — create/update an experiment.
 * Non-player-facing admin route (prompt 90).
 *
 * Task-1 (SEC) item 1, 2, 6, 8, 10: gated behind the shared-secret admin
 * bearer header. POST body is size-capped + Zod-validated + sanitized.
 * Every call is recorded in the AuditLog table.
 *
 * Section H-5000 (3775) — server-authoritative experiments: experiment
 * configs are persisted server-side (Experiment row); the client only
 * reads rollout decisions via the bootstrap endpoint, never writes.
 *
 * I-5000 #3891 / A-75 — cohort analytics dimension. The GET response now
 * includes per-cohort (A / B / control) player counts for each
 * experiment (default 30-day window). Live-ops uses this to decide when
 * an experiment has enough exposure for statistical significance.
 */
export async function GET(req: NextRequest) {
  return withAdminAudit(req, async () => {
    try {
      const url = new URL(req.url);
      const windowDays = Math.max(1, Math.min(365, Number(url.searchParams.get("windowDays") ?? "30")));
      const experiments = await listExperiments();
      // I-5000 #3891 — fetch cohort counts for each experiment in parallel.
      const withCounts = await Promise.all(
        experiments.map(async (e) => ({
          ...e,
          cohorts: await getCohortCounts(e.key, windowDays),
        })),
      );
      return NextResponse.json({ experiments: withCounts, windowDays });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "list failed" },
        { status: 500 },
      );
    }
  });
}

export async function POST(req: NextRequest) {
  // Body-size limit: 4KB is plenty for a single experiment config.
  const { json, error } = await readBoundedJson(req, { maxBytes: 4096 });
  if (error) return error;

  const parsed = adminExperimentSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid experiment body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Sanitize the free-text description before storage.
  const sanitizedDescription = sanitizeFreeText(parsed.data.description ?? "", {
    maxLength: 500,
  });

  return withAdminAudit(
    req,
    async () => {
      try {
        await upsertExperiment({
          key: parsed.data.key,
          description: sanitizedDescription ?? "",
          enabled: parsed.data.enabled ?? true,
          rollout: parsed.data.rollout ?? 0.5,
        });
        return NextResponse.json({ ok: true });
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "upsert failed" },
          { status: 500 },
        );
      }
    },
    { payloadOverride: { ...parsed.data, description: "<sanitized>" } },
  );
}
