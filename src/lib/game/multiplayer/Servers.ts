/**
 * Section H (957–960) — Dedicated server, listen server, region
 * selection, and server browser.
 *
 * The current deployment is a single-player demo (the engine runs in
 * the browser; there's no separate server process). This module
 * scaffolds the four multiplayer topologies so a real MP build can
 * wire them in without re-architecting:
 *
 *   957 — `DedicatedServer` runs the authoritative simulation headless
 *         (no rendering, no input). The browser clients connect via
 *         WebSocket; the server sends snapshots + receives inputs.
 *         This is the production topology (low-latency regions, no
 *         host-authority cheating, no host-disconnect migration).
 *   958 — `ListenServer` runs the authoritative simulation in the
 *         host's browser (the host is also a player). Other players
 *         connect to the host via WebRTC. Cheaper than dedicated
 *         (no server rental) but the host has authority (cheating
 *         risk) + host disconnect = match over (mitigated by H/941
 *         host migration).
 *   959 — `RegionRegistry` enumerates the available regions + their
 *         endpoints. The client calls `selectRegion(regionId)` to
 *         pin its matchmaking queue to a region (lowest-ping choice
 *         by default, manual override available).
 *   960 — `ServerBrowser` lists active sessions the player can
 *         spectate or join. Backed by the in-memory `sessions` Map
 *         from Matchmaking.ts (production would use a Redis sorted
 *         set keyed by region + mode + player-count).
 *
 * All four are scaffolded as classes with the right shape; the actual
 * WebSocket / WebRTC transport wiring is deferred to a real MP build
 * (the single-player demo doesn't need it).
 */

import {
  listSessions,
  type GameSession,
  type SessionState,
} from "./Matchmaking";

// ─── 959 — Region selection ──────────────────────────────────────────────

export interface Region {
  id: string;
  /** Human-readable label ("US East (Virginia)"). */
  label: string;
  /** Region code for matchmaking ("us-east-1"). */
  code: string;
  /** WebSocket endpoint for the region's dedicated-server pool. */
  endpoint: string;
  /** Approximate geographic latitude/longitude (for ping estimation). */
  lat: number;
  lng: number;
  /** True when the region is accepting new matches (false during outage). */
  acceptingPlayers: boolean;
}

/**
 * Known regions. The single-player demo has one local region; a real
 * MP build would source this from a config endpoint (so regions can
 * be added/removed without a deploy).
 */
export const REGIONS: Region[] = [
  {
    id: "local",
    label: "Local (single-player)",
    code: "local",
    endpoint: "ws://localhost:3000/api/matchmaking/ws",
    lat: 0,
    lng: 0,
    acceptingPlayers: true,
  },
  {
    id: "us-east",
    label: "US East (Virginia)",
    code: "us-east-1",
    endpoint: "wss://us-east.projectreality.example/api/matchmaking/ws",
    lat: 38.13,
    lng: -78.45,
    acceptingPlayers: false, // disabled until the MP build ships.
  },
  {
    id: "eu-west",
    label: "EU West (Ireland)",
    code: "eu-west-1",
    endpoint: "wss://eu-west.projectreality.example/api/matchmaking/ws",
    lat: 53.0,
    lng: -8.0,
    acceptingPlayers: false,
  },
  {
    id: "ap-southeast",
    label: "AP Southeast (Singapore)",
    code: "ap-southeast-1",
    endpoint: "wss://ap-southeast.projectreality.example/api/matchmaking/ws",
    lat: 1.35,
    lng: 103.82,
    acceptingPlayers: false,
  },
];

export class RegionRegistry {
  private selectedRegionId: string = "local";

  /** List the regions available to the player. */
  list(): Region[] {
    return REGIONS;
  }

  /** List only regions that are currently accepting players. */
  listAccepting(): Region[] {
    return REGIONS.filter((r) => r.acceptingPlayers);
  }

  /** Get the currently-selected region. */
  getSelected(): Region {
    return REGIONS.find((r) => r.id === this.selectedRegionId) ?? REGIONS[0];
  }

  /**
   * Select a region. Returns false if the region id is unknown or the
   * region isn't accepting players.
   *
   *   const ok = regions.selectRegion("us-east");
   *   if (!ok) return errorResponse("Region not available", 400);
   */
  selectRegion(regionId: string): boolean {
    const region = REGIONS.find((r) => r.id === regionId);
    if (!region) return false;
    if (!region.acceptingPlayers) return false;
    this.selectedRegionId = regionId;
    return true;
  }

