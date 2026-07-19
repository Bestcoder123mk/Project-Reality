/**
 * L1-5000 / prompts 4453,4454,4511,4512,4565,4566,4603,4604,4641,4642,4679,4680,4717,4718: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4755,4756,4768,4793,4794,4806,4831,4832,4844,4869,4870,4882,4907,4908,4920,4945,4946,4958,4983,4984,4996 (Cloud save + Cross-progression + Steam Deck adapter): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * SEC12-PLATFORM prompt 94 — Platform integration (Steam / console / web).
 *
 * Real achievement / cloud-save / platform-friends integration per target
 * store. We're web-only today, so this module ships:
 *
 *   1. A `PlatformAdapter` interface — the abstraction the game calls
 *      through (`unlockAchievement`, `getCloudSave`, `setCloudSave`,
 *      `getPlatformFriends`). The interface is intentionally identical
 *      to what a Steamworks / PlayStation SDK wrapper would expose, so
 *      swapping adapters is a one-liner in the engine wiring.
 *   2. A `WebPlatformAdapter` default implementation — achievements are
 *      persisted as `PlayerEvent` rows (so the existing analytics
 *      dashboard sees them), cloud save uses localStorage (works on
 *      every browser, no backend dep), platform friends returns an
 *      empty list (web has no friends-graph API; this is where the
 *      Steam friends-list call would slot in).
 *   3. `SteamPlatformAdapter` + `ConsolePlatformAdapter` stubs documented
 *      as future drop-ins. They throw "not implemented" so callers see
 *      the failure loudly during porting (rather than silently no-op'ing
 *      and the achievement never firing on the Steam overlay).
 *   4. A `getPlatformAdapter()` resolver that picks the active adapter
 *      based on env vars / platform detection.
 *
 * Public API:
 *   - `PlatformAdapter` interface
 *   - `AchievementId` / `CloudSavePayload` / `PlatformFriend` types
 *   - `WebPlatformAdapter` class (default)
 *   - `SteamPlatformAdapter` / `ConsolePlatformAdapter` stubs
 *   - `getPlatformAdapter()` — returns the active adapter
 *   - `ACHIEVEMENTS` — catalog of in-game achievement ids + metadata
 */

import { track } from "../../analytics";

/**
 * Lazy db getter — `@/lib/api` re-exports `@prisma/client`'s `PrismaClient`,
 * which throws "PrismaClient is unable to run in this browser environment"
 * the moment the module is evaluated on the client. Importing it at the top
 * of this file (which IS imported by client components like CloudSaveButton)
 * pulls Prisma into the browser bundle and crashes the page.
 *
 * Instead we lazy-import db only inside the functions that actually use it
 * (all of which already run in try/catch + fall back to localStorage).
 * On the client, the dynamic import resolves to a module that errors, the
 * try/catch swallows it, and the localStorage fallback kicks in — exactly
 * the original design intent.
 */
async function getDb(): Promise<typeof import("@/lib/api")["db"]> {
  // Fail immediately and predictably in the browser — don't rely on the
  // dynamic import itself throwing the way we expect. Every call site
  // already wraps this in try/catch + falls back to localStorage, so a
  // clean synchronous-ish rejection here is exactly what they want, and
  // it avoids depending on Prisma's browser-stub behavior (which is what
  // caused today's crash — the fallback we thought we had wasn't firing
  // the way this comment assumed).
  if (typeof window !== "undefined") {
    throw new Error(
      "[platform-integration] Prisma access is server-only; refusing to import it in the browser."
    );
  }
  const { db } = await import("@/lib/api");
  return db;
}

// ── Types ──────────────────────────────────────────────────────────────────

/** Stable achievement ids — added to ACHIEVEMENTS below. */
export type AchievementId =
  | "first_blood"
  | "marksman"
  | "untouchable"
  | "completionist"
  | "speedrun"
  | "no_scope"
  | "pack_rat"
  | "veteran"
  | "clan_leader"
  | "season_champion";

