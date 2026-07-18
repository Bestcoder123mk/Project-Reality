// Project Reality service worker — Prompt I-979 + I-985 + I-986.
//
// Caches the app shell so the game boots offline after the first visit.
// On a new deploy, the SW fetches the new bundle in the background +
// signals the page via controllerchange (the OTA update flow).
//
// Strategy:
//   - App shell (HTML/JS/CSS) — stale-while-revalidate (instant load
//     from cache + background refresh).
//   - Static assets (logos, fonts) — cache-first (rarely change).
//   - API requests — network-first (always fresh; fall back to cache
//     when offline).
//   - Everything else — pass-through to the network.

const CACHE_VERSION = "pr-v1";
const APP_SHELL = ["/", "/manifest.json", "/logo.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Skip cross-origin (analytics, font CDNs) — they have their own CORS.
  if (url.origin !== self.location.origin) return;

  // API requests — network-first.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then((m) => m || new Response("offline", { status: 503 }))),
    );
    return;
  }

  // App shell + static assets — stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
