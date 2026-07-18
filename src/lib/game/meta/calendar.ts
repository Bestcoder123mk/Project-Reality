/**
 * SEC11-META prompt 88 — Live-ops content calendar.
 *
 * Internal admin tooling for scheduling live-ops events (battle pass
 * seasons, challenge resets, shop rotations, double-XP weekends, feature
 * flag flips) WITHOUT a code deploy. The ScheduledEvent table is the
 * durable store; this module exposes:
 *
 *   - `scheduleEvent(input)` — idempotent insert (upsert on `slug`).
 *   - `getActiveEvents(now?)` — events where `startsAt <= now < endsAt`
 *     AND `status IN ("scheduled", "active")`. Side-effect: transitions
 *     `scheduled` → `active` for events whose window just opened.
 *   - `getUpcomingEvents(now?, limit?)` — events where `startsAt > now`
 *     AND `status = "scheduled"`, sorted by `startsAt` ascending.
 *   - `getPastEvents(now?, limit?)` — events where `endsAt < now`, sorted
 *     by `endsAt` descending.
 *   - `cancelEvent(slug)` — sets status to "cancelled" (no delete — audit
 *     trail preserved).
 *   - `tickEventStatuses(now?)` — promotes scheduled→active + active→ended
 *     based on `now`. Idempotent.
 *
 * Event kinds (the `kind` field):
 *   - "season"           — battle pass season window (payload: { seasonId })
 *   - "challenge_reset"  — daily/weekly reset (payload: { cadence })
 *   - "shop_rotation"    — shop slot rotation (payload: { rotationSlug, slots })
 *   - "double_xp"        — double-XP weekend (payload: { multiplier })
 *   - "feature_flag"     — flag flip (payload: { flagKey, enabled, rollout? })
 *   - "event"            — free-form (payload: arbitrary)
 *
 * Payloads are JSON strings; this module provides typed accessors for the
 * known kinds (parseSeasonPayload, parseShopRotationPayload, etc.) so
 * consumers don't reinvent the parsing.
 *
 * This module is NON-player-facing. The /api/admin/calendar route is the
 * only intended consumer.
 */

import { db } from "@/lib/db";
import type { ScheduledEvent } from "@prisma/client";

export type ScheduledEventKind =
  | "season"
  | "challenge_reset"
  | "shop_rotation"
  | "double_xp"
  | "feature_flag"
  | "event";

export type ScheduledEventStatus = "scheduled" | "active" | "ended" | "cancelled";

export function isScheduledEventKind(v: unknown): v is ScheduledEventKind {
  return (
    v === "season" ||
    v === "challenge_reset" ||
    v === "shop_rotation" ||
    v === "double_xp" ||
    v === "feature_flag" ||
    v === "event"
  );
}

export function isScheduledEventStatus(v: unknown): v is ScheduledEventStatus {
  return v === "scheduled" || v === "active" || v === "ended" || v === "cancelled";
}

export interface ScheduleEventInput {
  /** Stable slug — same slug = same event (upsert). */
  slug: string;
  kind: ScheduledEventKind;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  status?: ScheduledEventStatus;
  /** Arbitrary JSON-serialisable payload. */
  payload?: Record<string, unknown>;
}

/** Validate a ScheduleEventInput before persisting. Pure — no DB. */
export function validateScheduleInput(input: ScheduleEventInput): string[] {
  const errs: string[] = [];
  if (!input.slug || input.slug.length < 3) errs.push("slug must be at least 3 chars");
  if (!isScheduledEventKind(input.kind)) errs.push(`unknown kind: ${input.kind}`);
  if (!input.title || input.title.length === 0) errs.push("title is required");
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) {
    errs.push("startsAt must be a Date");
  }
  if (!(input.endsAt instanceof Date) || Number.isNaN(input.endsAt.getTime())) {
    errs.push("endsAt must be a Date");
  }
  if (
    input.startsAt instanceof Date &&
    input.endsAt instanceof Date &&
    input.endsAt <= input.startsAt
  ) {
    errs.push("endsAt must be after startsAt");
  }
  if (input.status !== undefined && !isScheduledEventStatus(input.status)) {
    errs.push(`unknown status: ${input.status}`);
  }
  return errs;
}

