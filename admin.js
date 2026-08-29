
const SVG_PACKAGE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F27A1A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"></line><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`;
const SVG_PHONE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F27A1A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`;
const SVG_MOTO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M5 16A3 3 0 1 0 5 22A3 3 0 1 0 5 16Z"></path><path d="M19 16A3 3 0 1 0 19 22A3 3 0 1 0 19 16Z"></path><path d="M5 19H19"></path><path d="M8 15L10 9H15L17 15"></path><path d="M14 9L13 5H17"></path></svg>`;
const SVG_PIN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
const SVG_COURIER = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

function migratedStorageKey(currentKey, legacyKey) {
  if (localStorage.getItem(currentKey) === null && localStorage.getItem(legacyKey) !== null) {
    localStorage.setItem(currentKey, localStorage.getItem(legacyKey));
  }
  return currentKey;
}

const ADMIN_TOKEN_KEY = migratedStorageKey("restomapAdminToken", "deliveraAdminToken");
const ADMIN_REFRESH_TOKEN_KEY = migratedStorageKey("restomapAdminRefreshToken", "deliveraAdminRefreshToken");
const ADMIN_LEGACY_AUTH_KEYS = ["deliveraAdminToken", "deliveraAdminRefreshToken"];
const ADMIN_REFRESH_MS = 20_000;
const ADMIN_MANUAL_MAX_ACTIVE_PACKAGES = 4;
const ADMIN_COURIER_ISSUE_LABELS = {
  musteri_yok: "Müşteri yok",
  adres_bulunamadi: "Adres sorunu",
  restoran_hazir_degil: "Restoran hazır değil",
  teknik_sorun: "Teknik sorun",
  diger: "Diğer",
};

const adminState = {
  data: null,
  token: "",
  refreshToken: "",
  selectedRestaurantId: "",
  packageLimit: 100,
  packageCursor: "0",
  unmatchedFilter: "pending",
  unmatchedSearch: "",
  orderHistory: {
    orders: [],
    pagination: null,
    cursor: "0",
    loaded: false,
    loading: false,
  },
  liveStream: null,
  workspacePollId: null,
  workspaceLoadPromise: null,
  queuedWorkspaceLoad: null,
  activeWorkspaceCard: "admin-announcements",
};

const adminRefs = {
  summary: document.getElementById("adminSummary"),
  loginPanel: document.getElementById("adminLoginPanel"),
  workspace: document.getElementById("adminWorkspace"),
  loginForm: document.getElementById("adminLoginForm"),
  logoutButton: document.getElementById("adminLogoutButton"),
  activeCouriers: document.getElementById("activeCouriers"),
  waitingPackages: document.getElementById("waitingPackages"),
  inTransitPackages: document.getElementById("inTransitPackages"),
  totalPackages: document.getElementById("totalPackages"),
  availableCourierCount: document.getElementById("availableCourierCount"),
  busyCourierCount: document.getElementById("busyCourierCount"),
  offlineCourierCount: document.getElementById("offlineCourierCount"),
  queueMode: document.getElementById("queueMode"),
  rateLimitStore: document.getElementById("rateLimitStore"),
  failedWebhookCount: document.getElementById("failedWebhookCount"),
  lastSystemError: document.getElementById("lastSystemError"),
  selectedRestaurantTitle: document.getElementById("selectedRestaurantTitle"),
  packagePanelTitle: document.getElementById("packagePanelTitle"),
  liveBadge: document.getElementById("adminLiveBadge"),
  notificationCenter: document.getElementById("adminNotificationCenter"),
  announcementForm: document.getElementById("announcementForm"),
  clearAnnouncementsButton: document.getElementById("clearAnnouncementsButton"),
  announcementList: document.getElementById("announcementList"),
  restaurantStatsBoard: document.getElementById("restaurantStatsBoard"),
  restaurantForm: document.getElementById("restaurantForm"),
  restaurantZone: document.getElementById("restaurantZone"),
  platformChecks: document.getElementById("platformChecks"),
  courierForm: document.getElementById("courierForm"),
  courierZone: document.getElementById("courierZone"),
  shiftPlanForm: document.getElementById("shiftPlanForm"),
  shiftPlanCourier: document.getElementById("shiftPlanCourier"),
  shiftPlanDate: document.getElementById("shiftPlanDate"),
  shiftPlanSummary: document.getElementById("shiftPlanSummary"),
  shiftPlanList: document.getElementById("shiftPlanList"),
  cashReconciliationList: document.getElementById("cashReconciliationList"),
  courierList: document.getElementById("courierList"),
  zoneBoard: document.getElementById("zoneBoard"),
  zoneAlertList: document.getElementById("zoneAlertList"),
  packageList: document.getElementById("packageList"),
  awaitingPackageList: document.getElementById("awaitingPackageList"),
  activeCourierOpsList: document.getElementById("activeCourierOpsList"),
  webhookLogList: document.getElementById("webhookLogList"),
  unmatchedOrderList: document.getElementById("unmatchedOrderList"),
  unmatchedOrderSearch: document.getElementById("unmatchedOrderSearch"),
  unmatchedOrderFilters: document.getElementById("unmatchedOrderFilters"),
  unmatchedPendingBadge: document.getElementById("unmatchedPendingBadge"),
  unmatchedPendingCount: document.getElementById("unmatchedPendingCount"),
  unmatchedResolvedCount: document.getElementById("unmatchedResolvedCount"),
  unmatchedTotalCount: document.getElementById("unmatchedTotalCount"),
  platformHealthSummary: document.getElementById("platformHealthSummary"),
  platformHealthList: document.getElementById("platformHealthList"),
  restaurantIntegrationIdList: document.getElementById("restaurantIntegrationIdList"),
  courierIntegrationIdList: document.getElementById("courierIntegrationIdList"),
  auditLogList: document.getElementById("auditLogList"),
  courierDailyReportList: document.getElementById("courierDailyReportList"),
  courierDailyReportDetailPanel: document.getElementById("courierDailyReportDetailPanel"),
  courierEarningsFilterForm: document.getElementById("courierEarningsFilterForm"),
  courierEarningsGenerateButton: document.getElementById("courierEarningsGenerateButton"),
  courierEarningsCourierFilter: document.getElementById("courierEarningsCourierFilter"),
  courierEarningsRestaurantFilter: document.getElementById("courierEarningsRestaurantFilter"),
  courierEarningsList: document.getElementById("courierEarningsList"),
  restaurantAccountingFilterForm: document.getElementById("restaurantAccountingFilterForm"),
  restaurantAccountingList: document.getElementById("restaurantAccountingList"),
  restaurantAccountingDetailPanel: document.getElementById("restaurantAccountingDetailPanel"),
  restaurantFilter: document.getElementById("restaurantFilter"),
  searchInput: document.getElementById("searchInput"),
  orderHistoryShortcut: document.getElementById("orderHistoryShortcut"),
  orderHistoryLink: document.querySelector('[data-section="adminWorkspace_ops_history"]'),
  orderHistoryFilterForm: document.getElementById("orderHistoryFilterForm"),
  orderHistoryDateFrom: document.getElementById("orderHistoryDateFrom"),
  orderHistoryDateTo: document.getElementById("orderHistoryDateTo"),
  orderHistoryRestaurant: document.getElementById("orderHistoryRestaurant"),
  orderHistoryStatus: document.getElementById("orderHistoryStatus"),
  orderHistoryAssignment: document.getElementById("orderHistoryAssignment"),
  orderHistorySearch: document.getElementById("orderHistorySearch"),
  orderHistoryTotalBadge: document.getElementById("orderHistoryTotalBadge"),
  orderHistoryTotalCount: document.getElementById("orderHistoryTotalCount"),
  orderHistoryLoadedCount: document.getElementById("orderHistoryLoadedCount"),
  orderHistoryAmount: document.getElementById("orderHistoryAmount"),
  orderHistoryList: document.getElementById("orderHistoryList"),
  orderHistoryLoadMore: document.getElementById("orderHistoryLoadMore"),
  template: document.getElementById("adminPackageTemplate"),
  courierAddForm: document.getElementById("adminCourierAddForm"),
  courierTableBody: document.getElementById("adminCourierTableBody"),
  courierEditModal: document.getElementById("adminCourierEditModal"),
  courierEditForm: document.getElementById("adminCourierEditForm"),
  courierEditTitle: document.getElementById("adminCourierEditTitle"),
  restaurantLocationTableBody: document.getElementById("adminRestaurantLocationTableBody"),
  restaurantLocationModal: document.getElementById("adminRestaurantLocationModal"),
  restaurantLocationForm: document.getElementById("adminRestaurantLocationForm"),
  restaurantLocationTitle: document.getElementById("adminRestaurantLocationTitle"),
  financialSettingsForm: document.getElementById("adminFinancialSettingsForm"),
};

function adminHeaders() {
  return authHeaders(adminState.token);
}

function readStoredAdminAuth() {
  try {
    adminState.token = localStorage.getItem(ADMIN_TOKEN_KEY) || "";
    adminState.refreshToken = localStorage.getItem(ADMIN_REFRESH_TOKEN_KEY) || "";
  } catch {
    adminState.token = "";
    adminState.refreshToken = "";
  }
}

