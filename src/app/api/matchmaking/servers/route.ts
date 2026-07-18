import { NextResponse, type NextRequest } from "next/server";
import { PLAYER_ID } from "@/lib/api";
import { getServerBrowser } from "@/lib/game/multiplayer/Servers";

/**
 * Section H (960) — server browser endpoint.
 *
 * GET /api/matchmaking/servers?mode=SURVIVAL&includeFull=1
 *   → 200 { servers: ServerBrowserEntry[], viewerPlayerId }
 *
 * Lists active sessions the player can join or spectate. Backed by
 * `Matchmaking.listSessions()` via the `ServerBrowser` class. Filters
 * by mode (optional) + excludes full sessions by default.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? undefined;
  const includeFull = url.searchParams.get("includeFull") === "1";
  const browser = getServerBrowser();
  const servers = browser.list({ mode, includeFull });
  return NextResponse.json({ servers, viewerPlayerId: PLAYER_ID });
}
