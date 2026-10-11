// ckanban service worker: makes the board installable and keeps the app shell (HTML, JS, CSS, icons) for a quick
// start. Never caches /api/ (board data, events, sockets): those always go to the daemon.
const CACHE = "ckanban-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network first, so a rebuilt UI shows at once; the cached copy only covers a daemon that is briefly down.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(async (c) => {
          await c.put(e.request.mode === "navigate" ? "/" : e.request, copy);
          // Each UI build has new hashed asset names: keep only the newest entries.
          const keys = await c.keys();
          await Promise.all(keys.slice(0, Math.max(0, keys.length - 40)).map((k) => c.delete(k)));
        });
      }
      return res;
    }).catch(() => caches.match(e.request.mode === "navigate" ? "/" : e.request).then((hit) => hit ?? Response.error())),
  );
});
