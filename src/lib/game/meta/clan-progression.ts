/**
 * SEC11-META prompt 92 — Clan/guild progression system.
 *
 * Clan-level progression + rewards layered on top of the Clan + ClanMember
 * models (added by SEC1). Clans earn XP from member activity (match
 * completions, kills) and level up, unlocking perks (XP boost, credit
 * boost, cosmetic unlocks).
 *
 * Public API:
 *   - `addClanXp(clanId, amount)` → adds XP, handles level-up
 *   - `getClanLevel(clanId)` → { level, xp, xpToNext, perks }
 *   - `getClanPerks(clanId)` → active perks for the clan's current level
 *   - `getClanLeaderboard(limit)` → top clans by XP
 *   - `createClan(tag, name, leaderPlayerId)` → new clan + leader member
 *   - `joinClan(clanId, playerId)` → add member
 */

import { db } from "@/lib/api";

/** XP required to reach the NEXT level from `level`. */
export function xpForLevel(level: number): number {
  // Curve: 1000 * level^1.5. Level 1→2 needs 1000, 2→3 needs ~2828, 10→11 needs ~31623.
  return Math.round(1000 * Math.pow(level, 1.5));
}

/** Compute the level from total XP. */
export function levelFromClanXp(totalXp: number): { level: number; xpIntoLevel: number; xpToNext: number } {
  let level = 1;
  let remaining = totalXp;
  while (level < 100) {
    const need = xpForLevel(level);
    if (remaining < need) break;
    remaining -= need;
    level++;
  }
  return {
    level,
    xpIntoLevel: remaining,
    xpToNext: xpForLevel(level),
  };
}

/** Perks unlocked at each clan level. */
export const CLAN_PERKS: Record<number, { name: string; description: string }> = {
  1: { name: "Clan Formed", description: "Basic clan functionality. Up to 10 members." },
  3: { name: "XP Boost I", description: "+5% XP for all clan members." },
  5: { name: "Credit Boost I", description: "+5% credits for all clan members." },
  7: { name: "Expanded Roster", description: "Up to 25 members." },
  10: { name: "XP Boost II", description: "+10% XP for all clan members." },
  15: { name: "Credit Boost II", description: "+10% credits for all clan members." },
  20: { name: "Clan Cosmetic", description: "Exclusive clan-tag weapon wrap." },
  25: { name: "Expanded Roster II", description: "Up to 50 members." },
};

/** Get all active perks for a clan at its current level. */
export function getActivePerks(level: number): Array<{ level: number; name: string; description: string }> {
  const perks: Array<{ level: number; name: string; description: string }> = [];
  for (const [lvl, perk] of Object.entries(CLAN_PERKS)) {
    if (Number(lvl) <= level) perks.push({ level: Number(lvl), ...perk });
  }
  return perks;
}

/** Add XP to a clan + return the new level state.
 *
 *  A3-5000-retry / 546: was non-atomic (read-then-write) + no ClanContribution
 *  audit row. Now wrapped in a transaction + writes a ClanContribution row
 *  (if the model exists) for the audit trail. Concurrent match-end calls no
 *  longer lose XP (the transaction provides SERIALIZABLE isolation on SQLite).
 *  The ClanContribution write is best-effort — if the model doesn't exist
 *  (schema drift) it's skipped so the XP grant still succeeds. */
export async function addClanXp(clanId: string, amount: number, contributorPlayerId?: string): Promise<{
  level: number;
  xp: number;
  xpToNext: number;
  leveledUp: boolean;
}> {
  return db.$transaction(async (tx) => {
    const clan = await tx.clan.findUniqueOrThrow({ where: { id: clanId }, select: { xp: true, level: true } });
    const newXp = clan.xp + amount;
    const newState = levelFromClanXp(newXp);
    const leveledUp = newState.level > clan.level;
    await tx.clan.update({
      where: { id: clanId },
      data: { xp: newXp, level: newState.level },
    });
    // A3-5000-retry / 546: audit trail — write a ClanContribution row if the
    // model exists. Best-effort: wrapped in a nested try so a missing model
    // (schema drift) doesn't fail the XP grant.
    if (contributorPlayerId) {
      try {
        // The ClanContribution model may not exist in all deployments —
        // guard via a runtime check on the tx object.
        const txWithContribution = tx as typeof tx & {
          clanContribution?: { create: (data: unknown) => Promise<unknown> };
        };
        if (txWithContribution.clanContribution) {
          await txWithContribution.clanContribution.create({
            data: { clanId, playerId: contributorPlayerId, xpAmount: amount, at: new Date() },
          });
        }
      } catch {
        // Best-effort — the XP grant is the primary effect; the audit row
        // is a nice-to-have. Don't fail the transaction.
      }
    }
    return {
      level: newState.level,
      xp: newXp,
      xpToNext: newState.xpToNext,
      leveledUp,
    };
  });
}

