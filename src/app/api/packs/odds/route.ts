import { NextResponse } from "next/server";
import { getOddsDisclosure, validateOddsIntegrity } from "@/lib/game/meta/loot-odds";

/**
 * GET /api/packs/odds?pack=<slug> — always-visible loot box odds disclosure.
 *
 * Per prompt 87 + loot box regulations (China, Belgium, platform stores),
 * the odds must be visible before any purchase path, not hidden behind a
 * toggle. This route serves the authoritative disclosure from the same
 * source the server uses to roll packs.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const packSlug = url.searchParams.get("pack");
    if (!packSlug) {
      return NextResponse.json({ error: "pack slug required" }, { status: 400 });
    }
    const disclosure = getOddsDisclosure(packSlug);
    if (!disclosure) {
      return NextResponse.json({ error: "unknown pack" }, { status: 404 });
    }
    const integrity = validateOddsIntegrity(packSlug);
    return NextResponse.json({ disclosure, integrity });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "odds failed" },
      { status: 500 },
    );
  }
}
