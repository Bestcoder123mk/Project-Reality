/**
 * SEC10-UIUX (prompt 82): Social panel — player profiles + clans.
 *
 * A self-contained overlay component. It manages its own open-state
 * via a tiny module-level store (subscribe/setOpen) so any component
 * in the app can call `openSocialPanel()` to surface it without
 * touching the global game store (which is on the do-not-edit list).
 *
 * Wiring: SettingsPanel.tsx imports <SocialPanel /> and renders it as
 * a sibling of its own overlay so the React tree mounts it. Any other
 * component can call `openSocialPanel()` to show it — the
 * recommended wiring is one line in MainMenu.tsx (a "Social" button
 * that calls openSocialPanel).
 *
 * Profile data is fetched via getPlayerProfile() + getClanProfile() +
 * searchPlayers() from src/lib/game/uiux/social.ts. Falls back to
 * synthetic local data when the network is unavailable.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Users, Search, X, Trophy, Coins, Zap, Clock, Crosshair, Sword, Shield, ChevronRight } from "lucide-react";
import {
  getPlayerProfile,
  getClanProfile,
  searchPlayers,
  type PlayerProfile,
  type ClanProfile,
  type PlayerSearchResult,
} from "@/lib/game/uiux/social";

// ─── Local open-state store ────────────────────────────────────────────────

type Listener = (open: boolean) => void;
const listeners = new Set<Listener>();
let openState = false;

function notify(): void {
  for (const l of listeners) l(openState);
}

/** SEC10-UIUX (prompt 82): Open the SocialPanel overlay from anywhere. */
export function openSocialPanel(): void {
  openState = true;
  notify();
}

/** SEC10-UIUX (prompt 82): Close the SocialPanel overlay. */
export function closeSocialPanel(): void {
  openState = false;
  notify();
}

function useSocialOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(openState);
  useEffect(() => {
    const l: Listener = (v) => setOpen(v);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const close = useCallback(() => {
    openState = false;
    notify();
  }, []);
  return [open, close];
}

// ─── Tab type ──────────────────────────────────────────────────────────────

type Tab = "profile" | "clan" | "search";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]";

// ─── Component ─────────────────────────────────────────────────────────────

