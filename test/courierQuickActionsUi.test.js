const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("courier quick actions start closed and manager call uses the configured fallback number", async () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "courier-design-source", "ana_harita_ekran", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "courier-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/courier.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const workspace = {
    courier: { id: "cr_quick", name: "Hızlı İşlem Kurye", available: false, latitude: 36.81, longitude: 34.64 },
    packages: [], historyPackages: [{ id: "pkg-history", status: "delivered" }], notifications: [], restaurants: [],
    dayMetrics: {}, earningsSummary: { today: {}, last7Days: {} }, reportSummary: { daily: {} }, shiftSummary: {},
  };
  window.EventSource = class { addEventListener() {} close() {} };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => workspace });
  window.localStorage.setItem("kuryeTakipCourierToken", "quick-action-token");
  window.eval(bridge);
  await delay(80);

  const managerButton = [...window.document.querySelectorAll("button")].find((button) => button.querySelector(".material-symbols-outlined")?.textContent.trim() === "phone_in_talk");
  assert.ok(managerButton);
  assert.equal(managerButton.getAttribute("aria-label"), "Yöneticiyi 0531 466 89 27 numarasından ara");
  assert.ok(managerButton.closest(".delivera-side-menu").classList.contains("is-collapsed"));
  assert.equal(window.document.querySelector("[data-delivera-history-pill]"), null);
  assert.match(bridge, /05314668927/);
  dom.window.close();
});

test("courier pool quick action shows unassigned packages and claims through the pool API", async () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "courier-design-source", "ana_harita_ekran", "code.html"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "courier-design-bridge.js"), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:3000/courier.html", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const requests = [];
  const poolPackage = {
    id: "pkg_pool_ui",
    trackingNo: "PKT-POOL-UI",
    status: "awaiting_assignment",
    restaurantName: "Havuz UI Restoran",
    recipient: "Havuz UI Müşteri",
    deliveryAddress: "Havuz teslimat adresi",
    paymentMethod: "Nakit",
  };
  const workspace = {
    courier: { id: "cr_pool_ui", name: "Havuz UI Kurye", available: true, activeLoad: 0, latitude: 36.81, longitude: 34.64 },
    packages: [], poolPackages: [poolPackage], poolCapacity: 2, poolAvailableSlots: 2,
    historyPackages: [], notifications: [], dayMetrics: {}, earningsSummary: { today: {}, last7Days: {} }, reportSummary: { daily: {} }, shiftSummary: {},
  };
  const claimedWorkspace = {
    ...workspace,
    courier: { ...workspace.courier, activeLoad: 1 },
    packages: [{ ...poolPackage, status: "accepted_by_courier", assignedCourierId: "cr_pool_ui" }],
    poolPackages: [],
    poolAvailableSlots: 1,
  };
  const leafletMap = {
    setView() { return this; }, fitBounds() { return this; }, panInside() { return this; }, invalidateSize() {}, getZoom() { return 15; },
  };
  window.L = {
    map: () => leafletMap,
    tileLayer: () => ({ addTo() {} }),
    marker: () => ({ addTo() { return this; }, setLatLng() {}, remove() {}, on() {} }),
    divIcon: (options) => options,
    latLng: (latitude, longitude) => ({ latitude, longitude }),
    latLngBounds: (points) => points,
  };
  window.EventSource = class { addEventListener() {} close() {} };
  window.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET" });
    const payload = String(url).includes("/api/courier/pool/pkg_pool_ui/claim") ? claimedWorkspace : workspace;
    return { ok: true, status: 200, json: async () => payload };
  };
  window.localStorage.setItem("kuryeTakipCourierToken", "pool-ui-token");
  window.eval(bridge);
  await delay(80);

  const poolButtons = [...window.document.querySelectorAll("*")]
    .filter((node) => node.children.length === 0 && node.textContent.trim() === "Havuz")
    .map((node) => node.closest("button"))
    .filter(Boolean);
  const poolButton = poolButtons.find((button) => button.querySelector(".absolute.-top-2")?.textContent === "1") || poolButtons[0];
  assert.ok(poolButton, "Havuz hızlı işlem düğmesi bulunamadı");
  assert.ok(poolButtons.some((button) => button.querySelector(".absolute.-top-2")?.textContent === "1"));
  poolButton.click();
  const modal = window.document.querySelector(".delivera-modal");
  assert.ok(modal);
  assert.match(modal.textContent, /Atanmamış Paket Havuzu/);
  assert.match(modal.textContent, /Havuz UI Restoran/);
  assert.match(modal.textContent, /Havuzdan 2 paket daha alabilirsiniz/);

  const claim = [...modal.querySelectorAll("button")].find((button) => button.textContent.includes("Havuzdan Al"));
  assert.ok(claim);
  claim.click();
  await delay(80);
  assert.ok(requests.some((request) => request.url.includes("/api/courier/pool/pkg_pool_ui/claim") && request.method === "POST"));
  assert.equal(window.document.querySelector(".delivera-modal"), null);
  dom.window.close();
});
