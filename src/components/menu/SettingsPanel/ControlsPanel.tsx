"use client";

/**
 * SettingsPanel/ControlsPanel.tsx — Controls tab.
 * Extracted verbatim (incl. the RemappableKeybindings grid) from the
 * original SettingsPanel.tsx (backlog §20 #468).
 */

import { useState, useEffect } from "react";
import { Gamepad2 } from "lucide-react";
import { useGameStore } from "@/lib/game/store";
import {
  DEFAULT_BINDINGS,
  resolveBinding,
  remapKey,
  resetActionBinding,
  formatKeyCode,
  type BindingSlot,
} from "@/lib/game/Keybindings";
import { isGamepadConnected, isSteamInputActive } from "@/lib/game/uiux/gamepad";
import { getControllerLayout, type ControllerLayout } from "@/lib/game/uiux/controller-layouts";
import {
  type PanelProps,
  SectionHeader,
  Row,
  ValuePill,
  Segmented,
  ThemedSlider,
  ThemedSwitch,
  FOCUS_RING,
} from "./_shared";

export function ControlsPanel({ visual, setVisual }: PanelProps) {
  const settings = useGameStore((s) => s.settings);
  const setSettings = useGameStore((s) => s.setSettings);
  const setExtended = useGameStore((s) => s.setExtended);

  return (
    <div>
      <SectionHeader
        title="Controls"
        description="Mouse sensitivity, aim behavior, and key bindings."
      />
      <div>
        <Row label="Mouse Sensitivity">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.sensitivity]}
              min={0.1}
              max={3}
              step={0.05}
              onValueChange={(v) => setSettings({ sensitivity: v[0] })}
              aria-label="Mouse sensitivity"
            />
            <ValuePill>{settings.sensitivity.toFixed(2)}</ValuePill>
          </div>
        </Row>
        <Row label="ADS Sensitivity">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.extended.aimSensitivity]}
              min={0.2}
              max={1}
              step={0.05}
              onValueChange={(v) => setExtended({ aimSensitivity: v[0] })}
              aria-label="ADS sensitivity"
            />
            <ValuePill>
              {settings.extended.aimSensitivity.toFixed(2)}
            </ValuePill>
          </div>
        </Row>
        <Row label="ADS Mode">
          <Segmented<"hold" | "toggle">
            value={settings.extended.adsMode}
            onChange={(v) => setExtended({ adsMode: v })}
            options={[
              { value: "hold", label: "Hold" },
              { value: "toggle", label: "Toggle" },
            ]}
          />
        </Row>
        <Row label="ADS Speed">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.extended.adsSpeed]}
              min={8}
              max={20}
              step={1}
              onValueChange={(v) => setExtended({ adsSpeed: v[0] })}
              aria-label="ADS speed"
            />
            <ValuePill>{settings.extended.adsSpeed}</ValuePill>
          </div>
        </Row>
        <Row label="Invert Y Axis">
          <ThemedSwitch
            checked={visual.invertY}
            onCheckedChange={(c) => setVisual((p) => ({ ...p, invertY: c }))}
            aria-label="Invert Y axis"
          />
        </Row>
      </div>

      {/* Keybindings — remappable (SEC10-UIUX prompt 77) */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between px-1">
          <h3 className="text-sm font-semibold text-white/90">Keybindings</h3>
          <span className="text-[11px] uppercase tracking-wider text-white/30">
            Click a key to rebind
          </span>
        </div>
        <RemappableKeybindings />
      </div>

      {/* Prompt J-4016 / J-4093 — Controller rebinding UI. Shows the
          detected controller's button layout + Steam Input status. The
          actual rebinding happens via the platform's controller settings
          (Steam Input / OS gamepad settings) — the W3C Gamepad API
          doesn't expose a write-side remap. We surface the read-side
          layout so the player can verify their controller is recognized. */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between px-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white/90">
            <Gamepad2 className="h-3.5 w-3.5 text-amber-400" />
            Controller
          </h3>
          <span className="text-[11px] uppercase tracking-wider text-white/30">
            {isGamepadConnected() ? "Connected" : "Not detected"}
          </span>
        </div>
        <ControllerSection />
      </div>
    </div>
  );
}

