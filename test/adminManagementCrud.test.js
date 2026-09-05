const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForServer(baseUrl) { const started = Date.now(); while (Date.now() - started < 10000) { try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {} await delay(100); } throw new Error("Admin management server did not start."); }
async function stopServer(server) { if (server.exitCode !== null || server.signalCode !== null) return; await new Promise((resolve) => { server.once("exit", resolve); server.kill(); setTimeout(resolve, 2000).unref(); }); }
async function removeTempDir(tempDir) { for (let attempt = 0; attempt < 12; attempt += 1) { try { fs.rmSync(tempDir, { recursive: true, force: true }); return; } catch { await delay(200); } } }
async function freePort() { return new Promise((resolve, reject) => { const listener = net.createServer(); listener.unref(); listener.once("error", reject); listener.listen(0, "127.0.0.1", () => { const { port } = listener.address(); listener.close(() => resolve(port)); }); }); }

test("admin shift, leave, adjustment and zone management persist in the database", { timeout: 25000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-admin-management-"));
  const dbFile = path.join(tempDir, "delivera.sqlite");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const username = `admin_management_${Date.now()}`;
  const password = "AdminManagement123!";
  const server = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: "", POSTGRES_URL: "", DATABASE_PATH: dbFile, DB_PATH: dbFile, DELIVERA_DB_FILE: dbFile, DELIVERA_ADMIN_USERNAME: username, DELIVERA_ADMIN_PASSWORD: password }, stdio: ["ignore", "ignore", "pipe"] });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(baseUrl);
    const db = new DatabaseSync(dbFile); db.exec("PRAGMA busy_timeout = 10000");
    const stamp = new Date().toISOString();
    db.prepare("INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("cr_management", "Yönetim Kuryesi", "Akdeniz", 36.8, 34.6, 1, "online", "management-courier", "unused", "unused", stamp, stamp);
    db.prepare("INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("cr_management_offline", "Çevrimdışı Kurye", "Akdeniz", 36.81, 34.61, 0, "offline", "management-offline", "unused", "unused", stamp, stamp);
    db.prepare("INSERT INTO couriers (id, name, zone, x, y, available, status, username, password_hash, password_salt, last_location_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("cr_management_stale", "Eski Konumlu Kurye", "Akdeniz", 36.82, 34.62, 1, "online", "management-stale", "unused", "unused", new Date(Date.now() - 5 * 60 * 1000).toISOString(), stamp);
    db.prepare("INSERT INTO courier_sessions (token, courier_id, created_at) VALUES (?, ?, ?)").run("courier-management-token", "cr_management", stamp);
    db.prepare("INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("rst_management_a", "Yönetim Restoran A", "Akdeniz", 36.8, 34.6, "[]", "management-a", "secret-a", stamp);
    db.prepare("INSERT INTO restaurants (id, name, zone, x, y, platforms_json, api_key, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("rst_management_b", "Yönetim Restoran B", "Akdeniz", 36.81, 34.61, "[]", "management-b", "secret-b", stamp);
    db.prepare("INSERT INTO restaurant_sessions (token, restaurant_id, created_at) VALUES (?, ?, ?)").run("restaurant-management-token", "rst_management_a", stamp);
    const auth = await (await fetch(`${baseUrl}/api/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) })).json();
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` };
    const date = new Date().toISOString().slice(0, 10);

    const shiftResponse = await fetch(`${baseUrl}/api/admin/shift-plans`, { method: "POST", headers, body: JSON.stringify({ courierId: "cr_management", planDate: date, startTime: "09:00", endTime: "17:00", zone: "Akdeniz" }) });
    assert.equal(shiftResponse.status, 200, await shiftResponse.text());
    const shiftList = await (await fetch(`${baseUrl}/api/admin/shift-plans?date=${date}`, { headers })).json();
    assert.equal(shiftList.shiftPlans.length, 1);
    assert.equal(shiftList.shiftPlans[0].courierId, "cr_management");

    const leaveResponse = await fetch(`${baseUrl}/api/admin/management-records`, { method: "POST", headers, body: JSON.stringify({ recordType: "courier_leave", subjectType: "courier", subjectId: "cr_management", title: "Haftalık izin", startDate: date, endDate: date, note: "Planlı izin" }) });
    const leave = await leaveResponse.json();
    assert.equal(leaveResponse.status, 201, leave.error);
    assert.equal(db.prepare("SELECT record_type FROM management_records WHERE id = ?").get(leave.managementRecord.id).record_type, "courier_leave");

    const adjustmentResponse = await fetch(`${baseUrl}/api/admin/management-records`, { method: "POST", headers, body: JSON.stringify({ recordType: "courier_adjustment", subjectType: "courier", subjectId: "cr_management", title: "Başarı ödülü", amount: 125, startDate: date }) });
    assert.equal(adjustmentResponse.status, 201, await adjustmentResponse.text());
    const paymentChangeResponse = await fetch(`${baseUrl}/api/admin/management-records`, { method: "POST", headers, body: JSON.stringify({ recordType: "payment_change", subjectType: "courier", subjectId: "cr_management", title: "Ödeme yöntemi düzeltmesi", amount: 25, startDate: date }) });
    assert.equal(paymentChangeResponse.status, 201, await paymentChangeResponse.text());

    const restaurantRecordA = await fetch(`${baseUrl}/api/admin/management-records`, { method: "POST", headers, body: JSON.stringify({ recordType: "restaurant_pricing", subjectType: "restaurant", subjectId: "rst_management_a", title: "A fiyat kuralı", amount: 10, startDate: date }) });
    assert.equal(restaurantRecordA.status, 201, await restaurantRecordA.text());
    const restaurantRecordB = await fetch(`${baseUrl}/api/admin/management-records`, { method: "POST", headers, body: JSON.stringify({ recordType: "restaurant_pricing", subjectType: "restaurant", subjectId: "rst_management_b", title: "B fiyat kuralı", amount: 20, startDate: date }) });
    assert.equal(restaurantRecordB.status, 201, await restaurantRecordB.text());

    const creditBefore = await (await fetch(`${baseUrl}/api/admin/restaurants/rst_management_a/credits`, { headers })).json();
    assert.equal(creditBefore.account.balance, 0);
    const addCredits = await fetch(`${baseUrl}/api/admin/restaurants/rst_management_a/credits`, { method: "POST", headers, body: JSON.stringify({ eventKey: "admin-test-credit-1", amount: 10, reason: "Test kontör yükleme" }) });
    assert.equal(addCredits.status, 200, await addCredits.text());
    const repeatedCredits = await fetch(`${baseUrl}/api/admin/restaurants/rst_management_a/credits`, { method: "POST", headers, body: JSON.stringify({ eventKey: "admin-test-credit-1", amount: 10, reason: "Test kontör yükleme" }) });
    assert.equal(repeatedCredits.status, 200, await repeatedCredits.text());
    assert.equal(db.prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM restaurant_credit_movements WHERE restaurant_id = ?").get("rst_management_a").balance, 10);
    const conflictingCredit = await fetch(`${baseUrl}/api/admin/restaurants/rst_management_a/credits`, { method: "POST", headers, body: JSON.stringify({ eventKey: "admin-test-credit-1", amount: 11, reason: "Farklı veri" }) });
    assert.equal(conflictingCredit.status, 409);
    const spendCredits = await fetch(`${baseUrl}/api/admin/restaurants/rst_management_a/credits`, { method: "POST", headers, body: JSON.stringify({ eventKey: "admin-test-credit-2", amount: -3, reason: "Test kullanım" }) });
    assert.equal(spendCredits.status, 200, await spendCredits.text());
    const overspendCredits = await fetch(`${baseUrl}/api/admin/restaurants/rst_management_b/credits`, { method: "POST", headers, body: JSON.stringify({ eventKey: "admin-test-credit-3", amount: -1, reason: "Negatif bakiye engeli" }) });
    assert.equal(overspendCredits.status, 409);
    const restaurantCredits = await (await fetch(`${baseUrl}/api/restaurant/credits`, { headers: { Authorization: "Bearer restaurant-management-token" } })).json();
    assert.equal(restaurantCredits.account.restaurantId, "rst_management_a");
    assert.equal(restaurantCredits.account.balance, 7);
    const restaurantWrite = await fetch(`${baseUrl}/api/restaurant/credits`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer restaurant-management-token" }, body: JSON.stringify({ eventKey: "restaurant-write", amount: 1, reason: "Yetkisiz" }) });
    assert.equal(restaurantWrite.status, 403);
    const bootstrapWithCredits = await (await fetch(`${baseUrl}/api/admin/bootstrap?limit=250&cursor=0`, { headers })).json();
    const creditAccountA = bootstrapWithCredits.creditAccounts.find((item) => item.restaurantId === "rst_management_a");
    assert.equal(creditAccountA.balance, 7);

    // Regression: negative penalties must survive parsing and every mutation
    // must replace their previous effect, not accumulate it.
    const currentTotal = () => db.prepare("SELECT total_payable FROM courier_earnings WHERE courier_id = ? AND report_date = ?").get("cr_management", date).total_payable;
    const penaltyResponse = await fetch(`${baseUrl}/api/admin/management-records`, { method: "POST", headers, body: JSON.stringify({ recordType: "courier_adjustment", subjectType: "courier", subjectId: "cr_management", title: "Teslim cezası", amount: -500, startDate: date }) });
    const penalty = await penaltyResponse.json();
    assert.equal(penaltyResponse.status, 201, penalty.error);
    assert.equal(penalty.managementRecord.amount, -500);
    assert.equal(currentTotal(), -375);
    const penaltyUrl = `${baseUrl}/api/admin/management-records/${penalty.managementRecord.id}`;
    const edited = await fetch(penaltyUrl, { method: "PATCH", headers, body: JSON.stringify({ amount: -200 }) });
    assert.equal(edited.status, 200, await edited.text());
    assert.equal(currentTotal(), -75);
    const tomorrow = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
    const moved = await fetch(penaltyUrl, { method: "PATCH", headers, body: JSON.stringify({ startDate: tomorrow }) });
    assert.equal(moved.status, 200, await moved.text());
    assert.equal(currentTotal(), 125);
    assert.equal(db.prepare("SELECT total_payable FROM courier_earnings WHERE courier_id = ? AND report_date = ?").get("cr_management", tomorrow).total_payable, -200);
    const removed = await fetch(penaltyUrl, { method: "DELETE", headers });
    assert.equal(removed.status, 200, await removed.text());
    assert.equal(db.prepare("SELECT total_payable FROM courier_earnings WHERE courier_id = ? AND report_date = ?").get("cr_management", tomorrow).total_payable, 0);
    assert.equal(currentTotal(), 125);
    const invalid = await fetch(`${baseUrl}/api/admin/management-records`, { method: "POST", headers, body: JSON.stringify({ recordType: "courier_adjustment", subjectType: "courier", subjectId: "missing", title: "Invalid", amount: -50, startDate: date }) });
    assert.equal(invalid.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM management_records WHERE subject_id = 'missing'").get().n, 0);
    const forbidden = await fetch(`${baseUrl}/api/admin/management-records`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer courier-management-token" }, body: JSON.stringify({ title: "forbidden" }) });
    assert.equal(forbidden.status, 401);
    // A closed earning must not be silently rewritten by a new management entry.
    db.prepare("UPDATE courier_earnings SET payment_status = 'paid' WHERE courier_id = ? AND report_date = ?").run("cr_management", tomorrow);
    const closed = await fetch(`${baseUrl}/api/admin/management-records`, { method: "POST", headers, body: JSON.stringify({ recordType: "courier_adjustment", subjectType: "courier", subjectId: "cr_management", title: "Closed period", amount: -20, startDate: tomorrow }) });
    assert.equal(closed.status, 409);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM management_records WHERE title = 'Closed period'").get().n, 0);

    const courierWorkspaceResponse = await fetch(`${baseUrl}/api/courier/me`, { headers: { Authorization: "Bearer courier-management-token" } });
    const courierWorkspace = await courierWorkspaceResponse.json();
    assert.equal(courierWorkspaceResponse.status, 200, courierWorkspace.error);
    assert.deepEqual(new Set(courierWorkspace.managementRecords.map((record) => record.recordType)), new Set(["courier_leave", "courier_adjustment", "payment_change"]));
    assert.equal(db.prepare("SELECT total_payable FROM courier_earnings WHERE courier_id = ? AND report_date = ?").get("cr_management", date).total_payable, 125);

    const restaurantWorkspaceResponse = await fetch(`${baseUrl}/api/restaurant/bootstrap`, { headers: { Authorization: "Bearer restaurant-management-token" } });
    const restaurantWorkspace = await restaurantWorkspaceResponse.json();
    assert.equal(restaurantWorkspaceResponse.status, 200, restaurantWorkspace.error);
    assert.deepEqual(restaurantWorkspace.managementRecords.map((record) => record.subjectId), ["rst_management_a"]);
    assert.equal(restaurantWorkspace.unmatchedOrders.length, 0);
    assert.equal(restaurantWorkspace.courierDailyReports.length, 0);
    assert.equal(restaurantWorkspace.cashReconciliations.length, 0);

    const restaurantMapResponse = await fetch(`${baseUrl}/api/restaurant/live-map`, { headers: { Authorization: "Bearer restaurant-management-token" } });
    const restaurantMap = await restaurantMapResponse.json();
    assert.equal(restaurantMapResponse.status, 200, restaurantMap.error);
    assert.deepEqual(restaurantMap.activeCouriers.map((courier) => courier.id), ["cr_management"]);

    const adminMapResponse = await fetch(`${baseUrl}/api/admin/operation-map`, { headers });
    const adminMap = await adminMapResponse.json();
    assert.equal(adminMapResponse.status, 200, adminMap.error);
    assert.deepEqual(adminMap.activeCouriers.map((courier) => courier.id), ["cr_management"]);

    const courierMapResponse = await fetch(`${baseUrl}/api/courier/live-map`, { headers: { Authorization: "Bearer courier-management-token" } });
    const courierMap = await courierMapResponse.json();
    assert.equal(courierMapResponse.status, 200, courierMap.error);
    assert.equal(courierMap.courier.id, "cr_management");
    assert.ok(Array.isArray(courierMap.packages));

    const zoneName = `Test Bölge ${Date.now()}`;
    const zoneResponse = await fetch(`${baseUrl}/api/admin/zones`, { method: "POST", headers, body: JSON.stringify({ name: zoneName }) });
    assert.equal(zoneResponse.status, 201, await zoneResponse.text());
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM zones WHERE name = ?").get(zoneName).total, 1);
    db.close();
  } finally { await stopServer(server); await removeTempDir(tempDir); }
});
