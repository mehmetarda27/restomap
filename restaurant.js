
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

const RESTAURANT_TOKEN_KEY = migratedStorageKey("restomapRestaurantToken", "deliveraRestaurantToken");
const RESTAURANT_REFRESH_TOKEN_KEY = migratedStorageKey("restomapRestaurantRefreshToken", "deliveraRestaurantRefreshToken");
const RESTAURANT_ID_KEY = migratedStorageKey("restomapRestaurantId", "deliveraRestaurantId");
const RESTAURANT_API_KEY_KEY = migratedStorageKey("restomapRestaurantApiKey", "deliveraRestaurantApiKey");
const RESTAURANT_LEGACY_AUTH_KEYS = [
  "deliveraRestaurantToken",
  "deliveraRestaurantRefreshToken",
  "deliveraRestaurantId",
  "deliveraRestaurantApiKey",
];
const RESTAURANT_AUTO_PRINT_KEY = migratedStorageKey("restomapRestaurantAutoPrintByRestaurant", "deliveraRestaurantAutoPrintByRestaurant");
const RESTAURANT_PRINTED_PACKAGES_KEY = migratedStorageKey("restomapRestaurantPrintedPackages", "deliveraRestaurantPrintedPackages");
const RESTAURANT_PRINTED_PACKAGE_LIMIT = 250;
const RESTAURANT_WORKSPACE_REFRESH_MS = 12_000;

const restaurantState = {
  data: null,
  token: "",
  refreshToken: "",
  selectedRestaurantId: "",
  historyRange: "7d",
  historyVisibleCount: 50,
  packageLimit: 100,
  packageCursor: "0",
  workspacePollId: null,
  liveStream: null,
  orderAlarmTimer: null,
  orderAlarmKey: "",
  autoPrintEnabled: false,
  pendingAutoPrintKeys: new Set(),
  workspaceLoadPromise: null,
  queuedWorkspaceLoad: null,
  activeWorkspaceCard: "restaurant-integration-wizard",
};

function mountManualCustomerPanel() {
  const manualSection = document.getElementById("restaurantWorkspace_manual");
  const manualGrid = manualSection?.querySelector(".dashboard-grid");
  if (!manualSection || !manualGrid) return;

  manualGrid.classList.add("manual-entry-grid");
  const manualPackagePanel = manualGrid.querySelector(":scope > article.glass-panel");
  manualPackagePanel?.classList.add("manual-package-panel");

  const platformPanel = document.getElementById("manualPlatformOrderForm")?.closest(".glass-panel");
  const rightColumn = manualGrid.querySelector(":scope > div");

  manualPackagePanel?.querySelector(".panel-head")?.insertAdjacentHTML("beforeend", `
    <button id="manualPlatformToggleButton" class="ghost-btn compact-platform-toggle" type="button" aria-expanded="false" aria-controls="manualPlatformDrawer">+ Platform Siparisi Ekle</button>
  `);

  manualGrid.insertAdjacentHTML("afterend", `
    <section id="manualPlatformDrawer" class="glass-panel manual-platform-drawer hidden" aria-hidden="true">
      <div id="manualPlatformDrawerBody"></div>
    </section>
  `);

  const drawerBody = document.getElementById("manualPlatformDrawerBody");
  if (platformPanel && drawerBody) {
    platformPanel.classList.add("manual-platform-panel");
    drawerBody.appendChild(platformPanel);
  }
  if (rightColumn && rightColumn.children.length === 0) {
    rightColumn.remove();
  }

  document.getElementById("restaurantWorkspace_customers")?.remove();

  (document.getElementById("manualPlatformDrawer") || manualGrid).insertAdjacentHTML("afterend", `
    <section id="readyRecordsPanel" class="glass-panel ready-records-panel is-collapsed">
      <div class="panel-head">
        <div>
          <p class="eyebrow accent-coral">Kayitli Musteriler</p>
          <h3>Hazir Kayitlar</h3>
        </div>
        <button id="restaurantCustomerToggleButton" class="ghost-btn icon-btn ready-records-toggle" type="button" aria-expanded="false" aria-controls="readyRecordsBody" aria-label="Hazir kayitlari ac veya kapat">+</button>
      </div>
      <div id="readyRecordsBody" class="ready-records-body" hidden>
        <div class="ready-records-toolbar">
          <label class="full-width">
            Telefon / Isim
            <input id="restaurantCustomerListSearch" type="search" placeholder="Telefon veya isim ara">
          </label>
          <button id="restaurantCustomerNewButton" class="ghost-btn" type="button">Yeni Musteri</button>
        </div>
        <div id="restaurantCustomerMissing" class="empty-state hidden"></div>
        <div id="restaurantCustomerList" class="stack-list"></div>
        <div id="restaurantCustomerHistory" class="stack-list"></div>
        <form id="restaurantCustomerForm" class="form-grid hidden">
          <input id="restaurantCustomerEditId" name="id" type="hidden">
          <label class="full-width">
            Musteri Adi
            <input name="name" type="text" placeholder="Ad Soyad" required>
          </label>
          <label class="full-width">
            Telefon
            <input name="phone" type="tel" placeholder="05xx xxx xx xx" required>
          </label>
          <label class="full-width">
            Adres
            <textarea name="address" rows="3" placeholder="Teslimat adresi" required></textarea>
          </label>
          <label class="full-width">
            Not
            <textarea name="note" rows="2" placeholder="Apartman, tercih, dikkat notu"></textarea>
          </label>
          <button class="primary-btn full-width" type="submit">Musteriyi Kaydet</button>
        </form>
      </div>
    </section>
  `);
}

function setReadyRecordsOpen(isOpen) {
  const panel = restaurantRefs.readyRecordsPanel;
  const body = restaurantRefs.readyRecordsBody;
  const button = restaurantRefs.readyRecordsToggle;
  if (!panel || !body || !button) return;
  panel.classList.toggle("is-open", isOpen);
  panel.classList.toggle("is-collapsed", !isOpen);
  body.hidden = !isOpen;
  button.textContent = isOpen ? "-" : "+";
  button.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

function openReadyRecords() {
  setReadyRecordsOpen(true);
}

function toggleReadyRecords() {
  setReadyRecordsOpen(!restaurantRefs.readyRecordsPanel?.classList.contains("is-open"));
}

function setManualPlatformDrawerOpen(isOpen) {
  const drawer = restaurantRefs.manualPlatformDrawer;
  const button = restaurantRefs.manualPlatformToggle;
  if (!drawer || !button) return;
  drawer.classList.toggle("hidden", !isOpen);
  drawer.classList.toggle("is-open", isOpen);
  drawer.setAttribute("aria-hidden", isOpen ? "false" : "true");
  button.setAttribute("aria-expanded", isOpen ? "true" : "false");
  button.textContent = isOpen ? "Platform Siparisini Kapat" : "+ Platform Siparisi Ekle";
}

function toggleManualPlatformDrawer() {
  setManualPlatformDrawerOpen(!restaurantRefs.manualPlatformDrawer?.classList.contains("is-open"));
}

function findRestaurantCustomerByPhone(phone) {
  const digits = normalizeRestaurantPhone(phone);
  if (!digits) return null;
  return (restaurantState.data?.customers || []).find((customer) => {
    const customerDigits = normalizeRestaurantPhone(customer.phone);
    if (!customerDigits) return false;
    return customerDigits === digits || customerDigits.endsWith(digits) || digits.endsWith(customerDigits);
  }) || null;
}

async function searchRestaurantCustomerByPhone({ showNotFound = true } = {}) {
  const phone = restaurantRefs.customerPhoneSearch?.value?.trim() || "";
  const digits = normalizeRestaurantPhone(phone);
  if (!digits || digits.length < 5) {
    if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = "Telefon yazinca kayitli musteri aranir.";
    hideCustomerMissing();
    return null;
  }

  const cachedCustomer = findRestaurantCustomerByPhone(phone);
  if (cachedCustomer) {
    fillPackageFormFromCustomer(cachedCustomer);
    renderSelectedCustomerHistory(cachedCustomer);
    renderRestaurantCustomers(restaurantState.data?.customers || []);
    openReadyRecords();
    showToast("Kayitli musteri bulundu ve form dolduruldu.");
    return cachedCustomer;
  }

  try {
    const data = await api(`/api/restaurant/customers?phone=${encodeURIComponent(phone)}`, {
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
    });
    const customer = data.customers?.[0];
    if (!customer) {
      if (showNotFound) {
        if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = "Kayitli musteri bulunamadi.";
        showToast("Kayitli musteri bulunamadi.", "warning");
      }
      renderCustomerMissing(phone);
      openReadyRecords();
      return null;
    }

    fillPackageFormFromCustomer(customer);
    renderSelectedCustomerHistory(customer);
    renderRestaurantCustomers(data.customers || restaurantState.data?.customers || []);
    openReadyRecords();
    showToast("Kayitli musteri bulundu ve form dolduruldu.");
    return customer;
  } catch (error) {
    if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = error.message || "Musteri aramasi basarisiz.";
    showToast(error.message || "Musteri aramasi basarisiz.", "error");
    return null;
  }
}

mountManualCustomerPanel();

const restaurantRefs = {
  summary: document.getElementById("restaurantSummary"),
  accessForm: document.getElementById("restaurantAccessForm"),
  logoutButton: document.getElementById("restaurantLogoutButton"),
  createSection: document.getElementById("restaurantCreateSection"),
  workspace: document.getElementById("restaurantWorkspace"),
  platformAccountForm: document.getElementById("platformAccountForm"),
  manualPlatformOrderForm: document.getElementById("manualPlatformOrderForm"),
  manualPlatformToggle: document.getElementById("manualPlatformToggleButton"),
  manualPlatformDrawer: document.getElementById("manualPlatformDrawer"),
  packageForm: document.getElementById("packageForm"),
  packageRestaurantId: document.getElementById("packageRestaurantId"),
  restaurantCustomerId: document.getElementById("restaurantCustomerId"),
  customerPhoneSearch: document.getElementById("customerPhoneSearch"),
  customerPhoneSearchButton: document.getElementById("customerPhoneSearchButton"),
  customerSearchHint: document.getElementById("customerSearchHint"),
  readyRecordsPanel: document.getElementById("readyRecordsPanel"),
  readyRecordsBody: document.getElementById("readyRecordsBody"),
  readyRecordsToggle: document.getElementById("restaurantCustomerToggleButton"),
  customerForm: document.getElementById("restaurantCustomerForm"),
  customerEditId: document.getElementById("restaurantCustomerEditId"),
  customerList: document.getElementById("restaurantCustomerList"),
  customerListSearch: document.getElementById("restaurantCustomerListSearch"),
  customerNewButton: document.getElementById("restaurantCustomerNewButton"),
  customerMissing: document.getElementById("restaurantCustomerMissing"),
  customerHistory: document.getElementById("restaurantCustomerHistory"),
  packagePaymentMethod: document.getElementById("packagePaymentMethod"),
  platformSelect: document.getElementById("platformSelect"),
  manualPlatformSelect: document.getElementById("manualPlatformSelect"),
  restaurantList: document.getElementById("restaurantList"),
  platformAccountList: document.getElementById("platformAccountList"),
  recentOrders: document.getElementById("recentOrders"),
  searchInput: document.getElementById("restaurantSearchInput"),
  integrationEndpoint: document.getElementById("integrationEndpoint"),
  integrationRestaurant: document.getElementById("integrationRestaurant"),
  integrationApiKey: document.getElementById("integrationApiKey"),
  integrationPortalUsername: document.getElementById("integrationPortalUsername"),
  integrationWebhookSecret: document.getElementById("integrationWebhookSecret"),
  platformWebhookUrl: document.getElementById("platformWebhookUrl"),
  platformSetupName: document.getElementById("platformSetupName"),
  platformSetupAuth: document.getElementById("platformSetupAuth"),
  platformSetupStore: document.getElementById("platformSetupStore"),
  platformSetupHint: document.getElementById("platformSetupHint"),
  totalPackages: document.getElementById("restaurantTotalPackages"),
  waitingPackages: document.getElementById("restaurantWaitingPackages"),
  inTransitPackages: document.getElementById("restaurantInTransitPackages"),
  activeCouriers: document.getElementById("restaurantActiveCouriers"),
  performanceBoard: document.getElementById("restaurantPerformanceBoard"),
  liveBadge: document.getElementById("restaurantLiveBadge"),
  notificationCenter: document.getElementById("restaurantNotificationCenter"),
  enablePushButton: document.getElementById("restaurantEnablePushButton"),
  autoPrintStatus: document.getElementById("restaurantAutoPrintStatus"),
  autoPrintToggle: document.getElementById("restaurantAutoPrintToggle"),
  orderAlarm: document.getElementById("restaurantOrderAlarm"),
  orderAlarmMessage: document.getElementById("restaurantOrderAlarmMessage"),
  orderAlarmAcknowledge: document.getElementById("restaurantOrderAlarmAcknowledge"),
  activeOrders: document.getElementById("activeOrders"),
  orderHistory: document.getElementById("orderHistory"),
  historyMeta: document.getElementById("restaurantHistoryMeta"),
  historyMore: document.getElementById("restaurantHistoryMore"),
  historyFilters: document.getElementById("restaurantHistoryFilters"),
  samplePayload: document.getElementById("samplePayload"),
  samplePaymentMethod: document.getElementById("samplePaymentMethod"),
  integrationWizardSteps: document.getElementById("integrationWizardSteps"),
  reportTableBody: document.getElementById("restaurantReportTableBody"),
  printReportButton: document.getElementById("printReportButton"),
  reportDetailSection: document.getElementById("reportDetailSection"),
  reportDetailTitle: document.getElementById("reportDetailTitle"),
  reportDetailSubtitle: document.getElementById("reportDetailSubtitle"),
  reportCourierSummary: document.getElementById("reportCourierSummary"),
  reportDetailTableBody: document.getElementById("reportDetailTableBody"),
  exportReportExcel: document.getElementById("exportReportExcel"),
  exportDetailExcel: document.getElementById("exportDetailExcel"),
  closeReportDetail: document.getElementById("closeReportDetail"),
  integrationWizardWebhook: document.getElementById("integrationWizardWebhook"),
  integrationWizardStatus: document.getElementById("integrationWizardStatus"),
  copyWebhookButton: document.getElementById("copyWebhookButton"),
  mainQuickPasteRawText: document.getElementById("mainQuickPasteRawText"),
  mainQuickPasteParseButton: document.getElementById("mainQuickPasteParseButton"),
  packageImageInput: document.getElementById("packageImageInput"),
  packageImagePreview: document.getElementById("packageImagePreview"),
  cameraModal: document.getElementById("cameraModal"),
  openCameraButton: document.getElementById("openCameraButton"),
  closeCameraButton: document.getElementById("closeCameraButton"),
  cameraVideo: document.getElementById("cameraVideo"),
  captureCameraButton: document.getElementById("captureCameraButton"),
  cameraCanvas: document.getElementById("cameraCanvas"),
};

function restaurantAuthHeaders() {
  return authHeaders(restaurantState.token);
}

function readStoredRestaurantAuth() {
  try {
    restaurantState.token = localStorage.getItem(RESTAURANT_TOKEN_KEY) || "";
    restaurantState.refreshToken = localStorage.getItem(RESTAURANT_REFRESH_TOKEN_KEY) || "";
  } catch {
    restaurantState.token = "";
    restaurantState.refreshToken = "";
  }
}

function writeStoredRestaurantAuth() {
  try {
    if (restaurantState.token) {
      localStorage.setItem(RESTAURANT_TOKEN_KEY, restaurantState.token);
    } else {
      localStorage.removeItem(RESTAURANT_TOKEN_KEY);
    }
    if (restaurantState.refreshToken) {
      localStorage.setItem(RESTAURANT_REFRESH_TOKEN_KEY, restaurantState.refreshToken);
    } else {
      localStorage.removeItem(RESTAURANT_REFRESH_TOKEN_KEY);
    }
  } catch {}
}

function writeStoredRestaurantAccessInfo() {
  // Keep restaurant ID/API key in memory only. Persistent auth uses session tokens.
}

function clearStoredRestaurantAuth() {
  try {
    [
      RESTAURANT_TOKEN_KEY,
      RESTAURANT_REFRESH_TOKEN_KEY,
      RESTAURANT_ID_KEY,
      RESTAURANT_API_KEY_KEY,
      ...RESTAURANT_LEGACY_AUTH_KEYS,
    ].forEach((key) => localStorage.removeItem(key));
  } catch {}
}

function safeSetText(element, value) {
  if (!element) {
    return;
  }
  element.textContent = value;
}

function restaurantHtmlSafe(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function persistRestaurantAccessInfo(payload = {}) {
  const restaurantId = String(payload.restaurantId || payload.id || "").trim();
  const apiKey = String(payload.apiKey || "").trim();
  restaurantState.storedRestaurantId = restaurantId;
  restaurantState.storedApiKey = apiKey;
  writeStoredRestaurantAccessInfo();
}

function clearRestaurantAccessInfo() {
  restaurantState.storedRestaurantId = "";
  restaurantState.storedApiKey = "";
}

function applyRestaurantAccessFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const restaurantId = String(params.get("restaurant_id") || params.get("restaurantId") || "").trim();
  const apiKey = String(params.get("api_key") || params.get("apiKey") || "").trim();
  if (restaurantId && apiKey) {
    persistRestaurantAccessInfo({ restaurantId, apiKey });
  }
}

async function tryRestaurantSessionFromStoredAccess() {
  const restaurantId = restaurantState.storedRestaurantId || "";
  const apiKey = restaurantState.storedApiKey || "";
  if (!restaurantId || !apiKey || restaurantState.token) {
    return false;
  }

  const data = await api("/api/restaurant/session", {
    method: "POST",
    headers: {
      "x-restaurant-id": restaurantId,
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ restaurantId, apiKey }),
  });
  persistRestaurantAuth(data);
  hydrateRestaurant(data.state);
  startRestaurantWorkspacePolling();
  startRestaurantLiveStream();
  return true;
}

