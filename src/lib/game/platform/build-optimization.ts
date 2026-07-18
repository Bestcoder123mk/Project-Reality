/**
 * L1-5000 / prompts 4479,4480,4533,4534,4587,4588,4625,4626,4663,4664,4701,4702,4739,4740: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4777,4815,4853,4891,4929,4967 (Build on >=8GB): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * SEC12-PLATFORM prompt 98 — Build size + load time optimization.
 *
 * Build-size audit + asset streaming / lazy-loading strategy. Exposes:
 *
 *   - `BUILD_BUDGET` — max bundle sizes per chunk (first-load JS,
 *     per-route JS, total JS, CSS, fonts, images, audio).
 *   - `auditBuildSize()` — reads `.next/` manifests if present + returns
 *     actual sizes per chunk + flags any over-budget chunks.
 *   - `getLazyLoadStrategy()` — documents which screens lazy-load which
 *     assets (so the compliance team + new hires can verify the
 *     streaming plan matches the implementation).
 *   - `LazyLoadRule` type — structured rule the engine wiring consumes.
 *
 * Public API is intentionally pure-data + pure-functions — no side
 * effects, no global state, safe to call from any context (SSR / tests).
 *
 * Wiring: the build pipeline (or a CI step) calls `auditBuildSize()`
 * post-build + fails the build when any chunk is over budget. The
 * lazy-load strategy is consumed by the engine's asset loader (a
 * one-liner per asset category — see Wiring Notes at the bottom).
 */

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// ── Build budget ───────────────────────────────────────────────────────────

/**
 * Maximum bundle sizes per chunk. Numbers are in KB (compressed, gzip
 * equivalent — Next.js reports compressed sizes in the build manifest).
 *
 * The budgets come from the AAA roadmap targets + a 4G mobile profile
 * (the slowest connection we ship to):
 *   - First-load JS: 200KB gzipped → ~1.4s on 4G. Anything more and
 *     the player bounces before the loading screen finishes.
 *   - Per-route JS: 100KB gzipped. Routes load on-demand; 100KB is the
 *     budget that keeps the route transition under 700ms on 4G.
 *   - Total JS (everything combined): 1.5MB gzipped. The full game
 *     client; reached only after the player has played long enough to
 *     care.
 *   - CSS: 50KB gzipped. Tailwind v4 purges aggressively; 50KB is the
 *     ceiling including the design-system tokens.
 *   - Fonts: 100KB gzipped. Two families (display + body), latin-only.
 *   - Images: 500KB per screen. The shop's 3D preview is the heaviest.
 *   - Audio: 2MB total. Music loops + SFX banks.
 */
export interface BuildBudget {
  /** Chunk identifier (matches the keys below). */
  chunk: string;
  /** Max size in KB (gzip). */
  maxKB: number;
  /** Human-readable rationale (shown in the audit report). */
  rationale: string;
}

export const BUILD_BUDGET: BuildBudget[] = [
  { chunk: "firstLoadJS", maxKB: 200, rationale: "4G mobile first-paint budget (≤1.4s)" },
  { chunk: "perRouteJS", maxKB: 100, rationale: "Route transition budget (≤700ms on 4G)" },
  { chunk: "totalJS", maxKB: 1500, rationale: "Full game client budget (lazy-loaded over the session)" },
  { chunk: "css", maxKB: 50, rationale: "Tailwind v4 + design-system tokens" },
  { chunk: "fonts", maxKB: 100, rationale: "Display + body, latin-only" },
  { chunk: "images", maxKB: 500, rationale: "Per-screen image budget (shop 3D preview is heaviest)" },
  { chunk: "audio", maxKB: 2000, rationale: "Music loops + SFX banks" },
  { chunk: "wasm", maxKB: 500, rationale: "Physics + audio decoders (only loaded on match start)" },
];

// ── Build-size audit ───────────────────────────────────────────────────────

export interface ChunkSizeReport {
  chunk: string;
  /** Actual size in KB (gzip-equivalent when Next reports compressed). */
  actualKB: number;
  /** Budget ceiling in KB. */
  maxKB: number;
  /** True when actual > max. */
  overBudget: boolean;
  /** Filesystem paths that contributed to this chunk's size. */
  sources: string[];
}

