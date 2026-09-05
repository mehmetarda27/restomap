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
  assert.match(source, /package-location-warning/);
  assert.match(source, /konum doğru olmayabilir/i);
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

test("courier navigation follows the package flow without changing its status", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "courier-design-bridge.js"), "utf8");
  const start = source.indexOf("function validMapCoordinates");
  const end = source.indexOf("\n  function liveMapBounds", start);
  assert.ok(start >= 0 && end > start, "navigation target helpers are missing");

  const helpers = new Function(`${source.slice(start, end)}; return { navigationTargetForPackages, navigationRouteUrl, externalNavigationUrl, directDistanceKm };`)();
  const pkg = {
    id: "pkg-navigation",
    status: "accepted_by_courier",
    restaurantName: "Rota Restoran",
    restaurantLat: 36.800001,
    restaurantLng: 34.600001,
    recipient: "Rota Müşteri",
    customerLat: 36.810001,
    customerLng: 34.610001,
  };

  const restaurantTarget = helpers.navigationTargetForPackages([pkg]);
  assert.equal(restaurantTarget.type, "restaurant");
  assert.equal(restaurantTarget.name, "Rota Restoran");
  assert.equal(pkg.status, "accepted_by_courier", "target selection must not mutate package status");

  const customerTarget = helpers.navigationTargetForPackages([{ ...pkg, status: "on_route" }]);
  assert.equal(customerTarget.type, "customer");
  assert.equal(customerTarget.name, "Rota Müşteri");
  assert.match(helpers.navigationRouteUrl({ latitude: 36.79, longitude: 34.59 }, customerTarget), /34\.590000,36\.790000;34\.610001,36\.810001/);
  assert.match(decodeURIComponent(helpers.externalNavigationUrl(customerTarget)), /destination=36\.810001,34\.610001/);
  assert.ok(helpers.directDistanceKm({ latitude: 36.8, longitude: 34.6 }, customerTarget) > 0);

  const prioritized = helpers.navigationTargetForPackages([
    pkg,
    { ...pkg, id: "pkg-on-road", status: "on_route", recipient: "Öncelikli Müşteri" },
  ]);
  assert.equal(prioritized.type, "customer");
  assert.equal(prioritized.name, "Öncelikli Müşteri");
  assert.match(source, /window\.open\(href, "_blank", "noopener,noreferrer"\)/);
  assert.match(source, /void updateNavigationRoute\(L, \{ latitude: safeLat, longitude: safeLon \}\)/);
});