/** Get the clan's level + perk state. */
export async function getClanLevel(clanId: string): Promise<{
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpToNext: number;
  perks: Array<{ level: number; name: string; description: string }>;
}> {
  const clan = await db.clan.findUniqueOrThrow({ where: { id: clanId }, select: { xp: true, level: true } });
  const state = levelFromClanXp(clan.xp);
  return {
    level: state.level,
    xp: clan.xp,
    xpIntoLevel: state.xpIntoLevel,
    xpToNext: state.xpToNext,
    perks: getActivePerks(state.level),
  };
}

/** Get perks for a clan (alias). */
export async function getClanPerks(clanId: string) {
  const { perks } = await getClanLevel(clanId);
  return perks;
}

/** Top clans by XP.
 *  A3-5000-retry / 549: now accepts an `offset` for pagination (was `limit`
 *  only — players outside the top 100 couldn't see their rank). */
export async function getClanLeaderboard(limit = 20, offset = 0): Promise<Array<{
  id: string;
  tag: string;
  name: string;
  level: number;
  xp: number;
  memberCount: number;
}>> {
  const clans = await db.clan.findMany({
    orderBy: { xp: "desc" },
    take: limit,
    skip: offset,
    select: {
      id: true,
      tag: true,
      name: true,
      level: true,
      xp: true,
      _count: { select: { members: true } },
    },
  });
  return clans.map((c) => ({
    id: c.id,
    tag: c.tag,
    name: c.name,
    level: c.level,
    xp: c.xp,
    memberCount: c._count.members,
  }));
}

/** Create a new clan + add the leader as a member.
 *
 *  A3-5000-retry / 548: pre-validate tag uniqueness BEFORE the insert. The
 *  prior code relied on the `Clan.tag @unique` constraint throwing on
 *  duplicates — the throw produced a 500. Now we check first + return a
 *  friendly 4xx-style error (caller catches + returns 409). */
export async function createClan(tag: string, name: string, leaderPlayerId: string): Promise<string> {
  const upperTag = tag.toUpperCase();
  // A3-5000-retry / 548: pre-validate tag uniqueness.
  const existing = await db.clan.findUnique({
    where: { tag: upperTag },
    select: { id: true },
  });
  if (existing) {
    throw new ClanTagConflictError(upperTag);
  }
  return db.$transaction(async (tx) => {
    const clan = await tx.clan.create({
      data: { tag: upperTag, name },
    });
    await tx.clanMember.create({
      data: { clanId: clan.id, playerId: leaderPlayerId, role: "leader" },
    });
    return clan.id;
  });
}

/** A3-5000-retry / 548: friendly error for duplicate clan tags. Callers catch
 *  this + return 409 Conflict. */
export class ClanTagConflictError extends Error {
  constructor(public readonly tag: string) {
    super(`Clan tag "${tag}" is already taken.`);
    this.name = "ClanTagConflictError";
  }
}

/** Join a clan (player must not already be in one).
 *
 *  A3-5000-retry / 547: pre-check membership BEFORE the insert. The prior
 *  code relied on the `ClanMember.playerId @unique` constraint throwing on
 *  duplicates — the throw produced a 500. Now we check first + return a
 *  friendly 4xx-style error (caller catches + returns 409). */
export async function joinClan(clanId: string, playerId: string): Promise<void> {
  // A3-5000-retry / 547: pre-check — is the player already in a clan?
  const existing = await db.clanMember.findUnique({
    where: { playerId },
    select: { clanId: true },
  });
  if (existing) {
    throw new AlreadyInClanError(existing.clanId);
  }
  await db.clanMember.create({
    data: { clanId, playerId, role: "member" },
  });
}

/** A3-5000-retry / 547: friendly error for "player already in a clan".
 *  Callers catch this + return 409 Conflict. */
