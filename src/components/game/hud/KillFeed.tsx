"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * KillFeed — top-right stack of recent kills.
 *
 * Prompt J-4040 — previously capped at 4.5s with no scrollback. The
 * player could only see the last few seconds of kills; if they looked
 * away during a multi-kill chain they missed it entirely. Now:
 *   - Live entries fade out after 4.5s (unchanged).
 *   - Expired entries move into a `historyRef` ring buffer (last 50).
 *   - A small chevron button toggles the scrollback panel open. The
 *     panel renders the history newest-first, scrollable.
 *
 * The history is in-memory only (resets on tab close) — sufficient for
 * mid-match review. A future persistence layer (match summary screen)
 * could write it to localStorage if a "post-match kill feed" is wanted.
 */
interface KillFeedEntry {
  id: number;
  killer: string;
  victim: string;
  weapon: string;
  headshot: boolean;
  time: number;
}

const HISTORY_MAX = 50;
const LIVE_DURATION_MS = 4500;

export function KillFeed({
  entries,
  now,
}: {
  entries: KillFeedEntry[];
  now: number;
}) {
  // Prompt J-4040 — scrollback ring buffer. Appends every entry the
  // parent passes in (live + recently-expired), capped at HISTORY_MAX.
  const historyRef = useRef<KillFeedEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // Bump a counter when history changes so the open panel re-renders.
  const [, setHistoryVersion] = useState(0);

  useEffect(() => {
    if (entries.length === 0) return;
    // Append new entries (by id) to the history.
    const knownIds = new Set(historyRef.current.map((e) => e.id));
    let added = false;
    for (const e of entries) {
      if (!knownIds.has(e.id)) {
        historyRef.current = [e, ...historyRef.current].slice(0, HISTORY_MAX);
        added = true;
      }
    }
    if (added) setHistoryVersion((v) => v + 1);
  }, [entries]);

  const live = entries.filter((k) => now - k.time < LIVE_DURATION_MS);

  return (
    <div className="absolute right-4 top-4 flex w-72 flex-col items-end gap-1.5">
      {/* Scrollback toggle — only renders if there's history. */}
      {historyRef.current.length > 0 && (
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="hud-glass mb-0.5 rounded-md px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white/50 transition-colors hover:text-white/80"
          aria-label={showHistory ? "Hide kill feed history" : "Show kill feed history"}
          aria-expanded={showHistory}
        >
          {showHistory ? "▲ Hide" : "▼ History"} ({historyRef.current.length})
        </button>
      )}
      {/* Scrollback panel — newest first, scrollable. */}
      <AnimatePresence>
        {showHistory && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="hud-glass max-h-64 w-72 overflow-y-auto rounded-md p-1.5"
          >
            {historyRef.current.map((k) => (
              <div
                key={k.id}
                className="flex items-center gap-2 rounded px-1.5 py-0.5 text-[10px] hover:bg-white/[0.04]"
              >
                <span
                  className={`font-semibold ${
                    k.killer === "YOU"
                      ? "text-emerald-300"
                      : k.killer === "SYSTEM"
                        ? "text-amber-300"
                        : "text-sky-300"
                  }`}
                >
                  {k.killer}
                </span>
                {k.weapon && <span className="text-white/30">{k.weapon}</span>}
                {k.headshot && <span className="font-bold text-amber-400">HS</span>}
                <span className="font-semibold text-rose-300/80">{k.victim}</span>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      {/* Live entries (fade after 4.5s). */}
      <AnimatePresence>
        {live.map((k) => (
          <motion.div
            key={k.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="hud-glass flex items-center gap-2 rounded-md px-2.5 py-1"
          >
            <span
              className={`text-xs font-semibold ${
                k.killer === "YOU"
                  ? "text-emerald-300"
                  : k.killer === "SYSTEM"
                    ? "text-amber-300"
                    : "text-sky-300"
              }`}
            >
              {k.killer}
            </span>
            {k.weapon && (
              <span className="text-[10px] text-white/35">{k.weapon}</span>
            )}
            {k.headshot && (
              <span className="text-[10px] font-bold text-amber-400">HS</span>
            )}
            <span className="text-xs font-semibold text-rose-300">
              {k.victim}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * RadioMessage — top-center radio callout below the objective pill.
 */
export function RadioMessage({
  radio,
  now,
}: {
  radio: { text: string; channel: string; time: number } | null;
  now: number;
}) {
  if (!radio || now - radio.time >= 4000) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="hud-glass absolute left-1/2 top-20 flex -translate-x-1/2 items-center gap-2 rounded-md px-3 py-1.5"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.6)]" />
      <span className="text-[9px] font-bold uppercase tracking-wider text-sky-300">
        [{radio.channel}]
      </span>
      <span className="text-xs text-white/85">{radio.text}</span>
    </motion.div>
  );
}
