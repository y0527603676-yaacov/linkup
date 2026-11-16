/* LINKUP service worker: shows push notifications only. No caching and no offline storage. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (_) { m = { title: "LINKUP", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(m.title || "LINKUP", {
    body: m.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: m.tag || undefined,
    renotify: !!m.tag,
    lang: "he",
    dir: "auto",
    data: { url: m.url || "/app/notifications" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/app/notifications", self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin && "focus" in c) { await c.navigate(url).catch(() => {}); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