function writeStoredAdminAuth() {
  try {
    if (adminState.token) {
      localStorage.setItem(ADMIN_TOKEN_KEY, adminState.token);
    } else {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
    if (adminState.refreshToken) {
      localStorage.setItem(ADMIN_REFRESH_TOKEN_KEY, adminState.refreshToken);
    } else {
      localStorage.removeItem(ADMIN_REFRESH_TOKEN_KEY);
    }
  } catch {
    // Storage may be unavailable in private contexts; in-memory auth still works.
  }
}

function clearStoredAdminAuth() {
  try {
    [ADMIN_TOKEN_KEY, ADMIN_REFRESH_TOKEN_KEY, ...ADMIN_LEGACY_AUTH_KEYS]
      .forEach((key) => localStorage.removeItem(key));
  } catch {}
}

function htmlSafe(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function copyTextToClipboard(value) {
  const text = String(value || "");
  if (!text) {
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function persistAdminAuth(auth) {
  adminState.token = auth.token;
  adminState.refreshToken = auth.refreshToken;
  writeStoredAdminAuth();
}

function clearAdminAuth() {
  adminState.token = "";
  adminState.refreshToken = "";
  clearStoredAdminAuth();
  adminState.data = null;
  adminState.selectedRestaurantId = "";
  stopAdminWorkspacePolling();
  adminState.liveStream?.close?.();
  adminState.liveStream = null;
}

async function refreshAdminAccess() {
  if (!adminState.refreshToken) {
    throw new Error("Admin refresh token bulunamadi.");
  }

  try {
    const auth = await api("/api/admin/refresh", {
      method: "POST",
      body: JSON.stringify({
        refreshToken: adminState.refreshToken,
      }),
    });
    persistAdminAuth(auth);
    return auth;
  } catch (err) {
    if (err.status === 401) {
      clearAdminAuth();
      window.location.reload();
    }
    throw err;
  }
}

function renderPlatformChecks() {
  adminRefs.platformChecks.innerHTML = PLATFORM_OPTIONS.map((platform) => `
    <label class="chip-option">
      <input type="checkbox" name="platforms" value="${platform}">
      <span>${platform}</span>
    </label>
  `).join("");
}

function setAdminLoggedIn(isLoggedIn) {
  adminRefs.loginPanel.classList.toggle("hidden", isLoggedIn);
  adminRefs.workspace.classList.toggle("hidden", !isLoggedIn);
  document.body.classList.toggle("app-unauthenticated", !isLoggedIn);
}

function stopAdminWorkspacePolling() {
  if (adminState.workspacePollId) {
    clearInterval(adminState.workspacePollId);
    adminState.workspacePollId = null;
  }
}

function startAdminWorkspacePolling() {
  if (adminState.workspacePollId) {
    return;
  }
  adminState.workspacePollId = setInterval(() => {
    loadAdminState().catch(() => {
      // Keep current screen if a refresh request fails.
    });
  }, ADMIN_REFRESH_MS);
}

function syncAdminWorkspaceCards() {
  const cards = [...document.querySelectorAll(".workspace-collapsible-admin")];
  cards.forEach((card) => {
    const isActive = card.dataset.cardKey === adminState.activeWorkspaceCard;
    card.classList.toggle("panel-expanded", isActive);
    card.classList.toggle("panel-collapsed", !isActive);
    const header = card.querySelector(".panel-head");
    if (header) {
      header.setAttribute("aria-expanded", isActive ? "true" : "false");
    }
  });
}

function initializeAdminWorkspaceCards() {
  const cardMap = [
    ["#adminWorkspace > section:nth-of-type(3)", "admin-restaurant-focus"],
    ["#adminWorkspace > section:nth-of-type(4)", "admin-announcements"],
    ["#adminWorkspace > section:nth-of-type(5)", "admin-notifications"],
    ["#adminWorkspace > section:nth-of-type(6) > article:nth-of-type(1)", "admin-restaurant-form"],
    ["#adminWorkspace > section:nth-of-type(6) > article:nth-of-type(2)", "admin-courier-form"],
    ["#adminWorkspace > section:nth-of-type(6) > article:nth-of-type(3)", "admin-zone-board"],
    ["#adminWorkspace > section:nth-of-type(6) > article:nth-of-type(4)", "admin-zone-alerts"],
    ["#adminWorkspace > section:nth-of-type(9) > article:nth-of-type(1)", "admin-shift-plan"],
    ["#adminWorkspace > section:nth-of-type(9) > article:nth-of-type(2)", "admin-cash"],
    ["#adminWorkspace > section:nth-of-type(10)", "admin-webhooks"],
    ["#adminWorkspace > section:nth-of-type(11)", "admin-platform-health"],
    ["#adminWorkspace > section:nth-of-type(12)", "admin-audit"],
    ["#adminWorkspace > section:nth-of-type(13)", "admin-day-close"],
  ];

  cardMap.forEach(([selector, key]) => {
    const card = document.querySelector(selector);
    if (!card) {
      return;
    }

    card.dataset.cardKey = key;
    card.classList.add("workspace-collapsible", "workspace-collapsible-admin");

    const header = card.querySelector(".panel-head");
    if (!header || header.dataset.bound === "1") {
      return;
    }

    header.dataset.bound = "1";
    header.classList.add("panel-toggle-head");
    header.tabIndex = 0;
    header.setAttribute("role", "button");

    const activate = () => {
      adminState.activeWorkspaceCard = adminState.activeWorkspaceCard === key ? "" : key;
      syncAdminWorkspaceCards();
    };

    header.addEventListener("click", (event) => {
      if (event.target.closest("button, select, input, textarea, a, label")) {
        return;
      }
      activate();
    });

    header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      activate();
    });
  });

  syncAdminWorkspaceCards();
}

function startAdminLiveStream() {
  if (adminState.liveStream || !adminState.token) {
    return;
  }

  adminState.liveStream = connectLiveStream("/api/admin/stream", adminState.token, {
    onMessage(event) {
      if (event?.message) {
        showToast(event.message, notificationTone(event.type));
        if (event.type === "assignment-waiting") {
          playSignal("critical");
        } else if (["package-assigned", "platform-order-pending", "order:new"].includes(event.type)) {
          playSignal("assignment");
        } else if (event.type === "order:unmatched") {
          playSignal("critical");
        } else if (event.type === "package-status") {
          playSignal("ready");
        }
      }
      if (event?.type !== "courier-location") {
        loadAdminState({ force: true }).catch(() => {});
      }
    },
    onError() {
      if (adminRefs.liveBadge) {
        adminRefs.liveBadge.textContent = "Canli akis tekrar baglaniyor";
      }
      adminState.liveStream?.close?.();
      adminState.liveStream = null;
      window.setTimeout(() => startAdminLiveStream(), 2000);
    },
  });
}

function bootstrapPath() {
  const params = new URLSearchParams();
  if (adminState.selectedRestaurantId) {
    params.set("restaurantId", adminState.selectedRestaurantId);
  }
  params.set("limit", String(adminState.packageLimit));
  params.set("cursor", adminState.packageCursor || "0");
  const query = params.toString();
  return query ? `/api/admin/bootstrap?${query}` : "/api/admin/bootstrap";
}

async function loadAdminState(options = {}) {
  if (adminState.workspaceLoadPromise) {
    if (options.force) {
      adminState.queuedWorkspaceLoad = { ...(adminState.queuedWorkspaceLoad || {}), ...options };
    }
    return adminState.workspaceLoadPromise;
  }

  adminState.workspaceLoadPromise = doLoadAdminState(options)
    .finally(async () => {
      adminState.workspaceLoadPromise = null;
      const queuedOptions = adminState.queuedWorkspaceLoad;
      adminState.queuedWorkspaceLoad = null;
      if (queuedOptions) {
        await loadAdminState(queuedOptions);
      }
    });
  return adminState.workspaceLoadPromise;
}

async function doLoadAdminState(options = {}) {
  if (!adminState.token) {
    if (adminState.refreshToken) {
      try {
        await refreshAdminAccess();
      } catch {
        clearAdminAuth();
      }
    }
  }

  if (!adminState.token) {
    setAdminLoggedIn(false);
    return;
  }

  if (!options.append) {
    adminState.packageCursor = "0";
  }
  const data = await api(bootstrapPath(), {
    headers: adminHeaders(),
    retryWithRefresh: refreshAdminAccess,
  });
  if (options.append && adminState.data?.packages?.length) {
    data.packages = [...adminState.data.packages, ...(data.packages || [])];
  }
  hydrateAdmin(data);
  startAdminLiveStream();
  startAdminWorkspacePolling();
}

function renderAdminStats(stats) {
  const couriers = adminState.data?.couriers || [];
  adminRefs.activeCouriers.textContent = adminState.data?.packages?.filter((pkg) => !["delivered", "failed", "cancelled"].includes(pkg.status)).length || 0;
  adminRefs.waitingPackages.textContent = stats.waitingPackages;
  adminRefs.inTransitPackages.textContent = stats.inTransitPackages;
  adminRefs.totalPackages.textContent = stats.assignedPackages;
  adminRefs.availableCourierCount.textContent = couriers.filter((courier) => courier.status === "online").length;
  adminRefs.busyCourierCount.textContent = couriers.filter((courier) => courier.status === "busy").length;
  adminRefs.offlineCourierCount.textContent = couriers.filter((courier) => courier.status === "offline").length;
  const focusLabel = adminState.selectedRestaurantId ? "Secili restoran filtresi aktif." : "Tum restoranlar gorunuyor.";
  adminRefs.summary.textContent =
    `${stats.totalPackages} siparis, ${stats.assignedPackages} aktif atama, ${stats.waitingPackages} bekleyen. ${focusLabel}`;
}

function renderRestaurantFilter(restaurants) {
  const signature = `${adminState.selectedRestaurantId}|${listRenderSignature(restaurants, ["id", "name"])}`;
  if (adminRefs.restaurantFilter.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.restaurantFilter.__deliveraRenderSignature = signature;
  adminRefs.restaurantFilter.innerHTML = ['<option value="">Tum Restoranlar</option>']
    .concat(restaurants.map((restaurant) => `<option value="${restaurant.id}">${restaurant.name}</option>`))
    .join("");
  adminRefs.restaurantFilter.value = adminState.selectedRestaurantId;
}

function renderRestaurantStats(restaurants, stats, packages) {
  const signature = [
    adminState.selectedRestaurantId,
    listRenderSignature(restaurants, ["id", "name", "zone"]),
    stats.totalPackages,
    stats.waitingPackages,
    listRenderSignature(packages, ["id", "status", "assignedCourierId", "updatedAt"]),
  ].join("||");
  if (adminRefs.restaurantStatsBoard.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.restaurantStatsBoard.__deliveraRenderSignature = signature;
  adminRefs.restaurantStatsBoard.innerHTML = "";

  const selectedRestaurant = restaurants.find((restaurant) => restaurant.id === adminState.selectedRestaurantId) || null;
  const selectedPlatformAccount = selectedRestaurant
    ? (adminState.data?.platformAccounts || []).find((account) => account.restaurantId === selectedRestaurant.id && account.active)
    : null;
  const title = selectedRestaurant ? `${selectedRestaurant.name} Operasyon Ozet` : "Tum Restoranlar Operasyon Ozet";
  const panelTitle = selectedRestaurant ? `${selectedRestaurant.name} Aktif Siparişleri` : "Tüm Restoranların Aktif Siparişleri";
  adminRefs.selectedRestaurantTitle.textContent = title;
  adminRefs.packagePanelTitle.textContent = panelTitle;

  const deliveredCount = packages.filter((pkg) => pkg.status === "delivered").length;
  const assignedCount = packages.filter((pkg) => pkg.status === "assigned" || pkg.status === "accepted_by_courier" || pkg.status === "on_route").length;
  const cards = [
    {
      label: "Restoran",
      value: selectedRestaurant ? selectedRestaurant.name : `${restaurants.length} restoran`,
      detail: selectedRestaurant ? `${selectedRestaurant.zone} bolgesi` : "Tum tenant gorunumu",
    },
    {
      label: "Toplam Paket",
      value: stats.totalPackages,
      detail: `${assignedCount} atandi`,
    },
    {
      label: "Havuz Bekleyen",
      value: stats.waitingPackages,
      detail: "Kurye eslesmesi bekliyor",
    },
    {
      label: "Teslim Edilen",
      value: deliveredCount,
      detail: "Filtrelenen listeye gore",
    },
  ];

  cards.forEach((item) => {
    const card = document.createElement("article");
    card.className = "zone-card";
    card.innerHTML = `
      <strong>${item.label}</strong>
      <p>${item.value}</p>
      <p>${item.detail}</p>
    `;
    adminRefs.restaurantStatsBoard.appendChild(card);
  });
}

function renderCourierManagement(couriers) {
  const tbody = adminRefs.courierTableBody;
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!couriers || couriers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="soft-copy" style="text-align: center;">Henuz kurye bulunmuyor.</td></tr>';
    return;
  }

  couriers.forEach((courier) => {
    const tr = document.createElement("tr");
    
    tr.innerHTML = `
      <td><strong>${htmlSafe(courier.name)}</strong></td>
      <td><code>${htmlSafe(courier.id)}</code></td>
      <td>@${htmlSafe(courier.username)}</td>
      <td>${htmlSafe(courier.zone)}</td>
      <td><span class="soft-badge">${courierStatusLabel(courier.status)}</span></td>
      <td style="text-align: right; display: flex; gap: 8px; justify-content: flex-end;">
        <button type="button" class="ghost-btn edit-btn" style="padding: 4px 8px;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button type="button" class="ghost-btn delete-btn" style="padding: 4px 8px; color: var(--coral);"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>
      </td>
    `;
    
    tr.querySelector(".edit-btn").addEventListener("click", () => {
      adminRefs.courierEditForm.reset();
      adminRefs.courierEditTitle.textContent = `${courier.name} Duzenle`;
      adminRefs.courierEditForm.elements["courierId"].value = courier.id;
      adminRefs.courierEditForm.elements["name"].value = courier.name;
      adminRefs.courierEditForm.elements["username"].value = courier.username;
      adminRefs.courierEditForm.elements["zone"].value = courier.zone;
      if (adminRefs.courierEditForm.elements["perPackageFee"]) {
        adminRefs.courierEditForm.elements["perPackageFee"].value = courier.perPackageFee ?? "";
      }
      adminRefs.courierEditModal.showModal();
    });

    tr.querySelector(".delete-btn").addEventListener("click", async () => {
      if (!confirm(`Dikkat: ${courier.name} kuryesini silmek istediginizden emin misiniz?`)) return;
      try {
        const data = await api(`/api/admin/couriers/${courier.id}`, {
          method: "DELETE",
          headers: adminHeaders(),
          retryWithRefresh: refreshAdminAccess,
        });
        showToast("Kurye basariyla silindi.");
        hydrateAdmin(data);
      } catch (err) {
        showToast(err.message || "Kurye silinirken bir hata olustu.", "error");
      }
    });

    tbody.appendChild(tr);
  });
  if (window.lucide) {
    window.lucide.createIcons({ root: tbody });
  }
}

function integrationIdentityCard(item, type) {
  const primary = type === "restaurant" ? item.name : item.name;
  const secondary = type === "restaurant"
    ? `${item.zone || "-"} - @${item.username || "-"}`
    : `${item.zone || "-"} - @${item.username || "-"}`;
  const platformText = type === "restaurant" && Array.isArray(item.platforms) && item.platforms.length
    ? item.platforms.join(", ")
    : "";
  const platformIds = type === "restaurant"
    ? [
        item.trendyolRestaurantId ? `Trendyol: ${item.trendyolRestaurantId}` : "",
        item.yemeksepetiRestaurantId ? `Yemeksepeti: ${item.yemeksepetiRestaurantId}` : "",
        item.getirRestaurantId ? `Getir: ${item.getirRestaurantId}` : "",
        item.migrosRestaurantId ? `Migros: ${item.migrosRestaurantId}` : "",
        item.posentegraId ? `Posentegra: ${item.posentegraId}` : "",
        ...(Array.isArray(item.externalRestaurantIds) ? item.externalRestaurantIds.map((entry) => `${entry.platform || "Diger"}: ${entry.restaurantId}`) : []),
      ].filter(Boolean)
    : [];
  return `
    <article class="stack-card">
      <div class="stack-top">
        <div>
          <strong>${htmlSafe(primary)}</strong>
          <p>${htmlSafe(secondary)}</p>
          ${platformText ? `<p>${htmlSafe(platformText)}</p>` : ""}
          ${platformIds.length ? `<p>${htmlSafe(platformIds.join(" | "))}</p>` : ""}
          <p><code>${htmlSafe(item.id)}</code></p>
        </div>
        <div class="stack-actions">
          ${type === "restaurant" ? `<button class="ghost-btn" type="button" data-edit-restaurant-platform-ids="${htmlSafe(item.id)}">ID Duzenle</button>` : ""}
          <button class="ghost-btn" type="button" data-copy-integration-id="${htmlSafe(item.id)}">ID Kopyala</button>
        </div>
      </div>
    </article>
  `;
}

function renderIntegrationIdentities(restaurants, couriers) {
  if (adminRefs.restaurantIntegrationIdList) {
    const signature = listRenderSignature(restaurants || [], ["id", "name", "username", "zone", "platforms", "trendyolRestaurantId", "yemeksepetiRestaurantId", "getirRestaurantId", "migrosRestaurantId", "posentegraId", "externalRestaurantIds"]);
    if (adminRefs.restaurantIntegrationIdList.__deliveraRenderSignature !== signature) {
      adminRefs.restaurantIntegrationIdList.__deliveraRenderSignature = signature;
      adminRefs.restaurantIntegrationIdList.innerHTML = restaurants?.length
        ? restaurants.map((restaurant) => integrationIdentityCard(restaurant, "restaurant")).join("")
        : '<div class="empty-state">Henuz restoran bulunmuyor.</div>';
    }
  }

  if (adminRefs.courierIntegrationIdList) {
    const signature = listRenderSignature(couriers || [], ["id", "name", "username", "zone", "status"]);
    if (adminRefs.courierIntegrationIdList.__deliveraRenderSignature !== signature) {
      adminRefs.courierIntegrationIdList.__deliveraRenderSignature = signature;
      adminRefs.courierIntegrationIdList.innerHTML = couriers?.length
        ? couriers.map((courier) => integrationIdentityCard(courier, "courier")).join("")
        : '<div class="empty-state">Henuz kurye bulunmuyor.</div>';
    }
  }
}

function renderAdminCouriers(couriers) {
  const signature = listRenderSignature(couriers, ["id", "name", "username", "zone", "status", "available", "activeLoad", "lastLocationAt", "latitude", "longitude"]);
  if (adminRefs.courierList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.courierList.__deliveraRenderSignature = signature;
  adminRefs.courierList.innerHTML = "";

  if (couriers.length === 0) {
    adminRefs.courierList.innerHTML = '<div class="empty-state">Kurye havuzu henuz bos.</div>';
    return;
  }

  const orderedCouriers = [...couriers].sort((left, right) => {
    if (left.available !== right.available) {
      return Number(right.available) - Number(left.available);
    }
    return (right.lastLocationAt || "").localeCompare(left.lastLocationAt || "");
  });

  orderedCouriers.forEach((courier) => {
    const liveLabel = courier.lastLocationAt ? formatTimeAgo(courier.lastLocationAt) : "Konum kapali";
    const motionLabel = courier.lastLocationAt ? "Canli takip acik" : "Konum paylasmiyor";
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong class="entity-line">${SVG_MOTO} ${htmlSafe(courier.name)}</strong>
          <p>@${htmlSafe(courier.username)}</p>
          <p class="entity-line">${SVG_PIN} ${htmlSafe(courier.zone)} bolgesi - GPS ${Number(courier.latitude).toFixed(5)}, ${Number(courier.longitude).toFixed(5)}</p>
          <p class="entity-line">${SVG_COURIER} ${courier.activeLoad} aktif paket - ${courier.available ? "Atamaya acik" : "Pasif"}</p>
          <p>${motionLabel} - Son sinyal ${liveLabel}</p>
        </div>
        <span class="soft-badge">${courierStatusLabel(courier.status)}</span>
      </div>
    `;

    const actions = document.createElement("div");
    actions.className = "stack-actions";

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "ghost-btn";
    toggleButton.textContent = courier.available ? "Pasif Yap" : "Aktif Yap";
    toggleButton.addEventListener("click", async () => {
      const data = await api(`/api/admin/couriers/${courier.id}/availability`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ available: !courier.available }),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
    });

    actions.appendChild(toggleButton);
    card.appendChild(actions);
    adminRefs.courierList.appendChild(card);
  });
}

function renderZoneBoard(zones) {
  const signature = listRenderSignature(zones, ["name", "packageCount", "activeCourierCount", "courierCount", "waitingCount"]);
  if (adminRefs.zoneBoard.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.zoneBoard.__deliveraRenderSignature = signature;
  adminRefs.zoneBoard.innerHTML = "";

  if (zones.length === 0) {
    adminRefs.zoneBoard.innerHTML = '<div class="empty-state">Bolge verisi yok.</div>';
    return;
  }

  zones.forEach((zone) => {
    const card = document.createElement("article");
    card.className = "zone-card";
    card.innerHTML = `
      <strong class="entity-line">${SVG_PIN} ${htmlSafe(zone.name)}</strong>
      <p class="entity-line">${SVG_MOTO} ${zone.packageCount} paket - ${zone.activeCourierCount}/${zone.courierCount} aktif kurye</p>
      <p>${zone.waitingCount} paket bekliyor</p>
    `;
    adminRefs.zoneBoard.appendChild(card);
  });
}

function renderZoneAlerts(zoneAlerts) {
  const signature = listRenderSignature(zoneAlerts || [], ["zone", "message", "waitingCount", "oldestWaitingMinutes", "severity"]);
  if (adminRefs.zoneAlertList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.zoneAlertList.__deliveraRenderSignature = signature;
  adminRefs.zoneAlertList.innerHTML = "";

  if (!zoneAlerts || zoneAlerts.length === 0) {
    adminRefs.zoneAlertList.innerHTML = '<div class="empty-state">Su an kritik bolge yogunlugu yok.</div>';
    return;
  }

  zoneAlerts.forEach((alert) => {
    const card = document.createElement("article");
    card.className = `stack-card ${alert.severity === "critical" ? "priority-alert-card" : ""}`;
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${htmlSafe(alert.zone)}</strong>
          <p>${htmlSafe(alert.message)}</p>
          <p>${alert.waitingCount} bekleyen siparis - en eski bekleme ${alert.oldestWaitingMinutes} dk</p>
        </div>
        <span class="soft-badge">${alert.severity === "critical" ? "Kirmizi Oncelik" : "Yogunluk"}</span>
      </div>
    `;
    adminRefs.zoneAlertList.appendChild(card);
  });
}

function packageVisible(pkg) {
  const query = adminRefs.searchInput.value.trim().toLowerCase();
  if (!query) {
    return true;
  }

  return [
    pkg.trackingNo,
    pkg.sourcePlatform,
    pkg.externalOrderNo,
    pkg.restaurantName,
    pkg.recipient,
    pkg.assignedCourierName || "",
    pkg.status,
  ].join(" ").toLowerCase().includes(query);
}

function renderRestaurantLocationManagement(restaurants) {
  const tbody = adminRefs.restaurantLocationTableBody;
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!Array.isArray(restaurants) || restaurants.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="soft-copy" style="text-align: center;">Henüz restoran bulunmuyor.</td></tr>';
    return;
  }

  restaurants.forEach((restaurant) => {
    const latitude = Number(restaurant.latitude);
    const longitude = Number(restaurant.longitude);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${htmlSafe(restaurant.name)}</strong></td>
      <td><code>${htmlSafe(restaurant.id)}</code></td>
      <td>${htmlSafe(restaurant.zone || "-")}</td>
      <td><code>${Number.isFinite(latitude) ? latitude.toFixed(6) : "-"}</code></td>
      <td><code>${Number.isFinite(longitude) ? longitude.toFixed(6) : "-"}</code></td>
      <td style="text-align: right;">
        <button type="button" class="ghost-btn restaurant-location-edit-btn" style="padding: 6px 10px;">
          <i data-lucide="map-pin"></i> Konumu Düzenle
        </button>
      </td>
    `;

    tr.querySelector(".restaurant-location-edit-btn")?.addEventListener("click", () => {
      if (!adminRefs.restaurantLocationForm || !adminRefs.restaurantLocationModal) return;
      adminRefs.restaurantLocationForm.reset();
      adminRefs.restaurantLocationTitle.textContent = `${restaurant.name} Konumu`;
      adminRefs.restaurantLocationForm.elements.restaurantId.value = restaurant.id;
      adminRefs.restaurantLocationForm.elements.latitude.value = Number.isFinite(latitude) ? latitude.toFixed(6) : "";
      adminRefs.restaurantLocationForm.elements.longitude.value = Number.isFinite(longitude) ? longitude.toFixed(6) : "";
      adminRefs.restaurantLocationModal.showModal();
    });
    tbody.appendChild(tr);
  });

  if (window.lucide) {
    window.lucide.createIcons({ root: tbody });
  }
}

function isAdminActivePackage(pkg) {
  return !["delivered", "failed", "rejected", "cancelled"].includes(String(pkg?.status || "").toLowerCase());
}

function localDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initializeOrderHistoryDates() {
  if (!adminRefs.orderHistoryDateFrom || adminRefs.orderHistoryDateFrom.value) return;
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  adminRefs.orderHistoryDateFrom.value = localDateInputValue(start);
  adminRefs.orderHistoryDateTo.value = localDateInputValue(end);
}

function renderOrderHistoryRestaurantOptions(restaurants = []) {
  if (!adminRefs.orderHistoryRestaurant) return;
  const selected = adminRefs.orderHistoryRestaurant.value;
  const signature = listRenderSignature(restaurants, ["id", "name"]);
  if (adminRefs.orderHistoryRestaurant.__deliveraRenderSignature === signature) return;
  adminRefs.orderHistoryRestaurant.__deliveraRenderSignature = signature;
  adminRefs.orderHistoryRestaurant.innerHTML = ['<option value="">Tüm Restoranlar</option>']
    .concat(restaurants.map((restaurant) => `<option value="${htmlSafe(restaurant.id)}">${htmlSafe(restaurant.name)}</option>`))
    .join("");
  adminRefs.orderHistoryRestaurant.value = selected;
}

function openOrderHistoryWorkspace() {
  const link = adminRefs.orderHistoryLink;
  if (!link) return;
  link.closest(".tree-group")?.classList.add("open");
  link.click();
  if (!adminState.orderHistory.loaded) loadOrderHistory().catch(() => {});
}

function orderHistoryRestaurantName(pkg) {
  return pkg.restaurantName || adminState.data?.restaurants?.find((restaurant) => restaurant.id === pkg.restaurantId)?.name || "Bilinmeyen Restoran";
}

function orderHistoryIssueLabel(pkg) {
  if (String(pkg?.status || "").toLowerCase() !== "cancelled") return "";
  return ADMIN_COURIER_ISSUE_LABELS[String(pkg?.failureReason || "").toLowerCase()] || "";
}

function renderOrderHistoryOrders(orders = [], pagination = null) {
  if (!adminRefs.orderHistoryList) return;
  const total = Number(pagination?.total ?? orders.length);
  const amount = orders.reduce((sum, pkg) => sum + Number(pkg.orderAmount || 0), 0);
  adminRefs.orderHistoryTotalBadge.textContent = `${total} kayıt`;
  adminRefs.orderHistoryTotalCount.textContent = String(total);
  adminRefs.orderHistoryLoadedCount.textContent = String(orders.length);
  adminRefs.orderHistoryAmount.textContent = formatCurrency(amount);
  if (adminRefs.orderHistoryShortcut) {
    adminRefs.orderHistoryShortcut.textContent = `Son 1 Aylık Siparişleri Aç (${total})`;
  }
  adminRefs.orderHistoryLoadMore.classList.toggle("hidden", !pagination?.hasMore);

  if (!orders.length) {
    adminRefs.orderHistoryList.innerHTML = '<div class="empty-state">Seçilen tarih ve filtrelerde sipariş bulunamadı.</div>';
    return;
  }

  adminRefs.orderHistoryList.innerHTML = orders.map((pkg) => `
    <article class="order-history-card" data-order-history-id="${htmlSafe(pkg.id)}">
      <div class="order-history-card-head">
        <div>
          <span class="order-history-date">${htmlSafe(formatDate(pkg.createdAt))}</span>
          <strong>${htmlSafe(pkg.trackingNo || pkg.externalOrderNo || pkg.id)}</strong>
          <small>${htmlSafe(pkg.sourcePlatform || pkg.platform || "Manuel")} · ${htmlSafe(orderHistoryRestaurantName(pkg))}</small>
        </div>
        <span class="order-history-status-stack">
          <span class="status-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
          ${orderHistoryIssueLabel(pkg) ? `<span class="order-history-issue-note">${htmlSafe(orderHistoryIssueLabel(pkg))}</span>` : ""}
        </span>
      </div>
      <div class="order-history-detail-grid">
        <div><span>Müşteri</span><strong>${htmlSafe(pkg.recipient || "-")}</strong><small>${htmlSafe(pkg.phone || "-")}</small></div>
        <div><span>Kurye</span><strong>${htmlSafe(pkg.assignedCourierName || "Atanmamış")}</strong><small>${pkg.assignedAt ? `Atama: ${htmlSafe(formatDate(pkg.assignedAt))}` : "Atama zamanı yok"}</small></div>
        <div><span>Ödeme</span><strong>${htmlSafe(formatCurrency(pkg.orderAmount || 0))}</strong><small>${htmlSafe(pkg.paymentMethod || "-")} · ${htmlSafe(paymentStatusLabel(pkg.paymentStatus))}</small></div>
        <div><span>Adres</span><strong>${htmlSafe(pkg.deliveryAddress || pkg.address || "-")}</strong><small>${htmlSafe(pkg.zone || "-")}</small></div>
      </div>
      <div class="order-history-card-actions">
        <span>Paket ID: ${htmlSafe(pkg.id)}</span>
        <button class="ghost-btn" type="button" data-order-history-detail="${htmlSafe(pkg.id)}">Tüm Detayları Gör</button>
      </div>
    </article>
  `).join("");

  adminRefs.orderHistoryList.querySelectorAll("[data-order-history-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      const pkg = orders.find((item) => item.id === button.dataset.orderHistoryDetail);
      if (pkg) window.showPackageDetailsModal?.({ ...pkg, restaurantName: orderHistoryRestaurantName(pkg) });
    });
  });
}

async function loadOrderHistory(options = {}) {
  if (adminState.orderHistory.loading || !adminState.token) return;
  initializeOrderHistoryDates();
  const append = Boolean(options.append);
  const form = new FormData(adminRefs.orderHistoryFilterForm);
  const params = new URLSearchParams({
    limit: "50",
    cursor: append ? (adminState.orderHistory.pagination?.nextCursor || "0") : "0",
  });
  const dateFrom = String(form.get("dateFrom") || "");
  const dateTo = String(form.get("dateTo") || "");
  if (dateFrom) params.set("dateFrom", `${dateFrom}T00:00:00.000`);
  if (dateTo) params.set("dateTo", `${dateTo}T23:59:59.999`);
  ["restaurantId", "status", "search"].forEach((key) => {
    const value = String(form.get(key) || "").trim();
    if (value) params.set(key, value);
  });
  if (form.get("assignment") === "assigned") params.set("assignedOnly", "true");

  adminState.orderHistory.loading = true;
  adminRefs.orderHistoryList.setAttribute("aria-busy", "true");
  if (!append) adminRefs.orderHistoryList.innerHTML = '<div class="empty-state">Siparişler yükleniyor...</div>';
  try {
    const data = await api(`/api/admin/orders?${params.toString()}`, {
      headers: adminHeaders(),
      retryWithRefresh: refreshAdminAccess,
    });
    const nextOrders = Array.isArray(data.orders) ? data.orders : [];
    adminState.orderHistory.orders = append ? [...adminState.orderHistory.orders, ...nextOrders] : nextOrders;
    adminState.orderHistory.pagination = data.pagination || null;
    adminState.orderHistory.loaded = true;
    renderOrderHistoryOrders(adminState.orderHistory.orders, adminState.orderHistory.pagination);
  } catch (error) {
    if (!append) adminRefs.orderHistoryList.innerHTML = `<div class="empty-state">${htmlSafe(error.message || "Sipariş arşivi yüklenemedi.")}</div>`;
    showToast(error.message || "Sipariş arşivi yüklenemedi.", "error");
  } finally {
    adminState.orderHistory.loading = false;
    adminRefs.orderHistoryList.removeAttribute("aria-busy");
  }
}

function normalizeZoneValue(value) {
  return String(value || "").trim().toLowerCase();
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceKm(aLat, aLng, bLat, bLng) {
  const lat1 = Number(aLat);
  const lng1 = Number(aLng);
  const lat2 = Number(bLat);
  const lng2 = Number(bLng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) {
    return null;
  }

  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const latA = toRadians(lat1);
  const latB = toRadians(lat2);
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2;

  return Number((2 * earthRadiusKm * Math.asin(Math.sqrt(haversine))).toFixed(1));
}

function buildCourierOverrideOptions(pkg) {
  const allCouriers = adminState.data?.couriers || [];
  return allCouriers
    .sort((left, right) => {
      const leftEligible = left.id !== pkg.assignedCourierId && ["online", "busy"].includes(left.status) && Number(left.activeLoad || 0) < ADMIN_MANUAL_MAX_ACTIVE_PACKAGES;
      const rightEligible = right.id !== pkg.assignedCourierId && ["online", "busy"].includes(right.status) && Number(right.activeLoad || 0) < ADMIN_MANUAL_MAX_ACTIVE_PACKAGES;
      if (leftEligible !== rightEligible) {
        return Number(rightEligible) - Number(leftEligible);
      }
      const loadDifference = Number(left.activeLoad || 0) - Number(right.activeLoad || 0);
      if (loadDifference !== 0) return loadDifference;
      const leftDistance = distanceKm(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude, left.latitude, left.longitude);
      const rightDistance = distanceKm(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude, right.latitude, right.longitude);
      if (leftDistance !== null && rightDistance !== null && leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      return left.name.localeCompare(right.name, "tr");
    })
    .map((courier) => {
      const activeLoad = Number(courier.activeLoad || 0);
      const isCurrentCourier = courier.id === pkg.assignedCourierId;
      const isEligible = !isCurrentCourier && ["online", "busy"].includes(courier.status) && activeLoad < ADMIN_MANUAL_MAX_ACTIVE_PACKAGES;
      const distance = distanceKm(pkg.restaurantLat ?? pkg.latitude, pkg.restaurantLng ?? pkg.longitude, courier.latitude, courier.longitude);
      let reason = "Musait";
      if (isCurrentCourier) {
        reason = "Mevcut kurye";
      } else if (activeLoad >= ADMIN_MANUAL_MAX_ACTIVE_PACKAGES) {
        reason = `${ADMIN_MANUAL_MAX_ACTIVE_PACKAGES} paket limiti dolu`;
      } else if (!["online", "busy"].includes(courier.status)) {
        reason = "Offline";
      } else if (activeLoad > 0) {
        reason = `Admin ${activeLoad + 1}. paket atayabilir`;
      }

      return {
        value: courier.id,
        label: `${courier.name} - ${courier.zone} - ${distance === null ? "Mesafe yok" : `${distance} km`} - ${reason}`,
        disabled: !isEligible,
      };
    });
}

function openPackagePrintWindow(pkg) {
  const win = window.open("", "_blank", "width=720,height=840");
  if (!win) {
    showToast("Yazdirma penceresi acilamadi.", "error");
    return;
  }

  const items = Array.isArray(pkg.items) && pkg.items.length
    ? pkg.items.map((item) => `
      <tr>
        <td>${htmlSafe(item.name || "-")}</td>
        <td>${htmlSafe(item.quantity || 1)}</td>
        <td>${htmlSafe(formatCurrency(item.price || 0))}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="3">Urun bilgisi paylasilmadi.</td></tr>';

  win.document.write(`
    <html>
      <head>
        <title>${htmlSafe(pkg.externalOrderNo)} Fis</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border-bottom: 1px solid #ddd; padding: 8px 4px; text-align: left; }
        </style>
      </head>
      <body>
        <h1>${htmlSafe(pkg.restaurantName || "RESTOMAP")}</h1>
        <p>Platform: ${htmlSafe(pkg.sourcePlatform || "-")}</p>
        <p style="display: flex; align-items: center; gap: 4px;">${SVG_PACKAGE} Siparis No: ${htmlSafe(pkg.externalOrderNo || pkg.trackingNo || "-")}</p>
        <p>Musteri: ${htmlSafe(pkg.recipient || "-")}</p>
        <p>Telefon: ${htmlSafe(pkg.phone || "-")}</p>
        <p>Adres: ${htmlSafe(pkg.deliveryAddress || pkg.address || "-")}</p>
        <table>
          <thead><tr><th>Urun</th><th>Adet</th><th>Tutar</th></tr></thead>
          <tbody>${items}</tbody>
        </table>
        <p>Toplam: ${formatCurrency(pkg.orderAmount || 0)}</p>
        <p>Odeme: ${htmlSafe(pkg.paymentMethod || "-")}</p>
        <p>Notlar: ${htmlSafe(pkg.customerNote || pkg.note || "-")}</p>
        <p>Tarih Saat: ${htmlSafe(formatDate(pkg.createdAt))}</p>
      </body>
    </html>
  `);
  win.document.close();
  win.focus();
  window.setTimeout(() => win.print(), 150);
}

function buildPackageCard(pkg) {
  const node = adminRefs.template.content.cloneNode(true);
  const badge = node.querySelector(".status-badge");
  const select = node.querySelector(".status-select");
  const reassignButton = node.querySelector(".reassign-btn");
  const platformPendingApproval = pkg.status === "pending_approval" || pkg.status === "rejected";

  const wrapper = node.querySelector(".package-card");
  if (!pkg.assignedCourierId && ["pending_approval", "pending", "preparing", "awaiting_assignment"].includes(pkg.status)) {
    wrapper.classList.add("priority-alert-card");
  }
  node.querySelector(".tracking-no").innerHTML = `${SVG_PACKAGE} ${htmlSafe(pkg.trackingNo)} - ${htmlSafe(pkg.externalOrderNo)} - ${htmlSafe(formatDate(pkg.createdAt))} - Paket ID: ${htmlSafe(pkg.id)}`;
  node.querySelector(".recipient-name").innerHTML = `${SVG_PHONE} ${htmlSafe(pkg.recipient)} - ${htmlSafe(pkg.phone)}`;
  node.querySelector(".platform-name").innerHTML = `${SVG_MOTO} ${htmlSafe(pkg.sourcePlatform || pkg.platform || "-")} - Platform Restoran ID: ${htmlSafe(pkg.platformRestaurantId || "-")} - Posentegra PID: ${htmlSafe(pkg.posentegraId || "-")} - Platform Siparis ID: ${htmlSafe(pkg.platformOrderId || pkg.externalOrderNo || "-")}`;
  node.querySelector(".restaurant-name").innerHTML = `${SVG_MOTO} ${htmlSafe(pkg.restaurantName)} - Sistem ID: ${htmlSafe(pkg.restaurantId || "-")}`;
  node.querySelector(".courier-name").innerHTML = `${SVG_COURIER} ${htmlSafe(pkg.assignedCourierName || "Kurye bekleniyor")}`;
  node.querySelector(".distance-value").textContent = pkg.distanceKm === null ? "-" : `${pkg.distanceKm} km`;
  node.querySelector(".payment-method").textContent = `${pkg.paymentMethod} - ${paymentStatusLabel(pkg.paymentStatus)} - ${formatCurrency(pkg.orderAmount)}`;
  const orderItemsSlot = node.querySelector(".order-items-slot");
  if (orderItemsSlot) {
    orderItemsSlot.innerHTML = window.renderOrderItemsBox?.(pkg, { compact: true }) || "";
  }
  node.querySelector(".address-value").innerHTML = `${SVG_PIN} ${htmlSafe(pkg.deliveryAddress || pkg.address)}`;

  if (!node.querySelector(".details-btn-injected")) {
    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = "margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px; text-align: right;";
    actionsRow.innerHTML = `<button class="ghost-btn details-btn-injected" style="padding: 6px 16px; font-size: 0.85rem; border-radius: 8px;">Detayı Görüntüle</button>`;
    actionsRow.querySelector('.details-btn-injected').addEventListener('click', () => {
      if (typeof showPackageDetailsModal === 'function') showPackageDetailsModal(pkg);
    });
    wrapper.appendChild(actionsRow);
  }
  const platformLogText = Array.isArray(pkg.platformStatusLogs) && pkg.platformStatusLogs.length
    ? ` - Platform: ${pkg.platformStatusLogs.map((item) => item.message).join(" | ")}`
    : "";
  node.querySelector(".assignment-note").textContent = `${pkg.assignmentReason}${pkg.lastAssignmentError ? ` - Son Hata: ${pkg.lastAssignmentError}` : ""}${platformLogText}`;
  node.querySelector(".note-text").textContent = `${pkg.zone} - ${pkg.address}${pkg.customerNote || pkg.note ? ` - ${pkg.customerNote || pkg.note}` : ""}${pkg.assignedAt ? ` - Atama ${formatDate(pkg.assignedAt)}` : ""}`;

  badge.textContent = statusLabel(pkg.status);
  badge.className = `status-badge ${statusClassName(pkg.status)}`;
  select.innerHTML = createStatusOptions(pkg.status);
  select.value = pkg.status;
  select.classList.toggle("status-select-delivered", pkg.status === "delivered");

  select.addEventListener("change", async (event) => {
    select.classList.toggle("status-select-delivered", event.target.value === "delivered");
    const data = await api(`/api/admin/packages/${pkg.id}/status`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ status: event.target.value }),
      retryWithRefresh: refreshAdminAccess,
    });
    hydrateAdmin(data);
  });

  reassignButton.addEventListener("click", async () => {
    const data = await api(`/api/admin/packages/${pkg.id}/reassign`, {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
      retryWithRefresh: refreshAdminAccess,
    });
    hydrateAdmin(data);
  });
  reassignButton.disabled = platformPendingApproval;

  const actions = node.querySelector(".card-actions");
  const courierSelect = document.createElement("select");
  courierSelect.className = "status-select";
  const courierOptions = buildCourierOverrideOptions(pkg);
  const hasAssignableCourier = courierOptions.some((option) => !option.disabled);
  courierSelect.innerHTML = ['<option value="">Kurye sec</option>']
    .concat(courierOptions.map((option) => `<option value="${option.value}" ${option.disabled ? "disabled" : ""}>${option.label}</option>`))
    .join("");
  courierSelect.disabled = platformPendingApproval;

  const overrideButton = document.createElement("button");
  overrideButton.type = "button";
  overrideButton.className = "ghost-btn";
  overrideButton.textContent = "Kuriyeye Ata";
  overrideButton.disabled = !hasAssignableCourier || platformPendingApproval;
  overrideButton.addEventListener("click", async () => {
    if (!courierSelect.value) {
      showToast("Bu paket icin uygun online kurye bulunamadi.", "warning");
      return;
    }
    const data = await api(`/api/admin/packages/${pkg.id}/override`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ courierId: courierSelect.value }),
      retryWithRefresh: refreshAdminAccess,
    });
    hydrateAdmin(data);
  });

  const unassignButton = document.createElement("button");
  unassignButton.type = "button";
  unassignButton.className = "ghost-btn";
  unassignButton.textContent = "Atamayi Kaldir";
  unassignButton.addEventListener("click", async () => {
    const data = await api(`/api/admin/packages/${pkg.id}/unassign`, {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
      retryWithRefresh: refreshAdminAccess,
    });
    hydrateAdmin(data);
  });
  unassignButton.disabled = platformPendingApproval;

  actions.appendChild(courierSelect);
  actions.appendChild(overrideButton);
  actions.appendChild(unassignButton);

  const printButton = document.createElement("button");
  printButton.type = "button";
  printButton.className = "primary-btn";
  printButton.textContent = "Yazdir";
  printButton.addEventListener("click", () => openPackagePrintWindow(pkg));
  actions.appendChild(printButton);

  if (!courierOptions.length) {
    const helper = document.createElement("p");
    helper.className = "subtle-text";
    helper.textContent = "Uygun kurye bulunamadi: online kurye yok / mesafe disi / bolge farkli olsa bile musait kurye bulunamadi.";
    actions.appendChild(helper);
  }

  return node;
}

