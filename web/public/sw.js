// The Bay — service worker. Offline app-shell so the PWA opens instantly and
// survives flaky venue wifi. Network-first for navigations (always try fresh
// HTML), cache-first for hashed build assets, and never touch the API.
const CACHE = "thebay-v1";
const SHELL = "/app/";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Never cache API/auth — always live.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
  // Offline map packs are hundreds of megabytes and are fetched with Range. The
  // Cache API can neither store a 206 nor satisfy a Range from a cached body, so
  // touching /tiles/ here would break the vector map AND blow the quota. They are
  // installed deliberately into OPFS instead (web/src/offline/opfs.ts).
  if (url.pathname.startsWith("/tiles/")) return;
  // Only handle our own app scope.
  if (!url.pathname.startsWith("/app/")) return;
  // Byte-range requests can't be replayed from the Cache API — always pass through.
  if (e.request.headers.has("range")) return;

  // Navigations: network-first, fall back to the cached shell offline.
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match(SHELL)));
    return;
  }
  // Static assets: cache-first, then populate. This is what makes /app/map/…
  // (the SDF glyph PBFs and the sprite sheet) available offline for free — they
  // are served from our own origin precisely so they land inside this predicate.
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => hit),
    ),
  );
});

// Web push — show notifications the Worker sends (intros, check-ins, chat).
self.addEventListener("push", (e) => {
  let data = { title: "The Bay", body: "You have an update." };
  try { data = e.data.json(); } catch { /* keep default */ }
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: "/app/icon.svg", badge: "/app/icon.svg", data: data.url || "/app/" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data || "/app/"));
});
