import { PrismaClient } from '@prisma/client'

// SEC12-PLATFORM: bump this comment to force Next.js HMR to re-evaluate
// the module after a `db:push` regenerates @prisma/client with new models.
// Without this, the dev-server's cached PrismaClient class stays stale
// (it was imported before prisma generate ran) + the new models
// (bugReport, supportTicket) are undefined on the fresh client instance.
const __PRISMA_CLIENT_REV = 3

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  __prismaClientRev?: number
}

// SEC12-PLATFORM: detect a stale cached PrismaClient. When the schema
// gains new models mid-dev-session (db:push + prisma generate run while
// the dev server is up), the globalThis.prisma singleton is still an
// instance of the OLD PrismaClient class — so calls to the new models
// (db.bugReport, db.supportTicket, db.playerSession, etc.) hit
// `undefined`. This check verifies the cached client has a known-new
// model + recreates it when missing. Dev-only; production builds always
// construct a fresh client at boot.
function makeFreshClient(): PrismaClient {
  // Task-1 (SEC) item 19 — Prisma log filter.
  //
  // Prisma's default `query` log level prints every query to stdout.
  // That's fine in dev (surfaces slow queries) but in production it
  // floods the logs + can leak the DATABASE_URL via connection-error
  // messages (PrismaClientInitializationError.message contains the
  // full URL with credentials when Postgres/MySQL refuses auth).
  //
  // Mitigations:
  //
  //   1. In production, log only `warn` + `error` (not `query`).
  //   2. Use a custom `emit` function that pipes every message through
  //      `scrubDatabaseUrl()` so even an `error` log line never
  //      contains the raw connection string.
  //   3. Export `scrubDatabaseUrl` + `scrubObjectOfDatabaseUrl` so
  //      `errorTracking.ts` can scrub the same way before persisting
  //      a CrashReport row.
  const isProd = process.env.NODE_ENV === "production";
  return new PrismaClient({
    log: [
      { level: "warn", emit: "stdout" },
      {
        level: "error",
        emit: "stdout",
      },
      ...(isProd
        ? []
        : [{ level: "query" as const, emit: "stdout" as const }]),
    ],
  });
}

/**
 * Replace any `DATABASE_URL`-shaped string in `s` with a redacted form.
 *
 *   "postgresql://user:pass@host:5432/db?schema=public"
 *   → "postgresql://***:***@host:5432/db"
 *
 *   "file:/home/z/my-project/db/custom.db"
 *   → "file:/home/z/my-project/db/custom.db"  (file URLs have no creds)
 *
 * Used by `errorTracking.ts` so a thrown Prisma error never leaks the
 * connection string into the CrashReport table or Sentry.
 */
export function scrubDatabaseUrl(s: string): string {
  if (!s) return s;
  // Match `protocol://user:pass@host[:port]/path` or `protocol://user:pass@host[:port]`.
  return s.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+)(:[^\s@/]+)?(@[^\s/]+)/gi,
    (_m, proto, _user, _pass, host) => `${proto}***:***${host}`,
  );
}

/**
 * Scrub the DATABASE_URL out of any object — used by error serializers
 * (errorTracking.ts) before sending an error to Sentry / the CrashReport
 * table. Walks the object recursively + replaces any string that looks
 * like a connection string.
 */
export function scrubObjectOfDatabaseUrl<T>(obj: T): T {
  if (typeof obj === "string") return scrubDatabaseUrl(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map(scrubObjectOfDatabaseUrl) as unknown as T;
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // Also redact common env-var keys that hold connection strings.
      const lk = k.toLowerCase();
      if (
        (lk.includes("database_url") || lk === "url" || lk === "datasource") &&
        typeof v === "string"
      ) {
        out[k] = scrubDatabaseUrl(v);
      } else {
        out[k] = scrubObjectOfDatabaseUrl(v);
      }
    }
    return out as unknown as T;
  }
  return obj;
}

function isStaleClient(c: PrismaClient | undefined): boolean {
  if (!c) return true
  // Probe for a model that was added after the original dev-server boot.
  // `playerSession` was added by SEC11; `bugReport` + `supportTicket` by
  // SEC12; `auditLog` + `usedNonce` + `cheatFlag` by Task-1 (SEC). If any
  // is missing, the cached client predates the current schema + must be
  // recreated.
  return (
    (c as unknown as { playerSession?: unknown }).playerSession === undefined ||
    (c as unknown as { bugReport?: unknown }).bugReport === undefined ||
    (c as unknown as { auditLog?: unknown }).auditLog === undefined ||
    (c as unknown as { usedNonce?: unknown }).usedNonce === undefined ||
    (c as unknown as { cheatFlag?: unknown }).cheatFlag === undefined
  )
}

let db: PrismaClient
if (process.env.NODE_ENV !== 'production') {
  // Also force re-creation when the module-rev changed (post db:push HMR).
  const revMismatch = globalForPrisma.__prismaClientRev !== __PRISMA_CLIENT_REV
  if (globalForPrisma.prisma && !isStaleClient(globalForPrisma.prisma) && !revMismatch) {
    db = globalForPrisma.prisma
  } else {
    const fresh = makeFreshClient()
    console.log(
      '[db.ts] recreating PrismaClient — fresh client has playerSession:',
      (fresh as unknown as { playerSession?: unknown }).playerSession !== undefined,
      'has bugReport:',
      (fresh as unknown as { bugReport?: unknown }).bugReport !== undefined,
      'rev:',
      __PRISMA_CLIENT_REV,
    )
    db = fresh
    globalForPrisma.prisma = db
    globalForPrisma.__prismaClientRev = __PRISMA_CLIENT_REV
  }
} else {
  db = makeFreshClient()
}

export { db }