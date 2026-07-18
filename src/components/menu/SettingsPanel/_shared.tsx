"use client";

/**
 * SettingsPanel/_shared.tsx — shared primitives + types for every settings
 * sub-panel. Extracted from the original 1,643-line `SettingsPanel.tsx`
 * (backlog §20 item 468) so each sub-panel can be authored, reviewed, and
 * lint-checked independently.
 *
 * Everything here is presentation-only — no game-store reads. Sub-panels
 * read the store themselves; the shell lifts the cross-section VisualSettings
 * state and passes it down so panel switches don't reset UI-only toggles.
 */

import { type Dispatch, type SetStateAction } from "react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import type { CrosshairSettings } from "@/lib/game/store";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SectionId =
  | "video"
  | "audio"
  | "controls"
  | "gameplay"
  | "accessibility"
  | "social";

export type Quality = "low" | "medium" | "high";
export type ShadowQuality = "off" | "low" | "high";

/**
 * Visual-only settings: toggles/sliders that exist in the UI but don't map
 * to the gameplay store. Lifted to the panel root so they survive tab
 * switches (radix Tabs unmounts inactive content by default).
 */
export interface VisualSettings {
  hudScale: number;
  textureQuality: Quality;
  aa: boolean;
  muteOnFocusLoss: boolean;
  invertY: boolean;
  subtitles: boolean;
  reducedMotion: boolean;
  hudOpacity: number;
  autoReload: boolean;
  autoTarget: boolean;
  confirmedKills: boolean;
}

export const DEFAULT_VISUAL: VisualSettings = {
  hudScale: 1.0,
  textureQuality: "high",
  aa: true,
  muteOnFocusLoss: true,
  invertY: false,
  subtitles: true,
  reducedMotion: false,
  hudOpacity: 1.0,
  autoReload: true,
  autoTarget: false,
  confirmedKills: true,
};

// ─── Constants ──────────────────────────────────────────────────────────────

export const CROSSHAIR_STYLES: CrosshairSettings["style"][] = [
  "cross",
  "circle",
  "dot",
  "cross+dot",
  "T",
];

export const CROSSHAIR_COLORS = [
  "#00ff88",
  "#ffffff",
  "#ff4444",
  "#ffaa00",
  "#00aaff",
  "#ff00ff",
  "#88ff00",
  "#00ffff",
];

/** Shared focus-ring recipe — 2px ring at 50% opacity, 4px offset. */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]";

// ─── Reusable primitives ────────────────────────────────────────────────────

export function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-3 px-1">
      <h2 className="text-lg font-semibold tracking-tight text-white">
        {title}
      </h2>
      <p className="text-xs text-white/40">{description}</p>
    </div>
  );
}

/**
 * Row — 56px tall setting row. Label left, control right, hairline divider
 * below (except the last row).
 *
 * Prompt I-961 — `data-search` attribute carries the lowercased label so
 * the SettingsPanel shell can filter rows by search query without each
 * sub-panel having to plumb a `query` prop through its tree. The shell
 * queries `[data-search]` and toggles `hidden` based on a substring match.
 */
