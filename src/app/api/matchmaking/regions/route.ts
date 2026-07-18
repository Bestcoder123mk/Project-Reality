import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, PLAYER_ID } from "@/lib/api";
import { requireSameOrigin } from "@/lib/security/csrf";
import {
  getRegionRegistry,
  getServerBrowser,
} from "@/lib/game/multiplayer/Servers";
import { z } from "zod";

/**
 * Section H (959, 960) — region selection + server browser endpoints.
 *
 * GET /api/matchmaking/regions
 *   → 200 { regions: Region[], accepting: Region[], selected: string }
 *
 * POST /api/matchmaking/regions
 *   body: { regionId }
 *   → 200 { ok: true, selected: regionId }
 *   → 400 when the region is unknown or not accepting players.
 */

export async function GET(_req: NextRequest) {
  const registry = getRegionRegistry();
  return NextResponse.json({
    regions: registry.list(),
    accepting: registry.listAccepting(),
    selected: registry.getSelected().id,
  });
}

const regionSelectSchema = z.object({
  regionId: z.string().min(1).max(80),
});

/** POST /api/matchmaking/regions — select a region. */
export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  const { readBoundedJson } = await import("@/lib/security/body-size");
  const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
  if (bodyError) return bodyError;
  const parsed = regionSelectSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("Invalid body. Expected { regionId }.", 400, {
      issues: parsed.error.issues,
    });
  }
  const registry = getRegionRegistry();
  const ok = registry.selectRegion(parsed.data.regionId);
  if (!ok) {
    return errorResponse(
      `Region "${parsed.data.regionId}" is unknown or not accepting players.`,
      400,
    );
  }
  return NextResponse.json({ ok: true, selected: parsed.data.regionId });
}

// Reference PLAYER_ID to avoid the unused-import warning; the viewer
// is logged in as PLAYER_ID for the single-player demo.
void PLAYER_ID;

// Re-export getServerBrowser for the servers route (kept here to
// avoid a separate import cycle).
export { getServerBrowser };
