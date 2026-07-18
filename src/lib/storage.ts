/**
 * Cloud Storage — typed wrappers for wraps/skins/charms asset CDN.
 *
 * Section I (Firebase & Backend) — prompt I-45 / I-57.
 *
 * The game's wrap/skin/charm textures live in Cloud Storage (the
 * Firebase Storage bucket `project-reality-8966a.firebasestorage.app`).
 * This module wraps the Firebase Storage SDK so callers get:
 *
 *   - typed asset URLs (`getWrapUrl`, `getSkinUrl`, `getCharmUrl`)
 *   - a metadata fetcher for cache-busting query strings
 *   - a listing helper for the catalog UI
 *   - an upload helper for community wraps (when allowed)
 *
 * Layout (matches `public/wraps/`, `public/skins/`, `public/charms/`):
 *
 *   gs://project-reality-8966a.firebasestorage.app/
 *     wraps/{slug}.png
 *     skins/{weaponSlug}/{skinSlug}.png
 *     charms/{slug}.png
 *     operators/{slug}/preview.png
 *
 * All helpers are SSR-safe + never throw — they return null on error
 * so the renderer falls back to the local bundled texture.
 */

import {
  getStorage,
  ref,
  getDownloadURL,
  getMetadata,
  uploadBytes,
  listAll,
  type FirebaseStorage,
  type StorageReference,
} from "firebase/storage";

import { getFirebaseApp } from "@/lib/firebase";

let _storage: FirebaseStorage | null = null;

function storage(): FirebaseStorage | null {
  if (typeof window === "undefined") return null;
  if (!_storage) {
    const app = getFirebaseApp();
    if (!app) return null;
    try {
      _storage = getStorage(app);
    } catch (err) {
      console.error("[storage] init failed:", err);
      return null;
    }
  }
  return _storage;
}

/** Build a CDN URL for a wrap texture (e.g. `gs://…/wraps/tiger.png`). */
export async function getWrapUrl(slug: string): Promise<string | null> {
  return safeUrl(`wraps/${slug}.png`);
}

/** Build a CDN URL for a weapon skin texture. */
export async function getSkinUrl(
  weaponSlug: string,
  skinSlug: string,
): Promise<string | null> {
  // The "default" skin is bundled locally — never hit the network for it.
  if (skinSlug === "default") return null;
  return safeUrl(`skins/${weaponSlug}/${skinSlug}.png`);
}

/** Build a CDN URL for a weapon charm icon. */
export async function getCharmUrl(slug: string): Promise<string | null> {
  if (!slug || slug === "none") return null;
  return safeUrl(`charms/${slug}.png`);
}

/** Build a CDN URL for an operator preview thumbnail. */
export async function getOperatorPreviewUrl(
  slug: string,
): Promise<string | null> {
  return safeUrl(`operators/${slug}/preview.png`);
}

/**
 * Fetch a download URL + the asset's `updated` metadata, then return
 * the URL with a `?v=<updatedAt>` cache-buster so the browser refetches
 * when the asset changes.
 */
export async function getVersionedUrl(path: string): Promise<string | null> {
  const s = storage();
  if (!s) return null;
  try {
    const r = ref(s, path);
    const [url, meta] = await Promise.all([
      getDownloadURL(r),
      getMetadata(r).catch(() => null),
    ]);
    if (meta?.updated) {
      const v = new Date(meta.updated).getTime();
      return `${url}?v=${v}`;
    }
    return url;
  } catch (err) {
    console.error("[storage] getVersionedUrl failed:", err);
    return null;
  }
}

/**
 * List all assets under a prefix. Used by the catalog UI to populate
 * the wraps/skins/charms grid without hard-coding the slugs.
 */
export async function listAssets(
  prefix: string,
): Promise<Array<{ name: string; fullPath: string; url: string | null }>> {
  const s = storage();
  if (!s) return [];
  try {
    const r = ref(s, prefix);
    const res = await listAll(r);
    const out = await Promise.all(
      res.items.map(async (item) => ({
        name: item.name,
        fullPath: item.fullPath,
        url: await getDownloadURL(item).catch(() => null),
      })),
    );
    return out;
  } catch (err) {
    console.error("[storage] listAssets failed:", err);
    return [];
  }
}

/**
 * Upload a community wrap. The caller must be signed-in (the path is
 * scoped to their uid so Security Rules can enforce ownership). Returns
 * the public download URL on success.
 *
 * Security Rules (storage.rules) enforce:
 *   - write: only the owner of `players/{uid}/…` paths
 *   - read:  public (any signed-in user)
 */
export async function uploadCommunityWrap(
  file: Blob | Uint8Array | ArrayBuffer,
  uid: string,
  name: string,
): Promise<string | null> {
  const s = storage();
  if (!s) return null;
  try {
    const path = `players/${uid}/wraps/${name}.png`;
    const r = ref(s, path);
    await uploadBytes(r, file, { contentType: "image/png" });
    return await getDownloadURL(r);
  } catch (err) {
    console.error("[storage] uploadCommunityWrap failed:", err);
    return null;
  }
}

/** Build a storage reference (advanced use). */
export function storageRef(path: string): StorageReference | null {
  const s = storage();
  if (!s) return null;
  return ref(s, path);
}

// ─── helpers ──────────────────────────────────────────────────────────────

async function safeUrl(path: string): Promise<string | null> {
  return getVersionedUrl(path);
}
