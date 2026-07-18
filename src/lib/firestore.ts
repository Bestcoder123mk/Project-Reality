/**
 * Firestore — typed CRUD helpers for the Project Reality backend.
 *
 * Section I (Firebase & Backend).
 *
 * Collection layout (matches firestore.rules):
 *
 *   players/{uid}                    — public profile + stats + loadout
 *   players/{uid}/inventory/{slug}   — owned items (weapons/attachments/etc.)
 *   battlepass/{uid}                 — current-season tier progress + claims
 *   matches/{matchId}                — match history (write-once)
 *   clans/{clanId}                   — clan info + roster
 *   clans/{clanId}/members/{uid}     — membership rows
 *
 * Firestore is the real-time + cross-device layer. Prisma (SQLite) is
 * the server-side cache for the heavy relational queries (shop catalog,
 * battle-pass tier rows, challenge templates). The Firebase `uid` is the
 * join key. See `@/lib/cloud-save` for the sync logic.
 *
 * Every helper here:
 *   - is SSR-safe (returns null/empty when window is undefined)
 *   - lazy-initializes the Firestore instance
 *   - never throws — logs + returns null so the UI can fall back
 */

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  addDoc,
  serverTimestamp,
  onSnapshot,
  type DocumentReference,
  type Unsubscribe,
} from "firebase/firestore";

import { getDb } from "@/lib/firebase";
import type { FirebaseUser } from "@/lib/auth";

// ─── Types ────────────────────────────────────────────────────────────────

/** Public player profile — synced with the Prisma `Player` row. */
export interface PlayerDoc {
  uid: string;
  displayName: string;
  email: string | null;
  photoURL: string | null;
  isAnonymous: boolean;
  credits: number;
  level: number;
  xp: number;
  /** Schema version for forward-only migrations (mirrors Prisma). */
  schemaVersion: number;
  /** ISO timestamp of the last cloud save. */
  lastSavedAt: number | null;
  /** ISO timestamp of the player's first sign-in. */
  createdAt: number | null;
  /** Stable — used to dedup cloud writes. */
  updatedAt: number | null;
}

export type InventoryItemType =
  | "WEAPON"
  | "ATTACHMENT"
  | "SKIN"
  | "OPERATOR"
  | "WRAP"
  | "CHARM";

export interface InventoryItemDoc {
  slug: string;
  type: InventoryItemType;
  /** ISO timestamp of acquisition. */
  acquiredAt: number | null;
}

export interface BattlePassDoc {
  uid: string;
  season: number;
  tier: number;
  xp: number;
  premium: boolean;
  /** Array of `{ tier, isPremium }` — claimed tier rows. */
  claimedTiers: Array<{ tier: number; isPremium: boolean }>;
  updatedAt: number | null;
}

export interface MatchDoc {
  matchId: string;
  uid: string;
  map: string;
  mode: string;
  result: "VICTORY" | "DEFEAT" | "DRAW" | "INCOMPLETE";
  kills: number;
  deaths: number;
  assists: number;
  xpEarned: number;
  creditsEarned: number;
  startedAt: number;
  endedAt: number;
  /** Per-weapon kill counts (for the post-match recap). */
  weaponStats?: Record<string, { kills: number; shots: number; hits: number }>;
}

