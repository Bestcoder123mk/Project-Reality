/**
 * L1-5000 / prompts 4452,4510,4564,4602,4640,4678,4716: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4754,4792,4830,4868,4906,4944,4982 (OTA — versioned release notes are the user-facing side of over-the-air updates): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * SEC12-PLATFORM prompt 100 — Public patch-notes pipeline.
 *
 * Versioned list of patch notes the support team publishes after each
 * release. The notes are seeded with the current version's changes
 * (the SEC12-PLATFORM work itself) + the structure is in place for
 * future releases.
 *
 * Public API:
 *   - `getPatchNotes()` — returns the full versioned list (newest first).
 *   - `getLatestPatchNotes()` — returns just the latest version's notes.
 *   - `getPatchNotesForVersion(version)` — returns the notes for a
 *     specific version (or null when not found).
 *   - `PatchNote` / `PatchNoteVersion` types.
 *
 * The notes are stored as a static array (not in the DB) because:
 *   - They're immutable post-publish (a patch note is a historical record).
 *   - They ship with the build (so the player sees the notes for the
 *     version they're running, even offline).
 *   - The DB would only be needed if we wanted to publish notes without
 *     a code deploy — that's a live-ops feature we don't have yet.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type PatchNoteCategory =
  | "feature"
  | "improvement"
  | "balance"
  | "bugfix"
  | "security"
  | "compliance"
  | "known-issue"
  | "deprecation";

export interface PatchNote {
  category: PatchNoteCategory;
  title: string;
  description: string;
  /** Optional affected system (e.g. "combat", "shop", "matchmaking"). */
  area?: string;
}

export interface PatchNoteVersion {
  /** Semantic version string (e.g. "0.2.0"). */
  version: string;
  /** ISO release date. */
  releasedAt: string;
  /** Short headline for the version. */
  headline: string;
  /** Per-category notes. */
  notes: PatchNote[];
  /** Optional link to the full blog post / changelog. */
  blogUrl?: string;
}

// ── Seed data ──────────────────────────────────────────────────────────────

/**
 * The patch-notes database. Newest version first. Each new release
 * prepends a `PatchNoteVersion` here — the publish step is a code
 * deploy (the notes ship with the build).
 *
 * The current entry documents the SEC12-PLATFORM work (this PR).
 */
export const PATCH_NOTES: PatchNoteVersion[] = [
  {
    version: "0.2.0",
    releasedAt: "2025-01-15T00:00:00.000Z",
    headline: "Platform, performance & compliance pass",
    notes: [
      {
        category: "feature",
        title: "Per-platform performance targets",
        description:
          "Frame-time budgets are now per-platform (mobile 60fps, console 60/120fps, PC 144/240fps). The HUD overlay shows the active target + flags regressions.",
        area: "performance",
      },
      {
        category: "feature",
        title: "Platform integration abstraction",
        description:
          "Achievements, cloud save, and platform friends are now behind a PlatformAdapter interface. The web adapter ships today; Steam/console adapters are documented as drop-ins.",
        area: "platform",
      },
      {
        category: "security",
        title: "API security audit",
        description:
          "Every API route is now annotated with its validation + authorization status. The /api/admin/security-audit route returns the report.",
        area: "security",
      },
      {
        category: "compliance",
        title: "ESRB Teen / PEGI 16 rating audit",
        description:
          "Content factors (violence, gore, gambling, language) are audited against the rating targets. The audit fails if any factor pushes the rating above Teen/16.",
        area: "compliance",
      },
      {
        category: "compliance",
        title: "GDPR data export + right to erasure",
        description:
          "Players can download their full data export + request deletion. The deletion is hard for player-owned rows + anonymizes analytics events.",
        area: "compliance",
      },
      {
        category: "improvement",
        title: "Build size budget + lazy-load strategy",
        description:
          "Per-chunk build budget (200KB first-load JS, 1.5MB total). Lazy-load strategy documents which screens lazy-load which assets.",
        area: "performance",
      },
      {
        category: "feature",
        title: "Crash-free session metric",
        description:
          "Crash-free session rate is now a tracked metric (target 99.5%+). The /api/admin/crash-free route returns the rate + time-series trend.",
        area: "reliability",
      },
      {
        category: "feature",
        title: "In-game bug report + support tickets",
        description:
          "Players can submit bug reports (auto-attaches breadcrumbs + replay snippet) + support tickets from the support menu. Patch notes pipeline added.",
        area: "support",
      },
    ],
    blogUrl: "https://example.com/blog/project-reality-0-2-0",
  },
  {
    version: "0.1.0",
    releasedAt: "2024-12-01T00:00:00.000Z",
    headline: "Initial early-access launch",
    notes: [
      {
        category: "feature",
        title: "Initial game launch",
        description:
          "Project Reality launches in early access with 10 weapons, 4 maps, 6 operators, and a full battle pass season.",
      },
      {
        category: "known-issue",
        title: "Mobile performance on low-end devices",
        description:
          "Low-end mobile devices (under 4GB RAM) may experience frame drops in heavy scenes. Working on a 30fps cap option for the next patch.",
        area: "performance",
      },
    ],
  },
];

// ── Public API ─────────────────────────────────────────────────────────────

/** Get the full patch-notes list (newest first). */
export function getPatchNotes(): PatchNoteVersion[] {
  return [...PATCH_NOTES];
}

/** Get the latest version's patch notes (or null when empty). */
export function getLatestPatchNotes(): PatchNoteVersion | null {
  return PATCH_NOTES.length > 0 ? PATCH_NOTES[0] : null;
}

/** Get the patch notes for a specific version (or null when not found). */
export function getPatchNotesForVersion(version: string): PatchNoteVersion | null {
  return PATCH_NOTES.find((v) => v.version === version) ?? null;
}

/** Filter patch notes by category (e.g. show only security advisories). */
export function getPatchNotesByCategory(category: PatchNoteCategory): Array<{
  version: string;
  releasedAt: string;
  note: PatchNote;
}> {
  const out: Array<{ version: string; releasedAt: string; note: PatchNote }> = [];
  for (const v of PATCH_NOTES) {
    for (const note of v.notes) {
      if (note.category === category) {
        out.push({ version: v.version, releasedAt: v.releasedAt, note });
      }
    }
  }
  return out;
}
