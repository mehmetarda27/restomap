(() => {
  "use strict";

  window.deliveraDesktop?.markBridgeReady?.();

  function migratedStorageKey(currentKey, legacyKey) {
    if (localStorage.getItem(currentKey) === null && localStorage.getItem(legacyKey) !== null) {
      localStorage.setItem(currentKey, localStorage.getItem(legacyKey));
    }
    return currentKey;
  }

  const TOKEN_KEY = migratedStorageKey("restomapRestaurantToken", "deliveraRestaurantToken");
  const REFRESH_KEY = migratedStorageKey("restomapRestaurantRefreshToken", "deliveraRestaurantRefreshToken");
  const ID_KEY = migratedStorageKey("restomapRestaurantId", "deliveraRestaurantId");
  const API_KEY = migratedStorageKey("restomapRestaurantApiKey", "deliveraRestaurantApiKey");
  const LEGACY_AUTH_KEYS = [
    "deliveraRestaurantToken",
    "deliveraRestaurantRefreshToken",
    "deliveraRestaurantId",
    "deliveraRestaurantApiKey",
  ];
  const SEEN_ORDER_ALERTS_KEY = migratedStorageKey("restomapRestaurantSeenOrderAlerts", "deliveraRestaurantSeenOrderAlerts");
  const KIOSK_MODE_KEY = migratedStorageKey("restomapRestaurantKioskMode", "deliveraRestaurantKioskMode");
  const KIOSK_PRINTED_ORDERS_KEY = migratedStorageKey("restomapRestaurantKioskPrintedOrders", "deliveraRestaurantKioskPrintedOrders");
  const PLATFORM_ATTENTION_ACK_KEY = migratedStorageKey("restomapRestaurantPlatformAttentionAcknowledged", "deliveraRestaurantPlatformAttentionAcknowledged");
  const INITIAL_ORDER_ALERT_WINDOW_MS = 30 * 60 * 1000;
  const terminalStatuses = new Set(["delivered", "failed", "rejected", "cancelled", "canceled"]);
  let pushInitialized = false;
  let orderAudioContext = null;
  const activeOrderOscillators = new Set();
  let orderReminderTimer = null;
  let platformAttentionTimer = null;
  let platformTitleTimer = null;
  let platformAttentionPackageId = "";
  const normalDocumentTitle = "Restoran Paneli | RESTOMAP";
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    refreshToken: localStorage.getItem(REFRESH_KEY) || "",
    data: null,
    filter: "all",
    search: "",
    stream: null,
    poll: null,
    map: null,
    mapLayer: null,
    mapHasFitted: false,
    mapPoll: null,
    mapRefreshTimer: null,
    mapRefreshBusy: false,
    mapUpdatedAt: null,
    platformAlerts: new Set(),
    panelData: {
      tables: [],
      categories: [],
      products: [],
      paymentTypes: ["Online ödendi", "Kapıda nakit", "Kapıda kart"],
      posSettings: { serviceFee: 0, taxRate: 10, autoAccept: false },
      generalSettings: { orderSound: true, autoPrint: false, defaultPrepMinutes: 20 },
      printerSettings: { paperSize: "80mm", copies: 1, header: "" },
    },
  };

  const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  const normalize = (value) => String(value || "").toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  const formatMoney = (value) => `${Number(value || 0).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;
  const time = (value) => value ? new Date(value).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "-";
  const dateTime = (value) => value ? new Date(value).toLocaleString("tr-TR") : "-";
  const ago = (value) => {
    if (!value) return "-";
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
    if (minutes < 1) return "şimdi";
    if (minutes < 60) return `${minutes} dk önce`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} sa önce` : `${Math.floor(hours / 24)} gün önce`;
  };

  const statusMap = {
    pending: ["Onay Bekliyor", "bg-amber-500"],
    pending_approval: ["Onay Bekliyor", "bg-amber-500"],
    preparing: ["Hazırlanıyor", "bg-red-500"],
    awaiting_assignment: ["Kurye Bekliyor", "bg-indigo-500"],
    assigned: ["Kurye Atandı", "bg-blue-500"],
    accepted_by_courier: ["Kurye Aldı", "bg-cyan-600"],
    on_route: ["Taşımada", "bg-violet-600"],
    delivered: ["Teslim Edildi", "bg-emerald-600"],
    failed: ["Teslim Edilemedi", "bg-rose-600"],
    rejected: ["Reddedildi", "bg-red-700"],
    cancelled: ["İptal Edildi", "bg-slate-500"],
    canceled: ["İptal Edildi", "bg-slate-500"],
  };
  const statusInfo = (status) => statusMap[String(status || "").toLowerCase()] || [String(status || "Bekliyor"), "bg-slate-500"];
  const sourceName = (pkg) => {
    if (pkg.sourcePlatform || pkg.platform) return pkg.sourcePlatform || pkg.platform;
    const source = String(pkg.source || "");
    return /yemek|sepet|getir|migros|trendyol/i.test(source) ? source : (source === "platform_manual" ? "Platform" : "Telefon");
  };
  const platformKey = (value) => {
    const text = normalize(value);
    const compact = text.replace(/[^a-z0-9]/g, "");
    if (["ty", "trendyol", "trendyolyemek"].includes(compact) || text.includes("trendyol")) return "trendyol";
    if (["gy", "getir", "getiryemek"].includes(compact) || text.includes("getir")) return "getir";
    if (["my", "migros", "migrosyemek"].includes(compact) || text.includes("migros")) return "migros";
    if (["ys", "yemeksepeti"].includes(compact) || text.includes("yemek sepet")) return "yemeksepeti";
    return "manual";
  };
  const platformLabels = {
    yemeksepeti: "Yemeksepeti",
    getir: "Getir",
    migros: "Migros",
    trendyol: "Trendyol",
    manual: "Telefon",
  };

  function kioskModeEnabled() {
    const requested = new URLSearchParams(location.search).get("kiosk") === "1";
    if (requested) localStorage.setItem(KIOSK_MODE_KEY, "1");
    return requested || localStorage.getItem(KIOSK_MODE_KEY) === "1";
  }

  function kioskPrintedOrders() {
    try {
      const values = JSON.parse(localStorage.getItem(KIOSK_PRINTED_ORDERS_KEY) || "[]");
      return new Set(Array.isArray(values) ? values.map(String) : []);
    } catch {
      return new Set();
    }
  }

  function rememberKioskPrintedOrder(packageId) {
    const values = [...kioskPrintedOrders(), String(packageId)].slice(-1000);
    localStorage.setItem(KIOSK_PRINTED_ORDERS_KEY, JSON.stringify(values));
  }

  function kioskPrintPackage(pkg) {
    if (!kioskModeEnabled() || window.deliveraDesktop?.autoPrintReceipt) return;
    const packageId = String(pkg.id || pkg.trackingNo || pkg.externalOrderNo || "").trim();
    if (!packageId || kioskPrintedOrders().has(packageId)) return;
    const settings = state.panelData.printerSettings || {};
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;width:1px;height:1px;right:0;bottom:0;border:0;opacity:0;pointer-events:none";
    frame.srcdoc = receiptDocument(pkg, false, settings.paperSize || "80mm", settings.copies || 1, true);
    document.body.appendChild(frame);
    rememberKioskPrintedOrder(packageId);
    window.setTimeout(() => frame.remove(), 15000);
  }

  async function api(path, options = {}, retry = true) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401 && retry && state.refreshToken) {
      const refreshed = await fetch("/api/restaurant/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      });
      if (refreshed.ok) {
        saveAuth(await refreshed.json());
        return api(path, options, false);
      }
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `İşlem başarısız (${response.status})`);
    return body;
  }

  function saveAuth(auth) {
    state.token = auth.token || "";
    state.refreshToken = auth.refreshToken || "";
    localStorage.setItem(TOKEN_KEY, state.token);
    localStorage.setItem(REFRESH_KEY, state.refreshToken);
    const restaurant = auth.state?.restaurants?.[0];
    if (restaurant?.id) localStorage.setItem(ID_KEY, restaurant.id);
    if (restaurant?.apiKey) localStorage.setItem(API_KEY, restaurant.apiKey);
  }

  function clearAuth() {
    state.token = "";
    state.refreshToken = "";
    [TOKEN_KEY, REFRESH_KEY, ID_KEY, API_KEY, ...LEGACY_AUTH_KEYS]
      .forEach((key) => localStorage.removeItem(key));
    state.stream?.close();
    clearInterval(state.poll);
  }

  function logout() {
    const token = state.token;
    const refreshToken = state.refreshToken;
    if (refreshToken) {
      fetch("/api/restaurant/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ refreshToken }),
        keepalive: true,
      }).catch(() => {
        // Ağ hatası yerel oturumun kapatılmasını engellememeli.
      });
    }
    clearAuth();
    location.reload();
  }

  async function loadPanelData() {
    const response = await api("/api/restaurant/panel-data");
    const incoming = response.data || {};
    state.panelData = {
      ...state.panelData,
      ...incoming,
      posSettings: { ...state.panelData.posSettings, ...(incoming.posSettings || {}) },
      generalSettings: { ...state.panelData.generalSettings, ...(incoming.generalSettings || {}) },
      printerSettings: { ...state.panelData.printerSettings, ...(incoming.printerSettings || {}) },
    };
    return state.panelData;
  }

  async function savePanelData(message = "Ayarlar kaydedildi.") {
    const response = await api("/api/restaurant/panel-data", { method: "PUT", body: JSON.stringify({ data: state.panelData }) });
    state.panelData = response.data;
    toast(message, "success");
    return state.panelData;
  }

  function injectShell() {
    document.title = "Restoran Paneli | RESTOMAP";
    const style = document.createElement("style");
    style.textContent = `
      html,body{height:100%;overflow:hidden} body{min-width:1024px}
      .zg-modal-root{position:fixed;inset:0;z-index:100;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:24px}
      .zg-modal{width:min(720px,96vw);max-height:90vh;overflow:auto;background:white;border-radius:14px;box-shadow:0 24px 70px rgba(15,23,42,.3)}
      .zg-modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #e2e8f0}
      .zg-modal-body{padding:20px}.zg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .zg-field{display:flex;flex-direction:column;gap:5px}.zg-field.full{grid-column:1/-1}.zg-field input,.zg-field select,.zg-field textarea{border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:14px}
      .zg-primary{background:#5a67d8;color:white;border-radius:8px;padding:10px 16px;font-weight:600}.zg-danger{background:#dc2626;color:white;border-radius:8px;padding:10px 16px;font-weight:600}
      .zg-toast{position:fixed;right:20px;bottom:20px;z-index:150;background:#0f172a;color:#fff;padding:12px 16px;border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.22)}
      .zg-toast.error{background:#b91c1c}.zg-toast.success{background:#047857}.zg-empty{padding:60px 20px;text-align:center;color:#64748b}
      .zg-map{height:calc(100vh - 155px);min-height:480px}.zg-list-row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #e2e8f0}
      .zg-map-shell{position:relative}.zg-map-summary{position:absolute;z-index:500;left:14px;top:14px;min-width:220px;max-width:310px;background:rgba(255,255,255,.96);border:1px solid #dbe4ee;border-radius:12px;padding:12px 14px;box-shadow:0 10px 28px rgba(15,23,42,.16)}
      .zg-map-legend{display:flex;gap:12px;margin-top:8px;font-size:11px;color:#64748b}.zg-dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:4px}.zg-map-live{color:#047857;font-weight:700}
      .zg-sidebar-active{background:#eff6ff!important;color:#2563eb!important;border-left-color:#2563eb!important}
      .zg-platform-alert{background:#fff7ed!important;box-shadow:inset 0 -3px 0 #f97316;animation:zgPlatformPulse 1.1s ease-in-out infinite}
      .zg-platform-alert span:nth-last-of-type(1){transform:scale(1.12);box-shadow:0 0 0 4px rgba(249,115,22,.18)}
      .zg-notification-button{position:relative;width:38px;height:38px;border:1px solid #dbe4ee;border-radius:9px;background:#fff;color:#325ecc;display:grid;place-items:center;margin-left:8px}.zg-notification-badge{position:absolute;right:-5px;top:-6px;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#dc2626;color:#fff;font-size:10px;font-weight:800;display:grid;place-items:center}
      @keyframes zgPlatformPulse{0%,100%{filter:brightness(1)}50%{filter:brightness(.94)}}
      .zg-platform-attention-root{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;background:rgba(2,6,23,.82);backdrop-filter:blur(7px);animation:zgAttentionBackdrop .9s ease-in-out infinite alternate}
      .zg-platform-attention{width:min(680px,96vw);overflow:hidden;border:4px solid #fb923c;border-radius:24px;background:#fff;box-shadow:0 0 0 10px rgba(249,115,22,.18),0 30px 90px rgba(0,0,0,.55);animation:zgAttentionCard .8s ease-in-out infinite alternate}
      .zg-platform-attention-head{padding:18px 24px;background:linear-gradient(135deg,#c2410c,#f97316);color:#fff;text-align:center;font-size:14px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}
      .zg-platform-attention-body{padding:30px;text-align:center}.zg-platform-attention-icon{width:78px;height:78px;margin:0 auto 18px;border-radius:999px;background:#fff7ed;color:#ea580c;display:grid;place-items:center;font-size:42px}
      .zg-platform-attention h2{margin:0;color:#0f172a;font-size:clamp(27px,4vw,42px);line-height:1.12;font-weight:900}.zg-platform-attention h2 strong{color:#ea580c}.zg-platform-attention-code{display:inline-flex;margin-top:18px;padding:8px 15px;border-radius:999px;background:#f1f5f9;color:#334155;font-weight:800}
      .zg-platform-attention-info{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:22px 0;text-align:left}.zg-platform-attention-info div{padding:13px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc}.zg-platform-attention-info small{display:block;color:#64748b;font-size:11px}.zg-platform-attention-info b{display:block;margin-top:3px;color:#0f172a;overflow-wrap:anywhere}
      .zg-platform-seen{width:100%;min-height:62px;border:0;border-radius:14px;background:#16a34a;color:#fff;font-size:22px;font-weight:900;box-shadow:0 10px 24px rgba(22,163,74,.25)}.zg-platform-seen:hover{background:#15803d}.zg-platform-attention-note{margin-top:12px;color:#64748b;font-size:12px}
      @keyframes zgAttentionBackdrop{from{background:rgba(2,6,23,.76)}to{background:rgba(67,20,7,.88)}}@keyframes zgAttentionCard{from{transform:scale(.985);border-color:#fb923c}to{transform:scale(1.01);border-color:#ef4444}}
      .zg-source{display:inline-flex;align-items:center;gap:5px;margin-top:4px;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:700;border:1px solid transparent}
      .zg-source-yemeksepeti{color:#b91c1c;background:#fef2f2;border-color:#fecaca}.zg-source-getir{color:#5b21b6;background:#f5f3ff;border-color:#ddd6fe}
      .zg-source-migros{color:#c2410c;background:#fff7ed;border-color:#fed7aa}.zg-source-trendyol{color:#c2410c;background:#fff7ed;border-color:#fdba74}
      .zg-source-manual{color:#334155;background:#f1f5f9;border-color:#cbd5e1}
      .zg-order-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch;gap:5px;width:168px;max-width:100%;min-width:0}
      .zg-order-action{min-height:32px;min-width:0;width:100%;display:inline-flex;align-items:center;justify-content:center;gap:3px;padding:5px 6px;border:1px solid transparent;border-radius:6px;font-size:10px;font-weight:700;line-height:1.05;white-space:normal;text-align:center;transition:background-color .15s,border-color .15s,transform .15s}
      .zg-order-action:hover{transform:translateY(-1px)}.zg-order-action i{display:none}.zg-order-action-print{color:#334155;background:#f1f5f9;border-color:#cbd5e1}.zg-order-action-time{color:#a16207;background:#fef3c7;border-color:#fcd34d}.zg-order-action-invoice{color:#7e22ce;background:#f3e8ff;border-color:#d8b4fe}
      .zg-order-action-status{color:#fff}.zg-order-detail{color:#94a3b8;transition:color .15s}.zg-order-detail:hover{color:#475569}
      .zg-print-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.zg-print-option{display:flex;min-height:108px;flex-direction:column;align-items:flex-start;justify-content:space-between;border:1px solid #cbd5e1;border-radius:12px;padding:14px;text-align:left;background:#fff;transition:border-color .15s,box-shadow .15s,transform .15s}.zg-print-option:hover{border-color:#2563eb;box-shadow:0 8px 22px rgba(37,99,235,.12);transform:translateY(-1px)}.zg-print-option.is-default{border-color:#2563eb;background:#eff6ff}.zg-print-option strong{font-size:16px;color:#0f172a}.zg-print-option span{font-size:12px;color:#64748b}.zg-print-default{display:flex;align-items:center;gap:8px;margin-top:14px;padding:11px 12px;border-radius:9px;background:#f8fafc;color:#475569;font-size:13px}
      .zg-report-controls{display:grid;grid-template-columns:1.1fr 1fr 1fr auto;gap:10px;align-items:end}.zg-report-controls label{display:flex;flex-direction:column;gap:5px;color:#475569;font-size:12px;font-weight:700}.zg-report-controls input,.zg-report-controls select{height:40px;border:1px solid #cbd5e1;border-radius:8px;padding:0 10px;background:#fff;color:#0f172a;font-size:13px}
      .zg-report-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}.zg-report-card{min-height:92px;border:1px solid #e2e8f0;border-radius:11px;padding:12px;background:#f8fafc;text-align:left}.zg-report-card span{display:block;color:#64748b;font-size:12px}.zg-report-card strong{display:block;margin-top:4px;color:#0f172a;font-size:21px}.zg-report-card small{display:block;margin-top:2px;color:#64748b;font-size:11px}.zg-report-card.is-blue{background:#eff6ff;border-color:#bfdbfe}.zg-report-card.is-green{background:#ecfdf5;border-color:#a7f3d0}.zg-report-card.is-red{background:#fef2f2;border-color:#fecaca}.zg-report-card.is-amber{background:#fffbeb;border-color:#fde68a}
      .zg-report-table{width:100%;border-collapse:collapse;font-size:12px}.zg-report-table th{position:sticky;top:0;background:#f8fafc;color:#64748b;text-align:left;padding:9px;border-bottom:1px solid #cbd5e1}.zg-report-table td{padding:9px;border-bottom:1px solid #e2e8f0;vertical-align:top}.zg-report-pill{display:inline-flex;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:800}.zg-report-history{display:flex;gap:8px;overflow:auto;padding:3px 0 7px}.zg-report-day{min-width:142px;border:1px solid #e2e8f0;border-radius:9px;padding:9px;background:white;text-align:left}.zg-report-day.is-selected{border-color:#2563eb;background:#eff6ff}.zg-report-day strong,.zg-report-day span{display:block}.zg-report-day span{margin-top:3px;color:#64748b;font-size:11px}
      tr[data-platform="yemeksepeti"]{border-left:3px solid #e3000f}tr[data-platform="getir"]{border-left:3px solid #5d3ebc}tr[data-platform="migros"]{border-left:3px solid #ff8a00}tr[data-platform="trendyol"]{border-left:3px solid #f27a1a}tr[data-platform="manual"]{border-left:3px solid #64748b}
      @media(max-width:1200px){aside{width:220px!important}header>div:first-child button{padding-left:.5rem!important;padding-right:.5rem!important}.zg-operator{display:none!important}.zg-report-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.zg-report-controls{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);

    const main = document.querySelector("main");
    const content = main?.querySelector(":scope > div.flex-1.overflow-auto");
    const tbody = content?.querySelector("tbody");
    if (content) content.id = "restaurantContent";
    if (tbody) {
      tbody.id = "restaurantOrders";
      tbody.innerHTML = '<tr><td colspan="8" class="zg-empty"><i class="ph ph-circle-notch ph-spin text-3xl block mb-2"></i>Siparişler yükleniyor...</td></tr>';
    }
    const search = main?.querySelector('input[placeholder*="Paket No"]');
    if (search) search.id = "restaurantSearch";
    const phoneButton = [...(main?.querySelectorAll("button") || [])].find((button) => normalize(button.textContent).includes("telefon siparişi ekle"));
    if (phoneButton) phoneButton.id = "addPhoneOrder";
    const sidebarLinks = [...document.querySelectorAll("aside a")];
    sidebarLinks.forEach((link) => { link.dataset.route = normalize(link.textContent); link.removeAttribute("href"); link.setAttribute("role", "button"); link.tabIndex = 0; });
    [...(main?.querySelectorAll("header button") || [])].forEach((button) => {
      const count = button.querySelector("span:nth-last-of-type(1)");
      if (count && /^\d+$/.test(count.textContent.trim())) count.textContent = "0";
    });
    [...(main?.querySelectorAll(".divide-x > div") || [])].slice(0, 5).forEach((box) => {
      const count = box.querySelector(".font-bold");
      if (count) count.textContent = "0";
    });
    const headerActions = main?.querySelector("header > div:last-child") || main?.querySelector("header");
    const notificationButton = document.createElement("button");
    notificationButton.type = "button";
    notificationButton.id = "restaurantEnablePushButton";
    notificationButton.className = "zg-notification-button";
    notificationButton.title = "Bildirim merkezi";
    notificationButton.setAttribute("aria-label", "Bildirim Merkezi");
    notificationButton.innerHTML = '<i class="ph ph-bell text-lg"></i><span class="zg-notification-badge" hidden>0</span>';
    headerActions?.appendChild(notificationButton);
    return { main, content, tbody, search, phoneButton, sidebarLinks, notificationButton };
  }

  const refs = injectShell();

  function toast(message, tone = "") {
    document.querySelector(".zg-toast")?.remove();
    const element = document.createElement("div");
    element.className = `zg-toast ${tone}`;
    element.textContent = message;
    document.body.appendChild(element);
    setTimeout(() => element.remove(), 3500);
  }

  function notificationPermission() {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  }

  function pushApplicationServerKey(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const raw = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  }

  async function initializeRestaurantPush(requestPermission = false) {
    if (pushInitialized) return true;
    if (!state.token || !("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return false;
    let permission = Notification.permission;
    if (requestPermission && permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") return false;
    try {
      const registration = await navigator.serviceWorker.register("/courier-push-sw.js?v=20260814-1", { scope: "/" });
      await registration.update().catch(() => {});
      const keyResponse = await api("/api/restaurant/push/public-key");
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushApplicationServerKey(keyResponse.publicKey) });
      await api("/api/restaurant/push/subscriptions", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
      pushInitialized = true;
      return true;
    } catch (error) {
      if (requestPermission) toast(error.message || "Bildirimler etkinleştirilemedi.", "error");
      return false;
    }
  }

  function unlockOrderAudio() {
    try {
      orderAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (orderAudioContext.state === "suspended") orderAudioContext.resume().catch(() => {});
    } catch {}
  }

  function stopActiveOrderSignal() {
    activeOrderOscillators.forEach((oscillator) => {
      try { oscillator.stop(); } catch {}
      try { oscillator.disconnect(); } catch {}
    });
    activeOrderOscillators.clear();
  }

  function playOrderSignal() {
    if (state.panelData.generalSettings?.orderSound === false) return;
    try {
      unlockOrderAudio();
      if (orderAudioContext.state !== "running") return;
      stopActiveOrderSignal();
      [880, 1175, 880, 1175, 1320, 1175, 880, 1175].forEach((frequency, index) => {
        const oscillator = orderAudioContext.createOscillator();
        const gain = orderAudioContext.createGain();
        const start = orderAudioContext.currentTime + index * 0.32;
        const stop = start + 0.28;
        oscillator.type = "square";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.38, start + 0.02);
        gain.gain.setValueAtTime(0.38, stop - 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, stop);
        oscillator.connect(gain).connect(orderAudioContext.destination);
        oscillator.onended = () => activeOrderOscillators.delete(oscillator);
        activeOrderOscillators.add(oscillator);
        oscillator.start(start);
        oscillator.stop(stop);
      });
    } catch {}
  }

  function seenOrderAlerts() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SEEN_ORDER_ALERTS_KEY) || "[]");
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return new Set();
    }
  }

  function orderAlertId(pkg) {
    return String(pkg?.id || pkg?.trackingNo || pkg?.externalOrderNo || "").trim();
  }

  function rememberOrderAlerts(packagesToRemember) {
    const seen = seenOrderAlerts();
    packagesToRemember.forEach((pkg) => {
      const id = orderAlertId(pkg);
      if (id) seen.add(id);
    });
    localStorage.setItem(SEEN_ORDER_ALERTS_KEY, JSON.stringify([...seen].slice(-500)));
  }

  function isRecentOrder(pkg) {
    const createdAt = new Date(pkg?.createdAt || pkg?.updatedAt || 0).getTime();
    return Number.isFinite(createdAt) && createdAt > 0 && Date.now() - createdAt <= INITIAL_ORDER_ALERT_WINDOW_MS;
  }

  function showNotificationCenter() {
    const notifications = state.data?.notifications || [];
    modal("Bildirim Merkezi", notifications.length ? notifications.map((item) => `<div class="zg-list-row"><div><b>${safe(item.message || item.title || "Bildirim")}</b><div class="text-xs text-slate-500">${dateTime(item.createdAt)}</div></div></div>`).join("") : '<div class="zg-empty">Henüz bildirim yok.</div>');
  }

  function modal(title, html, onMount) {
    document.querySelector(".zg-modal-root")?.remove();
    const root = document.createElement("div");
    root.className = "zg-modal-root";
    root.innerHTML = `<section class="zg-modal" role="dialog" aria-modal="true"><div class="zg-modal-head"><h2 class="font-bold text-xl text-slate-800">${safe(title)}</h2><button data-close class="text-2xl text-slate-500" aria-label="Kapat">×</button></div><div class="zg-modal-body">${html}</div></section>`;
    root.addEventListener("click", (event) => { if (event.target === root || event.target.closest("[data-close]")) root.remove(); });
    document.body.appendChild(root);
    onMount?.(root);
    return root;
  }

  function showLogin(message = "Restoran paneline giriş yapın.") {
    window.RestomapLoginShell.show({
      title: "Restoran Girişi",
      description: message,
      fields: `<label class="delivera-auth-field full"><span>Kullanıcı adı</span><input name="username" autocomplete="username"></label><label class="delivera-auth-field full"><span>Parola</span><input name="password" type="password" autocomplete="current-password"></label><div class="delivera-auth-separator">veya API erişimi</div><label class="delivera-auth-field"><span>Restoran ID</span><input name="restaurantId"></label><label class="delivera-auth-field"><span>API key</span><input name="apiKey" type="password"></label>`,
      onSubmit: async (form) => {
        unlockOrderAudio();
        const notificationRequest = notificationPermission() === "default"
          ? Promise.resolve(Notification.requestPermission()).catch(() => "default")
          : Promise.resolve(notificationPermission());
        const restaurantId = String(form.get("restaurantId") || "").trim();
        const apiKey = String(form.get("apiKey") || "").trim();
        const auth = await api("/api/restaurant/session", {
          method: "POST",
          headers: restaurantId && apiKey ? { "x-restaurant-id": restaurantId, "x-api-key": apiKey } : {},
          body: JSON.stringify(restaurantId && apiKey ? { restaurantId, apiKey } : { username: form.get("username"), password: form.get("password") }),
        }, false);
        saveAuth(auth);
        window.RestomapLoginShell.hide();
        hydrate(auth.state);
        await loadPanelData();
        await notificationRequest;
        await initializeRestaurantPush(false);
        connectStream();
        startPolling();
        toast("Restoran paneli açıldı.", "success");
      },
    });
  }

  function packages() { return state.data?.packages || []; }
  const localDateKey = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value || "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const packageOperationalDate = (pkg) => localDateKey(pkg.deliveredAt || pkg.failedAt || pkg.updatedAt || pkg.createdAt);
  const operationalPackages = () => packages().filter((pkg) => !terminalStatuses.has(pkg.status) || packageOperationalDate(pkg) === localDateKey());
  function currentPackages() {
    return operationalPackages().filter((pkg) => {
      const haystack = normalize([pkg.trackingNo, pkg.externalOrderNo, pkg.customerName, pkg.phone, pkg.deliveryAddress].join(" "));
      if (state.search && !haystack.includes(normalize(state.search))) return false;
      if (state.filter === "active" && terminalStatuses.has(pkg.status)) return false;
      if (state.filter === "delivered" && pkg.status !== "delivered") return false;
      if (state.filter === "cancelled" && !["failed", "rejected", "cancelled", "canceled"].includes(pkg.status)) return false;
      if (!["all", "active", "delivered", "cancelled"].includes(state.filter) && platformKey(sourceName(pkg)) !== state.filter) return false;
      return true;
    });
  }

  function row(pkg) {
    const [label, color] = statusInfo(pkg.status);
    const courier = (state.data?.couriers || []).find((item) => item.id === pkg.assignedCourierId);
    const pending = ["pending", "pending_approval"].includes(pkg.status);
    const code = pkg.trackingNo || pkg.externalOrderNo || pkg.id;
    const sourceKey = platformKey(sourceName(pkg));
    const sourceLabel = platformLabels[sourceKey] || sourceName(pkg);
    return `<tr class="table-row-hover transition-colors" data-package-id="${safe(pkg.id)}" data-platform="${sourceKey}">
      <td class="px-4 py-4 whitespace-nowrap"><div class="flex items-center space-x-2"><div class="w-6 h-6 rounded flex items-center justify-center zg-source-${sourceKey}"><i class="ph ph-package"></i></div><div><span class="font-bold text-slate-900">${safe(code)}</span><div class="zg-source zg-source-${sourceKey}">${safe(sourceLabel)}</div></div></div></td>
      <td class="px-4 py-4"><div class="flex flex-col"><span class="font-semibold text-slate-800">${safe(pkg.customerName || "Müşteri")} <span class="font-normal text-slate-500">- ${safe(pkg.phone || "Telefon yok")}</span></span><span class="text-xs text-slate-500 mt-0.5 max-w-xs truncate" title="${safe(pkg.deliveryAddress)}">${safe(pkg.deliveryAddress || "Adres yok")}</span></div></td>
      <td class="px-4 py-4 whitespace-nowrap"><div class="flex flex-col items-start space-y-1"><span class="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 text-red-600 border border-red-100">${safe(pkg.paymentMethod || "Belirtilmedi")}</span><span class="inline-flex px-2 py-0.5 rounded text-xs font-bold bg-emerald-50 text-emerald-600 border border-emerald-100">${formatMoney(pkg.orderAmount)}</span></div></td>
      <td class="px-4 py-4 whitespace-nowrap"><div class="flex flex-col"><span class="font-semibold text-slate-800">${time(pkg.createdAt)}</span><span class="text-xs text-slate-500">(${ago(pkg.createdAt)})</span></div></td>
      <td class="px-4 py-4 whitespace-nowrap text-xs text-slate-500"><div class="flex flex-col space-y-0.5"><div>Atanma: <span class="font-medium">${time(pkg.assignedAt)}</span></div><div>Teslim Alma: <span class="font-medium">${time(pkg.pickedUpAt || pkg.onRouteAt)}</span></div></div></td>
      <td class="px-4 py-4 whitespace-nowrap">${courier ? `<span class="font-medium text-slate-700">${safe(courier.name || courier.fullName || courier.id)}</span>` : '<span class="text-slate-500 italic text-sm">Atanmadı</span>'}</td>
      <td class="px-4 py-4 whitespace-nowrap"><div class="zg-order-actions"><button data-action="print" class="zg-order-action zg-order-action-print" title="Sipariş fişini yazdır" aria-label="Sipariş fişini yazdır"><i class="ph ph-printer"></i><span>Yazdır</span></button><button data-action="schedule" class="zg-order-action zg-order-action-time" title="Siparişin zaman akışını göster" aria-label="Sipariş zaman akışını göster"><i class="ph ph-calendar-blank"></i><span>Zaman</span></button><button data-action="detail" class="zg-order-action zg-order-action-invoice" title="Sipariş içeriğini ve müşteri bilgilerini göster" aria-label="Sipariş detayını görüntüle"><i class="ph ph-clipboard-text"></i><span>Sipariş Detayı</span></button>${pending ? `<button data-action="confirm" class="zg-order-action bg-emerald-600 text-white">Onayla</button><button data-action="reject" class="zg-order-action bg-red-600 text-white">Reddet</button>` : `<button data-action="detail" class="zg-order-action zg-order-action-status ${color}" title="Sipariş durumunu ve detaylarını göster"><span>${safe(label)}</span><i class="ph ph-caret-right"></i></button>`}</div></td>
      <td class="px-4 py-4 whitespace-nowrap text-center"><button data-action="detail" class="zg-order-detail" title="Sipariş içeriğini ve müşteri notunu göster" aria-label="Sipariş detayını görüntüle"><i class="ph ph-clipboard-text text-2xl"></i></button></td>
    </tr>`;
  }

  function renderOrders() {
    if (!refs.tbody || !state.data) return;
    const list = currentPackages();
    refs.tbody.innerHTML = list.length ? list.map(row).join("") : `<tr><td colspan="8" class="zg-empty"><i class="ph ph-package text-4xl block mb-2"></i>Bu filtrede sipariş bulunamadı.</td></tr>`;
  }

  function updateCounters() {
    const main = refs.main;
    const daily = operationalPackages();
    const active = daily.filter((pkg) => !terminalStatuses.has(pkg.status));
    const counterBoxes = [...(main?.querySelectorAll(".divide-x > div") || [])];
    const values = [daily.length, active.filter((p) => ["pending", "pending_approval", "preparing", "awaiting_assignment"].includes(p.status)).length, active.filter((p) => p.status === "assigned").length, active.filter((p) => ["accepted_by_courier", "on_route"].includes(p.status)).length, active.filter((p) => !p.assignedCourierId).length];
    counterBoxes.slice(0, 5).forEach((box, index) => { const target = box.querySelector(".font-bold"); if (target) target.textContent = values[index]; });
    const topButtons = [...(main?.querySelectorAll("header button") || [])];
    topButtons.forEach((button) => {
      const text = normalize(button.textContent);
      const key = text.includes("yemeksepeti") ? "yemeksepeti" : text.includes("getir") ? "getir" : text.includes("migros") ? "migros" : text.includes("trendyol") ? "trendyol" : text.includes("tüm siparişler") ? "all" : "";
      if (!key) return;
      const badge = button.querySelector("span:nth-last-of-type(1)");
      const count = key === "all" ? daily.length : active.filter((pkg) => platformKey(sourceName(pkg)) === key).length;
      if (badge) {
        badge.textContent = count;
        badge.setAttribute("aria-label", key === "all" ? `Tüm siparişler: ${count} toplam sipariş` : `${platformLabels[key]}: ${count} aktif sipariş`);
      }
      button.classList.toggle("zg-platform-alert", state.platformAlerts.has(key));
      button.title = key === "all" ? `Bugün ve açık siparişler: ${daily.length}` : `${platformLabels[key]}: ${count} aktif sipariş`;
      button.dataset.filter = key;
    });
  }

  function announceNewPackages(incoming, options = {}) {
    const groups = new Map();
    incoming.filter((pkg) => !terminalStatuses.has(pkg.status)).forEach((pkg) => {
      const key = platformKey(sourceName(pkg));
      const list = groups.get(key) || [];
      list.push(pkg);
      groups.set(key, list);
      state.platformAlerts.add(key);
    });
    groups.forEach((items, key) => {
      const label = platformLabels[key] || "Platform";
      toast(`${label}'den ${items.length} yeni sipariş geldi.`, "success");
    });
    if (groups.size) {
      playOrderSignal();
      window.clearTimeout(orderReminderTimer);
      orderReminderTimer = window.setTimeout(() => {
        playOrderSignal();
        navigator.vibrate?.([250, 100, 500]);
        orderReminderTimer = null;
      }, 10 * 1000);
      navigator.vibrate?.([250, 100, 500]);
      window.deliveraDesktop?.showNotification?.({
        title: "RESTOMAP - Yeni Sipariş",
        body: `${incoming.length} yeni sipariş geldi. Fiş varsayılan yazıcıya gönderiliyor.`,
      }).catch(() => {});
      if (window.deliveraDesktop?.autoPrintReceipt) {
        const settings = state.panelData.printerSettings || {};
        incoming.filter((pkg) => !terminalStatuses.has(pkg.status)).forEach((pkg) => {
          const packageId = String(pkg.id || pkg.trackingNo || pkg.externalOrderNo || "").trim();
          if (!packageId) return;
          window.deliveraDesktop.autoPrintReceipt({
            packageId,
            trackingNo: pkg.trackingNo || pkg.externalOrderNo || packageId,
            customerName: pkg.customerName || "Müşteri",
            html: receiptDocument(pkg, false, settings.paperSize || "80mm", settings.copies || 1, false),
          }).catch(() => {});
        });
      }
      if (options.allowKioskPrint !== false) {
        incoming.filter((pkg) => !terminalStatuses.has(pkg.status)).forEach(kioskPrintPackage);
      }
      if (!window.deliveraDesktop && !pushInitialized && notificationPermission() === "granted") {
        navigator.serviceWorker?.getRegistration("/").then((registration) => registration?.showNotification("RESTOMAP - Yeni Sipariş", {
          body: `${incoming.length} yeni sipariş geldi.`, tag: "delivera-restaurant-orders", renotify: true, requireInteraction: true,
          vibrate: [250, 100, 500], data: { url: "/restaurant-panel" },
        })).catch(() => {});
      }
    }
  }

  function acknowledgedPlatformAlerts() {
    try {
      const values = JSON.parse(localStorage.getItem(PLATFORM_ATTENTION_ACK_KEY) || "[]");
      return new Set(Array.isArray(values) ? values.map(String) : []);
    } catch {
      return new Set();
    }
  }

  function platformAttentionId(pkg) {
    return String(pkg?.id || pkg?.trackingNo || pkg?.externalOrderNo || "").trim();
  }

  function rememberPlatformAlertSeen(packageId) {
    const values = [...acknowledgedPlatformAlerts(), String(packageId)].slice(-1500);
    localStorage.setItem(PLATFORM_ATTENTION_ACK_KEY, JSON.stringify(values));
  }

  function stopPlatformAttention() {
    window.clearTimeout(platformAttentionTimer);
    window.clearInterval(platformTitleTimer);
    window.clearTimeout(orderReminderTimer);
    platformAttentionTimer = null;
    platformTitleTimer = null;
    orderReminderTimer = null;
    platformAttentionPackageId = "";
    stopActiveOrderSignal();
    document.title = normalDocumentTitle;
    document.querySelector(".zg-platform-attention-root")?.remove();
  }

  function platformOrdersWaitingForAttention(packagesToCheck = packages()) {
    const acknowledged = acknowledgedPlatformAlerts();
    return packagesToCheck.filter((pkg) => {
      const id = platformAttentionId(pkg);
      return id && !acknowledged.has(id) && !terminalStatuses.has(String(pkg.status || "").toLowerCase()) && platformKey(sourceName(pkg)) !== "manual";
    }).sort((left, right) => new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime());
  }

  function showPlatformAttention(pkg) {
    const packageId = platformAttentionId(pkg);
    if (!packageId || platformAttentionPackageId === packageId) return;
    stopPlatformAttention();
    platformAttentionPackageId = packageId;
    const key = platformKey(sourceName(pkg));
    const platform = platformLabels[key] || sourceName(pkg) || "Platform";
    const root = document.createElement("section");
    root.className = "zg-platform-attention-root";
    root.setAttribute("role", "alertdialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-live", "assertive");
    root.innerHTML = `<div class="zg-platform-attention"><div class="zg-platform-attention-head">Yeni platform siparişi</div><div class="zg-platform-attention-body"><div class="zg-platform-attention-icon"><i class="ph ph-bell-ringing"></i></div><h2>Merhaba, <strong>${safe(platform)}</strong>'dan yeni siparişiniz var!</h2><div class="zg-platform-attention-code">${safe(pkg.trackingNo || pkg.externalOrderNo || packageId)}</div><div class="zg-platform-attention-info"><div><small>Müşteri</small><b>${safe(pkg.customerName || "Müşteri")}</b></div><div><small>Sipariş tutarı</small><b>${safe(formatMoney(pkg.orderAmount))}</b></div></div><button type="button" class="zg-platform-seen" data-platform-seen>Gördüm</button><p class="zg-platform-attention-note">Bu düğme yalnızca uyarıyı kapatır; sipariş durumunu değiştirmez.</p></div></div>`;
    root.querySelector("[data-platform-seen]").addEventListener("click", () => {
      rememberPlatformAlertSeen(packageId);
      stopPlatformAttention();
      syncPlatformAttention();
    });
    document.body.appendChild(root);
    let titleVisible = false;
    const signal = () => { playOrderSignal(); navigator.vibrate?.([500, 150, 500, 150, 900]); };
    const repeatSignal = () => {
      if (!platformAttentionPackageId) return;
      signal();
      platformAttentionTimer = window.setTimeout(repeatSignal, 3500);
    };
    signal();
    platformAttentionTimer = window.setTimeout(repeatSignal, 3500);
    platformTitleTimer = window.setInterval(() => {
      titleVisible = !titleVisible;
      document.title = titleVisible ? `🔔 YENİ ${platform.toLocaleUpperCase("tr-TR")} SİPARİŞİ` : normalDocumentTitle;
    }, 700);
  }

  function syncPlatformAttention(packagesToCheck = packages()) {
    const waiting = platformOrdersWaitingForAttention(packagesToCheck);
    const currentStillWaiting = waiting.find((pkg) => platformAttentionId(pkg) === platformAttentionPackageId);
    if (currentStillWaiting) return;
    stopPlatformAttention();
    if (waiting[0]) showPlatformAttention(waiting[0]);
  }

  function updateBusiness() {
    const restaurant = state.data?.restaurants?.[0];
    if (!restaurant) return;
    const footer = document.querySelector("aside > div:last-child .bg-blue-50");
    if (footer) footer.textContent = restaurant.name || "Restoran";
    const operator = [...document.querySelectorAll("span")].find((span) => normalize(span.textContent) === "ali öksüz");
    if (operator) operator.textContent = restaurant.contactName || restaurant.ownerName || restaurant.name;
    const operatorBox = operator?.closest("div.flex.items-center");
    operatorBox?.classList.add("zg-operator");
  }

  function hydrate(data) {
    const hadData = Boolean(state.data);
    const previousIds = new Set((state.data?.packages || []).map((pkg) => pkg.id));
    const seen = seenOrderAlerts();
    const incoming = (data.packages || []).filter((pkg) => {
      const id = orderAlertId(pkg);
      if (!id || terminalStatuses.has(pkg.status) || seen.has(id)) return false;
      return hadData ? !previousIds.has(pkg.id) : isRecentOrder(pkg);
    });
    state.data = data;
    if (incoming.length) announceNewPackages(incoming, { allowKioskPrint: hadData });
    rememberOrderAlerts(data.packages || []);
    syncPlatformAttention(data.packages || []);
    updateBusiness(); updateCounters(); renderOrders();
    const badge = refs.notificationButton?.querySelector(".zg-notification-badge");
    if (badge) { badge.textContent = String((data.notifications || []).length); badge.hidden = !(data.notifications || []).length; }
    updateRestaurantCourierMap(false);
  }

  async function load(silent = false) {
    try {
      const [bootstrapData] = await Promise.all([
        api("/api/restaurant/bootstrap?limit=250&cursor=0"),
        loadPanelData(),
      ]);
      hydrate(bootstrapData);
    }
    catch (error) { if (!silent) { clearAuth(); showLogin(error.message); } }
  }

  function startPolling() {
    clearInterval(state.poll);
    state.poll = setInterval(() => load(true), 12000);
  }

  function connectStream() {
    state.stream?.close();
    if (!state.token) return;
    state.stream = new EventSource(`/api/restaurant/stream?token=${encodeURIComponent(state.token)}`);
    const handleEvent = (messageEvent) => {
      try {
        const event = JSON.parse(messageEvent.data || "{}");
        if (event?.type === "courier-location" && event.courierId && state.data?.couriers) {
          const courier = state.data.couriers.find((item) => item.id === event.courierId);
          const latitude = Number(event.latitude);
          const longitude = Number(event.longitude);
          if (courier && Number.isFinite(latitude) && Number.isFinite(longitude)) {
            courier.latitude = latitude;
            courier.longitude = longitude;
            courier.lastLocationAt = event.at || event.createdAt || new Date().toISOString();
            updateRestaurantCourierMap(false);
          }
        }
        if (event?.message && !["courier-location", "heartbeat", "ping"].includes(event.type)) toast(event.message);
      } catch {}
      if (state.map) scheduleRestaurantMapRefresh();
      if (messageEvent.type !== "courier-location" && messageEvent.type !== "ping") load(true);
    };
    state.stream.onmessage = handleEvent;
    ["package-created", "platform-order-pending", "integration-order", "order:new", "package-assigned", "assignment-waiting", "package-status", "courier-location", "courier-availability", "restaurant-confirmed", "restaurant-push-test", "workspace-update", "restaurant-accounting-update"].forEach((type) => state.stream.addEventListener(type, handleEvent));
    state.stream.onerror = () => { state.stream?.close(); state.stream = null; setTimeout(connectStream, 2500); };
  }

  function detailModal(pkg) {
    const courier = (state.data?.couriers || []).find((item) => item.id === pkg.assignedCourierId);
    const [label] = statusInfo(pkg.status);
    const items = orderItems(pkg);
    const itemRows = items.map((item) => {
      const amount = item.lineTotal === null ? "" : formatMoney(item.lineTotal);
      return `<div class="zg-list-row" data-order-item><div><b>${safe(item.quantity)}× ${safe(item.name)}</b>${item.details.length ? `<div class="text-xs text-slate-500 mt-1">${safe(item.details.join(" · "))}</div>` : ""}</div>${amount ? `<strong>${safe(amount)}</strong>` : ""}</div>`;
    }).join("");
    const products = itemRows || '<div class="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Ürün bilgisi platformdan gelmedi.</div>';
    modal(`Sipariş Detayı · ${pkg.trackingNo || pkg.externalOrderNo || pkg.id}`, `<div class="space-y-4 text-sm"><section><div class="flex items-center justify-between mb-2"><h3 class="font-bold text-base">Sipariş İçeriği</h3><span class="text-xs text-slate-500">${items.length ? `${items.length} kalem` : "Bilgi yok"}</span></div><div class="rounded-lg border overflow-hidden" data-order-items>${products}</div></section><section><h3 class="font-bold text-base mb-2">Teslimat Bilgileri</h3><div class="space-y-1"><div class="zg-list-row"><b>Durum</b><span>${safe(label)}</span></div><div class="zg-list-row"><b>Müşteri</b><span>${safe(pkg.customerName || "-")}</span></div><div class="zg-list-row"><b>Telefon</b><a class="text-blue-600" href="tel:${safe(pkg.phone)}">${safe(pkg.phone || "-")}</a></div><div class="zg-list-row"><b>Adres</b><span class="text-right max-w-md">${safe(pkg.deliveryAddress || "-")}</span></div><div class="zg-list-row"><b>Müşteri notu</b><span>${safe(pkg.customerNote || "-")}</span></div><div class="zg-list-row"><b>Ödeme</b><span>${safe(pkg.paymentMethod || "-")} · ${formatMoney(pkg.orderAmount)}</span></div><div class="zg-list-row"><b>Kurye</b><span>${safe(courier?.name || courier?.fullName || "Atanmadı")}</span></div><div class="zg-list-row"><b>Oluşturulma</b><span>${dateTime(pkg.createdAt)}</span></div></div></section></div>`);
  }

  function normalizedPaperSize(value) {
    const size = String(value || "80mm").toUpperCase();
    return size === "58MM" ? "58mm" : size === "A4" ? "A4" : "80mm";
  }

  function localizedItemText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return String(value).trim();
    return String(value.tr || value.en || value.default || value.text || value.name || Object.values(value).find((entry) => typeof entry === "string") || "").trim();
  }

  function orderItems(pkg) {
    const raw = pkg?.rawPayload && typeof pkg.rawPayload === "object" ? pkg.rawPayload : {};
    const candidates = [pkg?.items, raw.items, raw.products, raw.lines, raw.order?.items, raw.order?.products, raw.data?.items, raw.data?.products];
    const source = candidates.find((candidate) => Array.isArray(candidate) && candidate.length) || [];
    const choiceNames = (value) => (Array.isArray(value) ? value : [])
      .map((choice) => localizedItemText(choice?.name ?? choice?.title ?? choice))
      .filter(Boolean);
    return source.map((item, index) => {
      const entry = item && typeof item === "object" ? item : { name: item };
      const name = localizedItemText(entry.name ?? entry.productName ?? entry.title ?? entry.product) || `Ürün ${index + 1}`;
      const quantity = Math.max(1, Number(entry.quantity ?? entry.qty ?? entry.count ?? 1) || 1);
      const unitValue = entry.unitPrice ?? entry.unit_price ?? entry.price;
      const totalValue = entry.total ?? entry.totalPrice ?? entry.total_price ?? entry.priceWithOption ?? entry.price_with_option;
      const unitPrice = unitValue === null || unitValue === undefined || unitValue === "" ? null : Number(unitValue);
      const explicitTotal = totalValue === null || totalValue === undefined || totalValue === "" ? null : Number(totalValue);
      const lineTotal = Number.isFinite(explicitTotal) ? explicitTotal : Number.isFinite(unitPrice) ? unitPrice * quantity : null;
      const extras = choiceNames(entry.extraIngredients ?? entry.extra_ingredients ?? entry.extras ?? entry.options ?? entry.modifiers);
      const removed = choiceNames(entry.removedIngredients ?? entry.removed_ingredients);
      const note = localizedItemText(entry.note ?? entry.description);
      return {
        name,
        quantity,
        unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
        lineTotal: Number.isFinite(lineTotal) ? lineTotal : null,
        details: [extras.length ? `Ekstra: ${extras.join(", ")}` : "", removed.length ? `Çıkarılan: ${removed.join(", ")}` : "", note ? `Not: ${note}` : ""].filter(Boolean),
      };
    });
  }

  function receiptItemsHtml(pkg) {
    const items = orderItems(pkg);
    if (!items.length) {
      return `<section class="items"><div class="items-title">SİPARİŞ İÇERİĞİ</div><div class="items-empty">${safe(pkg.packageType || "Ürün bilgisi platformdan gelmedi.")}</div></section>`;
    }
    return `<section class="items"><div class="items-title">SİPARİŞ İÇERİĞİ</div><div class="items-head"><b>Adet / Ürün</b><b>Tutar</b></div>${items.map((item) => `<div class="item"><div><strong>${safe(item.quantity)}× ${safe(item.name)}</strong>${item.unitPrice !== null ? `<small>Birim: ${safe(formatMoney(item.unitPrice))}</small>` : ""}${item.details.map((detail) => `<small>${safe(detail)}</small>`).join("")}</div><b>${item.lineTotal === null ? "-" : safe(formatMoney(item.lineTotal))}</b></div>`).join("")}</section>`;
  }

  function receiptDocument(pkg, invoice, paperSize, copies, invokeBrowserPrint = true) {
    const size = normalizedPaperSize(paperSize);
    const thermal = size !== "A4";
    const pageWidth = size === "58mm" ? "58mm" : size === "80mm" ? "80mm" : "A4";
    const contentWidth = size === "58mm" ? "54mm" : size === "80mm" ? "76mm" : "186mm";
    const restaurant = state.data?.restaurants?.[0] || {};
    const customHeader = String(state.panelData.printerSettings?.header || "").trim();
    const receiptCount = Math.max(1, Math.min(5, Number(copies) || 1));
    const receipt = (copyNumber) => `<article class="receipt${copyNumber < receiptCount ? " page-break" : ""}">
      <header class="brand"><div class="checkers">■ □ ■ □ ■ □ ■ □ ■ □</div><div class="brand-name">RESTOMAP</div><div class="brand-tagline">Tamamı Paket Takip Sistemi</div><div class="checkers">□ ■ □ ■ □ ■ □ ■ □ ■</div></header>
      ${customHeader ? `<div class="custom-header">${safe(customHeader)}</div>` : ""}
      <section class="restaurant"><h1>${safe(restaurant.name || "Restoran")}</h1><div>${invoice ? "FATURALI SİPARİŞ FİŞİ" : "SİPARİŞ / TESLİMAT FİŞİ"}</div></section>
      <div class="tracking"><small>PAKET NUMARASI</small><strong>${safe(pkg.trackingNo || pkg.externalOrderNo || pkg.id)}</strong></div>
      <section class="rows">
        <div class="row"><b>Tarih</b><span>${dateTime(pkg.createdAt)}</span></div>
        <div class="row"><b>Sipariş kaynağı</b><span>${safe(sourceName(pkg))}</span></div>
        <div class="row"><b>Müşteri</b><span>${safe(pkg.customerName || "-")}</span></div>
        <div class="row"><b>Telefon</b><span>${safe(pkg.phone || "-")}</span></div>
        <div class="row total"><b>Ödeme / Tutar</b><span>${safe(pkg.paymentMethod || "-")}<br><strong>${formatMoney(pkg.orderAmount)}</strong></span></div>
      </section>
      ${receiptItemsHtml(pkg)}
      <section class="block"><b>TESLİMAT ADRESİ</b><p>${safe(pkg.deliveryAddress || "-")}</p></section>
      ${pkg.customerNote ? `<section class="block note"><b>MÜŞTERİ NOTU</b><p>${safe(pkg.customerNote)}</p></section>` : ""}
      <footer><strong>RESTOMAP</strong><span>Bu teslimat RESTOMAP altyapısıyla yönetilmektedir.</span><small>Restoran · Kurye · Operasyon tek sistemde</small>${receiptCount > 1 ? `<small>Kopya ${copyNumber}/${receiptCount}</small>` : ""}</footer>
    </article>`;
    return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${invoice ? "Faturalı Fiş" : "Sipariş Fişi"} · ${safe(pkg.trackingNo || pkg.id)}</title><style>
      @page{size:${pageWidth}${thermal ? " auto" : " portrait"};margin:${thermal ? "0" : "10mm"}}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif}body{width:${contentWidth};max-width:100%;margin:0 auto;padding:${thermal ? "2mm" : "0"};font-size:${size === "58mm" ? "10px" : size === "80mm" ? "12px" : "14px"};line-height:1.35}.receipt{width:100%;margin:0 auto}.page-break{break-after:page;page-break-after:always}.brand{text-align:center;border:2px solid #111;padding:${thermal ? "2mm 1mm" : "14px"};margin-bottom:${thermal ? "2mm" : "18px"}.checkers{font-size:${thermal ? "7px" : "11px"};letter-spacing:1px;white-space:nowrap;overflow:hidden}.brand-name{font-size:${size === "58mm" ? "17px" : size === "80mm" ? "22px" : "32px"};font-weight:900;letter-spacing:.5px}.brand-name span{display:${thermal ? "block" : "inline"};font-size:.58em}.brand-tagline{font-size:.72em;font-weight:700;margin:3px 0}.custom-header{text-align:center;font-weight:800;border:1px dashed #555;padding:6px;margin-bottom:8px}.restaurant{text-align:center;border-bottom:1px dashed #555;padding-bottom:8px;margin-bottom:8px}.restaurant h1{font-size:1.35em;margin:0 0 3px}.restaurant div{font-weight:800;font-size:.88em}.tracking{text-align:center;background:#f2f2f2;border:1px solid #111;padding:${thermal ? "6px 3px" : "12px"};margin-bottom:8px}.tracking small{display:block;font-size:.72em}.tracking strong{display:block;font-size:1.45em;letter-spacing:.7px}.row{display:grid;grid-template-columns:${thermal ? "38% 62%" : "30% 70%"};gap:6px;border-bottom:1px dashed #aaa;padding:${thermal ? "5px 0" : "8px 0"}.row span{text-align:right;overflow-wrap:anywhere}.row.total{border:1px solid #111;margin:7px 0;padding:7px}.row.total span strong{font-size:1.18em}.items{margin-top:8px;border-top:2px solid #111;border-bottom:2px solid #111;padding:6px 0}.items-title{text-align:center;font-weight:900;font-size:1.08em;margin-bottom:5px}.items-head,.item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;padding:4px 0}.items-head{border-bottom:1px solid #111;font-size:.78em}.item{border-bottom:1px dashed #aaa;align-items:start}.item:last-child{border-bottom:0}.item>div{min-width:0}.item strong{display:block;overflow-wrap:anywhere}.item small{display:block;color:#333;font-size:.78em;overflow-wrap:anywhere}.items-empty{text-align:center;font-style:italic;padding:5px}.block{margin-top:8px;border:1px solid #777;padding:${thermal ? "6px" : "10px"}.block>b{font-size:.78em}.block p{margin:4px 0 0;overflow-wrap:anywhere}.note{border-style:dashed}footer{text-align:center;border-top:2px solid #111;margin-top:${thermal ? "10px" : "18px"};padding-top:8px}footer strong,footer span,footer small{display:block}footer strong{font-size:1.15em}footer span{font-weight:700;margin:3px 0}footer small{font-size:.72em;margin-top:3px}@media print{html,body{background:#fff}.receipt{box-shadow:none}}
    </style></head><body>${Array.from({ length: receiptCount }, (_, index) => receipt(index + 1)).join("")}${invokeBrowserPrint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),180));<\\/script>' : ""}</body></html>`;
  }

  function printPackage(pkg, invoice = false, options = {}) {
    const settings = state.panelData.printerSettings || {};
    const paperSize = normalizedPaperSize(options.paperSize || settings.paperSize);
    const copies = Math.max(1, Math.min(5, Number(options.copies ?? settings.copies) || 1));
    const frame = document.createElement("iframe");
    frame.className = "zg-browser-print-frame";
    frame.title = "Sipariş fişi yazdırma";
    frame.setAttribute("aria-hidden", "true");
    Object.assign(frame.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: "1px",
      height: "1px",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    });
    const cleanup = () => frame.remove();
    frame.addEventListener("load", () => {
      if (window.__DELIVERA_TEST__) return;
      try {
        const printWindow = frame.contentWindow;
        if (!printWindow) throw new Error("Yazdırma çerçevesi açılamadı");
        printWindow.addEventListener("afterprint", cleanup, { once: true });
        printWindow.focus();
        window.setTimeout(() => printWindow.print(), 120);
        window.setTimeout(cleanup, 60000);
      } catch (error) {
        cleanup();
        toast(`Yazdırma ekranı açılamadı: ${error.message}`, "error");
      }
    }, { once: true });
    frame.srcdoc = receiptDocument(pkg, invoice, paperSize, copies, false);
    document.body.appendChild(frame);
  }

  function printOptionsModal(pkg, invoice = false) {
    const settings = state.panelData.printerSettings || {};
    const current = normalizedPaperSize(settings.paperSize);
    const sizes = [
      { value: "58mm", title: "58 mm · Küçük", detail: "Dar termal yazıcı ve kurye fişi" },
      { value: "80mm", title: "80 mm · Orta", detail: "Standart restoran termal yazıcısı" },
      { value: "A4", title: "A4 · Büyük", detail: "Normal yazıcı ve ayrıntılı çıktı" },
    ];
    modal(invoice ? "Faturalı Fiş Yazdır" : "Sipariş Fişi Yazdır", `<div class="zg-print-options">${sizes.map((size) => `<button type="button" data-print-size="${size.value}" class="zg-print-option ${current === size.value ? "is-default" : ""}"><strong>${size.title}</strong><span>${size.detail}</span>${current === size.value ? '<small class="text-blue-600 font-bold">Varsayılan</small>' : ""}</button>`).join("")}</div><label class="zg-field mt-4"><span>Kopya sayısı</span><input data-print-copies type="number" min="1" max="5" value="${Math.max(1, Math.min(5, Number(settings.copies) || 1))}"></label><label class="zg-print-default"><input data-save-print-default type="checkbox" checked><span>Seçtiğim ölçüyü ve kopya sayısını bu restoran için varsayılan kaydet</span></label><p class="mt-3 text-xs text-slate-500">Not: Yazıcı sürücüsünde kağıt genişliği de 58 mm veya 80 mm olarak seçili olmalıdır.</p>`, (root) => {
      root.querySelectorAll("[data-print-size]").forEach((button) => button.addEventListener("click", () => {
        const paperSize = button.dataset.printSize;
        const copies = Math.max(1, Math.min(5, Number(root.querySelector("[data-print-copies]").value) || 1));
        if (root.querySelector("[data-save-print-default]").checked) {
          state.panelData.printerSettings = { ...settings, paperSize, copies };
          savePanelData("Yazıcı tercihi kaydedildi.").catch((error) => toast(error.message, "error"));
        }
        printPackage(pkg, invoice, { paperSize, copies });
        root.remove();
      }));
    });
  }

  async function packageAction(pkg, action) {
    const reason = action === "reject" ? prompt("Reddetme nedeni:", "Restoran reddetti.") : "";
    if (action === "reject" && reason === null) return;
    try {
      hydrate(await api(`/api/restaurant/packages/${encodeURIComponent(pkg.id)}/action`, { method: "POST", body: JSON.stringify({ action, reason }) }));
      toast(action === "confirm" ? "Sipariş onaylandı ve kurye ataması başlatıldı." : "Sipariş reddedildi.", "success");
    } catch (error) { toast(error.message, "error"); }
  }

  function phoneOrderModal() {
    const paymentOptions = (state.panelData.paymentTypes || []).map((label) => {
      const key = normalize(label);
      const value = key.includes("nakit") ? "cash_on_delivery" : key.includes("kart") ? "card_on_delivery" : "paid_online";
      return `<option value="${value}">${safe(label)}</option>`;
    }).join("");
    modal("Telefon Siparişi Ekle", `<form id="zgOrderForm" class="zg-grid"><input type="hidden" name="restaurantCustomerId"><label class="zg-field"><span>Müşteri adı</span><input name="customerName" required></label><label class="zg-field"><span>Telefon</span><input name="phone" inputmode="tel" autocomplete="tel" required><small data-customer-match class="text-xs text-slate-500">Kayıtlı müşteri için yalnızca numarayı yazın.</small></label><label class="zg-field full"><span>Teslimat adresi</span><textarea name="deliveryAddress" rows="3" required></textarea></label><label class="zg-field"><span>Sipariş içeriği (isteğe bağlı)</span><input name="packageType" placeholder="Boş bırakılabilir"></label><label class="zg-field"><span>Tutar</span><input name="orderAmount" type="number" min="0.01" step="0.01" required></label><label class="zg-field"><span>Ödeme türü</span><select name="paymentMethod">${paymentOptions || '<option value="paid_online">Online ödendi</option>'}</select></label><label class="zg-field"><span>Müşteri notu</span><input name="customerNote"></label><div class="full flex justify-end gap-2"><button data-close type="button" class="px-4">Vazgeç</button><button class="zg-primary" type="submit">Siparişi Kaydet</button></div></form>`, (root) => {
      const formElement = root.querySelector("form");
      const phoneInput = formElement.elements.phone;
      const matchText = root.querySelector("[data-customer-match]");
      let lookupTimer = null;
      let lookupSequence = 0;
      const fillCustomer = (customer) => {
        formElement.elements.restaurantCustomerId.value = customer.id || "";
        formElement.elements.customerName.value = customer.name || "";
        formElement.elements.deliveryAddress.value = customer.address || "";
        if (!formElement.elements.customerNote.value) formElement.elements.customerNote.value = customer.note || "";
        matchText.textContent = `${customer.name} bulundu; bilgiler otomatik dolduruldu.`;
        matchText.className = "text-xs text-emerald-600 font-semibold";
      };
      phoneInput.addEventListener("input", () => {
        clearTimeout(lookupTimer);
        formElement.elements.restaurantCustomerId.value = "";
        matchText.textContent = "Kayıtlı müşteri aranıyor...";
        matchText.className = "text-xs text-slate-500";
        const digits = String(phoneInput.value || "").replace(/\D/g, "").replace(/^90(?=5)/, "");
        const sequence = ++lookupSequence;
        if (digits.length < 10) { matchText.textContent = "Kayıtlı müşteri için yalnızca numarayı yazın."; return; }
        lookupTimer = setTimeout(async () => {
          try {
            const localMatch = (state.data?.customers || []).find((customer) => String(customer.phone || "").replace(/\D/g, "").replace(/^90(?=5)/, "") === digits);
            const response = localMatch ? { customers: [localMatch] } : await api(`/api/restaurant/customers?phone=${encodeURIComponent(digits)}`);
            if (sequence !== lookupSequence) return;
            const exact = (response.customers || []).find((customer) => String(customer.phone || "").replace(/\D/g, "").replace(/^90(?=5)/, "") === digits);
            if (exact) fillCustomer(exact);
            else { matchText.textContent = "Yeni müşteri; sipariş kaydedilince müşteri rehberine eklenecek."; matchText.className = "text-xs text-blue-600"; }
          } catch { if (sequence === lookupSequence) matchText.textContent = "Müşteri araması yapılamadı; bilgileri elle girebilirsiniz."; }
        }, 250);
      });
      formElement.addEventListener("submit", async (event) => {
        event.preventDefault();
        const shouldTest = event.submitter?.hasAttribute("data-save-test");
        const form = Object.fromEntries(new FormData(event.currentTarget));
        form.packageType ||= "";
        try { const data = await api("/api/restaurant/packages", { method: "POST", body: JSON.stringify(form) }); hydrate(data); root.remove(); toast("Sipariş kaydedildi ve kurye havuzuna gönderildi.", "success"); }
        catch (error) { toast(error.message, "error"); }
      });
    });
  }

  function listModal(title, items, renderer) {
    modal(title, items.length ? `<div>${items.map(renderer).join("")}</div>` : '<div class="zg-empty">Kayıt bulunamadı.</div>');
  }

  function panelCrudModal(config) {
    const render = () => {
      const items = state.panelData[config.key] || [];
      return `<form data-crud-form class="zg-grid mb-5">${config.fields.map((field) => `<label class="zg-field ${field.full ? "full" : ""}"><span>${safe(field.label)}</span>${field.type === "select" ? `<select name="${field.name}" ${field.required ? "required" : ""}>${field.options.map((option) => `<option value="${safe(option.value ?? option)}">${safe(option.label ?? option)}</option>`).join("")}</select>` : `<input name="${field.name}" type="${field.type || "text"}" ${field.required ? "required" : ""} ${field.min != null ? `min="${field.min}"` : ""} ${field.step ? `step="${field.step}"` : ""}>`}</label>`).join("")}<div class="full flex justify-end"><button class="zg-primary" type="submit">Ekle</button></div></form><div data-crud-list>${items.length ? items.map((item) => config.row(item)).join("") : '<div class="zg-empty">Henüz kayıt yok.</div>'}</div>`;
    };
    const root = modal(config.title, render(), (mounted) => {
      const bind = () => {
        mounted.querySelector("[data-crud-form]")?.addEventListener("submit", async (event) => {
          event.preventDefault();
          const values = Object.fromEntries(new FormData(event.currentTarget));
          const item = { id: `${config.key}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...values };
          (state.panelData[config.key] ||= []).push(item);
          await savePanelData(`${config.itemName} eklendi.`);
          mounted.querySelector(".zg-modal-body").innerHTML = render(); bind();
        });
        mounted.querySelector("[data-crud-list]")?.addEventListener("click", async (event) => {
          const button = event.target.closest("[data-delete-id],[data-toggle-id]");
          if (!button) return;
          const list = state.panelData[config.key] || [];
          const id = button.dataset.deleteId || button.dataset.toggleId;
          if (button.dataset.deleteId) state.panelData[config.key] = list.filter((item) => item.id !== id);
          else {
            const item = list.find((entry) => entry.id === id);
            if (item) item.active = item.active === false;
          }
          await savePanelData(`${config.itemName} güncellendi.`);
          mounted.querySelector(".zg-modal-body").innerHTML = render(); bind();
        });
      };
      bind();
    });
    return root;
  }

  function tableManagement() {
    return panelCrudModal({
      title: "POS Masa Yönetimi", key: "tables", itemName: "Masa",
      fields: [{ name: "name", label: "Masa adı/no", required: true }, { name: "capacity", label: "Kapasite", type: "number", min: 1, required: true }],
      row: (item) => `<div class="zg-list-row"><div><b>${safe(item.name)}</b><div class="text-xs text-slate-500">${safe(item.capacity)} kişilik</div></div><div class="flex items-center gap-2"><span class="${item.active === false ? "text-slate-400" : "text-emerald-600"}">${item.active === false ? "Kapalı" : "Açık"}</span><button data-toggle-id="${safe(item.id)}" class="text-blue-600">Durumu değiştir</button><button data-delete-id="${safe(item.id)}" class="text-red-600">Sil</button></div></div>`,
    });
  }

  function categoryManagement() {
    return panelCrudModal({
      title: "Kategoriler", key: "categories", itemName: "Kategori",
      fields: [{ name: "name", label: "Kategori adı", required: true, full: true }],
      row: (item) => `<div class="zg-list-row"><b>${safe(item.name)}</b><div class="flex gap-3"><button data-toggle-id="${safe(item.id)}" class="text-blue-600">${item.active === false ? "Etkinleştir" : "Pasifleştir"}</button><button data-delete-id="${safe(item.id)}" class="text-red-600">Sil</button></div></div>`,
    });
  }

  function productManagement() {
    const categoryOptions = (state.panelData.categories || []).filter((item) => item.active !== false).map((item) => ({ value: item.id, label: item.name }));
    if (!categoryOptions.length) categoryOptions.push({ value: "general", label: "Genel" });
    return panelCrudModal({
      title: "Ürünler ve Menü", key: "products", itemName: "Ürün",
      fields: [{ name: "name", label: "Ürün adı", required: true }, { name: "categoryId", label: "Kategori", type: "select", options: categoryOptions }, { name: "price", label: "Fiyat", type: "number", min: 0, step: "0.01", required: true }, { name: "stock", label: "Stok", type: "number", min: 0, required: true }],
      row: (item) => { const category = (state.panelData.categories || []).find((entry) => entry.id === item.categoryId); return `<div class="zg-list-row"><div><b>${safe(item.name)}</b><div class="text-xs text-slate-500">${safe(category?.name || "Genel")} · Stok: ${safe(item.stock)}</div></div><div class="flex items-center gap-3"><b>${formatMoney(item.price)}</b><button data-toggle-id="${safe(item.id)}" class="text-blue-600">${item.active === false ? "Satışa aç" : "Satışı durdur"}</button><button data-delete-id="${safe(item.id)}" class="text-red-600">Sil</button></div></div>`; },
    });
  }

  function settingsModal(kind) {
    const configs = {
      pos: { title: "POS Ayarları", key: "posSettings", fields: [{ name: "serviceFee", label: "Servis ücreti (%)", type: "number", min: 0 }, { name: "taxRate", label: "KDV oranı (%)", type: "number", min: 0 }, { name: "autoAccept", label: "POS siparişlerini otomatik onayla", type: "checkbox" }] },
      general: { title: "Genel Ayarlar", key: "generalSettings", fields: [{ name: "defaultPrepMinutes", label: "Varsayılan hazırlık süresi (dk)", type: "number", min: 1 }, { name: "orderSound", label: "Yeni sipariş sesi", type: "checkbox" }, { name: "autoPrint", label: "Yeni siparişi otomatik yazdır", type: "checkbox" }] },
      printer: { title: "Yazıcı Ayarları", key: "printerSettings", fields: [{ name: "paperSize", label: "Kağıt ölçüsü", type: "select", options: ["58mm", "80mm", "A4"] }, { name: "copies", label: "Kopya sayısı", type: "number", min: 1 }, { name: "header", label: "Fiş üst başlığı", type: "text" }] },
    };
    const config = configs[kind];
    const values = state.panelData[config.key] || {};
    const fieldsHtml = config.fields.map((field) => {
      if (field.type === "checkbox") {
        return `<label class="zg-field full flex-row items-center"><input name="${field.name}" type="checkbox" ${values[field.name] ? "checked" : ""}><span>${safe(field.label)}</span></label>`;
      }
      const control = field.type === "select"
        ? `<select name="${field.name}">${field.options.map((option) => `<option ${values[field.name] === option ? "selected" : ""}>${safe(option)}</option>`).join("")}</select>`
        : `<input name="${field.name}" type="${field.type}" min="${field.min ?? ""}" value="${safe(values[field.name] ?? "")}">`;
      return `<label class="zg-field"><span>${safe(field.label)}</span>${control}</label>`;
    }).join("");
    modal(config.title, `<form data-settings class="zg-grid">${fieldsHtml}<div class="full flex justify-end"><button class="zg-primary">Kaydet</button></div></form>`, (root) => {
      root.querySelector("form").addEventListener("submit", async (event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget); const next = {};
        config.fields.forEach((field) => { next[field.name] = field.type === "checkbox" ? event.currentTarget.elements[field.name].checked : field.type === "number" ? Number(form.get(field.name) || 0) : form.get(field.name); });
        state.panelData[config.key] = next; await savePanelData(); root.remove();
      });
    });
  }

  function paymentTypesModal() {
    const render = () => `<form data-payment-form class="flex gap-2 mb-4"><input name="name" required class="flex-1 border rounded px-3" placeholder="Yeni ödeme türü"><button class="zg-primary">Ekle</button></form><div>${(state.panelData.paymentTypes || []).map((name, index) => `<div class="zg-list-row"><span>${safe(name)}</span><button data-payment-delete="${index}" class="text-red-600">Sil</button></div>`).join("")}</div>`;
    modal("Telefon Ödeme Türleri", render(), (root) => {
      const bind = () => {
        root.querySelector("[data-payment-form]").addEventListener("submit", async (event) => { event.preventDefault(); state.panelData.paymentTypes ||= []; state.panelData.paymentTypes.push(new FormData(event.currentTarget).get("name")); await savePanelData("Ödeme türü eklendi."); root.querySelector(".zg-modal-body").innerHTML = render(); bind(); });
        root.querySelectorAll("[data-payment-delete]").forEach((button) => button.addEventListener("click", async () => { state.panelData.paymentTypes.splice(Number(button.dataset.paymentDelete), 1); await savePanelData("Ödeme türü silindi."); root.querySelector(".zg-modal-body").innerHTML = render(); bind(); }));
      }; bind();
    });
  }

  async function reportModal(title, mode = "summary") {
    const delivered = packages().filter((pkg) => pkg.status === "delivered");
    const selected = mode === "outside" ? packages().filter((pkg) => ["manual", "external_manual", "platform_manual"].includes(pkg.source)) : delivered;
    if (mode === "summary") {
      return modal(title, `<div data-account-report><div class="zg-empty"><i class="ph ph-circle-notch ph-spin text-3xl block mb-2"></i>Günlük hesap raporu hazırlanıyor...</div></div>`, (root) => {
        const modalElement = root.querySelector(".zg-modal");
        modalElement.style.width = "min(1040px,96vw)";
        const container = root.querySelector("[data-account-report]");
        let selectedDate = "";
        let periodFilter = "day";
        let statusFilter = "all";
        let paymentFilter = "all";

        const reportStatus = (status) => ({
          delivered: ["Teslim edildi", "background:#dcfce7;color:#166534"],
          cancelled: ["İptal", "background:#fee2e2;color:#991b1b"],
          rejected: ["Reddedildi", "background:#fee2e2;color:#991b1b"],
          failed: ["Teslim edilemedi", "background:#ffedd5;color:#9a3412"],
          on_route: ["Yolda", "background:#dbeafe;color:#1e40af"],
          accepted_by_courier: ["Kurye kabul etti", "background:#e0e7ff;color:#3730a3"],
          assigned: ["Kurye atandı", "background:#ede9fe;color:#5b21b6"],
          awaiting_assignment: ["Kurye bekliyor", "background:#fef3c7;color:#92400e"],
          preparing: ["Hazırlanıyor", "background:#fef3c7;color:#92400e"],
          pending_approval: ["Onay bekliyor", "background:#f1f5f9;color:#475569"],
        }[status] || [status || "Bilinmiyor", "background:#f1f5f9;color:#475569"]);
        const paymentLabel = (bucket) => ({ cash: "Nakit", card: "Kapıda kart", online: "Online", restaurant: "Restoran tahsilatı", other: "Diğer" }[bucket] || "Diğer");

        const render = (data) => {
          selectedDate = data.selectedDate;
          periodFilter = data.period || periodFilter;
          const summary = data.summary || {};
          const rows = data.packages || [];
          const history = data.history || [];
          container.innerHTML = `
            <form data-report-filter class="zg-report-controls">
              <label>Rapor dönemi<select name="period"><option value="day">Günlük</option><option value="week">Haftalık</option></select></label>
              <label>Rapor tarihi<input name="date" type="date" value="${safe(selectedDate)}" max="${safe(data.currentDate)}"></label>
              <label>Sipariş durumu<select name="status"><option value="all">Tüm siparişler</option><option value="delivered">Teslim edilenler</option><option value="cancelled">İptal / reddedilenler</option><option value="active">Devam edenler</option><option value="failed">Teslim edilemeyenler</option></select></label>
              <label>Ödeme türü<select name="payment"><option value="all">Tüm ödemeler</option><option value="cash">Nakit</option><option value="card">Kapıda kart</option><option value="online">Online</option><option value="restaurant">Restoran tahsilatı</option><option value="other">Diğer</option></select></label>
              <button class="zg-primary" type="submit"><i class="ph ph-funnel mr-1"></i>Filtrele</button>
            </form>
            <div class="mt-3 text-xs text-slate-500"><b>${periodFilter === "week" ? "Hafta aralığı" : "Gün sınırı"}:</b> ${periodFilter === "week" ? `${safe(data.rangeStart)} – ${safe(data.rangeEnd)}` : "Türkiye saatiyle 00.00–23.59"} · Seçili tarih: <b>${safe(selectedDate)}</b></div>
            <div class="zg-report-cards">
              <div class="zg-report-card is-blue"><span>Toplam sipariş</span><strong>${Number(summary.totalOrders || 0)}</strong><small>${Number(summary.activeCount || 0)} devam ediyor</small></div>
              <div class="zg-report-card is-green"><span>Teslim edildi</span><strong>${Number(summary.deliveredCount || 0)}</strong><small>${formatMoney(summary.deliveredRevenue || 0)} ciro</small></div>
              <div class="zg-report-card is-red"><span>İptal / ret</span><strong>${Number(summary.cancelledCount || 0)}</strong><small>${formatMoney(summary.cancelledAmount || 0)} iptal tutarı</small></div>
              <div class="zg-report-card is-amber"><span>Teslim edilemedi</span><strong>${Number(summary.failedCount || 0)}</strong><small>İnceleme gereken kayıt</small></div>
              <div class="zg-report-card"><span>Nakit</span><strong>${Number(summary.cashCount || 0)}</strong><small>${formatMoney(summary.cashAmount || 0)}</small></div>
              <div class="zg-report-card"><span>Kapıda kart</span><strong>${Number(summary.cardCount || 0)}</strong><small>${formatMoney(summary.cardAmount || 0)}</small></div>
              <div class="zg-report-card"><span>Online ödeme</span><strong>${Number(summary.onlineCount || 0)}</strong><small>${formatMoney(summary.onlineAmount || 0)}</small></div>
              <div class="zg-report-card"><span>Restoran / diğer</span><strong>${Number(summary.restaurantCount || 0) + Number(summary.otherCount || 0)}</strong><small>${formatMoney(Number(summary.restaurantAmount || 0) + Number(summary.otherAmount || 0))}</small></div>
            </div>
            <div class="mt-5"><div class="flex items-center justify-between mb-2"><b class="text-sm">Geçmiş ${periodFilter === "week" ? "haftalar" : "günler"}</b><span class="text-xs text-slate-500">Son ${history.length} dönem</span></div><div class="zg-report-history">${history.map((day) => `<button type="button" data-report-day="${safe(day.date)}" class="zg-report-day ${day.date === (periodFilter === "week" ? data.rangeStart : selectedDate) ? "is-selected" : ""}"><strong>${safe(day.date)}${day.endDate ? ` – ${safe(day.endDate)}` : ""}</strong><span>${day.totalOrders} sipariş · ${day.cancelledCount} iptal</span><span>${formatMoney(day.deliveredRevenue)} teslim cirosu</span></button>`).join("") || '<span class="text-xs text-slate-500">Geçmiş kayıt bulunamadı.</span>'}</div></div>
            <div class="mt-3 border rounded-lg overflow-auto" style="max-height:330px"><table class="zg-report-table"><thead><tr><th>Paket</th><th>Müşteri</th><th>Durum</th><th>Ödeme</th><th>Kurye</th><th>Saat</th><th class="text-right">Tutar</th></tr></thead><tbody>${rows.map((pkg) => { const status = reportStatus(pkg.status); return `<tr><td><b>${safe(pkg.trackingNo || pkg.id)}</b><div class="text-[10px] text-slate-500">${safe(pkg.sourcePlatform || "Telefon")}</div></td><td>${safe(pkg.customerName || "Müşteri")}</td><td><span class="zg-report-pill" style="${status[1]}">${safe(status[0])}</span></td><td>${safe(paymentLabel(pkg.paymentBucket))}<div class="text-[10px] text-slate-500">${safe(pkg.paymentMethod)}</div></td><td>${safe(pkg.courierName)}</td><td>${dateTime(pkg.createdAt)}</td><td class="text-right"><b>${formatMoney(pkg.orderAmount)}</b></td></tr>`; }).join("") || '<tr><td colspan="7" class="zg-empty">Bu filtrelerde sipariş bulunamadı.</td></tr>'}</tbody></table></div>
            <div class="flex justify-between items-center mt-4"><span class="text-xs text-slate-500">Listede ${rows.length} kayıt gösteriliyor.</span><button data-report-print class="zg-primary" type="button"><i class="ph ph-printer mr-1"></i>Yazdır</button></div>`;
          container.querySelector('[name="period"]').value = periodFilter;
          container.querySelector('[name="status"]').value = statusFilter;
          container.querySelector('[name="payment"]').value = paymentFilter;
          bind();
        };
        const load = async () => {
          container.style.opacity = ".55";
          try {
            const query = new URLSearchParams({ period: periodFilter, status: statusFilter, payment: paymentFilter });
            if (selectedDate) query.set("date", selectedDate);
            render(await api(`/api/restaurant/reports/account?${query}`));
          } catch (error) {
            container.innerHTML = `<div class="zg-empty text-red-600">${safe(error.message)}</div>`;
          } finally { container.style.opacity = "1"; }
        };
        const bind = () => {
          container.querySelector("[data-report-filter]")?.addEventListener("submit", (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            selectedDate = String(form.get("date") || "");
            periodFilter = String(form.get("period") || "day");
            statusFilter = String(form.get("status") || "all");
            paymentFilter = String(form.get("payment") || "all");
            load();
          });
          container.querySelectorAll("[data-report-day]").forEach((button) => button.addEventListener("click", () => { selectedDate = button.dataset.reportDay; load(); }));
          container.querySelector("[data-report-print]")?.addEventListener("click", () => window.print());
        };
        load();
      });
    }
    if (mode === "daily") {
      try {
        const response = await api("/api/restaurant/reports/daily");
        return listModal(title, response.reports || [], (row) => `<div class="zg-list-row"><div><b>${safe(row.date)}</b><div class="text-xs text-slate-500">${safe(row.courier_name)} · ${row.package_count} paket</div></div><b>${formatMoney(row.total_revenue)}</b></div>`);
      } catch (error) { return toast(error.message, "error"); }
    }
    if (mode === "km") {
      const grouped = new Map();
      packages().forEach((pkg) => { const name = pkg.assignedCourierName || "Atanmadı"; const row = grouped.get(name) || { count: 0, km: 0 }; row.count += 1; row.km += Number(pkg.distanceKm || pkg.extraDistanceKm || 0); grouped.set(name, row); });
      return listModal(title, [...grouped], ([name, row]) => `<div class="zg-list-row"><div><b>${safe(name)}</b><div class="text-xs text-slate-500">${row.count} paket</div></div><b>${row.km.toLocaleString("tr-TR", { maximumFractionDigits: 2 })} km</b></div>`);
    }
    const revenue = selected.reduce((sum, pkg) => sum + Number(pkg.orderAmount || 0), 0);
    modal(title, `<div class="zg-grid"><div class="p-4 rounded bg-blue-50"><div class="text-sm text-slate-500">Kayıt sayısı</div><b class="text-2xl">${selected.length}</b></div><div class="p-4 rounded bg-emerald-50"><div class="text-sm text-slate-500">Toplam tutar</div><b class="text-2xl">${formatMoney(revenue)}</b></div></div><div class="mt-4 max-h-80 overflow-auto">${selected.map((pkg) => `<div class="zg-list-row"><div><b>${safe(pkg.trackingNo || pkg.id)}</b><div class="text-xs text-slate-500">${safe(pkg.customerName || "Müşteri")} · ${dateTime(pkg.createdAt)}</div></div><b>${formatMoney(pkg.orderAmount)}</b></div>`).join("") || '<div class="zg-empty">Kayıt bulunamadı.</div>'}</div><button onclick="window.print()" class="zg-primary mt-4">Yazdır</button>`);
  }

  function integrationModal() {
    modal("Yeni Platform Entegrasyonu", `<form data-integration class="zg-grid"><label class="zg-field"><span>Platform</span><select name="platform"><option>Yemeksepeti</option><option>Getir Yemek</option><option>Migros Yemek</option><option>Trendyol Yemek</option></select></label><label class="zg-field"><span>Mağaza / restoran / supplier ID</span><input name="externalStoreId" required></label><label class="zg-field"><span>API Key</span><input name="apiKey" autocomplete="off"></label><label class="zg-field"><span>API Secret</span><input name="apiSecret" type="password" autocomplete="new-password"></label><label class="zg-field"><span>Erişim tokenı</span><input name="token" type="password" autocomplete="new-password"></label><label class="zg-field"><span>Webhook Secret</span><input name="webhookSecret" type="password" autocomplete="new-password"></label><p data-integration-help class="full text-xs text-slate-500"></p><div class="full flex justify-end gap-2"><button class="border rounded px-4" type="submit">Kaydet</button><button class="zg-primary" type="submit" data-save-test>Kaydet ve Bağlantıyı Test Et</button></div></form>`, (root) => {
      const formElement = root.querySelector("form");
      const syncRequirements = () => {
        const trendyol = formElement.elements.platform.value === "Trendyol Yemek";
        formElement.elements.apiKey.required = trendyol;
        formElement.elements.apiSecret.required = trendyol;
        formElement.elements.webhookSecret.required = !trendyol;
        root.querySelector("[data-integration-help]").textContent = trendyol
          ? "Trendyol için Supplier ID, API Key ve API Secret zorunludur; siparişler polling ile alınır."
          : "Bu platform için restoran ID ve Webhook Secret zorunludur; siparişler imzalı webhook ile alınır.";
      };
      formElement.elements.platform.addEventListener("change", syncRequirements);
      syncRequirements();
      formElement.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = Object.fromEntries(new FormData(event.currentTarget));
        const pollingEnabled = form.platform === "Trendyol Yemek";
        const payload = { ...form, staticToken: form.webhookSecret, active: true, webhookEnabled: !pollingEnabled, pollingEnabled, settings: {} };
        try {
          const nextState = await api("/api/restaurant/platform-accounts", { method: "POST", body: JSON.stringify(payload) });
          hydrate(nextState);
          const account = (nextState.platformAccounts || []).find((item) => item.platform === form.platform && item.externalStoreId === form.externalStoreId);
          if (shouldTest && account?.id) {
            const testResult = await api("/api/restaurant/platform-accounts/test-connection", { method: "POST", body: JSON.stringify({ accountId: account.id }) });
            toast(testResult.message || testResult.publicMessage || "Bağlantı testi tamamlandı.", testResult.ok ? "success" : "error");
          } else toast("Platform entegrasyonu kaydedildi.", "success");
          root.remove();
        } catch (error) { toast(error.message, "error"); }
      });
    });
  }

  function dataToolsModal() {
    modal("Dosya Data", `<p class="text-sm text-slate-500 mb-4">Masa, ürün, kategori ve panel ayarlarını JSON dosyası olarak yedekleyebilir veya geri yükleyebilirsiniz.</p><div class="flex gap-3"><button data-export class="zg-primary">JSON Dışa Aktar</button><label class="border rounded px-4 py-2 cursor-pointer">JSON İçe Aktar<input data-import type="file" accept="application/json" class="hidden"></label></div>`, (root) => {
      root.querySelector("[data-export]").addEventListener("click", () => { const blob = new Blob([JSON.stringify(state.panelData, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `restoran-panel-yedek-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
      root.querySelector("[data-import]").addEventListener("change", async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const data = JSON.parse(await file.text()); if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Geçersiz dosya"); state.panelData = { ...state.panelData, ...data }; await savePanelData("Panel verileri içe aktarıldı."); root.remove(); } catch (error) { toast(error.message, "error"); } });
    });
  }

  async function showMap() {
    const content = refs.content;
    if (!content) return;
    content.dataset.tableHtml ||= content.innerHTML;
    content.innerHTML = '<div class="zg-map-shell"><div id="restaurantMap" class="zg-map bg-slate-200 rounded-lg"></div><div id="restaurantMapSummary" class="zg-map-summary"><b>Canlı Kurye Haritası</b><div class="text-xs text-slate-500 mt-1">Konumlar yükleniyor...</div></div></div>';
    if (!window.L) {
      await Promise.all([
        new Promise((resolve) => { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/vendor/leaflet.css"; link.onload = resolve; document.head.appendChild(link); }),
        new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = "/vendor/leaflet.js"; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); }),
      ]);
    }
    const restaurant = state.data?.restaurants?.[0] || {};
    const restaurantLocation = restaurantMapLocation(restaurant);
    const center = [restaurantLocation.latitude, restaurantLocation.longitude];
    state.map?.remove?.();
    state.map = L.map("restaurantMap").setView(center, 13);
    state.mapHasFitted = false;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(state.map);
    updateRestaurantCourierMap(true);
    startRestaurantMapRefresh();
  }

  function stopRestaurantMapRefresh() {
    clearInterval(state.mapPoll);
    clearTimeout(state.mapRefreshTimer);
    state.mapPoll = null;
    state.mapRefreshTimer = null;
  }

  async function refreshRestaurantMapData() {
    if (!state.map || state.mapRefreshBusy || !document.getElementById("restaurantMap")) return;
    state.mapRefreshBusy = true;
    try {
      const liveMap = await api("/api/restaurant/live-map");
      if (!state.data) state.data = {};
      state.data.couriers = liveMap.activeCouriers || [];
      if (liveMap.restaurant) state.data.restaurants = [liveMap.restaurant];
      state.mapUpdatedAt = liveMap.generatedAt || new Date().toISOString();
      updateRestaurantCourierMap(false);
    } catch {
      // Son başarılı harita görünümü korunur; sonraki canlı olay veya aralık tekrar dener.
    } finally {
      state.mapRefreshBusy = false;
    }
  }

  function scheduleRestaurantMapRefresh() {
    clearTimeout(state.mapRefreshTimer);
    state.mapRefreshTimer = setTimeout(refreshRestaurantMapData, 180);
  }

  function startRestaurantMapRefresh() {
    stopRestaurantMapRefresh();
    state.mapPoll = setInterval(refreshRestaurantMapData, 5000);
    scheduleRestaurantMapRefresh();
  }

  function distanceKm(lat1, lng1, lat2, lng2) {
    const toRadians = (value) => value * Math.PI / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function restaurantMapLocation(restaurant = {}) {
    const latitude = Number(restaurant.latitude ?? restaurant.lat);
    const longitude = Number(restaurant.longitude ?? restaurant.lng);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      return { latitude, longitude, estimated: false };
    }
    const zoneCenters = {
      akdeniz: [36.8081, 34.6372],
      yenişehir: [36.7810, 34.5740],
      yenisehir: [36.7810, 34.5740],
      mezitli: [36.7503, 34.5388],
      toroslar: [36.8241, 34.6250],
      tarsus: [36.9177, 34.8928],
    };
    const fallback = zoneCenters[normalize(restaurant.zone)] || [36.8121, 34.6415];
    return { latitude: fallback[0], longitude: fallback[1], estimated: true };
  }

  function restaurantLiveMapCouriers(restaurantLocation, now = Date.now()) {
    return (state.data?.couriers || []).map((courier) => {
      const latitude = Number(courier.latitude ?? courier.lat);
      const longitude = Number(courier.longitude ?? courier.lng);
      const distance = Number.isFinite(latitude) && Number.isFinite(longitude)
        ? distanceKm(restaurantLocation.latitude, restaurantLocation.longitude, latitude, longitude)
        : Infinity;
      const lastLocationMs = new Date(courier.lastLocationAt || 0).getTime();
      const status = normalize(courier.status);
      const isLive = Number.isFinite(lastLocationMs) && now - lastLocationMs >= -60_000 && now - lastLocationMs <= 2 * 60 * 1000;
      const isOnline = Boolean(courier.available) && ["online", "busy"].includes(status);
      return { ...courier, latitude, longitude, distance, isLive, isOnline };
    }).filter((courier) => courier.isOnline && courier.isLive && Number.isFinite(courier.latitude) && Number.isFinite(courier.longitude) && courier.distance <= 25)
      .sort((left, right) => left.distance - right.distance);
  }

  function updateRestaurantCourierMap(fitBounds = false) {
    if (!state.map || !document.getElementById("restaurantMap")) return;
    const restaurant = state.data?.restaurants?.[0] || {};
    const restaurantLocation = restaurantMapLocation(restaurant);
    const restaurantLat = restaurantLocation.latitude;
    const restaurantLng = restaurantLocation.longitude;
    const couriers = restaurantLiveMapCouriers(restaurantLocation);

    state.mapLayer?.remove?.();
    state.mapLayer = L.layerGroup().addTo(state.map);
    const restaurantMarker = L.circleMarker([restaurantLat, restaurantLng], { radius: 12, color: "#991b1b", weight: 3, fillColor: "#ef4444", fillOpacity: 1 }).addTo(state.mapLayer);
    restaurantMarker.bindPopup(`<b>${safe(restaurant.name || "Restoran")}</b><br>${restaurantLocation.estimated ? "Bölge merkezine göre yaklaşık restoran konumu" : "Restoran konumu"}`);
    restaurantMarker.bindTooltip("Restoran", { direction: "top", offset: [0, -8] });

    couriers.forEach((courier) => {
      const marker = L.circleMarker([courier.latitude, courier.longitude], {
        radius: 10,
        color: "#075985",
        weight: 3,
        fillColor: "#0ea5e9",
        fillOpacity: .95,
      }).addTo(state.mapLayer);
      marker.bindTooltip(`${safe(courier.name || "Kurye")} · ${courier.distance.toFixed(1)} km`, { direction: "top", offset: [0, -7] });
      marker.bindPopup(`<b>${safe(courier.name || "Kurye")}</b><br>${safe(courier.status || "Çevrimiçi")}<br><b>${courier.distance.toFixed(2)} km</b> uzakta<br><span style="color:#047857;font-weight:700">Canlı konum</span>`);
    });

    const refreshedAt = new Date(state.mapUpdatedAt || Date.now()).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const summary = document.getElementById("restaurantMapSummary");
    if (summary) summary.innerHTML = `<b>Canlı Kurye Haritası</b><div class="text-sm mt-1"><strong>${couriers.length}</strong> çevrimiçi yakın kurye · <span class="zg-map-live">● CANLI · ${refreshedAt}</span></div><div class="zg-map-legend"><span><i class="zg-dot" style="background:#ef4444"></i>Restoran</span><span><i class="zg-dot" style="background:#0ea5e9"></i>Çevrimiçi kurye</span></div><div class="text-[10px] text-slate-400 mt-2">Restoranın 25 km çevresi · çevrimdışı ve eski konumlu kuryeler gösterilmez${restaurantLocation.estimated ? " · restoran noktası bölge merkezinden hesaplandı" : ""}</div>`;
    if (fitBounds && !state.mapHasFitted) {
      const bounds = [[restaurantLat, restaurantLng], ...couriers.map((courier) => [courier.latitude, courier.longitude])];
      if (bounds.length > 1) state.map.fitBounds(bounds, { padding: [55, 55], maxZoom: 15 });
      state.mapHasFitted = true;
    }
  }

  function restoreTable(filter = state.filter) {
    stopRestaurantMapRefresh();
    state.map?.remove?.();
    state.map = null;
    state.mapLayer = null;
    if (refs.content?.dataset.tableHtml) {
      refs.content.innerHTML = refs.content.dataset.tableHtml;
      refs.tbody = refs.content.querySelector("tbody"); refs.tbody.id = "restaurantOrders";
    }
    state.filter = filter; renderOrders(); updateCounters();
  }

  function showRoute(route) {
    document.querySelectorAll("aside a").forEach((link) => link.classList.toggle("zg-sidebar-active", link.dataset.route === route));
    if (route.includes("güncel durum")) return restoreTable("all");
    if (route.includes("kurye takip")) return showMap().catch((error) => toast(error.message, "error"));
    if (route.includes("kuryelerim")) return listModal("Kuryelerim", state.data?.couriers || [], (c) => `<div class="zg-list-row"><div><b>${safe(c.name || c.fullName || c.id)}</b><div class="text-xs text-slate-500">${safe(c.phone || c.vehiclePlate || "")}</div></div><span>${safe(c.status || (c.active ? "Aktif" : "Pasif"))}</span></div>`);
    if (route.includes("müşteriler")) return listModal("Müşteriler", state.data?.customers || [], (c) => `<div class="zg-list-row"><div><b>${safe(c.name)}</b><div class="text-xs text-slate-500">${safe(c.phone)} · ${safe(c.address)}</div></div><span>${Number(c.orderCount || 0)} sipariş</span></div>`);
    if (route.includes("arama geçmişi")) { restoreTable("all"); refs.search?.focus(); return toast("Paket no, müşteri veya telefonla arama yapabilirsiniz."); }
    if (route.includes("kurye teslim onayları")) return restoreTable("active");
    if (route.includes("teslim onay geçmişi") || route.includes("teslim edilenler")) return restoreTable("delivered");
    if (route.includes("iptal edilenler")) return restoreTable("cancelled");
    if (route.includes("pos masa")) return tableManagement();
    if (route.includes("pos ayar")) return settingsModal("pos");
    if (route.includes("pos rapor")) return reportModal("POS Raporu", "outside");
    if (route === "kategoriler") return categoryManagement();
    if (route === "ürünler" || route.includes("menü yönetimi")) return productManagement();
    if (route.includes("hesap rapor")) return reportModal("Hesap Raporları", "summary");
    if (route.includes("günlük sipariş raporu")) return reportModal("Günlük Sipariş Raporu", "daily");
    if (route.includes("sipariş detayları")) return reportModal("Sipariş Detayları", "all");
    if (route.includes("sistem dışı rapor")) return reportModal("Sistem Dışı Sipariş Raporu", "outside");
    if (route.includes("km ücret raporu")) return reportModal("KM Ücret Raporu", "km");
    if (route.includes("restoranlarım")) return listModal("Restoran ve Platformlarım", [{ platform: state.data?.restaurants?.[0]?.name || "Restoran", externalStoreId: state.data?.restaurants?.[0]?.id, active: true }, ...(state.data?.platformAccounts || [])], (a) => `<div class="zg-list-row"><div><b>${safe(a.platform)}</b><div class="text-xs text-slate-500">Mağaza: ${safe(a.externalStoreId || a.platformRestaurantId || "-")}</div></div><span class="${a.active !== false ? "text-emerald-600" : "text-slate-500"}">${a.active !== false ? "Aktif" : "Pasif"}</span></div>`);
    if (route.includes("yeni restoran")) return integrationModal();
    if (route.includes("genel ayar")) return settingsModal("general");
    if (route.includes("telefon ödeme")) return paymentTypesModal();
    if (route.includes("dosya data")) return dataToolsModal();
    if (route.includes("yazıcı ayar")) return settingsModal("printer");
    toast(`${route} bölümü açıldı.`);
  }

  refs.search?.addEventListener("input", (event) => { state.search = event.target.value; renderOrders(); });
  refs.notificationButton?.addEventListener("click", async () => {
    try {
      unlockOrderAudio();
      if (notificationPermission() !== "granted") {
        const enabled = await initializeRestaurantPush(true);
        toast(enabled ? "Bildirim ve sipariş sesi açıldı." : "Bildirim izni verilmedi.", enabled ? "success" : "error");
        if (enabled) playOrderSignal();
      } else {
        await initializeRestaurantPush(false);
        playOrderSignal();
      }
      showNotificationCenter();
    } catch (error) { toast(error.message, "error"); }
  });
  document.addEventListener("pointerdown", () => {
    unlockOrderAudio();
    if (notificationPermission() === "default") initializeRestaurantPush(true);
    else if (notificationPermission() === "granted") initializeRestaurantPush(false);
  }, { once: true });
  refs.phoneButton?.addEventListener("click", phoneOrderModal);
  refs.sidebarLinks.forEach((link) => {
    const handler = () => normalize(link.textContent).includes("çıkış yap") ? logout() : showRoute(link.dataset.route);
    link.addEventListener("click", handler);
    link.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); handler(); } });
  });

  document.querySelectorAll("aside nav h3").forEach((heading) => {
    heading.tabIndex = 0;
    heading.setAttribute("role", "button");
    const toggle = () => {
      const list = heading.nextElementSibling;
      list?.classList.toggle("hidden");
      const icon = heading.querySelector(".ph-caret-down,.ph-caret-up");
      icon?.classList.toggle("ph-caret-down");
      icon?.classList.toggle("ph-caret-up");
    };
    heading.addEventListener("click", toggle);
    heading.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); toggle(); } });
  });

  refs.main?.querySelector("header")?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (normalize(button.textContent).includes("haritayı göster")) return showMap().catch((error) => toast(error.message, "error"));
    if (button.dataset.filter) {
      state.platformAlerts.delete(button.dataset.filter);
      button.classList.remove("zg-platform-alert");
      restoreTable(button.dataset.filter);
    }
    else if (!normalize(button.textContent)) listModal("Platform Entegrasyonları", state.data?.platformAccounts || [], (account) => `<div class="zg-list-row"><b>${safe(account.platform)}</b><span>${account.active ? "Aktif" : "Pasif"}</span></div>`);
  });

  refs.content?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    const rowElement = button?.closest("[data-package-id]");
    const pkg = packages().find((item) => item.id === rowElement?.dataset.packageId);
    if (!button || !pkg) return;
    const action = button.dataset.action;
    if (action === "detail") detailModal(pkg);
    else if (action === "print") printOptionsModal(pkg);
    else if (action === "schedule") modal("Sipariş Zamanları", `<div class="zg-list-row"><b>Oluşturulma</b><span>${dateTime(pkg.createdAt)}</span></div><div class="zg-list-row"><b>Kurye atanma</b><span>${dateTime(pkg.assignedAt)}</span></div><div class="zg-list-row"><b>Teslim alma</b><span>${dateTime(pkg.pickedUpAt || pkg.onRouteAt)}</span></div><div class="zg-list-row"><b>Tahmini süre</b><span>${safe(pkg.eta || "Hesaplanıyor")}</span></div>`);
    else if (["confirm", "reject"].includes(action)) packageAction(pkg, action);
  });

  async function bootstrap() {
    if (!state.token) {
      const restaurantId = localStorage.getItem(ID_KEY) || "";
      const apiKey = localStorage.getItem(API_KEY) || "";
      if (restaurantId && apiKey) {
        try {
          const auth = await api("/api/restaurant/session", { method: "POST", headers: { "x-restaurant-id": restaurantId, "x-api-key": apiKey }, body: JSON.stringify({ restaurantId, apiKey }) }, false);
          saveAuth(auth); hydrate(auth.state); await loadPanelData();
        } catch { showLogin(); return; }
      } else { showLogin(); return; }
    } else await load();
    if (notificationPermission() === "granted") initializeRestaurantPush(false);
    connectStream(); startPolling();
  }

  if (globalThis.__DELIVERA_TEST__) {
    globalThis.__restaurantDesignTest = { state, currentPackages, hydrate, connectStream, updateRestaurantCourierMap, refreshRestaurantMapData, restaurantLiveMapCouriers, platformKey, platformOrdersWaitingForAttention, syncPlatformAttention };
  }

  window.addEventListener("storage", (event) => { if (event.key === PLATFORM_ATTENTION_ACK_KEY) syncPlatformAttention(); });
  window.addEventListener("beforeunload", () => { stopRestaurantMapRefresh(); stopPlatformAttention(); state.stream?.close(); clearInterval(state.poll); });
  bootstrap();
})();
