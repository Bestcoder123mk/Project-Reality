import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { ensureSeed, errorResponse, PLAYER_ID, getActiveSeason, serializeBattlePass } from "@/lib/api";
const logger = createLogger("/api/battlepass/preview");
import { getPremiumPreview } from "@/lib/game/BattlePassSeasons";

/**
 * GET /api/battlepass/preview — preview the premium-track rewards the
 * player would unlock if they purchased premium right now (based on
 * their current tier).
 *
 * I-5000 #3847 — Battle pass premium preview. The UI uses this to
 * render the "Buy Premium to unlock X" upsell. Does NOT grant the
 * rewards — just previews them.
 */
export async function GET(_req: NextRequest) {
  try {
    await ensureSeed();
    const preview = await getPremiumPreview(PLAYER_ID);
    const season = await getActiveSeason();
    return NextResponse.json({
      season: season
        ? {
            id: season.id,
            season: season.season,
            name: season.name,
            premiumPrice: season.premiumPrice,
            maxTier: season.maxTier,
            tierSize: season.tierSize,
          }
        : null,
      currentTier: preview.currentTier,
      purchasableTiers: preview.purchasableTiers,
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "preview failed" },
      { status: 500 },
    );
  }
}

// Re-export for type-safety; serializeBattlePass import keeps the helper
// tree-shakeable in case future callers want the full BP shape.
void serializeBattlePass;
