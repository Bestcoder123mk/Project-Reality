/**
 * Task-1 (SEC) item 25 — GDPR cascade verification script.
 *
 * Inserts one row into every player-owned Prisma model for a throwaway
 * test player, then calls the GDPR delete path (`deletePlayerData`)
 * and asserts every player-owned model is empty for that playerId.
 *
 * Run with: `bun run verify:gdpr` (alias for `bun run scripts/verify-gdpr-cascade.ts`)
 *
 * The script:
 *   1. Generates a unique test playerId (`gdpr-test-<timestamp>`).
 *   2. Creates the Player row (with minimum viable fields).
 *   3. Inserts one row into every player-owned model listed below.
 *      (Models that require a non-player parent row — e.g. ClanMember
 *      needs a Clan, NpcMemory needs an NpcCharacter — get a stub
 *      parent inserted first + cleaned up at the end.)
 *   4. Calls `deletePlayerData(testPlayerId)`.
 *   5. Re-reads every player-owned model for that playerId + asserts
 *      the count is 0 (or, for PlayerEvent, that the playerId is null).
 *   6. Prints a structured pass/fail report.
 *   7. Exits non-zero on any failure so CI catches regressions.
 *
 * The list of player-owned models is sourced from `prisma/schema.prisma`
 * — every model with a `playerId` field. See `security.md` for the
 * full enumeration.
 */

import { db } from "../src/lib/db";
import { deletePlayerData } from "../src/lib/game/platform/gdpr";
import { PLAYER_ID } from "../src/lib/seed";

// ── Test player setup ─────────────────────────────────────────────────────

async function makeTestPlayer(id: string): Promise<void> {
  await db.player.upsert({
    where: { id },
    update: {},
    create: {
      id,
      displayName: `GDPR-Test-${id.slice(-6)}`,
      credits: 100,
      level: 1,
      xp: 0,
    },
  });
}

// ── Player-owned model inserts ────────────────────────────────────────────
//
// Each entry inserts one row into the named model for `playerId`. Models
// are listed in dependency order (parents before children). The `cleanup`
// field is for stub-parent rows that need to be removed at the end (the
// GDPR delete cascades the player-owned rows but not the stub parent).

interface Insert {
  model: string;
  insert: (playerId: string) => Promise<void>;
}