function renderAdminPackages(packages) {
  const visible = packages.filter(isAdminActivePackage).filter(packageVisible);
  const packagePage = adminState.data?.pagination?.packages || null;
  const signature = [
    adminRefs.searchInput.value.trim().toLowerCase(),
    packagePage?.hasMore,
    packagePage?.nextCursor,
    packagePage?.total,
    listRenderSignature(visible, ["id", "trackingNo", "externalOrderNo", "status", "assignedCourierId", "assignedCourierName", "lastAssignmentError", "paymentStatus", "updatedAt"]),
  ].join("||");
  if (adminRefs.packageList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.packageList.__deliveraRenderSignature = signature;
  adminRefs.packageList.innerHTML = "";

  if (visible.length === 0) {
    adminRefs.packageList.innerHTML = '<div class="empty-state">Aktif sipariş yok. Yeni paket geldiğinde bu alan canlı olarak güncellenir.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  visible.forEach((pkg) => fragment.appendChild(buildPackageCard(pkg)));
  if (packagePage?.hasMore) {
    const moreButton = document.createElement("button");
    moreButton.className = "ghost-btn";
    moreButton.type = "button";
    moreButton.textContent = `Daha fazla aktif sipariş ara (${visible.length} aktif / ${packagePage.total} toplam)`;
    moreButton.addEventListener("click", async () => {
      adminState.packageCursor = packagePage.nextCursor;
      await loadAdminState({ append: true });
    });
    fragment.appendChild(moreButton);
  }
  adminRefs.packageList.appendChild(fragment);
}

function renderAwaitingPackages(packages) {
  const waiting = packages.filter((pkg) => ["pending_approval", "pending", "preparing", "awaiting_assignment"].includes(pkg.status));
  const signature = listRenderSignature(waiting, ["id", "trackingNo", "restaurantName", "recipient", "deliveryAddress", "address", "status", "lastAssignmentAttemptAt", "lastAssignmentError", "updatedAt"]);
  if (adminRefs.awaitingPackageList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.awaitingPackageList.__deliveraRenderSignature = signature;
  adminRefs.awaitingPackageList.innerHTML = "";

  if (waiting.length === 0) {
    adminRefs.awaitingPackageList.innerHTML = '<div class="empty-state">Atama bekleyen siparis yok.</div>';
    return;
  }

  waiting.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong style="display: flex; align-items: center; gap: 4px;">${SVG_PACKAGE} ${htmlSafe(pkg.trackingNo)} - ${SVG_MOTO} ${htmlSafe(pkg.restaurantName)}</strong>
          <p class="entity-line">${SVG_PIN} ${htmlSafe(pkg.recipient)} - ${htmlSafe(pkg.deliveryAddress || pkg.address)}</p>
          <p>Son deneme: ${htmlSafe(pkg.lastAssignmentAttemptAt ? formatDate(pkg.lastAssignmentAttemptAt) : "-")}</p>
          <p>Hata: ${htmlSafe(pkg.lastAssignmentError || "-")}</p>
        </div>
        <span class="status-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
      </div>
    `;
    adminRefs.awaitingPackageList.appendChild(card);
  });
}

function renderActiveCourierOps(couriers) {
  const list = couriers.filter((courier) => courier.status === "online" || courier.status === "busy");
  const signature = listRenderSignature(list, ["id", "name", "username", "zone", "activeLoad", "lastLocationAt", "status"]);
  if (adminRefs.activeCourierOpsList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.activeCourierOpsList.__deliveraRenderSignature = signature;
  adminRefs.activeCourierOpsList.innerHTML = "";

  if (list.length === 0) {
    adminRefs.activeCourierOpsList.innerHTML = '<div class="empty-state">Aktif veya musait kurye yok.</div>';
    return;
  }

  list.forEach((courier) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong class="entity-line">${SVG_MOTO} ${htmlSafe(courier.name)}</strong>
          <p class="entity-line">${SVG_PIN} @${htmlSafe(courier.username)} - ${htmlSafe(courier.zone)}</p>
          <p class="entity-line">${SVG_COURIER} ${courier.activeLoad} aktif is - Son sinyal ${courier.lastLocationAt ? formatTimeAgo(courier.lastLocationAt) : "yok"}</p>
        </div>
        <span class="soft-badge">${courierStatusLabel(courier.status)}</span>
      </div>
    `;
    adminRefs.activeCourierOpsList.appendChild(card);
  });
}

function renderWebhookLogs(logs) {
  const signature = listRenderSignature((logs || []).slice(0, 20), ["id", "platform", "externalRestaurantId", "externalOrderId", "restaurantId", "isMatched", "status", "httpStatus", "errorMessage", "createdAt"]);
  if (adminRefs.webhookLogList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.webhookLogList.__deliveraRenderSignature = signature;
  adminRefs.webhookLogList.innerHTML = "";

  if (!logs || logs.length === 0) {
    adminRefs.webhookLogList.innerHTML = '<div class="empty-state">Henuz webhook log kaydi yok.</div>';
    return;
  }

  logs.slice(0, 20).forEach((log) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${htmlSafe(log.platform || log.sourcePlatform || "Platform yok")} - ${htmlSafe(log.externalOrderId || log.externalOrderNo || "Siparis no yok")}</strong>
          <p>Restoran: ${htmlSafe(log.restaurantId || "-")} - External ID: ${htmlSafe(log.externalRestaurantId || "-")}</p>
          <p>Durum: ${log.isMatched === null ? "Belirsiz" : log.isMatched ? "Eslesti" : "Eslesmedi"} - HTTP ${log.httpStatus || log.responseStatus}${log.retryCount ? ` - Retry ${log.retryCount}` : ""}</p>
          ${log.errorMessage ? `<p>Son hata: ${htmlSafe(log.errorMessage)}${log.deadLetteredAt ? " - DLQ" : ""}</p>` : ""}
          ${log.rawPayload ? `<details><summary>Ham JSON</summary><pre class="code-block">${htmlSafe(JSON.stringify(log.rawPayload, null, 2))}</pre></details>` : ""}
        </div>
        <span class="soft-badge">${formatDate(log.createdAt)}</span>
      </div>
    `;
    adminRefs.webhookLogList.appendChild(card);
  });
}

function renderUnmatchedOrders(unmatchedOrders, restaurants) {
  if (!adminRefs.unmatchedOrderList) {
    return;
  }
  const orders = Array.isArray(unmatchedOrders) ? unmatchedOrders : [];
  const pendingCount = orders.filter((order) => !order.isResolved).length;
  const resolvedCount = orders.length - pendingCount;
  const query = adminState.unmatchedSearch.trim().toLowerCase();
  const filteredOrders = orders.filter((order) => {
    if (adminState.unmatchedFilter === "pending" && order.isResolved) return false;
    if (adminState.unmatchedFilter === "resolved" && !order.isResolved) return false;
    if (!query) return true;
    return [
      order.platform,
      order.externalOrderId,
      order.confirmationId,
      order.externalRestaurantId,
      order.restaurantNameFromPayload,
      order.customerName,
      order.customerPhone,
    ].join(" ").toLowerCase().includes(query);
  });

  if (adminRefs.unmatchedPendingBadge) adminRefs.unmatchedPendingBadge.textContent = `${pendingCount} bekleyen`;
  if (adminRefs.unmatchedPendingCount) adminRefs.unmatchedPendingCount.textContent = String(pendingCount);
  if (adminRefs.unmatchedResolvedCount) adminRefs.unmatchedResolvedCount.textContent = String(resolvedCount);
  if (adminRefs.unmatchedTotalCount) adminRefs.unmatchedTotalCount.textContent = String(orders.length);
  adminRefs.unmatchedOrderFilters?.querySelectorAll("[data-unmatched-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.unmatchedFilter === adminState.unmatchedFilter);
  });

  const signature = [
    adminState.unmatchedFilter,
    adminState.unmatchedSearch,
    listRenderSignature(filteredOrders, ["id", "externalOrderId", "externalRestaurantId", "platform", "isResolved", "resolvedRestaurantId", "updatedAt"]),
    listRenderSignature(restaurants || [], ["id", "name"]),
  ].join("||");
  if (adminRefs.unmatchedOrderList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.unmatchedOrderList.__deliveraRenderSignature = signature;
  if (filteredOrders.length === 0) {
    const emptyMessage = query
      ? "Aramana uyan eşleşme kaydı bulunamadı."
      : adminState.unmatchedFilter === "pending"
        ? "Bekleyen eşleşme yok. Yeni bir kayıt geldiğinde bu alan canlı olarak güncellenir."
        : "Bu filtrede eşleşme kaydı bulunmuyor.";
    adminRefs.unmatchedOrderList.innerHTML = `<div class="empty-state unmatched-empty-state">${htmlSafe(emptyMessage)}</div>`;
    return;
  }

  const restaurantById = new Map((restaurants || []).map((restaurant) => [restaurant.id, restaurant]));
  adminRefs.unmatchedOrderList.innerHTML = filteredOrders.map((order) => {
    const payloadRestaurantName = String(order.restaurantNameFromPayload || "").trim().toLowerCase();
    const suggestedRestaurant = (restaurants || []).find((restaurant) =>
      payloadRestaurantName && String(restaurant.name || "").trim().toLowerCase() === payloadRestaurantName
    );
    const restaurantOptions = [
      '<option value="">Restoran seç</option>',
      ...(restaurants || []).map((restaurant) => `
        <option value="${htmlSafe(restaurant.id)}" ${restaurant.id === suggestedRestaurant?.id ? "selected" : ""}>${htmlSafe(restaurant.name)}</option>
      `),
    ].join("");
    const resolvedRestaurant = restaurantById.get(order.resolvedRestaurantId);
    return `
      <article class="stack-card unmatched-order-card ${order.isResolved ? "is-resolved" : "is-pending"}">
        <div class="unmatched-card-head">
          <div>
            <span class="unmatched-platform-label">${htmlSafe(order.platform || "Platform belirtilmedi")}</span>
            <strong>${htmlSafe(order.externalOrderId || order.confirmationId || "Sipariş numarası yok")}</strong>
          </div>
          <span class="status-badge ${order.isResolved ? "status-delivered" : "status-awaiting-assignment"}">${order.isResolved ? "Çözüldü" : "İşlem Bekliyor"}</span>
        </div>

        <div class="unmatched-detail-grid">
          <div><span>Payload restoranı</span><strong>${htmlSafe(order.restaurantNameFromPayload || "-")}</strong></div>
          <div><span>Platform restoran ID</span><strong class="unmatched-id-value">${htmlSafe(order.externalRestaurantId || "-")}</strong></div>
          <div><span>Müşteri</span><strong>${htmlSafe(order.customerName || "-")} · ${htmlSafe(order.customerPhone || "-")}</strong></div>
          <div><span>Tutar / Geliş</span><strong>${formatCurrency(order.totalPrice || 0)} · ${formatDate(order.createdAt)}</strong></div>
        </div>

        ${order.isResolved ? `
          <div class="unmatched-resolution-note">${htmlSafe(resolvedRestaurant?.name || order.resolvedRestaurantId || "Restoran")} ile eşleştirildi ve arşivlendi.</div>
        ` : `
          <div class="unmatched-match-panel">
            ${suggestedRestaurant ? `<p class="unmatched-suggestion">İsim eşleşmesine göre önerilen restoran: <strong>${htmlSafe(suggestedRestaurant.name)}</strong></p>` : ""}
            <div class="unmatched-match-form">
              <label>
                <span>Bağlanacak restoran</span>
                <select data-unmatched-restaurant="${htmlSafe(order.id)}">${restaurantOptions}</select>
              </label>
              <label class="inline-check unmatched-save-check">
                <input type="checkbox" data-unmatched-save-id="${htmlSafe(order.id)}" checked>
                <span>Bu Posentegra restoran ID’sini kalıcı kaydet</span>
              </label>
              <button class="primary-btn unmatched-match-button" type="button" data-match-unmatched="${htmlSafe(order.id)}">Restorana Bağla</button>
            </div>
          </div>
        `}

        <details class="unmatched-json-details"><summary>Teknik detay / Ham JSON</summary><pre class="code-block">${htmlSafe(JSON.stringify(order.rawPayload || {}, null, 2))}</pre></details>
      </article>
    `;
  }).join("");
}

function renderAuditLogs(logs) {
  const signature = listRenderSignature((logs || []).slice(0, 12), ["id", "action", "actorRole", "actorId", "restaurantId", "packageId", "createdAt"]);
  if (adminRefs.auditLogList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.auditLogList.__deliveraRenderSignature = signature;
  adminRefs.auditLogList.innerHTML = "";

  if (!logs || logs.length === 0) {
    adminRefs.auditLogList.innerHTML = '<div class="empty-state">Henuz audit log yok.</div>';
    return;
  }

  logs.slice(0, 12).forEach((log) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${htmlSafe(log.action)}</strong>
          <p>${htmlSafe(log.actorRole)} - ${htmlSafe(log.actorId || "anonim")}</p>
          <p>Restoran: ${htmlSafe(log.restaurantId || "-")}${log.packageId ? ` - Paket: ${htmlSafe(log.packageId)}` : ""}</p>
        </div>
        <span class="soft-badge">${formatDate(log.createdAt)}</span>
      </div>
    `;
    adminRefs.auditLogList.appendChild(card);
  });
}

function renderCourierDailyReportsTable(reports) {
  const target = adminRefs.courierDailyReportList;
  if (!target) return;
  const signature = listRenderSignature((reports || []).slice(0, 50), ["id", "courierName", "reportDate", "deliveredCount", "totalAmount", "paidOnlineAmount", "cashCollectedAmount", "creditCardAmount", "restaurantCollectedAmount", "failedCollectionTotal", "status", "adminNote", "updatedAt"]);
  if (target.__deliveraRenderSignature === signature) return;
  target.__deliveraRenderSignature = signature;
  target.innerHTML = "";
  if (!(reports || []).length) {
    target.innerHTML = '<tr><td colspan="10" class="soft-copy" style="text-align:center;">Henuz kurye gun sonu raporu yok.</td></tr>';
    return;
  }
  reports.slice(0, 50).forEach((report) => {
    const row = document.createElement("tr");
    const statusText = report.status === "approved" ? "Onaylandi" : report.status === "rejected" ? "Reddedildi" : "Onay Bekliyor";
    row.innerHTML = `
      <td><strong>${htmlSafe(report.reportDate)}</strong><br><span class="soft-copy">${htmlSafe(report.zone || "-")}</span></td>
      <td>${htmlSafe(report.courierName || "-")}</td>
      <td>${Number(report.deliveredCount || report.packageIds?.length || 0)} Paket</td>
      <td>${formatCurrency(report.cashCollectedAmount)}</td>
      <td>${formatCurrency(report.creditCardAmount)}</td>
      <td>${formatCurrency(report.paidOnlineAmount)}</td>
      <td>${formatCurrency(report.restaurantCollectedAmount)}</td>
      <td class="${Number(report.failedCollectionTotal || 0) > 0 ? "report-missing-amount" : ""}">${formatCurrency(report.failedCollectionTotal)}</td>
      <td><strong>${formatCurrency(report.totalAmount)}</strong></td>
      <td><div class="admin-eod-row-actions"><span class="status-badge ${report.status === "approved" ? "status-delivered" : report.status === "rejected" ? "status-failed" : "status-awaiting-assignment"}">${statusText}</span><button class="ghost-btn small-btn detail-btn" type="button">Detay</button></div></td>
    `;
    row.querySelector(".detail-btn")?.addEventListener("click", () => renderCourierDailyReportDetail(report));
    target.appendChild(row);
  });
}

function renderCourierDailyReportDetail(report) {
  const panel = adminRefs.courierDailyReportDetailPanel;
  if (!panel) return;
  const editable = report.status !== "approved";
  panel.innerHTML = `
    <article class="stack-card admin-eod-editor-card">
      <div class="stack-top"><div><p class="eyebrow accent-teal">Gun Sonu Detayi</p><h3>${htmlSafe(report.courierName)} - ${htmlSafe(report.reportDate)}</h3><p>${htmlSafe(report.zone || "-")} bolgesi - ${Number(report.deliveredCount || 0)} teslimat</p></div><button class="ghost-btn close-detail-btn" type="button">Kapat</button></div>
      <div class="form-grid admin-eod-editor-grid">
        <label>Nakit<input name="cashCollectedAmount" type="number" min="0" step="0.01" value="${Number(report.cashCollectedAmount || 0).toFixed(2)}" ${editable ? "" : "disabled"}></label>
        <label>Kredi Karti<input name="creditCardAmount" type="number" min="0" step="0.01" value="${Number(report.creditCardAmount || 0).toFixed(2)}" ${editable ? "" : "disabled"}></label>
        <label>Online<input name="paidOnlineAmount" type="number" min="0" step="0.01" value="${Number(report.paidOnlineAmount || 0).toFixed(2)}" ${editable ? "" : "disabled"}></label>
        <label>Restoran Tahsil<input name="restaurantCollectedAmount" type="number" min="0" step="0.01" value="${Number(report.restaurantCollectedAmount || 0).toFixed(2)}" ${editable ? "" : "disabled"}></label>
        <label>Eksik / Tahsil Edilemedi<input name="failedCollectionTotal" type="number" min="0" step="0.01" value="${Number(report.failedCollectionTotal || 0).toFixed(2)}" ${editable ? "" : "disabled"}></label>
        <label class="full-width">Admin Notu<textarea name="adminNote" rows="3" ${editable ? "" : "disabled"}>${htmlSafe(report.adminNote || "")}</textarea></label>
      </div>
      ${report.courierNote ? `<p class="soft-copy"><strong>Kurye notu:</strong> ${htmlSafe(report.courierNote)}</p>` : ""}
      <div class="card-actions admin-eod-detail-actions">${editable ? '<button class="ghost-btn save-report-btn" type="button">Duzeltmeyi Kaydet</button><button class="primary-btn approve-report-btn" type="button">Onayla</button><button class="ghost-btn reject-report-btn" type="button">Reddet</button>' : '<span class="soft-badge">Bu rapor onaylandi ve kilitlendi.</span>'}</div>
    </article>`;
  panel.querySelector(".close-detail-btn")?.addEventListener("click", () => { panel.innerHTML = ""; });
  if (!editable) return;
  const reportPayload = () => {
    const value = (name) => Number(panel.querySelector(`[name="${name}"]`)?.value || 0);
    return { cashCollectedAmount: value("cashCollectedAmount"), creditCardAmount: value("creditCardAmount"), paidOnlineAmount: value("paidOnlineAmount"), restaurantCollectedAmount: value("restaurantCollectedAmount"), failedCollectionTotal: value("failedCollectionTotal"), adminNote: panel.querySelector('[name="adminNote"]')?.value || "" };
  };
  const saveReport = async () => {
    const data = await api(`/api/admin/day-close/${report.id}`, { method: "PATCH", headers: adminHeaders(), body: JSON.stringify(reportPayload()), retryWithRefresh: refreshAdminAccess });
    hydrateAdmin(data);
    return data;
  };
  panel.querySelector(".save-report-btn")?.addEventListener("click", async () => { await saveReport(); showToast("Gun sonu duzeltmesi kaydedildi.", "success"); });
  panel.querySelector(".approve-report-btn")?.addEventListener("click", async () => {
    const payload = reportPayload();
    await saveReport();
    const data = await api(`/api/admin/day-close/${report.id}/approve`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ adminNote: payload.adminNote }), retryWithRefresh: refreshAdminAccess });
    panel.innerHTML = ""; hydrateAdmin(data); showToast("Gun sonu onaylandi.", "success");
  });
  panel.querySelector(".reject-report-btn")?.addEventListener("click", async () => {
    const payload = reportPayload();
    if (!payload.adminNote.trim()) { showToast("Reddetmek icin admin notuna red sebebi yaz.", "error"); return; }
    await saveReport();
    const data = await api(`/api/admin/day-close/${report.id}/reject`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ adminNote: payload.adminNote }), retryWithRefresh: refreshAdminAccess });
    panel.innerHTML = ""; hydrateAdmin(data); showToast("Gun sonu reddedildi.", "warning");
  });
}

