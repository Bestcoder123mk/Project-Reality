import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, PLAYER_ID } from "@/lib/api";
const logger = createLogger("/api/player");
import {
  getActiveSeason,
  getOrCreatePlayerBattlePass,
  getPlayerInventorySlugs,
  serializeBattlePass,
  serializeLoadouts,
  serializePlayer,
} from "@/lib/api";

export async function GET() {
  try {
    await ensureSeed();

    const [player, loadouts, season] = await Promise.all([
      db.player.findUniqueOrThrow({ where: { id: PLAYER_ID } }),
      db.playerLoadout.findMany({
        where: { playerId: PLAYER_ID },
        orderBy: { weaponSlug: "asc" },
      }),
      getActiveSeason(),
    ]);

    const bp = await getOrCreatePlayerBattlePass(season.id);
    const inventory = await getPlayerInventorySlugs();
    const { loadouts: serializedLoadouts, equipped } = serializeLoadouts(loadouts);

    return NextResponse.json({
      player: serializePlayer(player),
      inventory,
      loadouts: serializedLoadouts,
      equipped,
      battlePass: serializeBattlePass(bp, season),
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load player" },
      { status: 500 },
    );
  }
}
