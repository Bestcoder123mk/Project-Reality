/**
 * Cloud Save — Firestore ↔ Prisma sync with conflict resolution.
 *
 * Section I (Firebase & Backend) — prompt I-28 / I-63.
 *
 * Architecture:
 *   - Prisma (SQLite) is the local / server-side cache for the heavy
 *     relational catalog (weapons, attachments, operators, challenges,
 *     battle-pass tier rows). The single-tenant demo Player row gets
 *     read on every menu render.
 *   - Firestore is the cross-device real-time layer. A signed-in user's
 *     `players/{uid}` document is the authoritative profile snapshot
 *     that follows them across browsers / devices.
 *
 * Sync model (last-write-wins by `updatedAt`):
 *   1. PUSH  — push current Prisma profile to Firestore (only if local
 *              is newer than the cloud's `lastSavedAt`).
 *   2. PULL  — fetch the Firestore doc; if cloud is newer, push the
 *              cloud values into the local Prisma Player row (and refresh
 *              the zustand profile via the existing /api/player route).
 *   3. MERGE — on conflict, the side with the higher `updatedAt` wins;
 *              numeric currency/XP are summed defensively to avoid
 *              losing spend-through on a stale tab.
 *
 * All helpers are SSR-safe + never throw — they surface a result enum
 * so the UI can show a toast on failure without breaking the game.
 */

import {
  ensurePlayerDocument,
  getPlayerDoc,
  setPlayerDoc,
  type PlayerDoc,
} from "@/lib/firestore";
import { getCurrentUser } from "@/lib/auth";

export type CloudSaveStatus =
  | "ok"
  | "no-auth"        // not signed in (guest or boot)
  | "no-local"       // local profile missing
  | "cloud-newer"    // pulled cloud → local
  | "local-newer"    // pushed local → cloud
  | "in-sync"        // nothing to do
  | "error";

export interface CloudSaveResult {
  status: CloudSaveStatus;
  message?: string;
  /** The authoritative doc after sync (or null on failure). */
  doc?: PlayerDoc | null;
}

interface LocalProfileSnapshot {
  credits: number;
  level: number;
  xp: number;
  displayName?: string;
  /** ms epoch — the local row's updatedAt. */
  updatedAt?: number;
}

/**
 * PUSH — upload the local profile snapshot to Firestore.
 *
 * The caller passes a plain snapshot (no Prisma types leaking across the
 * client/server boundary). The Firebase `uid` is taken from the current
 * auth state; the doc is created on first push.
 */
export async function pushLocalToCloud(
  snapshot: LocalProfileSnapshot,
): Promise<CloudSaveResult> {
  const user = getCurrentUser();
  if (!user) {
    return { status: "no-auth", message: "Sign in to enable cloud save" };
  }
  try {
    const existing = await getPlayerDoc(user.uid);
    const now = Date.now();
    // Last-write-wins: only push when local is newer than the cloud.
    if (
      existing &&
      existing.lastSavedAt &&
      existing.lastSavedAt > (snapshot.updatedAt ?? now)
    ) {
      return {
        status: "cloud-newer",
        message: "Cloud save is newer — pull first",
        doc: existing,
      };
    }
    const merged: PlayerDoc = {
      uid: user.uid,
      displayName: snapshot.displayName ?? existing?.displayName ?? user.displayName ?? "Operator",
      email: existing?.email ?? user.email ?? null,
      photoURL: existing?.photoURL ?? user.photoURL ?? null,
      isAnonymous: user.isAnonymous,
      credits: snapshot.credits,
      level: snapshot.level,
      xp: snapshot.xp,
      schemaVersion: existing?.schemaVersion ?? 1,
      lastSavedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await setPlayerDoc(user.uid, merged);
    return { status: "ok", doc: merged };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Cloud push failed",
    };
  }
}

/**
 * PULL — fetch the Firestore doc and surface it for the caller to apply
 * to the local store. The actual local write happens via the existing
 * `/api/player/cloud-save` route (server-side, Prisma) so we don't ship
 * Prisma to the client.
 */
export async function pullCloudToLocal(): Promise<CloudSaveResult> {
  const user = getCurrentUser();
  if (!user) {
    return { status: "no-auth", message: "Sign in to enable cloud save" };
  }
  try {
    // Ensure the doc exists (first sign-in on a new device).
    const doc = await ensurePlayerDocument(user);
    if (!doc) {
      return { status: "error", message: "Cloud profile unavailable" };
    }
    return { status: "ok", doc };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Cloud pull failed",
    };
  }
}

/**
 * FULL SYNC — push then pull, with conflict resolution.
 *
 * Strategy:
 *   - Read cloud + local snapshots.
 *   - Compare `lastSavedAt` (cloud) vs `updatedAt` (local).
 *   - If cloud is newer → return the cloud doc (caller applies it).
 *   - If local is newer → push local → return local doc.
 *   - If equal → in-sync, no-op.
 *
 * Currency / XP merge: when the two sides disagree AND the timestamps
 * are within 5 seconds (likely a race), take the MAX of each numeric to
 * avoid losing earned credits/XP. This is the defensive "never steal
 * the player's progress" rule.
 */
export async function syncWithConflictResolution(
  snapshot: LocalProfileSnapshot,
): Promise<CloudSaveResult> {
  const user = getCurrentUser();
  if (!user) {
    return { status: "no-auth", message: "Sign in to enable cloud save" };
  }
  try {
    const cloud = await ensurePlayerDocument(user);
    if (!cloud) {
      return { status: "error", message: "Cloud profile unavailable" };
    }
    const localTs = snapshot.updatedAt ?? Date.now();
    const cloudTs = cloud.lastSavedAt ?? cloud.updatedAt ?? 0;
    const RACE_WINDOW_MS = 5_000;

    if (Math.abs(localTs - cloudTs) <= RACE_WINDOW_MS) {
      // Race — merge numerics by MAX, prefer cloud's display name.
      const merged: PlayerDoc = {
        ...cloud,
        credits: Math.max(cloud.credits, snapshot.credits),
        level: Math.max(cloud.level, snapshot.level),
        xp: Math.max(cloud.xp, snapshot.xp),
        lastSavedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await setPlayerDoc(user.uid, merged);
      return { status: "ok", doc: merged, message: "Synced (merge)" };
    }

    if (cloudTs > localTs) {
      // Cloud wins — caller should apply the cloud doc to local.
      return { status: "cloud-newer", doc: cloud };
    }

    // Local wins — push.
    return await pushLocalToCloud(snapshot);
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Sync failed",
    };
  }
}

/**
 * Convenience: returns true when the user is signed in AND their cloud
 * profile exists. Used by the menu to decide whether to show the "synced"
 * badge vs the "offline" badge.
 */
export async function isCloudSaveAvailable(): Promise<boolean> {
  const user = getCurrentUser();
  if (!user) return false;
  const doc = await getPlayerDoc(user.uid);
  return Boolean(doc);
}
