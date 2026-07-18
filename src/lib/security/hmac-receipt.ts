/**
 * Task-1 (SEC) item 9 — HMAC receipt signing + verification helpers.
 *
 * Section H (929) — security-theater fix.
 *
 * The previous module shipped a `verifyReceiptClient` helper that
 * POSTed the receipt to `/api/admin/verify-receipt` with the admin
 * bearer token. This was incoherent:
 *
 *   1. The player client never has the admin token (it's a server-only
 *      secret). The function was unreachable from any legitimate
 *      player flow.
 *   2. The "verify the receipt on the client" goal is impossible: the
 *      receipt HMAC uses `RECEIPT_SECRET` (server-only). A client that
 *      could verify would also be able to forge — defeating the point.
 *   3. The admin route's verify path is real (server-side, server-only
 *      key) — that's where verification belongs.
 *
 * The redesign:
 *
 *   - `verifyReceipt` (re-exported from currency-guard) — server-side,
 *     constant-time. Used by the admin verify-receipt route. KEPT.
 *   - `verifyReceiptServerSide(params, opts)` — wraps `verifyReceipt`
 *     + writes an audit-log row on every verification (success + fail)
 *     so the support team has a forensic trail. NEW.
 *   - `verifyReceiptClient` — REMOVED. The function is deleted; the
 *      client has no role in receipt verification. If the player wants
 *      to verify a receipt they forward it to support (who use the
 *      admin route).
 *
 * Hit-claim HMAC (item 21) — kept unchanged. The client obtains the
 * signature from the server's session-bootstrap response (the
 * HIT_CLAIM_SECRET is server-only; the client can't forge a signature
 * for a hit it didn't make). The validator (`hit-validation.ts`)
 * verifies the signature server-side.
 *
 * The HMAC key is `RECEIPT_SECRET` (env). Hit claims use a separate
 * key (`HIT_CLAIM_SECRET`) so a compromise of one doesn't compromise
 * the other.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  receiptMessage,
  verifyReceipt,
  getReceiptSecret as cgGetReceiptSecret,
} from "@/lib/game/meta/currency-guard";

export { receiptMessage, verifyReceipt };

/** Receipt-signing secret (server-side only). Delegates to currency-guard. */
export function getReceiptSecret(): string {
  return cgGetReceiptSecret();
}

// ── Hit-claim HMAC (item 21) ──────────────────────────────────────────────

/** Hit-claim-signing secret. Falls back to the receipt secret in dev. */
export function getHitClaimSecret(): string {
  const env = process.env.HIT_CLAIM_SECRET;
  if (env) return env;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "HIT_CLAIM_SECRET must be set in production (use the platform secret manager).",
    );
  }
  if (!hitSecretWarned) {
    hitSecretWarned = true;
    console.warn(
      "[hmac-receipt] HIT_CLAIM_SECRET not set — falling back to receipt secret. Set HIT_CLAIM_SECRET in production.",
    );
  }
  return getReceiptSecret();
}
let hitSecretWarned = false;

/** Canonical message signed by a hit claim. */
export function hitClaimMessage(params: {
  shooterId: string;
  targetId: string;
  weaponSlug: string;
  hitLocation: string;
  distance: number;
  shotAtMs: number;
}): string {
  return [
    params.shooterId,
    params.targetId,
    params.weaponSlug,
    params.hitLocation,
    params.distance,
    params.shotAtMs,
  ].join("|");
}

/** Sign a hit claim. Server-side only. */
export function signHitClaim(params: {
  shooterId: string;
  targetId: string;
  weaponSlug: string;
  hitLocation: string;
  distance: number;
  shotAtMs: number;
}): string {
  const msg = hitClaimMessage(params);
  return createHmac("sha256", getHitClaimSecret()).update(msg).digest("hex");
}

/** Verify a hit-claim signature. Constant-time compare. */
export function verifyHitClaim(params: {
  shooterId: string;
  targetId: string;
  weaponSlug: string;
  hitLocation: string;
  distance: number;
  shotAtMs: number;
  signature: string;
}): boolean {
  const expected = signHitClaim(params);
  if (expected.length !== params.signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(params.signature));
  } catch {
    return false;
  }
}

// ── 929 — server-side receipt verification (with audit log) ───────────────

export interface ReceiptPayload {
  playerId: string;
  reason: string;
  itemSlug: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  nonce: string;
  ts: string;
  signature: string;
}

/**
 * Section H (929) — server-side receipt verification with audit trail.
 *
 * Used by `/api/admin/verify-receipt` (the only legitimate consumer of
 * receipt verification). Recomputes the HMAC + compares constant-time;
 * writes an audit-log row recording the verification attempt (success
 * or failure) so a support agent reviewing a dispute leaves a trail.
 *
 *   const result = await verifyReceiptServerSide(receipt, {
 *     actor: "support-agent-42",
 *     ip: getClientIp(req),
 *   });
 *   if (!result.valid) return errorResponse("Receipt failed verification", 400);
 *
 * The function is fire-and-forget on the audit log (a failed audit
 * write doesn't fail the verification — same tradeoff as
 * `withAdminAudit`).
 */
export async function verifyReceiptServerSide(
  receipt: ReceiptPayload,
  opts: { actor: string; ip: string; route?: string },
): Promise<{ valid: boolean; reason?: string }> {
  // Parse the timestamp — the receipt carries an ISO string.
  let ts: Date;
  try {
    ts = new Date(receipt.ts);
    if (Number.isNaN(ts.getTime())) {
      return { valid: false, reason: "invalid_ts" };
    }
  } catch {
    return { valid: false, reason: "invalid_ts" };
  }
  const valid = verifyReceipt({
    playerId: receipt.playerId,
    reason: receipt.reason,
    itemSlug: receipt.itemSlug,
    amount: receipt.amount,
    balanceBefore: receipt.balanceBefore,
    balanceAfter: receipt.balanceAfter,
    nonce: receipt.nonce,
    ts,
    signature: receipt.signature,
  });
  // Write the audit row (fire-and-forget). Lazy import to avoid a cycle
  // when audit-log.ts pulls in db at module load.
  try {
    const { writeAudit } = await import("./audit-log");
    await writeAudit({
      actor: opts.actor,
      route: opts.route ?? "/api/admin/verify-receipt",
      method: "POST",
      ip: opts.ip,
      status: valid ? 200 : 400,
      payloadJson: JSON.stringify({
        playerId: receipt.playerId,
        reason: receipt.reason,
        nonce: receipt.nonce,
        valid,
      }),
    });
  } catch {
    // Audit-log failure is non-fatal.
  }
  return { valid, reason: valid ? undefined : "signature_mismatch" };
}

// ── 929 — explicit "no client verification" documentation ─────────────────
//
// The previous `verifyReceiptClient` function is intentionally REMOVED.
// A player-side receipt verification would require the player to know
// the RECEIPT_SECRET — which would let them forge receipts. The right
// architecture is:
//
//   - Server signs + persists the receipt at issue time.
//   - Player can READ their own receipts (GET /api/player/receipts).
//   - Player can FORWARD a receipt to support (POST /api/support/ticket
//     with the receipt id); support verifies via the admin route.
//
// There is no legitimate client-side verification path. If a future
// flow needs the client to detect a tampered receipt, the solution is a
// server-side verify-on-read (the GET /api/player/receipts endpoint
// re-verifies every receipt before returning it + flags bad ones), not
// a client-side verify function.
