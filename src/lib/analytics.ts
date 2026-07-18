/**
 * Analytics — provider-agnostic event pipeline.
 *
 * Prompt 4 of the AAA roadmap. Replaces ad-hoc local writes with a single
 * typed event surface that:
 *   - Buffers events in-process and flushes to /api/telemetry/events.
 *   - Forwards to PostHog/Amplitude when a project key is configured
 *     (NEXT_PUBLIC_POSTHOG_KEY / NEXT_PUBLIC_AMPLITUDE_KEY).
 *   - Tags every event with the session id + anonymous player id so funnel
 *     drop-off (menu → match → purchase) is reconstructable.
 *
 * The server route (/api/telemetry/events) is the durable store: it writes
 * to the PlayerEvent table and (optionally) fans out to the real provider.
 */

export type AnalyticsEventName =
  | "session_start"
  | "screen_view"
  | "menu_deploy"
  | "match_start"
  | "match_end"
  | "weapon_fired"
  | "enemy_killed"
  | "player_died"
  | "shop_view"
  | "shop_buy"
  | "pack_open"
  | "battlepass_claim"
  | "loadout_change"
  | "settings_change"
  | "tutorial_step"
  | "pointer_lock_engage"
  | "context_lost"
  | "safe_mode_engaged"
  | "error";

export interface AnalyticsEvent {
  name: AnalyticsEventName;
  props?: Record<string, string | number | boolean | null | undefined>;
  at: number;
  sessionId: string;
  playerId?: string;
}

const buffer: AnalyticsEvent[] = [];
const FLUSH_INTERVAL = 8000; // 8s
const FLUSH_AT = 20; // or 20 events
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function sessionId(): string {
  if (typeof window === "undefined") return "ssr";
  const w = window as unknown as { __PR_SESSION_ID__?: string };
  if (!w.__PR_SESSION_ID__) w.__PR_SESSION_ID__ = crypto.randomUUID();
  return w.__PR_SESSION_ID__;
}

function playerId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return localStorage.getItem("pr_player_id") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Track an event. Safe to call from any client component. */
export function track(
  name: AnalyticsEventName,
  props?: Record<string, string | number | boolean | null | undefined>,
) {
  if (typeof window === "undefined") return;
  buffer.push({
    name,
    props,
    at: Date.now(),
    sessionId: sessionId(),
    playerId: playerId(),
  });
  if (buffer.length >= FLUSH_AT) void flush();
  else scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer || typeof window === "undefined") return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL);
}

/** Flush the buffer to the server. Exposed for the page-hide beacon. */
export async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    await fetch("/api/telemetry/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
  } catch {
    // Re-queue on failure (cap to avoid unbounded growth).
    buffer.unshift(...batch.slice(-FLUSH_AT));
  }
}

/** Wire a page-hide beacon so the final batch isn't lost. */
export function initAnalytics() {
  if (typeof window === "undefined") return;
  window.addEventListener("pagehide", () => {
    void flush();
  });
  track("session_start");
}
