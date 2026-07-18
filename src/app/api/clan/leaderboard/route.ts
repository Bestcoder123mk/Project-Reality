import { NextResponse } from "next/server";
import { getClanLeaderboard, getClanLeaderboardForMember } from "@/lib/game/meta/clan-progression";
import { PLAYER_ID } from "@/lib/seed";

/**
 * GET /api/clan/leaderboard — top clans by XP.
 * Query: ?limit=20&offset=0  (paginated leaderboard)
 * Query: ?scope=member       (per-member view: shows the caller's clan rank
 *                             + a surrounding window of clans)
 *
 * A3-5000-retry / 549: was `?limit=20` only (capped at 100). Players outside
 * the top 100 couldn't see their rank. Now accepts `offset` for pagination
 * (no cap on offset — a player can paginate to their rank). The `limit` cap
 * of 100 is kept to prevent excessive single-query loads.
 *
 * I-5000 #3883 / A-67 — per-member filter. When `?scope=member` is passed,
 * the route returns the caller's clan rank + a surrounding window of clans
 * (so the UI can show "your clan is rank 47 of 312"). The window size is
 * configurable via `?windowSize=N` (default 5 clans on each side).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope");

    // I-5000 #3883 — per-member view.
    if (scope === "member") {
      const windowSize = Math.max(1, Math.min(20, Number(url.searchParams.get("windowSize") ?? "5")));
      const memberView = await getClanLeaderboardForMember(PLAYER_ID, windowSize);
      if (!memberView) {
        return NextResponse.json(
          { error: "Player is not in a clan", scope: "member" },
          { status: 404 },
        );
      }
      return NextResponse.json({ scope: "member", ...memberView });
    }

    // Default: paginated leaderboard.
    const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? "20")), 100);
    // A3-5000-retry / 549: pagination offset (was missing — players outside
    // top 100 had no way to see their rank).
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));
    const clans = await getClanLeaderboard(limit, offset);
    return NextResponse.json({ clans, offset, limit, scope: "global" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "leaderboard failed" },
      { status: 500 },
    );
  }
}
