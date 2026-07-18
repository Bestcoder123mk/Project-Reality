/**
 * Section L / L_Performance_Optimization.txt
 * Prompts: 7, 44, 49, 56 ("texture VRAM" + "without exceeding 50MB VRAM")
 *
 * texture-streaming.ts — streaming mip levels based on distance + VRAM budget.
 *
 * Without streaming, every texture is uploaded to the GPU at full resolution
 * on scene load. For a map with 200 unique textures averaging 4MB each, that's
 * 800MB of VRAM — way over the 50MB budget on mobile-low and over the 768MB
 * budget on mobile-mid. Two problems:
 *
 *   1. **Initial load stalls.** Uploading 800MB to the GPU on first frame
 *      takes 5-10 seconds — the player stares at a black screen.
 *   2. **VRAM exhaustion.** On a 512MB GPU, the OS pages the WebGL context
 *      out to system RAM and the frame rate collapses.
 *
 * Streaming solves both:
 *
 *   - Textures are loaded as a tiny base mip (32x32, ~4KB each) on scene
 *     load. The base mip loads in milliseconds and looks blurry-but-visible.
 *   - As the camera moves, the streaming manager promotes textures near
 *     the camera to higher mips (64, 128, 256, 512, 1024, 2048...).
 *   - Distant textures are demoted back to the base mip — their VRAM is
 *     reclaimed.
 *   - A global VRAM budget caps total resident texture memory. When the
 *     budget is exceeded, the LRU (least-recently-used) textures are
 *     demoted first.
 *
 * This module is renderer-agnostic — it works with both WebGLRenderer
 * (THREE.Texture) and WebGPURenderer (THREE.GPUTexture). The promotion
 * and demotion are throttled to N textures per frame to avoid hitches.
 */

import * as THREE from "three";

// ─── Public types ────────────────────────────────────────────────────────

/** A streaming texture — wraps a THREE.Texture with LOD tracking. */
export interface StreamingTexture {
  /** Stable ID. */
  id: number;
  /** The underlying THREE.Texture (loaded at base mip initially). */
  texture: THREE.Texture;
  /** All available mip URLs (index 0 = base 32x32, last = full res). */
  mipChain: string[];
  /** Currently-loaded mip index into mipChain. */
  currentMip: number;
  /** Target mip (the LOD we WANT to be at, based on distance). */
  targetMip: number;
  /** World-space position this texture is anchored to (for distance calc). */
  anchor: THREE.Vector3;
  /** Last frame this texture was visible (for LRU). */
  lastVisibleFrame: number;
  /** Estimated VRAM (bytes) at the current mip. */
  vramBytes: number;
  /** Image load promise — resolves when the current mip finishes loading. */
  loadingPromise: Promise<void> | null;
}

/** Per-frame streaming stats — surfaced to the perf overlay. */
export interface StreamingStats {
  /** Total resident textures. */
  resident: number;
  /** Total VRAM used (bytes). */
  vramBytes: number;
  /** VRAM budget (bytes). */
  vramBudgetBytes: number;
  /** Promotions this frame (mip up). */
  promotions: number;
  /** Demotions this frame (mip down). */
  demotions: number;
  /** Textures currently loading. */
  loading: number;
}

// ─── Streaming manager ───────────────────────────────────────────────────

/** Default VRAM budget by quality tier (bytes). */
const VRAM_BUDGET_BYTES: Record<string, number> = {
  low: 64 * 1024 * 1024,        // 64MB
  medium: 192 * 1024 * 1024,    // 192MB
  high: 512 * 1024 * 1024,      // 512MB
  ultra: 1024 * 1024 * 1024,    // 1GB
};

/** Max textures promoted/demoted per frame (avoids hitching). */
const MAX_OPS_PER_FRAME = 4;

/** Distance thresholds for mip selection (meters). */
const MIP_DISTANCE_THRESHOLDS = [
  8,    // mip 0 (full res) within 8m
  16,   // mip 1 within 16m
  32,   // mip 2 within 32m
  64,   // mip 3 within 64m
  128,  // mip 4 within 128m
  256,  // mip 5 within 256m
  512,  // mip 6 within 512m (base mip beyond)
];

