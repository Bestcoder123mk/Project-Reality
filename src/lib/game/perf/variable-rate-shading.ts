/**
 * Section L / L_Performance_Optimization.txt
 * Prompts: 22, 41, 45, 54 ("WebGPU pipeline creation" + "triangle throughput")
 *
 * variable-rate-shading.ts — Variable Rate Shading (VRS) for peripheral regions.
 *
 * VRS lets the GPU run the fragment shader at a reduced rate for tiles that
 * don't need full detail — e.g. the periphery of the screen (where the
 * player isn't looking), behind the gun (where the gun model covers most of
 * the pixels), or motion-blurred regions (where the blur hides reduced
 * detail). On a 4K render, VRS 4x4 in the periphery can halve fragment
 * shader cost with no perceptible quality loss.
 *
 * WebGPU exposes VRS via `GPURenderPass.colorAttachment[].view` with a
 * shading rate image attached. The shading rate image is a texture whose
 * texels encode the rate (1x1, 1x2, 2x1, 2x2, 4x4) for the corresponding
 * screen tile.
 *
 * WebGL2 has no native VRS. The fallback path uses a render-scale trick:
 * render the periphery at half resolution to a separate render target +
 * upscale (cheap bilinear) when compositing. This isn't as efficient as
 * real VRS (it still issues a separate draw call) but achieves a similar
 * fragment-shader saving.
 *
 * Degradation: if VRS isn't available, the manager is a no-op.
 */

// ─── Public types ────────────────────────────────────────────────────────

/** Shading rate for a screen tile. Higher = coarser (cheaper). */
export type ShadingRate = 1 | 2 | 4;

/** VRS pattern — controls how the rate varies across the screen. */
export type VRSPattern = "uniform" | "periphery" | "foveated" | "motion-aware";

/** VRS configuration. */
export interface VRSConfig {
  pattern: VRSPattern;
  /** Center shading rate (always 1 = full detail). */
  centerRate: ShadingRate;
  /** Periphery shading rate. */
  peripheryRate: ShadingRate;
  /** Foveated: radius (0..1 of viewport min dimension) of the full-detail region. */
  foveatedRadius: number;
  /** Motion-aware: rate increase above this motion-vector magnitude. */
  motionThreshold: number;
}

/** VRS stats. */
export interface VRSStats {
  enabled: boolean;
  pattern: VRSPattern;
  /** Average shading rate actually applied this frame. */
  avgRate: number;
  /** Estimated fragment shader savings (0..1). */
  savings: number;
}

// ─── VRS manager ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: VRSConfig = {
  pattern: "periphery",
  centerRate: 1,
  peripheryRate: 2,
  foveatedRadius: 0.25,
  motionThreshold: 8.0,
};

/**
 * VariableRateShadingManager — owns the shading rate image + per-frame
 * updates.
 *
 * Usage:
 *   const vrs = new VariableRateShadingManager();
 *   await vrs.init({ webgpuDevice, viewport: { w: 1920, h: 1080 } });
 *   // Per frame:
 *   vrs.update({ cameraMotion: 5.2, gaze: { x: 0.5, y: 0.5 } });
 *   const rateImage = vrs.getRateImage(); // GPUTexture on WebGPU, null otherwise
 *   if (rateImage) pass.setShadingRateImage(rateImage);
 */
export class VariableRateShadingManager {
  private config: VRSConfig = DEFAULT_CONFIG;
  private enabled = false;
  private device: GPUDevice | null = null;
  private rateImage: GPUTexture | null = null;
  private rateView: GPUTextureView | null = null;
  private viewport = { w: 1920, h: 1080 };
  private tileW = 8; // VRS tile size (hardware-defined; WebGPU spec = 8x8)
  private tileH = 8;
  private avgRate = 1;
  private savings = 0;