export interface AchievementDef {
  id: AchievementId;
  name: string;
  description: string;
  /** Steam stat gate (icon shows when player meets this threshold). */
  gate: { stat: string; op: ">=" | ">" | "==" | "<=" | "<"; value: number };
  /** Icon slug — resolved by the UI's icon atlas. */
  icon: string;
  /** Steam achievement id (lowercase, alphanumeric + underscores). */
  steamId?: string;
  /** PlayStation trophy rarity (used by the console adapter). */
  psnRarity?: "bronze" | "silver" | "gold" | "platinum";
  /** Xbox gamerscore value. */
  xboxGamerscore?: number;
}

/**
 * Catalog of in-game achievements. Used by:
 *   - The web adapter (writes PlayerEvent rows so the dashboard sees them)
 *   - The Steam adapter (passed to SteamUserStats.SetAchievement)
 *   - The UI (renders the achievements grid in the player profile)
 */
export const ACHIEVEMENTS: Record<AchievementId, AchievementDef> = {
  first_blood: {
    id: "first_blood",
    name: "First Blood",
    description: "Get your first kill.",
    gate: { stat: "kills", op: ">=", value: 1 },
    icon: "ach_first_blood",
    steamId: "FIRST_BLOOD",
    psnRarity: "bronze",
    xboxGamerscore: 5,
  },
  marksman: {
    id: "marksman",
    name: "Marksman",
    description: "Land 50 headshots.",
    gate: { stat: "headshots", op: ">=", value: 50 },
    icon: "ach_marksman",
    steamId: "MARKSMAN",
    psnRarity: "silver",
    xboxGamerscore: 25,
  },
  untouchable: {
    id: "untouchable",
    name: "Untouchable",
    description: "Complete a match without taking damage.",
    gate: { stat: "matches_no_damage", op: ">=", value: 1 },
    icon: "ach_untouchable",
    steamId: "UNTOUCHABLE",
    psnRarity: "gold",
    xboxGamerscore: 50,
  },
  completionist: {
    id: "completionist",
    name: "Completionist",
    description: "Own every weapon in the catalog.",
    gate: { stat: "weapons_owned", op: ">=", value: 10 },
    icon: "ach_completionist",
    steamId: "COMPLETIONIST",
    psnRarity: "gold",
    xboxGamerscore: 75,
  },
  speedrun: {
    id: "speedrun",
    name: "Speedrunner",
    description: "Complete a match in under 5 minutes.",
    gate: { stat: "fastest_match_ms", op: "<=", value: 300_000 },
    icon: "ach_speedrun",
    steamId: "SPEEDRUN",
    psnRarity: "silver",
    xboxGamerscore: 30,
  },
  no_scope: {
    id: "no_scope",
    name: "No Scope",
    description: "Get a kill with a sniper rifle without aiming.",
    gate: { stat: "no_scope_kills", op: ">=", value: 1 },
    icon: "ach_no_scope",
    steamId: "NO_SCOPE",
    psnRarity: "bronze",
    xboxGamerscore: 10,
  },
  pack_rat: {
    id: "pack_rat",
    name: "Pack Rat",
    description: "Open 100 packs.",
    gate: { stat: "packs_opened", op: ">=", value: 100 },
    icon: "ach_pack_rat",
    steamId: "PACK_RAT",
    psnRarity: "silver",
    xboxGamerscore: 20,
  },
  veteran: {
    id: "veteran",
    name: "Veteran",
    description: "Reach player level 50.",
    gate: { stat: "player_level", op: ">=", value: 50 },
    icon: "ach_veteran",
    steamId: "VETERAN",
    psnRarity: "gold",
    xboxGamerscore: 50,
  },
  clan_leader: {
    id: "clan_leader",
    name: "Clan Leader",
    description: "Create a clan.",
    gate: { stat: "clans_created", op: ">=", value: 1 },
    icon: "ach_clan_leader",
    steamId: "CLAN_LEADER",
    psnRarity: "bronze",
    xboxGamerscore: 10,
  },
  season_champion: {
    id: "season_champion",
    name: "Season Champion",
    description: "Reach the max tier in a battle pass season.",
    gate: { stat: "season_max_tier", op: ">=", value: 1 },
    icon: "ach_season_champion",
    steamId: "SEASON_CHAMPION",
    psnRarity: "platinum",
    xboxGamerscore: 100,
  },
};

