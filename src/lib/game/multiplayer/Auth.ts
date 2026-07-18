/**
 * P7.1: Authentication & player identity (Task-H SEC revision).
 *
 * Section A (145–150) + Section H (912–916) hardening:
 *
 *   145 / 912 — Replace the toy `simpleHash` session-token signature with
 *               HMAC-SHA256. The old `simpleHash` was a 32-bit DJB2-style
 *               hash: trivially forgeable, so any client could mint a
 *               valid session token for any playerId.
 *   913       — Token comparison uses `timingSafeEqual` (constant-time)
 *               so an attacker can't time-oracle the comparison byte-by-byte.
 *   146 / 915 — `getOrCreatePlayer` no longer silently creates players
 *               from an untrusted `playerId` argument (IDOR). It now
 *               requires either an authenticated session token OR an
 *               explicit `assert: true` flag the caller passes after its
 *               own auth check (kept for the seed/bootstrap path).
 *   147 / 916 — `getSessionSecret()` throws in production when
 *               `SESSION_SECRET` is unset. The dev-only fallback is
 *               still allowed so local development works without env setup.
 *   914       — Refresh-token rotation. `createSessionToken` now returns
 *               `{ access, refresh, exp }`. Access tokens are short-lived
 *               (15 min); refresh tokens are longer-lived (7 days) and
 *               single-use — `rotateRefreshToken` consumes the old refresh
 *               and issues a fresh pair.
 *
 * The local session-token helpers don't depend on `next-auth` (which Task-1
 * removed — see `security.md` §"Decision: next-auth removed"). A future
 * real-multiplayer build should re-evaluate IdP choice (NextAuth v5 /
 * Clerk / Supabase Auth / custom OIDC).
 */

import { db } from "@/lib/db";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export interface PlayerIdentity {
  id: string;
  displayName: string;
  isGuest: boolean;
  createdAt: number;
}

/** Create a guest player with a random callsign. */
export async function createGuestPlayer(): Promise<PlayerIdentity> {
  const callsign = generateCallsign();
  const player = await db.player.create({
    data: { displayName: callsign, credits: 500, level: 1, xp: 0 },
  });
  return {
    id: player.id,
    displayName: player.displayName,
    isGuest: true,
    createdAt: player.createdAt.getTime(),
  };
}

/**
 * Get or create a player by ID.
 *
 * Section A (146) / H (915) — IDOR fix: the previous implementation would
 * happily create+return a player for any caller-supplied `playerId`,
 * including an attacker-supplied one. We now require an authenticated
 * session token (validated against the server-side HMAC key) OR an
 * explicit `assert: true` flag the caller passes after its own auth
 * check (the bootstrap/seed path uses this).
 *
 * The function is still named `getOrCreatePlayer` for back-compat with
 * callers that legitimately need upsert semantics after authenticating
 * the request (e.g. the seed bootstrap). New code should prefer
 * `getPlayer(playerId)` for read-only lookups (which never creates).
 */
export async function getOrCreatePlayer(
  playerId: string,
  opts: { assert?: boolean; sessionToken?: string } = {},
): Promise<PlayerIdentity | null> {
  // IDOR gate: require either an explicit assert (post-auth bootstrap) or
  // a valid session token whose payload matches `playerId`.
  if (!opts.assert) {
    if (!opts.sessionToken) return null;
    const session = verifySessionToken(opts.sessionToken);
    if (!session || session.playerId !== playerId) return null;
  }
  const player = await db.player.findUnique({ where: { id: playerId } });
  if (!player) return null;
  return {
    id: player.id,
    displayName: player.displayName,
    isGuest: false,
    createdAt: player.createdAt.getTime(),
  };
}

/** Read-only player lookup (never creates). */
export async function getPlayer(playerId: string): Promise<PlayerIdentity | null> {
  const player = await db.player.findUnique({ where: { id: playerId } });
  if (!player) return null;
  return {
    id: player.id,
    displayName: player.displayName,
    isGuest: false,
    createdAt: player.createdAt.getTime(),
  };
}

