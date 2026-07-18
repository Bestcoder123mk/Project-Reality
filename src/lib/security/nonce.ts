/**
 * Task-1 (SEC) item 17 — Replay-attack protection via single-use nonces.
 *
 * The purchase flow returns a signed `CurrencyReceipt` with a server-
 * generated random nonce. If an attacker captures the request and
 * replays it (e.g. to double-claim a refund or double-spend a one-time
 * offer), the server must reject the replay.
 *
 * Defense: every flow that issues a receipt (or any signed response
 * whose validity depends on "this hasn't been used yet") records the
 * nonce in the `UsedNonce` table. The next request that depends on the
 * nonce must call `consumeNonce(nonce, flow)` — which atomically
 * deletes the row. If the row didn't exist (already consumed or never
 * issued), the request is rejected as a replay.
 *
 * Two flavors:
 *
 *   - `issueNonce(flow)` — server-side: generates a fresh 16-byte hex
 *     nonce + records it in `UsedNonce` with a 24h TTL. Returns the
 *     nonce string. The caller embeds it in the signed response.
 *   - `consumeNonce(nonce, flow)` — server-side: deletes the row; if
 *     the row existed the delete count is 1 (success). Returns true on
 *     success, false on replay.
 *
 * The TTL is enforced lazily: `pruneExpiredNonces()` runs on every
 * `issueNonce` call (cheap upsert) and deletes rows past their
 * `expiresAt`. For higher-traffic deployments, move this to a cron.
 *
 * Edge case: SQLite doesn't support `ON CONFLICT DO NOTHING` on a
 * composite key the same way Postgres does, but `UsedNonce.nonce` is
 * the PK — a duplicate insert throws P2002, which we catch + return
 * false (replay).
 */

import { db } from "@/lib/db";
import { randomBytes } from "node:crypto";

/** How long a nonce is valid for (24h — long enough for any legitimate flow). */
export const NONCE_TTL_MS = 24 * 60 * 60 * 1000;

/** Allowed nonce flow labels. */
export type NonceFlow = "purchase" | "pack_open" | "hit_claim";

/**
 * Issue a fresh nonce for `flow`. Records the nonce in `UsedNonce` with
 * a 24h TTL. Returns the nonce string (32 hex chars).
 *
 *   const nonce = await issueNonce("pack_open", PLAYER_ID);
 *   // ... embed in signed response ...
 *
 * Section H (950) — the O(N) `pruneExpiredNonces` no longer runs on
 * every issue. Instead, we prune at most once per `PRUNE_INTERVAL_MS`
 * (default 60s). For high-traffic deployments, move the prune to a
 * cron entirely. The first issue after bootstrapping the process still
 * prunes (so a fresh process cleans up stale rows from a previous run).
 */
const PRUNE_INTERVAL_MS = 60_000;
let lastPruneAt = 0;

export async function issueNonce(
  flow: NonceFlow,
  playerId?: string,
): Promise<string> {
  // Section H (950) — periodic prune instead of per-issue.
  const now = Date.now();
  if (now - lastPruneAt > PRUNE_INTERVAL_MS) {
    lastPruneAt = now;
    // Fire-and-forget — don't block the issue on the prune.
    void pruneExpiredNonces().catch(() => {
      // Reset so the next issue tries again.
      lastPruneAt = 0;
    });
  }

  const nonce = randomBytes(16).toString("hex");
  const nowDate = new Date(now);
  const expiresAt = new Date(now + NONCE_TTL_MS);
  await db.usedNonce.create({
    data: { nonce, flow, playerId, createdAt: nowDate, expiresAt },
  });
  return nonce;
}

/**
 * Consume a previously-issued nonce. Returns `true` on success (the
 * nonce was valid + has been consumed), `false` on replay (the nonce
 * was already consumed or never issued).
 *
 *   const ok = await consumeNonce(nonce, "pack_open");
 *   if (!ok) return errorResponse("Replay detected — nonce already used", 409);
 */
export async function consumeNonce(
  nonce: string,
  flow: NonceFlow,
): Promise<boolean> {
  // Delete the row; if the row existed, the delete count is 1 (success).
  // If it didn't exist (already consumed or never issued), the count is 0.
  // This is atomic on SQLite under a single-writer transaction.
  const now = new Date();
  // Reject expired nonces explicitly so a stale nonce from a dead session
  // can't be replayed.
  const r = await db.usedNonce.deleteMany({
    where: { nonce, flow, expiresAt: { gt: now } },
  });
  return r.count === 1;
}

/** Delete all expired nonces. Called lazily by `issueNonce`. */
export async function pruneExpiredNonces(): Promise<number> {
  const now = new Date();
  const r = await db.usedNonce.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  return r.count;
}

/**
 * Validate the shape of a client-supplied nonce (16-byte hex string).
 * Used by routes that accept a nonce in the request body — the actual
 * consumption is a separate call to `consumeNonce`.
 */
export function isValidNonceShape(nonce: unknown): nonce is string {
  return (
    typeof nonce === "string" &&
    nonce.length >= 32 &&
    nonce.length <= 64 &&
    /^[a-f0-9]+$/i.test(nonce)
  );
}
