"use client";

/**
 * SettingsPanel/VideoPanel.tsx — Video tab.
 *
 * Combines the three previously-separate Display / Graphics / Crosshair
 * sections from the original 1,643-line SettingsPanel.tsx (backlog §20 #468).
 * All settings, state wiring, and per-effect toggles are preserved exactly.
 */

import { useState } from "react";
import { Activity, AlertTriangle } from "lucide-react";
import { useGameStore } from "@/lib/game/store";
import { getUnavailablePillars } from "@/lib/game/FeatureFlags";
import {
  SUPPORTED_LOCALES,
  LOCALE_LABELS,
  setLocale,
  getLocale,
  t,
  type Locale,
} from "@/lib/game/uiux/i18n";
import {
  runBenchmark,
  getPerEffectToggles,
  setPerEffectToggles,
  resetPerEffectToggles,
  getTierDefaults,
  getCachedBenchmark,
  PER_EFFECT_INFO,
  type PerEffectToggles,
  type BenchmarkResult,
} from "@/lib/game/uiux/graphics-benchmark";
import type { QualityTier } from "@/lib/game/systems/FrameBudgetProfiler";
import {
  type PanelProps,
  type Quality,
  type ShadowQuality,
  SectionHeader,
  Row,
  ValuePill,
  Segmented,
  ThemedSlider,
  ThemedSwitch,
  FOCUS_RING,
  CROSSHAIR_STYLES,
  CROSSHAIR_COLORS,
  CrosshairPreview,
  StyleGlyph,
} from "./_shared";

// ─── Display sub-section ────────────────────────────────────────────────────

