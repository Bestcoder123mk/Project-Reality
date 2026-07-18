"use client";

import { motion } from "framer-motion";

/**
 * BottomCenterCluster — medical quick slots (H/J/K/L), weather/time strip,
 * suppression bar (only when active), and medical channel progress (only
 * when channeling). All anchored to a single column so they never overlap.
 */
export function BottomCenterCluster({
  suppression,
  medicalInventory,
  medicalChannel,
  weather,
  timeOfDay,
  windSpeed,
}: {
  suppression: number;
  medicalInventory: { bandage: number; splint: number; epi: number; medkit: number };
  medicalChannel: { slug: string; progress: number } | null;
  weather: string;
  timeOfDay: number;
  windSpeed: number;
}) {
  return (
    <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5">
      {/* Medical channel progress (only when channeling) */}
      {medicalChannel && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="hud-glass-strong w-60 rounded-lg px-3 py-2"
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold capitalize text-white">
              {medicalChannel.slug}
            </span>
            <span className="hud-label text-emerald-300">Applying</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <motion.div
              className="h-full rounded-full bg-emerald-400"
              animate={{ width: `${medicalChannel.progress * 100}%` }}
            />
          </div>
        </motion.div>
      )}

      {/* Suppression bar (only when > 2%) */}
      {suppression > 0.02 && (
        <div className="w-44">
          <div className="mb-0.5 flex justify-between">
            <span className="hud-label">Suppression</span>
            <span className="hud-mono text-[9px] font-bold text-orange-300">
              {Math.round(suppression * 100)}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-orange-500 to-rose-500"
              animate={{ width: `${suppression * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Weather + time strip */}
      <div className="hud-glass flex items-center gap-2.5 rounded-full px-3 py-1">
        <WeatherIcon weather={weather} />
        <span className="hud-mono text-[11px] font-medium text-white/75">
          {formatTime(timeOfDay)}
        </span>
        <span className="text-[10px] text-white/35">{weather}</span>
        <span className="h-3 w-px bg-white/10" />
        <span className="hud-mono text-[10px] text-white/45">
          {windSpeed.toFixed(1)} m/s
        </span>
      </div>

      {/* Medical quick slots */}
      <div className="flex gap-1.5">
        <MedSlot keyName="H" slug="Bandage" count={medicalInventory.bandage} accent="emerald" />
        <MedSlot keyName="J" slug="Splint" count={medicalInventory.splint} accent="amber" />
        <MedSlot keyName="K" slug="Medkit" count={medicalInventory.medkit} accent="sky" />
        <MedSlot keyName="L" slug="Epi" count={medicalInventory.epi} accent="rose" />
      </div>
    </div>
  );
}

function MedSlot({
  keyName,
  slug,
  count,
  accent,
}: {
  keyName: string;
  slug: string;
  count: number;
  accent: "emerald" | "amber" | "sky" | "rose";
}) {
  const empty = count <= 0;
  const accentColor = {
    emerald: "text-emerald-300 bg-emerald-500/15",
    amber: "text-amber-300 bg-amber-500/15",
    sky: "text-sky-300 bg-sky-500/15",
    rose: "text-rose-300 bg-rose-500/15",
  }[accent];
  return (
    <div
      className={`hud-glass flex items-center gap-1.5 rounded-md px-2 py-1 ${
        empty ? "opacity-35" : ""
      }`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold ${accentColor}`}
      >
        {keyName}
      </span>
      <span className="text-[10px] font-medium text-white/75">{slug}</span>
      <span className="hud-mono text-[10px] font-bold text-white/90">
        {count}
      </span>
    </div>
  );
}

function WeatherIcon({ weather }: { weather: string }) {
  const icon =
    weather === "NIGHT"
      ? "🌙"
      : weather === "RAIN"
        ? "🌧"
        : weather === "FOG"
          ? "🌫"
          : weather === "CLOUDY"
            ? "☁"
            : "☀";
  return <span className="text-sm">{icon}</span>;
}

function formatTime(tod: number): string {
  const h = Math.floor(tod);
  const m = Math.floor((tod - h) * 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}
