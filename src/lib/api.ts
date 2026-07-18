import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureSeed, PLAYER_ID, SEASON_1_ID } from "@/lib/seed";
import type {
  BattlePassSeason,
  BattlePassStatus,
  Player,
  PlayerBattlePass,
  PlayerLoadout,
  Prisma,
} from "@prisma/client";

// Re-export for convenience so route files import from a single place.
export { db, ensureSeed, PLAYER_ID, SEASON_1_ID };
export { computeTierSkipCost } from "@/lib/game/BattlePassSeasons";
export { serializeChallenge } from "@/lib/game/Challenges";
export type { SerializedChallenge } from "@/lib/game/Challenges";

export type ClaimedTier = { tier: number; isPremium: boolean };

/**
 * Returns the active BattlePassSeason (currently the seeded season 1).
 * Ensures seed has run first.
 */
export async function getActiveSeason(): Promise<BattlePassSeason> {
  await ensureSeed();
  const season = await db.battlePassSeason.findFirst({
    where: { active: true },
    orderBy: { season: "desc" },
  });
  if (!season) {
    // Should never happen post-seed, but satisfy TS.
    throw new Error("No active Battle Pass season");
  }
  return season;
}

/**
 * Returns (or creates) the player's PlayerBattlePass row for the given season.
 */
export async function getOrCreatePlayerBattlePass(
  seasonId: string,
): Promise<PlayerBattlePass> {
  await ensureSeed();
  return db.playerBattlePass.upsert({
    where: { playerId_seasonId: { playerId: PLAYER_ID, seasonId } },
    update: {},
    create: {
      playerId: PLAYER_ID,
      seasonId,
      xp: 0,
      premium: false,
      claimedTiers: "[]",
      status: "ACTIVE",
    },
  });
}

export function computeTier(xp: number, tierSize: number, maxTier: number): number {
  const raw = Math.floor(xp / tierSize);
  return Math.min(raw, maxTier);
}

export function serializePlayer(player: Player) {
  return {
    id: player.id,
    displayName: player.displayName,
    credits: player.credits,
    level: player.level,
    xp: player.xp,
  };
}

export type SerializedPlayer = ReturnType<typeof serializePlayer>;

/**
 * Builds the public battle-pass view described in the GET /api/player spec.
 */
export function serializeBattlePass(
  bp: PlayerBattlePass,
  season: BattlePassSeason,
) {
  const tier = computeTier(bp.xp, season.tierSize, season.maxTier);
  const nextTierXp = (tier + 1) * season.tierSize;
  return {
    season: season.season,
    tier,
    xp: bp.xp,
    tierSize: season.tierSize,
    maxTier: season.maxTier,
    premium: bp.premium,
    claimedTiers: parseClaimedTiers(bp.claimedTiers),
    nextTierXp,
    status: bp.status as BattlePassStatus,
  };
}

export type SerializedBattlePass = ReturnType<typeof serializeBattlePass>;

/**
 * Parses the JSON-stored claimed tiers. Stored as an array of
 * `{ tier: number, isPremium: boolean }` objects so the free and premium
 * tracks are tracked independently (a deviation from the literal `number[]`
 * in the brief, required for correctness — see worklog).
 */
export function parseClaimedTiers(json: string): ClaimedTier[] {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is ClaimedTier =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as ClaimedTier).tier === "number" &&
          typeof (e as ClaimedTier).isPremium === "boolean",
      )
      .map((e) => ({ tier: e.tier, isPremium: e.isPremium }));
  } catch {
    return [];
  }
}

export function serializeClaimedTiers(arr: ClaimedTier[]): string {
  return JSON.stringify(arr);
}

export function isClaimed(
  claimed: ClaimedTier[],
  tier: number,
  isPremium: boolean,
): boolean {
  return claimed.some(
    (c) => c.tier === tier && c.isPremium === isPremium,
  );
}

/**
 * Returns the player's owned catalog slugs grouped by type.
 */
export async function getPlayerInventorySlugs(): Promise<{
  weapons: string[];
  attachments: string[];
  skins: string[];
  operators: string[];
}> {
  const [invWeapons, invSkins, invAttachments, invOperators] = await Promise.all([
    db.playerInventory.findMany({
      where: { playerId: PLAYER_ID, weaponSlug: { not: null } },
      select: { weaponSlug: true },
    }),
    db.playerInventory.findMany({
      where: { playerId: PLAYER_ID, skinSlug: { not: null } },
      select: { skinSlug: true },
    }),
    db.playerInventoryAttachment.findMany({
      where: { playerId: PLAYER_ID },
      select: { attachmentSlug: true },
    }),
    db.playerInventoryOperator.findMany({
      where: { playerId: PLAYER_ID },
      select: { operatorSlug: true },
    }),
  ]);

  return {
    weapons: invWeapons
      .map((r) => r.weaponSlug)
      .filter((s): s is string => Boolean(s)),
    attachments: invAttachments.map((r) => r.attachmentSlug),
    skins: invSkins
      .map((r) => r.skinSlug)
      .filter((s): s is string => Boolean(s)),
    operators: invOperators.map((r) => r.operatorSlug),
  };
}

/**
 * Builds the public loadout + equipped view from a list of PlayerLoadout rows.
 */
export function serializeLoadouts(loadouts: PlayerLoadout[]) {
  const equippedLoadout = loadouts.find((l) => l.isEquipped) ?? null;
  const equipped = equippedLoadout
    ? {
        weaponSlug: equippedLoadout.weaponSlug,
        muzzleSlug: equippedLoadout.muzzleSlug,
        sightSlug: equippedLoadout.sightSlug,
        gripSlug: equippedLoadout.gripSlug,
        magazineSlug: equippedLoadout.magazineSlug,
        skinSlug: equippedLoadout.skinSlug,
        operatorSlug: equippedLoadout.operatorSlug,
      }
    : null;
  return { loadouts, equipped };
}

/**
 * Standard error JSON helper.
 */
export function errorResponse(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

// Avoid unused-import lint when Prisma type is only used in type position.
export type { Prisma };
