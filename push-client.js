// Shared browser/PWA device lifecycle. Native WebViews require native push support.
const locks = new Map();
let nativePlugin;
let nativeHandles = [];
let lastRegistration = 0;
let currentRegistration;
window.addEventListener("online", () => {
  if (currentRegistration) { lastRegistration = 0; registerPush(currentRegistration.role, currentRegistration.api).catch(() => {}); }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentRegistration) registerPush(currentRegistration.role, currentRegistration.api).catch(() => {});
});

async function androidPlugin() {
  if (nativePlugin) return nativePlugin;
  const { registerPlugin } = await import("/vendor/capacitor-core.js");
  nativePlugin = registerPlugin("PushNotifications");
  return nativePlugin;
}

async function registerAndroid(role, api, requestPermission) {
  const config = await api(`/api/${role}/push/public-key`);
  if (!config.fcmConfigured) {
    if (requestPermission) throw new Error("Android push sunucu yapılandırması henüz tamamlanmadı.");
    return false;
  }
  const plugin = await androidPlugin();
  let permission = await plugin.checkPermissions();
  if (permission.receive !== "granted" && requestPermission) permission = await plugin.requestPermissions();
  if (permission.receive !== "granted") return false;
  await plugin.createChannel({ id: "restomap-operations", name: "RESTOMAP bildirimleri", importance: 4, vibration: true });
  await Promise.all(nativeHandles.map((handle) => handle.remove()));
  nativeHandles = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Cihaz bildirim kaydı zaman aşımına uğradı.")), 15000);
    (async () => {
      nativeHandles.push(await plugin.addListener("registration", async ({ value }) => {
        try {
          const previous = localStorage.getItem(`restomapPush:${role}`);
          await api(`/api/${role}/push/subscriptions`, { method: "POST", body: JSON.stringify({ subscription: { provider: "fcm", token: value }, platform: "android", deviceLabel: navigator.userAgent }) });
          if (previous && previous !== `fcm:${value}`) await api(`/api/${role}/push/subscriptions`, { method: "DELETE", body: JSON.stringify({ endpoint: previous }) });
          localStorage.setItem(`restomapPush:${role}`, `fcm:${value}`);
          window.DeliveraNativeApp?.setPushEnabled?.(true);
          clearTimeout(timer); resolve(true);
        } catch (error) { clearTimeout(timer); reject(error); }
      }));
      nativeHandles.push(await plugin.addListener("registrationError", () => { clearTimeout(timer); reject(new Error("Android bildirim kaydı başarısız. Firebase yapılandırmasını kontrol edin.")); }));
      nativeHandles.push(await plugin.addListener("pushNotificationActionPerformed", ({ notification }) => {
        const url = new URL(notification.data?.url || `/${role}.html`, location.origin);
        if (url.origin === location.origin && url.pathname === `/${role}.html`) location.assign(url.href);
      }));
      await plugin.register();
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });
}

export async function registerPush(role, api, requestPermission = false) {
  currentRegistration = { role, api };
  if (locks.has(role)) return locks.get(role);
  const android = window.Capacitor?.getPlatform?.() === "android";
  if (!android && (!navigator.serviceWorker || !("PushManager" in window) || !("Notification" in window))) return false;
  if (!requestPermission && Date.now() - lastRegistration < 60000) return true;
  const task = (async () => {
    if (android) return registerAndroid(role, api, requestPermission);
    let permission = Notification.permission;
    if (requestPermission && permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") return false;
    const registration = await navigator.serviceWorker.register("/courier-push-sw.js", { scope: "/" });
    const { publicKey } = await api(`/api/${role}/push/public-key`);
    const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - publicKey.length % 4) % 4));
    const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    let subscription = await registration.pushManager.getSubscription();
    const previousKey = subscription?.options?.applicationServerKey;
    if (subscription && previousKey && String(new Uint8Array(previousKey)) !== String(key)) {
      await api(`/api/${role}/push/subscriptions`, { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api(`/api/${role}/push/subscriptions`, { method: "POST", body: JSON.stringify({
      subscription: subscription.toJSON(),
      platform: window.matchMedia?.("(display-mode: standalone)").matches ? "pwa" : "web",
      deviceLabel: navigator.userAgent.slice(0, 120),
    }) });
    return true;
  })();
  locks.set(role, task);
  try { const result = await task; if (result) lastRegistration = Date.now(); return result; } finally { locks.delete(role); }
}

export async function removePush(role, api) {
  currentRegistration = null;
  lastRegistration = 0;
  if (window.Capacitor?.getPlatform?.() === "android") {
    window.DeliveraNativeApp?.setPushEnabled?.(false);
    const plugin = await androidPlugin();
    const endpoint = localStorage.getItem(`restomapPush:${role}`);
    try {
      if (endpoint) await api(`/api/${role}/push/subscriptions`, { method: "DELETE", body: JSON.stringify({ endpoint }) });
    } finally {
      await Promise.all(nativeHandles.map((handle) => handle.remove())); nativeHandles = [];
      await plugin.unregister();
      await plugin.removeAllDeliveredNotifications();
      localStorage.removeItem(`restomapPush:${role}`);
    }
    return;
  }
  if (!navigator.serviceWorker) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) return;
  // Unsubscribe at the provider even when the application server is offline.
  try {
    await api(`/api/${role}/push/subscriptions`, { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
  } finally {
    await subscription.unsubscribe();
    const notifications = await registration.getNotifications();
    notifications.forEach((notification) => notification.close());
  }
}

export function removePushWithToken(role, token) {
  return removePush(role, async (path, options) => {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Bildirim aboneliği silinemedi.");
  });
}
