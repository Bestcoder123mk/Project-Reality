import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, PLAYER_ID } from "@/lib/api";
import {
  submitBugReport,
  type BugCategory,
  type BugSeverity,
} from "@/lib/game/platform/support";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { rateLimit, ipRateKey } from "@/lib/security/rate-limit";
import { getClientIp } from "@/lib/security/csrf-helpers";
import { sanitizeFreeText } from "@/lib/security/sanitize";
import { createLogger } from "@/lib/logger";

const logger = createLogger("/api/support/bug-report");

const BodySchema = z.object({
  category: z.enum([
    "crash",
    "graphical",
    "audio",
    "input",
    "gameplay",
    "performance",
    "ui",
    "network",
    "other",
  ]),
  severity: z.enum(["low", "medium", "high", "blocker"]),
  description: z.string().min(1).max(4000),
  screenshotUrl: z.string().url().optional(),
  replaySnippet: z.string().max(20000).optional(),
  hardware: z
    .object({
      tier: z.string(),
      renderer: z.string(),
      isMobile: z.boolean(),
      cores: z.number(),
      deviceMemoryGB: z.number(),
    })
    .optional(),
  buildId: z.string().max(100).optional(),
  sessionId: z.string().max(100).optional(),
  playerId: z.string().min(1).optional(),
});

/** IP rate limit: 10 bug reports / IP / minute — Task-1 (SEC) item 11. */
const BUG_RATE_LIMIT = { max: 10, windowMs: 60_000, label: "bug-report" };

/**
 * POST /api/support/bug-report — in-game bug-report ingest (prompt 100).
 *
 * The body is zod-validated. The route auto-attaches the current
 * breadcrumb ring (from errorTracking.ts) — the player doesn't have to
 * attach logs manually. The replay snippet is optional + truncated to
 * 16KB so it fits in the SQLite TEXT column.
 *
 * Player-facing route (the player submits from the in-game support menu).
 *
 * Task-1 (SEC) additions:
 *   - Same-origin CSRF check (item 5).
 *   - IP rate limit: 10 reports / IP / minute (item 11).
 *   - Body-size limit: 32KB (item 6, accommodates the 16KB replay snippet).
 *   - Free-text sanitization of description (item 23).
 */
export async function POST(req: NextRequest) {
  // 1. CSRF check.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  // 2. IP rate limit.
  const ip = getClientIp(req);
  const rl = rateLimit(ipRateKey(ip, "bug-report"), BUG_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many bug reports from this IP", retryAfterMs: rl.retryAfterMs },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  // 3. Body-size limit + Zod validation.
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 32_768 });
  if (bodyError) return bodyError;
  const body = BodySchema.safeParse(json);
  if (!body.success) {
    return errorResponse("Invalid bug report body.", 400, {
      issues: body.error.issues,
    });
  }

  // 4. Sanitize free-text description before storage.
  const sanitizedDescription = sanitizeFreeText(body.data.description, {
    maxLength: 4000,
    stripTags: true,
  }) ?? "";

  try {
    const report = await submitBugReport({
      playerId: body.data.playerId ?? PLAYER_ID,
      category: body.data.category as BugCategory,
      severity: body.data.severity as BugSeverity,
      description: sanitizedDescription,
      screenshotUrl: body.data.screenshotUrl,
      replaySnippet: body.data.replaySnippet,
      hardware: body.data.hardware,
      buildId: body.data.buildId,
      sessionId: body.data.sessionId,
    });
    return NextResponse.json(report, { status: 201 });
  } catch (err) {
    logger.errorOf(err, "bug report failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "bug report failed" },
      { status: 500 },
    );
  }
}
