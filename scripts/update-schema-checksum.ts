#!/usr/bin/env bun
/**
 * Regenerate prisma/schema.checksum from the current prisma/schema.prisma.
 *
 * Run after every intentional schema change:
 *   bun run scripts/update-schema-checksum.ts
 *
 * The checksum is read by tests/static/schema-drift.test.ts (item 45).
 * Commit both prisma/schema.prisma and prisma/schema.checksum together.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCHEMA_PATH = path.resolve(process.cwd(), "prisma/schema.prisma");
const CHECKSUM_PATH = path.resolve(process.cwd(), "prisma/schema.checksum");

const contents = readFileSync(SCHEMA_PATH, "utf8");
const hash = createHash("sha256").update(contents).digest("hex");
writeFileSync(CHECKSUM_PATH, hash + "\n", "utf8");
console.log(`[update-schema-checksum] wrote ${CHECKSUM_PATH}`);
console.log(`  sha256: ${hash}`);