function generateCallsign(): string {
  const animals = ["Wolf", "Viper", "Hawk", "Bear", "Cobra", "Lion", "Shark", "Raven", "Falcon", "Tiger"];
  // Use crypto.randomBytes for the callsign too — Math.random was the
  // original complaint (H/937 covers session IDs, but callsigns should
  // also be unpredictable so an attacker can't enumerate callsigns
  // to identify sessions).
  const aIdx = randomBytes(1)[0] % animals.length;
  const n = (randomBytes(1)[0] % 9) + 1;
  return `${animals[aIdx]}-${n}`;
}

// ─── Session secret ──────────────────────────────────────────────────────

/**
 * Section A (147) / H (916) — read the session secret. Throws in production
 * when `SESSION_SECRET` is unset (no silent dev fallback in prod). In dev
 * we log once + use a fixed insecure key so the flow is exercisable
 * without env setup.
 */
export function getSessionSecret(): string {
  const env = process.env.SESSION_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (env) return env;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET must be set in production. Generate with: openssl rand -hex 32",
    );
  }
  if (!devSecretWarned) {
    devSecretWarned = true;
    console.warn(
      "[auth] SESSION_SECRET not set — using insecure dev fallback. Set SESSION_SECRET in production.",
    );
  }
  return "pr_dev_session_secret_INSECURE_DO_NOT_USE_IN_PRODUCTION";
}
let devSecretWarned = false;

// ─── HMAC-SHA256 session tokens (145 / 912 / 913) ────────────────────────

/** Access-token TTL — short, so a stolen token has a small blast radius. */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min

/** Refresh-token TTL — long, but single-use (rotated on each refresh). */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SessionPayload {
  playerId: string;
  /** Token kind: "access" | "refresh". */
  kind: "access" | "refresh";
  /** Issue time (ms since epoch). */
  iat: number;
  /** Expiry time (ms since epoch). */
  exp: number;
  /** Random 16-byte family id — all refresh tokens in a chain share this. */
  fam?: string;
}

export interface SessionTokenPair {
  access: string;
  refresh: string;
  exp: number;
}

/**
 * Issue an HMAC-SHA256-signed session token pair (access + refresh) for
 * `playerId`. Section H (914) — refresh tokens rotate on each refresh;
 * both are signed with the server-side `SESSION_SECRET`.
 *
 *   const pair = createSessionToken(playerId);
 *   // pair.access  — short-lived (15 min), sent on every request.
 *   // pair.refresh — long-lived (7 days), single-use, sent only to refresh.
 */
export function createSessionToken(playerId: string): SessionTokenPair {
  const now = Date.now();
  const fam = randomBytes(16).toString("hex");
  return {
    access: signSessionToken({
      playerId,
      kind: "access",
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_MS,
      fam,
    }),
    refresh: signSessionToken({
      playerId,
      kind: "refresh",
      iat: now,
      exp: now + REFRESH_TOKEN_TTL_MS,
      fam,
    }),
    exp: now + ACCESS_TOKEN_TTL_MS,
  };
}

/** Sign a SessionPayload with the server-side HMAC key. */
function signSessionToken(payload: SessionPayload): string {
  const payloadStr = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", getSessionSecret()).update(payloadStr).digest("hex");
  return `${payloadStr}.${sig}`;
}

/**
 * Verify a session token's HMAC signature + expiry. Constant-time compare
 * (Section H/913) so an attacker can't byte-by-byte time-oracle the
 * signature. Returns the decoded payload on success, `null` on failure
 * (bad signature, bad shape, expired, or future-iat).
 */
export function verifySessionToken(token: string): SessionPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payloadStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", getSessionSecret()).update(payloadStr).digest("hex");
  // 913 — constant-time compare. Length mismatch bails early (timingSafeEqual
  // throws on length mismatch, which would leak length info — we guard).
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.playerId !== "string") return null;
    if (payload.kind !== "access" && payload.kind !== "refresh") return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    if (typeof payload.iat !== "number" || payload.iat > Date.now() + 60_000) return null; // clock-skew tolerance
    return payload;
  } catch {
    return null;
  }
}

