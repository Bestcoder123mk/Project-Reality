/**
 * Remote Config — client-side fetch for feature flags + A/B tests.
 *
 * Section I (Firebase & Backend).
 *
 * Wraps the Firebase Remote Config SDK so callers get a typed config
 * object instead of touching `firebase/remote-config` directly. Values
 * are fetched with a minimum fetch interval (5s in dev, 1h in prod) and
 * cached locally so the first paint has the previous fetch's values.
 *
 * Public API:
 *   - `initRemoteConfig()` — call once on the client (lazy)
 *   - `getRemoteConfigValue(key)` — single-value getter
 *   - `getAllRemoteConfig()` — full typed snapshot
 *   - `subscribeToRemoteConfig(cb)` — live updates
 *   - `REMOTE_CONFIG_DEFAULTS` — the in-code fallback values
 *
 * The defaults mirror the Prisma `FeatureFlag` table so the game works
 * identically whether Remote Config is configured or not. When it IS
 * configured, the cloud values override the defaults at runtime.
 */

import {
  getRemoteConfig,
  fetchConfig,
  getValue,
  getAll,
  type RemoteConfig as FirebaseRemoteConfig,
} from "firebase/remote-config";

import { getFirebaseApp } from "@/lib/firebase";

let _rc: FirebaseRemoteConfig | null = null;
let _initAttempted = false;

/** In-code default values — used when Remote Config is unavailable. */
export const REMOTE_CONFIG_DEFAULTS = {
  // Feature flags.
  enable_cloud_save: "true",
  enable_google_signin: "true",
  enable_clans: "false",
  enable_matchmaking: "false",
  enable_leaderboard: "false",
  enable_packs: "true",
  enable_shop: "true",
  enable_battlepass: "true",
  enable_gunsmith: "true",
  // Live-ops tuning.
  daily_bonus_credits: "100",
  weekly_bonus_credits: "500",
  battlepass_tier_size: "1000",
  battlepass_max_tier: "50",
  // A/B tests — cohort percentage (0..100).
  ab_new_hud_layout: "0",
  ab_tactical_sprint: "0",
  ab_recoil_rework: "0",
  // Maintenance mode.
  maintenance_mode: "false",
  maintenance_message: "",
  // Build version gate — minimum client version allowed to connect.
  min_client_version: "0.0.0",
} as const;

export type RemoteConfigKey = keyof typeof REMOTE_CONFIG_DEFAULTS;
export type RemoteConfigMap = Record<RemoteConfigKey, string>;

const listeners = new Set<(cfg: RemoteConfigMap) => void>();
let lastSnapshot: RemoteConfigMap = { ...REMOTE_CONFIG_DEFAULTS };

/** Initialize Remote Config. Idempotent + SSR-safe. */
export function initRemoteConfig(): FirebaseRemoteConfig | null {
  if (typeof window === "undefined") return null;
  if (_rc) return _rc;
  if (_initAttempted) return null;
  _initAttempted = true;

  const app = getFirebaseApp();
  if (!app) return null;

  try {
    _rc = getRemoteConfig(app);
    _rc.settings.minimumFetchIntervalMillis =
      process.env.NODE_ENV === "production" ? 3_600_000 : 5_000;
    _rc.defaultConfig = { ...REMOTE_CONFIG_DEFAULTS };
    return _rc;
  } catch (err) {
    console.error("[remote-config] init failed:", err);
    return null;
  }
}

/** Trigger a fetch from the server. Safe to call repeatedly. */
export async function refreshRemoteConfig(): Promise<RemoteConfigMap> {
  if (!_rc) initRemoteConfig();
  if (!_rc) return { ...REMOTE_CONFIG_DEFAULTS };
  try {
    await fetchConfig(_rc);
    lastSnapshot = getAll(_rc) as unknown as RemoteConfigMap;
    listeners.forEach((cb) => cb(lastSnapshot));
    return lastSnapshot;
  } catch (err) {
    console.error("[remote-config] fetch failed:", err);
    return lastSnapshot;
  }
}

/** Get a single value as a string (with default fallback). */
export function getRemoteConfigValue(key: RemoteConfigKey): string {
  if (!_rc) initRemoteConfig();
  if (!_rc) return REMOTE_CONFIG_DEFAULTS[key];
  try {
    return getValue(_rc, key).asString();
  } catch {
    return REMOTE_CONFIG_DEFAULTS[key];
  }
}

/** Get a value as a boolean. */
export function getRemoteConfigBool(key: RemoteConfigKey): boolean {
  const v = getRemoteConfigValue(key).toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Get a value as a number. */
export function getRemoteConfigNumber(key: RemoteConfigKey): number {
  const v = getRemoteConfigValue(key);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Get the full typed snapshot (live — reflects the last fetch). */
export function getAllRemoteConfig(): RemoteConfigMap {
  if (!_rc) initRemoteConfig();
  if (!_rc) return { ...REMOTE_CONFIG_DEFAULTS };
  try {
    return getAll(_rc) as unknown as RemoteConfigMap;
  } catch {
    return { ...REMOTE_CONFIG_DEFAULTS };
  }
}

/** Live subscription. The callback fires immediately with the current
 *  snapshot, then again after every successful refresh. */
export function subscribeToRemoteConfig(
  cb: (cfg: RemoteConfigMap) => void,
): () => void {
  listeners.add(cb);
  cb(lastSnapshot);
  return () => listeners.delete(cb);
}
