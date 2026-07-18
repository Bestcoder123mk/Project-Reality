/**
 * Task-1 (SEC) item 10 — Audit log writer.
 *
 * Every admin route call writes a single `AuditLog` row: actor, route,
 * method, IP, response status, + a redacted JSON snapshot of the
 * request payload (PII stripped before storage).
 *
 * The write is fire-and-forget — the route handler does NOT block on
 * it. A failed audit-log write logs a warning + continues (the request
 * still succeeds). This is the right tradeoff for an admin route: the
 * operator wants the response, the audit log is a forensic backstop.
 *
 * Section H-5000 (3665 / cross-ref A-600) — per-admin attribution.
 *
 *   The `actor` field on every AuditLog row now records the named
 *   operator when `ADMIN_SECRET` is configured as a `name:secret`
 *   table (or the caller supplies `X-Admin-Actor`). Previously every
 *   row's actor was the hard-coded string `"shared-secret"` — a
 *   forensic review couldn't distinguish which operator performed
 *   which action. The actor is sourced from `requireAdmin().actor`,
 *   which `withAdminAudit` propagates into the audit row below.
 *
 * Usage (the `withAdminAudit` wrapper handles this automatically):
 *
 *   export async function GET(req: NextRequest) {
 *     return withAdminAudit(req, async () => {
 *       // ... handler body ...
 *       return NextResponse.json({ ... });
 *     });
 *   }
 *
 * The wrapper:
 *   1. Calls `requireAdmin(req)` — 401 on missing/wrong secret.
 *   2. Runs the handler.
 *   3. Records the audit log row with the handler's response status.
 *   4. Returns the handler's response.
 *
 * PII redaction: the `payloadJson` field is built by `redactPayload`
 * which deep-clones the request body + replaces known PII field names
 * (playerId, ip, password, token, signature, ...) with `<redacted>`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "./admin-auth";
import { getClientIp } from "./csrf-helpers";
import { sanitizeRouteName } from "./sanitize";

/** Field names redacted from the audit-log payload. */
const REDACTED_KEYS = new Set([
  "playerid",
  "player_id",
  "ip",
  "ipaddress",
  "password",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "signature",
  "nonce",
  "sessionid",
  "session_id",
  "authorization",
  "adminsecret",
  "admin_secret",
  "receiptsecret",
  "receipt_secret",
  "fieldenc_key",
  "fieldenckey",
  "field_enc_key",
  "database_url",
  "databaseurl",
]);

/**
 * Redact PII from a request payload. Deep-clones the input + replaces
 * values of known PII keys with `<redacted>`. Returns the redacted
 * object as a JSON string (capped at 4KB so a huge payload doesn't
 * bloat the audit table).
 */
export function redactPayload(payload: unknown): string {
  if (payload == null) return "{}";
  try {
    const clone = JSON.parse(JSON.stringify(payload)) as unknown;
    redactInPlace(clone);
    const json = JSON.stringify(clone);
    return json.length > 4096 ? json.slice(0, 4096) + "…" : json;
  } catch {
    return "<unserializable>";
  }
}

function redactInPlace(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) redactInPlace(item);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k.toLowerCase())) {
        (node as Record<string, unknown>)[k] = "<redacted>";
      } else {
        redactInPlace(v);
      }
    }
  }
}

export interface AuditEntry {
  actor: string;
  route: string;
  method: string;
  ip: string;
  status: number;
  payloadJson: string;
}

/** Write a single AuditLog row. Fire-and-forget — never throws. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actor: entry.actor,
        route: sanitizeRouteName(entry.route),
        method: entry.method.slice(0, 10),
        ip: entry.ip.slice(0, 64),
        status: entry.status,
        payloadJson: entry.payloadJson,
      },
    });
  } catch (err) {
    // The audit log must never break the request. Log + continue.
    console.warn("[audit-log] failed to write audit row:", err);
  }
}

/**
 * Wrap an admin route handler with auth + audit logging. The handler
 * runs only if `requireAdmin` succeeds. The audit row records the
 * final response status (200/4xx/5xx).
 *
 *   export async function POST(req: NextRequest) {
 *     return withAdminAudit(req, async (auth) => {
 *       // ... handler body ... `auth.actor` is the per-admin name (3665).
 *       return NextResponse.json({ ok: true });
 *     });
 *   }
 *
 * The `payloadOverride` arg lets the caller supply a pre-redacted
 * payload when the request body has a shape the redactor doesn't
 * understand (rare — the redactor is generic).
 *
 * Section H-5000 (3665) — the handler receives the `auth` result so
 * it can pass `auth.actor` to downstream audit calls (e.g.
 * `verifyReceiptServerSide({ actor: auth.actor, ... })`). The arg is
 * optional — existing handlers that don't read it compile unchanged.
 */
export async function withAdminAudit(
  req: NextRequest,
  handler: (auth: { actor: string }) => Promise<NextResponse>,
  opts: { payloadOverride?: unknown } = {},
): Promise<NextResponse> {
  const auth = requireAdmin(req);
  if (!auth.ok) {
    // Still audit the failed-auth attempt so brute-force probes are visible.
    await writeAudit({
      actor: "anonymous",
      route: req.nextUrl?.pathname ?? new URL(req.url).pathname,
      method: req.method,
      ip: getClientIp(req),
      status: 401,
      payloadJson: "{}",
    });
    return auth.response;
  }

  let response: NextResponse;
  try {
    response = await handler({ actor: auth.actor });
  } catch (err) {
    console.error("[withAdminAudit] handler threw:", err);
    response = NextResponse.json(
      { error: err instanceof Error ? err.message : "internal error" },
      { status: 500 },
    );
  }

  await writeAudit({
    actor: auth.actor,
    route: req.nextUrl?.pathname ?? new URL(req.url).pathname,
    method: req.method,
    ip: getClientIp(req),
    status: response.status,
    payloadJson: opts.payloadOverride
      ? redactPayload(opts.payloadOverride)
      : "{}",
  });

  return response;
}
