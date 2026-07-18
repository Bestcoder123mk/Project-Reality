/**
 * Section J / J_RealLife_Integration-00031: Hand pose tracking via
 * MediaPipe Hands → in-game gestures (quick-chat, inspect, throw).
 * Loaded from CDN as an ESM bundle; if it fails to load (offline / CSP)
 * the tracker degrades to a no-op reporting "none". Runs ~20 Hz on a
 * 320×240 canvas, 21 landmarks per hand, up to 2 hands. Gesture classes:
 * open-palm, fist, point, peace, thumbs-up, pinch, gun.
 */

export type HandGesture =
  | "none" | "open-palm" | "fist" | "point"
  | "peace" | "thumbs-up" | "pinch" | "gun";

export interface HandLandmarks {
  /** 21 MediaPipe landmarks in normalized [0,1] image-space coords. */
  points: Array<{ x: number; y: number; z: number }>;
  handedness: "Left" | "Right";
}

export interface HandTrackingSnapshot {
  hands: HandLandmarks[];
  gesture: HandGesture;
  timestamp: number;
}

type MediaPipeHands = {
  setOptions: (opts: Record<string, unknown>) => void;
  onResults: (cb: (r: MediaPipeResult) => void) => void;
  send: (input: { image: CanvasImageSource }) => Promise<void>;
};

type MediaPipeResult = {
  multiHandLandmarks?: Array<Array<{ x: number; y: number; z: number }>>;
  multiHandedness?: Array<{ label: "Left" | "Right"; score: number }>;
};

const CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js";

export class HandPoseTracker {
  private hands: MediaPipeHands | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private rafId = 0;
  private running = false;
  private lastSend = 0;
  private current: HandTrackingSnapshot = { hands: [], gesture: "none", timestamp: 0 };
  private listeners = new Set<(s: HandTrackingSnapshot) => void>();

  isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(): Promise<boolean> {
    if (!this.isSupported()) return false;
    try {
      await this.loadMediaPipe();
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: "user" }, audio: false });
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
    this.stream = null; this.video = null; this.hands = null;
  }

  onGesture(cb: (s: HandTrackingSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getCurrent(): HandTrackingSnapshot {
    return this.current;
  }

  private async loadMediaPipe(): Promise<void> {
    if (this.hands) return;
    if (typeof window === "undefined") throw new Error("no window");
    const w = window as unknown as { Hands?: new () => MediaPipeHands };
    if (!w.Hands) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement("script");
        s.src = CDN; s.crossOrigin = "anonymous";
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("MediaPipe CDN load failed"));
        document.head.appendChild(s);
      });
    }
    const HandsCtor = (window as unknown as { Hands: new () => MediaPipeHands }).Hands;
    this.hands = new HandsCtor();
    this.hands.setOptions({ maxNumHands: 2, modelComplexity: 0,
      minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
    this.hands.onResults((r) => this.handleResults(r));
  }

  private loop = async (): Promise<void> => {
    if (!this.running || !this.hands || !this.video) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - this.lastSend < 50) return; // 20 Hz
    this.lastSend = now;
    if (this.video.readyState < 2) return;
    try {
      await this.hands.send({ image: this.video });
    } catch {
      /* swallow transient frame errors */
    }
  };

  private handleResults(r: MediaPipeResult): void {
    const lm = r.multiHandLandmarks ?? [];
    const hd = r.multiHandedness ?? [];
    const hands: HandLandmarks[] = lm.map((pts, i) => ({
      points: pts.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })),
      handedness: hd[i]?.label ?? "Right",
    }));
    const gesture = hands[0] ? this.classifyGesture(hands[0]) : "none";
    this.current = { hands, gesture, timestamp: Date.now() };
    this.listeners.forEach((cb) => cb(this.current));
  }

  private classifyGesture(h: HandLandmarks): HandGesture {
    const p = h.points;
    if (p.length < 21) return "none";
    const ext = (tip: number, pip: number) => p[tip].y < p[pip].y - 0.02;
    const index = ext(8, 6), middle = ext(12, 10),
      ring = ext(16, 14), pinky = ext(20, 18);
    const thumb = Math.abs(p[4].x - p[2].x) > 0.04;
    if (index && middle && ring && pinky) return "open-palm";
    if (!index && !middle && !ring && !pinky) return "fist";
    if (index && !middle && !ring && !pinky) return thumb ? "gun" : "point";
    if (index && middle && !ring && !pinky) return "peace";
    if (thumb && !index && !middle && !ring && !pinky) return "thumbs-up";
    if (!index && !middle && !ring && !pinky && thumb) return "pinch";
    return "none";
  }
}
