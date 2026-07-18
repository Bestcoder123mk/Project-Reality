import { NextResponse, type NextRequest } from "next/server";
import { auditApiRoutes } from "@/lib/game/platform/security-audit";
import { withAdminAudit } from "@/lib/security/audit-log";

/**
 * GET /api/admin/security-audit — full API security audit report.
 *
 * Non-player-facing admin route (prompt 95). Returns the structured
 * report produced by `auditApiRoutes()`: every discovered route, the
 * curated validation/authorization assessment, the routes flagged as
 * needing follow-up, + high-level summary counts.
 *
 * Task-1 (SEC) item 1, 2, 10: gated behind the shared-secret admin
 * bearer header (`Authorization: Bearer <ADMIN_SECRET>`). Every call
 * is recorded in the AuditLog table.
 *
 * Section H-5000 (3779) — server-authoritative security-audit: the
 * report is generated server-side by walking the `src/app/api/**`
 * route tree + applying the curated assessment table. The client
 * never sends audit data, only requests the report.
 */
export async function GET(req: NextRequest) {
  return withAdminAudit(req, async () => {
    try {
      const report = auditApiRoutes();
      return NextResponse.json(report);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "audit failed" },
        { status: 500 },
      );
    }
  });
}
