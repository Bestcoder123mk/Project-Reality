"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Crosshair, Coins, Shield, Package, Heart, Bomb, Zap, Wind, Bot, Hexagon, Square, Play } from "lucide-react";
import { GameEngine } from "@/lib/game/engine";
import { useGameStore, type BuyStationItem } from "@/lib/game/store";
import { HUD } from "./HUD";
import { PauseScreen, DeathScreen, VictoryScreen } from "@/components/menu/Screens";

export function GameCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const phase = useGameStore((s) => s.phase);
  const locked = useGameStore((s) => s.locked);
  const settings = useGameStore((s) => s.settings);
  const loadout = useGameStore((s) => s.loadout);
  const setPhase = useGameStore((s) => s.setPhase);

  const inGame = phase === "playing" || phase === "paused" || phase === "dead" || phase === "victory";

  // Create engine once when entering the game
  useEffect(() => {
    if (!containerRef.current || !inGame) return;
    if (engineRef.current) return;

    const store = useGameStore.getState();
    const engine = new GameEngine(containerRef.current, store.settings, store.loadout);
    engineRef.current = engine;
    engine.attachDebugHelpers(); // DEBUG: wave transition + AI verification
    engine.start();

    // Prompt A#1 — pointer-lock engage/pause race fix lives in
    // context-factory.ts (requestPointerLock defers to rAF + pointerlockerror
    // retry). The "Click to Engage" overlay's onClick calls engine.resume()
    // which calls ctx.requestPointerLock() — the rAF callback inherits the
    // click's user-gesture context, so the first click engages on the first
    // try (was: race with canvas-not-yet-focusable on cold mount).

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [inGame]);

  // Sync settings to engine
  useEffect(() => {
    engineRef.current?.setSettings(settings);
  }, [settings]);

  // Sync loadout changes to engine (live weapon switching in-match)
  useEffect(() => {
    if (phase === "playing" && engineRef.current) {
      engineRef.current.setLoadout(loadout);
    }
  }, [loadout, phase]);

  // Drive engine paused state
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    const shouldRun = phase === "playing" && locked;
    e.setPaused(!shouldRun);
  }, [phase, locked]);

  const handleResume = () => {
    setPhase("playing");
    engineRef.current?.resume();
  };

  const handleRetry = () => {
    engineRef.current?.restart();
    setPhase("playing");
  };

  const handleQuit = () => {
    if (engineRef.current) {
      engineRef.current.dispose();
      engineRef.current = null;
    }
    useGameStore.getState().resetHud();
    useGameStore.getState().setLocked(false);
    setPhase("menu");
  };

  const showEngage = phase === "playing" && !locked;
  // Task-13 — suppress the "Click to Engage" overlay while the buy station
  // is open. The buy station releases pointer lock intentionally so the
  // player can mouse-click shop items; we don't want the engage overlay
  // stacked on top of the buy station panel.
  const buyStationOpen = useGameStore((s) => s.buyStationOpen);

  return (
    <>
      <div ref={containerRef} className="absolute inset-0" style={{ display: inGame ? "block" : "none" }} />
      {phase === "playing" && <HUD />}
      <AnimatePresence>
        {showEngage && !buyStationOpen && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => { useGameStore.getState().setPhase("playing"); engineRef.current?.resume(); }}
            className="absolute inset-0 z-40 flex cursor-pointer flex-col items-center justify-center bg-black/55 backdrop-blur-sm"
          >
            <motion.div
              animate={{ scale: [1, 1.08, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/20 bg-white/10 backdrop-blur-xl"
            >
              <Crosshair className="h-7 w-7 text-white" />
            </motion.div>
            <div className="text-2xl font-bold text-white">Click to Engage</div>
            <div className="mt-2 text-sm text-white/50">Lock your mouse to begin combat</div>
          </motion.button>
        )}
      </AnimatePresence>
      {/* Task-13 — Buy Station overlay (between waves). Rendered when the
          engine opens the buy station (store.buyStationOpen === true). The
          overlay is a full-screen tactical-styled React panel; pointer events
          are captured so the player can click items without firing weapons. */}
      <BuyStationOverlay />
      <PauseScreen onResume={handleResume} onQuit={handleQuit} />
      <DeathScreen onRetry={handleRetry} onQuit={handleQuit} />
      <VictoryScreen onRetry={handleRetry} onQuit={handleQuit} />
    </>
  );
}

// ============================================================================
// Task-13 — BuyStationOverlay (between-wave shop).
// ============================================================================

/** A 15-second countdown shown at the top of the buy station overlay.
 *  Note: avoids synchronous setState in the effect body (lint rule
 *  react-hooks/set-state-in-effect). The setInterval callback is async,
 *  so setState there is fine. On open, the first tick (100ms in) refreshes
 *  the displayed value. */
function useBuyStationCountdown() {
  const open = useGameStore((s) => s.buyStationOpen);
  const [remaining, setRemaining] = useState(15);
  useEffect(() => {
    if (!open) return;
    const start = performance.now();
    const id = setInterval(() => {
      const elapsed = (performance.now() - start) / 1000;
      const r = Math.max(0, 15 - elapsed);
      setRemaining(r);
      if (r <= 0) clearInterval(id);
    }, 100);
    return () => clearInterval(id);
  }, [open]);
  // When closed, return 15 (no setState — avoids the lint rule).
  return open ? remaining : 15;
}