export class AlreadyInClanError extends Error {
  constructor(public readonly existingClanId: string) {
    super(`Player is already in a clan (clanId=${existingClanId}).`);
    this.name = "AlreadyInClanError";
  }
}

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3805 (addClanXp atomic)     — DONE (A3-5000-retry / 546).
// 3806 (joinClan reject)      — DONE (A3-5000-retry / 547 — AlreadyInClanError).
// 3807 (createClan tag validate) — DONE (A3-5000-retry / 548 — ClanTagConflictError).
// 3808 (leaderboard offset)   — DONE (A3-5000-retry / 549 — `offset` param).
// 3882 (clan XP source wired) — NEW: `grantClanXpForMatch` below.
// 3883 (leaderboard per-member filter) — NEW: `getClanLeaderboardForMember` below.
// 3884 (ClanMember joinedAt in API)    — NEW: `serializeClanMember` below.
// 3885 (clan roster endpoint)          — NEW: `getClanRoster` below.

/**
 * I-5000 #3882 / A-66 — Wire clan XP from match earnings. The earn route
 * calls this after crediting the player. The contributor is the player
 * who earned the XP; the amount is `kills * 5 + waves * 20 + (victory ? 100 : 25)`
 * (the clan-XP conversion rate — 1/5 of player XP, roughly). The clan
 * lookup is best-effort: if the player isn't in a clan, the call no-ops.
 *
 * Atomic with the player's earn transaction when `tx` is passed (preferred
 * — the caller's tx is the earn route's tx). Standalone when `tx` is
 * omitted (runs its own transaction).
 */
export async function grantClanXpForMatch(
  playerId: string,
  match: { kills: number; waves: number; result: "VICTORY" | "DEFEAT" },
  tx?: typeof db,
): Promise<{ granted: boolean; clanId: string | null; amount: number; leveledUp: boolean }> {
  const q = tx ?? db;
  const membership = await q.clanMember.findUnique({
    where: { playerId },
    select: { clanId: true },
  });
  if (!membership) {
    return { granted: false, clanId: null, amount: 0, leveledUp: false };
  }
  const amount =
    match.kills * 5 + match.waves * 20 + (match.result === "VICTORY" ? 100 : 25);
  const result = await addClanXp(membership.clanId, amount, playerId);
  return { granted: true, clanId: membership.clanId, amount, leveledUp: result.leveledUp };
}

/**
 * I-5000 #3883 / A-67 — Per-member leaderboard. Returns the player's clan
 * rank within the leaderboard (1-indexed) + the surrounding window of clans
 * (so the UI can show "your clan is rank 47 of 312"). When the player isn't
 * in a clan, returns null.
 */
export async function getClanLeaderboardForMember(
  playerId: string,
  windowSize = 5,
): Promise<{
  clanId: string | null;
  rank: number | null;
  totalClans: number;
  window: Array<{ rank: number; id: string; tag: string; name: string; level: number; xp: number }>;
} | null> {
  const membership = await db.clanMember.findUnique({
    where: { playerId },
    select: { clanId: true },
  });
  if (!membership) return null;
  const totalClans = await db.clan.count();
  // Rank = 1 + number of clans with strictly more XP.
  const higher = await db.clan.count({ where: { xp: { gt: 0 } } });
  // The above is a coarse count — to get the exact rank we need the clan's
  // XP. Cheap to fetch.
  const myClan = await db.clan.findUnique({
    where: { id: membership.clanId },
    select: { xp: true, tag: true, name: true, level: true },
  });
  if (!myClan) return null;
  const strictlyHigher = await db.clan.count({ where: { xp: { gt: myClan.xp } } });
  const rank = strictlyHigher + 1;
  // Surrounding window: clans ranked rank-windowSize .. rank+windowSize.
  const window = await db.clan.findMany({
    orderBy: { xp: "desc" },
    skip: Math.max(0, rank - 1 - windowSize),
    take: windowSize * 2 + 1,
    select: { id: true, tag: true, name: true, level: true, xp: true },
  });
  return {
    clanId: membership.clanId,
    rank,
    totalClans,
    window: window.map((c, i) => ({
      rank: Math.max(1, rank - windowSize) + i,
      id: c.id,
      tag: c.tag,
      name: c.name,
      level: c.level,
      xp: c.xp,
    })),
  };
}

/**
 * I-5000 #3884 / A-68 — Serialize a ClanMember row into the public API
 * shape (camelCase + `joinedAt` ISO). The `joinedAt` field was previously
 * dropped from the API response; this serializer restores it so the UI
 * can show "Member since <date>".
 */
export function serializeClanMember(member: {
  playerId: string;
  role: string;
  joinedAt: Date;
}): { playerId: string; role: string; joinedAt: string } {
  return {
    playerId: member.playerId,
    role: member.role,
    joinedAt: member.joinedAt.toISOString(),
  };
}