function persistRestaurantAuth(auth) {
  restaurantState.token = auth.token;
  restaurantState.refreshToken = auth.refreshToken;
  writeStoredRestaurantAuth();
  const currentRestaurant = auth?.state?.restaurants?.[0];
  if (currentRestaurant) {
    persistRestaurantAccessInfo({
      restaurantId: currentRestaurant.id,
      apiKey: currentRestaurant.apiKey,
    });
  }
}

function clearRestaurantAuth() {
  restaurantState.token = "";
  restaurantState.refreshToken = "";
  clearStoredRestaurantAuth();
  restaurantState.data = null;
  restaurantState.selectedRestaurantId = "";
  stopRestaurantWorkspacePolling();
  restaurantState.liveStream?.close?.();
  restaurantState.liveStream = null;
  stopRestaurantOrderAlarm();
  clearRestaurantAccessInfo();
}

async function refreshRestaurantAccess() {
  if (!restaurantState.refreshToken) {
    throw new Error("Restoran refresh token bulunamadi.");
  }

  try {
    const auth = await api("/api/restaurant/refresh", {
      method: "POST",
      body: JSON.stringify({
        refreshToken: restaurantState.refreshToken,
      }),
    });
    persistRestaurantAuth(auth);
    return auth;
  } catch (err) {
    if (err.status === 401) {
      clearRestaurantAuth();
      window.location.reload();
    }
    throw err;
  }
}

function setRestaurantWorkspaceVisible(isVisible) {
  const isLoggedIn = !!restaurantState.token;
  const hasRestaurant = isVisible; // isVisible is true when restaurants array is not empty
  
  restaurantRefs.workspace.classList.toggle("hidden", !hasRestaurant);
  restaurantRefs.logoutButton.classList.toggle("hidden", !isLoggedIn);
  restaurantRefs.createSection.classList.toggle("hidden", !(isLoggedIn && !hasRestaurant));
  
  if (restaurantRefs.accessForm) {
    const loginSection = restaurantRefs.accessForm.closest('.topbar');
    if (loginSection) {
      loginSection.classList.toggle("hidden", isLoggedIn);
    }
  }
  
  document.body.classList.toggle("app-unauthenticated", !isLoggedIn);
}

function syncRestaurantWorkspaceCards() {
  const cards = [...document.querySelectorAll(".workspace-collapsible-restaurant")];
  cards.forEach((card) => {
    const isActive = card.dataset.cardKey === restaurantState.activeWorkspaceCard;
    card.classList.toggle("panel-expanded", isActive);
    card.classList.toggle("panel-collapsed", !isActive);
    const header = card.querySelector(".panel-head");
    if (header) {
      header.setAttribute("aria-expanded", isActive ? "true" : "false");
    }
  });
}