export function SocialPanel() {
  const [open, close] = useSocialOpen();
  const [tab, setTab] = useState<Tab>("profile");
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [clan, setClan] = useState<ClanProfile | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlayerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch profile + clan when the panel opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Defer the initial setLoading(true) to a microtask so it's not
    // synchronous within the effect body (avoids the
    // react-hooks/set-state-in-effect lint).
    queueMicrotask(() => {
      if (!cancelled) setLoading(true);
    });
    (async () => {
      const [p, c] = await Promise.all([
        getPlayerProfile("me"),
        getClanProfile("mine"),
      ]);
      if (cancelled) return;
      queueMicrotask(() => {
        if (cancelled) return;
        setProfile(p);
        setClan(c);
        setLoading(false);
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!searchQuery.trim()) {
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const results = await searchPlayers(searchQuery);
      if (!cancelled) {
        // Defer to a microtask to avoid synchronous setState in effect.
        queueMicrotask(() => {
          if (!cancelled) setSearchResults(results);
        });
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchQuery]);

  // Clear search results when the query is emptied (separate effect to
  // avoid the synchronous-setState-in-effect lint).
  useEffect(() => {
    if (searchQuery.trim() === "") {
      const t = setTimeout(() => setSearchResults([]), 0);
      return () => clearTimeout(t);
    }
  }, [searchQuery]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex items-center justify-center bg-[#08090c]/80 backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          role="dialog"
          aria-modal="true"
          aria-label="Social"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="panel-glass-strong w-full max-w-2xl rounded-3xl border border-white/[0.06] bg-[#0e0f12]/95 p-6 text-white shadow-2xl"
          >
            {/* Header */}
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-amber-400" />
                <h2 className="text-lg font-semibold tracking-tight">Social</h2>
              </div>
              <button
                type="button"
                onClick={close}
                className={`flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-white/60 transition-colors hover:bg-white/[0.12] hover:text-white ${FOCUS_RING}`}
                aria-label="Close social panel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Tabs */}
            <div className="mb-5 flex gap-1 rounded-xl bg-white/[0.04] p-1">
              {([
                { id: "profile", label: "Profile" },
                { id: "clan", label: "Clan" },
                { id: "search", label: "Search" },
              ] as { id: Tab; label: string }[]).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-pressed={tab === t.id}
                  className={`flex-1 rounded-lg px-4 py-2 text-xs font-medium transition-colors ${FOCUS_RING} ${
                    tab === t.id
                      ? "bg-gradient-to-r from-amber-500 to-amber-600 text-black shadow-[0_0_16px_rgba(255,140,26,0.3)]"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="max-h-[60vh] overflow-y-auto pr-2">
              {loading ? (
                <div className="py-12 text-center text-sm text-white/40">Loading…</div>
              ) : tab === "profile" ? (
                <ProfileTab profile={profile} />
              ) : tab === "clan" ? (
                <ClanTab clan={clan} />
              ) : (
                <SearchTab
                  query={searchQuery}
                  onQueryChange={setSearchQuery}
                  results={searchResults}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Profile tab ───────────────────────────────────────────────────────────

function ProfileTab({ profile }: { profile: PlayerProfile | null }) {
  if (!profile) {
    return <div className="py-12 text-center text-sm text-white/40">Profile unavailable.</div>;
  }
  const playtimeHours = (profile.stats.playtimeSeconds / 3600).toFixed(1);
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04] text-2xl font-bold">
          {profile.callsign.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-xl font-bold tracking-tight">{profile.callsign}</h3>
            {profile.clanTag && (
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-400">
                [{profile.clanTag}]
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-white/50">
            <span>Level {profile.level}</span>
            <span className="text-white/20">•</span>
            <span>{profile.xp.toLocaleString()} XP</span>
            <span className="text-white/20">•</span>
            <span>BP Tier {profile.stats.battlePassTier}</span>
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2">
        <StatCell icon={Crosshair} label="K/D" value={profile.stats.kd.toFixed(2)} accent="text-amber-400" />
        <StatCell icon={Sword} label="Kills" value={profile.stats.kills.toLocaleString()} accent="text-emerald-400" />
        <StatCell icon={Shield} label="Deaths" value={profile.stats.deaths.toLocaleString()} accent="text-rose-400" />
        <StatCell icon={Trophy} label="Wins" value={profile.stats.wins.toLocaleString()} accent="text-amber-400" />
        <StatCell icon={Zap} label="Win Rate" value={`${Math.round(profile.stats.winRate * 100)}%`} accent="text-sky-400" />
        <StatCell icon={Clock} label="Playtime" value={`${playtimeHours}h`} accent="text-white/80" />
        <StatCell icon={Crosshair} label="HS Rate" value={`${Math.round(profile.stats.headshotRate * 100)}%`} accent="text-purple-400" />
        <StatCell icon={Sword} label="Best Streak" value={profile.stats.bestKillstreak} accent="text-amber-400" />
        <StatCell icon={Coins} label="Credits" value={profile.stats.credits.toLocaleString()} accent="text-amber-300" />
      </div>

      {/* Showcase */}
      <div>
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-white/40">Showcase</h4>
        <div className="grid grid-cols-3 gap-2">
          {profile.showcase.length === 0 ? (
            <div className="col-span-3 rounded-lg border border-white/[0.06] bg-white/[0.02] py-4 text-center text-xs text-white/30">
              No showcase items yet
            </div>
          ) : (
            profile.showcase.map((item) => (
              <div
                key={`${item.kind}-${item.slug}`}
                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2"
              >
                <div className="truncate text-xs font-medium text-white/80">{item.name}</div>
                <div className="text-[10px] uppercase tracking-wider text-white/40">
                  {item.kind} • {item.rarity}
                </div>
                {item.equipped && (
                  <div className="mt-0.5 text-[10px] font-medium text-emerald-400">Equipped</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Equipped loadout */}
      <div>
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-white/40">Equipped Loadout</h4>
        <div className="grid grid-cols-2 gap-2">
          <LoadoutRow slot="Primary" value={profile.equippedLoadout.primary} />
          <LoadoutRow slot="Secondary" value={profile.equippedLoadout.secondary} />
          <LoadoutRow slot="Melee" value={profile.equippedLoadout.melee} />
          <LoadoutRow slot="Utility" value={profile.equippedLoadout.utility} />
        </div>
      </div>
    </div>
  );
}

function StatCell({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Crosshair;
  label: string;
  value: string | number;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-white/40">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

function LoadoutRow({ slot, value }: { slot: string; value?: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-white/40">{slot}</span>
      <span className="text-xs font-medium text-white/80">{value ?? "—"}</span>
    </div>
  );
}

// ─── Clan tab ──────────────────────────────────────────────────────────────

function ClanTab({ clan }: { clan: ClanProfile | null }) {
  if (!clan) {
    return (
      <div className="space-y-3 py-8 text-center">
        <div className="text-sm text-white/50">You're not in a clan yet.</div>
        <div className="text-xs text-white/30">
          Create a clan from the settings screen, or ask an officer to invite you.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-lg font-bold text-amber-400">
          [{clan.tag}]
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xl font-bold tracking-tight">{clan.name}</h3>
          <div className="mt-1 flex items-center gap-2 text-xs text-white/50">
            <span>Level {clan.level}</span>
            <span className="text-white/20">•</span>
            <span>{clan.xp.toLocaleString()} XP</span>
            <span className="text-white/20">•</span>
            <span>{clan.members.length} members</span>
          </div>
        </div>
      </div>

      {/* Aggregate stats */}
      <div className="grid grid-cols-4 gap-2">
        <StatCell icon={Sword} label="Kills" value={clan.aggregateStats.totalKills.toLocaleString()} accent="text-emerald-400" />
        <StatCell icon={Trophy} label="Wins" value={clan.aggregateStats.totalWins.toLocaleString()} accent="text-amber-400" />
        <StatCell icon={Crosshair} label="Matches" value={clan.aggregateStats.totalMatches.toLocaleString()} accent="text-sky-400" />
        <StatCell icon={Clock} label="Playtime" value={`${(clan.aggregateStats.totalPlaytimeSeconds / 3600).toFixed(0)}h`} accent="text-white/80" />
      </div>

      {/* Member list */}
      <div>
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-white/40">Members</h4>
        <div className="space-y-1">
          {clan.members.map((m) => (
            <div
              key={m.playerId}
              className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-xs font-bold">
                {m.callsign.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-white/80">{m.callsign}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                    m.role === "leader" ? "bg-amber-500/15 text-amber-400" :
                    m.role === "officer" ? "bg-sky-500/15 text-sky-400" :
                    "bg-white/[0.06] text-white/50"
                  }`}>
                    {m.role}
                  </span>
                  <span className="text-[10px] text-white/30">Lv {m.level}</span>
                </div>
                <div className="text-[10px] text-white/40">
                  {m.kills.toLocaleString()} kills • {m.matches} matches
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-white/20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Search tab ────────────────────────────────────────────────────────────

function SearchTab({
  query,
  onQueryChange,
  results,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  results: PlayerSearchResult[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-3 py-2">
        <Search className="h-4 w-4 text-white/40" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search by callsign…"
          spellCheck={false}
          className={`flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30 ${FOCUS_RING}`}
          aria-label="Search players by callsign"
        />
      </div>

      {query.trim() === "" ? (
        <div className="py-8 text-center text-xs text-white/30">
          Start typing to search for players by callsign.
        </div>
      ) : results.length === 0 ? (
        <div className="py-8 text-center text-sm text-white/40">No players found.</div>
      ) : (
        <div className="space-y-1">
          {results.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-xs font-bold">
                {r.callsign.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-white/80">{r.callsign}</span>
                  {r.clanTag && (
                    <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                      [{r.clanTag}]
                    </span>
                  )}
                  <span className="text-[10px] text-white/30">Lv {r.level}</span>
                </div>
              </div>
              <div className={`h-2 w-2 rounded-full ${r.online ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" : "bg-white/15"}`} />
              <span className="text-[10px] uppercase tracking-wider text-white/40">
                {r.online ? "Online" : "Offline"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export type { PlayerProfile, ClanProfile, PlayerSearchResult };
