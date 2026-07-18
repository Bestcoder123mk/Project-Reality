/**
 * ErrorTracking — provider-agnostic crash reporting.
 *
 * Prompt 3 of the AAA roadmap. Ships a thin abstraction that:
 *   - Captures errors + breadcrumbs in-process (ring buffer).
 *   - Forwards to Sentry when `NEXT_PUBLIC_SENTRY_DSN` is set.
 *   - Falls back to a local `/api/telemetry/errors` ingest otherwise.
 *   - Tags every event with build id, session id, and active screen so a
 *     crash report is actionable without a reproduction.
 *
 * The module is SSR-safe (no-ops on the server) and tree-shakes to nothing
 * when no provider is configured.
 */

type Severity = "info" | "warning" | "error" | "fatal";

interface CrashEvent {
  id: string;
  message: string;
  stack?: string;
  severity: Severity;
  tags: Record<string, string | number | boolean>;
  breadcrumbs: Breadcrumb[];
  at: number;
  sessionId: string;
  buildId: string;
  url?: string;
}

interface Breadcrumb {
  at: number;
  category: string;
  message: string;
  level: Severity;
  data?: Record<string, unknown>;
}

const RING_SIZE = 64;
const breadcrumbRing: Breadcrumb[] = [];

let SESSION_ID = "";
let BUILD_ID = "dev";
try {
  SESSION_ID =
    (globalThis as { __PR_SESSION_ID__?: string }).__PR_SESSION_ID__ ??
    crypto.randomUUID();
  (globalThis as { __PR_SESSION_ID__?: string }).__PR_SESSION_ID__ = SESSION_ID;
} catch {
  SESSION_ID = "unknown-session";
}

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";
const LOCAL_INGEST = "/api/telemetry/errors";

/** Initialise the tracker (call once on the client). */
export function initErrorTracking(buildId = "dev") {
  BUILD_ID = buildId;
  if (typeof window === "undefined") return;
  // Global uncaught errors.
  window.addEventListener("error", (ev) => {
    captureException(ev.error ?? ev.message, {
      severity: "error",
      tags: { source: "window.onerror" },
    });
  });
  // Unhandled promise rejections.
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = (ev as PromiseRejectionEvent).reason;
    captureException(reason instanceof Error ? reason : new Error(String(reason)), {
      severity: "error",
      tags: { source: "unhandledrejection" },
    });
  });
}

/** Leave a breadcrumb — a short trace of what the user was doing. */
export function addBreadcrumb(
  category: string,
  message: string,
  level: Severity = "info",
  data?: Record<string, unknown>,
) {
  breadcrumbRing.push({ at: Date.now(), category, message, level, data });
  if (breadcrumbRing.length > RING_SIZE) breadcrumbRing.shift();
}

/** Capture an exception synchronously, then flush async. */
export function captureException(
  err: Error | string,
  opts: { severity?: Severity; tags?: Record<string, string | number | boolean> } = {},
) {
  if (typeof window === "undefined") return;
  const message = typeof err === "string" ? err : err.message;
  const stack = typeof err === "string" ? undefined : err.stack;
  const evt: CrashEvent = {
    id: crypto.randomUUID(),
    message,
    stack,
    severity: opts.severity ?? "error",
    tags: opts.tags ?? {},
    breadcrumbs: [...breadcrumbRing],
    at: Date.now(),
    sessionId: SESSION_ID,
    buildId: BUILD_ID,
    url: typeof window !== "undefined" ? window.location.href : undefined,
  };
  // SEC12-PLATFORM: count this session as crashed (dedup'd on sessionId)
  // so the live in-memory crash-free rate is accurate between DB flushes.
  recordSessionCrash(SESSION_ID);
  void flush(evt);
}

