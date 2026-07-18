import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { PLAYER_ID } from "@/lib/seed";
import { _resetRateLimitStore } from "@/lib/security/rate-limit";

/**
 * Backlog §2 item 37 — Contract tests for every /api/* route.
 *
 * A "contract test" calls the route handler directly with a mocked
 * NextRequest, asserts the HTTP status code + the response JSON shape
 * (presence of expected fields + types). It does NOT spin up a real
 * HTTP server — that's an integration / e2e concern. The contract is
 * "given this request, the handler returns this shape".
 *
 * Routes covered (one describe block per route file):
 *
 *   GET  /api/                  → 200 { message: string }
 *   GET  /api/catalog           → 200 { weapons, attachments, skins, operators }
 *   GET  /api/player            → 200 { player, inventory, loadouts, equipped, battlePass }
 *   GET  /api/challenges        → 200 { daily, weekly, dailyResetAt, weeklyResetAt }
 *   GET  /api/battlepass        → 200 { season, tiers, progress, currentTier }
 *   GET  /api/packs/odds        → 200 { disclosure, integrity } | 400 | 404
 *   POST /api/packs/open        → 200 { packSlug, item, seed, ... } | 400 | 403 (CSRF)
 *   POST /api/shop/buy          → 200 { credits, inventory, receipt } | 400 | 403 (CSRF)
 *   GET  /api/admin/backend-health → 200 { provider, connected, ... } | 401 (no admin)
 *
 * Strategy:
 *   - POST routes get an `Origin: http://localhost:3000` header so the
 *     same-origin CSRF check passes (it accepts localhost:3000 in dev).
 *   - Admin routes get `Authorization: Bearer <ADMIN_SECRET>` (set via
 *     env in beforeAll).
 *   - Routes that mutate DB state (shop/buy, packs/open) are exercised
 *     once per test file run; the rate-limit store is reset in
 *     beforeEach so each test starts from a clean counter.
 *
 * Env notes:
 *   - RECEIPT_SECRET is set so currency-guard's HMAC signing works.
 *   - ADMIN_SECRET is set so requireAdmin doesn't fall back to the
 *     dev secret (which would still pass — but we want to test the
 *     real configured-secret path).
 *   - NODE_ENV is left as whatever vitest sets it to ("test" by default
 *     via the vitest runtime; not "production" so dev fallbacks are OK).
 */

const APP_ORIGIN = "http://localhost:3000";

beforeAll(() => {
  process.env.RECEIPT_SECRET = "test-receipt-secret-contract";
  process.env.ADMIN_SECRET = "test-admin-secret-contract";
  process.env.NEXT_PUBLIC_APP_URL = APP_ORIGIN;
});

afterAll(() => {
  delete process.env.RECEIPT_SECRET;
  delete process.env.ADMIN_SECRET;
});

beforeEach(() => {
  // Reset the in-memory rate-limiter so test ordering doesn't bleed
  // counters into each other.
  _resetRateLimitStore();
});

