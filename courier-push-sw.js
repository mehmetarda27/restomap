const COURIER_PAGE = "/courier.html";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json?.() || {};
  } catch {
    payload = { body: event.data?.text?.() || "Yeni paket atandi." };
  }

  const title = payload.title || "RESTOMAP - Yeni Paket";
  const options = {
    body: payload.body || "Yeni bir paketiniz var.",
    tag: payload.tag || "restomap-notification",
    data: {
      url: payload.url || COURIER_PAGE,
      packageId: payload.packageId || "",
    },
    requireInteraction: true,
    renotify: true,
    vibrate: [300, 100, 300, 100, 600],
  };

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const targetPath = new URL(options.data.url, self.location.origin).pathname;
    const visiblePanel = windows.some((client) => {
      if (client.visibilityState !== "visible") return false;
      const clientPath = new URL(client.url).pathname;
      if (targetPath.startsWith("/restaurant")) return clientPath.startsWith("/restaurant");
      if (targetPath.startsWith("/courier")) return clientPath.startsWith("/courier");
      return clientPath === targetPath;
    });

    // Foreground panels render SSE/in-app alerts themselves.
    if (visiblePanel) return;
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || COURIER_PAGE, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (new URL(targetUrl).origin !== self.location.origin) return;
    const existing = windows.find((client) => new URL(client.url).pathname === new URL(targetUrl).pathname);
    if (existing) {
      await existing.navigate(targetUrl);
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
