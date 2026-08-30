const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/bootstrap`);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(150);
  }
  throw new Error("Test server did not start in time.");
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(`${route} -> ${response.status}: ${body.error || body.message || "request failed"}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function readRow(dbFile, sql, ...params) {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

function runSql(dbFile, sql, ...params) {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("panel create/update/delete flows persist to database tables", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-panel-persistence-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 34000 + (process.pid % 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `admin_${Date.now()}`;
  const adminPassword = "Delivera123!";
  const restaurantUsername = `rest_${Date.now()}`;
  const restaurantPassword = "Rest12345!";
  const secondRestaurantUsername = `rest2_${Date.now()}`;
  const secondRestaurantPassword = "Rest22345!";
  const yemeksepetiRestaurantId = `ys-${Date.now()}`;
  const posentegraRestaurantId = "6377deac15d5d59aee02bf51";
  const posentegraPid = "a7j7-2619-ni3r";

  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      DATABASE_URL: "",
      POSTGRES_URL: "",
      DATABASE_PATH: dbFile,
      DB_PATH: dbFile,
      DELIVERA_DB_FILE: dbFile,
      DELIVERA_ADMIN_USERNAME: adminUsername,
      DELIVERA_ADMIN_PASSWORD: adminPassword,
      DELIVERA_INTEGRATION_KEY: "test-integration-key",
      WEBHOOK_SECRET: "test-webhook-secret",
      WEBHOOK_ENABLED: "true",
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  try {
    await waitForServer(baseUrl);

    const publicBootstrap = await request(baseUrl, "/api/bootstrap");
    assert.ok(publicBootstrap.stats);
    assert.equal(publicBootstrap.restaurants, undefined);
    assert.equal(publicBootstrap.packages, undefined);
    assert.equal(publicBootstrap.platformOrders, undefined);
    assert.equal(publicBootstrap.webhookLogs, undefined);

    const adminLogin = await request(baseUrl, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    let adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };
    const refreshedAdmin = await request(baseUrl, "/api/admin/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: adminLogin.refreshToken }),
    });
    assert.ok(refreshedAdmin.token);
    assert.ok(refreshedAdmin.refreshToken);
    adminHeaders = { Authorization: `Bearer ${refreshedAdmin.token}` };
    const refreshedAdminBootstrap = await request(baseUrl, "/api/admin/bootstrap", {
      headers: { Authorization: `Bearer ${refreshedAdmin.token}` },
    });
    assert.ok(Array.isArray(refreshedAdminBootstrap.restaurants));

    await assert.rejects(
      () => request(baseUrl, "/api/admin/restaurants", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          name: "Invalid Coordinate Restaurant",
          portalUsername: `invalid_${Date.now()}`,
          portalPassword: "Invalid123!",
          zone: "Erdemli",
          latitude: 5654656,
          longitude: 545484,
        }),
      }),
      (error) => error.status === 400 && error.body.error === "Restoran koordinatlari gecersiz."
    );

    await assert.rejects(
      () => request(baseUrl, "/api/admin/couriers", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          name: "Invalid Coordinate Courier",
          username: `invalid_courier_${Date.now()}`,
          password: "Invalid123!",
          zone: "Erdemli",
          latitude: 13123131,
          longitude: 48485544,
        }),
      }),
      (error) => error.status === 400 && error.body.error === "Kurye koordinatlari gecersiz."
    );

    const restaurantState = await request(baseUrl, "/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Persistence Test Restaurant",
        portalUsername: restaurantUsername,
        portalPassword: restaurantPassword,
        zone: "Erdemli",
        latitude: 36.601,
        longitude: 34.32,
        platforms: ["Getir Yemek"],
        yemeksepetiRestaurantId,
        posentegraId: posentegraRestaurantId,
        externalRestaurantIds: JSON.stringify([{ platform: "other", restaurantId: `other-${Date.now()}` }]),
      }),
    });
    assert.ok(restaurantState.createdRestaurant?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM restaurants WHERE id = ?", restaurantState.createdRestaurant.id));

    const secondRestaurantState = await request(baseUrl, "/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Second Persistence Test Restaurant",
        portalUsername: secondRestaurantUsername,
        portalPassword: secondRestaurantPassword,
        zone: "Mezitli",
        latitude: 36.75,
        longitude: 34.55,
        platforms: ["POS"],
        getirRestaurantId: `getir-${Date.now()}`,
      }),
    });
    assert.ok(secondRestaurantState.createdRestaurant?.id);
    assert.notEqual(secondRestaurantState.createdRestaurant.id, restaurantState.createdRestaurant.id);
    assert.ok(readRow(dbFile, "SELECT id FROM restaurants WHERE id = ?", secondRestaurantState.createdRestaurant.id));
    assert.equal(
      readRow(dbFile, "SELECT yemeksepeti_restaurant_id FROM restaurants WHERE id = ?", restaurantState.createdRestaurant.id).yemeksepeti_restaurant_id,
      restaurantState.createdRestaurant.yemeksepetiRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT getir_restaurant_id FROM restaurants WHERE id = ?", secondRestaurantState.createdRestaurant.id).getir_restaurant_id,
      secondRestaurantState.createdRestaurant.getirRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT posentegra_id FROM restaurants WHERE id = ?", restaurantState.createdRestaurant.id).posentegra_id,
      posentegraRestaurantId
    );

    const updatedLatitude = 36.612345;
    const updatedLongitude = 34.323456;
    const locationUpdateState = await request(baseUrl, `/api/admin/restaurants/${restaurantState.createdRestaurant.id}/location`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ latitude: updatedLatitude, longitude: updatedLongitude }),
    });
    assert.equal(locationUpdateState.restaurant.latitude, updatedLatitude);
    assert.equal(locationUpdateState.restaurant.longitude, updatedLongitude);
    const persistedRestaurantLocation = readRow(dbFile, "SELECT x, y FROM restaurants WHERE id = ?", restaurantState.createdRestaurant.id);
    assert.equal(persistedRestaurantLocation.x, updatedLatitude);
    assert.equal(persistedRestaurantLocation.y, updatedLongitude);
    const bootstrapAfterLocationUpdate = await request(baseUrl, "/api/admin/bootstrap", { headers: adminHeaders });
    const updatedBootstrapRestaurant = bootstrapAfterLocationUpdate.restaurants.find((item) => item.id === restaurantState.createdRestaurant.id);
    assert.equal(updatedBootstrapRestaurant.latitude, updatedLatitude);
    assert.equal(updatedBootstrapRestaurant.longitude, updatedLongitude);

    await assert.rejects(
      () => request(baseUrl, `/api/admin/restaurants/${restaurantState.createdRestaurant.id}/location`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ latitude: 999, longitude: updatedLongitude }),
      }),
      (error) => error.status === 400 && error.body.error === "Restoran koordinatlari gecersiz."
    );
    const locationAfterRejectedUpdate = readRow(dbFile, "SELECT x, y FROM restaurants WHERE id = ?", restaurantState.createdRestaurant.id);
    assert.equal(locationAfterRejectedUpdate.x, updatedLatitude);
    assert.equal(locationAfterRejectedUpdate.y, updatedLongitude);

    const courierState = await request(baseUrl, "/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Persistence Courier",
        username: `courier_${Date.now()}`,
        password: "Kurye123!",
        zone: "Erdemli",
        latitude: 36.602,
        longitude: 34.321,
        available: true,
      }),
    });
    assert.ok(courierState.createdCourier?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM couriers WHERE id = ?", courierState.createdCourier.id));

    await request(baseUrl, `/api/admin/couriers/${courierState.createdCourier.id}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Persistence Courier Updated",
        username: courierState.createdCourier.username,
        zone: "Erdemli",
      }),
    });
    assert.equal(
      readRow(dbFile, "SELECT name FROM couriers WHERE id = ?", courierState.createdCourier.id).name,
      "Persistence Courier Updated"
    );

    const deleteCourierState = await request(baseUrl, "/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Delete Persistence Courier",
        username: `delete_courier_${Date.now()}`,
        password: "Kurye123!",
        zone: "Erdemli",
        latitude: 36.603,
        longitude: 34.322,
        available: false,
      }),
    });
    const deleteCourierId = deleteCourierState.createdCourier.id;
    const relatedStamp = new Date().toISOString();
    runSql(
      dbFile,
      "INSERT INTO courier_breaks (id, courier_id, started_at, ended_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "break_delete_test",
      deleteCourierId,
      relatedStamp,
      relatedStamp,
      relatedStamp,
      relatedStamp
    );
    runSql(
      dbFile,
      `INSERT INTO courier_earnings (
        id, courier_id, report_date, delivered_package_count, per_package_fee, bonus_amount,
        deduction_amount, total_payable, payment_status, paid_at, admin_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "earning_delete_test",
      deleteCourierId,
      relatedStamp.slice(0, 10),
      0,
      0,
      0,
      0,
      0,
      "unpaid",
      null,
      "Silme bağımlılık testi",
      relatedStamp,
      relatedStamp
    );
    runSql(
      dbFile,
      "INSERT INTO courier_push_subscriptions (id, courier_id, endpoint, subscription_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "push_delete_test",
      deleteCourierId,
      "https://push.example/delete-test",
      JSON.stringify({ endpoint: "https://push.example/delete-test", keys: { p256dh: "test", auth: "test" } }),
      relatedStamp,
      relatedStamp
    );
    await request(baseUrl, `/api/admin/couriers/${deleteCourierState.createdCourier.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    assert.equal(readRow(dbFile, "SELECT id FROM couriers WHERE id = ?", deleteCourierId), undefined);
    assert.equal(readRow(dbFile, "SELECT id FROM courier_breaks WHERE courier_id = ?", deleteCourierId), undefined);
    assert.equal(readRow(dbFile, "SELECT id FROM courier_earnings WHERE courier_id = ?", deleteCourierId), undefined);
    assert.equal(readRow(dbFile, "SELECT id FROM courier_push_subscriptions WHERE courier_id = ?", deleteCourierId), undefined);

    const restaurantLogin = await request(baseUrl, "/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({ username: restaurantUsername, password: restaurantPassword }),
    });
    let restaurantHeaders = { Authorization: `Bearer ${restaurantLogin.token}` };
    const refreshedRestaurant = await request(baseUrl, "/api/restaurant/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: restaurantLogin.refreshToken }),
    });
    assert.ok(refreshedRestaurant.token);
    const refreshedRestaurantHeaders = { Authorization: `Bearer ${refreshedRestaurant.token}` };
    restaurantHeaders = refreshedRestaurantHeaders;
    const refreshedRestaurantBootstrap = await request(baseUrl, "/api/restaurant/bootstrap", {
      headers: refreshedRestaurantHeaders,
    });
    assert.equal(refreshedRestaurantBootstrap.restaurants[0].id, restaurantState.createdRestaurant.id);

    const platformOrderId = `PLATFORM-${Date.now()}`;
    const platformOrderState = await request(baseUrl, "/platform-orders", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        platform: "POS",
        orderId: platformOrderId,
        customerName: "Platform Persistence Customer",
        phone: "5554443322",
        address: "Platform persistence address",
        totalPrice: 210,
        paymentMethod: "CARD",
        note: "platform_orders persistence test",
      }),
    });
    assert.ok(platformOrderState.package?.id);
    assert.equal(platformOrderState.package.paymentMethodCode, "card_on_delivery");
    assert.equal(platformOrderState.package.paymentStatus, "credit_card");
    assert.ok(platformOrderState.platformOrder?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM packages WHERE id = ?", platformOrderState.package.id));
    assert.ok(readRow(dbFile, "SELECT id FROM platform_orders WHERE id = ?", platformOrderState.platformOrder.id));
    assert.ok(
      readRow(dbFile, "SELECT id FROM platform_orders WHERE platform_order_id = ?", platformOrderId)
    );

    const packageState = await request(baseUrl, "/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: restaurantState.createdRestaurant.id,
        deliveryAddress: "Persistence mahallesi no 1 Erdemli",
        packageType: "Test Paket",
        orderAmount: 125,
        customerName: "Persistence Customer",
        phone: "5551112233",
        customerNote: "DB persistence test",
        paymentMethod: "Panel Kaydi",
      }),
    });
    assert.ok(packageState.createdPackage?.id);
    assert.ok(readRow(dbFile, "SELECT id FROM packages WHERE id = ?", packageState.createdPackage.id));
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", packageState.createdPackage.id).restaurant_id,
      restaurantState.createdRestaurant.id
    );
    assert.ok(
      readRow(dbFile, "SELECT posentegra_id FROM packages WHERE id = ?", packageState.createdPackage.id).posentegra_id
    );
    const bootstrapWithPackage = await request(baseUrl, "/api/admin/bootstrap", { headers: adminHeaders });
    const packageAfterRestaurantLocationUpdate = bootstrapWithPackage.packages.find((item) => item.id === packageState.createdPackage.id);
    assert.equal(packageAfterRestaurantLocationUpdate.restaurantLat, updatedLatitude);
    assert.equal(packageAfterRestaurantLocationUpdate.restaurantLng, updatedLongitude);

    const courierLogin = await request(baseUrl, "/api/courier/login", {
      method: "POST",
      body: JSON.stringify({ username: courierState.createdCourier.username, password: "Kurye123!" }),
    });
    assert.ok(courierLogin.token);
    const refreshedCourier = await request(baseUrl, "/api/courier/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: courierLogin.refreshToken }),
    });
    assert.ok(refreshedCourier.token);
    const refreshedCourierWorkspace = await request(baseUrl, "/api/courier/me", {
      headers: { Authorization: `Bearer ${refreshedCourier.token}` },
    });
    assert.equal(refreshedCourierWorkspace.courier.id, courierState.createdCourier.id);
    const courierWorkspace = await request(baseUrl, "/api/courier/me", {
      headers: { Authorization: `Bearer ${refreshedCourier.token}` },
    });
    assert.equal(courierWorkspace.courier.id, courierState.createdCourier.id);
    assert.ok(courierWorkspace.dayMetrics);
    assert.ok(courierWorkspace.mapsConfig);

    await assert.rejects(
      () => request(baseUrl, `/api/admin/packages/${packageState.createdPackage.id}/status`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ status: "not_a_real_status" }),
      }),
      (error) => error.status === 400 && /Gecersiz paket durumu/.test(error.body.error)
    );

    const lifecycleCourierState = await request(baseUrl, "/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Lifecycle Persistence Courier",
        username: `lifecycle_courier_${Date.now()}`,
        password: "Kurye123!",
        zone: "Erdemli",
        latitude: 36.604,
        longitude: 34.323,
        available: true,
      }),
    });
    assert.ok(lifecycleCourierState.createdCourier?.id);
    const setupDb = new DatabaseSync(dbFile);
    try {
      setupDb.prepare("UPDATE packages SET assigned_courier_id = NULL, assigned_courier_name = NULL, assigned_at = NULL, status = 'awaiting_assignment', assignment_status = 'pending' WHERE assigned_courier_id = ? AND id != ?")
        .run(lifecycleCourierState.createdCourier.id, packageState.createdPackage.id);
      setupDb.prepare("UPDATE couriers SET available = 1, status = 'online' WHERE id = ?").run(lifecycleCourierState.createdCourier.id);
    } finally {
      setupDb.close();
    }

    await request(baseUrl, `/api/admin/packages/${packageState.createdPackage.id}/override`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ courierId: lifecycleCourierState.createdCourier.id }),
    });
    const assignedPackageRow = readRow(
      dbFile,
      "SELECT status, assignment_status, assigned_courier_id, assigned_courier_name FROM packages WHERE id = ?",
      packageState.createdPackage.id
    );
    assert.equal(assignedPackageRow.status, "assigned");
    assert.equal(assignedPackageRow.assignment_status, "assigned");
    assert.equal(assignedPackageRow.assigned_courier_id, lifecycleCourierState.createdCourier.id);
    assert.ok(assignedPackageRow.assigned_courier_name);

    const assignedAdminState = await request(baseUrl, "/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    assert.equal(
      assignedAdminState.packages.find((pkg) => pkg.id === packageState.createdPackage.id)?.assignedCourierId,
      lifecycleCourierState.createdCourier.id
    );

    const lifecycleCourierLogin = await request(baseUrl, "/api/courier/login", {
      method: "POST",
      body: JSON.stringify({ username: lifecycleCourierState.createdCourier.username, password: "Kurye123!" }),
    });
    const lifecycleCourierHeaders = { Authorization: `Bearer ${lifecycleCourierLogin.token}` };
    const lifecycleCourierWorkspace = await request(baseUrl, "/api/courier/me", {
      headers: lifecycleCourierHeaders,
    });
    assert.equal(
      lifecycleCourierWorkspace.packages.find((pkg) => pkg.id === packageState.createdPackage.id)?.status,
      "assigned"
    );

    await assert.rejects(
      () => request(baseUrl, `/api/courier/packages/${packageState.createdPackage.id}/status`, {
        method: "PATCH",
        headers: lifecycleCourierHeaders,
        body: JSON.stringify({ status: "not_a_real_status" }),
      }),
      (error) => error.status === 400 && /Gecersiz paket durumu/.test(error.body.error)
    );

    await request(baseUrl, `/api/courier/packages/${packageState.createdPackage.id}/status`, {
      method: "PATCH",
      headers: lifecycleCourierHeaders,
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    assert.equal(
      readRow(dbFile, "SELECT status FROM packages WHERE id = ?", packageState.createdPackage.id).status,
      "accepted_by_courier"
    );

    runSql(
      dbFile,
      "UPDATE packages SET customer_lat = ?, customer_lng = ? WHERE id = ?",
      36.801,
      34.621,
      packageState.createdPackage.id
    );

    await request(baseUrl, `/api/courier/packages/${packageState.createdPackage.id}/status`, {
      method: "PATCH",
      headers: lifecycleCourierHeaders,
      body: JSON.stringify({ status: "on_route" }),
    });
    assert.equal(
      readRow(dbFile, "SELECT status FROM packages WHERE id = ?", packageState.createdPackage.id).status,
      "on_route"
    );

    const deliveredCourierWorkspace = await request(baseUrl, `/api/courier/packages/${packageState.createdPackage.id}/status`, {
      method: "PATCH",
      headers: lifecycleCourierHeaders,
      // Panel kaydi online odemedir; hatali kurye secimi backend tarafinda
      // canonical online duruma geri alinmalidir.
      body: JSON.stringify({ status: "delivered", paymentStatus: "cash_collected" }),
    });
    const deliveredPackageRow = readRow(
      dbFile,
      "SELECT status, assignment_status, payment_status, accepted_at, on_route_at, delivered_at FROM packages WHERE id = ?",
      packageState.createdPackage.id
    );
    assert.equal(deliveredPackageRow.status, "delivered");
    assert.equal(deliveredPackageRow.assignment_status, "assigned");
    assert.equal(deliveredPackageRow.payment_status, "paid_online");
    assert.ok(deliveredPackageRow.accepted_at);
    assert.ok(deliveredPackageRow.on_route_at);
    assert.ok(deliveredPackageRow.delivered_at);
    assert.ok(deliveredCourierWorkspace.historyPackages.some((pkg) => pkg.id === packageState.createdPackage.id && pkg.status === "delivered"));

    const deliveredAdminState = await request(baseUrl, "/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    assert.equal(
      deliveredAdminState.packages.find((pkg) => pkg.id === packageState.createdPackage.id)?.status,
      "delivered"
    );

    const archiveDateFrom = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();
    const archiveDateTo = new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString();
    const archivedOrders = await request(
      baseUrl,
      `/api/admin/orders?assignedOnly=true&dateFrom=${encodeURIComponent(archiveDateFrom)}&dateTo=${encodeURIComponent(archiveDateTo)}&search=${encodeURIComponent(packageState.createdPackage.trackingNo)}`,
      { headers: adminHeaders }
    );
    assert.equal(archivedOrders.pagination.total, 1);
    assert.equal(archivedOrders.orders.length, 1);
    assert.equal(archivedOrders.orders[0].id, packageState.createdPackage.id);
    assert.equal(archivedOrders.orders[0].status, "delivered");
    assert.equal(archivedOrders.orders[0].assignedCourierId, lifecycleCourierState.createdCourier.id);

    const secondRestaurantLogin = await request(baseUrl, "/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({ username: secondRestaurantUsername, password: secondRestaurantPassword }),
    });
    const secondRestaurantHeaders = { Authorization: `Bearer ${secondRestaurantLogin.token}` };
    const secondPackageState = await request(baseUrl, "/packages", {
      method: "POST",
      headers: secondRestaurantHeaders,
      body: JSON.stringify({
        restaurantId: restaurantState.createdRestaurant.id,
        deliveryAddress: "Second restaurant package address",
        packageType: "Second Test Paket",
        orderAmount: 175,
        customerName: "Second Restaurant Customer",
        phone: "5559998877",
        customerNote: "body restaurantId must be ignored",
        paymentMethod: "Panel Kaydi",
      }),
    });
    assert.ok(secondPackageState.createdPackage?.id);
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", secondPackageState.createdPackage.id).restaurant_id,
      secondRestaurantState.createdRestaurant.id
    );
    assert.ok(
      readRow(dbFile, "SELECT posentegra_id FROM packages WHERE id = ?", secondPackageState.createdPackage.id).posentegra_id
    );
    assert.equal(
      readRow(dbFile, "SELECT COUNT(DISTINCT restaurant_id) AS count FROM packages").count,
      2
    );
    assert.equal(
      readRow(dbFile, "SELECT COUNT(*) AS count FROM packages WHERE posentegra_id IS NULL OR posentegra_id = ''").count,
      0
    );

    const reloadedRestaurantState = await request(baseUrl, "/api/restaurant/bootstrap", {
      headers: restaurantHeaders,
    });
    assert.ok(reloadedRestaurantState.packages.some((pkg) => pkg.id === packageState.createdPackage.id));
    assert.equal(
      reloadedRestaurantState.packages.find((pkg) => pkg.id === packageState.createdPackage.id)?.status,
      "delivered"
    );
    assert.ok(!reloadedRestaurantState.packages.some((pkg) => pkg.id === secondPackageState.createdPackage.id));
    const reloadedSecondRestaurantState = await request(baseUrl, "/api/restaurant/bootstrap", {
      headers: secondRestaurantHeaders,
    });
    assert.ok(reloadedSecondRestaurantState.packages.some((pkg) => pkg.id === secondPackageState.createdPackage.id));
    assert.ok(!reloadedSecondRestaurantState.packages.some((pkg) => pkg.id === packageState.createdPackage.id));

    await assert.rejects(
      () => request(baseUrl, "/api/external/packages"),
      (error) => error.status === 401
    );

    const externalHeaders = { Authorization: "Bearer test-integration-key" };
    const externalRestaurants = await request(baseUrl, "/api/external/restaurants", {
      headers: externalHeaders,
    });
    assert.ok(externalRestaurants.some((item) =>
      item.id === restaurantState.createdRestaurant.id &&
      item.yemeksepetiRestaurantId === restaurantState.createdRestaurant.yemeksepetiRestaurantId &&
      item.posentegraId === posentegraRestaurantId
    ));

    const externalOrderOneId = `YS-${Date.now()}`;
    const externalOrderOne = await request(baseUrl, "/api/external/platform-orders", {
      method: "POST",
      headers: externalHeaders,
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: restaurantState.createdRestaurant.yemeksepetiRestaurantId,
        platformOrderId: externalOrderOneId,
        customerName: "External Customer One",
        customerPhone: "05550000001",
        deliveryAddress: "External address one",
        items: [{ name: "Lahmacun", quantity: 2, price: 120 }],
        totalAmount: 240,
        rawPayload: { source: "test" },
      }),
    });
    const externalOrderTwoId = `GETIR-${Date.now()}`;
    const externalOrderTwo = await request(baseUrl, "/api/external/platform-orders", {
      method: "POST",
      headers: externalHeaders,
      body: JSON.stringify({
        platform: "getir",
        platformRestaurantId: secondRestaurantState.createdRestaurant.getirRestaurantId,
        platformOrderId: externalOrderTwoId,
        customerName: "External Customer Two",
        customerPhone: "05550000002",
        deliveryAddress: "External address two",
        items: [{ name: "Burger", quantity: 1, price: 180 }],
        totalAmount: 180,
        rawPayload: { source: "test" },
      }),
    });
    const externalPosentegraPid = `POSENTEGRA-EXT-${Date.now()}`;
    const externalOrderByRestaurantId = await request(baseUrl, "/api/external/platform-orders", {
      method: "POST",
      headers: externalHeaders,
      body: JSON.stringify({
        platform: "yemeksepeti",
        restaurantId: posentegraRestaurantId,
        pid: externalPosentegraPid,
        platformOrderId: `POSENTEGRA-ORDER-${Date.now()}`,
        customerName: "External Posentegra Customer",
        customerPhone: "05550000006",
        deliveryAddress: "External Posentegra address",
        items: [{ name: "Pizza", quantity: 1, price: 260 }],
        totalAmount: 260,
        rawPayload: { restaurantId: posentegraRestaurantId, pid: externalPosentegraPid },
      }),
    });
    assert.equal(externalOrderOne.package.restaurantId, restaurantState.createdRestaurant.id);
    assert.equal(externalOrderTwo.package.restaurantId, secondRestaurantState.createdRestaurant.id);
    assert.equal(externalOrderByRestaurantId.package.restaurantId, restaurantState.createdRestaurant.id);
    assert.notEqual(externalOrderOne.package.restaurantId, externalOrderTwo.package.restaurantId);
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", externalOrderOne.package.id).restaurant_id,
      restaurantState.createdRestaurant.id
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM packages WHERE id = ?", externalOrderOne.package.id).platform_restaurant_id,
      restaurantState.createdRestaurant.yemeksepetiRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT posentegra_id FROM packages WHERE id = ?", externalOrderOne.package.id).posentegra_id,
      externalOrderOneId
    );
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", externalOrderTwo.package.id).restaurant_id,
      secondRestaurantState.createdRestaurant.id
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM packages WHERE id = ?", externalOrderTwo.package.id).platform_restaurant_id,
      secondRestaurantState.createdRestaurant.getirRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT posentegra_id FROM packages WHERE id = ?", externalOrderTwo.package.id).posentegra_id,
      externalOrderTwoId
    );
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", externalOrderByRestaurantId.package.id).restaurant_id,
      restaurantState.createdRestaurant.id
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM packages WHERE id = ?", externalOrderByRestaurantId.package.id).platform_restaurant_id,
      posentegraRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT posentegra_id FROM packages WHERE id = ?", externalOrderByRestaurantId.package.id).posentegra_id,
      externalPosentegraPid
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM platform_orders WHERE id = ?", externalOrderOne.platformOrder.id).platform_restaurant_id,
      restaurantState.createdRestaurant.yemeksepetiRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM platform_orders WHERE id = ?", externalOrderTwo.platformOrder.id).platform_restaurant_id,
      secondRestaurantState.createdRestaurant.getirRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT package_id FROM platform_orders WHERE id = ?", externalOrderOne.platformOrder.id).package_id,
      externalOrderOne.package.id
    );
    const externalPackageDetail = await request(baseUrl, `/api/external/packages/${externalOrderOne.package.id}`, {
      headers: externalHeaders,
    });
    assert.equal(externalPackageDetail.platformRestaurantId, restaurantState.createdRestaurant.yemeksepetiRestaurantId);
    assert.equal(externalPackageDetail.platformOrderId, externalOrderOne.platformOrder.platformOrderId);

    const webhookOrderId = `YS-WEBHOOK-${Date.now()}`;
    const webhookOrder = await request(baseUrl, "/api/webhooks/orders", {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify({
        provider: { slug: "ys" },
        restaurantId: yemeksepetiRestaurantId,
        restaurant: { id: yemeksepetiRestaurantId, name: "Persistence Test Restaurant" },
        orderId: webhookOrderId,
        customerName: "Webhook Customer",
        customerPhone: "05550000003",
        addressText: "Webhook address",
        totalPrice: 320,
        products: [{ id: "prod-1", name: "Kofte", quantity: 1, price: 320, totalPrice: 320 }],
      }),
    });
    assert.equal(webhookOrder.matched, true);
    assert.equal(webhookOrder.package.restaurantId, restaurantState.createdRestaurant.id);
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", webhookOrder.package.id).restaurant_id,
      restaurantState.createdRestaurant.id
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM packages WHERE id = ?", webhookOrder.package.id).platform_restaurant_id,
      yemeksepetiRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM platform_orders WHERE platform_order_id = ?", webhookOrderId).platform_restaurant_id,
      yemeksepetiRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT package_id FROM platform_orders WHERE platform_order_id = ?", webhookOrderId).package_id,
      webhookOrder.package.id
    );

    const posentegraPackageCountBefore = readRow(dbFile, "SELECT COUNT(*) AS count FROM packages").count;
    const posentegraWebhookBody = {
      provider: { slug: "ys", kaynak: "Yemek Sepeti" },
      pid: posentegraPid,
      restaurantId: posentegraRestaurantId,
      restaurant: { id: posentegraRestaurantId, name: "Persistence Test Restaurant" },
      customerName: "Posentegra Customer",
      customerPhone: "05550000005",
      addressText: "Posentegra webhook address",
      totalPrice: 410,
      products: [{ id: "prod-pos-1", name: "Sucuk", quantity: 1, price: 410, totalPrice: 410 }],
    };
    const posentegraWebhookOrder = await request(baseUrl, "/api/webhooks/orders", {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify(posentegraWebhookBody),
    });
    assert.equal(posentegraWebhookOrder.matched, true);
    assert.equal(posentegraWebhookOrder.package.restaurantId, restaurantState.createdRestaurant.id);
    assert.equal(
      readRow(dbFile, "SELECT restaurant_id FROM packages WHERE id = ?", posentegraWebhookOrder.package.id).restaurant_id,
      restaurantState.createdRestaurant.id
    );
    assert.equal(
      readRow(dbFile, "SELECT posentegra_id FROM packages WHERE id = ?", posentegraWebhookOrder.package.id).posentegra_id,
      posentegraPid
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM packages WHERE id = ?", posentegraWebhookOrder.package.id).platform_restaurant_id,
      posentegraRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT posentegra_id FROM platform_orders WHERE platform_order_id = ?", posentegraPid).posentegra_id,
      posentegraPid
    );
    assert.equal(
      readRow(dbFile, "SELECT platform_restaurant_id FROM platform_orders WHERE platform_order_id = ?", posentegraPid).platform_restaurant_id,
      posentegraRestaurantId
    );
    assert.equal(
      readRow(dbFile, "SELECT COUNT(*) AS count FROM packages").count,
      posentegraPackageCountBefore + 1
    );

    const posentegraDuplicate = await request(baseUrl, "/api/webhooks/orders", {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify(posentegraWebhookBody),
    });
    assert.equal(posentegraDuplicate.matched, true);
    assert.equal(posentegraDuplicate.duplicate, true);
    assert.equal(posentegraDuplicate.package.id, posentegraWebhookOrder.package.id);
    assert.equal(
      readRow(dbFile, "SELECT COUNT(*) AS count FROM packages").count,
      posentegraPackageCountBefore + 1
    );

    const packageCountBeforeUnmatched = readRow(dbFile, "SELECT COUNT(*) AS count FROM packages").count;
    const unmatchedWebhookOrder = await request(baseUrl, "/api/webhooks/orders", {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify({
        provider: { slug: "ys" },
        restaurantId: "unknown-yemeksepeti-restaurant",
        orderId: `YS-UNMATCHED-${Date.now()}`,
        customerName: "Unmatched Webhook Customer",
        customerPhone: "05550000004",
        addressText: "Unmatched webhook address",
        totalPrice: 100,
        products: [{ id: "prod-2", name: "Ayran", quantity: 1, price: 100, totalPrice: 100 }],
      }),
    });
    assert.equal(unmatchedWebhookOrder.matched, false);
    assert.equal(readRow(dbFile, "SELECT COUNT(*) AS count FROM packages").count, packageCountBeforeUnmatched);

    const sharedPosentegraRestaurantId = `pos-common-${Date.now()}`;
    const firstSharedWebhook = await request(baseUrl, "/api/webhooks/orders", {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify({
        provider: { slug: "ty", api: "tywh", kaynak: "Trendyol Yemek" },
        pid: `POS-SHARED-TY-${Date.now()}`,
        restaurant: { id: sharedPosentegraRestaurantId, name: "Second Persistence Test Restaurant" },
        customerName: "Shared Posentegra Customer",
        addressText: "Shared Posentegra address",
        totalPrice: 150,
        products: [{ id: "prod-shared-1", name: "Tantuni", quantity: 1, price: 150, totalPrice: 150 }],
      }),
    });
    assert.equal(firstSharedWebhook.matched, false);

    const matchedSharedWebhook = await request(
      baseUrl,
      `/api/admin/unmatched-orders/${firstSharedWebhook.unmatchedOrderId}/match`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          restaurantId: secondRestaurantState.createdRestaurant.id,
          saveExternalId: true,
        }),
      }
    );
    assert.equal(matchedSharedWebhook.ok, true);
    const savedSharedIds = JSON.parse(
      readRow(
        dbFile,
        "SELECT external_restaurant_ids FROM restaurants WHERE id = ?",
        secondRestaurantState.createdRestaurant.id
      ).external_restaurant_ids
    );
    assert.ok(savedSharedIds.some((item) =>
      item.platform === "posentegra" && item.restaurantId === sharedPosentegraRestaurantId
    ));

    const secondSharedWebhook = await request(baseUrl, "/api/webhooks/orders", {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify({
        provider: { slug: "getir", api: "getirwh", kaynak: "Getir Yemek" },
        pid: `POS-SHARED-GETIR-${Date.now()}`,
        restaurant: { id: sharedPosentegraRestaurantId, name: "Second Persistence Test Restaurant" },
        customerName: "Shared Posentegra Customer Two",
        addressText: "Shared Posentegra address two",
        totalPrice: 175,
        products: [{ id: "prod-shared-2", name: "Burger", quantity: 1, price: 175, totalPrice: 175 }],
      }),
    });
    assert.equal(secondSharedWebhook.matched, true);
    assert.equal(secondSharedWebhook.package.restaurantId, secondRestaurantState.createdRestaurant.id);

    const externalPackages = await request(baseUrl, "/api/external/packages", {
      headers: externalHeaders,
    });
    assert.ok(externalPackages.some((pkg) => pkg.id === externalOrderOne.package.id));
    const patched = await request(baseUrl, `/api/external/packages/${externalOrderOne.package.id}/status`, {
      method: "PATCH",
      headers: externalHeaders,
      body: JSON.stringify({ status: "picked_up" }),
    });
    assert.equal(patched.package.status, "picked_up");

    const counts = readRow(dbFile, `
      SELECT
        (SELECT COUNT(*) FROM restaurants) AS restaurants,
        (SELECT COUNT(*) FROM couriers) AS couriers,
        (SELECT COUNT(*) FROM packages) AS packages,
        (SELECT COUNT(*) FROM platform_orders) AS platform_orders
    `);
    assert.ok(counts.restaurants > 0);
    assert.ok(counts.couriers > 0);
    assert.ok(counts.packages > 0);
    assert.ok(counts.platform_orders > 0);
    assert.equal(
      readRow(dbFile, "SELECT COUNT(*) AS count FROM packages WHERE posentegra_id IS NULL OR posentegra_id = ''").count,
      0
    );
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
