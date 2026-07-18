"use client";

/**
 * FirebaseBoot — client-side Firebase initialization.
 *
 * Section I (Firebase & Backend).
 *
 * This component mounts once in the root layout and:
 *   1. Initializes the Firebase app (lazy, via `initFirebase()`).
 *   2. Initializes App Check (reCAPTCHA Enterprise) when configured.
 *   3. Initializes Remote Config + triggers the first fetch.
 *
 * It's a no-op on the server (all Firebase SDK calls are guarded by
 * `typeof window !== "undefined"`).
 */

import { useEffect } from "react";

export function FirebaseBoot() {
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Core app + Auth + Firestore + Analytics.
        const { initFirebase } = await import("@/lib/firebase");
        if (cancelled) return;
        await initFirebase();

        // App Check (reCAPTCHA Enterprise) — idempotent, no-op when
        // the site key is missing.
        const { initAppCheck } = await import("@/lib/app-check");
        if (cancelled) return;
        initAppCheck();

        // Remote Config — fetch the latest values non-blocking so the
        // menu can read flags on the first paint (with cached defaults)
        // and refresh them in the background.
        const { initRemoteConfig, refreshRemoteConfig } = await import(
          "@/lib/remote-config"
        );
        if (cancelled) return;
        initRemoteConfig();
        void refreshRemoteConfig().catch(() => {});

        console.log("[Firebase] initialized — project-reality-8966a");
      } catch (err) {
        console.error("[Firebase] initialization failed:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // The modular Firebase SDK is bundled via npm (the `firebase` package
  // imported in @/lib/firebase.ts) so this component renders no DOM —
  // it just runs the init side-effect on mount.
  return null;
}
