/**
 * Auth — Firebase Authentication wrappers + Google Sign-in.
 *
 * Section I (Firebase & Backend) — primary auth surface for the game.
 *
 * This module wraps the modular Firebase Auth SDK so callers don't have
 * to touch `firebase/auth` directly. Every call is SSR-safe (no-ops on
 * the server) and lazy-initializes the underlying Auth instance on the
 * first call (see `@/lib/firebase`).
 *
 * Public API:
 *   - `signInWithGoogle()` — official GoogleAuthProvider + popup
 *   - `signInAnonymously()` — for the "Continue as guest" path
 *   - `signOutUser()` — sign out
 *   - `onAuthChange(cb)` — auth state listener (returns unsubscribe fn)
 *   - `getCurrentUser()` — synchronous current user snapshot
 *   - `getCurrentUserIdToken()` — for sending to server APIs as a bearer
 *   - `ensurePlayerDocument()` — Firestore `players/{uid}` auto-create
 *
 * Firestore is the source of truth for the public player profile (display
 * name, level, credits, owned items). Prisma (SQLite) stays as a server-
 * side cache for the heavy relational inventory / loadout / battle-pass
 * queries; the Firebase `uid` is the join key. See `@/lib/cloud-save`.
 */

import {
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously as fbSignInAnonymously,
  signOut as fbSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  type User as FirebaseUser,
  type Unsubscribe,
} from "firebase/auth";

import { getFirebaseAuth, getDb } from "@/lib/firebase";
import { ensurePlayerDocument } from "@/lib/firestore";

// Re-export so callers can grab the type from a single import.
export type { FirebaseUser };

/** Official Google OAuth provider — uses the standard Google branding. */
export function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  // Request profile + email scopes (default Google scopes — see
  // https://firebase.google.com/docs/auth/web/google-signin).
  provider.addScope("profile");
  provider.addScope("email");
  // Force account chooser so the player sees their Google account picker
  // every time (matches the user expectation for "Sign in with Google").
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

/** Result of a sign-in attempt. */
export interface SignInResult {
  ok: boolean;
  user?: FirebaseUser;
  error?: string;
  /** Error code from Firebase Auth (e.g. "auth/popup-closed-by-user"). */
  code?: string;
}

/**
 * Sign in with Google using a popup. This is the official Google Sign-in
 * flow — uses `GoogleAuthProvider` from `firebase/auth` (NOT a custom
 * implementation). The popup closes itself on success.
 *
 * On success: ensures the player's Firestore document exists (creates it
 * on first sign-in) and returns the user.
 *
 * On failure: returns `{ ok: false, error, code }` — never throws.
 */
export async function signInWithGoogle(): Promise<SignInResult> {
  const auth = getFirebaseAuth();
  if (!auth) {
    return { ok: false, error: "Firebase Auth not available (SSR?)" };
  }
  try {
    await setPersistence(auth, browserLocalPersistence);
    const provider = googleProvider();
    const cred = await signInWithPopup(auth, provider);
    // Auto-create / link the Firestore player document on first sign-in.
    try {
      await ensurePlayerDocument(cred.user);
    } catch (err) {
      // Non-fatal — the player can still play; cloud save will retry.
      console.warn("[auth] ensurePlayerDocument failed:", err);
    }
    return { ok: true, user: cred.user };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "auth/unknown";
    const message =
      err instanceof Error ? err.message : "Google sign-in failed";
    return { ok: false, error: message, code };
  }
}

/**
 * Continue as guest — anonymous auth. The player gets a UID (so cloud
 * save + Firestore still work) but no email/password/Google identity.
 *
 * They can later link a Google account (via `linkWithPopup`) to upgrade
 * the anonymous account to a permanent one — preserving all progress.
 */
export async function signInAnonymously(): Promise<SignInResult> {
  const auth = getFirebaseAuth();
  if (!auth) {
    return { ok: false, error: "Firebase Auth not available (SSR?)" };
  }
  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await fbSignInAnonymously(auth);
    try {
      await ensurePlayerDocument(cred.user);
    } catch (err) {
      console.warn("[auth] ensurePlayerDocument failed:", err);
    }
    return { ok: true, user: cred.user };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "auth/unknown";
    const message =
      err instanceof Error ? err.message : "Anonymous sign-in failed";
    return { ok: false, error: message, code };
  }
}

/** Sign out the current user. No-ops on the server. */
export async function signOutUser(): Promise<void> {
  const auth = getFirebaseAuth();
  if (!auth) return;
  try {
    await fbSignOut(auth);
  } catch (err) {
    console.error("[auth] sign-out failed:", err);
  }
}

/** Auth state listener — wraps onAuthStateChanged. SSR-safe. */
export function onAuthChange(
  callback: (user: FirebaseUser | null) => void,
): Unsubscribe {
  const auth = getFirebaseAuth();
  if (!auth) {
    // SSR or no auth — emit null once and return a no-op unsubscribe.
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

/** Synchronous current user snapshot. Null on the server or signed-out. */
export function getCurrentUser(): FirebaseUser | null {
  const auth = getFirebaseAuth();
  if (!auth) return null;
  return auth.currentUser;
}

/**
 * Get the current user's ID token (JWT) for sending to server APIs as
 * `Authorization: Bearer <token>`. Server-side route handlers can
 * verify this token with the Firebase Admin SDK.
 *
 * Returns null on the server or when signed out.
 */
export async function getCurrentUserIdToken(
  forceRefresh = false,
): Promise<string | null> {
  const user = getCurrentUser();
  if (!user) return null;
  try {
    return await user.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

/**
 * Convenience: returns true when the current user has a Google provider
 * in their `providerData` (i.e. they signed in with Google, not guest).
 */
export function isGoogleUser(user: FirebaseUser | null): boolean {
  if (!user) return false;
  return user.providerData.some((p) => p.providerId === "google.com");
}

/**
 * Fetch helper that injects the Firebase ID token as a Bearer header.
 * Falls back to a plain fetch when signed out (so legacy Prisma-only
 * flows still work for guests).
 */
export async function authedFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getCurrentUserIdToken();
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(input, { ...init, headers });
}

/** Use session-only persistence (cleared on tab close). Used by the
 *  "remember me" toggle in the sign-in screen. */
export async function useSessionPersistence(): Promise<void> {
  const auth = getFirebaseAuth();
  if (!auth) return;
  await setPersistence(auth, browserSessionPersistence);
}

/** Use local persistence (default — survives browser restarts). */
export async function useLocalPersistence(): Promise<void> {
  const auth = getFirebaseAuth();
  if (!auth) return;
  await setPersistence(auth, browserLocalPersistence);
}