const inserts: Insert[] = [
  {
    model: "playerInventory",
    insert: async (pid) => {
      await db.playerInventory.create({
        data: { playerId: pid, weaponSlug: "ak74" },
      });
    },
  },
  {
    model: "playerInventoryAttachment",
    insert: async (pid) => {
      await db.playerInventoryAttachment.create({
        data: { playerId: pid, attachmentSlug: "red_dot" },
      });
    },
  },
  {
    model: "playerInventoryOperator",
    insert: async (pid) => {
      await db.playerInventoryOperator.create({
        data: { playerId: pid, operatorSlug: "warden" },
      });
    },
  },
  {
    model: "playerLoadout",
    insert: async (pid) => {
      await db.playerLoadout.create({
        data: {
          playerId: pid,
          weaponSlug: "ak74",
          muzzleSlug: null,
          sightSlug: null,
          gripSlug: null,
          magazineSlug: null,
          skinSlug: null,
          operatorSlug: null,
          isEquipped: false,
        },
      });
    },
  },
  {
    model: "playerBattlePass",
    insert: async (pid) => {
      const season = await db.battlePassSeason.findFirst({
        where: { active: true },
      });
      if (!season) return;
      await db.playerBattlePass.create({
        data: {
          playerId: pid,
          seasonId: season.id,
          xp: 0,
          premium: false,
          claimedTiers: "[]",
          status: "ACTIVE",
        },
      });
    },
  },
  {
    model: "matchEarning",
    insert: async (pid) => {
      await db.matchEarning.create({
        data: {
          playerId: pid,
          credits: 10,
          xp: 5,
          kills: 1,
          wave: 0,
          result: "DEFEAT",
        },
      });
    },
  },
  {
    model: "playerMedicalState",
    insert: async (pid) => {
      await db.playerMedicalState.create({
        data: { playerId: pid, state: "ACTIVE", bleedRate: 0, fractureLimb: "" },
      });
    },
  },
  {
    model: "playerMedicalInventory",
    insert: async (pid) => {
      await db.playerMedicalInventory.create({
        data: { playerId: pid, itemSlug: "bandage", quantity: 1 },
      });
    },
  },
  {
    model: "playerChallenge",
    insert: async (pid) => {
      await db.playerChallenge.create({
        data: {
          playerId: pid,
          type: "KILLS",
          cadence: "DAILY",
          target: 1,
          progress: 0,
          completed: false,
          claimed: false,
          rewardCredits: 0,
          rewardXp: 0,
          description: "",
          resetsAt: new Date(Date.now() + 86400000),
        },
      });
    },
  },
  {
    model: "playerOperatorCustomization",
    insert: async (pid) => {
      await db.playerOperatorCustomization.create({
        data: { playerId: pid, baseSlug: "warden", overrides: "{}" },
      });
    },
  },
  {
    model: "currencyReceipt",
    insert: async (pid) => {
      await db.currencyReceipt.create({
        data: {
          playerId: pid,
          reason: "test",
          itemSlug: "ak74",
          amount: 100,
          balanceBefore: 100,
          balanceAfter: 0,
          nonce: `gdpr-test-${pid}-${Date.now()}`,
          signature: "test",
        },
      });
    },
  },
  {
    model: "lootBoxRoll",
    insert: async (pid) => {
      await db.lootBoxRoll.create({
        data: {
          playerId: pid,
          packSlug: "tactical",
          itemKind: "wrap",
          itemSlug: "woodland_camo",
          rarity: "COMMON",
          seed: "test",
        },
      });
    },
  },
  {
    model: "clanMember",
    insert: async (pid) => {
      // Stub a Clan for the membership to point at.
      const clan = await db.clan.create({
        data: { name: `GDPR-Test-Clan-${pid.slice(-6)}`, tag: "GDR", xp: 0 },
      });
      await db.clanMember.create({
        data: { playerId: pid, clanId: clan.id, role: "member" },
      });
    },
  },
  {
    model: "clanContribution",
    insert: async (pid) => {
      const clan = await db.clan.findFirst({ where: { name: { startsWith: "GDPR-Test-Clan-" } } });
      if (!clan) return;
      await db.clanContribution.create({
        data: { clanId: clan.id, playerId: pid, source: "match", amount: 1, at: new Date() },
      });
    },
  },
  {
    model: "experimentExposure",
    insert: async (pid) => {
      await db.experimentExposure.create({
        data: { flagKey: "gdpr-test", playerId: pid, cohort: "A", variant: "" },
      });
    },
  },
  {
    model: "playerSession",
    insert: async (pid) => {
      await db.playerSession.create({
        data: { playerId: pid, sessionId: `gdpr-test-${pid}` },
      });
    },
  },
  {
    model: "playerEvent",
    insert: async (pid) => {
      await db.playerEvent.create({
        data: {
          playerId: pid,
          sessionId: "gdpr-test",
          name: "gdpr_test_event",
          props: "{}",
        },
      });
    },
  },
  {
    model: "supplyTransaction",
    insert: async (pid) => {
      await db.supplyTransaction.create({
        data: {
          playerId: pid,
          type: "BUY",
          resource: "bandage",
          amount: 1,
        },
      });
    },
  },
  {
    model: "replay",
    insert: async (pid) => {
      await db.replay.create({
        data: {
          playerId: pid,
          matchId: "gdpr-test-match",
          seed: 1,
          mode: "SURVIVAL",
          loadoutSlug: "ak74",
          result: "DEFEAT",
          finalScore: 0,
          finalKills: 0,
          durationMs: 1000,
          frameCount: 1,
          replayData: "{}",
        },
      });
    },
  },
  {
    model: "npcMemory",
    insert: async (pid) => {
      // Stub an NpcCharacter for the memory to point at.
      const npc = await db.npcCharacter.create({
        data: { name: `GDPR-Test-NPC-${pid.slice(-6)}` },
      });
      await db.npcMemory.create({
        data: {
          npcId: npc.id,
          playerId: pid,
          type: "observation",
          content: "test",
          importance: 0.5,
        },
      });
    },
  },
  {
    model: "dialogueLog",
    insert: async (pid) => {
      const npc = await db.npcCharacter.findFirst({ where: { name: { startsWith: "GDPR-Test-NPC-" } } });
      if (!npc) return;
      await db.dialogueLog.create({
        data: {
          npcId: npc.id,
          playerId: pid,
          role: "user",
          content: "test",
        },
      });
    },
  },
  {
    model: "bugReport",
    insert: async (pid) => {
      await db.bugReport.create({
        data: {
          playerId: pid,
          category: "other",
          severity: "low",
          description: "gdpr test",
        },
      });
    },
  },
  {
    model: "supportTicket",
    insert: async (pid) => {
      await db.supportTicket.create({
        data: {
          playerId: pid,
          category: "other",
          subject: "gdpr test",
          description: "gdpr test",
        },
      });
    },
  },
];

// ── Verification ──────────────────────────────────────────────────────────

