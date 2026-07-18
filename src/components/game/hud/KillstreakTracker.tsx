"use client";

import { useEffect, useRef, useState } from "react";
import { Radar, Bomb, Zap, Shield, Skull, type LucideIcon } from "lucide-react";

/**
 * V2.2 + V5.4 — Killstreak tracker (bottom-right, above the ammo cluster).
 *
 * Shows the current streak count, the next reward threshold, and the
 * ready/in-use state of the configured reward tiers.
 *
 * Prompt J-4043 — previously hardcoded to exactly 2 rewards (recon drone
 * @ 3 kills, airstrike @ 7 kills). Adding a third reward required code
 * changes (the reward map + the hotkey UI + the HudSystem publisher).
 * Now the rewards are data-driven via `KILLSTREAK_REWARDS`: each entry
 * defines { threshold, slug, label, icon, hotkey, readyField, activeField,
 * remainingField }. The HudSystem publishes a generic map of slug → state;
 * the tracker renders any reward whose threshold has been reached.
 *
 * Adding a new reward is now a one-line config change here + a wire in
 * HudSystem to publish the new state field.
 */

/** Config for a single killstreak reward tier. */
interface KillstreakRewardConfig {
  /** Kill count at which the reward unlocks. */
  threshold: number;
  /** Stable slug — matches the field on `window.__PR_KILLSTREAK__`. */
  slug: "recon" | "airstrike" | "supplyDrop" | "emp" | "gunship";
  /** Display label. */
  label: string;
  /** Icon (lucide). */
  icon: LucideIcon;
  /** Hotkey to invoke the reward when ready. */
  hotkey: string;
}

/**
 * The canonical reward table. To add a new reward, append a config entry
 * + extend the `slug` union + wire the matching state field in HudSystem
 * (which publishes `window.__PR_KILLSTREAK__`).
 */
const KILLSTREAK_REWARDS: KillstreakRewardConfig[] = [
  { threshold: 3, slug: "recon",      label: "RECON",   icon: Radar,  hotkey: "4" },
  { threshold: 7, slug: "airstrike",  label: "STRIKE",  icon: Bomb,   hotkey: "5" },
  // Prompt J-4043 — extensible: additional tiers can be enabled by
  // un-commenting these + wiring the HudSystem publisher. Kept commented
  // so the UI doesn't render rewards the engine can't yet fulfill.
  // { threshold: 10, slug: "supplyDrop", label: "SUPPLY", icon: Shield, hotkey: "6" },
  // { threshold: 12, slug: "emp",        label: "EMP",    icon: Zap,    hotkey: "7" },
  // { threshold: 15, slug: "gunship",    label: "GUNSHIP", icon: Skull, hotkey: "8" },
];

export function KillstreakTracker() {
  const [data, setData] = useState<{
    streak: number;
    reconReady: boolean;
    airstrikeReady: boolean;
    reconActive: boolean;
    reconRemainingMs: number;
    // Prompt J-4043 — extensible fields. The HudSystem publisher can
    // add additional `*Ready`/`*Active`/`*RemainingMs` fields as it
    // wires new reward tiers; the tracker reads them via dynamic key
    // lookup so the UI doesn't need code changes per reward.
    [k: string]: number | boolean | undefined;
  }>({ streak: 0, reconReady: false, airstrikeReady: false, reconActive: false, reconRemainingMs: 0 });

  const rafRef = useRef<number>(0);
  useEffect(() => {
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const d = window.__PR_KILLSTREAK__;
      if (d) {
        setData({
          streak: d.streak,
          reconReady: d.reconReady,
          airstrikeReady: d.airstrikeReady,
          reconActive: d.reconActive,
          reconRemainingMs: d.reconRemainingMs,
        });
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Prompt J-4043 — render only rewards whose threshold has been reached.
  const unlockedRewards = KILLSTREAK_REWARDS.filter(
    (r) => data.streak >= r.threshold || data[`${r.slug}Ready`] || data[`${r.slug}Active`],
  );
  const showTracker = data.streak > 0 || unlockedRewards.length > 0;
  if (!showTracker) return null;

  // Next threshold indicator.
  const nextReward = KILLSTREAK_REWARDS.find((r) => data.streak < r.threshold) ?? null;
  const nextTier = nextReward?.threshold ?? null;
  const tierProgress = nextTier ? Math.min(1, data.streak / nextTier) : 1;

  return (
    <div className="tactical-panel flex flex-col gap-1.5 px-3 py-2">
      {/* Streak count */}
      <div className="flex items-center gap-2">
        <span className="hud-label">Streak</span>
        <span className="hud-mono text-base font-bold text-amber-300 tabular">
          {data.streak}
        </span>
        {nextTier && (
          <span className="hud-mono text-[9px] text-white/40">/{nextTier}</span>
        )}
      </div>

      {/* Next-tier progress bar (segmented pips) */}
      {nextTier && (
        <div className="flex gap-0.5">
          {Array.from({ length: nextTier }).map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 ${i < data.streak ? "bg-amber-400" : "bg-white/10"}`}
            />
          ))}
        </div>
      )}

      {/* Reward tiles (one per unlocked tier) */}
      {unlockedRewards.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {unlockedRewards.map((r) => {
            const ready = Boolean(data[`${r.slug}Ready`]);
            const active = Boolean(data[`${r.slug}Active`]);
            const remainingMs = (data[`${r.slug}RemainingMs`] as number | undefined) ?? 0;
            return (
              <RewardTile
                key={r.slug}
                icon={r.icon}
                label={r.label}
                hotkey={r.hotkey}
                ready={ready}
                active={active}
                remainingMs={remainingMs}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function RewardTile({
  icon: Icon,
  label,
  hotkey,
  ready,
  active,
  remainingMs,
}: {
  icon: LucideIcon;
  label: string;
  hotkey: string;
  ready: boolean;
  active: boolean;
  remainingMs: number;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 border px-2 py-1 ${
        active
          ? "border-emerald-400/50 bg-emerald-500/15"
          : ready
            ? "border-amber-400/50 bg-amber-500/15 animate-pulse"
            : "border-white/10 bg-white/[0.03]"
      }`}
    >
      <Icon className={`h-3 w-3 ${active ? "text-emerald-300" : ready ? "text-amber-300" : "text-white/40"}`} />
      <span className={`hud-mono text-[9px] font-bold ${active ? "text-emerald-300" : ready ? "text-amber-300" : "text-white/50"}`}>
        {label}
      </span>
      {active && (
        <span className="hud-mono text-[8px] text-emerald-300/80">
          {Math.ceil(remainingMs / 1000)}s
        </span>
      )}
      {ready && (
        <kbd className="hud-mono rounded-sm border border-white/15 bg-black/40 px-1 text-[8px] font-bold text-white/70">
          {hotkey}
        </kbd>
      )}
    </div>
  );
}