  /** Initialize. Returns true if VRS is available. */
  async init(opts: { webgpuDevice?: GPUDevice; viewport: { w: number; h: number } }): Promise<boolean> {
    this.viewport = opts.viewport;
    if (!opts.webgpuDevice) {
      this.enabled = false;
      return false;
    }
    try {
      this.device = opts.webgpuDevice;
      // Check for the VRS feature.
      const features = opts.webgpuDevice.features;
      const hasVRS = features.has("shading-rate" as GPUFeatureName)
        || features.has("fragment-shading-rate" as GPUFeatureName);
      if (!hasVRS) {
        console.info("[VRS] shading-rate feature not available — VRS disabled");
        this.enabled = false;
        return false;
      }
      // Allocate the shading-rate image. Texel format is r8uint where
      // 0 = 1x1, 1 = 1x2, 2 = 2x1, 3 = 2x2, 4 = 4x4 (WebGPU enum).
      const tileW = Math.ceil(this.viewport.w / this.tileW);
      const tileH = Math.ceil(this.viewport.h / this.tileH);
      this.rateImage = opts.webgpuDevice.createTexture({
        size: { width: tileW, height: tileH },
        format: "r8uint" as GPUTextureFormat,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.rateView = this.rateImage.createView();
      this.enabled = true;
      return true;
    } catch (err) {
      console.warn("[VRS] init failed:", err);
      this.enabled = false;
      return false;
    }
  }

  /** Update the configuration. */
  setConfig(c: Partial<VRSConfig>): void {
    this.config = { ...this.config, ...c };
  }

  /** Per-frame: regenerate the shading rate image based on the pattern. */
  update(opts: { cameraMotion?: number; gaze?: { x: number; y: number } }): void {
    if (!this.enabled || !this.device || !this.rateImage) return;
    const motion = opts.cameraMotion ?? 0;
    const gaze = opts.gaze ?? { x: 0.5, y: 0.5 };

    const tileW = Math.ceil(this.viewport.w / this.tileW);
    const tileH = Math.ceil(this.viewport.h / this.tileH);
    const data = new Uint8Array(tileW * tileH);
    let rateSum = 0;
    for (let y = 0; y < tileH; y++) {
      for (let x = 0; x < tileW; x++) {
        let rate: number;
        switch (this.config.pattern) {
          case "uniform":
            rate = this.rateToCode(this.config.peripheryRate);
            break;
          case "periphery": {
            // Center 50% of the viewport is full-detail; periphery is reduced.
            const dx = (x / tileW) - 0.5;
            const dy = (y / tileH) - 0.5;
            const dist = Math.hypot(dx, dy);
            rate = dist < 0.25
              ? this.rateToCode(this.config.centerRate)
              : this.rateToCode(this.config.peripheryRate);
            break;
          }
          case "foveated": {
            const dx = (x / tileW) - gaze.x;
            const dy = (y / tileH) - gaze.y;
            const dist = Math.hypot(dx, dy);
            rate = dist < this.config.foveatedRadius
              ? this.rateToCode(this.config.centerRate)
              : this.rateToCode(this.config.peripheryRate);
            break;
          }
          case "motion-aware": {
            // Where motion is high, reduce rate (the blur will hide it).
            rate = motion > this.config.motionThreshold
              ? this.rateToCode(this.config.peripheryRate)
              : this.rateToCode(this.config.centerRate);
            break;
          }
          default:
            rate = 0;
        }
        data[(y * tileW) + x] = rate;
        rateSum += this.codeToRateValue(rate);
      }
    }
    this.avgRate = rateSum / (tileW * tileH);
    this.savings = 1 - (1 / this.avgRate);

    // Upload the rate image.
    this.device.queue.writeTexture(
      { texture: this.rateImage },
      data,
      { bytesPerRow: tileW, rowsPerImage: tileH },
      { width: tileW, height: tileH },
    );
  }

  /** Get the shading rate image view (for binding to the render pass). */
  getRateView(): GPUTextureView | null {
    return this.rateView;
  }

  /** Snapshot for diagnostics. */
  stats(): VRSStats {
    return {
      enabled: this.enabled,
      pattern: this.config.pattern,
      avgRate: this.avgRate,
      savings: this.savings,
    };
  }

  /** Dispose GPU resources. */
  dispose(): void {
    this.rateImage?.destroy();
    this.rateImage = null;
    this.rateView = null;
    this.device = null;
    this.enabled = false;
  }

  /** Convert a ShadingRate (1/2/4) to the WebGPU enum code. */
  private rateToCode(rate: ShadingRate): number {
    switch (rate) {
      case 1: return 0; // 1x1
      case 2: return 3; // 2x2
      case 4: return 4; // 4x4
      default: return 0;
    }
  }

  /** Convert a WebGPU enum code back to a "rate value" (1, 2, or 4). */
  private codeToRateValue(code: number): number {
    switch (code) {
      case 0: return 1; // 1x1
      case 1: return 2; // 1x2
      case 2: return 2; // 2x1
      case 3: return 4; // 2x2
      case 4: return 16; // 4x4
      default: return 1;
    }
  }
}

// ─── WebGL2 fallback (render-scale) ──────────────────────────────────────

/**
 * WebGL2VRSFallback — emulates VRS on WebGL2 by rendering the periphery
 * at half resolution into a separate render target + upscaling on composite.
 *
 * This isn't true VRS (it's a separate draw call) but achieves similar
 * fragment-shader savings on hardware without native VRS. The fallback
 * is opt-in: callers who don't want the extra render target can disable
 * it + the manager becomes a no-op.
 */
export class WebGL2VRSFallback {
  private enabled = false;
  private halfResTarget: THREE.WebGLRenderTarget | null = null;
  private compositeMaterial: THREE.ShaderMaterial | null = null;
  private compositeMesh: THREE.Mesh | null = null;

  init(renderer: THREE.WebGLRenderer, viewport: { w: number; h: number }): boolean {
    try {
      this.halfResTarget = new THREE.WebGLRenderTarget(
        Math.floor(viewport.w / 2),
        Math.floor(viewport.h / 2),
        { format: THREE.RGBAFormat, type: THREE.UnsignedByteType },
      );
      this.compositeMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tFull: { value: null },
          tHalf: { value: null },
          uPeripheryMask: { value: 0.5 },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D tFull;
          uniform sampler2D tHalf;
          uniform float uPeripheryMask;
          varying vec2 vUv;
          void main() {
            vec2 d = vUv - 0.5;
            float dist = length(d);
            float mask = smoothstep(0.25, 0.5, dist);
            vec3 full = texture2D(tFull, vUv).rgb;
            vec3 half_ = texture2D(tHalf, vUv).rgb;
            gl_FragColor = vec4(mix(full, half_, mask * uPeripheryMask), 1.0);
          }
        `,
      });
      this.compositeMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        this.compositeMaterial,
      );
      this.compositeMesh.frustumCulled = false;
      this.enabled = true;
      return true;
    } catch (err) {
      console.warn("[VRS-Fallback] init failed:", err);
      this.enabled = false;
      return false;
    }
  }

  get enabled_(): boolean { return this.enabled; }
  get halfTarget(): THREE.WebGLRenderTarget | null { return this.halfResTarget; }

  /** Render the composite. Call after the periphery has been rendered to
   *  `halfTarget` and the center has been rendered to the default target. */
  composite(renderer: THREE.WebGLRenderer, fullTarget: THREE.WebGLRenderTarget | null): void {
    if (!this.enabled || !this.compositeMaterial || !this.compositeMesh) return;
    this.compositeMaterial.uniforms.tFull.value = fullTarget?.texture ?? null;
    this.compositeMaterial.uniforms.tHalf.value = this.halfResTarget?.texture ?? null;
    // Render to screen.
    renderer.setRenderTarget(null);
    renderer.render(new THREE.Scene().add(this.compositeMesh), new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
  }

  dispose(): void {
    this.halfResTarget?.dispose();
    this.compositeMaterial?.dispose();
    this.compositeMesh?.geometry.dispose();
    this.halfResTarget = null;
    this.compositeMaterial = null;
    this.compositeMesh = null;
    this.enabled = false;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _vrs: VariableRateShadingManager | null = null;

export function getVRS(): VariableRateShadingManager {
  if (!_vrs) _vrs = new VariableRateShadingManager();
  return _vrs;
}

export function resetVRS(): void {
  _vrs?.dispose();
  _vrs = null;
}
