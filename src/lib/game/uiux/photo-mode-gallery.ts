/**
 * Section K — Photo Mode Gallery (prompt K_UI_UX_HUD-00010 et al.).
 * In-game photo mode: capture, filters, tagging, share.
 * Public API: `PhotoModeGallery`, `PhotoShot`, `PhotoFilter`.
 */

export type PhotoFilterId =
  | "none" | "cinematic" | "vintage" | "mono" | "vivid" | "noir";

export interface PhotoFilter {
  id: PhotoFilterId;
  label: string;
  cssFilter: string;
}

export const PHOTO_FILTERS: Record<PhotoFilterId, PhotoFilter> = {
  none: { id: "none", label: "Off", cssFilter: "none" },
  cinematic: { id: "cinematic", label: "Cinematic", cssFilter: "contrast(1.15) saturate(0.9) brightness(0.95)" },
  vintage: { id: "vintage", label: "Vintage", cssFilter: "sepia(0.45) contrast(0.95) brightness(1.05)" },
  mono: { id: "mono", label: "Mono", cssFilter: "grayscale(1) contrast(1.1)" },
  vivid: { id: "vivid", label: "Vivid", cssFilter: "saturate(1.4) contrast(1.05)" },
  noir: { id: "noir", label: "Noir", cssFilter: "grayscale(1) contrast(1.4) brightness(0.85)" },
};

export interface PhotoShot {
  id: string;
  capturedAt: string;
  scene: string;
  filter: PhotoFilterId;
  dataUrl: string;
  tags: string[];
}

const STORE_KEY = "pr_photo_gallery_v1";
export type Shared = { shared: true };

export class PhotoModeGallery {
  private shots: PhotoShot[] = [];
  private activeFilter: PhotoFilterId = "none";

  constructor(private readonly storage: Storage = localStorage) {
    this.load();
  }

  /** Capture the current frame from a canvas / video source. */
  capture(source: HTMLCanvasElement | HTMLVideoElement, scene: string): PhotoShot {
    const tmp = document.createElement("canvas");
    tmp.width = "videoWidth" in source ? source.videoWidth : source.width;
    tmp.height = "videoHeight" in source ? source.videoHeight : source.height;
    const ctx = tmp.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable for capture");
    ctx.filter = PHOTO_FILTERS[this.activeFilter].cssFilter;
    ctx.drawImage(source as CanvasImageSource, 0, 0);
    const shot: PhotoShot = {
      id: `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      capturedAt: new Date().toISOString(),
      scene, filter: this.activeFilter, dataUrl: tmp.toDataURL("image/png"), tags: [],
    };
    this.shots.unshift(shot);
    this.persist();
    return shot;
  }

  setFilter(id: PhotoFilterId): void { this.activeFilter = id; }

  applyFilter(shotId: string, id: PhotoFilterId): PhotoShot | undefined {
    const shot = this.shots.find((s) => s.id === shotId);
    if (!shot) return undefined;
    shot.filter = id;
    this.persist();
    return shot;
  }

  tag(shotId: string, tag: string): void {
    const shot = this.shots.find((s) => s.id === shotId);
    if (shot && !shot.tags.includes(tag)) shot.tags.push(tag);
    this.persist();
  }

  list(filter?: (s: PhotoShot) => boolean): PhotoShot[] {
    return filter ? this.shots.filter(filter) : [...this.shots];
  }

  delete(shotId: string): void {
    this.shots = this.shots.filter((s) => s.id !== shotId);
    this.persist();
  }

  async exportPng(shotId: string): Promise<Blob | undefined> {
    const shot = this.shots.find((s) => s.id === shotId);
    if (!shot) return undefined;
    const res = await fetch(shot.dataUrl);
    return res.blob();
  }

  /** Share via Web Share API; falls back to returning the Blob. */
  async share(shotId: string, title = "Project Reality Photo"): Promise<Shared | Blob | undefined> {
    const blob = await this.exportPng(shotId);
    if (!blob) return undefined;
    const file = new File([blob], `${shotId}.png`, { type: "image/png" });
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (nav && "share" in nav && "canShare" in nav) {
      try {
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title });
          return { shared: true };
        }
      } catch { /* user cancelled */ }
    }
    return blob;
  }

  private persist(): void {
    try { this.storage.setItem(STORE_KEY, JSON.stringify(this.shots.slice(0, 100))); }
    catch { /* quota — silently drop */ }
  }

  private load(): void {
    try {
      const raw = this.storage.getItem(STORE_KEY);
      if (raw) this.shots = JSON.parse(raw) as PhotoShot[];
    } catch { this.shots = []; }
  }
}
