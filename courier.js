const STORAGE_TOKEN_KEY = "kuryeTakipCourierToken";
const STORAGE_REFRESH_TOKEN_KEY = "kuryeTakipCourierRefreshToken";
const LOCATION_PUSH_MS = 10_000;
const WORKSPACE_POLL_MS = 12_000;

const courierState = {
  token: window.__deliveraInitialCourierAuth?.token || "",
  refreshToken: window.__deliveraInitialCourierAuth?.refreshToken || "",
  data: null,
  watchId: null,
  lastCoords: null,
  lastLocationPushAt: 0,
  locationPushPromise: null,
  heartbeatId: null,
  workspacePollId: null,
  historyRange: "7d",
  historyVisibleCount: 50,
  packageLimit: 100,
  packageCursor: "0",
  lastPackageSnapshot: new Map(),
  packageActionDrafts: new Map(),
  liveStream: null,
  lastWorkspaceLoadAt: 0,
  workspaceLoadPromise: null,
  queuedWorkspaceLoad: null,
  connectionBusy: false,
  focusPackage: null,
  activeProfileSection: "",
  offerPackageId: "",
  offerBusy: false,
  routeDistanceCache: new Map(),
  packageGeocodePromises: new Map(),
};

const COURIER_FAILURE_REASON_OPTIONS = [
  { value: "musteri_yok", label: "Musteri yok" },
  { value: "adres_bulunamadi", label: "Adres bulunamadi" },
  { value: "restoran_hazir_degil", label: "Restoran hazir degil" },
  { value: "teknik_sorun", label: "Teknik sorun" },
  { value: "ters_yon", label: "Ters yon" },
  { value: "diger", label: "Diger" },
];
const COURIER_CLOSED_STATUSES = ["delivered", "failed", "cancelled"];

const COURIER_PACKAGE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"></line><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`;
const COURIER_MOTO_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 16A3 3 0 1 0 5 22A3 3 0 1 0 5 16Z"></path><path d="M19 16A3 3 0 1 0 19 22A3 3 0 1 0 19 16Z"></path><path d="M5 19H19"></path><path d="M8 15L10 9H15L17 15"></path><path d="M14 9L13 5H17"></path></svg>`;
const COURIER_PIN_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
const COURIER_PERSON_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

function escapeCourierHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function presentCourierText(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text || text === "null" || text === "undefined") {
    return fallback;
  }
  return text;
}

function presentCourierAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "Tutar yok";
  }
  return formatCurrency(amount);
}

function presentCourierPayment(pkg) {
  const methodCode = String(pkg?.paymentMethodCode || "").toLowerCase();
  const paymentStatus = String(pkg?.paymentStatus || "").toLowerCase();
  if (paymentStatus === "payment_issue") return "Alınamadı";
  if (methodCode === "cash_on_delivery") {
    return paymentStatus === "cash_collected" ? "Nakit Alındı" : "Nakit";
  }
  if (methodCode === "card_on_delivery") {
    return paymentStatus === "credit_card_collected" ? "Kartla Alındı" : "Kart";
  }
  if (methodCode === "restaurant_collected" || paymentStatus === "restaurant_collected") return "Restoran Aldı";
  if (methodCode === "paid_online" || paymentStatus === "paid_online") return "Online Ödendi";
  if (methodCode === "collected" || paymentStatus === "collected") return "Ödendi";

  const method = presentCourierText(pkg?.paymentMethod, "");
  const status = presentCourierText(paymentStatusLabel(pkg?.paymentStatus), "");
  if (!method && !status) {
    return "Odeme bilgisi yok";
  }
  if (method && status) {
    return `${method} - ${status}`;
  }
  return method || status;
}

function courierPaymentAction(pkg) {
  const rawMethod = String(pkg?.paymentMethod || "").toLowerCase();
  let methodCode = String(pkg?.paymentMethodCode || "").toLowerCase();
  if (!methodCode && (rawMethod.includes("cash") || rawMethod.includes("nakit"))) {
    methodCode = "cash_on_delivery";
  } else if (!methodCode && (rawMethod.includes("card") || rawMethod.includes("kart") || rawMethod.includes("kredi") || rawMethod.includes("debit") || rawMethod.includes("pos"))) {
    methodCode = "card_on_delivery";
  }
  const selectableMethods = ["cash_on_delivery", "card_on_delivery", "restaurant_collected"];
  return {
    methodCode,
    requiresSelection: selectableMethods.includes(methodCode),
    label: presentCourierPayment(pkg),
  };
}

function courierFailureReasonLabel(reason) {
  return COURIER_FAILURE_REASON_OPTIONS.find((item) => item.value === reason)?.label || reason || "Sorun yok";
}

function isActiveCourierPackage(pkg) {
  return pkg && !COURIER_CLOSED_STATUSES.includes(pkg.status);
}

function historyDateForPackage(pkg) {
  return new Date(pkg.updatedAt || pkg.deliveredAt || pkg.failedAt || pkg.createdAt);
}

function packageMatchesHistoryRange(pkg, range) {
  const targetDate = historyDateForPackage(pkg);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const sevenDayStart = new Date(todayStart);
  sevenDayStart.setDate(sevenDayStart.getDate() - 6);
  const thirtyDayStart = new Date(todayStart);
  thirtyDayStart.setDate(thirtyDayStart.getDate() - 29);

  if (range === "today") {
    return targetDate >= todayStart;
  }
  if (range === "yesterday") {
    return targetDate >= yesterdayStart && targetDate < todayStart;
  }
  if (range === "30d") {
    return targetDate >= thirtyDayStart;
  }
  if (range === "all") {
    return true;
  }

  return targetDate >= sevenDayStart;
}

const courierRefs = {
  summary: document.getElementById("courierSummary"),
  loginPanel: document.getElementById("loginPanel"),
  workspacePanel: document.getElementById("workspacePanel"),
  loginForm: document.getElementById("loginForm"),
  logoutButton: document.getElementById("logoutButton"),
  connectionSwitch: document.getElementById("courierConnectionSwitch"),
  connectionLabel: document.getElementById("courierConnectionLabel"),
  locationStatus: document.getElementById("locationStatus"),
  name: document.getElementById("courierName"),
  focusCard: document.querySelector(".courier-focus-card"),
  focusLabel: document.querySelector(".courier-focus-card .eyebrow"),
  focusTitle: document.getElementById("courierFocusTitle"),
  focusText: document.getElementById("courierFocusText"),
  offerOverlay: document.getElementById("courierOfferOverlay"),
  offerTitle: document.getElementById("courierOfferTitle"),
  offerSubtitle: document.getElementById("courierOfferSubtitle"),
  offerCode: document.getElementById("courierOfferCode"),
  offerDetails: document.getElementById("courierOfferDetails"),
  offerError: document.getElementById("courierOfferError"),
  offerAccept: document.getElementById("courierOfferAccept"),
  offerReject: document.getElementById("courierOfferReject"),
  missionMeta: document.getElementById("courierMissionMeta"),
  destinationMap: document.getElementById("courierDestinationMap"),
  destinationPreview: document.getElementById("courierDestinationPreview"),
  mapTitle: document.getElementById("courierMapTitle"),
  mapAddress: document.getElementById("courierMapAddress"),
  mapButton: document.getElementById("courierMapButton"),
  stats: document.getElementById("courierStats"),
  dayMetrics: document.getElementById("courierDayMetrics"),
  dayCloseNote: document.getElementById("courierDayCloseNote"),
  earningsMetrics: document.getElementById("courierEarningsMetrics"),
  shiftMetrics: document.getElementById("courierShiftMetrics"),
  liveBadge: document.getElementById("courierLiveBadge"),
  dayCloseButton: document.getElementById("courierDayCloseButton"),
  notificationCenter: document.getElementById("courierNotificationCenter"),
  enablePushButton: document.getElementById("courierEnablePushButton"),
  announcementList: document.getElementById("courierAnnouncementList"),
  packages: document.getElementById("courierPackages"),
  history: document.getElementById("courierHistory"),
  historyMeta: document.getElementById("courierHistoryMeta"),
  historyMore: document.getElementById("courierHistoryMore"),
  historyFilters: document.getElementById("courierHistoryFilters"),
  template: document.getElementById("courierPackageTemplate"),
  profileSettingsButton: document.getElementById("profileSettingsButton"),
  profileModal: document.getElementById("courierProfileModal"),
  profileForm: document.getElementById("courierProfileForm"),
};

function readStoredCourierAuth() {
  try {
    if (!courierState.token) {
      courierState.token = localStorage.getItem(STORAGE_TOKEN_KEY) || "";
    }
    if (!courierState.refreshToken) {
      courierState.refreshToken = localStorage.getItem(STORAGE_REFRESH_TOKEN_KEY) || "";
    }
  } catch {
    if (!courierState.token) courierState.token = "";
    if (!courierState.refreshToken) courierState.refreshToken = "";
  }
}

function writeStoredCourierAuth() {
  try {
    if (courierState.token) {
      localStorage.setItem(STORAGE_TOKEN_KEY, courierState.token);
    } else {
      localStorage.removeItem(STORAGE_TOKEN_KEY);
    }
    if (courierState.refreshToken) {
      localStorage.setItem(STORAGE_REFRESH_TOKEN_KEY, courierState.refreshToken);
    } else {
      localStorage.removeItem(STORAGE_REFRESH_TOKEN_KEY);
    }
  } catch {
    // In-memory session still works if storage is unavailable.
  }
}

function clearStoredCourierAuth() {
  try {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    localStorage.removeItem(STORAGE_REFRESH_TOKEN_KEY);
  } catch {}
}

function persistCourierAuth(auth) {
  courierState.token = auth.token;
  courierState.refreshToken = auth.refreshToken;
  writeStoredCourierAuth();
}

function clearCourierAuth() {
  courierState.token = "";
  courierState.refreshToken = "";
  clearStoredCourierAuth();
  courierState.data = null;
  courierState.lastCoords = null;
  courierState.lastPackageSnapshot = new Map();
  courierState.packageActionDrafts = new Map();
  courierState.liveStream?.close?.();
  courierState.liveStream = null;
}

async function refreshCourierAccess() {
  if (!courierState.refreshToken) {
    throw new Error("Kurye refresh token bulunamadi.");
  }

  try {
    const auth = await api("/api/courier/refresh", {
      method: "POST",
      body: JSON.stringify({
        refreshToken: courierState.refreshToken,
      }),
    });
    persistCourierAuth(auth);
    return auth;
  } catch (err) {
    if (err.status === 401) {
      clearCourierAuth();
      window.location.reload();
    }
    throw err;
  }
}

