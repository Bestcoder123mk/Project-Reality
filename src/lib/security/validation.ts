/**
 * Task-1 (SEC) item 8, 16 — Shared Zod schema registry.
 *
 * Every route that trusts `req.json()` validates against a schema from
 * this registry. Centralizing the schemas here means:
 *
 *   1. One place to find the canonical shape of every request body.
 *   2. Cross-route consistency (the `playerId` field is the same shape
 *      in every route — UUID-ish, min length 1).
 *   3. Catalog-enum validation (item 16): `packSlugSchema` /
 *      `weaponSlugSchema` etc. enforce the slug is in the known set,
 *      so a tampered client sending `packSlug: "../../../etc/passwd"`
 *      is rejected before it reaches the catalog lookup.
 *
 * Schemas are written as `z.object({...})` so callers can `.safeParse()`
 * directly. The registry is intentionally exhaustive — every route that
 * accepts a JSON body should be able to find a matching schema here, or
 * add one.
 */

import { z } from "zod";
import { PACK_SLUGS } from "@/lib/game/meta/loot-odds";

// ── Catalog enums (item 16) ───────────────────────────────────────────────

/**
 * Known pack slugs. Pulled from `PACK_ODDS` at module load — stays in
 * sync with the live-ops team's table.
 */
export const packSlugSchema = z.enum(PACK_SLUGS as [string, ...string[]]);

/**
 * Known shop-item types. Matches the `CatalogKind` union in
 * `currency-guard.ts` minus PACK + BATTLE_PASS_PREMIUM (those go
 * through their own routes).
 */
export const shopItemTypeSchema = z.enum(["WEAPON", "ATTACHMENT", "SKIN", "OPERATOR"]);

/**
 * Free-form slug for a catalog item (weapon/attachment/skin/operator).
 * We don't enumerate every catalog slug here (the catalog is DB-driven
 * and changes); we just enforce shape + length so a path-traversal
 * payload can't slip through. The catalog lookup itself is the second
 * line of defense — `resolveCatalogPrice` returns null on an unknown
 * slug, and the route turns that into a 404.
 */
export const itemSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_]+$/i, "slug must be alphanumeric + underscore only");

// ── Player + reason ───────────────────────────────────────────────────────

/** Player ID — UUID-shaped string. The demo uses a fixed UUID. */
export const playerIdSchema = z.string().min(1).max(80);

/**
 * Free-text `reason` field — sanitized (item 23) before storage. We
 * cap at 500 chars + reject obvious control-character injection.
 */
export const reasonSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[\p{L}\p{N}\p{P}\p{Zs}\n]+$/u, "reason contains control characters");

// ── Route-specific request bodies ─────────────────────────────────────────

/** POST /api/shop/buy */
export const shopBuySchema = z.object({
  itemType: shopItemTypeSchema,
  slug: itemSlugSchema,
  clientPrice: z.number().int().min(0).max(1_000_000).optional(),
});

/** POST /api/packs/open */
export const packsOpenSchema = z.object({
  packSlug: packSlugSchema,
  clientPrice: z.number().int().min(0).max(1_000_000).optional(),
});

/** POST /api/player/delete (GDPR) */
export const playerDeleteSchema = z.object({
  playerId: playerIdSchema.optional(),
  confirm: z.literal("DELETE"),
  reason: reasonSchema.optional(),
});

/** POST /api/telemetry/hit (signed hit claim — item 21) */
export const hitClaimSchema = z.object({
  /** Attacker (shooter) player id. */
  shooterId: playerIdSchema,
  /** Victim (target) player id — for PvE this is the enemy unit id. */
  targetId: z.string().min(1).max(80),
  /** Weapon slug the shooter fired. Must exist in the catalog. */
  weaponSlug: itemSlugSchema,
  /** Hit location: head | torso | limb. */
  hitLocation: z.enum(["head", "torso", "limb"]),
  /** Distance to the target in meters (game units). */
  distance: z.number().nonnegative().max(2000),
  /** Timestamp of the shot, ms since epoch (client clock). */
  shotAtMs: z.number().int().min(0),
  /** HMAC-SHA256 signature over `${shooterId}|${targetId}|${weaponSlug}|${hitLocation}|${distance}|${shotAtMs}`. */
  signature: z.string().min(64).max(128),
  /** Server-issued nonce from the shooter's last /api/telemetry/session call. */
  nonce: z.string().min(16).max(64).optional(),
});

/** POST /api/admin/experiments */
export const adminExperimentSchema = z.object({
  key: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  rollout: z.number().min(0).max(1).optional(),
});

