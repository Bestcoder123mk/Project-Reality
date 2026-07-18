/**
 * L1-5000 / prompts 4478,4532,4586,4624,4662,4700,4738: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * SEC12-PLATFORM prompt 95 — Security audit of API routes.
 *
 * Reviews every route under `src/app/api/` for input validation +
 * authorization. The audit runs at module load — it reads the route
 * files via `fs.readdir` and statically lists all routes + their
 * auth/validation status (based on a curated registry of which routes
 * accept player-controlled balance/price/quantity without server-side
 * validation).
 *
 * Public API:
 *   - `auditApiRoutes()` — sync scan of the `src/app/api/` directory,
 *     returns a structured report of every discovered route + flags.
 *   - `ROUTE_REGISTRY` — curated map of known routes + their
 *     server-side validation status. Used by `auditApiRoutes` to flag
 *     routes that accept player-controlled balance/price without
 *     server-side validation.
 *   - `SecurityAuditReport` — the structured return type.
 *
 * The admin route `/api/admin/security-audit` returns the report. The
 * report is non-actionable on its own — it's a snapshot the
 * security/compliance team reviews on each release to confirm every
 * route has the right validation flags set.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

/** A single API route entry discovered by the filesystem scan. */
export interface DiscoveredRoute {
  /** Filesystem path relative to the project root (POSIX-style). */
  path: string;
  /** URL path inferred from the filesystem path (e.g. "/api/shop/buy"). */
  urlPath: string;
  /** HTTP methods the route file exports (GET/POST/PUT/PATCH/DELETE). */
  methods: string[];
  /** True when the file imports a zod schema or performs manual type guards. */
  hasInputValidation: boolean;
  /** True when the file imports an auth/session helper. */
  hasAuthCheck: boolean;
  /** True when the file touches the database (db / prisma import). */
  writesToDatabase: boolean;
  /** True when the file references a balance/price/quantity/credits field. */
  touchesCurrency: boolean;
}

export interface RouteValidationStatus {
  /** URL path (e.g. "/api/shop/buy"). */
  urlPath: string;
  /** Filesystem path relative to project root. */
  filePath: string;
  /** Curated assessment of input validation. */
  validation: "server-canonical" | "client-validated-only" | "none" | "unknown";
  /** Curated assessment of authorization. */
  authorization: "admin-only" | "player-scoped" | "public" | "unknown";
  /** True when the route accepts a player-controlled balance/price field. */
  acceptsPlayerControlledCurrency: boolean;
  /** True when the server-side catalog/guard is the source of truth. */
  serverCanonicalPrice: boolean;
  /** Free-form notes (e.g. "uses currency-guard.validatePurchase"). */
  notes: string;
}

export interface SecurityAuditReport {
  /** ISO timestamp the audit was run. */
  generatedAt: string;
  /** Total routes discovered by the filesystem scan. */
  totalRoutes: number;
  /** Routes flagged as needing follow-up. */
  flaggedRoutes: RouteValidationStatus[];
  /** Full per-route status registry. */
  routeStatuses: RouteValidationStatus[];
  /** Routes the scan discovered that aren't in the curated registry. */
  unmappedRoutes: DiscoveredRoute[];
  /** High-level counts (for the admin dashboard). */
  summary: {
    serverCanonical: number;
    clientValidatedOnly: number;
    noValidation: number;
    adminOnly: number;
    publicRoutes: number;
    acceptsPlayerControlledCurrency: number;
  };
}

// ── Curated route registry ────────────────────────────────────────────────
//
// Each route is annotated with the validation + authorization assessment
// based on a code review. The scan still discovers every route file; this
// registry adds the curated metadata that a filesystem scan can't infer.

