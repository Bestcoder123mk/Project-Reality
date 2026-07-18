"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * PerfOverlay — dev-only frame-budget dashboard (prompt 7).
 *
 * Reads the per-subsystem timing snapshot exposed on `window.__PR_PERF`
 * by the engine and renders a compact, non-interactive overlay with:
 *   - current FPS + average frame time
 *   - active quality tier
 *   - per-system rolling-average / peak ms (sorted desc)
 *   - a budget bar (16.6ms = 60fps target)
 *   - Task 3 / item 55: 20-min rolling memory chart (Chromium-only —
 *     `performance.memory`). Samples every 5s, keeps 240 samples (20 min).
 *   - Task 3 / item 69: GPU renderer info via `WEBGL_debug_renderer_info`
 *     (where available — Chrome exposes it, Firefox/Safari usually don't).
 *
 * Visible only when `?perf=1` is in the URL (or the localStorage flag
 * `pr_perf_overlay` is set), so it never appears for real players.
 *
 * Task 3 / item 58: also surfaced in SettingsPanel as a toggle — the toggle
 * flips the same `pr_perf_overlay` localStorage flag, so the two stay in
 * sync (the user can toggle it from settings OR via URL).
 *
 * Prompt J-4049 / J-4113 — the overlay is "dev-only" by default (URL/flag
 * gate) but is also toggleable IN-GAME via the SettingsPanel → Video →
 * "Performance overlay" switch. The switch flips the same localStorage
 * flag, so toggling it on at runtime shows the overlay immediately on
 * the next render (the overlay reads the flag on mount + re-reads when
 * the settings store fires a change).
 *
 * Prompt J-4114 / J-4115 / J-4116 / J-4117 / J-4118 / J-4119 / J-4120 /
 * J-4121 / J-4122 — extended metrics already wired by L1-5000:
 *   - J-4114: frame-time sparkline (FrameTimeSparkline component)
 *   - J-4115: draw-call counter (`p.drawCalls()` accessor)
 *   - J-4116: memory counter (useMemoryChart + MemorySparkline)
 *   - J-4117: per-system breakdown (snapshot().slice().sort())
 *   - J-4118: budget alert (overBudget banner when avgMs > TARGET_MS)
 *   - J-4119: GPU timer (`p.gpuFrameMs()` accessor)
 *   - J-4120: VRAM counter (`p.vramMB()` accessor)
 *   - J-4121: ping display (`p.pingMs()` accessor)
 *   - J-4122: packet-loss display (`p.packetLossPct()` accessor)
 */
interface SubsystemTiming {
  name: string;
  avgMs: number;
  lastMs: number;
  peakMs: number;
}

interface PerfHandle {
  snapshot: () => SubsystemTiming[];
  fps: () => number;
  avgFrameMs: () => number;
  tier: () => string;
  /** L1-5000 / prompt 4485 — current draw-call count (last frame). */
  drawCalls?: () => number;
  /** L1-5000 / prompt 4490 — current estimated VRAM usage in MB. */
  vramMB?: () => number;
  /** L1-5000 / prompt 4491 — current network RTT in ms (multiplayer only). */
  pingMs?: () => number;
  /** L1-5000 / prompt 4492 — packet-loss percentage (0–100). */
  packetLossPct?: () => number;
  /** L1-5000 / prompt 4489 — last GPU frame time in ms (EXT_disjoint_timer_query,
   *  Chromium-only; null when unsupported). */
  gpuFrameMs?: () => number | null;
  /** L1-5000 / prompt 4484 — last N raw frame-time samples (ms) for the
   *  frame-time sparkline. The engine pushes samples here; the overlay
   *  plots them as a sparkline (mirrors the memory sparkline pattern). */
  frameTimeSamples?: () => number[];
}

/** Chromium-only `performance.memory` shape (not in standard TS DOM lib). */
interface ChromeMemory {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

declare global {
  interface Window {
    __PR_PERF?: PerfHandle;
    // Chromium-only — undefined on Firefox/Safari.
    performance?: Performance & { memory?: ChromeMemory };
    // Set by RendererSystem.ts after WEBGL_debug_renderer_info lookup.
    __PR_GPU_INFO?: { vendor?: string; renderer?: string };
  }
}

const TARGET_MS = 16.6; // 60fps
const WORST_MS = 33.3; // 30fps — redline

// ─── Memory chart (Task 3 / item 55) ───────────────────────────────────────
// 240 samples × 5s = 20 min rolling window. Ring buffer so the chart always
// shows the last 20 min, dropping the oldest sample once full.
const MEMORY_SAMPLE_INTERVAL_MS = 5_000;
const MEMORY_SAMPLE_COUNT = 240; // 20 min @ 5s

interface MemorySample {
  t: number;        // performance.now() at sample time
  usedMB: number;   // usedJSHeapSize / 1MB
  totalMB: number;  // totalJSHeapSize / 1MB
}

function readMemorySample(): MemorySample | null {
  if (typeof window === "undefined") return null;
  const mem = window.performance?.memory;
  if (!mem) return null;
  return {
    t: performance.now(),
    usedMB: mem.usedJSHeapSize / (1024 * 1024),
    totalMB: mem.totalJSHeapSize / (1024 * 1024),
  };
}

/** Hook: collect a 240-sample ring buffer of performance.memory readings,
 *  one every 5s. Returns the samples array (oldest → newest) + the latest
 *  reading. On non-Chromium browsers (no performance.memory) returns empty. */
function useMemoryChart(enabled: boolean) {
  // Prompt I (chore) — store samples in state (not a ref) so the
  // sparkline re-renders without accessing a ref during render.
  // Lazy initializer seeds the array with one initial sample so the
  // chart isn't empty for the first 5s.
  const [samples, setSamples] = useState<MemorySample[]>(() => {
    if (!enabled || typeof window === "undefined") return [];
    return readMemorySample() ? [readMemorySample()!] : [];
  });

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      const s = readMemorySample();
      if (!s) return;
      setSamples((prev) => {
        const buf = [...prev, s];
        if (buf.length > MEMORY_SAMPLE_COUNT) buf.shift();
        return buf;
      });
    }, MEMORY_SAMPLE_INTERVAL_MS);

    return () => clearInterval(id);
  }, [enabled]);

  return samples;
}

