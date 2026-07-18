import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * Backlog §2 item 46 — Smoke test that boots the production build.
 *
 * All other e2e tests run against the dev server (`next dev`).
 * This test boots the PRODUCTION build (`next build` + `next start`
 * — or the standalone server if `output: "standalone"` is set in
 * next.config.ts) and asserts:
 *
 *   1. The build completes successfully.
 *   2. The standalone server starts + listens on a port.
 *   3. `GET /` returns 200 + the expected title.
 *   4. `GET /api/catalog` returns 200 + the catalog arrays (so the
 *      server-side Prisma + seed both work in the production runtime).
 *
 * Why this matters:
 *
 *   Dev-mode bugs (hot-reload artifacts, dev-only `console.log`
 *   paths, missing production env vars) often don't surface until
 *   `next build`. A production smoke test catches:
 *     - Build-time TypeScript errors that `tsc --noEmit` missed.
 *     - Server-only code that got bundled into the client.
 *     - Missing `process.env.X` references that crash on boot.
 *     - Prisma client version mismatches that work in dev but fail
 *       in the standalone server.
 *
 * Implementation:
 *
 *   - Spawns `bun run build` as a child process.
 *   - Waits for the build to complete (timeout: 5 minutes — the
 *     87k LOC codebase compiles slowly under Turbopack).
 *   - Spawns `bun run start` (or `bun .next/standalone/server.js`)
 *     as a child process listening on a random port.
 *   - Polls `http://localhost:${port}/` until it returns 200.
 *   - Runs the smoke assertions.
 *   - Tears down the server (kills the child process).
 *
 * Env limitations:
 *
 *   - **Build memory**: the 87k LOC codebase can OOM under the
 *     default 4GB cgroup during `next build`. The build script
 *     passes `NODE_OPTIONS=--max-old-space-size=3072` (matching
 *     the dev script). If the build still OOMs in CI, mark this
 *     test as `test.skip` with a clear reason + run it on a beefier
 *     machine.
 *
 *   - **Build time**: the first build can take 5+ minutes. The test
 *     timeout is set to 600s (10 minutes) to absorb that.
 *
 *   - **Cleanup**: if the test fails midway, the spawned `next start`
 *     process is killed in the `finally` block. If the test
 *     process itself is killed (SIGKILL from CI), the child process
 *     may leak — the orchestrator's cleanup step should `pkill -f
 *     "next start"` between runs.
 */

const BUILD_TIMEOUT_MS = 600_000; // 10 minutes
const START_TIMEOUT_MS = 120_000; // 2 minutes for the server to boot

test.describe("production build smoke (item 46)", () => {
  // This test is gated on `PLAYWRIGHT_RUN_PROD_SMOKE=1` because it
  // builds the entire app (5+ min) — too slow for the default e2e
  // suite. CI runs it as a separate job.
  test.skip(!process.env.PLAYWRIGHT_RUN_PROD_SMOKE, "production smoke is opt-in (PLAYWRIGHT_RUN_PROD_SMOKE=1) — it runs `bun run build` which takes 5+ minutes");

  test("bun run build succeeds + bun run start serves /", async () => {
    // 1. Run `bun run build`.
    const buildResult = await runCommand("bun", ["run", "build"], BUILD_TIMEOUT_MS);
    expect(buildResult.exitCode, `build failed:\nstdout: ${buildResult.stdout}\nstderr: ${buildResult.stderr}`).toBe(0);

    // 2. Spawn `bun run start` (or the standalone server).
    //    The package.json `start` script runs the standalone server.
    //    We pass a custom PORT so we don't conflict with the dev server.
    const port = 4321 + Math.floor(Math.random() * 1000);
    const startProc = spawn("bun", ["run", "start"], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    startProc.stdout?.on("data", (d) => (stdout += d.toString()));
    startProc.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      // 3. Wait for the server to start listening. Poll the port.
      const startedAt = Date.now();
      let ready = false;
      while (Date.now() - startedAt < START_TIMEOUT_MS) {
        try {
          const res = await fetch(`http://localhost:${port}/`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // server not ready yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(ready, `server did not become ready within ${START_TIMEOUT_MS / 1000}s\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(true);

      // 4. Smoke assertions against the running production server.
      const homeRes = await fetch(`http://localhost:${port}/`);
      expect(homeRes.status).toBe(200);
      const homeHtml = await homeRes.text();
      expect(homeHtml).toMatch(/<title>[^<]*Project Reality/i);

      const catalogRes = await fetch(`http://localhost:${port}/api/catalog`);
      expect(catalogRes.status).toBe(200);
      const catalogJson = await catalogRes.json();
      expect(Array.isArray(catalogJson.weapons)).toBe(true);
      expect(catalogJson.weapons.length).toBeGreaterThan(0);
    } finally {
      // 5. Tear down the server.
      startProc.kill("SIGTERM");
      // Give it a moment to clean up, then SIGKILL if still alive.
      await new Promise((r) => setTimeout(r, 1000));
      if (!startProc.killed) startProc.kill("SIGKILL");
    }
  });
});

/** Run a command + return its stdout/stderr/exitCode. Rejects on timeout. */
function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
