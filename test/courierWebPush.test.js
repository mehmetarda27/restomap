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
  throw new Error("Courier web push test server did not start in time.");
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

test("courier web push subscription is authenticated, idempotent and removable", { timeout: 20000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-web-push-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 41000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `push_admin_${Date.now()}`;
  const adminPassword = "PushAdmin123!";
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
      DELIVERA_ADMIN_USERNAME: adminUsername,
      DELIVERA_ADMIN_PASSWORD: adminPassword,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const db = new DatabaseSync(dbFile);
    const stamp = new Date().toISOString();
    const courierId = "cr_push_test";
    const token = "courier-push-test-token";
    db.prepare(`
      INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(courierId, "Push Test Courier", "Erdemli", 36.6, 34.3, 1, "online", "push_test", "unused", "unused", stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)")
      .run(token, courierId, stamp);

    const unauthorized = await jsonRequest(baseUrl, "/api/courier/push/public-key");
    assert.equal(unauthorized.response.status, 401);

    const headers = { Authorization: `Bearer ${token}` };
    const publicKeyResult = await jsonRequest(baseUrl, "/api/courier/push/public-key", { headers });
    assert.equal(publicKeyResult.response.status, 200);
    assert.match(publicKeyResult.body.publicKey, /^[A-Za-z0-9_-]+$/);
    assert.ok(publicKeyResult.body.publicKey.length > 50);

    const subscription = {
      endpoint: "https://push.example.test/subscription/one",
      expirationTime: null,
      keys: { p256dh: "test-p256dh-key", auth: "test-auth-key" },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const saved = await jsonRequest(baseUrl, "/api/courier/push/subscriptions", {
        method: "POST",
        headers,
        body: JSON.stringify({ subscription }),
      });
      assert.equal(saved.response.status, 201);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM courier_push_subscriptions WHERE courier_id = ?").get(courierId).count, 1);

    db.prepare(`
      INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("rst_push_test", "Push Test Restaurant", "Erdemli", 36.6, 34.3, "[]", "push-api-key", "push-webhook", stamp);
    db.prepare(`
      INSERT INTO packages (
        id, tracking_no, restaurant_id, source, source_platform, external_order_no,
        recipient, phone, address, zone, eta, payment_method, order_amount,
        x, y, note, status, assignment_status, assignment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pkg_push_test", "PKT-PUSH-TEST", "rst_push_test", "restaurant_panel", "Manuel", "PUSH-TEST-1",
      "Push Customer", "5550000000", "Push test address", "Erdemli", "15 dk", "Online Odeme", 100,
      36.6, 34.3, "Push isolation test", "awaiting_assignment", "pending", "Test setup", stamp, stamp
    );
    const adminLogin = await jsonRequest(baseUrl, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: adminUsername, password: adminPassword }),
    });
    assert.equal(adminLogin.response.status, 200);
    const adminHeaders = { Authorization: `Bearer ${adminLogin.body.token}` };
    const adminDenied = await jsonRequest(baseUrl, "/api/admin/push/public-key", { headers });
    assert.equal(adminDenied.response.status, 401);
    const adminKey = await jsonRequest(baseUrl, "/api/admin/push/public-key", { headers: adminHeaders });
    assert.equal(adminKey.response.status, 200);
    assert.equal(adminKey.body.publicKey, publicKeyResult.body.publicKey);
    for (const device of ["one", "two", "one"]) {
      const result = await jsonRequest(baseUrl, "/api/admin/push/subscriptions", {
        method: "POST", headers: adminHeaders,
        body: JSON.stringify({ subscription: { ...subscription, endpoint: `https://push.example.test/admin/${device}` }, platform: "pwa", deviceLabel: device }),
      });
      assert.equal(result.response.status, 201);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get().n, 2);
    assert.equal(db.prepare("SELECT platform FROM admin_push_subscriptions LIMIT 1").get().platform, "pwa");
    const crossRoleDelete = await jsonRequest(baseUrl, "/api/admin/push/subscriptions", {
      method: "DELETE", headers, body: JSON.stringify({ endpoint: "https://push.example.test/admin/one" }),
    });
    assert.equal(crossRoleDelete.response.status, 401);
    const logout = await jsonRequest(baseUrl, "/api/admin/logout", {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ refreshToken: adminLogin.body.refreshToken, pushEndpoint: "https://push.example.test/admin/one" }),
    });
    assert.equal(logout.response.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_push_subscriptions").get().n, 1);
    const newLogin = await jsonRequest(baseUrl, "/api/admin/login", { method: "POST", body: JSON.stringify({ username: adminUsername, password: adminPassword }) });
    adminLogin.body.token = newLogin.body.token;
    const assigned = await jsonRequest(baseUrl, "/api/admin/packages/pkg_push_test/override", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminLogin.body.token}` },
      body: JSON.stringify({ courierId }),
    });
    assert.equal(assigned.response.status, 200);
    assert.equal(db.prepare("SELECT assigned_courier_id FROM packages WHERE id = ?").get("pkg_push_test").assigned_courier_id, courierId);
    const assignmentNotification = db.prepare(`
      SELECT event_type, message FROM notification_logs
      WHERE target_role = 'courier' AND target_id = ?
      ORDER BY datetime(created_at) DESC LIMIT 1
    `).get(courierId);
    assert.equal(assignmentNotification.event_type, "package-override");
    assert.match(assignmentNotification.message, /paketi kuriyeye atadi/i);

    const workerResponse = await fetch(`${baseUrl}/courier-push-sw.js`);
    assert.equal(workerResponse.status, 200);
    const workerSource = await workerResponse.text();
    assert.match(workerSource, /self\.addEventListener\("push"/);
    assert.match(workerSource, /client\.visibilityState !== "visible"/);
    assert.match(workerSource, /if \(visiblePanel\) return/);

    const removed = await jsonRequest(baseUrl, "/api/courier/push/subscriptions", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    assert.equal(removed.response.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM courier_push_subscriptions WHERE courier_id = ?").get(courierId).count, 0);
    const nativeToken = "restomap-test-fcm-token-1234567890";
    const nativeSaved = await jsonRequest(baseUrl, "/api/courier/push/subscriptions", {
      method: "POST", headers, body: JSON.stringify({ subscription: { provider: "fcm", token: nativeToken }, platform: "android" }),
    });
    assert.equal(nativeSaved.response.status, 201);
    const nativeRow = db.prepare("SELECT * FROM courier_push_subscriptions WHERE courier_id = ?").get(courierId);
    assert.equal(nativeRow.platform, "android");
    assert.equal(JSON.parse(nativeRow.subscription_json).token, nativeToken);
    await jsonRequest(baseUrl, "/api/courier/push/subscriptions", { method: "DELETE", headers, body: JSON.stringify({ endpoint: `fcm:${nativeToken}` }) });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM courier_push_subscriptions WHERE courier_id = ?").get(courierId).count, 0);
    db.close();
  } finally {
    await stopServer(server);
    await removeTempDir(tempDir);
  }
});
