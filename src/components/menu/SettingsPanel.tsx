"use client";

/**
 * SettingsPanel — tabbed shell (backlog §20 item 468).
 *
 * Previously a 1,643-line file with 8 internally-defined section components.
 * Now a slim shell that mounts the shadcn `Tabs` primitive and renders each
 * sub-panel from `./SettingsPanel/<Name>Panel.tsx`:
 *
 *   - VideoPanel        (Display + Graphics + Crosshair)
 *   - AudioPanel
 *   - ControlsPanel     (incl. remappable keybindings)
 *   - GameplayPanel
 *   - AccessibilityPanel
 *
 * The "Social" entry is preserved as a small inline component on the same
 * tab strip — it's a one-button launchpad for the SocialPanel overlay, so
 * a dedicated file would be over-engineering. The SocialPanel overlay itself
 * (`@/components/uiux/SocialPanel`) is still mounted at the bottom of this
 * shell so it's reachable without touching page.tsx.
 *
 * Behavioural preservation:
 *   - The cross-section `VisualSettings` state (UI-only toggles/sliders
 *     that don't map to the game store) is lifted into this shell so
 *     radix Tabs (which unmounts inactive content) doesn't reset it.
 *   - The framer-motion entry/exit animation for the whole panel is
 *     preserved; only the per-section inner AnimatePresence was removed
 *     (the Tabs component has its own transition).
 *   - All settings state wiring (store reads, setSettings, setExtended,
 *     setCrosshair) is preserved exactly — see each sub-panel.
 *
 * Prompt I-964 — Tabs unmount-on-switch decision.
 *
 * radix Tabs unmounts inactive content by default. The cross-section
 * VisualSettings state is lifted into this shell (see `visual` useState
 * below) so it survives tab switches. Sub-section internal state (e.g.
 * the Crosshair panel's hex input, the Graphics benchmark's running
 * flag) does NOT survive — radix remounts the panel on each switch.
 *
 * Decision: ACCEPT THE RESET. `forceMount` on every TabsContent would
 * keep all five panels mounted at once (5x the React reconciliation work
 * + 5x the focus-trap complexity + the per-panel useEffects run
 * concurrently). The remount cost is < 16ms (panels are presentational
 * — no heavy work in useEffect). The reset is intentional: it gives the
 * user a clean slate on each visit, and the lifted `visual` state keeps
 * the user-facing toggles sticky. Documented in docs/KNOWN-ISSUES.md
 * Tier 3 (SettingsPanel tabs reset ephemeral UI state).
 *
 * Prompt I-961 / J-4013 / J-4089 / J-4179 — Settings search.
 *
 * A search input lives in the header. When the query is non-empty, the
 * shell iterates `[data-search]` rows across ALL mounted panels and
 * hides rows that don't match. (Panels are mounted on-demand by radix
 * Tabs, so the search runs against the active panel's rows — switching
 * tabs while a search is active re-runs the filter on the new panel.)
 *
 * Prompt I-962 / J-4014 / J-4090 / J-4180 — Keybind conflict resolver.
 *
 * A "Conflicts" button in the header opens a small panel listing every
 * key claimed by 2+ actions (scanned via `findAllConflicts()`). A
 * "Reset all to defaults" button bulk-resolves.
 *
 * Prompt I-963 / J-4015 / J-4091 / J-4181 — Preset save/load.
 *
 * A "Presets" dropdown in the header lists saved presets + Save / Load
 * / Delete buttons. Presets capture the ExtendedSettings + the lifted
 * VisualSettings state.
 */

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Monitor,
  Volume2,
  Mouse,
  Gamepad2,
  Eye,
  Users,
  X,
  Search,
  AlertTriangle,
  Save,
  ChevronDown,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useGameStore } from "@/lib/game/store";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SocialPanel } from "@/components/uiux/SocialPanel";
