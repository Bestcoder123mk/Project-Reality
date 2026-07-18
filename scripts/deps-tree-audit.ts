#!/usr/bin/env bun
/**
 * scripts/deps-tree-audit.ts — backlog §20 item 490.
 *
 * Runs `bun pm ls` (the dependency tree) and cross-references each
 * direct dependency against `src/` to find installed-but-never-
 * imported packages. Writes a markdown report to
 * docs/deps-tree-audit.md.
 *
 * This is the automated version of `docs/DEPS-CLEANUP.md`'s "process
 * for future dead-dep detection."
 *
 * Run: bun run scripts/deps-tree-audit.ts
 *
 * Output:
 *   docs/deps-tree-audit.md  — full report (used, unused, transitive)
 *   stdout                   — one-line summary
 *
 * What this catches that ts-prune doesn't:
 *   - Installed-but-never-imported packages (e.g. next-auth before
 *     Task 1 removed it).
 *   - Packages imported only by their type definitions.
 *
 * What this DOESN'T catch:
 *   - Packages imported by a dynamic `require()` (rare in this TS
 *     codebase).
 *   - Packages used implicitly by Next.js / Prisma config (e.g.
 *     `prisma` itself is "imported" only by `@/lib/db` but it's also
 *     the CLI runner for `db:push`).
 */
import { execSync } from "node:child_process";
import { readFile, writeFile, access, readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";

const ROOT = process.cwd();
const OUT_FILE = join(ROOT, "docs", "deps-tree-audit.md");
const SRC_DIR = join(ROOT, "src");

interface PkgShape {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackageJson(): Promise<PkgShape> {
  const txt = await readFile(join(ROOT, "package.json"), "utf-8");
  return JSON.parse(txt) as PkgShape;
}

/** Walk src/ and return a list of all .ts/.tsx file paths. */
async function listSourceFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && (extname(e.name) === ".ts" || extname(e.name) === ".tsx")) {
        out.push(full);
      }
    }
  }
  await walk(SRC_DIR);
  return out;
}

