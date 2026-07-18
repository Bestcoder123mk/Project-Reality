import { NextResponse, type NextRequest } from "next/server";
import { joinClan, AlreadyInClanError } from "@/lib/game/meta/clan-progression";
import { PLAYER_ID } from "@/lib/seed";
import { clanJoinSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";

/**
 * POST /api/clan/join — join an existing clan.
 * Body: { clanId }
 *
 * Task-1 (SEC) additions (items 5, 6, 8):
 *   - Same-origin CSRF check.
 *   - Body-size limit (1KB).
 *   - Zod validation: clanId is 1-80 chars.
 *
 * I-5000 #3806 / A-547 — 4xx on conflict. The prior code caught every
 * error + returned 500, including the AlreadyInClanError (which is a
 * client error, not a server error). The fix catches AlreadyInClanError
 * specifically + returns 409 Conflict.
 */
export async function POST(req: NextRequest) {
  // 1. CSRF check.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  // 2. Body-size limit + Zod validation.
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
  if (bodyError) return bodyError;
  const parsed = clanJoinSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body. Expected { clanId: string }.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    await joinClan(parsed.data.clanId, PLAYER_ID);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AlreadyInClanError) {
      return NextResponse.json(
        { error: err.message, code: "already_in_clan", existingClanId: err.existingClanId },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "join failed" },
      { status: 500 },
    );
  }
}
