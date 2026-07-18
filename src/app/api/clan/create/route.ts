import { NextResponse, type NextRequest } from "next/server";
import { createClan, ClanTagConflictError } from "@/lib/game/meta/clan-progression";
import { PLAYER_ID } from "@/lib/seed";
import { clanCreateSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { sanitizeFreeText } from "@/lib/security/sanitize";

/**
 * POST /api/clan/create — create a new clan with the caller as leader.
 * Body: { tag, name }
 *
 * Task-1 (SEC) additions (items 5, 6, 8, 23):
 *   - Same-origin CSRF check.
 *   - Body-size limit (1KB).
 *   - Zod validation: tag is 2-5 alphanumeric chars, name is 1-64 chars.
 *   - Free-text `name` sanitized before storage.
 *
 * I-5000 #3807 / A-548 — 4xx on tag conflict. The prior code caught
 * every error + returned 500, including the ClanTagConflictError (which
 * is a client error, not a server error). The fix catches
 * ClanTagConflictError specifically + returns 409 Conflict.
 */
export async function POST(req: NextRequest) {
  // 1. CSRF check.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  // 2. Body-size limit + Zod validation.
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
  if (bodyError) return bodyError;
  const parsed = clanCreateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body. Expected { tag: 2-5 alphanumeric, name: 1-64 chars }.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // 3. Sanitize free-text name before storage.
  const sanitizedName = sanitizeFreeText(parsed.data.name, { maxLength: 64 }) ?? "";
  try {
    const clanId = await createClan(parsed.data.tag, sanitizedName, PLAYER_ID);
    return NextResponse.json({ ok: true, clanId });
  } catch (err) {
    if (err instanceof ClanTagConflictError) {
      return NextResponse.json(
        { error: err.message, code: "tag_conflict", tag: err.tag },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "create failed" },
      { status: 500 },
    );
  }
}
