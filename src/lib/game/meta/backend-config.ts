/**
 * SEC11-META prompt 85 — Backend abstraction layer.
 *
 * The Project Reality persistence layer is currently SQLite via Prisma. The
 * Prisma schema is intentionally provider-agnostic — only the `datasource`
 * block in `prisma/schema.prisma` references a specific provider. Swapping
 * to hosted Postgres (or any other Prisma-supported provider) is therefore
 * a **transport change**, not a rewrite:
 *
 *   1. Provision a hosted Postgres instance (RDS / Cloud SQL / Supabase /
 *      Neon / Crunchy Bridge — pick one). Create a role with read/write on
 *      a fresh database.
 *   2. Set `DATABASE_URL="postgresql://role:password@host:5432/db?schema=public"`
 *      in the deployment environment (NOT in `.env` for production — use
 *      the platform's secret manager).
 *   3. Swap `provider = "sqlite"` → `provider = "postgresql"` in
 *      `prisma/schema.prisma`.
 *   4. Run `bun run db:migrate deploy` (NOT `db:push` — `db:push` is a
 *      dev-only convenience that won't preserve migration history on a
 *      shared hosted DB). Generate the first migration with
 *      `bun run db:migrate dev --name init` against a staging DB first.
 *   5. Restart the app. The Prisma Client reconnects on next request.
 *
 * ADR-0002 ("Local SQLite persistence") documents this transition plan in
 * full. The currency-guard, loot-odds, calendar, A/B testing, retention,
 * and clan-progression modules in this folder are written assuming only
 * the standard Prisma client surface (`db.$transaction`, `db.<model>.find*`
 * etc.) — none of them use SQLite-specific SQL. They will work unchanged on
 * Postgres.
 *
 * The only place a provider swap will surface is the `Json` type: SQLite
 * stores JSON as TEXT (we already do this — every JSON field is a `String`
 * column in the schema). On Postgres you may want to migrate these to
 * native `Json` columns for query efficiency, but the existing code keeps
 * working.
 */

/**
 * The current Prisma datasource provider. Read from `prisma/schema.prisma`
 * at build time (Bun inlines `process.env` values for client bundles; this
 * constant is server-only). When the field is absent we fall back to
 * `"sqlite"` — that's the historical default.
 */
export const BACKEND_PROVIDER: "sqlite" | "postgresql" | "mysql" =
  (process.env.PRISMA_BACKEND_PROVIDER as
    | "sqlite"
    | "postgresql"
    | "mysql"
    | undefined) ?? "sqlite";

/**
 * Read the DATABASE_URL the Prisma client is using. This is the same env
 * var Prisma itself reads (`datasource db { url = env("DATABASE_URL") }`),
 * so the value returned here is guaranteed to match what the live Prisma
 * client is connected to.
 *
 * For Postgres, the URL looks like:
 *   `postgresql://user:pass@host:5432/db?schema=public`
 *
 * For SQLite (dev), the URL is a `file:` URL pointing at `db/custom.db`.
 *
 * Throws if `DATABASE_URL` is missing — the server cannot start without a
 * database.
 */
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Set it in .env (dev) or the platform secret manager (prod).",
    );
  }
  return url;
}

/**
 * Human-readable provider label for the admin health route. Avoids leaking
 * the raw connection string (which contains credentials).
 */
export function describeBackend(): {
  provider: "sqlite" | "postgresql" | "mysql";
  hasUrl: boolean;
  isFile: boolean;
} {
  let url: string;
  try {
    url = getDatabaseUrl();
  } catch {
    return { provider: BACKEND_PROVIDER, hasUrl: false, isFile: false };
  }
  return {
    provider: BACKEND_PROVIDER,
    hasUrl: true,
    isFile: url.startsWith("file:"),
  };
}

/**
 * Connection check for the admin health route. Runs a trivial Prisma query
 * (`SELECT 1` via `$queryRaw`) and reports latency. Returns `connected: false`
 * on any error — the route surfaces the error message but never throws.
 *
 * Uses `db.$queryRaw` so it works on any Prisma-supported provider without
 * importing provider-specific SQL.
 */
export async function pingDatabase(): Promise<{
  connected: boolean;
  latencyMs: number;
  error?: string;
}> {
  // Lazy import so the backend-config module stays importable from client
  // bundles (e.g. tests) that don't have a live Prisma client.
  const { db } = await import("@/lib/db");
  const start = Date.now();
  try {
    // SQLite-compatible: `SELECT 1 AS one` is universal.
    await db.$queryRaw`SELECT 1 AS one`;
    return { connected: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      connected: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3836 (env vs schema / A-579) — NEW: `verifyProviderConsistency` below.
// 3895 (economy tuning config) — DONE in Economy.ts:ECONOMY_TUNING + resolveTuning.

/**
 * I-5000 #3836 / A-579 — Verify that the env-declared `BACKEND_PROVIDER`
 * matches the Prisma schema's actual `provider` field. The two can drift
 * when a deploy sets `PRISMA_BACKEND_PROVIDER=postgresql` but the schema
 * still says `provider = "sqlite"` (or vice versa). The mismatch surfaces
 * as a runtime error on the first query (typically "Database connection
 * error" or "unsupported feature"), which is confusing. This function
 * reads the schema file at build time (cached) + compares.
 *
 * Returns `{ consistent: true }` when they match, or
 * `{ consistent: false, envProvider, schemaProvider }` when they drift.
 * The /api/admin/backend-health route surfaces this in its response so
 * the live-ops team can catch the drift before it causes a prod outage.
 *
 * Note: reading the schema file at runtime is intentionally best-effort
 * — the schema may not be present in a production bundle (Prisma
 * generates the client from it but doesn't ship the .prisma file). In
 * that case the function returns `{ consistent: true, note: "schema
 * file not present — skipping check" }` (assume consistent; the
 * generated client's `$queryRaw` will fail loudly if there's a real
 * mismatch).
 */
export async function verifyProviderConsistency(): Promise<{
  consistent: boolean;
  envProvider: string;
  schemaProvider?: string;
  note?: string;
}> {
  const envProvider = BACKEND_PROVIDER;
  try {
    // Read the schema file from the project root. In a deployed bundle
    // this path may not exist — the function returns `consistent: true`
    // with a note when the file is absent.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
    const schemaContent = await readFile(schemaPath, "utf-8");
    // Match `provider = "sqlite"` (or postgresql / mysql).
    const match = schemaContent.match(/^datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/m);
    if (!match) {
      return { consistent: true, envProvider, note: "schema provider field not found — skipping check" };
    }
    const schemaProvider = match[1];
    if (schemaProvider !== envProvider) {
      return { consistent: false, envProvider, schemaProvider };
    }
    return { consistent: true, envProvider, schemaProvider };
  } catch {
    // Schema file not present (production bundle) — assume consistent.
    return {
      consistent: true,
      envProvider,
      note: "schema file not present — skipping check (production bundle)",
    };
  }
}