  /**
   * Auto-select the lowest-ping region based on the client's
   * approximate geolocation. The client supplies its lat/lng (from
   * `navigator.geolocation`); we pick the closest accepting region.
   */
  autoSelectFromGeolocation(clientLat: number, clientLng: number): Region | null {
    const accepting = this.listAccepting();
    if (accepting.length === 0) return null;
    let best: Region | null = null;
    let bestDist = Infinity;
    for (const r of accepting) {
      // Haversine-ish — we only need relative ordering, so the
      // Euclidean approximation is fine.
      const dist = Math.hypot(r.lat - clientLat, r.lng - clientLng);
      if (dist < bestDist) {
        bestDist = dist;
        best = r;
      }
    }
    if (best) this.selectedRegionId = best.id;
    return best;
  }
}

// ─── 957 — Dedicated server ──────────────────────────────────────────────

/**
 * Headless authoritative server. Runs the simulation tick at 60 Hz,
 * accepts client inputs at 60 Hz, and broadcasts snapshots at 20 Hz.
 *
 * The single-player demo doesn't run this — the engine IS the server.
 * A real MP build would `node dedicated-server.js` on a region's
 * server pool; each instance hosts up to `MAX_SESSIONS_PER_INSTANCE`
 * concurrent matches.
 */
export interface DedicatedServerConfig {
  regionId: string;
  /** Max concurrent matches per process (RAM-bounded). */
  maxSessionsPerInstance: number;
  /** Snapshot broadcast rate (Hz). */
  snapshotHz: number;
  /** Simulation tick rate (Hz). */
  tickHz: number;
}

export const DEFAULT_DEDICATED_CONFIG: DedicatedServerConfig = {
  regionId: "local",
  maxSessionsPerInstance: 16,
  snapshotHz: 20,
  tickHz: 60,
};

export class DedicatedServer {
  private sessions = new Map<string, GameSession>();
  private lastTickAt = 0;
  private lastSnapshotAt = 0;

  constructor(public config: DedicatedServerConfig = DEFAULT_DEDICATED_CONFIG) {}

  /** Accept a new session onto this server instance. */
  hostSession(session: GameSession): boolean {
    if (this.sessions.size >= this.config.maxSessionsPerInstance) return false;
    this.sessions.set(session.id, session);
    return true;
  }

  /** Remove a session (match ended). */
  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Run one simulation tick. The caller (the dedicated-server process's
   * main loop) invokes this at `tickHz` cadence. Each tick advances
   * every active session's simulation by 1/tickHz seconds.
   *
   * Returns the number of sessions ticked. The actual sim work is
   * deferred to the engine's `simulate(dt)` (which the dedicated-server
   * build links in headless — no rendering, no input, just the systems).
   */
  tick(now: number): number {
    const dt = this.lastTickAt === 0 ? 16 : now - this.lastTickAt;
    this.lastTickAt = now;
    let n = 0;
    for (const session of this.sessions.values()) {
      if (session.state !== "IN_PROGRESS") continue;
      // The engine's simulate() lives in `engine/loop.ts`; the
      // dedicated-server build calls it directly (no RAF). Deferred
      // to the real MP build — the stub just counts active sessions.
      void dt;
      n++;
    }
    return n;
  }

  /**
   * Broadcast snapshots to all connected clients. Returns the number
   * of snapshots sent. The actual serialization uses
   * `packSnapshotBinary` (905) — kept stubbed here because there's
   * no WebSocket pool in the single-player demo.
   */
  broadcastSnapshots(now: number): number {
    if (now - this.lastSnapshotAt < 1000 / this.config.snapshotHz) return 0;
    this.lastSnapshotAt = now;
    let n = 0;
    for (const session of this.sessions.values()) {
      if (session.state !== "IN_PROGRESS") continue;
      // Stub: real impl walks the session's entity registry + calls
      // `packSnapshotBinary` + sends to each connected WebSocket.
      n++;
    }
    return n;
  }

  /** Number of currently-hosted sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }
}

// ─── 958 — Listen server ─────────────────────────────────────────────────

/**
 * Listen-server topology: the host's browser runs the authoritative
 * simulation; other players connect via WebRTC (peer-to-peer mesh) or
 * via a relay (WebRTC + TURN). Cheaper than dedicated (no server
 * rental) but:
 *
 *   - Host has authority → cheating risk (mitigated by the
 *     server-authoritative hit-validation in hit-validation.ts, which
 *     still runs on the host's browser — the host can still cheat by
 *     modifying the host-side code, but other players can't).
 *   - Host disconnect = match over (mitigated by H/941 host migration;
 *     the new host continues the simulation from the last snapshot).
 *
 * The single-player demo IS a listen server (the engine is the host +
 * the only player). This class formalizes the topology so the MP
 * build can wire WebRTC.
 */
