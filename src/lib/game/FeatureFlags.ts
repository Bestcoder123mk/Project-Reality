/**
 * Feature Flags — honest capability gating.
 *
 * Prompt: "Delete the vaporware pillar flags before any of the above, so the
 * codebase stops lying about what it can do."
 *
 * The previous v2 pillar flags (world_model, embodied_cognition,
 * neural_rendering_2, biometric_director, living_world, narrative_engine,
 * xr_convergence, modding) were all default-OFF stubs that implied capability
 * the codebase didn't have. They've been removed.
 *
 * What remains is the genuine hardware-feature detection (WebGL2, WebGPU,
 * WebWorker, SharedArrayBuffer, IndexedDB, etc.) that real systems check
 * before using optional browser APIs. These flags reflect actual runtime
 * capability, not aspirational pillars.
 */

import { detectFeatures, type FeatureAvailability } from "./systems/HardwareDetect";

export type FeatureKey = keyof FeatureAvailability;

let cachedFeatures: FeatureAvailability | null = null;
let overrides: Partial<Record<FeatureKey, boolean>> = {};

function loadOverrides(): Partial<Record<FeatureKey, boolean>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem("pr_feature_overrides");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Get the current feature availability (with overrides applied). */
export function getFeatures(): FeatureAvailability {
  if (!cachedFeatures) cachedFeatures = detectFeatures();
  if (Object.keys(overrides).length === 0) overrides = loadOverrides();
  return { ...cachedFeatures, ...overrides };
}

/**
 * A3-5000 #596 — invalidate the cached feature detection.
 *
 * Previously `getFeatures()` cached `detectFeatures()` for the entire page
 * lifetime — a browser update enabling WebGPU mid-session (or a feature
 * flag flip from a service worker) wouldn't be picked up until reload.
 * Call this after a browser update / version bump / settings change to
 * force the next `getFeatures()` call to re-run `detectFeatures()`.
 *
 * Overrides are preserved (they reflect user choice, not detection).
 */
export function invalidateFeatures(): void {
  cachedFeatures = null;
}

/** Check if a specific feature is enabled. */
export function isFeatureEnabled(key: FeatureKey): boolean {
  return getFeatures()[key] ?? false;
}

/** Override a feature flag (for testing). Persists to localStorage. */
export function setFeatureOverride(key: FeatureKey, enabled: boolean): void {
  overrides[key] = enabled;
  if (typeof window !== "undefined") {
    localStorage.setItem("pr_feature_overrides", JSON.stringify(overrides));
    // A3-5000 #597 — broadcast the override to other tabs via the storage
    // event. Without this, two open tabs would diverge: tab 1's override
    // wouldn't reach tab 2 until reload. The storage event fires in OTHER
    // tabs (not the originating one), which is exactly the cross-tab sync
    // semantics we want. The listener (registered below) re-reads the
    // overrides + invalidates the cached features so the new value is picked
    // up on the next getFeatures() call.
  }
}

// A3-5000 #597 — cross-tab override sync. The `storage` event fires in
// every OTHER tab when one tab writes to localStorage. We reload the
// overrides + invalidate the cached features so the change is visible
// without a page reload. Registered once at module load (idempotent —
// guarded by a sentinel property so HMR / re-imports don't double-bind).
if (typeof window !== "undefined" && !(window as unknown as { __pr_feature_storage_bound?: boolean }).__pr_feature_storage_bound) {
  (window as unknown as { __pr_feature_storage_bound?: boolean }).__pr_feature_storage_bound = true;
  window.addEventListener("storage", (e) => {
    if (e.key === "pr_feature_overrides") {
      overrides = loadOverrides();
      cachedFeatures = null; // invalidate so new overrides take effect
    }
  });
}

/** Clear all overrides. */
export function clearFeatureOverrides(): void {
  overrides = {};
  if (typeof window !== "undefined") localStorage.removeItem("pr_feature_overrides");
}

/**
 * Pillar availability summary (hardware capability).
 * Reflects which gameplay pillars CAN be activated given current features.
 * Used by the settings panel to grey-out options the hardware can't support.
 *
 * A3-5000 #598 — caller wiring. The settings panels (VideoPanel,
 * AccessibilityPanel) SHOULD call this on mount + when getFeatures()
 * changes (post-invalidate) to grey-out unsupported options. The function
 * is intentionally pure (no side effects) so it can be called from React
 * render without affecting engine state.
 */
export function getPillarAvailability(): {
  pillar1_real_physics: boolean;
  pillar2_spatial_audio: boolean;
  pillar3_pwa_offline: boolean;
  pillar4_haptics: boolean;
  pillar5_workers: boolean;
} {
  const f = getFeatures();
  return {
    pillar1_real_physics: true, // AABB impulse backend works everywhere
    pillar2_spatial_audio: true, // Web Audio PannerNode works everywhere
    pillar3_pwa_offline: f.serviceWorker && f.indexedDB,
    pillar4_haptics: typeof navigator !== "undefined" && "getGamepads" in navigator,
    pillar5_workers: f.webWorker,
  };
}

/**
 * A3-5000 #598 — helper for settings UIs. Returns a list of pillars that
 * are UNavailable on the current hardware, in display order. The Video /
 * Accessibility panels map each entry to a disabled setting row with a
 * tooltip explaining why it's greyed out. Empty array means all pillars
 * are available (no grey-out needed).
 */
export function getUnavailablePillars(): string[] {
  const avail = getPillarAvailability();
  const labels: Record<keyof typeof avail, string> = {
    pillar1_real_physics: "Real Physics",
    pillar2_spatial_audio: "Spatial Audio",
    pillar3_pwa_offline: "Offline PWA",
    pillar4_haptics: "Haptics",
    pillar5_workers: "Web Workers",
  };
  return (Object.keys(avail) as (keyof typeof avail)[])
    .filter((k) => !avail[k])
    .map((k) => labels[k]);
}