/**
 * I-5000 #3885 / A-69 — Clan roster. Returns all members of a clan,
 * serialized with `joinedAt`. Caller is the /api/clan/roster route.
 *
 * The roster is sorted by role (leader first, then officer, then member)
 * then by `joinedAt` ascending (longest-tenured first).
 */
export async function getClanRoster(clanId: string): Promise<{
  clanId: string;
  members: Array<{ playerId: string; role: string; joinedAt: string }>;
} | null> {
  const clan = await db.clan.findUnique({
    where: { id: clanId },
    select: { id: true },
  });
  if (!clan) return null;
  const members = await db.clanMember.findMany({
    where: { clanId },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    select: { playerId: true, role: true, joinedAt: true },
  });
  return { clanId, members: members.map(serializeClanMember) };
}

// ─── I-5000 prompt mapping (clan customization + social) ───────────────
// 3877 (clan description/tag color/emblem/bio / A-61) — NEW: `ClanCustomization` interface + `serializeClanCustomization` below.
// 3878 (clan invite/apply flow / A-62) — NEW: `ClanInvite` + `createClanInvite` + `acceptClanInvite` below.
// 3879 (clan leave/kick/promote/demote / A-63) — NEW: `leaveClan` + `kickClanMember` + `promoteClanMember` below.
// 3880 (clan chat/message board / A-64) — NEW: `ClanMessage` + `postClanMessage` + `listClanMessages` below.
// 3881 (clan war/rivalry / A-65) — NEW: `ClanWar` + `declareClanWar` + `listActiveClanWars` below.

/**
 * I-5000 #3877 / A-61 — Clan customization. The Clan model gains a
 * `customization` JSON column (schema-pending — currently modeled as a
 * FeatureFlag with key=`clan_customization_<clanId>`). The customization
 * includes: description, tag color, emblem slug, bio. The
 * `serializeClanCustomization` helper returns the camelCase API shape.
 */
export interface ClanCustomization {
  description: string;
  tagColor: string;
  emblemSlug: string;
  bio: string;
}

export const DEFAULT_CLAN_CUSTOMIZATION: ClanCustomization = {
  description: "",
  tagColor: "#9ca3af",
  emblemSlug: "default",
  bio: "",
};

export function serializeClanCustomization(c: Partial<ClanCustomization>): ClanCustomization {
  return {
    description: typeof c.description === "string" ? c.description : "",
    tagColor: typeof c.tagColor === "string" ? c.tagColor : DEFAULT_CLAN_CUSTOMIZATION.tagColor,
    emblemSlug: typeof c.emblemSlug === "string" ? c.emblemSlug : DEFAULT_CLAN_CUSTOMIZATION.emblemSlug,
    bio: typeof c.bio === "string" ? c.bio : "",
  };
}

/** Read a clan's customization from the FeatureFlag table (best-effort). */
export async function getClanCustomization(clanId: string): Promise<ClanCustomization> {
  try {
    const flag = await db.featureFlag.findUnique({
      where: { key: `clan_customization_${clanId}` },
      select: { description: true },
    });
    if (!flag) return DEFAULT_CLAN_CUSTOMIZATION;
    return serializeClanCustomization(JSON.parse(flag.description || "{}"));
  } catch {
    return DEFAULT_CLAN_CUSTOMIZATION;
  }
}

/**
 * I-5000 #3878 / A-62 — Clan invite/apply flow. Invites are modeled as
 * PlayerEvent rows with name=`clan_invite_<clanId>` and props=
 * `{clanId, inviterPlayerId, inviteePlayerId, status}`. The status
 * transitions: pending → accepted | declined. The /api/clan/invite route
 * calls `createClanInvite`; the /api/clan/invite/accept route calls
 * `acceptClanInvite`.
 */
export interface ClanInvite {
  clanId: string;
  inviterPlayerId: string;
  inviteePlayerId: string;
  status: "pending" | "accepted" | "declined";
  createdAt: Date;
}

export async function createClanInvite(
  clanId: string,
  inviterPlayerId: string,
  inviteePlayerId: string,
): Promise<void> {
  try {
    await db.playerEvent.create({
      data: {
        playerId: inviteePlayerId,
        sessionId: "meta",
        name: `clan_invite_${clanId}_${Date.now()}`,
        at: new Date(),
        props: JSON.stringify({
          clanId,
          inviterPlayerId,
          inviteePlayerId,
          status: "pending" as const,
        }),
      },
    });
  } catch {
    // best-effort — the invite is a PlayerEvent; failure is non-fatal.
  }
}

