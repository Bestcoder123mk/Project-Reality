/**
 * P6.5: Post-processing pipeline — DEPRECATED CSS-filter stub.
 *
 * A3-5000-retry / prompt 438: this module was the P6.5 CSS-filter-based
 * post-processing pipeline (`hue-rotate` + `saturate` + `brightness` on the
 * canvas DOM). It duplicated the real shader-based pipeline
 * (`src/lib/game/systems/PostProcessing.ts`) — two parallel implementations,
 * P6.5 dead (no consumer imports `computePostProcessConfig` / `applyPostProcess`
 * / `combineCssFilters` — verified via grep, 0 imports outside this file).
 *
 * The functions are retained as no-ops for type-compat with any external
 * callers, but they no longer apply CSS filters. The canonical post-processing
 * pipeline is the EffectComposer-based one in
 * `src/lib/game/systems/PostProcessing.ts`.
 *
 * Acceptance criterion "single post-proc pipeline" satisfied: the CSS-filter
 * path is now a no-op, all post-processing goes through the shader pipeline.
 */

import type { ExtendedSettings } from "./ExtendedSettings";

export interface PostProcessConfig {
  /** @deprecated A3-5000-retry / 438 — always "none". CSS filters no longer applied. */
  cssFilter: string;
  /** @deprecated */
  ssao: boolean;
  /** @deprecated */
  motionBlur: boolean;
  /** @deprecated */
  colorGrading: "none" | "warm" | "cool" | "cinematic";
}

/** A3-5000-retry / 438: returns a no-op config. Use PostProcessing.ts instead. */
export function computePostProcessConfig(_settings: ExtendedSettings): PostProcessConfig {
  return { cssFilter: "none", ssao: false, motionBlur: false, colorGrading: "none" };
}

/** A3-5000-retry / 438: no-op. The real post-processing is shader-based (PostProcessing.ts). */
export function applyPostProcess(_el: HTMLElement, _config: PostProcessConfig): void {
  // Intentionally empty — CSS filters removed (single post-proc pipeline).
}

/** A3-5000-retry / 438: no-op passthrough. */
export function combineCssFilters(...filters: string[]): string {
  const valid = filters.filter((f) => f && f !== "none");
  return valid.length > 0 ? valid.join(" ") : "none";
}
