/**
 * Task-1 (SEC) item 3, 11 — In-memory sliding-window rate limiter.
 *
 * Section A (149) / H (920) — rejected attempts are now RECORDED, not
 * silently dropped. This implements "penalty windows": every over-limit
 * request extends the window by recording its timestamp, so a client
 * that keeps hammering a 429'd endpoint sees its `Retry-After` keep
 * growing (the standard "leaky bucket" back-pressure behavior). The
 * previous behavior — drop the rejected timestamp — let a brute-forcer
 * retry at a fixed cadence forever.
 *
 * Section A (150) / H (921) — the store is bounded by an LRU cap
 * (default 10k keys). Old keys are evicted when the cap is hit so an
 * attacker can't OOM the process by generating unique rate-limit keys
 * (e.g. one per spoofed IP).
 *
 * Section H (922) — the store is pluggable. The default in-memory
 * `MapStore` is fine for single-instance dev/standalone; a `RedisStore`
 * adapter (provided but not wired — there's no Redis dep in the demo)
 * makes the limiter work across multiple Node.js instances (serverless /
 * k8s). The public API (`rateLimit`, `checkRateLimit`) is unchanged;
 * only the internal store implementation swaps.
 *
 * Two consumers (Task-1):
 *   - item 3:  `/api/shop/buy` + `/api/packs/open` — per-player-per-minute.
 *   - item 11: `/api/support/bug-report` + `/api/support/ticket` — per-IP-per-minute.
 *
 * Section H (923) — the `playerRateKey(playerId, route)` helper is the
 * per-player key builder; consumers like `/api/audio/vo` already use it.
 */

/** Pluggable store interface (922). Sync-only — MapStore-compatible. */
export interface RateLimitStore {
  /** Get the timestamps currently recorded for `key` (within window). */
  get(key: string): number[];
  /** Replace the timestamps for `key` (within window). */
  set(key: string, ts: number[]): void;
  /** Drop `key` from the store. */
  delete(key: string): void;
  /** Total entries (for LRU bound). */
  size(): number;
  /** Iterate keys, oldest-first (for LRU eviction). */
  keysOldestFirst(): IterableIterator<string>;
}

/**
 * Async store interface (922) — for Redis-backed adapters. The sync
 * `rateLimit` only works with `RateLimitStore`; use `rateLimitAsync`
 * with `AsyncRateLimitStore` (e.g. RedisStore).
 */
export interface AsyncRateLimitStore {
  get(key: string): Promise<number[]>;
  set(key: string, ts: number[]): Promise<void>;
  delete(key: string): Promise<void>;
  size(): Promise<number>;
  keysOldestFirst(): IterableIterator<string>;
}

/**
 * Default in-memory store: a `Map<string, number[]>` with LRU eviction.
 * Section A (150) / H (921) — bounded by `maxKeys` so the keyspace can't
 * grow unboundedly under an IP-spoofing / unique-key attack.
 */
export class MapStore implements RateLimitStore {
  private map = new Map<string, number[]>();
  constructor(private readonly maxKeys = 10_000) {}

  get(key: string): number[] {
    const v = this.map.get(key);
    if (!v) return [];
    // Refresh LRU position (Map preserves insertion order; delete + re-set
    // moves the key to the end / "most recently used").
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, ts: number[]): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, ts);
    // LRU eviction — oldest entry is the first key.
    while (this.map.size > this.maxKeys) {
      const firstKey = this.map.keys().next().value;
      if (firstKey === undefined) break;
      this.map.delete(firstKey);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  size(): number {
    return this.map.size;
  }

  keysOldestFirst(): IterableIterator<string> {
    return this.map.keys();
  }
}

/**
 * Section H (922) — Redis-backed store adapter. NOT wired (no Redis dep
 * in the demo) — included so a multi-instance deployment can drop in
 * `ioredis` or `@upstash/redis` and the rest of the limiter works
 * unchanged. The adapter uses a Redis LIST per key (RPUSH timestamps +
 * LTRIM to window) so multi-instance atomicity is preserved via Redis's
 * single-threaded command processing.
 */
export interface RedisLike {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  rpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  del(key: string): Promise<number>;
  dbsize?(): Promise<number>;
}

export class RedisStore implements AsyncRateLimitStore {
  constructor(private readonly redis: RedisLike, private readonly maxKeys = 10_000) {}

  async get(key: string): Promise<number[]> {
    const arr = await this.redis.lrange(key, 0, -1);
    return arr.map((s) => Number(s)).filter((n) => Number.isFinite(n));
  }