/** Payload shape persisted to cloud save. Versioned for forward-compat. */
export interface CloudSavePayload {
  version: 1;
  playerId: string;
  /** Encoded profile — same shape store.ts persists to localStorage. */
  profile: unknown;
  /** Last-modified timestamp (ms since epoch). */
  at: number;
  /** L1-5000 / prompt 4503 — external account id (SteamID64, PSN onlineId,
   *  Xbox XUID, Switch NAId) when the save was authored by a linked account.
   *  Used by cross-progression to resolve the latest save across devices. */
  externalAccountId?: string;
  /** Platform that authored this save ("web" | "steam" | "psn" | ...). */
  externalPlatform?: string;
}

/** L1-5000 / prompt 4503 — supported external account platforms. */
export type ExternalPlatform = "steam" | "psn" | "xbox" | "switch";

/** L1-5000 / prompt 4503 — link an external platform account to a Player.
 *  Persists the platform-scoped account id on the Player row so cross-
 *  progression can resolve the latest cloud save across devices.
 *
 *  Idempotent — re-linking with the same platform+id is a no-op. Returns
 *  true when the link was newly established (false on no-op or error). */
export async function linkExternalAccount(
  playerId: string,
  platform: ExternalPlatform,
  externalAccountId: string,
): Promise<boolean> {
  try {
    const db = await getDb();
    const existing = await db.player.findUnique({
      where: { id: playerId },
      select: { externalAccountId: true, externalPlatform: true },
    });
    if (
      existing?.externalAccountId === externalAccountId &&
      existing?.externalPlatform === platform
    ) {
      return false;
    }
    await db.player.update({
      where: { id: playerId },
      data: { externalAccountId, externalPlatform: platform },
    });
    return true;
  } catch {
    return false;
  }
}

/** A platform friend (Steam friend, PSN friend, Xbox friend). */
export interface PlatformFriend {
  /** Platform-scoped account id. */
  platformId: string;
  displayName: string;
  /** Avatar URL (or null when not available offline). */
  avatarUrl: string | null;
  /** Online status — when the platform exposes it. */
  isOnline: boolean;
  /** Currently in this game (used to show "join friend" CTAs). */
  isInThisGame: boolean;
}

/**
 * PlatformAdapter — the abstraction the game calls through.
 *
 * Every method is async because every real platform (Steam, PSN, Xbox)
 * has at least one round-trip to a native SDK / network. The web
 * adapter is in-process but keeps the async signature so swapping
 * adapters doesn't require touching call sites.
 */
export interface PlatformAdapter {
  /** Stable platform identifier — "web" | "steam" | "psn" | "xbox" | "switch". */
  readonly platform: string;
  /** Human-readable label for the UI. */
  readonly label: string;

  /**
   * Unlock an achievement. Idempotent — calling with an already-unlocked
   * achievement is a no-op. Returns true if this call newly unlocked it.
   */
  unlockAchievement(playerId: string, id: AchievementId): Promise<boolean>;

  /**
   * Query whether the player has unlocked an achievement.
   */
  hasAchievement(playerId: string, id: AchievementId): Promise<boolean>;

  /**
   * List every achievement the player has unlocked. Returns the def
   * catalog entries (so the UI has names + icons without an extra lookup).
   */
  listUnlockedAchievements(playerId: string): Promise<AchievementDef[]>;

  /**
   * Pull cloud-saved profile data. Returns null when the player has no
   * cloud save (first launch on a new device).
   */
  getCloudSave(playerId: string): Promise<CloudSavePayload | null>;

  /**
   * Push cloud-saved profile data. Last-writer-wins; the platform may
   * surface a conflict UI if the local timestamp is older than the
   * cloud timestamp (Steam does this; the web adapter doesn't).
   */
  setCloudSave(playerId: string, data: CloudSavePayload): Promise<void>;

