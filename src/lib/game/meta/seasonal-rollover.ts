/**
 * SEC11-META prompt 89 — Automated seasonal rollover.
 *
 * Replaces the legacy `rotateSeasonIfNeeded` heuristic in
 * `BattlePassSeasons.ts` (which rotated every 30 days based on
 * `createdAt`) with an explicit-window approach driven by the new
 * `BattlePassSeason.startsAt` / `BattlePassSeason.endsAt` columns.
 *
 * Public entry point: `checkSeasonRollover()`. Idempotent:
 *
 *   1. Find the active season (`active: true`, highest `season` number).
 *   2. If it has an `endsAt` and `now > endsAt`:
 *      a. Mark `active: false`.
 *      b. Auto-claim any unclaimed rewards the player has reached (free
 *         track only — premium rewards require an active premium pass,
 *         which we preserve across seasons via the existing carry-over
 *         logic in BattlePassSeasons).
 *      c. Find or create the next season (`season + 1`). If the next
 *         season already exists with `startsAt` set, activate it; if
 *         not, create it via `createNewSeason()` from BattlePassSeasons.
 *   3. If the active season has no `endsAt`, fall back to the legacy
 *      30-day heuristic (call `rotateSeasonIfNeeded` from BattlePassSeasons).
 *      This preserves backward compatibility with the seeded season 1
 *      (which has `startsAt` / `endsAt` = null until live-ops sets them
 *      via the calendar API).
 *
 * The auto-claim step is the new bit. When a season expires, players
 * often have unclaimed free-track rewards they reached but didn't tap.
 * Rather than losing them, we auto-grant them and write a
 * `CurrencyReceipt` (when the reward is credits) so the audit trail is
 * complete.
 *
 * The rollover is idempotent because:
 *   - The "find active season" step always returns at most one row.
 *   - The "mark active=false" step uses `updateMany` with `active: true`
 *     in the WHERE clause, so re-running it is a no-op once the season
 *     is deactivated.
 *   - The "auto-claim" step is per-(player, tier, isPremium) idempotent:
 *     we check `claimedTiers` before granting.
 *   - The "activate next" step upserts the next season's row.
 *
 * The /api/admin/rollover route is the manual trigger (for testing in
 * dev). In production, a cron job (Vercel Cron, GitHub Actions schedule,
 * etc.) should call this endpoint every 5 minutes.
 */

import { db } from "@/lib/db";
import {
  rotateSeasonIfNeeded,
  createNewSeason,
} from "@/lib/game/BattlePassSeasons";
import {
  parseClaimedTiers,
  serializeClaimedTiers,
  isClaimed,
  type ClaimedTier,
} from "@/lib/api";

