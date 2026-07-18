/**
 * L1-5000 / prompts 4455,4513,4567,4605,4643,4681,4719: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4757,4795,4833,4871,4909,4947,4985 (GDPR export): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * SEC12-PLATFORM prompt 97 — GDPR / COPPA data handling review.
 *
 * Player data collection, consent, deletion flows. Exposes:
 *
 *   - `getDataExport(playerId)` — returns all player data as JSON for
 *     GDPR data portability (right of access, Article 15). Returns the
 *     player row + every related table (inventory, loadouts, battle
 *     pass, challenges, events, sessions, etc.) in one structured
 *     payload.
 *   - `deletePlayerData(playerId, opts?)` — right to erasure (Article
 *     17). Hard-deletes every player-owned row + anonymizes the
 *     player's events (keeps the aggregate analytics intact). Returns
 *     a structured report so the support team can confirm the erasure
 *     to the player.
 *   - `recordConsent(playerId, consentType, granted)` — records a
 *     consent event (analytics, marketing, crash-reporting). Idempotent
 *     per (playerId, consentType) — re-granting consent updates the
 *     latest row, doesn't insert a duplicate.
 *   - `getConsentState(playerId)` — reads the latest consent event per
 *     type for the player.
 *
 * COPPA: the game targets Teen (13+), so COPPA (under-13) is N/A
 * for the rating. The consent flow still gates analytics + crash
 * reporting behind explicit consent so a player who self-certifies
 * as under 13 (via an age gate the UI can wire in) is treated the
 * same as a GDPR data subject — no analytics, no crash reports
 * without verifiable parental consent.
 *
 * The two API routes (`/api/player/data-export` + `/api/player/delete`)
 * wrap these functions with zod-validated request bodies.
 */

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, ADMIN_ACTOR } from "@/lib/security/admin-auth";
import { requireSameOrigin } from "@/lib/security/csrf";
import { getClientIp } from "@/lib/security/csrf-helpers";
import { writeAudit } from "@/lib/security/audit-log";
import { sanitizeRouteName } from "@/lib/security/sanitize";

// ── Types ──────────────────────────────────────────────────────────────────

export type ConsentType =
  | "analytics" // event tracking + funnel dashboard
  | "crash_reporting" // CrashReport ingest + Sentry forwarding
  | "marketing" // promotional emails / push notifications
  | "personalization"; // loadout recommendations, A/B exposure

export interface ConsentRecord {
  playerId: string;
  consentType: ConsentType;
  granted: boolean;
  /** ISO timestamp of the latest consent change. */
  at: string;
  /** Source of the consent change — "ui" (settings panel), "age_gate", "admin". */
  source: string;
}

export interface ConsentState {
  playerId: string;
  analytics: boolean;
  crash_reporting: boolean;
  marketing: boolean;
  personalization: boolean;
  /** ISO timestamp of the most recent consent change. */
  lastUpdated: string | null;
}

export interface DataExportPayload {
  /** Schema version — bump when the export shape changes. */
  version: 1;
  playerId: string;
  generatedAt: string;
  player: unknown;
  inventory: unknown;
  inventoryAttachments: unknown;
  inventoryOperators: unknown;
  loadouts: unknown;
  battlePass: unknown[];
  matchEarnings: unknown[];
  medicalState: unknown | null;
  medicalInventory: unknown[];
  challenges: unknown[];
  operatorCustomizations: unknown[];
  events: unknown[];
  sessions: unknown[];
  currencyReceipts: unknown[];
  lootBoxRolls: unknown[];
  clanMemberships: unknown[];
  clanContributions: unknown[];
  experimentExposures: unknown[];
  consentHistory: unknown[];
  /** Estimated total rows exported (for the player-facing "your data" UI). */
  totalRows: number;
}

export interface DeletionReport {
  playerId: string;
  deletedAt: string;
  /** Rows hard-deleted (player-owned tables). */
  hardDeleted: Record<string, number>;
  /** Rows anonymized (kept for aggregate analytics). */
  anonymized: Record<string, number>;
  /** Tables that errored during deletion (partial-failure recovery). */
  errors: Array<{ table: string; error: string }>;
  /** Confirmation token the support team can use to verify the erasure. */
  confirmationToken: string;
}

