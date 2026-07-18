/**
 * Section J / J_RealLife_Integration-00035 (sunrise/sunset → skybox):
 * Ambient Light Sensor API drives the in-game skybox brightness so the
 * player's real room lighting bleeds into the virtual world.
 *
 * The `AmbientLightSensor` Web API is part of the Generic Sensor API.
 * Chrome shipped it behind a flag for years; production availability
 * is still spotty (not on Firefox / Safari as of 2024). We feature-detect
 * and fall back to:
 *   1. `prefers-reduced-data` / time-of-day estimate (rough heuristic)
 *   2. A neutral mid-day brightness (0.85)
 *
 * The sensor reports `illuminance` in lux. We map lux → skybox multiplier:
 *   < 50 lux  (dim room)        → 0.45
 *   50–500    (indoor)          → 0.75
 *   500–5000  (bright indoor)   → 0.95
 *   > 5000    (outdoor daylight)→ 1.10
 * Values are smoothed with exponential decay to avoid flicker.
 */

type AmbientLightSensorLike = {
  illuminance: number;
  addEventListener: (type: "reading" | "error", cb: () => void) => void;
  start: () => void;
  stop: () => void;
};

type AmbientLightSensorCtor = new (opts?: { frequency?: number }) => AmbientLightSensorLike;

function getSensorCtor(): AmbientLightSensorCtor | null {
  if (typeof window === "undefined") return null;
  const g = window as unknown as { AmbientLightSensor?: AmbientLightSensorCtor };
  return g.AmbientLightSensor ?? null;
}

export interface AmbientReading {
  lux: number;
  source: "sensor" | "fallback-time" | "fallback-default";
  timestamp: number;
}

export class AmbientLightSensor {
  private sensor: AmbientLightSensorLike | null = null;
  private smoothedLux = 300;
  private lastReading: AmbientReading | null = null;
  private listeners = new Set<(r: AmbientReading) => void>();
  private frequency: number;

  constructor(frequency = 2) {
    this.frequency = frequency;
  }

  isSupported(): boolean {
    return getSensorCtor() !== null;
  }

  async start(): Promise<void> {
    const Ctor = getSensorCtor();
    if (!Ctor) {
      // Fallback: derive a synthetic lux from current wall-clock hour.
      this.emitFallback();
      return;
    }
    try {
      this.sensor = new Ctor({ frequency: this.frequency });
      this.sensor.addEventListener("reading", () => this.handleReading());
      this.sensor.addEventListener("error", () => this.emitFallback());
      this.sensor.start();
    } catch {
      this.emitFallback();
    }
  }

  stop(): void {
    try {
      this.sensor?.stop();
    } catch {
      /* ignore */
    }
    this.sensor = null;
  }

  onReading(cb: (r: AmbientReading) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getLastReading(): AmbientReading | null {
    return this.lastReading;
  }

  /** Map the smoothed lux to a skybox brightness multiplier. */
  getSkyboxBrightness(): number {
    const lux = this.smoothedLux;
    if (lux < 50) return 0.45;
    if (lux < 500) return 0.75;
    if (lux < 5000) return 0.95;
    return 1.1;
  }

  private handleReading(): void {
    const lux = this.sensor?.illuminance ?? this.smoothedLux;
    // exponential smoothing — tau ≈ 1s at 2Hz
    this.smoothedLux = this.smoothedLux * 0.7 + lux * 0.3;
    this.lastReading = { lux: this.smoothedLux, source: "sensor", timestamp: Date.now() };
    this.listeners.forEach((cb) => cb(this.lastReading!));
  }

  private emitFallback(): void {
    const hour = new Date().getHours();
    // Rough daylight curve: peak ~14:00, dark 22–05.
    const daylight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
    const lux = 10 + daylight * 4000;
    this.smoothedLux = lux;
    this.lastReading = {
      lux,
      source: hour >= 6 && hour <= 18 ? "fallback-time" : "fallback-default",
      timestamp: Date.now(),
    };
    this.listeners.forEach((cb) => cb(this.lastReading!));
  }
}
