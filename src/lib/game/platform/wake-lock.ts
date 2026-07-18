/**
 * L1-5000 / prompts 4457,4515,4569,4607,4645,4683,4721: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4759,4797,4835,4873,4911,4949,4987 (Wake-lock): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * Prompt #113 — Screen Wake Lock.
 *
 * The Screen Wake Lock API prevents the display from dimming / sleeping while
 * a match is in progress. Critical for a browser FPS: a playercamping a
 * corner for 30+ seconds (sniper holding angle) shouldn't have their screen
 * lock mid-firefight on a power-saving laptop. The lock is auto-released by
 * the browser when the tab is backgrounded (so we don't drain battery while
 * alt-tabbed), and we re-acquire it on visibilitychange (see engine.ts).
 *
 * Feature-detection: `navigator.wakeLock` is undefined on Firefox + Safari
 * < 16.4 + all iOS browsers (Apple ships it as a no-op). On unsupported
 * browsers, acquireWakeLock() resolves to a no-op release fn so callers
 * don't need to branch.
 *
 * The returned release fn is idempotent — calling it twice is safe.
 *
 * L1-5000 / prompt 4508 — the legacy module shipped acquireWakeLock() but
 * never wired the visibilitychange listener that re-acquires the lock
 * when the tab comes back to the foreground. The browser auto-releases
 * the sentinel on tab background; without re-acquire, the screen would
 * dim/sleep mid-match after the first alt-tab. The new
 * `acquirePersistentWakeLock()` returns a release fn that ALSO tears down
 * the visibilitychange listener — so callers don't leak listeners across
 * match restarts. The original `acquireWakeLock()` is kept for callers
 * that want the one-shot behavior (e.g. cutscenes).
 */

/** Minimal WakeLockSentinel shape we depend on (avoids TS lib version drift). */
interface WakeLockSentinelLike {
  release: () => Promise<void>;
  released: boolean;
  type: "screen";
  addEventListener: (type: "release", cb: () => void) => void;
}

export async function acquireWakeLock(): Promise<() => void> {
  // SSR guard + feature detection.
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) {
    return () => {};
  }
  try {
    // `navigator.wakeLock` is typed in lib.dom as of TS 5.2+, but the
    // project's TS lib may predate it — cast through unknown to the
    // canonical Screen Wake Lock shape to stay strict-safe.
    const wakeLock = (navigator as unknown as {
      wakeLock?: {
        request: (type: "screen") => Promise<WakeLockSentinelLike>;
      };
    }).wakeLock;
    if (!wakeLock) return () => {};
    const lock = await wakeLock.request("screen");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        lock.release();
      } catch {
        // Already released (browser auto-released on background) — ignore.
      }
    };
  } catch {
    // NotAllowedError: page isn't focused / cross-origin iframe / no user
    // gesture yet. Return a no-op so the engine doesn't have to branch.
    return () => {};
  }
}

/**
 * L1-5000 / prompt 4508 — acquire a wake lock that persists across
 * tab-background → tab-foreground transitions.
 *
 * The browser auto-releases the WakeLockSentinel when the tab is
 * backgrounded (battery preservation). Without re-acquire, the screen
 * would dim/sleep mid-match after the first alt-tab — a sniper holding
 * an angle for 30+ seconds comes back to a locked screen.
 *
 * This helper:
 *   1. Acquires the initial sentinel.
 *   2. Registers a `visibilitychange` listener that re-acquires the
 *      sentinel when `document.visibilityState === "visible"`.
 *   3. Returns a release fn that:
 *        - Releases the current sentinel.
 *        - Removes the visibilitychange listener.
 *        - Is idempotent (safe to call multiple times).
 *
 * The release fn is what the engine stores on the GameContext + calls
 * on match end / pause. The listener is registered on `document` (not
 * `window`) because that's where visibilitychange fires.
 *
 * SSR / unsupported browsers: returns a no-op release fn (same as
 * acquireWakeLock). The caller doesn't branch.
 */
export async function acquirePersistentWakeLock(): Promise<() => void> {
  if (typeof document === "undefined" || typeof navigator === "undefined") {
    return () => {};
  }
  const wakeLock = (navigator as unknown as {
    wakeLock?: {
      request: (type: "screen") => Promise<WakeLockSentinelLike>;
    };
  }).wakeLock;
  if (!wakeLock) return () => {};

  let current: WakeLockSentinelLike | null = null;
  let disposed = false;

  const acquire = async () => {
    if (disposed) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      // Tab is hidden — the browser will reject the request. Skip; the
      // visibilitychange listener will re-acquire when the tab returns.
      return;
    }
    try {
      current = await wakeLock.request("screen");
      // When the sentinel auto-releases (tab background), clear the
      // reference so the next visibilitychange re-acquires fresh.
      current.addEventListener("release", () => {
        current = null;
      });
    } catch {
      // NotAllowedError / SecurityError — page not focused, cross-origin
      // iframe, no user gesture yet. Swallow; the next visibilitychange
      // will retry.
    }
  };

  const onVisibilityChange = () => {
    if (disposed) return;
    if (document.visibilityState === "visible") {
      void acquire();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Initial acquire (best-effort — may reject if no user gesture yet).
  await acquire();

  return () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (current) {
      try {
        void current.release();
      } catch {
        // Already released — ignore.
      }
      current = null;
    }
  };
}
