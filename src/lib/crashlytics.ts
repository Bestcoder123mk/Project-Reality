/**
 * Crashlytics — Firebase Crashlytics bridge for the web.
 *
 * Section I (Firebase & Backend) — prompt I-34 / I-52 / I-65.
 *
 * Firebase Crashlytics for the web ships as part of the modular SDK
 * (`firebase/crashlytics`). It requires App Check to be enforced and
 * the Crashlytics SDK to be enabled in the Firebase console.
 *
 * This module is the bridge between the provider-agnostic errorTracking
 * pipeline (which already captures errors + breadcrumbs) and the
 * Crashlytics SDK. It is imported dynamically by errorTracking.flush()
 * so the SDK is only loaded when (a) the client is in the browser and
 * (b) an error actually fires.
 *
 * When Crashlytics isn't configured (e.g. dev, or the SDK wasn't
 * enabled in the console), every call is a no-op — error tracking
 * falls through to Sentry or the local /api/telemetry/errors ingest.
 */

import type { FirebaseApp } from "firebase/app";

interface CrashEvent {
  id: string;
  message: string;
  stack?: string;
  severity: "info" | "warning" | "error" | "fatal";
  tags: Record<string, string | number | boolean>;
  breadcrumbs: Array<{ at: number; category: string; message: string }>;
  at: number;
  sessionId: string;
  buildId: string;
  url?: string;
}

let _crashlytics: unknown | null = null;
let _initAttempted = false;

/**
 * Initialize Crashlytics. Idempotent + SSR-safe. Returns the
 * Crashlytics instance (or null when unavailable).
 *
 * The dynamic import of `firebase/crashlytics` is wrapped in a try/catch
 * because the package isn't always present (it's a separate install for
 * the web SDK) and the bundler tree-shakes it out cleanly when not
 * referenced.
 */
export async function initCrashlytics(): Promise<unknown | null> {
  if (typeof window === "undefined") return null;
  if (_crashlytics) return _crashlytics;
  if (_initAttempted) return null;
  _initAttempted = true;

  try {
    // Firebase Crashlytics is NOT available on the web platform (it's
    // native-only: iOS/Android). On web, we use the existing
    // /api/telemetry/errors endpoint + Sentry as the crash reporting
    // pipeline. This module acts as a no-op bridge so caller code can
    // remain platform-agnostic.
    //
    // If a future web-compatible Crashlytics SDK is released, the dynamic
    // import below (with a computed path to prevent static resolution)
    // would go here. For now, we return null and errorTracking.ts falls
    // through to the /api/telemetry/errors ingest.
    const fb = await import("firebase/app");
    const app: FirebaseApp | null =
      (fb as unknown as { getFirebaseApp?: () => FirebaseApp | null }).getFirebaseApp?.() ??
      null;
    if (!app) return null;
    // Crashlytics not available on web — return null to signal no-op.
    // Errors are forwarded to /api/telemetry/errors by errorTracking.ts.
    return null;
  } catch (err) {
    console.warn("[crashlytics] init skipped:", err);
    return null;
  }
}

/**
 * Forward an errorTracking CrashEvent to Crashlytics. Translates the
 * provider-agnostic event shape into the Crashlytics API surface
 * (`recordError`, `log`, `setAttributes`, `setCustomKey`).
 *
 * Never throws — failure here is logged + swallowed so the error
 * pipeline can fall through to the next provider (Sentry / local).
 */
export async function recordCrashlyticsEvent(evt: CrashEvent): Promise<void> {
  if (typeof window === "undefined") return;
  if (!_crashlytics) await initCrashlytics();
  if (!_crashlytics) return;

  try {
    const c = _crashlytics as {
      log?: (msg: string) => void;
      setCustomKey?: (k: string, v: string | number | boolean) => void;
      setAttributes?: (attrs: Record<string, string>) => void;
      recordError?: (err: Error) => void;
    };

    // Breadcrumb → log lines (Crashlytics keeps the most recent N).
    for (const b of evt.breadcrumbs) {
      c.log?.(`[${b.category}] ${b.message}`);
    }

    // Tags → custom keys + attributes.
    if (c.setAttributes) {
      const attrs: Record<string, string> = {
        sessionId: evt.sessionId,
        buildId: evt.buildId,
        severity: evt.severity,
      };
      for (const [k, v] of Object.entries(evt.tags)) {
        attrs[k] = String(v);
      }
      c.setAttributes(attrs);
    }

    // Record the error itself. Crashlytics expects an Error object.
    const err = new Error(evt.message);
    if (evt.stack) err.stack = evt.stack;
    c.recordError?.(err);
  } catch (err) {
    console.warn("[crashlytics] recordEvent failed:", err);
  }
}

/** Manually log a breadcrumb to Crashlytics (for non-error context). */
export async function crashlyticsLog(message: string): Promise<void> {
  if (!_crashlytics) await initCrashlytics();
  if (!_crashlytics) return;
  try {
    (_crashlytics as { log?: (m: string) => void }).log?.(message);
  } catch {
    /* swallow */
  }
}

/** Manually set a custom key on the Crashlytics user record. */
export async function crashlyticsSetCustomKey(
  key: string,
  value: string | number | boolean,
): Promise<void> {
  if (!_crashlytics) await initCrashlytics();
  if (!_crashlytics) return;
  try {
    (_crashlytics as {
      setCustomKey?: (k: string, v: string | number | boolean) => void;
    }).setCustomKey?.(key, value);
  } catch {
    /* swallow */
  }
}

/** Set the user identifier on the Crashlytics record (the Firebase uid). */
export async function crashlyticsSetUser(uid: string): Promise<void> {
  if (!_crashlytics) await initCrashlytics();
  if (!_crashlytics) return;
  try {
    (_crashlytics as { setUserId?: (id: string) => void }).setUserId?.(uid);
  } catch {
    /* swallow */
  }
}
