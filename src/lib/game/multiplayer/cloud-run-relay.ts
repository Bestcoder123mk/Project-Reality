/**
 * G_Multiplayer_Netcode-00005 / 00038 / 00009: Cloud Run WebSocket relay.
 *
 * Cloud Run (2nd gen) supports WebSocket upgrades. Client SDK that resolves
 * the closest regional endpoint, opens an authenticated WebSocket to the
 * relay, reconnects with exponential backoff, heartbeats every 5s, and
 * applies backpressure (drops non-critical packets once `bufferedAmount`
 * exceeds `maxBufferedBytes`).
 */

export type Region = "us-central1" | "us-east1" | "europe-west1" | "asia-east1";
export type PacketPriority = "critical" | "normal";

export interface RelayConfig {
  /** Base Cloud Run URL, e.g. https://relay-abc-xyz.a.run.app */
  baseUrl: string;
  region?: Region;
  /** Firebase ID token; sent as WebSocket subprotocol `bearer.<token>`. */
  authToken: string;
  /** Match id — the relay routes packets by this. */
  sessionId: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatMs?: number;
  /** Drop normal-priority packets above this bufferedAmount. Default 256 KB. */
  maxBufferedBytes?: number;
}

export interface RelayPacket { seq: number; priority: PacketPriority; payload: ArrayBuffer | string; }
export interface RelayStats {
  connected: boolean; region: Region | null; rttMs: number;
  reconnects: number; droppedPackets: number; bufferedBytes: number;
}

type Listener = (packet: RelayPacket) => void;

export class CloudRunRelay {
  private cfg: Required<Omit<RelayConfig, "region">> & { region?: Region };
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statsListeners = new Set<(s: RelayStats) => void>();
  private seq = 0;
  private reconnects = 0;
  private droppedPackets = 0;
  private lastPingAt = 0;
  private rttMs = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(cfg: RelayConfig) {
    this.cfg = { reconnectBaseMs: 1000, reconnectMaxMs: 30000, heartbeatMs: 5000, maxBufferedBytes: 262144, ...cfg };
  }

  connect(): void { this.closed = false; void this.open(); }

  private async open(): Promise<void> {
    const region = this.cfg.region ?? (await this.probeRegion());
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/relay`
      + `?session=${encodeURIComponent(this.cfg.sessionId)}&region=${region}`;
    const ws = new WebSocket(url, [`bearer.${this.cfg.authToken}`]);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { this.ws = ws; this.startHeartbeat(); this.emitStats(); };
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = () => this.onClose();
    ws.onerror = () => this.onClose();
  }

  /** Race HEAD requests to each regional endpoint, pick fastest (1.5s cap). */
  private async probeRegion(): Promise<Region> {
    const regions: Region[] = ["us-central1", "us-east1", "europe-west1", "asia-east1"];
    const url = (r: Region) =>
      `${this.cfg.baseUrl.replace(/(\w+)\.a\.run\.app/, `${r}.a.run.app`)}/ping?_=${Date.now()}`;
    return Promise.race(regions.map((r) => new Promise<Region>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(r);
      img.onerror = () => resolve(r);
      img.src = url(r);
      setTimeout(() => resolve(r), 1500);
    })));
  }

  private onMessage(ev: MessageEvent): void {
    if (typeof ev.data === "string" && ev.data === "pong") {
      this.rttMs = Date.now() - this.lastPingAt;
      this.emitStats();
      return;
    }
    this.listeners.forEach((l) => l(ev.data as RelayPacket));
  }

  private startHeartbeat(): void {
    this.heartbeatTimer?.();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.lastPingAt = Date.now();
      this.ws.send("ping");
    }, this.cfg.heartbeatMs);
  }

  private onClose(): void {
    this.ws = null;
    this.heartbeatTimer?.();
    this.heartbeatTimer = null;
    if (this.closed) return;
    this.reconnects += 1;
    const delay = Math.min(this.cfg.reconnectBaseMs * 2 ** Math.min(this.reconnects - 1, 5), this.cfg.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => void this.open(), delay);
    this.emitStats();
  }

  /** Send a packet. Returns false if dropped (backpressure or not connected). */
  send(priority: PacketPriority, payload: ArrayBuffer | string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > this.cfg.maxBufferedBytes && priority === "normal") {
      this.droppedPackets += 1;
      return false;
    }
    this.seq += 1;
    const packet: RelayPacket = { seq: this.seq, priority, payload };
    this.ws.send(typeof payload === "string" ? JSON.stringify(packet) : payload);
    return true;
  }

  onPacket(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  onStats(l: (s: RelayStats) => void): () => void { this.statsListeners.add(l); return () => this.statsListeners.delete(l); }

  private emitStats(): void {
    const stats: RelayStats = {
      connected: this.ws?.readyState === WebSocket.OPEN,
      region: this.cfg.region ?? null, rttMs: this.rttMs, reconnects: this.reconnects,
      droppedPackets: this.droppedPackets, bufferedBytes: this.ws?.bufferedAmount ?? 0,
    };
    this.statsListeners.forEach((l) => l(stats));
  }

  close(): void {
    this.closed = true;
    this.reconnectTimer?.();
    this.heartbeatTimer?.();
    this.ws?.close();
    this.ws = null;
  }
}