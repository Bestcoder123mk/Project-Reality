import { NextResponse, type NextRequest } from "next/server";
import { db, errorResponse, PLAYER_ID } from "@/lib/api";
import { requireSameOrigin } from "@/lib/security/csrf";
import { rateLimit, playerRateKey } from "@/lib/security/rate-limit";
import { createLogger } from "@/lib/logger";

const logger = createLogger("/api/matchmaking/replay");

/**
 * Section H (943) — replay download endpoint.
 *
 * GET /api/matchmaking/replay/:id
 *   → 200 { replay: { id, matchId, mode, result, finalScore, ... , replayData } }
 *   → 404 when the replay doesn't exist or doesn't belong to the caller.
 *
 * POST /api/matchmaking/replay
 *   → 201 { id }  — records a new replay (called by the engine at match end).
 *
 * Task-1 (SEC) — same-origin CSRF check on POST, rate-limited per
 * player (12 downloads / minute — replays are large, prevent scraping).
 */

const REPLAY_RATE_LIMIT = { max: 12, windowMs: 60_000, label: "replay" };

/** GET /api/matchmaking/replay/:id — download a replay. */
export async function GET(req: NextRequest) {
  try {
    // The replay id is the last path segment.
    const url = new URL(req.url);
    const id = url.pathname.split("/").pop();
    if (!id) return errorResponse("Missing replay id", 400);

    const rl = rateLimit(playerRateKey(PLAYER_ID, "replay-download"), REPLAY_RATE_LIMIT);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many replay downloads", retryAfterMs: rl.retryAfterMs },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        },
      );
    }

    const replay = await db.replay.findUnique({
      where: { id },
    });
    if (!replay || replay.playerId !== PLAYER_ID) {
      // Don't reveal whether the replay exists for another player
      // (would let an attacker enumerate replay ids).
      return errorResponse("Replay not found", 404);
    }

    return NextResponse.json({
      replay: {
        id: replay.id,
        matchId: replay.matchId,
        seed: replay.seed,
        mode: replay.mode,
        loadoutSlug: replay.loadoutSlug,
        result: replay.result,
        finalScore: replay.finalScore,
        finalKills: replay.finalKills,
        durationMs: replay.durationMs,
        frameCount: replay.frameCount,
        createdAt: replay.createdAt.toISOString(),
        // The replayData is a JSON-encoded snapshot ring + events.
        // For very large replays the caller may want a streamed
        // response; for the single-player demo we return it inline.
        replayData: replay.replayData,
      },
    });
  } catch (err) {
    logger.errorOf(err, "replay download failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Replay download failed" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/matchmaking/replay — record a new replay.
 *
 * Body: { matchId, seed, mode, loadoutSlug, result, finalScore, finalKills,
 *         durationMs, frameCount, replayData }
 *
 * Called by the engine at match end. The replay is persisted to the
 * Replay table; the player can later download it via GET.
 */
export async function POST(req: NextRequest) {
  try {
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;

    const rl = rateLimit(playerRateKey(PLAYER_ID, "replay-record"), REPLAY_RATE_LIMIT);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many replay records", retryAfterMs: rl.retryAfterMs },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        },
      );
    }

    // Cap the replay body at 2 MB (a typical 5-min match is ~500 KB).
    const { readBoundedJson } = await import("@/lib/security/body-size");
    const { json, error: bodyError } = await readBoundedJson(req, { maxBytes: 2_000_000 });
    if (bodyError) return bodyError;

    // Minimal shape validation (the schema is intentionally permissive —
    // the engine writes a known shape; we just guard against obvious
    // abuse).
    const body = json as {
      matchId?: string;
      seed?: number;
      mode?: string;
      loadoutSlug?: string;
      result?: string;
      finalScore?: number;
      finalKills?: number;
      durationMs?: number;
      frameCount?: number;
      replayData?: string;
    };
    if (
      typeof body.matchId !== "string" ||
      typeof body.replayData !== "string" ||
      body.replayData.length === 0
    ) {
      return errorResponse("Missing required fields (matchId, replayData)", 400);
    }

    const replay = await db.replay.create({
      data: {
        playerId: PLAYER_ID,
        matchId: body.matchId,
        seed: body.seed ?? 0,
        mode: body.mode ?? "SURVIVAL",
        loadoutSlug: body.loadoutSlug ?? "default",
        result: body.result ?? "DEFEAT",
        finalScore: body.finalScore ?? 0,
        finalKills: body.finalKills ?? 0,
        durationMs: body.durationMs ?? 0,
        frameCount: body.frameCount ?? 0,
        replayData: body.replayData,
      },
    });

    return NextResponse.json({ id: replay.id }, { status: 201 });
  } catch (err) {
    logger.errorOf(err, "replay record failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Replay record failed" },
      { status: 500 },
    );
  }
}
