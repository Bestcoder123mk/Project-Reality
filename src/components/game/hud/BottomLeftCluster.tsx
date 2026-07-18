"use client";

import { motion } from "framer-motion";

/**
 * BottomLeftCluster — player vitals: health + armor + casualty status.
 * Corner-clustered, glassmorphic, with subtle animations on damage.
 */
export function BottomLeftCluster({
  health,
  maxHealth,
  armor,
  casualtyState,
  bleedRate,
}: {
  health: number;
  maxHealth: number;
  armor: number;
  casualtyState: "ACTIVE" | "BLEEDING" | "FRACTURED" | "UNCONSCIOUS";
  bleedRate: number;
}) {
  const healthPct = Math.max(0, Math.min(100, (health / maxHealth) * 100));
  const armorPct = Math.max(0, Math.min(100, armor));
  const healthColor =
    healthPct > 50 ? "#34d399" : healthPct > 25 ? "#fbbf24" : "#f87171";
  const showCasualty = casualtyState !== "ACTIVE" || bleedRate > 0;

  return (
    <div className="absolute bottom-4 left-4 flex w-60 flex-col gap-2">
      {showCasualty && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="hud-glass-strong flex items-center gap-2 rounded-md border border-rose-500/30 px-2.5 py-1.5"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              casualtyState === "BLEEDING"
                ? "animate-pulse bg-rose-500"
                : casualtyState === "FRACTURED"
                  ? "bg-amber-500"
                  : "bg-red-700"
            }`}
          />
          <span className="text-[11px] font-bold text-rose-200">
            {casualtyState}
          </span>
          {bleedRate > 0 && (
            <span className="hud-mono text-[10px] text-rose-300">
              -{bleedRate.toFixed(1)}/s
            </span>
          )}
          <span className="ml-auto text-[9px] text-white/45">
            {casualtyState === "BLEEDING" && "H"}
            {casualtyState === "FRACTURED" && "J"}
            {casualtyState === "UNCONSCIOUS" && "L"}
          </span>
        </motion.div>
      )}

      <div className="hud-glass rounded-xl p-3">
        {/* Health */}
        <div className="mb-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="hud-label">Health</span>
            <motion.span
              key={Math.floor(health)}
              initial={{ scale: 1.12, opacity: 0.7 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.18 }}
              className="hud-mono text-lg font-bold leading-none"
              style={{ color: healthColor }}
            >
              {Math.max(0, Math.ceil(health))}
            </motion.span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
            <motion.div
              className="h-full rounded-full"
              style={{ backgroundColor: healthColor }}
              animate={{ width: `${healthPct}%` }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
        </div>
        {/* Armor */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="hud-label">Armor</span>
            <span className="hud-mono text-xs font-semibold text-sky-300">
              {Math.max(0, Math.round(armor))}
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/8">
            <motion.div
              className="h-full rounded-full bg-sky-400/80"
              animate={{ width: `${armorPct}%` }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
