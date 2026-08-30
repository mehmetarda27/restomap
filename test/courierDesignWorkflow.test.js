const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(baseUrl) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error("Courier workflow test server did not start.");
}

async function request(baseUrl, pathname, token, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const body = await response.json();
  assert.equal(response.ok, true, body.error || `${options.method || "GET"} ${pathname} failed.`);
  return body;
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
    setTimeout(resolve, 2000).unref();
  });
}

test("courier design flow accepts, routes, delivers and records a break", { timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-design-flow-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = 48000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const geocodeQueries = [];
  const geocoder = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    geocodeQueries.push(url.searchParams.get("q"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{ lat: "36.8001", lon: "34.6202" }]));
  });
  await new Promise((resolve) => geocoder.listen(0, "127.0.0.1", resolve));
  const geocoderPort = geocoder.address().port;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: "", POSTGRES_URL: "", DATABASE_PATH: dbFile, DB_PATH: dbFile, DELIVERA_DB_FILE: dbFile, DELIVERA_ASSIGNMENT_RETRY_MS: "60000", DELIVERA_COURIER_OFFER_TIMEOUT_MS: "60000", GEOCODING_API_URL: `http://127.0.0.1:${geocoderPort}/search`, RESTOMAP_DEFAULT_CITY: "Mersin" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(baseUrl);
    const stamp = new Date().toISOString();
    const db = new DatabaseSync(dbFile);
    db.prepare("INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("rst_flow", "Akış Restoran", "Akdeniz", 36.79, 34.60, "[]", "flow-api", "flow-secret", stamp);
    db.prepare("INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, per_package_fee, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("cr_flow", "Akış Kurye", "Akdeniz", 36.791, 34.601, 1, "online", "flow", "unused", "unused", 40, stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run("token-flow", "cr_flow", stamp);
    db.prepare("INSERT OR IGNORE INTO admins (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("admin", "admin-flow", "unused", "unused", stamp);
    db.prepare("INSERT INTO admin_sessions (token, admin_id, created_at) VALUES (?, ?, ?)").run("admin-flow", "admin", stamp);
    db.prepare("INSERT INTO courier_shifts (id, courier_id, started_at, ended_at, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)")
      .run("shift_flow", "cr_flow", stamp, stamp, stamp);
    db.prepare(`INSERT INTO packages (
      id, tracking_no, restaurant_id, source, source_platform, external_order_no, recipient, phone, address, zone, eta,
      payment_method, payment_status, order_amount, x, y, note, status, assignment_status, assigned_courier_id,
      assigned_courier_name, assigned_at, assignment_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("pkg_flow", "PKT-FLOW", "rst_flow", "restaurant_panel", "Manuel", "FLOW-1", "Akış Müşteri", "5550000000", "Test adresi", "Akdeniz", "15 dk", "Nakit", "cash_expected", 250, 36.79, 34.60, "", "assigned", "assigned", "cr_flow", "Akış Kurye", stamp, "Test ataması", stamp, stamp);
    db.close();

    let workspace = await request(baseUrl, "/api/courier/packages/pkg_flow/status", "token-flow", { method: "PATCH", body: JSON.stringify({ status: "accepted_by_courier" }) });
    assert.equal(workspace.packages.find((pkg) => pkg.id === "pkg_flow").status, "accepted_by_courier");

    const breakWhileActive = await fetch(`${baseUrl}/api/courier/break`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer token-flow" }, body: JSON.stringify({ action: "start" }) });
    assert.equal(breakWhileActive.status, 409);

    workspace = await request(baseUrl, "/api/courier/packages/pkg_flow/status", "token-flow", { method: "PATCH", body: JSON.stringify({ status: "on_route" }) });
    const routedPackage = workspace.packages.find((pkg) => pkg.id === "pkg_flow");
    assert.equal(routedPackage.status, "on_route");
    assert.equal(routedPackage.customerLat, 36.8001);
    assert.equal(routedPackage.customerLng, 34.6202);
    assert.match(geocodeQueries[0], /Test adresi/i);
    assert.match(geocodeQueries[0], /Akdeniz/i);
    assert.match(geocodeQueries[0], /Mersin/i);

    const prematureDayClose = await fetch(`${baseUrl}/api/courier/day-close`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer token-flow" }, body: "{}" });
    assert.equal(prematureDayClose.status, 409);
    assert.match((await prematureDayClose.json()).error, /Aktif 1 paket/);

    workspace = await request(baseUrl, "/api/courier/packages/pkg_flow/status", "token-flow", { method: "PATCH", body: JSON.stringify({ status: "delivered", paymentStatus: "cash_collected", courierCollectionNote: "250 TL alındı" }) });
    const delivered = workspace.historyPackages.find((pkg) => pkg.id === "pkg_flow");
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.paymentStatus, "cash_collected");
    assert.equal(delivered.paymentMethod, "Nakit tahsil edildi");
    const restaurantLogin = await request(baseUrl, "/api/restaurant/session", "", {
      method: "POST",
      body: JSON.stringify({ restaurantId: "rst_flow", apiKey: "flow-api" }),
    });
    const restaurantWorkspace = await request(baseUrl, "/api/restaurant/bootstrap", restaurantLogin.token);
    const restaurantDeliveredPackage = restaurantWorkspace.packages.find((pkg) => pkg.id === "pkg_flow");
    assert.equal(restaurantDeliveredPackage.paymentStatus, "cash_collected");
    assert.equal(restaurantDeliveredPackage.paymentMethod, "Nakit tahsil edildi");
    assert.equal(workspace.reportSummary.daily.deliveredCount, 1);
    assert.equal(workspace.reportSummary.weekly.deliveredCount, 1);
    assert.equal(workspace.reportSummary.monthly.deliveredCount, 1);
    assert.equal(typeof workspace.reportSummary.daily.averageDeliveryMinutes, "number");

    workspace = await request(baseUrl, "/api/courier/break", "token-flow", { method: "POST", body: JSON.stringify({ action: "start" }) });
    assert.ok(workspace.shiftSummary.currentBreak);
    assert.equal(workspace.courier.available, false);

    workspace = await request(baseUrl, "/api/courier/break", "token-flow", { method: "POST", body: JSON.stringify({ action: "end" }) });
    assert.equal(workspace.shiftSummary.currentBreak, null);
    assert.equal(workspace.courier.available, true);

    workspace = await request(baseUrl, "/api/courier/day-close", "token-flow", { method: "POST", body: JSON.stringify({ courierNote: "Gün sonu tahsilatı teslim edildi" }) });
    assert.equal(workspace.dayMetrics.hasClosedDay, true);
    assert.equal(workspace.dayMetrics.deliveredCount, 0);
    assert.equal(workspace.dayMetrics.totalAmount, 0);
    assert.equal(workspace.dayMetrics.closedSummary.deliveredCount, 1);
    assert.equal(workspace.courier.available, false);
    assert.equal(workspace.courierDailyReports.length, 1);
    assert.equal(workspace.dayCloseReport.cashCollectedAmount, 250);
    assert.equal(workspace.dayCloseReport.status, "pending_approval");

    const performance = await request(baseUrl, `/api/admin/courier-performance?date=${stamp.slice(0, 10)}`, "admin-flow");
    const performanceRow = performance.couriers.find((courier) => courier.id === "cr_flow");
    assert.equal(performanceRow.deliveredCount, 1);
    assert.equal(performanceRow.totalCount, 1);

    const verificationDb = new DatabaseSync(dbFile);
    const reconciliation = verificationDb.prepare("SELECT * FROM cash_reconciliations WHERE courier_id = ?").get("cr_flow");
    assert.ok(reconciliation);
    assert.equal(reconciliation.expected_cash, 250);
    assert.equal(reconciliation.reported_cash, 250);
    assert.equal(reconciliation.status, "pending");
    const report = verificationDb.prepare("SELECT * FROM courier_daily_reports WHERE courier_id = ?").get("cr_flow");
    assert.equal(report.courier_note, "Gün sonu tahsilatı teslim edildi");
    assert.equal(report.status, "pending_approval");
    verificationDb.close();
  } finally {
    await stopServer(server);
    await new Promise((resolve) => geocoder.close(resolve));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); break; }
      catch (error) {
        if (error.code !== "EPERM") throw error;
        await delay(200);
      }
    }
  }
});
