"use client";

import { useState, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Check, Coins, User, Shield, RotateCcw, Save, Shuffle,
  Eye, Shirt, Backpack, HardHat, Sparkles, Wrench, Glasses,
} from "lucide-react";
import { useGameStore } from "@/lib/game/store";
import { useProfile, saveOperatorCustomization } from "@/lib/game/useProfile";
import { OperatorPreview3D } from "@/components/game/OperatorPreview3D";
import {
  OPERATORS,
  OPERATOR_RARITY_COLORS,
  type OperatorCatalogEntry,
  type OperatorHelmet,
} from "@/lib/game/operators";
import {
  CUSTOMIZABLE_FIELDS,
  CUSTOMIZATION_GROUP_LABELS,
  CUSTOMIZATION_GROUP_ORDER,
  DEFAULT_CUSTOMIZATION,
  isPristine,
  randomizeOverrides,
  resolveOperatorVisual,
  type CustomizableField,
  type OperatorCustomization,
  type OperatorCustomizationOverrides,
} from "@/lib/game/OperatorCustom";
import { toast } from "sonner";

const EASE_APPLE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#06070a]";

// ============================================================================
// Main component — full operator customization studio.
// 3-column layout: preset selector | 3D live preview | customization controls.
// ============================================================================

export function OperatorScreen() {
  const setPhase = useGameStore((s) => s.setPhase);
  const operator = useGameStore((s) => s.operator);
  const profile = useGameStore((s) => s.profile);
  const ownedOperators = useGameStore((s) => s.ownedOperators);
  const equippedCustomization = useGameStore((s) => s.equippedCustomization);
  const setEquippedCustomization = useGameStore((s) => s.setEquippedCustomization);
  const patchCustomizationOverride = useGameStore((s) => s.patchCustomizationOverride);
  const resetCustomizationToPreset = useGameStore((s) => s.resetCustomizationToPreset);

  // Local working copy — keeps the persisted state stable until SAVE.
  const [working, setWorking] = useState<OperatorCustomization>(equippedCustomization);
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Sync working copy to the live store so the 3D preview updates in real-time.
  const pushToStore = useCallback(
    (c: OperatorCustomization) => {
      setWorking(c);
      setEquippedCustomization(c);
    },
    [setEquippedCustomization],
  );

  const basePreset = useMemo<OperatorCatalogEntry>(
    () => OPERATORS.find((o) => o.slug === working.baseSlug) ?? OPERATORS[0],
    [working.baseSlug],
  );

  const pristine = isPristine(working);
  const isDirty = useMemo(
    () => JSON.stringify(working) !== JSON.stringify(equippedCustomization),
    [working, equippedCustomization],
  );

  // ─── Handlers ─────────────────────────────────────────────────────────
  const handleSelectPreset = (slug: string) => {
    if (!ownedOperators.includes(slug)) return;
    pushToStore({ baseSlug: slug, overrides: {} });
  };

  const handlePatch = <K extends keyof OperatorCustomizationOverrides>(
    key: K,
    value: OperatorCustomizationOverrides[K],
  ) => {
    const next: OperatorCustomization = {
      baseSlug: working.baseSlug,
      overrides: { ...working.overrides, [key]: value },
    };
    pushToStore(next);
  };

  const handleReset = () => {
    pushToStore({ baseSlug: working.baseSlug, overrides: {} });
    toast.success(`Reset to ${basePreset.callsign} defaults`);
  };

  const handleRandomize = () => {
    pushToStore({
      baseSlug: working.baseSlug,
      overrides: { ...working.overrides, ...randomizeOverrides() },
    });
    toast.success("Randomized appearance");
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await saveOperatorCustomization(working);
      setEquippedCustomization(saved);
      setWorking(saved);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
      toast.success("Operator customization saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  // The 3D preview uses the equipped slug from the store. We need it to be
  // the working copy's slug so swapping presets re-renders the figure. The
  // store's equippedCustomization.baseSlug is what getOperatorVisual sees.
  const previewSlug = working.baseSlug;

  // Group controls by section for rendering.
  const grouped = useMemo(() => {
    const m = new Map<string, CustomizableField[]>();
    for (const g of CUSTOMIZATION_GROUP_ORDER) m.set(g, []);
    for (const f of CUSTOMIZABLE_FIELDS) m.get(f.group)?.push(f);
    return m;
  }, []);

  return (
    <div className="absolute inset-0 z-40 overflow-hidden bg-[#06070a] text-white noise-overlay">
      {/* Ambient backdrop */}
      <div aria-hidden className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0b0e] via-[#06070a] to-[#040506]" />
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
            WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 80%)",
          }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_75%_30%,rgba(255,140,26,0.10),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_20%_80%,rgba(40,60,90,0.15),transparent_60%)]" />
      </div>

      <div className="relative z-10 flex h-screen flex-col">
        {/* ═══ Header ════════════════════════════════════════════════════ */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/[0.06] px-5 sm:px-8">
          <button
            type="button"
            onClick={() => setPhase("menu")}
            className={`flex h-11 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] pl-3 pr-4 text-sm font-medium text-white/80 backdrop-blur-2xl transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold tracking-tight">Operator Studio</span>
            <span className="ml-2 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
              {basePreset.callsign}
            </span>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/8 px-3 py-1.5 backdrop-blur-xl">
            <Coins className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-[13px] font-bold tabular text-amber-300">
              {profile.credits.toLocaleString()}
            </span>
          </div>
        </header>

        {/* ═══ Body — 3-column ═══════════════════════════════════════════ */}
        <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
          {/* ─── Left column — Preset Selector ─────────────────────────── */}
          <aside className="order-2 w-full shrink-0 overflow-y-auto border-t border-white/[0.06] p-4 lg:order-1 lg:w-72 lg:border-t-0 lg:border-r scroll-thin">
            <div className="mb-3 flex items-center gap-2 px-1">
              <Shield className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.25em] text-white/45">
                Base Preset
              </span>
            </div>
            <div className="space-y-2">
              {OPERATORS.map((op) => (
                <PresetCard
                  key={op.slug}
                  op={op}
                  selected={working.baseSlug === op.slug}
                  owned={ownedOperators.includes(op.slug)}
                  onSelect={() => handleSelectPreset(op.slug)}
                />
              ))}
            </div>
            <p className="mt-3 px-1 text-[10px] leading-relaxed text-white/35">
              Selecting a preset resets all overrides to its defaults. Then
              fine-tune any field in the right panel.
            </p>
          </aside>

          {/* ─── Center column — 3D Live Preview ──────────────────────── */}
          <main className="relative order-1 flex min-h-[320px] flex-1 flex-col overflow-hidden lg:order-2">
            <div className="absolute inset-0 flex items-center justify-center">
              <AnimatePresence mode="wait">
                <motion.div
                  key={previewSlug}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.5, ease: EASE_APPLE }}
                  className="relative h-full w-full max-w-[520px]"
                >
                  <OperatorPreview3D
                    operator={operator}
                    operatorSlug={previewSlug}
                    className="h-full w-full"
                  />
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Nameplate (top-center) */}
            <motion.div
              key={`name-${previewSlug}`}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE_APPLE }}
              className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2"
            >
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className="rounded-full border px-4 py-1 backdrop-blur-xl"
                  style={{
                    borderColor: `${OPERATOR_RARITY_COLORS[basePreset.rarity]}40`,
                    background: `${OPERATOR_RARITY_COLORS[basePreset.rarity]}12`,
                  }}
                >
                  <span
                    className="text-[9px] font-semibold uppercase tracking-[0.3em]"
                    style={{ color: `${OPERATOR_RARITY_COLORS[basePreset.rarity]}cc` }}
                  >
                    {basePreset.rarity} · {basePreset.faction}
                  </span>
                </div>
                <span className="text-2xl font-bold tracking-tight text-gradient-amber">
                  {basePreset.callsign}
                </span>
                <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">
                  {basePreset.name}
                </span>
              </div>
            </motion.div>

            {/* Drag/zoom hint */}
            <div className="pointer-events-none absolute bottom-20 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.25em] text-white/25">
              Drag to rotate · Scroll to zoom
            </div>

            {/* Reset-to-preset button (top-right of preview) */}
            <div className="absolute right-4 top-4 z-10 flex flex-col gap-2">
              <button
                type="button"
                onClick={handleReset}
                disabled={pristine}
                className={`flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-black/40 px-3 py-1.5 text-[11px] font-semibold text-white/70 backdrop-blur-xl transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
              >
                <RotateCcw className="h-3 w-3" />
                Reset to Preset
              </button>
              <button
                type="button"
                onClick={handleRandomize}
                className={`flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-black/40 px-3 py-1.5 text-[11px] font-semibold text-white/70 backdrop-blur-xl transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
              >
                <Shuffle className="h-3 w-3" />
                Randomize
              </button>
            </div>
          </main>

          {/* ─── Right column — Customization Controls ────────────────── */}
          <aside className="order-3 w-full shrink-0 overflow-y-auto border-t border-white/[0.06] p-4 lg:order-3 lg:w-80 lg:border-t-0 lg:border-l scroll-thin">
            <div className="mb-3 flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Wrench className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.25em] text-white/45">
                  Customization
                </span>
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/30">
                {pristine ? "Pristine" : "Modified"}
              </span>
            </div>

            <div className="space-y-4">
              {CUSTOMIZATION_GROUP_ORDER.map((group) => {
                const fields = grouped.get(group) ?? [];
                if (fields.length === 0) return null;
                return (
                  <ControlSection key={group} group={group}>
                    {fields.map((f) => (
                      <ControlRow
                        key={f.key}
                        field={f}
                        value={working.overrides[f.key]}
                        baseValue={basePreset.visual}
                        onChange={(v) => handlePatch(f.key, v as never)}
                      />
                    ))}
                  </ControlSection>
                );
              })}
            </div>
          </aside>
        </div>

        {/* ═══ Bottom bar — actions ══════════════════════════════════════ */}
        <footer className="shrink-0 border-t border-white/[0.06] bg-black/30 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-2 text-[11px] text-white/40">
              <span className="hidden sm:inline">Changes apply to the 3D preview in real-time.</span>
              {isDirty ? (
                <span className="flex items-center gap-1.5 text-amber-400/80">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(255,140,26,0.6)]" />
                  Unsaved
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-emerald-400/70">
                  <Check className="h-3 w-3" />
                  In sync
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRandomize}
                className={`flex h-10 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-semibold text-white/70 backdrop-blur-xl transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
              >
                <Shuffle className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">RANDOMIZE</span>
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={pristine}
                className={`flex h-10 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-semibold text-white/70 backdrop-blur-xl transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">RESET</span>
              </button>
              <button
                type="button"
                onClick={() => setPhase("menu")}
                className={`flex h-10 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 text-[12px] font-semibold text-white/80 backdrop-blur-xl transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                BACK
              </button>
              <motion.button
                type="button"
                onClick={handleSave}
                disabled={busy || !isDirty}
                whileHover={isDirty ? { scale: 1.02 } : undefined}
                whileTap={isDirty ? { scale: 0.97 } : undefined}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                className={`flex h-11 items-center gap-2 rounded-full bg-gradient-to-r from-amber-500 to-amber-600 px-7 text-[13px] font-bold text-black shadow-[0_0_24px_rgba(255,140,26,0.4)] transition-shadow disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${FOCUS_RING}`}
              >
                {savedFlash ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                {busy ? "SAVING…" : savedFlash ? "SAVED" : "SAVE"}
              </motion.button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ============================================================================
// Preset card — base operator selector.
// ============================================================================

function PresetCard({
  op,
  selected,
  owned,
  onSelect,
}: {
  op: OperatorCatalogEntry;
  selected: boolean;
  owned: boolean;
  onSelect: () => void;
}) {
  const rarityColor = OPERATOR_RARITY_COLORS[op.rarity];
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!owned}
      className={`group relative w-full overflow-hidden rounded-xl border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING} ${
        selected
          ? "border-amber-500/40 bg-amber-500/8"
          : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05]"
      }`}
    >
      {/* Rarity accent strip (left edge) */}
      <div
        className="absolute left-0 top-0 h-full w-1"
        style={{ background: rarityColor, opacity: selected ? 1 : 0.5 }}
      />
      <div className="flex items-center gap-3 pl-1.5">
        {/* Operator avatar swatch — suit + accent */}
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border"
          style={{
            background: `${op.visual.suit}40`,
            borderColor: `${rarityColor}40`,
          }}
        >
          <div
            className="h-6 w-6 rounded-full"
            style={{
              background: `linear-gradient(135deg, ${op.visual.suit} 0%, ${op.visual.helmet} 60%, ${op.visual.accent} 140%)`,
              boxShadow: `0 0 10px ${op.visual.accent}50`,
            }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-bold text-white/90">{op.name}</span>
            {selected && (
              <span className="flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-amber-300">
                <Check className="h-2.5 w-2.5" /> Base
              </span>
            )}
          </div>
          <div className="truncate text-[10px] font-medium uppercase tracking-wider text-white/40">
            {op.callsign} · {op.faction}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className="text-[9px] font-bold uppercase tracking-wider"
              style={{ color: rarityColor }}
            >
              {op.rarity}
            </span>
            {!owned && (
              <span className="flex items-center gap-0.5 text-[10px] font-semibold text-white/45">
                <Coins className="h-2.5 w-2.5 text-amber-400/70" />
                {op.price.toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </div>
      {op.rarity === "LEGENDARY" && (
        <Sparkles className="pointer-events-none absolute right-2 top-2 h-3 w-3 text-amber-400/60" />
      )}
    </button>
  );
}

// ============================================================================
// Control section — grouped customization controls.
// ============================================================================

const GROUP_ICON: Record<string, typeof Eye> = {
  face: Eye,
  clothing: Shirt,
  gear: HardHat,
  pads: Shield,
  details: Sparkles,
  helmet: HardHat,
  accessories: Backpack,
};

function ControlSection({
  group,
  children,
}: {
  group: string;
  children: React.ReactNode;
}) {
  const Icon = GROUP_ICON[group] ?? Wrench;
  return (
    <div className="tactical-panel rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="mb-2.5 flex items-center gap-2 px-0.5">
        <Icon className="h-3 w-3 text-amber-400/80" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/55">
          {CUSTOMIZATION_GROUP_LABELS[group as keyof typeof CUSTOMIZATION_GROUP_LABELS] ?? group}
        </span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

// ============================================================================
// Control row — dispatches to the right input based on field.type.
// ============================================================================

function ControlRow({
  field,
  value,
  baseValue,
  onChange,
}: {
  field: CustomizableField;
  value: unknown;
  baseValue: OperatorCatalogEntry["visual"];
  onChange: (v: unknown) => void;
}) {
  // Resolve the current effective value — override if set, else base preset.
  const effective = resolveEffective(field, value, baseValue);
  const isOverridden = value !== undefined;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[12px] font-medium text-white/70">{field.label}</span>
        {isOverridden && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-amber-400/60 hover:text-amber-400"
            aria-label={`Reset ${field.label} to preset`}
          >
            reset
          </button>
        )}
      </div>
      <div className="shrink-0">
        {field.type === "color" && (
          <ColorSwatch
            value={effective as string}
            onChange={(v) => onChange(v)}
          />
        )}
        {field.type === "slider" && (
          <SliderInput
            value={effective as number}
            min={field.min ?? 0}
            max={field.max ?? 1}
            step={field.step ?? 0.05}
            onChange={(v) => onChange(v)}
          />
        )}
        {field.type === "toggle" && (
          <ToggleSwitch
            value={Boolean(effective)}
            onChange={(v) => onChange(v)}
          />
        )}
        {field.type === "select" && (
          <SelectInput
            value={effective as string}
            options={field.options ?? []}
            onChange={(v) => onChange(v)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Resolves the effective value for a field — uses the override if set,
 * otherwise falls back to the base preset's OperatorVisual field (for the
 * 7 base fields) or a sensible default (for extended fields).
 */
function resolveEffective(
  field: CustomizableField,
  value: unknown,
  base: OperatorCatalogEntry["visual"],
): string | number | boolean {
  if (value !== undefined) return value as string | number | boolean;
  switch (field.key) {
    case "suit": return base.suit;
    case "accent": return base.accent;
    case "vest": return base.vest;
    case "helmet": return base.helmet;
    case "visorTint": return base.visorTint;
    case "skinTone": return base.skinTone;
    case "helmetStyle": return base.helmetStyle;
    // Extended fields — sensible defaults until overridden.
    case "eyeColor": return "#4a6a8a";
    case "lipColor": return "#8a4a3a";
    case "hairColor": return "#2a1a10";
    case "pantsColor": return base.suit;
    case "jacketColor": return base.vest;
    case "gloveColor": return base.vest;
    case "bootColor": return "#1a1a1e";
    case "bagColor": return base.vest;
    case "pouchColor": return "#3a3a3e";
    case "kneePadColor": return "#1a1a1e";
    case "elbowPadColor": return "#1a1a1e";
    case "balaclavaColor": return base.suit;
    // Accessories — default off.
    case "hasNVG": return false;
    case "hasHeadset": return false;
    case "hasBackpack": return false;
    case "hasBalaclava": return base.helmetStyle === "full" || base.helmetStyle === "visor";
    case "hasKneePads": return false;
    case "hasElbowPads": return false;
    case "hasSidearm": return false;
    case "hasGlasses": return false;
    default: return "#ffffff";
  }
}

// ============================================================================
// Atomic controls.
// ============================================================================

function ColorSwatch({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  // Hidden native color input — opened on swatch click.
  return (
    <label
      className="flex cursor-pointer items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] py-1 pl-1 pr-2.5 transition-colors hover:bg-white/[0.06]"
      title="Click to pick a color"
    >
      <span
        className="h-6 w-6 rounded-full border border-white/20 shadow-inner"
        style={{ backgroundColor: value }}
      />
      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-white/70">
        {value.replace("#", "")}
      </span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
        aria-label="Color picker"
      />
    </label>
  );
}

function SliderInput({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-white/10 accent-amber-500"
        aria-label="Slider"
      />
      <span className="w-9 text-right font-mono text-[10px] font-semibold tabular-nums text-white/70">
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function ToggleSwitch({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative h-5 w-9 rounded-full border transition-colors ${FOCUS_RING} ${
        value
          ? "border-amber-500/40 bg-amber-500/30"
          : "border-white/[0.08] bg-white/[0.04]"
      }`}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full ${
          value ? "right-0.5 bg-amber-400" : "left-0.5 bg-white/50"
        }`}
      />
    </button>
  );
}

function SelectInput({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as OperatorHelmet)}
      className={`h-7 rounded-full border border-white/[0.08] bg-[#0a0b0e] px-3 text-[11px] font-semibold text-white/80 backdrop-blur-xl transition-colors hover:bg-white/[0.06] focus:bg-[#0a0b0e] ${FOCUS_RING}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-[#0a0b0e] text-white">
          {o.label}
        </option>
      ))}
    </select>
  );
}
