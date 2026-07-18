/**
 * App Check — Firebase App Check with reCAPTCHA Enterprise.
 *
 * Section I (Firebase & Backend).
 *
 * App Check protects server resources (Cloud Functions, Firestore,
 * Cloud Storage) from abuse by attaching a short-lived attestation
 * token to every request. The token is minted client-side by a
 * registered provider (reCAPTCHA Enterprise for the web) and verified
 * server-side by the Firebase Admin SDK / Firestore Security Rules.
 *
 * Setup (one-time, in the Firebase console):
 *   1. Enable App Check in the Firebase console.
 *   2. Register the web app with reCAPTCHA Enterprise (Site Key).
 *   3. Add the site key to `NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY`.
 *   4. Enforce App Check on Firestore / Functions / Storage.
 *
 * This module is SSR-safe and never throws — when the site key is
 * missing or App Check is not configured, calls fall back to no-op so
 * the game still works in dev.
 *
 * Public API:
 *   - `initAppCheck()` — call once on the client (lazy)
 *   - `getAppCheckToken()` — for debugging / manual attach
 *   - `appCheckEnabled` — boolean (false in dev when key missing)
 */

import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  getToken,
  type AppCheck as FirebaseAppCheck,
} from "firebase/app-check";

import { getFirebaseApp } from "@/lib/firebase";

let _appCheck: FirebaseAppCheck | null = null;
let _initAttempted = false;

/** True when a reCAPTCHA Enterprise site key is configured. */
export const appCheckEnabled = Boolean(
  process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY,
);

/**
 * Initialize App Check on the client. Idempotent — safe to call from
 * a useEffect. Returns the AppCheck instance (or null on the server
 * / when not configured).
 *
 * A debug token is printed to the console in dev so you can register
 * it in the Firebase console (App Check → Apps → Manage debug tokens)
 * for local testing without a real reCAPTCHA score.
 */
export function initAppCheck(): FirebaseAppCheck | null {
  if (typeof window === "undefined") return null;
  if (_appCheck) return _appCheck;
  if (_initAttempted) return null;
  _initAttempted = true;

  const app = getFirebaseApp();
  if (!app) return null;

  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY;
  if (!siteKey) {
    if (process.env.NODE_ENV !== "production") {
      console.info(
        "[AppCheck] NEXT_PUBLIC_RECAPTCHA_ENTERPRISE_SITE_KEY not set — App Check disabled in dev.",
      );
    }
    return null;
  }

  try {
    // In dev, register a debug provider so the token is print-token-based
    // (not a real reCAPTCHA score). The debug token is logged once; paste
    // it into the Firebase console to allowlist it.
    if (process.env.NODE_ENV !== "production") {
      // @ts-expect-error — Firebase reads this global to enable debug tokens.
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    _appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    return _appCheck;
  } catch (err) {
    console.error("[AppCheck] init failed:", err);
    return null;
  }
}

/**
 * Force-refresh and return the current App Check token. Useful for
 * attaching to a custom fetch when calling a Cloud Function directly.
 */
export async function getAppCheckToken(): Promise<string | null> {
  if (!_appCheck) initAppCheck();
  if (!_appCheck) return null;
  try {
    const { token } = await getToken(_appCheck, /* forceRefresh */ false);
    return token;
  } catch (err) {
    console.error("[AppCheck] getToken failed:", err);
    return null;
  }
}

/**
 * Fetch wrapper that injects the App Check token as the
 * `X-Firebase-AppCheck` header. Cloud Functions + Firestore Security
 * Rules can verify this server-side.
 */
export async function appCheckFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getAppCheckToken();
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set("X-Firebase-AppCheck", token);
  return fetch(input, { ...init, headers });
}
