#!/usr/bin/env bun
/**
 * scripts/ci-build-budget-gate.ts — L1-5000 / prompt 4499.
 *
 * CI gate that runs `auditBuildSize()` from
 * `src/lib/game/platform/build-optimization.ts` and exits non-zero when
 * any chunk is over its BUILD_BUDGET ceiling.
 *
 * Wire this as a post-build CI step (after `bun run build` succeeds):
 *
 *   - name: Build
 *     run: bun run build
 *   - name: Enforce build budget
 *     run: bun run scripts/ci-build-budget-gate.ts
 *
 * The gate honors `SKIP_BUILD_BUDGET=1` for hotfix branches that need
 * to ship above-budget on a one-off basis. The bypass is logged but
 * the script still exits 0 so the build can ship.
 *
 * Run locally: `bun run scripts/ci-build-budget-gate.ts` after a build.
 */
import { enforceBuildBudget } from "../src/lib/game/platform/build-optimization";

const result = enforceBuildBudget();

console.log("─".repeat(60));
console.log(`Build budget gate: ${result.pass ? "✅ PASS" : "❌ FAIL"}${result.bypassed ? " (bypassed via SKIP_BUILD_BUDGET=1)" : ""}`);
console.log(`Total build size: ${result.audit.totalKB.toFixed(1)} KB across ${result.audit.chunks.length} chunks`);
console.log("─".repeat(60));

for (const c of result.audit.chunks) {
  const status = c.overBudget ? "❌" : "✅";
  const pct = ((c.actualKB / c.maxKB) * 100).toFixed(0);
  console.log(`  ${status} ${c.chunk.padEnd(14)} ${String(c.actualKB).padStart(8)} KB / ${String(c.maxKB).padStart(8)} KB  (${pct}%)`);
}

if (!result.pass) {
  console.error("─".repeat(60));
  console.error(`❌ ${result.failures.length} chunk(s) over budget — build gate failed.`);
  for (const f of result.failures) {
    console.error(`   • ${f.chunk}: ${f.actualKB} KB > ${f.maxKB} KB budget`);
  }
  console.error("");
  console.error("To bypass on a hotfix branch: SKIP_BUILD_BUDGET=1 bun run scripts/ci-build-budget-gate.ts");
  process.exit(1);
}

if (result.audit.notes.length > 0) {
  console.log("");
  console.log("Notes:");
  for (const n of result.audit.notes) console.log(`  • ${n}`);
}
process.exit(0);
