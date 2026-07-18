"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Coins, Lock, Sparkles, X, Check, ChevronRight } from "lucide-react";
import {
  useGameStore, RARITY_COLORS, type Rarity,
} from "@/lib/game/store";
import { WRAPS, type WrapSlug } from "@/lib/game/Wraps";
import { CHARMS, type CharmSlug } from "@/lib/game/Charms";
import { FINISHERS, type FinisherSlug } from "@/lib/game/systems/FinisherSystem";
import { useProfile } from "@/lib/game/useProfile";
import { toast } from "sonner";

/**
 * PackScreen — Task 2-d Prompt 12.
 *
 * Case-opening-style UI:
 *   - 3 crates (Tactical / Elite / Legendary) with different prices + drop tables.
 *   - Weighted drop table over wrap/charm/finisher items.
 *   - Horizontal spinner that scrolls through items, decelerates, and lands
 *     on the won item with a dramatic reveal + particle burst.
 *   - Drop odds shown as percentages for transparency.
 *   - Open button with credits check + ownership grant.
 *   - Glass-morphism + spring-physics style consistent with the rest of the menu.
 *
 * Rendered as a full-screen overlay (parent — typically ShopScreen — gates
 * visibility and provides onClose).
 */

// ─── Drop table types ────────────────────────────────────────

type PackItemKind = "wrap" | "charm" | "finisher";
interface PackItem {
  kind: PackItemKind;
  slug: WrapSlug | CharmSlug | FinisherSlug;
  name: string;
  rarity: Rarity;
  weight: number;
}

interface CrateConfig {
  slug: string;
  name: string;
  desc: string;
  price: number;
  accent: string; // hex
  items: PackItem[];
}

// ─── Catalog helpers ─────────────────────────────────────────

function wrapItem(slug: WrapSlug, weight: number): PackItem {
  return { kind: "wrap", slug, name: WRAPS[slug].name, rarity: WRAPS[slug].rarity, weight };
}
function charmItem(slug: CharmSlug, weight: number): PackItem {
  const c = CHARMS[slug];
  if (!c) throw new Error(`Unknown charm ${slug}`);
  return { kind: "charm", slug, name: c.name, rarity: c.rarity, weight };
}
function finisherItem(slug: FinisherSlug, weight: number): PackItem {
  return { kind: "finisher", slug, name: FINISHERS[slug].name, rarity: FINISHERS[slug].rarity, weight };
}

// ─── Crates ──────────────────────────────────────────────────

const CRATES: CrateConfig[] = [
  {
    slug: "tactical",
    name: "Tactical Crate",
    desc: "Standard issue. Mostly commons + rares.",
    price: 800,
    accent: "#9ca3af",
    items: [
      wrapItem("woodland_camo", 30),
      wrapItem("desert_digital", 25),
      wrapItem("carbon_black", 20),
      charmItem("dice_charm", 12),
      charmItem("dogtag_charm", 10),
      wrapItem("arctic_tiger", 3),
    ],
  },
  {
    slug: "elite",
    name: "Elite Crate",
    desc: "Premium odds. Rares + epics, with a shot at legendaries.",
    price: 2200,
    accent: "#a855f7",
    items: [
      wrapItem("urban_hex", 25),
      wrapItem("crimson_gradient", 20),
      charmItem("skull_charm", 16),
      charmItem("feather_charm", 14),
      charmItem("lightning_charm", 10),
      charmItem("flame_charm", 8),
      wrapItem("neon_geometric", 4),
      wrapItem("gold_damascus", 2),
      finisherItem("suplex", 1),
    ],
  },
  {
    slug: "legendary",
    name: "Legendary Crate",
    desc: "Top tier. Guaranteed epic+. Real shot at the shark.",
    price: 5000,
    accent: "#f59e0b",
    items: [
      charmItem("shark_charm", 28),
      wrapItem("gold_damascus", 22),
      wrapItem("neon_geometric", 18),
      finisherItem("shark", 12),
      finisherItem("disintegrate", 10),
      finisherItem("squish", 6),
      charmItem("lightning_charm", 2),
      charmItem("flame_charm", 2),
    ],
  },
];

// ─── Weighted random ─────────────────────────────────────────
// Prompt J-4072 — `pickWeighted` was previously dead code (the server
// does the real roll; the client only needed a uniform filler picker
// for the spinner track). Removed. The spinner filler now uses
// `Math.random()` directly (see handleOpen). If a future feature needs
// weighted filler (e.g. visual hint of rarity distribution), re-introduce
// a `pickWeightedFiller` here — but it would be visual-only, NOT the roll.