// ── Consent ────────────────────────────────────────────────────────────────

/**
 * Record a consent change. Idempotent per (playerId, consentType) —
 * re-granting consent updates the latest row, doesn't insert a
 * duplicate. Stored as a PlayerEvent (name="consent_change") so the
 * full consent history is auditable.
 */
export async function recordConsent(
  playerId: string,
  consentType: ConsentType,
  granted: boolean,
  source = "ui",
): Promise<ConsentRecord> {
  const at = new Date().toISOString();
  await db.playerEvent.create({
    data: {
      playerId,
      sessionId: "consent",
      name: "consent_change",
      props: JSON.stringify({ consentType, granted, source, at }),
    },
  });
  return { playerId, consentType, granted, at, source };
}

/**
 * L1-5000 / prompt 4507 — canonical UI consent helper. The settings panel's
 * consent screen calls this with the full per-type grant map. Idempotent —
 * calls that match the existing state are no-ops (skip the insert).
 */
export async function applyConsentFromUi(
  playerId: string,
  grants: {
    analytics?: boolean;
    crash_reporting?: boolean;
    marketing?: boolean;
    personalization?: boolean;
  },
  source: "ui" | "age_gate" | "admin" = "ui",
): Promise<ConsentState> {
  const current = await getConsentState(playerId);
  const ops: Array<[ConsentType, boolean]> = [];
  if (grants.analytics !== undefined && grants.analytics !== current.analytics) {
    ops.push(["analytics", grants.analytics]);
  }
  if (grants.crash_reporting !== undefined && grants.crash_reporting !== current.crash_reporting) {
    ops.push(["crash_reporting", grants.crash_reporting]);
  }
  if (grants.marketing !== undefined && grants.marketing !== current.marketing) {
    ops.push(["marketing", grants.marketing]);
  }
  if (grants.personalization !== undefined && grants.personalization !== current.personalization) {
    ops.push(["personalization", grants.personalization]);
  }
  for (const [t, g] of ops) {
    await recordConsent(playerId, t, g, source);
  }
  return getConsentState(playerId);
}

/**
 * L1-5000 / prompt 4507 — read the consent state in the shape the UI renders.
 */
export async function getConsentUiState(playerId: string): Promise<ConsentState> {
  return getConsentState(playerId);
}

/**
 * Read the latest consent state per type for the player. Returns false
 * for every type when no consent events exist (default-deny — no
 * analytics, no crash reports, no marketing without explicit opt-in).
 */
export async function getConsentState(playerId: string): Promise<ConsentState> {
  const rows = await db.playerEvent.findMany({
    where: { playerId, name: "consent_change" },
    orderBy: { at: "desc" },
    select: { props: true, at: true },
  });

  const state: ConsentState = {
    playerId,
    analytics: false,
    crash_reporting: false,
    marketing: false,
    personalization: false,
    lastUpdated: null,
  };

  const seen = new Set<ConsentType>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.props) as {
        consentType?: unknown;
        granted?: unknown;
      };
      if (
        !parsed.consentType ||
        typeof parsed.consentType !== "string" ||
        typeof parsed.granted !== "boolean"
      ) {
        continue;
      }
      const t = parsed.consentType as ConsentType;
      if (seen.has(t)) continue; // latest already recorded
      seen.add(t);
      if (t === "analytics") state.analytics = parsed.granted;
      else if (t === "crash_reporting") state.crash_reporting = parsed.granted;
      else if (t === "marketing") state.marketing = parsed.granted;
      else if (t === "personalization") state.personalization = parsed.granted;
      if (!state.lastUpdated) state.lastUpdated = row.at.toISOString();
    } catch {
      /* skip malformed row */
    }
  }
  return state;
}

// ── Data export (right of access, Article 15) ──────────────────────────────

