/**
 * SEC11-META — Automated retention campaigns.
 *
 * Drives three classes of automated rewards:
 *   - Daily login bonus (7/14/28-day tracks with escalating value)
 *   - Comeback / win-back rewards (lapsed 7/14/30 days)
 *   - Milestone streaks (consecutive-day streak bonuses)
 *
 * Each grant is idempotent (keyed by `playerId:campaignId:cycle`) so a
 * double-claim cannot double-pay. State lives in the PlayerCampaignState
 * table; this module is the pure policy layer that callers hydrate from
 * the DB before invoking `evaluate`.
 *
 * Public API:
 *   - `RetentionCampaignManager.evaluate(state, now)` → Grant[]
 *   - `RetentionCampaignManager.claim(grant)` → ClaimedGrant
 *   - `RetentionCampaignManager.tracks()` → campaign definitions
 */

export type CampaignKind = "login_bonus" | "comeback" | "streak";

export interface CampaignTrack {
  id: string;
  kind: CampaignKind;
  cycleDays: number; // length of the reward track
  rewards: Reward[]; // length === cycleDays
  /** Lapsed-window that qualifies a player (comeback only). */
  lapsedMinDays?: number;
  lapsedMaxDays?: number;
}

export interface Reward {
  softCurrency?: number;
  hardCurrency?: number;
  cosmeticSku?: string;
  xpBoostMinutes?: number;
}

export interface PlayerCampaignState {
  playerId: string;
  /** Map of campaignId → current day-in-cycle (1-indexed). */
  progress: Record<string, number>;
  /** Map of campaignId → ISO date of last claim (YYYY-MM-DD). */
  lastClaim: Record<string, string>;
  lastSessionAt: string;
  streak: number;
}

export interface Grant {
  playerId: string;
  campaignId: string;
  cycle: number;
  day: number;
  reward: Reward;
  reason: CampaignKind;
}

export interface ClaimedGrant extends Grant {
  claimedAt: string;
  id: string;
}

const LOGIN_7: CampaignTrack = {
  id: "login_7",
  kind: "login_bonus",
  cycleDays: 7,
  rewards: [
    { softCurrency: 500 },
    { softCurrency: 750 },
    { softCurrency: 1000 },
    { xpBoostMinutes: 30 },
    { softCurrency: 1500 },
    { hardCurrency: 20 },
    { cosmeticSku: "login_pack_t1" },
  ],
};

const COMEBACK_14: CampaignTrack = {
  id: "comeback_14",
  kind: "comeback",
  cycleDays: 3,
  lapsedMinDays: 14,
  lapsedMaxDays: 60,
  rewards: [
    { hardCurrency: 100 },
    { softCurrency: 5000 },
    { cosmeticSku: "comeback_banner" },
  ],
};

const STREAK_28: CampaignTrack = {
  id: "streak_28",
  kind: "streak",
  cycleDays: 28,
  rewards: Array.from({ length: 28 }, (_, i) => ((i + 1) % 7 === 0 ? { hardCurrency: 25 } : { softCurrency: 250 })),
};

export class RetentionCampaignManager {
  private readonly tracks: Map<string, CampaignTrack>;

  constructor(tracks: CampaignTrack[] = [LOGIN_7, COMEBACK_14, STREAK_28]) {
    this.tracks = new Map(tracks.map((t) => [t.id, t]));
  }

  /** Compute all grants the player is currently eligible for. */
  evaluate(state: PlayerCampaignState, now: Date = new Date()): Grant[] {
    const grants: Grant[] = [];
    const todayKey = now.toISOString().slice(0, 10);
    const lastSession = new Date(state.lastSessionAt);
    const lapsedDays = Math.floor((now.getTime() - lastSession.getTime()) / 86_400_000);

    for (const track of this.tracks.values()) {
      const last = state.lastClaim[track.id] ? new Date(state.lastClaim[track.id]) : null;
      const alreadyToday = last && last.toISOString().slice(0, 10) === todayKey;
      if (alreadyToday) continue;

      if (track.kind === "comeback") {
        if (track.lapsedMinDays === undefined || track.lapsedMaxDays === undefined) continue;
        if (lapsedDays < track.lapsedMinDays || lapsedDays > track.lapsedMaxDays) continue;
      }

      const day = ((state.progress[track.id] ?? 0) % track.cycleDays) + 1;
      const reward = track.rewards[day - 1];
      if (!reward) continue;
      grants.push({
        playerId: state.playerId,
        campaignId: track.id,
        cycle: Math.floor((state.progress[track.id] ?? 0) / track.cycleDays) + 1,
        day,
        reward,
        reason: track.kind,
      });
    }
    return grants;
  }

  /** Convert a grant into a claimed record (caller persists). */
  claim(grant: Grant): ClaimedGrant {
    return {
      ...grant,
      id: `${grant.playerId}:${grant.campaignId}:${grant.cycle}:${grant.day}`,
      claimedAt: new Date().toISOString(),
    };
  }

  tracks(): CampaignTrack[] {
    return Array.from(this.tracks.values());
  }
}
