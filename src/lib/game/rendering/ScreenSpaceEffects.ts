/**
 * Phase 3: Advanced screen-space effects — DEPRECATED stub.
 *
 * A3-5000-retry / prompt 407: this class was a dead stub — `init()` built an
 * EffectComposer but added no passes, and `render()` had `this.composer.render()`
 * COMMENTED OUT. The real SSR / SSAO / Clearcoat / SSS implementations live in
 * `src/lib/game/rendering2/{ssr,ssao}.ts` (wired by PostProcessing.ts). This
 * module is retained for type-compat with any legacy imports but is now a
 * no-op that logs a one-time deprecation warning. All four effects are
 * "removed" from this class — callers should use the rendering2 implementations.
 */

import * as THREE from "three";

export interface ScreenSpaceEffectsConfig {
  enableSSR: boolean;
  enableSSAO: boolean;
  enableClearcoat: boolean;
  enableSSS: boolean;
  /** SSAO sample radius (world units). */
  ssaoRadius: number;
  /** SSR max distance (world units). */
  ssrMaxDistance: number;
}

/**
 * A3-5000-retry / 407: deprecated no-op stub. The real screen-space effects
 * are wired by `PostProcessing.ts` via `rendering2/ssr.ts` + `rendering2/ssao.ts`.
 */
export class ScreenSpaceEffects {
  config: ScreenSpaceEffectsConfig;
  /** Always null — kept for legacy callers that read this field. */
  composer: any = null;
  private _warned = false;

  constructor(config: ScreenSpaceEffectsConfig) {
    this.config = config;
  }

  /** No-op. Real passes live in rendering2/. */
  async init(_renderer: any, _scene: THREE.Scene, _camera: THREE.Camera): Promise<void> {
    if (!this._warned) {
      console.warn("[ScreenSpaceEffects] DEPRECATED — use rendering2/ssr.ts + rendering2/ssao.ts (wired by PostProcessing.ts). This stub is a no-op.");
      this._warned = true;
    }
  }

  /** No-op. */
  render(_deltaTime: number): void {
    // Intentionally empty — see init().
  }

  /** No-op. */
  setSize(_width: number, _height: number): void {
    // Intentionally empty.
  }

  dispose(): void {
    this.composer = null;
  }
}

/** Default config: SSR + SSAO on ultra/high, off on medium/low. */
export function getDefaultScreenSpaceEffectsConfig(tier: string): ScreenSpaceEffectsConfig {
  const highTier = tier === "ultra" || tier === "high";
  return {
    enableSSR: highTier,
    enableSSAO: highTier,
    enableClearcoat: tier === "ultra",
    enableSSS: tier === "ultra",
    ssaoRadius: 0.5,
    ssrMaxDistance: 50,
  };
}