function itemProbability(crate: CrateConfig, item: PackItem): number {
  const total = crate.items.reduce((s, i) => s + i.weight, 0);
  return (item.weight / total) * 100;
}

// ─── Component ───────────────────────────────────────────────

export function PackScreen({ onClose }: { onClose: () => void }) {
  const profile = useGameStore((s) => s.profile);
  const setProfile = useGameStore((s) => s.setProfile);
  const { refresh } = useProfile();
  const [selectedCrate, setSelectedCrate] = useState<CrateConfig>(CRATES[0]);
  const [opening, setOpening] = useState(false);
  const [revealed, setRevealed] = useState<PackItem | null>(null);
  const [showOdds, setShowOdds] = useState(false);

  // ── Spinner state ──
  const [spinItems, setSpinItems] = useState<PackItem[]>([]);
  const [spinOffset, setSpinOffset] = useState(0);
  const spinTrackRef = useRef<HTMLDivElement>(null);
  const ITEM_W = 140; // px per item in the spinner track
  const FOCUS_INDEX = 4; // landing item index within the visible window

  // Reset reveal when the user picks a different crate.
  useEffect(() => {
    setRevealed(null);
    setSpinItems([]);
    setSpinOffset(0);
  }, [selectedCrate.slug]);

  const handleOpen = async () => {
    if (opening) return;
    if (profile.credits < selectedCrate.price) {
      toast.error("Insufficient credits");
      return;
    }
    setOpening(true);
    setRevealed(null);

    // Task-1 (SEC) item 4 — call the server-authoritative /api/packs/open
    // route. The server debits credits, rolls the pack with crypto-grade
    // randomness, writes a LootBoxRoll audit row, and returns the rolled
    // item + a signed CurrencyReceipt. The client no longer rolls locally
    // — `pickWeighted` is used only to build the spinner's filler track
    // (visual-only; the winner comes from the server response).
    let winner: PackItem | null = null;
    let serverCredits: number | null = null;
    try {
      const res = await fetch("/api/packs/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packSlug: selectedCrate.slug,
          clientPrice: selectedCrate.price,
        }),
      });
      const data = (await res.json()) as {
        item?: { kind: PackItemKind; slug: string; name: string; rarity: Rarity };
        credits?: number;
        error?: string;
      };
      if (!res.ok || !data.item) {
        throw new Error(data.error ?? `Pack open failed (HTTP ${res.status})`);
      }
      // Map the server response back into the local PackItem shape so the
      // spinner + reveal modal can render it. We trust the server for the
      // rolled item; the local crate's `items` list is just for the visual
      // filler track.
      const localMatch = selectedCrate.items.find(
        (it) => it.kind === data.item!.kind && it.slug === data.item!.slug,
      );
      winner = localMatch ?? {
        kind: data.item.kind,
        slug: data.item.slug as PackItem["slug"],
        name: data.item.name,
        rarity: data.item.rarity,
        weight: 0,
      };
      serverCredits = typeof data.credits === "number" ? data.credits : null;
    } catch (err) {
      setOpening(false);
      toast.error(err instanceof Error ? err.message : "Pack open failed");
      return;
    }

    // Optimistically deduct credits locally so the UI feels responsive —
    // the server's authoritative balance arrives via `refresh()` below.
    if (serverCredits !== null) {
      setProfile({ credits: serverCredits });
    } else {
      setProfile({ credits: profile.credits - selectedCrate.price });
    }

    // Build a long random scroll track. Insert the winner at a known index
    // (FOCUS_INDEX) near the end, so the spinner can decelerate onto it.
    const totalItems = 40;
    const fillerPool = selectedCrate.items;
    const items: PackItem[] = [];
    // `winner` is non-null here — the early `throw` above guarantees it,
    // but TS doesn't narrow across the closure, so we capture a local.
    const confirmedWinner: PackItem = winner;
    for (let i = 0; i < totalItems; i++) {
      if (i === FOCUS_INDEX + 30) {
        items.push(confirmedWinner);
      } else {
        // Random filler from the same crate.
        items.push(fillerPool[Math.floor(Math.random() * fillerPool.length)]);
      }
    }
    // The winner lands at index 30+FOCUS_INDEX. We'll center it.
    const winnerIndex = 30 + FOCUS_INDEX;
    setSpinItems(items);

    // Reset offset to 0, then animate to center the winner under the marker.
    setSpinOffset(0);
    // Defer the animation to the next tick so the initial state renders first.
    requestAnimationFrame(() => {
      // Compute target offset: center the winner item under the marker.
      // Marker is at the middle of the viewport. The track starts at x=0.
      // Track item width is ITEM_W. Center of winner = winnerIndex * ITEM_W + ITEM_W/2.
      // We want this center at the viewport center, so offset = -(winnerCenter - viewportWidth/2).
      const viewportWidth = spinTrackRef.current?.parentElement?.clientWidth ?? 600;
      const targetOffset = viewportWidth / 2 - (winnerIndex * ITEM_W + ITEM_W / 2);
      // Use a long spring transition for the deceleration feel.
      setSpinOffset(targetOffset);
    });

    // After the spin animation completes, reveal the winner.
    setTimeout(() => {
      setRevealed(confirmedWinner);
      setOpening(false);
      // Prompt J-4073 — grantOwnership was previously client-only + ran
      // BEFORE the server-persisted ownership landed. The visual grant
      // is now removed — the `refresh()` call below pulls the
      // server-authoritative ownedWraps/ownedCharms/ownedFinishers lists
      // + credits. This means there's a ~200ms window where the just-won
      // item doesn't yet show as owned in the odds table, but that's
      // preferable to the previous behaviour of locally-granting an item
      // the server might not have persisted (e.g. on a network failure).
      // Prompt J-4074 — finishers persisted via localStorage cache since
      // the PlayerProfile type doesn't yet have an `ownedFinishers` field.
      // The `refresh()` pulls wrap/charm ownership from the server; this
      // local cache handles finishers so the odds table reflects them.
      if (confirmedWinner.kind === "finisher") {
        try {
          const raw = localStorage.getItem("pr_owned_finishers");
          const set: string[] = raw ? JSON.parse(raw) : [];
          if (!set.includes(confirmedWinner.slug)) {
            set.push(confirmedWinner.slug);
            localStorage.setItem("pr_owned_finishers", JSON.stringify(set));
          }
        } catch { /* localStorage unavailable — non-fatal */ }
      }
      // Refresh profile from server so the authoritative balance + any
      // server-side state lands in the client store.
      refresh();
    }, 4200);
  };

  /** Prompt J-4073 — local grantOwnership removed. The server's
   *  /api/packs/open route persists wrap/charm ownership; the client's
   *  `refresh()` call pulls it. Finishers are persisted via the
   *  localStorage cache (J-4074) above since PlayerProfile doesn't yet
   *  have an `ownedFinishers` field. */
  const alreadyOwned = (item: PackItem | null): boolean => {
    if (!item) return false;
    if (item.kind === "wrap") return profile.ownedWraps.includes(item.slug as WrapSlug);
    if (item.kind === "charm") return profile.ownedCharms.includes(item.slug as CharmSlug);
    // Prompt J-4074 — finisher ownership checked via the localStorage cache.
    if (item.kind === "finisher") {
      try {
        const raw = localStorage.getItem("pr_owned_finishers");
        const set: string[] = raw ? JSON.parse(raw) : [];
        return set.includes(item.slug);
      } catch { return false; }
    }
    return false;
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 flex flex-col bg-[#08090c] text-white"
    >
      {/* Ambient backdrop. */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0c0e0a] via-[#08090c] to-[#050607]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_30%,rgba(168,85,247,0.10),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_55%_45%_at_50%_80%,rgba(255,140,26,0.08),transparent_60%)]" />
      </div>

      <header className="relative z-10 flex items-center justify-between border-b border-white/[0.05] px-6 py-4 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.04] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
              <Sparkles className="h-4 w-4 text-amber-400" /> Packs
            </h1>
            <p className="text-[11px] text-white/40">Open crates for wraps, charms + finishers</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowOdds((v) => !v)}
            className="flex h-9 items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.04] px-4 text-[11px] font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            {showOdds ? "Hide" : "Show"} odds
          </button>
          <div className="flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3.5 py-1.5">
            <Coins className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-sm font-bold tabular-nums text-amber-300">{profile.credits.toLocaleString()}</span>
          </div>
        </div>
      </header>

      <div className="relative z-10 flex flex-1 flex-col gap-6 overflow-y-auto p-6">
        {/* Crate selector */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {CRATES.map((c) => {
            const active = selectedCrate.slug === c.slug;
            const affordable = profile.credits >= c.price;
            return (
              <motion.button
                key={c.slug}
                onClick={() => !opening && setSelectedCrate(c)}
                whileHover={!opening ? { y: -4, scale: 1.01 } : undefined}
                whileTap={!opening ? { scale: 0.99 } : undefined}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                className="relative overflow-hidden rounded-2xl border bg-white/[0.04] p-5 text-left backdrop-blur-2xl"
                style={{ borderColor: active ? c.accent : "rgba(255,255,255,0.08)" }}
              >
                {active && (
                  <div className="absolute left-0 right-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${c.accent}, ${c.accent}00)` }} />
                )}
                <div className="mb-3 flex items-center justify-between">
                  {/* Crate icon — stylized box. */}
                  <div className="relative h-16 w-20" style={{ perspective: "200px" }}>
                    <motion.div
                      animate={active ? { rotateY: [0, 8, -8, 0], y: [0, -2, 0] } : {}}
                      transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                      className="absolute inset-0 rounded-md border-2"
                      style={{
                        borderColor: c.accent,
                        background: `linear-gradient(135deg, ${c.accent}40, ${c.accent}10)`,
                        boxShadow: `0 0 24px ${c.accent}40, inset 0 0 12px ${c.accent}30`,
                      }}
                    >
                      <div className="absolute left-1/2 top-1/2 h-1 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: c.accent }} />
                      <div className="absolute left-1/2 top-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: c.accent }} />
                    </motion.div>
                  </div>
                  <Sparkles className="h-4 w-4" style={{ color: c.accent }} />
                </div>
                <div className="text-base font-bold">{c.name}</div>
                <div className="mb-3 text-[11px] text-white/45">{c.desc}</div>
                <div className="flex items-center gap-1.5 text-sm font-bold" style={{ color: affordable ? c.accent : "rgba(255,255,255,0.4)" }}>
                  {!affordable && <Lock className="h-3.5 w-3.5" />}
                  <Coins className="h-3.5 w-3.5" />
                  {c.price.toLocaleString()}
                </div>
              </motion.button>
            );
          })}
        </div>

        {/* Selected crate — drop odds + spinner + open button */}
        <div className="flex flex-col gap-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 backdrop-blur-2xl">
          {/* Drop odds table (collapsible). */}
          <AnimatePresence>
            {showOdds && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/40">Drop odds — {selectedCrate.name}</div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
                  {[...selectedCrate.items].sort((a, b) => b.weight - a.weight).map((it) => {
                    const pct = itemProbability(selectedCrate, it);
                    const owned = alreadyOwned(it);
                    return (
                      <div key={`${it.kind}-${it.slug}`} className="flex items-center justify-between text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium" style={{ color: RARITY_COLORS[it.rarity] }}>{it.name}</span>
                          {owned && <Check className="h-2.5 w-2.5 text-emerald-400" />}
                          <span className="text-white/30">· {it.kind}</span>
                        </div>
                        <span className="font-bold tabular-nums text-white/70">{pct.toFixed(1)}%</span>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Spinner */}
          <div className="relative overflow-hidden rounded-xl border border-white/[0.06] bg-black/40 py-4">
            {/* Center marker (top + bottom ticks + center line). */}
            <div className="pointer-events-none absolute left-1/2 top-0 z-20 h-full w-px -translate-x-1/2 bg-amber-400/60 shadow-[0_0_8px_rgba(255,140,26,0.7)]" />
            <div className="pointer-events-none absolute left-1/2 top-0 z-20 -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-amber-400" />
            <div className="pointer-events-none absolute bottom-0 left-1/2 z-20 -translate-x-1/2 border-x-4 border-b-4 border-x-transparent border-b-amber-400" />

            <div ref={spinTrackRef} className="relative">
              <motion.div
                className="flex gap-2"
                animate={{ x: spinOffset }}
                transition={opening
                  ? { duration: 4.0, ease: [0.16, 1, 0.3, 1] } // long ease-out for deceleration
                  : { duration: 0.2 }
                }
              >
                {spinItems.length === 0 ? (
                  // Placeholder — initial state (no spin yet).
                  <div className="flex h-32 w-full items-center justify-center text-[11px] uppercase tracking-wider text-white/30">
                    Press OPEN to spin
                  </div>
                ) : (
                  spinItems.map((it, i) => (
                    <div
                      key={i}
                      className="flex h-32 shrink-0 flex-col items-center justify-center rounded-lg border bg-white/[0.04] px-3"
                      style={{
                        width: `${ITEM_W - 8}px`,
                        borderColor: `${RARITY_COLORS[it.rarity]}40`,
                      }}
                    >
                      <div className="mb-1 h-12 w-12 rounded-md" style={{
                        background: `linear-gradient(135deg, ${RARITY_COLORS[it.rarity]}, ${RARITY_COLORS[it.rarity]}40)`,
                        boxShadow: `inset 0 0 16px ${RARITY_COLORS[it.rarity]}60`,
                      }} />
                      <div className="text-center text-[10px] font-bold leading-tight">{it.name}</div>
                      <div className="text-[9px] uppercase tracking-wider" style={{ color: RARITY_COLORS[it.rarity] }}>{it.rarity}</div>
                    </div>
                  ))
                )}
              </motion.div>
            </div>
          </div>

          {/* Open button */}
          <div className="flex items-center justify-center gap-3">
            <motion.button
              onClick={handleOpen}
              disabled={opening || profile.credits < selectedCrate.price}
              whileHover={!opening && profile.credits >= selectedCrate.price ? { scale: 1.02 } : undefined}
              whileTap={!opening && profile.credits >= selectedCrate.price ? { scale: 0.97 } : undefined}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="flex h-12 items-center gap-2 rounded-full bg-gradient-to-r from-amber-500 to-amber-600 px-8 text-sm font-bold text-black shadow-[0_0_20px_rgba(255,140,26,0.35)] disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              {opening ? "Spinning…" : <>Open — <Coins className="ml-1 inline h-3.5 w-3.5" /> {selectedCrate.price.toLocaleString()}</>}
            </motion.button>
          </div>
        </div>
      </div>

      {/* Reveal modal */}
      <AnimatePresence>
        {revealed && (
          <RevealModal
            item={revealed}
            alreadyOwned={alreadyOwned(revealed)}
            onClose={() => { setRevealed(null); setSpinItems([]); }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Reveal modal ────────────────────────────────────────────

function RevealModal({ item, alreadyOwned, onClose }: { item: PackItem; alreadyOwned: boolean; onClose: () => void }) {
  const rarityColor = RARITY_COLORS[item.rarity];
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-2xl"
      onClick={onClose}
    >
      {/* Particle burst — concentric rings. */}
      <motion.div
        initial={{ scale: 0, opacity: 0.8 }}
        animate={{ scale: 2.5, opacity: 0 }}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
        className="absolute h-64 w-64 rounded-full border-4"
        style={{ borderColor: rarityColor }}
      />
      <motion.div
        initial={{ scale: 0, opacity: 0.8 }}
        animate={{ scale: 3.5, opacity: 0 }}
        transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
        className="absolute h-64 w-64 rounded-full border-2"
        style={{ borderColor: rarityColor }}
      />

      <motion.div
        initial={{ scale: 0.7, opacity: 0, y: 30 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: "spring", stiffness: 280, damping: 22 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md rounded-3xl border bg-white/[0.04] p-8 text-center backdrop-blur-2xl"
        style={{ borderColor: `${rarityColor}60`, boxShadow: `0 0 48px ${rarityColor}40` }}
      >
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-white/50">You unboxed</div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wider" style={{ color: rarityColor }}>{item.rarity}</div>
        <motion.div
          animate={{ rotate: [0, 2, -2, 0], y: [0, -4, 0] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
          className="mx-auto my-5 h-32 w-32 rounded-2xl"
          style={{
            background: `linear-gradient(135deg, ${rarityColor}, ${rarityColor}40)`,
            boxShadow: `inset 0 0 30px ${rarityColor}80, 0 0 36px ${rarityColor}60`,
          }}
        />
        <h2 className="text-2xl font-bold tracking-tight">{item.name}</h2>
        <p className="mt-1 text-[11px] uppercase tracking-wider text-white/40">{item.kind}</p>

        {alreadyOwned ? (
          <div className="mt-4 rounded-full bg-white/[0.04] px-4 py-2 text-[11px] font-medium text-white/60">
            Duplicate — credits refunded ×0.3 (demo)
          </div>
        ) : (
          <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-4 py-2 text-[11px] font-semibold text-emerald-400">
            <Check className="h-3.5 w-3.5" /> Added to inventory
          </div>
        )}

        <button
          onClick={onClose}
          className="mt-6 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-white text-sm font-semibold text-black transition-transform hover:scale-[1.02] active:scale-95"
        >
          <ChevronRight className="h-4 w-4" /> Continue
        </button>
      </motion.div>

      <button
        onClick={onClose}
        className="absolute right-6 top-6 flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.04] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
    </motion.div>
  );
}
