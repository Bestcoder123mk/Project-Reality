import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { PLAYER_ID, SEASON_1_ID } from "@/lib/seed";
import {
  checkSeasonRollover,
  shouldRotateSeason,
  autoClaimUnclaimedRewards,
  type RolloverResult,
} from "@/lib/game/meta/seasonal-rollover";

/**
 * Backlog §2 item 44 — Integration tests for the season-rollover cron
 * logic (`seasonal-rollover.ts`).
 *
 * The rollover is the live-ops heartbeat: every 5 minutes a cron calls
 * `checkSeasonRollover()` to detect an expired season, auto-claim any
 * unclaimed free-track rewards, deactivate the old season, and
 * activate the next. A bug here silently loses player rewards or
 * soft-locks the battle pass.
 *
 * This integration test runs against the real SQLite DB (the same one
 * the dev server + e2e tests use). It exercises three scenarios:
 *
 *   1. `shouldRotateSeason` — the pure decision function. Covers:
 *      - explicit endsAt in the future → no rotate
 *      - explicit endsAt in the past → rotate
 *      - null endsAt + age < 30d → no rotate
 *      - null endsAt + age > 30d → rotate (legacy heuristic)
 *
 *   2. `checkSeasonRollover` happy path — set the active season's
 *      `endsAt` to the past, call `checkSeasonRollover`, assert:
 *      - rotated: true
 *      - deactivatedSeasonId == the old season's id
 *      - activatedSeasonId == a NEW season row's id
 *      - the old season's `active` is now false
 *      - the new season's `active` is now true
 *      - the new season's `season` number is old + 1
 *      - idempotency: calling again with the same `now` produces
 *        `rotated: false` (the new active season hasn't expired)
 *
 *   3. `autoClaimUnclaimedRewards` — seed a player's battle pass with
 *      xp = 5 tiers worth, mark no tiers claimed, call auto-claim,
 *      assert the free-track tiers 1-5 are now claimed (and any
 *      credits rewards were granted).
 *
 * Env notes:
 *   - SEASON_1_ID is the seeded season 1. The integration tests
 *     modify + restore it (set endsAt to past, then back to null).
 *   - The rollover CREATES new season rows (season 2, 3, …). These
 *     are NOT cleaned up — they persist in the DB. That's fine for
 *     dev (idempotent — findOrCreateNextSeason reuses them); in a
 *     CI env with a fresh DB each run, the new seasons are expected.
 *   - `ensureSeed()` is called implicitly via the module's first DB
 *     access — we don't need to seed explicitly.
 *
 * Honesty note on idempotency:
 *
 *   The rollover is idempotent because:
 *     - "find active season" returns at most one row (unique
 *       constraint: only one `active: true` per season number).
 *     - "mark active=false" uses updateMany with `active: true` in
 *       the WHERE — re-running it is a no-op once the season is
 *       deactivated.
 *     - "find or create next season" upserts by `season` number.
 *
 *   We test this idempotency explicitly: two calls in a row produce
 *   `rotated: true` then `rotated: false` (the second call sees the
 *   newly-active next season, which has endsAt=null + age=0, so no
 *   rotation).
 */

let originalEndsAt: Date | null = null;
let originalActive: boolean | null = null;
const seasonsCreatedDuringTest: string[] = [];

beforeAll(async () => {
  // Snapshot season 1's state so we can restore it.
  const s1 = await db.battlePassSeason.findUnique({ where: { id: SEASON_1_ID } });
  if (!s1) throw new Error(`seed season 1 (${SEASON_1_ID}) not found — run bun run db:push + seed first`);
  originalEndsAt = s1.endsAt;
  originalActive = s1.active;
});

afterAll(async () => {
  // Restore season 1's state.
  if (originalActive !== null) {
    try {
      await db.battlePassSeason.update({
        where: { id: SEASON_1_ID },
        data: { endsAt: originalEndsAt, active: originalActive },
      });
    } catch {
      /* best effort */
    }
  }
  // Deactivate (don't delete — they have tier rows referencing them)
  // any extra seasons created during the test so they don't interfere
  // with other test suites that assume season 1 is active.
  for (const id of seasonsCreatedDuringTest) {
    try {
      await db.battlePassSeason.update({
        where: { id },
        data: { active: false },
      });
    } catch {
      /* best effort */
    }
  }
  // Re-activate season 1 as the canonical active season.
  try {
    await db.battlePassSeason.update({
      where: { id: SEASON_1_ID },
      data: { active: true },
    });
  } catch {
    /* best effort */
  }
  await db.$disconnect();
});

