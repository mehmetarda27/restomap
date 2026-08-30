const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const REQUIRED_FILES = [
  "index.html",
  "landing-final.css",
  "assets/delivera-login.jpg",
  "admin-design-source/code.html",
  "admin-design-source/admin-local.css",
  "restaurant-design-source/code.html",
  "courier.html",
  "courier-design-source/vardiya_y_netimi/code.html",
  "courier-design-source/performans_raporlar/code.html",
  "courier-design-source/profil_ve_ayarlar/code.html",
  "admin-design-bridge.js",
  "restaurant-design-bridge.js",
  "courier-design-bridge.js",
  "login-shell.js",
  "migrations/202608080001_panel_workflow_tables.js",
];
const REQUIRED_ENV_CONTRACT = [
  "DATABASE_URL",
  "WEBHOOK_SECRET",
  "POSENTEGRA_API_BASE_URL",
  "POSENTEGRA_API_KEY",
  "POSENTEGRA_BUSINESS_ID",
  "REDIS_URL",
  "RESTOMAP_REQUIRE_REDIS",
];
const FORBIDDEN_TRACKED = [
  /^\.env$/,
  /^node_modules\//,
  /^logs\//,
  /^backups\//,
  /^uploads\//,
  /(?:^|\/)delivera\.sqlite(?:-shm|-wal)?$/,
  /(?:^|\/)processed_orders\.db$/,
  /\.diff$/,
];

function gitFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.replaceAll("\\", "/"));
  } catch (error) {
    throw new Error(`Git dosya listesi okunamadi: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const trackedFiles = gitFiles();
const trackedSet = new Set(trackedFiles);
const missingFiles = REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(ROOT, file)));
const untrackedRequired = REQUIRED_FILES.filter((file) => !trackedSet.has(file));
const forbiddenFiles = trackedFiles.filter((file) => FORBIDDEN_TRACKED.some((pattern) => pattern.test(file)));
const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
const missingEnvContract = REQUIRED_ENV_CONTRACT.filter((name) => !new RegExp(`^${name}=`, "m").test(envExample));
const serverSource = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

assert(missingFiles.length === 0, `Deploy icin gerekli dosyalar eksik: ${missingFiles.join(", ")}`);
assert(untrackedRequired.length === 0, `Gerekli dosyalar Git'e eklenmemis: ${untrackedRequired.join(", ")}`);
assert(forbiddenFiles.length === 0, `Runtime veya secret dosyalari halen Git'te: ${forbiddenFiles.slice(0, 20).join(", ")}`);
assert(missingEnvContract.length === 0, `.env.example sozlesmesi eksik: ${missingEnvContract.join(", ")}`);
assert(serverSource.includes('pathname === "/ready"'), "/ready endpointi bulunamadi.");
assert(serverSource.includes("runMigrations()"), "Sunucu baslangic migration kontrolu bulunamadi.");
assert(serverSource.includes('"/admin.html": "admin-design-source/code.html"'), "Admin final tasarim route'u eksik.");
assert(serverSource.includes('"/restaurant.html": "restaurant-design-source/code.html"'), "Restoran final tasarim route'u eksik.");

process.stdout.write(`${JSON.stringify({
  ok: true,
  trackedFileCount: trackedFiles.length,
  requiredFiles: REQUIRED_FILES.length,
  forbiddenTrackedFiles: 0,
  readinessEndpoint: true,
  startupMigrations: true,
}, null, 2)}\n`);