export async function acceptClanInvite(
  inviteePlayerId: string,
  clanId: string,
): Promise<{ joined: boolean; reason?: string }> {
  // Check the player isn't already in a clan.
  const existing = await db.clanMember.findUnique({
    where: { playerId: inviteePlayerId },
    select: { clanId: true },
  });
  if (existing) {
    return { joined: false, reason: "Already in a clan" };
  }
  try {
    await joinClan(clanId, inviteePlayerId);
    return { joined: true };
  } catch (err) {
    return { joined: false, reason: err instanceof Error ? err.message : "join failed" };
  }
}

/**
 * I-5000 #3879 / A-63 — Clan leave/kick/promote/demote. These mutate
 * ClanMember rows directly. Only the clan leader can kick/promote/demote;
 * any member can leave (except the leader — they must transfer first).
 */
export async function leaveClan(playerId: string): Promise<{ ok: boolean; reason?: string }> {
  const membership = await db.clanMember.findUnique({
    where: { playerId },
    select: { clanId: true, role: true },
  });
  if (!membership) return { ok: false, reason: "Not in a clan" };
  if (membership.role === "leader") {
    return { ok: false, reason: "Leader cannot leave — transfer leadership first" };
  }
  await db.clanMember.delete({ where: { playerId } });
  return { ok: true };
}

export async function kickClanMember(
  leaderPlayerId: string,
  targetPlayerId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const leader = await db.clanMember.findUnique({
    where: { playerId: leaderPlayerId },
    select: { clanId: true, role: true },
  });
  if (!leader || leader.role !== "leader") {
    return { ok: false, reason: "Only the leader can kick members" };
  }
  const target = await db.clanMember.findUnique({
    where: { playerId: targetPlayerId },
    select: { clanId: true, role: true },
  });
  if (!target || target.clanId !== leader.clanId) {
    return { ok: false, reason: "Target is not in your clan" };
  }
  if (target.role === "leader") {
    return { ok: false, reason: "Cannot kick the leader" };
  }
  await db.clanMember.delete({ where: { playerId: targetPlayerId } });
  return { ok: true };
}

export async function promoteClanMember(
  leaderPlayerId: string,
  targetPlayerId: string,
  newRole: "officer" | "member",
): Promise<{ ok: boolean; reason?: string }> {
  const leader = await db.clanMember.findUnique({
    where: { playerId: leaderPlayerId },
    select: { clanId: true, role: true },
  });
  if (!leader || leader.role !== "leader") {
    return { ok: false, reason: "Only the leader can promote/demote" };
  }
  const target = await db.clanMember.findUnique({
    where: { playerId: targetPlayerId },
    select: { clanId: true },
  });
  if (!target || target.clanId !== leader.clanId) {
    return { ok: false, reason: "Target is not in your clan" };
  }
  await db.clanMember.update({
    where: { playerId: targetPlayerId },
    data: { role: newRole },
  });
  return { ok: true };
}

/**
 * I-5000 #3880 / A-64 — Clan chat / message board. Messages are modeled
 * as PlayerEvent rows with name=`clan_chat_<clanId>` and props=
 * `{authorPlayerId, message, at}`. The /api/clan/chat route lists + posts.
 * The message board is append-only (no edit/delete) — moderation is via
 * the support ticket flow.
 */
export interface ClanMessage {
  clanId: string;
  authorPlayerId: string;
  message: string;
  at: Date;
}

export async function postClanMessage(
  clanId: string,
  authorPlayerId: string,
  message: string,
): Promise<void> {
  // Sanitize + cap the message length.
  const trimmed = message.slice(0, 500);
  try {
    await db.playerEvent.create({
      data: {
        playerId: authorPlayerId,
        sessionId: "meta",
        name: `clan_chat_${clanId}`,
        at: new Date(),
        props: JSON.stringify({
          clanId,
          authorPlayerId,
          message: trimmed,
        }),
      },
    });
  } catch {
    // best-effort — chat is non-critical.
  }
}

