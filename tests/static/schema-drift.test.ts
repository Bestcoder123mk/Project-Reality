import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Backlog §2 item 45 — Schema-drift test that fails if prisma/schema.prisma
 * changes without a matching migration (or, in this codebase which uses
 * `prisma db push` rather than migrations, without updating the committed
 * `prisma/schema.checksum` file).
 *
 * Workflow:
 *   1. Edit prisma/schema.prisma.
 *   2. Run `bun run db:push` to apply the change to the dev SQLite DB.
 *   3. Run `bun run test:schema-checksum -- --update` (or just `bun run
 *      scripts/update-schema-checksum.ts`) to regenerate the checksum file.
 *   4. Commit both schema.prisma + schema.checksum together.
 *
 * If a PR changes schema.prisma without updating schema.checksum, this test
 * fails with a clear message telling the developer what to do.
 */

const SCHEMA_PATH = path.resolve(process.cwd(), "prisma/schema.prisma");
const CHECKSUM_PATH = path.resolve(process.cwd(), "prisma/schema.checksum");

function sha256OfFile(p: string): string {
  const contents = readFileSync(p, "utf8");
  return createHash("sha256").update(contents).digest("hex");
}

describe("prisma schema drift (item 45)", () => {
  beforeAll(() => {
    // Sanity: schema.prisma must exist.
    if (!existsSync(SCHEMA_PATH)) {
      throw new Error(`schema.prisma not found at ${SCHEMA_PATH}`);
    }
  });

  it("a committed schema.checksum file exists", () => {
    if (!existsSync(CHECKSUM_PATH)) {
      throw new Error(
        `prisma/schema.checksum not found.\n` +
        `Run \`bun run scripts/update-schema-checksum.ts\` to generate it ` +
        `from the current prisma/schema.prisma, then commit both files together.`,
      );
    }
  });

  it("the committed checksum matches the current schema.prisma (no drift)", () => {
    if (!existsSync(CHECKSUM_PATH)) return; // surfaced by the previous test

    const actual = sha256OfFile(SCHEMA_PATH);
    const stored = readFileSync(CHECKSUM_PATH, "utf8").trim();

    if (actual !== stored) {
      throw new Error(
        `prisma/schema.prisma has changed but prisma/schema.checksum is stale.\n` +
        `  stored checksum:  ${stored}\n` +
        `  current checksum: ${actual}\n\n` +
        `To fix:\n` +
        `  1. Run \`bun run db:push\` to apply the schema change to the dev DB.\n` +
        `  2. Run \`bun run scripts/update-schema-checksum.ts\` to regenerate the checksum.\n` +
        `  3. Commit prisma/schema.prisma + prisma/schema.checksum together.\n\n` +
        `If you intended to ship without a migration,` +
        `this codebase uses \`prisma db push\` (not migrations) — see worklog Task 0.`,
      );
    }
  });

  it("schema.prisma is non-empty + has the expected generator + datasource blocks", () => {
    const contents = readFileSync(SCHEMA_PATH, "utf8");
    expect(contents.length).toBeGreaterThan(1000); // multi-model schema
    expect(contents).toMatch(/generator\s+client\s*{/);
    expect(contents).toMatch(/datasource\s+db\s*{/);
    expect(contents).toMatch(/provider\s*=\s*"sqlite"/);
    // The PLAYER_ID from seed.ts is a UUID, so the Player.id must be String.
    expect(contents).toMatch(/model\s+Player\s*{[\s\S]*?id\s+String/);
  });
});
