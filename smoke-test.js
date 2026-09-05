const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const extensionShared = require("./chrome-extension/shared.js");

const PORT = 3210;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 8000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/bootstrap`);
      if (response.ok) {
        return;
      }
    } catch {
      await delay(150);
    }
  }

  throw new Error("Sunucu belirtilen surede acilmadi.");
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${body.error || "Bilinmeyen hata"}`);
  }

  return body;
}

async function requestText(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${body || "Bilinmeyen hata"}`);
  }
  return body;
}

function parseToolJsonOutput(output) {
  const text = String(output || "");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join("\n").trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  throw new Error(`JSON ciktisi bulunamadi: ${text}`);
}

function runMigrationForSmoke(tempDbFile) {
  const result = spawnSync(process.execPath, ["scripts/migrate.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      DATABASE_PATH: tempDbFile,
      DB_PATH: tempDbFile,
      DELIVERA_DB_FILE: tempDbFile,
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Migration smoke komutu basarisiz: ${result.stderr || result.stdout}`);
  }
  return parseToolJsonOutput(result.stdout);
}

function smokeMigrationCount(tempDbFile) {
  const db = new DatabaseSync(tempDbFile);
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count;
  } finally {
    db.close();
  }
}

function runBackupForSmoke(tempDbFile, tempDir) {
  const backupDir = path.join(tempDir, "backups");
  const result = spawnSync(process.execPath, ["scripts/backup-sqlite.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      DATABASE_PATH: tempDbFile,
      DB_PATH: tempDbFile,
      DELIVERA_DB_FILE: tempDbFile,
      DELIVERA_BACKUP_DIR: backupDir,
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Backup smoke komutu basarisiz: ${result.stderr || result.stdout}`);
  }
  const payload = parseToolJsonOutput(result.stdout);
  if (!payload.ok || !fs.existsSync(payload.backup) || !payload.backup.includes("delivera-")) {
    throw new Error("Backup smoke beklenen tarihli backup dosyasini uretmedi.");
  }
  return payload;
}

function smokeMapUrl(order, target = "customer") {
  const latitude = Number(target === "restaurant" ? (order?.restaurantLat ?? order?.latitude) : (order?.customerLat ?? order?.customerLatitude));
  const longitude = Number(target === "restaurant" ? (order?.restaurantLng ?? order?.longitude) : (order?.customerLng ?? order?.customerLongitude));
  const address = String(
    target === "restaurant"
      ? (order?.restaurantAddress || order?.restaurantName || order?.zone || "")
      : (order?.customerAddress || order?.deliveryAddress || order?.address || "")
  ).trim();

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  }
  if (!address) {
    return "";
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

async function run() {
  const adminUsername = process.env.DELIVERA_ADMIN_USERNAME || "admin";
  const adminPassword = process.env.DELIVERA_ADMIN_PASSWORD || "Delivera123!";
  const courierUsername = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courierPassword = "Kurye123!";
  const courier2Username = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courier2Password = "Kurye123!";
  const courier3Username = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courier3Password = "Kurye123!";
  const courier4Username = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courier4Password = "Kurye123!";
  const courier5Username = `smokekurye${Math.floor(Math.random() * 100000)}`;
  const courier5Password = "Kurye123!";
  const restaurantLatitude = 36.601001;
  const restaurantLongitude = 34.320001;
  const courierLatitude = 36.601051;
  const courierLongitude = 34.320051;
  const firstAddress = `Mersin Erdemli test mahallesi teslimat noktasi ${Date.now()} no 10`;
  const secondAddress = `Mersin Erdemli ikinci teslim noktasi ${Date.now()} no 20`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivera-smoke-"));
  const tempDbFile = path.join(tempDir, "delivera.sqlite");
  const firstMigrationRun = runMigrationForSmoke(tempDbFile);
  const firstMigrationCount = smokeMigrationCount(tempDbFile);
  if (!firstMigrationRun.ok || firstMigrationRun.applied.length < 1 || firstMigrationCount < 1) {
    throw new Error("Migration runner ilk calismada schema_migrations kaydi olusturmadi.");
  }
  const secondMigrationRun = runMigrationForSmoke(tempDbFile);
  const secondMigrationCount = smokeMigrationCount(tempDbFile);
  if (!secondMigrationRun.ok || secondMigrationRun.applied.length !== 0 || secondMigrationCount !== firstMigrationCount) {
    throw new Error("Migration runner ikinci calismada idempotent davranmadi.");
  }
  runBackupForSmoke(tempDbFile, tempDir);
  const server = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DELIVERA_ADMIN_USERNAME: adminUsername,
      DELIVERA_ADMIN_PASSWORD: adminPassword,
      DELIVERA_ASSIGNMENT_RETRY_MS: "1000",
      DELIVERA_COURIER_OFFER_TIMEOUT_MS: "5000",
      DATABASE_PATH: tempDbFile,
      DB_PATH: tempDbFile,
      DELIVERA_DB_FILE: tempDbFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer();

    const adminLogin = await request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: adminUsername,
        password: adminPassword,
      }),
    });
    const adminHeaders = { Authorization: `Bearer ${adminLogin.token}` };

    const health = await request("/health");
    if (!health.ok || health.app !== "RESTOMAP" || health.database || health.queues || health.cache) {
      throw new Error("Public health endpoint guvenli minimal payload dondurmedi.");
    }
    const metrics = await requestText("/metrics");
    if (!metrics.includes("delivera_up 1") || !metrics.includes("delivera_requests_total") || !metrics.includes("delivera_table_rows")) {
      throw new Error("Prometheus metrics endpoint beklenen metrikleri dondurmedi.");
    }
    const systemStatus = await request("/api/admin/system-status", {
      headers: adminHeaders,
    });
    if (!systemStatus.ok || !systemStatus.queues || !systemStatus.cache || typeof systemStatus.database?.postgresUrlConfigured !== "boolean") {
      throw new Error("Admin system-status production hazirlik alanlarini dondurmedi.");
    }
    const performanceSummary = await request("/api/admin/performance-summary", {
      headers: adminHeaders,
    });
    if (!performanceSummary.ok || typeof performanceSummary.p95ResponseTimeMs !== "number" || !performanceSummary.queues) {
      throw new Error("Admin performance-summary metrik alanlari eksik.");
    }
    let rateLimited = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await request("/api/admin/login", {
          method: "POST",
          headers: { "X-Forwarded-For": "10.200.10.10" },
          body: JSON.stringify({ username: `wrong-${attempt}`, password: "Wrong123!" }),
        });
      } catch (error) {
        if (String(error.message).includes("429") && String(error.message).includes("Too many requests")) {
          rateLimited = true;
          break;
        }
      }
    }
    if (!rateLimited) {
      throw new Error("Login rate limit temel kontrolu 429 dondurmedi.");
    }

    const restaurantUsername = `smokerest${Math.floor(Math.random() * 100000)}`;
    const restaurantPassword = "Rest12345!";
    const createdRestaurant = await request("/api/admin/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: `Smoke Restoran ${Date.now()}`,
        portalUsername: restaurantUsername,
        portalPassword: restaurantPassword,
        zone: "Erdemli",
        latitude: restaurantLatitude,
        longitude: restaurantLongitude,
        platforms: ["Trendyol Go", "GetirYemek"],
      }),
    });
    const createdRestaurantRecord = createdRestaurant.restaurants.find((item) => item.username === restaurantUsername);
    if (!createdRestaurantRecord) {
      throw new Error("Admin restoran kaydini dondurmedi.");
    }

    const restaurantLogin = await request("/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({
        username: restaurantUsername,
        password: restaurantPassword,
      }),
    });
    const restaurantHeaders = { Authorization: `Bearer ${restaurantLogin.token}` };

    const platformState = await request("/api/restaurant/platform-accounts", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        platform: "Yemeksepeti",
        externalStoreId: `vendor-${Date.now()}`,
        staticToken: "smoke-platform-secret",
      }),
    });
    const platformAccount = platformState.platformAccounts.find((item) => item.platform === "Yemeksepeti");
    if (!platformAccount) {
      throw new Error("Platform hesabi olusmadi.");
    }
    if (!platformAccount.hasStaticToken || platformAccount.staticToken) {
      throw new Error("Static Token frontend yanitinda gizlenmedi.");
    }
    const initialPlatformHealth = await request(`/api/restaurant/platform-accounts/${platformAccount.id}/health`, {
      headers: restaurantHeaders,
    });
    if (!initialPlatformHealth.health || !["unknown", "warning"].includes(initialPlatformHealth.health.status)) {
      throw new Error("Yeni kaydedilen platform hesabi bagli gibi gorunmemeli.");
    }
    const checkedPlatformHealth = await request(`/api/restaurant/platform-accounts/${platformAccount.id}/check-connection`, {
      method: "POST",
      headers: restaurantHeaders,
    });
    if (!checkedPlatformHealth.health || !["warning", "connected", "unknown"].includes(checkedPlatformHealth.health.status)) {
      throw new Error("Restoran platform check-connection health payload dondurmedi.");
    }
    const adminPlatformHealth = await request(`/api/admin/platform-accounts/${platformAccount.id}/health`, {
      headers: adminHeaders,
    });
    if (!adminPlatformHealth.account || !adminPlatformHealth.health) {
      throw new Error("Admin platform health endpoint detay dondurmedi.");
    }
    const adminPlatformSummary = await request("/api/admin/platform-health-summary", {
      headers: adminHeaders,
    });
    if (!adminPlatformSummary.ok || !adminPlatformSummary.summary || !Array.isArray(adminPlatformSummary.accounts)) {
      throw new Error("Admin platform-health-summary endpoint beklenen ozeti dondurmedi.");
    }
    const otherRestaurantUsername = `smokeother${Math.floor(Math.random() * 100000)}`;
    const otherRestaurantPassword = "Rest12345!";
    await request("/api/admin/restaurants", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: `Smoke Diger Restoran ${Date.now()}`,
        portalUsername: otherRestaurantUsername,
        portalPassword: otherRestaurantPassword,
        zone: "Erdemli",
        latitude: restaurantLatitude + 0.01,
        longitude: restaurantLongitude + 0.01,
        platforms: ["Yemeksepeti"],
      }),
    });
    const otherRestaurantLogin = await request("/api/restaurant/session", {
      method: "POST",
      body: JSON.stringify({
        username: otherRestaurantUsername,
        password: otherRestaurantPassword,
      }),
    });
    await request(`/api/restaurant/platform-accounts/${platformAccount.id}/health`, {
      headers: { Authorization: `Bearer ${otherRestaurantLogin.token}` },
    }).then(() => {
      throw new Error("Restoran baska restoranin platform health bilgisini gorebildi.");
    }).catch((error) => {
      if (!String(error.message).includes("404")) {
        throw error;
      }
    });

    const courierState = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye",
        username: courierUsername,
        password: courierPassword,
        zone: "Erdemli",
        latitude: courierLatitude,
        longitude: courierLongitude,
        available: true,
      }),
    });
    const createdCourier = courierState.couriers.find((item) => item.username === courierUsername);
    if (!createdCourier) {
      throw new Error("Kurye olusturulamadi.");
    }
    const courierState2 = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye 2",
        username: courier2Username,
        password: courier2Password,
        zone: "Erdemli",
        latitude: courierLatitude + 0.0001,
        longitude: courierLongitude + 0.0001,
        available: true,
      }),
    });
    const createdCourier2 = courierState2.couriers.find((item) => item.username === courier2Username);
    if (!createdCourier2) {
      throw new Error("Ikinci kurye olusturulamadi.");
    }
    // Automatic assignment requires the courier to be online with a fresh GPS
    // timestamp. A real courier gets both when signing in, so the smoke flow must
    // do the same before creating packages instead of relying on admin creation.
    const courierLogin = await request("/api/courier/login", {
      method: "POST",
      body: JSON.stringify({
        username: courierUsername,
        password: courierPassword,
      }),
    });
    const courierHeaders = { Authorization: `Bearer ${courierLogin.token}` };
    const courier2Login = await request("/api/courier/login", {
      method: "POST",
      body: JSON.stringify({
        username: courier2Username,
        password: courier2Password,
      }),
    });
    const courier2Headers = { Authorization: `Bearer ${courier2Login.token}` };
    const courierState3 = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye 3",
        username: courier3Username,
        password: courier3Password,
        zone: "Akdeniz",
        latitude: courierLatitude + 0.0002,
        longitude: courierLongitude + 0.0002,
        available: false,
      }),
    });
    const createdCourier3 = courierState3.couriers.find((item) => item.username === courier3Username);
    if (!createdCourier3) {
      throw new Error("Ucuncu kurye olusturulamadi.");
    }
    let bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    if (!bootstrap.couriers.some((item) => item.id === createdCourier.id) ||
      !bootstrap.couriers.some((item) => item.id === createdCourier2.id) ||
      !bootstrap.couriers.some((item) => item.id === createdCourier3.id)) {
      throw new Error("Yeni eklenen kuryeler admin bootstrap listesine dusmedi.");
    }

    const firstRestaurantPackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: firstAddress,
        packageType: "Sicak Yemek",
        orderAmount: 250,
        customerName: "Birinci Musteri",
        phone: "05550000001",
      }),
    });
    const firstManualPackage = firstRestaurantPackageState.packages.find((pkg) => pkg.deliveryAddress === firstAddress);
    if (!firstManualPackage || !["awaiting_assignment", "assigned"].includes(firstManualPackage.status)) {
      throw new Error("Manuel paket beklenen duruma (awaiting_assignment/assigned) gelmedi.");
    }
    if (firstManualPackage.source !== "external_manual") {
      throw new Error("Manuel paket source alani beklenen sekilde isaretlenmedi.");
    }
    
    // No need to manually trigger assignment, system auto-assigns
    const firstAssignedState = await request("/api/restaurant/bootstrap", { headers: restaurantHeaders });
    const firstAssignedPackage = firstAssignedState.packages.find((pkg) => pkg.id === firstManualPackage.id);
    if (!firstAssignedPackage || firstAssignedPackage.status !== "assigned" || firstAssignedPackage.assignedCourierId !== createdCourier.id) {
      throw new Error("Uygun kurye varken ilk siparis otomatik atanamadi.");
    }

    const secondRestaurantPackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: secondAddress,
        packageType: "Tatli",
        orderAmount: 180,
        customerName: "Ikinci Musteri",
        phone: "05550000002",
      }),
    });
    const secondManualPackage = secondRestaurantPackageState.packages.find((pkg) => pkg.deliveryAddress === secondAddress);
    if (!secondManualPackage || !["awaiting_assignment", "assigned"].includes(secondManualPackage.status)) {
      throw new Error("Ikinci manuel paket beklenen duruma (awaiting_assignment/assigned) gelmedi.");
    }
    
    // No need to manually trigger assignment, system auto-assigns
    const secondAssignedState = await request("/api/restaurant/bootstrap", { headers: restaurantHeaders });
    const secondAssignedPackage = secondAssignedState.packages.find((pkg) => pkg.id === secondManualPackage.id);
    if (!secondAssignedPackage || secondAssignedPackage.status !== "assigned") {
      throw new Error("Ikinci uygun kurye varken ikinci siparis atanamadi.");
    }
    if (secondAssignedPackage.assignedCourierId !== createdCourier2.id) {
      throw new Error("Ikinci siparis beklenen ikinci kuryeye atanamadi.");
    }

    const thirdAddress = `Mersin Erdemli ucuncu teslim noktasi ${Date.now()} no 30`;
    const thirdRestaurantPackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: thirdAddress,
        packageType: "Icecek",
        orderAmount: 90,
        customerName: "Ucuncu Musteri",
        phone: "05550000003",
      }),
    });
    const thirdManualPackage = thirdRestaurantPackageState.packages.find((pkg) => pkg.deliveryAddress === thirdAddress);
    if (!thirdManualPackage || !["awaiting_assignment", "assigned"].includes(thirdManualPackage.status)) {
      throw new Error("Ucuncu manuel paket beklenen duruma (awaiting_assignment/assigned) gelmedi.");
    }
    
    // No need to manually trigger assignment, system auto-assigns
    const thirdAssignedState = await request("/api/restaurant/bootstrap", { headers: restaurantHeaders });
    const thirdWaitingPackage = thirdAssignedState.packages.find((pkg) => pkg.id === thirdManualPackage.id);
    if (!thirdWaitingPackage || thirdWaitingPackage.status !== "awaiting_assignment") {
      throw new Error("Tum kuryeler busy iken ucuncu siparis kurye bekleme durumuna gecmedi.");
    }
    if (!thirdWaitingPackage.lastAssignmentError) {
      throw new Error("Atama basarisizlik nedeni kaydedilmedi.");
    }
    const pagedAdminBootstrap = await request("/api/admin/bootstrap?limit=2&cursor=0", {
      headers: adminHeaders,
    });
    if (!pagedAdminBootstrap.pagination?.packages || pagedAdminBootstrap.packages.length > 2 || !pagedAdminBootstrap.pagination.packages.hasMore) {
      throw new Error("Admin bootstrap pagination metadata veya limit davranisi calismadi.");
    }
    const pagedRestaurantBootstrap = await request("/api/restaurant/bootstrap?limit=2&cursor=0", {
      headers: restaurantHeaders,
    });
    if (!pagedRestaurantBootstrap.pagination?.packages || pagedRestaurantBootstrap.packages.length > 2 || !pagedRestaurantBootstrap.pagination.packages.hasMore) {
      throw new Error("Restoran bootstrap pagination metadata veya limit davranisi calismadi.");
    }

    await request("/api/platform/order", {
      method: "POST",
      headers: {
        "x-platform-secret": "wrong-secret",
      },
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: platformAccount.externalStoreId,
        orderId: `YS-WRONG-${Date.now()}`,
        customerName: "Yanlis Secret",
        phone: "05550000000",
        address: "Mersin gizli test adresi",
        totalPrice: 99,
      }),
    }).then(() => {
      throw new Error("Yanlis secret ile siparis kabul edildi.");
    }).catch((error) => {
      if (!String(error.message).includes("401")) {
        throw error;
      }
    });

    const webhookResponse = await request("/api/platform/order", {
      method: "POST",
      headers: {
        "x-platform-secret": "smoke-platform-secret",
      },
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: platformAccount.externalStoreId,
        orderId: `YS-${Date.now()}`,
        customerName: "Webhook Musteri",
        phone: "5550000000",
        address: "Mersin Mezitli sahil caddesi webhook no 12",
        totalPrice: 320,
        items: [
          { id: "ys-1", name: "Lahmacun", quantity: 2, price: 120 },
          { id: "ys-2", name: "Ayran", quantity: 1, price: 80 },
        ],
        paymentMethod: "Online Odeme",
        customerNote: "Zili calma",
      }),
    });
    if (webhookResponse.package.status !== "pending_approval") {
      throw new Error("Platform siparisi pending_approval durumunda kaydolmadi.");
    }
    if (webhookResponse.package.customerAddress !== "Mersin Mezitli sahil caddesi webhook no 12") {
      throw new Error("Platform siparisinde musteri adresi customer_address alanina kaydolmadi.");
    }
    if (webhookResponse.package.assignedCourierId) {
      throw new Error("Platform siparisi restoran onayi olmadan kuryeye atandi.");
    }
    const connectedPlatformHealth = await request(`/api/admin/platform-accounts/${platformAccount.id}/health`, {
      headers: adminHeaders,
    });
    if (connectedPlatformHealth.health?.status !== "connected") {
      throw new Error("Basarili webhook sonrasi platform health connected olmadi.");
    }

    const duplicateWebhookResponse = await request("/api/platform/order", {
      method: "POST",
      headers: {
        "x-platform-secret": "smoke-platform-secret",
      },
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: platformAccount.externalStoreId,
        orderId: webhookResponse.package.externalOrderNo,
        customerName: "Webhook Musteri",
        phone: "5550000000",
        address: "Mersin Mezitli sahil caddesi webhook no 12",
        totalPrice: 320,
      }),
    });
    if (duplicateWebhookResponse.package.id !== webhookResponse.package.id) {
      throw new Error("Duplicate platform siparisi ikinci kez olustu.");
    }
    const duplicateEventSummary = await request("/api/admin/platform-health-summary", {
      headers: adminHeaders,
    });
    if (!duplicateEventSummary.recentEvents?.some((event) => event.status === "duplicate")) {
      throw new Error("Duplicate order controlled event olarak loglanmadi.");
    }

    const rejectedWebhookResponse = await request("/api/platform/order", {
      method: "POST",
      headers: {
        "x-platform-secret": "smoke-platform-secret",
      },
      body: JSON.stringify({
        platform: "yemeksepeti",
        platformRestaurantId: platformAccount.externalStoreId,
        orderId: `YS-REJECT-${Date.now()}`,
        customerName: "Reddedilecek Musteri",
        phone: "05554443322",
        address: "Mersin red test adresi",
        totalPrice: 120,
      }),
    });
    if (rejectedWebhookResponse.package.status !== "pending_approval") {
      throw new Error("Reddedilecek platform siparisi pending_approval olmadi.");
    }
    const pendingRestaurantBootstrap = await request("/api/restaurant/bootstrap", {
      headers: restaurantHeaders,
    });
    if (!pendingRestaurantBootstrap.packages.some((pkg) => pkg.id === webhookResponse.package.id && pkg.status === "pending_approval")) {
      throw new Error("Restoran paneli pending_approval platform siparisini gormedi.");
    }
    const pendingAdminBootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    if (!pendingAdminBootstrap.packages.some((pkg) => pkg.id === webhookResponse.package.id && pkg.status === "pending_approval")) {
      throw new Error("Admin paneli pending_approval platform siparisini gormedi.");
    }

    let shiftPlanState = await request("/api/admin/shift-plans", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        courierId: createdCourier.id,
        planDate: new Date().toISOString().slice(0, 10),
        startTime: "11:00",
        endTime: "19:00",
        zone: "Erdemli",
      }),
    });
    const pendingShiftPlan = (shiftPlanState.shiftPlans || []).find((plan) => plan.courierId === createdCourier.id);
    if (!pendingShiftPlan || pendingShiftPlan.status !== "awaiting_courier_acceptance") {
      throw new Error("Kurye vardiya teklifi olusmadi.");
    }

    let courierWorkspace = await request("/api/courier/me", {
      headers: courierHeaders,
    });
    const pagedCourierWorkspace = await request("/api/courier/me?limit=1&cursor=0", {
      headers: courierHeaders,
    });
    if (!pagedCourierWorkspace.pagination?.packages || pagedCourierWorkspace.packages.length > 1) {
      throw new Error("Kurye workspace pagination metadata veya limit davranisi calismadi.");
    }
    const courierShiftPlan = (courierWorkspace.shiftSummary?.shiftPlans || []).find((plan) => plan.id === pendingShiftPlan.id);
    if (!courierShiftPlan || courierShiftPlan.status !== "awaiting_courier_acceptance") {
      throw new Error("Kurye panelinde vardiya teklifi gorunmedi.");
    }
    courierWorkspace = await request(`/api/courier/shift-plans/${pendingShiftPlan.id}/accept`, {
      method: "POST",
      headers: courierHeaders,
      body: JSON.stringify({}),
    });
    const acceptedShiftPlan = (courierWorkspace.shiftSummary?.shiftPlans || []).find((plan) => plan.id === pendingShiftPlan.id);
    if (!acceptedShiftPlan || acceptedShiftPlan.status !== "accepted") {
      throw new Error("Kurye vardiya planini kabul edemedi.");
    }
    shiftPlanState = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const acceptedAdminShiftPlan = (shiftPlanState.shiftPlans || []).find((plan) => plan.id === pendingShiftPlan.id);
    if (!acceptedAdminShiftPlan || acceptedAdminShiftPlan.status !== "accepted") {
      throw new Error("Admin vardiya kabul bilgisini goremiyor.");
    }

    if (courierWorkspace.packages.filter((pkg) => ["assigned", "accepted_by_courier", "on_route"].includes(pkg.status)).length !== 1) {
      throw new Error("Ayni kurye birden fazla aktif paket aldi.");
    }
    const assignedPackage = courierWorkspace.packages.find((pkg) => pkg.id === firstManualPackage.id);
    if (!assignedPackage) {
      throw new Error("Atanan ilk siparis kurye panelinde bulunamadi.");
    }
    if (assignedPackage.source !== "external_manual") {
      throw new Error("Manuel paket kurye paneline beklenen source ile dusmedi.");
    }
    if (!assignedPackage.recipient || !assignedPackage.phone || !assignedPackage.paymentMethod) {
      throw new Error("Kurye paneli musteri bilgisi veya odeme tipini eksik aldi.");
    }
    const restaurantMapUrl = smokeMapUrl(assignedPackage, "restaurant");
    if (restaurantMapUrl !== `https://www.google.com/maps/search/?api=1&query=${restaurantLatitude},${restaurantLongitude}`) {
      throw new Error("Restoran harita linki koordinatla uretilmedi.");
    }
    const customerMapUrl = smokeMapUrl(assignedPackage, "customer");
    if (!customerMapUrl.includes(encodeURIComponent(firstAddress))) {
      throw new Error("Musteri harita linki adres fallback ile encode edilmedi.");
    }
    if (smokeMapUrl({ customerAddress: "" }, "customer") !== "") {
      throw new Error("Bos adres icin harita linki uretilmemeliydi.");
    }

    courierWorkspace = await request(`/api/courier/packages/${assignedPackage.id}/status`, {
      method: "PATCH",
      headers: courierHeaders,
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    // Confirm a deterministic fixture point through the real restaurant API; no geocoder dependency.
    await request(`/api/restaurant/packages/${assignedPackage.id}/delivery-point`, {
      method: "PATCH", headers: restaurantHeaders,
      body: JSON.stringify({ latitude: restaurantLatitude + 0.001, longitude: restaurantLongitude + 0.001 }),
    });
    courierWorkspace = await request(`/api/courier/packages/${assignedPackage.id}/status`, {
      method: "PATCH",
      headers: courierHeaders,
      body: JSON.stringify({ status: "on_route" }),
    });
    courierWorkspace = await request(`/api/courier/packages/${assignedPackage.id}/status`, {
      method: "PATCH",
      headers: courierHeaders,
      body: JSON.stringify({ status: "delivered", paymentStatus: "cash_collected" }),
    });
    await request(`/api/admin/packages/${assignedPackage.id}/status`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ status: "delivered", paymentStatus: "cash_collected" }),
    });
    await delay(1200);

    await request(`/api/courier/packages/${secondManualPackage.id}/status`, {
      method: "PATCH",
      headers: courier2Headers,
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    // Confirm a deterministic fixture point through the real restaurant API; no geocoder dependency.
    await request(`/api/restaurant/packages/${secondManualPackage.id}/delivery-point`, {
      method: "PATCH", headers: restaurantHeaders,
      body: JSON.stringify({ latitude: restaurantLatitude + 0.001, longitude: restaurantLongitude + 0.001 }),
    });
    await request(`/api/courier/packages/${secondManualPackage.id}/status`, {
      method: "PATCH",
      headers: courier2Headers,
      body: JSON.stringify({ status: "on_route" }),
    });
    await request(`/api/courier/packages/${secondManualPackage.id}/status`, {
      method: "PATCH",
      headers: courier2Headers,
      body: JSON.stringify({ status: "delivered", paymentStatus: "paid_online" }),
    });
    await delay(1200);

    const cardAddress = `Mersin Kartli teslim noktasi ${Date.now()} no 18`;
    const cardPackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: cardAddress,
        packageType: "Kartli Paket",
        orderAmount: 275,
        customerName: "Kartli Musteri",
        phone: "05550000018",
        paymentMethod: "Kapida Kart POS",
      }),
    });
    const cardPackage = cardPackageState.packages.find((pkg) => pkg.deliveryAddress === cardAddress);
    if (!cardPackage) {
      throw new Error("Kartli gun sonu test paketi olusturulamadi.");
    }
    if (cardPackage.paymentStatus !== "credit_card") {
      throw new Error("Kapida kart/POS odemesi kredi karti olarak normalize edilmedi.");
    }
    const cardCourierHeaders = cardPackage.assignedCourierId === createdCourier.id
      ? courierHeaders
      : cardPackage.assignedCourierId === createdCourier2.id
        ? courier2Headers
        : null;
    if (!cardCourierHeaders) {
      throw new Error("Kartli paket beklenen kuryelerden birine otomatik atanamadi.");
    }
    await request(`/api/courier/packages/${cardPackage.id}/status`, {
      method: "PATCH",
      headers: cardCourierHeaders,
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    // Confirm a deterministic fixture point through the real restaurant API; no geocoder dependency.
    await request(`/api/restaurant/packages/${cardPackage.id}/delivery-point`, {
      method: "PATCH", headers: restaurantHeaders,
      body: JSON.stringify({ latitude: restaurantLatitude + 0.001, longitude: restaurantLongitude + 0.001 }),
    });
    await request(`/api/courier/packages/${cardPackage.id}/status`, {
      method: "PATCH",
      headers: cardCourierHeaders,
      body: JSON.stringify({ status: "on_route" }),
    });
    await request(`/api/courier/packages/${cardPackage.id}/status`, {
      method: "PATCH",
      headers: cardCourierHeaders,
      body: JSON.stringify({ status: "delivered", paymentStatus: "credit_card_collected" }),
    });
    await delay(1200);

    let retryPackageInitial = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await delay(500);
      bootstrap = await request("/api/admin/bootstrap", {
        headers: adminHeaders,
      });
      retryPackageInitial = bootstrap.packages.find((pkg) => pkg.id === thirdManualPackage.id) || null;
      if (retryPackageInitial?.status === "assigned" && retryPackageInitial.assignedCourierId) {
        break;
      }
    }
    if (!retryPackageInitial || retryPackageInitial.status !== "assigned") {
      throw new Error("Retry test paketi ilk atamada assigned olmadi.");
    }
    const firstRetryCourierId = retryPackageInitial.assignedCourierId;
    let retryPackageAfterTimeout = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await delay(500);
      bootstrap = await request("/api/admin/bootstrap", {
        headers: adminHeaders,
      });
      retryPackageAfterTimeout = bootstrap.packages.find((pkg) => pkg.id === thirdManualPackage.id) || null;
      if (retryPackageAfterTimeout && retryPackageAfterTimeout.assignedCourierId && retryPackageAfterTimeout.assignedCourierId !== firstRetryCourierId) {
        break;
      }
    }
    if (!retryPackageAfterTimeout || retryPackageAfterTimeout.status !== "assigned") {
      throw new Error("Retry zamani gelince paket yeniden assigned kalmadi.");
    }
    if (retryPackageAfterTimeout.assignedCourierId === firstRetryCourierId) {
      throw new Error("Retry sonrasi ayni kurye tekrar secildi.");
    }
    const retryCourierHeaders = retryPackageAfterTimeout.assignedCourierId === createdCourier.id
      ? courierHeaders
      : retryPackageAfterTimeout.assignedCourierId === createdCourier2.id
        ? courier2Headers
        : null;
    if (!retryCourierHeaders) {
      throw new Error("Retry sonrasi paket beklenen online kuryelerden birine atanmadi.");
    }
    await request(`/api/courier/packages/${retryPackageAfterTimeout.id}/status`, {
      method: "PATCH",
      headers: retryCourierHeaders,
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    await delay(1800);
    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const retryAcceptedPackage = bootstrap.packages.find((pkg) => pkg.id === retryPackageAfterTimeout.id);
    if (!retryAcceptedPackage || retryAcceptedPackage.status !== "accepted_by_courier") {
      throw new Error("Retry sonrasi kurye kabul akisi calismadi.");
    }
    if (retryAcceptedPackage.assignedCourierId !== retryPackageAfterTimeout.assignedCourierId) {
      throw new Error("Kurye kabul ettikten sonra retry durmadi ve kurye degisti.");
    }
    // Confirm a deterministic fixture point through the real restaurant API; no geocoder dependency.
    await request(`/api/restaurant/packages/${retryPackageAfterTimeout.id}/delivery-point`, {
      method: "PATCH", headers: restaurantHeaders,
      body: JSON.stringify({ latitude: restaurantLatitude + 0.001, longitude: restaurantLongitude + 0.001 }),
    });
    await request(`/api/courier/packages/${retryPackageAfterTimeout.id}/status`, {
      method: "PATCH",
      headers: retryCourierHeaders,
      body: JSON.stringify({ status: "on_route" }),
    });
    await request(`/api/courier/packages/${retryPackageAfterTimeout.id}/status`, {
      method: "PATCH",
      headers: retryCourierHeaders,
      body: JSON.stringify({ status: "delivered", paymentStatus: "paid_online" }),
    });
    await delay(1200);

    const quickPasteAddress = `Mersin Akdeniz hizli yapistir teslim noktasi ${Date.now()} no 11`;
    const quickPasteState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: quickPasteAddress,
        packageType: "Hizli Platform Siparisi",
        orderAmount: 310,
        customerName: "Hizli Musteri",
        phone: "05551112233",
        customerAddress: quickPasteAddress,
        paymentMethod: "Nakit",
        customerNote: "Zile basma",
        source: "platform_manual",
        status: "preparing",
        sourcePlatform: "Hizli Yapistir",
        rawText: "Musteri: Hizli Musteri\nTelefon: 05551112233\nAdres: " + quickPasteAddress + "\nOdeme: Nakit\nNot: Zile basma",
      }),
    });
    const quickPastePackage = quickPasteState.packages.find((pkg) => pkg.deliveryAddress === quickPasteAddress);
    if (!quickPastePackage || quickPastePackage.source !== "platform_manual") {
      throw new Error("Hizli yapistir siparisi platform_manual olarak kaydolmadi.");
    }
    if (quickPastePackage.recipient !== "Hizli Musteri" || quickPastePackage.phone !== "05551112233") {
      throw new Error("Hizli yapistir musteri alanlari kaydolmadi.");
    }

    const extensionQuickPasteAddress = `Mersin Yenişehir extension teslim noktasi ${Date.now()} no 21`;
    const extensionQuickPasteState = await request("/api/restaurant/packages/quick-paste", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        source: "platform_extension_auto",
        sourcePlatform: "Yemeksepeti",
        dedupeKey: `ext-auto-${Date.now()}`,
        rawText: `Musteri: Extension Musteri\nTelefon: 05554443322\nAdres: ${extensionQuickPasteAddress}\nOdeme: Online Odeme\nToplam: 420 TL\nNot: Kapiyi calmadan ara`,
      }),
    });
    if (!extensionQuickPasteState.ok || !extensionQuickPasteState.package) {
      throw new Error("Extension quick paste endpointi paket dondurmedi.");
    }
    if (extensionQuickPasteState.package.source !== "platform_extension_auto") {
      throw new Error("Extension quick paste source alani yanlis kaydedildi.");
    }
    if (extensionQuickPasteState.package.customerAddress !== extensionQuickPasteAddress) {
      throw new Error("Extension quick paste adres ayiklama basarisiz.");
    }
    const extensionQuickPasteDuplicate = await request("/api/restaurant/packages/quick-paste", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        source: "platform_extension_auto",
        sourcePlatform: "Yemeksepeti",
        dedupeKey: extensionQuickPasteState.package.externalOrderId,
        rawText: `Musteri: Extension Musteri\nTelefon: 05554443322\nAdres: ${extensionQuickPasteAddress}\nOdeme: Online Odeme\nToplam: 420 TL`,
      }),
    });
    if (!extensionQuickPasteDuplicate.duplicate || extensionQuickPasteDuplicate.package.id !== extensionQuickPasteState.package.id) {
      throw new Error("Extension auto dedupe korumasi calismadi.");
    }

    const pendingCandidate = extensionShared.analyzeOrderText({
      url: "https://panel.yemeksepeti.com/orders",
      statusText: "Yeni Siparis",
      rawText: `Yeni Siparis\nMusteri: Bekleyen Musteri\nTelefon: 05550001122\nAdres: Mersin Erdemli deneme mahallesi no 1\nToplam: 210 TL`,
    });
    if (pendingCandidate.hasAcceptedSignal) {
      throw new Error("Kabul sinyali olmayan siparis yanlislikla accepted algilandi.");
    }
    if (pendingCandidate.canAutoSend) {
      throw new Error("Kabul sinyali olmayan siparis otomatik gonderime uygun sayildi.");
    }

    const acceptedWithPhoneAmount = extensionShared.analyzeOrderText({
      url: "https://food.getir.com/restaurant/orders",
      statusText: "Kabul Edildi",
      rawText: `Musteri: Kabul Musteri\nTelefon: 05553334455\nToplam: 450 TL\nSiparis notu: Kapiyi calmadan ara`,
    });
    if (!acceptedWithPhoneAmount.hasAcceptedSignal || !acceptedWithPhoneAmount.meetsMinimumSignal) {
      throw new Error("Telefon + tutar kombinasyonu accepted sipariste algilanmadi.");
    }

    const acceptedWithPhoneAddress = extensionShared.analyzeOrderText({
      url: "https://trendyol.com/restaurant",
      statusText: "Preparing",
      rawText: `Musteri: Adres Musteri\nTelefon: 05554445566\nAdres: Mersin Yenisehir test sokak bina 9 kat 2`,
    });
    if (!acceptedWithPhoneAddress.meetsMinimumSignal) {
      throw new Error("Telefon + adres kombinasyonu accepted sipariste algilanmadi.");
    }
    if (!acceptedWithPhoneAddress.autoDedupeKey.startsWith("phone-address:")) {
      throw new Error("Telefon + adres icin beklenen auto dedupe key uretilmedi.");
    }

    const acceptedWithOrderAmount = extensionShared.analyzeOrderText({
      url: "https://migros.com.tr/restaurant",
      statusText: "Confirmed",
      rawText: `Siparis No: TY-555\nToplam: 510 TL\nMusteri: Siparis Numarali`,
    });
    if (!acceptedWithOrderAmount.meetsMinimumSignal || acceptedWithOrderAmount.autoDedupeKey !== "order:TY-555") {
      throw new Error("Siparis no + tutar kombinasyonu veya order dedupe key calismadi.");
    }

    const acceptedWithOrderAddress = extensionShared.analyzeOrderText({
      url: "https://yemeksepeti.com/panel",
      statusText: "Onaylandi",
      rawText: `Teslimat No: ABC-123\nAdres: Mersin Pozcu mahallesi 2010 sokak no 4`,
    });
    if (!acceptedWithOrderAddress.meetsMinimumSignal || acceptedWithOrderAddress.autoDedupeKey !== "order:ABC-123") {
      throw new Error("Siparis no + adres kombinasyonu accepted sipariste algilanmadi.");
    }

    const manualFallbackCandidate = extensionShared.analyzeOrderText({
      url: "https://ornek.com/orders",
      statusText: "Approved",
      rawText: `Musteri: Hash Gerekli\nToplam: 95 TL`,
    });
    if (manualFallbackCandidate.autoDedupeKey) {
      throw new Error("Yetersiz veri olan sipariste otomatik dedupe key uretilmemeliydi.");
    }
    if (!manualFallbackCandidate.manualDedupeKey.startsWith("manual-hash:")) {
      throw new Error("Manual hash fallback uretilmedi.");
    }

    const courierState4 = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye 4",
        username: courier4Username,
        password: courier4Password,
        zone: "Erdemli",
        latitude: courierLatitude + 0.0003,
        longitude: courierLongitude + 0.0003,
        available: true,
      }),
    });
    const createdCourier4 = courierState4.couriers.find((item) => item.username === courier4Username);
    if (!createdCourier4) {
      throw new Error("Dorduncu kurye olusturulamadi.");
    }
    const courierState5 = await request("/api/admin/couriers", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Smoke Kurye 5",
        username: courier5Username,
        password: courier5Password,
        zone: "Erdemli",
        latitude: courierLatitude + 0.0004,
        longitude: courierLongitude + 0.0004,
        available: true,
      }),
    });
    const createdCourier5 = courierState5.couriers.find((item) => item.username === courier5Username);
    if (!createdCourier5) {
      throw new Error("Besinci kurye olusturulamadi.");
    }

    const courier4Login = await request("/api/courier/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: courier4Username,
        password: courier4Password,
      }),
    });
    const courier4Headers = { Authorization: `Bearer ${courier4Login.token}` };
    const courier5Login = await request("/api/courier/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: courier5Username,
        password: courier5Password,
      }),
    });
    const courier5Headers = { Authorization: `Bearer ${courier5Login.token}` };

    const rejectedState = await request(`/api/restaurant/packages/${rejectedWebhookResponse.package.id}/action`, {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({ action: "reject", reason: "Test red" }),
    });
    const rejectedPackage = rejectedState.packages.find((pkg) => pkg.id === rejectedWebhookResponse.package.id);
    if (!rejectedPackage || rejectedPackage.status !== "rejected" || rejectedPackage.assignedCourierId) {
      throw new Error("Reddedilen platform siparisi kuryeye atanmamasi gerekirken akisa girdi.");
    }
    if (!rejectedPackage.platformStatusLogs?.some((item) => item.status === "rejected")) {
      throw new Error("Platform rejected callback logu yazilmadi.");
    }

    const approvedState = await request(`/api/restaurant/packages/${webhookResponse.package.id}/action`, {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({ action: "confirm" }),
    });
    const assignedWebhookAfterDelivery = approvedState.packages.find((pkg) => pkg.id === webhookResponse.package.id);
    if (!assignedWebhookAfterDelivery) {
      throw new Error("Onaylanan platform siparisi restoran durumunda bulunamadi.");
    }
    if (!["preparing", "assigned"].includes(assignedWebhookAfterDelivery.status)) {
      throw new Error("Onaylanan platform siparisi preparing veya assigned durumuna gecmedi.");
    }
    if (!assignedWebhookAfterDelivery.platformStatusLogs?.some((item) => item.status === "accepted")) {
      throw new Error("Platform accepted callback logu yazilmadi.");
    }
    if (!assignedWebhookAfterDelivery.platformStatusLogs?.some((item) => item.status === "preparing")) {
      throw new Error("Platform preparing callback logu yazilmadi.");
    }

    const printSource = fs.readFileSync(path.join(__dirname, "restaurant.js"), "utf8");
    if (!printSource.includes(".print()")) {
      throw new Error("Yazdirma ekrani window.print akisini icermiyor.");
    }
    const courierSource = fs.readFileSync(path.join(__dirname, "courier.js"), "utf8");
    if (!courierSource.includes('textContent = "Restoran"') ||
      !courierSource.includes('textContent = "Musteri"') ||
      !courierSource.includes("openOrderMap") ||
      !courierSource.includes("buildOrderMapUrl") ||
      !courierSource.includes("encodeURIComponent(address)")) {
      throw new Error("Kurye paneli restoran/musteri harita butonlarini icermiyor.");
    }
    const courierHtmlSource = fs.readFileSync(path.join(__dirname, "courier.html"), "utf8");
    if (!courierHtmlSource.includes('<div hidden aria-hidden="true" id="courierRuntimeHooks">')) {
      throw new Error("Kurye runtime uyumluluk kancalari gorunur arayuzden izole edilmemis.");
    }
    if (!courierHtmlSource.includes('class="courier-package-map-preview"')) {
      throw new Error("Kurye paket kartinin teslimat haritasi eksik.");
    }

    await delay(1200);
    const afterDeliveryBootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const assignedWebhookPackage = afterDeliveryBootstrap.packages.find((pkg) => pkg.id === assignedWebhookAfterDelivery.id);
    if (!assignedWebhookPackage?.assignedCourierId) {
      throw new Error("Platform siparisi bos kurye olmasina ragmen atanmadi.");
    }
    if (!assignedWebhookPackage.platformStatusLogs?.some((item) => item.status === "assigned")) {
      throw new Error("Platform assigned callback logu yazilmadi.");
    }

    const platformCourierHeaders = assignedWebhookPackage.assignedCourierId === createdCourier.id
      ? courierHeaders
      : assignedWebhookPackage.assignedCourierId === createdCourier2.id
        ? courier2Headers
        : assignedWebhookPackage.assignedCourierId === createdCourier4.id
          ? courier4Headers
          : assignedWebhookPackage.assignedCourierId === createdCourier5.id
            ? courier5Headers
        : null;
    if (!platformCourierHeaders) {
      throw new Error("Platform siparisi beklenmeyen kuryeye atandi.");
    }

    const assignedCourierWorkspace = await request("/api/courier/me", {
      headers: platformCourierHeaders,
    });
    if (!assignedCourierWorkspace.packages.some((pkg) => pkg.id === assignedWebhookAfterDelivery.id)) {
      throw new Error("Platform siparisi uygun kurye bosalinca kurye paneline dusmedi.");
    }
    await request(`/api/courier/packages/${assignedWebhookAfterDelivery.id}/status`, {
      method: "PATCH",
      headers: platformCourierHeaders,
      body: JSON.stringify({ status: "accepted_by_courier" }),
    });
    // Confirm a deterministic fixture point through the real restaurant API; no geocoder dependency.
    await request(`/api/restaurant/packages/${assignedWebhookAfterDelivery.id}/delivery-point`, {
      method: "PATCH", headers: restaurantHeaders,
      body: JSON.stringify({ latitude: restaurantLatitude + 0.001, longitude: restaurantLongitude + 0.001 }),
    });
    await request(`/api/courier/packages/${assignedWebhookAfterDelivery.id}/status`, {
      method: "PATCH",
      headers: platformCourierHeaders,
      body: JSON.stringify({ status: "on_route" }),
    });
    await request(`/api/courier/packages/${assignedWebhookAfterDelivery.id}/status`, {
      method: "PATCH",
      headers: platformCourierHeaders,
      body: JSON.stringify({ status: "delivered", paymentStatus: "paid_online" }),
    });
    await delay(1200);

    const restaurantBootstrap = await request("/api/restaurant/bootstrap", {
      headers: restaurantHeaders,
    });

    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });

    if (!firstRestaurantPackageState.packages.some((pkg) => pkg.restaurantId === createdRestaurantRecord.id)) {
      throw new Error("Restoran paketi tenant filtreli listede bulunamadi.");
    }
    if (!restaurantBootstrap.packages.every((pkg) => pkg.restaurantId === createdRestaurantRecord.id)) {
      throw new Error("Restoran bootstrap baska tenant siparislerini dondurdu.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.source === "external_manual") || !restaurantBootstrap.packages.some((pkg) => pkg.source !== "external_manual")) {
      throw new Error("Restoran paneli manuel ve webhook siparislerini birlikte gosteremedi.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.id === webhookResponse.package.id && ["preparing", "assigned", "delivered"].includes(pkg.status))) {
      throw new Error("Restoran paneli onaylanan platform siparisini guncel gostermedi.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.id === rejectedWebhookResponse.package.id && pkg.status === "rejected")) {
      throw new Error("Restoran paneli reddedilen platform siparisini gormedi.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.assignedCourierName === createdCourier.name)) {
      throw new Error("Restoran panelinde atanmis kurye bilgisi gorunmuyor.");
    }
    if (!restaurantBootstrap.packages.every((pkg) => pkg.paymentStatus && pkg.status)) {
      throw new Error("Restoran paneli siparis veya odeme durumunu eksik aldi.");
    }
    if (!restaurantBootstrap.packages.some((pkg) => pkg.id === thirdManualPackage.id)) {
      throw new Error("Restoran paneli daha once beklemeye dusen siparisi koruyamadi.");
    }

    if (!bootstrap.restaurants.some((restaurant) => restaurant.id === createdRestaurantRecord.id)) {
      throw new Error("Admin bootstrap restoran kaydini dondurmedi.");
    }

    if (!bootstrap.auditLogs.some((log) => log.restaurantId === createdRestaurantRecord.id)) {
      throw new Error("Audit log akisi beklenen tenant kaydini uretmedi.");
    }

    if (!webhookResponse.package || webhookResponse.package.sourcePlatform !== "Yemeksepeti") {
      throw new Error("Platform webhook siparisi beklenen paketi uretmedi.");
    }
    const duplicateWebhookPackages = bootstrap.packages.filter((pkg) => pkg.externalOrderNo === webhookResponse.package.externalOrderNo);
    if (duplicateWebhookPackages.length !== 1) {
      throw new Error("Duplicate siparis korumasi ayni siparisten birden fazla kayit olusturdu.");
    }

    const availableCouriers = bootstrap.couriers.filter((courier) => courier.status === "online");
    const busyCouriers = bootstrap.couriers.filter((courier) => courier.status === "busy");
    const offlineCouriers = bootstrap.couriers.filter((courier) => courier.status === "offline");
    if ((availableCouriers.length + busyCouriers.length + offlineCouriers.length) < 3 || availableCouriers.length < 1 || offlineCouriers.length < 1) {
      throw new Error("Admin operasyon ozeti kurye durumlarini beklenen sekilde yansitmadi.");
    }

    const overrideAddress = `Mersin override teslim noktasi ${Date.now()} no 50`;
    const overridePackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: overrideAddress,
        packageType: "Override Test",
        orderAmount: 140,
        customerName: "Override Musteri",
        phone: "05550000004",
      }),
    });
    const overridePackage = overridePackageState.packages.find((pkg) => pkg.deliveryAddress === overrideAddress);
    if (!overridePackage) {
      throw new Error("Override test paketi olusturulamadi.");
    }
    await request(`/api/restaurant/packages/${overridePackage.id}/action`, {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({ action: "confirm" }),
    });
    const overridePackageAfterInvalidConfirm = await request("/api/restaurant/bootstrap", {
      headers: restaurantHeaders,
    });
    const preservedOverridePackage = overridePackageAfterInvalidConfirm.packages.find((pkg) => pkg.id === overridePackage.id);
    if (
      !preservedOverridePackage ||
      preservedOverridePackage.status !== overridePackage.status ||
      preservedOverridePackage.assignedCourierId !== overridePackage.assignedCourierId
    ) {
      throw new Error("Gecersiz yeniden onay denemesi manuel paketin atamasini degistirdi.");
    }

    await request(`/api/admin/couriers/${createdCourier3.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
    });
    await request(`/api/admin/packages/${overridePackage.id}/override`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ courierId: createdCourier3.id }),
    }).then(() => {
      throw new Error("Offline kurye override ile atanabildi.");
    }).catch((error) => {
      if (!String(error.message).includes("online")) {
        throw error;
      }
    });
    await request(`/api/admin/couriers/${createdCourier3.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: true }),
    });

    await request(`/api/admin/packages/${overridePackage.id}/override`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ courierId: createdCourier3.id }),
    });
    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const overriddenPackage = bootstrap.packages.find((pkg) => pkg.id === overridePackage.id);
    if (!overriddenPackage || overriddenPackage.assignedCourierId !== createdCourier3.id) {
      throw new Error("Admin manuel override beklenen sekilde calismadi.");
    }
    const courier3Login = await request("/api/courier/login", {
      method: "POST",
      body: JSON.stringify({
        username: courier3Username,
        password: courier3Password,
      }),
    });
    const courier3Headers = { Authorization: `Bearer ${courier3Login.token}` };
    await request(`/api/courier/packages/${overridePackage.id}/status`, {
      method: "PATCH",
      headers: courier3Headers,
      body: JSON.stringify({ status: "failed" }),
    }).then(() => {
      throw new Error("Kurye sorun nedeni secmeden paketi failed yapabildi.");
    }).catch((error) => {
      if (!String(error.message).includes("sorun nedeni")) {
        throw error;
      }
    });
    await request(`/api/courier/packages/${overridePackage.id}/status`, {
      method: "PATCH",
      headers: courier3Headers,
      body: JSON.stringify({ status: "failed", failureReason: "teknik_sorun" }),
    });
    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const issueCancelledPackage = bootstrap.packages.find((pkg) => pkg.id === overridePackage.id);
    if (
      !issueCancelledPackage
      || issueCancelledPackage.status !== "cancelled"
      || issueCancelledPackage.failureReason !== "teknik_sorun"
      || issueCancelledPackage.assignedCourierId !== createdCourier3.id
    ) {
      throw new Error("Kurye reddetme/sorun bildirme akisi beklenen sekilde calismadi.");
    }

    const retryAddress = `Mersin yeniden atama teslim noktasi ${Date.now()} no 51`;
    const retryPackageState = await request("/api/restaurant/packages", {
      method: "POST",
      headers: restaurantHeaders,
      body: JSON.stringify({
        restaurantId: createdRestaurantRecord.id,
        deliveryAddress: retryAddress,
        packageType: "Yeniden Atama Test",
        orderAmount: 145,
        customerName: "Yeniden Atama Musteri",
        phone: "05550000005",
      }),
    });
    const retryPackage = retryPackageState.packages.find((pkg) => pkg.deliveryAddress === retryAddress);
    if (!retryPackage) {
      throw new Error("Yeniden atama test paketi olusturulamadi.");
    }
    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });

    // Yeniden atama testi tek paketi olcmeli. Onceki senaryolardan kalan
    // atanabilir paketler ayni bos kuryeyi kaparak testi rastlantisal hale
    // getirmesin.
    const assignableSmokeStatuses = new Set([
      "pending_approval",
      "pending",
      "preparing",
      "awaiting_assignment",
      "assigned",
      "accepted_by_courier",
      "on_route",
      "failed",
    ]);
    for (const candidate of bootstrap.packages) {
      if (candidate.id === retryPackage.id || !assignableSmokeStatuses.has(candidate.status)) continue;
      await request(`/api/admin/packages/${candidate.id}/status`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ status: "cancelled" }),
      });
    }
    await request(`/api/admin/couriers/${createdCourier.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
    });
    await request(`/api/admin/couriers/${createdCourier2.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
    });
    await request(`/api/admin/couriers/${createdCourier4.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
    });
    await request(`/api/admin/couriers/${createdCourier5.id}/availability`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ available: false }),
    });

    await request(`/api/admin/packages/${retryPackage.id}/unassign`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}",
    });
    await delay(1200);
    bootstrap = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const retriedPackage = bootstrap.packages.find((pkg) => pkg.id === retryPackage.id);
    if (!retriedPackage || retriedPackage.status !== "assigned") {
      throw new Error("Unassign sonrasi yeniden atama mantigi calismadi.");
    }
    if (retriedPackage.assignedCourierId !== createdCourier3.id) {
      throw new Error("Farkli bolgedeki ama 5 km icindeki online kurye otomatik atamada secilemedi.");
    }
    if (!retriedPackage.lastAssignmentAttemptAt) {
      throw new Error("Son atama denemesi bilgisi admin tarafinda gorunmuyor.");
    }

    const activeAssignments = bootstrap.packages.filter((pkg) => pkg.assignedCourierId === createdCourier.id && ["assigned", "accepted_by_courier", "on_route"].includes(pkg.status));
    if (activeAssignments.length > 1) {
      throw new Error("Kurye basina tek aktif paket kurali bozuldu.");
    }
    const deliveredManualPackage = bootstrap.packages.find((pkg) => pkg.id === firstManualPackage.id);
    if (!deliveredManualPackage || deliveredManualPackage.status !== "delivered") {
      throw new Error("Manuel paket teslimat yasam dongusunde delivered durumuna gecemedi.");
    }
    if (deliveredManualPackage.paymentStatus !== "cash_collected") {
      throw new Error("Manuel paket odeme yasam dongusu guncellenemedi.");
    }

    const dayCloseWorkspace = await request("/api/courier/day-close", {
      method: "POST",
      headers: courierHeaders,
      body: "{}",
    });
    const dayCloseReport = dayCloseWorkspace.dayCloseReport;
    if (!dayCloseReport || dayCloseReport.status !== "pending_approval") {
      throw new Error("Kurye gun sonu raporu olusmadi veya onay bekleme durumuna gecmedi.");
    }
    if (!Number.isFinite(Number(dayCloseReport.creditCardAmount))) {
      throw new Error("Kurye gun sonu kredi karti tutari sayisal donmedi.");
    }
    if (Number(dayCloseReport.cashCollectedAmount) < 250) {
      throw new Error("Kurye gun sonu nakit tutari beklenen teslimattan dusuk dondu.");
    }
    if (cardPackage.assignedCourierId === createdCourier.id && Number(dayCloseReport.creditCardAmount) < 275) {
      throw new Error("Kurye gun sonu kapida kart/POS tutari kredi karti kirilimina yansimadi.");
    }

    const duplicateDayCloseResponse = await fetch(`${BASE_URL}/api/courier/day-close`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...courierHeaders },
      body: "{}",
    });
    const duplicateDayCloseBody = await duplicateDayCloseResponse.json();
    if (duplicateDayCloseResponse.status !== 409 || !duplicateDayCloseBody.dayCloseReport?.id) {
      throw new Error("Kurye ayni gun ikinci kez gun sonu yapabildi veya mevcut rapor geri donmedi.");
    }

    const editedDayClose = await request(`/api/admin/day-close/${dayCloseReport.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ failedCollectionTotal: 25, adminNote: "Smoke eksik kontrolu" }),
    });
    const editedDayCloseReport = (editedDayClose.courierDailyReports || []).find((report) => report.id === dayCloseReport.id);
    if (!editedDayCloseReport || Number(editedDayCloseReport.failedCollectionTotal) !== 25 || editedDayCloseReport.adminNote !== "Smoke eksik kontrolu") {
      throw new Error("Admin gun sonu eksik tutarini ve notunu kaydedemedi.");
    }

    const dayCloseApproval = await request(`/api/admin/day-close/${dayCloseReport.id}/approve`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ adminNote: "Smoke eksik kontrolu" }),
    });
    if (!dayCloseApproval.success) {
      throw new Error("Admin kurye gun sonu raporunu onaylayamadi.");
    }
    const approvedReportFromResponse = (dayCloseApproval.courierDailyReports || []).find((report) => report.id === dayCloseReport.id);
    if (!approvedReportFromResponse || approvedReportFromResponse.status !== "approved") {
      throw new Error("Gun sonu onay yaniti guncel admin rapor listesini dondurmedi.");
    }
    for (const field of ["paidOnlineAmount", "cashCollectedAmount", "creditCardAmount"]) {
      if (!Number.isFinite(Number(approvedReportFromResponse[field]))) {
        throw new Error(`Gun sonu onay yanitinda ${field} sayisal donmedi.`);
      }
    }

    const courier2DayCloseWorkspace = await request("/api/courier/day-close", {
      method: "POST",
      headers: courier2Headers,
      body: "{}",
    });
    const courier2DayCloseReport = courier2DayCloseWorkspace.dayCloseReport;
    if (!courier2DayCloseReport || courier2DayCloseReport.status !== "pending_approval") {
      throw new Error("Ikinci kurye gun sonu raporu olusmadi veya onay bekleme durumuna gecmedi.");
    }
    if (Number(courier2DayCloseReport.paidOnlineAmount) < 180) {
      throw new Error("Kurye gun sonu online tutari beklenen teslimattan dusuk dondu.");
    }
    if (cardPackage.assignedCourierId === createdCourier2.id && Number(courier2DayCloseReport.creditCardAmount) < 275) {
      throw new Error("Kurye gun sonu kapida kart/POS tutari kredi karti kirilimina yansimadi.");
    }
    const courier2DayCloseRejection = await request(`/api/admin/day-close/${courier2DayCloseReport.id}/reject`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ adminNote: "Smoke red kontrolu" }),
    });
    const rejectedCourier2Report = (courier2DayCloseRejection.courierDailyReports || []).find((report) => report.id === courier2DayCloseReport.id);
    if (!rejectedCourier2Report || rejectedCourier2Report.status !== "rejected" || rejectedCourier2Report.adminNote !== "Smoke red kontrolu") {
      throw new Error("Kurye gun sonu reddi ve red sebebi admin rapor listesine yansimadi.");
    }

    const approvedDayCloseState = await request("/api/admin/bootstrap", {
      headers: adminHeaders,
    });
    const approvedDayCloseReport = (approvedDayCloseState.courierDailyReports || []).find((report) => report.id === dayCloseReport.id);
    if (!approvedDayCloseReport || approvedDayCloseReport.status !== "approved") {
      throw new Error("Onaylanan kurye gun sonu raporu admin paneline yansimadi.");
    }

    const deliveredWebhookPackage = bootstrap.packages.find((pkg) => pkg.id === assignedWebhookAfterDelivery.id);
    if (!deliveredWebhookPackage?.platformStatusLogs?.some((item) => item.status === "delivered")) {
      throw new Error("Platform delivered callback logu yazilmadi.");
    }

    console.log("Smoke test başarılı: admin, restoran, kurye, webhook, otomatik atama, harita ve gün sonu akışı çalıştı.");
  } finally {
    server.kill("SIGTERM");
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup errors.
    }
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
