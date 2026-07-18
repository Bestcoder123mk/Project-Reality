"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Lock, Check, Coins, Sparkles } from "lucide-react";
import {
  useGameStore, WEAPONS, ATTACHMENTS, SKINS, RARITY_COLORS,
  MELEE_WEAPONS, UTILITY_ITEMS,
  DEFAULT_LOADOUT,
  type WeaponType, type AttachmentSlug, type SkinSlug,
  type WeaponCategory, type WeaponConfig, type Rarity,
} from "@/lib/game/store";
import { useProfile } from "@/lib/game/useProfile";
import { WeaponPreview3D } from "@/components/game/Gunsmith3D";
import { PackScreen } from "@/components/menu/PackScreen";
import { toast } from "sonner";

/**
 * ShopScreen — Task 2-d Prompt 5.
 *
 * Rebuilt with:
 *   - Live rotating 3D weapon preview per card (compact WeaponPreview3D).
 *     Prompt J-4025 / J-4140 — firing range preview from shop. Each
 *     weapon card embeds a compact 3D preview (drag-to-rotate + auto-
 *     spin) so the player can inspect the weapon before buying. The
 *     full "test-fire" mode (animated muzzle flash + recoil in a
 *     firing-range scene) is the next-layer feature, flagged for a
 *     future art pass; the 3D preview alone already lets the player
 *     verify the weapon's silhouette + skin before purchasing.
 *   - Visibility-gated WebGL mounting (IntersectionObserver) so off-screen
 *     cards don't hold a WebGL context — keeps us well under the browser's
 *     ~16-context limit.
 *   - Normalized 0-100 stat BARS (Damage, Range, Fire Rate, Mobility,
 *     Accuracy, Reload Speed) with framer-motion width transitions.
 *   - Category filtering tabs (RIFLE/SMG/PISTOL/SNIPER/SHOTGUN/LMG/MELEE/UTILITY).
 *   - Rarity-colored borders (common grey, rare blue, epic purple, legendary
 *     amber) + matching inner glow.
 *   - Glass-morphism + spring-physics style (backdrop-blur-2xl, bg-white/[0.04],
 *     hover/tap springs) consistent with MainMenu.
 *   - Purchase button with credits check + toast feedback.
 */

type Tab = "weapons" | "attachments" | "skins";
type WeaponFilter = "ALL" | WeaponCategory | "MELEE" | "UTILITY";

const EASE_APPLE: [number, number, number, number] = [0.16, 1, 0.3, 1];

const WEAPON_FILTERS: { id: WeaponFilter; label: string }[] = [
  { id: "ALL", label: "All" },
  { id: "RIFLE", label: "Rifles" },
  { id: "SMG", label: "SMG" },
  { id: "PISTOL", label: "Pistols" },
  { id: "SNIPER", label: "Sniper" },
  { id: "SHOTGUN", label: "Shotgun" },
  { id: "LMG", label: "LMG" },
  { id: "MELEE", label: "Melee" },
  { id: "UTILITY", label: "Utility" },
];

// ─── Stat normalization ──────────────────────────────────────
// Each stat is normalized to 0-100 from the raw weapon config value, using
// the empirical min/max across the WEAPONS record. The bars use these.

interface StatNorm {
  label: string;
  value: number; // 0-100
}