function initializeRestaurantWorkspaceCards() {
  const cardMap = [
    ["#restaurantWorkspace > section:nth-of-type(2) > article:nth-of-type(1)", "restaurant-performance"],
    ["#restaurantWorkspace > section:nth-of-type(2) > article:nth-of-type(2)", "restaurant-integration-wizard"],
    ["#restaurantWorkspace > section:nth-of-type(3)", "restaurant-notifications"],
    ["#restaurantWorkspace > section:nth-of-type(4) > article:nth-of-type(3)", "restaurant-payload"],
    ["#restaurantWorkspace > section:nth-of-type(6)", "restaurant-history"],
    ["#restaurantWorkspace > section:nth-of-type(7) > article:nth-of-type(1)", "restaurant-platform-form"],
    ["#restaurantWorkspace > section:nth-of-type(7) > article:nth-of-type(2)", "restaurant-webhook-info"],
    ["#restaurantWorkspace > section:nth-of-type(8)", "restaurant-account"],
    ["#restaurantWorkspace > section:nth-of-type(9)", "restaurant-platform-accounts"],
  ];

  cardMap.forEach(([selector, key]) => {
    const card = document.querySelector(selector);
    if (!card) {
      return;
    }

    card.dataset.cardKey = key;
    card.classList.add("workspace-collapsible", "workspace-collapsible-restaurant");

    const header = card.querySelector(".panel-head");
    if (!header || header.dataset.bound === "1") {
      return;
    }

    header.dataset.bound = "1";
    header.classList.add("panel-toggle-head");
    header.tabIndex = 0;
    header.setAttribute("role", "button");

    const activate = () => {
      restaurantState.activeWorkspaceCard = restaurantState.activeWorkspaceCard === key ? "" : key;
      syncRestaurantWorkspaceCards();
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

  syncRestaurantWorkspaceCards();
}

function stopRestaurantWorkspacePolling() {
  if (restaurantState.workspacePollId !== null) {
    window.clearInterval(restaurantState.workspacePollId);
    restaurantState.workspacePollId = null;
  }
}

function startRestaurantWorkspacePolling() {
  if (restaurantState.workspacePollId !== null || !restaurantState.token) {
    return;
  }

  restaurantState.workspacePollId = window.setInterval(() => {
    loadRestaurantWorkspace({ silent: true });
  }, RESTAURANT_WORKSPACE_REFRESH_MS);
}

function stopRestaurantOrderAlarm() {
  if (restaurantState.orderAlarmTimer !== null) {
    window.clearInterval(restaurantState.orderAlarmTimer);
    restaurantState.orderAlarmTimer = null;
  }
  restaurantState.orderAlarmKey = "";
  restaurantRefs.orderAlarm?.classList.add("hidden");
}

function startRestaurantOrderAlarm(event = {}) {
  const alarmKey = String(event.packageId || event.orderId || `${event.type || "order"}:${event.createdAt || Date.now()}`);
  if (restaurantState.orderAlarmKey === alarmKey && restaurantState.orderAlarmTimer !== null) {
    return;
  }
  if (restaurantState.orderAlarmTimer !== null) {
    window.clearInterval(restaurantState.orderAlarmTimer);
  }
  restaurantState.orderAlarmKey = alarmKey;
  if (restaurantRefs.orderAlarmMessage) {
    restaurantRefs.orderAlarmMessage.textContent = event.message || "Siparis detaylarini kontrol edin.";
  }
  restaurantRefs.orderAlarm?.classList.remove("hidden");
  playSignal("assignment-long");
  restaurantState.orderAlarmTimer = window.setInterval(() => {
    playSignal("assignment-long");
  }, 8000);
}

function shouldSuppressRestaurantOrderAlert(event = {}) {
  const source = String(event.source || "").trim().toLowerCase();
  return event.suppressRestaurantAlert === true || [
    "manual",
    "external_manual",
    "platform_manual",
    "restaurant_panel",
  ].includes(source);
}

function startRestaurantLiveStream() {
  if (restaurantState.liveStream || !restaurantState.token) {
    return;
  }

  restaurantState.liveStream = connectLiveStream("/api/restaurant/stream", restaurantState.token, {
    onMessage(event) {
      const isNewOrderEvent = ["package-created", "platform-order", "platform-order-pending", "integration-order", "order:new"].includes(event?.type);
      const suppressRestaurantAlert = shouldSuppressRestaurantOrderAlert(event);
      if (event?.message && !suppressRestaurantAlert) {
        showToast(event.message, notificationTone(event.type));
        if (isNewOrderEvent) {
          startRestaurantOrderAlarm(event);
        } else if (event.type === "assignment-waiting") {
          playSignal("critical");
        } else if (event.type === "package-status") {
          playSignal("ready");
        }
      }
      if (event?.type !== "courier-location") {
        if (isNewOrderEvent) {
          queueAutomaticPackagePrint(event);
        }
        loadRestaurantWorkspace({ silent: true, force: true })
          .then(() => flushAutomaticPackagePrintQueue())
          .catch(() => {});
      }
    },
    onError() {
      if (restaurantRefs.liveBadge) {
        restaurantRefs.liveBadge.textContent = "Canli akis tekrar baglaniyor";
      }
      restaurantState.liveStream?.close?.();
      restaurantState.liveStream = null;
      window.setTimeout(() => startRestaurantLiveStream(), 2000);
    },
  });
}

function renderPlatformChecks() {
  if (!restaurantRefs.platformChecks) {
    return;
  }
  restaurantRefs.platformChecks.innerHTML = PLATFORM_OPTIONS.map((platform) => `
    <label class="chip-option">
      <input type="checkbox" name="platforms" value="${platform}">
      <span>${platform}</span>
    </label>
  `).join("");
}

function setLabelText(label, text) {
  if (!label) {
    return;
  }

  const textNode = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (textNode) {
    textNode.textContent = `\n              ${text}\n              `;
    return;
  }

  label.prepend(document.createTextNode(`${text} `));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isGetirPlatform(platform = "") {
  return String(platform).toLowerCase().includes("getir");
}

function isTrendyolPlatform(platform = "") {
  return String(platform).toLowerCase().includes("trendyol");
}

function isYemeksepetiPlatform(platform = "") {
  return String(platform).toLowerCase().includes("yemeksepeti");
}

function platformClientConfig(platform = "") {
  if (isTrendyolPlatform(platform)) {
    return {
      mode: "polling",
      testStrategy: "polling",
      webhookEnabled: false,
      pollingEnabled: true,
      requiredFields: ["externalStoreId", "apiKey", "apiSecret"],
      label: "Polling otomatik aktif",
    };
  }
  if (isGetirPlatform(platform)) {
    return {
      mode: "webhook",
      testStrategy: "local_webhook",
      webhookEnabled: true,
      pollingEnabled: false,
      requiredFields: ["externalStoreId", "staticToken"],
      label: "Webhook otomatik aktif",
    };
  }
  if (isYemeksepetiPlatform(platform)) {
    return {
      mode: "hybrid",
      testStrategy: "auto",
      webhookEnabled: true,
      pollingEnabled: true,
      requiredFields: ["externalStoreId", "staticToken"],
      label: "Webhook/Polling otomatik",
    };
  }
  return {
    mode: "webhook",
    testStrategy: "local_webhook",
    webhookEnabled: true,
    pollingEnabled: false,
    requiredFields: ["externalStoreId", "staticToken"],
    label: "Otomatik mod",
  };
}

function platformFriendlyMessage(message = "", account = null) {
  const text = String(message || "").trim();
  if (!text) {
    return "";
  }
  if (/Restaurant\/platform match failed/i.test(text)) {
    return "Restoran ID bu platformla eşleşmedi. Gerçek Store/Restaurant ID girilmeli.";
  }
  if (/Polling endpoint ayarl[ıi] de[ğg]il|polling endpoint not configured/i.test(text)) {
    return "Bu platform polling desteklemiyor. Webhook modu kullanılacak.";
  }
  if (/API eri|yetki kapal|403/i.test(text)) {
    return "Bu restoran için API yetkisi kapalı. Platform panelinden API/POS entegrasyon izni açılmalı.";
  }
  if (/Unauthorized|401|API Key veya API Secret hatal/i.test(text)) {
    return "API Key, Secret veya Token hatalı olabilir.";
  }
  return text;
}

function isBenignPlatformMessage(message = "", account = null) {
  const text = String(message || "").trim();
  return /Polling kapal[ıi]|polling desteklemiyor|Webhook modu kullanılacak/i.test(text) ||
    (/Polling endpoint/i.test(text) && isGetirPlatform(account?.platform));
}

function isTemporaryPlatformId(value = "") {
  return /(^|[-_])(test|demo|sample|ornek|örnek)([-_]|$)|getir-restaurant-\d+|test-store-\d+/i.test(String(value || "").trim());
}

function platformHintCard(message, tone = "info") {
  if (!message) {
    return "";
  }
  return `<div class="platform-alert platform-alert-${tone}">${escapeHtml(message)}</div>`;
}

function platformStatusChip(text, tone = "neutral", icon = "•") {
  return `<span class="platform-chip platform-chip-${tone}"><span aria-hidden="true">${icon}</span>${escapeHtml(text)}</span>`;
}

function connectionStatusForAccount(account, pollingReady = false, webhookReady = false) {
  if (account?.connectionStatus) {
    return {
      connected: { text: "Bağlantı aktif", tone: "success" },
      warning: { text: "Uyarı var", tone: "warning" },
      error: { text: "Hatalı", tone: "error" },
      disabled: { text: "Devre dışı", tone: "neutral" },
      unknown: { text: "Kontrol edilmedi", tone: "warning" },
    }[account.connectionStatus] || { text: "Kontrol edilmedi", tone: "warning" };
  }
  const errorText = platformFriendlyMessage(account?.lastError || "", account);
  if (errorText && !isBenignPlatformMessage(errorText, account)) {
    if (/API yetkisi/i.test(errorText)) {
      return { text: "API yetkisi bekliyor", tone: "warning" };
    }
    return { text: "Hata var", tone: "error" };
  }
  if (account?.verificationStatus === "verified" || account?.lastVerificationAt || account?.lastWebhookAt || account?.lastPollAt) {
    return { text: "Bağlandı", tone: "success" };
  }
  if (pollingReady || webhookReady) {
    return { text: "Hazır", tone: "success" };
  }
  return { text: "Bağlantı bekliyor", tone: "warning" };
}

function simplifyPlatformAccountForm() {
  const form = restaurantRefs.platformAccountForm;
  if (!form) {
    return;
  }

  const storeInput = form.querySelector('[name="externalStoreId"]');
  const platformSelect = form.querySelector('[name="platform"]');
  const secretInput = form.querySelector('[name="staticToken"], [name="webhookSecret"]');
  const initiallyHiddenFieldNames = [
    "externalMerchantId",
    "webhookAuthType",
    "apiUsername",
    "apiPassword",
    "storeFrontCode",
    "chainId",
    "vendorId",
    "posSecretKey",
  ];

  initiallyHiddenFieldNames.forEach((name) => {
    const field = form.querySelector(`[name="${name}"]`);
    const label = field?.closest("label");
    if (!field || !label) {
      return;
    }
    field.required = false;
    field.disabled = true;
    label.classList.add("hidden");
  });

  if (storeInput) {
    setLabelText(storeInput.closest("label"), "Platform Restaurant ID / Store ID / Vendor ID");
    storeInput.placeholder = "Platformdaki gerçek restoran/store ID";
  }

  if (secretInput) {
    const secretLabel = secretInput.closest("label");
    setLabelText(secretLabel, "Webhook Secret");
    secretInput.type = "password";
    secretInput.placeholder = "Webhook icin gizli anahtar";
    secretInput.required = true;
    if (storeInput?.closest("label") && secretLabel) {
      storeInput.closest("label").insertAdjacentElement("afterend", secretLabel);
    }
  }

  const authTitle = restaurantRefs.platformSetupAuth?.previousElementSibling;
  if (authTitle) {
    authTitle.textContent = "Webhook Secret";
  }
  const storeTitle = restaurantRefs.platformSetupStore?.previousElementSibling;
  if (storeTitle) {
    storeTitle.textContent = "Platform Restaurant ID";
  }

  ["apiKey", "apiSecret", "token"].forEach((name) => {
    const field = form.querySelector(`[name="${name}"]`);
    if (field) {
      field.type = "password";
      field.autocomplete = "new-password";
    }
  });

  if (!form.querySelector(".platform-form-hint")) {
    const hint = document.createElement("div");
    hint.className = "platform-form-hint full-width";
    platformSelect?.closest("label")?.insertAdjacentElement("afterend", hint);
  }

  applyPlatformFormMode();
}

function setFieldVisible(form, name, isVisible) {
  const field = form.querySelector(`[name="${name}"]`);
  const label = field?.closest("label");
  if (!field || !label) {
    return;
  }
  label.classList.toggle("hidden", !isVisible);
  field.disabled = !isVisible;
  field.required = false;
}

function setCheckboxValue(form, name, checked) {
  const field = form.querySelector(`[name="${name}"]`);
  if (field) {
    field.checked = checked;
  }
}

function applyPlatformFormMode() {
  const form = restaurantRefs.platformAccountForm;
  if (!form) {
    return;
  }

  const platform = form.querySelector('[name="platform"]')?.value || "";
  const config = platformClientConfig(platform);
  const isGetir = isGetirPlatform(platform);
  const isTrendyol = isTrendyolPlatform(platform);
  const isYemeksepeti = isYemeksepetiPlatform(platform);
  const storeInput = form.querySelector('[name="externalStoreId"]');
  const secretInput = form.querySelector('[name="staticToken"]');
  const apiSecretInput = form.querySelector('[name="apiSecret"]');
  const apiKeyInput = form.querySelector('[name="apiKey"]');
  const tokenInput = form.querySelector('[name="token"]');
  const hint = form.querySelector(".platform-form-hint");
  const webhookToggleLabel = form.querySelector('[name="webhookEnabled"]')?.closest("label");
  const pollingToggleLabel = form.querySelector('[name="pollingEnabled"]')?.closest("label");
  const activeToggleLabel = form.querySelector('[name="active"]')?.closest("label");

  ["externalStoreId", "staticToken", "apiKey", "apiSecret", "token", "integrationReferenceCode"].forEach((name) => {
    setFieldVisible(form, name, true);
  });
  webhookToggleLabel?.classList.add("hidden");
  pollingToggleLabel?.classList.add("hidden");
  activeToggleLabel?.classList.add("hidden");
  setCheckboxValue(form, "webhookEnabled", config.webhookEnabled);
  setCheckboxValue(form, "pollingEnabled", config.pollingEnabled);
  setCheckboxValue(form, "active", true);

  if (isGetir) {
    setLabelText(storeInput?.closest("label"), "Restaurant ID / Store ID");
    storeInput.placeholder = "Gerçek Getir restoran/store ID";
    storeInput.required = true;
    setLabelText(secretInput?.closest("label"), "Webhook Secret");
    secretInput.placeholder = "Getir webhook secret";
    secretInput.required = true;
    setLabelText(apiSecretInput?.closest("label"), "API Secret (opsiyonel)");
    apiSecretInput.placeholder = "Boş bırakılırsa webhook secret kullanılabilir";
    apiSecretInput.required = false;
    setFieldVisible(form, "apiKey", false);
    setFieldVisible(form, "token", false);
    if (hint) {
      hint.textContent = "Getir Yemek webhook modu ile otomatik çalışır. Store/Restaurant ID ve Webhook Secret girip kaydet.";
    }
  } else if (isTrendyol) {
    setLabelText(storeInput?.closest("label"), "Restaurant ID / Supplier ID");
    storeInput.placeholder = "Trendyol restaurant/supplier ID";
    storeInput.required = true;
    setLabelText(secretInput?.closest("label"), "Webhook Secret");
    secretInput.placeholder = "Webhook kullanılıyorsa secret";
    secretInput.required = false;
    setLabelText(apiKeyInput?.closest("label"), "API Key");
    apiKeyInput.required = true;
    setLabelText(apiSecretInput?.closest("label"), "API Secret");
    apiSecretInput.required = true;
    setLabelText(tokenInput?.closest("label"), "Token (opsiyonel)");
    tokenInput.required = false;
    if (hint) {
      hint.textContent = "Trendyol Yemek polling modu ile otomatik çalışır. Supplier ID, API Key ve API Secret zorunludur.";
    }
  } else if (isYemeksepeti) {
    setLabelText(storeInput?.closest("label"), "Vendor / Restaurant ID");
    storeInput.placeholder = "Yemeksepeti vendor/restaurant ID";
    storeInput.required = true;
    setLabelText(secretInput?.closest("label"), "Webhook Secret");
    secretInput.required = true;
    setLabelText(apiKeyInput?.closest("label"), "API Key (opsiyonel)");
    apiKeyInput.required = false;
    setLabelText(apiSecretInput?.closest("label"), "API Secret (opsiyonel)");
    apiSecretInput.required = false;
    setLabelText(tokenInput?.closest("label"), "Token (opsiyonel)");
    tokenInput.required = false;
    if (hint) {
      hint.textContent = "Yemeksepeti webhook/polling destek durumuna göre otomatik çalışır. API bilgisi yoksa webhook modu kullanılır.";
    }
  } else if (hint) {
    storeInput.required = true;
    secretInput.required = true;
    hint.textContent = "Platforma ait gerçek restoran/store ID ve gerekli secret bilgilerini girin. Mod seçimi otomatik yapılır.";
  }
}

function normalizePlatformSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "_")
    .replaceAll("-", "_");
}

function readJsonStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function autoPrintPreferenceMap() {
  const stored = readJsonStorage(RESTAURANT_AUTO_PRINT_KEY, {});
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}

function isAutoPrintEnabledForRestaurant(restaurantId) {
  return Boolean(restaurantId && autoPrintPreferenceMap()[restaurantId]);
}

function updateAutoPrintControls() {
  const restaurantId = restaurantState.selectedRestaurantId;
  const ready = Boolean(restaurantId);
  restaurantState.autoPrintEnabled = ready && isAutoPrintEnabledForRestaurant(restaurantId);
  if (restaurantRefs.autoPrintToggle) {
    restaurantRefs.autoPrintToggle.disabled = !ready;
    restaurantRefs.autoPrintToggle.textContent = restaurantState.autoPrintEnabled ? "Otomatik Fişi Kapat" : "Otomatik Fişi Aç";
    restaurantRefs.autoPrintToggle.setAttribute("aria-pressed", restaurantState.autoPrintEnabled ? "true" : "false");
  }
  if (restaurantRefs.autoPrintStatus) {
    restaurantRefs.autoPrintStatus.textContent = restaurantState.autoPrintEnabled
      ? "58 mm otomatik fiş açık"
      : "58 mm otomatik fiş kapalı";
  }
}

function setAutoPrintEnabledForRestaurant(restaurantId, enabled) {
  if (!restaurantId) return false;
  const preferences = autoPrintPreferenceMap();
  if (enabled) {
    preferences[restaurantId] = true;
  } else {
    delete preferences[restaurantId];
  }
  writeJsonStorage(RESTAURANT_AUTO_PRINT_KEY, preferences);
  restaurantState.autoPrintEnabled = Boolean(enabled);
  updateAutoPrintControls();
  return restaurantState.autoPrintEnabled;
}

function printedPackageStorageKey(restaurantId) {
  return `${RESTAURANT_PRINTED_PACKAGES_KEY}:${restaurantId || "unknown"}`;
}

function printedPackageIds(restaurantId) {
  const stored = readJsonStorage(printedPackageStorageKey(restaurantId), []);
  return Array.isArray(stored) ? stored.map((id) => String(id)).filter(Boolean) : [];
}

function hasAutoPrintedPackage(restaurantId, packageId) {
  return Boolean(packageId && printedPackageIds(restaurantId).includes(String(packageId)));
}

function markPackageAutoPrinted(restaurantId, packageId) {
  if (!restaurantId || !packageId) return;
  const next = printedPackageIds(restaurantId).filter((id) => id !== String(packageId));
  next.push(String(packageId));
  writeJsonStorage(printedPackageStorageKey(restaurantId), next.slice(-RESTAURANT_PRINTED_PACKAGE_LIMIT));
}

function thermalReceiptItemsHtml(pkg) {
  if (!Array.isArray(pkg.items) || pkg.items.length === 0) {
    return '<div class="empty-line">Ürün bilgisi platformdan gelmedi.</div>';
  }
  return pkg.items.map((item) => {
    const quantity = Math.max(1, Number(item.quantity || item.count || 1));
    const unitPrice = Number(item.price ?? item.unitPrice ?? 0);
    const lineTotal = Number(item.total ?? item.totalPrice ?? (unitPrice * quantity));
    const priceText = lineTotal > 0 ? formatCurrency(lineTotal) : "";
    return `
      <div class="item-row">
        <span class="item-quantity">${escapeHtml(quantity)}×</span>
        <span class="item-name">${escapeHtml(item.name || item.productName || "Ürün")}</span>
        <strong>${escapeHtml(priceText)}</strong>
      </div>
      ${item.note || item.description ? `<div class="item-note">${escapeHtml(item.note || item.description)}</div>` : ""}
    `;
  }).join("");
}

function buildThermalReceiptHtml(pkg, restaurantName = "RESTOMAP") {
  const orderCode = pkg.externalOrderNo || pkg.platformOrderId || pkg.trackingNo || pkg.id || "Sipariş";
  const trackingCode = pkg.trackingNo || pkg.id || "-";
  const note = pkg.customerNote || pkg.note || "-";
  return `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(orderCode)} - 58 mm Fiş</title>
    <style>
      @page { size: 58mm auto; margin: 0; }
      * { box-sizing: border-box; }
      html, body { width: 58mm; margin: 0; padding: 0; background: #fff; color: #000; }
      body { width: 54mm; padding: 2mm; font-family: Arial, Helvetica, sans-serif; font-size: 10.5px; line-height: 1.28; }
      h1 { margin: 0; text-align: center; font-size: 15px; line-height: 1.15; }
      .center { text-align: center; }
      .order-code { margin: 2mm 0 1mm; font-size: 15px; font-weight: 800; text-align: center; overflow-wrap: anywhere; }
      .divider { margin: 1.5mm 0; border-top: 1px dashed #000; }
      .row { display: flex; justify-content: space-between; gap: 2mm; margin: 0.7mm 0; }
      .row span:first-child { flex: 0 0 18mm; }
      .row strong { flex: 1; text-align: right; overflow-wrap: anywhere; }
      .block { margin: 1mm 0; overflow-wrap: anywhere; }
      .label { display: block; margin-bottom: 0.4mm; font-weight: 700; }
      .items-title { font-size: 12px; font-weight: 800; }
      .item-row { display: grid; grid-template-columns: 6mm 1fr auto; gap: 1mm; align-items: start; margin: 1mm 0; }
      .item-name { font-weight: 700; overflow-wrap: anywhere; }
      .item-note { margin: -0.5mm 0 1mm 7mm; font-size: 9px; }
      .empty-line { margin: 1mm 0; font-style: italic; }
      .total { font-size: 14px; font-weight: 800; }
      .footer { margin-top: 2mm; text-align: center; font-size: 9px; }
      @media screen { body { margin: 0 auto; border: 1px solid #ddd; } }
      @media print { html, body { width: 58mm !important; } body { width: 54mm !important; } }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(restaurantName)}</h1>
    <div class="center">${escapeHtml(pkg.sourcePlatform || packageSourceLabel(pkg) || "Restoran Siparişi")}</div>
    <div class="order-code">${escapeHtml(orderCode)}</div>
    <div class="center">Paket: ${escapeHtml(trackingCode)}</div>
    <div class="divider"></div>
    <div class="row"><span>Tarih</span><strong>${escapeHtml(formatDate(pkg.createdAt))}</strong></div>
    <div class="row"><span>Müşteri</span><strong>${escapeHtml(pkg.recipient || "-")}</strong></div>
    <div class="row"><span>Telefon</span><strong>${escapeHtml(pkg.phone || "-")}</strong></div>
    <div class="block"><span class="label">Adres</span>${escapeHtml(pkg.deliveryAddress || pkg.address || "-")}</div>
    <div class="divider"></div>
    <div class="items-title">ÜRÜNLER</div>
    ${thermalReceiptItemsHtml(pkg)}
    <div class="divider"></div>
    <div class="row"><span>Ödeme</span><strong>${escapeHtml(pkg.paymentMethod || "-")}</strong></div>
    <div class="row total"><span>TOPLAM</span><strong>${escapeHtml(formatCurrency(pkg.orderAmount || 0))}</strong></div>
    <div class="divider"></div>
    <div class="block"><span class="label">Müşteri Notu</span>${escapeHtml(note)}</div>
    <div class="footer">RESTOMAP · 58 mm restoran fişi</div>
  </body>
</html>`;
}

function printThermalReceiptInFrame(pkg, restaurantName = "RESTOMAP") {
  const frame = document.createElement("iframe");
  frame.setAttribute("title", "58 mm sipariş fişi");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.width = "1px";
  frame.style.height = "1px";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.style.left = "-10000px";
  document.body.appendChild(frame);
  const printWindow = frame.contentWindow;
  if (!printWindow?.document) {
    frame.remove();
    return false;
  }
  printWindow.document.open();
  printWindow.document.write(buildThermalReceiptHtml(pkg, restaurantName));
  printWindow.document.close();
  window.setTimeout(() => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch {
      showToast("58 mm fiş yazdırılamadı; sipariş kartındaki tekrar yazdır butonunu kullanın.", "error");
    } finally {
      window.setTimeout(() => frame.remove(), 3000);
    }
  }, 180);
  return true;
}

function openPackagePrintWindow(pkg, restaurantName = "RESTOMAP") {
  let win = null;
  try {
    win = window.open("", "_blank", "width=390,height=760");
  } catch {}
  if (!win) {
    const fallbackStarted = printThermalReceiptInFrame(pkg, restaurantName);
    showToast(
      fallbackStarted ? "58 mm fiş yazdırma ekranına gönderildi." : "Yazdırma penceresi açılamadı.",
      fallbackStarted ? "warning" : "error"
    );
    return fallbackStarted;
  }
  win.document.open();
  win.document.write(buildThermalReceiptHtml(pkg, restaurantName));
  win.document.close();
  win.onafterprint = () => win.close();
  win.focus();
  window.setTimeout(() => win.print(), 180);
  return true;
}

function queueAutomaticPackagePrint(event = {}) {
  if (!restaurantState.autoPrintEnabled) return false;
  const printKey = String(event.packageId || event.orderId || "").trim();
  if (!printKey) return false;
  restaurantState.pendingAutoPrintKeys.add(printKey);
  return true;
}

function flushAutomaticPackagePrintQueue() {
  if (!restaurantState.autoPrintEnabled || !restaurantState.data || restaurantState.pendingAutoPrintKeys.size === 0) {
    return 0;
  }
  const restaurantId = restaurantState.selectedRestaurantId || restaurantState.data.restaurants?.[0]?.id || "";
  const restaurantName = restaurantState.data.restaurants?.[0]?.name || "RESTOMAP";
  let printedCount = 0;
  [...restaurantState.pendingAutoPrintKeys].forEach((printKey) => {
    const pkg = (restaurantState.data.packages || []).find((item) =>
      [item.id, item.externalOrderId, item.externalOrderNo, item.platformOrderId, item.trackingNo]
        .filter(Boolean)
        .map(String)
        .includes(printKey)
    );
    if (!pkg) return;
    restaurantState.pendingAutoPrintKeys.delete(printKey);
    if (hasAutoPrintedPackage(restaurantId, pkg.id)) return;
    if (printThermalReceiptInFrame(pkg, restaurantName)) {
      markPackageAutoPrinted(restaurantId, pkg.id);
      printedCount += 1;
      showToast(`${packageDisplayCode(pkg)} için 58 mm fiş yazıcıya gönderildi.`);
    }
  });
  return printedCount;
}

function normalizedPasteText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function findLabeledValue(text, labels = []) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`${escaped}\\s*[:\\-]?\\s*(.+)`, "i"));
    if (match?.[1]) {
      const value = match[1].split("\n")[0].trim();
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function quickPasteKey(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function quickPasteLineMap(text) {
  const rows = String(text || "").split("\n").map((line) => line.trim());
  return rows.map((line, index) => {
    const match = line.match(/^([^:\-#]{2,48})\s*[:\-]\s*(.*)$/u);
    return {
      index,
      line,
      key: match ? quickPasteKey(match[1]) : "",
      value: match ? match[2].trim() : "",
      hasLabel: Boolean(match),
    };
  });
}

function requestRestaurantNotificationPermission() {
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

function restaurantPushApplicationServerKey(base64Value) {
  const padding = "=".repeat((4 - (base64Value.length % 4)) % 4);
  const base64 = (base64Value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function updateRestaurantPushButton(enabled = false) {
  if (!restaurantRefs.enablePushButton) return;
  const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  restaurantRefs.enablePushButton.disabled = permission === "unsupported";
  restaurantRefs.enablePushButton.textContent = permission === "denied"
    ? "Bildirim Engelli"
    : (enabled ? "Bildirim Acik - Sesi Test Et" : "Bildirimleri ve Sesi Ac");
}

async function initializeRestaurantPush(options = {}) {
  if (!restaurantState.token || !('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === "undefined") {
    updateRestaurantPushButton(false);
    return false;
  }

  let permission = Notification.permission;
  if (options.requestPermission && permission === "default") {
    permission = await requestRestaurantNotificationPermission();
  }
  if (permission !== "granted") {
    updateRestaurantPushButton(false);
    if (options.requestPermission && permission === "denied") {
      showToast("Chrome bildirim izni engelli. Adres cubugundaki kilit simgesinden Bildirimler iznini acin.", "warning");
    }
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.register("/courier-push-sw.js", { scope: "/" });
    const keyResponse = await api("/api/restaurant/push/public-key", {
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
    });
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: restaurantPushApplicationServerKey(keyResponse.publicKey),
      });
    }
    await api("/api/restaurant/push/subscriptions", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      body: JSON.stringify({ subscription: subscription.toJSON() }),
      retryWithRefresh: refreshRestaurantAccess,
    });
    updateRestaurantPushButton(true);
    if (options.requestPermission) {
      await api("/api/restaurant/push/test", {
        method: "POST",
        headers: restaurantAuthHeaders(),
        body: JSON.stringify({}),
        retryWithRefresh: refreshRestaurantAccess,
      });
      playSignal("assignment-long");
      showToast("Bildirimler acildi. Duydugunuz ses yeni siparis alarmidir.", "success");
    }
    return true;
  } catch (error) {
    updateRestaurantPushButton(false);
    if (options.requestPermission) {
      showToast(error.message || "Bildirimler etkinlestirilemedi.", "error");
    }
    return false;
  }
}

async function currentRestaurantPushEndpoint() {
  if (!("serviceWorker" in navigator)) return "";
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager?.getSubscription?.();
    return subscription?.endpoint || "";
  } catch {
    return "";
  }
}

function quickPasteValue(text, labels = []) {
  const wanted = new Set(labels.map(quickPasteKey));
  const row = quickPasteLineMap(text).find((item) => item.hasLabel && wanted.has(item.key) && item.value);
  return row?.value || "";
}

function quickPasteBlock(text, labels = []) {
  const rows = quickPasteLineMap(text);
  const wanted = new Set(labels.map(quickPasteKey));
  const stopLabels = new Set([
    "not", "aciklama", "adres tarifi", "kurye notu", "musteri notu", "siparis icerigi",
    "siparis icerigi", "urunler", "odeme", "odeme tipi", "tutar", "toplam", "toplam tutar",
    "telefon", "tel", "musteri", "musteri adi", "ad soyad", "siparis no", "order id"
  ]);
  const start = rows.find((item) => item.hasLabel && wanted.has(item.key));
  if (!start) return "";
  const parts = [];
  if (start.value) parts.push(start.value);
  for (let index = start.index + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.line) {
      if (parts.length) break;
      continue;
    }
    if (row.hasLabel && stopLabels.has(row.key)) break;
    parts.push(row.line);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function detectQuickPastePlatform(text) {
  if (/yemek\s*sepeti|yemeksepeti|\bys\b/i.test(text)) return "Yemeksepeti";
  if (/getir/i.test(text)) return "GetirYemek";
  if (/trendyol/i.test(text)) return "Trendyol Yemek";
  if (/migros/i.test(text)) return "Migros Yemek";
  return "Hizli Platform";
}

function parseQuickPasteOrderSmart(rawText) {
  const text = normalizedPasteText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const phoneMatch = text.match(/(?:\+?90\s*)?(05\d[\d\s-]{8,})/);
  const phone = phoneMatch ? phoneMatch[1].replace(/[^\d]/g, "").replace(/^90(?=5)/, "") : "";
  const platform = detectQuickPastePlatform(text);
  const customerName = quickPasteValue(text, ["Musteri", "Musteri Adi", "Ad Soyad", "Adi Soyadi", "Alici"]);
  const labeledPayment = quickPasteValue(text, ["Odeme", "Odeme Tipi", "Payment", "Payment Method"]);
  const paymentMethod = labeledPayment || (/nakit kapida|kapida nakit|nakit/i.test(text)
    ? "Nakit"
    : /online|kart|kredi karti|pos/i.test(text)
      ? "Online Odeme"
      : "");
  const customerNote = quickPasteValue(text, ["Not", "Aciklama", "Adres Tarifi", "Kurye Notu", "Musteri Notu"]);
  const amountMatch = text.match(/(?:toplam\s*tutar|toplam|tutar|odeme)\s*[:\-]?\s*(?:tl|try|₺)?\s*([\d\.,]+)/i) ||
    text.match(/([\d\.,]+)\s*(?:tl|try|₺)/i);
  const normalizedAmount = amountMatch?.[1]
    ? Number(String(amountMatch[1]).replace(/\./g, "").replace(",", "."))
    : null;
  const orderNo = quickPasteValue(text, ["Siparis No", "Siparis ID", "Order No", "Order ID"]) ||
    (text.match(/#\s*([A-Z0-9][A-Z0-9\-]{4,})/i)?.[1] || "");
  const labeledAddress = quickPasteBlock(text, ["Teslimat Adresi", "Adres", "Musteri Adresi"]);
  const longAddressLine = lines
    .filter((line) => line.length >= 18 && !/^(telefon|tel|odeme|musteri|not|aciklama|toplam|tutar|urun|siparis)\b/i.test(quickPasteKey(line)))
    .sort((left, right) => right.length - left.length)[0] || "";

  return {
    customerName,
    phone,
    customerAddress: labeledAddress || longAddressLine,
    paymentMethod,
    customerNote,
    packageType: `${platform} Siparisi${orderNo ? ` - ${orderNo}` : ""}`,
    platform,
    orderNo,
    orderAmount: Number.isFinite(normalizedAmount) && normalizedAmount > 0 ? normalizedAmount : "",
  };
}

function quickPastePaymentMethodCode(value) {
  const text = quickPasteKey(value);
  if (!text) return "";
  if (text.includes("online") || text.includes("odendi") || text.includes("paid")) return "paid_online";
  if (text.includes("kart") || text.includes("pos") || text.includes("kredi")) return "card_on_delivery";
  if (text.includes("nakit") || text.includes("cash")) return "cash_on_delivery";
  return "";
}

function parseQuickPasteOrder(rawText) {
  return parseQuickPasteOrderSmart(rawText);
  const text = normalizedPasteText(rawText);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const phoneMatch = text.match(/(?:\+?90\s*)?(05\d[\d\s-]{8,})/);
  const phone = phoneMatch
    ? phoneMatch[1].replace(/[^\d]/g, "").replace(/^90(?=5)/, "")
    : "";

  const customerName = findLabeledValue(text, ["Musteri", "MÃ¼ÅŸteri", "Ad Soyad", "AdÄ± SoyadÄ±", "Alici", "AlÄ±cÄ±"]);
  const paymentMethod = (() => {
    const labeled = findLabeledValue(text, ["Odeme", "Ã–deme", "Odeme Tipi", "Ã–deme Tipi"]);
    if (labeled) {
      return labeled;
    }
    if (/nakit kapida|kapida nakit|nakit/i.test(text)) {
      return "Nakit";
    }
    if (/online|kart|kredi karti|kredi kartÄ±|pos/i.test(text)) {
      return "Online Odeme";
    }
    return "";
  })();
  const customerNote = findLabeledValue(text, ["Not", "Aciklama", "AÃ§Ä±klama", "Kurye Notu", "Musteri Notu", "MÃ¼ÅŸteri Notu"]);
  const amountMatch = text.match(/(?:toplam|tutar|odeme|Ã¶deme)\s*[:\-]?\s*[â‚ºâ‚¸]?\s*([\d\.,]+)/i) || text.match(/[â‚ºâ‚¸]\s*([\d\.,]+)/);
  const normalizedAmount = amountMatch?.[1]
    ? Number(String(amountMatch[1]).replace(/\./g, "").replace(",", "."))
    : null;
  const packageType = findLabeledValue(text, ["Paket Tipi", "Urun", "ÃœrÃ¼n", "Siparis", "SipariÅŸ"]) || "Hizli Platform Siparisi";

  const labeledAddress = findLabeledValue(text, ["Adres", "Teslimat Adresi", "Musteri Adresi", "MÃ¼ÅŸteri Adresi"]);
  const longAddressLine = lines
    .filter((line) => line.length >= 18 && !/^(telefon|odeme|Ã¶deme|musteri|mÃ¼ÅŸteri|not|aciklama|aÃ§Ä±klama|toplam|tutar)\b/i.test(line))
    .sort((left, right) => right.length - left.length)[0] || "";
  const customerAddress = labeledAddress || longAddressLine;

  return {
    customerName,
    phone,
    customerAddress,
    paymentMethod,
    customerNote,
    packageType,
    orderAmount: Number.isFinite(normalizedAmount) && normalizedAmount > 0 ? normalizedAmount : "",
  };
}


function getCurrentRestaurant(data) {
  return data.restaurants.find((item) => item.id === restaurantState.selectedRestaurantId) || data.restaurants[0] || null;
}

function getCurrentPlatformAccount(data) {
  return data.platformAccounts?.[0] || null;
}

function currentWebhookUrl() {
  return `${window.location.origin}/api/webhooks/orders`;
}

function getLastWebhookLog(data, account) {
  const logs = Array.isArray(data?.webhookLogs) ? data.webhookLogs : [];
  if (!account) {
    return logs[0] || null;
  }
  return logs.find((log) => log.sourcePlatform === account.platform) || logs[0] || null;
}

function activeOrderPackages(packages) {
  return packages.filter((pkg) => !["delivered", "failed", "rejected", "cancelled"].includes(pkg.status));
}

function packageSourceLabel(pkg) {
  if (pkg.source === "platform_manual") {
    return "Hizli Yapistir";
  }
  if (pkg.source === "external_manual" || pkg.source === "manual") {
    return "Manuel Paket";
  }
  return pkg.sourcePlatform;
}

function packageDisplayCode(pkg) {
  return pkg.trackingNo || pkg.externalOrderNo || pkg.platformOrderId || pkg.id || "-";
}

function packageClosedAt(pkg) {
  return pkg.deliveredAt || pkg.completedAt || pkg.closedAt || pkg.cancelledAt || pkg.failedAt || pkg.updatedAt || "";
}

function courierMap(data) {
  return new Map((data.couriers || []).map((courier) => [courier.id, courier]));
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

function setIntegrationInfo(data, explicitIntegration = null) {
  const restaurant = getCurrentRestaurant(data);

  if (!restaurant) {
    safeSetText(restaurantRefs.integrationRestaurant, "Henuz restoran oturumu acik degil.");
    safeSetText(restaurantRefs.integrationApiKey, "API key panelde gosterilmez");
    safeSetText(restaurantRefs.integrationPortalUsername, "Portal kullanici burada gorunur");
    safeSetText(restaurantRefs.integrationWebhookSecret, "Secret panelde gosterilmez");
    safeSetText(restaurantRefs.integrationEndpoint, "Restoran girisi yapildiginda endpoint gorunur");
    safeSetText(restaurantRefs.platformWebhookUrl, "Platform hesabini kaydedince webhook URL gorunur");
    safeSetText(restaurantRefs.platformSetupName, "Henuz kayitli platform yok.");
    safeSetText(restaurantRefs.platformSetupAuth, "Secret kaydedilmedi");
    safeSetText(restaurantRefs.platformSetupStore, "Store/vendor bilgisi burada gorunur");
    safeSetText(restaurantRefs.platformSetupHint, "Polling API kapalı — webhook ile sipariş bekleniyor");
    safeSetText(restaurantRefs.samplePayload, "Restoran girisi yapildiginda webhook govdesi bilgisi gorunecek.");
    return;
  }

  restaurantState.selectedRestaurantId = restaurant.id;

  const integration = explicitIntegration || {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    portalUsername: restaurant.username,
    apiKey: restaurant.apiKey ? "Kayitli" : "Eksik",
    webhookSecret: restaurant.webhookSecret ? "Kayitli" : "Eksik",
    endpoint: currentWebhookUrl(),
    samplePayload: {
      platform: normalizePlatformSlug(restaurant.platforms[0] || "Trendyol Yemek"),
      platformRestaurantId: restaurant.id,
      orderId: "PLATFORM-ORDER-ID",
      customerName: "Musteri Adi",
      phone: "05555555555",
      address: "Mersin teslimat adresi",
      totalPrice: 250,
      items: [{ id: "item-1", name: "Urun", quantity: 1, price: 250 }],
      paymentMethod: "Online Odeme",
      customerNote: "Kapidan ara",
    },
  };

  safeSetText(restaurantRefs.integrationRestaurant, `${integration.restaurantName} - ${restaurant.zone}`);
  safeSetText(restaurantRefs.integrationApiKey, integration.apiKey ? "Kayitli, panelde gosterilmez" : "Eksik");
  safeSetText(restaurantRefs.integrationPortalUsername, integration.portalUsername || restaurant.username || "-");
  safeSetText(restaurantRefs.integrationWebhookSecret, integration.webhookSecret ? "Kayitli, panelde gosterilmez" : "Eksik");
  safeSetText(restaurantRefs.integrationEndpoint, integration.endpoint);
  safeSetText(restaurantRefs.samplePayload, JSON.stringify(integration.samplePayload, null, 2));
  if (restaurantRefs.packageRestaurantId) {
    restaurantRefs.packageRestaurantId.value = restaurant.id;
  }
}

function setPlatformSetup(data) {
  const account = getCurrentPlatformAccount(data);

  if (!account) {
    safeSetText(restaurantRefs.platformWebhookUrl, currentWebhookUrl());
    safeSetText(restaurantRefs.platformSetupName, "Henuz kayitli platform yok.");
    safeSetText(restaurantRefs.platformSetupAuth, "Secret kaydedilmedi");
    safeSetText(restaurantRefs.platformSetupStore, "Platform restoran bilgisi burada gorunur");
    safeSetText(restaurantRefs.platformSetupHint, "Polling API kapalı — webhook ile sipariş bekleniyor");
    return;
  }

  const lastWebhook = getLastWebhookLog(data, account);
  const accountConfig = platformClientConfig(account.platform);
  const modeText = accountConfig.mode === "hybrid"
    ? "Webhook/Polling otomatik"
    : (accountConfig.mode === "polling" ? "Polling otomatik" : "Webhook otomatik");
  safeSetText(restaurantRefs.platformWebhookUrl, currentWebhookUrl());
  safeSetText(restaurantRefs.platformSetupName, `${account.platform} - ${modeText}`);
  safeSetText(restaurantRefs.platformSetupStore, account.externalStoreId ? `ID kayitli: ${account.externalStoreId}` : "ID eksik");
  safeSetText(restaurantRefs.platformSetupAuth, account.hasWebhookSecret || account.webhookSecret ? "Secret kayitli" : "Secret eksik");
  safeSetText(
    restaurantRefs.platformSetupHint,
    [
      `${modeText} mod seçildi.`,
      account.lastWebhookAt ? `Son webhook: ${formatDate(account.lastWebhookAt)}` : (lastWebhook ? `Son webhook: ${formatDate(lastWebhook.createdAt)}` : "Son webhook: henuz yok"),
      account.lastPollAt ? `Son polling: ${formatDate(account.lastPollAt)}` : "Son polling: henuz yok",
      account.lastWebhookAt ? "Son doğrulama: gerçek webhook alındı" : "Son doğrulama: ilk gerçek sipariş bekleniyor",
      account.lastError ? `Son hata: ${platformFriendlyMessage(account.lastError, account)}` : "Son hata: yok",
    ].join(" ")
  );
}

function renderRestaurantList(restaurants) {
  const signature = listRenderSignature(restaurants, ["id", "name", "zone", "latitude", "longitude"]);
  if (restaurantRefs.restaurantList.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.restaurantList.__deliveraRenderSignature = signature;
  restaurantRefs.restaurantList.innerHTML = "";

  if (restaurants.length === 0) {
    restaurantRefs.restaurantList.innerHTML = '<div class="empty-state">Bu oturum icin restoran bulunamadi.</div>';
    return;
  }

  const restaurant = restaurants[0];
  const card = document.createElement("article");
  card.className = "stack-card";
  card.innerHTML = `
    <div class="stack-top">
      <div>
        <strong>${escapeHtml(restaurant.name)}</strong>
        <p>${escapeHtml(restaurant.zone)} bolgesi - GPS ${escapeHtml(restaurant.latitude)}, ${escapeHtml(restaurant.longitude)}</p>
        <div class="badge-row">${createPlatformBadges(restaurant.platforms)}</div>
      </div>
      <span class="soft-badge">Tenant Izole</span>
    </div>
  `;

  restaurantRefs.restaurantList.appendChild(card);
}

function renderPlatformAccounts(accounts) {
  const signature = listRenderSignature(accounts || [], ["id", "platform", "externalStoreId", "active", "lastWebhookAt", "lastPollAt", "lastVerificationAt", "verifiedAt", "lastError", "connectionStatus", "lastCheckAt", "lastSuccessAt", "lastErrorAt", "lastErrorCode", "lastErrorMessage", "lastHttpStatus", "lastLatencyMs", "consecutiveFailures", "hasApiKey", "hasApiSecret", "hasWebhookSecret", "pollingEnabled", "webhookEnabled"]);
  if (restaurantRefs.platformAccountList.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.platformAccountList.__deliveraRenderSignature = signature;
  restaurantRefs.platformAccountList.innerHTML = "";

  if (!accounts || accounts.length === 0) {
    restaurantRefs.platformAccountList.innerHTML = '<div class="empty-state">Bu restorana bagli platform hesabi yok.</div>';
    return;
  }

  accounts.forEach((account) => {
    const card = document.createElement("article");
    card.className = "stack-card platform-account-card";
    const lastWebhook = getLastWebhookLog(restaurantState.data, account);
    const accountConfig = platformClientConfig(account.platform);
    const pollingCredentialsReady = Boolean(account.hasApiKey && account.hasApiSecret);
    const pollingReady = Boolean(accountConfig.mode !== "webhook" && account.pollingEnabled && pollingCredentialsReady);
    const isGetir = isGetirPlatform(account.platform);
    const hasWebhookSecret = Boolean(account.hasWebhookSecret || account.webhookSecret);
    const hasTemporaryId = isTemporaryPlatformId(account.externalStoreId);
    const friendlyLastError = platformFriendlyMessage(account.lastError, account);
    const benignLastError = isBenignPlatformMessage(account.lastError, account);
    const readyForWebhook = Boolean(accountConfig.mode !== "polling" && account.webhookEnabled && hasWebhookSecret && account.externalStoreId);
    const connectionStatus = connectionStatusForAccount(account, pollingReady, readyForWebhook);
    const health = account.connectionHealth || {};
    const healthMessage = health.publicMessage || friendlyLastError || "Bağlantı henuz dogrulanmadi. Son durumu kontrol edin.";
    const modeText = account.mode === "hybrid" || accountConfig.mode === "hybrid"
      ? "Otomatik hybrid"
      : (accountConfig.mode === "polling" ? "Polling otomatik" : "Webhook otomatik");
    const credentialText = pollingReady || readyForWebhook ? "Bilgiler kayıtlı" : "Bağlantı bilgisi bekliyor";
    const lastWebhookText = account.lastWebhookAt ? formatDate(account.lastWebhookAt) : (lastWebhook ? formatDate(lastWebhook.createdAt) : "Henüz yok");
    const lastPollText = account.lastPollAt ? formatDate(account.lastPollAt) : "Henüz yok";
    const lastVerificationTime = account.lastVerificationAt || account.verifiedAt || account.lastPollAt || account.lastWebhookAt || "";
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <div class="platform-card-title">
            <span class="platform-logo-dot">${escapeHtml(String(account.platform || "?").slice(0, 1))}</span>
            <div>
              <strong>${escapeHtml(account.platform)}</strong>
              <p>${escapeHtml(modeText)} çalışma modu</p>
            </div>
          </div>
          <div class="platform-chip-row">
            ${platformStatusChip(modeText, "success", "↯")}
            ${platformStatusChip(credentialText, (pollingReady || readyForWebhook) ? "success" : "warning", "●")}
            ${platformStatusChip(account.externalStoreId ? "Restoran ID kayıtlı" : "Restoran ID eksik", account.externalStoreId ? "success" : "warning", "#")}
          </div>
          <div class="platform-meta-grid">
            <span>Platform Restaurant ID<strong>${account.externalStoreId ? escapeHtml(account.externalStoreId) : "Eksik"}</strong></span>
            <span>Çalışma modu<strong>${escapeHtml(modeText)}</strong></span>
            <span>Son doğrulama<strong>${lastVerificationTime ? escapeHtml(formatDate(lastVerificationTime)) : "İlk gerçek sipariş bekleniyor"}</strong></span>
            <span>Son webhook<strong>${lastWebhookText}</strong></span>
          </div>
          ${hasTemporaryId ? platformHintCard(`${account.externalStoreId} geçici ID gibi görünüyor. Platformdaki gerçek restoran/store ID ile değiştirin.`, "warning") : ""}
          ${platformHintCard(healthMessage, connectionStatus.tone === "error" ? "error" : connectionStatus.tone === "warning" ? "warning" : "success")}
        </div>
        <span class="platform-live-badge platform-live-${connectionStatus.tone}">${connectionStatus.text}</span>
      </div>
      <div class="card-actions">
        <button class="ghost-btn" type="button" data-platform-check="${account.id}">Bağlantıyı Kontrol Et</button>
        <button class="ghost-btn" type="button" data-platform-refresh="${account.id}">Son Durumu Yenile</button>
      </div>
    `;
    restaurantRefs.platformAccountList.appendChild(card);
  });
}

function renderRestaurantPerformance(performance) {
  if (!restaurantRefs.performanceBoard) {
    return;
  }

  const data = performance || {
    todayOrderCount: 0,
    deliveredTodayCount: 0,
    averageAssignmentMinutes: 0,
    averageDeliveryMinutes: 0,
    failedDeliveryRate: 0,
  };
  const signature = listRenderSignature([data], ["todayOrderCount", "deliveredTodayCount", "averageAssignmentMinutes", "averageDeliveryMinutes", "failedDeliveryRate"]);
  if (restaurantRefs.performanceBoard.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.performanceBoard.__deliveraRenderSignature = signature;

  restaurantRefs.performanceBoard.innerHTML = `
    <article class="mini-stat-card">
      <span>Bugun Siparis</span>
      <strong>${data.todayOrderCount}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Teslim Edilen</span>
      <strong>${data.deliveredTodayCount}</strong>
    </article>
    <article class="mini-stat-card">
      <span>Ort. Atama</span>
      <strong>${data.averageAssignmentMinutes} dk</strong>
    </article>
    <article class="mini-stat-card">
      <span>Ort. Teslim</span>
      <strong>${data.averageDeliveryMinutes} dk</strong>
    </article>
    <article class="mini-stat-card">
      <span>Basarisiz Oran</span>
      <strong>%${data.failedDeliveryRate}</strong>
    </article>
  `;
}

function renderIntegrationWizard(wizard) {
  if (!restaurantRefs.integrationWizardSteps) {
    return;
  }

  const safeWizard = wizard || {
    webhookUrl: currentWebhookUrl(),
    verificationStatus: "pending",
    helpText: "Webhook modu icin once platformRestaurantId ve secret kaydet.",
    steps: [],
  };
  const signature = [
    safeWizard.webhookUrl,
    safeWizard.verificationStatus,
    safeWizard.helpText,
    listRenderSignature(safeWizard.steps || [], ["title", "label", "done"]),
  ].join("||");
  if (restaurantRefs.integrationWizardSteps.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.integrationWizardSteps.__deliveraRenderSignature = signature;

  restaurantRefs.integrationWizardSteps.innerHTML = safeWizard.steps.map((step) => `
    <article class="stack-card wizard-step-card ${step.done ? "wizard-step-done" : ""}">
      <div class="stack-top">
        <div>
          <strong>${step.title} - ${step.label}</strong>
          <p>${step.done ? "Hazir" : "Siradaki adim bekliyor"}</p>
        </div>
        <span class="soft-badge">${step.done ? "Tamam" : "Bekliyor"}</span>
      </div>
    </article>
  `).join("") || '<div class="empty-state">Entegrasyon sihirbazi icin once restoran oturumu ac.</div>';

  restaurantRefs.integrationWizardWebhook.textContent = safeWizard.webhookUrl;
  restaurantRefs.integrationWizardStatus.textContent = `${safeWizard.helpText} Durum: Webhook modu aktif.`;
}

function renderRecentOrders(packages) {
  const list = activeOrderPackages(packages)
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, 8);
  const signature = listRenderSignature(list, ["id", "trackingNo", "externalOrderNo", "status", "assignedCourierId", "assignedCourierName", "paymentStatus", "updatedAt"]);
  if (restaurantRefs.recentOrders.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.recentOrders.__deliveraRenderSignature = signature;
  restaurantRefs.recentOrders.innerHTML = "";

  if (list.length === 0) {
    restaurantRefs.recentOrders.innerHTML = '<div class="empty-state">Aktif sipariş yok. Yeni paket geldiğinde bu alan canlı olarak güncellenir.</div>';
    return;
  }

  list.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = `stack-card order-summary-card restaurant-order-card ${!pkg.assignedCourierId ? "priority-alert-card" : ""}`;
    card.innerHTML = `
      <div class="order-card-top">
        <div class="order-card-title">
          <strong class="entity-line">${SVG_PACKAGE} ${escapeHtml(packageDisplayCode(pkg))}</strong>
          <p class="entity-line">${escapeHtml(pkg.packageType || "Standart Paket")} - ${escapeHtml(pkg.recipient || "Musteri")}</p>
          <p>Kaynak: ${escapeHtml(packageSourceLabel(pkg) || "-")} - ${escapeHtml(pkg.restaurantName || "-")}</p>
        </div>
        <div class="order-card-badges">
          <span class="status-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
        </div>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Adres</span>
          <strong class="entity-line">${SVG_PIN} ${escapeHtml(pkg.deliveryAddress || pkg.address || "-")}</strong>
        </div>
        <div>
          <span>Kurye</span>
          <strong class="entity-line">${SVG_COURIER} ${escapeHtml(pkg.assignedCourierName || "Kurye bekleniyor")}</strong>
        </div>
        <div>
          <span>Odeme</span>
          <strong>${escapeHtml(pkg.paymentMethod || "-")} - ${escapeHtml(paymentStatusLabel(pkg.paymentStatus))} - ${escapeHtml(formatCurrency(pkg.orderAmount))}</strong>
        </div>
        <div>
          <span>Zaman</span>
          <strong>${formatDate(pkg.createdAt)}</strong>
        </div>
      </div>
      <div class="order-card-footer">
        <button class="ghost-btn details-btn" type="button" aria-label="${escapeHtml(pkg.trackingNo || "Siparis")} detayini goruntule" style="padding: 6px 16px; font-size: 0.85rem; border-radius: 8px;">Detayı Görüntüle</button>
      </div>
    `;
    card.querySelector('.details-btn')?.addEventListener('click', () => {
      window.showPackageDetailsModal?.(pkg);
    });
    const quickPrintButton = document.createElement("button");
    quickPrintButton.type = "button";
    quickPrintButton.className = "primary-btn compact-action-btn";
    quickPrintButton.textContent = "58 mm Fiş Yazdır";
    quickPrintButton.setAttribute("aria-label", `${packageDisplayCode(pkg)} 58 mm fiş yazdır`);
    quickPrintButton.addEventListener("click", () => {
      openPackagePrintWindow(pkg, restaurantState.data?.restaurants?.[0]?.name || "RESTOMAP");
    });
    card.querySelector(".order-card-footer")?.appendChild(quickPrintButton);
    restaurantRefs.recentOrders.appendChild(card);
  });
}

function renderActiveOrders(data) {
  const packageList = activeOrderPackages(data.packages || [])
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const courierById = courierMap(data);
  const restaurantName = data.restaurants?.[0]?.name || "RESTOMAP";
  const signature = [
    restaurantName,
    listRenderSignature(packageList, ["id", "trackingNo", "externalOrderNo", "status", "assignedCourierId", "assignedCourierName", "paymentStatus", "lastAssignmentError", "updatedAt"]),
    listRenderSignature(data.couriers || [], ["id", "status", "lastLocationAt"]),
  ].join("||");
  if (restaurantRefs.activeOrders.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.activeOrders.__deliveraRenderSignature = signature;
  restaurantRefs.activeOrders.innerHTML = "";

  if (packageList.length === 0) {
    restaurantRefs.activeOrders.innerHTML = '<div class="empty-state">Aktif sipariş yok. Manuel veya platform paketi geldiğinde burada canlı olarak görünecek.</div>';
    return;
  }

  packageList.forEach((pkg) => {
    const courier = pkg.assignedCourierId ? courierById.get(pkg.assignedCourierId) : null;
    const sourceLabel = packageSourceLabel(pkg);
    const assignmentBadge = pkg.status === "pending_approval"
      ? "Restoran Onayi Bekliyor"
      : pkg.assignedCourierId
        ? "Kurye Atandi"
        : pkg.status === "preparing"
          ? "Kurye Araniyor"
          : "Atama Bekliyor";
    const assignmentTone = pkg.assignedCourierId ? "soft-badge" : "soft-badge status-awaiting-assignment";
    const prepCode = `DLV-${String(pkg.id || "").slice(-4).toUpperCase()}`;

    const card = document.createElement("article");
    card.className = `stack-card order-summary-card restaurant-order-card modern-card ${pkg.status === "preparing" ? "anim-pulse-preparing" : ""}`;
    card.innerHTML = `
      <div class="order-card-top">
        <div class="order-card-title">
          <strong class="entity-line">${SVG_PACKAGE} ${escapeHtml(packageDisplayCode(pkg))}</strong>
          <p>Kaynak: ${escapeHtml(sourceLabel || "-")} - Musteri: ${escapeHtml(pkg.recipient || "-")}</p>
          <p>Olusturulma: ${formatDate(pkg.createdAt)}</p>
        </div>
        <div class="order-card-badges">
          <span class="${assignmentTone}">${assignmentBadge}</span>
          <span class="status-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
          <span class="soft-badge">${paymentStatusLabel(pkg.paymentStatus)}</span>
        </div>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Paket ID</span>
          <strong>${escapeHtml(pkg.id)}</strong>
        </div>
        <div>
          <span>Hazirlik Kodu</span>
          <strong>${escapeHtml(prepCode)}</strong>
        </div>
        <div>
          <span>Adres</span>
          <strong class="entity-line">${SVG_PIN} ${escapeHtml(pkg.deliveryAddress || pkg.address || "-")}</strong>
        </div>
        <div>
          <span>Not</span>
          <strong>${escapeHtml(pkg.customerNote || pkg.note || "-")}</strong>
        </div>
        <div>
          <span>Odeme</span>
          <strong>${escapeHtml(pkg.paymentMethod || "-")} - ${escapeHtml(paymentStatusLabel(pkg.paymentStatus))} - ${escapeHtml(formatCurrency(pkg.orderAmount))}</strong>
        </div>
        <div>
          <span>Kurye</span>
          <strong class="entity-line">${SVG_MOTO} ${escapeHtml(pkg.assignedCourierName || "Henüz atanmadı")}</strong>
        </div>
        <div>
          <span>Kurye Durumu</span>
          <strong class="entity-line">${SVG_COURIER} ${courier ? courierStatusLabel(courier.status) : "-"}</strong>
        </div>
        <div>
          <span>Kurye Telefon</span>
          <strong>-</strong>
        </div>
        <div>
          <span>Atama Zamani</span>
          <strong>${pkg.assignedAt ? formatDate(pkg.assignedAt) : "-"}</strong>
        </div>
        <div>
          <span>Hazirlik Sayaci</span>
          <strong>${escapeHtml(pkg.eta || "5 dk")}</strong>
        </div>
      </div>
      ${Array.isArray(pkg.items) && pkg.items.length ? `<p>Urunler: ${pkg.items.map((item) => `${escapeHtml(item.quantity || 1)}x ${escapeHtml(item.name || "-")}`).join(", ")}</p>` : ""}
      ${pkg.lastAssignmentError ? `<p>Son Atama Notu: ${escapeHtml(pkg.lastAssignmentError)}</p>` : ""}
    `;

    const detailFooter = document.createElement("div");
    detailFooter.className = "order-card-footer";
    const detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.className = "ghost-btn details-btn compact-action-btn";
    detailButton.textContent = "Detayi Goruntule";
    detailButton.setAttribute("aria-label", `${packageDisplayCode(pkg)} detayini goruntule`);
    detailButton.addEventListener("click", () => {
      window.showPackageDetailsModal?.(pkg);
    });
    detailFooter.appendChild(detailButton);
    card.appendChild(detailFooter);

    const actions = document.createElement("div");
    actions.className = "card-actions order-card-actions";

    if (pkg.status === "pending_approval") {
        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.className = "ghost-btn";
        confirmButton.textContent = "Siparisi Onayla";
        confirmButton.addEventListener("click", async () => {
          try {
            const next = await api(`/api/restaurant/packages/${pkg.id}/action`, {
              method: "POST",
              headers: restaurantAuthHeaders(),
              retryWithRefresh: refreshRestaurantAccess,
              body: JSON.stringify({ action: "confirm" }),
            });
            hydrateRestaurant(next);
            showToast("Siparis onaylandi.");
          } catch (error) {
            showToast(error.message || "Siparis onaylanamadi.", "error");
          }
        });
        actions.appendChild(confirmButton);

        const rejectButton = document.createElement("button");
        rejectButton.type = "button";
        rejectButton.className = "ghost-btn";
        rejectButton.textContent = "Siparisi Reddet";
        rejectButton.addEventListener("click", async () => {
          const reason = window.prompt("Red nedeni", "Restoran kapasitesi uygun degil") || "Restoran reddetti.";
          try {
            const next = await api(`/api/restaurant/packages/${pkg.id}/action`, {
              method: "POST",
              headers: restaurantAuthHeaders(),
              retryWithRefresh: refreshRestaurantAccess,
              body: JSON.stringify({ action: "reject", reason }),
            });
            hydrateRestaurant(next);
            showToast("Siparis reddedildi.");
          } catch (error) {
            showToast(error.message || "Siparis reddedilemedi.", "error");
          }
        });
        actions.appendChild(rejectButton);
      }

    const printButton = document.createElement("button");
    printButton.type = "button";
    printButton.className = "primary-btn";
    printButton.textContent = "58 mm Fiş Yazdır";
    printButton.setAttribute("aria-label", `${packageDisplayCode(pkg)} 58 mm fiş yazdır`);
    printButton.addEventListener("click", () => openPackagePrintWindow(pkg, restaurantName));
    actions.appendChild(printButton);

    card.appendChild(actions);
    restaurantRefs.activeOrders.appendChild(card);
  });
}

function renderOrderHistory(packages) {
  const filteredHistory = [...packages]
    .filter((pkg) => ["delivered", "failed", "rejected", "cancelled"].includes(pkg.status))
    .filter((pkg) => packageMatchesHistoryRange(pkg, restaurantState.historyRange))
    .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt))
  const list = filteredHistory.slice(0, restaurantState.historyVisibleCount);
  const signature = [
    restaurantState.historyRange,
    restaurantState.historyVisibleCount,
    filteredHistory.length,
    listRenderSignature(list, ["id", "trackingNo", "externalOrderNo", "status", "recipient", "deliveryAddress", "address", "assignedCourierName", "paymentMethod", "paymentStatus", "orderAmount", "createdAt", "updatedAt", "deliveredAt", "completedAt", "closedAt", "cancelledAt", "failedAt"]),
  ].join("||");
  if (restaurantRefs.orderHistory.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.orderHistory.__deliveraRenderSignature = signature;
  restaurantRefs.orderHistory.innerHTML = "";

  restaurantRefs.historyMeta.textContent = `${filteredHistory.length} kapanan siparis icinden ${list.length} kayit gorunuyor.`;
  restaurantRefs.historyMore.classList.toggle("hidden", list.length >= filteredHistory.length);
  [...restaurantRefs.historyFilters.querySelectorAll("[data-range]")].forEach((button) => {
    button.classList.toggle("active", button.dataset.range === restaurantState.historyRange);
  });

  if (list.length === 0) {
    restaurantRefs.orderHistory.innerHTML = '<div class="empty-state">Dun veya onceki gunlerden kapanan siparis kaydi henuz yok.</div>';
    return;
  }

  list.forEach((pkg) => {
    const closedAt = packageClosedAt(pkg);
    const card = document.createElement("article");
    card.className = "stack-card order-summary-card restaurant-order-card restaurant-history-card modern-card";
    card.innerHTML = `
      <div class="order-card-top">
        <div class="order-card-title">
          <strong class="entity-line">${SVG_PACKAGE} ${escapeHtml(packageDisplayCode(pkg))}</strong>
          <p class="entity-line">${escapeHtml(pkg.recipient || "Musteri")} - ${escapeHtml(pkg.packageType || "Standart Paket")}</p>
          <p>Kaynak: ${escapeHtml(packageSourceLabel(pkg) || "-")}</p>
        </div>
        <div class="order-card-badges">
          <span class="status-badge ${statusClassName(pkg.status)}">${statusLabel(pkg.status)}</span>
        </div>
      </div>
      <div class="meta-grid compact-meta-grid">
        <div>
          <span>Paket kodu</span>
          <strong>${escapeHtml(packageDisplayCode(pkg))}</strong>
        </div>
        <div>
          <span>Musteri</span>
          <strong>${escapeHtml(pkg.recipient || "-")}</strong>
        </div>
        <div class="order-meta-wide">
          <span>Adres</span>
          <strong class="entity-line">${SVG_PIN} ${escapeHtml(pkg.deliveryAddress || pkg.address || "-")}</strong>
        </div>
        <div>
          <span>Kurye</span>
          <strong class="entity-line">${SVG_MOTO} ${escapeHtml(pkg.assignedCourierName || "Atama yok")}</strong>
        </div>
        <div>
          <span>Odeme</span>
          <strong>${escapeHtml(pkg.paymentMethod || "-")} - ${escapeHtml(paymentStatusLabel(pkg.paymentStatus))} - ${escapeHtml(formatCurrency(pkg.orderAmount))}</strong>
        </div>
        <div>
          <span>Olusturulma</span>
          <strong>${formatDate(pkg.createdAt)}</strong>
        </div>
        <div>
          <span>Kapanma</span>
          <strong>${closedAt ? formatDate(closedAt) : "-"}</strong>
        </div>
      </div>
      <div class="order-card-footer">
        <button class="ghost-btn details-btn" type="button" aria-label="${escapeHtml(pkg.trackingNo || "Siparis")} detayini goruntule" style="padding: 6px 16px; font-size: 0.85rem; border-radius: 8px;">Detayı Görüntüle</button>
      </div>
    `;
    card.querySelector('.details-btn')?.addEventListener('click', () => {
      window.showPackageDetailsModal?.(pkg);
    });
    const reprintButton = document.createElement("button");
    reprintButton.type = "button";
    reprintButton.className = "primary-btn compact-action-btn";
    reprintButton.textContent = "Fişi Tekrar Yazdır";
    reprintButton.setAttribute("aria-label", `${packageDisplayCode(pkg)} fişi tekrar yazdır`);
    reprintButton.addEventListener("click", () => {
      openPackagePrintWindow(pkg, restaurantState.data?.restaurants?.[0]?.name || "RESTOMAP");
    });
    card.querySelector(".order-card-footer")?.appendChild(reprintButton);
    restaurantRefs.orderHistory.appendChild(card);
  });
}

function renderRestaurantNotifications(notifications) {
  renderNotificationCenter(restaurantRefs.notificationCenter, notifications || [], "Restoran icin bildirim yok.");
}

function normalizeRestaurantPhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function fillPackageFormFromCustomer(customer) {
  const elements = restaurantRefs.packageForm?.elements;
  if (!elements || !customer) return;
  if (restaurantRefs.restaurantCustomerId) restaurantRefs.restaurantCustomerId.value = customer.id || "";
  if (restaurantRefs.customerPhoneSearch) restaurantRefs.customerPhoneSearch.value = customer.phone || "";
  if (elements["customerName"]) elements["customerName"].value = customer.name || "";
  if (elements["phone"]) elements["phone"].value = customer.phone || "";
  if (elements["deliveryAddress"]) elements["deliveryAddress"].value = customer.address || "";
  if (elements["customerNote"]) elements["customerNote"].value = customer.note || elements["customerNote"].value || "";
  if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = `${customer.name || "Musteri"} secildi; paket formu dolduruldu.`;
}

function renderSelectedCustomerHistory(customer) {
  if (!restaurantRefs.customerHistory) return;
  restaurantRefs.customerHistory.innerHTML = "";
  if (!customer?.id) {
    restaurantRefs.customerHistory.classList.add("hidden");
    return;
  }
  const customerPhone = normalizeRestaurantPhone(customer.phone);
  const orders = (restaurantState.data?.packages || [])
    .filter((item) => {
      const itemCustomerId = item.restaurantCustomerId || item.customerId || item.customer?.id;
      if (itemCustomerId && itemCustomerId === customer.id) return true;
      return customerPhone && normalizeRestaurantPhone(item.phone || item.customerPhone) === customerPhone;
    })
    .sort((a, b) => new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0))
    .slice(0, 5);

  restaurantRefs.customerHistory.classList.remove("hidden");
  if (!orders.length) {
    restaurantRefs.customerHistory.innerHTML = '<div class="empty-state">Secilen musterinin siparis gecmisi henuz yok.</div>';
    return;
  }

  restaurantRefs.customerHistory.innerHTML = `
    <div class="stack-card">
      <div class="stack-top">
        <div>
          <strong>${restaurantHtmlSafe(customer.name || "Secilen musteri")}</strong>
          <p>Siparis gecmisi</p>
        </div>
        <span class="soft-badge">${orders.length} kayit</span>
      </div>
      ${orders.map((order) => `
        <p class="soft-copy">
          ${restaurantHtmlSafe(order.trackingNumber || order.id || "-")} -
          ${restaurantHtmlSafe(order.status || "-")} -
          ${formatCurrency(order.orderAmount || order.amount || order.totalPrice || 0)}
        </p>
      `).join("")}
    </div>
  `;
}

function showCustomerForm(customer = null) {
  if (!restaurantRefs.customerForm) return;
  openReadyRecords();
  const form = restaurantRefs.customerForm;
  const elements = form.elements;
  const packageElements = restaurantRefs.packageForm?.elements;
  const phoneSeed = restaurantRefs.customerPhoneSearch?.value || restaurantRefs.customerListSearch?.value || packageElements?.["phone"]?.value || "";
  form.classList.remove("hidden");
  elements["id"].value = customer?.id || "";
  elements["name"].value = customer?.name || packageElements?.["customerName"]?.value || "";
  elements["phone"].value = customer?.phone || phoneSeed;
  elements["address"].value = customer?.address || packageElements?.["deliveryAddress"]?.value || "";
  elements["note"].value = customer?.note || packageElements?.["customerNote"]?.value || "";
  elements["name"].focus();
}

function hideCustomerMissing() {
  if (!restaurantRefs.customerMissing) return;
  restaurantRefs.customerMissing.classList.add("hidden");
  restaurantRefs.customerMissing.innerHTML = "";
}

function renderCustomerMissing(query) {
  if (!restaurantRefs.customerMissing) return;
  const phone = query || restaurantRefs.customerPhoneSearch?.value || "";
  const digits = normalizeRestaurantPhone(phone);
  if (digits.length < 5) {
    hideCustomerMissing();
    return;
  }
  restaurantRefs.customerMissing.classList.remove("hidden");
  openReadyRecords();
  restaurantRefs.customerMissing.innerHTML = `
    <p>Bu numara kayitli degil, yeni musteri olarak ekle.</p>
    <button class="ghost-btn missing-customer-add-btn" type="button">Yeni Musteri Olarak Ekle</button>
  `;
  restaurantRefs.customerMissing.querySelector(".missing-customer-add-btn")?.addEventListener("click", () => {
    showCustomerForm({ phone });
  });
}

function selectRestaurantCustomer(customer) {
  if (!customer) return;
  fillPackageFormFromCustomer(customer);
  renderSelectedCustomerHistory(customer);
  renderRestaurantCustomers(restaurantState.data?.customers || []);
  openReadyRecords();
  setActiveWorkspaceSection("restaurantWorkspace_manual");
  showToast("Musteri bilgileri manuel paket formuna aktarildi.");
}

function renderRestaurantCustomers(customers = []) {
  if (!restaurantRefs.customerList) {
    return;
  }
  const query = (restaurantRefs.customerListSearch?.value || "").trim().toLowerCase();
  const selectedId = restaurantRefs.restaurantCustomerId?.value || "";
  const filtered = (customers || []).filter((customer) => {
    if (!query) return true;
    return [customer.name, customer.phone, customer.address, customer.note]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });
  if (filtered.length) {
    hideCustomerMissing();
  } else {
    renderCustomerMissing(query);
  }
  const signature = `${query}|${selectedId}|${listRenderSignature(filtered, ["id", "name", "phone", "address", "note", "orderCount", "lastOrderAt", "updatedAt"])}`;
  if (restaurantRefs.customerList.__deliveraRenderSignature === signature) {
    return;
  }
  restaurantRefs.customerList.__deliveraRenderSignature = signature;
  restaurantRefs.customerList.innerHTML = "";
  if (!filtered.length) {
    restaurantRefs.customerList.innerHTML = '<div class="empty-state">Kayitli musteri bulunamadi.</div>';
    return;
  }
  filtered.forEach((customer) => {
    const card = document.createElement("article");
    card.className = "stack-card";
    if (selectedId && customer.id === selectedId) {
      card.classList.add("selected");
    }
    card.innerHTML = `
      <div class="stack-top">
        <div>
          <strong>${restaurantHtmlSafe(customer.name || "-")}</strong>
          <p>${restaurantHtmlSafe(customer.phone || "-")}</p>
          <p>${restaurantHtmlSafe(customer.address || "-")}</p>
          ${customer.note ? `<p>${restaurantHtmlSafe(customer.note)}</p>` : ""}
        </div>
        <span class="soft-badge">${customer.orderCount || 0} siparis</span>
      </div>
      <p class="soft-copy">Son siparis: ${customer.lastOrderAt ? formatDate(customer.lastOrderAt) : "-"}</p>
      <div class="card-actions">
        <button class="ghost-btn use-customer-btn" type="button">Musteri Sec</button>
        <button class="ghost-btn edit-customer-btn" type="button">Duzenle</button>
        <button class="ghost-btn delete-customer-btn" type="button">Sil / Pasife Al</button>
      </div>
    `;
    card.querySelector(".use-customer-btn")?.addEventListener("click", () => selectRestaurantCustomer(customer));
    card.querySelector(".edit-customer-btn")?.addEventListener("click", () => showCustomerForm(customer));
    card.querySelector(".delete-customer-btn")?.addEventListener("click", async () => {
      if (!confirm(`${customer.name || customer.phone || "Musteri"} pasife alinsin mi?`)) return;
      try {
        const data = await api(`/api/customers/${encodeURIComponent(customer.id)}`, {
          method: "DELETE",
          headers: restaurantAuthHeaders(),
          retryWithRefresh: refreshRestaurantAccess,
        });
        if (restaurantRefs.restaurantCustomerId?.value === customer.id) {
          restaurantRefs.restaurantCustomerId.value = "";
          renderSelectedCustomerHistory(null);
        }
        if (data.state) {
          hydrateRestaurant(data.state);
        } else {
          await loadRestaurantWorkspace({ silent: true, force: true });
        }
        showToast("Musteri pasife alindi.");
      } catch (error) {
        showToast(error.message || "Musteri pasife alinamadi.", "error");
      }
    });
    restaurantRefs.customerList.appendChild(card);
  });
}

function hydrateRestaurant(data, explicitIntegration = null) {
  const nextSignature = JSON.stringify({
    restaurants: (data.restaurants || []).map((item) => [item.id, item.name, item.zone, item.updatedAt]),
    platformAccounts: (data.platformAccounts || []).map((item) => [item.id, item.active, item.connectionStatus, item.lastSyncAt, item.updatedAt]),
    packages: (data.packages || []).map((item) => [item.id, item.status, item.assignmentStatus, item.assignedCourierId, item.paymentStatus, item.updatedAt]),
    customers: (data.customers || []).map((item) => [item.id, item.name, item.phone, item.address, item.note, item.orderCount, item.lastOrderAt, item.updatedAt]),
    notifications: (data.notifications || []).map((item) => [item.id, item.readAt, item.createdAt]),
    performance: data.restaurantPerformance,
    wizard: data.integrationWizard,
    selectedRestaurantId: restaurantState.selectedRestaurantId,
    historyRange: restaurantState.historyRange,
    historyVisibleCount: restaurantState.historyVisibleCount,
    explicitIntegration,
  });
  if (restaurantState.lastHydrateSignature === nextSignature) {
    restaurantState.data = data;
    if (data.restaurants?.[0]) {
      restaurantState.selectedRestaurantId = data.restaurants[0].id || restaurantState.selectedRestaurantId;
    }
    return;
  }
  restaurantState.lastHydrateSignature = nextSignature;
  restaurantState.data = data;
  restaurantState.selectedRestaurantId = data.restaurants[0]?.id || "";
  if (!restaurantState.selectedRestaurantId) {
    restaurantState.pendingAutoPrintKeys.clear();
  }
  updateAutoPrintControls();
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    initializeRestaurantPush();
  } else {
    updateRestaurantPushButton(false);
  }
  if (data.restaurants?.[0]) {
    persistRestaurantAccessInfo({
      restaurantId: data.restaurants[0].id,
      apiKey: data.restaurants[0].apiKey,
    });
  }
  initializeRestaurantWorkspaceCards();
  const activePackages = activeOrderPackages(data.packages || []);
  const awaitingPackages = activePackages.filter((pkg) => pkg.status === "pending" || pkg.status === "awaiting_assignment");
  const inTransitPackages = activePackages.filter((pkg) => pkg.status === "accepted_by_courier" || pkg.status === "on_route");
  const activeCourierIds = [...new Set(activePackages.filter((pkg) => pkg.assignedCourierId).map((pkg) => pkg.assignedCourierId))];

  if (data.restaurants.length === 0) {
    setRestaurantWorkspaceVisible(false);
    restaurantRefs.summary.textContent = "Restoran oturumu acik degil. Yeni restoran olusturabilir veya mevcut restoranla giris yapabilirsin.";
    restaurantRefs.packageRestaurantId.value = "";
    if (restaurantRefs.liveBadge) {
      restaurantRefs.liveBadge.textContent = "Canli akis kapali";
    }
  } else {
    setRestaurantWorkspaceVisible(true);
    restaurantRefs.summary.textContent =
      `${data.restaurants[0].name} icin ${data.packages.length} siparis gorunuyor. Bu panel yalnizca bu restoranin verilerini gosterir.`;
    if (restaurantRefs.liveBadge) {
      restaurantRefs.liveBadge.textContent = "Canli akis acik";
    }
  }

  restaurantRefs.totalPackages.textContent = activePackages.length;
  restaurantRefs.waitingPackages.textContent = awaitingPackages.length;
  restaurantRefs.inTransitPackages.textContent = inTransitPackages.length;
  restaurantRefs.activeCouriers.textContent = activeCourierIds.length;

  renderRestaurantList(data.restaurants);
  renderPlatformAccounts(data.platformAccounts || []);
  renderRestaurantPerformance(data.restaurantPerformance);
  renderIntegrationWizard(data.integrationWizard);
  renderRecentOrders(data.packages);
  renderActiveOrders(data);
  renderOrderHistory(data.packages);
  renderRestaurantNotifications(data.notifications || []);
  renderRestaurantCustomers(data.customers || []);
  setIntegrationInfo(data, explicitIntegration);
  setPlatformSetup(data);
}

restaurantRefs.historyFilters?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-range]");
  if (!button) {
    return;
  }
  restaurantState.historyRange = button.dataset.range;
  restaurantState.historyVisibleCount = 50;
  if (restaurantState.data) {
    renderOrderHistory(restaurantState.data.packages || []);
  }
});

restaurantRefs.historyMore?.addEventListener("click", () => {
  restaurantState.historyVisibleCount += 50;
  if (restaurantState.data) {
    renderOrderHistory(restaurantState.data.packages || []);
  }
});

async function loadRestaurantWorkspace(options = {}) {
  if (restaurantState.workspaceLoadPromise) {
    if (options.force) {
      restaurantState.queuedWorkspaceLoad = { ...(restaurantState.queuedWorkspaceLoad || {}), ...options };
    }
    return restaurantState.workspaceLoadPromise;
  }

  restaurantState.workspaceLoadPromise = doLoadRestaurantWorkspace(options)
    .finally(async () => {
      restaurantState.workspaceLoadPromise = null;
      const queuedOptions = restaurantState.queuedWorkspaceLoad;
      restaurantState.queuedWorkspaceLoad = null;
      if (queuedOptions) {
        await loadRestaurantWorkspace(queuedOptions);
      }
    });
  return restaurantState.workspaceLoadPromise;
}

async function doLoadRestaurantWorkspace(options = {}) {
  if (!restaurantState.token) {
    if (restaurantState.refreshToken) {
      try {
        await refreshRestaurantAccess();
      } catch {
        clearRestaurantAuth();
      }
    }
  }

  if (!restaurantState.token) {
    try {
      const restored = await tryRestaurantSessionFromStoredAccess();
      if (restored) {
        return;
      }
    } catch (error) {
      if (!options.silent) {
        restaurantRefs.summary.textContent = "Restoran oturumu bulunamadi, lutfen tekrar giris yapin";
      }
    }
    stopRestaurantWorkspacePolling();
    hydrateRestaurant({
      zones: [],
      restaurants: [],
      couriers: [],
      packages: [],
      webhookLogs: [],
      restaurantPerformance: null,
      integrationWizard: null,
      stats: {
        totalRestaurants: 0,
        totalCouriers: 0,
        activeCouriers: 0,
        totalPackages: 0,
        waitingPackages: 0,
        assignedPackages: 0,
        inTransitPackages: 0,
        deliveredPackages: 0,
      },
    });
    return;
  }

  try {
    const params = new URLSearchParams({
      limit: String(restaurantState.packageLimit),
      cursor: restaurantState.packageCursor || "0",
    });
    const data = await api(`/api/restaurant/bootstrap?${params.toString()}`, {
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
    });
    hydrateRestaurant(data);
    startRestaurantWorkspacePolling();
    startRestaurantLiveStream();
  } catch (error) {
    if (!options.silent) {
      clearRestaurantAuth();
      restaurantRefs.summary.textContent = error.message.includes("oturumu")
        ? "Restoran oturumu bulunamadi, lutfen tekrar giris yapin"
        : error.message;
    }
  }
}

restaurantRefs.accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(restaurantRefs.accessForm);
  try {
    const data = await api("/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
      }),
    });

    persistRestaurantAuth(data);
    restaurantRefs.accessForm.reset();
    hydrateRestaurant(data.state);
    startRestaurantLiveStream();
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      initializeRestaurantPush();
    }
  } catch (error) {
    restaurantRefs.summary.textContent = error.message.includes("Restoran kimligi")
      ? "Restoran oturumu bulunamadi, lutfen tekrar giris yapin"
      : error.message;
    showToast(restaurantRefs.summary.textContent, "error");
  }
});

restaurantRefs.platformAccountForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!restaurantState.token || !restaurantState.data?.restaurants?.[0]) {
    restaurantRefs.summary.textContent = "Restoran oturumu bulunamadi, lutfen restoran paneline gecerli restoran baglantisiyla girin.";
    showToast("Restoran oturumu bulunamadi, lutfen restoran paneline gecerli restoran baglantisiyla girin.", "error");
    return;
  }

  const restaurant = restaurantState.data.restaurants[0];
  const formData = new FormData(restaurantRefs.platformAccountForm);
  const selectedPlatform = String(formData.get("platform") || "").trim();
  const config = platformClientConfig(selectedPlatform);
  const staticToken = String(formData.get("staticToken") || formData.get("webhookSecret") || "").trim();
  const externalStoreId = String(formData.get("externalStoreId") || "").trim();
  if (isTemporaryPlatformId(externalStoreId)) {
    const warning = `${externalStoreId} geçici ID gibi görünüyor. Platformdaki gerçek restoran/store ID girilmeli.`;
    restaurantRefs.summary.textContent = warning;
    showToast(warning, "error");
  }
  const platformRequestBody = {
    restaurantId: restaurant.id,
    platform: selectedPlatform,
    platformRestaurantId: externalStoreId,
    externalStoreId,
    externalMerchantId: formData.get("externalMerchantId"),
    apiUsername: formData.get("apiUsername"),
    apiPassword: formData.get("apiPassword"),
    apiKey: formData.get("apiKey"),
    apiSecret: formData.get("apiSecret"),
    token: formData.get("token"),
    integrationReferenceCode: formData.get("integrationReferenceCode"),
    posSecretKey: formData.get("posSecretKey"),
    storeFrontCode: formData.get("storeFrontCode"),
    chainId: formData.get("chainId"),
    vendorId: formData.get("vendorId"),
    active: true,
    webhookEnabled: config.webhookEnabled,
    pollingEnabled: config.pollingEnabled,
    webhookSecret: staticToken,
    authType: "static_token",
    staticToken,
    settings: {
      platformMode: config.mode,
      verificationStrategy: config.testStrategy,
      requiredFields: config.requiredFields,
    },
  };

  try {
    const data = await api("/api/restaurant/platform-accounts", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify(platformRequestBody),
    });

    restaurantRefs.platformAccountForm.reset();
    restaurantRefs.platformSelect.innerHTML = createPlatformOptions();
    simplifyPlatformAccountForm();
    applyPlatformFormMode();
    hydrateRestaurant(data);
    const savedAccount = (data.platformAccounts || []).find((item) =>
      item.platform === selectedPlatform && item.externalStoreId === externalStoreId
    );
    restaurantRefs.summary.textContent = savedAccount?.id
      ? "Platform hesabı kaydedildi. İlk gerçek platform siparişi geldiğinde bağlantı otomatik doğrulanacak."
      : "Platform hesabı kaydedildi.";
    showToast(restaurantRefs.summary.textContent, "success");
  } catch (error) {
    const message = platformFriendlyMessage(error.message) || "Platform hesabı kaydedilemedi.";
    restaurantRefs.summary.textContent = message;
    showToast(message, "error");
  }
});

restaurantRefs.platformAccountList?.addEventListener("click", async (event) => {
  const checkButton = event.target.closest("[data-platform-check]");
  const refreshButton = event.target.closest("[data-platform-refresh]");
  const accountId = checkButton?.dataset.platformCheck || refreshButton?.dataset.platformRefresh || "";
  if (!accountId) {
    return;
  }
  const button = checkButton || refreshButton;
  button.disabled = true;
  button.textContent = checkButton ? "Kontrol ediliyor" : "Yenileniyor";
  try {
    const data = checkButton
      ? await api(`/api/restaurant/platform-accounts/${accountId}/check-connection`, {
          method: "POST",
          headers: restaurantAuthHeaders(),
          retryWithRefresh: refreshRestaurantAccess,
        })
      : await api(`/api/restaurant/platform-accounts/${accountId}/health`, {
          headers: restaurantAuthHeaders(),
          retryWithRefresh: refreshRestaurantAccess,
        });
    await loadRestaurantWorkspace();
    showToast(data.publicMessage || data.health?.publicMessage || "Platform bağlantı durumu güncellendi.", data.health?.status === "connected" ? "success" : "warning");
  } finally {
    button.disabled = false;
    button.textContent = checkButton ? "Bağlantıyı Kontrol Et" : "Son Durumu Yenile";
  }
});

restaurantRefs.copyWebhookButton?.addEventListener("click", async () => {
  const text = restaurantRefs.integrationWizardWebhook?.textContent || "";
  if (!text) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("API bilgisi kopyalandi.");
  } catch {
    showToast("API bilgisi kopyalanamadi.", "error");
  }
});

restaurantRefs.manualPlatformOrderForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!restaurantState.token) {
    showToast("Once restoran girisi yapmalisin.", "error");
    return;
  }
  const formData = new FormData(restaurantRefs.manualPlatformOrderForm);
  try {
    const response = await api("/api/restaurant/platform-orders/manual", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify({
        platform: formData.get("platform"),
        customerName: formData.get("customerName"),
        phone: formData.get("phone"),
        address: formData.get("address"),
        totalPrice: formData.get("totalPrice"),
        note: formData.get("note"),
      }),
    });
    if (!response.package?.id || !response.platformOrder?.id) {
      throw new Error("API platform siparisinin veritabanina yazildigini dogrulayan cevap dondurmedi.");
    }
    restaurantRefs.manualPlatformOrderForm.reset();
    setManualPlatformDrawerOpen(false);
    hydrateRestaurant(response.state || response);
    showToast(`Manuel platform siparisi kaydedildi. ID: ${response.platformOrder.id}`);
  } catch (error) {
    showToast(error.message || "Manuel platform siparisi kaydedilemedi.", "error");
  }
});

restaurantRefs.quickPasteButton?.addEventListener("click", () => {
  setQuickPasteModalVisible(true);
});

restaurantRefs.quickPasteClose?.addEventListener("click", () => {
  setQuickPasteModalVisible(false);
});

restaurantRefs.quickPasteModal?.addEventListener("click", (event) => {
  if (event.target?.dataset?.modalClose === "quick-paste") {
    setQuickPasteModalVisible(false);
  }
});

restaurantRefs.mainQuickPasteParseButton?.addEventListener("click", () => {
  const rawText = restaurantRefs.mainQuickPasteRawText?.value || "";
  if (!rawText.trim()) {
    showToast("Lutfen once siparis metnini yapistirin.", "error");
    return;
  }
  const parsed = parseQuickPasteOrder(rawText);
  
  if (restaurantRefs.packageForm) {
    const elements = restaurantRefs.packageForm.elements;
    if (elements["customerName"]) elements["customerName"].value = parsed.customerName || "";
    if (elements["phone"]) elements["phone"].value = parsed.phone || "";
    if (elements["deliveryAddress"]) elements["deliveryAddress"].value = parsed.customerAddress || "";
    if (elements["customerNote"]) elements["customerNote"].value = parsed.customerNote || "";
    if (parsed.packageType && elements["packageType"]) elements["packageType"].value = parsed.packageType;
    if (parsed.orderAmount && elements["orderAmount"]) elements["orderAmount"].value = parsed.orderAmount;
    const paymentCode = quickPastePaymentMethodCode(parsed.paymentMethod);
    if (paymentCode && elements["paymentMethod"]) elements["paymentMethod"].value = paymentCode;
  }
  
  showToast("Form otomatik dolduruldu. Lutfen kontrol edip Paket Olustur'a basin.");
});

restaurantRefs.enablePushButton?.addEventListener("click", async () => {
  await initializeRestaurantPush({ requestPermission: true });
});

restaurantRefs.autoPrintToggle?.addEventListener("click", () => {
  const restaurantId = restaurantState.selectedRestaurantId;
  if (!restaurantId) {
    showToast("Otomatik fiş için önce restoran girişi yapın.", "warning");
    return;
  }
  const enabled = setAutoPrintEnabledForRestaurant(restaurantId, !restaurantState.autoPrintEnabled);
  restaurantState.pendingAutoPrintKeys.clear();
  showToast(
    enabled
      ? "58 mm otomatik fiş açıldı. Chrome kiosk yazdırma modundaysa siparişler sessiz basılır."
      : "58 mm otomatik fiş kapatıldı.",
    enabled ? "success" : "warning"
  );
});

restaurantRefs.orderAlarmAcknowledge?.addEventListener("click", () => {
  stopRestaurantOrderAlarm();
  showToast("Yeni siparis bildirimi goruldu olarak kapatildi.", "success");
});

restaurantRefs.logoutButton?.addEventListener("click", async () => {
  const pushEndpoint = await currentRestaurantPushEndpoint();
  if (restaurantState.refreshToken) {
    api("/api/restaurant/logout", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      body: JSON.stringify({ refreshToken: restaurantState.refreshToken, pushEndpoint }),
    }).catch(() => {
      // Local cleanup should still continue.
    });
  }
  clearRestaurantAuth();
  restaurantRefs.summary.textContent = "Restoran oturumu kapatildi.";
  hydrateRestaurant({
    zones: [],
    restaurants: [],
    couriers: [],
    packages: [],
    webhookLogs: [],
    platformAccounts: [],
    restaurantPerformance: null,
    integrationWizard: null,
    stats: {
      totalRestaurants: 0,
      totalCouriers: 0,
      activeCouriers: 0,
      totalPackages: 0,
      waitingPackages: 0,
      assignedPackages: 0,
      inTransitPackages: 0,
      deliveredPackages: 0,
    },
  });
});

let customerSearchTimer = null;
let customerListSearchTimer = null;

restaurantRefs.manualPlatformToggle?.addEventListener("click", toggleManualPlatformDrawer);

restaurantRefs.readyRecordsToggle?.addEventListener("click", toggleReadyRecords);

restaurantRefs.customerListSearch?.addEventListener("input", () => {
  clearTimeout(customerListSearchTimer);
  customerListSearchTimer = setTimeout(() => {
    renderRestaurantCustomers(restaurantState.data?.customers || []);
  }, 120);
});

restaurantRefs.customerNewButton?.addEventListener("click", () => {
  openReadyRecords();
  showCustomerForm();
});

restaurantRefs.customerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!restaurantState.token) {
    showToast("Musteri kaydetmek icin restoran girisi gerekli.", "error");
    return;
  }
  const currentRestaurantId = restaurantState.data?.restaurants?.[0]?.id;
  if (!currentRestaurantId) {
    showToast("Aktif restoran bulunamadi.", "error");
    return;
  }
  const formData = new FormData(restaurantRefs.customerForm);
  const customerId = formData.get("id");
  const isEdit = Boolean(customerId);
  try {
    const data = await api(isEdit
      ? `/api/customers/${encodeURIComponent(customerId)}`
      : `/api/restaurants/${encodeURIComponent(currentRestaurantId)}/customers`, {
      method: isEdit ? "PATCH" : "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify({
        name: formData.get("name"),
        phone: formData.get("phone"),
        address: formData.get("address"),
        note: formData.get("note"),
      }),
    });
    restaurantRefs.customerForm.reset();
    restaurantRefs.customerForm.classList.add("hidden");
    if (data.state) {
      hydrateRestaurant(data.state);
    } else {
      await loadRestaurantWorkspace({ silent: true, force: true });
    }
    const savedPhone = normalizeRestaurantPhone(formData.get("phone"));
    const savedCustomer = data.customer || (data.state?.customers || []).find((item) =>
      (customerId && item.id === customerId) || normalizeRestaurantPhone(item.phone) === savedPhone
    );
    if (savedCustomer) {
      fillPackageFormFromCustomer(savedCustomer);
      renderSelectedCustomerHistory(savedCustomer);
    }
    showToast(isEdit ? "Musteri guncellendi." : "Musteri kaydedildi.");
  } catch (error) {
    showToast(error.message || "Musteri kaydedilemedi.", "error");
  }
});

restaurantRefs.customerPhoneSearch?.addEventListener("input", () => {
  clearTimeout(customerSearchTimer);
  const phone = restaurantRefs.customerPhoneSearch.value.trim();
  if (restaurantRefs.restaurantCustomerId) {
    restaurantRefs.restaurantCustomerId.value = "";
  }
  if (restaurantRefs.customerListSearch) {
    restaurantRefs.customerListSearch.value = phone;
  }
  renderRestaurantCustomers(restaurantState.data?.customers || []);
  if (!phone || phone.replace(/\D/g, "").length < 5) {
    if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = "Telefon yazinca kayitli musteri aranir.";
    hideCustomerMissing();
    return;
  }
  customerSearchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/restaurant/customers?phone=${encodeURIComponent(phone)}`, {
        headers: restaurantAuthHeaders(),
        retryWithRefresh: refreshRestaurantAccess,
      });
      const customer = data.customers?.[0];
      if (!customer) {
        if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = "Kayitli musteri bulunamadi; bilgileri girersen yeni kayit acilir.";
        renderCustomerMissing(phone);
        return;
      }
      if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = `${customer.name || "Musteri"} bulundu; sag listeden tek tikla sec.`;
      renderRestaurantCustomers(data.customers || []);
    } catch (error) {
      if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = error.message || "Musteri aramasi basarisiz.";
    }
  }, 350);
});

restaurantRefs.customerPhoneSearchButton?.addEventListener("click", () => {
  searchRestaurantCustomerByPhone();
});

restaurantRefs.customerPhoneSearch?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  clearTimeout(customerSearchTimer);
  searchRestaurantCustomerByPhone();
});

restaurantRefs.packageForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!restaurantState.token) {
    restaurantRefs.summary.textContent = "Paket olusturmadan once restoran girisi yapmalisin.";
    return;
  }

  const currentRestaurant = restaurantState.data?.restaurants?.[0];
  if (!currentRestaurant) {
    restaurantRefs.summary.textContent = "Aktif restoran oturumu bulunamadi. Once tekrar giris yap.";
    return;
  }

  const formData = new FormData(restaurantRefs.packageForm);
  const payload = {
    deliveryAddress: formData.get("deliveryAddress"),
    packageType: formData.get("packageType"),
    orderAmount: formData.get("orderAmount"),
    customerName: formData.get("customerName"),
    phone: formData.get("phone"),
    customerNote: formData.get("customerNote"),
    paymentMethod: formData.get("paymentMethod"),
    restaurantCustomerId: formData.get("restaurantCustomerId"),
  };

  const file = restaurantRefs.packageImageInput?.files?.[0] || null;
  if (file) {
    if (file.size > 10 * 1024 * 1024) {
      showToast("Fotograf 10MB'dan kucuk olmalidir.", "error");
      return;
    }
    try {
      payload.photoBase64 = await compressImage(file);
    } catch (err) {
      console.error("Image compression error:", err);
      showToast("Fotograf islenemedi: " + (err.message || "Bilinmeyen hata"), "error");
      return;
    }
  }

  try {
    const data = await api("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
      body: JSON.stringify(payload),
    });

    if (!data.createdPackage?.id) {
      throw new Error("API paketin veritabanina yazildigini dogrulayan createdPackage cevabi dondurmedi.");
    }
    restaurantRefs.packageForm.reset();
    if (restaurantRefs.restaurantCustomerId) restaurantRefs.restaurantCustomerId.value = "";
    if (restaurantRefs.customerListSearch) restaurantRefs.customerListSearch.value = "";
    if (restaurantRefs.customerSearchHint) restaurantRefs.customerSearchHint.textContent = "Telefon yazinca kayitli musteri aranir.";
    hideCustomerMissing();
    renderSelectedCustomerHistory(null);
    if (restaurantRefs.packageImagePreview) {
      restaurantRefs.packageImagePreview.style.display = "none";
      restaurantRefs.packageImagePreview.src = "";
    }
    if (restaurantRefs.mainQuickPasteRawText) {
      restaurantRefs.mainQuickPasteRawText.value = "";
    }
    hydrateRestaurant(data);
    restaurantRefs.summary.textContent = `${currentRestaurant.name} icin paket olusturuldu ve dogrudan havuza iletildi.`;
    showToast("Paket kaydedildi ve dogrudan kurye havuzuna iletildi.");
  } catch (error) {
    restaurantRefs.summary.textContent = error.message || "Manuel paket kaydedilemedi.";
    showToast(error.message || "Manuel paket kaydedilemedi.", "error");
  }
});

restaurantRefs.platformSelect.innerHTML = createPlatformOptions();
if (restaurantRefs.manualPlatformSelect) {
  restaurantRefs.manualPlatformSelect.innerHTML = createPlatformOptions();
}
restaurantRefs.platformSelect?.addEventListener("change", applyPlatformFormMode);
if (restaurantRefs.samplePaymentMethod) {
  restaurantRefs.samplePaymentMethod.innerHTML = PAYMENT_OPTIONS.map((item) => `<option value="${item}">${item}</option>`).join("");
}
simplifyPlatformAccountForm();
restaurantRefs.samplePaymentMethod?.addEventListener("change", () => {
  if (restaurantState.data) {
    setIntegrationInfo(restaurantState.data);
  }
});

function compressImage(file, maxSize = 1200, quality = 0.7) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("Dosya bulunamadi."));
    
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const img = new Image();
      
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round(height * (maxSize / width));
            width = maxSize;
          } else {
            width = Math.round(width * (maxSize / height));
            height = maxSize;
          }
        }
        
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        
        try {
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (err) {
          // Fallback to raw dataUrl if canvas compression fails
          resolve(dataUrl);
        }
      };
      
      img.onerror = () => {
        // If the browser cannot render this image type (e.g., raw HEIC),
        // fallback to uploading the raw base64 file without compression.
        resolve(dataUrl);
      };
      
      img.src = dataUrl;
    };
    
    reader.onerror = () => reject(new Error("Dosya okunamadi."));
    reader.readAsDataURL(file);
  });
}

