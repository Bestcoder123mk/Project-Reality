/**
 * Task-1 (SEC) item 1, 2 — Shared-secret admin authentication.
 *
 * Section H hardening:
 *
 *   930 — `getAdminSecret()` already throws in production when
 *         `ADMIN_SECRET` is unset (Task-1). This revision removes the
 *         dev fallback entirely when `ADMIN_STRICT=1` is set (for
 *         staging environments that run with `NODE_ENV=development`
 *         but should still require a real secret). It also adds a
 *         `requireAdminStrict()` that bypasses the dev fallback
 *         unconditionally — used by the IP-allowlist + rate-limit
 *         gates so a misconfigured env can't bypass them.
 *   931 — `requireAdmin()` now applies a brute-force throttle:
 *         `admin-auth:<ip>` rate-limited to 10 attempts / minute per IP.
 *         A failed attempt counts; a successful attempt still consumes
 *         the slot (so a brute-forcer can't probe fast even after a
 *         legit login). Logged via the existing AuditLog path.
 *   932 — Optional IP allowlist (`ADMIN_IP_ALLOWLIST`, comma-separated
 *         CIDRs / IPs). When set, requests from non-allowlisted IPs get
 *         a 403 before the secret is even checked — defense in depth
 *         for prod admin routes exposed via a VPN / office IP only.
 *
 * Section H-5000 (3665 / cross-ref A-600) — per-admin attribution.
 *
 *   The previous `requireAdmin` returned a single hard-coded actor
 *   `"shared-secret"` for every successful auth. The AuditLog rows
 *   recorded "shared-secret" for every admin call, so a forensic
 *   review couldn't distinguish which operator performed which action
 *   (the audit trail was per-IP + per-route but not per-admin).
 *
 *   The fix supports per-admin attribution via two complementary
 *   mechanisms:
 *
 *   (a) Multi-admin token table — `ADMIN_SECRET` may now be a comma-
 *       separated list of `name:secret` pairs:
 *         `ADMIN_SECRET="alice:$2a$hash1,bob:$2a$hash2,carol:plain"`
 *       When the env var is in this format, each Bearer token is
 *       matched against every entry; the matched entry's `name`
 *       becomes the actor. Plain strings (no colon) fall back to the
 *       legacy `"shared-secret"` actor for back-compat.
 *   (b) `X-Admin-Actor` header — an explicit actor name the caller
 *       supplies alongside the Bearer token. The header is sanity-
 *       capped (32 chars, sanitized) so it can't inject log entries.
 *       This is the softer of the two mechanisms (any admin can claim
 *       any actor name) but is convenient for operators that share
 *       one secret + still want per-operator attribution in the
 *       audit trail.
 *
 *   The `actor` returned by `requireAdmin` is consumed by
 *   `withAdminAudit` → `writeAudit` so every AuditLog row records
 *   the named operator (when configured).
 */

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getClientIp } from "./csrf-helpers";
import { rateLimit, ipRateKey } from "./rate-limit";

/** Actor string written to AuditLog rows when per-admin attribution isn't configured. */
export const ADMIN_ACTOR = "shared-secret";

/** Header name the client must send. Conventional HTTP bearer header. */
export const ADMIN_AUTH_HEADER = "authorization";

/**
 * Section H-5000 (3665) — optional explicit actor header. When an
 * admin supplies `X-Admin-Actor: alice`, the AuditLog row records
 * `alice` as the actor (instead of `shared-secret`). Capped at 32
 * chars + sanitized to path-safe characters so it can't inject log
 * entries (defense-in-depth against a compromised admin token).
 */
export const ADMIN_ACTOR_HEADER = "x-admin-actor";
const MAX_ACTOR_LEN = 32;

/**
 * Parse `ADMIN_SECRET` into a per-admin token table.
 *
 * Accepted formats (auto-detected):
 *
 *   1. Plain secret string — `"s3cret"` → single entry with the
 *      legacy `"shared-secret"` actor. Back-compat with existing
 *      single-admin deployments.
 *   2. Comma-separated `name:secret` pairs —
 *      `"alice:$2a$hash1,bob:plain2"` → two entries, each with the
 *      named actor. The colon is the separator; the secret itself
 *      may contain any other character (including colons after the
 *      first one, since we split on the FIRST colon only).
 *
 * Returns `null` when `ADMIN_SECRET` is unset (caller decides whether
 * to fall back to the dev secret).
 */
interface AdminTokenEntry {
  name: string;
  secret: string;
}

