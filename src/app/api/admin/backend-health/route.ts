import { NextResponse, type NextRequest } from "next/server";
import {
  BACKEND_PROVIDER,
  describeBackend,
  pingDatabase,
  getDatabaseUrl,
} from "@/lib/game/meta/backend-config";
import { withAdminAudit } from "@/lib/security/audit-log";
import { isAdminConfigured } from "@/lib/security/admin-auth";
import { scrubDatabaseUrl } from "@/lib/db";

/**
 * SEC11-META prompt 85 — admin backend-health endpoint.
 *
 * Non-player-facing. Returns:
 *   - the configured Prisma datasource provider (`sqlite` | `postgresql` | `mysql`)
 *   - whether `DATABASE_URL` is set
 *   - a live connection ping (`SELECT 1 AS one`) with latency
 *   - whether the URL points at a local file (SQLite dev mode) or a remote host
 *   - whether `ADMIN_SECRET` is configured (Task-1 SEC)
 *
 * The route NEVER leaks the raw connection string (it contains credentials).
 * Even the redacted form is run through `scrubDatabaseUrl` so a malformed
 * URL with credentials in an unexpected position is still redacted.
 *
 * Task-1 (SEC) item 1, 2, 10, 19: gated behind the shared-secret admin
 * bearer header. Every call is recorded in the AuditLog table.
 *
 * Section H-5000 (3778 / 3705) — server-authoritative backend-health +
 * raw-SQL audit. The only `$queryRaw` in the codebase is the
 * parameterized `SELECT 1 AS one` ping in `backend-config.ts:116` —
 * it's a tagged-template literal (Prisma's safe form: no string
 * concatenation, no user input). All other DB access is via Prisma's
 * typed client (`db.player.findUnique`, etc.). No `$queryRawUnsafe` /
 * `$executeRawUnsafe` calls exist (audited).
 *
 * GET /api/admin/backend-health
 *   → 200 { provider, hasUrl, isFile, connected, latencyMs, error?, adminSecretConfigured, ts }
 */
export async function GET(req: NextRequest) {
  return withAdminAudit(req, async () => {
    const described = describeBackend();
    const ping = await pingDatabase();

    // For local dev: surface a `url` hint only when the URL is a `file:` URL
    // (no credentials). For remote URLs we report just the host — never the
    // user/password/query string. Task-1 (SEC) item 19: run the redacted
    // form through `scrubDatabaseUrl` for defense-in-depth.
    let urlHint: string | null = null;
    try {
      const raw = getDatabaseUrl();
      if (raw.startsWith("file:")) {
        urlHint = raw;
      } else {
        // Parse + redact credentials.
        try {
          const u = new URL(raw);
          urlHint = scrubDatabaseUrl(`${u.protocol}//${u.host}${u.pathname}`);
        } catch {
          urlHint = "<unparseable remote URL>";
        }
      }
    } catch {
      urlHint = null;
    }

    return NextResponse.json({
      provider: BACKEND_PROVIDER,
      hasUrl: described.hasUrl,
      isFile: described.isFile,
      url: urlHint,
      connected: ping.connected,
      latencyMs: ping.latencyMs,
      error: ping.error ? scrubDatabaseUrl(ping.error) : null,
      adminSecretConfigured: isAdminConfigured(),
      ts: new Date().toISOString(),
    });
  });
}