function renderCourierDailyReports(reports) {
  renderCourierDailyReportsTable(reports);
}

function renderCourierDailyReportsLegacy(reports) {
  const signature = listRenderSignature((reports || []).slice(0, 20), ["id", "courierName", "reportDate", "zone", "deliveredCount", "totalAmount", "paidOnlineAmount", "cashCollectedAmount", "creditCardAmount", "restaurantCollectedAmount", "failedCollectionTotal", "status", "updatedAt"]);
  if (adminRefs.courierDailyReportList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.courierDailyReportList.__deliveraRenderSignature = signature;
  adminRefs.courierDailyReportList.innerHTML = "";

  if (!reports || reports.length === 0) {
    adminRefs.courierDailyReportList.innerHTML = '<div class="empty-state">Henuz kurye gun sonu raporu yok.</div>';
    return;
  }

  reports.slice(0, 20).forEach((report) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    const isPending = report.status === 'pending_approval';
    card.innerHTML = `
      <div class="stack-top" style="align-items: flex-start;">
        <div>
          <strong>${htmlSafe(report.courierName)} - ${htmlSafe(report.reportDate)}</strong>
          <p>${htmlSafe(report.zone)} bolgesi - ${Number(report.deliveredCount || 0)} teslimat</p>
          <p style="font-weight: bold; color: #10B981;">Toplam Ciro: ${formatCurrency(report.totalAmount)}</p>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
          <span class="soft-badge" style="${isPending ? 'background: #FEF3C7; color: #D97706; border-color: #FCD34D;' : 'background: #D1FAE5; color: #059669; border-color: #6EE7B7;'}">
            ${isPending ? 'Onay Bekliyor' : 'Onaylandı'}
          </span>
          <span class="soft-badge" style="font-size: 0.75rem;">${formatDate(report.updatedAt)}</span>
          ${isPending ? `<button class="primary-btn small-btn approve-btn" data-id="${htmlSafe(report.id)}" style="background: #F27A1A; border-color: #F27A1A;">Onayla</button><button class="ghost-btn small-btn edit-btn" data-id="${htmlSafe(report.id)}">Duzenle</button><button class="ghost-btn small-btn reject-btn" data-id="${htmlSafe(report.id)}">Reddet</button>` : ''}
        </div>
      </div>
      <div class="meta-grid compact-meta-grid" style="margin-top: 12px; border-top: 1px solid #E2E8F0; padding-top: 12px; grid-template-columns: repeat(6, 1fr);">
        <div>
          <span>Online</span>
          <strong>${formatCurrency(report.paidOnlineAmount)}</strong>
        </div>
        <div>
          <span>K. Kartı</span>
          <strong>${formatCurrency(report.creditCardAmount || 0)}</strong>
        </div>
        <div>
          <span>Nakit</span>
          <strong>${formatCurrency(report.cashCollectedAmount)}</strong>
        </div>
        <div>
          <span>Restoran Tahsil</span>
          <strong>${formatCurrency(report.restaurantCollectedAmount || 0)}</strong>
        </div>
        <div>
          <span>Tahsil Edilemedi</span>
          <strong>${formatCurrency(report.failedCollectionTotal || 0)}</strong>
        </div>
        <div>
          <span>Paket</span>
          <strong>${report.packageIds.length}</strong>
        </div>
      </div>
      ${report.courierNote || report.adminNote ? `<p class="soft-copy" style="margin-top: 10px;">Kurye notu: ${htmlSafe(report.courierNote || "-")} | Admin: ${htmlSafe(report.adminNote || "-")}</p>` : ""}
    `;

    if (isPending) {
        const btn = card.querySelector('.approve-btn');
        btn.addEventListener('click', async () => {
            btn.textContent = "Onaylanıyor...";
            btn.disabled = true;
            try {
                const res = await api(`/api/admin/day-close/${report.id}/approve`, {
                    method: 'POST',
                    headers: authHeaders(adminState.token)
                });
                hydrateAdmin(res);
                showToast("Gün sonu başarıyla onaylandı.", "success");
            } catch (err) {
                showToast("Onay hatası: " + err.message, "error");
                btn.textContent = "Onayla";
                btn.disabled = false;
            }
        });
        card.querySelector('.reject-btn')?.addEventListener('click', async () => {
          const reason = window.prompt("Red sebebi", report.adminNote || "");
          if (!reason) return;
          const res = await api(`/api/admin/day-close/${report.id}/reject`, {
            method: "POST",
            headers: authHeaders(adminState.token),
            body: JSON.stringify({ adminNote: reason }),
          });
          hydrateAdmin(res);
          showToast("Gun sonu reddedildi.", "warning");
        });
        card.querySelector('.edit-btn')?.addEventListener('click', async () => {
          const adminNote = window.prompt("Admin notu", report.adminNote || "") || "";
          const res = await api(`/api/admin/day-close/${report.id}`, {
            method: "PATCH",
            headers: authHeaders(adminState.token),
            body: JSON.stringify({ adminNote }),
          });
          hydrateAdmin(res);
          showToast("Gun sonu raporu guncellendi.");
        });
    }

    adminRefs.courierDailyReportList.appendChild(card);
  });
}