function handleImagePreview(inputElement, previewElement) {
  if (!inputElement || !previewElement) return;
  inputElement.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        previewElement.src = ev.target.result;
        previewElement.style.display = "block";
      };
      reader.readAsDataURL(file);
    } else {
      previewElement.src = "";
      previewElement.style.display = "none";
    }
  });
}
handleImagePreview(restaurantRefs.packageImageInput, restaurantRefs.packageImagePreview);
  restaurantRefs.openCameraButton?.addEventListener("click", () => {
    if (restaurantRefs.packageImageInput) {
      // Force mobile browsers to open camera directly
      restaurantRefs.packageImageInput.setAttribute("capture", "environment");
      restaurantRefs.packageImageInput.click();
      
      // Remove the capture attribute after a short delay so manual file selection still works
      setTimeout(() => {
        restaurantRefs.packageImageInput.removeAttribute("capture");
      }, 500);
    }
  });

readStoredRestaurantAuth();
applyRestaurantAccessFromQuery();
setRestaurantWorkspaceVisible(Boolean(restaurantState.token || restaurantState.refreshToken));

api("/api/bootstrap")
  .then((data) => {
    return loadRestaurantWorkspace();
  })
  .catch((error) => {
    restaurantRefs.summary.textContent = error.message;
  });

