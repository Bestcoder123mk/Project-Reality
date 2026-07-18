"use client";

/**
 * Prompt I-976 / J-4056 / J-4102 — Screen reader for menus.
 *
 * A polite aria-live region mounted once at the root layout. Other
 * components call `announceMenuMessage(text)` to push a message; the
 * region re-renders + the screen reader announces it. Used for:
 *
 *   - Phase transitions ("Opened Settings", "Returned to Main Menu").
 *   - Modal open/close ("Opened PackScreen", "Closed dialog").
 *   - Async result toasts the Sonner toaster already shows visually
 *     ("Saved preset 'sniper'", "Pack open failed").
 *
 * The region is `.sr-only` (visually hidden, screen-reader available)
 * and `aria-live="polite"` so it doesn't interrupt. Atomic so the
 * whole string is announced as one phrase.
 *
 * Why a separate region (not the toaster): Sonner toasts render with
 * role="status" which is announced, but the timing + announcement
 * semantics vary by screen reader. A dedicated live region is the
 * most reliable channel for menu navigation cues.
 */

import { useEffect, useState } from "react";

let _setMessage: ((msg: string) => void) | null = null;

/** Push a message to the menu screen-reader live region. No-op on SSR. */
export function announceMenuMessage(text: string): void {
  if (typeof window === "undefined") return;
  if (_setMessage) _setMessage(text);
}

export function MenuScreenReaderLiveRegion() {
  const [msg, setMsg] = useState("");
  useEffect(() => {
    _setMessage = (m: string) => {
      // Toggle through empty string so consecutive identical messages
      // still announce (some screen readers dedupe identical text).
      setMsg("");
      // Defer the actual message to the next tick so the empty-state
      // render commits first.
      requestAnimationFrame(() => setMsg(m));
    };
    return () => {
      _setMessage = null;
    };
  }, []);
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-testid="menu-screen-reader-live"
    >
      {msg}
    </div>
  );
}
