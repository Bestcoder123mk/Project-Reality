/**
 * Firebase client initialization.
 *
 * This module initializes the Firebase JS SDK with the project config
 * and exports the core services (app, analytics, firestore, auth).
 *
 * The config is safe to expose to the client — Firebase web config is
 * NOT a secret. Security is enforced by Firestore Security Rules
 * (firestore.rules) + Firebase Auth, not by hiding the config.
 *
 * Usage in any client component:
 *   import { db, auth } from "@/lib/firebase";
 *   const playerDoc = await getDoc(doc(db, "players", uid));
 */

import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAnalytics, isSupported, type Analytics } from "firebase/analytics";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getAuth, type Auth } from "firebase/auth";

/**
 * Firebase project configuration for project-reality-8966a.
 *
 * These values are public (safe to ship in client JS). Real security
 * comes from Firestore Security Rules (see firestore.rules) which
 * enforce that a player can only read/write their own documents.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBVi4uGY5Dh-nirII9nphF1qLD_slQ-QN0",
  authDomain: "project-reality-8966a.firebaseapp.com",
  projectId: "project-reality-8966a",
  storageBucket: "project-reality-8966a.firebasestorage.app",
  messagingSenderId: "316380274193",
  appId: "1:316380274193:web:9de1a193f5e2fd22ecdbb0",
  measurementId: "G-RMHM6D0EXF",
};

// Initialize Firebase app (singleton — safe to call multiple times).
let _app: FirebaseApp | null = null;
let _firestore: Firestore | null = null;
let _auth: Auth | null = null;
let _analytics: Analytics | null = null;

/**
 * Get the Firebase app instance (lazy-init on first call).
 * Returns null on the server (Firebase is browser-only).
 */
export function getFirebaseApp(): FirebaseApp | null {
  if (typeof window === "undefined") return null;
  if (!_app) {
    _app = initializeApp(firebaseConfig);
  }
  return _app;
}

/**
 * Get the Firestore instance (lazy-init on first call).
 * Returns null on the server.
 */
export function getDb(): Firestore | null {
  if (typeof window === "undefined") return null;
  if (!_firestore) {
    const app = getFirebaseApp();
    if (!app) return null;
    _firestore = getFirestore(app);
  }
  return _firestore;
}

/**
 * Get the Firebase Auth instance (lazy-init on first call).
 * Returns null on the server.
 */
export function getFirebaseAuth(): Auth | null {
  if (typeof window === "undefined") return null;
  if (!_auth) {
    const app = getFirebaseApp();
    if (!app) return null;
    _auth = getAuth(app);
  }
  return _auth;
}

/**
 * Get the Analytics instance (lazy-init, browser-only).
 * Analytics is optional — it fails gracefully if cookies are blocked.
 */
export async function getFirebaseAnalytics(): Promise<Analytics | null> {
  if (typeof window === "undefined") return null;
  if (_analytics) return _analytics;
  try {
    const supported = await isSupported();
    if (!supported) return null;
    const app = getFirebaseApp();
    if (!app) return null;
    _analytics = getAnalytics(app);
    return _analytics;
  } catch {
    // Analytics not supported (e.g. private browsing, blocked cookies).
    return null;
  }
}

/**
 * Convenience exports for direct import.
 * These are null on the server; call the getters above for SSR-safe access.
 */
export const app = typeof window !== "undefined" ? getFirebaseApp() : null;
export const db = typeof window !== "undefined" ? getDb() : null;
export const auth = typeof window !== "undefined" ? getFirebaseAuth() : null;

/**
 * Initialize Firebase on the client side.
 * Call this from a useEffect in the root layout.
 */
export async function initFirebase(): Promise<void> {
  if (typeof window === "undefined") return;
  getFirebaseApp();
  getDb();
  getFirebaseAuth();
  await getFirebaseAnalytics();
}