function setLoggedIn(isLoggedIn) {
  document.body.classList.toggle("app-unauthenticated", !isLoggedIn);
  courierRefs.loginPanel.classList.toggle("hidden", isLoggedIn);
}

function setLocationStatus(message) {
  if (courierRefs.locationStatus) courierRefs.locationStatus.textContent = message;
}

function setShiftGreetingStatus(available = courierState.data?.courier?.available) {
  setLocationStatus(available ? "Hayırlı günler" : "Hayırlı akşamlar");
}

function hasMapTarget(latitudeValue, longitudeValue, addressValue) {
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return true;
  }
  return Boolean(String(addressValue || "").trim());
}

function buildOrderMapUrl(order, target = "customer") {
  const coordinates = orderTargetCoordinates(order, target);
  const address = String(
    target === "restaurant"
      ? (order?.restaurantAddress || order?.restaurantName || order?.zone || "")
      : (order?.customerAddress || order?.deliveryAddress || order?.address || "")
  ).trim();

  if (coordinates) {
    const courierLatitude = Number(courierState.data?.courier?.latitude);
    const courierLongitude = Number(courierState.data?.courier?.longitude);
    const origin = Number.isFinite(courierLatitude) && Number.isFinite(courierLongitude)
      ? `&origin=${courierLatitude},${courierLongitude}`
      : "";
    return `https://www.google.com/maps/dir/?api=1${origin}&destination=${coordinates.latitude},${coordinates.longitude}&travelmode=driving`;
  }

  if (!address) {
    return "";
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function mapTargetQuery(order, target = "customer") {
  const coordinates = orderTargetCoordinates(order, target);
  const address = String(
    target === "restaurant"
      ? (order?.restaurantAddress || order?.restaurantName || order?.zone || "")
      : (order?.customerAddress || order?.deliveryAddress || order?.address || "")
  ).trim();

  if (coordinates) {
    return `${coordinates.latitude},${coordinates.longitude}`;
  }
  return address;
}

function buildGoogleMapsEmbedUrl(order, target = "customer") {
  const apiKey = courierState.data?.mapsConfig?.googleMapsEmbedApiKey || "";
  const query = mapTargetQuery(order, target);
  if (!query) {
    return "";
  }
  if (apiKey) {
    return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}`;
  }
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
}

function orderTargetCoordinates(order, target = "customer") {
  const latitudeValue = target === "restaurant" ? (order?.restaurantLat ?? order?.latitude) : (order?.customerLat ?? order?.customerLatitude);
  const longitudeValue = target === "restaurant" ? (order?.restaurantLng ?? order?.longitude) : (order?.customerLng ?? order?.customerLongitude);
  if (latitudeValue === null || latitudeValue === undefined || latitudeValue === "" || longitudeValue === null || longitudeValue === undefined || longitudeValue === "") return null;
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
}

function distanceBetweenCoordinates(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const values = [fromLatitude, fromLongitude, toLatitude, toLongitude].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [fromLat, fromLng, toLat, toLng] = values;
  const radians = (value) => value * Math.PI / 180;
  const deltaLat = radians(toLat - fromLat);
  const deltaLng = radians(toLng - fromLng);
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatLiveDistance(pkg) {
  const destination = orderTargetCoordinates(pkg, "customer");
  const courier = courierState.data?.courier;
  if (!destination || !courier) return "Mesafe için müşteri koordinatı bekleniyor";
  const distance = distanceBetweenCoordinates(courier.latitude, courier.longitude, destination.latitude, destination.longitude);
  if (!Number.isFinite(distance)) return "Canlı GPS bekleniyor";
  return distance < 1 ? `Yaklaşık ${Math.round(distance * 1000)} m` : `Yaklaşık ${distance.toFixed(2)} km`;
}

function routeDistanceKey(pkg) {
  const destination = orderTargetCoordinates(pkg, "customer");
  const courier = courierState.data?.courier;
  const courierLatitude = Number(courier?.latitude);
  const courierLongitude = Number(courier?.longitude);
  if (!destination || !Number.isFinite(courierLatitude) || !Number.isFinite(courierLongitude)) return null;
  return {
    key: `${courierLatitude.toFixed(4)},${courierLongitude.toFixed(4)}>${destination.latitude.toFixed(5)},${destination.longitude.toFixed(5)}`,
    courierLatitude,
    courierLongitude,
    destination,
  };
}

async function updateRoadDistance(target, pkg) {
  const route = routeDistanceKey(pkg);
  if (!route || !target?.isConnected) return;
  const cached = courierState.routeDistanceCache.get(route.key);
  if (Number.isFinite(cached)) {
    target.textContent = `${cached < 1 ? `${Math.round(cached * 1000)} m` : `${cached.toFixed(2)} km`} yol mesafesi · Dokun, rotayı aç`;
    return;
  }
  try {
    const coordinates = `${route.courierLongitude},${route.courierLatitude};${route.destination.longitude},${route.destination.latitude}`;
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=false&alternatives=false&steps=false`);
    if (!response.ok) return;
    const payload = await response.json();
    const kilometers = Number(payload?.routes?.[0]?.distance) / 1000;
    if (!Number.isFinite(kilometers) || !target.isConnected) return;
    courierState.routeDistanceCache.set(route.key, kilometers);
    target.textContent = `${kilometers < 1 ? `${Math.round(kilometers * 1000)} m` : `${kilometers.toFixed(2)} km`} yol mesafesi · Dokun, rotayı aç`;
  } catch (_error) {
    // Anlık rota servisi erişilemezse kuş uçuşu yaklaşımı ekranda kalır.
  }
}

