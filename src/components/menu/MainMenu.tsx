"use client";

import { motion } from "framer-motion";
import {
  Play, Settings as SettingsIcon, Crosshair as CrosshairIcon, ChevronRight,
  Target, Shield, Zap, Trophy, Wrench, ShoppingBag, Crown, Coins,
  GraduationCap, Map as MapIcon, User, Swords, Skull, Package,
} from "lucide-react";
import {
  useGameStore, WEAPONS, computeWeaponStats,
  type WeaponType, type GamePhase,
} from "@/lib/game/store";
import { OperatorPreview3D } from "@/components/game/OperatorPreview3D";
import { OPERATORS_BY_SLUG } from "@/lib/game/operators";
import type { LucideIcon } from "lucide-react";

const EASE_APPLE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]";

const weaponMeta: Record<WeaponType, { icon: LucideIcon; tag: string; desc: string; stats: { dmg: number; fire: number; mobility: number; range: number } }> = {
  ak74: { icon: Target, tag: "Assault Rifle", desc: "Balanced full-auto workhorse. Reliable in any engagement.", stats: { dmg: 70, fire: 80, mobility: 70, range: 85 } },
  m4: { icon: Target, tag: "Assault Rifle", desc: "Lower recoil, faster fire. Precision-oriented rifle.", stats: { dmg: 65, fire: 85, mobility: 72, range: 85 } },
  mp7: { icon: Zap, tag: "Submachine Gun", desc: "High fire rate, mobile, ideal for close quarters.", stats: { dmg: 45, fire: 95, mobility: 90, range: 50 } },
  p90: { icon: Zap, tag: "Submachine Gun", desc: "Huge magazine, controllable. Sustained pressure SMG.", stats: { dmg: 40, fire: 98, mobility: 92, range: 45 } },
  usp: { icon: CrosshairIcon, tag: "Sidearm", desc: "Precise semi-auto. Bonus mobility, limited magazine.", stats: { dmg: 60, fire: 50, mobility: 100, range: 60 } },
  deagle: { icon: CrosshairIcon, tag: "Sidearm", desc: "Hand cannon. Massive damage, heavy recoil.", stats: { dmg: 90, fire: 35, mobility: 95, range: 65 } },
  awp: { icon: Shield, tag: "Sniper Rifle", desc: "One-shot lethality. Slow, punishing, decisive.", stats: { dmg: 100, fire: 20, mobility: 40, range: 100 } },
  scout: { icon: Shield, tag: "Sniper Rifle", desc: "Mobile sniper. Strong damage, faster handling.", stats: { dmg: 85, fire: 30, mobility: 55, range: 95 } },
  nova: { icon: Target, tag: "Shotgun", desc: "Devastating up close. Spread pellets, short range.", stats: { dmg: 80, fire: 25, mobility: 65, range: 25 } },
  m249: { icon: Shield, tag: "Light Machine Gun", desc: "100-round belt-fed. Suppressive fire, heavy recoil.", stats: { dmg: 60, fire: 90, mobility: 35, range: 80 } },

  // ── Task-5 — new weapons (mirror closest category sibling for stats) ──
  hk416: { icon: Target, tag: "Assault Rifle", desc: "Piston-driven AR. Crisp recoil, tier-one reliability.", stats: { dmg: 68, fire: 85, mobility: 72, range: 88 } },
  famas: { icon: Target, tag: "Bullpup Rifle", desc: "Bullpup in 5.56mm. High damage, small 25-round mag.", stats: { dmg: 75, fire: 88, mobility: 70, range: 82 } },
  aug: { icon: Target, tag: "Bullpup Rifle", desc: "Austrian bullpup with built-in 1.5x optic. Smooth.", stats: { dmg: 70, fire: 84, mobility: 70, range: 88 } },
  scarh: { icon: Target, tag: "Battle Rifle", desc: "7.62mm battle rifle. Armor-piercing damage, 20 rounds.", stats: { dmg: 88, fire: 72, mobility: 60, range: 90 } },
  galil: { icon: Target, tag: "Assault Rifle", desc: "Israeli workhorse. 35-round mag, dirt-tough.", stats: { dmg: 73, fire: 78, mobility: 68, range: 82 } },
  mk17: { icon: Target, tag: "Battle Rifle", desc: "SCAR variant in 7.62mm. Heavy hits, 20 rounds.", stats: { dmg: 90, fire: 70, mobility: 58, range: 92 } },
  mk14: { icon: Target, tag: "Marksman Rifle", desc: "Bridges AR + sniper. 7.62mm precision at range.", stats: { dmg: 92, fire: 62, mobility: 60, range: 95 } },
  mp5: { icon: Zap, tag: "Submachine Gun", desc: "9mm classic. Soft recoil, CQB gold standard.", stats: { dmg: 48, fire: 92, mobility: 95, range: 48 } },
  ump45: { icon: Zap, tag: "Submachine Gun", desc: ".45 ACP SMG. Higher damage, slower fire.", stats: { dmg: 55, fire: 75, mobility: 88, range: 52 } },
  vector: { icon: Zap, tag: "Submachine Gun", desc: "1200 RPM laser-flat SMG. Eats mags alive.", stats: { dmg: 42, fire: 100, mobility: 90, range: 45 } },
  pp90m1: { icon: Zap, tag: "Submachine Gun", desc: "Russian helical-mag SMG. 64-round relentless fire.", stats: { dmg: 45, fire: 96, mobility: 85, range: 44 } },
  glock18: { icon: CrosshairIcon, tag: "Machine Pistol", desc: "Full-auto 9mm backup. 17 rounds in a second.", stats: { dmg: 55, fire: 80, mobility: 100, range: 50 } },
  m1911: { icon: CrosshairIcon, tag: "Sidearm", desc: ".45 ACP classic. Seven rounds of knockdown.", stats: { dmg: 80, fire: 40, mobility: 98, range: 62 } },
  revolver: { icon: CrosshairIcon, tag: "Heavy Sidearm", desc: ".50 cal hand-cannon. Five rounds, guaranteed stagger.", stats: { dmg: 95, fire: 28, mobility: 92, range: 70 } },
  kar98k: { icon: Shield, tag: "Sniper Rifle", desc: "WWII bolt-action. Quick cycle, classic marksman feel.", stats: { dmg: 88, fire: 32, mobility: 58, range: 92 } },
  l115a3: { icon: Shield, tag: "Sniper Rifle", desc: "British .338 Lapua. Longest confirmed kill platform.", stats: { dmg: 100, fire: 18, mobility: 38, range: 100 } },
  m1014: { icon: Target, tag: "Shotgun", desc: "Semi-auto 12-gauge. Seven shells clear a room.", stats: { dmg: 75, fire: 50, mobility: 62, range: 28 } },
  spas12: { icon: Target, tag: "Shotgun", desc: "Dual-mode Italian 12-gauge. Pump or semi.", stats: { dmg: 82, fire: 38, mobility: 60, range: 30 } },
  rpk: { icon: Shield, tag: "Light Machine Gun", desc: "Soviet 5.45mm squad auto. Drum-fed pin-down.", stats: { dmg: 70, fire: 84, mobility: 40, range: 85 } },
  mk48: { icon: Shield, tag: "Light Machine Gun", desc: "7.62mm GPMG. 100 rounds of belt-fed annihilation.", stats: { dmg: 78, fire: 80, mobility: 32, range: 90 } },
};

