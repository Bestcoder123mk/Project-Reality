import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/api";
import { telemetryErrorsSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { rateLimit, playerRateKey } from "@/lib/security/rate-limit";
import { scrubDatabaseUrl } from "@/lib/db";
import { PLAYER_ID } from "@/lib/seed";

/**
 * POST /api/telemetry/errors — crash report ingest (prompt 3).
 *
 * The client ErrorTracking module posts here when no Sentry DSN is set.
 * Each report is stored in CrashReport for later triage. Severity is
 * preserved so 'fatal' events surface above 'warning' in the admin view.
 *
 * Task-1 (SEC) additions (items 3, 5, 6, 8, 19):
 *   - Same-origin CSRF check.
 *   - Rate limit: 60 crash reports / player / minute.
 *   - Body-size limit: 32KB (the stack + breadcrumbs can be large).
 *   - Zod validation via `telemetryErrorsSchema`.
 *   - All stored strings are scrubbed through `scrubDatabaseUrl` so an
 *     error message containing a Prisma connection-error never persists
 *     the DATABASE_URL with credentials (item 19).
 */
const ERRORS_RATE_LIMIT = { max: 60, windowMs: 60_000, label: "telemetry-errors" };

export async function POST(req: NextRequest) {
  // 1. CSRF check.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  // 2. Rate limit (per player).
  const rl = rateLimit(playerRateKey(PLAYER_ID, "telemetry-errors"), ERRORS_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "Too many crash reports", retryAfterMs: rl.retryAfterMs },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  // 3. Body-size limit + Zod validation.
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 32_768 });
  if (bodyError) return bodyError;
  const parsed = telemetryErrorsSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid body. Expected { message: string, stack?, severity?, ... }.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;
  try {
    await db.crashReport.create({
      data: {
        // Task-1 (SEC) item 19 — scrub the DATABASE_URL out of every stored
        // string. A Prisma connection error in `message` or `stack` would
        // otherwise leak credentials into the CrashReport table.
        sessionId: scrubDatabaseUrl(body.sessionId ?? "unknown"),
        message: scrubDatabaseUrl(body.message).slice(0, 4000),
        stack: body.stack ? scrubDatabaseUrl(body.stack) : null,
        severity: body.severity,
        tags: JSON.stringify(body.tags ?? {}),
        breadcrumbs: JSON.stringify(body.breadcrumbs ?? []),
        url: body.url ?? null,
        buildId: body.buildId ?? null,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "ingest failed" },
      { status: 500 },
    );
  }
}

/** GET — recent unresolved crashes (admin triage view). */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
  try {
    const rows = await db.crashReport.findMany({
      where: { resolved: false },
      orderBy: { at: "desc" },
      take: limit,
      select: {
        id: true,
        message: true,
        severity: true,
        sessionId: true,
        url: true,
        at: true,
      },
    });
    return NextResponse.json({ crashes: rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "query failed" },
      { status: 500 },
    );
  }
}
