import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed } from "@/lib/api";
const logger = createLogger("/api/battlepass");
import {
  computeTier,
  getActiveSeason,
  getOrCreatePlayerBattlePass,
  isClaimed,
  parseClaimedTiers,
  serializeBattlePass,
} from "@/lib/api";

export async function GET() {
  try {
    await ensureSeed();
    const season = await getActiveSeason();
    const bp = await getOrCreatePlayerBattlePass(season.id);

    const tiers = await db.battlePassTier.findMany({
      where: { seasonId: season.id },
      orderBy: [{ tier: "asc" }, { isPremium: "asc" }],
    });

    const claimed = parseClaimedTiers(bp.claimedTiers);
    const currentTier = computeTier(bp.xp, season.tierSize, season.maxTier);

    const tiersWithClaimState = tiers.map((t) => {
      const claimedThis = isClaimed(claimed, t.tier, t.isPremium);
      const reachable = t.tier <= currentTier;
      const premiumOk = !t.isPremium || bp.premium;
      const claimable = !claimedThis && reachable && premiumOk;
      return {
        id: t.id,
        tier: t.tier,
        isPremium: t.isPremium,
        rewardType: t.rewardType,
        rewardSlug: t.rewardSlug,
        rewardAmount: t.rewardAmount,
        claimed: claimedThis,
        claimable,
      };
    });

    return NextResponse.json({
      season: {
        id: season.id,
        season: season.season,
        name: season.name,
        startXp: season.startXp,
        tierSize: season.tierSize,
        maxTier: season.maxTier,
        premiumPrice: season.premiumPrice,
        active: season.active,
      },
      tiers: tiersWithClaimState,
      progress: serializeBattlePass(bp, season),
      currentTier,
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load battle pass" },
      { status: 500 },
    );
  }
}
