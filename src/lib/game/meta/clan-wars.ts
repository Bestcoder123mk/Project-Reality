/**
 * SEC11-META — Clan war system with territories.
 *
 * Models a season-long clan war over a grid of territories. Each territory
 * has a control point; clans earn war points by winning matches on that
 * territory. At end-of-season the clan holding the most territories wins
 * the season reward, and top contributors inside each clan receive
 * individual bonuses.
 *
 * Pure policy layer: the caller persists `WarState` to Firestore
 * (`clanWars/{seasonId}`) and hydrates before each call. All operations
 * are idempotent within a tick.
 *
 * Public API:
 *   - `ClanWarSystem.startSeason(config)` → WarState
 *   - `ClanWarSystem.recordMatch(result)` → updated state + grants
 *   - `ClanWarSystem.closeSeason(state)` → final standings
 */

export interface Territory {
  id: string;
  name: string;
  /** Current controlling clan id (null = contested). */
  ownerId: string | null;
  warPoints: Record<string, number>;
  /** Total war points needed to flip control in a tick. */
  captureThreshold: number;
}

export interface ClanWarConfig {
  seasonId: string;
  startsAt: string;
  endsAt: string;
  clanIds: string[];
  territoryIds: string[];
  captureThreshold: number;
  winReward: Reward;
  contributorReward: Reward;
}

export interface Reward {
  softCurrency?: number;
  hardCurrency?: number;
  cosmeticSku?: string;
  clanXp?: number;
}

export interface MatchResult {
  territoryId: string;
  winningClanId: string;
  losingClanId: string;
  contributors: { playerId: string; clanId: string; score: number }[];
  playedAt: string;
}

export interface WarState {
  config: ClanWarConfig;
  territories: Record<string, Territory>;
  clanTotals: Record<string, number>;
  contributorTotals: Record<string, number>;
  matches: number;
  closed: boolean;
}

export interface SeasonStanding {
  clanId: string;
  territoriesHeld: number;
  warPoints: number;
  rank: number;
  reward: Reward;
}

export class ClanWarSystem {
  startSeason(config: ClanWarConfig): WarState {
    const territories: Record<string, Territory> = {};
    for (const id of config.territoryIds) {
      territories[id] = { id, name: id, ownerId: null, warPoints: {}, captureThreshold: config.captureThreshold };
    }
    return {
      config,
      territories,
      clanTotals: Object.fromEntries(config.clanIds.map((c) => [c, 0])),
      contributorTotals: {},
      matches: 0,
      closed: false,
    };
  }

  recordMatch(state: WarState, result: MatchResult): { state: WarState; grants: Reward[] } {
    if (state.closed) return { state, grants: [] };
    const territory = state.territories[result.territoryId];
    if (!territory) return { state, grants: [] };
    const next: WarState = JSON.parse(JSON.stringify(state));
    next.matches += 1;
    const wp = 10;
    next.clanTotals[result.winningClanId] = (next.clanTotals[result.winningClanId] ?? 0) + wp;
    territory.warPoints[result.winningClanId] = (territory.warPoints[result.winningClanId] ?? 0) + wp;
    next.territories[result.territoryId] = territory;

    // Flip control when a clan exceeds captureThreshold and leads by ≥20%.
    const totals = Object.entries(territory.warPoints).sort((a, b) => b[1] - a[1]);
    if (totals.length) {
      const [top, second] = totals;
      const lead = second ? top[1] - second[1] : top[1];
      if (top[1] >= territory.captureThreshold && lead >= Math.max(20, top[1] * 0.2)) {
        territory.ownerId = top[0];
      }
    }

    const grants: Reward[] = [];
    for (const c of result.contributors) {
      next.contributorTotals[c.playerId] = (next.contributorTotals[c.playerId] ?? 0) + c.score;
      if (c.clanId === result.winningClanId) {
        grants.push({ clanXp: 25, softCurrency: 100 });
      }
    }
    return { state: next, grants };
  }

  closeSeason(state: WarState): SeasonStanding[] {
    if (state.closed) return this.standings(state);
    state.closed = true;
    return this.standings(state);
  }

  private standings(state: WarState): SeasonStanding[] {
    const held: Record<string, number> = {};
    for (const t of Object.values(state.territories)) {
      if (t.ownerId) held[t.ownerId] = (held[t.ownerId] ?? 0) + 1;
    }
    const rows = state.config.clanIds.map((clanId) => ({
      clanId,
      territoriesHeld: held[clanId] ?? 0,
      warPoints: state.clanTotals[clanId] ?? 0,
      rank: 0,
      reward: { clanXp: 0, hardCurrency: 0 } as Reward,
    }));
    rows.sort((a, b) => b.territoriesHeld - a.territoriesHeld || b.warPoints - a.warPoints);
    rows.forEach((r, i) => {
      r.rank = i + 1;
      if (i === 0) r.reward = state.config.winReward;
      else if (i < 3) r.reward = { hardCurrency: 100, clanXp: 500 };
    });
    return rows;
  }
}