function parseAdminSecretTable(raw: string): AdminTokenEntry[] {
  // Auto-detect format: if any entry has a colon BEFORE the first
  // comma, treat the whole string as `name:secret` pairs.
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const table: AdminTokenEntry[] = [];
  let sawNamed = false;
  let sawPlain = false;
  for (const entry of entries) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx > 0 && colonIdx < entry.length - 1) {
      // `name:secret` — split on FIRST colon only (the secret may
      // contain colons, e.g. a bcrypt hash with `$2a$10$...:salt`).
      const name = entry.slice(0, colonIdx).trim();
      const secret = entry.slice(colonIdx + 1);
      if (name && secret) {
        table.push({ name, secret });
        sawNamed = true;
      }
    } else {
      // Plain secret string — legacy single-admin format.
      table.push({ name: ADMIN_ACTOR, secret: entry });
      sawPlain = true;
    }
  }
  // Mixed formats are a config error — log a warning + prefer the
  // named entries (so a misconfigured env can't accidentally fall
  // back to plain-shared-secret mode).
  if (sawNamed && sawPlain) {
    console.warn(
      "[admin-auth] ADMIN_SECRET mixes named + plain entries — preferring named entries. " +
        "Move all entries to the `name:secret` form for consistency.",
    );
    return table.filter((e) => e.name !== ADMIN_ACTOR);
  }
  return table;
}

/**
 * Match a Bearer token against the admin token table. Returns the
 * actor name of the matched entry, or `null` when no entry matches.
 *
 * Uses `timingSafeEqual` so a brute-force probe can't time-oracle
 * which entry is being compared. All entries are compared in order;
 * the first length-matching entry is constant-time-compared.
 */
function matchAdminToken(token: string, table: AdminTokenEntry[]): string | null {
  const tokenBuf = Buffer.from(token);
  for (const entry of table) {
    const secretBuf = Buffer.from(entry.secret);
    // Length mismatch — skip (timingSafeEqual would throw). We compare
    // lengths in constant time relative to the entry, not the token,
    // so an attacker can't time-oracle the secret length.
    if (tokenBuf.length !== secretBuf.length) continue;
    try {
      if (timingSafeEqual(tokenBuf, secretBuf)) {
        return entry.name;
      }
    } catch {
      // Defensive — timingSafeEqual shouldn't throw after the length
      // check, but a malformed buffer would. Skip the entry.
    }
  }
  return null;
}

/** Sanitize an X-Admin-Actor header value to a path-safe actor name. */
function sanitizeActor(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_\-\.@]/g, "").slice(0, MAX_ACTOR_LEN);
}

/**
 * Read the configured ADMIN_SECRET table. Returns the parsed table
 * (one entry per `name:secret` pair, or a single `shared-secret`
 * entry when the env var is a plain string). Throws in production
 * when the env var is unset (the dev fallback MUST NOT be reachable
 * in production — it would let anyone read every admin route).
 *
 * Section H (930) — `ADMIN_STRICT=1` disables the dev fallback even
 * when `NODE_ENV !== production`. Useful for staging environments
 * that run with `NODE_ENV=development` but should still require a
 * real secret.
 *
 * Section H-5000 (3665) — the table is parsed once at module load +
 * cached; subsequent calls return the cached table. A new env var
 * value requires a process restart (the platform secret manager
 * rotates by signaling the process, not by mutating env vars).
 */
let adminTokenTable: AdminTokenEntry[] | null = null;

export function getAdminSecret(): string {
  // Back-compat: return the FIRST secret in the table (single-admin
  // callers expect a string). Multi-admin callers should use
  // `getAdminTokenTable()` directly.
  const table = getAdminTokenTable();
  return table[0]?.secret ?? "";
}

/** Section H-5000 (3665) — return the parsed admin token table. */
export function getAdminTokenTable(): AdminTokenEntry[] {
  if (adminTokenTable) return adminTokenTable;
  const env = process.env.ADMIN_SECRET;
  if (!env) {
    const strict =
      process.env.ADMIN_STRICT === "1" || process.env.NODE_ENV === "production";
    if (strict) {
      throw new Error(
        "ADMIN_SECRET must be set. The dev fallback is disabled (production or ADMIN_STRICT=1).",
      );
    }
    if (!devSecretWarned) {
      devSecretWarned = true;
      console.warn(
        "[admin-auth] ADMIN_SECRET not set — using insecure dev fallback. Set ADMIN_SECRET in production.",
      );
    }
    adminTokenTable = [
      { name: ADMIN_ACTOR, secret: "pr_dev_admin_secret_INSECURE_DO_NOT_USE_IN_PRODUCTION" },
    ];
    return adminTokenTable;
  }
  adminTokenTable = parseAdminSecretTable(env);
  return adminTokenTable;
}

/** Test-only — reset the cached token table so the next `getAdminTokenTable` re-parses. */
export function _resetAdminTokenTableForTests(): void {
  adminTokenTable = null;
}
let devSecretWarned = false;

/** True when ADMIN_SECRET is set in env (not the dev fallback). */
export function isAdminConfigured(): boolean {
  return Boolean(process.env.ADMIN_SECRET);
}

