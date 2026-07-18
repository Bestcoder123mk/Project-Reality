import { NextResponse, type NextRequest } from "next/server";
import { ensureSeed, errorResponse } from "@/lib/api";
import {
  scheduleEvent,
  getActiveEvents,
  getUpcomingEvents,
  getPastEvents,
  cancelEvent,
  serializeScheduledEvent,
  isScheduledEventKind,
  type ScheduledEventKind,
} from "@/lib/game/meta/calendar";
import { withAdminAudit } from "@/lib/security/audit-log";
import { adminCalendarSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { createLogger } from "@/lib/logger";

const logger = createLogger("/api/admin/calendar");
import { sanitizeFreeText } from "@/lib/security/sanitize";

/**
 * SEC11-META prompt 88 — admin live-ops calendar API.
 *
 * Non-player-facing. Routes:
 *
 *   GET  /api/admin/calendar                  → list active + upcoming + recent past
 *   GET  /api/admin/calendar?scope=active     → only active
 *   GET  /api/admin/calendar?scope=upcoming   → only upcoming
 *   GET  /api/admin/calendar?scope=past       → only past
 *   POST /api/admin/calendar                  → schedule a new event (idempotent on slug)
 *   POST /api/admin/calendar?cancel=<slug>    → cancel an event
 *
 * Task-1 (SEC) item 1, 2, 6, 8, 10, 23: gated behind the shared-secret
 * admin bearer header. POST body is size-capped + Zod-validated +
 * free-text sanitized. Every call is recorded in the AuditLog table.
 *
 * Section H-5000 (3774) — server-authoritative calendar: every scheduled
 * event is persisted server-side (ScheduledEvent row); clients see the
 * active calendar via the bootstrap endpoint, never mutate it directly.
 */
export async function GET(req: NextRequest) {
  return withAdminAudit(req, async () => {
    try {
      await ensureSeed();
      const url = new URL(req.url);
      const scope = url.searchParams.get("scope") ?? "all";

      if (scope === "active") {
        const rows = await getActiveEvents();
        return NextResponse.json({ scope, events: rows.map(serializeScheduledEvent) });
      }
      if (scope === "upcoming") {
        const rows = await getUpcomingEvents();
        return NextResponse.json({ scope, events: rows.map(serializeScheduledEvent) });
      }
      if (scope === "past") {
        const rows = await getPastEvents();
        return NextResponse.json({ scope, events: rows.map(serializeScheduledEvent) });
      }

      const [active, upcoming, past] = await Promise.all([
        getActiveEvents(),
        getUpcomingEvents(),
        getPastEvents(),
      ]);
      return NextResponse.json({
        scope: "all",
        active: active.map(serializeScheduledEvent),
        upcoming: upcoming.map(serializeScheduledEvent),
        past: past.map(serializeScheduledEvent),
      });
    } catch (err) {
      logger.errorOf(err, "calendar query failed");
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "calendar query failed" },
        { status: 500 },
      );
    }
  });
}

export async function POST(req: NextRequest) {
  // Body-size limit: 16KB — the payload field can carry a JSON blob.
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 16_384 });
  if (bodyError) return bodyError;

  return withAdminAudit(
    req,
    async () => {
      try {
        await ensureSeed();
        const url = new URL(req.url);
        const cancelSlug = url.searchParams.get("cancel");
        if (cancelSlug) {
          const updated = await cancelEvent(cancelSlug);
          if (!updated) return errorResponse(`Event not found: ${cancelSlug}`, 404);
          return NextResponse.json({ event: serializeScheduledEvent(updated) });
        }

        if (!json) return errorResponse("Invalid JSON body", 400);

        const parsed = adminCalendarSchema.safeParse(json);
        if (!parsed.success) {
          return errorResponse("Invalid calendar body", 400, {
            issues: parsed.error.issues,
          });
        }

        const startsAt = new Date(parsed.data.startsAt);
        const endsAt = new Date(parsed.data.endsAt);
        if (Number.isNaN(startsAt.getTime())) return errorResponse("startsAt must be ISO date", 400);
        if (Number.isNaN(endsAt.getTime())) return errorResponse("endsAt must be ISO date", 400);

        const kind: ScheduledEventKind = parsed.data.kind;
        const event = await scheduleEvent({
          slug: parsed.data.slug,
          kind,
          // Sanitize free-text fields before storage (item 23).
          title: sanitizeFreeText(parsed.data.title, { maxLength: 200 }) ?? "",
          description:
            sanitizeFreeText(parsed.data.description, { maxLength: 2000 }) ?? undefined,
          startsAt,
          endsAt,
          status: parsed.data.status,
          payload: parsed.data.payload,
        });
        return NextResponse.json({ event: serializeScheduledEvent(event) }, { status: 201 });
      } catch (err) {
        logger.errorOf(err, "schedule failed");
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "schedule failed" },
          { status: 500 },
        );
      }
    },
    { payloadOverride: { ...(json as object), title: "<sanitized>" } },
  );
}

// Re-export for backwards compat with any imports that expect this from the route file.
export { isScheduledEventKind };
