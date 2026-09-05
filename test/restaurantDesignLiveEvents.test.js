const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const rootDir = path.resolve(__dirname, "..");

function jsonResponse(payload) {
  return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => payload };
}

test("new restaurant design filters closed orders and subscribes to named live events", async () => {
  const eventTypes = new Set();
  const desktopPrints = [];
  const desktopNotifications = [];
  const alarmOscillators = [];
  const alarmGains = [];
  class FakeAudioContext {
    constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = "running"; return Promise.resolve(); }
    createGain() {
      const values = [];
      alarmGains.push(values);
      return {
        gain: {
          setValueAtTime(value) { values.push(value); },
          exponentialRampToValueAtTime(value) { values.push(value); },
        },
        connect(target) { return target; },
      };
    }
    createOscillator() {
      const oscillator = {
        frequency: { value: 0 }, type: "sine", stopCalls: 0,
        connect(target) { return target; }, disconnect() {}, start() {},
        stop() { this.stopCalls += 1; },
      };
      alarmOscillators.push(oscillator);
      return oscillator;
    }
  }
  class FakeEventSource {
    addEventListener(type) { eventTypes.add(type); }
    close() {}
  }
  const html = fs.readFileSync(path.join(rootDir, "restaurant-design-source", "code.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/restaurant-panel", pretendToBeVisual: true });
  try {
    dom.window.__DELIVERA_TEST__ = true;
    dom.window.AudioContext = FakeAudioContext;
    dom.window.EventSource = FakeEventSource;
    dom.window.deliveraDesktop = {
      autoPrintReceipt: async (payload) => { desktopPrints.push(payload); return { ok: true }; },
      showNotification: async (payload) => { desktopNotifications.push(payload); return { ok: true }; },
    };
    dom.window.localStorage.setItem("deliveraRestaurantToken", "test-token");
    dom.window.fetch = async () => jsonResponse({ packages: [], couriers: [], restaurants: [] });
    dom.window.eval(fs.readFileSync(path.join(rootDir, "restaurant-design-bridge.js"), "utf8"));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 30));

    const ordersTable = dom.window.document.querySelector("#restaurantOrders")?.closest("table");
    assert.ok(ordersTable?.classList.contains("zg-orders-table"));
    assert.ok(ordersTable?.parentElement?.classList.contains("zg-orders-card"));
    assert.match(dom.window.document.head.textContent, /\.zg-orders-table\{[^}]*table-layout:fixed/);

    const hooks = dom.window.__restaurantDesignTest;
    assert.equal(hooks.platformKey("ty"), "trendyol");
    assert.equal(hooks.platformKey("Trendyol Yemek"), "trendyol");
    assert.equal(hooks.platformKey("gy"), "getir");
    assert.equal(hooks.platformKey("my"), "migros");
    assert.equal(hooks.platformKey("ys"), "yemeksepeti");
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const today = new Date().toISOString();
    hooks.hydrate({
      packages: [
        { id: "pkg_active", trackingNo: "PKT-ACTIVE", status: "on_route", sourcePlatform: "Trendyol Yemek", updatedAt: yesterday, items: [{ name: "Tantuni", quantity: 2, price: 125, extraIngredients: [{ name: "Kaşar" }], note: "Acısız" }] },
        { id: "pkg_delivered", trackingNo: "PKT-DELIVERED", status: "delivered", sourcePlatform: "Yemeksepeti", deliveredAt: today },
        { id: "pkg_old", trackingNo: "PKT-OLD", status: "delivered", sourcePlatform: "Yemeksepeti", deliveredAt: yesterday },
      ],
      couriers: [],
      restaurants: [],
    });
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(desktopPrints.length, 1);
    assert.equal(desktopPrints[0].packageId, "pkg_active");
    assert.match(desktopPrints[0].html, /SİPARİŞ İÇERİĞİ|SÄ°PARÄ°Å Ä°Ã‡ERÄ°ÄÄ°/);
    assert.doesNotMatch(desktopPrints[0].html, /window\.print/);
    assert.equal(desktopNotifications.length, 1);
    const platformAttention = dom.window.document.querySelector(".zg-platform-attention-root");
    assert.ok(platformAttention);
    assert.match(platformAttention.textContent, /Trendyol/);
    assert.match(platformAttention.textContent, /PKT-ACTIVE/);
    assert.match(platformAttention.textContent, /yalnızca uyarıyı kapatır/);
    assert.ok(alarmOscillators.length >= 8, "uzun alarm dizisi kurulmalı");
    assert.ok(alarmGains.some((values) => values.includes(0.38)), "alarm sesi yüksek kazanç kullanmalı");
    platformAttention.querySelector("[data-platform-seen]").click();
    assert.equal(dom.window.document.querySelector(".zg-platform-attention-root"), null);
    assert.ok(alarmOscillators.every((oscillator) => oscillator.stopCalls >= 2), "Gördüm aktif alarm seslerini durdurmalı");
    assert.match(dom.window.localStorage.getItem("restomapRestaurantPlatformAttentionAcknowledged"), /pkg_active/);
    hooks.hydrate({
      packages: [{ id: "pkg_phone", trackingNo: "PKT-PHONE", status: "pending", source: "phone", createdAt: today }],
      couriers: [],
      restaurants: [],
    });
    assert.equal(dom.window.document.querySelector(".zg-platform-attention-root"), null);
    hooks.hydrate({
      packages: [
        { id: "pkg_active", trackingNo: "PKT-ACTIVE", status: "on_route", sourcePlatform: "Trendyol Yemek", updatedAt: yesterday, items: [{ name: "Tantuni", quantity: 2, price: 125, extraIngredients: [{ name: "Kaşar" }], note: "Acısız" }] },
        { id: "pkg_delivered", trackingNo: "PKT-DELIVERED", status: "delivered", sourcePlatform: "Yemeksepeti", deliveredAt: today },
        { id: "pkg_old", trackingNo: "PKT-OLD", status: "delivered", sourcePlatform: "Yemeksepeti", deliveredAt: yesterday },
      ],
      couriers: [],
      restaurants: [],
    });
    hooks.state.filter = "active";
    assert.deepEqual(Array.from(hooks.currentPackages(), (pkg) => pkg.id), ["pkg_active"]);
    hooks.state.filter = "all";
    assert.deepEqual(Array.from(hooks.currentPackages(), (pkg) => pkg.id), ["pkg_active", "pkg_delivered"]);
    const actionLabels = Array.from(dom.window.document.querySelectorAll("#restaurantOrders [data-action]"), (button) => button.textContent.trim());
    ["Yazdır", "Zaman", "Sipariş Detayı"].forEach((label) => assert.ok(actionLabels.includes(label), label));
    assert.equal(actionLabels.includes("Faturalı Fiş"), false);
    dom.window.document.querySelector('#restaurantOrders button[data-action="detail"]').click();
    const detailModalText = dom.window.document.querySelector(".zg-modal-root")?.textContent || "";
    assert.match(detailModalText, /PKT-ACTIVE/);
    assert.match(detailModalText, /2× Tantuni/);
    assert.match(detailModalText, /Ekstra: Kaşar/);
    assert.match(detailModalText, /Not: Acısız/);
    let mapClick;
    let correctionRequest;
    const savedData = hooks.state.data;
    const fakeMap = { setView() { return this; }, on(name, fn) { if (name === 'click') mapClick = fn; }, remove() {} };
    dom.window.L = { map: () => fakeMap, tileLayer: () => ({ addTo() {} }), marker: () => ({ addTo() { return this; }, setLatLng() {} }) };
    const priorFetch = dom.window.fetch;
    dom.window.fetch = async (url, options) => {
      if (String(url).includes('/delivery-point')) correctionRequest = { url, options };
      return jsonResponse(savedData);
    };
    dom.window.document.querySelector('[data-edit-point]').click();
    assert.equal(dom.window.document.querySelector('[data-point-save]').disabled, true);
    mapClick({ latlng: { lat: 36.815, lng: 34.625 } });
    dom.window.document.querySelector('[data-point-save]').click();
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.match(correctionRequest.url, /pkg_active\/delivery-point$/);
    assert.equal(correctionRequest.options.method, 'PATCH');
    assert.deepEqual(JSON.parse(correctionRequest.options.body), { latitude: 36.815, longitude: 34.625 });
    dom.window.fetch = priorFetch;
    dom.window.document.querySelector(".zg-modal-root [data-close]")?.click();
    dom.window.document.querySelector('#restaurantOrders [data-action="print"]').click();
    const printModal = dom.window.document.querySelector(".zg-modal-root");
    assert.ok(printModal);
    assert.equal(printModal.querySelectorAll("[data-print-size]").length, 3);
    printModal.querySelector("[data-save-print-default]").checked = false;
    printModal.querySelector('[data-print-size="58mm"]').click();
    const printFrame = dom.window.document.querySelector(".zg-browser-print-frame");
    assert.ok(printFrame, "manuel baskı popup yerine sayfa içi baskı çerçevesi oluşturmalı");
    const printedHtml = printFrame.srcdoc;
    assert.match(printedHtml, /@page\{size:58mm auto/);
    assert.match(printedHtml, /RESTOMAP/);
    assert.match(printedHtml, /RESTOMAP altyapısıyla yönetilmektedir/);
    assert.match(printedHtml, /SİPARİŞ İÇERİĞİ/);
    assert.match(printedHtml, /2× Tantuni/);
    assert.match(printedHtml, /Birim: 125,00 ₺/);
    assert.match(printedHtml, /250,00 ₺/);
    assert.match(printedHtml, /Ekstra: Kaşar/);
    assert.match(printedHtml, /Not: Acısız/);
    assert.doesNotMatch(printedHtml, /window\.print/);
    hooks.connectStream();
    ["order:new", "package-created", "package-assigned", "package-status", "courier-location", "courier-availability", "workspace-update"].forEach((type) => assert.ok(eventTypes.has(type), type));

    hooks.state.data.couriers = [
      { id: "online", status: "online", available: true, latitude: 36.81, longitude: 34.64, lastLocationAt: today },
      { id: "offline", status: "offline", available: false, latitude: 36.81, longitude: 34.64, lastLocationAt: today },
      { id: "stale", status: "online", available: true, latitude: 36.81, longitude: 34.64, lastLocationAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
    ];
    assert.deepEqual(
      Array.from(hooks.restaurantLiveMapCouriers({ latitude: 36.8121, longitude: 34.6415 }), (courier) => courier.id),
      ["online"],
    );

    dom.window.localStorage.setItem("deliveraRestaurantRefreshToken", "legacy-refresh");
    dom.window.localStorage.setItem("deliveraRestaurantId", "legacy-id");
    dom.window.localStorage.setItem("deliveraRestaurantApiKey", "legacy-api-key");
    const logoutLink = Array.from(dom.window.document.querySelectorAll("aside a"))
      .find((link) => link.textContent.includes("Çıkış Yap"));
    assert.ok(logoutLink, "restoran çıkış bağlantısı bulunmalı");
    logoutLink.click();
    [
      "restomapRestaurantToken",
      "restomapRestaurantRefreshToken",
      "restomapRestaurantId",
      "restomapRestaurantApiKey",
      "deliveraRestaurantToken",
      "deliveraRestaurantRefreshToken",
      "deliveraRestaurantId",
      "deliveraRestaurantApiKey",
    ].forEach((key) => assert.equal(dom.window.localStorage.getItem(key), null, `${key} çıkışta silinmeli`));
  } finally {
    dom.window.close();
  }
});