export function Row({
  label,
  hint,
  children,
  last = false,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      data-search={label.toLowerCase()}
      className={`flex h-14 items-center gap-4 px-1 ${
        last ? "" : "border-b border-white/[0.04]"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white/80">{label}</div>
        {hint && <div className="text-xs text-white/40">{hint}</div>}
      </div>
      <div className="flex min-h-[44px] shrink-0 items-center">{children}</div>
    </div>
  );
}

export function ValuePill({ children }: { children: React.ReactNode }) {
  return (
    <span className="min-w-[56px] text-right font-mono text-xs font-semibold tabular-nums text-white/60">
      {children}
    </span>
  );
}

/** Segmented control — used for multi-option pickers (Quality, ADS mode…). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-white/[0.06] p-0.5">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={`min-h-[36px] rounded-[6px] px-4 text-xs font-medium transition-colors ${FOCUS_RING} ${
              active
                ? "bg-gradient-to-r from-amber-500 to-amber-600 text-black shadow-[0_0_16px_rgba(255,140,26,0.35)]"
                : "text-white/60 hover:text-white"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Slider themed to pure white (overrides shadcn primary to avoid any blue). */
export function ThemedSlider(props: React.ComponentProps<typeof Slider>) {
  return (
    <Slider
      {...props}
      className={`w-44 shrink-0 [&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:bg-white/15 [&_[data-slot=slider-range]]:bg-white [&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-thumb]]:border-white/40 [&_[data-slot=slider-thumb]]:bg-white [&_[data-slot=slider-thumb]]:shadow-sm ${props.className ?? ""}`}
    />
  );
}

/** Switch themed to pure white when checked. */
export function ThemedSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      className={`data-[state=checked]:bg-white data-[state=unchecked]:bg-white/15 ${props.className ?? ""}`}
    />
  );
}

export function KeyChip({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded-md border border-white/10 bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] font-medium text-white/80">
      {children}
    </kbd>
  );
}

// ─── Crosshair live preview ─────────────────────────────────────────────────

/**
 * Renders the crosshair inside a 200×100 dark box using the same logic as
 * the in-game Crosshair component (simplified — no spread/hit-marker).
 * Updates in real-time as the store settings change.
 */
export function CrosshairPreview({ cfg }: { cfg: CrosshairSettings }) {
  const stroke = cfg.color;
  const outline = cfg.outline
    ? "0 0 2px rgba(0,0,0,0.9), 0 0 1px rgba(0,0,0,0.9)"
    : "none";
  const len = cfg.length;
  const thick = cfg.thickness;
  const gap = cfg.gap;

  const showCenterDot =
    cfg.showDot || cfg.style === "dot" || cfg.style === "cross+dot";
  const showCircle = cfg.style === "circle";
  const showCross =
    cfg.style === "cross" || cfg.style === "cross+dot" || cfg.style === "T";
  const isT = cfg.style === "T";

  return (
    <div className="relative flex h-[100px] w-[200px] items-center justify-center overflow-hidden rounded-lg border border-white/[0.06] bg-black">
      {/* reference grid */}
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      />

      {showCircle && (
        <svg
          className="absolute"
          width={gap * 2 + 8}
          height={gap * 2 + 8}
          viewBox={`0 0 ${gap * 2 + 8} ${gap * 2 + 8}`}
          style={{
            overflow: "visible",
            filter: cfg.outline
              ? "drop-shadow(0 0 1px rgba(0,0,0,0.9))"
              : "none",
          }}
        >
          <circle
            cx={gap + 4}
            cy={gap + 4}
            r={gap + 2}
            stroke={stroke}
            strokeWidth={thick}
            fill="none"
          />
        </svg>
      )}

      {showCross && (
        <>
          {/* top */}
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: thick,
              height: len,
              background: stroke,
              boxShadow: outline,
              transform: `translate(-50%, calc(-100% - ${gap}px))`,
            }}
          />
          {/* bottom (hidden for T) */}
          {!isT && (
            <div
              className="absolute left-1/2 top-1/2"
              style={{
                width: thick,
                height: len,
                background: stroke,
                boxShadow: outline,
                transform: `translate(-50%, ${gap}px)`,
              }}
            />
          )}
          {/* left */}
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: len,
              height: thick,
              background: stroke,
              boxShadow: outline,
              transform: `translate(calc(-100% - ${gap}px), -50%)`,
            }}
          />
          {/* right */}
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: len,
              height: thick,
              background: stroke,
              boxShadow: outline,
              transform: `translate(${gap}px, -50%)`,
            }}
          />
        </>
      )}

      {showCenterDot && (
        <div
          className="absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: Math.max(2, thick),
            height: Math.max(2, thick),
            background: stroke,
            boxShadow: outline,
          }}
        />
      )}
    </div>
  );
}

/** Mini 16×16 icon representing each crosshair style. */
export function StyleGlyph({
  style,
  active,
}: {
  style: CrosshairSettings["style"];
  active: boolean;
}) {
  const c = active ? "#0a0b0e" : "rgba(255,255,255,0.7)";
  switch (style) {
    case "cross":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16">
          <rect x="7" y="2" width="2" height="12" fill={c} />
          <rect x="2" y="7" width="12" height="2" fill={c} />
        </svg>
      );
    case "circle":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16">
          <circle
            cx="8"
            cy="8"
            r="5"
            stroke={c}
            strokeWidth="2"
            fill="none"
          />
        </svg>
      );
    case "dot":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="2.5" fill={c} />
        </svg>
      );
    case "cross+dot":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16">
          <rect x="7" y="2" width="2" height="3" fill={c} />
          <rect x="7" y="11" width="2" height="3" fill={c} />
          <rect x="2" y="7" width="3" height="2" fill={c} />
          <rect x="11" y="7" width="3" height="2" fill={c} />
          <circle cx="8" cy="8" r="1.5" fill={c} />
        </svg>
      );
    case "T":
      return (
        <svg width="16" height="16" viewBox="0 0 16 16">
          <rect x="7" y="2" width="2" height="5" fill={c} />
          <rect x="2" y="7" width="12" height="2" fill={c} />
        </svg>
      );
  }
}

// ─── Sub-panel prop bundle ──────────────────────────────────────────────────

/**
 * Common props every sub-panel receives from the tabbed shell. Keeping the
 * visual-settings state lifted prevents radix Tabs (which unmounts inactive
 * content) from resetting UI-only toggles on tab switch.
 */
export interface PanelProps {
  visual: VisualSettings;
  setVisual: Dispatch<SetStateAction<VisualSettings>>;
}
