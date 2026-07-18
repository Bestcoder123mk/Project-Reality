"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, Check, Crosshair, Zap, Shield, Target } from "lucide-react";
import { useGameStore, WEAPONS, type WeaponType, type LoadoutConfig } from "@/lib/game/store";

type SlotKey = "primary" | "secondary" | "melee" | "utility";

// Prompt J-4079 — expanded primary list from 7 → all 26 primary weapons
// across every category (RIFLE/SMG/SNIPER/SHOTGUN/LMG). The previous list
// only shipped the original 7 starter weapons, hiding 19 Task-5 additions
// behind the Gunsmith screen. Now the picker surfaces the full arsenal.
const PRIMARY_WEAPONS: WeaponType[] = [
  // Original 7
  "ak74", "m4", "mp7", "p90", "awp", "scout", "nova",
  // Task-5 RIFLE additions
  "hk416", "famas", "aug", "scarh", "galil", "mk17", "mk14",
  // Task-5 SMG additions
  "mp5", "ump45", "vector", "pp90m1",
  // Task-5 SNIPER additions
  "kar98k", "l115a3",
  // Task-5 SHOTGUN additions
  "m1014", "spas12",
  // Task-5 LMG additions
  "m249", "rpk", "mk48",
];
// Prompt J-4080 — expanded secondary list from 2 → all 5 pistols.
const SECONDARY_WEAPONS: WeaponType[] = ["usp", "deagle", "glock18", "m1911", "revolver"];
// Prompt J-4080 — expanded melee list from 2 → 5 options.
const MELEE_OPTIONS = [
  { slug: "knife", name: "Combat Knife", desc: "Fast slash, 50 dmg. Silent takedown from behind." },
  { slug: "axe", name: "Tactical Axe", desc: "Slower but 70 dmg. Throws further." },
  { slug: "katana", name: "Katana", desc: "Long reach, 60 dmg. Sweep arc hits multiple." },
  { slug: "machete", name: "Machete", desc: "Wide slash, 55 dmg. Cuts through foliage." },
  { slug: "baton", name: "Tactical Baton", desc: "Non-lethal stun. 35 dmg + 1.5s stagger." },
];
const UTILITY_OPTIONS = [
  { slug: "bandage", name: "Bandage x3", desc: "Stops bleeding. 4s channel." },
  { slug: "frag", name: "Frag Grenade x2", desc: "Explosive, 5m radius." },
  { slug: "smoke", name: "Smoke Grenade x1", desc: "Concealment, 20s duration." },
];

const SLOT_CONFIG: Record<SlotKey, { label: string; icon: typeof Target; color: string }> = {
  primary: { label: "Primary", icon: Target, color: "text-sky-400" },
  secondary: { label: "Secondary", icon: Crosshair, color: "text-amber-400" },
  melee: { label: "Melee", icon: Zap, color: "text-rose-400" },
  utility: { label: "Utility", icon: Shield, color: "text-emerald-400" },
};

