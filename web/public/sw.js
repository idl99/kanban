// ckanban service worker: makes the board installable, keeps the app shell (HTML, JS, CSS, icons) for a quick
// start, and shows "needs you" notifications sent by the daemon (src/server/push.ts). Never caches /api/ (board
// data, events, sockets): those always go to the daemon.
const CACHE = "ckanban-shell-v3";

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

// A "needs you" message from the daemon: {title, body, url, tag}. Always show one (iOS drops silent pushes).
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(self.registration.showNotification(data.title || "ckanban", {
    body: data.body || "A ticket needs you",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
  }));
});

// Tap: the ticket on this board's own address (the link may name another one, e.g. the Mac's localhost).
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  let hash = "";
  try {
    hash = new URL(e.notification.data && e.notification.data.url, location.origin).hash;
  } catch {}
  const target = `${location.origin}/${hash}`;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
    const open = list.find((c) => new URL(c.url).origin === location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: "open", hash });
      return;
    }
    await self.clients.openWindow(target);
  }));
});

// The browser renewed this device's push address: tell the daemon the new one.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const old = e.oldSubscription;
    const sub = e.newSubscription || (old && await self.registration.pushManager.subscribe(old.options));
    if (!sub) return;
    if (old) await fetch("/api/push/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: old.endpoint }) }).catch(() => {});
    await fetch("/api/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), label: "Browser" }),
    }).catch(() => {});
  })());
});