window.addEventListener("beforeunload", stopRestaurantWorkspacePolling);

// ── Report module state ──────────────────────────────────────────────
let _lastReportData = null;
let _lastDetailData = null;
let _lastDetailDate = null;
let _lastDetailCourier = "";

const _reportDetailRefs = {
  section: restaurantRefs.reportDetailSection,
  title: restaurantRefs.reportDetailTitle,
  subtitle: restaurantRefs.reportDetailSubtitle,
  courierSummary: restaurantRefs.reportCourierSummary,
  detailBody: restaurantRefs.reportDetailTableBody,
  exportBtn: restaurantRefs.exportDetailExcel,
  closeBtn: restaurantRefs.closeReportDetail,
  exportSummaryBtn: restaurantRefs.exportReportExcel,
};

const _formatTRY = (val) =>
  new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(val || 0);

// ── CSV / Excel Export Utility ───────────────────────────────────────
function reportPaymentType(pkg = {}) {
  const text = String(`${pkg.payment_method || ""} ${pkg.payment_status || ""}`).toLowerCase();
  if (text.includes("cash") || text.includes("nakit")) return "Nakit";
  if (text.includes("card") || text.includes("kart") || text.includes("kredi")) return "Kredi Kartı";
  if (text.includes("online")) return "Online Ödeme";
  return pkg.payment_method || pkg.payment_status || "-";
}

