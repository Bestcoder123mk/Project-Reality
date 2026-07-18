import { NextResponse } from "next/server";
import { getClanRoster } from "@/lib/game/meta/clan-progression";

/**
 * GET /api/clan/roster?clanId=<id> — list a clan's members.
 *
 * I-5000 #3885 / A-69 — Clan roster endpoint. Returns the clan's
 * members with their role + `joinedAt` (the `joinedAt` field was
 * previously dropped from the API; this route surfaces it so the UI
 * can show "Member since <date>").
 *
 * Returns 404 when the clan doesn't exist. Public (no admin gate) —
 * clan rosters are public information in the social panel.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const clanId = url.searchParams.get("clanId");
    if (!clanId || clanId.length < 1 || clanId.length > 80) {
      return NextResponse.json(
        { error: "Missing or invalid clanId" },
        { status: 400 },
      );
    }
    const roster = await getClanRoster(clanId);
    if (!roster) {
      return NextResponse.json(
        { error: "Clan not found" },
        { status: 404 },
      );
    }
    return NextResponse.json(roster);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "roster failed" },
      { status: 500 },
    );
  }
}
