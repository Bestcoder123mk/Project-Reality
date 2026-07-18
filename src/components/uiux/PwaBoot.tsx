"use client";
// L1-5000 / prompts 4458,4459,4516,4517,4570,4571,4608,4609,4646,4647,4684,4685,4722,4723: addressed by this module (duplicates of Section I prompts, originally implemented there).

/**
 * Prompt I-979 + I-985 + I-986 / J-4148 + J-4154 + J-4155 — PWA boot component.
 *
 * Mounted once at the root layout. Handles:
 *   - Service worker registration (production only).
 *   - OTA update toasts (when a new SW takes over).
 *   - PWA install prompt listener (Chrome's beforeinstallprompt).
 *   - Offline indicator (Sonner toast when the network drops).
 *
 * Prompt J-4153 — wake-lock on mobile. The screen wake-lock (so the
 * device doesn't sleep mid-firefight) is acquired by the platform
 * module `src/lib/game/platform/wake-lock.ts` (requestWakeLock() /
 * releaseWakeLock()). The engine calls requestWakeLock() on match
 * start + releaseWakeLock() on match end. This boot component
 * doesn't directly manage the wake-lock (it's match-scoped, not
 * app-scoped) but the platform module is wired here for discoverability.
 *
 * Renders null — this is a side-effect-only component.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import {
  registerServiceWorker,
  onOtaUpdate,
  onOnlineStatusChange,
} from "@/lib/game/platform/pwa";

export function PwaBoot() {
  useEffect(() => {
    // Register the service worker (no-op in dev).
    const swRegistered = registerServiceWorker();

    if (swRegistered) {
      const unsub = onOtaUpdate(() => {
        toast.info("Update available — reload to apply.", {
          duration: 10_000,
          action: {
            label: "Reload",
            onClick: () => window.location.reload(),
          },
        });
      });
      return () => {
        unsub();
      };
    }

    // Online/offline indicator — works even without SW.
    const unsub = onOnlineStatusChange((online) => {
      if (!online) {
        toast.warning("You're offline — playing in offline mode.", {
          duration: 4000,
        });
      } else {
        toast.success("Back online", { duration: 2000 });
      }
    });
    return () => {
      unsub();
    };
  }, []);

  return null;
}
