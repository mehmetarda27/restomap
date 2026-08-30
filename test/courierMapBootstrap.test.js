const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

test("courier map does not render the old mock map layer before Leaflet starts", () => {
  const root = path.join(__dirname, "..");
  const files = [
    path.join(root, "courier.html"),
    path.join(root, "courier-design-source", "ana_harita_ekran", "code.html"),
  ];

  for (const file of files) {
    const dom = new JSDOM(fs.readFileSync(file, "utf8"));
    const map = dom.window.document.querySelector(".map-bg");
    assert.ok(map, `${path.basename(file)} map canvas is missing`);
    assert.equal(map.childElementCount, 0, `${path.basename(file)} still contains a mock map layer`);
    dom.window.close();
  }
});

test("courier bridge keeps the open shift alive and retries location after returning from background", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "courier-design-bridge.js"), "utf8");
  assert.match(source, /setInterval\(pushLiveLocationHeartbeat, 20_000\)/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /addEventListener\("focus", pushLiveLocationHeartbeat\)/);
  assert.match(source, /addEventListener\("online", pushLiveLocationHeartbeat\)/);
  assert.match(source, /locationOnly:\s*true/);
});

test("courier map switches each package from restaurant to customer after departure", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "courier-design-bridge.js"), "utf8");
  const start = source.indexOf("function validMapCoordinates");
  const end = source.indexOf("\n  function liveMapBounds", start);
  assert.ok(start >= 0 && end > start, "map target helpers are missing");

  const helpers = new Function(`${source.slice(start, end)}; return { packageMapPoints };`)();
  const basePackage = {
    id: "pkg-map-switch",
    restaurantId: "rst-map-switch",
    restaurantName: "Test Restoran",
    restaurantLat: 36.8,
    restaurantLng: 34.6,
    recipient: "Test Müşteri",
    customerLat: 36.81,
    customerLng: 34.61,
  };

  assert.deepEqual(helpers.packageMapPoints([{ ...basePackage, status: "accepted_by_courier" }]), [{
    latitude: 36.8,
    longitude: 34.6,
    type: "restaurant",
    name: "Test Restoran",
    packageCount: 1,
  }]);
  assert.deepEqual(helpers.packageMapPoints([{ ...basePackage, status: "on_route" }]), [{
    latitude: 36.81,
    longitude: 34.61,
    type: "customer",
    name: "Test Müşteri",
    packageCount: 1,
  }]);
  assert.equal(helpers.packageMapPoints([{ ...basePackage, status: "on_route", customerLat: null, customerLng: null }])[0].type, "restaurant");
  assert.match(source, /destinationKey !== lastDestinationMapKey/);
  assert.match(source, /leafletMap\.fitBounds/);
});
