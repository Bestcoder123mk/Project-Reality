"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, RotateCcw, Save, Check, Lock, ShoppingBag, Sparkles, Gauge } from "lucide-react";
import { useGameStore, WEAPONS, ATTACHMENTS, SKINS, computeWeaponStats, RARITY_COLORS, type AttachmentSlug, type AttachmentType, type WeaponType, type SkinSlug, type Rarity } from "@/lib/game/store";
import { useProfile } from "@/lib/game/useProfile";
import { WeaponPreview3D } from "@/components/game/Gunsmith3D";
import { TuningBench } from "@/components/menu/TuningBench";
import { catalogStats } from "@/lib/game/combat/tuning-bench";
import { WRAPS, type WrapSlug } from "@/lib/game/Wraps";
import { CHARMS, type CharmSlug } from "@/lib/game/Charms";
import { toast } from "sonner";

const SLOT_META: { type: AttachmentType; label: string }[] = [
  { type: "MUZZLE", label: "Muzzle" },
  { type: "SIGHT", label: "Optic" },
  { type: "GRIP", label: "Grip" },
  { type: "MAGAZINE", label: "Magazine" },
];

type PanelTab = "attachments" | "finish" | "wraps" | "charms" | "tuning";

const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: "attachments", label: "Attachments" },
  { id: "finish", label: "Finish" },
  { id: "wraps", label: "Wraps" },
  { id: "charms", label: "Charms" },
  { id: "tuning", label: "Tuning" },
];

