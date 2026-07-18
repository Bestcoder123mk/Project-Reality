import { NextResponse, type NextRequest } from "next/server";
import { withAdminAudit } from "@/lib/security/audit-log";
import { verifyReceiptSchema } from "@/lib/security/validation";
import { verifyReceiptServerSide } from "@/lib/security/hmac-receipt";
import { getClientIp } from "@/lib/security/csrf-helpers";
import { readBoundedJson } from "@/lib/security/body-size";

/**
 * POST /api/admin/verify-receipt — Task-1 (SEC) item 9. Section H (929).
 *
 * Accepts a CurrencyReceipt payload (id, playerId, reason, itemSlug,
 * amount, balanceBefore, balanceAfter, nonce, ts, signature) +
 * recomputes the HMAC server-side. Returns `{ valid: true }` when the
 * recomputed signature matches the supplied one, `{ valid: false }`
 * otherwise.
 *
 * Section H (929) — the route now uses `verifyReceiptServerSide` which
 * writes an AuditLog row for every verification attempt (success +
 * failure) so the support team has a forensic trail of who verified
 * what + when. The previous version only logged the request itself
 * (via `withAdminAudit`); the new audit row records the receipt's
 * playerId + nonce + the verification outcome.
 *
 * Section H-5000 (3781 / 3665) — server-authoritative verify-receipt:
 * verification runs entirely server-side (the RECEIPT_SECRET never
 * leaves the server); the per-admin actor is propagated into the
 * receipt-verification audit row so the support team's forensic trail
 * attributes the verify to the named operator.
 *
 * The route is admin-only (gated by `withAdminAudit` → `requireAdmin`).
 * Players never verify their own receipts — they forward them to
 * support via /api/support/ticket.
 */
export async function POST(req: NextRequest) {
  const { json, error } = await readBoundedJson(req, { maxBytes: 4096 });
  if (error) return error;

  const parsed = verifyReceiptSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { valid: false, error: "Invalid receipt payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const d = parsed.data;
  return withAdminAudit(
    req,
    async (auth) => {
      const result = await verifyReceiptServerSide(
        {
          playerId: d.playerId,
          reason: d.reason,
          itemSlug: d.itemSlug,
          amount: d.amount,
          balanceBefore: d.balanceBefore,
          balanceAfter: d.balanceAfter,
          nonce: d.nonce,
          ts: d.ts,
          signature: d.signature,
        },
        {
          // Section H-5000 (3665 / 3781) — pass the per-admin actor
          // (named operator or "shared-secret" back-compat) into the
          // receipt-verification audit row so the support team's
          // forensic trail attributes the verify to the named admin.
          actor: auth.actor,
          ip: getClientIp(req),
          route: "/api/admin/verify-receipt",
        },
      );
      if (!result.valid) {
        return NextResponse.json(
          { valid: false, error: result.reason ?? "signature_mismatch" },
          { status: 400 },
        );
      }
      return NextResponse.json({ valid: true });
    },
    // Override the payload so the audit log shows a sanitized form
    // (signature + nonce are redacted by `redactPayload`).
    { payloadOverride: { ...d, signature: "<redacted>", nonce: "<redacted>" } },
  );
}