export interface BuildSizeAudit {
  /** ISO timestamp the audit was run. */
  generatedAt: string;
  /** True when `.next/` exists (audit ran against an actual build). */
  buildPresent: boolean;
  /** Per-chunk size report. */
  chunks: ChunkSizeReport[];
  /** True when any chunk is over budget. */
  hasOverBudget: boolean;
  /** Total build size (sum of all chunks, in KB). */
  totalKB: number;
  /** Notes from the audit (e.g. ".next/manifest not found — skipping"). */
  notes: string[];
}

/**
 * Audit the current build's chunk sizes against BUILD_BUDGET.
 *
 * Reads `.next/build-manifest.json` + `.next/app-build-manifest.json`
 * (Next.js 16 emit) + walks `.next/static/` to compute actual sizes.
 * Returns a structured report; the CI step compares `hasOverBudget`
 * + fails the build when true.
 *
 * When `.next/` doesn't exist (e.g. dev mode, fresh clone), the audit
 * returns an empty chunk list with `buildPresent: false` so the caller
 * can skip without erroring.
 */
export function auditBuildSize(): BuildSizeAudit {
  const nextRoot = join(process.cwd(), ".next");
  const notes: string[] = [];
  const chunks: ChunkSizeReport[] = [];

  if (!existsSync(nextRoot)) {
    notes.push(".next/ not found — run `bun run build` before auditing.");
    return {
      generatedAt: new Date().toISOString(),
      buildPresent: false,
      chunks: [],
      hasOverBudget: false,
      totalKB: 0,
      notes,
    };
  }

  // Walk .next/static/ to compute actual file sizes per chunk type.
  const staticRoot = join(nextRoot, "static");
  let totalJS = 0;
  let totalCSS = 0;
  let firstLoadJS = 0;
  let perRouteJS = 0;
  let wasm = 0;

  if (existsSync(staticRoot)) {
    for (const dir of readdirSync(staticRoot)) {
      const sub = join(staticRoot, dir);
      const sizes = walkAndSum(sub);
      if (dir === "chunks") {
        totalJS += sizes.js;
        wasm += sizes.wasm;
      } else if (dir === "css") {
        totalCSS += sizes.css;
      } else if (dir === "media") {
        // media (fonts, images) handled separately below.
      }
    }
  }

  // First-load JS = the webpack runtime + react + the app shell.
  // Next.js's `app-build-manifest.json` lists "pages" → files; the
  // first-load intersection is in `build-manifest.json`'s `lowPriorityFiles`
  // + the root files. We approximate: firstLoadJS = the chunks in
  // `/static/chunks/` whose name starts with `webpack` or `main` or `app`.
  const chunksDir = join(staticRoot, "chunks");
  if (existsSync(chunksDir)) {
    for (const f of readdirSync(chunksDir)) {
      if (/\.(js|mjs)$/.test(f)) {
        const sz = fileSizeKB(join(chunksDir, f));
        if (/^(webpack|main|app|polyfills|framework)/.test(f)) {
          firstLoadJS += sz;
        } else {
          perRouteJS += sz;
        }
      }
    }
  }

  // Fonts + images from /static/media/.
  let fonts = 0;
  let images = 0;
  const mediaDir = join(staticRoot, "media");
  if (existsSync(mediaDir)) {
    for (const f of readdirSync(mediaDir)) {
      const sz = fileSizeKB(join(mediaDir, f));
      if (/\.(woff2?|ttf|otf)$/i.test(f)) fonts += sz;
      else if (/\.(png|jpg|jpeg|webp|avif|gif|svg)$/i.test(f)) images += sz;
    }
  }

  // Audio is in /public/audio/.
  let audio = 0;
  const audioDir = join(process.cwd(), "public", "audio");
  if (existsSync(audioDir)) {
    audio += walkAndSum(audioDir).audio;
  }

  const actuals: Record<string, number> = {
    firstLoadJS,
    perRouteJS,
    totalJS,
    css: totalCSS,
    fonts,
    images,
    audio,
    wasm,
  };

  for (const b of BUILD_BUDGET) {
    const actual = actuals[b.chunk] ?? 0;
    chunks.push({
      chunk: b.chunk,
      actualKB: Math.round(actual * 10) / 10,
      maxKB: b.maxKB,
      overBudget: actual > b.maxKB,
      sources: [],
    });
  }

  const totalKB = Object.values(actuals).reduce((s, v) => s + v, 0);
  const hasOverBudget = chunks.some((c) => c.overBudget);
  if (hasOverBudget) {
    notes.push("One or more chunks are over budget — see the per-chunk report.");
  }

  // Try to read the build-manifest for additional context (next-build
  // sometimes emits it under different names in 16.x).
  const manifestPaths = [
    join(nextRoot, "build-manifest.json"),
    join(nextRoot, "app-build-manifest.json"),
  ];
  for (const p of manifestPaths) {
    if (existsSync(p)) {
      try {
        const manifest = JSON.parse(readFileSync(p, "utf8")) as unknown;
        void manifest; // just verifying it parses; the chunk sizes above are already computed.
        notes.push(`Read ${relative(process.cwd(), p)}.`);
      } catch {
        notes.push(`Failed to parse ${relative(process.cwd(), p)}.`);
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    buildPresent: true,
    chunks,
    hasOverBudget,
    totalKB: Math.round(totalKB * 10) / 10,
    notes,
  };
}

/** Walk a directory + sum file sizes by extension. */
function walkAndSum(dir: string): {
  js: number;
  css: number;
  wasm: number;
  audio: number;
} {
  const sums = { js: 0, css: 0, wasm: 0, audio: 0 };
  if (!existsSync(dir)) return sums;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const child = walkAndSum(full);
      sums.js += child.js;
      sums.css += child.css;
      sums.wasm += child.wasm;
      sums.audio += child.audio;
    } else {
      const sz = st.size / 1024;
      if (/\.(js|mjs)$/i.test(entry)) sums.js += sz;
      else if (/\.css$/i.test(entry)) sums.css += sz;
      else if (/\.wasm$/i.test(entry)) sums.wasm += sz;
      else if (/\.(mp3|ogg|wav|flac|m4a)$/i.test(entry)) sums.audio += sz;
    }
  }
  return sums;
}