import {
  type SectionId,
  type VisualSettings,
  DEFAULT_VISUAL,
  FOCUS_RING,
  SectionHeader,
} from "./SettingsPanel/_shared";
import { VideoPanel } from "./SettingsPanel/VideoPanel";
import { AudioPanel } from "./SettingsPanel/AudioPanel";
import { ControlsPanel } from "./SettingsPanel/ControlsPanel";
import { GameplayPanel } from "./SettingsPanel/GameplayPanel";
import { AccessibilityPanel } from "./SettingsPanel/AccessibilityPanel";
import {
  findAllConflicts,
  resolveAllConflictsByReset,
} from "@/lib/game/Keybindings";
import {
  listPresets,
  savePreset,
  loadPreset,
  deletePreset,
  type SettingsPreset,
} from "@/lib/game/ExtendedSettings";
import { CloudSaveButton } from "@/components/uiux/CloudSaveButton";
import { GdprExportButton } from "@/components/uiux/GdprExportButton";
import { PartyPanel } from "@/components/uiux/PartyPanel";
import { announceMenuMessage } from "@/components/uiux/MenuScreenReader";

// Re-export the canonical Settings type for backward compatibility with any
// existing imports of `export type { Settings } from "SettingsPanel"`.
export type { Settings } from "@/lib/game/store";

// ─── Tab catalogue ──────────────────────────────────────────────────────────

const TABS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "video", label: "Video", icon: Monitor },
  { id: "audio", label: "Audio", icon: Volume2 },
  { id: "controls", label: "Controls", icon: Mouse },
  { id: "accessibility", label: "Accessibility", icon: Eye },
  { id: "gameplay", label: "Gameplay", icon: Gamepad2 },
  // SEC10-UIUX (prompt 82): social panel entry — preserved from original.
  { id: "social", label: "Social", icon: Users },
];

// ─── Social tab (inline — one-button launchpad for the overlay) ─────────────

