(() => {
  "use strict";

  function migratedStorageKey(currentKey, legacyKey) {
    if (localStorage.getItem(currentKey) === null && localStorage.getItem(legacyKey) !== null) {
      localStorage.setItem(currentKey, localStorage.getItem(legacyKey));
    }
    return currentKey;
  }

  const TOKEN_KEY = migratedStorageKey("restomapAdminToken", "deliveraAdminToken");
  const REFRESH_KEY = migratedStorageKey("restomapAdminRefreshToken", "deliveraAdminRefreshToken");
  const LEGACY_AUTH_KEYS = ["deliveraAdminToken", "deliveraAdminRefreshToken"];
  const terminalStatuses = new Set(["delivered", "failed", "rejected", "cancelled", "canceled"]);
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    refreshToken: localStorage.getItem(REFRESH_KEY) || "",
    data: null,
    filter: "all",
    stream: null,
    poll: null,
    map: null,
    mapLayer: null,
    audio: null,
    view: "operations",
    unmatchedFilter: "pending",
    liveMapRefresh: null,
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const normalize = (value) => String(value || "").toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
  const money = (value) => `${Number(value || 0).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;
  const time = (value) => value ? new Date(value).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "-";
  const dateTime = (value) => value ? new Date(value).toLocaleString("tr-TR") : "-";
  const packages = () => state.data?.packages || [];
  const couriers = () => state.data?.couriers || [];
  const restaurants = () => state.data?.restaurants || [];
  const unmatchedOrders = () => state.data?.unmatchedOrders || [];
  const localDateKey = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type)?.value || "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const packageOperationalDate = (pkg) => localDateKey(pkg.deliveredAt || pkg.failedAt || pkg.updatedAt || pkg.createdAt);
  const operationalPackages = () => packages().filter((pkg) => !terminalStatuses.has(pkg.status) || packageOperationalDate(pkg) === localDateKey());

  async function api(path, options = {}, retry = true) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401 && retry && state.refreshToken) {
      const refreshHeaders = { "Content-Type": "application/json" };
      if (state.token) refreshHeaders.Authorization = `Bearer ${state.token}`;
      const refreshResponse = await fetch("/api/admin/refresh", { method: "POST", headers: refreshHeaders, body: JSON.stringify({ refreshToken: state.refreshToken }) });
      if (refreshResponse.ok) {
        const auth = await refreshResponse.json();
        saveAuth(auth);
        return api(path, options, false);
      }
      clearAuth();
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `İşlem tamamlanamadı (${response.status}).`);
    return body;
  }

  function saveAuth(auth) {
    state.token = auth.token || "";
    state.refreshToken = auth.refreshToken || "";
    localStorage.setItem(TOKEN_KEY, state.token);
    localStorage.setItem(REFRESH_KEY, state.refreshToken);
  }

  async function logout() {
    const refreshToken = state.refreshToken;
    const token = state.token;
    clearAuth();
    if (navigator.serviceWorker || window.Capacitor?.isNativePlatform?.()) {
      try { const { removePushWithToken } = await import("/push-client.js"); await removePushWithToken("admin", token); } catch {}
    }
    try {
      if (refreshToken) {
        const headers = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        await fetch("/api/admin/logout", {
          method: "POST",
          headers,
          body: JSON.stringify({ refreshToken }),
        });
      }
    } catch {}
    clearAuth();
    location.reload();
  }

  function clearAuth() {
    state.token = "";
    state.refreshToken = "";
    [TOKEN_KEY, REFRESH_KEY, ...LEGACY_AUTH_KEYS]
      .forEach((key) => localStorage.removeItem(key));
    state.stream?.close();
  }

  function injectShell() {
    document.title = "Admin Operasyon | RESTOMAP";
    const style = document.createElement("style");
    style.textContent = `
      .da-modal-root{position:fixed;inset:0;z-index:200;background:rgba(15,23,42,.58);display:flex;align-items:center;justify-content:center;padding:24px}.da-modal{width:min(780px,96vw);max-height:90vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 24px 80px rgba(15,23,42,.3)}.da-modal-head{position:sticky;top:0;z-index:2;background:#fff;display:flex;justify-content:space-between;align-items:center;padding:17px 20px;border-bottom:1px solid #e2e8f0}.da-modal-body{padding:20px}.da-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.da-field{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600}.da-field.full{grid-column:1/-1}.da-field input,.da-field select,.da-field textarea{border:1px solid #c7c4d7;border-radius:8px;padding:10px;background:#fff;font-size:14px}.da-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:9px;margin-top:5px}.da-primary,.da-secondary,.da-danger{border:0;border-radius:8px;padding:10px 15px;font-weight:700}.da-primary{background:#4343d5;color:#fff}.da-secondary{background:#e7eefe;color:#2f05ea}.da-danger{background:#fee2e2;color:#b91c1c}.da-toast{position:fixed;z-index:250;right:22px;bottom:22px;max-width:420px;padding:12px 16px;border-radius:10px;background:#151c27;color:#fff;box-shadow:0 14px 40px #0004}.da-toast.success{background:#047857}.da-toast.error{background:#b91c1c}.da-empty{padding:60px 20px;text-align:center;color:#767586}.da-list{display:grid;gap:10px}.da-list-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px;border:1px solid #e2e8f0;border-radius:10px}.da-list-row small{display:block;color:#64748b;margin-top:3px}.da-list-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.da-list-actions button{padding:7px 10px;border-radius:7px;background:#e7eefe;color:#2f05ea;font-size:11px;font-weight:700}.da-notification{position:relative;width:40px;height:40px;border-radius:10px;background:#fff;color:#4343d5;display:grid;place-items:center;border:1px solid #c7c4d7;margin-left:auto}.da-notification-badge{position:absolute;right:-5px;top:-6px;background:#dc2626;color:#fff;min-width:18px;height:18px;border-radius:99px;padding:0 5px;font-size:10px;display:grid;place-items:center}.da-map{height:min(68vh,620px);border-radius:10px;overflow:hidden}.da-live{color:#047857;font-weight:700}.da-row{cursor:pointer}.da-row:hover .da-row-actions{opacity:1}.da-row-actions{opacity:.25;transition:opacity .15s}.da-badge{display:inline-flex;padding:3px 8px;border-radius:99px;font-size:10px;font-weight:700;background:#e7eefe;color:#4343d5}.da-kpi{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}.da-kpi>div{background:#f0f3ff;border-radius:10px;padding:13px}.da-kpi strong{display:block;font-size:22px;color:#4343d5}.da-kpi span{font-size:11px;color:#64748b}.da-route-title{font-size:20px;font-weight:700;margin-bottom:14px}.da-login .da-modal{width:min(460px,96vw)}.da-connection-offline{background:#ef4444!important}.da-main-scroll{overflow:auto!important}.da-table-head,.da-row{min-width:1120px}.da-active-route{background:#4b3bff!important;color:#fff!important;border-left:4px solid #4343d5!important}.da-logout{margin-top:8px;width:100%;padding:8px;border-radius:8px;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:700}.leaflet-container{font:12px Inter,sans-serif}
      .da-row{cursor:default}.da-row-actions{opacity:1}.da-row-actions button{cursor:pointer}.da-payment-cell{display:grid;gap:2px}.da-payment-cell>*{display:block;line-height:1.25}.da-map-summary{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.da-map-summary span{padding:7px 10px;border-radius:8px;background:#f1f5f9;color:#334155;font-size:12px}.da-map-summary b{color:#312e81}.da-map-legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;color:#64748b;font-size:12px}.da-map-legend span{display:flex;align-items:center;gap:5px}.da-map-legend i{width:10px;height:10px;border-radius:50%;display:inline-block}
      .da-report-modal .da-modal{width:min(1260px,97vw)}.da-report-controls{display:grid;grid-template-columns:160px minmax(170px,1fr) minmax(170px,1fr) minmax(170px,1fr) auto;gap:10px;align-items:end}.da-report-controls label{display:grid;gap:6px;color:#475569;font-size:12px;font-weight:700}.da-report-controls input,.da-report-controls select{height:42px;border:1px solid #cbd5e1;border-radius:9px;padding:0 12px;background:#fff;color:#1e293b}.da-report-note{margin:12px 0;color:#64748b;font-size:12px}.da-report-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px}.da-report-card{display:grid;gap:5px;padding:15px;border:1px solid #e2e8f0;border-radius:11px;background:#f8fafc}.da-report-card span,.da-report-card small{color:#64748b;font-size:12px}.da-report-card strong{font-size:24px;color:#1e293b}.da-report-card.is-blue{background:#eff6ff;border-color:#bfdbfe}.da-report-card.is-green{background:#ecfdf5;border-color:#a7f3d0}.da-report-card.is-red{background:#fff1f2;border-color:#fecdd3}.da-report-card.is-amber{background:#fffbeb;border-color:#fde68a}.da-report-history{display:flex;gap:9px;overflow:auto;padding-bottom:5px}.da-report-day{min-width:175px;display:grid;gap:4px;padding:11px;border:1px solid #dbe2ea;border-radius:9px;background:#fff;text-align:left}.da-report-day.is-selected{border-color:#2563eb;background:#eff6ff}.da-report-day span{font-size:10px;color:#64748b}.da-report-table{width:100%;border-collapse:collapse;min-width:950px}.da-report-table th,.da-report-table td{padding:10px 11px;border-bottom:1px solid #e2e8f0;text-align:left;font-size:12px}.da-report-table th{position:sticky;top:0;background:#f8fafc;color:#475569}.da-report-pill{display:inline-flex;padding:4px 8px;border-radius:999px;font-size:10px;font-weight:700}.da-report-section-title{display:flex;justify-content:space-between;align-items:center;margin:18px 0 8px;font-size:13px}.da-report-footer{display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#64748b;font-size:11px}
      .da-operation-layout{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:12px}.da-operation-list{height:min(68vh,620px);overflow:auto;border:1px solid #e2e8f0;border-radius:10px;padding:8px;background:#f8fafc}.da-operation-list h3{font-size:13px;font-weight:800;padding:5px 6px 9px}.da-operation-business{width:100%;display:grid;grid-template-columns:11px minmax(0,1fr) auto;align-items:center;gap:8px;padding:10px 8px;border:0;border-top:1px solid #e2e8f0;background:transparent;text-align:left}.da-operation-business:not(:disabled){cursor:pointer}.da-operation-business:not(:disabled):hover{background:#eef2ff}.da-operation-business:disabled{opacity:.62}.da-operation-business i{width:10px;height:10px;border-radius:50%}.da-operation-business b{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.da-operation-business small{display:block;color:#64748b;font-size:10px;margin-top:2px}.da-operation-business strong{min-width:25px;height:25px;border-radius:99px;display:grid;place-items:center;background:#fff;color:#312e81;font-size:11px}.da-operation-couriers{margin-top:10px;padding:9px;border-radius:9px;background:#dbeafe;color:#1e3a8a;font-size:11px}.da-modal-map .da-modal{width:min(1100px,97vw)}
      .da-sidebar-count{margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:99px;background:#dc2626;color:#fff;font-size:10px;font-weight:800;display:grid;place-items:center}.da-unmatched-workspace{background:#fff;border:1px solid #dddbea;border-radius:12px;min-height:calc(100vh - 150px);overflow:hidden}.da-unmatched-workspace[hidden]{display:none}.da-unmatched-head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px;padding:20px 22px;border-bottom:1px solid #e2e8f0}.da-unmatched-head h2{font-size:22px;font-weight:800;color:#17172a}.da-unmatched-head p{margin-top:4px;color:#64748b;font-size:12px}.da-unmatched-stats{display:flex;gap:8px;flex-wrap:wrap;padding:14px 22px;background:#f8fafc;border-bottom:1px solid #e2e8f0}.da-unmatched-filter{border:1px solid #d7d8e2;border-radius:9px;padding:8px 12px;background:#fff;color:#475569;font-size:12px;font-weight:700}.da-unmatched-filter.active{background:#4343d5;color:#fff;border-color:#4343d5}.da-unmatched-list{display:grid;gap:12px;padding:18px 22px;max-height:calc(100vh - 290px);overflow:auto}.da-unmatched-card{border:1px solid #e2e8f0;border-radius:12px;padding:15px;background:#fff;box-shadow:0 3px 12px rgba(15,23,42,.04)}.da-unmatched-card.resolved{background:#f8fafc;border-color:#bbf7d0}.da-unmatched-card-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.da-unmatched-card h3{font-size:15px;font-weight:800;color:#1e1b4b}.da-unmatched-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:7px}.da-unmatched-meta span{padding:4px 7px;border-radius:7px;background:#eef2ff;color:#3730a3;font-size:10px;font-weight:700}.da-unmatched-card-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}.da-unmatched-card-grid div{padding:9px;border-radius:8px;background:#f8fafc}.da-unmatched-card-grid small{display:block;color:#64748b;font-size:10px}.da-unmatched-card-grid b{display:block;margin-top:3px;font-size:12px;overflow-wrap:anywhere}.da-unmatched-match{display:grid;grid-template-columns:minmax(220px,1fr) auto auto;gap:10px;align-items:center;margin-top:14px;padding-top:13px;border-top:1px solid #e2e8f0}.da-unmatched-match select{border:1px solid #cbd5e1;border-radius:8px;padding:10px;background:#fff}.da-unmatched-check{display:flex;align-items:center;gap:6px;font-size:11px;color:#475569}.da-unmatched-raw{margin-top:10px;font-size:11px;color:#64748b}.da-unmatched-raw pre{max-height:180px;overflow:auto;margin-top:7px;padding:10px;border-radius:8px;background:#0f172a;color:#e2e8f0;white-space:pre-wrap;word-break:break-word}.da-unmatched-resolved{margin-top:12px;padding:10px;border-radius:8px;background:#dcfce7;color:#166534;font-size:12px;font-weight:700}
      @media(max-width:900px){aside{width:220px!important}main{margin-left:220px!important}.da-grid{grid-template-columns:1fr}.da-field.full{grid-column:auto}.da-operation-layout{grid-template-columns:1fr}.da-operation-list{width:auto!important;height:210px}.da-unmatched-card-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.da-unmatched-match{grid-template-columns:1fr}.da-unmatched-head{flex-direction:column}.da-report-controls{grid-template-columns:1fr 1fr}.da-report-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
    const main = document.querySelector("main");
    const header = main?.querySelector("header");
    const tableCard = main?.querySelector(".p-container-padding > div");
    const tableHead = tableCard?.querySelector(":scope > div:first-child");
    const tableBody = tableCard?.querySelector(":scope > div.flex-1.overflow-y-auto");
    tableHead?.classList.add("da-table-head");
    if (tableBody) { tableBody.id = "adminOperationRows"; tableBody.innerHTML = '<div class="da-empty">Operasyon verileri yükleniyor...</div>'; }
    const filterButtons = [...(header?.querySelectorAll("button") || [])].slice(0, 6);
    const addOrderButton = [...(header?.querySelectorAll("button") || [])].find((button) => normalize(button.textContent).includes("sipariş ekle"));
    const notificationButton = document.createElement("button");
    notificationButton.type = "button";
    notificationButton.className = "da-notification";
    notificationButton.setAttribute("aria-label", "Bildirim Merkezi");
    notificationButton.title = "Bildirim Merkezi";
    notificationButton.innerHTML = '<span class="material-symbols-outlined">notifications</span><span class="da-notification-badge" hidden>0</span>';
    addOrderButton?.before(notificationButton);
    const integrationLink = [...document.querySelectorAll("aside nav a")].find((link) => normalize(link.textContent).includes("entegrasyon yönetimi"));
    let unmatchedMenuBadge = null;
    if (integrationLink) {
      const credentialsLink = document.createElement("a");
      credentialsLink.className = integrationLink.className;
      credentialsLink.innerHTML = '<span class="material-symbols-outlined mr-3 text-[20px]">manage_accounts</span><span class="text-body-sm font-body-sm">Restoran Giriş Bilgileri</span>';
      integrationLink.after(credentialsLink);
      const unmatchedLink = document.createElement("a");
      unmatchedLink.className = integrationLink.className;
      unmatchedLink.innerHTML = '<span class="material-symbols-outlined mr-3 text-[20px]">rule</span><span class="text-body-sm font-body-sm">Eşleşmeyen Paketler</span><span class="da-sidebar-count">0</span>';
      credentialsLink.after(unmatchedLink);
      const deviceSetupLink = document.createElement("a");
      deviceSetupLink.className = integrationLink.className;
      deviceSetupLink.innerHTML = '<span class="material-symbols-outlined mr-3 text-[20px]">print_connect</span><span class="text-body-sm font-body-sm">Restoran Cihaz Kurulumu</span>';
      unmatchedLink.after(deviceSetupLink);
      unmatchedMenuBadge = unmatchedLink.querySelector(".da-sidebar-count");
    }
    const dailyReportLink = [...document.querySelectorAll("aside nav a")].find((link) => normalize(link.textContent).includes("günlük sipariş raporu"));
    if (dailyReportLink) {
      const rangeReportLink = document.createElement("a");
      rangeReportLink.className = dailyReportLink.className;
      rangeReportLink.innerHTML = '<span class="material-symbols-outlined mr-3 text-[20px]">date_range</span><span class="text-body-sm font-body-sm">İşletme Tarih Aralığı</span>';
      dailyReportLink.after(rangeReportLink);
    }
    const creditCard = [...document.querySelectorAll("aside .bg-surface-container")].find((item) => normalize(item.textContent).includes("kontör"));
    const creditCount = creditCard?.querySelector(".text-green-600") || null;
    if (creditCard) {
      creditCard.setAttribute("role", "button");
      creditCard.setAttribute("aria-label", "Kontör İşlemleri");
      creditCard.tabIndex = 0;
      creditCard.classList.add("cursor-pointer", "hover:bg-primary-fixed", "transition-colors");
    }
    const sidebarLinks = [...document.querySelectorAll("aside nav a"), ...(creditCard ? [creditCard] : [])];
    sidebarLinks.forEach((link) => {
      const label = link.querySelector("span:not(.material-symbols-outlined)")?.textContent || link.textContent;
      link.dataset.route = normalize(label);
      link.removeAttribute("href");
      link.setAttribute("role", "button");
      link.tabIndex = 0;
    });
    const unmatchedWorkspace = document.createElement("section");
    unmatchedWorkspace.className = "da-unmatched-workspace";
    unmatchedWorkspace.hidden = true;
    tableCard?.after(unmatchedWorkspace);
    const sidebarFooter = document.querySelector("aside > div:last-child");
    const logoutButton = document.createElement("button");
    logoutButton.type = "button";
    logoutButton.className = "da-logout";
    logoutButton.textContent = "Güvenli Çıkış";
    sidebarFooter?.appendChild(logoutButton);
    return { main, header, tableCard, tableHead, tableBody, filterButtons, addOrderButton, notificationButton, sidebarLinks, logoutButton, unmatchedWorkspace, unmatchedMenuBadge, creditCount };
  }

  const refs = injectShell();

  function toast(message, tone = "") {
    document.querySelector(".da-toast")?.remove();
    const item = document.createElement("div");
    item.className = `da-toast ${tone}`;
    item.textContent = message;
    document.body.appendChild(item);
    setTimeout(() => item.remove(), 3800);
  }

  function modal(title, content, onMount, className = "") {
    document.querySelector(".da-modal-root")?.remove();
    const root = document.createElement("div");
    root.className = `da-modal-root ${className}`;
    root.innerHTML = `<section class="da-modal" role="dialog" aria-modal="true"><div class="da-modal-head"><h2 class="text-xl font-bold">${esc(title)}</h2><button data-close type="button" aria-label="Kapat" class="text-2xl">×</button></div><div class="da-modal-body">${content}</div></section>`;
    root.addEventListener("click", (event) => { if (event.target === root || event.target.closest("[data-close]")) root.remove(); });
    document.body.appendChild(root);
    onMount?.(root);
    return root;
  }

  function showLogin(message = "Operasyon paneline giriş yapın.") {
    window.RestomapLoginShell.show({
      title: "Operasyon Girişi",
      description: message.replace("Admin", "Operasyon"),
      fields: `<label class="delivera-auth-field full"><span>Kullanıcı adı</span><input name="username" autocomplete="username" required></label><label class="delivera-auth-field full"><span>Parola</span><input name="password" type="password" autocomplete="current-password" required></label>`,
      onSubmit: async (formData) => {
        const auth = await api("/api/admin/login", { method: "POST", body: JSON.stringify(Object.fromEntries(formData)) }, false);
        saveAuth(auth);
        window.RestomapLoginShell.hide();
        await load();
        connectStream();
        startPolling();
      },
    });
  }

  const statusLabels = {
    pending_approval: "Onay Bekliyor", pending: "İşletmede", preparing: "Hazır", awaiting_assignment: "Hazır - Atanmayan", assigned: "Atandı", accepted_by_courier: "Kurye Aldı", on_route: "Yolda", delivered: "Teslim Edildi", failed: "Teslim Edilemedi", rejected: "Reddedildi", cancelled: "İptal", canceled: "İptal",
  };

  function courierFor(pkg) { return couriers().find((courier) => courier.id === pkg.assignedCourierId); }
  const hasCoordinates = (item) => Number.isFinite(Number(item?.latitude)) && Number.isFinite(Number(item?.longitude));
  const isActiveCourier = (courier) => Boolean(courier?.available) && ["online", "busy"].includes(normalize(courier?.status));

  function operationMapData(focusPackage = null) {
    const waitingStatuses = new Set(["pending_approval", "pending", "preparing", "awaiting_assignment"]);
    const assignedStatuses = new Set(["assigned", "accepted_by_courier"]);
    const routeStatuses = new Set(["on_route"]);
    const restaurantItems = restaurants().map((restaurant) => {
      const activePackages = packages().filter((pkg) => pkg.restaurantId === restaurant.id && !terminalStatuses.has(pkg.status));
      return {
        ...restaurant,
        hasCoordinates: hasCoordinates(restaurant),
        activeCount: activePackages.length,
        waitingCount: activePackages.filter((pkg) => waitingStatuses.has(pkg.status)).length,
        assignedCount: activePackages.filter((pkg) => assignedStatuses.has(pkg.status)).length,
        routeCount: activePackages.filter((pkg) => routeStatuses.has(pkg.status)).length,
      };
    });
    return {
      restaurants: restaurantItems,
      mappedRestaurants: restaurantItems.filter((restaurant) => restaurant.hasCoordinates),
      missingRestaurantLocations: restaurantItems.filter((restaurant) => !restaurant.hasCoordinates),
      activeCouriers: couriers().filter((courier) => isActiveCourier(courier) && hasCoordinates(courier)),
      activeCouriersWithoutLocation: couriers().filter((courier) => isActiveCourier(courier) && !hasCoordinates(courier)),
      focusPackage,
    };
  }
  function visiblePackages() {
    return operationalPackages().filter((pkg) => {
      if (state.filter === "business") return ["pending_approval", "pending", "preparing"].includes(pkg.status);
      if (state.filter === "waiting") return ["awaiting_assignment", "assigned"].includes(pkg.status) && !pkg.assignedCourierId;
      if (state.filter === "route") return ["accepted_by_courier", "on_route", "assigned"].includes(pkg.status) && Boolean(pkg.assignedCourierId);
      if (state.filter === "scheduled") return Boolean(pkg.scheduledAt || pkg.appointmentAt);
      if (state.filter === "cancelled") return ["failed", "rejected", "cancelled", "canceled"].includes(pkg.status);
      return true;
    });
  }

  function row(pkg) {
    const courier = courierFor(pkg);
    const label = statusLabels[pkg.status] || pkg.status || "Bekliyor";
    const dot = terminalStatuses.has(pkg.status) ? "bg-slate-400" : pkg.assignedCourierId ? "bg-blue-500" : ["preparing", "awaiting_assignment"].includes(pkg.status) ? "bg-green-500" : "bg-orange-500";
    return `<div class="da-row grid grid-cols-[100px_1fr_1.5fr_1fr_120px_100px_120px_140px] gap-4 px-4 py-3 border-b border-outline-variant/50 hover:bg-surface-container-low items-center text-body-sm" data-package-id="${esc(pkg.id)}">
      <div><div class="flex items-center gap-1"><span class="w-2 h-2 rounded-full ${dot}"></span><b>${esc(pkg.trackingNo || pkg.externalOrderNo || pkg.id)}</b></div><span class="da-badge">${esc(pkg.sourcePlatform || pkg.source || "Panel")}</span></div>
      <div class="truncate"><b>${esc(pkg.restaurantName || "Restoran")}</b><small>${esc(pkg.zone || "-")}</small></div>
      <div class="truncate" title="${esc(pkg.deliveryAddress || pkg.address)}">${esc(pkg.deliveryAddress || pkg.address || "Adres yok")}</div>
      <div class="truncate"><b>${esc(pkg.customerName || pkg.recipient || "Müşteri")}</b><small>${esc(pkg.phone || "Telefon yok")}</small></div>
      <div><span>${time(pkg.createdAt)}</span><small>${Number(pkg.distanceKm || 0).toFixed(2)} km</small><b class="text-primary">${esc(label)}</b></div>
      <div class="text-center"><span class="material-symbols-outlined text-primary">${courier ? "delivery_dining" : "person"}</span><small>${esc(courier?.name || pkg.assignedCourierName || "Atanmadı")}</small></div>
      <div class="da-payment-cell"><b class="text-primary">${esc(pkg.paymentMethod || "Belirtilmedi")}</b><small>${esc(pkg.paymentStatus || "")}</small><strong class="text-green-600">${money(pkg.orderAmount)}</strong></div>
      <div class="da-row-actions flex flex-wrap gap-1 justify-end"><button data-action="detail" class="w-7 h-7 bg-blue-100 text-blue-600 rounded" title="Detay"><span class="material-symbols-outlined text-[14px]">visibility</span></button><button data-action="map" class="w-7 h-7 bg-amber-100 text-amber-600 rounded" title="Harita"><span class="material-symbols-outlined text-[14px]">map</span></button>${terminalStatuses.has(pkg.status) ? "" : '<button data-action="cancel" class="w-7 h-7 bg-red-100 text-red-600 rounded" title="İptal"><span class="material-symbols-outlined text-[14px]">close</span></button><button data-action="edit" class="px-2 py-1 bg-indigo-100 text-indigo-700 rounded text-[10px] font-bold w-full">Düzenle / Ata</button>'}</div>
    </div>`;
  }

  function renderOperations() {
    if (!refs.tableBody || !state.data || state.view !== "operations") return;
    refs.unmatchedWorkspace.hidden = true;
    refs.tableBody.innerHTML = visiblePackages().length ? visiblePackages().map(row).join("") : '<div class="da-empty">Bu filtrede paket bulunamadı.</div>';
    refs.tableBody.querySelectorAll('button[data-action="detail"]').forEach((button) => { button.type = "button"; button.title = "Paket detayını görüntüle"; button.setAttribute("aria-label", "Paket detayını görüntüle"); });
    refs.tableBody.querySelectorAll('button[data-action="map"]').forEach((button) => button.remove());
    refs.tableBody.querySelectorAll('button[data-action="edit"],button[data-action="cancel"]').forEach((button) => { button.type = "button"; });
    refs.tableCard.style.display = "flex";
  }

  function filterCount(filter) {
    const previous = state.filter; state.filter = filter; const count = visiblePackages().length; state.filter = previous; return count;
  }

  function updateCounters() {
    const config = [["all", "Tümü"], ["business", "İşletmede"], ["waiting", "Hazır - Atanmayan"], ["route", "Yolda"], ["scheduled", "Randevulu"], ["cancelled", "İptal"]];
    refs.filterButtons.forEach((button, index) => {
      const [key, label] = config[index]; button.dataset.filter = key;
      const badge = button.querySelector("span"); if (badge) badge.textContent = filterCount(key);
      button.childNodes[0].textContent = `${label} `;
      button.classList.toggle("bg-primary-container", state.filter === key);
      button.classList.toggle("text-on-primary-container", state.filter === key);
    });
    const badge = refs.notificationButton.querySelector(".da-notification-badge");
    const count = state.data.unreadNotificationCount ?? (state.data.notifications || []).filter((item) => item.unread !== false && !item.readAt).length; badge.textContent = count; badge.hidden = count === 0;
    const unmatchedCount = unmatchedOrders().filter((order) => !order.isResolved).length;
    if (refs.unmatchedMenuBadge) refs.unmatchedMenuBadge.textContent = String(unmatchedCount);
    const creditBalance = (state.data?.creditAccounts || []).reduce((sum, item) => sum + Number(item.balance || 0), 0);
    if (refs.creditCount) {
      refs.creditCount.textContent = String(creditBalance);
      refs.creditCount.title = `${creditBalance} kullanılabilir işletme kontörü`;
    }
  }

  function hydrate(data) {
    state.data = data;
    updateCounters();
    if (state.view === "unmatched") renderUnmatchedWorkspace();
    else renderOperations();
    const connectionText = [...document.querySelectorAll("aside span")].find((span) => normalize(span.textContent).includes("sisteme bağlı"));
    if (connectionText) connectionText.textContent = "Sisteme bağlı · Canlı";
  }

  async function load(silent = false) {
    if (!state.token) { showLogin(); return; }
    try { hydrate(await api("/api/admin/bootstrap?limit=250&cursor=0")); }
    catch (error) { if (!silent) { clearAuth(); showLogin(error.message); } }
  }

  function playSignal(kind = "normal") {
    try {
      state.audio ||= new (window.AudioContext || window.webkitAudioContext)();
      if (state.audio.state === "suspended") state.audio.resume().catch(() => {});
      const frequencies = kind === "critical" ? [880, 1175, 880, 1320] : [660, 880, 1100];
      frequencies.forEach((frequency, index) => {
        const oscillator = state.audio.createOscillator(); const gain = state.audio.createGain(); const start = state.audio.currentTime + index * .17;
        oscillator.frequency.value = frequency; gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(.14, start + .02); gain.gain.exponentialRampToValueAtTime(.0001, start + .14); oscillator.connect(gain).connect(state.audio.destination); oscillator.start(start); oscillator.stop(start + .15);
      });
    } catch {}
  }

  function connectStream() {
    state.stream?.close();
    if (!state.token || typeof EventSource === "undefined") return;
    state.stream = new EventSource(`/api/admin/stream?token=${encodeURIComponent(state.token)}`);
    const handle = (event) => {
      let payload = {}; try { payload = JSON.parse(event.data || "{}"); } catch {}
      if (payload.message) toast(payload.message, "success");
      if (["package-created", "package-assigned", "assignment-waiting", "order:new", "order:unmatched", "platform-order-pending"].includes(event.type)) playSignal(event.type === "assignment-waiting" || event.type === "order:unmatched" ? "critical" : "normal");
      state.liveMapRefresh?.();
      if (event.type !== "courier-location") load(true);
    };
    ["package-created", "package-assigned", "package-override", "package-reassign", "package-unassign", "package-status", "assignment-waiting", "order:new", "order:unmatched", "platform-order-pending", "courier-location", "courier-availability", "courier-day-close", "restaurant-created", "courier-created", "workspace-update", "restaurant-accounting-update"].forEach((type) => state.stream.addEventListener(type, handle));
    state.stream.onerror = () => { state.stream?.close(); state.stream = null; setTimeout(connectStream, 3500); };
  }

  function startPolling() { clearInterval(state.poll); state.poll = setInterval(() => load(true), 15000); }

  function notificationCenter() {
    const items = state.data?.notifications || [];
    modal("Bildirim Merkezi", `<div class="da-actions" style="margin-bottom:12px"><button class="da-secondary" type="button" data-read-all ${(state.data?.unreadNotificationCount ?? items.some((item) => item.unread !== false && !item.readAt)) > 0 ? "" : "disabled"}>Tümünü Okundu İşaretle</button></div>${items.length ? `<div class="da-list">${items.map((item) => `<div class="da-list-row"><div><b>${esc(item.message || "Bildirim")}</b><small>${dateTime(item.createdAt)}${item.readAt ? ` · Okundu ${dateTime(item.readAt)}` : " · Okunmadı"}</small></div><span class="da-badge">${esc(item.eventType || "sistem")}</span></div>`).join("")}</div>` : '<div class="da-empty">Henüz bildirim yok.</div>'}`, (root) => {
      root.querySelector("[data-read-all]")?.addEventListener("click", async () => {
        try {
          const result = await api("/api/admin/notifications/read", { method: "POST", body: JSON.stringify({}) });
          state.data.notifications = result.notifications || [];
          state.data.unreadNotificationCount = result.unreadNotificationCount;
          updateCounters();
          notificationCenter();
        } catch (error) { toast(error.message, "error"); }
      });
    });
  }

  function packageDetailLegacy(pkg) {
    const courier = courierFor(pkg);
    const products = globalThis.renderOrderItemsBox?.(pkg, { compact: true }) || `<div class="da-list-row"><b>Sipariş içeriği</b><span>${esc(pkg.packageType || "Ürün bilgisi platformdan gelmedi")}</span></div>`;
    modal(`Paket ${pkg.trackingNo || pkg.id}`, `<div class="da-kpi"><div><strong>${money(pkg.orderAmount)}</strong><span>Sipariş tutarı</span></div><div><strong>${Number(pkg.distanceKm || 0).toFixed(2)} km</strong><span>Mesafe</span></div><div><strong>${esc(statusLabels[pkg.status] || pkg.status)}</strong><span>Durum</span></div></div><div class="da-list"><div class="da-list-row"><b>Restoran</b><span>${esc(pkg.restaurantName)}</span></div><div class="da-list-row"><b>Müşteri</b><span>${esc(pkg.customerName || pkg.recipient)} · ${esc(pkg.phone)}</span></div><div class="da-list-row"><b>Adres</b><span class="text-right">${esc(pkg.deliveryAddress || pkg.address)}</span></div><div class="da-list-row"><b>Kurye</b><span>${esc(courier?.name || pkg.assignedCourierName || "Atanmadı")}</span></div><div class="da-list-row"><b>Ödeme</b><span>${esc(pkg.paymentMethod)} · ${esc(pkg.paymentStatus)}</span></div><div class="da-list-row"><b>Oluşturulma</b><span>${dateTime(pkg.createdAt)}</span></div><div class="da-list-row"><b>Not</b><span>${esc(pkg.customerNote || "-")}</span></div><div class="order-items-slot">${products}</div></div>`);
  }

  function packageDetail(pkg) {
    const courier = courierFor(pkg);
    const products = globalThis.renderOrderItemsBox?.(pkg, { compact: true }) || `<div class="da-list-row"><b>Sipariş içeriği</b><span>${esc(pkg.packageType || "Ürün bilgisi platformdan gelmedi")}</span></div>`;
    modal(`Paket ${pkg.trackingNo || pkg.externalOrderNo || pkg.id}`, `<div class="da-kpi"><div><strong>${money(pkg.orderAmount)}</strong><span>Sipariş tutarı</span></div><div><strong>${Number(pkg.distanceKm || 0).toFixed(2)} km</strong><span>Mesafe</span></div><div><strong>${esc(statusLabels[pkg.status] || pkg.status || "Bekliyor")}</strong><span>Durum</span></div></div><div class="da-list"><div class="da-list-row"><b>Kaynak / Sipariş No</b><span>${esc(pkg.sourcePlatform || pkg.source || "Panel")} · ${esc(pkg.externalOrderNo || pkg.trackingNo || pkg.id)}</span></div><div class="da-list-row"><b>İşletme</b><span>${esc(pkg.restaurantName || "Bilinmeyen işletme")}</span></div><div class="da-list-row"><b>Müşteri</b><span>${esc(pkg.customerName || pkg.recipient || "-")} · ${esc(pkg.phone || "Telefon yok")}</span></div><div class="da-list-row"><b>Teslimat adresi</b><span class="text-right">${esc(pkg.deliveryAddress || pkg.address || "Adres yok")}</span></div><div class="da-list-row"><b>Kurye</b><span>${esc(courier?.name || pkg.assignedCourierName || "Atanmadı")}</span></div><div class="da-list-row"><b>Ödeme</b><span>${esc(pkg.paymentMethod || "Belirtilmedi")} · ${esc(pkg.paymentStatus || "Durum yok")}</span></div><div class="da-list-row"><b>Oluşturulma</b><span>${dateTime(pkg.createdAt)}</span></div><div class="da-list-row"><b>Müşteri notu</b><span>${esc(pkg.customerNote || "-")}</span></div><div class="order-items-slot">${products}</div></div>`);
  }

  async function ensureLeaflet() {
    if (window.L) return;
    if (!document.querySelector('link[href="/vendor/leaflet.css"]')) { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/vendor/leaflet.css"; document.head.appendChild(link); }
    await new Promise((resolve, reject) => { const script = document.createElement("script"); script.src = "/vendor/leaflet.js"; script.onload = resolve; script.onerror = reject; document.head.appendChild(script); });
  }

  async function showMapLegacy(focusPackage = null) {
    await ensureLeaflet();
    modal(focusPackage ? `Paket Haritası · ${focusPackage.trackingNo || focusPackage.id}` : "Canlı Operasyon Haritası", '<div id="daMap" class="da-map"></div><p class="text-xs text-slate-500 mt-2"><span class="da-live">● CANLI</span> Mavi: kurye, turuncu: restoran, mor: teslimat</p>', (root) => {
      const map = L.map(root.querySelector("#daMap")).setView([36.8121, 34.6415], 12);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
      const points = [];
      const add = (lat, lng, color, title) => { if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return; L.circleMarker([Number(lat), Number(lng)], { radius: 9, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 }).addTo(map).bindPopup(esc(title)); points.push([Number(lat), Number(lng)]); };
      couriers().forEach((courier) => add(courier.latitude, courier.longitude, "#2563eb", `Kurye: ${courier.name}`));
      restaurants().forEach((restaurant) => add(restaurant.latitude, restaurant.longitude, "#f97316", `Restoran: ${restaurant.name}`));
      if (focusPackage) add(focusPackage.latitude, focusPackage.longitude, "#7c3aed", `Teslimat: ${focusPackage.deliveryAddress || focusPackage.address}`);
      if (points.length) map.fitBounds(points, { padding: [35, 35], maxZoom: 15 });
      setTimeout(() => map.invalidateSize(), 80);
    });
  }

  function normalizeOperationMapData(liveData, focusPackage = null) {
    const restaurantItems = (liveData.restaurants || []).map((restaurant) => ({ ...restaurant, hasCoordinates: hasCoordinates(restaurant) }));
    const liveCouriers = liveData.activeCouriers || [];
    return {
      restaurants: restaurantItems,
      mappedRestaurants: restaurantItems.filter((restaurant) => restaurant.hasCoordinates),
      missingRestaurantLocations: restaurantItems.filter((restaurant) => !restaurant.hasCoordinates),
      activeCouriers: liveCouriers.filter(hasCoordinates),
      activeCouriersWithoutLocation: liveCouriers.filter((courier) => !hasCoordinates(courier)),
      focusPackage,
    };
  }

  function operationMapSummary(data) {
    const missingCount = data.missingRestaurantLocations.length + data.activeCouriersWithoutLocation.length;
    const refreshedAt = new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `<span><b>${data.mappedRestaurants.length}</b> işletme haritada</span><span><b>${data.activeCouriers.length}</b> aktif kurye</span><span><b>${data.restaurants.reduce((sum, item) => sum + Number(item.activeCount || 0), 0)}</b> aktif paket</span>${missingCount ? `<span><b>${missingCount}</b> konum kaydı eksik</span>` : ""}<span class="da-live">● CANLI · <time>${refreshedAt}</time></span>`;
  }

  function operationRestaurantList(data) {
    return `<h3>Tüm Kayıtlı İşletmeler (${data.restaurants.length})</h3>${data.restaurants.map((restaurant) => {
      const color = restaurant.waitingCount ? "#dc2626" : restaurant.activeCount ? "#f97316" : restaurant.hasCoordinates ? "#16a34a" : "#94a3b8";
      const detail = restaurant.hasCoordinates ? `${restaurant.waitingCount} bekleyen · ${restaurant.assignedCount} atanmış · ${restaurant.routeCount} yolda` : "Konum bilgisi eksik";
      return `<button type="button" class="da-operation-business" data-map-restaurant="${esc(restaurant.id)}" ${restaurant.hasCoordinates ? "" : "disabled"}><i style="background:${color}"></i><span><b>${esc(restaurant.name)}</b><small>${esc(restaurant.zone || "Bölge yok")} · ${detail}</small></span><strong>${Number(restaurant.activeCount || 0)}</strong></button>`;
    }).join("")}<div class="da-operation-couriers"><b>Aktif kurye: ${data.activeCouriers.length}</b><br>${data.activeCouriers.length ? data.activeCouriers.map((courier) => esc(courier.name)).join(", ") : "Şu anda aktif kurye yok."}</div>`;
  }

  async function showMap(focusPackage = null, options = {}) {
    await ensureLeaflet();
    const courierOnly = options.mode === "couriers";
    const projectData = (source) => courierOnly ? { ...source, restaurants: [], mappedRestaurants: [], missingRestaurantLocations: [] } : source;
    let data = operationMapData(focusPackage);
    try { data = normalizeOperationMapData(await api("/api/admin/operation-map"), focusPackage); }
    catch (error) { toast(`Canlı harita verisi yenilenemedi; son kayıtlar gösteriliyor. ${error.message}`, "error"); }
    data = projectData(data);
    const legend = courierOnly ? '<div class="da-map-legend"><span><i style="background:#2563eb"></i>Çevrimiçi kurye ve son canlı konumu</span></div>' : '<div class="da-map-legend"><span><i style="background:#16a34a"></i>Paketsiz işletme</span><span><i style="background:#f97316"></i>Aktif paketli işletme</span><span><i style="background:#dc2626"></i>Bekleyen paketli işletme</span><span><i style="background:#2563eb"></i>Aktif kurye</span><span><i style="background:#7c3aed"></i>Teslimat</span></div>';
    const title = focusPackage ? `Paket Haritası · ${focusPackage.trackingNo || focusPackage.id}` : courierOnly ? "Canlı Kurye Haritası" : "Canlı Operasyon Haritası";
    modal(title, `<div class="da-map-summary" data-map-summary>${operationMapSummary(data)}</div><div class="da-operation-layout"><div id="daMap" class="da-map"></div><aside class="da-operation-list" data-map-restaurants>${operationRestaurantList(data)}</aside></div>${legend}`, (root) => {
      const map = L.map(root.querySelector("#daMap")).setView([36.8121, 34.6415], 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
      const markers = L.layerGroup().addTo(map);
      let refreshInFlight = false;
      let refreshQueued = false;
      let refreshTimer = null;
      let firstRender = true;

      const renderLiveData = (nextData) => {
        if (!root.isConnected) return;
        data = nextData;
        root.querySelector("[data-map-summary]").innerHTML = operationMapSummary(data);
        root.querySelector("[data-map-restaurants]").innerHTML = operationRestaurantList(data);
        markers.clearLayers();
        const points = [];
        const restaurantMarkers = new Map();
        const add = (lat, lng, color, popup, radius = 9) => {
          if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
          const point = [Number(lat), Number(lng)];
          const marker = L.circleMarker(point, { radius, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 }).addTo(markers).bindPopup(popup);
          points.push(point);
          return marker;
        };
        data.mappedRestaurants.forEach((restaurant) => {
          const color = restaurant.waitingCount ? "#dc2626" : restaurant.activeCount ? "#f97316" : "#16a34a";
          const marker = add(restaurant.latitude, restaurant.longitude, color, `<b>${esc(restaurant.name)}</b><br>Bölge: ${esc(restaurant.zone || "-")}<br>Aktif paket: <b>${restaurant.activeCount}</b><br>Bekleyen: ${restaurant.waitingCount} · Atanmış: ${restaurant.assignedCount} · Yolda: ${restaurant.routeCount}`, restaurant.activeCount ? 11 : 9);
          if (marker) restaurantMarkers.set(restaurant.id, marker);
        });
        data.activeCouriers.forEach((courier) => {
          const locationLabel = courier.locationFresh === false
            ? "Son bilinen konum (tarayıcı arka planda)"
            : "Canlı konum";
          add(courier.latitude, courier.longitude, "#2563eb", `<b>Kurye: ${esc(courier.name)}</b><br>Durum: ${esc(courier.status || "aktif")}<br>Aktif yük: ${Number(courier.activeLoad || 0)}<br>${locationLabel}: ${esc(dateTime(courier.lastLocationAt))}`);
        });
        if (focusPackage) {
          const deliveryLat = focusPackage.customerLat ?? focusPackage.customerLatitude ?? focusPackage.deliveryLatitude;
          const deliveryLng = focusPackage.customerLng ?? focusPackage.customerLongitude ?? focusPackage.deliveryLongitude;
          add(deliveryLat, deliveryLng, "#7c3aed", `<b>Teslimat</b><br>${esc(focusPackage.deliveryAddress || focusPackage.address || "Adres yok")}`, 10);
        }
        root.querySelectorAll("[data-map-restaurant]").forEach((button) => button.addEventListener("click", () => {
          const marker = restaurantMarkers.get(button.dataset.mapRestaurant);
          if (!marker) return;
          map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15), { animate: true });
          marker.openPopup();
        }));
        if (firstRender && points.length) map.fitBounds(points, { padding: [35, 35], maxZoom: 15 });
        firstRender = false;
      };

      const refresh = async () => {
        if (!root.isConnected || refreshInFlight) { refreshQueued = refreshInFlight; return; }
        refreshInFlight = true;
        try { renderLiveData(projectData(normalizeOperationMapData(await api("/api/admin/operation-map"), focusPackage))); }
        catch { /* Son başarılı görüntüyü koru; sonraki canlı olay veya aralık tekrar dener. */ }
        finally {
          refreshInFlight = false;
          if (refreshQueued) { refreshQueued = false; refresh(); }
        }
      };
      const scheduleRefresh = () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 180);
      };
      state.liveMapRefresh = scheduleRefresh;
      const interval = setInterval(refresh, 5000);
      const observer = new MutationObserver(() => {
        if (root.isConnected) return;
        clearInterval(interval);
        clearTimeout(refreshTimer);
        if (state.liveMapRefresh === scheduleRefresh) state.liveMapRefresh = null;
        map.remove();
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true });
      renderLiveData(data);
      setTimeout(() => map.invalidateSize(), 80);
    }, "da-modal-map");
  }

  function addOrderModal() {
    const restaurantOptions = restaurants().map((restaurant) => `<option value="${esc(restaurant.id)}">${esc(restaurant.name)}</option>`).join("");
    modal("Yeni Sipariş Ekle", `<form id="daOrderForm" class="da-grid"><label class="da-field full"><span>Restoran</span><select name="restaurantId" required><option value="">Seçin</option>${restaurantOptions}</select></label><label class="da-field"><span>Müşteri adı</span><input name="customerName" required></label><label class="da-field"><span>Telefon</span><input name="phone" inputmode="tel"></label><label class="da-field full"><span>Teslimat adresi</span><textarea name="deliveryAddress" rows="3" required></textarea></label><label class="da-field"><span>Sipariş içeriği (isteğe bağlı)</span><input name="packageType" placeholder="Standart Paket"></label><label class="da-field"><span>Tutar</span><input name="orderAmount" type="number" min="0.01" step="0.01" required></label><label class="da-field"><span>Ödeme türü</span><select name="paymentMethod"><option value="paid_online">Online ödendi</option><option value="cash_on_delivery">Kapıda nakit</option><option value="card_on_delivery">Kapıda kart</option></select></label><label class="da-field"><span>Müşteri notu</span><input name="customerNote"></label><div class="da-actions"><button data-close type="button" class="da-secondary">Vazgeç</button><button class="da-primary" type="submit">Siparişi Oluştur ve Ata</button></div></form>`, (root) => {
      root.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); try { hydrate(await api("/api/admin/packages", { method: "POST", body: JSON.stringify(form) })); root.remove(); toast("Sipariş oluşturuldu ve otomatik atama akışına alındı.", "success"); } catch (error) { toast(error.message, "error"); } });
    });
  }

  function editPackage(pkg) {
    const options = couriers().map((courier) => `<option value="${esc(courier.id)}" ${courier.id === pkg.assignedCourierId ? "selected" : ""}>${esc(courier.name)} · ${esc(courier.status)} · ${Number(courier.activeLoad || 0)} paket</option>`).join("");
    modal(`Paket Yönetimi · ${pkg.trackingNo || pkg.id}`, `<div class="da-list"><div class="da-list-row"><div><b>Mevcut durum</b><small>${esc(statusLabels[pkg.status] || pkg.status)}</small></div><span>${esc(pkg.assignedCourierName || courierFor(pkg)?.name || "Atanmadı")}</span></div><form id="daAssign" class="da-grid"><label class="da-field full"><span>Kurye seç</span><select name="courierId"><option value="">Kurye seçin</option>${options}</select></label><div class="da-actions"><button type="button" data-unassign class="da-secondary">Atamayı Kaldır</button><button type="button" data-reassign class="da-secondary">En Yakın Kuryeye Yeniden Ata</button><button class="da-primary" type="submit">Seçilen Kuryeye Ata</button></div></form></div>`, (root) => {
      const apply = async (path, options = {}) => { try { hydrate(await api(path, options)); root.remove(); toast("Paket ataması güncellendi.", "success"); } catch (error) { toast(error.message, "error"); } };
      root.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); const courierId = new FormData(event.currentTarget).get("courierId"); if (!courierId) return toast("Kurye seçin.", "error"); apply(`/api/admin/packages/${encodeURIComponent(pkg.id)}/override`, { method: "POST", body: JSON.stringify({ courierId }) }); });
      root.querySelector("[data-reassign]").addEventListener("click", () => apply(`/api/admin/packages/${encodeURIComponent(pkg.id)}/reassign`, { method: "POST", body: "{}" }));
      root.querySelector("[data-unassign]").addEventListener("click", () => apply(`/api/admin/packages/${encodeURIComponent(pkg.id)}/unassign`, { method: "POST", body: "{}" }));
    });
  }

  async function cancelPackage(pkg) {
    if (!confirm(`${pkg.trackingNo || pkg.id} paketini iptal etmek istediğinize emin misiniz?`)) return;
    try { hydrate(await api(`/api/admin/packages/${encodeURIComponent(pkg.id)}/status`, { method: "PATCH", body: JSON.stringify({ status: "cancelled", failureReason: "Admin iptal etti" }) })); toast("Paket iptal edildi.", "success"); }
    catch (error) { toast(error.message, "error"); }
  }

  function listModal(title, list, renderItem, extra = "") { modal(title, `${extra}<div class="da-list">${list.length ? list.map(renderItem).join("") : '<div class="da-empty">Kayıt bulunamadı.</div>'}</div>`); }

  function courierManagement() {
    const list = couriers();
    modal("Kuryeler", `<div class="flex justify-end mb-3"><button class="da-primary" data-add-courier>Yeni Kurye Ekle</button></div><div class="da-list">${list.map((courier) => `<div class="da-list-row" data-courier-id="${esc(courier.id)}"><div><b>${esc(courier.name)}</b><small>${esc(courier.zone)} · ${esc(courier.status)} · ${Number(courier.activeLoad || 0)} aktif paket</small></div><div class="da-list-actions"><button data-edit-courier>Düzenle</button><button data-availability="${courier.available ? "0" : "1"}">${courier.available ? "Pasife Al" : "Aktif Et"}</button><button data-delete-courier>Sil</button></div></div>`).join("")}</div>`, (root) => {
      root.querySelector("[data-add-courier]").addEventListener("click", addCourierModal);
      root.querySelectorAll("[data-edit-courier]").forEach((button) => button.addEventListener("click", () => editCourierModal(list.find((courier) => courier.id === button.closest("[data-courier-id]").dataset.courierId))));
      root.querySelectorAll("[data-availability]").forEach((button) => button.addEventListener("click", async () => { const courierId = button.closest("[data-courier-id]").dataset.courierId; try { hydrate(await api(`/api/admin/couriers/${encodeURIComponent(courierId)}/availability`, { method: "PATCH", body: JSON.stringify({ available: button.dataset.availability === "1" }) })); root.remove(); courierManagement(); } catch (error) { toast(error.message, "error"); } }));
      root.querySelectorAll("[data-delete-courier]").forEach((button) => button.addEventListener("click", async () => { const courierId = button.closest("[data-courier-id]").dataset.courierId; if (!confirm("Kuryeyi silmek ve aktif paketlerini yeniden atamaya almak istediğinize emin misiniz?")) return; try { absorb(await api(`/api/admin/couriers/${encodeURIComponent(courierId)}`, { method: "DELETE" })); toast("Kurye silindi, uygun paketler yeniden atamaya alındı.", "success"); courierManagement(); } catch (error) { toast(error.message, "error"); } }));
    });
  }

  function editCourierModal(courier) {
    if (!courier) return;
    modal(`Kurye Düzenle · ${courier.name}`, `<form class="da-grid"><label class="da-field"><span>Ad soyad</span><input name="name" value="${esc(courier.name)}" required></label><label class="da-field"><span>Bölge</span><input name="zone" value="${esc(courier.zone)}" required></label><label class="da-field"><span>Kullanıcı adı</span><input name="username" value="${esc(courier.username || "")}" required></label><label class="da-field"><span>Yeni parola (isteğe bağlı)</span><input name="password" type="password"></label><label class="da-field"><span>Paket başı ücret</span><input name="perPackageFee" type="number" step="0.01" min="0" value="${Number(courier.perPackageFee || 0)}"></label><div class="da-actions"><button class="da-primary">Değişiklikleri Kaydet</button></div></form>`, (root) => root.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); try { absorb(await api(`/api/admin/couriers/${encodeURIComponent(courier.id)}`, { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) })); toast("Kurye bilgileri güncellendi.", "success"); courierManagement(); } catch (error) { toast(error.message, "error"); } }));
  }

  function addCourierModal() {
    modal("Yeni Kurye", `<form class="da-grid"><label class="da-field"><span>Ad soyad</span><input name="name" required></label><label class="da-field"><span>Bölge</span><input name="zone" value="Merkez" required></label><label class="da-field"><span>Kullanıcı adı</span><input name="username" required></label><label class="da-field"><span>Parola</span><input name="password" type="password" required></label><label class="da-field"><span>Enlem</span><input name="latitude" type="number" step="any" value="36.8121"></label><label class="da-field"><span>Boylam</span><input name="longitude" type="number" step="any" value="34.6415"></label><div class="da-actions"><button class="da-primary">Kuryeyi Kaydet</button></div></form>`, (root) => root.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); data.available = true; try { hydrate(await api("/api/admin/couriers", { method: "POST", body: JSON.stringify(data) })); root.remove(); toast("Kurye eklendi.", "success"); } catch (error) { toast(error.message, "error"); } }));
  }

  function restaurantManagement() {
    modal("İşletmeler", `<div class="flex justify-end mb-3"><button class="da-primary" data-add-restaurant>Yeni İşletme Ekle</button></div><div class="da-list">${restaurants().map((restaurant) => `<div class="da-list-row" data-restaurant-id="${esc(restaurant.id)}"><div><b>${esc(restaurant.name)}</b><small>${esc(restaurant.zone || "-")} · ${esc(restaurant.phone || restaurant.contactPhone || "")}</small></div><div class="da-list-actions"><button data-location>Konumu Düzenle</button><span class="da-badge">${esc(restaurant.id)}</span></div></div>`).join("")}</div>`, (root) => {
      root.querySelector("[data-add-restaurant]").addEventListener("click", addRestaurantModal);
      root.querySelectorAll("[data-location]").forEach((button) => button.addEventListener("click", () => editRestaurantLocation(restaurants().find((restaurant) => restaurant.id === button.closest("[data-restaurant-id]").dataset.restaurantId))));
    });
  }

  function restaurantCredentialManagement() {
    const list = restaurants();
    modal("Restoran Giriş Bilgileri", `<div class="da-list">${list.length ? list.map((restaurant) => `<div class="da-list-row" data-restaurant-id="${esc(restaurant.id)}"><div><b>${esc(restaurant.name)}</b><small>Kullanıcı adı: ${esc(restaurant.username || "Tanımlı değil")} · ${esc(restaurant.zone || "-")}</small></div><div class="da-list-actions"><button data-edit-credentials>Giriş Bilgilerini Değiştir</button></div></div>`).join("") : '<div class="da-empty">Kayıtlı restoran bulunamadı.</div>'}</div>`, (root) => {
      root.querySelectorAll("[data-edit-credentials]").forEach((button) => button.addEventListener("click", () => {
        const restaurantId = button.closest("[data-restaurant-id]").dataset.restaurantId;
        editRestaurantCredentials(list.find((restaurant) => restaurant.id === restaurantId));
      }));
    });
  }

  function editRestaurantCredentials(restaurant) {
    if (!restaurant) return;
    modal(`Restoran Giriş Bilgileri · ${restaurant.name}`, `<form class="da-grid"><label class="da-field full"><span>Kullanıcı adı</span><input name="username" value="${esc(restaurant.username || "")}" minlength="3" autocomplete="off" required></label><label class="da-field"><span>Yeni parola</span><input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="Değişmeyecekse boş bırakın"></label><label class="da-field"><span>Yeni parola tekrar</span><input name="passwordConfirm" type="password" minlength="8" autocomplete="new-password" placeholder="Yeni parolayı tekrar yazın"></label><div class="da-field full"><span>Bilgi</span><small>Parola değiştirildiğinde güvenlik için bu restorana ait mevcut oturumlar kapatılır. Kullanıcı adı tek başına değiştirilirse açık oturumlar devam eder.</small></div><div class="da-actions"><button type="button" data-close class="da-secondary">Vazgeç</button><button class="da-primary">Giriş Bilgilerini Kaydet</button></div></form>`, (root) => root.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (values.password !== values.passwordConfirm) return toast("Yeni parolalar birbiriyle aynı değil.", "error");
      if (values.password && String(values.password).length < 8) return toast("Yeni parola en az 8 karakter olmalı.", "error");
      try {
        const result = await api(`/api/admin/restaurants/${encodeURIComponent(restaurant.id)}/credentials`, {
          method: "PATCH",
          body: JSON.stringify({ username: values.username, password: values.password }),
        });
        hydrate(result);
        root.remove();
        toast(result.passwordChanged ? "Kullanıcı adı ve parola güncellendi; eski restoran oturumları kapatıldı." : "Restoran kullanıcı adı güncellendi.", "success");
      } catch (error) { toast(error.message, "error"); }
    }));
  }

  function editRestaurantLocation(restaurant) {
    if (!restaurant) return;
    modal(`İşletme Konumu · ${restaurant.name}`, `<form class="da-grid"><label class="da-field"><span>Enlem</span><input name="latitude" type="number" step="any" value="${esc(restaurant.latitude ?? "")}" required></label><label class="da-field"><span>Boylam</span><input name="longitude" type="number" step="any" value="${esc(restaurant.longitude ?? "")}" required></label><div class="da-actions"><button class="da-primary">Konumu Kaydet</button></div></form>`, (root) => root.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); try { hydrate(await api(`/api/admin/restaurants/${encodeURIComponent(restaurant.id)}/location`, { method: "PUT", body: JSON.stringify(values) })); root.remove(); toast("İşletme konumu güncellendi ve atama mesafeleri yeniden hesaplandı.", "success"); } catch (error) { toast(error.message, "error"); } }));
  }

  function addRestaurantModal() {
    modal("Yeni İşletme", `<form class="da-grid"><label class="da-field"><span>İşletme adı</span><input name="name" required></label><label class="da-field"><span>Bölge</span><input name="zone" value="Merkez" required></label><label class="da-field"><span>Kullanıcı adı</span><input name="username" required></label><label class="da-field"><span>Parola</span><input name="password" type="password" required></label><label class="da-field"><span>Telefon</span><input name="phone"></label><label class="da-field"><span>Adres</span><input name="address"></label><label class="da-field"><span>Enlem</span><input name="latitude" type="number" step="any" value="36.8121"></label><label class="da-field"><span>Boylam</span><input name="longitude" type="number" step="any" value="34.6415"></label><div class="da-actions"><button class="da-primary">İşletmeyi Kaydet</button></div></form>`, (root) => root.querySelector("form").addEventListener("submit", async (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget)); try { hydrate(await api("/api/admin/restaurants", { method: "POST", body: JSON.stringify(data) })); root.remove(); toast("İşletme eklendi.", "success"); } catch (error) { toast(error.message, "error"); } }));
  }

  function accountReportModal(rangeMode = false, title = "") {
    const root = modal(title || (rangeMode ? "İşletme Tarih Aralığı Raporu" : "Tüm İşletmeler Sipariş Raporu"), '<div data-admin-account-report><div class="da-empty">Rapor hazırlanıyor...</div></div>', null, "da-report-modal");
    const container = root.querySelector("[data-admin-account-report]");
    let selectedDate = localDateKey();
    let periodFilter = rangeMode ? "range" : "day";
    const defaultRangeStart = new Date(`${selectedDate}T12:00:00.000Z`);
    defaultRangeStart.setUTCDate(defaultRangeStart.getUTCDate() - 6);
    let startDate = defaultRangeStart.toISOString().slice(0, 10);
    let endDate = selectedDate;
    let statusFilter = "all";
    let paymentFilter = "all";
    let restaurantFilter = "";
    const statusMeta = (status) => ({
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

    const bind = () => {
      container.querySelector("[data-report-filter]")?.addEventListener("submit", (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        selectedDate = String(form.get("date") || localDateKey());
        periodFilter = rangeMode ? "range" : String(form.get("period") || "day");
        startDate = String(form.get("startDate") || startDate);
        endDate = String(form.get("endDate") || endDate);
        if (rangeMode && startDate > endDate) return toast("Başlangıç tarihi bitiş tarihinden sonra olamaz.", "error");
        statusFilter = String(form.get("status") || "all");
        paymentFilter = String(form.get("payment") || "all");
        restaurantFilter = String(form.get("restaurantId") || "");
        load();
      });
      container.querySelectorAll("[data-report-day]").forEach((button) => button.addEventListener("click", () => { selectedDate = button.dataset.reportDay; load(); }));
      container.querySelector("[data-report-print]")?.addEventListener("click", () => window.print());
    };
    const render = (data) => {
      selectedDate = data.selectedDate;
      periodFilter = data.period || periodFilter;
      startDate = data.rangeStart || startDate;
      endDate = data.rangeEnd || endDate;
      const summary = data.summary || {};
      const rows = data.packages || [];
      const history = data.history || [];
      const reportRestaurants = data.restaurants || restaurants();
      restaurantFilter = data.selectedRestaurantId || restaurantFilter;
      const selectedRestaurant = reportRestaurants.find((restaurant) => restaurant.id === restaurantFilter);
      const displayedTotalOrders = Number(summary.totalOrders || 0);
      container.innerHTML = `
        <form data-report-filter class="da-report-controls ${rangeMode ? "is-range" : ""}">
          <label>İşletme<select name="restaurantId"><option value="">Tüm işletmeler</option>${reportRestaurants.map((restaurant) => `<option value="${esc(restaurant.id)}">${esc(restaurant.name)}${restaurant.zone ? ` · ${esc(restaurant.zone)}` : ""}</option>`).join("")}</select></label>
          ${rangeMode
            ? `<label>Başlangıç tarihi<input name="startDate" type="date" value="${esc(startDate)}" max="${esc(data.currentDate)}" required></label><label>Bitiş tarihi<input name="endDate" type="date" value="${esc(endDate)}" max="${esc(data.currentDate)}" required></label>`
            : `<label>Rapor dönemi<select name="period"><option value="day">Günlük</option><option value="week">Haftalık</option></select></label><label>Rapor tarihi<input name="date" type="date" value="${esc(selectedDate)}" max="${esc(data.currentDate)}"></label>`}
          <label>Sipariş durumu<select name="status"><option value="all">Tüm siparişler</option><option value="delivered">Teslim edilenler</option><option value="cancelled">İptal / reddedilenler</option><option value="active">Devam edenler</option><option value="failed">Teslim edilemeyenler</option></select></label>
          <label>Ödeme türü<select name="payment"><option value="all">Tüm ödemeler</option><option value="cash">Nakit</option><option value="card">Kapıda kart</option><option value="online">Online</option><option value="restaurant">Restoran tahsilatı</option><option value="other">Diğer</option></select></label>
          <button class="da-primary" type="submit">Filtrele</button>
        </form>
        <div class="da-report-note"><b>Rapor kapsamı:</b> ${esc(selectedRestaurant?.name || "Tüm kayıtlı işletmeler")} · <b>${rangeMode ? "Tarih aralığı" : periodFilter === "week" ? "Hafta aralığı" : "Gün sınırı"}:</b> ${rangeMode || periodFilter === "week" ? `${esc(data.rangeStart)} – ${esc(data.rangeEnd)} · Türkiye saatiyle her gün 00.00–23.59` : "Türkiye saatiyle 00.00–23.59"}</div>
        <div class="da-report-cards">
          <div class="da-report-card is-blue"><span>${rangeMode ? "İptaller dahil toplam" : "Toplam sipariş"}</span><strong>${displayedTotalOrders}</strong><small>${Number(summary.activeCount || 0)} devam ediyor</small></div>
          <div class="da-report-card is-green"><span>Teslim edildi</span><strong>${Number(summary.deliveredCount || 0)}</strong><small>${money(summary.deliveredRevenue || 0)} ciro</small></div>
          <div class="da-report-card is-red"><span>İptal / ret</span><strong>${Number(summary.cancelledCount || 0)}</strong><small>${money(summary.cancelledAmount || 0)} iptal tutarı</small></div>
          <div class="da-report-card is-amber"><span>Teslim edilemedi</span><strong>${Number(summary.failedCount || 0)}</strong><small>İnceleme gereken kayıt</small></div>
          <div class="da-report-card"><span>Nakit</span><strong>${Number(summary.cashCount || 0)}</strong><small>${money(summary.cashAmount || 0)}</small></div>
          <div class="da-report-card"><span>Kapıda kart</span><strong>${Number(summary.cardCount || 0)}</strong><small>${money(summary.cardAmount || 0)}</small></div>
          <div class="da-report-card"><span>Online ödeme</span><strong>${Number(summary.onlineCount || 0)}</strong><small>${money(summary.onlineAmount || 0)}</small></div>
          <div class="da-report-card"><span>Restoran / diğer</span><strong>${Number(summary.restaurantCount || 0) + Number(summary.otherCount || 0)}</strong><small>${money(Number(summary.restaurantAmount || 0) + Number(summary.otherAmount || 0))}</small></div>
        </div>
        <div class="da-report-section-title"><b>${rangeMode ? "Günlük dağılım" : `Geçmiş ${periodFilter === "week" ? "haftalar" : "günler"}`}</b><span>${rangeMode ? `${history.length} kayıtlı gün` : `Son ${history.length} dönem`}</span></div>
        <div class="da-report-history">${history.map((item) => `<button type="button" ${rangeMode ? "disabled" : `data-report-day="${esc(item.date)}"`} class="da-report-day ${!rangeMode && item.date === (periodFilter === "week" ? data.rangeStart : selectedDate) ? "is-selected" : ""}"><strong>${esc(item.date)}${item.endDate ? ` – ${esc(item.endDate)}` : ""}</strong><span>${item.totalOrders} sipariş · ${item.deliveredCount} teslim · ${item.cancelledCount} iptal · ${item.activeCount} aktif</span><span>${money(item.deliveredRevenue)} teslim cirosu</span></button>`).join("") || '<span>Bu aralıkta kayıt bulunamadı.</span>'}</div>
        <div class="mt-3 border rounded-lg overflow-auto" style="max-height:340px"><table class="da-report-table"><thead><tr><th>Paket</th><th>İşletme</th><th>Müşteri</th><th>Durum</th><th>Ödeme</th><th>Kurye</th><th>Saat</th><th>Tutar</th></tr></thead><tbody>${rows.map((pkg) => { const status = statusMeta(pkg.status); return `<tr><td><b>${esc(pkg.trackingNo || pkg.id)}</b><div>${esc(pkg.sourcePlatform || "Telefon")}</div></td><td>${esc(pkg.restaurantName)}</td><td>${esc(pkg.customerName)}</td><td><span class="da-report-pill" style="${status[1]}">${esc(status[0])}</span></td><td>${esc(paymentLabel(pkg.paymentBucket))}<div>${esc(pkg.paymentMethod)}</div></td><td>${esc(pkg.courierName)}</td><td>${dateTime(pkg.createdAt)}</td><td><b>${money(pkg.orderAmount)}</b></td></tr>`; }).join("") || '<tr><td colspan="8" class="da-empty">Bu filtrelerde sipariş bulunamadı.</td></tr>'}</tbody></table></div>
        <div class="da-report-footer"><span>Listede ${rows.length} kayıt gösteriliyor.</span><button data-report-print class="da-primary" type="button">Yazdır</button></div>`;
      if (!rangeMode) container.querySelector('[name="period"]').value = periodFilter;
      container.querySelector('[name="status"]').value = statusFilter;
      container.querySelector('[name="payment"]').value = paymentFilter;
      container.querySelector('[name="restaurantId"]').value = restaurantFilter;
      bind();
    };
    const load = async () => {
      container.style.opacity = ".55";
      try {
        const query = new URLSearchParams({ date: selectedDate, period: periodFilter, status: statusFilter, payment: paymentFilter });
        if (rangeMode) {
          query.set("startDate", startDate);
          query.set("endDate", endDate);
        }
        if (restaurantFilter) query.set("restaurantId", restaurantFilter);
        render(await api(`/api/admin/reports/account?${query}`));
      } catch (error) { container.innerHTML = `<div class="da-empty" style="color:#b91c1c">${esc(error.message)}</div>`; }
      finally { container.style.opacity = "1"; }
    };
    load();
  }

  function reportModal(title, selected = packages()) {
    const delivered = selected.filter((pkg) => pkg.status === "delivered");
    const total = delivered.reduce((sum, pkg) => sum + Number(pkg.orderAmount || 0), 0);
    modal(title, `<div class="da-kpi"><div><strong>${selected.length}</strong><span>Toplam paket</span></div><div><strong>${delivered.length}</strong><span>Teslim edilen</span></div><div><strong>${money(total)}</strong><span>Teslimat cirosu</span></div></div><div class="da-list">${selected.slice(0, 100).map((pkg) => `<div class="da-list-row"><div><b>${esc(pkg.trackingNo || pkg.id)} · ${esc(pkg.restaurantName)}</b><small>${dateTime(pkg.createdAt)} · ${esc(statusLabels[pkg.status] || pkg.status)}</small></div><b>${money(pkg.orderAmount)}</b></div>`).join("")}</div>`);
  }

  async function courierPerformanceManagement(selectedDate = localDateKey(), allHistory = false) {
    try {
      const scope = allHistory ? "all" : selectedDate;
      const result = await api(`/api/admin/courier-performance?date=${encodeURIComponent(scope)}`);
      const rows = result.couriers || [];
      modal("Kurye Performans ve Kazanç", `<form data-performance-filter class="da-grid mb-4"><label class="da-field"><span>Rapor günü</span><input name="date" type="date" value="${esc(selectedDate)}"></label><div class="da-actions"><button class="da-secondary" type="button" data-all-history>Tüm Geçmiş</button><button class="da-primary">Günü Getir</button></div></form><div class="da-route-title">${allHistory ? "Tüm geçmiş" : esc(selectedDate)} performansı</div><div class="da-list">${rows.length ? rows.map((courier) => `<div class="da-list-row"><div><b>${esc(courier.name)}</b><small>${esc(courier.zone)} · ${esc(courier.status)}</small></div><span><b>${Number(courier.deliveredCount || 0)}</b> teslimat · ${Number(courier.totalCount || 0)} toplam</span></div>`).join("") : '<div class="da-empty">Bu tarih için kurye kaydı bulunamadı.</div>'}</div>`, (root) => {
        root.querySelector("[data-performance-filter]").addEventListener("submit", (event) => {
          event.preventDefault();
          const date = new FormData(event.currentTarget).get("date") || localDateKey();
          courierPerformanceManagement(date, false);
        });
        root.querySelector("[data-all-history]").addEventListener("click", () => courierPerformanceManagement(selectedDate, true));
      });
    } catch (error) { toast(error.message, "error"); }
  }

  function absorb(result) {
    const next = result?.state || result;
    if (next?.packages || next?.couriers || next?.restaurants) hydrate(next);
    return result;
  }

  async function shiftManagement() {
    const today = new Date().toISOString().slice(0, 10);
    const open = async (selectedDate = today) => {
      const result = await api(`/api/admin/shift-plans?date=${encodeURIComponent(selectedDate)}`);
      const courierOptions = couriers().map((courier) => `<option value="${esc(courier.id)}">${esc(courier.name)} · ${esc(courier.zone)}</option>`).join("");
      modal("Haftalık Kurye Vardiya Yönetimi", `<form data-shift-filter class="da-grid mb-4"><label class="da-field"><span>Görüntülenecek gün</span><input name="selectedDate" type="date" value="${esc(selectedDate)}"></label><div class="da-actions"><button class="da-secondary">Günü Getir</button></div></form><form data-shift-create class="da-grid"><label class="da-field"><span>Kurye</span><select name="courierId" required><option value="">Seçin</option>${courierOptions}</select></label><label class="da-field"><span>Tarih</span><input name="planDate" type="date" value="${esc(selectedDate)}" required></label><label class="da-field"><span>Başlangıç</span><input name="startTime" type="time" value="10:00" required></label><label class="da-field"><span>Bitiş</span><input name="endTime" type="time" value="18:00" required></label><div class="da-actions"><button class="da-primary">Vardiya Teklifi Gönder</button></div></form><div class="da-route-title mt-5">${esc(selectedDate)} planları</div><div class="da-list">${(result.shiftPlans || []).length ? result.shiftPlans.map((plan) => `<div class="da-list-row" data-shift-id="${esc(plan.id)}"><div><b>${esc(plan.courierName)}</b><small>${esc(plan.zone)} · ${esc(plan.startTime)}-${esc(plan.endTime)} · ${esc(plan.status)}</small></div><div class="da-list-actions"><button data-delete-shift>Planı Sil</button></div></div>`).join("") : '<div class="da-empty">Bu gün için vardiya planı yok. Yukarıdaki formdan oluşturabilirsiniz.</div>'}</div>`, (root) => {
        root.querySelector("[data-shift-filter]").addEventListener("submit", (event) => { event.preventDefault(); open(new FormData(event.currentTarget).get("selectedDate")).catch((error) => toast(error.message, "error")); });
        root.querySelector("[data-shift-create]").addEventListener("submit", async (event) => { event.preventDefault(); try { absorb(await api("/api/admin/shift-plans", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) })); toast("Vardiya planı kaydedildi ve kuryeye onay teklifi gönderildi.", "success"); await open(new FormData(event.currentTarget).get("planDate")); } catch (error) { toast(error.message, "error"); } });
        root.querySelectorAll("[data-delete-shift]").forEach((button) => button.addEventListener("click", async () => { try { absorb(await api(`/api/admin/shift-plans/${encodeURIComponent(button.closest("[data-shift-id]").dataset.shiftId)}`, { method: "DELETE" })); toast("Vardiya planı silindi.", "success"); await open(selectedDate); } catch (error) { toast(error.message, "error"); } }));
      });
    };
    await open();
  }

  function recordManagement(config) {
    const records = (state.data?.managementRecords || []).filter((item) => item.recordType === config.type);
    const subjects = config.subject === "restaurant" ? restaurants() : config.subject === "courier" ? couriers() : [];
    const subjectOptions = subjects.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.zone || "-")}</option>`).join("");
    modal(config.title, `<form data-record-form class="da-grid"><input type="hidden" name="recordType" value="${esc(config.type)}"><input type="hidden" name="subjectType" value="${esc(config.subject || "system")}">${config.subject ? `<label class="da-field full"><span>${config.subject === "courier" ? "Kurye" : "İşletme"}</span><select name="subjectId" required><option value="">Seçin</option>${subjectOptions}</select></label>` : ""}<label class="da-field full"><span>Başlık / işlem nedeni</span><input name="title" required placeholder="${esc(config.placeholder || "Kayıt açıklaması")}"></label>${config.amount ? '<label class="da-field"><span>Tutar (+ ödül, - ceza)</span><input name="amount" type="number" step="0.01" value="0"></label>' : '<input type="hidden" name="amount" value="0">'}${config.dates !== false ? '<label class="da-field"><span>Başlangıç / işlem tarihi</span><input name="startDate" type="date"></label><label class="da-field"><span>Bitiş tarihi</span><input name="endDate" type="date"></label>' : ""}<label class="da-field full"><span>Not</span><textarea name="note" rows="2"></textarea></label><div class="da-actions"><button class="da-primary">Kaydı Veritabanına Ekle</button></div></form><div class="da-route-title mt-5">Kayıtlar</div><div class="da-list">${records.length ? records.map((item) => `<div class="da-list-row" data-record-id="${esc(item.id)}"><div><b>${esc(item.title)}</b><small>${esc(subjects.find((subject) => subject.id === item.subjectId)?.name || item.subjectId || "Sistem")} · ${esc(item.startDate || "Tarihsiz")}${item.endDate ? ` / ${esc(item.endDate)}` : ""} · ${esc(item.status)}</small>${item.note ? `<small>${esc(item.note)}</small>` : ""}</div><div class="da-list-actions">${item.amount ? `<b>${money(item.amount)}</b>` : ""}<button data-complete>${item.status === "completed" ? "Aktife Al" : "Tamamla"}</button><button data-delete-record>Sil</button></div></div>`).join("") : '<div class="da-empty">Henüz kayıt yok. Formdan gerçek bir kayıt oluşturabilirsiniz.</div>'}</div>`, (root) => {
      root.querySelector("[data-record-form]").addEventListener("submit", async (event) => { event.preventDefault(); try { absorb(await api("/api/admin/management-records", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) })); toast("Kayıt veritabanına işlendi.", "success"); recordManagement(config); } catch (error) { toast(error.message, "error"); } });
      root.querySelectorAll("[data-complete]").forEach((button) => button.addEventListener("click", async () => { const item = records.find((record) => record.id === button.closest("[data-record-id]").dataset.recordId); try { absorb(await api(`/api/admin/management-records/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ status: item.status === "completed" ? "active" : "completed" }) })); recordManagement(config); } catch (error) { toast(error.message, "error"); } }));
      root.querySelectorAll("[data-delete-record]").forEach((button) => button.addEventListener("click", async () => { try { absorb(await api(`/api/admin/management-records/${encodeURIComponent(button.closest("[data-record-id]").dataset.recordId)}`, { method: "DELETE" })); toast("Kayıt silindi.", "success"); recordManagement(config); } catch (error) { toast(error.message, "error"); } }));
    });
  }

  async function creditManagement(title = "İşletme Paket ve Kontör İşlemleri") {
    const accounts = state.data?.creditAccounts || [];
    const selectedId = accounts[0]?.restaurantId || "";
    const render = async (restaurantId = selectedId) => {
      const account = accounts.find((item) => item.restaurantId === restaurantId) || accounts[0] || {};
      let movements = [];
      if (account.restaurantId) {
        try {
          const result = await api(`/api/admin/restaurants/${encodeURIComponent(account.restaurantId)}/credits`);
          movements = result.movements || [];
          const index = state.data.creditAccounts.findIndex((item) => item.restaurantId === account.restaurantId);
          if (index >= 0 && result.account) state.data.creditAccounts[index] = result.account;
          Object.assign(account, result.account || {});
        } catch (error) {
          toast(error.message, "error");
        }
      }
      const options = accounts.map((item) => `<option value="${esc(item.restaurantId)}" ${item.restaurantId === account.restaurantId ? "selected" : ""}>${esc(item.restaurantName)} · ${Number(item.balance || 0)} kontör</option>`).join("");
      modal(title, `<form data-credit-form class="da-grid"><label class="da-field full"><span>İşletme</span><select name="restaurantId" required>${options}</select></label><div class="da-kpi full"><div><strong>${Number(account.balance || 0)}</strong><span>Mevcut kontör</span></div></div><label class="da-field"><span>Kontör değişimi</span><input name="amount" type="number" step="1" required placeholder="+100 veya -10"></label><label class="da-field"><span>Açıklama</span><input name="reason" required placeholder="Paket yükleme, düzeltme, iade"></label><div class="da-actions"><button class="da-primary">Kontörü İşle</button></div></form><div class="da-route-title mt-5">Son Hareketler</div><div class="da-list">${movements.length ? movements.map((item) => `<div class="da-list-row"><div><b>${Number(item.amount || 0) > 0 ? "+" : ""}${Number(item.amount || 0)} kontör</b><small>${esc(item.reason)} · ${dateTime(item.created_at || item.createdAt)}</small></div></div>`).join("") : '<div class="da-empty">Bu işletme için kontör hareketi yok.</div>'}</div>`, (root) => {
        root.querySelector('[name="restaurantId"]').addEventListener("change", (event) => render(event.target.value));
        root.querySelector("[data-credit-form]").addEventListener("submit", async (event) => {
          event.preventDefault();
          const form = Object.fromEntries(new FormData(event.currentTarget));
          const eventKey = `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          try {
            await api(`/api/admin/restaurants/${encodeURIComponent(form.restaurantId)}/credits`, { method: "POST", body: JSON.stringify({ amount: Number(form.amount), reason: form.reason, eventKey }) });
            await load(true);
            toast("Kontör bakiyesi güncellendi.", "success");
            creditManagement(title);
          } catch (error) {
            toast(error.message, "error");
          }
        });
      });
    };
    if (!accounts.length) return modal(title, '<div class="da-empty">Kayıtlı işletme bulunamadı.</div>');
    await render(selectedId);
  }

  function cashManagement(title = "Kurye Tahsilat Mutabakatı") {
    const items = state.data?.cashReconciliations || [];
    modal(title, `<div class="da-list">${items.length ? items.map((item) => `<form class="da-list-row" data-cash-id="${esc(item.id)}"><div><b>${esc(item.courierName)}</b><small>${esc(item.reportDate)} · Beklenen ${money(item.expectedCash)} · Fark ${money(item.variance)}</small></div><div class="da-list-actions"><input name="reportedCash" type="number" step="0.01" value="${Number(item.reportedCash || 0)}" class="w-28 border rounded p-2"><select name="status" class="border rounded p-2"><option value="pending" ${item.status === "pending" ? "selected" : ""}>Bekliyor</option><option value="approved" ${item.status === "approved" ? "selected" : ""}>Onaylandı</option><option value="rejected" ${item.status === "rejected" ? "selected" : ""}>Reddedildi</option></select><input name="adminNote" value="${esc(item.adminNote)}" placeholder="Admin notu" class="border rounded p-2"><button>Kaydet</button></div></form>`).join("") : '<div class="da-empty">Nakit mutabakatı kurye gün sonu yaptığında otomatik oluşur.</div>'}</div>`, (root) => root.querySelectorAll("[data-cash-id]").forEach((form) => form.addEventListener("submit", async (event) => { event.preventDefault(); try { absorb(await api(`/api/admin/cash-reconciliations/${encodeURIComponent(form.dataset.cashId)}`, { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(form))) })); toast("Nakit mutabakatı kaydedildi.", "success"); cashManagement(title); } catch (error) { toast(error.message, "error"); } })));
  }

  function courierPricingManagement() {
    modal("Kurye Paket Başı Ücretlendirme", `<div class="da-list">${couriers().map((courier) => `<form class="da-list-row" data-pricing-courier="${esc(courier.id)}"><div><b>${esc(courier.name)}</b><small>${esc(courier.zone)}</small></div><div class="da-list-actions"><input name="perPackageFee" type="number" step="0.01" min="0" value="${Number(courier.perPackageFee || 0)}" class="w-32 border rounded p-2"><button>Ücreti Kaydet</button></div></form>`).join("")}</div>`, (root) => root.querySelectorAll("[data-pricing-courier]").forEach((form) => form.addEventListener("submit", async (event) => { event.preventDefault(); const courier = couriers().find((item) => item.id === form.dataset.pricingCourier); try { absorb(await api(`/api/admin/couriers/${encodeURIComponent(courier.id)}`, { method: "PUT", body: JSON.stringify({ name: courier.name, username: courier.username, zone: courier.zone, perPackageFee: new FormData(form).get("perPackageFee") }) })); toast("Kurye ücreti veritabanında güncellendi.", "success"); courierPricingManagement(); } catch (error) { toast(error.message, "error"); } })));
  }

  function zoneManagement() {
    modal("Bölge Yönetimi", `<form data-zone-form class="da-grid"><label class="da-field full"><span>Yeni bölge adı</span><input name="name" required></label><div class="da-actions"><button class="da-primary">Bölge Ekle</button></div></form><div class="da-list mt-5">${(state.data.zones || []).map((zone) => `<div class="da-list-row" data-zone="${esc(zone.name)}"><div><b>${esc(zone.name)}</b><small>${zone.courierCount} kurye · ${zone.packageCount} paket · ${zone.waitingCount} bekleyen</small></div><div class="da-list-actions"><button data-delete-zone>Sil</button></div></div>`).join("")}</div>`, (root) => {
      root.querySelector("[data-zone-form]").addEventListener("submit", async (event) => { event.preventDefault(); try { absorb(await api("/api/admin/zones", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) })); toast("Bölge eklendi.", "success"); zoneManagement(); } catch (error) { toast(error.message, "error"); } });
      root.querySelectorAll("[data-delete-zone]").forEach((button) => button.addEventListener("click", async () => { try { absorb(await api(`/api/admin/zones/${encodeURIComponent(button.closest("[data-zone]").dataset.zone)}`, { method: "DELETE" })); zoneManagement(); } catch (error) { toast(error.message, "error"); } }));
    });
  }

  function courierEarningsManagement(title = "Kurye Hakediş ve Kazanç Yönetimi") {
    const earnings = state.data?.courierEarnings || [];
    modal(title, `<form data-generate-earnings class="da-grid"><label class="da-field"><span>Tarih</span><input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label><label class="da-field"><span>Kurye (boşsa tümü)</span><select name="courierId"><option value="">Tüm kuryeler</option>${couriers().map((courier) => `<option value="${esc(courier.id)}">${esc(courier.name)}</option>`).join("")}</select></label><div class="da-actions"><button class="da-primary">Hakedişleri Hesapla / Güncelle</button></div></form><div class="da-list mt-5">${earnings.length ? earnings.map((item) => `<div class="da-list-row" data-earning-id="${esc(item.id)}"><div><b>${esc(item.courierName)}</b><small>${esc(item.reportDate)} · ${item.deliveredPackageCount} paket · ${esc(item.paymentStatus)}</small></div><div class="da-list-actions"><b>${money(item.totalPayable)}</b>${item.paymentStatus !== "paid" ? '<button data-mark-paid>Ödendi İşaretle</button>' : ""}</div></div>`).join("") : '<div class="da-empty">Seçilen gün için hakediş yok. Hesapla düğmesini kullanın.</div>'}</div>`, (root) => {
      root.querySelector("[data-generate-earnings]").addEventListener("submit", async (event) => { event.preventDefault(); try { const result = await api("/api/admin/courier-earnings/generate", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); absorb(result); if (result.courierEarnings) state.data.courierEarnings = result.courierEarnings; toast("Hakedişler teslim edilen paketlerden hesaplandı.", "success"); courierEarningsManagement(title); } catch (error) { toast(error.message, "error"); } });
      root.querySelectorAll("[data-mark-paid]").forEach((button) => button.addEventListener("click", async () => { try { const result = await api(`/api/admin/courier-earnings/${encodeURIComponent(button.closest("[data-earning-id]").dataset.earningId)}/mark-paid`, { method: "POST", body: JSON.stringify({ adminNote: "Admin panelinden ödendi" }) }); absorb(result); await load(true); courierEarningsManagement(title); } catch (error) { toast(error.message, "error"); } }));
    });
  }

  function summaryListModal(title, items, renderItem, emptyMessage = "Bu bölüm için kayıt bulunamadı.") {
    modal(title, `<div class="da-list">${items.length ? items.map(renderItem).join("") : `<div class="da-empty">${esc(emptyMessage)}</div>`}</div>`);
  }

  function courierStatusReport() {
    const items = couriers();
    summaryListModal("Kurye Durum Raporu", items, (courier) => `<div class="da-list-row"><div><b>${esc(courier.name)}</b><small>${esc(courier.zone || "Bölgesiz")} · Son konum ${dateTime(courier.lastLocationAt)}</small></div><div class="da-list-actions"><span class="da-badge">${esc(courier.status || "offline")}</span><b>${Number(courier.activeLoad || 0)} aktif paket</b></div></div>`, "Kayıtlı kurye bulunamadı.");
  }

  function courierCashReport() {
    const items = state.data?.cashReconciliations || [];
    const expected = items.reduce((sum, item) => sum + Number(item.expectedCash || 0), 0);
    const reported = items.reduce((sum, item) => sum + Number(item.reportedCash || 0), 0);
    modal("Kurye Nakitleri Raporu", `<div class="da-kpi"><div><strong>${money(expected)}</strong><span>Beklenen nakit</span></div><div><strong>${money(reported)}</strong><span>Bildirilen nakit</span></div><div><strong>${money(reported - expected)}</strong><span>Toplam fark</span></div></div><div class="da-list">${items.length ? items.map((item) => `<div class="da-list-row"><div><b>${esc(item.courierName)}</b><small>${esc(item.reportDate)} · ${esc(item.status || "pending")}</small></div><div class="da-list-actions"><span>Beklenen ${money(item.expectedCash)}</span><b>${money(item.reportedCash)}</b></div></div>`).join("") : '<div class="da-empty">Henüz gün sonu nakit kaydı yok.</div>'}</div>`);
  }

  function deliveryTrackingReport() {
    const selected = packages().filter((pkg) => pkg.assignedCourierId || pkg.assignedCourierName || ["delivered", "failed", "cancelled", "canceled"].includes(pkg.status));
    summaryListModal("İşletme-Kurye Teslim Takibi", selected, (pkg) => `<div class="da-list-row"><div><b>${esc(pkg.trackingNo || pkg.id)} · ${esc(pkg.restaurantName || "İşletme yok")}</b><small>${esc(pkg.customerName || "Müşteri yok")} · ${dateTime(pkg.createdAt)}</small></div><div class="da-list-actions"><span>${esc(pkg.assignedCourierName || courierFor(pkg)?.name || "Kurye atanmadı")}</span><b>${esc(statusLabels[pkg.status] || pkg.status)}</b></div></div>`, "Henüz işletme-kurye teslim kaydı yok.");
  }

  function courierPoolEligibility() {
    const eligible = couriers().map((courier) => ({ ...courier, poolEligible: courier.available !== false && !["offline", "inactive"].includes(courier.status) && Number(courier.activeLoad || 0) > 0 && Number(courier.activeLoad || 0) < 2 }));
    summaryListModal("Kurye Havuz Uygunlukları", eligible, (courier) => `<div class="da-list-row"><div><b>${esc(courier.name)}</b><small>${esc(courier.zone || "Bölgesiz")} · ${Number(courier.activeLoad || 0)} aktif paket</small></div><div class="da-list-actions"><span class="da-badge">${courier.poolEligible ? "Havuzdan 1 ek paket alabilir" : "Şu anda uygun değil"}</span></div></div>`, "Kayıtlı kurye bulunamadı.");
  }

  function poolPackageHistory() {
    const selected = packages().filter((pkg) => normalize(`${pkg.assignmentReason || ""} ${pkg.status || ""}`).includes("havuz") || pkg.status === "awaiting_assignment");
    summaryListModal("Havuz Sipariş Geçmişi", selected, (pkg) => `<div class="da-list-row"><div><b>${esc(pkg.trackingNo || pkg.id)} · ${esc(pkg.restaurantName || "İşletme yok")}</b><small>${esc(pkg.assignmentReason || "Atama bekliyor")} · ${dateTime(pkg.createdAt)}</small></div><div class="da-list-actions"><span>${esc(pkg.assignedCourierName || "Atanmamış")}</span><b>${esc(statusLabels[pkg.status] || pkg.status)}</b></div></div>`, "Havuzda veya havuz geçmişinde paket bulunamadı.");
  }

  function detailedPackageReport() {
    summaryListModal("Detaylı Sipariş Raporu", packages(), (pkg) => `<div class="da-list-row"><div><b>${esc(pkg.trackingNo || pkg.id)} · ${esc(pkg.restaurantName || "İşletme yok")}</b><small>${esc(pkg.customerName || "Müşteri yok")} · ${esc(pkg.deliveryAddress || pkg.address || "Adres yok")} · ${dateTime(pkg.createdAt)}</small></div><div class="da-list-actions"><span>${esc(pkg.paymentMethod || "Ödeme yok")}</span><b>${money(pkg.orderAmount)}</b></div></div>`, "Sipariş kaydı bulunamadı.");
  }

  function paymentTypeReport() {
    const buckets = new Map();
    packages().forEach((pkg) => { const key = pkg.paymentMethod || "Belirtilmedi"; const current = buckets.get(key) || { label: key, count: 0, amount: 0 }; current.count += 1; current.amount += Number(pkg.orderAmount || 0); buckets.set(key, current); });
    summaryListModal("Kurye Ödeme Türü Raporu", [...buckets.values()], (item) => `<div class="da-list-row"><div><b>${esc(item.label)}</b><small>${item.count} paket</small></div><b>${money(item.amount)}</b></div>`, "Ödeme türü kaydı bulunamadı.");
  }

  function deliveryDurationReport() {
    const selected = packages().filter((pkg) => pkg.deliveredAt && pkg.createdAt).map((pkg) => ({ ...pkg, durationMinutes: Math.max(0, Math.round((new Date(pkg.deliveredAt) - new Date(pkg.createdAt)) / 60000)) }));
    summaryListModal("Kurye Teslim Süre Raporu", selected, (pkg) => `<div class="da-list-row"><div><b>${esc(pkg.trackingNo || pkg.id)} · ${esc(pkg.assignedCourierName || courierFor(pkg)?.name || "Kurye yok")}</b><small>${esc(pkg.restaurantName || "İşletme yok")} · ${dateTime(pkg.deliveredAt)}</small></div><b>${pkg.durationMinutes} dakika</b></div>`, "Teslim süresi hesaplanabilecek tamamlanmış paket yok.");
  }

  function restaurantEarningsReport(title = "Firma Kazanç Raporu", selected = packages()) {
    const groups = new Map();
    selected.filter((pkg) => pkg.status === "delivered").forEach((pkg) => { const id = pkg.restaurantId || pkg.restaurantName || "unknown"; const current = groups.get(id) || { name: pkg.restaurantName || id, count: 0, amount: 0 }; current.count += 1; current.amount += Number(pkg.orderAmount || 0); groups.set(id, current); });
    summaryListModal(title, [...groups.values()], (item) => `<div class="da-list-row"><div><b>${esc(item.name)}</b><small>${item.count} teslim edilen paket</small></div><b>${money(item.amount)}</b></div>`, "Teslim edilmiş işletme paketi bulunamadı.");
  }

  function restaurantCourierEarningsReport() {
    const groups = new Map();
    packages().filter((pkg) => pkg.status === "delivered").forEach((pkg) => { const courierName = pkg.assignedCourierName || courierFor(pkg)?.name || "Kurye yok"; const restaurantName = pkg.restaurantName || "İşletme yok"; const key = `${restaurantName}|${courierName}`; const current = groups.get(key) || { restaurantName, courierName, count: 0 }; current.count += 1; groups.set(key, current); });
    summaryListModal("Restoran Bazlı Kurye Kazanç Raporu", [...groups.values()], (item) => `<div class="da-list-row"><div><b>${esc(item.restaurantName)}</b><small>${esc(item.courierName)}</small></div><b>${item.count} teslimat</b></div>`, "Restoran-kurye teslimat kaydı bulunamadı.");
  }

  function zoneCollectionReport() {
    const accounting = state.data?.restaurantAccounting || [];
    const groups = new Map();
    accounting.forEach((item) => { const restaurant = restaurants().find((entry) => entry.id === item.restaurantId); const zone = restaurant?.zone || "Bölgesiz"; const current = groups.get(zone) || { zone, restaurants: 0, payable: 0, collected: 0 }; current.restaurants += 1; current.payable += Number(item.netPayable || 0); current.collected += Number(item.totalCourierCollected || 0); groups.set(zone, current); });
    summaryListModal("İşletme Bölge Bazlı Tahsilat", [...groups.values()], (item) => `<div class="da-list-row"><div><b>${esc(item.zone)}</b><small>${item.restaurants} işletme · Kurye tahsilatı ${money(item.collected)}</small></div><b>Net ${money(item.payable)}</b></div>`, "Bölgesel tahsilat kaydı bulunamadı.");
  }

  function managementRecordReport(type, title) {
    const records = (state.data?.managementRecords || []).filter((item) => item.recordType === type);
    const total = records.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    modal(title, `<div class="da-kpi"><div><strong>${records.length}</strong><span>Kayıt</span></div><div><strong>${money(total)}</strong><span>Toplam etki</span></div></div><div class="da-list">${records.length ? records.map((item) => `<div class="da-list-row"><div><b>${esc(item.title)}</b><small>${esc(item.subjectId || "Sistem")} · ${esc(item.startDate || "Tarihsiz")} · ${esc(item.status)}</small>${item.note ? `<small>${esc(item.note)}</small>` : ""}</div><b>${money(item.amount)}</b></div>`).join("") : '<div class="da-empty">Bu raporda kayıt bulunamadı.</div>'}</div>`);
  }

  function partialPaymentReport() {
    const selected = packages().filter((pkg) => Number(pkg.collectedAmount || 0) > 0 && Number(pkg.collectedAmount || 0) < Number(pkg.orderAmount || 0));
    summaryListModal("Parçalı Ödeme Raporu", selected, (pkg) => `<div class="da-list-row"><div><b>${esc(pkg.trackingNo || pkg.id)} · ${esc(pkg.customerName || "Müşteri yok")}</b><small>${esc(pkg.restaurantName || "İşletme yok")} · ${esc(pkg.paymentMethod || "Ödeme yok")}</small></div><div class="da-list-actions"><span>Tahsil ${money(pkg.collectedAmount)}</span><b>Kalan ${money(Number(pkg.orderAmount || 0) - Number(pkg.collectedAmount || 0))}</b></div></div>`, "Parçalı tahsilat kaydı bulunamadı.");
  }

  function courierPackageEarningsReport(title, selected) {
    const groups = new Map();
    selected.filter((pkg) => pkg.status === "delivered").forEach((pkg) => { const courier = courierFor(pkg); const id = pkg.assignedCourierId || courier?.id || pkg.assignedCourierName || "unknown"; const current = groups.get(id) || { name: pkg.assignedCourierName || courier?.name || "Kurye yok", count: 0, payable: 0 }; current.count += 1; current.payable += Number(courier?.perPackageFee || pkg.courierFee || 0); groups.set(id, current); });
    summaryListModal(title, [...groups.values()], (item) => `<div class="da-list-row"><div><b>${esc(item.name)}</b><small>${item.count} teslim edilen paket</small></div><b>${money(item.payable)}</b></div>`, "Kazanç hesaplanabilecek teslimat bulunamadı.");
  }

  async function restaurantAccountingManagement() {
    const today = new Date().toISOString().slice(0, 10);
    const open = async (startDate = today, endDate = today, restaurantId = "") => {
      const query = new URLSearchParams({ startDate, endDate });
      if (restaurantId) query.set("restaurantId", restaurantId);
      const result = await api(`/api/admin/accounting/restaurants?${query.toString()}`);
      const accounting = result.restaurantAccounting || [];
      const settlements = result.restaurantSettlements || [];
      const restaurantOptions = restaurants().map((restaurant) => `<option value="${esc(restaurant.id)}"${restaurant.id === restaurantId ? " selected" : ""}>${esc(restaurant.name)}</option>`).join("");
      modal("İşletme Tahsilat ve Hesap Yönetimi", `<form data-accounting-filter class="da-grid"><label class="da-field"><span>Başlangıç</span><input name="startDate" type="date" value="${esc(startDate)}"></label><label class="da-field"><span>Bitiş</span><input name="endDate" type="date" value="${esc(endDate)}"></label><label class="da-field full"><span>Restoran</span><select name="restaurantId"><option value="">Tüm restoranlar</option>${restaurantOptions}</select></label><div class="da-actions"><button class="da-secondary">Hesapları Getir</button></div></form><div class="da-list mt-5">${accounting.map((item) => { const paid = settlements.find((settlement) => settlement.restaurantId === item.restaurantId && settlement.startDate === startDate && settlement.endDate === endDate && settlement.status === "paid"); return `<div class="da-list-row" data-accounting-id="${esc(item.restaurantId)}"><div><b>${esc(item.restaurantName)}</b><small>${Number(item.totalSubmittedPackages || 0)} toplam paket · ${Number(item.totalPackages || 0)} teslimat · ${Number(item.totalCancelledPackages || 0)} iptal · Kurye tahsilatı ${money(item.totalCourierCollected)} · Hizmet bedeli ${money(item.serviceFee)}</small></div><div class="da-list-actions"><b>Net ${money(item.netPayable)}</b><button data-accounting-details>Detayları İncele</button>${paid ? '<span class="da-badge">Ödendi</span>' : '<button data-accounting-paid>Ödendi İşaretle</button>'}</div></div>`; }).join("") || '<div class="da-empty">İşletme hesabı bulunamadı.</div>'}</div>`, (root) => {
        root.querySelector("[data-accounting-filter]").addEventListener("submit", (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); open(values.startDate, values.endDate, values.restaurantId).catch((error) => toast(error.message, "error")); });
        root.querySelectorAll("[data-accounting-details]").forEach((button) => button.addEventListener("click", () => { const selectedId = button.closest("[data-accounting-id]").dataset.accountingId; showDetails(selectedId, startDate, endDate, restaurantId).catch((error) => toast(error.message, "error")); }));
        root.querySelectorAll("[data-accounting-paid]").forEach((button) => button.addEventListener("click", async () => { const selectedId = button.closest("[data-accounting-id]").dataset.accountingId; try { absorb(await api(`/api/admin/accounting/restaurants/${encodeURIComponent(selectedId)}/mark-paid`, { method: "POST", body: JSON.stringify({ startDate, endDate, note: "Admin panelinden ödendi" }) })); toast("İşletme tahsilatı ödendi olarak kaydedildi.", "success"); await open(startDate, endDate, restaurantId); } catch (error) { toast(error.message, "error"); } }));
      });
    };

    const showDetails = async (restaurantId, startDate, endDate, selectedRestaurantId = "") => {
      const result = await api(`/api/admin/accounting/restaurants/${encodeURIComponent(restaurantId)}/details?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
      const details = result.details || {};
      const stats = details.packageStats || {};
      const restaurant = restaurants().find((item) => item.id === restaurantId);
      const packageRow = (pkg) => `<div class="da-list-row"><div><b>${esc(pkg.trackingNo || pkg.id)}</b><small>${dateTime(pkg.date)} · ${esc(pkg.customer || "Müşteri belirtilmedi")}${pkg.courier ? ` · Kurye: ${esc(pkg.courier)}` : ""}</small>${pkg.note ? `<small>${esc(pkg.note)}</small>` : ""}</div><div class="da-list-actions"><b>${money(pkg.amount)}</b><span class="da-badge">${esc(statusLabel(pkg.status))}</span></div></div>`;
      modal(`${restaurant?.name || "Restoran"} · Paket Detayı`, `<div class="da-actions"><button type="button" class="da-secondary" data-accounting-back>← Hesaplara Dön</button></div><div class="da-list mt-5"><div class="da-list-row"><div><b>Seçilen dönem özeti</b><small>${Number(stats.totalSubmittedPackages || 0)} toplam paket · ${Number(stats.totalDeliveredPackages || 0)} teslimat · ${Number(stats.totalCancelledPackages || 0)} iptal</small></div><div class="da-list-actions"><b>Net ${money(details.summary?.netPayable)}</b></div></div></div><h3 class="mt-5">Teslim Edilen Paketler (${(details.packages || []).length})</h3><div class="da-list mt-3">${(details.packages || []).map(packageRow).join("") || '<div class="da-empty">Bu dönemde teslim edilen paket yok.</div>'}</div><h3 class="mt-5">İptal / Başarısız Paketler (${(details.cancelledPackages || []).length})</h3><div class="da-list mt-3">${(details.cancelledPackages || []).map(packageRow).join("") || '<div class="da-empty">Bu dönemde iptal edilen paket yok.</div>'}</div>`, (root) => {
        root.querySelector("[data-accounting-back]").addEventListener("click", () => open(startDate, endDate, selectedRestaurantId).catch((error) => toast(error.message, "error")));
      });
    };
    await open();
  }

  function suggestedRestaurantForUnmatched(order) {
    const externalId = String(order.externalRestaurantId || "").trim();
    const payloadName = normalize(order.restaurantNameFromPayload);
    const exactExternal = restaurants().find((restaurant) => {
      const ids = [
        restaurant.posentegraId,
        restaurant.trendyolRestaurantId,
        restaurant.yemeksepetiRestaurantId,
        restaurant.getirRestaurantId,
        restaurant.migrosRestaurantId,
        ...(restaurant.externalRestaurantIds || []).flatMap((item) => [item?.restaurantId, item?.id, typeof item === "string" ? item : ""]),
      ].filter(Boolean).map(String);
      return externalId && ids.includes(externalId);
    });
    if (exactExternal) return exactExternal;
    if (!payloadName) return null;
    return restaurants().find((restaurant) => normalize(restaurant.name) === payloadName)
      || restaurants().find((restaurant) => normalize(restaurant.name).includes(payloadName) || payloadName.includes(normalize(restaurant.name)))
      || null;
  }

  function renderUnmatchedWorkspace() {
    if (!refs.unmatchedWorkspace || !state.data || state.view !== "unmatched") return;
    refs.tableCard.style.display = "none";
    refs.unmatchedWorkspace.hidden = false;
    const all = unmatchedOrders();
    const pending = all.filter((order) => !order.isResolved);
    const resolved = all.filter((order) => order.isResolved);
    const selected = state.unmatchedFilter === "resolved" ? resolved : state.unmatchedFilter === "all" ? all : pending;
    const restaurantOptions = (selectedId = "") => `<option value="">İşletme seçin</option>${restaurants().map((restaurant) => `<option value="${esc(restaurant.id)}" ${restaurant.id === selectedId ? "selected" : ""}>${esc(restaurant.name)} · ${esc(restaurant.zone || "Bölgesiz")}</option>`).join("")}`;
    const cards = selected.map((order) => {
      const suggestion = suggestedRestaurantForUnmatched(order);
      const resolvedRestaurant = restaurants().find((restaurant) => restaurant.id === order.resolvedRestaurantId);
      const raw = JSON.stringify(order.rawPayload || {}, null, 2);
      return `<article class="da-unmatched-card ${order.isResolved ? "resolved" : ""}" data-unmatched-id="${esc(order.id)}">
        <div class="da-unmatched-card-top"><div><h3>${esc(order.restaurantNameFromPayload || "İşletme adı alınamadı")}</h3><div class="da-unmatched-meta"><span>${esc(order.platform || order.providerName || "Posentegra")}</span><span>Sipariş: ${esc(order.externalOrderId || order.confirmationId || order.id)}</span><span>${esc(order.status || "bekliyor")}</span></div></div><b>${money(order.totalPrice)}</b></div>
        <div class="da-unmatched-card-grid"><div><small>Harici işletme kimliği</small><b>${esc(order.externalRestaurantId || "Gönderilmedi")}</b></div><div><small>Müşteri</small><b>${esc(order.customerName || "-")}</b></div><div><small>Telefon</small><b>${esc(order.customerPhone || "-")}</b></div><div><small>Geliş zamanı</small><b>${esc(dateTime(order.createdAt))}</b></div></div>
        ${order.isResolved
          ? `<div class="da-unmatched-resolved">Eşleştirildi: ${esc(resolvedRestaurant?.name || order.resolvedRestaurantId || "İşletme")} · Paket ${esc(order.resolvedPackageId || "-")} · ${esc(dateTime(order.resolvedAt))}</div>`
          : `<div class="da-unmatched-match"><select data-unmatched-restaurant aria-label="Eşleştirilecek işletme">${restaurantOptions(suggestion?.id || "")}</select><label class="da-unmatched-check"><input data-save-external type="checkbox" checked> Bu harici işletme kimliğini sonraki siparişler için kaydet</label><button type="button" class="da-primary" data-match-unmatched>Eşleştir ve Paketi Oluştur</button></div>`}
        <details class="da-unmatched-raw"><summary>Posentegra ham verisini göster</summary><pre>${esc(raw)}</pre></details>
      </article>`;
    }).join("");
    refs.unmatchedWorkspace.innerHTML = `<div class="da-unmatched-head"><div><h2>Eşleşmeyen Paketler</h2><p>Posentegra veya sipariş platformundan gelip işletmesi otomatik bulunamayan siparişleri doğru işletmeye bağlayın.</p></div><button type="button" class="da-secondary" data-refresh-unmatched>Yenile</button></div><div class="da-unmatched-stats"><button class="da-unmatched-filter ${state.unmatchedFilter === "pending" ? "active" : ""}" data-unmatched-filter="pending">Bekleyen ${pending.length}</button><button class="da-unmatched-filter ${state.unmatchedFilter === "resolved" ? "active" : ""}" data-unmatched-filter="resolved">Eşleşen ${resolved.length}</button><button class="da-unmatched-filter ${state.unmatchedFilter === "all" ? "active" : ""}" data-unmatched-filter="all">Tümü ${all.length}</button></div><div class="da-unmatched-list">${cards || `<div class="da-empty">${state.unmatchedFilter === "pending" ? "Şu anda eşleşme bekleyen paket yok." : "Bu bölümde kayıt bulunamadı."}</div>`}</div>`;
    refs.unmatchedWorkspace.querySelectorAll("[data-unmatched-filter]").forEach((button) => button.addEventListener("click", () => { state.unmatchedFilter = button.dataset.unmatchedFilter; renderUnmatchedWorkspace(); }));
    refs.unmatchedWorkspace.querySelector("[data-refresh-unmatched]")?.addEventListener("click", async () => {
      try { const result = await api("/api/admin/unmatched-orders"); state.data.unmatchedOrders = result.unmatchedOrders || []; updateCounters(); renderUnmatchedWorkspace(); toast("Eşleşmeyen paketler güncellendi.", "success"); } catch (error) { toast(error.message, "error"); }
    });
    refs.unmatchedWorkspace.querySelectorAll("[data-match-unmatched]").forEach((button) => button.addEventListener("click", async () => {
      const card = button.closest("[data-unmatched-id]");
      const restaurantId = card.querySelector("[data-unmatched-restaurant]").value;
      if (!restaurantId) return toast("Paketi eşleştirmek için işletme seçin.", "error");
      button.disabled = true;
      button.textContent = "Eşleştiriliyor...";
      try {
        absorb(await api(`/api/admin/unmatched-orders/${encodeURIComponent(card.dataset.unmatchedId)}/match`, { method: "POST", body: JSON.stringify({ restaurantId, saveExternalId: card.querySelector("[data-save-external]").checked }) }));
        state.unmatchedFilter = "pending";
        toast("Sipariş işletmeyle eşleştirildi ve paket akışına alındı.", "success");
        renderUnmatchedWorkspace();
      } catch (error) { button.disabled = false; button.textContent = "Eşleştir ve Paketi Oluştur"; toast(error.message, "error"); }
    }));
  }

  async function showUnmatchedWorkspace() {
    state.view = "unmatched";
    const result = await api("/api/admin/unmatched-orders");
    state.data.unmatchedOrders = result.unmatchedOrders || [];
    updateCounters();
    renderUnmatchedWorkspace();
  }

  function unsupportedFeature(route) {
    const title = route.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
    modal(title || "Modül", `<div class="da-empty">Bu menü henüz gerçek bir işlem motoruna bağlı değil. Sahte kayıt oluşturulmadı; modül bağlandığında veritabanı ve panel akışıyla birlikte açılacak.</div>`);
  }

  function genericRoute(route) {
    const exactHandlers = {
      "kurye raporu": courierStatusReport,
      "kurye performans": () => courierPerformanceManagement(),
      "kurye tahsilat": () => cashManagement("Kurye Tahsilat Mutabakatı"),
      "kurye nakitleri": courierCashReport,
      "işletme-kurye teslim takibi": deliveryTrackingReport,
      "kurye ücretlendirme": courierPricingManagement,
      "kurye kazanç": () => courierEarningsManagement("Kurye Hakediş ve Kazanç Yönetimi"),
      "restoran bazlı kurye kazanç": restaurantCourierEarningsReport,
      "kurye havuz yetkileri": courierPoolEligibility,
      "havuz sipariş geçmişi": poolPackageHistory,
      "günlük sipariş raporu": () => accountReportModal(),
      "detaylı sipariş raporu": detailedPackageReport,
      "parçalı ödeme raporu": partialPaymentReport,
      "kurye teslim süre raporu": deliveryDurationReport,
      "kurye ödeme türü raporu": paymentTypeReport,
      "kurye ceza & ödül raporu": () => managementRecordReport("courier_adjustment", "Kurye Ceza ve Ödül Raporu"),
      "firma kazanç": restaurantEarningsReport,
      "işletme tahsilat": () => restaurantAccountingManagement().catch((error) => toast(error.message, "error")),
      "restoran hesap raporu": () => accountReportModal(true, "Restoran Hesap Raporu"),
      "işletme ücret iadesi": () => recordManagement({ type: "restaurant_refund", subject: "restaurant", title: "İşletme Ücret İadeleri", placeholder: "İade nedeni", amount: true, dates: true }),
      "entegrasyon yönetimi": integrationManagement,
      "kurye özel ücretlendirme": () => recordManagement({ type: "courier_special_pricing", subject: "courier", title: "Kurye Özel Ücretlendirme", placeholder: "Özel ücret kuralı", amount: true, dates: true }),
      "işletme ücretlendirme": () => recordManagement({ type: "restaurant_pricing", subject: "restaurant", title: "İşletme Ücretlendirme", placeholder: "İşletme ücret kuralı", amount: true, dates: true }),
      "restoran fiyatlandırması": () => recordManagement({ type: "restaurant_menu_pricing", subject: "restaurant", title: "Restoran Fiyatlandırması", placeholder: "Restoran fiyat planı", amount: true, dates: true }),
      "paket satın alma": () => creditManagement("İşletme Paket Satın Alma"),
      "sistem dışı onaylar": () => recordManagement({ type: "external_approval", subject: "courier", title: "Sistem Dışı İşlem Onayları", placeholder: "Onay kaydı", amount: true, dates: true }),
      "sistem dışı rapor": () => reportModal("Sistem Dışı İşlemler", packages().filter((pkg) => ["external_manual", "manual", "admin_manual"].includes(pkg.source))),
      "sistem dışı dahil kurye kazanç": () => courierPackageEarningsReport("Sistem Dışı Dahil Kurye Kazanç", packages()),
      "bölge tanımlama": zoneManagement,
      "işletme bölge fiyatlandırma": () => recordManagement({ type: "restaurant_zone_pricing", subject: "restaurant", title: "İşletme Bölge Fiyatlandırma", placeholder: "Bölge fiyat kuralı", amount: true, dates: true }),
      "işletme bölge bazlı tahsilat": zoneCollectionReport,
      "işletme tarih aralığı": () => accountReportModal(true),
    };
    if (exactHandlers[route]) return exactHandlers[route]();
    if (route.includes("restoran giriş bilgileri")) return restaurantCredentialManagement();
    if (route.includes("haftalık izin plan")) return recordManagement({ type: "courier_leave", subject: "courier", title: "Kurye İzin Planı", placeholder: "Yıllık izin, haftalık izin veya mazeret", dates: true });
    if (route.includes("vardiya") || route.includes("mola")) return shiftManagement().catch((error) => toast(error.message, "error"));
    if (route.includes("ceza") || route.includes("ödül")) return recordManagement({ type: "courier_adjustment", subject: "courier", title: "Kurye Ceza ve Ödül Kayıtları", placeholder: "Ödül veya ceza nedeni", amount: true, dates: true });
    if (route.includes("ödeme değişiklik")) return recordManagement({ type: "payment_change", subject: "courier", title: "Ödeme Değişiklikleri", placeholder: "Değişiklik nedeni", amount: true, dates: true });
    if (route.includes("kurye tahsilat") || route.includes("kurye nakit")) return cashManagement();
    if (route.includes("işletme tahsilat") || route.includes("restoran hesap") || route.includes("firma kazanç")) return restaurantAccountingManagement().catch((error) => toast(error.message, "error"));
    if (route.includes("kurye ücretlendirme") || route.includes("kurye özel ücretlendirme")) return courierPricingManagement();
    if (route === "kurye kazanç" || route.includes("restoran bazlı kurye kazanç") || route.includes("sistem dışı dahil kurye kazanç")) return courierEarningsManagement();
    if (route.includes("havuz yetki")) return courierManagement();
    if (route.includes("bölge tanımlama")) return zoneManagement();
    if (route.includes("restoran fiyatlandır") || route.includes("işletme ücretlendirme") || route.includes("bölge fiyatlandır")) return recordManagement({ type: "restaurant_pricing", subject: "restaurant", title: "İşletme ve Bölge Fiyatlandırması", placeholder: "Fiyat kuralı", amount: true, dates: true });
    if (route.includes("paket satın alma") || route.includes("kontör")) return creditManagement("İşletme Paket ve Kontör İşlemleri");
    if (route.includes("sistem dışı onay")) return recordManagement({ type: "external_approval", subject: "courier", title: "Sistem Dışı İşlem Onayları", placeholder: "Onay kaydı", amount: true, dates: true });
    if (route.includes("kurye raporu") || route.includes("kurye performans") || route.includes("kurye kazanç")) return courierPerformanceManagement();
    if (route.includes("tahsilat") || route.includes("nakit")) return cashManagement();
    if (route.includes("entegrasyon")) return integrationManagement();
    if (route.includes("bölge")) return zoneManagement();
    if (route.includes("işletme ücret iadesi")) return recordManagement({ type: "restaurant_refund", subject: "restaurant", title: "İşletme Ücret İadeleri", placeholder: "İade nedeni", amount: true, dates: true });
    if (route.includes("sistem dışı")) return reportModal("Sistem Dışı İşlemler", packages().filter((pkg) => ["external_manual", "manual", "admin_manual"].includes(pkg.source)));
    if (route.includes("işletme tarih aralığı")) return accountReportModal(true);
    if (route.includes("günlük sipariş raporu")) return accountReportModal();
    if (route.includes("rapor") || route.includes("geçmiş")) return reportModal(route.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()));
    return unsupportedFeature(route);
  }

  function integrationManagement() {
    const accounts = state.data.platformAccounts || [];
    modal("Entegrasyon Yönetimi", `<div class="da-list">${accounts.length ? accounts.map((account) => `<div class="da-list-row" data-account-id="${esc(account.id)}"><div><b>${esc(account.platform)}</b><small>Mağaza: ${esc(account.externalStoreId || "-")} · ${account.active ? "Aktif" : "Pasif"}</small></div><div class="da-list-actions"><button data-check>Bağlantıyı Test Et</button></div></div>`).join("") : '<div class="da-empty">Platform hesabı bulunamadı.</div>'}</div>`, (root) => root.querySelectorAll("[data-check]").forEach((button) => button.addEventListener("click", async () => { const id = button.closest("[data-account-id]").dataset.accountId; try { const result = await api(`/api/admin/platform-accounts/${encodeURIComponent(id)}/check-connection`, { method: "POST", body: "{}" }); toast(result.message || "Bağlantı kontrol edildi.", result.ok ? "success" : "error"); await load(true); } catch (error) { toast(error.message, "error"); } })));
  }

  function restoreOperations(filter = "all") {
    state.view = "operations";
    refs.unmatchedWorkspace.hidden = true;
    state.filter = filter; updateCounters(); renderOperations();
    refs.sidebarLinks.forEach((link) => link.classList.toggle("da-active-route", link.dataset.route === "operasyon"));
  }

  function handleRoute(route) {
    refs.sidebarLinks.forEach((link) => link.classList.toggle("da-active-route", link.dataset.route === route));
    if (route === "operasyon") return restoreOperations("all");
    if (route === "siparişler") return detailedPackageReport();
    if (route === "operasyon haritası") return showMap().catch((error) => toast(error.message, "error"));
    if (route === "canlı harita") return showMap(null, { mode: "couriers" }).catch((error) => toast(error.message, "error"));
    if (route === "işletmeler") return restaurantManagement();
    if (route === "kuryeler") return courierManagement();
    if (route.includes("eşleşmeyen paket")) return showUnmatchedWorkspace().catch((error) => toast(error.message, "error"));
    if (route.includes("restoran cihaz kurulumu")) {
      const download = document.createElement("a");
      download.href = "/downloads/restomap-restoran-kurulum.cmd";
      download.download = "restomap-restoran-kurulum.cmd";
      document.body.appendChild(download);
      download.click();
      download.remove();
      return toast("Restoran kurulum dosyası indirildi. Restoran bilgisayarında bir kez çalıştırın.", "success");
    }
    if (route.includes("oto atama")) return modal("Oto Atama Yönetimi", `<div class="da-list"><div class="da-list-row"><b>Aktif kurye</b><span>${state.data.stats?.activeCouriers || 0}</span></div><div class="da-list-row"><b>Atama bekleyen</b><span>${state.data.stats?.waitingPackages || 0}</span></div><div class="da-list-row"><b>Atama yöntemi</b><span>En yakın uygun kurye · canlı GPS ve kapasite kontrolü</span></div></div><div class="da-actions mt-4"><button class="da-primary" data-rebalance>Bekleyen Paketleri Şimdi Yeniden Ata</button></div>`, (root) => root.querySelector("[data-rebalance]").addEventListener("click", async () => { try { absorb(await api("/api/admin/rebalance", { method: "POST", body: "{}" })); toast("Otomatik atama yeniden çalıştırıldı.", "success"); root.remove(); } catch (error) { toast(error.message, "error"); } }));
    return genericRoute(route);
  }

  refs.filterButtons.forEach((button) => button.addEventListener("click", () => restoreOperations(button.dataset.filter)));
  refs.addOrderButton?.addEventListener("click", addOrderModal);
  refs.notificationButton.addEventListener("click", () => {
    notificationCenter();
    if (state.token) import("/push-client.js").then(({ registerPush }) => registerPush("admin", api, true)).catch((error) => toast(error.message, "error"));
  });
  refs.logoutButton?.addEventListener("click", logout);
  refs.sidebarLinks.forEach((link) => { const activate = (event) => { event.preventDefault(); handleRoute(link.dataset.route); }; link.addEventListener("click", activate); link.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) activate(event); }); });
  document.querySelectorAll("aside nav button").forEach((button) => button.addEventListener("click", () => { const list = button.nextElementSibling; list?.classList.toggle("hidden"); const icon = button.querySelector(".material-symbols-outlined"); if (icon) icon.textContent = list?.classList.contains("hidden") ? "chevron_right" : "expand_more"; }));
  refs.tableBody?.addEventListener("click", (event) => { const button = event.target.closest("button[data-action]"); const rowElement = button?.closest("[data-package-id]"); const pkg = packages().find((item) => item.id === rowElement?.dataset.packageId); if (!button || !pkg) return; event.preventDefault(); event.stopPropagation(); const action = button.dataset.action; if (action === "detail") packageDetail(pkg); else if (action === "map") showMap(pkg).catch((error) => toast(error.message, "error")); else if (action === "edit") editPackage(pkg); else if (action === "cancel") cancelPackage(pkg); });
  document.addEventListener("pointerdown", () => { try { state.audio ||= new (window.AudioContext || window.webkitAudioContext)(); state.audio.resume?.(); } catch {} }, { once: true });

  if (globalThis.__DELIVERA_TEST__) globalThis.__adminDesignTest = { state, hydrate, visiblePackages, operationMapData, packageDetail, connectStream, handleRoute };

  (async () => {
    await load();
    if (state.token) {
      connectStream(); startPolling();
      import("/push-client.js").then(({ registerPush }) => registerPush("admin", api)).catch(() => {});
      const query = new URLSearchParams(location.search);
      const pkg = packages().find((item) => item.id === query.get("package"));
      if (pkg) packageDetail(pkg);
      else if (query.has("notifications")) notificationCenter();
    }
  })();
})();
