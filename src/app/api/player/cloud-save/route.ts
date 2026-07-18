import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { errorResponse, PLAYER_ID } from "@/lib/api";
import { db } from "@/lib/db";
import { cloudSaveSchema, playerIdSchema } from "@/lib/security/validation";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import type { CloudSavePayload } from "@/lib/game/platform/platform-integration";
const logger = createLogger("/api/player/cloud-save");

/**
 * L1-5000 / prompt 4502 — cross-device cloud save endpoint.
 *
 * GET  /api/player/cloud-save?playerId=<id> — fetch the latest cloud save.
 * POST /api/player/cloud-save                — persist a new cloud save.
 *
 * The legacy WebPlatformAdapter only wrote to localStorage, which meant a
 * player's save was tied to one browser. This route is the server-side
 * canonical store — every browser the player logs in on pulls the latest
 * save via GET, and every save pushes via POST. localStorage becomes a
 * read-through cache.
 *
 * Storage strategy: the cloud save is persisted as a PlayerEvent row
 * (name="cloud_save", props=<json-encoded CloudSavePayload>). The latest
 * row by `at` is the canonical save; older rows are kept for a 30-day
 * audit trail (the GDPR delete path anonymizes them with the rest of the
 * player's events). This avoids a new Prisma model + migration.
 *
 * L1-5000 / prompt 4503 — when the POST body includes an
 * `externalAccountId` + `externalPlatform`, the route also upserts the
 * Player row to record the link (so cross-progression can resolve the
 * save by SteamID / PSN onlineId / etc. on first console login).
 *
 * Security: same-origin CSRF check, 256KB body cap (saves can be large
 * but not unbounded), Zod validation via the shared `cloudSaveSchema`.
 */

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const playerIdRaw = url.searchParams.get("playerId") ?? PLAYER_ID;
    const playerIdParse = playerIdSchema.safeParse(playerIdRaw);
    if (!playerIdParse.success) {
      return errorResponse("Invalid playerId.", 400, {
        issues: playerIdParse.error.issues,
      });
    }
    const playerId = playerIdParse.data;
    // Latest cloud_save event = canonical save.
    const row = await db.playerEvent.findFirst({
      where: { playerId, name: "cloud_save" },
      orderBy: { at: "desc" },
      select: { props: true, at: true },
    });
    if (!row) {
      return NextResponse.json(null);
    }
    try {
      const payload = JSON.parse(row.props) as CloudSavePayload;
      if (payload.version !== 1) {
        return NextResponse.json(null);
      }
      return NextResponse.json(payload);
    } catch {
      return NextResponse.json(null);
    }
  } catch (err) {
    logger.errorOf(err, "get failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "cloud-save get failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    // 1. CSRF check.
    const csrf = requireSameOrigin(req);
    if (!csrf.ok) return csrf.response;

    // 2. Body-size limit (256KB — saves can be ~50KB encoded, leave headroom).
    const { json, error: bodyError } = await readBoundedJson(req, {
      maxBytes: 256 * 1024,
    });
    if (bodyError) return bodyError;

    // 3. Zod validation.
    const parsed = cloudSaveSchema.safeParse(json);
    if (!parsed.success) {
      return errorResponse(
        "Invalid body. Expected CloudSavePayload { version: 1, playerId, profile, at, externalAccountId?, externalPlatform? }.",
        400,
        { issues: parsed.error.issues },
      );
    }
    const payload = parsed.data as unknown as CloudSavePayload;

    // 4. Persist as a PlayerEvent (latest row by `at` is canonical).
    await db.playerEvent.create({
      data: {
        playerId: payload.playerId,
        sessionId: "cloud_save",
        name: "cloud_save",
        props: JSON.stringify(payload),
      },
    });

    // 5. L1-5000 / prompt 4503 — record the external account link on the
    //    Player row when present. Idempotent (skipped when the player
    //    already has the same link).
    if (payload.externalAccountId && payload.externalPlatform && payload.externalPlatform !== "web") {
      try {
        const existing = await db.player.findUnique({
          where: { id: payload.playerId },
          select: {
            externalAccountId: true,
            externalPlatform: true,
          },
        });
        if (
          existing &&
          (existing.externalAccountId !== payload.externalAccountId ||
            existing.externalPlatform !== payload.externalPlatform)
        ) {
          await db.player.update({
            where: { id: payload.playerId },
            data: {
              externalAccountId: payload.externalAccountId,
              externalPlatform: payload.externalPlatform,
            },
          });
        } else if (!existing) {
          // Player row doesn't exist — skip the link (the cloud save
          // is still persisted as a PlayerEvent above, so it's not lost).
          logger.warn(
            `cloud-save POST: player ${payload.playerId} not found — external link skipped`,
          );
        }
      } catch (err) {
        // The external-account link is best-effort — a failure here
        // shouldn't fail the cloud save. Log + continue.
        logger.errorOf(err, "external-account link failed (non-fatal)");
      }
    }

    return NextResponse.json({ ok: true, at: payload.at });
  } catch (err) {
    logger.errorOf(err, "post failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "cloud-save post failed" },
      { status: 500 },
    );
  }
}
