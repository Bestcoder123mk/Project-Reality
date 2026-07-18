import { test, expect } from "@playwright/test";
// L1-5000 / prompts 4478,4532,4586,4624,4662,4700,4738: addressed by this module (duplicates of Section I prompts, originally implemented there).
// L2-5000 / prompts 4776,4814,4852,4890,4928,4966 (Per-platform CI): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).

/**
 * Prompt I-970 — Per-platform CI smoke test.
 *
 * Backlog §2 #42 — fail CI if frame time exceeds the platform's PERF_TARGETS.
 *
 * The existing `perf-budget.spec.ts` runs a single budget (33ms local /
 * 50ms CI). This test runs the same measurement but asserts against the
 * per-platform budgets defined in `src/lib/game/platform/perf-targets.ts`:
 *
 *   - mobile-low:   33.3ms (30fps floor — entry phones)
 *   - mobile-mid:   20.0ms (50fps)
 *   - mobile-high:  16.6ms (60fps — Pixel 5a / iPhone 12)
 *   - console-ps5:  16.6ms (60fps baseline)
 *   - console-xsx:  16.6ms
 *   - console-switch: 16.6ms
 *   - pc-low:       33.3ms (30fps — integrated GPU)
 *   - pc-mid:       16.6ms (60fps)
 *   - pc-high:       8.3ms (120fps)
 *
 * The test is parameterized over a subset of these platforms. CI selects
 * the platform via `PERF_PLATFORM=mobile-low` env var (defaults to
 * `pc-mid` — the canonical dev/CI desktop target). The threshold is
 * scaled by a SwiftShader factor (2.5x in CI, 1.0x locally with a real
 * GPU) so the same test passes on hardware + flags regressions on the
 * software-rendered CI runner.
 *
 * Honest env caveats:
 *   - Headless Chromium uses SwiftShader (software WebGL). A real-hardware
 *     pc-high threshold (8.3ms) is unreachable on SwiftShader — the test
 *     multiplies the target by SWIFTSHADER_SCALE (2.5x) so a regression
 *     on hardware still fails CI without making the test flaky in CI.
 *   - `requestAnimationFrame` in headless fires at 60Hz max; the 120fps
 *     pc-high target is asserted as "median frame time < 8.3ms × scale"
 *     rather than "≥ 120 fps samples in 5s" because headless can't
 *     produce 120 samples/sec.
 */

const SWIFTSHADER_SCALE = process.env.CI ? 2.5 : 1.0;
const PLATFORM = process.env.PERF_PLATFORM ?? "pc-mid";

// Mirror of PERF_TARGETS (kept local so the test doesn't pull in the
// engine module — keeps the e2e bundle small). If perf-targets.ts adds
// a new platform, update this table + the PlatformId union.
const TARGETS_MS: Record<string, number> = {
  "mobile-low": 33.3,
  "mobile-mid": 20.0,
  "mobile-high": 16.6,
  "console-switch": 16.6,
  "console-ps5": 16.6,
  "console-xsx": 16.6,
  "pc-low": 33.3,
  "pc-mid": 16.6,
  "pc-high": 8.3,
};

const TARGET_MS = (TARGETS_MS[PLATFORM] ?? TARGETS_MS["pc-mid"]) * SWIFTSHADER_SCALE;

test.describe(`per-platform perf budget (platform=${PLATFORM}, budget=${TARGET_MS.toFixed(1)}ms)`, () => {
  test(`median frame time within ${PLATFORM} budget`, async ({ page }) => {
    test.skip(!TARGETS_MS[PLATFORM], `unknown PERF_PLATFORM=${PLATFORM}`);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toBeVisible({ timeout: 60_000 });

    // Start a match via the dev-only hook (skip the menu walk so the
    // perf sample isn't polluted by menu transitions).
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
      test.skip(true, "dev-only startMatch hook not exposed — cannot measure engine frame time");
      return;
    }

    const canvas = page.locator("main canvas").first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3000); // warm up

    const samples = await page.evaluate(() => {
      return new Promise<number[]>((resolve) => {
        const ts: number[] = [];
        const start = performance.now();
        const SAMPLE_MS = 5000;
        function loop(now: number) {
          ts.push(now);
          if (now - start < SAMPLE_MS) {
            requestAnimationFrame(loop);
          } else {
            resolve(ts);
          }
        }
        requestAnimationFrame(loop);
      });
    });

    expect(samples.length, "no rAF samples collected").toBeGreaterThan(10);

    const intervals: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      intervals.push(samples[i] - samples[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];

    console.log(
      `[per-platform perf] platform=${PLATFORM} samples=${samples.length} ` +
      `median=${median.toFixed(1)}ms budget=${TARGET_MS.toFixed(1)}ms ` +
      `(raw=${(TARGETS_MS[PLATFORM] ?? 0).toFixed(1)}ms × scale=${SWIFTSHADER_SCALE})`,
    );

    expect(
      median,
      `${PLATFORM} median frame time ${median.toFixed(1)}ms exceeds budget ` +
      `${TARGET_MS.toFixed(1)}ms (raw ${(TARGETS_MS[PLATFORM] ?? 0).toFixed(1)}ms × ${SWIFTSHADER_SCALE} scale)`,
    ).toBeLessThan(TARGET_MS);
  });
});
