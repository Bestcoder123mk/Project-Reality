"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

/**
 * LoadoutStrip — persistent 4-slot weapon strip showing primary/secondary/
 * melee/utility, with the active slot highlighted/enlarged. Empty utility
 * charges are greyed out.
 *
 * Reads `window.__PR_LOADOUT_STRIP__` (published by HudSystem each frame)
 * via rAF polling — same pattern as Minimap/DamageNumbers.
 *
 * Positioned bottom-right, above the ammo cluster.
 */
const SLOT_LABELS = ["1", "2", "3", "4"];
const SLOT_NAMES = ["PRIMARY", "SECONDARY", "MELEE", "UTILITY"];

function weaponIcon(slug: string, slot: number): string {
  if (!slug) return "—";
  const s = slug.toLowerCase();
  if (slot === 2) {
    // melee
    if (s.includes("katana")) return "⚔";
    if (s.includes("axe")) return "🪓";
    if (s.includes("hammer") || s.includes("sledge")) return "🔨";
    if (s.includes("machete")) return "🗡";
    if (s.includes("crowbar")) return "🔧";
    return "🔪";
  }
  if (slot === 3) {
    // utility
    if (s.includes("frag") || s.includes("grenade")) return "💣";
    if (s.includes("smoke")) return "💨";
    if (s.includes("flash")) return "⚡";
    if (s.includes("medkit") || s.includes("bandage")) return "✚";
    if (s.includes("adrenaline")) return "💉";
    return "🎒";
  }
  // weapons
  if (s.includes("awp") || s.includes("l115") || s.includes("kar98") || s.includes("scout")) return "🎯";
  if (s.includes("nova") || s.includes("m1014") || s.includes("spas")) return "💥";
  if (s.includes("m249") || s.includes("rpk") || s.includes("mk48")) return "🔫";
  if (s.includes("deagle") || s.includes("revolver") || s.includes("usp") || s.includes("glock") || s.includes("1911")) return "🔫";
  return "🔫";
}

export function LoadoutStrip() {
  const [data, setData] = useState<{
    primary: string; secondary: string; melee: string; utility: string;
    active: 0 | 1 | 2 | 3; utilityCharges: number;
  } | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const d = window.__PR_LOADOUT_STRIP__;
      if (d) setData(d);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!data) return null;

  const slots = [data.primary, data.secondary, data.melee, data.utility];

  return (
    <div className="absolute bottom-[5.5rem] right-4 z-30 flex gap-1.5 pointer-events-none">
      {slots.map((slug, i) => {
        const isActive = data.active === i;
        const isUtility = i === 3;
        const empty = isUtility && data.utilityCharges <= 0;
        return (
          <motion.div
            key={i}
            className="relative flex flex-col items-center justify-center rounded-lg border backdrop-blur-xl"
            animate={{
              scale: isActive ? 1.12 : 1,
              opacity: empty ? 0.35 : 1,
            }}
            transition={{ type: "spring", stiffness: 400, damping: 28 }}
            style={{
              width: isActive ? 60 : 48,
              height: isActive ? 60 : 48,
              background: isActive
                ? "rgba(255,210,120,0.16)"
                : "rgba(15,18,22,0.55)",
              borderColor: isActive
                ? "rgba(255,210,120,0.65)"
                : "rgba(255,255,255,0.10)",
              boxShadow: isActive
                ? "0 0 16px rgba(255,180,40,0.35), inset 0 0 8px rgba(255,180,40,0.12)"
                : "none",
            }}
          >
            {/* Slot number keybind badge */}
            <span
              className="absolute -top-1.5 -left-1.5 flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold"
              style={{
                background: isActive ? "rgba(255,210,120,0.9)" : "rgba(40,44,50,0.9)",
                color: isActive ? "#1a1208" : "#9ca3af",
              }}
            >
              {SLOT_LABELS[i]}
            </span>

            {/* Weapon icon */}
            <span className="text-xl leading-none" style={{ filter: isActive ? "none" : "grayscale(0.3)" }}>
              {weaponIcon(slug, i)}
            </span>

            {/* Slot name + slug */}
            <span
              className="mt-0.5 text-[7px] font-semibold tracking-wider text-white/50 uppercase"
              style={{ lineHeight: 1 }}
            >
              {SLOT_NAMES[i].slice(0, 4)}
            </span>

            {/* Utility charges */}
            {isUtility && !empty && (
              <span className="absolute -bottom-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/90 px-1 text-[9px] font-bold text-black">
                {data.utilityCharges}
              </span>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
