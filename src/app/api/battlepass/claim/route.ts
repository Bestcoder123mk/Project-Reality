import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { db, ensureSeed, errorResponse, PLAYER_ID, type ClaimedTier } from "@/lib/api";
const logger = createLogger("/api/battlepass/claim");
import {
  computeTier,
  getActiveSeason,
  getOrCreatePlayerBattlePass,
  isClaimed,
  parseClaimedTiers,
  serializeBattlePass,
  serializeClaimedTiers,
  serializePlayer,
} from "@/lib/api";
import { battlepassClaimSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";

/**
 * I-5000 #3810 — sentinel thrown inside the claim transaction when a
 * concurrent claim already won the race. The outer catch returns 409.
 */
class ClaimRaceError extends Error {
  constructor() {
    super("claim_race");
    this.name = "ClaimRaceError";
  }
}

export async function POST(req: NextRequest) {
  try {
    // Task-1 (SEC) items 5, 6, 8 — CSRF + body-size + Zod.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
    if (bodyError) return bodyError;
    const parsed = battlepassClaimSchema.safeParse(json);
    if (!parsed.success) {
      return errorResponse("Invalid body. Expected { tier: positive int, isPremium?: boolean }.", 400, {
        issues: parsed.error.issues,
      });
    }

    await ensureSeed();

    const tier = parsed.data.tier;
    const isPremium = parsed.data.isPremium ?? false;

    const season = await getActiveSeason();
    const bp = await getOrCreatePlayerBattlePass(season.id);

    const currentTier = computeTier(bp.xp, season.tierSize, season.maxTier);
    if (tier > currentTier) {
      return errorResponse(
        `Tier ${tier} is not yet reached (current tier: ${currentTier})`,
        400,
      );
    }

    if (isPremium && !bp.premium) {
      return errorResponse("Premium tier requires Premium Battle Pass", 400);
    }

    const claimed = parseClaimedTiers(bp.claimedTiers);
    if (isClaimed(claimed, tier, isPremium)) {
      return errorResponse(
        `Tier ${tier} (${isPremium ? "premium" : "free"}) already claimed`,
        400,
      );
    }

    // Find the tier row.
    const tierRow = await db.battlePassTier.findUnique({
      where: {
        seasonId_tier_isPremium: {
          seasonId: season.id,
          tier,
          isPremium,
        },
      },
    });
    if (!tierRow) {
      return errorResponse("Tier reward not found", 404);
    }

    // Grant reward inside a transaction.
    // I-5000 #3810 / A-551 — concurrent-safe claim. The prior code read
    // `claimedTiers` BEFORE the transaction (line 53 above) + used that
    // stale snapshot inside the tx (line 122). Two concurrent claims for
    // the same tier could both pass the `isClaimed` check + both grant
    // the reward. The fix: re-read `bp.claimedTiers` INSIDE the tx + use
    // the fresh snapshot for the `isClaimed` check + the `newClaims` array.
    const result = await db.$transaction(async (tx) => {
      // Re-read the battle pass row inside the tx to get a fresh
      // `claimedTiers` snapshot (the prior code used the stale snapshot
      // from line 53).
      const bpFresh = await tx.playerBattlePass.findUniqueOrThrow({ where: { id: bp.id } });
      const claimedFresh = parseClaimedTiers(bpFresh.claimedTiers);
      if (isClaimed(claimedFresh, tier, isPremium)) {
        // Race: another concurrent claim won. Surface a clean 409.
        throw new ClaimRaceError();
      }

      let granted: { type: string; slug?: string; amount?: number };

      if (tierRow.rewardType === "CREDITS") {
        const player = await tx.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
        await tx.player.update({
          where: { id: PLAYER_ID },
          data: { credits: player.credits + tierRow.rewardAmount },
        });
        granted = { type: "CREDITS", amount: tierRow.rewardAmount };
      } else if (tierRow.rewardType === "WEAPON") {
        const owned = await tx.playerInventory.findFirst({
          where: { playerId: PLAYER_ID, weaponSlug: tierRow.rewardSlug },
        });
        if (!owned) {
          await tx.playerInventory.create({
            data: { playerId: PLAYER_ID, weaponSlug: tierRow.rewardSlug },
          });
        }
        granted = { type: "WEAPON", slug: tierRow.rewardSlug, amount: tierRow.rewardAmount };
      } else if (tierRow.rewardType === "SKIN") {
        const owned = await tx.playerInventory.findFirst({
          where: { playerId: PLAYER_ID, skinSlug: tierRow.rewardSlug },
        });
        if (!owned) {
          await tx.playerInventory.create({
            data: { playerId: PLAYER_ID, skinSlug: tierRow.rewardSlug },
          });
        }
        granted = { type: "SKIN", slug: tierRow.rewardSlug, amount: tierRow.rewardAmount };
      } else {
        // ATTACHMENT
        await tx.playerInventoryAttachment.upsert({
          where: {
            playerId_attachmentSlug: {
              playerId: PLAYER_ID,
              attachmentSlug: tierRow.rewardSlug,
            },
          },
          update: {},
          create: { playerId: PLAYER_ID, attachmentSlug: tierRow.rewardSlug },
        });
        granted = { type: "ATTACHMENT", slug: tierRow.rewardSlug, amount: tierRow.rewardAmount };
      }

      // Add to claimedTiers JSON. I-5000 #3810 — use the FRESH snapshot.
      const newClaimed: ClaimedTier[] = [...claimedFresh, { tier, isPremium }];
      const updatedBp = await tx.playerBattlePass.update({
        where: { id: bp.id },
        data: { claimedTiers: serializeClaimedTiers(newClaimed) },
      });

      const player = await tx.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
      return { granted, updatedBp, player, claimedTiers: newClaimed };
    });

    return NextResponse.json({
      granted: result.granted,
      player: serializePlayer(result.player),
      battlePass: serializeBattlePass(result.updatedBp, season),
      claimedTiers: result.claimedTiers,
    });
  } catch (err) {
    if (err instanceof ClaimRaceError) {
      return errorResponse(
        "Tier already claimed by a concurrent request",
        409,
      );
    }
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Claim failed" },
      { status: 500 },
    );
  }
}