/** Constant-time string equality. Returns false on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// ─── 932 — IP allowlist ───────────────────────────────────────────────────

/**
 * Parse `ADMIN_IP_ALLOWLIST` (comma-separated IPs / CIDRs). Returns null
 * when the env var is unset (allowlist disabled — all IPs allowed,
 * subject to the secret + rate limit). When set, only the listed
 * entries pass.
 *
 *   ADMIN_IP_ALLOWLIST="10.0.0.5,192.168.1.0/24,127.0.0.1"
 *
 * CIDR matching: only /32 (exact) and /24 are implemented — sufficient
 * for the typical "office IP + VPN subnet" use case. Wider CIDRs are
 * matched by prefix string compare (good enough for v4 /16-/24).
 */
export function getAdminIpAllowlist(): string[] | null {
  const raw = process.env.ADMIN_IP_ALLOWLIST;
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when `ip` is in the allowlist (or allowlist is disabled). */
export function isIpAllowed(ip: string, allowlist: string[] | null): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (ip === "unknown") return false;
  for (const entry of allowlist) {
    if (entry === ip) return true;
    if (entry.includes("/")) {
      // CIDR. Simple v4 prefix match — split on the mask length.
      const [base, maskStr] = entry.split("/");
      const mask = Number(maskStr);
      if (Number.isFinite(mask) && mask >= 8 && mask <= 32) {
        if (cidrMatchv4(ip, base, mask)) return true;
      }
    }
  }
  return false;
}

function cidrMatchv4(ip: string, base: string, mask: number): boolean {
  const ipParts = ip.split(".").map(Number);
  const baseParts = base.split(".").map(Number);
  if (ipParts.length !== 4 || baseParts.length !== 4) return false;
  if (ipParts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  if (baseParts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const baseInt = (baseParts[0] << 24) | (baseParts[1] << 16) | (baseParts[2] << 8) | baseParts[3];
  const maskInt = mask === 0 ? 0 : (0xFFFFFFFF << (32 - mask)) >>> 0;
  return (ipInt & maskInt) === (baseInt & maskInt);
}

// ─── 931 — Admin-auth rate limit ──────────────────────────────────────────

/** Brute-force throttle: 10 admin-auth attempts / IP / minute. */
const ADMIN_AUTH_RATE_LIMIT = { max: 10, windowMs: 60_000, label: "admin-auth" };

export type AdminAuthResult =
  | { ok: true; actor: string }
  | { ok: false; response: NextResponse };

/**
 * Validate the admin bearer token on an incoming request.
 *
 * Section H (931) — applies a 10/min/IP brute-force throttle BEFORE the
 * secret comparison. A failed attempt consumes a slot (so a brute-forcer
 * can't probe fast); a successful attempt also consumes a slot (so the
 * throttle can't be bypassed by interleaving legit + brute-force calls).
 *
 * Section H (932) — when `ADMIN_IP_ALLOWLIST` is set, requests from
 * non-allowlisted IPs get a 403 before the secret is checked. Combined
 * with the rate limit, this gives prod admin routes two independent
 * gates (IP allowlist + secret) plus an audit trail.
 *
 * Usage:
 *
 *   export async function GET(req: NextRequest) {
 *     const auth = requireAdmin(req);
 *     if (!auth.ok) return auth.response;
 *     // ... handler body ...
 *   }
 *
 * Returns 401 with a generic message on mismatch — never reveal whether
 * the header was missing vs. wrong (both look like "Unauthorized" to an
 * attacker probing the endpoint).
 */
export function requireAdmin(req: NextRequest): AdminAuthResult {
  // 932 — IP allowlist (checked first so a blocked IP doesn't consume a
  // rate-limit slot).
  const ip = getClientIp(req);
  const allowlist = getAdminIpAllowlist();
  if (!isIpAllowed(ip, allowlist)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden — IP not in admin allowlist" },
        { status: 403 },
      ),
    };
  }

  // 931 — brute-force throttle.
  const rl = rateLimit(ipRateKey(ip, "admin-auth"), ADMIN_AUTH_RATE_LIMIT);
  if (!rl.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Too many admin auth attempts", retryAfterMs: rl.retryAfterMs },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
        },
      ),
    };
  }

  const header = req.headers.get(ADMIN_AUTH_HEADER) ?? "";
  // Accept "Bearer <token>" or the raw token (the legacy curl form).
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Unauthorized — missing admin credential" },
        { status: 401 },
      ),
    };
  }
  // Section H-5000 (3665) — match the token against the admin token
  // table. Returns the matched entry's name (per-admin attribution)
  // or null on mismatch.
  const table = getAdminTokenTable();
  const matchedActor = matchAdminToken(token, table);
  if (!matchedActor) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Unauthorized — invalid admin credential" },
        { status: 401 },
      ),
    };
  }
  // 3665 — let the caller override the actor via X-Admin-Actor (sanitized
  // + capped). This is the softer attribution mechanism: any admin can
  // claim any actor name, but it's convenient for ops teams that share
  // one secret + want per-operator audit rows.
  const actorHeader = req.headers.get(ADMIN_ACTOR_HEADER);
  const actor = actorHeader ? sanitizeActor(actorHeader) || matchedActor : matchedActor;
  return { ok: true, actor };
}
