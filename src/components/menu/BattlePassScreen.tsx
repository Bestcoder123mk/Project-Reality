"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Lock, Crown, Gift, Coins, Check } from "lucide-react";
import { useGameStore, WEAPONS, ATTACHMENTS, SKINS, RARITY_COLORS } from "@/lib/game/store";
import { useProfile } from "@/lib/game/useProfile";
import { toast } from "sonner";

interface Tier {
  id: string; tier: number; isPremium: boolean; rewardType: "CREDITS" | "WEAPON" | "SKIN" | "ATTACHMENT";
  rewardSlug: string; rewardAmount: number; claimed: boolean; claimable: boolean;
}
interface BattlePassData {
  season: { id: string; season: number; name: string; tierSize: number; maxTier: number; premiumPrice: number; active: boolean };
  tiers: Tier[];
  progress: { tier: number; xp: number; premium: boolean; claimedTiers: Array<{ tier: number; isPremium: boolean }>; nextTierXp: number };
  currentTier: number;
}

export function BattlePassScreen() {
  const profile = useGameStore((s) => s.profile);
  const setPhase = useGameStore((s) => s.setPhase);
  const { refresh, claimBattlePass, unlockPremium } = useProfile();
  const [data, setData] = useState<BattlePassData | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/battlepass");
      if (res.ok) {
        setData(await res.json());
      } else {
        // Prompt J-4075 — surface a toast on failure (was silently swallowed).
        const err = await res.json().catch(() => ({ error: "Failed to load battle pass" }));
        toast.error(err.error ?? `Failed to load battle pass (HTTP ${res.status})`);
      }
    } catch (e) {
      // Network error — also toast.
      toast.error(e instanceof Error ? e.message : "Network error loading battle pass");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const handleClaim = async (tier: number, isPremium: boolean) => {
    setClaiming(`${tier}-${isPremium}`);
    try {
      await claimBattlePass(tier, isPremium);
      await load();
      toast.success("Reward claimed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setClaiming(null);
    }
  };

  const handlePremium = async () => {
    try {
      await unlockPremium();
      await load();
      toast.success("Premium unlocked");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  // Prompt J-4076 — jump-to-tier button. The tier track renders all 50
  // tiers horizontally; without a jump button the player has to scroll
  // manually to find their current tier. The button scrolls the current
  // tier into view smoothly.
  const trackRef = useRef<HTMLDivElement>(null);
  const jumpToCurrentTier = () => {
    const track = trackRef.current;
    if (!track || !data) return;
    // Each tier column is 160px wide (w-40) + 12px gap (gap-3).
    const TIER_W = 160 + 12;
    const targetX = (currentTier - 1) * TIER_W;
    track.scrollTo({ left: targetX, behavior: "smooth" });
  };

  const rewardLabel = (t: Tier) => {
    if (t.rewardType === "CREDITS") return { name: `${t.rewardAmount} Credits`, icon: Coins, color: "#fbbf24" };
    if (t.rewardType === "WEAPON") { const w = WEAPONS[t.rewardSlug as keyof typeof WEAPONS]; return { name: w?.name ?? t.rewardSlug, icon: Gift, color: RARITY_COLORS[w?.rarity ?? "COMMON"] }; }
    if (t.rewardType === "SKIN") { const s = SKINS[t.rewardSlug as keyof typeof SKINS]; return { name: s?.name ?? t.rewardSlug, icon: Gift, color: RARITY_COLORS[s?.rarity ?? "COMMON"] }; }
    const a = ATTACHMENTS[t.rewardSlug as AttachmentSlugKey]; return { name: a?.name ?? t.rewardSlug, icon: Gift, color: RARITY_COLORS[a?.rarity ?? "COMMON"] };
  };

  const currentTier = data?.currentTier ?? 0;
  const tierSize = data?.season.tierSize ?? 1000;
  const xpInTier = (data?.progress.xp ?? 0) % tierSize;
  const tierProgress = (xpInTier / tierSize) * 100;

  if (loading) {
    return <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#0a0a0c] text-white/40">Loading battle pass…</div>;
  }
  if (!data) return null;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#0a0a0c] text-white">
      <header className="flex items-center justify-between border-b border-white/5 px-6 py-4">
        <div className="flex items-center gap-4">
          <button onClick={() => setPhase("menu")} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-white/60 transition-colors hover:bg-white/10 hover:text-white">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-lg font-bold tracking-tight">{data.season.name}</h1>
            <p className="text-[11px] text-white/40">Season {data.season.season} · Battle Pass</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3.5 py-1.5">
            <span className="text-xs font-semibold text-amber-400">◈</span>
            <span className="text-sm font-bold tabular-nums text-amber-300">{profile.credits.toLocaleString()}</span>
          </div>
          {!data.progress.premium ? (
            <button onClick={handlePremium} className="flex h-9 items-center gap-2 rounded-full bg-gradient-to-r from-amber-400 to-orange-500 px-4 text-xs font-bold text-black transition-transform hover:scale-[1.03]">
              <Crown className="h-3.5 w-3.5" /> Unlock Premium · {data.season.premiumPrice}
            </button>
          ) : (
            <div className="flex h-9 items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-4 text-xs font-bold text-amber-300">
              <Crown className="h-3.5 w-3.5" /> PREMIUM
            </div>
          )}
        </div>
      </header>

      {/* Progress */}
      <div className="border-b border-white/5 px-6 py-4">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="font-medium text-white/60">Tier {currentTier} / {data.season.maxTier}</span>
          <span className="tabular-nums text-white/40">{xpInTier} / {tierSize} XP</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <motion.div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500" animate={{ width: `${tierProgress}%` }} transition={{ duration: 0.4 }} />
        </div>
        {/* Prompt J-4076 — Jump to current tier button. */}
        <div className="mt-2 flex justify-end">
          <button
            onClick={jumpToCurrentTier}
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-medium text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white"
            aria-label="Jump to current tier"
          >
            Jump to Tier {currentTier} →
          </button>
        </div>
      </div>

      {/* Tier track */}
      <div ref={trackRef} className="flex-1 overflow-x-auto overflow-y-hidden p-6">
        <div className="flex gap-3" style={{ minWidth: "min-content" }}>
          {Array.from({ length: data.season.maxTier }, (_, i) => {
            const tierNum = i + 1;
            const freeTier = data.tiers.find((t) => t.tier === tierNum && !t.isPremium);
            const premTier = data.tiers.find((t) => t.tier === tierNum && t.isPremium);
            const reached = tierNum <= currentTier;
            return (
              <div key={tierNum} className="flex w-40 flex-col gap-2">
                <div className="text-center text-xs font-bold text-white/50">TIER {tierNum}</div>
                {/* Free reward */}
                <TierCard tier={freeTier} reached={reached} premium={false} rewardLabel={rewardLabel} onClaim={handleClaim} claiming={claiming} currentTier={currentTier} />
                {/* Premium reward */}
                <TierCard tier={premTier} reached={reached} premium={true} rewardLabel={rewardLabel} onClaim={handleClaim} claiming={claiming} currentTier={currentTier} locked={!data.progress.premium} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TierCard({ tier, reached, premium, rewardLabel, onClaim, claiming, currentTier, locked }: {
  tier: Tier | undefined; reached: boolean; premium: boolean;
  rewardLabel: (t: Tier) => { name: string; icon: typeof Gift; color: string };
  onClaim: (tier: number, isPremium: boolean) => void; claiming: string | null; currentTier: number; locked?: boolean;
}) {
  if (!tier) return <div className="h-32" />;
  const r = rewardLabel(tier);
  const Icon = r.icon;
  const isClaiming = claiming === `${tier.tier}-${tier.isPremium}`;
  const canClaim = reached && !tier.claimed && !locked;

  return (
    <div className={`relative flex h-32 flex-col rounded-xl border p-2.5 transition-all ${premium ? "border-amber-500/30 bg-amber-500/[0.04]" : "border-white/10 bg-white/[0.03]"} ${reached ? "opacity-100" : "opacity-50"}`}>
      <div className="mb-1 flex items-center justify-between">
        <span className={`text-[9px] font-bold uppercase tracking-wider ${premium ? "text-amber-400" : "text-white/40"}`}>{premium ? "Premium" : "Free"}</span>
        {tier.claimed && <Check className="h-3 w-3 text-emerald-400" />}
        {locked && <Lock className="h-3 w-3 text-amber-400/50" />}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-1">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ backgroundColor: `${r.color}20` }}>
          <Icon className="h-4 w-4" style={{ color: r.color }} />
        </div>
        <div className="text-center text-[10px] font-medium leading-tight text-white/70">{r.name}</div>
      </div>
      {canClaim && (
        <button
          onClick={() => onClaim(tier.tier, tier.isPremium)}
          disabled={isClaiming}
          className="mt-1 h-7 rounded-lg bg-white text-[10px] font-bold text-black transition-transform hover:scale-[1.03] active:scale-95 disabled:opacity-60"
        >
          {isClaiming ? "…" : "CLAIM"}
        </button>
      )}
      {!reached && !tier.claimed && (
        <div className="mt-1 text-center text-[9px] font-medium text-white/30">Tier {tier.tier}</div>
      )}
    </div>
  );
}

type AttachmentSlugKey = "suppressor" | "compensator" | "red_dot" | "holo" | "acog" | "scope8x" | "foregrip" | "angled_grip" | "ext_mag" | "quick_mag";