describe("shouldRotateSeason (pure decision function)", () => {
  it("returns no_rotate when endsAt is in the future", () => {
    const now = new Date("2024-06-15T00:00:00Z");
    const season = { endsAt: new Date("2024-06-30T00:00:00Z"), createdAt: new Date("2024-06-01T00:00:00Z") };
    const r = shouldRotateSeason(season, now);
    expect(r.rotate).toBe(false);
    expect(r.reason).toBe("no_expiry");
  });

  it("returns rotate (explicit_window) when endsAt is in the past", () => {
    const now = new Date("2024-07-15T00:00:00Z");
    const season = { endsAt: new Date("2024-06-30T00:00:00Z"), createdAt: new Date("2024-06-01T00:00:00Z") };
    const r = shouldRotateSeason(season, now);
    expect(r.rotate).toBe(true);
    expect(r.reason).toBe("explicit_window");
  });

  it("returns no_rotate when endsAt is null + age < 30 days (legacy heuristic)", () => {
    const now = new Date("2024-06-15T00:00:00Z");
    const season = { endsAt: null, createdAt: new Date("2024-06-01T00:00:00Z") };
    const r = shouldRotateSeason(season, now);
    expect(r.rotate).toBe(false);
    expect(r.reason).toBe("no_expiry");
  });

  it("returns rotate (legacy_heuristic) when endsAt is null + age > 30 days", () => {
    const now = new Date("2024-08-15T00:00:00Z"); // 75 days later
    const season = { endsAt: null, createdAt: new Date("2024-06-01T00:00:00Z") };
    const r = shouldRotateSeason(season, now);
    expect(r.rotate).toBe(true);
    expect(r.reason).toBe("legacy_heuristic");
  });

  it("returns rotate exactly at the 30-day boundary (>= endsAt → rotate)", () => {
    const createdAt = new Date("2024-06-01T00:00:00Z");
    const exactly30Days = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const season = { endsAt: null, createdAt };
    const r = shouldRotateSeason(season, exactly30Days);
    expect(r.rotate).toBe(true);
    expect(r.reason).toBe("legacy_heuristic");
  });
});

describe("checkSeasonRollover (integration against real SQLite)", () => {
  it("rotates when the active season's endsAt has passed + activates a new season", async () => {
    // 1. Force season 1's endsAt to the past + ensure it's the only active season.
    await db.battlePassSeason.update({
      where: { id: SEASON_1_ID },
      data: { endsAt: new Date("2020-01-01T00:00:00Z"), active: true },
    });
    // Deactivate any other active seasons that might be lingering from
    // prior test runs (the rollover picks the highest-numbered active
    // season, so a stale season-2-active row would skip season 1).
    const otherActive = await db.battlePassSeason.findMany({
      where: { active: true, NOT: { id: SEASON_1_ID } },
    });
    for (const s of otherActive) {
      await db.battlePassSeason.update({ where: { id: s.id }, data: { active: false } });
    }

    // 2. Call the rollover.
    const result: RolloverResult = await checkSeasonRollover(new Date("2024-06-15T00:00:00Z"));

    // 3. Assert the rollover happened.
    expect(result.rotated).toBe(true);
    expect(result.reason).toBe("explicit_window");
    expect(result.deactivatedSeasonId).toBe(SEASON_1_ID);
    expect(result.activatedSeasonId).not.toBeNull();
    expect(result.activatedSeasonId).not.toBe(SEASON_1_ID);
    seasonsCreatedDuringTest.push(result.activatedSeasonId!);

    // 4. Verify the DB state.
    const oldSeason = await db.battlePassSeason.findUniqueOrThrow({ where: { id: SEASON_1_ID } });
    expect(oldSeason.active).toBe(false);

    const newSeason = await db.battlePassSeason.findUniqueOrThrow({
      where: { id: result.activatedSeasonId! },
    });
    expect(newSeason.active).toBe(true);
    expect(newSeason.season).toBe(oldSeason.season + 1);

    // 5. Verify exactly ONE active season exists after the rollover.
    const activeCount = await db.battlePassSeason.count({ where: { active: true } });
    expect(activeCount).toBe(1);
  });

  it("is idempotent — a second call with a fresh active season does not rotate again", async () => {
    // After the previous test, the new active season has endsAt=null +
    // age=0 → shouldRotate returns false.
    const result = await checkSeasonRollover(new Date("2024-06-15T00:00:00Z"));
    expect(result.rotated).toBe(false);
    // The reason is "no_expiry" because the new season has no endsAt
    // set (findOrCreateNextSeason leaves endsAt=null) + is fresh.
    expect(["no_expiry", "legacy_heuristic"]).toContain(result.reason);
  });

  it("reuses an existing next-season row if one already exists (no duplicate seasons)", async () => {
    // Force another rotation: set the current active season's endsAt
    // to the past again, then call rollover. The next season (current+1)
    // may already exist from a prior test run — findOrCreateNextSeason
    // should reuse it rather than creating a duplicate.
    const currentActive = await db.battlePassSeason.findFirstOrThrow({
      where: { active: true },
      orderBy: { season: "desc" },
    });
    const nextSeasonNumber = currentActive.season + 1;
    // Count seasons with this number before the call.
    const beforeCount = await db.battlePassSeason.count({
      where: { season: nextSeasonNumber },
    });

    await db.battlePassSeason.update({
      where: { id: currentActive.id },
      data: { endsAt: new Date("2020-01-01T00:00:00Z") },
    });

    const result = await checkSeasonRollover(new Date("2024-06-15T00:00:00Z"));
    expect(result.rotated).toBe(true);
    if (result.activatedSeasonId) seasonsCreatedDuringTest.push(result.activatedSeasonId);

    // After the call, the count of seasons with nextSeasonNumber must
    // be exactly 1 (no duplicates). If beforeCount was 1 (a stale row
    // from a prior run), findOrCreateNextSeason reused it; if it was
    // 0, it created a new one. Either way: post-condition is 1.
    const afterCount = await db.battlePassSeason.count({
      where: { season: nextSeasonNumber },
    });
    expect(afterCount).toBe(1);
  });
});