/** Build a NextRequest with the same-origin header set so CSRF passes. */
function postRequest(path: string, body: unknown): NextRequest {
  const url = `http://localhost:3000${path}`;
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

/** Build a plain GET NextRequest (no CSRF needed for GET). */
function getRequest(path: string, init: { headers?: Record<string, string> } = {}): NextRequest {
  const url = `http://localhost:3000${path}`;
  return new NextRequest(url, {
    method: "GET",
    headers: init.headers ?? {},
  });
}

/** Build a GET request that carries the admin bearer secret. */
function adminGetRequest(path: string): NextRequest {
  return getRequest(path, {
    headers: { authorization: `Bearer ${process.env.ADMIN_SECRET}` },
  });
}

// ─── /api (root) ─────────────────────────────────────────────────────────

describe("contract: GET /api", () => {
  it("returns 200 + { message: string }", async () => {
    const { GET } = await import("@/app/api/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.message).toBe("string");
    expect(json.message.length).toBeGreaterThan(0);
  });
});

// ─── /api/catalog ────────────────────────────────────────────────────────

describe("contract: GET /api/catalog", () => {
  it("returns 200 + the four catalog arrays", async () => {
    const { GET } = await import("@/app/api/catalog/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.weapons)).toBe(true);
    expect(Array.isArray(json.attachments)).toBe(true);
    expect(Array.isArray(json.skins)).toBe(true);
    expect(Array.isArray(json.operators)).toBe(true);
    // The seed ships ≥ 10 weapons (ak74, mp7, usp, …).
    expect(json.weapons.length).toBeGreaterThanOrEqual(10);
    // Every weapon has the canonical fields.
    const w = json.weapons[0];
    expect(typeof w.slug).toBe("string");
    expect(typeof w.name).toBe("string");
    expect(typeof w.price).toBe("number");
  });
});

// ─── /api/player ─────────────────────────────────────────────────────────

describe("contract: GET /api/player", () => {
  it("returns 200 + the full player view (player/inventory/loadouts/equipped/battlePass)", async () => {
    const { GET } = await import("@/app/api/player/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.player).toBeDefined();
    expect(json.player.id).toBe(PLAYER_ID);
    expect(typeof json.player.credits).toBe("number");
    expect(typeof json.player.level).toBe("number");
    expect(json.inventory).toBeDefined();
    expect(Array.isArray(json.inventory.weapons)).toBe(true);
    expect(Array.isArray(json.inventory.attachments)).toBe(true);
    expect(Array.isArray(json.inventory.skins)).toBe(true);
    expect(Array.isArray(json.inventory.operators)).toBe(true);
    expect(json.loadouts).toBeDefined();
    // `equipped` may be null when no loadout is marked isEquipped — accept either.
    expect(json.battlePass).toBeDefined();
    expect(typeof json.battlePass.season).toBe("number");
    expect(typeof json.battlePass.tier).toBe("number");
  });
});

// ─── /api/challenges ─────────────────────────────────────────────────────

describe("contract: GET /api/challenges", () => {
  it("returns 200 + daily/weekly arrays + reset timestamps", async () => {
    const { GET } = await import("@/app/api/challenges/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.daily)).toBe(true);
    expect(Array.isArray(json.weekly)).toBe(true);
    expect(typeof json.dailyResetAt).toBe("number");
    expect(typeof json.weeklyResetAt).toBe("number");
    // Each daily challenge has the SerializedChallenge shape.
    if (json.daily.length > 0) {
      const c = json.daily[0];
      expect(typeof c.id).toBe("string");
      expect(typeof c.cadence).toBe("string");
      expect(typeof c.target).toBe("number");
      expect(typeof c.progress).toBe("number");
      expect(typeof c.completed).toBe("boolean");
      expect(typeof c.claimed).toBe("boolean");
    }
  });
});

// ─── /api/battlepass ─────────────────────────────────────────────────────

describe("contract: GET /api/battlepass", () => {
  it("returns 200 + the season + tiers + progress", async () => {
    const { GET } = await import("@/app/api/battlepass/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.season).toBeDefined();
    expect(typeof json.season.season).toBe("number");
    expect(typeof json.season.tierSize).toBe("number");
    expect(Array.isArray(json.tiers)).toBe(true);
    expect(json.progress).toBeDefined();
    expect(typeof json.currentTier).toBe("number");
  });
});

// ─── /api/packs/odds ─────────────────────────────────────────────────────

describe("contract: GET /api/packs/odds", () => {
  it("returns 400 when no pack query param is supplied", async () => {
    const { GET } = await import("@/app/api/packs/odds/route");
    const req = getRequest("/api/packs/odds");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
  });

  it("returns 404 for an unknown pack slug", async () => {
    const { GET } = await import("@/app/api/packs/odds/route");
    const req = getRequest("/api/packs/odds?pack=does_not_exist");
    const res = await GET(req);
    expect(res.status).toBe(404);
  });

  it("returns 200 + the disclosure + integrity flag for a known pack", async () => {
    const { GET } = await import("@/app/api/packs/odds/route");
    const req = getRequest("/api/packs/odds?pack=tactical");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.disclosure).toBeDefined();
    expect(json.disclosure.packSlug).toBe("tactical");
    expect(Array.isArray(json.disclosure.rows)).toBe(true);
    expect(json.disclosure.rows.length).toBeGreaterThan(0);
    expect(typeof json.integrity).toBe("boolean");
    expect(json.integrity).toBe(true);
  });
});

// ─── /api/packs/open ─────────────────────────────────────────────────────

describe("contract: POST /api/packs/open", () => {
  it("returns 403 when the Origin header is missing (CSRF guard)", async () => {
    const { POST } = await import("@/app/api/packs/open/route");
    // Build a POST with no Origin/Referer — same-origin check rejects.
    const req = new NextRequest("http://localhost:3000/api/packs/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packSlug: "tactical" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toMatch(/CSRF|Origin/i);
  });

  it("returns 400 when the body fails Zod validation (unknown pack)", async () => {
    const { POST } = await import("@/app/api/packs/open/route");
    const req = postRequest("/api/packs/open", { packSlug: "free_money" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

  it("returns 400 when the player can't afford the pack", async () => {
    const { POST } = await import("@/app/api/packs/open/route");
    // Drain the player's credits to 0 so any pack is unaffordable.
    const player = await db.player.findUniqueOrThrow({ where: { id: PLAYER_ID } });
    await db.player.update({ where: { id: PLAYER_ID }, data: { credits: 0 } });
    try {
      const req = postRequest("/api/packs/open", { packSlug: "tactical" });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/Insufficient/i);
    } finally {
      // Restore — the load test (item 38) and other tests rely on the
      // player having some credits.
      await db.player.update({ where: { id: PLAYER_ID }, data: { credits: player.credits } });
    }
  });
});

// ─── /api/shop/buy ───────────────────────────────────────────────────────

describe("contract: POST /api/shop/buy", () => {
  it("returns 403 when the Origin header is missing (CSRF guard)", async () => {
    const { POST } = await import("@/app/api/shop/buy/route");
    const req = new NextRequest("http://localhost:3000/api/shop/buy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemType: "WEAPON", slug: "ak74" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 when itemType is not in the catalog enum", async () => {
    const { POST } = await import("@/app/api/shop/buy/route");
    const req = postRequest("/api/shop/buy", { itemType: "NUKE", slug: "ak74" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when slug contains path-traversal characters", async () => {
    const { POST } = await import("@/app/api/shop/buy/route");
    const req = postRequest("/api/shop/buy", {
      itemType: "WEAPON",
      slug: "../../../etc/passwd",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 'Already owned' when the player tries to re-buy a starter weapon", async () => {
    const { POST } = await import("@/app/api/shop/buy/route");
    // ak74 is a starter weapon (see STARTER_WEAPON_SLUGS) — the seed
    // already grants the player an inventory row for it.
    const req = postRequest("/api/shop/buy", { itemType: "WEAPON", slug: "ak74" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/own/i);
  });
});

// ─── /api/admin/backend-health ──────────────────────────────────────────

describe("contract: GET /api/admin/backend-health", () => {
  it("returns 401 when no Authorization header is supplied", async () => {
    const { GET } = await import("@/app/api/admin/backend-health/route");
    const req = getRequest("/api/admin/backend-health");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the bearer secret is wrong", async () => {
    const { GET } = await import("@/app/api/admin/backend-health/route");
    const req = getRequest("/api/admin/backend-health", {
      headers: { authorization: "Bearer wrong-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 200 + the backend health shape when the secret is correct", async () => {
    const { GET } = await import("@/app/api/admin/backend-health/route");
    const req = adminGetRequest("/api/admin/backend-health");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.provider).toBe("string");
    expect(typeof json.hasUrl).toBe("boolean");
    expect(typeof json.connected).toBe("boolean");
    expect(typeof json.adminSecretConfigured).toBe("boolean");
    expect(typeof json.ts).toBe("string");
    // The URL must NEVER leak credentials (Task-1 SEC item 19).
    if (json.url) {
      expect(json.url).not.toMatch(/:\/\/[^/]+:[^/@]+@/);
    }
  });
});