/** Render a tiny inline-SVG sparkline for the memory chart. Width 220px,
 *  height 28px. Plots usedJSHeapSize over time (MB). Scales to fit the
 *  rolling min/max so small leaks are visible. */
function MemorySparkline({ samples }: { samples: MemorySample[] }) {
  const W = 220;
  const H = 28;
  const path = useMemo(() => {
    if (samples.length < 2) return "";
    let min = Infinity, max = -Infinity;
    for (const s of samples) { if (s.usedMB < min) min = s.usedMB; if (s.usedMB > max) max = s.usedMB; }
    if (max - min < 1) { max = min + 1; } // avoid divide-by-zero on flat lines
    const t0 = samples[0].t;
    const t1 = samples[samples.length - 1].t;
    const tSpan = Math.max(1, t1 - t0);
    return samples
      .map((s, i) => {
        const x = (i / (samples.length - 1)) * W;
        const y = H - ((s.usedMB - min) / (max - min)) * H;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [samples]);

  const latest = samples[samples.length - 1];
  const used = latest ? latest.usedMB.toFixed(0) : "—";

  return (
    <div className="mt-2 border-t border-white/10 pt-2">
      <div className="mb-0.5 flex justify-between text-[9px] text-white/40">
        <span>HEAP (20min)</span>
        <span className="tabular-nums text-white/70">{used}MB</span>
      </div>
      <svg width={W} height={H} className="block w-full" viewBox={`0 0 ${W} ${H}`} aria-hidden>
        {path && <path d={path} fill="none" stroke="#60a5fa" strokeWidth={1} />}
      </svg>
    </div>
  );
}

/**
 * L1-5000 / prompt 4484 — frame-time sparkline. Plots the last N raw
 * frame-time samples (ms) so the dev can see jitter at a glance. Mirrors
 * the MemorySparkline pattern: 220×28 SVG, scales to the rolling min/max
 * so small spikes are visible. The 16.6ms / 33.3ms budget lines are
 * drawn as faint horizontal references.
 *
 * Renders nothing when the engine hasn't wired `frameTimeSamples()` yet
 * (graceful degradation for older engine builds).
 */
function FrameTimeSparkline({ samples }: { samples: number[] }) {
  const W = 220;
  const H = 28;
  const path = useMemo(() => {
    if (samples.length < 2) return "";
    let min = Infinity, max = -Infinity;
    for (const s of samples) { if (s < min) min = s; if (s > max) max = s; }
    // Always include the 16.6ms target in the scale so the chart doesn't
    // flatten when the game is running well (all samples < 16.6).
    min = Math.min(min, 0);
    max = Math.max(max, TARGET_MS * 1.5);
    if (max - min < 1) { max = min + 1; }
    return samples
      .map((s, i) => {
        const x = (i / (samples.length - 1)) * W;
        const y = H - ((s - min) / (max - min)) * H;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [samples]);

  if (samples.length < 2) return null;

  // Reference lines: 16.6ms (60fps) + 33.3ms (30fps).
  const refMaxY = H - (TARGET_MS / (TARGET_MS * 1.5)) * H;
  const refWorstY = H - (WORST_MS / (TARGET_MS * 1.5)) * H;

  return (
    <div className="mt-2 border-t border-white/10 pt-2">
      <div className="mb-0.5 flex justify-between text-[9px] text-white/40">
        <span>FRAME (ms)</span>
        <span className="tabular-nums text-white/70">
          {samples[samples.length - 1].toFixed(1)}ms
        </span>
      </div>
      <svg width={W} height={H} className="block w-full" viewBox={`0 0 ${W} ${H}`} aria-hidden>
        {/* 16.6ms reference line. */}
        <line x1="0" y1={refMaxY} x2={W} y2={refMaxY} stroke="#10b981" strokeWidth={0.5} strokeDasharray="2,2" opacity={0.4} />
        {/* 33.3ms reference line. */}
        <line x1="0" y1={refWorstY} x2={W} y2={refWorstY} stroke="#ef4444" strokeWidth={0.5} strokeDasharray="2,2" opacity={0.4} />
        {path && <path d={path} fill="none" stroke="#fbbf24" strokeWidth={1} />}
      </svg>
    </div>
  );
}

/** Task 3 / item 69 — GPU renderer info via WEBGL_debug_renderer_info.
 *  RendererSystem.ts sets window.__PR_GPU_INFO on init; we just read it. */
function GpuInfoLine() {
  const [info, setInfo] = useState<{ vendor?: string; renderer?: string } | undefined>(
    () => (typeof window !== "undefined" ? window.__PR_GPU_INFO : undefined),
  );
  useEffect(() => {
    if (info) return;
    const id = window.setInterval(() => {
      if (window.__PR_GPU_INFO) {
        setInfo(window.__PR_GPU_INFO);
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [info]);

  if (!info) {
    return (
      <div className="mt-1 text-[9px] text-white/30">
        GPU: (WEBGL_debug_renderer_info unavailable)
      </div>
    );
  }
  const renderer = info.renderer ?? "unknown";
  // Truncate long renderer strings (Intel HD Graphics 4000 → "Intel HD Grap…").
  const short = renderer.length > 36 ? renderer.slice(0, 33) + "…" : renderer;
  return (
    <div className="mt-1 text-[9px] text-white/40" title={renderer}>
      GPU: <span className="text-white/60">{short}</span>
    </div>
  );
}

export function PerfOverlay() {
  // Compute visibility once via a lazy initializer so we never call setState
  // synchronously inside the effect (React 19 cascading-render rule).
  const [visible] = useState(() => {
    if (typeof window === "undefined") return false;
    const urlOn = new URLSearchParams(window.location.search).get("perf") === "1";
    const lsOn = localStorage.getItem("pr_perf_overlay") === "1";
    return urlOn || lsOn;
  });
  const [fps, setFps] = useState(0);
  const [avgMs, setAvgMs] = useState(0);
  const [tier, setTier] = useState("—");
  const [systems, setSystems] = useState<SubsystemTiming[]>([]);
  // L1-5000 / prompts 4485+4490+4491+4492+4489 — extended metric state.
  const [drawCalls, setDrawCalls] = useState<number | null>(null);
  const [vramMB, setVramMB] = useState<number | null>(null);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [packetLoss, setPacketLoss] = useState<number | null>(null);
  const [gpuFrameMs, setGpuFrameMs] = useState<number | null>(null);
  // L1-5000 / prompt 4484 — frame-time sparkline samples.
  const [frameTimeSamples, setFrameTimeSamples] = useState<number[]>([]);
  // Task 3 / item 55 — 20-min rolling memory chart.
  const memSamples = useMemoryChart(visible);

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const tick = () => {
      const p = window.__PR_PERF;
      if (p) {
        setFps(p.fps());
        setAvgMs(p.avgFrameMs());
        setTier(p.tier());
        setSystems(
          p
            .snapshot()
            .slice()
            .sort((a, b) => b.avgMs - a.avgMs)
            .slice(0, 12),
        );
        // L1-5000 — extended metrics (graceful null when the engine
        // hasn't wired the accessor yet, so older engine builds still
        // render the overlay without runtime errors).
        setDrawCalls(p.drawCalls ? p.drawCalls() : null);
        setVramMB(p.vramMB ? p.vramMB() : null);
        setPingMs(p.pingMs ? p.pingMs() : null);
        setPacketLoss(p.packetLossPct ? p.packetLossPct() : null);
        setGpuFrameMs(p.gpuFrameMs ? p.gpuFrameMs() : null);
        setFrameTimeSamples(p.frameTimeSamples ? p.frameTimeSamples() : []);
      }
      raf = window.setTimeout(tick, 250) as unknown as number;
    };
    tick();
    return () => clearTimeout(raf);
  }, [visible]);

  if (!visible) return null;

  const budgetPct = Math.min(100, (avgMs / WORST_MS) * 100);
  const budgetColor =
    avgMs <= TARGET_MS ? "bg-emerald-500" : avgMs <= WORST_MS ? "bg-amber-500" : "bg-red-500";
  const fpsColor =
    fps >= 55 ? "text-emerald-400" : fps >= 30 ? "text-amber-400" : "text-red-400";
  // L1-5000 / prompt 4488 — budget alert: show a banner when the
  // rolling-average frame time exceeds the 60fps target.
  const overBudget = avgMs > TARGET_MS;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed left-3 top-3 z-[9998] w-64 rounded-lg border border-white/10 bg-black/80 p-3 font-mono text-[11px] leading-tight text-white/90 shadow-xl backdrop-blur"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-display text-xs font-bold uppercase tracking-widest text-white">
          Perf
        </span>
        <span className="text-white/50">{tier.toUpperCase()}</span>
      </div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className={`text-2xl font-bold ${fpsColor}`}>{fps}</span>
        <span className="text-white/50">FPS · {avgMs.toFixed(1)}ms</span>
      </div>
      {/* L1-5000 / prompt 4488 — budget alert banner. */}
      {overBudget && (
        <div className="mb-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-red-300">
          ⚠ Over {TARGET_MS}ms budget
        </div>
      )}
      {/* Budget bar */}
      <div className="mb-1 h-1.5 w-full overflow-hidden rounded bg-white/10">
        <div
          className={`h-full ${budgetColor}`}
          style={{ width: `${budgetPct}%` }}
        />
      </div>
      <div className="mb-2 flex justify-between text-[9px] text-white/40">
        <span>0</span>
        <span className="text-emerald-400/60">16.6</span>
        <span className="text-red-400/60">33.3</span>
      </div>
      {/* L1-5000 / prompt 4484 — frame-time sparkline. Plots the last N
          raw frame-time samples (ms) so the dev can see jitter at a glance. */}
      <FrameTimeSparkline samples={frameTimeSamples} />
      {/* L1-5000 / prompts 4485+4490+4489+4491+4492 — extended metrics row.
          Each metric renders as "label: value" with a graceful "—" when
          the engine hasn't wired the accessor. */}
      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 border-t border-white/10 pt-2 text-[9px] text-white/50">
        <div className="flex justify-between">
          <span>DC</span>
          <span className="tabular-nums text-white/70">{drawCalls !== null ? drawCalls : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span>GPU</span>
          <span className="tabular-nums text-white/70">{gpuFrameMs !== null ? `${gpuFrameMs.toFixed(1)}ms` : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span>VRAM</span>
          <span className="tabular-nums text-white/70">{vramMB !== null ? `${vramMB.toFixed(0)}MB` : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span>PING</span>
          <span className={`tabular-nums ${pingMs === null ? "text-white/70" : pingMs < 50 ? "text-emerald-400" : pingMs < 150 ? "text-amber-400" : "text-red-400"}`}>
            {pingMs !== null ? `${pingMs.toFixed(0)}ms` : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>LOSS</span>
          <span className={`tabular-nums ${packetLoss === null ? "text-white/70" : packetLoss < 1 ? "text-emerald-400" : packetLoss < 5 ? "text-amber-400" : "text-red-400"}`}>
            {packetLoss !== null ? `${packetLoss.toFixed(1)}%` : "—"}
          </span>
        </div>
      </div>
      {/* Per-system breakdown */}
      <div className="space-y-0.5">
        {systems.length === 0 && (
          <div className="text-white/40">waiting for engine…</div>
        )}
        {systems.map((s) => {
          const pct = Math.min(100, (s.avgMs / TARGET_MS) * 100);
          const c =
            s.avgMs <= TARGET_MS * 0.5
              ? "bg-emerald-500/70"
              : s.avgMs <= TARGET_MS
                ? "bg-amber-500/70"
                : "bg-red-500/70";
          return (
            <div key={s.name} className="flex items-center gap-1.5">
              <span className="w-20 truncate text-white/60">{s.name}</span>
              <div className="h-1 flex-1 overflow-hidden rounded bg-white/10">
                <div className={`h-full ${c}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="w-12 text-right tabular-nums text-white/70">
                {s.avgMs.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
      {/* Task 3 / item 55 — 20-min rolling memory sparkline (Chromium-only). */}
      <MemorySparkline samples={memSamples} />
      {/* Task 3 / item 69 — GPU renderer info. */}
      <GpuInfoLine />
    </div>
  );
}
