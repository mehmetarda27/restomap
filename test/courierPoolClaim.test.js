const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(baseUrl) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error("Courier pool test server did not start.");
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

async function courierRequest(baseUrl, pathname, token, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const body = await response.json();
  return { response, body };
}

test("courier sees real unassigned pool packages and can atomically claim at most two", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "restomap-courier-pool-"));
  const dbFile = path.join(tempDir, "restomap.sqlite");
  const port = 46000 + Math.floor(Math.random() * 1000);
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
      DELIVERA_ASSIGNMENT_RETRY_MS: "600000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(baseUrl);
    const stamp = new Date().toISOString();
    const db = new DatabaseSync(dbFile);
    db.prepare("INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("rst_pool", "Havuz Restoran", "Akdeniz", 36.79, 34.60, "[]", "pool-api", "pool-secret", stamp);
    const insertCourier = db.prepare("INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, per_package_fee, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertCourier.run("cr_pool_1", "Havuz Kurye 1", "Akdeniz", 36.791, 34.601, 1, "online", "pool1", "unused", "unused", 40, stamp);
    insertCourier.run("cr_pool_2", "Havuz Kurye 2", "Akdeniz", 36.792, 34.602, 1, "online", "pool2", "unused", "unused", 40, stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run("token-pool-1", "cr_pool_1", stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run("token-pool-2", "cr_pool_2", stamp);
    const insertPackage = db.prepare(`INSERT INTO packages (
      id, tracking_no, restaurant_id, source, source_platform, external_order_no, recipient, phone, address, zone, eta,
      payment_method, payment_status, order_amount, x, y, customer_lat, customer_lng, note, status, assignment_status,
      assignment_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 1; index <= 3; index += 1) {
      insertPackage.run(`pkg_pool_${index}`, `PKT-POOL-${index}`, "rst_pool", "restaurant_panel", "Manuel", `POOL-${index}`, `Müşteri ${index}`, "5550000000", `Adres ${index}`, "Akdeniz", "15 dk", "Nakit", "cash_expected", 100 + index, 36.79, 34.60, 36.80 + index / 1000, 34.61 + index / 1000, "", "awaiting_assignment", "pending", "Test havuz paketi", stamp, stamp);
    }
    db.close();

    let result = await courierRequest(baseUrl, "/api/courier/me", "token-pool-1");
    assert.equal(result.response.status, 200, result.body.error);
    assert.deepEqual(result.body.poolPackages.map((pkg) => pkg.id), ["pkg_pool_1", "pkg_pool_2", "pkg_pool_3"]);
    assert.equal(result.body.poolAvailableSlots, 2);

    result = await courierRequest(baseUrl, "/api/courier/pool/pkg_pool_1/claim", "token-pool-1", { method: "POST", body: "{}" });
    assert.equal(result.response.status, 200, result.body.error);
    assert.equal(result.body.packages.find((pkg) => pkg.id === "pkg_pool_1").status, "accepted_by_courier");
    assert.equal(result.body.poolAvailableSlots, 1);

    const duplicate = await courierRequest(baseUrl, "/api/courier/pool/pkg_pool_1/claim", "token-pool-2", { method: "POST", body: "{}" });
    assert.equal(duplicate.response.status, 409);
    assert.match(duplicate.body.error, /artik havuzda|baska bir kurye/);

    result = await courierRequest(baseUrl, "/api/courier/pool/pkg_pool_2/claim", "token-pool-1", { method: "POST", body: "{}" });
    assert.equal(result.response.status, 200, result.body.error);
    assert.equal(result.body.courier.activeLoad, 2);
    assert.equal(result.body.poolAvailableSlots, 0);

    const overCapacity = await courierRequest(baseUrl, "/api/courier/pool/pkg_pool_3/claim", "token-pool-1", { method: "POST", body: "{}" });
    assert.equal(overCapacity.response.status, 409);
    assert.match(overCapacity.body.error, /kapasitesine ulasti/);

    const verificationDb = new DatabaseSync(dbFile);
    const claimedRows = verificationDb.prepare("SELECT id, status, assigned_courier_id FROM packages WHERE assigned_courier_id = ? ORDER BY id").all("cr_pool_1");
    assert.deepEqual(claimedRows.map((row) => ({ ...row })), [
      { id: "pkg_pool_1", status: "accepted_by_courier", assigned_courier_id: "cr_pool_1" },
      { id: "pkg_pool_2", status: "accepted_by_courier", assigned_courier_id: "cr_pool_1" },
    ]);
    verificationDb.close();
  } finally {
    await stopServer(server);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); break; }
      catch (error) {
        if (error.code !== "EPERM") throw error;
        await delay(200);
      }
    }
  }
});
