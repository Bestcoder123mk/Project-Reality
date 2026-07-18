"use client";

/**
 * Prompt J-4111 — loading progress.
 *
 * Next.js route-level loading UI. Shown while the dynamically-imported
 * menu screens + GameCanvas chunks download + compile on the first
 * visit (turbopack compiles per-route on demand in dev; in prod the
 * chunks are pre-built but still need to download on slow connections).
 *
 * The UI shows:
 *   - A determinate progress bar that animates 0→90% over ~3s (the
 *     last 10% waits for the actual chunk to mount, so the bar never
 *     falsely hits 100% before the content is visible).
 *   - A rotating loading tip from the loading-tips lib (J-4021).
 *   - The Project Reality wordmark so the first paint already has
 *     brand identity (no blank white flash).
 *
 * This is a Client Component because it uses useState/useEffect for
 * the progress animation + tip rotation. Next.js wraps it in a
 * <Suspense> boundary automatically.
 */

import { useEffect, useState } from "react";
import { getRandomTip } from "@/lib/game/uiux/loading-tips";

export default function Loading() {
  const [progress, setProgress] = useState(0);
  const [tip, setTip] = useState<string>("");

  useEffect(() => {
    // Animate the progress bar 0→90% over ~2.8s, then hold at 90%
    // until the real content mounts (Next.js swaps the loading
    // boundary out the moment the dynamic chunk is ready).
    const start = performance.now();
    const DURATION_MS = 2800;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const elapsed = performance.now() - start;
      const t = Math.min(1, elapsed / DURATION_MS);
      // Ease-out cubic: fast start, slow finish (feels responsive
      // early, then settles as the chunk finishes compiling).
      const eased = 1 - Math.pow(1 - t, 3);
      setProgress(Math.round(eased * 90));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    // Pick a random tip on mount. The loading-tips lib is synchronous
    // + tiny (no network), so this is instant.
    setTip(getRandomTip().body);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#08090c] text-white"
      role="status"
      aria-live="polite"
      aria-label="Loading Project Reality"
    >
      <div className="flex flex-col items-center gap-6 px-6">
        {/* Wordmark */}
        <div className="text-center">
          <div className="font-display text-3xl font-bold uppercase tracking-[0.2em] text-amber-400">
            Project Reality
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.4em] text-white/30">
            Browser FPS
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-64 max-w-[80vw]">
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-400 transition-[width] duration-100 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-white/40">
            <span>Loading</span>
            <span className="tabular-nums">{progress}%</span>
          </div>
        </div>

        {/* Rotating tip */}
        {tip && (
          <div className="max-w-sm text-center">
            <div className="mb-1 text-[9px] font-bold uppercase tracking-[0.3em] text-amber-400/60">
              Tactical Tip
            </div>
            <p className="text-xs leading-relaxed text-white/50">{tip}</p>
          </div>
        )}
      </div>
    </div>
  );
}