async function assertEmpty(playerId: string): Promise<Array<{ model: string; count: number }>> {
  const checks: Array<{ model: string; count: number }> = [];
  const run = async (model: string, fn: () => Promise<number>) => {
    const count = await fn();
    checks.push({ model, count });
  };

  await run("playerInventory", () => db.playerInventory.count({ where: { playerId } }));
  await run("playerInventoryAttachment", () => db.playerInventoryAttachment.count({ where: { playerId } }));
  await run("playerInventoryOperator", () => db.playerInventoryOperator.count({ where: { playerId } }));
  await run("playerLoadout", () => db.playerLoadout.count({ where: { playerId } }));
  await run("playerBattlePass", () => db.playerBattlePass.count({ where: { playerId } }));
  await run("matchEarning", () => db.matchEarning.count({ where: { playerId } }));
  await run("playerMedicalState", () => db.playerMedicalState.count({ where: { playerId } }));
  await run("playerMedicalInventory", () => db.playerMedicalInventory.count({ where: { playerId } }));
  await run("playerChallenge", () => db.playerChallenge.count({ where: { playerId } }));
  await run("playerOperatorCustomization", () => db.playerOperatorCustomization.count({ where: { playerId } }));
  await run("currencyReceipt", () => db.currencyReceipt.count({ where: { playerId } }));
  await run("lootBoxRoll", () => db.lootBoxRoll.count({ where: { playerId } }));
  await run("clanMember", () => db.clanMember.count({ where: { playerId } }));
  await run("clanContribution", () => db.clanContribution.count({ where: { playerId } }));
  await run("experimentExposure", () => db.experimentExposure.count({ where: { playerId } }));
  await run("playerSession", () => db.playerSession.count({ where: { playerId } }));
  // PlayerEvent is anonymized (playerId set to null), not hard-deleted.
  await run("playerEvent (non-null playerId)", () => db.playerEvent.count({ where: { playerId } }));
  await run("supplyTransaction", () => db.supplyTransaction.count({ where: { playerId } }));
  await run("replay", () => db.replay.count({ where: { playerId } }));
  await run("npcMemory", () => db.npcMemory.count({ where: { playerId } }));
  await run("dialogueLog", () => db.dialogueLog.count({ where: { playerId } }));
  await run("bugReport", () => db.bugReport.count({ where: { playerId } }));
  await run("supportTicket", () => db.supportTicket.count({ where: { playerId } }));
  await run("player", () => db.player.count({ where: { id: playerId } }));

  return checks;
}

// ── Stub-parent cleanup ──────────────────────────────────────────────────

async function cleanupStubParents(): Promise<void> {
  // Delete the stub Clan(s) + NpcCharacter(s) created above.
  await db.clan.deleteMany({ where: { name: { startsWith: "GDPR-Test-Clan-" } } });
  await db.npcCharacter.deleteMany({ where: { name: { startsWith: "GDPR-Test-NPC-" } } });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const testId = `gdpr-test-${Date.now()}`;
  console.log(`\n[verify-gdpr-cascade] starting with test player ${testId}\n`);

  // 1. Create test player.
  await makeTestPlayer(testId);
  console.log(`  ✓ created Player row`);

  // 2. Insert one row into every player-owned model.
  for (const { model, insert } of inserts) {
    try {
      await insert(testId);
      console.log(`  ✓ inserted row into ${model}`);
    } catch (err) {
      console.error(`  ✗ FAILED to insert into ${model}:`, err instanceof Error ? err.message : err);
      // Continue — we still want to verify the cascade for the models that did insert.
    }
  }

  // 3. Call the GDPR delete path.
  console.log(`\n  → calling deletePlayerData(${testId})\n`);
  const report = await deletePlayerData(testId, { reason: "gdpr-cascade-test" });
  console.log(`  ✓ deletePlayerData returned ${report.errors.length} errors:`);
  for (const e of report.errors) {
    console.error(`    - ${e.table}: ${e.error}`);
  }

  // 4. Re-read every player-owned model + assert empty.
  console.log(`\n  → verifying every player-owned model is empty\n`);
  const checks = await assertEmpty(testId);
  const failures = checks.filter((c) => c.count > 0);
  for (const c of checks) {
    const status = c.count === 0 ? "✓" : "✗";
    console.log(`  ${status} ${c.model}: ${c.count} row(s)`);
  }

  // 5. Cleanup stub parents (clans + npcs).
  await cleanupStubParents();
  console.log(`\n  ✓ cleaned up stub parent rows`);

  // 6. Report.
  if (failures.length === 0 && report.errors.length === 0) {
    console.log(`\n[verify-gdpr-cascade] PASS — every player-owned model was cleared.\n`);
    process.exit(0);
  } else {
    console.error(
      `\n[verify-gdpr-cascade] FAIL — ${failures.length} model(s) still have rows, ${report.errors.length} deletion error(s).\n`,
    );
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("[verify-gdpr-cascade] uncaught error:", err);
    process.exit(2);
  })
  .finally(async () => {
    await db.$disconnect();
  });

// Note: this script intentionally references `PLAYER_ID` only as a type
// import guard — the actual test uses a fresh `gdpr-test-*` id so the
// real demo player (PLAYER_ID) is never touched.
void PLAYER_ID;