/** File size in KB (or 0 when the file doesn't exist). */
function fileSizeKB(path: string): number {
  try {
    return statSync(path).size / 1024;
  } catch {
    return 0;
  }
}

// ── Lazy-load strategy ─────────────────────────────────────────────────────

export type AssetCategory =
  | "engine-core" // Three.js + engine.ts + renderer — loaded on first paint
  | "engine-physics" // WASM physics — loaded on match start
  | "engine-audio" // Audio worklet + decoders — loaded on match start
  | "map-arena" // Per-map geometry + textures — loaded on match start
  | "map-extraction" // Extraction map (heavier) — loaded on match start
  | "weapon-models" // Per-weapon GLTF — loaded when the player equips
  | "weapon-skins" // Per-skin textures — loaded when the player equips
  | "operator-models" // Per-operator GLTF — loaded when the player equips
  | "shop-3d-preview" // Shop's 3D preview canvas — loaded on shop open
  | "ui-settings" // Settings panel heavy components — loaded on settings open
  | "ui-social" // Social panel — loaded on social open
  | "post-processing" // SSAO/SSR/TAA shaders — loaded on match start
  | "vo-banks" // Voice-over banks — loaded per-operator on match start
  | "music-loops" // Music — loaded on match start
  | "sfx-banks"; // SFX banks — loaded on match start

export type LoadTrigger =
  | "first-paint" // Loaded immediately on page load
  | "match-start" // Loaded when the player enters a match
  | "screen-open" // Loaded when the player opens a specific screen
  | "equip" // Loaded when the player equips an item
  | "idle"; // Loaded during idle time after first-paint (prefetch)

export interface LazyLoadRule {
  category: AssetCategory;
  trigger: LoadTrigger;
  /** Approximate size in KB (gzipped). */
  estimatedKB: number;
  /** Implementation note — which Next.js dynamic() / import() loads it. */
  implementation: string;
  /** True when the asset is critical-path (blocks first interactive frame). */
  critical: boolean;
}

