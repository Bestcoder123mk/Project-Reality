/**
 * Section J / J_RealLife_Integration-00015, 00034, 00040:
 * Heart-rate monitor via Web Bluetooth (BLE chest strap / wrist optical
 * sensor on the standard Heart Rate Service 0x180D) → in-game player
 * stamina / breathing / map biome weighting.
 *
 * HR Service exposes 0x2A37 Heart Rate Measurement (Notify) and 0x2A38
 * Body Sensor Location (optional). HR values drive an "exertion" score:
 * restHr (default 60) → 0, maxHr (default 190) → 1. Web Bluetooth is
 * Chrome/Edge-only; on unsupported browsers start() resolves false and
 * the StaminaSystem falls back to movement-derived exertion.
 */

export interface HeartRateReading {
  bpm: number;
  /** 0–1 instantaneous exertion, derived from HR zones. */
  exertion: number;
  /** Detected contact status (sensor reports skin contact). */
  contact: boolean;
  /** Energy expended in kcal since session start (approx). */
  energyKcal: number;
  timestamp: number;
}

export interface HeartRateConfig {
  restHr: number;
  maxHr: number;
  weightKg: number;
}

const DEFAULT_CONFIG: HeartRateConfig = { restHr: 60, maxHr: 190, weightKg: 75 };
const HR_SERVICE_UUID = 0x180d;
const HR_MEASUREMENT_UUID = 0x2a37;

type BluetoothRemoteGATTCharacteristicLike = {
  startNotifications: () => Promise<unknown>;
  addEventListener: (type: "characteristicvaluechanged", cb: (e: Event) => void) => void;
  value?: DataView;
};

type BluetoothDeviceLike = {
  gatt?: {
    connect: () => Promise<unknown>;
    getPrimaryService: (uuid: number | string) => Promise<{
      getCharacteristic: (uuid: number | string) => Promise<BluetoothRemoteGATTCharacteristicLike>;
    }>;
  };
  addEventListener: (type: "gattserverdisconnected", cb: () => void) => void;
};

type BluetoothLike = {
  requestDevice: (opts: {
    filters: Array<{ services: Array<number | string> }>;
  }) => Promise<BluetoothDeviceLike>;
};

function getBluetooth(): BluetoothLike | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as unknown as { bluetooth?: BluetoothLike };
  return nav.bluetooth ?? null;
}

export class HeartRateMonitor {
  private device: BluetoothDeviceLike | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristicLike | null = null;
  private config: HeartRateConfig;
  private energyKcal = 0;
  private lastTs = 0;
  private current: HeartRateReading | null = null;
  private listeners = new Set<(r: HeartRateReading) => void>();
  private disconnectListeners = new Set<() => void>();

  constructor(config: Partial<HeartRateConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static isSupported(): boolean {
    return getBluetooth() !== null;
  }

  setConfig(config: Partial<HeartRateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async start(): Promise<boolean> {
    const bt = getBluetooth();
    if (!bt) return false;
    try {
      this.device = await bt.requestDevice({ filters: [{ services: [HR_SERVICE_UUID] }] });
      this.device.addEventListener("gattserverdisconnected",
        () => this.disconnectListeners.forEach((cb) => cb()));
      if (!this.device.gatt) return false;
      await this.device.gatt.connect();
      const service = await this.device.gatt.getPrimaryService(HR_SERVICE_UUID);
      this.characteristic = await service.getCharacteristic(HR_MEASUREMENT_UUID);
      this.characteristic.addEventListener("characteristicvaluechanged", this.onReading);
      await this.characteristic.startNotifications();
      return true;
    } catch {
      this.stop();
      return false;
    }
  }

  stop(): void {
    this.characteristic = null;
    this.device = null;
  }

  onReading(cb: (r: HeartRateReading) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onDisconnect(cb: () => void): () => void {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }
  getCurrent(): HeartRateReading | null {
    return this.current;
  }

  private onReading = (e: Event): void => {
    const target = e.target as BluetoothRemoteGATTCharacteristicLike;
    const dv = target.value;
    if (!dv || dv.byteLength < 2) return;
    const flags = dv.getUint8(0);
    const is16Bit = (flags & 0x01) !== 0;
    const sensorContact = (flags & 0x04) !== 0;
    const bpm = is16Bit ? dv.getUint16(1, true) : dv.getUint8(1);
    const exertion = this.computeExertion(bpm);
    const now = Date.now();
    if (this.lastTs > 0) {
      const hrs = (now - this.lastTs) / 3_600_000;
      const met = 1 + exertion * 9; // MET scales with exertion (VO2 proxy)
      this.energyKcal += met * this.config.weightKg * hrs * 0.063;
    }
    this.lastTs = now;
    this.current = { bpm, exertion, contact: sensorContact,
      energyKcal: this.energyKcal, timestamp: now };
    this.listeners.forEach((cb) => cb(this.current!));
  };

  private computeExertion(bpm: number): number {
    const { restHr, maxHr } = this.config;
    if (bpm <= restHr) return 0;
    if (bpm >= maxHr) return 1;
    return (bpm - restHr) / (maxHr - restHr);
  }
}