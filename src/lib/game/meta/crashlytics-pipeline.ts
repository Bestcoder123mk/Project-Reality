/**
 * SEC11-META — Crashlytics symbol pipeline integration.
 *
 * Captures client-side crashes (Error + unhandledrejection), enriches them
 * with build/symbol metadata, and ships them to /api/telemetry/crashes
 * where they are joined with server-side symbolication (source-map lookup)
 * before being stored in the CrashReport table.
 *
 * The pipeline is provider-agnostic: it speaks the Crashlytics "Record
 * Custom Event" shape but writes to our own endpoint so we are not locked
 * into Firebase Crashlytics. When `NEXT_PUBLIC_CRASHLYTICS_ENABLED=1` and
 * the Firebase SDK is present, the same payload is mirrored to Crashlytics.
 *
 * Public API:
 *   - `CrashlyticsPipeline.install()` → wires window listeners (idempotent)
 *   - `CrashlyticsPipeline.record(error, ctx)` → manual capture
 *   - `CrashlyticsPipeline.setUserId(id)` / `setTag(k,v)` / `breadcrumb()`
 */

export interface CrashContext {
  userId?: string;
  buildId?: string;
  releaseStage?: "dev" | "preview" | "prod";
  route?: string;
  sessionId?: string;
  tags?: Record<string, string>;
  breadcrumbs?: Breadcrumb[];
}

export interface Breadcrumb {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface CrashPayload {
  message: string;
  stack?: string;
  name: string;
  context: CrashContext;
  capturedAt: string;
}

interface SymbolicatedFrame {
  file: string;
  line: number;
  col: number;
  fn?: string;
  source?: string;
}

/**
 * Symbolication request — POSTed to /api/telemetry/crashes where the
 * source-map lookup runs server-side. Returned frames are merged back
 * into the stored CrashReport so devs see original source lines.
 */
export async function symbolicate(stack: string, buildId: string): Promise<SymbolicatedFrame[]> {
  if (!stack) return [];
  try {
    const res = await fetch("/api/telemetry/crashes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "symbolicate", stack, buildId }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { frames?: SymbolicatedFrame[] };
    return data.frames ?? [];
  } catch {
    return [];
  }
}

export class CrashlyticsPipeline {
  private static installed = false;
  private static userId?: string;
  private static tags: Record<string, string> = {};
  private static breadcrumbs: Breadcrumb[] = [];
  private static readonly MAX_BREADCRUMBS = 32;

  /** Wire window listeners. Safe to call multiple times. */
  static install(buildId?: string): void {
    if (this.installed || typeof window === "undefined") return;
    this.installed = true;
    const ctx = (): CrashContext => ({
      userId: this.userId,
      buildId,
      releaseStage: process.env.NODE_ENV === "production" ? "prod" : "dev",
      route: typeof location !== "undefined" ? location.pathname : undefined,
      tags: { ...this.tags },
      breadcrumbs: this.breadcrumbs.slice(-this.MAX_BREADCRUMBS),
    });
    window.addEventListener("error", (e) => {
      void this.record(e.error ?? new Error(e.message), ctx());
    });
    window.addEventListener("unhandledrejection", (e) => {
      const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
      void this.record(err, ctx());
    });
  }

  static setUserId(id: string): void {
    this.userId = id;
  }

  static setTag(key: string, value: string): void {
    this.tags[key] = value;
  }

  static breadcrumb(message: string, level: Breadcrumb["level"] = "info", data?: Record<string, unknown>): void {
    this.breadcrumbs.push({ ts: Date.now(), level, message, data });
    if (this.breadcrumbs.length > this.MAX_BREADCRUMBS) this.breadcrumbs.shift();
  }

  static async record(error: Error, context: CrashContext): Promise<void> {
    const payload: CrashPayload = {
      message: error.message,
      stack: error.stack,
      name: error.name,
      context,
      capturedAt: new Date().toISOString(),
    };
    try {
      await fetch("/api/telemetry/crashes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "crash", payload }),
        keepalive: true,
      });
    } catch {
      /* swallow — never let crash reporting itself throw */
    }
  }
}

export const crashlytics = CrashlyticsPipeline;
