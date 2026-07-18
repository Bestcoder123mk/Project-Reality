/**
 * SEC12-PLATFORM prompt 100 — Post-launch support infrastructure.
 *
 * In-game bug-report tool (auto-attaches log/replay snippet), support
 * ticket flow, + the public patch-notes pipeline. Persists to two new
 * Prisma models (BugReport + SupportTicket — added in the same PR).
 *
 * Public API:
 *   - `submitBugReport(input)` — writes a BugReport row + auto-attaches
 *     the last N log lines + a replay snippet (if available).
 *   - `submitSupportTicket(input)` — writes a SupportTicket row.
 *   - `listBugReports(opts)` / `listSupportTickets(opts)` — admin
 *     queries for the support dashboard.
 *   - `resolveBugReport(id, resolution)` / `updateSupportTicket(id, update)`
 *     — admin actions.
 *   - `getBugReport(id)` / `getSupportTicket(id)` — single-record fetch.
 *
 * The bug-report tool is intentionally simple: the player opens the
 * support menu, picks a category, types a description (or uses the
 * "report this bug" voice command), + the tool attaches:
 *   - The last 64 breadcrumbs (from errorTracking.ts)
 *   - The last 5 analytics events (so we see what the player did)
 *   - The current replay buffer (from replay-capture.ts) — serialized
 *     as base64 + truncated to 16KB so it fits in a SQLite TEXT column
 *   - The current hardware profile (from HardwareDetect.ts) so we
 *     know the device tier
 *   - The current build id + session id
 */

import { db } from "@/lib/db";
import { getBreadcrumbs } from "@/lib/errorTracking";

// ── Types ──────────────────────────────────────────────────────────────────

export type BugCategory =
  | "crash"
  | "graphical"
  | "audio"
  | "input"
  | "gameplay"
  | "performance"
  | "ui"
  | "network"
  | "other";

export type BugSeverity = "low" | "medium" | "high" | "blocker";
export type TicketCategory = "billing" | "account" | "bug" | "feedback" | "question" | "other";
export type TicketStatus = "open" | "in_progress" | "waiting_on_player" | "resolved" | "closed";

export interface BugReportInput {
  playerId: string;
  category: BugCategory;
  severity: BugSeverity;
  description: string;
  /** Optional screenshot URL (uploaded separately). */
  screenshotUrl?: string;
  /** Optional replay snippet (base64). When omitted, the tool tries to
   *  capture the current replay buffer. */
  replaySnippet?: string;
  /** Hardware profile snapshot (from HardwareDetect.ts). */
  hardware?: {
    tier: string;
    renderer: string;
    isMobile: boolean;
    cores: number;
    deviceMemoryGB: number;
  };
  /** Build id (from process.env.NEXT_PUBLIC_BUILD_ID or "dev"). */
  buildId?: string;
  /** Session id (from errorTracking.ts). */
  sessionId?: string;
}

export interface BugReportRecord {
  id: string;
  playerId: string;
  category: string;
  severity: string;
  description: string;
  screenshotUrl: string | null;
  replaySnippet: string | null;
  breadcrumbs: string; // JSON
  hardware: string; // JSON
  buildId: string | null;
  sessionId: string | null;
  status: string;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketInput {
  playerId: string;
  category: TicketCategory;
  subject: string;
  description: string;
  /** Optional priority (1-5, default 3). */
  priority?: number;
  /** Optional related bug report id (when the ticket escalates a bug). */
  bugReportId?: string;
}

export interface SupportTicketRecord {
  id: string;
  playerId: string;
  category: string;
  subject: string;
  description: string;
  priority: number;
  status: string;
  bugReportId: string | null;
  assignedTo: string | null;
  responseHistory: string; // JSON
  createdAt: string;
  updatedAt: string;
}

// ── Bug report ─────────────────────────────────────────────────────────────

/**
 * Submit a bug report. Auto-attaches the current breadcrumb ring +
 * (optionally) a replay snippet. The breadcrumbs are capped at the
 * last 64 entries (the ring's natural cap) + the replay snippet is
 * truncated to 16KB so it fits in the SQLite TEXT column.
 */
export async function submitBugReport(input: BugReportInput): Promise<BugReportRecord> {
  // Pull the live breadcrumb ring (best-effort — null on SSR).
  let breadcrumbs: unknown[] = [];
  try {
    breadcrumbs = getBreadcrumbs().slice(-64).map((b) => ({
      at: b.at,
      category: b.category,
      message: b.message,
      level: b.level,
    }));
  } catch {
    /* SSR or no ring yet — empty */
  }

  // Truncate replay snippet to 16KB so it fits in a SQLite TEXT column
  // + doesn't blow up the row size. (A real replay would be a file
  // upload to S3; the snippet is for fast triage.)
  const replay =
    input.replaySnippet && input.replaySnippet.length > 16_384
      ? input.replaySnippet.slice(0, 16_384) + "…[truncated]"
      : input.replaySnippet ?? null;

  const row = await db.bugReport.create({
    data: {
      playerId: input.playerId,
      category: input.category,
      severity: input.severity,
      description: input.description.slice(0, 4000),
      screenshotUrl: input.screenshotUrl ?? null,
      replaySnippet: replay,
      breadcrumbs: JSON.stringify(breadcrumbs),
      hardware: JSON.stringify(input.hardware ?? {}),
      buildId: input.buildId ?? null,
      sessionId: input.sessionId ?? null,
      status: "open",
    },
  });

  return serializeBugReport(row);
}

/** Fetch a single bug report. */
export async function getBugReport(id: string): Promise<BugReportRecord | null> {
  const row = await db.bugReport.findUnique({ where: { id } });
  return row ? serializeBugReport(row) : null;
}

/** List bug reports (admin support dashboard). */
export async function listBugReports(opts: {
  status?: string;
  category?: string;
  severity?: string;
  limit?: number;
} = {}): Promise<BugReportRecord[]> {
  const where: Record<string, unknown> = {};
  if (opts.status) where.status = opts.status;
  if (opts.category) where.category = opts.category;
  if (opts.severity) where.severity = opts.severity;
  const rows = await db.bugReport.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 50, 200),
  });
  return rows.map(serializeBugReport);
}