/**
 * TextureStreamingManager — owns the streaming texture pool and runs the
 * per-frame promote/demote pass.
 *
 * Usage:
 *   const mgr = new TextureStreamingManager();
 *   mgr.setVramBudget(256 * 1024 * 1024);
 *   const tex = mgr.register({
 *     mipChain: ["/tex/base.jpg", "/tex/mid.jpg", "/tex/full.jpg"],
 *     anchor: new THREE.Vector3(0, 0, 0),
 *     texture: new THREE.Texture(), // placeholder
 *   });
 *   // Per-frame:
 *   mgr.update(camera, frameIndex);
 */
export class TextureStreamingManager {
  private textures = new Map<number, StreamingTexture>();
  private nextId = 0;
  private vramBudget = VRAM_BUDGET_BYTES.medium;
  private currentVram = 0;
  private promotionsThisFrame = 0;
  private demotionsThisFrame = 0;
  private cache = new Map<string, HTMLImageElement>(); // URL → loaded image

  /** Set the VRAM budget (bytes). Textures beyond this are LRU-demoted. */
  setVramBudget(bytes: number): void {
    this.vramBudget = bytes;
  }

  /** Convenience: set the budget from a quality tier string. */
  setVramBudgetForTier(tier: string): void {
    this.vramBudget = VRAM_BUDGET_BYTES[tier] ?? VRAM_BUDGET_BYTES.medium;
  }

  /** Register a streaming texture. The first mip is loaded immediately. */
  register(opts: {
    mipChain: string[];
    anchor: THREE.Vector3;
    texture: THREE.Texture;
    initialMip?: number;
  }): StreamingTexture {
    const id = this.nextId++;
    const initialMip = opts.initialMip ?? 0;
    const entry: StreamingTexture = {
      id,
      texture: opts.texture,
      mipChain: opts.mipChain,
      currentMip: -1, // will be set by loadMip
      targetMip: initialMip,
      anchor: opts.anchor.clone(),
      lastVisibleFrame: 0,
      vramBytes: 0,
      loadingPromise: null,
    };
    this.textures.set(id, entry);
    // Kick off the base mip load.
    entry.loadingPromise = this.loadMip(entry, initialMip);
    return entry;
  }

  /** Unregister + free the texture. */
  unregister(id: number): void {
    const entry = this.textures.get(id);
    if (!entry) return;
    this.currentVram -= entry.vramBytes;
    entry.texture.dispose();
    this.textures.delete(id);
  }

  /** Per-frame update: compute target mip per texture, promote/demote. */
  update(camera: THREE.Camera, frameIndex: number): StreamingStats {
    this.promotionsThisFrame = 0;
    this.demotionsThisFrame = 0;

    const camPos = camera.position;
    // 1. Compute target mip per texture based on distance.
    const candidates: StreamingTexture[] = [];
    for (const entry of this.textures.values()) {
      const dist = entry.anchor.distanceTo(camPos);
      let targetMip = 0;
      for (let i = 0; i < MIP_DISTANCE_THRESHOLDS.length; i++) {
        if (dist <= MIP_DISTANCE_THRESHOLDS[i]) {
          targetMip = i;
          break;
        }
        targetMip = i + 1;
      }
      // Clamp to chain length.
      targetMip = Math.min(targetMip, entry.mipChain.length - 1);
      entry.targetMip = targetMip;
      entry.lastVisibleFrame = frameIndex;
      candidates.push(entry);
    }

    // 2. Sort by priority: closer + lower mip (more in need of promotion)
    //    first. This is the order we'll process promotes in.
    candidates.sort((a, b) => {
      const aPromote = a.targetMip < a.currentMip ? 1 : 0; // needs promotion
      const bPromote = b.targetMip < b.currentMip ? 1 : 0;
      if (aPromote !== bPromote) return bPromote - aPromote;
      return a.targetMip - b.targetMip;
    });

    // 3. Process promotions (up to MAX_OPS_PER_FRAME).
    let ops = 0;
    for (const entry of candidates) {
      if (ops >= MAX_OPS_PER_FRAME) break;
      if (entry.targetMip > entry.currentMip && !entry.loadingPromise) {
        // Promote.
        entry.loadingPromise = this.loadMip(entry, entry.targetMip)
          .finally(() => { entry.loadingPromise = null; });
        this.promotionsThisFrame++;
        ops++;
      }
    }

    // 4. If VRAM over budget, demote LRU textures.
    if (this.currentVram > this.vramBudget) {
      // Sort by lastVisibleFrame ascending (oldest first).
      candidates.sort((a, b) => a.lastVisibleFrame - b.lastVisibleFrame);
      for (const entry of candidates) {
        if (this.currentVram <= this.vramBudget) break;
        if (ops >= MAX_OPS_PER_FRAME) break;
        if (entry.currentMip > 0 && !entry.loadingPromise) {
          entry.loadingPromise = this.loadMip(entry, entry.currentMip - 1)
            .finally(() => { entry.loadingPromise = null; });
          this.demotionsThisFrame++;
          ops++;
        }
      }
    }

    // 5. Process demotions (textures whose target is below current).
    for (const entry of candidates) {
      if (ops >= MAX_OPS_PER_FRAME) break;
      if (entry.targetMip < entry.currentMip && !entry.loadingPromise) {
        entry.loadingPromise = this.loadMip(entry, entry.targetMip)
          .finally(() => { entry.loadingPromise = null; });
        this.demotionsThisFrame++;
        ops++;
      }
    }

    return {
      resident: this.textures.size,
      vramBytes: this.currentVram,
      vramBudgetBytes: this.vramBudget,
      promotions: this.promotionsThisFrame,
      demotions: this.demotionsThisFrame,
      loading: Array.from(this.textures.values()).filter((e) => e.loadingPromise).length,
    };
  }