function DisplaySubSection({ visual, setVisual }: PanelProps) {
  const settings = useGameStore((s) => s.settings);
  const setSettings = useGameStore((s) => s.setSettings);
  // SEC10-UIUX (prompt 78): localization state — mirrors the i18n module.
  const [locale, setLocaleState] = useState<Locale>(getLocale());
  // Task 3 / item 58 — PerfOverlay toggle. Reads + writes the same
  // `pr_perf_overlay` localStorage flag that PerfOverlay.tsx reads on mount.
  // The overlay also activates via `?perf=1` URL param — the toggle is a
  // friendlier UI affordance for the same flag.
  const [perfOverlay, setPerfOverlay] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("pr_perf_overlay") === "1";
  });
  const togglePerfOverlay = (on: boolean) => {
    setPerfOverlay(on);
    if (typeof window === "undefined") return;
    if (on) localStorage.setItem("pr_perf_overlay", "1");
    else localStorage.removeItem("pr_perf_overlay");
  };
  const changeLocale = (l: Locale) => {
    setLocale(l);
    setLocaleState(l);
  };
  return (
    <div>
      <SectionHeader
        title="Display"
        description="Field of view, HUD scale, language, and on-screen indicators."
      />
      {/* Prompt J-4069 — Feature pillar gating UI. When the browser /
          hardware can't support a feature pillar (e.g. no gamepad API →
          haptics unavailable, no service worker → offline PWA unavailable),
          surface a banner listing the unavailable pillars so the player
          knows why some settings are greyed out. The matching setting rows
          below become disabled when their pillar is unavailable. */}
      {(() => {
        const unavailable = typeof window === "undefined" ? [] : getUnavailablePillars();
        if (unavailable.length === 0) return null;
        return (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <div className="text-[11px] text-amber-200/80">
              <div className="font-semibold">Some features unavailable on this device</div>
              <div className="mt-0.5 text-amber-200/60">
                {unavailable.join(", ")} — affected settings are greyed out.
              </div>
            </div>
          </div>
        );
      })()}
      <div>
        <Row label="Field of View">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[settings.fov]}
              min={60}
              max={110}
              step={1}
              onValueChange={(v) => setSettings({ fov: v[0] })}
              aria-label="Field of view"
            />
            <ValuePill>{settings.fov}°</ValuePill>
          </div>
        </Row>
        <Row label="HUD Scale">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[visual.hudScale]}
              min={0.75}
              max={1.5}
              step={0.05}
              onValueChange={(v) =>
                setVisual((p) => ({ ...p, hudScale: v[0] }))
              }
              aria-label="HUD scale"
            />
            <ValuePill>{visual.hudScale.toFixed(2)}×</ValuePill>
          </div>
        </Row>
        <Row
          label="Language"
          hint="SEC10-UIUX: localize menu strings (English / Spanish / French)."
        >
          {/* Prompt J-4064 / J-4013 — the section label itself is wired
              through t() so the Language row's own label localizes when
              the player picks a non-English locale. This is the seed
              call; the rest of the panel's strings are cataloged in
              i18n.ts MESSAGE_CATALOG but not yet swapped to t() (the
              surgical constraint keeps the panel diffs minimal). */}
          <div className="sr-only" data-testid="language-section-label">
            {t("settings.language.label")}
          </div>
          <div className="inline-flex rounded-lg bg-white/[0.06] p-0.5">
            {SUPPORTED_LOCALES.map((l) => {
              const active = locale === l;
              return (
                <button
                  key={l}
                  type="button"
                  onClick={() => changeLocale(l)}
                  aria-pressed={active}
                  className={`min-h-[36px] rounded-[6px] px-3 text-xs font-medium transition-colors ${FOCUS_RING} ${
                    active
                      ? "bg-gradient-to-r from-amber-500 to-amber-600 text-black shadow-[0_0_16px_rgba(255,140,26,0.35)]"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  <span className="mr-1.5">{LOCALE_LABELS[l].flag}</span>
                  {LOCALE_LABELS[l].label}
                </button>
              );
            })}
          </div>
        </Row>
        <Row label="Show FPS Counter">
          <ThemedSwitch
            checked={settings.showFps}
            onCheckedChange={(c) => setSettings({ showFps: c })}
            aria-label="Show FPS counter"
          />
        </Row>
        <Row label="Dynamic Shadows">
          <ThemedSwitch
            checked={settings.shadows}
            onCheckedChange={(c) => setSettings({ shadows: c })}
            aria-label="Dynamic shadows"
          />
        </Row>
        {/* Task 3 / item 58 — perf overlay toggle. Surfaces the existing
            PerfOverlay.tsx (?perf=1 / localStorage flag) as a player-facing
            settings row so users troubleshooting their own performance can
            toggle the dev HUD without knowing the URL trick. */}
        <Row
          label="Performance Overlay"
          hint="Task 3 / item 58 — show a dev HUD with FPS, per-system timing, a 20-min memory sparkline, and GPU renderer info. Visible only when this is on (or when ?perf=1 is in the URL)."
          last
        >
          <ThemedSwitch
            checked={perfOverlay}
            onCheckedChange={(c) => togglePerfOverlay(c)}
            aria-label="Performance overlay"
          />
        </Row>
      </div>
    </div>
  );
}

// ─── Graphics sub-section ───────────────────────────────────────────────────

function GraphicsSubSection({ visual, setVisual }: PanelProps) {
  const settings = useGameStore((s) => s.settings);
  const setSettings = useGameStore((s) => s.setSettings);
  const setExtended = useGameStore((s) => s.setExtended);
  // Map shadow quality (Off/Low/High) onto the boolean settings.shadows.
  const shadowQuality: ShadowQuality = settings.shadows ? "high" : "off";
  // Task 3 / item 65 — "Reduced effects" preset toggle.
  const reducedEffects = settings.extended.reducedEffects;

  // SEC10-UIUX (prompt 81): per-effect toggles + graphics benchmark.
  const [toggles, setToggles] = useState<PerEffectToggles>(() => getPerEffectToggles());
  const [benchmark, setBenchmark] = useState<BenchmarkResult | null>(() => getCachedBenchmark());
  const [benchmarking, setBenchmarking] = useState(false);

  const updateToggle = (key: keyof PerEffectToggles, value: boolean | string | number) => {
    const next = { ...toggles, [key]: value };
    setToggles(next);
    setPerEffectToggles({ [key]: value } as Partial<PerEffectToggles>);
  };

  const runBench = async () => {
    setBenchmarking(true);
    try {
      const result = await runBenchmark();
      setBenchmark(result);
      setToggles(result.recommendedToggles);
    } finally {
      setBenchmarking(false);
    }
  };

  const applyTierDefaults = (tier: QualityTier) => {
    const defaults = getTierDefaults(tier);
    setToggles(defaults);
    setPerEffectToggles(defaults);
  };

  const resetToggles = () => {
    resetPerEffectToggles();
    setToggles(getPerEffectToggles());
  };

  return (
    <div className="mt-10">
      <SectionHeader
        title="Graphics"
        description="Rendering quality, per-effect toggles, and auto-detect benchmark."
      />

      {/* SEC10-UIUX (prompt 81): graphics benchmark + auto-detect */}
      <div className="mb-5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
            <Activity className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-white/90">Graphics Benchmark</h3>
            <p className="text-xs text-white/40">
              {benchmark
                ? `Recommended tier: ${benchmark.recommendedTier.toUpperCase()} • ${benchmark.live ? "Live test" : "Hardware estimate"} • ${Math.round(benchmark.durationMs)}ms`
                : "Run a 5-second stress test to auto-detect the best settings for your hardware."}
            </p>
          </div>
          <button
            type="button"
            onClick={runBench}
            disabled={benchmarking}
            className={`rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-4 py-2 text-xs font-semibold text-black shadow-[0_0_16px_rgba(255,140,26,0.3)] transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-50 ${FOCUS_RING}`}
          >
            {benchmarking ? "Running…" : "Run Benchmark"}
          </button>
        </div>
        {benchmark?.live && (
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            {(["ultra", "high", "medium", "low"] as QualityTier[]).map((tier) => (
              <div key={tier} className="rounded-lg border border-white/[0.06] bg-white/[0.02] py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-white/40">{tier}</div>
                <div className={`text-sm font-bold tabular-nums ${
                  tier === benchmark.recommendedTier ? "text-amber-400" : "text-white/60"
                }`}>
                  {benchmark.measured[tier] !== null ? `${benchmark.measured[tier]} fps` : "—"}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(["ultra", "high", "medium", "low"] as QualityTier[]).map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => applyTierDefaults(tier)}
              className={`rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
            >
              Apply {tier}
            </button>
          ))}
          <button
            type="button"
            onClick={resetToggles}
            className={`rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
          >
            Reset
          </button>
        </div>
      </div>

      <div>
        <Row label="Quality">
          <Segmented<Quality>
            value={settings.quality}
            onChange={(v) => setSettings({ quality: v })}
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
        </Row>
        <Row label="Texture Quality">
          <Segmented<Quality>
            value={visual.textureQuality}
            onChange={(v) => setVisual((p) => ({ ...p, textureQuality: v }))}
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
        </Row>
        <Row label="Shadow Quality">
          <Segmented<ShadowQuality>
            value={shadowQuality}
            onChange={(v) => setSettings({ shadows: v !== "off" })}
            options={[
              { value: "off", label: "Off" },
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ]}
          />
        </Row>
        <Row label="Anti-aliasing">
          <ThemedSwitch
            checked={visual.aa}
            onCheckedChange={(c) => setVisual((p) => ({ ...p, aa: c }))}
            aria-label="Anti-aliasing"
          />
        </Row>
        {/* Task 3 / item 65 — "Reduced effects" preset. When on, ClothSim,
            RagdollSystem, and VoronoiFracture no-op their per-frame simulation
            (meshes still render at rest pose). The hardware benchmark can
            auto-enable this on integrated GPUs; the user can override here. */}
        <Row
          label="Reduced Effects"
          hint="Task 3 / item 65 — disable cloth simulation, ragdoll physics, and destructible fracture. Recommended for low-end devices / integrated GPUs. Meshes still render — they just don't simulate."
          last
        >
          <ThemedSwitch
            checked={reducedEffects}
            onCheckedChange={(c) => setExtended({ reducedEffects: c })}
            aria-label="Reduced effects preset"
          />
        </Row>

        {/* SEC10-UIUX (prompt 81): granular per-effect toggles */}
        <div className="mt-6 mb-2 px-1">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/30">
            Per-effect Toggles
          </h3>
          <p className="mt-0.5 text-[11px] text-white/30">
            Fine-tune individual rendering effects independent of the global quality tier.
          </p>
        </div>
        <Row label={PER_EFFECT_INFO.shadows.label} hint={PER_EFFECT_INFO.shadows.description}>
          <ThemedSwitch
            checked={toggles.shadows}
            onCheckedChange={(c) => updateToggle("shadows", c)}
            aria-label="Shadows toggle"
          />
        </Row>
        <Row label={PER_EFFECT_INFO.ssao.label} hint={PER_EFFECT_INFO.ssao.description}>
          <ThemedSwitch
            checked={toggles.ssao}
            onCheckedChange={(c) => updateToggle("ssao", c)}
            aria-label="SSAO toggle"
          />
        </Row>
        <Row label={PER_EFFECT_INFO.particles.label} hint={PER_EFFECT_INFO.particles.description}>
          <ThemedSwitch
            checked={toggles.particles}
            onCheckedChange={(c) => updateToggle("particles", c)}
            aria-label="Particles toggle"
          />
        </Row>
        <Row label={PER_EFFECT_INFO.bloom.label} hint={PER_EFFECT_INFO.bloom.description}>
          <ThemedSwitch
            checked={toggles.bloom}
            onCheckedChange={(c) => updateToggle("bloom", c)}
            aria-label="Bloom toggle"
          />
        </Row>
        <Row label={PER_EFFECT_INFO.motionBlur.label} hint={PER_EFFECT_INFO.motionBlur.description}>
          <ThemedSwitch
            checked={toggles.motionBlur}
            onCheckedChange={(c) => updateToggle("motionBlur", c)}
            aria-label="Motion blur toggle"
          />
        </Row>
        <Row label={PER_EFFECT_INFO.volumetricFog.label} hint={PER_EFFECT_INFO.volumetricFog.description} last>
          <ThemedSwitch
            checked={toggles.volumetricFog}
            onCheckedChange={(c) => updateToggle("volumetricFog", c)}
            aria-label="Volumetric fog toggle"
          />
        </Row>
      </div>
    </div>
  );
}

// ─── Crosshair sub-section ──────────────────────────────────────────────────

function CrosshairSubSection() {
  const cfg = useGameStore((s) => s.settings.crosshair);
  const setCrosshair = useGameStore((s) => s.setCrosshair);
  const [hexInput, setHexInput] = useState(cfg.color);

  // Sync the hex input when the color changes externally (e.g. via a swatch).
  // Using the React "adjusting state during render" pattern avoids a cascading
  // setState-in-effect render loop.
  const [lastColor, setLastColor] = useState(cfg.color);
  if (cfg.color !== lastColor) {
    setLastColor(cfg.color);
    setHexInput(cfg.color);
  }

  const commitHex = () => {
    const trimmed = hexInput.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
      setCrosshair({ color: trimmed.toLowerCase() });
    } else {
      setHexInput(cfg.color);
    }
  };

  return (
    <div className="mt-10">
      <SectionHeader
        title="Crosshair"
        description="Customize your reticle. The preview updates live."
      />

      {/* Live preview */}
      <div className="mb-6 flex flex-col items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] py-5">
        <CrosshairPreview cfg={cfg} />
        <span className="text-[11px] uppercase tracking-wider text-white/30">
          Live preview
        </span>
      </div>

      <div>
        <Row label="Style">
          <div className="flex gap-1.5">
            {CROSSHAIR_STYLES.map((st) => {
              const active = cfg.style === st;
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() => setCrosshair({ style: st })}
                  aria-label={`Crosshair style: ${st}`}
                  aria-pressed={active}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${FOCUS_RING} ${
                    active
                      ? "border-white/40 bg-white/15"
                      : "border-white/10 bg-white/[0.04] hover:bg-white/[0.08]"
                  }`}
                >
                  <StyleGlyph style={st} active={active} />
                </button>
              );
            })}
          </div>
        </Row>

        <Row label="Color">
          <div className="flex items-center gap-2">
            {CROSSHAIR_COLORS.map((c) => {
              const active = cfg.color.toLowerCase() === c.toLowerCase();
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCrosshair({ color: c })}
                  aria-label={`Crosshair color: ${c}`}
                  aria-pressed={active}
                  className={`h-6 w-6 rounded-full border-2 transition-transform ${FOCUS_RING} ${
                    active
                      ? "scale-110 border-white"
                      : "border-white/20 hover:scale-105"
                  }`}
                  style={{ backgroundColor: c }}
                />
              );
            })}
            <input
              type="text"
              value={hexInput}
              onChange={(e) => setHexInput(e.target.value)}
              onBlur={commitHex}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitHex();
              }}
              spellCheck={false}
              maxLength={7}
              aria-label="Crosshair color hex"
              className={`ml-1 h-8 w-24 rounded-md border border-white/10 bg-white/[0.04] px-2 font-mono text-xs text-white/80 outline-none transition-colors focus:border-white/30 ${FOCUS_RING}`}
            />
          </div>
        </Row>

        <Row label="Show Center Dot">
          <ThemedSwitch
            checked={cfg.showDot}
            onCheckedChange={(c) => setCrosshair({ showDot: c })}
            aria-label="Show center dot"
          />
        </Row>

        <Row label="Length">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[cfg.length]}
              min={2}
              max={20}
              step={1}
              onValueChange={(v) => setCrosshair({ length: v[0] })}
              aria-label="Crosshair length"
            />
            <ValuePill>{cfg.length}px</ValuePill>
          </div>
        </Row>

        <Row label="Thickness">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[cfg.thickness]}
              min={1}
              max={4}
              step={1}
              onValueChange={(v) => setCrosshair({ thickness: v[0] })}
              aria-label="Crosshair thickness"
            />
            <ValuePill>{cfg.thickness}px</ValuePill>
          </div>
        </Row>

        <Row label="Gap">
          <div className="flex items-center gap-3">
            <ThemedSlider
              value={[cfg.gap]}
              min={0}
              max={20}
              step={1}
              onValueChange={(v) => setCrosshair({ gap: v[0] })}
              aria-label="Crosshair gap"
            />
            <ValuePill>{cfg.gap}px</ValuePill>
          </div>
        </Row>

        <Row label="Outline">
          <ThemedSwitch
            checked={cfg.outline}
            onCheckedChange={(c) => setCrosshair({ outline: c })}
            aria-label="Crosshair outline"
          />
        </Row>

        <Row label="Dynamic Spread" last>
          <ThemedSwitch
            checked={cfg.dynamicSpread}
            onCheckedChange={(c) => setCrosshair({ dynamicSpread: c })}
            aria-label="Dynamic spread"
          />
        </Row>
      </div>
    </div>
  );
}

// ─── Public panel ───────────────────────────────────────────────────────────

export function VideoPanel(props: PanelProps) {
  return (
    <div>
      <DisplaySubSection {...props} />
      <GraphicsSubSection {...props} />
      <CrosshairSubSection />
    </div>
  );
}
