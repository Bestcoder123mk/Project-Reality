"use client";

import { motion } from "framer-motion";
import { useCountUp } from "@/lib/game/anim";

/**
 * Top-left cluster — minimap, score, kills, wave, hostiles, FPS.
 * Compact, corner-clustered layout per the reference spec.
 * Uses count-up animations for score/kills (tween, not snap).
 */
export function TopLeftCluster({
  score,
  kills,
  wave,
  maxWaves,
  enemiesRemaining,
  totalEnemies,
  fps,
  minimap,
}: {
  score: number;
  kills: number;
  wave: number;
  maxWaves: number;
  enemiesRemaining: number;
  totalEnemies: number;
  fps: number;
  minimap: React.ReactNode;
}) {
  // Count-up animations — tween when values change, not snap.
  const animatedScore = useCountUp(score, 500);
  const animatedKills = useCountUp(kills, 400);

  return (
    <div className="absolute left-4 top-4 flex flex-col gap-2">
      {minimap}
      <div className="hud-glass flex items-center gap-3 rounded-xl px-3 py-1.5">
        <div className="flex flex-col">
          <span className="hud-label">Score</span>
          <span className="hud-mono text-base font-bold leading-none text-white">
            {animatedScore.toLocaleString()}
          </span>
        </div>
        <div className="h-7 w-px bg-white/10" />
        <div className="flex flex-col">
          <span className="hud-label">Kills</span>
          <span className="hud-mono text-base font-bold leading-none text-amber-300">
            {animatedKills}
          </span>
        </div>
        <div className="h-7 w-px bg-white/10" />
        <div className="flex flex-col">
          <span className="hud-label">Hostiles</span>
          <span className="hud-mono text-base font-bold leading-none text-rose-300">
            {enemiesRemaining}/{totalEnemies}
          </span>
        </div>
      </div>
      <div className="hud-glass flex items-center gap-2 self-start rounded-lg px-2.5 py-1">
        <span className="hud-label">Wave</span>
        <span className="hud-mono text-xs font-bold text-white">
          {wave} / {maxWaves}
        </span>
        {fps > 0 && (
          <>
            <span className="mx-1 h-3 w-px bg-white/10" />
            <span className="hud-label">FPS</span>
            <span
              className={`hud-mono text-xs font-bold ${
                fps >= 50
                  ? "text-emerald-300"
                  : fps >= 30
                    ? "text-amber-300"
                    : "text-rose-300"
              }`}
            >
              {fps}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Top-center — wave pill + objective text.
 * Amber accent dot + animated entrance on wave change.
 */
export function TopCenterObjective({
  wave,
  maxWaves,
  objective,
}: {
  wave: number;
  maxWaves: number;
  objective: string;
}) {
  return (
    <div className="absolute left-1/2 top-4 flex -translate-x-1/2 flex-col items-center gap-1.5">
      <motion.div
        key={wave}
        initial={{ scale: 1.18, opacity: 0.6 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
        className="hud-glass-strong flex items-center gap-2 rounded-full px-4 py-1.5"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(255,140,26,0.7)]" />
        <span className="hud-label text-amber-200/80">Wave</span>
        <span className="hud-mono text-sm font-bold text-white">
          {wave} <span className="text-white/40">/ {maxWaves}</span>
        </span>
      </motion.div>
      {objective && (
        <div className="hud-glass rounded-md px-3 py-0.5">
          <span className="text-[10px] font-medium tracking-wide text-white/70">
            {objective}
          </span>
        </div>
      )}
    </div>
  );
}