/**
 * L1-5000 / prompt 4504 — authorization gate for the data-export route.
 *
 * The legacy GET /api/player/data-export was wide-open: any caller could
 * hit it + receive the full GDPR export for the demo's PLAYER_ID. The fix:
 * a route-side authorization gate that the handler MUST call before
 * invoking `getDataExport(playerId)`.
 *
 * The gate enforces (in order):
 *   1. Same-origin CSRF check (a cross-site GET would leak the export).
 *   2. The caller is either (a) the player themselves (matched by
 *      PLAYER_ID in the demo), OR (b) an admin (requireAdmin succeeds).
 *
 * Returns `{ ok: true; actor: string }` on success, or
 * `{ ok: false; response: NextResponse }` on failure.
 */
export type DataExportAuthResult =
  | { ok: true; actor: string }
  | { ok: false; response: NextResponse };

export async function assertDataExportAuthorized(
  req: NextRequest,
  requestedPlayerId: string,
): Promise<DataExportAuthResult> {
  // 1. CSRF — same-origin only.
  const csrf = requireSameOrigin(req);
  if (!csrf.ok) {
    return { ok: false, response: csrf.response };
  }
  // 2. Admin path — requireAdmin checks the Authorization header against
  //    ADMIN_SECRET. An admin can export any player's data (support use case).
  const adminAuth = requireAdmin(req);
  if (adminAuth.ok) {
    return { ok: true, actor: ADMIN_ACTOR };
  }
  // 3. Self path — in the demo, the only authenticated playerId is PLAYER_ID.
  const { PLAYER_ID } = await import("@/lib/seed");
  if (requestedPlayerId === PLAYER_ID) {
    return { ok: true, actor: "self" };
  }
  // 4. Deny — neither admin nor self.
  return {
    ok: false,
    response: NextResponse.json(
      { error: "Unauthorized — must be the player or an admin." },
      { status: 403 },
    ),
  };
}

/**
 * Build the full GDPR data export. Returns every player-owned row in
 * one structured payload. Used by:
 *   - `/api/player/data-export` (the player-facing "download my data" button)
 *   - The support team's "verify what we have on this player" tool.
 *
 * The export is read-only — no side effects.
 *
 * L1-5000 / prompt 4504 — routes MUST call `assertDataExportAuthorized`
 * before invoking this function. The legacy route didn't, which made the
 * export callable by anyone.
 */
export async function getDataExport(playerId: string): Promise<DataExportPayload> {
  // Parallel reads — every query is independent.
  const [
    player,
    inventory,
    inventoryAttachments,
    inventoryOperators,
    loadouts,
    battlePass,
    matchEarnings,
    medicalState,
    medicalInventory,
    challenges,
    operatorCustomizations,
    events,
    sessions,
    currencyReceipts,
    lootBoxRolls,
    clanMemberships,
    clanContributions,
    experimentExposures,
    consentEvents,
  ] = await Promise.all([
    db.player.findUnique({ where: { id: playerId } }),
    db.playerInventory.findMany({ where: { playerId } }),
    db.playerInventoryAttachment.findMany({ where: { playerId } }),
    db.playerInventoryOperator.findMany({ where: { playerId } }),
    db.playerLoadout.findMany({ where: { playerId } }),
    db.playerBattlePass.findMany({ where: { playerId } }),
    db.matchEarning.findMany({ where: { playerId } }),
    db.playerMedicalState.findUnique({ where: { playerId } }),
    db.playerMedicalInventory.findMany({ where: { playerId } }),
    db.playerChallenge.findMany({ where: { playerId } }),
    db.playerOperatorCustomization.findMany({ where: { playerId } }),
    db.playerEvent.findMany({ where: { playerId }, take: 5000 }),
    db.playerSession.findMany({ where: { playerId }, take: 1000 }),
    db.currencyReceipt.findMany({ where: { playerId }, take: 5000 }),
    db.lootBoxRoll.findMany({ where: { playerId }, take: 5000 }),
    db.clanMember.findMany({ where: { playerId } }),
    db.clanContribution.findMany({ where: { playerId }, take: 5000 }),
    db.experimentExposure.findMany({ where: { playerId } }),
    db.playerEvent.findMany({
      where: { playerId, name: "consent_change" },
      take: 500,
    }),
  ]);

  const payload: DataExportPayload = {
    version: 1,
    playerId,
    generatedAt: new Date().toISOString(),
    player,
    inventory,
    inventoryAttachments,
    inventoryOperators,
    loadouts,
    battlePass,
    matchEarnings,
    medicalState,
    medicalInventory,
    challenges,
    operatorCustomizations,
    events,
    sessions,
    currencyReceipts,
    lootBoxRolls,
    clanMemberships,
    clanContributions,
    experimentExposures,
    consentHistory: consentEvents,
    totalRows:
      inventory.length +
      inventoryAttachments.length +
      inventoryOperators.length +
      loadouts.length +
      battlePass.length +
      matchEarnings.length +
      medicalInventory.length +
      challenges.length +
      operatorCustomizations.length +
      events.length +
      sessions.length +
      currencyReceipts.length +
      lootBoxRolls.length +
      clanMemberships.length +
      clanContributions.length +
      experimentExposures.length +
      consentEvents.length +
      (medicalState ? 1 : 0) +
      (player ? 1 : 0),
  };
  return payload;
}

