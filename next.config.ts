import type { NextConfig } from "next";

/**
 * Phase 0: COOP/COEP/CORP headers for cross-origin isolation.
 *
 * Required for:
 *   - SharedArrayBuffer (JoltPhysics.js WASM threads — Pillar 3)
 *   - WebGPU compute shaders with shared memory (Pillar 1)
 *   - WebLLM in-browser inference (Pillar 2)
 *
 * Without these headers, SharedArrayBuffer is undefined and WASM threads
 * fail to initialize. The headers must be set on the top-level document
 * AND on all cross-origin subresources (via CORP).
 */
const crossOriginHeaders = [
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin",
  },
  {
    key: "Cross-Origin-Embedder-Policy",
    value: "require-corp",
  },
  {
    key: "Cross-Origin-Resource-Policy",
    value: "same-site",
  },
  // Allow WASM SIMD + threads (needed for JoltPhysics.js, WebLLM).
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), bluetooth=(self), serial=(self), xr-spatial-tracking=(self)",
  },
];

/**
 * Task-1 (SEC) item 14 — Content-Security-Policy header.
 *
 * DEV vs PROD: Next.js dev mode (Turbopack/webpack HMR + React Refresh)
 * REQUIRES inline scripts to hydrate. A strict CSP without 'unsafe-inline'
 * blocks them, white-screening the app in dev. So:
 *   - DEV: no CSP (let Next.js do its thing)
 *   - PROD: strict CSP (Next.js production build nonces inline scripts)
 *
 * Restricts the origins the browser will load resources from so a
 * successful XSS injection can't exfiltrate data to an attacker-
 * controlled domain. Allowlist:
 *
 *   - default-src 'self' — base allowlist for everything not otherwise
 *     specified. Same-origin only.
 *   - script-src 'self' 'wasm-unsafe-eval' — Three.js + WASM modules
 *     require `wasm-unsafe-eval`. No `unsafe-inline` — Next.js injects
 *     scripts with nonces by default in production.
 *   - style-src 'self' 'unsafe-inline' — Next.js injects styles inline.
 *   - img-src 'self' data: blob: — Three.js procedural textures.
 *   - connect-src 'self' — same-origin API + telemetry only.
 *   - font-src 'self' data: — Next.js fonts.
 *   - media-src 'self' blob: — audio decoded via MediaSource.
 *   - worker-src 'self' blob: — Three.js workers + WASM threads.
 *   - frame-ancestors 'none' — block iframe embedding (clickjacking).
 *   - form-action 'self' — block cross-origin form submits.
 *   - base-uri 'self' — block `<base>` tag injection.
 *   - object-src 'none' — no Flash/Java/PDF plugins.
 */
const cspHeader = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

/**
 * Task-1 (SEC) item 14, 20 — security headers applied to every route.
 *
 * CSP + X-Robots-Tag is split: `noindex` is applied to /api/admin/*
 * specifically (item 20), the rest apply globally.
 *
 * NOTE: CSP is PROD-only. Dev mode needs inline scripts for HMR.
 */
const isDev = process.env.NODE_ENV === "development";

const globalSecurityHeaders = [
  // Cross-origin isolation headers (COOP/COEP/CORP) — PROD only.
  // In dev mode, these break the preview-panel iframe embedding + HMR.
  ...(isDev ? [] : crossOriginHeaders),
  // CSP only in production — dev mode (HMR/React Refresh) needs inline scripts.
  ...(isDev ? [] : [{ key: "Content-Security-Policy", value: cspHeader }]),
  // HSTS — force HTTPS for 1 year (ignored on localhost / HTTP).
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // MIME sniffing defense.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Clickjacking defense — PROD uses CSP frame-ancestors 'none'.
  // DEV: omit X-Frame-Options so the preview-panel iframe can embed the page.
  ...(isDev ? [] : [{ key: "X-Frame-Options", value: "DENY" }]),
  // Referrer-Policy — only send origin to cross-origin targets.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Permissions-Policy (already set in crossOriginHeaders, but kept for clarity).
];

/** Admin-only headers — `/api/admin/*` is never indexed by crawlers. */
const adminHeaders = [
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Prevent the file watcher from watching dev.log and other non-source files
  // that change frequently — each change triggers a recompile which spikes
  // memory and can OOM-kill the server on low-RAM sandboxes. Next.js 16's
  // watchOptions type only exposes pollIntervalMs.
  watchOptions: {
    pollIntervalMs: 1000,
  },
  async headers() {
    return [
      {
        source: "/((?!api/admin).*)",
        headers: globalSecurityHeaders,
      },
      {
        // Admin routes get the global headers PLUS X-Robots-Tag: noindex.
        // The negative-lookahead above excludes /api/admin/* from the
        // global rule; this rule applies the same global headers + the
        // noindex header to /api/admin/*.
        source: "/api/admin/:path*",
        headers: [...globalSecurityHeaders, ...adminHeaders],
      },
    ];
  },
  // Phase 0: WebGPU + WASM experiments.
  experimental: {
    // Enable if Next.js adds WebGPU-specific config in future.
  },
};

export default nextConfig;