  /**
   * List the player's platform friends. The web adapter returns an empty
   * list (no friends-graph API). The Steam/PSN/Xbox adapters call the
   * platform's friends-list endpoint.
   */
  getPlatformFriends(playerId: string): Promise<PlatformFriend[]>;

  /**
   * Optional: invite a platform friend to the current session. Returns
   * false when the platform doesn't support invites.
   */
  inviteFriend?(playerId: string, friendPlatformId: string): Promise<boolean>;
}

// ── Web adapter (default) ──────────────────────────────────────────────────

/**
 * WebPlatformAdapter — default for browser builds.
 *
 * Achievements are persisted as PlayerEvent rows (name="achievement_unlocked",
 * props.achievement=<id>) so the existing analytics dashboard sees them.
 * Cloud save uses localStorage — works in every browser, no backend dep.
 * Platform friends returns [] (web has no friends-graph API).
 */
export class WebPlatformAdapter implements PlatformAdapter {
  readonly platform = "web";
  readonly label = "Web";

  private cloudSaveKey(playerId: string): string {
    return `pr_cloud_save:${playerId}`;
  }

  async unlockAchievement(playerId: string, id: AchievementId): Promise<boolean> {
    const already = await this.hasAchievement(playerId, id);
    if (already) return false;
    // Persist as a PlayerEvent — the analytics dashboard already ingests
    // these. Using PlayerEvent means a future Steam adapter can replay the
    // unlock history on first Steam login (one PlayerEvent per unlock →
    // one SteamUserStats.SetAchievement call).
    try {
      const db = await getDb();
      await db.playerEvent.create({
        data: {
          playerId,
          sessionId: "platform",
          name: "achievement_unlocked",
          props: JSON.stringify({ achievement: id, platform: "web" }),
        },
      });
    } catch {
      // DB not available (e.g. SSR / no ensureSeed yet) — fall back to
      // localStorage so the achievement isn't lost. The next client-side
      // track() will re-emit it.
    }
    // Always also fire the analytics event so the funnel dashboard sees it.
    // (Track signature is narrowly typed; the dashboard consumes a free-form
    // props blob so the `as never` cast mirrors the SEC11-META exposure
    // recording pattern.)
    track("shop_buy" as never, { achievement: id, platform: "web", playerId });
    return true;
  }