export const ROUTE_REGISTRY: RouteValidationStatus[] = [
  {
    urlPath: "/api/shop/buy",
    filePath: "src/app/api/shop/buy/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: true,
    serverCanonicalPrice: true,
    notes:
      "Accepts clientPrice but currency-guard.validatePurchase re-fetches from catalog. Receipt signed with HMAC.",
  },
  {
    urlPath: "/api/packs/open",
    filePath: "src/app/api/packs/open/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: true,
    serverCanonicalPrice: true,
    notes:
      "Server-side pack config + currency-guard. LootBoxRoll audit log + signed receipt.",
  },
  {
    urlPath: "/api/packs/odds",
    filePath: "src/app/api/packs/odds/route.ts",
    validation: "server-canonical",
    authorization: "public",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Read-only odds disclosure (loot-box compliance). No body.",
  },
  {
    urlPath: "/api/battlepass/premium",
    filePath: "src/app/api/battlepass/premium/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: true,
    serverCanonicalPrice: true,
    notes: "Server-side season price lookup. Currency-guard debit + receipt.",
  },
  {
    urlPath: "/api/battlepass/claim",
    filePath: "src/app/api/battlepass/claim/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Tier index validated against claimedTiers + maxTier.",
  },
  {
    urlPath: "/api/battlepass",
    filePath: "src/app/api/battlepass/route.ts",
    validation: "none",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Read-only GET. No body to validate.",
  },
  {
    urlPath: "/api/challenges",
    filePath: "src/app/api/challenges/route.ts",
    validation: "none",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Read-only GET.",
  },
  {
    urlPath: "/api/challenges/claim",
    filePath: "src/app/api/challenges/claim/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Challenge id validated against the player's challenge rows.",
  },
  {
    urlPath: "/api/loadout/equip",
    filePath: "src/app/api/loadout/equip/route.ts",
    validation: "client-validated-only",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes:
      "FLAG: slug ownership is checked via getPlayerInventorySlugs but no zod schema. Add zod for hardening.",
  },
  {
    urlPath: "/api/loadout/equip-operator",
    filePath: "src/app/api/loadout/equip-operator/route.ts",
    validation: "client-validated-only",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "FLAG: same as /loadout/equip — add zod.",
  },
  {
    urlPath: "/api/clan/create",
    filePath: "src/app/api/clan/create/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Tag + name validated server-side (length + uniqueness).",
  },
  {
    urlPath: "/api/clan/join",
    filePath: "src/app/api/clan/join/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Clan tag validated server-side (existence + not-full check).",
  },
  {
    urlPath: "/api/clan/leaderboard",
    filePath: "src/app/api/clan/leaderboard/route.ts",
    validation: "none",
    authorization: "public",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Read-only GET.",
  },
  {
    urlPath: "/api/catalog",
    filePath: "src/app/api/catalog/route.ts",
    validation: "none",
    authorization: "public",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Read-only GET.",
  },
  {
    urlPath: "/api/player",
    filePath: "src/app/api/player/route.ts",
    validation: "none",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Read-only GET.",
  },
  {
    urlPath: "/api/seed",
    filePath: "src/app/api/seed/route.ts",
    validation: "none",
    authorization: "admin-only",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Dev-only seed route. Should be disabled in production.",
  },
  {
    urlPath: "/api/admin/experiments",
    filePath: "src/app/api/admin/experiments/route.ts",
    validation: "server-canonical",
    authorization: "admin-only",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Admin-only. key/description/rollout validated server-side.",
  },
  {
    urlPath: "/api/admin/calendar",
    filePath: "src/app/api/admin/calendar/route.ts",
    validation: "server-canonical",
    authorization: "admin-only",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Admin-only. Slug/kind/title/dates validated server-side.",
  },
  {
    urlPath: "/api/admin/rollover",
    filePath: "src/app/api/admin/rollover/route.ts",
    validation: "none",
    authorization: "admin-only",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Admin-only. No body — triggers a server-side rollover check.",
  },
  {
    urlPath: "/api/admin/dashboard",
    filePath: "src/app/api/admin/dashboard/route.ts",
    validation: "none",
    authorization: "admin-only",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Admin-only. Read-only GET.",
  },
  {
    urlPath: "/api/admin/backend-health",
    filePath: "src/app/api/admin/backend-health/route.ts",
    validation: "none",
    authorization: "admin-only",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Admin-only. Read-only GET.",
  },
  {
    urlPath: "/api/telemetry/errors",
    filePath: "src/app/api/telemetry/errors/route.ts",
    validation: "client-validated-only",
    authorization: "public",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes:
      "FLAG: crash-report ingest. Body is loosely typed — could be tightened with zod, but accepts untrusted data by design.",
  },
  {
    urlPath: "/api/telemetry/events",
    filePath: "src/app/api/telemetry/events/route.ts",
    validation: "client-validated-only",
    authorization: "public",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "FLAG: analytics ingest. Same as /telemetry/errors.",
  },
  {
    urlPath: "/api/audio/vo",
    filePath: "src/app/api/audio/vo/route.ts",
    validation: "none",
    authorization: "public",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Read-only GET.",
  },
  {
    urlPath: "/api/admin/security-audit",
    filePath: "src/app/api/admin/security-audit/route.ts",
    validation: "none",
    authorization: "admin-only",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Admin-only. Read-only GET (this report).",
  },
  {
    urlPath: "/api/admin/crash-free",
    filePath: "src/app/api/admin/crash-free/route.ts",
    validation: "none",
    authorization: "admin-only",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Admin-only. Read-only GET.",
  },
  {
    urlPath: "/api/player/data-export",
    filePath: "src/app/api/player/data-export/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "GDPR data portability. playerId validated server-side.",
  },
  {
    urlPath: "/api/player/delete",
    filePath: "src/app/api/player/delete/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "GDPR right to erasure. Confirmation token required.",
  },
  {
    urlPath: "/api/support/bug-report",
    filePath: "src/app/api/support/bug-report/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Bug-report ingest. Zod-validated body.",
  },
  {
    urlPath: "/api/support/ticket",
    filePath: "src/app/api/support/ticket/route.ts",
    validation: "server-canonical",
    authorization: "player-scoped",
    acceptsPlayerControlledCurrency: false,
    serverCanonicalPrice: false,
    notes: "Support ticket ingest. Zod-validated body.",
  },
];

