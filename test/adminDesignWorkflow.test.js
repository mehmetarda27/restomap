const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("new admin design renders backend packages and listens to named live operation events", async () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "admin-design-source", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "admin-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/admin.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const eventTypes = new Set();
  class FakeEventSource {
    addEventListener(type) { eventTypes.add(type); }
    close() {}
  }
  const workspace = {
    packages: [
      { id: "pkg_admin_ui", trackingNo: "PKT-ADMIN-UI", restaurantName: "Admin Test Restoran", customerName: "Test Müşteri", deliveryAddress: "Test adresi", status: "awaiting_assignment", orderAmount: 240, createdAt: new Date().toISOString() },
      { id: "pkg_admin_old", trackingNo: "PKT-ADMIN-OLD", restaurantName: "Eski Restoran", status: "delivered", orderAmount: 100, deliveredAt: new Date(Date.now() - 86400000).toISOString() },
    ],
    couriers: [{ id: "cr_admin_ui", name: "Test Kurye", status: "online", activeLoad: 0 }],
    restaurants: [{ id: "rst_admin_ui", name: "Admin Test Restoran" }],
    notifications: [{ id: "ntf_admin_ui", message: "Yeni paket", eventType: "package-created", createdAt: new Date().toISOString() }],
    unmatchedOrders: [{ id: "unm_admin_ui", externalOrderId: "POS-ADMIN-UI", externalRestaurantId: "pos-store-99", restaurantNameFromPayload: "Admin Test Restoran", platform: "Posentegra", customerName: "Eşleşmeyen Müşteri", customerPhone: "05310000000", totalPrice: 315, status: "new", rawPayload: { source: "test" }, isResolved: false, createdAt: new Date().toISOString() }],
    stats: { totalPackages: 1, waitingPackages: 1, activeCouriers: 1 }, zones: [], platformAccounts: [], shiftPlans: [], cashReconciliations: [],
    restaurantAccounting: [{ restaurantId: "rst_admin_ui", restaurantName: "Admin Test Restoran", totalSubmittedPackages: 7, totalPackages: 5, totalCancelledPackages: 2, totalCourierCollected: 500, serviceFee: 100, netPayable: 400 }],
    restaurantSettlements: [],
  };
  window.__DELIVERA_TEST__ = true;
  window.EventSource = FakeEventSource;
  window.confirm = () => true;
  const fetchCalls = [];
  window.fetch = async (request) => {
    const url = String(request);
    fetchCalls.push(url);
    if (url.startsWith("/api/admin/reports/account")) return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        timezone: "Europe/Istanbul",
        currentDate: "2026-08-18",
        selectedDate: "2026-08-12",
        period: "range",
        rangeStart: "2026-08-12",
        rangeEnd: "2026-08-18",
        selectedRestaurantId: "",
        restaurants: workspace.restaurants,
        filters: { status: "all", payment: "all" },
        summary: { totalOrders: 3, deliveredCount: 1, cancelledCount: 1, activeCount: 1 },
        history: [{ date: "2026-08-18", totalOrders: 3, deliveredCount: 1, cancelledCount: 1, activeCount: 1, deliveredRevenue: 100 }],
        packages: [],
      }),
    };
    return { ok: true, status: 200, json: async () => workspace };
  };
  window.localStorage.setItem("deliveraAdminToken", "admin-ui-token");
  window.eval(bridge);
  await delay(60);

  assert.match(window.document.getElementById("adminOperationRows").textContent, /PKT-ADMIN-UI/);
  assert.doesNotMatch(window.document.getElementById("adminOperationRows").textContent, /PKT-ADMIN-OLD/);
  assert.match(window.document.getElementById("adminOperationRows").textContent, /Admin Test Restoran/);
  assert.equal(window.document.querySelector('[aria-label="Bildirim Merkezi"] .da-notification-badge').textContent, "1");
  const creditShortcut = window.document.querySelector('[aria-label="Kontör İşlemleri"]');
  assert.ok(creditShortcut);
  assert.equal(creditShortcut.getAttribute("role"), "button");
  assert.equal(creditShortcut.querySelector(".text-green-600").textContent, "0");
  ["package-created", "package-assigned", "package-status", "assignment-waiting", "order:new", "courier-location", "workspace-update"].forEach((type) => assert.ok(eventTypes.has(type), type));
  assert.ok(window.__adminDesignTest.visiblePackages().some((pkg) => pkg.id === "pkg_admin_ui"));
  assert.equal(window.document.querySelector('[data-action="map"]'), null);
  assert.equal(window.document.querySelector('[data-action="detail"]').getAttribute("aria-label"), "Paket detayını görüntüle");
  const rangeReportMenu = [...window.document.querySelectorAll("aside nav a")].find((link) => link.textContent.includes("İşletme Tarih Aralığı"));
  assert.ok(rangeReportMenu);
  await window.__adminDesignTest.handleRoute("işletme tarih aralığı");
  await delay(20);
  assert.match(window.document.querySelector(".da-modal-head").textContent, /İşletme Tarih Aralığı Raporu/);
  assert.match(window.document.querySelector("[data-admin-account-report]").textContent, /İptaller dahil toplam\s*4/);
  assert.ok(window.document.querySelector('[data-report-filter] input[name="startDate"]'));
  assert.ok(window.document.querySelector('[data-report-filter] input[name="endDate"]'));
  assert.ok(fetchCalls.some((url) => url.includes("period=range") && url.includes("startDate=") && url.includes("endDate=")));
  window.document.querySelector(".da-modal-root")?.remove();
  const unmatchedMenu = [...window.document.querySelectorAll("aside nav a")].find((link) => link.textContent.includes("Eşleşmeyen Paketler"));
  assert.ok(unmatchedMenu);
  assert.equal(unmatchedMenu.querySelector(".da-sidebar-count").textContent, "1");
  await window.__adminDesignTest.handleRoute("eşleşmeyen paketler");
  assert.equal(window.document.querySelector(".da-unmatched-workspace").hidden, false);
  assert.match(window.document.querySelector(".da-unmatched-workspace").textContent, /POS-ADMIN-UI/);
  assert.equal(window.document.querySelector('[data-unmatched-restaurant="unm_admin_ui"]'), null);
  assert.equal(window.document.querySelector('[data-unmatched-id="unm_admin_ui"] [data-unmatched-restaurant]').value, "rst_admin_ui");
  window.__adminDesignTest.handleRoute("operasyon");
  assert.equal(window.document.querySelector(".da-unmatched-workspace").hidden, true);
  window.document.querySelector('[data-action="detail"]').click();
  assert.match(window.document.querySelector(".da-modal-head").textContent, /Paket PKT-ADMIN-UI/);
  assert.equal(window.document.querySelector("#daMap"), null);

  window.__adminDesignTest.hydrate({
    ...workspace,
    packages: [{ ...workspace.packages[0], restaurantId: "rst_admin_ui" }],
    restaurants: [{ id: "rst_admin_ui", name: "Admin Test Restoran", zone: "Merkez", latitude: 36.8, longitude: 34.63 }],
    couriers: [
      { id: "cr_admin_ui", name: "Test Kurye", status: "online", available: true, latitude: 36.81, longitude: 34.64, activeLoad: 0 },
      { id: "cr_offline", name: "Kapalı Kurye", status: "offline", available: false, latitude: 36.82, longitude: 34.65, activeLoad: 0 },
    ],
  });
  const mapData = window.__adminDesignTest.operationMapData();
  assert.equal(mapData.mappedRestaurants.length, 1);
  assert.equal(mapData.mappedRestaurants[0].waitingCount, 1);
  assert.deepEqual(mapData.activeCouriers.map((courier) => courier.id), ["cr_admin_ui"]);
  await window.__adminDesignTest.handleRoute("işletme tahsilat");
  await delay(20);
  assert.match(window.document.querySelector(".da-modal-body").textContent, /7 toplam paket · 5 teslimat · 2 iptal/);
  assert.deepEqual([...window.document.querySelector('[data-accounting-filter] select[name="restaurantId"]').options].map((option) => option.textContent), ["Tüm restoranlar", "Admin Test Restoran"]);
  window.document.querySelector(".da-modal-root")?.remove();

  const distinctAdminRoutes = [
    ["siparişler", "Detaylı Sipariş Raporu"],
    ["kurye raporu", "Kurye Durum Raporu"],
    ["kurye performans", "Kurye Performans ve Kazanç"],
    ["kurye tahsilat", "Kurye Tahsilat Mutabakatı"],
    ["kurye nakitleri", "Kurye Nakitleri Raporu"],
    ["işletme-kurye teslim takibi", "İşletme-Kurye Teslim Takibi"],
    ["kurye ücretlendirme", "Kurye Paket Başı Ücretlendirme"],
    ["kurye özel ücretlendirme", "Kurye Özel Ücretlendirme"],
    ["kurye kazanç", "Kurye Hakediş ve Kazanç Yönetimi"],
    ["restoran bazlı kurye kazanç", "Restoran Bazlı Kurye Kazanç Raporu"],
    ["kurye havuz yetkileri", "Kurye Havuz Uygunlukları"],
    ["havuz sipariş geçmişi", "Havuz Sipariş Geçmişi"],
    ["detaylı sipariş raporu", "Detaylı Sipariş Raporu"],
    ["parçalı ödeme raporu", "Parçalı Ödeme Raporu"],
    ["kurye teslim süre raporu", "Kurye Teslim Süre Raporu"],
    ["kurye ödeme türü raporu", "Kurye Ödeme Türü Raporu"],
    ["kurye ceza & ödül raporu", "Kurye Ceza ve Ödül Raporu"],
    ["firma kazanç", "Firma Kazanç Raporu"],
    ["işletme ücret iadesi", "İşletme Ücret İadeleri"],
    ["işletme ücretlendirme", "İşletme Ücretlendirme"],
    ["restoran fiyatlandırması", "Restoran Fiyatlandırması"],
    ["paket satın alma", "İşletme Paket Satın Alma"],
    ["kontör", "İşletme Paket ve Kontör İşlemleri"],
    ["sistem dışı onaylar", "Sistem Dışı İşlem Onayları"],
    ["sistem dışı rapor", "Sistem Dışı İşlemler"],
    ["sistem dışı dahil kurye kazanç", "Sistem Dışı Dahil Kurye Kazanç"],
    ["işletme bölge fiyatlandırma", "İşletme Bölge Fiyatlandırma"],
    ["işletme bölge bazlı tahsilat", "İşletme Bölge Bazlı Tahsilat"],
    ["restoran hesap raporu", "Restoran Hesap Raporu"],
  ];
  for (const [route, title] of distinctAdminRoutes) {
    await window.__adminDesignTest.handleRoute(route);
    await delay(5);
    assert.match(window.document.querySelector(".da-modal-head")?.textContent || "", new RegExp(title), route);
    window.document.querySelector(".da-modal-root")?.remove();
  }
  dom.window.close();
});
