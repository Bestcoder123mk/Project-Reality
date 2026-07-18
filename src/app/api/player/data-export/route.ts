import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { errorResponse, PLAYER_ID } from "@/lib/api";
import { getDataExport, assertDataExportAuthorized } from "@/lib/game/platform/gdpr";
import { playerDataExportSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
const logger = createLogger("/api/player/data-export");

/**
 * GET /api/player/data-export — GDPR data portability (right of access,
 * Article 15). Returns the full player data export as JSON.
 *
 * The player can download this from the settings panel ("Download my
 * data" button). The response is large (every player-owned row) but
 * not streamed — the typical player has <10k rows and the JSON
 * serializes in <100ms.
 *
 * No body. The player id is sourced from the server-side PLAYER_ID
 * constant (single-player demo) — in production this would come from
 * the authenticated session.
 *
 * A3-5000-retry / 567: GET now goes through `assertDataExportAuthorized`
 * (same CSRF + admin/self gate as POST). Previously the GET path was
 * wide-open — any client could fetch any player's full export.
 */
export async function GET(req: NextRequest) {
  try {
    // A3-5000-retry / 567: enforce the auth gate.
    const auth = await assertDataExportAuthorized(req, PLAYER_ID);
    if (!auth.ok) return auth.response;
    const payload = await getDataExport(PLAYER_ID);
    return NextResponse.json(payload);
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "export failed" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/player/data-export — same as GET but accepts an explicit
 * playerId (used by the support team's "verify what we have on this
 * player" tool).
 *
 * Task-1 (SEC) additions (items 5, 6, 8):
 *   - Same-origin CSRF check.
 *   - Body-size limit (1KB).
 *   - Zod validation via the shared `playerDataExportSchema` (replaces
 *     the inline schema — same shape, now centralized).
 *
 * A3-5000-retry / 567: POST now goes through `assertDataExportAuthorized`
 * (CSRF + admin-or-self gate). Previously the POST accepted any
 * playerId in the body — a malicious client could POST `{playerId:"any-uuid"}`
 * and receive that player's full export.
 */
export async function POST(req: NextRequest) {
  try {
    // Task-1 (SEC) items 5, 6, 8.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
    if (bodyError) return bodyError;
    const parsed = playerDataExportSchema.safeParse(json);
    if (!parsed.success) {
      return errorResponse("Invalid body. Expected { playerId?: string }.", 400, {
        issues: parsed.error.issues,
      });
    }
    const playerId = parsed.data.playerId ?? PLAYER_ID;
    // A3-5000-retry / 567: enforce the auth gate (admin or self only).
    const auth = await assertDataExportAuthorized(req, playerId);
    if (!auth.ok) return auth.response;
    const payload = await getDataExport(playerId);
    return NextResponse.json(payload);
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "export failed" },
      { status: 500 },
    );
  }
}
