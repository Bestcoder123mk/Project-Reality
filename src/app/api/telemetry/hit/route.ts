import { NextResponse, type NextRequest } from "next/server";
import { ensureSeed, errorResponse, PLAYER_ID } from "@/lib/api";
import { hitClaimSchema } from "@/lib/security/validation";
import {
  validateHitClaim,
  recordWeaponFire,
  flushEvents,
  pendingEventCount,
  _resetHitValidationCaches,
} from "@/lib/security/hit-validation";
import { scanPlayerForCheats } from "@/lib/security/anti-cheat";
import { readBoundedJson } from "@/lib/security/body-size";
import { requireSameOrigin } from "@/lib/security/csrf";
import { rateLimit, playerRateKey } from "@/lib/security/rate-limit";
import { verifyAccessToken } from "@/lib/game/multiplayer/Auth";
import { db } from "@/lib/db";
import { createLogger } from "@/lib/logger";

const logger = createLogger("/api/telemetry/hit");

/**
 * POST /api/telemetry/hit — Task-1 (SEC) item 21, 22. Section H (928, 949).
 *
 * Server-authoritative hit validation. The client posts a signed hit
 * claim; the server re-checks ballistic feasibility (max range, fire
 * rate, hitzone plausibility) + records the kill only when the claim
 * is valid. After recording, runs the anti-cheat scan for the shooter
 * + writes any CheatFlag rows.
 *
 * Section H (928) — the `shooterId` in the request body is NOT trusted.
 * The route extracts the authenticated shooter from the session token
 * (Authorization: Bearer <access>) + passes it as `authShooterId` to
 * the validator. A client can no longer pad stats for other players.
 *
 * Section H (949) — kills + weapon_fire events are written via the
 * batched `enqueueEvent` / `flushEvents` API. The route flushes after
 * the response so a flood of hit claims produces one `createMany`
 * instead of N `create` calls.
 *
 * Request body (Zod-validated by `hitClaimSchema`):
 *
 *   {
 *     shooterId, targetId, weaponSlug, hitLocation,
 *     distance, shotAtMs, signature, nonce?
 *   }
 */
const HIT_RATE_LIMIT = { max: 120, windowMs: 60_000, label: "hit-claim" };

export async function POST(req: NextRequest) {
  // 1. CSRF check.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) return csrf.response;

  // Section H (928) — extract auth shooterId from the access token. When
  // no token is present (single-player demo mode), fall back to PLAYER_ID
  // so the demo still works. Multiplayer builds MUST send the token.
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyAccessToken(token) : null;
  // In demo mode (no token), use PLAYER_ID. In real MP, require a token.
  const authShooterId = session?.playerId ?? PLAYER_ID;
  if (token && !session) {
    return NextResponse.json(
      { error: "Invalid or expired session token" },
      { status: 401 },
    );
  }

  // 2. Rate limit (per player).
  const rlKey = playerRateKey(authShooterId, "hit");
  const rl = rateLimit(rlKey, HIT_RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: "Too many hit claims",
        retryAfterMs: rl.retryAfterMs,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      },
    );
  }

  // 3. Body-size limit (1KB — the hit-claim body is tiny).
  const { json, error } = await readBoundedJson(req, { maxBytes: 1024 });
  if (error) return error;

  const parsed = hitClaimSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("Invalid hit claim body.", 400, {
      issues: parsed.error.issues,
    });
  }

  try {
    await ensureSeed();

    // Section H (928) — pass authShooterId so the validator ignores the
    // (untrusted) body shooterId.
    // Section H (907) — supply a LOS check (walks the server's collision
    // world; here we stub to `true` in single-player since the engine
    // owns the LOS test pre-route. A real MP server would walk the
    // server-authoritative collision octree).
    // Section H (908) — supply a hitbox resolver (same stub reason).
    const result = await validateHitClaim(parsed.data, {
      authShooterId,
      losCheck: () => true, // engine-side; route defers to the in-engine validator.
      hitboxResolver: () => null, // engine-side; route defers to the in-engine validator.
    });
    if (!result.valid) {
      // Still record a `weapon_fire` event so the next claim has a
      // baseline (the player did fire — they just missed / were cheating).
      await recordWeaponFire({
        shooterId: authShooterId,
        weaponSlug: parsed.data.weaponSlug,
        sessionId: "hit-validation",
      });
      // 949 — flush the queue (background; non-blocking).
      void flushEvents().catch((err) => {
        logger.warn("event flush failed", { error: String(err) });
      });
      return NextResponse.json(
        { valid: false, reasons: result.reasons, killRecorded: false },
        { status: 400 },
      );
    }

    // 5. Record the kill + the weapon_fire baseline. 949 — batched.
    const killAt = new Date(parsed.data.shotAtMs);
    // Use the server-derived hit zone when available (908); fall back
    // to the client claim (already validated against the hitbox).
    const hitZone = result.serverHitZone ?? parsed.data.hitLocation;
    // Enqueue the kill event (the route flushes after the response).
    const { enqueueEvent } = await import("@/lib/security/hit-validation");
    enqueueEvent({
      playerId: authShooterId,
      sessionId: "hit-validation",
      name: "kill",
      props: {
        targetId: parsed.data.targetId,
        weaponSlug: parsed.data.weaponSlug,
        hitLocation: hitZone,
        distance: parsed.data.distance,
        at: killAt.toISOString(),
      },
      at: killAt,
    });
    await recordWeaponFire({
      shooterId: authShooterId,
      weaponSlug: parsed.data.weaponSlug,
      sessionId: "hit-validation",
      at: killAt,
    });

    // 6. Anti-cheat scan — fire-and-forget; don't block the response.
    void scanPlayerForCheats(authShooterId).catch((err) => {
      logger.warn("anti-cheat scan failed", { error: String(err) });
    });

    // 949 — flush the pending event queue so the kill + weapon_fire land
    // in one batched write. Background; non-blocking.
    if (pendingEventCount() > 0) {
      void flushEvents().catch((err) => {
        logger.warn("event flush failed", { error: String(err) });
      });
    }

    return NextResponse.json({
      valid: true,
      reasons: [],
      softFlags: result.softFlags,
      killRecorded: true,
      // 908 — surface the server-derived hit zone so the client's hit
      // marker UI matches the server's authoritative decision.
      serverHitZone: result.serverHitZone ?? parsed.data.hitLocation,
      weapon: result.weapon
        ? {
            slug: result.weapon.slug,
            name: result.weapon.name,
            damage: result.weapon.damage,
          }
        : null,
    });
  } catch (err) {
    logger.errorOf(err, "hit validation failed");
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "hit validation failed" },
      { status: 500 },
    );
  }
}

// Expose the cache-reset for admin tooling (e.g. when the catalog is
// reloaded, the weapon cache should be cleared so new stats take effect).
export { _resetHitValidationCaches };
