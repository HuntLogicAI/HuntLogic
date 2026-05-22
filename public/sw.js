// =============================================================================
// HuntLogic service worker — web push delivery
// =============================================================================
// Lifecycle:
//   - install: skipWaiting so updates propagate without a refresh.
//   - activate: claim all clients (no cache strategy; this SW is intentionally
//     cache-less to avoid the stale-bundle issues that prompted the previous
//     "nuke all caches" SW). On first activation we also clear any caches
//     left behind by older worker versions.
//   - push: render a notification from the JSON payload our server sends.
//   - notificationclick: focus an existing tab or open one to the deep link.
// =============================================================================

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "HuntLogic", body: event.data.text() };
  }

  const title = payload.title || "HuntLogic";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icon-192.png",
    badge: payload.badge || "/icon-192.png",
    tag: payload.tag,
    data: {
      url: payload.url || "/dashboard",
      ...(payload.data || {}),
    },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/dashboard";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // If a HuntLogic tab is already open, focus it and navigate.
      for (const client of clients) {
        if (client.url.includes(self.registration.scope) && "focus" in client) {
          client.focus();
          if ("navigate" in client) {
            return client.navigate(targetUrl);
          }
          return undefined;
        }
      }
      // Otherwise, open a new tab.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
