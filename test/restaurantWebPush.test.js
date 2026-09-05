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
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Restaurant web push test server did not start in time.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

async function removeTempDir(tempDir) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); return; }
    catch (error) { lastError = error; await delay(250); }
  }
  if (process.platform === "win32" && ["EPERM", "EBUSY"].includes(lastError?.code)) return;
  throw lastError;
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  return { response, body };
}

test("restaurant web push subscription is authenticated, isolated and idempotent", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-restaurant-push-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 42000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
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
      DELIVERA_ASSIGNMENT_RETRY_MS: "60000",
      DELIVERA_ADMIN_USERNAME: `restaurant_push_admin_${Date.now()}`,
      DELIVERA_ADMIN_PASSWORD: "RestaurantPushAdmin123!",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const db = new DatabaseSync(dbFile);
    const stamp = new Date().toISOString();
    const firstRestaurantId = "rst_restaurant_push_one";
    const secondRestaurantId = "rst_restaurant_push_two";
    const firstToken = "restaurant-push-token-one";
    const secondToken = "restaurant-push-token-two";
    const insertRestaurant = db.prepare(`
      INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertRestaurant.run(firstRestaurantId, "Push Restaurant One", "Erdemli", 36.6, 34.3, "[]", "push-api-one", "push-secret-one", stamp);
    insertRestaurant.run(secondRestaurantId, "Push Restaurant Two", "Erdemli", 36.7, 34.4, "[]", "push-api-two", "push-secret-two", stamp);
    db.prepare("INSERT INTO restaurant_sessions (token, restaurant_id, created_at) VALUES (?, ?, ?)")
      .run(firstToken, firstRestaurantId, stamp);
    db.prepare("INSERT INTO restaurant_sessions (token, restaurant_id, created_at) VALUES (?, ?, ?)")
      .run(secondToken, secondRestaurantId, stamp);

    const unauthorized = await jsonRequest(baseUrl, "/api/restaurant/push/public-key");
    assert.equal(unauthorized.response.status, 401);

    const firstHeaders = { Authorization: `Bearer ${firstToken}` };
    const secondHeaders = { Authorization: `Bearer ${secondToken}` };
    const publicKeyResult = await jsonRequest(baseUrl, "/api/restaurant/push/public-key", { headers: firstHeaders });
    assert.equal(publicKeyResult.response.status, 200);
    assert.match(publicKeyResult.body.publicKey, /^[A-Za-z0-9_-]+$/);
    assert.ok(publicKeyResult.body.publicKey.length > 50);

    const subscription = {
      endpoint: "https://push.example.test/restaurant/one",
      expirationTime: null,
      keys: { p256dh: "restaurant-test-p256dh", auth: "restaurant-test-auth" },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const saved = await jsonRequest(baseUrl, "/api/restaurant/push/subscriptions", {
        method: "POST",
        headers: firstHeaders,
        body: JSON.stringify({ subscription }),
      });
      assert.equal(saved.response.status, 201);
    }
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM restaurant_push_subscriptions WHERE restaurant_id = ?").get(firstRestaurantId).count,
      1
    );

    const packageResult = await jsonRequest(baseUrl, "/api/restaurant/packages", {
      method: "POST",
      headers: firstHeaders,
      body: JSON.stringify({
        deliveryAddress: "Restaurant push test address",
        packageType: "Push Test Paket",
        orderAmount: 125,
        customerName: "Push Test Customer",
        phone: "5551112233",
        customerNote: "Push failure must not block package creation",
        paymentMethod: "Nakit",
      }),
    });
    assert.equal(packageResult.response.status, 201);
    assert.ok(packageResult.body.createdPackage?.id);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM packages WHERE id = ?").get(packageResult.body.createdPackage.id).count,
      1
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM notification_logs WHERE target_role = ? AND target_id = ? AND event_type = ?")
        .get("restaurant", firstRestaurantId, "package-created").count,
      0
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM notification_logs WHERE target_role = ? AND target_id IS NULL AND event_type = ?")
        .get("admin", "package-created").count,
      1
    );

    const pushTest = await jsonRequest(baseUrl, "/api/restaurant/push/test", {
      method: "POST",
      headers: firstHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(pushTest.response.status, 200);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM notification_logs WHERE target_role = ? AND target_id = ? AND event_type = ?")
        .get("restaurant", firstRestaurantId, "restaurant-push-test").count,
      1
    );

    const foreignDelete = await jsonRequest(baseUrl, "/api/restaurant/push/subscriptions", {
      method: "DELETE",
      headers: secondHeaders,
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    assert.equal(foreignDelete.response.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM restaurant_push_subscriptions").get().count, 1);

    const workerResponse = await fetch(`${baseUrl}/courier-push-sw.js`);
    assert.equal(workerResponse.status, 200);
    const workerSource = await workerResponse.text();
    assert.match(workerSource, /payload\.url/);
    assert.match(workerSource, /targetPath\.startsWith\("\/restaurant"\)/);
    assert.match(workerSource, /if \(visiblePanel\) return/);
    assert.doesNotMatch(workerSource, /Hatırlatma:/);
    const panelResponse = await fetch(`${baseUrl}/restaurant.html`);
    assert.equal(panelResponse.status, 200);
    assert.match(await panelResponse.text(), /restaurant-design-bridge\.js/);
    const bridgeResponse = await fetch(`${baseUrl}/restaurant-design-bridge.js`);
    assert.equal(bridgeResponse.status, 200);
    const bridgeSource = await bridgeResponse.text();
    assert.match(bridgeSource, /restaurantEnablePushButton/);
    assert.match(bridgeSource, /registerPush\("restaurant"/);
    assert.match(bridgeSource, /deliveraRestaurantKioskPrintedOrders/);
    assert.match(bridgeSource, /allowKioskPrint: hadData/);

    const setupResponse = await fetch(`${baseUrl}/downloads/delivera-restoran-kurulum.cmd`);
    assert.equal(setupResponse.status, 200);
    assert.match(setupResponse.headers.get("content-disposition") || "", /attachment.*delivera-restoran-kurulum\.cmd/i);
    const setupSource = await setupResponse.text();
    assert.match(setupSource, /--kiosk-printing/);
    assert.match(setupSource, /restaurant\.html\?kiosk=1/);
    assert.match(setupSource, /NotificationsAllowedForUrls/);

    const removed = await jsonRequest(baseUrl, "/api/restaurant/push/subscriptions", {
      method: "DELETE",
      headers: firstHeaders,
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    assert.equal(removed.response.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM restaurant_push_subscriptions").get().count, 0);
    db.close();
  } finally {
    await stopServer(server);
    await removeTempDir(tempDir);
  }
});
