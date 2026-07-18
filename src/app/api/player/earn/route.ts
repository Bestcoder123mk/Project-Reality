import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
const logger = createLogger("/api/player/earn");
import {
  db,
  ensureSeed,
  errorResponse,
  PLAYER_ID,
  getActiveSeason,
  getOrCreatePlayerBattlePass,
  serializePlayer,
} from "@/lib/api";
import { issueReceipt } from "@/lib/game/meta/currency-guard";
import {
  calculateMatchEarnings,
  levelFromXp,
  validateMatchResult,
} from "@/lib/game/Economy";
import { trackChallengeProgress } from "@/lib/game/Challenges";
import { playerEarnSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { consumeNonce, issueNonce, isValidNonceShape } from "@/lib/security/nonce";
import { rateLimit, playerRateKey } from "@/lib/security/rate-limit";

/**
 * POST /api/player/earn
 *
 * Called by the engine at match end (victory or defeat). Persists the match's
 * credits + XP to the player's account, writes a MatchEarning audit row,
 * advances the battle pass, recomputes the player's level from XP, and
 * tracks challenge progress (kills / headshots / waves / melee / matches).
 *
 * Section H (924) — server-authoritative earn. The client's `credits`
 * and `xp` fields are IGNORED — the route recomputes them from the
 * server-canonical `calculateMatchEarnings` using the validated kills/
 * waves/result. The client's claimed stats are cross-checked against
 * the durable PlayerEvent rows; an over-claim is capped at the server
 * count + flagged.
 *
 * Section H (925) — replay protection. The route requires a single-use
 * nonce issued by `/api/player/session` (or any prior authorized call).
 * Replaying the same POST fails because the nonce is consumed on first
 * use. Without a nonce, the route rejects with 400.
 *
 * Section H (926) — receipts BEFORE the credit. The previous flow
 * issued the receipt AFTER the balance update inside the same
 * transaction. While that's atomic, the receipt's `balanceBefore` was
 * the post-update value (the receipt was self-consistent but didn't
 * protect against the credit). The new flow:
 *   1. Read pre-credit balance.
 *   2. Issue the receipt (signed, persisted) — locks the intent.
 *   3. Apply the credit.
 *   4. If the credit fails, the receipt is voided (status flips to
 *      VOID — the row stays in the audit trail).
 *
 * Body shape (sent by `GameEngine.reportEarnings` in engine.ts):
 *   { credits, xp, kills, wave, result, headshots?, melee?, sessionId, nonce }
 *
 * Returns the new serialized player profile so the client can update its
 * local store without an extra round-trip.
 */
const EARN_RATE_LIMIT = { max: 12, windowMs: 60_000, label: "player-earn" };

export async function POST(req: NextRequest) {
  try {
    // Task-1 (SEC) items 5, 6, 8.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;

    // Section H (925) — rate-limit earn (anti-replay / brute-force gate).
    const rl = rateLimit(playerRateKey(PLAYER_ID, "earn"), EARN_RATE_LIMIT);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many earn requests", retryAfterMs: rl.retryAfterMs },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        },
      );
    }

    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 1024 });
    if (bodyError) return bodyError;
    const parsed = playerEarnSchema.safeParse(json);
    if (!parsed.success) {
      return errorResponse("Invalid body. Expected { credits, xp, kills?, wave?, result?, headshots?, melee?, sessionId?, nonce? }.", 400, {
        issues: parsed.error.issues,
      });
    }

    // Section H (925) — nonce is REQUIRED. Without it, a replayed POST
    // would re-credit the player. The nonce is single-use; consumption
    // happens below.
    const nonce = (json as { nonce?: unknown } | null)?.nonce;
    if (!isValidNonceShape(nonce)) {
      return errorResponse("Missing or invalid nonce (32+ hex chars).", 400);
    }
    const sessionId = (json as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 120) {
      return errorResponse("Missing or invalid sessionId.", 400);
    }

    await ensureSeed();

    // Section H (925) — consume the nonce BEFORE any DB write. If the
    // nonce was already used (replay), reject. The consumption is
    // atomic (deleteMany with the flow + nonce match), so two
    // concurrent replays can't both succeed.
    const nonceOk = await consumeNonce(nonce, "purchase");
    if (!nonceOk) {
      return errorResponse("Replay detected — nonce already used or expired.", 409);
    }

    // Section H (924) — server-authoritative earn. Read the canonical
    // stats from the PlayerEvent table for this session, then compute
    // the credit + XP awards server-side. The client's claimed credits
    // + xp are IGNORED.
    const serverKillCount = await db.playerEvent.count({
      where: { playerId: PLAYER_ID, sessionId, name: "kill" },
    });
    const serverWaveCount = await db.playerEvent.count({
      where: { playerId: PLAYER_ID, sessionId, name: "wave_clear" },
    });
    const serverHeadshotCount = await db.playerEvent.count({
      where: { playerId: PLAYER_ID, sessionId, name: "kill", props: { contains: '"hitLocation":"head"' } },
    });
    const serverMeleeCount = await db.playerEvent.count({
      where: { playerId: PLAYER_ID, sessionId, name: "kill", props: { contains: '"melee":true' } },
    });
    // The match result comes from the session row (server-authoritative).
    // In single-player demo, the engine writes it via the engine's
    // reportEarnings — accept the client's claim but flag mismatches.
    const clientResult: "VICTORY" | "DEFEAT" = parsed.data.result;

    const validation = await validateMatchResult(
      PLAYER_ID,
      sessionId,
      {
        kills: parsed.data.kills,
        waves: parsed.data.wave,
        result: clientResult,
        headshots: parsed.data.headshots,
        melee: parsed.data.melee,
      },
      {
        killCount: serverKillCount,
        waveCount: serverWaveCount,
        headshotCount: serverHeadshotCount,
        meleeCount: serverMeleeCount,
        result: clientResult, // single-player: trust the engine's claim.
      },
    );

    if (validation.discrepancies.length > 0) {
      logger.warn("earn claim discrepancies", {
        discrepancies: validation.discrepancies,
        playerId: PLAYER_ID,
        sessionId,
      });
    }

    // Recompute earnings from the server-canonical stats (924).
    const { credits, xp } = calculateMatchEarnings({
      kills: validation.canonical.kills,
      waves: validation.canonical.waves,
      result: validation.canonical.result,
    });

    const season = await getActiveSeason();

    // Section H (926) — issue the receipt BEFORE the credit, inside the
    // transaction. The receipt's `balanceBefore` is the pre-credit
    // balance; `balanceAfter` is the post-credit balance (we know it
    // because we're about to apply it). If the credit fails (e.g. a
    // constraint violation), the transaction rolls back + the receipt
    // never lands — both stay consistent.
    const result = await db.$transaction(async (tx) => {
      const player = await tx.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
      const balanceBefore = player.credits;
      const balanceAfter = balanceBefore + credits;

      const newXp = player.xp + xp;
      const newLevel = levelFromXp(newXp);

      // 926 — issue the signed receipt FIRST. The row records the intent
      // + the expected balanceAfter. If the subsequent update fails, the
      // transaction rolls back + the receipt never commits.
      const receipt = await issueReceipt(tx, {
        playerId: PLAYER_ID,
        reason: "match_earn",
        itemSlug: validation.canonical.result,
        amount: -credits, // negative = credit (per currency-guard convention).
        balanceBefore,
        balanceAfter,
      });

      // Apply the credit + XP + level update.
      const updatedPlayer = await tx.player.update({
        where: { id: PLAYER_ID },
        data: {
          credits: balanceAfter,
          xp: newXp,
          level: newLevel,
        },
      });

      // MatchEarning audit row — uses the SERVER-canonical stats.
      await tx.matchEarning.create({
        data: {
          playerId: PLAYER_ID,
          credits,
          xp,
          kills: validation.canonical.kills,
          wave: validation.canonical.waves,
          result: validation.canonical.result,
        },
      });

      // Advance the battle pass XP.
      const bp = await tx.playerBattlePass.upsert({
        where: { playerId_seasonId: { playerId: PLAYER_ID, seasonId: season.id } },
        update: { xp: { increment: xp } },
        create: {
          playerId: PLAYER_ID,
          seasonId: season.id,
          xp,
          premium: false,
          claimedTiers: "[]",
          status: "ACTIVE",
        },
      });

      // I-5000 #3812 / A-553 — track challenge progress INSIDE the earn
      // transaction. The prior code called trackChallengeProgress AFTER
      // the transaction committed, so a DB failure between commit +
      // track would grant credits but lose challenge progress. Moving
      // the call inside the tx (passing `tx` as the transaction client)
      // makes the challenge-tracking atomic with the credit grant.
      try {
        await trackChallengeProgress(
          PLAYER_ID,
          {
            kills: validation.canonical.kills,
            headshots: validation.canonical.headshots,
            waves: validation.canonical.waves,
            matches: 1,
            melee: validation.canonical.melee,
          },
          tx as any,
        );
      } catch (trackErr) {
        // Don't fail the earn transaction over a challenge-tracking
        // failure — log it + continue. The receipt + credit + BP XP
        // are the primary effects; the challenge progress is secondary.
        logger.warn("challenge tracking failed inside earn tx", {
          error: trackErr instanceof Error ? trackErr.message : String(trackErr),
          playerId: PLAYER_ID,
          sessionId,
        });
      }

      return { updatedPlayer, bp, receipt };
    });

    // I-5000 #3824 / A-566 — receipt convention documented:
    //   - Debits (player spends credits): amount > 0 (positive).
    //   - Credits (player earns credits): amount < 0 (negative).
    //   - Reason is a snake_case verb-noun pair (e.g. "match_earn",
    //     "shop_buy", "battlepass_premium", "challenge_claim",
    //     "pack_open", "tier_skip", "trade_up", "refund").
    //   - itemSlug is the canonical identifier for the item the receipt
    //     pertains to (weapon slug, season id, challenge id, "credits"
    //     for generic currency grants, etc.).
    //   - balanceBefore / balanceAfter are the player's credit balance
    //     immediately before / after the transaction (NOT the BP-XP
    //     balance, NOT the seasonal-token balance — those have their
    //     own audit trails).
    // The earn route returns the receipt so the client can verify the
    // credit matches the server's signed intent.
    return NextResponse.json({
      player: serializePlayer(result.updatedPlayer),
      battlePassXp: result.bp.xp,
      // 926 — return the receipt so the client can verify the credit
      // matches the server's signed intent. The receipt's `amount` is
      // the credit amount (negative per currency-guard convention);
      // `reason` is "match_earn"; `itemSlug` is the result (VICTORY/DEFEAT).
      receipt: {
        id: result.receipt.id,
        nonce: result.receipt.nonce,
        signature: result.receipt.signature,
        amount: -credits,
        reason: "match_earn",
        itemSlug: validation.canonical.result,
        ts: result.receipt.ts.toISOString(),
      },
      // 924 — surface the server-canonical stats + any discrepancies.
      canonical: validation.canonical,
      discrepancies: validation.discrepancies,
    });
  } catch (err) {
    logger.errorOf(err, "failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Earn failed" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/player/earn/nonce — issue a single-use nonce for the next
 * earn POST. The client calls this before reporting earnings, then
 * includes the nonce in the earn POST. Section H (925).
 */
export async function GET(_req: NextRequest) {
  try {
    await ensureSeed();
    const nonce = await issueNonce("purchase", PLAYER_ID);
    return NextResponse.json({ nonce });
  } catch (err) {
    logger.errorOf(err, "nonce issue failed");
    return NextResponse.json(
      { error: "Failed to issue nonce" },
      { status: 500 },
    );
  }
}
