import { NextResponse, type NextRequest } from "next/server";
import { checkSeasonRollover } from "@/lib/game/meta/seasonal-rollover";
import { withAdminAudit } from "@/lib/security/audit-log";

/**
 * POST /api/admin/rollover — manually trigger a season rollover check.
 * Idempotent: if no season is expired, returns { rolled: false }.
 * Non-player-facing admin route (prompt 89).
 *
 * Task-1 (SEC) item 1, 2, 10: gated behind the shared-secret admin
 * bearer header. Every call is recorded in the AuditLog table.
 *
 * Section H-5000 (3780) — server-authoritative rollover: the season
 * state machine runs entirely server-side (BattlePassSeason row +
 * checkSeasonRollover); the client only reads the resulting season
 * metadata via the bootstrap endpoint, never triggers a rollover.
 */
async function handleRollover(req: NextRequest) {
  return withAdminAudit(req, async () => {
    try {
      const result = await checkSeasonRollover();
      return NextResponse.json(result);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "rollover failed" },
        { status: 500 },
      );
    }
  });
}

export async function POST(req: NextRequest) {
  return handleRollover(req);
}

/**
 * GET — added for Vercel Cron, which triggers scheduled invocations
 * with a GET request (it cannot be configured to send POST). Vercel
 * automatically attaches `Authorization: Bearer <CRON_SECRET>` to cron
 * requests, so as long as CRON_SECRET is set to the same value as
 * ADMIN_SECRET in the Vercel project's env vars, this still passes
 * through the same withAdminAudit() check as a manual admin call.
 */
export async function GET(req: NextRequest) {
  return handleRollover(req);
}
