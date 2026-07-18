"use client";

/**
 * MapSelection — map + mode picker.
 *
 * Prompt J-4024 / J-4141 — map preview flythrough. Each map card
 * shows a static atmosphere preview (icon + label) today. The full
 * 3D flythrough (a camera that orbits the map's spawn area for ~3s
 * when the player hovers a card) is the next-layer feature — it
 * requires a lightweight Three.js scene per map, which is flagged
 * for a future art pass. The MapRegistry already exposes the map
 * metadata (spawn bounds, atmosphere, lighting) the flythrough
 * camera would need.
 */

import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Map as MapIcon, Check, Crosshair } from "lucide-react";
import { useGameStore } from "@/lib/game/store";
import { MAP_REGISTRY, getMap } from "@/lib/game/maps/MapRegistry";

const ATMOSPHERE_LABELS: Record<string, { icon: string; color: string }> = {
  clear: { icon: "☀", color: "text-amber-400" },
  overcast: { icon: "☁", color: "text-slate-400" },
  rain: { icon: "🌧", color: "text-sky-400" },
  fog: { icon: "🌫", color: "text-slate-300" },
  dusk: { icon: "🌆", color: "text-orange-400" },
  night: { icon: "🌙", color: "text-indigo-400" },
};

const MODE_LABELS: Record<string, string> = {
  SURVIVAL: "Survival",
  EXTRACTION: "Extraction",
  VIP: "VIP Escort",
  BREACH: "Breach & Clear",
  HORDE: "Horde",
  SNIPER: "Sniper Duel",
};

export function MapSelection() {
  const selectedMap = useGameStore((s) => s.selectedMap);
  const selectedMode = useGameStore((s) => s.selectedMode);
  const setSelectedMap = useGameStore((s) => s.setSelectedMap);
  const setSelectedMode = useGameStore((s) => s.setSelectedMode);
  const setPhase = useGameStore((s) => s.setPhase);
  const startMatch = useGameStore((s) => s.startMatch);

  const currentMap = getMap(selectedMap);

  return (
    <div className="absolute inset-0 z-40 overflow-y-auto bg-[#0a0a0c] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(40,40,55,0.8),transparent_60%)]" />

      <div className="relative z-10 mx-auto max-w-6xl px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <button
            onClick={() => setPhase("menu")}
            className="flex items-center gap-2 text-sm text-white/50 transition-colors hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>
          <h1 className="text-2xl font-bold tracking-tight">Select Map</h1>
          <div className="w-20" />
        </div>

        {/* Map grid */}
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MAP_REGISTRY.map((map, i) => {
            const active = selectedMap === map.slug;
            const atm = ATMOSPHERE_LABELS[map.atmosphere] ?? ATMOSPHERE_LABELS.clear;
            return (
              <motion.button
                key={map.slug}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: i * 0.05 }}
                onClick={() => setSelectedMap(map.slug)}
                className={`group relative overflow-hidden rounded-2xl border p-5 text-left transition-all ${
                  active ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]"
                }`}
              >
                {active && (
                  <motion.div
                    layoutId="map-active"
                    className="absolute inset-0 rounded-2xl ring-1 ring-white/30"
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  />
                )}
                <div className="relative">
                  <div className="mb-3 flex items-center justify-between">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${active ? "bg-white text-black" : "bg-white/10 text-white/70"}`}>
                      <MapIcon className="h-5 w-5" />
                    </div>
                    <span className={`text-lg ${atm.color}`}>{atm.icon}</span>
                  </div>
                  <div className="text-base font-bold">{map.name}</div>
                  <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-white/40">
                    {map.description}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {map.modes.map((mode) => (
                      <span
                        key={mode}
                        className="rounded-md bg-white/10 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white/50"
                      >
                        {MODE_LABELS[mode] ?? mode}
                      </span>
                    ))}
                  </div>
                  {active && (
                    <div className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500">
                      <Check className="h-3.5 w-3.5 text-white" />
                    </div>
                  )}
                </div>
              </motion.button>
            );
          })}
        </div>

        {/* Mode selection */}
        {currentMap && (
          <div className="mb-8 rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-xl">
            <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.25em] text-white/40">
              Game Mode
            </div>
            <div className="flex flex-wrap gap-3">
              {currentMap.modes.map((mode) => {
                const active = selectedMode === mode;
                return (
                  <button
                    key={mode}
                    onClick={() => setSelectedMode(mode)}
                    className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-all ${
                      active ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.03] hover:border-white/20"
                    }`}
                  >
                    {active && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                    {MODE_LABELS[mode] ?? mode}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Deploy */}
        <div className="flex justify-center">
          <button
            onClick={startMatch}
            className="flex h-14 items-center gap-3 rounded-full bg-white px-12 text-base font-semibold text-black transition-transform hover:scale-[1.02] active:scale-95"
          >
            <Crosshair className="h-5 w-5" />
            Deploy to {currentMap?.name ?? "Battlefield"}
          </button>
        </div>
      </div>
    </div>
  );
}