/**
 * Idempotent schedule insert. Same `slug` = same event: re-scheduling with
 * the same slug updates the existing row (title, description, startsAt,
 * endsAt, payload, status). Returns the upserted row.
 */
export async function scheduleEvent(input: ScheduleEventInput): Promise<ScheduledEvent> {
  const errs = validateScheduleInput(input);
  if (errs.length > 0) {
    throw new Error(`Invalid schedule input: ${errs.join("; ")}`);
  }
  const payload = JSON.stringify(input.payload ?? {});
  const status: ScheduledEventStatus = input.status ?? "scheduled";
  return db.scheduledEvent.upsert({
    where: { slug: input.slug },
    update: {
      kind: input.kind,
      title: input.title,
      description: input.description ?? "",
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status,
      payload,
    },
    create: {
      slug: input.slug,
      kind: input.kind,
      title: input.title,
      description: input.description ?? "",
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status,
      payload,
    },
  });
}

/**
 * Promote `scheduled` → `active` (when `now >= startsAt`) + `active` →
 * `ended` (when `now >= endsAt`). Idempotent — safe to call on every
 * calendar GET. Returns the number of rows whose status changed.
 *
 * Cancelled events are skipped (their status is final).
 */
export async function tickEventStatuses(now: Date = new Date()): Promise<{
  promotedToActive: number;
  promotedToEnded: number;
}> {
  // scheduled → active
  const toActivate = await db.scheduledEvent.updateMany({
    where: {
      status: "scheduled",
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    data: { status: "active" },
  });
  // active → ended
  const toEnd = await db.scheduledEvent.updateMany({
    where: {
      status: "active",
      endsAt: { lte: now },
    },
    data: { status: "ended" },
  });
  return {
    promotedToActive: toActivate.count,
    promotedToEnded: toEnd.count,
  };
}

/**
 * Get all events currently active (`startsAt <= now < endsAt` AND status
 * IN ("scheduled", "active")). Side-effect: calls `tickEventStatuses`
 * first so the returned list reflects the current time.
 */
export async function getActiveEvents(now: Date = new Date()): Promise<ScheduledEvent[]> {
  await tickEventStatuses(now);
  return db.scheduledEvent.findMany({
    where: {
      status: { in: ["scheduled", "active"] },
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    orderBy: { endsAt: "asc" },
  });
}

/** Get upcoming events (start in the future, still scheduled). */
export async function getUpcomingEvents(
  now: Date = new Date(),
  limit = 20,
): Promise<ScheduledEvent[]> {
  return db.scheduledEvent.findMany({
    where: {
      status: "scheduled",
      startsAt: { gt: now },
    },
    orderBy: { startsAt: "asc" },
    take: limit,
  });
}

/** Get recently-ended events (audit / dashboard). */
export async function getPastEvents(
  now: Date = new Date(),
  limit = 20,
): Promise<ScheduledEvent[]> {
  return db.scheduledEvent.findMany({
    where: {
      status: { in: ["ended", "cancelled"] },
      endsAt: { lt: now },
    },
    orderBy: { endsAt: "desc" },
    take: limit,
  });
}

/** Cancel an event by slug. No-op if not found. Returns the updated row or null. */
export async function cancelEvent(slug: string): Promise<ScheduledEvent | null> {
  const existing = await db.scheduledEvent.findUnique({ where: { slug } });
  if (!existing) return null;
  if (existing.status === "cancelled") return existing;
  return db.scheduledEvent.update({
    where: { slug },
    data: { status: "cancelled" },
  });
}

// ─── Payload accessors ──────────────────────────────────────────────────

/** Parse the JSON payload of an event. Returns `{}` on parse failure. */
export function parsePayload(event: ScheduledEvent): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(event.payload ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

export interface SeasonPayload {
  seasonId?: string;
  seasonNumber?: number;
}
export interface ChallengeResetPayload {
  cadence: "daily" | "weekly";
}
export interface ShopRotationPayload {
  rotationSlug: string;
  slots?: string[];
}
export interface DoubleXpPayload {
  multiplier: number;
}
export interface FeatureFlagPayload {
  flagKey: string;
  enabled: boolean;
  rollout?: number;
}

export function parseSeasonPayload(event: ScheduledEvent): SeasonPayload {
  const p = parsePayload(event);
  return {
    seasonId: typeof p.seasonId === "string" ? p.seasonId : undefined,
    seasonNumber: typeof p.seasonNumber === "number" ? p.seasonNumber : undefined,
  };
}

export function parseChallengeResetPayload(event: ScheduledEvent): ChallengeResetPayload {
  const p = parsePayload(event);
  const cadence = p.cadence === "weekly" ? "weekly" : "daily";
  return { cadence };
}

export function parseShopRotationPayload(event: ScheduledEvent): ShopRotationPayload {
  const p = parsePayload(event);
  const rotationSlug = typeof p.rotationSlug === "string" ? p.rotationSlug : "";
  const slots = Array.isArray(p.slots)
    ? p.slots.filter((s): s is string => typeof s === "string")
    : undefined;
  return { rotationSlug, slots };
}

export function parseDoubleXpPayload(event: ScheduledEvent): DoubleXpPayload {
  const p = parsePayload(event);
  const multiplier = typeof p.multiplier === "number" && p.multiplier > 0 ? p.multiplier : 2;
  return { multiplier };
}

export function parseFeatureFlagPayload(event: ScheduledEvent): FeatureFlagPayload {
  const p = parsePayload(event);
  const flagKey = typeof p.flagKey === "string" ? p.flagKey : "";
  const enabled = p.enabled === true;
  const rollout = typeof p.rollout === "number" ? p.rollout : undefined;
  return { flagKey, enabled, rollout };
}

/** Serialize a ScheduledEvent row into the public API shape (camelCase). */
export function serializeScheduledEvent(event: ScheduledEvent) {
  return {
    id: event.id,
    slug: event.slug,
    kind: event.kind,
    title: event.title,
    description: event.description,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    status: event.status,
    payload: parsePayload(event),
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

export type SerializedScheduledEvent = ReturnType<typeof serializeScheduledEvent>;

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3826 (double_xp consumed)     — NEW: `applyDoubleXpMultiplier` below.
// 3827 (feature_flag consumed)  — NEW: `applyFeatureFlagFlip` below.
// 3828 (shop_rotation consumed) — NEW: `applyShopRotation` below.
// 3829 (tick only from admin → player routes auto-activate) — NEW: `tickForPlayerRoute` below.
// 3886 (double-XP consumption)  — same as 3826.
// 3887 (feature_flag consumption) — same as 3827.
// 3888 (shop_rotation consumption) — same as 3828.
// 3889 (tickEventStatuses on player routes) — same as 3829.

/**
 * I-5000 #3826 / #3886 / A-570 — Consume active `double_xp` events.
 *
 * Returns the effective XP multiplier for the current time (1.0 when no
 * double-XP event is active, the event's `multiplier` payload when one is).
 * When multiple double-XP events overlap, the MAX multiplier wins (the
 * player gets the best active boost).
 *
 * The caller (earn route) multiplies the canonical XP by this value before
 * persisting. The event itself is NOT mutated — it stays `active` until
 * its `endsAt` passes + `tickEventStatuses` flips it to `ended`.
 */
export async function applyDoubleXpMultiplier(now: Date = new Date()): Promise<number> {
  const events = await db.scheduledEvent.findMany({
    where: {
      kind: "double_xp",
      status: "active",
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    select: { payload: true },
  });
  if (events.length === 0) return 1.0;
  let max = 1.0;
  for (const e of events) {
    try {
      const p = JSON.parse(e.payload ?? "{}") as { multiplier?: unknown };
      const m = typeof p.multiplier === "number" && p.multiplier > 0 ? p.multiplier : 2;
      if (m > max) max = m;
    } catch {
      /* ignore parse errors */
    }
  }
  return max;
}

/**
 * I-5000 #3827 / #3887 / A-571 — Consume active `feature_flag` events.
 *
 * Returns the effective value for a feature flag, considering both the
 * FeatureFlag table (the static config) AND any active `feature_flag`
 * scheduled events (the live-ops override). When a scheduled event is
 * active for the given flag key, its `enabled` payload value overrides
 * the static config. The `rollout` payload value (0..1) is also returned
 * so A/B experiments can be live-tuned via the calendar.
 *
 * The caller (the flag-resolution path) calls this instead of reading the
 * FeatureFlag row directly when live-ops overrides should apply.
 */
export async function applyFeatureFlagFlip(
  flagKey: string,
  staticConfig: { enabled: boolean; rollout: number },
  now: Date = new Date(),
): Promise<{ enabled: boolean; rollout: number; overriddenByEvent: boolean }> {
  const events = await db.scheduledEvent.findMany({
    where: {
      kind: "feature_flag",
      status: "active",
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    select: { payload: true },
  });
  for (const e of events) {
    try {
      const p = JSON.parse(e.payload ?? "{}") as {
        flagKey?: unknown;
        enabled?: unknown;
        rollout?: unknown;
      };
      if (typeof p.flagKey === "string" && p.flagKey === flagKey) {
        return {
          enabled: p.enabled === true,
          rollout: typeof p.rollout === "number" ? p.rollout : staticConfig.rollout,
          overriddenByEvent: true,
        };
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return { ...staticConfig, overriddenByEvent: false };
}

/**
 * I-5000 #3828 / #3888 / A-572 — Consume active `shop_rotation` events.
 *
 * Returns the active shop-rotation slug + the slots that should be
 * displayed. When no `shop_rotation` event is active, returns null (the
 * caller renders the default shop layout). When one is active, the caller
 * renders only the slots listed in the event's payload.
 *
 * The event stays `active` until `endsAt` passes; the shop UI re-fetches
 * this on every render so the rotation flips at the scheduled time
 * without a deploy.
 */
export async function applyShopRotation(
  now: Date = new Date(),
): Promise<{ rotationSlug: string; slots: string[] } | null> {
  const event = await db.scheduledEvent.findFirst({
    where: {
      kind: "shop_rotation",
      status: "active",
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    orderBy: { startsAt: "desc" },
    select: { payload: true },
  });
  if (!event) return null;
  try {
    const p = JSON.parse(event.payload ?? "{}") as {
      rotationSlug?: unknown;
      slots?: unknown;
    };
    const rotationSlug = typeof p.rotationSlug === "string" ? p.rotationSlug : "";
    const slots = Array.isArray(p.slots)
      ? p.slots.filter((s): s is string => typeof s === "string")
      : [];
    if (!rotationSlug) return null;
    return { rotationSlug, slots };
  } catch {
    return null;
  }
}

/**
 * I-5000 #3829 / #3889 / A-573 — Player-route auto-tick.
 *
 * The `tickEventStatuses` function was previously only called from admin
 * routes (the calendar admin GET). Player routes that need the current
 * calendar state (battlepass, shop, earn) should call this helper to
 * promote scheduled→active + active→ended before they read.
 *
 * This is a thin wrapper around `tickEventStatuses` that swallows errors
 * (a calendar tick failure must NOT break a player's earn request). The
 * return value is the count of status transitions (for telemetry).
 */
export async function tickForPlayerRoute(now: Date = new Date()): Promise<{
  promotedToActive: number;
  promotedToEnded: number;
}> {
  try {
    return await tickEventStatuses(now);
  } catch {
    return { promotedToActive: 0, promotedToEnded: 0 };
  }
}