// ── Filesystem scan ────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const API_ROOT = join(PROJECT_ROOT, "src", "app", "api");

/** Recursively discover every `route.ts` file under the API root. */
function discoverRouteFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...discoverRouteFiles(full));
    } else if (entry === "route.ts" || entry === "route.tsx") {
      out.push(full);
    }
  }
  return out;
}

/** Infer the URL path from a filesystem route path. */
function inferUrlPath(absPath: string): string {
  const rel = relative(API_ROOT, absPath).replace(/\\/g, "/");
  // Drop the trailing /route.ts (or route.tsx).
  const withoutRoute = rel.replace(/\/route\.tsx?$/, "");
  return `/api/${withoutRoute}`;
}

/** Statically detect which HTTP methods the route file exports. */
function detectMethods(source: string): string[] {
  const methods: string[] = [];
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    // Match `export async function GET` or `export function GET`.
    const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`);
    if (re.test(source)) methods.push(m);
  }
  return methods;
}

/** Statically detect whether the route has input validation. */
function detectValidation(source: string): boolean {
  return (
    source.includes("zod") ||
    source.includes("z.") ||
    source.includes(".parse(") ||
    source.includes(".safeParse(") ||
    /typeof\s+\w+\s*!==\s*['"]string['"]/.test(source) ||
    source.includes("isItemType") ||
    source.includes("isScheduledEventKind") ||
    source.includes("validatePurchase")
  );
}

/** Statically detect whether the route has an auth/session check. */
function detectAuth(source: string): boolean {
  return (
    source.includes("getServerSession") ||
    source.includes("requireAdmin") ||
    source.includes("isAdmin") ||
    source.includes("admin") ||
    source.includes("PLAYER_ID") // Player-scoped implicit auth
  );
}

/** Statically detect whether the route writes to the database. */
function detectDbWrite(source: string): boolean {
  return source.includes("db.") || source.includes("prisma.");
}

/** Statically detect whether the route touches currency fields. */
function detectCurrency(source: string): boolean {
  return (
    source.includes("price") ||
    source.includes("credits") ||
    source.includes("balance") ||
    source.includes("amount") ||
    source.includes("currency-guard") ||
    source.includes("validatePurchase") ||
    source.includes("debit")
  );
}

/** Build a DiscoveredRoute from a route file path. */
function buildDiscoveredRoute(absPath: string): DiscoveredRoute {
  let source = "";
  try {
    source = readFileSync(absPath, "utf8");
  } catch {
    /* unreadable — leave source empty */
  }
  const relPath = relative(PROJECT_ROOT, absPath).replace(/\\/g, "/");
  return {
    path: relPath,
    urlPath: inferUrlPath(absPath),
    methods: detectMethods(source),
    hasInputValidation: detectValidation(source),
    hasAuthCheck: detectAuth(source),
    writesToDatabase: detectDbWrite(source),
    touchesCurrency: detectCurrency(source),
  };
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Audit every route under `src/app/api/`. Returns the structured report
 * the admin route surfaces. Sync (filesystem read at module load) —
 * acceptable because the API directory is small (~25 routes).
 */
export function auditApiRoutes(): SecurityAuditReport {
  const routeFiles = discoverRouteFiles(API_ROOT);
  const discovered: DiscoveredRoute[] = routeFiles.map(buildDiscoveredRoute);

  // Index the curated registry by URL path for O(1) lookup.
  const registryByUrl = new Map(ROUTE_REGISTRY.map((r) => [r.urlPath, r]));

  // Build the per-route status list: every discovered route gets a status
  // entry, either from the registry (curated) or synthesized (unknown).
  const routeStatuses: RouteValidationStatus[] = [];
  const unmappedRoutes: DiscoveredRoute[] = [];

  for (const dr of discovered) {
    const curated = registryByUrl.get(dr.urlPath);
    if (curated) {
      routeStatuses.push(curated);
    } else {
      unmappedRoutes.push(dr);
      routeStatuses.push({
        urlPath: dr.urlPath,
        filePath: dr.path,
        validation: "unknown",
        authorization: "unknown",
        acceptsPlayerControlledCurrency: dr.touchesCurrency,
        serverCanonicalPrice: false,
        notes: `Unmapped route — discovered by filesystem scan but not in ROUTE_REGISTRY. Static scan: methods=[${dr.methods.join(",")}] validation=${dr.hasInputValidation} auth=${dr.hasAuthCheck} db=${dr.writesToDatabase} currency=${dr.touchesCurrency}`,
      });
    }
  }

  // Flagged routes: any route that accepts player-controlled currency
  // without server-canonical price validation, OR has unknown validation.
  const flaggedRoutes = routeStatuses.filter((r) => {
    if (r.validation === "unknown") return true;
    if (r.acceptsPlayerControlledCurrency && !r.serverCanonicalPrice) return true;
    if (r.validation === "none" && r.acceptsPlayerControlledCurrency) return true;
    return false;
  });

  const summary = {
    serverCanonical: routeStatuses.filter((r) => r.validation === "server-canonical").length,
    clientValidatedOnly: routeStatuses.filter((r) => r.validation === "client-validated-only").length,
    noValidation: routeStatuses.filter((r) => r.validation === "none").length,
    adminOnly: routeStatuses.filter((r) => r.authorization === "admin-only").length,
    publicRoutes: routeStatuses.filter((r) => r.authorization === "public").length,
    acceptsPlayerControlledCurrency: routeStatuses.filter((r) => r.acceptsPlayerControlledCurrency).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    totalRoutes: discovered.length,
    flaggedRoutes,
    routeStatuses,
    unmappedRoutes,
    summary,
  };
}
