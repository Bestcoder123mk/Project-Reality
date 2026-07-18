import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { errorResponse, PLAYER_ID } from "@/lib/api";
import { deletePlayerData, assertDataExportAuthorized } from "@/lib/game/platform/gdpr";
import { playerDeleteSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { sanitizeFreeText } from "@/lib/security/sanitize";
const logger = createLogger("/api/player/delete");

/**
 * POST /api/player/delete — GDPR right to erasure (Article 17).
 *
 * Hard-deletes every player-owned row + anonymizes the player's events.
 * Returns a structured report the support team can use to confirm the
 * erasure to the player.
 *
 * The body MUST include `confirm: "DELETE"` so a misclick doesn't wipe
 * a player's account. The route is intentionally POST-only (not DELETE)
 * because DELETE requests don't have a body in some HTTP clients.
 *
 * In production this route is gated by re-authentication (the player
 * must re-enter their password / 2FA code before the deletion fires).
 * The single-player demo doesn't have auth, so the player id comes
 * from the server-side PLAYER_ID constant.
 *
 * Task-1 (SEC) additions:
 *   - Same-origin CSRF check (item 5) — a cross-site DELETE would be
 *     catastrophic + trivially exploitable without this.
 *   - Body-size limit (item 6).
 *   - Zod validation via the shared `playerDeleteSchema` (item 8).
 *   - Sanitize the `reason` free-text field (item 23) before passing
 *     to the deletion function.
 *
 * A3-5000-retry / 568: POST now goes through `assertDataExportAuthorized`
 * (CSRF + admin-or-self gate) — same gate as data-export. Previously
 * the POST accepted any playerId in the body — a malicious client could
 * POST `{playerId:"any-uuid", confirm:"DELETE"}` and erase any player.
 */
export async function POST(req: NextRequest) {
  try {
    // 1. CSRF check.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;

    // 2. Body-size limit + Zod validation.
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
    if (bodyError) return bodyError;
    const body = playerDeleteSchema.safeParse(json);
    if (!body.success) {
      return errorResponse(
        'Invalid body. Expected { confirm: "DELETE", reason?: string, playerId?: string }.',
        400,
        { issues: body.error.issues },
      );
    }
    const playerId = body.data.playerId ?? PLAYER_ID;
    // A3-5000-retry / 568: enforce the auth gate (admin or self only).
    const auth = await assertDataExportAuthorized(req, playerId);
    if (!auth.ok) return auth.response;
    const sanitizedReason =
      sanitizeFreeText(body.data.reason, { maxLength: 500 }) ?? undefined;
    const report = await deletePlayerData(playerId, { reason: sanitizedReason, actor: auth.actor });
    return NextResponse.json(report);
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "deletion failed" },
      { status: 500 },
    );
  }
}