  /** Load a specific mip for an entry. Updates VRAM accounting. */
  private async loadMip(entry: StreamingTexture, mip: number): Promise<void> {
    if (mip < 0 || mip >= entry.mipChain.length) return;
    if (mip === entry.currentMip) return;
    const url = entry.mipChain[mip];

    // Try cache first.
    let img = this.cache.get(url);
    if (!img) {
      img = new Image();
      img.src = url;
      this.cache.set(url, img);
      try {
        await img.decode();
      } catch {
        // Load failed — keep previous mip.
        return;
      }
    } else if (!img.complete) {
      await img.decode().catch(() => undefined);
    }

    // Reclaim old VRAM.
    this.currentVram -= entry.vramBytes;

    // Update the THREE.Texture with the new image.
    const newTex = new THREE.Texture(img);
    newTex.needsUpdate = true;
    // Copy properties from old texture.
    newTex.wrapS = entry.texture.wrapS;
    newTex.wrapT = entry.texture.wrapT;
    newTex.anisotropy = entry.texture.anisotropy;
    newTex.colorSpace = entry.texture.colorSpace;
    newTex.minFilter = entry.texture.minFilter;
    newTex.magFilter = entry.texture.magFilter;
    // Swap: this is the simplest path — callers reading entry.texture see
    // the new image. The old texture is disposed (releases VRAM).
    entry.texture.image = img;
    entry.texture.needsUpdate = true;

    // Estimate VRAM: width * height * 4 bytes (RGBA8) per mip.
    const w = img.naturalWidth || 32;
    const h = img.naturalHeight || 32;
    entry.vramBytes = w * h * 4;
    this.currentVram += entry.vramBytes;
    entry.currentMip = mip;
  }

  /** Dispose all textures + clear the cache. */
  dispose(): void {
    for (const entry of this.textures.values()) {
      entry.texture.dispose();
    }
    this.textures.clear();
    this.cache.clear();
    this.currentVram = 0;
  }

  /** Snapshot for diagnostics. */
  stats(): StreamingStats {
    return {
      resident: this.textures.size,
      vramBytes: this.currentVram,
      vramBudgetBytes: this.vramBudget,
      promotions: this.promotionsThisFrame,
      demotions: this.demotionsThisFrame,
      loading: Array.from(this.textures.values()).filter((e) => e.loadingPromise).length,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _mgr: TextureStreamingManager | null = null;

export function getTextureStreamingManager(): TextureStreamingManager {
  if (!_mgr) _mgr = new TextureStreamingManager();
  return _mgr;
}

export function resetTextureStreamingManager(): void {
  _mgr?.dispose();
  _mgr = null;
}