function setCourierEarningFilters(couriers = [], restaurants = []) {
  if (adminRefs.courierEarningsCourierFilter && !adminRefs.courierEarningsCourierFilter.dataset.ready) {
    adminRefs.courierEarningsCourierFilter.innerHTML = '<option value="">Tum kuryeler</option>' +
      couriers.map((courier) => `<option value="${htmlSafe(courier.id)}">${htmlSafe(courier.name)}</option>`).join("");
    adminRefs.courierEarningsCourierFilter.dataset.ready = "1";
  }
  if (adminRefs.courierEarningsRestaurantFilter && !adminRefs.courierEarningsRestaurantFilter.dataset.ready) {
    adminRefs.courierEarningsRestaurantFilter.innerHTML = '<option value="">Tum restoranlar</option>' +
      restaurants.map((restaurant) => `<option value="${htmlSafe(restaurant.id)}">${htmlSafe(restaurant.name)}</option>`).join("");
    adminRefs.courierEarningsRestaurantFilter.dataset.ready = "1";
  }
  const dateInput = adminRefs.courierEarningsFilterForm?.querySelector("input[name='date']");
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }
}

function renderCourierEarnings(earnings = []) {
  if (!adminRefs.courierEarningsList) return;
  const signature = listRenderSignature(earnings || [], ["id", "courierName", "reportDate", "deliveredPackageCount", "perPackageFee", "bonusAmount", "deductionAmount", "totalPayable", "paymentStatus", "paidAt", "adminNote", "updatedAt"]);
  if (adminRefs.courierEarningsList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.courierEarningsList.__deliveraRenderSignature = signature;
  adminRefs.courierEarningsList.innerHTML = "";

  if (!earnings.length) {
    adminRefs.courierEarningsList.innerHTML = '<div class="empty-state">Secilen filtrelerde kurye hakedisi yok. Hakedisleri Olustur butonu ile teslim edilen paketlerden rapor uretebilirsin.</div>';
    return;
  }

  earnings.forEach((earning) => {
    const isPaid = earning.paymentStatus === "paid";
    const items = earning.items || [];
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top" style="align-items: flex-start;">
        <div>
          <strong>Kurye: ${htmlSafe(earning.courierName || "-")}</strong>
          <p>Tarih: ${htmlSafe(earning.reportDate || "-")}</p>
          <p>Teslim edilen paket: ${earning.deliveredPackageCount || 0}</p>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px; align-items: flex-end;">
          <span class="soft-badge" style="${isPaid ? 'background:#D1FAE5;color:#059669;border-color:#6EE7B7;' : 'background:#FEF3C7;color:#D97706;border-color:#FCD34D;'}">${isPaid ? "Odendi" : "Odenmedi"}</span>
          ${earning.paidAt ? `<span class="soft-badge">${formatDate(earning.paidAt)}</span>` : ""}
        </div>
      </div>
      <div class="meta-grid compact-meta-grid" style="margin-top: 12px; grid-template-columns: repeat(5, minmax(120px, 1fr));">
        <div><span>Paket basi ucret</span><strong>${formatCurrency(earning.perPackageFee || 0)}</strong></div>
        <div><span>Ek ucret</span><strong>${formatCurrency(earning.bonusAmount || 0)}</strong></div>
        <div><span>Kesinti</span><strong>${formatCurrency(earning.deductionAmount || 0)}</strong></div>
        <div><span>Toplam</span><strong>${formatCurrency(earning.totalPayable || 0)}</strong></div>
        <div><span>Paket</span><strong>${items.length || earning.deliveredPackageCount || 0}</strong></div>
      </div>
      ${earning.adminNote ? `<p class="soft-copy" style="margin-top: 10px;">Admin notu: ${htmlSafe(earning.adminNote)}</p>` : ""}
      <div class="card-actions" style="margin-top: 12px;">
        <button class="ghost-btn detail-btn" type="button">Detaylari Gor</button>
        ${isPaid ? "" : '<button class="primary-btn mark-paid-btn" type="button">Odendi Olarak Isaretle</button>'}
        <button class="ghost-btn edit-btn" type="button">Duzenle</button>
      </div>
      <div class="earning-detail hidden" style="margin-top: 12px;">
        ${items.length ? `
          <div class="report-table-wrap">
            <table class="report-table">
              <thead>
                <tr>
                  <th>Paket ID</th>
                  <th>Restoran</th>
                  <th>Musteri</th>
                  <th>Adres</th>
                  <th>Tutar</th>
                  <th>Odeme</th>
                  <th>Teslim Saati</th>
                  <th>Durum</th>
                  <th>Kurye Notu</th>
                </tr>
              </thead>
              <tbody>
                ${items.map((item) => {
                  const pkg = item.package || {};
                  return `
                    <tr>
                      <td>${htmlSafe(pkg.trackingNo || item.packageId || "-")}</td>
                      <td>${htmlSafe(pkg.restaurantName || item.restaurantName || "-")}</td>
                      <td>${htmlSafe(pkg.customerName || "-")}</td>
                      <td>${htmlSafe(pkg.deliveryAddress || "-")}</td>
                      <td>${formatCurrency(pkg.orderAmount || 0)}</td>
                      <td>${htmlSafe(pkg.paymentMethod || "-")}</td>
                      <td>${pkg.deliveredAt ? formatDate(pkg.deliveredAt) : "-"}</td>
                      <td>${htmlSafe(pkg.status || "-")}</td>
                      <td>${htmlSafe(pkg.courierNote || "-")}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        ` : '<div class="empty-state">Bu hakedise bagli teslim edilmis paket yok.</div>'}
      </div>
    `;

    card.querySelector(".detail-btn")?.addEventListener("click", () => {
      card.querySelector(".earning-detail")?.classList.toggle("hidden");
    });
    card.querySelector(".mark-paid-btn")?.addEventListener("click", async () => {
      const adminNote = window.prompt("Odeme notu", earning.adminNote || "") || "";
      const data = await api(`/api/admin/courier-earnings/${earning.id}/mark-paid`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ adminNote }),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data.state || data);
      showToast("Kurye hakedisi odendi olarak isaretlendi.");
    });
    card.querySelector(".edit-btn")?.addEventListener("click", async () => {
      const perPackageFee = window.prompt("Paket basi ucret", Number(earning.perPackageFee || 0).toFixed(2));
      if (perPackageFee === null) return;
      const bonusAmount = window.prompt("Ek ucret", Number(earning.bonusAmount || 0).toFixed(2));
      if (bonusAmount === null) return;
      const deductionAmount = window.prompt("Kesinti", Number(earning.deductionAmount || 0).toFixed(2));
      if (deductionAmount === null) return;
      const adminNote = window.prompt("Admin notu", earning.adminNote || "") || "";
      const data = await api(`/api/admin/courier-earnings/${earning.id}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ perPackageFee, bonusAmount, deductionAmount, adminNote }),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data.state || data);
      showToast("Kurye hakedisi guncellendi.");
    });

    adminRefs.courierEarningsList.appendChild(card);
  });
}

function renderSystemSignals(data) {
  const logs = data.webhookLogs || [];
  const failed = logs.filter((log) => Number(log.responseStatus) >= 400 || log.deadLetteredAt).length;
  const lastError = logs.find((log) => log.lastError || Number(log.responseStatus) >= 400);
  if (adminRefs.queueMode) {
    adminRefs.queueMode.textContent = data.systemStatus?.queues?.queueService?.mode || data.queues?.queueService?.mode || "inline";
  }
  if (adminRefs.rateLimitStore) {
    adminRefs.rateLimitStore.textContent = data.systemStatus?.cache?.rateLimitStore?.mode || data.cache?.rateLimitStore?.mode || "memory";
  }
  if (adminRefs.failedWebhookCount) {
    adminRefs.failedWebhookCount.textContent = String(data.systemStatus?.totals?.failedWebhooks ?? failed);
  }
  if (adminRefs.lastSystemError) {
    adminRefs.lastSystemError.textContent = lastError
      ? `${lastError.sourcePlatform || "platform"} ${lastError.lastError || `HTTP ${lastError.responseStatus}`}`.slice(0, 28)
      : "-";
  }
}

function platformHealthLabel(status) {
  return {
    connected: "Bağlı",
    warning: "Uyarı",
    error: "Hatalı",
    disabled: "Devre dışı",
    unknown: "Kontrol edilmedi",
  }[status] || "Kontrol edilmedi";
}

function platformHealthTone(status) {
  return {
    connected: "success",
    warning: "warning",
    error: "error",
    disabled: "neutral",
    unknown: "neutral",
  }[status] || "neutral";
}

function renderPlatformHealth(data) {
  if (!adminRefs.platformHealthSummary || !adminRefs.platformHealthList) {
    return;
  }
  const accounts = data.platformAccounts || [];
  const summary = data.systemStatus?.platformHealth || {};
  const signature = [
    summary.connected, summary.warning, summary.error, summary.disabled, summary.unknown,
    listRenderSignature(accounts, ["id", "platform", "restaurantId", "connectionStatus", "lastSuccessAt", "lastErrorAt", "lastErrorCode", "lastErrorMessage", "lastHttpStatus", "lastLatencyMs", "consecutiveFailures", "lastCheckAt"]),
  ].join("|");
  if (adminRefs.platformHealthList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.platformHealthList.__deliveraRenderSignature = signature;

  adminRefs.platformHealthSummary.innerHTML = [
    ["Bağlı", summary.connected || 0],
    ["Uyarı", summary.warning || 0],
    ["Hatalı", summary.error || 0],
    ["Kontrol edilmedi", summary.unknown || 0],
  ].map(([label, value]) => `
    <article class="mini-stat-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </article>
  `).join("");

  adminRefs.platformHealthList.innerHTML = "";
  if (accounts.length === 0) {
    adminRefs.platformHealthList.innerHTML = '<div class="empty-state">Platform hesabi bulunmuyor.</div>';
    return;
  }

  accounts.forEach((account) => {
    const health = account.connectionHealth || {};
    const status = account.connectionStatus || health.status || "unknown";
    const restaurant = (data.restaurants || []).find((item) => item.id === account.restaurantId);
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${htmlSafe(account.platform)} - ${htmlSafe(restaurant?.name || account.restaurantId || "-")}</strong>
          <p>${htmlSafe(health.publicMessage || account.lastErrorMessage || "Son durum bekleniyor.")}</p>
          <p>HTTP ${account.lastHttpStatus || "-"} - ${account.lastLatencyMs ?? "-"} ms - Ardışık hata ${account.consecutiveFailures || 0}</p>
          <details>
            <summary>Son hataları göster</summary>
            <p>Kod: ${htmlSafe(account.lastErrorCode || "-")} - ${htmlSafe(account.lastErrorMessage || "-")}</p>
            <p>Son başarılı: ${account.lastSuccessAt ? formatDate(account.lastSuccessAt) : "-"} | Son hata: ${account.lastErrorAt ? formatDate(account.lastErrorAt) : "-"}</p>
          </details>
        </div>
        <span class="platform-live-badge platform-live-${platformHealthTone(status)}">${platformHealthLabel(status)}</span>
      </div>
      <div class="card-actions">
        <button class="ghost-btn" type="button" data-platform-health-check="${account.id}">Tekrar kontrol et</button>
      </div>
    `;
    adminRefs.platformHealthList.appendChild(card);
  });
}

function renderAdminNotifications(notifications) {
  renderNotificationCenter(adminRefs.notificationCenter, notifications || [], "Bildirim henuz yok.");
}

function renderAnnouncements(items) {
  const courierAnnouncements = (items || []).filter((item) => item.targetRole === "courier");
  const signature = listRenderSignature(courierAnnouncements, ["id", "targetRole", "title", "message", "updatedAt", "createdAt"]);
  if (adminRefs.announcementList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.announcementList.__deliveraRenderSignature = signature;
  adminRefs.announcementList.innerHTML = "";

  if (!courierAnnouncements.length) {
    adminRefs.announcementList.innerHTML = '<div class="empty-state">Aktif kurye duyurusu yok.</div>';
    return;
  }

  courierAnnouncements.forEach((item) => {
    const card = document.createElement("article");
    card.className = "stack-card notification-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${htmlSafe(item.title)}</strong>
          <p>${htmlSafe(item.message)}</p>
          <p>Yayin: ${formatDate(item.updatedAt || item.createdAt)}</p>
        </div>
        <button class="ghost-btn" type="button">Sil</button>
      </div>
    `;
    card.querySelector("button").addEventListener("click", async () => {
      const data = await api(`/api/admin/announcements/${item.id}`, {
        method: "DELETE",
        headers: adminHeaders(),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
      showToast("Duyuru kaldirildi.");
    });
    adminRefs.announcementList.appendChild(card);
  });
}

function renderShiftPlanTools(couriers, plans, summary) {
  if (adminRefs.shiftPlanCourier) {
    const selectedCourier = adminRefs.shiftPlanCourier.value;
    const selectSignature = listRenderSignature(couriers || [], ["id", "name", "zone"]);
    if (adminRefs.shiftPlanCourier.__deliveraRenderSignature !== selectSignature) {
      adminRefs.shiftPlanCourier.__deliveraRenderSignature = selectSignature;
      adminRefs.shiftPlanCourier.innerHTML = ['<option value="">Kurye sec</option>']
        .concat((couriers || []).map((courier) => `<option value="${htmlSafe(courier.id)}">${htmlSafe(courier.name)} - ${htmlSafe(courier.zone)}</option>`))
        .join("");
      adminRefs.shiftPlanCourier.value = selectedCourier;
    }
  }
  if (adminRefs.shiftPlanDate && !adminRefs.shiftPlanDate.value) {
    adminRefs.shiftPlanDate.value = new Date().toISOString().slice(0, 10);
  }

  const summarySignature = listRenderSignature(summary || [], ["zone", "plannedCouriers", "missingCouriers"]);
  if (adminRefs.shiftPlanSummary.__deliveraRenderSignature !== summarySignature) {
    adminRefs.shiftPlanSummary.__deliveraRenderSignature = summarySignature;
    adminRefs.shiftPlanSummary.innerHTML = "";
  (summary || []).forEach((item) => {
    const card = document.createElement("article");
    card.className = "zone-card";
    card.innerHTML = `
      <strong>${htmlSafe(item.zone)}</strong>
      <p>${item.plannedCouriers} planli kurye</p>
      <p>${item.missingCouriers > 0 ? `${item.missingCouriers} eksik vardiya` : "Kadrolama dengeli"}</p>
    `;
    adminRefs.shiftPlanSummary.appendChild(card);
  });
  }

  const planSignature = listRenderSignature(plans || [], ["id", "courierName", "zone", "planDate", "startTime", "endTime", "status", "acceptedAt", "offerExpiresAt"]);
  if (adminRefs.shiftPlanList.__deliveraRenderSignature === planSignature) {
    return;
  }
  adminRefs.shiftPlanList.__deliveraRenderSignature = planSignature;
  adminRefs.shiftPlanList.innerHTML = "";
  if (!(plans || []).length) {
    adminRefs.shiftPlanList.innerHTML = '<div class="empty-state">Bugun icin vardiya plani kaydi yok.</div>';
    return;
  }

  const acceptedPlans = plans.filter((plan) => plan.status === "accepted");
  if (acceptedPlans.length) {
    const acceptedCard = document.createElement("article");
    acceptedCard.className = "stack-card notification-card";
    acceptedCard.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>Kabul Eden Kuryeler</strong>
          <p>${acceptedPlans.map((plan) => `${htmlSafe(plan.courierName)} (${htmlSafe(plan.startTime)}-${htmlSafe(plan.endTime)})`).join(" - ")}</p>
        </div>
        <span class="soft-badge">${acceptedPlans.length} kabul</span>
      </div>
    `;
    adminRefs.shiftPlanList.appendChild(acceptedCard);
  }

  plans.forEach((plan) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${htmlSafe(plan.courierName)}</strong>
          <p>${htmlSafe(plan.zone)} - ${htmlSafe(plan.planDate)}</p>
          <p>${htmlSafe(plan.startTime)} / ${htmlSafe(plan.endTime)}</p>
          <p>${plan.status === "accepted"
            ? `Kurye onayi ${formatDate(plan.acceptedAt)}`
            : plan.status === "awaiting_courier_acceptance"
              ? `Kurye onayi bekleniyor. Son sure ${formatDate(plan.offerExpiresAt)}`
              : "Onay suresi doldu"}</p>
        </div>
        <span class="soft-badge">${plan.status === "accepted" ? "Onaylandi" : plan.status === "awaiting_courier_acceptance" ? "Bekliyor" : "Sure Doldu"}</span>
      </div>
    `;
    adminRefs.shiftPlanList.appendChild(card);
  });
}

function renderCashReconciliations(items) {
  const signature = listRenderSignature(items || [], ["id", "courierName", "reportDate", "zone", "expectedCash", "reportedCash", "variance", "status", "updatedAt"]);
  if (adminRefs.cashReconciliationList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.cashReconciliationList.__deliveraRenderSignature = signature;
  adminRefs.cashReconciliationList.innerHTML = "";
  if (!(items || []).length) {
    adminRefs.cashReconciliationList.innerHTML = '<div class="empty-state">Nakit mutabakat kaydi henuz yok.</div>';
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    const inputId = `cash-${item.id}`;
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${htmlSafe(item.courierName)} - ${htmlSafe(item.reportDate)}</strong>
          <p>${htmlSafe(item.zone)} bolgesi</p>
          <p>Beklenen ${formatCurrency(item.expectedCash)} - Bildirilen ${formatCurrency(item.reportedCash)}</p>
        </div>
        <span class="soft-badge">${item.status}</span>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Fark</span>
          <strong>${formatCurrency(item.variance)}</strong>
        </div>
        <div>
          <span>Paket</span>
          <strong>${item.packageIds.length}</strong>
        </div>
      </div>
      <div class="card-actions">
        <input id="${inputId}" class="status-select" type="number" step="0.01" value="${Number(item.reportedCash || 0).toFixed(2)}">
        <button class="ghost-btn" type="button" data-action="approve">Onayla</button>
        <button class="ghost-btn" type="button" data-action="issue">Sorun Isaretle</button>
      </div>
    `;

    card.querySelector('[data-action="approve"]').addEventListener("click", async () => {
      const reportedCash = card.querySelector(`#${inputId}`).value;
      const data = await api(`/api/admin/cash-reconciliations/${item.id}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ status: "approved", reportedCash }),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
    });

    card.querySelector('[data-action="issue"]').addEventListener("click", async () => {
      const reportedCash = card.querySelector(`#${inputId}`).value;
      const data = await api(`/api/admin/cash-reconciliations/${item.id}`, {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ status: "issue", reportedCash }),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
    });

    adminRefs.cashReconciliationList.appendChild(card);
  });
}

function renderRestaurantAccounting(items = [], settlements = []) {
  if (!adminRefs.restaurantAccountingList) return;
  const signature = listRenderSignature(items, ["restaurantId", "startDate", "endDate", "totalPackages", "totalCash", "totalCard", "totalOnline", "totalRestaurantCollected", "totalCourierCollected", "failedCollectionTotal", "serviceFee", "netPayable"]);
  if (adminRefs.restaurantAccountingList.__deliveraRenderSignature === signature) {
    return;
  }
  adminRefs.restaurantAccountingList.__deliveraRenderSignature = signature;
  adminRefs.restaurantAccountingList.innerHTML = "";
  if (!items.length) {
    adminRefs.restaurantAccountingList.innerHTML = '<div class="empty-state">Secilen aralikta restoran hak edis kaydi yok.</div>';
    return;
  }
  items.forEach((item) => {
    const settlement = settlements.find((entry) => entry.restaurantId === item.restaurantId && entry.startDate === item.startDate && entry.endDate === item.endDate);
    const card = document.createElement("article");
    card.className = "stack-card accounting-summary-card";
    card.innerHTML = `
      <div class="stack-card-head">
        <div>
          <strong>${htmlSafe(item.restaurantName || item.restaurantId)}</strong>
          <p>${htmlSafe(item.startDate)} - ${htmlSafe(item.endDate)} | ${item.totalPackages || 0} paket</p>
        </div>
        <span class="soft-badge">${settlement?.status === "paid" ? "Odendi" : "Odenmedi"}</span>
      </div>
      <div class="mini-stat-list">
        <article class="mini-stat-card"><span>Nakit</span><strong>${formatCurrency(item.totalCash)}</strong></article>
        <article class="mini-stat-card"><span>Kart</span><strong>${formatCurrency(item.totalCard)}</strong></article>
        <article class="mini-stat-card"><span>Online</span><strong>${formatCurrency(item.totalOnline)}</strong></article>
        <article class="mini-stat-card"><span>Restoran Tahsil</span><strong>${formatCurrency(item.totalRestaurantCollected)}</strong></article>
        <article class="mini-stat-card"><span>Kurye Uzerinde</span><strong>${formatCurrency(item.totalCourierCollected)}</strong></article>
        <article class="mini-stat-card"><span>Tahsil Edilemedi</span><strong>${formatCurrency(item.failedCollectionTotal)}</strong></article>
        <article class="mini-stat-card"><span>Hizmet Bedeli</span><strong>${formatCurrency(item.serviceFee)}</strong></article>
        <article class="mini-stat-card"><span>Net Odenecek</span><strong>${formatCurrency(item.netPayable)}</strong></article>
      </div>
      <div class="card-actions">
        <button class="ghost-btn accounting-detail-btn" type="button">Detaylari Gor</button>
        <button class="primary-btn settlement-paid-btn" type="button">Odendi Isaretle</button>
      </div>
    `;
    card.querySelector(".accounting-detail-btn")?.addEventListener("click", async () => {
      await loadRestaurantAccountingDetails(item);
    });
    card.querySelector(".settlement-paid-btn")?.addEventListener("click", async () => {
      const data = await api(`/api/admin/accounting/restaurants/${encodeURIComponent(item.restaurantId)}/mark-paid`, {
        method: "POST",
        headers: adminHeaders(),
        retryWithRefresh: refreshAdminAccess,
        body: JSON.stringify({
          restaurantId: item.restaurantId,
          startDate: item.startDate,
          endDate: item.endDate,
          status: "paid",
        }),
      });
      hydrateAdmin(data);
      showToast("Restoran hak edisi odendi olarak isaretlendi.");
    });
    adminRefs.restaurantAccountingList.appendChild(card);
  });
}

async function loadRestaurantAccountingDetails(item) {
  if (!adminRefs.restaurantAccountingDetailPanel) {
    return;
  }
  const params = new URLSearchParams({
    startDate: item.startDate,
    endDate: item.endDate,
  });
  const data = await api(`/api/admin/accounting/restaurants/${encodeURIComponent(item.restaurantId)}/details?${params.toString()}`, {
    headers: adminHeaders(),
    retryWithRefresh: refreshAdminAccess,
  });
  renderRestaurantAccountingDetails(item, data.details);
}

function renderRestaurantAccountingDetails(item, details) {
  if (!adminRefs.restaurantAccountingDetailPanel) {
    return;
  }
  const rows = details?.packages || [];
  adminRefs.restaurantAccountingDetailPanel.innerHTML = `
    <article class="stack-card accounting-detail-card">
      <div class="stack-card-head">
        <div>
          <strong>${htmlSafe(item.restaurantName || item.restaurantId)} Detaylari</strong>
          <p>${htmlSafe(item.startDate)} - ${htmlSafe(item.endDate)} | ${rows.length} paket</p>
        </div>
        <button class="ghost-btn accounting-detail-close" type="button">Kapat</button>
      </div>
      <div class="report-table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>Paket no</th>
              <th>Tarih</th>
              <th>Musteri</th>
              <th>Kurye</th>
              <th>Tutar</th>
              <th>Odeme</th>
              <th>Tahsil eden</th>
              <th>Durum</th>
              <th>Not</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((pkg) => `
              <tr>
                <td>${htmlSafe(pkg.trackingNo || pkg.id)}</td>
                <td>${pkg.date ? formatDate(pkg.date) : "-"}</td>
                <td>${htmlSafe(pkg.customer || "-")}</td>
                <td>${htmlSafe(pkg.courier || "-")}</td>
                <td>${formatCurrency(pkg.amount)}</td>
                <td>${htmlSafe(pkg.paymentMethod || "-")} / ${paymentStatusLabel(pkg.paymentStatus)}</td>
                <td>${htmlSafe(pkg.paymentCollectedBy || "-")}</td>
                <td>${statusLabel(pkg.status)}</td>
                <td>${htmlSafe(pkg.note || "-")}</td>
              </tr>
            `).join("") || '<tr><td colspan="9">Paket yok.</td></tr>'}
          </tbody>
        </table>
      </div>
    </article>
  `;
  adminRefs.restaurantAccountingDetailPanel.querySelector(".accounting-detail-close")?.addEventListener("click", () => {
    adminRefs.restaurantAccountingDetailPanel.innerHTML = "";
  });
}

function hydrateAdmin(data) {
  const nextSignature = JSON.stringify({
    stats: data.stats,
    restaurants: (data.restaurants || []).map((item) => [item.id, item.name, item.zone, item.latitude, item.longitude, item.updatedAt]),
    couriers: (data.couriers || []).map((item) => [item.id, item.name, item.status, item.available, item.zone, item.updatedAt, item.lastLocationAt, item.perPackageFee]),
    packages: (data.packages || []).map((item) => [item.id, item.status, item.assignmentStatus, item.assignedCourierId, item.paymentStatus, item.updatedAt]),
    webhookLogs: (data.webhookLogs || []).map((item) => [item.id, item.status, item.createdAt]),
    unmatchedOrders: (data.unmatchedOrders || []).map((item) => [item.id, item.isResolved, item.updatedAt, item.createdAt]),
    auditLogs: (data.auditLogs || []).map((item) => [item.id, item.createdAt]),
    courierDailyReports: (data.courierDailyReports || []).map((item) => [item.id, item.status, item.updatedAt]),
    courierEarnings: (data.courierEarnings || []).map((item) => [item.id, item.paymentStatus, item.totalPayable, item.updatedAt]),
    notifications: (data.notifications || []).map((item) => [item.id, item.readAt, item.createdAt]),
    announcements: (data.announcements || []).map((item) => [item.id, item.active, item.updatedAt, item.createdAt]),
    shiftPlans: (data.shiftPlans || []).map((item) => [item.id, item.status, item.updatedAt]),
    cashReconciliations: (data.cashReconciliations || []).map((item) => [item.id, item.status, item.updatedAt]),
    restaurantAccounting: (data.restaurantAccounting || []).map((item) => [item.restaurantId, item.startDate, item.endDate, item.packageCount, item.totalAmount, item.settlementStatus]),
    selectedRestaurantId: adminState.selectedRestaurantId,
    packageCursor: data.pagination?.nextCursor || adminState.packageCursor,
  });
  if (adminState.lastHydrateSignature === nextSignature) {
    adminState.data = data;
    setAdminLoggedIn(true);
    return;
  }
  adminState.lastHydrateSignature = nextSignature;
  adminState.data = data;
  setAdminLoggedIn(true);
  initializeAdminWorkspaceCards();
  if (adminRefs.liveBadge) {
    adminRefs.liveBadge.textContent = "Canli akis acik";
  }
  renderAdminStats(data.stats);
  renderSystemSignals(data);
  setZoneOptions(adminRefs.courierZone, data.zones);
  setZoneOptions(adminRefs.restaurantZone, data.zones);
  renderRestaurantFilter(data.restaurants);
  renderOrderHistoryRestaurantOptions(data.restaurants);
  if (!adminState.orderHistory.loaded && !adminState.orderHistory.loading) {
    loadOrderHistory().catch(() => {});
  }
  renderRestaurantStats(data.restaurants, data.stats, data.packages);
  renderAdminCouriers(data.couriers);
  renderCourierManagement(data.couriers);
  renderRestaurantLocationManagement(data.restaurants || []);
  renderIntegrationIdentities(data.restaurants || [], data.couriers || []);
  renderZoneBoard(data.zones);
  renderZoneAlerts(data.zoneAlerts || []);
  renderAdminPackages(data.packages);
  renderAwaitingPackages(data.packages);
  renderActiveCourierOps(data.couriers);
  renderWebhookLogs(data.webhookLogs);
  renderUnmatchedOrders(data.unmatchedOrders || [], data.restaurants || []);
  renderPlatformHealth(data);
  renderAuditLogs(data.auditLogs || []);
  renderCourierDailyReports(data.courierDailyReports || []);
  setCourierEarningFilters(data.couriers || [], data.restaurants || []);
  renderCourierEarnings(data.courierEarnings || []);
  renderAdminNotifications(data.notifications || []);
  renderAnnouncements(data.announcements || []);
  renderShiftPlanTools(data.couriers || [], data.shiftPlans || [], data.shiftPlanSummary || []);
  renderCashReconciliations(data.cashReconciliations || []);
  renderRestaurantAccounting(data.restaurantAccounting || [], data.restaurantSettlements || []);
  
  if (data.systemSettings && adminRefs.financialSettingsForm) {
    const feeInput = adminRefs.financialSettingsForm.querySelector("input[name='courier_per_package_fee']");
    if (feeInput) feeInput.value = data.systemSettings.courier_per_package_fee;
  }
}

adminRefs.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.loginForm);
  const login = await api("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({
      username: formData.get("username"),
      password: formData.get("password"),
    }),
  });
  persistAdminAuth(login);
  adminRefs.loginForm.reset();
  await loadAdminState();
  startAdminLiveStream();
});

