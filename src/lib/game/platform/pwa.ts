/**
 * L1-5000 / prompts 4458,4459,4516,4517,4570,4571,4608,4609,4646,4647,4684,4685,4722,4723: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4760,4761,4798,4799,4836,4837,4874,4875,4912,4913,4950,4951,4988,4989 (PWA + Offline): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * Prompt I-979 — OTA update for the PWA.
 * Prompt I-985 — PWA install (manifest).
 * Prompt I-986 — Offline mode (service worker caching).
 *
 * The PWA manifest already exists at `public/manifest.json` (prompt 111)
 * and is linked from `src/app/layout.tsx`. This module handles the
 * runtime side:
 *
 *   - `registerServiceWorker()` — registers `/sw.js` on the client.
 *     The service worker caches the app shell (HTML/JS/CSS) + the
 *     static assets, so the game boots offline after the first visit.
 *     On reconnect, the SW fetches the new bundle in the background
 *     + signals the page via `controllerchange` so we can prompt the
 *     player to reload for the OTA update.
 *   - `onOtaUpdate(callback)` — fires when a new SW takes over. The
 *     UI shows a toast "Update available — reload to apply." Clicking
 *     reload applies the new bundle.
 *   - `isPwaInstalled()` — true when the page was launched from the
 *     installed PWA (display-mode: standalone) — used to hide the
 *     "Install app" prompt after install.
 *   - `promptInstall()` — calls `beforeinstallprompt` (Chrome only).
 *     Returns false on browsers that don't expose the prompt.
 *   - `isOnline()` / `onOnlineStatusChange(cb)` — for the offline-mode
 *     indicator in the HUD.
 *
 * SSR-safe: every function no-ops on the server.
 */

const SW_URL = "/sw.js";
const SW_SCOPE = "/";

let installEvent: BeforeInstallPromptEvent | null = null;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Register the service worker. Idempotent — safe to call multiple times.
 * Returns true if registration succeeded (or already existed).
 */
export function registerServiceWorker(): boolean {
  if (typeof window === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  // Don't register in dev — Next dev hot-reloads break SW caching.
  if (process.env.NODE_ENV !== "production") return false;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e as BeforeInstallPromptEvent;
  });
  navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch(() => {
    // Registration failure is non-fatal — the app still works online.
  });
  return true;
}

/**
 * Prompt I-979 — Subscribe to OTA updates. The callback fires when a
 * new service worker has installed + taken over (i.e. a new bundle
 * was deployed). The UI shows a "reload to update" toast.
 */
export function onOtaUpdate(callback: () => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return () => {};
  }
  const onControllerChange = () => {
    // The new SW has taken over — only fire once per page session.
    callback();
  };
  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  return () => {
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  };
}

/** True when the page is running as an installed PWA. */
export function isPwaInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari standalone flag.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * Prompt I-985 — Trigger the browser's "Add to Home Screen" prompt.
 * Returns true when the prompt was shown + the user accepted.
 */
export async function promptInstall(): Promise<boolean> {
  if (!installEvent) return false;
  try {
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    return choice.outcome === "accepted";
  } catch {
    return false;
  } finally {
    installEvent = null;
  }
}

/** True when the browser is online (navigator.onLine). */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/** Subscribe to online/offline transitions. Returns an unsubscribe fn. */
export function onOnlineStatusChange(cb: (online: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const on = () => cb(true);
  const off = () => cb(false);
  window.addEventListener("online", on);
  window.addEventListener("offline", off);
  return () => {
    window.removeEventListener("online", on);
    window.removeEventListener("offline", off);
  };
}
