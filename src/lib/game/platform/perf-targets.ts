/**
 * L1-5000 / prompts 4479,4480,4481,4482,4533,4534,4535,4536,4587,4588,4589,4590,4625,4626,4627,4628,4663,4664,4665,4666,4701,4702,4703,4704,4739,4740: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * SEC12-PLATFORM prompt 93 — Mobile / console / PC performance targets.
 *
 * Defines explicit frame-time budgets per target platform so a regression
 * (more draw calls than the budget allows, longer frame time than the
 * target) is visible at a glance in the FrameBudgetProfiler HUD overlay
 * + the admin crash-free dashboard.
 *
 * The budgets are *deliberate* — they come from the hardware matrix:
 *
 *   - Mid-range mobile (Pixel 5a / iPhone 12 / Galaxy S21 class): big.LITTLE
 *     CPU, 4-6GB RAM, Mali/Adreno 6xx GPU. Target 60fps at 16.6ms frame
 *     budget; cap draw calls at 300 (each one is a driver overhead hit on
 *     tiled renderers) + triangles at 250k (mobile GPUs are vertex-bound).
 *   - High-end mobile + low-end console (Switch-class): 60fps, slightly
 *     looser triangle budget (500k) because the GPU is unified memory.
 *   - Console (PS5/XSX-class): 60fps baseline, 120fps in performance
 *     mode. 3M triangles + 3000 draw calls is well within reach.
 *   - High-end PC (RTX 4070 / RX 7800 XT + 8-core CPU): 144fps target.
 *     7ms frame budget; 5M triangles + 5000 draw calls.
 *
 * Public API:
 *   - `PERF_TARGETS` — read-only table of every target platform.
 *   - `getPerfTargetForDevice(hardwareTier)` — maps the existing
 *     `QualityTier` (low/medium/high/ultra) detected by HardwareDetect to
 *     the closest perf-target. Used by FrameBudgetProfiler to set its
 *     budget + the HUD overlay to show "X ms / budget Y ms".
 *   - `getPerfTargetForPlatform(platform)` — explicit platform lookup
 *     (used by the per-platform CI / benchmark runner).
 *   - `PlatformId` — string-literal union of supported platform ids.
 *
 * Wiring: FrameBudgetProfiler imports `getPerfTargetForDevice` and uses
 * the returned `budgetMs` instead of the hardcoded `BUDGET_MS = 16.6`.
 * The `maxDrawCalls` / `maxTriangles` are surfaced in the snapshot so a
 * HUD/telemetry consumer can flag a regression.
 */

import type { QualityTier } from "../systems/FrameBudgetProfiler";

/** Supported target platforms (string-literal union for type-safe lookup). */
export type PlatformId =
  | "mobile-low"
  | "mobile-mid"
  | "mobile-high"
  | "console-switch"
  | "console-ps5"
  | "console-xsx"
  | "pc-low"
  | "pc-mid"
  | "pc-high"
  | "pc-ultra";

/**
 * A single platform's frame-time budget + render caps.
 *
 * `budgetMs` is the per-frame time budget (1000 / targetFps, minus a
 * safety margin so transient spikes don't blow the budget every frame).
 */
export interface PerfTarget {
  /** Stable platform identifier. */
  platform: PlatformId;
  /** Human-readable label for HUD/telemetry. */
  label: string;
  /** Target frame rate in fps. */
  targetFps: number;
  /** Per-frame time budget in milliseconds. */
  budgetMs: number;
  /** Maximum draw calls per frame before a regression is flagged. */
  maxDrawCalls: number;
  /** Maximum submitted triangles per frame before a regression is flagged. */
  maxTriangles: number;
  /** Maximum VRAM (in MB) the renderer is allowed to hold resident. */
  maxVramMB: number;
  /** Whether this platform is a "performance mode" target (e.g. 120fps PS5). */
  isPerformanceMode: boolean;
}

/**
 * The complete perf-target table. Sorted roughly low-end → high-end.
 *
 * Budget math: budgetMs = (1000 / targetFps) * 0.92 — the 8% safety
 * margin leaves room for one vsync spike per second without flagging a
 * regression.
 */