/** Icon component for each buy station item slug. */
function ItemIcon({ slug, className }: { slug: string; className?: string }) {
  switch (slug) {
    case "armor_plate":   return <Shield className={className} />;
    case "ammo_box":      return <Package className={className} />;
    case "medkit":        return <Heart className={className} />;
    case "frag_grenade":  return <Bomb className={className} />;
    case "flashbang":     return <Zap className={className} />;
    case "smoke_grenade": return <Wind className={className} />;
    case "auto_turret":   return <Bot className={className} />;
    case "claymore":      return <Hexagon className={className} />;
    case "c4":            return <Square className={className} />;
    default:              return <Package className={className} />;
  }
}

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]";

function BuyStationOverlay() {
  const open = useGameStore((s) => s.buyStationOpen);
  const items = useGameStore((s) => s.buyStationItems);
  const credits = useGameStore((s) => s.profile.credits);
  const purchase = useGameStore((s) => s.buyStationPurchase);
  const ready = useGameStore((s) => s.buyStationReady);
  const remaining = useBuyStationCountdown();
  // Local feedback state — shows the last purchase result (success / error).
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);

  // Group items by category for the overlay layout.
  const grouped = useMemo(() => {
    const cats: Record<BuyStationItem["category"], BuyStationItem[]> = {
      Consumable: [],
      Grenade: [],
      Deployable: [],
    };
    for (const it of items) cats[it.category].push(it);
    return cats;
  }, [items]);

  const handlePurchase = (slug: string, name: string, price: number) => {
    const result = purchase(slug);
    setFlash({ ok: result.ok, msg: result.ok ? `Purchased ${name} (−${price})` : (result.error || "Purchase failed") });
    window.setTimeout(() => setFlash(null), 1800);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#08090c]/85 backdrop-blur-xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <motion.div
            initial={{ scale: 0.96, y: 12, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.96, y: 12, opacity: 0 }}
            transition={{ type: "spring", stiffness: 280, damping: 26 }}
            className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-amber-500/20 bg-gradient-to-b from-[#0e1015]/95 to-[#08090c]/95 shadow-[0_0_60px_rgba(255,140,26,0.18)]"
          >
            {/* Header — title + credits + countdown */}
            <div className="flex items-center justify-between gap-4 border-b border-amber-500/15 bg-amber-500/[0.04] px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10">
                  <Package className="h-5 w-5 text-amber-400" />
                </div>
                <div>
                  <h2 className="text-xl font-bold tracking-tight text-white">BUY STATION</h2>
                  <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-amber-300/60">Resupply · Prep · Deploy</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 rounded-xl border border-amber-500/15 bg-amber-500/[0.06] px-3 py-2">
                  <Coins className="h-4 w-4 text-amber-400" />
                  <span className="text-base font-bold tabular-nums text-amber-300">{credits.toLocaleString()}</span>
                  <span className="text-[10px] uppercase tracking-widest text-amber-300/50">CR</span>
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
                  <span className="text-[10px] uppercase tracking-widest text-white/40">Deploy in</span>
                  <span className="text-base font-bold tabular-nums text-white">{remaining.toFixed(1)}s</span>
                </div>
              </div>
            </div>

            {/* Body — item grid grouped by category */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <CategoryBlock title="Consumables" items={grouped.Consumable} credits={credits} onPurchase={handlePurchase} />
              <CategoryBlock title="Grenades" items={grouped.Grenade} credits={credits} onPurchase={handlePurchase} />
              <CategoryBlock title="Deployables" items={grouped.Deployable} credits={credits} onPurchase={handlePurchase} />
            </div>

            {/* Footer — READY button + flash feedback */}
            <div className="flex items-center justify-between gap-4 border-t border-amber-500/15 bg-amber-500/[0.04] px-6 py-4">
              <div className="min-h-[24px] flex-1 text-sm">
                <AnimatePresence mode="wait">
                  {flash ? (
                    <motion.span
                      key={flash.msg + flash.ok}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className={flash.ok ? "font-semibold text-emerald-400" : "font-semibold text-red-400"}
                    >
                      {flash.ok ? "✓ " : "✕ "}{flash.msg}
                    </motion.span>
                  ) : (
                    <span className="text-white/40">Click an item to purchase. Effects apply immediately.</span>
                  )}
                </AnimatePresence>
              </div>
              <button
                onClick={() => ready()}
                className={`flex h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-7 text-sm font-bold text-black shadow-[0_0_20px_rgba(255,140,26,0.35)] transition-transform hover:scale-[1.02] active:scale-95 ${FOCUS_RING}`}
              >
                <Play className="h-4 w-4 fill-black" /> READY
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CategoryBlock({
  title, items, credits, onPurchase,
}: {
  title: string;
  items: BuyStationItem[];
  credits: number;
  onPurchase: (slug: string, name: string, price: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-6">
      <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.35em] text-amber-300/50">{title}</h3>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => {
          const affordable = credits >= it.price;
          return (
            <button
              key={it.slug}
              onClick={() => onPurchase(it.slug, it.name, it.price)}
              disabled={!affordable}
              className={`group flex items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-all ${
                affordable
                  ? "border-white/[0.08] bg-white/[0.03] hover:border-amber-500/40 hover:bg-amber-500/[0.06]"
                  : "border-white/[0.04] bg-white/[0.01] opacity-50"
              } ${FOCUS_RING}`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/15 bg-amber-500/[0.06] text-amber-300">
                <ItemIcon slug={it.slug} className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-white">{it.name}</span>
                  <span className={`flex shrink-0 items-center gap-1 text-sm font-bold tabular-nums ${affordable ? "text-amber-300" : "text-red-400"}`}>
                    <Coins className="h-3 w-3" />{it.price}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-white/40">{it.desc}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