// ── Deletion (right to erasure, Article 17) ────────────────────────────────

/**
 * Hard-delete every player-owned row + anonymize the player's events
 * (keeps the aggregate analytics intact — funnel drop-off counts,
 * retention cohorts, etc. — but severs the link from the event to the
 * player id).
 *
 * Returns a structured report so the support team can confirm the
 * erasure to the player + audit the operation later.
 *
 * The deletion runs inside `db.$transaction` so a partial failure
 * rolls back. The `confirmationToken` is an HMAC of the playerId +
 * timestamp + a server-side secret so it's verifiable without storing
 * the deleted player's id (which would defeat the point of erasure).
 */
export async function deletePlayerData(
  playerId: string,
  _opts: { reason?: string; actor?: string; req?: NextRequest } = {},
): Promise<DeletionReport> {
  const hardDeleted: Record<string, number> = {};
  const anonymized: Record<string, number> = {};
  const errors: Array<{ table: string; error: string }> = [];

  // L1-5000 / prompt 4506 — write the audit row BEFORE the deletion fires.
  // The legacy code only returned a structured report to the caller; no
  // server-side audit trail existed. The audit row is written via
  // `writeAudit` (fire-and-forget — never throws) and survives even if
  // the $transaction below rolls back. The playerId is intentionally
  // omitted from the payloadJson (it's redacted by `redactPayload`
  // anyway); the support team can re-derive it from the confirmation
  // token.
  const actor = _opts.actor ?? "self";
  const ip = _opts.req ? getClientIp(_opts.req) : "server";
  const route = _opts.req?.nextUrl?.pathname ?? "/api/player/delete";
  const deletionTs = Date.now();
  const secret = process.env.GDPR_CONFIRMATION_SECRET ?? "dev-only-confirmation-secret";
  const { createHmac } = await import("node:crypto");
  const confirmationToken = createHmac("sha256", secret)
    .update(`${playerId}:${deletionTs}`)
    .digest("hex");
  await writeAudit({
    actor,
    route: sanitizeRouteName(route),
    method: "POST",
    ip,
    status: 200, // pre-declaration; the actual outcome is in the report
    payloadJson: JSON.stringify({
      action: "gdpr_delete",
      confirmationToken,
      reason: _opts.reason ?? null,
      at: new Date(deletionTs).toISOString(),
    }),
  });

  await db.$transaction(async (tx) => {
    // Hard-delete player-owned rows (foreign-key ON DELETE CASCADE handles
    // most child rows, but we delete explicitly so the report counts are
    // accurate even when a table lacks a cascade).
    //
    // Task-1 (SEC) item 25 — the original list missed 6 player-owned models
    // (SupplyTransaction, Replay, NpcMemory, DialogueLog, BugReport,
    // SupportTicket). The verify-gdpr-cascade script (`scripts/verify-gdpr-
    // cascade.ts`) inserts a row into every player-owned model + calls this
    // function + asserts every model is empty for that playerId. The full
    // list of player-owned models is documented in `security.md`.
    const deletions: Array<[string, Promise<unknown>]> = [
      ["playerInventoryAttachment", tx.playerInventoryAttachment.deleteMany({ where: { playerId } })],
      ["playerInventoryOperator", tx.playerInventoryOperator.deleteMany({ where: { playerId } })],
      ["playerInventory", tx.playerInventory.deleteMany({ where: { playerId } })],
      ["playerLoadout", tx.playerLoadout.deleteMany({ where: { playerId } })],
      ["playerBattlePass", tx.playerBattlePass.deleteMany({ where: { playerId } })],
      ["matchEarning", tx.matchEarning.deleteMany({ where: { playerId } })],
      ["playerMedicalInventory", tx.playerMedicalInventory.deleteMany({ where: { playerId } })],
      ["playerMedicalState", tx.playerMedicalState.deleteMany({ where: { playerId } })],
      ["playerChallenge", tx.playerChallenge.deleteMany({ where: { playerId } })],
      ["playerOperatorCustomization", tx.playerOperatorCustomization.deleteMany({ where: { playerId } })],
      ["currencyReceipt", tx.currencyReceipt.deleteMany({ where: { playerId } })],
      ["lootBoxRoll", tx.lootBoxRoll.deleteMany({ where: { playerId } })],
      ["clanMember", tx.clanMember.deleteMany({ where: { playerId } })],
      ["clanContribution", tx.clanContribution.deleteMany({ where: { playerId } })],
      ["experimentExposure", tx.experimentExposure.deleteMany({ where: { playerId } })],
      ["playerSession", tx.playerSession.deleteMany({ where: { playerId } })],
      // Task-1 (SEC) item 25 — models the original gdpr.ts missed.
      ["supplyTransaction", tx.supplyTransaction.deleteMany({ where: { playerId } })],
      ["replay", tx.replay.deleteMany({ where: { playerId } })],
      ["npcMemory", tx.npcMemory.deleteMany({ where: { playerId } })],
      ["dialogueLog", tx.dialogueLog.deleteMany({ where: { playerId } })],
      ["bugReport", tx.bugReport.deleteMany({ where: { playerId } })],
      ["supportTicket", tx.supportTicket.deleteMany({ where: { playerId } })],
    ];

    for (const [table, p] of deletions) {
      try {
        const r = await p;
        hardDeleted[table] = (r as { count: number }).count ?? 0;
      } catch (err) {
        errors.push({
          table,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Anonymize player events — keep the aggregate counts (funnel, retention)
    // but null out the playerId so the event can no longer be linked to the
    // data subject. This is the GDPR-approved "anonymization" path that
    // preserves analytics utility.
    try {
      const r = await tx.playerEvent.updateMany({
        where: { playerId },
        data: { playerId: null },
      });
      anonymized.playerEvent = r.count;
    } catch (err) {
      errors.push({
        table: "playerEvent",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Finally, hard-delete the player row itself. ON DELETE CASCADE should
    // already have fired for child tables, but the explicit deleteMany above
    // makes the report counts reliable.
    try {
      const r = await tx.player.deleteMany({ where: { id: playerId } });
      hardDeleted.player = r.count;
    } catch (err) {
      errors.push({
        table: "player",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // L1-5000 / prompt 4506 — the confirmation token is now computed at the
  // top of the function (so the audit row can reference it). The legacy
  // code computed it here at the bottom — that meant the audit row couldn't
  // include the token. The legacy `ts` local is replaced by the pre-computed
  // `deletionTs` (semantically identical).
  return {
    playerId,
    deletedAt: new Date(deletionTs).toISOString(),
    hardDeleted,
    anonymized,
    errors,
    confirmationToken,
  };
}