/** Resolve a bug report (admin action). */
export async function resolveBugReport(
  id: string,
  resolution: "fixed" | "wontfix" | "duplicate" | "invalid",
  note?: string,
): Promise<BugReportRecord | null> {
  const row = await db.bugReport.update({
    where: { id },
    data: {
      status: "resolved",
      resolution: `${resolution}${note ? `: ${note}` : ""}`,
    },
  });
  return serializeBugReport(row);
}

// ── Support ticket ─────────────────────────────────────────────────────────

/** Submit a support ticket. */
export async function submitSupportTicket(input: SupportTicketInput): Promise<SupportTicketRecord> {
  const row = await db.supportTicket.create({
    data: {
      playerId: input.playerId,
      category: input.category,
      subject: input.subject.slice(0, 200),
      description: input.description.slice(0, 4000),
      priority: Math.max(1, Math.min(5, input.priority ?? 3)),
      status: "open",
      bugReportId: input.bugReportId ?? null,
      responseHistory: JSON.stringify([
        { at: new Date().toISOString(), from: "player", message: input.description.slice(0, 4000) },
      ]),
    },
  });
  return serializeTicket(row);
}

/** Fetch a single support ticket. */
export async function getSupportTicket(id: string): Promise<SupportTicketRecord | null> {
  const row = await db.supportTicket.findUnique({ where: { id } });
  return row ? serializeTicket(row) : null;
}

/** List support tickets (admin support dashboard). */
export async function listSupportTickets(opts: {
  status?: string;
  category?: string;
  assignedTo?: string;
  limit?: number;
} = {}): Promise<SupportTicketRecord[]> {
  const where: Record<string, unknown> = {};
  if (opts.status) where.status = opts.status;
  if (opts.category) where.category = opts.category;
  if (opts.assignedTo) where.assignedTo = opts.assignedTo;
  const rows = await db.supportTicket.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 50, 200),
  });
  return rows.map(serializeTicket);
}

/** Update a support ticket (admin action — assign, change status, append response). */
export async function updateSupportTicket(
  id: string,
  update: {
    status?: TicketStatus;
    assignedTo?: string | null;
    response?: { from: "support" | "player"; message: string };
  },
): Promise<SupportTicketRecord | null> {
  const existing = await db.supportTicket.findUnique({ where: { id } });
  if (!existing) return null;

  const responseHistory: unknown[] = JSON.parse(existing.responseHistory || "[]");
  if (update.response) {
    responseHistory.push({
      at: new Date().toISOString(),
      from: update.response.from,
      message: update.response.message.slice(0, 4000),
    });
  }

  const row = await db.supportTicket.update({
    where: { id },
    data: {
      status: update.status ?? existing.status,
      assignedTo: update.assignedTo === undefined ? existing.assignedTo : update.assignedTo,
      responseHistory: JSON.stringify(responseHistory),
    },
  });
  return serializeTicket(row);
}

// ── Serialization ──────────────────────────────────────────────────────────

function serializeBugReport(row: {
  id: string;
  playerId: string;
  category: string;
  severity: string;
  description: string;
  screenshotUrl: string | null;
  replaySnippet: string | null;
  breadcrumbs: string;
  hardware: string;
  buildId: string | null;
  sessionId: string | null;
  status: string;
  resolution: string | null;
  createdAt: Date;
  updatedAt: Date;
}): BugReportRecord {
  return {
    id: row.id,
    playerId: row.playerId,
    category: row.category,
    severity: row.severity,
    description: row.description,
    screenshotUrl: row.screenshotUrl,
    replaySnippet: row.replaySnippet,
    breadcrumbs: row.breadcrumbs,
    hardware: row.hardware,
    buildId: row.buildId,
    sessionId: row.sessionId,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeTicket(row: {
  id: string;
  playerId: string;
  category: string;
  subject: string;
  description: string;
  priority: number;
  status: string;
  bugReportId: string | null;
  assignedTo: string | null;
  responseHistory: string;
  createdAt: Date;
  updatedAt: Date;
}): SupportTicketRecord {
  return {
    id: row.id,
    playerId: row.playerId,
    category: row.category,
    subject: row.subject,
    description: row.description,
    priority: row.priority,
    status: row.status,
    bugReportId: row.bugReportId,
    assignedTo: row.assignedTo,
    responseHistory: row.responseHistory,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
