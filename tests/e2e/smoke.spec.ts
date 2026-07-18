import { test, expect, type Page } from "@playwright/test";

/**
 * Backlog §2 item 32 — Playwright e2e smoke test.
 *
 * Loads `/`, waits for `<main>` to render, captures every console
 * message + page-error event for the duration of the load, and
 * asserts that no `console.error` or uncaught exception fired.
 *
 * This is the cheapest possible "did the page boot at all" check.
 * It would have caught:
 *   - the Sprite-raycast bug (console error on first frame)
 *   - any module-import failure (chunk 404 → console error)
 *   - any thrown exception in the top-level useEffect chains
 *     (initErrorTracking, initAnalytics, useProfile refresh)
 *
 * Env note: the dev server is managed externally (see playwright.config.ts
 * + worklog Task 0). If the server isn't running on BASE_URL, this test
 * will fail at `page.goto` with ECONNREFUSED — surfaced honestly in the
 * worklog. CI's `bun run test:e2e` step depends on the orchestrator
 * having booted the dev server first.
 *
 * The smoke test does NOT interact with the canvas — that's covered by
 * item 31 (deploy + fire weapon). This test only verifies "the page
 * loaded cleanly with no console errors".
 */

const CONSOLE_ERROR_PATTERNS_TO_IGNORE: RegExp[] = [
  // Browser extensions / devtools noise that isn't from our code.
  /Download the React DevTools/i,
  // Turbopack dev-only watch warnings about missing internal dirs
  // (these come from the dev server's file-watcher, not the page).
  /watch error/i,
];

function isRealConsoleError(text: string): boolean {
  return !CONSOLE_ERROR_PATTERNS_TO_IGNORE.some((re) => re.test(text));
}

test("smoke: / loads with <main> rendered + no console errors (item 32)", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (isRealConsoleError(text)) errors.push(text);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  // Wait for the <main> element to render. The phase router in page.tsx
  // always renders a <main> (even before any screen mounts) — so this
  // is the cheapest "React hydrated" signal.
  await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });

  // Give the page a moment for the post-hydration useEffect chains
  // (initErrorTracking, initAnalytics, useProfile refresh) to fire.
  // If any of them throws, the pageerror handler captures it.
  await page.waitForTimeout(2000);

  expect(errors, `console errors during smoke load:\n${errors.join("\n")}`).toEqual([]);
});

test("smoke: the document title is set (sanity check that layout.tsx loaded)", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/Project Reality/i);
});