function buildOpenStreetMapEmbedUrl(pkg) {
  const destination = orderTargetCoordinates(pkg, "customer");
  if (!destination) return "";
  const latitudeSpan = 0.008;
  const longitudeSpan = 0.012;
  const bbox = [
    destination.longitude - longitudeSpan,
    destination.latitude - latitudeSpan,
    destination.longitude + longitudeSpan,
    destination.latitude + latitudeSpan,
  ].join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${destination.latitude}%2C${destination.longitude}`;
}

function openOrderMap(order, target = "customer") {
  const url = buildOrderMapUrl(order, target);
  if (!url) {
    showToast("Adres bulunamadi.", "error");
    return;
  }
  window.open(url, "_blank");
}

function renderMapUnavailable(target, pkg, message = "Rota ön izlemesi için müşteri koordinatı gerekli", options = {}) {
  if (options.hideWhenUnavailable) {
    target.classList.add("hidden");
    target.innerHTML = "";
    return;
  }
  target.classList.remove("has-embed");
  target.classList.remove("map-fallback");
  target.classList.add("map-unavailable");
  target.innerHTML = `
    <div class="courier-map-unavailable-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"></path><circle cx="12" cy="10" r="2.5"></circle><path d="m17.5 4.5-11 11"></path></svg>
    </div>
    <div class="courier-map-unavailable-copy">
      <strong>Konum verisi eksik</strong>
      <span>${escapeCourierHtml(message)}</span>
    </div>
  `;
}

async function resolvePackageAddressCoordinates(pkg, target, options = {}) {
  if (!pkg?.id || orderTargetCoordinates(pkg, "customer")) return;
  let pending = courierState.packageGeocodePromises.get(pkg.id);
  if (!pending) {
    pending = api(`/api/courier/packages/${encodeURIComponent(pkg.id)}/geocode`, {
      method: "POST",
      headers: { Authorization: `Bearer ${courierState.token}` },
      retryWithRefresh: refreshCourierAccess,
    }).finally(() => courierState.packageGeocodePromises.delete(pkg.id));
    courierState.packageGeocodePromises.set(pkg.id, pending);
  }

  try {
    const coordinates = await pending;
    pkg.customerLat = coordinates.latitude;
    pkg.customerLng = coordinates.longitude;
    if (target?.isConnected) renderPackageMapPreview(target, pkg, options);
  } catch (error) {
    if (target?.isConnected && !target.classList.contains("has-embed")) {
      renderMapUnavailable(target, pkg, error?.message || "Adres haritada bulunamadı", options);
    }
  }
}

function renderPackageMapPreview(target, pkg, options = {}) {
  if (!target) {
    return;
  }
  const mapUrl = buildOrderMapUrl(pkg, "customer");
  if (!mapUrl) {
    target.classList.remove("hidden");
    renderMapUnavailable(target, pkg, undefined, options);
    return;
  }

  const embedUrl = buildGoogleMapsEmbedUrl(pkg, "customer") || buildOpenStreetMapEmbedUrl(pkg);
  if (!embedUrl) {
    target.classList.remove("hidden");
    target.setAttribute("role", "link");
    target.setAttribute("tabindex", "0");
    target.title = "Google Maps'te ac";
    target.onclick = () => openOrderMap(pkg, "customer");
    target.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openOrderMap(pkg, "customer");
      }
    };
    renderMapUnavailable(target, pkg, "Adres koordinata çevriliyor, harita hazırlanıyor...", options);
    resolvePackageAddressCoordinates(pkg, target, options);
    return;
  }

  target.classList.remove("hidden");
  target.setAttribute("role", "link");
  target.setAttribute("tabindex", "0");
  target.title = "Google Maps'te ac";
  target.onclick = () => openOrderMap(pkg, "customer");
  target.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openOrderMap(pkg, "customer");
    }
  };

  target.classList.add("has-embed");
  target.classList.remove("map-fallback", "map-unavailable");
  target.innerHTML = `
    <iframe title="Gercek Google Maps teslimat on izlemesi" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${escapeCourierHtml(embedUrl)}"></iframe>
    <div class="courier-map-glass">
      <strong>Canlı konum ön izlemesi</strong>
      <span class="courier-live-distance">${escapeCourierHtml(formatLiveDistance(pkg))} · Dokun, rotayı aç</span>
    </div>
  `;
  if (!orderTargetCoordinates(pkg, "customer")) {
    resolvePackageAddressCoordinates(pkg, target, options);
  }
  updateRoadDistance(target.querySelector(".courier-live-distance"), pkg);
  const iframe = target.querySelector("iframe");
  iframe?.addEventListener("error", () => {
    renderMapUnavailable(target, pkg, "Harita servisine şu anda ulaşılamıyor", options);
  }, { once: true });
}

window.openCourierPackageDetailsById = function(packageId) {
  const pkg = courierState.data?.packages?.find(p => p.id === packageId) ||
              courierState.data?.historyPackages?.find(p => p.id === packageId);
  if (pkg) {
    window.openCourierPackageDetails(pkg);
  }
}

window.openCourierPackageDetails = function(pkg) {
  if (typeof window.showPackageDetailsModal === "function") {
    window.showPackageDetailsModal(pkg);
    return;
  }
  showToast("Siparis detaylari su anda acilamiyor.", "error");
};

function stopLocationWatch() {
  if (courierState.watchId !== null) {
    navigator.geolocation.clearWatch(courierState.watchId);
    courierState.watchId = null;
  }

  if (courierState.heartbeatId !== null) {
    window.clearInterval(courierState.heartbeatId);
    courierState.heartbeatId = null;
  }
}

function stopWorkspacePolling() {
  if (courierState.workspacePollId !== null) {
    window.clearInterval(courierState.workspacePollId);
    courierState.workspacePollId = null;
  }
}

function startWorkspacePolling() {
  if (courierState.workspacePollId !== null || !courierState.token) {
    return;
  }

  courierState.workspacePollId = window.setInterval(() => {
    loadCourierWorkspace({ silent: true });
  }, WORKSPACE_POLL_MS);
}

function startCourierLiveStream() {
  if (courierState.liveStream || !courierState.token) {
    return;
  }

  courierState.liveStream = connectLiveStream("/api/courier/stream", courierState.token, {
    onMessage(event) {
      const toastableTypes = new Set([
        "package-created",
        "package-assigned",
        "assignment-waiting",
        "package-status",
        "package-reassign",
        "package-override",
        "package-unassign",
        "integration-order",
        "platform-order",
        "courier-day-close",
        "courier-availability",
        "shift-plan-offer",
        "shift-plan-accepted",
      ]);
      if (event?.message && toastableTypes.has(event.type)) {
        showToast(event.message, notificationTone(event.type));
        if (event.type === "package-assigned") {
          playSignal("assignment-long");
        } else if (event.type === "shift-plan-offer") {
          playSignal("assignment-long");
        } else if (event.type === "assignment-waiting") {
          playSignal("critical");
        } else if (event.type === "package-status") {
          playSignal("ready");
        }
      }
      if (event?.type !== "courier-location") {
        loadCourierWorkspace({ silent: true, force: true });
      }
    },
    onError() {
      if (courierRefs.liveBadge) {
        courierRefs.liveBadge.textContent = "Canli akis tekrar baglaniyor";
      }
      courierState.liveStream?.close?.();
      courierState.liveStream = null;
      window.setTimeout(() => startCourierLiveStream(), 2000);
    },
  });
}

function requestNotificationPermission() {
  if (typeof Notification === "undefined") {
    return Promise.resolve("unsupported");
  }

  if (Notification.permission === "default") {
    try {
      return Promise.resolve(Notification.requestPermission()).catch(() => "default");
    } catch {
      return Promise.resolve("default");
    }
  }
  return Promise.resolve(Notification.permission);
}

function pushApplicationServerKey(base64Value) {
  const padding = "=".repeat((4 - (base64Value.length % 4)) % 4);
  const base64 = (base64Value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function updateCourierPushButton(enabled = false) {
  if (!courierRefs.enablePushButton) return;
  const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  courierRefs.enablePushButton.classList.toggle("hidden", enabled);
  courierRefs.enablePushButton.disabled = permission === "unsupported";
  courierRefs.enablePushButton.textContent = permission === "denied" ? "Bildirim Engelli" : "Bildirimleri Ac";
}

async function initializeCourierPush(options = {}) {
  if (!courierState.token || !("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
    updateCourierPushButton(false);
    return false;
  }

  let permission = Notification.permission;
  if (options.requestPermission && permission === "default") {
    permission = await requestNotificationPermission();
  }
  if (permission !== "granted") {
    updateCourierPushButton(false);
    if (options.requestPermission && permission === "denied") {
      showToast("Chrome bildirim izni engelli. Site ayarlarindan Bildirimler iznini ac.", "warning");
    }
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.register("/courier-push-sw.js", { scope: "/" });
    const keyResponse = await api("/api/courier/push/public-key", {
      headers: authHeaders(courierState.token),
      retryWithRefresh: refreshCourierAccess,
    });
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: pushApplicationServerKey(keyResponse.publicKey),
      });
    }
    await api("/api/courier/push/subscriptions", {
      method: "POST",
      headers: authHeaders(courierState.token),
      body: JSON.stringify({ subscription: subscription.toJSON() }),
      retryWithRefresh: refreshCourierAccess,
    });
    updateCourierPushButton(true);
    return true;
  } catch (error) {
    updateCourierPushButton(false);
    if (options.requestPermission) {
      showToast(error.message || "Bildirimler etkinlestirilemedi.", "error");
    }
    return false;
  }
}

async function currentCourierPushEndpoint() {
  if (!("serviceWorker" in navigator)) return "";
  try {
    const registration = await navigator.serviceWorker.getRegistration("/courier-push-sw.js");
    const subscription = await registration?.pushManager?.getSubscription?.();
    return subscription?.endpoint || "";
  } catch {
    return "";
  }
}

let screenWakeLock = null;

async function requestScreenWakeLock() {
  if (!courierState.token) return;
  if ("wakeLock" in navigator) {
    try {
      if (screenWakeLock !== null) {
        return; // Already active
      }
      screenWakeLock = await navigator.wakeLock.request("screen");
      screenWakeLock.addEventListener("release", () => {
        screenWakeLock = null;
      });
    } catch (err) {
      // Ignore wake lock errors
    }
  }
}

function notifyNewAssignment(pkg) {
  showToast(`${pkg.restaurantName} tarafindan yeni paket dustu: ${pkg.recipient}`, "success");
  playSignal("assignment-long");

  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }

  try {
    new Notification("RESTOMAP - Yeni Paket", {
      body: `${pkg.restaurantName} - ${pkg.deliveryAddress || pkg.address}`,
      tag: `delivera-package-${pkg.id}`,
    });
  } catch {
    // Ignore browser notification errors.
  }
}

function processIncomingPackageNotifications(packages) {
  const nextSnapshot = new Map();
  const activePackages = packages.filter(isActiveCourierPackage);

  activePackages.forEach((pkg) => {
    const signature = `${pkg.status}|${pkg.assignedAt || ""}`;
    nextSnapshot.set(pkg.id, signature);
    const previous = courierState.lastPackageSnapshot.get(pkg.id);

    if (!previous && pkg.status === "assigned") {
      notifyNewAssignment(pkg);
      return;
    }

    if (previous && previous !== signature && pkg.status === "assigned") {
      notifyNewAssignment(pkg);
    }
  });

  courierState.lastPackageSnapshot = nextSnapshot;
}

function packageCodeForCourier(pkg) {
  return presentCourierText(pkg?.trackingNo || pkg?.externalOrderNo || pkg?.platformOrderId || pkg?.id, "Paket kodu yok");
}

function setCourierOfferBusy(isBusy, action = "") {
  courierState.offerBusy = isBusy;
  [courierRefs.offerAccept, courierRefs.offerReject].forEach((button) => {
    if (button) button.disabled = isBusy;
  });
  if (courierRefs.offerAccept) {
    courierRefs.offerAccept.textContent = isBusy && action === "accept" ? "Kabul ediliyor..." : "Paketi Kabul Et";
  }
  if (courierRefs.offerReject) {
    courierRefs.offerReject.textContent = isBusy && action === "reject" ? "Reddediliyor..." : "Paketi Reddet";
  }
}

function setCourierOfferError(message = "") {
  if (!courierRefs.offerError) return;
  courierRefs.offerError.textContent = message;
  courierRefs.offerError.classList.toggle("hidden", !message);
}

function setCourierOfferVisible(isVisible) {
  courierRefs.offerOverlay?.classList.toggle("hidden", !isVisible);
  courierRefs.offerOverlay?.setAttribute("aria-hidden", isVisible ? "false" : "true");
  document.body.classList.toggle("courier-offer-open", isVisible);
}

function hideCourierOffer() {
  courierState.offerPackageId = "";
  setCourierOfferBusy(false);
  setCourierOfferError("");
  setCourierOfferVisible(false);
}

function renderCourierOffer(courier, packages = []) {
  const assignedPackages = packages
    .filter((pkg) => pkg.status === "assigned" && isActiveCourierPackage(pkg))
    .sort((left, right) => new Date(left.assignedAt || left.createdAt || 0) - new Date(right.assignedAt || right.createdAt || 0));
  const offerPackage = assignedPackages[0] || null;

  if (!offerPackage || !courier?.available) {
    if (!courierState.offerBusy) {
      hideCourierOffer();
    }
    return;
  }

  courierState.offerPackageId = offerPackage.id;
  const deliveryAddress = presentCourierText(offerPackage.deliveryAddress || offerPackage.address || offerPackage.customerAddress, "Adres yok");
  const note = presentCourierText(offerPackage.customerNote || offerPackage.note, "");
  const distanceText = Number.isFinite(Number(offerPackage.distanceKm))
    ? `${Number(offerPackage.distanceKm).toFixed(1)} km`
    : presentCourierText(offerPackage.eta, "Mesafe hesaplanmadi");

  if (courierRefs.offerTitle) courierRefs.offerTitle.textContent = "Yeni Paket Talebi";
  if (courierRefs.offerSubtitle) courierRefs.offerSubtitle.textContent = `${presentCourierText(offerPackage.restaurantName, "Restoran")} cikisli paket`;
  if (courierRefs.offerCode) courierRefs.offerCode.textContent = packageCodeForCourier(offerPackage);
  if (courierRefs.offerDetails) {
    courierRefs.offerDetails.innerHTML = [
      ["Paket kodu", packageCodeForCourier(offerPackage)],
      ["Restoran", presentCourierText(offerPackage.restaurantName, "Restoran yok")],
      ["Musteri", presentCourierText(offerPackage.recipient, "Musteri yok")],
      ["Teslimat adresi", deliveryAddress, "wide"],
      ["Tahmini ucret", presentCourierAmount(offerPackage.orderAmount)],
      ["Tahmini mesafe", distanceText],
      ["Odeme tipi", presentCourierPayment(offerPackage)],
      ...(note ? [["Siparis notu", note, "wide"]] : []),
    ].map(([label, value, wide]) => `
      <div class="${wide ? "courier-offer-detail-wide" : ""}">
        <span>${escapeCourierHtml(label)}</span>
        <strong>${escapeCourierHtml(value)}</strong>
      </div>
    `).join("");
  }
  setCourierOfferError("");
  setCourierOfferVisible(true);
}

async function submitCourierOfferAction(action) {
  if (courierState.offerBusy) return;
  const packageId = courierState.offerPackageId;
  if (!packageId) return;
  if (!courierState.data?.courier?.available) {
    setCourierOfferError("Offline durumdasin. Paketi almak icin once online ol.");
    showToast("Offline durumdasin. Once baglan.", "error");
    return;
  }

  setCourierOfferBusy(true, action);
  setCourierOfferError("");
  try {
    const endpoint = action === "accept"
      ? `/api/courier/packages/${encodeURIComponent(packageId)}/status`
      : `/api/courier/packages/${encodeURIComponent(packageId)}/reject`;
    const updatedWorkspace = await api(endpoint, {
      method: action === "accept" ? "PATCH" : "POST",
      headers: authHeaders(courierState.token),
      body: action === "accept" ? JSON.stringify({ status: "accepted_by_courier" }) : "{}",
      retryWithRefresh: refreshCourierAccess,
    });
    hideCourierOffer();
    hydrateCourierWorkspace(updatedWorkspace);
    setActiveWorkspaceSection("courierWorkspace_active_missions");
    showToast(action === "accept" ? "Paket kabul edildi." : "Paket reddedildi, yeni kurye aranıyor.");
  } catch (error) {
    setCourierOfferError(error.message || "Islem tamamlanamadi.");
    showToast(error.message || "Islem tamamlanamadi.", "error");
  } finally {
    setCourierOfferBusy(false);
  }
}

function packageRenderSignature(pkg) {
  return [
    pkg.id,
    pkg.status,
    pkg.paymentStatus,
    pkg.failureReason,
    pkg.assignedAt,
    pkg.acceptedAt,
    pkg.onRouteAt,
    pkg.deliveredAt,
    pkg.failedAt,
    pkg.updatedAt,
    pkg.lastAssignmentError,
  ].join("|");
}

function getPackageDraft(pkgId) {
  return courierState.packageActionDrafts.get(pkgId) || { paymentStatus: "", failureReason: "", courierCollectionNote: "" };
}

function setPackageDraft(pkgId, nextDraft) {
  courierState.packageActionDrafts.set(pkgId, {
    ...getPackageDraft(pkgId),
    ...nextDraft,
  });
}

function clearResolvedPackageDrafts(packages) {
  const activeIds = new Set((packages || []).filter(isActiveCourierPackage).map((pkg) => pkg.id));
  [...courierState.packageActionDrafts.keys()].forEach((pkgId) => {
    if (!activeIds.has(pkgId)) {
      courierState.packageActionDrafts.delete(pkgId);
    }
  });
}

function locationLabel(courier) {
  const gps = `${Number(courier.latitude).toFixed(5)}, ${Number(courier.longitude).toFixed(5)}`;
  const freshness = courier.lastLocationAt ? formatTimeAgo(courier.lastLocationAt) : "Konum daha paylasilmadi";
  return `${gps} - ${freshness}`;
}

function renderCourierStats(courier, packages) {
  const signature = [
    courier.id,
    courier.zone,
    courier.username,
    courier.activeLoad,
    courier.status,
    courier.available,
    courier.latitude,
    courier.longitude,
    courier.lastLocationAt,
    listRenderSignature(packages, ["id", "status", "updatedAt"]),
  ].join("||");
  if (courierRefs.stats.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.stats.__deliveraRenderSignature = signature;
  courierRefs.stats.innerHTML = "";

  const delivered = packages.filter((pkg) => pkg.status === "delivered").length;
  const inTransit = packages.filter((pkg) => pkg.status === "accepted_by_courier" || pkg.status === "on_route").length;

  courierRefs.stats.innerHTML = `
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_PIN_ICON} Bolge</span>
      <strong>${courier.zone}</strong>
    </article>
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_PERSON_ICON} Kullanici</span>
      <strong>${courier.username}</strong>
    </article>
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_MOTO_ICON} Aktif Yuk</span>
      <strong>${courier.activeLoad}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Teslim</span>
      <strong>${delivered}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Sahada</span>
      <strong>${inTransit}</strong>
    </article>
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_PERSON_ICON} Durum</span>
      <strong>${courierStatusLabel(courier.status)}</strong>
    </article>
    <article class="mini-stat-card">
      <span class="entity-line">${COURIER_PIN_ICON} Canli GPS</span>
      <strong class="gps-stat">${locationLabel(courier)}</strong>
    </article>
  `;
}

function renderCourierDayMetrics(dayMetrics) {
  const metrics = dayMetrics || {
    deliveredCount: 0,
    totalAmount: 0,
    paidOnlineAmount: 0,
    cashCollectedAmount: 0,
    creditCardAmount: 0,
    restaurantCollectedAmount: 0,
    failedCollectionTotal: 0,
    courierEarnings: 0,
    hasClosedDay: false,
    closedAt: null,
  };
  const signature = listRenderSignature([metrics], ["deliveredCount", "totalAmount", "paidOnlineAmount", "cashCollectedAmount", "creditCardAmount", "restaurantCollectedAmount", "failedCollectionTotal", "courierEarnings", "hasClosedDay", "closedAt"]);
  if (courierRefs.dayMetrics.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.dayMetrics.__deliveraRenderSignature = signature;
  courierRefs.dayMetrics.innerHTML = "";

  courierRefs.dayMetrics.innerHTML = `
    <article class="mini-stat-card">
      <span>Bugun Teslim</span>
      <strong>${metrics.deliveredCount}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Gunluk Ciro</span>
      <strong>${formatCurrency(metrics.totalAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Gunluk Kazanc</span>
      <strong>${formatCurrency(metrics.courierEarnings || 0)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Online</span>
      <strong>${formatCurrency(metrics.paidOnlineAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Nakit</span>
      <strong>${formatCurrency(metrics.cashCollectedAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Kart</span>
      <strong>${formatCurrency(metrics.creditCardAmount)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Tahsil Edilemedi</span>
      <strong>${formatCurrency(metrics.failedCollectionTotal)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Rapor</span>
      <strong>${metrics.hasClosedDay ? `Kapandi ${formatTimeAgo(metrics.closedAt)}` : "Henuz kapanmadi"}</strong>
    </article>
  `;
  if (courierRefs.dayCloseButton) {
    courierRefs.dayCloseButton.disabled = Boolean(metrics.hasClosedDay);
    courierRefs.dayCloseButton.textContent = metrics.hasClosedDay ? "Bugun Gun Sonu Yapildi" : "Gunu Bitir";
  }
  if (courierRefs.dayCloseNote) {
    courierRefs.dayCloseNote.disabled = Boolean(metrics.hasClosedDay);
  }
}

function renderCourierEarnings(earningsSummary) {
  if (!courierRefs.earningsMetrics) {
    return;
  }

  const data = earningsSummary || {
    today: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0, courierEarnings: 0 },
    yesterday: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0, courierEarnings: 0 },
    last7Days: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0, courierEarnings: 0 },
    total: { deliveredCount: 0, totalAmount: 0, paidOnlineAmount: 0, cashAmount: 0, courierEarnings: 0 },
  };
  const signature = JSON.stringify(data);
  if (courierRefs.earningsMetrics.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.earningsMetrics.__deliveraRenderSignature = signature;

  courierRefs.earningsMetrics.innerHTML = `
    <article class="mini-stat-card">
      <span>Bugunku Kazanc</span>
      <strong>${formatCurrency(data.today.courierEarnings || 0)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Dun</span>
      <strong>${formatCurrency(data.yesterday.courierEarnings || 0)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Son 7 Gun</span>
      <strong>${formatCurrency(data.last7Days.courierEarnings || 0)}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Toplam Teslimat</span>
      <strong>${data.total.deliveredCount}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Toplam Kazanc</span>
      <strong>${formatCurrency(data.total.courierEarnings || 0)}</strong>
    </article>
  `;
}

function syncCourierProfilePanels() {
  const panels = [...document.querySelectorAll(".courier-profile-panel .inner-day-panel")];
  panels.forEach((panel, index) => {
    const sectionKey = panel.dataset.section || `panel-${index}`;
    const isActive = sectionKey === courierState.activeProfileSection;
    panel.classList.toggle("panel-expanded", isActive);
    panel.classList.toggle("panel-collapsed", !isActive);
  });
}

function initializeCourierProfilePanels() {
  const sectionKeys = ["day-close", "earnings", "notifications", "announcements"];
  const panels = [...document.querySelectorAll(".courier-profile-panel .inner-day-panel")];

  panels.forEach((panel, index) => {
    panel.dataset.section = sectionKeys[index] || `panel-${index}`;
    const header = panel.querySelector(".panel-head");
    if (!header || header.dataset.bound === "1") {
      return;
    }

    header.dataset.bound = "1";
    header.classList.add("panel-toggle-head");
    header.tabIndex = 0;
    header.setAttribute("role", "button");
    header.setAttribute("aria-expanded", panel.dataset.section === courierState.activeProfileSection ? "true" : "false");

    const togglePanel = () => {
      courierState.activeProfileSection = courierState.activeProfileSection === panel.dataset.section
        ? ""
        : panel.dataset.section;
      syncCourierProfilePanels();
      panels.forEach((item) => {
        const itemHeader = item.querySelector(".panel-head");
        if (itemHeader) {
          itemHeader.setAttribute("aria-expanded", item.dataset.section === courierState.activeProfileSection ? "true" : "false");
        }
      });
    };

    header.addEventListener("click", (event) => {
      if (event.target.closest("button, select, input, textarea, a, label")) {
        return;
      }
      togglePanel();
    });

    header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      togglePanel();
    });
  });

  syncCourierProfilePanels();
}

function shiftPlanStatusLabel(status) {
  if (status === "accepted") {
    return "Onaylandi";
  }
  if (status === "awaiting_courier_acceptance") {
    return "Onay Bekliyor";
  }
  if (status === "expired") {
    return "Sure Doldu";
  }
  return status || "Planlandi";
}

function shiftDeadlineText(value) {
  if (!value) {
    return "Sure bilgisi yok";
  }
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) {
    return "Onay suresi doldu";
  }
  const totalMinutes = Math.max(1, Math.ceil(diffMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours} sa ${minutes} dk kaldi`;
  }
  return `${minutes} dk kaldi`;
}

function renderCourierShiftSummary(shiftSummary) {
  if (!courierRefs.shiftMetrics) {
    return;
  }

  const currentShift = shiftSummary?.currentShift || null;
  const recentShifts = shiftSummary?.recentShifts || [];
  const shiftPlans = shiftSummary?.shiftPlans || [];
  const signature = [
    currentShift?.id,
    currentShift?.startedAt,
    listRenderSignature(recentShifts.slice(0, 3), ["id", "startedAt", "endedAt"]),
    listRenderSignature(shiftPlans.slice(0, 3), ["id", "planDate", "startTime", "endTime", "zone", "status", "acceptedAt", "offerExpiresAt"]),
  ].join("||");
  if (courierRefs.shiftMetrics.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.shiftMetrics.__deliveraRenderSignature = signature;
  const items = [];

  items.push(`
    <article class="stack-card">
      <div class="stack-top">
        <div>
          <strong>Vardiya Baslangici</strong>
          <p>${currentShift?.startedAt ? formatDate(currentShift.startedAt) : "Acik vardiya yok"}</p>
        </div>
        <span class="soft-badge">${currentShift ? "Aktif" : "Kapali"}</span>
      </div>
    </article>
  `);

  items.push(`
    <article class="stack-card">
      <div class="stack-top">
        <div>
          <strong>Vardiya Bitisi</strong>
          <p>${currentShift ? "Henuz kapanmadi" : (recentShifts[0]?.endedAt ? formatDate(recentShifts[0].endedAt) : "Kayit yok")}</p>
        </div>
        <span class="soft-badge">${recentShifts.length} kayit</span>
      </div>
    </article>
  `);

  shiftPlans.slice(0, 3).forEach((plan) => {
    items.push(`
      <article class="stack-card shift-offer-card ${plan.status === "awaiting_courier_acceptance" ? "shift-offer-pending" : ""}">
        <div class="stack-top">
          <div>
            <strong>${plan.planDate} - ${plan.startTime} / ${plan.endTime}</strong>
            <p>${plan.zone} bolgesi vardiya plani</p>
            <p>${plan.status === "awaiting_courier_acceptance" ? shiftDeadlineText(plan.offerExpiresAt) : (plan.acceptedAt ? `Onay ${formatDate(plan.acceptedAt)}` : shiftPlanStatusLabel(plan.status))}</p>
          </div>
          <span class="soft-badge">${shiftPlanStatusLabel(plan.status)}</span>
        </div>
        ${plan.status === "awaiting_courier_acceptance" ? `<div class="stack-actions"><button class="primary-btn" type="button" data-shift-accept="${plan.id}">Vardiyayi Onayla</button></div>` : ""}
      </article>
    `);
  });

  courierRefs.shiftMetrics.innerHTML = items.join("");
  [...courierRefs.shiftMetrics.querySelectorAll("[data-shift-accept]")].forEach((button) => {
    button.addEventListener("click", async () => {
      const data = await api(`/api/courier/shift-plans/${button.dataset.shiftAccept}/accept`, {
        method: "POST",
        headers: authHeaders(courierState.token),
        body: "{}",
        retryWithRefresh: refreshCourierAccess,
      });
      hydrateCourierWorkspace(data);
      showToast("Vardiya plani onaylandi.");
    });
  });
}

function renderPackages(packages) {
  const activePackages = packages.filter(isActiveCourierPackage);
  const mapsKey = courierState.data?.mapsConfig?.googleMapsEmbedApiKey || "";
  const livePositionKey = `${courierState.data?.courier?.latitude || ""},${courierState.data?.courier?.longitude || ""}`;
  const signature = `${mapsKey}|${livePositionKey}|${listRenderSignature(activePackages, ["id", "trackingNo", "externalOrderNo", "status", "assignedAt", "paymentStatus", "failureReason", "updatedAt", "eta", "lastAssignmentError", "deliveryAddress", "address", "customerAddress", "customerLat", "customerLng", "customerLatitude", "customerLongitude", "items"])}`;
  if (courierRefs.packages.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.packages.__deliveraRenderSignature = signature;
  courierRefs.packages.innerHTML = "";

  if (activePackages.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();

  activePackages.forEach((pkg) => {
    const node = courierRefs.template.content.cloneNode(true);
    const badge = node.querySelector(".status-badge");
    const actions = node.querySelector(".card-actions");
    const assignedAtBadge = node.querySelector(".assigned-at-badge");
    const etaBadge = node.querySelector(".eta-badge");
    const failureBadge = node.querySelector(".failure-badge");
    const currentDraft = getPackageDraft(pkg.id);
    let selectedPaymentStatus = currentDraft.paymentStatus || pkg.paymentStatus || "";
    let selectedFailureReason = currentDraft.failureReason || "";

    const customerName = presentCourierText(pkg.recipient, "Musteri adi yok");
    const customerPhone = presentCourierText(pkg.phone, "Telefon yok");
    const deliveryAddress = presentCourierText(pkg.deliveryAddress || pkg.address || pkg.customerAddress, "Adres yok");
    const platformOrderId = presentCourierText(pkg.platformOrderId || pkg.externalOrderId || pkg.externalOrderNo, "Platform siparis ID yok");
    const posentegraPid = presentCourierText(pkg.posentegraId || pkg.posentegra_id, "");
    const paymentText = presentCourierPayment(pkg);

    node.querySelector(".tracking-no").innerHTML = `${COURIER_PACKAGE_ICON} ${escapeCourierHtml(presentCourierText(pkg.trackingNo, "Takip no yok"))}`;
    node.querySelector(".recipient-name").textContent = customerName;
    node.querySelector(".customer-name-value").textContent = customerName;
    node.querySelector(".customer-phone-value").textContent = customerPhone;
    node.querySelector(".order-amount-value").textContent = presentCourierAmount(pkg.orderAmount);
    node.querySelector(".payment-status-value").textContent = paymentText;
    node.querySelector(".platform-order-id-value").textContent = platformOrderId;
    const posentegraPidRow = node.querySelector(".posentegra-pid-row");
    if (posentegraPid) {
      node.querySelector(".posentegra-pid-value").textContent = posentegraPid;
      posentegraPidRow?.classList.remove("hidden");
    } else {
      posentegraPidRow?.classList.add("hidden");
    }
    node.querySelector(".platform-name").innerHTML = `${COURIER_PACKAGE_ICON} ${escapeCourierHtml(pkg.source === "external_manual" || pkg.source === "manual" ? "Manuel Paket" : presentCourierText(pkg.platform || pkg.sourcePlatform, "Platform yok"))} - Restoran Platform ID: ${escapeCourierHtml(presentCourierText(pkg.platformRestaurantId, "Yok"))}`;
    node.querySelector(".restaurant-name").innerHTML = `${COURIER_MOTO_ICON} ${escapeCourierHtml(pkg.restaurantName)} - ${escapeCourierHtml(pkg.restaurantId || "-")}`;
    node.querySelector(".zone-name").innerHTML = `${COURIER_PIN_ICON} ${escapeCourierHtml(pkg.zone)}`;
    node.querySelector(".eta-value").textContent = presentCourierText(pkg.eta, "ETA yok");
    node.querySelector(".payment-method").textContent = `${paymentText} - ${presentCourierAmount(pkg.orderAmount)}`;
    const courierOrderItems = node.querySelector(".courier-order-items");
    if (courierOrderItems) {
      courierOrderItems.innerHTML = window.renderOrderItemsBox?.(pkg, { compact: true }) || "";
    }
    node.querySelector(".address-value").innerHTML = `${COURIER_PIN_ICON} ${escapeCourierHtml(deliveryAddress)}`;
    renderPackageMapPreview(node.querySelector(".courier-package-map-preview"), pkg, { hideWhenUnavailable: true });
    node.querySelector(".note-text").textContent =
      `${pkg.note || "Ek not yok."} - Kayit ${formatDate(pkg.createdAt)}${pkg.failureReason ? ` - Sorun: ${pkg.failureReason}` : ""}`;

    const photoEl = node.querySelector(".order-photo");
    if (pkg.rawPayload && pkg.rawPayload.photoUrl) {
      photoEl.src = pkg.rawPayload.photoUrl;
      photoEl.classList.remove("hidden");
      photoEl.addEventListener("click", () => {
        const overlay = document.createElement("div");
        overlay.style.position = "fixed";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.width = "100%";
        overlay.style.height = "100%";
        overlay.style.backgroundColor = "rgba(0,0,0,0.8)";
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";
        overlay.style.zIndex = "9999";
        overlay.style.cursor = "pointer";
        
        const img = document.createElement("img");
        img.src = pkg.rawPayload.photoUrl;
        img.style.maxWidth = "90%";
        img.style.maxHeight = "90%";
        img.style.borderRadius = "8px";
        img.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";
        
        overlay.appendChild(img);
        overlay.addEventListener("click", () => document.body.removeChild(overlay));
        document.body.appendChild(overlay);
      });
    }

    const offerWindowSeconds = pkg.status === "assigned" && pkg.assignedAt
      ? Math.max(0, 25 - Math.floor((Date.now() - new Date(pkg.assignedAt).getTime()) / 1000))
      : 0;
    assignedAtBadge.textContent = pkg.status === "assigned"
      ? `Teklif ${offerWindowSeconds} sn`
      : `Atama ${pkg.assignedAt ? formatTimeAgo(pkg.assignedAt) : "bekliyor"}`;
    etaBadge.textContent = `Teslim hedefi ${pkg.eta || "-"}`;

    if (pkg.failureReason) {
      failureBadge.textContent = `Sorun: ${courierFailureReasonLabel(pkg.failureReason)}`;
      failureBadge.classList.remove("hidden");
    } else {
      failureBadge.classList.add("hidden");
    }

    badge.textContent = statusLabel(pkg.status);
    badge.className = `status-badge ${statusClassName(pkg.status)}`;

    const submitStatus = async (status, failureReason = "", paymentStatus = "", courierCollectionNote = "") => {
      if (status === "failed" && !failureReason) {
        showToast("Lutfen sorun nedenini sec.", "error");
        return;
      }
      try {
        const updatedWorkspace = await api(`/api/courier/packages/${pkg.id}/status`, {
          method: "PATCH",
          headers: authHeaders(courierState.token),
          body: JSON.stringify({ status, failureReason, paymentStatus, courierCollectionNote }),
          retryWithRefresh: refreshCourierAccess,
        });
        courierState.packageActionDrafts.delete(pkg.id);
        hydrateCourierWorkspace(updatedWorkspace);
        showToast(status === "failed"
          ? (failureReason === "ters_yon"
            ? "Paket ters yön nedeniyle yeniden atama havuzuna alındı."
            : "Paket sorun nedeniyle iptal edildi. Paket ücreti hakedişe eklendi.")
          : "Paket durumu güncellendi.");
      } catch (error) {
        showToast(error.message || "Durum güncellenemedi.", "error");
      }
    };

    actions.innerHTML = "";

    const showRestaurantAction = ["assigned", "accepted_by_courier"].includes(pkg.status);
    const showCustomerAction = pkg.status === "on_route";

    if (showRestaurantAction && hasMapTarget(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude, pkg.restaurantAddress || pkg.restaurantName || pkg.zone)) {
      const restaurantMapButton = document.createElement("button");
      restaurantMapButton.type = "button";
      restaurantMapButton.className = "ghost-btn courier-action-secondary courier-map-action";
      restaurantMapButton.textContent = "Restoran";
      restaurantMapButton.addEventListener("click", () => {
        openOrderMap(pkg, "restaurant");
      });
      actions.appendChild(restaurantMapButton);
    }

    if (showCustomerAction && hasMapTarget(pkg.customerLat ?? pkg.customerLatitude, pkg.customerLng ?? pkg.customerLongitude, pkg.customerAddress || pkg.deliveryAddress || pkg.address)) {
      const customerMapButton = document.createElement("button");
      customerMapButton.type = "button";
      customerMapButton.className = "ghost-btn courier-action-secondary courier-map-action";
      customerMapButton.textContent = "Musteri";
      customerMapButton.addEventListener("click", () => {
        openOrderMap(pkg, "customer");
      });
      actions.appendChild(customerMapButton);
    }

    if (pkg.status === "assigned") {
      const acceptButton = document.createElement("button");
      acceptButton.type = "button";
      acceptButton.className = "primary-btn courier-action-main";
      acceptButton.textContent = "Kabul Et";
      acceptButton.addEventListener("click", async () => {
        await submitStatus("accepted_by_courier");
      });
      actions.appendChild(acceptButton);
    }

    if (pkg.status === "accepted_by_courier") {
      const routeButton = document.createElement("button");
      routeButton.type = "button";
      routeButton.className = "primary-btn courier-action-main";
      routeButton.textContent = "Yola Ciktim";
      routeButton.addEventListener("click", async () => {
        await submitStatus("on_route");
      });
      actions.appendChild(routeButton);
    }

    if (pkg.status === "on_route") {
      const paymentAction = courierPaymentAction(pkg);
      const requiresCollection = paymentAction.requiresSelection;
      let paymentSelect = null;
      if (requiresCollection) {
        paymentSelect = document.createElement("select");
        paymentSelect.className = "status-select courier-action-select";
        paymentSelect.innerHTML = [
          '<option value="">Tahsilat Seç</option>',
          '<option value="cash_collected">Nakit Alındı</option>',
          '<option value="credit_card_collected">Kartla Alındı</option>',
          '<option value="restaurant_collected">Restoran Aldı</option>',
          '<option value="payment_issue">Alınamadı</option>',
        ].join("");
        if (["cash_collected", "credit_card_collected", "restaurant_collected", "payment_issue"].includes(selectedPaymentStatus)) {
          paymentSelect.value = selectedPaymentStatus;
        }
        paymentSelect.addEventListener("change", () => {
          selectedPaymentStatus = paymentSelect.value;
          setPackageDraft(pkg.id, { paymentStatus: selectedPaymentStatus });
        });
      } else {
        selectedPaymentStatus = pkg.paymentStatus || "";
      }
      const noteInput = document.createElement("input");
      noteInput.className = "courier-action-note hidden";
      noteInput.type = "text";
      noteInput.placeholder = "Tahsilat notu (istege bagli)";
      noteInput.value = currentDraft.courierCollectionNote || pkg.courierCollectionNote || "";
      const hasCollectionDecision = ["cash_collected", "credit_card_collected", "restaurant_collected", "payment_issue"]
        .includes(selectedPaymentStatus);
      noteInput.classList.toggle("hidden", !requiresCollection || (!hasCollectionDecision && !noteInput.value));
      noteInput.addEventListener("input", () => {
        setPackageDraft(pkg.id, { courierCollectionNote: noteInput.value });
      });
      paymentSelect?.addEventListener("change", () => {
        noteInput.classList.toggle("hidden", !paymentSelect.value && !noteInput.value);
      });

      const deliveredButton = document.createElement("button");
      deliveredButton.type = "button";
      deliveredButton.className = "primary-btn delivered-action courier-action-delivered";
      deliveredButton.textContent = "Teslim Edildi";
      deliveredButton.addEventListener("click", async () => {
        if (requiresCollection && !selectedPaymentStatus) {
          showToast("Teslim oncesi odeme durumunu sec.", "error");
          return;
        }
        await submitStatus("delivered", "", selectedPaymentStatus, noteInput.value);
      });
      if (paymentSelect) {
        actions.appendChild(paymentSelect);
        actions.appendChild(noteInput);
      } else {
        const paymentSummary = document.createElement("div");
        paymentSummary.className = "courier-payment-summary";
        paymentSummary.setAttribute("role", "status");
        paymentSummary.textContent = paymentAction.label === "Odeme bilgisi yok"
          ? "Tahsilat gerekmiyor"
          : paymentAction.label;
        actions.appendChild(paymentSummary);
      }
      actions.appendChild(deliveredButton);
    }

    if (["assigned", "accepted_by_courier", "on_route"].includes(pkg.status)) {
      const failureSelect = document.createElement("select");
      failureSelect.className = "status-select courier-action-select";
      const availableFailureReasons = activePackages.length >= 2
        ? COURIER_FAILURE_REASON_OPTIONS
        : COURIER_FAILURE_REASON_OPTIONS.filter((item) => item.value !== "ters_yon");
      failureSelect.innerHTML = ['<option value="">Sorun nedeni sec</option>']
        .concat(availableFailureReasons.map((item) => `<option value="${item.value}">${item.label}</option>`))
        .join("");
      failureSelect.value = selectedFailureReason;
      failureSelect.addEventListener("change", () => {
        selectedFailureReason = failureSelect.value;
        setPackageDraft(pkg.id, { failureReason: selectedFailureReason });
      });

      const failureButton = document.createElement("button");
      failureButton.type = "button";
      failureButton.className = "ghost-btn courier-action-danger";
      failureButton.textContent = "Sorun Bildir";
      failureButton.addEventListener("click", async () => {
        await submitStatus("failed", selectedFailureReason);
      });

      const failureActions = document.createElement("details");
      failureActions.className = "courier-issue-actions";
      const failureSummary = document.createElement("summary");
      failureSummary.textContent = "Sorun Bildir";
      const failureControls = document.createElement("div");
      failureControls.className = "courier-issue-controls";
      failureControls.append(failureSelect, failureButton);
      failureActions.append(failureSummary, failureControls);
      actions.appendChild(failureActions);
    }

    fragment.appendChild(node);
  });

  courierRefs.packages.appendChild(fragment);
}

function renderCourierHistory(packages, historySource = null) {
  const sourcePackages = Array.isArray(historySource) ? historySource : packages;
  const filteredHistory = [...sourcePackages]
    .filter((pkg) => ["delivered", "failed", "cancelled"].includes(pkg.status))
    .filter((pkg) => packageMatchesHistoryRange(pkg, courierState.historyRange))
    .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt))
  const visibleHistoryPackages = filteredHistory.slice(0, courierState.historyVisibleCount);
  const signature = [
    courierState.historyRange,
    courierState.historyVisibleCount,
    filteredHistory.length,
    listRenderSignature(visibleHistoryPackages, ["id", "trackingNo", "recipient", "restaurantName", "deliveryAddress", "address", "status", "paymentStatus", "failureReason", "updatedAt", "deliveredAt", "failedAt"]),
  ].join("||");
  if (courierRefs.history.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.history.__deliveraRenderSignature = signature;
  courierRefs.history.innerHTML = "";

  courierRefs.historyMeta.textContent = `${filteredHistory.length} kapanan teslimattan ${visibleHistoryPackages.length} kayit gorunuyor.`;
  courierRefs.historyMore.classList.toggle("hidden", visibleHistoryPackages.length >= filteredHistory.length);
  [...courierRefs.historyFilters.querySelectorAll("[data-range]")].forEach((button) => {
    button.classList.toggle("active", button.dataset.range === courierState.historyRange);
  });

  if (visibleHistoryPackages.length === 0) {
    courierRefs.history.innerHTML = '<div class="empty-state">Dun ve onceki gunlerden kapanan teslimat kaydi yok.</div>';
    return;
  }

  visibleHistoryPackages.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = "stack-card courier-history-card";
    card.innerHTML = `
      <div class="stack-top courier-history-card__top">
        <div class="courier-history-card__summary">
          <strong>${pkg.trackingNo} - ${pkg.recipient}</strong>
          <p class="entity-line">${COURIER_MOTO_ICON} ${escapeCourierHtml(pkg.restaurantName)}</p>
          <p class="entity-line">${COURIER_PIN_ICON} ${escapeCourierHtml(pkg.deliveryAddress || pkg.address)}</p>
          <p>Kapanis: ${formatDate(pkg.updatedAt || pkg.deliveredAt || pkg.failedAt || pkg.createdAt)}</p>
        </div>
        <div class="courier-history-card__actions">
          <span class="soft-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
          <button class="primary-btn details-btn courier-history-card__details" type="button" data-package-id="${pkg.id}" aria-label="${pkg.trackingNo || "Siparis"} detayini goruntule">
            ${COURIER_PACKAGE_ICON} Detay
          </button>
        </div>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Odeme</span>
          <strong>${pkg.paymentMethod} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}</strong>
        </div>
        <div>
          <span>Sorun</span>
          <strong>${courierFailureReasonLabel(pkg.failureReason)}</strong>
        </div>
      </div>
    `;
    card.querySelectorAll('.details-btn').forEach((button) => button.addEventListener('click', () => {
      window.openCourierPackageDetails(pkg);
    }));
    courierRefs.history.appendChild(card);
  });
}

function renderCourierNotifications(notifications) {
  renderNotificationCenter(courierRefs.notificationCenter, notifications || [], "Kurye icin bildirim yok.");
}

function renderCourierAnnouncements(items) {
  const announcements = (items || []).filter((item) => item.targetRole === "courier");
  const signature = listRenderSignature(announcements, ["id", "targetRole", "title", "message", "updatedAt", "createdAt"]);
  if (courierRefs.announcementList.__deliveraRenderSignature === signature) {
    return;
  }
  courierRefs.announcementList.__deliveraRenderSignature = signature;
  courierRefs.announcementList.innerHTML = "";

  if (!announcements.length) {
    courierRefs.announcementList.innerHTML = '<div class="empty-state compact-empty-state">Aktif admin duyurusu yok.</div>';
    return;
  }

  announcements.forEach((item) => {
    const card = document.createElement("article");
    card.className = "stack-card notification-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${item.title}</strong>
          <p>${item.message}</p>
          <p>Yayin zamani ${formatDate(item.updatedAt || item.createdAt)}</p>
        </div>
        <span class="soft-badge">Aktif</span>
      </div>
    `;
    courierRefs.announcementList.appendChild(card);
  });
}

function renderCourierFocus(courier, packages) {
  const activePackages = packages.filter(isActiveCourierPackage);
  const priority = activePackages.find((pkg) => pkg.status === "on_route") || activePackages.find((pkg) => pkg.status === "accepted_by_courier") || activePackages[0] || null;
  courierState.focusPackage = priority;

  if (!priority) {
    courierRefs.focusCard?.classList.add("hidden");
    courierRefs.destinationMap?.classList.add("hidden");
    if (courierRefs.focusLabel) courierRefs.focusLabel.textContent = "Yeni Paket";
    courierRefs.focusTitle.textContent = courier.available ? "Yeni Paket Bekleniyor" : "Vardiya Kapali";
    courierRefs.focusText.textContent = courier.available
      ? "Paket dustugunde burada tek kart olarak gorunecek."
      : "Hazir oldugunda baglan, yeni paketler burada gorunsun.";
    if (courierRefs.mapTitle) courierRefs.mapTitle.textContent = "Harita bekleniyor";
    if (courierRefs.mapAddress) courierRefs.mapAddress.textContent = "Yeni paket geldiginde gidecegin adres burada gorunecek.";
    courierRefs.destinationMap?.classList.add("map-empty");
    if (courierRefs.destinationPreview) courierRefs.destinationPreview.innerHTML = "";
    courierRefs.mapButton?.setAttribute("disabled", "disabled");
    if (courierRefs.missionMeta) courierRefs.missionMeta.textContent = "Henuz aktif paket yok.";
    return;
  }

  courierRefs.focusCard?.classList.remove("hidden");
  courierRefs.destinationMap?.classList.remove("hidden");
  if (courierRefs.focusLabel) courierRefs.focusLabel.textContent = "Yeni Paket Dustu";
  courierRefs.focusTitle.textContent = `${priority.trackingNo} - ${priority.recipient}`;
  courierRefs.focusText.textContent = `${statusLabel(priority.status)} - ${priority.restaurantName} cikisli paket.`;
  if (courierRefs.mapTitle) courierRefs.mapTitle.textContent = priority.recipient || "Teslimat";
  if (courierRefs.mapAddress) courierRefs.mapAddress.textContent = priority.deliveryAddress || priority.address || "Adres bilgisi bekleniyor.";
  courierRefs.destinationMap?.classList.remove("map-empty");
  renderPackageMapPreview(courierRefs.destinationPreview, priority);
  courierRefs.mapButton?.removeAttribute("disabled");
  if (courierRefs.missionMeta) courierRefs.missionMeta.textContent = `${activePackages.length} aktif paket, ${activePackages.filter((pkg) => pkg.status === "on_route").length} sahada.`;
}

function syncConnectionSwitch(courier = courierState.data?.courier) {
  if (!courierRefs.connectionSwitch) {
    return;
  }

  const connected = Boolean(courier?.available);
  courierRefs.connectionSwitch.checked = connected;
  courierRefs.connectionSwitch.disabled = courierState.connectionBusy;
  courierRefs.connectionSwitch.setAttribute("aria-checked", String(connected));
  if (courierRefs.connectionLabel) {
    courierRefs.connectionLabel.textContent = courierState.connectionBusy
      ? "İşleniyor..."
      : connected
        ? "Bağlantıyı Kes"
        : "Bağlan";
  }
}

function restoreCourierConnectionFromWorkspace(courier = courierState.data?.courier) {
  if (!courier || courierState.connectionBusy) {
    return;
  }

  if (courier.available) {
    startLocationWatch({
      latitude: courier.latitude,
      longitude: courier.longitude,
    });
    return;
  }

  stopLocationWatch();
}

function hydrateCourierWorkspace(data) {
  const nextSignature = JSON.stringify({
    courier: data.courier ? [
      data.courier.id,
      data.courier.name,
      data.courier.status,
      data.courier.available,
      data.courier.updatedAt,
    ] : null,
    packages: (data.packages || []).map((item) => [
      item.id,
      item.status,
      item.assignmentStatus,
      item.paymentStatus,
      item.assignedCourierId,
      item.updatedAt,
    ]),
    historyPackages: (data.historyPackages || []).map((item) => [item.id, item.status, item.paymentStatus, item.updatedAt]),
    notifications: (data.notifications || []).map((item) => [item.id, item.readAt, item.createdAt]),
    announcements: (data.announcements || []).map((item) => [item.id, item.active, item.updatedAt, item.createdAt]),
    dayMetrics: data.dayMetrics,
    earningsSummary: data.earningsSummary,
    shiftSummary: data.shiftSummary,
    historyRange: courierState.historyRange,
    historyVisibleCount: courierState.historyVisibleCount,
  });
  if (courierState.lastHydrateSignature === nextSignature) {
    courierState.data = data;
    setLoggedIn(true);
    renderCourierOffer(data.courier, data.packages);
    return;
  }
  courierState.lastHydrateSignature = nextSignature;
  initializeCourierProfilePanels();
  processIncomingPackageNotifications(data.packages);
  clearResolvedPackageDrafts(data.packages);
  courierState.data = data;
  setLoggedIn(true);
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    initializeCourierPush();
  } else {
    updateCourierPushButton(false);
  }
  requestScreenWakeLock();
  startWorkspacePolling();
  startCourierLiveStream();
  courierRefs.name.textContent = data.courier.name;
  if (courierRefs.summary) {
    courierRefs.summary.textContent =
      `${data.courier.name} hesabinda ${data.packages.filter(isActiveCourierPackage).length} aktif paket var.`;
  }
  if (courierRefs.liveBadge) {
    courierRefs.liveBadge.textContent = "Canli akis acik";
  }
  restoreCourierConnectionFromWorkspace(data.courier);
  setShiftGreetingStatus(data.courier.available);
  syncConnectionSwitch(data.courier);
  renderCourierOffer(data.courier, data.packages);
  renderCourierStats(data.courier, data.packages);
  renderCourierDayMetrics(data.dayMetrics);
  renderCourierEarnings(data.earningsSummary);
  renderCourierShiftSummary(data.shiftSummary);
  renderCourierFocus(data.courier, data.packages);
  renderPackages(data.packages);
  renderCourierHistory(data.packages, data.historyPackages);
  renderCourierNotifications(data.notifications || []);
  renderCourierAnnouncements(data.announcements || []);
}

courierRefs.historyFilters?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-range]");
  if (!button) {
    return;
  }
  courierState.historyRange = button.dataset.range;
  courierState.historyVisibleCount = 50;
  if (courierState.data) {
    renderCourierHistory(courierState.data.packages || [], courierState.data.historyPackages || null);
  }
});

courierRefs.historyMore?.addEventListener("click", () => {
  courierState.historyVisibleCount += 50;
  if (courierState.data) {
    renderCourierHistory(courierState.data.packages || [], courierState.data.historyPackages || null);
  }
});

courierRefs.offerAccept?.addEventListener("click", () => {
  submitCourierOfferAction("accept");
});

courierRefs.offerReject?.addEventListener("click", () => {
  submitCourierOfferAction("reject");
});

courierRefs.mapButton?.addEventListener("click", () => {
  if (!courierState.focusPackage) {
    showToast("Once aktif paket gelsin.", "error");
    return;
  }
  openOrderMap(courierState.focusPackage, "customer");
});

async function pushCourierLocation(payload, options = {}) {
  const isLocationOnlyUpdate =
    options.locationOnly ||
    (typeof payload.latitude === "number" || typeof payload.longitude === "number") &&
    typeof payload.available !== "boolean";
  if (isLocationOnlyUpdate && courierState.locationPushPromise) {
    return courierState.locationPushPromise;
  }
  const request = api("/api/courier/location", {
    method: "PATCH",
    headers: authHeaders(courierState.token),
    body: JSON.stringify(payload),
    retryWithRefresh: refreshCourierAccess,
  });
  if (isLocationOnlyUpdate) {
    courierState.locationPushPromise = request.finally(() => {
      courierState.locationPushPromise = null;
      courierState.lastLocationPushAt = Date.now();
    });
  }
  const data = await (isLocationOnlyUpdate ? courierState.locationPushPromise : request);
  if (isLocationOnlyUpdate) {
    if (courierState.data?.courier && data?.courier) {
      courierState.data = {
        ...courierState.data,
        courier: data.courier,
      };
    }
  } else {
    hydrateCourierWorkspace(data);
  }
  return data;
}

async function heartbeatCourierLocation() {
  if (!courierState.token || !courierState.data?.courier) {
    return;
  }

  const coords = courierState.lastCoords || {
    latitude: courierState.data.courier.latitude,
    longitude: courierState.data.courier.longitude,
  };

  try {
    await pushCourierLocation({
      ...coords,
      available: courierState.data.courier.available,
      locationOnly: true,
    }, { locationOnly: true });
    setShiftGreetingStatus(courierState.data?.courier?.available);
  } catch (error) {
    setLocationStatus(error.message);
  }
}

async function refreshCourierLocationNow() {
  if (!courierState.token || !courierState.data?.courier?.available || document.visibilityState === "hidden") {
    return;
  }

  try {
    const position = await getCurrentCourierPosition();
    const coords = {
      latitude: Number(position.coords.latitude.toFixed(6)),
      longitude: Number(position.coords.longitude.toFixed(6)),
    };
    courierState.lastCoords = coords;
    await pushCourierLocation({
      ...coords,
      available: true,
      locationOnly: true,
    }, { locationOnly: true });
    startLocationWatch(coords);
    setShiftGreetingStatus(true);
  } catch (error) {
    handleLocationError(error);
  }
}

function handleLocationError(error) {
  const message = error?.code === 1
    ? "Konum izni reddedildi. Adminde canli takip icin tarayici izni vermen gerekiyor."
    : "Konum alinamadi. GPS veya tarayici ayarlarini kontrol et.";
  setLocationStatus(message);
}

function getCurrentCourierPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Bu cihazda konum desteği bulunmuyor."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 5_000,
      timeout: 12_000,
    });
  });
}

function startLocationWatch(initialCoords = null) {
  if (!courierState.token) {
    return;
  }

  if (!navigator.geolocation) {
    setLocationStatus("Bu cihazda geolocation desteklenmiyor.");
    return false;
  }

  if (courierState.watchId !== null) {
    setShiftGreetingStatus(true);
    return true;
  }

  if (initialCoords) {
    courierState.lastCoords = initialCoords;
  }

  courierState.watchId = navigator.geolocation.watchPosition(
    async (position) => {
      const coords = {
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
      };
      const last = courierState.lastCoords;
      const moved =
        !last ||
        Math.abs(last.latitude - coords.latitude) > 0.00005 ||
        Math.abs(last.longitude - coords.longitude) > 0.00005;

      setShiftGreetingStatus(courierState.data?.courier?.available ?? true);
      if (!moved && Date.now() - courierState.lastLocationPushAt < LOCATION_PUSH_MS) {
        return;
      }
      courierState.lastCoords = coords;
      try {
        await pushCourierLocation({
          ...coords,
          available: courierState.data?.courier?.available ?? true,
          locationOnly: true,
        }, { locationOnly: true });
      } catch (error) {
        setLocationStatus(error.message);
      }
    },
    handleLocationError,
    {
      enableHighAccuracy: true,
      maximumAge: 5_000,
      timeout: 12_000,
    }
  );

  courierState.heartbeatId = window.setInterval(() => {
    heartbeatCourierLocation();
  }, LOCATION_PUSH_MS);
  return true;
}

async function setCourierConnection(connected) {
  if (courierState.connectionBusy || !courierState.data?.courier) {
    syncConnectionSwitch();
    return;
  }

  courierState.connectionBusy = true;
  syncConnectionSwitch();

  try {
    if (connected) {
      setLocationStatus("Konum izni isteniyor...");
      const position = await getCurrentCourierPosition();
      const coords = {
        latitude: Number(position.coords.latitude.toFixed(6)),
        longitude: Number(position.coords.longitude.toFixed(6)),
      };
      courierState.lastCoords = coords;
      const data = await pushCourierLocation({ ...coords, available: true });
      startLocationWatch(coords);
      hydrateCourierWorkspace(data);
      setShiftGreetingStatus(true);
      showToast("Baglanti acildi. Konum ve vardiya aktif.", "success");
    } else {
      stopLocationWatch();
      const courier = courierState.data.courier;
      const coords = courierState.lastCoords || {
        latitude: courier.latitude,
        longitude: courier.longitude,
      };
      const data = await pushCourierLocation({ ...coords, available: false });
      hydrateCourierWorkspace(data);
      setShiftGreetingStatus(false);
      showToast("Baglanti kapatildi. Vardiya bitirildi.", "success");
    }
  } catch (error) {
    if (connected) {
      stopLocationWatch();
    } else if (courierState.data?.courier?.available) {
      startLocationWatch(courierState.lastCoords);
    }
    const message = error?.code === 1
      ? "Konum izni reddedildi. Baglanti acilamadi."
      : error.message || "Baglanti durumu degistirilemedi.";
    setLocationStatus(message);
    showToast(message, "error");
  } finally {
    courierState.connectionBusy = false;
    syncConnectionSwitch();
  }
}

async function loadCourierWorkspace(options = {}) {
  if (courierState.workspaceLoadPromise) {
    if (options.force) {
      courierState.queuedWorkspaceLoad = { ...(courierState.queuedWorkspaceLoad || {}), ...options };
    }
    return courierState.workspaceLoadPromise;
  }

  courierState.workspaceLoadPromise = doLoadCourierWorkspace(options)
    .finally(async () => {
      courierState.workspaceLoadPromise = null;
      const queuedOptions = courierState.queuedWorkspaceLoad;
      courierState.queuedWorkspaceLoad = null;
      if (queuedOptions) {
        await loadCourierWorkspace(queuedOptions);
      }
    });
  return courierState.workspaceLoadPromise;
}

async function doLoadCourierWorkspace(options = {}) {
  if (!courierState.token) {
    if (courierState.refreshToken) {
      try {
        await refreshCourierAccess();
      } catch {
        clearCourierAuth();
      }
    }
  }

  if (!courierState.token) {
    setLoggedIn(false);
    return;
  }

  const now = Date.now();
  if (options.silent && !options.force && now - courierState.lastWorkspaceLoadAt < 1500) {
    return;
  }
  courierState.lastWorkspaceLoadAt = now;

  try {
    const params = new URLSearchParams({
      limit: String(courierState.packageLimit),
      cursor: courierState.packageCursor || "0",
    });
    const data = await api(`/api/courier/me?${params.toString()}`, {
      headers: authHeaders(courierState.token),
      retryWithRefresh: refreshCourierAccess,
    });
    hydrateCourierWorkspace(data);
  } catch (error) {
    if (error.message.includes("Oturum") || error.message.includes("Kurye bulunamadi") || error.message.includes("refresh")) {
      clearCourierAuth();
      stopWorkspacePolling();
      setLoggedIn(false);
      if (!options.silent && courierRefs.summary) {
        courierRefs.summary.textContent = error.message;
      }
    }
    if (courierRefs.liveBadge) {
      courierRefs.liveBadge.textContent = "Bağlantı koptu, tekrar deneniyor...";
    }
  }
}

courierRefs.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const notificationPermission = requestNotificationPermission();
  try {
    const formData = new FormData(courierRefs.loginForm);
    const data = await api("/api/courier/login", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
      }),
    });
    persistCourierAuth(data);
    const workspace = await api("/api/courier/me", {
      headers: authHeaders(courierState.token),
      retryWithRefresh: refreshCourierAccess,
    });
    courierRefs.loginForm.reset();
    hydrateCourierWorkspace(workspace);
    await notificationPermission;
    initializeCourierPush();
  } catch (error) {
    showToast(error.message || "Giris basarisiz oldu.", "error");
  }
});

courierRefs.connectionSwitch?.addEventListener("change", async (event) => {
  await setCourierConnection(event.currentTarget.checked);
});

courierRefs.enablePushButton?.addEventListener("click", async () => {
  await initializeCourierPush({ requestPermission: true });
});

courierRefs.dayCloseButton?.addEventListener("click", async () => {
  if (!courierState.token) {
    return;
  }
  if (courierState.data?.dayMetrics?.hasClosedDay) {
    showToast("Bugunun gun sonu raporu daha once gonderildi.", "warning");
    return;
  }
  const data = await api("/api/courier/day-close", {
    method: "POST",
    headers: authHeaders(courierState.token),
    body: JSON.stringify({ courierNote: courierRefs.dayCloseNote?.value || "" }),
    retryWithRefresh: refreshCourierAccess,
  });
  hydrateCourierWorkspace(data);
  if (courierRefs.dayCloseNote) courierRefs.dayCloseNote.value = "";
  showToast(`Gun sonu raporu olustu. Toplam ciro ${formatCurrency(data.dayCloseReport?.totalAmount)}.`, "success");
});

courierRefs.logoutButton?.addEventListener("click", async () => {
  try {
    if (courierState.token) {
      await pushCourierLocation({
        available: false,
        latitude: courierState.data?.courier?.latitude,
        longitude: courierState.data?.courier?.longitude,
      });
    }
  } catch {
    // Logout should still continue even if the network write fails.
  }

  stopLocationWatch();
  stopWorkspacePolling();
  const pushEndpoint = await currentCourierPushEndpoint();
  if (courierState.refreshToken) {
    api("/api/courier/logout", {
      method: "POST",
      headers: authHeaders(courierState.token),
      body: JSON.stringify({ refreshToken: courierState.refreshToken, pushEndpoint }),
    }).catch(() => {
      // Local cleanup should still continue.
    });
  }
  clearCourierAuth();
  setLoggedIn(false);
  setShiftGreetingStatus(false);
  if (courierRefs.summary) {
    courierRefs.summary.textContent = "Cikis yapildi.";
  }
  if (courierRefs.liveBadge) {
    courierRefs.liveBadge.textContent = "Canli akis kapali";
  }
});

if (courierRefs.profileSettingsButton) {
  courierRefs.profileSettingsButton.addEventListener("click", () => {
    if (courierState.data?.courier) {
      courierRefs.profileForm.elements["username"].value = courierState.data.courier.username;
      courierRefs.profileForm.elements["password"].value = "";
    }
    courierRefs.profileModal?.showModal();
  });
}

if (courierRefs.profileModal) {
  courierRefs.profileModal.querySelector(".close-modal-btn").addEventListener("click", () => {
    courierRefs.profileModal.close();
  });
}

if (courierRefs.profileForm) {
  courierRefs.profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(courierRefs.profileForm);
    const payload = {
      username: formData.get("username"),
      password: formData.get("password"),
    };
    try {
      await api("/api/courier/me/credentials", {
        method: "PUT",
        headers: authHeaders(courierState.token),
        body: JSON.stringify(payload),
        retryWithRefresh: refreshCourierAccess,
      });
      courierRefs.profileModal.close();
      showToast("Profil basariyla guncellendi.");
      if (payload.username && courierState.data?.courier) {
        courierState.data.courier.username = payload.username;
      }
    } catch (err) {
      showToast(err.message || "Guncellenirken hata olustu", "error");
    }
  });
}

window.addEventListener("beforeunload", stopLocationWatch);
window.addEventListener("beforeunload", stopWorkspacePolling);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestScreenWakeLock();
    refreshCourierLocationNow();
  }
});

window.addEventListener("focus", refreshCourierLocationNow);
window.addEventListener("pageshow", refreshCourierLocationNow);
window.addEventListener("online", refreshCourierLocationNow);

readStoredCourierAuth();
setLoggedIn(Boolean(courierState.token || courierState.refreshToken));
loadCourierWorkspace();