/** Prompt J-4016 — controller rebinding UI (read-side layout display). */
function ControllerSection() {
  const [layout, setLayout] = useState<ControllerLayout | null>(null);
  const [steamInput, setSteamInput] = useState(false);
  useEffect(() => {
    setLayout(getControllerLayout());
    setSteamInput(isSteamInputActive());
  }, []);
  if (!layout) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 text-[11px] text-white/40">
        No controller detected. Connect a controller to view its layout.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
          {layout.platform} layout
        </span>
        {steamInput && (
          <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-sky-300">
            Steam Input active
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        {layout.bindings.map((b) => {
          // J-5000-retry — ControllerBinding has no `button` field. The
          // left column shows a title-cased action name (e.g. "Fire"),
          // the right column shows the platform button glyph from
          // `b.label` (e.g. "RT" / "R2" / "ZR"). The prior code's
          // `b.button` was a phantom field.
          const actionLabel = b.action
            .replace(/([A-Z])/g, " $1")
            .replace(/^./, (c) => c.toUpperCase())
            .trim();
          return (
            <div key={b.action} className="flex items-center justify-between text-[11px]">
              <span className="text-white/60">{actionLabel}</span>
              <span className="font-mono text-white/85">{b.label}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 text-[10px] text-white/30">
        {steamInput
          ? "Steam Input is remapping your controller — rebinding is available in the Steam overlay."
          : "Rebinding is available in your OS controller settings (Steam Input, Windows Game Controllers, etc.)."}
      </div>
    </div>
  );
}

/**
 * SEC10-UIUX (prompt 77): Remappable keybinding grid. Reads the
 * DEFAULT_BINDINGS catalog from Keybindings.ts + the player's custom
 * overrides from localStorage. Click a binding chip → press any key
 * to rebind. Conflicts are detected + rejected with a toast.
 */
function RemappableKeybindings() {
  // Bump a counter to force re-render after each remap (the bindings
  // are read from localStorage, which is not reactive).
  const [, setVersion] = useState(0);
  const [rebinding, setRebinding] = useState<{ action: string; slot: BindingSlot } | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    if (!rebinding) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Cancel on Esc.
      if (e.code === "Escape") {
        setRebinding(null);
        return;
      }
      const result = remapKey(rebinding.action, e.code, rebinding.slot);
      if (result.ok) {
        setToast({ kind: "ok", text: `Rebound "${rebinding.action}" → ${formatKeyCode(e.code)}` });
      } else {
        setToast({ kind: "err", text: result.reason ?? "Conflict" });
      }
      setRebinding(null);
      refresh();
      // Auto-clear the toast after 2s.
      setTimeout(() => setToast(null), 2000);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as EventListenerOptions);
  }, [rebinding]);

  // Group bindings by category for display.
  const categories: { id: string; label: string }[] = [
    { id: "movement", label: "Movement" },
    { id: "combat", label: "Combat" },
    { id: "weapons", label: "Weapons" },
    { id: "medical", label: "Medical" },
    { id: "social", label: "Social" },
    { id: "system", label: "System" },
  ];

  return (
    <div>
      {toast && (
        <div className={`mb-2 rounded-md px-3 py-1.5 text-[11px] font-medium ${
          toast.kind === "ok"
            ? "bg-emerald-500/10 text-emerald-300"
            : "bg-rose-500/10 text-rose-300"
        }`}>
          {toast.text}
        </div>
      )}
      {categories.map((cat) => {
        const bindings = DEFAULT_BINDINGS.filter((b) => b.category === cat.id);
        if (bindings.length === 0) return null;
        return (
          <div key={cat.id} className="mb-4">
            <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-white/30">
              {cat.label}
            </div>
            <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              {bindings.map((b) => {
                const [primary, secondary] = resolveBinding(b.action);
                return (
                  <div
                    key={b.action}
                    className="flex h-12 items-center justify-between gap-3 border-b border-white/[0.04] px-1"
                  >
                    <span className="text-sm text-white/70">{b.label}</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setRebinding({ action: b.action, slot: "primary" })}
                        className={`rounded-md border px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                          rebinding?.action === b.action && rebinding?.slot === "primary"
                            ? "border-amber-500/60 bg-amber-500/15 text-amber-300 animate-pulse"
                            : "border-white/10 bg-white/[0.06] text-white/80 hover:bg-white/[0.1]"
                        } ${FOCUS_RING}`}
                        aria-label={`Rebind ${b.label} primary key`}
                      >
                        {rebinding?.action === b.action && rebinding?.slot === "primary"
                          ? "Press…"
                          : formatKeyCode(primary)}
                      </button>
                      {secondary !== null && (
                        <button
                          type="button"
                          onClick={() => setRebinding({ action: b.action, slot: "secondary" })}
                          className={`rounded-md border px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                            rebinding?.action === b.action && rebinding?.slot === "secondary"
                              ? "border-amber-500/60 bg-amber-500/15 text-amber-300 animate-pulse"
                              : "border-white/10 bg-white/[0.06] text-white/80 hover:bg-white/[0.1]"
                          } ${FOCUS_RING}`}
                          aria-label={`Rebind ${b.label} secondary key`}
                        >
                          {rebinding?.action === b.action && rebinding?.slot === "secondary"
                            ? "Press…"
                            : formatKeyCode(secondary)}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          resetActionBinding(b.action);
                          refresh();
                          setToast({ kind: "ok", text: `Reset "${b.label}" to default` });
                          setTimeout(() => setToast(null), 1500);
                        }}
                        className={`rounded-md px-1.5 py-1 text-[10px] text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/70 ${FOCUS_RING}`}
                        aria-label={`Reset ${b.label} to default`}
                      >
                        ↺
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Provenance note (backlog §20 #485): the gamepad aim-assist strength slider
// lives in AccessibilityPanel — preserving the original SettingsPanel layout.
// The underlying gamepad helpers are imported there, not here.

