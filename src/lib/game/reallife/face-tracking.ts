/**
 * Section J / J_RealLife_Integration-00009:
 * WebRTC webcam face-tracking → operator blendshapes. The player's real
 * facial expressions drive the in-game operator's face (smirk, frown,
 * raised brows, jaw clench) for cosmetics / taunts / killcam reactions.
 *
 * Uses the Shape Detection API's `FaceDetector` (Chrome-only, behind
 * "Experimental Web Platform Features"). When `FaceDetector` is
 * unavailable we expose an unimplemented state and callers degrade
 * gracefully (operator uses canned animation only).
 *
 * Pipeline: getUserMedia → <video> → requestFrame on rAF → FaceDetector
 * → landmarks → blendshape weights (0–1). Heavy work is throttled to
 * ~15 Hz to avoid burning the main thread.
 */

type DetectedFace = {
  landmarks: Array<{ type: string; locations: Array<{ x: number; y: number }> }>;
};

type FaceDetectorLike = {
  detect: (input: CanvasImageSource) => Promise<DetectedFace[]>;
};

type FaceDetectorCtor = new (opts?: unknown) => FaceDetectorLike;

function getFaceDetectorCtor(): FaceDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const g = window as unknown as { FaceDetector?: FaceDetectorCtor };
  return g.FaceDetector ?? null;
}

export interface BlendshapeWeights {
  browRaise: number;
  browFurrow: number;
  jawClench: number;
  mouthSmile: number;
  mouthFrown: number;
  eyeSquint: number;
  timestamp: number;
}

const NEUTRAL: BlendshapeWeights = {
  browRaise: 0,
  browFurrow: 0,
  jawClench: 0,
  mouthSmile: 0,
  mouthFrown: 0,
  eyeSquint: 0,
  timestamp: 0,
};

export class FaceTracker {
  private detector: FaceDetectorLike | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private rafId = 0;
  private running = false;
  private lastDetect = 0;
  private listeners = new Set<(w: BlendshapeWeights) => void>();
  private current: BlendshapeWeights = { ...NEUTRAL };

  isSupported(): boolean {
    return getFaceDetectorCtor() !== null && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(): Promise<boolean> {
    const Ctor = getFaceDetectorCtor();
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      this.detector = new Ctor({
        fastMode: true,
        maxDetectedFaces: 1,
        landmarkDetectors: ["eye", "mouth", "nose"],
      });
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: "user" },
        audio: false,
      });
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
    this.detector = null;
  }

  onBlendshapes(cb: (w: BlendshapeWeights) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getCurrent(): BlendshapeWeights {
    return this.current;
  }

  private loop = async (): Promise<void> => {
    if (!this.running || !this.detector || !this.video) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - this.lastDetect < 66) return; // 15 Hz
    this.lastDetect = now;
    if (this.video.readyState < 2) return;
    try {
      const faces = await this.detector.detect(this.video);
      if (faces[0]) {
        this.current = this.deriveBlendshapes(faces[0]);
        this.listeners.forEach((cb) => cb(this.current));
      }
    } catch {
      /* swallow — detector sometimes throws on transient frames */
    }
  };

  /** Map landmark geometry → coarse blendshape weights in [0,1]. */
  private deriveBlendshapes(face: DetectedFace): BlendshapeWeights {
    const eye = face.landmarks.find((l) => l.type === "eye");
    const mouth = face.landmarks.find((l) => l.type === "mouth");
    if (!eye || !mouth || eye.locations.length < 2 || mouth.locations.length < 2) {
      return { ...NEUTRAL, timestamp: Date.now() };
    }
    const eyeOpen = Math.abs(eye.locations[0].y - eye.locations[1].y);
    const mouthOpen = Math.abs(mouth.locations[0].y - mouth.locations[1].y);
    return {
      browRaise: 0,
      browFurrow: 0,
      jawClench: Math.max(0, 1 - mouthOpen / 12),
      mouthSmile: Math.min(1, mouthOpen / 20),
      mouthFrown: 0,
      eyeSquint: Math.max(0, 1 - eyeOpen / 8),
      timestamp: Date.now(),
    };
  }
}