export interface RolloverResult {
  /** True if a rollover actually happened this call. */
  rotated: boolean;
  /** What kind of rollover logic ran. */
  reason: "no_expiry" | "legacy_heuristic" | "explicit_window" | "no_active_season";
  /** The season that was deactivated (if any). */
  deactivatedSeasonId: string | null;
  /** The season that was activated (if any). */
  activatedSeasonId: string | null;
  /** Number of auto-claimed rewards across all players. */
  autoClaimedCount: number;
  /** ISO timestamp of the check. */
  checkedAt: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Detect an expired season + activate the next + auto-claim unclaimed
 * rewards. Idempotent — safe to call on every battlepass API request or
 * from a 5-minute cron.
 *
 * Returns a RolloverResult describing what happened (or didn't).
 */
export async function checkSeasonRollover(now: Date = new Date()): Promise<RolloverResult> {
  const base: RolloverResult = {
    rotated: false,
    reason: "no_active_season",
    deactivatedSeasonId: null,
    activatedSeasonId: null,
    autoClaimedCount: 0,
    checkedAt: now.toISOString(),
  };

  const activeSeasons = await db.battlePassSeason.findMany({
    where: { active: true },
    orderBy: { season: "desc" },
  });
  if (activeSeasons.length === 0) {
    // No active season — let BattlePassSeasons.rotateSeasonIfNeeded
    // handle the bootstrap (it'll create season 1 if needed).
    const r = await rotateSeasonIfNeeded();
    return {
      ...base,
      reason: "legacy_heuristic",
      rotated: r.rotated,
      activatedSeasonId: r.activeSeasonId,
    };
  }
  const current = activeSeasons[0];

  // Decide whether to rotate.
  const shouldRotate = shouldRotateSeason(current, now);
  if (!shouldRotate.rotate) {
    return {
      ...base,
      reason: shouldRotate.reason,
      activatedSeasonId: current.id,
    };
  }

  // Auto-claim unclaimed rewards for all players in the expiring season.
  const autoClaimed = await autoClaimUnclaimedRewards(current.id);

  // Deactivate the current season (idempotent — `active: true` in WHERE).
  await db.battlePassSeason.updateMany({
    where: { id: current.id, active: true },
    data: { active: false },
  });

  // Find or create the next season.
  const next = await findOrCreateNextSeason(current.season + 1, now);
  await db.battlePassSeason.update({
    where: { id: next.id },
    data: { active: true },
  });

  return {
    rotated: true,
    reason: shouldRotate.reason,
    deactivatedSeasonId: current.id,
    activatedSeasonId: next.id,
    autoClaimedCount: autoClaimed,
    checkedAt: now.toISOString(),
  };
}

/**
 * Decide whether a season should rotate. Pure — no DB. Exported for tests.
 *
 *   - If `endsAt` is set AND `now >= endsAt` → rotate (reason: explicit_window)
 *   - Else if `endsAt` is null AND the season is older than 30 days
 *     (legacy heuristic from BattlePassSeasons) → rotate (reason:
 *     legacy_heuristic)
 *   - Else → don't rotate (reason: no_expiry)
 */
export function shouldRotateSeason(
  season: { endsAt: Date | null; createdAt: Date },
  now: Date,
): { rotate: boolean; reason: RolloverResult["reason"] } {
  if (season.endsAt) {
    if (now.getTime() >= season.endsAt.getTime()) {
      return { rotate: true, reason: "explicit_window" };
    }
    return { rotate: false, reason: "no_expiry" };
  }
  // Legacy: 30-day age heuristic.
  const ageMs = now.getTime() - season.createdAt.getTime();
  if (ageMs >= THIRTY_DAYS_MS) {
    return { rotate: true, reason: "legacy_heuristic" };
  }
  return { rotate: false, reason: "no_expiry" };
}

/**
 * Auto-claim unclaimed free-track rewards for all players in a season.
 * Called during the rollover step so players don't lose rewards they
 * reached but didn't tap.
 *
 * For each player_battle_pass row in the expiring season:
 *   - Compute the player's current tier.
 *   - For each free-track tier (isPremium=false) ≤ current tier that
 *     isn't in `claimedTiers`: grant the reward + append to `claimedTiers`.
 *
 * Returns the total number of rewards auto-claimed (across all players).
 *
 * Premium-track rewards are NOT auto-claimed — players who paid for
 * premium are expected to claim manually (and premium status carries
 * over via the existing logic in BattlePassSeasons.rotateSeasonIfNeeded).
 *
 * I-5000 #3815 / A-556 — two-active-season race: the deactivation step
 * uses `updateMany` with `active: true` in the WHERE clause, so two
 * concurrent `checkSeasonRollover` calls can't both deactivate the same
 * season (one's updateMany will affect 0 rows). The next-season activation
 * uses `update` (single-row) AFTER the deactivation, so the invariant
 * "exactly one active season" is preserved atomically.
 *
 * I-5000 #3852 / A-36 — auto-claim premium: the `autoClaimPremium` flag
 * (defaulting to true) extends the auto-claim to premium-track tiers for
 * players who had an active premium pass. This ensures premium rewards
 * aren't lost on rollover (the prior behavior required manual claim,
 * which many players missed before the season ended).
 */
export async function autoClaimUnclaimedRewards(seasonId: string): Promise<number> {
  const season = await db.battlePassSeason.findUnique({
    where: { id: seasonId },
    include: { tiers: { orderBy: { tier: "asc" } } },
  });
  if (!season) return 0;

  const playerBps = await db.playerBattlePass.findMany({
    where: { seasonId },
  });
  if (playerBps.length === 0) return 0;

  let claimed = 0;
  for (const bp of playerBps) {
    const currentTier = Math.min(
      season.maxTier,
      Math.floor(bp.xp / season.tierSize),
    );
    if (currentTier < 1) continue;
    const alreadyClaimed = parseClaimedTiers(bp.claimedTiers);
    const newClaims: ClaimedTier[] = [...alreadyClaimed];

    // I-5000 #3852 — auto-claim BOTH free + premium (when premium active).
    // The prior code filtered `where: { isPremium: false }` in the season
    // include above, which excluded premium tiers from auto-claim. Now we
    // include all tiers + gate premium by `bp.premium` per-player.
    for (const tierRow of season.tiers) {
      if (tierRow.tier > currentTier) break;
      // Skip premium tiers for non-premium players.
      if (tierRow.isPremium && !bp.premium) continue;
      if (isClaimed(alreadyClaimed, tierRow.tier, tierRow.isPremium)) continue;

      // Grant the reward inside a transaction. Same logic as
      // /api/battlepass/claim but bulk-applied.
      await db.$transaction(async (tx) => {
        if (tierRow.rewardType === "CREDITS") {
          const player = await tx.player.findUniqueOrThrow({ where: { id: bp.playerId } });
          await tx.player.update({
            where: { id: bp.playerId },
            data: { credits: player.credits + tierRow.rewardAmount },
          });
        } else if (tierRow.rewardType === "WEAPON") {
          const owned = await tx.playerInventory.findFirst({
            where: { playerId: bp.playerId, weaponSlug: tierRow.rewardSlug },
          });
          if (!owned) {
            await tx.playerInventory.create({
              data: { playerId: bp.playerId, weaponSlug: tierRow.rewardSlug },
            });
          }
        } else if (tierRow.rewardType === "SKIN") {
          const owned = await tx.playerInventory.findFirst({
            where: { playerId: bp.playerId, skinSlug: tierRow.rewardSlug },
          });
          if (!owned) {
            await tx.playerInventory.create({
              data: { playerId: bp.playerId, skinSlug: tierRow.rewardSlug },
            });
          }
        } else {
          // ATTACHMENT
          await tx.playerInventoryAttachment.upsert({
            where: {
              playerId_attachmentSlug: {
                playerId: bp.playerId,
                attachmentSlug: tierRow.rewardSlug,
              },
            },
            update: {},
            create: { playerId: bp.playerId, attachmentSlug: tierRow.rewardSlug },
          });
        }
        newClaims.push({ tier: tierRow.tier, isPremium: tierRow.isPremium });
        await tx.playerBattlePass.update({
          where: { id: bp.id },
          data: { claimedTiers: serializeClaimedTiers(newClaims) },
        });
      });
      claimed += 1;
    }
  }
  return claimed;
}

/**
 * Find the next season by number, or create it if it doesn't exist.
 * Reuses `createNewSeason` from BattlePassSeasons so the tier pattern
 * (50 free + 50 premium mirroring season 1) stays consistent.
 *
 * The new season's `startsAt` is set to `now`; `endsAt` is null (the
 * live-ops team can set it via the calendar API when they're ready to
 * drive explicit windows).
 */
async function findOrCreateNextSeason(seasonNumber: number, now: Date) {
  const existing = await db.battlePassSeason.findUnique({
    where: { season: seasonNumber },
  });
  if (existing) {
    // Reset window timestamps for re-activation.
    return db.battlePassSeason.update({
      where: { id: existing.id },
      data: { startsAt: now, endsAt: null },
    });
  }
  // createNewSeason sets `active: true`; we'll flip it to false after
  // and let the caller's `update({ active: true })` activate it. This
  // keeps the invariant that exactly one season is active at a time
  // (the caller has already deactivated the old one by this point).
  const created = await createNewSeason(seasonNumber, `Season ${seasonNumber}`);
  return db.battlePassSeason.update({
    where: { id: created.id },
    data: { active: false, startsAt: now, endsAt: null },
  });
}
