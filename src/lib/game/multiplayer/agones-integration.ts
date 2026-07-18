/**
 * G_Multiplayer_Netcode-00017 / 00022: Agones game server integration.
 *
 * Agones is an open-source Kubernetes-based dedicated game server. We use it
 * for ranked matches where Cloud Run's request-response model is too coarse
 * for sub-50ms tick fidelity. This module is the SDK that:
 *
 *   1. Requests a fresh GameServer from the Agones allocation endpoint
 *      (`/apis/allocation.agones.dev/v1/namespaces/{ns}/gameserverallocate`).
 *   2. Polls the GameServer's `status.state` until it's `Allocated`.
 *   3. Returns the `{ host, port }` the client connects its WebSocket to.
 *
 * Allocation is authenticated via a Kubernetes service-account token. In
 * production this is a separate Firebase Function that holds the SA token;
 * here we accept a caller-supplied `fetch` shim so the SDK can run client-
 * side (calling the Function) or server-side (calling Agones directly).
 *
 * `AgonesConfig` is a config-driven data table (per the prompt) so ops can
 * tune fleet sizes + labels without a redeploy.
 */

export type AgonesRegion = "us-central" | "us-east" | "eu-west" | "asia-east";
export type AgonesFleet = "ranked-5v5" | "ranked-2v2" | "casual-16p" | "custom";

export interface AgonesConfig {
  /** Agones allocation API base URL (e.g. https://agones.example.com). */
  apiBaseUrl: string;
  /** Kubernetes namespace. Default "default". */
  namespace?: string;
  /** Bearer token (SA token) — required for direct Agones calls. */
  authToken?: string;
  /** Per-fleet sizing + label config (the "data table"). */
  fleets: Record<AgonesFleet, AgonesFleetConfig>;
  /** Region → preferred fleet label value. */
  regionFleets: Record<AgonesRegion, AgonesFleet>;
  /** Poll interval (ms) while waiting for Allocated. Default 500. */
  pollIntervalMs?: number;
  /** Total timeout (ms) waiting for Allocated. Default 30000. */
  allocateTimeoutMs?: number;
}

export interface AgonesFleetConfig {
  /** Fleet name in the Agones cluster. */
  fleetName: string;
  /** Max concurrent allocations per second (rate limit). */
  maxAllocationsPerSecond: number;
  /** Labels added to the GameServer on allocation (region, mode, etc.). */
  labels: Record<string, string>;
  /** Annotations (e.g. session-mode-version for A/B deploys). */
  annotations?: Record<string, string>;
  /** Preferred ports (named ports on the GameServer spec). */
  ports: { name: string; containerPort: number }[];
}

export interface AllocatedGameServer {
  /** GameServer name (k8s resource name). */
  name: string;
  /** Public host the client connects to. */
  host: string;
  /** Named ports the GameServer exposes. */
  ports: Record<string, number>;
  /** Region the server landed in. */
  region: AgonesRegion;
}

export interface AllocateRequest {
  fleet: AgonesFleet;
  region: AgonesRegion;
  /** Match/session id stamped onto the GameServer as a label. */
  sessionId: string;
  /** Optional player ids for Agones player tracking. */
  playerIds?: string[];
}

export class AgonesAllocationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AgonesAllocationError";
  }
}

/**
 * Request a fresh Agones GameServer. Returns once `status.state === "Allocated"`.
 * Throws `AgonesAllocationError` on timeout or HTTP failure.
 */
export async function requestGameServer(
  cfg: AgonesConfig,
  req: AllocateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AllocatedGameServer> {
  const ns = cfg.namespace ?? "default";
  const fleetCfg = cfg.fleets[req.fleet];
  if (!fleetCfg) throw new AgonesAllocationError(`unknown fleet: ${req.fleet}`, "UNKNOWN_FLEET");
  const url = `${cfg.apiBaseUrl}/apis/allocation.agones.dev/v1/namespaces/${ns}/gameserverallocate`;
  const body = {
    apiVersion: "allocation.agones.dev/v1",
    kind: "GameServerAllocation",
    spec: {
      selectors: [
        {
          matchLabels: { ...fleetCfg.labels, region: req.region, fleet: fleetCfg.fleetName },
        },
      ],
      scheduling: "Packed",
      metadata: {
        labels: { session: req.sessionId, region: req.region },
        annotations: fleetCfg.annotations,
      },
      ports: fleetCfg.ports.map((p) => ({ name: p.name })),
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.authToken) headers.Authorization = `Bearer ${cfg.authToken}`;

  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new AgonesAllocationError(
      `allocate HTTP ${res.status}: ${await res.text()}`,
      "ALLOCATE_HTTP_ERROR",
    );
  }
  const gs = (await res.json()) as {
    status?: { state?: string; address?: string; ports?: Record<string, number> };
    metadata?: { name?: string; labels?: Record<string, string> };
  };
  if (gs.status?.state !== "Allocated" || !gs.status?.address || !gs.status?.ports) {
    // Agones returns 200 + state=Unallocated when no capacity; surface that.
    throw new AgonesAllocationError(
      `not allocated (state=${gs.status?.state ?? "unknown"})`,
      "NOT_ALLOCATED",
    );
  }
  return {
    name: gs.metadata?.name ?? req.sessionId,
    host: gs.status.address,
    ports: gs.status.ports,
    region: (gs.metadata?.labels?.region as AgonesRegion) ?? req.region,
  };
}

/** Resolve which fleet to use for a region (used by the matchmaker). */
export function fleetForRegion(cfg: AgonesConfig, region: AgonesRegion): AgonesFleet {
  return cfg.regionFleets[region];
}
