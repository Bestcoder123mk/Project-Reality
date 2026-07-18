"use client";

import { motion } from "framer-motion";
import { useCountUp } from "@/lib/game/anim";

/**
 * BottomRightCluster — weapon name + view-mode chip + big ammo number
 * with reserve, magazine pips, and reload progress.
 * Uses the same amber accent + panel-glass tokens as the menu.
 *
 * Prompt J-4036 / J-4130 — ammo warning. When `ammo <= magSize * 0.25`
 * the ammo number + magazine pips switch from amber to rose-400 and
 * the number flashes (motion scale 1.22→1) so the player reads "I'm
 * about to run dry" at a glance, even in peripheral vision. The
 * threshold (25%) matches the genre standard (CS2 / Valorant both
 * flag at ~25% mag).
 */
export function BottomRightCluster({
  ammo,
  magSize,
  reserveAmmo,
  weaponName,
  reloading,
  reloadProgress,
  viewMode,
}: {
  ammo: number;
  magSize: number;
  reserveAmmo: number;
  weaponName: string;
  reloading: boolean;
  reloadProgress: number;
  viewMode: "first" | "third";
}) {
  const ammoLow = ammo <= magSize * 0.25;
  const pipCount = Math.min(magSize, 30);
  // Count-up animation for reserve ammo (tweens when it changes).
  const animatedReserve = useCountUp(reserveAmmo, 400);

  return (
    <div className="absolute bottom-4 right-4">
      <div className="hud-glass rounded-xl px-4 py-2.5 text-right">
        <div className="mb-0.5 flex items-center justify-end gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
              viewMode === "first"
                ? "bg-amber-500/15 text-amber-300"
                : "bg-fuchsia-500/15 text-fuchsia-300"
            }`}
          >
            {viewMode === "first" ? "1ST" : "3RD"}
          </span>
          <span className="hud-label text-white/55">{weaponName}</span>
        </div>
        <div className="flex items-end justify-end gap-1.5">
          <motion.span
            key={ammo}
            initial={{ scale: 1.22, opacity: 0.6 }}
            animate={{
              scale: 1,
              opacity: 1,
              color: ammoLow ? "#f87171" : "#ffffff",
            }}
            transition={{ duration: 0.13, ease: [0.16, 1, 0.3, 1] }}
            className="hud-mono text-4xl font-bold leading-none text-white"
            style={{ color: ammoLow ? "#f87171" : "#ffffff" }}
          >
            {ammo}
          </motion.span>
          <span className="hud-mono mb-0.5 text-base font-medium text-white/40">
            / {animatedReserve}
          </span>
        </div>
        {/* Magazine pips — amber when full, rose when low. */}
        <div className="mt-1.5 flex justify-end gap-0.5">
          {Array.from({ length: pipCount }).map((_, i) => (
            <div
              key={i}
              className={`h-2.5 w-[2px] rounded-full ${
                i < ammo
                  ? ammoLow
                    ? "bg-rose-400"
                    : "bg-amber-400/80"
                  : "bg-white/12"
              }`}
            />
          ))}
        </div>
        {/* Reload bar — amber gradient. */}
        {reloading && (
          <div className="mt-2">
            <div className="mb-0.5 flex items-center justify-end gap-1.5">
              <span className="hud-label text-amber-300">Reloading</span>
            </div>
            <div className="ml-auto h-1 w-32 overflow-hidden rounded-full bg-white/10">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-400"
                style={{ width: `${reloadProgress * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