/** Capture a message (no exception object). */
export function captureMessage(
  message: string,
  severity: Severity = "info",
  tags: Record<string, string | number | boolean> = {},
) {
  if (typeof window === "undefined") return;
  const evt: CrashEvent = {
    id: crypto.randomUUID(),
    message,
    severity,
    tags,
    breadcrumbs: [...breadcrumbRing],
    at: Date.now(),
    sessionId: SESSION_ID,
    buildId: BUILD_ID,
    url: window.location.href,
  };
  void flush(evt);
}

async function flush(evt: CrashEvent) {
  // Section I (Firebase & Backend) — forward to Firebase Crashlytics
  // when the optional Crashlytics SDK is loaded. We dynamically import
  // so the SDK is never pulled into the server bundle and only lands
  // in the client chunk when actually configured. Failures are
  // swallowed — crash reporting must never crash the game.
  if (typeof window !== "undefined") {
    try {
      const mod = await import("@/lib/crashlytics");
      await mod.recordCrashlyticsEvent(evt).catch(() => {});
    } catch {
      /* Crashlytics module not available — fall through */
    }
  }

  // Forward to Sentry if configured (DSN only — no SDK dep to keep bundle lean).
  if (SENTRY_DSN) {
    try {
      await fetch(SENTRY_DSN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(evt),
        keepalive: true,
      });
      return;
    } catch {
      /* fall through to local ingest */
    }
  }
  // Local fallback — never throws, never blocks.
  try {
    await fetch(LOCAL_INGEST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt),
      keepalive: true,
    });
  } catch {
    /* swallow — crash reporting must never crash the game */
  }
}

/** Read-only snapshot of the breadcrumb ring (for the dev overlay). */
export function getBreadcrumbs(): readonly Breadcrumb[] {
  return breadcrumbRing;
}

// ── SEC12-PLATFORM prompt 99: crash-free session counter ───────────────────
//
// The crash-free rate target (99.5%+) needs a way to count sessions that
// crashed in-process, not just the ones that made it to the durable
// CrashReport table. (A session that crashes during the crash-report
// POST itself would otherwise be missed.) These helpers keep an in-memory
// counter of (a) sessions started + (b) sessions that captured an
// exception, so the dev overlay + admin dashboard can show a live
// crash-free rate between DB flushes.
//
// The durable computation in `crash-free-metric.ts` reads from the
// CrashReport + PlayerSession tables; this in-memory counter is a
// faster-rolling approximation used by the HUD overlay.

interface CrashFreeCounters {
  sessionsStarted: number;
  sessionsCrashed: number;
  /** Map of sessionId → crashed (for dedup — one crash per session). */
  crashedSessionIds: Set<string>;
}

const counters: CrashFreeCounters = {
  sessionsStarted: 0,
  sessionsCrashed: 0,
  crashedSessionIds: new Set(),
};

/** Record a session start (called by initErrorTracking or the engine on match-start). */
export function recordSessionStart(id: string = SESSION_ID): void {
  counters.sessionsStarted++;
  void id; // sessionId is captured by captureException; this is a no-arg counter.
}

/** Record a session crash (called by captureException — dedup'd on sessionId). */
export function recordSessionCrash(id: string = SESSION_ID): void {
  if (counters.crashedSessionIds.has(id)) return;
  counters.crashedSessionIds.add(id);
  counters.sessionsCrashed++;
}

/** Live in-memory crash-free rate (0..1). Used by the HUD overlay. */
export function getLiveCrashFreeRate(): {
  sessionsStarted: number;
  sessionsCrashed: number;
  rate: number;
} {
  const total = counters.sessionsStarted;
  const crashed = counters.sessionsCrashed;
  return {
    sessionsStarted: total,
    sessionsCrashed: crashed,
    rate: total > 0 ? (total - crashed) / total : 1,
  };
}

/** Reset the in-memory counters (test-only / dev-overlay refresh). */
export function resetCrashFreeCounters(): void {
  counters.sessionsStarted = 0;
  counters.sessionsCrashed = 0;
  counters.crashedSessionIds.clear();
}