export const PERF_TARGETS: Record<PlatformId, PerfTarget> = {
  "mobile-low": {
    platform: "mobile-low",
    label: "Low-end mobile (2GB, 4-core)",
    targetFps: 30,
    budgetMs: (1000 / 30) * 0.92, // ~30.7ms
    maxDrawCalls: 150,
    maxTriangles: 120_000,
    maxVramMB: 512,
    isPerformanceMode: false,
  },
  "mobile-mid": {
    platform: "mobile-mid",
    label: "Mid-range mobile (Pixel 5a / iPhone 12)",
    targetFps: 60,
    budgetMs: (1000 / 60) * 0.92, // ~15.3ms
    maxDrawCalls: 300,
    maxTriangles: 250_000,
    maxVramMB: 768,
    isPerformanceMode: false,
  },
  "mobile-high": {
    platform: "mobile-high",
    label: "High-end mobile (iPhone 15 Pro / S24)",
    targetFps: 60,
    budgetMs: (1000 / 60) * 0.92,
    maxDrawCalls: 500,
    maxTriangles: 500_000,
    maxVramMB: 1024,
    isPerformanceMode: false,
  },
  "console-switch": {
    platform: "console-switch",
    label: "Nintendo Switch (docked)",
    targetFps: 60,
    budgetMs: (1000 / 60) * 0.92,
    maxDrawCalls: 600,
    maxTriangles: 500_000,
    maxVramMB: 2048,
    isPerformanceMode: false,
  },
  "console-ps5": {
    platform: "console-ps5",
    label: "PlayStation 5 (60fps fidelity)",
    targetFps: 60,
    budgetMs: (1000 / 60) * 0.92,
    maxDrawCalls: 3000,
    maxTriangles: 3_000_000,
    maxVramMB: 8192,
    isPerformanceMode: false,
  },
  "console-xsx": {
    platform: "console-xsx",
    label: "Xbox Series X (120fps performance)",
    targetFps: 120,
    budgetMs: (1000 / 120) * 0.92, // ~7.7ms
    maxDrawCalls: 3000,
    maxTriangles: 3_000_000,
    maxVramMB: 8192,
    isPerformanceMode: true,
  },
  "pc-low": {
    platform: "pc-low",
    label: "Low-end PC (integrated GPU)",
    targetFps: 60,
    budgetMs: (1000 / 60) * 0.92,
    maxDrawCalls: 1000,
    maxTriangles: 1_000_000,
    maxVramMB: 2048,
    isPerformanceMode: false,
  },
  "pc-mid": {
    platform: "pc-mid",
    label: "Mid-range PC (GTX 1660 / RX 6600)",
    targetFps: 60,
    budgetMs: (1000 / 60) * 0.92,
    maxDrawCalls: 2000,
    maxTriangles: 2_000_000,
    maxVramMB: 4096,
    isPerformanceMode: false,
  },
  "pc-high": {
    platform: "pc-high",
    label: "High-end PC (RTX 4070 / RX 7800 XT)",
    targetFps: 144,
    budgetMs: (1000 / 144) * 0.92, // ~6.4ms
    maxDrawCalls: 5000,
    maxTriangles: 5_000_000,
    maxVramMB: 8192,
    isPerformanceMode: false,
  },
  "pc-ultra": {
    platform: "pc-ultra",
    label: "Ultra PC (RTX 4090 / RX 7900 XTX)",
    targetFps: 240,
    budgetMs: (1000 / 240) * 0.92, // ~3.8ms
    maxDrawCalls: 8000,
    maxTriangles: 8_000_000,
    maxVramMB: 16384,
    isPerformanceMode: true,
  },
};

/**
 * The mobile/console/PC tier → platform mapping used by the runtime.
 *
 * `hardwareTier` comes from HardwareDetect.detectHardwareExtended() — the
 * "ultra" / "high" / "medium" / "low" categorization based on
 * deviceMemory + cores + WebGPU availability. We additionally consider
 * `isMobile` so the same "high" tier maps to a different platform on a
 * phone vs a desktop.
 */
export interface DeviceProfile {
  tier: QualityTier;
  isMobile: boolean;
  /** Optional explicit platform override (e.g. set from URL param). */
  override?: PlatformId;
}

/**
 * Map a detected hardware tier to the closest perf-target.
 *
 * The mapping is intentionally conservative — a "high" tier on mobile
 * maps to "mobile-high" (60fps, 500 draw calls), not "console-ps5",
 * because mobile GPUs are fill-rate + draw-call-bound regardless of how
 * much RAM the device has.
 */
export function getPerfTargetForDevice(
  hardwareTier: QualityTier | DeviceProfile,
): PerfTarget {
  // Accept either a bare QualityTier (treat as desktop) or a full profile.
  const profile: DeviceProfile =
    typeof hardwareTier === "string"
      ? { tier: hardwareTier, isMobile: false }
      : hardwareTier;

  if (profile.override && PERF_TARGETS[profile.override]) {
    return PERF_TARGETS[profile.override];
  }

  if (profile.isMobile) {
    switch (profile.tier) {
      case "ultra":
        return PERF_TARGETS["mobile-high"];
      case "high":
        return PERF_TARGETS["mobile-high"];
      case "medium":
        return PERF_TARGETS["mobile-mid"];
      case "low":
      default:
        return PERF_TARGETS["mobile-low"];
    }
  }

  // Desktop / console class.
  switch (profile.tier) {
    case "ultra":
      return PERF_TARGETS["pc-ultra"];
    case "high":
      return PERF_TARGETS["pc-high"];
    case "medium":
      return PERF_TARGETS["pc-mid"];
    case "low":
    default:
      return PERF_TARGETS["pc-low"];
  }
}

/** Explicit platform lookup (used by per-platform CI / benchmark runner). */
export function getPerfTargetForPlatform(platform: PlatformId): PerfTarget {
  const t = PERF_TARGETS[platform];
  if (!t) {
    throw new Error(`Unknown platform id: ${platform}`);
  }
  return t;
}

/** Convenience: list every target (for the admin perf report). */
export function listPerfTargets(): PerfTarget[] {
  return Object.values(PERF_TARGETS);
}

/**
 * Given an observed frame time + draw call count + triangle count,
 * return the platforms whose budgets are violated. Empty array = clean.
 *
 * Used by the per-platform CI smoke test: run a fixed 30s capture on
 * each platform's GPU profile, call this with the worst-observed
 * numbers, and any violations become a perf regression on that platform.
 */
export function findBudgetViolations(observed: {
  frameMs: number;
  drawCalls: number;
  triangles: number;
}): PerfTarget[] {
  const out: PerfTarget[] = [];
  for (const t of Object.values(PERF_TARGETS)) {
    if (
      observed.frameMs > t.budgetMs ||
      observed.drawCalls > t.maxDrawCalls ||
      observed.triangles > t.maxTriangles
    ) {
      out.push(t);
    }
  }
  return out;
}