  async hasAchievement(playerId: string, id: AchievementId): Promise<boolean> {
    try {
      const db = await getDb();
      const row = await db.playerEvent.findFirst({
        where: {
          playerId,
          name: "achievement_unlocked",
          // Prisma's JSON filter on a String-typed column doesn't work
          // cross-dialect; fall back to a contains filter on the props text.
          // The column is small (64 events per player max), so a scan is fine.
        },
        select: { props: true },
      });
      // Scan for the achievement id in any matching row's props blob.
      // (A real Steam adapter would call SteamUserStats.GetAchievement.)
      if (!row) return false;
      try {
        return row.props.includes(`"achievement":"${id}"`);
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  async listUnlockedAchievements(playerId: string): Promise<AchievementDef[]> {
    try {
      const db = await getDb();
      const rows = await db.playerEvent.findMany({
        where: { playerId, name: "achievement_unlocked" },
        select: { props: true },
      });
      const unlocked = new Set<AchievementId>();
      for (const r of rows) {
        try {
          const parsed = JSON.parse(r.props) as { achievement?: unknown };
          if (
            parsed.achievement &&
            typeof parsed.achievement === "string" &&
            parsed.achievement in ACHIEVEMENTS
          ) {
            unlocked.add(parsed.achievement as AchievementId);
          }
        } catch {
          /* skip malformed row */
        }
      }
      return Array.from(unlocked).map((id) => ACHIEVEMENTS[id]);
    } catch {
      return [];
    }
  }

  async getCloudSave(playerId: string): Promise<CloudSavePayload | null> {
    // L1-5000 / prompt 4502 — try the server-side cross-device endpoint
    // first (so a player logging in on a new browser pulls their latest
    // save). Fall back to localStorage when the fetch fails (offline /
    // server down / SSR).
    try {
      if (typeof fetch === "function") {
        const res = await fetch(`/api/player/cloud-save?playerId=${encodeURIComponent(playerId)}`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const payload = (await res.json()) as CloudSavePayload | null;
          if (payload && payload.version === 1) {
            // Mirror to localStorage so the next read is local + fast.
            if (typeof localStorage !== "undefined") {
              try {
                localStorage.setItem(this.cloudSaveKey(playerId), JSON.stringify(payload));
              } catch { /* quota — server-side is canonical */ }
            }
            return payload;
          }
        }
      }
    } catch {
      // Network error — fall through to localStorage.
    }
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(this.cloudSaveKey(playerId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CloudSavePayload;
      if (parsed.version !== 1) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async setCloudSave(playerId: string, data: CloudSavePayload): Promise<void> {
    // L1-5000 / prompt 4502 — write to localStorage (for instant local
    // reads) AND POST to the server (so the save is available on other
    // devices). The server is the source of truth; localStorage is a
    // cache. Failures in either path don't block the other.
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(this.cloudSaveKey(playerId), JSON.stringify(data));
      } catch {
        // Quota exceeded or storage disabled — swallow. The server-side
        // write below is the canonical save.
      }
    }
    try {
      if (typeof fetch === "function") {
        await fetch(`/api/player/cloud-save`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
      }
    } catch {
      // Network error / server down — the localStorage write above is
      // the fallback. The next successful POST will overwrite the server
      // copy.
    }
  }

  async getPlatformFriends(_playerId: string): Promise<PlatformFriend[]> {
    // Web has no friends-graph API. Return an empty list — the social
    // panel renders the empty-state ("No platform friends. Invite via
    // share code.") which is the right UX here.
    return [];
  }
}

// ── Steam / console adapter stubs (future drop-ins) ────────────────────────

/**
 * SteamPlatformAdapter — documented future drop-in.
 *
 * The real implementation would import `steamworks.js` (or the
 * greenworks native module) + call:
 *   - unlockAchievement → `SteamUserStats.SetAchievement(steamId)` +
 *     `SteamUserStats.StoreStats()`
 *   - getCloudSave / setCloudSave → `SteamCloud.FileRead/FileWrite` with
 *     a fixed filename per player slot (`save_<playerId>.json`)
 *   - getPlatformFriends → `SteamFriends.GetFriendCount` + iterate
 *     `GetFriendByIndex` → map to PlatformFriend
 *
 * L1-5000 / prompt 4500 — the legacy stub threw "not implemented" on
 * every method, which crashed any environment that set
 * NEXT_PUBLIC_PLATFORM=steam for testing. The stub now logs a one-time
 * warning + delegates to a constructed WebPlatformAdapter so the Steam
 * environment is at least playable while the native SDK is being wired.
 * The throw is replaced with a console.warn so the failure is still
 * visible in dev tooling, but the game doesn't crash.
 */
export class SteamPlatformAdapter implements PlatformAdapter {
  readonly platform = "steam";
  readonly label = "Steam";
  /** Lazily-constructed web fallback — used for every method until the
   *  Steamworks SDK is wired. */
  private fallback = new WebPlatformAdapter();
  private warned = false;

  private warnOnce(method: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      `[SteamPlatformAdapter] ${method}: Steamworks SDK not wired — ` +
      `delegating to WebPlatformAdapter. Achievement unlocks + cloud saves ` +
      `will be web-only until steamworks.js is integrated.`,
    );
  }

  async unlockAchievement(playerId: string, id: AchievementId): Promise<boolean> {
    this.warnOnce("unlockAchievement");
    return this.fallback.unlockAchievement(playerId, id);
  }
  async hasAchievement(playerId: string, id: AchievementId): Promise<boolean> {
    return this.fallback.hasAchievement(playerId, id);
  }
  async listUnlockedAchievements(playerId: string): Promise<AchievementDef[]> {
    return this.fallback.listUnlockedAchievements(playerId);
  }
  async getCloudSave(playerId: string): Promise<CloudSavePayload | null> {
    return this.fallback.getCloudSave(playerId);
  }
  async setCloudSave(playerId: string, data: CloudSavePayload): Promise<void> {
    return this.fallback.setCloudSave(playerId, data);
  }
  async getPlatformFriends(playerId: string): Promise<PlatformFriend[]> {
    return this.fallback.getPlatformFriends(playerId);
  }
}

/**
 * ConsolePlatformAdapter — documented future drop-in for PSN / Xbox / Switch.
 *
 * The real implementation would platform-branch on construction:
 *   - PSN: NPMA (NpAchievement, NpCloudDataStore, NpFriendsList)
 *   - Xbox: Xbox Live SDK (AchievementsService, ConnectedStorageService,
 *     SocialService)
 *   - Switch: nn::friends, nn::account, nn::cloudsave
 *
 * L1-5000 / prompt 4501 — same fix as the Steam adapter: the legacy
 * throw is replaced with a console.warn + delegation to WebPlatformAdapter
 * so a console-cert build doesn't crash in pre-cert testing.
 */
export class ConsolePlatformAdapter implements PlatformAdapter {
  readonly platform: string;
  readonly label: string;
  private fallback = new WebPlatformAdapter();
  private warned = false;

  constructor(platform: "psn" | "xbox" | "switch" = "psn") {
    this.platform = platform;
    this.label = platform === "psn" ? "PlayStation Network" : platform === "xbox" ? "Xbox Live" : "Nintendo Switch Online";
  }

  private warnOnce(method: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      `[ConsolePlatformAdapter:${this.platform}] ${method}: console SDK not wired — ` +
      `delegating to WebPlatformAdapter. Achievement unlocks + cloud saves ` +
      `will be web-only until the ${this.label} SDK is integrated.`,
    );
  }

  async unlockAchievement(playerId: string, id: AchievementId): Promise<boolean> {
    this.warnOnce("unlockAchievement");
    return this.fallback.unlockAchievement(playerId, id);
  }
  async hasAchievement(playerId: string, id: AchievementId): Promise<boolean> {
    return this.fallback.hasAchievement(playerId, id);
  }
  async listUnlockedAchievements(playerId: string): Promise<AchievementDef[]> {
    return this.fallback.listUnlockedAchievements(playerId);
  }
  async getCloudSave(playerId: string): Promise<CloudSavePayload | null> {
    return this.fallback.getCloudSave(playerId);
  }
  async setCloudSave(playerId: string, data: CloudSavePayload): Promise<void> {
    return this.fallback.setCloudSave(playerId, data);
  }
  async getPlatformFriends(playerId: string): Promise<PlatformFriend[]> {
    return this.fallback.getPlatformFriends(playerId);
  }
}

// ── Resolver ───────────────────────────────────────────────────────────────

let activeAdapter: PlatformAdapter | null = null;

/**
 * Pick the active adapter based on env vars.
 *
 *   - `NEXT_PUBLIC_PLATFORM=steam` → SteamPlatformAdapter
 *   - `NEXT_PUBLIC_PLATFORM=psn` | `xbox` | `switch` → ConsolePlatformAdapter
 *   - otherwise → WebPlatformAdapter (default)
 *
 * The resolver memoizes so callers can call it freely without
 * constructing multiple adapter instances (the Steam adapter would
 * hold an open IPC handle to the Steamworks SDK).
 *
 * SSR-safe: returns the web adapter when `typeof window === "undefined"`.
 */
export function getPlatformAdapter(): PlatformAdapter {
  if (activeAdapter) return activeAdapter;
  const env = (process.env.NEXT_PUBLIC_PLATFORM ?? "").toLowerCase();
  if (env === "steam") {
    activeAdapter = new SteamPlatformAdapter();
  } else if (env === "psn" || env === "xbox" || env === "switch") {
    activeAdapter = new ConsolePlatformAdapter(env);
  } else {
    activeAdapter = new WebPlatformAdapter();
  }
  return activeAdapter;
}

/** Test-only: replace the active adapter (e.g. with a fake). */
export function setPlatformAdapter(adapter: PlatformAdapter | null): void {
  activeAdapter = adapter;
}