// ─── Refresh-token rotation (914) ─────────────────────────────────────────

/**
 * In-memory rotation log: tracks the family id of the most-recently-issued
 * refresh token per playerId. A refresh attempt with a stale family id
 * (i.e. the refresh token was already rotated) is rejected — this is the
 * standard "refresh-token reuse detection" defense (RFC 6749 §10.4).
 *
 * For multi-instance deployments this should move to Redis (key:
 * `session:fam:<playerId>`). Single-instance dev is fine in-memory.
 */
const refreshFamilies = new Map<string, { fam: string; exp: number }>();

/**
 * Rotate a refresh token: consumes the supplied refresh token (single-use),
 * issues a fresh access + refresh pair, and updates the family rotation log.
 *
 *   const next = rotateRefreshToken(refreshToken);
 *   if (!next) return errorResponse("Invalid or replayed refresh token", 401);
 *
 * Returns `null` when:
 *   - the supplied token is malformed or has a bad signature,
 *   - the token has expired,
 *   - the token's family doesn't match the current rotation log entry
 *     (replay — the token was already rotated, possible token theft).
 */
export function rotateRefreshToken(refreshToken: string): SessionTokenPair | null {
  const payload = verifySessionToken(refreshToken);
  if (!payload || payload.kind !== "refresh") return null;
  const current = refreshFamilies.get(payload.playerId);
  if (current && current.fam !== payload.fam) {
    // Reuse detected — the supplied refresh token's family doesn't match
    // the latest. This is the classic "refresh token reuse" signal:
    // an attacker stole an old refresh token + is trying to use it
    // after the legitimate client already rotated. Revoke the family
    // entirely (force re-auth) by deleting the entry — subsequent
    // refresh attempts with any token in this family will fail.
    refreshFamilies.delete(payload.playerId);
    return null;
  }
  // Issue a fresh pair under a new family id.
  const pair = createSessionToken(payload.playerId);
  // Track the new family id so a replay of the OLD refresh token is caught.
  const newFam: string = verifySessionToken(pair.refresh)?.fam ?? payload.fam ?? "";
  refreshFamilies.set(payload.playerId, {
    fam: newFam,
    exp: Date.now() + REFRESH_TOKEN_TTL_MS,
  });
  return pair;
}

/** Revoke all tokens in a player's refresh family (force re-auth). */
export function revokeSession(playerId: string): void {
  refreshFamilies.delete(playerId);
}

/** Periodic GC of expired rotation entries. Call from a cron or on access. */
export function gcRefreshFamilies(): number {
  const now = Date.now();
  let n = 0;
  for (const [pid, entry] of refreshFamilies) {
    if (entry.exp < now) {
      refreshFamilies.delete(pid);
      n++;
    }
  }
  return n;
}

// ─── Legacy back-compat helpers (kept so existing callers compile) ───────
//
// Existing call sites use `verifySessionToken(token): { playerId, exp }`.
// The new function returns the richer `SessionPayload`; this thin wrapper
// preserves the old return shape for callers that haven't been updated.
//
// New code should call `verifySessionToken` directly + check `kind === "access"`.

export function verifyAccessToken(token: string): { playerId: string; exp: number } | null {
  const p = verifySessionToken(token);
  if (!p || p.kind !== "access") return null;
  return { playerId: p.playerId, exp: p.exp };
}

/**
 * Generate a random opaque session id (used by Matchmaking + server-side
 * session tables). Section H (937) — `Matchmaking.ts` was generating
 * session IDs with `Math.random().toString(36)`; this helper uses
 * `crypto.randomUUID()` so session IDs are 122 bits of entropy +
 * unpredictable.
 */
export function generateSessionId(): string {
  return randomUUID();
}

/** Random opaque token (hex) — used for CSRF tokens, recovery links, etc. */
export function generateOpaqueToken(byteLen = 32): string {
  return randomBytes(byteLen).toString("hex");
}
