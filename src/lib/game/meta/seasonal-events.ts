/**
 * SEC11-META — Seasonal events with unique modes and rewards.
 *
 * Drives time-boxed in-game events (winter holiday, Halloween, summer
 * anniversary, etc.) each with its own game-mode override, questline, and
 * reward track. The event calendar is data-driven — adding a new season
 * is one config object, no code changes.
 *
 * Events are evaluated against the current server time so a single call
 * to `SeasonalEventManager.active(now)` returns the live event for any
 * client. Each event carries a unique `modeId` that the gameplay layer
 * uses to swap weapon/round rules.
 *
 * Public API:
 *   - `SeasonalEventManager.register(event)` → void
 *   - `SeasonalEventManager.active(now)` → Event | null
 *   - `SeasonalEventManager.upcoming(now, limit)` → Event[]
 *   - `SeasonalEventManager.track(event, day)` → DayReward | null
 */

export type EventModeId =
  | "standard"
  | "snowball_arsenal"
  | "triple_threat"
  | "anniversary_bash"
  | "summer_showdown"
  | "zombie_horde";

export interface EventReward {
  softCurrency?: number;
  hardCurrency?: number;
  cosmeticSku?: string;
  battlePassXp?: number;
}

export interface EventQuest {
  id: string;
  description: string;
  target: number;
  metric: "kills" | "wins" | "matches" | "headshots";
  reward: EventReward;
}

export interface GameEvent {
  id: string;
  name: string;
  modeId: EventModeId;
  startsAt: string;
  endsAt: string;
  /** Daily reward track — length determines event length in days. */
  dailyRewards: EventReward[];
  quests: EventQuest[];
  cosmeticBundleSku?: string;
  /** Battle Pass XP multiplier active during the event (1 = none). */
  bpXpMultiplier?: number;
}

export class SeasonalEventManager {
  private readonly events = new Map<string, GameEvent>();

  constructor(seed: GameEvent[] = []) {
    for (const e of seed) this.events.set(e.id, e);
  }

  register(event: GameEvent): void {
    this.events.set(event.id, event);
  }

  /** Return the event active at the given time (or null). */
  active(now: Date = new Date()): GameEvent | null {
    const t = now.getTime();
    for (const e of this.events.values()) {
      const start = new Date(e.startsAt).getTime();
      const end = new Date(e.endsAt).getTime();
      if (t >= start && t <= end) return e;
    }
    return null;
  }

  /** Future events sorted by start time. */
  upcoming(now: Date = new Date(), limit = 5): GameEvent[] {
    const t = now.getTime();
    return Array.from(this.events.values())
      .filter((e) => new Date(e.startsAt).getTime() > t)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
      .slice(0, limit);
  }

  /** Get the reward for a specific day-in-event (1-indexed). */
  track(event: GameEvent, day: number): EventReward | null {
    return event.dailyRewards[day - 1] ?? null;
  }

  /** Compute the active day index (1-indexed) of an event, or 0 if not active. */
  activeDay(event: GameEvent, now: Date = new Date()): number {
    const t = now.getTime();
    const start = new Date(event.startsAt).getTime();
    const end = new Date(event.endsAt).getTime();
    if (t < start || t > end) return 0;
    return Math.floor((t - start) / 86_400_000) + 1;
  }

  /** List all events (active + scheduled + past). */
  list(): GameEvent[] {
    return Array.from(this.events.values()).sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
  }
}
