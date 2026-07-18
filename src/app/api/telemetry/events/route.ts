import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/api";
import { telemetryEventsSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { rateLimit, playerRateKey } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/csrf-helpers";
import { encryptField } from "@/lib/security/encryption";
import { PLAYER_ID } from "@/lib/seed";

/**
 * POST /api/telemetry/events — durable analytics ingest (prompt 4).
 *
 * Accepts a batch of client track() events. Writes each to PlayerEvent.
 * When a real provider is configured (PostHog/Amplitude via env), the
 * route additionally fans out — the local row is always the source of
 * truth so analysis works even without the third party.
 *
 * When the batch contains a `session_start` event, the route also upserts
 * a `PlayerSession` row with `ipEncrypted = encryptField(getClientIp(req))`
 * (Task-1 (SEC) item 12 — encrypted PII-adjacent field).
 *
 * Task-1 (SEC) additions (items 3, 5, 6, 8, 12):
 *   - Same-origin CSRF check.
 *   - Rate limit: 120 batches / player / minute.
 *   - Body-size limit: 64KB (the batch can hold up to 500 events).
 *   - Zod validation via `telemetryEventsSchema` (max 500 events per batch).
 *   - PlayerSession.ipEncrypted is written with the encrypted client IP
 *     on session_start (item 12).
 *
 * Input shape: { events: AnalyticsEvent[] }
 */
const EVENTS_RATE_LIMIT = { max: 120, windowMs: 60_000, label: "telemetry-events" };

export async function POST(req: NextRequest) {
  // 1. CSRF check.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  // 2. Rate limit (per player).
  const rl = rateLimit(playerRateKey(PLAYER_ID, "telemetry-events"), EVENTS_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many telemetry batches", retryAfterMs: rl.retryAfterMs },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  // 3. Body-size limit + Zod validation.
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 65_536 });
  if (bodyError) return bodyError;
  const parsed = telemetryEventsSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid body. Expected { events: Array<{ name, props?, at?, sessionId?, playerId? }> }.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const events = parsed.data.events;
  if (events.length === 0) return NextResponse.json({ ok: true, stored: 0 });

  try {
    const rows = events.map((e) => ({
      playerId: e.playerId ?? null,
      sessionId: e.sessionId ?? "unknown",
      name: String(e.name ?? "unknown"),
      props: JSON.stringify(e.props ?? {}),
    }));

    // Chunk to stay under SQLite's 999-variable limit per insert.
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.playerEvent.createMany({ data: rows.slice(i, i + CHUNK) });
    }

    // Task-1 (SEC) item 12 — when the batch contains a `session_start`
    // event, upsert a PlayerSession row with the encrypted client IP.
    // The IP is encrypted at rest via FIELD_ENC_KEY (AES-256-GCM) so a
    // DB-dump leak does not reveal end-user IP addresses.
    //
    // `sessionId` is not @unique in the schema (only indexed), so we
    // findFirst + update/create rather than upsert. The first
    // session_start for a given sessionId creates the row; subsequent
    // ones (e.g. from a replayed batch) update the ipEncrypted field.
    const sessionStart = events.find((e) => e.name === "session_start");
    if (sessionStart?.sessionId) {
      try {
        const ipEncrypted = encryptField(getClientIp(req));
        const existing = await db.playerSession.findFirst({
          where: { sessionId: sessionStart.sessionId },
          select: { id: true },
        });
        if (existing) {
          await db.playerSession.update({
            where: { id: existing.id },
            data: { ipEncrypted, playerId: sessionStart.playerId ?? PLAYER_ID },
          });
        } else {
          await db.playerSession.create({
            data: {
              sessionId: sessionStart.sessionId,
              playerId: sessionStart.playerId ?? PLAYER_ID,
              ipEncrypted,
            },
          });
        }
      } catch (err) {
        // PlayerSession write is best-effort — never break the ingest.
        console.warn("[/api/telemetry/events] PlayerSession upsert failed:", err);
      }
    }

    // Optional fan-out to a real provider (prompt 4). When the env var is
    // absent we no-op; the local PlayerEvent rows are sufficient for the
    // retention dashboard (prompt 91).
    const providerKey =
      process.env.POSTHOG_KEY ?? process.env.AMPLITUDE_KEY ?? "";
    if (providerKey) {
      // Fire-and-forget — don't block the response on the provider.
      void fanOut(events, providerKey).catch(() => {
        /* provider outage must never break the local ingest */
      });
    }

    return NextResponse.json({ ok: true, stored: rows.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "ingest failed" },
      { status: 500 },
    );
  }
}

/** GET — recent event counts by name (lightweight admin view). */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const hours = Number(url.searchParams.get("hours") ?? "24");
  const since = new Date(Date.now() - hours * 3600_000);
  try {
    const rows = await db.playerEvent.groupBy({
      by: ["name"],
      where: { at: { gte: since } },
      _count: { _all: true },
    });
    return NextResponse.json({
      since: since.toISOString(),
      counts: Object.fromEntries(rows.map((r) => [r.name, r._count._all])),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "query failed" },
      { status: 500 },
    );
  }
}

async function fanOut(
  events: Array<{ name: string; props?: Record<string, unknown> }>,
  _key: string,
) {
  // Stub for the real provider SDK call. Kept generic so the route doesn't
  // take a hard dep on PostHog/Amplitude; swap in the SDK of choice.
  void events;
  void _key;
}
