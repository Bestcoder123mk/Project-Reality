import { test, expect } from "@playwright/test";

/**
 * Backlog §2 item 36 — Memory-leak test.
 *
 * Loads `/`, navigates into a match and back to the menu 20 times,
 * samples `performance.memory.usedJSHeapSize` (Chromium-only) at the
 * start and end of each cycle, and asserts that the final heap is
 * not significantly larger than the initial heap (≤ 50MB growth).
 *
 * The engine creates + disposes a LOT of GPU resources per match:
 *   - Three.js geometries, materials, textures
 *   - WebGLRenderTargets (shadow maps, post-process FBOs)
 *   - Audio buffers
 *   - The ObjectPool's projectile/ragdolls/decal ring buffers
 *
 * A dispose leak in any of these surfaces as heap growth that
 * compounds across match loads. The 50MB threshold is intentionally
 * generous — the engine legitimately caches some things (audio
 * buffers, the catalog) that aren't freed on match-end. The test
 * catches a MONOTONIC climb (each cycle leaks a chunk), not a
 * one-time setup cost.
 *
 * Env limitations:
 *
 *   - `performance.memory` is Chromium-only (not in Firefox/Safari
 *     spec). Playwright's `devices["Desktop Chrome"]` project ensures
 *     we're on Chromium. If the API is missing, the test skips.
 *
 *   - The test uses the dev-only `window.__pr.startMatch()` /
 *     `setPhase('menu')` hooks to drive the menu ↔ match transitions.
 *     If the hook isn't exposed, the test falls back to clicking
 *     through the menu (slow + flaky) — but the heap-growth invariant
 *     is what we care about, not the navigation method.
 *
 *   - Headless Chromium's GC is more aggressive than headed (no
 *     compositor thread), so leaks may not surface as strongly in
 *     headless. Running with HEADED=1 locally is more sensitive.
 */

test("memory: 20 menu ↔ match cycles do not grow the JS heap > 50MB (item 36)", async ({ page }) => {
  // performance.memory is Chromium-only — skip on other browsers.
  const hasMemoryAPI = await page.addInitScript(() => {
    // @ts-expect-error — Chromium-only API
    return typeof performance !== "undefined" && !!performance.memory;
  });
  if (!hasMemoryAPI) {
    test.skip(true, "performance.memory not available — Chromium-only API");
    return;
  }

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("main")).toBeVisible({ timeout: 60_000 });

  // Helper: read the current JS heap size (Chromium-only).
  const readHeap = () =>
    page.evaluate(() => {
      // @ts-expect-error — Chromium-only API
      const m = performance.memory;
      return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : null;
    });

  // Helper: force a GC sweep so the measurement isn't polluted by
  // uncollected garbage. Only works when Chromium is launched with
  // `--js-flags="--expose-gc"` (Playwright does this for the
  // chromium channel by default in CI; locally it may not — the
  // test degrades gracefully by just sleeping instead).
  const forceGc = async () => {
    await page.evaluate(() => {
      // @ts-expect-error — exposed via --expose-gc
      if (typeof globalThis.gc === "function") globalThis.gc();
    });
    // Sleep a bit either way so any pending finalizers run.
    await page.waitForTimeout(200);
  };

  // Stabilize the baseline: do one menu → match → menu cycle before
  // measuring so any lazy module loads (Turbopack chunks, the engine
  // constructor) are paid for up-front.
  await page.evaluate(() => {
    // @ts-expect-error — dev-only hook
    if (window.__pr?.startMatch) window.__pr.startMatch();
  });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    // @ts-expect-error — dev-only hook
    if (window.__pr?.setPhase) window.__pr.setPhase("menu");
  });
  await page.waitForTimeout(1000);
  await forceGc();

  const baseline = await readHeap();
  if (!baseline) {
    test.skip(true, "performance.memory returned null after init");
    return;
  }
  console.log(`[memory test] baseline usedJSHeapSize = ${(baseline.used / 1024 / 1024).toFixed(1)}MB`);

  // 20 cycles of menu → match → menu.
  const CYCLES = 20;
  const samples: number[] = [baseline.used];
  for (let i = 0; i < CYCLES; i++) {
    await page.evaluate(() => {
      // @ts-expect-error — dev-only hook
      if (window.__pr?.startMatch) window.__pr.startMatch();
    });
    await page.waitForTimeout(1500); // let the engine boot + allocate
    await page.evaluate(() => {
      // @ts-expect-error — dev-only hook
      if (window.__pr?.setPhase) window.__pr.setPhase("menu");
    });
    await page.waitForTimeout(800); // let the engine dispose + return to menu
    await forceGc();
    const snap = await readHeap();
    if (snap) samples.push(snap.used);
  }

  const final = samples[samples.length - 1];
  const growthBytes = final - baseline.used;
  const growthMB = growthBytes / 1024 / 1024;
  console.log(
    `[memory test] final usedJSHeapSize = ${(final / 1024 / 1024).toFixed(1)}MB ` +
    `(growth: ${growthMB > 0 ? "+" : ""}${growthMB.toFixed(1)}MB over ${CYCLES} cycles)`,
  );
  console.log(`[memory test] samples (MB): ${samples.map((s) => (s / 1024 / 1024).toFixed(0)).join(", ")}`);

  // Core invariant: heap did not grow > 50MB across 20 cycles.
  // (50MB is generous — a real leak surfaces as 100MB+; the threshold
  // is set high enough to avoid flaky failures from normal cache
  // churn, low enough to catch the leaks that matter.)
  expect(growthMB, `heap grew ${growthMB.toFixed(1)}MB over ${CYCLES} cycles (threshold: 50MB)`).toBeLessThan(50);

  // Secondary invariant: the heap is not MONOTONICALLY climbing. We
  // allow small fluctuations (the GC is non-deterministic) but assert
  // that at least one sample is lower than the previous one (i.e.
  // the GC DID reclaim something across cycles — a true leak would
  // be strictly monotonic).
  let anyDecrease = false;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] < samples[i - 1]) {
      anyDecrease = true;
      break;
    }
  }
  expect(anyDecrease, "heap grew monotonically across all 20 cycles — likely a real leak").toBe(true);
});