describe("autoClaimUnclaimedRewards (integration against real SQLite)", () => {
  it("auto-claims free-track tiers the player reached but didn't tap", async () => {
    // Pick the currently-active season.
    const season = await db.battlePassSeason.findFirstOrThrow({
      where: { active: true },
      orderBy: { season: "desc" },
      include: { tiers: { where: { isPremium: false }, orderBy: { tier: "asc" } } },
    });

    // The seed creates free-track tier rows only at multiples of 5
    // (tier 5, 10, 15, …, 50) — see BattlePassSeasons.createNewSeason.
    // Set the player's xp so they've reached tier 10 → the free-track
    // tier rows for tier 5 + tier 10 should both be auto-claimed.
    const targetTier = 10;
    const playerBp = await db.playerBattlePass.upsert({
      where: { playerId_seasonId: { playerId: PLAYER_ID, seasonId: season.id } },
      update: { xp: season.tierSize * targetTier, claimedTiers: "[]" },
      create: {
        playerId: PLAYER_ID,
        seasonId: season.id,
        xp: season.tierSize * targetTier,
        premium: false,
        claimedTiers: "[]",
        status: "ACTIVE",
      },
    });

    // Snapshot the player's credit balance before auto-claim (some
    // free tiers grant CREDITS — we want to confirm they were added).
    const playerBefore = await db.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
    const creditsBefore = playerBefore.credits;

    // The free-track tiers ≤ targetTier that should be auto-claimed.
    const expectedClaimedTiers = season.tiers.filter((t) => t.tier <= targetTier);
    // Sanity: there must be at least one such tier (else the test
    // isn't exercising anything).
    expect(expectedClaimedTiers.length).toBeGreaterThan(0);

    const expectedCreditGain = expectedClaimedTiers
      .filter((t) => t.rewardType === "CREDITS")
      .reduce((s, t) => s + t.rewardAmount, 0);

    // Run auto-claim.
    const claimedCount = await autoClaimUnclaimedRewards(season.id);
    expect(claimedCount).toBe(expectedClaimedTiers.length);

    // The PlayerBattlePass row should now have those tiers claimed.
    const playerBpAfter = await db.playerBattlePass.findUniqueOrThrow({
      where: { id: playerBp.id },
    });
    expect(playerBpAfter.claimedTiers).not.toBe("[]");
    const claimed = JSON.parse(playerBpAfter.claimedTiers) as Array<{ tier: number; isPremium: boolean }>;
    for (const t of expectedClaimedTiers) {
      expect(claimed.some((c) => c.tier === t.tier && c.isPremium === false)).toBe(true);
    }

    // The player's credits should have increased by the sum of CREDITS
    // rewards on the auto-claimed tiers.
    const playerAfter = await db.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
    expect(playerAfter.credits - creditsBefore).toBe(expectedCreditGain);

    // Idempotency: re-running auto-claim on the same season claims
    // nothing new (the tiers are already in claimedTiers).
    const secondRun = await autoClaimUnclaimedRewards(season.id);
    expect(secondRun).toBe(0);
  });
});
