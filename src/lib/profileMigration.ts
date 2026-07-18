import { db, PLAYER_ID } from "@/lib/api";

/**
 * Profile migration — prompt 8 of the AAA roadmap.
 *
 * The PlayerProfile gained fields additively across sessions (ownedWraps,
 * ownedCharms, schemaVersion, …). Before real players have profiles worth
 * protecting, every new schema change needs an actual migration story.
 *
 * Approach: a versioned migration runner. Each Player row carries a
 * `schemaVersion`. On load, the runner walks every migration whose version
 * is greater than the row's current version, applying it in order. Each
 * migration is a pure, idempotent function of the player row.
 *
 * Add a new migration by appending to MIGRATIONS with the next version
 * number. NEVER edit a shipped migration — write a new one instead.
 */

export interface MigrationContext {
  /** The player row (untyped — migrations may touch any column). */
  player: Record<string, unknown>;
}

export interface Migration {
  /** Monotonically increasing version this migration upgrades TO. */
  version: number;
  /** Human-readable description of what changed. */
  description: string;
  /** Apply the migration. Must be idempotent. */
  up: (ctx: MigrationContext) => Promise<void> | void;
}

/**
 * Migration registry. v1 is the baseline (no-op — every existing row is
 * already v1 after the schemaVersion column was added with default 1).
 *
 * Example of a real migration (uncomment when needed):
 *   {
 *     version: 2,
 *     description: "Grant the default knife melee to every existing player.",
 *     up: async ({ player }) => {
 *       await db.playerInventory.upsert({
 *         where: { ... },
 *         create: { playerId: String(player.id), weaponSlug: "knife" },
 *         update: {},
 *       });
 *     },
 *   },
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Baseline — schemaVersion column introduced. No data changes.",
    up: () => {
      /* no-op */
    },
  },
];

/** The highest migration version currently defined. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

/**
 * Run all pending migrations for the default player. Safe to call on every
 * profile load — migrations are idempotent and only run when the row's
 * schemaVersion is behind LATEST_SCHEMA_VERSION.
 *
 * Returns the list of migrations applied (empty when already current).
 */
export async function migratePlayerProfile(
  playerId: string = PLAYER_ID,
): Promise<Migration[]> {
  const player = await db.player.findUnique({ where: { id: playerId } });
  if (!player) return [];
  const current = player.schemaVersion ?? 0;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) return [];

  const ctx: MigrationContext = { player: player as unknown as Record<string, unknown> };
  for (const m of pending) {
    await m.up(ctx);
    await db.player.update({
      where: { id: playerId },
      data: { schemaVersion: m.version },
    });
  }
  return pending;
}
