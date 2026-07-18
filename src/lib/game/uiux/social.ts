/**
 * SEC10-UIUX (prompt 82): Social UI — player profiles + clans.
 *
 * Persistent player profile pages (stats, cosmetic showcase) + a
 * clan/guild system interface. The Clan + ClanMember models exist in
 * the schema from SEC1 — this module is the client-side data layer
 * that talks to the (forthcoming) /api/social/* endpoints + provides
 * a local-cache fallback so the UI works offline / in dev.
 *
 * Public API:
 *   - getPlayerProfile(playerId) → PlayerProfile (async, network-backed)
 *   - getClanProfile(clanId) → ClanProfile (async, network-backed)
 *   - searchPlayers(query) → PlayerSearchResult[] (async, network-backed)
 *   - getCachedPlayerProfile(playerId) — synchronous read from cache
 *   - clearSocialCache() — bust the cache
 *
 * SSR-safe: server-side calls return empty results without throwing.
 */

export interface PlayerProfileStats {
  kills: number;
  deaths: number;
  /** Kills / deaths ratio (0 if deaths === 0). */
  kd: number;
  wins: number;
  losses: number;
  matches: number;
  /** Win rate (0..1). */
  winRate: number;
  headshotRate: number;   // 0..1
  /** Total playtime in seconds. */
  playtimeSeconds: number;
  /** Highest killstreak ever achieved. */
  bestKillstreak: number;
  /** Credits currently held. */
  credits: number;
  /** Current battle pass tier. */
  battlePassTier: number;
}

export interface CosmeticShowcaseItem {
  slug: string;
  name: string;
  kind: "wrap" | "charm" | "finisher" | "skin";
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
  /** Whether this is the player's currently equipped item of this kind. */
  equipped: boolean;
}

export interface PlayerProfile {
  id: string;
  callsign: string;
  /** Player level (1..100) — derived from total XP. */
  level: number;
  /** Total XP earned. */
  xp: number;
  /** Clan id (or null if not in a clan). */
  clanId: string | null;
  /** Clan tag (or null). */
  clanTag: string | null;
  /** ISO-8601 timestamp of when the player first launched the game. */
  joinedAt: string;
  /** Last-seen ISO-8601 timestamp. */
  lastSeenAt: string;
  stats: PlayerProfileStats;
  /** Showcase — the cosmetics the player chooses to display (max 6). */
  showcase: CosmeticShowcaseItem[];
  /** Equipped loadout summary (weapon names). */
  equippedLoadout: {
    primary?: string;
    secondary?: string;
    melee?: string;
    utility?: string;
  };
}

export interface ClanProfile {
  id: string;
  tag: string;          // 3-5 char prefix, e.g. "AMK"
  name: string;
  level: number;
  xp: number;
  /** ISO-8601 timestamp of clan creation. */
  createdAt: string;
  members: ClanMember[];
  /** Clan-wide stats (sum of member stats). */
  aggregateStats: {
    totalKills: number;
    totalMatches: number;
    totalWins: number;
    totalPlaytimeSeconds: number;
  };
}

export interface ClanMember {
  playerId: string;
  callsign: string;
  role: "leader" | "officer" | "member";
  level: number;
  joinedAt: string;
  /** Last-seen ISO-8601 timestamp. */
  lastSeenAt: string;
  kills: number;
  matches: number;
}

export interface PlayerSearchResult {
  id: string;
  callsign: string;
  level: number;
  clanTag: string | null;
  /** Whether this player is online right now. */
  online: boolean;
}

// ─── Cache (LRU with TTL) ──────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000; // 30s — profiles change rarely but we want fresh-ish data
const profileCache = new Map<string, CacheEntry<PlayerProfile>>();
const clanCache = new Map<string, CacheEntry<ClanProfile>>();
const searchCache = new Map<string, CacheEntry<PlayerSearchResult[]>>();

function isCacheValid<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  if (!entry) return false;
  return entry.expiresAt > (typeof performance !== "undefined" ? performance.now() : Date.now());
}

function setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number = CACHE_TTL_MS): void {
  cache.set(key, {
    value,
    expiresAt: (typeof performance !== "undefined" ? performance.now() : Date.now()) + ttl,
  });
}

/**
 * SEC10-UIUX (prompt 82): Get a player's profile.
 *
 * Tries the network first (GET /api/social/profile?playerId=...). Falls
 * back to the cache if the network is unavailable. Returns null if
 * neither succeeds (e.g. SSR or unknown player).
 *
 * @param playerId Player id (or "me" for the current player).
 */