/** POST /api/admin/calendar */
export const adminCalendarSchema = z.object({
  slug: z.string().min(1).max(80),
  kind: z.enum([
    "season",
    "challenge_reset",
    "shop_rotation",
    "double_xp",
    "feature_flag",
    "event",
  ]),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  status: z
    .enum(["scheduled", "active", "ended", "cancelled"])
    .optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** POST /api/admin/verify-receipt (item 9) */
export const verifyReceiptSchema = z.object({
  playerId: playerIdSchema,
  reason: z.string().min(1).max(80),
  itemSlug: z.string().max(80).default(""),
  amount: z.number().int(),
  balanceBefore: z.number().int(),
  balanceAfter: z.number().int(),
  nonce: z.string().min(16).max(64),
  ts: z.string().min(1),
  signature: z.string().min(64).max(128),
});

// ── Player-facing mutating routes (item 8 — Zod on every req.json()) ───────

/** POST /api/clan/create — body { tag, name }. */
export const clanCreateSchema = z.object({
  tag: z
    .string()
    .min(2)
    .max(5)
    .regex(/^[a-zA-Z0-9]+$/, "tag must be alphanumeric"),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\p{L}\p{N}\p{P}\p{Zs}]+$/u, "name contains control characters"),
});

/** POST /api/clan/join — body { clanId }. */
export const clanJoinSchema = z.object({
  clanId: z.string().min(1).max(80),
});

/** POST /api/battlepass/claim — body { tier, isPremium? }. */
export const battlepassClaimSchema = z.object({
  tier: z.number().int().min(1).max(1000),
  isPremium: z.boolean().optional(),
});

/** POST /api/challenges/claim — body { challengeId }. */
export const challengeClaimSchema = z.object({
  challengeId: z.string().min(1).max(80),
});

/** POST /api/player/earn — body { credits, xp, kills, wave, result, headshots?, melee?, sessionId, nonce }. */
export const playerEarnSchema = z.object({
  credits: z.number().min(0).max(1_000_000),
  xp: z.number().min(0).max(1_000_000),
  kills: z.number().min(0).max(10_000).optional().default(0),
  wave: z.number().min(0).max(10_000).optional().default(0),
  result: z.enum(["VICTORY", "DEFEAT"]).optional().default("DEFEAT"),
  headshots: z.number().min(0).max(10_000).optional().default(0),
  melee: z.number().min(0).max(10_000).optional().default(0),
  /** Section H (925): match session id (for server-side stat validation). */
  sessionId: z.string().min(1).max(120).optional(),
  /** Section H (925): single-use nonce (replay protection). */
  nonce: z.string().min(32).max(64).optional(),
});

/** POST /api/loadout/equip — body { weaponSlug, muzzleSlug?, sightSlug?, gripSlug?, magazineSlug?, skinSlug? }. */
const optionalSlug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_]+$/i)
  .optional();
export const loadoutEquipSchema = z.object({
  weaponSlug: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/i),
  muzzleSlug: optionalSlug,
  sightSlug: optionalSlug,
  gripSlug: optionalSlug,
  magazineSlug: optionalSlug,
  skinSlug: optionalSlug,
});

/** POST /api/loadout/equip-operator — body { operatorSlug }. */
export const loadoutEquipOperatorSchema = z.object({
  operatorSlug: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/i),
});

/** POST /api/audio/vo — body { text, voice? }. */
export const audioVoSchema = z.object({
  text: z.string().min(1).max(1024),
  voice: z
    .enum([
      "tongtong",
      "chuichui",
      "xiaochen",
      "jam",
      "kazi",
      "douji",
      "luodo",
    ])
    .optional(),
});

/** POST /api/player/data-export — body { playerId? }. */
export const playerDataExportSchema = z.object({
  playerId: playerIdSchema.optional(),
});

/**
 * POST /api/telemetry/events — batched analytics ingest.
 * Each event has `name`, optional `props`, `at`, `sessionId`, `playerId`.
 * The `props` field is allowed to be an arbitrary object (the schema
 * enforces shape, not contents — `sanitizeFreeText` is the responsibility
 * of the consumer for any prop value that gets rendered).
 */
const telemetryEventItemSchema = z.object({
  name: z.string().min(1).max(120),
  props: z.record(z.string(), z.unknown()).optional(),
  at: z.union([z.number(), z.string()]).optional(),
  sessionId: z.string().min(1).max(120).optional(),
  playerId: z.string().min(1).max(80).optional(),
});
export const telemetryEventsSchema = z.object({
  events: z.array(telemetryEventItemSchema).max(500),
});

/** POST /api/telemetry/errors — crash report ingest. */
export const telemetryErrorsSchema = z.object({
  id: z.string().max(120).optional(),
  message: z.string().min(1).max(4000),
  stack: z.string().max(16_000).optional(),
  severity: z
    .enum(["fatal", "error", "warning", "info", "debug"])
    .optional()
    .default("error"),
  tags: z.record(z.string(), z.unknown()).optional(),
  breadcrumbs: z.array(z.unknown()).max(500).optional(),
  url: z.string().max(2000).optional(),
  sessionId: z.string().max(120).optional(),
  buildId: z.string().max(120).optional(),
});

/** POST /api/player/cloud-save — cross-device cloud save (L1-5000 #4502). */
export const cloudSaveSchema = z.object({
  payload: z.string().max(262144), // 256KB cap
  version: z.number().int().positive().max(100),
  externalAccountId: z.string().max(200).optional(),
  externalPlatform: z.string().max(50).optional(),
});
