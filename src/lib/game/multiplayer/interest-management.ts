/**
 * G_Multiplayer_Netcode-00035: Network interest management + culling.
 *
 * Replicating every entity at 20 Hz blows past 1 KB/snapshot. This module
 * culls to entities the client can perceive (~80% bandwidth cut in dense
 * scenes). Relevance channels:
 *   - Spatial: within perception radius (120 m); uniform grid, rebuilt per tick.
 *   - View frustum: in front of the player (dot > cos(FOV/2)); disabled for spectators.
 *   - Owned / squad: always relevant.
 *   - Recently damaged: relevant for 2 s (kill-cam + hit indicator).
 *   - Audible: gunshots within 80 m relevant even behind the player.
 */

export interface InterestEntity {
  id: string;
  x: number;
  y: number;
  z: number;
  alwaysRelevant?: boolean;
  audible?: boolean;
}

export interface InterestClient {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Unit-vector facing direction. */
  fx: number;
  fy: number;
  fz: number;
  /** Cosine of half the FOV (e.g. cos(45°) ≈ 0.707 for a 90° FOV). */
  fovDot: number;
  omniscient?: boolean;
  ownedIds: ReadonlySet<string>;
}

export interface InterestConfig {
  perceptionRadius: number;
  audibleRadius: number;
  cellSize: number;
  recentlyDamagedMs: number;
}

const DEFAULT_CONFIG: InterestConfig = {
  perceptionRadius: 120,
  audibleRadius: 80,
  cellSize: 16,
  recentlyDamagedMs: 2000,
};

export class InterestManager {
  private cfg: InterestConfig;
  private grid = new Map<string, InterestEntity[]>();
  private relevant = new Map<string, Set<string>>();
  private recentDamage = new Map<string, { fromEntityId: string; at: number }[]>();

  constructor(cfg: Partial<InterestConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /** Notify that `clientId` took damage from `fromEntityId` at `now`. */
  recordDamage(clientId: string, fromEntityId: string, now: number): void {
    let list = this.recentDamage.get(clientId);
    if (!list) {
      list = [];
      this.recentDamage.set(clientId, list);
    }
    list.push({ fromEntityId, at: now });
  }

  /** Rebuild the spatial grid + recompute relevance for each client. */
  update(entities: readonly InterestEntity[], clients: readonly InterestClient[], now: number): void {
    this.pruneDamage(now);
    this.rebuildGrid(entities);
    this.relevant.clear();
    for (const client of clients) this.relevant.set(client.id, this.computeRelevant(client, now));
  }

  /** Returns the cached set of entity ids relevant to `clientId`. */
  getRelevantEntities(clientId: string): Set<string> {
    return this.relevant.get(clientId) ?? new Set();
  }

  private computeRelevant(client: InterestClient, now: number): Set<string> {
    const out = new Set<string>();
    const r2 = this.cfg.perceptionRadius * this.cfg.perceptionRadius;
    const ar2 = this.cfg.audibleRadius * this.cfg.audibleRadius;
    const damaged = this.recentDamage.get(client.id) ?? [];
    for (const e of this.queryNeighbors(client)) {
      if (e.alwaysRelevant || client.ownedIds.has(e.id)) { out.add(e.id); continue; }
      const dx = e.x - client.x;
      const dy = e.y - client.y;
      const dz = e.z - client.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= r2) {
        if (client.omniscient || d2 < 25 || client.fovDot <= -1) { out.add(e.id); continue; }
        const dist = Math.sqrt(d2);
        const dot = (dx * client.fx + dy * client.fy + dz * client.fz) / dist;
        if (dot >= client.fovDot) out.add(e.id);
        continue;
      }
      if (e.audible && d2 <= ar2) out.add(e.id);
    }
    for (const d of damaged) {
      if (now - d.at < this.cfg.recentlyDamagedMs) out.add(d.fromEntityId);
    }
    return out;
  }

  private rebuildGrid(entities: readonly InterestEntity[]): void {
    this.grid.clear();
    const cs = this.cfg.cellSize;
    for (const e of entities) {
      const key = `${Math.floor(e.x / cs)},${Math.floor(e.z / cs)}`;
      let bucket = this.grid.get(key);
      if (!bucket) { bucket = []; this.grid.set(key, bucket); }
      bucket.push(e);
    }
  }

  private queryNeighbors(client: InterestClient): InterestEntity[] {
    const cs = this.cfg.cellSize;
    const r = Math.ceil(this.cfg.perceptionRadius / cs);
    const cx = Math.floor(client.x / cs);
    const cz = Math.floor(client.z / cs);
    const out: InterestEntity[] = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const bucket = this.grid.get(`${cx + dx},${cz + dz}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  }

  private pruneDamage(now: number): void {
    for (const [clientId, list] of this.recentDamage) {
      const pruned = list.filter((d) => now - d.at < this.cfg.recentlyDamagedMs);
      if (pruned.length === 0) this.recentDamage.delete(clientId);
      else this.recentDamage.set(clientId, pruned);
    }
  }
}