export interface ClanDoc {
  clanId: string;
  name: string;
  tag: string;
  description: string;
  leaderUid: string;
  memberCount: number;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ClanMemberDoc {
  uid: string;
  clanId: string;
  role: "LEADER" | "OFFICER" | "MEMBER";
  joinedAt: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

function fs() {
  return getDb();
}

/** Build the default PlayerDoc for a newly signed-in user. */
export function defaultPlayerDoc(user: FirebaseUser): PlayerDoc {
  const now = Date.now();
  return {
    uid: user.uid,
    displayName: user.displayName ?? (user.isAnonymous ? "Guest" : "Operator"),
    email: user.email ?? null,
    photoURL: user.photoURL ?? null,
    isAnonymous: user.isAnonymous,
    credits: 500,
    level: 1,
    xp: 0,
    schemaVersion: SCHEMA_VERSION,
    lastSavedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── players ──────────────────────────────────────────────────────────────

/**
 * Ensure the player's Firestore document exists. Creates it with the
 * default profile on first sign-in; no-ops when it already exists.
 *
 * Returns the doc data (existing or newly created).
 */
export async function ensurePlayerDocument(
  user: FirebaseUser,
): Promise<PlayerDoc | null> {
  const db = fs();
  if (!db) return null;
  const ref = doc(db, "players", user.uid);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data() as PlayerDoc;
    }
    const fresh = defaultPlayerDoc(user);
    await setDoc(ref, { ...fresh, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return fresh;
  } catch (err) {
    console.error("[firestore] ensurePlayerDocument failed:", err);
    return null;
  }
}

/** Read a player's public profile. Null if missing or on error. */
export async function getPlayerDoc(uid: string): Promise<PlayerDoc | null> {
  const db = fs();
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, "players", uid));
    if (!snap.exists()) return null;
    return snap.data() as PlayerDoc;
  } catch (err) {
    console.error("[firestore] getPlayerDoc failed:", err);
    return null;
  }
}

/**
 * Write the player's profile (full overwrite). Use `updatePlayerDoc` for
 * partial patches.
 */
export async function setPlayerDoc(
  uid: string,
  data: PlayerDoc,
): Promise<void> {
  const db = fs();
  if (!db) return;
  try {
    await setDoc(doc(db, "players", uid), {
      ...data,
      updatedAt: serverTimestamp(),
      lastSavedAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("[firestore] setPlayerDoc failed:", err);
  }
}

/** Partial update of the player's profile. */
export async function updatePlayerDoc(
  uid: string,
  patch: Partial<PlayerDoc>,
): Promise<void> {
  const db = fs();
  if (!db) return;
  try {
    await updateDoc(doc(db, "players", uid), {
      ...patch,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("[firestore] updatePlayerDoc failed:", err);
  }
}

/** Live subscription to a player's profile. Returns unsubscribe fn. */
export function subscribeToPlayerDoc(
  uid: string,
  cb: (doc: PlayerDoc | null) => void,
): Unsubscribe {
  const db = fs();
  if (!db) {
    cb(null);
    return () => {};
  }
  return onSnapshot(
    doc(db, "players", uid),
    (snap) => cb(snap.exists() ? (snap.data() as PlayerDoc) : null),
    (err) => {
      console.error("[firestore] subscribeToPlayerDoc error:", err);
      cb(null);
    },
  );
}

// ─── players/{uid}/inventory ──────────────────────────────────────────────

const inventoryCol = (uid: string) => `players/${uid}/inventory`;

export async function addInventoryItem(
  uid: string,
  item: InventoryItemDoc,
): Promise<void> {
  const db = fs();
  if (!db) return;
  try {
    await setDoc(doc(db, inventoryCol(uid), item.slug), {
      ...item,
      acquiredAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("[firestore] addInventoryItem failed:", err);
  }
}

export async function getInventory(
  uid: string,
): Promise<InventoryItemDoc[]> {
  const db = fs();
  if (!db) return [];
  try {
    const snap = await getDocs(collection(db, inventoryCol(uid)));
    return snap.docs.map((d) => d.data() as InventoryItemDoc);
  } catch (err) {
    console.error("[firestore] getInventory failed:", err);
    return [];
  }
}

export async function removeInventoryItem(
  uid: string,
  slug: string,
): Promise<void> {
  const db = fs();
  if (!db) return;
  try {
    await deleteDoc(doc(db, inventoryCol(uid), slug));
  } catch (err) {
    console.error("[firestore] removeInventoryItem failed:", err);
  }
}

// ─── battlepass ───────────────────────────────────────────────────────────

const BATTLEPASS_COL = "battlepass";

export async function getBattlePassDoc(
  uid: string,
  season: number,
): Promise<BattlePassDoc | null> {
  const db = fs();
  if (!db) return null;
  try {
    // The doc id is `${uid}_${season}` so seasons don't overwrite each other.
    const ref = doc(db, BATTLEPASS_COL, `${uid}_${season}`);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return snap.data() as BattlePassDoc;
  } catch (err) {
    console.error("[firestore] getBattlePassDoc failed:", err);
    return null;
  }
}

export async function setBattlePassDoc(
  uid: string,
  season: number,
  data: BattlePassDoc,
): Promise<void> {
  const db = fs();
  if (!db) return;
  try {
    await setDoc(doc(db, BATTLEPASS_COL, `${uid}_${season}`), {
      ...data,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("[firestore] setBattlePassDoc failed:", err);
  }
}

// ─── matches ──────────────────────────────────────────────────────────────

const MATCHES_COL = "matches";

/** Append a completed match to the player's history. Write-once. */
export async function addMatchDoc(match: MatchDoc): Promise<string | null> {
  const db = fs();
  if (!db) return null;
  try {
    const ref = await addDoc(collection(db, MATCHES_COL), {
      ...match,
      endedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error("[firestore] addMatchDoc failed:", err);
    return null;
  }
}

/** Get a player's recent matches (most-recent-first). */
export async function getRecentMatches(
  uid: string,
  limitN = 20,
): Promise<MatchDoc[]> {
  const db = fs();
  if (!db) return [];
  try {
    const q = query(
      collection(db, MATCHES_COL),
      where("uid", "==", uid),
      orderBy("endedAt", "desc"),
      limit(limitN),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as MatchDoc);
  } catch (err) {
    console.error("[firestore] getRecentMatches failed:", err);
    return [];
  }
}

// ─── clans ────────────────────────────────────────────────────────────────

const CLANS_COL = "clans";

export async function createClan(
  data: Omit<ClanDoc, "clanId" | "createdAt" | "updatedAt" | "memberCount"> & {
    memberCount?: number;
  },
): Promise<string | null> {
  const db = fs();
  if (!db) return null;
  try {
    const ref = await addDoc(collection(db, CLANS_COL), {
      ...data,
      memberCount: data.memberCount ?? 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    // Add the leader as the first member.
    await setDoc(doc(db, `${CLANS_COL}/${ref.id}/members`, data.leaderUid), {
      uid: data.leaderUid,
      clanId: ref.id,
      role: "LEADER",
      joinedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error("[firestore] createClan failed:", err);
    return null;
  }
}

export async function getClanDoc(clanId: string): Promise<ClanDoc | null> {
  const db = fs();
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, CLANS_COL, clanId));
    if (!snap.exists()) return null;
    return { clanId: snap.id, ...(snap.data() as Omit<ClanDoc, "clanId">) };
  } catch (err) {
    console.error("[firestore] getClanDoc failed:", err);
    return null;
  }
}

export async function getClanMembers(
  clanId: string,
): Promise<ClanMemberDoc[]> {
  const db = fs();
  if (!db) return [];
  try {
    const snap = await getDocs(collection(db, `${CLANS_COL}/${clanId}/members`));
    return snap.docs.map((d) => d.data() as ClanMemberDoc);
  } catch (err) {
    console.error("[firestore] getClanMembers failed:", err);
    return [];
  }
}

/** Find the clan a player belongs to (if any) — top-N scan. */
export async function findClanByMember(
  uid: string,
): Promise<{ clanId: string; role: ClanMemberDoc["role"] } | null> {
  const db = fs();
  if (!db) return null;
  try {
    // Iterate clans and check membership. For the demo scale this is fine;
    // a production deployment would maintain a `players/{uid}/clanMembership`
    // subcollection for O(1) lookup.
    const snap = await getDocs(collection(db, CLANS_COL));
    for (const clanDoc of snap.docs) {
      const memberRef = doc(db, `${CLANS_COL}/${clanDoc.id}/members`, uid);
      const memberSnap = await getDoc(memberRef);
      if (memberSnap.exists()) {
        return {
          clanId: clanDoc.id,
          role: (memberSnap.data() as ClanMemberDoc).role,
        };
      }
    }
    return null;
  } catch (err) {
    console.error("[firestore] findClanByMember failed:", err);
    return null;
  }
}

// ─── utility ──────────────────────────────────────────────────────────────

/** Firestore DocumentReference helper (typed). Exposed for advanced use. */
export function playerDocRef(uid: string): DocumentReference | null {
  const db = fs();
  if (!db) return null;
  return doc(db, "players", uid);
}

/** Delete a player's entire Firestore footprint (GDPR account deletion). */
export async function deletePlayerCascade(uid: string): Promise<void> {
  const db = fs();
  if (!db) return;
  try {
    // Inventory subcollection.
    const invSnap = await getDocs(collection(db, inventoryCol(uid)));
    await Promise.all(
      invSnap.docs.map((d) => deleteDoc(d.ref)),
    );
    // Battle-pass docs for every season (best-effort: scan recent seasons).
    const bpSnap = await getDocs(
      query(collection(db, BATTLEPASS_COL), where("uid", "==", uid)),
    );
    await Promise.all(
      bpSnap.docs.map((d) => deleteDoc(d.ref)),
    );
    // Match history.
    const matchSnap = await getDocs(
      query(collection(db, MATCHES_COL), where("uid", "==", uid)),
    );
    await Promise.all(
      matchSnap.docs.map((d) => deleteDoc(d.ref)),
    );
    // Finally the player doc.
    await deleteDoc(doc(db, "players", uid));
  } catch (err) {
    console.error("[firestore] deletePlayerCascade failed:", err);
  }
}