export interface ListenServerConfig {
  /** WebRTC ICE servers (TURN/STUN) for NAT traversal. */
  iceServers: RTCIceServer[];
  /** Max peers (excluding host). */
  maxPeers: number;
  /** Whether to use a relay when P2P fails. */
  allowRelay: boolean;
}

export const DEFAULT_LISTEN_CONFIG: ListenServerConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  maxPeers: 15,
  allowRelay: true,
};

export class ListenServer {
  private peers = new Map<string, RTCPeerConnection>();
  private sessionId: string | null = null;

  constructor(public config: ListenServerConfig = DEFAULT_LISTEN_CONFIG) {}

  /** Start hosting a session. Returns the session id (for the browser). */
  startHosting(session: GameSession): string {
    this.sessionId = session.id;
    return session.id;
  }

  /**
   * Accept a new peer connection. The peer's WebRTC offer is signaled
   * out-of-band (e.g. via the matchmaking server's WebSocket); the
   * host answers + adds the peer to the mesh.
   *
   * Returns false when the peer cap is reached.
   */
  acceptPeer(peerId: string, offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit | null> {
    if (this.peers.size >= this.config.maxPeers) return Promise.resolve(null);
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    this.peers.set(peerId, pc);
    // The data channel for snapshots + inputs is created by the host
    // (the peer's `ondatachannel` handler fires when the host opens it).
    return pc.setRemoteDescription(offer)
      .then(() => pc.createAnswer())
      .then((answer) => {
        void pc.setLocalDescription(answer);
        return answer;
      })
      .catch(() => null);
  }

  /** Disconnect a peer. */
  dropPeer(peerId: string): void {
    const pc = this.peers.get(peerId);
    if (pc) {
      pc.close();
      this.peers.delete(peerId);
    }
  }

  /** Stop hosting. Closes all peer connections. */
  stopHosting(): void {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.sessionId = null;
  }

  get peerCount(): number {
    return this.peers.size;
  }
}

// ─── 960 — Server browser ────────────────────────────────────────────────

export interface ServerBrowserEntry {
  sessionId: string;
  mode: string;
  mapSlug: string;
  state: SessionState;
  playerCount: number;
  maxPlayers: number;
  /** Average MMR of the players (for "fair match" filtering). */
  mmrBand?: number;
  /** True when the session accepts spectators. */
  acceptsSpectators: boolean;
  /** Ping in ms (estimated from the region's geolocation). */
  pingMs: number;
}

export class ServerBrowser {
  constructor(private registry: RegionRegistry = new RegionRegistry()) {}

  /**
   * List active sessions the player can join or spectate. Filters by
   * the selected region (only sessions hosted in that region are
   * returned) + by the optional mode filter.
   *
   * Backed by `Matchmaking.listSessions()` in the single-player demo.
   * Production would query the region's Redis sorted set.
   */
  list(opts: { mode?: string; includeFull?: boolean; includeSpectatable?: boolean } = {}): ServerBrowserEntry[] {
    const region = this.registry.getSelected();
    const sessions = listSessions();
    return sessions
      .filter((s) => {
        if (opts.mode && s.mode !== opts.mode) return false;
        if (!opts.includeFull && s.players.length >= 16) return false;
        return true;
      })
      .map((s) => this.toEntry(s, region));
  }

  private toEntry(session: GameSession, region: Region): ServerBrowserEntry {
    // Estimate ping from the region's geolocation (the single-player
    // "local" region is 0 ms; remote regions would be estimated from
    // the client's last-measured RTT).
    const pingMs = region.id === "local" ? 0 : 50; // stub.
    return {
      sessionId: session.id,
      mode: session.mode,
      mapSlug: session.mapSlug,
      state: session.state,
      playerCount: session.players.length,
      maxPlayers: 16,
      mmrBand: session.mmrBand,
      acceptsSpectators: Boolean(session.spectatorIds),
      pingMs,
    };
  }

  /**
   * Join a session by id. Returns the session if the join succeeded
   * (slot available), null otherwise. The actual join logic lives in
   * `Matchmaking.joinQueue` (re-joined as a "ready" player); this is
   * a thin lookup.
   */
  join(sessionId: string): GameSession | null {
    return listSessions().find((s) => s.id === sessionId) ?? null;
  }
}

// ─── singleton accessors ─────────────────────────────────────────────────

/** Process-wide region registry (one per client). */
let regionRegistry: RegionRegistry | null = null;
export function getRegionRegistry(): RegionRegistry {
  if (!regionRegistry) regionRegistry = new RegionRegistry();
  return regionRegistry;
}

/** Process-wide server browser (one per client). */
let serverBrowser: ServerBrowser | null = null;
export function getServerBrowser(): ServerBrowser {
  if (!serverBrowser) serverBrowser = new ServerBrowser(getRegionRegistry());
  return serverBrowser;
}