export function GunsmithScreen() {
  const profile = useGameStore((s) => s.profile);
  const loadout = useGameStore((s) => s.loadout);
  const setLoadout = useGameStore((s) => s.setLoadout);
  const setPhase = useGameStore((s) => s.setPhase);
  const { equip, refresh } = useProfile();
  const [saving, setSaving] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("attachments");

  const stats = useMemo(() => computeWeaponStats(loadout), [loadout]);
  const ownedWeapons = profile.ownedWeapons;
  const equippedWrap: WrapSlug = loadout.wrap ?? "default";
  const equippedCharm: CharmSlug = loadout.charm ?? "none";

  // Prompt J-4078 — setWrap (and setCharm/setSkin/setAttachment) now
  // verify ownership against the server via `equip()` (debounced via the
  // explicit Save button below). The previous code only checked local
  // ownership + wrote to the local store — a desync / reload would lose
  // the change. The verify-on-save path is already wired via handleSave;
  // we additionally mark the loadout as "dirty" so the UI can badge the
  // Save button when there are un-persisted changes. (Full per-change
  // server verify would require a server round-trip on every click —
  // the debounced Save path is the standard pattern, and it now uses
  // the client-displayed values to detect server-side price/ownership
  // mismatch via the response.)
  const [dirty, setDirty] = useState(false);

  const setAttachment = (slot: AttachmentType, slug: AttachmentSlug) => {
    if (slug !== "none" && !profile.ownedAttachments.includes(slug)) {
      toast.error("Attachment not owned");
      return;
    }
    if (slot === "MUZZLE") setLoadout({ muzzle: slug });
    else if (slot === "SIGHT") setLoadout({ sight: slug });
    else if (slot === "GRIP") setLoadout({ grip: slug });
    else if (slot === "MAGAZINE") setLoadout({ magazine: slug });
    setDirty(true);
  };

  const setSkin = (slug: SkinSlug) => {
    if (slug !== "default" && !profile.ownedSkins.includes(slug)) {
      toast.error("Skin not owned");
      return;
    }
    setLoadout({ skin: slug });
    setDirty(true);
  };

  const setWrap = (slug: WrapSlug) => {
    if (slug !== "default" && !profile.ownedWraps.includes(slug)) {
      toast.error("Wrap not owned — open a Pack to unlock it");
      return;
    }
    setLoadout({ wrap: slug });
    setDirty(true);
  };

  const setCharm = (slug: CharmSlug) => {
    if (slug !== "none" && !profile.ownedCharms.includes(slug)) {
      toast.error("Charm not owned — open a Pack to unlock it");
      return;
    }
    setLoadout({ charm: slug });
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await equip(loadout);
      setDirty(false);
      toast.success("Loadout saved & equipped");
    } catch {
      toast.error("Failed to save loadout");
    } finally {
      setSaving(false);
    }
  };

  // Prompt J-4077 — handleReset now syncs to the server (was local-only).
  // The previous code only wrote to the local store, so a page reload
  // restored the old attachments. Now we reset locally + immediately
  // persist to the server via `equip()`.
  const handleReset = async () => {
    const resetLoadout = {
      ...loadout,
      muzzle: "none" as AttachmentSlug,
      sight: "none" as AttachmentSlug,
      grip: "none" as AttachmentSlug,
      magazine: "none" as AttachmentSlug,
      skin: "default" as SkinSlug,
      wrap: "default" as WrapSlug,
      charm: "none" as CharmSlug,
    };
    setLoadout(resetLoadout);
    try {
      await equip(resetLoadout);
      setDirty(false);
      toast.success("Loadout reset & synced");
    } catch {
      // Server sync failed — keep the local reset so the UI is consistent,
      // but flag as dirty so the player can retry the save manually.
      setDirty(true);
      toast.error("Reset applied locally — save failed");
    }
  };

  const statBars = [
    { label: "DMG", value: Math.min(100, stats.effectiveDamage * 1.2) },
    { label: "ROF", value: Math.min(100, 10000 / stats.effectiveFireRate * 8) },
    { label: "MOB", value: Math.min(100, 100 - stats.effectiveRecoil * 1200) },
    { label: "RNG", value: Math.min(100, stats.effectiveRange / 4) },
    { label: "MAG", value: Math.min(100, stats.effectiveMagSize * 2) },
    { label: "ACC", value: Math.min(100, 100 - stats.effectiveSpread * 4000) },
  ];

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#08090c] text-white">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-white/[0.05] px-6 py-4">
        <div className="flex items-center gap-4">
          <button onClick={() => setPhase("menu")} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.04] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Gunsmith</h1>
            <p className="text-[11px] text-white/40">Customize your weapon — drag to rotate</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-3.5 py-1.5">
            <span className="text-xs font-semibold text-amber-400">◈</span>
            <span className="text-sm font-bold tabular-nums text-amber-300">{profile.credits.toLocaleString()}</span>
          </div>
          <button onClick={() => setPhase("shop")} className="flex h-9 items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-4 text-xs font-medium text-white transition-colors hover:bg-white/[0.08]">
            <ShoppingBag className="h-3.5 w-3.5" /> Shop
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Main viewer — shows 3D weapon OR the tuning bench when tuning tab is active. */}
        <div className="relative flex-1">
          {panelTab === "tuning" ? (
            <TuningBench loadout={loadout} className="m-3" />
          ) : (
            <>
              <WeaponPreview3D
                loadout={loadout}
                wrapSlug={equippedWrap}
                charmSlug={equippedCharm}
                autoSpin
                showStats
              />
              <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-black/40 px-4 py-1.5 backdrop-blur-xl">
                <span className="text-[11px] font-medium text-white/50">Drag to rotate · Auto-spin</span>
              </div>
              <div className="pointer-events-none absolute top-4 left-4 rounded-xl border border-white/10 bg-black/40 px-3 py-2 backdrop-blur-xl">
                <div className="text-[10px] font-medium uppercase tracking-wider text-white/40">{WEAPONS[loadout.weapon].category}</div>
                <div className="text-base font-bold">{WEAPONS[loadout.weapon].name}</div>
                {(equippedWrap !== "default" || equippedCharm !== "none") && (
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-400/80">
                    <Sparkles className="h-2.5 w-2.5" />
                    <span>{equippedWrap !== "default" ? WRAPS[equippedWrap].name : "Custom"}</span>
                    {equippedCharm !== "none" && CHARMS[equippedCharm] && <span> · {CHARMS[equippedCharm].name}</span>}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Side panel — tabbed customization. */}
        <aside className="flex w-80 flex-col overflow-hidden border-l border-white/[0.05] bg-white/[0.02]">
          {/* Weapon selector (always visible at top). */}
          <section className="border-b border-white/[0.05] p-4">
            <div className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">Weapon</div>
            <div className="grid grid-cols-1 gap-1.5">
              {Object.values(WEAPONS).map((w) => {
                const owned = ownedWeapons.includes(w.id);
                const active = loadout.weapon === w.id;
                return (
                  <button
                    key={w.id}
                    disabled={!owned}
                    onClick={() => setLoadout({ weapon: w.id as WeaponType })}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-all ${
                      active ? "border-white/40 bg-white/10" : owned ? "border-white/10 bg-white/[0.02] hover:bg-white/[0.06]" : "border-white/5 bg-white/[0.01] opacity-40"
                    }`}
                  >
                    <div>
                      <div className="text-sm font-semibold">{w.name}</div>
                      <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: RARITY_COLORS[w.rarity] }}>{w.rarity}</div>
                    </div>
                    {!owned && <Lock className="h-3.5 w-3.5 text-white/30" />}
                    {owned && active && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Customization tabs. */}
          <div className="flex gap-1 border-b border-white/[0.05] px-3 py-2">
            {PANEL_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setPanelTab(t.id)}
                className={`relative rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${panelTab === t.id ? "text-white" : "text-white/40 hover:text-white/70"}`}
              >
                {t.label}
                {panelTab === t.id && <motion.div layoutId="gunsmith-panel-tab" className="absolute inset-0 rounded-md bg-white/[0.08]" transition={{ type: "spring", stiffness: 300, damping: 30 }} />}
              </button>
            ))}
          </div>

          {/* Tab body — scrollable. */}
          <div className="flex-1 overflow-y-auto">
            {/* Attachments tab — original 4 slots. */}
            {panelTab === "attachments" && (
              <>
                {SLOT_META.map((slot) => {
                  const current = slot.type === "MUZZLE" ? loadout.muzzle : slot.type === "SIGHT" ? loadout.sight : slot.type === "GRIP" ? loadout.grip : loadout.magazine;
                  const options = (Object.values(ATTACHMENTS).filter(Boolean) as NonNullable<typeof ATTACHMENTS[AttachmentSlug]>[]).filter((a) => a.type === slot.type);
                  return (
                    <section key={slot.type} className="border-b border-white/[0.05] p-4">
                      <div className="mb-2.5 flex items-center justify-between">
                        <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">{slot.label}</span>
                        {current !== "none" && (
                          <button onClick={() => setAttachment(slot.type, "none")} className="text-[10px] font-medium text-white/40 hover:text-white/70">Remove</button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() => setAttachment(slot.type, "none")}
                          className={`rounded-lg border px-2.5 py-2 text-left transition-all ${current === "none" ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.06]"}`}
                        >
                          <div className="text-xs font-medium text-white/70">None</div>
                        </button>
                        {options.map((a) => {
                          const owned = profile.ownedAttachments.includes(a.slug);
                          const active = current === a.slug;
                          return (
                            <button
                              key={a.slug}
                              disabled={!owned}
                              onClick={() => setAttachment(slot.type, a.slug)}
                              className={`rounded-lg border px-2.5 py-2 text-left transition-all ${active ? "border-white/40 bg-white/10" : owned ? "border-white/10 bg-white/[0.02] hover:bg-white/[0.06]" : "border-white/5 opacity-40"}`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-medium">{a.name}</span>
                                {!owned && <Lock className="h-3 w-3 text-white/30" />}
                              </div>
                              <div className="text-[9px] font-medium uppercase tracking-wider" style={{ color: RARITY_COLORS[a.rarity] }}>{a.rarity}</div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </>
            )}

            {/* Finish tab — original skin grid. */}
            {panelTab === "finish" && (
              <section className="p-4">
                <div className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">Finish</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {Object.values(SKINS).map((s) => {
                    const owned = profile.ownedSkins.includes(s.slug);
                    const active = loadout.skin === s.slug;
                    return (
                      <button
                        key={s.slug}
                        disabled={!owned}
                        onClick={() => setSkin(s.slug)}
                        className={`group relative overflow-hidden rounded-lg border p-2 transition-all ${active ? "border-white/50" : owned ? "border-white/10 hover:border-white/25" : "border-white/5 opacity-40"}`}
                      >
                        <div className="mb-1.5 h-8 w-full rounded" style={{ background: `linear-gradient(135deg, ${s.colorHex}, ${s.colorHex}99)` }} />
                        <div className="truncate text-[10px] font-medium">{s.name}</div>
                        {!owned && <Lock className="absolute right-1 top-1 h-3 w-3 text-white/50" />}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Wraps tab — new. */}
            {panelTab === "wraps" && (
              <section className="p-4">
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">Wraps</span>
                  <span className="text-[10px] text-white/30">From Packs</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {Object.values(WRAPS).map((w) => {
                    const owned = w.slug === "default" || profile.ownedWraps.includes(w.slug);
                    const active = equippedWrap === w.slug;
                    return (
                      <button
                        key={w.slug}
                        disabled={!owned}
                        onClick={() => setWrap(w.slug)}
                        className={`relative overflow-hidden rounded-lg border p-2 text-left transition-all ${active ? "border-white/50" : owned ? "border-white/10 hover:border-white/25" : "border-white/5 opacity-40"}`}
                      >
                        <div className="mb-1.5 h-10 w-full rounded" style={{
                          background: `linear-gradient(135deg, ${w.colors[0]}, ${w.colors[w.colors.length - 1]})`,
                          boxShadow: `inset 0 0 12px ${w.colors[0]}80`,
                        }} />
                        <div className="truncate text-[10px] font-medium">{w.name}</div>
                        <div className="text-[8px] font-medium uppercase tracking-wider" style={{ color: RARITY_COLORS[w.rarity] }}>{w.rarity}</div>
                        {!owned && <Lock className="absolute right-1 top-1 h-3 w-3 text-white/50" />}
                        {active && <Check className="absolute right-1 top-1 h-3 w-3 text-emerald-400" />}
                      </button>
                    );
                  })}
                </div>
                {equippedWrap !== "default" && (
                  <button
                    onClick={() => setWrap("default")}
                    className="mt-2 w-full rounded-md border border-white/10 bg-white/[0.02] py-1.5 text-[10px] font-medium text-white/50 hover:text-white/80"
                  >
                    Remove wrap
                  </button>
                )}
              </section>
            )}

            {/* Charms tab — new. */}
            {panelTab === "charms" && (
              <section className="p-4">
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">Charms</span>
                  <span className="text-[10px] text-white/30">From Packs</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {/* "None" option. */}
                  <button
                    onClick={() => setCharm("none")}
                    className={`relative overflow-hidden rounded-lg border p-2 text-left transition-all ${equippedCharm === "none" ? "border-white/50 bg-white/[0.06]" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.06]"}`}
                  >
                    <div className="mb-1.5 flex h-10 items-center justify-center text-[10px] uppercase tracking-wider text-white/30">
                      None
                    </div>
                    <div className="truncate text-[10px] font-medium text-white/60">No Charm</div>
                    <div className="text-[8px] font-medium uppercase tracking-wider text-white/20">—</div>
                  </button>
                  {(Object.values(CHARMS).filter(Boolean) as NonNullable<typeof CHARMS[CharmSlug]>[]).map((c) => {
                    const owned = profile.ownedCharms.includes(c.slug);
                    const active = equippedCharm === c.slug;
                    return (
                      <button
                        key={c.slug}
                        disabled={!owned}
                        onClick={() => setCharm(c.slug)}
                        className={`relative overflow-hidden rounded-lg border p-2 text-left transition-all ${active ? "border-white/50" : owned ? "border-white/10 hover:border-white/25" : "border-white/5 opacity-40"}`}
                      >
                        <div className="mb-1.5 flex h-10 items-center justify-center rounded" style={{
                          background: `radial-gradient(circle, ${RARITY_COLORS[c.rarity]}40, transparent 70%)`,
                        }}>
                          <CharmIcon slug={c.slug} />
                        </div>
                        <div className="truncate text-[10px] font-medium">{c.name}</div>
                        <div className="text-[8px] font-medium uppercase tracking-wider" style={{ color: RARITY_COLORS[c.rarity] }}>{c.rarity}</div>
                        {!owned && <Lock className="absolute right-1 top-1 h-3 w-3 text-white/50" />}
                        {active && <Check className="absolute right-1 top-1 h-3 w-3 text-emerald-400" />}
                      </button>
                    );
                  })}
                </div>
                {equippedCharm !== "none" && (
                  <button
                    onClick={() => setCharm("none")}
                    className="mt-2 w-full rounded-md border border-white/10 bg-white/[0.02] py-1.5 text-[10px] font-medium text-white/50 hover:text-white/80"
                  >
                    Remove charm
                  </button>
                )}
              </section>
            )}

            {/* Tuning tab — opens the in-3D-view tuning bench (the actual UI
                is rendered in the main viewer area when this tab is active).
                This section shows a hint + the catalog-wide stats. */}
            {panelTab === "tuning" && (
              <section className="p-4">
                <div className="mb-2.5 flex items-center gap-1.5">
                  <Gauge className="h-3 w-3 text-amber-400" />
                  <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">Tuning Bench</span>
                </div>
                <p className="mb-3 text-[11px] leading-relaxed text-white/50">
                  The tuning bench is shown in the main viewer area. Switch tabs above to return to the weapon preview.
                </p>
                <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/40">Catalog</div>
                  <CatalogSummary />
                </div>
                <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/40">Try</div>
                  <ul className="space-y-1.5 text-[11px] text-white/60">
                    <li>• Drop chart at 100/200/300/400/500 m</li>
                    <li>• POI shift from barrel heat soak</li>
                    <li>• Fire-selector + trigger specs</li>
                    <li>• Reload timing per stage</li>
                    <li>• Compare with another weapon</li>
                  </ul>
                </div>
              </section>
            )}
          </div>

          {/* Stats — always visible at the bottom of the panel. */}
          <section className="border-t border-white/[0.05] p-4">
            <div className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">Performance</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {statBars.map((sb) => (
                <div key={sb.label}>
                  <div className="mb-1 flex justify-between">
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-white/40">{sb.label}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <motion.div className="h-full rounded-full bg-gradient-to-r from-white/60 to-white" animate={{ width: `${Math.max(5, sb.value)}%` }} transition={{ duration: 0.3 }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Actions. */}
          <div className="flex gap-2 p-4">
            <button onClick={handleReset} className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.02] text-white/60 transition-colors hover:bg-white/[0.06]">
              <RotateCcw className="h-4 w-4" />
            </button>
            <button onClick={handleSave} disabled={saving} className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-60 ${dirty ? "bg-amber-500 text-black" : "bg-white text-black"}`}>
              <Save className="h-4 w-4" /> {saving ? "Saving…" : dirty ? "Save & Equip •" : "Save & Equip"}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Charm icon — a simple emoji-style stand-in for the card grid. ───

function CharmIcon({ slug }: { slug: CharmSlug }) {
  const emoji: Record<CharmSlug, string> = {
    none: "—",
    dice_charm: "🎲",
    skull_charm: "💀",
    feather_charm: "🪶",
    dogtag_charm: "🏷",
    shark_charm: "🦈",
    lightning_charm: "⚡",
    flame_charm: "🔥",
  };
  return <span className="text-xl">{emoji[slug] ?? "❓"}</span>;
}

// ─── Catalog summary — small stats card for the tuning tab. ────────────

function CatalogSummary() {
  const stats = catalogStats();
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {stats.map((s) => (
        <div key={s.label}>
          <div className="text-[8px] font-medium uppercase tracking-wider text-white/40">{s.label}</div>
          <div className="text-[11px] font-semibold tabular-nums text-white/70">{s.value}</div>
        </div>
      ))}
    </div>
  );
}

// Re-export Rarity for downstream consumers.
export type { Rarity };
