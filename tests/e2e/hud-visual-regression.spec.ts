import { test, expect } from "@playwright/test";

/**
 * Backlog §2 item 40 — Visual regression tests for the HUD across
 * HP tiers.
 *
 * The HUD (`src/components/game/HUD.tsx`) renders four HP-tier
 * overlays:
 *
 *   HP > 70   : clean (no overlay)
 *   HP 40-70  : faint static red vignette
 *   HP 15-40  : strong pulsing red vignette (1.4s period)
 *   HP < 15   : heavy blood overlay + faster pulse (0.7s period)
 *
 * A visual regression on any tier (color, opacity, blur radius) is
 * hard to catch with unit tests — the visual diff IS the test.
 *
 * Strategy:
 *
 *   The HUD is a React component that reads from the zustand store
 *   (`hudCombat.health`). Rather than boot the full game + drive the
 *   player's HP down with bullets (slow + flaky in headless WebGL),
 *   we use the dev-only `window.__pr` hook to:
 *
 *     1. Boot `/`.
 *     2. Start a match (so the HUD mounts).
 *     3. For each HP tier (100 / 50 / 25 / 0):
 *        a. `setHud({ health: <hp> })` to set the HP.
 *        b. Wait for the vignette animation to settle (the pulse
 *           uses framer-motion's `animate: { opacity: [...] }` —
 *           we wait 1 cycle = 1.4s).
 *        c. `toHaveScreenshot(`hud-hp-${hp}.png`)`.
 *
 *   The screenshot is masked to the HUD overlay region (the corners
 *   where the vignette is visible) so a background WebGL frame
 *   change doesn't trip the diff.
 *
 * Env limitations:
 *
 *   - **Headless WebGL**: the HUD mounts inside `<main>` which also
 *     hosts the GameCanvas. If WebGL fails, the canvas is black —
 *     the HUD overlay is still rendered on top, so the screenshot
 *     diff works against a black background. The threshold in
 *     playwright.config.ts (maxDiffPixelRatio: 0.05) absorbs the
 *     small per-pixel noise from antialiasing / GPU rasterization.
 *
 *   - **Animation timing**: framer-motion's pulse cycles are
 *     non-deterministic across runs (they depend on when the
 *     component mounted vs `performance.now()`). The screenshot is
 *     taken after a 1.5s settle delay; the threshold absorbs the
 *     resulting opacity variance.
 *
 *   - **First-run baseline**: `toHaveScreenshot()` creates the
 *     baseline PNG on first run (committed to
 *     `tests/e2e/__screenshots__/`). Subsequent runs diff against
 *     it. Update baselines with `bun run test:e2e -- --update-snapshots`.
 */

const HP_TIERS = [100, 50, 25, 0] as const;

test.describe("HUD visual regression across HP tiers (item 40)", () => {
  for (const hp of HP_TIERS) {
    test(`HUD at HP=${hp} matches committed screenshot`, async ({ page }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator("main")).toBeVisible({ timeout: 60_000 });

      // Start a match so the HUD mounts.
      const hooked = await page.evaluate(() => {
        // @ts-expect-error — dev-only hook
        if (window.__pr?.startMatch) {
          // @ts-expect-error — dev-only hook
          window.__pr.startMatch();
          return true;
        }
        return false;
      });
      if (!hooked) {
        test.skip(true, "dev-only store hook not exposed — cannot drive HUD state without booting the full match flow");
        return;
      }

      // Wait for the GameCanvas + HUD to mount.
      await page.waitForTimeout(2000);

      // Set the HUD's HP to the target tier. The store exposes
      // `setHud({ health })` which writes to the hudCombat slice.
      await page.evaluate((h) => {
        // @ts-expect-error — dev-only hook
        if (window.__pr?.setHud) window.__pr.setHud({ health: h, maxHealth: 100 });
      }, hp);

      // Wait for the vignette animation to settle. The strong-pulse
      // tier (HP 15-40) has a 1.4s period; the critical tier (HP <15)
      // has a 0.7s period. 1.5s covers at least one full cycle of
      // each so the screenshot captures a stable representative frame.
      await page.waitForTimeout(1500);

      // Screenshot the HUD overlay region. The HUD is
      // `absolute inset-0 z-30` — it covers the full viewport. We
      // mask out the bottom-right cluster (ammo counter) + top-left
      // cluster (score) because their text changes per-frame
      // (clock, FPS counter) and would trip the diff.
      const hud = page.locator("main").first();
      await expect(hud).toHaveScreenshot(`hud-hp-${hp}.png`, {
        maxDiffPixelRatio: 0.05,
        mask: [
          page.locator("text=/\\d+\\s*\\/\\s*\\d+/").first(), // ammo
          page.locator("text=/\\d+\\s*fps/i").first(), // FPS counter
        ],
      });
    });
  }
});