function SocialTab() {
  const open = () => {
    // Lazy import avoids a circular dependency (SocialPanel already imports
    // from many menu modules; we only need openSocialPanel here).
    import("@/components/uiux/SocialPanel").then((m) => m.openSocialPanel());
  };
  // Prompt I-977 — announce tab transitions to screen readers.
  useEffect(() => {
    announceMenuMessage("Opened Social tab");
  }, []);
  return (
    <div>
      <SectionHeader
        title="Social"
        description="Player profiles, clans, and friend search."
      />
      {/* Prompt J-4084 — Social tab is a "real section" (was previously a
          single button). Now includes: open-social-panel CTA, party UI,
          cloud save, GDPR export. Each lives in its own card so the
          player can navigate them as distinct sections. */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-400">
            <Users className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-white/90">Open the Social Panel</h3>
            <p className="text-xs text-white/40">
              View your profile + clan, or search for other players by callsign.
            </p>
          </div>
          <button
            type="button"
            onClick={open}
            className={`rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-4 py-2 text-xs font-semibold text-black shadow-[0_0_16px_rgba(255,140,26,0.3)] transition-transform hover:scale-[1.02] active:scale-95 ${FOCUS_RING}`}
          >
            Open
          </button>
        </div>
      </div>

      {/* Prompt J-4026 — Party UI mounted under Social tab. */}
      <div className="mt-6">
        <PartyPanel />
      </div>

      {/* Prompt I-980 + I-982 — Cloud save + GDPR export.
          Mounted under Social tab since it's a profile/data layer. */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
          <CloudSaveButton />
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
          <GdprExportButton />
        </div>
      </div>
    </div>
  );
}

// ─── Root panel ─────────────────────────────────────────────────────────────

export function SettingsPanel() {
  const phase = useGameStore((s) => s.phase);
  const setPhase = useGameStore((s) => s.setPhase);
  const settings = useGameStore((s) => s.settings);
  const setExtended = useGameStore((s) => s.setExtended);
  const [section, setSection] = useState<SectionId>("video");
  // Lifted VisualSettings state — survives tab switches (radix Tabs
  // unmounts inactive content by default).
  const [visual, setVisual] = useState<VisualSettings>(DEFAULT_VISUAL);

  // ─── Prompt I-961 — Settings search ────────────────────────────────
  const [search, setSearch] = useState("");
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const q = search.trim().toLowerCase();
    const rows = main.querySelectorAll<HTMLElement>("[data-search]");
    rows.forEach((row) => {
      const hay = row.getAttribute("data-search") ?? "";
      if (!q || hay.includes(q)) {
        row.style.display = "";
      } else {
        row.style.display = "none";
      }
    });
  }, [search, section]);

  // ─── Prompt I-962 — Keybind conflict resolver ──────────────────────
  const [showConflicts, setShowConflicts] = useState(false);
  const [conflicts, setConflicts] = useState<ReturnType<typeof findAllConflicts>>([]);
  const toggleConflicts = () => {
    setShowConflicts((v) => {
      const next = !v;
      if (next) setConflicts(findAllConflicts());
      return next;
    });
  };

  // ─── Prompt I-963 — Preset save/load ───────────────────────────────
  const [showPresets, setShowPresets] = useState(false);
  const [presets, setPresets] = useState<SettingsPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const togglePresets = () => {
    setShowPresets((v) => {
      const next = !v;
      if (next) setPresets(listPresets());
      return next;
    });
  };

  const open = phase === "settings";
  const activeLabel = TABS.find((t) => t.id === section)?.label ?? "Settings";
  const hasConflicts = conflicts.length > 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex flex-col bg-[#08090c]/95 backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
        >
          {/* Header (56px) */}
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.06] pl-4 pr-3 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-sm font-semibold tracking-tight text-white truncate">
                {activeLabel}
              </h1>
            </div>
            <div className="flex items-center gap-1.5">
              {/* Prompt I-961 — Settings search */}
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search settings…"
                  aria-label="Search settings"
                  className={`h-8 w-40 rounded-md border border-white/10 bg-white/[0.04] pl-8 pr-2 text-xs text-white/90 placeholder:text-white/30 outline-none transition-colors focus:border-white/30 focus:w-56 ${FOCUS_RING}`}
                />
              </div>
              {/* Prompt I-962 — Conflict resolver */}
              <button
                type="button"
                onClick={toggleConflicts}
                className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors ${
                  hasConflicts
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                    : "border-white/10 bg-white/[0.04] text-white/60 hover:bg-white/[0.08] hover:text-white"
                } ${FOCUS_RING}`}
                aria-label="Keybind conflicts"
                aria-expanded={showConflicts}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Conflicts</span>
                {hasConflicts && (
                  <span className="ml-0.5 rounded-full bg-rose-500/30 px-1.5 text-[10px] font-bold">
                    {conflicts.length}
                  </span>
                )}
              </button>
              {/* Prompt I-963 — Preset manager */}
              <div className="relative">
                <button
                  type="button"
                  onClick={togglePresets}
                  className={`flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-medium text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
                  aria-label="Settings presets"
                  aria-expanded={showPresets}
                >
                  <Save className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Presets</span>
                  <ChevronDown className="h-3 w-3" />
                </button>
                {showPresets && (
                  <div
                    className="absolute right-0 top-9 z-50 w-72 rounded-lg border border-white/10 bg-[#0c0e0a] p-3 shadow-2xl"
                    role="menu"
                  >
                    <div className="mb-2 flex items-center gap-1.5">
                      <input
                        type="text"
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        placeholder="New preset name…"
                        aria-label="Preset name"
                        maxLength={32}
                        className={`h-8 flex-1 rounded-md border border-white/10 bg-white/[0.04] px-2 text-xs text-white/90 placeholder:text-white/30 outline-none focus:border-white/30 ${FOCUS_RING}`}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!presetName.trim()) return;
                          // J-5000-retry — spread `visual` into a plain
                          // object so it's assignable to savePreset's
                          // `Record<string, unknown>` param (TS doesn't
                          // widen interfaces directly to Record types).
                          savePreset(presetName, settings.extended, { ...visual });
                          setPresets(listPresets());
                          setPresetName("");
                        }}
                        disabled={!presetName.trim()}
                        className={`flex h-8 items-center justify-center rounded-md bg-amber-500 px-2 text-xs font-bold text-black disabled:opacity-40 ${FOCUS_RING}`}
                        aria-label="Save preset"
                      >
                        <Save className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {presets.length === 0 ? (
                        <div className="px-2 py-6 text-center text-[11px] text-white/40">
                          No saved presets yet.
                        </div>
                      ) : (
                        presets.map((p) => (
                          <div
                            key={p.name}
                            className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/[0.04]"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-white/90">{p.name}</div>
                              <div className="text-[10px] text-white/40">
                                {new Date(p.at).toLocaleDateString()}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                const loaded = loadPreset(p.name);
                                if (!loaded) return;
                                setExtended(loaded.extended);
                                setVisual((prev) => ({ ...prev, ...(loaded.visual as Partial<VisualSettings>) }));
                                setShowPresets(false);
                              }}
                              className={`flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.06] text-white/70 transition-colors hover:bg-white/[0.12] hover:text-white ${FOCUS_RING}`}
                              aria-label={`Load preset ${p.name}`}
                              title="Load"
                            >
                              <Upload className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                deletePreset(p.name);
                                setPresets(listPresets());
                              }}
                              className={`flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.06] text-white/70 transition-colors hover:bg-rose-500/15 hover:text-rose-300 ${FOCUS_RING}`}
                              aria-label={`Delete preset ${p.name}`}
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPhase("menu")}
                className={`flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-white/60 transition-colors hover:bg-white/[0.12] hover:text-white ${FOCUS_RING}`}
                aria-label="Close settings"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          {/* Conflict resolver panel (Prompt I-962) */}
          {showConflicts && (
            <div className="border-b border-white/[0.06] bg-rose-500/[0.04] px-6 py-3">
              <div className="mx-auto max-w-2xl">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-rose-400" />
                    <span className="text-sm font-semibold text-white/90">
                      Keybind conflicts ({conflicts.length})
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const reset = resolveAllConflictsByReset();
                      setConflicts(findAllConflicts());
                      if (reset.length > 0) {
                        // Force re-render of the ControlsPanel bindings.
                        setSection((s) => s);
                      }
                    }}
                    disabled={conflicts.length === 0}
                    className={`rounded-md bg-rose-500/20 px-3 py-1.5 text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-500/30 disabled:opacity-40 ${FOCUS_RING}`}
                  >
                    Reset all to defaults
                  </button>
                </div>
                {conflicts.length === 0 ? (
                  <div className="text-[11px] text-white/50">
                    No conflicts detected. Every key is bound to at most one action.
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {conflicts.map((c) => (
                      <li
                        key={c.code}
                        className="flex items-center gap-2 text-[11px]"
                      >
                        <code className="rounded bg-rose-500/15 px-1.5 py-0.5 font-mono text-rose-300">
                          {c.display}
                        </code>
                        <span className="text-white/60">claimed by</span>
                        <span className="font-medium text-white/90">
                          {c.labels.join(", ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* Tabs bar */}
          <Tabs
            value={section}
            onValueChange={(v) => setSection(v as SectionId)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList
              aria-label="Settings sections"
              // Prompt J-4085 — mobile tab wrap. The TabsList uses a 3-col
              // grid on mobile (<sm) so 6 tabs wrap to 2 rows of 3, and a
              // 6-col grid on sm+ so all tabs fit on one row. The previous
              // code had a different layout that wrapped awkwardly on
              // narrow phones (single-column stack with horizontal scroll).
              // The 3-col-on-mobile grid spans the full panel width and
              // gives each tab equal room (no overflow).
              className="m-3 grid w-auto grid-cols-3 self-start bg-white/[0.04] sm:grid-cols-6"
            >
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = section === t.id;
                return (
                  <TabsTrigger
                    key={t.id}
                    value={t.id}
                    className={`gap-1.5 data-[state=active]:bg-white data-[state=active]:text-black data-[state=active]:shadow-sm ${
                      active ? "text-white" : "text-white/60"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="hidden text-xs sm:inline">{t.label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {/* Content (scrollable) */}
            <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-2xl px-8 py-6">
                {section === "video" && (
                  <VideoPanel visual={visual} setVisual={setVisual} />
                )}
                {section === "audio" && (
                  <AudioPanel visual={visual} setVisual={setVisual} />
                )}
                {section === "controls" && (
                  <ControlsPanel visual={visual} setVisual={setVisual} />
                )}
                {section === "accessibility" && (
                  <AccessibilityPanel visual={visual} setVisual={setVisual} />
                )}
                {section === "gameplay" && (
                  <GameplayPanel visual={visual} setVisual={setVisual} />
                )}
                {section === "social" && <SocialTab />}
              </div>
            </main>
          </Tabs>

          {/* Tabs content renders above. The SocialPanel overlay is mounted
              once at the bottom of this AnimatePresence tree — see below. */}
        </motion.div>
      )}
      {/* SEC10-UIUX (prompt 82): SocialPanel overlay — openable from the
          Social section OR from anywhere via openSocialPanel(). Mounted
          here so it's reachable without touching page.tsx. Rendered outside
          the `open` conditional so openSocialPanel() works from any screen —
          same behaviour as the pre-split file. Single instance, never
          remounted on settings toggle. */}
      <SocialPanel />
    </AnimatePresence>
  );
}
