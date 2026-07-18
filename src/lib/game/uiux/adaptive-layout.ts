/**
 * Section K — Adaptive HUD Layout (foldable / Steam Deck / ultrawide).
 * Picks a HUD layout preset from viewport + device hints; emits a
 * descriptor React HUD clusters subscribe to.
 * Public API: `AdaptiveLayoutManager`, `detectLayoutPreset()`, `HudLayout`.
 */

export type LayoutPreset =
  | "mobile-portrait" | "mobile-landscape" | "tablet" | "foldable"
  | "steamdeck" | "desktop-16-9" | "ultrawide" | "4k";

export interface HudLayout {
  preset: LayoutPreset;
  viewport: { w: number; h: number; dpr: number; aspect: number };
  scale: number;
  fontScale: number;
  clusters: {
    minimap: { x: number; y: number; w: number; h: number };
    killFeed: { x: number; y: number };
    weaponStrip: { x: number; y: number };
    ammoCounter: { x: number; y: number };
    compass: { x: number; y: number };
  };
  touch: boolean;
  safeArea: { top: number; bottom: number; left: number; right: number };
}

export function detectLayoutPreset(
  w: number, h: number, hints: { touch?: boolean; foldable?: boolean } = {},
): LayoutPreset {
  const aspect = w / h;
  if (hints.foldable) return "foldable";
  if (w < 700 && h > w) return "mobile-portrait";
  if (w < 900) return "mobile-landscape";
  if (w <= 1280 && aspect > 1.3 && aspect < 1.9 && hints.touch) return "steamdeck";
  if (aspect >= 2.2) return "ultrawide";
  if (w >= 3440) return "4k";
  if (w >= 1600) return "desktop-16-9";
  return "tablet";
}

function buildLayout(preset: LayoutPreset, w: number, h: number, dpr: number): HudLayout {
  const aspect = w / h;
  const touch = preset.startsWith("mobile") || preset === "tablet" || preset === "foldable";
  const safe = preset.startsWith("mobile")
    ? { top: 6, bottom: 6, left: 4, right: 4 }
    : { top: 1, bottom: 1, left: 1, right: 1 };
  const base: HudLayout = {
    preset, viewport: { w, h, dpr, aspect }, scale: 1, fontScale: 1,
    clusters: {
      minimap: { x: 70, y: 4, w: 26, h: 32 }, killFeed: { x: 70, y: 38 },
      weaponStrip: { x: 2, y: 88 }, ammoCounter: { x: 92, y: 88 }, compass: { x: 30, y: 4 },
    },
    touch, safeArea: safe,
  };
  switch (preset) {
    case "mobile-portrait":
      return { ...base, scale: 0.85, fontScale: 0.9, clusters: { ...base.clusters, minimap: { x: 70, y: 30, w: 28, h: 24 } } };
    case "mobile-landscape":
      return { ...base, scale: 0.8, fontScale: 0.85, clusters: { ...base.clusters, minimap: { x: 78, y: 4, w: 20, h: 28 } } };
    case "tablet": return { ...base, scale: 1.05, fontScale: 1.05 };
    case "foldable":
      return { ...base, scale: 0.95, fontScale: 0.95, clusters: { ...base.clusters, minimap: { x: 80, y: 4, w: 18, h: 24 } } };
    case "steamdeck": return { ...base, scale: 0.9, fontScale: 0.95 };
    case "ultrawide":
      return { ...base, scale: 1.1, clusters: { ...base.clusters, minimap: { x: 82, y: 4, w: 16, h: 24 } } };
    case "4k": return { ...base, scale: 1.35, fontScale: 1.3 };
    default: return base;
  }
}

export class AdaptiveLayoutManager {
  private current: HudLayout | null = null;
  private listeners = new Set<(l: HudLayout) => void>();
  private ro: ResizeObserver | null = null;
  private mq: MediaQueryList | null = null;

  start(root: HTMLElement = document.body): void {
    this.recompute();
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.recompute());
      this.ro.observe(root);
    }
    if (typeof matchMedia !== "undefined") {
      this.mq = matchMedia("(orientation: portrait), (spanning: single-fold-vertical)");
      this.mq.addEventListener("change", () => this.recompute());
    }
    if (typeof window !== "undefined") window.addEventListener("resize", this.recompute);
  }

  stop(): void {
    this.ro?.disconnect(); this.ro = null;
    this.mq?.removeEventListener("change", this.recompute); this.mq = null;
    if (typeof window !== "undefined") window.removeEventListener("resize", this.recompute);
  }

  getLayout(): HudLayout | null { return this.current; }

  subscribe(cb: (l: HudLayout) => void): () => void {
    this.listeners.add(cb);
    if (this.current) cb(this.current);
    return () => this.listeners.delete(cb);
  }

  private recompute = (): void => {
    const w = typeof window !== "undefined" ? window.innerWidth : 1920;
    const h = typeof window !== "undefined" ? window.innerHeight : 1080;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const foldable = typeof matchMedia !== "undefined" && matchMedia("(spanning: single-fold-vertical)").matches;
    const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
    const next = buildLayout(detectLayoutPreset(w, h, { touch, foldable }), w, h, dpr);
    this.current = next;
    this.listeners.forEach((cb) => cb(next));
  };
}
