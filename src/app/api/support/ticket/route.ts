import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, PLAYER_ID } from "@/lib/api";
import {
  submitSupportTicket,
  listSupportTickets,
  type TicketCategory,
} from "@/lib/game/platform/support";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { rateLimit, ipRateKey } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/csrf-helpers";
import { sanitizeFreeText } from "@/lib/security/sanitize";
import { createLogger } from "@/lib/logger";

const logger = createLogger("/api/support/ticket");

const PostSchema = z.object({
  category: z.enum(["billing", "account", "bug", "feedback", "question", "other"]),
  subject: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  priority: z.number().int().min(1).max(5).optional(),
  bugReportId: z.string().min(1).optional(),
  playerId: z.string().min(1).optional(),
});

const ListSchema = z.object({
  status: z
    .enum(["open", "in_progress", "waiting_on_player", "resolved", "closed"])
    .optional(),
  category: z
    .enum(["billing", "account", "bug", "feedback", "question", "other"])
    .optional(),
  assignedTo: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** IP rate limit: 5 tickets / IP / minute — Task-1 (SEC) item 11. */
const TICKET_RATE_LIMIT = { max: 5, windowMs: 60_000, label: "support-ticket" };

/**
 * POST /api/support/ticket — submit a support ticket (prompt 100).
 * GET  /api/support/ticket — list tickets (admin support dashboard).
 *
 * POST is player-facing (the player submits from the in-game support
 * menu). GET is admin-facing (the support team triages from the
 * dashboard). Both are zod-validated.
 *
 * Task-1 (SEC) additions:
 *   - Same-origin CSRF check (item 5).
 *   - IP rate limit: 5 tickets / IP / minute (item 11).
 *   - Body-size limit: 16KB (item 6).
 *   - Free-text sanitization of subject + description (item 23).
 */
export async function POST(req: NextRequest) {
  // 1. CSRF check.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  // 2. IP rate limit.
  const ip = getClientIp(req);
  const rl = rateLimit(ipRateKey(ip, "support-ticket"), TICKET_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many tickets from this IP", retryAfterMs: rl.retryAfterMs },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  // 3. Body-size limit + Zod validation.
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 16_384 });
  if (bodyError) return bodyError;
  const body = PostSchema.safeParse(json);
  if (!body.success) {
    return errorResponse("Invalid support ticket body.", 400, {
      issues: body.error.issues,
    });
  }

  // 4. Sanitize free-text fields before storage.
  const sanitizedSubject = sanitizeFreeText(body.data.subject, { maxLength: 200 }) ?? "";
  const sanitizedDescription = sanitizeFreeText(body.data.description, {
    maxLength: 4000,
    stripTags: true,
  }) ?? "";

  try {
    const ticket = await submitSupportTicket({
      playerId: body.data.playerId ?? PLAYER_ID,
      category: body.data.category as TicketCategory,
      subject: sanitizedSubject,
      description: sanitizedDescription,
      priority: body.data.priority,
      bugReportId: body.data.bugReportId,
    });
    return NextResponse.json(ticket, { status: 201 });
  } catch (err) {
    logger.errorOf(err, "ticket submit failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ticket submit failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const params = Object.fromEntries(url.searchParams.entries());
    const parsed = ListSchema.safeParse(params);
    if (!parsed.success) {
      return errorResponse("Invalid query params.", 400, {
        issues: parsed.error.issues,
      });
    }
    const tickets = await listSupportTickets({
      status: parsed.data.status,
      category: parsed.data.category,
      assignedTo: parsed.data.assignedTo,
      limit: parsed.data.limit,
    });
    return NextResponse.json({ tickets });
  } catch (err) {
    logger.errorOf(err, "ticket list failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ticket list failed" },
      { status: 500 },
    );
  }
}