export function LoadoutPicker() {
  const loadout = useGameStore((s) => s.loadout);
  const setLoadout = useGameStore((s) => s.setLoadout);
  const setPhase = useGameStore((s) => s.setPhase);
  const startMatch = useGameStore((s) => s.startMatch);
  const profile = useGameStore((s) => s.profile);
  const [activeSlot, setActiveSlot] = useState<SlotKey>("primary");

  const ownedWeapons = profile.ownedWeapons;

  const setPrimary = (w: WeaponType) => {
    if (!ownedWeapons.includes(w)) return;
    setLoadout({ weapon: w } as Partial<LoadoutConfig>);
  };
  const setSecondary = (w: WeaponType) => {
    if (!ownedWeapons.includes(w)) return;
    setLoadout({ secondary: w } as Partial<LoadoutConfig>);
  };
  const setMelee = (slug: string) => setLoadout({ melee: slug } as Partial<LoadoutConfig>);
  const setUtility = (slug: string) => setLoadout({ utility: slug } as Partial<LoadoutConfig>);

  const slots: Array<{ key: SlotKey; weapon: string; name: string }> = [
    { key: "primary", weapon: loadout.weapon, name: WEAPONS[loadout.weapon]?.name ?? "—" },
    { key: "secondary", weapon: loadout.secondary, name: WEAPONS[loadout.secondary]?.name ?? "—" },
    { key: "melee", weapon: loadout.melee, name: MELEE_OPTIONS.find((m) => m.slug === loadout.melee)?.name ?? "Knife" },
    { key: "utility", weapon: loadout.utility, name: UTILITY_OPTIONS.find((u) => u.slug === loadout.utility)?.name ?? "Bandage" },
  ];

  return (
    <div className="absolute inset-0 z-40 overflow-y-auto bg-[#0a0a0c] text-white">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(40,40,55,0.8),transparent_60%)]" />

      <div className="relative z-10 mx-auto max-w-5xl px-6 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <button
            onClick={() => setPhase("menu")}
            className="flex items-center gap-2 text-sm text-white/50 transition-colors hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>
          <h1 className="text-2xl font-bold tracking-tight">Loadout</h1>
          <div className="w-20" />
        </div>

        {/* 4 slot tabs */}
        <div className="mb-6 grid grid-cols-4 gap-3">
          {slots.map((slot) => {
            const cfg = SLOT_CONFIG[slot.key];
            const Icon = cfg.icon;
            const active = activeSlot === slot.key;
            return (
              <button
                key={slot.key}
                onClick={() => setActiveSlot(slot.key)}
                className={`group relative overflow-hidden rounded-2xl border p-4 text-left transition-all ${
                  active ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.03] hover:border-white/20"
                }`}
              >
                {active && <motion.div layoutId="slot-active" className="absolute inset-0 rounded-2xl ring-1 ring-white/30" />}
                <div className="relative">
                  <div className={`mb-2 flex h-9 w-9 items-center justify-center rounded-xl ${active ? "bg-white text-black" : "bg-white/10"}`}>
                    <Icon className={`h-4 w-4 ${active ? "" : cfg.color}`} />
                  </div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-white/40">{cfg.label}</div>
                  <div className="mt-0.5 text-sm font-semibold truncate">{slot.name}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Slot content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeSlot}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.2 }}
            className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur-xl"
          >
            {activeSlot === "primary" && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {PRIMARY_WEAPONS.map((w) => {
                  const cfg = WEAPONS[w];
                  const owned = ownedWeapons.includes(w);
                  const equipped = loadout.weapon === w;
                  return (
                    <button
                      key={w}
                      disabled={!owned}
                      onClick={() => setPrimary(w)}
                      className={`relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
                        equipped ? "border-white/40 bg-white/10" : owned ? "border-white/10 bg-white/[0.03] hover:border-white/20" : "border-white/5 bg-white/[0.01] opacity-40"
                      }`}
                    >
                      {equipped && <Check className="absolute right-3 top-3 h-4 w-4 text-emerald-400" />}
                      <div className="text-sm font-bold">{cfg.name}</div>
                      <div className="text-[10px] uppercase tracking-wider text-white/40">{cfg.category}</div>
                      <div className="mt-2 flex gap-3 text-[10px] text-white/50">
                        <span>DMG {cfg.damage}</span>
                        <span>RNG {cfg.range}</span>
                      </div>
                      {!owned && <div className="mt-2 text-[10px] text-amber-400">🔒 {cfg.price}c</div>}
                    </button>
                  );
                })}
              </div>
            )}

            {activeSlot === "secondary" && (
              <div className="grid grid-cols-2 gap-3">
                {SECONDARY_WEAPONS.map((w) => {
                  const cfg = WEAPONS[w];
                  const owned = ownedWeapons.includes(w);
                  const equipped = loadout.secondary === w;
                  return (
                    <button
                      key={w}
                      disabled={!owned}
                      onClick={() => setSecondary(w)}
                      className={`relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
                        equipped ? "border-white/40 bg-white/10" : owned ? "border-white/10 bg-white/[0.03] hover:border-white/20" : "border-white/5 bg-white/[0.01] opacity-40"
                      }`}
                    >
                      {equipped && <Check className="absolute right-3 top-3 h-4 w-4 text-emerald-400" />}
                      <div className="text-sm font-bold">{cfg.name}</div>
                      <div className="text-[10px] uppercase tracking-wider text-white/40">{cfg.category}</div>
                      <div className="mt-2 flex gap-3 text-[10px] text-white/50">
                        <span>DMG {cfg.damage}</span>
                        <span>RNG {cfg.range}</span>
                      </div>
                      {!owned && <div className="mt-2 text-[10px] text-amber-400">🔒 {cfg.price}c</div>}
                    </button>
                  );
                })}
              </div>
            )}

            {activeSlot === "melee" && (
              <div className="grid grid-cols-2 gap-3">
                {MELEE_OPTIONS.map((m) => {
                  const equipped = loadout.melee === m.slug;
                  return (
                    <button
                      key={m.slug}
                      onClick={() => setMelee(m.slug)}
                      className={`relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
                        equipped ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.03] hover:border-white/20"
                      }`}
                    >
                      {equipped && <Check className="absolute right-3 top-3 h-4 w-4 text-emerald-400" />}
                      <div className="text-sm font-bold">{m.name}</div>
                      <div className="mt-1 text-[11px] text-white/50">{m.desc}</div>
                    </button>
                  );
                })}
              </div>
            )}

            {activeSlot === "utility" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {UTILITY_OPTIONS.map((u) => {
                  const equipped = loadout.utility === u.slug;
                  return (
                    <button
                      key={u.slug}
                      onClick={() => setUtility(u.slug)}
                      className={`relative overflow-hidden rounded-xl border p-4 text-left transition-all ${
                        equipped ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.03] hover:border-white/20"
                      }`}
                    >
                      {equipped && <Check className="absolute right-3 top-3 h-4 w-4 text-emerald-400" />}
                      <div className="text-sm font-bold">{u.name}</div>
                      <div className="mt-1 text-[11px] text-white/50">{u.desc}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {/* Deploy button */}
        <div className="mt-8 flex justify-center">
          <button
            onClick={startMatch}
            className="flex h-14 items-center gap-3 rounded-full bg-white px-12 text-base font-semibold text-black transition-transform hover:scale-[1.02] active:scale-95"
          >
            <Crosshair className="h-5 w-5" />
            Deploy
          </button>
        </div>

        {/* Controls hint */}
        <div className="mt-6 text-center text-[11px] text-white/30">
          Q / E or mouse wheel to switch between primary and secondary in-match · R reload · F melee · G takedown
        </div>
      </div>
    </div>
  );
}