export async function getPlayerProfile(playerId: string): Promise<PlayerProfile | null> {
  // Check cache first.
  const cached = profileCache.get(playerId);
  if (isCacheValid(cached)) return cached.value;

  // Network fetch — wrap in try/catch so SSR + offline don't throw.
  if (typeof window !== "undefined") {
    try {
      const res = await fetch(`/api/social/profile?playerId=${encodeURIComponent(playerId)}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const profile = (await res.json()) as PlayerProfile;
        setCache(profileCache, playerId, profile);
        return profile;
      }
    } catch {
      /* network error — fall through to fallback */
    }
  }

  // Fallback — return a deterministic synthetic profile so the UI
  // always has something to render. This is intentionally *not* real
  // data; the network call is the source of truth. In production, the
  // server is expected to be available.
  if (playerId === "me" || playerId === "default") {
    const fallback = makeFallbackProfile(playerId);
    setCache(profileCache, playerId, fallback);
    return fallback;
  }

  return null;
}

/**
 * SEC10-UIUX (prompt 82): Get a clan's profile (members + aggregate stats).
 *
 * @param clanId Clan id (or "mine" for the current player's clan).
 */
export async function getClanProfile(clanId: string): Promise<ClanProfile | null> {
  const cached = clanCache.get(clanId);
  if (isCacheValid(cached)) return cached.value;

  if (typeof window !== "undefined") {
    try {
      const res = await fetch(`/api/social/clan?clanId=${encodeURIComponent(clanId)}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const clan = (await res.json()) as ClanProfile;
        setCache(clanCache, clanId, clan);
        return clan;
      }
    } catch {
      /* network error — fall through */
    }
  }

  // Fallback — synthetic clan data.
  if (clanId === "mine" || clanId === "default") {
    const fallback = makeFallbackClan(clanId);
    setCache(clanCache, clanId, fallback);
    return fallback;
  }

  return null;
}

/**
 * SEC10-UIUX (prompt 82): Search for players by callsign.
 *
 * @param query Search query (callsign prefix or full match).
 */
export async function searchPlayers(query: string): Promise<PlayerSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const cached = searchCache.get(trimmed);
  if (isCacheValid(cached)) return cached.value;

  if (typeof window !== "undefined") {
    try {
      const res = await fetch(`/api/social/search?q=${encodeURIComponent(trimmed)}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const results = (await res.json()) as PlayerSearchResult[];
        setCache(searchCache, trimmed, results);
        return results;
      }
    } catch {
      /* network error — fall through */
    }
  }

  // Fallback — return an empty list. The UI shows "No players found".
  return [];
}

/**
 * SEC10-UIUX (prompt 82): Synchronous cache-only read. Returns the
 * cached profile if present + fresh, else null. Used by React
 * components that need a value on first render (and will refetch
 * async via getPlayerProfile()).
 */
export function getCachedPlayerProfile(playerId: string): PlayerProfile | null {
  const cached = profileCache.get(playerId);
  return isCacheValid(cached) ? cached.value : null;
}

/** SEC10-UIUX (prompt 82): Synchronous cache-only read for clans. */
export function getCachedClanProfile(clanId: string): ClanProfile | null {
  const cached = clanCache.get(clanId);
  return isCacheValid(cached) ? cached.value : null;
}

/** SEC10-UIUX (prompt 82): Bust the entire social cache. */
export function clearSocialCache(): void {
  profileCache.clear();
  clanCache.clear();
  searchCache.clear();
}

// ─── Fallback synthetic data (for offline / SSR / dev) ──────────────────────

function makeFallbackProfile(playerId: string): PlayerProfile {
  return {
    id: playerId,
    callsign: playerId === "me" ? "Operator" : "Recruit",
    level: 7,
    xp: 5400,
    clanId: null,
    clanTag: null,
    joinedAt: "2024-01-15T00:00:00.000Z",
    lastSeenAt: new Date().toISOString(),
    stats: {
      kills: 248,
      deaths: 156,
      kd: 1.59,
      wins: 18,
      losses: 24,
      matches: 42,
      winRate: 0.429,
      headshotRate: 0.22,
      playtimeSeconds: 36_000,
      bestKillstreak: 14,
      credits: 8400,
      battlePassTier: 23,
    },
    showcase: [
      { slug: "gold_damascus", name: "Gold Damascus", kind: "wrap", rarity: "LEGENDARY", equipped: true },
      { slug: "shark_charm", name: "Shark Charm", kind: "charm", rarity: "LEGENDARY", equipped: true },
      { slug: "shark", name: "Shark Finisher", kind: "finisher", rarity: "LEGENDARY", equipped: true },
    ],
    equippedLoadout: {
      primary: "AK-74",
      secondary: "USP-S",
      melee: "Knife",
      utility: "Bandage",
    },
  };
}

function makeFallbackClan(clanId: string): ClanProfile {
  const now = new Date().toISOString();
  return {
    id: clanId,
    tag: "AMK",
    name: "Alpha Mike Kilo",
    level: 12,
    xp: 84_500,
    createdAt: "2024-02-01T00:00:00.000Z",
    members: [
      { playerId: "p1", callsign: "Ghost", role: "leader", level: 87, joinedAt: "2024-02-01T00:00:00.000Z", lastSeenAt: now, kills: 4521, matches: 312 },
      { playerId: "p2", callsign: "Roach", role: "officer", level: 64, joinedAt: "2024-02-03T00:00:00.000Z", lastSeenAt: now, kills: 3210, matches: 245 },
      { playerId: "p3", callsign: "Soap", role: "member", level: 41, joinedAt: "2024-02-10T00:00:00.000Z", lastSeenAt: now, kills: 1842, matches: 138 },
    ],
    aggregateStats: {
      totalKills: 9573,
      totalMatches: 695,
      totalWins: 412,
      totalPlaytimeSeconds: 540_000,
    },
  };
}