function reportDeliveredTime(pkg = {}) {
  const value = pkg.delivered_at || pkg.updated_at || pkg.created_at || "";
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("tr-TR");
}

function reportEscapeCsv(value = "") {
  return String(value ?? "").replace(/;/g, ",").replace(/\r?\n/g, " ");
}

function reportXmlSafe(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function syncReportTableHeaders() {
  const summaryTable = restaurantRefs.reportTableBody?.closest("table");
  const detailTable = _reportDetailRefs.detailBody?.closest("table");
  const summaryHead = summaryTable?.querySelector("thead");
  const detailHead = detailTable?.querySelector("thead");
  if (summaryHead) {
    summaryHead.innerHTML = `
      <tr>
        <th>Tarih</th>
        <th>Kurye</th>
        <th style="text-align:center;">Paket Sayısı</th>
        <th style="text-align:right;">Nakit Toplam</th>
        <th style="text-align:right;">Kredi Kartı</th>
        <th style="text-align:right;">Online Ödeme</th>
        <th style="text-align:right;">Toplam Ciro</th>
        <th style="text-align:right;">Detay</th>
      </tr>
    `;
  }
  if (detailHead) {
    detailHead.innerHTML = `
      <tr>
        <th>Paket Kodu</th>
        <th>Müşteri</th>
        <th>Telefon</th>
        <th>Adres</th>
        <th style="text-align:right;">Tutar</th>
        <th>Ödeme Tipi</th>
        <th>Kurye</th>
        <th>Teslim Saati</th>
        <th>Durum</th>
        <th>İşlem Geçmişi</th>
      </tr>
    `;
  }
}

function reportColumnName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function reportCrc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function reportUint16(value) {
  return [value & 255, (value >>> 8) & 255];
}

function reportUint32(value) {
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
}

function reportZipStore(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const crc = reportCrc32(dataBytes);
    const local = new Uint8Array([
      ...reportUint32(0x04034b50), ...reportUint16(20), ...reportUint16(0), ...reportUint16(0),
      ...reportUint16(0), ...reportUint16(0), ...reportUint32(crc), ...reportUint32(dataBytes.length),
      ...reportUint32(dataBytes.length), ...reportUint16(nameBytes.length), ...reportUint16(0),
    ]);
    chunks.push(local, nameBytes, dataBytes);
    central.push({ nameBytes, crc, size: dataBytes.length, offset });
    offset += local.length + nameBytes.length + dataBytes.length;
  }
  const centralOffset = offset;
  for (const entry of central) {
    const header = new Uint8Array([
      ...reportUint32(0x02014b50), ...reportUint16(20), ...reportUint16(20), ...reportUint16(0),
      ...reportUint16(0), ...reportUint16(0), ...reportUint16(0), ...reportUint32(entry.crc),
      ...reportUint32(entry.size), ...reportUint32(entry.size), ...reportUint16(entry.nameBytes.length),
      ...reportUint16(0), ...reportUint16(0), ...reportUint16(0), ...reportUint16(0), ...reportUint32(0),
      ...reportUint32(entry.offset),
    ]);
    chunks.push(header, entry.nameBytes);
    offset += header.length + entry.nameBytes.length;
  }
  const centralSize = offset - centralOffset;
  chunks.push(new Uint8Array([
    ...reportUint32(0x06054b50), ...reportUint16(0), ...reportUint16(0), ...reportUint16(central.length),
    ...reportUint16(central.length), ...reportUint32(centralSize), ...reportUint32(centralOffset), ...reportUint16(0),
  ]));
  return new Blob(chunks, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function exportToExcel(rows, filename) {
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${reportColumnName(colIndex)}${rowIndex + 1}`;
      const isNumber = typeof value === "number" && Number.isFinite(value);
      if (isNumber) return `<c r="${ref}"><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${reportXmlSafe(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const files = [
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Gün Sonu Raporu" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ];
  const blob = reportZipStore(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.replace(/\.csv$/i, ".xlsx");
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

// ── Summary Report Loader (click-to-detail rows) ────────────────────
async function loadRestaurantReports() {
  if (!restaurantRefs.reportTableBody) return;

  syncReportTableHeaders();
  if (_reportDetailRefs.section) _reportDetailRefs.section.style.display = "none";

  restaurantRefs.reportTableBody.innerHTML =
    '<tr><td colspan="8" style="text-align:center;">Raporlar yükleniyor...</td></tr>';

  try {
    const data = await api("/api/restaurant/reports/daily", {
      method: "GET",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
    });

    _lastReportData = data;

    if (!data.reports || data.reports.length === 0) {
      restaurantRefs.reportTableBody.innerHTML =
        '<tr><td colspan="8" style="text-align:center;">Geçmişe dönük gün sonu verisi bulunamadı.</td></tr>';
      return;
    }

    const rowsHTML = data.reports
      .map(
        (r) => `
      <tr>
        <td>
          <strong>${restaurantHtmlSafe(r.date)}</strong>
        </td>
        <td>${restaurantHtmlSafe(r.courier_name || "Bilinmiyor")}</td>
        <td style="text-align:center;">${Number(r.package_count || 0)} Paket</td>
        <td style="text-align:right;">${_formatTRY(r.cash_revenue)}</td>
        <td style="text-align:right;">${_formatTRY(r.card_revenue)}</td>
        <td style="text-align:right;">${_formatTRY(r.online_revenue)}</td>
        <td style="text-align:right;font-weight:700;">${_formatTRY(r.total_revenue)}</td>
        <td style="text-align:right;">
          <button class="ghost-btn report-detail-btn" type="button" data-report-date="${restaurantHtmlSafe(r.date)}" data-report-courier="${restaurantHtmlSafe(r.courier_name || "Bilinmiyor")}">Detay</button>
        </td>
      </tr>`
      )
      .join("");

    restaurantRefs.reportTableBody.innerHTML = rowsHTML;

    restaurantRefs.reportTableBody.querySelectorAll(".report-detail-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        loadReportDetail(btn.dataset.reportDate, btn.dataset.reportCourier);
      });
    });
  } catch (err) {
    console.error("loadRestaurantReports error", err);
    restaurantRefs.reportTableBody.innerHTML =
      '<tr><td colspan="8" style="text-align:center;color:var(--coral);">Bağlantı hatası oluştu.</td></tr>';
  }
}

// ── Daily Detail Loader ──────────────────────────────────────────────
async function loadReportDetail(date, courierName = "") {
  if (!_reportDetailRefs.section) return;

  syncReportTableHeaders();
  _lastDetailDate = date;
  _lastDetailCourier = courierName || "";
  _reportDetailRefs.section.style.display = "block";
  _reportDetailRefs.title.textContent = `${date} - ${courierName || "Tüm Kuryeler"} Detay`;
  _reportDetailRefs.subtitle.textContent = "Yükleniyor...";
  _reportDetailRefs.courierSummary.innerHTML = "";
  _reportDetailRefs.detailBody.innerHTML =
    '<tr><td colspan="10" style="text-align:center;">Detay yükleniyor...</td></tr>';

  _reportDetailRefs.section.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const params = new URLSearchParams({ date });
    if (courierName) params.set("courier", courierName);
    const data = await api("/api/restaurant/reports/daily-detail?" + params.toString(), {
      method: "GET",
      headers: restaurantAuthHeaders(),
      retryWithRefresh: refreshRestaurantAccess,
    });

    _lastDetailData = data;

    _reportDetailRefs.subtitle.textContent = `${data.summary.total_packages} Paket · ${data.couriers.length} Kurye · ${_formatTRY(data.summary.total_revenue)} Toplam Ciro`;

    if (data.couriers && data.couriers.length > 0) {
      _reportDetailRefs.courierSummary.innerHTML = data.couriers
        .map(
          (c) => `
        <span class="report-courier-pill">
          <strong>${restaurantHtmlSafe(c.name)}</strong>
          <span>${Number(c.package_count || 0)} paket</span>
          <span>${_formatTRY(c.total_revenue)}</span>
        </span>`
        )
        .join("");
    }

    if (!data.packages || data.packages.length === 0) {
      _reportDetailRefs.detailBody.innerHTML =
        '<tr><td colspan="10" style="text-align:center;">Kayıt bulunamadı.</td></tr>';
      return;
    }

    const rowsHTML = data.packages
      .map((pkg) => {
        const address = pkg.delivery_address || pkg.customer_address || pkg.address || "-";
        const status = typeof statusLabel === "function" ? statusLabel(pkg.status) : pkg.status || "-";
        const history = Array.isArray(pkg.audit_history) && pkg.audit_history.length
          ? pkg.audit_history.map((item) => `${item.action || "İşlem"} ${reportDeliveredTime(item)}`).join(" | ")
          : "-";

        return `
        <tr>
          <td><span class="report-code">${restaurantHtmlSafe(pkg.tracking_no || pkg.id)}</span></td>
          <td>${restaurantHtmlSafe(pkg.recipient || "-")}</td>
          <td>${restaurantHtmlSafe(pkg.phone || "-")}</td>
          <td class="report-address">${restaurantHtmlSafe(address)}</td>
          <td style="text-align:right;font-weight:600;">${_formatTRY(pkg.order_amount)}</td>
          <td>${restaurantHtmlSafe(reportPaymentType(pkg))}</td>
          <td><strong>${restaurantHtmlSafe(pkg.assigned_courier_name || "-")}</strong></td>
          <td>${restaurantHtmlSafe(reportDeliveredTime(pkg))}</td>
          <td><span class="status-badge ${statusClassName(pkg.status)}">${restaurantHtmlSafe(status)}</span></td>
          <td class="report-history">${restaurantHtmlSafe(history)}</td>
        </tr>`;
      })
      .join("");

    _reportDetailRefs.detailBody.innerHTML = rowsHTML;
  } catch (err) {
    console.error("loadReportDetail error", err);
    _reportDetailRefs.detailBody.innerHTML =
      '<tr><td colspan="10" style="text-align:center;color:var(--coral);">Bağlantı hatası oluştu.</td></tr>';
    _reportDetailRefs.subtitle.textContent = "Hata oluştu.";
  }
}

// ── Event Listeners ──────────────────────────────────────────────────
const reportsTab = document.querySelector('.tree-link[data-section="restaurantWorkspace_reports"]');
if (reportsTab) {
  reportsTab.addEventListener("click", () => {
    loadRestaurantReports();
  });
}

if (restaurantRefs.printReportButton) {
  restaurantRefs.printReportButton.addEventListener("click", () => {
    document.body.classList.add("report-print-mode");
    window.print();
    window.setTimeout(() => {
      document.body.classList.remove("report-print-mode");
    }, 500);
  });
}

if (_reportDetailRefs.closeBtn) {
  _reportDetailRefs.closeBtn.addEventListener("click", () => {
    _reportDetailRefs.section.style.display = "none";
  });
}

if (_reportDetailRefs.exportSummaryBtn) {
  _reportDetailRefs.exportSummaryBtn.addEventListener("click", async () => {
    const button = _reportDetailRefs.exportSummaryBtn;
    const originalText = button.innerHTML;
    try {
      if (!_lastReportData || !_lastReportData.reports) {
        await loadRestaurantReports();
      }
      if (!_lastReportData || !_lastReportData.reports || _lastReportData.reports.length === 0) {
        showToast("Excel için rapor verisi bulunamadı.", "error");
        return;
      }
      button.disabled = true;
      button.innerHTML = "Hazırlanıyor...";
      const rows = [
        ["Özet"],
        ["Tarih", "Kurye", "Paket Sayısı", "Nakit Toplam", "Kredi Kartı Toplam", "Online Ödeme Toplam", "Toplam Ciro"],
      ];
      for (const r of _lastReportData.reports) {
        rows.push([
          r.date,
          r.courier_name || "Bilinmiyor",
          r.package_count,
          r.cash_revenue,
          r.card_revenue,
          r.online_revenue,
          r.total_revenue,
        ]);
      }

      rows.push([]);
      rows.push(["Detay"]);
      rows.push(["Tarih", "Kurye", "Paket kodu", "Müşteri", "Telefon", "Adres", "Ödeme tipi", "Tutar", "Teslim zamanı", "Durum"]);

      for (const report of _lastReportData.reports) {
        const params = new URLSearchParams({ date: report.date });
        if (report.courier_name) params.set("courier", report.courier_name);
        const detail = await api("/api/restaurant/reports/daily-detail?" + params.toString(), {
          method: "GET",
          headers: restaurantAuthHeaders(),
          retryWithRefresh: refreshRestaurantAccess,
        });
        for (const p of detail.packages || []) {
          const status = typeof statusLabel === "function" ? statusLabel(p.status) : p.status || "";
          rows.push([
            report.date,
            p.assigned_courier_name || "",
            p.tracking_no || p.id || "",
            p.recipient || "",
            p.phone || "",
            p.delivery_address || p.customer_address || p.address || "",
            reportPaymentType(p),
            p.order_amount || 0,
            reportDeliveredTime(p),
            status,
          ]);
        }
      }

      exportToExcel(rows, "delivera-z-raporu.xlsx");
      button.dataset.lastExport = new Date().toISOString();
      showToast("Excel dosyası hazırlandı.", "success");
    } catch (err) {
      console.error("exportReportExcel error", err);
      showToast("Excel hazırlanamadı.", "error");
    } finally {
      button.disabled = false;
      button.innerHTML = originalText;
    }
  });
}

if (_reportDetailRefs.exportBtn) {
  _reportDetailRefs.exportBtn.addEventListener("click", () => {
    if (!_lastDetailData || !_lastDetailData.packages) return;
    const rows = [
      ["Tarih", "Kurye", "Paket kodu", "Müşteri", "Telefon", "Adres", "Ödeme tipi", "Tutar", "Teslim zamanı", "Durum", "İşlem Geçmişi"],
    ];
    for (const p of _lastDetailData.packages) {
      const status = typeof statusLabel === "function" ? statusLabel(p.status) : p.status || "";
      const history = Array.isArray(p.audit_history) && p.audit_history.length
        ? p.audit_history.map((item) => `${item.action || "İşlem"} ${reportDeliveredTime(item)}`).join(" | ")
        : "";
      rows.push([
        _lastDetailDate || _lastDetailData.date || "",
        _lastDetailCourier || p.assigned_courier_name || "",
        p.tracking_no || p.id,
        p.recipient || "",
        p.phone || "",
        p.delivery_address || p.customer_address || p.address || "",
        reportPaymentType(p),
        p.order_amount || 0,
        reportDeliveredTime(p),
        status,
        history,
      ]);
    }
    exportToExcel(rows, `delivera-detay-${_lastDetailDate}.xlsx`);
  });
}
