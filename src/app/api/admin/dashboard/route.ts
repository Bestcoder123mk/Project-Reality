import { NextResponse, type NextRequest } from "next/server";
import { getDashboardSnapshot } from "@/lib/game/meta/retention";
import { withAdminAudit } from "@/lib/security/audit-log";

/**
 * GET /api/admin/dashboard — retention + funnel + session-length snapshot.
 * Non-player-facing admin route (prompt 91).
 *
 * Task-1 (SEC) item 1, 2, 10: gated behind the shared-secret admin
 * bearer header. Every call is recorded in the AuditLog table.
 *
 * Section H-5000 (3776) — server-authoritative dashboard: the snapshot
 * is computed server-side from the durable PlayerEvent / PlayerSession
 * rows; the client never sends dashboard data, only requests it. The
 * per-admin actor (3665) is recorded on every audit row.
 */
export async function GET(req: NextRequest) {
  return withAdminAudit(req, async () => {
    try {
      const snapshot = await getDashboardSnapshot();
      return NextResponse.json(snapshot);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "dashboard failed" },
        { status: 500 },
      );
    }
  });
}
