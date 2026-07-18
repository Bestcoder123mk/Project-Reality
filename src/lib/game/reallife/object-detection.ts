/**
 * Section J / J_RealLife_Integration-00013, 00028:
 * WebNN on-device object detection → environment props / biome hints.
 * The player points their camera at the real world; detected objects
 * (tree, car, building, person, dog) bias map prop selection so the
 * virtual environment mirrors their physical surroundings.
 *
 * WebNN (`navigator.ml`) ships in Chromium behind the `webnn` flag.
 * We feature-detect and fall back to a TF.js variant; if both fail,
 * `detect()` resolves to an empty array — callers treat "no detection"
 * as "no preference". The detector is model-agnostic: callers supply a
 * `ModelLoader` so production can swap in a hosted `.tflite`.
 */

export type DetectedObjectType =
  | "person" | "vehicle" | "building" | "tree"
  | "animal" | "sky" | "water" | "road" | "unknown";

export interface DetectedObject {
  type: DetectedObjectType;
  score: number; // 0–1
  bbox: { x: number; y: number; w: number; h: number }; // normalized [0,1]
}

export interface DetectionSnapshot {
  objects: DetectedObject[];
  dominantType: DetectedObjectType | null;
  timestamp: number;
}

export type ModelLoader = () => Promise<DetectionModel>;

export interface DetectionModel {
  detect: (input: CanvasImageSource) => Promise<DetectedObject[]>;
  dispose?: () => void;
}

/** Coarse mapping from COCO-91 class IDs → our 9 canonical types. */
const COCO_MAP: Record<number, DetectedObjectType> = {
  1: "person", 3: "vehicle", 4: "vehicle", 6: "vehicle", 8: "vehicle",
  17: "animal", 18: "animal", 19: "animal", 20: "animal",
};

export class ObjectDetector {
  private model: DetectionModel | null = null;
  private loader: ModelLoader | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private rafId = 0;
  private running = false;
  private lastDetect = 0;
  private listeners = new Set<(s: DetectionSnapshot) => void>();
  private current: DetectionSnapshot = { objects: [], dominantType: null, timestamp: 0 };

  static webnnSupported(): boolean {
    if (typeof navigator === "undefined") return false;
    const nav = navigator as unknown as { ml?: unknown };
    return nav.ml !== undefined;
  }

  isReady(): boolean {
    return this.model !== null;
  }

  /** Inject a model loader (WebNN, TF.js, or remote inference client). */
  setModelLoader(loader: ModelLoader): void {
    this.loader = loader;
  }

  async start(cameraFacing: "user" | "environment" = "environment"): Promise<boolean> {
    if (!this.loader) return false;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      this.model = await this.loader();
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: cameraFacing }, audio: false });
      this.video = document.createElement("video");
      this.video.srcObject = this.stream;
      this.video.muted = true;
      await this.video.play();
      this.running = true;
      this.loop();
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    try { this.model?.dispose?.(); } catch { /* ignore */ }
    this.model = null;
  }

  onSnapshot(cb: (s: DetectionSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getCurrent(): DetectionSnapshot {
    return this.current;
  }

  private loop = async (): Promise<void> => {
    if (!this.running || !this.model || !this.video) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - this.lastDetect < 200) return; // 5 Hz
    this.lastDetect = now;
    if (this.video.readyState < 2) return;
    try {
      const objects = await this.model.detect(this.video);
      this.current = this.toSnapshot(objects);
      this.listeners.forEach((cb) => cb(this.current));
    } catch {
      /* swallow transient inference errors */
    }
  };

  private toSnapshot(objects: DetectedObject[]): DetectionSnapshot {
    if (objects.length === 0) {
      return { objects: [], dominantType: null, timestamp: Date.now() };
    }
    const counts = new Map<DetectedObjectType, number>();
    let dominant: DetectedObjectType = "unknown";
    let max = 0;
    for (const o of objects) {
      const t = o.type;
      const n = (counts.get(t) ?? 0) + 1;
      counts.set(t, n);
      if (n > max) {
        max = n;
        dominant = t;
      }
    }
    return { objects, dominantType: dominant, timestamp: Date.now() };
  }

  /** Helper for COCO-style models that emit raw class IDs. */
  static mapCocoClass(classId: number): DetectedObjectType {
    return COCO_MAP[classId] ?? "unknown";
  }
}