/** In-memory grep: count files that import `pkg` as a bare specifier. */
async function countImporters(pkg: string, files: string[]): Promise<string[]> {
  // Match: from "pkg"  |  from "pkg/..."  |  from 'pkg'  |  require("pkg")
  //   |   import("pkg")   |   import("pkg/...")
  // We use a regex that looks for the pkg name as a complete path
  // segment (preceded by `from "`, `from '`, `require("`, `require('`,
  // `import("`, `import('`, and followed by either a closing quote or
  // a `/`).
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:from\\s+['\"]${escaped}(?:['\"\\/])|require\\(['\"]${escaped}(?:['\"\\/])|import\\(['\"]${escaped}(?:['\"\\/]))`,
  );
  const hits: string[] = [];
  for (const f of files) {
    try {
      const src = await readFile(f, "utf-8");
      if (re.test(src)) hits.push(f);
    } catch {
      // Skip unreadable.
    }
  }
  return hits;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const pkg = await readPackageJson();
  const runtimeDeps = Object.keys(pkg.dependencies ?? {}).sort();
  const devDeps = Object.keys(pkg.devDependencies ?? {}).sort();

  console.log(`→ indexing ${runtimeDeps.length} runtime + ${devDeps.length} dev deps…`);
  console.log("→ scanning src/ for imports (in-memory)…");
  const files = await listSourceFiles();
  console.log(`→ ${files.length} source files to scan.`);

  const runtimeAudit: { name: string; version: string; importedIn: string[] }[] = [];
  for (const name of runtimeDeps) {
    const version = pkg.dependencies?.[name] ?? "?";
    const importedIn = await countImporters(name, files);
    runtimeAudit.push({ name, version, importedIn });
  }

  const devAudit: { name: string; version: string; importedIn: string[] }[] = [];
  for (const name of devDeps) {
    const version = pkg.devDependencies?.[name] ?? "?";
    const importedIn = await countImporters(name, files);
    devAudit.push({ name, version, importedIn });
  }

  // Get the full dependency tree (transitive). `bun pm ls` outputs
  // a tree; we just want a count + the top-level format.
  let treeRaw = "";
  try {
    treeRaw = execSync("bun pm ls 2>&1", {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    }).toString();
  } catch (err) {
    treeRaw = `(bun pm ls failed: ${(err as Error).message})`;
  }

  const runtimeUnused = runtimeAudit.filter((d) => d.importedIn.length === 0);
  const devUnused = devAudit.filter((d) => d.importedIn.length === 0);

  const lines: string[] = [];
  lines.push("# Dependency Tree Audit");
  lines.push("");
  lines.push("**Backlog §20 item 490.** Generated by `scripts/deps-tree-audit.ts`.");
  lines.push("");
  lines.push(`- **Project version:** ${pkg.version ?? "?"}`);
  lines.push(`- **Runtime deps in package.json:** ${runtimeDeps.length}`);
  lines.push(`- **Dev deps in package.json:** ${devDeps.length}`);
  lines.push(`- **Runtime deps with zero imports in src/:** ${runtimeUnused.length}`);
  lines.push(`- **Dev deps with zero imports in src/:** ${devUnused.length}`);
  lines.push("");
  lines.push("## How to use this report");
  lines.push("");
  lines.push("For each dep flagged as 'unused':");
  lines.push("");
  lines.push("1. **Verify.** `rg \"from '<pkg>'\" src/` — the script may miss");
  lines.push("   dynamic imports or `require()` calls.");
  lines.push("2. **Check for non-import usage.** The dep may be a CLI tool");
  lines.push("   (`prisma`, `vitest`, `eslint`), a type-only dep");
  lines.push("   (`@types/*`), or a config-only dep (`tailwindcss`).");
  lines.push("3. **If truly unused,** remove from `package.json` and re-run");
  lines.push("   `bun install`. Record in `docs/DEPS-CLEANUP.md`.");
  lines.push("4. **If used dynamically,** add a comment in `package.json`'s");
  lines.push("   dependencies section explaining why (rare).");
  lines.push("");
  lines.push("## Runtime dependencies");
  lines.push("");
  lines.push("| Package | Version | Imports in src/ | Status |");
  lines.push("|---|---|---:|---|");
  for (const d of runtimeAudit) {
    const status = d.importedIn.length === 0 ? "⚠️ unused" : "✅ used";
    lines.push(`| \`${d.name}\` | \`${d.version}\` | ${d.importedIn.length} | ${status} |`);
  }
  lines.push("");
  lines.push("## Dev dependencies");
  lines.push("");
  lines.push("| Package | Version | Imports in src/ | Status |");
  lines.push("|---|---|---:|---|");
  for (const d of devAudit) {
    // Many dev deps are CLI tools / type packages — not imported in src/.
    const isTypes = d.name.startsWith("@types/");
    const isCli = ["eslint", "eslint-config-next", "typescript", "vitest",
      "@vitest/coverage-v8", "@vitest/ui", "tailwindcss", "@tailwindcss/postcss",
      "tw-animate-css", "prisma", "husky", "ts-prune", "bun-types",
      "@playwright/test", "@axe-core/playwright", "fast-check"].includes(d.name);
    let status: string;
    if (d.importedIn.length > 0) status = "✅ used (imported)";
    else if (isTypes) status = "🔵 types-only";
    else if (isCli) status = "🔵 CLI / config";
    else status = "⚠️ unused";
    lines.push(`| \`${d.name}\` | \`${d.version}\` | ${d.importedIn.length} | ${status} |`);
  }
  lines.push("");
  lines.push("## Unused (action required)");
  lines.push("");

  if (runtimeUnused.length === 0 && devUnused.length === 0) {
    lines.push("_No unused deps detected (excluding types-only and CLI/config)._");
  } else {
    if (runtimeUnused.length > 0) {
      lines.push("### Runtime");
      lines.push("");
      for (const d of runtimeUnused) {
        lines.push(`- \`${d.name}\` @ \`${d.version}\` — 0 imports in src/`);
      }
      lines.push("");
    }
    const devActionable = devUnused.filter(
      (d) => !d.name.startsWith("@types/") &&
        !["eslint", "eslint-config-next", "typescript", "vitest",
          "@vitest/coverage-v8", "@vitest/ui", "tailwindcss",
          "@tailwindcss/postcss", "tw-animate-css", "prisma", "husky",
          "ts-prune", "bun-types", "@playwright/test",
          "@axe-core/playwright", "fast-check"].includes(d.name),
    );
    if (devActionable.length > 0) {
      lines.push("### Dev (excluding types-only + CLI/config)");
      lines.push("");
      for (const d of devActionable) {
        lines.push(`- \`${d.name}\` @ \`${d.version}\` — 0 imports in src/`);
      }
      lines.push("");
    }
  }

  lines.push("## Full dependency tree");
  lines.push("");
  lines.push("Output of `bun pm ls` (truncated to first 200 lines if long):");
  lines.push("");
  lines.push("```");
  const treeLines = treeRaw.split("\n").slice(0, 200);
  lines.push(...treeLines);
  if (treeRaw.split("\n").length > 200) {
    lines.push("... (truncated — run `bun pm ls` for the full tree)");
  }
  lines.push("```");
  lines.push("");
  lines.push("## References");
  lines.push("");
  lines.push("- `docs/DEPS-CLEANUP.md` — dead-dep removal record + pinning rationale.");
  lines.push("- `docs/MAINTENANCE-CADENCE.md` — when to act on this report.");
  lines.push("- `scripts/find-unused-exports.ts` — complementary tool that finds");
  lines.push("  unused *exports* (not unused *deps*).");

  await writeFile(OUT_FILE, lines.join("\n"));
  console.log(
    `✓ Wrote ${relative(ROOT, OUT_FILE)} — ${runtimeUnused.length} runtime unused, ${devUnused.length} dev unused.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
