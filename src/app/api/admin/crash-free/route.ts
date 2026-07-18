import { NextResponse, type NextRequest } from "next/server";
import {
  getCrashFreeRate,
  getCrashTrend,
  CRASH_FREE_TARGET,
} from "@/lib/game/platform/crash-free-metric";
import { withAdminAudit } from "@/lib/security/audit-log";

/**
 * GET /api/admin/crash-free — crash-free session rate (prompt 99).
 *
 * Query params:
 *   - windowHours (default 24) — the rolling window for the rate.
 *   - trend (default "0") — when "1", also returns the time-series
 *     sparkline (windowHours / bucketHours buckets).
 *   - bucketHours (default 24) — the sparkline bucket size.
 *
 * Returns the rate (0..1), the raw counts, the target, + whether the
 * target is met. Non-player-facing admin route.
 *
 * Task-1 (SEC) item 1, 2, 10: gated behind the shared-secret admin
 * bearer header. Every call is recorded in the AuditLog table.
 *
 * Section H-5000 (3777) — server-authoritative crash-free metric: the
 * rate is computed server-side from the CrashReport table; the client
 * never reports its own crash-free status, only queries the aggregate.
 */
export async function GET(req: NextRequest) {
  return withAdminAudit(req, async () => {
    try {
      const url = new URL(req.url);
      const windowHours = Math.max(1, Math.min(720, Number(url.searchParams.get("windowHours") ?? "24")));
      const withTrend = url.searchParams.get("trend") === "1";
      const bucketHours = Math.max(1, Math.min(168, Number(url.searchParams.get("bucketHours") ?? "24")));

      const rate = await getCrashFreeRate(windowHours);
      if (!withTrend) {
        return NextResponse.json({
          ...rate,
          target: CRASH_FREE_TARGET,
        });
      }
      const trend = await getCrashTrend(windowHours, bucketHours);
      return NextResponse.json({
        ...rate,
        target: CRASH_FREE_TARGET,
        trend,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "crash-free query failed" },
        { status: 500 },
      );
    }
  });
}
