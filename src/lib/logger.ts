/**
 * Structured logger — backlog §20 item 470.
 *
 * Tiny (no dependencies), level-filtered, env-configurable. Replaces the
 * scattered `console.error("[/api/foo] failed", err)` calls in the API
 * route handlers with a consistent prefix + level.
 *
 * Why not pino/winston? The API routes are mostly Next.js Route Handlers
 * running on the edge runtime (or Node), and most of them already
 * serialise to JSON via NextResponse. A heavyweight logger would pull in
 * node-only streams and break edge compatibility. This logger is ~70 LOC,
 * has no deps, and writes to stdout/stderr in a structured-ish format
 * (`[LEVEL] [route] msg` + optional JSON context).
 *
 * Levels (default `info`):
 *   - debug  → noisy per-request traces (only in dev).
 *   - info   → lifecycle events (server start, migrations, etc.).
 *   - warn   → recoverable but suspicious (rate-limit hit, fallback path).
 *   - error  → request failed, but server is still up.
 *
 * Config via `LOG_LEVEL` env var (case-insensitive). Defaults to `info`
 * in production, `debug` when `NODE_ENV === "development"`.
 *
 * Intentionally does NOT touch client/game code (perf-sensitive; the
 * game loop must not pay a function-call tax per frame). Use it in:
 *   - the API route handlers under src/app/api/.
 *   - server-side middleware / server actions.
 *   - scripts/ (optional — they often just use console directly).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function readConfiguredLevel(): LogLevel {
  const fromEnv = (typeof process !== "undefined" && process.env?.LOG_LEVEL?.toLowerCase()) as
    | LogLevel
    | undefined;
  if (fromEnv && LEVEL_ORDER[fromEnv] !== undefined) return fromEnv;
  // Default: debug in dev, info elsewhere.
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "development") {
    return "debug";
  }
  return "info";
}

let currentLevel: LogLevel = readConfiguredLevel();

/**
 * Override the configured level at runtime (test helper). Pass `undefined`
 * to reset back to the env-derived default.
 */
export function setLogLevel(level: LogLevel | undefined): void {
  currentLevel = level ?? readConfiguredLevel();
}

/** Current effective log level (mostly for tests / introspection). */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

interface LogContext {
  /** Free-form structured fields. JSON-serialised onto the log line. */
  [key: string]: unknown;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function emit(level: LogLevel, prefix: string | undefined, msg: string, ctx: LogContext | undefined): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const tag = prefix ? `[${prefix}]` : "";
  const ctxStr =
    ctx && Object.keys(ctx).length > 0
      ? " " + JSON.stringify(ctx)
      : "";
  const line = `${tag} ${msg}${ctxStr}`.trim();

  // error/warn → stderr; info/debug → stdout. (Server logs in many PaaS
  // platforms split stderr into the "error" stream for alerting.)
  if (level === "error" || level === "warn") {
    console[level === "error" ? "error" : "warn"](line);
  } else {
    console[level === "info" ? "info" : "log"](line);
  }
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /** Convenience: log an Error object with stack + optional context. */
  errorOf(err: unknown, msg?: string, ctx?: LogContext): void;
}

/**
 * Create a child logger with a fixed `[prefix]` tag — typically the API
 * route path, e.g. `createLogger("/api/shop/buy")`.
 */
export function createLogger(prefix: string): Logger {
  return {
    debug: (msg, ctx) => emit("debug", prefix, msg, ctx),
    info: (msg, ctx) => emit("info", prefix, msg, ctx),
    warn: (msg, ctx) => emit("warn", prefix, msg, ctx),
    error: (msg, ctx) => emit("error", prefix, msg, ctx),
    errorOf: (err, msg, ctx) =>
      emit("error", prefix, msg ?? "failed", {
        ...ctx,
        error: formatError(err),
      }),
  };
}

/**
 * Default root logger — no prefix. Prefer `createLogger("/api/foo")` so
 * the route path is visible in every line (saves a step when triaging
 * from logs).
 */
export const logger: Logger = createLogger("");