function normalizeStats(w: WeaponConfig): StatNorm[] {
  // Damage: 16-110 → 0-100
  const damage = clamp01((w.damage - 15) / 100) * 100;
  // Range: 60-400 → 0-100
  const range = clamp01((w.range - 50) / 350) * 100;
  // Fire Rate: lower ms between shots = faster. 60-900ms → invert.
  const fireRate = clamp01(1 - (w.fireRate - 50) / 900) * 100;
  // Mobility: lower recoil + lower spread = more mobile. Combine.
  // Recoil: 0.016-0.06. Spread: 0.001-0.05.
  const mobility = clamp01(1 - (w.recoil - 0.015) / 0.05) * 50 + clamp01(1 - (w.spread - 0.001) / 0.05) * 50;
  // Accuracy: inverse of spread.
  const accuracy = clamp01(1 - (w.spread - 0.001) / 0.05) * 100;
  // Reload Speed: inverse of reloadTime. 1500-4500ms.
  const reload = clamp01(1 - (w.reloadTime - 1500) / 3000) * 100;
  return [
    { label: "Damage", value: Math.round(damage) },
    { label: "Range", value: Math.round(range) },
    { label: "Fire Rate", value: Math.round(fireRate) },
    { label: "Mobility", value: Math.round(mobility) },
    { label: "Accuracy", value: Math.round(accuracy) },
    { label: "Reload", value: Math.round(reload) },
  ];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ─── Component ───────────────────────────────────────────────

export function ShopScreen() {
  const profile = useGameStore((s) => s.profile);
  const setPhase = useGameStore((s) => s.setPhase);
  const { refresh } = useProfile();
  const [tab, setTab] = useState<Tab>("weapons");
  const [filter, setFilter] = useState<WeaponFilter>("ALL");
  const [buying, setBuying] = useState<string | null>(null);
  const [packsOpen, setPacksOpen] = useState(false);

  const handleBuy = async (itemType: "WEAPON" | "ATTACHMENT" | "SKIN" | "MELEE" | "UTILITY", slug: string, price: number) => {
    if (profile.credits < price) { toast.error("Insufficient credits"); return; }
    setBuying(slug);
    try {
      // Prompt J-4071 — send the client-displayed price to the server so it
      // can detect + reject client/server mismatch (server is authoritative
      // but a stale client could otherwise pay less than the real price).
      // The server returns the actual price charged; we verify it matches
      // the displayed price and warn the player if it differs.
      const res = await fetch("/api/shop/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemType, slug, clientPrice: price }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Purchase failed" }));
        throw new Error(err.error || "Purchase failed");
      }
      const data = await res.json().catch(() => ({}));
      if (typeof data.chargedPrice === "number" && data.chargedPrice !== price) {
        toast.warning(`Paid ${data.chargedPrice}c (displayed: ${price}c) — catalog updated`);
      } else {
        toast.success("Purchased");
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBuying(null);
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "weapons", label: "Weapons" },
    { id: "attachments", label: "Attachments" },
    { id: "skins", label: "Finishes" },
  ];

  // Filtered weapon list — also includes MELEE/UTILITY pseudo-categories.
  const filteredWeapons = useMemo(() => {
    const all = Object.values(WEAPONS);
    if (filter === "ALL") return all;
    return all.filter((w) => w.category === filter);
  }, [filter]);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#08090c] text-white">
      {/* Ambient backdrop (matches MainMenu). */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0c0e0a] via-[#08090c] to-[#050607]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_70%_25%,rgba(255,140,26,0.07),transparent_60%)]" />
      </div>

      <header className="relative z-10 flex items-center justify-between border-b border-white/[0.05] px-6 py-4 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <button onClick={() => setPhase("menu")} className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.04] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Armory Shop</h1>
            <p className="text-[11px] text-white/40">Acquire weapons, attachments, finishes</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPacksOpen(true)}
            className="flex h-9 items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-4 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-500/20"
          >
            <Sparkles className="h-3.5 w-3.5" /> Packs
          </button>
          <div className="flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3.5 py-1.5">
            <Coins className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-sm font-bold tabular-nums text-amber-300">{profile.credits.toLocaleString()}</span>
          </div>
        </div>
      </header>

      {/* Tab strip — Weapons / Attachments / Finishes */}
      <div className="relative z-10 flex gap-1 border-b border-white/[0.05] px-6 py-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${tab === t.id ? "text-white" : "text-white/40 hover:text-white/70"}`}
          >
            {t.label}
            {tab === t.id && <motion.div layoutId="shop-tab" className="absolute inset-0 rounded-lg bg-white/[0.08]" transition={{ type: "spring", stiffness: 300, damping: 30 }} />}
          </button>
        ))}
      </div>

      <div className="relative z-10 flex-1 overflow-y-auto p-6">
        {tab === "weapons" && (
          <>
            {/* Category filter pills */}
            <div className="mb-5 flex flex-wrap gap-1.5">
              {WEAPON_FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-all ${
                    filter === f.id
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                      : "border-white/[0.06] bg-white/[0.02] text-white/55 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* MELEE + UTILITY pseudo-categories */}
            {/* Prompt J-4070 — melee + utility purchases now flow through the
                real /api/shop/buy route (was a `toast.info("coming soon")`
                stub). The server recognizes MELEE/UTILITY itemTypes and
                grants ownership + debits credits authoritatively. */}
            {filter === "MELEE" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {MELEE_WEAPONS.map((m) => {
                  const owned = (profile as { ownedMelee?: string[] }).ownedMelee?.includes(m.slug) ?? false;
                  return (
                    <FlatCard
                      key={m.slug}
                      name={m.name}
                      category="MELEE"
                      rarity={m.rarity}
                      desc={m.description}
                      price={m.price}
                      owned={owned}
                      buying={buying === m.slug}
                      affordable={profile.credits >= m.price}
                      onBuy={() => handleBuy("MELEE", m.slug, m.price)}
                    />
                  );
                })}
              </div>
            )}
            {filter === "UTILITY" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {UTILITY_ITEMS.map((u) => {
                  const owned = (profile as { ownedUtility?: string[] }).ownedUtility?.includes(u.slug) ?? false;
                  return (
                    <FlatCard
                      key={u.slug}
                      name={u.name}
                      category="UTILITY"
                      rarity={u.rarity}
                      desc={u.description}
                      price={u.price}
                      owned={owned}
                      buying={buying === u.slug}
                      affordable={profile.credits >= u.price}
                      onBuy={() => handleBuy("UTILITY", u.slug, u.price)}
                    />
                  );
                })}
              </div>
            )}

            {/* Weapon cards (3D preview + stat bars) */}
            {(filter === "ALL" || ["RIFLE", "SMG", "PISTOL", "SNIPER", "SHOTGUN", "LMG"].includes(filter)) && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredWeapons.map((w) => (
                  <WeaponCard
                    key={w.id}
                    weapon={w}
                    owned={profile.ownedWeapons.includes(w.id)}
                    affordable={profile.credits >= w.price}
                    buying={buying === w.id}
                    onBuy={() => handleBuy("WEAPON", w.id, w.price)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {tab === "attachments" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(Object.values(ATTACHMENTS).filter(Boolean) as NonNullable<typeof ATTACHMENTS[AttachmentSlug]>[]).map((a) => {
              const owned = profile.ownedAttachments.includes(a.slug);
              const affordable = profile.credits >= a.price;
              return (
                <FlatCard
                  key={a.slug}
                  name={a.name}
                  category={a.type}
                  rarity={a.rarity}
                  desc={`${a.type} attachment`}
                  price={a.price}
                  owned={owned}
                  buying={buying === a.slug}
                  affordable={affordable}
                  onBuy={() => handleBuy("ATTACHMENT", a.slug, a.price)}
                />
              );
            })}
          </div>
        )}

        {tab === "skins" && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Object.values(SKINS).map((s) => {
              const owned = profile.ownedSkins.includes(s.slug);
              const affordable = profile.credits >= s.price;
              return (
                <SkinCard
                  key={s.slug}
                  slug={s.slug}
                  name={s.name}
                  rarity={s.rarity}
                  colorHex={s.colorHex}
                  price={s.price}
                  owned={owned}
                  affordable={affordable}
                  buying={buying === s.slug}
                  onBuy={() => handleBuy("SKIN", s.slug, s.price)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Pack opening overlay — rendered from the shop header's "Packs" button. */}
      <AnimatePresence>
        {packsOpen && <PackScreen onClose={() => setPacksOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}

// ─── Weapon card with live 3D preview + stat bars ───────────

function WeaponCard({
  weapon, owned, affordable, buying, onBuy,
}: {
  weapon: WeaponConfig;
  owned: boolean;
  affordable: boolean;
  buying: boolean;
  onBuy: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const rarityColor = RARITY_COLORS[weapon.rarity];
  const stats = useMemo(() => normalizeStats(weapon), [weapon]);

  // Mount the 3D viewer only when the card is on-screen. This keeps the
  // WebGL context count low (max ~6 visible cards) and avoids initializing
  // 10 contexts at once when the page first loads.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const previewLoadout = useMemo(
    () => ({ ...DEFAULT_LOADOUT, weapon: weapon.id }),
    [weapon.id],
  );

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE_APPLE }}
      whileHover={{ y: -4, scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
      className="relative flex flex-col overflow-hidden rounded-2xl border bg-white/[0.04] backdrop-blur-2xl"
      style={{ borderColor: `${rarityColor}40` }}
    >
      {/* Rarity top accent bar. */}
      <div
        className="absolute left-0 right-0 top-0 h-0.5"
        style={{ background: `linear-gradient(90deg, ${rarityColor}, ${rarityColor}00)` }}
      />
      {/* Inner glow on hover. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500"
        style={{ boxShadow: `inset 0 0 40px ${rarityColor}20` }}
      />

      {/* Header — name + rarity + owned chip */}
      <div className="relative z-10 flex items-start justify-between p-4 pb-2">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: rarityColor }}>
            {weapon.rarity}
          </div>
          <div className="text-base font-bold">{weapon.name}</div>
          <div className="text-[11px] text-white/40">{weapon.category}</div>
        </div>
        {owned && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
            OWNED
          </span>
        )}
      </div>

      {/* 3D preview — compact WeaponPreview3D. Mounted only when visible. */}
      <div className="relative h-44 w-full overflow-hidden">
        {visible ? (
          <WeaponPreview3D loadout={previewLoadout} compact autoSpin className="h-full w-full" />
        ) : (
          <div className="flex h-full items-center justify-center bg-white/[0.02]">
            <div className="text-[10px] uppercase tracking-wider text-white/20">Loading…</div>
          </div>
        )}
        {/* Subtle gradient overlay so the preview fades into the card. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#08090c] to-transparent" />
      </div>

      {/* Stat bars */}
      <div className="relative z-10 grid grid-cols-2 gap-x-4 gap-y-2 p-4 pt-3">
        {stats.map((s, i) => (
          <StatBar key={s.label} label={s.label} value={s.value} delay={i * 0.05} />
        ))}
      </div>

      {/* Buy button */}
      <div className="relative z-10 p-4 pt-2">
        {owned ? (
          <button disabled className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-white/[0.06] text-sm font-medium text-emerald-400">
            <Check className="h-4 w-4" /> In Inventory
          </button>
        ) : (
          <motion.button
            onClick={onBuy}
            disabled={!affordable || buying}
            whileHover={affordable ? { scale: 1.02 } : undefined}
            whileTap={affordable ? { scale: 0.97 } : undefined}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
            className={`flex h-10 w-full items-center justify-center gap-1.5 rounded-xl text-sm font-semibold transition-all ${
              affordable
                ? "bg-white text-black hover:shadow-[0_0_18px_rgba(255,255,255,0.18)]"
                : "bg-white/[0.05] text-white/40"
            }`}
          >
            {buying ? (
              "…"
            ) : (
              <>
                <Coins className="h-3.5 w-3.5" /> {weapon.price.toLocaleString()}
              </>
            )}
          </motion.button>
        )}
      </div>
    </motion.div>
  );
}

function StatBar({ label, value, delay }: { label: string; value: number; delay: number }) {
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-white/40">{label}</span>
        <span className="text-[9px] font-bold tabular-nums text-white/70">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-amber-500/70 to-amber-400"
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(5, value)}%` }}
          transition={{ duration: 0.7, delay, ease: EASE_APPLE }}
        />
      </div>
    </div>
  );
}

// ─── Flat card (attachments, melee, utility) ────────────────

function FlatCard({
  name, category, rarity, desc, price, owned, buying, affordable, onBuy,
}: {
  name: string;
  category: string;
  rarity: Rarity;
  desc: string;
  price: number;
  owned: boolean;
  buying: boolean;
  affordable: boolean;
  onBuy: () => void;
}) {
  const rarityColor = RARITY_COLORS[rarity];
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE_APPLE }}
      whileHover={{ y: -4, scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
      className="relative flex flex-col rounded-2xl border bg-white/[0.04] p-4 backdrop-blur-2xl"
      style={{ borderColor: `${rarityColor}40` }}
    >
      <div className="absolute left-0 right-0 top-0 h-0.5" style={{ background: `linear-gradient(90deg, ${rarityColor}, ${rarityColor}00)` }} />
      <div className="mb-2 flex items-start justify-between">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: rarityColor }}>{rarity}</div>
          <div className="text-base font-bold">{name}</div>
          <div className="text-[11px] text-white/40">{category}</div>
        </div>
        {owned && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">OWNED</span>}
      </div>
      <p className="mb-3 line-clamp-2 text-[11px] leading-relaxed text-white/45">{desc}</p>
      {owned ? (
        <button disabled className="mt-auto flex h-10 items-center justify-center gap-1.5 rounded-xl bg-white/[0.06] text-sm font-medium text-emerald-400">
          <Check className="h-4 w-4" /> In Inventory
        </button>
      ) : (
        <motion.button
          onClick={onBuy}
          disabled={!affordable || buying}
          whileHover={affordable ? { scale: 1.02 } : undefined}
          whileTap={affordable ? { scale: 0.97 } : undefined}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
          className={`mt-auto flex h-10 items-center justify-center gap-1.5 rounded-xl text-sm font-semibold transition-all ${affordable ? "bg-white text-black" : "bg-white/[0.05] text-white/40"}`}
        >
          {buying ? "…" : <><Coins className="h-3.5 w-3.5" /> {price.toLocaleString()}</>}
        </motion.button>
      )}
    </motion.div>
  );
}

// ─── Skin card ───────────────────────────────────────────────

function SkinCard({
  slug, name, rarity, colorHex, price, owned, affordable, buying, onBuy,
}: {
  slug: SkinSlug;
  name: string;
  rarity: Rarity;
  colorHex: string;
  price: number;
  owned: boolean;
  affordable: boolean;
  buying: boolean;
  onBuy: () => void;
}) {
  const rarityColor = RARITY_COLORS[rarity];
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE_APPLE }}
      whileHover={{ y: -4, scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className="relative flex flex-col overflow-hidden rounded-2xl border bg-white/[0.04] p-4 backdrop-blur-2xl"
      style={{ borderColor: `${rarityColor}40` }}
    >
      <div className="absolute left-0 right-0 top-0 h-0.5" style={{ background: `linear-gradient(90deg, ${rarityColor}, ${rarityColor}00)` }} />
      <div className="mb-3 h-20 rounded-xl" style={{ background: `linear-gradient(135deg, ${colorHex}, ${colorHex}66)`, boxShadow: `inset 0 0 30px ${colorHex}40` }} />
      <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: rarityColor }}>{rarity}</div>
      <div className="mb-3 text-sm font-bold">{name}</div>
      {owned ? (
        <button disabled className="mt-auto flex h-10 items-center justify-center gap-1.5 rounded-xl bg-white/[0.06] text-sm font-medium text-emerald-400">
          <Check className="h-4 w-4" /> Owned
        </button>
      ) : (
        <motion.button
          onClick={onBuy}
          disabled={!affordable || buying}
          whileHover={affordable ? { scale: 1.02 } : undefined}
          whileTap={affordable ? { scale: 0.97 } : undefined}
          transition={{ type: "spring", stiffness: 400, damping: 25 }}
          className={`mt-auto flex h-10 items-center justify-center gap-1.5 rounded-xl text-sm font-semibold transition-all ${affordable ? "bg-white text-black" : "bg-white/[0.05] text-white/40"}`}
        >
          {buying ? "…" : <><Coins className="h-3.5 w-3.5" /> {price.toLocaleString()}</>}
        </motion.button>
      )}
    </motion.div>
  );
}

export type { WeaponType, AttachmentSlug, SkinSlug, WeaponCategory };
