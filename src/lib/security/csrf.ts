/**
 * Task-1 (SEC) item 5 — Same-origin CSRF protection on mutating POST routes.
 *
 * Section A (148) / H (917) — `allowedOrigins()` no longer unconditionally
 * allows `http://localhost:3000`. In production that's an attack surface
 * (a script on localhost could CSRF the prod server). Localhost is only
 * allowed when `NODE_ENV !== "production"`.
 *
 * Section H (918) — defense-in-depth CSRF *token* on top of the Origin/
 * Referer check. The token is a double-submit cookie: a non-secret random
 * value the client must echo in the `X-CSRF-Token` header. The cookie is
 * `SameSite=Strict` (so it isn't sent on cross-site requests at all) +
 * the header check confirms the request came from JS running on the same
 * origin (which a cross-site form POST can't forge).
 *
 * Section H (919) — `setCsrfCookie` / `withSameSiteCookie` helpers ready
 * for the day the codebase adopts cookie-based auth. Currently the app
 * uses bearer-header auth (no session cookies), so the cookie path is
 * dormant — but the helpers exist so a future migration can't ship
 * cookies without SameSite.
 *
 * Threat model recap:
 *
 *   1. `Origin`/`Referer` check (stateless, sufficient for same-origin SPA
 *      with bearer auth) — primary defense.
 *   2. CSRF token (stateful, double-submit) — defense-in-depth, defeats
 *      any future bug in the Origin check (e.g. browser quirk, proxy
 *      header rewriting).
 *   3. SameSite=Strict cookie flag (browser-enforced) — only relevant when
 *      cookies are added; the helpers here make it impossible to ship a
 *      cookie without it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";

/**
 * Section A (148) / H (917) — allowed origins for same-origin checks.
 *
 * Production: only `NEXT_PUBLIC_APP_URL` (no localhost — would be an
 * attack surface). Dev: also `http://localhost:3000` so local dev works
 * without env setup.
 */
export function allowedOrigins(): string[] {
  const out: string[] = [];
  const env = process.env.NEXT_PUBLIC_APP_URL;
  if (env) out.push(env.replace(/\/$/, ""));
  if (process.env.NODE_ENV !== "production") {
    out.push("http://localhost:3000");
  }
  return Array.from(new Set(out));
}

/** Extract the effective origin from a request (Origin header, fall back to Referer). */
export function requestOrigin(req: NextRequest): string | null {
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

export type CsrfResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

/**
 * Enforce same-origin on a mutating request. Returns `{ ok: true }` on
 * success or `{ ok: false, response }` on failure — the caller returns
 * the response immediately.
 *
 * Section H (918) — when `requireToken: true` (opt-in, used by routes that
 * have migrated to the CSRF-token defense-in-depth path), also requires
 * the request to carry an `X-CSRF-Token` header whose value matches the
 * `csrf_token` cookie. Routes that haven't migrated still get the
 * Origin/Referer check (the original Task-1 defense).
 */
export function requireSameOrigin(
  req: NextRequest,
  opts: { requireToken?: boolean } = {},
): CsrfResult {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { ok: true };
  }
  const origin = requestOrigin(req);
  if (!origin) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Missing Origin/Referer header — possible CSRF" },
        { status: 403 },
      ),
    };
  }
  const allowed = allowedOrigins();
  if (!allowed.includes(origin)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Origin ${origin} not allowed` },
        { status: 403 },
      ),
    };
  }

  // 918 — optional defense-in-depth CSRF token (double-submit cookie).
  if (opts.requireToken) {
    const headerTok = req.headers.get("x-csrf-token") ?? "";
    const cookieTok = req.cookies.get("csrf_token")?.value ?? "";
    if (
      !headerTok ||
      !cookieTok ||
      headerTok.length !== cookieTok.length ||
      !constantTimeEqual(headerTok, cookieTok)
    ) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Missing or mismatched CSRF token" },
          { status: 403 },
        ),
      };
    }
  }

  return { ok: true };
}

/**
 * Section H (918) — issue a fresh CSRF token (double-submit cookie).
 * Routes that opt into `requireToken: true` should call this on session
 * bootstrap (e.g. GET /api/player) and set the cookie via Set-Cookie.
 *
 * Returns `{ token, cookie }` where `cookie` is a fully-formed
 * `Set-Cookie` header value ready to drop into a NextResponse.
 */
export function issueCsrfToken(): { token: string; cookie: string } {
  const token = randomBytes(32).toString("hex");
  // 919 — SameSite=Strict; also Secure in prod (HTTPS-only), HttpOnly
  // off (the client JS needs to read it to put it in the X-CSRF-Token
  // header — that's the double-submit pattern).
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const cookie = `csrf_token=${token}; Path=/; Max-Age=86400; SameSite=Strict${secure}`;
  return { token, cookie };
}

/** Constant-time string compare. Returns false on length mismatch. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  try {
    // node:crypto.timingSafeEqual
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { timingSafeEqual } = require("node:crypto") as typeof import("node:crypto");
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Section H (919) — cookie helper for future cookie-based auth. Wraps any
 * Set-Cookie string + injects `SameSite=Strict` (and `Secure` in prod)
 * if they aren't already present. Use this for every cookie the app sets
 * so a future cookie can't accidentally ship without SameSite.
 */
export function withSameSiteCookie(setCookie: string): string {
  const hasSameSite = /SameSite=/i.test(setCookie);
  const hasSecure = /Secure/i.test(setCookie);
  let out = setCookie;
  if (!hasSameSite) out += "; SameSite=Strict";
  if (!hasSecure && process.env.NODE_ENV === "production") out += "; Secure";
  return out;
}
