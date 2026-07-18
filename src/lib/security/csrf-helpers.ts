/**
 * Task-1 (SEC) — IP extraction helper.
 *
 * Extracts the client IP from a request, preferring the `X-Forwarded-For`
 * header (set by the proxy / load balancer) over the direct socket IP.
 * Returns the first non-empty value in the chain. Falls back to
 * "unknown" when no IP can be determined (e.g. a unit test with no
 * headers).
 *
 * Used by:
 *   - `audit-log.ts` (records the IP of every admin call).
 *   - `rate-limit.ts` consumer routes (support ticket / bug report).
 *   - `/api/player/data-export` (logs the IP for abuse triage).
 *
 * Trust model: we trust `X-Forwarded-For` ONLY when the request came
 * through the platform's proxy. The platform proxy (Caddyfile in the
 * repo) sets `X-Forwarded-For` to the real client IP + strips any
 * client-supplied value. Direct requests to the Next.js port (dev
 * mode) don't have the header, so we fall back to the connection IP.
 */

import type { NextRequest } from "next/server";

export function getClientIp(req: NextRequest | Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // XFF is a comma-separated list: "client, proxy1, proxy2". The first
    // entry is the originating client (the platform proxy appends, never
    // prepends — so the leftmost is the real client under our setup).
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.slice(0, 64);
  return "unknown";
}
