/**
 * Section K — Replay Editor (kill-cam / demo scrubbing).
 * Non-linear timeline, slow-mo speeds, Catmull-Rom camera paths.
 * Public API: `ReplayEditor`, `ReplayFrame`, `CameraWaypoint`, `PlaybackState`.
 */

export interface ReplayFrame {
  t: number;
  camera: { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };
  events: string[];
}

export interface CameraWaypoint {
  t: number;
  position: [number, number, number];
  lookAt?: [number, number, number];
  fov?: number;
}

export interface PlaybackState {
  playing: boolean;
  cursor: number;
  speed: number;
  loop: boolean;
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof SPEEDS)[number];

export class ReplayEditor {
  private buffer: ReplayFrame[] = [];
  private state: PlaybackState = { playing: false, cursor: 0, speed: 1, loop: false };
  private waypoints: CameraWaypoint[] = [];
  private pathTimer: number | null = null;
  private listeners = new Set<(s: PlaybackState) => void>();

  load(frames: ReplayFrame[]): void {
    this.buffer = [...frames].sort((a, b) => a.t - b.t);
    this.state.cursor = 0;
    this.emit();
  }

  onState(cb: (s: PlaybackState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  play(): void { if (this.buffer.length) { this.state.playing = true; this.emit(); } }
  pause(): void { this.state.playing = false; this.emit(); }
  seek(t: number): void { this.state.cursor = Math.max(0, Math.min(this.duration(), t)); this.emit(); }
  setSpeed(speed: ReplaySpeed): void { this.state.speed = speed; this.emit(); }
  toggleLoop(): void { this.state.loop = !this.state.loop; this.emit(); }
  getState(): PlaybackState { return { ...this.state }; }

  tick(dt: number): ReplayFrame | undefined {
    if (!this.state.playing || !this.buffer.length) return this.currentFrame();
    const next = this.state.cursor + dt * this.state.speed;
    if (next >= this.duration()) {
      if (this.state.loop) this.state.cursor = 0;
      else { this.state.cursor = this.duration(); this.state.playing = false; }
    } else { this.state.cursor = next; }
    this.emit();
    return this.currentFrame();
  }

  currentFrame(): ReplayFrame | undefined {
    if (!this.buffer.length) return undefined;
    let best = this.buffer[0];
    for (const f of this.buffer) { if (f.t <= this.state.cursor) best = f; else break; }
    return best;
  }

  duration(): number { return this.buffer.length ? this.buffer[this.buffer.length - 1].t : 0; }

  // ---- Camera paths ----
  addWaypoint(wp: CameraWaypoint): void {
    this.waypoints.push(wp);
    this.waypoints.sort((a, b) => a.t - b.t);
  }
  removeWaypoint(index: number): void { this.waypoints.splice(index, 1); }
  listWaypoints(): CameraWaypoint[] { return [...this.waypoints]; }

  /** Catmull-Rom interpolation along waypoints. */
  sampleCameraPath(t: number): CameraWaypoint | undefined {
    const w = this.waypoints;
    if (w.length === 0) return undefined;
    if (w.length === 1) return w[0];
    let i = 0;
    while (i < w.length - 1 && w[i + 1].t < t) i++;
    const p0 = w[Math.max(0, i - 1)], p1 = w[i], p2 = w[Math.min(w.length - 1, i + 1)], p3 = w[Math.min(w.length - 1, i + 2)];
    const span = p2.t - p1.t || 1;
    const u = Math.max(0, Math.min(1, (t - p1.t) / span));
    const u2 = u * u, u3 = u2 * u;
    const cat = (a: number, b: number, c: number, d: number) =>
      0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (3 * b - 3 * c - a + d) * u3);
    return {
      t,
      position: [
        cat(p0.position[0], p1.position[0], p2.position[0], p3.position[0]),
        cat(p0.position[1], p1.position[1], p2.position[1], p3.position[1]),
        cat(p0.position[2], p1.position[2], p2.position[2], p3.position[2]),
      ],
      lookAt: p1.lookAt, fov: p1.fov,
    };
  }

  playCameraPath(realtimeSeconds: number, onUpdate: (wp: CameraWaypoint) => void): void {
    if (!this.waypoints.length) return;
    const total = this.waypoints[this.waypoints.length - 1].t;
    if (total <= 0) return;
    const start = performance.now();
    if (this.pathTimer !== null) cancelAnimationFrame(this.pathTimer);
    const step = () => {
      const elapsed = (performance.now() - start) / 1000;
      const t = (elapsed / realtimeSeconds) * total;
      const wp = this.sampleCameraPath(t);
      if (wp) onUpdate(wp);
      if (elapsed < realtimeSeconds) this.pathTimer = requestAnimationFrame(step);
      else this.pathTimer = null;
    };
    this.pathTimer = requestAnimationFrame(step);
  }

  stopCameraPath(): void {
    if (this.pathTimer !== null) { cancelAnimationFrame(this.pathTimer); this.pathTimer = null; }
  }

  private emit(): void {
    const snap = this.getState();
    this.listeners.forEach((cb) => cb(snap));
  }
}