adminRefs.platformHealthList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-platform-health-check]");
  if (!button) {
    return;
  }
  button.disabled = true;
  button.textContent = "Kontrol ediliyor";
  try {
    const data = await api(`/api/admin/platform-accounts/${button.dataset.platformHealthCheck}/check-connection`, {
      method: "POST",
      headers: adminHeaders(),
      retryWithRefresh: refreshAdminAccess,
    });
    await loadAdminState();
    showToast(data.health?.publicMessage || "Platform bağlantısı kontrol edildi.", data.health?.status === "connected" ? "success" : "warning");
  } finally {
    button.disabled = false;
    button.textContent = "Tekrar kontrol et";
  }
});

adminRefs.courierForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.courierForm);
  const payload = {
    name: formData.get("name"),
    username: formData.get("username"),
    password: formData.get("password"),
    zone: formData.get("zone"),
    latitude: formData.get("latitude"),
    longitude: formData.get("longitude"),
    available: formData.get("available") === "on",
    perPackageFee: formData.get("perPackageFee"),
  };
  try {
    const data = await api("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(payload),
      retryWithRefresh: refreshAdminAccess,
    });
    adminRefs.courierForm.reset();
    hydrateAdmin(data);
    const createdCourier = data.createdCourier;
    if (!createdCourier?.id) {
      throw new Error("API kuryenin veritabanina yazildigini dogrulayan createdCourier cevabi dondurmedi.");
    }
    showToast(`${payload.name} isimli kurye kaydedildi. ID: ${createdCourier.id}`);
  } catch (err) {
    showToast(err.message || "Kurye eklenirken bir hata olustu.", "error");
  }
});

