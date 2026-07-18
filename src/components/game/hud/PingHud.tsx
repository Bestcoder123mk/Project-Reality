"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Prompt J-4032 / J-4126 / J-4198 — ping system (HUD layer).
 *
 * The lib layer (`createMinimapPing` in HudUxEnhancements.ts) defines
 * the ping data model. This component is the HUD renderer: it reads
 * active pings from `window.__PR_PINGS__` (published by the engine
 * when the player presses the ping key, default middle-click or Z)
 * + renders them as screen-space markers that fade over ~3s.
 *
 * Each ping has a world position {x, z} + a type ("enemy" | "objective"
 * | "alert" | "go"). The engine projects the world position to screen
 * space + publishes {id, sx, sy, type, bornAt}. The HUD just draws.
 *
 * Pings behind the camera (sx < 0 or > viewport) are clamped to the
 * screen edge with an arrow pointing off-screen, so the player can
 * tell "someone pinged something behind me".
 *
 * The minimap also reads `window.__PR_PINGS__` (separate renderer in
 * Minimap.tsx — to be wired) so pings appear both on the HUD + the
 * minimap simultaneously.
 */

export interface HudPing {
  id: number;
  /** Screen-space x (CSS pixels from left). Negative or > viewport
   *  means the ping is off-screen (behind the player or past the FOV). */
  sx: number;
  /** Screen-space y (CSS pixels from top). */
  sy: number;
  /** Ping type — drives the icon + color. */
  type: "enemy" | "objective" | "alert" | "go";
  /** performance.now() when the ping was created. */
  bornAt: number;
}

declare global {
  interface Window {
    __PR_PINGS__?: HudPing[];
  }
}

const PING_DURATION_MS = 3000;
const PING_COLORS: Record<HudPing["type"], string> = {
  enemy: "#f87171",
  objective: "#fbbf24",
  alert: "#a78bfa",
  go: "#34d399",
};
const PING_LABELS: Record<HudPing["type"], string> = {
  enemy: "!",
  objective: "◆",
  alert: "?",
  go: "→",
};

export function PingHud() {
  const [pings, setPings] = useState<HudPing[]>([]);
  const lastSigRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const raw = window.__PR_PINGS__;
      if (!raw) return;
      // Cheap change detection: compare length + last id. Only setState
      // when the list actually changed (avoids per-frame re-renders).
      const sig = raw.length * 100000 + (raw[raw.length - 1]?.id ?? 0);
      if (sig === lastSigRef.current) return;
      lastSigRef.current = sig;
      // Filter out expired pings on the HUD side too (the engine may
      // keep them around for the minimap's longer fade).
      const now = performance.now();
      setPings(raw.filter((p) => now - p.bornAt < PING_DURATION_MS));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (pings.length === 0) return null;
  const now = performance.now();
  const vw = typeof window !== "undefined" ? window.innerWidth : 1920;
  const vh = typeof window !== "undefined" ? window.innerHeight : 1080;

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {pings.map((p) => {
        const age = now - p.bornAt;
        const t = Math.min(1, age / PING_DURATION_MS);
        const alpha = 1 - t;
        const scale = 1 + t * 0.4;
        const color = PING_COLORS[p.type];
        // Clamp off-screen pings to the edge with an arrow.
        const onScreen = p.sx >= 0 && p.sx <= vw && p.sy >= 0 && p.sy <= vh;
        const cx = Math.max(20, Math.min(vw - 20, p.sx));
        const cy = Math.max(20, Math.min(vh - 20, p.sy));
        return (
          <div
            key={p.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: cx, top: cy, opacity: alpha }}
          >
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 font-bold"
              style={{
                borderColor: color,
                color,
                backgroundColor: `${color}22`,
                transform: `scale(${scale})`,
                boxShadow: `0 0 12px ${color}88`,
              }}
            >
              {onScreen ? PING_LABELS[p.type] : "◀"}
            </div>
          </div>
        );
      })}
    </div>
  );
}