export function MainMenu() {
  const startMatch = useGameStore((s) => s.startMatch);
  const setPhase = useGameStore((s) => s.setPhase);
  const selectedWeapon = useGameStore((s) => s.selectedWeapon);
  const setSelectedWeapon = useGameStore((s) => s.setSelectedWeapon);
  const setLoadout = useGameStore((s) => s.setLoadout);
  const profile = useGameStore((s) => s.profile);
  const hud = useGameStore((s) => s.hud);
  const loadout = useGameStore((s) => s.loadout);
  const operator = useGameStore((s) => s.operator);
  const equippedOperatorSlug = useGameStore((s) => s.equippedOperatorSlug);
  const equippedOperator = OPERATORS_BY_SLUG[equippedOperatorSlug] ?? OPERATORS_BY_SLUG.warden;

  const cfg = WEAPONS[loadout.weapon];
  const meta = weaponMeta[loadout.weapon];
  const Icon = meta.icon;
  const ownedWeapons = profile.ownedWeapons;

  const pickWeapon = (w: WeaponType) => {
    if (!ownedWeapons.includes(w)) return;
    setSelectedWeapon(w);
    setLoadout({ weapon: w });
  };

  const navItems: { id: GamePhase; label: string; icon: LucideIcon }[] = [
    { id: "loadout", label: "Loadout", icon: CrosshairIcon },
    { id: "operator", label: "Operator", icon: User },
    { id: "mapselect", label: "Maps", icon: MapIcon },
    { id: "gunsmith", label: "Gunsmith", icon: Wrench },
    { id: "shop", label: "Armory", icon: ShoppingBag },
    { id: "packs", label: "Packs", icon: Package },
    { id: "battlepass", label: "Battle Pass", icon: Crown },
    { id: "tutorial", label: "Tutorial", icon: GraduationCap },
  ];

  return (
    <div className="absolute inset-0 z-40 overflow-hidden bg-[#08090c] text-white noise-overlay">
      {/* Ambient background — industrial hangar vibe with warm key light. */}
      <Backdrop />

      <div className="relative z-10 flex h-screen flex-col">
        {/* ═══════════════════════════════════════════════════════════
            TOP BAR (56px, hairline bottom border)
            Left: logo + wordmark. Right: level chip, credits, settings gear.
            ═══════════════════════════════════════════════════════════ */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.05] px-5 sm:px-7">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-amber-400 to-amber-600 shadow-[0_0_12px_rgba(255,140,26,0.4)]">
              <CrosshairIcon className="h-3.5 w-3.5 text-black" />
            </div>
            <span className="text-wordmark text-[15px]">Project Reality</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Credits chip — amber, translucent. */}
            <div className="flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/8 px-3 py-1.5 backdrop-blur-xl">
              <Coins className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-[13px] font-bold tabular text-amber-300">{profile.credits.toLocaleString()}</span>
            </div>
            {/* Level chip — translucent glass. */}
            <div className="flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.04] px-3 py-1.5 backdrop-blur-xl">
              <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-white/40">LVL</span>
              <span className="text-[13px] font-bold tabular">{profile.level}</span>
            </div>
            {profile.battlePassPremium && (
              <div className="flex h-7 w-7 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/15 backdrop-blur-xl">
                <Crown className="h-3.5 w-3.5 text-amber-400" />
              </div>
            )}
            {/* Settings gear. */}
            <button
              type="button"
              onClick={() => setPhase("settings")}
              className={`flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.04] text-white/60 backdrop-blur-xl transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
              aria-label="Open settings"
            >
              <SettingsIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {/* ═══════════════════════════════════════════════════════════
            MAIN BODY — 3-column: left panel | center hero+preview | right panel
            ═══════════════════════════════════════════════════════════ */}
        <div className="flex flex-1 overflow-hidden">
          {/* ─── LEFT PANEL — Contracts / Objectives ─── */}
          <aside className="hidden w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-white/[0.05] p-4 lg:flex scroll-thin">
            <LeftPanel />
          </aside>

          {/* ─── CENTER — Hero + 3D Operator Preview ─── */}
          <main className="relative flex flex-1 flex-col overflow-hidden">
            {/* Center: 3D operator preview filling the space. */}
            <div className="absolute inset-0 flex items-center justify-center">
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.9, delay: 0.2, ease: EASE_APPLE }}
                className="relative h-full w-full max-w-[480px]"
              >
                <OperatorPreview3D operator={operator} operatorSlug={equippedOperatorSlug} className="h-full w-full" />
                {/* Callsign nameplate above the operator. */}
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.7, delay: 0.6, ease: EASE_APPLE }}
                  className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2"
                >
                  <div className="flex flex-col items-center gap-1">
                    <div className="rounded-full border border-amber-500/20 bg-black/40 px-4 py-1 backdrop-blur-xl">
                      <span className="text-[9px] font-semibold uppercase tracking-[0.3em] text-amber-400/80">{equippedOperator.faction}</span>
                    </div>
                    <span className="text-xl font-bold tracking-tight text-gradient-amber">{equippedOperator.callsign}</span>
                  </div>
                </motion.div>
                {/* Drag hint at bottom. */}
                <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.25em] text-white/25">
                  Drag to rotate · Scroll to zoom
                </div>
              </motion.div>
            </div>

            {/* Hero text — bottom-left anchored, doesn't overlap the preview. */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: EASE_APPLE }}
              className="relative z-10 mt-auto max-w-md p-6 sm:p-8"
            >
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1 backdrop-blur-xl">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(255,140,26,0.6)]" />
                <span className="text-[10px] font-medium uppercase tracking-[0.25em] text-white/50">Tactical FPS</span>
              </div>
              <h1 className="font-display text-5xl uppercase leading-[0.95] text-gradient-white sm:text-6xl">
                Project<br />Reality
              </h1>
            </motion.div>
          </main>

          {/* ─── RIGHT PANEL — Active loadout ─── */}
          <aside className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/[0.05] p-4 xl:flex scroll-thin">
            <RightPanel
              loadout={loadout}
              ownedWeapons={ownedWeapons}
              pickWeapon={pickWeapon}
              cfg={cfg}
              meta={meta}
              Icon={Icon}
              onGunsmith={() => setPhase("gunsmith")}
            />
          </aside>
        </div>

        {/* ═══════════════════════════════════════════════════════════
            BOTTOM NAV — pill row with prominent amber DEPLOY button
            ═══════════════════════════════════════════════════════════ */}
        <footer className="shrink-0 border-t border-white/[0.05] bg-black/30 backdrop-blur-xl">
          {/* Prompt J-4087 + J-4088 — mobile fallbacks for the contracts
              (left panel, hidden <lg) + loadout (right panel, hidden <xl).
              On small screens the side asides disappear, so we surface a
              compact one-line summary above the nav row so the player can
              still see + reach their loadout + best contract without the
              full panels. Tapping the loadout chip jumps to the Loadout
              screen; tapping the contract chip jumps to Battle Pass. */}
          <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-1.5 sm:px-6 lg:hidden xl:hidden">
            <button
              type="button"
              onClick={() => setPhase("loadout")}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
              aria-label="Open loadout"
            >
              <CrosshairIcon className="h-3 w-3 text-amber-400" />
              <span className="truncate max-w-[100px]">{cfg.name}</span>
            </button>
            <button
              type="button"
              onClick={() => setPhase("battlepass")}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[10px] font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
              aria-label="Open contracts"
            >
              <Swords className="h-3 w-3 text-amber-400" />
              <span className="truncate">Contracts</span>
            </button>
          </div>
          <div className="flex items-center gap-2 px-4 py-3 sm:px-6">
            {/* Scrollable nav pills. */}
            <div className="flex flex-1 items-center gap-1.5 overflow-x-auto scroll-hidden">
              {navItems.map((n) => {
                const NIcon = n.icon;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => setPhase(n.id)}
                    className={`group flex shrink-0 items-center gap-2 rounded-full border px-4 py-2.5 text-[13px] font-medium backdrop-blur-xl transition-all hover:bg-white/[0.06] ${FOCUS_RING} border-white/[0.06] bg-white/[0.02] text-white/60 hover:text-white`}
                  >
                    <NIcon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{n.label}</span>
                  </button>
                );
              })}
            </div>
            {/* DEPLOY button — the single hero CTA, amber gradient with glow. */}
            <motion.button
              type="button"
              onClick={startMatch}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className={`group relative flex h-12 shrink-0 items-center gap-2 overflow-hidden rounded-full bg-gradient-to-r from-amber-500 to-amber-600 px-7 text-[15px] font-bold text-black shadow-[0_0_24px_rgba(255,140,26,0.4)] transition-shadow hover:shadow-[0_0_36px_rgba(255,140,26,0.6)] ${FOCUS_RING}`}
            >
              <Play className="h-4 w-4 fill-black" />
              <span className="relative z-10">DEPLOY</span>
              {/* Shimmer sweep. */}
              <span className="absolute inset-0 shimmer-sweep opacity-60" />
            </motion.button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------- Backdrop ----------

function Backdrop() {
  return (
    <div aria-hidden className="absolute inset-0">
      {/* Base gradient — V4.1 grounded tactical palette: charcoal→gunmetal with a faint olive undertone. */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#0c0e0a] via-[#08090c] to-[#050607]" />
      {/* Warm key light from top-right (simulates the hangar lamp) — amber. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_70%_25%,rgba(255,140,26,0.10),transparent_60%)]" />
      {/* Olive/tan fill from bottom-left — tactical fabric undertone. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_55%_45%_at_18%_82%,rgba(59,74,47,0.22),transparent_60%)]" />
      {/* Cool steel fill from top-left. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_45%_38%_at_85%_75%,rgba(106,112,104,0.12),transparent_60%)]" />
      {/* Subtle grid. */}
      <div
        className="absolute inset-0 opacity-[0.045]"
        style={{
          backgroundImage: "linear-gradient(rgba(201,176,138,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(201,176,138,0.5) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
        }}
      />
      {/* Vignette. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.6)_100%)]" />
    </div>
  );
}

// ---------- Left Panel: Contracts / Objectives ----------

function LeftPanel() {
  // Prompt J-4012 — reactive best score (was useGameStore.getState() outside selector).
  const bestScore = useGameStore((s) => s.hud.score);
  const contracts = [
    { name: "Clear Wave 3", reward: "+500 XP", icon: Skull, progress: 0 },
    { name: "50 Headshots", reward: "+1200 XP", icon: Target, progress: 0.32 },
    { name: "Survive 6 Waves", reward: "Gold Skin", icon: Shield, progress: 0 },
  ];
  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.6, delay: 0.3, ease: EASE_APPLE }}
      className="flex flex-col gap-3"
    >
      {/* Header. */}
      <div className="flex items-center gap-2 px-1">
        <Swords className="h-3.5 w-3.5 text-amber-400" />
        <span className="font-display-tight text-[11px] text-white/55">Contracts</span>
      </div>
      {/* Contract cards. */}
      {contracts.map((c, i) => {
        const CIcon = c.icon;
        return (
          <div
            key={c.name}
            className="tactical-panel tactical-bracket p-3.5 transition-colors hover:bg-[rgba(59,74,47,0.18)]"
          >
            <div className="mb-2 flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06]">
                <CIcon className="h-4 w-4 text-white/70" />
              </div>
              <div className="flex-1">
                <div className="text-[12px] font-semibold text-white/85">{c.name}</div>
                <div className="text-[10px] font-medium text-amber-400/80">{c.reward}</div>
              </div>
            </div>
            {/* Progress bar. */}
            <div className="h-1 overflow-hidden rounded-full bg-white/8">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-400"
                initial={{ width: 0 }}
                animate={{ width: `${c.progress * 100}%` }}
                transition={{ duration: 0.8, delay: 0.5 + i * 0.1, ease: EASE_APPLE }}
              />
            </div>
          </div>
        );
      })}
      {/* Prompt J-4012 — reactive best score.
          Previously `useGameStore.getState().hud.score` was called inline,
          which bypasses the selector subscription. The component never
          re-rendered when score changed. Now we subscribe via a proper
          selector so the best-score card appears + updates reactively. */}
      {bestScore > 0 && (
        <div className="tactical-panel mt-1 p-3.5">
          <div className="flex items-center gap-2">
            <Trophy className="h-3.5 w-3.5 text-amber-400" />
            <span className="font-display-tight text-[10px] text-white/45">Best Score</span>
          </div>
          <div className="mt-1 font-display text-3xl tabular text-gradient-amber">
            {bestScore.toLocaleString()}
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ---------- Right Panel: Active Loadout ----------

function RightPanel({
  loadout, ownedWeapons, pickWeapon, cfg, meta, Icon, onGunsmith,
}: {
  loadout: ReturnType<typeof useGameStore.getState>["loadout"];
  ownedWeapons: WeaponType[];
  pickWeapon: (w: WeaponType) => void;
  cfg: ReturnType<typeof useGameStore.getState>["loadout"] extends { weapon: WeaponType } ? typeof WEAPONS[WeaponType] : never;
  meta: { icon: LucideIcon; tag: string; desc: string; stats: { dmg: number; fire: number; mobility: number; range: number } };
  Icon: LucideIcon;
  onGunsmith: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.6, delay: 0.3, ease: EASE_APPLE }}
      className="flex flex-col gap-3"
    >
      {/* Header. */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <CrosshairIcon className="h-3.5 w-3.5 text-amber-400" />
          <span className="font-display-tight text-[11px] text-white/55">Active Loadout</span>
        </div>
        <button
          type="button"
          onClick={onGunsmith}
          className={`flex items-center gap-0.5 text-[10px] font-medium text-white/40 transition-colors hover:text-amber-400 ${FOCUS_RING}`}
        >
          Gunsmith <ChevronRight className="h-3 w-3" />
        </button>
      </div>

      {/* Equipped weapon card. */}
      <div className="panel-glass rounded-xl p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/15">
            <Icon className="h-5 w-5 text-amber-400" />
          </div>
          <div className="flex-1">
            <div className="font-display text-[15px] uppercase tracking-wide text-white">{cfg.name}</div>
            <div className="font-display-tight text-[9px] text-white/40">{meta.tag}</div>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-white/45">{meta.desc}</p>
        {/* Stat bars. */}
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
          <StatBar label="DMG" value={meta.stats.dmg} />
          <StatBar label="ROF" value={meta.stats.fire} />
          <StatBar label="MOB" value={meta.stats.mobility} />
          <StatBar label="RNG" value={meta.stats.range} />
        </div>
      </div>

      {/* Weapon selector grid (owned only). */}
      <div className="flex flex-wrap gap-1.5">
        {ownedWeapons.map((w) => {
          const active = loadout.weapon === w;
          const WIcon = weaponMeta[w].icon;
          return (
            <button
              key={w}
              type="button"
              onClick={() => pickWeapon(w)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-all ${FOCUS_RING} ${
                active
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-400 glow-amber-sm"
                  : "border-white/[0.06] bg-white/[0.02] text-white/50 hover:bg-white/[0.06] hover:text-white"
              }`}
              aria-label={WEAPONS[w].name}
              title={WEAPONS[w].name}
            >
              <WIcon className="h-4 w-4" />
            </button>
          );
        })}
      </div>

      {/* Secondary + melee summary. */}
      <div className="panel-glass rounded-xl p-3.5">
        <div className="flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-white/40">Sidearm</span>
            <span className="font-semibold text-white/80">{WEAPONS[loadout.secondary]?.name ?? "—"}</span>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-white/40">Melee</span>
            <span className="font-semibold capitalize text-white/80">{loadout.melee}</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-white/40">{label}</span>
        <span className="text-[10px] font-bold tabular text-white/70">{value}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/8">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-amber-500/80 to-amber-400"
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.7, ease: EASE_APPLE }}
        />
      </div>
    </div>
  );
}

export { computeWeaponStats };