if (adminRefs.courierAddForm) {
  adminRefs.courierAddForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(adminRefs.courierAddForm);
    const payload = {
      name: formData.get("name"),
      username: formData.get("username"),
      password: formData.get("password"),
      zone: formData.get("zone"),
      latitude: 36.800000,
      longitude: 34.633333,
      available: true,
      perPackageFee: formData.get("perPackageFee"),
    };
    try {
      const data = await api("/api/admin/couriers", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify(payload),
        retryWithRefresh: refreshAdminAccess,
      });
      adminRefs.courierAddForm.reset();
      hydrateAdmin(data);
      const createdCourier = data.createdCourier;
      if (!createdCourier?.id) {
        throw new Error("API kuryenin veritabanina yazildigini dogrulayan createdCourier cevabi dondurmedi.");
      }
      showToast(`${payload.name} isimli kurye eklendi. ID: ${createdCourier.id}`);
    } catch (err) {
      showToast(err.message || "Kurye eklenirken bir hata olustu.", "error");
    }
  });
}

if (adminRefs.courierEditForm) {
  adminRefs.courierEditForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(adminRefs.courierEditForm);
    const courierId = formData.get("courierId");
    const payload = {
      name: formData.get("name"),
      username: formData.get("username"),
      password: formData.get("password"),
      zone: formData.get("zone"),
      perPackageFee: formData.get("perPackageFee"),
    };
    try {
      const data = await api(`/api/admin/couriers/${courierId}`, {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify(payload),
        retryWithRefresh: refreshAdminAccess,
      });
      adminRefs.courierEditModal.close();
      showToast("Kurye bilgileri basariyla guncellendi.");
      hydrateAdmin(data);
    } catch (err) {
      showToast(err.message || "Kurye guncellenirken bir hata olustu.", "error");
    }
  });
}

