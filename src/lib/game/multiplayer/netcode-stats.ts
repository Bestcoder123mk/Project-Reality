/**
 * G_Multiplayer_Netcode-00002 / 00021 / 00023 / 00029: Network stats tracking.
 *
 * Aggregates three signals the netcode + UI need:
 *   - Ping (RTT): EMA for stability + p95 over a 60 s window.
 *   - Packet loss: `recordLost(count)` increments lost counter; loss % =
 *     lost / (received + lost).
 *   - Jitter: EMA of |Δarrival - meanΔarrival|. High jitter triggers the
 *     jitter-buffer tuning in `StateReplication.ts`.
 *
 * `snapshot()` returns a frozen view for the UI. `quality()` maps signals
 * to a 4-bar rating (good / medium / poor / disconnected) using thresholds
 * from prompt #12 / #15.
 */

export type ConnectionQuality = "good" | "medium" | "poor" | "disconnected";

export interface NetcodeSnapshot {
  pingEmaMs: number;
  pingP95Ms: number;
  packetLossPct: number;
  jitterEmaMs: number;
  packetsSent: number;
  packetsReceived: number;
  packetsLost: number;
  bytesSent: number;
  bytesReceived: number;
  quality: ConnectionQuality;
  updatedAt: number;
}

export interface NetcodeStatsOptions {
  pingAlpha?: number;
  jitterAlpha?: number;
  pingWindow?: number;
  goodPingMs?: number;
  mediumPingMs?: number;
  poorLossPct?: number;
  poorJitterMs?: number;
  disconnectMs?: number;
}

export class NetcodeStats {
  private opts: Required<NetcodeStatsOptions>;
  private pingEma = 0;
  private jitterEma = 0;
  private lastArrivalMs = 0;
  private lastInterArrival = 0;
  private pingWindow: number[] = [];
  private packetsSent = 0;
  private packetsReceived = 0;
  private packetsLost = 0;
  private bytesSent = 0;
  private bytesReceived = 0;
  private lastPacketAt = 0;
  private updatedAt = 0;

  constructor(opts: NetcodeStatsOptions = {}) {
    this.opts = {
      pingAlpha: 0.1, jitterAlpha: 0.05, pingWindow: 60,
      goodPingMs: 50, mediumPingMs: 120, poorLossPct: 3, poorJitterMs: 30, disconnectMs: 5000,
      ...opts,
    };
  }

  recordPing(rttMs: number, now: number): void {
    this.pingEma = this.pingEma === 0 ? rttMs : this.pingEma + this.opts.pingAlpha * (rttMs - this.pingEma);
    this.pingWindow.push(rttMs);
    if (this.pingWindow.length > this.opts.pingWindow) this.pingWindow.shift();
    this.lastPacketAt = now;
    this.updatedAt = now;
  }

  recordPacketSent(bytes: number, now: number): void {
    this.packetsSent += 1;
    this.bytesSent += bytes;
    this.updatedAt = now;
  }

  /** `seq` is the packet sequence number (reserved for future gap detection). */
  recordPacketReceived(seq: number, bytes: number, now: number): void {
    this.packetsReceived += 1;
    this.bytesReceived += bytes;
    if (this.lastArrivalMs > 0) {
      const dt = now - this.lastArrivalMs;
      if (this.lastInterArrival > 0) {
        const delta = Math.abs(dt - this.lastInterArrival);
        this.jitterEma = this.jitterEma === 0 ? delta : this.jitterEma + this.opts.jitterAlpha * (delta - this.jitterEma);
      }
      this.lastInterArrival = dt;
    }
    this.lastArrivalMs = now;
    this.lastPacketAt = now;
    this.updatedAt = now;
    void seq;
  }

  recordLost(count = 1): void {
    this.packetsLost += count;
  }

  snapshot(now: number): NetcodeSnapshot {
    const sorted = [...this.pingWindow].sort((a, b) => a - b);
    const p95 = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const lossPct = this.packetsSent === 0
      ? 0
      : Math.min(100, (this.packetsLost / (this.packetsReceived + this.packetsLost)) * 100);
    return {
      pingEmaMs: this.pingEma,
      pingP95Ms: p95,
      packetLossPct: lossPct,
      jitterEmaMs: this.jitterEma,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      packetsLost: this.packetsLost,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      quality: this.quality(now),
      updatedAt: this.updatedAt,
    };
  }

  quality(now: number): ConnectionQuality {
    if (now - this.lastPacketAt > this.opts.disconnectMs || this.pingEma === 0) return "disconnected";
    if (this.pingEma > this.opts.mediumPingMs
      || this.packetsLost > this.opts.poorLossPct
      || this.jitterEma > this.opts.poorJitterMs) return "poor";
    if (this.pingEma > this.opts.goodPingMs) return "medium";
    return "good";
  }

  reset(): void {
    this.pingEma = 0;
    this.jitterEma = 0;
    this.lastArrivalMs = 0;
    this.lastInterArrival = 0;
    this.pingWindow = [];
    this.packetsSent = 0;
    this.packetsReceived = 0;
    this.packetsLost = 0;
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this.lastPacketAt = 0;
    this.updatedAt = 0;
  }
}