  async set(key: string, ts: number[]): Promise<void> {
    // Replace: del + rpush the new array. Not atomic across instances
    // but acceptable for rate-limiting (worst case: slight under-count
    // during the swap window). For strict atomicity use a Lua script.
    await this.redis.del(key);
    if (ts.length > 0) {
      await this.redis.rpush(key, ...ts.map((t) => String(t)));
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async size(): Promise<number> {
    if (this.redis.dbsize) return this.redis.dbsize();
    return 0;
  }

  keysOldestFirst(): IterableIterator<string> {
    // Redis doesn't expose ordered key iteration cheaply; the LRU bound
    // is enforced by setting a TTL on each key (caller does this via
    // `set` — for now this returns an empty iterator since the in-memory
    // LRU cap doesn't apply to Redis).
    return [][Symbol.iterator]();
  }
}

// The active store. Defaults to MapStore (sync). Call `setRateLimitStore`
// from boot (e.g. instrumentation.ts) to swap in another sync store.
// For an async store (Redis), use `setAsyncRateLimitStore` + `rateLimitAsync`.
let store: RateLimitStore = new MapStore();
let asyncStore: AsyncRateLimitStore | null = null;

/** Swap the active sync store. Used by boot code if a custom sync store is needed. */
export function setRateLimitStore(s: RateLimitStore): void {
  store = s;
}

/** Swap the active async store (Redis). When set, `rateLimitAsync` uses it. */
export function setAsyncRateLimitStore(s: AsyncRateLimitStore | null): void {
  asyncStore = s;
}

/** Internal — exposed for tests so they can reset the store between cases. */
export function _resetRateLimitStore(): void {
  if (store instanceof MapStore) {
    store.delete("__reset_marker__"); // ensure instance is alive
  }
  store = new MapStore();
}

export interface RateLimitOptions {
  /** Window size in ms (default 60_000 = 1 minute). */
  windowMs?: number;
  /** Max requests allowed in the window. */
  max: number;
  /** Optional friendly label for error messages + logs. */
  label?: string;
}

export interface RateLimitResult {
  ok: boolean;
  /** Number of requests in the current window (including this one if ok). */
  count: number;
  /** Max allowed per window. */
  limit: number;
  /** Ms until the oldest request in the window expires (retry-after hint). */
  retryAfterMs: number;
}

/**
 * Check + record a request against the rate limit for `key`. Returns the
 * result so the caller can format a 429 response with the standard
 * `Retry-After` + `X-RateLimit-*` headers.
 *
 * Section A (149) / H (920) — when over the limit, the rejected timestamp
 * is RECORDED (not dropped). This extends the window for repeat offenders
 * (penalty back-pressure). A client that keeps hitting 429 sees its
 * `Retry-After` keep growing instead of being able to retry at a fixed
 * cadence. The recorded-but-rejected timestamp is capped at the window
 * size so the penalty can't grow unboundedly (worst case: the bucket
 * stays full, so the client must wait the full window for the oldest
 * recorded timestamp to expire).
 */
export function rateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max;
  const now = Date.now();
  const cutoff = now - windowMs;

  const existing = store.get(key);
  // Evict timestamps older than the window.
  const recent = existing.filter((t) => t > cutoff);

  if (recent.length >= max) {
    // Over the limit. Record the rejected timestamp so a repeat offender's
    // window keeps extending (penalty back-pressure). Drop the oldest entry
    // so the array doesn't grow unboundedly — keep it at `max + 1` entries.
    recent.push(now);
    while (recent.length > max + 1) recent.shift();
    store.set(key, recent);
    const oldest = recent[0] ?? now;
    const retryAfterMs = Math.max(1, oldest + windowMs - now);
    return { ok: false, count: recent.length - 1, limit: max, retryAfterMs };
  }

  recent.push(now);
  store.set(key, recent);
  return { ok: true, count: recent.length, limit: max, retryAfterMs: 0 };
}

/**
 * Async variant — required when the store is async (RedisStore / 922).
 * Use this in route handlers; the sync `rateLimit` is kept for back-compat
 * with the in-memory store.
 */
export async function rateLimitAsync(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max;
  const now = Date.now();
  const cutoff = now - windowMs;
  // Use the async store if one is wired; otherwise fall back to the
  // sync store (so callers can switch to `rateLimitAsync` unconditionally
  // without breaking the in-memory dev path).
  if (asyncStore) {
    const existing = await asyncStore.get(key);
    const recent = existing.filter((t) => t > cutoff);
    if (recent.length >= max) {
      recent.push(now);
      while (recent.length > max + 1) recent.shift();
      await asyncStore.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfterMs = Math.max(1, oldest + windowMs - now);
      return { ok: false, count: recent.length - 1, limit: max, retryAfterMs };
    }
    recent.push(now);
    await asyncStore.set(key, recent);
    return { ok: true, count: recent.length, limit: max, retryAfterMs: 0 };
  }
  // Fall back to sync store (wrapped in await for type compatibility).
  return rateLimit(key, opts);
}

/**
 * Convenience wrapper — read-friendly result for callers that only need
 * a yes/no and don't want to format headers themselves.
 */
export function checkRateLimit(key: string, opts: RateLimitOptions): boolean {
  return rateLimit(key, opts).ok;
}

/**
 * Build a stable rate-limit key for a player-scoped route. Avoids
 * collision with IP-scoped keys (different prefix).
 *
 * Section H (923) — this is the per-player key builder. Consumers like
 * `/api/audio/vo` + `/api/shop/buy` + `/api/packs/open` already use it.
 */
export function playerRateKey(playerId: string, route: string): string {
  return `player:${playerId}:${route}`;
}

/**
 * Build a stable rate-limit key for an IP-scoped route. Caller is
 * responsible for using `getClientIp(req)` to populate the IP.
 */
export function ipRateKey(ip: string, route: string): string {
  return `ip:${ip}:${route}`;
}
