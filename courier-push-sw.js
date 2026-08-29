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
    tag: payload.tag || "delivera-new-package",
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
    const isRestaurantNotification = targetPath.startsWith("/restaurant");
    const visiblePanel = windows.some((client) => {
      if (client.visibilityState !== "visible") return false;
      const clientPath = new URL(client.url).pathname;
      if (targetPath.startsWith("/restaurant")) return clientPath.startsWith("/restaurant");
      if (targetPath.startsWith("/courier")) return clientPath.startsWith("/courier");
      return clientPath === targetPath;
    });

    // Kurye paneli açıkken ekran içi kabul penceresi yeterlidir. Restoran
    // bildirimi ise siparişin kaçmaması için panel açık olsa da mutlaka görünür.
    if (visiblePanel && !isRestaurantNotification) return;
    const notificationOptions = visiblePanel && isRestaurantNotification
      ? { ...options, silent: true }
      : options;
    await self.registration.showNotification(title, notificationOptions);
    if (isRestaurantNotification && payload.packageId) {
      await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
      await self.registration.showNotification(title, {
        ...notificationOptions,
        body: `Hatırlatma: ${options.body}`,
      });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || COURIER_PAGE, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).pathname === COURIER_PAGE);
    if (existing) {
      await existing.navigate(targetUrl);
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