if (adminRefs.courierEditModal) {
  adminRefs.courierEditModal.querySelector(".close-modal-btn").addEventListener("click", () => {
    adminRefs.courierEditModal.close();
  });
}

if (adminRefs.restaurantLocationForm) {
  adminRefs.restaurantLocationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(adminRefs.restaurantLocationForm);
    const restaurantId = String(formData.get("restaurantId") || "");
    const payload = {
      latitude: formData.get("latitude"),
      longitude: formData.get("longitude"),
    };
    const submitButton = adminRefs.restaurantLocationForm.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    try {
      const data = await api(`/api/admin/restaurants/${encodeURIComponent(restaurantId)}/location`, {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify(payload),
        retryWithRefresh: refreshAdminAccess,
      });
      adminRefs.restaurantLocationModal?.close();
      hydrateAdmin(data);
      showToast("Restoran konumu güncellendi. Otomatik atama artık yeni koordinatları kullanacak.");
    } catch (error) {
      showToast(error.message || "Restoran konumu güncellenemedi.", "error");
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });
}

adminRefs.restaurantLocationModal?.querySelector(".close-modal-btn")?.addEventListener("click", () => {
  adminRefs.restaurantLocationModal.close();
});

adminRefs.restaurantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.restaurantForm);
  const payload = {
    name: formData.get("name"),
    portalUsername: formData.get("portalUsername"),
    portalPassword: formData.get("portalPassword"),
    zone: formData.get("zone"),
    latitude: formData.get("latitude"),
    longitude: formData.get("longitude"),
    platforms: formData.getAll("platforms"),
    trendyolRestaurantId: formData.get("trendyolRestaurantId"),
    trendyol_restaurant_id: formData.get("trendyolRestaurantId"),
    yemeksepetiRestaurantId: formData.get("yemeksepetiRestaurantId"),
    yemeksepeti_restaurant_id: formData.get("yemeksepetiRestaurantId"),
    getirRestaurantId: formData.get("getirRestaurantId"),
    getir_restaurant_id: formData.get("getirRestaurantId"),
    migrosRestaurantId: formData.get("migrosRestaurantId"),
    migros_restaurant_id: formData.get("migrosRestaurantId"),
    posentegraId: formData.get("posentegraId"),
    posentegra_id: formData.get("posentegraId"),
    externalRestaurantIds: formData.get("externalRestaurantIds"),
    external_restaurant_ids: formData.get("externalRestaurantIds"),
  };
  try {
    const data = await api("/api/admin/restaurants", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(payload),
      retryWithRefresh: refreshAdminAccess,
    });
    adminRefs.restaurantForm.reset();
    renderPlatformChecks();
    hydrateAdmin(data);
    const createdRestaurant = data.createdRestaurant;
    if (!createdRestaurant?.id) {
      throw new Error("API restoranin veritabanina yazildigini dogrulayan createdRestaurant cevabi dondurmedi.");
    }
    showToast(`${payload.name} restorani kaydedildi. ID: ${createdRestaurant.id}`);
  } catch (error) {
    showToast(error.message || "Restoran eklenirken bir hata olustu.", "error");
  }
});

adminRefs.unmatchedOrderFilters?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-unmatched-filter]");
  if (!button) return;
  adminState.unmatchedFilter = button.dataset.unmatchedFilter || "pending";
  renderUnmatchedOrders(adminState.data?.unmatchedOrders || [], adminState.data?.restaurants || []);
});

adminRefs.unmatchedOrderSearch?.addEventListener("input", (event) => {
  adminState.unmatchedSearch = String(event.target.value || "");
  renderUnmatchedOrders(adminState.data?.unmatchedOrders || [], adminState.data?.restaurants || []);
});

document.addEventListener("click", async (event) => {
  const editRestaurantPlatformIdsButton = event.target.closest("[data-edit-restaurant-platform-ids]");
  if (editRestaurantPlatformIdsButton) {
    const restaurantId = editRestaurantPlatformIdsButton.dataset.editRestaurantPlatformIds;
    const restaurant = (adminState.data?.restaurants || []).find((item) => item.id === restaurantId);
    if (!restaurant) {
      showToast("Restoran bulunamadi.", "error");
      return;
    }
    const externalDefault = JSON.stringify(restaurant.externalRestaurantIds || []);
    const payload = {
      trendyolRestaurantId: (prompt("Trendyol Restoran ID", restaurant.trendyolRestaurantId || "") ?? restaurant.trendyolRestaurantId) || "",
      yemeksepetiRestaurantId: (prompt("Yemeksepeti Restoran ID", restaurant.yemeksepetiRestaurantId || "") ?? restaurant.yemeksepetiRestaurantId) || "",
      getirRestaurantId: (prompt("Getir Restoran ID", restaurant.getirRestaurantId || "") ?? restaurant.getirRestaurantId) || "",
      migrosRestaurantId: (prompt("Migros Yemek Restoran ID", restaurant.migrosRestaurantId || "") ?? restaurant.migrosRestaurantId) || "",
      posentegraId: (prompt("Posentegra Restoran ID", restaurant.posentegraId || "") ?? restaurant.posentegraId) || "",
      externalRestaurantIds: prompt("Diger Platform ID'leri JSON", externalDefault) ?? externalDefault,
    };
    try {
      const data = await api(`/api/admin/restaurants/${encodeURIComponent(restaurantId)}`, {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify(payload),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
      showToast("Restoran platform ID'leri guncellendi.");
    } catch (error) {
      showToast(error.message || "Platform ID'leri guncellenemedi.", "error");
    }
    return;
  }

  const matchButton = event.target.closest("[data-match-unmatched]");
  if (matchButton) {
    const unmatchedId = matchButton.dataset.matchUnmatched;
    const restaurantSelect = document.querySelector(`[data-unmatched-restaurant="${CSS.escape(unmatchedId)}"]`);
    const saveIdInput = document.querySelector(`[data-unmatched-save-id="${CSS.escape(unmatchedId)}"]`);
    const restaurantId = restaurantSelect?.value || "";
    if (!restaurantId) {
      showToast("Önce bağlanacak restoranı seçmelisin.", "error");
      return;
    }
    const originalButtonText = matchButton.textContent;
    matchButton.disabled = true;
    matchButton.textContent = "Bağlanıyor...";
    try {
      const data = await api(`/api/admin/unmatched-orders/${encodeURIComponent(unmatchedId)}/match`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ restaurantId, saveExternalId: saveIdInput?.checked !== false }),
        retryWithRefresh: refreshAdminAccess,
      });
      hydrateAdmin(data);
      showToast("Sipariş restorana bağlandı. Sonraki Posentegra siparişleri otomatik tanınacak.");
    } catch (error) {
      matchButton.disabled = false;
      matchButton.textContent = originalButtonText;
      showToast(error.message || "Sipariş bağlanamadı.", "error");
    }
    return;
  }

  const copyButton = event.target.closest("[data-copy-integration-id]");
  if (!copyButton) {
    return;
  }
  try {
    await copyTextToClipboard(copyButton.dataset.copyIntegrationId);
    showToast(`ID kopyalandi: ${copyButton.dataset.copyIntegrationId}`);
  } catch (error) {
    showToast("ID kopyalanamadi.", "error");
  }
});

adminRefs.shiftPlanForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.shiftPlanForm);
  try {
    const data = await api("/api/admin/shift-plans", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        courierId: formData.get("courierId"),
        planDate: formData.get("planDate"),
        startTime: formData.get("startTime"),
        endTime: formData.get("endTime"),
      }),
      retryWithRefresh: refreshAdminAccess,
    });
    hydrateAdmin(data);
    if (!data.createdShiftPlan?.id) {
      throw new Error("API vardiya planinin veritabanina yazildigini dogrulayan createdShiftPlan cevabi dondurmedi.");
    }
    showToast("Vardiya plani kaydedildi.");
  } catch (error) {
    showToast(error.message || "Vardiya plani kaydedilemedi.", "error");
  }
});

adminRefs.announcementForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.announcementForm);
  try {
    const data = await api("/api/admin/announcements", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        targetRole: "courier",
        title: formData.get("title"),
        message: formData.get("message"),
      }),
      retryWithRefresh: refreshAdminAccess,
    });
    adminRefs.announcementForm.reset();
    hydrateAdmin(data);
    if (!data.createdAnnouncement?.id) {
      throw new Error("API duyurunun veritabanina yazildigini dogrulayan createdAnnouncement cevabi dondurmedi.");
    }
    showToast("Kurye duyurusu yayinlandi.");
  } catch (error) {
    showToast(error.message || "Kurye duyurusu yayinlanamadi.", "error");
  }
});

adminRefs.clearAnnouncementsButton?.addEventListener("click", async () => {
  const data = await api("/api/admin/announcements/clear", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ targetRole: "courier" }),
    retryWithRefresh: refreshAdminAccess,
  });
  hydrateAdmin(data);
  showToast("Tum kurye duyurulari sifirlandi.");
});

adminRefs.financialSettingsForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.financialSettingsForm);
  const data = await api("/api/admin/settings", {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({
      courier_per_package_fee: formData.get("courier_per_package_fee"),
    }),
    retryWithRefresh: refreshAdminAccess,
  });
  hydrateAdmin(data.state);
  showToast("Finansal ayarlar başarıyla güncellendi.");
});

adminRefs.courierEarningsFilterForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.courierEarningsFilterForm);
  const params = new URLSearchParams();
  if (formData.get("date")) params.set("date", formData.get("date"));
  if (formData.get("courierId")) params.set("courierId", formData.get("courierId"));
  if (formData.get("restaurantId")) params.set("restaurantId", formData.get("restaurantId"));
  if (formData.get("paymentStatus")) params.set("paymentStatus", formData.get("paymentStatus"));
  const data = await api(`/api/admin/courier-earnings?${params.toString()}`, {
    headers: adminHeaders(),
    retryWithRefresh: refreshAdminAccess,
  });
  renderCourierEarnings(data.courierEarnings || []);
});

adminRefs.courierEarningsGenerateButton?.addEventListener("click", async () => {
  const formData = new FormData(adminRefs.courierEarningsFilterForm);
  const data = await api("/api/admin/courier-earnings/generate", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      date: formData.get("date"),
      courierId: formData.get("courierId"),
    }),
    retryWithRefresh: refreshAdminAccess,
  });
  hydrateAdmin(data.state || data);
  renderCourierEarnings(data.courierEarnings || data.state?.courierEarnings || []);
  showToast("Kurye hakedisleri teslim edilen paketlerle senkronize edildi.");
});

adminRefs.restaurantAccountingFilterForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(adminRefs.restaurantAccountingFilterForm);
  const params = new URLSearchParams();
  if (formData.get("startDate")) params.set("startDate", formData.get("startDate"));
  if (formData.get("endDate")) params.set("endDate", formData.get("endDate"));
  const data = await api(`/api/admin/accounting/restaurants?${params.toString()}`, {
    headers: adminHeaders(),
    retryWithRefresh: refreshAdminAccess,
  });
  renderRestaurantAccounting(data.restaurantAccounting || [], data.restaurantSettlements || []);
});

adminRefs.searchInput.addEventListener("input", () => {
  if (adminState.data) {
    renderAdminPackages(adminState.data.packages);
  }
});

let screenWakeLock = null;
async function requestScreenWakeLock() {
  if (!adminState.token) return;
  if ("wakeLock" in navigator) {
    try {
      if (screenWakeLock !== null) return;
      screenWakeLock = await navigator.wakeLock.request("screen");
      screenWakeLock.addEventListener("release", () => {
        screenWakeLock = null;
      });
    } catch (err) {}
  }
}

window.addEventListener("beforeunload", stopAdminWorkspacePolling);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestScreenWakeLock();
  }
});

initializeOrderHistoryDates();
adminRefs.orderHistoryLink?.addEventListener("click", () => {
  if (!adminState.orderHistory.loaded) loadOrderHistory().catch(() => {});
});
adminRefs.orderHistoryShortcut?.addEventListener("click", openOrderHistoryWorkspace);
adminRefs.orderHistoryFilterForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  loadOrderHistory().catch(() => {});
});
adminRefs.orderHistoryLoadMore?.addEventListener("click", () => loadOrderHistory({ append: true }).catch(() => {}));

adminRefs.restaurantFilter.addEventListener("change", async (event) => {
  adminState.selectedRestaurantId = event.target.value;
  adminState.packageCursor = "0";
  await loadAdminState();
});

adminRefs.logoutButton?.addEventListener("click", () => {
  if (adminState.refreshToken) {
    api("/api/admin/logout", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ refreshToken: adminState.refreshToken }),
    }).catch(() => {
      // Local cleanup should still continue.
    });
  }

  clearAdminAuth();
  adminRefs.summary.textContent = "Admin oturumu kapatildi.";
  setAdminLoggedIn(false);
  if (adminRefs.liveBadge) {
    adminRefs.liveBadge.textContent = "Canli akis kapali";
  }
});

readStoredAdminAuth();
setAdminLoggedIn(Boolean(adminState.token || adminState.refreshToken));
requestScreenWakeLock();

loadAdminState().catch((error) => {
  clearAdminAuth();
  adminRefs.summary.textContent = error.message;
  setAdminLoggedIn(false);
  if (adminRefs.liveBadge) {
    adminRefs.liveBadge.textContent = "Canli akis kapali";
  }
});

renderPlatformChecks();