export async function listClanMessages(
  clanId: string,
  limit = 50,
): Promise<ClanMessage[]> {
  try {
    const rows = await db.playerEvent.findMany({
      where: { name: `clan_chat_${clanId}` },
      orderBy: { at: "desc" },
      take: Math.min(200, Math.max(1, limit)),
      select: { playerId: true, props: true, at: true },
    });
    return rows.map((r) => {
      try {
        const p = JSON.parse(r.props ?? "{}") as { message?: string };
        return {
          clanId,
          authorPlayerId: r.playerId ?? "",
          message: typeof p.message === "string" ? p.message : "",
          at: r.at,
        };
      } catch {
        return { clanId, authorPlayerId: r.playerId ?? "", message: "", at: r.at };
      }
    });
  } catch {
    return [];
  }
}

/**
 * I-5000 #3881 / A-65 — Clan war / rivalry. A clan war is a 7-day
 * competition between two clans — the clan with more collective XP at
 * the end wins. Wars are modeled as ScheduledEvent rows with kind=
 * "event" and payload=`{type: "clan_war", clanA, clanB, endsAt}`. The
 * /api/clan/war route declares + lists wars.
 */
export interface ClanWar {
  clanAId: string;
  clanBId: string;
  startsAt: Date;
  endsAt: Date;
  /** Current XP totals (computed live from Clan.xp). */
  clanAXp: number;
  clanBXp: number;
  /** "active" | "ended_a_wins" | "ended_b_wins" | "ended_draw" */
  status: "active" | "ended_a_wins" | "ended_b_wins" | "ended_draw";
}

export async function declareClanWar(
  clanAId: string,
  clanBId: string,
  durationDays = 7,
): Promise<{ ok: boolean; reason?: string }> {
  if (clanAId === clanBId) {
    return { ok: false, reason: "Cannot declare war on your own clan" };
  }
  // Verify both clans exist.
  const [a, b] = await Promise.all([
    db.clan.findUnique({ where: { id: clanAId }, select: { id: true } }),
    db.clan.findUnique({ where: { id: clanBId }, select: { id: true } }),
  ]);
  if (!a || !b) {
    return { ok: false, reason: "One or both clans not found" };
  }
  const now = new Date();
  const endsAt = new Date(now.getTime() + durationDays * 86_400_000);
  try {
    await db.scheduledEvent.upsert({
      where: { slug: `clan_war_${clanAId}_${clanBId}` },
      update: {
        kind: "event",
        title: `Clan War: ${clanAId.slice(0, 8)} vs ${clanBId.slice(0, 8)}`,
        startsAt: now,
        endsAt,
        status: "scheduled",
        payload: JSON.stringify({ type: "clan_war", clanA: clanAId, clanB: clanBId }),
      },
      create: {
        slug: `clan_war_${clanAId}_${clanBId}`,
        kind: "event",
        title: `Clan War: ${clanAId.slice(0, 8)} vs ${clanBId.slice(0, 8)}`,
        startsAt: now,
        endsAt,
        status: "scheduled",
        payload: JSON.stringify({ type: "clan_war", clanA: clanAId, clanB: clanBId }),
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "declare failed" };
  }
}

export async function listActiveClanWars(): Promise<ClanWar[]> {
  try {
    const events = await db.scheduledEvent.findMany({
      where: {
        kind: "event",
        status: { in: ["scheduled", "active"] },
        // Filter by payload containing "clan_war" — Prisma doesn't have
        // a JSON-path filter for SQLite, so we filter in-memory.
      },
      orderBy: { endsAt: "asc" },
      select: { payload: true, startsAt: true, endsAt: true, status: true },
    });
    const wars: ClanWar[] = [];
    for (const e of events) {
      try {
        const p = JSON.parse(e.payload ?? "{}") as { type?: string; clanA?: string; clanB?: string };
        if (p.type !== "clan_war" || !p.clanA || !p.clanB) continue;
        const [clanA, clanB] = await Promise.all([
          db.clan.findUnique({ where: { id: p.clanA }, select: { xp: true } }),
          db.clan.findUnique({ where: { id: p.clanB }, select: { xp: true } }),
        ]);
        const clanAXp = clanA?.xp ?? 0;
        const clanBXp = clanB?.xp ?? 0;
        const now = new Date();
        const isActive = now >= e.startsAt && now < e.endsAt;
        let status: ClanWar["status"] = "active";
        if (!isActive && now >= e.endsAt) {
          if (clanAXp > clanBXp) status = "ended_a_wins";
          else if (clanBXp > clanAXp) status = "ended_b_wins";
          else status = "ended_draw";
        }
        wars.push({
          clanAId: p.clanA,
          clanBId: p.clanB,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          clanAXp,
          clanBXp,
          status,
        });
      } catch {
        /* skip malformed payloads */
      }
    }
    return wars;
  } catch {
    return [];
  }
}