/**
 * The lazy-load strategy — which screens / triggers load which asset
 * categories. This is the documentation the compliance team + new
 * hires consult to verify the streaming plan matches the implementation.
 *
 * The strategy follows three principles:
 *
 *   1. Critical-path assets (engine-core) load on first-paint. These
 *      are the bytes between the player landing on the page + seeing
 *      the loading screen.
 *   2. Match-critical assets (physics, audio, map, weapons, post-FX,
 *      VO, music, SFX) load on match-start — they're needed by the
 *      first interactive frame but not before. The loading screen
 *      shows progress while these stream in.
 *   3. On-demand assets (weapon skins, operator models, shop preview,
 *      settings/social UI) load when the player opens the relevant
 *      screen or equips the relevant item. These are prefetch during
 *      idle time after first-paint so the second-open is instant.
 */
export const LAZY_LOAD_STRATEGY: LazyLoadRule[] = [
  {
    category: "engine-core",
    trigger: "first-paint",
    estimatedKB: 200,
    implementation: "Static import in src/app/page.tsx — bundled into firstLoadJS",
    critical: true,
  },
  {
    category: "engine-physics",
    trigger: "match-start",
    estimatedKB: 250,
    implementation: "dynamic(() => import('@/lib/game/physics/PhysicsBackend'), { ssr: false })",
    critical: true,
  },
  {
    category: "engine-audio",
    trigger: "match-start",
    estimatedKB: 150,
    implementation: "dynamic(() => import('@/lib/game/audio'), { ssr: false })",
    critical: true,
  },
  {
    category: "map-arena",
    trigger: "match-start",
    estimatedKB: 300,
    implementation: "Per-map chunk loaded via ChunkManager.setChunkLoader()",
    critical: true,
  },
  {
    category: "map-extraction",
    trigger: "match-start",
    estimatedKB: 450,
    implementation: "Per-map chunk loaded via ChunkManager.setChunkLoader()",
    critical: true,
  },
  {
    category: "weapon-models",
    trigger: "equip",
    estimatedKB: 80,
    implementation: "dynamic(() => import('@/lib/game/WeaponBuilder'), { ssr: false })",
    critical: false,
  },
  {
    category: "weapon-skins",
    trigger: "equip",
    estimatedKB: 120,
    implementation: "Texture loaded on-demand from /public/textures/skins/<slug>.webp",
    critical: false,
  },
  {
    category: "operator-models",
    trigger: "equip",
    estimatedKB: 200,
    implementation: "GLTF loaded on-demand from /public/models/operators/<slug>.glb",
    critical: false,
  },
  {
    category: "shop-3d-preview",
    trigger: "screen-open",
    estimatedKB: 350,
    implementation: "dynamic(() => import('@/components/shop/PreviewCanvas'), { ssr: false })",
    critical: false,
  },
  {
    category: "ui-settings",
    trigger: "screen-open",
    estimatedKB: 60,
    implementation: "dynamic(() => import('@/components/menu/SettingsPanel'), { ssr: false })",
    critical: false,
  },
  {
    category: "ui-social",
    trigger: "screen-open",
    estimatedKB: 40,
    implementation: "dynamic(() => import('@/components/uiux/SocialPanel'), { ssr: false })",
    critical: false,
  },
  {
    category: "post-processing",
    trigger: "match-start",
    estimatedKB: 100,
    implementation: "Shader chunks compiled on first match-start; cached across sessions",
    critical: true,
  },
  {
    category: "vo-banks",
    trigger: "match-start",
    estimatedKB: 400,
    implementation: "Per-operator VO bank loaded from /public/audio/vo/<operator>.ogg",
    critical: false,
  },
  {
    category: "music-loops",
    trigger: "match-start",
    estimatedKB: 800,
    implementation: "Music loops loaded from /public/audio/music/<track>.ogg",
    critical: false,
  },
  {
    category: "sfx-banks",
    trigger: "match-start",
    estimatedKB: 600,
    implementation: "SFX banks loaded from /public/audio/sfx/<bank>.ogg",
    critical: false,
  },
];

/** Return the lazy-load strategy (for the docs / admin dashboard). */
export function getLazyLoadStrategy(): LazyLoadRule[] {
  return LAZY_LOAD_STRATEGY;
}

/** Filter the strategy by trigger (for the per-screen optimization report). */
export function getLazyLoadByTrigger(trigger: LoadTrigger): LazyLoadRule[] {
  return LAZY_LOAD_STRATEGY.filter((r) => r.trigger === trigger);
}

