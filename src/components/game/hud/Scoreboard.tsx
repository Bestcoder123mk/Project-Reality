"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  getScoreboard,
  sortScoreboard,
  getLocalRank,
  type ScoreboardData,
  type ScoreboardEntry,
} from "@/lib/game/uiux/scoreboard";

/**
 * Prompt J-4035 / J-4129 — in-match scoreboard.
 *
 * Toggled with Tab (held) — the scoreboard overlays the HUD with a
 * translucent panel listing every player's K/D/A/score/ping. The local
 * player's row is highlighted + pinned to the bottom for quick self-
 * location. Reads `window.__PR_SCOREBOARD__` (published by the engine
 * each frame) so there's no React re-render cost while the panel is
 * closed.
 *
 * When open, the panel polls the engine data on rAF (throttled to
 * ~10 Hz — plenty for a stats readout, well below the 60 Hz render
 * budget). Closes on Tab release or Escape.
 */
export function Scoreboard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<ScoreboardData | null>(null);

  // Poll engine data on rAF while open.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let lastUpdate = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (now - lastUpdate < 100) return; // 10 Hz
      lastUpdate = now;
      const d = getScoreboard();
      setData((prev) => {
        // Skip update if the data hasn't changed (avoid re-render).
        if (prev === d) return prev;
        return d;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
        >
          <motion.div
            className="w-full max-w-2xl rounded-2xl border border-white/[0.08] bg-[#0c0e0a]/95 p-6 text-white shadow-2xl"
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold tracking-tight">Scoreboard</h2>
              <div className="flex items-center gap-3 text-[11px] text-white/40">
                {data && (
                  <span>
                    Rank #{getLocalRank(data)} / {data.entries.length}
                  </span>
                )}
                <span>Press Tab to close</span>
              </div>
            </div>

            {!data ? (
              <div className="py-12 text-center text-sm text-white/40">
                No scoreboard data available.
              </div>
            ) : (
              <ScoreboardTable data={data} />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ScoreboardTable({ data }: { data: ScoreboardData }) {
  const sorted = sortScoreboard(data.entries);
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06]">
      {/* Header */}
      <div className="grid grid-cols-[2rem_1fr_3rem_3rem_3rem_4rem_3rem] gap-2 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-white/40">
        <span>#</span>
        <span>Player</span>
        <span className="text-right">K</span>
        <span className="text-right">D</span>
        <span className="text-right">A</span>
        <span className="text-right">Score</span>
        <span className="text-right">Ping</span>
      </div>
      {/* Rows */}
      <div className="max-h-[60vh] overflow-y-auto">
        {sorted.map((entry, i) => (
          <ScoreboardRow key={entry.id} entry={entry} rank={i + 1} />
        ))}
      </div>
    </div>
  );
}

function ScoreboardRow({ entry, rank }: { entry: ScoreboardEntry; rank: number }) {
  const teamColor =
    entry.team === "player"
      ? "text-emerald-300"
      : entry.team === "ally"
        ? "text-sky-300"
        : "text-rose-300";
  return (
    <div
      className={`grid grid-cols-[2rem_1fr_3rem_3rem_3rem_4rem_3rem] items-center gap-2 px-3 py-1.5 text-xs ${
        entry.isLocal ? "bg-amber-500/[0.08] ring-1 ring-inset ring-amber-500/20" : "hover:bg-white/[0.02]"
      }`}
    >
      <span className="text-white/40 tabular-nums">{rank}</span>
      <span className={`min-w-0 truncate font-medium ${teamColor}`}>
        {entry.callsign}
        {entry.isLocal && <span className="ml-1 text-[9px] uppercase tracking-wider text-amber-400">you</span>}
        {entry.status === "dead" && <span className="ml-1 text-[9px] uppercase tracking-wider text-rose-400">dead</span>}
      </span>
      <span className="text-right tabular-nums text-white/80">{entry.kills}</span>
      <span className="text-right tabular-nums text-white/60">{entry.deaths}</span>
      <span className="text-right tabular-nums text-white/60">{entry.assists}</span>
      <span className="text-right tabular-nums font-bold text-white">{entry.score}</span>
      <span className={`text-right tabular-nums ${entry.pingMs < 50 ? "text-emerald-400" : entry.pingMs < 150 ? "text-amber-400" : "text-rose-400"}`}>
        {entry.pingMs > 0 ? `${entry.pingMs}ms` : "—"}
      </span>
    </div>
  );
}