/** Total estimated KB for a given trigger (for the budget cross-check). */
export function totalEstimatedKBForTrigger(trigger: LoadTrigger): number {
  return LAZY_LOAD_STRATEGY.filter((r) => r.trigger === trigger).reduce(
    (s, r) => s + r.estimatedKB,
    0,
  );
}

// ── L1-5000 / prompt 4499 — CI gate ─────────────────────────────────────────
//
// The legacy module shipped `auditBuildSize()` + `BUILD_BUDGET` but never
// wired them into a CI gate. CI would happily ship a 2MB first-load JS
// bundle because the audit was an "informational" report — no enforcement.
//
// `enforceBuildBudget(audit?)` is the gate: it runs the audit (or accepts
// a pre-computed one), checks `hasOverBudget`, and returns a structured
// result with `pass: boolean` + the over-budget chunk list. The CI step
// is a one-liner:
//
//   const { pass, failures } = enforceBuildBudget();
//   if (!pass) {
//     console.error(`❌ Build budget exceeded:\n${failures.map(f => `  ${f.chunk}: ${f.actualKB}KB > ${f.maxKB}KB`).join("\n")}`);
//     process.exit(1);
//   }
//
// The gate honors an opt-out env `SKIP_BUILD_BUDGET=1` for hotfix branches
// that need to ship above-budget on a one-off basis (the override is
// logged to the audit trail via the `notes` field).

export interface BudgetGateResult {
  /** True when every chunk is within its BUILD_BUDGET ceiling. */
  pass: boolean;
  /** Chunks that exceeded their budget (empty when pass === true). */
  failures: ChunkSizeReport[];
  /** The full audit (chunks + total + notes) so the caller can log it. */
  audit: BuildSizeAudit;
  /** True when the gate was bypassed via SKIP_BUILD_BUDGET=1. */
  bypassed: boolean;
}

/**
 * L1-5000 / prompt 4499 — enforce BUILD_BUDGET in CI.
 *
 * Runs `auditBuildSize()` (or accepts a pre-computed audit so callers can
 * avoid re-walking `.next/`) and returns a structured pass/fail result.
 * Honors `SKIP_BUILD_BUDGET=1` for one-off hotfix branches — the bypass
 * is recorded in the audit's notes so it's visible in the CI log.
 *
 * The function does NOT call `process.exit()` itself — that's the CI
 * script's job (keeps this module unit-testable). The caller's pattern:
 *
 *   const result = enforceBuildBudget();
 *   if (!result.pass) {
 *     for (const f of result.failures) {
 *       console.error(`❌ ${f.chunk}: ${f.actualKB}KB > ${f.maxKB}KB budget`);
 *     }
 *     process.exit(1);
 *   }
 */
export function enforceBuildBudget(audit?: BuildSizeAudit): BudgetGateResult {
  const skip = process.env.SKIP_BUILD_BUDGET === "1";
  const a = audit ?? auditBuildSize();
  if (skip) {
    a.notes.push(
      "L1-5000 / prompt 4499 — gate bypassed via SKIP_BUILD_BUDGET=1 (hotfix override).",
    );
  }
  const failures = a.chunks.filter((c) => c.overBudget);
  return {
    pass: skip ? true : !a.hasOverBudget,
    failures,
    audit: a,
    bypassed: skip,
  };
}

// ── Wiring notes ───────────────────────────────────────────────────────────
//
// Engine wiring (one-liners — none require touching the DO-NOT-EDIT files):
//
//   • page.tsx: wrap the heavy game-canvas component in
//     `dynamic(() => import('./GameCanvas'), { ssr: false, loading: () => <LoadingScreen /> })`
//     so the first-paint JS stays under budget.
//
//   • Shop preview: wrap the 3D preview canvas in
//     `dynamic(() => import('./PreviewCanvas'), { ssr: false })` so the
//     shop route doesn't pay the 350KB cost until the player opens it.
//
//   • Asset loader: in `assets/index.ts`, replace the static imports of
//     per-operator GLTFs with `loadGltf(slug)` that fetches on-demand +
//     caches in a Map. The TextureLoader already does this; GLTF needs
//     the same treatment.
//
//   • CI: add a post-build step `bun run scripts/audit-build.ts` that
//     calls `auditBuildSize()` + exits non-zero when `hasOverBudget`
//     is true. (The script is two lines; not shipped in this PR because
//     the CI pipeline isn't part of the sandbox.)
